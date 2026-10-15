import { afterEach, expect, spyOn, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { DEFAULT_AGENT_POLICY, type AgentPolicy, type MeasurementContext } from '../../packages/contracts/src/model';
import type { ToolExecutionContext } from '../../packages/contracts/src/tool';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { QueryService } from '../../packages/core/src/data/query-service';
import { EvidenceReader } from '../../packages/core/src/evidence/evidence-reader';
import { RunControl } from '../../packages/core/src/runtime/run-control';
import { ToolExecutor } from '../../packages/core/src/tools/executor';
import { ToolRecorder } from '../../packages/core/src/tools/recorder';
import { ToolRegistry } from '../../packages/core/src/tools/registry';
import { createBusinessTools } from '../../packages/core/src/tools/tools';
import { buildToolProfiles, TOOL_PROFILE_RULES } from '../../packages/core/src/tools/tool-profile';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { createPiRunControlBinding, createPiToolDefinitions, observePiToolDelivery } from '../../packages/runtime-pi/src/pi-tool-adapter';
import { SqliteCatalogStore } from '../../packages/storage/src/catalog-store';
import { openDatabase } from '../../packages/storage/src/database';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

type Call = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
type Step = (fixture: Fixture, request: Record<string, unknown>) => Call | null;
type Fixture = {
  db: Database;
  store: SqliteToolStore;
  catalog: CatalogService;
  queries: QueryService;
  evidence: EvidenceReader;
  control: RunControl;
  getContext: (nativeToolCallId: string, signal?: AbortSignal) => ToolExecutionContext;
  recorder: ToolRecorder;
  session: AgentSession;
  requests: Record<string, unknown>[];
  stepErrors: unknown[];
  measurementContext: MeasurementContext;
};
const currentInput = {
  batchIds: [1],
  time: {
    start: '2026-01-01',
    endExclusive: '2026-01-02',
  },
};

// This loopback Provider scripts engineering fault boundaries; it supplies no formal evaluation Gold.
async function setup(steps: Step[], originalHooks?: (session: AgentSession) => void, policy: AgentPolicy = DEFAULT_AGENT_POLICY): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p3-controlled-recovery-'));
  const db = openDatabase(join(root, 'app.sqlite'));
  const scope = {
    batchIds: [1],
    deviceIds: null,
    allowedToolNames: ['query_current_devices', 'read_query', 'list_batches', 'read_query_evidence'],
    allowedResourceRefs: [],
    artifactIds: [],
    readOnly: true,
  };
  const createdAt = new Date().toISOString();
  const measurementContext: MeasurementContext = {
    version: 'medclaw.tool-measurement/v1',
    sdkVersion: '0.87.1',
    environmentKey: 'controlled-recovery-fixture',
    cutoffAt: createdAt,
    maxToolCallId: null,
  };
  db.query(`INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at)
    VALUES(1,'native','create','{}','{}','Recovery fixture',?,?)`).run(createdAt, createdAt);
  db.query(`INSERT INTO runs(id,session_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,
    config_json,scope_json,workspace_json,reference_date,timezone,created_at)
    VALUES(1,1,'agent','fixture','submit',1,'{"sessionId":1,"clientSequence":1}','running','query','Read devices',
      '{"agent":{"nativeSessionId":"native"}}',?,'{}','2026-01-01','Asia/Shanghai',?)`).run(JSON.stringify(scope), createdAt);
  db.query('UPDATE runs SET config_json=? WHERE id=1').run(JSON.stringify({ agent: { nativeSessionId: 'native' },
    agentPolicy: policy, measurementContext }));
  db.query(`INSERT INTO imports(id,operation_ref,instance_id,state,preview_request_json,created_at,updated_at)
    VALUES(1,'import','fixture','imported','{}',?,?)`).run(createdAt, createdAt);
  db.query('UPDATE catalog_state SET revision=1,updated_at=?').run(createdAt);
  db.query(`INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,coverage,
    expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at)
    VALUES(1,1,'scope','2026-01-01','浙江','fixture/v1','bundle','full',1,1,'[]','{}',1,NULL,1,?)`).run(createdAt);
  const sources = JSON.stringify([{ sourceId: 'fixture', file: 'saved-source.csv', recordId: 'device-1', row: 1 }]);
  db.query(`INSERT INTO devices(id,source_device_id,source_bundle_id,source_submission_id,source_refs_json,created_at)
    VALUES(1,'device-1','bundle','submission',?,?)`).run(sources, createdAt);
  db.query(`INSERT INTO snapshots(id,batch_id,device_id,device_name,category,region,price_cents,currency,unit,status,manufacturer,distributor,
    source_row_ref,source_refs_json,field_origins_json)
    VALUES(1,1,1,'Fixture device','Fixture','浙江',100,'CNY','件','active','Fixture manufacturer','Fixture distributor','1:1',?,'{}')`).run(sources);
  const store = new SqliteToolStore(db);
  const catalog = new CatalogService(new SqliteCatalogStore(db));
  const queries = new QueryService(catalog, store);
  const evidence = new EvidenceReader(catalog, queries, store);
  const registry = new ToolRegistry(createBusinessTools({ catalog, queries, evidence }));
  const recorder = new ToolRecorder(store);
  const executor = new ToolExecutor(registry, recorder);
  const abort = new AbortController();
  const control = new RunControl({ runId: 1, policy, scope, signal: abort.signal,
    deadlineAt: performance.now() + 30000, totalTimeoutMs: 30000, measurementContext });
  const getContext = (nativeToolCallId: string, signal?: AbortSignal): ToolExecutionContext => ({
    runId: 1,
    sessionId: 1,
    nativeToolCallId,
    scope,
    referenceDate: '2026-01-01',
    timezone: 'Asia/Shanghai',
    signal: signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
    checkActive: control.checkActive,
  });
  const requests: Record<string, unknown>[] = [];
  const stepErrors: unknown[] = [];
  let fixture!: Fixture;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    requests.push(body);
    let call: Call | null = null;
    try { call = steps[requests.length - 1]?.(fixture, body) ?? null; }
    catch (error) { stepErrors.push(error); }
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: 'assistant', content: 'Fixture complete.' };
    const chunk = { id: 'fixture', model: 'fixture', choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('recovery-fixture', async () => ({ type: 'api_key', key: 'fixture-only' }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  await runtime.installCustom([{ providerId: 'recovery-fixture', name: 'Recovery fixture', api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false,
      contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] }]);
  const resolved = await runtime.resolve({ provider: 'recovery-fixture', modelId: 'fixture', expectedConfigVersion: '1' }, '1', null,
    { timeoutMs: 10000, maxRetries: 0, maxRetryDelayMs: 2000 });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', defaultTools: [],
    packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false, enableInstallTelemetry: false });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'pi'), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Use the saved data tools.' });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: join(root, 'pi'), modelRuntime: runtime.native, model: resolved.model,
    thinkingLevel: 'off', tools: scope.allowedToolNames, customTools: createPiToolDefinitions(registry, executor, getContext, () => control),
    settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) });
  // Preserve a real original Hook before installing MedClaw's chaining binding.
  originalHooks?.(session);
  const stopDelivery = observePiToolDelivery(session, registry, recorder, getContext, () => control);
  const stopControl = createPiRunControlBinding(session, registry, recorder, getContext, () => control)();
  const provider = session.agent.streamFunction;
  session.agent.streamFunction = async (model, context, options) => {
    const admission = control.admitModelCall();
    const messages = context.messages.map(message => message.role === 'system' && !admission.allowTools
      ? { ...message, toolsAdded: [], toolsRemoved: [] } : message);
    messages.push({ role: 'system', content: `Trusted runtime feedback:\n${admission.feedback}`, timestamp: Date.now() });
    return provider(model, { ...context, messages }, options);
  };
  closers.push(async () => {
    await session.abort();
    await session.waitForIdle();
    stopDelivery();
    stopControl();
    control.dispose();
    session.dispose();
    server.stop(true);
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  fixture = { db, store, catalog, queries, evidence, control, getContext, recorder, session, requests, stepErrors, measurementContext };
  return fixture;
}

function queryId(fixture: Fixture) {
  const query = fixture.store.findQuery('1:query-original');
  if (!query) throw new Error('The original Query was not committed.');
  return query.id;
}
function toolMessage(fixture: Fixture, id: string) {
  const entry = fixture.session.sessionManager.getEntries().findLast(entry => entry.type === 'message'
    && entry.message.role === 'toolResult' && entry.message.toolCallId === id);
  if (!entry || entry.type !== 'message' || entry.message.role !== 'toolResult') throw new Error('An actual SDK result is missing.');
  return entry.message;
}

for (const afterFailure of ['throw', 'malformed result']) test(`committed Query survives after ${afterFailure} and same-parameter new identity cannot recalculate it before original read recovery`, async () => {
  const fixture = await setup([
    () => ({ id: 'query-original', name: 'query_current_devices', arguments: currentInput }),
    fixture => {
      expect(fixture.db.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 1 });
      expect(fixture.control.summary().unresolvedItems).toContain('query-original');
      return { id: 'query-recalculate', name: 'query_current_devices', arguments: currentInput };
    },
    fixture => {
      expect(fixture.db.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 1 });
      expect(toolMessage(fixture, 'query-recalculate').isError).toBe(true);
      return { id: 'query-read', name: 'read_query', arguments: { queryId: queryId(fixture) } };
    },
    fixture => {
      expect(toolMessage(fixture, 'query-read').isError).toBe(false);
      expect(fixture.control.summary().unresolvedItems).toEqual([]);
      return null;
    },
  ], session => {
    session.agent.afterToolCall = async context => {
      if (context.toolCall.id === 'query-original') {
        if (afterFailure === 'throw') throw new Error('Fixture original after failure.');
        return JSON.parse('{"content":[{"type":"unsupported"}]}');
      }
    };
  });
  await fixture.session.prompt('Query the explicit day and recover the original result if delivery fails.');
  if (fixture.stepErrors.length) throw fixture.stepErrors[0];
  expect(fixture.requests).toHaveLength(4);
  expect(fixture.db.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 1 });
  expect(fixture.db.query('SELECT COUNT(*) AS n FROM query_evidence').get()).toEqual({ n: 1 });
  const original = fixture.store.readCall(fixture.getContext('query-original'))!;
  expect(original).toMatchObject({ status: 'succeeded', sdkReturned: true, data: { queryId: queryId(fixture), totalRows: 1 },
    control: { postflightStatus: 'failed', hookFailure: { stage: 'afterToolCall', code: 'tool_postprocess_failed' } } });
  expect(original.sdkDelivery?.isError).toBe(true);
  const read = fixture.store.readCall(fixture.getContext('query-read'))!;
  expect(read).toMatchObject({ status: 'succeeded', sdkReturned: true, data: { queryId: queryId(fixture), totalRows: 1 },
    control: { recoveryAction: 'recovered', repairOfToolCallId: original.id } });
  expect(read.sdkDelivery?.isError).toBe(false);
  const savedEvidence = fixture.evidence.readQuery(queryId(fixture), fixture.getContext('query-read'));
  expect(savedEvidence).toHaveLength(1);
  expect(fixture.evidence.read(savedEvidence[0]!.id, fixture.getContext('query-read')).queryId)
    .toBe(fixture.queries.read(queryId(fixture), fixture.getContext('query-read')).id);
  expect(fixture.control.readBudget().recovery.episodeId).toBeNull();
});

test('SDK rejected parameters yield safe real history and only-invalid-field correction with omitted defaults closes recovery', async () => {
  const marker = 'synthetic-private-input-marker';
  const fixture = await setup([
    () => ({ id: 'invalid-input', name: 'list_batches', arguments: { page: marker } }),
    (fixture, request) => {
      const messages = request.messages as { role: string; content: unknown }[];
      expect(JSON.stringify(messages.filter(message => message.role === 'tool' || message.role === 'system'))).not.toContain(marker);
      const failed = fixture.store.readCall(fixture.getContext('invalid-input'))!;
      expect(failed).toMatchObject({ status: 'failed', sdkReturned: true, error: { code: 'tool_input_invalid' },
        control: { inputValidation: 'failed', executionElapsedMs: null } });
      expect(failed.control?.validationIssues.some(issue => issue.fieldPath.join('.') === 'page')).toBe(true);
      expect(JSON.stringify(toolMessage(fixture, 'invalid-input'))).not.toContain(marker);
      return { id: 'corrected-input', name: 'list_batches', arguments: { page: 1 } };
    },
    fixture => {
      expect(toolMessage(fixture, 'corrected-input').isError).toBe(false);
      expect(fixture.control.summary().unresolvedItems).toEqual([]);
      return null;
    },
  ]);
  await fixture.session.prompt('List the allowed batches and correct only invalid pagination.');
  if (fixture.stepErrors.length) throw fixture.stepErrors[0];
  expect(fixture.requests).toHaveLength(3);
  const failed = fixture.store.readCall(fixture.getContext('invalid-input'))!;
  const corrected = fixture.store.readCall(fixture.getContext('corrected-input'))!;
  expect(corrected).toMatchObject({ status: 'succeeded', sdkReturned: true, input: { page: 1, pageSize: 50 },
    data: { totalRows: 1 }, control: { recoveryAction: 'recovered' } });
  expect(corrected.sdkDelivery?.isError).toBe(false);
  expect(fixture.control.readBudget().recovery.episodeId).toBeNull();
  expect(failed.control?.workloadBucket).not.toBeNull();
  const cutoffAt = new Date().toISOString();
  const observations = fixture.store.readToolObservations({ limit: TOOL_PROFILE_RULES.observationLimit, windowDays: TOOL_PROFILE_RULES.windowDays, cutoffAt });
  expect(observations.observations.find(row => row.id === failed.id)).toMatchObject({
    startedAt: null,
    measurementContext: fixture.measurementContext,
    control: { inputValidation: 'failed', environmentKey: fixture.measurementContext.environmentKey },
  });
  const profiles = buildToolProfiles(observations, { ...fixture.measurementContext, cutoffAt, maxToolCallId: observations.maxToolCallId });
  expect(profiles.profiles.filter(profile => profile.name === 'list_batches')
    .reduce((sum, profile) => sum + (profile.reliability.inputRejections ?? 0), 0)).toBe(1);
  expect(profiles.profiles.filter(profile => profile.name === 'list_batches')
    .reduce((sum, profile) => sum + profile.completeSamples, 0)).toBe(1);
  expect(corrected.control?.repairOfToolCallId).toBe(failed.id);
});

test('after error override cannot close recovery until a later non-error receipt resolves all failures for the original Query', async () => {
  const fixture = await setup([
    () => ({ id: 'query-original', name: 'query_current_devices', arguments: currentInput }),
    fixture => ({ id: 'query-read-error', name: 'read_query', arguments: { queryId: queryId(fixture) } }),
    fixture => {
      expect(toolMessage(fixture, 'query-read-error').isError).toBe(true);
      expect(fixture.control.summary().unresolvedItems).toContain('query-original');
      expect(fixture.db.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 1 });
      return { id: 'query-read-success', name: 'read_query', arguments: { queryId: queryId(fixture) } };
    },
    fixture => {
      expect(toolMessage(fixture, 'query-read-success').isError).toBe(false);
      expect(fixture.control.summary().unresolvedItems).toEqual([]);
      return null;
    },
  ], session => {
    session.agent.afterToolCall = async context => {
      if (context.toolCall.id === 'query-original') throw new Error('Fixture original after failure.');
      if (context.toolCall.id === 'query-read-error') return { isError: true };
    };
  });
  await fixture.session.prompt('Read the saved Query after the original delivery error.');
  if (fixture.stepErrors.length) throw fixture.stepErrors[0];
  expect(fixture.requests).toHaveLength(4);
  expect(fixture.db.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 1 });
  expect(fixture.db.query('SELECT COUNT(*) AS n FROM query_evidence').get()).toEqual({ n: 1 });
  expect(fixture.store.readCall(fixture.getContext('query-read-error'))).toMatchObject({
    status: 'succeeded',
    sdkReturned: true,
    data: { queryId: queryId(fixture) },
    sdkDelivery: { isError: true },
    control: { failureClass: 'tool_postprocess_failed', failureStage: 'sdk_delivery' },
  });
  expect(fixture.store.readCall(fixture.getContext('query-read-success'))).toMatchObject({
    status: 'succeeded',
    sdkReturned: true,
    data: { queryId: queryId(fixture) },
    sdkDelivery: { isError: false },
    control: { recoveryAction: 'recovered' },
  });
  expect(fixture.control.summary().unresolvedItems).toEqual([]);
  expect(fixture.control.readBudget().recovery.episodeId).toBeNull();
});

test('actual snapshot inconsistency persists business validation failure and rebuilds its reliability count without committing a Query', async () => {
  const fixture = await setup([
    () => ({ id: 'inconsistent-snapshot', name: 'query_current_devices', arguments: currentInput }),
    fixture => {
      expect(toolMessage(fixture, 'inconsistent-snapshot').isError).toBe(true);
      return null;
    },
  ]);
  // The persisted snapshot conflicts with its actual batch; the domain service must detect it.
  fixture.db.query("UPDATE snapshots SET region='上海' WHERE id=1").run();
  await fixture.session.prompt('Read the explicit-day devices and report any inconsistent saved data.');
  if (fixture.stepErrors.length) throw fixture.stepErrors[0];
  expect(fixture.requests).toHaveLength(2);
  expect(fixture.db.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 0 });
  expect(fixture.db.query('SELECT COUNT(*) AS n FROM query_evidence').get()).toEqual({ n: 0 });
  const failed = fixture.store.readCall(fixture.getContext('inconsistent-snapshot'))!;
  expect(failed).toMatchObject({
    status: 'failed',
    error: { code: 'tool_output_inconsistent' },
    sdkReturned: true,
    control: {
      inputValidation: 'passed',
      businessValidation: { post: 'failed' },
      failureClass: 'tool_output_inconsistent',
      failureStage: 'business_post',
      failureVisibility: 'implicit',
      environmentKey: fixture.measurementContext.environmentKey,
    },
  });
  expect(failed.sdkDelivery?.isError).toBe(true);
  const cutoffAt = new Date().toISOString();
  const observations = fixture.store.readToolObservations({ limit: TOOL_PROFILE_RULES.observationLimit, windowDays: TOOL_PROFILE_RULES.windowDays, cutoffAt });
  expect(observations.observations.find(row => row.id === failed.id)?.control?.businessValidation.post).toBe('failed');
  const profiles = buildToolProfiles(observations, { ...fixture.measurementContext, cutoffAt, maxToolCallId: observations.maxToolCallId });
  const profile = profiles.profiles.find(profile => profile.name === 'query_current_devices')!;
  expect(profile.reliability.businessValidationFailures).toBe(1);
  expect(profile.reliability.executionFailures).toBe(0);
  expect(profile.completeSamples).toBe(0);
});

test('a Query committed before the executor timeout check preserves its original identity and must be read instead of recalculated', async () => {
  let clock: ReturnType<typeof spyOn<typeof performance, 'now'>> | undefined;
  let observedCommittedQueryId: number | null = null;
  let actualDomainCalls = 0;
  const fixture = await setup([
    () => ({ id: 'query-original', name: 'query_current_devices', arguments: currentInput }),
    fixture => {
      clock?.mockRestore();
      clock = undefined;
      const original = fixture.store.readCall(fixture.getContext('query-original'))!;
      expect(original).toMatchObject({
        status: 'failed',
        error: { code: 'tool_timeout' },
        data: { queryId: observedCommittedQueryId, totalRows: 1 },
        sdkReturned: true,
        control: { failureClass: 'tool_timeout', latencyObservation: 'right_censored' },
      });
      expect(toolMessage(fixture, 'query-original').isError).toBe(true);
      expect(fixture.db.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 1 });
      expect(JSON.parse(fixture.control.feedback()).failures[0].queryId).toBe(observedCommittedQueryId);
      return { id: 'query-recalculate', name: 'query_current_devices', arguments: currentInput };
    },
    fixture => {
      expect(toolMessage(fixture, 'query-recalculate').isError).toBe(true);
      expect(fixture.store.readCall(fixture.getContext('query-recalculate'))?.error?.code).toBe('operation_result_unknown');
      expect(fixture.db.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 1 });
      return { id: 'query-read', name: 'read_query', arguments: { queryId: queryId(fixture) } };
    },
    fixture => {
      expect(toolMessage(fixture, 'query-read').isError).toBe(false);
      expect(fixture.control.summary().unresolvedItems).toEqual([]);
      return null;
    },
  ], undefined, { ...DEFAULT_AGENT_POLICY, singleToolTimeoutMs: 1000 });
  const originalCurrent = fixture.queries.current.bind(fixture.queries);
  const current = spyOn(fixture.queries, 'current').mockImplementation((input, context) => {
    // The actual domain method has returned only after its real SQLite transaction committed.
    actualDomainCalls++;
    const result = originalCurrent(input, context);
    observedCommittedQueryId = result.queryId;
    expect(fixture.store.findQuery('1:query-original')?.id).toBe(result.queryId);
    expect(fixture.db.query('SELECT COUNT(*) AS n FROM query_evidence').get()).toEqual({ n: 1 });
    const timeout = fixture.control.observation(context.nativeToolCallId).effectiveTimeoutMs!;
    clock = spyOn(performance, 'now').mockReturnValue(performance.now() + timeout + 1);
    return result;
  });
  try {
    await fixture.session.prompt('Query the explicit day and recover the saved result after any confirmed tool timeout.');
    if (fixture.stepErrors.length) throw fixture.stepErrors[0];
  } finally {
    clock?.mockRestore();
    current.mockRestore();
  }
  expect(fixture.requests).toHaveLength(4);
  expect(actualDomainCalls).toBe(1);
  expect(fixture.db.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 1 });
  expect(fixture.db.query('SELECT COUNT(*) AS n FROM query_evidence').get()).toEqual({ n: 1 });
  expect(fixture.store.readCall(fixture.getContext('query-read'))).toMatchObject({
    status: 'succeeded',
    data: { queryId: observedCommittedQueryId },
    sdkDelivery: { isError: false },
    control: { recoveryAction: 'recovered' },
  });
  expect(fixture.control.readBudget().recovery.episodeId).toBeNull();
});
