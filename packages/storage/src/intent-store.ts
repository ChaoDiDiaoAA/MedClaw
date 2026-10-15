import type { Database } from 'bun:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { PositiveIdSchema, TimestampSchema, safeError } from '../../contracts/src/error';
import { IntentModelSelectionSchema } from '../../contracts/src/model';
import { InputContentSchema } from '../../contracts/src/session';
import { renderIntentContext, intentContextSource, ContextSnapshotBodySchema, ModelCallContextSchema } from '../../contracts/src/context';
import { IntentModelCallViewSchema, RunScopeSchema, canonicalRequest } from '../../contracts/src/run';
import { RegisteredEventPayloadSchema, type EventWriter, type RegisteredEventPayload } from '../../contracts/src/event';
import {
  IntentCallRegistrationSchema, IntentCallCompletionSchema, IntentStageInputSchema, IntentHttpOutcomeSchema,
  IntentResultSchema, IntentValidationSchema, IntentDecisionSchema, IntentReadResultSchema, ReadIntentInputSchema,
  RouteCommitSchema, QueryContextRecordSchema, type IntentStore, type IntentCallRegistration,
  type IntentCallCompletion, type RouteCommit, type ReadIntentInput, type IntentValidation,
  PrepareIntentInputSchema, FrozenIntentAdmissionSchema, IntentInputProjectionSchema, AdoptedContextFactSchema, IntentExecutionFactSchema,
  ProductResultDetailsSchema, QueryContextFactSchema, FormExecutionFactSchema, type PrepareIntentInput, type QueryContextRecord, INTENT_VERSIONS,
} from '../../contracts/src/intent';
import { SqliteEventStore } from './event-store';
import { SqliteWriteTransactions } from './write-transactions';
import { SqliteCatalogStore } from './catalog-store';
import { SqliteToolStore } from './tool-store';
import { readWorkspaceBatchReferences } from './workspace-selection';

import { legacyContextBody, legacyInputContent, legacyIntentAdmission, legacyIntentStage, legacyIntentExecution, legacyModelCallContext, legacyModelSelection, legacyQueryContext, legacyRunScope, legacyEventPayload, omitLegacyFields, readLegacyIntentContext } from './legacy-business-fields';
const json = (value: unknown) => value == null ? null : JSON.stringify(value);
function fail(code: string): never { throw new Error(code); }
function checked<T>(schema: z.ZodType<T>, value: unknown, code = 'storage_read_failed'): T {
  const parsed = schema.safeParse(value); return parsed.success ? parsed.data : fail(code);
}
function legacyMetadata(value: unknown): unknown {
  const model=omitLegacyFields(value,['completionHash']) as Record<string,unknown>|null;
  if(model===null||typeof model!=='object'||Array.isArray(model))return model;
  return {...model,selection:legacyModelSelection(model.selection),context:legacyModelCallContext(model.context)};
}
function decoded(value: string | null): unknown { try { return value === null ? null : JSON.parse(value); } catch { fail('storage_read_failed'); } }
const metadataSchema = z.strictObject({ selection: IntentModelSelectionSchema, responseModel: z.string().nullable(), sdkStopReason: z.null(),
  context: ModelCallContextSchema,
  http: IntentHttpOutcomeSchema.omit({ rawOutput: true, observation: true }).nullable() });
type RunRow = { id: number; session_id: number; input_id: number; input_text: string; kind: string; parent_run_id: number | null; status: string;
  cancel_requested_at: string | null; reference_date: string; timezone: string; scope_json: string; config_json:string; cleanup_json: string | null };
type CallRow = { id: number; model_call_id: number; call_id: string; run_id: number; session_id: number; input_id: number;
  snapshot_id: number; stage: 'classify' | 'verify'; previous_call_id: number | null; taxonomy_version: string; rule_version: string;
  prompt_version: string; schema_version: string; input_projection_json: string; raw_output: string | null;
  parsed_result_json: string | null; validation_json: string | null; validation_state: string; created_at: string;
  model_json: string; state: 'started' | 'completed' | 'failed' | 'cancelled'; started_at: string; ended_at: string | null;
  duration_ms: number | null; input_tokens: number | null; output_tokens: number | null; cost: number | null;
  cost_currency: string | null; usage_source: string | null; unavailable_reason: string | null; error_json: string | null;
  granularity: string; attempt: number; attempt_count_unknown: number };
type RouteRow = { id: number; run_id: number; session_id: number; input_id: number; intent_call_id: number | null;
  call_id: string | null; route: string; decision_source: string; matched_by: string | null; business_status: string | null;
  rule_evaluation_json: string | null; adopted_intents_json: string; context_intent_id: string | null; adopted_slots_json: string | null;
  query_params_json: string | null; execution_plan_json: string | null; missing_slots_json: string; issues_json: string; schema_version: string; policy_version: string; created_at: string };
const callSelect = 'SELECT i.*,m.call_id,m.model_json,m.state,m.started_at,m.ended_at,m.duration_ms,m.input_tokens,m.output_tokens,m.cost,m.cost_currency,m.usage_source,m.unavailable_reason,m.error_json,m.granularity,m.attempt,m.attempt_count_unknown FROM intent_calls i JOIN model_calls m ON m.id=i.model_call_id';
const readFactsSchema=z.strictObject(IntentReadResultSchema.shape).omit({execution:true,effectiveContext:true});

export class SqliteIntentStore implements Omit<IntentStore, 'readIntent'> {
  private readonly events: EventWriter;
  constructor(private readonly db: Database, events?: EventWriter, private readonly transactions = SqliteWriteTransactions.forDatabase(db)) {
    this.events = events ?? new SqliteEventStore(db, transactions);
  }
  private write<T>(action: () => T): T {
    try { return this.transactions.immediate(action); } catch (error) { if (error instanceof Error && error.name === 'SQLiteError') fail('storage_write_failed'); throw error; }
  }
  readContextProjection(cached:Record<string,unknown>):QueryContextRecord {
    const common={sessionId:cached.session_id,nativeLeafId:cached.native_leaf_id,version:cached.version,sourceRunId:cached.source_run_id,
      sourceInputId:cached.source_input_id,queryIds:decoded(cached.query_ids_json as string),
      pendingClarification:decoded(cached.pending_clarification_json as string|null)};
    if(cached.schema_version==='medclaw.query-form/v1'){
      const route=this.route(cached.source_run_id as number);
      if(!route||route.decision_source!=='user_form'||route.input_id!==cached.source_input_id||route.session_id!==cached.session_id
        ||cached.context_intent_id!=='user_form'||!isDeepStrictEqual(decoded(cached.task_intents_json as string),[]))fail('storage_read_failed');
      return checked(QueryContextRecordSchema,{...common,contract:'medclaw.query-form-context/v1',decisionId:route.id,params:decoded(cached.adopted_slots_json as string)});
    }
    if(cached.schema_version!=='medclaw.intent/v2')fail('storage_read_failed');
    return checked(QueryContextRecordSchema,{...common,taskIntents:decoded(cached.task_intents_json as string),contextIntentId:cached.context_intent_id,
      adoptedSlots:decoded(cached.adopted_slots_json as string)});
  }
  private owner(runId: number, sessionId?: number, inputId?: number): RunRow {
    const run = this.db.query<RunRow, [number]>('SELECT * FROM runs WHERE id=?').get(runId);
    if (!run || run.kind !== 'agent' || run.parent_run_id !== null || sessionId !== undefined && run.session_id !== sessionId
      || inputId !== undefined && run.input_id !== inputId) fail('access_denied');
    const owner = this.db.query('SELECT i.id FROM session_inputs i JOIN sessions s ON s.id=i.session_id WHERE i.id=? AND i.session_id=? AND i.target_run_id=? AND s.kind=\'user\'').get(run.input_id, run.session_id, run.id);
    if (!owner) fail('access_denied'); return run;
  }
  private active(run: RunRow): void { if (!['created', 'running'].includes(run.status) || run.cancel_requested_at !== null) fail('state_conflict'); }
  private call(callId: string): CallRow | null { return this.db.query<CallRow, [string]>(callSelect + ' WHERE m.call_id=?').get(callId); }
  private event(run: RunRow, fact: RegisteredEventPayload, sourceConnection: string, sourceSequence: number, at: string): void {
    this.events.appendInTransaction({ ...fact, runId: run.id, sessionId: run.session_id,
      source: fact.type === 'route_decided' ? 'application' : 'intent', sourceConnection, sourceSequence,
      toolCallId: null, occurredAt: at, receivedAt: at });
  }
  private registration(row: CallRow): IntentCallRegistration {
    const model = checked(metadataSchema, legacyMetadata(decoded(row.model_json))), input = checked(IntentStageInputSchema, legacyIntentStage(decoded(row.input_projection_json)));
    const previous = row.previous_call_id === null ? null : this.db.query<{ call_id: string }, [number]>('SELECT m.call_id FROM intent_calls i JOIN model_calls m ON m.id=i.model_call_id WHERE i.id=?').get(row.previous_call_id);
    const registration = checked(IntentCallRegistrationSchema, { callId: row.call_id, runId: row.run_id, sessionId: row.session_id,
      inputId: row.input_id, snapshotId: row.snapshot_id, selection: model.selection, input, stage: row.stage,
      previousCallId: previous?.call_id ?? null, createdAt: row.created_at });
    if (row.taxonomy_version !== input.input.versions.taxonomyVersion || row.rule_version !== input.input.versions.ruleVersion
      || row.schema_version !== input.input.versions.schemaVersion || row.prompt_version !== (row.stage === 'classify'
        ? input.input.versions.classifyPromptVersion : input.input.versions.verifyPromptVersion)) fail('storage_read_failed');
    return registration;
  }
  registerIntentCall(raw: IntentCallRegistration): { modelCallPk: number; intentCallPk: number } {
    return this.write(() => {
      const input = checked(IntentCallRegistrationSchema, raw, 'invalid_argument'), run = this.owner(input.runId, input.sessionId, input.inputId);
      const existing = this.call(input.callId);
      if (existing) { if (!isDeepStrictEqual(this.registration(existing), input)) fail('state_conflict'); return { modelCallPk: existing.model_call_id, intentCallPk: existing.id }; }
      this.active(run);
      if (this.db.query('SELECT id FROM model_calls WHERE call_id=?').get(input.callId)
        || this.db.query('SELECT id FROM intent_calls WHERE run_id=? AND stage=?').get(run.id, input.stage)
        || this.db.query('SELECT id FROM route_decisions WHERE run_id=?').get(run.id)) fail('state_conflict');
      const accepted = this.db.query<{ content_json: string }, [number]>('SELECT content_json FROM session_inputs WHERE id=?').get(input.inputId)!;
      const content = checked(InputContentSchema, legacyInputContent(decoded(accepted.content_json))), projection = input.input.input;
      if (projection.text !== content.text || projection.referenceDate !== run.reference_date || projection.timezone !== run.timezone
        || !isDeepStrictEqual(projection.scope, checked(RunScopeSchema, legacyRunScope(decoded(run.scope_json))))) fail('access_denied');
      const snapshot = this.db.query<{ run_id: number; session_id: number; input_id: number; snapshot_json: string }, [number]>('SELECT * FROM context_snapshots WHERE id=?').get(input.snapshotId);
      if (!snapshot || snapshot.run_id !== run.id || snapshot.session_id !== run.session_id || snapshot.input_id !== run.input_id) fail('access_denied');
      const body = checked(ContextSnapshotBodySchema, legacyContextBody(decoded(snapshot.snapshot_json)));
      const source = intentContextSource(input.input);
      if (!isDeepStrictEqual(body.intentSource, source) || body.delegationSource || !isDeepStrictEqual(body.workspaceContext, content.workspaceContext)
        || body.renderedProjection !== renderIntentContext(input.input)) fail('access_denied');
      const session = this.db.query<{ current_leaf_id: string | null; storage_version: number }, [number]>('SELECT current_leaf_id,storage_version FROM sessions WHERE id=?').get(run.session_id)!;
      if (session.current_leaf_id !== projection.baseLeafId || session.storage_version !== projection.baseStorageVersion) fail('state_conflict');
      let previousPk: number | null = null;
      if (input.stage === 'verify') {
        const prior = this.call(input.previousCallId!); if (!prior || prior.stage !== 'classify' || prior.run_id !== run.id || prior.state !== 'completed') fail('state_conflict');
        const previous = this.registration(prior), validation = checked(IntentValidationSchema, decoded(prior.validation_json));
        const review = input.input.review!;
        if (!validation.reviewRequired || validation.rawOutputTruncated || !isDeepStrictEqual(previous.selection, input.selection)
          || !isDeepStrictEqual(previous.input.input, projection) || !isDeepStrictEqual(review.prediction, decoded(prior.parsed_result_json))
          || !isDeepStrictEqual(review.issues, validation.issues)
          || review.rawPreview !== (prior.raw_output ?? '').slice(0, 4096)) fail('state_conflict');
        previousPk = prior.id;
      }
      const model = checked(metadataSchema, { selection: input.selection, responseModel: null, sdkStopReason: null, http: null,
        context: { contract: 'medclaw.context-call/v1', snapshotId: input.snapshotId, inputId: input.inputId,
          intentSource: source, observation: null, responseStatus: null, payloadVerified: null } }, 'invalid_argument');
      const modelCallPk = Number(this.db.query(`INSERT INTO model_calls(call_id,run_id,session_id,input_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,started_at)
        VALUES(?,?,?,?,'intent',1,'logical_request',0,?,'started',?)`).run(input.callId, run.id, run.session_id, run.input_id, JSON.stringify(model), input.createdAt).lastInsertRowid);
      const versions = projection.versions;
      const intentCallPk = Number(this.db.query(`INSERT INTO intent_calls(model_call_id,run_id,session_id,input_id,snapshot_id,stage,previous_call_id,taxonomy_version,rule_version,prompt_version,schema_version,input_projection_json,validation_state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(modelCallPk, run.id, run.session_id, run.input_id, input.snapshotId, input.stage, previousPk,
          versions.taxonomyVersion, versions.ruleVersion, input.stage === 'classify' ? versions.classifyPromptVersion : versions.verifyPromptVersion,
          versions.schemaVersion, JSON.stringify(input.input), input.createdAt, input.createdAt).lastInsertRowid);
      this.event(run, { type: 'intent_started', payload: { contract: 'medclaw.event/v1', runId: run.id, inputId: run.input_id,
        stage: input.stage, previousCallId: input.previousCallId, intentCallId: input.callId, callId: input.callId, snapshotId: input.snapshotId,
        configVersion: input.selection.configVersion, modelTag: input.selection.modelTag } }, `intent:${input.callId}`, 1, input.createdAt);
      return { modelCallPk, intentCallPk };
    });
  }
  finishIntentCall(raw: IntentCallCompletion): void {
    this.write(() => {
      const input = checked(IntentCallCompletionSchema, raw, 'invalid_argument'), run = this.owner(input.runId, input.sessionId, input.inputId), row = this.call(input.callId);
      if (!row || row.run_id !== run.id || row.input_id !== run.input_id || row.stage !== input.stage) fail('access_denied');
      const model = checked(metadataSchema, legacyMetadata(decoded(row.model_json)));
      const { outcome } = input;
      if (input.parsed !== null) {
        try { if (outcome.rawOutput === null || !isDeepStrictEqual(checked(IntentResultSchema, JSON.parse(outcome.rawOutput), 'state_conflict'), input.parsed)) fail('state_conflict'); }
        catch { fail('state_conflict'); }
      }
      if (Date.parse(outcome.startedAt) < Date.parse(row.started_at) || input.validation.state === 'pending'
        || input.validation.rawOutputTruncated !== outcome.rawOutputTruncated || Date.parse(outcome.endedAt) < Date.parse(outcome.startedAt)
        || outcome.observation !== null && (Date.parse(outcome.observation.observedAt) < Date.parse(outcome.startedAt)
          || Date.parse(outcome.observation.observedAt) > Date.parse(outcome.endedAt))) fail('state_conflict');
      if (outcome.observation !== null) {
        if (!isDeepStrictEqual(model.context.observation, outcome.observation) || !this.db.query('SELECT id FROM context_deliveries WHERE model_call_id=? AND snapshot_id=? AND run_id=? AND session_id=?')
          .get(row.model_call_id, row.snapshot_id, run.id, run.session_id)) fail('state_conflict');
      }
      if (input.state === 'completed' && (outcome.transportState !== 'completed' || outcome.observation === null)
        || input.validation.state === 'valid' && (input.parsed === null || outcome.rawOutputTruncated || input.state !== 'completed')) fail('state_conflict');
      const cancelled = run.cancel_requested_at !== null || run.status === 'cancelled';
      const state = cancelled ? 'cancelled' : input.state;
      const validation: IntentValidation = cancelled ? checked(IntentValidationSchema, { contract: 'medclaw.intent-validation/v2', state: 'not_run',
        finalStatus: null, adoptedIntents: [], missingSlots: [], issues: [], resolvedDeviceIds: [], reviewRequired: false,
        rawOutputTruncated: outcome.rawOutputTruncated, checkedAt: null }) : input.validation;
      if (validation.state === 'pending') fail('state_conflict');
      const { rawOutput: _raw, observation: _observation, ...http } = outcome;
      if(model.http!==null){
        if(row.state!==state||row.raw_output!==outcome.rawOutput||!isDeepStrictEqual(decoded(row.parsed_result_json),input.parsed)
          ||!isDeepStrictEqual(decoded(row.validation_json),validation)||!isDeepStrictEqual(model.http,http))fail('state_conflict');
        return;
      }
      if(row.state!=='started')fail('state_conflict');
      const savedModel = checked(metadataSchema, { ...model, responseModel: outcome.responseModel, http });
      this.db.query(`UPDATE model_calls SET state=?,model_json=?,ended_at=?,duration_ms=?,input_tokens=?,output_tokens=?,cost=NULL,cost_currency=NULL,
        usage_source=?,error_json=? WHERE id=?`).run(state, JSON.stringify(savedModel), outcome.endedAt, outcome.durationMs,
          outcome.inputTokens, outcome.outputTokens, outcome.inputTokens !== null || outcome.outputTokens !== null ? 'ollama_reported' : null,
          json(outcome.error), row.model_call_id);
      this.db.query('UPDATE intent_calls SET raw_output=?,parsed_result_json=?,validation_json=?,validation_state=?,updated_at=? WHERE id=?')
        .run(outcome.rawOutput, json(input.parsed), JSON.stringify(validation), validation.state, outcome.endedAt, row.id);
      this.event(run, { type: 'intent_finished', payload: { contract: 'medclaw.event/v1', runId: run.id, inputId: run.input_id, stage: row.stage,
        callId: row.call_id, intentCallId: row.call_id, state, validationState: validation.state, errorCode: outcome.error?.code ?? null } }, `intent:${row.call_id}`, 2, outcome.endedAt);
    });
  }
  recoverInterrupted(runId: number, time: string): void {
    checked(PositiveIdSchema, runId, 'invalid_argument'); checked(TimestampSchema, time, 'invalid_argument');
    this.write(() => {
      const calls = this.db.query<CallRow, [number]>(callSelect + " WHERE m.run_id=? AND m.state='started'").all(runId);
      if (!calls.length) return;
      const run = this.owner(runId), error = safeError('runtime_interrupted', undefined, { runId });
      for (const call of calls) {
        checked(metadataSchema, legacyMetadata(decoded(call.model_json)));
        if (call.validation_state !== 'pending' || call.raw_output !== null || call.parsed_result_json !== null || call.validation_json !== null) fail('storage_read_failed');
        const state = run.cancel_requested_at !== null || run.status === 'cancelled' ? 'cancelled' : 'failed';
        const validation = checked(IntentValidationSchema, { contract: 'medclaw.intent-validation/v2', state: 'not_run', finalStatus: null,
          adoptedIntents: [], missingSlots: [], issues: [], resolvedDeviceIds: [], reviewRequired: false, rawOutputTruncated: false, checkedAt: null });
        // Process exit proves local ownership ended; response, usage and HTTP timing remain unknown.
        this.db.query("UPDATE model_calls SET state=?,ended_at=?,duration_ms=NULL,input_tokens=NULL,output_tokens=NULL,usage_source=NULL,unavailable_reason='runtime_interrupted',error_json=? WHERE id=? AND state='started'")
          .run(state, time, JSON.stringify(error), call.model_call_id);
        this.db.query("UPDATE intent_calls SET validation_json=?,validation_state='not_run',updated_at=? WHERE id=?")
          .run(JSON.stringify(validation), time, call.id);
        this.event(run, { type: 'intent_finished', payload: { contract: 'medclaw.event/v1', runId, inputId: run.input_id, stage: call.stage,
          callId: call.call_id, intentCallId: call.call_id, state, validationState: 'not_run', errorCode: error.code } }, `intent:${call.call_id}`, 2, time);
      }
    });
  }
  private rule(runId: number) {
    const row = this.db.query<{ payload_json: string }, [number]>("SELECT payload_json FROM runtime_events WHERE run_id=? AND type='intent_rule_evaluated'").get(runId);
    if (!row) return null;
    const fact = checked(RegisteredEventPayloadSchema, { type: 'intent_rule_evaluated', payload: legacyEventPayload(decoded(row.payload_json)) });
    if (fact.type !== 'intent_rule_evaluated') fail('storage_read_failed'); return fact.payload.ruleEvaluation;
  }
  private route(runId: number): RouteRow | null {
    return this.db.query<RouteRow, [number]>('SELECT d.*,m.call_id FROM route_decisions d LEFT JOIN intent_calls i ON i.id=d.intent_call_id LEFT JOIN model_calls m ON m.id=i.model_call_id WHERE d.run_id=?').get(runId);
  }
  private decision(row: RouteRow) {
    if (row.intent_call_id !== null && row.call_id === null) fail('storage_read_failed');
    return checked(IntentDecisionSchema, { intentCallId: row.call_id, matchedBy: row.matched_by, route: row.route, status: row.business_status,
      adoptedIntents: decoded(row.adopted_intents_json), contextIntentId: row.context_intent_id, adoptedSlots: decoded(row.adopted_slots_json),
      queryParams: decoded(row.query_params_json), missingSlots: decoded(row.missing_slots_json), issues: decoded(row.issues_json),
      ...(row.execution_plan_json===null?{}:{executionPlan:decoded(row.execution_plan_json)}),
      ruleEvaluation: omitLegacyFields(decoded(row.rule_evaluation_json),['inputHash']), decisionSource: row.decision_source, schemaVersion: row.schema_version, policyVersion: row.policy_version });
  }
  commitRoute(raw: RouteCommit): { decisionId: number } {
    return this.write(() => {
      const input = checked(RouteCommitSchema, raw, 'invalid_argument'), run = this.owner(input.runId, input.sessionId, input.inputId), decision = input.decision, existing = this.route(run.id);
      if (existing) { if (!isDeepStrictEqual(this.decision(existing), decision) || existing.created_at !== input.createdAt) fail('state_conflict'); return { decisionId: existing.id }; }
      this.active(run);
      let adoptedPk: number | null = null;
      if (decision.decisionSource === 'validated_model') {
        const call = this.call(decision.intentCallId!); if (!call || call.run_id !== run.id || call.input_id !== run.input_id || call.state !== 'completed') fail('state_conflict');
        const validation = checked(IntentValidationSchema, decoded(call.validation_json));
        if (validation.state !== 'valid' || validation.reviewRequired || validation.rawOutputTruncated || validation.finalStatus !== decision.status
          || !isDeepStrictEqual(validation.adoptedIntents, decision.adoptedIntents) || !isDeepStrictEqual(validation.missingSlots, decision.missingSlots)
          || !isDeepStrictEqual(validation.issues, decision.issues) || decision.matchedBy !== (call.stage === 'classify' ? 'qwen_prompt' : 'paper_enhanced')
          || call.stage === 'classify' && this.db.query("SELECT id FROM intent_calls WHERE run_id=? AND stage='verify'").get(run.id)) fail('state_conflict');
        adoptedPk = call.id;
      } else if (decision.decisionSource === 'deterministic_rule') {
        if (!isDeepStrictEqual(this.rule(run.id), decision.ruleEvaluation) || this.db.query('SELECT id FROM intent_calls WHERE run_id=?').get(run.id)) fail('state_conflict');
      } else if (decision.decisionSource === 'explicit_agent_fallback') {
        const accepted=this.db.query<{content_json:string},[number]>('SELECT content_json FROM session_inputs WHERE id=?').get(run.input_id)!;
        const content=checked(InputContentSchema,legacyInputContent(decoded(accepted.content_json))),request=content.originalSubmitInput;
        if(request.mode!=='send'||request.routing?.mode!=='explicit_agent_fallback'||content.intentAdmission||this.db.query('SELECT id FROM intent_calls WHERE run_id=?').get(run.id))fail('state_conflict');
        const origin=this.owner(request.routing.originRunId,run.session_id);
        if(origin.id>=run.id||!['failed','cancelled','completed'].includes(origin.status)||origin.input_text!==content.text
          ||origin.reference_date!==content.referenceDate||origin.timezone!==content.timezone)fail('state_conflict');
      } else if (decision.decisionSource === 'user_form') {
        const accepted=this.db.query<{content_json:string},[number]>('SELECT content_json FROM session_inputs WHERE id=?').get(run.input_id)!;
        const content=checked(InputContentSchema,legacyInputContent(decoded(accepted.content_json))),request=content.originalSubmitInput;
        if(request.mode!=='send'||request.routing?.mode!=='user_form'||content.intentAdmission||content.resourceInputPlan
          ||content.text!=='Query form: '+canonicalRequest(request.routing.params)||!isDeepStrictEqual(decision.queryParams,request.routing.params)
          ||!isDeepStrictEqual(request.routing.params.batchIds,content.scope.batchIds)
          ||this.db.query('SELECT id FROM model_calls WHERE run_id=?').get(run.id))fail('state_conflict');
      }
      const decisionId = Number(this.db.query(`INSERT INTO route_decisions(run_id,session_id,input_id,intent_call_id,route,decision_source,matched_by,business_status,rule_evaluation_json,adopted_intents_json,context_intent_id,adopted_slots_json,query_params_json,missing_slots_json,issues_json,schema_version,policy_version,created_at,execution_plan_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(run.id, run.session_id, run.input_id, adoptedPk, decision.route, decision.decisionSource, decision.matchedBy,
          decision.status, json(decision.ruleEvaluation), json(decision.adoptedIntents)!, decision.contextIntentId, json(decision.adoptedSlots), json(decision.queryParams),
          JSON.stringify(decision.missingSlots), JSON.stringify(decision.issues), decision.schemaVersion, decision.policyVersion, input.createdAt,json(decision.executionPlan??null)).lastInsertRowid);
      this.event(run, { type: 'route_decided', payload: { contract: 'medclaw.event/v1', runId: run.id, inputId: run.input_id, decisionId,
        intentCallId: decision.intentCallId, route: decision.route, decisionSource: decision.decisionSource, matchedBy: decision.matchedBy,
        status: decision.status } }, `route:${decisionId}`, 1, input.createdAt);
      return { decisionId };
    });
  }
  readModelCall(modelCallPk: number) {
    checked(PositiveIdSchema, modelCallPk, 'invalid_argument');
    const row = this.db.query<CallRow, [number]>(callSelect + ' WHERE m.id=?').get(modelCallPk); if (!row) fail('storage_read_failed');
    const model = checked(metadataSchema, legacyMetadata(decoded(row.model_json)));
    return checked(IntentModelCallViewSchema, { id: row.model_call_id, callId: row.call_id, inputId: row.input_id, kind: 'intent', state: row.state,
      model: model.selection, responseModel: model.responseModel, sdkStopReason: null, contextSnapshotId: model.context.snapshotId,
      granularity: row.granularity, attempt: row.attempt, attemptCountUnknown: row.attempt_count_unknown === 1,
      startedAt: row.started_at, endedAt: row.ended_at, durationMs: row.duration_ms, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      cost: row.cost, costCurrency: row.cost_currency, usageSource: row.usage_source, unavailableReason: row.unavailable_reason, error: decoded(row.error_json) });
  }
  readIntentFacts(raw: ReadIntentInput) {
    try { return this.db.transaction(() => {
      const input = checked(ReadIntentInputSchema, raw, 'invalid_argument');
      const runId = 'runId' in input ? input.runId : this.call(input.intentCallId)?.run_id;
      const saved=runId===undefined?null:this.db.query<{config_json:string},[number]>('SELECT config_json FROM runs WHERE id=?').get(runId);
      if(runId===undefined||!saved)return null;
      const rows=this.db.query<CallRow,[number]>(callSelect+' WHERE i.run_id=? ORDER BY i.id').all(runId),route=this.route(runId),rule=this.rule(runId);
      if(!rows.length&&!route&&!rule&&!(decoded(saved.config_json) as {intentAdmission?:unknown}).intentAdmission)return null;
      const run=this.owner(runId);
      return checked(readFactsSchema, { contract: 'medclaw.intent-read/v2', runId: run.id, sessionId: run.session_id, inputId: run.input_id,
        ruleEvaluation: rule, calls: rows.map(row => {
          const registration = this.registration(row), model = this.readModelCall(row.model_call_id);
          const validation = row.validation_json === null ? null : checked(IntentValidationSchema, decoded(row.validation_json));
          if (validation ? validation.state !== row.validation_state : row.validation_state !== 'pending') fail('storage_read_failed');
          return { id: row.id, callId: row.call_id, intentCallId: row.call_id, stage: row.stage, previousCallId: registration.previousCallId,
            state: model.state, model: model.model, snapshotId: row.snapshot_id, startedAt: model.startedAt, endedAt: model.endedAt, error: model.error,
            prediction: row.parsed_result_json === null ? null : checked(IntentResultSchema, decoded(row.parsed_result_json)),
            rawOutput: row.raw_output === null ? null : { text: row.raw_output, truncated: validation?.rawOutputTruncated ?? false }, validation };
        }), decision: route === null ? null : { ...this.decision(route), id: route.id, createdAt: route.created_at } });
    }).deferred(); } catch (error) { if (error instanceof Error && error.name === 'SQLiteError') fail('storage_read_failed'); throw error; }
  }
  readIntentStageInput(callId: string) {
    const row=this.call(callId);if(!row)fail('storage_read_failed');
    const registration=this.registration(row),run=this.owner(row.run_id,row.session_id,row.input_id);
    const snapshot=this.db.query<{run_id:number;session_id:number;input_id:number;snapshot_json:string},[number]>('SELECT * FROM context_snapshots WHERE id=?').get(row.snapshot_id);
    if(!snapshot||snapshot.run_id!==run.id||snapshot.session_id!==run.session_id||snapshot.input_id!==run.input_id)fail('storage_read_failed');
    const body=checked(ContextSnapshotBodySchema,legacyContextBody(decoded(snapshot.snapshot_json)));
    const rawBody=decoded(snapshot.snapshot_json) as {intentSource?:{stageInput?:unknown}};
    const stage=readLegacyIntentContext(body.renderedProjection,rawBody.intentSource?.stageInput);
    if(!isDeepStrictEqual(body.intentSource,intentContextSource(registration.input))||!isDeepStrictEqual(stage,registration.input))fail('storage_read_failed');
    return registration.input;
  }
  prepareIntentInput(raw: PrepareIntentInput) {
    try { return this.db.transaction(() => {
      const input=checked(PrepareIntentInputSchema,raw,'invalid_argument'),run=this.owner(input.runId);
      const session=this.db.query<{current_leaf_id:string|null;storage_version:number},[number]>('SELECT current_leaf_id,storage_version FROM sessions WHERE id=?').get(run.session_id);
      const accepted=this.db.query<{content_json:string;status:string;target_run_id:number},[number]>('SELECT content_json,status,target_run_id FROM session_inputs WHERE id=?').get(run.input_id);
      if(!session||!accepted||accepted.status!=='queued'||accepted.target_run_id!==run.id||!['created','running'].includes(run.status)||run.cancel_requested_at!==null)fail('state_conflict');
      const content=checked(InputContentSchema,legacyInputContent(decoded(accepted.content_json))),frozen=checked(FrozenIntentAdmissionSchema,content.intentAdmission);
      const configuration=decoded(run.config_json) as {intentAdmission?:unknown};
      if(!isDeepStrictEqual(checked(FrozenIntentAdmissionSchema,legacyIntentAdmission(configuration.intentAdmission)),frozen))fail('storage_read_failed');
      if(session.current_leaf_id!==frozen.baseLeafId||session.storage_version!==frozen.baseStorageVersion)fail('state_conflict');
      const scope=checked(RunScopeSchema,legacyRunScope(decoded(run.scope_json))),refs=readWorkspaceBatchReferences(this.db,scope.batchIds).refs;
      if(!isDeepStrictEqual(scope,content.scope)||refs.some(ref=>!content.workspaceContext.batchRefs.some(value=>isDeepStrictEqual(ref,value))))fail('access_denied');
      type NativeRow={native_entry_id:string;parent_entry_id:string|null;run_id:number|null;entry_json:string};
      const branch=new Map<string,NativeRow>();let cursor=session.current_leaf_id;
      while(cursor!==null){if(branch.has(cursor))fail('storage_read_failed');
        const entry=this.db.query<NativeRow,[number,string]>('SELECT native_entry_id,parent_entry_id,run_id,entry_json FROM memories WHERE session_id=? AND native_entry_id=?').get(run.session_id,cursor);
        if(!entry)fail('storage_read_failed');branch.set(cursor,entry);cursor=entry.parent_entry_id;}
      const recentTurns:import('../../contracts/src/intent').IntentInputProjection['recentTurns']=[];
      let nearestCondition:NativeRow|undefined;
      let pendingClarification:import('../../contracts/src/intent').IntentInputProjection['pendingClarification']=null;
      let latestBusinessResultSeen=false;
      for(const saved of branch.values()){
        const entry=decoded(saved.entry_json) as {type:string;customType?:string;details?:unknown;data?:unknown;content?:unknown;message?:{role:string;content:unknown;stopReason?:string}};
        if(!nearestCondition&&entry.type==='custom'&&entry.customType==='medclaw-query-context')nearestCondition=saved;
        if(recentTurns.length===4&&latestBusinessResultSeen)continue;
        const source=entry.type==='message'?(entry.message?.role==='user'?'user':entry.message?.role==='assistant'&&['stop','length'].includes(entry.message.stopReason??'')?'model':null)
          :entry.type==='custom_message'&&entry.customType==='medclaw-query-result'?'program':null;
        if(!source)continue;
        const value=entry.type==='message'?entry.message!.content:entry.content;
        const text=typeof value==='string'?value:Array.isArray(value)?value.filter(part=>part.type==='text').map(part=>part.text).join(''):null;
        if(text===null)fail('storage_read_failed');
        if(source==='user'&&!this.db.query("SELECT id FROM session_inputs WHERE session_id=? AND run_id=? AND native_entry_id=? AND status='consumed'").get(run.session_id,saved.run_id,saved.native_entry_id))fail('storage_read_failed');
        if(source==='model'){
          if(!this.db.query("SELECT a.id FROM answers a JOIN runs r ON r.id=a.run_id WHERE a.session_id=? AND a.run_id=? AND a.text=? AND r.status='completed'").get(run.session_id,saved.run_id,text))continue;
          const route=this.route(saved.run_id!);
          if(route&&this.decision(route).route==='agent')latestBusinessResultSeen=true;
        }
        if(source==='program'){
          const details=checked(ProductResultDetailsSchema,entry.details);
          const answer=this.db.query<{text:string;kind:string;query_ids_json:string;missing_slots_json:string},[number,number,number,number]>(`SELECT a.* FROM answers a JOIN runs r ON r.id=a.run_id
            JOIN route_decisions d ON d.id=? AND d.run_id=r.id WHERE a.session_id=? AND a.run_id=? AND a.input_id=? AND r.status='completed'`).get(details.decisionId,run.session_id,details.runId,details.inputId);
          if(saved.run_id!==details.runId||!answer||answer.text!==text||answer.kind!==details.kind||!isDeepStrictEqual(decoded(answer.query_ids_json),details.queryIds)
            ||!isDeepStrictEqual(decoded(answer.missing_slots_json),details.missingSlots))fail('storage_read_failed');
          if(!latestBusinessResultSeen&&details.kind!=='out_of_scope'){
            latestBusinessResultSeen=true;
            if(['clarification','insufficient_evidence'].includes(details.kind)){
              const prior=this.owner(details.runId,run.session_id,details.inputId),route=this.route(prior.id);
              if(!route||route.id!==details.decisionId)fail('storage_read_failed');
              const decision=this.decision(route),projection=decision.intentCallId===null?null:this.readIntentStageInput(decision.intentCallId).input;
              if(projection&&isDeepStrictEqual(projection.scope.batchIds,scope.batchIds)){
                const original=this.db.query<{content_json:string},[number]>('SELECT content_json FROM session_inputs WHERE id=?').get(details.inputId);
                if(!original)fail('storage_read_failed');
                pendingClarification={taskText:projection.pendingClarification?.taskText??checked(InputContentSchema,legacyInputContent(decoded(original.content_json))).text,missingSlots:details.missingSlots};
              }
            }
          }
        }
        if(recentTurns.length<4)recentTurns.push({nativeEntryId:saved.native_entry_id,source,text:text.slice(0,4096)});
      }
      let previousQueryContext:QueryContextRecord|null=null;
      if(nearestCondition){
        const entry=decoded(nearestCondition.entry_json) as {data:unknown},adopted=checked(QueryContextFactSchema,legacyQueryContext(entry.data));
        const cached=this.db.query<Record<string,unknown>,[number]>('SELECT * FROM query_contexts WHERE session_id=?').get(run.session_id);
        const branchIds=[...branch.keys()],projectionIndex=branchIds.indexOf(cached?.native_leaf_id as string);
        if(!cached||projectionIndex<0||projectionIndex>branchIds.indexOf(nearestCondition.native_entry_id)
          ||nearestCondition.run_id!==adopted.sourceRunId)fail('storage_read_failed');
        const context=this.readContextProjection(cached),decisionId=adopted.decisionId;
        const source=this.owner(adopted.sourceRunId,run.session_id,adopted.sourceInputId),route=this.route(source.id);
        const executionRow=nearestCondition.parent_entry_id===null?null:branch.get(nearestCondition.parent_entry_id);
        const nativeExecution=executionRow?decoded(executionRow.entry_json) as {type:string;customType:string;data:unknown}:null;
        if(source.status!=='completed'||!route||route.id!==decisionId||executionRow?.run_id!==source.id||nativeExecution?.type!=='custom')fail('storage_read_failed');
        const decision=this.decision(route),queryRefs:{queryId:number}[]=[];
        if(adopted.contract==='medclaw.query-form-context/v1'){
          if(!('contract' in context)||nativeExecution.customType!=='medclaw-query-form-execution'||decision.decisionSource!=='user_form')fail('storage_read_failed');
          const {sessionId:_sessionId,nativeLeafId:_leaf,version:_version,pendingClarification:_pending,...fact}=context;
          const execution=checked(FormExecutionFactSchema,omitLegacyFields(nativeExecution.data,['resultHash']));
          if(!isDeepStrictEqual(fact,adopted)||!isDeepStrictEqual(decision.queryParams,adopted.params)||execution.decisionId!==decisionId
            ||!isDeepStrictEqual(adopted.queryIds,[execution.queryId]))fail('storage_read_failed');
          queryRefs.push({queryId:execution.queryId});
        }else{
          if('contract' in context||nativeExecution.customType!=='medclaw-intent-execution'||decision.decisionSource==='user_form')fail('storage_read_failed');
          const {contract:_contract,decisionId:_decision,...adoptedFields}=adopted,{sessionId:_sessionId,nativeLeafId:_leaf,version:_version,...contextFields}=context;
          const execution=checked(IntentExecutionFactSchema,legacyIntentExecution(nativeExecution.data));
          if(!isDeepStrictEqual(adoptedFields,contextFields)||execution.decisionId!==decisionId||!isDeepStrictEqual(execution.taskIntents,adopted.taskIntents)
            ||!isDeepStrictEqual(decision.adoptedIntents,adopted.taskIntents)||decision.contextIntentId!==adopted.contextIntentId
            ||!isDeepStrictEqual(decision.adoptedSlots,adopted.adoptedSlots))fail('storage_read_failed');
          queryRefs.push(...execution.stepResults.flatMap(step=>step.queryRefs));
        }
        const queries=new SqliteToolStore(this.db);
        for(const queryId of adopted.queryIds){const query=queries.readQuery(queryId),ref=queryRefs.find(ref=>ref.queryId===queryId);
          if(!query||!ref||query.runId!==source.id||query.sessionId!==run.session_id||query.inputId!==source.input_id
            ||adopted.contract==='medclaw.query-form-context/v1'&&(query.source!=='user_form'||!isDeepStrictEqual(query.params,adopted.params)
              ||query.callRef!==`form:${source.id}:${source.input_id}`))fail('storage_read_failed');}
        if(isDeepStrictEqual(checked(RunScopeSchema,legacyRunScope(decoded(source.scope_json))).batchIds,scope.batchIds))previousQueryContext=context;
      }
      const catalog=new SqliteCatalogStore(this.db),batches=catalog.readBatches(scope.batchIds),rows=catalog.readIntentSnapshots(scope.batchIds,scope.deviceIds);
      const unique=(values:string[])=>[...new Set(values)].sort();
      return checked(IntentInputProjectionSchema,{contract:'medclaw.intent-input/v2',runId:run.id,sessionId:run.session_id,inputId:run.input_id,
        baseLeafId:frozen.baseLeafId,baseStorageVersion:frozen.baseStorageVersion,text:content.text,referenceDate:run.reference_date,timezone:run.timezone,
        scope,previousQueryContext,pendingClarification:latestBusinessResultSeen?pendingClarification:previousQueryContext?.pendingClarification??null,recentTurns:recentTurns.reverse(),
        selectedEntities:(scope.deviceIds??[]).map(deviceId=>{const row=rows.find(row=>row.deviceId===deviceId);if(!row)fail('access_denied');return {deviceId,label:row.deviceName};}),
        availableData:{regions:unique(batches.map(batch=>batch.region)),dates:unique(batches.map(batch=>batch.snapshotDate)),currencies:unique(rows.map(row=>row.currency)),units:unique(rows.map(row=>row.unit))},
        enabledL2:input.enabledL2,availableToolNames:scope.allowedToolNames,versions:{configVersion:frozen.selection.configVersion,
          taxonomyVersion:frozen.selection.taxonomyVersion,ruleVersion:frozen.selection.ruleVersion,classifyPromptVersion:frozen.selection.classifyPromptVersion,
          verifyPromptVersion:frozen.selection.verifyPromptVersion,schemaVersion:frozen.selection.schemaVersion,policyVersion:frozen.selection.policyVersion}});
    }).deferred(); }catch(error){if(error instanceof Error&&error.name==='SQLiteError')fail('storage_read_failed');throw error;}
  }
}
