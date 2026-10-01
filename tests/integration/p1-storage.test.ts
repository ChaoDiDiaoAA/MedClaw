import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/storage/src/database";
import { Repositories } from "../../packages/storage/src/repositories";

const roots: string[] = [];
const handles: Database[] = [];
function path() {
  const root = mkdtempSync(join(tmpdir(), "medclaw-p1-sqlite-"));
  roots.push(root);
  return join(root, "app.sqlite");
}
function open(file = path()) {
  const db = openDatabase(file);
  handles.push(db);
  return db;
}
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("historical 001 contains exactly three STRICT tables with WAL and foreign keys", () => {
  const db = new Database(path(), { create: true, strict: true }); handles.push(db);
  const sql = readFileSync(new URL("../../packages/storage/src/migrations/001_p1.sql", import.meta.url));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;"); db.exec(sql.toString());
  db.query("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(1,?,?)").run(createHash("sha256").update(sql).digest("hex"), new Date().toISOString());
  const tables = db.query<{ name: string; strict: number }, []>(
    "SELECT name, strict FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all();
  expect(tables).toEqual([
    { name: "model_calls", strict: 1 },
    { name: "runs", strict: 1 },
    { name: "schema_migrations", strict: 1 },
  ]);
  expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 1000 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(db.query("SELECT version, length(checksum) AS chars FROM schema_migrations").all())
    .toEqual([{ version: 1, chars: 64 }]);
});

const time = "2026-09-30T12:00:00.000Z";
const selection = {
  provider: "test", modelId: "text", endpointRef: null, api: "openai-completions",
  configVersion: "1", credentialRef: null, maxOutputTokens: 1024,
  capabilitySource: "pi_catalog" as const, sdkVersion: "0.87.1" as const,
};
const policy = { timeoutMs: 120_000, maxRetries: 0 as const, maxRetryDelayMs: 2000 };
function request(operationRef = "operation-a", instanceId = "instance-old") {
  return {
    operationRef, instanceId, method: "model.request" as const, goal: "answer" as const,
    inputText: "hello", originalRequest: {
      text: "hello", model: { provider: "test", modelId: "text", expectedConfigVersion: "1" },
      referenceDate: "2026-09-30", timezone: "Asia/Shanghai",
    }, selection, policy, referenceDate: "2026-09-30", timezone: "Asia/Shanghai", createdAt: time,
  };
}
function completed(callId = "call-a", outputText = "answer") {
  return {
    status: "completed" as const, outputText, stoppedAt: time, endedAt: time, error: null,
    call: {
      callId, state: "completed" as const, responseModel: "text", sdkStopReason: "stop" as const,
      endedAt: time, durationMs: 0, inputTokens: null, outputTokens: null, cost: null,
      costCurrency: null, usageSource: null, unavailableReason: "usage_unavailable", error: null,
    },
  };
}

test("accepted operation identity survives config changes and permits no changed original parameters", () => {
  const repo = new Repositories(open());
  const accepted = repo.registerProvider(request());
  const changedCurrent = { ...request(), selection: { ...selection, configVersion: "99" } };
  expect(repo.registerProvider(changedCurrent)).toEqual({ ...accepted, reused: true });
  expect(repo.findProviderOperation("operation-a")?.originalRequest).toEqual(request().originalRequest);
  expect(() => repo.registerProvider({ ...request(), originalRequest: { ...request().originalRequest, text: "other" } }))
    .toThrow("state_conflict");
  expect(() => repo.registerProvider(request("operation-b"))).toThrow("runtime_busy");
  expect(repo.read({ runId: accepted.runId })).toMatchObject({ kind: "one", run: { status: "created", model: selection, calls: [] } });
});

test("starting the actual logical call and the Run is atomic and creates no HTTP attempts", () => {
  const db = open();
  let fail = false;
  const repo = new Repositories(db, () => { if (fail) throw new Error("injected commit fault"); });
  const { runId } = repo.registerProvider(request());
  fail = true;
  expect(() => repo.startCall(runId, "call-a", "main", time)).toThrow("injected commit fault");
  expect(repo.read({ runId })).toMatchObject({ kind: "one", run: { status: "created", startedAt: null, calls: [] } });
  fail = false;
  repo.startCall(runId, "call-a", "main", time);
  expect(repo.read({ runId })).toMatchObject({ kind: "one", run: {
    status: "running", calls: [{ callId: "call-a", state: "started", attempt: 1, granularity: "logical_request", attemptCountUnknown: true }],
  } });
  expect(() => repo.startCall(runId, "call-b", "main", time)).toThrow("state_conflict");
  expect(() => repo.startCall(99, "call-orphan", "main", time)).toThrow("state_conflict");
});

test("native success may finalize a cancelled Run and terminal facts cannot change", () => {
  const repo = new Repositories(open());
  const { runId } = repo.registerProvider(request());
  repo.startCall(runId, "call-a", "main", time);
  repo.requestCancel(runId, time);
  const fact = { ...completed(), status: "cancelled" as const, cancelRequestedAt: time };
  const run = repo.finalizeProvider(runId, fact);
  expect(run).toMatchObject({ status: "cancelled", cancelRequestedAt: time, calls: [{ state: "completed" }] });
  expect(repo.finalizeProvider(runId, fact)).toEqual(run);
  expect(() => repo.finalizeProvider(runId, { ...fact, outputText: "changed" })).toThrow("state_conflict");
  repo.requestCancel(runId, "2026-09-30T12:01:00.000Z");
  expect(repo.read({ runId })).toEqual({ kind: "one", run });
});

test("a failed final transaction rolls back both facts and only the same result is later saved", () => {
  const db = open();
  let fail = false;
  const repo = new Repositories(db, () => { if (fail) throw new Error("injected commit fault"); });
  const { runId } = repo.registerProvider(request());
  repo.startCall(runId, "call-a", "main", time);
  fail = true;
  expect(() => repo.finalizeProvider(runId, completed())).toThrow("injected commit fault");
  expect(repo.read({ runId })).toMatchObject({ kind: "one", run: { status: "running", output: { text: "" }, calls: [{ state: "started" }] } });
  expect(repo.active()).toEqual({ runId, kind: "provider", sessionId: null });
  fail = false;
  expect(repo.finalizeProvider(runId, completed())).toMatchObject({ status: "completed", calls: [{ inputTokens: null, cost: null }] });
  expect(repo.active()).toBeNull();
});

test("restart marks old nonterminal facts interrupted without inventing local stop or usage", () => {
  const file = path();
  const first = open(file);
  const repo = new Repositories(first);
  const { runId } = repo.registerProvider(request());
  repo.startCall(runId, "call-a", "main", time);
  first.close(); handles.pop();
  const recovered = new Repositories(open(file));
  expect(recovered.recoverInterrupted("instance-new", "2026-10-01T00:00:00.000Z")).toBe(1);
  const result = recovered.read({ runId });
  expect(result).toMatchObject({ kind: "one", run: {
    instanceId: "instance-old", status: "failed", stoppedAt: null, endedAt: "2026-10-01T00:00:00.000Z",
    error: { reason: "host_interrupted" }, calls: [{ state: "failed", endedAt: null, durationMs: null, inputTokens: null, cost: null }],
  } });
  expect(recovered.recoverInterrupted("instance-newer", "2026-10-01T01:00:00.000Z")).toBe(0);
  expect(recovered.read({ runId })).toEqual(result);
});

test("output pages reconstruct surrogate pairs and recent reads preserve frozen summaries", () => {
  const repo = new Repositories(open());
  const { runId } = repo.registerProvider(request());
  repo.startCall(runId, "call-a", "main", time);
  repo.finalizeProvider(runId, completed("call-a", "A😀B😀C"));
  let offset = 0;
  let assembled = "";
  do {
    const page = repo.read({ operationRef: "operation-a", outputOffset: offset, outputLimit: 1 });
    if (page.kind !== "one" || !page.run) throw new Error("missing run");
    expect(page.run.output.text).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
    assembled += page.run.output.text;
    if (page.run.output.nextOffset === null) break;
    expect(page.run.output.nextOffset).toBeGreaterThan(offset);
    offset = page.run.output.nextOffset;
  } while (true);
  expect(assembled).toBe("A😀B😀C");
  expect(repo.read({ recent: true })).toMatchObject({ kind: "recent", runs: [{ id: runId, status: "completed" }], nextBeforeRunId: null });
  expect(repo.read({ runId: 999 })).toEqual({ kind: "one", run: null });
  expect(() => repo.read({ runId, outputLimit: 32769 })).toThrow("invalid_argument");
});

test("SQL CHECKs, the activity index and durable operation index reject invalid persisted facts", () => {
  const db = open();
  const repo = new Repositories(db);
  const { runId } = repo.registerProvider(request());
  for (const sql of [
    "UPDATE runs SET kind='agent'", "UPDATE runs SET status='unknown'", "UPDATE runs SET config_json='bad json'",
    "UPDATE runs SET config_json='{}'", "UPDATE runs SET scope_json='bad json'", "UPDATE runs SET session_id=1",
    "UPDATE runs SET input_id=1", "UPDATE runs SET prior_run_id=999", "UPDATE runs SET prior_run_id=id",
  ]) expect(() => db.exec(sql)).toThrow();
  repo.startCall(runId, "call-a", "main", time);
  for (const sql of [
    "UPDATE model_calls SET run_id=999", "UPDATE model_calls SET state='unknown'",
    "UPDATE model_calls SET model_json='bad json'", "UPDATE model_calls SET cost=1,cost_currency=NULL",
    "UPDATE model_calls SET input_tokens=-1", "UPDATE model_calls SET input_tokens=1.5", "UPDATE model_calls SET attempt=0",
  ]) expect(() => db.exec(sql)).toThrow();
  repo.finalizeProvider(runId, completed());
  const second = repo.registerProvider(request("operation-b"));
  expect(() => db.query("UPDATE runs SET status='running' WHERE id=?").run(runId)).toThrow();
  expect(() => db.query("UPDATE runs SET config_json=(SELECT config_json FROM runs WHERE id=?) WHERE id=?").run(runId, second.runId)).toThrow();
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("a run-write failure after the call update rolls the entire finalization back", () => {
  const db = open();
  const repo = new Repositories(db);
  const { runId } = repo.registerProvider(request());
  repo.startCall(runId, "call-a", "main", time);
  db.exec("CREATE TEMP TRIGGER fail_final BEFORE UPDATE OF status ON runs WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'run write fault'); END");
  expect(() => repo.finalizeProvider(runId, completed())).toThrow("run write fault");
  expect(repo.read({ runId })).toMatchObject({ kind: "one", run: { status: "running", calls: [{ state: "started" }] } });
  db.exec("DROP TRIGGER fail_final");
  expect(repo.finalizeProvider(runId, completed())).toMatchObject({ status: "completed", calls: [{ state: "completed" }] });
});

test("checksum mismatch is rejected without replacing the database", () => {
  const file = path();
  const db = open(file);
  db.exec("UPDATE schema_migrations SET checksum='bad-checksum'");
  db.close(); handles.pop();
  expect(() => openDatabase(file)).toThrow("storage_migration_failed");
  const original = new Database(file);
  expect(original.query("SELECT checksum FROM schema_migrations").get()).toEqual({ checksum: "bad-checksum" });
  original.close();
});

test("failed DDL rolls migration back and preserves pre-existing data", () => {
  const file = path();
  const original = new Database(file);
  original.exec("CREATE TABLE runs(sentinel TEXT); INSERT INTO runs VALUES('keep me')");
  original.close();
  expect(() => openDatabase(file)).toThrow("storage_migration_failed");
  const reopened = new Database(file);
  expect(reopened.query("SELECT sentinel FROM runs").get()).toEqual({ sentinel: "keep me" });
  expect(reopened.query("SELECT name FROM sqlite_schema WHERE name='schema_migrations'").get()).toBeNull();
  reopened.close();
});

test("foreign-key damage is rejected on reopen without fabricating a clean database", () => {
  const file = path();
  const db = open(file);
  const repo = new Repositories(db);
  repo.registerProvider(request());
  db.exec("PRAGMA foreign_keys=OFF; UPDATE runs SET prior_run_id=999");
  db.close(); handles.pop();
  expect(() => openDatabase(file)).toThrow("storage_migration_failed");
  const original = new Database(file);
  expect(original.query("SELECT prior_run_id FROM runs").get()).toEqual({ prior_run_id: 999 });
  original.close();
});
