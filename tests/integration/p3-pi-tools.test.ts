import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { RunScopeSchema } from "../../packages/contracts/src/run";
import { safeError } from "../../packages/contracts/src/error";
import type { AnyToolDefinition, ToolCallRecord, ToolCallStore, ToolExecutionContext, ToolExecutionMode, ToolResult } from "../../packages/contracts/src/tool";
import { PiModelRuntime } from "../../packages/runtime-pi/src/model-runtime";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
const InputSchema = RunScopeSchema.pick({ readOnly: true });
const OutputSchema = RunScopeSchema.pick({ batchIds: true });
const key = (context: ToolExecutionContext) => `${context.runId}/${context.sessionId}/${context.nativeToolCallId}`;

// Only the persistence boundary is a fixture: Registry, Executor, Recorder and Pi are real.
class CallStore implements ToolCallStore {
  readonly calls = new Map<string, ToolCallRecord>();
  rejectDelivery = false;
  assertContext(context: ToolExecutionContext) {
    if (context.runId !== 41 || context.sessionId !== 7 || context.scope.batchIds[0] !== 13) throw safeError("access_denied");
  }
  request(tool: AnyToolDefinition, input: unknown, context: ToolExecutionContext) {
    this.assertContext(context);
    const previous = this.readCall(context);
    if (previous) {
      if (previous.name !== tool.name || JSON.stringify(previous.input) !== JSON.stringify(input)) throw safeError("state_conflict");
      return previous;
    }
    const call: ToolCallRecord = { id: this.calls.size + 1, runId: context.runId, sessionId: context.sessionId,
      nativeToolCallId: context.nativeToolCallId, name: tool.name, version: tool.version, executionMode: tool.executionMode,
      input: structuredClone(input), status: "requested", data: null, error: null, sdkReturned: false, nativeEntryId: null };
    this.calls.set(key(context), call); return call;
  }
  readCall(context: ToolExecutionContext) { return this.calls.get(key(context)) ?? null; }
  transition(id: number, from: ToolCallRecord["status"], to: ToolCallRecord["status"], result?: ToolResult<unknown>) {
    const call = [...this.calls.values()].find(call => call.id === id);
    if (!call || call.status !== from) throw safeError("state_conflict");
    call.status = to;
    if (result) { call.data = result.data ?? null; call.error = result.status === "succeeded" ? null : result.error; }
    return call;
  }
  recordDelivery(context: ToolExecutionContext, nativeEntryId: string) {
    if (this.rejectDelivery) throw safeError("storage_write_failed");
    const call = this.readCall(context);
    if (!call || call.status === "requested" || call.status === "running") throw safeError("state_conflict");
    if (call.sdkReturned) { if (call.nativeEntryId !== nativeEntryId) throw safeError("state_conflict"); return; }
    call.sdkReturned = true; call.nativeEntryId = nativeEntryId;
  }
}

function providerFixture(names: string[], args: unknown, repeatCalls: boolean) {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>; requests.push(body);
    const encoder = new TextEncoder();
    const chunks = requests.length === 1 || repeatCalls && requests.length === 3
      ? [{ id: "fixture", model: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: names.map((name, index) => ({
          index, id: `call-${index + 1}`, type: "function", function: { name, arguments: JSON.stringify(args) },
        })) }, finish_reason: "tool_calls" }] }]
      : [{ id: "fixture", model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "verified" }, finish_reason: "stop" }] }];
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  return { requests, url: `http://127.0.0.1:${server.port}/v1`, close: () => server.stop(true) };
}

async function setup(modes: ToolExecutionMode[], execute?: (context: ToolExecutionContext) => Promise<void>, args: unknown = { readOnly: true }, repeatCalls = false) {
  const adapter = await import("../../packages/runtime-pi/src/pi-tool-adapter").catch(() => null);
  expect(adapter).not.toBeNull(); if (!adapter) throw new Error("P3 Pi tool adapter is missing");
  const { ToolRegistry } = await import("../../packages/core/src/tools/registry");
  const { ToolExecutor } = await import("../../packages/core/src/tools/executor");
  const { ToolRecorder } = await import("../../packages/core/src/tools/recorder");
  let abortSession: (() => void) | undefined;
  const store = new CallStore(), recorder = new ToolRecorder(store, () => abortSession?.()), contexts: ToolExecutionContext[] = [];
  let active = 0, maximumActive = 0;
  const order: string[] = [];
  const definitions: AnyToolDefinition[] = modes.map((executionMode, index) => ({ name: `scope_${index + 1}`, label: `Scope ${index + 1}`,
    description: "Read the permitted batch identities.", version: "1.0.0", effect: "READ", executionMode, inputSchema: InputSchema,
    outputSchema: OutputSchema, async execute(input, context) {
      InputSchema.parse(input); contexts.push(context); order.push(`start:${index + 1}`); active++; maximumActive = Math.max(maximumActive, active);
      try { if (execute) await execute(context); else await new Promise(resolve => setTimeout(resolve, 15)); return { batchIds: context.scope.batchIds }; }
      finally { active--; order.push(`end:${index + 1}`); }
    } }));
  const registry = new ToolRegistry(definitions), executor = new ToolExecutor(registry, recorder), abort = new AbortController();
  const getContext = (nativeToolCallId: string, signal?: AbortSignal): ToolExecutionContext => ({ runId: 41, sessionId: 7, nativeToolCallId,
    scope: { batchIds: [13], deviceIds: null, allowedToolNames: definitions.map(tool => tool.name), allowedResourceRefs: [], artifactIds: [], readOnly: true },
    referenceDate: "2026-01-01", timezone: "Asia/Shanghai", signal: signal ? AbortSignal.any([abort.signal, signal]) : abort.signal });
  const root = await mkdtemp(join(tmpdir(), "medclaw-p3-pi-")), fixture = providerFixture(definitions.map(tool => tool.name), args, repeatCalls);
  closers.push(async () => { fixture.close(); await rm(root, { recursive: true, force: true }); });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("p3-fixture", async () => ({ type: "api_key", key: "fixture-only" }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  await runtime.installCustom([{ providerId: "p3-fixture", name: "Fixture", api: "openai-completions", baseUrl: fixture.url,
    models: [{ id: "fixture", name: "fixture", input: ["text"], reasoning: false, contextWindow: 32768, maxTokens: 1024,
      outputLimitConfirmed: true, pricingKnown: false, cost: null }] }]);
  const resolved = await runtime.resolve({ provider: "p3-fixture", modelId: "fixture", expectedConfigVersion: "1" }, "1", null,
    { timeoutMs: 5000, maxRetries: 0, maxRetryDelayMs: 2000 });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", defaultTools: [],
    packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false, enableInstallTelemetry: false });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "pi"), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Use the provided data tools." });
  await resourceLoader.reload();
  const piTools = adapter.createPiToolDefinitions(registry, executor, getContext);
  const { session } = await createAgentSession({ cwd: root, agentDir: join(root, "pi"), modelRuntime: runtime.native, model: resolved.model,
    thinkingLevel: "off", tools: definitions.map(tool => tool.name), customTools: piTools,
    settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) });
  abortSession = () => { void session.abort(); };
  const unsubscribe = adapter.observePiToolDelivery(session, registry, recorder, getContext);
  closers.unshift(async () => { await session.abort(); await session.waitForIdle(); unsubscribe(); session.dispose(); });
  return { session, store, fixture, contexts, order, abort, piTools, getContext, get maximumActive() { return maximumActive; } };
}

test("Pi executes adapted parallel tools and records only real SDK result delivery", async () => {
  const c = await setup(["parallel", "parallel"]);
  await c.session.prompt("Read both scopes.");
  expect(c.maximumActive).toBe(2);
  expect(c.fixture.requests).toHaveLength(2);
  const messages = c.fixture.requests[1]!.messages as { role: string; content: string }[];
  expect(messages.filter(message => message.role === "tool").map(message => message.content)).toEqual(['{"batchIds":[13]}', '{"batchIds":[13]}']);
  expect(c.contexts.map(context => [context.runId, context.sessionId, context.referenceDate, context.timezone]))
    .toEqual([[41, 7, "2026-01-01", "Asia/Shanghai"], [41, 7, "2026-01-01", "Asia/Shanghai"]]);
  for (const record of c.store.calls.values()) {
    expect(record).toMatchObject({ status: "succeeded", sdkReturned: true, data: { batchIds: [13] } });
    expect(record.nativeEntryId).not.toBeNull();
    expect(c.session.sessionManager.getEntry(record.nativeEntryId!)).toMatchObject({ type: "message",
      message: { role: "toolResult", toolCallId: record.nativeToolCallId } });
  }
});

test("an adapted sequential tool serializes the whole mixed Pi tool batch", async () => {
  const c = await setup(["parallel", "sequential"]);
  await c.session.prompt("Read both scopes.");
  expect(c.maximumActive).toBe(1);
  expect(c.order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  expect([...c.store.calls.values()].map(call => call.executionMode)).toEqual(["parallel", "sequential"]);
});

test("Pi global sequential mode overrides adapted parallel declarations", async () => {
  const c = await setup(["parallel", "parallel"]);
  c.session.agent.toolExecution = "sequential";
  await c.session.prompt("Read both scopes.");
  expect(c.maximumActive).toBe(1);
  expect(c.order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  expect([...c.store.calls.values()].map(call => call.executionMode)).toEqual(["parallel", "parallel"]);
});

test("returning from execute is not recorded as SDK delivery", async () => {
  const c = await setup(["parallel"]);
  await c.piTools[0]!.execute("direct-call", { readOnly: true }, c.abort.signal, undefined, {} as never);
  expect(c.store.readCall(c.getContext("direct-call"))).toMatchObject({ status: "succeeded", sdkReturned: false, nativeEntryId: null });
  expect(c.fixture.requests).toHaveLength(0);
});

test("delivery persistence failure preserves execution success and stops the next model request", async () => {
  const c = await setup(["parallel"]); c.store.rejectDelivery = true;
  await c.session.prompt("Read the scope.");
  expect([...c.store.calls.values()]).toMatchObject([{ status: "succeeded", sdkReturned: false, nativeEntryId: null }]);
  expect(c.fixture.requests).toHaveLength(1);
});

test("Pi cancellation reaches the original tool context without a fabricated successful result", async () => {
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const c = await setup(["parallel"], async context => {
    started(); context.signal.throwIfAborted();
    await new Promise<never>((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
  });
  const prompt = c.session.prompt("Read the scope.");
  await entered; await c.session.abort(); await prompt;
  expect(c.contexts[0]!.signal.aborted).toBe(true);
  expect([...c.store.calls.values()]).toMatchObject([{ status: "cancelled", data: null }]);
  expect(c.fixture.requests).toHaveLength(1);
});

test("SDK schema rejection is recorded as a failed attempt without executing business code", async () => {
  const c = await setup(["parallel"], undefined, { readOnly: true, runId: 999 });
  await c.session.prompt("Read the scope.");
  expect(c.contexts).toHaveLength(0);
  expect([...c.store.calls.values()]).toMatchObject([{ status: "failed", input: { readOnly: true, runId: 999 },
    error: { code: "tool_input_invalid" }, sdkReturned: true }]);
});

test("SDK delivery with a reused ID and different tool cannot acknowledge the original call", async () => {
  const c = await setup(["sequential", "sequential"]);
  await c.piTools[0]!.execute("call-2", { readOnly: true }, c.abort.signal, undefined, {} as never);
  await c.session.prompt("Read both scopes.");
  expect(c.store.readCall(c.getContext("call-2"))).toMatchObject({ name: "scope_1", status: "succeeded", sdkReturned: false, nativeEntryId: null });
  expect(c.fixture.requests).toHaveLength(1);
});

test("SDK delivery with a reused ID and changed arguments cannot acknowledge the original result", async () => {
  const c = await setup(["parallel"]);
  await c.piTools[0]!.execute("call-1", { readOnly: false }, c.abort.signal, undefined, {} as never);
  await c.session.prompt("Read the scope.");
  expect(c.store.readCall(c.getContext("call-1"))).toMatchObject({ status: "succeeded", input: { readOnly: false }, sdkReturned: false, nativeEntryId: null });
  expect(c.fixture.requests).toHaveLength(1);
});

test("Pi replays an already delivered call without executing again or replacing its first receipt", async () => {
  const c = await setup(["parallel"], undefined, { readOnly: true }, true);
  await c.session.prompt("Read the scope.");
  const original = structuredClone(c.store.readCall(c.getContext("call-1"))!);
  await c.session.prompt("Read the same scope again.");
  expect(c.contexts).toHaveLength(1);
  expect(c.store.readCall(c.getContext("call-1"))).toEqual(original);
  expect(c.fixture.requests).toHaveLength(4);
  expect(c.session.sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(2);
});

test("a parameter conflict cannot acknowledge an original failure with the same error code", async () => {
  const c = await setup(["parallel"], async () => { throw safeError("state_conflict"); });
  await expect(c.piTools[0]!.execute("call-1", { readOnly: false }, c.abort.signal, undefined, {} as never)).rejects.toThrow("state_conflict");
  await c.session.prompt("Read the scope.");
  expect(c.store.readCall(c.getContext("call-1"))).toMatchObject({ status: "failed", error: { code: "state_conflict" }, input: { readOnly: false }, sdkReturned: false, nativeEntryId: null });
  expect(c.contexts).toHaveLength(1);
  expect(c.fixture.requests).toHaveLength(1);
});
