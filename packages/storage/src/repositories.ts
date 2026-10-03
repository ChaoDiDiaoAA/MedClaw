import type { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema, safeError, type AppError } from "../../contracts/src/error";
import { ToolSdkDeliverySchema } from "../../contracts/src/tool";
import { ToolControlObservationSchema } from "../../contracts/src/model";
import { SqliteInputStore } from "./input-store";
import { InputContentSchema, type PreparedInput, type InputStore, type InputCancelProof, type InputSettlementProof, type ReadInputRequest, type ListInputsRequest } from "../../contracts/src/session";
import { SqliteToolStore } from "./tool-store";
import { NewSessionInputSchema, NewSessionResultSchema, SelectSessionInputSchema, SessionViewSchema, ListSessionsRequestSchema, SubmitInputSchema, ReadSubmissionRequestSchema,
  type NewSessionInput, type NewSessionResult, type SelectSessionInput, type SessionView, type SessionPage, type ReadSubmissionRequest, type SubmitResult, type SessionStore } from "../../contracts/src/session";
import { WorkspaceViewSchema, WorkspaceChangeSchema, RevisionSchema, type WorkspaceView, type WorkspaceChange, type BatchRef } from "../../contracts/src/workspace";
import { businessToolSchemas } from "../../contracts/src/business-tools";
import { StoredToolConfigurationSchema } from '../../contracts/src/tool-config';
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
  toolConfiguration: StoredToolConfigurationSchema.optional(),
  runtimeConfiguration: RuntimeConfigurationSchema.optional(),
  agentPolicy: AgentPolicySchema.optional(),
  measurementContext: MeasurementContextSchema.optional(),
  toolProfileSnapshot: ToolProfileSnapshotSchema.optional(),
  referenceDate: z.string(), timezone: z.string(), agent: P2AgentOptionsSchema.extend({ stage: z.enum(["P2", "P3"]), nativeSessionId: OpaqueIdSchema,
    tools: z.array(z.string()), autoCompaction: z.literal(false), autoRetry: z.literal(false), cacheWarming: z.literal("off") }) });
const commonConfigSchema = z.object({ selection: ModelSelectionSchema, policy: RequestPolicySchema });
const savedDeliverySchema = z.object({ contract: z.literal("medclaw.tool-delivery/v1"), resultRecorded: z.boolean(), sdkReturned: z.boolean(),
  nativeEntryId: OpaqueIdSchema.nullable(), deliveredAt: TimestampSchema.nullable(), nextModelCallId: z.string().min(1).nullable(), consumedAt: TimestampSchema.nullable(),
  error: AppErrorSchema.nullable(), message: ToolSdkDeliverySchema.optional(), control: ToolControlObservationSchema.optional(),
  consumptionEvidence: z.literal("provider_input_verified").optional(),
});
const scope = { batchIds: [], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true };
type RunRow = {
  input_id: number | null; kind: "provider" | "agent"; session_id: number | null; submission_operation_ref: string | null;
  submission_client_sequence: number | null; submission_request_json: string | null;
  id: number; instance_id: string; status: RunView["status"]; goal: "answer" | "verify";
  input_text: string; output_text: string | null; config_json: string; prior_run_id: number | null;
  reference_date: string; timezone: string; created_at: string; started_at: string | null;
  cancel_requested_at: string | null; stopped_at: string | null; ended_at: string | null;
  error_json: string | null; cleanup_json: string | null; usage_json: string | null;
  scope_json: string;
};
type CallRow = {
  input_id: number | null; id: number; call_id: string; kind: "main" | "diagnostic"; model_json: string;
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
function json(value: unknown): string | null { return value == null ? null : JSON.stringify(value); }
function decoded(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return fail("storage_write_failed"); }
}
function id(value: number) { if (!Number.isSafeInteger(value) || value <= 0) fail("invalid_argument"); }
function timestamp(value: string | null) {
  if (value !== null && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) fail("invalid_argument");
}

export class Repositories implements ProviderRunStore, SessionStore {
  private readonly p3: boolean;
  private readonly inputs: SqliteInputStore;
  private readonly p5: boolean;
  constructor(private readonly db: Database, private readonly beforeCommit?: () => void) {
    this.inputs = new SqliteInputStore(db);
    this.p5 = db.query("SELECT name FROM sqlite_schema WHERE name='session_inputs'").get() !== null;
    this.p3 = this.db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name='answers'").get() !== null;
  }

  private creationReceipt(text: string): NewSessionResult {
    const value = decoded(text) as NewSessionResult;
    return checked(NewSessionResultSchema, {...value, session: {...value.session, inputControl: value.session.inputControl ?? null}}, "storage_read_failed");
  }
  private inputRead<T>(action:()=>T):T {try{return action();}catch(error){if(error instanceof Error&&error.name==='SQLiteError')fail('storage_read_failed');throw error;}}
  private inputWrite<T>(action:()=>T):T {try{return this.db.transaction(()=>{const result=action();this.beforeCommit?.();return result;}).immediate();}catch(error){if(error instanceof Error&&error.name==='SQLiteError')fail('storage_write_failed');throw error;}}
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
  acceptInput(plan:PreparedInput):SubmitResult {
    const request=checked(SubmitInputSchema,plan.originalSubmitInput),operationRef=checked(OpaqueIdSchema,plan.operationRef);
    return this.inputWrite(()=>{
      const operation=this.findOperation(operationRef),sequence=this.findSubmission({sessionId:request.sessionId,clientSequence:request.clientSequence});
      if(operation||sequence){if(!operation||operation.method!=='session.submit'||!sequence||operation.result.inputId!==sequence.inputId||operation.result.runId!==sequence.runId||operation.result.sessionId!==sequence.sessionId||operation.result.clientSequence!==sequence.clientSequence||canonicalRequest(operation.originalRequest)!==canonicalRequest(request))fail('state_conflict');return sequence;}
      const content=checked(InputContentSchema,plan.content);timestamp(plan.createdAt);
      if(canonicalRequest(content.originalSubmitInput)!==canonicalRequest(request)||content.deliveryAttempt!==null||content.text!==request.text||content.referenceDate!==request.referenceDate||content.timezone!==request.timezone||content.model.provider!==request.model.provider||content.model.modelId!==request.model.modelId||content.model.configVersion!==request.model.expectedConfigVersion||plan.execution.mode!==request.mode)fail('invalid_argument');
      const session=this.readSession(request.sessionId);if(!session)fail('session_not_found');
      if(request.clientSequence<session.nextSubmissionSequence||request.clientSequence===Number.MAX_SAFE_INTEGER)fail('state_conflict');
      const workspace=this.readWorkspace();if(workspace.sessionId!==session.id||workspace.revision!==request.expectedRevision||!isDeepStrictEqual(workspace,content.workspaceContext)||!isDeepStrictEqual(workspace.batchRefs.map(b=>b.id),request.expectedBatchIds)||workspace.queryId!==request.expectedQueryId)fail('workspace_revision_mismatch');
      if(this.p3)for(const batch of workspace.batchRefs){
        const row=this.db.query<{metadata_json:string},[number]>('SELECT metadata_json FROM batches WHERE id=?').get(batch.id);
        const metadata=checked(z.object({referenceDate:ReferenceDateSchema,timezone:TimezoneSchema}),decoded(row?.metadata_json??null),'storage_read_failed');
        if(request.timezone!==metadata.timezone)fail('invalid_argument');
      }
      let target:number|null=null;
      if(plan.execution.mode==='send'){
        if(this.active())fail('runtime_busy');const run=plan.execution.run;
        if(run.sessionId!==session.id||run.goal!=='answer'||run.text!==content.text||run.referenceDate!==content.referenceDate||run.timezone!==content.timezone||run.timeoutMs!==run.policy.timeoutMs||!isDeepStrictEqual(run.workspace,workspace)||!isDeepStrictEqual(run.scope,content.scope)||!isDeepStrictEqual(run.model,content.model)||!isDeepStrictEqual(this.freezeAgentScope(workspace,run.scope.allowedToolNames),run.scope))fail('invalid_argument');
      }else{
        if(request.mode==='send'||request.targetRunId!==plan.execution.targetRunId)fail('invalid_argument');target=plan.execution.targetRunId;const run=this.row(target),active=this.active();
        if(!run||run.kind!=='agent'||run.session_id!==session.id||!active||active.runId!==target)fail('state_conflict');
        const root=checked(agentConfigSchema,decoded(run.config_json),'storage_read_failed'),scope=checked(RunScopeSchema,decoded(run.scope_json),'storage_read_failed');
        if(!isDeepStrictEqual(root.selection,content.model)||run.reference_date!==content.referenceDate||run.timezone!==content.timezone||content.scope.batchIds.some(b=>!scope.batchIds.includes(b))||scope.deviceIds!==null&&(content.scope.deviceIds===null||content.scope.deviceIds.some(d=>!scope.deviceIds!.includes(d)))||content.scope.allowedToolNames.some(t=>!scope.allowedToolNames.includes(t))||content.scope.allowedResourceRefs.some(r=>!scope.allowedResourceRefs.includes(r))||content.scope.artifactIds.some(a=>!scope.artifactIds.includes(a))||scope.readOnly&&!content.scope.readOnly)fail('access_denied');
      }
      const saved=this.db.query("INSERT INTO session_inputs(session_id,client_sequence,operation_ref,mode,status,content_json,target_run_id,run_id,error_json,created_at,delivered_at,processed_at,updated_at,processing_status,native_entry_id) VALUES(?,?,?,?,'queued',?,?,NULL,NULL,?,NULL,NULL,?,'pending',NULL)").run(session.id,request.clientSequence,operationRef,request.mode,canonicalRequest(content),target,plan.createdAt,plan.createdAt);
      const inputId=Number(saved.lastInsertRowid);
      if(plan.execution.mode==='send'){
        const run=plan.execution.run;checked(OpaqueIdSchema,run.instanceId);timestamp(run.createdAt);
        const config=checked(agentConfigSchema,{selection:run.model,policy:run.policy,referenceDate:run.referenceDate,timezone:run.timezone,...(run.agentPolicy?{agentPolicy:run.agentPolicy}:{}),...(run.runtimeConfiguration?{runtimeConfiguration:run.runtimeConfiguration}:{}),...(run.toolConfiguration?{toolConfiguration:run.toolConfiguration}:{}),...(run.measurementContext?{measurementContext:run.measurementContext}:{}),...(run.toolProfileSnapshot?{toolProfileSnapshot:run.toolProfileSnapshot}:{}),agent:{...run.agentOptions,stage:run.scope.allowedToolNames.length?'P3':'P2',nativeSessionId:session.nativeSessionId,tools:run.scope.allowedToolNames,autoCompaction:false,autoRetry:false,cacheWarming:'off'}});
        const r=this.db.query("INSERT INTO runs(session_id,input_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at) VALUES(?,?,'agent',?,NULL,NULL,NULL,'created','answer',?,?,?,?,?,?,?)").run(session.id,inputId,run.instanceId,content.text,JSON.stringify(config),JSON.stringify(run.scope),JSON.stringify(workspace),run.referenceDate,run.timezone,run.createdAt);target=Number(r.lastInsertRowid);
        this.db.query('UPDATE session_inputs SET target_run_id=? WHERE id=? AND target_run_id IS NULL').run(target,inputId);
      }
      return this.inputs.result(this.inputs.required(inputId));
    });
  }

  private row(runId: number): RunRow | null {
    return this.db.query<RunRow, [number]>("SELECT * FROM runs WHERE id=?").get(runId);
  }
  private config(row: RunRow) { return checked(commonConfigSchema, decoded(row.config_json), "storage_read_failed"); }
  private providerConfig(row: RunRow) { return checked(providerConfigSchema, decoded(row.config_json), "storage_read_failed"); }
  private calls(runId: number): ModelCallView[] {
    return this.db.query<CallRow, [number]>("SELECT * FROM model_calls WHERE run_id=? ORDER BY id").all(runId).map((row) => {
      const model = checked(z.object({
        selection: ModelSelectionSchema, responseModel: z.string().nullable(),
        sdkStopReason: z.enum(["stop", "length", "toolUse", "error", "aborted", "deferred"]).nullable(),
      }).strict(), decoded(row.model_json), "storage_write_failed");
      return checked(ModelCallViewSchema, {
        id: row.id, inputId: row.input_id, callId: row.call_id, kind: row.kind, state: row.state,
        granularity: row.granularity, attempt: row.attempt, attemptCountUnknown: row.attempt_count_unknown === 1,
        model: model.selection, responseModel: model.responseModel, sdkStopReason: model.sdkStopReason,
        startedAt: row.started_at, endedAt: row.ended_at, durationMs: row.duration_ms,
        inputTokens: row.input_tokens, outputTokens: row.output_tokens, cost: row.cost, costCurrency: row.cost_currency,
        usageSource: row.usage_source, unavailableReason: row.unavailable_reason, error: decoded(row.error_json),
      }, "storage_write_failed");
    });
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
    const agent = row.kind === "agent" ? checked(agentConfigSchema, decoded(row.config_json), "storage_read_failed") : null;
    return checked(RunViewSchema, {
      id: row.id, kind: row.kind, status: row.status, operationRef: row.kind === "provider" ? this.providerConfig(row).providerRequest.operationRef : rootInput?.operation_ref ?? row.submission_operation_ref,
      instanceId: row.instance_id, sessionId: row.session_id, inputId: row.input_id, goal: row.goal, inputText: inputPage.text, inputPage,
      model: config.selection, policy: config.policy, priorRunId: row.prior_run_id,
      ...(row.kind === 'provider' ? { runtimeConfiguration: this.providerConfig(row).runtimeConfiguration ?? null } : {}),
      referenceDate: row.reference_date, timezone: row.timezone, createdAt: row.created_at,
      startedAt: row.started_at, cancelRequestedAt: row.cancel_requested_at, stoppedAt: row.stopped_at,
      endedAt: row.ended_at, error: decoded(row.error_json), cleanup: cleanup.success ? cleanup.data : null,
      answerRef: this.p3 ? this.db.query<{ id: number }, [number]>("SELECT id FROM answers WHERE run_id=?").get(row.id)?.id ?? null : null,
      output,
      calls: row.kind === "provider" ? calls : calls.slice(callOffset, callOffset + callLimit), persistence: "committed",
      ...(agent ? { clientSequence: rootInput?.client_sequence ?? row.submission_client_sequence, nativeSessionId: agent.agent.nativeSessionId,
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

  findOperation(operationRef: string): StoredOperation | null {
    checked(OpaqueIdSchema, operationRef);
    if(this.p5){const count=this.db.query<{n:number},[string]>("SELECT COUNT(*) AS n FROM (SELECT id FROM sessions WHERE creation_operation_ref=?1 UNION ALL SELECT id FROM runs WHERE submission_operation_ref=?1 OR (kind='provider' AND json_extract(config_json,'$.providerRequest.operationRef')=?1) UNION ALL SELECT id FROM session_inputs WHERE operation_ref=?1)").get(operationRef)!.n;if(count>1)fail('state_conflict');}
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

  readWorkspace(): WorkspaceView {
    const row = this.db.query<{ active_session_id: number | null; revision: number; material_version: string | null;
      batch_refs_json: string; device_ids_json: string; active_query_id: number | null; active_view: string; selection_json: string | null }, []>("SELECT * FROM workspace WHERE id=1").get();
    if (!row) fail("storage_read_failed");
    return checked(WorkspaceViewSchema, { revision: row.revision, sessionId: row.active_session_id, materialVersion: row.material_version ?? null,
      batchRefs: row.batch_refs_json === undefined ? [] : decoded(row.batch_refs_json), deviceIds: row.device_ids_json === undefined ? [] : decoded(row.device_ids_json),
      queryId: row.active_query_id ?? null, activeView: row.active_view ?? "data", selection: row.selection_json === undefined ? null : decoded(row.selection_json) }, "storage_read_failed");
  }

  private batchReferences(ids: number[]): { refs: BatchRef[]; materialVersion: string | null } {
    const rows = ids.map(batchId => {
      const row = this.db.query<{ id: number; content_hash: string; snapshot_date: string; scope_key: string; material_version: string }, [number]>(
        "SELECT id,content_hash,snapshot_date,scope_key,material_version FROM batches WHERE id=?").get(batchId);
      if (!row) fail("access_denied");
      return row;
    });
    const versions = new Set(rows.map(row => row.material_version));
    if (versions.size > 1) fail("invalid_argument");
    return { refs: rows.map(row => ({ id: row.id, contentHash: row.content_hash, snapshotDate: row.snapshot_date, scopeKey: row.scope_key })),
      materialVersion: rows[0]?.material_version ?? null };
  }

  updateWorkspace(change: WorkspaceChange, expectedRevision: number, time: string): WorkspaceView {
    const request = checked(WorkspaceChangeSchema, change); checked(RevisionSchema, expectedRevision); timestamp(time);
    return this.db.transaction(() => {
      const old = this.readWorkspace();
      if (old.revision !== expectedRevision) fail("workspace_revision_mismatch");
      const batchIds = request.batchIds ?? old.batchRefs.map(batch => batch.id), batches = this.batchReferences(batchIds);
      const deviceIds = request.deviceIds ?? old.deviceIds;
      for (const deviceId of deviceIds) {
        if (!batchIds.some(batchId => this.db.query("SELECT id FROM snapshots WHERE batch_id=? AND device_id=?").get(batchId, deviceId))) fail("access_denied");
      }
      const queryId = request.queryId !== undefined ? request.queryId : request.batchIds !== undefined || request.deviceIds !== undefined ? null : old.queryId;
      if (queryId !== null) {
        const query = this.db.query<{ session_id: number; batch_ids_json: string; result_json: string }, [number]>("SELECT session_id,batch_ids_json,result_json FROM queries WHERE id=?").get(queryId);
        const queryBatches = query ? checked(z.array(PositiveIdSchema), decoded(query.batch_ids_json), "storage_read_failed") : [];
        const result = query ? checked(z.object({ scopeDeviceIds: z.array(PositiveIdSchema).nullable() }), decoded(query.result_json), "storage_read_failed") : null;
        if (!query || query.session_id !== old.sessionId || queryBatches.some(batchId => !batchIds.includes(batchId))
          || deviceIds.length > 0 && (result?.scopeDeviceIds === null || result?.scopeDeviceIds.some(deviceId => !deviceIds.includes(deviceId)))) fail("access_denied");
      }
      const next = checked(WorkspaceViewSchema, { ...old, batchRefs: batches.refs, materialVersion: batches.materialVersion, deviceIds, queryId,
        activeView: request.activeView ?? old.activeView, selection: null });
      if (isDeepStrictEqual(old, next)) return old;
      next.revision++;
      const saved = this.db.query(`UPDATE workspace SET material_version=?,batch_refs_json=?,device_ids_json=?,active_query_id=?,active_view=?,selection_json=NULL,
        revision=?,updated_at=? WHERE id=1 AND revision=?`).run(next.materialVersion, JSON.stringify(next.batchRefs), JSON.stringify(next.deviceIds), next.queryId,
          next.activeView, next.revision, time, expectedRevision);
      if (saved.changes !== 1) fail("workspace_revision_mismatch");
      this.beforeCommit?.();
      return next;
    }).immediate();
  }

  freezeAgentScope(workspace: WorkspaceView, toolNames: readonly string[]): RunScope {
    const selected = checked(WorkspaceViewSchema, workspace), ids = selected.batchRefs.map(batch => batch.id);
    const batches = this.batchReferences(ids);
    if (!isDeepStrictEqual(batches.refs, selected.batchRefs) || batches.materialVersion !== selected.materialVersion) fail("access_denied");
    const names = [...toolNames], supported = new Set([...Object.keys(businessToolSchemas), "read", "grep", "find", "ls", "edit", "write", "bash", "powershell"]);
    if (new Set(names).size !== names.length || names.some(name => !supported.has(name))) fail("invalid_argument");
    for (const deviceId of selected.deviceIds) {
      if (!ids.some(batchId => this.db.query("SELECT id FROM snapshots WHERE batch_id=? AND device_id=?").get(batchId, deviceId))) fail("access_denied");
    }
    const artifacts = ids.flatMap(batchId => {
      const row = this.db.query<{ artifact_id: number | null }, [number]>("SELECT i.artifact_id FROM batches b JOIN imports i ON i.id=b.import_id WHERE b.id=?").get(batchId);
      return row?.artifact_id === null || row === null ? [] : [row.artifact_id];
    });
    return { batchIds: [...ids], deviceIds: selected.deviceIds.length ? [...selected.deviceIds] : null, allowedToolNames: names,
      allowedResourceRefs: [], artifactIds: [...new Set(artifacts)], readOnly: !names.some(name => ["edit", "write", "bash", "powershell"].includes(name)) };
  }

  readSession(sessionId: number): SessionView | null {
    id(sessionId);
    const row = this.db.query<{ id: number; native_session_id: string; title: string; kind: string; status: string; storage_version: number }, [number]>("SELECT * FROM sessions WHERE id=?").get(sessionId);
    if (!row) return null;
    const sequence = this.db.query<{ n: number | null }, [number]>(this.p5 ? "SELECT MAX(n) AS n FROM (SELECT submission_client_sequence AS n FROM runs WHERE session_id=?1 UNION ALL SELECT client_sequence AS n FROM session_inputs WHERE session_id=?1)" : "SELECT MAX(submission_client_sequence) AS n FROM runs WHERE session_id=?").get(sessionId)?.n ?? 0;
    return checked(SessionViewSchema, { id: row.id, title: row.title, nativeSessionId: row.native_session_id, kind: row.kind, status: row.status,
      inputControl: null, storageVersion: row.storage_version, leafId: null, nextSubmissionSequence: sequence + 1 }, "storage_read_failed");
  }

  listSessions(input: { beforeSessionId?: number; limit?: number }): SessionPage {
    const request = checked(ListSessionsRequestSchema, input);
    const rows = this.db.query<{ id: number }, [number, number]>("SELECT id FROM sessions WHERE id<? ORDER BY id DESC LIMIT ?")
      .all(request.beforeSessionId ?? Number.MAX_SAFE_INTEGER, request.limit + 1), page = rows.slice(0, request.limit);
    return { sessions: page.map(row => this.readSession(row.id)!), nextBeforeSessionId: rows.length > request.limit ? page.at(-1)!.id : null };
  }

  createSession(input: NewSessionInput, operationRef: string, nativeSessionId: string, time: string): NewSessionResult {
    const request = checked(NewSessionInputSchema, input); checked(OpaqueIdSchema, operationRef); checked(OpaqueIdSchema, nativeSessionId); timestamp(time);
    return this.db.transaction(() => {
      const existing = this.findOperation(operationRef);
      if (existing) {
        if (existing.method !== "session.create" || canonicalRequest(existing.originalRequest) !== canonicalRequest(request)) fail("state_conflict");
        return existing.result;
      }
      const workspace = this.readWorkspace();
      if (workspace.revision !== request.expectedWorkspaceRevision) fail("workspace_revision_mismatch");
      const sessionId = (this.db.query<{ n: number | null }, []>("SELECT MAX(id) AS n FROM sessions").get()?.n ?? 0) + 1;
      checked(PositiveIdSchema, sessionId);
      const result = checked(NewSessionResultSchema, { session: { id: sessionId, title: `New Session ${sessionId}`, nativeSessionId,
        kind: "user", status: "active", inputControl: null, storageVersion: 0, leafId: null, nextSubmissionSequence: 1 },
        workspace: { ...workspace, sessionId, queryId: null, selection: null, revision: workspace.revision + 1 } });
      this.db.query(`INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(sessionId, nativeSessionId, operationRef, canonicalRequest(request), JSON.stringify(result), result.session.title, time, time);
      this.db.query(`UPDATE workspace SET active_session_id=?,revision=?,updated_at=?${this.p3 ? ',active_query_id=NULL,selection_json=NULL' : ''} WHERE id=1 AND revision=?`)
        .run(sessionId, result.workspace.revision, time, workspace.revision);
      this.beforeCommit?.();
      return result;
    }).immediate();
  }

  selectSession(input: SelectSessionInput, time: string): WorkspaceView {
    const request = checked(SelectSessionInputSchema, input); timestamp(time);
    return this.db.transaction(() => {
      const workspace = this.readWorkspace();
      if (workspace.revision !== request.expectedWorkspaceRevision) fail("workspace_revision_mismatch");
      if (!this.readSession(request.sessionId)) fail("session_not_found");
      if (workspace.sessionId === request.sessionId) return workspace;
      const selected = checked(WorkspaceViewSchema, { ...workspace, sessionId: request.sessionId, queryId: null, selection: null, revision: workspace.revision + 1 });
      this.db.query(`UPDATE workspace SET active_session_id=?,revision=?,updated_at=?${this.p3 ? ',active_query_id=NULL,selection_json=NULL' : ''} WHERE id=1 AND revision=?`)
        .run(request.sessionId, selected.revision, time, workspace.revision);
      this.beforeCommit?.();
      return selected;
    }).immediate();
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
      checked(agentConfigSchema, JSON.parse(row.config_json), "storage_read_failed");
      if (original.sessionId !== row.session_id || original.clientSequence !== row.submission_client_sequence) fail("storage_read_failed");
      return this.submissionResult(row);
    } catch { return fail("storage_read_failed"); }
  }

  readMessageLinks(sessionId: number, nativeEntryIds: readonly string[]): Map<string, { runId: number; toolCallRef: string; references: string[] }> {
    id(sessionId);
    checked(z.array(OpaqueIdSchema).max(100), nativeEntryIds);
    const links = new Map<string, { runId: number; toolCallRef: string; references: string[] }>();
    if (!nativeEntryIds.length) return links;
    try {
      // ponytail: Validate O(target Session saved receipts) so corrupt envelopes cannot vanish through JSON filtering; indexed history belongs to P9.
      const receipts = this.db.query<{ id: number; native_tool_call_id: string; tool_name: string; delivery_json: string }, [number]>(
        "SELECT id,native_tool_call_id,tool_name,delivery_json FROM tool_calls WHERE session_id=? AND delivery_json IS NOT NULL").all(sessionId);
      for (const row of receipts) {
        const saved = checked(savedDeliverySchema, JSON.parse(row.delivery_json), "storage_read_failed");
        if (saved.sdkReturned && (saved.nativeEntryId === null || saved.deliveredAt === null || !saved.resultRecorded)
          || saved.message && (saved.message.toolCallId !== row.native_tool_call_id || saved.message.toolName !== row.tool_name)) fail("storage_read_failed");
      }
      const rows = this.db.query<{ id: number; run_id: number; native_tool_call_id: string; native_entry_id: string; query_id: number | null }, [string, number]>(
        `SELECT t.id,t.run_id,t.native_tool_call_id,json_extract(t.delivery_json,'$.nativeEntryId') AS native_entry_id,q.id AS query_id
         FROM tool_calls t JOIN runs r ON r.id=t.run_id AND r.session_id=t.session_id AND r.kind='agent'
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
            if (evidence.resultHash !== query.resultHash || evidence.calculationVersion !== query.calculationVersion) fail("storage_read_failed");
            if (references.length < 16) references.push(`evidence:${evidence.id}`);
          }
        }
        links.set(row.native_entry_id, { runId: row.run_id, toolCallRef: row.native_tool_call_id, references });
      }
      return links;
    } catch { return fail("storage_read_failed"); }
  }

  registerAgent(input: RegisterAgentInput): Extract<SubmitResult,{inputId:null}> {
    if(input.submission === null || input.inputId !== null) fail("invalid_argument");
    const request = checked(SubmitInputSchema, input.submission.originalSubmitInput), operationRef = checked(OpaqueIdSchema, input.submission.operationRef); timestamp(input.createdAt);
    return this.db.transaction(() => {
      const operation = this.findOperation(operationRef), sequence = this.findSubmission({ sessionId: request.sessionId, clientSequence: request.clientSequence });
      if (operation || sequence) {
        if (!operation || operation.method !== "session.submit" || !sequence || operation.result.runId !== sequence.runId
          || canonicalRequest(operation.originalRequest) !== canonicalRequest(request)) fail("state_conflict");
        if(sequence.inputId!==null)fail("state_conflict");return sequence;
      }
      const session = this.readSession(request.sessionId);
      if (!session) fail("session_not_found");
      if (request.clientSequence < session.nextSubmissionSequence || request.clientSequence === Number.MAX_SAFE_INTEGER) fail("state_conflict");
      const workspace = this.readWorkspace();
      if (workspace.sessionId !== session.id || workspace.revision !== request.expectedRevision || !isDeepStrictEqual(workspace, input.workspace)) fail("workspace_revision_mismatch");
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
      const config = checked(agentConfigSchema, { selection: input.model, policy: input.policy, referenceDate: request.referenceDate,
        ...(input.agentPolicy ? { agentPolicy: input.agentPolicy } : {}),
        ...(input.runtimeConfiguration ? { runtimeConfiguration: input.runtimeConfiguration } : {}),
        ...(input.toolConfiguration ? { toolConfiguration: input.toolConfiguration } : {}),
        ...(input.measurementContext ? { measurementContext: input.measurementContext } : {}),
        ...(input.toolProfileSnapshot ? { toolProfileSnapshot: input.toolProfileSnapshot } : {}),
        timezone: request.timezone, agent: { ...input.agentOptions, stage: input.scope.allowedToolNames.length ? "P3" : "P2", nativeSessionId: session.nativeSessionId, tools: input.scope.allowedToolNames,
          autoCompaction: false, autoRetry: false, cacheWarming: "off" } });
      const result = this.db.query(`INSERT INTO runs(session_id,input_id,kind,instance_id,submission_operation_ref,submission_client_sequence,
        submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at)
        VALUES(?,NULL,'agent',?,?,?,?,'created','answer',?,?,?,?,?,?,?)`)
        .run(session.id, input.instanceId, operationRef, request.clientSequence, canonicalRequest(request), request.text, JSON.stringify(config),
          JSON.stringify(input.scope), JSON.stringify(workspace), request.referenceDate, request.timezone, input.createdAt);
      this.beforeCommit?.();
      return { sessionId: session.id, clientSequence: request.clientSequence, inputId: null, runId: Number(result.lastInsertRowid) };
    }).immediate();
  }

  registerProvider(input: RegisterProviderInput): ProviderAccepted {
    const originalRequest = input.method === "model.request" ? checked(ProviderRequestSchema, input.originalRequest) : checked(DiagnoseRequestSchema, input.originalRequest);
    if (!input.operationRef || input.operationRef.length > 512) fail("invalid_argument");
    return this.db.transaction(() => {
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
    }).immediate();
  }

  startCall(runId: number, callId: string, kind: "main" | "diagnostic", time: string): void {
    id(runId); timestamp(time);
    if (!callId || callId.length > 512) fail("invalid_argument");
    this.db.transaction(() => {
      const row = this.row(runId);
      if (!row || row.status !== "created" && !(row.kind === "agent" && row.status === "running")) fail("state_conflict");
      if (row.kind === "provider" && this.calls(runId).length) fail("state_conflict");
      if (kind !== (row.goal === "verify" ? "diagnostic" : "main")) fail("invalid_argument");
      if (row.status === "created") {
        const changed = this.db.query("UPDATE runs SET status='running',started_at=? WHERE id=? AND status='created'").run(time, runId);
        if (changed.changes !== 1) fail("state_conflict");
      }
      this.db.query(`INSERT INTO model_calls(call_id,run_id,session_id,input_id,kind,attempt,granularity,
        attempt_count_unknown,model_json,state,started_at,ended_at,duration_ms,input_tokens,output_tokens,
        cost,cost_currency,usage_source,unavailable_reason,error_json)
        VALUES(?,?,?,?,?,1,'logical_request',1,?,'started',?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`)
        .run(callId, runId, row.session_id, row.input_id, kind, JSON.stringify({ selection: this.config(row).selection, responseModel: null, sdkStopReason: null }), time);
      this.beforeCommit?.();
    }).immediate();
  }

  requestCancel(runId: number, time: string): boolean {
    id(runId); timestamp(time);
    return this.db.transaction(() => {
      if (!this.row(runId)) fail("state_conflict");
      const result = this.db.query(`UPDATE runs SET cancel_requested_at=COALESCE(cancel_requested_at,?)
        WHERE id=? AND status IN ('created','running')`).run(time, runId);
      if (result.changes) this.beforeCommit?.();
      return result.changes > 0;
    }).immediate();
  }

  finalizeProvider(runId: number, fact: FinalProviderFact): RunView {
    return this.finalize(runId, fact, fact.call ? [fact.call] : [], "provider");
  }
  finalizeAgent(runId: number, fact: FinalAgentFact): RunView {
    return this.finalize(runId, fact, fact.calls, "agent");
  }
  private validateCleanup(previous: unknown, input: RunCleanupRecord): RunCleanupRecord {
    const next = checked(RunCleanupRecordSchema, input), old = RunCleanupRecordSchema.safeParse(previous);
    if (old.success) {
      if (next.budgetSummary == null && old.data.budgetSummary != null) next.budgetSummary = old.data.budgetSummary;
      for (const key of ["executionStarted", "stopConfirmed", "requiredPersistenceComplete", "inputsSettled", "resourcesReleased"] as const) {
        if (old.data[key] === true && next[key] !== true || key === "executionStarted" && old.data[key] === false && next[key] !== false) fail("state_conflict");
      }
      if (old.data.verifiedAt && (!next.verifiedAt || Date.parse(next.verifiedAt) < Date.parse(old.data.verifiedAt))) fail("state_conflict");
      if (old.data.secondaryErrors.some(error => !next.secondaryErrors.some(item => isDeepStrictEqual(item, error)))) fail("state_conflict");
    }
    return next;
  }
  private finalize(runId: number, fact: FinalProviderFact, finalCalls: import("../../contracts/src/run").FinalCallFact[], kind: "provider" | "agent"): RunView {
    id(runId); timestamp(fact.endedAt); timestamp(fact.stoppedAt); timestamp(fact.cancelRequestedAt ?? null);
    if (!["completed", "failed", "cancelled"].includes(fact.status)) fail("invalid_argument");
    checked(z.string().nullable(), fact.outputText);
    const error = fact.error === null ? null : checked(AppErrorSchema, fact.error);
    let cleanup = fact.cleanup == null ? null : checked(z.union([cleanupSchema, RunCleanupRecordSchema]), fact.cleanup);
    const usage = fact.usage == null ? null : checked(usageSchema, fact.usage);
    return this.db.transaction(() => {
      const row = this.row(runId);
      if (!row || row.kind !== kind) fail("state_conflict");
      const calls = this.calls(runId);
      if (calls.length !== finalCalls.length || new Set(finalCalls.map(call => call.callId)).size !== finalCalls.length) fail("state_conflict");
      const cancelRequestedAt = fact.cancelRequestedAt ?? row.cancel_requested_at;
      if (fact.cancelRequestedAt && row.cancel_requested_at && fact.cancelRequestedAt !== row.cancel_requested_at) fail("state_conflict");
      if (fact.status === "cancelled" && !cancelRequestedAt || fact.status === "completed" && !calls.length) fail("invalid_argument");
      const terminal = row.status !== "created" && row.status !== "running";
      if (terminal && (row.status !== fact.status || row.output_text !== null && row.output_text !== fact.outputText
        || row.stopped_at !== null && row.stopped_at !== fact.stoppedAt || !isDeepStrictEqual(decoded(row.error_json), error)
        || row.usage_json !== null && !isDeepStrictEqual(decoded(row.usage_json), usage))) fail("state_conflict");
      if(kind==='agent' && this.p5){
        const proof=(fact as FinalAgentFact & {inputSettlement?:InputSettlementProof}).inputSettlement;
        if(this.inputs.hasInputsForRun(runId)){if(!proof)fail('state_conflict');this.inputs.settleRunInputs(runId,fact.status,fact.endedAt,proof);}
        if(cleanup&&'contract'in cleanup)cleanup={...cleanup,inputsSettled:!this.inputs.hasPendingInputsForRun(runId)};
      }
      if (cleanup && "contract" in cleanup) cleanup = this.validateCleanup(decoded(row.cleanup_json), cleanup);
      else if (terminal && !isDeepStrictEqual(decoded(row.cleanup_json), cleanup)) fail("state_conflict");
      for (const original of calls) {
        const incoming = finalCalls.find(call => call.callId === original.callId);
        if (!incoming) fail("state_conflict");
        if("inputId" in incoming && incoming.inputId !== row.input_id) fail("state_conflict");
        const finalCall = checked(ModelCallViewSchema, { ...original, ...incoming });
        if (finalCall.state === "started") fail("invalid_argument");
        if (original.state !== "started") {
          if (!isDeepStrictEqual(original, finalCall)) fail("state_conflict");
          continue;
        }
        const result = this.db.query(`UPDATE model_calls SET state=?,model_json=?,ended_at=?,duration_ms=?,input_tokens=?,
          output_tokens=?,cost=?,cost_currency=?,usage_source=?,unavailable_reason=?,error_json=? WHERE run_id=? AND call_id=? AND state='started'`)
          .run(finalCall.state, JSON.stringify({ selection: original.model, responseModel: finalCall.responseModel, sdkStopReason: finalCall.sdkStopReason }),
            finalCall.endedAt, finalCall.durationMs, finalCall.inputTokens, finalCall.outputTokens, finalCall.cost, finalCall.costCurrency,
            finalCall.usageSource, finalCall.unavailableReason, json(finalCall.error), runId, finalCall.callId);
        if (result.changes !== 1) fail("state_conflict");
      }
      this.db.query(`UPDATE runs SET status=?,output_text=?,stopped_at=COALESCE(stopped_at,?),ended_at=COALESCE(ended_at,?),cancel_requested_at=?,
        error_json=?,cleanup_json=?,usage_json=? WHERE id=?`)
        .run(terminal ? row.status : fact.status, row.output_text ?? fact.outputText, fact.stoppedAt, fact.endedAt, cancelRequestedAt,
          terminal ? row.error_json : json(error), json(cleanup), row.usage_json ?? json(usage), runId);
      if (this.p3 && row.kind === "agent" && fact.status === "completed" && checked(agentConfigSchema, decoded(row.config_json), "storage_read_failed").agent.stage === "P3") {
        const frozen = checked(RunScopeSchema, decoded(row.scope_json), "storage_read_failed");
        const queries = this.db.query<{ id: number; session_id: number; batch_ids_json: string; result_json: string }, [number]>(
          "SELECT id,session_id,batch_ids_json,result_json FROM queries WHERE run_id=? ORDER BY id").all(runId);
        for (const query of queries) {
          const batches = checked(z.array(PositiveIdSchema), decoded(query.batch_ids_json), "storage_read_failed");
          const result = checked(z.object({ scopeDeviceIds: z.array(PositiveIdSchema).nullable() }), decoded(query.result_json), "storage_read_failed");
          if (query.session_id !== row.session_id || batches.some(batch => !frozen.batchIds.includes(batch))
            || frozen.deviceIds !== null && (result.scopeDeviceIds === null || result.scopeDeviceIds.some(device => !frozen.deviceIds!.includes(device)))) fail("access_denied");
        }
        const queryIds = queries.map(query => query.id), text = fact.outputText ?? "";
        const priorAnswer = this.db.query<{ id: number; text: string; query_ids_json: string }, [number]>("SELECT id,text,query_ids_json FROM answers WHERE run_id=?").get(runId);
        if (priorAnswer) {
          if (priorAnswer.text !== text || !isDeepStrictEqual(decoded(priorAnswer.query_ids_json), queryIds)) fail("state_conflict");
        } else {
          const saved = this.db.query("INSERT INTO answers(run_id,session_id,input_id,kind,text,query_ids_json,missing_slots_json,native_leaf_id,created_at) VALUES(?,?,?,'result',?,?,'[]',NULL,?)")
            .run(runId, row.session_id, row.input_id, text, JSON.stringify(queryIds), fact.endedAt);
          this.db.query("INSERT INTO business_events(operation_ref,type,actor,session_id,run_id,details_json,occurred_at) VALUES(?,'answer_committed','agent',?,?,?,?)")
            .run(`answer:${runId}`, row.session_id, runId, JSON.stringify({ answerId: Number(saved.lastInsertRowid), queryIds }), fact.endedAt);
        }
      }
      const run = this.view(this.row(runId)!);
      this.beforeCommit?.();
      return run;
    }).immediate();
  }

  /** Read-only proof after a COMMIT whose return was lost; compare full facts, not paged previews. */
  isFinalSaved(runId: number, fact: FinalProviderFact | FinalAgentFact): boolean {
    id(runId);
    const row = this.row(runId);
    const savedCleanup = RunCleanupRecordSchema.safeParse(row ? decoded(row.cleanup_json) : null);
    const expectedCleanup = fact.cleanup && 'contract' in fact.cleanup && savedCleanup.success
      ? { ...fact.cleanup, ...(fact.cleanup.budgetSummary == null && savedCleanup.data.budgetSummary != null ? { budgetSummary: savedCleanup.data.budgetSummary } : {}) }
      : fact.cleanup ?? null;
    if (!row || row.kind !== ("calls" in fact ? "agent" : "provider") || row.status !== fact.status
      || row.output_text !== fact.outputText || row.stopped_at !== fact.stoppedAt || row.ended_at !== fact.endedAt
      || row.cancel_requested_at !== (fact.cancelRequestedAt ?? null) || !isDeepStrictEqual(decoded(row.error_json), fact.error)
      || !isDeepStrictEqual(decoded(row.usage_json), fact.usage ?? null) || !isDeepStrictEqual(decoded(row.cleanup_json), expectedCleanup)) return false;
    if (this.p3 && row.kind === "agent" && fact.status === "completed" && checked(agentConfigSchema, decoded(row.config_json), "storage_read_failed").agent.stage === "P3") {
      const answer = this.db.query<{ text: string }, [number]>("SELECT text FROM answers WHERE run_id=?").get(runId);
      if (!answer || answer.text !== (fact.outputText ?? "")) return false;
    }
    if(this.p5&&row.kind==='agent'&&this.inputs.hasPendingInputsForRun(runId))return false;
    const saved = this.calls(runId), expected = "calls" in fact ? fact.calls : fact.call ? [fact.call] : [];
    return saved.length === expected.length && expected.every(call => {
      const original = saved.find(item => item.callId === call.callId);
      return original !== undefined && Object.entries(call).every(([key, value]) => isDeepStrictEqual(original[key as keyof ModelCallView], value));
    });
  }

  checkpointFailure(runId: number, error: AppError, cleanup: RunCleanupRecord, time: string): void {
    id(runId); timestamp(time); checked(AppErrorSchema, error);
    this.db.transaction(() => {
      const row = this.row(runId);
      if (!row) fail("run_not_found");
      const terminal = row.status !== "created" && row.status !== "running";
      if (terminal && (row.status !== "failed" || !isDeepStrictEqual(decoded(row.error_json), error))) fail("state_conflict");
      if(this.p5&&cleanup.inputsSettled&&this.inputs.hasPendingInputsForRun(runId))fail('state_conflict');
      const checkedCleanup = this.validateCleanup(decoded(row.cleanup_json), cleanup);
      this.db.query("UPDATE runs SET status='failed',error_json=?,ended_at=COALESCE(ended_at,?),cleanup_json=? WHERE id=?")
        .run(json(error), time, json(checkedCleanup), runId);
      this.beforeCommit?.();
    }).immediate();
  }

  saveRunCleanup(runId: number, cleanup: RunCleanupRecord): void {
    id(runId);
    this.db.transaction(() => {
      const row = this.row(runId);
      if (!row) fail("run_not_found");
      if(this.p5&&cleanup.inputsSettled&&this.inputs.hasPendingInputsForRun(runId))fail('state_conflict');
      const checkedCleanup = this.validateCleanup(decoded(row.cleanup_json), cleanup);
      this.db.query("UPDATE runs SET cleanup_json=? WHERE id=?").run(json(checkedCleanup), runId);
      this.beforeCommit?.();
    }).immediate();
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
      return row.status === "created" || row.status === "running" || !released || toolGap || inputGap ? [this.view(row)] : [];
    });
  }

  verifyPriorToolFacts(runId: number, previousProcessExited: boolean, time: string): {
    stopConfirmed: boolean | null; requiredPersistenceComplete: boolean; unconfirmedItems: string[];
  } {
    id(runId); timestamp(time);
    return this.db.transaction(() => {
      const run = this.row(runId);
      if (!run) fail('run_not_found');
      const prior = RunCleanupRecordSchema.safeParse(decoded(run.cleanup_json));
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
          if (spawned && tool.status === 'running') {
            stopConfirmed = null;
            unconfirmed.add('tool_results_unknown');
            continue;
          }
          if (spawned && tool.started_at !== null && tool.stopped_at === null && !(prior.success && prior.data.stopConfirmed === true)) stopConfirmed = null;
          if (tool.status === 'requested' || tool.status === 'running') {
            if (!previousProcessExited) {
              unconfirmed.add('tool_results_unknown');
              continue;
            }
            const result = tool.status === 'running'
              ? { outcomeUnknown: true, recoveredAfterHostExit: true }
              : { executionStarted: false, recoveredAfterHostExit: true };
            const error = safeError('runtime_interrupted', undefined, { runId, toolCallId: tool.id });
            this.db.query(`UPDATE tool_calls SET status='failed',result_json=?,error_json=?,ended_at=? WHERE id=? AND status=?`)
              .run(JSON.stringify(result), JSON.stringify(error), time, tool.id, tool.status);
            changed = true;
            if (tool.status === 'running' && tool.effect === 'LOCAL_WRITE') unconfirmed.add('tool_effect_unknown');
          } else if (tool.effect === 'LOCAL_WRITE') {
            const result = decoded(tool.result_json);
            if (typeof result === 'object' && result !== null && 'outcomeUnknown' in result && result.outcomeUnknown === true) unconfirmed.add('tool_effect_unknown');
          }
        }
        if (previousProcessExited && !tools.some(tool => ['bash', 'powershell', 'grep', 'find'].includes(tool.tool_name) && tool.status === 'running')) unconfirmed.delete('tool_results_unknown');
      }
      if (stopConfirmed !== true) { unconfirmed.add('stop'); unconfirmed.add('resources'); }
      if (changed) this.beforeCommit?.();
      return { stopConfirmed, requiredPersistenceComplete: ![...unconfirmed].some(item => item.startsWith('tool_')), unconfirmedItems: [...unconfirmed] };
    }).immediate();
  }

  read(request: z.input<typeof ReadRunRequestSchema>): ReadRunResult {
    const input = checked(ReadRunRequestSchema, request);
    if ("recent" in input) {
      const rows = this.db.query<RunRow, [number, number | null, number | null, string | null, string | null, number]>(
        "SELECT * FROM runs WHERE id<? AND (? IS NULL OR session_id=?) AND (? IS NULL OR kind=?) ORDER BY id DESC LIMIT ?",
      ).all(input.beforeRunId ?? Number.MAX_SAFE_INTEGER, input.sessionId ?? null, input.sessionId ?? null, input.kind ?? null, input.kind ?? null, input.limit + 1);
      const page = rows.slice(0, input.limit);
      return { kind: "recent", runs: page.map((row) => {
        const { output, calls, inputPage, cleanup, ...summary } = this.view(row);
        const cleanupSummary = cleanup ? { executionStarted: cleanup.executionStarted, stopConfirmed: cleanup.stopConfirmed,
          requiredPersistenceComplete: cleanup.requiredPersistenceComplete, inputsSettled: cleanup.inputsSettled,
          resourcesReleased: cleanup.resourcesReleased, unconfirmedCount: cleanup.unconfirmedItems.length,
          secondaryErrorCount: cleanup.secondaryErrors.length, verifiedAt: cleanup.verifiedAt } : null;
        if (cleanupSummary && cleanup?.budgetSummary !== undefined) Object.assign(cleanupSummary, { budgetSummary: cleanup.budgetSummary });
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
    const row = this.db.query<{ id: number; kind: "provider" | "agent"; session_id: number | null }, []>("SELECT id,kind,session_id FROM runs WHERE status IN ('created','running')").get();
    return row ? { runId: row.id, kind: row.kind, sessionId: row.session_id } : null;
  }

  // Called only after the Host has confirmed the old owning process exited.
  recoverInterrupted(instanceId: string, time: string): number {
    timestamp(time);
    if (!instanceId) fail("invalid_argument");
    return this.db.transaction(() => {
      const rows = this.db.query<RunRow, [string]>(
        "SELECT * FROM runs WHERE instance_id<>? AND status IN ('created','running')",
      ).all(instanceId);
      for (const row of rows) {
        const error = safeError(row.kind === "provider" ? "host_interrupted" : "runtime_interrupted", undefined, { runId: row.id,
          operationRef: row.kind === "provider" ? this.providerConfig(row).providerRequest.operationRef : row.submission_operation_ref ?? undefined });
        const prior = RunCleanupRecordSchema.safeParse(decoded(row.cleanup_json));
        const inputFacts = this.verifyPriorInputFacts(row.id,true,time);
        const facts = row.kind === 'agent' && this.p3 ? this.verifyPriorToolFacts(row.id, true, time) : null;
        const cleanup = facts ? checked(RunCleanupRecordSchema, {
          contract: 'medclaw.run-cleanup/v1', executionStarted: prior.success ? prior.data.executionStarted : null,
          stopConfirmed: facts.stopConfirmed, requiredPersistenceComplete: facts.requiredPersistenceComplete && inputFacts.requiredPersistenceComplete,
          inputsSettled: inputFacts.inputsSettled, resourcesReleased: facts.stopConfirmed, unconfirmedItems: [...facts.unconfirmedItems,...inputFacts.unconfirmedItems],
          secondaryErrors: prior.success ? prior.data.secondaryErrors : [], verifiedAt: facts.stopConfirmed === true ? time : prior.success ? prior.data.verifiedAt : null,
          ...(prior.success && prior.data.budgetSummary !== undefined ? { budgetSummary: prior.data.budgetSummary } : {}),
        }) : { previousInstanceId: row.instance_id, oldProcessExited: true, observationGap: true };
        if (row.kind === "provider") this.db.query("UPDATE model_calls SET state='failed',error_json=?,unavailable_reason='host_interrupted' WHERE run_id=? AND state='started'")
          .run(JSON.stringify(error), row.id);
        this.db.query(`UPDATE runs SET status='failed',ended_at=?,error_json=?,cleanup_json=?
          WHERE id=? AND status IN ('created','running')`)
          .run(time, JSON.stringify(error), JSON.stringify(cleanup), row.id);
      }
      if (rows.length) this.beforeCommit?.();
      return rows.length;
    }).immediate();
  }
}
