import { CONTEXT_MATERIAL_PREFIX, IntentModelViewSchema, readIntentContext } from '../../packages/contracts/src/context';
import { IntentStageInputSchema } from '../../packages/contracts/src/intent';
import { BusinessDataSchema } from '../../packages/contracts/src/query';

export const emptyIntentSlots = () => ({
  time: null, region: null, manufacturer: null, device: null, category: null,
  changeKind: null, changeField: null, direction: null, threshold: null, status: null,
  distributor: null, metric: null, groupBy: null, topN: null, sort: null,
});

export const productIntent = () => ({
  id: 's1', l0: 'BASIC_INFO', l1: 'PRODUCT_INFO', l2: 'PRODUCT_SEARCH',
  slots: emptyIntentSlots(), parameters: {}, dependsOn: [], resultRef: null,
});

export const resolvedIntent = () => ({
  contract: 'medclaw.intent/v2', status: 'RESOLVED', intents: [productIntent()],
  candidateIntents: [], clarification: null,
});

export const disabledIntentModel = () => ({
  contract: 'medclaw.intent-model/v2', enabled: false, baseUrl: 'http://127.0.0.1:11434',
  modelTag: 'qwen3.5:0.8b', modelDigest: null,
  sourceUrl: 'https://ollama.com/library/qwen3.5:0.8b', verifiedEvidenceRef: null, timeoutMs: 15000,
});

export const intentRuleFact = () => ({
  ruleVersion: 'medclaw.intent-rules/v1' as const, ruleId: 'product.exact', inputHash: 'a'.repeat(64),
  outcome: 'hit' as const, reasonCode: 'complete_match', checkedAt: '2026-10-10T03:00:00.000Z',
});

export const intentDecision = () => ({
  intentCallId: null, matchedBy: 'rule', route: 'agent', status: 'RESOLVED',
  adoptedIntents: [productIntent()], contextIntentId: 's1', adoptedSlots: emptyIntentSlots(), queryParams: null,
  missingSlots: [], issues: [], ruleEvaluation: intentRuleFact(), decisionSource: 'deterministic_rule',
  schemaVersion: 'medclaw.intent/v2', policyVersion: 'medclaw.intent-policy/v2',
});

export const intentInput = () => ({
  contract: 'medclaw.intent-input/v2', sessionId: 1, inputId: 2, runId: 3, baseLeafId: null, baseStorageVersion: 0,
  text: 'ENGINEERING intent task', referenceDate: '2026-10-10', timezone: 'Asia/Shanghai',
  scope: { batchIds: [], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true },
  scopeBatchHashes: [], previousQueryContext: null, pendingClarification: null, recentTurns: [], selectedEntities: [],
  availableData: { regions: [], dates: [], currencies: [], units: [] }, enabledL2: [], availableToolNames: [],
  versions: { configVersion: '1', taxonomyVersion: 'medclaw.intent-taxonomy/v1', ruleVersion: 'medclaw.intent-rules/v1',
    classifyPromptVersion: 'medclaw.intent-classify-prompt/v1', verifyPromptVersion: 'medclaw.intent-verify-prompt/v1',
    schemaVersion: 'medclaw.intent/v2', policyVersion: 'medclaw.intent-policy/v2' },
});

export function intentCatalogData() {
  const sourceRefs = [{ sourceId: 'ENGINEERING', file: 'fixture.csv', recordId: '1', row: 1, sha256: 'a'.repeat(64) }];
  const batches = [1, 2, 3].map(id => ({ id, scopeKey: 'ENGINEERING-zhejiang', snapshotDate: `2026-10-${String(id + 7).padStart(2, '0')}`,
    region: '浙江', coverage: 'full', previousBatchId: id === 1 ? null : id - 1, materialVersion: 'ENGINEERING/v1',
    sourceBundleId: 'ENGINEERING', sourceLockHash: 'a'.repeat(64), contentHash: String(id).repeat(64), cohortHash: 'b'.repeat(64),
    catalogRevision: 1, expectedEntityCount: 2, observedEntityCount: 2, declaredMissingDeviceIds: [] }));
  const devices = [1, 2].map(id => ({ id, sourceDeviceId: String(id), sourceBundleId: 'ENGINEERING',
    sourceSubmissionId: `submission-${id}`, sourceApplicant: '申报来源，不能作为厂家', sourceRefs }));
  const snapshots = batches.flatMap(batch => devices.map(device => ({ id: (batch.id - 1) * 2 + device.id,
    batchId: batch.id, deviceId: device.id, deviceName: device.id === 1 ? '甲医疗器械' : '乙医疗器械',
    category: device.id === 1 ? '甲类别' : '乙类别', region: batch.region,
    priceCents: device.id === 1 ? 95 + batch.id * 5 : 200, currency: 'CNY', unit: '件', status: 'active',
    manufacturer: device.id === 1 ? '甲厂' : '乙厂', distributor: '配送企业', sourceRowRef: String(device.id), sourceRefs, fieldOrigins: {} })));
  const changes = [2, 3].map(batch => ({ id: batch, deviceId: 1, oldBatchId: batch - 1, newBatchId: batch,
    kind: 'field_changed', field: 'price', oldValue: 95 + (batch - 1) * 5, newValue: 95 + batch * 5,
    deltaCents: 5, ratio: 5 / (95 + (batch - 1) * 5), calculationVersion: 'ENGINEERING/v1' }));
  return BusinessDataSchema.parse({ batches, devices, snapshots, changes });
}

export function readIntentStageMessage(content: string) {
  if (content.startsWith(CONTEXT_MATERIAL_PREFIX + '{"contract":"medclaw.intent-model-view/v1"')) {
    return IntentModelViewSchema.parse(JSON.parse(content.slice(CONTEXT_MATERIAL_PREFIX.length)));
  }
  return readIntentContext(content);
}
