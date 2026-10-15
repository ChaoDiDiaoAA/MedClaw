import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteIntentStore } from '../../packages/storage/src/intent-store';
import { SqliteContextStore } from '../../packages/storage/src/context-store';
import { SqliteEventStore } from '../../packages/storage/src/event-store';
import { SqliteWriteTransactions } from '../../packages/storage/src/write-transactions';
import { renderIntentContext, ContextSnapshotBodySchema } from '../../packages/contracts/src/context';
import { RegisteredEventDraftSchema } from '../../packages/contracts/src/event';
import { canonicalRequest } from '../../packages/contracts/src/run';
import { IntentCallRegistrationSchema, IntentCallCompletionSchema, IntentStageInputSchema, RouteCommitSchema,
  INTENT_VERSIONS, IntentValidationSchema, type IntentCallRegistration, type IntentHttpObservation } from '../../packages/contracts/src/intent';
import { contextAt, acceptContextInput } from '../fixtures/p8-context';
import { disabledIntentModel, intentInput, intentDecision, intentRuleFact, resolvedIntent } from '../fixtures/p14-intent';

const validation = () => IntentValidationSchema.parse({ contract: 'medclaw.intent-validation/v2', state: 'valid', finalStatus: 'RESOLVED',
  adoptedIntents: resolvedIntent().intents, missingSlots: [], issues: [], resolvedDeviceIds: [], reviewRequired: false,
  rawOutputTruncated: false, checkedAt: contextAt });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p14-store-')), db = openDatabase(join(root, 'app.sqlite'));
  let fault = false;
  const repos = new Repositories(db, () => { if (fault) throw new Error('storage_write_failed'); });
  const accepted = acceptContextInput(db, { consume: false, repositories: repos, text: 'ENGINEERING intent task' });
  const events = new SqliteEventStore(db), transactions = SqliteWriteTransactions.forDatabase(db);
  const projection = { ...intentInput(), runId: accepted.input.runId, sessionId: accepted.input.sessionId, inputId: accepted.input.inputId,
    text: accepted.request.text, scope: accepted.input.scope, referenceDate: accepted.request.referenceDate };
  const selection = { ...disabledIntentModel(), enabled: true,  verifiedEvidenceRef: 'protocol-1',
    configVersion: '1', api: 'ollama-chat', ...INTENT_VERSIONS };
  const store = new SqliteIntentStore(db);
  const stage = (callId = 'classify-1', review: unknown = null) => {
    const input = IntentStageInputSchema.parse({ input: projection, stage: review === null ? 'classify' : 'verify', review });
    const renderedProjection = renderIntentContext(input), runtimeFeedback = '';
    const body = ContextSnapshotBodySchema.parse({ contract: 'medclaw.context/v1', workspaceContext: accepted.input.workspaceContext,
      selectedRefs: [],  renderedProjection, runtimeFeedback,
      resourceVersions: {}, nativeRefs: [], omitted: [], projectionLimitBytes: 24 * 1024,
      intentSource: { contract: 'medclaw.intent-context/v1', inputId: projection.inputId, baseLeafId: null, baseStorageVersion: 0 } });
    const snapshotId = Number(db.query(`INSERT INTO context_snapshots(run_id,session_id,input_id,sequence,snapshot_json,created_at)
      VALUES(?,?,?,(SELECT COALESCE(MAX(sequence),0)+1 FROM context_snapshots WHERE run_id=?),?,?)`)
      .run(projection.runId, projection.sessionId, projection.inputId, projection.runId, JSON.stringify(body), contextAt).lastInsertRowid);
    return IntentCallRegistrationSchema.parse({ callId, runId: projection.runId, sessionId: projection.sessionId, inputId: projection.inputId,
      snapshotId, selection, input, stage: input.stage, previousCallId: input.review?.previousCallId ?? null, createdAt: contextAt });
  };
  const observation = (registration: IntentCallRegistration): IntentHttpObservation => {
    const body = JSON.parse(db.query<{ snapshot_json: string }, [number]>('SELECT snapshot_json FROM context_snapshots WHERE id=?').get(registration.snapshotId)!.snapshot_json);
    return { contract: 'medclaw.context-observation/v1', api: 'ollama-chat', transport: 'json', observedAt: contextAt, httpStatus: 200,
         verifiedNativeRefs: [] };
  };
  const completion = (registration: IntentCallRegistration) => IntentCallCompletionSchema.parse({ callId: registration.callId,
    runId: registration.runId, sessionId: registration.sessionId, inputId: registration.inputId, stage: registration.stage, state: 'completed',
    outcome: { transportState: 'completed', rawOutput: JSON.stringify(resolvedIntent()), rawOutputTruncated: false,
      responseModel: 'qwen3.5:0.8b', doneReason: 'stop', httpStatus: 200, observation: observation(registration),
      startedAt: contextAt, endedAt: contextAt, durationMs: 1, inputTokens: 44, outputTokens: 35, serverTotalDurationNs: 1000000, error: null },
    parsed: resolvedIntent(), validation: validation() });
  const deliver = (registration: IntentCallRegistration) => new SqliteContextStore(db).recordDelivery({ runId: registration.runId,
    sessionId: registration.sessionId, inputId: registration.inputId, callId: registration.callId,
    snapshotId: registration.snapshotId, observation: observation(registration) });
  const rule = () => {
    const fact = intentRuleFact();
    transactions.immediate(() => events.appendInTransaction({ type: 'intent_rule_evaluated', runId: projection.runId, sessionId: projection.sessionId,
      source: 'application', sourceConnection: `intent-rule:${projection.runId}`, sourceSequence: 1, toolCallId: null,
      occurredAt: contextAt, receivedAt: contextAt, payload: { contract: 'medclaw.event/v1', runId: projection.runId, inputId: projection.inputId, ruleEvaluation: fact } }));
    return fact;
  };
  const route = (callId: string | null = 'classify-1') => RouteCommitSchema.parse({ runId: projection.runId, sessionId: projection.sessionId,
    inputId: projection.inputId, expectedCancelEpoch: 0, createdAt: contextAt,
    decision: { ...intentDecision(), ...(callId === null ? {} : { intentCallId: callId, matchedBy: 'qwen_prompt',
      decisionSource: 'validated_model', ruleEvaluation: null }) } });
  return { root, db, repos, store, projection, stage, completion, deliver, route, rule, fault: (enabled: boolean) => { fault = enabled; },
    dispose() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const delivered of [false, true]) test(`p14 interrupted intent recovery preserves delivery ${delivered}, unknown usage, atomicity and exit-proof gate`, () => {
  const f = fixture();
  try {
    const registration = f.stage(), identity = f.repos.registerIntentCall(registration);
    if (delivered) f.deliver(registration);
    const before = { calls: f.db.query('SELECT * FROM model_calls').all(), intents: f.db.query('SELECT * FROM intent_calls').all(),
      deliveries: f.db.query('SELECT * FROM context_deliveries').all(), events: f.db.query('SELECT * FROM runtime_events').all() };
    f.fault(true);
    expect(f.repos.verifyPriorIntentFacts(registration.runId, false, contextAt)).toEqual({ requiredPersistenceComplete: false,
      unconfirmedItems: ['intent_stop_unknown', 'intent_persistence'] });
    expect(() => f.repos.verifyPriorIntentFacts(registration.runId, true, contextAt)).toThrow('storage_write_failed');
    expect(f.db.query('SELECT * FROM model_calls').all()).toEqual(before.calls);expect(f.db.query('SELECT * FROM intent_calls').all()).toEqual(before.intents);
    expect(f.db.query('SELECT * FROM runtime_events').all()).toEqual(before.events);
    f.fault(false);
    expect(f.repos.verifyPriorIntentFacts(registration.runId, true, contextAt)).toEqual({ requiredPersistenceComplete: true, unconfirmedItems: [] });
    expect(f.store.readModelCall(identity.modelCallPk)).toMatchObject({ state: 'failed', durationMs: null, inputTokens: null, outputTokens: null,
      usageSource: null, cost: null, unavailableReason: 'runtime_interrupted', error: { code: 'runtime_interrupted' } });
    expect(f.repos.readIntent({ runId: registration.runId })?.calls[0]).toMatchObject({ state: 'failed', prediction: null, rawOutput: null,
      validation: { state: 'not_run' }, error: { code: 'runtime_interrupted' } });
    expect(f.db.query('SELECT * FROM context_deliveries').all()).toEqual(before.deliveries);
    const events = f.db.query('SELECT * FROM runtime_events').all();
    expect(f.repos.verifyPriorIntentFacts(registration.runId, true, contextAt)).toEqual({ requiredPersistenceComplete: true, unconfirmedItems: [] });
    expect(f.db.query('SELECT * FROM runtime_events').all()).toEqual(events);
    expect(() => f.repos.finishIntentCall(f.completion(registration))).toThrow('state_conflict');
  } finally { f.dispose(); }
});

test('p14 registers a real independent intent call and snapshot atomically; replay never creates another call or event', () => {
  const f = fixture();
  try {
    const registration = f.stage(), first = f.repos.registerIntentCall(registration);
    expect(f.repos.registerIntentCall(registration)).toEqual(first);
    expect(f.db.query('SELECT kind,attempt,attempt_count_unknown FROM model_calls').all()).toEqual([{ kind: 'intent', attempt: 1, attempt_count_unknown: 0 }]);
    expect(f.db.query("SELECT type FROM runtime_events WHERE type='intent_started'").all()).toHaveLength(1);
    const read = f.repos.readIntent({ runId: registration.runId });
    expect(read?.calls[0]).toMatchObject({ callId: registration.callId, stage: 'classify', model: registration.selection, state: 'started' });
    expect(f.repos.readIntent({ intentCallId: registration.callId })).toEqual(read);
    expect(() => f.repos.registerIntentCall({ ...registration, selection: { ...registration.selection, timeoutMs: 16000 } })).toThrow('state_conflict');
    expect(() => f.repos.registerIntentCall({ ...registration, callId: 'second-classify' })).toThrow('state_conflict');
    expect(f.db.query('SELECT id FROM model_calls').all()).toHaveLength(1);
  } finally { f.dispose(); }
});

test('p14 registration, completion and route fault barriers roll back their rows and events together', () => {
  const f = fixture();
  try {
    const registration = f.stage();
    f.fault(true); expect(() => f.repos.registerIntentCall(registration)).toThrow('storage_write_failed');
    expect(f.db.query('SELECT id FROM model_calls').all()).toEqual([]);
    expect(f.db.query('SELECT id FROM intent_calls').all()).toEqual([]);
    expect(f.db.query("SELECT id FROM runtime_events WHERE type='intent_started'").all()).toEqual([]);
    f.fault(false); f.repos.registerIntentCall(registration); f.deliver(registration);
    f.fault(true); expect(() => f.repos.finishIntentCall(f.completion(registration))).toThrow('storage_write_failed');
    expect(f.db.query('SELECT state FROM model_calls').get()).toEqual({ state: 'started' });
    expect(f.db.query('SELECT raw_output FROM intent_calls').get()).toEqual({ raw_output: null });
    f.fault(false); f.repos.finishIntentCall(f.completion(registration));
    f.fault(true); expect(() => f.repos.commitRoute(f.route())).toThrow('storage_write_failed');
    expect(f.db.query('SELECT id FROM route_decisions').all()).toEqual([]);
    expect(f.db.query("SELECT id FROM runtime_events WHERE type='route_decided'").all()).toEqual([]);
    f.fault(false); const decision = f.repos.commitRoute(f.route());
    expect(f.repos.commitRoute(f.route())).toEqual(decision);
  } finally { f.dispose(); }
});

test('p14 completion requires saved actual delivery and persists Ollama usage without a Pi or cost claim', () => {
  const f = fixture();
  try {
    const registration = f.stage(); f.repos.registerIntentCall(registration);
    expect(() => f.repos.finishIntentCall(f.completion(registration))).toThrow('state_conflict');
    f.deliver(registration); const completion = f.completion(registration);
    f.repos.finishIntentCall(completion); f.repos.finishIntentCall(completion);
    const read = f.repos.readIntent({ runId: registration.runId });
    expect(read?.calls[0]).toMatchObject({ state: 'completed', prediction: completion.parsed, validation: completion.validation });
    expect(f.db.query('SELECT input_tokens,output_tokens,cost,cost_currency,usage_source FROM model_calls').get())
      .toEqual({ input_tokens: 44, output_tokens: 35, cost: null, cost_currency: null, usage_source: 'ollama_reported' });
    expect(f.store.readModelCall(f.db.query<{ id: number }, []>('SELECT id FROM model_calls').get()!.id))
      .toMatchObject({ kind: 'intent', model: registration.selection, sdkStopReason: null, attemptCountUnknown: false });
    expect(f.repos.read({ runId: registration.runId })).toMatchObject({ kind: 'one', run: { calls: [{ kind: 'intent', model: registration.selection }] } });
    expect(f.db.query("SELECT type FROM runtime_events WHERE type='intent_finished'").all()).toHaveLength(1);
    expect(() => f.repos.finishIntentCall({ ...completion, outcome: { ...completion.outcome, outputTokens: 99 } })).toThrow('state_conflict');
    const committed = f.repos.commitRoute(f.route());
    expect(f.repos.readIntent({ runId: registration.runId })?.decision?.id).toBe(committed.decisionId);
  } finally { f.dispose(); }
});

test('p14 bounded review preserves the first prediction, frozen input and model while saving its own call', () => {
  const f = fixture();
  try {
    const first = f.stage(); f.repos.registerIntentCall(first); f.deliver(first);
    const completion = f.completion(first);
    completion.validation = IntentValidationSchema.parse({ ...completion.validation, state: 'invalid', finalStatus: null, adoptedIntents: [],
      reviewRequired: true, issues: [{ code: 'hierarchy_conflict', intentId: 's1', slot: 'l1', severity: 'invalid', message: 'ENGINEERING conflict', candidates: [] }] });
    f.repos.finishIntentCall(completion);
    const review = { previousCallId: first.callId, prediction: completion.parsed,
      rawPreview: completion.outcome.rawOutput, issues: completion.validation.issues,
      candidates: [{ intents: resolvedIntent().intents, reasonCode: 'hierarchy_conflict' }] };
    const second = f.stage('verify-1', review);
    expect(() => f.repos.registerIntentCall({ ...second, selection: { ...second.selection, timeoutMs: 16000 } })).toThrow('state_conflict');
    f.repos.registerIntentCall(second); f.deliver(second); f.repos.finishIntentCall(f.completion(second));
    expect(f.repos.readIntent({ runId: first.runId })?.calls.map(call => [call.stage, call.previousCallId]))
      .toEqual([['classify', null], ['verify', first.callId]]);
    expect(() => f.repos.commitRoute(f.route(first.callId))).toThrow('state_conflict');
    const route = f.route(second.callId); route.decision.matchedBy = 'paper_enhanced';
    f.repos.commitRoute(route);
    expect(f.db.query('SELECT id FROM model_calls').all()).toHaveLength(2);
  } finally { f.dispose(); }
});

test('p14 saved rule facts can route with zero model calls and final decision remains unique', () => {
  const f = fixture();
  try {
    const request = f.route(null);
    expect(() => f.repos.commitRoute(request)).toThrow('state_conflict');
    f.rule(); const committed = f.repos.commitRoute(request);
    expect(f.repos.commitRoute(request)).toEqual(committed);
    expect(f.repos.readIntent({ runId: request.runId })?.calls).toEqual([]);
    expect(f.repos.readIntent({ runId: request.runId })?.ruleEvaluation).toEqual(intentRuleFact());
    expect(f.db.query('SELECT id FROM model_calls').all()).toEqual([]);
    expect(() => f.repos.commitRoute({ ...request, decision: { ...request.decision, contextIntentId: null, adoptedSlots: null } })).toThrow('state_conflict');
  } finally { f.dispose(); }
});

test('p14 cancellation preserves late attached model facts but prevents route and further registration', () => {
  const f = fixture();
  try {
    const registration = f.stage(); f.repos.registerIntentCall(registration); f.deliver(registration);
    f.db.query('UPDATE runs SET cancel_requested_at=? WHERE id=?').run(contextAt, registration.runId);
    f.repos.finishIntentCall(f.completion(registration));
    expect(f.repos.readIntent({ runId: registration.runId })?.calls[0]).toMatchObject({ state: 'cancelled', validation: { state: 'not_run' } });
    expect(() => f.repos.commitRoute(f.route())).toThrow('state_conflict');
    expect(() => f.repos.registerIntentCall({ ...registration, callId: 'after-stop' })).toThrow('state_conflict');
    expect(f.db.query('SELECT id FROM route_decisions').all()).toEqual([]);
    expect(f.db.query('SELECT id FROM model_calls').all()).toHaveLength(1);
    const saved = { calls: f.db.query('SELECT * FROM model_calls').all(), intents: f.db.query('SELECT * FROM intent_calls').all(),
      events: f.db.query('SELECT * FROM runtime_events').all() };
    f.repos.finishIntentCall(f.completion(registration));
    expect(() => f.repos.finishIntentCall({ ...f.completion(registration), outcome: { ...f.completion(registration).outcome, outputTokens: 36 } })).toThrow('state_conflict');
    expect({ calls: f.db.query('SELECT * FROM model_calls').all(), intents: f.db.query('SELECT * FROM intent_calls').all(),
      events: f.db.query('SELECT * FROM runtime_events').all() }).toEqual(saved);
    expect(f.db.query("SELECT type FROM runtime_events WHERE type='intent_finished'").all()).toHaveLength(1);
  } finally { f.dispose(); }
});

test('p14 trusted storage ports reject mismatched owners, projection text and corrupt persisted facts', () => {
  const f = fixture();
  try {
    const registration = f.stage();
    expect(() => f.repos.registerIntentCall({ ...registration, input: { ...registration.input,
      input: { ...registration.input.input, text: 'forged canonical task' } } })).toThrow('access_denied');
    expect(() => f.repos.registerIntentCall({ ...registration, runId: 999, input: { ...registration.input,
      input: { ...registration.input.input, runId: 999 } } })).toThrow('access_denied');
    f.repos.registerIntentCall(registration);
    expect(f.repos.readIntent({ runId: 999 })).toBeNull();
    f.db.query("UPDATE intent_calls SET validation_json='{}',validation_state='invalid' WHERE run_id=?").run(registration.runId);
    expect(() => f.repos.readIntent({ runId: registration.runId })).toThrow('storage_read_failed');
  } finally { f.dispose(); }
});

test('p14 events cannot claim a call, its completion or a route without the corresponding saved fact', () => {
  const f = fixture();
  try {
    const registration = f.stage(), events = new SqliteEventStore(f.db), tx = SqliteWriteTransactions.forDatabase(f.db);
    const append = (value: unknown) => tx.immediate(() => events.appendInTransaction(RegisteredEventDraftSchema.parse(value)));
    const base = { runId: registration.runId, sessionId: registration.sessionId, toolCallId: null, occurredAt: contextAt, receivedAt: contextAt };
    const started = { ...base, type: 'intent_started', source: 'intent', sourceConnection: `intent:${registration.callId}`, sourceSequence: 1,
      payload: { contract: 'medclaw.event/v1', runId: registration.runId, inputId: registration.inputId, stage: 'classify', previousCallId: null,
        intentCallId: registration.callId, callId: registration.callId, snapshotId: registration.snapshotId,
        configVersion: registration.selection.configVersion, modelTag: registration.selection.modelTag } };
    expect(() => append(started)).toThrow('storage_write_failed');
    f.repos.registerIntentCall(registration);
    expect(() => append({ ...base, type: 'intent_finished', source: 'intent', sourceConnection: `intent:${registration.callId}`, sourceSequence: 2,
      payload: { contract: 'medclaw.event/v1', runId: registration.runId, inputId: registration.inputId, stage: 'classify',
        intentCallId: registration.callId, callId: registration.callId, state: 'completed', validationState: 'valid', errorCode: null } })).toThrow('storage_write_failed');
    expect(() => append({ ...base, type: 'route_decided', source: 'application', sourceConnection: 'route:999', sourceSequence: 1,
      payload: { contract: 'medclaw.event/v1', runId: registration.runId, inputId: registration.inputId, decisionId: 999,
        intentCallId: registration.callId, route: 'agent', decisionSource: 'validated_model', matchedBy: 'qwen_prompt', status: 'RESOLVED'} })).toThrow('storage_write_failed');
  } finally { f.dispose(); }
});

test('p14 parsed predictions must be the actual bounded raw output before they can be adopted', () => {
  const f = fixture();
  try {
    const registration = f.stage(); f.repos.registerIntentCall(registration); f.deliver(registration);
    const completion = f.completion(registration);
    expect(() => f.repos.finishIntentCall({ ...completion, outcome: { ...completion.outcome, rawOutput: '{broken' } })).toThrow('state_conflict');
    expect(() => f.repos.finishIntentCall({ ...completion, outcome: { ...completion.outcome, startedAt: '2026-10-04T23:59:59.999Z' } })).toThrow('state_conflict');
    expect(() => f.repos.finishIntentCall({ ...completion, outcome: { ...completion.outcome, startedAt: '2026-10-05T00:00:00.001Z',
      endedAt: '2026-10-05T00:00:00.002Z' } })).toThrow('state_conflict');
    expect(f.db.query('SELECT state FROM model_calls').get()).toEqual({ state: 'started' });
  } finally { f.dispose(); }
});
