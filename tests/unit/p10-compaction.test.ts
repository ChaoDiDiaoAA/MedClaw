import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, estimateTokens, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { discoverTests } from '../run';
import { memoryAssistant } from '../fixtures/p9-memory';
import { publicMethodSchemas, HOST_PROTOCOL_VERSION, DATABASE_SCHEMA_VERSION, PublicHostRequestSchema } from '../../packages/contracts/src/protocol';
import { safeError } from '../../packages/contracts/src/error';

test('p10 stage discovers its real unit tests and rejects unsupported stages', () => {
  expect(discoverTests('unit', 'P10')).toContain(join(import.meta.dir, 'p10-compaction.test.ts'));
  expect(() => discoverTests('unit', 'P100')).toThrow('Unknown test stage');
});

test('p10 compact routes strictly separate command identity, reads and the three completion facts', () => {
  const compact = Reflect.get(publicMethodSchemas, 'session.compact');
  expect(compact).toBeDefined();
  const input = { sessionId: 1, expectedStorageVersion: 2, model: { provider: 'openai', modelId: 'probe', expectedConfigVersion: '1' } };
  expect(compact.input.safeParse(input).success).toBe(true);
  expect(compact.input.safeParse({ ...input, runId: 1 }).success).toBe(false);
  expect(compact.input.safeParse({ ...input, operationRef: 'injected' }).success).toBe(false);
  const frame = { protocolVersion: 'medclaw.host/p10-v1', kind: 'request', requestId: 'request', instanceId: 'host', operationRef: 'manual', method: 'session.compact', payload: input };
  expect(PublicHostRequestSchema.safeParse(frame).success).toBe(true);
  expect(PublicHostRequestSchema.safeParse({ ...frame, protocolVersion: 'medclaw.host/p9-v1' }).success).toBe(false);
  expect(HOST_PROTOCOL_VERSION).toBe('medclaw.host/p10-v1'); expect(DATABASE_SCHEMA_VERSION).toBe(10);
  const receipt = { contract: 'medclaw.compaction/v1', operationRef: 'manual', sessionId: 1, runId: null, reason: 'manual', status: 'no_op', nativeGenerated: false, nativeSaved: false,
    nativeEntryId: null, firstKeptEntryId: null, tokensBefore: null, estimatedTokensAfter: null, baseStorageVersion: 2, storageVersion: null, activeLeafId: 'original', callIds: [],
    continuationEligibleAtCommit: true, cancelRequestedAt: null, stoppedAt: '2026-10-06T00:00:00.000Z', finishedAt: '2026-10-06T00:00:00.000Z', noOpReason: 'nothing_to_compact', error: null };
  const view = { contract: receipt.contract, operationRef: 'manual', sessionId: 1, status: 'no_op', phase: 'finished', revision: 1, nativeGenerated: false, nativeSaved: false, canContinue: true, receipt, error: null };
  expect(compact.output.safeParse(view).success).toBe(true);
  expect(compact.output.safeParse({ ...view, nativeSaved: true }).success).toBe(false);
  expect(compact.output.safeParse({ ...view, status: 'completed', receipt: { ...receipt, status: 'completed' } }).success).toBe(false);
  expect(compact.output.safeParse({ ...view, receipt: { ...receipt, runId: 1 } }).success).toBe(false);
  expect(compact.output.safeParse({ ...view, receipt: { ...receipt, nativeEntryId: 'invented' } }).success).toBe(false);
  const cancelled = { ...receipt, status: 'cancelled', noOpReason: null, continuationEligibleAtCommit: false, cancelRequestedAt: receipt.finishedAt };
  expect(compact.output.safeParse({ ...view, status: 'cancelled', canContinue: false, receipt: cancelled }).success).toBe(true);
  const read = Reflect.get(publicMethodSchemas, 'session.compaction.read'), cancel = Reflect.get(publicMethodSchemas, 'session.compaction.cancel');
  expect(read.input.safeParse({ sessionId: 1, operationRef: 'manual' }).success).toBe(true);
  expect(read.input.safeParse({ sessionId: 1, operationRef: 'manual', expectedStorageVersion: 2 }).success).toBe(false);
  expect(read.output.safeParse(null).success).toBe(true);
  expect(cancel.output.safeParse({ operation: view, disposition: 'already_finished' }).success).toBe(true);
  expect(safeError('compaction_failed', undefined, { reason: 'compaction_capacity' })).toMatchObject({ code: 'compaction_failed', category: 'runtime', retryable: false, reason: 'compaction_capacity' });
});

const sessions: AgentSession[] = [];
afterEach(async () => { for (const session of sessions.splice(0)) { await session.abort(); await session.waitForIdle(); session.dispose(); } });

function response(text: string, tokens = 2, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  const message = { ...memoryAssistant(text, 'p10-probe'), timestamp: Date.now(), stopReason };
  message.usage = { ...message.usage, input: tokens, output: 1, totalTokens: tokens + 1 };
  return message;
}
function streamMessage(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  if (message.stopReason === 'error' || message.stopReason === 'aborted') stream.push({ type: 'error', reason: message.stopReason, error: message });
  else stream.push({ type: 'done', reason: message.stopReason === 'length' ? 'length' : 'stop', message });
  return stream;
}
async function nativeFixture(rich = true) {
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendModelChange('openai', 'p10-probe'); manager.appendThinkingLevelChange('off');
  if (rich) for (let index = 0; index < 6; index++) {
    manager.appendMessage({ role: 'user', content: `ENGINEERING region=Shanghai ${'x'.repeat(160)}`, timestamp: index * 2 + 1 });
    manager.appendMessage({ ...response(`ENGINEERING answer ${'y'.repeat(160)}`), timestamp: index * 2 + 2 });
  }
  const credentials = { read: async () => ({ type: 'api_key' as const, key: 'ENGINEERING-NONSECRET' }), list: async () => [], modify: async () => undefined, delete: async () => {} };
  const native = await ModelRuntime.create({ credentials, modelsStore: { read: async () => undefined, write: async () => {}, delete: async () => {} }, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 256, keepRecentTokens: 128 }, retry: { enabled: false }, cacheWarming: 'off', defaultTools: [], packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false, enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.cwd(), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [], systemPrompt: 'ENGINEERING' }); await loader.reload();
  const model = { id: 'p10-probe', name: 'ENGINEERING', provider: 'openai', api: 'openai-completions' as const, baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 };
  const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: process.cwd(), modelRuntime: native, model, sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: 'all', tools: [], customTools: [], thinkingLevel: 'off' });
  sessions.push(session);
  const events: AgentSessionEvent[] = []; let reason = 'main';
  session.subscribe(event => { events.push(event); if (event.type === 'compaction_start') reason = event.reason; if (event.type === 'compaction_end') reason = 'main'; });
  return { session, manager, events, phase: () => reason };
}

test('p10 public manual compaction generates a native split-turn entry and does not compact it twice', async () => {
  const f = await nativeFixture(); const phases: string[] = [];
  f.session.agent.streamFunction = () => { phases.push(f.phase()); return streamMessage(response('ENGINEERING Shanghai approved active')); };
  const before = structuredClone(f.manager.getEntries()), result = await f.session.compact(); await f.session.waitForIdle();
  const entry = f.manager.getEntries().at(-1)!;
  expect(phases).toEqual(['manual', 'manual']); expect(entry).toMatchObject({ type: 'compaction', summary: expect.stringContaining('Shanghai'), firstKeptEntryId: result.firstKeptEntryId });
  expect(f.manager.getEntries().slice(0, before.length)).toEqual(before); expect(f.manager.getEntry(result.firstKeptEntryId)).toBeDefined();
  expect(result.estimatedTokensAfter).toBeGreaterThan(0); expect(Reflect.has(result, 'id')).toBe(false); expect(f.session.isIdle).toBe(true);
  expect(f.events.findLast(event => event.type === 'compaction_end')).toMatchObject({ reason: 'manual', aborted: false, willRetry: false });
  await expect(f.session.compact()).rejects.toThrow('Already compacted'); expect(phases).toHaveLength(2);
});

test('p10 public compact reports too-small history without requesting a summary', async () => {
  const f = await nativeFixture(false); let calls = 0;
  f.session.agent.streamFunction = () => { calls++; return streamMessage(response('ENGINEERING')); };
  await expect(f.session.compact()).rejects.toThrow('Nothing to compact'); expect(calls).toBe(0);
  expect(f.manager.getEntries().some(entry => entry.type === 'compaction')).toBe(false);
});

test('p10 SDK threshold runs summaries after the completed main answer without repeating the answer', async () => {
  const f = await nativeFixture(), phases: string[] = [];
  f.session.agent.streamFunction = () => { const phase = f.phase(); phases.push(phase); return streamMessage(response(phase === 'main' ? 'ENGINEERING main' : 'ENGINEERING Shanghai', phase === 'main' ? 3950 : 2)); };
  await f.session.prompt('ENGINEERING continue'); await f.session.waitForIdle();
  expect(phases).toEqual(['main', 'threshold', 'threshold']);
  expect(f.events.findLast(event => event.type === 'compaction_end')).toMatchObject({ reason: 'threshold', aborted: false, willRetry: false });
  expect(f.manager.getEntries().at(-1)?.type).toBe('compaction'); expect(f.session.isIdle).toBe(true);
});

test('p10 SDK overflow preserves the original failed attempt and continues once after compaction', async () => {
  const f = await nativeFixture(), phases: string[] = []; let mainCalls = 0;
  f.session.agent.streamFunction = () => {
    const phase = f.phase(); phases.push(phase);
    if (phase !== 'main') return streamMessage(response('ENGINEERING Shanghai'));
    if (++mainCalls === 1) return streamMessage({ ...response('', 0, 'error'), errorMessage: 'maximum context length exceeded' });
    return streamMessage(response('ENGINEERING recovered'));
  };
  await f.session.prompt('ENGINEERING continue'); await f.session.waitForIdle();
  expect(phases).toEqual(['main', 'overflow', 'overflow', 'main']);
  expect(f.manager.getEntries().some(entry => entry.type === 'context_edit')).toBe(true);
  expect(f.manager.getEntries().some(entry => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.stopReason === 'error')).toBe(true);
  expect(f.events.findLast(event => event.type === 'compaction_end')).toMatchObject({ reason: 'overflow', aborted: false, willRetry: true });
});

test('p10 SDK successful overflow compacts without repeating a completed answer', async () => {
  const f = await nativeFixture(), phases: string[] = [];
  f.session.agent.streamFunction = () => { const phase = f.phase(); phases.push(phase); return streamMessage(response(phase === 'main' ? 'ENGINEERING main' : 'ENGINEERING Shanghai', phase === 'main' ? 4200 : 2)); };
  await f.session.prompt('ENGINEERING continue'); await f.session.waitForIdle();
  expect(phases.filter(phase => phase === 'main')).toHaveLength(1);
  expect(f.events.findLast(event => event.type === 'compaction_end')).toMatchObject({ reason: 'overflow', willRetry: false });
});

test('p10 SDK recoverable length compacts and continues the original turn once', async () => {
  const f = await nativeFixture(), phases: string[] = []; let mainCalls = 0;
  f.session.agent.streamFunction = () => {
    const phase = f.phase(); phases.push(phase);
    return streamMessage(phase !== 'main' ? response('ENGINEERING Shanghai') : ++mainCalls === 1 ? response('ENGINEERING partial', 2, 'length') : { ...response('ENGINEERING recovered'), timestamp: Date.now() + 1 });
  };
  await f.session.prompt('ENGINEERING continue'); await f.session.waitForIdle();
  expect(phases).toEqual(['main', 'overflow', 'overflow', 'main']);
  expect(f.manager.getEntries().some(entry => entry.type === 'context_edit')).toBe(true);
  expect(f.events.findLast(event => event.type === 'compaction_end')).toMatchObject({ reason: 'overflow', willRetry: true });
});

test('p10 SDK stops after the second overflow instead of compacting and continuing again', async () => {
  const f = await nativeFixture(), phases: string[] = [];
  f.session.agent.streamFunction = () => { const phase = f.phase(); phases.push(phase); const message = phase === 'main' ? { ...response('', 0, 'error'), errorMessage: 'maximum context length exceeded' } : response('ENGINEERING Shanghai'); message.timestamp = Date.now() + 1; return streamMessage(message); };
  await f.session.prompt('ENGINEERING continue'); await f.session.waitForIdle();
  expect(phases.filter(phase => phase === 'main')).toHaveLength(2);
  expect(f.manager.getEntries().filter(entry => entry.type === 'compaction')).toHaveLength(1);
  expect(f.events.findLast(event => event.type === 'compaction_end')).toMatchObject({ reason: 'overflow', result: undefined, willRetry: false, errorMessage: expect.stringContaining('one compact-and-retry') });
});

test('p10 SDK second-summary failure preserves the first request but produces no compaction entry or retry', async () => {
  const f = await nativeFixture(); let summaries = 0;
  f.session.agent.streamFunction = () => streamMessage(++summaries === 1 ? response('ENGINEERING history') : { ...response('', 0, 'error'), errorMessage: 'ENGINEERING provider failure' });
  await expect(f.session.compact()).rejects.toThrow(); await f.session.waitForIdle();
  expect(summaries).toBe(2); expect(f.manager.getEntries().some(entry => entry.type === 'compaction')).toBe(false);
  expect(f.events.findLast(event => event.type === 'compaction_end')).toMatchObject({ aborted: false, result: undefined });
});

test('p10 public abortCompaction stops a pending summary before an entry is generated', async () => {
  const f = await nativeFixture(); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  f.session.agent.streamFunction = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    options?.signal?.throwIfAborted();
    options?.signal?.addEventListener('abort', () => stream.push({ type: 'error', reason: 'aborted', error: response('', 0, 'aborted') }), { once: true });
    started(); return stream;
  };
  const pending = f.session.compact(); await ready; expect(f.session.isCompacting).toBe(true); f.session.abortCompaction();
  await expect(pending).rejects.toThrow(); await f.session.waitForIdle(); expect(f.session.isIdle).toBe(true);
  expect(f.manager.getEntries().some(entry => entry.type === 'compaction')).toBe(false);
  expect(f.events.findLast(event => event.type === 'compaction_end')).toMatchObject({ aborted: true });
});

test('p10 native Chinese character estimate remains an estimate rather than a provider usage claim', () => {
  expect(estimateTokens({ role: 'user', content: '上海'.repeat(10), timestamp: 1 })).toBe(5);
});

test('p10 incomplete length summaries cannot become native compaction checkpoints', async () => {
  const f = await nativeFixture(); let calls = 0;
  f.session.agent.streamFunction = () => { calls++; return streamMessage(response('ENGINEERING partial Shanghai', 2, 'length')); };
  await expect(f.session.compact()).rejects.toThrow('summary is incomplete');
  expect(calls).toBe(1); expect(f.manager.getEntries().some(entry => entry.type === 'compaction')).toBe(false);
});

test('p10 split-turn can summarize the current user while keeping a tool call and result paired', async () => {
  const f = await nativeFixture();
  const input = 'ENGINEERING correction: province=Shanghai, approved date, active only';
  f.manager.appendMessage({ role: 'user', content: input, timestamp: 20 });
  f.manager.appendMessage({ ...response(''), timestamp: 21, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'ENGINEERING-query', name: 'read_query', arguments: { filter: 'x'.repeat(1024) } }] });
  f.manager.appendMessage({ role: 'toolResult', toolCallId: 'ENGINEERING-query', toolName: 'read_query', content: [{ type: 'text', text: 'ENGINEERING count=12' }], isError: false, timestamp: 22 });
  f.manager.appendMessage({ ...response('ENGINEERING done'), timestamp: 23 });
  f.session.agent.streamFunction = () => streamMessage(response('ENGINEERING Shanghai approved active only'));
  const result = await f.session.compact();
  const kept = f.manager.getEntry(result.firstKeptEntryId)!;
  expect(kept.type).toBe('message');
  if (kept.type === 'message') expect(kept.message.role).not.toBe('toolResult');
  const messages = f.manager.buildSessionProjection().messages;
  expect(messages.some(message => message.role === 'user' && message.content === input)).toBe(false);
  for (const message of messages) if (message.role === 'toolResult') expect(messages.some(candidate => candidate.role === 'assistant' && candidate.content.some(part => part.type === 'toolCall' && part.id === message.toolCallId))).toBe(true);
  expect(f.manager.getEntries().some(entry => entry.type === 'message' && entry.message.role === 'user' && entry.message.content === input)).toBe(true);
});

test('p10 repeated summaries with identical text preserve different native identities and previous-summary context', async () => {
  const f = await nativeFixture(), requests: unknown[] = [];
  f.session.agent.streamFunction = (_model, context) => { requests.push(structuredClone(context)); return streamMessage(response('ENGINEERING identical Shanghai')); };
  await f.session.compact(); const first = f.manager.getEntries().at(-1)!;
  for (let index = 0; index < 5; index++) {
    f.manager.appendMessage({ role: 'user', content: `ENGINEERING continue ${'z'.repeat(400)}`, timestamp: 100 + index * 2 });
    f.manager.appendMessage({ ...response('ENGINEERING new answer'), timestamp: 101 + index * 2 });
  }
  const nextRequests = requests.length; await f.session.compact(); const second = f.manager.getEntries().at(-1)!;
  expect(first.id).not.toBe(second.id); expect(f.manager.getEntries().filter(entry => entry.type === 'compaction')).toHaveLength(2);
  expect(JSON.stringify(requests.slice(nextRequests))).toContain('<previous-summary>');
  const restored = SessionManager.inMemory(process.cwd(), undefined, [structuredClone(f.manager.getHeader()!), ...structuredClone(f.manager.getEntries())]); restored.branch(second.id);
  expect(restored.buildSessionContext()).toEqual(f.manager.buildSessionContext());
});

test('p10 public native history restoration preserves complete compaction fields', async () => {
  const f = await nativeFixture();
  f.session.agent.streamFunction = () => streamMessage(response('ENGINEERING Shanghai'));
  await f.session.compact();
  const entries = structuredClone(f.manager.getEntries()), entry = entries.at(-1)!;
  expect(entry.type).toBe('compaction');
  Reflect.set(entry, 'details', { version: 'ENGINEERING', refs: ['query:12'] });
  Reflect.set(entry, 'usage', response('ENGINEERING').usage);
  const restored = SessionManager.inMemory(process.cwd(), undefined, [structuredClone(f.manager.getHeader()!), ...entries]);
  restored.branch(entry.id);
  expect(restored.getEntries()).toEqual(entries);
  expect(restored.getEntries().at(-1)).toMatchObject({ details: { refs: ['query:12'] }, usage: { totalTokens: 3 } });
  expect(restored.buildSessionContext()).toEqual(f.manager.buildSessionContext());
});
