import { sqliteHistory } from '../fixtures/p9-memory';
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/storage/src/database";
import { Repositories } from "../../packages/storage/src/repositories";
import type { SessionDetail, SubmitInput, SubmitResult, InputSettlementProof } from "../../packages/contracts/src/session";
import type { Result } from "../../packages/contracts/src/error";
import { safeError } from "../../packages/contracts/src/error";
import type { RunHandle } from "../../packages/contracts/src/run";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { PiModelRuntime } from "../../packages/runtime-pi/src/model-runtime";
import { PiAgentRuntime } from "../../packages/runtime-pi/src/agent-runtime";
import { ModelCallRecorder } from "../../packages/runtime-pi/src/model-call-recorder";
import { Application } from "../../packages/core/src/application";
import { SessionService } from "../../packages/core/src/session/session-service";
import { PublishedSettingsSchema, type CredentialScope } from "../../packages/contracts/src/model";
import type { RuntimeNotice } from "../../packages/contracts/src/protocol";
import type { AgentExecutionObservation } from "../../packages/contracts/src/run";
import { providerFixture } from "../fixtures/p1-provider";

const roots: string[] = [], handles: Database[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const shutdowns: (() => Promise<void>)[] = [];
afterEach(async () => { for (const shutdown of shutdowns.splice(0)) await shutdown(); });
async function setup(beforeCommit?: () => void) {
  const modules = await Promise.all([
    import("../../packages/core/src/session/session-service").catch(() => null),
    import("../../packages/core/src/workspace/workspace-service").catch(() => null),
  ]);
  expect(modules[0]).not.toBeNull(); expect(modules[1]).not.toBeNull();
  if (!modules[0] || !modules[1]) throw new Error("P2 Session/Workspace services are missing");
  const root = mkdtempSync(join(tmpdir(), "medclaw-p2-services-")); roots.push(root);
  const db = openDatabase(join(root, "db.sqlite")); handles.push(db);
  const repo = new Repositories(db, beforeCommit, undefined, undefined, sqliteHistory(db).store);
  const previews = new Map<number, SessionDetail["history"] & { leafId: string | null }>();
  let allocated = 0, discarded = 0, delegated = 0, active: RunHandle | null = null;
  const bindings = {
    allocate: () => {
      allocated++; const nativeSessionId = `native-${allocated}`;
      return { nativeSessionId, history:{header:{type:'session',version:3,id:nativeSessionId,timestamp:new Date().toISOString(),cwd:root},entries:[],activeLeafId:null}, bind: (sessionId: number) => previews.set(sessionId, { available: true, reason: null, leafId: null, messages: [], truncated: false }),
        discard: () => { discarded++; } };
    },
    read: async (sessionId: number) => ({...(previews.get(sessionId) ?? { available: false, reason: "host_restart" as const, leafId: null, messages: [], truncated: false }),storageVersion:1}),
    readMessages: async () => { throw new Error("Unexpected fixture message read"); },
    ensureLoaded:async()=>{},restore:async()=>{},readAvailability:()=>({availability:'ready' as const,error:null}),
  };
  const delegate = async (_input: SubmitInput): Promise<Result<SubmitResult>> => { delegated++; return { ok: false, error: safeError("state_conflict", undefined, { reason: "runtime_busy" }) }; };
  const service = new modules[0].SessionService("host-1", repo, bindings, delegate, () => active);
  const workspace = new modules[1].WorkspaceService(repo);
  return { db, repo, service, workspace, previews, stats: () => ({ allocated, discarded, delegated }), setActive: (value: RunHandle | null) => { active = value; } };
}
function context(operationRef: string) { return { instanceId: "host-1", operationRef }; }
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }

test("create commits and binds once; original create replay cannot reselect A over B", async () => {
  const c = await setup(), a = unwrap(await c.service.create({ expectedWorkspaceRevision: 0 }, context("create-a")));
  const b = unwrap(await c.service.create({ expectedWorkspaceRevision: 1 }, context("create-b")));
  expect(c.stats()).toEqual({ allocated: 2, discarded: 0, delegated: 0 });
  expect(unwrap(await c.service.create({ selectOnCreate: true, expectedWorkspaceRevision: 0 }, context("create-a")))).toEqual(a);
  expect(unwrap(await c.workspace.read())).toEqual(b.workspace); expect(c.stats().allocated).toBe(2);
  expect(await c.service.create({ expectedWorkspaceRevision: 2 }, context("create-a"))).toMatchObject({ ok: false, error: { code: "state_conflict" } });
});

test("commit failure discards unpublished manager and storage failure is explicit", async () => {
  const c = await setup(() => { throw new Error("injected transaction failure"); });
  expect(await c.service.create({ expectedWorkspaceRevision: 0 }, context("create-a"))).toMatchObject({ ok: false, error: { code: "storage_write_failed" } });
  expect(c.stats()).toEqual({ allocated: 1, discarded: 1, delegated: 0 });
  expect(c.repo.listSessions({}).sessions).toEqual([]); expect(unwrap(await c.workspace.read()).revision).toBe(0);
});

test("selection CAS can browse B while A runs without creating execution or another manager", async () => {
  const c = await setup(), a = unwrap(await c.service.create({ expectedWorkspaceRevision: 0 }, context("create-a")));
  const b = unwrap(await c.service.create({ expectedWorkspaceRevision: 1 }, context("create-b")));
  c.setActive({ runId: 7, kind: "agent", sessionId: a.session.id });
  const selected = unwrap(await c.service.select({ sessionId: b.session.id, expectedWorkspaceRevision: 2 }));
  expect(selected.revision).toBe(2);
  expect(unwrap(await c.service.read(a.session.id)).runningRunId).toBe(7);
  expect(unwrap(await c.service.read(b.session.id)).runningRunId).toBeNull();
  expect(unwrap(await c.service.read(b.session.id)).currentQueryContext).toBeNull();
  expect(await c.service.select({ sessionId: a.session.id, expectedWorkspaceRevision: 1 })).toMatchObject({ ok: false, error: { code: "state_conflict", reason: "workspace_revision_mismatch" } });
  expect(await c.service.select({ sessionId: 999, expectedWorkspaceRevision: 2 })).toMatchObject({ ok: false, error: { code: "input_invalid", reason: "session_not_found" } });
  expect(c.stats()).toEqual({ allocated: 2, discarded: 0, delegated: 0 });
});

test("metadata survives absent native binding and readonly restore/read never invents history", async () => {
  const c = await setup(), created = unwrap(await c.service.create({ expectedWorkspaceRevision: 0 }, context("create-a")));
  c.previews.clear(); const before = c.db.query("SELECT * FROM sessions").all();
  const read = unwrap(await c.service.read(created.session.id));
  expect(read.session.nativeSessionId).toBe(created.session.nativeSessionId);
  expect(read.history).toEqual({ available: false, reason: "host_restart", messages: [], truncated: false });
  expect(read.currentQueryContext).toBeNull();
  expect(unwrap(await c.workspace.restore())).toEqual(created.workspace); expect(unwrap(await c.service.list({})).sessions).toHaveLength(1);
  expect(c.db.query("SELECT * FROM sessions").all()).toEqual(before); expect(c.stats().allocated).toBe(1);
  expect(await c.service.read(999)).toMatchObject({ ok: false, error: { code: "input_invalid", reason: "session_not_found" } });
});

test("submit delegates new admission to the sole runtime; invalid trusted context never reaches it", async () => {
  const c = await setup(), created = unwrap(await c.service.create({ expectedWorkspaceRevision: 0 }, context("create-a")));
  const input: SubmitInput = { sessionId: created.session.id, clientSequence: 1, text: "hello", mode: "send", expectedRevision: 1, expectedBatchIds: [],
    expectedQueryId: null, model: { provider: "test", modelId: "text", expectedConfigVersion: "1" }, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" };
  expect(await c.service.submit(input, context("submit-a"))).toMatchObject({ ok: false, error: { reason: "runtime_busy" } });
  expect(c.stats().delegated).toBe(1);
  expect(await c.service.submit(input, { ...context("submit-a"), instanceId: "old-host" })).toMatchObject({ ok: false, error: { code: "host_protocol_mismatch" } });
  expect(c.stats().delegated).toBe(1); expect(unwrap(await c.service.readSubmission({ sessionId: created.session.id, clientSequence: 1 }))).toBeNull();
});

test("Workspace storage read failure cannot become an empty successful restore", async () => {
  const c = await setup(); c.db.exec("DROP TABLE workspace");
  expect(await c.workspace.read()).toMatchObject({ ok: false, error: { code: "storage_read_failed" } });
  expect(await c.workspace.restore()).toMatchObject({ ok: false, error: { code: "storage_read_failed" } });
});

test("accepted original submit is returned before runtime admission even after Workspace changes", async () => {
  const c = await setup(), created = unwrap(await c.service.create({ expectedWorkspaceRevision: 0 }, context("create-a")));
  const input: SubmitInput = { sessionId: created.session.id, clientSequence: 1, text: "  original😀\n", mode: "send", expectedRevision: 1,
    expectedBatchIds: [], expectedQueryId: null, model: { provider: "test", modelId: "text", expectedConfigVersion: "1" }, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" };
  const policy = { timeoutMs: 1000, maxRetries: 0 as const, maxRetryDelayMs: 2000 };
  const accepted = c.repo.registerAgent({ sessionId: input.sessionId, inputId: null, text: input.text, goal: "answer", policy,
    model: { provider: "test", modelId: "text", endpointRef: null, api: "openai-completions", configVersion: "1", credentialRef: null, maxOutputTokens: 1024, capabilitySource: "pi_catalog", sdkVersion: "0.87.1" },
    workspace: created.workspace, scope: { batchIds: [], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true },
    referenceDate: input.referenceDate, timezone: input.timezone, timeoutMs: policy.timeoutMs, agentOptions: { requestedThinkingLevel: "off", effectiveThinkingLevel: "off" },
    submission: { operationRef: "submit-a", originalSubmitInput: input }, instanceId: "host-1", createdAt: "2026-10-01T00:00:00.000Z" });
  unwrap(await c.service.create({ expectedWorkspaceRevision: 1 }, context("create-b")));
  expect(unwrap(await c.service.submit(input, context("submit-a")))).toEqual(accepted);
  expect(unwrap(await c.service.readSubmission({ sessionId: input.sessionId, clientSequence: 1 }))).toEqual(accepted);
  expect(await c.service.submit({ ...input, text: "changed" }, context("submit-a"))).toMatchObject({ ok: false, error: { code: "state_conflict" } });
  expect(c.stats().delegated).toBe(0);
});

function requireSend(result: SubmitResult) {
  if (result.inputId === null || result.runId === null) throw new Error("Expected current Send to create a real Input and root Run");
  return { ...result, inputId: result.inputId, runId: result.runId };
}
function closedInputSource(runId: number): InputSettlementProof {
  return { runId, admissionClosed: true, preflightSettled: true, nativeIdle: true, nativeQueuesEmpty: true,
    pendingPersistence: false, removals: [], unconfirmedInputIds: [] };
}

async function runtimeSetup(mode: Parameters<typeof providerFixture>[0] = "success", beforeCommit?: () => void, credentialScope: CredentialScope = (_context, action) => action()) {
  const root = mkdtempSync(join(tmpdir(), "medclaw-p2-app-"));
  const fixture = providerFixture(mode), db = openDatabase(join(root, "db.sqlite")), repo = new Repositories(db, beforeCommit,undefined,undefined,sqliteHistory(db).store);
  const credentials = new InMemoryCredentialStore(); await credentials.modify("p2-fixture", async () => ({ type: "api_key", key: "fixture-only" }));
  const modelRuntime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  const definition = { providerId: "p2-fixture", name: "Fixture", api: "openai-completions", baseUrl: fixture.url,
    models: [{ id: "fixture", name: "Fixture", input: ["text" as const], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true as const, pricingKnown: false, cost: null }] };
  await modelRuntime.installCustom([definition]);
  const settings = PublishedSettingsSchema.parse({ schemaVersion: "medclaw.settings/p1-v1", configVersion: "1", model: { provider: "p2-fixture", modelId: "fixture" },
    customProviders: [{ definition, credentialRef: null }], credentialRefs: {}, requestPolicy: { timeoutMs: 1000, maxRetries: 0, maxRetryDelayMs: 2000 },
    ui: { navCollapsed: false, detailOpen: false, detailTab: "conditions" }, previous: null, rollbackFromVersion: null });
  const adapter = new PiAgentRuntime(modelRuntime, root, sqliteHistory(db)), notices: RuntimeNotice[] = [];
  const app = new Application("host-1", settings, modelRuntime, repo, credentialScope,
    (runId, kind, time) => new ModelCallRecorder(repo, runId, kind, time), notice => notices.push(notice), undefined, adapter);
  shutdowns.push(async () => { try { await app.shutdown(); } finally { db.close(); fixture.close(); rmSync(root, { recursive: true, force: true }); } });
  expect(app.runs).toBeDefined();
  const sessions = new SessionService("host-1", repo, adapter, (input, context) => app.runs.submitAgent(input, context), () => app.runs.activeHandle);
  async function create(op: string = crypto.randomUUID()) { return unwrap(await sessions.create({ expectedWorkspaceRevision: repo.readWorkspace().revision }, context(op))); }
  function input(sessionId: number, text = "hello"): SubmitInput {
    return { sessionId, clientSequence: repo.readSession(sessionId)!.nextSubmissionSequence, text, mode: "send", expectedRevision: repo.readWorkspace().revision,
      expectedBatchIds: [], expectedQueryId: null, model: { provider: "p2-fixture", modelId: "fixture", expectedConfigVersion: app.config.configVersion }, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" };
  }
  const command = { requestId: "provider-request", instanceId: "host-1", operationRef: "provider-operation",
    payload: { text: "provider hello", model: { provider: "p2-fixture", modelId: "fixture", expectedConfigVersion: "1" }, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" } };
  return { app, adapter, repo, db, fixture, modelRuntime, notices, sessions, settings, create, input, command };
}
async function until(test: () => boolean, timeout = 4000) { const end = Date.now() + timeout; while (!test()) { if (Date.now() > end) throw new Error("condition timed out"); await Bun.sleep(10); } }

test("Provider and Agent share one root; browsing B and Stop keep A execution identity", async () => {
  const c = await runtimeSetup("slow"), a = await c.create("a"), b = await c.create("b");
  unwrap(await c.sessions.select({ sessionId: a.session.id, expectedWorkspaceRevision: 2 }));
  const original = c.input(a.session.id, "A-only"), accepted = requireSend(unwrap(await c.sessions.submit(original, context("send-a")))); await c.fixture.requested;
  unwrap(await c.sessions.select({ sessionId: b.session.id, expectedWorkspaceRevision: 3 }));
  expect(await c.sessions.submit(c.input(b.session.id, "B-draft"), context("send-b"))).toMatchObject({ ok: false, error: { code: "state_conflict", reason: "runtime_busy" } });
  await expect(c.app.submitProvider(c.command)).rejects.toThrow("runtime_busy");
  expect(unwrap(await c.app.runs.readControl())).toMatchObject({ activeRootRun: { runId: accepted.runId, sessionId: a.session.id, kind: "agent" }, acceptingNewRuns: false });
  expect(unwrap(await c.sessions.submit(original, context("send-a")))).toEqual(accepted);
  expect(unwrap(await c.app.runs.cancel(accepted.runId)).stopped).toBe(true);
  await until(() => !c.app.busy); expect(c.fixture.requests).toHaveLength(1);
  expect(c.repo.read({ runId: accepted.runId })).toMatchObject({ kind: "one", run: { sessionId: a.session.id, status: "cancelled", cleanup: { stopConfirmed: true, requiredPersistenceComplete: true, resourcesReleased: true } } });
  expect(unwrap(await c.app.runs.readControl()).acceptingNewRuns).toBe(true);
});

test("async model admission reserves the root with no fake RunHandle and only one resolve", async () => {
  const c = await runtimeSetup(), a = await c.create();
  const original = c.modelRuntime.resolve.bind(c.modelRuntime); let release!: () => void, entered!: () => void, resolves = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), resolving = new Promise<void>(resolve => { entered = resolve; });
  c.modelRuntime.resolve = async (...args) => { resolves++; entered(); await gate; return original(...args); };
  const request = c.input(a.session.id), pending = c.sessions.submit(request, context("first")); await resolving;
  try {
    expect(unwrap(await c.app.runs.readControl())).toMatchObject({ activeRootRun: null, acceptingNewRuns: false });
    expect(await c.sessions.submit(request, context("first"))).toMatchObject({ ok: false, error: { code: "operation_result_unknown" } });
    expect(await c.sessions.submit({ ...request, clientSequence: 2 }, context("second"))).toMatchObject({ ok: false, error: { reason: "runtime_busy" } });
    expect(resolves).toBe(1); expect(c.db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
  } finally { release(); }
  unwrap(await pending); await until(() => !c.app.busy); expect(c.fixture.requests).toHaveLength(1);
});

test("Agent save failure blocks new Run and retrySave persists the original fact without another request", async () => {
  let fail = false; const c = await runtimeSetup("slow", () => { if (fail) throw new Error("save fixture"); }), a = await c.create();
  const accepted = requireSend(unwrap(await c.sessions.submit(c.input(a.session.id), context("send")))); await c.fixture.requested; fail = true;
  const cancelled = unwrap(await c.app.runs.cancel(accepted.runId)); expect(cancelled).toMatchObject({ stopped: true, persistencePending: true });
  expect(unwrap(await c.app.runs.readControl())).toMatchObject({ acceptingNewRuns: false, activeRootRun: { runId: accepted.runId } });
  expect(await c.sessions.submit(c.input(a.session.id), context("next"))).toMatchObject({ ok: false, error: { reason: "runtime_busy" } });
  fail = false; expect(unwrap(await c.app.runs.retrySave(accepted.runId)).status).toBe("cancelled");
  expect(c.fixture.requests).toHaveLength(1); expect(unwrap(await c.app.runs.readControl()).acceptingNewRuns).toBe(true);
});

test("known deadline failure remains occupied until actual stop; late cleanup preserves first endedAt", async () => {
  const c = await runtimeSetup(), a = await c.create(); let release!: (value: AgentExecutionObservation) => void, observedAbort = false;
  const pending = new Promise<AgentExecutionObservation>(resolve => { release = resolve; });
  let recorder: ReturnType<Parameters<typeof c.adapter.execute>[1]["startCall"]> | undefined;
  c.adapter.execute = async (input, callbacks) => {
    if (input.inputId == null || !callbacks.inputStore) throw new Error("Expected Input persistence port");
    const at = new Date().toISOString();
    callbacks.inputStore.recordInputDelivery(input.inputId, at);
    callbacks.inputStore.recordInputConsumption(input.inputId, { sessionId: input.sessionId, runId: input.runId, nativeEntryId: "controlled-input", at });
    recorder = callbacks.startCall(at);
    input.signal.addEventListener("abort", () => { observedAbort = true; });
    return pending;
  };
  const accepted = requireSend(unwrap(await c.sessions.submit(c.input(a.session.id), context("delayed-stop"))));
  try {
    await until(() => observedAbort); const failed = c.repo.read({ runId: accepted.runId });
    expect(failed).toMatchObject({ kind: "one", run: { status: "failed", stoppedAt: null, error: { code: "run_timeout" }, calls: [{ state: "started", endedAt: null }], cleanup: { stopConfirmed: false } } });
    expect(c.repo.readInput({ inputId: accepted.inputId })).toMatchObject({ status: "consumed", processingStatus: "pending", runId: accepted.runId });
    const endedAt = failed.kind === "one" ? failed.run!.endedAt : null;
    expect(c.repo.active()).toBeNull(); expect(unwrap(await c.app.runs.readControl()).acceptingNewRuns).toBe(false);
    expect(await c.sessions.submit(c.input(a.session.id), context("blocked"))).toMatchObject({ ok: false, error: { reason: "runtime_busy" } });
    expect(unwrap(await c.app.runs.cancel(accepted.runId))).toMatchObject({ stopped: false, committedStatus: "failed" });
    const outcome = { sdkStopReason: "aborted" as const, text: "", responseModel: null, callState: "cancelled" as const, error: null,
      usage: { inputTokens: null, outputTokens: null, cost: null, costCurrency: null, source: null, unavailableReason: "controlled_unknown" } };
    release({ nativeIdle: true, lastOutcome: outcome, calls: [recorder!.finish(outcome, new Date().toISOString())], inputSettlement: closedInputSource(accepted.runId) });
    await until(() => !c.app.busy);
    expect(c.repo.read({ runId: accepted.runId })).toMatchObject({ kind: "one", run: { status: "failed", error: { code: "run_timeout" }, endedAt,
      cleanup: { stopConfirmed: true, resourcesReleased: true, unconfirmedItems: [] } } });
    expect(c.repo.readInput({ inputId: accepted.inputId })).toMatchObject({ status: "consumed", processingStatus: "failed", runId: accepted.runId });
  } finally { release({ nativeIdle: true, lastOutcome: null, calls: [], inputSettlement: closedInputSource(accepted.runId) }); }
}, 12000);

test("normal native completion latch survives Stop while final save is pending", async () => {
  let fail = false;
  const c = await runtimeSetup("success", () => { if (fail) throw new Error("final save fault"); }), a = await c.create();
  const finalize = c.repo.finalizeAgent.bind(c.repo);
  c.repo.finalizeAgent = (...args) => { fail = true; return finalize(...args); };
  const accepted = requireSend(unwrap(await c.sessions.submit(c.input(a.session.id), context("success"))));
  await until(() => c.notices.some(n => n.type === "agent.persistence_failed"));
  expect(unwrap(await c.app.runs.cancel(accepted.runId))).toMatchObject({ cancelRequested: false, stopped: true, persistencePending: true });
  c.repo.finalizeAgent = finalize; fail = false; expect(unwrap(await c.app.runs.retrySave(accepted.runId))).toMatchObject({ status: "completed", cancelRequestedAt: null });
  expect(c.fixture.requests).toHaveLength(1);
});

test("old cancelled cleanup gap blocks with empty active view and ordinary control reads never repair", async () => {
  let writes = 0; const c = await runtimeSetup("success", () => { writes++; }), a = await c.create();
  const accepted = requireSend(unwrap(await c.sessions.submit(c.input(a.session.id), context("old")))); await until(() => !c.app.busy);
  c.db.query("UPDATE runs SET instance_id='old-host',status='cancelled',cancel_requested_at=created_at,cleanup_json=json_set(cleanup_json,'$.stopConfirmed',0,'$.resourcesReleased',0,'$.unconfirmedItems',json('[\"stop\",\"resources\"]')) WHERE id=?").run(accepted.runId);
  const before = c.db.query("SELECT status,error_json,ended_at,input_text,output_text FROM runs WHERE id=?").get(accepted.runId), count = writes;
  const control = unwrap(await c.app.runs.readControl()); expect(control).toMatchObject({ activeRootRun: null, acceptingNewRuns: false });
  expect(writes).toBe(count); expect(await c.app.runs.retrySave(accepted.runId)).toMatchObject({ ok: false, error: { code: "run_save_unavailable" } });
  c.app.runs.recoverInterrupted(true);
  expect(unwrap(await c.app.runs.readControl()).acceptingNewRuns).toBe(true);
  expect(c.db.query("SELECT status,error_json,ended_at,input_text,output_text FROM runs WHERE id=?").get(accepted.runId)).toEqual(before);
  expect(c.fixture.requests).toHaveLength(1);
});

test("model/auth validation fails before Agent acceptance, not as a fallback run", async () => {
  const c = await runtimeSetup(), a = await c.create(), input = c.input(a.session.id);
  expect(await c.sessions.submit({ ...input, model: { ...input.model, modelId: "missing" } }, context("bad-model"))).toMatchObject({ ok: false, error: { code: "model_not_found" } });
  expect(c.db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 }); expect(c.fixture.requests).toHaveLength(0);
  expect(unwrap(await c.app.runs.readControl()).acceptingNewRuns).toBe(true);
});

test("final COMMIT with a lost return is confirmed from the original durable facts without another execution", async () => {
  const c = await runtimeSetup(), a = await c.create(), finalize = c.repo.finalizeAgent.bind(c.repo);
  c.repo.finalizeAgent = (...args) => { finalize(...args); throw new Error("reply lost after COMMIT"); };
  const accepted = requireSend(unwrap(await c.sessions.submit(c.input(a.session.id), context("commit-unknown"))));
  try {
    await until(() => c.notices.some(n => n.type === "agent.settled" || n.type === "agent.persistence_failed"));
    expect(c.app.persistencePending).toBe(false);
    expect(unwrap(await c.app.runs.readControl()).acceptingNewRuns).toBe(true);
    expect(c.notices.filter(n => n.type === "agent.settled")).toHaveLength(1);
    expect(c.fixture.requests).toHaveLength(1);
    expect(c.repo.read({ runId: accepted.runId })).toMatchObject({ kind: "one", run: { status: "completed", calls: [{ state: "completed" }] } });
  } finally { c.repo.finalizeAgent = finalize; if (c.app.persistencePending) unwrap(await c.app.runs.retrySave(accepted.runId)); }
});

test("cancel before native entry has no call or invented stoppedAt", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const c = await runtimeSetup("success", undefined, async (_context, action) => { entered(); await gate; return action(); }), a = await c.create();
  const accepted = requireSend(unwrap(await c.sessions.submit(c.input(a.session.id), context("early-stop")))); await ready;
  c.app.runs.cancelNow(accepted.runId); release(); await until(() => !c.app.busy);
  expect(c.repo.read({ runId: accepted.runId })).toMatchObject({ kind: "one", run: { status: "cancelled", stoppedAt: null, calls: [],
    cleanup: { executionStarted: false, stopConfirmed: true, resourcesReleased: true } } });
  expect(unwrap(await c.app.runs.cancel(accepted.runId)).stopped).toBe(true);
  expect(c.fixture.requests).toHaveLength(0);
});

test("credential scope failure before native entry closes an accepted zero-call Run safely", async () => {
  const c = await runtimeSetup("success", undefined, async () => { throw new Error("credential_read_failed"); }), a = await c.create();
  const accepted = requireSend(unwrap(await c.sessions.submit(c.input(a.session.id), context("scope-failed"))));
  await until(() => c.notices.some(n => n.type === "agent.settled") || c.repo.read({ runId: accepted.runId }).kind === "one" && !c.app.runs.stopPending);
  expect(c.repo.read({ runId: accepted.runId })).toMatchObject({ kind: "one", run: { status: "failed", stoppedAt: null, calls: [],
    error: { code: "credential_read_failed" }, cleanup: { executionStarted: false, stopConfirmed: true } } });
  expect(unwrap(await c.app.runs.readControl()).acceptingNewRuns).toBe(true);
  expect(c.fixture.requests).toHaveLength(0);
});

test("control read failure is an error and never an empty idle success or repair", async () => {
  let writes = 0; const c = await runtimeSetup("success", () => { writes++; }), a = await c.create(), before = writes;
  const active = c.repo.active.bind(c.repo); c.repo.active = () => { throw new Error("read fixture"); };
  try { expect(await c.app.runs.readControl()).toMatchObject({ ok: false, error: { code: "storage_read_failed" } }); expect(writes).toBe(before); }
  finally { c.repo.active = active; }
  expect(c.fixture.requests).toHaveLength(0); expect(unwrap(await c.sessions.read(a.session.id)).history.available).toBe(true);
});

for (const status of ["failed", "cancelled", "completed"] as const) test(`Host recovery only supplements ${status} cleanup; failed save keeps admission blocked`, async () => {
  let fail = false, savingCleanup = false;
  const c = await runtimeSetup("success", () => { if (fail && savingCleanup) throw new Error("recovery save fixture"); }), a = await c.create();
  const saveCleanup = c.repo.saveRunCleanup.bind(c.repo);
  c.repo.saveRunCleanup = (...args) => {
    savingCleanup = true;
    try { return saveCleanup(...args); } finally { savingCleanup = false; }
  };
  const accepted = requireSend(unwrap(await c.sessions.submit(c.input(a.session.id), context(`old-${status}`)))); await until(() => !c.app.busy);
  c.db.query("UPDATE runs SET instance_id='old-host',status=?,error_json=?,cancel_requested_at=?,cleanup_json=json_set(cleanup_json,'$.stopConfirmed',0,'$.resourcesReleased',0,'$.unconfirmedItems',json('[\"stop\",\"resources\"]')) WHERE id=?")
    .run(status, status === "failed" ? JSON.stringify(safeError("run_timeout")) : null, status === "cancelled" ? "2026-10-01T00:00:00.000Z" : null, accepted.runId);
  const facts = () => c.db.query("SELECT status,error_json,ended_at,stopped_at,input_text,output_text,usage_json FROM runs WHERE id=?").get(accepted.runId);
  const before = facts(), calls = c.db.query("SELECT * FROM model_calls WHERE run_id=?").all(accepted.runId);
  const originalInput = c.repo.readInput({ inputId: accepted.inputId });
  fail = true; c.app.runs.recoverInterrupted(true);
  expect(unwrap(await c.app.runs.readControl())).toMatchObject({ activeRootRun: null, acceptingNewRuns: false });
  expect(await c.sessions.submit(c.input(a.session.id), context("blocked-next"))).toMatchObject({ ok: false, error: { reason: "runtime_busy" } });
  fail = false; unwrap(await c.app.runs.retrySave(accepted.runId));
  expect(facts()).toEqual(before); expect(c.db.query("SELECT * FROM model_calls WHERE run_id=?").all(accepted.runId)).toEqual(calls);
  expect(c.repo.readInput({ inputId: accepted.inputId })).toEqual(originalInput);
  expect(unwrap(await c.app.runs.readControl()).acceptingNewRuns).toBe(true); expect(c.fixture.requests).toHaveLength(1);
});
