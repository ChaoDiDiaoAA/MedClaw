import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import { createResourceSource } from '../../packages/runtime-pi/src/resource-loader';
import { ModelCallRecorder } from '../../packages/runtime-pi/src/model-call-recorder';
import { contextMessageText } from '../../packages/runtime-pi/src/messages';
import { Application } from '../../packages/core/src/application';
import { ContextService } from '../../packages/core/src/context/context-service';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { QueryService } from '../../packages/core/src/data/query-service';
import { EvidenceReader } from '../../packages/core/src/evidence/evidence-reader';
import { createBusinessTools } from '../../packages/core/src/tools/tools';
import { ToolRegistry } from '../../packages/core/src/tools/registry';
import { ToolRecorder } from '../../packages/core/src/tools/recorder';
import { ToolExecutor } from '../../packages/core/src/tools/executor';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteContextStore } from '../../packages/storage/src/context-store';
import { SqliteCatalogStore } from '../../packages/storage/src/catalog-store';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { InputContentSchema, SubmitInputSchema, type SubmitInput } from '../../packages/contracts/src/session';
import { ResourceCatalogueSchema, resourceRefKey } from '../../packages/contracts/src/resources';
import { sqliteHistory } from '../fixtures/p9-memory';

async function fixture(respond?: (index: number) => Promise<Record<string, unknown>> | Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-runtime-')), author = join(root, 'author'); cpSync(resolve('resources'), author, { recursive: true });
  const db = openDatabase(join(root, 'app.sqlite')), requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>);
    const delta = await respond?.(requests.length) ?? { role: 'assistant', content: 'ENGINEERING response; no quality claim.' };
    return new Response(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const credentials = new InMemoryCredentialStore(); await credentials.modify('p11-fixture', async () => ({ type: 'api_key', key: 'engineering' }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  const definition = { providerId: 'p11-fixture', name: 'Engineering', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [{ id: 'fixture', name: 'Engineering', input: ['text' as const], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true as const, pricingKnown: false, cost: null }] };
  await runtime.installCustom([definition]);
  const history = sqliteHistory(db), repos = new Repositories(db, undefined, undefined, undefined, history.store), contexts = new SqliteContextStore(db);
  const catalog = new CatalogService(new SqliteCatalogStore(db)), toolStore = new SqliteToolStore(db), queries = new QueryService(catalog, toolStore), evidence = new EvidenceReader(catalog, queries, toolStore);
  const registry = new ToolRegistry(createBusinessTools({ catalog, queries, evidence })), errors: unknown[] = [], recorder = new ToolRecorder(toolStore, error => errors.push(error));
  const agent = new PiAgentRuntime(runtime, root, history, { registry, recorder, executor: new ToolExecutor(registry, recorder) }, new ContextService(contexts, { inspectManagedImport: async () => ({ status: 'valid' as const }) }));
  const allocated = agent.allocate(); repos.createSession({ expectedWorkspaceRevision: 0 }, 'create-a', allocated.nativeSessionId, new Date().toISOString(), allocated.history); allocated.bind(1);
  const catalogue = ResourceCatalogueSchema.parse(JSON.parse(readFileSync(join(author, 'catalog.json'), 'utf8'))), prompt = catalogue.definitions.find(r => r.kind === 'prompt')!, skill = catalogue.definitions.find(r => r.kind === 'skill')!;
  const ref = ({ kind, id, version, treeHash }: typeof prompt) => ({ kind, id, version, treeHash });
  const config = PublishedSettingsSchema.parse({ schemaVersion: 'medclaw.settings/p1-v1', configVersion: '1', model: { provider: 'p11-fixture', modelId: 'fixture' }, customProviders: [{ definition, credentialRef: null }], credentialRefs: {}, previous: null, rollbackFromVersion: null,
    requestPolicy: { timeoutMs: 15000, maxRetries: 0, maxRetryDelayMs: 2000 }, resources: { bySession: { '1': { prompt: ref(prompt), skills: [ref(skill)] } } } });
  const source = createResourceSource(author);
  const app = new Application('host', config, runtime, repos, async (_context, action) => action(), (runId, kind, at, context) => new ModelCallRecorder(repos, runId, kind, at, context), () => {}, error => errors.push(error), agent, undefined, undefined, source);
  const request = (text: string): SubmitInput => SubmitInputSchema.parse({ sessionId: 1, clientSequence: repos.readSession(1)!.nextSubmissionSequence, mode: 'send', text, expectedRevision: repos.readWorkspace().revision, expectedBatchIds: [], expectedQueryId: null, model: { provider: 'p11-fixture', modelId: 'fixture', expectedConfigVersion: app.config.configVersion }, referenceDate: '2026-10-06', timezone: 'Asia/Shanghai' });
  const settle = async () => { for (let i = 0; i < 2000 && app.runs.busy; i++) await Bun.sleep(2); expect(app.runs.busy).toBe(false); };
  const content = (id: number) => InputContentSchema.parse(JSON.parse(db.query<{ content_json: string }, [number]>('SELECT content_json FROM session_inputs WHERE id=?').get(id)!.content_json));
  return { root, author, db, requests, errors, app, agent, repos, contexts, source, prompt: ref(prompt), skill: ref(skill), request, settle, content,
    close: async () => { await app.runs.shutdown(); server.stop(true); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('p11 ordinary Send freezes author bytes and records the one real SDK expansion with unchanged raw input', async () => {
  const f = await fixture(); try {
    const raw = '"quote" C:\\case\n$1  whitespace', request = f.request(raw);
    const result = await f.app.runs.submitAgent(request, { instanceId: 'host', operationRef: 'send-original' });
    expect(result.ok).toBe(true); if (!result.ok || !result.data.inputId || !result.data.runId) throw new Error('No accepted input');
    await f.settle(); const inputId = result.data.inputId, runId = result.data.runId, saved = f.content(inputId), frozen = f.repos.readRunResources(runId)!;
    expect(saved.text).toBe(raw); expect(saved.originalSubmitInput).toEqual(request); expect(saved.resourceInputPlan?.kind).toBe('prompt');
    expect(frozen.selection).toEqual({ prompt: f.prompt, skills: [f.skill] }); expect(frozen.available).toHaveLength(2);
    expect(saved.scope.allowedResourceRefs).toEqual(frozen.available.map(s => resourceRefKey(s.ref)));
    expect(saved.nativeInput?.text).toContain(raw); expect(saved.nativeInput?.text).not.toBe(saved.resourceInputPlan?.dispatchText);
    expect(saved.nativeInput?.sha256).toBe(createHash('sha256').update(saved.nativeInput!.text).digest('hex'));
    expect(f.requests).toHaveLength(1); const messages = f.requests[0]!.messages as { role: string; content: unknown }[];
    expect(messages.filter(m => m.role === 'user' && contextMessageText(m.content) === saved.nativeInput!.text)).toHaveLength(1);
    expect(f.errors).toEqual([]); expect(f.repos.readInput({ inputId })).toMatchObject({ status: 'consumed', processingStatus: 'completed' });
    expect(await f.app.runs.submitAgent(request, { instanceId: 'host', operationRef: 'send-original' })).toEqual(result); expect(f.requests).toHaveLength(1);
    const call = f.db.query<{ call_id: string }, []>('SELECT call_id FROM model_calls').get()!;
    expect(f.contexts.read({ callId: call.call_id })).toMatchObject({ kind: 'snapshot', evidence: 'saved' });
    rmSync(f.author, { recursive: true }); expect((await f.app.resources!.read({ source: 'run', runId, resourceRef: f.prompt, file: 'query.md' })).content).toContain('$ARGUMENTS');
  } finally { await f.close(); }
}, 15000);

test('p11 disabling selected resources during a Run preserves its snapshot and applies to the next Run', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async index => { if (index === 1) await gate; return { role: 'assistant', content: 'ENGINEERING' }; });
  try {
    const first = await f.app.runs.submitAgent(f.request('first'), { instanceId: 'host', operationRef: 'active-first' });
    if (!first.ok || !first.data.runId || !first.data.inputId) throw new Error('No first Run');
    for (let i = 0; i < 1000 && f.requests.length === 0; i++) await Bun.sleep(2); expect(f.requests).toHaveLength(1);
    const { previous, rollbackFromVersion, ...old } = f.app.config;
    const candidate = { ...f.app.config, configVersion: '2', previous: old, resources: { bySession: { '1': { prompt: null, skills: [] } } } };
    await f.app.prepareConfig('disable-next', candidate); f.app.commitConfig('disable-next', '2');
    expect(f.repos.readRunResources(first.data.runId)?.configVersion).toBe('1'); expect(f.app.runs.activeHandle?.runId).toBe(first.data.runId);
    release(); await f.settle();
    const second = await f.app.runs.submitAgent(f.request('second'), { instanceId: 'host', operationRef: 'next-plain' });
    if (!second.ok || !second.data.runId || !second.data.inputId) throw new Error('No next Run'); await f.settle();
    expect(f.repos.readRunResources(second.data.runId)).toMatchObject({ configVersion: '2', available: [], selection: { prompt: null, skills: [] } });
    expect(f.content(first.data.inputId).nativeInput?.text).toContain('first'); expect(f.content(second.data.inputId).nativeInput?.text).toBe('second');
    expect(f.requests).toHaveLength(2); expect(f.errors).toEqual([]);
  } finally { release(); await f.close(); }
}, 15000);

test('p11 consecutive same-version Runs load their own frozen paths without duplicating Prompt content', async () => {
  const f = await fixture(); try {
    const accepted: { runId: number; inputId: number }[] = [];
    for (const operationRef of ['same-one', 'same-two']) {
      const result = await f.app.runs.submitAgent(f.request('same'), { instanceId: 'host', operationRef });
      if (!result.ok || !result.data.runId || !result.data.inputId) throw new Error('No Run'); accepted.push({ runId: result.data.runId, inputId: result.data.inputId }); await f.settle();
    }
    for (const run of accepted) expect(readFileSync(join(f.root, 'runtime', String(run.runId), 'work', 'scratch', 'resources', 'prompts/query/v1/query.md'), 'utf8')).toContain('$ARGUMENTS');
    const text = f.content(accepted[0]!.inputId).nativeInput!.text;
    expect(f.content(accepted[1]!.inputId).nativeInput!.text).toBe(text);
    expect((f.requests[0]!.messages as { role: string; content: unknown }[]).filter(m => m.role === 'user' && contextMessageText(m.content) === text)).toHaveLength(1);
    expect((f.requests[1]!.messages as { role: string; content: unknown }[]).filter(m => m.role === 'user' && contextMessageText(m.content) === text)).toHaveLength(2);
    expect(f.errors).toEqual([]); expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
}, 15000);

test('p11 required missing Prompt rejects admission while omitted optional Skill permits an unrelated Send', async () => {
  const f = await fixture(); try {
    rmSync(join(f.author, 'prompts/query/v1/query.md'));
    expect(await f.app.runs.submitAgent(f.request('requires prompt'), { instanceId: 'host', operationRef: 'missing-prompt' })).toMatchObject({ ok: false, error: { code: 'resource_unavailable', reason: 'resource_missing' } });
    expect(f.db.query('SELECT * FROM runs').all()).toHaveLength(0); expect(f.db.query('SELECT * FROM session_inputs').all()).toHaveLength(0); expect(f.requests).toHaveLength(0);
    const { previous, rollbackFromVersion, ...old } = f.app.config;
    const candidate = { ...f.app.config, configVersion: '2', previous: old, resources: { bySession: { '1': { prompt: null, skills: [f.skill] } } } };
    await f.app.prepareConfig('disable-bad-prompt', candidate); f.app.commitConfig('disable-bad-prompt', '2'); rmSync(join(f.author, 'skills/query/v1/SKILL.md'));
    expect(await f.app.runs.submitAgent(f.request('/skill:query required'), { instanceId: 'host', operationRef: 'missing-skill' })).toMatchObject({ ok: false, error: { code: 'resource_unavailable', reason: 'resource_missing' } });
    const result = await f.app.runs.submitAgent(f.request('unrelated plain question'), { instanceId: 'host', operationRef: 'optional-skill' });
    if (!result.ok || !result.data.runId || !result.data.inputId) throw new Error('No unrelated Run'); await f.settle();
    expect(f.repos.readRunResources(result.data.runId)).toMatchObject({ available: [], omitted: [{ resourceRef: f.skill, reason: 'resource_missing' }] });
    expect(f.content(result.data.inputId).nativeInput?.text).toBe('unrelated plain question'); expect(f.requests).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 15000);

test('p11 saved Run survives a conflicting snapshot file without overwriting it or dispatching to Pi', async () => {
  const f = await fixture(); try {
    const execute = f.agent.execute.bind(f.agent); f.agent.execute = (input, callbacks) => {
      const path = join(f.root, 'runtime', String(input.runId), 'work', 'scratch', 'resources', 'prompts/query/v1'); mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'query.md'), 'ENGINEERING conflicting copy');
      return execute(input, callbacks);
    };
    const result = await f.app.runs.submitAgent(f.request('cannot dispatch'), { instanceId: 'host', operationRef: 'bad-copy' });
    if (!result.ok || !result.data.runId || !result.data.inputId) throw new Error('No saved Run'); await f.settle();
    expect(f.repos.readInput({ inputId: result.data.inputId })).toMatchObject({ status: 'failed', nativeEntryId: null });
    expect(f.repos.read({ runId: result.data.runId })).toMatchObject({ kind: 'one', run: { status: 'failed', error: { code: 'resource_unavailable', reason: 'resource_snapshot_invalid' } } });
    expect(f.content(result.data.inputId).nativeInput).toBeUndefined(); expect(f.requests).toHaveLength(0); expect(f.db.query('SELECT * FROM model_calls').all()).toHaveLength(0);
    expect(readFileSync(join(f.root, 'runtime', String(result.data.runId), 'work', 'scratch', 'resources', 'prompts/query/v1/query.md'), 'utf8')).toBe('ENGINEERING conflicting copy');
    expect((await f.app.resources!.read({ source: 'run', runId: result.data.runId, resourceRef: f.prompt, file: 'query.md' })).content).toContain('$ARGUMENTS');
  } finally { await f.close(); }
}, 15000);

test('p11 actual SDK capture checks receipt budget before native dispatch and preserves unconsumed failure', async () => {
  const f = await fixture(); try {
    const { previous, rollbackFromVersion, ...old } = f.app.config;
    await f.app.prepareConfig('budget-plain', { ...f.app.config, configVersion: '2', previous: old, resources: { bySession: {} } }); f.app.commitConfig('budget-plain', '2');
    const text = '"receipt"\n\\ budget', budget = Buffer.byteLength(JSON.stringify({ text, sha256: createHash('sha256').update(text).digest('hex') })); let limit = budget - 1;
    const execute = f.agent.execute.bind(f.agent); f.agent.execute = (input, callbacks) => execute({ ...input, nativeReceiptLimitBytes: limit }, callbacks);
    const result = await f.app.runs.submitAgent(f.request(text), { instanceId: 'host', operationRef: 'capture-budget' });
    if (!result.ok || !result.data.runId || !result.data.inputId) throw new Error('No saved Input'); await f.settle();
    expect(f.content(result.data.inputId).nativeInput).toBeUndefined(); expect(f.requests).toHaveLength(0); expect(f.db.query('SELECT * FROM model_calls').all()).toHaveLength(0);
    expect(f.repos.readInput({ inputId: result.data.inputId })).toMatchObject({ status: 'failed', nativeEntryId: null, error: { code: 'resource_unavailable', reason: 'resource_too_large' } });
    expect(f.repos.read({ runId: result.data.runId })).toMatchObject({ kind: 'one', run: { status: 'failed', error: { code: 'resource_unavailable', reason: 'resource_too_large' } } });
    limit = budget; const exact = await f.app.runs.submitAgent(f.request(text), { instanceId: 'host', operationRef: 'capture-exact' });
    if (!exact.ok || !exact.data.inputId) throw new Error('No exact-budget Input'); await f.settle();
    expect(f.content(exact.data.inputId).nativeInput?.text).toBe(text); expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
}, 15000);

test('p11 resource capture rechecks the published configuration before creating any Run or Input', async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), captureStarted = new Promise<void>(resolve => { entered = resolve; });
  try {
    const capture = f.source.capture; f.source.capture = async refs => { const result = await capture(refs); entered(); await gate; return result; };
    const submission = f.app.runs.submitAgent(f.request('stale capture'), { instanceId: 'host', operationRef: 'stale-freeze' }); await captureStarted;
    const { previous, rollbackFromVersion, ...old } = f.app.config;
    await f.app.prepareConfig('replace-capture', { ...f.app.config, configVersion: '2', previous: old, resources: { bySession: {} } }); f.app.commitConfig('replace-capture', '2');
    release(); expect(await submission).toMatchObject({ ok: false, error: { code: 'config_conflict' } });
    expect(f.db.query('SELECT * FROM runs').all()).toHaveLength(0); expect(f.db.query('SELECT * FROM session_inputs').all()).toHaveLength(0); expect(f.requests).toHaveLength(0);
    expect(f.app.runs.busy).toBe(false);
  } finally { release(); await f.close(); }
}, 15000);
