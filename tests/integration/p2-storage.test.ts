import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/storage/src/database";
import { Repositories } from "../../packages/storage/src/repositories";
import { safeError } from "../../packages/contracts/src/error";
import { SubmitInputSchema } from "../../packages/contracts/src/session";
import { RunCleanupRecordSchema } from "../../packages/contracts/src/run";

const handles: Database[] = [], roots: string[] = [];
const time = "2026-10-01T00:00:00.000Z", later = "2026-10-01T00:00:01.000Z";
function file() { const root = mkdtempSync(join(tmpdir(), "medclaw-p2-db-")); roots.push(root); return join(root, "app.sqlite"); }
function open(path = file()) { const db = openDatabase(path); handles.push(db); return db; }
afterEach(() => { for (const db of handles.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const selection = { provider: "test", modelId: "text", endpointRef: null, api: "openai-completions", configVersion: "1", credentialRef: null,
  maxOutputTokens: 1024, capabilitySource: "pi_catalog" as const, sdkVersion: "0.87.1" as const };
const policy = { timeoutMs: 120000, maxRetries: 0 as const, maxRetryDelayMs: 2000 };
const cleanup = RunCleanupRecordSchema.parse({ contract: "medclaw.run-cleanup/v1", executionStarted: true, stopConfirmed: null,
  requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: false, unconfirmedItems: ["stop", "resources"], secondaryErrors: [], verifiedAt: null });
function agent(repo: Repositories, sessionId: number, operationRef = "submit-1", clientSequence = 1, text = "hello") {
  const workspace = repo.readWorkspace(), session = repo.readSession(sessionId)!;
  const originalRequest = SubmitInputSchema.parse({ sessionId, clientSequence, text, mode: "send", expectedRevision: workspace.revision,
    expectedBatchIds: [], expectedQueryId: null, model: { provider: "test", modelId: "text", expectedConfigVersion: "1" }, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" });
  return { sessionId, inputId: null, text, model: selection, policy, goal: "answer" as const, workspace,
    scope: { batchIds: [], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true },
    referenceDate: originalRequest.referenceDate, timezone: originalRequest.timezone, timeoutMs: policy.timeoutMs,
    submission: { operationRef, originalSubmitInput: originalRequest }, instanceId: "host-old",
    agentOptions: { requestedThinkingLevel: "off" as const, effectiveThinkingLevel: "off" as const }, createdAt: time };
}
function provider(operationRef = "provider-1") {
  const originalRequest = { text: "hello", model: { provider: "test", modelId: "text", expectedConfigVersion: "1" }, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" };
  return { operationRef, originalRequest, instanceId: "host-old", method: "model.request" as const, goal: "answer" as const,
    inputText: "hello", selection, policy, referenceDate: originalRequest.referenceDate, timezone: originalRequest.timezone, createdAt: time };
}
function makeSession(repo: Repositories, op = "create-1", native = "native-1") {
  return repo.createSession({ expectedWorkspaceRevision: repo.readWorkspace().revision }, op, native, time).session.id;
}

test("latest database preserves P2 tables alongside P3, verifies ten migrations and has no FK violations", () => {
  const db = open();
  expect(db.query("SELECT name FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
    .toEqual(["answers", "artifacts", "batches", "business_events", "catalog_state", "change_events", "context_deliveries", "context_snapshots", "data_deletions", "devices", "imports", "memories", "model_calls", "queries", "query_evidence", "runs", "runtime_events", "schema_migrations", "session_inputs", "sessions", "snapshots", "tool_calls", "workspace"].map(name => ({ name })));
  expect(db.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }]);
  expect(db.query("SELECT COUNT(*) AS n FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' AND strict<>1").get()).toEqual({ n: 0 });
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 1000 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

function legacy(path: string) {
  const db = new Database(path, { create: true }); handles.push(db);
  const sql = readFileSync(new URL("../../packages/storage/src/migrations/001_p1.sql", import.meta.url));
  db.exec(sql.toString());
  db.query("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(1,?,?)").run(createHash("sha256").update(sql).digest("hex"), time);
  // Seed 001 directly so upgrading proves original P1 facts survive.
  for (const [index, status] of ["completed", "failed", "cancelled"].entries()) {
    const base = provider(`legacy-${index}`), priorRunId = index || null, runId = index + 1;
    const originalRequest = { ...base.originalRequest, ...(priorRunId ? { priorRunId } : {}) };
    const config = { providerRequest: { operationRef: base.operationRef, method: base.method, originalRequest }, selection, policy };
    db.query(`INSERT INTO runs(id,kind,prior_run_id,instance_id,status,goal,input_text,output_text,config_json,scope_json,reference_date,timezone,
      error_json,created_at,started_at,cancel_requested_at,stopped_at,ended_at) VALUES(?,'provider',?,'host-old',?,'answer','hello',?,?,'{}','2026-10-01','Asia/Shanghai',?,?,?,?,?,?)`)
      .run(runId, priorRunId, status, status === "completed" ? "真实😀原文" : null, JSON.stringify(config),
        status === "failed" ? JSON.stringify(safeError("provider_request_failed")) : null, time, time, status === "cancelled" ? time : null, time, time);
    db.query(`INSERT INTO model_calls(call_id,run_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,started_at,ended_at,unavailable_reason)
      VALUES(?,?,'main',1,'logical_request',1,?,?,?,?,'unknown')`)
      .run(`call-${index}`, runId, JSON.stringify({ selection, responseModel: "text", sdkStopReason: status === "completed" ? "stop" : "error" }), status, time, time);
  }
  return db;
}

test("001 upgrades without changing any existing field, JSON byte or unknown usage and reopening is idempotent", () => {
  const path = file(), old = legacy(path);
  const runs = old.query<Record<string, unknown>, []>("SELECT * FROM runs ORDER BY id").all();
  const calls = old.query("SELECT * FROM model_calls ORDER BY id").all();
  old.close(); handles.pop();
  const db = open(path);
  const migrated = db.query<Record<string, unknown>, []>("SELECT * FROM runs ORDER BY id").all();
  expect(migrated.map(row => Object.fromEntries(Object.keys(runs[0]!).map(key => [key, row[key]])))).toEqual(runs);
  expect(db.query("SELECT * FROM model_calls ORDER BY id").all()).toEqual(calls);
  expect(db.query("SELECT * FROM sessions").all()).toEqual([]);
  db.close(); handles.pop();
  expect(open(path).query("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({n:13});
});

test("a late migration fault rolls back to the original valid 001 file", () => {
  const path = file(), old = legacy(path), rows = old.query("SELECT * FROM runs ORDER BY id").all(); old.close(); handles.pop();
  expect(() => openDatabase(path, () => { throw new Error("late fault"); })).toThrow("storage_migration_failed");
  const db = new Database(path); handles.push(db);
  expect(db.query("SELECT * FROM runs ORDER BY id").all()).toEqual(rows);
  expect(db.query("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }]);
  expect(db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
    .toEqual(["model_calls", "runs", "schema_migrations"].map(name => ({ name })));
});

test("create replay returns original result without reselecting over later B; CAS is atomic and idempotent", () => {
  const repo = new Repositories(open());
  const a = repo.createSession({ expectedWorkspaceRevision: 0 }, "create-a", "native-a", time);
  const b = repo.createSession({ expectedWorkspaceRevision: 1 }, "create-b", "native-b", time);
  expect(a.session.title).toBe("New Session 1");
  expect(b.session.title).toBe("New Session 2");
  expect(repo.readSession(a.session.id)?.title).toBe("New Session 1");
  expect(repo.findOperation("create-a")).toMatchObject({ method: "session.create", result: a });
  expect(repo.createSession({ selectOnCreate: true, expectedWorkspaceRevision: 0 }, "create-a", "unused", later)).toEqual(a);
  expect(repo.readWorkspace()).toEqual(b.workspace);
  expect(() => repo.createSession({ expectedWorkspaceRevision: 2 }, "create-a", "unused", later)).toThrow("state_conflict");
  expect(() => repo.selectSession({ sessionId: a.session.id, expectedWorkspaceRevision: 1 }, later)).toThrow("workspace_revision_mismatch");
  expect(repo.selectSession({ sessionId: b.session.id, expectedWorkspaceRevision: 2 }, later).revision).toBe(2);
  expect(repo.selectSession({ sessionId: a.session.id, expectedWorkspaceRevision: 2 }, later).revision).toBe(3);
  expect(repo.listSessions({}).sessions.map(s => s.id)).toEqual([2, 1]);
});

test("legacy creation replay preserves the Chinese snapshot, later selection and saved error facts", async () => {
  const { errorMessage } = await import("../../packages/contracts/src/error");
  const db = open(), repo = new Repositories(db);
  const a = repo.createSession({ expectedWorkspaceRevision: 0 }, "legacy-create-a", "native-a", time);
  const original = { ...a, session: { ...a.session, title: "新会话 1" } };
  db.query("UPDATE sessions SET title=?,creation_result_json=? WHERE id=?").run(original.session.title, JSON.stringify(original), a.session.id);
  const { runId } = repo.registerAgent(agent(repo, a.session.id));
  repo.startCall(runId, "legacy-call", "main", time);
  const oldError = { ...safeError("run_timeout"), message: "模型请求超过运行时限。" };
  repo.checkpointFailure(runId, oldError, { ...cleanup, secondaryErrors: [oldError] }, time);
  db.query("UPDATE model_calls SET error_json=? WHERE run_id=?").run(JSON.stringify(oldError), runId);
  const b = repo.createSession({ expectedWorkspaceRevision: 1 }, "create-b", "native-b", later);
  const sessions = db.query("SELECT * FROM sessions ORDER BY id").all(), runs = db.query("SELECT * FROM runs").all(), calls = db.query("SELECT * FROM model_calls").all();
  expect(repo.createSession({ expectedWorkspaceRevision: 0 }, "legacy-create-a", "unused", later)).toEqual(original);
  expect(repo.readWorkspace()).toEqual(b.workspace);
  expect(repo.readSession(a.session.id)?.title).toBe("New Session 1");
  const saved = repo.read({ runId });
  if (saved.kind !== "one" || !saved.run?.error) throw new Error("missing original Run error");
  expect(errorMessage(saved.run.error)).toBe("The model request exceeded the runtime limit.");
  expect(saved.run.error).toEqual(oldError);
  expect(saved.run.calls[0]?.error).toEqual(oldError);
  expect(saved.run.cleanup?.secondaryErrors).toEqual([oldError]);
  expect(db.query("SELECT * FROM sessions ORDER BY id").all()).toEqual(sessions);
  expect(db.query("SELECT * FROM runs").all()).toEqual(runs);
  expect(db.query("SELECT * FROM model_calls").all()).toEqual(calls);
});

test("creation commit failure leaves neither Session nor changed workspace", () => {
  const db = open(), repo = new Repositories(db, () => { throw new Error("commit fault"); });
  expect(() => makeSession(repo)).toThrow("commit fault");
  expect(repo.listSessions({}).sessions).toEqual([]); expect(repo.readWorkspace()).toMatchObject({ sessionId: null, revision: 0 });
});

test("submission freezes complete original request and dual identities before any call; replay ignores newer state", () => {
  const db = open(), repo = new Repositories(db), a = makeSession(repo), input = agent(repo, a);
  const accepted = repo.registerAgent(input);
  expect(accepted).toEqual({ sessionId: a, clientSequence: 1, inputId: null, runId: 1 });
  expect(repo.findSubmission({ sessionId: a, clientSequence: 1 })).toEqual(accepted);
  expect(repo.findSubmission({ sessionId: a, clientSequence: 2 })).toBeNull();
  expect(repo.registerAgent({ ...input, model: { ...selection, configVersion: "99" } })).toEqual(accepted);
  expect(() => repo.registerAgent({ ...input, submission: { ...input.submission, originalSubmitInput: { ...input.submission.originalSubmitInput, text: "changed" } } })).toThrow("state_conflict");
  expect(() => repo.registerAgent({ ...input, submission: { ...input.submission, operationRef: "different" } })).toThrow("state_conflict");
  expect(() => repo.registerProvider(provider("submit-1"))).toThrow("state_conflict");
  expect(() => repo.createSession({ expectedWorkspaceRevision: 1 }, "submit-1", "unused", time)).toThrow("state_conflict");
  expect(repo.readSession(a)?.nextSubmissionSequence).toBe(2);
  expect(repo.read({ runId: 1 })).toMatchObject({ kind: "one", run: { kind: "agent", sessionId: a, status: "created", calls: [], nativeSessionId: "native-1" } });
  expect(db.query("SELECT submission_request_json FROM runs").get()).not.toBeNull();
});

test("Provider and Agent share the root constraint, and Agent calls derive ownership from the Run", () => {
  const db = open(), repo = new Repositories(db), a = makeSession(repo), b = makeSession(repo, "create-b", "native-b");
  repo.selectSession({ sessionId: a, expectedWorkspaceRevision: 2 }, time);
  const { runId } = repo.registerAgent(agent(repo, a));
  expect(() => repo.registerProvider(provider())).toThrow("runtime_busy");
  repo.startCall(runId, "first", "main", time); repo.startCall(runId, "second", "main", later);
  expect(db.query("SELECT session_id FROM model_calls ORDER BY id").all()).toEqual([{ session_id: a }, { session_id: a }]);
  expect(() => db.query("UPDATE model_calls SET session_id=NULL WHERE call_id='first'").run()).toThrow();
  expect(() => db.query("UPDATE model_calls SET session_id=? WHERE call_id='first'").run(b)).toThrow();
  expect(() => db.query("UPDATE model_calls SET run_id=999 WHERE call_id='first'").run()).toThrow();
  expect(() => db.query("UPDATE runs SET input_id=1 WHERE id=?").run(runId)).toThrow();
  expect(() => db.query("UPDATE runs SET submission_request_json=NULL WHERE id=?").run(runId)).toThrow();
});

test("terminal failure/cancellation checkpoint can gain cleanup evidence without changing primary facts", () => {
  const db = open(), repo = new Repositories(db), a = makeSession(repo), { runId } = repo.registerAgent(agent(repo, a));
  repo.startCall(runId, "first", "main", time);
  repo.checkpointFailure(runId, safeError("run_timeout"), cleanup, time);
  const before = repo.read({ runId });
  repo.saveRunCleanup(runId, { ...cleanup, stopConfirmed: true, resourcesReleased: true, unconfirmedItems: [], verifiedAt: later });
  expect(repo.read({ runId })).toMatchObject({ kind: "one", run: { status: "failed", error: { code: "run_timeout" }, endedAt: time,
    cleanup: { stopConfirmed: true, resourcesReleased: true }, calls: [{ state: "started", endedAt: null }] } });
  expect(() => repo.checkpointFailure(runId, safeError("host_interrupted"), cleanup, later)).toThrow("state_conflict");
  expect(before).toMatchObject({ kind: "one", run: { status: "failed", cleanup: { stopConfirmed: null } } });
  expect(() => repo.saveRunCleanup(runId, { ...cleanup, executionStarted: false })).toThrow("state_conflict");
});

test("Host interruption preserves terminal completed/failed/cancelled and known call facts while exposing gaps", () => {
  const path = file(), db = legacy(path); db.close(); handles.pop();
  const migrated = open(path), repo = new Repositories(migrated);
  const before = migrated.query("SELECT status,error_json,ended_at,input_text,output_text FROM runs ORDER BY id").all();
  const calls = migrated.query("SELECT * FROM model_calls ORDER BY id").all();
  repo.recoverInterrupted("host-new", later);
  expect(migrated.query("SELECT status,error_json,ended_at,input_text,output_text FROM runs ORDER BY id").all()).toEqual(before);
  expect(migrated.query("SELECT * FROM model_calls ORDER BY id").all()).toEqual(calls);
  expect(repo.recoveryCandidates("host-new")).toHaveLength(3);
});

test("long Unicode inputs are stored verbatim and returned in bounded input/recent pages", () => {
  const repo = new Repositories(open()), a = makeSession(repo), text = "器械😀".repeat(30000), { runId } = repo.registerAgent(agent(repo, a, "long", 1, text));
  let offset = 0, collected = "";
  do {
    const result = repo.read({ runId, inputOffset: offset, inputLimit: 65536 });
    if (result.kind !== "one" || !result.run) throw new Error("missing");
    expect(result.run.inputText).toBe(result.run.inputPage.text); expect(result.run.inputText.length).toBeLessThanOrEqual(65536);
    collected += result.run.inputText; offset = result.run.inputPage.nextOffset ?? -1;
  } while (offset !== -1);
  expect(collected).toBe(text);
  expect(repo.read({ recent: true, sessionId: a, kind: "agent" })).toMatchObject({ kind: "recent", runs: [{ id: runId }] });
  const recent = repo.read({ recent: true }); if (recent.kind !== "recent") throw new Error("wrong page");
  expect(recent.runs[0]!.inputText.length).toBeLessThanOrEqual(2048);
});

test("Agent finalization commits all real calls and output together, with rollback and same-fact retry", () => {
  const db = open(); let fail = false;
  const repo = new Repositories(db, () => { if (fail) throw new Error("save fault"); }), a = makeSession(repo), { runId } = repo.registerAgent(agent(repo, a));
  repo.startCall(runId, "first", "main", time); repo.startCall(runId, "second", "main", time);
  const calls = ["first", "second"].map(callId => ({ callId, state: "completed" as const, responseModel: "text", sdkStopReason: "stop" as const,
    endedAt: later, durationMs: 5, inputTokens: null, outputTokens: null, cost: null, costCurrency: null, usageSource: null, unavailableReason: "unknown", error: null }));
  const fact = { status: "completed" as const, outputText: "answer", stoppedAt: later, endedAt: later, error: null, calls,
    cleanup: { ...cleanup, stopConfirmed: true, resourcesReleased: true, unconfirmedItems: [], verifiedAt: later } };
  fail = true; expect(() => repo.finalizeAgent(runId, fact)).toThrow("save fault");
  expect(repo.read({ runId })).toMatchObject({ kind: "one", run: { status: "running", output: { text: "" }, calls: [{ state: "started" }, { state: "started" }] } });
  fail = false; const saved = repo.finalizeAgent(runId, fact); expect(repo.finalizeAgent(runId, fact)).toEqual(saved);
  expect(() => repo.finalizeAgent(runId, { ...fact, outputText: "different" })).toThrow("state_conflict");
  expect(repo.read({ runId, callLimit: 1 })).toMatchObject({ kind: "one", run: { calls: [{ callId: "first" }], nextCallOffset: 1 } });
  expect(repo.read({ runId, callOffset: 1, callLimit: 1 })).toMatchObject({ kind: "one", run: { calls: [{ callId: "second" }], nextCallOffset: null } });
  expect(() => repo.read({ runId, callOffset: 3 })).toThrow("invalid_argument");
});

test("late actual-stop evidence preserves failed first endedAt and can finalize previously unknown calls", () => {
  const repo = new Repositories(open()), a = makeSession(repo), { runId } = repo.registerAgent(agent(repo, a));
  repo.startCall(runId, "first", "main", time); const error = safeError("run_timeout");
  repo.checkpointFailure(runId, error, cleanup, time);
  const saved = repo.finalizeAgent(runId, { status: "failed", outputText: "observed partial", stoppedAt: later, endedAt: later, error,
    calls: [{ callId: "first", state: "cancelled", responseModel: null, sdkStopReason: "aborted", endedAt: later, durationMs: null,
      inputTokens: null, outputTokens: null, cost: null, costCurrency: null, usageSource: null, unavailableReason: "unknown", error: null }],
    cleanup: { ...cleanup, stopConfirmed: true, resourcesReleased: true, unconfirmedItems: [], verifiedAt: later } });
  expect(saved).toMatchObject({ status: "failed", endedAt: time, stoppedAt: later, error: { code: "run_timeout" }, calls: [{ state: "cancelled" }] });
});

test("cancelled terminal with cleanup false remains a recovery candidate and only cleanup gains evidence", () => {
  const db = open(), repo = new Repositories(db), a = makeSession(repo), { runId } = repo.registerAgent(agent(repo, a));
  repo.requestCancel(runId, time);
  const pending = { ...cleanup, executionStarted: false, stopConfirmed: false, requiredPersistenceComplete: false };
  repo.finalizeAgent(runId, { status: "cancelled", outputText: null, stoppedAt: null, endedAt: time, error: null, calls: [], cleanup: pending });
  const before = db.query("SELECT status,error_json,ended_at,input_text,output_text FROM runs").get();
  expect(repo.active()).toBeNull(); expect(repo.recoveryCandidates("host-new")).toHaveLength(1);
  repo.saveRunCleanup(runId, { ...pending, stopConfirmed: true, requiredPersistenceComplete: true, resourcesReleased: true, unconfirmedItems: [], verifiedAt: later });
  expect(repo.recoveryCandidates("host-new")).toEqual([]); expect(db.query("SELECT status,error_json,ended_at,input_text,output_text FROM runs").get()).toEqual(before);
  expect(() => repo.saveRunCleanup(runId, { ...pending, executionStarted: true })).toThrow("state_conflict");
});

test("accepted commit failure is not misreported as a saved submission; corrupted facts are storage errors", () => {
  const db = open(); let fail = false;
  const repo = new Repositories(db, () => { if (fail) throw new Error("admission fault"); }), a = makeSession(repo), input = agent(repo, a);
  fail = true; expect(() => repo.registerAgent(input)).toThrow("admission fault");
  expect(repo.findSubmission({ sessionId: a, clientSequence: 1 })).toBeNull(); expect(repo.readSession(a)?.nextSubmissionSequence).toBe(1);
  fail = false; repo.registerAgent(input);
  db.query("UPDATE runs SET submission_request_json=json_set(submission_request_json,'$.mode','steer')").run();
  expect(() => repo.findOperation(input.submission.operationRef)).toThrow("storage_read_failed");
});
