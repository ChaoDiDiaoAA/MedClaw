import type { Database } from "bun:sqlite";
import { stopProofForOwner, type ProcessTreeProof } from '@medclaw/contracts/maintenance';
import { isDeepStrictEqual } from "node:util";
import { legacyRunConfig, legacyRunScope, legacyRunResources, legacyRunExtensions, legacyContextBody, legacyModelCallContext, legacyModelSelection, legacyChildConfig, legacyChildResult, legacyQueryContext, legacyIntentExecution, legacyIntentMetadata, legacyInputContent, legacyWorkspaceContext, legacyToolDelivery, legacyBusinessToolOutput, omitLegacyFields } from './legacy-business-fields';
import { ProviderRequestOriginalSchema } from '../../contracts/src/controller-evidence';
import { z } from "zod";
import { AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema, safeError, type AppError } from "../../contracts/src/error";
import { ToolSdkDeliverySchema } from "../../contracts/src/tool";
import { ToolControlObservationSchema } from "../../contracts/src/model";
import { SqliteInputStore } from "./input-store";
import { SqliteIntentStore } from './intent-store';
import type { IntentCallRegistration, IntentCallCompletion, RouteCommit, ReadIntentInput } from '../../contracts/src/intent';
import { IntentReadResultSchema, IntentDecisionSchema, INTENT_VERSIONS, ProductResultDetailsSchema, ProductSettlementSchema, IntentExecutionFactSchema, IntentQueryStepInputSchema, IntentStepMetadataSchema, AdoptedContextFactSchema, QueryContextRecordSchema, QueryContextFactSchema, FormContextFactSchema, FormExecutionFactSchema, FrozenIntentAdmissionSchema, type PrepareIntentInput, type QueryContextFact } from '../../contracts/src/intent';
import type { SqliteMemoryStore } from './memory-store';
import { SqliteEventStore } from './event-store';
import { SqliteWriteTransactions } from './write-transactions';
import { verifyPriorContextFacts } from './context-store';
import { ModelCallContextSchema, ContextSnapshotBodySchema, type StartCallContext } from '../../contracts/src/context';
import { FrozenRunResourcesSchema, ResourceEvidenceSchema, ResourceReadFactSchema, resourceRefKey, type FrozenRunResources, type ResourceEvidence } from '../../contracts/src/resources';
import { FrozenRunExtensionsSchema, type FrozenRunExtensions } from '../../contracts/src/extensions';
import { FrozenChildConfigSchema, ChildResultSchema, BoundChildIdentitySchema, childScopeWithin, type BoundChildIdentity, type RegisterChildInput, type FinalChildFact, type ChildResult, type CommittedChildExecutionProof } from '../../contracts/src/subagent';
import type { ToolExecutionContext } from '../../contracts/src/tool';
import { readFrozenChild, canReadRelatedQuery } from './child-identity';
import type { EventWriter, RegisteredEventDraft, RegisteredEventPayload } from '../../contracts/src/event';
import { RegisteredEventPayloadSchema } from '../../contracts/src/event';
import { NATIVE_HISTORY_FORMAT, InputContentSchema, type NativeHistoryCommit, type InitialNativeHistory, type PreparedInput, type InputStore, type InputCancelProof, type InputSettlementProof, type ReadInputRequest, type ListInputsRequest } from "../../contracts/src/session";
import { CompactSessionInputSchema, ReadCompactionInputSchema, FrozenCompactionSchema, StoredCompactionOperationSchema, CompactionReceiptSchema, CompactionSaveFactSchema, CompactionCallOwnerSchema, CompactionCallMetadataSchema,
  type CompactSessionInput, type ReadCompactionInput, type FrozenCompaction, type StoredCompactionOperation, type CompactionCallOwner, type CompactionReceipt, type CompactionSaveFact } from '../../contracts/src/session';
import { SqliteToolStore } from "./tool-store";
import { SqliteCatalogStore } from './catalog-store';
import { HistorySourceStore } from './history-source-store';
import { readWorkspaceBatchReferences, readWorkspaceQuery, validateWorkspaceSelection, freezeWorkspaceScope } from './workspace-selection';
import { AnswerRecordSchema, type AnswerRecord, type QueryRecord } from '../../contracts/src/query';
import { ActivityListInputSchema, ActivityListSchema, BusinessActivitySchema } from '../../contracts/src/export';
import { RenameSessionInputSchema, DeleteSessionInputSchema, ReadManagementOperationInputSchema, SessionManagementDetailsSchema, SessionManagementReceiptSchema,
  type RenameSessionInput, type DeleteSessionInput, type ReadManagementOperationInput, type SessionManagementReceipt, type SessionManagementDetails,
  NewSessionInputSchema, NewSessionResultSchema, SelectSessionInputSchema, SessionViewSchema, ListSessionsRequestSchema, SubmitInputSchema, ReadSubmissionRequestSchema,
  type NewSessionInput, type NewSessionResult, type SelectSessionInput, type SessionView, type SessionPage, type ReadSubmissionRequest, type SubmitInput, type SubmitResult, type SessionStore } from "../../contracts/src/session";
import { ReadSessionCheckpointsInputSchema, RestoreSessionCheckpointInputSchema, SessionCheckpointDetailsSchema, SessionCheckpointPageSchema,
  type ReadSessionCheckpointsInput,type RestoreSessionCheckpointInput,type SessionCheckpointReceipt,type SessionCheckpointDetails,type NativeHistorySnapshot } from '../../contracts/src/session';
import { WorkspaceStateSchema, WorkspaceViewSchema, WorkspaceContextSchema, WorkspaceChangeSchema, RevisionSchema, toWorkspaceContext, type WorkspaceState, type WorkspaceSelection, type WorkspaceView, type WorkspaceChange, type BatchRef, type WorkspaceStore, type WorkspaceInspection, type WorkspaceNotice } from "../../contracts/src/workspace";
import { businessToolSchemas } from "../../contracts/src/business-tools";
import { StoredToolConfigurationSchema, normalizeToolConfiguration } from '../../contracts/src/tool-config';
import { RuntimeConfigurationSchema } from '../../contracts/src/runtime-config';
import {
  DiagnoseRequestSchema, ModelSelectionSchema, ProviderRequestSchema, RequestPolicySchema, ReferenceDateSchema, TimezoneSchema,
  AgentPolicySchema, MeasurementContextSchema, ToolProfileSnapshotSchema,
  type ProviderAccepted, type ProviderRequest,
} from "../../contracts/src/model";
import {
  ModelCallViewSchema, ReadRunRequestSchema, RunViewSchema, RecentRunViewSchema, RunCleanupRecordSchema, P2AgentOptionsSchema, RunScopeSchema, canonicalRequest, sliceOutput, sliceText, safePreview,
  type ModelCallView, type ReadRunResult, type RunView, type RegisterProviderInput,
  type ProviderOperation, type FinalProviderFact, type ProviderRunStore, type RegisterAgentInput, type FinalAgentFact, type StoredOperation, type RunCleanupRecord, type RunScope,
} from "../../contracts/src/run";
export type { RegisterProviderInput, ProviderOperation, FinalCallFact, FinalProviderFact } from "../../contracts/src/run";
const usageSchema = z.object({
  source: z.string().max(100).nullable().optional(),
  unavailableReason: z.string().max(200).nullable().optional(),
  cacheRead: z.number().int().nonnegative().safe().nullable().optional(),
  cacheWrite: z.number().int().nonnegative().safe().nullable().optional(),
  cacheWrite1h: z.number().int().nonnegative().safe().nullable().optional(),
  reasoning: z.number().int().nonnegative().safe().nullable().optional(),
  totalTokens: z.number().int().nonnegative().safe().nullable().optional(),
  costSource: z.string().max(100).nullable().optional(),
}).strict();
const cleanupSchema = z.object({
  oldProcessExited: z.boolean().optional(), observationGap: z.boolean().optional(),
  previousInstanceId: z.string().max(512).optional(), errors: z.array(AppErrorSchema).max(10).optional(),
}).strict();

const providerConfigSchema = z.object({
  providerRequest: z.discriminatedUnion("method", [
    z.object({ operationRef: z.string().min(1).max(512), method: z.literal("model.request"), originalRequest: ProviderRequestSchema }).strict(),
    z.object({ operationRef: z.string().min(1).max(512), method: z.literal("model.diagnose"), originalRequest: DiagnoseRequestSchema }).strict(),
  ]),
  selection: ModelSelectionSchema, policy: RequestPolicySchema, runtimeConfiguration: RuntimeConfigurationSchema.optional(),
}).strict();
const agentConfigSchema = z.strictObject({ selection: ModelSelectionSchema, policy: RequestPolicySchema,
  intentAdmission: FrozenIntentAdmissionSchema.optional(),
  toolConfiguration: StoredToolConfigurationSchema.optional(),
  runtimeConfiguration: RuntimeConfigurationSchema.optional(),
  agentPolicy: AgentPolicySchema.optional(),
  measurementContext: MeasurementContextSchema.optional(),
  toolProfileSnapshot: ToolProfileSnapshotSchema.optional(),
  referenceDate: z.string(), timezone: z.string(), agent: P2AgentOptionsSchema.extend({ stage: z.enum(["P2", "P3"]), nativeSessionId: OpaqueIdSchema,
    resources: FrozenRunResourcesSchema.optional(),
    extensions: FrozenRunExtensionsSchema.optional(),
    tools: z.array(z.string()), autoCompaction: z.boolean(), autoRetry: z.literal(false), cacheWarming: z.literal("off"), contextContract: z.literal('medclaw.context/v1').optional(),historyContract:z.literal('medclaw.history/p9-v1').optional() }) })
  .refine(config => config.agent.autoCompaction === (config.agent.compaction?.enabled ?? false), 'Frozen compaction configuration mismatch');
const commonConfigSchema = z.object({ selection: ModelSelectionSchema, policy: RequestPolicySchema });
const savedDeliverySchema = z.object({ contract: z.literal("medclaw.tool-delivery/v1"), resultRecorded: z.boolean(), sdkReturned: z.boolean(),
  nativeEntryId: OpaqueIdSchema.nullable(), deliveredAt: TimestampSchema.nullable(), nextModelCallId: z.string().min(1).nullable(), consumedAt: TimestampSchema.nullable(),
  error: AppErrorSchema.nullable(), message: ToolSdkDeliverySchema.optional(), control: ToolControlObservationSchema.optional(),
  consumptionEvidence: z.literal("provider_input_verified").optional(),
  resourceRead: ResourceReadFactSchema.optional(),
});
const scope = { batchIds: [], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true };
type RunRow = {
  input_id: number | null; kind: "provider" | "agent" | "child"; session_id: number | null; submission_operation_ref: string | null;
  parent_run_id?: number | null; origin_tool_call_id?: number | null; child_result_json?: string | null;
  submission_client_sequence: number | null; submission_request_json: string | null;
  id: number; instance_id: string; status: RunView["status"]; goal: "answer" | "verify";
  input_text: string; output_text: string | null; config_json: string; prior_run_id: number | null;
  reference_date: string; timezone: string; created_at: string; started_at: string | null;
  cancel_requested_at: string | null; stopped_at: string | null; ended_at: string | null;
  error_json: string | null; cleanup_json: string | null; usage_json: string | null;
  scope_json: string; workspace_json: string | null;
};
type CallRow = {
  input_id: number | null; id: number; call_id: string; kind: "main" | "diagnostic" | "compaction" | "intent"; model_json: string;
  granularity: string; attempt: number; attempt_count_unknown: number;
  state: ModelCallView["state"]; started_at: string; ended_at: string | null; duration_ms: number | null;
  input_tokens: number | null; output_tokens: number | null; cost: number | null;
  cost_currency: string | null; usage_source: string | null; unavailable_reason: string | null; error_json: string | null;
};
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function checked<T>(schema: z.ZodType<T>, value: unknown, code = "invalid_argument"): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : fail(code);
}
function legacyCallMetadata(value: unknown): unknown {
  const model=value as Record<string,unknown>|null;
  if(model===null||typeof model!=='object'||Array.isArray(model))return model;
  return {...model,selection:legacyModelSelection(model.selection),...(model.context===undefined?{}:{context:legacyModelCallContext(model.context)}),
    ...(Array.isArray(model.requestOriginals)?{requestOriginals:model.requestOriginals.map(item=>omitLegacyFields(item,['sha256']))}:{})};
}
function json(value: unknown): string | null { return value == null ? null : JSON.stringify(value); }
function decoded(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return fail("storage_write_failed"); }
}
function id(value: number) { if (!Number.isSafeInteger(value) || value <= 0) fail("invalid_argument"); }
function timestamp(value: string | null) {
  if (value !== null && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) fail("invalid_argument");
}

export class Repositories implements ProviderRunStore, SessionStore, WorkspaceStore {
  private readonly p3: boolean;
  private readonly inputs: SqliteInputStore;
  private readonly intents: SqliteIntentStore | null;
  private readonly p5: boolean;
  private readonly childRuns:boolean;
  private readonly batchLifecycle:boolean;
  private readonly events: EventWriter | undefined;
  constructor(private readonly db: Database, private readonly beforeCommit?: () => void, events?: EventWriter,
    private readonly transactions = SqliteWriteTransactions.forDatabase(db),private readonly memory?:SqliteMemoryStore,private readonly evidenceInstanceId?:string) {
    this.events = events ?? (db.query("SELECT name FROM sqlite_schema WHERE name='runtime_events'").get() ? new SqliteEventStore(db, transactions) : undefined);
    this.inputs = new SqliteInputStore(db, this.events);
    this.intents = db.query("SELECT name FROM sqlite_schema WHERE name='intent_calls'").get() ? new SqliteIntentStore(db, this.events, transactions) : null;
    this.p5 = db.query("SELECT name FROM sqlite_schema WHERE name='session_inputs'").get() !== null;
    this.childRuns=!!db.query("SELECT name FROM pragma_table_info('runs') WHERE name='parent_run_id'").get();
    this.p3 = this.db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name='answers'").get() !== null;
    this.batchLifecycle=!!db.query("SELECT name FROM pragma_table_info('batches') WHERE name='status'").get();
  }

  private event(row: RunRow, fact: RegisteredEventPayload, at: string, source: RegisteredEventDraft['source'] = 'application', toolCallId: number | null = null): void {
    if (!this.events || !['agent','child'].includes(row.kind) || row.session_id === null) return;
    this.events.appendInTransaction({...fact,runId:row.id,sessionId:row.session_id,source,sourceConnection:null,sourceSequence:null,toolCallId,occurredAt:at,receivedAt:at});
  }
  private runLifecycle(row: RunRow, type: 'run_created'|'run_started', at: string): void {
    if((row.kind==='agent'||row.kind==='child')&&row.session_id!==null)this.event(row,{type,payload:{contract:'medclaw.event/v1',sessionId:row.session_id,kind:row.kind,configVersion:this.config(row).selection.configVersion}},at);
  }
  private runTerminal(row: RunRow, status: 'completed'|'failed'|'cancelled', error: AppError|null, cleanup: unknown, at: string): void {
    const saved = RunCleanupRecordSchema.safeParse(cleanup);
    const answer = this.p3 ? this.db.query<{id:number},[number]>('SELECT id FROM answers WHERE run_id=?').get(row.id) : null;
    const payload={contract:'medclaw.event/v1' as const,answerId:answer?.id??null,stopConfirmed:saved.success?saved.data.stopConfirmed:null};
    if(status==='completed')this.event(row,{type:'run_completed',payload:{...payload,errorCode:null}},at);
    else if(status==='failed'){
      if(row.kind==='agent'&&error===null)fail('storage_write_failed');
      if(error)this.event(row,{type:'run_failed',payload:{...payload,errorCode:error.code}},at);
    }else this.event(row,{type:'run_cancelled',payload:{...payload,errorCode:error?.code??null}},at);
  }
  private recoveredToolEvent(run:RunRow,callId:number,error:AppError,at:string):void {
    const row=this.db.query<{native_tool_call_id:string},[number]>('SELECT native_tool_call_id FROM tool_calls WHERE id=?').get(callId);
    if(!row)fail('storage_write_failed');
    const queryIds=this.db.query<{id:number},[number,string]>('SELECT id FROM queries WHERE run_id=? AND call_ref=? ORDER BY id').all(run.id,`${run.id}:${row.native_tool_call_id}`).map(query=>query.id);
    this.event(run,{type:'tool_finished',payload:{contract:'medclaw.event/v1',callId,nativeToolCallId:row.native_tool_call_id,status:'failed',queryIds,errorCode:error.code}},at,'host',callId);
  }

  private creationReceipt(text: string): NewSessionResult {
    const value = decoded(text) as NewSessionResult;
    return checked(NewSessionResultSchema, {...value, session: {...value.session, inputControl: value.session.inputControl ?? null, metadataRevision:value.session.metadataRevision ?? 0, deletedAt:value.session.deletedAt ?? null}}, "storage_read_failed");
  }
  private inputRead<T>(action:()=>T):T {try{return action();}catch(error){if(error instanceof Error&&error.name==='SQLiteError')fail('storage_read_failed');throw error;}}
  private inputWrite<T>(action:()=>T):T {try{return this.transactions.immediate(()=>{const result=action();this.beforeCommit?.();return result;});}catch(error){if(error instanceof Error&&error.name==='SQLiteError')fail('storage_write_failed');throw error;}}
  registerIntentCall(input: IntentCallRegistration) { return this.inputWrite(() => (this.intents ?? fail('state_conflict')).registerIntentCall(input)); }
  finishIntentCall(input: IntentCallCompletion): void { this.inputWrite(() => (this.intents ?? fail('state_conflict')).finishIntentCall(input)); }
  commitRoute(input: RouteCommit) { return this.inputWrite(() => (this.intents ?? fail('state_conflict')).commitRoute(input)); }
  readIntent(input: ReadIntentInput) { return this.inputRead(() => this.db.transaction(()=>{
    const facts=(this.intents??fail('state_conflict')).readIntentFacts(input);if(!facts)return null;
    try{
      const row=this.row(facts.runId)!,cleanup=row.cleanup_json===null?null:checked(RunCleanupRecordSchema,decoded(row.cleanup_json));
      const answer=this.db.query<{id:number},[number]>('SELECT id FROM answers WHERE run_id=?').get(row.id);
      const hasContext=!!this.db.query('SELECT session_id FROM query_contexts WHERE session_id=?').get(facts.sessionId);
      const hasHistory=!!this.db.query("SELECT id FROM runtime_events WHERE run_id=? AND type='history_saved'").get(row.id);
      const snapshot=this.memory?this.memory.loadInTransaction(facts.sessionId):answer||hasContext||hasHistory?fail('storage_read_failed'):null;
      const fallback=facts.decision?.decisionSource==='explicit_agent_fallback';
      const final=row.status==='completed'&&facts.decision&&!fallback&&snapshot?this.readSavedIntentFinal(row,snapshot):null;
      let history=final?.history??(snapshot&&['failed','cancelled'].includes(row.status)&&cleanup?.requiredPersistenceComplete?this.readSavedIntentHistory(row,snapshot):null);
      if(fallback&&row.status==='completed'&&snapshot){
        const saved=this.readSavedAnswerHistory(row,snapshot);
        const queryIds=this.db.query<{id:number},[number]>('SELECT id FROM queries WHERE run_id=? ORDER BY id').all(row.id).map(query=>query.id);
        if(saved.answer.kind!=='result'||!isDeepStrictEqual(decoded(saved.answer.query_ids_json),queryIds)||!isDeepStrictEqual(decoded(saved.answer.missing_slots_json),[]))fail('storage_read_failed');
        this.validateFinalAnswer(row,{history:saved.history,outputText:row.output_text});history=saved.history;
      }
      const store=new SqliteToolStore(this.db),queryIds=this.db.query<{id:number},[number]>('SELECT id FROM queries WHERE run_id=? ORDER BY id').all(row.id).map(query=>{
        const saved=store.readQuery(query.id);if(!saved||saved.runId!==row.id||saved.sessionId!==row.session_id)fail('storage_read_failed');return query.id;
      });
      return checked(IntentReadResultSchema,{...facts,execution:{runStatus:row.status,queryIds,stepResults:final&&'stepResults' in final.proof.execution?final.proof.execution.stepResults:[],
        answerId:answer?.id??null,finalHistorySaved:history!==null,requiredPersistenceComplete:cleanup?.requiredPersistenceComplete??null},
        effectiveContext:snapshot?this.readEffectiveIntentContext(snapshot):null});
    }catch{fail('storage_read_failed');}
  }).deferred()); }

  private readSavedIntentHistory(row:RunRow,snapshot:NativeHistorySnapshot,leafId?:string):NativeHistoryCommit|null {
    const event=this.db.query<{payload_json:string},[number,number]>("SELECT payload_json FROM runtime_events WHERE run_id=? AND session_id=? AND type='history_saved' AND source='pi' ORDER BY id DESC LIMIT 1").get(row.id,snapshot.sessionId);
    if(!event)return null;
    const saved=checked(RegisteredEventPayloadSchema,{type:'history_saved',payload:decoded(event.payload_json)});
    if(saved.type!=='history_saved'||leafId!==undefined&&saved.payload.nativeLeafId!==leafId)fail('storage_read_failed');
    const history:NativeHistoryCommit={sessionId:snapshot.sessionId,runId:row.id,header:snapshot.header,expectedStorageVersion:saved.payload.storageVersion-1,
      activeLeafId:saved.payload.nativeLeafId,newEntries:this.db.query<{entry_json:string},[number,number]>('SELECT entry_json FROM memories WHERE session_id=? AND run_id=? ORDER BY sequence').all(snapshot.sessionId,row.id).map(entry=>decoded(entry.entry_json))};
    if(!this.memory?.confirmCommitted(history))fail('storage_read_failed');return history;
  }

  private readSavedAnswerHistory(row:RunRow,snapshot:NativeHistorySnapshot) {
    const answer=this.db.query<{id:number;session_id:number;input_id:number;text:string;kind:string;query_ids_json:string;missing_slots_json:string;native_leaf_id:string|null},[number]>('SELECT * FROM answers WHERE run_id=?').get(row.id);
    if(!answer||row.status!=='completed'||row.input_id===null||row.ended_at===null||answer.session_id!==row.session_id||answer.input_id!==row.input_id
      ||answer.native_leaf_id===null||answer.text!==row.output_text||row.error_json!==null)fail('storage_read_failed');
    const history=this.readSavedIntentHistory(row,snapshot,answer.native_leaf_id);if(!history)fail('storage_read_failed');
    return {answer,history,inputId:row.input_id,endedAt:row.ended_at,nativeLeafId:answer.native_leaf_id};
  }
  private readSavedIntentFinal(row:RunRow,snapshot:NativeHistorySnapshot) {
    const {answer,history,inputId,endedAt,nativeLeafId}=this.readSavedAnswerHistory(row,snapshot);
    type Entry={id:string;parentId:string|null;type:string;customType?:string;data?:unknown};
    const entries=new Map((snapshot.entries as Entry[]).map(entry=>[entry.id,entry])),leaf=entries.get(nativeLeafId);
    const condition=leaf?.type==='custom'&&leaf.customType==='medclaw-query-context'?leaf:null;
    const execution=condition?.parentId?entries.get(condition.parentId):leaf;
    if(!execution||execution.type!=='custom'||!['medclaw-intent-execution','medclaw-query-form-execution'].includes(execution.customType??''))fail('storage_read_failed');
    const input=this.inputs.required(inputId),decision=this.intents!.readIntentFacts({runId:row.id})?.decision;
    if(!decision||input.status!=='consumed'||input.processing_status!=='completed'||input.run_id!==row.id||input.session_id!==row.session_id)fail('storage_read_failed');
    const program=decision.route!=='agent',turn={userEntryId:program?input.native_entry_id:null,resultEntryId:program?execution.parentId:null,
      executionEntryId:execution.id,conditionEntryId:condition?.id??null,history};
    const base={status:'completed' as const,outputText:row.output_text,error:null,calls:[],history,productTurn:turn,cleanup:checked(RunCleanupRecordSchema,decoded(row.cleanup_json)),
      endedAt,stoppedAt:row.stopped_at,cancelRequestedAt:row.cancel_requested_at};
    const fact:FinalAgentFact=program?{...base,resultSource:decision.decisionSource==='user_form'?'user_form':'program',productSettlement:{contract:'medclaw.product-settlement/v1',basis:'product_history',nativeUserEntryId:turn.userEntryId,
      runId:row.id,sessionId:snapshot.sessionId,inputId,admissionClosed:true,requestSettled:true,routeSettled:true,requiredFactsSaved:true,pendingFactsEmpty:true}}:base;
    if(!program)this.validateFinalAnswer(row,fact);
    const proof=program?this.validateProgramFinal(row,fact,false):this.validateAgentIntentFinal(row,fact,false);
    if(!proof||!isDeepStrictEqual([...proof.queryIds].sort((a,b)=>a-b),decoded(answer.query_ids_json))
      ||!isDeepStrictEqual(decision.missingSlots,decoded(answer.missing_slots_json))||program&&checked(ProductResultDetailsSchema,Reflect.get(proof,'details')).kind!==answer.kind
      ||!program&&answer.kind!=='result')fail('storage_read_failed');
    return {history,proof,turn};
  }

  private reachableIntentCondition(snapshot:NativeHistorySnapshot) {
    type Entry={id:string;parentId:string|null;type:string;customType?:string;data?:unknown};
    const entries=new Map((snapshot.entries as Entry[]).map(entry=>[entry.id,entry])),path=this.checkpointPath(snapshot,snapshot.activeLeafId);
    const nearest=[...path].map(id=>entries.get(id)!).find(entry=>entry.type==='custom'&&entry.customType==='medclaw-query-context');
    if(!nearest)return null;
    const adopted=checked(QueryContextFactSchema,legacyQueryContext(nearest.data)),source=this.row(adopted.sourceRunId);
    if(!source||source.session_id!==snapshot.sessionId||source.input_id!==adopted.sourceInputId)fail('storage_read_failed');
    let final:ReturnType<Repositories['readSavedIntentFinal']>;
    try{final=this.readSavedIntentFinal(source,snapshot);}catch{fail('storage_read_failed');}
    if(final.turn.conditionEntryId!==nearest.id||!isDeepStrictEqual(final.proof.adopted,adopted))fail('storage_read_failed');
    return {nearest,adopted,path};
  }
  private readEffectiveIntentContext(snapshot:NativeHistorySnapshot) {
    const cached=this.db.query<Record<string,unknown>,[number]>('SELECT * FROM query_contexts WHERE session_id=?').get(snapshot.sessionId);
    const condition=this.reachableIntentCondition(snapshot);if(!condition){if(cached)fail('storage_read_failed');return null;}
    const {nearest,adopted,path}=condition;
    if(!cached||!path.has(cached.native_leaf_id as string)
      ||!this.checkpointPath(snapshot,cached.native_leaf_id as string).has(nearest.id))fail('storage_read_failed');
    const context=this.intents!.readContextProjection(cached);
    if(adopted.contract==='medclaw.query-form-context/v1'){
      if(!('contract' in context))fail('storage_read_failed');
      const {sessionId:_session,nativeLeafId:_leaf,version:_version,pendingClarification:_pending,...fact}=context;
      if(!isDeepStrictEqual(fact,adopted))fail('storage_read_failed');return context;
    }
    if('contract' in context)fail('storage_read_failed');
    const {contract:_contract,decisionId:_decision,...fields}=adopted,
      {sessionId:_session,nativeLeafId:_leaf,version:_version,...projection}=context;
    if(!isDeepStrictEqual(fields,projection))fail('storage_read_failed');
    return context;
  }
  readQueryContext(sessionId:number) {id(sessionId);return this.inputRead(()=>this.db.transaction(()=>{
    const session=this.readSession(sessionId);if(!session)fail('session_not_found');if(session.kind!=='user')fail('access_denied');
    if(!this.intents||session.storageVersion===0)return null;
    return this.readEffectiveIntentContext(this.memory?.loadInTransaction(sessionId)??fail('storage_read_failed'));
  }).deferred());}
  prepareIntentInput(input: PrepareIntentInput) { return this.inputRead(() => (this.intents ?? fail('state_conflict')).prepareIntentInput(input)); }
  readHistorySnapshot(sessionId: number) { id(sessionId);return this.inputRead(() => this.db.transaction(() => this.memory?.loadInTransaction(sessionId) ?? fail('storage_read_failed')).deferred()); }
  beginInputDelivery(inputId:number,instanceId:string,at:string):void {this.inputWrite(()=>this.inputs.beginInputDelivery(inputId,instanceId,at));}
  recordInputDelivery(inputId:number,at:string):void {this.inputWrite(()=>this.inputs.recordInputDelivery(inputId,at));}
  recordInputConsumption(inputId:number,fact:Parameters<InputStore['recordInputConsumption']>[1]):void {this.inputWrite(()=>this.inputs.recordInputConsumption(inputId,fact));}
  recordInputFailure(inputId:number,fact:Parameters<InputStore['recordInputFailure']>[1]):void {this.inputWrite(()=>this.inputs.recordInputFailure(inputId,fact));}
  recordInputCancellation(proof:InputCancelProof,at:string) {return this.inputWrite(()=>this.inputs.recordInputCancellation(proof,at));}
  readInput(request:ReadInputRequest) {return this.inputRead(()=>this.inputs.readInput(request));}
  listInputs(request:ListInputsRequest) {return this.inputRead(()=>this.inputs.listInputs(request));}
  inputsForRun(runId:number) {return this.p5?this.inputRead(()=>this.inputs.inputsForRun(runId)):[];}
  settleRunInputs(runId:number,status:'completed'|'failed'|'cancelled',at:string,proof:InputSettlementProof):void {this.inputWrite(()=>this.inputs.settleRunInputs(runId,status,at,proof));}
  verifyPriorInputFacts(runId:number,previousProcessExited:boolean,time:string) {return this.inputWrite(()=>this.p5?this.inputs.verifyPriorInputFacts(runId,previousProcessExited,time):{inputsSettled:true,requiredPersistenceComplete:true,unconfirmedItems:[] as string[]});}
  readMessageInputLinks(sessionId:number,entryIds:readonly string[]):Map<string,{inputId:number;runId:number}> {
    id(sessionId);checked(z.array(OpaqueIdSchema).max(100),entryIds);return this.inputRead(()=>{
      const links=new Map<string,{inputId:number;runId:number}>();if(!this.p5)return links;
      for(const entry of new Set(entryIds)){const row=this.db.query<import('./input-store').InputRow,[number,string]>('SELECT * FROM session_inputs WHERE session_id=? AND native_entry_id=? AND status=\'consumed\'').get(sessionId,entry);if(row){this.inputs.projection(row);links.set(entry,{inputId:row.id,runId:row.run_id!});}}return links;
    });
  }
  private checkedResources(value: unknown, sessionId: number, configVersion: string): FrozenRunResources {
    const frozen = checked(FrozenRunResourcesSchema, legacyRunResources(value), 'storage_read_failed');
    if (frozen.sessionId !== sessionId || frozen.configVersion !== configVersion) fail('storage_read_failed');
    return frozen;
  }
  readRunResources(runId: number): FrozenRunResources | null {
    id(runId); return this.inputRead(() => {
      const row = this.row(runId); if (!row) fail('run_not_found');
      if (row.kind==='child') {const child=readFrozenChild(this.db,runId);return child.resources?this.checkedResources(child.resources,child.parentSessionId,child.model.configVersion):null;}
      if (row.kind !== 'agent') return null;
      const config = checked(agentConfigSchema, legacyRunConfig(decoded(row.config_json)), 'storage_read_failed');
      return config.agent.resources ? this.checkedResources(config.agent.resources, row.session_id!, config.selection.configVersion) : null;
    });
  }
  readRunResourceScope(runId: number): RunScope | null {
    id(runId);return this.inputRead(()=>{
      const row=this.row(runId);if(!row)fail('run_not_found');
      return row.kind==='agent'?checked(RunScopeSchema,legacyRunScope(decoded(row.scope_json)),'storage_read_failed'):null;
    });
  }
  private checkedExtensions(value: unknown, sessionId: number, configVersion: string): FrozenRunExtensions {
    const frozen = checked(FrozenRunExtensionsSchema, legacyRunExtensions(value), 'storage_read_failed');
    if (frozen.sessionId !== sessionId || frozen.configVersion !== configVersion) fail('storage_read_failed');
    if (frozen.source && !isDeepStrictEqual(decoded(frozen.source.files.find(file => file.file === 'manifest.json')!.content), frozen.source.manifest)) fail('storage_read_failed');
    return frozen;
  }
  readRunExtensions(runId: number): FrozenRunExtensions | null {
    id(runId); return this.inputRead(() => {
      const row = this.row(runId); if (!row) fail('run_not_found');
      if (row.kind !== 'agent') return null;
      const config = checked(agentConfigSchema, legacyRunConfig(decoded(row.config_json)), 'storage_read_failed');
      return config.agent.extensions ? this.checkedExtensions(config.agent.extensions, row.session_id!, config.selection.configVersion) : null;
    });
  }
  readResourceOrigins(sessionId: number, nativeEntryIds: readonly string[]): Array<ResourceEvidence & {content:unknown}> {
    id(sessionId); if (nativeEntryIds.length > 1000) fail('resource_too_large');
    const entries = new Set(nativeEntryIds), runs = new Set<number>();
    for (const entry of entries) {
      checked(OpaqueIdSchema, entry);
      const row = this.db.query<{run_id:number|null}, [number,string]>('SELECT run_id FROM memories WHERE session_id=? AND native_entry_id=?').get(sessionId, entry);
      if (row?.run_id !== null && row?.run_id !== undefined) runs.add(row.run_id);
    }
    const facts: ResourceEvidence[] = [];
    for (const runId of runs) {
      for (let page = 1; ; page++) {
        const result = this.readResourceEvidence(runId, page, 100, false);
        facts.push(...result.items.filter(f => f.nativeEntryId !== null && entries.has(f.nativeEntryId)));
        if (page * 100 >= result.totalRows) break;
      }
    }
    return facts.map(fact => {
      const saved=this.db.query<{entry_json:string},[number,number,string]>('SELECT entry_json FROM memories WHERE session_id=? AND run_id=? AND native_entry_id=?').get(sessionId,fact.originRunId,fact.nativeEntryId!);
      if(!saved)fail('storage_read_failed');
      const message=(decoded(saved.entry_json) as {message?:{role?:string;content?:unknown}}).message;
      if(fact.kind==='sdk_expansion'&&fact.inputId!==null){
        const input=this.inputs.required(fact.inputId),content=this.inputs.content(input).nativeInput?.text;
        if(input.session_id!==sessionId||input.run_id!==fact.originRunId||input.native_entry_id!==fact.nativeEntryId||content===undefined||message?.role!=='user'
          ||!(message.content===content||isDeepStrictEqual(message.content,[{type:'text',text:content}])))fail('storage_read_failed');
        return {...fact,content};
      }
      if(fact.kind==='native_read'&&fact.toolCallId!==null){
        const tool=this.db.query<{delivery_json:string|null},[number,number,number]>('SELECT delivery_json FROM tool_calls WHERE id=? AND session_id=? AND run_id=?').get(fact.toolCallId,sessionId,fact.originRunId);
        const delivery=tool?.delivery_json?checked(savedDeliverySchema,legacyToolDelivery(decoded(tool.delivery_json)),'storage_read_failed'):null;
        if(!delivery?.message||!delivery.sdkReturned||delivery.nativeEntryId!==fact.nativeEntryId||!isDeepStrictEqual(message,delivery.message))fail('storage_read_failed');
        return {...fact,content:delivery.message.content};
      }
      return fail('storage_read_failed');
    });
  }
  readResourceEvidence(runId: number, page: number, pageSize: number, includeDeliveries = true): { items: ResourceEvidence[]; totalRows: number } {
    id(runId); id(page); id(pageSize); if (pageSize > 100 || !Number.isSafeInteger(page * pageSize)) fail('invalid_argument');
    return this.inputRead(() => {
      const run = this.row(runId); if (!run) fail('run_not_found');
      const frozen = this.readRunResources(runId); if (!frozen) return { items: [], totalRows: 0 };
      const facts: ResourceEvidence[] = [];
      const originFile = (originRunId: number, ref: import('../../contracts/src/resources').ResourceRef, file: string | null) => {
        const origin = this.row(originRunId); if (!origin || origin.session_id !== run.session_id) fail('storage_read_failed');
        const saved = this.readRunResources(originRunId), snapshot = saved?.available.find(s => resourceRefKey(s.ref) === resourceRefKey(ref));
        if (!snapshot || file !== null && !snapshot.files.some(f => f.file === file)) fail('storage_read_failed');
        return snapshot;
      };
      for (const input of this.inputs.rowsForRun(runId)) {
        const content = this.inputs.content(input), plan = content.resourceInputPlan;
        if (input.status !== 'consumed' || !plan?.resourceRef || !content.nativeInput) continue;
        const snapshot = originFile(runId, plan.resourceRef, null), file = snapshot.entry.split('/').at(-1)!;
        const time = input.delivered_at ?? this.db.query<{ occurred_at: string }, [number, number]>("SELECT occurred_at FROM runtime_events WHERE run_id=? AND type='input_delivered' AND json_extract(payload_json,'$.phase')='native_consumed' AND json_extract(payload_json,'$.inputId')=? ORDER BY sequence LIMIT 1").get(runId, input.id)?.occurred_at;
        if (!time || !input.native_entry_id) fail('storage_read_failed');
        facts.push(checked(ResourceEvidenceSchema, { resourceRef: plan.resourceRef, originRunId: runId, file, kind: 'sdk_expansion', inputId: input.id,
          nativeEntryId: input.native_entry_id, toolCallId: null, modelCallId: null, observedAt: time, coverage: 'complete' }, 'storage_read_failed'));
      }
      const tools = new SqliteToolStore(this.db);
      const toolRows = this.db.query<{ id: number; native_tool_call_id: string; context_snapshot_id: number | null; call_id: string | null; input_id: number | null; snapshot_json: string | null }, [number, number]>(`SELECT t.id,t.native_tool_call_id,t.context_snapshot_id,c.call_id,s.input_id,s.snapshot_json
        FROM tool_calls t LEFT JOIN model_calls c ON c.id=t.model_call_id LEFT JOIN context_snapshots s ON s.id=t.context_snapshot_id WHERE t.run_id=? AND t.session_id=? ORDER BY t.id`).all(runId, run.session_id!);
      for (const row of toolRows) {
        const contextSnapshot = row.snapshot_json ? checked(ContextSnapshotBodySchema, legacyContextBody(decoded(row.snapshot_json)), 'storage_read_failed') : null;
        const workspace=contextSnapshot?.workspaceContext??null;
        const record = tools.readCall({ runId, sessionId: run.session_id!, nativeToolCallId: row.native_tool_call_id, scope: checked(RunScopeSchema, legacyRunScope(decoded(run.scope_json))),
          referenceDate: run.reference_date, timezone: run.timezone, signal: new AbortController().signal,
          ...(run.kind==='child'&&contextSnapshot?.delegationSource?{contextSnapshotId:row.context_snapshot_id!,modelCallId:row.call_id!,workspaceContext:null,workspaceInputId:null,basedOnQueryId:null,delegationSource:contextSnapshot.delegationSource}:
            row.context_snapshot_id !== null && workspace ? { contextSnapshotId: row.context_snapshot_id, modelCallId: row.call_id!, workspaceContext: workspace, workspaceInputId: row.input_id,
            basedOnQueryId: workspace.queryId, workspaceRevision: workspace.revision } : {}) });
        if (!record?.resourceRead) continue;
        const read = record.resourceRead, snapshot = originFile(runId, read.resourceRef, read.file);
        if (!record.nativeEntryId || !record.sdkDelivery || record.sdkDelivery.isError) fail('storage_read_failed');
        facts.push(checked(ResourceEvidenceSchema, { resourceRef: read.resourceRef, originRunId: runId, file: read.file, kind: 'native_read', inputId: null,
          nativeEntryId: record.nativeEntryId, toolCallId: record.id, modelCallId: null, observedAt: read.observedAt, coverage: read.coverage }, 'storage_read_failed'));
      }
      const calls = this.db.query<{ call_id: string; model_json: string; delivered_at: string }, [number, number]>(`SELECT c.call_id,c.model_json,d.delivered_at FROM model_calls c JOIN context_deliveries d ON d.model_call_id=c.id
        WHERE c.run_id=? AND c.session_id=? AND c.kind='main' ORDER BY c.id`).all(runId, run.session_id!);
      for (const call of includeDeliveries ? calls : []) {
        const context = checked(ModelCallContextSchema, legacyModelCallContext((decoded(call.model_json) as { context: unknown }).context), 'storage_read_failed');
        const observation = context.observation && 'resources' in context.observation ? context.observation.resources : undefined; if (!observation) continue;
        if (call.delivered_at !== context.observation!.observedAt) fail('storage_read_failed');
        for (const ref of observation.verified) {
          originFile(ref.originRunId, ref.resourceRef, ref.file);
          if (ref.kind === 'skill_index' && ref.originRunId !== runId) fail('storage_read_failed');
          if (ref.inputId !== null && !this.db.query('SELECT id FROM session_inputs WHERE id=? AND session_id=? AND run_id=? AND native_entry_id=?').get(ref.inputId, run.session_id, ref.originRunId, ref.nativeEntryId)) fail('storage_read_failed');
          if (ref.toolCallId !== null && !this.db.query("SELECT id FROM tool_calls WHERE id=? AND session_id=? AND run_id=? AND json_extract(delivery_json,'$.nativeEntryId')=?").get(ref.toolCallId, run.session_id, ref.originRunId, ref.nativeEntryId)) fail('storage_read_failed');
          facts.push(checked(ResourceEvidenceSchema, { ...ref, kind: 'provider_delivery', modelCallId: call.call_id, observedAt: call.delivered_at }, 'storage_read_failed'));
        }
      }
      // ponytail: scan one bounded Run's facts before paging; use SQL projection if measured Run histories outgrow memory.
      const distinct = [...new Map(facts.map(f => [canonicalRequest(f), f])).values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt) || canonicalRequest(a).localeCompare(canonicalRequest(b)));
      return { items: distinct.slice((page - 1) * pageSize, page * pageSize), totalRows: distinct.length };
    });
  }
  verifyIntentOrigin(raw:Extract<SubmitInput,{mode:'send'}>):void {
    this.inputRead(()=>this.db.transaction(()=>{
      const request=checked(SubmitInputSchema,raw);
      if(request.mode!=='send')fail('invalid_argument');
      if(!request.routing||!('originRunId' in request.routing)||request.routing.originRunId==null)return;
      const row=this.row(request.routing.originRunId),session=this.readSession(request.sessionId);
      if(!row||row.kind!=='agent'||row.parent_run_id!==null||row.session_id!==request.sessionId||row.input_id===null
        ||!session||session.kind!=='user'||session.status!=='active'||!['failed','cancelled','completed'].includes(row.status)||row.ended_at===null)fail('state_conflict');
      const cleanup=checked(RunCleanupRecordSchema,decoded(row.cleanup_json));
      if(cleanup.stopConfirmed!==true||cleanup.requiredPersistenceComplete!==true||cleanup.inputsSettled!==true||cleanup.resourcesReleased!==true||cleanup.unconfirmedItems.length)fail('state_conflict');
      const input=this.inputs.required(row.input_id),content=this.inputs.content(input),config=checked(agentConfigSchema,legacyRunConfig(decoded(row.config_json))),facts=this.intents?.readIntentFacts({runId:row.id});
      if(input.session_id!==request.sessionId||input.mode!=='send'||input.target_run_id!==row.id||content.text!==row.input_text
        ||content.text!==request.text||content.referenceDate!==request.referenceDate||content.timezone!==request.timezone
        ||row.reference_date!==request.referenceDate||row.timezone!==request.timezone||!isDeepStrictEqual(content.scope,checked(RunScopeSchema,legacyRunScope(decoded(row.scope_json))))
        ||!isDeepStrictEqual(content.workspaceContext,checked(WorkspaceContextSchema,legacyWorkspaceContext(decoded(row.workspace_json)))))fail('state_conflict');
      const originRouting=content.originalSubmitInput.mode==='send'?content.originalSubmitInput.routing:null;
      if(originRouting?.mode==='intent'){
        if(!content.intentAdmission||!isDeepStrictEqual(content.intentAdmission,config.intentAdmission))fail('state_conflict');
      }else if(originRouting?.mode!=='explicit_agent_fallback'||facts?.decision?.decisionSource!=='explicit_agent_fallback')fail('state_conflict');
      if(request.routing.mode==='explicit_agent_fallback'&&row.status==='completed'&&!['clarify','reject'].includes(facts?.decision?.route??''))fail('state_conflict');
      const workspace=this.readWorkspace(),{revision:_originalRevision,...originalWorkspace}=content.workspaceContext,{revision:_currentRevision,...currentWorkspace}=toWorkspaceContext(workspace);
      if(!isDeepStrictEqual(originalWorkspace,currentWorkspace))fail('state_conflict');
      const {allowedToolNames:_tools,allowedResourceRefs:_resources,...originalScope}=content.scope;
      const {allowedToolNames:_currentTools,allowedResourceRefs:_currentResources,...currentScope}=this.freezeAgentScope(workspace,content.scope.allowedToolNames);
      if(!isDeepStrictEqual(originalScope,currentScope))fail('state_conflict');
    }).deferred());
  }
  acceptInput(plan:PreparedInput):SubmitResult {
    const request=checked(SubmitInputSchema,plan.originalSubmitInput),operationRef=checked(OpaqueIdSchema,plan.operationRef);
    return this.inputWrite(()=>{
      const operation=this.findOperation(operationRef),sequence=this.findSubmission({sessionId:request.sessionId,clientSequence:request.clientSequence});
      if(operation||sequence){if(!operation||operation.method!=='session.submit'||!sequence||operation.result.inputId!==sequence.inputId||operation.result.runId!==sequence.runId||operation.result.sessionId!==sequence.sessionId||operation.result.clientSequence!==sequence.clientSequence||canonicalRequest(operation.originalRequest)!==canonicalRequest(request))fail('state_conflict');return sequence;}
      const content=checked(InputContentSchema,plan.content);timestamp(plan.createdAt);
      if(canonicalRequest(content.originalSubmitInput)!==canonicalRequest(request)||content.nativeInput!==undefined||content.deliveryAttempt!==null||content.text!==request.text||content.referenceDate!==request.referenceDate||content.timezone!==request.timezone||content.model.provider!==request.model.provider||content.model.modelId!==request.model.modelId||content.model.configVersion!==request.model.expectedConfigVersion||plan.execution.mode!==request.mode)fail('invalid_argument');
      const session=this.readSession(request.sessionId);if(!session)fail('session_not_found');this.assertSessionActive(session);
      if(request.clientSequence<session.nextSubmissionSequence||request.clientSequence===Number.MAX_SAFE_INTEGER)fail('state_conflict');
      const workspace=this.readWorkspace();if(workspace.sessionId!==session.id||workspace.revision!==request.expectedRevision||!isDeepStrictEqual(toWorkspaceContext(workspace),content.workspaceContext)||!isDeepStrictEqual(workspace.batchRefs.map(b=>b.id),request.expectedBatchIds)||workspace.queryId!==request.expectedQueryId)fail('workspace_revision_mismatch');
      const frozenWorkspace=toWorkspaceContext(workspace);
      if(request.mode==='send')this.verifyIntentOrigin(request);
      if(this.p3)for(const batch of workspace.batchRefs){
        const row=this.db.query<{metadata_json:string},[number]>('SELECT metadata_json FROM batches WHERE id=?').get(batch.id);
        const metadata=checked(z.object({referenceDate:ReferenceDateSchema,timezone:TimezoneSchema}),decoded(row?.metadata_json??null),'storage_read_failed');
        if(request.timezone!==metadata.timezone)fail('invalid_argument');
      }
      let target:number|null=null;
      if(plan.execution.mode==='send'){
        if(this.active())fail('runtime_busy');const run=plan.execution.run;
        if(!isDeepStrictEqual(run.intentAdmission,content.intentAdmission))fail('invalid_argument');
        if(run.intentAdmission&&(run.intentAdmission.baseLeafId!==session.leafId||run.intentAdmission.baseStorageVersion!==session.storageVersion))fail('state_conflict');
        const resources = run.resources ? this.checkedResources(run.resources, session.id, run.model.configVersion) : null;
        if (run.extensions) this.checkedExtensions(run.extensions, session.id, run.model.configVersion);
        if(!!resources!==!!content.resourceInputPlan || content.resourceInputPlan?.resourceRef && !resources!.available.some(s=>resourceRefKey(s.ref)===resourceRefKey(content.resourceInputPlan!.resourceRef!)))fail('invalid_argument');
        const expectedScope = { ...this.freezeAgentScope(workspace,run.scope.allowedToolNames), allowedResourceRefs: resources?.available.map(s=>resourceRefKey(s.ref)) ?? [] };
        if(run.sessionId!==session.id||run.goal!=='answer'||run.text!==content.text||run.referenceDate!==content.referenceDate||run.timezone!==content.timezone||run.timeoutMs!==run.policy.timeoutMs||!isDeepStrictEqual(toWorkspaceContext(run.workspace),frozenWorkspace)||!isDeepStrictEqual(run.scope,content.scope)||!isDeepStrictEqual(run.model,content.model)||!isDeepStrictEqual(expectedScope,run.scope))fail('invalid_argument');
      }else{
        if(request.mode==='send'||request.targetRunId!==plan.execution.targetRunId)fail('invalid_argument');target=plan.execution.targetRunId;const run=this.row(target),active=this.active();
        if(!run||run.kind!=='agent'||run.session_id!==session.id||!active||active.runId!==target)fail('state_conflict');
        const root=checked(agentConfigSchema,legacyRunConfig(decoded(run.config_json)),'storage_read_failed'),scope=checked(RunScopeSchema,legacyRunScope(decoded(run.scope_json)),'storage_read_failed');
        if(!isDeepStrictEqual({...this.freezeAgentScope(workspace,scope.allowedToolNames),allowedResourceRefs:scope.allowedResourceRefs},content.scope))fail('access_denied');
        if(!!root.agent.resources!==!!content.resourceInputPlan || content.resourceInputPlan?.resourceRef && !root.agent.resources!.available.some(s=>resourceRefKey(s.ref)===resourceRefKey(content.resourceInputPlan!.resourceRef!)))fail('access_denied');
        if(!isDeepStrictEqual(root.selection,content.model)||run.reference_date!==content.referenceDate||run.timezone!==content.timezone||content.scope.batchIds.some(b=>!scope.batchIds.includes(b))||scope.deviceIds!==null&&(content.scope.deviceIds===null||content.scope.deviceIds.some(d=>!scope.deviceIds!.includes(d)))||content.scope.allowedToolNames.some(t=>!scope.allowedToolNames.includes(t))||content.scope.allowedResourceRefs.some(r=>!scope.allowedResourceRefs.includes(r))||content.scope.artifactIds.some(a=>!scope.artifactIds.includes(a))||scope.readOnly&&!content.scope.readOnly)fail('access_denied');
      }
      const saved=this.db.query("INSERT INTO session_inputs(session_id,client_sequence,operation_ref,mode,status,content_json,target_run_id,run_id,error_json,created_at,delivered_at,processed_at,updated_at,processing_status,native_entry_id) VALUES(?,?,?,?,'queued',?,?,NULL,NULL,?,NULL,NULL,?,'pending',NULL)").run(session.id,request.clientSequence,operationRef,request.mode,canonicalRequest(content),target,plan.createdAt,plan.createdAt);
      const inputId=Number(saved.lastInsertRowid);
      if(plan.execution.mode==='send'){
        const run=plan.execution.run;checked(OpaqueIdSchema,run.instanceId);timestamp(run.createdAt);
        const config=checked(agentConfigSchema,{selection:run.model,policy:run.policy,referenceDate:run.referenceDate,timezone:run.timezone,...(run.intentAdmission?{intentAdmission:run.intentAdmission}:{}),...(run.agentPolicy?{agentPolicy:run.agentPolicy}:{}),...(run.runtimeConfiguration?{runtimeConfiguration:run.runtimeConfiguration}:{}),...(run.toolConfiguration?{toolConfiguration:run.toolConfiguration}:{}),...(run.measurementContext?{measurementContext:run.measurementContext}:{}),...(run.toolProfileSnapshot?{toolProfileSnapshot:run.toolProfileSnapshot}:{}),agent:{...run.agentOptions,stage:run.scope.allowedToolNames.length?'P3':'P2',nativeSessionId:session.nativeSessionId,tools:run.scope.allowedToolNames,autoCompaction:run.agentOptions.compaction?.enabled??false,autoRetry:false,cacheWarming:'off',...(run.resources?{resources:run.resources}:{}),...(run.extensions?{extensions:run.extensions}:{}),...(run.contextContract?{contextContract:run.contextContract}:{}),...(run.historyContract?{historyContract:run.historyContract}:{})}});
        const r=this.db.query("INSERT INTO runs(session_id,input_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at) VALUES(?,?,'agent',?,NULL,NULL,NULL,'created','answer',?,?,?,?,?,?,?)").run(session.id,inputId,run.instanceId,content.text,JSON.stringify(config),JSON.stringify(run.scope),JSON.stringify(frozenWorkspace),run.referenceDate,run.timezone,run.createdAt);target=Number(r.lastInsertRowid);
        this.db.query('UPDATE session_inputs SET target_run_id=? WHERE id=? AND target_run_id IS NULL').run(target,inputId);
        this.runLifecycle(this.row(target)!, 'run_created', run.createdAt);
      }
      this.inputs.accepted(inputId, plan.createdAt);
      if(request.mode==='send'&&request.routing?.mode==='explicit_agent_fallback'){
        const decision=IntentDecisionSchema.parse({intentCallId:null,matchedBy:null,route:'agent',status:null,adoptedIntents:[],contextIntentId:null,adoptedSlots:null,
          queryParams:null,missingSlots:[],issues:[],ruleEvaluation:null,decisionSource:'explicit_agent_fallback',schemaVersion:INTENT_VERSIONS.schemaVersion,policyVersion:INTENT_VERSIONS.policyVersion});
        (this.intents??fail('state_conflict')).commitRoute({runId:target!,sessionId:session.id,inputId,decision,expectedCancelEpoch:0,createdAt:plan.createdAt});
      }
      if(request.mode==='send'&&request.routing?.mode==='user_form'){
        const run=plan.execution.mode==='send'?plan.execution.run:fail('invalid_argument'),params=request.routing.params;
        if(content.text!=='Query form: '+canonicalRequest(params)||!isDeepStrictEqual(params.batchIds,content.scope.batchIds)
          ||content.intentAdmission||content.resourceInputPlan||run.extensions||run.resources||run.scope.allowedToolNames.length)fail('invalid_argument');
        const decision=IntentDecisionSchema.parse({intentCallId:null,matchedBy:null,route:'simple',status:'RESOLVED',adoptedIntents:[],contextIntentId:null,
          adoptedSlots:null,queryParams:params,missingSlots:[],issues:[],ruleEvaluation:null,decisionSource:'user_form',schemaVersion:INTENT_VERSIONS.schemaVersion,policyVersion:INTENT_VERSIONS.policyVersion});
        (this.intents??fail('state_conflict')).commitRoute({runId:target!,sessionId:session.id,inputId,decision,expectedCancelEpoch:0,createdAt:plan.createdAt});
      }
      return this.inputs.result(this.inputs.required(inputId));
    });
  }

  private row(runId: number): RunRow | null {
    return this.db.query<RunRow, [number]>("SELECT * FROM runs WHERE id=?").get(runId);
  }
  private config(row: RunRow) { return checked(commonConfigSchema, legacyRunConfig(decoded(row.config_json)), "storage_read_failed"); }
  private providerConfig(row: RunRow) { return checked(providerConfigSchema, legacyRunConfig(decoded(row.config_json)), "storage_read_failed"); }
  private calls(runId: number): ModelCallView[] {
    return this.db.query<CallRow, [number]>("SELECT * FROM model_calls WHERE run_id=? ORDER BY id").all(runId).map(row => this.call(row));
  }
  private call(row: CallRow): ModelCallView {
      if (row.kind === 'intent') return (this.intents ?? fail('storage_read_failed')).readModelCall(row.id);
      const model = checked(z.object({
        selection: ModelSelectionSchema, responseModel: z.string().nullable(),
        sdkStopReason: z.enum(["stop", "length", "toolUse", "error", "aborted", "deferred"]).nullable(),
        context: ModelCallContextSchema.optional(),
        compaction: CompactionCallMetadataSchema.optional(),
        requestOriginals:z.array(ProviderRequestOriginalSchema).optional(),
      }).strict(), legacyCallMetadata(decoded(row.model_json)), "storage_write_failed");
      return checked(ModelCallViewSchema, {
        ...(model.compaction?{compaction:{operationRef:model.compaction.operationRef,reason:model.compaction.reason,nativeEntryId:model.compaction.nativeEntryId,savedStorageVersion:model.compaction.savedStorageVersion}}:{}),
        id: row.id, inputId: row.input_id, callId: row.call_id, kind: row.kind, state: row.state, contextSnapshotId: model.context?.snapshotId ?? null,
        granularity: row.granularity, attempt: row.attempt, attemptCountUnknown: row.attempt_count_unknown === 1,
        model: model.selection, responseModel: model.responseModel, sdkStopReason: model.sdkStopReason,
        startedAt: row.started_at, endedAt: row.ended_at, durationMs: row.duration_ms,
        inputTokens: row.input_tokens, outputTokens: row.output_tokens, cost: row.cost, costCurrency: row.cost_currency,
        usageSource: row.usage_source, unavailableReason: row.unavailable_reason, error: decoded(row.error_json),
      }, "storage_write_failed");
  }
  private view(row: RunRow, offset = 0, limit = 16_384, inputOffset = 0, inputLimit = 65536, callOffset = 0, callLimit = 20): RunView {
    const rootInput = this.p5 && row.input_id !== null ? this.inputs.required(row.input_id) : null;
    const config = this.config(row);
    const text = row.output_text ?? "";
    let output: RunView["output"];
    try { output = sliceOutput(text, offset, limit); } catch { return fail("invalid_argument"); }
    let inputPage: RunView["inputPage"];
    try { inputPage = sliceText(row.input_text, inputOffset, inputLimit, 65536); } catch { return fail("invalid_argument"); }
    const cleanup = RunCleanupRecordSchema.safeParse(decoded(row.cleanup_json));
    const calls = this.calls(row.id);
    if (callOffset > calls.length) fail("invalid_argument");
    const agent = row.kind === "agent" ? checked(agentConfigSchema, legacyRunConfig(decoded(row.config_json)), "storage_read_failed") : null;
    const child = row.kind === 'child' ? checked(FrozenChildConfigSchema, legacyChildConfig((decoded(row.config_json) as { subagent: unknown }).subagent), 'storage_read_failed') : null;
    const childResult = child && row.child_result_json ? checked(ChildResultSchema, legacyChildResult(decoded(row.child_result_json)), 'storage_read_failed') : null;
    const childDelivery = child ? this.db.query<{ delivery_json: string | null }, [number]>('SELECT delivery_json FROM tool_calls WHERE id=?').get(child.originToolCallId) : null;
    const delivery = childDelivery?.delivery_json ? checked(savedDeliverySchema, legacyToolDelivery(decoded(childDelivery.delivery_json)), 'storage_read_failed') : null;
    return checked(RunViewSchema, {
      id: row.id, kind: row.kind, status: row.status, operationRef: child ? `internal-child:${child.originToolCallId}` : row.kind === "provider" ? this.providerConfig(row).providerRequest.operationRef : rootInput?.operation_ref ?? row.submission_operation_ref,
      instanceId: row.instance_id, sessionId: row.session_id, inputId: row.input_id, goal: row.goal, inputText: inputPage.text, inputPage,
      model: config.selection, policy: config.policy, priorRunId: row.prior_run_id,
      ...(row.kind === 'provider' ? { runtimeConfiguration: this.providerConfig(row).runtimeConfiguration ?? null } : {}),
      referenceDate: row.reference_date, timezone: row.timezone, createdAt: row.created_at,
      startedAt: row.started_at, cancelRequestedAt: row.cancel_requested_at, stoppedAt: row.stopped_at,
      endedAt: row.ended_at, error: decoded(row.error_json), cleanup: cleanup.success ? cleanup.data : null,
      answerRef: this.p3 ? this.db.query<{ id: number }, [number]>("SELECT id FROM answers WHERE run_id=?").get(row.id)?.id ?? null : null,
      output,
      calls: row.kind === "provider" ? calls : calls.slice(callOffset, callOffset + callLimit), persistence: "committed",
      ...(child ? { parentRunId: child.parentRunId, originToolCallId: child.originToolCallId, pluginAgentId: child.pluginAgentId, nativeSessionId: child.nativeSessionId,originSnapshotId:child.originSnapshotId,parentInputId:child.parentInputId,
        nextCallOffset: callOffset + callLimit < calls.length ? callOffset + callLimit : null,
        childResult: childResult ? (() => { const { originalReply, ...view } = childResult,preview=safePreview(view.text,32768);return { ...view,truncated:view.truncated||preview.truncated,text:childResult.outcome === 'completed' ? preview.text : AppErrorSchema.safeParse(decoded(row.error_json)).data?.message ?? 'Child execution did not complete.' }; })() : null,
        delivery: delivery ? { resultRecorded: delivery.resultRecorded, sdkReturned: delivery.sdkReturned,sdkResultIsError:delivery.message?.isError??null,nativeEntryId: delivery.nativeEntryId, nextModelCallId: delivery.nextModelCallId, consumedAt: delivery.consumedAt,consumptionEvidence:delivery.consumptionEvidence??null,error: delivery.error } : null } : {}),
      ...(agent ? { clientSequence: rootInput?.client_sequence ?? row.submission_client_sequence, nativeSessionId: agent.agent.nativeSessionId,
        ...(this.childRuns?{groupUsage:(()=>{const part=(children:boolean)=>{
          const where=children?"r.kind='child' AND r.parent_run_id=?":"r.kind='agent' AND r.id=?";
          const usage=this.db.query<{modelCalls:number;inputTokens:number|null;outputTokens:number|null;cost:number|null},[number]>(`SELECT count(*) modelCalls,
            CASE WHEN count(*)=0 THEN 0 WHEN count(c.input_tokens)=count(*) THEN sum(c.input_tokens) END inputTokens,
            CASE WHEN count(*)=0 THEN 0 WHEN count(c.output_tokens)=count(*) THEN sum(c.output_tokens) END outputTokens,
            CASE WHEN count(*)=0 THEN 0 WHEN count(c.cost)=count(*) THEN sum(c.cost) END cost
            FROM model_calls c JOIN runs r ON r.id=c.run_id AND r.session_id=c.session_id WHERE ${where}`).get(row.id)!;
          const tools=this.db.query<{n:number},[number]>(`SELECT count(*) n FROM tool_calls t JOIN runs r ON r.id=t.run_id AND r.session_id=t.session_id WHERE ${where}`).get(row.id)!;
          return {...usage,toolCalls:tools.n,costCurrency:usage.cost===null?null:'USD'};
        };return {parent:part(false),children:part(true)};})()}:{}),
        answerNativeLeafId:this.p3 ? this.db.query<{native_leaf_id:string|null},[number]>('SELECT native_leaf_id FROM answers WHERE run_id=?').get(row.id)?.native_leaf_id??null : null,
        nextCallOffset: callOffset + callLimit < calls.length ? callOffset + callLimit : null,
        control: agent.runtimeConfiguration || agent.toolConfiguration || agent.agentPolicy || agent.measurementContext || agent.toolProfileSnapshot ? {
          runtimeConfiguration: agent.runtimeConfiguration ?? null,
          toolConfiguration: agent.toolConfiguration ?? null,
          agentPolicy: agent.agentPolicy ?? null,
          measurementContext: agent.measurementContext ?? null,
          toolProfileSnapshot: agent.toolProfileSnapshot ?? null,
        } : null } : {}),
    }, "storage_read_failed");
  }

  findProviderOperation(operationRef: string): ProviderOperation | null {
    const row = this.db.query<RunRow, [string]>(
      "SELECT * FROM runs WHERE kind='provider' AND json_extract(config_json,'$.providerRequest.operationRef')=?",
    ).get(operationRef);
    if (!row) return null;
    const request = this.providerConfig(row).providerRequest;
    return { runId: row.id, operationRef: request.operationRef, method: request.method, originalRequest: request.originalRequest, run: this.view(row) };
  }

  private compactionOperation(operationRef: string): StoredCompactionOperation | null {
    const rows = this.db.query<{type:string;actor:string;session_id:number;run_id:number|null;details_json:string;occurred_at:string},[string]>(
      "SELECT * FROM business_events WHERE operation_ref=? AND type IN ('session_compaction_started','session_compaction_cancel_requested','session_compaction_finished') ORDER BY id").all(operationRef);
    const started = rows.find(row => row.type === 'session_compaction_started');
    if (!started) { if (rows.length) fail('storage_read_failed'); return null; }
    const details = checked(z.strictObject({contract:z.literal('medclaw.compaction/v1'),originalRequest:CompactSessionInputSchema,...FrozenCompactionSchema.shape}),decoded(started.details_json),'storage_read_failed');
    const {contract,originalRequest,...frozen} = details;
    let cancelRequestedAt: string | null = null, receipt: CompactionReceipt | null = null;
    for (const row of rows) {
      if (row.session_id !== originalRequest.sessionId || row.run_id !== null || row.actor !== 'user') fail('storage_read_failed');
      if (row.type === 'session_compaction_cancel_requested') {
        const cancel = checked(z.strictObject({contract:z.literal('medclaw.compaction/v1'),operationRef:OpaqueIdSchema,sessionId:PositiveIdSchema,requestedAt:TimestampSchema}),decoded(row.details_json),'storage_read_failed');
        if (cancel.operationRef !== operationRef || cancel.sessionId !== originalRequest.sessionId || cancel.requestedAt !== row.occurred_at) fail('storage_read_failed');
        cancelRequestedAt = cancel.requestedAt;
      }
      if (row.type === 'session_compaction_finished') {
        receipt = checked(z.strictObject({contract:z.literal('medclaw.compaction/v1'),receipt:CompactionReceiptSchema}),decoded(row.details_json),'storage_read_failed').receipt;
        if (receipt.finishedAt !== row.occurred_at || receipt.baseStorageVersion !== frozen.baseStorageVersion) fail('storage_read_failed');
      }
    }
    if (started.occurred_at !== frozen.startedAt || receipt && receipt.cancelRequestedAt !== cancelRequestedAt) fail('storage_read_failed');
    return checked(StoredCompactionOperationSchema,{operationRef,request:originalRequest,frozen,cancelRequestedAt,receipt},'storage_read_failed');
  }
  readCompactionOperation(input: ReadCompactionInput): StoredCompactionOperation | null {
    const request = checked(ReadCompactionInputSchema,input), operation = this.compactionOperation(request.operationRef);
    if (operation && operation.request.sessionId !== request.sessionId) fail('access_denied');
    return operation;
  }
  latestCompactionOperation(sessionId:number):StoredCompactionOperation|null {
    id(sessionId);const row=this.db.query<{operation_ref:string},[number]>("SELECT operation_ref FROM business_events WHERE session_id=? AND type='session_compaction_started' ORDER BY id DESC LIMIT 1").get(sessionId);
    return row?this.readCompactionOperation({sessionId,operationRef:row.operation_ref}):null;
  }
  readCompactionCalls(operationRef:string):ModelCallView[] {return this.compactionCalls(operationRef).map(call=>this.call(call));}
  acceptCompaction(input: CompactSessionInput, operationRef: string, inputFrozen: FrozenCompaction): StoredCompactionOperation {
    const request = checked(CompactSessionInputSchema,input); checked(OpaqueIdSchema,operationRef);
    return this.inputWrite(() => {
      const prior = this.findOperation(operationRef);
      if (prior) { if (prior.method !== 'session.compact' || canonicalRequest(prior.originalRequest) !== canonicalRequest(request)) fail('state_conflict'); return prior.result; }
      const frozen = checked(FrozenCompactionSchema,inputFrozen), session = this.readSession(request.sessionId);
      if (!session) fail('session_not_found'); this.assertHistoryMutationAllowed(session.id);
      if (session.storageVersion !== request.expectedStorageVersion || frozen.baseStorageVersion !== session.storageVersion || frozen.baseLeafId !== session.leafId) throw safeError('state_conflict',undefined,{reason:'history_version_mismatch'});
      if (request.model.provider !== frozen.model.provider || request.model.modelId !== frozen.model.modelId || request.model.expectedConfigVersion !== frozen.model.configVersion) fail('state_conflict');
      this.db.query("INSERT INTO business_events(operation_ref,type,actor,session_id,details_json,occurred_at) VALUES(?,'session_compaction_started','user',?,?,?)")
        .run(operationRef,session.id,canonicalRequest({contract:'medclaw.compaction/v1',originalRequest:request,...frozen}),frozen.startedAt);
      return this.readCompactionOperation({sessionId:session.id,operationRef})!;
    });
  }
  requestCompactionCancel(input: ReadCompactionInput, requestedAt: string): boolean {
    const request = checked(ReadCompactionInputSchema,input); checked(TimestampSchema,requestedAt);
    return this.inputWrite(() => {
      const operation = this.readCompactionOperation(request); if (!operation) fail('operation_not_found');
      if (operation.receipt || operation.cancelRequestedAt) return false;
      this.db.query("INSERT INTO business_events(operation_ref,type,actor,session_id,details_json,occurred_at) VALUES(?,'session_compaction_cancel_requested','user',?,?,?)")
        .run(request.operationRef,request.sessionId,canonicalRequest({contract:'medclaw.compaction/v1',...request,requestedAt}),requestedAt);
      return true;
    });
  }
  startCompactionCall(input: {callId: string; owner: CompactionCallOwner; startedAt: string}): void {
    const callId = checked(OpaqueIdSchema,input.callId), owner = checked(CompactionCallOwnerSchema,input.owner), time = checked(TimestampSchema,input.startedAt);
    this.inputWrite(() => {
      const existing = this.db.query<{model_json:string;run_id:number|null;session_id:number},[string]>("SELECT * FROM model_calls WHERE kind='compaction' AND json_extract(model_json,'$.compaction.operationRef')=? ORDER BY id").all(owner.operationRef);
      if (owner.ordinal !== existing.length + 1 || existing.some(row => row.run_id !== owner.runId || row.session_id !== owner.sessionId)) fail('state_conflict');
      for (const row of existing) {
        const model = decoded(row.model_json) as {selection:unknown;compaction:unknown}, metadata = checked(CompactionCallMetadataSchema,model.compaction,'storage_read_failed');
        if (metadata.source !== owner.source || metadata.reason !== owner.reason || metadata.baseStorageVersion !== owner.baseStorageVersion || metadata.baseLeafId !== owner.baseLeafId || !isDeepStrictEqual(model.selection,owner.model) || metadata.operationEndedAt) fail('state_conflict');
      }
      const child=owner.source==='auto'&&this.row(owner.runId!)?.kind==='child';
      if(child) {
        if(readFrozenChild(this.db,owner.runId!).childSessionId!==owner.sessionId||!this.memory)fail('access_denied');
        this.memory!.loadInTransaction(owner.sessionId);
      } else { const session = this.readSession(owner.sessionId); if (!session) fail('session_not_found'); this.assertSessionActive(session); }
      if (owner.source === 'manual') {
        const operation = this.readCompactionOperation({sessionId:owner.sessionId,operationRef:owner.operationRef});
        if (!operation || operation.receipt || operation.cancelRequestedAt || owner.ordinal > operation.frozen.budget.maxModelCalls
          || !isDeepStrictEqual(operation.frozen.model,owner.model) || owner.baseStorageVersion !== operation.frozen.baseStorageVersion || owner.baseLeafId !== operation.frozen.baseLeafId) fail('state_conflict');
      } else {
        if (!existing.length && this.findOperation(owner.operationRef)) fail('state_conflict');
        const run = this.row(owner.runId!);
        if (!run || !['agent','child'].includes(run.kind) || run.session_id !== owner.sessionId || !['created','running'].includes(run.status) || run.cancel_requested_at || !isDeepStrictEqual(this.config(run).selection,owner.model)) fail('state_conflict');
      }
      const metadata = checked(CompactionCallMetadataSchema,{contract:'medclaw.compaction/v1',operationRef:owner.operationRef,source:owner.source,reason:owner.reason,ordinal:owner.ordinal,baseStorageVersion:owner.baseStorageVersion,baseLeafId:owner.baseLeafId,
        nativeEntryId:null,savedStorageVersion:null,operationEndedAt:null,operationError:null});
      this.db.query(`INSERT INTO model_calls(call_id,run_id,session_id,input_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,started_at)
        VALUES(?,?,?,NULL,'compaction',1,'logical_request',1,?,'started',?)`).run(callId,owner.runId,owner.sessionId,JSON.stringify({selection:owner.model,responseModel:null,sdkStopReason:null,compaction:metadata}),time);
    });
  }
  finishCompactionCall(inputOwner: CompactionCallOwner, fact: import('../../contracts/src/run').FinalCallFact): void {
    const owner = checked(CompactionCallOwnerSchema,inputOwner);
    this.inputWrite(() => {
      const row = this.db.query<CallRow & {run_id:number|null;session_id:number|null},[string]>('SELECT * FROM model_calls WHERE call_id=?').get(fact.callId);
      if (!row || row.kind !== 'compaction' || row.run_id !== owner.runId || row.session_id !== owner.sessionId || fact.context) fail('state_conflict');
      const model = decoded(row.model_json) as {selection:unknown;compaction:unknown}, metadata = checked(CompactionCallMetadataSchema,model.compaction,'storage_read_failed');
      if (metadata.operationRef !== owner.operationRef || metadata.source !== owner.source || metadata.reason !== owner.reason || metadata.ordinal !== owner.ordinal || metadata.baseStorageVersion !== owner.baseStorageVersion || metadata.baseLeafId !== owner.baseLeafId || !isDeepStrictEqual(model.selection,owner.model)) fail('state_conflict');
      const original = this.call(row), final = checked(ModelCallViewSchema,{...original,...fact});
      if (final.state === 'started' || !final.endedAt) fail('invalid_argument');
      if (original.state !== 'started') { if (!isDeepStrictEqual(original,final)) fail('state_conflict'); return; }
      if (this.db.query(`UPDATE model_calls SET state=?,model_json=?,ended_at=?,duration_ms=?,input_tokens=?,output_tokens=?,cost=?,cost_currency=?,usage_source=?,unavailable_reason=?,error_json=? WHERE call_id=? AND state='started'`)
        .run(final.state,JSON.stringify({...model,responseModel:final.responseModel,sdkStopReason:final.sdkStopReason}),final.endedAt,final.durationMs,final.inputTokens,final.outputTokens,final.cost,final.costCurrency,final.usageSource,final.unavailableReason,json(final.error),final.callId).changes !== 1) fail('state_conflict');
    });
  }
  commitCompactionInTransaction(change: NativeHistoryCommit | null, inputFact: CompactionReceipt | CompactionSaveFact): number {
    this.transactions.assertActive();
    const fact='contract' in inputFact?checked(CompactionReceiptSchema,inputFact):checked(CompactionSaveFactSchema,inputFact);
    const manual='contract' in fact?fact:null, saved=manual?manual.nativeSaved:true;
    if(manual&&manual.reason!=='manual'||saved&&!change||!saved&&change)fail('invalid_argument');
    const operation=manual?this.readCompactionOperation({sessionId:fact.sessionId,operationRef:fact.operationRef}):null;
    if(manual&&(!operation||operation.frozen.baseStorageVersion!==fact.baseStorageVersion||operation.cancelRequestedAt!==manual.cancelRequestedAt))fail('state_conflict');
    const confirmed=this.confirmCompactionSaved(change,fact);
    if(confirmed!==null)return confirmed;
    if(operation?.receipt)fail('state_conflict');
    const calls=this.compactionCalls(fact.operationRef);
    this.validateCompactionCalls(calls,fact);
    if(calls.some(call=>checked(CompactionCallMetadataSchema,(decoded(call.model_json) as {compaction:unknown}).compaction,'storage_read_failed').operationEndedAt!==null))fail('state_conflict');
    let version=fact.baseStorageVersion;
    if(saved) {
      if(!this.memory||change!.sessionId!==fact.sessionId||change!.runId!==fact.runId||change!.expectedStorageVersion!==fact.baseStorageVersion)fail('state_conflict');
      const entry=change!.newEntries.find(value=>(value as {id:string}).id===fact.nativeEntryId) as {type:string;firstKeptEntryId:string;tokensBefore:number}|undefined;
      if(!entry||entry.type!=='compaction'||entry.firstKeptEntryId!==fact.firstKeptEntryId||entry.tokensBefore!==fact.tokensBefore)fail('session_history_invalid');
      if(!manual) {
        const run=this.row(fact.runId!);
        if(!run||!['agent','child'].includes(run.kind)||run.session_id!==fact.sessionId||!['created','running'].includes(run.status))fail('state_conflict');
        if(run.kind==='child')readFrozenChild(this.db,run.id);
      }
      version=this.memory.commitInTransaction(change!).storageVersion;
      if(manual&&(manual.storageVersion!==version||manual.activeLeafId!==change!.activeLeafId))fail('state_conflict');
    } else if(this.readSession(fact.sessionId)!.storageVersion!==fact.baseStorageVersion)fail('state_conflict');
    const endedAt=manual?.finishedAt??new Date().toISOString();
    for (const call of calls) {
      const model = decoded(call.model_json) as {compaction:unknown}, metadata = checked(CompactionCallMetadataSchema,model.compaction,'storage_read_failed');
      if (metadata.nativeEntryId || metadata.savedStorageVersion) fail('state_conflict');
      this.db.query('UPDATE model_calls SET model_json=? WHERE call_id=?').run(JSON.stringify({...model,compaction:{...metadata,nativeEntryId:saved?fact.nativeEntryId:null,savedStorageVersion:saved?version:null,operationEndedAt:endedAt,operationError:manual?.error??null}}),call.call_id);
    }
    if(manual)this.db.query("INSERT INTO business_events(operation_ref,type,actor,session_id,details_json,occurred_at) VALUES(?,'session_compaction_finished','user',?,?,?)")
      .run(fact.operationRef,fact.sessionId,canonicalRequest({contract:'medclaw.compaction/v1',receipt:manual}),endedAt);
    else this.event(this.row(fact.runId!)!,{type:'compaction_completed',payload:{contract:'medclaw.event/v1',operationRef:fact.operationRef,reason:fact.reason as 'threshold'|'overflow',nativeEntryId:fact.nativeEntryId!,firstKeptEntryId:fact.firstKeptEntryId!,storageVersion:version,tokensBefore:fact.tokensBefore!,estimatedTokensAfter:fact.estimatedTokensAfter}},endedAt,'pi');
    this.beforeCommit?.();
    return version;
  }
  private compactionCalls(operationRef:string) {
    return this.db.query<CallRow&{run_id:number|null;session_id:number},[string]>("SELECT * FROM model_calls WHERE kind='compaction' AND json_extract(model_json,'$.compaction.operationRef')=? ORDER BY id").all(operationRef);
  }
  private validateCompactionCalls(calls:ReturnType<Repositories['compactionCalls']>,fact:CompactionReceipt|CompactionSaveFact):void {
    if(!isDeepStrictEqual(calls.map(call=>call.call_id),fact.callIds)||calls.some(call=>call.state==='started'||call.run_id!==fact.runId||call.session_id!==fact.sessionId))fail('storage_write_failed');
    calls.forEach((call,index)=>{
      this.call(call);
      const marker=checked(CompactionCallMetadataSchema,(decoded(call.model_json) as {compaction:unknown}).compaction,'storage_read_failed');
      if(marker.ordinal!==index+1||marker.reason!==fact.reason||marker.baseStorageVersion!==fact.baseStorageVersion||(marker.source==='manual')!==(fact.reason==='manual'))fail('state_conflict');
    });
  }
  /** Full original proof; a later active leaf does not erase a committed compaction. */
  confirmCompactionSaved(change:NativeHistoryCommit|null,fact:CompactionReceipt|CompactionSaveFact):number|null {
    return this.db.transaction(()=>this.compactionProof(change,fact)).deferred();
  }
  private compactionProof(change:NativeHistoryCommit|null,fact:CompactionReceipt|CompactionSaveFact):number|null {
    const manual='contract' in fact?fact:null,calls=this.compactionCalls(fact.operationRef);
    if(manual) {
      const operation=this.readCompactionOperation({sessionId:fact.sessionId,operationRef:fact.operationRef});
      if(!operation?.receipt)return null;
      if(!isDeepStrictEqual(operation.receipt,manual))fail('state_conflict');
      this.validateCompactionCalls(calls,fact);
      if(!manual.nativeSaved) {
        if(calls.some(call=>{const marker=checked(CompactionCallMetadataSchema,(decoded(call.model_json) as {compaction:unknown}).compaction,'storage_read_failed');return marker.operationEndedAt!==manual.finishedAt||!isDeepStrictEqual(marker.operationError,manual.error)||marker.nativeEntryId!==null;}))return null;
        return manual.baseStorageVersion;
      }
    } else if(!calls.length)return null;
    const markers=calls.map(call=>checked(CompactionCallMetadataSchema,(decoded(call.model_json) as {compaction:unknown}).compaction,'storage_read_failed'));
    const version=markers[0]?.savedStorageVersion;
    if(version==null||markers.some(marker=>marker.nativeEntryId!==fact.nativeEntryId||marker.savedStorageVersion!==version||marker.operationEndedAt===null))return null;
    this.validateCompactionCalls(calls,fact);
    if(manual&&manual.storageVersion!==version)return null;
    const row=this.db.query<{entry_json:string;run_id:number|null},[number,string]>("SELECT entry_json,run_id FROM memories WHERE session_id=? AND native_entry_id=? AND entry_type='compaction'").get(fact.sessionId,fact.nativeEntryId!);
    if(!row||row.run_id!==fact.runId)return null;
    const entry=decoded(row.entry_json) as {firstKeptEntryId:string;tokensBefore:number};
    if(entry.firstKeptEntryId!==fact.firstKeptEntryId||entry.tokensBefore!==fact.tokensBefore)return null;
    const original=change?.newEntries.find(value=>(value as {id:string}).id===fact.nativeEntryId);
    if(original&&canonicalRequest(original)!==canonicalRequest(entry))return null;
    if(!this.memory)return null;
    const snapshot=this.memory.loadInTransaction(fact.sessionId);
    if(snapshot.storageVersion<version)return null;
    if(original&&manual) {
      if(change!.sessionId!==fact.sessionId||change!.runId!==null||change!.expectedStorageVersion+1!==version||change!.activeLeafId!==manual.activeLeafId||canonicalRequest(change!.header)!==canonicalRequest(snapshot.header))return null;
      for(const value of change!.newEntries) {
        const saved=this.db.query<{entry_json:string;run_id:number|null},[number,string]>('SELECT entry_json,run_id FROM memories WHERE session_id=? AND native_entry_id=?').get(fact.sessionId,(value as {id:string}).id);
        if(!saved||saved.run_id!==null||canonicalRequest(decoded(saved.entry_json))!==canonicalRequest(value))return null;
      }
    } else if(original&&this.memory.confirmCommitted(change!)?.storageVersion!==version)return null;
    if(!manual) {
      const events=this.db.query<{payload_json:string;source:string;source_connection:string|null;source_sequence:number|null;tool_call_id:number|null},[number,number,string]>("SELECT * FROM runtime_events WHERE type='compaction_completed' AND run_id=? AND session_id=? AND json_extract(payload_json,'$.operationRef')=?").all(fact.runId!,fact.sessionId,fact.operationRef);
      const expected={contract:'medclaw.event/v1',operationRef:fact.operationRef,reason:fact.reason,nativeEntryId:fact.nativeEntryId,firstKeptEntryId:fact.firstKeptEntryId,storageVersion:version,tokensBefore:fact.tokensBefore,estimatedTokensAfter:fact.estimatedTokensAfter};
      if(events.length!==1||events[0]!.source!=='pi'||events[0]!.source_connection!==null||events[0]!.source_sequence!==null||events[0]!.tool_call_id!==null||!isDeepStrictEqual(decoded(events[0]!.payload_json),expected))return null;
    }
    return version;
  }
  recoverManualCompactions(instanceId:string,previousProcessExited:boolean,time:string):StoredCompactionOperation[] {
    checked(OpaqueIdSchema,instanceId);timestamp(time);
    return this.transactions.immediate(()=>{
      const rows=this.db.query<{operation_ref:string;session_id:number},[string]>("SELECT operation_ref,session_id FROM business_events s WHERE type='session_compaction_started' AND json_extract(details_json,'$.instanceId')<>? AND NOT EXISTS (SELECT 1 FROM business_events f WHERE f.operation_ref=s.operation_ref AND f.type='session_compaction_finished') ORDER BY id").all(instanceId);
      const pending:StoredCompactionOperation[]=[];
      for(const row of rows) {
        const operation=this.readCompactionOperation({sessionId:row.session_id,operationRef:row.operation_ref})!;
        if(!previousProcessExited){pending.push(operation);continue;}
        const error=safeError('runtime_interrupted'),calls=this.compactionCalls(row.operation_ref);
        for(const call of calls)if(call.state==='started')this.db.query("UPDATE model_calls SET state='failed',ended_at=?,error_json=?,unavailable_reason='call_not_observed' WHERE call_id=? AND state='started'").run(time,JSON.stringify(error),call.call_id);
        this.commitCompactionInTransaction(null,{contract:'medclaw.compaction/v1',operationRef:row.operation_ref,sessionId:row.session_id,runId:null,reason:'manual',status:'interrupted',nativeGenerated:null,nativeSaved:false,
          nativeEntryId:null,firstKeptEntryId:null,tokensBefore:null,estimatedTokensAfter:null,baseStorageVersion:operation.frozen.baseStorageVersion,storageVersion:null,activeLeafId:operation.frozen.baseLeafId,
          callIds:calls.map(call=>call.call_id),continuationEligibleAtCommit:false,cancelRequestedAt:operation.cancelRequestedAt,stoppedAt:time,finishedAt:time,noOpReason:null,error});
      }
      return pending;
    });
  }
  verifyPriorCompactionFacts(runId:number,previousProcessExited=false,time?:string):{requiredPersistenceComplete:boolean;unconfirmedItems:string[]} {
    id(runId);
    if(previousProcessExited) {
      timestamp(time!);
      this.transactions.immediate(()=>{
        const error=safeError('runtime_interrupted',undefined,{runId});
        for(const call of this.db.query<CallRow,[number]>("SELECT * FROM model_calls WHERE run_id=? AND kind='compaction'").all(runId)) {
          const model=decoded(call.model_json) as {compaction:unknown},marker=checked(CompactionCallMetadataSchema,model.compaction,'storage_read_failed');
          if(call.state==='started')this.db.query("UPDATE model_calls SET state='failed',ended_at=?,error_json=?,unavailable_reason='call_not_observed' WHERE call_id=? AND state='started'").run(time!,JSON.stringify(error),call.call_id);
          if(marker.nativeEntryId===null&&marker.operationEndedAt===null)this.db.query('UPDATE model_calls SET model_json=? WHERE call_id=?').run(JSON.stringify({...model,compaction:{...marker,operationEndedAt:time!,operationError:error}}),call.call_id);
        }
      });
    }
    return this.inputRead(()=>{
      const groups=this.db.query<{operation_ref:string},[number]>("SELECT DISTINCT json_extract(model_json,'$.compaction.operationRef') AS operation_ref FROM model_calls WHERE run_id=? AND kind='compaction'").all(runId);
      const gaps=new Set<string>();
      for(const group of groups) {
        const calls=this.compactionCalls(group.operation_ref),markers=calls.map(call=>checked(CompactionCallMetadataSchema,(decoded(call.model_json) as {compaction:unknown}).compaction,'storage_read_failed'));
        if(calls.some(call=>call.state==='started'||call.ended_at===null))gaps.add('compaction_call_unknown');
        if(markers.some(marker=>marker.operationEndedAt===null))gaps.add('compaction_operation_unconfirmed');
        const marker=markers[0]!;
        if(marker.nativeEntryId===null) {if(markers.some(marker=>marker.operationError===null))gaps.add('compaction_operation_unconfirmed');continue;}
        const entry=this.db.query<{entry_json:string},[number,string]>("SELECT entry_json FROM memories WHERE session_id=? AND native_entry_id=? AND entry_type='compaction'").get(calls[0]!.session_id,marker.nativeEntryId);
        const events=this.db.query<{payload_json:string},[number,string]>("SELECT payload_json FROM runtime_events WHERE run_id=? AND type='compaction_completed' AND json_extract(payload_json,'$.operationRef')=?").all(runId,group.operation_ref);
        if(!entry||events.length!==1){gaps.add('compaction_persistence');continue;}
        const parsed=RegisteredEventPayloadSchema.safeParse({type:'compaction_completed',payload:decoded(events[0]!.payload_json)});
        if(!parsed.success||parsed.data.type!=='compaction_completed'){gaps.add('compaction_persistence');continue;}
        const native=decoded(entry.entry_json) as {firstKeptEntryId:string;tokensBefore:number};
        const fact:CompactionSaveFact={operationRef:group.operation_ref,sessionId:calls[0]!.session_id,runId,reason:marker.reason as 'threshold'|'overflow',nativeEntryId:marker.nativeEntryId,firstKeptEntryId:native.firstKeptEntryId,
          tokensBefore:native.tokensBefore,estimatedTokensAfter:parsed.data.payload.estimatedTokensAfter,baseStorageVersion:marker.baseStorageVersion,callIds:calls.map(call=>call.call_id)};
        if(this.confirmCompactionSaved(null,fact)===null)gaps.add('compaction_persistence');
      }
      return {requiredPersistenceComplete:gaps.size===0,unconfirmedItems:[...gaps]};
    });
  }
  finishAutoCompaction(operationRef:string,runId:number,error:AppError,endedAt:string):void {
    id(runId);checked(OpaqueIdSchema,operationRef);checked(AppErrorSchema,error);timestamp(endedAt);
    this.inputWrite(()=>{
      const run=this.row(runId);if(!run||!['agent','child'].includes(run.kind))fail('state_conflict');
      if(run.kind==='child')readFrozenChild(this.db,runId);
      const calls=this.compactionCalls(operationRef);
      if(calls.some(call=>call.run_id!==runId||call.session_id!==run.session_id||call.state==='started'))fail('storage_write_failed');
      for(const call of calls) {
        const model=decoded(call.model_json) as {compaction:unknown},marker=checked(CompactionCallMetadataSchema,model.compaction);
        if(marker.source!=='auto')fail('state_conflict');
        if(marker.operationError!==null){if(!isDeepStrictEqual(marker.operationError,error))fail('state_conflict');continue;}
        this.db.query('UPDATE model_calls SET model_json=? WHERE call_id=?').run(JSON.stringify({...model,compaction:{...marker,operationEndedAt:marker.operationEndedAt??endedAt,operationError:error}}),call.call_id);
      }
    });
  }

  findOperation(operationRef: string): StoredOperation | null {
    checked(OpaqueIdSchema, operationRef);
    if(this.batchLifecycle&&this.db.query('SELECT id FROM data_deletions WHERE operation_ref=?').get(operationRef))fail('state_conflict');
    if(this.p3&&this.db.query('SELECT id FROM imports WHERE operation_ref=?').get(operationRef))fail('state_conflict');
    const sources=["SELECT id FROM sessions WHERE creation_operation_ref=?1","SELECT id FROM runs WHERE submission_operation_ref=?1 OR (kind='provider' AND json_extract(config_json,'$.providerRequest.operationRef')=?1)"];
    if(this.p5)sources.push("SELECT id FROM session_inputs WHERE operation_ref=?1");
    if(this.p3)sources.push("SELECT id FROM business_events WHERE operation_ref=?1 AND type IN ('session_renamed','session_deleted','session_checkpoint_restored','session_compaction_started')");
    const count=this.db.query<{n:number},[string]>(`SELECT COUNT(*) AS n FROM (${sources.join(' UNION ALL ')})`).get(operationRef)!.n;
    if(count>1)fail('state_conflict');
    if (this.p3) {
      const compact = this.compactionOperation(operationRef);
      if (compact) return {method:'session.compact',operationRef,originalRequest:compact.request,result:compact};
      if (this.db.query("SELECT id FROM model_calls WHERE kind='compaction' AND json_extract(model_json,'$.compaction.operationRef')=? LIMIT 1").get(operationRef)) fail('state_conflict');
    }
    if(this.p3){const checkpoint=this.readCheckpointOperation(operationRef);if(checkpoint)return {method:'session.restoreCheckpoint',operationRef,originalRequest:checkpoint.request,result:checkpoint.receipt};}
    if(this.p3){const management=this.managementDetails(operationRef);if(management){const {receipt,originalRequest}=management;
      if(receipt.method==='session.rename'&&'title' in originalRequest)return {method:receipt.method,operationRef,originalRequest,result:receipt};
      if(receipt.method==='session.delete'&&'expectedWorkspaceRevision' in originalRequest)return {method:receipt.method,operationRef,originalRequest,result:receipt};
      fail('storage_read_failed');
    }}
    const created = this.db.query<{ creation_request_json: string; creation_result_json: string }, [string]>(
      "SELECT creation_request_json,creation_result_json FROM sessions WHERE creation_operation_ref=?").get(operationRef);
    if (created) return { method: "session.create", operationRef,
      originalRequest: checked(NewSessionInputSchema, decoded(created.creation_request_json), "storage_read_failed"),
      result: this.creationReceipt(created.creation_result_json) };
    const input = this.p5 ? this.inputs.operation(operationRef) : null;
    if(input) return {method:"session.submit",operationRef,originalRequest:this.inputs.content(input).originalSubmitInput,result:this.inputs.result(input)};
    const submitted = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE submission_operation_ref=?").get(operationRef);
    if (submitted) return { method: "session.submit", operationRef,
      originalRequest: checked(SubmitInputSchema, decoded(submitted.submission_request_json), "storage_read_failed"), result: this.submissionResult(submitted) };
    return this.findProviderOperation(operationRef);
  }

  readWorkspace(): WorkspaceState {
    const row = this.db.query<{ active_session_id: number | null; revision: number; material_version: string | null;
      batch_refs_json: string; device_ids_json: string; active_query_id: number | null; active_view: string; selection_json: string | null }, []>("SELECT * FROM workspace WHERE id=1").get();
    if (!row) fail("storage_read_failed");
    const readJson=(text:string|null):unknown=>{if(text===null)return null;try{return JSON.parse(text);}catch{fail('storage_read_failed');}};
    return checked(WorkspaceStateSchema, legacyWorkspaceContext({ revision: row.revision, sessionId: row.active_session_id, materialVersion: row.material_version ?? null,
      batchRefs: row.batch_refs_json === undefined ? [] : readJson(row.batch_refs_json), deviceIds: row.device_ids_json === undefined ? [] : readJson(row.device_ids_json),
      queryId: row.active_query_id ?? null, activeView: row.active_view ?? "data", selection: row.selection_json === undefined ? null : readJson(row.selection_json) }), "storage_read_failed");
  }

  private batchReferences(ids: number[]): { refs: BatchRef[]; materialVersion: string | null } { return readWorkspaceBatchReferences(this.db, ids); }

  inspectWorkspace(invalidArtifactIds: readonly number[] = []): WorkspaceInspection {
    // One synchronous read snapshot fixes all DB evidence before any filesystem await.
    return this.db.transaction(() => this.workspaceInspection(invalidArtifactIds)).deferred();
  }

  private workspaceInspection(invalidArtifactIds: readonly number[]): WorkspaceInspection {
    const state=this.readWorkspace(), candidate:WorkspaceState=structuredClone(state), notices:WorkspaceNotice[]=[];
    const dependencies=new Map<string,{kind:string;id:number;record:Record<string,unknown>|null}>();
    const tables={session:'sessions',batch:'batches',import:'imports',artifact:'artifacts',device:'devices',snapshot:'snapshots',change:'change_events',query:'queries',evidence:'query_evidence'} as const;
    type Kind=keyof typeof tables;
    const ids=(value:unknown):number[]=>checked(z.array(PositiveIdSchema),value,'storage_read_failed');
    const load=(kind:Kind,target:number):Record<string,unknown>|null=>{
      const key=`${kind}:${target}`,known=dependencies.get(key);if(known)return known.record;
      const row=this.db.query<Record<string,unknown>,[number]>(kind==='session'?'SELECT id,kind,status,title,metadata_revision,deleted_at,metadata_json FROM sessions WHERE id=?':`SELECT * FROM ${tables[kind]} WHERE id=?`).get(target);
      dependencies.set(key,{kind,id:target,record:row});
      if(!row)return null;
      for(const [field,value] of Object.entries(row))if(field.endsWith('_json')&&typeof value==='string') {
        try{JSON.parse(value);}catch{fail('storage_read_failed');}
      }
      const ref=(type:Kind,value:unknown)=>{if(value!==null&&value!==undefined)load(type,checked(PositiveIdSchema,value,'storage_read_failed'));};
      const members=(type:Kind,field:string)=>{if(typeof row[field]==='string')for(const id of ids(JSON.parse(row[field])))load(type,id);};
      if(kind==='batch')ref('import',row.import_id);
      if(kind==='import')ref('artifact',row.artifact_id);
      if(kind==='artifact')ref('import',row.import_id);
      if(kind==='snapshot'){ref('batch',row.batch_id);ref('device',row.device_id);}
      if(kind==='change'){ref('batch',row.old_batch_id);ref('batch',row.new_batch_id);ref('device',row.device_id);}
      if(kind==='query') {
        ref('session',row.session_id);members('batch','batch_ids_json');
        const query=new SqliteToolStore(this.db).readQuery(target)!;
        for(const id of query.snapshotIds)load('snapshot',id);
        for(const id of query.eventIds)load('change',id);
        for(const id of query.scopeDeviceIds??[])load('device',id);
        for(const evidence of this.db.query<{id:number},[number]>('SELECT id FROM query_evidence WHERE query_id=? ORDER BY id').all(target))load('evidence',evidence.id);
      }
      if(kind==='evidence'){ref('query',row.query_id);members('batch','batch_ids_json');members('snapshot','snapshot_ids_json');members('change','event_ids_json');new SqliteToolStore(this.db).readEvidence(target);}
      return row;
    };
    const clear=(kind:WorkspaceNotice['kind'],targetId:number)=>notices.push({code:'reference_cleared',kind,targetId:String(targetId)});
    if(state.sessionId!==null){const row=load('session',state.sessionId);if(!row||row.kind!=='user'||row.status!=='active'){candidate.sessionId=null;clear('session',state.sessionId);}}
    const artifactIds:number[]=[];
    candidate.batchRefs=state.batchRefs.filter(ref=>{
      const batch=load('batch',ref.id);
      const owner=batch?load('import',Number(batch.import_id)):null;
      const artifact=owner&&owner.artifact_id!==null?load('artifact',Number(owner.artifact_id)):null;
      const valid=batch&&batch.status==='active'&&batch.snapshot_date===ref.snapshotDate&&batch.scope_key===ref.scopeKey
        &&batch.material_version===state.materialVersion&&owner&&['imported','duplicate'].includes(String(owner.state))&&artifact
        &&artifact.import_id===owner.id&&artifact.operation_ref===owner.operation_ref&&artifact.status==='ready';
      if(valid)artifactIds.push(Number(artifact.id));
      if(!valid||invalidArtifactIds.includes(Number(artifact?.id))){clear('batch',ref.id);return false;}return true;
    });
    candidate.materialVersion=candidate.batchRefs.length?state.materialVersion:null;
    for(const deviceId of state.deviceIds){
      load('device',deviceId);
      for(const ref of state.batchRefs)for(const row of this.db.query<{id:number},[number,number]>('SELECT id FROM snapshots WHERE batch_id=? AND device_id=? ORDER BY id').all(ref.id,deviceId))load('snapshot',row.id);
    }
    candidate.deviceIds=state.deviceIds.filter(deviceId=>{
      const valid=load('device',deviceId)&&candidate.batchRefs.some(batch=>this.db.query('SELECT id FROM snapshots WHERE batch_id=? AND device_id=?').get(batch.id,deviceId));
      if(!valid)clear('device',deviceId);return !!valid;
    });
    if(state.queryId!==null){
      load('query',state.queryId);
      try{this.workspaceQuery(state.queryId,candidate);}catch(error){if(error instanceof Error&&error.message==='access_denied'){candidate.queryId=null;clear('query',state.queryId);}else throw error;}
    }
    if(state.selection){
      const selection=state.selection;
      if(selection.kind==='device'||selection.rowKey?.startsWith('snapshot:'))load('snapshot',Number(selection.rowKey!.slice(9)));
      if(selection.kind==='change')load('change',Number(selection.targetId));
      if(selection.rowKey?.startsWith('change:'))load('change',Number(selection.rowKey.slice(7)));
      if(selection.kind==='evidence')load('evidence',Number(selection.targetId));
      candidate.selection=this.compatibleSelection(selection,candidate);
      if(candidate.selection===null)clear('selection',Number(selection.targetId));
    }
    if(candidate.queryId===null&&['query','evidence'].includes(candidate.activeView))candidate.activeView='data';
    const sorted=[...dependencies.values()].sort((a,b)=>a.kind.localeCompare(b.kind)||a.id-b.id);
    return {state,candidate,artifactIds:[...new Set(artifactIds)].sort((a,b)=>a-b),notices,dependencies:sorted};
  }

  commitWorkspaceRestore(expectedRevision:number,expectedDependencies:unknown,candidate:WorkspaceState,time:string):WorkspaceState {
    checked(RevisionSchema,expectedRevision);checked(WorkspaceStateSchema,candidate);timestamp(time);
    return this.transactions.immediate(()=>{
      const original=this.workspaceInspection([]);
      if(original.state.revision!==expectedRevision||!isDeepStrictEqual(original.dependencies,expectedDependencies))throw safeError('state_conflict',undefined,{reason:'workspace_revision_mismatch'});
      // DB-invalid references already disappeared from the original candidate.
      // Only additional removals can represent a failed managed-file inspection.
      const invalidArtifacts=original.candidate.batchRefs.filter(ref=>!candidate.batchRefs.some(item=>item.id===ref.id)).flatMap(ref=>{
        const row=this.db.query<{artifact_id:number|null},[number]>('SELECT i.artifact_id FROM batches b JOIN imports i ON i.id=b.import_id WHERE b.id=?').get(ref.id);
        return row?.artifact_id==null?[]:[row.artifact_id];
      });
      const verified=this.workspaceInspection(invalidArtifacts);
      if(!isDeepStrictEqual(candidate,verified.candidate)||candidate.revision!==expectedRevision)fail('invalid_argument');
      const saved=this.saveWorkspace(original.state,candidate,time);
      if(saved!==original.state)this.beforeCommit?.();
      return saved;
    });
  }

  private workspaceQuery(queryId: number, state: WorkspaceState): QueryRecord { return readWorkspaceQuery(this.db, queryId, state); }

  reconcileDeletedWorkspace(expectedRevision:number,time:string):WorkspaceState {
    return this.transactions.immediate(()=>{
      const old=this.readWorkspace();if(old.revision!==expectedRevision)fail('workspace_revision_mismatch');
      const next=structuredClone(old),catalog=new SqliteCatalogStore(this.db);
      const live=new Set(catalog.readBatches(old.batchRefs.map(ref=>ref.id)).map(batch=>batch.id));
      next.batchRefs=old.batchRefs.filter(ref=>live.has(ref.id));next.materialVersion=next.batchRefs.length?old.materialVersion:null;
      next.deviceIds=old.deviceIds.filter(id=>next.batchRefs.some(batch=>this.db.query('SELECT id FROM snapshots WHERE batch_id=? AND device_id=?').get(batch.id,id)));
      if(next.queryId!==null){try{this.workspaceQuery(next.queryId,next);}catch(error){if(error instanceof Error&&error.message==='access_denied')next.queryId=null;else throw error;}}
      next.selection=this.compatibleSelection(next.selection,next);
      if(next.queryId===null&&['query','evidence'].includes(next.activeView))next.activeView='data';
      return this.saveWorkspace(old,next,time);
    });
  }

  private validateSelection(selection: WorkspaceSelection, state: WorkspaceState): void { return validateWorkspaceSelection(this.db, selection, state); }

  private compatibleSelection(selection: WorkspaceSelection | null, state: WorkspaceState): WorkspaceSelection | null {
    if (selection === null) return null;
    try { this.validateSelection(selection, state); return selection; }
    catch (error) {
      if (error instanceof Error && ['access_denied','invalid_argument'].includes(error.message)) return null;
      throw error;
    }
  }

  private saveWorkspace(old: WorkspaceState, candidate: WorkspaceState, time: string, forceRevision=false): WorkspaceState {
    const next = checked(WorkspaceStateSchema, candidate);
    const semantic=(state:WorkspaceState)=>({...state,batchRefs:[...state.batchRefs].sort((a,b)=>a.id-b.id),deviceIds:[...state.deviceIds].sort((a,b)=>a-b)});
    if (!forceRevision&&isDeepStrictEqual(semantic(old), semantic(next))) return old;
    if (old.revision === Number.MAX_SAFE_INTEGER) fail('state_conflict');
    next.revision = old.revision + 1;
    const saved = this.p3 ? this.db.query(`UPDATE workspace SET active_session_id=?,material_version=?,batch_refs_json=?,device_ids_json=?,active_query_id=?,active_view=?,selection_json=?,revision=?,updated_at=? WHERE id=1 AND revision=?`)
      .run(next.sessionId,next.materialVersion,JSON.stringify(next.batchRefs),JSON.stringify(next.deviceIds),next.queryId,next.activeView,json(next.selection),next.revision,time,old.revision)
      : this.db.query('UPDATE workspace SET active_session_id=?,revision=?,updated_at=? WHERE id=1 AND revision=?').run(next.sessionId,next.revision,time,old.revision);
    if (saved.changes !== 1) fail('workspace_revision_mismatch');
    return next;
  }

  updateWorkspace(change: WorkspaceChange, expectedRevision: number, time: string): WorkspaceState {
    const request = checked(WorkspaceChangeSchema, change); checked(RevisionSchema, expectedRevision); timestamp(time);
    return this.transactions.immediate(() => {
      const old = this.readWorkspace();
      if (old.revision !== expectedRevision) fail("workspace_revision_mismatch");
      const normalized = (ids: number[]) => [...new Set(ids)].sort((a,b) => a-b);
      let batchIds = normalized(request.batchIds ?? old.batchRefs.map(batch => batch.id));
      let explicitDevices = request.deviceIds;
      if (request.queryId != null) {
        const query = new SqliteToolStore(this.db).readQuery(request.queryId);
        if (!query || query.sessionId !== old.sessionId) fail('access_denied');
        const queryBatches = normalized(query.batchIds), queryDevices = normalized(query.scopeDeviceIds ?? []);
        if (request.batchIds !== undefined && !isDeepStrictEqual(batchIds,queryBatches)
          || explicitDevices !== undefined && !isDeepStrictEqual(normalized(explicitDevices),queryDevices)) fail('invalid_argument');
        batchIds = queryBatches; explicitDevices = queryDevices;
      }
      const batches = this.batchReferences(batchIds);
      const present = (deviceId: number) => batchIds.some(batchId => this.db.query('SELECT id FROM snapshots WHERE batch_id=? AND device_id=?').get(batchId,deviceId));
      const deviceIds = normalized(explicitDevices ?? old.deviceIds.filter(present));
      if (deviceIds.some(deviceId => !present(deviceId))) fail('access_denied');
      const scopeChanged = !isDeepStrictEqual(batches.refs,[...old.batchRefs].sort((a,b)=>a.id-b.id)) || batches.materialVersion !== old.materialVersion || !isDeepStrictEqual(deviceIds,normalized(old.deviceIds));
      const queryId = request.queryId !== undefined ? request.queryId : scopeChanged ? null : old.queryId;
      const next: WorkspaceState = {...old,batchRefs:batches.refs,materialVersion:batches.materialVersion,deviceIds,queryId,activeView:request.activeView ?? old.activeView,selection:null};
      if (queryId !== null) this.workspaceQuery(queryId,next);
      next.selection = request.selection !== undefined ? request.selection : this.compatibleSelection(old.selection,next);
      if (request.selection != null) this.validateSelection(request.selection,next);
      if (queryId === null && ['query','evidence'].includes(next.activeView)) next.activeView = 'data';
      const saved = this.saveWorkspace(old,next,time);
      if (saved === old) return old;
      this.beforeCommit?.();
      return saved;
    });
  }

  freezeAgentScope(workspace: WorkspaceView, toolNames: readonly string[]): RunScope { return freezeWorkspaceScope(this.db, workspace, toolNames); }

  readSession(sessionId: number): SessionView | null {
    id(sessionId);
    const row = this.db.query<{ id: number; native_session_id: string; title: string; kind: string; status: string; storage_version: number; current_leaf_id?:string|null; metadata_json:string; metadata_revision?:number; deleted_at?:string|null }, [number]>("SELECT * FROM sessions WHERE id=?").get(sessionId);
    if (!row || row.kind !== 'user') return null;
    const sequence = this.db.query<{ n: number | null }, [number]>(this.p5 ? "SELECT MAX(n) AS n FROM (SELECT submission_client_sequence AS n FROM runs WHERE session_id=?1 UNION ALL SELECT client_sequence AS n FROM session_inputs WHERE session_id=?1)" : "SELECT MAX(submission_client_sequence) AS n FROM runs WHERE session_id=?").get(sessionId)?.n ?? 0;
    return checked(SessionViewSchema, { id: row.id, title: this.sessionTitle(row), metadataRevision:row.metadata_revision??0, deletedAt:row.deleted_at??null, nativeSessionId: row.native_session_id, kind: row.kind, status: row.status,
      inputControl: null, storageVersion: row.storage_version, leafId: row.current_leaf_id??null, nextSubmissionSequence: sequence + 1 }, "storage_read_failed");
  }

  readAnswer(runId: number): AnswerRecord | null {
    id(runId);
    const run = this.row(runId);
    if (!run) return null;
    const session = run.session_id === null ? null : this.readSession(run.session_id);
    if (run.kind !== 'agent' || !session || session.kind !== 'user' || session.status !== 'active') fail('access_denied');
    const row = this.db.query<{ id: number; run_id: number; session_id: number; input_id: number | null; kind: string; text: string;
      query_ids_json: string; missing_slots_json: string; native_leaf_id: string | null; created_at: string }, [number]>('SELECT * FROM answers WHERE run_id=?').get(runId);
    if (!row) return null;
    if (run.status !== 'completed' || row.session_id !== session.id || row.input_id !== run.input_id) fail('storage_read_failed');
    const route = this.db.query<{ session_id: number; input_id: number; route: string; decision_source: string; query_params_json: string | null }, [number]>('SELECT * FROM route_decisions WHERE run_id=?').get(runId);
    let resultSource: AnswerRecord['resultSource'] = 'agent';
    if (route) {
      if (route.session_id !== session.id || route.input_id !== run.input_id) fail('storage_read_failed');
      const input = this.db.query<{ content_json: string; session_id: number; target_run_id: number | null }, [number]>('SELECT * FROM session_inputs WHERE id=?').get(route.input_id);
      if (!input || input.session_id !== session.id || input.target_run_id !== runId) fail('storage_read_failed');
      const original = checked(InputContentSchema, legacyInputContent(JSON.parse(input.content_json)), 'storage_read_failed').originalSubmitInput;
      if (original.mode !== 'send' || original.sessionId !== session.id) fail('storage_read_failed');
      if (route.decision_source === 'user_form') {
        if (!original.routing || String(original.routing.mode) !== 'user_form' || !('params' in original.routing)
          || route.route !== 'simple' || canonicalRequest(original.routing.params) !== canonicalRequest(JSON.parse(route.query_params_json!))) fail('storage_read_failed');
        resultSource = 'user_form';
      } else if (route.decision_source !== 'explicit_agent_fallback') {
        if (original.routing?.mode !== 'intent') fail('storage_read_failed');
        resultSource = route.route === 'agent' ? 'agent' : 'program';
      }
    }
    const answer = checked(AnswerRecordSchema, { id: row.id, runId, sessionId: session.id, inputId: row.input_id, kind: row.kind, text: row.text,
      queryIds: JSON.parse(row.query_ids_json), missingSlots: JSON.parse(row.missing_slots_json), nativeLeafId: row.native_leaf_id, createdAt: row.created_at, resultSource }, 'storage_read_failed');
    const scope = checked(RunScopeSchema, legacyRunScope(JSON.parse(run.scope_json!)), 'storage_read_failed'), store = new SqliteToolStore(this.db);
    if (answer.queryIds.some(queryId => {
      const query = store.readQuery(queryId);
      return !query || query.sessionId !== session.id || query.batchIds.some(batchId => !scope.batchIds.includes(batchId))
        || scope.deviceIds !== null && (query.scopeDeviceIds === null || query.scopeDeviceIds.some(deviceId => !scope.deviceIds!.includes(deviceId)));
    })) fail('access_denied');
    return answer;
  }

  listActivity(value: z.input<typeof ActivityListInputSchema>) {
    const input = ActivityListInputSchema.parse(value);
    return this.inputRead(() => {
    if (input.sessionId !== null) {
      const session = this.readSession(input.sessionId);
      if (!session || session.kind !== 'user' || session.status !== 'active') fail('access_denied');
    }
    const rows = this.db.query<{ id: number; operation_ref: string; type: string; actor: string; occurred_at: string;
      session_id: number | null; run_id: number | null; import_id: number | null; query_id: number | null; artifact_id: number | null; export_id: number | null; details_json: string },
      [number | null, number | null, number]>('SELECT * FROM business_events WHERE session_id IS ? AND (?2 IS NULL OR id<?2) ORDER BY id DESC LIMIT ?3')
      .all(input.sessionId, input.beforeEventId ?? null, input.limit + 1);
    const page = rows.slice(0, input.limit).map(row => {
      const details = { source: null, answerId: null, rowCount: null, batchCount: null, copyState: null } as z.infer<typeof BusinessActivitySchema>['details'];
      if (['import.imported', 'import.duplicate', 'query_committed', 'answer_committed', 'export_registered', 'export_copied'].includes(row.type)) {
        const saved = checked(z.record(z.string(), z.unknown()), JSON.parse(row.details_json), 'storage_read_failed');
        if (row.type.startsWith('import.')) {
          const counts = checked(z.object({ acceptedRows: z.number().int().nonnegative().safe(), duplicateRows: z.number().int().nonnegative().safe(), batchIds: z.array(PositiveIdSchema) }), saved, 'storage_read_failed');
          details.rowCount = counts.acceptedRows + counts.duplicateRows; details.batchCount = counts.batchIds.length;
        } else {
          details.source = saved.source as typeof details.source ?? (saved.resultSource === 'program' ? 'intent' : saved.resultSource === 'user_form' ? 'user_form' : null);
          details.answerId = saved.answerId as number ?? null; details.rowCount = saved.rowCount as number ?? null;
          details.copyState = saved.copyState as typeof details.copyState ?? null;
        }
      }
      return checked(BusinessActivitySchema, { id: row.id, operationRef: row.operation_ref, type: row.type, actor: row.actor, occurredAt: row.occurred_at,
        sessionId: row.session_id, runId: row.run_id, importId: row.import_id, queryId: row.query_id, artifactId: row.artifact_id, exportId: row.export_id, details }, 'storage_read_failed');
    });
    return checked(ActivityListSchema, { items: page, nextBeforeEventId: rows.length > input.limit ? page.at(-1)!.id : null }, 'storage_read_failed');
    });
  }

  readChildIdentity(runId: number): BoundChildIdentity | null {
    id(runId);
    const row = this.row(runId); if (!row || row.kind !== 'child') return null;
    const frozen = readFrozenChild(this.db, runId);
    return checked(BoundChildIdentitySchema, Object.fromEntries(Object.keys(BoundChildIdentitySchema.shape).map(key => [key, frozen[key as keyof typeof frozen]])), 'storage_read_failed');
  }

  private sessionTitle(row:{id:number;title:string;metadata_json:string}):string {
    let metadata:unknown;try{metadata=JSON.parse(row.metadata_json);}catch{fail('storage_read_failed');}
    const parsed=checked(z.object({titleOrigin:z.enum(['default','user']).optional()}).passthrough(),metadata,'storage_read_failed');
    return parsed.titleOrigin==='default'&&row.title===`新会话 ${row.id}` ? `New Session ${row.id}` : row.title;
  }
  private assertSessionActive(session:SessionView):void {
    if(session.status==='deleted')throw safeError('state_conflict',undefined,{reason:'session_deleted'});
    if(session.kind!=='user')fail('access_denied');
  }
  private checkpointHistory(sessionId:number) {
    if(!this.memory)fail('session_history_invalid');return this.memory.loadInTransaction(sessionId);
  }
  private checkpointPath(history:NativeHistorySnapshot,leaf:string|null):Set<string> {
    const entries=new Map((history.entries as {id:string;parentId:string|null}[]).map(entry=>[entry.id,entry])),path=new Set<string>();
    while(leaf!==null){const entry=entries.get(leaf);if(!entry||path.has(leaf))fail('session_history_invalid');path.add(leaf);leaf=entry.parentId;}
    return path;
  }
  private eligibleCheckpoints(history:NativeHistorySnapshot) {
    // ponytail: O(Session history + answers); page the candidate scan if measured long histories make reads slow.
    const entries=new Map((history.entries as {id:string;parentId:string|null;type:string;message?:{role:string;stopReason?:string;content:{type:string}[]}}[]).map(entry=>[entry.id,entry]));
    const rows=this.db.query<{id:number;run_id:number;input_id:number;text:string;native_leaf_id:string;created_at:string;input_text:string;native_entry_id:string;cleanup_json:string},[number]>(`SELECT a.*,r.input_text,r.cleanup_json,i.native_entry_id FROM answers a
      JOIN runs r ON r.id=a.run_id AND r.session_id=a.session_id AND r.kind='agent' AND r.status='completed'
      JOIN session_inputs i ON i.id=a.input_id AND i.id=r.input_id AND i.session_id=a.session_id AND i.run_id=r.id AND i.status='consumed' AND i.processing_status='completed'
      WHERE a.session_id=? AND a.native_leaf_id IS NOT NULL ORDER BY a.id DESC`).all(history.sessionId);
    return rows.filter(row=>{
      const cleanup=RunCleanupRecordSchema.safeParse(decoded(row.cleanup_json));
      if(!cleanup.success||cleanup.data.stopConfirmed!==true||cleanup.data.requiredPersistenceComplete!==true||cleanup.data.inputsSettled!==true||cleanup.data.resourcesReleased!==true||cleanup.data.unconfirmedItems.length)return false;
      const path=this.checkpointPath(history,row.native_leaf_id),user=entries.get(row.native_entry_id);
      if(!user||user.type!=='message'||user.message?.role!=='user'||!path.has(user.id))return false;
      const decision=this.intents?.readIntentFacts({runId:row.run_id})?.decision;
      if(decision&&decision.decisionSource!=='explicit_agent_fallback'){
        try{this.readSavedIntentFinal(this.row(row.run_id)!,history);return true;}catch{return false;}
      }
      const assistant=[...path].map(id=>entries.get(id)!).find(entry=>entry.type==='message');
      if(!assistant||assistant.message?.role!=='assistant'||!['stop','length'].includes(assistant.message.stopReason??'')||assistant.message.content.some(part=>part.type==='toolCall'))return false;
      return !!this.db.query('SELECT id FROM memories WHERE session_id=? AND native_entry_id=? AND run_id=?').get(history.sessionId,assistant.id,row.run_id)
        &&!!this.db.query('SELECT id FROM memories WHERE session_id=? AND native_entry_id=? AND run_id=?').get(history.sessionId,user.id,row.run_id);
    });
  }
  readCheckpoints(input:ReadSessionCheckpointsInput) {
    const request=checked(ReadSessionCheckpointsInputSchema,input);
    return this.inputRead(()=>this.db.transaction(()=>{
      const session=this.readSession(request.sessionId);if(!session)fail('session_not_found');if(session.kind!=='user')fail('access_denied');
      const history=this.checkpointHistory(session.id),eligible=this.eligibleCheckpoints(history),current=this.checkpointPath(history,history.activeLeafId);
      if(request.afterAnswerId!==null&&!eligible.some(row=>row.id===request.afterAnswerId))throw safeError('session_history_invalid',undefined,{reason:'checkpoint_invalid'});
      const rows=eligible.filter(row=>request.afterAnswerId===null||row.id<request.afterAnswerId),page=rows.slice(0,request.limit),hasMore=rows.length>request.limit;
      return checked(SessionCheckpointPageSchema,{sessionId:session.id,storageVersion:history.storageVersion,items:page.map(row=>{
        const adopted=this.intents?this.reachableIntentCondition({...history,activeLeafId:row.native_leaf_id})?.adopted:null;
        const slots=adopted?.contract==='medclaw.query-form-context/v1'?adopted.params:adopted?.adoptedSlots;
        const summary=slots?[slots.region,slots.manufacturer,'device' in slots?slots.device:slots.deviceIds?.join(', '),slots.category,slots.status??'All statuses',slots.time?`${slots.time.start} ≤ date < ${slots.time.endExclusive}`:null].filter(Boolean).join(' · '):null;
        return {answerId:row.id,runId:row.run_id,nativeLeafId:row.native_leaf_id,committedAt:row.created_at,questionSummary:safePreview(row.input_text,512).text,answerSummary:safePreview(row.text,512).text,conditionSummary:summary===null?null:safePreview(summary,1024).text,isCurrentBranch:current.has(row.native_leaf_id)};
      }),nextAnswerId:hasMore?page.at(-1)!.id:null,hasMore},'storage_read_failed');
    }).deferred());
  }
  readCheckpointOperation(operationRef:string):{request:RestoreSessionCheckpointInput;receipt:SessionCheckpointReceipt}|null {
    checked(OpaqueIdSchema,operationRef);
    return this.inputRead(()=>{
      const rows=this.db.query<{session_id:number|null;actor:string;run_id:number|null;import_id:number|null;query_id:number|null;artifact_id:number|null;details_json:string;occurred_at:string},[string]>("SELECT * FROM business_events WHERE operation_ref=? AND type='session_checkpoint_restored'").all(operationRef);
      if(rows.length>1)fail('storage_read_failed');const row=rows[0];if(!row)return null;
      const details=checked(SessionCheckpointDetailsSchema,decoded(row.details_json),'storage_read_failed');
      if(row.actor!=='user'||row.session_id!==details.receipt.sessionId||details.receipt.operationRef!==operationRef||row.occurred_at!==details.receipt.committedAt
        ||row.run_id!==null||row.import_id!==null||row.query_id!==null||row.artifact_id!==null||!this.readSession(details.receipt.sessionId))fail('storage_read_failed');
      return {request:details.request,receipt:details.receipt};
    });
  }
  restoreCheckpointInTransaction(input:RestoreSessionCheckpointInput,operationRef:string,time:string):SessionCheckpointReceipt {
    this.transactions.assertActive();const request=checked(RestoreSessionCheckpointInputSchema,input);checked(OpaqueIdSchema,operationRef);timestamp(time);
    const prior=this.findOperation(operationRef);if(prior){if(prior.method!=='session.restoreCheckpoint'||canonicalRequest(prior.originalRequest)!==canonicalRequest(request))fail('state_conflict');return prior.result;}
    const session=this.readSession(request.sessionId);if(!session)fail('session_not_found');this.assertSessionActive(session);const workspace=this.readWorkspace();
    if(workspace.revision!==request.expectedWorkspaceRevision)throw safeError('state_conflict',undefined,{reason:'workspace_revision_mismatch'});
    if(workspace.sessionId!==session.id)fail('state_conflict');
    if(session.storageVersion!==request.expectedStorageVersion||session.storageVersion===Number.MAX_SAFE_INTEGER)throw safeError('state_conflict',undefined,{reason:'history_version_mismatch'});
    this.assertHistoryMutationAllowed(session.id);
    const history=this.checkpointHistory(session.id);if(!this.eligibleCheckpoints(history).some(row=>row.native_leaf_id===request.targetLeafId))throw safeError('session_history_invalid',undefined,{reason:'checkpoint_invalid'});
    if(this.db.query('UPDATE sessions SET current_leaf_id=?,storage_version=storage_version+1,updated_at=? WHERE id=? AND storage_version=?').run(request.targetLeafId,time,session.id,session.storageVersion).changes!==1)fail('state_conflict');
    if(this.intents){
      const condition=this.reachableIntentCondition({...history,activeLeafId:request.targetLeafId,storageVersion:session.storageVersion+1});
      if(condition)this.writeIntentContext(session.id,request.targetLeafId,condition.adopted,time);
      else this.db.query('DELETE FROM query_contexts WHERE session_id=?').run(session.id);
    }
    const next=this.saveWorkspace(workspace,this.sessionWorkspace(workspace,session.id),time,true);
    const receipt:SessionCheckpointReceipt={operationRef,sessionId:session.id,targetLeafId:request.targetLeafId,storageVersion:session.storageVersion+1,workspaceRevision:next.revision,committedAt:time};
    const details:SessionCheckpointDetails=checked(SessionCheckpointDetailsSchema,{format:'medclaw.session-checkpoint/v1',request,before:{leafId:session.leafId,storageVersion:session.storageVersion,workspaceRevision:workspace.revision},receipt});
    this.db.query("INSERT INTO business_events(operation_ref,type,actor,session_id,details_json,occurred_at) VALUES(?,'session_checkpoint_restored','user',?,?,?)").run(operationRef,session.id,canonicalRequest(details),time);
    this.beforeCommit?.();return receipt;
  }
  private managementDetails(operationRef:string):SessionManagementDetails|null {
    const rows=this.db.query<{operation_ref:string;type:string;actor:string;session_id:number|null;run_id:number|null;import_id:number|null;query_id:number|null;artifact_id:number|null;details_json:string;occurred_at:string},[string]>(
      "SELECT * FROM business_events WHERE operation_ref=? AND type IN ('session_renamed','session_deleted')").all(operationRef);
    if(rows.length>1)fail('state_conflict');const row=rows[0];if(!row)return null;
    let value:unknown;try{value=JSON.parse(row.details_json);}catch{fail('storage_read_failed');}
    const details=checked(SessionManagementDetailsSchema,value,'storage_read_failed'),receipt=details.receipt;
    if(row.operation_ref!==receipt.operationRef||row.type!==(receipt.method==='session.rename'?'session_renamed':'session_deleted')
      ||row.actor!=='user'||row.session_id!==receipt.session.id||row.occurred_at!==receipt.committedAt
      ||row.run_id!==null||row.import_id!==null||row.query_id!==null||row.artifact_id!==null)fail('storage_read_failed');
    return details;
  }
  readManagementOperation(input:ReadManagementOperationInput):SessionManagementReceipt|null {
    const request=checked(ReadManagementOperationInputSchema,input);
    try {
      const operation=this.findOperation(request.operationRef);
      return operation?.method==='session.rename'||operation?.method==='session.delete'?operation.result:null;
    } catch { return fail('storage_read_failed'); }
  }
  private managementSession(sessionId:number,expectedRevision:number):SessionView {
    const session=this.readSession(sessionId);if(!session)throw safeError('input_invalid',undefined,{reason:'session_not_found'});
    this.assertSessionActive(session);
    if(session.metadataRevision!==expectedRevision)throw safeError('state_conflict',undefined,{reason:'session_metadata_revision_mismatch'});
    return session;
  }
  private managementReplay(method:'session.rename'|'session.delete',request:RenameSessionInput|DeleteSessionInput,operationRef:string):SessionManagementReceipt|null {
    const operation=this.findOperation(operationRef);if(!operation)return null;
    if(operation.method!==method||canonicalRequest(operation.originalRequest)!==canonicalRequest(request))fail('state_conflict');
    if(operation.method==='session.rename'||operation.method==='session.delete')return operation.result;
    return fail('state_conflict');
  }
  private saveManagement(request:RenameSessionInput|DeleteSessionInput,receipt:SessionManagementReceipt):void {
    const details=checked(SessionManagementDetailsSchema,{format:'medclaw.session-management/v1',originalRequest:request,receipt});
    this.db.query("INSERT INTO business_events(operation_ref,type,actor,session_id,details_json,occurred_at) VALUES(?,?,'user',?,?,?)")
      .run(receipt.operationRef,receipt.method==='session.rename'?'session_renamed':'session_deleted',receipt.session.id,canonicalRequest(details),receipt.committedAt);
  }
  renameSession(input:RenameSessionInput,operationRef:string,time:string):SessionManagementReceipt {
    const request=checked(RenameSessionInputSchema,input);checked(OpaqueIdSchema,operationRef);checked(TimestampSchema,time);
    return this.inputWrite(()=>{
      const prior=this.managementReplay('session.rename',request,operationRef);if(prior)return prior;
      const session=this.managementSession(request.sessionId,request.expectedMetadataRevision);
      if(request.title!==session.title){
        if(session.metadataRevision===Number.MAX_SAFE_INTEGER)fail('state_conflict');
        this.db.query("UPDATE sessions SET title=?,metadata_json=json_set(metadata_json,'$.titleOrigin','user'),metadata_revision=metadata_revision+1,updated_at=? WHERE id=? AND status='active' AND metadata_revision=?")
          .run(request.title,time,session.id,session.metadataRevision);
      }
      const receipt=checked(SessionManagementReceiptSchema,{operationRef,method:'session.rename',session:this.metadataView(this.readSession(session.id)!),workspace:null,committedAt:time});
      this.saveManagement(request,receipt);return receipt;
    });
  }
  private metadataView(session:SessionView) {return {id:session.id,title:session.title,status:session.status,metadataRevision:session.metadataRevision,deletedAt:session.deletedAt};}
  private assertSessionPersistedClosed(sessionId:number):void {
    if(this.p5&&this.db.query("SELECT id FROM session_inputs WHERE session_id=? AND (processing_status='pending' OR status='delivery_unknown') LIMIT 1").get(sessionId))fail('runtime_busy');
    for(const row of this.db.query<RunRow,[number]>('SELECT * FROM runs WHERE session_id=?').all(sessionId)){
      const cleanup=RunCleanupRecordSchema.safeParse(decoded(row.cleanup_json));
      if(row.status==='created'||row.status==='running'||!cleanup.success
        ||!(cleanup.data.executionStarted===false||cleanup.data.stopConfirmed===true)||cleanup.data.requiredPersistenceComplete!==true
        ||cleanup.data.inputsSettled!==true||cleanup.data.resourcesReleased!==true||cleanup.data.unconfirmedItems.length)fail('runtime_busy');
      if(this.p3&&this.db.query("SELECT id FROM tool_calls WHERE run_id=? AND (status IN ('requested','running') OR (effect='LOCAL_WRITE' AND json_extract(result_json,'$.outcomeUnknown')=1)) LIMIT 1").get(row.id))fail('runtime_busy');
    }
  }
  assertHistoryMutationAllowed(sessionId:number):void {
    const session=this.readSession(sessionId);if(!session)fail('session_not_found');this.assertSessionActive(session);
    if(this.active())throw safeError('state_conflict',undefined,{reason:'runtime_busy'});
    this.assertSessionPersistedClosed(sessionId);
  }
  deleteSession(input:DeleteSessionInput,operationRef:string,time:string):SessionManagementReceipt {
    const request=checked(DeleteSessionInputSchema,input);checked(OpaqueIdSchema,operationRef);checked(TimestampSchema,time);
    return this.inputWrite(()=>{
      const prior=this.managementReplay('session.delete',request,operationRef);if(prior)return prior;
      const session=this.managementSession(request.sessionId,request.expectedMetadataRevision),workspace=this.readWorkspace();
      if(workspace.revision!==request.expectedWorkspaceRevision)throw safeError('state_conflict',undefined,{reason:'workspace_revision_mismatch'});
      if(session.metadataRevision===Number.MAX_SAFE_INTEGER)fail('state_conflict');this.assertSessionPersistedClosed(session.id);
      this.db.query("UPDATE sessions SET status='deleted',deleted_at=?,metadata_revision=metadata_revision+1,updated_at=? WHERE id=? AND status='active' AND metadata_revision=?")
        .run(time,time,session.id,session.metadataRevision);
      const finalWorkspace=workspace.sessionId===session.id?this.saveWorkspace(workspace,this.sessionWorkspace(workspace,null),time):workspace;
      const receipt=checked(SessionManagementReceiptSchema,{operationRef,method:'session.delete',session:this.metadataView(this.readSession(session.id)!),workspace:finalWorkspace,committedAt:time});
      this.saveManagement(request,receipt);return receipt;
    });
  }

  private sessionWorkspace(workspace: WorkspaceState, sessionId: number | null): WorkspaceState {
    const next: WorkspaceState = {...workspace,sessionId,queryId:null,selection:null,
      activeView:['query','evidence'].includes(workspace.activeView) ? 'data' : workspace.activeView};
    if (this.p3) {
      next.batchRefs = workspace.batchRefs.filter(batch => {
        const row = this.db.query<{snapshot_date:string;scope_key:string;material_version:string},[number]>('SELECT snapshot_date,scope_key,material_version FROM batches WHERE id=?').get(batch.id);
        return row !== null && row.snapshot_date === batch.snapshotDate && row.scope_key === batch.scopeKey && row.material_version === workspace.materialVersion;
      });
      if (next.batchRefs.length === 0) next.materialVersion = null;
      next.deviceIds = workspace.deviceIds.filter(deviceId => next.batchRefs.some(batch => this.db.query('SELECT id FROM snapshots WHERE batch_id=? AND device_id=?').get(batch.id,deviceId)));
      next.selection = this.compatibleSelection(workspace.selection,next);
    }
    return next;
  }

  listSessions(input: { beforeSessionId?: number; limit?: number }): SessionPage {
    const request = checked(ListSessionsRequestSchema, input);
    const rows = this.db.query<{ id: number }, [number, number]>("SELECT id FROM sessions WHERE kind='user' AND status='active' AND id<? ORDER BY id DESC LIMIT ?")
      .all(request.beforeSessionId ?? Number.MAX_SAFE_INTEGER, request.limit + 1), page = rows.slice(0, request.limit);
    return { sessions: page.map(row => this.readSession(row.id)!), nextBeforeSessionId: rows.length > request.limit ? page.at(-1)!.id : null };
  }

  createSession(input: NewSessionInput, operationRef: string, nativeSessionId: string, time: string, initialHistory?:InitialNativeHistory): NewSessionResult {
    const request = checked(NewSessionInputSchema, input); checked(OpaqueIdSchema, operationRef); checked(OpaqueIdSchema, nativeSessionId); timestamp(time);
    return this.transactions.immediate(() => {
      const existing = this.findOperation(operationRef);
      if (existing) {
        if (existing.method !== "session.create" || canonicalRequest(existing.originalRequest) !== canonicalRequest(request)) fail("state_conflict");
        return existing.result;
      }
      const workspace = this.readWorkspace();
      if (workspace.revision !== request.expectedWorkspaceRevision) fail("workspace_revision_mismatch");
      // The omitted history path is retained solely for original-schema fixtures and legacy import compatibility.
      // Product SessionStore callers must provide the authentic newly allocated empty native history.
      let header:unknown;
      if(initialHistory) {
        header=checked(z.object({type:z.literal('session'),version:z.literal(3),id:OpaqueIdSchema,timestamp:TimestampSchema,cwd:z.string(),parentSession:z.string().optional()}).passthrough(),initialHistory.header,'session_history_invalid');
        if((header as {id:string}).id!==nativeSessionId||!Array.isArray(initialHistory.entries)||initialHistory.entries.length||initialHistory.activeLeafId!==null)fail('session_history_invalid');
      }
      const sessionId = (this.db.query<{ n: number | null }, []>("SELECT MAX(id) AS n FROM sessions").get()?.n ?? 0) + 1;
      checked(PositiveIdSchema, sessionId);
      if (workspace.revision === Number.MAX_SAFE_INTEGER) fail('state_conflict');
      const occupiedNumbers = new Set<number>();
      const activeTitles = this.db.query<{id:number;title:string;metadata_json:string},[]>(
        "SELECT id,title,metadata_json FROM sessions WHERE kind='user' AND status='active'").all();
      for (const row of activeTitles) {
        const match = /^New Session ([1-9]\d*)$/.exec(this.sessionTitle(row));
        if (match && Number.isSafeInteger(Number(match[1]))) occupiedNumbers.add(Number(match[1]));
      }
      let displayNumber = 1;
      while (occupiedNumbers.has(displayNumber)) displayNumber++;
      const next = this.sessionWorkspace(workspace,sessionId);
      const result = checked(NewSessionResultSchema, { session: { id: sessionId, title: `New Session ${displayNumber}`, nativeSessionId,
        kind: "user", status: "active", metadataRevision:0, deletedAt:null, inputControl: null, storageVersion: initialHistory?1:0, leafId: null, nextSubmissionSequence: 1 },
        workspace: { ...next, revision: workspace.revision + 1 } });
      if(initialHistory)this.db.query(`INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,metadata_json,created_at,updated_at,native_header_json,history_format_version,storage_version)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,1)`).run(sessionId,nativeSessionId,operationRef,canonicalRequest(request),JSON.stringify(result),result.session.title,'{"titleOrigin":"default"}',time,time,canonicalRequest(header),NATIVE_HISTORY_FORMAT);
      else this.db.query(`INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,metadata_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(sessionId, nativeSessionId, operationRef, canonicalRequest(request), JSON.stringify(result), result.session.title, '{"titleOrigin":"default"}', time, time);
      this.saveWorkspace(workspace,next,time);
      this.beforeCommit?.();
      return result;
    });
  }

  selectSession(input: SelectSessionInput, time: string): WorkspaceView {
    const request = checked(SelectSessionInputSchema, input); timestamp(time);
    return this.transactions.immediate(() => {
      const workspace = this.readWorkspace();
      if (workspace.revision !== request.expectedWorkspaceRevision) fail("workspace_revision_mismatch");
      const session = this.readSession(request.sessionId);
      if (!session) fail("session_not_found");
      this.assertSessionActive(session);
      if (session.kind !== 'user' || session.status !== 'active') fail('access_denied');
      if (workspace.sessionId === request.sessionId) return workspace;
      const selected = this.saveWorkspace(workspace,this.sessionWorkspace(workspace,request.sessionId),time);
      this.beforeCommit?.();
      return selected;
    });
  }

  private submissionResult(row: RunRow): SubmitResult {
    if (row.kind !== "agent" || row.session_id === null || row.submission_client_sequence === null) fail("storage_read_failed");
    return { sessionId: row.session_id, clientSequence: row.submission_client_sequence, inputId: null, runId: row.id };
  }

  findSubmission(input: ReadSubmissionRequest): SubmitResult | null {
    const request = checked(ReadSubmissionRequestSchema, input);
    const inputRow = this.p5 ? this.inputs.sequence(request.sessionId, request.clientSequence) : null;
    if(inputRow){if(this.db.query("SELECT id FROM runs WHERE session_id=? AND submission_client_sequence=?").get(request.sessionId,request.clientSequence))fail("state_conflict");return this.inputs.result(inputRow);}
    const row = this.db.query<RunRow, [number, number]>("SELECT * FROM runs WHERE session_id=? AND submission_client_sequence=?").get(request.sessionId, request.clientSequence);
    if (!row) return null;
    // The saved original request/config are part of the accepted identity, even on a readonly lookup.
    try {
      const original = checked(SubmitInputSchema, JSON.parse(row.submission_request_json!), "storage_read_failed");
      checked(agentConfigSchema, legacyRunConfig(JSON.parse(row.config_json)), "storage_read_failed");
      if (original.sessionId !== row.session_id || original.clientSequence !== row.submission_client_sequence) fail("storage_read_failed");
      return this.submissionResult(row);
    } catch { return fail("storage_read_failed"); }
  }

  readMessageLinks(sessionId: number, nativeEntryIds: readonly string[]): Map<string, { runId: number; toolCallRef: string | null; references: string[] }> {
    id(sessionId);
    checked(z.array(OpaqueIdSchema).max(100), nativeEntryIds);
    const links = new Map<string, { runId: number; toolCallRef: string | null; references: string[] }>();
    if (!nativeEntryIds.length) return links;
    try {
      if (this.db.query("SELECT name FROM sqlite_schema WHERE name='memories'").get()) {
        const messages = this.db.query<{ native_entry_id:string; entry_json:string; run_id:number; owner:number|null; kind:string|null }, [string,number]>(
          `SELECT m.native_entry_id,m.entry_json,m.run_id,r.session_id AS owner,r.kind FROM memories m
           JOIN json_each(?) entry ON entry.value=m.native_entry_id LEFT JOIN runs r ON r.id=m.run_id
           WHERE m.session_id=? AND m.entry_type='message' AND m.run_id IS NOT NULL`).all(JSON.stringify([...new Set(nativeEntryIds)]),sessionId);
        for (const row of messages) {
          checked(PositiveIdSchema,row.run_id,'storage_read_failed');
          const entry=checked(z.object({type:z.literal('message'),id:OpaqueIdSchema,message:z.object({role:z.string()})}),JSON.parse(row.entry_json),'storage_read_failed');
          if(row.owner!==sessionId||!['agent','child'].includes(row.kind??'')||entry.id!==row.native_entry_id) fail('storage_read_failed');
          if(row.kind==='child'&&readFrozenChild(this.db,row.run_id).childSessionId!==sessionId)fail('storage_read_failed');
          if(entry.message.role==='user'||entry.message.role==='assistant') links.set(row.native_entry_id,{runId:row.run_id,toolCallRef:null,references:[`run:${row.run_id}`]});
        }
      }
      // ponytail: Validate O(target Session saved receipts); index further only if large Session reads become slow.
      const receipts = this.db.query<{ id: number; native_tool_call_id: string; tool_name: string; delivery_json: string }, [number]>(
        "SELECT id,native_tool_call_id,tool_name,delivery_json FROM tool_calls WHERE session_id=? AND delivery_json IS NOT NULL").all(sessionId);
      for (const row of receipts) {
        const saved = checked(savedDeliverySchema, legacyToolDelivery(JSON.parse(row.delivery_json)), "storage_read_failed");
        if (saved.sdkReturned && (saved.nativeEntryId === null || saved.deliveredAt === null || !saved.resultRecorded)
          || saved.message && (saved.message.toolCallId !== row.native_tool_call_id || saved.message.toolName !== row.tool_name)) fail("storage_read_failed");
      }
      const rows = this.db.query<{ id: number; run_id: number; native_tool_call_id: string; native_entry_id: string; query_id: number | null }, [string, number]>(
        `SELECT t.id,t.run_id,t.native_tool_call_id,json_extract(t.delivery_json,'$.nativeEntryId') AS native_entry_id,q.id AS query_id
         FROM tool_calls t JOIN runs r ON r.id=t.run_id AND r.session_id=t.session_id AND r.kind IN ('agent','child')
         JOIN json_each(?) entry ON entry.value=json_extract(t.delivery_json,'$.nativeEntryId')
         LEFT JOIN queries q ON q.session_id=t.session_id AND q.run_id=t.run_id AND q.call_ref=CAST(t.run_id AS TEXT)||':'||t.native_tool_call_id AND q.source='agent_tool'
         WHERE t.session_id=? AND json_extract(t.delivery_json,'$.sdkReturned')=1`).all(JSON.stringify([...new Set(nativeEntryIds)]), sessionId);
      const facts = new SqliteToolStore(this.db);
      for (const row of rows) {
        checked(PositiveIdSchema, row.run_id, "storage_read_failed"); checked(PositiveIdSchema, row.id, "storage_read_failed");
        if (links.has(row.native_entry_id)) fail("storage_read_failed");
        const references = [`run:${row.run_id}`, `tool:${row.id}`];
        if (row.query_id !== null) {
          const query = facts.readQuery(row.query_id);
          if (!query || query.sessionId !== sessionId || query.runId !== row.run_id || query.callRef !== `${row.run_id}:${row.native_tool_call_id}`
            || (query.source ?? "agent_tool") !== "agent_tool") fail("storage_read_failed");
          references.push(`query:${query.id}`);
          for (const evidence of facts.listEvidence(query.id)) {
            if (evidence.calculationVersion !== query.calculationVersion) fail("storage_read_failed");
            if (references.length < 16) references.push(`evidence:${evidence.id}`);
          }
        }
        links.set(row.native_entry_id, { runId: row.run_id, toolCallRef: row.native_tool_call_id, references });
      }
      return links;
    } catch { return fail("storage_read_failed"); }
  }

  registerAgent(input: RegisterAgentInput): Extract<SubmitResult,{inputId:null}> {
    if(input.submission === null || input.inputId !== null || input.resources !== undefined) fail("invalid_argument");
    const request = checked(SubmitInputSchema, input.submission.originalSubmitInput), operationRef = checked(OpaqueIdSchema, input.submission.operationRef); timestamp(input.createdAt);
    return this.transactions.immediate(() => {
      const operation = this.findOperation(operationRef), sequence = this.findSubmission({ sessionId: request.sessionId, clientSequence: request.clientSequence });
      if (operation || sequence) {
        if (!operation || operation.method !== "session.submit" || !sequence || operation.result.runId !== sequence.runId
          || canonicalRequest(operation.originalRequest) !== canonicalRequest(request)) fail("state_conflict");
        if(sequence.inputId!==null)fail("state_conflict");return sequence;
      }
      const session = this.readSession(request.sessionId);
      if (!session) fail("session_not_found");
      this.assertSessionActive(session);
      if (request.clientSequence < session.nextSubmissionSequence || request.clientSequence === Number.MAX_SAFE_INTEGER) fail("state_conflict");
      const workspace = this.readWorkspace();
      if (workspace.sessionId !== session.id || workspace.revision !== request.expectedRevision || !isDeepStrictEqual(toWorkspaceContext(workspace), toWorkspaceContext(input.workspace))) fail("workspace_revision_mismatch");
      if (!isDeepStrictEqual(workspace.batchRefs.map(batch => batch.id), request.expectedBatchIds) || workspace.queryId !== request.expectedQueryId) fail("workspace_revision_mismatch");
      if (this.p3) for (const batch of workspace.batchRefs) {
        const row = this.db.query<{ metadata_json: string }, [number]>('SELECT metadata_json FROM batches WHERE id=?').get(batch.id);
        const metadata = checked(z.object({ referenceDate: ReferenceDateSchema, timezone: TimezoneSchema }), decoded(row?.metadata_json ?? null), 'storage_read_failed');
        if (request.timezone !== metadata.timezone) fail('invalid_argument');
      }
      if (this.active()) fail("runtime_busy");
      if (input.sessionId !== session.id || input.inputId !== null || input.goal !== "answer" || input.text !== request.text
        || input.referenceDate !== request.referenceDate || input.timezone !== request.timezone || input.timeoutMs !== input.policy.timeoutMs
        || !isDeepStrictEqual(this.freezeAgentScope(workspace, input.scope.allowedToolNames), input.scope) || input.model.provider !== request.model.provider
        || input.model.modelId !== request.model.modelId || input.model.configVersion !== request.model.expectedConfigVersion) fail("invalid_argument");
      checked(OpaqueIdSchema, input.instanceId);
      if (input.extensions) this.checkedExtensions(input.extensions, session.id, input.model.configVersion);
      const config = checked(agentConfigSchema, { selection: input.model, policy: input.policy, referenceDate: request.referenceDate,
        ...(input.intentAdmission ? { intentAdmission: input.intentAdmission } : {}),
        ...(input.agentPolicy ? { agentPolicy: input.agentPolicy } : {}),
        ...(input.runtimeConfiguration ? { runtimeConfiguration: input.runtimeConfiguration } : {}),
        ...(input.toolConfiguration ? { toolConfiguration: input.toolConfiguration } : {}),
        ...(input.measurementContext ? { measurementContext: input.measurementContext } : {}),
        ...(input.toolProfileSnapshot ? { toolProfileSnapshot: input.toolProfileSnapshot } : {}),
        timezone: request.timezone, agent: { ...input.agentOptions, stage: input.scope.allowedToolNames.length ? "P3" : "P2", nativeSessionId: session.nativeSessionId, tools: input.scope.allowedToolNames,
          autoCompaction: input.agentOptions.compaction?.enabled ?? false, autoRetry: false, cacheWarming: "off", ...(input.extensions?{extensions:input.extensions}:{}), ...(input.contextContract ? {contextContract:input.contextContract} : {}),...(input.historyContract?{historyContract:input.historyContract}:{}) } });
      const result = this.db.query(`INSERT INTO runs(session_id,input_id,kind,instance_id,submission_operation_ref,submission_client_sequence,
        submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at)
        VALUES(?,NULL,'agent',?,?,?,?,'created','answer',?,?,?,?,?,?,?)`)
        .run(session.id, input.instanceId, operationRef, request.clientSequence, canonicalRequest(request), request.text, JSON.stringify(config),
          JSON.stringify(input.scope), JSON.stringify(toWorkspaceContext(workspace)), request.referenceDate, request.timezone, input.createdAt);
      const runId=Number(result.lastInsertRowid);
      this.runLifecycle(this.row(runId)!, 'run_created', input.createdAt);
      this.beforeCommit?.();
      return { sessionId: session.id, clientSequence: request.clientSequence, inputId: null, runId };
    });
  }

  registerChild(input: RegisterChildInput): BoundChildIdentity {
    id(input.parentRunId); id(input.originToolCallId); timestamp(input.createdAt);
    checked(OpaqueIdSchema,input.pluginAgentId); checked(OpaqueIdSchema,input.nativeSessionId);
    if(!this.memory)fail('session_history_invalid');
    return this.transactions.immediate(() => {
      const parent=this.row(input.parentRunId);
      if(!parent||parent.kind!=='agent'||parent.session_id===null)fail('access_denied');
      if(!['created','running'].includes(parent.status)||parent.cancel_requested_at!==null)fail('state_conflict');
      if(this.db.query('SELECT id FROM runs WHERE origin_tool_call_id=?').get(input.originToolCallId))fail('state_conflict');
      if(this.db.query("SELECT id FROM runs WHERE parent_run_id=? AND status IN ('created','running')").get(parent.id))fail('runtime_busy');
      const origin=this.db.query<{native_tool_call_id:string;context_snapshot_id:number;input_id:number|null;args_json:string},[number,number,number]>(`SELECT t.native_tool_call_id,t.context_snapshot_id,s.input_id,t.args_json FROM tool_calls t JOIN context_snapshots s ON s.id=t.context_snapshot_id
        WHERE t.id=? AND t.run_id=? AND t.session_id=? AND t.tool_name='Agent' AND t.status IN ('requested','running') AND s.run_id=t.run_id AND s.session_id=t.session_id`).get(input.originToolCallId,parent.id,parent.session_id);
      const childRunId=(this.db.query<{n:number},[]>('SELECT COALESCE(MAX(id),0)+1 n FROM runs').get()!).n;
      const childSessionId=(this.db.query<{n:number},[]>('SELECT COALESCE(MAX(id),0)+1 n FROM sessions').get()!).n;
      const frozen=checked(FrozenChildConfigSchema,{...input.frozen,childRunId,childSessionId});
      if(!origin||frozen.parentRunId!==parent.id||frozen.parentSessionId!==parent.session_id||frozen.instanceId!==parent.instance_id
        ||frozen.originToolCallId!==input.originToolCallId||frozen.originNativeToolCallId!==origin.native_tool_call_id
        ||frozen.originSnapshotId!==origin.context_snapshot_id||frozen.parentInputId!==origin.input_id
        ||frozen.pluginAgentId!==input.pluginAgentId||frozen.nativeSessionId!==input.nativeSessionId
        ||JSON.parse(origin.args_json).prompt!==input.prompt
        ||!isDeepStrictEqual(frozen.model,this.config(parent).selection)||!isDeepStrictEqual(frozen.policy,this.config(parent).policy)
        ||!childScopeWithin(frozen.scope,checked(RunScopeSchema,legacyRunScope(decoded(parent.scope_json)),'storage_read_failed')))fail('access_denied');
      const header=checked(z.object({type:z.literal('session'),version:z.literal(3),id:OpaqueIdSchema,timestamp:TimestampSchema,cwd:z.string()}).passthrough(),input.initialHistory.header,'session_history_invalid');
      if(header.id!==input.nativeSessionId||!Array.isArray(input.initialHistory.entries)
        ||input.initialHistory.entries.some(entry=>!entry||typeof entry!=='object'||Reflect.get(entry,'type')==='message'))fail('session_history_invalid');
      const creation={contract:'medclaw.child-creation/v1',parentRunId:parent.id,originToolCallId:input.originToolCallId,pluginAgentId:input.pluginAgentId};
      this.db.query(`INSERT INTO sessions(id,native_session_id,kind,creation_operation_ref,creation_request_json,creation_result_json,title,storage_version,native_header_json,history_format_version,created_at,updated_at)
        VALUES(?,?,'child',?,?,NULL,'Subagent',1,?,?,?,?)`).run(childSessionId,input.nativeSessionId,`internal-child:${input.originToolCallId}`,canonicalRequest(creation),canonicalRequest(header),NATIVE_HISTORY_FORMAT,input.createdAt,input.createdAt);
      this.db.query(`INSERT INTO runs(id,session_id,kind,parent_run_id,origin_tool_call_id,instance_id,status,goal,input_text,config_json,scope_json,reference_date,timezone,created_at)
        VALUES(?,?,'child',?,?,?,'created','answer',?,?,?,?,?,?)`).run(childRunId,childSessionId,parent.id,input.originToolCallId,parent.instance_id,input.prompt,
          canonicalRequest({selection:frozen.model,policy:frozen.policy,subagent:frozen}),canonicalRequest(frozen.scope),parent.reference_date,parent.timezone,input.createdAt);
      this.memory!.initializeChildInTransaction(childSessionId,childRunId,input.initialHistory);
      this.runLifecycle(this.row(childRunId)!,'run_created',input.createdAt);
      this.beforeCommit?.();
      return this.readChildIdentity(childRunId)!;
    });
  }

  findChild(parentRunId:number,originToolCallId:number,expected?:RegisterChildInput):BoundChildIdentity|null {
    id(parentRunId);id(originToolCallId);
    return this.inputRead(()=>this.db.transaction(()=>{
    const row=this.db.query<{id:number},[number,number]>("SELECT id FROM runs WHERE kind='child' AND parent_run_id=? AND origin_tool_call_id=?").get(parentRunId,originToolCallId);
    if(!row)return null;
    const identity=this.readChildIdentity(row.id)!;
    if(expected) {
      const stored=this.row(row.id)!,frozen=readFrozenChild(this.db,row.id),initial=this.memory?.loadInTransaction(identity.childSessionId);
      if(canonicalRequest(frozen)!==canonicalRequest({...expected.frozen,childRunId:identity.childRunId,childSessionId:identity.childSessionId})||stored.input_text!==expected.prompt
        ||!initial||initial.storageVersion!==1||canonicalRequest(initial.header)!==canonicalRequest(expected.initialHistory.header)||canonicalRequest(initial.entries)!==canonicalRequest(expected.initialHistory.entries)||initial.activeLeafId!==expected.initialHistory.activeLeafId)fail('storage_read_failed');
    }
    return identity;
    }).deferred());
  }
  readChildHistoryBase(runId:number):{storageVersion:number;leafId:string|null} {
    id(runId);const frozen=readFrozenChild(this.db,runId);
    const row=this.db.query<{storage_version:number;current_leaf_id:string|null},[number]>('SELECT storage_version,current_leaf_id FROM sessions WHERE id=?').get(frozen.childSessionId);
    if(!row)fail('storage_read_failed');return {storageVersion:row.storage_version,leafId:row.current_leaf_id};
  }

  findCommittedChild(context:ToolExecutionContext):CommittedChildExecutionProof|null {
    return this.inputRead(()=>this.db.transaction(()=>{
      const parent=this.row(context.runId);
      if(!parent||parent.kind!=='agent'||parent.session_id!==context.sessionId||context.delegationSource)fail('access_denied');
      const origin=this.db.query<{id:number;tool_name:string},[number,number,string]>('SELECT id,tool_name FROM tool_calls WHERE run_id=? AND session_id=? AND native_tool_call_id=?').get(context.runId,context.sessionId,context.nativeToolCallId);
      if(!origin||origin.tool_name!=='Agent')return null;
      const row=this.db.query<RunRow,[number,number]>("SELECT * FROM runs WHERE kind='child' AND parent_run_id=? AND origin_tool_call_id=?").get(context.runId,origin.id);
      if(!row||row.status!=='completed'||!row.child_result_json)return null;
      const frozen=readFrozenChild(this.db,row.id),result=checked(ChildResultSchema,legacyChildResult(decoded(row.child_result_json)),'storage_read_failed');
      const cleanup=checked(RunCleanupRecordSchema,decoded(row.cleanup_json),'storage_read_failed');
      const history=this.memory?.loadInTransaction(frozen.childSessionId);
      if(!history||cleanup.stopConfirmed!==true||cleanup.requiredPersistenceComplete!==true
        ||result.childRunId!==row.id||result.parentRunId!==context.runId||result.originToolCallId!==origin.id
        ||history.storageVersion!==result.storageVersion||history.activeLeafId!==result.finalLeafId||checked(z.object({id:OpaqueIdSchema}),history.header,'storage_read_failed').id!==result.nativeSessionId
        ||!verifyPriorContextFacts(this.db,row.id).requiredPersistenceComplete)fail('storage_read_failed');
      return {parentRunId:context.runId,originToolCallId:origin.id,childRunId:row.id,childOutcome:'completed' as const,originalReply:result.originalReply,
        finalLeafId:result.finalLeafId,storageVersion:result.storageVersion};
    }).deferred());
  }

  registerProvider(input: RegisterProviderInput): ProviderAccepted {
    const originalRequest = input.method === "model.request" ? checked(ProviderRequestSchema, input.originalRequest) : checked(DiagnoseRequestSchema, input.originalRequest);
    if (!input.operationRef || input.operationRef.length > 512) fail("invalid_argument");
    return this.transactions.immediate(() => {
      const operation = this.findOperation(input.operationRef);
      if (operation && operation.method !== input.method) fail("state_conflict");
      const existing = this.findProviderOperation(input.operationRef);
      if (existing) {
        if (existing.method !== input.method || !isDeepStrictEqual(
          decoded(JSON.stringify(existing.originalRequest)), decoded(JSON.stringify(originalRequest)),
        )) fail("state_conflict");
        return { runId: existing.runId, operationRef: input.operationRef, reused: true };
      }
      if (this.active()) fail("runtime_busy");
      timestamp(input.createdAt);
      if (!input.instanceId || input.instanceId.length > 512 || input.referenceDate !== originalRequest.referenceDate ||
          input.timezone !== originalRequest.timezone || input.priorRunId !== originalRequest.priorRunId ||
          input.goal !== (input.method === "model.request" ? "answer" : "verify") ||
          input.inputText !== (input.method === "model.request" ? (originalRequest as ProviderRequest).text : "请仅回复 OK。")) fail("invalid_argument");
      if (input.priorRunId !== undefined) { id(input.priorRunId); if (!this.row(input.priorRunId)) fail("invalid_argument"); }
      const config = checked(providerConfigSchema, { providerRequest: { operationRef: input.operationRef, method: input.method, originalRequest }, selection: input.selection, policy: input.policy,
        ...(input.runtimeConfiguration ? { runtimeConfiguration: input.runtimeConfiguration } : {}) });
      const result = this.db.query(`INSERT INTO runs(
        session_id,input_id,kind,prior_run_id,instance_id,status,goal,input_text,output_text,config_json,
        scope_json,workspace_json,reference_date,timezone,error_json,created_at,started_at,
        cancel_requested_at,stopped_at,ended_at,cleanup_json,usage_json
      ) VALUES(NULL,NULL,'provider',?,?,'created',?,?,NULL,?,?,NULL,?,?,NULL,?,NULL,NULL,NULL,NULL,NULL,NULL)`)
        .run(input.priorRunId ?? null, input.instanceId, input.goal, input.inputText, JSON.stringify(config), JSON.stringify(scope), input.referenceDate, input.timezone, input.createdAt);
      this.beforeCommit?.();
      return { runId: Number(result.lastInsertRowid), operationRef: input.operationRef, reused: false };
    });
  }

  startIntentRun(runId:number,at:string):void {
    id(runId);timestamp(at);
    this.transactions.immediate(()=>{
      const row=this.row(runId);
      const request=row?.input_id?this.inputs.content(this.inputs.required(row.input_id)).originalSubmitInput:null;
      if(!row||row.kind!=='agent'||row.parent_run_id!==null||row.cancel_requested_at!==null||!['created','running'].includes(row.status)
        ||!checked(agentConfigSchema,legacyRunConfig(decoded(row.config_json))).intentAdmission
          &&!(request?.mode==='send'&&request.routing?.mode==='user_form'))fail('state_conflict');
      if(row.status==='running')return;
      if(this.db.query("UPDATE runs SET status='running',started_at=? WHERE id=? AND status='created' AND cancel_requested_at IS NULL").run(at,runId).changes!==1)fail('state_conflict');
      this.runLifecycle(row,'run_started',at);
    });
  }
  startCall(runId: number, callId: string, kind: "main" | "diagnostic", time: string, context?: StartCallContext): void {
    id(runId); timestamp(time);
    if (!callId || callId.length > 512) fail("invalid_argument");
    this.transactions.immediate(() => {
      const row = this.row(runId);
      if (!row || row.status !== "created" && !(['agent','child'].includes(row.kind) && row.status === "running")) fail("state_conflict");
      if (row.kind === "provider" && this.calls(runId).length) fail("state_conflict");
      if (kind !== (row.goal === "verify" ? "diagnostic" : "main")) fail("invalid_argument");
      const requiresContext = row.kind==='child' || row.kind === 'agent' && checked(agentConfigSchema,legacyRunConfig(decoded(row.config_json)),'storage_read_failed').agent.contextContract === 'medclaw.context/v1';
      if (requiresContext && !context || context && (!['agent','child'].includes(row.kind) || kind !== 'main')) fail('state_conflict');
      if (context) {
        const snapshot=this.db.query<{snapshot_json:string},[number,number,number|null,number|null]>('SELECT snapshot_json FROM context_snapshots WHERE id=? AND run_id=? AND session_id=? AND input_id IS ?').get(context.snapshotId,runId,row.session_id,context.inputId);
        if(!snapshot)fail('access_denied');
        const body=checked(ContextSnapshotBodySchema,legacyContextBody(decoded(snapshot.snapshot_json)),'storage_read_failed');
        if(row.kind==='child') {
          const frozen=readFrozenChild(this.db,runId);
          if(context.inputId!==null||!isDeepStrictEqual(context.delegationSource,body.delegationSource)
            ||context.delegationSource.parentRunId!==frozen.parentRunId||context.delegationSource.originToolCallId!==frozen.originToolCallId
            ||context.delegationSource.parentSnapshotId!==frozen.originSnapshotId)fail('access_denied');
        } else if(context.inputId===null||body.delegationSource)fail('access_denied');
      }
      if (row.status === "created") {
        const changed = this.db.query("UPDATE runs SET status='running',started_at=? WHERE id=? AND status='created'").run(time, runId);
        if (changed.changes !== 1) fail("state_conflict");
        this.runLifecycle(row,'run_started',time);
      }
      this.db.query(`INSERT INTO model_calls(call_id,run_id,session_id,input_id,kind,attempt,granularity,
        attempt_count_unknown,model_json,state,started_at,ended_at,duration_ms,input_tokens,output_tokens,
        cost,cost_currency,usage_source,unavailable_reason,error_json)
        VALUES(?,?,?,?,?,1,'logical_request',1,?,'started',?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`)
        .run(callId, runId, row.session_id, context?.inputId ?? row.input_id, kind, JSON.stringify({ selection: this.config(row).selection, responseModel: null, sdkStopReason: null, ...(context ? {context:checked(ModelCallContextSchema,{contract:'medclaw.context-call/v1',...context,observation:null,responseStatus:null,payloadVerified:null})} : {}) }), time);
      this.beforeCommit?.();
    });
  }

  recordProviderRequest(callId:string,payload:unknown,observedAt:string):void {
    const body=JSON.stringify(payload);if(typeof body!=='string')fail('invalid_argument');
    this.transactions.immediate(()=>{
      const row=this.db.query<{model_json:string;session_id:number|null;run_id:number|null;instance_id:string|null;state:string},[string]>(`SELECT c.model_json,c.session_id,c.run_id,c.state,r.instance_id FROM model_calls c LEFT JOIN runs r ON r.id=c.run_id WHERE c.call_id=?`).get(callId);
      if(!row||row.state!=='started')fail('state_conflict');
      const model=JSON.parse(row.model_json),originals=(model.requestOriginals??[]) as unknown[];
      const instanceId=this.evidenceInstanceId??row.instance_id;
      // Legacy non-Host fixtures cannot attest a manual operation's Host identity.
      if(!instanceId&&row.run_id===null)return;
      if(!instanceId||row.instance_id&&row.instance_id!==instanceId)fail('access_denied');
      originals.push(ProviderRequestOriginalSchema.parse({instanceId,sessionId:row.session_id,runId:row.run_id,callId,observedAt,boundary:'sdk_onPayload',sequence:originals.length+1,
        body,bytes:Buffer.byteLength(body)}));
      this.db.query('UPDATE model_calls SET model_json=? WHERE call_id=?').run(JSON.stringify({...model,requestOriginals:originals}),callId);
    });
  }

  requestCancel(runId: number, time: string): boolean {
    id(runId); timestamp(time);
    return this.transactions.immediate(() => {
      const row=this.row(runId);if (!row) fail("state_conflict");
      const result = this.db.query(`UPDATE runs SET cancel_requested_at=COALESCE(cancel_requested_at,?)
        WHERE id=? AND status IN ('created','running')`).run(time, runId);
      if (result.changes) {
        if(row.cancel_requested_at===null)this.event(row,{type:'run_cancel_requested',payload:{contract:'medclaw.event/v1',reason:'run_cancelled'}},time);
        this.beforeCommit?.();
      }
      return result.changes > 0;
    });
  }

  finalizeProvider(runId: number, fact: FinalProviderFact): RunView {
    return this.finalize(runId, fact, fact.call ? [fact.call] : [], "provider");
  }
  finalizeAgent(runId: number, fact: FinalAgentFact): RunView {
    return this.finalize(runId, fact, fact.calls, "agent");
  }
  childResultReferences(runId:number):Pick<ChildResult,'queryRefs'|'evidenceIds'|'gaps'> {
    id(runId);const child=readFrozenChild(this.db,runId);
    const queries=this.db.query<{id:number},[number,number]>('SELECT id FROM queries WHERE run_id=? AND session_id=? ORDER BY id').all(runId,child.childSessionId);
    const evidence=this.db.query<{id:number},[number,number]>('SELECT e.id FROM query_evidence e JOIN queries q ON q.id=e.query_id WHERE q.run_id=? AND q.session_id=? ORDER BY e.id').all(runId,child.childSessionId);
    const refs=new Set(queries.map(row=>row.id)),evidenceIds=new Set(evidence.map(row=>row.id)),store=new SqliteToolStore(this.db);
    const reads=this.db.query<{tool_name:string;args_json:string;result_json:string},[number,number]>(`SELECT tool_name,args_json,result_json FROM tool_calls WHERE run_id=? AND session_id=? AND status='succeeded'
      AND tool_name IN ('read_query','read_query_page','list_query_evidence','read_query_evidence','read_evidence_rows','read_source_metadata')`).all(runId,child.childSessionId);
    for(const read of reads){
      const name=read.tool_name as 'read_query'|'read_query_page'|'list_query_evidence'|'read_query_evidence'|'read_evidence_rows'|'read_source_metadata',schemas=businessToolSchemas[name];
      const args=checked(schemas.input as z.ZodType<Record<string,number>>,decoded(read.args_json),'storage_read_failed');
      const data=checked(schemas.output as z.ZodType<unknown>,legacyBusinessToolOutput(name,decoded(read.result_json)),'storage_read_failed') as {queryId?:number;items?:{id?:number;queryId?:number}[]};
      const readEvidence=args.evidenceId?store.readEvidence(args.evidenceId):null,queryId=args.queryId??readEvidence?.queryId,query=queryId?store.readQuery(queryId):null;
      if(!query||!canReadRelatedQuery(this.db,runId,child.childSessionId,query)||query.batchIds.some(batch=>!child.scope.batchIds.includes(batch))
        ||child.scope.deviceIds!==null&&(query.scopeDeviceIds===null||query.scopeDeviceIds.some(device=>!child.scope.deviceIds!.includes(device))))fail('storage_read_failed');
      if(data.queryId!==undefined&&data.queryId!==query.id
        ||name==='list_query_evidence'&&data.items?.some(item=>item.queryId!==query.id))fail('storage_read_failed');
      refs.add(query.id);
      for(const evidenceId of readEvidence?[readEvidence.id]:name==='list_query_evidence'?data.items!.map(item=>item.id!):[]){
        const item=store.readEvidence(evidenceId);
        if(!item||item.queryId!==query.id||item.batchIds.some(batch=>!child.scope.batchIds.includes(batch)))fail('storage_read_failed');
        evidenceIds.add(evidenceId);
      }
    }
    const failed=this.db.query<{native_tool_call_id:string},[number,number]>("SELECT native_tool_call_id FROM tool_calls WHERE run_id=? AND session_id=? AND status IN ('failed','cancelled') ORDER BY id").all(runId,child.childSessionId);
    const receipts=this.db.query<{tool_call_id:string},[number,number]>("SELECT json_extract(entry_json,'$.message.toolCallId') AS tool_call_id FROM memories WHERE run_id=? AND session_id=? AND entry_type='message' AND json_extract(entry_json,'$.message.role')='toolResult' AND json_extract(entry_json,'$.message.isError')=1 ORDER BY sequence").all(runId,child.childSessionId);
    return {queryRefs:[...refs].sort((a,b)=>a-b).map(queryId=>({queryId})),evidenceIds:[...evidenceIds].sort((a,b)=>a-b),
      gaps:[...new Set([...failed.map(row=>row.native_tool_call_id),...receipts.map(row=>row.tool_call_id)].map(id=>'tool_result_error:'+id))]};
  }
  private childFinalEnvelope(runId:number,fact:FinalChildFact):FinalAgentFact & {childResult:ChildResult} {
    const row=this.row(runId);if(!row||row.kind!=='child')fail('access_denied');
    return {...fact,stoppedAt:fact.cleanup.executionStarted===false?null:fact.endedAt,
      cancelRequestedAt:fact.status==='cancelled'?row.cancel_requested_at??fact.endedAt:row.cancel_requested_at};
  }
  finalizeChild(runId:number,fact:FinalChildFact) {
    const result=this.finalize(runId,this.childFinalEnvelope(runId,fact),fact.calls,'child');
    if(result.kind!=='child')fail('state_conflict');return result;
  }
  isChildFinalSaved(runId:number,fact:FinalChildFact):boolean {return this.isFinalSaved(runId,this.childFinalEnvelope(runId,fact));}
  confirmHistorySaved(change:NativeHistoryCommit) {if(!this.memory)fail('storage_read_failed');return this.memory.confirmCommitted(change);}
  private answerReferences(row:RunRow, requireAvailable:boolean, explicitIds?:number[]):number[] {
    try {
      const store=new SqliteToolStore(this.db),sources=new HistorySourceStore(this.db),catalog=new SqliteCatalogStore(this.db),scope=checked(RunScopeSchema,legacyRunScope(decoded(row.scope_json)));
      const ids=new Set(explicitIds??this.db.query<{id:number},[number]>('SELECT id FROM queries WHERE run_id=?').all(row.id).map(value=>value.id));
      for(const input of explicitIds?[]:this.inputsForRun(row.id))if(input.status==='consumed'&&input.runId===row.id&&input.sessionId===row.session_id&&input.nativeEntryId){
        const frozen=this.inputs.content(this.inputs.required(input.id)).workspaceContext;
        if(frozen.queryId!==null)ids.add(frozen.queryId);
      }
      const explicitReads=new Set<number>();
      const reads=this.db.query<{tool_name:string;args_json:string;result_json:string;delivery_json:string;native_tool_call_id:string},[number,number]>(`SELECT * FROM tool_calls WHERE run_id=? AND session_id=? AND status='succeeded'
        AND tool_name IN ('read_query','read_query_page','list_query_evidence','read_query_evidence')`).all(row.id,row.session_id!);
      for(const read of explicitIds?[]:reads){
        const name=read.tool_name as 'read_query'|'read_query_page'|'list_query_evidence'|'read_query_evidence',schemas=businessToolSchemas[name];
        const args=checked(schemas.input as z.ZodType<Record<string,number>>,decoded(read.args_json));
        const data=checked(schemas.output as z.ZodType<unknown>,legacyBusinessToolOutput(name,decoded(read.result_json))) as {queryId?:number;items?:{queryId:number}[]};
        const delivery=checked(savedDeliverySchema,legacyToolDelivery(decoded(read.delivery_json)));
        // A successful tool row alone does not prove that this model consumed its result.
        if(!delivery.sdkReturned||!delivery.nativeEntryId||!delivery.nextModelCallId||!delivery.consumedAt||delivery.consumptionEvidence!=='provider_input_verified')continue;
        if(!delivery.message||delivery.message.isError||delivery.message.toolCallId!==read.native_tool_call_id||delivery.message.toolName!==name
          ||!isDeepStrictEqual(legacyBusinessToolOutput(name,delivery.message.details),data))fail('answer_evidence_invalid');
        const entry=this.db.query<{entry_json:string},[number,string,number]>("SELECT entry_json FROM memories WHERE session_id=? AND native_entry_id=? AND run_id=? AND entry_type='message'").get(row.session_id!,delivery.nativeEntryId,row.id);
        if(!entry||!isDeepStrictEqual((decoded(entry.entry_json) as {message:unknown}).message,delivery.message)
          ||!this.db.query('SELECT id FROM model_calls WHERE run_id=? AND session_id=? AND call_id=?').get(row.id,row.session_id,delivery.nextModelCallId))fail('answer_evidence_invalid');
        const queryId=name==='read_query_evidence'?store.readEvidence(args.evidenceId!)?.queryId:args.queryId;
        if(!queryId||data.queryId!==undefined&&data.queryId!==queryId||data.items?.some(item=>item.queryId!==queryId))fail('answer_evidence_invalid');
        const query=store.readQuery(queryId);
        if(!query)fail('answer_evidence_invalid');
        ids.add(queryId);explicitReads.add(queryId);
      }
      for(const id of ids){
        const query=store.readQuery(id),view=sources.query(id,1,1);
        const source=this.db.query<{source:string},[number]>('SELECT source FROM queries WHERE id=?').get(id);
        if(!query||query.sessionId!==row.session_id&&(!explicitReads.has(id)||!canReadRelatedQuery(this.db,row.id,row.session_id!,query))||query.batchIds.some(batch=>!scope.batchIds.includes(batch))
          ||(query.source??'agent_tool')!==source?.source
          ||scope.deviceIds!==null&&(query.scopeDeviceIds===null||query.scopeDeviceIds.some(device=>!scope.deviceIds!.includes(device)))
          ||requireAvailable&&view.query.sourceAvailability!=='available')fail('answer_evidence_invalid');
        const batches=catalog.readBatches(query.batchIds),references=requireAvailable?catalog.readSnapshotReferences(query.snapshotIds):[],events=requireAvailable&&query.eventIds.length?catalog.readChanges(query.batchIds,query.batchIds,query.scopeDeviceIds):[];
        if(batches.length!==new Set(query.batchIds).size||requireAvailable&&(references.length!==new Set(query.snapshotIds).size
          ||references.some(ref=>!query.batchIds.includes(ref.batchId)||query.scopeDeviceIds!==null&&!query.scopeDeviceIds.includes(ref.deviceId))
          ||query.eventIds.some(id=>!events.some(event=>event.id===id&&query.batchIds.includes(event.oldBatchId)&&query.batchIds.includes(event.newBatchId)))))fail('answer_evidence_invalid');
        const evidenceRows=store.listEvidence(id);
        for(const evidence of evidenceRows){
          if(evidence.calculationVersion!==query.calculationVersion
            ||evidence.snapshotIds.some(value=>!query.snapshotIds.includes(value))||evidence.eventIds.some(value=>!query.eventIds.includes(value))
            ||evidence.filters!==undefined&&!isDeepStrictEqual(evidence.filters,query.params)
            ||evidence.batchIds.some(id=>!batches.some(batch=>batch.id===id&&batch.sourceBundleId===evidence.sourceBundleId&&batch.materialVersion===evidence.materialVersion))
            ||requireAvailable&&!isDeepStrictEqual([...new Set(evidence.sourceRowRefs)].sort(),[...new Set(references.filter(ref=>evidence.snapshotIds.includes(ref.id)).map(ref=>ref.sourceRowRef))].sort()))fail('answer_evidence_invalid');
          const proof=sources.evidence(id,evidence.id,1,1);
          if(requireAvailable&&proof.sourceAvailability!=='available')fail('answer_evidence_invalid');
        }
        if(query.batchIds.some(id=>!evidenceRows.some(value=>value.batchIds.includes(id)))||query.snapshotIds.some(id=>!evidenceRows.some(value=>value.snapshotIds.includes(id)))||query.eventIds.some(id=>!evidenceRows.some(value=>value.eventIds.includes(id))))fail('answer_evidence_invalid');
      }
      return [...ids].sort((a,b)=>a-b);
    }catch{throw safeError('answer_evidence_invalid',undefined,{runId:row.id,sessionId:row.session_id??undefined});}
  }
  private validateFinalAnswer(row:RunRow,fact:Pick<FinalAgentFact,'history'|'outputText'>):void {
    const history=fact.history!;
    type Entry={id:string;parentId:string|null;type:string;message?:{role:string;content:{type:string;text?:string}[];stopReason?:string}};
    const assistant=(history.newEntries as Entry[]).findLast(entry=>entry.type==='message');
    if(!assistant||assistant.message?.role!=='assistant'||!['stop','length'].includes(assistant.message.stopReason??'')
      ||assistant.message.content.some(part=>part.type==='toolCall')||assistant.message.content.filter(part=>part.type==='text').map(part=>part.text).join('')!==fact.outputText||history.activeLeafId===null)fail('session_history_invalid');
    const path=new Set<string>();let leaf:string|null=history.activeLeafId;
    while(leaf!==null){if(path.has(leaf))fail('session_history_invalid');path.add(leaf);const entry=this.db.query<{parent_entry_id:string|null},[number,string]>('SELECT parent_entry_id FROM memories WHERE session_id=? AND native_entry_id=?').get(row.session_id!,leaf);if(!entry)fail('session_history_invalid');leaf=entry.parent_entry_id;}
    if(!path.has(assistant.id)||!this.db.query('SELECT id FROM memories WHERE session_id=? AND native_entry_id=? AND run_id=?').get(row.session_id,assistant.id,row.id))fail('session_history_invalid');
    if(row.input_id!==null){const input=this.inputs.required(row.input_id);if(input.status!=='consumed'||input.run_id!==row.id||input.session_id!==row.session_id||!input.native_entry_id||!path.has(input.native_entry_id)
      ||!this.db.query("SELECT id FROM memories WHERE session_id=? AND native_entry_id=? AND run_id=? AND entry_type='message' AND json_extract(entry_json,'$.message.role')='user'").get(row.session_id,input.native_entry_id,row.id))fail('session_history_invalid');}
  }
  private validateProgramFailure(row:RunRow,fact:FinalAgentFact) {
    if(!['program','user_form'].includes(fact.resultSource??'pi')||fact.status==='completed'||fact.outputText!==null||fact.history||fact.productTurn||fact.inputSettlement
      ||fact.calls.length||fact.compactions?.length||row.input_id===null||row.session_id===null)fail('state_conflict');
    const settlement=checked(ProductSettlementSchema,fact.productSettlement),cleanup=checked(RunCleanupRecordSchema,fact.cleanup);
    if(settlement.runId!==row.id||settlement.sessionId!==row.session_id||settlement.inputId!==row.input_id||settlement.nativeUserEntryId!==null
      ||cleanup.executionStarted!==false||cleanup.stopConfirmed!==true||cleanup.requiredPersistenceComplete!==true
      ||cleanup.inputsSettled!==true||cleanup.resourcesReleased!==true||cleanup.unconfirmedItems.length)fail('state_conflict');
    const content=this.inputs.content(this.inputs.required(row.input_id)),configuration=checked(agentConfigSchema,legacyRunConfig(decoded(row.config_json)));
    const request=content.originalSubmitInput,form=fact.resultSource==='user_form';
    if(form?(request.mode!=='send'||request.routing?.mode!=='user_form'||!!content.intentAdmission||!!configuration.intentAdmission)
      :!content.intentAdmission||!isDeepStrictEqual(content.intentAdmission,configuration.intentAdmission))fail('state_conflict');
    if(form&&this.db.query('SELECT id FROM model_calls WHERE run_id=?').get(row.id)
      ||this.db.query('SELECT id FROM memories WHERE run_id=?').get(row.id)||this.db.query('SELECT id FROM answers WHERE run_id=?').get(row.id)
      ||this.db.query("SELECT id FROM model_calls WHERE run_id=? AND kind!='intent'").get(row.id))fail('state_conflict');
  }
  private validateAgentIntentFinal(row:RunRow,fact:FinalAgentFact,requireAvailable:boolean) {
    const config=checked(agentConfigSchema,legacyRunConfig(decoded(row.config_json)));
    if(!config.intentAdmission){if(fact.productTurn)fail('state_conflict');return null;}
    const decision=this.intents?.readIntentFacts({runId:row.id})?.decision,turn=fact.productTurn,history=fact.history;
    if(!decision||decision.route!=='agent'||decision.status!=='RESOLVED'||!turn||!history||row.input_id===null||row.session_id===null
      ||turn.userEntryId!==null||turn.resultEntryId!==null||!isDeepStrictEqual(turn.history,history))fail('session_history_invalid');
    const path=new Set<string>();let leaf=history.activeLeafId;
    while(leaf!==null){if(path.has(leaf))fail('session_history_invalid');path.add(leaf);
      const entry=this.db.query<{parent_entry_id:string|null},[number,string]>('SELECT parent_entry_id FROM memories WHERE session_id=? AND native_entry_id=?').get(row.session_id,leaf);
      if(!entry)fail('session_history_invalid');leaf=entry.parent_entry_id;}
    const read=(id:string)=>{
      const incoming=history.newEntries.find(value=>(value as {id?:string}).id===id);
      const saved=this.db.query<{entry_json:string},[number,number,string]>('SELECT entry_json FROM memories WHERE session_id=? AND run_id=? AND native_entry_id=?').get(row.session_id!,row.id,id);
      if(!path.has(id)||!incoming||!saved||canonicalRequest(incoming)!==saved.entry_json)fail('session_history_invalid');
      return decoded(saved.entry_json) as {id:string;parentId:string|null;type:string;customType?:string;data?:unknown};
    };
    const entry=read(turn.executionEntryId),assistant=history.newEntries.findLast(value=>(value as {type?:string}).type==='message') as {id:string}|undefined;
    if(entry.type!=='custom'||entry.customType!=='medclaw-intent-execution'||entry.parentId!==assistant?.id
      ||history.activeLeafId!==(turn.conditionEntryId??turn.executionEntryId))fail('session_history_invalid');
    const execution=checked(IntentExecutionFactSchema,legacyIntentExecution(entry.data));
    if(execution.decisionId!==decision.id||!isDeepStrictEqual(execution.taskIntents,decision.adoptedIntents)
      ||execution.stepResults.length!==execution.taskIntents.length)fail('answer_evidence_invalid');
    const content=this.inputs.content(this.inputs.required(row.input_id)),scope=checked(RunScopeSchema,legacyRunScope(decoded(row.scope_json))),store=new SqliteToolStore(this.db);
    const readTool=(nativeToolCallId:string,stepId:string)=>{
      const origin=this.db.query<{context_snapshot_id:number;call_id:string;input_id:number},[number,string]>(`SELECT t.context_snapshot_id,c.call_id,s.input_id FROM tool_calls t JOIN model_calls c ON c.id=t.model_call_id JOIN context_snapshots s ON s.id=t.context_snapshot_id WHERE t.run_id=? AND t.native_tool_call_id=?`).get(row.id,nativeToolCallId);
      if(!origin)fail('answer_evidence_invalid');
      const toolContent=this.inputs.content(this.inputs.required(origin.input_id));
      const tool=store.readCall({runId:row.id,sessionId:row.session_id!,nativeToolCallId,scope,referenceDate:row.reference_date,timezone:row.timezone,
        signal:new AbortController().signal,contextSnapshotId:origin.context_snapshot_id,modelCallId:origin.call_id,workspaceInputId:origin.input_id,workspaceContext:toolContent.workspaceContext,
        basedOnQueryId:toolContent.workspaceContext.queryId,workspaceRevision:toolContent.workspaceContext.revision});
      const args=IntentQueryStepInputSchema.safeParse(tool?.input);
      if(!tool||tool.name!=='query_intent_step'||tool.status!=='succeeded'||!tool.sdkReturned||!tool.nativeEntryId||!path.has(tool.nativeEntryId)
        ||tool.sdkDelivery?.isError!==false||tool.consumptionEvidence!=='provider_input_verified'||!args.success||args.data.stepId!==stepId)fail('answer_evidence_invalid');
      return {tool,args:args.data};
    };
    const queryIds:number[]=[];
    for(const step of execution.stepResults){
      const task=execution.taskIntents.find(value=>value.id===step.stepId)!;
      if(task.l2==='FRESHNESS'){
        if(step.queryRefs.length||task.parameters.basis!=='snapshot_date')fail('answer_evidence_invalid');
        const call=this.db.query<{native_tool_call_id:string},[number,string]>("SELECT native_tool_call_id FROM tool_calls WHERE run_id=? AND tool_name='query_intent_step' AND status='succeeded' AND json_extract(args_json,'$.stepId')=? ORDER BY id DESC LIMIT 1").get(row.id,task.id);
        if(!call)fail('answer_evidence_invalid');
        const {tool,args}=readTool(call.native_tool_call_id,step.stepId),metadata=checked(IntentStepMetadataSchema,legacyIntentMetadata(tool.data));
        if(args.part!==0||metadata.stepId!==step.stepId||metadata.batches.some(batch=>!content.workspaceContext.batchRefs.some(ref=>ref.id===batch.id)))fail('answer_evidence_invalid');
        if(requireAvailable&&!isDeepStrictEqual(metadata.batches,new SqliteCatalogStore(this.db).readBatches(scope.batchIds).filter(batch=>task.slots.region===null||batch.region===task.slots.region)))fail('answer_evidence_invalid');
        continue;
      }
      const expectedParts=task.l2==='COMPANY_COMPARE'?task.parameters.manufacturers.length:task.l2==='PRODUCT_COMPARE'?task.parameters.devices.length:task.l2==='PERIOD_COMPARE'?task.parameters.periods.length:1;
      if(step.queryRefs.length!==expectedParts)fail('answer_evidence_invalid');
      const parts=new Set<number>();
      for(const ref of step.queryRefs){
        const query=store.readQuery(ref.queryId);
        if(!query||queryIds.includes(ref.queryId)||query.runId!==row.id||query.sessionId!==row.session_id||query.inputId!==row.input_id
          ||query.source!=='agent_tool'||!query.callRef.startsWith(`${row.id}:`))fail('answer_evidence_invalid');
        const nativeToolCallId=query.callRef.slice(String(row.id).length+1);
        const {tool,args}=readTool(nativeToolCallId,step.stepId),data=tool.data as {id?:number}|null;
        if(args.part>=expectedParts||parts.has(args.part)||data?.id!==query.id)fail('answer_evidence_invalid');
        parts.add(args.part);queryIds.push(query.id);
      }
    }
    this.answerReferences(row,requireAvailable,queryIds);
    const adopted=turn.conditionEntryId===null?null:(()=>{const condition=read(turn.conditionEntryId);
      if(condition.type!=='custom'||condition.customType!=='medclaw-query-context'||condition.parentId!==entry.id)fail('session_history_invalid');
      return checked(AdoptedContextFactSchema,legacyQueryContext(condition.data));})();
    const contextRefs=execution.stepResults.find(step=>step.stepId===decision.contextIntentId)?.queryRefs.map(ref=>ref.queryId)??[];
    if((decision.contextIntentId===null)!==(adopted===null)||adopted&&(adopted.decisionId!==decision.id||adopted.sourceRunId!==row.id||adopted.sourceInputId!==row.input_id
      ||adopted.contextIntentId!==decision.contextIntentId||!isDeepStrictEqual(adopted.taskIntents,execution.taskIntents)||!isDeepStrictEqual(adopted.adoptedSlots,decision.adoptedSlots)
      ||!isDeepStrictEqual(adopted.queryIds,contextRefs)||adopted.pendingClarification!==null))fail('state_conflict');
    return {execution,adopted,queryIds};
  }
  private validateProgramFinal(row:RunRow,fact:FinalAgentFact,requireAvailable:boolean) {
    if(!['program','user_form'].includes(fact.resultSource??'pi')||fact.status!=='completed'||fact.error!==null||fact.inputSettlement!==undefined||!fact.history
      ||row.input_id===null||row.session_id===null||fact.calls.length||fact.compactions?.length)fail('state_conflict');
    const cleanup=checked(RunCleanupRecordSchema,fact.cleanup);
    if(cleanup.executionStarted!==false||cleanup.stopConfirmed!==true||cleanup.requiredPersistenceComplete!==true
      ||cleanup.inputsSettled!==true||cleanup.resourcesReleased!==true||cleanup.unconfirmedItems.length)fail('state_conflict');
    const settlement=checked(ProductSettlementSchema,fact.productSettlement),turn=fact.productTurn,history=fact.history;
    if(settlement.runId!==row.id||settlement.sessionId!==row.session_id||settlement.inputId!==row.input_id
      ||!turn||!isDeepStrictEqual(turn.history,history)||!turn.userEntryId||settlement.nativeUserEntryId!==turn.userEntryId||!turn.resultEntryId||!history.activeLeafId)fail('session_history_invalid');
    const path=new Set<string>();let leaf:string|null=history.activeLeafId;
    while(leaf!==null){if(path.has(leaf))fail('session_history_invalid');path.add(leaf);const entry=this.db.query<{parent_entry_id:string|null},[number,string]>('SELECT parent_entry_id FROM memories WHERE session_id=? AND native_entry_id=?').get(row.session_id,leaf);if(!entry)fail('session_history_invalid');leaf=entry.parent_entry_id;}
    const read=(entryId:string)=>{
      checked(OpaqueIdSchema,entryId);
      const stored=this.db.query<{entry_json:string},[number,number,string]>('SELECT entry_json FROM memories WHERE session_id=? AND run_id=? AND native_entry_id=?').get(row.session_id!,row.id,entryId);
      const incoming=history.newEntries.find(value=>(value as {id?:string}).id===entryId);
      if(!stored||!path.has(entryId)||!incoming||canonicalRequest(incoming)!==stored.entry_json)fail('session_history_invalid');
      return decoded(stored.entry_json) as {id:string;parentId:string|null;type:string;customType?:string;details?:unknown;data?:unknown;content?:unknown;display?:boolean;message?:{role:string;content:unknown}};
    };
    const user=read(turn.userEntryId),result=read(turn.resultEntryId),executionEntry=read(turn.executionEntryId);
    const content=this.inputs.content(this.inputs.required(row.input_id));
    const scope=checked(RunScopeSchema,legacyRunScope(decoded(row.scope_json)));
    if(!isDeepStrictEqual(content.scope,scope))fail('state_conflict');
    const frozenBatches=scope.batchIds.map(batchId=>{
      const ref=content.workspaceContext.batchRefs.find(value=>value.id===batchId);if(!ref)fail('state_conflict');return ref;
    });
    if(requireAvailable&&!isDeepStrictEqual(readWorkspaceBatchReferences(this.db,scope.batchIds).refs,frozenBatches))fail('state_conflict');
    if(user.type!=='message'||user.message?.role!=='user'||!isDeepStrictEqual(user.message.content,[{type:'text',text:content.text}])
      ||content.text!==row.input_text||result.type!=='custom_message'||result.customType!=='medclaw-query-result'||result.display!==true
      ||result.parentId!==user.id||result.content!==fact.outputText||executionEntry.type!=='custom'
      ||executionEntry.parentId!==result.id)fail('session_history_invalid');
    const details=checked(ProductResultDetailsSchema,result.details);
    const decision=this.intents?.readIntentFacts({runId:row.id})?.decision;
    if(fact.resultSource==='user_form'){
      if(!decision||decision.decisionSource!=='user_form'||details.source!=='user_form'||details.runId!==row.id||details.inputId!==row.input_id
        ||details.decisionId!==decision.id||executionEntry.customType!=='medclaw-query-form-execution'||turn.conditionEntryId===null
        ||history.newEntries.length!==4||history.activeLeafId!==turn.conditionEntryId||content.intentAdmission||content.resourceInputPlan
        ||this.db.query('SELECT id FROM model_calls WHERE run_id=?').get(row.id)||this.db.query('SELECT id FROM tool_calls WHERE run_id=?').get(row.id))fail('state_conflict');
      const execution=checked(FormExecutionFactSchema,omitLegacyFields(executionEntry.data,['resultHash'])),condition=read(turn.conditionEntryId);
      if(condition.type!=='custom'||condition.customType!=='medclaw-query-context'||condition.parentId!==executionEntry.id)fail('session_history_invalid');
      const adopted=checked(FormContextFactSchema,legacyQueryContext(condition.data)),query=new SqliteToolStore(this.db).readQuery(execution.queryId),request=content.originalSubmitInput;
      if(request.mode!=='send'||request.routing?.mode!=='user_form'||!query||query.source!=='user_form'||query.runId!==row.id
        ||query.sessionId!==row.session_id||query.inputId!==row.input_id||query.callRef!==`form:${row.id}:${row.input_id}`
        ||query.basedOnQueryId!==request.expectedQueryId||execution.decisionId!==decision.id
        ||!isDeepStrictEqual(query.params,request.routing.params)||!isDeepStrictEqual(query.params,decision.queryParams)
        ||!isDeepStrictEqual(details.queryIds,[query.id])||adopted.decisionId!==decision.id||adopted.sourceRunId!==row.id
        ||adopted.sourceInputId!==row.input_id||!isDeepStrictEqual(adopted.params,query.params)||!isDeepStrictEqual(adopted.queryIds,[query.id]))fail('answer_evidence_invalid');
      this.answerReferences(row,requireAvailable,[query.id]);return {details,execution,adopted,queryIds:[query.id]};
    }
    if(details.source!=='program'||executionEntry.customType!=='medclaw-intent-execution'||decision?.decisionSource==='user_form')fail('state_conflict');
    const execution=checked(IntentExecutionFactSchema,legacyIntentExecution(executionEntry.data));
    if(!decision||details.runId!==row.id||details.inputId!==row.input_id||details.decisionId!==decision.id||execution.decisionId!==decision.id
      ||!isDeepStrictEqual(execution.taskIntents,decision.adoptedIntents)||!isDeepStrictEqual(details.missingSlots,decision.missingSlots))fail('state_conflict');
    const expectedKind=decision.route==='simple'?'result':decision.route==='reject'?'out_of_scope':decision.route==='clarify'
      ?decision.status==='UNSUPPORTED_DATA'?'insufficient_evidence':'clarification':null;
    if(details.kind!==expectedKind)fail('state_conflict');
    const store=new SqliteToolStore(this.db),refs=execution.stepResults.flatMap(step=>step.queryRefs),queryIds=[...new Set(refs.map(ref=>ref.queryId))].sort((a,b)=>a-b);
    if(!isDeepStrictEqual([...details.queryIds].sort((a,b)=>a-b),queryIds))fail('answer_evidence_invalid');
    if(decision.executionPlan){
      if(execution.stepResults.length!==decision.executionPlan.steps.length||queryIds.length!==refs.length)fail('answer_evidence_invalid');
      for(const [index,step] of decision.executionPlan.steps.entries()){
        const result=execution.stepResults[index];
        if(!result||result.stepId!==step.stepId||result.queryRefs.length!==step.queries.length)fail('answer_evidence_invalid');
        if(step.metadata){
          if(!result.metadata||result.metadata.stepId!==step.stepId||result.metadata.basis!==step.metadata.basis
            ||result.metadata.batches.length===0||result.metadata.batches.some(batch=>!frozenBatches.some(ref=>ref.id===batch.id)
              ||step.metadata!.region!==null&&batch.region!==step.metadata!.region))fail('answer_evidence_invalid');
          if(requireAvailable&&!isDeepStrictEqual(result.metadata.batches,new SqliteCatalogStore(this.db).readBatches(scope.batchIds).filter(batch=>step.metadata!.region===null||batch.region===step.metadata!.region)))fail('answer_evidence_invalid');
        }else if(result.metadata)fail('answer_evidence_invalid');
        for(const [part,params] of step.queries.entries()){
          const ref=result.queryRefs[part]!,query=store.readQuery(ref.queryId);
          if(!query||query.runId!==row.id||query.sessionId!==row.session_id||query.inputId!==row.input_id||query.source!=='intent'
            ||query.callRef!==`intent:${row.id}:${decision.id}:${step.stepId}:${part}`||!isDeepStrictEqual(query.params,params))fail('answer_evidence_invalid');
        }
      }
      const actual=this.db.query<{id:number},[number]>('SELECT id FROM queries WHERE run_id=? ORDER BY id').all(row.id).map(query=>query.id);
      if(!isDeepStrictEqual(actual,queryIds))fail('answer_evidence_invalid');
    }else{
    if(decision.route==='simple'&&(execution.stepResults.length!==1||execution.stepResults[0]!.stepId!==decision.adoptedIntents[0]!.id||refs.length!==1)
      ||decision.route!=='simple'&&refs.length)fail('answer_evidence_invalid');
    for(const ref of refs){const query=store.readQuery(ref.queryId);
      if(!query||query.runId!==row.id||query.sessionId!==row.session_id||query.inputId!==row.input_id||query.source!=='intent'
        ||query.callRef!==`intent:${row.id}:${decision.id}:${execution.stepResults[0]!.stepId}`||!isDeepStrictEqual(query.params,decision.queryParams))fail('answer_evidence_invalid');}
    }
    this.answerReferences(row,requireAvailable,queryIds);
    const adopted=turn.conditionEntryId===null?null:(()=>{const entry=read(turn.conditionEntryId);
      if(entry.type!=='custom'||entry.customType!=='medclaw-query-context'||entry.parentId!==executionEntry.id)fail('session_history_invalid');
      return checked(AdoptedContextFactSchema,legacyQueryContext(entry.data));})();
    if((decision.contextIntentId===null)!==(adopted===null)||history.newEntries.length!==(adopted?4:3)
      ||history.activeLeafId!==(turn.conditionEntryId??turn.executionEntryId))fail('session_history_invalid');
    const expectedPending=decision.route==='clarify'?{
      taskText:(decision.intentCallId===null?null:this.intents!.readIntentStageInput(decision.intentCallId).input.pendingClarification)?.taskText??content.text,
      missingSlots:decision.missingSlots}:null;
    const contextQueryIds=decision.executionPlan?(execution.stepResults.find(step=>step.stepId===decision.contextIntentId)?.queryRefs.map(ref=>ref.queryId)??[]):queryIds;
    if(adopted&&(adopted.sourceRunId!==row.id||adopted.sourceInputId!==row.input_id||adopted.decisionId!==decision.id
      ||adopted.contextIntentId!==decision.contextIntentId||!isDeepStrictEqual(adopted.taskIntents,execution.taskIntents)
      ||!isDeepStrictEqual(adopted.adoptedSlots,decision.adoptedSlots)||!isDeepStrictEqual(adopted.pendingClarification,expectedPending)||!isDeepStrictEqual([...adopted.queryIds].sort((a,b)=>a-b),contextQueryIds)))fail('state_conflict');
    return {details,execution,adopted,queryIds};
  }
  private adoptProgramContext(row:RunRow,fact:FinalAgentFact,adopted:QueryContextFact|null):void {
    if(!adopted)return;
    this.writeIntentContext(row.session_id!,fact.history!.activeLeafId!,adopted,fact.endedAt);
  }
  private writeIntentContext(sessionId:number,nativeLeafId:string,adopted:QueryContextFact,time:string):void {
    const previous=this.db.query<{version:number},[number]>('SELECT version FROM query_contexts WHERE session_id=?').get(sessionId);
    const version=(previous?.version??0)+1;
    const {contract:_contract,decisionId:_decisionId,...fields}=adopted;
    const form=adopted.contract==='medclaw.query-form-context/v1';
    checked(QueryContextRecordSchema,{sessionId,nativeLeafId,version,...(form?{...adopted,pendingClarification:null}:fields)});
    this.db.query(`INSERT INTO query_contexts(session_id,native_leaf_id,version,source_input_id,source_run_id,context_intent_id,task_intents_json,schema_version,adopted_slots_json,query_ids_json,pending_clarification_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET native_leaf_id=excluded.native_leaf_id,version=excluded.version,source_input_id=excluded.source_input_id,source_run_id=excluded.source_run_id,
      context_intent_id=excluded.context_intent_id,task_intents_json=excluded.task_intents_json,schema_version=excluded.schema_version,adopted_slots_json=excluded.adopted_slots_json,
      query_ids_json=excluded.query_ids_json,pending_clarification_json=excluded.pending_clarification_json,updated_at=excluded.updated_at`)
      .run(sessionId,nativeLeafId,version,adopted.sourceInputId,adopted.sourceRunId,form?'user_form':adopted.contextIntentId,
        canonicalRequest(form?[]:adopted.taskIntents),form?'medclaw.query-form/v1':'medclaw.intent/v2',
        canonicalRequest(form?adopted.params:adopted.adoptedSlots),canonicalRequest(adopted.queryIds),json(form?null:adopted.pendingClarification),time);
  }
  private validateCleanup(row: RunRow, input: RunCleanupRecord): RunCleanupRecord {
    const previous = decoded(row.cleanup_json);
    const next = checked(RunCleanupRecordSchema, input), old = RunCleanupRecordSchema.safeParse(previous);
    if (old.success) {
      if (old.data.processTreeProof) {
        if (next.processTreeProof && !isDeepStrictEqual(old.data.processTreeProof, next.processTreeProof)) fail('state_conflict');
        next.processTreeProof = old.data.processTreeProof;
      }
      if (next.budgetSummary == null && old.data.budgetSummary != null) next.budgetSummary = old.data.budgetSummary;
      if (!next.extensions && old.data.extensions) next.extensions = old.data.extensions;
      if(old.data.extensionReleaseBasis){
        if(next.extensionReleaseBasis&&next.extensionReleaseBasis!==old.data.extensionReleaseBasis)fail('state_conflict');
        next.extensionReleaseBasis=old.data.extensionReleaseBasis;
      }
      if (old.data.extensions && next.extensions) {
        const before = old.data.extensions, after = next.extensions;
        if (before.assemblyId !== after.assemblyId || before.loadedAt !== null && before.loadedAt !== after.loadedAt
          || before.state === 'disposed' && after.state !== 'disposed' || before.state === 'load_failed' && !['load_failed', 'disposed'].includes(after.state)
          || before.state === 'active' && !['active', 'disposed'].includes(after.state)
          || before.disposedAt !== null && before.disposedAt !== after.disposedAt
          || Object.keys(before.hookCounts).some(key => after.hookCounts[key as keyof typeof after.hookCounts] < before.hookCounts[key as keyof typeof before.hookCounts])
          || before.diagnostics.some(error => !after.diagnostics.some(item => isDeepStrictEqual(item, error)))) fail('state_conflict');
      }
      for (const key of ["executionStarted", "stopConfirmed", "requiredPersistenceComplete", "inputsSettled", "resourcesReleased"] as const) {
        if (old.data[key] === true && next[key] !== true || key === "executionStarted" && old.data[key] === false && next[key] !== false) fail("state_conflict");
      }
      if (old.data.verifiedAt && (!next.verifiedAt || Date.parse(next.verifiedAt) < Date.parse(old.data.verifiedAt))) fail("state_conflict");
      if (old.data.secondaryErrors.some(error => !next.secondaryErrors.some(item => isDeepStrictEqual(item, error)))) fail("state_conflict");
    }
    if (next.processTreeProof && next.processTreeProof.instanceId !== row.instance_id) fail('state_conflict');
    const selectedExtension=this.readRunExtensions(row.id)?.selection.extension;
    if(next.extensionReleaseBasis&&(!selectedExtension||next.extensions||next.extensionReleaseBasis==='not_loaded'&&(next.executionStarted!==false||this.calls(row.id).some(call=>call.kind!=='intent'))))fail('state_conflict');
    if (next.resourcesReleased===true && selectedExtension && !next.extensions&&!next.extensionReleaseBasis) fail('state_conflict');
    if (next.extensions) {
      const proof = next.extensions, frozen = this.readRunExtensions(row.id);
      if (proof.instanceId !== row.instance_id || proof.sessionId !== row.session_id || proof.runId !== row.id
        || !frozen?.selection.extension || !isDeepStrictEqual(proof.ref, frozen.selection.extension)
        || next.resourcesReleased === true && !proof.resourcesReleased) fail('state_conflict');
    }
    return next;
  }
  private finalize(runId: number, fact: FinalProviderFact, finalCalls: import("../../contracts/src/run").FinalCallFact[], kind: "provider" | "agent" | "child"): RunView {
    id(runId); timestamp(fact.endedAt); timestamp(fact.stoppedAt); timestamp(fact.cancelRequestedAt ?? null);
    if (!["completed", "failed", "cancelled"].includes(fact.status)) fail("invalid_argument");
    checked(z.string().nullable(), fact.outputText);
    const error = fact.error === null ? null : checked(AppErrorSchema, fact.error);
    let cleanup = fact.cleanup == null ? null : checked(z.union([cleanupSchema, RunCleanupRecordSchema]), fact.cleanup);
    const usage = fact.usage == null ? null : checked(usageSchema, fact.usage);
    return this.transactions.immediate(() => {
      const row = this.row(runId);
      if (!row || row.kind !== kind) fail("state_conflict");
      const program=kind==='agent'&&['program','user_form'].includes((fact as FinalAgentFact).resultSource??'pi');
      let programProof:ReturnType<Repositories['validateProgramFinal']>|null=null;
      if(program&&fact.status==='completed'&&(row.cancel_requested_at!==null||fact.cancelRequestedAt!=null))fail('state_conflict');
      if(program&&fact.status!=='completed')this.validateProgramFailure(row,fact as FinalAgentFact);
      const history=kind==='agent'||kind==='child'?(fact as FinalAgentFact).history:undefined;
      const historyRequired=program||kind==='child'||kind==='agent'&&checked(agentConfigSchema,legacyRunConfig(decoded(row.config_json)),'storage_read_failed').agent.historyContract==='medclaw.history/p9-v1';
      if(historyRequired&&fact.status==='completed'&&!history)fail('session_history_invalid');
      if(history) {
        if(history.sessionId!==row.session_id||history.runId!==runId)fail('access_denied');
        if(this.isFinalSaved(runId,fact))return this.view(row);
        if(!this.memory)fail('storage_write_failed');
        if(historyRequired&&fact.status==='completed') {
          const candidate=program?(fact as FinalAgentFact).productTurn?.userEntryId:(history.newEntries as {id:string;type:string}[]).findLast(entry=>entry.type==='message')?.id;
          if(!candidate||this.db.query('SELECT id FROM memories WHERE session_id=? AND native_entry_id=?').get(row.session_id,candidate))fail('session_history_invalid');
        }
        const compactions=(fact as FinalAgentFact).compactions??[];
        const pending=compactions.filter(compaction=>this.compactionCalls(compaction.operationRef).some(call=>checked(CompactionCallMetadataSchema,(decoded(call.model_json) as {compaction:unknown}).compaction).nativeEntryId===null));
        // A second native frame must first cross the same save barrier as a continuation.
        if(pending.length>1)fail('state_conflict');
        if(pending.length)this.commitCompactionInTransaction(history,pending[0]!);
        else this.memory.commitInTransaction(history);
        for(const compaction of compactions)if(compaction!==pending[0]&&this.confirmCompactionSaved(history,compaction)===null)fail('storage_write_failed');
        if(program){
          programProof=this.validateProgramFinal(row,fact as FinalAgentFact,true);
          this.inputs.settleProductInput(row.input_id!,{runId,sessionId:row.session_id!,nativeEntryId:(fact as FinalAgentFact).productTurn!.userEntryId!,at:fact.endedAt});
          this.adoptProgramContext(row,fact as FinalAgentFact,programProof.adopted);
        }else if(historyRequired&&fact.status==='completed'){
          this.validateFinalAnswer(row,fact as FinalAgentFact);
          const intent=kind==='agent'?this.validateAgentIntentFinal(row,fact as FinalAgentFact,true):null;
          if(intent)this.adoptProgramContext(row,fact as FinalAgentFact,intent.adopted);
        }
      }
      if(kind==='child') {
        const result=checked(ChildResultSchema,(fact as FinalAgentFact & {childResult:ChildResult}).childResult);
        if(Buffer.byteLength(JSON.stringify(result),'utf8')>normalizeToolConfiguration(readFrozenChild(this.db,runId).toolConfiguration).maxResultBytes)fail('tool_result_too_large');
        const identity=this.readChildIdentity(runId)!,base=this.readChildHistoryBase(runId),refs=this.childResultReferences(runId);
        if(!history||Object.entries(identity).filter(([key])=>key!=='instanceId'&&key!=='parentSessionId'&&key!=='originNativeToolCallId').some(([key,value])=>result[key as keyof ChildResult]!==value)
          ||result.outcome!==fact.status||result.text!==fact.outputText||result.storageVersion!==base.storageVersion||result.finalLeafId!==base.leafId||result.committedAt!==fact.endedAt
          ||!isDeepStrictEqual(result.queryRefs,refs.queryRefs)||!isDeepStrictEqual(result.evidenceIds,refs.evidenceIds)
          ||row.child_result_json!=null&&!isDeepStrictEqual(decoded(row.child_result_json),result))fail('state_conflict');
      }
      const allCalls=this.calls(runId),calls=allCalls.filter(call=>call.kind!=='intent');
      if(allCalls.some(call=>call.kind==='intent'&&call.state==='started'))fail('storage_write_failed');
      if (calls.length !== finalCalls.length || new Set(finalCalls.map(call => call.callId)).size !== finalCalls.length) fail("state_conflict");
      const cancelRequestedAt = fact.cancelRequestedAt ?? row.cancel_requested_at;
      if (fact.cancelRequestedAt && row.cancel_requested_at && fact.cancelRequestedAt !== row.cancel_requested_at) fail("state_conflict");
      if (fact.status === "cancelled" && !cancelRequestedAt || fact.status === "completed" && !calls.length&&!program) fail("invalid_argument");
      const terminal = row.status !== "created" && row.status !== "running";
      if(kind==='child'&&!terminal&&row.cancel_requested_at&&fact.status==='completed')fail('state_conflict');
      if (terminal && (row.status !== fact.status || row.output_text !== null && row.output_text !== fact.outputText
        || row.stopped_at !== null && row.stopped_at !== fact.stoppedAt || !isDeepStrictEqual(decoded(row.error_json), error)
        || row.usage_json !== null && !isDeepStrictEqual(decoded(row.usage_json), usage))) fail("state_conflict");
      if(kind==='agent' && this.p5){
        if(program&&fact.status!=='completed')this.inputs.settleProgramFailure(row.input_id!,{runId,sessionId:row.session_id!,status:fact.status,at:fact.endedAt,error});
        const proof=(fact as FinalAgentFact & {inputSettlement?:InputSettlementProof}).inputSettlement;
        if(!program&&this.inputs.hasInputsForRun(runId)){if(!proof)fail('state_conflict');this.inputs.settleRunInputs(runId,fact.status,fact.endedAt,proof);}
        if(cleanup&&'contract'in cleanup)cleanup={...cleanup,inputsSettled:!this.inputs.hasPendingInputsForRun(runId)};
      }
      if (cleanup && "contract" in cleanup) cleanup = this.validateCleanup(row, cleanup);
      else if (terminal && !isDeepStrictEqual(decoded(row.cleanup_json), cleanup)) fail("state_conflict");
      for (const original of calls) {
        const incoming = finalCalls.find(call => call.callId === original.callId);
        if (!incoming) fail("state_conflict");
        if("inputId" in incoming && incoming.inputId !== original.inputId) fail("state_conflict");
        const {context: incomingContext, ...incomingView} = incoming;
        const savedModel = decoded(this.db.query<{model_json:string},[string]>('SELECT model_json FROM model_calls WHERE call_id=?').get(original.callId)!.model_json) as Record<string,unknown>;
        if (incomingContext) {
          const next = checked(ModelCallContextSchema,incomingContext), prior = checked(ModelCallContextSchema,legacyModelCallContext(savedModel.context),'storage_read_failed');
          if (next.snapshotId !== prior.snapshotId || next.inputId !== prior.inputId || next.observation && !isDeepStrictEqual(next.observation,prior.observation)) fail('state_conflict');
          savedModel.context = checked(ModelCallContextSchema,{...next,observation:prior.observation ?? next.observation,responseStatus:prior.observation ? prior.responseStatus : next.responseStatus ?? prior.responseStatus,payloadVerified:prior.observation ? prior.payloadVerified : next.payloadVerified ?? prior.payloadVerified});
        }
        const finalCall = checked(ModelCallViewSchema, { ...original, ...incomingView });
        if (finalCall.state === "started") fail("invalid_argument");
        if (original.state !== "started") {
          if (!isDeepStrictEqual(original, finalCall)) fail("state_conflict");
          continue;
        }
        const result = this.db.query(`UPDATE model_calls SET state=?,model_json=?,ended_at=?,duration_ms=?,input_tokens=?,
          output_tokens=?,cost=?,cost_currency=?,usage_source=?,unavailable_reason=?,error_json=? WHERE run_id=? AND call_id=? AND state='started'`)
          .run(finalCall.state, JSON.stringify({ ...savedModel, selection: original.model, responseModel: finalCall.responseModel, sdkStopReason: finalCall.sdkStopReason }),
            finalCall.endedAt, finalCall.durationMs, finalCall.inputTokens, finalCall.outputTokens, finalCall.cost, finalCall.costCurrency,
            finalCall.usageSource, finalCall.unavailableReason, json(finalCall.error), runId, finalCall.callId);
        if (result.changes !== 1) fail("state_conflict");
      }
      if (cleanup && 'contract' in cleanup && cleanup.requiredPersistenceComplete && (!this.verifyPriorContextFacts(runId).requiredPersistenceComplete||!this.verifyPriorCompactionFacts(runId).requiredPersistenceComplete)) fail('storage_write_failed');
      if(program&&fact.status==='completed'&&this.row(runId)!.cancel_requested_at!==null)fail('state_conflict');
      this.db.query(`UPDATE runs SET status=?,output_text=?,stopped_at=COALESCE(stopped_at,?),ended_at=COALESCE(ended_at,?),cancel_requested_at=?,
        error_json=?,cleanup_json=?,usage_json=?,child_result_json=COALESCE(child_result_json,?) WHERE id=?`)
        .run(terminal ? row.status : fact.status, row.output_text ?? fact.outputText, fact.stoppedAt, fact.endedAt, cancelRequestedAt,
          terminal ? row.error_json : json(error), json(cleanup), row.usage_json ?? json(usage),kind==='child'?canonicalRequest((fact as FinalAgentFact & {childResult:ChildResult}).childResult):null, runId);
      if (this.p3 && row.kind === "agent" && fact.status === "completed" && (historyRequired||checked(agentConfigSchema, legacyRunConfig(decoded(row.config_json)), "storage_read_failed").agent.stage === "P3")) {
        const frozen = checked(RunScopeSchema, legacyRunScope(decoded(row.scope_json)), "storage_read_failed");
        const queries = this.db.query<{ id: number; session_id: number; batch_ids_json: string; result_json: string }, [number]>(
          "SELECT id,session_id,batch_ids_json,result_json FROM queries WHERE run_id=? ORDER BY id").all(runId);
        for (const query of historyRequired?[]:queries) {
          const batches = checked(z.array(PositiveIdSchema), decoded(query.batch_ids_json), "storage_read_failed");
          const result = checked(z.object({ scopeDeviceIds: z.array(PositiveIdSchema).nullable() }), decoded(query.result_json), "storage_read_failed");
          if (query.session_id !== row.session_id || batches.some(batch => !frozen.batchIds.includes(batch))
            || frozen.deviceIds !== null && (result.scopeDeviceIds === null || result.scopeDeviceIds.some(device => !frozen.deviceIds!.includes(device)))) fail("access_denied");
        }
        const queryIds = programProof?.queryIds??(historyRequired?this.answerReferences(row,true):queries.map(query => query.id)), text = fact.outputText ?? "";
        const answerKind=programProof?.details.kind??'result',missingSlots=programProof?.details.missingSlots??[];
        const priorAnswer = this.db.query<{ id: number; text: string; query_ids_json: string;kind:string;missing_slots_json:string }, [number]>("SELECT id,text,query_ids_json,kind,missing_slots_json FROM answers WHERE run_id=?").get(runId);
        if (priorAnswer) {
          if (priorAnswer.text !== text || priorAnswer.kind!==answerKind||!isDeepStrictEqual(decoded(priorAnswer.missing_slots_json),missingSlots)||!isDeepStrictEqual(decoded(priorAnswer.query_ids_json), queryIds)) fail("state_conflict");
        } else {
          const saved = this.db.query("INSERT INTO answers(run_id,session_id,input_id,kind,text,query_ids_json,missing_slots_json,native_leaf_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
            .run(runId, row.session_id, row.input_id, answerKind, text, JSON.stringify(queryIds),JSON.stringify(missingSlots),history?.activeLeafId??null, fact.endedAt);
          this.db.query("INSERT INTO business_events(operation_ref,type,actor,session_id,run_id,details_json,occurred_at) VALUES(?,'answer_committed',?,?,?,?,?)")
            .run(`answer:${runId}`,program?'system':'agent', row.session_id, runId, JSON.stringify({ answerId: Number(saved.lastInsertRowid), queryIds,...(program?{resultSource:(fact as FinalAgentFact).resultSource}:{}) }), fact.endedAt);
        }
      }
      if(!terminal)this.runTerminal(row,fact.status,error,cleanup,fact.endedAt);
      const run = this.view(this.row(runId)!);
      this.beforeCommit?.();
      if(program&&fact.status==='completed'&&this.row(runId)!.cancel_requested_at!==null)fail('state_conflict');
      return run;
    });
  }

  /** Read-only proof after a COMMIT whose return was lost; compare full facts, not paged previews. */
  isFinalSaved(runId: number, fact: FinalProviderFact | FinalAgentFact): boolean {
    id(runId);
    const row = this.row(runId);
    const savedCleanup = RunCleanupRecordSchema.safeParse(row ? decoded(row.cleanup_json) : null);
    const expectedCleanup = fact.cleanup && 'contract' in fact.cleanup && savedCleanup.success
      ? { ...fact.cleanup, ...(fact.cleanup.budgetSummary == null && savedCleanup.data.budgetSummary != null ? { budgetSummary: savedCleanup.data.budgetSummary } : {}) }
      : fact.cleanup ?? null;
    if (!row || row.kind !== ("childResult" in fact ? "child" : "calls" in fact ? "agent" : "provider") || row.status !== fact.status
      || row.output_text !== fact.outputText || row.stopped_at !== fact.stoppedAt || row.ended_at !== fact.endedAt
      || row.cancel_requested_at !== (fact.cancelRequestedAt ?? null) || !isDeepStrictEqual(decoded(row.error_json), fact.error)
      || !isDeepStrictEqual(decoded(row.usage_json), fact.usage ?? null) || !isDeepStrictEqual(decoded(row.cleanup_json), expectedCleanup)) return false;
    const program='calls' in fact&&(fact.resultSource==='program'||fact.resultSource==='user_form');
    let programProof:ReturnType<Repositories['validateProgramFinal']>|null=null;
    if(program&&fact.status==='completed'){
      try{programProof=this.validateProgramFinal(row,fact,false);}catch{return false;}
      const input=this.inputs.required(row.input_id!),content=this.inputs.content(input);
      if(input.status!=='consumed'||input.processing_status!=='completed'||input.run_id!==runId||input.native_entry_id!==fact.productTurn.userEntryId
        ||input.delivered_at!==fact.endedAt||content.resourceInputPlan&&content.nativeInput?.text!==content.text)return false;
      const delivered=this.db.query<{source:string;payload_json:string},[number]>("SELECT source,payload_json FROM runtime_events WHERE run_id=? AND type='input_delivered'").all(runId);
      if(delivered.length!==1||delivered[0]!.source!=='application')return false;
      const payload=decoded(delivered[0]!.payload_json) as {phase?:string;inputId?:number;runId?:number};
      if(payload.phase!=='product_history_saved'||payload.inputId!==row.input_id||payload.runId!==runId)return false;
      if(programProof.adopted&&this.db.query<{current_leaf_id:string|null},[number]>('SELECT current_leaf_id FROM sessions WHERE id=?').get(row.session_id!)?.current_leaf_id===fact.history.activeLeafId){
        const context=this.readIntent({runId})?.effectiveContext,adopted=programProof.adopted;
        const matches=context&&adopted.contract==='medclaw.query-form-context/v1'?'contract' in context&&context.decisionId===adopted.decisionId&&isDeepStrictEqual(context.params,adopted.params)
          :context&&!('contract' in context)&&adopted.contract==='medclaw.query-context-entry/v2'&&context.contextIntentId===adopted.contextIntentId
            &&isDeepStrictEqual(context.taskIntents,adopted.taskIntents)&&isDeepStrictEqual(context.adoptedSlots,adopted.adoptedSlots);
        if(!context||context.nativeLeafId!==fact.history.activeLeafId||context.sourceRunId!==runId||context.sourceInputId!==row.input_id
          ||!matches
          ||!isDeepStrictEqual(context.queryIds,adopted.queryIds)||!isDeepStrictEqual(context.pendingClarification,adopted.contract==='medclaw.query-form-context/v1'?null:adopted.pendingClarification))return false;
      }
    }
    if(program&&fact.status!=='completed'){
      try{this.validateProgramFailure(row,fact);}catch{return false;}
      const input=this.inputs.required(row.input_id!);
      if(input.status!==fact.status||input.processing_status!==fact.status||input.processed_at!==fact.endedAt||!isDeepStrictEqual(decoded(input.error_json),fact.error))return false;
    }
    const historyRequired=program||row.kind==='agent'&&checked(agentConfigSchema,legacyRunConfig(decoded(row.config_json)),'storage_read_failed').agent.historyContract==='medclaw.history/p9-v1';
    if('calls' in fact&&fact.history&&(!this.memory||this.memory.confirmCommitted(fact.history)===null))return false;
    if('calls' in fact&&fact.compactions?.some(compaction=>this.confirmCompactionSaved(fact.history??null,compaction)===null))return false;
    if(historyRequired) {
      if(fact.status==='completed') {
        if(!('calls' in fact)||!fact.history)return false;
        if(!program){try{this.validateAgentIntentFinal(row,fact,false);}catch{return false;}}
        const answer=this.db.query<{id:number;session_id:number;input_id:number|null;native_leaf_id:string|null;text:string;query_ids_json:string;kind:string;missing_slots_json:string},[number]>('SELECT * FROM answers WHERE run_id=?').get(runId);
        let queryIds:number[];try{queryIds=programProof?.queryIds??this.answerReferences(row,false);}catch{return false;}
        if(!answer||answer.session_id!==row.session_id||answer.input_id!==row.input_id||answer.native_leaf_id!==fact.history.activeLeafId||answer.text!==fact.outputText
          ||answer.kind!==(programProof?.details.kind??'result')||!isDeepStrictEqual(decoded(answer.missing_slots_json),programProof?.details.missingSlots??[])
          ||!isDeepStrictEqual(decoded(answer.query_ids_json),queryIds))return false;
        const activity=this.db.query<{details_json:string},[string,string]>("SELECT details_json FROM business_events WHERE operation_ref=? AND type='answer_committed' AND actor=?").get(`answer:${runId}`,program?'system':'agent');
        if(!activity||!isDeepStrictEqual(decoded(activity.details_json),{answerId:answer.id,queryIds,...(program?{resultSource:fact.resultSource}:{})}))return false;
      }
      const terminal=this.db.query<{payload_json:string},[number,string]>('SELECT payload_json FROM runtime_events WHERE run_id=? AND type=?').get(runId,`run_${fact.status}`);
      if(!terminal)return false;
      const parsed=RegisteredEventPayloadSchema.safeParse({type:`run_${fact.status}`,payload:decoded(terminal.payload_json)});
      if(!parsed.success||!['run_completed','run_failed','run_cancelled'].includes(parsed.data.type))return false;
      const payload=parsed.data.payload as {answerId:number|null;stopConfirmed:boolean|null;errorCode:string|null};
      const answer=this.db.query<{id:number},[number]>('SELECT id FROM answers WHERE run_id=?').get(runId);
      if(payload.answerId!==(answer?.id??null)||payload.errorCode!==(fact.error?.code??null)||fact.status==='completed'&&payload.stopConfirmed!==true)return false;
      for(const input of this.inputsForRun(runId))if(input.status==='consumed'&&input.processingStatus!==fact.status)return false;
    }
    if (this.p3 && row.kind === "agent" && fact.status === "completed" && checked(agentConfigSchema, legacyRunConfig(decoded(row.config_json)), "storage_read_failed").agent.stage === "P3") {
      const answer = this.db.query<{ text: string }, [number]>("SELECT text FROM answers WHERE run_id=?").get(runId);
      if (!answer || answer.text !== (fact.outputText ?? "")) return false;
    }
    if(this.p5&&row.kind==='agent'&&this.inputs.hasPendingInputsForRun(runId))return false;
    if('childResult' in fact) {
      if(!isDeepStrictEqual(decoded(row.child_result_json??null),fact.childResult)||!this.db.query('SELECT id FROM runtime_events WHERE run_id=? AND type=?').get(runId,`run_${fact.status}`)
        ||this.db.query('SELECT id FROM answers WHERE run_id=?').get(runId))return false;
    }
    const allSaved=this.calls(runId),saved=allSaved.filter(call=>call.kind!=='intent'), expected = "calls" in fact ? fact.calls : fact.call ? [fact.call] : [];
    if(allSaved.some(call=>call.kind==='intent'&&call.state==='started'))return false;
    return saved.length === expected.length && expected.every(call => {
      const original = saved.find(item => item.callId === call.callId);
      if (call.context) {
        const model = decoded(this.db.query<{model_json:string},[string]>('SELECT model_json FROM model_calls WHERE call_id=?').get(call.callId)!.model_json) as {context?:unknown}, marker = ModelCallContextSchema.safeParse(legacyModelCallContext(model.context));
        if (!marker.success || marker.data.snapshotId !== call.context.snapshotId || marker.data.inputId !== call.context.inputId || call.context.observation !== null && !isDeepStrictEqual(marker.data.observation,call.context.observation)) return false;
      }
      return original !== undefined && Object.entries(call).filter(([key]) => key !== 'context').every(([key, value]) => isDeepStrictEqual(original[key as keyof ModelCallView], value));
    });
  }

  checkpointFailure(runId: number, error: AppError, cleanup: RunCleanupRecord, time: string): void {
    id(runId); timestamp(time); checked(AppErrorSchema, error);
    this.transactions.immediate(() => {
      const row = this.row(runId);
      if (!row) fail("run_not_found");
      const terminal = row.status !== "created" && row.status !== "running";
      if (terminal && (row.status !== "failed" || !isDeepStrictEqual(decoded(row.error_json), error))) fail("state_conflict");
      if(this.p5&&cleanup.inputsSettled&&this.inputs.hasPendingInputsForRun(runId))fail('state_conflict');
      const checkedCleanup = this.validateCleanup(row, cleanup);
      if (checkedCleanup.requiredPersistenceComplete && (!this.verifyPriorContextFacts(runId).requiredPersistenceComplete||!this.verifyPriorCompactionFacts(runId).requiredPersistenceComplete)) fail('storage_write_failed');
      this.db.query("UPDATE runs SET status='failed',error_json=?,ended_at=COALESCE(ended_at,?),cleanup_json=? WHERE id=?")
        .run(json(error), time, json(checkedCleanup), runId);
      if(!terminal)this.runTerminal(row,'failed',error,checkedCleanup,time);
      this.beforeCommit?.();
    });
  }

  saveRunCleanup(runId: number, cleanup: RunCleanupRecord): void {
    id(runId);
    this.transactions.immediate(() => {
      const row = this.row(runId);
      if (!row) fail("run_not_found");
      if(this.p5&&cleanup.inputsSettled&&this.inputs.hasPendingInputsForRun(runId))fail('state_conflict');
      if (cleanup.requiredPersistenceComplete && (!this.verifyPriorContextFacts(runId).requiredPersistenceComplete||!this.verifyPriorCompactionFacts(runId).requiredPersistenceComplete)) fail('storage_write_failed');
      const checkedCleanup = this.validateCleanup(row, cleanup);
      this.db.query("UPDATE runs SET cleanup_json=? WHERE id=?").run(json(checkedCleanup), runId);
      this.beforeCommit?.();
    });
  }

  recoveryCandidates(instanceId: string): RunView[] {
    checked(OpaqueIdSchema, instanceId);
    return this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE instance_id<>? ORDER BY id").all(instanceId).flatMap(row => {
      const cleanup = RunCleanupRecordSchema.safeParse(decoded(row.cleanup_json));
      const released = cleanup.success && (cleanup.data.executionStarted === false || cleanup.data.stopConfirmed === true)
        && cleanup.data.requiredPersistenceComplete === true && cleanup.data.inputsSettled === true
        && cleanup.data.resourcesReleased === true && cleanup.data.unconfirmedItems.length === 0;
      const toolGap = this.p3 && this.db.query(`SELECT 1 FROM tool_calls WHERE run_id=? AND (
        status IN ('requested','running') OR (effect='LOCAL_WRITE' AND json_extract(result_json,'$.outcomeUnknown')=1)
        OR (tool_name IN ('bash','powershell','grep','find') AND started_at IS NOT NULL AND stopped_at IS NULL AND ?<>1)) LIMIT 1`)
        .get(row.id, cleanup.success && cleanup.data.stopConfirmed === true ? 1 : 0) !== null;
      const inputGap=this.p5&&this.inputs.hasPendingInputsForRun(row.id);
      const contextGap = !this.verifyPriorContextFacts(row.id).requiredPersistenceComplete;
      const compactionGap=!this.verifyPriorCompactionFacts(row.id).requiredPersistenceComplete;
      return row.status === "created" || row.status === "running" || !released || toolGap || inputGap || contextGap||compactionGap ? [this.view(row)] : [];
    });
  }

  verifyPriorToolFacts(runId: number, previousProcessExited: boolean, time: string, processTreeProof?: ProcessTreeProof): {
    stopConfirmed: boolean | null; requiredPersistenceComplete: boolean; unconfirmedItems: string[];
  } {
    id(runId); timestamp(time);
    return this.transactions.immediate(() => {
      const run = this.row(runId);
      if (!run) fail('run_not_found');
      const prior = RunCleanupRecordSchema.safeParse(decoded(run.cleanup_json));
      const treeProof = previousProcessExited ? stopProofForOwner(processTreeProof, run.instance_id) ?? (prior.success ? prior.data.processTreeProof : undefined) : undefined;
      const treeStopped = treeProof?.instanceId === run.instance_id;
      const unconfirmed = new Set(prior.success ? prior.data.unconfirmedItems.filter(item =>
        ['tool_persistence', 'tool_effect_unknown', 'tool_results_unknown'].includes(item)) : []);
      let stopConfirmed: boolean | null = previousProcessExited || prior.success && prior.data.stopConfirmed === true ? true : null;
      let changed = false;
      if (this.p3) {
        const tools = this.db.query<{
          id: number; tool_name: string; effect: string; status: string; started_at: string | null;
          stopped_at: string | null; result_json: string | null;
        }, [number]>('SELECT id,tool_name,effect,status,started_at,stopped_at,result_json FROM tool_calls WHERE run_id=? ORDER BY id').all(runId);
        for (const tool of tools) {
          const spawned = ['bash', 'powershell', 'grep', 'find'].includes(tool.tool_name);
          // The owning Host exiting proves neither a spawned child's stop nor its original result.
          if (spawned && tool.status === 'running' && !treeStopped) {
            stopConfirmed = null;
            unconfirmed.add('tool_results_unknown');
            continue;
          }
          if (spawned && tool.started_at !== null && tool.stopped_at === null && !treeStopped && !(prior.success && prior.data.stopConfirmed === true)) stopConfirmed = null;
          if (tool.status === 'requested' || tool.status === 'running') {
            if (!previousProcessExited) {
              unconfirmed.add('tool_results_unknown');
              continue;
            }
            const result = tool.status === 'running'
              ? { outcomeUnknown: true, recoveredAfterHostExit: true }
              : { executionStarted: false, recoveredAfterHostExit: true };
            const error = safeError('runtime_interrupted', undefined, { runId, toolCallId: tool.id });
            this.db.query(`UPDATE tool_calls SET status='failed',result_json=?,error_json=?,ended_at=?,stopped_at=CASE WHEN ?=1 THEN COALESCE(stopped_at,?) ELSE stopped_at END WHERE id=? AND status=?`)
              .run(JSON.stringify(result), JSON.stringify(error), time, treeStopped ? 1 : 0, treeProof?.observedAt ?? null, tool.id, tool.status);
            this.recoveredToolEvent(run,tool.id,error,time);
            changed = true;
            if (tool.status === 'running' && tool.effect === 'LOCAL_WRITE') unconfirmed.add('tool_effect_unknown');
          } else if (tool.effect === 'LOCAL_WRITE') {
            const result = decoded(tool.result_json);
            if (typeof result === 'object' && result !== null && 'outcomeUnknown' in result && result.outcomeUnknown === true) unconfirmed.add('tool_effect_unknown');
          }
        }
        if (previousProcessExited && (treeStopped || !tools.some(tool => ['bash', 'powershell', 'grep', 'find'].includes(tool.tool_name) && tool.status === 'running'))) unconfirmed.delete('tool_results_unknown');
      }
      if (stopConfirmed !== true) { unconfirmed.add('stop'); unconfirmed.add('resources'); }
      if (changed) this.beforeCommit?.();
      return { stopConfirmed, requiredPersistenceComplete: ![...unconfirmed].some(item => item.startsWith('tool_')), unconfirmedItems: [...unconfirmed] };
    });
  }

  verifyPriorContextFacts(runId: number) { id(runId); return this.inputRead(() => verifyPriorContextFacts(this.db,runId)); }
  verifyPriorIntentFacts(runId: number, previousProcessExited: boolean, time: string) {
    id(runId); timestamp(time);
    const intents = this.intents, pending = intents && this.inputRead(() => this.db.query("SELECT id FROM model_calls WHERE run_id=? AND kind='intent' AND state='started' LIMIT 1").get(runId));
    if (!intents || !pending) return { requiredPersistenceComplete: true, unconfirmedItems: [] as string[] };
    if (!previousProcessExited) return { requiredPersistenceComplete: false, unconfirmedItems: ['intent_stop_unknown', 'intent_persistence'] };
    this.inputWrite(() => intents.recoverInterrupted(runId, time));
    return { requiredPersistenceComplete: true, unconfirmedItems: [] as string[] };
  }
  verifyPriorHistoryFacts(runId:number) {
    id(runId);return this.inputRead(()=>this.db.transaction(()=>{
      const row=this.row(runId);if(!row)fail('run_not_found');
      if(row.kind!=='child'&&(row.kind!=='agent'||checked(agentConfigSchema,legacyRunConfig(decoded(row.config_json)),'storage_read_failed').agent.historyContract!=='medclaw.history/p9-v1'))return {requiredPersistenceComplete:true,unconfirmedItems:[] as string[]};
      try {
        if(!this.memory||row.session_id===null)fail('session_history_invalid');
        const snapshot=this.memory.loadInTransaction(row.session_id),ids=new Set(snapshot.entries.map(value=>(value as {id:string}).id));
        for(const input of this.inputsForRun(runId))if(input.status==='consumed'&&(!input.nativeEntryId||!ids.has(input.nativeEntryId)
          ||!this.db.query("SELECT id FROM memories WHERE session_id=? AND run_id=? AND native_entry_id=? AND json_extract(entry_json,'$.message.role')='user'").get(row.session_id,runId,input.nativeEntryId)))fail('session_history_invalid');
        return {requiredPersistenceComplete:true,unconfirmedItems:[] as string[]};
      }catch{return {requiredPersistenceComplete:false,unconfirmedItems:['history_persistence']};}
    }).deferred());
  }

  read(request: z.input<typeof ReadRunRequestSchema>): ReadRunResult {
    const input = checked(ReadRunRequestSchema, request);
    if ("recent" in input) {
      if ('parentRunId' in input && this.row(input.parentRunId)?.kind !== 'agent') fail('access_denied');
      const rows = 'parentRunId' in input
        ? this.db.query<RunRow, [number, number, number]>("SELECT * FROM runs WHERE kind='child' AND parent_run_id=? AND id<? ORDER BY id DESC LIMIT ?").all(input.parentRunId, input.beforeRunId ?? Number.MAX_SAFE_INTEGER, input.limit + 1)
        : this.db.query<RunRow, [number, number | null, number | null, string | null, string | null, number]>(
          "SELECT * FROM runs WHERE kind IN ('provider','agent') AND id<? AND (? IS NULL OR session_id=?) AND (? IS NULL OR kind=?) ORDER BY id DESC LIMIT ?",
        ).all(input.beforeRunId ?? Number.MAX_SAFE_INTEGER, input.sessionId ?? null, input.sessionId ?? null, input.kind ?? null, input.kind ?? null, input.limit + 1);
      const page = rows.slice(0, input.limit);
      return { kind: "recent", runs: page.map((row) => {
        const { output, calls, inputPage, cleanup, ...summary } = this.view(row);
        const cleanupSummary = cleanup ? { executionStarted: cleanup.executionStarted, stopConfirmed: cleanup.stopConfirmed,
          requiredPersistenceComplete: cleanup.requiredPersistenceComplete, inputsSettled: cleanup.inputsSettled,
          resourcesReleased: cleanup.resourcesReleased, unconfirmedCount: cleanup.unconfirmedItems.length,
          secondaryErrorCount: cleanup.secondaryErrors.length, verifiedAt: cleanup.verifiedAt } : null;
        if (cleanupSummary && cleanup?.budgetSummary !== undefined) Object.assign(cleanupSummary, { budgetSummary: cleanup.budgetSummary });
        if (summary.kind === 'child') { const { nextCallOffset, childResult, ...childSummary } = summary; return checked(RecentRunViewSchema, { ...childSummary, inputText: safePreview(row.input_text, 2048).text, cleanupSummary }); }
        if ("nextCallOffset" in summary) { const { nextCallOffset, ...agentSummary } = summary; return checked(RecentRunViewSchema, { ...agentSummary, inputText: safePreview(row.input_text, 2048).text, cleanupSummary }); }
        return checked(RecentRunViewSchema, { ...summary, inputText: safePreview(row.input_text, 2048).text, cleanupSummary });
      }),
        nextBeforeRunId: rows.length > input.limit ? page.at(-1)!.id : null };
    }
    const row = "runId" in input ? this.row(input.runId) : this.db.query<RunRow, [string, string]>(
      this.p5 ? "SELECT * FROM runs WHERE submission_operation_ref=?1 OR (kind='provider' AND json_extract(config_json,'$.providerRequest.operationRef')=?2) OR input_id=(SELECT id FROM session_inputs WHERE operation_ref=?1)" : "SELECT * FROM runs WHERE submission_operation_ref=? OR (kind='provider' AND json_extract(config_json,'$.providerRequest.operationRef')=?)",
    ).get(input.operationRef, input.operationRef);
    return { kind: "one", run: row ? this.view(row, input.outputOffset, input.outputLimit, input.inputOffset, input.inputLimit, input.callOffset, input.callLimit) : null };
  }

  active(): { runId: number; kind: "provider" | "agent"; sessionId: number | null } | null {
    const row = this.db.query<{ id: number; kind: "provider" | "agent"; session_id: number | null }, []>("SELECT id,kind,session_id FROM runs WHERE kind IN ('provider','agent') AND status IN ('created','running')").get();
    return row ? { runId: row.id, kind: row.kind, sessionId: row.session_id } : null;
  }

  // Called only after the Host has confirmed the old owning process exited.
  recoverInterrupted(instanceId: string, time: string, processTreeProof?: ProcessTreeProof): number {
    timestamp(time);
    if (!instanceId) fail("invalid_argument");
    return this.transactions.immediate(() => {
      const rows = this.db.query<RunRow, [string]>(
        "SELECT * FROM runs WHERE instance_id<>? AND status IN ('created','running')",
      ).all(instanceId);
      for (const row of rows) {
        const error = safeError(row.kind === "provider" ? "host_interrupted" : "runtime_interrupted", undefined, { runId: row.id,
          operationRef: row.kind === "provider" ? this.providerConfig(row).providerRequest.operationRef : row.submission_operation_ref ?? undefined });
        const prior = RunCleanupRecordSchema.safeParse(decoded(row.cleanup_json));
        const intentFacts = this.verifyPriorIntentFacts(row.id,true,time);
        const inputFacts = this.verifyPriorInputFacts(row.id,true,time);
        const treeProof = prior.success && prior.data.processTreeProof || stopProofForOwner(processTreeProof, row.instance_id);
        const facts = row.kind === 'agent' && this.p3 ? this.verifyPriorToolFacts(row.id, true, time, treeProof) : null;
        const contextFacts = this.verifyPriorContextFacts(row.id);
        const historyFacts = this.verifyPriorHistoryFacts(row.id);
        const extension=prior.success?prior.data.extensions:undefined;
        const exitedExtension=extension?{...extension,state:'disposed' as const,resourcesReleased:true,disposedAt:extension.disposedAt??time}:undefined;
        const extensionReleaseBasis=!extension&&this.readRunExtensions(row.id)?.selection.extension
          ?(prior.success?prior.data.extensionReleaseBasis:undefined)??'owner_process_exited' as const:undefined;
        const extensionReleased=!this.readRunExtensions(row.id)?.selection.extension||!!exitedExtension||!!extensionReleaseBasis;
        const cleanup = facts ? checked(RunCleanupRecordSchema, {
          contract: 'medclaw.run-cleanup/v1', executionStarted: prior.success ? prior.data.executionStarted : null,
          stopConfirmed: facts.stopConfirmed, requiredPersistenceComplete: facts.requiredPersistenceComplete && intentFacts.requiredPersistenceComplete && inputFacts.requiredPersistenceComplete && contextFacts.requiredPersistenceComplete && historyFacts.requiredPersistenceComplete,
          inputsSettled: inputFacts.inputsSettled, resourcesReleased: facts.stopConfirmed===true&&extensionReleased, unconfirmedItems: [...facts.unconfirmedItems,...intentFacts.unconfirmedItems,...inputFacts.unconfirmedItems,...contextFacts.unconfirmedItems,...historyFacts.unconfirmedItems,...(extensionReleased?[]:['resources','extension_cleanup'])],
          ...(exitedExtension?{extensions:exitedExtension}:{}),
          ...(extensionReleaseBasis?{extensionReleaseBasis}:{}),
          ...(treeProof ? { processTreeProof: treeProof } : {}),
          secondaryErrors: prior.success ? prior.data.secondaryErrors : [], verifiedAt: facts.stopConfirmed === true&&extensionReleased ? time : null,
          ...(prior.success && prior.data.budgetSummary !== undefined ? { budgetSummary: prior.data.budgetSummary } : {}),
        }) : { previousInstanceId: row.instance_id, oldProcessExited: true, observationGap: true };
        if (row.kind === "provider") this.db.query("UPDATE model_calls SET state='failed',error_json=?,unavailable_reason='host_interrupted' WHERE run_id=? AND state='started'")
          .run(JSON.stringify(error), row.id);
        this.db.query(`UPDATE runs SET status='failed',ended_at=?,error_json=?,cleanup_json=?
          WHERE id=? AND status IN ('created','running')`)
          .run(time, JSON.stringify(error), JSON.stringify(cleanup), row.id);
        this.runTerminal(row,'failed',error,cleanup,time);
      }
      if (rows.length) this.beforeCommit?.();
      return rows.length;
    });
  }
}
