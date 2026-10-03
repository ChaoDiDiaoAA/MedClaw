import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { PiModelRuntime } from "../../packages/runtime-pi/src/model-runtime";
import { BridgeCredentialStore } from "../../packages/runtime-pi/src/credential-store";
import { privateCredentialMethodSchemas } from "../../packages/contracts/src/protocol";
import { ModelCallRecorder } from "../../packages/runtime-pi/src/model-call-recorder";
import { openDatabase } from "../../packages/storage/src/database";
import { Repositories } from "../../packages/storage/src/repositories";
import { providerFixture } from "../fixtures/p1-provider";
import type { ProviderOutcome } from "../../packages/contracts/src/run";
import type { SubmitInput } from "../../packages/contracts/src/session";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

test("overlapping native model snapshots stay within private credential capacity and read fresh original contexts", async () => {
  let inFlight = 0, highWater = 0, overflows = 0, available = true;
  const reads: { providerId: string; operationRef: string }[] = [];
  const credentials = new BridgeCredentialStore(async (method, payload) => {
    if (method === "credential.list") return [];
    if (method !== "credential.read") throw new Error("Unexpected credential mutation in model snapshot");
    const input = privateCredentialMethodSchemas["credential.read"].input.parse(payload);
    reads.push({ providerId: input.providerId, operationRef: input.context.operationRef });
    inFlight++; highWater = Math.max(highWater, inFlight);
    try {
      if (inFlight > 256) { overflows++; throw new Error("runtime_busy"); }
      await Bun.sleep(2);
      return input.providerId === "p2-snapshot" && available ? { type: "api_key", key: "fixture-only" } : null;
    } finally { inFlight--; }
  });
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  await runtime.installCustom([{ providerId: "p2-snapshot", name: "Snapshot fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1",
    models: [{ id: "snapshot", name: "Snapshot", input: ["text"], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] }]);
  reads.length = 0; highWater = 0; overflows = 0;
  const operations = Array.from({ length: 8 }, (_, index) => `snapshot-${index}`);
  const directories = await Promise.all(operations.map(operationRef => credentials.withContext({ purpose: "runtime", operationRef }, () => runtime.directory("1"))));
  expect(reads.length).toBeGreaterThan(256);
  expect(overflows).toBe(0);
  expect(highWater).toBeLessThanOrEqual(256);
  expect(inFlight).toBe(0);
  expect([...new Set(reads.map(read => read.operationRef))].sort()).toEqual(operations);
  for (const directory of directories) {
    expect(directory.providers.some(provider => provider.auth.state === "sync_unknown")).toBe(false);
    expect(directory.providers.find(provider => provider.id === "p2-snapshot")?.auth.state).toBe("available");
  }
  for (const operationRef of operations) expect(reads.some(read => read.operationRef === operationRef && read.providerId === "p2-snapshot")).toBe(true);
  available = false;
  const later = await credentials.withContext({ purpose: "runtime", operationRef: "snapshot-after-credential-change" }, () => runtime.directory("2"));
  expect(later.configVersion).toBe("2");
  expect(later.providers.find(provider => provider.id === "p2-snapshot")?.auth.state).toBe("unavailable");
  expect(reads.some(read => read.operationRef === "snapshot-after-credential-change" && read.providerId === "p2-snapshot")).toBe(true);
  expect(inFlight).toBe(0);
});

test("native catalog registration overlapping model snapshots cannot overflow private credential reads", async () => {
  let inFlight = 0, highWater = 0, overflows = 0;
  const contexts = new Set<string>();
  const credentials = new BridgeCredentialStore(async (method, payload) => {
    if (method === "credential.list") return [];
    if (method !== "credential.read") throw new Error("Unexpected credential mutation in catalog refresh");
    const input = privateCredentialMethodSchemas["credential.read"].input.parse(payload);
    contexts.add(input.context.operationRef);
    inFlight++; highWater = Math.max(highWater, inFlight);
    try {
      if (inFlight > 256) { overflows++; throw new Error("runtime_busy"); }
      await Bun.sleep(2);
      return input.providerId.startsWith("p2-catalog-") ? { type: "api_key", key: "fixture-only" } : null;
    } finally { inFlight--; }
  });
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  highWater = 0; overflows = 0; contexts.clear();
  const definitions = Array.from({ length: 20 }, (_, index) => ({ providerId: `p2-catalog-${index}`, name: "Catalog fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1",
    models: [{ id: "catalog", name: "Catalog", input: ["text" as const], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true as const, pricingKnown: false, cost: null }] }));
  const operations = Array.from({ length: 8 }, (_, index) => `catalog-snapshot-${index}`);
  const outcomes = await Promise.allSettled([runtime.installCustom(definitions), ...operations.map(operationRef => credentials.withContext({ purpose: "runtime", operationRef }, () => runtime.directory("1")))]);
  expect(overflows).toBe(0);
  expect(highWater).toBeLessThanOrEqual(256);
  expect(inFlight).toBe(0);
  expect(outcomes.every(outcome => outcome.status === "fulfilled")).toBe(true);
  for (const operationRef of operations) expect(contexts.has(operationRef)).toBe(true);
  const after = await runtime.directory("2");
  expect(after.providers.some(provider => provider.auth.state === "sync_unknown")).toBe(false);
  for (const definition of definitions) expect(after.providers.find(provider => provider.id === definition.providerId)?.auth.state).toBe("available");
});

test("queued credential reads abort without frames while leases bypass read pressure and failed reads release admission", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls: { method: string; providerId?: string; operationRef?: string }[] = [];
  const credentials = new BridgeCredentialStore(async (method, payload) => {
    if (method === "credential.read") {
      const input = privateCredentialMethodSchemas["credential.read"].input.parse(payload);
      calls.push({ method, providerId: input.providerId, operationRef: input.context.operationRef });
      if (input.providerId === "p2-failed") throw new Error("fixture read failed");
      await held; return null;
    }
    calls.push({ method });
    if (method === "credential.modify.begin") return { leaseId: "fixture-lease", version: "1", current: null };
    if (method === "credential.modify.commit" || method === "credential.modify.abort") return null;
    throw new Error("Unexpected private credential method");
  });
  const blockers = Array.from({ length: 256 }, (_, index) => credentials.withContext({ purpose: "runtime", operationRef: `held-read-${index}` }, () => credentials.read("p2-held")));
  try {
    await Bun.sleep(0);
    const abort = new AbortController();
    const cancelled = credentials.withContext({ purpose: "runtime", operationRef: "queued-aborted-read" }, () => credentials.read("p2-aborted", { signal: abort.signal })).then(() => "completed", () => "aborted");
    await Bun.sleep(0); abort.abort();
    expect(await Promise.race([cancelled, Bun.sleep(100).then(() => "still waiting")])).toBe("aborted");
    expect(calls.some(call => call.providerId === "p2-aborted")).toBe(false);
    await credentials.modify("p2-lease", async () => undefined);
    await expect(credentials.modify("p2-lease", async () => { throw new Error("fixture callback cancelled"); })).rejects.toThrow("fixture callback cancelled");
    expect(calls.filter(call => call.method !== "credential.read").map(call => call.method)).toEqual(["credential.modify.begin", "credential.modify.commit", "credential.modify.begin", "credential.modify.abort"]);
  } finally { release(); await Promise.allSettled(blockers); }
  const failedReads = Promise.allSettled(Array.from({ length: 256 }, () => credentials.read("p2-failed"))).then(results => results.filter(result => result.status === "rejected").length);
  expect(await Promise.race([failedReads, Bun.sleep(100).then(() => "leaked read slots")])).toBe(256);
  expect(await credentials.withContext({ purpose: "runtime", operationRef: "after-read-failure" }, () => credentials.read("p2-released"))).toBeUndefined();
  expect(calls.filter(call => call.providerId === "p2-held").map(call => call.operationRef)).toEqual(Array.from({ length: 256 }, (_, index) => `held-read-${index}`));
  expect(calls.find(call => call.providerId === "p2-released")?.operationRef).toBe("after-read-failure");
});

async function setup(mode: Parameters<typeof providerFixture>[0] = "success") {
  const module = await import("../../packages/runtime-pi/src/agent-runtime").catch(() => null);
  expect(module).not.toBeNull(); if (!module) throw new Error("P2 native adapter is missing");
  const root = await mkdtemp(join(tmpdir(), "medclaw-p2-native-")), fixture = providerFixture(mode);
  const db = openDatabase(join(root, "db.sqlite")), repo = new Repositories(db), credentials = new InMemoryCredentialStore();
  await credentials.modify("p2-fixture", async () => ({ type: "api_key", key: "fixture-only" }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  await runtime.installCustom([{ providerId: "p2-fixture", name: "Fixture", api: "openai-completions", baseUrl: fixture.url,
    models: ["fixture", "other"].map(id => ({ id, name: id, input: ["text"], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null })) }]);
  const adapter = new module.PiAgentRuntime(runtime, root);
  closers.push(async () => { db.close(); fixture.close(); await rm(root, { recursive: true, force: true }); });
  function create() {
    const native = adapter.allocate(), created = repo.createSession({ expectedWorkspaceRevision: repo.readWorkspace().revision }, crypto.randomUUID(), native.nativeSessionId, new Date().toISOString());
    native.bind(created.session.id); return created.session;
  }
  async function run(sessionId: number, text: string, modelId = "fixture", signal = new AbortController().signal, maxRetries: 0 | 1 = 0) {
    const workspace = repo.selectSession({ sessionId, expectedWorkspaceRevision: repo.readWorkspace().revision }, new Date().toISOString());
    const policy = { timeoutMs: 10000, maxRetries, maxRetryDelayMs: 2000 }, model = { provider: "p2-fixture", modelId, expectedConfigVersion: "1" };
    const resolved = await runtime.resolve(model, "1", null, policy), agentOptions = adapter.describe(resolved);
    const input: SubmitInput = { sessionId, clientSequence: repo.readSession(sessionId)!.nextSubmissionSequence, text, mode: "send", expectedRevision: workspace.revision,
      expectedBatchIds: [], expectedQueryId: null, model, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" };
    const { runId } = repo.registerAgent({ sessionId, inputId: null, text, model: resolved.selection, policy, goal: "answer", workspace,
      scope: { batchIds: [], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true },
      referenceDate: input.referenceDate, timezone: input.timezone, timeoutMs: policy.timeoutMs, agentOptions,
      submission: { operationRef: crypto.randomUUID(), originalSubmitInput: input }, instanceId: "host-1", createdAt: new Date().toISOString() });
    const previews: string[] = [], terminals: ProviderOutcome[] = [];
    const observed = await adapter.execute({ runId, sessionId, text, resolved, agentOptions, signal, deadlineAt: performance.now() + policy.timeoutMs }, {
      startCall: time => new ModelCallRecorder(repo, runId, "main", time), preview: text => previews.push(text), nativeTerminal: outcome => terminals.push(outcome),
    });
    const endedAt = new Date().toISOString(), status = signal.aborted ? "cancelled" : observed.lastOutcome?.error ? "failed" : "completed";
    if (signal.aborted) repo.requestCancel(runId, endedAt);
    repo.finalizeAgent(runId, { status, outputText: observed.lastOutcome?.text ?? null, stoppedAt: endedAt, endedAt,
      error: status === "failed" ? observed.lastOutcome?.error ?? null : null, calls: observed.calls,
      cleanup: { contract: "medclaw.run-cleanup/v1", executionStarted: observed.calls.length > 0, stopConfirmed: true,
        requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: true, unconfirmedItems: [], secondaryErrors: [], verifiedAt: endedAt } });
    return { runId, observed, previews, terminals, resolved };
  }
  return { root, fixture, db, repo, credentials, runtime, adapter, create, run };
}

test("actual native A→B→A requests preserve A history and never include B history", async () => {
  const c = await setup(), a = c.create(), b = c.create();
  expect(a.nativeSessionId).not.toBe(b.nativeSessionId);
  await c.run(a.id, "A-only-first"); await c.run(b.id, "B-only-first"); await c.run(a.id, "A-only-second");
  const requests = c.fixture.requests.map(r => JSON.stringify(r.body.messages));
  expect(requests[0]).toContain("A-only-first"); expect(requests[1]).not.toContain("A-only-first");
  expect(requests[2]).toContain("A-only-first"); expect(requests[2]).toContain("A-only-second"); expect(requests[2]).not.toContain("B-only-first");
  const aMessages = c.adapter.read(a.id).messages, bMessages = c.adapter.read(b.id).messages;
  expect(aMessages.filter(m => m.role === "user").map(m => m.text)).toEqual(["A-only-first", "A-only-second"]);
  expect(bMessages.filter(m => m.role === "user").map(m => m.text)).toEqual(["B-only-first"]);
  expect(new Set([...aMessages, ...bMessages].map(m => m.nativeEntryId)).size).toBe(aMessages.length + bMessages.length);
});

test("switching A model preserves its native history and leaves B model/history intact", async () => {
  const c = await setup(), a = c.create(), b = c.create();
  await c.run(a.id, "A-first"); await c.run(b.id, "B-first"); const beforeB = c.adapter.read(b.id);
  await c.run(a.id, "A-other-model", "other"); expect(c.adapter.read(b.id)).toEqual(beforeB);
  await c.run(b.id, "B-second");
  expect(c.fixture.requests.map(r => r.body.model)).toEqual(["fixture", "fixture", "other", "fixture"]);
  expect(JSON.stringify(c.fixture.requests[2]!.body.messages)).toContain("A-first");
  expect(JSON.stringify(c.fixture.requests[3]!.body.messages)).not.toContain("A-other-model");
});

test("explicit empty tools/resources ignore local AGENTS, skills and extensions", async () => {
  const c = await setup(); await mkdir(join(c.root, ".pi/extensions"), { recursive: true });
  await mkdir(join(c.root, ".pi/skills/canary"), { recursive: true });
  await writeFile(join(c.root, "AGENTS.md"), "RESOURCE-CANARY instructions");
  await writeFile(join(c.root, ".pi/skills/canary/SKILL.md"), "---\nname: canary\ndescription: RESOURCE-CANARY\n---\nRESOURCE-CANARY");
  await writeFile(join(c.root, ".pi/extensions/canary.ts"), 'throw new Error("RESOURCE-CANARY extension loaded")');
  const a = c.create(); await c.run(a.id, "/skill:canary original text");
  expect(c.fixture.requests).toHaveLength(1); expect(c.fixture.requests[0]!.body.tools ?? []).toEqual([]);
  expect(JSON.stringify(c.fixture.requests[0]!.body.messages)).not.toContain("RESOURCE-CANARY");
  expect(JSON.stringify(c.fixture.requests[0]!.body.messages)).toContain("/skill:canary original text");
});

test("native HTTP retry remains one logical model call and outcomes omit raw provider secrets", async () => {
  const c = await setup("retry"), a = c.create(), result = await c.run(a.id, "retry", "fixture", undefined, 1);
  expect(c.fixture.requests).toHaveLength(2); expect(result.observed.calls).toHaveLength(1);
  expect(c.repo.read({ runId: result.runId })).toMatchObject({ kind: "one", run: { calls: [{ attempt: 1, granularity: "logical_request", attemptCountUnknown: true }] } });
  expect(result.observed.lastOutcome?.usage.cost).toBeNull();
});

test("cancellation awaits native idle and records the real logical-call outcome", async () => {
  const c = await setup("slow"), a = c.create(), abort = new AbortController(), pending = c.run(a.id, "stop-me", "fixture", abort.signal);
  await c.fixture.requested; abort.abort(); const result = await pending;
  expect(result.observed.nativeIdle).toBe(true); expect(result.observed.calls).toHaveLength(1);
  expect(result.observed.calls[0]?.sdkStopReason).toBe("aborted"); expect(result.observed.calls[0]?.state).toBe("cancelled");
  expect(result.terminals).toHaveLength(1); expect(c.fixture.requests).toHaveLength(1);
});

test("full user input remains in native history/request while basic preview is bounded", async () => {
  const c = await setup(), a = c.create(), text = "器械😀".repeat(30000); await c.run(a.id, text);
  expect(JSON.stringify(c.fixture.requests[0]!.body.messages)).toContain(text);
  const user = c.adapter.read(a.id).messages.find(m => m.role === "user");
  expect(user).toMatchObject({ totalChars: text.length, truncated: true }); expect(user!.text.length).toBeLessThanOrEqual(8192);
});

test("a new Host adapter cannot silently recreate an old native history", async () => {
  const c = await setup(), a = c.create(); await c.run(a.id, "old history");
  const module = await import("../../packages/runtime-pi/src/agent-runtime"), restarted = new module.PiAgentRuntime(c.runtime, c.root);
  expect(restarted.read(a.id)).toEqual({ available: false, reason: "host_restart", leafId: null, messages: [], truncated: false });
  expect(c.repo.readSession(a.id)?.nativeSessionId).toBe(a.nativeSessionId);
  expect(c.fixture.requests).toHaveLength(1);
});

test("SDK error responses yield honest usage and only fixed product errors", async () => {
  const c = await setup("unauthorized"), a = c.create(), result = await c.run(a.id, "error");
  expect(result.observed.nativeIdle).toBe(true); expect(result.observed.calls).toHaveLength(1);
  expect(result.observed.calls[0]).toMatchObject({ state: "failed", sdkStopReason: "error", inputTokens: null, cost: null, error: { code: "provider_request_failed" } });
  expect(JSON.stringify([result.observed, c.adapter.read(a.id), c.repo.read({ runId: result.runId })])).not.toContain("fixture-secret-do-not-project");
  expect(c.fixture.requests).toHaveLength(1);
});

test("unexpected tool response aborts instead of running tools or another model turn", async () => {
  const c = await setup("tool"), a = c.create(), result = await c.run(a.id, "no tools");
  expect(c.fixture.requests).toHaveLength(1); expect(result.observed.calls).toHaveLength(1);
  expect(result.observed.lastOutcome?.error?.code).toBe("agent_response_unsupported");
  expect(c.adapter.read(a.id).reason).toBe("native_state_invalid");
});

test("a native stream setup exception still closes the registered logical call without invented SDK outcome", async () => {
  const c = await setup(), a = c.create();
  c.runtime.native.streamSimple = () => { throw new Error("fixture-private-native-error"); };
  const result = await c.run(a.id, "stream setup error");
  expect(c.fixture.requests).toHaveLength(0); expect(result.observed.calls).toHaveLength(1);
  expect(result.observed.calls[0]).toMatchObject({ state: "failed", sdkStopReason: null, inputTokens: null, cost: null });
  expect(JSON.stringify(result.observed)).not.toContain("fixture-private-native-error");
});
