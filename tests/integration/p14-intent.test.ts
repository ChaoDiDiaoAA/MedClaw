import { readIntentStageMessage } from '../fixtures/p14-intent';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteContextStore } from '../../packages/storage/src/context-store';
import { SqliteCatalogStore } from '../../packages/storage/src/catalog-store';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { SqliteEventStore } from '../../packages/storage/src/event-store';
import { SqliteWriteTransactions } from '../../packages/storage/src/write-transactions';
import { ContextService } from '../../packages/core/src/context/context-service';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { QueryService } from '../../packages/core/src/data/query-service';
import { RunControl } from '../../packages/core/src/runtime/run-control';
import { IntentService } from '../../packages/core/src/intent/intent-service';
import { IntentValidator } from '../../packages/core/src/intent/validate';
import { CLASSIFY_PROMPT } from '../../packages/core/src/intent/prompts/classify';
import { VERIFY_PROMPT } from '../../packages/core/src/intent/prompts/verify';
import { OllamaIntentClient } from '../../packages/intent-ollama/src/index';
import { IntentInputProjectionSchema, IntentModelSelectionSchema, INTENT_VERSIONS, type IntentStageInput } from '../../packages/contracts/src/intent';
import { normalizeRuntimeConfiguration, RUNTIME_CONFIG } from '../../packages/contracts/src/runtime-config';
import { type EventWriter } from '../../packages/contracts/src/event';
import { safeError } from '../../packages/contracts/src/error';
import { QueryParamsSchema, type QueryExecutionContext } from '../../packages/contracts/src/query';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { acceptContextInput } from '../fixtures/p8-context';
import { disabledIntentModel, intentInput, resolvedIntent } from '../fixtures/p14-intent';

type Mode = 'rule' | 'classify' | 'verify' | 'http' | 'json' | 'digest' | 'b2_failure' | 'delivery_failure' | 'stop_rule' | 'stop_classify'
  | 'ambiguous' | 'missing' | 'unsupported' | 'ood' | 'multi' | 'verify_expand' | 'verify_unresolved';
function fixture(mode: Mode | 'slow_preflight' | 'b1_failure' | 'b3_failure', maxModelCalls = 5, timeoutMs = 10000) {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p14-service-')), db = openDatabase(join(root, 'app.sqlite'));
  const transactions = SqliteWriteTransactions.forDatabase(db), abort = new AbortController(), actualEvents = new SqliteEventStore(db, transactions);
  let failSave = false, chats = 0;
  const events: EventWriter = { appendInTransaction(draft) {
    const saved = actualEvents.appendInTransaction(draft);
    if (mode === 'stop_rule' && draft.type === 'intent_rule_evaluated' || mode === 'stop_classify' && draft.type === 'intent_finished') transactions.afterCommit(() => {
      db.query('UPDATE runs SET cancel_requested_at=? WHERE id=?').run(new Date().toISOString(), draft.runId); abort.abort();
    });
    return saved;
  } };
  const repos = new Repositories(db, () => { if (failSave || mode === 'b3_failure' && db.query('SELECT id FROM route_decisions').get()) throw safeError('storage_write_failed'); }, events, transactions);
  seedWorkspaceQueries(db, repos);
  const toolNames = ['query_current_devices', 'query_device_changes'];
  const accepted = acceptContextInput(db, { consume: false, repositories: repos, toolNames,
    text: mode === 'rule' || mode === 'stop_rule' ? '查询2026-10-04在浙江的全部医疗器械。' : '列出所有医疗器械' });
  const session = repos.readSession(accepted.input.sessionId)!;
  const input = IntentInputProjectionSchema.parse({ ...intentInput(), runId: accepted.input.runId, sessionId: accepted.input.sessionId,
    inputId: accepted.input.inputId, text: accepted.request.text, referenceDate: accepted.request.referenceDate,
    baseLeafId: session.leafId, baseStorageVersion: session.storageVersion, scope: accepted.input.scope, scopeBatchHashes: ['a'.repeat(64)],
    availableData: { regions: ['浙江'], dates: ['2026-10-04'], currencies: ['CNY'], units: ['台'] },
    enabledL2: ['PRODUCT_SEARCH', 'NEW_RECORDS'], availableToolNames: toolNames });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/version') { if (mode === 'slow_preflight') await Bun.sleep(150); return Response.json({ version: 'ENGINEERING-0.40.2' }); }
    if (path === '/api/tags') return Response.json({ models: [{ name: 'qwen3.5:0.8b', digest: (mode === 'digest' ? 'b' : 'a').repeat(64) }] });
    if (path === '/api/show') return Response.json({ details: { family: 'qwen35', parameter_size: '752.39M', quantization_level: 'Q8_0' } });
    if (path !== '/api/chat') return new Response('Unexpected endpoint', { status: 404 });
    chats++;
    if (mode === 'http') return new Response('ENGINEERING failure', { status: 503 });
    const body = await request.json() as { messages: { content: string }[] }, stage = readIntentStageMessage(body.messages[1]!.content) as IntentStageInput;
    let result: unknown = stage.stage === 'verify' ? { ...resolvedIntent(), intents: stage.review!.candidates[0]!.intents } : resolvedIntent();
    if (['verify', 'stop_classify', 'verify_expand', 'verify_unresolved'].includes(mode) && stage.stage === 'classify') result = { ...resolvedIntent(),
      intents: [{ ...resolvedIntent().intents[0]!, l0: 'DATA_OPERATIONS' }] };
    if (mode === 'ood') result = { contract: 'medclaw.intent/v2', status: 'OUT_OF_SCOPE', intents: [], candidateIntents: [], clarification: null };
    if (mode === 'unsupported') result = { contract: 'medclaw.intent/v2', status: 'UNSUPPORTED_DATA', intents: [], candidateIntents: [], clarification: null };
    if (mode === 'missing') result = { ...resolvedIntent(), status: 'NEED_PARAMETERS', intents: [{ ...resolvedIntent().intents[0]!,
      l0: 'CHANGE_MONITOR', l1: 'RECORD_CHANGE', l2: 'NEW_RECORDS', slots: { ...resolvedIntent().intents[0]!.slots, changeKind: 'added' } }],
      clarification: { question: 'Select the period.', intentIds: ['s1'], missingSlots: ['s1.time'], options: [] } };
    if (mode === 'ambiguous' || mode === 'verify_unresolved' && stage.stage === 'verify') result = { ...resolvedIntent(), status: 'AMBIGUOUS', intents: [],
      candidateIntents: stage.review?.candidates ?? [{ reasonCode: 'schema_recovery', intents: resolvedIntent().intents }],
      clarification: { question: 'Confirm the requested task.', intentIds: ['s1'], missingSlots: [], options: [] } };
    if (mode === 'verify_expand' && stage.stage === 'verify') result = { ...resolvedIntent(), intents: stage.review!.candidates[0]!.intents.map(item => ({ ...item,
      slots: { ...item.slots, status: 'recalled' } })) };
    if (mode === 'multi') result = { ...resolvedIntent(), intents: ['active', 'delisted'].map((status, index) => ({ ...resolvedIntent().intents[0]!,
      id: `s${index + 1}`, slots: { ...resolvedIntent().intents[0]!.slots, status } })) };
    if (mode === 'b2_failure') failSave = true;
    if (mode === 'delivery_failure') db.query(`CREATE TRIGGER engineering_fail_delivery BEFORE INSERT ON context_deliveries BEGIN SELECT RAISE(ABORT,'ENGINEERING'); END`).run();
    return Response.json({ model: 'qwen3.5:0.8b', done: true, done_reason: 'stop',
      message: { role: 'assistant', content: mode === 'json' ? 'broken JSON' : JSON.stringify(result) },
      prompt_eval_count: 44, eval_count: 35, total_duration: 1000000 });
  } });
  const selection = IntentModelSelectionSchema.parse({ ...disabledIntentModel(), enabled: true, baseUrl: `http://127.0.0.1:${server.port}`,
    modelDigest: 'sha256:' + 'a'.repeat(64), verifiedEvidenceRef: 'ENGINEERING', configVersion: '1', api: 'ollama-chat', ...INTENT_VERSIONS });
  const contexts = new ContextService(new SqliteContextStore(db), { async inspectManagedImport() { throw new Error('Unexpected artifact'); } });
  const service = new IntentService(repos, contexts, new OllamaIntentClient({ classify: CLASSIFY_PROMPT, verify: VERIFY_PROMPT }),
    new IntentValidator(new CatalogService(new SqliteCatalogStore(db))), events, transactions);
  const control = new RunControl({ runId: input.runId, scope: input.scope, signal: abort.signal, deadlineAt: performance.now() + timeoutMs,
    runtimeConfiguration: normalizeRuntimeConfiguration({ runtimeConfiguration: { ...RUNTIME_CONFIG, runBudget: { ...RUNTIME_CONFIG.runBudget, maxModelCalls } } }) });
  const execution = { signal: abort.signal, control, workspaceContext: accepted.input.workspaceContext, expectedCancelEpoch: 0,
    checkActive() { const run = db.query<{ status: string; cancel_requested_at: string | null }, [number]>('SELECT status,cancel_requested_at FROM runs WHERE id=?').get(input.runId)!;
      if (abort.signal.aborted || run.cancel_requested_at !== null) throw new Error('tool_cancelled');
      if (!['created', 'running'].includes(run.status)) throw new Error('state_conflict');
    } };
  const queries = new QueryService(new CatalogService(new SqliteCatalogStore(db)), new SqliteToolStore(db));
  const queryContext = (decisionId: number): QueryExecutionContext => ({ runId: input.runId, inputId: input.inputId, sessionId: input.sessionId,
    scope: input.scope, referenceDate: input.referenceDate, timezone: input.timezone, signal: abort.signal, source: 'intent',
    callRef: `intent:${input.runId}:${decisionId}:s1`, checkActive: execution.checkActive });
  return { db, input, selection, service, control, execution, queries, queryContext,
    run: () => { if (mode === 'b1_failure') failSave = true; return service.recognize(input, selection, execution); }, chats: () => chats,
    releaseSave() { failSave = false; db.query('DROP TRIGGER IF EXISTS engineering_fail_delivery').run(); },
    close() { control.dispose(); server.stop(true); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const [mode, calls, matchedBy] of [['rule', 0, 'rule'], ['classify', 1, 'qwen_prompt'], ['verify', 2, 'paper_enhanced']] as const) {
  test(`p14 actual ${mode} composes HTTP, Context, SQLite and the same root budget with ${calls} calls`, async () => {
    const f = fixture(mode);
    try {
      const result = await f.run();
      expect(result.callIds).toHaveLength(calls);
      expect(result.decision).toMatchObject({ route: 'simple', status: 'RESOLVED', matchedBy,
        adoptedSlots: { time: { start: '2026-10-04', endExclusive: '2026-10-05' } } });
      expect(result.decisionId).toBeGreaterThan(0);
      expect(f.chats()).toBe(calls);
      expect(f.control.readBudget().modelCalls.used).toBe(calls);
      expect(f.db.query('SELECT id FROM runs').all()).toHaveLength(2);
      expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(f.input.runId)).toEqual([]);
      expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(f.input.runId)).toEqual([]);
      expect(f.db.query('SELECT status,native_entry_id FROM session_inputs WHERE id=?').get(f.input.inputId)).toEqual({ status: 'queued', native_entry_id: null });
      expect(f.db.query('SELECT id FROM context_snapshots WHERE run_id=?').all(f.input.runId)).toHaveLength(calls);
      expect(f.db.query('SELECT id FROM context_deliveries WHERE run_id=?').all(f.input.runId)).toHaveLength(calls);
      const read = f.service.read({ runId: f.input.runId })!;
      expect(read.calls.map(call => call.stage)).toEqual(calls === 2 ? ['classify', 'verify'] : calls ? ['classify'] : []);
      expect(read.calls.every(call => call.state === 'completed')).toBe(true);
      expect(read.decision?.id).toBe(result.decisionId);
      if (calls === 2) expect(read.calls[0]).toMatchObject({ prediction: null, validation: { state: 'invalid', reviewRequired: true } });
      await expect(f.run()).rejects.toMatchObject({ code: 'state_conflict' });
      expect(f.chats()).toBe(calls);
    } finally { f.close(); }
  });
}

for (const [mode, error, calls] of [['http', 'intent_response_invalid', 1], ['json', 'intent_output_invalid', 1], ['digest', 'intent_model_identity_mismatch', 0],
  ['stop_rule', 'tool_cancelled', 0], ['stop_classify', 'tool_cancelled', 1]] as const) {
  test(`p14 ${mode} retains actual facts and never continues to verify or route`, async () => {
    const f = fixture(mode);
    try {
      await expect(f.run()).rejects.toMatchObject({ code: error });
      expect(f.chats()).toBe(calls);
      expect(f.service.read({ runId: f.input.runId })?.decision).toBeNull();
      expect(f.db.query('SELECT id FROM model_calls WHERE run_id=?').all(f.input.runId)).toHaveLength(calls);
    } finally { f.close(); }
  });
}

test('p14 classify and verify share the root model-call ceiling', async () => {
  const f = fixture('verify', 1);
  try {
    await expect(f.run()).rejects.toMatchObject({ code: 'agent_call_limit' });
    expect(f.chats()).toBe(1);
    expect(f.control.readBudget().modelCalls.used).toBe(1);
    expect(f.service.read({ runId: f.input.runId })?.calls).toHaveLength(1);
    expect(f.service.read({ runId: f.input.runId })?.decision).toBeNull();
  } finally { f.close(); }
});

for (const [mode, status, route] of [['ambiguous', 'AMBIGUOUS', 'clarify'], ['missing', 'NEED_PARAMETERS', 'clarify'],
  ['unsupported', 'UNSUPPORTED_DATA', 'clarify'], ['ood', 'OUT_OF_SCOPE', 'reject'], ['multi', 'RESOLVED', 'agent']] as const) {
  test(`p14 ${mode} commits the actual ${status}/${route} decision without partial Query execution`, async () => {
    const f = fixture(mode);
    try {
      const result = await f.run();
      expect(result.decision).toMatchObject({ status, route, intentCallId: result.callIds[0], matchedBy: 'qwen_prompt' });
      expect(f.chats()).toBe(1);
      expect(f.service.read({ runId: f.input.runId })?.calls[0]?.prediction?.status).toBe(status);
      expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(f.input.runId)).toEqual([]);
      if (mode === 'multi') {
        expect(result.decision.adoptedIntents.map(item => item.slots.status)).toEqual(['active', 'delisted']);
        expect(result.decision.contextIntentId).toBeNull();
      }
    } finally { f.close(); }
  });
}

test('p14 verify cannot expand candidate filters or obtain a third call', async () => {
  const f = fixture('verify_expand');
  try {
    await expect(f.run()).rejects.toMatchObject({ code: 'intent_output_invalid' });
    expect(f.chats()).toBe(2);
    expect(f.service.read({ runId: f.input.runId })?.calls[1]).toMatchObject({ stage: 'verify', validation: { state: 'invalid', reviewRequired: false } });
    expect(f.service.read({ runId: f.input.runId })?.decision).toBeNull();
  } finally { f.close(); }
});

test('p14 unresolved verify returns a saved clarification after exactly two calls', async () => {
  const f = fixture('verify_unresolved');
  try {
    const result = await f.run();
    expect(result.decision).toMatchObject({ status: 'AMBIGUOUS', route: 'clarify', matchedBy: 'paper_enhanced' });
    expect(f.chats()).toBe(2);
    expect(f.service.read({ runId: f.input.runId })?.calls[1]).toMatchObject({ validation: { state: 'valid', reviewRequired: false } });
  } finally { f.close(); }
});

test('p14 source=intent cannot execute without its saved resolved simple route or change its adopted parameters', async () => {
  const f = fixture('rule');
  try {
    f.db.query("UPDATE runs SET status='running' WHERE id=?").run(f.input.runId);
    const params = QueryParamsSchema.parse({ kind: 'current', population: 'snapshot', snapshotMode: 'exact_date', batchIds: [1],
      time: { start: '2026-10-04', endExclusive: '2026-10-05' }, region: '浙江' });
    expect(await f.queries.execute(params, f.queryContext(99))).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(f.input.runId)).toEqual([]);
    const route = await f.run(), context = f.queryContext(route.decisionId);
    const changed = { ...route.decision.queryParams!, status: 'delisted' as const };
    expect(await f.queries.execute(changed, context)).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(await f.queries.execute(route.decision.queryParams!, { ...context, callRef: context.callRef.replace(':s1', ':s2') })).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    const result = await f.queries.execute(route.decision.queryParams!, context);
    if (!result.ok) throw result.error;
    expect(result.data).toMatchObject({ runId: f.input.runId, inputId: f.input.inputId, source: 'intent', callRef: context.callRef });
    expect(result.data.rows).toHaveLength(3);
    const replay = await f.queries.execute(route.decision.queryParams!, context);
    expect(replay).toEqual(result);
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(f.input.runId)).toHaveLength(1);
    expect(f.db.query("SELECT actor FROM business_events WHERE run_id=? AND type='query_committed'").get(f.input.runId)).toEqual({ actor: 'system' });
    expect(f.db.query("SELECT source,tool_call_id FROM runtime_events WHERE run_id=? AND type='query_completed'").get(f.input.runId)).toEqual({ source: 'application', tool_call_id: null });
    f.db.query('UPDATE runs SET cancel_requested_at=? WHERE id=?').run(new Date().toISOString(), f.input.runId);
    expect(await f.queries.execute(route.decision.queryParams!, { ...context, checkActive: undefined })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  } finally { f.close(); }
});

test('p14 query commit rechecks DB cancellation within B4 and rolls back its result and events', async () => {
  const f = fixture('rule');
  try {
    const route = await f.run();
    f.db.query(`CREATE TRIGGER engineering_cancel_query AFTER INSERT ON queries WHEN NEW.run_id=${f.input.runId}
      BEGIN UPDATE runs SET cancel_requested_at='2026-10-10T00:00:00.000Z' WHERE id=NEW.run_id; END`).run();
    const result = await f.queries.execute(route.decision.queryParams!, { ...f.queryContext(route.decisionId), checkActive: undefined });
    expect(result).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(f.input.runId)).toEqual([]);
    expect(f.db.query("SELECT id FROM business_events WHERE run_id=? AND type='query_committed'").all(f.input.runId)).toEqual([]);
    expect(f.db.query("SELECT id FROM runtime_events WHERE run_id=? AND type='query_completed'").all(f.input.runId)).toEqual([]);
  } finally { f.close(); }
});

test('p14 the zero-model path executes its authorized query while the original root is created', async () => {
  const f = fixture('rule');
  try {
    const route = await f.run();
    expect(f.db.query('SELECT status FROM runs WHERE id=?').get(f.input.runId)).toEqual({ status: 'created' });
    expect(await f.queries.execute(route.decision.queryParams!, f.queryContext(route.decisionId))).toMatchObject({ ok: true, data: { source: 'intent' } });
    expect(f.chats()).toBe(0);
    expect(f.db.query('SELECT id FROM model_calls WHERE run_id=?').all(f.input.runId)).toEqual([]);
  } finally { f.close(); }
});

for (const mode of ['b2_failure', 'delivery_failure'] as const) test(`p14 ${mode} retry saves the acquired facts only and cannot infer or route again`, async () => {
  const f = fixture(mode);
  try {
    await expect(f.run()).rejects.toMatchObject({ code: 'storage_write_failed' });
    expect(f.service.hasPendingSave(f.input.runId)).toBe(true);
    expect(f.service.read({ runId: f.input.runId })?.calls[0]?.state).toBe('started');
    f.releaseSave();
    f.service.flush(f.input.runId);
    f.service.flush(f.input.runId);
    expect(f.service.hasPendingSave(f.input.runId)).toBe(false);
    expect(f.chats()).toBe(1);
    expect(f.service.read({ runId: f.input.runId })?.calls[0]?.state).toBe(mode === 'b2_failure' ? 'completed' : 'failed');
    expect(f.service.read({ runId: f.input.runId })?.decision).toBeNull();
    expect(f.db.query('SELECT id FROM context_deliveries WHERE run_id=?').all(f.input.runId)).toHaveLength(1);
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(f.input.runId)).toEqual([]);
  } finally { f.close(); }
});

test('p14 root deadline bounds model preflight without admitting an inference request', async () => {
  const f = fixture('slow_preflight', 5, 50);
  try {
    await expect(f.run()).rejects.toMatchObject({ code: 'run_timeout' });
    expect(f.chats()).toBe(0);
    expect(f.control.readBudget().modelCalls.used).toBe(0);
    expect(f.service.read({ runId: f.input.runId })?.calls).toEqual([]);
    expect(f.service.read({ runId: f.input.runId })?.decision).toBeNull();
  } finally { f.close(); }
});

for (const [mode, calls] of [['b1_failure', 0], ['b3_failure', 1]] as const) test(`p14 ${mode} prevents dependent network/query actions`, async () => {
  const f = fixture(mode);
  try {
    await expect(f.run()).rejects.toMatchObject({ code: 'storage_write_failed' });
    expect(f.chats()).toBe(calls);
    expect(f.control.readBudget().modelCalls.used).toBe(calls);
    expect(f.service.hasPendingSave(f.input.runId)).toBe(false);
    expect(f.service.read({ runId: f.input.runId })?.decision).toBeNull();
    expect(f.db.query('SELECT id FROM model_calls WHERE run_id=?').all(f.input.runId)).toHaveLength(calls);
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(f.input.runId)).toEqual([]);
  } finally { f.close(); }
});

test('p14 cancellation before a B2 save retry retains the acquired output as nonexecutable late facts', async () => {
  const f = fixture('b2_failure');
  try {
    await expect(f.run()).rejects.toMatchObject({ code: 'storage_write_failed' });
    f.releaseSave();
    f.db.query('UPDATE runs SET cancel_requested_at=? WHERE id=?').run(new Date().toISOString(), f.input.runId);
    f.service.flush(f.input.runId);
    expect(f.chats()).toBe(1);
    expect(f.service.read({ runId: f.input.runId })?.calls[0]).toMatchObject({ state: 'cancelled',
      rawOutput: { text: JSON.stringify(resolvedIntent()) }, validation: { state: 'not_run', finalStatus: null, reviewRequired: false } });
    expect(f.service.read({ runId: f.input.runId })?.decision).toBeNull();
  } finally { f.close(); }
});
