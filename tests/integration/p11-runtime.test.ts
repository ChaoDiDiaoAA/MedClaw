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
import {SqliteWriteTransactions} from '../../packages/storage/src/write-transactions';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { InputContentSchema, SubmitInputSchema, type SubmitInput } from '../../packages/contracts/src/session';
import { ResourceCatalogueSchema, resourceRefKey } from '../../packages/contracts/src/resources';
import {canonicalRequest} from '../../packages/contracts/src/run';
import {SessionService} from '../../packages/core/src/session/session-service';
import type {ModelCallStarter} from '../../packages/contracts/src/run';
import type {CompactionCallOwner} from '../../packages/contracts/src/session';
import { parseSkillBlock } from '@earendil-works/pi-coding-agent';
import { sqliteHistory } from '../fixtures/p9-memory';

async function fixture(respond?: (index: number, payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-runtime-')), author = join(root, 'author'); cpSync(resolve('resources'), author, { recursive: true });
  const db = openDatabase(join(root, 'app.sqlite')), requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>);
    const delta = await respond?.(requests.length, requests.at(-1)!) ?? { role: 'assistant', content: 'ENGINEERING response; no quality claim.' };
    return new Response(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const credentials = new InMemoryCredentialStore(); await credentials.modify('p11-fixture', async () => ({ type: 'api_key', key: 'engineering' }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  const definition = { providerId: 'p11-fixture', name: 'Engineering', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [{ id: 'fixture', name: 'Engineering', input: ['text' as const], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true as const, pricingKnown: false, cost: null }] };
  await runtime.installCustom([definition]);
  const history = sqliteHistory(db), repos = new Repositories(db, undefined, undefined, undefined, history.store), contexts = new SqliteContextStore(db);
  const catalog = new CatalogService(new SqliteCatalogStore(db)), toolStore = new SqliteToolStore(db), queries = new QueryService(catalog, toolStore), evidence = new EvidenceReader(catalog, queries, toolStore);
  const registry = new ToolRegistry(createBusinessTools({ catalog, queries, evidence })), errors: unknown[] = [], recorder = new ToolRecorder(toolStore, (error,context) => {errors.push(error);app.runs.failToolPersistence(context.runId,error);});
  const agent = new PiAgentRuntime(runtime, root, history, { registry, recorder, executor: new ToolExecutor(registry, recorder) }, new ContextService(contexts, { inspectManagedImport: async () => ({ status: 'valid' as const }) }));
  const allocated = agent.allocate(); repos.createSession({ expectedWorkspaceRevision: 0 }, 'create-a', allocated.nativeSessionId, new Date().toISOString(), allocated.history); allocated.bind(1);
  const catalogue = ResourceCatalogueSchema.parse(JSON.parse(readFileSync(join(author, 'catalog.json'), 'utf8'))), prompt = catalogue.definitions.find(r => r.kind === 'prompt')!, skill = catalogue.definitions.find(r => r.kind === 'skill')!;
  const ref = ({ kind, id, version, treeHash }: typeof prompt) => ({ kind, id, version, treeHash });
  const config = PublishedSettingsSchema.parse({ schemaVersion: 'medclaw.settings/p1-v1', configVersion: '1', model: { provider: 'p11-fixture', modelId: 'fixture' }, customProviders: [{ definition, credentialRef: null }], credentialRefs: {}, previous: null, rollbackFromVersion: null,
    requestPolicy: { timeoutMs: 15000, maxRetries: 0, maxRetryDelayMs: 2000 }, resources: { bySession: { '1': { prompt: ref(prompt), skills: [ref(skill)] } } } });
  const source = createResourceSource(author);
  const starter=Object.assign((...args:Parameters<ModelCallStarter>)=>new ModelCallRecorder(repos,...args),{forCompaction:(owner:CompactionCallOwner,time:string)=>ModelCallRecorder.forCompaction(repos,owner,time)});
  const app = new Application('host', config, runtime, repos, async (_context, action) => action(), starter, () => {}, error => errors.push(error), agent, undefined, SqliteWriteTransactions.forDatabase(db), source);
  const request = (text: string): SubmitInput => SubmitInputSchema.parse({ sessionId: 1, clientSequence: repos.readSession(1)!.nextSubmissionSequence, mode: 'send', text, expectedRevision: repos.readWorkspace().revision, expectedBatchIds: [], expectedQueryId: null, model: { provider: 'p11-fixture', modelId: 'fixture', expectedConfigVersion: app.config.configVersion }, referenceDate: '2026-10-06', timezone: 'Asia/Shanghai' });
  const settle = async () => { for (let i = 0; i < 2000 && app.runs.busy; i++) await Bun.sleep(2); expect(app.runs.busy).toBe(false); };
  const content = (id: number) => InputContentSchema.parse(JSON.parse(db.query<{ content_json: string }, [number]>('SELECT content_json FROM session_inputs WHERE id=?').get(id)!.content_json));
  return { root, author, db, requests, errors, app, agent, repos, contexts, source, toolStore, recorder, runtime, history, registry, prompt: ref(prompt), skill: ref(skill), request, settle, content,
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

test('p11 explicit Skill and queued commands consume only the active Run freeze after a new selection is published', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async index => { if (index === 1) await gate; return { role: 'assistant', content: 'ENGINEERING queue response' }; });
  try {
    const rootRequest = f.request('/skill:query first explicit'), root = await f.app.runs.submitAgent(rootRequest, { instanceId: 'host', operationRef: 'skill-root' });
    if (!root.ok || !root.data.runId || !root.data.inputId) throw new Error('No explicit Skill Run');
    for (let i = 0; i < 1000 && f.requests.length === 0; i++) await Bun.sleep(2); expect(f.requests).toHaveLength(1);
    const runId = root.data.runId, first = f.content(root.data.inputId), block = parseSkillBlock(first.nativeInput!.text)!;
    expect(block.name).toBe('query'); expect(block.location).toBe(join(f.root, 'runtime', String(runId), 'work', 'scratch', 'resources', 'skills/query/v1/SKILL.md'));
    expect(block.userMessage).toBe('first explicit'); expect(first.resourceInputPlan?.kind).toBe('skill');
    const { previous, rollbackFromVersion, ...old } = f.app.config;
    await f.app.prepareConfig('disable-during-skill', { ...f.app.config, configVersion: '2', previous: old, resources: { bySession: { '1': { prompt: null, skills: [] } } } }); f.app.commitConfig('disable-during-skill', '2');
    const queued = (mode: 'steer' | 'follow_up', text: string) => SubmitInputSchema.parse({ ...f.request(text), mode, targetRunId: runId, model: rootRequest.model });
    expect(await f.app.runs.submitAgent(queued('steer', '/skill:not-selected fail'), { instanceId: 'host', operationRef: 'unselected-queue' })).toMatchObject({ ok: false, error: { code: 'resource_unavailable', reason: 'resource_missing' } });
    const steer = await f.app.runs.submitAgent(queued('steer', 'plain steering'), { instanceId: 'host', operationRef: 'plain-steer' });
    const queuedSkill = await f.app.runs.submitAgent(queued('steer', '/skill:query queued skill'), { instanceId: 'host', operationRef: 'skill-steer' });
    const follow = await f.app.runs.submitAgent(queued('follow_up', '/query "explicit queued"'), { instanceId: 'host', operationRef: 'prompt-follow' });
    if (!steer.ok || !steer.data.inputId || !queuedSkill.ok || !queuedSkill.data.inputId || !follow.ok || !follow.data.inputId) throw new Error('No queued Input');
    expect(f.content(steer.data.inputId).model.configVersion).toBe('1'); expect(f.content(steer.data.inputId).resourceInputPlan?.kind).toBe('plain');
    expect(f.content(follow.data.inputId).resourceInputPlan).toMatchObject({ kind: 'prompt', resourceRef: f.prompt });
    release(); await f.settle();
    expect(f.content(steer.data.inputId).nativeInput?.text).toBe('plain steering'); expect(f.content(follow.data.inputId).nativeInput?.text).toContain('explicit queued');
    expect(parseSkillBlock(f.content(queuedSkill.data.inputId).nativeInput!.text)).toMatchObject({ name: 'query', location: block.location, userMessage: 'queued skill' });
    for (const id of [root.data.inputId, steer.data.inputId, queuedSkill.data.inputId, follow.data.inputId]) expect(f.repos.readInput({ inputId: id })).toMatchObject({ status: 'consumed', runId, targetRunId: runId, processingStatus: 'completed' });
    expect(f.requests).toHaveLength(4); expect(f.errors).toEqual([]);
    expect(await f.app.runs.submitAgent(queued('steer', '/skill:query late'), { instanceId: 'host', operationRef: 'terminal-late' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(f.db.query('SELECT * FROM session_inputs').all()).toHaveLength(4);
    expect(await f.app.runs.submitAgent(f.request('/skill:query now-disabled'), { instanceId: 'host', operationRef: 'disabled-new-root' })).toMatchObject({ ok: false, error: { code: 'resource_unavailable' } }); expect(f.requests).toHaveLength(4);
  } finally { release(); await f.close(); }
}, 15000);

test('p11 cancelling an expanded queued Skill removes its original object while the surviving Prompt runs once', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async index => { if (index === 1) await gate; return { role: 'assistant', content: 'ENGINEERING' }; });
  try {
    const request = f.request('root'), root = await f.app.runs.submitAgent(request, { instanceId: 'host', operationRef: 'cancel-root' });
    if (!root.ok || !root.data.runId) throw new Error('No root'); const runId = root.data.runId;
    for (let i = 0; i < 1000 && f.requests.length === 0; i++) await Bun.sleep(2); expect(f.requests).toHaveLength(1);
    const queued = (text: string) => SubmitInputSchema.parse({ ...f.request(text), mode: 'follow_up', targetRunId: runId });
    const first = await f.app.runs.submitAgent(queued('/skill:query remove'), { instanceId: 'host', operationRef: 'cancel-skill' });
    const survivor = await f.app.runs.submitAgent(queued('/query survivor'), { instanceId: 'host', operationRef: 'survivor-prompt' });
    if (!first.ok || !first.data.inputId || !survivor.ok || !survivor.data.inputId) throw new Error('No queue');
    const cancellation = f.app.runs.cancelInput(first.data.inputId, { instanceId: 'host', operationRef: 'remove-one' }); release();
    expect(await cancellation).toMatchObject({ ok: true, data: { id: first.data.inputId, status: 'cancelled', nativeEntryId: null } }); await f.settle();
    expect(f.content(first.data.inputId).nativeInput).toBeUndefined(); expect(f.content(survivor.data.inputId).nativeInput?.text).toContain('survivor');
    expect(f.requests).toHaveLength(2); expect(f.errors).toEqual([]);
    expect(await f.app.runs.cancelInput(first.data.inputId, { instanceId: 'host', operationRef: 'remove-again' })).toMatchObject({ ok: true, data: { status: 'cancelled' } }); expect(f.requests).toHaveLength(2);
  } finally { release(); await f.close(); }
}, 15000);

test('p11 A and B Sessions retain different selections, native history and Run-owned queued inputs', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async index => { if (index === 1) await gate; return { role: 'assistant', content: 'ENGINEERING' }; });
  try {
    const rootRequest = f.request('A only'), root = await f.app.runs.submitAgent(rootRequest, { instanceId: 'host', operationRef: 'a-root' });
    if (!root.ok || !root.data.runId) throw new Error('No A Run'); for (let i = 0; i < 1000 && f.requests.length === 0; i++) await Bun.sleep(2);
    const allocated = f.agent.allocate(); f.repos.createSession({ expectedWorkspaceRevision: f.repos.readWorkspace().revision }, 'create-b', allocated.nativeSessionId, new Date().toISOString(), allocated.history); allocated.bind(2);
    const { previous, rollbackFromVersion, ...old } = f.app.config;
    await f.app.prepareConfig('b-selection', { ...f.app.config, configVersion: '2', previous: old, resources: { bySession: { ...f.app.config.resources!.bySession, '2': { prompt: null, skills: [] } } } }); f.app.commitConfig('b-selection', '2');
    const forged = SubmitInputSchema.parse({ ...f.request('/skill:query forged'), sessionId: 2, clientSequence: 1, mode: 'steer', targetRunId: root.data.runId });
    expect(await f.app.runs.submitAgent(forged, { instanceId: 'host', operationRef: 'b-borrows-a' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await f.app.resources!.list({ source: 'selection', sessionId: 2 })).toMatchObject({ sessionId: 2, selection: { prompt: null, skills: [] }, evidence: [] });
    const denied = await f.app.resources!.read({ source: 'selection', sessionId: 2, resourceRef: f.skill, file: 'SKILL.md' }).then(() => null, error => error); expect(denied).toMatchObject({ code: 'access_denied' });
    release(); await f.settle();
    const b = SubmitInputSchema.parse({ ...f.request('B plain'), sessionId: 2, clientSequence: 1 }), result = await f.app.runs.submitAgent(b, { instanceId: 'host', operationRef: 'b-root' });
    if (!result.ok || !result.data.runId || !result.data.inputId) throw new Error('No B Run'); await f.settle();
    expect(f.content(result.data.inputId).nativeInput?.text).toBe('B plain'); expect(f.repos.readRunResources(result.data.runId)).toMatchObject({ sessionId: 2, configVersion: '2', available: [] });
    expect(JSON.stringify(f.requests[1])).not.toContain('A only'); expect(JSON.stringify(f.requests[1])).not.toContain('SKILL.md');
    expect(f.db.query('SELECT session_id,run_id FROM session_inputs ORDER BY id').all()).toEqual([{ session_id: 1, run_id: root.data.runId }, { session_id: 2, run_id: result.data.runId }]); expect(f.errors).toEqual([]);
  } finally { release(); await f.close(); }
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

test('p11 real native progressive reads keep SDK results and independently save read and HTTP delivery identities', async () => {
  const f = await fixture((index, payload) => {
    const system = (payload.messages as {role:string;content:string}[]).find(m => m.role === 'system')!.content;
    const path = /<location>(.*?)<\/location>/.exec(system)![1]!;
    const input = index === 1 ? {path} : index === 2 ? {path: path.replace('SKILL.md', 'references/facts-and-assumptions.md'), offset: 1, limit: 1}
      : index === 3 ? {path: path.replace('SKILL.md', 'references/facts-and-assumptions.md')} : {};
    return index < 5 ? {role:'assistant',tool_calls:[{index:0,id:`p11read${index}`,type:'function',function:{name:index < 4 ? 'read' : 'read_data_scope',arguments:JSON.stringify(input)}}]}
      : {role:'assistant',content:'ENGINEERING final, no model quality claim'};
  });
  try {
    const result = await f.app.runs.submitAgent(f.request('progressive read'), {instanceId:'host',operationRef:'progressive-read'});
    if (!result.ok || !result.data.runId) throw new Error('No Run'); await f.settle();
    expect(f.repos.read({runId:result.data.runId})).toMatchObject({kind:'one',run:{status:'completed'}});
    expect(f.errors).toEqual([]); expect(f.requests).toHaveLength(5);
    const facts = (await f.app.resources!.list({source:'run',runId:result.data.runId,evidencePageSize:100})).evidence;
    expect(facts.filter(e => e.kind === 'native_read').map(e => e.coverage).sort()).toEqual(['complete','complete','partial']);
    const tools = f.db.query<{delivery_json:string}, []>('SELECT delivery_json FROM tool_calls ORDER BY id').all().map(r => JSON.parse(r.delivery_json));
    const frozen = f.repos.readRunResources(result.data.runId)!.available.find(s => s.ref.kind === 'skill')!;
    expect(tools[0].message.content).toEqual([{type:'text',text:frozen.files.find(s => s.file === 'SKILL.md')!.content}]);
    expect(tools[0].message.details).toBeUndefined(); expect(tools[3].resourceRead).toBeUndefined();
    for (const read of facts.filter(e => e.kind === 'native_read')) expect(facts.some(e => e.kind === 'provider_delivery' && e.toolCallId === read.toolCallId && e.nativeEntryId === read.nativeEntryId)).toBe(true);
    expect(facts.some(e => e.kind === 'provider_delivery' && e.coverage === 'index' && e.file === null)).toBe(true);
  } finally {await f.close();}
},15000);

test('p11 equal Prompt expansions in successive Runs each retain their original native entry and origin Run', async () => {
  const f = await fixture(); try {
    const runs: number[] = [];
    for (const operationRef of ['origin-one','origin-two']) {
      const result = await f.app.runs.submitAgent(f.request('identical text'), {instanceId:'host',operationRef});
      if (!result.ok || !result.data.runId) throw new Error('No Run'); runs.push(result.data.runId); await f.settle();
    }
    const facts = (await f.app.resources!.list({source:'run',runId:runs[1]!,evidencePageSize:100})).evidence.filter(e => e.kind === 'provider_delivery' && e.resourceRef.kind === 'prompt');
    expect(facts.map(e => e.originRunId).sort()).toEqual(runs); expect(new Set(facts.map(e => e.nativeEntryId)).size).toBe(2);
    expect(f.errors).toEqual([]);
  } finally {await f.close();}
},15000);

for (const failure of ['read_annotation','provider_delivery'] as const) test(`p11 ${failure} save failure retains original proof and retrySave never reexecutes HTTP or tools`,async()=>{
  const f=await fixture((index,payload)=>{
    if(failure==='read_annotation'&&index===1){const system=(payload.messages as {role:string;content:string}[]).find(m=>m.role==='system')!.content;const path=/<location>(.*?)<\/location>/.exec(system)![1]!;
      return {role:'assistant',tool_calls:[{index:0,id:'save-read',type:'function',function:{name:'read',arguments:JSON.stringify({path})}}]};}
    return {role:'assistant',content:'ENGINEERING'};
  });
  let reject=true;const read=f.toolStore.recordResourceRead.bind(f.toolStore),delivery=f.contexts.recordDelivery.bind(f.contexts);
  if(failure==='read_annotation')f.toolStore.recordResourceRead=(...args)=>{if(reject)throw new Error('storage_write_failed');read(...args);};
  else f.contexts.recordDelivery=input=>{if(reject)throw new Error('storage_write_failed');return delivery(input);};
  try {
    const result=await f.app.runs.submitAgent(f.request('save failure'),{instanceId:'host',operationRef:failure});if(!result.ok||!result.data.runId)throw new Error('No Run');const runId=result.data.runId;
    for(let i=0;i<2000&&!f.app.runs.persistencePending;i++)await Bun.sleep(2);
    expect(f.app.runs.persistencePending).toBe(true);expect(f.app.runs.activeHandle?.runId).toBe(runId);expect(f.requests).toHaveLength(1);
    expect(await f.app.runs.submitAgent(f.request('must stay blocked'),{instanceId:'host',operationRef:'blocked-'+failure})).toMatchObject({ok:false,error:{code:'state_conflict'}});
    const before=(await f.app.resources!.list({source:'run',runId})).evidence;
    expect(before.filter(e=>e.kind===(failure==='read_annotation'?'native_read':'provider_delivery'))).toHaveLength(0);
    expect(await f.app.runs.cancel(runId)).toMatchObject({ok:true,data:{stopped:true}});
    reject=false;expect(await f.app.runs.retrySave(runId)).toMatchObject({ok:true,data:{status:'failed',cleanup:{requiredPersistenceComplete:true}}});
    expect(f.app.runs.activeHandle).toBeNull();expect(f.requests).toHaveLength(1);
    const after=(await f.app.resources!.list({source:'run',runId})).evidence;
    expect(after.filter(e=>e.kind===(failure==='read_annotation'?'native_read':'provider_delivery')).length).toBeGreaterThan(0);
    if(failure==='read_annotation'){expect(f.db.query('SELECT * FROM tool_calls').all()).toHaveLength(1);expect(after.some(e=>e.kind==='provider_delivery'&&e.toolCallId!==null)).toBe(false);}
  }finally{reject=false;if(f.app.runs.activeHandle){const id=f.app.runs.activeHandle.runId;await f.app.runs.cancel(id);await f.app.runs.retrySave(id);}await f.close();}
},15000);

test('p11 reopened SQLite and new native Session preserve old v1 history while a v2 Run has a distinct current index',async()=>{
  const f=await fixture((index,payload)=>{if(index!==1)return {role:'assistant',content:'ENGINEERING'};const system=(payload.messages as {role:string;content:string}[]).find(m=>m.role==='system')!.content;
    return {role:'assistant',tool_calls:[{index:0,id:'old-read',type:'function',function:{name:'read',arguments:JSON.stringify({path:/<location>(.*?)<\/location>/.exec(system)![1]})}}]};});let second:ReturnType<typeof openDatabase>|undefined;let app:typeof f.app|undefined;
  try {
    const first=await f.app.runs.submitAgent(f.request('/skill:query historical v1'),{instanceId:'host',operationRef:'v1-before-restart'});if(!first.ok||!first.data.runId)throw new Error('No v1');await f.settle();
    const catalogue=ResourceCatalogueSchema.parse(JSON.parse(readFileSync(join(f.author,'catalog.json'),'utf8'))),v1=catalogue.definitions.find(d=>d.kind==='skill')!;
    const folder=join(f.author,'skills/query/v2');cpSync(join(f.author,'skills/query/v1'),folder,{recursive:true});writeFileSync(join(folder,'SKILL.md'),readFileSync(join(folder,'SKILL.md'),'utf8')+'\nENGINEERING version two.\n');
    const definition={...v1,version:'v2',entry:'skills/query/v2/SKILL.md',treeHash:''};const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
    const metadata={kind:definition.kind,id:definition.id,version:definition.version,entry:definition.entry,keywords:[...definition.keywords].sort(),requiredTools:[...definition.requiredTools].sort(),requiredExtensions:[...definition.requiredExtensions].sort(),files:definition.files.map(path=>{const bytes=readFileSync(join(folder,path));return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)};
    definition.treeHash=hash(canonicalRequest(metadata));catalogue.definitions.push(definition);writeFileSync(join(f.author,'catalog.json'),JSON.stringify(catalogue));
    const v2={kind:definition.kind,id:definition.id,version:definition.version,treeHash:definition.treeHash}, {previous,rollbackFromVersion,...old}=f.app.config;
    await f.app.prepareConfig('v2-selected',{...f.app.config,configVersion:'2',previous:old,resources:{bySession:{'1':{prompt:null,skills:[v2]}}}});f.app.commitConfig('v2-selected','2');
    const nextRequest=f.request('new v2 question');await f.app.runs.shutdown();f.db.close();second=openDatabase(join(f.root,'app.sqlite'));
    const history=sqliteHistory(second),repos=new Repositories(second,undefined,undefined,undefined,history.store),contexts=new SqliteContextStore(second),tools=new SqliteToolStore(second),catalog=new CatalogService(new SqliteCatalogStore(second)),queries=new QueryService(catalog,tools);
    const registry=new ToolRegistry(createBusinessTools({catalog,queries,evidence:new EvidenceReader(catalog,queries,tools)})),recorder=new ToolRecorder(tools),agent=new PiAgentRuntime(f.runtime,f.root,history,{registry,recorder,executor:new ToolExecutor(registry,recorder)},new ContextService(contexts,{inspectManagedImport:async()=>({status:'valid'})}));
    app=new Application('new-host',f.app.config,f.runtime,repos,async(_context,action)=>action(),(id,kind,at,context)=>new ModelCallRecorder(repos,id,kind,at,context),()=>{},undefined,agent,undefined,undefined,f.source);
    await agent.ensureLoaded(1);const request=SubmitInputSchema.parse({...nextRequest,clientSequence:repos.readSession(1)!.nextSubmissionSequence});
    const accepted=await app.runs.submitAgent(request,{instanceId:'new-host',operationRef:'v2-after-restart'});if(!accepted.ok||!accepted.data.runId)throw new Error('No v2');for(let i=0;i<2000&&app.runs.busy;i++)await Bun.sleep(2);expect(app.runs.busy).toBe(false);
    const facts=(await app.resources!.list({source:'run',runId:accepted.data.runId,evidencePageSize:100})).evidence;
    expect(facts.some(e=>e.kind==='provider_delivery'&&e.originRunId===first.data.runId&&e.resourceRef.version==='v1'&&e.inputId!==null)).toBe(true);
    expect(facts.some(e=>e.kind==='provider_delivery'&&e.originRunId===first.data.runId&&e.resourceRef.version==='v1'&&e.toolCallId!==null)).toBe(true);
    expect(facts.some(e=>e.kind==='provider_delivery'&&e.originRunId===accepted.data.runId&&e.resourceRef.version==='v2'&&e.coverage==='index')).toBe(true);
    rmSync(f.author,{recursive:true});expect((await app.resources!.read({source:'run',runId:first.data.runId,resourceRef:f.skill,file:'SKILL.md'})).content).not.toContain('version two');
    expect((await app.resources!.list({source:'selection',sessionId:1})).items.some(i=>i.ref.version==='v2'&&i.availability!=='ready')).toBe(true);
    expect(await app.runs.submitAgent({...request,clientSequence:3,text:'/skill:query required'},{instanceId:'new-host',operationRef:'missing-required-after-restart'})).toMatchObject({ok:false,error:{code:'resource_unavailable'}});expect(f.requests).toHaveLength(3);
  }finally{await app?.runs.shutdown();second?.close();await f.close();}
},15000);

test('p11 actual manual compaction mentions a Skill name without inventing delivery of its omitted full body',async()=>{
  const f=await fixture(()=>({role:'assistant',content:'ENGINEERING summary mentioning query only.'}));
  try {
    const describe=f.agent.describe.bind(f.agent);f.agent.describe=resolved=>({...describe(resolved),compaction:{...describe(resolved).compaction,keepRecentTokens:32,reserveTokens:256}});
    const sessions=new SessionService('host',f.repos,f.agent,(input,context)=>f.app.runs.submitAgent(input,context),()=>f.app.runs.activeHandle,()=>null,undefined,f.app.runs);
    let original=0;
    for(let i=0;i<3;i++){const result=await f.app.runs.submitAgent(f.request(i===0?'/skill:query original large body':`turn ${i}`),{instanceId:'host',operationRef:`pre-compact-${i}`});if(!result.ok||!result.data.runId)throw new Error('No Run');original ||=result.data.runId;await f.settle();}
    const accepted=await sessions.compact({sessionId:1,expectedStorageVersion:f.repos.readSession(1)!.storageVersion,model:{provider:'p11-fixture',modelId:'fixture',expectedConfigVersion:'1'}},{instanceId:'host',operationRef:'p11-compact'});expect(accepted).toMatchObject({ok:true});
    let saved=false;for(let i=0;i<1000;i++){const read=await sessions.readCompaction({sessionId:1,operationRef:'p11-compact'});if(read.ok&&read.data?.canContinue){saved=true;break;}await Bun.sleep(2);}expect(saved).toBe(true);
    const result=await f.app.runs.submitAgent(f.request('after compact'),{instanceId:'host',operationRef:'after-compact'});if(!result.ok||!result.data.runId)throw new Error('No next Run');await f.settle();
    const facts=(await f.app.resources!.list({source:'run',runId:result.data.runId,evidencePageSize:100})).evidence;
    expect(facts.some(e=>e.kind==='provider_delivery'&&e.originRunId===original&&e.inputId!==null)).toBe(false);
    expect(facts.some(e=>e.kind==='provider_delivery'&&e.coverage==='index')).toBe(true);
    const rows=f.db.query<{kind:string;model_json:string}, []>('SELECT kind,model_json FROM model_calls').all();expect(rows.some(r=>r.kind==='compaction')).toBe(true);
    expect(rows.filter(r=>r.kind==='compaction').every(r=>!JSON.parse(r.model_json).context?.resources)).toBe(true);
    expect((await f.app.resources!.list({source:'run',runId:original})).evidence.some(e=>e.kind==='provider_delivery'&&e.inputId!==null)).toBe(true);expect(f.errors).toEqual([]);
  }finally{await f.close();}
},15000);

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
