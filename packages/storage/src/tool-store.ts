import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { AppErrorSchema, PositiveIdSchema, safeError, type AppError } from "../../contracts/src/error";
import { BUSINESS_RULES, createQuerySchemas, ChangesQuerySchema, CurrentQuerySchema, QueryParamsSchema, EvidenceSchema, QueryRecordSchema, type Evidence, type QueryRecord, type QueryStore, type QueryContext } from "../../contracts/src/query";
import { canonicalRequest, RunScopeSchema } from "../../contracts/src/run";
import { SqliteEventStore } from './event-store';
import { SqliteWriteTransactions } from './write-transactions';
import type { EventWriter } from '../../contracts/src/event';
import { StoredToolConfigurationSchema } from '../../contracts/src/tool-config';
import { createToolControlObservation, MeasurementContextSchema, ToolControlObservationSchema, type ToolControlObservation } from '../../contracts/src/model';
import { ToolCallRecordSchema, ToolContextIdentitySchema, ToolContextFieldsSchema, ToolExecutionModeSchema, ToolSdkDeliverySchema, type ToolCallIdentity, type ToolCallRecord,
  ToolObservationSchema, type ToolObservation, type ToolCallStore, type ToolExecutionContext, type ToolResult, type ToolSdkDelivery } from "../../contracts/src/tool";
import { InputContentSchema } from '../../contracts/src/session';
import { WorkspaceContextSchema } from '../../contracts/src/workspace';
import { ModelCallContextSchema, ContextSnapshotBodySchema } from '../../contracts/src/context';
import { FrozenRunResourcesSchema, ResourceReadFactSchema, resourceRefKey, type ResourceReadFact } from '../../contracts/src/resources';
import { readFrozenChild } from './child-identity';

const knownErrors = new Set(["invalid_argument", "access_denied", "state_conflict", "operation_not_found", "runtime_interrupted", "storage_read_failed", "storage_write_failed"]);
function fail(code: string): never { throw new Error(code); }
function protect<T>(action: () => T, fallback: string): T {
  try { return action(); }
  catch (error) {
    const safe = AppErrorSchema.safeParse(error);
    if (safe.success && safeError(safe.data.code).code === safe.data.code) throw safeError(safe.data.code, undefined, safe.data);
    if (error instanceof Error && (knownErrors.has(error.message) || ['tool_timeout', 'run_timeout', 'tool_cancelled'].includes(error.message))) throw error;
    return fail(fallback);
  }
}
function json(value: unknown): string {
  return protect(() => {
    const text = JSON.stringify(value);
    if (text === undefined || !isDeepStrictEqual(value, JSON.parse(text))) fail("invalid_argument");
    return canonicalRequest(value);
  }, "invalid_argument");
}
function decode(text: string): unknown { return protect(() => JSON.parse(text), "storage_read_failed"); }
function id(value: number) { if (!PositiveIdSchema.safeParse(value).success) fail("invalid_argument"); }
function cancelled(context: QueryContext) {
  if ('checkActive' in context && typeof context.checkActive === 'function') context.checkActive();
  if (context.signal.aborted) fail("runtime_interrupted");
}
const terminal = (status: ToolCallRecord["status"]) => status === "succeeded" || status === "failed" || status === "cancelled";

function mergeFacts(previous: unknown, incoming: unknown, field = ''): unknown {
  if (isDeepStrictEqual(previous, incoming) || incoming === undefined || incoming === null
    || ['unknown', 'not_reached', 'missing'].includes(String(incoming))) return previous;
  if (previous === undefined || previous === null || ['unknown', 'not_reached', 'missing'].includes(String(previous))) return incoming;
  if (field === 'validationIssues' && Array.isArray(previous) && Array.isArray(incoming)) {
    return [...previous, ...incoming.filter(issue => !previous.some(prior => isDeepStrictEqual(prior, issue)))];
  }
  if (field === 'recoveryAction' && incoming === 'recovered') return incoming;
  if (field === 'observedElapsedMs' && typeof previous === 'number' && typeof incoming === 'number' && incoming >= previous) return incoming;
  if (previous && incoming && typeof previous === 'object' && typeof incoming === 'object' && !Array.isArray(previous) && !Array.isArray(incoming)) {
    const result = { ...previous } as Record<string, unknown>;
    for (const [key, value] of Object.entries(incoming)) result[key] = mergeFacts(result[key], value, key);
    return result;
  }
  return fail('state_conflict');
}

/** Explicit isolated-DB entry point. Do not append these tables to a daily P2 database:
 * openDatabase validates its exact table set until a P3 migration is registered. */
export function initializeToolStorage(db: Database): void {
  protect(() => {
    if (db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys !== 1) fail("invalid_argument");
    db.transaction(() => db.exec(readFileSync(new URL("./tool-schema.sql", import.meta.url), "utf8"))).immediate();
  }, "storage_write_failed");
}

type CallRow = { id: number; run_id: number; session_id: number; native_tool_call_id: string; tool_name: string; tool_version: string; model_call_id?: number | null; context_snapshot_id?: number | null; stopped_at?: string | null;
  requested_at: string; started_at: string | null;
  effect: string; execution_mode: string; args_json: string; status: ToolCallRecord["status"]; result_json: string | null;
  error_json: string | null; delivery_json: string | null; ended_at:string|null };
type QueryRow = { input_id?:number|null; id: number; session_id: number; run_id: number; call_ref: string; kind: QueryRecord["kind"];
  params_json: string; params_hash: string; batch_ids_json: string; result_json: string; result_hash: string; created_at: string;
  source?: QueryRecord['source']; catalog_revision?: number; material_version?: string; based_on_query_id?: number | null };
type EvidenceRow = { id: number; query_id: number; batch_ids_json: string; snapshot_ids_json: string; event_ids_json: string;
  source_row_refs_json: string; calculation_version: string; material_version: string; source_bundle_id: string; source_lock_hash: string; result_hash: string;
  filters_json?: string; provenance?: string };

export class SqliteToolStore implements ToolCallStore, QueryStore {
  private readonly p3: boolean;
  private readonly events: EventWriter | undefined;
  constructor(private readonly db: Database, events?: EventWriter, private readonly transactions=SqliteWriteTransactions.forDatabase(db)) {
    this.events=events??(db.query("SELECT name FROM sqlite_schema WHERE name='runtime_events'").get()?new SqliteEventStore(db,transactions):undefined);
    this.p3 = db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name='catalog_state'").get() !== null;
  }
  private event(row:CallRow,type:'tool_requested'|'tool_started'|'tool_finished',at:string):void {
    if(!this.events)return;
    const queryIds=this.db.query<{id:number},[number,string]>('SELECT id FROM queries WHERE run_id=? AND call_ref=? ORDER BY id').all(row.run_id,`${row.run_id}:${row.native_tool_call_id}`).map(query=>query.id);
    const result=row.result_json===null?null:decode(row.result_json);
    // A read tool can reference the original Query without creating a second one.
    const reference=result&&typeof result==='object'&&'queryId'in result?PositiveIdSchema.safeParse(result.queryId):null;
    if(reference?.success){
      const query=this.db.query<{id:number},[number,number,number]>('SELECT id FROM queries WHERE run_id=? AND id=? AND session_id=?').get(row.run_id,reference.data,row.session_id);
      if(query&&!queryIds.includes(query.id))queryIds.push(query.id);
    }
    const error=row.error_json===null?null:AppErrorSchema.parse(decode(row.error_json)).code;
    const status=row.status;
    const payload={contract:'medclaw.event/v1' as const,callId:row.id,nativeToolCallId:row.native_tool_call_id,status,queryIds,errorCode:error};
    if(type==='tool_requested'&&status==='requested')this.events.appendInTransaction({type,payload:{...payload,status:'requested'},runId:row.run_id,sessionId:row.session_id,source:'tool',sourceConnection:null,sourceSequence:null,toolCallId:row.id,occurredAt:at,receivedAt:at});
    else if(type==='tool_started'&&status==='running')this.events.appendInTransaction({type,payload:{...payload,status:'running'},runId:row.run_id,sessionId:row.session_id,source:'tool',sourceConnection:null,sourceSequence:null,toolCallId:row.id,occurredAt:at,receivedAt:at});
    else if(type==='tool_finished'&&terminal(status))this.events.appendInTransaction({type,payload:{...payload,status:status as 'succeeded'|'failed'|'cancelled'},runId:row.run_id,sessionId:row.session_id,source:'tool',sourceConnection:null,sourceSequence:null,toolCallId:row.id,occurredAt:at,receivedAt:at});
    else fail('state_conflict');
  }
  withQueryTransaction<T>(action: () => T): T {
    try { return this.transactions.immediate(action); }
    catch (error) { if (error instanceof Error && error.name === 'SQLiteError') fail('storage_write_failed'); throw error; }
  }

  private identity(context: QueryContext, active: boolean): void {
    const { signal: _signal, ...identity } = context;
    if (!("nativeToolCallId" in identity ? ToolContextIdentitySchema : ToolContextFieldsSchema.omit({ nativeToolCallId: true })).safeParse(identity).success) fail("invalid_argument");
    if ("source" in context && (!["agent_tool", "intent", "user_form"].includes(context.source) || !context.callRef)) fail("invalid_argument");
    const run = this.db.query<{ kind:string; input_id?:number|null; config_json:string; workspace_json: string | null; session_id: number; status: string; scope_json: string; reference_date: string; timezone: string }, [number]>(
      "SELECT * FROM runs WHERE id=?").get(context.runId);
    if (!run || run.session_id !== context.sessionId || run.reference_date !== context.referenceDate || run.timezone !== context.timezone) fail("access_denied");
    if('inputId' in context && context.inputId !== (run.input_id ?? null)) fail('access_denied');
    const scope = RunScopeSchema.safeParse(decode(run.scope_json));
    if (!scope.success || !isDeepStrictEqual(scope.data, context.scope)) fail("access_denied");
    if(run.kind==='child') {
      const frozen=readFrozenChild(this.db,context.runId);
      if(!('nativeToolCallId' in context)||!context.delegationSource||context.workspaceContext!==null||context.workspaceInputId!==null||context.basedOnQueryId!==null||context.workspaceRevision!==undefined
        ||context.contextSnapshotId==null||!context.modelCallId)fail('access_denied');
      const owner=this.db.query<{snapshot_json:string;input_id:number|null;model_json:string},[number,string,number,number]>(`SELECT s.snapshot_json,s.input_id,c.model_json FROM context_snapshots s JOIN model_calls c ON c.run_id=s.run_id AND c.session_id=s.session_id
        WHERE s.id=? AND c.call_id=? AND s.run_id=? AND s.session_id=? AND c.input_id IS NULL`).get(context.contextSnapshotId,context.modelCallId,context.runId,context.sessionId);
      if(!owner)fail('access_denied');
      const body=ContextSnapshotBodySchema.safeParse(decode(owner.snapshot_json)),model=decode(owner.model_json) as {context?:unknown},marker=ModelCallContextSchema.safeParse(model.context);
      if(!body.success||!marker.success)fail('storage_read_failed');
      if(owner.input_id!==null||marker.data.inputId!==null||marker.data.snapshotId!==context.contextSnapshotId||body.data.workspaceContext!==null
        ||!isDeepStrictEqual(body.data.delegationSource,context.delegationSource)||!isDeepStrictEqual(marker.data.delegationSource,context.delegationSource)
        ||context.delegationSource.parentRunId!==frozen.parentRunId||context.delegationSource.originToolCallId!==frozen.originToolCallId
        ||context.delegationSource.parentSnapshotId!==frozen.originSnapshotId||context.delegationSource.promptHash!==frozen.promptHash)fail('access_denied');
      if(active&&run.status!=='running')fail('state_conflict');
      return;
    }
    if('delegationSource' in context&&context.delegationSource!==undefined)fail('access_denied');
    const p8 = this.p3 && this.db.query("SELECT id FROM runs WHERE id=? AND json_extract(config_json,'$.agent.contextContract')='medclaw.context/v1'").get(context.runId) !== null;
    if (p8 && 'nativeToolCallId' in context) {
      if (context.contextSnapshotId == null || !context.modelCallId || !context.workspaceContext || context.workspaceInputId == null) fail('state_conflict');
      const owner = this.db.query<{snapshot_json:string;input_id:number;model_json:string},[number,string,number,number]>(`SELECT s.snapshot_json,s.input_id,c.model_json FROM context_snapshots s JOIN model_calls c ON c.run_id=s.run_id AND c.session_id=s.session_id WHERE s.id=? AND c.call_id=? AND s.run_id=? AND s.session_id=?`).get(context.contextSnapshotId,context.modelCallId,context.runId,context.sessionId);
      if (!owner) fail('access_denied');
      const body = ContextSnapshotBodySchema.safeParse(decode(owner.snapshot_json)), model = decode(owner.model_json) as {context?:unknown}, marker = ModelCallContextSchema.safeParse(model.context);
      if (!body.success || !marker.success) fail('storage_read_failed');
      if (marker.data.snapshotId !== context.contextSnapshotId || marker.data.inputId !== context.workspaceInputId || owner.input_id !== context.workspaceInputId || !isDeepStrictEqual(body.data.workspaceContext,context.workspaceContext)) fail('access_denied');
    } else if ('nativeToolCallId' in context && context.contextSnapshotId != null) fail('state_conflict');
    if ('nativeToolCallId' in context && context.workspaceContext !== undefined) {
      if (context.workspaceInputId != null) {
        const input = this.db.query<{ session_id: number; target_run_id: number | null; run_id: number | null; status: string;
          native_entry_id: string | null; content_json: string }, [number]>('SELECT * FROM session_inputs WHERE id=?').get(context.workspaceInputId);
        if (!input || input.session_id !== context.sessionId || input.target_run_id !== context.runId || input.run_id !== context.runId
          || input.status !== 'consumed' || !input.native_entry_id) fail('state_conflict');
        const content = InputContentSchema.safeParse(decode(input.content_json));
        if (!content.success) fail('storage_read_failed');
        if (!isDeepStrictEqual(content.data.workspaceContext, context.workspaceContext)
          || !p8 && !isDeepStrictEqual(content.data.scope, context.scope) || content.data.referenceDate !== context.referenceDate
          || content.data.timezone !== context.timezone) fail('access_denied');
      } else {
        if (run.input_id != null || run.workspace_json == null) fail('state_conflict');
        const workspace = WorkspaceContextSchema.safeParse(decode(run.workspace_json));
        if (!workspace.success || !isDeepStrictEqual(workspace.data, context.workspaceContext)) fail('access_denied');
      }
    }
    if (active && run.status !== "running") fail("state_conflict");
  }

  assertContext(context: QueryContext): void { protect(() => this.identity(context, true), "storage_read_failed"); }
  assertReadContext(context: QueryContext): void { protect(() => this.identity(context, false), "storage_read_failed"); }

  private call(row: CallRow): ToolCallRecord {
    const delivery = row.delivery_json === null ? null : decode(row.delivery_json);
    if (delivery !== null && (typeof delivery !== "object" || !Object.hasOwn(delivery, "sdkReturned") || !Object.hasOwn(delivery, "nativeEntryId"))) fail("storage_read_failed");
    const receipt = delivery as { sdkReturned: boolean; nativeEntryId: string | null; message?: ToolSdkDelivery; nextModelCallId?: string | null; consumedAt?: string | null; consumptionEvidence?: unknown; control?: ToolControlObservation; resourceRead?: ResourceReadFact } | null;
    const model = row.model_call_id ? this.db.query<{ call_id: string }, [number]>("SELECT call_id FROM model_calls WHERE id=?").get(row.model_call_id) : null;
    const parsed = ToolCallRecordSchema.safeParse({ id: row.id, runId: row.run_id, sessionId: row.session_id, nativeToolCallId: row.native_tool_call_id,
      name: row.tool_name, version: row.tool_version, executionMode: row.execution_mode, input: decode(row.args_json), status: row.status,
      data: row.result_json === null ? null : decode(row.result_json), error: row.error_json === null ? null : decode(row.error_json),
      sdkReturned: receipt?.sdkReturned ?? false, nativeEntryId: receipt?.nativeEntryId ?? null,
      contextSnapshotId: row.context_snapshot_id ?? null,
      ...(receipt?.message ? { sdkDelivery: receipt.message } : {}), ...(model ? { modelCallId: model.call_id } : {}),
      ...(receipt?.resourceRead ? { resourceRead: receipt.resourceRead } : {}),
      ...(row.stopped_at ? { stoppedAt: row.stopped_at } : {}), ...(receipt?.nextModelCallId ? { nextModelCallId: receipt.nextModelCallId } : {}),
      ...(receipt?.consumedAt ? { consumedAt: receipt.consumedAt } : {}), ...(receipt?.control ? { control: receipt.control } : {}),
      ...(receipt && Object.hasOwn(receipt, 'consumptionEvidence') ? { consumptionEvidence: receipt.consumptionEvidence } : {}) });
    return parsed.success ? parsed.data : fail("storage_read_failed");
  }
  private callRow(context: ToolExecutionContext): CallRow | null {
    const row = this.db.query<CallRow, [number, string]>("SELECT * FROM tool_calls WHERE session_id=? AND native_tool_call_id=?").get(context.sessionId, context.nativeToolCallId);
    if (row && row.run_id !== context.runId) fail("state_conflict");
    if (row && context.contextSnapshotId != null && (row.context_snapshot_id !== context.contextSnapshotId || this.db.query<{call_id:string},[number]>('SELECT call_id FROM model_calls WHERE id=?').get(row.model_call_id!)?.call_id !== context.modelCallId)) fail('state_conflict');
    return row;
  }
  readCall(context: ToolExecutionContext): ToolCallRecord | null {
    return protect(() => { this.identity(context, false); const row = this.callRow(context); return row ? this.call(row) : null; }, "storage_read_failed");
  }
  request(tool: ToolCallIdentity, input: unknown, context: ToolExecutionContext): ToolCallRecord {
    return protect(() => this.transactions.immediate(() => {
      this.identity(context, true);
      const args = json(input);
      const prior = this.callRow(context);
      if (prior) {
        if (prior.tool_name !== tool.name || prior.tool_version !== tool.version || prior.execution_mode !== tool.executionMode
          || prior.effect !== tool.effect || prior.args_json !== args) fail("state_conflict");
        return this.call(prior);
      }
      if (!ToolExecutionModeSchema.safeParse(tool.executionMode).success || !tool.name || !tool.version) fail("invalid_argument");
      const origin = context.contextSnapshotId != null;
      this.db.query(`INSERT INTO tool_calls(session_id,run_id,native_tool_call_id,tool_name,tool_version,effect,execution_mode,args_json,status,requested_at${origin ? ',model_call_id,context_snapshot_id' : ''})
        VALUES(?,?,?,?,?,?,?,?,'requested',?${origin ? ',(SELECT id FROM model_calls WHERE call_id=?),?' : ''})`).run(context.sessionId, context.runId, context.nativeToolCallId, tool.name, tool.version, tool.effect, tool.executionMode, args, new Date().toISOString(),...(origin ? [context.modelCallId!,context.contextSnapshotId!] : []));
      if (this.p3 && !origin) this.db.query(`UPDATE tool_calls SET model_call_id=(SELECT MAX(id) FROM model_calls WHERE run_id=? AND session_id=?)
        WHERE session_id=? AND native_tool_call_id=?`).run(context.runId, context.sessionId, context.sessionId, context.nativeToolCallId);
      const saved=this.callRow(context)!;this.event(saved,'tool_requested',saved.requested_at);
      return this.call(this.callRow(context)!);
    }), "storage_write_failed");
  }
  recordFailedRequest(tool: ToolCallIdentity, input: unknown, context: ToolExecutionContext, error: AppError, requestedAt: string): void {
    protect(() => this.transactions.immediate(() => {
      this.identity(context, false);
      if (this.callRow(context)) fail('state_conflict');
      if (!ToolExecutionModeSchema.safeParse(tool.executionMode).success || !tool.name || !tool.version || !Number.isFinite(Date.parse(requestedAt))) fail('invalid_argument');
      const problem = safeError(AppErrorSchema.parse(error).code, undefined, { runId: context.runId, sessionId: context.sessionId });
      const origin = context.contextSnapshotId != null;
      this.db.query(`INSERT INTO tool_calls(session_id,run_id,native_tool_call_id,tool_name,tool_version,effect,execution_mode,args_json,status,error_json,requested_at,ended_at${origin ? ',model_call_id,context_snapshot_id' : this.p3 ? ',model_call_id' : ''})
        VALUES(?,?,?,?,?,?,?,?,'failed',?,?,?${origin ? ',(SELECT id FROM model_calls WHERE call_id=?),?' : this.p3 ? ',(SELECT MAX(id) FROM model_calls WHERE run_id=?)' : ''})`).run(context.sessionId, context.runId, context.nativeToolCallId, tool.name,
          tool.version, tool.effect, tool.executionMode, json(input), json(problem), requestedAt, new Date().toISOString(), ...(origin ? [context.modelCallId!,context.contextSnapshotId!] : this.p3 ? [context.runId] : []));
      const saved=this.callRow(context)!;this.event(saved,'tool_finished',saved.ended_at!);
    }), 'storage_write_failed');
  }
  private delivery(row: CallRow): Record<string, unknown> {
    if (row.delivery_json !== null) {
      const value = decode(row.delivery_json);
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('storage_read_failed');
      return value as Record<string, unknown>;
    }
    return {
      contract: 'medclaw.tool-delivery/v1',
      resultRecorded: terminal(row.status),
      sdkReturned: false,
      nativeEntryId: null,
      deliveredAt: null,
      nextModelCallId: null,
      consumedAt: null,
      error: null,
    };
  }
  private withControl(row: CallRow, patch: Partial<ToolControlObservation>): Record<string, unknown> {
    if (!ToolControlObservationSchema.partial().safeParse(patch).success) fail('invalid_argument');
    const delivery = this.delivery(row);
    const old = delivery.control === undefined ? createToolControlObservation() : ToolControlObservationSchema.parse(delivery.control);
    const control = ToolControlObservationSchema.parse(mergeFacts(old, patch));
    return { ...delivery, control };
  }
  mergeControl(context: ToolExecutionContext, patch: Partial<ToolControlObservation>): ToolCallRecord {
    return protect(() => this.transactions.immediate(() => {
      this.identity(context, false);
      const row = this.callRow(context);
      if (!row) fail('operation_not_found');
      const delivery = this.withControl(row, patch);
      this.db.query('UPDATE tool_calls SET delivery_json=? WHERE id=?').run(json(delivery), row.id);
      return this.call(this.callRow(context)!);
    }), 'storage_write_failed');
  }
  transition(callId: number, from: ToolCallRecord["status"], to: ToolCallRecord["status"], result?: ToolResult<unknown>, control?: ToolControlObservation): ToolCallRecord {
    return protect(() => this.transactions.immediate(() => {
      id(callId);
      const row = this.db.query<CallRow, [number]>("SELECT * FROM tool_calls WHERE id=?").get(callId);
      if (!row) fail("operation_not_found");
      if (row.status !== from || terminal(from) || !(from === "requested" && ["running", "failed", "cancelled"].includes(to)
        || from === "running" && terminal(to))) fail("state_conflict");
      let data: string | null = null, error: string | null = null;
      if (terminal(to)) {
        if (!result || result.status !== to) fail("invalid_argument");
        if (result.status === "succeeded") data = json(result.data);
        else {
          const parsed = AppErrorSchema.safeParse(result.error);
          if (!parsed.success) fail("invalid_argument");
          error = json(safeError(parsed.data.code, undefined, { runId: row.run_id, sessionId: row.session_id, toolCallId: row.id, reason: parsed.data.reason }));
          if (result.data !== undefined) data = json(result.data);
        }
      } else if (result !== undefined) fail("invalid_argument");
      const now = new Date().toISOString();
      const updated = this.db.query(`UPDATE tool_calls SET status=?,result_json=?,error_json=?,started_at=CASE WHEN ?='running' THEN ? ELSE started_at END,
        ended_at=CASE WHEN ?='running' THEN NULL ELSE ? END WHERE id=? AND status=?`).run(to, data, error, to, now, to, now, callId, from);
      if (updated.changes !== 1) fail("state_conflict");
      if (control !== undefined) {
        const delivery = this.withControl(row, control);
        delivery.resultRecorded = terminal(to);
        this.db.query('UPDATE tool_calls SET delivery_json=? WHERE id=?').run(json(delivery), callId);
      }
      if (this.p3 && from === "running" && terminal(to)) this.db.query("UPDATE tool_calls SET stopped_at=? WHERE id=?").run(now, callId);
      const saved=this.db.query<CallRow, [number]>("SELECT * FROM tool_calls WHERE id=?").get(callId)!;
      this.event(saved,to==='running'?'tool_started':'tool_finished',now);
      return this.call(saved);
    }), "storage_write_failed");
  }
  recordDelivery(context: ToolExecutionContext, nativeEntryId: string, message?: ToolSdkDelivery): void {
    protect(() => this.transactions.immediate(() => {
      this.identity(context, false);
      if (typeof nativeEntryId !== "string" || nativeEntryId.length < 1 || nativeEntryId.length > 256) fail("invalid_argument");
      const row = this.callRow(context);
      if (!row) fail("operation_not_found");
      if (!terminal(row.status)) fail("state_conflict");
      if (message !== undefined && (!ToolSdkDeliverySchema.safeParse(message).success
        || message.toolCallId !== context.nativeToolCallId || message.toolName !== row.tool_name)) fail("invalid_argument");
      const record = this.call(row);
      if (record.sdkReturned) {
        if (record.nativeEntryId !== nativeEntryId || message !== undefined && !isDeepStrictEqual(record.sdkDelivery, message)) fail("state_conflict");
        return;
      }
      this.db.query("UPDATE tool_calls SET delivery_json=? WHERE id=?").run(json({ ...this.delivery(row), contract: "medclaw.tool-delivery/v1", resultRecorded: true, sdkReturned: true, nativeEntryId,
        deliveredAt: new Date().toISOString(), nextModelCallId: null, consumedAt: null,
        error:row.tool_name==='Agent'&&row.status==='succeeded'&&message?.isError?safeError('tool_delivery_failed',undefined,{runId:row.run_id,sessionId:row.session_id,toolCallId:row.id}):null,
        ...(message !== undefined ? { message } : {}) }), row.id);
    }), "storage_write_failed");
  }

  recordResourceRead(context: ToolExecutionContext, raw: ResourceReadFact): void {
    protect(() => this.transactions.immediate(() => {
      this.identity(context, false);
      const parsed = ResourceReadFactSchema.safeParse(raw); if (!parsed.success) fail('invalid_argument'); const fact = parsed.data;
      const row = this.callRow(context); if (!row) fail('operation_not_found'); const record = this.call(row);
      if (record.resourceRead) { if (!isDeepStrictEqual(record.resourceRead, fact)) fail('state_conflict'); return; }
      if (record.name !== 'read' || record.status !== 'succeeded' || !record.sdkReturned || !record.nativeEntryId || !record.sdkDelivery || record.sdkDelivery.isError) fail('state_conflict');
      const config = this.db.query<{ config_json: string }, [number, number]>('SELECT config_json FROM runs WHERE id=? AND session_id=?').get(context.runId, context.sessionId);
      const child=context.delegationSource?readFrozenChild(this.db,context.runId):null;
      const frozen = FrozenRunResourcesSchema.safeParse(child?.resources??(config ? decode(config.config_json) as { agent?: { resources?: unknown } } : null)?.agent?.resources);
      if (!frozen.success || frozen.data.sessionId !== (child?.parentSessionId??context.sessionId)) fail('state_conflict');
      const snapshot = frozen.data.available.find(s => resourceRefKey(s.ref) === resourceRefKey(fact.resourceRef)), file = snapshot?.files.find(f => f.file === fact.file);
      if (!file || file.sha256 !== fact.fileHash || createHash('sha256').update(file.content).digest('hex') !== file.sha256
        || createHash('sha256').update(canonicalRequest(record.sdkDelivery.content)).digest('hex') !== fact.returnedContentHash) fail('state_conflict');
      this.db.query('UPDATE tool_calls SET delivery_json=? WHERE id=?').run(json({ ...this.delivery(row), resourceRead: fact }), row.id);
    }), 'storage_write_failed');
  }
  recordConsumption(context: ToolExecutionContext, nextCallId: string, evidence?: 'provider_input_verified'): void {
    protect(() => this.transactions.immediate(() => {
      this.identity(context, false);
      if (evidence !== undefined && evidence !== 'provider_input_verified') fail('invalid_argument');
      const row = this.callRow(context);
      if (!row || row.delivery_json === null) fail("state_conflict");
      const receipt = decode(row.delivery_json);
      if (receipt === null || typeof receipt !== "object") fail("storage_read_failed");
      if (!('sdkReturned' in receipt) || receipt.sdkReturned !== true) fail('state_conflict');
      const next = this.db.query<{ id: number }, [string, number, number]>("SELECT id FROM model_calls WHERE call_id=? AND run_id=? AND session_id=?").get(nextCallId, context.runId, context.sessionId);
      if (!next || row.model_call_id != null && next.id <= row.model_call_id) fail("state_conflict");
      const previous = this.call(row);
      if (previous.nextModelCallId) return;
      this.db.query("UPDATE tool_calls SET delivery_json=? WHERE id=?").run(json({ ...receipt, nextModelCallId: nextCallId, consumedAt: new Date().toISOString(),
        ...(evidence === undefined ? {} : { consumptionEvidence: evidence }) }), row.id);
    }), "storage_write_failed");
  }

  readToolObservations(input: { cutoffAt: string; maxToolCallId?: number | null; limit: number; windowDays: number }): { maxToolCallId: number | null; observations: ToolObservation[] } {
    return protect(() => this.db.transaction(() => {
      const cutoff = Date.parse(input.cutoffAt);
      const limit = input.limit;
      const windowDays = input.windowDays;
      if (!Number.isFinite(cutoff) || new Date(cutoff).toISOString() !== input.cutoffAt || !Number.isSafeInteger(limit) || limit < 1
        || !Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > Math.floor(Number.MAX_SAFE_INTEGER / 86400000)) fail('invalid_argument');
      if (input.maxToolCallId !== undefined && input.maxToolCallId !== null) id(input.maxToolCallId);
      const maximum = this.db.query<{ maximum: number | null }, [string]>('SELECT MAX(id) AS maximum FROM tool_calls WHERE requested_at<=?').get(input.cutoffAt)!.maximum;
      const maxToolCallId = input.maxToolCallId === undefined ? maximum : input.maxToolCallId;
      if (maxToolCallId === null) return { maxToolCallId, observations: [] };
      const since = new Date(Math.max(-8640000000000000, cutoff - windowDays * 86400000)).toISOString();
      const rows = this.db.query<CallRow & { config_json: string }, [number, string, string, number]>(
        'SELECT t.*,r.config_json FROM tool_calls t JOIN runs r ON r.id=t.run_id WHERE t.id<=? AND t.requested_at>=? AND t.requested_at<=? ORDER BY t.id DESC LIMIT ?')
        .all(maxToolCallId, since, input.cutoffAt, limit);
      const observations = rows.map(row => {
        const delivery = this.delivery(row);
        const config = decode(row.config_json);
        const fields = config && typeof config === 'object' ? config as Record<string, unknown> : {};
        const measurement = MeasurementContextSchema.safeParse(fields.measurementContext);
        const selection = fields.selection && typeof fields.selection === 'object' ? fields.selection as Record<string, unknown> : {};
        const modelKey = ['provider', 'modelId', 'sdkVersion'].every(key => typeof selection[key] === 'string')
          ? canonicalRequest([selection.provider, selection.modelId, selection.sdkVersion]) : null;
        const parsed = ToolObservationSchema.safeParse({
          id: row.id,
          name: row.tool_name,
          version: row.tool_version,
          status: row.status,
          requestedAt: row.requested_at,
          startedAt: row.started_at,
          stoppedAt: row.stopped_at ?? null,
          control: delivery.control ?? null,
          measurementContext: measurement.success ? measurement.data : null,
          modelKey,
          sdkReturned: delivery.sdkReturned === true,
          consumedAt: delivery.consumedAt ?? null,
        });
        return parsed.success ? parsed.data : fail('storage_read_failed');
      });
      return { maxToolCallId, observations };
    }).deferred(), 'storage_read_failed');
  }

  private query(row: QueryRow): QueryRecord {
    const result = decode(row.result_json);
    if (typeof result !== "object" || result === null) fail("storage_read_failed");
    const params = decode(row.params_json);
    const batches = decode(row.batch_ids_json);
    const schema = params && typeof params === 'object' && 'kind' in params ? QueryParamsSchema : row.kind === 'current' ? CurrentQuerySchema : ChangesQuerySchema;
    const prepared = schema.safeParse(params);
    if (!prepared.success || 'kind' in prepared.data && prepared.data.kind !== row.kind
      || row.params_hash !== createHash('sha256').update(canonicalRequest(prepared.data)).digest('hex')) throw safeError('tool_output_inconsistent');
    const headers: Record<string, unknown> = {
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      callRef: row.call_ref,
      kind: row.kind,
      params: prepared.data,
      batchIds: batches,
      resultHash: row.result_hash,
      createdAt: row.created_at,
    };
    for (const [key, value] of Object.entries(headers)) {
      if (Object.hasOwn(result, key) && !isDeepStrictEqual((result as Record<string, unknown>)[key], value)) throw safeError('tool_output_inconsistent');
    }
    const parsed = QueryRecordSchema.safeParse({ ...result, id: row.id, sessionId: row.session_id, runId: row.run_id, inputId: row.input_id ?? null, callRef: row.call_ref,
      kind: row.kind, params: prepared.data, batchIds: batches, resultHash: row.result_hash, createdAt: row.created_at });
    return parsed.success ? parsed.data : fail("storage_read_failed");
  }
  findQuery(callRef: string): QueryRecord | null {
    return protect(() => { const row = this.db.query<QueryRow, [string]>("SELECT * FROM queries WHERE call_ref=?").get(callRef); return row ? this.query(row) : null; }, "storage_read_failed");
  }
  readQuery(queryId: number, sessionId?: number): QueryRecord | null {
    return protect(() => {
      id(queryId);if(sessionId!==undefined)id(sessionId);
      const row = sessionId===undefined?this.db.query<QueryRow,[number]>("SELECT * FROM queries WHERE id=?").get(queryId)
        :this.db.query<QueryRow,[number,number]>("SELECT * FROM queries WHERE id=? AND session_id=?").get(queryId,sessionId);
      return row ? this.query(row) : null;
    }, "storage_read_failed");
  }
  private evidence(row: EvidenceRow): Evidence {
    const parsed = EvidenceSchema.safeParse({ id: row.id, queryId: row.query_id, batchIds: decode(row.batch_ids_json), snapshotIds: decode(row.snapshot_ids_json),
      eventIds: decode(row.event_ids_json), sourceRowRefs: decode(row.source_row_refs_json), calculationVersion: row.calculation_version,
      materialVersion: row.material_version, sourceBundleId: row.source_bundle_id, sourceLockHash: row.source_lock_hash, resultHash: row.result_hash,
      ...(row.filters_json ? { filters: decode(row.filters_json) } : {}), ...(row.provenance ? { provenance: row.provenance } : {}) });
    return parsed.success ? parsed.data : fail("storage_read_failed");
  }
  readEvidence(evidenceId: number): Evidence | null {
    return protect(() => { id(evidenceId); const row = this.db.query<EvidenceRow, [number]>("SELECT * FROM query_evidence WHERE id=?").get(evidenceId); return row ? this.evidence(row) : null; }, "storage_read_failed");
  }
  readChildQuery(queryId: number, context: ToolExecutionContext): QueryRecord | null {
    return protect(()=>{
      id(queryId);this.identity(context,false);
      const frozen=readFrozenChild(this.db,context.runId),record=this.readQuery(queryId);
      if(!record)return null;
      if(record.sessionId===context.sessionId)return record.runId===context.runId?record:null;
      if(record.sessionId!==frozen.parentSessionId)return null;
      const row=this.db.query<{snapshot_json:string},[number,number,number]>('SELECT snapshot_json FROM context_snapshots WHERE id=? AND run_id=? AND session_id=?').get(frozen.originSnapshotId,frozen.parentRunId,frozen.parentSessionId);
      if(!row)fail('storage_read_failed');
      const snapshot=ContextSnapshotBodySchema.parse(decode(row.snapshot_json));
      const savedHash=createHash('sha256').update(canonicalRequest(record)).digest('hex');
      return snapshot.selectedRefs.some(ref=>ref.kind==='query'&&ref.channel==='product_projection'&&ref.id===String(record.id)&&ref.version===record.resultHash&&ref.hash===savedHash)?record:null;
    },'storage_read_failed');
  }
  listEvidence(queryId: number): Evidence[] {
    return protect(() => { id(queryId); return this.db.query<EvidenceRow, [number]>("SELECT * FROM query_evidence WHERE query_id=? ORDER BY id").all(queryId).map(row => this.evidence(row)); }, "storage_read_failed");
  }
  commitQuery(input: Omit<QueryRecord, "id">, inputEvidence: Omit<Evidence, "id" | "queryId">[], context: QueryContext): QueryRecord {
    return protect(() => this.transactions.immediate(() => {
      cancelled(context); this.identity(context, true);
      if (input.runId !== context.runId || input.sessionId !== context.sessionId || input.callRef !== ("callRef" in context ? context.callRef : `${context.runId}:${context.nativeToolCallId}`)
        || !input.batchIds.every(batch => context.scope.batchIds.includes(batch))) fail("access_denied");
      const parsed = QueryRecordSchema.omit({ id: true }).safeParse(input);
      const params = ("kind" in input.params ? QueryParamsSchema : input.kind === "current" ? CurrentQuerySchema : ChangesQuerySchema).safeParse(input.params);
      if (!parsed.success || !params.success) fail("invalid_argument");
      if ('kind' in params.data && params.data.kind !== input.kind) fail('invalid_argument');
      const source = "source" in context ? context.source : "agent_tool";
      const rootInput = this.db.query<{input_id?:number|null},[number]>('SELECT * FROM runs WHERE id=?').get(context.runId)?.input_id ?? null;
      if(input.inputId !== undefined && input.inputId !== rootInput)fail('access_denied');
      if(!this.p3 && rootInput !== null)fail('access_denied');
      if (input.source !== undefined && input.source !== source) fail("access_denied");
      if (!params.data.batchIds.every(batch => context.scope.batchIds.includes(batch))) fail("access_denied");
      if (!isDeepStrictEqual(input.scopeDeviceIds, params.data.deviceIds ?? context.scope.deviceIds)
        || input.scopeDeviceIds?.some(device => context.scope.deviceIds !== null && !context.scope.deviceIds.includes(device))) fail("access_denied");
      if (input.kind === "current" && !input.batchIds.every(batch => params.data.batchIds.includes(batch))) fail("invalid_argument");
      const prior = this.findQuery(input.callRef);
      if (prior) {
        if (prior.sessionId !== input.sessionId || prior.runId !== input.runId || prior.kind !== input.kind || (prior.source ?? 'agent_tool') !== source
          || json(prior.params) !== json(params.data) || json(prior.batchIds) !== json(input.batchIds)
          || json(prior.scopeDeviceIds) !== json(input.scopeDeviceIds)) fail('state_conflict');
        return prior;
      }
      // Validate the saved snapshot without reactivating removed business settings.
      const run = this.db.query<{ config_json?: string | null }, [number]>('SELECT * FROM runs WHERE id=?').get(context.runId);
      if (run?.config_json != null) {
        const saved = decode(run.config_json);
        if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) fail('storage_read_failed');
        if (Object.hasOwn(saved, 'toolConfiguration')) {
          const frozen = StoredToolConfigurationSchema.safeParse((saved as Record<string, unknown>).toolConfiguration);
          if (!frozen.success) fail('storage_read_failed');
        }
      }
      const policySchemas = createQuerySchemas();
      const policySchema = 'kind' in params.data ? policySchemas.QueryParamsSchema
        : input.kind === 'current' ? policySchemas.CurrentQuerySchema : policySchemas.ChangesQuerySchema;
      if (!policySchema.safeParse(params.data).success) fail('invalid_argument');
      if (input.rows.length > BUSINESS_RULES.maxSavedRows) throw safeError('query_result_too_large');
      const references = this.p3 ? this.db.query<{ id: number; material_version: string; source_bundle_id: string; source_lock_hash: string }, [string]>(
        'SELECT id,material_version,source_bundle_id,source_lock_hash FROM batches WHERE id IN (SELECT value FROM json_each(?))').all(json(input.batchIds)) : [];
      if (this.p3) {
        const revision = this.db.query<{ revision: number }, []>('SELECT revision FROM catalog_state WHERE id=1').get()!.revision;
        if (references.length !== input.batchIds.length || input.catalogRevision !== undefined && input.catalogRevision !== revision
          || input.materialVersion !== undefined && input.materialVersion !== [...new Set(references.map(batch => batch.material_version))].sort().join(',')) fail('invalid_argument');
        if ((input.basedOnQueryId ?? null) !== ('basedOnQueryId' in context ? context.basedOnQueryId ?? null : null)) fail('access_denied');
        if (input.basedOnQueryId != null) {
          const parent = this.readQuery(input.basedOnQueryId);
          if (!parent || parent.sessionId !== context.sessionId || parent.batchIds.some(batchId => !context.scope.batchIds.includes(batchId))
            || context.scope.deviceIds !== null && (parent.scopeDeviceIds === null || parent.scopeDeviceIds.some(deviceId => !context.scope.deviceIds!.includes(deviceId)))) fail('access_denied');
        }
      }
      json(input);
      const evidence = inputEvidence.map(value => {
        const checked = EvidenceSchema.omit({ id: true, queryId: true }).safeParse(value);
        if (!checked.success || checked.data.batchIds.some(batch => !input.batchIds.includes(batch))
          || checked.data.snapshotIds.some(snapshot => !input.snapshotIds.includes(snapshot)) || checked.data.eventIds.some(event => !input.eventIds.includes(event))
          || checked.data.resultHash !== input.resultHash || checked.data.calculationVersion !== input.calculationVersion) fail("invalid_argument");
        if (checked.data.filters !== undefined && json(checked.data.filters) !== json(params.data)) fail('invalid_argument');
        if (this.p3 && checked.data.batchIds.some(batchId => {
          const batch = references.find(row => row.id === batchId)!;
          return batch.material_version !== checked.data.materialVersion || batch.source_bundle_id !== checked.data.sourceBundleId || batch.source_lock_hash !== checked.data.sourceLockHash;
        })) fail('invalid_argument');
        json(value); return checked.data;
      });
      const result = { scopeDeviceIds: input.scopeDeviceIds, rows: input.rows, snapshotIds: input.snapshotIds, eventIds: input.eventIds, warnings: input.warnings, calculationVersion: input.calculationVersion,
        ...(input.interpretation === undefined ? {} : { interpretation: input.interpretation }),
        ...(input.source === undefined ? {} : { source: input.source }), ...(input.catalogRevision === undefined ? {} : { catalogRevision: input.catalogRevision }),
        ...(input.materialVersion === undefined ? {} : { materialVersion: input.materialVersion }), ...(input.basedOnQueryId === undefined ? {} : { basedOnQueryId: input.basedOnQueryId }) };
      const extraColumns = this.p3 ? ",source,catalog_revision,material_version,based_on_query_id,input_id" : "";
      const extraValues = this.p3 ? ",?,?,?,?,?" : "";
      const inserted = this.db.query(`INSERT INTO queries(session_id,run_id,call_ref,kind,params_hash,params_json,batch_ids_json,result_json,result_hash,created_at${extraColumns})
        VALUES(?,?,?,?,?,?,?,?,?,?${extraValues})`).run(input.sessionId, input.runId, input.callRef, input.kind,
        createHash("sha256").update(json(params.data)).digest("hex"), json(params.data), json(input.batchIds), json(result), input.resultHash, input.createdAt,
        ...(this.p3 ? [source, input.catalogRevision ?? this.db.query<{ revision: number }, []>("SELECT revision FROM catalog_state WHERE id=1").get()!.revision,
          input.materialVersion ?? inputEvidence.map(item => item.materialVersion).join(","), input.basedOnQueryId ?? null, rootInput] : []));
      const queryId = Number(inserted.lastInsertRowid);
      for (const item of evidence) this.db.query(`INSERT INTO query_evidence(query_id,batch_ids_json,snapshot_ids_json,event_ids_json,source_row_refs_json,
        calculation_version,material_version,source_bundle_id,source_lock_hash,result_hash${this.p3 ? ",filters_json,provenance" : ""}) VALUES(?,?,?,?,?,?,?,?,?,?${this.p3 ? ",?,?" : ""})`).run(queryId, json(item.batchIds),
        json(item.snapshotIds), json(item.eventIds), json(item.sourceRowRefs), item.calculationVersion, item.materialVersion, item.sourceBundleId, item.sourceLockHash, item.resultHash,
        ...(this.p3 ? [json(item.filters ?? params.data), item.provenance ?? "synthetic-derived"] : []));
      if (this.p3) this.db.query("INSERT INTO business_events(operation_ref,type,actor,session_id,run_id,query_id,details_json,occurred_at) VALUES(?,'query_committed',?,?,?,?,?,?)")
        .run(input.callRef, source === "user_form" ? "user" : "agent", input.sessionId, input.runId, queryId,
          json({ queryId, kind: input.kind, resultHash: input.resultHash, source, rowCount: input.rows.length,
            ...('workspaceRevision' in context ? { workspaceRevision: context.workspaceRevision } : {}) }), input.createdAt);
      cancelled(context); this.identity(context, true);
      this.events?.appendInTransaction({type:'query_completed',payload:{contract:'medclaw.event/v1',queryId,resultHash:input.resultHash,batchIds:input.batchIds},runId:input.runId,sessionId:input.sessionId,source:source==='user_form'?'application':'tool',sourceConnection:null,sourceSequence:null,toolCallId:'nativeToolCallId'in context?this.callRow(context)?.id??null:null,occurredAt:input.createdAt,receivedAt:input.createdAt});
      return this.readQuery(queryId)!;
    }), "storage_write_failed");
  }
}
