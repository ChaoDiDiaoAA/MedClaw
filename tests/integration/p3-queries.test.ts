import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';
import { SqliteCatalogStore } from '../../packages/storage/src/catalog-store';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { QueryService } from '../../packages/core/src/data/query-service';
import { EvidenceReader } from '../../packages/core/src/evidence/evidence-reader';
import { createReadQueryTool } from '../../packages/core/src/tools/business-tools/read-query';
import { ChangesQuerySchema, CurrentQuerySchema, QueryParamsSchema, type QueryExecutionContext } from '../../packages/contracts/src/query';
import type { ToolExecutionContext } from '../../packages/contracts/src/tool';
import { safeError } from '../../packages/contracts/src/error';

const roots: string[] = [];
const handles: Database[] = [];
const time = '2026-10-02T00:00:00.000Z';
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function services(db: Database) {
  const store = new SqliteToolStore(db);
  const catalog = new CatalogService(new SqliteCatalogStore(db));
  const queries = new QueryService(catalog, store);
  return { catalog, queries, evidence: new EvidenceReader(catalog, queries, store) };
}
function fixture(includeOtherRegion = false) {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p3-query-'));
  roots.push(root);
  const path = join(root, 'app.sqlite');
  const db = openDatabase(path);
  handles.push(db);
  const context: ToolExecutionContext = { runId: 1, sessionId: 1, nativeToolCallId: 'current', referenceDate: '2026-01-02', timezone: 'Asia/Shanghai', signal: new AbortController().signal,
    scope: { batchIds: includeOtherRegion ? [1, 2, 3] : [1, 2], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true } };
  db.query(`INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at)
    VALUES(1,'native','create','{}','{}','Query session',?,?)`).run(time, time);
  db.query(`INSERT INTO runs(id,session_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,
    config_json,scope_json,workspace_json,reference_date,timezone,created_at)
    VALUES(1,1,'agent','host','submit',1,'{"sessionId":1,"clientSequence":1}','running','query','Query',
      '{"agent":{"nativeSessionId":"native"}}',?,'{}','2026-01-02','Asia/Shanghai',?)`).run(JSON.stringify(context.scope), time);
  db.query(`INSERT INTO imports(id,operation_ref,instance_id,state,preview_request_hash,preview_request_json,created_at,updated_at)
    VALUES(1,'import','host','imported','hash','{}',?,?)`).run(time, time);
  db.query('UPDATE catalog_state SET revision=1,updated_at=?').run(time);
  for (const id of [1, 2]) {
    db.query(`INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,
      expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at)
      VALUES(?,1,'scope',?,'浙江','material/v1','bundle','lock',?,'full','cohort',3,3,'[]','{}',?,?,1,?)`)
      .run(id, `2026-01-0${id}`, `content-${id}`, id === 1 ? 1 : 0, id === 1 ? null : 1, time);
  }
  const prices = [[10000, 0, null], [8000, 50, 10]];
  const sources = JSON.stringify([{ sourceId: 'fda', file: 'missing-original.csv', recordId: 'source-row', row: 1, sha256: 'a'.repeat(64) }]);
  for (const deviceId of [1, 2, 3]) {
    db.query("INSERT INTO devices(id,source_device_id,source_bundle_id,source_submission_id,source_refs_json,created_at) VALUES(?,?,'bundle','same-submission',?,?)")
      .run(deviceId, `device-${deviceId}`, sources, time);
    for (const batchId of [1, 2]) db.query(`INSERT INTO snapshots(id,batch_id,device_id,device_name,category,region,price_cents,currency,unit,status,manufacturer,distributor,source_row_ref,source_refs_json,field_origins_json)
      VALUES(?,?,?,?,'耗材','浙江',?,'CNY','件','active',?,'配送',?,?,?)`)
      .run((batchId - 1) * 3 + deviceId, batchId, deviceId, `器械${deviceId}`, prices[batchId - 1]![deviceId - 1]!, deviceId === 3 ? '厂家B' : '厂家A', `${batchId}:${deviceId}`, sources,
        '{"price":{"kind":"synthetic","ruleId":"pricing","lastAdjustmentDate":"2026-01-02"}}');
    db.query(`INSERT INTO change_events(id,event_key,device_id,old_batch_id,new_batch_id,kind,field,old_value_json,new_value_json,delta_cents,ratio,calculation_version,created_at)
      VALUES(?,?,?,1,2,'field_changed','price',?,?,999,999,'diff/v1',?)`)
      .run(deviceId, `event-${deviceId}`, deviceId, JSON.stringify(prices[0]![deviceId - 1]), JSON.stringify(prices[1]![deviceId - 1]), time);
  }
  if (includeOtherRegion) {
    db.query(`INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,
      expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at)
      VALUES(3,1,'other-scope','2026-01-01','上海','material/v1','bundle','lock','other-content','full','cohort',3,3,'[]','{}',1,NULL,1,?)`).run(time);
    db.exec(`INSERT INTO snapshots SELECT id+6,3,device_id,device_name,category,'上海',price_cents,currency,unit,status,manufacturer,distributor,source_row_ref,source_refs_json,field_origins_json
      FROM snapshots WHERE batch_id=1`);
  }
  return { db, path, context, ...services(db) };
}

test('production current reads filter in SQLite before decoding unselected rows and commits revision/source/evidence', () => {
  const { db, context, queries, evidence } = fixture();
  // A nonselected row deliberately cannot decode as SourceRef[]; SQL filtering must exclude it first.
  db.query("UPDATE snapshots SET source_refs_json='{}' WHERE device_id=3").run();
  const result = queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2], manufacturer: '厂家A', pageSize: 1 }), context);
  expect(result).toMatchObject({ totalRows: 2, rows: [{ deviceId: 1, priceCents: 8000 }] });
  expect(queries.read(result.queryId, context)).toMatchObject({ source: 'agent_tool', catalogRevision: 1, materialVersion: 'material/v1' });
  expect(evidence.read(result.evidenceIds[0]!, context)).toMatchObject({ sourceRowRefs: ['2:1', '2:2'], filters: { manufacturer: '厂家A' }, provenance: 'synthetic-derived' });
  expect(queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2], manufacturer: "' OR 1=1 --" }), { ...context, nativeToolCallId: 'literal' }).totalRows).toBe(0);
  expect(db.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 2 });
});

test('production changes filters actual joined snapshot arithmetic and separates zero/null and strict/inclusive thresholds', () => {
  const { context, queries } = fixture();
  const base = ChangesQuerySchema.parse({ batchIds: [2], time: { start: '2026-01-02', endExclusive: '2026-01-03' }, changeField: 'price' });
  const all = queries.changes(base, { ...context, nativeToolCallId: 'all' });
  expect(all.rows).toMatchObject([{ deviceId: 1, deltaCents: -2000, ratio: -0.2 }, { deviceId: 2, deltaCents: 50, ratio: null }, { deviceId: 3, deltaCents: null, ratio: null }]);
  expect(queries.changes({ ...base, direction: 'decrease', threshold: { operator: 'gt', value: 0.2 } }, { ...context, nativeToolCallId: 'gt' }).totalRows).toBe(0);
  expect(queries.changes({ ...base, direction: 'decrease', threshold: { operator: 'gte', value: 0.2 } }, { ...context, nativeToolCallId: 'gte' })).toMatchObject({ totalRows: 1, rows: [{ deviceId: 1 }] });
});

test('public aggregate/trend execute uses explicit populations, dates, metric units and trusted source identity', async () => {
  const { db, context, queries } = fixture();
  // SQL summaries and lightweight evidence references must not decode complete snapshot JSON.
  db.query("UPDATE snapshots SET source_refs_json='{}'").run();
  const execution: QueryExecutionContext = { runId: 1, sessionId: 1, inputId: null, source: 'agent_tool', callRef: '1:form-count', scope: context.scope,
    referenceDate: context.referenceDate, timezone: context.timezone, signal: context.signal };
  const count = await queries.execute(QueryParamsSchema.parse({ kind: 'aggregate', population: 'snapshot', snapshotMode: 'exact_date', batchIds: [1, 2], metric: 'count' }), execution);
  expect(count).toMatchObject({ ok: true, data: { source: 'agent_tool', kind: 'aggregate', rows: [{ metric: 'count', value: 3, unit: 'devices' }],
    interpretation: { requestedDate: '2026-01-02', dataDates: ['2026-01-02'], basis: 'distinct_device_identifiers_per_scope', quantity: 3, unit: 'identifiers', isStale: false } } });
  const changed = await queries.execute(QueryParamsSchema.parse({ kind: 'aggregate', population: 'changes', snapshotMode: null, batchIds: [1, 2], metric: 'changed_device_count', time: { start: '2026-01-02', endExclusive: '2026-01-03' } }), { ...execution, callRef: '1:form-changed' });
  expect(changed).toMatchObject({ ok: true, data: { rows: [{ value: 3, unit: 'devices' }], interpretation: { requestedDate: null,
    dataDates: ['2026-01-02'], basis: 'changed_device_identifiers_per_scope', quantity: 3, isStale: null } } });
  const trend = await queries.execute(QueryParamsSchema.parse({ kind: 'trend', population: 'snapshot', snapshotMode: 'exact_date', batchIds: [1, 2], metric: 'count', time: { start: '2026-01-01', endExclusive: '2026-01-04' } }), { ...execution, callRef: '1:form-trend' });
  expect(trend).toMatchObject({ ok: true, data: { rows: [{ date: '2026-01-01', value: 3 }, { date: '2026-01-02', value: 3 }, { date: '2026-01-03', value: null, gap: true }],
    interpretation: { requestedDate: null, dataDates: ['2026-01-01', '2026-01-02'], quantity: null, isStale: null } } });
  const repeated = await queries.execute(QueryParamsSchema.parse({ kind: 'aggregate', population: 'snapshot', snapshotMode: 'exact_date', batchIds: [1, 2], metric: 'count' }), execution);
  expect(repeated).toEqual(count);
  expect((await queries.execute(QueryParamsSchema.parse({ kind: 'aggregate', population: 'snapshot', snapshotMode: 'exact_date', batchIds: [1, 2], metric: 'sum_price' }), execution))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
});

test('SQL price aggregation separates units, counts valid/zero/missing prices and keeps grouped trend gaps explicit', async () => {
  const { db, context, queries } = fixture();
  db.query("UPDATE snapshots SET unit='box',price_cents=NULL WHERE device_id=3").run();
  const execution: QueryExecutionContext = { runId: 1, sessionId: 1, inputId: null, source: 'agent_tool', callRef: '1:mean', scope: context.scope,
    referenceDate: context.referenceDate, timezone: context.timezone, signal: context.signal };
  const mean = await queries.execute(QueryParamsSchema.parse({ kind: 'aggregate', population: 'snapshot', snapshotMode: 'exact_date', batchIds: [1, 2], metric: 'mean_price',
    time: { start: '2026-01-01', endExclusive: '2026-01-02' } }), execution);
  expect(mean).toMatchObject({ ok: true, data: { rows: [
    { priceUnit: '件', value: 5000, validCount: 2, zeroCount: 1, missingCount: 0 },
    { priceUnit: 'box', value: null, validCount: 0, zeroCount: 0, missingCount: 1 },
  ] } });
  const trend = await queries.execute(QueryParamsSchema.parse({ kind: 'trend', population: 'snapshot', snapshotMode: 'exact_date', batchIds: [1, 2], metric: 'sum_price',
    time: { start: '2026-01-01', endExclusive: '2026-01-04' } }), { ...execution, callRef: '1:sum-trend' });
  expect(trend).toMatchObject({ ok: true, data: { rows: [
    { date: '2026-01-01', priceUnit: 'box', value: null, gap: false },
    { date: '2026-01-01', priceUnit: '件', value: 10000, gap: false },
    { date: '2026-01-02', priceUnit: 'box', value: null, gap: false },
    { date: '2026-01-02', priceUnit: '件', value: 8050, gap: false },
    { date: '2026-01-03', priceUnit: 'box', value: null, gap: true },
    { date: '2026-01-03', priceUnit: '件', value: null, gap: true },
  ] } });
});

test('reopening reads original saved Query and evidence after its Run is terminal without recomputing new catalog facts', () => {
  const { db, path, context, queries } = fixture();
  const result = queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2] }), context);
  db.query("UPDATE runs SET status='completed',output_text='saved',ended_at=? WHERE id=1").run(time);
  db.query('UPDATE catalog_state SET revision=2').run();
  handles.splice(handles.indexOf(db), 1); db.close();
  const reopened = openDatabase(path); handles.push(reopened);
  const next = services(reopened);
  expect(next.queries.page({ queryId: result.queryId, page: 2, pageSize: 1 }, context)).toMatchObject({ totalRows: 3, rows: [{ deviceId: 2, priceCents: 50 }],
    interpretation: { requestedDate: '2026-01-02', referenceDate: '2026-01-02', timezone: 'Asia/Shanghai', dataDates: ['2026-01-02'], quantity: 3 } });
  expect(next.queries.read(result.queryId, context)).toMatchObject({ catalogRevision: 1 });
  expect(next.evidence.rows({ evidenceId: result.evidenceIds[0]!, page: 1, pageSize: 1 }, context).items[0]).toMatchObject({ priceCents: 8000 });
});

test('dated snapshot counts expose the requested date, actual data date and status without using the reference date or page length as the count', async () => {
  const { db, context, queries } = fixture();
  db.query("UPDATE snapshots SET status='suspended' WHERE batch_id=2 AND device_id=3").run();
  const historical = queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2], time: { start: '2026-01-01', endExclusive: '2026-01-02' }, pageSize: 1 }), context);
  expect(historical).toMatchObject({ totalRows: 3, interpretation: {
    requestedDate: '2026-01-01', requestedTime: { start: '2026-01-01', endExclusive: '2026-01-02' }, referenceDate: '2026-01-02', timezone: 'Asia/Shanghai',
    dataDates: ['2026-01-01'], snapshotMode: 'exact_date', basis: 'snapshot_records', status: null, quantity: 3, unit: 'records', isStale: false,
  } });
  expect(await createReadQueryTool({ queries }).execute({ queryId: historical.queryId }, context)).toMatchObject({
    interpretation: { requestedDate: '2026-01-01', dataDates: ['2026-01-01'], quantity: 3, basis: 'snapshot_records' },
  });
  const active = queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2], status: 'active', pageSize: 1 }), { ...context, nativeToolCallId: 'active-count' });
  expect(active).toMatchObject({ totalRows: 2, interpretation: { requestedDate: '2026-01-02', dataDates: ['2026-01-02'], status: 'active', quantity: 2 } });
  expect(db.query<{ result: string }, [number]>('SELECT result_json AS result FROM queries WHERE id=?').get(historical.queryId)?.result).toContain('"requestedDate":"2026-01-01"');
});

test('as-of after coverage reports stale source dates and preserves its cutoff across paging while exact-date fails', () => {
  const { context, queries } = fixture();
  const input = CurrentQuerySchema.parse({ batchIds: [1, 2], snapshotMode: 'as_of', time: { start: '2026-01-05', endExclusive: '2026-01-06' }, pageSize: 1 });
  const result = queries.current(input, context);
  expect(result).toMatchObject({ totalRows: 3, interpretation: { requestedDate: '2026-01-05', referenceDate: '2026-01-02', dataDates: ['2026-01-02'], quantity: 3, isStale: true } });
  expect(queries.page({ queryId: result.queryId, page: 3, pageSize: 1 }, context)).toMatchObject({ rows: [{ deviceId: 3 }],
    interpretation: { requestedDate: '2026-01-05', dataDates: ['2026-01-02'], quantity: 3, isStale: true } });
  expect(queries.current(input, context)).toEqual(result);
  expect(() => queries.current({ ...input, snapshotMode: 'exact_date' }, { ...context, nativeToolCallId: 'missing-day' })).toThrow('data_coverage_missing');
});

test('zero matches still identify the actual snapshot date and legacy saved queries do not invent an unrecorded cutoff', () => {
  const { db, context, queries } = fixture();
  const result = queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2], manufacturer: 'Unknown manufacturer' }), context);
  expect(result).toMatchObject({ totalRows: 0, interpretation: { requestedDate: '2026-01-02', dataDates: ['2026-01-02'], quantity: 0, isStale: false } });
  const { id: _id, interpretation: _interpretation, ...legacy } = queries.read(result.queryId, context);
  const saved = new SqliteToolStore(db).commitQuery({ ...legacy, callRef: '1:legacy-empty' }, [], { ...context, nativeToolCallId: 'legacy-empty' });
  expect(queries.page({ queryId: saved.id, page: 1, pageSize: 50 }, context)).toMatchObject({ interpretation: {
    requestedDate: null, referenceDate: null, timezone: null, dataDates: ['2026-01-02'], quantity: 0, isStale: null,
  } });
});

test('excluded regions cannot make a fresh regional count stale or require a missing batch in that other region', async () => {
  const { context, queries } = fixture(true);
  const input = CurrentQuerySchema.parse({ batchIds: [1, 2, 3], region: '浙江', snapshotMode: 'as_of' });
  expect(queries.current(input, context)).toMatchObject({ totalRows: 3, warnings: [], interpretation: { dataDates: ['2026-01-02'], quantity: 3, isStale: false } });
  expect(queries.current({ ...input, snapshotMode: 'exact_date' }, { ...context, nativeToolCallId: 'region-exact' })).toMatchObject({ totalRows: 3 });
  const execution: QueryExecutionContext = { runId: 1, sessionId: 1, inputId: null, source: 'agent_tool', callRef: '1:region-summary', scope: context.scope,
    referenceDate: context.referenceDate, timezone: context.timezone, signal: context.signal };
  expect(await queries.execute(QueryParamsSchema.parse({ kind: 'aggregate', population: 'snapshot', snapshotMode: 'as_of', batchIds: [1, 2, 3], region: '浙江', metric: 'count' }), execution))
    .toMatchObject({ ok: true, data: { warnings: [], interpretation: { dataDates: ['2026-01-02'], quantity: 3, isStale: false } } });
  expect(queries.changes(ChangesQuerySchema.parse({ batchIds: [1, 2, 3], region: '浙江', time: { start: '2026-01-02', endExclusive: '2026-01-03' } }), { ...context, nativeToolCallId: 'region-changes' }))
    .toMatchObject({ totalRows: 3, interpretation: { dataDates: ['2026-01-02'] } });
});

test('saved query interpretation and current page reject valid-schema date or identity corruption', () => {
  const { db, context, queries } = fixture();
  const result = queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2] }), context);
  // Model an already-corrupt on-disk record; normal application writes remain immutable.
  db.exec('DROP TRIGGER queries_update_immutable');
  db.query("UPDATE queries SET result_json=json_set(result_json,'$.interpretation.requestedDate','2026-01-01') WHERE id=?").run(result.queryId);
  expect(() => queries.read(result.queryId, context)).toThrow('tool_output_inconsistent');
  db.query("UPDATE queries SET result_json=json_set(result_json,'$.interpretation.requestedDate','2026-01-02','$.rows[0].date','2026-01-01') WHERE id=?").run(result.queryId);
  expect(() => queries.page({ queryId: result.queryId, page: 1, pageSize: 1 }, context)).toThrow('tool_output_inconsistent');
  expect(queries.page({ queryId: result.queryId, page: 99, pageSize: 1 }, context)).toMatchObject({ totalRows: 3, rows: [] });
  db.query("UPDATE queries SET result_json=json_set(result_json,'$.rows[0].date','2026-01-02','$.rows[0].deviceId',999) WHERE id=?").run(result.queryId);
  expect(() => queries.page({ queryId: result.queryId, page: 1, pageSize: 1 }, context)).toThrow('tool_output_inconsistent');
});

test('evidence reads reject mismatched saved query hash, source version and page row references', () => {
  const { db, context, queries, evidence } = fixture();
  const result = queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2] }), context);
  const evidenceId = result.evidenceIds[0]!;
  db.exec('DROP TRIGGER query_evidence_update_immutable');
  db.query("UPDATE query_evidence SET result_hash='other-result' WHERE id=?").run(evidenceId);
  expect(() => evidence.list({ queryId: result.queryId, page: 1, pageSize: 50 }, context)).toThrow('tool_output_inconsistent');
  db.query("UPDATE query_evidence SET result_hash=(SELECT result_hash FROM queries WHERE id=?),material_version='other-version' WHERE id=?").run(result.queryId, evidenceId);
  expect(() => evidence.read(evidenceId, context)).toThrow('tool_output_inconsistent');
  db.query("UPDATE query_evidence SET material_version='material/v1',source_row_refs_json='[\"unrelated-row\"]' WHERE id=?").run(evidenceId);
  expect(() => evidence.rows({ evidenceId, page: 1, pageSize: 1 }, context)).toThrow('tool_output_inconsistent');
});

test('schema-valid imported snapshot region and event values cannot commit contradictory query facts', () => {
  const { db, context, queries } = fixture();
  db.query("UPDATE snapshots SET region='上海' WHERE id=4").run();
  expect(() => queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2] }), context)).toThrow('tool_output_inconsistent');
  db.query("UPDATE snapshots SET region='浙江' WHERE id=4").run();
  db.query("UPDATE change_events SET old_value_json='123' WHERE id=1").run();
  expect(() => queries.changes(ChangesQuerySchema.parse({ batchIds: [2], time: { start: '2026-01-02', endExclusive: '2026-01-03' } }), { ...context, nativeToolCallId: 'bad-event' })).toThrow('tool_output_inconsistent');
  expect(db.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 0 });
  expect(db.query('SELECT COUNT(*) AS n FROM query_evidence').get()).toEqual({ n: 0 });
});

test('trusted deadline after synchronous SQLite calculation rolls back query and preserves the deadline error', async () => {
  const { db, context } = fixture();
  let expired = false;
  class ExpiringCatalog extends SqliteCatalogStore {
    override readSnapshots(...args: Parameters<SqliteCatalogStore['readSnapshots']>) {
      const rows = super.readSnapshots(...args);
      expired = true;
      return rows;
    }
  }
  const queries = new QueryService(new CatalogService(new ExpiringCatalog(db)), new SqliteToolStore(db));
  const execution: QueryExecutionContext = { runId: 1, sessionId: 1, inputId: null, source: 'agent_tool', callRef: '1:expired', scope: context.scope,
    referenceDate: context.referenceDate, timezone: context.timezone, signal: context.signal,
    checkActive: () => { if (expired) throw safeError('run_timeout'); } };
  expect(await queries.execute(QueryParamsSchema.parse({ kind: 'current', population: 'snapshot', snapshotMode: 'exact_date', batchIds: [1, 2] }), execution))
    .toMatchObject({ ok: false, error: { code: 'run_timeout' } });
  expect(db.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 0 });
  expect(db.query('SELECT COUNT(*) AS n FROM query_evidence').get()).toEqual({ n: 0 });
});

test('schema-valid inconsistent batch coverage metadata is rejected while baseline zero changes stay valid', () => {
  const { db, context, catalog, queries } = fixture();
  expect(catalog.checkCoverage({ time: { start: '2026-01-01', endExclusive: '2026-01-02' }, snapshotMode: 'exact_date', requirePredecessor: true }, context))
    .toEqual({ batchIds: [1], missingDates: [], missingPredecessorBatchIds: [], complete: false });
  expect(queries.changes(ChangesQuerySchema.parse({ batchIds: [1], time: { start: '2026-01-01', endExclusive: '2026-01-02' } }), context))
    .toMatchObject({ totalRows: 0, rows: [], warnings: ['baseline_no_predecessor:1'] });
  db.query('UPDATE batches SET observed_entity_count=2 WHERE id=2').run();
  const next = services(db);
  expect(() => next.catalog.readBatch(2, context)).toThrow('tool_output_inconsistent');
});

test('filter dictionaries omit empty values and device resolution retains its full-match status on empty pages', () => {
  const { db, context, catalog } = fixture();
  db.query("UPDATE snapshots SET manufacturer='' WHERE device_id IN (1,2)").run();
  expect(catalog.listFilterValues({ field: 'manufacturer', batchIds: [1, 2], page: 1, pageSize: 50 }, context))
    .toEqual({ values: ['厂家B'], totalRows: 1, page: 1, pageSize: 50 });
  expect(catalog.resolveDevice({ text: 'device-1', matchBy: 'source_id', page: 2, pageSize: 1 }, context))
    .toMatchObject({ resolution: 'unique', totalRows: 1, items: [] });
  expect(catalog.resolveDevice({ text: '器械', matchBy: 'name', page: 9, pageSize: 1 }, context))
    .toMatchObject({ resolution: 'ambiguous', totalRows: 3, items: [] });
});
