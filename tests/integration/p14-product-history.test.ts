import { readIntentStageMessage } from '../fixtures/p14-intent';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { openDatabase } from '../../packages/storage/src/database';
import { SqliteMemoryStore } from '../../packages/storage/src/memory-store';
import { SqliteWriteTransactions } from '../../packages/storage/src/write-transactions';
import { PiMemoryAdapter, restoreNativeManager, validateNativeHistory } from '../../packages/runtime-pi/src/memory-store';
import { appendProductTurn } from '../../packages/runtime-pi/src/product-turn-adapter';
import { ProductTurnInputSchema, type ProductTurnInput } from '../../packages/contracts/src/intent';
import type { NativeHistorySnapshot } from '../../packages/contracts/src/session';
import { acceptContextInput, contextAt } from '../fixtures/p8-context';
import { productIntent } from '../fixtures/p14-intent';
import { memoryAssistant } from '../fixtures/p9-memory';
import { providerFixture } from '../fixtures/p1-provider';
import { p12Loader, p12Model, p12Runtime, p12Settings } from '../fixtures/p12-extensions';
import { agentRuntimeFixture } from '../fixtures/agent-runtime';
import { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteEventStore } from '../../packages/storage/src/event-store';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { SqliteCatalogStore } from '../../packages/storage/src/catalog-store';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { QueryService } from '../../packages/core/src/data/query-service';
import { IntentValidator } from '../../packages/core/src/intent/validate';
import { evaluateIntentRules } from '../../packages/core/src/intent/rules';
import { decideIntentRoute } from '../../packages/core/src/intent/route-policy';
import { intentInput } from '../fixtures/p14-intent';
import { IntentInputProjectionSchema } from '../../packages/contracts/src/intent';
import { RunCleanupRecordSchema, type FinalAgentFact } from '../../packages/contracts/src/run';
import { IntentService } from '../../packages/core/src/intent/intent-service';
import { ContextService } from '../../packages/core/src/context/context-service';
import { SqliteContextStore } from '../../packages/storage/src/context-store';
import { OllamaIntentClient } from '../../packages/intent-ollama/src/index';
import { CLASSIFY_PROMPT } from '../../packages/core/src/intent/prompts/classify';
import { VERIFY_PROMPT } from '../../packages/core/src/intent/prompts/verify';
import { RunControl } from '../../packages/core/src/runtime/run-control';
import { disabledIntentModel, resolvedIntent } from '../fixtures/p14-intent';
import { FrozenIntentAdmissionSchema, IntentModelSelectionSchema, INTENT_VERSIONS, type IntentStageInput } from '../../packages/contracts/src/intent';

async function fixture(withQuery = false, text?: string, sharedBatchHash = false) {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p14-product-')), db = openDatabase(join(root, 'app.sqlite'));
  const manager = SessionManager.inMemory(root), header = manager.getHeader()!;
  const store = new SqliteMemoryStore(db, validateNativeHistory), transactions = SqliteWriteTransactions.forDatabase(db);
  let fault = false;
  const repos = new Repositories(db, () => { if (fault) throw new Error('ENGINEERING_FINAL_FAULT'); }, undefined, transactions, store);
  repos.createSession({ expectedWorkspaceRevision: 0 }, 'create-product', manager.getSessionId(), contextAt, { header, entries: [], activeLeafId: null });
  if (withQuery) seedWorkspaceQueries(db, repos);
  if (sharedBatchHash) {
    db.query(`INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,
      expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at,cohort_json)
      SELECT 2,import_id,'ENGINEERING-second-scope',snapshot_date,'上海',material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,
      0,0,'[]',json_set(metadata_json,'$.expectedEntityCount',0,'$.observedEntityCount',0),1,NULL,1,created_at,'[]' FROM batches WHERE id=1`).run();
    repos.updateWorkspace({ batchIds: [1, 2] }, repos.readWorkspace().revision, contextAt);
  }
  const accepted = acceptContextInput(db, { consume: false, repositories: repos, history: true,
    text: text ?? (withQuery ? '查询2026-10-04在浙江的全部医疗器械。' : 'ENGINEERING_ORIGINAL_REQUEST'), toolNames: ['query_current_devices'] });
  const loaded = await store.load(accepted.input.sessionId); if (!loaded.ok) throw loaded.error;
  const commits: unknown[] = [], failures: unknown[] = []; let ownerRunId = accepted.input.runId;
  const memory = new PiMemoryAdapter(manager, { snapshot: loaded.data, getRunId: () => ownerRunId,
    commitSync: change => { commits.push(structuredClone(change)); return transactions.immediate(() => store.commitInTransaction(change)); },
    onFailure: error => failures.push(error) });
  const execution = { contract: 'medclaw.intent-execution/v1', decisionId: 1, taskIntents: [productIntent()], stepResults: [] };
  const input = ProductTurnInputSchema.parse({ runId: accepted.input.runId, sessionId: accepted.input.sessionId,
    inputId: accepted.input.inputId, baseLeafId: null, baseStorageVersion: 1, occurredAt: contextAt, mode: 'program',
    text: accepted.request.text, decisionId: 1, result: { kind: 'clarification', text: 'ENGINEERING_PROGRAM_CLARIFICATION', queryIds: [], missingSlots: ['region'] },
    execution, adoptedContext: null });
  if(input.mode!=='program')throw new Error('Expected the engineering program fixture');
  const discard = (snapshot: NativeHistorySnapshot = loaded.data) => ({ runId: input.runId, sessionId: input.sessionId,
    requestSettled: true as const, routeSettled: true as const, requiredFactsSaved: true as const, committedSnapshot: snapshot });
  return { root, db, manager, memory, store, transactions, input, commits, failures, discard, repos, accepted, fault(value: boolean) { fault = value; }, owner(value: number) { ownerRunId = value; },
    async snapshot() { const value = await store.load(input.sessionId); if (!value.ok) throw value.error; return value.data; },
    dispose() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function queryFinalFixture(mode: 'rule' | 'classify' | 'verify' = 'rule', sharedBatchHash = false) {
  const f = await fixture(true, mode === 'rule' ? undefined : '列出浙江2026-10-04的器械清单', sharedBatchHash), catalog = new CatalogService(new SqliteCatalogStore(f.db)), queryStore = new SqliteToolStore(f.db);
  const projection = IntentInputProjectionSchema.parse({ ...intentInput(), runId: f.input.runId, sessionId: f.input.sessionId, inputId: f.input.inputId,
    text: f.accepted.request.text, baseLeafId: null, baseStorageVersion: 1, referenceDate: f.accepted.request.referenceDate,
    scope: f.accepted.input.scope, scopeBatchHashes: ['a'.repeat(64)], availableData: { regions: sharedBatchHash ? ['上海', '浙江'] : ['浙江'], dates: ['2026-10-04'], currencies: ['CNY'], units: ['台'] },
    enabledL2: ['PRODUCT_SEARCH'], availableToolNames: ['query_current_devices'] });
  const events = new SqliteEventStore(f.db);
  const context = { runId: f.input.runId, sessionId: f.input.sessionId, inputId: f.input.inputId, source: 'intent' as const, callRef: 'ENGINEERING-preflight',
    scope: projection.scope, signal: new AbortController().signal, referenceDate: projection.referenceDate, timezone: projection.timezone };
  let adopted: Awaited<ReturnType<IntentService['recognize']>>, chats = 0;
  if (mode === 'rule') {
    const rule = evaluateIntentRules(projection, contextAt); if (!rule.result) throw new Error('Expected complete fixture rule');
    f.transactions.immediate(() => events.appendInTransaction({ type: 'intent_rule_evaluated', runId: f.input.runId, sessionId: f.input.sessionId,
      source: 'application', sourceConnection: `intent-rule:${f.input.runId}`, sourceSequence: 1, toolCallId: null, occurredAt: contextAt, receivedAt: contextAt,
      payload: { contract: 'medclaw.event/v1', runId: f.input.runId, inputId: f.input.inputId, ruleEvaluation: rule.evaluation } }));
    const validation = new IntentValidator(catalog).validateQueryParams(rule.result, context, projection, contextAt);
    const decision = decideIntentRoute(rule.result, validation, projection, { rule: rule.evaluation });
    const saved = f.repos.commitRoute({ runId: f.input.runId, sessionId: f.input.sessionId, inputId: f.input.inputId, expectedCancelEpoch: 0, createdAt: contextAt, decision });
    adopted = { ...saved, decision, callIds: [], ruleEvaluation: rule.evaluation };
  } else {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/api/version') return Response.json({ version: 'ENGINEERING' });
      if (path === '/api/tags') return Response.json({ models: [{ name: 'qwen3.5:0.8b', digest: 'a'.repeat(64) }] });
      if (path === '/api/show') return Response.json({ details: { family: 'qwen35', parameter_size: '752.39M', quantization_level: 'Q8_0' } });
      if (path !== '/api/chat') return new Response('Unexpected engineering endpoint', { status: 404 });
      chats++;
      const body = await request.json() as { messages: { content: string }[] }, stage = readIntentStageMessage(body.messages[1]!.content) as IntentStageInput;
      const result = { ...resolvedIntent(), intents: stage.stage === 'verify' ? stage.review!.candidates[0]!.intents : [{ ...productIntent(),
        ...(mode === 'verify' ? { l0: 'DATA_OPERATIONS' } : {}), slots: { ...productIntent().slots, region: '浙江', time: { start: '2026-10-04', endExclusive: '2026-10-05' } } }] };
      return Response.json({ model: 'qwen3.5:0.8b', done: true, done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) }, prompt_eval_count: 44, eval_count: 35 });
    } });
    const control = new RunControl({ runId: projection.runId, scope: projection.scope, signal: context.signal, deadlineAt: performance.now() + 15000 });
    try {
      const service = new IntentService(f.repos, new ContextService(new SqliteContextStore(f.db), { async inspectManagedImport() { throw new Error('Unexpected artifact'); } }),
        new OllamaIntentClient({ classify: CLASSIFY_PROMPT, verify: VERIFY_PROMPT }), new IntentValidator(catalog), events, f.transactions);
      const selection = IntentModelSelectionSchema.parse({ ...disabledIntentModel(), enabled: true, baseUrl: `http://127.0.0.1:${server.port}`,
        modelDigest: 'sha256:' + 'a'.repeat(64), verifiedEvidenceRef: 'ENGINEERING', configVersion: '1', api: 'ollama-chat', ...INTENT_VERSIONS });
      adopted = await service.recognize(projection, selection, { signal: context.signal, control, workspaceContext: f.accepted.input.workspaceContext,
        expectedCancelEpoch: 0, checkActive() { if (f.db.query<{ cancel_requested_at: string | null }, [number]>('SELECT cancel_requested_at FROM runs WHERE id=?').get(projection.runId)!.cancel_requested_at !== null) throw new Error('tool_cancelled'); } });
    } finally { control.dispose(); server.stop(true); }
  }
  const { decision, decisionId } = adopted;
  const step = decision.adoptedIntents[0]!;
  const result = await new QueryService(catalog, queryStore).execute(decision.queryParams!, { ...context, callRef: `intent:${f.input.runId}:${decisionId}:${step.id}` });
  if (!result.ok) throw result.error;
  const query = result.data;
  const input = ProductTurnInputSchema.parse({ ...f.input, mode: 'program', text: f.accepted.request.text, decisionId,
    result: { kind: 'result', text: 'Program query result: 3 devices. Currency CNY; unit 台.', queryIds: [query.id], missingSlots: [] },
    execution: { contract: 'medclaw.intent-execution/v1', decisionId, taskIntents: decision.adoptedIntents,
      stepResults: [{ stepId: step.id, queryRefs: [{ queryId: query.id, resultHash: query.resultHash }] }] },
    adoptedContext: { contract: 'medclaw.query-context-entry/v2', sourceRunId: f.input.runId, sourceInputId: f.input.inputId,
      taskIntents: decision.adoptedIntents, contextIntentId: decision.contextIntentId, adoptedSlots: decision.adoptedSlots,
      scopeBatchHashes: projection.scopeBatchHashes, queryIds: [query.id], pendingClarification: null, decisionId } });
  if(input.mode!=='program')throw new Error('Expected the engineering query program fixture');
  const productTurn = appendProductTurn(f.manager, f.memory, input);
  const fact: FinalAgentFact = { status: 'completed', resultSource: 'program', productTurn, history: productTurn.history, calls: [],
    outputText: input.mode === 'program' ? input.result.text : '', error: null, stoppedAt: null, endedAt: mode === 'rule' ? contextAt : new Date().toISOString(), cancelRequestedAt: null,
    productSettlement: { contract: 'medclaw.product-settlement/v1', basis:'product_history',nativeUserEntryId:productTurn.userEntryId, runId: input.runId, sessionId: input.sessionId, inputId: input.inputId,
      admissionClosed: true, requestSettled: true, routeSettled: true, requiredFactsSaved: true, pendingFactsEmpty: true },
    cleanup: RunCleanupRecordSchema.parse({ contract: 'medclaw.run-cleanup/v1', executionStarted: false, stopConfirmed: true,
      requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: true, unconfirmedItems: [], secondaryErrors: [], verifiedAt: contextAt }) };
  return { ...f, fact, query, productInput: input, chats };
}

test('p14 public product append holds real user/custom/execution entries until a confirmed SQLite commit', async () => {
  const f = await fixture();
  try {
    const fact = appendProductTurn(f.manager, f.memory, f.input);
    expect(fact.history.newEntries.map((entry: any) => entry.type)).toEqual(['message', 'custom_message', 'custom']);
    const user = f.manager.getEntry(fact.userEntryId!);
    expect(user).toMatchObject({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: f.input.mode === 'program' ? f.input.text : '' }], timestamp: Date.parse(contextAt) } });
    expect(f.manager.getEntry(fact.resultEntryId!)).toMatchObject({ parentId: fact.userEntryId, type: 'custom_message', display: true,
      customType: 'medclaw-query-result', details: { contract: 'medclaw.product-result/v1', source: 'program', runId: f.input.runId, inputId: f.input.inputId, decisionId: 1, kind: 'clarification' } });
    expect(f.manager.getEntry(fact.executionEntryId)).toMatchObject({ parentId: fact.resultEntryId, type: 'custom', customType: 'medclaw-intent-execution', data: f.input.execution });
    expect(fact.history.activeLeafId).toBe(fact.executionEntryId);
    expect(f.commits).toEqual([]);
    expect((await f.snapshot()).entries).toEqual([]);
    expect(f.db.query('SELECT status,native_entry_id FROM session_inputs').get()).toEqual({ status: 'queued', native_entry_id: null });
    expect(f.db.query('SELECT id FROM answers').all()).toEqual([]);
    expect(() => f.memory.flushBeforeRequest()).toThrow();
    expect(() => f.memory.beginCompaction('another-operation')).toThrow();
    expect(() => f.memory.releaseFinal(f.input.runId)).toThrow();
    expect(() => appendProductTurn(f.manager, f.memory, f.input)).toThrow();
    expect(f.manager.getEntries()).toHaveLength(3);
    expect(() => f.transactions.immediate(() => { f.store.commitInTransaction(fact.history); throw new Error('ENGINEERING_B5_FAULT'); })).toThrow('ENGINEERING_B5_FAULT');
    expect((await f.snapshot()).entries).toEqual([]);
    expect(fact.history).toEqual(f.memory.freezeFinal(f.input.runId));
    const saved = f.transactions.immediate(() => f.store.commitInTransaction(fact.history));
    expect(f.store.confirmCommitted(fact.history)).toEqual(saved);
    f.memory.acknowledgeSaved(fact.history, saved.storageVersion);
    expect(fact.history).toEqual(f.memory.freezeFinal(f.input.runId));
    f.memory.releaseFinal(f.input.runId);
    expect((await f.snapshot()).entries).toEqual(fact.history.newEntries);
    expect(f.failures).toEqual([]);
    f.memory.dispose();
  } finally { f.dispose(); }
});

test('p14 Agent task adds execution and adopted context inside the real final assistant hold without a second user', async () => {
  const f = await fixture();
  try {
    const userId = f.manager.appendMessage({ role: 'user', content: 'ENGINEERING SDK INPUT', timestamp: 1 });
    const base = f.memory.readSavedContext(), assistantId = f.manager.appendMessage(memoryAssistant('ENGINEERING SDK ANSWER'));
    const input = ProductTurnInputSchema.parse({ runId: f.input.runId, sessionId: f.input.sessionId, inputId: f.input.inputId,
      baseLeafId: base.leafId, baseStorageVersion: base.storageVersion, occurredAt: contextAt, mode: 'agent_task', execution: f.input.execution,
      adoptedContext: { contract: 'medclaw.query-context-entry/v2', sourceInputId: f.input.inputId, sourceRunId: f.input.runId,
        taskIntents: f.input.execution.taskIntents, contextIntentId: 's1', adoptedSlots: productIntent().slots,
        scopeBatchHashes: [], queryIds: [], pendingClarification: null, decisionId: 1 } });
    const fact = appendProductTurn(f.manager, f.memory, input);
    expect(fact.userEntryId).toBeNull(); expect(fact.resultEntryId).toBeNull();
    expect(fact.history.newEntries.map((entry: any) => entry.type)).toEqual(['message', 'custom', 'custom']);
    expect(fact.history.newEntries[0]).toMatchObject({ id: assistantId, parentId: userId, message: { role: 'assistant' } });
    expect(f.manager.getEntry(fact.conditionEntryId!)).toMatchObject({ parentId: fact.executionEntryId, customType: 'medclaw-query-context', data: input.adoptedContext });
    expect((await f.snapshot()).entries).toHaveLength(1);
    expect(f.manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(1);
    const snapshot = await f.snapshot();
    expect(() => f.memory.discardProductTurn(f.discard(snapshot))).toThrow();
    const saved = f.transactions.immediate(() => f.store.commitInTransaction(fact.history));
    f.memory.acknowledgeSaved(fact.history, saved.storageVersion);
    f.memory.releaseFinal(f.input.runId); f.memory.dispose();
  } finally { f.dispose(); }
});

test('p14 product input rejects malformed identities and condition/execution/result mismatches before native mutation', async () => {
  const f = await fixture();
  try {
    const cases: unknown[] = [
      { ...f.input, hidden: true }, { ...f.input, occurredAt: 'yesterday' }, { ...f.input, decisionId: 2 },
      { ...f.input, result: { kind: 'result', text: 'ENGINEERING', queryIds: [10], missingSlots: [] } },
      { ...f.input, adoptedContext: { contract: 'medclaw.query-context-entry/v2', sourceInputId: f.input.inputId + 1, sourceRunId: f.input.runId,
        taskIntents: f.input.execution.taskIntents, contextIntentId: 's1', adoptedSlots: productIntent().slots,
        scopeBatchHashes: [], queryIds: [], pendingClarification: null, decisionId: 1 } },
    ];
    for (const input of cases) expect(() => appendProductTurn(f.manager, f.memory, input as ProductTurnInput)).toThrow();
    expect(() => appendProductTurn(f.manager, f.memory, { ...f.input, baseStorageVersion: 2 })).toThrow();
    expect(() => appendProductTurn(f.manager, f.memory, { ...f.input, runId: f.input.runId + 1 })).toThrow();
    expect(() => appendProductTurn(f.manager, f.memory, { ...f.input, sessionId: f.input.sessionId + 1 })).toThrow();
    expect(f.manager.getEntries()).toEqual([]); expect(f.commits).toEqual([]);
    f.memory.dispose();
  } finally { f.dispose(); }
});

test('p14 program cancellation discards only uncommitted product entries after exact settled proof', async () => {
  const f = await fixture();
  try {
    const snapshot = await f.snapshot(), fact = appendProductTurn(f.manager, f.memory, f.input);
    for (const key of ['requestSettled', 'routeSettled', 'requiredFactsSaved'] as const) {
      expect(() => f.memory.discardProductTurn({ ...f.discard(), [key]: false } as any)).toThrow();
    }
    expect(() => f.memory.discardProductTurn({ ...f.discard(), runId: f.input.runId + 1 })).toThrow();
    expect(() => f.memory.discardProductTurn(f.discard({ ...snapshot, storageVersion: 2 }))).toThrow();
    expect(fact.history).toEqual(f.memory.freezeFinal(f.input.runId));
    f.memory.discardProductTurn(f.discard());
    const restored = restoreNativeManager(snapshot, f.root);
    expect(restored.getEntries()).toEqual([]); expect(restored.getLeafId()).toBeNull();
    expect((await f.snapshot()).entries).toEqual([]);
    expect(f.db.query('SELECT status,native_entry_id FROM session_inputs').get()).toEqual({ status: 'queued', native_entry_id: null });
  } finally { f.dispose(); }
});

test('p14 committed product facts cannot be discarded by a stale precommit snapshot', async () => {
  const f = await fixture();
  try {
    const fact = appendProductTurn(f.manager, f.memory, f.input), saved = f.transactions.immediate(() => f.store.commitInTransaction(fact.history));
    f.memory.acknowledgeSaved(fact.history, saved.storageVersion);
    expect(() => f.memory.discardProductTurn(f.discard())).toThrow();
    const snapshot = await f.snapshot();
    expect(() => f.memory.discardProductTurn(f.discard(snapshot))).toThrow();
    f.memory.releaseFinal(f.input.runId); f.memory.dispose();
  } finally { f.dispose(); }
});

test('p14 a partial public append failure retains the product hold and permits only proven discard', async () => {
  const f = await fixture(), original = f.manager.appendCustomMessageEntry;
  try {
    f.manager.appendCustomMessageEntry = () => { throw new Error('ENGINEERING_NATIVE_APPEND_FAULT'); };
    expect(() => appendProductTurn(f.manager, f.memory, f.input)).toThrow('ENGINEERING_NATIVE_APPEND_FAULT');
    f.manager.appendCustomMessageEntry = original;
    expect(f.manager.getEntries()).toHaveLength(1); expect((await f.snapshot()).entries).toEqual([]);
    expect(() => f.memory.flushBeforeRequest()).toThrow(); expect(() => f.memory.dispose()).toThrow();
    expect(() => appendProductTurn(f.manager, f.memory, f.input)).toThrow();
    expect(f.manager.getEntries()).toHaveLength(1);
    f.memory.discardProductTurn(f.discard());
    expect((await f.snapshot()).entries).toEqual([]); expect(f.commits).toEqual([]);
  } finally { f.manager.appendCustomMessageEntry = original; f.dispose(); }
});

test('p14 confirmed product history reaches a real next provider payload through public SDK reassembly', async () => {
  const f = await fixture(), receiver = providerFixture(); let session: AgentSession | undefined;
  try {
    const fact = appendProductTurn(f.manager, f.memory, f.input), saved = f.transactions.immediate(() => f.store.commitInTransaction(fact.history));
    f.memory.acknowledgeSaved(fact.history, saved.storageVersion);
    f.memory.releaseFinal(f.input.runId); f.memory.dispose();
    const restored = restoreNativeManager(await f.snapshot(), f.root), loader = p12Loader(f.root); await loader.reload();
    ({ session } = await createAgentSession({ cwd: f.root, agentDir: join(f.root, 'agent'), modelRuntime: await p12Runtime(),
      model: { ...p12Model, baseUrl: receiver.url }, settingsManager: p12Settings(), resourceLoader: loader,
      sessionManager: restored, tools: [], customTools: [], thinkingLevel: 'off' }));
    await session.bindExtensions({ onError: event => { throw new Error(event.error); } });
    await session.prompt('ENGINEERING_FOLLOWUP_REQUEST', { expandPromptTemplates: false }); await session.waitForIdle();
    expect(receiver.requests).toHaveLength(1);
    const payload = JSON.stringify(receiver.requests[0]!.body);
    for (const text of ['ENGINEERING_ORIGINAL_REQUEST', 'ENGINEERING_PROGRAM_CLARIFICATION', 'ENGINEERING_FOLLOWUP_REQUEST']) expect(payload.split(text)).toHaveLength(2);
    expect(payload).not.toContain('medclaw.product-result/v1'); expect(payload).not.toContain('medclaw.intent-execution/v1');
  } finally { if (session) { await session.abort(); await session.waitForIdle(); session.dispose(); } receiver.close(); f.dispose(); }
}, 30000);

test('p14 PiAgentRuntime exposes the held product fact under its actual Run owner without starting a provider', async () => {
  const f = await agentRuntimeFixture();
  try {
    const accepted = acceptContextInput(f.db, { consume: false, repositories: f.repos, text: 'ENGINEERING Runtime product input' });
    const input = ProductTurnInputSchema.parse({ runId: accepted.input.runId, sessionId: accepted.input.sessionId, inputId: accepted.input.inputId,
      baseLeafId: null, baseStorageVersion: 1, occurredAt: contextAt, mode: 'program', text: accepted.request.text, decisionId: 1,
      result: { kind: 'out_of_scope', text: 'ENGINEERING Supported scope', queryIds: [], missingSlots: [] },
      execution: { contract: 'medclaw.intent-execution/v1', decisionId: 1, taskIntents: [], stepResults: [] }, adoptedContext: null });
    const fact = await f.agent.appendProductTurn(input);
    expect(f.agent.readFinalHistory(input.runId)).toEqual(fact.history);
    expect(await f.agent.appendProductTurn(structuredClone(input))).toEqual(fact);
    await expect(f.agent.appendProductTurn({ ...input, occurredAt: '2026-10-06T00:00:00.000Z' })).rejects.toMatchObject({ code: 'state_conflict' });
    const readAgain = await f.agent.appendProductTurn(input); readAgain.history.newEntries.length = 0;
    expect((await f.agent.appendProductTurn(input)).history.newEntries).toHaveLength(3);
    expect(f.requests).toEqual([]); expect(f.db.query('SELECT id FROM memories').all()).toEqual([]);
    const saved = f.history.commitSync(fact.history);
    f.agent.acknowledgeHistorySaved(fact.history, saved.storageVersion); f.agent.releaseHistoryFacts(input.runId);
    expect(f.agent.readAvailability(input.sessionId).availability).toBe('ready');
    await expect(f.agent.appendProductTurn(input)).rejects.toBeDefined();
    expect(f.requests).toEqual([]);
  } finally { await f.close(); }
});

test('p14 a cold PiAgentRuntime loads only native history for program results and checks the real committed snapshot before discard', async () => {
  const f = await agentRuntimeFixture();
  try {
    const agent = new PiAgentRuntime(f.runtime, f.root, f.history);
    const accepted = acceptContextInput(f.db, { consume: false, repositories: f.repos });
    const input = ProductTurnInputSchema.parse({ runId: accepted.input.runId, sessionId: accepted.input.sessionId, inputId: accepted.input.inputId,
      baseLeafId: null, baseStorageVersion: 1, occurredAt: contextAt, mode: 'program', text: accepted.request.text, decisionId: 1,
      result: { kind: 'out_of_scope', text: 'ENGINEERING Supported scope', queryIds: [], missingSlots: [] },
      execution: { contract: 'medclaw.intent-execution/v1', decisionId: 1, taskIntents: [], stepResults: [] }, adoptedContext: null });
    const loaded = await f.history.store.load(input.sessionId); if (!loaded.ok) throw loaded.error;
    const proof = { runId: input.runId, sessionId: input.sessionId, requestSettled: true as const, routeSettled: true as const,
      requiredFactsSaved: true as const, committedSnapshot: loaded.data };
    await agent.appendProductTurn(input); await agent.discardProductTurn(proof);
    expect(agent.readAvailability(input.sessionId).availability).toBe('ready');
    expect(() => agent.readFinalHistory(input.runId)).toThrow();
    const fact = await agent.appendProductTurn(input);
    const saved = f.history.commitSync(fact.history);
    await expect(agent.discardProductTurn(proof)).rejects.toMatchObject({ code: 'storage_write_failed' });
    agent.acknowledgeHistorySaved(fact.history, saved.storageVersion); agent.releaseHistoryFacts(input.runId);
    expect(f.requests).toEqual([]);
  } finally { await f.close(); }
});

test('p14 program B5 commits actual Query references, user/custom history, input, adopted context, Answer and Run atomically without a model', async () => {
  const f = await queryFinalFixture();
  try {
    const run = f.repos.finalizeAgent(f.input.runId, f.fact);
    expect(run.status).toBe('completed'); expect(run.calls).toEqual([]); expect(run.answerRef).not.toBeNull();
    expect(f.repos.isFinalSaved(f.input.runId, f.fact)).toBe(true);
    expect(f.db.query('SELECT kind,text,query_ids_json,missing_slots_json,native_leaf_id FROM answers WHERE run_id=?').get(f.input.runId)).toEqual({
      kind: 'result', text: f.fact.outputText, query_ids_json: JSON.stringify([f.query.id]), missing_slots_json: '[]', native_leaf_id: f.fact.history!.activeLeafId });
    expect(f.db.query('SELECT status,processing_status,native_entry_id,delivered_at FROM session_inputs WHERE id=?').get(f.input.inputId)).toEqual({
      status: 'consumed', processing_status: 'completed', native_entry_id: f.fact.productTurn!.userEntryId, delivered_at: contextAt });
    expect(f.db.query('SELECT source_run_id,source_input_id,native_leaf_id,version FROM query_contexts').get()).toEqual({
      source_run_id: f.input.runId, source_input_id: f.input.inputId, native_leaf_id: f.fact.history!.activeLeafId, version: 1 });
    const delivered = f.db.query<{ source: string; payload_json: string }, [number]>("SELECT source,payload_json FROM runtime_events WHERE run_id=? AND type='input_delivered'").all(f.input.runId);
    expect(delivered).toHaveLength(1); expect(delivered[0]!.source).toBe('application'); expect(JSON.parse(delivered[0]!.payload_json).phase).toBe('product_history_saved');
    const activity = f.db.query<{ actor: string; details_json: string }, [number]>("SELECT actor,details_json FROM business_events WHERE run_id=? AND type='answer_committed'").get(f.input.runId)!;
    expect(activity.actor).toBe('system'); expect(JSON.parse(activity.details_json)).toMatchObject({ resultSource: 'program', queryIds: [f.query.id] });
    const count = f.db.query<{ n: number }, []>('SELECT count(*) n FROM runtime_events').get()!.n;
    expect(f.repos.finalizeAgent(f.input.runId, f.fact).answerRef).toBe(run.answerRef);
    expect(f.db.query<{ n: number }, []>('SELECT count(*) n FROM runtime_events').get()!.n).toBe(count);
    f.memory.acknowledgeSaved(f.fact.history!, 2); f.memory.releaseFinal(f.input.runId); f.memory.dispose();
  } finally { f.dispose(); }
});

for(const nativeUserEntryId of [null,'foreign-native-user'])test(`p14 program B5 rejects settlement user ${nativeUserEntryId} without consuming input or saving history`,async()=>{
  const f=await queryFinalFixture();
  try {
    const fact=structuredClone(f.fact);if(fact.resultSource!=='program')throw new Error('Missing program fixture');
    fact.productSettlement.nativeUserEntryId=nativeUserEntryId;
    expect(()=>f.repos.finalizeAgent(f.input.runId,fact)).toThrow('session_history_invalid');
    expect(f.repos.isFinalSaved(f.input.runId,fact)).toBe(false);
    expect((await f.snapshot()).entries).toHaveLength(0);
    expect(f.db.query('SELECT id FROM answers').all()).toHaveLength(0);
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(f.input.runId)).toHaveLength(1);
    expect(f.db.query('SELECT status FROM session_inputs WHERE id=?').get(f.input.inputId)).toEqual({status:'queued'});
  }finally{f.dispose();}
});

test('p14 intent read exposes only committed verified native step results and the actual effective condition', async () => {
  const f=await queryFinalFixture();
  try{
    expect(f.repos.readIntent({runId:f.input.runId})?.execution).toMatchObject({stepResults:[],finalHistorySaved:false,answerId:null});
    f.repos.finalizeAgent(f.input.runId,f.fact);
    const read=f.repos.readIntent({runId:f.input.runId});
    expect(read?.execution).toEqual({runStatus:'completed',queryIds:[f.query.id],stepResults:f.productInput.execution.stepResults,
      answerId:1,finalHistorySaved:true,requiredPersistenceComplete:true});
    expect(read?.effectiveContext).toMatchObject({sourceRunId:f.input.runId,sourceInputId:f.input.inputId,
      nativeLeafId:f.fact.productTurn!.conditionEntryId,queryIds:[f.query.id]});
    f.memory.acknowledgeSaved(f.fact.history!,2);f.memory.releaseFinal(f.input.runId);f.memory.dispose();
  }finally{f.dispose();}
});

for(const damage of ['execution_hash','projection_slots','projection_before_condition','projection_schema','projection_missing','answer_text','history_receipt','off_branch'] as const)
test(`p14 intent read refuses damaged committed ${damage} instead of inventing adopted execution`,async()=>{
  const f=await queryFinalFixture();
  try{
    f.repos.finalizeAgent(f.input.runId,f.fact);f.memory.acknowledgeSaved(f.fact.history!,2);f.memory.releaseFinal(f.input.runId);f.memory.dispose();
    if(damage==='execution_hash')f.db.query("UPDATE memories SET entry_json=json_set(entry_json,'$.data.stepResults[0].queryRefs[0].resultHash',?) WHERE native_entry_id=?")
      .run('f'.repeat(64),f.fact.productTurn!.executionEntryId);
    if(damage==='projection_slots')f.db.query("UPDATE query_contexts SET adopted_slots_json=json_set(adopted_slots_json,'$.manufacturer','ENGINEERING forged'),task_intents_json=json_set(task_intents_json,'$[0].slots.manufacturer','ENGINEERING forged')").run();
    if(damage==='projection_before_condition')f.db.query('UPDATE query_contexts SET native_leaf_id=?').run(f.fact.productTurn!.userEntryId);
    if(damage==='projection_schema')f.db.query("UPDATE query_contexts SET schema_version='medclaw.intent/v99'").run();
    if(damage==='projection_missing')f.db.query('DELETE FROM query_contexts').run();
    if(damage==='answer_text')f.db.query("UPDATE answers SET text='ENGINEERING forged'").run();
    if(damage==='history_receipt')f.db.query("DELETE FROM runtime_events WHERE type='history_saved'").run();
    if(damage==='off_branch')f.db.query('UPDATE sessions SET current_leaf_id=NULL').run();
    expect(()=>f.repos.readIntent({runId:f.input.runId})).toThrow('storage_read_failed');
  }finally{f.dispose();}
});

test('p14 historical execution remains readable after leaving its branch without adopting its condition',async()=>{
  const f=await queryFinalFixture();
  try{
    f.repos.finalizeAgent(f.input.runId,f.fact);f.memory.acknowledgeSaved(f.fact.history!,2);f.memory.releaseFinal(f.input.runId);f.memory.dispose();
    f.db.transaction(()=>{f.db.query('UPDATE sessions SET current_leaf_id=NULL,storage_version=storage_version+1').run();f.db.query('DELETE FROM query_contexts').run();})();
    const read=f.repos.readIntent({runId:f.input.runId});
    expect(read?.execution).toMatchObject({stepResults:f.productInput.execution.stepResults,finalHistorySaved:true});
    expect(read?.effectiveContext).toBeNull();
  }finally{f.dispose();}
});

test('p14 an unstarted intent read still verifies prior reachable conditions when the cache was lost',async()=>{
  const f=await queryFinalFixture();
  try{
    f.repos.finalizeAgent(f.input.runId,f.fact);f.memory.acknowledgeSaved(f.fact.history!,2);f.memory.releaseFinal(f.input.runId);f.memory.dispose();
    const snapshot=f.repos.readHistorySnapshot(f.input.sessionId);
    const intentAdmission=FrozenIntentAdmissionSchema.parse({contract:'medclaw.intent-admission/v1',baseLeafId:snapshot.activeLeafId,baseStorageVersion:snapshot.storageVersion,
      selection:{...disabledIntentModel(),enabled:true,modelDigest:'sha256:'+'a'.repeat(64),verifiedEvidenceRef:'ENGINEERING',configVersion:'1',api:'ollama-chat',...INTENT_VERSIONS},
      prompts:new OllamaIntentClient({classify:CLASSIFY_PROMPT,verify:VERIFY_PROMPT}).prompts});
    const next=acceptContextInput(f.db,{consume:false,repositories:f.repos,history:true,text:'ENGINEERING next intent',intentAdmission});
    f.db.query('DELETE FROM query_contexts').run();
    expect(()=>f.repos.readIntent({runId:next.input.runId})).toThrow('storage_read_failed');
  }finally{f.dispose();}
});

test('p14 B5 failure rolls back every final fact while retaining the previously committed Query and original native IDs', async () => {
  const f = await queryFinalFixture();
  try {
    f.fault(true); expect(() => f.repos.finalizeAgent(f.input.runId, f.fact)).toThrow('ENGINEERING_FINAL_FAULT');
    expect(f.repos.isFinalSaved(f.input.runId, f.fact)).toBe(false);
    expect((await f.snapshot()).entries).toEqual([]); expect(f.db.query('SELECT id FROM answers').all()).toEqual([]);
    expect(f.db.query('SELECT id FROM query_contexts').all()).toEqual([]);
    expect(f.db.query('SELECT status,native_entry_id FROM session_inputs WHERE id=?').get(f.input.inputId)).toEqual({ status: 'queued', native_entry_id: null });
    expect(f.db.query('SELECT status FROM runs WHERE id=?').get(f.input.runId)).toEqual({ status: 'created' });
    expect(f.db.query('SELECT id FROM queries WHERE id=?').get(f.query.id)).toEqual({ id: f.query.id });
    expect(f.fact.history).toEqual(f.memory.freezeFinal(f.input.runId));
    f.fault(false); f.repos.finalizeAgent(f.input.runId, f.fact);
    expect(f.repos.isFinalSaved(f.input.runId, f.fact)).toBe(true);
    f.memory.acknowledgeSaved(f.fact.history!, 2); f.memory.releaseFinal(f.input.runId); f.memory.dispose();
  } finally { f.dispose(); }
});

test('p14 program B5 rejects Stop, false result text, missing decision and false execution Query hashes without writing final facts', async () => {
  const f = await queryFinalFixture();
  try {
    expect(() => f.repos.finalizeAgent(f.input.runId, { ...f.fact, outputText: 'ENGINEERING forged output' })).toThrow();
    const bad = structuredClone(f.fact), execution = bad.history!.newEntries.find((entry: any) => entry.customType === 'medclaw-intent-execution') as any;
    execution.data.stepResults[0].queryRefs[0].resultHash = 'f'.repeat(64); bad.productTurn!.history = bad.history!;
    expect(() => f.repos.finalizeAgent(f.input.runId, bad)).toThrow();
    f.db.query('UPDATE runs SET cancel_requested_at=? WHERE id=?').run(contextAt, f.input.runId);
    expect(() => f.repos.finalizeAgent(f.input.runId, f.fact)).toThrow();
    f.db.query('UPDATE runs SET cancel_requested_at=NULL WHERE id=?').run(f.input.runId);
    f.db.query('DELETE FROM route_decisions WHERE run_id=?').run(f.input.runId);
    expect(() => f.repos.finalizeAgent(f.input.runId, f.fact)).toThrow();
    expect((await f.snapshot()).entries).toEqual([]); expect(f.db.query('SELECT id FROM answers').all()).toEqual([]);
    expect(f.db.query('SELECT id FROM query_contexts').all()).toEqual([]);
  } finally { f.dispose(); }
});

for (const [mode, calls] of [['classify', 1], ['verify', 2]] as const) {
  test(`p14 ${mode} B5 keeps ${calls} actual saved intent calls without inventing Pi final calls or reinferring on save retry`, async () => {
    const f = await queryFinalFixture(mode);
    try {
      expect(f.chats).toBe(calls); f.fault(true); expect(() => f.repos.finalizeAgent(f.input.runId, f.fact)).toThrow('ENGINEERING_FINAL_FAULT');
      expect(f.db.query('SELECT id FROM answers').all()).toEqual([]);
      f.fault(false); const run = f.repos.finalizeAgent(f.input.runId, f.fact);
      expect(run.calls).toHaveLength(calls); expect(run.calls.every(call => call.kind === 'intent' && call.state === 'completed')).toBe(true);
      expect(f.repos.isFinalSaved(f.input.runId, f.fact)).toBe(true);
      expect(f.repos.finalizeAgent(f.input.runId, f.fact).answerRef).toBe(run.answerRef); expect(f.chats).toBe(calls);
      expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(f.input.runId)).toEqual([{ id: f.query.id }]);
      f.memory.acknowledgeSaved(f.fact.history!, 2); f.memory.releaseFinal(f.input.runId); f.memory.dispose();
    } finally { f.dispose(); }
  });
}

test('p14 a committed program turn permits the next actual accepted root on the same adapter and saved branch', async () => {
  const f = await queryFinalFixture();
  try {
    f.repos.finalizeAgent(f.input.runId, f.fact); f.memory.acknowledgeSaved(f.fact.history!, 2); f.memory.releaseFinal(f.input.runId);
    const snapshot = await f.snapshot();
    const accepted = acceptContextInput(f.db, { consume: false, repositories: f.repos, history: true });
    f.owner(accepted.input.runId);
    const input = ProductTurnInputSchema.parse({ ...f.input, runId: accepted.input.runId, inputId: accepted.input.inputId,
      mode: 'program', text: accepted.request.text, baseLeafId: snapshot.activeLeafId, baseStorageVersion: snapshot.storageVersion, decisionId: 2,
      result: { kind: 'out_of_scope', text: 'ENGINEERING next program result', queryIds: [], missingSlots: [] },
      execution: { contract: 'medclaw.intent-execution/v1', decisionId: 2, taskIntents: [], stepResults: [] }, adoptedContext: null });
    const turn = appendProductTurn(f.manager, f.memory, input);
    expect(f.manager.getEntry(turn.userEntryId!)?.parentId).toBe(f.fact.history!.activeLeafId);
    expect(turn.history.newEntries).toHaveLength(3); expect((await f.snapshot()).entries).toHaveLength(4);
    f.memory.discardProductTurn({ runId: input.runId, sessionId: input.sessionId, requestSettled: true, routeSettled: true, requiredFactsSaved: true, committedSnapshot: snapshot });
  } finally { f.dispose(); }
});

for (const [table, operation] of [['query_contexts', 'INSERT'], ['answers', 'INSERT'], ['session_inputs', 'UPDATE']] as const) {
  test(`p14 cancellation observed during B5 ${table} cannot be overwritten by final Run saving`, async () => {
    const f = await queryFinalFixture();
    try {
      f.db.query(`CREATE TRIGGER engineering_cancel_final AFTER ${operation} ON ${table} BEGIN UPDATE runs SET cancel_requested_at='2026-10-05T00:00:00.000Z' WHERE id=${f.input.runId}; END`).run();
      expect(() => f.repos.finalizeAgent(f.input.runId, f.fact)).toThrow();
      expect((await f.snapshot()).entries).toEqual([]); expect(f.db.query('SELECT id FROM answers').all()).toEqual([]);
      expect(f.db.query('SELECT id FROM query_contexts').all()).toEqual([]);
      expect(f.db.query('SELECT status FROM session_inputs WHERE id=?').get(f.input.inputId)).toEqual({ status: 'queued' });
      expect(f.db.query('SELECT status FROM runs WHERE id=?').get(f.input.runId)).toEqual({ status: 'created' });
      expect(f.db.query('SELECT id FROM queries WHERE id=?').get(f.query.id)).toEqual({ id: f.query.id });
    } finally { f.dispose(); }
  });
}

test('p14 a program completion cannot bypass unresolved cleanup with a declared product settlement', async () => {
  for (const missing of ['stopConfirmed', 'requiredPersistenceComplete', 'inputsSettled', 'resourcesReleased', 'unconfirmedItems'] as const) {
    const f = await queryFinalFixture();
    try {
      const fact = structuredClone(f.fact);
      if (missing === 'unconfirmedItems') fact.cleanup.unconfirmedItems = ['context_save']; else fact.cleanup[missing] = false;
      expect(() => f.repos.finalizeAgent(f.input.runId, fact)).toThrow();
      expect((await f.snapshot()).entries).toEqual([]); expect(f.db.query('SELECT id FROM answers').all()).toEqual([]);
      expect(f.db.query('SELECT status FROM session_inputs WHERE id=?').get(f.input.inputId)).toEqual({ status: 'queued' });
    } finally { f.dispose(); }
  }
});

test('p14 program B5 deduplicates shared batch hashes while preserving every frozen batch identity', async () => {
  const f = await queryFinalFixture('rule', true);
  try {
    expect(f.accepted.input.scope.batchIds).toEqual([1, 2]);
    const run = f.repos.finalizeAgent(f.input.runId, f.fact);
    expect(run.status).toBe('completed'); expect(f.repos.isFinalSaved(f.input.runId, f.fact)).toBe(true);
    expect(f.db.query('SELECT scope_batch_hashes_json FROM query_contexts WHERE session_id=?').get(f.input.sessionId))
      .toEqual({ scope_batch_hashes_json: JSON.stringify(['a'.repeat(64)]) });
  } finally { f.dispose(); }
});

for (const field of ['content_hash', 'snapshot_date', 'scope_key'] as const) {
  test(`p14 program B5 rejects ${field} changed after the original accepted Scope even when current condition hashes match`, async () => {
    const f = await queryFinalFixture();
    try {
      const value = field === 'content_hash' ? 'f'.repeat(64) : field === 'snapshot_date' ? '2026-10-03' : 'ENGINEERING-altered-scope';
      f.db.query(`UPDATE batches SET ${field}=? WHERE id=1`).run(value);
      const fact = structuredClone(f.fact);
      if (field === 'content_hash') {
        const condition = fact.history!.newEntries.find((entry: any) => entry.customType === 'medclaw-query-context') as any;
        condition.data.scopeBatchHashes = [value]; fact.productTurn!.history = fact.history!;
      }
      expect(() => f.repos.finalizeAgent(f.input.runId, fact)).toThrow();
      expect((await f.snapshot()).entries).toEqual([]); expect(f.db.query('SELECT id FROM answers').all()).toEqual([]);
      expect(f.db.query('SELECT id FROM queries WHERE id=?').get(f.query.id)).toEqual({ id: f.query.id });
    } finally { f.dispose(); }
  });
}
