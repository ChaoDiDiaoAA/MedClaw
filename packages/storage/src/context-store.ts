import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ContextSnapshotBodySchema, ContextSnapshotSchema, ContextDeliverySchema, ContextReadResultSchema, ContextProjectionSchema, ReadContextInputSchema, PrepareContextInputSchema, RegisterContextDeliveryInputSchema, ModelCallContextSchema, CONTEXT_READ_BYTES, CONTEXT_MATERIAL_PREFIX, type ContextStore, type ContextSnapshot, type ContextDelivery, type ContextReadResult, type PrepareContextInput, type SaveContextSelection, type RegisterContextDeliveryInput, type ReadContextInput, type ContextRef, type ContextSource, type NativeContextRef } from '../../contracts/src/context';
import { InputContentSchema } from '../../contracts/src/session';
import { CallResourceContextSchema, FrozenRunResourcesSchema, resourceRefKey } from '../../contracts/src/resources';
import { ToolSdkDeliverySchema } from '../../contracts/src/tool';
import { canonicalRequest, RunScopeSchema } from '../../contracts/src/run';
import { normalizeToolConfiguration } from '../../contracts/src/tool-config';
import { safeError } from '../../contracts/src/error';
import type { EventWriter, WriteTransactions } from '../../contracts/src/event';
import { SqliteWriteTransactions } from './write-transactions';
import { SqliteEventStore } from './event-store';
import { SqliteCatalogStore } from './catalog-store';
import { SqliteToolStore } from './tool-store';
import { freezeWorkspaceScope, resolveQueryRow, readWorkspaceQuery } from './workspace-selection';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const digest = (value: unknown) => hash(canonicalRequest(value));
function fail(code: string): never { throw new Error(code); }
const checked = <T>(schema: z.ZodType<T>, value: unknown, code = 'storage_read_failed'): T => { const parsed = schema.safeParse(value); return parsed.success ? parsed.data : fail(code); };
function protect<T>(action: () => T, fallback: string): T {
  try { return action(); } catch (error) { if (error instanceof Error && error.name === 'SQLiteError') fail(fallback); throw error; }
}
type SnapshotRow = { id: number; run_id: number; session_id: number; input_id: number | null; sequence: number; snapshot_json: string; created_at: string };
type CallRow = { id: number; call_id: string; run_id: number | null; session_id: number | null; input_id: number | null; kind: string; state: string; model_json: string };
type RunRow = { id: number; session_id: number | null; kind: string; status: string; config_json: string; scope_json: string; cleanup_json: string | null; reference_date: string; timezone: string };
type Material = { ref: Omit<ContextRef, 'channel'>; source: ContextSource; provenance: 'public' | 'synthetic' | 'synthetic-derived' | null; fieldOrigins: unknown; value: unknown };

/** One immutable selection per logical request; native history remains Pi's responsibility. */
export class SqliteContextStore implements ContextStore {
  private readonly events: EventWriter;
  constructor(private readonly db: Database, events?: EventWriter, private readonly transactions: WriteTransactions = SqliteWriteTransactions.forDatabase(db)) { this.events = events ?? new SqliteEventStore(db); }
  private run(runId: number): RunRow { const run = this.db.query<RunRow,[number]>('SELECT * FROM runs WHERE id=?').get(runId); return run ?? fail('run_not_found'); }
  private body(row: SnapshotRow) { const body = checked(ContextSnapshotBodySchema, JSON.parse(row.snapshot_json)); if (hash(body.renderedProjection) !== body.projectionHash || hash(body.runtimeFeedback) !== body.feedbackHash || !body.renderedProjection.startsWith(CONTEXT_MATERIAL_PREFIX)) fail('storage_read_failed'); checked(ContextProjectionSchema,JSON.parse(body.renderedProjection.slice(CONTEXT_MATERIAL_PREFIX.length))); return body; }
  private snapshot(row: SnapshotRow): ContextSnapshot {
    const deliveredCallIds = this.db.query<{call_id:string},[number]>('SELECT c.call_id FROM context_deliveries d JOIN model_calls c ON c.id=d.model_call_id WHERE d.snapshot_id=? ORDER BY d.id').all(row.id).map(call => call.call_id);
    return checked(ContextSnapshotSchema, { ...this.body(row), id: row.id, runId: row.run_id, sessionId: row.session_id, inputId: row.input_id, sequence: row.sequence, createdAt: row.created_at, deliveredCallIds });
  }
  select(raw: PrepareContextInput): SaveContextSelection {
    return protect(() => this.db.transaction(() => {
      const input = checked(PrepareContextInputSchema, raw, 'invalid_argument'), run = this.run(input.runId);
      if (run.kind !== 'agent' || run.session_id !== input.sessionId) fail('access_denied');
      if (!['created','running'].includes(run.status)) fail('state_conflict');
      const rootScope = checked(RunScopeSchema, JSON.parse(run.scope_json));
      if (!isDeepStrictEqual(rootScope, input.scope)) fail('access_denied');
      const row = this.db.query<{id:number;session_id:number;run_id:number|null;target_run_id:number|null;status:string;native_entry_id:string|null;content_json:string},[number]>('SELECT * FROM session_inputs WHERE id=?').get(input.inputId);
      if (!row || row.session_id !== input.sessionId || row.run_id !== input.runId || row.target_run_id !== input.runId || row.status !== 'consumed' || row.native_entry_id !== input.nativeEntryId) fail('state_conflict');
      const content = checked(InputContentSchema, JSON.parse(row.content_json));
      if (!isDeepStrictEqual(content.workspaceContext, input.workspaceContext) || content.referenceDate !== run.reference_date || content.timezone !== run.timezone) fail('access_denied');
      const config = JSON.parse(run.config_json), resources = config.agent?.resources ? checked(FrozenRunResourcesSchema, config.agent.resources) : null;
      if (resources ? resources.sessionId !== input.sessionId || resources.configVersion !== content.model.configVersion
        || !isDeepStrictEqual(resources.available.map(s => resourceRefKey(s.ref)), rootScope.allowedResourceRefs) : content.scope.allowedResourceRefs.length || rootScope.allowedResourceRefs.length) fail('resource_unavailable');
      const materialScope = { ...freezeWorkspaceScope(this.db, input.workspaceContext, content.scope.allowedToolNames), allowedResourceRefs: rootScope.allowedResourceRefs };
      if (!isDeepStrictEqual(content.scope, materialScope) || materialScope.batchIds.some(id => !rootScope.batchIds.includes(id)) || rootScope.deviceIds !== null && (materialScope.deviceIds === null || materialScope.deviceIds.some(id => !rootScope.deviceIds!.includes(id))) || materialScope.allowedToolNames.some(name => !rootScope.allowedToolNames.includes(name)) || materialScope.artifactIds.some(id => !rootScope.artifactIds.includes(id)) || rootScope.readOnly && !materialScope.readOnly) fail('access_denied');
      if (content.resourceInputPlan && !content.nativeInput || content.nativeInput && hash(content.nativeInput.text) !== content.nativeInput.sha256) fail('storage_read_failed');
      const catalog = new SqliteCatalogStore(this.db), tools = new SqliteToolStore(this.db), materials: Material[] = [], selectedRefs: ContextRef[] = [];
      const add = (kind: ContextRef['kind'], id: number, version: string, value: unknown, source: ContextSource, provenance: Material['provenance'] = null, fieldOrigins: unknown = {}) => {
        const ref = { kind, id: String(id), version, hash: digest(value), channel: 'product_projection' as const }; selectedRefs.push(ref);
        const {channel, ...identity} = ref; const material = {ref:identity,source,provenance,fieldOrigins,value}; materials.push(material); return material;
      };
      for (const batch of catalog.readBatches(materialScope.batchIds)) selectedRefs.push({kind:'batch',id:String(batch.id),version:batch.materialVersion,hash:digest(batch),channel:'product_projection'});
      const selected = input.workspaceContext.selection;
      const query = input.workspaceContext.queryId === null ? null : readWorkspaceQuery(this.db, input.workspaceContext.queryId, input.workspaceContext);
      const evidence = query ? tools.listEvidence(query.id) : [];
      if (query && digest({kind:query.kind,params:query.params,batchIds:query.batchIds,scopeDeviceIds:query.scopeDeviceIds,rows:query.rows,interpretation:query.interpretation,calculationVersion:query.calculationVersion}) !== query.resultHash) fail('tool_output_inconsistent');
      let optional: Material | null = null;
      if (query) {
        const rows = selected?.kind === 'query-row' ? [selected.field === null ? resolveQueryRow(query,selected.rowKey) : {rowKey:selected.rowKey,fields:{[selected.field]:resolveQueryRow(query,selected.rowKey)[selected.field]}}] : selected === null ? query.rows.slice(0, 20) : [];
        const value = { kind:query.kind, params:query.params, interpretation:query.interpretation ?? null, calculationVersion:query.calculationVersion, totalRows:query.rows.length, rows, warnings:query.warnings, selectedField:selected?.kind === 'query-row' ? selected.field : null };
        const item = add('query',query.id,query.resultHash,value,'program_query_fact','synthetic-derived');
        // The reference hash covers the saved result, including optional rows omitted from the projection.
        item.ref.hash = digest(query); selectedRefs.find(ref => ref.kind === 'query' && ref.id === String(query.id))!.hash = item.ref.hash;
        if (selected === null) optional = item;
      }
      if (selected?.kind === 'device' || selected?.kind === 'evidence' && selected.rowKey !== null || selected?.kind === 'query-row' && selected.rowKey.startsWith('snapshot:')) {
        const item = catalog.readSnapshot(Number(selected.rowKey!.slice(9))); if (!item) fail('access_denied');
        add('snapshot',item.id,input.workspaceContext.batchRefs.find(ref => ref.id === item.batchId)!.contentHash,{ identity:{snapshotId:item.id,deviceId:item.deviceId,batchId:item.batchId}, selectedField:selected.field, fields:selected.field === null ? item : {[selected.field]:Reflect.get(item,selected.field)}, sourceRowRef:item.sourceRowRef, sourceRefs:item.sourceRefs },'source_data',null,item.fieldOrigins);
      }
      if (selected?.kind === 'change' || selected?.kind === 'query-row' && selected.rowKey.startsWith('change:')) {
        const id = selected.kind === 'change' ? Number(selected.targetId) : Number(selected.rowKey.slice(7));
        const item = catalog.readChanges(materialScope.batchIds,materialScope.batchIds,materialScope.deviceIds).find(change => change.id === id); if (!item) fail('access_denied');
        const sources = [item.oldBatchId,item.newBatchId].flatMap(batchId => this.db.query<{id:number},[number,number]>('SELECT id FROM snapshots WHERE batch_id=? AND device_id=?').all(batchId,item.deviceId)).map(row => catalog.readSnapshot(row.id)!);
        add('change',item.id,item.calculationVersion,{...item,selectedField:selected.field,sources:sources.map(source => ({snapshotId:source.id,sourceRowRef:source.sourceRowRef,sourceRefs:source.sourceRefs,fieldOrigins:source.fieldOrigins}))},'program_query_fact','synthetic-derived');
      }
      if (selected?.kind === 'evidence') {
        const item = evidence.find(item => item.id === Number(selected.targetId)); if (!item) fail('access_denied');
        add('evidence',item.id,item.calculationVersion,selected.rowKey === null ? item : {...item,snapshotIds:[Number(selected.rowKey.slice(9))],sourceRowRefs:[]},'program_query_fact',item.provenance ?? 'synthetic-derived');
      }
      const inputRef: NativeContextRef = {kind:'input',id:input.inputId,nativeEntryId:input.nativeEntryId,contentHash:hash(content.nativeInput?.text ?? content.text),nativeToolCallId:null,originSnapshotId:null};
      const nativeRefs = [inputRef];
      for (const ref of input.nativeRefs) {
        if (ref.kind === 'input') { if (!isDeepStrictEqual(ref,inputRef)) fail('access_denied'); continue; }
        const tool = this.db.query<{run_id:number;session_id:number;native_tool_call_id:string;context_snapshot_id:number|null;delivery_json:string|null},[number]>('SELECT * FROM tool_calls WHERE id=?').get(ref.id);
        const delivery = tool?.delivery_json ? JSON.parse(tool.delivery_json) : null;
        const receipt = checked(ToolSdkDeliverySchema, delivery?.message);
        if (!tool || tool.run_id !== input.runId || tool.session_id !== input.sessionId || tool.native_tool_call_id !== ref.nativeToolCallId || tool.context_snapshot_id !== ref.originSnapshotId || delivery?.sdkReturned !== true || delivery.nativeEntryId !== ref.nativeEntryId || digest(receipt.content) !== ref.contentHash) fail('access_denied');
        if (nativeRefs.some(prior => prior.kind === ref.kind && prior.id === ref.id)) fail('state_conflict'); nativeRefs.push(ref);
      }
      for (const ref of nativeRefs) selectedRefs.push({kind:ref.kind === 'input' ? 'input' : 'tool_result',id:String(ref.id),version:ref.kind === 'input' ? 'medclaw.session-input/v1' : 'medclaw.tool-delivery/v1',hash:ref.contentHash,channel:'native_history'});
      const projectionLimitBytes = Math.min(normalizeToolConfiguration(config).maxResultBytes, CONTEXT_READ_BYTES / 2);
      const omitted: SaveContextSelection['body']['omitted'] = [];
      if (optional && query && query.rows.length > 20) omitted.push({kind:'query',id:String(query.id),reason:'capacity',omittedRows:query.rows.length - 20});
      const render = () => CONTEXT_MATERIAL_PREFIX + canonicalRequest(checked(ContextProjectionSchema,JSON.parse(JSON.stringify({contract:'medclaw.context-projection/v1',executionScope:rootScope,materialScope,referenceDate:run.reference_date,timezone:run.timezone,materials,omitted}))));
      let renderedProjection = render();
      while (Buffer.byteLength(renderedProjection + input.runtimeFeedback,'utf8') > projectionLimitBytes && optional && (optional.value as {rows:unknown[]}).rows.length) {
        (optional.value as {rows:unknown[]}).rows.pop(); const prior = omitted.find(item => item.kind === 'query'); if (prior) prior.omittedRows++; else omitted.push({kind:'query',id:optional.ref.id,reason:'capacity',omittedRows:1}); renderedProjection = render();
      }
      if (Buffer.byteLength(renderedProjection + input.runtimeFeedback,'utf8') > projectionLimitBytes) fail('context_projection_too_large');
      const resourceVersions = Object.fromEntries((resources?.available ?? []).map(s => [`${s.ref.kind}:${s.ref.id}`, `${s.ref.version}#${s.ref.treeHash}`]));
      const body = checked(ContextSnapshotBodySchema,{contract:'medclaw.context/v1',workspaceContext:input.workspaceContext,selectedRefs,projectionHash:hash(renderedProjection),renderedProjection,runtimeFeedback:input.runtimeFeedback,feedbackHash:hash(input.runtimeFeedback),resourceVersions,nativeRefs,omitted,projectionLimitBytes},'context_projection_too_large');
      const artifacts = materialScope.artifactIds.map(id => this.db.query('SELECT * FROM artifacts WHERE id=?').get(id));
      return {input,body,sourceFingerprint:digest({runId:run.id,sessionId:run.session_id,config:run.config_json,scope:run.scope_json,input:row.content_json,body,artifacts})};
    }).deferred(), 'storage_read_failed');
  }
  save(selection: SaveContextSelection): ContextSnapshot {
    return protect(() => this.transactions.immediate(() => {
      const current = this.select(selection.input);
      if (current.sourceFingerprint !== selection.sourceFingerprint || !isDeepStrictEqual(current.body,selection.body)) fail('state_conflict');
      const sequence = this.db.query<{n:number},[number]>('SELECT COALESCE(MAX(sequence),0)+1 n FROM context_snapshots WHERE run_id=?').get(selection.input.runId)!.n;
      const provisional = {...selection.body,id:Number.MAX_SAFE_INTEGER,runId:selection.input.runId,sessionId:selection.input.sessionId,inputId:selection.input.inputId,sequence,createdAt:selection.input.createdAt,deliveredCallIds:['x'.repeat(256)]};
      const reserve = {snapshot:provisional,deliveries:[{modelCallId:Number.MAX_SAFE_INTEGER,callId:'x'.repeat(256),snapshotId:Number.MAX_SAFE_INTEGER,runId:provisional.runId,sessionId:provisional.sessionId,deliveredAt:'x'.repeat(64),observation:{contract:'medclaw.context-observation/v1',api:'x'.repeat(128),transport:'aws-event-stream',observedAt:'x'.repeat(64),httpStatus:299,projectionHash:provisional.projectionHash,feedbackHash:provisional.feedbackHash,verifiedNativeRefs:provisional.nativeRefs.map(({kind,id,contentHash}) => ({kind,id,contentHash}))}}],kind:'snapshot',selectedCallId:'x'.repeat(256),evidence:'saved'};
      if (Buffer.byteLength(JSON.stringify(reserve),'utf8') > CONTEXT_READ_BYTES) fail('context_projection_too_large');
      const result = this.db.query('INSERT INTO context_snapshots(run_id,session_id,input_id,sequence,snapshot_json,created_at) VALUES(?,?,?,?,?,?)').run(selection.input.runId,selection.input.sessionId,selection.input.inputId,sequence,JSON.stringify(selection.body),selection.input.createdAt);
      return this.snapshot(this.db.query<SnapshotRow,[number]>('SELECT * FROM context_snapshots WHERE id=?').get(Number(result.lastInsertRowid))!);
    }), 'storage_write_failed');
  }
  private matchesObservation(call: CallRow, snapshot: SnapshotRow, observation: RegisterContextDeliveryInput['observation']): boolean {
    const model = JSON.parse(call.model_json), context = checked(ModelCallContextSchema,model.context), body = this.body(snapshot);
    const resourceMatch = context.resources ? observation.resources !== undefined && CallResourceContextSchema.safeParse({expected:context.resources.expected,payload:observation.resources}).success : observation.resources === undefined;
    return resourceMatch && call.run_id === snapshot.run_id && call.session_id === snapshot.session_id && call.input_id === snapshot.input_id && context.snapshotId === snapshot.id && context.inputId === snapshot.input_id && model.selection?.api === observation.api && body.projectionHash === observation.projectionHash && body.feedbackHash === observation.feedbackHash && observation.verifiedNativeRefs.every(ref => body.nativeRefs.some(native => native.kind === ref.kind && native.id === ref.id && native.contentHash === ref.contentHash));
  }
  private delivery(call: CallRow, row: {snapshot_id:number;run_id:number;session_id:number;delivered_at:string}): ContextDelivery {
    const context = checked(ModelCallContextSchema,JSON.parse(call.model_json).context);
    const snapshot = this.db.query<SnapshotRow,[number]>('SELECT * FROM context_snapshots WHERE id=?').get(row.snapshot_id);
    if (!context.observation || !snapshot || row.run_id !== call.run_id || row.session_id !== call.session_id || !this.matchesObservation(call,snapshot,context.observation)) fail('storage_read_failed');
    return checked(ContextDeliverySchema,{modelCallId:call.id,callId:call.call_id,snapshotId:row.snapshot_id,runId:row.run_id,sessionId:row.session_id,deliveredAt:row.delivered_at,observation:context.observation});
  }
  recordDelivery(raw: RegisterContextDeliveryInput): ContextDelivery {
    return protect(() => this.transactions.immediate(() => {
      const input = checked(RegisterContextDeliveryInputSchema,raw,'invalid_argument'), run = this.run(input.runId);
      const call = this.db.query<CallRow,[string]>('SELECT * FROM model_calls WHERE call_id=?').get(input.callId);
      const snapshot = this.db.query<SnapshotRow,[number]>('SELECT * FROM context_snapshots WHERE id=?').get(input.snapshotId);
      if (!call || !snapshot || run.kind !== 'agent' || call.kind !== 'main' || call.run_id !== input.runId || call.session_id !== input.sessionId || snapshot.run_id !== input.runId || snapshot.session_id !== input.sessionId || snapshot.input_id !== input.inputId || call.input_id !== input.inputId) fail('access_denied');
      const model = JSON.parse(call.model_json), context = checked(ModelCallContextSchema,model.context);
      if (!this.matchesObservation(call,snapshot,input.observation)) fail('state_conflict');
      const prior = this.db.query<{snapshot_id:number;run_id:number;session_id:number;delivered_at:string},[number,number]>('SELECT * FROM context_deliveries WHERE model_call_id=? AND snapshot_id=?').get(call.id,snapshot.id);
      if (prior) { const saved = this.delivery(call,prior); if (!isDeepStrictEqual(saved.observation,input.observation)) fail('state_conflict'); return saved; }
      if (context.observation !== null) fail('state_conflict');
      this.db.query('INSERT INTO context_deliveries(model_call_id,snapshot_id,run_id,session_id,delivered_at) VALUES(?,?,?,?,?)').run(call.id,snapshot.id,input.runId,input.sessionId,input.observation.observedAt);
      model.context = checked(ModelCallContextSchema,{...context,payloadVerified:true,responseStatus:input.observation.httpStatus,observation:input.observation,...(context.resources ? {resources:{expected:context.resources.expected,payload:input.observation.resources}} : {})});
      this.db.query('UPDATE model_calls SET model_json=? WHERE id=?').run(JSON.stringify(model),call.id);
      if (['created','running'].includes(run.status)) this.events.appendInTransaction({type:'context_delivered',payload:{contract:'medclaw.event/v1',snapshotId:snapshot.id,callId:call.call_id},runId:input.runId,sessionId:input.sessionId,source:'pi',sourceConnection:null,sourceSequence:null,toolCallId:null,occurredAt:input.observation.observedAt,receivedAt:new Date().toISOString()});
      return this.delivery({...call,model_json:JSON.stringify(model)},{snapshot_id:snapshot.id,run_id:input.runId,session_id:input.sessionId,delivered_at:input.observation.observedAt});
    }), 'storage_write_failed');
  }
  read(raw: ReadContextInput): ContextReadResult {
    return protect(() => this.db.transaction(() => {
      const input = checked(ReadContextInputSchema,raw,'invalid_argument'); let selectedCallId: string | null = null, observed = false, row: SnapshotRow | null;
      if ('callId' in input) {
        selectedCallId = input.callId;
        const call = this.db.query<CallRow,[string]>('SELECT * FROM model_calls WHERE call_id=?').get(input.callId); if (!call) fail('run_not_found');
        if (call.kind === 'compaction') return checked(ContextReadResultSchema,{kind:'not_recorded',runId:call.run_id,sessionId:call.session_id,callId:call.call_id,reason:'not_applicable'});
        if (call.run_id === null) fail('storage_read_failed');
        const run = this.run(call.run_id), model = JSON.parse(call.model_json);
        if (run.kind !== 'agent' || call.kind !== 'main') return {kind:'not_recorded' as const,runId:run.id,sessionId:run.session_id,callId:call.call_id,reason:'not_applicable' as const};
        if (!model.context) { if (JSON.parse(run.config_json).agent?.contextContract === 'medclaw.context/v1') fail('storage_read_failed'); return {kind:'not_recorded' as const,runId:run.id,sessionId:run.session_id,callId:call.call_id,reason:'pre_p8' as const}; }
        const context = checked(ModelCallContextSchema,model.context);
        observed = context.observation !== null;
        row = this.db.query<SnapshotRow,[number]>('SELECT * FROM context_snapshots WHERE id=?').get(context.snapshotId);
        if (!row || row.run_id !== run.id || row.session_id !== call.session_id || row.input_id !== context.inputId || call.input_id !== row.input_id) fail('storage_read_failed');
      } else row = this.db.query<SnapshotRow,[number]>('SELECT * FROM context_snapshots WHERE id=?').get(input.snapshotId);
      if (!row) fail('resource_unavailable');
      const snapshot = this.snapshot(row), run = this.run(row.run_id), cleanup = run.cleanup_json ? JSON.parse(run.cleanup_json) : null;
      const calls = this.db.query<CallRow & {snapshot_id:number;delivered_at:string;session_id:number;run_id:number},[number]>('SELECT c.*,d.snapshot_id,d.delivered_at FROM context_deliveries d JOIN model_calls c ON c.id=d.model_call_id WHERE d.snapshot_id=? ORDER BY d.id').all(row.id);
      const deliveries = calls.map(call => this.delivery(call,call));
      const saved = selectedCallId === null ? deliveries.length > 0 : deliveries.some(delivery => delivery.callId === selectedCallId);
      if (observed && !saved) fail('storage_read_failed');
      const result = {kind:'snapshot' as const,snapshot,deliveries,selectedCallId,evidence:saved ? 'saved' as const : cleanup?.unconfirmedItems?.some((item: string) => item.startsWith('context_')) ? 'persistence_gap' as const : 'unconfirmed' as const};
      if (Buffer.byteLength(JSON.stringify(result),'utf8') > CONTEXT_READ_BYTES) fail('frame_too_large');
      return checked(ContextReadResultSchema,result);
    }).deferred(), 'storage_read_failed');
  }
  verifyPriorContextFacts(runId: number) { return verifyPriorContextFacts(this.db,runId); }
}

/** Read-only restart proof. A lost in-process receipt cannot be reconstructed from an answer. */
export function verifyPriorContextFacts(db: Database, runId: number) {
  return protect(() => {
    const run = db.query<RunRow,[number]>('SELECT * FROM runs WHERE id=?').get(runId); if (!run) fail('run_not_found');
    if (run.kind !== 'agent' || JSON.parse(run.config_json).agent?.contextContract !== 'medclaw.context/v1') return {requiredPersistenceComplete:true,unconfirmedItems:[]};
    const cleanup = run.cleanup_json ? JSON.parse(run.cleanup_json) : null;
    const priorGap = cleanup?.unconfirmedItems?.some((item: string) => item.startsWith('context_')) ?? false;
    const contexts = new SqliteContextStore(db), unconfirmedItems: string[] = [];
    const calls = db.query<CallRow,[number]>("SELECT * FROM model_calls WHERE run_id=? AND kind<>'compaction' ORDER BY id").all(runId);
    for (const call of calls) {
      const read = contexts.read({callId:call.call_id}); if (read.kind !== 'snapshot') fail('storage_read_failed');
      const context = checked(ModelCallContextSchema,JSON.parse(call.model_json).context);
      const saved = read.deliveries.find(delivery => delivery.callId === call.call_id);
      if (context.observation && !saved) fail('storage_read_failed');
      if (!saved && (priorGap || call.state === 'started' || call.state === 'completed' || context.responseStatus !== null && context.responseStatus >= 200 && context.responseStatus < 300 && context.payloadVerified === true)) unconfirmedItems.push('context_persistence','context_observation_unknown');
    }
    return {requiredPersistenceComplete:unconfirmedItems.length === 0,unconfirmedItems:[...new Set(unconfirmedItems)]};
  }, 'storage_read_failed');
}
