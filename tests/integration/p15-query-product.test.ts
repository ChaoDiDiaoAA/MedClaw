import { expect, spyOn, test } from 'bun:test';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentRuntimeFixture } from '../fixtures/agent-runtime';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { disabledIntentModel, productIntent, resolvedIntent, readIntentStageMessage } from '../fixtures/p14-intent';
import { OllamaIntentClient } from '../../packages/intent-ollama/src/index';
import { CLASSIFY_PROMPT } from '../../packages/core/src/intent/prompts/classify';
import { VERIFY_PROMPT } from '../../packages/core/src/intent/prompts/verify';
import { queryProductData, queryProductParams } from '../fixtures/p15-query-product';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { openDatabase } from '../../packages/storage/src/database';
import { SqliteCatalogStore } from '../../packages/storage/src/catalog-store';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { QueryService } from '../../packages/core/src/data/query-service';
import { canonicalRequest } from '../../packages/contracts/src/run';
import { IntentModelConfigurationSchema } from '../../packages/contracts/src/model';
import { SessionService } from '../../packages/core/src/session/session-service';
import { SqliteWriteTransactions } from '../../packages/storage/src/write-transactions';
import type { QueryParams } from '../../packages/contracts/src/query';
import type { IntentStageInput } from '../../packages/contracts/src/intent';
import type { IntentModelConfiguration } from '../../packages/contracts/src/model';

function businessFixture() {
  const data = queryProductData(), root = mkdtempSync(join(tmpdir(), 'medclaw-p15-business-')), db = openDatabase(join(root, 'app.sqlite')), at = '2026-10-11T01:00:00.000Z';
  const context = { sessionId: 1, runId: 1, inputId: null, source: 'agent_tool' as const, callRef: 'business', referenceDate: '2026-10-11', timezone: 'Asia/Shanghai',
    scope: { batchIds: data.batches.map(batch => batch.id), deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true }, signal: new AbortController().signal };
  for (const id of [1, 2]) {
    db.query("INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at) VALUES(?,? ,?,'{}','{}','Business fixture',?,?)").run(id, `native-${id}`, `session-${id}`, at, at);
    if (id === 1) db.query("INSERT INTO runs(id,session_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at) VALUES(?,?,'agent','host',?,1,json_object('sessionId',?,'clientSequence',1),'running','query','Business fixture',?,?,'{}',?,?,?)").run(id, id, `run-${id}`, id, JSON.stringify({ agent: { nativeSessionId: `native-${id}` } }), JSON.stringify(context.scope), context.referenceDate, context.timezone, at);
  }
  db.query("INSERT INTO imports(id,operation_ref,instance_id,state,preview_request_hash,preview_request_json,created_at,updated_at) VALUES(1,'import','host','imported','hash','{}',?,?)").run(at, at);
  db.query('UPDATE catalog_state SET revision=1,updated_at=?').run(at);
  db.transaction(() => {
    for (const batch of data.batches) db.query("INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,? ,?,'{}',?,?,1,?)").run(batch.id, batch.scopeKey, batch.snapshotDate, batch.region, batch.materialVersion, batch.sourceBundleId, batch.sourceLockHash, batch.contentHash, batch.coverage, batch.cohortHash, batch.expectedEntityCount, batch.observedEntityCount, JSON.stringify(batch.declaredMissingDeviceIds), batch.previousBatchId === null ? 1 : 0, batch.previousBatchId, at);
    for (const device of data.devices) db.query('INSERT INTO devices(id,source_device_id,source_bundle_id,source_submission_id,source_applicant,source_refs_json,created_at) VALUES(?,?,?,?,?,?,?)').run(device.id, device.sourceDeviceId, device.sourceBundleId, device.sourceSubmissionId, device.sourceApplicant, JSON.stringify(device.sourceRefs), at);
    for (const row of data.snapshots) db.query('INSERT INTO snapshots(id,batch_id,device_id,device_name,category,region,price_cents,currency,unit,status,manufacturer,distributor,source_row_ref,source_refs_json,field_origins_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id, row.batchId, row.deviceId, row.deviceName, row.category, row.region, row.priceCents, row.currency, row.unit, row.status, row.manufacturer, row.distributor, row.sourceRowRef, JSON.stringify(row.sourceRefs), JSON.stringify(row.fieldOrigins));
    for (const event of data.changes) db.query('INSERT INTO change_events(id,event_key,device_id,old_batch_id,new_batch_id,kind,field,old_value_json,new_value_json,delta_cents,ratio,calculation_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(event.id, `event-${event.id}`, event.deviceId, event.oldBatchId, event.newBatchId, event.kind, event.field, JSON.stringify(event.oldValue), JSON.stringify(event.newValue), event.deltaCents, event.ratio, event.calculationVersion, at);
  }).immediate();
  const store = new SqliteToolStore(db), queries = new QueryService(new CatalogService(new SqliteCatalogStore(db)), store); let counter = 0;
  const execute = async (params: QueryParams) => { const result = await queries.execute(params, { ...context, callRef: `business:${++counter}` }); if (!result.ok) throw result.error; return result.data; };
  return { data, db, context, queries, execute, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('p15 catalog validates cohort membership and original identifiers with indexed lookups', () => {
  const f = businessFixture(), catalog = new SqliteCatalogStore(f.db);
  try {
    const cohort = f.data.devices.map(device => ({ deviceId: device.id, sourceDeviceId: device.sourceDeviceId }));
    for (const batch of f.data.batches) f.db.query('UPDATE batches SET cohort_json=?,metadata_json=? WHERE id=?').run(JSON.stringify(cohort), JSON.stringify({ expectedEntityCount: batch.expectedEntityCount, observedEntityCount: batch.observedEntityCount, declaredMissingEntityIds: batch.declaredMissingDeviceIds.map(id => f.data.devices.find(device => device.id === id)!.sourceDeviceId), referenceDate: f.context.referenceDate, timezone: f.context.timezone }), batch.id);
    expect(catalog.readCatalog(1, 500).snapshotCount).toBe(f.data.snapshots.length);
    f.db.query('UPDATE devices SET source_device_id=? WHERE id=?').run('tampered-original-id', f.data.devices[0]!.id);
    expect(() => catalog.readCatalog(1, 500)).toThrow('tool_output_inconsistent');
  } finally { f.close(); }
});

test('p15 intent projection reads only typed business fields while query evidence retains full provenance checks', () => {
  const f = businessFixture(), store = new SqliteCatalogStore(f.db);
  try {
    const rows = store.readIntentSnapshots([3], null);
    expect(rows).toEqual(f.data.snapshots.filter(row => row.batchId === 3).map(({ sourceRefs: _refs, fieldOrigins: _origins, sourceRowRef: _row, ...value }) => value));
    expect(store.readIntentSnapshots([3], [1])).toHaveLength(1);
    f.db.query("UPDATE snapshots SET source_refs_json='{}' WHERE id=?").run(rows[0]!.id);
    expect(store.readIntentSnapshots([3], [1])).toHaveLength(1);
    expect(() => store.readSnapshots([3], [1])).toThrow('storage_read_failed');
  } finally { f.close(); }
});

test('p15 business facts independently count scoped identifiers, events and complete saved pages', async () => {
  const f = businessFixture();
  try {
    const snapshots = f.data.snapshots.filter(row => [3, 5].includes(row.batchId)), unique = new Set(snapshots.map(row => `${f.data.batches.find(batch => batch.id === row.batchId)!.scopeKey}:${row.deviceId}`));
    const params = queryProductParams({ batchIds: [3, 5], time: { start: '2026-10-11', endExclusive: '2026-10-12' } });
    const current = await f.execute(params); expect(current.rows).toHaveLength(snapshots.length); expect(current.rows).toHaveLength(1004);
    const count = await f.execute({ ...params, kind: 'aggregate', metric: 'count' }); expect(count.rows[0]!.value).toBe(unique.size);
    const pages = [1, 2, 3].map(page => f.queries.page({ queryId: current.id, page, pageSize: 500 }, f.context)); expect(pages.map(page => page.rows.length)).toEqual([500, 500, 4]); expect(pages.flatMap(page => page.rows)).toEqual(current.rows);
    const changes = queryProductParams({ kind: 'aggregate', population: 'changes', snapshotMode: null, batchIds: f.context.scope.batchIds, time: { start: '2026-10-11', endExclusive: '2026-10-12' }, metric: 'change_count' });
    const events = f.data.changes.filter(event => f.data.batches.find(batch => batch.id === event.newBatchId)!.snapshotDate >= changes.time!.start);
    const changed = new Set(events.map(event => `${f.data.batches.find(batch => batch.id === event.newBatchId)!.scopeKey}:${event.deviceId}`));
    expect((await f.execute(changes)).rows[0]!.value).toBe(events.length); expect(events).toHaveLength(3);
    expect((await f.execute({ ...changes, metric: 'changed_device_count' })).rows[0]!.value).toBe(changed.size); expect(changed.size).toBe(2);
    expect(await f.queries.execute({ ...changes, time: { start: '2026-10-09', endExclusive: '2026-10-12' } }, { ...f.context, callRef: 'gap-changes' })).toMatchObject({ ok: false, error: { code: 'data_coverage_missing' } });
    expect(() => f.queries.read(current.id, { ...f.context, sessionId: 2 })).toThrow('access_denied');
    expect(await f.queries.execute(params, { ...f.context, scope: { ...f.context.scope, batchIds: [3] }, callRef: 'outside-scope' })).toMatchObject({ ok: false, error: { code: 'access_denied' } });
  } finally { f.close(); }
});

test('p15 business zero null as_of gaps and price units match independent imported facts', async () => {
  const f = businessFixture();
  try {
    const base = queryProductParams({ batchIds: f.context.scope.batchIds, time: { start: '2026-10-08', endExclusive: '2026-10-09' } });
    const current = await f.execute(base), snapshots = f.data.snapshots.filter(row => [1, 4].includes(row.batchId));
    expect(current.rows.filter(row => row.priceCents === 0)).toHaveLength(snapshots.filter(row => row.priceCents === 0).length); expect(current.rows.filter(row => row.priceCents === null)).toHaveLength(2);
    const means = await f.execute({ ...base, kind: 'aggregate', metric: 'mean_price' });
    expect(means.rows).toHaveLength(2);
    for (const row of means.rows) {
      const population = snapshots.filter(snapshot => snapshot.unit === row.priceUnit), prices = population.map(snapshot => snapshot.priceCents).filter((value): value is number => value !== null);
      expect(row.value).toBeCloseTo(prices.reduce((total, value) => total + value, 0) / prices.length, 10);
      expect(row.validCount).toBe(prices.length); expect(row.zeroCount).toBe(prices.filter(value => value === 0).length); expect(row.missingCount).toBe(population.length - prices.length);
    }
    const asOf = await f.execute({ ...base, time: { start: '2026-10-10', endExclusive: '2026-10-11' }, snapshotMode: 'as_of' });
    expect([...asOf.batchIds].sort((a, b) => a - b)).toEqual([2, 4]); expect(asOf.rows).toHaveLength(1003); expect(asOf.warnings).toHaveLength(2);
    expect(await f.queries.execute({ ...base, time: { start: '2026-10-10', endExclusive: '2026-10-11' } }, { ...f.context, callRef: 'missing-date' })).toMatchObject({ ok: false, error: { code: 'data_coverage_missing' } });
    expect((await f.execute({ ...base, manufacturer: 'No matching manufacturer' })).rows).toHaveLength(0);
    const trend = await f.execute({ ...base, kind: 'trend', metric: 'count', groupBy: 'date', time: { start: '2026-10-08', endExclusive: '2026-10-12' } });
    expect(trend.rows.map(row => [row.date, row.value, row.gap])).toEqual([['2026-10-08', 1004, false], ['2026-10-09', null, true], ['2026-10-10', null, true], ['2026-10-11', 1004, false]]);
    const emptyTrend = await f.execute({ ...base, kind: 'trend', metric: 'count', groupBy: 'date', manufacturer: 'No matching manufacturer', time: { start: '2026-10-08', endExclusive: '2026-10-12' } });
    expect(emptyTrend.rows.map(row => [row.value, row.gap])).toEqual([[0, false], [null, true], [null, true], [0, false]]);
    const zeroOld = queryProductParams({ kind: 'changes', population: 'changes', snapshotMode: null, batchIds: [1, 2], time: { start: '2026-10-09', endExclusive: '2026-10-10' }, changeField: 'price' });
    expect((await f.execute(zeroOld)).rows[0]).toMatchObject({ oldValue: 0, newValue: 102, ratio: null, deltaCents: 102 });
    expect((await f.execute({ ...zeroOld, threshold: { operator: 'gte', value: 0 } })).rows).toHaveLength(0);
    expect(await f.queries.execute({ ...zeroOld, batchIds: [2] }, { ...f.context, scope: { ...f.context.scope, batchIds: [2] }, callRef: 'missing-predecessor' })).toMatchObject({ ok: false, error: { code: 'access_denied' } });
  } finally { f.close(); }
});

test('p15 SQL and memory calculations preserve the same scoped groups, ordering and saved result population', async () => {
  const f = businessFixture(), memory = new QueryService(new CatalogService(f.data), new SqliteToolStore(f.db));
  try {
    const base = queryProductParams({ batchIds: f.context.scope.batchIds, time: { start: '2026-10-11', endExclusive: '2026-10-12' } });
    const cases: QueryParams[] = [base, { ...base, sort: 'desc' },
      { ...base, kind: 'aggregate', metric: 'count', groupBy: 'region', topN: 1 },
      { ...base, kind: 'aggregate', metric: 'mean_price', groupBy: 'status' },
      { ...base, kind: 'changes', population: 'changes', snapshotMode: null },
      { ...base, kind: 'aggregate', population: 'changes', snapshotMode: null, metric: 'change_count' },
      { ...base, kind: 'aggregate', population: 'changes', snapshotMode: null, metric: 'changed_device_count' },
      { ...base, kind: 'trend', metric: 'count', groupBy: 'date', time: { start: '2026-10-08', endExclusive: '2026-10-12' } }];
    for (const [index, params] of cases.entries()) {
      const sql = await f.execute(params), result = await memory.execute(params, { ...f.context, callRef: `memory:${index}` });
      expect(result.ok).toBe(true); if (!result.ok) throw result.error;
      expect(result.data.rows).toEqual(sql.rows); expect(result.data.warnings).toEqual(sql.warnings);
      expect([...result.data.snapshotIds].sort((a, b) => a - b)).toEqual([...sql.snapshotIds].sort((a, b) => a - b));
      expect([...result.data.eventIds].sort((a, b) => a - b)).toEqual([...sql.eventIds].sort((a, b) => a - b));
    }
  } finally { f.close(); }
});

async function formFixture(configuration:IntentModelConfiguration=IntentModelConfigurationSchema.parse(disabledIntentModel())) {
  const client = new OllamaIntentClient({ classify: CLASSIFY_PROMPT, verify: VERIFY_PROMPT });
  const f = await agentRuntimeFixture(undefined, false, undefined, { client, configuration });
  seedWorkspaceQueries(f.db, f.repos);
  f.db.query('UPDATE runs SET cleanup_json=? WHERE id=10').run(JSON.stringify({ contract: 'medclaw.run-cleanup/v1', executionStarted: false,
    stopConfirmed: true, requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: true, unconfirmedItems: [], secondaryErrors: [],
    verifiedAt: '2026-10-04T00:00:00.000Z' }));
  const resolve = f.runtime.resolve.bind(f.runtime), authentications: boolean[] = [];
  f.runtime.resolve = async (...args) => { authentications.push(args[4] !== false); if (args[4] !== false) throw new Error('FORM_MUST_NOT_AUTHENTICATE'); return resolve(...args); };
  const params = queryProductParams({ batchIds: [1], time: { start: '2026-10-04', endExclusive: '2026-10-05' } });
  return { ...f, authentications, requestForm: (conditions:QueryParams=params) => ({ ...f.request('Query form: ' + canonicalRequest(conditions)), routing: { mode: 'user_form' as const, params:conditions } }) };
}

test('p15 form creates its own Input Run Query and native product answer without NLU, main calls or authentication', async () => {
  const f = await formFixture();
  try {
    const request = f.requestForm(), before = f.db.query<{ n: number }, []>('SELECT COUNT(*) n FROM queries').get()!.n;
    const accepted = await f.app.runs.submitAgent(request, { instanceId: 'host', operationRef: 'form:first' });
    expect(accepted).toMatchObject({ ok: true }); if (!accepted.ok) throw accepted.error;
    await f.settle();
    const run = f.repos.read({ runId: accepted.data.runId! });
    expect(run).toMatchObject({ kind: 'one', run: { status: 'completed', inputId: accepted.data.inputId, output: { nextOffset: null } } });
    expect(f.db.query('SELECT COUNT(*) n FROM queries').get()).toEqual({ n: before + 1 });
    expect(f.db.query('SELECT COUNT(*) n FROM intent_calls').get()).toEqual({ n: 0 });
    expect(f.db.query('SELECT COUNT(*) n FROM model_calls').get()).toEqual({ n: 0 });
    expect(f.requests).toHaveLength(0); expect(f.authentications).toEqual([false]);
    const query = f.db.query<{ id: number; source: string; call_ref: string; based_on_query_id: number | null }, [number]>('SELECT * FROM queries WHERE run_id=?').get(accepted.data.runId!)!;
    expect(query).toMatchObject({ source: 'user_form', call_ref: `form:${accepted.data.runId}:${accepted.data.inputId}`, based_on_query_id: request.expectedQueryId });
    expect(f.repos.readQueryContext(1)).toMatchObject({ contract: 'medclaw.query-form-context/v1', params: request.routing.params, queryIds: [query.id], pendingClarification: null });
    expect(f.db.query('SELECT decision_source,route,matched_by,intent_call_id FROM route_decisions WHERE run_id=?').get(accepted.data.runId))
      .toEqual({ decision_source: 'user_form', route: 'simple', matched_by: null, intent_call_id: null });
    const entries = f.repos.readHistorySnapshot(1).entries as { type: string; customType?: string; details?: { source?: string }; message?: { role: string } }[];
    expect(entries.filter(entry => entry.message?.role === 'assistant')).toHaveLength(0);
    expect(entries.at(-3)).toMatchObject({ type: 'custom_message', customType: 'medclaw-query-result', details: { source: 'user_form' } });
    expect(entries.at(-2)?.customType).toBe('medclaw-query-form-execution');
    expect(await f.app.runs.submitAgent(request, { instanceId: 'host', operationRef: 'form:first' })).toEqual(accepted);
    expect(f.authentications).toEqual([false]);
  } finally { await f.close(); }
});

const finalFaults={
  history:"BEFORE INSERT ON memories WHEN NEW.run_id IS NOT NULL",
  leaf:"BEFORE UPDATE OF current_leaf_id ON sessions WHEN NEW.current_leaf_id IS NOT OLD.current_leaf_id",
  answer:'BEFORE INSERT ON answers',context:'BEFORE INSERT ON query_contexts',
  input:"BEFORE UPDATE ON session_inputs WHEN NEW.processing_status='completed'",
  run:"BEFORE UPDATE ON runs WHEN NEW.status='completed'",
  event:"BEFORE INSERT ON runtime_events WHEN NEW.type='run_completed'",
};
for(const [phase,condition] of Object.entries(finalFaults))test(`p15 form final transaction rolls back ${phase} and retries only acquired facts`,async()=>{
  const f=await formFixture();let appends=0;
  const append=f.agent.appendProductTurn.bind(f.agent);f.agent.appendProductTurn=async input=>{appends++;return append(input);};
  try{
    f.db.exec(`CREATE TRIGGER form_final_fault ${condition} BEGIN SELECT RAISE(ABORT,'ENGINEERING_FINAL_FAULT'); END`);
    const accepted=await f.app.runs.submitAgent(f.requestForm(),{instanceId:'host',operationRef:`form:final:${phase}`});if(!accepted.ok)throw accepted.error;
    for(let i=0;i<1000&&!f.app.runs.persistencePending;i++)await Bun.sleep(2);
    expect(f.app.runs.persistencePending).toBe(true);expect(appends).toBe(1);
    const queries=f.db.query('SELECT id,result_hash FROM queries WHERE run_id=?').all(accepted.data.runId!);expect(queries).toHaveLength(1);
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(0);
    expect(f.db.query('SELECT id FROM memories WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(0);
    expect(f.repos.readQueryContext(1)).toBeNull();expect(f.repos.readInput({inputId:accepted.data.inputId!})).toMatchObject({status:'queued',processingStatus:'pending'});
    expect(await f.app.runs.submitAgent(f.requestForm(),{instanceId:'host',operationRef:`form:blocked:${phase}`})).toMatchObject({ok:false,error:{code:'state_conflict'}});
    f.db.exec('DROP TRIGGER form_final_fault');
    expect(await f.app.runs.retrySave(accepted.data.runId!)).toMatchObject({ok:true,data:{status:'completed'}});
    await f.settle();expect(f.db.query('SELECT id,result_hash FROM queries WHERE run_id=?').all(accepted.data.runId!)).toEqual(queries);
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(1);expect(appends).toBe(1);
    expect(f.requests).toHaveLength(0);expect(f.authentications).toEqual([false]);
  }finally{f.db.exec('DROP TRIGGER IF EXISTS form_final_fault');if(f.app.runs.persistencePending&&f.app.runs.activeHandle)await f.app.runs.retrySave(f.app.runs.activeHandle.runId);await f.close();}
});

test('p15 form checks its trusted deadline synchronously before query commit',async()=>{
  const f=await formFixture(),admit=f.toolStore.assertQueryAdmission.bind(f.toolStore);let monotonic:ReturnType<typeof spyOn>|undefined;
  f.toolStore.assertQueryAdmission=(params,context)=>{monotonic=spyOn(performance,'now').mockReturnValue(performance.now()+20000);context.checkActive?.();admit(params,context);};
  try{
    const accepted=await f.app.runs.submitAgent(f.requestForm(),{instanceId:'host',operationRef:'form:expired'});if(!accepted.ok)throw accepted.error;
    monotonic?.mockRestore();await f.settle();
    expect(f.repos.read({runId:accepted.data.runId!})).toMatchObject({kind:'one',run:{status:'failed',error:{code:'run_timeout'}}});
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(0);
    expect(f.repos.readInput({inputId:accepted.data.inputId!})).toMatchObject({status:'failed',processingStatus:'failed'});
    expect(f.requests).toHaveLength(0);
  }finally{monotonic?.mockRestore();await f.close();}
});

test('p15 form Stop during final save retains committed Query without adopting staged history or conditions',async()=>{
  const f=await formFixture(),finalize=f.repos.finalizeAgent.bind(f.repos);let fail=true;
  f.repos.finalizeAgent=(...args)=>{if(fail)throw new Error('ENGINEERING_SAVE');return finalize(...args);};
  try{
    const accepted=await f.app.runs.submitAgent(f.requestForm(),{instanceId:'host',operationRef:'form:stop-final'});if(!accepted.ok)throw accepted.error;
    for(let i=0;i<1000&&!f.app.runs.persistencePending;i++)await Bun.sleep(2);
    expect(f.app.runs.persistencePending).toBe(true);expect(await f.app.runs.cancel(accepted.data.runId!)).toMatchObject({ok:true,data:{cancelRequested:true}});
    fail=false;expect(await f.app.runs.retrySave(accepted.data.runId!)).toMatchObject({ok:true});await f.settle();
    expect(f.repos.readInput({inputId:accepted.data.inputId!})).toMatchObject({status:'cancelled',processingStatus:'cancelled'});
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(1);
    expect(f.db.query('SELECT id FROM memories WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(0);
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(0);expect(f.repos.readQueryContext(1)).toBeNull();
    expect(f.requests).toHaveLength(0);
  }finally{fail=false;if(f.app.runs.persistencePending&&f.app.runs.activeHandle)await f.app.runs.retrySave(f.app.runs.activeHandle.runId);await f.close();}
});

test('p15 form confirms a committed final result after losing the storage acknowledgement',async()=>{
  const f=await formFixture(),finalize=f.repos.finalizeAgent.bind(f.repos);let commits=0,appends=0;
  const append=f.agent.appendProductTurn.bind(f.agent);f.agent.appendProductTurn=async input=>{appends++;return append(input);};
  f.repos.finalizeAgent=(...args)=>{commits++;finalize(...args);throw new Error('ENGINEERING_COMMIT_ACK_LOST');};
  try{
    const request=f.requestForm(),accepted=await f.app.runs.submitAgent(request,{instanceId:'host',operationRef:'form:lost-ack'});if(!accepted.ok)throw accepted.error;await f.settle();
    expect(f.app.runs.persistencePending).toBe(false);expect(commits).toBe(1);expect(appends).toBe(1);
    expect(f.repos.readAnswer(accepted.data.runId!)).toMatchObject({resultSource:'user_form',runId:accepted.data.runId,queryIds:expect.arrayContaining([expect.any(Number)])});
    expect(await f.app.runs.submitAgent(request,{instanceId:'host',operationRef:'form:lost-ack'})).toEqual(accepted);
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(1);
    expect(f.db.query("SELECT id FROM runtime_events WHERE run_id=? AND type='run_completed'").all(accepted.data.runId!)).toHaveLength(1);
    expect(f.requests).toHaveLength(0);expect(f.authentications).toEqual([false]);
  }finally{f.repos.finalizeAgent=finalize;await f.close();}
});

test('p15 form rejects conflicting text, scope and replay identity before new effects',async()=>{
  const f=await formFixture();
  try{
    const request=f.requestForm();
    for(const invalid of [{...request,text:'Untrusted free text'},
      {...request,routing:{...request.routing,params:{...request.routing.params,batchIds:[999]}}}]){
      expect(await f.app.runs.submitAgent(invalid,{instanceId:'host',operationRef:'form:invalid'})).toMatchObject({ok:false,error:{code:'invalid_argument'}});
    }
    expect(f.authentications).toHaveLength(0);expect(f.db.query('SELECT id FROM session_inputs').all()).toHaveLength(0);
    const accepted=await f.app.runs.submitAgent(request,{instanceId:'host',operationRef:'form:identity'});if(!accepted.ok)throw accepted.error;await f.settle();
    const changed={...request,routing:{...request.routing,params:{...request.routing.params,sort:'desc' as const}}};changed.text='Query form: '+canonicalRequest(changed.routing.params);
    expect(await f.app.runs.submitAgent(changed,{instanceId:'host',operationRef:'form:identity'})).toMatchObject({ok:false,error:{code:'state_conflict'}});
    expect(await f.app.runs.submitAgent(request,{instanceId:'host',operationRef:'form:different-op'})).toMatchObject({ok:false,error:{code:'state_conflict'}});
    expect(f.db.query('SELECT id FROM session_inputs').all()).toHaveLength(1);expect(f.authentications).toEqual([false]);expect(f.requests).toHaveLength(0);
  }finally{await f.close();}
});

test('p15 form conditions reach natural-language recognition and the trusted as_of mode survives its full-slot output', async () => {
  const stages:IntentStageInput[]=[];
  const time={start:'2026-10-05',endExclusive:'2026-10-06'};
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/api/version')return Response.json({version:'ENGINEERING'});
    if(path==='/api/tags')return Response.json({models:[{name:'qwen3.5:0.8b',digest:'a'.repeat(64)}]});
    if(path==='/api/show')return Response.json({details:{family:'qwen35',parameter_size:'752.39M',quantization_level:'Q8_0'}});
    const body=await request.json() as {messages:{content:string}[]};stages.push(readIntentStageMessage(body.messages[1]!.content) as IntentStageInput);
    return Response.json({model:'qwen3.5:0.8b',done:true,done_reason:'stop',message:{role:'assistant',content:JSON.stringify({...resolvedIntent(),
      intents:[{...productIntent(),slots:{...productIntent().slots,time,region:'浙江'}}]})},prompt_eval_count:21,eval_count:12});
  }});
  const f=await formFixture(IntentModelConfigurationSchema.parse({...disabledIntentModel(),enabled:true,baseUrl:`http://127.0.0.1:${server.port}`,
    modelDigest:'sha256:'+'a'.repeat(64),verifiedEvidenceRef:'ENGINEERING'}));
  try{
    const first=f.requestForm();first.routing.params={...first.routing.params,time,snapshotMode:'as_of',region:'浙江'};first.text='Query form: '+canonicalRequest(first.routing.params);
    const accepted=await f.app.runs.submitAgent(first,{instanceId:'host',operationRef:'form:as-of'});if(!accepted.ok)throw accepted.error;await f.settle();
    const context=f.repos.readQueryContext(1)!;expect(stages).toHaveLength(0);
    const next={...f.request('继续列出当前条件下的器械'),routing:{mode:'intent' as const,originRunId:null}};
    const preparing = spyOn(f.repos, 'prepareIntentInput');
    const automatic=await f.app.runs.submitAgent(next,{instanceId:'host',operationRef:'form:as-of:followup'});if(!automatic.ok)throw automatic.error;
    expect(preparing).not.toHaveBeenCalled(); await f.settle(); expect(preparing).toHaveBeenCalledTimes(1); preparing.mockRestore();
    expect(stages).toHaveLength(1);expect(stages[0]!.input.previousQueryContext).toEqual(context);
    expect(f.db.query('SELECT params_json FROM queries WHERE run_id=?').get(automatic.data.runId)).toMatchObject({params_json:expect.any(String)});
    const saved=JSON.parse(f.db.query<{params_json:string},[number]>('SELECT params_json FROM queries WHERE run_id=?').get(automatic.data.runId!)!.params_json);
    expect(saved).toMatchObject({snapshotMode:'as_of',time,distributor:null,status:null});
    expect(f.requests).toHaveLength(0);expect(f.authentications).toEqual([false,false]);
  }finally{await f.close();server.stop(true);}
});

test('p15 form correction preserves old results, clears full conditions and restores the corresponding saved branch', async () => {
  const f=await formFixture();
  try {
    const first=f.requestForm();first.routing.params={...first.routing.params,distributor:'配送企业',status:'active'};
    first.text='Query form: '+canonicalRequest(first.routing.params);
    const accepted=await f.app.runs.submitAgent(first,{instanceId:'host',operationRef:'form:condition:first'});if(!accepted.ok)throw accepted.error;
    await f.settle();const original=f.repos.readQueryContext(1)!;
    const queryId=original.queryIds[0]!;f.repos.updateWorkspace({queryId},f.repos.readWorkspace().revision,new Date().toISOString());
    const corrected=f.requestForm({...first.routing.params,distributor:null,status:null,snapshotMode:'as_of'});
    const second=await f.app.runs.submitAgent(corrected,{instanceId:'host',operationRef:'form:condition:second'});expect(second).toMatchObject({ok:true});if(!second.ok)throw second.error;
    await f.settle();const next=f.repos.readQueryContext(1)!;
    expect(next).toMatchObject({contract:'medclaw.query-form-context/v1',params:{distributor:null,status:null,snapshotMode:'as_of'},version:original.version+1});
    expect(next.queryIds[0]).not.toBe(queryId);expect(next.sourceRunId).not.toBe(original.sourceRunId);expect(next.sourceInputId).not.toBe(original.sourceInputId);
    expect(f.db.query('SELECT based_on_query_id FROM queries WHERE id=?').get(next.queryIds[0])).toEqual({based_on_query_id:queryId});
    const sessions=new SessionService('host',f.repos,f.agent,(request,context)=>f.app.runs.submitAgent(request,context),()=>f.app.runs.activeHandle,
      id=>f.app.runs.readInputControl(id),(id,context)=>f.app.runs.cancelInput(id,context),f.app.runs,SqliteWriteTransactions.forDatabase(f.db));
    const checkpoints=await sessions.readCheckpoints({sessionId:1,afterAnswerId:null,limit:20});expect(checkpoints).toMatchObject({ok:true});if(!checkpoints.ok)throw checkpoints.error;
    expect(checkpoints.data.items.map(item=>item.runId)).toEqual([second.data.runId!,accepted.data.runId!]);
    const restored=await sessions.restoreCheckpoint({sessionId:1,targetLeafId:original.nativeLeafId,expectedStorageVersion:f.repos.readSession(1)!.storageVersion,
      expectedWorkspaceRevision:f.repos.readWorkspace().revision},{instanceId:'host',operationRef:'form:restore'});
    expect(restored).toMatchObject({ok:true});expect(f.repos.readQueryContext(1)).toMatchObject({sourceRunId:original.sourceRunId,params:first.routing.params});
    expect(f.requests).toHaveLength(0);expect(f.authentications).toEqual([false,false]);
  }finally{await f.close();}
});

test('p15 form to automatic clear cannot resurrect an older filter and automatic conditions can be edited by form', async () => {
  const stages: ReturnType<typeof readIntentStageMessage>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/version') return Response.json({ version: 'ENGINEERING' });
    if (path === '/api/tags') return Response.json({ models: [{ name: 'qwen3.5:0.8b', digest: 'a'.repeat(64) }] });
    if (path === '/api/show') return Response.json({ details: { family: 'qwen35', parameter_size: '752.39M', quantization_level: 'Q8_0' } });
    const body = await request.json() as { messages: { content: string }[] };
    const stage = readIntentStageMessage(body.messages[1]!.content); stages.push(stage);
    const item = productIntent();
    return Response.json({ model: 'qwen3.5:0.8b', done: true, done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ ...resolvedIntent(),
      intents: [{ ...item, slots: { ...item.slots, time: { start: '2026-10-04', endExclusive: '2026-10-05' }, status: stages.length === 1 ? null : 'active' } }] }) }, prompt_eval_count: 21, eval_count: 12 });
  } });
  const f = await formFixture(IntentModelConfigurationSchema.parse({ ...disabledIntentModel(), enabled: true, baseUrl: `http://127.0.0.1:${server.port}`, modelDigest: 'sha256:' + 'a'.repeat(64), verifiedEvidenceRef: 'ENGINEERING' }));
  try {
    const initial = f.requestForm(); initial.routing.params.status = 'active'; initial.text = 'Query form: ' + canonicalRequest(initial.routing.params);
    const first = await f.app.runs.submitAgent(initial, { instanceId: 'host', operationRef: 'form:clear:start' }); if (!first.ok) throw first.error; await f.settle();
    const cleared = await f.app.runs.submitAgent({ ...f.request('取消器械状态'), mode: 'send', routing: { mode: 'intent', originRunId: null } }, { instanceId: 'host', operationRef: 'form:clear:automatic' }); if (!cleared.ok) throw cleared.error; await f.settle();
    const context = f.repos.readQueryContext(1)!; expect(context).toMatchObject({ sourceRunId: cleared.data.runId, adoptedSlots: { status: null } });
    const queries = f.db.query('SELECT id FROM queries').all();
    const stale = await f.app.runs.submitAgent({ ...f.request('继续当前条件'), mode: 'send', routing: { mode: 'intent', originRunId: null } }, { instanceId: 'host', operationRef: 'form:clear:stale' }); if (!stale.ok) throw stale.error; await f.settle();
    expect(f.repos.read({ runId: stale.data.runId! })).toMatchObject({ kind: 'one', run: { status: 'failed', error: { code: 'intent_output_invalid' } } });
    expect(stages[1]!.input.previousQueryContext).toEqual(context); expect(f.repos.readQueryContext(1)).toEqual(context); expect(f.db.query('SELECT id FROM queries').all()).toEqual(queries);
    const corrected = await f.app.runs.submitAgent(f.requestForm({ ...initial.routing.params, status: null }), { instanceId: 'host', operationRef: 'form:clear:back-to-form' }); if (!corrected.ok) throw corrected.error; await f.settle();
    expect(f.repos.readQueryContext(1)).toMatchObject({ contract: 'medclaw.query-form-context/v1', sourceRunId: corrected.data.runId, params: { status: null } });
    expect(stages).toHaveLength(3);
    expect(stages[2]).toMatchObject({ stage: 'verify', review: { mode: 'semantic_correction', candidates: [] } });
    expect(f.requests).toHaveLength(0); expect(f.authentications).toEqual([false, false, false, false]);
  } finally { await f.close(); server.stop(true); }
});
