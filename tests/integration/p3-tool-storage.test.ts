import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { safeError } from "../../packages/contracts/src/error";
import { ChangesQuerySchema, CurrentQuerySchema, type Evidence, type QueryRecord } from "../../packages/contracts/src/query";
import type { AnyToolDefinition, ToolExecutionContext } from "../../packages/contracts/src/tool";
import { initializeToolStorage, SqliteToolStore } from "../../packages/storage/src/tool-store";

const handles: Database[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); });
const scope = { batchIds: [1], deviceIds: null, allowedToolNames: ["query_current_devices"], allowedResourceRefs: [], artifactIds: [], readOnly: true };
const tool: AnyToolDefinition = { name: "query_current_devices", version: "1.0.0", label: "查询器械", description: "Query",
  effect: "READ", executionMode: "sequential", inputSchema: CurrentQuerySchema, outputSchema: CurrentQuerySchema, execute: async () => null };
function fixture() {
  const db = new Database(":memory:"); handles.push(db);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE runs(id INTEGER PRIMARY KEY,session_id INTEGER NOT NULL REFERENCES sessions(id),status TEXT NOT NULL,
      scope_json TEXT NOT NULL,reference_date TEXT NOT NULL,timezone TEXT NOT NULL,UNIQUE(id,session_id)) STRICT;
    INSERT INTO sessions VALUES(1),(2);`);
  db.query("INSERT INTO runs VALUES(1,1,'running',?,'2026-10-01','Asia/Shanghai')").run(JSON.stringify(scope));
  initializeToolStorage(db);
  const context: ToolExecutionContext = { runId: 1, sessionId: 1, nativeToolCallId: "call-1", scope,
    referenceDate: "2026-10-01", timezone: "Asia/Shanghai", signal: new AbortController().signal };
  return { db, store: new SqliteToolStore(db), context };
}
function query(context: ToolExecutionContext): Omit<QueryRecord, "id"> {
  return { sessionId: context.sessionId, runId: context.runId, callRef: `${context.runId}:${context.nativeToolCallId}`,
    kind: "current", params: CurrentQuerySchema.parse({ batchIds: [1] }), batchIds: [1], scopeDeviceIds: context.scope.deviceIds, rows: [{ deviceId: 1, priceCents: 250 }],
    snapshotIds: [1], eventIds: [], warnings: [], calculationVersion: "query/v1", resultHash: "result-hash", createdAt: "2026-10-01T00:00:00.000Z" };
}
function evidence(): Omit<Evidence, "id" | "queryId"> {
  return { batchIds: [1], snapshotIds: [1], eventIds: [], sourceRowRefs: ["row-1"], calculationVersion: "query/v1",
    materialVersion: "1", sourceBundleId: "bundle", sourceLockHash: "lock", resultHash: "result-hash" };
}

test("request replays original identity and rejects changed Run, tool, mode or parameters", () => {
  const { db, store, context } = fixture();
  const record = store.request(tool, { b: 2, a: 1 }, context);
  expect(store.request(tool, { a: 1, b: 2 }, context)).toEqual(record);
  for (const changed of [{ ...tool, name: "other" }, { ...tool, version: "2" }, { ...tool, executionMode: "parallel" as const }]) {
    expect(() => store.request(changed, { a: 1, b: 2 }, context)).toThrow();
  }
  expect(() => store.request(tool, { a: 2, b: 2 }, context)).toThrow("state_conflict");
  expect(() => store.readCall({ ...context, sessionId: 2 })).toThrow("access_denied");
  db.query("INSERT INTO runs VALUES(2,1,'running',?,'2026-10-01','Asia/Shanghai')").run(JSON.stringify(scope));
  expect(() => store.request(tool, { a: 1, b: 2 }, { ...context, runId: 2 })).toThrow("state_conflict");
  expect(db.query("SELECT COUNT(*) AS n FROM tool_calls").get()).toEqual({ n: 1 });
});

test("context must match frozen Scope, date, timezone and an active Run", () => {
  const { db, store, context } = fixture();
  expect(() => store.assertContext({ ...context, scope: { ...scope, batchIds: [2] } })).toThrow("access_denied");
  expect(() => store.assertContext({ ...context, referenceDate: "2026-10-02" })).toThrow("access_denied");
  expect(() => store.assertContext({ ...context, timezone: "UTC" })).toThrow("access_denied");
  db.exec("UPDATE runs SET status='completed' WHERE id=1");
  expect(() => store.assertContext(context)).toThrow("state_conflict");
});

test("execution terminal state is immutable and delivery only adds original receipt", () => {
  const { db, store, context } = fixture();
  const original = store.request(tool, {}, context);
  expect(() => store.transition(original.id, "requested", "succeeded", { status: "succeeded", data: 1 })).toThrow("state_conflict");
  store.transition(original.id, "requested", "running");
  const done = store.transition(original.id, "running", "succeeded", { status: "succeeded", data: { answer: 1 } });
  expect(() => store.transition(done.id, "succeeded", "failed", { status: "failed", error: safeError("internal_error") })).toThrow("state_conflict");
  db.exec("UPDATE runs SET status='completed' WHERE id=1");
  store.recordDelivery(context, "native-entry-1"); store.recordDelivery(context, "native-entry-1");
  expect(store.readCall(context)).toEqual({ ...done, sdkReturned: true, nativeEntryId: "native-entry-1" });
  expect(() => store.recordDelivery(context, "native-entry-2")).toThrow("state_conflict");
  expect(() => store.recordDelivery({ ...context, sessionId: 2 }, "native-entry-1")).toThrow("access_denied");
});

test("failed and cancelled calls require matching safe errors and JSON results", () => {
  const { store, context } = fixture();
  const record = store.request(tool, {}, context);
  expect(() => store.transition(record.id, "requested", "failed", { status: "cancelled", error: safeError("runtime_interrupted") })).toThrow("invalid_argument");
  const cancelled = store.transition(record.id, "requested", "cancelled", { status: "cancelled", error: safeError("runtime_interrupted") });
  expect(cancelled.error?.code).toBe("runtime_interrupted");
  expect(() => store.request(tool, { nonJson: Infinity }, { ...context, nativeToolCallId: "bad-json" })).toThrow("invalid_argument");
  const bad = store.request(tool, {}, { ...context, nativeToolCallId: "bad-result" });
  store.transition(bad.id, "requested", "running");
  expect(() => store.transition(bad.id, "running", "succeeded", { status: "succeeded", data: { missing: undefined } })).toThrow("invalid_argument");
});

test("query and evidence commit atomically and replay reads immutable original result", () => {
  const { db, store, context } = fixture(), input = query(context);
  const committed = store.commitQuery(input, [evidence()], context);
  const replay = store.commitQuery({ ...input, rows: [{ deviceId: 999 }], resultHash: "later" }, [], context);
  expect(replay).toEqual(committed);
  expect(store.readQuery(committed.id)).toEqual(committed);
  const savedEvidence = store.listEvidence(committed.id);
  expect(savedEvidence).toHaveLength(1);
  expect(store.readEvidence(savedEvidence[0]!.id)).toEqual(savedEvidence[0]!);
  expect(() => store.commitQuery({ ...input, params: CurrentQuerySchema.parse({ batchIds: [1], manufacturer: "other" }) }, [evidence()], context)).toThrow("state_conflict");
  expect(db.query("SELECT COUNT(*) AS n FROM queries").get()).toEqual({ n: 1 });
  expect(() => db.exec("UPDATE queries SET result_hash='changed'")).toThrow();
  expect(() => db.exec("DELETE FROM query_evidence")).toThrow();
});

test("query commit rejects cancelled execution and scope/ownership mismatch", () => {
  const { db, store, context } = fixture();
  const controller = new AbortController(); controller.abort();
  expect(() => store.commitQuery(query(context), [evidence()], { ...context, signal: controller.signal })).toThrow("runtime_interrupted");
  expect(() => store.commitQuery({ ...query(context), sessionId: 2 }, [evidence()], context)).toThrow("access_denied");
  expect(() => store.commitQuery({ ...query(context), callRef: "other-call" }, [evidence()], context)).toThrow("access_denied");
  expect(() => store.commitQuery({ ...query(context), batchIds: [2] }, [evidence()], context)).toThrow("access_denied");
  expect(() => store.commitQuery(query(context), [{ ...evidence(), batchIds: [2] }], context)).toThrow("invalid_argument");
  expect(db.query("SELECT COUNT(*) AS n FROM queries").get()).toEqual({ n: 0 });
});

test("current Query stores actual selected batches while changes can store scoped predecessors", () => {
  const { db, store, context } = fixture();
  const expanded = { ...context, scope: { ...scope, batchIds: [1, 2] } };
  db.query("UPDATE runs SET scope_json=? WHERE id=1").run(JSON.stringify(expanded.scope));
  const selected = { ...query(expanded), params: CurrentQuerySchema.parse({ batchIds: [1, 2] }), batchIds: [1] };
  expect(store.commitQuery(selected, [evidence()], expanded).batchIds).toEqual([1]);
  const changes = { ...query(expanded), callRef: "1:call-2", kind: "changes" as const,
    params: ChangesQuerySchema.parse({ batchIds: [2], time: { start: "2026-01-01", endExclusive: "2026-01-02" } }), batchIds: [1, 2] };
  expect(store.commitQuery(changes, [evidence()], { ...expanded, nativeToolCallId: "call-2" }).batchIds).toEqual([1, 2]);
});

test("an evidence insertion failure rolls back its Query and never reports success", () => {
  const { db, store, context } = fixture();
  db.exec("CREATE TRIGGER fail_evidence BEFORE INSERT ON query_evidence BEGIN SELECT RAISE(ABORT,'secret database detail'); END");
  expect(() => store.commitQuery(query(context), [evidence()], context)).toThrow("storage_write_failed");
  expect(db.query("SELECT COUNT(*) AS n FROM queries").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM query_evidence").get()).toEqual({ n: 0 });
});

test("an inactive Run discovered after inserts still rolls back both facts", () => {
  const { db, store, context } = fixture();
  db.exec("CREATE TRIGGER stop_query AFTER INSERT ON query_evidence BEGIN UPDATE runs SET status='completed' WHERE id=1; END");
  expect(() => store.commitQuery(query(context), [evidence()], context)).toThrow("state_conflict");
  expect(db.query("SELECT COUNT(*) AS n FROM queries").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM query_evidence").get()).toEqual({ n: 0 });
  expect(db.query("SELECT status FROM runs WHERE id=1").get()).toEqual({ status: "running" });
});

test("initializer is explicit, idempotent and does not change P2 schema version", () => {
  const { db } = fixture();
  initializeToolStorage(db);
  expect(db.query("SELECT name FROM pragma_table_list WHERE schema='main' AND name IN ('tool_calls','queries','query_evidence') ORDER BY name").all())
    .toEqual([{ name: "queries" }, { name: "query_evidence" }, { name: "tool_calls" }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("SELECT name FROM sqlite_schema WHERE name='schema_migrations'").get()).toBeNull();
});
