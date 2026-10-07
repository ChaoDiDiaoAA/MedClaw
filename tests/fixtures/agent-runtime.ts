import { expect } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
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
import { restoreNativeManager } from '../../packages/runtime-pi/src/memory-store';
import type { AnyToolDefinition } from '../../packages/contracts/src/tool';

export async function agentRuntimeFixture(respond?: (index: number, payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>, extensions = false) {
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
  const configure = (_configuration:unknown, extraDefinitions:readonly AnyToolDefinition[]=[]) => {const combined=new ToolRegistry([...registry.definitions,...extraDefinitions]);return {registry:combined,executor:new ToolExecutor(combined,recorder,{findCommittedChild:context=>repos.findCommittedChild(context)})};};
  const agent = new PiAgentRuntime(runtime, root, history, { registry, recorder, executor: new ToolExecutor(registry, recorder), configure }, new ContextService(contexts, { inspectManagedImport: async () => ({ status: 'valid' as const }) }),join(author,'extensions'));
  const allocated = agent.allocate(); repos.createSession({ expectedWorkspaceRevision: 0 }, 'create-a', allocated.nativeSessionId, new Date().toISOString(), allocated.history); allocated.bind(1);
  const catalogue = ResourceCatalogueSchema.parse(JSON.parse(readFileSync(join(author, 'catalog.json'), 'utf8'))), prompt = catalogue.definitions.find(r => r.kind === 'prompt')!, skill = catalogue.definitions.find(r => r.kind === 'skill')!;
  const ref = ({ kind, id, version, treeHash }: typeof prompt) => ({ kind, id, version, treeHash });
  const descriptor=extensions?await agent.readExtensionDescriptor():null;
  const config = PublishedSettingsSchema.parse({ schemaVersion: 'medclaw.settings/p1-v1', configVersion: '1', model: { provider: 'p11-fixture', modelId: 'fixture' }, customProviders: [{ definition, credentialRef: null }], credentialRefs: {}, previous: null, rollbackFromVersion: null,
    ...(extensions?{extensions:{bySession:{'1':{extension:descriptor!.ref}}}}:{}),
    requestPolicy: { timeoutMs: 15000, maxRetries: 0, maxRetryDelayMs: 2000 }, resources: { bySession: { '1': { prompt: ref(prompt), skills: [ref(skill)] } } } });
  const source = createResourceSource(author);
  const starter=Object.assign((...args:Parameters<ModelCallStarter>)=>new ModelCallRecorder(repos,...args),{forCompaction:(owner:CompactionCallOwner,time:string)=>ModelCallRecorder.forCompaction(repos,owner,time)});
  const app = new Application('host', config, runtime, repos, async (_context, action) => action(), starter, () => {}, error => errors.push(error), agent, undefined, SqliteWriteTransactions.forDatabase(db), source);
  const request = (text: string): SubmitInput => SubmitInputSchema.parse({ sessionId: 1, clientSequence: repos.readSession(1)!.nextSubmissionSequence, mode: 'send', text, expectedRevision: repos.readWorkspace().revision, expectedBatchIds: repos.readWorkspace().batchRefs.map(ref=>ref.id), expectedQueryId: repos.readWorkspace().queryId, model: { provider: 'p11-fixture', modelId: 'fixture', expectedConfigVersion: app.config.configVersion }, referenceDate: '2026-10-06', timezone: 'Asia/Shanghai' });
  const settle = async () => { for (let i = 0; i < 2000 && app.runs.busy; i++) await Bun.sleep(2); expect(app.runs.busy).toBe(false); };
  const content = (id: number) => InputContentSchema.parse(JSON.parse(db.query<{ content_json: string }, [number]>('SELECT content_json FROM session_inputs WHERE id=?').get(id)!.content_json));
  return { root, author, db, requests, errors, app, agent, repos, contexts, source, toolStore, recorder, runtime, history, registry, prompt: ref(prompt), skill: ref(skill), request, settle, content,
    close: async () => { try { await app.runs.shutdown(); } finally { server.stop(true); db.close(); rmSync(root, { recursive: true, force: true }); } } };
}
