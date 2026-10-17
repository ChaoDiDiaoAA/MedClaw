import { expect, test } from 'bun:test';
import { DATABASE_SCHEMA_VERSION, HOST_PROTOCOL_VERSION, PublicHostRequestSchema, isReadOnlyMethod, publicMethodSchemas } from '../../packages/contracts/src/protocol';
import { RegisteredEventDraftSchema, StoredRunEventSchema, type EventPage } from '../../packages/contracts/src/event';
import { SubmitInputSchema, type SubmitInput } from '../../packages/contracts/src/session';
import { ContextDeliveryObservationSchema } from '../../packages/contracts/src/context';
import { ModelCallViewSchema, UsageViewSchema } from '../../packages/contracts/src/run';
import { INTENT_VERSIONS } from '../../packages/contracts/src/intent';
import { disabledIntentModel, intentRuleFact, intentInput, productIntent } from '../fixtures/p14-intent';
import { safeError } from '../../packages/contracts/src/error';
import * as contextSchemas from '../../packages/contracts/src/context';
import * as intentSchemas from '../../packages/contracts/src/intent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { projectSessionMessages } from '../../packages/runtime-pi/src/messages';
import { MAX_MESSAGE_REFERENCES, MAX_MESSAGE_TEXT_CHARS } from '../../packages/contracts/src/messages';
import { newSessionDraft, acceptSubmissionDraft } from '../../apps/desktop/src/renderer/session-list';
import { createRequire } from 'node:module';
import { QueryConditions } from '../../apps/desktop/src/renderer/intent-panel';
import { RunEventProjection } from '../../apps/desktop/src/renderer/use-run-events';

const at = '2026-10-10T03:00:00.000Z';

test('p14 condition card binds its Session, preserves date boundaries and renders values as text', () => {
  const { renderToStaticMarkup } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('react-dom/server');
  const item = productIntent(), slots = { ...item.slots, region: '<script>inert</script>', time: { start: '2026-01-01', endExclusive: '2026-01-02' }, threshold: { operator: 'gte' as const, value: 0.1 } };
  const context = intentSchemas.QueryContextRecordSchema.parse({ sessionId: 1, nativeLeafId: 'leaf-1', version: 2, sourceInputId: 3, sourceRunId: 4,
    taskIntents: [{ ...item, slots }], contextIntentId: 's1', adoptedSlots: slots,  queryIds: [5], pendingClarification: null });
  expect(renderToStaticMarkup(QueryConditions({ sessionId: 2, context }))).toBe('');
  expect(renderToStaticMarkup(QueryConditions({ sessionId: 1, context: null }))).toBe('');
  const html = renderToStaticMarkup(QueryConditions({ sessionId: 1, context }));
  expect(html).toContain('2026-01-01 ≤ date &lt; 2026-01-02');expect(html).toContain('&lt;script&gt;inert&lt;/script&gt;');
  expect(html).not.toContain('<script>');expect(html).toContain('Run 4');expect(html).toContain('Query #5');
  expect(html).toContain('≥ 0.1');
});

test('p14 new draft uses the enabled intent default and retains explicit main routing otherwise', () => {
  expect(newSessionDraft(null, null, true).routing).toEqual({ mode: 'intent', originRunId: null });
  expect(newSessionDraft(null, null, false).routing).toBeNull();
  expect(newSessionDraft(null).routing).toBeNull();
});

test('p14 accepted intent retains its task until successful settlement without clearing a newer edit', () => {
  const model = { provider: 'fixture', modelId: 'fixture', expectedConfigVersion: '1' };
  const input: SubmitInput = { sessionId: 1, clientSequence: 1, text: 'Original intent task', mode: 'send', expectedRevision: 1,
    expectedBatchIds: [], expectedQueryId: null, model, referenceDate: '2026-10-10', timezone: 'Asia/Shanghai', routing: { mode: 'intent', originRunId: null } };
  const pending = { operationRef: 'original-intent', input }, draft = { ...newSessionDraft(model, null, true), text: input.text, pending };
  expect(acceptSubmissionDraft(draft, pending, 5)).toMatchObject({ text: input.text, pending: null, intentRunId: 5 });
  expect(acceptSubmissionDraft({ ...draft, text: 'New edit' }, pending, 5)).toMatchObject({ text: 'New edit', pending: null, intentRunId: undefined });
  const main = { ...pending, input: { ...input, routing: undefined } };
  expect(acceptSubmissionDraft({ ...draft, pending: main }, main, 6)).toMatchObject({ text: '', pending: null, intentRunId: undefined });
});

test('p14 projects only visible validated program results with bounded text and Query links', () => {
  const manager = SessionManager.inMemory('C:/medclaw-p14-message-fixture');
  const details: intentSchemas.ProductResultDetails = { contract: 'medclaw.product-result/v1', source: 'program', runId: 1, inputId: 2,
    decisionId: 3, kind: 'result', queryIds: Array.from({ length: 20 }, (_, index) => index + 4), missingSlots: [] };
  const text = 'Program query result\n' + 'x'.repeat(MAX_MESSAGE_TEXT_CHARS);
  const visible = manager.appendCustomMessageEntry('medclaw-query-result', text, true, details);
  manager.appendCustomMessageEntry('unregistered', 'PRIVATE_EXTENSION', true, details);
  manager.appendCustomMessageEntry('medclaw-query-result', 'PRIVATE_HIDDEN', false, details);
  manager.appendCustomMessageEntry('medclaw-query-result', 'PRIVATE_INVALID', true, { ...details, source: 'pi' });
  manager.appendCustomMessageEntry('medclaw-query-result', 'PRIVATE_EXTRA', true, { ...details, secret: true });
  manager.appendCustomEntry('medclaw-query-context', { secret: 'PRIVATE_CONTEXT' });
  const before = structuredClone(manager.getEntries()), leaf = manager.getLeafId();
  const page = projectSessionMessages(manager, { sessionId: 1, leafId: null, afterEntryId: null, limit: 50 }, new Map());
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ nativeEntryId: visible, entryType: 'custom_message', displayRole: 'program', runId: 1, inputId: null,
    textInfo: { totalChars: text.length, truncated: true, redacted: false } });
  expect(page.items[0]!.text).toHaveLength(MAX_MESSAGE_TEXT_CHARS);
  expect(page.items[0]!.references).toEqual(['run:1', ...details.queryIds.slice(0, MAX_MESSAGE_REFERENCES - 1).map(id => `query:${id}`)]);
  expect(JSON.stringify(page)).not.toContain('PRIVATE_');
  expect(manager.getEntries()).toEqual(before); expect(manager.getLeafId()).toBe(leaf);
});

test('p14 program result details have one strict shared source contract and real ownership identities', () => {
  const details: intentSchemas.ProductResultDetails = { contract: 'medclaw.product-result/v1', source: 'program', runId: 1, inputId: 2, decisionId: 3,
    kind: 'result', queryIds: [4], missingSlots: [] };
  expect(intentSchemas.ProductResultDetailsSchema.parse(details)).toEqual(details);
  for (const changed of [{ ...details, source: 'pi' }, { ...details, inputId: 0 }, { ...details, queryIds: [4, 4] },
    { ...details, matchedBy: 'rule' }, { ...details, text: 'model text' }]) expect(intentSchemas.ProductResultDetailsSchema.safeParse(changed).success).toBe(false);
});
const envelope = { runId: 1, sessionId: 2, source: 'intent', sourceConnection: 'intent:call-1', sourceSequence: 1,
  toolCallId: null, occurredAt: at, receivedAt: at };
const started = { ...envelope, type: 'intent_started', payload: { contract: 'medclaw.event/v1', stage: 'classify',
  previousCallId: null, runId: 1, inputId: 3, intentCallId: 'call-1', callId: 'call-1', snapshotId: 4,
  configVersion: '1', modelTag: 'qwen3.5:0.8b' } };

test('p14 event replay verifies saved identities and facts before appending any new event', () => {
  const first = StoredRunEventSchema.parse({ ...started, eventId: 11, sequence: 1 });
  const second = StoredRunEventSchema.parse({ ...envelope, sourceSequence: 2, type: 'intent_finished', eventId: 12, sequence: 2,
    payload: { contract: 'medclaw.event/v1', stage: 'classify', runId: 1, inputId: 3, intentCallId: 'call-1', callId: 'call-1',
      state: 'completed', validationState: 'valid', errorCode: null } });
  const page = (events: EventPage['events'], nextSequence: number): EventPage => ({ runId: 1, events, nextSequence,
    hasMore: false, range: { firstSequence: 1, lastSequence: 2 } });
  const view = new RunEventProjection(1, 2);
  expect(view.applyPage(page([first], 1))).toBe(true);
  const before = structuredClone(view.state);
  const changed = StoredRunEventSchema.parse({ ...first, payload: { ...started.payload, snapshotId: 5 } });
  for (const events of [[changed, second], [{ ...first, eventId: 13 }, second], [{ ...second, eventId: first.eventId }]]) {
    expect(view.applyPage(page(events, 2))).toBe(false);
    expect(view.state).toEqual(before);
  }
  expect(view.applyPage(page([first, second], 2))).toBe(true);
  expect(view.applyPage(page([first, second], 2))).toBe(true);
  expect(view.state.events).toEqual([first, second]); expect(view.state.cursor).toBe(2);
});

test('p14 Host negotiates the P14 protocol and schema13 explicitly', () => {
  expect(HOST_PROTOCOL_VERSION).toBe('medclaw.host/p17-v1');
  expect(DATABASE_SCHEMA_VERSION).toBe(16);
});

test('p14 failures keep registered user-visible causes without authorizing automatic retry', () => {
  for (const code of ['intent_model_unavailable', 'intent_model_identity_mismatch', 'intent_offline', 'intent_timeout',
    'intent_response_invalid', 'intent_output_invalid', 'intent_input_too_large']) {
    const error = safeError(code);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(['intent_offline', 'intent_timeout'].includes(code));
  }
});

test('p14 intent context binds an accepted input and baseline without fabricating native consumption', () => {
  const projection = { input: intentInput(), stage: 'classify', review: null };
  const workspaceContext = { sessionId: 1, revision: 0, materialVersion: 'material/v1',
    batchRefs: [], deviceIds: [], queryId: null, activeView: 'data', selection: null };
  const input = { runId: 3, sessionId: 1, inputId: 2, baseLeafId: null, baseStorageVersion: 0,
    workspaceContext, scope: projection.input.scope, nativeRefs: [], projection, createdAt: at };
  const schema = Reflect.get(contextSchemas, 'PrepareIntentContextInputSchema');
  expect(Boolean(schema?.safeParse(input).success)).toBe(true);
  for (const patch of [{ nativeEntryId: 'forged-user' }, { runId: 9 }, { inputId: 9 }, { baseStorageVersion: 1 },
    { baseLeafId: 'other' }, { scope: { ...input.scope, batchIds: [9] } }]) {
    expect(schema.safeParse({ ...input, ...patch }).success).toBe(false);
  }
  expect(contextSchemas.PrepareContextInputSchema.safeParse(input).success).toBe(false);
});

test('p14 public methods use strict identities and inspect is read-only', () => {
  const methods: Record<string, { input: { safeParse(value: unknown): { success: boolean } } }> = publicMethodSchemas;
  expect(methods['intent.read']?.input.safeParse({ runId: 1 }).success).toBe(true);
  expect(methods['intent.read'].input.safeParse({ intentCallId: 'opaque-call-1' }).success).toBe(true);
  for (const request of [{ intentCallId: 1 }, { runId: 1, intentCallId: 'opaque-call-1' }, { sessionId: 1 }]) {
    expect(methods['intent.read'].input.safeParse(request).success).toBe(false);
  }
  expect(methods['model.intent.configure'].input.safeParse({ expectedConfigVersion: '1', intentModel: disabledIntentModel() }).success).toBe(true);
  expect(methods['model.intent.inspect'].input.safeParse({ baseUrl: 'http://127.0.0.1:11434', modelTag: 'qwen3.5:0.8b' }).success).toBe(true);
  expect(isReadOnlyMethod('model.intent.inspect')).toBe(true);
  expect(PublicHostRequestSchema.safeParse({ protocolVersion: HOST_PROTOCOL_VERSION, kind: 'request', requestId: 'read-1',
    instanceId: 'host-1', operationRef: 'read-1', method: 'intent.read', payload: { runId: 1 } }).success).toBe(true);
});

test('p14 routing is explicit only on new Send and never on queued steer/follow-up', () => {
  const base = { clientSequence: 1, sessionId: 2, text: 'ENGINEERING task', expectedRevision: 0, expectedBatchIds: [],
    expectedQueryId: null, model: { provider: 'openai', modelId: 'fixture', expectedConfigVersion: '1' },
    referenceDate: '2026-10-10', timezone: 'Asia/Shanghai' };
  expect(SubmitInputSchema.safeParse({ ...base, mode: 'send', routing: { mode: 'intent', originRunId: null } }).success).toBe(true);
  expect(SubmitInputSchema.safeParse({ ...base, mode: 'send', routing: { mode: 'explicit_agent_fallback', originRunId: 1 } }).success).toBe(true);
  expect(SubmitInputSchema.safeParse({ ...base, mode: 'send', routing: { mode: 'explicit_agent_fallback', originRunId: null } }).success).toBe(false);
  for (const mode of ['steer', 'follow_up']) {
    expect(SubmitInputSchema.safeParse({ ...base, mode, targetRunId: 1, routing: { mode: 'intent', originRunId: null } }).success).toBe(false);
  }
});

test('p14 intent events bind stage, public call identity, source and source sequence independently', () => {
  expect(RegisteredEventDraftSchema.safeParse(started).success).toBe(true);
  for (const patch of [{ source: 'pi' }, { sourceSequence: 2 }, { sourceConnection: 'other' }, { toolCallId: 9 }]) {
    expect(RegisteredEventDraftSchema.safeParse({ ...started, ...patch }).success).toBe(false);
  }
  for (const patch of [{ intentCallId: 'other' }, { previousCallId: 'other' }, { runId: 9 }]) {
    expect(RegisteredEventDraftSchema.safeParse({ ...started, payload: { ...started.payload, ...patch } }).success).toBe(false);
  }
  expect(RegisteredEventDraftSchema.safeParse({ ...started, payload: { ...started.payload, stage: 'verify', previousCallId: 'previous-1' } }).success).toBe(true);
  expect(RegisteredEventDraftSchema.safeParse({ ...started, sourceSequence: 2, type: 'intent_finished', payload: {
    contract: 'medclaw.event/v1', stage: 'classify', runId: 1, inputId: 3, intentCallId: 'call-1', callId: 'call-1',
    state: 'completed', validationState: 'valid', errorCode: null } }).success).toBe(true);
});

test('p14 rule and route events are program facts without fabricated model or tool calls', () => {
  const rule = { ...envelope, source: 'application', sourceConnection: 'intent-rule:1', type: 'intent_rule_evaluated',
    payload: { contract: 'medclaw.event/v1', runId: 1, inputId: 3, ruleEvaluation: intentRuleFact() } };
  expect(RegisteredEventDraftSchema.safeParse(rule).success).toBe(true);
  expect(RegisteredEventDraftSchema.safeParse({ ...rule, source: 'intent' }).success).toBe(false);
  const route = { ...rule, sourceConnection: 'route:5', type: 'route_decided', payload: { contract: 'medclaw.event/v1',
    runId: 1, inputId: 3, decisionId: 5, intentCallId: null, route: 'agent', decisionSource: 'deterministic_rule',
    matchedBy: 'rule', status: 'RESOLVED'} };
  expect(RegisteredEventDraftSchema.safeParse(route).success).toBe(true);
  expect(RegisteredEventDraftSchema.safeParse({ ...route, sourceConnection: 'route:other' }).success).toBe(false);
});

test('p14 nonstreaming Ollama delivery cannot masquerade as a Pi transport', () => {
  const observation = { contract: 'medclaw.context-observation/v1', api: 'ollama-chat', transport: 'json', observedAt: at,
    httpStatus: 200,    verifiedNativeRefs: [] };
  expect(ContextDeliveryObservationSchema.safeParse(observation).success).toBe(true);
  expect(ContextDeliveryObservationSchema.safeParse({ ...observation, transport: 'sse' }).success).toBe(false);
  expect(ContextDeliveryObservationSchema.safeParse({ ...observation, api: 'openai-completions' }).success).toBe(false);
  expect(RegisteredEventDraftSchema.safeParse({ ...envelope, sourceConnection: null, sourceSequence: null, type: 'context_delivered',
    payload: { contract: 'medclaw.event/v1', snapshotId: 4, callId: 'call-1' } }).success).toBe(true);
});

test('p14 actual intent model calls carry their independent selection, exact attempt count and unknown cost', () => {
  const call = { id: 1, inputId: 3, callId: 'call-1', kind: 'intent', state: 'completed', contextSnapshotId: 4,
    granularity: 'logical_request', attempt: 1, attemptCountUnknown: false,
    model: { ...disabledIntentModel(), enabled: true,  verifiedEvidenceRef: 'protocol-1',
      configVersion: '1', api: 'ollama-chat', ...INTENT_VERSIONS },
    responseModel: 'qwen3.5:0.8b', sdkStopReason: null, startedAt: at, endedAt: at, durationMs: 1,
    inputTokens: 0, outputTokens: 1, cost: null, costCurrency: null, usageSource: 'ollama_reported', unavailableReason: null, error: null };
  expect(ModelCallViewSchema.safeParse(call).success).toBe(true);
  for (const patch of [{ attemptCountUnknown: true }, { inputId: null }, { cost: 0 }, { sdkStopReason: 'stop' },
    { model: { ...call.model, modelTag: 'qwen3.5:2b' } }, { usageSource: 'pi_normalized' }]) {
    expect(ModelCallViewSchema.safeParse({ ...call, ...patch }).success).toBe(false);
  }
});

test('p14 usage distinguishes Ollama, Pi and mixed totals without claiming a local cost', () => {
  const usage = { inputTokens: 1, outputTokens: 2, cost: null, costCurrency: null, unavailableReason: null };
  for (const source of ['pi_normalized', 'ollama_reported', 'mixed', null]) {
    expect(UsageViewSchema.safeParse({ ...usage, source }).success).toBe(true);
  }
  expect(UsageViewSchema.safeParse({ ...usage, source: 'ollama_reported', cost: 0, costCurrency: 'USD' }).success).toBe(false);
  expect(UsageViewSchema.safeParse({ ...usage, source: 'mixed', cost: 0, costCurrency: 'USD' }).success).toBe(false);
});
