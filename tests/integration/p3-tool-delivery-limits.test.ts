import { afterEach, expect, test } from 'bun:test';
import { RunScopeSchema } from '../../packages/contracts/src/run';
import { PositiveIdSchema } from '../../packages/contracts/src/error';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createAgentSession, createReadToolDefinition, defineTool, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { TOOL_CONFIG } from '../../packages/contracts/src/tool-config';
import { DEFAULT_AGENT_POLICY } from '../../packages/contracts/src/model';
import type { ToolCallIdentity, ToolCallRecord, ToolCallStore, ToolExecutionContext, ToolResult, ToolSdkDelivery } from '../../packages/contracts/src/tool';
import { ToolExecutor } from '../../packages/core/src/tools/executor';
import { ToolRecorder } from '../../packages/core/src/tools/recorder';
import { ToolRegistry } from '../../packages/core/src/tools/registry';
import { RunControl } from '../../packages/core/src/runtime/run-control';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { createPiNativeTools, createPiRunControlBinding, createPiToolDefinitions, observePiToolDelivery } from '../../packages/runtime-pi/src/pi-tool-adapter';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
class Calls implements ToolCallStore {
  rows = new Map<string, ToolCallRecord>();
  assertContext() {}
  readCall(context: ToolExecutionContext) { return this.rows.get(context.nativeToolCallId) ?? null; }
  request(tool: ToolCallIdentity, input: unknown, context: ToolExecutionContext) {
    const prior = this.readCall(context); if (prior) return prior;
    const row: ToolCallRecord = { id: this.rows.size + 1, runId: context.runId, sessionId: context.sessionId, nativeToolCallId: context.nativeToolCallId,
      name: tool.name, version: tool.version, executionMode: tool.executionMode, input, status: 'requested', data: null, error: null, sdkReturned: false, nativeEntryId: null };
    this.rows.set(context.nativeToolCallId, row); return row;
  }
  transition(id: number, from: ToolCallRecord['status'], status: ToolCallRecord['status'], result?: ToolResult<unknown>, control?: ToolCallRecord['control']) {
    const row = [...this.rows.values()].find(row => row.id === id)!;
    if (row.status !== from) throw new Error('state_conflict');
    Object.assign(row, { status, data: result?.data ?? null, error: result && result.status !== 'succeeded' ? result.error : null, ...(control ? { control } : {}) }); return row;
  }
  mergeControl(context: ToolExecutionContext, control: Partial<NonNullable<ToolCallRecord['control']>>) {
    const row = this.readCall(context)!; row.control = { ...row.control, ...control } as NonNullable<ToolCallRecord['control']>; return row;
  }
  recordDelivery(context: ToolExecutionContext, nativeEntryId: string, sdkDelivery?: ToolSdkDelivery) {
    Object.assign(this.readCall(context)!, { nativeEntryId, sdkDelivery: structuredClone(sdkDelivery), sdkReturned: true });
  }
}
async function fixture(native: boolean, args: unknown = native ? { path: 'sample.txt' } : {}) {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-delivery-limit-'));
  await writeFile(join(root, 'sample.txt'), 'first\nsecond\nthird');
  const name = native ? 'read' : 'test_query', requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>);
    const delta = requests.length === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'limit-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
      : { role: 'assistant', content: 'done' };
    return new Response(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  closers.push(async () => { server.stop(true); await rm(root, { recursive: true, force: true }); });
  const credentials = new InMemoryCredentialStore(); await credentials.modify('limit-fixture', async () => ({ type: 'api_key', key: 'fixture' }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  await runtime.installCustom([{ providerId: 'limit-fixture', name: 'Fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`,
    models: [{ id: 'fixture', name: 'fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] }]);
  const resolved = await runtime.resolve({ provider: 'limit-fixture', modelId: 'fixture', expectedConfigVersion: '1' }, '1', null, { timeoutMs: 5000, maxRetries: 0, maxRetryDelayMs: 2000 });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', defaultTools: [], packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false, enableInstallTelemetry: false });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'pi'), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Use the supplied tools.' });
  await resourceLoader.reload();
  const store = new Calls(), recorder = new ToolRecorder(store), abort = new AbortController();
  const scope = { batchIds: [1], deviceIds: null, allowedToolNames: [name], allowedResourceRefs: [], artifactIds: [], readOnly: true };
  const config = { ...TOOL_CONFIG, maxResultBytes: 1024 };
  const control = new RunControl({ runId: 1, policy: DEFAULT_AGENT_POLICY, toolConfiguration: config, scope, signal: abort.signal, deadlineAt: performance.now() + 10000, totalTimeoutMs: 10000 });
  const getContext = (nativeToolCallId: string, signal = abort.signal): ToolExecutionContext => ({ runId: 1, sessionId: 1, nativeToolCallId, signal, scope, referenceDate: '2026-01-01', timezone: 'Asia/Shanghai' });
  let executions = 0;
  const registry = new ToolRegistry(native ? [] : [{ name, label: 'Fixture', description: 'Read facts.', version: '1.0.0', effect: 'READ', executionMode: 'parallel', inputSchema: RunScopeSchema.pick({}).strict(), outputSchema: RunScopeSchema.extend({ queryId: PositiveIdSchema }).pick({ queryId: true }).strict(),
    async execute() { executions++; return { queryId: 7 }; } }]);
  const executor = new ToolExecutor(registry, recorder);
  const nativeTools = createPiNativeTools(root, recorder, getContext, {}, () => control);
  const definitions = native ? nativeTools.definitions : createPiToolDefinitions(registry, executor, getContext, () => control);
  const { session } = await createAgentSession({ cwd: root, agentDir: join(root, 'pi'), modelRuntime: runtime.native, model: resolved.model, thinkingLevel: 'off', tools: [name], customTools: definitions, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) });
  let afterCalls = 0;
  session.agent.afterToolCall = async () => { afterCalls++; return { content: [{ type: 'text', text: '中'.repeat(342) }], details: { original: 'kept' }, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; };
  const stopControl = createPiRunControlBinding(session, registry, recorder, getContext, () => control)();
  const stopDelivery = native ? nativeTools.bind(session) : observePiToolDelivery(session, registry, recorder, getContext, () => control);
  closers.unshift(async () => { await session.abort(); await session.waitForIdle(); stopDelivery(); stopControl(); control.dispose(); session.dispose(); });
  return { root, session, store, control, recorder, requests, get executions() { return executions; }, get afterCalls() { return afterCalls; } };
}
for (const native of [false, true]) test(`final after Hook byte limit delivers a real error while preserving ${native ? 'native' : 'business'} execution`, async () => {
  const c = await fixture(native); await c.session.prompt('Read facts.');
  const row = c.store.rows.get('limit-call')!;
  expect(row).toMatchObject({ status: 'succeeded', sdkReturned: true, control: { postflightStatus: 'passed', failureStage: 'sdk_delivery', failureClass: 'tool_result_too_large' }, sdkDelivery: { isError: true, details: { original: 'kept' }, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
  if (native) {
    const sdk = defineTool(createReadToolDefinition(c.root));
    const raw = { path: 'sample.txt' };
    expect(row.input).toEqual(sdk.prepareArguments ? sdk.prepareArguments(raw) : raw);
  }
  else expect(row.data).toEqual({ queryId: 7 });
  expect(JSON.stringify(c.requests[1]!.messages)).toContain('tool_result_too_large');
  expect(c.control.summary().toolCalls).toBe(1);
  expect(c.recorder.blocked({ runId: 1 } as ToolExecutionContext)).toBeUndefined();
});
test('SDK input refusal with a large private invalid field is safe before receipt snapshots', async () => {
  const c = await fixture(false, { secret: 'private'.repeat(1000) }); await c.session.prompt('Read facts.');
  expect(c.executions).toBe(0); expect(c.afterCalls).toBe(0);
  const row = c.store.rows.get('limit-call')!;
  expect(row).toMatchObject({ status: 'failed', sdkReturned: true, error: { code: 'tool_input_invalid' }, sdkDelivery: { isError: true } });
  expect(JSON.stringify(row.sdkDelivery)).not.toContain('private');
});
