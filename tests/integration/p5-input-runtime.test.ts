import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionFactory, type SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore, type AssistantMessage } from '@earendil-works/pi-ai';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import { ModelCallRecorder } from '../../packages/runtime-pi/src/model-call-recorder';
import type { InputStore } from '../../packages/contracts/src/session';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
async function setup(hook?: ExtensionFactory, options: { appendThrows?: boolean; saveThrows?: () => boolean; cancelSaveThrows?: () => boolean } = {}) {
  const module = await import('../../packages/runtime-pi/src/input-adapter').catch(() => null);
  expect(module).not.toBeNull(); if (!module) throw new Error('P5 InputAdapter is missing');
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p5-input-'));
  const credentials = new InMemoryCredentialStore(); await credentials.modify('p5-fixture', async () => ({ type: 'api_key', key: 'fixture' }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  await runtime.installCustom([{ providerId: 'p5-fixture', name: 'fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', name: 'fixture', input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] }]);
  const resolved = await runtime.resolve({ provider: 'p5-fixture', modelId: 'fixture', expectedConfigVersion: '1' }, '1', null, { timeoutMs: 10000, maxRetries: 0, maxRetryDelayMs: 2000 });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', defaultTools: [], packages: [], extensions: [], skills: [], prompts: [], themes: [] });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'pi'), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: hook ? [hook] : [], systemPrompt: 'fixture' });
  await resourceLoader.reload();
  const manager = SessionManager.inMemory(root);
  let nativeAppends = 0; const append = manager.appendMessage.bind(manager);
  manager.appendMessage = message => { if (message.role === 'user') nativeAppends++; if (options.appendThrows && message.role === 'user') throw new Error('native-append-failed'); return append(message); };
  const { session } = await createAgentSession({ cwd: root, agentDir: join(root, 'pi'), modelRuntime: runtime.native, model: resolved.model, thinkingLevel: 'off', noTools: 'all', tools: [], settingsManager, resourceLoader, sessionManager: manager });
  const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
  session.agent.streamFunction = (_model, _context, options) => { options?.signal?.throwIfAborted(); const stream = createAssistantMessageEventStream(); streams.push(stream); return stream; };
  const consumed: { inputId: number; nativeEntryId: string }[] = [], delivered: number[] = [], failures: { inputId: number; reason: string; code: string }[] = [], savedRemovals: number[] = []; let nativeInvalidations = 0;
  const adapter = new module.PiInputAdapter(session, manager, { runId: 41, sessionId: 7,
    delivered: input => { delivered.push(input.inputId); }, consumed: (input, fact) => { if (options.saveThrows?.()) throw new Error('sqlite-save-failed'); consumed.push({ inputId: input.inputId, nativeEntryId: fact.nativeEntryId }); },
    failed: (input, fact) => { failures.push({ inputId: input.inputId, reason: fact.proof.reason, code: fact.error.code }); },
    cancelled: proof => { if (options.cancelSaveThrows?.()) throw new Error('cancel-save-failed'); savedRemovals.push(proof.inputId); }, fatal: () => {}, nativeStateInvalid: () => { nativeInvalidations++; }, admissionClosed: () => {} });
  function finish(index: number) { const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: 'openai-completions', provider: 'p5-fixture', model: 'fixture', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() }; streams[index]!.push({ type: 'done', reason: 'stop', message }); }
  const input = (inputId: number, mode: 'send' | 'steer' | 'follow_up', text = 'same') => ({ inputId, sessionId: 7, targetRunId: 41, mode, text, stopEpoch: 0 });
  const waitStreams = async (count: number) => { for (let i = 0; i < 500 && streams.length < count; i++) await Bun.sleep(1); expect(streams.length).toBe(count); };
  closers.push(async () => { for (let i = 0; i < streams.length; i++) finish(i); await session.abort(); await session.waitForIdle(); adapter.dispose(); session.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, runtime, resolved, session, manager, adapter, consumed, delivered, failures, savedRemovals, streams, finish, input, waitStreams, get nativeAppends() { return nativeAppends; }, get nativeInvalidations() { return nativeInvalidations; } };
}

test('SDK Hook transforms preserve distinct input objects and exact append entry identities', async () => {
  let hooks = 0;
  const c = await setup(pi => { pi.on('input', () => { hooks++; return { action: 'transform', text: 'X:same' }; }); });
  await c.adapter.deliver(c.input(1, 'send')); await c.waitStreams(1);
  await c.adapter.deliver(c.input(2, 'follow_up')); await c.adapter.deliver(c.input(3, 'follow_up'));
  c.finish(0); await c.waitStreams(2); c.finish(1); await c.waitStreams(3); c.finish(2);
  const proof = await c.adapter.close(41, 'completed');
  expect(proof.nativeIdle).toBe(true); expect(c.delivered).toEqual([1, 2, 3]); expect(c.consumed.map(f => f.inputId)).toEqual([1, 2, 3]);
  const users = c.manager.getEntries().filter((e): e is SessionMessageEntry => e.type === 'message' && e.message.role === 'user');
  expect(users.map(e => e.message.role === 'user' ? typeof e.message.content === 'string' ? e.message.content : e.message.content.filter(part => part.type === 'text').map(part => part.text).join('') : null)).toEqual(['X:same', 'X:same', 'X:same']);
  expect(new Set(users.map(e => e.message)).size).toBe(3); expect(new Set(c.consumed.map(f => f.nativeEntryId)).size).toBe(3); expect(hooks).toBe(3);
});

test('cancel during prepareNextTurn drain-before-start gap cannot remove or replay the drained object', async () => {
  const c = await setup(); const entered = deferred(), resume = deferred(); let prepares = 0;
  const original = c.session.agent.prepareNextTurnWithContext;
  c.session.agent.prepareNextTurnWithContext = async (...args) => { if (++prepares === 1) { entered.resolve(); await resume.promise; } return original?.(...args); };
  await c.adapter.deliver(c.input(1, 'send')); await c.waitStreams(1); await c.adapter.deliver(c.input(2, 'follow_up'));
  c.finish(0); await entered.promise;
  let answered = false; const cancel = c.adapter.cancel(2).then(proof => { answered = true; return proof; });
  await Bun.sleep(10); expect(answered).toBe(false); resume.resolve(); await c.waitStreams(2); c.finish(1);
  expect((await cancel).kind).toBe('consumed'); await c.adapter.close(41, 'completed');
  expect(c.consumed.map(f => f.inputId)).toEqual([1, 2]); expect(c.streams).toHaveLength(2);
});

test('native append throw leaves unknown and never retries append or prompt', async () => {
  const c = await setup(undefined, { appendThrows: true });
  await c.adapter.deliver(c.input(1, 'send'));
  const proof = await c.adapter.close(41, 'failed'); const before = c.nativeAppends;
  c.adapter.retryPersistence(41);
  expect(c.nativeAppends).toBe(before); expect(c.nativeAppends).toBe(1); expect(c.consumed).toEqual([]);
  expect(proof.unconfirmedInputIds).toEqual([1]); expect(c.failures).toContainEqual({ inputId: 1, reason: 'append_failed', code: 'input_delivery_unknown' });
  expect(c.nativeInvalidations).toBe(1);
});

test('SQLite failure retains exact native entry and retries only its persistence callback', async () => {
  let reject = true; const c = await setup(undefined, { saveThrows: () => reject });
  await c.adapter.deliver(c.input(1, 'send')); await c.waitStreams(1); c.finish(0);
  const proof = await c.adapter.close(41, 'failed'); const appends = c.nativeAppends;
  expect(proof.pendingPersistence).toBe(true); expect(c.consumed).toEqual([]);
  reject = false; c.adapter.retryPersistence(41);
  expect(c.adapter.persistencePending(41)).toBe(false); expect(c.nativeAppends).toBe(appends);
  const entry = c.manager.getEntries().find(e => e.type === 'message' && e.message.role === 'user')!;
  expect(c.consumed).toEqual([{ inputId: 1, nativeEntryId: entry.id }]);
  expect(c.nativeInvalidations).toBe(0);
});

test('two lanes retain their own order and replay bypasses Hooks and string shadow', async () => {
  let hooks = 0; const c = await setup(pi => { pi.on('input', () => { hooks++; return { action: 'continue' }; }); });
  const queuedObjects: Parameters<typeof c.session.agent.steer>[0][] = []; const original = c.session.agent.steer;
  c.session.agent.steer = message => { queuedObjects.push(message); original(message); };
  const originalFollow = c.session.agent.followUp; c.session.agent.followUp = message => { queuedObjects.push(message); originalFollow(message); };
  await c.adapter.deliver(c.input(1, 'send')); await c.waitStreams(1);
  for (const [id, mode] of [[2, 'follow_up'], [3, 'steer'], [4, 'follow_up'], [5, 'steer']] as const) await c.adapter.deliver(c.input(id, mode));
  const cancel = c.adapter.cancel(4); c.finish(0); expect((await cancel).kind).toBe('removed');
  await c.waitStreams(2); c.finish(1); await c.waitStreams(3); c.finish(2); await c.waitStreams(4); c.finish(3);
  await c.adapter.close(41, 'completed');
  expect(c.consumed.map(f => f.inputId)).toEqual([1, 3, 5, 2]); expect(hooks).toBe(5);
  const actual = c.manager.getEntries().filter((e): e is SessionMessageEntry => e.type === 'message' && e.message.role === 'user').map(e => e.message);
  expect(actual.slice(1)).toEqual([queuedObjects[1], queuedObjects[3], queuedObjects[0]]);
  expect(c.session.agent.hasQueuedMessages()).toBe(false);
});

test('long Send releases dispatch lock and cancelling q2 requeues q1/q3 same objects at turn_end', async () => {
  const c = await setup(); let ends = 0; c.session.agent.subscribe(event => { if (event.type === 'agent_end') ends++; });
  await c.adapter.deliver(c.input(1, 'send')); await c.waitStreams(1);
  for (const id of [2, 3, 4]) await c.adapter.deliver(c.input(id, 'follow_up'));
  const cancelled = c.adapter.cancel(3); c.finish(0);
  expect((await cancelled).kind).toBe('removed'); await c.waitStreams(2); c.finish(1); await c.waitStreams(3); c.finish(2);
  const proof = await c.adapter.close(41, 'completed');
  expect(c.consumed.map(f => f.inputId)).toEqual([1, 2, 4]); expect(ends).toBe(1); expect(proof.nativeQueuesEmpty).toBe(true);
});

test('handled Hook records zero native deliveries', async () => {
  const c = await setup(pi => { pi.on('input', () => ({ action: 'handled' })); });
  await c.adapter.deliver(c.input(1, 'send'));
  expect(c.delivered).toEqual([]); expect(c.consumed).toEqual([]); expect(c.failures).toEqual([{ inputId: 1, reason: 'hook_handled', code: 'input_hook_handled' }]);
  expect((await c.adapter.close(41, 'failed')).nativeIdle).toBe(true);
});

test('Stop clears queued native sources before abort and never starts another model loop', async () => {
  const c = await setup(); await c.adapter.deliver(c.input(1, 'send')); await c.waitStreams(1);
  await c.adapter.deliver(c.input(2, 'follow_up')); await c.adapter.deliver(c.input(3, 'steer'));
  c.adapter.stop(); expect(c.session.agent.hasQueuedMessages()).toBe(false);
  const stopping = c.session.abort(); c.finish(0); await stopping;
  const proof = await c.adapter.close(41, 'cancelled');
  expect(c.streams).toHaveLength(1); expect(c.consumed.map(f => f.inputId)).toEqual([1]);
  expect(proof.removals.map(f => f.inputId)).toEqual([2, 3]); expect(proof.unconfirmedInputIds).toEqual([]);
});

test('normal close invalidates a pending Hook before its native dispatch', async () => {
  const gate = deferred(), entered = deferred();
  const c = await setup(pi => { pi.on('input', async event => { if (event.text === 'late') { entered.resolve(); await gate.promise; } return { action: 'continue' }; }); });
  await c.adapter.deliver(c.input(1, 'send')); await c.waitStreams(1);
  const pending = c.adapter.deliver(c.input(2, 'follow_up', 'late')); await entered.promise;
  c.adapter.closeAdmission(); gate.resolve(); await pending; c.finish(0);
  const proof = await c.adapter.close(41, 'completed');
  expect(c.delivered).toEqual([1]); expect(c.consumed.map(f => f.inputId)).toEqual([1]); expect(proof.nativeQueuesEmpty).toBe(true);
});

test('nested Hook submission cannot borrow the outer input identity', async () => {
  let nested: (() => Promise<void>) | undefined;
  const c = await setup(pi => { pi.on('input', async event => { if (event.text === 'outer') await nested!(); return { action: 'continue' }; }); });
  nested = () => c.session.followUp('nested');
  await c.adapter.deliver(c.input(1, 'follow_up', 'outer'));
  const proof = await c.adapter.close(41, 'failed');
  expect(c.delivered).toEqual([]); expect(c.consumed).toEqual([]); expect(proof.unconfirmedInputIds).toEqual([1]);
});

test('known root failing before SDK preparation returns not-dispatched source proof', async () => {
  const c = await setup(); const runtime = new PiAgentRuntime(c.runtime, c.root); runtime.allocate().bind(7);
  const abort = new AbortController(); abort.abort(); const facts: string[] = [];
  const store = { recordInputFailure: (_id, fact) => { facts.push(fact.proof.reason); } } as Pick<InputStore, 'recordInputFailure'> as InputStore;
  const observed = await runtime.execute({ runId: 41, sessionId: 7, inputId: 1, text: 'same', resolved: c.resolved, agentOptions: runtime.describe(c.resolved), signal: abort.signal, deadlineAt: performance.now() + 10000 }, {
    startCall: () => { throw new Error('no call allowed'); }, preview: () => {}, nativeTerminal: () => {}, inputStore: store,
  });
  expect(facts).toEqual(['start_failed']);
  expect(observed.inputSettlement).toMatchObject({ runId: 41, admissionClosed: true, preflightSettled: true, nativeIdle: true, nativeQueuesEmpty: true, pendingPersistence: false, unconfirmedInputIds: [] });
});

test('failed cancellation save retains original removal proof and never resends its object', async () => {
  let reject = true; const c = await setup(undefined, { cancelSaveThrows: () => reject });
  await c.adapter.deliver(c.input(1, 'send')); await c.waitStreams(1); await c.adapter.deliver(c.input(2, 'follow_up'));
  const cancelled = c.adapter.cancel(2); c.finish(0); const removal = await cancelled;
  expect(removal.kind).toBe('removed'); const proof = await c.adapter.close(41, 'completed');
  expect(proof.pendingPersistence).toBe(true); expect(c.savedRemovals).toEqual([]);
  reject = false; c.adapter.retryPersistence(41);
  expect(c.savedRemovals).toEqual([2]); expect(await c.adapter.cancel(2)).toBe(removal);
  expect(c.streams).toHaveLength(1); expect(c.consumed.map(f => f.inputId)).toEqual([1]);
});

test('Stop during drain-before-start waits for idle before publishing any removal proof', async () => {
  const c = await setup(); const entered = deferred(), resume = deferred(); const original = c.session.agent.prepareNextTurnWithContext;
  c.session.agent.prepareNextTurnWithContext = async (...args) => { entered.resolve(); await resume.promise; return original?.(...args); };
  await c.adapter.deliver(c.input(1, 'send')); await c.waitStreams(1); await c.adapter.deliver(c.input(2, 'follow_up'));
  c.finish(0); await entered.promise; c.adapter.stop(); const abort = c.session.abort();
  let closed = false; const closing = c.adapter.close(41, 'cancelled').then(proof => { closed = true; return proof; });
  await Bun.sleep(10); expect(closed).toBe(false); expect(c.savedRemovals).toEqual([]);
  resume.resolve(); await abort; const proof = await closing;
  expect(c.streams).toHaveLength(1); expect(proof.nativeIdle).toBe(true);
  // Pi appends the drained input before checking the aborted provider signal.
  expect(c.consumed.map(f => f.inputId)).toEqual([1, 2]);
  expect(proof.removals).toEqual([]); expect(proof.unconfirmedInputIds).toEqual([]);
});

test('actual PiAgentRuntime quarantines native append corruption while known entry save retry preserves history', async () => {
  const c = await setup(), runtime = new PiAgentRuntime(c.runtime, c.root); runtime.allocate().bind(7);
  let rejectSave = false, nativeStreams = 0;
  const consumption: { inputId: number; nativeEntryId: string }[] = [], failureReasons: string[] = [];
  const store: InputStore = {
    acceptInput: () => { throw new Error('acceptance belongs to core fixture'); }, beginInputDelivery: () => {}, recordInputDelivery: () => {},
    recordInputConsumption: (inputId, fact) => { if (rejectSave) throw new Error('sqlite-save-failed'); consumption.push({ inputId, nativeEntryId: fact.nativeEntryId }); },
    recordInputFailure: (_inputId, fact) => { failureReasons.push(fact.proof.reason); }, recordInputCancellation: () => { throw new Error('no queued cancellation in this fixture'); },
    readInput: () => null, listInputs: input => ({ sessionId: input.sessionId, items: [], nextClientSequence: null, hasMore: false }), inputsForRun: () => [], settleRunInputs: () => {},
  };
  c.runtime.native.streamSimple = () => {
    nativeStreams++; const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: 'openai-completions', provider: 'p5-fixture', model: 'fixture', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    stream.push({ type: 'done', reason: 'stop', message }); return stream;
  };
  const execute = (sessionId: number, runId: number, inputId: number) => runtime.execute({ sessionId, runId, inputId, text: `input-${inputId}`, resolved: c.resolved, agentOptions: runtime.describe(c.resolved), signal: new AbortController().signal, deadlineAt: performance.now() + 10000 }, {
    startCall: at => new ModelCallRecorder({ startCall: () => {} }, runId, 'main', at), preview: () => {}, nativeTerminal: () => {}, inputStore: store,
  });
  const originalAppend = SessionManager.prototype.appendMessage;
  const corruptAppend = spyOn(SessionManager.prototype, 'appendMessage').mockImplementation(function(this: SessionManager, message) {
    if (message.role === 'user') throw new Error('native-append-corruption'); return originalAppend.call(this, message);
  });
  try { const observed = await execute(7, 41, 1); expect(observed.nativeIdle).toBe(true); expect(observed.inputSettlement?.unconfirmedInputIds).toEqual([1]); }
  finally { corruptAppend.mockRestore(); }
  expect(failureReasons).toEqual(['append_failed']); runtime.releaseInputFacts(41); runtime.releaseToolFacts(41);
  expect(runtime.read(7)).toMatchObject({ available: false, reason: 'native_state_invalid' });
  const before = nativeStreams; await expect(execute(7, 42, 2)).rejects.toThrow('session_history_invalid'); expect(nativeStreams).toBe(before);
  runtime.allocate().bind(8); expect((await execute(8, 43, 3)).nativeIdle).toBe(true); runtime.releaseInputFacts(43); runtime.releaseToolFacts(43);
  expect(runtime.read(8).available).toBe(true);
  rejectSave = true; const pending = await execute(8, 44, 4);
  expect(pending.inputSettlement?.pendingPersistence).toBe(true); expect(runtime.read(8).available).toBe(true);
  const users = runtime.read(8).messages.filter(message => message.role === 'user'); const entry = users.at(-1)!.nativeEntryId;
  rejectSave = false; runtime.retryInputPersistence(44); expect(runtime.inputPersistencePending(44)).toBe(false);
  expect(consumption.find(fact => fact.inputId === 4)?.nativeEntryId).toBe(entry);
  runtime.releaseInputFacts(44); runtime.releaseToolFacts(44);
  expect(runtime.read(8).available).toBe(true); expect((await execute(8, 45, 5)).nativeIdle).toBe(true); runtime.releaseInputFacts(45); runtime.releaseToolFacts(45);
});
