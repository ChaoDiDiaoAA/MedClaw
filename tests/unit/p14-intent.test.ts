import { expect, test } from 'bun:test';
import { disabledIntentModel, emptyIntentSlots, intentDecision, intentRuleFact, productIntent, resolvedIntent, intentInput } from '../fixtures/p14-intent';
import * as schemas from '../../packages/contracts/src/intent';
import * as modelSchemas from '../../packages/contracts/src/model';

test('p14 program settlement names its product-history basis and the real user entry or explicit non-delivery',()=>{
  const proof={contract:'medclaw.product-settlement/v1',basis:'product_history',runId:1,sessionId:1,inputId:1,nativeUserEntryId:'actual-native-user',
    admissionClosed:true,requestSettled:true,routeSettled:true,requiredFactsSaved:true,pendingFactsEmpty:true};
  expect(schemas.ProductSettlementSchema.safeParse(proof).success).toBe(true);
  expect(schemas.ProductSettlementSchema.safeParse({...proof,nativeUserEntryId:null}).success).toBe(true);
  expect(schemas.ProductSettlementSchema.safeParse({...proof,basis:'sdk'}).success).toBe(false);
});

test('p14 exposes shared model configuration through the existing model contract without a second schema', () => {
  expect(Reflect.get(modelSchemas, 'IntentModelConfigurationSchema') === schemas.IntentModelConfigurationSchema).toBe(true);
});

test('p14 route decisions require program-owned source facts and block unsupported execution', () => {
  const schema = Reflect.get(schemas, 'IntentDecisionSchema');
  expect(Boolean(schema?.safeParse(intentDecision()).success)).toBe(true);
  for (const patch of [
    { intentCallId: 'forged-call' }, { ruleEvaluation: null }, { status: 'UNSUPPORTED_DATA' },
    { route: 'simple', queryParams: null }, { contextIntentId: 's2' },
    { adoptedSlots: { ...emptyIntentSlots(), distributor: 'wrong' } },
    { matchedBy: 'qwen_prompt' }, { adoptedIntents: [] },
  ]) expect(schema.safeParse({ ...intentDecision(), ...patch }).success).toBe(false);
  expect(schema.safeParse({ ...intentDecision(), intentCallId: 'classify-1', matchedBy: 'qwen_prompt',
    decisionSource: 'validated_model', ruleEvaluation: { ...intentRuleFact(), ruleId: null, outcome: 'miss' } }).success).toBe(true);
  expect(schema.safeParse({ ...intentDecision(), decisionSource: 'explicit_agent_fallback', matchedBy: null,
    status: null, adoptedIntents: [], contextIntentId: null, adoptedSlots: null, ruleEvaluation: null }).success).toBe(true);
});

test('p14 query contexts retain the unique adopted task and strict branch/source identities', () => {
  const schema = Reflect.get(schemas, 'QueryContextRecordSchema');
  const context = { sessionId: 1, nativeLeafId: 'leaf-1', version: 1, sourceInputId: 2, sourceRunId: 3,
    taskIntents: [productIntent()], contextIntentId: 's1', adoptedSlots: emptyIntentSlots(),
     queryIds: [4], pendingClarification: null };
  expect(Boolean(schema?.safeParse(context).success)).toBe(true);
  for (const patch of [{ nativeLeafId: null }, { sourceRunId: 0 }, { contextIntentId: 's2' }, { taskIntents: [] },
    { sourceRunId:0 }, { queryIds: [4, 4] }, { adoptedSlots: {} }]) {
    expect(schema.safeParse({ ...context, ...patch }).success).toBe(false);
  }
});

test('p14 validation, execution mapping and HTTP facts remain distinct from model output', () => {
  const validationSchema = Reflect.get(schemas, 'IntentValidationSchema');
  const executionSchema = Reflect.get(schemas, 'IntentExecutionFactSchema');
  const validation = { contract: 'medclaw.intent-validation/v2', state: 'valid', finalStatus: 'RESOLVED',
    adoptedIntents: [productIntent()], missingSlots: [], issues: [], resolvedDeviceIds: [], reviewRequired: false,
    rawOutputTruncated: false, checkedAt: '2026-10-10T03:00:00.000Z' };
  expect(Boolean(validationSchema?.safeParse(validation).success)).toBe(true);
  expect(validationSchema.safeParse({ ...validation, finalStatus: null }).success).toBe(false);
  expect(validationSchema.safeParse({ ...validation, rawOutputTruncated: true, reviewRequired: true }).success).toBe(false);
  const execution = { contract: 'medclaw.intent-execution/v1', decisionId: 1, taskIntents: [productIntent()],
    stepResults: [{ stepId: 's1', queryRefs: [{ queryId: 2}] }] };
  expect(executionSchema.safeParse(execution).success).toBe(true);
  expect(executionSchema.safeParse({ ...execution, stepResults: [{ ...execution.stepResults[0], stepId: 's2' }] }).success).toBe(false);
});

test('p14 accepts the strict full v2 result used by the classifier', () => {
  expect(schemas?.IntentResultSchema.safeParse(resolvedIntent()).success).toBe(true);
});

test('p14 registers exactly 4/10/23 unique hierarchical paths', () => {
  const paths = Object.values(schemas?.INTENT_TAXONOMY ?? {}) as { l0: string; l1: string }[];
  expect(paths).toHaveLength(23);
  expect(new Set(paths.map(p => p.l0)).size).toBe(4);
  expect(new Set(paths.map(p => p.l1)).size).toBe(10);
});

test('p14 rejects flat legacy labels and illegal parent paths', () => {
  expect(schemas?.IntentItemSchema.safeParse({ ...productIntent(), l0: 'CHANGE_MONITOR' }).success).toBe(false);
  expect(schemas?.IntentItemSchema.safeParse({ ...productIntent(), l1: 'COMPANY_INFO' }).success).toBe(false);
  expect(schemas?.IntentItemSchema.safeParse({ ...productIntent(), l2: 'current_data_query' }).success).toBe(false);
});

test('p14 rejects model permission, confidence, source and extra nested parameters', () => {
  for (const extra of [{ matchedBy: 'rule' }, { confidence: 1 }, { complexity: 'simple' }, { tool: 'query' }]) {
    expect(schemas?.IntentResultSchema.safeParse({ ...resolvedIntent(), ...extra }).success).toBe(false);
  }
  expect(schemas?.IntentItemSchema.safeParse({ ...productIntent(), parameters: { sql: 'SELECT *' } }).success).toBe(false);
  expect(schemas?.IntentSlotsSchema.safeParse({ ...emptyIntentSlots(), price: 3 }).success).toBe(false);
});

test('p14 requires every slot key and preserves explicit null instead of filling conditions', () => {
  const { distributor, ...partial } = emptyIntentSlots();
  expect(schemas?.IntentSlotsSchema.safeParse(partial).success).toBe(false);
  expect(schemas?.IntentSlotsSchema.parse(emptyIntentSlots()).distributor).toBe(null);
  expect(schemas?.IntentSlotsSchema.safeParse({ ...emptyIntentSlots(), manufacturer: '\u0000' }).success).toBe(false);
});

test('p14 validates half-open real dates and the 366-day limit', () => {
  for (const time of [
    { start: '2025-02-29', endExclusive: '2025-03-01' },
    { start: '2026-01-01', endExclusive: '2026-01-01' },
    { start: '2026-01-02', endExclusive: '2026-01-01' },
    { start: '2024-01-01', endExclusive: '2025-01-02' },
  ]) expect(schemas?.TimeRangeSchema.safeParse(time).success).toBe(false);
  expect(schemas?.TimeRangeSchema.safeParse({ start: '2024-01-01', endExclusive: '2025-01-01' }).success).toBe(true);
});

test('p14 ratios accept growth above 100 percent and retain gt versus gte', () => {
  for (const operator of ['gt', 'gte'] as const) {
    expect(schemas?.IntentSlotsSchema.parse({ ...emptyIntentSlots(), threshold: { operator, value: 1.2 } }).threshold?.operator).toBe(operator);
  }
  for (const value of [-0.01, Infinity, NaN]) {
    expect(schemas?.IntentSlotsSchema.safeParse({ ...emptyIntentSlots(), threshold: { operator: 'gt', value } }).success).toBe(false);
  }
  for (const topN of [0, 101, 1.5]) expect(schemas?.IntentSlotsSchema.safeParse({ ...emptyIntentSlots(), topN }).success).toBe(false);
});

test('p14 binds exclusive parameters to the leaf label and requires unknown keys as null', () => {
  const expiry = { ...productIntent(), l0: 'CHANGE_MONITOR', l1: 'CERT_MONITOR', l2: 'CERT_EXPIRY_WARNING' };
  expect(schemas?.IntentItemSchema.safeParse({ ...expiry, parameters: { withinDays: null } }).success).toBe(true);
  for (const parameters of [{}, { withinDays: 0 }, { withinDays: 367 }, { withinDays: 3, certificateNumber: 'X' }]) {
    expect(schemas?.IntentItemSchema.safeParse({ ...expiry, parameters }).success).toBe(false);
  }
});

test('p14 comparison lists permit unknown empty lists and reject duplicate or one-item comparisons', () => {
  const item = { ...productIntent(), l0: 'STATISTICAL_ANALYSIS', l1: 'COMPANY_STATS', l2: 'COMPANY_COMPARE' };
  for (const manufacturers of [[], ['A', 'B']]) {
    expect(schemas?.IntentItemSchema.safeParse({ ...item, parameters: { manufacturers } }).success).toBe(true);
  }
  for (const manufacturers of [['A'], ['A', 'A'], Array.from({ length: 21 }, (_, i) => 'A' + i)]) {
    expect(schemas?.IntentItemSchema.safeParse({ ...item, parameters: { manufacturers } }).success).toBe(false);
  }
});

test('p14 validates earlier-step dependencies and binds resultRef to a declared dependency', () => {
  const delivery = { ...productIntent(), id: 's2', l0: 'DATA_OPERATIONS', l1: 'RESULT_DELIVERY', l2: 'EXPORT_RESULT',
    parameters: { format: 'csv' }, dependsOn: ['s1'], resultRef: { stepId: 's1' } };
  const task = { ...resolvedIntent(), intents: [productIntent(), delivery] };
  expect(schemas?.IntentResultSchema.safeParse(task).success).toBe(true);
  for (const intents of [[delivery, productIntent()], [productIntent(), productIntent()],
    [productIntent(), { ...delivery, dependsOn: [] }], [productIntent(), { ...delivery, resultRef: { stepId: 's2' } }]]) {
    expect(schemas?.IntentResultSchema.safeParse({ ...task, intents }).success).toBe(false);
  }
  expect(schemas?.IntentItemSchema.safeParse({ ...delivery, resultRef: { queryId: 0 } }).success).toBe(false);
});

test('p14 keeps the five semantic statuses distinct and enforces their required payloads', () => {
  const base = resolvedIntent();
  const clarification = { question: 'Which product?', intentIds: ['s1'], missingSlots: ['device'], options: [] };
  expect(schemas?.IntentResultSchema.safeParse({ ...base, intents: [] }).success).toBe(false);
  expect(schemas?.IntentResultSchema.safeParse({ ...base, status: 'OUT_OF_SCOPE', intents: [] }).success).toBe(true);
  expect(schemas?.IntentResultSchema.safeParse({ ...base, status: 'OUT_OF_SCOPE' }).success).toBe(false);
  expect(schemas?.IntentResultSchema.safeParse({ ...base, status: 'NEED_PARAMETERS', clarification }).success).toBe(true);
  expect(schemas?.IntentResultSchema.safeParse({ ...base, status: 'NEED_PARAMETERS' }).success).toBe(false);
  expect(schemas?.IntentResultSchema.safeParse({ ...base, status: 'AMBIGUOUS', clarification,
    candidateIntents: [{ intents: [productIntent()], reasonCode: 'confusable_pair' }] }).success).toBe(true);
  expect(schemas?.IntentResultSchema.safeParse({ ...base, status: 'AMBIGUOUS', clarification }).success).toBe(false);
  expect(schemas?.IntentResultSchema.safeParse({ ...base, status: 'UNSUPPORTED_DATA', intents: [] }).success).toBe(true);
  expect(schemas?.IntentResultSchema.safeParse({ ...base, status: 'failed' }).success).toBe(false);
});

test('p14 bounds and deduplicates candidates, questions, clarification slots and task IDs', () => {
  const base = resolvedIntent(), group = { intents: [productIntent()], reasonCode: 'schema_recovery' };
  const clarification = { question: 'Choose a task.', intentIds: ['s1'], missingSlots: [], options: [] };
  for (const candidateIntents of [[group, group, group, group], [{ ...group, intents: [] }]]) {
    expect(schemas?.IntentResultSchema.safeParse({ ...base, status: 'AMBIGUOUS', candidateIntents, clarification }).success).toBe(false);
  }
  expect(schemas?.IntentResultSchema.safeParse({ ...base, status: 'NEED_PARAMETERS',
    clarification: { ...clarification, missingSlots: ['device', 'device'] } }).success).toBe(false);
  expect(schemas?.IntentItemSchema.safeParse({ ...productIntent(), id: 's9' }).success).toBe(false);
});

test('p14 allows only numeric HTTP loopback Ollama URLs with no redirecting URL components', () => {
  for (const baseUrl of ['http://127.0.0.1:11434', 'http://[::1]:11434', 'http://127.0.0.1']) {
    expect(schemas?.IntentModelConfigurationSchema.safeParse({ ...disabledIntentModel(), baseUrl }).success).toBe(true);
  }
  for (const baseUrl of ['https://127.0.0.1', 'http://localhost:11434', 'http://example.com', 'http://127.1',
    'http://2130706433', 'http://127.0.0.1/api', 'http://u:p@127.0.0.1', 'http://127.0.0.1?x=1', 'http://127.0.0.1#x']) {
    expect(schemas?.IntentModelConfigurationSchema.safeParse({ ...disabledIntentModel(), baseUrl }).success).toBe(false);
  }
});

test('p14 enables only the stock tag with protocol evidence', () => {
  const enabled = { ...disabledIntentModel(), enabled: true };
  expect(schemas?.IntentModelConfigurationSchema.safeParse(enabled).success).toBe(false);
  const valid = { ...enabled,  verifiedEvidenceRef: 'p14.official-protocol' };
  expect(schemas?.IntentModelConfigurationSchema.safeParse(valid).success).toBe(true);
  for (const patch of [{ modelTag: 'qwen3.5:2b' }, { verifiedEvidenceRef:null }, { timeoutMs: 999 },
    { timeoutMs: 60001 }, { adapter: 'sft' }, { sourceUrl: 'https://example.com' }]) {
    expect(schemas?.IntentModelConfigurationSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  }
});

test('p14 exports JSON Schema from the same Zod output contract', () => {
  expect(schemas.intentJsonSchema).toMatchObject({
    type: 'object', additionalProperties: false, properties: { contract: { const: 'medclaw.intent/v2' } },
  });
});

test('p14 registration binds the admitted input, stage and immutable enabled model selection', () => {
  const input = { input: intentInput(), stage: 'classify', review: null };
  const model = { ...disabledIntentModel(), enabled: true,  verifiedEvidenceRef: 'protocol-1',
    configVersion: '1', api: 'ollama-chat', ...schemas.INTENT_VERSIONS };
  const value = { callId: 'classify-1', runId: 3, sessionId: 1, inputId: 2, snapshotId: 4,
    selection: model, input, stage: 'classify', previousCallId: null, createdAt: '2026-10-10T03:00:00.000Z' };
  const registration = Reflect.get(schemas, 'IntentCallRegistrationSchema');
  expect(Boolean(registration?.safeParse(value).success)).toBe(true);
  for (const patch of [{ runId: 9 }, { sessionId: 9 }, { inputId: 9 }, { previousCallId: 'other' },
    { stage: 'verify' }, { selection: { ...model, enabled: false } }, { selection: { ...model, configVersion: '2' } }, { schemaVersion: 'v1' }]) {
    expect(registration.safeParse({ ...value, ...patch }).success).toBe(false);
  }
});
