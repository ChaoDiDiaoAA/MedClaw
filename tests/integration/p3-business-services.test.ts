import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BusinessDataSchema, ChangesQuerySchema, CurrentQuerySchema, QueryPageSchema } from "../../packages/contracts/src/query";
import { businessToolSchemas } from "../../packages/contracts/src/business-tools";
import type { ToolExecutionContext } from "../../packages/contracts/src/tool";
import { CatalogService } from "../../packages/core/src/data/catalog-service";
import { QueryService } from "../../packages/core/src/data/query-service";
import { EvidenceReader } from "../../packages/core/src/evidence/evidence-reader";
import { ToolExecutor } from "../../packages/core/src/tools/executor";
import { ToolRecorder } from "../../packages/core/src/tools/recorder";
import { ToolRegistry } from "../../packages/core/src/tools/registry";
import { createBusinessTools } from "../../packages/core/src/tools/tools";
import { initializeToolStorage, SqliteToolStore } from "../../packages/storage/src/tool-store";
import { createPiToolDefinitions } from "../../packages/runtime-pi/src/pi-tool-adapter";

const handles: Database[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); });
function data() {
  const sourceRefs = [{ sourceId: "fda", file: "original-file-now-missing.csv", recordId: "row-1", row: 1 }];
  const batches = [1, 2].map(id => ({ id, scopeKey: "浙江:器械", snapshotDate: `2026-01-0${id}`, region: "浙江", coverage: "full" as const,
    previousBatchId: id === 1 ? null : 1, materialVersion: "data/v1", sourceBundleId: "bundle",
    catalogRevision: 1, expectedEntityCount: 3, observedEntityCount: 3 }));
  const devices = [1, 2, 3].map(id => ({ id, sourceDeviceId: `device-${id}`, sourceBundleId: "bundle", sourceSubmissionId: `submission-${id}`,
    sourceApplicant: "公开申报企业", sourceRefs }));
  const prices = [[10000, 0, null], [8000, 50, 10]];
  const snapshots = batches.flatMap(batch => devices.map(device => ({ id: (batch.id - 1) * 3 + device.id, batchId: batch.id, deviceId: device.id,
    deviceName: device.id === 3 ? "敷料" : `注射针${device.id}`, category: "耗材", region: "浙江", priceCents: prices[batch.id - 1]![device.id - 1]!,
    currency: "CNY" as const, unit: "件", status: "active" as const, manufacturer: "厂家A", distributor: "配送A", sourceRowRef: `${batch.id}:${device.id}`,
    sourceRefs, fieldOrigins: { price: { kind: "synthetic" as const, ruleId: "pricing-v1" }, deviceName: { kind: "public" as const, ruleId: "source" } } })));
  const changes = devices.map(device => ({ id: device.id, deviceId: device.id, oldBatchId: 1, newBatchId: 2, kind: "field_changed" as const, field: "price" as const,
    oldValue: prices[0]![device.id - 1]!, newValue: prices[1]![device.id - 1]!, deltaCents: 999, ratio: 999, calculationVersion: "untrusted-input" }));
  return BusinessDataSchema.parse({ batches, devices, snapshots, changes });
}
function fixture() {
  const db = new Database(":memory:"); handles.push(db); db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id INTEGER PRIMARY KEY);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,session_id INTEGER REFERENCES sessions(id),status TEXT,scope_json TEXT,reference_date TEXT,timezone TEXT,UNIQUE(id,session_id));`);
  const context: ToolExecutionContext = { runId: 1, sessionId: 1, nativeToolCallId: "current-call", referenceDate: "2026-01-02", timezone: "Asia/Shanghai", signal: new AbortController().signal,
    scope: { batchIds: [1, 2], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true } };
  db.exec("INSERT INTO sessions VALUES(1),(2)");
  db.query("INSERT INTO runs VALUES(1,1,'running',?,?,?)").run(JSON.stringify(context.scope), context.referenceDate, context.timezone);
  db.query("INSERT INTO runs VALUES(2,2,'running',?,?,?)").run(JSON.stringify(context.scope), context.referenceDate, context.timezone);
  initializeToolStorage(db);
  const catalog = new CatalogService(data()), store = new SqliteToolStore(db), queries = new QueryService(catalog, store), evidence = new EvidenceReader(catalog, queries, store);
  return { db, context, catalog, queries, evidence, store };
}

test("current query freezes full results, replays one identity and reads pages without recomputing", () => {
  const { context, queries } = fixture(), input = CurrentQuerySchema.parse({ batchIds: [1, 2], pageSize: 1 });
  const first = queries.current(input, context);
  expect(first).toMatchObject({ totalRows: 3, pageSize: 1, rows: [{ deviceId: 1, priceCents: 8000 }] });
  expect(queries.current(input, context)).toEqual(first);
  expect(() => queries.current({ ...input, pageSize: 2 }, context)).toThrow("state_conflict");
  first.rows[0]!.priceCents = 42;
  expect(queries.page({ queryId: first.queryId, page: 1, pageSize: 1 }, context).rows[0]!.priceCents).toBe(8000);
  expect(queries.page({ queryId: first.queryId, page: 2, pageSize: 1 }, context)).toMatchObject({ totalRows: 3, rows: [{ deviceId: 2, priceCents: 50 }] });
});

test("missing exact dates remain missing and as_of reports the actual chosen batch", () => {
  const { context, catalog, queries } = fixture();
  expect(() => queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2], time: { start: "2026-01-03", endExclusive: "2026-01-04" } }), context)).toThrow("data_coverage_missing");
  const result = queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2], snapshotMode: "as_of", time: { start: "2026-01-03", endExclusive: "2026-01-04" } }), context);
  expect(result.rows.every(row => row.batchId === 2)).toBe(true); expect(result.warnings).toEqual(["as_of_freshness:2:2026-01-02:2026-01-03"]);
  expect(catalog.checkCoverage({ time: { start: "2026-01-01", endExclusive: "2026-01-04" }, snapshotMode: "exact_date", requirePredecessor: false }, context))
    .toEqual({ batchIds: [1, 2], missingDates: ["2026-01-03"], missingPredecessorBatchIds: [], complete: false });
  expect(() => queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2], time: { start: "2026-01-01", endExclusive: "2026-01-03" } }), { ...context, nativeToolCallId: "multi-date" })).toThrow("invalid_argument");
});

test("price ratios are calculated from imported cents; zero and missing old prices remain null", () => {
  const { context, queries } = fixture(), input = ChangesQuerySchema.parse({ batchIds: [2], time: { start: "2026-01-02", endExclusive: "2026-01-03" } });
  const all = queries.changes(input, { ...context, nativeToolCallId: "all-changes" });
  expect(queries.changes(input, { ...context, nativeToolCallId: "all-changes" })).toEqual(all);
  expect(queries.read(all.queryId, context).params).not.toHaveProperty("snapshotMode");
  expect(all.rows).toMatchObject([{ deviceId: 1, deltaCents: -2000, ratio: -0.2 }, { deviceId: 2, deltaCents: 50, ratio: null }, { deviceId: 3, deltaCents: null, ratio: null }]);
  const threshold = queries.changes({ ...input, changeField: "price", direction: "decrease", threshold: { operator: "gt", value: 0.1 } }, { ...context, nativeToolCallId: "threshold" });
  expect(threshold).toMatchObject({ totalRows: 1, rows: [{ deviceId: 1, ratio: -0.2 }] });
  expect(queries.changes({ ...input, changeField: "price", threshold: { operator: "gt", value: 0.2 } }, { ...context, nativeToolCallId: "strict-threshold" }).totalRows).toBe(0);
  expect(queries.changes({ ...input, changeField: "price", threshold: { operator: "gte", value: 0.2 } }, { ...context, nativeToolCallId: "inclusive-threshold" }).totalRows).toBe(1);
});

test("query and evidence enforce Session and current frozen scope ownership", () => {
  const { context, catalog, queries, evidence } = fixture(), result = queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2] }), context);
  expect(() => catalog.readBatch(3, context)).toThrow("access_denied");
  expect(() => catalog.readDevice(1, { ...context, scope: { ...context.scope, deviceIds: [2] } })).toThrow("access_denied");
  const otherSession = { ...context, sessionId: 2, runId: 2 };
  expect(() => queries.read(result.queryId, otherSession)).toThrow("access_denied");
  expect(() => evidence.read(result.evidenceIds[0]!, otherSession)).toThrow("access_denied");
});

test("evidence keeps imported original values and source origins without opening original files", () => {
  const { context, queries, evidence } = fixture(), result = queries.changes(ChangesQuerySchema.parse({ batchIds: [2], time: { start: "2026-01-02", endExclusive: "2026-01-03" } }), context);
  const id = result.evidenceIds[0]!;
  expect(evidence.list({ queryId: result.queryId, page: 1, pageSize: 50 }, context).items[0]).toMatchObject({ id, batchIds: [1, 2], eventIds: [1, 2, 3] });
  expect(evidence.rows({ evidenceId: id, page: 1, pageSize: 50 }, context).totalRows).toBe(6);
  const source = evidence.sources({ evidenceId: id, page: 1, pageSize: 1 }, context);
  expect(source.items[0]).toMatchObject({ sourceRefs: [{ file: "original-file-now-missing.csv" }], fieldOrigins: { price: { kind: "synthetic", ruleId: "pricing-v1" } } });
});

test("legal empty filters succeed; catalog handles entity ambiguity and freezes input data", () => {
  const { context, catalog, queries } = fixture();
  expect(queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2], manufacturer: "不存在厂家" }), context).totalRows).toBe(0);
  expect(catalog.resolveDevice({ text: "注射针", matchBy: "name", page: 1, pageSize: 1 }, context)).toMatchObject({ resolution: "ambiguous", totalRows: 2, items: [{ id: 1 }] });
  expect(catalog.resolveDevice({ text: "device-2", matchBy: "source_id", page: 1, pageSize: 50 }, context)).toMatchObject({ resolution: "unique", items: [{ id: 2 }] });
  expect(catalog.listFilterValues({ field: "manufacturer", batchIds: [1, 2], page: 1, pageSize: 50 }, context)).toEqual({ values: ["厂家A"], totalRows: 1, page: 1, pageSize: 50 });
  const imported = data(), immutable = new CatalogService(imported); imported.snapshots[3]!.priceCents = 1;
  expect(immutable.snapshot(4, context).priceCents).toBe(8000);
  expect(Reflect.set(immutable.snapshot(4, context), "priceCents", 1)).toBe(false);
});

test("cancellation before query commit leaves no query or evidence fact", () => {
  const { db, context, queries } = fixture(), controller = new AbortController(); controller.abort();
  expect(() => queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2] }), { ...context, signal: controller.signal })).toThrow();
  expect(db.query("SELECT COUNT(*) AS n FROM queries").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM query_evidence").get()).toEqual({ n: 0 });
});

test("all 15 assembled tools execute through schemas, Registry, Executor and SQLite recording", async () => {
  const { db, context, catalog, queries, evidence, store } = fixture();
  const registry = new ToolRegistry(createBusinessTools({ catalog, queries, evidence })), recorder = new ToolRecorder(store), executor = new ToolExecutor(registry, recorder);
  expect(registry.definitions).toHaveLength(15);
  expect(new Set(registry.definitions.map(tool => tool.name)).size).toBe(15);
  for (const [name, schemas] of Object.entries(businessToolSchemas)) {
    const definition = registry.get(name);
    expect(definition?.inputSchema).toBe(schemas.input);
    expect(definition?.outputSchema).toBe(schemas.output);
  }
  expect(registry.definitions.filter(tool => tool.executionMode === "sequential").map(tool => tool.name)).toEqual(["query_current_devices", "query_device_changes"]);
  expect(registry.definitions.filter(tool => tool.executionMode === "parallel")).toHaveLength(13);
  context.scope.allowedToolNames = registry.definitions.map(tool => tool.name);
  db.query("UPDATE runs SET scope_json=? WHERE id=1").run(JSON.stringify(context.scope));
  const piTools = createPiToolDefinitions(registry, executor, nativeToolCallId => ({ ...context, nativeToolCallId }));
  expect(piTools.map(tool => [tool.name, tool.executionMode])).toEqual(registry.definitions.map(tool => [tool.name, tool.executionMode]));
  expect(piTools.map(tool => tool.parameters)).toEqual(registry.definitions.map(() => expect.objectContaining({ type: "object" })));
  let sequence = 0;
  async function execute(name: string, input: unknown) {
    const ctx = { ...context, nativeToolCallId: `assembled-${++sequence}` }, result = await executor.execute(name, input, ctx);
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error(result.error.code);
    expect(store.readCall(ctx)).toMatchObject({ name, status: "succeeded", executionMode: registry.get(name)!.executionMode });
    return result.data;
  }
  await execute("read_data_scope", {});
  await execute("list_batches", {});
  await execute("read_batch", { batchId: 2 });
  await execute("check_data_coverage", { time: { start: "2026-01-02", endExclusive: "2026-01-03" }, requirePredecessor: true });
  await execute("list_filter_values", { batchIds: [2], field: "manufacturer" });
  await execute("resolve_device", { text: "device-1", matchBy: "source_id" });
  await execute("read_device", { deviceId: 1 });
  const current = QueryPageSchema.parse(await execute("query_current_devices", { batchIds: [1, 2], pageSize: 1 }));
  expect(current.totalRows).toBe(3);
  const changes = QueryPageSchema.parse(await execute("query_device_changes", { batchIds: [2], time: { start: "2026-01-02", endExclusive: "2026-01-03" }, changeField: "price", direction: "decrease" }));
  expect(changes).toMatchObject({ totalRows: 1, rows: [{ deltaCents: -2000, ratio: -0.2 }] });
  await execute("read_query", { queryId: current.queryId });
  await execute("read_query_page", { queryId: current.queryId, page: 2, pageSize: 1 });
  await execute("list_query_evidence", { queryId: current.queryId });
  await execute("read_query_evidence", { evidenceId: changes.evidenceIds[0] });
  await execute("read_evidence_rows", { evidenceId: changes.evidenceIds[0] });
  await execute("read_source_metadata", { evidenceId: changes.evidenceIds[0] });
  expect(db.query("SELECT COUNT(*) AS n FROM tool_calls WHERE status='succeeded'").get()).toEqual({ n: 15 });
  expect(db.query("SELECT COUNT(*) AS n FROM queries").get()).toEqual({ n: 2 });
  expect(db.query("SELECT COUNT(*) AS n FROM query_evidence").get()).toEqual({ n: 2 });
  const forbidden = await executor.execute("read_batch", { batchId: 999 }, { ...context, nativeToolCallId: "forbidden-batch" });
  expect(forbidden).toMatchObject({ status: "failed", error: { code: "access_denied" } });
  const forged = await executor.execute("read_batch", { batchId: 2, sessionId: 2 }, { ...context, nativeToolCallId: "forged-input" });
  expect(forged).toMatchObject({ status: "failed", error: { code: "tool_input_invalid" } });
});

test("an empty historical query cannot be read after its entity scope narrows", () => {
  const { db, context, queries } = fixture();
  const result = queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2], manufacturer: "不存在厂家" }), context);
  const narrow = { ...context, runId: 3, nativeToolCallId: "narrow", scope: { ...context.scope, deviceIds: [1] } };
  db.query("INSERT INTO runs VALUES(3,1,'running',?,?,?)").run(JSON.stringify(narrow.scope), narrow.referenceDate, narrow.timezone);
  expect(() => queries.read(result.queryId, narrow)).toThrow("access_denied");
  const restricted = queries.current(CurrentQuerySchema.parse({ batchIds: [1, 2], deviceIds: [1], manufacturer: "不存在厂家" }), { ...context, nativeToolCallId: "restricted" });
  expect(queries.read(restricted.queryId, narrow).rows).toEqual([]);
});

test("catalog rejects broken cohort counts, source bindings and nonadjacent predecessors", () => {
  const count = data(); count.batches[1]!.expectedEntityCount = 4;
  expect(() => new CatalogService(count)).toThrow("input_invalid");
  const binding = data(); binding.batches[1]!.sourceBundleId = "different-source";
  expect(() => new CatalogService(binding)).toThrow("input_invalid");
  const predecessor = data(); predecessor.batches[1]!.previousBatchId = null; predecessor.changes = [];
  expect(() => new CatalogService(predecessor)).toThrow("input_invalid");
  const duplicates = data(); duplicates.devices[1]!.sourceDeviceId = duplicates.devices[0]!.sourceDeviceId;
  expect(() => new CatalogService(duplicates)).toThrow("input_invalid");
  const duplicateEvent = data(); duplicateEvent.changes.push({ ...duplicateEvent.changes[0]!, id: 4 });
  expect(() => new CatalogService(duplicateEvent)).toThrow("input_invalid");
});

test("declared missing records conserve the cohort and remain missing rather than delisted", () => {
  const { context, store } = fixture(), imported = data();
  imported.snapshots = imported.snapshots.filter(row => row.id !== 6);
  imported.batches[1]!.observedEntityCount = 2; imported.batches[1]!.declaredMissingDeviceIds = [3];
  imported.changes[2] = { ...imported.changes[2]!, kind: "missing", field: null, oldValue: true, newValue: false, deltaCents: null, ratio: null };
  const catalog = new CatalogService(imported), queries = new QueryService(catalog, store);
  const result = queries.changes(ChangesQuerySchema.parse({ batchIds: [2], time: { start: "2026-01-02", endExclusive: "2026-01-03" }, changeKind: "missing" }), context);
  expect(result).toMatchObject({ totalRows: 1, rows: [{ deviceId: 3, kind: "missing", field: null, deltaCents: null, ratio: null }] });
  const undeclared = structuredClone(imported); undeclared.batches[1]!.declaredMissingDeviceIds = [];
  expect(() => new CatalogService(undeclared)).toThrow("input_invalid");
  const wrongBinding = data(); wrongBinding.devices[0]!.sourceBundleId = "other-bundle";
  expect(() => new CatalogService(wrongBinding)).toThrow("input_invalid");
});

test("missing predecessor Scope is rejected and an unallowed tool attempt is recorded without execution", async () => {
  const { db, context, catalog, queries, evidence, store } = fixture();
  const restricted = { ...context, scope: { ...context.scope, batchIds: [2], allowedToolNames: [] } };
  db.query("UPDATE runs SET scope_json=? WHERE id=1").run(JSON.stringify(restricted.scope));
  const input = ChangesQuerySchema.parse({ batchIds: [2], time: { start: "2026-01-02", endExclusive: "2026-01-03" } });
  expect(() => queries.changes(input, restricted)).toThrow("access_denied");
  expect(catalog.checkCoverage({ time: input.time, snapshotMode: "exact_date", requirePredecessor: true }, restricted))
    .toEqual({ batchIds: [2], missingDates: [], missingPredecessorBatchIds: [1], complete: false });
  const executor = new ToolExecutor(new ToolRegistry(createBusinessTools({ catalog, queries, evidence })), new ToolRecorder(store));
  const result = await executor.execute("query_current_devices", { batchIds: [2] }, restricted);
  expect(result).toMatchObject({ status: "failed", error: { code: "access_denied" } });
  expect(store.readCall(restricted)).toMatchObject({ status: "failed", name: "query_current_devices" });
  expect(db.query("SELECT COUNT(*) AS n FROM queries").get()).toEqual({ n: 0 });
});
