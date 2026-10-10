import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ContextSnapshotBodySchema, ContextSnapshotSchema, ContextDeliverySchema, ContextReadResultSchema, ContextProjectionSchema, ReadContextInputSchema, PrepareContextInputSchema, RegisterContextDeliveryInputSchema, ModelCallContextSchema, CONTEXT_READ_BYTES, CONTEXT_MATERIAL_PREFIX, renderIntentContext, type ContextStore, type ContextSnapshot, type ContextDelivery, type ContextReadResult, type PrepareContextInput, type SaveContextSelection, type RegisterContextDeliveryInput, type ReadContextInput, type ContextRef, type ContextSource, type NativeContextRef } from '../../contracts/src/context';
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
import { freezeWorkspaceScope, resolveQueryRow, readWorkspaceQuery, readWorkspaceBatchReferences } from './workspace-selection';
import { PrepareChildContextInputSchema, type PrepareChildContextInput } from '../../contracts/src/context';
import { readFrozenChild, readDeliveredChild } from './child-identity';
import { IntentStageInputSchema, ProductResultDetailsSchema, QueryContextRecordSchema, type QueryContextRecord } from '../../contracts/src/intent';
import { PrepareIntentContextInputSchema, type PrepareIntentContextInput } from '../../contracts/src/context';

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
  constructor(private readonly db: Database, events?: EventWriter, private readonly transactions: WriteTransactions = SqliteWriteTransactions.forDatabase(db),
    private readonly readQueryContext?: (sessionId:number)=>QueryContextRecord|null) { this.events = events ?? new SqliteEventStore(db); }
  private run(runId: number): RunRow { const run = this.db.query<RunRow,[number]>('SELECT * FROM runs WHERE id=?').get(runId); return run ?? fail('run_not_found'); }
  private body(row: SnapshotRow) {
    const body = checked(ContextSnapshotBodySchema, JSON.parse(row.snapshot_json));
    if (hash(body.renderedProjection) !== body.projectionHash || hash(body.runtimeFeedback) !== body.feedbackHash || !body.renderedProjection.startsWith(CONTEXT_MATERIAL_PREFIX)) fail('storage_read_failed');
    const material = body.renderedProjection.slice(CONTEXT_MATERIAL_PREFIX.length);
    const projection = JSON.parse(body.intentSource ? material.split('\n', 1)[0]! : material);
    if (body.intentSource) {
      const stage = checked(IntentStageInputSchema, projection), input = stage.input;
      if (renderIntentContext(stage) !== body.renderedProjection) fail('storage_read_failed');
      if (body.delegationSource || input.runId !== row.run_id || input.sessionId !== row.session_id || input.inputId !== row.input_id
        || body.intentSource.inputId !== input.inputId || body.intentSource.baseLeafId !== input.baseLeafId
        || body.intentSource.baseStorageVersion !== input.baseStorageVersion) fail('storage_read_failed');
    } else checked(ContextProjectionSchema, projection);
    return body;
  }
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
      if(!this.readQueryContext&&this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='query_contexts'").get()
        &&this.db.query('SELECT session_id FROM query_contexts WHERE session_id=?').get(input.sessionId))fail('state_conflict');
      const currentContext=this.readQueryContext?.(input.sessionId)??null;
      if(currentContext&&(checked(QueryContextRecordSchema,currentContext).sessionId!==input.sessionId))fail('access_denied');
      const materialHashes=[...new Set(input.workspaceContext.batchRefs.map(ref=>ref.contentHash))].sort();
      const adoptedQueryContext=currentContext&&isDeepStrictEqual(currentContext.scopeBatchHashes,materialHashes)?currentContext:null;
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
        const child=readDeliveredChild(this.db,input.runId,ref.id);
        if(child)add('tool_result',ref.id,'child-result/v1',{childRunId:child.childRunId,originToolCallId:child.originToolCallId,
          childResultHash:digest(child),queryRefs:child.queryRefs,evidenceIds:child.evidenceIds,gaps:child.gaps},'program_query_fact');
      }
      for (const ref of nativeRefs) selectedRefs.push({kind:ref.kind === 'input' ? 'input' : 'tool_result',id:String(ref.id),version:ref.kind === 'input' ? 'medclaw.session-input/v1' : 'medclaw.tool-delivery/v1',hash:ref.contentHash,channel:'native_history'});
      const projectionLimitBytes = Math.min(normalizeToolConfiguration(config).maxResultBytes, CONTEXT_READ_BYTES / 2);
      const omitted: SaveContextSelection['body']['omitted'] = [];
      if (optional && query && query.rows.length > 20) omitted.push({kind:'query',id:String(query.id),reason:'capacity',omittedRows:query.rows.length - 20});
      const render = () => CONTEXT_MATERIAL_PREFIX + canonicalRequest(checked(ContextProjectionSchema,JSON.parse(JSON.stringify({contract:'medclaw.context-projection/v1',executionScope:rootScope,materialScope,referenceDate:run.reference_date,timezone:run.timezone,adoptedQueryContext,materials,omitted}))));
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
  selectChild(raw: PrepareChildContextInput): SaveContextSelection {
    return protect(()=>this.db.transaction(()=>{
      const input=checked(PrepareChildContextInputSchema,raw,'invalid_argument'),run=this.run(input.runId),frozen=readFrozenChild(this.db,run.id),source=input.delegationSource;
      if(run.session_id!==input.sessionId||!isDeepStrictEqual(frozen.scope,input.scope)
        ||source.parentRunId!==frozen.parentRunId||source.originToolCallId!==frozen.originToolCallId||source.parentSnapshotId!==frozen.originSnapshotId
        ||source.parentInputId!==frozen.parentInputId||source.promptHash!==frozen.promptHash)fail('access_denied');
      if(!['created','running'].includes(run.status))fail('state_conflict');
      const origin=this.db.query<SnapshotRow,[number]>('SELECT * FROM context_snapshots WHERE id=?').get(frozen.originSnapshotId);
      if(!origin||origin.run_id!==frozen.parentRunId||origin.session_id!==frozen.parentSessionId||origin.input_id!==frozen.parentInputId)fail('access_denied');
      const parent=this.body(origin),projection=checked(ContextProjectionSchema,JSON.parse(parent.renderedProjection.slice(CONTEXT_MATERIAL_PREFIX.length)));
      const native=this.db.query<{entry_json:string},[number,string,number]>("SELECT entry_json FROM memories WHERE session_id=? AND native_entry_id=? AND run_id=? AND entry_type='message'").get(input.sessionId,source.nativeEntryId,run.id);
      const entry=native&&JSON.parse(native.entry_json),content=entry?.message?.content;
      const prompt=typeof content==='string'?content:Array.isArray(content)&&content.every(block=>block.type==='text'&&typeof block.text==='string')?content.map(block=>block.text).join('\n'):null;
      if(entry?.message?.role!=='user'||prompt===null||hash(prompt)!==source.promptHash)fail('access_denied');
      const scope=frozen.scope,catalog=new SqliteCatalogStore(this.db),tools=new SqliteToolStore(this.db);
      const permitted=(ref:ContextRef|Material['ref']):boolean=>{
        const id=Number(ref.id);
        if(ref.kind==='batch')return scope.batchIds.includes(id);
        if(ref.kind==='query') { const query=tools.readQuery(id);return !!query&&query.sessionId===frozen.parentSessionId&&query.batchIds.every(id=>scope.batchIds.includes(id))
          &&(scope.deviceIds===null||query.scopeDeviceIds!==null&&query.scopeDeviceIds.every(id=>scope.deviceIds!.includes(id))); }
        if(ref.kind==='snapshot') { const value=catalog.readSnapshot(id);return !!value&&scope.batchIds.includes(value.batchId)&&(scope.deviceIds===null||scope.deviceIds.includes(value.deviceId)); }
        if(ref.kind==='change')return catalog.readChanges(scope.batchIds,scope.batchIds,scope.deviceIds).some(change=>change.id===id);
        if(ref.kind==='evidence') { const evidence=tools.readEvidence(id);return !!evidence&&permitted({kind:'query',id:String(evidence.queryId),version:ref.version,hash:ref.hash}); }
        return false; // Parent native inputs and tool messages are never copied into child context.
      };
      const selectedRefs=parent.selectedRefs.filter(ref=>ref.channel==='product_projection'&&permitted(ref));
      const materials=projection.materials.filter(material=>permitted(material.ref));
      const nativeRefs:NativeContextRef[]=[];
      for(const ref of input.nativeRefs) {
        if(ref.kind!=='tool_result'||nativeRefs.some(prior=>prior.id===ref.id))fail('access_denied');
        const tool=this.db.query<{run_id:number;session_id:number;native_tool_call_id:string;context_snapshot_id:number;delivery_json:string|null},[number]>('SELECT * FROM tool_calls WHERE id=?').get(ref.id);
        const delivery=tool?.delivery_json?JSON.parse(tool.delivery_json):null,receipt=checked(ToolSdkDeliverySchema,delivery?.message);
        const saved=this.db.query<{entry_json:string},[number,string,number]>('SELECT entry_json FROM memories WHERE session_id=? AND native_entry_id=? AND run_id=?').get(input.sessionId,ref.nativeEntryId,run.id);
        if(!tool||tool.run_id!==run.id||tool.session_id!==input.sessionId||tool.native_tool_call_id!==ref.nativeToolCallId||tool.context_snapshot_id!==ref.originSnapshotId
          ||delivery?.sdkReturned!==true||delivery.nativeEntryId!==ref.nativeEntryId||digest(receipt.content)!==ref.contentHash||!saved||!isDeepStrictEqual(JSON.parse(saved.entry_json).message,receipt))fail('access_denied');
        nativeRefs.push(ref);selectedRefs.push({kind:'tool_result',id:String(ref.id),version:'medclaw.tool-delivery/v1',hash:ref.contentHash,channel:'native_history'});
      }
      const omitted=projection.omitted.filter(item=>selectedRefs.some(ref=>ref.kind===item.kind&&ref.id===item.id));
      const renderedProjection=CONTEXT_MATERIAL_PREFIX+canonicalRequest(checked(ContextProjectionSchema,{...projection,executionScope:scope,materialScope:scope,materials,omitted}));
      const projectionLimitBytes=Math.min(normalizeToolConfiguration(frozen.toolConfiguration).maxResultBytes,parent.projectionLimitBytes);
      const resourceVersions=Object.fromEntries((frozen.resources?.available??[]).filter(resource=>scope.allowedResourceRefs.includes(resourceRefKey(resource.ref)))
        .map(resource=>[`${resource.ref.kind}:${resource.ref.id}`,`${resource.ref.version}#${resource.ref.treeHash}`]));
      const body=checked(ContextSnapshotBodySchema,{contract:'medclaw.context/v1',workspaceContext:null,selectedRefs,projectionHash:hash(renderedProjection),renderedProjection,
        runtimeFeedback:input.runtimeFeedback,feedbackHash:hash(input.runtimeFeedback),resourceVersions,nativeRefs,omitted,projectionLimitBytes,delegationSource:source},'context_projection_too_large');
      return {input,body,sourceFingerprint:digest({child:run.config_json,parent:origin.snapshot_json,prompt:native!.entry_json,body})};
    }).deferred(),'storage_read_failed');
  }
  selectIntent(raw: PrepareIntentContextInput): SaveContextSelection {
    return protect(() => this.db.transaction(() => {
      const input = checked(PrepareIntentContextInputSchema, raw, 'invalid_argument');
      const run = this.db.query<RunRow & { input_id: number; parent_run_id: number | null; cancel_requested_at: string | null }, [number]>('SELECT * FROM runs WHERE id=?').get(input.runId);
      const session = this.db.query<{ kind: string; current_leaf_id: string | null; storage_version: number }, [number]>('SELECT * FROM sessions WHERE id=?').get(input.sessionId);
      const accepted = this.db.query<{ session_id: number; target_run_id: number | null; content_json: string }, [number]>('SELECT * FROM session_inputs WHERE id=?').get(input.inputId);
      if (!run || run.kind !== 'agent' || run.parent_run_id !== null || run.session_id !== input.sessionId || run.input_id !== input.inputId
        || session?.kind !== 'user' || !accepted || accepted.session_id !== input.sessionId || accepted.target_run_id !== input.runId) fail('access_denied');
      if (!['created', 'running'].includes(run.status) || run.cancel_requested_at !== null || session.current_leaf_id !== input.baseLeafId
        || session.storage_version !== input.baseStorageVersion) fail('state_conflict');
      const content = checked(InputContentSchema, JSON.parse(accepted.content_json)), projection = input.projection.input;
      if (!isDeepStrictEqual(input.workspaceContext, content.workspaceContext) || !isDeepStrictEqual(input.scope, checked(RunScopeSchema, JSON.parse(run.scope_json)))
        || projection.text !== content.text || projection.referenceDate !== run.reference_date || projection.timezone !== run.timezone) fail('access_denied');
      const batches = readWorkspaceBatchReferences(this.db, input.scope.batchIds);
      if (!isDeepStrictEqual(projection.scopeBatchHashes, [...new Set(batches.refs.map(ref => ref.contentHash))].sort())
        || batches.refs.some(ref => !content.workspaceContext.batchRefs.some(frozen => isDeepStrictEqual(frozen, ref)))) fail('access_denied');
      const branch = new Map<string, { parent_entry_id: string | null; entry_json: string }>();
      if (input.nativeRefs.length || projection.recentTurns.length) {
        let cursor = input.baseLeafId;
        while (cursor !== null) {
          if (branch.has(cursor)) fail('storage_read_failed');
          const entry = this.db.query<{ parent_entry_id: string | null; entry_json: string }, [number, string]>('SELECT * FROM memories WHERE session_id=? AND native_entry_id=?').get(input.sessionId, cursor);
          if (!entry) fail('storage_read_failed'); branch.set(cursor, entry); cursor = entry.parent_entry_id;
        }
      }
      const nativeRefs: NativeContextRef[] = [], selectedRefs: ContextRef[] = [{ kind: 'input', id: String(input.inputId),
        version: 'medclaw.session-input/v1', hash: digest(content), channel: 'product_projection' }];
      for (const ref of input.nativeRefs) {
        const saved = branch.get(ref.nativeEntryId); if (!saved || nativeRefs.some(prior => prior.kind === ref.kind && prior.id === ref.id)) fail('access_denied');
        const native = JSON.parse(saved.entry_json);
        if (ref.kind === 'input') {
          const previous = this.db.query<{ content_json: string; native_entry_id: string | null; status: string }, [number, number]>('SELECT * FROM session_inputs WHERE id=? AND session_id=?').get(ref.id, input.sessionId);
          if (!previous || previous.status !== 'consumed' || previous.native_entry_id !== ref.nativeEntryId || ref.id === input.inputId) fail('access_denied');
          const priorContent = checked(InputContentSchema, JSON.parse(previous.content_json));
          const text = priorContent.nativeInput?.text ?? priorContent.text;
          if (ref.contentHash !== hash(text) || native.type !== 'message' || native.message?.role !== 'user'
            || !(native.message.content === text || isDeepStrictEqual(native.message.content, [{ type: 'text', text }]))) fail('access_denied');
        } else {
          const tool = this.db.query<{ native_tool_call_id: string; context_snapshot_id: number | null; delivery_json: string | null }, [number, number]>('SELECT * FROM tool_calls WHERE id=? AND session_id=?').get(ref.id, input.sessionId);
          const delivery = tool?.delivery_json ? JSON.parse(tool.delivery_json) : null, receipt = checked(ToolSdkDeliverySchema, delivery?.message, 'access_denied');
          if (!tool || tool.native_tool_call_id !== ref.nativeToolCallId || tool.context_snapshot_id !== ref.originSnapshotId
            || delivery?.sdkReturned !== true || delivery.nativeEntryId !== ref.nativeEntryId || digest(receipt.content) !== ref.contentHash
            || !isDeepStrictEqual(native.message, receipt)) fail('access_denied');
        }
        nativeRefs.push(ref); selectedRefs.push({ kind: ref.kind, id: String(ref.id), version: ref.kind === 'input' ? 'medclaw.session-input/v1' : 'medclaw.tool-delivery/v1', hash: ref.contentHash, channel: 'native_history' });
      }
      for (const turn of projection.recentTurns) {
        const saved = branch.get(turn.nativeEntryId); if (!saved) fail('access_denied');
        const entry = JSON.parse(saved.entry_json), source = entry.type === 'message' ? (entry.message?.role === 'user' ? 'user' : entry.message?.role === 'assistant' ? 'model' : null)
          : entry.type === 'custom_message' && entry.customType === 'medclaw-query-result' ? 'program' : null;
        const content = entry.type === 'message' ? entry.message.content : entry.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : null;
        if (source !== turn.source || text === null || turn.text !== text.slice(0, 4096)) fail('access_denied');
        if (source === 'program') {
          const details = checked(ProductResultDetailsSchema, entry.details, 'access_denied');
          const answer = this.db.query<{ text: string; kind: string; query_ids_json: string; missing_slots_json: string }, [number, number, number, number]>(`SELECT a.* FROM answers a JOIN runs r ON r.id=a.run_id
            JOIN route_decisions d ON d.id=? AND d.run_id=r.id WHERE a.run_id=? AND a.session_id=? AND a.input_id=r.input_id AND r.input_id=? AND r.status='completed'`)
            .get(details.decisionId, details.runId, input.sessionId, details.inputId);
          if (!answer || answer.text !== text || answer.kind !== details.kind || !isDeepStrictEqual(JSON.parse(answer.query_ids_json), details.queryIds)
            || !isDeepStrictEqual(JSON.parse(answer.missing_slots_json), details.missingSlots)) fail('access_denied');
        }
      }
      const renderedProjection = renderIntentContext(input.projection), runtimeFeedback = '';
      const body = checked(ContextSnapshotBodySchema, { contract: 'medclaw.context/v1', workspaceContext: input.workspaceContext, selectedRefs,
        projectionHash: hash(renderedProjection), renderedProjection, runtimeFeedback, feedbackHash: hash(runtimeFeedback), resourceVersions: {},
        nativeRefs, omitted: [], projectionLimitBytes: 24 * 1024 + Buffer.byteLength(CONTEXT_MATERIAL_PREFIX),
        intentSource: { contract: 'medclaw.intent-context/v1', inputId: input.inputId, baseLeafId: input.baseLeafId, baseStorageVersion: input.baseStorageVersion } }, 'intent_input_too_large');
      return { input, body, sourceFingerprint: digest({ accepted: accepted.content_json, config: run.config_json, scope: run.scope_json,
        baseline: { leafId: session.current_leaf_id, storageVersion: session.storage_version }, batches, body }) };
    }).deferred(), 'storage_read_failed');
  }
  save(selection: SaveContextSelection): ContextSnapshot {
    return protect(() => this.transactions.immediate(() => {
      const current = 'projection' in selection.input ? this.selectIntent(selection.input) : selection.input.inputId===null?this.selectChild(selection.input):this.select(selection.input);
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
    const resources = 'resources' in observation ? observation.resources : undefined;
    const resourceMatch = context.resources ? resources !== undefined && CallResourceContextSchema.safeParse({expected:context.resources.expected,payload:resources}).success : resources === undefined;
    return resourceMatch && isDeepStrictEqual(context.intentSource,body.intentSource) && isDeepStrictEqual(context.delegationSource,body.delegationSource) && call.run_id === snapshot.run_id && call.session_id === snapshot.session_id && call.input_id === snapshot.input_id && context.snapshotId === snapshot.id && context.inputId === snapshot.input_id && model.selection?.api === observation.api && body.projectionHash === observation.projectionHash && body.feedbackHash === observation.feedbackHash && observation.verifiedNativeRefs.every(ref => body.nativeRefs.some(native => native.kind === ref.kind && native.id === ref.id && native.contentHash === ref.contentHash));
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
      if (!call || !snapshot || !['agent','child'].includes(run.kind)
        || (call.kind === 'intent' ? run.kind !== 'agent' || input.observation.api !== 'ollama-chat' : call.kind !== 'main' || input.observation.api === 'ollama-chat')
        || call.run_id !== input.runId || call.session_id !== input.sessionId || snapshot.run_id !== input.runId || snapshot.session_id !== input.sessionId || snapshot.input_id !== input.inputId || call.input_id !== input.inputId) fail('access_denied');
      const model = JSON.parse(call.model_json), context = checked(ModelCallContextSchema,model.context);
      if(!isDeepStrictEqual(input.delegationSource,context.delegationSource))fail('access_denied');
      if (!this.matchesObservation(call,snapshot,input.observation)) fail('state_conflict');
      const prior = this.db.query<{snapshot_id:number;run_id:number;session_id:number;delivered_at:string},[number,number]>('SELECT * FROM context_deliveries WHERE model_call_id=? AND snapshot_id=?').get(call.id,snapshot.id);
      if (prior) { const saved = this.delivery(call,prior); if (!isDeepStrictEqual(saved.observation,input.observation)) fail('state_conflict'); return saved; }
      if (context.observation !== null) fail('state_conflict');
      this.db.query('INSERT INTO context_deliveries(model_call_id,snapshot_id,run_id,session_id,delivered_at) VALUES(?,?,?,?,?)').run(call.id,snapshot.id,input.runId,input.sessionId,input.observation.observedAt);
      model.context = checked(ModelCallContextSchema,{...context,payloadVerified:true,responseStatus:input.observation.httpStatus,observation:input.observation,...(context.resources ? {resources:{expected:context.resources.expected,payload:'resources' in input.observation ? input.observation.resources : undefined}} : {})});
      this.db.query('UPDATE model_calls SET model_json=? WHERE id=?').run(JSON.stringify(model),call.id);
      if (['created','running'].includes(run.status)) this.events.appendInTransaction({type:'context_delivered',payload:{contract:'medclaw.event/v1',snapshotId:snapshot.id,callId:call.call_id},runId:input.runId,sessionId:input.sessionId,source:call.kind === 'intent' ? 'intent' : 'pi',sourceConnection:null,sourceSequence:null,toolCallId:null,occurredAt:input.observation.observedAt,receivedAt:new Date().toISOString()});
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
        if (!['agent','child'].includes(run.kind) || !['main','intent'].includes(call.kind)) return {kind:'not_recorded' as const,runId:run.id,sessionId:run.session_id,callId:call.call_id,reason:'not_applicable' as const};
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
    if (run.kind !== 'child' && (run.kind !== 'agent' || JSON.parse(run.config_json).agent?.contextContract !== 'medclaw.context/v1')) return {requiredPersistenceComplete:true,unconfirmedItems:[]};
    if(run.kind==='child')readFrozenChild(db,runId);
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
