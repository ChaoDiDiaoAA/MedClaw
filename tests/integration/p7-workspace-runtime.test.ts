import {queryTargetVersion} from '../../packages/storage/src/workspace-selection';
import { sqliteHistory, nativeHistoryFixture } from '../fixtures/p9-memory';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, VERSION } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { PiInputAdapter } from '../../packages/runtime-pi/src/input-adapter';
import * as adapters from '../../packages/runtime-pi/src/pi-tool-adapter';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { createReadDataScopeTool } from '../../packages/core/src/tools/business-tools/read-data-scope';
import type { ToolExecutionContext } from '../../packages/contracts/src/tool';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const workspace = (revision: number, queryId = 17) => ({ sessionId: 7, revision, materialVersion: null, batchRefs: [], deviceIds: [], queryId, activeView: 'query' as const,
  selection: { formatVersion: 1 as const, kind: 'query-row' as const, targetId: String(queryId), targetVersion: `query:${queryId}:v1`, rowKey: 'snapshot:23', field: 'priceCents' } });
const scope = { batchIds: [], deviceIds: null, allowedToolNames: ['read_data_scope'], allowedResourceRefs: [], artifactIds: [], readOnly: true };
async function fixture(options: { rejectConsumption?: (id: number) => boolean; appendThrows?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p7-native-'));
  const requests: Record<string, unknown>[] = [], gates: ReturnType<typeof deferred>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>; requests.push(body); const index = requests.length - 1;
    const gate = deferred(); gates.push(gate); await gate.promise;
    const isTool = index % 2 === 0;
    const delta = isTool ? { role: 'assistant', tool_calls: [{ index: 0, id: `scope-${index}`, type: 'function', function: { name: 'read_data_scope', arguments: '{}' } }] }
      : { role: 'assistant', content: 'verified' };
    return new Response(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta, finish_reason: isTool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const credentials = new InMemoryCredentialStore(); await credentials.modify('p7-fixture', async () => ({ type: 'api_key', key: 'fixture' }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  await runtime.installCustom([{ providerId: 'p7-fixture', name: 'Fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] }]);
  const resolved = await runtime.resolve({ provider: 'p7-fixture', modelId: 'fixture', expectedConfigVersion: '1' }, '1', null, { timeoutMs: 15000, maxRetries: 0, maxRetryDelayMs: 2000 });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', defaultTools: [], packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false, enableInstallTelemetry: false });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'pi'), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Use read_data_scope for each consumed user input.' });
  await resourceLoader.reload(); const manager = SessionManager.inMemory(root);
  const originalAppend = manager.appendMessage.bind(manager); let appends = 0;
  manager.appendMessage = message => { if (message.role === 'user') { appends++; if (options.appendThrows) throw new Error('append failed'); } return originalAppend(message); };
  let adapter!: PiInputAdapter; const catalog = new CatalogService({ batches: [], devices: [], snapshots: [], changes: [] });
  const tool = createReadDataScopeTool({ catalog });
  const { session } = await createAgentSession({ cwd: root, agentDir: join(root, 'pi'), modelRuntime: runtime.native, model: resolved.model, thinkingLevel: 'off', settingsManager, resourceLoader, sessionManager: manager,
    tools: ['read_data_scope'], customTools: [{ name: tool.name, label: tool.label, description: tool.description, parameters: { type: 'object', properties: {}, additionalProperties: false }, executionMode: 'parallel', async execute(id) {
      const consumed = adapter.readConsumedWorkspace()!;
      const context = { runId: 41, sessionId: 7, nativeToolCallId: id, scope, referenceDate: '2026-01-01', timezone: 'Asia/Shanghai', signal: new AbortController().signal,
        workspaceContext: consumed.workspaceContext, workspaceInputId: consumed.inputId, workspaceRevision: consumed.workspaceContext.revision, basedOnQueryId: consumed.workspaceContext.queryId };
      const data = tool.outputSchema.parse(await tool.execute({}, context)); return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data };
    } }] });
  const consumed: number[] = [];
  adapter = new PiInputAdapter(session, manager, { runId: 41, sessionId: 7, delivered: () => {}, consumed: (input) => { if (options.rejectConsumption?.(input.inputId)) throw new Error('save failed'); consumed.push(input.inputId); }, failed: () => {}, cancelled: () => {}, fatal: () => {}, admissionClosed: () => {} });
  const input = (id: number, mode: 'send' | 'steer' | 'follow_up', revision = id) => ({ inputId: id, sessionId: 7, targetRunId: 41, stopEpoch: 0, mode, text: `input ${id}`, workspaceContext: workspace(revision) });
  const waitRequest = async (count: number) => { for (let i = 0; i < 1000 && requests.length < count; i++) await Bun.sleep(2); expect(requests).toHaveLength(count); };
  closers.push(async () => { for (const gate of gates) gate.resolve(); await session.abort(); await session.waitForIdle(); adapter.dispose(); session.dispose(); server.stop(true); await rm(root, { recursive: true, force: true }); });
  return { root, runtime, resolved, adapter, session, manager, consumed, input, waitRequest, requests, gates, get appends() { return appends; } };
}

// Break caught: advancing attention at queue admission leaks an unconsumed selection to tools/provider.
test('Pi 0.87.1 safe point keeps queued selection old, then real read_data_scope result reaches the next HTTP request', async () => {
  const c = await fixture(); expect(VERSION).toBe('0.87.1');
  const root = c.input(1, 'send'); await c.adapter.deliver(root); await c.waitRequest(1);
  root.workspaceContext.selection.field = 'deviceId';
  await c.adapter.deliver(c.input(2, 'follow_up', 22)); await c.adapter.deliver(c.input(3, 'steer', 33));
  expect(c.adapter.readConsumedWorkspace()).toMatchObject({ inputId: 1, workspaceContext: { revision: 1, selection: { field: 'priceCents' } } });
  c.gates[0]!.resolve(); await c.waitRequest(2);
  const toolMessages = (c.requests[1]!.messages as { role: string; content: string }[]).filter(message => message.role === 'tool');
  expect(JSON.parse(toolMessages[0]!.content)).toMatchObject({ workspaceInputId: 1, workspaceContext: { queryId: 17, selection: { rowKey: 'snapshot:23', field: 'priceCents' } }, scope: { batchIds: [] } });
  // Steer is consumed at Pi's native turn boundary; no custom scheduling loop.
  expect(c.adapter.readConsumedWorkspace()).toMatchObject({ inputId: 3, workspaceContext: { revision: 33 } });
  c.gates[1]!.resolve(); await c.waitRequest(3);
  expect(c.adapter.readConsumedWorkspace()).toMatchObject({ inputId: 2, workspaceContext: { revision: 22 } });
  c.gates[2]!.resolve(); await c.waitRequest(4);
  const nextTools = (c.requests[3]!.messages as { role: string; content: string }[]).filter(message => message.role === 'tool');
  expect(JSON.parse(nextTools.at(-1)!.content)).toMatchObject({ workspaceInputId: 2, workspaceContext: { revision: 22 } });
  c.gates[3]!.resolve(); await c.adapter.close(41, 'completed');
  expect(c.consumed).toEqual([1, 3, 2]); expect(c.appends).toBe(3);
});

// Break caught: missing deep clone/re-reading a getter changes an already executing tool's identity.
test('late old tool observation reuses its frozen copy after new input consumption', async () => {
  let current = workspace(1); let inputId = 1;
  const getContext = adapters.createFrozenToolContextFactory((nativeToolCallId: string) => ({ runId: 41, sessionId: 7, nativeToolCallId, scope, referenceDate: '2026-01-01', timezone: 'Asia/Shanghai', signal: new AbortController().signal,
    workspaceContext: current, workspaceInputId: inputId, workspaceRevision: current.revision, basedOnQueryId: current.queryId }));
  const first = getContext('old'); current.selection.field = 'deviceId'; current = workspace(2, 18); inputId = 2;
  const late = getContext('old'), next = getContext('new');
  const catalog = new CatalogService({ batches: [], devices: [], snapshots: [], changes: [] });
  expect(catalog.readScope(late)).toMatchObject({ workspaceInputId: 1, workspaceContext: { revision: 1, queryId: 17, selection: { field: 'priceCents' } } });
  expect(catalog.readScope(next)).toMatchObject({ workspaceInputId: 2, workspaceContext: { revision: 2, queryId: 18 } });
  expect(late).toBe(first);
});

// Break caught: returning the previous confirmed context hides a newer append whose required save failed.
test('latest native append without confirmed consumption fails closed and retries only the original save', async () => {
  let reject = true; const c = await fixture({ rejectConsumption: () => reject });
  await c.adapter.deliver(c.input(1, 'send')); await c.waitRequest(1);
  expect(() => c.adapter.readConsumedWorkspace()).toThrow();
  const appends = c.appends; reject = false; c.adapter.retryPersistence(41);
  expect(c.adapter.readConsumedWorkspace()).toMatchObject({ inputId: 1, workspaceContext: { revision: 1 } });
  expect(c.appends).toBe(appends); expect(c.consumed).toEqual([1]); c.gates[0]!.resolve(); await c.waitRequest(2); c.gates[1]!.resolve(); await c.adapter.close(41, 'completed');
});

import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { toWorkspaceContext } from '../../packages/contracts/src/workspace';
import { DEFAULT_REQUEST_POLICY } from '../../packages/contracts/src/model';
async function databaseFixture() {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p7-tool-')), db = openDatabase(join(root, 'app.sqlite')), repo = new Repositories(db);
  const at = new Date().toISOString(), created = repo.createSession({ expectedWorkspaceRevision: 0 }, 'create', 'native', at), workspaceContext = toWorkspaceContext(created.workspace);
  const frozenScope = { ...scope };
  const model = { provider: 'fixture', modelId: 'fixture', api: 'openai-completions', endpointRef: null, credentialRef: null, configVersion: '1', maxOutputTokens: 100, capabilitySource: 'user_declared' as const, sdkVersion: '0.87.1' as const };
  const request = { sessionId: created.session.id, clientSequence: 1, text: 'original', mode: 'send' as const, expectedRevision: workspaceContext.revision, expectedBatchIds: [], expectedQueryId: null, model: { provider: 'fixture', modelId: 'fixture', expectedConfigVersion: '1' }, referenceDate: '2026-01-01', timezone: 'Asia/Shanghai' };
  const content = { contract: 'medclaw.session-input/v1' as const, originalSubmitInput: request, text: request.text, workspaceContext, scope: frozenScope, model, referenceDate: request.referenceDate, timezone: request.timezone, deliveryAttempt: null };
  const run = { sessionId: created.session.id, goal: 'answer' as const, text: request.text, model, policy: DEFAULT_REQUEST_POLICY, workspace: workspaceContext, scope: frozenScope,
    referenceDate: request.referenceDate, timezone: request.timezone, timeoutMs: DEFAULT_REQUEST_POLICY.timeoutMs, agentOptions: { requestedThinkingLevel: 'off' as const, effectiveThinkingLevel: 'off' as const }, instanceId: 'fixture', createdAt: at };
  const accepted = repo.acceptInput({ operationRef: 'send', originalSubmitInput: request, content, createdAt: at, execution: { mode: 'send', run } });
  if (!accepted.inputId || !accepted.runId) throw new Error('missing root');
  repo.startCall(accepted.runId, 'model-call', 'main', at);
  const context: ToolExecutionContext = { runId: accepted.runId, sessionId: created.session.id, nativeToolCallId: 'scope-call', scope: frozenScope,
    referenceDate: request.referenceDate, timezone: request.timezone, signal: new AbortController().signal, workspaceContext, workspaceInputId: accepted.inputId, workspaceRevision: workspaceContext.revision, basedOnQueryId: null };
  closers.push(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const consume = () => { repo.beginInputDelivery(accepted.inputId!, 'fixture', at); repo.recordInputConsumption(accepted.inputId!, { sessionId: created.session.id, runId: accepted.runId!, nativeEntryId: 'original-entry', at }); };
  return { root, db, repo, accepted, context, consume, workspaceContext, request, content, run, at };
}

// Break caught: a syntactically valid queued/forged attention source gains data access before consumption.
test('ToolStore rejects queued and forged frozen input contexts while root input foreign keys remain original', async () => {
  const c = await databaseFixture(), store = new SqliteToolStore(c.db);
  expect(() => store.assertContext(c.context)).toThrow();
  c.consume(); expect(() => store.assertContext(c.context)).not.toThrow();
  const changed = structuredClone(c.workspaceContext); changed.revision++;
  expect(() => store.assertContext({ ...c.context, workspaceContext: changed, workspaceRevision: changed.revision })).toThrow();
  expect(() => store.assertContext({ ...c.context, workspaceInputId: c.accepted.inputId! + 1 })).toThrow();
  const tool = createReadDataScopeTool({ catalog: new CatalogService({ batches: [], devices: [], snapshots: [], changes: [] }) });
  const call = store.request(tool, {}, c.context);
  expect(c.db.query('SELECT run_id FROM tool_calls WHERE id=?').get(call.id)).toEqual({ run_id: c.accepted.runId });
  expect(c.db.query('SELECT input_id FROM model_calls WHERE call_id=?').get('model-call')).toEqual({ input_id: c.accepted.inputId });
});

// Break caught: an older deferred consumption save overwrites the most recently appended input.
test('late older consumption-save retry cannot overwrite newer actual append order', async () => {
  let reject = true; const c = await fixture({ rejectConsumption: id => id === 3 && reject });
  await c.adapter.deliver(c.input(1, 'send')); await c.waitRequest(1);
  await c.adapter.deliver(c.input(2, 'follow_up', 22)); await c.adapter.deliver(c.input(3, 'steer', 33));
  c.gates[0]!.resolve(); await c.waitRequest(2);
  expect(() => c.adapter.readConsumedWorkspace()).toThrow();
  c.gates[1]!.resolve(); await c.waitRequest(3);
  expect(c.adapter.readConsumedWorkspace()).toMatchObject({ inputId: 2, workspaceContext: { revision: 22 } });
  reject = false; c.adapter.retryPersistence(41);
  expect(c.adapter.readConsumedWorkspace()).toMatchObject({ inputId: 2, workspaceContext: { revision: 22 } });
  expect(c.consumed).toEqual([1, 2, 3]); expect(c.appends).toBe(3);
  c.gates[2]!.resolve(); await c.waitRequest(4); c.gates[3]!.resolve(); await c.adapter.close(41, 'completed');
});

test('cancelled queued selection never replaces the actually consumed reference', async () => {
  const c = await fixture(); await c.adapter.deliver(c.input(1, 'send')); await c.waitRequest(1);
  await c.adapter.deliver(c.input(2, 'follow_up')); const cancelled = c.adapter.cancel(2);
  c.gates[0]!.resolve(); await c.waitRequest(2); expect((await cancelled).kind).toBe('removed');
  expect(c.adapter.readConsumedWorkspace()).toMatchObject({ inputId: 1 });
  c.gates[1]!.resolve(); await c.adapter.close(41, 'completed'); expect(c.consumed).toEqual([1]);
});

import { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import { ModelCallRecorder } from '../../packages/runtime-pi/src/model-call-recorder';
import { Application } from '../../packages/core/src/application';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { SqliteCatalogStore } from '../../packages/storage/src/catalog-store';
import { QueryService } from '../../packages/core/src/data/query-service';
import { EvidenceReader } from '../../packages/core/src/evidence/evidence-reader';
import { createBusinessTools } from '../../packages/core/src/tools/tools';
import { ToolRegistry } from '../../packages/core/src/tools/registry';
import { ToolRecorder } from '../../packages/core/src/tools/recorder';
import { ToolExecutor } from '../../packages/core/src/tools/executor';
import { CurrentQuerySchema } from '../../packages/contracts/src/query';
import { SubmitInputSchema } from '../../packages/contracts/src/session';
import type { RuntimeNotice } from '../../packages/contracts/src/protocol';

// Break caught: RuntimeService loses accepted selection, tools read live Workspace, or Query commit loses its frozen parent.
test('production accepted Input and Run preserve selected Query row through real tools, provider wire, and Query commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p7-production-')), db = openDatabase(join(root, 'app.sqlite'));
  const repo = new Repositories(db,undefined,undefined,undefined,sqliteHistory(db).store), at = new Date().toISOString(), requests: Record<string, unknown>[] = [], gates: ReturnType<typeof deferred>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>); const index = requests.length - 1, gate = deferred(); gates.push(gate); await gate.promise;
    const calls = index === 0 ? [{ index: 0, id: 'scope-root', type: 'function', function: { name: 'read_data_scope', arguments: '{}' } }]
      : index === 1 ? [
        { index: 0, id: 'scope-next', type: 'function', function: { name: 'read_data_scope', arguments: '{}' } },
        { index: 1, id: 'query-next', type: 'function', function: { name: 'query_current_devices', arguments: '{"batchIds":[1],"time":{"start":"2026-01-01","endExclusive":"2026-01-02"}}' } },
      ] : null;
    const delta = calls ? { role: 'assistant', tool_calls: calls } : { role: 'assistant', content: 'verified original selection' };
    return new Response(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  let app: Application<Awaited<ReturnType<PiModelRuntime['resolve']>>> | undefined;
  let agent: PiAgentRuntime | undefined;
  closers.push(async () => { for (const gate of gates) gate.resolve(); await app?.runs.shutdown(); const bindings = agent && Reflect.get(agent, 'sessions') as Map<number, { session?: { dispose(): void } }> | undefined;
    bindings?.forEach(binding => binding.session?.dispose()); server.stop(true); db.close(); await rm(root, { recursive: true, force: true }); });
  db.query(`INSERT INTO imports(id,operation_ref,instance_id,state,preview_request_json,created_at,updated_at) VALUES(1,'import','fixture','imported','{}',?,?)`).run(at, at);
  db.query('UPDATE catalog_state SET revision=1,updated_at=?').run(at);
  db.query(`INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,coverage,expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at)
    VALUES(1,1,'scope','2026-01-01','浙江','fixture/v1','bundle','full',2,2,'[]',?,1,NULL,1,?)`).run(JSON.stringify({ referenceDate: '2026-01-01', timezone: 'Asia/Shanghai' }), at);
  for (const deviceId of [1, 2]) {
    db.query(`INSERT INTO devices(id,source_device_id,source_bundle_id,source_submission_id,source_refs_json,created_at) VALUES(?,?,'bundle','submission','[]',?)`).run(deviceId, `device-${deviceId}`, at);
    db.query(`INSERT INTO snapshots(id,batch_id,device_id,device_name,region,price_cents,currency,unit,status,source_row_ref,source_refs_json,field_origins_json)
      VALUES(?,1,?,'器械','浙江',100,'CNY','件','active',?,'[]','{}')`).run(deviceId, deviceId, `1:${deviceId}`);
  }
  const catalog = new CatalogService(new SqliteCatalogStore(db)), store = new SqliteToolStore(db), queries = new QueryService(catalog, store), evidence = new EvidenceReader(catalog, queries, store);
  const registry = new ToolRegistry(createBusinessTools({ catalog, queries, evidence })), recorder = new ToolRecorder(store), executor = new ToolExecutor(registry, recorder);
  const credentials = new InMemoryCredentialStore(); await credentials.modify('p7-production', async () => ({ type: 'api_key', key: 'fixture' }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  const definition = { providerId: 'p7-production', name: 'Fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [{ id: 'fixture', name: 'Fixture', input: ['text' as const], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true as const, pricingKnown: false, cost: null }] };
  await runtime.installCustom([definition]); agent = new PiAgentRuntime(runtime, root, sqliteHistory(db), { registry, recorder, executor });
  const native = agent.allocate(), session = repo.createSession({ expectedWorkspaceRevision: 0 }, 'create', native.nativeSessionId, at,native.history).session; native.bind(session.id);
  repo.updateWorkspace({ batchIds: [1] }, repo.readWorkspace().revision, at);
  const priorScope = repo.freezeAgentScope(repo.readWorkspace(), agent.toolNames ?? []);
  db.query(`INSERT INTO runs(id,session_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at)
    VALUES(10,?,'agent','fixture','seed',1,'{"sessionId":1,"clientSequence":1}','running','answer','seed','{"agent":{"nativeSessionId":"native"}}',?,'{}','2026-01-01','Asia/Shanghai',?)`).run(session.id, JSON.stringify(priorScope), at);
  const previous = queries.current(CurrentQuerySchema.parse({ batchIds: [1], time: { start: '2026-01-01', endExclusive: '2026-01-02' } }), { runId: 10, sessionId: session.id, nativeToolCallId: 'seed-query', scope: priorScope, referenceDate: '2026-01-01', timezone: 'Asia/Shanghai', signal: new AbortController().signal });
  db.query("UPDATE runs SET status='completed',ended_at=? WHERE id=10").run(at);
  const original = store.readQuery(previous.queryId)!;
  repo.updateWorkspace({ queryId: original.id, activeView: 'query', selection: { formatVersion: 1, kind: 'query-row', targetId: String(original.id), targetVersion: queryTargetVersion(original), rowKey: 'snapshot:1', field: 'priceCents' } }, repo.readWorkspace().revision, at);
  const frozen = toWorkspaceContext(repo.readWorkspace()), notices: RuntimeNotice[] = [];
  const settings = PublishedSettingsSchema.parse({ schemaVersion: 'medclaw.settings/p1-v1', configVersion: '1', model: { provider: 'p7-production', modelId: 'fixture' }, customProviders: [{ definition, credentialRef: null }], credentialRefs: {}, requestPolicy: { timeoutMs: 15000, maxRetries: 0, maxRetryDelayMs: 2000 }, ui: { navCollapsed: false, detailOpen: false, detailTab: 'conditions' }, previous: null, rollbackFromVersion: null });
  app = new Application('fixture', settings, runtime, repo, (_context, action) => action(), (runId, kind, time) => new ModelCallRecorder(repo, runId, kind, time), notice => notices.push(notice), undefined, agent);
  const request = SubmitInputSchema.parse({ sessionId: session.id, clientSequence: 2, text: '这一项为什么下降？', mode: 'send', expectedRevision: frozen.revision, expectedBatchIds: [1], expectedQueryId: original.id, model: { provider: 'p7-production', modelId: 'fixture', expectedConfigVersion: '1' }, referenceDate: '2026-01-01', timezone: 'Asia/Shanghai' });
  const accepted = await app.runs.submitAgent(request, { instanceId: 'fixture', operationRef: 'send' });
  if (!accepted.ok || !accepted.data.inputId || !accepted.data.runId) throw new Error('acceptance failed');
  const waitRequest = async (count: number) => { for (let i = 0; i < 1000 && requests.length < count; i++) await Bun.sleep(2); expect(requests).toHaveLength(count); };
  await waitRequest(1);
  expect(() => agent!.releaseToolFacts(accepted.data.runId!)).toThrow();
  const newWorkspace = repo.updateWorkspace({ selection: { ...frozen.selection!, field: 'deviceName' } }, frozen.revision, new Date().toISOString());
  const nextRequest = SubmitInputSchema.parse({ ...request, mode: 'steer', targetRunId: accepted.data.runId, clientSequence: 3, text: '核对名称', expectedRevision: newWorkspace.revision });
  const queued = await app.runs.submitAgent(nextRequest, { instanceId: 'fixture', operationRef: 'steer' });
  if (!queued.ok || !queued.data.inputId) throw new Error('queue failed');
  expect(repo.readInput({ inputId: queued.data.inputId })?.status).toBe('queued');
  repo.updateWorkspace({ queryId: null, selection: null }, newWorkspace.revision, new Date().toISOString());
  gates[0]!.resolve(); await waitRequest(2);
  const rootResult = (requests[1]!.messages as { role: string; content: string }[]).filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  expect(rootResult).toMatchObject([{ workspaceInputId: accepted.data.inputId, workspaceContext: { queryId: original.id, selection: { targetVersion: queryTargetVersion(original), rowKey: 'snapshot:1', field: 'priceCents' } } }]);
  expect(repo.readInput({ inputId: queued.data.inputId })?.status).toBe('consumed');
  gates[1]!.resolve(); await waitRequest(3);
  const nextResult = (requests[2]!.messages as { role: string; content: string }[]).filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  expect(nextResult).toContainEqual({ scope: priorScope, referenceDate: '2026-01-01', timezone: 'Asia/Shanghai', workspaceContext: toWorkspaceContext(newWorkspace), workspaceInputId: queued.data.inputId });
  gates[2]!.resolve(); for (let i = 0; i < 1000 && app.runs.activeHandle; i++) await Bun.sleep(2);
  expect(app.runs.activeHandle).toBeNull();
  const inputJson = JSON.parse(db.query<{ content_json: string }, [number]>('SELECT content_json FROM session_inputs WHERE id=?').get(accepted.data.inputId)!.content_json);
  const runJson = db.query<{ workspace_json: string; config_json: string }, [number]>('SELECT workspace_json,config_json FROM runs WHERE id=?').get(accepted.data.runId)!;
  expect(inputJson.workspaceContext).toEqual(frozen); expect(JSON.parse(runJson.workspace_json)).toEqual(frozen); expect(JSON.parse(runJson.config_json).workspaceContext).toBeUndefined();
  const produced = db.query<{ input_id: number; based_on_query_id: number; params_json: string; result_json: string }, [number]>('SELECT input_id,based_on_query_id,params_json,result_json FROM queries WHERE run_id=?').get(accepted.data.runId)!;
  expect(produced.input_id).toBe(accepted.data.inputId); expect(produced.based_on_query_id).toBe(original.id); expect(JSON.parse(produced.params_json).batchIds).toEqual([1]);
  expect(JSON.parse(produced.result_json).rows).toHaveLength(2);
  expect(db.query('SELECT tool_version,status FROM tool_calls WHERE tool_name=? ORDER BY id').all('read_data_scope')).toEqual([{ tool_version: '1.1.0', status: 'succeeded' }, { tool_version: '1.1.0', status: 'succeeded' }]);
  expect(db.query('SELECT COUNT(*) n FROM model_calls WHERE run_id=?').get(accepted.data.runId)).toEqual({ n: 3 });
  expect(db.query('SELECT COUNT(*) n FROM tool_calls WHERE run_id=?').get(accepted.data.runId)).toEqual({ n: 3 });
  expect(db.query('SELECT DISTINCT input_id FROM model_calls WHERE run_id=?').all(accepted.data.runId)).toEqual([{ input_id: accepted.data.inputId }]);
}, 15000);

test('production tool context without an accepted frozen workspace fails closed with state_conflict', async () => {
  const c = await fixture(), d = await databaseFixture(), faults: string[] = [], abort = new AbortController();
  const registry = new ToolRegistry([createReadDataScopeTool({ catalog: new CatalogService({ batches: [], devices: [], snapshots: [], changes: [] }) })]);
  const recorder = new ToolRecorder(new SqliteToolStore(d.db)), history=nativeHistoryFixture(),agent = new PiAgentRuntime(c.runtime, c.root, history.history, { registry, recorder, executor: new ToolExecutor(registry, recorder) });
  history.bind(agent,d.context.sessionId);
  const running = agent.execute({ runId: d.context.runId, sessionId: d.context.sessionId, text: 'scope', resolved: c.resolved, agentOptions: agent.describe(c.resolved), scope,
    referenceDate: '2026-01-01', timezone: 'Asia/Shanghai', signal: abort.signal, deadlineAt: performance.now() + 10000 }, {
    startCall: time => new ModelCallRecorder(d.repo, d.context.runId, 'main', time), preview: () => {}, nativeTerminal: () => {}, fatal: error => { faults.push(error.code); abort.abort(); },
  });
  await c.waitRequest(1); c.gates[0]!.resolve(); await running;
  expect(faults).toContain('state_conflict'); expect(d.db.query('SELECT COUNT(*) n FROM tool_calls').get()).toEqual({ n: 0 });
  const sessions = Reflect.get(agent, 'sessions') as Map<number, { session?: { dispose(): void } }>;
  sessions.forEach(binding => binding.session?.dispose());
});


// Break caught: an early identity observer caches the root signal and loses a later SDK cancellation.
test('frozen tool identity still observes the SDK signal supplied after its first lookup', () => {
  const getContext = adapters.createFrozenToolContextFactory(nativeToolCallId => ({ runId: 41, sessionId: 7, nativeToolCallId, scope, referenceDate: '2026-01-01', timezone: 'Asia/Shanghai', signal: new AbortController().signal }));
  getContext('call'); const sdk = new AbortController(); sdk.abort();
  expect(getContext('call', sdk.signal).signal.aborted).toBe(true);
});

test('historical read_data_scope retains its saved 1.0.0 output and legacy metadata context', async () => {
  const c = await databaseFixture(); c.consume(); const store = new SqliteToolStore(c.db);
  const { workspaceContext: _workspace, workspaceInputId: _input, workspaceRevision: _revision, basedOnQueryId: _query, ...legacy } = c.context;
  const oldOutput = { scope: c.context.scope, referenceDate: '2026-01-01', timezone: 'Asia/Shanghai' };
  const call = store.request({ name: 'read_data_scope', version: '1.0.0', effect: 'READ', executionMode: 'parallel' }, {}, legacy);
  store.transition(call.id, 'requested', 'running'); store.transition(call.id, 'running', 'succeeded', { status: 'succeeded', data: oldOutput });
  const record = store.readCall(legacy)!; expect(record.version).toBe('1.0.0'); expect(record.data).toEqual(oldOutput);
  expect(Object.hasOwn(record.data as object, 'workspaceContext')).toBe(false);
  const catalog = new CatalogService({ batches: [], devices: [], snapshots: [], changes: [] });
  expect(catalog.readScope(legacy)).toMatchObject({ workspaceContext: null, workspaceInputId: null });
});
