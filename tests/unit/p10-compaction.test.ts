import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, estimateTokens, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { discoverTests } from '../run';
import { memoryAssistant } from '../fixtures/p9-memory';
import { publicMethodSchemas, HOST_PROTOCOL_VERSION, DATABASE_SCHEMA_VERSION, PublicHostRequestSchema } from '../../packages/contracts/src/protocol';
import { safeError } from '../../packages/contracts/src/error';
import { RunControl } from '../../packages/core/src/runtime/run-control';
import { RUNTIME_CONFIG } from '../../packages/contracts/src/runtime-config';
import { ModelCallRecorder } from '../../packages/runtime-pi/src/model-call-recorder';
import { PiMemoryAdapter } from '../../packages/runtime-pi/src/memory-store';
import { CompactionAdapter } from '../../packages/runtime-pi/src/compaction-adapter';
import { DEFAULT_REQUEST_POLICY } from '../../packages/contracts/src/model';
import { contextModel } from '../fixtures/p8-context';
import { projectSessionMessages } from '../../packages/runtime-pi/src/messages';
import { MAX_MESSAGE_TEXT_CHARS } from '../../packages/contracts/src/messages';

test('p10 native summary stays a bounded history marker with its original identity',()=>{
  const manager=SessionManager.inMemory(process.cwd()),input=manager.appendMessage({role:'user',content:'ENGINEERING original',timestamp:1});
  const id=manager.appendCompaction('ENGINEERING summary '+ 'x'.repeat(MAX_MESSAGE_TEXT_CHARS),input,10);
  const page=projectSessionMessages(manager,{sessionId:1,leafId:null,afterEntryId:null,limit:50},new Map());
  expect(page.items.at(-1)).toMatchObject({nativeEntryId:id,entryType:'compaction',displayRole:'history_marker',runId:null,textInfo:{truncated:true,redacted:false}});
  expect(page.items.at(-1)!.text).toContain('ENGINEERING summary');expect(page.items.at(-1)!.text!.length).toBeLessThanOrEqual(MAX_MESSAGE_TEXT_CHARS);
});

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
  const frame = { protocolVersion: 'medclaw.host/p14-v1', kind: 'request', requestId: 'request', instanceId: 'host', operationRef: 'manual', method: 'session.compact', payload: input };
  expect(PublicHostRequestSchema.safeParse(frame).success).toBe(true);
  expect(PublicHostRequestSchema.safeParse({ ...frame, protocolVersion: 'medclaw.host/p9-v1' }).success).toBe(false);
  expect(HOST_PROTOCOL_VERSION).toBe('medclaw.host/p14-v1'); expect(DATABASE_SCHEMA_VERSION).toBe(13);
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

test('p10 compaction admissions consume the same model budget and invalidate stale main previews without advancing tool recovery', () => {
  const runtimeConfiguration = structuredClone(RUNTIME_CONFIG); runtimeConfiguration.runBudget.maxModelCalls = 2;
  const control = new RunControl({runId:1,runtimeConfiguration,scope:{batchIds:[],deviceIds:null,allowedToolNames:[],allowedResourceRefs:[],artifactIds:[],readOnly:true},signal:new AbortController().signal,deadlineAt:performance.now()+10000});
  try {
    const admit = Reflect.get(control,'admitCompactionCall'); expect(admit).toBeDefined();
    const preview = control.previewModelCall(), before = control.readBudget();
    admit.call(control); expect(()=>control.admitModelCall(preview)).toThrow('state_conflict');
    const after = control.readBudget(); expect(after.modelCalls).toMatchObject({used:1,remaining:1});
    expect(after.recovery).toEqual(before.recovery); expect(after.toolCalls).toEqual(before.toolCalls);
    admit.call(control); expect(()=>admit.call(control)).toThrow('agent_call_limit');
    expect(control.summary()).toMatchObject({modelCalls:2,recoveryAttempts:0});
  } finally {control.dispose();}
});

test('p10 compaction recorder preserves the genuine null Run owner and one logical request identity', () => {
  const factory = Reflect.get(ModelCallRecorder,'forCompaction'); expect(factory).toBeDefined();
  const starts: unknown[] = [], owner = {operationRef:'manual',sessionId:1,runId:null,source:'manual' as const,reason:'manual' as const,model:contextModel,baseStorageVersion:1,baseLeafId:null,ordinal:1};
  const recorder = factory.call(ModelCallRecorder,{startCompactionCall:(input:unknown)=>starts.push(input)},owner,'2026-10-06T00:00:00.000Z');
  expect(starts).toEqual([{callId:recorder.callId,owner,startedAt:'2026-10-06T00:00:00.000Z'}]);
  const fact = recorder.finish({sdkStopReason:'stop',text:'ENGINEERING summary',responseModel:'fixture',callState:'completed',usage:{inputTokens:10,outputTokens:2,cost:null,costCurrency:null,source:'pi_normalized',unavailableReason:'pricing_unknown'},error:null},'2026-10-06T00:00:01.000Z');
  expect(fact).toMatchObject({callId:recorder.callId,state:'completed',inputTokens:10,outputTokens:2,cost:null,unavailableReason:'pricing_unknown'});
  expect(Reflect.has(fact,'text')).toBe(false); expect(fact.durationMs).toBeGreaterThanOrEqual(0);
  expect(()=>factory.call(ModelCallRecorder,{startCompactionCall:()=>{throw new Error('storage_write_failed');}},owner,'2026-10-06T00:00:00.000Z')).toThrow('storage_write_failed');
});

test('p10 compaction hold protects the candidate answer and native extensions until explicit acknowledgement', () => {
  const manager = SessionManager.inMemory(process.cwd()), commits: unknown[] = [];
  const memory = new PiMemoryAdapter(manager,{snapshot:{sessionId:1,nativeSessionId:manager.getSessionId(),header:manager.getHeader(),entries:[],activeLeafId:null,storageVersion:1},
    getRunId:()=>10,commitSync:change=>{commits.push(change);return {storageVersion:commits.length+1};},onFailure:()=>{}});
  const user = manager.appendMessage({role:'user',content:'ENGINEERING original',timestamp:1});
  const answer = manager.appendMessage(memoryAssistant('ENGINEERING candidate'));
  const begin = Reflect.get(memory,'beginCompaction'); expect(begin).toBeDefined(); begin.call(memory,'auto');
  const compaction = manager.appendCompaction('ENGINEERING summary',user,50,{original:['query:12']},false,memoryAssistant().usage);
  manager.appendMessage({role:'user',content:'ENGINEERING queued',timestamp:3});
  expect(commits).toHaveLength(1); expect(()=>memory.flushBeforeRequest()).toThrow();
  const change = Reflect.get(memory,'readCompactionCommit').call(memory,'auto');
  expect(change.newEntries.map((entry:{id:string})=>entry.id)).toEqual([answer,compaction,manager.getLeafId()!]);
  expect(change.newEntries[1]).toMatchObject({details:{original:['query:12']},usage:memoryAssistant().usage});
  Reflect.get(memory,'acknowledgeCompaction').call(memory,change,3);
  memory.flushBeforeRequest(); expect(commits).toHaveLength(1); memory.dispose();
});

for (const mode of ['success','budget','registration'] as const) test(`p10 summary adapter ${mode} keeps SDK request sizing, genuine facts and staged history`, async () => {
  const f=await nativeFixture(), requests:{maxTokens:number|undefined;hasFeedback:boolean}[]=[], facts:import('../../packages/contracts/src/run').FinalCallFact[]=[], starts:unknown[]=[];
  const memory=new PiMemoryAdapter(f.manager,{snapshot:{sessionId:1,nativeSessionId:f.manager.getSessionId(),header:f.manager.getHeader(),entries:f.manager.getEntries(),activeLeafId:f.manager.getLeafId(),storageVersion:2},
    getRunId:()=>null,commitSync:()=>{throw new Error('No ordinary commit allowed');},onFailure:()=>{}});
  const frozen={model:contextModel,baseStorageVersion:2,baseLeafId:f.manager.getLeafId(),settings:{enabled:true,reserveTokens:256,keepRecentTokens:128},budget:{maxModelCalls:mode==='budget'?1:4,timeoutMs:5000},instanceId:'host',startedAt:'2026-10-06T00:00:00.000Z'};
  const adapter=new CompactionAdapter(f.session,f.manager,memory,{kind:'manual',input:{operationRef:'manual',sessionId:1,resolved:{selection:contextModel,model:f.session.model!,policy:DEFAULT_REQUEST_POLICY,pricingKnown:false},frozen,signal:new AbortController().signal,deadlineAt:performance.now()+5000},
    callbacks:{startCall:(time,ordinal)=>{if(mode==='registration')throw new Error('storage_write_failed');return ModelCallRecorder.forCompaction({startCompactionCall:value=>starts.push(value)},
      {operationRef:'manual',sessionId:1,runId:null,source:'manual',reason:'manual',model:contextModel,baseStorageVersion:2,baseLeafId:frozen.baseLeafId,ordinal},time);},finishCall:fact=>facts.push(fact),progress:()=>{}}},
    (_model,context,options)=>{requests.push({maxTokens:options?.maxTokens,hasFeedback:JSON.stringify(context).includes('MedClaw trusted runtime feedback')});return streamMessage(response('ENGINEERING summary'));});
  const stop=f.session.subscribe(event=>adapter.onNativeEvent(event)); f.session.agent.streamFunction=(model,context,options)=>adapter.streamSummary(model,context,options);
  try {
    const observed=await adapter.runManual();
    expect(observed.nativeIdle).toBe(true); expect(requests).toHaveLength(mode==='success'?2:mode==='budget'?1:0); expect(facts).toHaveLength(requests.length); expect(starts).toHaveLength(requests.length);
    expect(requests.every(request=>request.maxTokens!==contextModel.maxOutputTokens&&!request.hasFeedback)).toBe(true);
    expect(observed.nativeGenerated).toBe(mode==='success'); expect(observed.result.callIds).toEqual(facts.map(fact=>fact.callId));
    if(mode==='success')expect(observed.change?.newEntries).toHaveLength(1);else expect(observed.result.error?.code).toBe(mode==='budget'?'agent_call_limit':'storage_write_failed');
    expect(()=>memory.dispose()).toThrow();
  } finally {stop();}
});

test('p10 saved split-turn proof permits the summarized original input but excludes edits, uncommitted entries and other branches', () => {
  const manager=SessionManager.inMemory(process.cwd()),user=manager.appendMessage({role:'user',content:'ENGINEERING original',timestamp:1}),answer=manager.appendMessage(memoryAssistant());
  const check=()=>{
    const memory=new PiMemoryAdapter(manager,{snapshot:{sessionId:1,nativeSessionId:manager.getSessionId(),header:manager.getHeader(),entries:manager.getEntries(),activeLeafId:manager.getLeafId(),storageVersion:3},getRunId:()=>null,commitSync:()=>{throw new Error('No writes');},onFailure:()=>{}});
    try{return {onBranch:memory.isSavedInputOnBranch(user,'ENGINEERING original'),summarized:memory.isSavedSummarizedInput(user),position:memory.readSavedContext()};}finally{memory.dispose();}
  };
  const compaction=manager.appendCompaction('ENGINEERING original summarized',answer,10);
  expect(check()).toMatchObject({onBranch:true,summarized:true,position:{leafId:compaction,storageVersion:3,compactionEntryIds:[compaction]}});
  manager.appendContextEdit(user,null);expect(check()).toMatchObject({onBranch:false,summarized:false});
  manager.resetLeaf();manager.appendMessage({role:'user',content:'ENGINEERING other branch',timestamp:3});
  expect(check()).toMatchObject({onBranch:false,summarized:false});
});

for (const mode of ['success','budget','save_failure','capacity'] as const) test(`p10 automatic ${mode} preserves original Run budget and saves before overflow continuation`, async () => {
  const f=await nativeFixture(),facts:(import('../../packages/contracts/src/run').FinalCallFact|null)[]=[],requests:string[]=[],saved:unknown[]=[],errors:unknown[]=[];
  let storageVersion=2;
  const memory=new PiMemoryAdapter(f.manager,{snapshot:{sessionId:1,nativeSessionId:f.manager.getSessionId(),header:f.manager.getHeader(),entries:f.manager.getEntries(),activeLeafId:f.manager.getLeafId(),storageVersion},
    getRunId:()=>10,commitSync:()=>({storageVersion:++storageVersion}),onFailure:()=>{}});
  const config=structuredClone(RUNTIME_CONFIG);config.runBudget.maxModelCalls=mode==='budget'?2:4;
  const controller=new AbortController(),deadlineAt=performance.now()+5000,control=new RunControl({runId:10,runtimeConfiguration:config,scope:{batchIds:[],deviceIds:null,allowedToolNames:[],allowedResourceRefs:[],artifactIds:[],readOnly:true},signal:controller.signal,deadlineAt});
  const adapter=new CompactionAdapter(f.session,f.manager,memory,{kind:'auto',input:{runId:10,sessionId:1,text:'ENGINEERING',resolved:{selection:contextModel,model:f.session.model!,policy:DEFAULT_REQUEST_POLICY,pricingKnown:false},
    agentOptions:{requestedThinkingLevel:'off',effectiveThinkingLevel:'off',compaction:{contract:'medclaw.compaction/v1',enabled:true,reserveTokens:256,keepRecentTokens:128}},signal:controller.signal,deadlineAt},control,facts,
    callbacks:{begin:()=> 'automatic',startCall:(_op,time,ordinal)=>ModelCallRecorder.forCompaction({startCompactionCall:()=>{}},{operationRef:'automatic',sessionId:1,runId:10,source:'auto',reason:'overflow',model:contextModel,baseStorageVersion:storageVersion,baseLeafId:frozenLeaf,ordinal},time),
      finishCall:()=>{},progress:()=>{},failed:(_op,error)=>errors.push(error),save:(change,fact)=>{if(mode==='save_failure')throw safeError('storage_write_failed');saved.push({change,fact});return ++storageVersion;}}},
    ()=>{requests.push('summary');return streamMessage(response(mode==='capacity'?'ENGINEERING '.repeat(20000):'ENGINEERING summary'));});
  const frozenLeaf=f.manager.getLeafId(),stop=f.session.subscribe(event=>adapter.onNativeEvent(event));let mains=0;
  f.session.agent.streamFunction=async(model,context,options)=>{
    if(adapter.isSummarizing)return adapter.streamSummary(model,context,options);
    adapter.beforeMainRequest();memory.flushBeforeRequest();control.admitModelCall();requests.push('main');
    if(++mains===1)return streamMessage({...response('',0,'error'),errorMessage:'maximum context length exceeded'});
    expect(saved).toHaveLength(1);expect(memory.readSavedContext().compactionEntryIds).toHaveLength(1);return streamMessage(response('ENGINEERING main recovered'));
  };
  try {
    await f.session.prompt('ENGINEERING original input');await f.session.waitForIdle();await adapter.settle();
    expect(requests).toEqual(mode==='budget'?['main','summary']:mode==='save_failure'||mode==='capacity'?['main','summary','summary']:['main','summary','summary','main']);
    expect(control.summary().modelCalls).toBe(requests.length);expect(control.summary().recoveryAttempts).toBe(0);
    expect(facts.filter(Boolean)).toHaveLength(mode==='budget'?1:2);expect(saved).toHaveLength(mode==='success'||mode==='capacity'?1:0);
    if(mode==='budget')expect(errors).toMatchObject([{code:'agent_call_limit'}]);
    if(mode==='capacity')expect(errors).toMatchObject([{code:'compaction_failed',reason:'compaction_capacity'}]);
    if(mode==='success')expect((saved[0] as {change:{newEntries:{type:string}[]}}).change.newEntries.some(entry=>entry.type==='context_edit')).toBe(true);
  } finally {stop();control.dispose();}
});
