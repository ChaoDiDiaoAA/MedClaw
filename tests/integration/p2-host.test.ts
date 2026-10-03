import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HostController } from "../../apps/desktop/src/main/host-controller";
import { MainSettings, atomicWriteJson } from "../../apps/desktop/src/main/settings";
import { PublishedSettingsSchema } from "../../packages/contracts/src/model";
import { mergeRuntimeConfigurationPolicies } from '../../packages/contracts/src/runtime-config';
import { NewSessionResultSchema, SessionDetailSchema, SessionInputSchema, SessionInputPageSchema, SubmitResultSchema, type SubmitInput } from "../../packages/contracts/src/session";
import { RuntimeControlViewSchema, ReadRunResultSchema } from "../../packages/contracts/src/run";
import { WorkspaceViewSchema } from "../../packages/contracts/src/workspace";
import { safeError, type Result } from "../../packages/contracts/src/error";
import type { DesktopNotice } from "../../packages/contracts/src/protocol";
import { DATABASE_SCHEMA_VERSION } from "../../packages/contracts/src/protocol";
import { providerFixture } from "../fixtures/p1-provider";
import { SessionMessagePageSchema } from "../../packages/contracts/src/messages";

function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function sendResult(value: unknown) {
  const result = SubmitResultSchema.parse(value);
  expect(result.runId !== null).toBe(true);
  expect(result.inputId !== null).toBe(true);
  if (result.runId === null || result.inputId === null) throw new Error('Current Send acceptance requires root Run and input identities');
  return { ...result, runId: result.runId, inputId: result.inputId };
}
async function until(check: () => boolean | Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error("Host condition timed out"); await Bun.sleep(20); }
}
async function setup(mode: Parameters<typeof providerFixture>[0] = "success") {
  const root = mkdtempSync(join(tmpdir(), "medclaw-p2-host-")), service = providerFixture(mode), notices: DesktopNotice[] = [];
  const host = new HostController({ dataRoot: root, hostEntry: resolve("apps/host/src/main.ts"), bunExecutable: process.execPath,
    onNotice: notice => notices.push(notice), onCredentialRequest: async frame => {
      if (frame.method === "credential.list") return { ok: true, data: [{ providerId: "p2-fixture", type: "api_key" }] };
      if (frame.method === "credential.read") return { ok: true, data: frame.payload.providerId === "p2-fixture" ? { type: "api_key", key: "fixture-only" } : null };
      return { ok: false, error: safeError("access_denied") };
    } });
  const initial = new MainSettings(host.paths.settingsPath).read();
  const definition = { providerId: "p2-fixture", name: "Fixture", api: "openai-completions", baseUrl: service.url,
    models: [{ id: "fixture", name: "Fixture", input: ["text"], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] };
  atomicWriteJson(host.paths.settingsPath, PublishedSettingsSchema.parse({ ...initial, model: { provider: "p2-fixture", modelId: "fixture" },
    customProviders: [{ definition, credentialRef: null }], ...mergeRuntimeConfigurationPolicies(initial, { requestPolicy: { timeoutMs: mode === "slow" ? 10000 : 5000, maxRetries: 0, maxRetryDelayMs: 2000 } }) }));
  expect(await host.start()).toMatchObject({ state: "ready", schemaVersion: DATABASE_SCHEMA_VERSION, error: null });
  async function workspace() { return WorkspaceViewSchema.parse(unwrap(await host.request("workspace.read", {}))); }
  async function create(op: string = crypto.randomUUID()) { return NewSessionResultSchema.parse(unwrap(await host.request("session.create", { expectedWorkspaceRevision: (await workspace()).revision }, op))); }
  async function select(sessionId: number) { return WorkspaceViewSchema.parse(unwrap(await host.request("session.select", { sessionId, expectedWorkspaceRevision: (await workspace()).revision }))); }
  async function input(sessionId: number, text: string): Promise<SubmitInput> {
    const session = SessionDetailSchema.parse(unwrap(await host.request("session.read", { sessionId })));
    return { sessionId, clientSequence: session.session.nextSubmissionSequence, text, mode: "send", expectedRevision: (await workspace()).revision,
      expectedBatchIds: [], expectedQueryId: null, model: { provider: "p2-fixture", modelId: "fixture", expectedConfigVersion: "1" }, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" };
  }
  async function idle() { await until(async () => RuntimeControlViewSchema.parse(unwrap(await host.request("run.control.read", {}))).acceptingNewRuns); }
  async function close() { try { if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!); } finally { service.close(); rmSync(root, { recursive: true, force: true }); } }
  return { host, root, service, notices, workspace, create, select, input, idle, close };
}

test("actual Host routes Session/Workspace and A→B→A uses isolated native histories", async () => {
  const c = await setup();
  try {
    const a = await c.create("create-a"), b = await c.create("create-b");
    expect(a.session.nativeSessionId).not.toBe(b.session.nativeSessionId);
    const replay = unwrap(await c.host.request("session.create", { expectedWorkspaceRevision: 0 }, "create-a")); expect(replay).toEqual(a);
    expect((await c.workspace()).sessionId).toBe(b.session.id);
    await c.select(a.session.id); const original = await c.input(a.session.id, "A-unique-history");
    const accepted = sendResult(unwrap(await c.host.request("session.submit", original, "send-a"))); await c.idle();
    await c.select(b.session.id); unwrap(await c.host.request("session.submit", await c.input(b.session.id, "B-unique-history"), "send-b")); await c.idle();
    expect(unwrap(await c.host.request("session.submit", original, "send-a"))).toEqual(accepted);
    expect(await c.host.request("session.submit", { ...original, text: "changed" }, "send-a")).toMatchObject({ ok: false, error: { code: "state_conflict" } });
    await c.select(a.session.id); unwrap(await c.host.request("session.submit", await c.input(a.session.id, "A-follow-up"), "send-a2")); await c.idle();
    expect(c.service.requests).toHaveLength(3);
    const inputs = c.service.requests.map(r => JSON.stringify(r.body));
    expect(inputs[1]).not.toContain("A-unique-history"); expect(inputs[2]).toContain("A-unique-history"); expect(inputs[2]).not.toContain("B-unique-history");
    expect(SessionDetailSchema.parse(unwrap(await c.host.request("session.read", { sessionId: a.session.id }))).history.messages).toHaveLength(4);
    expect(await c.host.request("session.readSubmission", { sessionId: a.session.id, clientSequence: 1 })).toEqual({ ok: true, data: accepted });
    expect(await c.host.request("session.readSubmission", { sessionId: a.session.id, clientSequence: 99 })).toEqual({ ok: true, data: null });
  } finally { await c.close(); }
}, 30000);

test("actual slow Host streams to A while viewing B; busy Send and Stop keep the root identity", async () => {
  const c = await setup("slow");
  try {
    const a = await c.create(), b = await c.create(); await c.select(a.session.id);
    const accepted = sendResult(unwrap(await c.host.request("session.submit", await c.input(a.session.id, "A-slow"), "slow-a")));
    await c.service.requested; await c.select(b.session.id);
    const browsing = await c.workspace();
    expect(await c.host.request("session.messages.read", { sessionId: a.session.id })).toMatchObject({ ok: true, data: { sessionId: a.session.id } });
    expect(await c.host.request("session.messages.read", { sessionId: b.session.id })).toMatchObject({ ok: true, data: { items: [] } });
    expect(await c.workspace()).toEqual(browsing); expect(c.service.requests).toHaveLength(1);
    expect(RuntimeControlViewSchema.parse(unwrap(await c.host.request("run.control.read", {})))).toMatchObject({ activeRootRun: { runId: accepted.runId, sessionId: a.session.id }, acceptingNewRuns: false });
    expect(await c.host.request("session.submit", await c.input(b.session.id, "B-draft"), "busy-b")).toMatchObject({ ok: false, error: { code: "state_conflict", reason: "runtime_busy" } });
    const opened = unwrap(await c.host.request('event.subscribe', { action:'open', subscriptionId:'p2-slow-a', runId:accepted.runId, afterSequence:0, limit:50 })) as {snapshots:{runId:number;sessionId:number}[]};
    await until(() => opened.snapshots.length > 0 || c.notices.some(n => n.type === 'event.stream'));
    expect(opened.snapshots.every(n=>n.sessionId===a.session.id&&n.runId===accepted.runId)).toBe(true);
    expect(c.notices.filter(n=>n.type==='event.stream').every(n=>n.snapshot.sessionId===a.session.id&&n.snapshot.runId===accepted.runId)).toBe(true);
    expect(await c.host.request("run.cancel", { runId: accepted.runId })).toMatchObject({ ok: true, data: { stopped: true } }); await c.idle();
    expect(ReadRunResultSchema.parse(unwrap(await c.host.request("run.read", { runId: accepted.runId })))).toMatchObject({ kind: "one", run: { status: "cancelled", sessionId: a.session.id } });
    expect(c.service.requests).toHaveLength(1);
  } finally { await c.close(); }
}, 30000);

test("Host restart keeps metadata and original acceptance but cannot restore P2 history", async () => {
  const c = await setup();
  try {
    const a = await c.create(), original = await c.input(a.session.id, "before-restart");
    const accepted = unwrap(await c.host.request("session.submit", original, "original")); await c.idle();
    const old = c.host.read().instanceId!; expect(await c.host.restart(old)).toMatchObject({ state: "ready", error: null });
    expect(c.host.read().instanceId).not.toBe(old);
    expect(await c.host.request("session.messages.read", { sessionId: a.session.id })).toMatchObject({ ok: false, error: { code: "resource_unavailable" } });
    expect(SessionDetailSchema.parse(unwrap(await c.host.request("session.read", { sessionId: a.session.id })))).toMatchObject({ session: { id: a.session.id, leafId: null }, history: { available: false, reason: "host_restart", messages: [] } });
    expect(unwrap(await c.host.request("session.submit", original, "original"))).toEqual(accepted);
    expect(await c.host.request("session.submit", await c.input(a.session.id, "cannot resume"), "new-old-session")).toMatchObject({ ok: false, error: { code: "session_history_invalid" } });
    expect(c.service.requests).toHaveLength(1);
    const b = await c.create(); unwrap(await c.host.request("session.submit", await c.input(b.session.id, "new-process-session"), "new-session")); await c.idle();
    expect(c.service.requests).toHaveLength(2);
  } finally { await c.close(); }
}, 30000);

test("startup supplements failed/cancelled/completed cleanup while preserving known durable results", async () => {
  const c = await setup();
  try {
    const a = await c.create(), ids: number[] = [];
    for (const status of ["failed", "cancelled", "completed"] as const) { ids.push(sendResult(unwrap(await c.host.request("session.submit", await c.input(a.session.id, status), status))).runId); await c.idle(); }
    await c.host.stop(c.host.read().instanceId!);
    const db = new Database(c.host.paths.databasePath); let before: unknown[] = [], calls: unknown[] = [];
    try {
      for (const [i, status] of ["failed", "cancelled", "completed"].entries()) db.query("UPDATE runs SET status=?,error_json=?,cancel_requested_at=?,cleanup_json=json_set(cleanup_json,'$.stopConfirmed',0,'$.resourcesReleased',0,'$.unconfirmedItems',json('[\"stop\",\"resources\"]')) WHERE id=?")
        .run(status, status === "failed" ? JSON.stringify(safeError("run_timeout")) : null, status === "cancelled" ? "2026-10-01T00:00:00.000Z" : null, ids[i]!);
      before = db.query("SELECT id,status,error_json,ended_at,stopped_at,input_text,output_text,usage_json FROM runs ORDER BY id").all(); calls = db.query("SELECT * FROM model_calls ORDER BY id").all();
    } finally { db.close(); }
    expect(await c.host.start()).toMatchObject({ state: "ready", error: null }); await c.idle();
    for (const id of ids) expect(ReadRunResultSchema.parse(unwrap(await c.host.request("run.read", { runId: id })))).toMatchObject({ kind: "one", run: { cleanup: { stopConfirmed: true, resourcesReleased: true, unconfirmedItems: [] } } });
    unwrap(await c.host.request("run.control.read", {})); unwrap(await c.host.request("workspace.restore", {})); await c.host.stop(c.host.read().instanceId!);
    const check = new Database(c.host.paths.databasePath, { readonly: true });
    try { expect(check.query("SELECT id,status,error_json,ended_at,stopped_at,input_text,output_text,usage_json FROM runs ORDER BY id").all()).toEqual(before); expect(check.query("SELECT * FROM model_calls ORDER BY id").all()).toEqual(calls); }
    finally { check.close(); }
    expect(c.service.requests).toHaveLength(3);
  } finally { await c.close(); }
}, 30000);

test("fast competing Session selections use CAS; stale requests cannot move confirmed Workspace", async () => {
  const c = await setup();
  try {
    const a = await c.create(), b = await c.create(), d = await c.create(), revision = (await c.workspace()).revision;
    const replies = await Promise.all([c.host.request("session.select", { sessionId: a.session.id, expectedWorkspaceRevision: revision }), c.host.request("session.select", { sessionId: b.session.id, expectedWorkspaceRevision: revision })]);
    expect(replies.filter(reply => reply.ok)).toHaveLength(1);
    expect(replies.filter(reply => !reply.ok)).toMatchObject([{ ok: false, error: { code: "state_conflict", reason: "workspace_revision_mismatch" } }]);
    const confirmed = await c.workspace(); expect(confirmed.revision).toBe(revision + 1);
    expect(await c.host.request("session.select", { sessionId: d.session.id, expectedWorkspaceRevision: revision })).toMatchObject({ ok: false, error: { reason: "workspace_revision_mismatch" } });
    expect(await c.workspace()).toEqual(confirmed); expect(c.service.requests).toHaveLength(0);
  } finally { await c.close(); }
}, 30000);

test("lost acceptance reply is unknown; original lookup and resubmission issue only one actual request", async () => {
  const c = await setup();
  try {
    const a = await c.create(), input = await c.input(a.session.id, "lost-reply-input");
    const transport = c.host as unknown as { settle(id: string, result: Result<unknown>): void }, original = transport.settle.bind(transport);
    transport.settle = (id, result) => { if (id !== "drop-accepted-reply" || !result.ok) original(id, result); };
    const reply = await c.host.request("session.submit", input, "original-lost", "drop-accepted-reply");
    expect(reply).toMatchObject({ ok: false, error: { code: "operation_result_unknown", operationRef: "original-lost" } });
    const saved = sendResult(unwrap(await c.host.request("session.readSubmission", { sessionId: a.session.id, clientSequence: input.clientSequence })));
    const messagePage = SessionMessagePageSchema.parse(unwrap(await c.host.request("session.messages.read", { sessionId: a.session.id })));
    expect(messagePage.items.find(item => item.displayRole === "user")).toMatchObject({ text: "lost-reply-input", runId: saved.runId, inputId: saved.inputId });
    expect(ReadRunResultSchema.parse(unwrap(await c.host.request("run.read", { runId: saved.runId })))).toMatchObject({ kind: "one", run: { id: saved.runId, sessionId: a.session.id } });
    expect(c.service.requests).toHaveLength(1);
    expect(unwrap(await c.host.request("session.submit", input, "original-lost"))).toEqual(saved); expect(c.service.requests).toHaveLength(1);
    transport.settle = original;
  } finally { await c.close(); }
}, 30000);

test("message reads keep session, workspace, run and provider facts unchanged through the Host", async () => {
  const c = await setup();
  try {
    const a = await c.create(), input = await c.input(a.session.id, "saved message"), accepted = sendResult(unwrap(await c.host.request("session.submit", input, "message-read-run"))); await c.idle();
    const b = await c.create(), before = await c.workspace(), native = SessionDetailSchema.parse(unwrap(await c.host.request("session.read", { sessionId: a.session.id })));
    const db = new Database(c.host.paths.databasePath, { readonly: true });
    try {
      const snapshot = () => ({ sessions: db.query("SELECT * FROM sessions").all(), runs: db.query("SELECT * FROM runs").all(), calls: db.query("SELECT * FROM model_calls").all(), tools: db.query("SELECT * FROM tool_calls").all(), queries: db.query("SELECT * FROM queries").all(), answers: db.query("SELECT * FROM answers").all(), migrations: db.query("SELECT * FROM schema_migrations").all() });
      const facts = snapshot();
      const page = SessionMessagePageSchema.parse(unwrap(await c.host.request("session.messages.read", { sessionId: a.session.id })));
      expect(page).toMatchObject({ sessionId: a.session.id, nativeSessionId: a.session.nativeSessionId, leafId: native.session.leafId, source: "native_memory", hasMore: false });
      expect(page.items.filter(item => item.displayRole === "user")).toMatchObject([{ text: "saved message", runId: accepted.runId, inputId: accepted.inputId }]);
      expect(await c.host.request("session.messages.read", { sessionId: b.session.id })).toMatchObject({ ok: true, data: { items: [], leafId: null } });
      expect(await c.host.request("session.messages.read", { sessionId: 999 })).toMatchObject({ ok: false, error: { code: "input_invalid", reason: "session_not_found" } });
      expect(await c.host.request("session.readSubmission", { sessionId: 999, clientSequence: 1 })).toMatchObject({ ok: false, error: { code: "input_invalid", reason: "session_not_found" } });
      expect(await c.workspace()).toEqual(before); expect(SessionDetailSchema.parse(unwrap(await c.host.request("session.read", { sessionId: a.session.id }))).session.leafId).toBe(native.session.leafId);
      expect(snapshot()).toEqual(facts); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]); expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" }); expect(c.host.read().schemaVersion).toBe(DATABASE_SCHEMA_VERSION); expect(c.service.requests).toHaveLength(1);
    } finally { db.close(); }
  } finally { await c.close(); }
}, 30000);

test("readonly missing-table faults stay storage errors, never null lookup or empty idle control", async () => {
  const c = await setup();
  try {
    const a = await c.create(); expect(await c.host.request("session.readSubmission", { sessionId: a.session.id, clientSequence: 1 })).toEqual({ ok: true, data: null });
    const obstruction = new Database(c.host.paths.databasePath); // Isolated fault injection, not a product writer.
    try { obstruction.exec("DROP TABLE runs"); } finally { obstruction.close(); }
    expect(await c.host.request("session.readSubmission", { sessionId: a.session.id, clientSequence: 1 })).toMatchObject({ ok: false, error: { code: "storage_read_failed" } });
    expect(await c.host.request("session.messages.read", { sessionId: a.session.id })).toMatchObject({ ok: false, error: { code: "storage_read_failed" } });
    expect(await c.host.request("run.control.read", {})).toMatchObject({ ok: false, error: { code: "storage_read_failed" } });
    expect(c.service.requests).toHaveLength(0);
  } finally { await c.close(); }
}, 30000);

test("confirmed Host interruption settles queued and consumed inputs without replay or changing prior terminal facts", async () => {
  const c = await setup("slow");
  try {
    const a = await c.create();
    const prior = sendResult(unwrap(await c.host.request("session.submit", await c.input(a.session.id, "prior-terminal"), "prior-terminal")));
    await c.service.requested;
    const priorFollow: SubmitInput = { ...await c.input(a.session.id, 'prior-removed-follow-up'), mode: 'follow_up', targetRunId: prior.runId };
    const priorQueued = SubmitResultSchema.parse(unwrap(await c.host.request('session.submit', priorFollow, 'prior-removed-follow-up')));
    expect(priorQueued.runId).toBeNull();
    if (priorQueued.inputId === null) throw new Error('Prior queued input must have its accepted identity');
    expect(await c.host.request("run.cancel", { runId: prior.runId })).toMatchObject({ ok: true, data: { stopped: true } }); await c.idle();
    const terminalInput = SessionInputSchema.parse(unwrap(await c.host.request("session.readInput", { inputId: prior.inputId })));
    expect(terminalInput.status).toBe('consumed'); expect(terminalInput.processingStatus).toBe('cancelled'); expect(terminalInput.processedAt).not.toBeNull();
    const terminalRemoved = SessionInputSchema.parse(unwrap(await c.host.request('session.readInput', { inputId: priorQueued.inputId })));
    expect(terminalRemoved).toMatchObject({ status: 'cancelled', processingStatus: 'cancelled', runId: null, nativeEntryId: null }); expect(terminalRemoved.processedAt).not.toBeNull();
    const terminalRun = ReadRunResultSchema.parse(unwrap(await c.host.request("run.read", { runId: prior.runId })));
    if (terminalRun.kind !== 'one' || terminalRun.run === null) throw new Error('Prior terminal Run must exist');
    const accepted = sendResult(unwrap(await c.host.request("session.submit", await c.input(a.session.id, "interrupted-agent"), "interrupted")));
    await until(() => c.service.requests.length === 2);
    const follow: SubmitInput = { ...await c.input(a.session.id, "interrupted-follow-up"), mode: 'follow_up', targetRunId: accepted.runId };
    const queued = SubmitResultSchema.parse(unwrap(await c.host.request("session.submit", follow, "interrupted-follow-up")));
    expect(queued.runId).toBeNull(); expect(queued.inputId !== null).toBe(true);
    if (queued.inputId === null) throw new Error('Queued acceptance must have an input identity');
    const consumedBefore = SessionInputSchema.parse(unwrap(await c.host.request('session.readInput', { inputId: accepted.inputId })));
    const queuedBefore = SessionInputSchema.parse(unwrap(await c.host.request('session.readInput', { inputId: queued.inputId })));
    expect(consumedBefore).toMatchObject({ status: 'consumed', processingStatus: 'pending', runId: accepted.runId, processedAt: null });
    expect(consumedBefore.nativeEntryId).not.toBeNull();
    expect(queuedBefore).toMatchObject({ status: 'queued', processingStatus: 'pending', targetRunId: accepted.runId, runId: null, nativeEntryId: null, processedAt: null });
    expect(queuedBefore.deliveredAt).not.toBeNull();
    const old = c.host.read().instanceId!;
    const child = (c.host as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const exited = new Promise<void>(resolve => child.once("close", resolve)); expect(child.kill("SIGKILL")).toBe(true); await exited;
    expect(await c.host.restart(old)).toMatchObject({ state: "ready", error: null }); await c.idle();
    expect(c.host.read().instanceId).not.toBe(old);
    expect(ReadRunResultSchema.parse(unwrap(await c.host.request("run.read", { runId: accepted.runId })))).toMatchObject({ kind: "one", run: { status: "failed", instanceId: old,
      stoppedAt: null, error: { code: "runtime_interrupted", reason: "host_interrupted" }, cleanup: { executionStarted: null, stopConfirmed: true, inputsSettled: true, resourcesReleased: true, unconfirmedItems: [] },
      calls: [{ state: "started", endedAt: null, sdkStopReason: null, inputTokens: null, outputTokens: null }] } });
    const consumedAfter = SessionInputSchema.parse(unwrap(await c.host.request('session.readInput', { sessionId: a.session.id, clientSequence: accepted.clientSequence })));
    const queuedAfter = SessionInputSchema.parse(unwrap(await c.host.request('session.readInput', { inputId: queued.inputId })));
    expect(consumedAfter).toMatchObject({ id: accepted.inputId, status: 'consumed', processingStatus: 'failed', runId: accepted.runId, nativeEntryId: consumedBefore.nativeEntryId });
    expect(consumedAfter.processedAt).not.toBeNull();
    expect(queuedAfter).toMatchObject({ id: queued.inputId, status: 'delivery_unknown', processingStatus: 'failed', targetRunId: accepted.runId, runId: null, nativeEntryId: null, deliveredAt: queuedBefore.deliveredAt });
    expect(queuedAfter.processedAt).not.toBeNull();
    expect(SessionInputSchema.parse(unwrap(await c.host.request('session.readInput', { inputId: prior.inputId })))).toEqual(terminalInput);
    expect(SessionInputSchema.parse(unwrap(await c.host.request('session.readInput', { inputId: priorQueued.inputId })))).toEqual(terminalRemoved);
    const priorAfter = ReadRunResultSchema.parse(unwrap(await c.host.request('run.read', { runId: prior.runId })));
    if (priorAfter.kind !== 'one' || priorAfter.run === null) throw new Error('Prior terminal Run must survive restart');
    expect({ status: priorAfter.run.status, endedAt: priorAfter.run.endedAt, error: priorAfter.run.error }).toEqual({ status: terminalRun.run.status, endedAt: terminalRun.run.endedAt, error: terminalRun.run.error });
    const page = SessionInputPageSchema.parse(unwrap(await c.host.request('session.listInputs', { sessionId: a.session.id })));
    expect(page.items.map(input => [input.id, input.status, input.processingStatus])).toEqual([[prior.inputId, 'consumed', 'cancelled'], [priorQueued.inputId, 'cancelled', 'cancelled'], [accepted.inputId, 'consumed', 'failed'], [queued.inputId, 'delivery_unknown', 'failed']]);
    expect(unwrap(await c.host.request('session.readSubmission', { sessionId: a.session.id, clientSequence: follow.clientSequence }))).toEqual(queued);
    expect(unwrap(await c.host.request('session.submit', follow, 'interrupted-follow-up'))).toEqual(queued);
    expect(SessionDetailSchema.parse(unwrap(await c.host.request('session.read', { sessionId: a.session.id })))).toMatchObject({ history: { available: false, reason: 'host_restart', messages: [] } });
    expect(await c.host.request('session.submit', await c.input(a.session.id, 'cannot resume interrupted source'), 'new-after-interruption')).toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
    const db = new Database(c.host.paths.databasePath, { readonly: true });
    try { expect(db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 2 }); expect(db.query('SELECT COUNT(*) AS n FROM model_calls').get()).toEqual({ n: 2 }); expect(db.query('SELECT COUNT(*) AS n FROM session_inputs').get()).toEqual({ n: 4 }); }
    finally { db.close(); }
    expect(c.service.requests).toHaveLength(2);
  } finally { await c.close(); }
}, 30000);
