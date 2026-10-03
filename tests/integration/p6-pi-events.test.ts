import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore, type AssistantMessage } from '@earendil-works/pi-ai';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import type { StreamSnapshot, MessageStreamSnapshot } from '../../packages/contracts/src/event';
import { providerFixture } from '../fixtures/p1-provider';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
async function model(baseUrl = 'http://127.0.0.1:1/v1') {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p6-pi-'));
  closers.push(() => rm(root, { recursive: true, force: true }));
  const credentials = new InMemoryCredentialStore(); await credentials.modify('p6-fixture', async () => ({ type: 'api_key', key: 'fixture' }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  await runtime.installCustom([{ providerId: 'p6-fixture', name: 'fixture', api: 'openai-completions', baseUrl, models: [{ id: 'fixture', name: 'fixture', input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] }]);
  const resolved = await runtime.resolve({ provider: 'p6-fixture', modelId: 'fixture', expectedConfigVersion: '1' }, '1', null, { timeoutMs: 10000, maxRetries: 0, maxRetryDelayMs: 2000 });
  return { root, runtime, resolved };
}
test('real provider Agent execution emits original call identity and clears snapshots after idle', async () => {
  const fixture = providerFixture(); closers.push(async () => fixture.close());
  const c = await model(fixture.url), runtime = new PiAgentRuntime(c.runtime, c.root); runtime.allocate().bind(7);
  const seen: StreamSnapshot[] = []; let live: unknown;
  const observed = await runtime.execute({ runId: 41, sessionId: 7, text: 'hello', resolved: c.resolved, agentOptions: runtime.describe(c.resolved), signal: new AbortController().signal, deadlineAt: performance.now() + 10000 }, {
    startCall: () => ({ callId: 'original-call', finish: (outcome, endedAt) => ({ callId: 'original-call', state: outcome.callState, responseModel: outcome.responseModel, sdkStopReason: outcome.sdkStopReason === 'pending' ? null : outcome.sdkStopReason, endedAt, durationMs: 1, ...outcome.usage, usageSource: outcome.usage.source, error: outcome.error }) }),
    preview: () => { throw new Error('obsolete Agent preview'); }, nativeTerminal: () => {},
    stream: snapshot => { seen.push(snapshot); live = runtime.readSnapshots?.(41); throw new Error('page display failure'); },
  });
  expect(observed.lastOutcome?.callState).toBe('completed');
  expect(seen.some(s => s.type === 'message.snapshot' && s.modelCallId === 'original-call' && s.blocks.some(b => b.text.includes('你好😀')))).toBe(true);
  expect(live).toMatchObject({ incomplete: false });
  expect(runtime.readSnapshots?.(41)).toEqual({ streamConnection: null, snapshots: [], incomplete: false });
});
async function controlled(readToolIdentity: (nativeToolCallId: string) => { toolCallId: number } | null = () => null, tool?: ToolDefinition) {
  const c = await model();
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', defaultTools: [], packages: [], extensions: [], skills: [], prompts: [], themes: [] });
  const resourceLoader = new DefaultResourceLoader({ cwd: c.root, agentDir: join(c.root, 'pi'), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'fixture' }); await resourceLoader.reload();
  const manager = SessionManager.inMemory(c.root);
  const { session } = await createAgentSession({ cwd: c.root, agentDir: join(c.root, 'pi'), modelRuntime: c.runtime.native, model: c.resolved.model, thinkingLevel: 'off', ...(tool ? { tools: [tool.name], customTools: [tool] } : { noTools: 'all' as const, tools: [] }), settingsManager, resourceLoader, sessionManager: manager });
  const streams: ReturnType<typeof createAssistantMessageEventStream>[] = []; let callId: string | null = null;
  session.agent.streamFunction = () => { callId = `call-${streams.length + 1}`; const stream = createAssistantMessageEventStream(); streams.push(stream); return stream; };
  const { EventAdapter } = await import('../../packages/runtime-pi/src/event-adapter');
  const adapter = new EventAdapter(), seen: StreamSnapshot[] = [];
  const dispose = adapter.attach({ session, manager, runId: 41, sessionId: 7, streamConnection: 'original-connection', readToolIdentity, readCurrentModelCallId: () => callId, emit: snapshot => seen.push(snapshot) });
  const message = (text: string): AssistantMessage => ({ role: 'assistant', content: [{ type: 'thinking', thinking: 'private', thinkingSignature: 'secret' }, { type: 'text', text }, { type: 'text', text: ' tail' }], api: 'openai-completions', provider: 'p6-fixture', model: 'fixture', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
  async function waitStream(count: number) { for (let i = 0; i < 500 && streams.length < count; i++) await Bun.sleep(1); expect(streams.length).toBe(count); }
  closers.unshift(async () => { streams.forEach(s => s.push({ type: 'done', reason: 'stop', message: message('cleanup') })); await session.abort(); await session.waitForIdle(); dispose(); session.dispose(); });
  return { ...c, session, manager, streams, adapter, seen, dispose, message, waitStream };
}
test('real SDK multi-message snapshots freeze safe blocks, calls and exact appended native entries', async () => {
  const c = await controlled(); const running = c.session.prompt('hello'); await c.waitStream(1);
  const partial = c.message('first'); c.streams[0]!.push({ type: 'start', partial }); c.streams[0]!.push({ type: 'text_delta', contentIndex: 1, delta: 'first', partial }); await Bun.sleep(5);
  const old = c.seen.find(s => s.type === 'message.snapshot' && s.blocks.some(b => b.text === 'first')) as MessageStreamSnapshot;
  partial.content[1] = { type: 'text', text: 'changed' };
  expect(old.blocks).toEqual([{ contentIndex: 1, text: 'first' }, { contentIndex: 2, text: ' tail' }]);
  c.session.agent.followUp({ role: 'user', content: 'again', timestamp: Date.now() });
  c.streams[0]!.push({ type: 'done', reason: 'stop', message: c.message('first') }); await c.waitStream(2);
  c.streams[1]!.push({ type: 'done', reason: 'stop', message: c.message('second') }); await running;
  const snapshots = c.adapter.readSnapshots(41).snapshots as MessageStreamSnapshot[];
  expect(snapshots.map(s => [s.messageId, s.modelCallId, s.phase])).toEqual([['41.1', 'call-1', 'ended'], ['41.2', 'call-2', 'ended']]);
  expect(snapshots.map(s => s.nativeEntryId)).toEqual(c.manager.getEntries().filter(e => e.type === 'message' && e.message.role === 'assistant').map(e => e.id));
  for (const snapshot of snapshots) { const entry = c.manager.getEntry(snapshot.nativeEntryId!); expect(entry?.type).toBe('message'); expect(JSON.stringify(snapshot)).not.toContain('private'); expect(JSON.stringify(snapshot)).not.toContain('secret'); }
  snapshots[0]!.blocks[0]!.text = 'reader mutation'; expect(JSON.stringify(c.adapter.readSnapshots(41))).not.toContain('reader mutation');
  c.dispose(); expect(c.adapter.readSnapshots(41)).toEqual({ streamConnection: null, snapshots: [], incomplete: false });
});
test('real SDK retains only recent bounded snapshots with surrogate-safe total text accounting', async () => {
  const c = await controlled();
  for (let i = 0; i < 35; i++) { const run = c.session.prompt('again'); await c.waitStream(i + 1); c.streams[i]!.push({ type: 'done', reason: 'stop', message: c.message('x'.repeat(32767) + '😀') }); await run; }
  const result = c.adapter.readSnapshots(41); expect(result.incomplete).toBe(true); expect(result.snapshots).toHaveLength(32);
  const first = result.snapshots[0] as MessageStreamSnapshot; expect(first.messageId).toBe('41.4'); expect(first.totalChars).toBe(32774); expect(first.truncated).toBe(true);
  expect(first.blocks.map(b => b.text).join('')).toBe('x'.repeat(32767));
  expect(Buffer.byteLength(JSON.stringify(result.snapshots))).toBeLessThanOrEqual(3 * 1024 * 1024);
});
test('real SDK unknown-tool attempts expose no argument or raw result text and no invented product identity', async () => {
  const c = await controlled(); const run = c.session.prompt('tool'); await c.waitStream(1);
  const message = c.message('explanation'); message.content.push({ type: 'toolCall', id: 'unknown-attempt', name: 'missing', arguments: { credential: 'hidden-argument' } }); message.stopReason = 'toolUse';
  c.streams[0]!.push({ type: 'done', reason: 'toolUse', message }); await c.waitStream(2); c.streams[1]!.push({ type: 'done', reason: 'stop', message: c.message('final') }); await run;
  const tools = c.seen.filter(s => s.type === 'tool.snapshot');
  expect(tools.map(s => [s.phase, s.toolCallId, s.text, s.totalChars, s.truncated])).toEqual([['attempt', null, null, null, false], ['ended', null, null, null, false]]);
  expect(JSON.stringify(c.seen)).not.toContain('hidden-argument'); expect(JSON.stringify(c.seen)).not.toContain('not found');
});
test('ordinary identity-reader failure cannot reject the real SDK loop', async () => {
  const c = await controlled(() => { throw new Error('read-side SQLite failure'); }); const run = c.session.prompt('tool'); await c.waitStream(1);
  const message = c.message('before'); message.content.push({ type: 'toolCall', id: 'attempt', name: 'missing', arguments: {} }); message.stopReason = 'toolUse';
  c.streams[0]!.push({ type: 'done', reason: 'toolUse', message }); await c.waitStream(2); c.streams[1]!.push({ type: 'done', reason: 'stop', message: c.message('after') }); await run;
  expect(c.session.isIdle).toBe(true); expect(c.adapter.readSnapshots(41).incomplete).toBe(true);
  expect(c.adapter.readSnapshots(41).snapshots.some(s => s.type === 'message.snapshot' && s.blocks.some(b => b.text === 'after'))).toBe(true);
});
test('real SDK tool progress exposes verified identity and hides arbitrary partial and final results', async () => {
  let saved = false;
  const tool: ToolDefinition = { name: 'fixture_tool', label: 'Fixture', description: 'Fixture', parameters: { type: 'object', properties: {} },
    async execute(_id, _args, _signal, update) { saved = true; update?.({ content: [{ type: 'text', text: 'sensitive-stdout' }], details: { secret: 'partial-secret' } }); return { content: [{ type: 'text', text: 'sensitive-final' }], details: { secret: 'final-secret' } }; } };
  const c = await controlled(() => saved ? { toolCallId: 123 } : null, tool); const run = c.session.prompt('tool'); await c.waitStream(1);
  const message = c.message('before'); message.content.push({ type: 'toolCall', id: 'real-tool', name: 'fixture_tool', arguments: {} }); message.stopReason = 'toolUse';
  c.streams[0]!.push({ type: 'done', reason: 'toolUse', message }); await c.waitStream(2); c.streams[1]!.push({ type: 'done', reason: 'stop', message: c.message('after') }); await run;
  expect(c.seen.filter(s => s.type === 'tool.snapshot').map(s => [s.phase, s.toolCallId, s.text])).toEqual([['attempt', null, null], ['progress', 123, null], ['ended', 123, null]]);
  expect(JSON.stringify(c.seen)).not.toContain('sensitive'); expect(JSON.stringify(c.seen)).not.toContain('secret');
});
test('real SDK Unicode snapshots evict for UTF8 JSON byte budget before object count limit', async () => {
  const c = await controlled();
  for (let i = 0; i < 32; i++) { const run = c.session.prompt('again'); await c.waitStream(i + 1); c.streams[i]!.push({ type: 'done', reason: 'stop', message: c.message('汉'.repeat(32768)) }); await run; }
  const result = c.adapter.readSnapshots(41); expect(result.incomplete).toBe(true); expect(result.snapshots).toHaveLength(31);
  expect((result.snapshots[0] as MessageStreamSnapshot).messageId).toBe('41.2');
  expect(Buffer.byteLength(JSON.stringify(result.snapshots), 'utf8')).toBeLessThanOrEqual(3 * 1024 * 1024);
});
