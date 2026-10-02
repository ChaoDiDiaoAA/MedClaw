import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { RunScopeSchema } from "../../packages/contracts/src/run";
import { safeError } from "../../packages/contracts/src/error";
import type { AnyToolDefinition, ToolCallRecord, ToolCallStore, ToolExecutionContext, ToolExecutionMode, ToolResult, ToolSdkDelivery } from "../../packages/contracts/src/tool";
import { PiModelRuntime } from "../../packages/runtime-pi/src/model-runtime";
import { DEFAULT_AGENT_POLICY, type ToolControlObservation } from '../../packages/contracts/src/model';
import { RunControl } from '../../packages/core/src/runtime/run-control';
import { performance } from 'node:perf_hooks';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
const InputSchema = RunScopeSchema.pick({ readOnly: true }).extend({ readOnly: RunScopeSchema.shape.readOnly.default(true) });
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
  mergeControl(context: ToolExecutionContext, control: Partial<ToolControlObservation>) {
    const call = this.readCall(context);
    if (call) call.control = { ...(call.control ?? {}), ...control } as ToolControlObservation;
    if (!call) throw new Error('tool_not_found');
    return call;
  }
  transition(id: number, from: ToolCallRecord["status"], to: ToolCallRecord["status"], result?: ToolResult<unknown>) {
    const call = [...this.calls.values()].find(call => call.id === id);
    if (!call || call.status !== from) throw safeError("state_conflict");
    call.status = to;
    if (result) { call.data = result.data ?? null; call.error = result.status === "succeeded" ? null : result.error; }
    return call;
  }
  recordDelivery(context: ToolExecutionContext, nativeEntryId: string, message?: ToolSdkDelivery) {
    if (this.rejectDelivery) throw safeError("storage_write_failed");
    const call = this.readCall(context);
    if (!call || call.status === "requested" || call.status === "running") throw safeError("state_conflict");
    if (call.sdkReturned) { if (call.nativeEntryId !== nativeEntryId) throw safeError("state_conflict"); return; }
    call.sdkReturned = true; call.nativeEntryId = nativeEntryId;
    if (message) call.sdkDelivery = structuredClone(message);
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

async function setup(modes: ToolExecutionMode[], execute?: (context: ToolExecutionContext) => Promise<void>, args: unknown = { readOnly: true }, repeatCalls = false, controlled = false, installHooks?: (session: AgentSession) => void, emittedNames?: string[]) {
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
  const root = await mkdtemp(join(tmpdir(), "medclaw-p3-pi-")), fixture = providerFixture(emittedNames ?? definitions.map(tool => tool.name), args, repeatCalls);
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
  const control = controlled ? new RunControl({ runId: 41, policy: DEFAULT_AGENT_POLICY, scope: getContext('call-1').scope,
    signal: abort.signal, deadlineAt: performance.now() + 10000, totalTimeoutMs: 10000 }) : undefined;
  const piTools = adapter.createPiToolDefinitions(registry, executor, getContext, () => control);
  const { session } = await createAgentSession({ cwd: root, agentDir: join(root, "pi"), modelRuntime: runtime.native, model: resolved.model,
    thinkingLevel: "off", tools: definitions.map(tool => tool.name), customTools: piTools,
    settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) });
  abortSession = () => { void session.abort(); };
  installHooks?.(session);
  const unsubscribe = adapter.observePiToolDelivery(session, registry, recorder, getContext, () => control);
  const unsubscribeControl = control ? adapter.createPiRunControlBinding(session, registry, recorder, getContext, () => control)() : () => {};
  closers.unshift(async () => { await session.abort(); await session.waitForIdle(); unsubscribe(); unsubscribeControl(); session.dispose(); });
  return { session, store, recorder, registry, adapter, fixture, contexts, order, abort, piTools, getContext, control, get maximumActive() { return maximumActive; } };
}

test('SDK-prepared input and business defaults share one controlled execution identity', async () => {
  const c = await setup(['parallel'], undefined, {}, false, true);
  await c.session.prompt('Read the scope.');
  expect(c.contexts).toHaveLength(1);
  expect([...c.store.calls.values()]).toMatchObject([{ status: 'succeeded', input: { readOnly: true }, sdkReturned: true }]);
  expect(c.control!.summary().toolCalls).toBe(1);
});

test('after Hook failure retains original execution success and delivers its real error for correction', async () => {
  const c = await setup(['parallel'], undefined, {}, false, true, session => {
    session.agent.afterToolCall = async () => { throw new Error('fixture after failure'); };
  });
    c.control!.admitModelCall();
    await c.session.prompt('Read the scope.');
    expect(c.contexts).toHaveLength(1);
    expect([...c.store.calls.values()]).toMatchObject([{ status: 'succeeded', data: { batchIds: [13] }, sdkReturned: true,
      control: { postflightStatus: 'failed', hookFailure: { stage: 'afterToolCall', code: 'tool_postprocess_failed' } } }]);
    expect(c.fixture.requests).toHaveLength(2);
    expect(JSON.stringify(c.fixture.requests[1]!.messages)).toContain('tool_postprocess_failed');
});

test('original before rejection skips execution and after while retaining its real diagnosis', async () => {
  let afterCalls = 0;
  const c = await setup(['parallel'], undefined, {}, false, true, session => {
    session.agent.beforeToolCall = async () => ({ block: true, reason: 'fixture refusal' });
    session.agent.afterToolCall = async () => { afterCalls++; };
  });
  await c.session.prompt('Read the scope.');
  expect(c.contexts).toHaveLength(0);
  expect(afterCalls).toBe(0);
  expect(c.control!.summary().toolCalls).toBe(1);
  expect([...c.store.calls.values()]).toMatchObject([{ status: 'failed', error: { code: 'access_denied' }, sdkReturned: true,
    control: { preflightStatus: 'blocked', postflightStatus: 'not_reached', executionElapsedMs: null } }]);
});

test('shared admission rejects only the over-budget attempt in a parallel SDK batch', async () => {
  const c = await setup(Array.from({ length: 25 }, () => 'parallel' as const), undefined, {}, false, true);
  await c.session.prompt('Read all scopes.');
  expect(c.contexts).toHaveLength(24);
  expect(c.control!.summary()).toMatchObject({ toolCalls: 25, toolAdmissionsRejected: 1 });
  expect(c.store.readCall(c.getContext('call-25'))).toMatchObject({ status: 'failed', error: { code: 'tool_call_limit' }, sdkReturned: true });
});

test('controlled replay preserves the first failed postprocessing receipt without rerunning its Hook', async () => {
  let afterCalls = 0;
  const c = await setup(['parallel'], undefined, {}, true, true, session => {
    session.agent.afterToolCall = async () => { afterCalls++; if (afterCalls === 1) throw new Error('first after failed'); };
  });
  await c.session.prompt('Read the scope.');
  const original = structuredClone(c.store.readCall(c.getContext('call-1')));
  await c.session.prompt('Replay the same original call.');
  expect(afterCalls).toBe(1);
  expect(c.contexts).toHaveLength(1);
  expect(c.control!.summary().toolCalls).toBe(1);
  expect(c.store.readCall(c.getContext('call-1'))).toEqual(original);
  const latest = c.session.sessionManager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'toolResult').at(-1);
  expect(latest).toMatchObject({ message: { isError: true, content: original!.sdkDelivery!.content } });
});

test('unknown SDK tools count as real attempts without invented execution records', async () => {
  const c = await setup(['parallel'], undefined, {}, false, true, undefined, ['unregistered_tool']);
  await c.session.prompt('Try the unknown tool.');
  expect(c.control!.summary().toolCalls).toBe(1);
  expect(c.store.calls.size).toBe(0);
  expect(c.contexts).toHaveLength(0);
  const toolMessages = (c.fixture.requests[1]!.messages as { role: string; content: string }[]).filter(message => message.role === 'tool');
  expect(toolMessages[0]!.content).toContain('tool_not_found');
});

test('before exceptions retain their safe stage and never enter execution or after', async () => {
  let afterCalls = 0;
  const c = await setup(['parallel'], undefined, {}, false, true, session => {
    session.agent.beforeToolCall = async () => { throw new Error('private fixture exception'); };
    session.agent.afterToolCall = async () => { afterCalls++; };
  });
  await c.session.prompt('Read the scope.');
  expect(c.contexts).toHaveLength(0);
  expect(afterCalls).toBe(0);
  expect([...c.store.calls.values()]).toMatchObject([{ error: { code: 'internal_error' }, sdkReturned: true,
    control: { preflightStatus: 'failed', postflightStatus: 'not_reached', executionElapsedMs: null } }]);
  expect(JSON.stringify(c.fixture.requests[1]!.messages)).not.toContain('private fixture exception');
});

test('an invalid postprocessing envelope fails safely while preserving original business success', async () => {
  const c = await setup(['parallel'], undefined, {}, false, true, session => {
    session.agent.afterToolCall = async () => ({ content: [{ type: 'image', data: 'fixture' } as never] });
  });
  await c.session.prompt('Read the scope.');
  expect([...c.store.calls.values()]).toMatchObject([{ status: 'succeeded', data: { batchIds: [13] }, sdkReturned: true,
    control: { postflightStatus: 'failed' }, sdkDelivery: { isError: true } }]);
  expect(JSON.stringify(c.fixture.requests[1]!.messages)).toContain('tool_postprocess_failed');
});

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

test('real Provider argument fragments with truncated JSON reach SDK rejection without executing or losing their attempt', async () => {
  const c = await setup(['parallel'], undefined, {}, false, true);
  const requests: Record<string, unknown>[] = [];
  const starts: unknown[] = [];
  const stop = c.session.agent.subscribe(event => {
    if (event.type === 'tool_execution_start') starts.push(structuredClone(event.args));
  });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>);
    const deltas = requests.length === 1 ? [
      { role: 'assistant', tool_calls: [{ index: 0, id: 'truncated-call', type: 'function',
        function: { name: 'scope_1', arguments: '{"readOnly":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '"invalid-boolean"' } }] },
    ] : [{ role: 'assistant', content: 'The invalid argument was rejected.' }];
    const chunks = deltas.map((delta, index) => ({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta,
      finish_reason: index === deltas.length - 1 ? requests.length === 1 ? 'tool_calls' : 'stop' : null }] }));
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  closers.push(async () => { stop(); server.stop(true); });
  const model = c.session.model;
  if (!model) throw new Error('The real Pi session has no selected fixture model.');
  await c.session.setModel({ ...model, baseUrl: `http://127.0.0.1:${server.port}/v1` }, { persist: false });
  c.control!.admitModelCall();
  await c.session.prompt('Read the scope using the streamed arguments.');
  expect(requests).toHaveLength(2);
  expect(starts).toEqual([{ readOnly: 'invalid-boolean' }]);
  expect(c.contexts).toHaveLength(0);
  expect(c.control!.summary().toolCalls).toBe(1);
  expect(c.store.readCall(c.getContext('truncated-call'))).toMatchObject({
    status: 'failed',
    error: { code: 'tool_input_invalid' },
    input: { readOnly: 'invalid-boolean' },
    sdkReturned: true,
    control: { inputValidation: 'failed', preflightStatus: 'not_reached', postflightStatus: 'not_reached', executionElapsedMs: null },
  });
  const result = c.session.sessionManager.getEntries().findLast(entry => entry.type === 'message'
    && entry.message.role === 'toolResult' && entry.message.toolCallId === 'truncated-call');
  expect(result).toMatchObject({ message: { isError: true } });
  const toolMessages = (requests[1]!.messages as { role: string; content: string }[]).filter(message => message.role === 'tool');
  expect(toolMessages).toHaveLength(1);
  expect(toolMessages[0]!.content).toContain('tool_input_invalid');
  expect(toolMessages[0]!.content).not.toContain('invalid-boolean');
});

test.each([false, true])('execute throws but SDK still calls original after and preserves the first cause (after also throws: %s)', async afterThrows => {
  let afterCalls = 0;
  const originalErrors: boolean[] = [];
  const c = await setup(['parallel'], async () => { throw safeError('data_coverage_missing'); }, {}, false, true, session => {
    const originalAfter = session.agent.afterToolCall;
    session.agent.afterToolCall = async (context, signal) => {
      afterCalls++;
      originalErrors.push(context.isError);
      if (afterThrows) throw new Error('private fixture after failure');
      return originalAfter?.(context, signal);
    };
  });
  c.control!.admitModelCall();
  await c.session.prompt('Read the unavailable data and report the real execution failure.');
  expect(c.contexts).toHaveLength(1);
  expect(afterCalls).toBe(1);
  expect(originalErrors).toEqual([true]);
  expect(c.fixture.requests).toHaveLength(2);
  expect(c.store.readCall(c.getContext('call-1'))).toMatchObject({
    status: 'failed',
    error: { code: 'data_coverage_missing' },
    sdkReturned: true,
    control: { failureClass: 'data_coverage_missing', failureStage: 'execution', postflightStatus: afterThrows ? 'failed' : 'passed' },
  });
  const message = c.session.sessionManager.getEntries().findLast(entry => entry.type === 'message'
    && entry.message.role === 'toolResult' && entry.message.toolCallId === 'call-1');
  expect(message).toMatchObject({ message: { isError: true } });
  const providerMessages = (c.fixture.requests[1]!.messages as { role: string; content: string }[]).filter(message => message.role === 'tool');
  expect(providerMessages[0]!.content).toContain(afterThrows ? 'tool_postprocess_failed' : 'data_coverage_missing');
  expect(providerMessages[0]!.content).not.toContain('private fixture after failure');
  if (afterThrows) expect(c.store.readCall(c.getContext('call-1'))?.control?.hookFailure)
    .toEqual({ stage: 'afterToolCall', code: 'tool_postprocess_failed' });
});
