import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { canonicalRequest } from '../../packages/contracts/src/run';
import { BUSINESS_RULES, BusinessDataSchema, CurrentQuerySchema, QueryPageSchema, QueryParamsSchema, QueryRecordSchema, TimeRangeSchema, createQuerySchemas, createStoredQuerySchemas } from '../../packages/contracts/src/query';
import { businessToolSchemas } from '../../packages/contracts/src/business-tools';
import type { ToolExecutionContext } from '../../packages/contracts/src/tool';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { QueryService } from '../../packages/core/src/data/query-service';
import { EvidenceReader } from '../../packages/core/src/evidence/evidence-reader';
import { createBusinessTools } from '../../packages/core/src/tools/tools';
import { initializeToolStorage, SqliteToolStore } from '../../packages/storage/src/tool-store';

const handles: Database[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); });
function fixture(count = 3, region = 'region') {
  const db = new Database(':memory:'); handles.push(db);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id INTEGER PRIMARY KEY);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,session_id INTEGER REFERENCES sessions(id),status TEXT,scope_json TEXT,reference_date TEXT,timezone TEXT,UNIQUE(id,session_id));
    INSERT INTO sessions VALUES(1);`);
  const context: ToolExecutionContext = { runId: 1, sessionId: 1, nativeToolCallId: 'query', referenceDate: '2026-01-02', timezone: 'Asia/Shanghai', signal: new AbortController().signal,
    scope: { batchIds: [1, 2], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true } };
  db.query("INSERT INTO runs VALUES(1,1,'running',?,?,?)").run(JSON.stringify(context.scope), context.referenceDate, context.timezone);
  initializeToolStorage(db);
  const batches = [1, 2].map(id => ({ id, scopeKey: 'scope', snapshotDate: `2026-01-0${id}`, region, coverage: 'full', previousBatchId: id === 1 ? null : 1,
    materialVersion: 'v1', sourceBundleId: 'bundle', catalogRevision: 1, expectedEntityCount: count, observedEntityCount: count }));
  const devices = Array.from({ length: count }, (_, index) => ({ id: index + 1, sourceDeviceId: `device-${index + 1}`, sourceBundleId: 'bundle', sourceSubmissionId: `submission-${index + 1}`, sourceApplicant: null, sourceRefs: [] }));
  const snapshots = batches.flatMap(batch => devices.map(device => ({ id: (batch.id - 1) * count + device.id, batchId: batch.id, deviceId: device.id, deviceName: `name-${device.id}`, category: null,
    region, priceCents: 1, currency: 'CNY', unit: 'item', status: 'active', manufacturer: 'maker', distributor: null, sourceRowRef: `${batch.id}:${device.id}`, sourceRefs: [], fieldOrigins: {} })));
  const catalog = new CatalogService(BusinessDataSchema.parse({ batches, devices, snapshots, changes: [] }));
  const store = new SqliteToolStore(db), queries = new QueryService(catalog, store), evidence = new EvidenceReader(catalog, queries, store);
  return { db, context, catalog, queries, evidence, store };
}

test('fixed execution contracts keep input and capacity boundaries while saved facts remain structural', () => {
  const current = createQuerySchemas();
  expect(current.CurrentQuerySchema.parse({ batchIds: [1] })).toMatchObject({ page: 1, pageSize: 50, snapshotMode: 'exact_date', sort: 'asc' });
  for (const input of [{ batchIds: [1], pageSize: 501 }, { batchIds: [1], region: 'r'.repeat(257) }, { batchIds: [1, 1] }]) {
    expect(current.CurrentQuerySchema.safeParse(input).success).toBe(false);
  }
  expect(current.TimeRangeSchema.safeParse({ start: '2024-01-01', endExclusive: '2026-01-01' }).success).toBe(false);
  expect(CurrentQuerySchema.safeParse({ batchIds: [1], pageSize: 501, region: 'r'.repeat(257) }).success).toBe(true);
  expect(TimeRangeSchema.safeParse({ start: '2024-01-01', endExclusive: '2026-01-01' }).success).toBe(true);
  expect(QueryPageSchema.safeParse({ queryId: 1, rows: [], totalRows: 0, page: 1, pageSize: 501, warnings: [], calculationVersion: 'v1', evidenceIds: [] }).success).toBe(true);
  expect(CurrentQuerySchema.safeParse({ batchIds: [1, 1] }).success).toBe(false);
  expect(TimeRangeSchema.safeParse({ start: '2026-01-01', endExclusive: '2024-01-01' }).success).toBe(false);
  expect(BUSINESS_RULES.maxSavedRows).toBe(100000);
});

test('all fifteen tools use the fixed business contracts and defaults', () => {
  const tools = createBusinessTools(fixture());
  expect(tools).toHaveLength(15);
  for (const tool of tools) expect(tool.description.length).toBeGreaterThan(20);
  expect(tools.find(tool => tool.name === 'list_batches')!.inputSchema).toBe(businessToolSchemas.list_batches.input);
  expect(businessToolSchemas.query_current_devices.input.parse({ batchIds: [1] })).toMatchObject({ page: 1, pageSize: 50, snapshotMode: 'exact_date', sort: 'asc' });
  expect(businessToolSchemas.check_data_coverage.input.parse({ time: { start: '2026-01-01', endExclusive: '2026-01-02' } })).toMatchObject({ snapshotMode: 'exact_date', requirePredecessor: false });
  expect(businessToolSchemas.resolve_device.input.parse({ text: 'id' })).toMatchObject({ matchBy: 'name' });
  expect(businessToolSchemas.query_current_devices.input.safeParse({ batchIds: [1], pageSize: 501 }).success).toBe(false);
  expect(businessToolSchemas.resolve_device.input.safeParse({ text: 'x'.repeat(513) }).success).toBe(false);
  const aggregate = { kind: 'aggregate', population: 'snapshot', snapshotMode: 'exact_date', batchIds: [1], metric: 'count', topN: 101 };
  expect(createQuerySchemas().QueryParamsSchema.safeParse(aggregate).success).toBe(false);
  expect(QueryParamsSchema.safeParse(aggregate).success).toBe(true);
});

test('direct service callers cannot bypass fixed execution pagination and input limits', () => {
  const { catalog, queries, evidence, context } = fixture();
  const page = queries.current(createQuerySchemas().CurrentQuerySchema.parse({ batchIds: [2] }), context);
  expect(page).toMatchObject({ page: 1, pageSize: 50, totalRows: 3 });
  expect(() => catalog.listBatches({ page: 1, pageSize: 501 }, context)).toThrow();
  expect(() => catalog.resolveDevice({ text: 'x'.repeat(513), matchBy: 'name', page: 1, pageSize: 1 }, context)).toThrow();
  expect(() => catalog.checkCoverage({ time: { start: '2024-01-01', endExclusive: '2026-01-03' }, snapshotMode: 'as_of', requirePredecessor: false }, context)).toThrow();
  expect(() => queries.page({ queryId: page.queryId, page: 1, pageSize: 501 }, context)).toThrow();
  expect(() => evidence.rows({ evidenceId: page.evidenceIds[0]!, page: 1, pageSize: 501 }, context)).toThrow();
});

test('SQLite new submissions use fixed capacity and saved replays keep original identity', () => {
  const { store, context, db } = fixture();
  const input = {
    sessionId: 1, runId: 1, callRef: '1:query', kind: 'current' as const,
    params: CurrentQuerySchema.parse({ batchIds: [2] }), batchIds: [2], scopeDeviceIds: null,
    rows: [{ deviceId: 1 }], snapshotIds: [], eventIds: [], warnings: [], calculationVersion: 'v1', createdAt: '2026-01-02T00:00:00.000Z',
  };
  const oversized = { ...input, rows: Array.from({ length: BUSINESS_RULES.maxSavedRows + 1 }, () => ({ deviceId: 1 })) };
  let failure: unknown;
  try { store.commitQuery(oversized, [], context); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'query_result_too_large' });
  expect(db.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 0 });
  const saved = store.commitQuery(input, [], context);
  expect(() => store.commitQuery(oversized, [], context)).toThrow('state_conflict');
  expect(store.commitQuery(input, [], context).id).toBe(saved.id);
  expect(store.readQuery(saved.id)?.rows).toHaveLength(1);
  expect(QueryRecordSchema.safeParse({ ...saved, rows: oversized.rows }).success).toBe(true);
});

test('saved Query and Evidence remain readable when legacy params exceed current execution limits', () => {
  const { db, context, queries, store } = fixture();
  const page = queries.current(createQuerySchemas().CurrentQuerySchema.parse({ batchIds: [2] }), context);
  const saved = store.readQuery(page.queryId)!;
  const historical = { ...saved.params, pageSize: 501 };
  const inserted = db.query(`INSERT INTO queries(session_id,run_id,call_ref,kind,params_json,batch_ids_json,result_json,created_at)
    SELECT session_id,run_id,'1:historical',kind,?,batch_ids_json,result_json,created_at FROM queries WHERE id=?`)
    .run(canonicalRequest(historical), page.queryId);
  const historicalId = Number(inserted.lastInsertRowid);
  const evidenceInsert = db.query(`INSERT INTO query_evidence(query_id,batch_ids_json,snapshot_ids_json,event_ids_json,source_row_refs_json,calculation_version,material_version,source_bundle_id)
    SELECT ?,batch_ids_json,snapshot_ids_json,event_ids_json,source_row_refs_json,calculation_version,material_version,source_bundle_id FROM query_evidence WHERE id=?`)
    .run(historicalId, page.evidenceIds[0]!);
  expect(queries.read(historicalId, context).params.pageSize).toBe(501);
  expect(store.readEvidence(Number(evidenceInsert.lastInsertRowid))!.queryId).toBe(historicalId);
  expect(queries.page({ queryId: historicalId, page: 1, pageSize: 1 }, context).totalRows).toBe(3);
  expect(createStoredQuerySchemas().CurrentQuerySchema.safeParse(historical).success).toBe(true);
  expect(createQuerySchemas().CurrentQuerySchema.safeParse(historical).success).toBe(false);
});
