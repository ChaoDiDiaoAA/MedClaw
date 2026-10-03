import { expect, test } from 'bun:test';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { RunScopeSchema } from '../../packages/contracts/src/run';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteToolStore, initializeToolStorage } from '../../packages/storage/src/tool-store';
import { ToolRegistry } from '../../packages/core/src/tools/registry';
import { ToolRecorder } from '../../packages/core/src/tools/recorder';
import { ToolExecutor } from '../../packages/core/src/tools/executor';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { QueryService } from '../../packages/core/src/data/query-service';
import { createQueryCurrentDevicesTool } from '../../packages/core/src/tools/business-tools/query-current-devices';
import { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { ModelCallRecorder } from '../../packages/runtime-pi/src/model-call-recorder';
import { SubmitInputSchema } from '../../packages/contracts/src/session';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { Application } from '../../packages/core/src/application';
import type { ResolvedModel } from '../../packages/runtime-pi/src/model-runtime';
import type { RuntimeNotice } from '../../packages/contracts/src/protocol';

test('production PiAgentRuntime executes business and native tools in one frozen Run, then records a final model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p3-runtime-'));
  const db = openDatabase(join(root, 'app.sqlite'));
  if (!db.query("SELECT name FROM sqlite_schema WHERE name='tool_calls'").get()) initializeToolStorage(db);
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    requests.push(body);
    const delta = requests.length === 1 ? { role: 'assistant', tool_calls: [
      { index: 0, id: 'scope-call', type: 'function', function: { name: 'read_data_scope', arguments: '{}' } },
      { index: 1, id: 'write-call', type: 'function', function: { name: 'write', arguments: '{"path":"proof.txt","content":"actual agent write"}' } },
    ] } : { role: 'assistant', content: 'Scope and file verified.' };
    return new Response(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const repo = new Repositories(db), store = new SqliteToolStore(db);
    const registry = new ToolRegistry([{
      name: 'read_data_scope', version: '1.0.0', label: 'Read scope', description: 'Read the accepted scope.',
      inputSchema: RunScopeSchema.pick({}), outputSchema: RunScopeSchema.pick({ batchIds: true }), effect: 'READ', executionMode: 'parallel',
      execute: async (_input, context) => ({ batchIds: context.scope.batchIds }),
    }, createQueryCurrentDevicesTool({ queries: new QueryService(new CatalogService({ batches: [], devices: [], snapshots: [], changes: [] }), store) })]);
    const recorder = new ToolRecorder(store), executor = new ToolExecutor(registry, recorder);
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('p3-runtime', async () => ({ type: 'api_key', key: 'fixture' }));
    const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
    await runtime.installCustom([{ providerId: 'p3-runtime', name: 'Runtime fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`,
      models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024,
        outputLimitConfirmed: true, pricingKnown: false, cost: null }] }]);
    const agent = new PiAgentRuntime(runtime, root, { registry, recorder, executor });
    const native = agent.allocate(), session = repo.createSession({ expectedWorkspaceRevision: 0 }, 'create', native.nativeSessionId, new Date().toISOString()).session;
    native.bind(session.id);
    const workspace = repo.readWorkspace(), scope = repo.freezeAgentScope(workspace, agent.toolNames ?? []);
    const request = SubmitInputSchema.parse({ sessionId: session.id, clientSequence: 1, text: 'Read my scope and write a proof file.', mode: 'send',
      expectedRevision: workspace.revision, expectedBatchIds: [], expectedQueryId: null,
      model: { provider: 'p3-runtime', modelId: 'fixture', expectedConfigVersion: '1' }, referenceDate: '2026-01-01', timezone: 'Asia/Shanghai' });
    const policy = { timeoutMs: 10000, maxRetries: 0 as const, maxRetryDelayMs: 2000 };
    const agentPolicy = { version: 'medclaw.agent-policy/v1' as const, maxToolCalls: 24, maxModelCalls: 2, singleToolTimeoutMs: 30000, maxRecoveryAttempts: 2 };
    const resolved = await runtime.resolve(request.model, '1', null, policy), agentOptions = agent.describe(resolved);
    const accepted = repo.registerAgent({ sessionId: session.id, inputId: null, text: request.text, model: resolved.selection, policy, goal: 'answer',
      workspace, scope, referenceDate: request.referenceDate, timezone: request.timezone, timeoutMs: policy.timeoutMs, agentOptions, agentPolicy,
      submission: { operationRef: 'send', originalSubmitInput: request }, instanceId: 'instance', createdAt: new Date().toISOString() });
    const observed = await agent.execute({ runId: accepted.runId, sessionId: session.id, text: request.text, resolved, agentOptions,
      scope, referenceDate: request.referenceDate, timezone: request.timezone, agentPolicy, signal: new AbortController().signal, deadlineAt: performance.now() + 10000 }, {
      startCall: time => new ModelCallRecorder(repo, accepted.runId, 'main', time), preview: () => {}, nativeTerminal: () => {},
    });
    expect(observed.lastOutcome).toMatchObject({ text: 'Scope and file verified.', error: null });
    expect(observed.calls).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.tools).toEqual([]);
    expect(observed.budgetSummary).toMatchObject({ toolCalls: 2, modelCalls: 2 });
    const providerMessages: unknown[] = Array.isArray(requests[0]!.messages) ? requests[0]!.messages : [];
    const systemPrompt = providerMessages.flatMap(message => message !== null && typeof message === 'object'
      && 'role' in message && message.role === 'system' && 'content' in message && typeof message.content === 'string' ? [message.content] : []).join('\n');
    for (const constraint of [
      /explicit (?:user )?dates?.{0,100}(?:precedence|priority).{0,100}referenceDate/i,
      /today.{0,100}(?:now|current).{0,100}frozen referenceDate/i,
      /(?:never|do not).{0,100}(?:system clock|wall clock)/i,
      /requestedDate.{0,100}requestedTime/i,
      /actual dataDates/i,
      /basis.{0,100}status.{0,100}quantity.{0,100}unit/i,
      /snapshot records.{0,150}(?:identifiers.{0,80}scope|scope.{0,80}identifiers).{0,100}events/i,
      /(?:not|never).{0,100}physical (?:units|device units).{0,100}inventory/i,
      /(?:missing|without|no).{0,100}quantity.{0,100}(?:cannot|unknown)/i,
      /\bas_of\b.{0,40}latest snapshot.{0,250}(?:not|never).{0,100}(?:cumulative|historical accumulation)/i,
      /(?:never|do not).{0,100}(?:sum|add).{0,100}(?:dates|batches)/i,
      /target.date.{0,100}unknown/i,
      /equal counts.{0,100}(?:do not|cannot).{0,100}(?:same|identical).{0,100}(?:set|identifiers)/i,
      /status.{0,100}(?:omitted|unspecified|not specified).{0,100}all/i,
    ]) expect(systemPrompt).toMatch(constraint);
    expect(systemPrompt).not.toMatch(/\bas_of_latest\b/i);
    const providerTools: unknown[] = Array.isArray(requests[0]!.tools) ? requests[0]!.tools : [];
    const currentDescription = providerTools.flatMap(tool => tool !== null && typeof tool === 'object' && 'function' in tool
      && tool.function !== null && typeof tool.function === 'object' && 'name' in tool.function && tool.function.name === 'query_current_devices'
      && 'description' in tool.function && typeof tool.function.description === 'string' ? [tool.function.description] : [])[0];
    expect(currentDescription).toBeDefined();
    for (const constraint of [
      /explicit.{0,100}(?:precedence|priority).{0,100}reference date/i,
      /\bas_of\b.{0,40}latest snapshot.{0,250}(?:not|never).{0,100}(?:cumulative|historical accumulation)/i,
      /interpretation.{0,200}requestedDate.{0,100}dataDates/i,
      /snapshot records.{0,200}(?:not|never).{0,100}(?:inventory|physical)/i,
      /status.{0,100}(?:omitted|unspecified|not specified).{0,100}all/i,
    ]) expect(currentDescription).toMatch(constraint);
    expect(currentDescription).not.toMatch(/\bas_of_latest\b/i);
    expect(JSON.stringify(requests[1]!.messages)).toContain('scope-call');
    expect(await readFile(join(root, 'runtime', String(accepted.runId), 'work', 'scratch', 'proof.txt'), 'utf8')).toBe('actual agent write');
    expect(db.query('SELECT tool_name,status FROM tool_calls ORDER BY id').all()).toEqual([
      { tool_name: 'read_data_scope', status: 'succeeded' }, { tool_name: 'write', status: 'succeeded' },
    ]);
    const recorded = store.readCall({ runId: accepted.runId, sessionId: session.id, nativeToolCallId: 'write-call', scope,
      referenceDate: request.referenceDate, timezone: request.timezone, signal: new AbortController().signal });
    expect(recorded?.modelCallId).toBe(observed.calls[0]!.callId);
    expect(recorded?.nextModelCallId).toBe(observed.calls[1]!.callId);
    expect(recorded?.consumptionEvidence).toBe('provider_input_verified');
    expect(recorded?.sdkDelivery?.toolCallId).toBe('write-call');
    const endedAt = new Date().toISOString();
    const fact = { status: 'completed' as const, outputText: observed.lastOutcome!.text, stoppedAt: endedAt, endedAt,
      error: null, calls: observed.calls, cleanup: { contract: 'medclaw.run-cleanup/v1' as const, executionStarted: true, stopConfirmed: true,
        requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: true, unconfirmedItems: [], secondaryErrors: [], verifiedAt: endedAt } };
    const faulty = new Repositories(db, () => { throw new Error('injected final transaction failure'); });
    expect(() => faulty.finalizeAgent(accepted.runId, fact)).toThrow('injected final transaction failure');
    expect(db.query('SELECT count(*) n FROM answers').get()).toEqual({ n: 0 });
    expect(db.query('SELECT status FROM runs WHERE id=?').get(accepted.runId)).toEqual({ status: 'running' });
    const final = repo.finalizeAgent(accepted.runId, fact);
    expect(final.answerRef).toBeGreaterThan(0);
    expect(repo.isFinalSaved(accepted.runId, fact)).toBe(true);
    expect(db.query('SELECT text,native_leaf_id FROM answers WHERE run_id=?').get(accepted.runId)).toEqual({ text: observed.lastOutcome!.text, native_leaf_id: null });
  } finally { server.stop(true); db.close(); await rm(root, { recursive: true, force: true }); }
}, 15000);

test.each(['request-before-commit', 'request-after-commit', 'result', 'delivery', 'consumption-before-commit', 'consumption-after-commit',
  'consumption-before-commit-second-retry', 'consumption-after-commit-second-retry'] as const)('necessary %s save failure retains the root and retry saves facts without another native effect', async fault => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p3-save-')), db = openDatabase(join(root, 'app.sqlite'));
  let requests = 0;
  const batchConsumption = fault.startsWith('consumption'), payloads: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    payloads.push(await request.json() as Record<string, unknown>); requests++;
    const delta = requests === 1 ? { role: 'assistant', tool_calls: [
      { index: 0, id: 'write-1', type: 'function', function: { name: 'write', arguments: '{"path":"proof.txt","content":"one real effect"}' } },
      ...(batchConsumption ? [{ index: 1, id: 'write-2', type: 'function', function: { name: 'write', arguments: '{"path":"proof-second.txt","content":"second real effect"}' } }] : []),
    ] } : { role: 'assistant', content: 'Done' };
    return new Response(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  let app: Application<ResolvedModel> | undefined;
  try {
    const repo = new Repositories(db), store = new SqliteToolStore(db), registry = new ToolRegistry([]), notices: RuntimeNotice[] = [];
    const originalRequest = store.request.bind(store), originalTransition = store.transition.bind(store), originalDelivery = store.recordDelivery.bind(store);
    const originalConsumption = store.recordConsumption.bind(store);
    let originalEvidence: Parameters<typeof store.recordConsumption> | undefined;
    let failing = true, secondRetryFailure = fault.endsWith('second-retry');
    store.request = (...args) => {
      if (failing && fault.startsWith('request')) {
        if (fault === 'request-after-commit') originalRequest(...args);
        throw new Error('storage_write_failed');
      }
      return originalRequest(...args);
    };
    store.transition = (...args) => { if (failing && fault === 'result' && args[2] === 'succeeded') throw new Error('storage_write_failed'); return originalTransition(...args); };
    store.recordDelivery = (...args) => { if (failing && fault === 'delivery') throw new Error('storage_write_failed'); return originalDelivery(...args); };
    store.recordConsumption = (...args) => {
      if (failing && batchConsumption && args[0].nativeToolCallId === 'write-1') {
        originalEvidence ??= args;
        if (fault.includes('after-commit')) originalConsumption(...args);
        throw new Error('storage_write_failed');
      }
      if (!failing && secondRetryFailure && args[0].nativeToolCallId === 'write-2') throw new Error('storage_write_failed');
      return originalConsumption(...args);
    };
    const recorder = new ToolRecorder(store, (error, context) => app?.runs.failToolPersistence(context.runId, error));
    const credentials = new InMemoryCredentialStore(); await credentials.modify('p3-save', async () => ({ type: 'api_key', key: 'fixture' }));
    const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
    const definition = { providerId: 'p3-save', name: 'Save fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`,
      models: [{ id: 'fixture', name: 'Fixture', input: ['text' as const], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true as const, pricingKnown: false, cost: null }] };
    await runtime.installCustom([definition]);
    const policy = { timeoutMs: 10000, maxRetries: 0 as const, maxRetryDelayMs: 2000 };
    const settings = PublishedSettingsSchema.parse({ schemaVersion: 'medclaw.settings/p1-v1', configVersion: '1', model: { provider: 'p3-save', modelId: 'fixture' },
      customProviders: [{ definition, credentialRef: null }], credentialRefs: {}, requestPolicy: policy,
      ui: { navCollapsed: false, detailOpen: false, detailTab: 'conditions' }, previous: null, rollbackFromVersion: null });
    const agent = new PiAgentRuntime(runtime, root, { registry, recorder, executor: new ToolExecutor(registry, recorder) });
    app = new Application('instance', settings, runtime, repo, (_context, action) => action(), (runId, kind, time) => new ModelCallRecorder(repo, runId, kind, time), notice => notices.push(notice), undefined, agent);
    const native = agent.allocate(), session = repo.createSession({ expectedWorkspaceRevision: 0 }, 'create', native.nativeSessionId, new Date().toISOString()).session; native.bind(session.id);
    const input = SubmitInputSchema.parse({ sessionId: session.id, clientSequence: 1, text: 'Write the proof once.', mode: 'send', expectedRevision: 1, expectedBatchIds: [], expectedQueryId: null,
      model: { provider: 'p3-save', modelId: 'fixture', expectedConfigVersion: '1' }, referenceDate: '2026-01-01', timezone: 'Asia/Shanghai' });
    const accepted = await app.runs.submitAgent(input, { instanceId: 'instance', operationRef: 'send' });
    if (!accepted.ok) throw accepted.error;
    const until = Date.now() + 5000;
    while (!notices.some(notice => notice.type === 'agent.persistence_failed') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    expect(notices.some(notice => notice.type === 'agent.persistence_failed')).toBe(true);
    expect(await app.runs.readControl()).toMatchObject({ ok: true, data: { acceptingNewRuns: false, activeRootRun: { runId: accepted.data.runId } } });
    expect(db.query('SELECT status FROM runs WHERE id=?').get(accepted.data.runId)).toEqual({ status: 'failed' });
    if (!fault.startsWith('request')) expect(await readFile(join(root, 'runtime', String(accepted.data.runId), 'work', 'scratch', 'proof.txt'), 'utf8')).toBe('one real effect');
    expect(requests).toBe(fault.startsWith('consumption') ? 2 : 1);
    if (originalEvidence) {
      expect(originalEvidence[2]).toBe('provider_input_verified');
      expect(store.readCall(originalEvidence[0])).toMatchObject({ status: 'succeeded', sdkReturned: true, nativeToolCallId: 'write-1' });
      expect(store.readCall(originalEvidence[0])?.consumptionEvidence).toBe(fault.includes('after-commit') ? 'provider_input_verified' : undefined);
    }
    const originalReceipts = batchConsumption ? ['write-1', 'write-2'].map(nativeToolCallId => store.readCall({ ...originalEvidence![0], nativeToolCallId })!) : [];
    const work = join(root, 'runtime', String(accepted.data.runId), 'work', 'scratch');
    const originalFileTimes = batchConsumption ? await Promise.all(['proof.txt', 'proof-second.txt'].map(async name => (await stat(join(work, name), { bigint: true })).mtimeNs)) : [];
    if (batchConsumption) {
      expect(await readFile(join(work, 'proof-second.txt'), 'utf8')).toBe('second real effect');
      expect(originalReceipts).toHaveLength(2);
      for (const record of originalReceipts) {
        expect(record).toMatchObject({ status: 'succeeded', sdkReturned: true });
        expect(record.nativeEntryId).toBeTruthy();
        const text = record.sdkDelivery!.content.map(part => (part as { text: string }).text).join('\n');
        expect(payloads[1]!.messages).toEqual(expect.arrayContaining([{ role: 'tool', tool_call_id: record.nativeToolCallId, content: text }]));
      }
      expect(recorder.persistencePending(accepted.data.runId)).toBe(true);
    }
    failing = false;
    if (secondRetryFailure) {
      expect(await app.runs.retrySave(accepted.data.runId)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
      expect(await app.runs.readControl()).toMatchObject({ ok: true, data: { acceptingNewRuns: false, activeRootRun: { runId: accepted.data.runId } } });
      expect(recorder.persistencePending(accepted.data.runId)).toBe(true);
      expect(store.readCall({ ...originalEvidence![0], nativeToolCallId: 'write-1' })).toMatchObject({ nextModelCallId: originalEvidence![1], consumptionEvidence: 'provider_input_verified' });
      expect(store.readCall({ ...originalEvidence![0], nativeToolCallId: 'write-2' })?.consumptionEvidence).toBeUndefined();
      expect(requests).toBe(2);
      secondRetryFailure = false;
    }
    expect(await app.runs.retrySave(accepted.data.runId)).toMatchObject({ ok: true, data: { status: 'failed', cleanup: { stopConfirmed: true, requiredPersistenceComplete: true } } });
    expect(db.query('SELECT tool_name,status FROM tool_calls').all()).toEqual([
      { tool_name: 'write', status: fault.startsWith('request') ? 'failed' : 'succeeded' },
      ...(batchConsumption ? [{ tool_name: 'write', status: 'succeeded' }] : []),
    ]);
    expect(await app.runs.readControl()).toMatchObject({ ok: true, data: { acceptingNewRuns: true } });
    expect(requests).toBe(fault.startsWith('consumption') ? 2 : 1);
    if (originalEvidence) {
      expect(store.readCall(originalEvidence[0])).toMatchObject({ nextModelCallId: originalEvidence[1], consumptionEvidence: 'provider_input_verified',
        status: 'succeeded', sdkReturned: true });
      expect(await readFile(join(root, 'runtime', String(accepted.data.runId), 'work', 'scratch', 'proof.txt'), 'utf8')).toBe('one real effect');
      expect(db.query('SELECT COUNT(*) n FROM model_calls').get()).toEqual({ n: 2 });
      expect(db.query('SELECT COUNT(*) n FROM tool_calls').get()).toEqual({ n: 2 });
      for (const original of originalReceipts) {
        const saved = store.readCall({ ...originalEvidence[0], nativeToolCallId: original.nativeToolCallId })!;
        expect(saved).toMatchObject({ nextModelCallId: originalEvidence[1], consumptionEvidence: 'provider_input_verified',
          status: 'succeeded', sdkReturned: true, nativeEntryId: original.nativeEntryId });
        expect(saved.sdkDelivery).toEqual(original.sdkDelivery);
      }
      expect(await Promise.all(['proof.txt', 'proof-second.txt'].map(async name => (await stat(join(work, name), { bigint: true })).mtimeNs))).toEqual(originalFileTimes);
      expect(recorder.persistencePending(accepted.data.runId)).toBe(false);
    }
  } finally { try { await app?.shutdown(); } finally { server.stop(true); db.close(); await rm(root, { recursive: true, force: true }); } }
}, 15000);
