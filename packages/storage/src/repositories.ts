import type { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import { createHash } from 'node:crypto';
import { z } from "zod";
import { AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema, safeError, type AppError } from "../../contracts/src/error";
import { ToolSdkDeliverySchema } from "../../contracts/src/tool";
import { ToolControlObservationSchema } from "../../contracts/src/model";
import { SqliteInputStore } from "./input-store";
import type { SqliteMemoryStore } from './memory-store';
import { SqliteEventStore } from './event-store';
import { SqliteWriteTransactions } from './write-transactions';
import { verifyPriorContextFacts } from './context-store';
import { ModelCallContextSchema, ContextSnapshotBodySchema, type StartCallContext } from '../../contracts/src/context';
import { FrozenRunResourcesSchema, ResourceEvidenceSchema, ResourceReadFactSchema, resourceRefKey, type FrozenRunResources, type ResourceEvidence } from '../../contracts/src/resources';
import { FrozenRunExtensionsSchema, type FrozenRunExtensions } from '../../contracts/src/extensions';
import { FrozenChildConfigSchema, ChildResultSchema, BoundChildIdentitySchema, type BoundChildIdentity } from '../../contracts/src/subagent';
import type { EventWriter, RegisteredEventDraft, RegisteredEventPayload } from '../../contracts/src/event';
import { RegisteredEventPayloadSchema } from '../../contracts/src/event';
import { NATIVE_HISTORY_FORMAT, InputContentSchema, type NativeHistoryCommit, type InitialNativeHistory, type PreparedInput, type InputStore, type InputCancelProof, type InputSettlementProof, type ReadInputRequest, type ListInputsRequest } from "../../contracts/src/session";
import { CompactSessionInputSchema, ReadCompactionInputSchema, FrozenCompactionSchema, StoredCompactionOperationSchema, CompactionReceiptSchema, CompactionSaveFactSchema, CompactionCallOwnerSchema, CompactionCallMetadataSchema,
  type CompactSessionInput, type ReadCompactionInput, type FrozenCompaction, type StoredCompactionOperation, type CompactionCallOwner, type CompactionReceipt, type CompactionSaveFact } from '../../contracts/src/session';
import { SqliteToolStore } from "./tool-store";
import { SqliteCatalogStore } from './catalog-store';
import { HistorySourceStore } from './history-source-store';
import { readWorkspaceBatchReferences, readWorkspaceQuery, validateWorkspaceSelection, freezeWorkspaceScope } from './workspace-selection';
import type { QueryRecord } from '../../contracts/src/query';
import { RenameSessionInputSchema, DeleteSessionInputSchema, ReadManagementOperationInputSchema, SessionManagementDetailsSchema, SessionManagementReceiptSchema,
  type RenameSessionInput, type DeleteSessionInput, type ReadManagementOperationInput, type SessionManagementReceipt, type SessionManagementDetails,
  NewSessionInputSchema, NewSessionResultSchema, SelectSessionInputSchema, SessionViewSchema, ListSessionsRequestSchema, SubmitInputSchema, ReadSubmissionRequestSchema,
  type NewSessionInput, type NewSessionResult, type SelectSessionInput, type SessionView, type SessionPage, type ReadSubmissionRequest, type SubmitResult, type SessionStore } from "../../contracts/src/session";
import { ReadSessionCheckpointsInputSchema, RestoreSessionCheckpointInputSchema, SessionCheckpointDetailsSchema, SessionCheckpointPageSchema,
  type ReadSessionCheckpointsInput,type RestoreSessionCheckpointInput,type SessionCheckpointReceipt,type SessionCheckpointDetails,type NativeHistorySnapshot } from '../../contracts/src/session';
import { WorkspaceStateSchema, WorkspaceViewSchema, WorkspaceChangeSchema, RevisionSchema, toWorkspaceContext, type WorkspaceState, type WorkspaceSelection, type WorkspaceView, type WorkspaceChange, type BatchRef, type WorkspaceStore, type WorkspaceInspection, type WorkspaceNotice } from "../../contracts/src/workspace";
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
  scope_json: string;
};
type CallRow = {
  input_id: number | null; id: number; call_id: string; kind: "main" | "diagnostic" | "compaction"; model_json: string;
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

export class Repositories implements ProviderRunStore, SessionStore, WorkspaceStore {
  private readonly p3: boolean;
  private readonly inputs: SqliteInputStore;
  private readonly p5: boolean;
  private readonly batchLifecycle:boolean;
  private readonly events: EventWriter | undefined;
  constructor(private readonly db: Database, private readonly beforeCommit?: () => void, events?: EventWriter,
    private readonly transactions = SqliteWriteTransactions.forDatabase(db),private readonly memory?:SqliteMemoryStore) {
    this.events = events ?? (db.query("SELECT name FROM sqlite_schema WHERE name='runtime_events'").get() ? new SqliteEventStore(db, transactions) : undefined);
    this.inputs = new SqliteInputStore(db, this.events);
    this.p5 = db.query("SELECT name FROM sqlite_schema WHERE name='session_inputs'").get() !== null;
    this.p3 = this.db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name='answers'").get() !== null;
    this.batchLifecycle=!!db.query("SELECT name FROM pragma_table_info('batches') WHERE name='status'").get();
  }

  private event(row: RunRow, fact: RegisteredEventPayload, at: string, source: RegisteredEventDraft['source'] = 'application', toolCallId: number | null = null): void {
    if (!this.events || row.kind !== 'agent' || row.session_id === null) return;
    this.events.appendInTransaction({...fact,runId:row.id,sessionId:row.session_id,source,sourceConnection:null,sourceSequence:null,toolCallId,occurredAt:at,receivedAt:at});
  }
  private runLifecycle(row: RunRow, type: 'run_created'|'run_started', at: string): void {
    if(row.kind==='agent'&&row.session_id!==null)this.event(row,{type,payload:{contract:'medclaw.event/v1',sessionId:row.session_id,kind:'agent',configVersion:this.config(row).selection.configVersion}},at);
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
    const frozen = checked(FrozenRunResourcesSchema, value, 'storage_read_failed');
    if (frozen.sessionId !== sessionId || frozen.configVersion !== configVersion) fail('storage_read_failed');
    for (const snapshot of frozen.available) {
      for (const file of snapshot.files) if (createHash('sha256').update(file.content).digest('hex') !== file.sha256) fail('storage_read_failed');
      const { kind, id, version } = snapshot.ref;
      const metadata = { kind, id, version, entry: snapshot.entry, keywords: [...snapshot.keywords].sort(), requiredTools: [...snapshot.requiredTools].sort(),
        requiredExtensions: [...snapshot.requiredExtensions].sort(), files: snapshot.files.map(f => ({ path: f.file, bytes: f.bytes, sha256: f.sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
      if (createHash('sha256').update(canonicalRequest(metadata)).digest('hex') !== snapshot.ref.treeHash) fail('storage_read_failed');
    }
    return frozen;
  }
  readRunResources(runId: number): FrozenRunResources | null {
    id(runId); return this.inputRead(() => {
      const row = this.row(runId); if (!row) fail('run_not_found');
      if (row.kind !== 'agent') return null;
      const config = checked(agentConfigSchema, decoded(row.config_json), 'storage_read_failed');
      return config.agent.resources ? this.checkedResources(config.agent.resources, row.session_id!, config.selection.configVersion) : null;
    });
  }
  private checkedExtensions(value: unknown, sessionId: number, configVersion: string): FrozenRunExtensions {
    const frozen = checked(FrozenRunExtensionsSchema, value, 'storage_read_failed');
    if (frozen.sessionId !== sessionId || frozen.configVersion !== configVersion) fail('storage_read_failed');
    if (frozen.source) {
      const { manifest, files } = frozen.source;
      for (const file of files) if (createHash('sha256').update(file.content).digest('hex') !== file.sha256) fail('storage_read_failed');
      if (!isDeepStrictEqual(decoded(files.find(file => file.file === 'manifest.json')!.content), manifest)) fail('storage_read_failed');
      const metadata = { id: manifest.id, version: manifest.version, sdkVersion: manifest.sdkVersion,
        files: files.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0) };
      if (createHash('sha256').update(canonicalRequest(metadata)).digest('hex') !== frozen.selection.extension!.treeHash) fail('storage_read_failed');
    }
    return frozen;
  }
  readRunExtensions(runId: number): FrozenRunExtensions | null {
    id(runId); return this.inputRead(() => {
      const row = this.row(runId); if (!row) fail('run_not_found');
      if (row.kind !== 'agent') return null;
      const config = checked(agentConfigSchema, decoded(row.config_json), 'storage_read_failed');
      return config.agent.extensions ? this.checkedExtensions(config.agent.extensions, row.session_id!, config.selection.configVersion) : null;
    });
  }
  readResourceOrigins(sessionId: number, nativeEntryIds: readonly string[]): ResourceEvidence[] {
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
    return facts;
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
          nativeEntryId: input.native_entry_id, toolCallId: null, modelCallId: null, contentHash: content.nativeInput.sha256, payloadHash: null, observedAt: time, coverage: 'complete' }, 'storage_read_failed'));
      }
      const tools = new SqliteToolStore(this.db);
      const toolRows = this.db.query<{ id: number; native_tool_call_id: string; context_snapshot_id: number | null; call_id: string | null; input_id: number | null; snapshot_json: string | null }, [number, number]>(`SELECT t.id,t.native_tool_call_id,t.context_snapshot_id,c.call_id,s.input_id,s.snapshot_json
        FROM tool_calls t LEFT JOIN model_calls c ON c.id=t.model_call_id LEFT JOIN context_snapshots s ON s.id=t.context_snapshot_id WHERE t.run_id=? AND t.session_id=? ORDER BY t.id`).all(runId, run.session_id!);
      for (const row of toolRows) {
        const workspace = row.snapshot_json ? checked(ContextSnapshotBodySchema, decoded(row.snapshot_json), 'storage_read_failed').workspaceContext : null;
        const record = tools.readCall({ runId, sessionId: run.session_id!, nativeToolCallId: row.native_tool_call_id, scope: checked(RunScopeSchema, decoded(run.scope_json)),
          referenceDate: run.reference_date, timezone: run.timezone, signal: new AbortController().signal,
          ...(row.context_snapshot_id !== null && workspace ? { contextSnapshotId: row.context_snapshot_id, modelCallId: row.call_id!, workspaceContext: workspace, workspaceInputId: row.input_id,
            basedOnQueryId: workspace.queryId, workspaceRevision: workspace.revision } : {}) });
        if (!record?.resourceRead) continue;
        const read = record.resourceRead, snapshot = originFile(runId, read.resourceRef, read.file);
        if (!record.nativeEntryId || !record.sdkDelivery || record.sdkDelivery.isError || snapshot.files.find(f => f.file === read.file)!.sha256 !== read.fileHash
          || createHash('sha256').update(canonicalRequest(record.sdkDelivery.content)).digest('hex') !== read.returnedContentHash) fail('storage_read_failed');
        facts.push(checked(ResourceEvidenceSchema, { resourceRef: read.resourceRef, originRunId: runId, file: read.file, kind: 'native_read', inputId: null,
          nativeEntryId: record.nativeEntryId, toolCallId: record.id, modelCallId: null, contentHash: read.returnedContentHash, payloadHash: null, observedAt: read.observedAt, coverage: read.coverage }, 'storage_read_failed'));
      }
      const calls = this.db.query<{ call_id: string; model_json: string; delivered_at: string }, [number, number]>(`SELECT c.call_id,c.model_json,d.delivered_at FROM model_calls c JOIN context_deliveries d ON d.model_call_id=c.id
        WHERE c.run_id=? AND c.session_id=? AND c.kind='main' ORDER BY c.id`).all(runId, run.session_id!);
      for (const call of includeDeliveries ? calls : []) {
        const context = checked(ModelCallContextSchema, (decoded(call.model_json) as { context: unknown }).context, 'storage_read_failed');
        const observation = context.observation?.resources; if (!observation) continue;
        if (call.delivered_at !== context.observation!.observedAt) fail('storage_read_failed');
        for (const ref of observation.verified) {
          originFile(ref.originRunId, ref.resourceRef, ref.file);
          if (ref.kind === 'skill_index' && ref.originRunId !== runId) fail('storage_read_failed');
          if (ref.inputId !== null && !this.db.query('SELECT id FROM session_inputs WHERE id=? AND session_id=? AND run_id=? AND native_entry_id=?').get(ref.inputId, run.session_id, ref.originRunId, ref.nativeEntryId)) fail('storage_read_failed');
          if (ref.toolCallId !== null && !this.db.query("SELECT id FROM tool_calls WHERE id=? AND session_id=? AND run_id=? AND json_extract(delivery_json,'$.nativeEntryId')=?").get(ref.toolCallId, run.session_id, ref.originRunId, ref.nativeEntryId)) fail('storage_read_failed');
          facts.push(checked(ResourceEvidenceSchema, { ...ref, kind: 'provider_delivery', modelCallId: call.call_id, payloadHash: observation.payloadHash, observedAt: call.delivered_at }, 'storage_read_failed'));
        }
      }
      // ponytail: scan one bounded Run's facts before paging; use SQL projection if measured Run histories outgrow memory.
      const distinct = [...new Map(facts.map(f => [canonicalRequest(f), f])).values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt) || canonicalRequest(a).localeCompare(canonicalRequest(b)));
      return { items: distinct.slice((page - 1) * pageSize, page * pageSize), totalRows: distinct.length };
    });
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
      if(this.p3)for(const batch of workspace.batchRefs){
        const row=this.db.query<{metadata_json:string},[number]>('SELECT metadata_json FROM batches WHERE id=?').get(batch.id);
        const metadata=checked(z.object({referenceDate:ReferenceDateSchema,timezone:TimezoneSchema}),decoded(row?.metadata_json??null),'storage_read_failed');
        if(request.timezone!==metadata.timezone)fail('invalid_argument');
      }
      let target:number|null=null;
      if(plan.execution.mode==='send'){
        if(this.active())fail('runtime_busy');const run=plan.execution.run;
        const resources = run.resources ? this.checkedResources(run.resources, session.id, run.model.configVersion) : null;
        if (run.extensions) this.checkedExtensions(run.extensions, session.id, run.model.configVersion);
        if(!!resources!==!!content.resourceInputPlan || content.resourceInputPlan?.resourceRef && !resources!.available.some(s=>resourceRefKey(s.ref)===resourceRefKey(content.resourceInputPlan!.resourceRef!)))fail('invalid_argument');
        const expectedScope = { ...this.freezeAgentScope(workspace,run.scope.allowedToolNames), allowedResourceRefs: resources?.available.map(s=>resourceRefKey(s.ref)) ?? [] };
        if(run.sessionId!==session.id||run.goal!=='answer'||run.text!==content.text||run.referenceDate!==content.referenceDate||run.timezone!==content.timezone||run.timeoutMs!==run.policy.timeoutMs||!isDeepStrictEqual(toWorkspaceContext(run.workspace),frozenWorkspace)||!isDeepStrictEqual(run.scope,content.scope)||!isDeepStrictEqual(run.model,content.model)||!isDeepStrictEqual(expectedScope,run.scope))fail('invalid_argument');
      }else{
        if(request.mode==='send'||request.targetRunId!==plan.execution.targetRunId)fail('invalid_argument');target=plan.execution.targetRunId;const run=this.row(target),active=this.active();
        if(!run||run.kind!=='agent'||run.session_id!==session.id||!active||active.runId!==target)fail('state_conflict');
        const root=checked(agentConfigSchema,decoded(run.config_json),'storage_read_failed'),scope=checked(RunScopeSchema,decoded(run.scope_json),'storage_read_failed');
        if(!isDeepStrictEqual({...this.freezeAgentScope(workspace,scope.allowedToolNames),allowedResourceRefs:scope.allowedResourceRefs},content.scope))fail('access_denied');
        if(!!root.agent.resources!==!!content.resourceInputPlan || content.resourceInputPlan?.resourceRef && !root.agent.resources!.available.some(s=>resourceRefKey(s.ref)===resourceRefKey(content.resourceInputPlan!.resourceRef!)))fail('access_denied');
        if(!isDeepStrictEqual(root.selection,content.model)||run.reference_date!==content.referenceDate||run.timezone!==content.timezone||content.scope.batchIds.some(b=>!scope.batchIds.includes(b))||scope.deviceIds!==null&&(content.scope.deviceIds===null||content.scope.deviceIds.some(d=>!scope.deviceIds!.includes(d)))||content.scope.allowedToolNames.some(t=>!scope.allowedToolNames.includes(t))||content.scope.allowedResourceRefs.some(r=>!scope.allowedResourceRefs.includes(r))||content.scope.artifactIds.some(a=>!scope.artifactIds.includes(a))||scope.readOnly&&!content.scope.readOnly)fail('access_denied');
      }
      const saved=this.db.query("INSERT INTO session_inputs(session_id,client_sequence,operation_ref,mode,status,content_json,target_run_id,run_id,error_json,created_at,delivered_at,processed_at,updated_at,processing_status,native_entry_id) VALUES(?,?,?,?,'queued',?,?,NULL,NULL,?,NULL,NULL,?,'pending',NULL)").run(session.id,request.clientSequence,operationRef,request.mode,canonicalRequest(content),target,plan.createdAt,plan.createdAt);
      const inputId=Number(saved.lastInsertRowid);
      if(plan.execution.mode==='send'){
        const run=plan.execution.run;checked(OpaqueIdSchema,run.instanceId);timestamp(run.createdAt);
        const config=checked(agentConfigSchema,{selection:run.model,policy:run.policy,referenceDate:run.referenceDate,timezone:run.timezone,...(run.agentPolicy?{agentPolicy:run.agentPolicy}:{}),...(run.runtimeConfiguration?{runtimeConfiguration:run.runtimeConfiguration}:{}),...(run.toolConfiguration?{toolConfiguration:run.toolConfiguration}:{}),...(run.measurementContext?{measurementContext:run.measurementContext}:{}),...(run.toolProfileSnapshot?{toolProfileSnapshot:run.toolProfileSnapshot}:{}),agent:{...run.agentOptions,stage:run.scope.allowedToolNames.length?'P3':'P2',nativeSessionId:session.nativeSessionId,tools:run.scope.allowedToolNames,autoCompaction:run.agentOptions.compaction?.enabled??false,autoRetry:false,cacheWarming:'off',...(run.resources?{resources:run.resources}:{}),...(run.extensions?{extensions:run.extensions}:{}),...(run.contextContract?{contextContract:run.contextContract}:{}),...(run.historyContract?{historyContract:run.historyContract}:{})}});
        const r=this.db.query("INSERT INTO runs(session_id,input_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at) VALUES(?,?,'agent',?,NULL,NULL,NULL,'created','answer',?,?,?,?,?,?,?)").run(session.id,inputId,run.instanceId,content.text,JSON.stringify(config),JSON.stringify(run.scope),JSON.stringify(frozenWorkspace),run.referenceDate,run.timezone,run.createdAt);target=Number(r.lastInsertRowid);
        this.db.query('UPDATE session_inputs SET target_run_id=? WHERE id=? AND target_run_id IS NULL').run(target,inputId);
        this.runLifecycle(this.row(target)!, 'run_created', run.createdAt);
      }
      this.inputs.accepted(inputId, plan.createdAt);
      return this.inputs.result(this.inputs.required(inputId));
    });
  }

  private row(runId: number): RunRow | null {
    return this.db.query<RunRow, [number]>("SELECT * FROM runs WHERE id=?").get(runId);
  }
  private config(row: RunRow) { return checked(commonConfigSchema, decoded(row.config_json), "storage_read_failed"); }
  private providerConfig(row: RunRow) { return checked(providerConfigSchema, decoded(row.config_json), "storage_read_failed"); }
  private calls(runId: number): ModelCallView[] {
    return this.db.query<CallRow, [number]>("SELECT * FROM model_calls WHERE run_id=? ORDER BY id").all(runId).map(row => this.call(row));
  }
  private call(row: CallRow): ModelCallView {
      const model = checked(z.object({
        selection: ModelSelectionSchema, responseModel: z.string().nullable(),
        sdkStopReason: z.enum(["stop", "length", "toolUse", "error", "aborted", "deferred"]).nullable(),
        context: ModelCallContextSchema.optional(),
        compaction: CompactionCallMetadataSchema.optional(),
      }).strict(), decoded(row.model_json), "storage_write_failed");
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
    const agent = row.kind === "agent" ? checked(agentConfigSchema, decoded(row.config_json), "storage_read_failed") : null;
    const child = row.kind === 'child' ? checked(FrozenChildConfigSchema, (decoded(row.config_json) as { subagent: unknown }).subagent, 'storage_read_failed') : null;
    const childResult = child && row.child_result_json ? checked(ChildResultSchema, decoded(row.child_result_json), 'storage_read_failed') : null;
    const childDelivery = child ? this.db.query<{ delivery_json: string | null }, [number]>('SELECT delivery_json FROM tool_calls WHERE id=?').get(child.originToolCallId) : null;
    const delivery = childDelivery?.delivery_json ? checked(savedDeliverySchema, decoded(childDelivery.delivery_json), 'storage_read_failed') : null;
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
      ...(child ? { parentRunId: child.parentRunId, originToolCallId: child.originToolCallId, pluginAgentId: child.pluginAgentId, nativeSessionId: child.nativeSessionId,
        nextCallOffset: callOffset + callLimit < calls.length ? callOffset + callLimit : null,
        childResult: childResult ? (() => { const { originalReply, ...view } = childResult; return { ...view, text: childResult.outcome === 'completed' ? safePreview(view.text, 32768).text : AppErrorSchema.safeParse(decoded(row.error_json)).data?.message ?? 'Child execution did not complete.' }; })() : null,
        delivery: delivery ? { resultRecorded: delivery.resultRecorded, sdkReturned: delivery.sdkReturned, nativeEntryId: delivery.nativeEntryId, nextModelCallId: delivery.nextModelCallId, consumedAt: delivery.consumedAt, error: delivery.error } : null } : {}),
      ...(agent ? { clientSequence: rootInput?.client_sequence ?? row.submission_client_sequence, nativeSessionId: agent.agent.nativeSessionId,
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
      const session = this.readSession(owner.sessionId); if (!session) fail('session_not_found'); this.assertSessionActive(session);
      if (owner.source === 'manual') {
        const operation = this.readCompactionOperation({sessionId:owner.sessionId,operationRef:owner.operationRef});
        if (!operation || operation.receipt || operation.cancelRequestedAt || owner.ordinal > operation.frozen.budget.maxModelCalls
          || !isDeepStrictEqual(operation.frozen.model,owner.model) || owner.baseStorageVersion !== operation.frozen.baseStorageVersion || owner.baseLeafId !== operation.frozen.baseLeafId) fail('state_conflict');
      } else {
        if (!existing.length && this.findOperation(owner.operationRef)) fail('state_conflict');
        const run = this.row(owner.runId!);
        if (!run || run.kind !== 'agent' || run.session_id !== owner.sessionId || !['created','running'].includes(run.status) || run.cancel_requested_at || !isDeepStrictEqual(this.config(run).selection,owner.model)) fail('state_conflict');
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
        if(!run||run.kind!=='agent'||run.session_id!==fact.sessionId||!['created','running'].includes(run.status))fail('state_conflict');
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
      const run=this.row(runId);if(!run||run.kind!=='agent')fail('state_conflict');
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
    return checked(WorkspaceStateSchema, { revision: row.revision, sessionId: row.active_session_id, materialVersion: row.material_version ?? null,
      batchRefs: row.batch_refs_json === undefined ? [] : readJson(row.batch_refs_json), deviceIds: row.device_ids_json === undefined ? [] : readJson(row.device_ids_json),
      queryId: row.active_query_id ?? null, activeView: row.active_view ?? "data", selection: row.selection_json === undefined ? null : readJson(row.selection_json) }, "storage_read_failed");
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
        const resultHash=createHash('sha256').update(canonicalRequest({kind:query.kind,params:query.params,batchIds:query.batchIds,scopeDeviceIds:query.scopeDeviceIds,rows:query.rows,interpretation:query.interpretation,calculationVersion:query.calculationVersion})).digest('hex');
        if(resultHash!==query.resultHash)throw safeError('tool_output_inconsistent');
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
      const valid=batch&&batch.status==='active'&&batch.content_hash===ref.contentHash&&batch.snapshot_date===ref.snapshotDate&&batch.scope_key===ref.scopeKey
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
    const sorted=[...dependencies.values()].sort((a,b)=>a.kind.localeCompare(b.kind)||a.id-b.id).map(item=>({...item,record:item.record===null?{missing:true}:Object.fromEntries(Object.entries(item.record).map(([key,value])=>[key,key.endsWith('_json')&&typeof value==='string'?{sha256:createHash('sha256').update(value).digest('hex')}:value]))}));
    const fingerprint=createHash('sha256').update(canonicalRequest({format:'workspace-inspection/v1',state,dependencies:sorted})).digest('hex');
    return {state,candidate,artifactIds:[...new Set(artifactIds)].sort((a,b)=>a-b),notices,fingerprint};
  }

  commitWorkspaceRestore(expectedRevision:number,expectedFingerprint:string,candidate:WorkspaceState,time:string):WorkspaceState {
    checked(RevisionSchema,expectedRevision);checked(WorkspaceStateSchema,candidate);timestamp(time);
    return this.transactions.immediate(()=>{
      const original=this.workspaceInspection([]);
      if(original.state.revision!==expectedRevision||original.fingerprint!==expectedFingerprint)throw safeError('state_conflict',undefined,{reason:'workspace_revision_mismatch'});
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

  readChildIdentity(runId: number): BoundChildIdentity | null {
    id(runId);
    const row = this.row(runId); if (!row || row.kind !== 'child') return null;
    const frozen = checked(FrozenChildConfigSchema, (decoded(row.config_json) as { subagent: unknown }).subagent, 'storage_read_failed');
    const session = this.db.query<{ native_session_id: string; kind: string }, [number]>('SELECT native_session_id,kind FROM sessions WHERE id=?').get(frozen.childSessionId);
    const parent = this.row(frozen.parentRunId);
    if (!session || session.kind !== 'child' || session.native_session_id !== frozen.nativeSessionId
      || row.id !== frozen.childRunId || row.session_id !== frozen.childSessionId || row.parent_run_id !== frozen.parentRunId
      || row.origin_tool_call_id !== frozen.originToolCallId || !parent || parent.kind !== 'agent' || parent.session_id !== frozen.parentSessionId || parent.instance_id !== frozen.instanceId) fail('storage_read_failed');
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
      return checked(SessionCheckpointPageSchema,{sessionId:session.id,storageVersion:history.storageVersion,items:page.map(row=>({answerId:row.id,runId:row.run_id,nativeLeafId:row.native_leaf_id,committedAt:row.created_at,questionSummary:safePreview(row.input_text,512).text,answerSummary:safePreview(row.text,512).text,conditionSummary:null,isCurrentBranch:current.has(row.native_leaf_id)})),nextAnswerId:hasMore?page.at(-1)!.id:null,hasMore},'storage_read_failed');
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
        const row = this.db.query<{content_hash:string;snapshot_date:string;scope_key:string;material_version:string},[number]>('SELECT content_hash,snapshot_date,scope_key,material_version FROM batches WHERE id=?').get(batch.id);
        return row !== null && row.content_hash === batch.contentHash && row.snapshot_date === batch.snapshotDate && row.scope_key === batch.scopeKey && row.material_version === workspace.materialVersion;
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
      checked(agentConfigSchema, JSON.parse(row.config_json), "storage_read_failed");
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
          if(row.owner!==sessionId||row.kind!=='agent'||entry.id!==row.native_entry_id) fail('storage_read_failed');
          if(entry.message.role==='user'||entry.message.role==='assistant') links.set(row.native_entry_id,{runId:row.run_id,toolCallRef:null,references:[`run:${row.run_id}`]});
        }
      }
      // ponytail: Validate O(target Session saved receipts); index further only if large Session reads become slow.
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

  startCall(runId: number, callId: string, kind: "main" | "diagnostic", time: string, context?: StartCallContext): void {
    id(runId); timestamp(time);
    if (!callId || callId.length > 512) fail("invalid_argument");
    this.transactions.immediate(() => {
      const row = this.row(runId);
      if (!row || row.status !== "created" && !(row.kind === "agent" && row.status === "running")) fail("state_conflict");
      if (row.kind === "provider" && this.calls(runId).length) fail("state_conflict");
      if (kind !== (row.goal === "verify" ? "diagnostic" : "main")) fail("invalid_argument");
      const requiresContext = row.kind === 'agent' && checked(agentConfigSchema,decoded(row.config_json),'storage_read_failed').agent.contextContract === 'medclaw.context/v1';
      if (requiresContext && !context || context && (row.kind !== 'agent' || kind !== 'main')) fail('state_conflict');
      if (context && !this.db.query('SELECT id FROM context_snapshots WHERE id=? AND run_id=? AND session_id=? AND input_id=?').get(context.snapshotId,runId,row.session_id,context.inputId)) fail('access_denied');
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
  confirmHistorySaved(change:NativeHistoryCommit) {if(!this.memory)fail('storage_read_failed');return this.memory.confirmCommitted(change);}
  private answerReferences(row:RunRow, requireAvailable:boolean):number[] {
    try {
      const store=new SqliteToolStore(this.db),sources=new HistorySourceStore(this.db),catalog=new SqliteCatalogStore(this.db),scope=checked(RunScopeSchema,decoded(row.scope_json));
      const ids=new Set(this.db.query<{id:number},[number]>('SELECT id FROM queries WHERE run_id=?').all(row.id).map(value=>value.id));
      for(const input of this.inputsForRun(row.id))if(input.status==='consumed'&&input.runId===row.id&&input.sessionId===row.session_id&&input.nativeEntryId){
        const frozen=this.inputs.content(this.inputs.required(input.id)).workspaceContext;
        if(frozen.queryId!==null)ids.add(frozen.queryId);
      }
      const reads=this.db.query<{tool_name:string;args_json:string;result_json:string;delivery_json:string;native_tool_call_id:string},[number,number]>(`SELECT * FROM tool_calls WHERE run_id=? AND session_id=? AND status='succeeded'
        AND tool_name IN ('read_query','read_query_page','list_query_evidence','read_query_evidence')`).all(row.id,row.session_id!);
      for(const read of reads){
        const name=read.tool_name as 'read_query'|'read_query_page'|'list_query_evidence'|'read_query_evidence',schemas=businessToolSchemas[name];
        const args=checked(schemas.input as z.ZodType<Record<string,number>>,decoded(read.args_json));
        const data=checked(schemas.output as z.ZodType<unknown>,decoded(read.result_json)) as {queryId?:number;resultHash?:string;items?:{queryId:number;resultHash:string}[]};
        const delivery=checked(savedDeliverySchema,decoded(read.delivery_json));
        // A successful tool row alone does not prove that this model consumed its result.
        if(!delivery.sdkReturned||!delivery.nativeEntryId||!delivery.nextModelCallId||!delivery.consumedAt||delivery.consumptionEvidence!=='provider_input_verified')continue;
        if(!delivery.message||delivery.message.isError||delivery.message.toolCallId!==read.native_tool_call_id||delivery.message.toolName!==name
          ||!isDeepStrictEqual(delivery.message.details,data))fail('answer_evidence_invalid');
        const entry=this.db.query<{entry_json:string},[number,string,number]>("SELECT entry_json FROM memories WHERE session_id=? AND native_entry_id=? AND run_id=? AND entry_type='message'").get(row.session_id!,delivery.nativeEntryId,row.id);
        if(!entry||!isDeepStrictEqual((decoded(entry.entry_json) as {message:unknown}).message,delivery.message)
          ||!this.db.query('SELECT id FROM model_calls WHERE run_id=? AND session_id=? AND call_id=?').get(row.id,row.session_id,delivery.nextModelCallId))fail('answer_evidence_invalid');
        const queryId=name==='read_query_evidence'?store.readEvidence(args.evidenceId!)?.queryId:args.queryId;
        if(!queryId||data.queryId!==undefined&&data.queryId!==queryId||data.items?.some(item=>item.queryId!==queryId))fail('answer_evidence_invalid');
        const query=store.readQuery(queryId);
        if(!query||data.resultHash!==undefined&&data.resultHash!==query.resultHash||data.items?.some(item=>item.resultHash!==query.resultHash))fail('answer_evidence_invalid');
        ids.add(queryId);
      }
      for(const id of ids){
        const query=store.readQuery(id),view=sources.query(id,1,1);
        const source=this.db.query<{source:string},[number]>('SELECT source FROM queries WHERE id=?').get(id);
        if(!query||query.sessionId!==row.session_id||query.batchIds.some(batch=>!scope.batchIds.includes(batch))
          ||(query.source??'agent_tool')!==source?.source
          ||scope.deviceIds!==null&&(query.scopeDeviceIds===null||query.scopeDeviceIds.some(device=>!scope.deviceIds!.includes(device)))
          ||requireAvailable&&view.query.sourceAvailability!=='available')fail('answer_evidence_invalid');
        const batches=catalog.readBatches(query.batchIds),references=requireAvailable?catalog.readSnapshotReferences(query.snapshotIds):[],events=requireAvailable&&query.eventIds.length?catalog.readChanges(query.batchIds,query.batchIds,query.scopeDeviceIds):[];
        if(batches.length!==new Set(query.batchIds).size||requireAvailable&&(references.length!==new Set(query.snapshotIds).size
          ||references.some(ref=>!query.batchIds.includes(ref.batchId)||query.scopeDeviceIds!==null&&!query.scopeDeviceIds.includes(ref.deviceId))
          ||query.eventIds.some(id=>!events.some(event=>event.id===id&&query.batchIds.includes(event.oldBatchId)&&query.batchIds.includes(event.newBatchId)))))fail('answer_evidence_invalid');
        const evidenceRows=store.listEvidence(id);
        for(const evidence of evidenceRows){
          if(evidence.resultHash!==query.resultHash||evidence.calculationVersion!==query.calculationVersion
            ||evidence.snapshotIds.some(value=>!query.snapshotIds.includes(value))||evidence.eventIds.some(value=>!query.eventIds.includes(value))
            ||evidence.filters!==undefined&&!isDeepStrictEqual(evidence.filters,query.params)
            ||evidence.batchIds.some(id=>!batches.some(batch=>batch.id===id&&batch.sourceBundleId===evidence.sourceBundleId&&batch.materialVersion===evidence.materialVersion&&batch.sourceLockHash===evidence.sourceLockHash))
            ||requireAvailable&&!isDeepStrictEqual([...new Set(evidence.sourceRowRefs)].sort(),[...new Set(references.filter(ref=>evidence.snapshotIds.includes(ref.id)).map(ref=>ref.sourceRowRef))].sort()))fail('answer_evidence_invalid');
          const proof=sources.evidence(id,evidence.id,1,1);
          if(requireAvailable&&proof.sourceAvailability!=='available')fail('answer_evidence_invalid');
        }
        if(query.batchIds.some(id=>!evidenceRows.some(value=>value.batchIds.includes(id)))||query.snapshotIds.some(id=>!evidenceRows.some(value=>value.snapshotIds.includes(id)))||query.eventIds.some(id=>!evidenceRows.some(value=>value.eventIds.includes(id))))fail('answer_evidence_invalid');
      }
      return [...ids].sort((a,b)=>a-b);
    }catch{throw safeError('answer_evidence_invalid',undefined,{runId:row.id,sessionId:row.session_id??undefined});}
  }
  private validateFinalAnswer(row:RunRow,fact:FinalAgentFact):void {
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
  private validateCleanup(row: RunRow, input: RunCleanupRecord): RunCleanupRecord {
    const previous = decoded(row.cleanup_json);
    const next = checked(RunCleanupRecordSchema, input), old = RunCleanupRecordSchema.safeParse(previous);
    if (old.success) {
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
    const selectedExtension=this.readRunExtensions(row.id)?.selection.extension;
    if(next.extensionReleaseBasis&&(!selectedExtension||next.extensions||next.extensionReleaseBasis==='not_loaded'&&(next.executionStarted!==false||this.calls(row.id).length)))fail('state_conflict');
    if (next.resourcesReleased===true && selectedExtension && !next.extensions&&!next.extensionReleaseBasis) fail('state_conflict');
    if (next.extensions) {
      const proof = next.extensions, frozen = this.readRunExtensions(row.id);
      if (proof.instanceId !== row.instance_id || proof.sessionId !== row.session_id || proof.runId !== row.id
        || !frozen?.selection.extension || !isDeepStrictEqual(proof.ref, frozen.selection.extension)
        || next.resourcesReleased === true && !proof.resourcesReleased) fail('state_conflict');
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
    return this.transactions.immediate(() => {
      const row = this.row(runId);
      if (!row || row.kind !== kind) fail("state_conflict");
      const history=kind==='agent'?(fact as FinalAgentFact).history:undefined;
      const historyRequired=kind==='agent'&&checked(agentConfigSchema,decoded(row.config_json),'storage_read_failed').agent.historyContract==='medclaw.history/p9-v1';
      if(historyRequired&&fact.status==='completed'&&!history)fail('session_history_invalid');
      if(history) {
        if(history.sessionId!==row.session_id||history.runId!==runId)fail('access_denied');
        if(this.isFinalSaved(runId,fact))return this.view(row);
        if(!this.memory)fail('storage_write_failed');
        if(historyRequired&&fact.status==='completed') {
          const assistant=(history.newEntries as {id:string;type:string}[]).findLast(entry=>entry.type==='message');
          if(!assistant||this.db.query('SELECT id FROM memories WHERE session_id=? AND native_entry_id=?').get(row.session_id,assistant.id))fail('session_history_invalid');
        }
        const compactions=(fact as FinalAgentFact).compactions??[];
        const pending=compactions.filter(compaction=>this.compactionCalls(compaction.operationRef).some(call=>checked(CompactionCallMetadataSchema,(decoded(call.model_json) as {compaction:unknown}).compaction).nativeEntryId===null));
        // A second native frame must first cross the same save barrier as a continuation.
        if(pending.length>1)fail('state_conflict');
        if(pending.length)this.commitCompactionInTransaction(history,pending[0]!);
        else this.memory.commitInTransaction(history);
        for(const compaction of compactions)if(compaction!==pending[0]&&this.confirmCompactionSaved(history,compaction)===null)fail('storage_write_failed');
        if(historyRequired&&fact.status==='completed')this.validateFinalAnswer(row,fact as FinalAgentFact);
      }
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
      if (cleanup && "contract" in cleanup) cleanup = this.validateCleanup(row, cleanup);
      else if (terminal && !isDeepStrictEqual(decoded(row.cleanup_json), cleanup)) fail("state_conflict");
      for (const original of calls) {
        const incoming = finalCalls.find(call => call.callId === original.callId);
        if (!incoming) fail("state_conflict");
        if("inputId" in incoming && incoming.inputId !== original.inputId) fail("state_conflict");
        const {context: incomingContext, ...incomingView} = incoming;
        const savedModel = decoded(this.db.query<{model_json:string},[string]>('SELECT model_json FROM model_calls WHERE call_id=?').get(original.callId)!.model_json) as Record<string,unknown>;
        if (incomingContext) {
          const next = checked(ModelCallContextSchema,incomingContext), prior = checked(ModelCallContextSchema,savedModel.context,'storage_read_failed');
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
      this.db.query(`UPDATE runs SET status=?,output_text=?,stopped_at=COALESCE(stopped_at,?),ended_at=COALESCE(ended_at,?),cancel_requested_at=?,
        error_json=?,cleanup_json=?,usage_json=? WHERE id=?`)
        .run(terminal ? row.status : fact.status, row.output_text ?? fact.outputText, fact.stoppedAt, fact.endedAt, cancelRequestedAt,
          terminal ? row.error_json : json(error), json(cleanup), row.usage_json ?? json(usage), runId);
      if (this.p3 && row.kind === "agent" && fact.status === "completed" && (historyRequired||checked(agentConfigSchema, decoded(row.config_json), "storage_read_failed").agent.stage === "P3")) {
        const frozen = checked(RunScopeSchema, decoded(row.scope_json), "storage_read_failed");
        const queries = this.db.query<{ id: number; session_id: number; batch_ids_json: string; result_json: string }, [number]>(
          "SELECT id,session_id,batch_ids_json,result_json FROM queries WHERE run_id=? ORDER BY id").all(runId);
        for (const query of historyRequired?[]:queries) {
          const batches = checked(z.array(PositiveIdSchema), decoded(query.batch_ids_json), "storage_read_failed");
          const result = checked(z.object({ scopeDeviceIds: z.array(PositiveIdSchema).nullable() }), decoded(query.result_json), "storage_read_failed");
          if (query.session_id !== row.session_id || batches.some(batch => !frozen.batchIds.includes(batch))
            || frozen.deviceIds !== null && (result.scopeDeviceIds === null || result.scopeDeviceIds.some(device => !frozen.deviceIds!.includes(device)))) fail("access_denied");
        }
        const queryIds = historyRequired?this.answerReferences(row,true):queries.map(query => query.id), text = fact.outputText ?? "";
        const priorAnswer = this.db.query<{ id: number; text: string; query_ids_json: string }, [number]>("SELECT id,text,query_ids_json FROM answers WHERE run_id=?").get(runId);
        if (priorAnswer) {
          if (priorAnswer.text !== text || !isDeepStrictEqual(decoded(priorAnswer.query_ids_json), queryIds)) fail("state_conflict");
        } else {
          const saved = this.db.query("INSERT INTO answers(run_id,session_id,input_id,kind,text,query_ids_json,missing_slots_json,native_leaf_id,created_at) VALUES(?,?,?,'result',?,?,'[]',?,?)")
            .run(runId, row.session_id, row.input_id, text, JSON.stringify(queryIds),history?.activeLeafId??null, fact.endedAt);
          this.db.query("INSERT INTO business_events(operation_ref,type,actor,session_id,run_id,details_json,occurred_at) VALUES(?,'answer_committed','agent',?,?,?,?)")
            .run(`answer:${runId}`, row.session_id, runId, JSON.stringify({ answerId: Number(saved.lastInsertRowid), queryIds }), fact.endedAt);
        }
      }
      if(!terminal)this.runTerminal(row,fact.status,error,cleanup,fact.endedAt);
      const run = this.view(this.row(runId)!);
      this.beforeCommit?.();
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
    if (!row || row.kind !== ("calls" in fact ? "agent" : "provider") || row.status !== fact.status
      || row.output_text !== fact.outputText || row.stopped_at !== fact.stoppedAt || row.ended_at !== fact.endedAt
      || row.cancel_requested_at !== (fact.cancelRequestedAt ?? null) || !isDeepStrictEqual(decoded(row.error_json), fact.error)
      || !isDeepStrictEqual(decoded(row.usage_json), fact.usage ?? null) || !isDeepStrictEqual(decoded(row.cleanup_json), expectedCleanup)) return false;
    const historyRequired=row.kind==='agent'&&checked(agentConfigSchema,decoded(row.config_json),'storage_read_failed').agent.historyContract==='medclaw.history/p9-v1';
    if('calls' in fact&&fact.history&&(!this.memory||this.memory.confirmCommitted(fact.history)===null))return false;
    if('calls' in fact&&fact.compactions?.some(compaction=>this.confirmCompactionSaved(fact.history??null,compaction)===null))return false;
    if(historyRequired) {
      if(fact.status==='completed') {
        if(!('calls' in fact)||!fact.history)return false;
        const answer=this.db.query<{id:number;session_id:number;input_id:number|null;native_leaf_id:string|null;text:string;query_ids_json:string},[number]>('SELECT * FROM answers WHERE run_id=?').get(runId);
        let queryIds:number[];try{queryIds=this.answerReferences(row,false);}catch{return false;}
        if(!answer||answer.session_id!==row.session_id||answer.input_id!==row.input_id||answer.native_leaf_id!==fact.history.activeLeafId||answer.text!==fact.outputText||!isDeepStrictEqual(decoded(answer.query_ids_json),queryIds))return false;
        const activity=this.db.query<{details_json:string},[string]>("SELECT details_json FROM business_events WHERE operation_ref=? AND type='answer_committed' AND actor='agent'").get(`answer:${runId}`);
        if(!activity||!isDeepStrictEqual(decoded(activity.details_json),{answerId:answer.id,queryIds}))return false;
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
    if (this.p3 && row.kind === "agent" && fact.status === "completed" && checked(agentConfigSchema, decoded(row.config_json), "storage_read_failed").agent.stage === "P3") {
      const answer = this.db.query<{ text: string }, [number]>("SELECT text FROM answers WHERE run_id=?").get(runId);
      if (!answer || answer.text !== (fact.outputText ?? "")) return false;
    }
    if(this.p5&&row.kind==='agent'&&this.inputs.hasPendingInputsForRun(runId))return false;
    const saved = this.calls(runId), expected = "calls" in fact ? fact.calls : fact.call ? [fact.call] : [];
    return saved.length === expected.length && expected.every(call => {
      const original = saved.find(item => item.callId === call.callId);
      if (call.context) {
        const model = decoded(this.db.query<{model_json:string},[string]>('SELECT model_json FROM model_calls WHERE call_id=?').get(call.callId)!.model_json) as {context?:unknown}, marker = ModelCallContextSchema.safeParse(model.context);
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

  verifyPriorToolFacts(runId: number, previousProcessExited: boolean, time: string): {
    stopConfirmed: boolean | null; requiredPersistenceComplete: boolean; unconfirmedItems: string[];
  } {
    id(runId); timestamp(time);
    return this.transactions.immediate(() => {
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
            this.recoveredToolEvent(run,tool.id,error,time);
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
    });
  }

  verifyPriorContextFacts(runId: number) { id(runId); return this.inputRead(() => verifyPriorContextFacts(this.db,runId)); }
  verifyPriorHistoryFacts(runId:number) {
    id(runId);return this.inputRead(()=>this.db.transaction(()=>{
      const row=this.row(runId);if(!row)fail('run_not_found');
      if(row.kind!=='agent'||checked(agentConfigSchema,decoded(row.config_json),'storage_read_failed').agent.historyContract!=='medclaw.history/p9-v1')return {requiredPersistenceComplete:true,unconfirmedItems:[] as string[]};
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
  recoverInterrupted(instanceId: string, time: string): number {
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
        const inputFacts = this.verifyPriorInputFacts(row.id,true,time);
        const facts = row.kind === 'agent' && this.p3 ? this.verifyPriorToolFacts(row.id, true, time) : null;
        const contextFacts = this.verifyPriorContextFacts(row.id);
        const historyFacts = this.verifyPriorHistoryFacts(row.id);
        const extension=prior.success?prior.data.extensions:undefined;
        const exitedExtension=extension?{...extension,state:'disposed' as const,resourcesReleased:true,disposedAt:extension.disposedAt??time}:undefined;
        const extensionReleaseBasis=!extension&&this.readRunExtensions(row.id)?.selection.extension
          ?(prior.success?prior.data.extensionReleaseBasis:undefined)??'owner_process_exited' as const:undefined;
        const extensionReleased=!this.readRunExtensions(row.id)?.selection.extension||!!exitedExtension||!!extensionReleaseBasis;
        const cleanup = facts ? checked(RunCleanupRecordSchema, {
          contract: 'medclaw.run-cleanup/v1', executionStarted: prior.success ? prior.data.executionStarted : null,
          stopConfirmed: facts.stopConfirmed, requiredPersistenceComplete: facts.requiredPersistenceComplete && inputFacts.requiredPersistenceComplete && contextFacts.requiredPersistenceComplete && historyFacts.requiredPersistenceComplete,
          inputsSettled: inputFacts.inputsSettled, resourcesReleased: facts.stopConfirmed===true&&extensionReleased, unconfirmedItems: [...facts.unconfirmedItems,...inputFacts.unconfirmedItems,...contextFacts.unconfirmedItems,...historyFacts.unconfirmedItems,...(extensionReleased?[]:['resources','extension_cleanup'])],
          ...(exitedExtension?{extensions:exitedExtension}:{}),
          ...(extensionReleaseBasis?{extensionReleaseBasis}:{}),
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
