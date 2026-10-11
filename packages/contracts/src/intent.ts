import { z } from 'zod';
import { AppErrorSchema, ConfigVersionSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema } from './error';
import { INTENT_VERSIONS, IntentModelSelectionSchema, IntentClassifyPromptVersionSchema, IntentVerifyPromptVersionSchema, IntentPolicyVersionSchema, ReferenceDateSchema, TimezoneSchema, type IntentModelSelection } from './model';
import { BatchSchema, QueryParamsSchema } from './query';
import { RunScopeSchema, RunStatusSchema } from './run';
import { ResourceHashSchema } from './resources';
export { INTENT_VERSIONS, IntentBaseUrlSchema, IntentModelConfigurationSchema, IntentModelSelectionSchema } from './model';
export type { IntentModelConfiguration, IntentModelSelection } from './model';

export const INTENT_TAXONOMY = {
  PRODUCT_SEARCH: { l0: 'BASIC_INFO', l1: 'PRODUCT_INFO', definition: '检索当前器械' },
  PRODUCT_DETAIL: { l0: 'BASIC_INFO', l1: 'PRODUCT_INFO', definition: '查看指定器械详情' },
  CERT_LOOKUP: { l0: 'BASIC_INFO', l1: 'PRODUCT_INFO', definition: '查询注册证资料' },
  COMPANY_PROFILE: { l0: 'BASIC_INFO', l1: 'COMPANY_INFO', definition: '企业主体资料' },
  COMPANY_PRODUCTS: { l0: 'BASIC_INFO', l1: 'COMPANY_INFO', definition: '指定企业的器械清单' },
  NEW_RECORDS: { l0: 'CHANGE_MONITOR', l1: 'RECORD_CHANGE', definition: '期间新增记录' },
  FIELD_CHANGES: { l0: 'CHANGE_MONITOR', l1: 'RECORD_CHANGE', definition: '指定业务字段的变动记录' },
  PRICE_CHANGE_RANK: { l0: 'CHANGE_MONITOR', l1: 'PRICE_MONITOR', definition: '按价格变动量或比率排行' },
  PRICE_TREND: { l0: 'CHANGE_MONITOR', l1: 'PRICE_MONITOR', definition: '价格随日期变化' },
  PRICE_ANOMALY: { l0: 'CHANGE_MONITOR', l1: 'PRICE_MONITOR', definition: '指定口径的价格异常' },
  CERT_STATUS_CHANGE: { l0: 'CHANGE_MONITOR', l1: 'CERT_MONITOR', definition: '注册证状态变化；不含器械业务状态' },
  CERT_EXPIRY_WARNING: { l0: 'CHANGE_MONITOR', l1: 'CERT_MONITOR', definition: '注册证到期预警' },
  CATEGORY_STATS: { l0: 'STATISTICAL_ANALYSIS', l1: 'CATEGORY_REGION_STATS', definition: '按类别统计' },
  REGION_STATS: { l0: 'STATISTICAL_ANALYSIS', l1: 'CATEGORY_REGION_STATS', definition: '按区域统计' },
  COMPANY_RANK: { l0: 'STATISTICAL_ANALYSIS', l1: 'COMPANY_STATS', definition: '按企业聚合排行' },
  COMPANY_COMPARE: { l0: 'STATISTICAL_ANALYSIS', l1: 'COMPANY_STATS', definition: '指定企业之间比较' },
  PRODUCT_COMPARE: { l0: 'STATISTICAL_ANALYSIS', l1: 'COMPARATIVE_ANALYSIS', definition: '指定器械之间比较' },
  PERIOD_COMPARE: { l0: 'STATISTICAL_ANALYSIS', l1: 'COMPARATIVE_ANALYSIS', definition: '两个明确期间比较' },
  MISSING_FIELDS: { l0: 'DATA_OPERATIONS', l1: 'DATA_QUALITY', definition: '业务字段缺失检查' },
  DUPLICATES: { l0: 'DATA_OPERATIONS', l1: 'DATA_QUALITY', definition: '按键检查重复记录' },
  FRESHNESS: { l0: 'DATA_OPERATIONS', l1: 'DATA_QUALITY', definition: '数据新鲜度；不含证书到期' },
  MONITOR_REPORT: { l0: 'DATA_OPERATIONS', l1: 'RESULT_DELIVERY', definition: '生成监控报告' },
  EXPORT_RESULT: { l0: 'DATA_OPERATIONS', l1: 'RESULT_DELIVERY', definition: '导出已查询的真实结果' },
} as const;

export type L2 = keyof typeof INTENT_TAXONOMY;
export const L2Schema = z.enum(Object.keys(INTENT_TAXONOMY) as [L2, ...L2[]]);
export const L0Schema = z.enum([...new Set(Object.values(INTENT_TAXONOMY).map(p => p.l0))]);
export const L1Schema = z.enum([...new Set(Object.values(INTENT_TAXONOMY).map(p => p.l1))]);
const label = z.string().min(1).max(256).refine(v => !/[\u0000-\u001f\u007f]/.test(v), 'Control characters are forbidden');
const stepId = z.string().regex(/^s[1-8]$/);
const uniqueLabels = z.array(label).max(20).refine(v => new Set(v).size === v.length, 'Duplicate values');
const comparisons = uniqueLabels.refine(v => v.length === 0 || v.length >= 2, 'A comparison needs two distinct values');
export const TimeRangeSchema = z.strictObject({ start: ReferenceDateSchema, endExclusive: ReferenceDateSchema })
  .refine(v => v.start < v.endExclusive && (Date.parse(v.endExclusive) - Date.parse(v.start)) / 86400000 <= 366, 'Expected a half-open interval of at most 366 days');
export type TimeRange = z.infer<typeof TimeRangeSchema>;
export const IntentStatusSchema = z.enum(['RESOLVED', 'AMBIGUOUS', 'OUT_OF_SCOPE', 'UNSUPPORTED_DATA', 'NEED_PARAMETERS']);
export type IntentStatus = z.infer<typeof IntentStatusSchema>;
export const IntentStageSchema = z.enum(['classify', 'verify']);
export type IntentStage = z.infer<typeof IntentStageSchema>;
export const IntentSlotsSchema = z.strictObject({
  time: TimeRangeSchema.nullable(), region: label.nullable(), manufacturer: label.nullable(), device: label.nullable(), category: label.nullable(),
  changeKind: z.enum(['added', 'missing', 'field_changed']).nullable(),
  changeField: z.enum(['price', 'status', 'distributor']).nullable(), direction: z.enum(['increase', 'decrease']).nullable(),
  threshold: z.strictObject({ operator: z.enum(['gt', 'gte', 'lt', 'lte']), value: z.number().finite().nonnegative() }).nullable(),
  status: z.enum(['active', 'suspended', 'delisted', 'recalled']).nullable(), distributor: label.nullable(),
  metric: z.enum(['count', 'changed_device_count', 'sum_price', 'mean_price', 'change_count']).nullable(),
  groupBy: z.enum(['date', 'region', 'category', 'manufacturer', 'status']).nullable(),
  topN: z.number().int().min(1).max(100).nullable(), sort: z.enum(['asc', 'desc']).nullable(),
});
export type IntentSlots = z.infer<typeof IntentSlotsSchema>;
const itemFields = {
  id: stepId, slots: IntentSlotsSchema,
  dependsOn: z.array(stepId).max(7).refine(v => new Set(v).size === v.length, 'Duplicate dependencies'),
  resultRef: z.union([z.strictObject({ stepId }), z.strictObject({ queryId: PositiveIdSchema })]).nullable(),
};
const leaf = <K extends L2, S extends z.ZodRawShape>(l2: K, parameters: S) => z.strictObject({
  ...itemFields, l0: z.literal(INTENT_TAXONOMY[l2].l0), l1: z.literal(INTENT_TAXONOMY[l2].l1), l2: z.literal(l2),
  parameters: z.strictObject(parameters),
});
export const IntentItemSchema = z.discriminatedUnion('l2', [
  leaf('PRODUCT_SEARCH', {}), leaf('PRODUCT_DETAIL', {}), leaf('CERT_LOOKUP', { certificateNumber: label.nullable() }),
  leaf('COMPANY_PROFILE', {}), leaf('COMPANY_PRODUCTS', {}), leaf('NEW_RECORDS', {}), leaf('FIELD_CHANGES', {}),
  leaf('PRICE_CHANGE_RANK', { rankBy: z.enum(['absolute_change', 'change_ratio']).nullable() }), leaf('PRICE_TREND', {}),
  leaf('PRICE_ANOMALY', { method: z.enum(['explicit_threshold', 'statistical']).nullable() }),
  leaf('CERT_STATUS_CHANGE', { certificateNumber: label.nullable() }),
  leaf('CERT_EXPIRY_WARNING', { withinDays: z.number().int().min(1).max(366).nullable() }),
  leaf('CATEGORY_STATS', {}), leaf('REGION_STATS', {}), leaf('COMPANY_RANK', {}),
  leaf('COMPANY_COMPARE', { manufacturers: comparisons }), leaf('PRODUCT_COMPARE', { devices: comparisons }),
  leaf('PERIOD_COMPARE', { periods: z.array(TimeRangeSchema).refine(v => v.length === 0 || v.length === 2, 'Expected exactly two periods or unknown') }),
  leaf('MISSING_FIELDS', { fields: uniqueLabels }), leaf('DUPLICATES', { keyFields: uniqueLabels }),
  leaf('FRESHNESS', { basis: z.enum(['snapshot_date', 'capture_time']).nullable() }),
  leaf('MONITOR_REPORT', { format: z.enum(['markdown', 'pdf']).nullable() }),
  leaf('EXPORT_RESULT', { format: z.enum(['csv', 'xlsx']).nullable() }),
]);
export type IntentItem = z.infer<typeof IntentItemSchema>;
export type ParamsByL2 = { [K in L2]: Extract<IntentItem, { l2: K }>['parameters'] };
export const IntentItemsSchema = z.array(IntentItemSchema).max(8).superRefine((items, ctx) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate step ID' });
    for (const dependency of item.dependsOn) {
      if (!seen.has(dependency)) ctx.addIssue({ code: 'custom', path: [index, 'dependsOn'], message: 'Dependency must reference an earlier step' });
    }
    if (item.resultRef && 'stepId' in item.resultRef && !item.dependsOn.includes(item.resultRef.stepId)) {
      ctx.addIssue({ code: 'custom', path: [index, 'resultRef'], message: 'Result reference must be a declared earlier dependency' });
    }
    seen.add(item.id);
  });
});
export const IntentCandidateSchema = z.strictObject({
  intents: IntentItemsSchema.refine(v => v.length > 0, 'A candidate must contain a task'),
  reasonCode: z.enum(['hierarchy_conflict', 'confusable_pair', 'suspected_ood', 'schema_recovery']),
});
export type IntentCandidate = z.infer<typeof IntentCandidateSchema>;
const uniqueSlots = z.array(label).max(20).refine(v => new Set(v).size === v.length, 'Duplicate missing slots');
export const IntentClarificationSchema = z.strictObject({
  question: z.string().min(1).max(1024).refine(v => !/[\u0000-\u001f\u007f]/.test(v)),
  intentIds: z.array(stepId).max(8).refine(v => new Set(v).size === v.length),
  missingSlots: uniqueSlots, options: z.array(label).max(5),
});
export const IntentResultSchema = z.strictObject({
  contract: z.literal('medclaw.intent/v2'), status: IntentStatusSchema, intents: IntentItemsSchema,
  candidateIntents: z.array(IntentCandidateSchema).max(3), clarification: IntentClarificationSchema.nullable(),
}).superRefine((result, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (result.status === 'RESOLVED' && (!result.intents.length || result.candidateIntents.length || result.clarification !== null)) invalid('Resolved requires a nonempty task without candidates or clarification');
  if (result.status === 'OUT_OF_SCOPE' && (result.intents.length || result.candidateIntents.length || result.clarification !== null)) invalid('Out of scope cannot contain a task');
  if (result.status === 'AMBIGUOUS' && (!result.candidateIntents.length || result.clarification === null)) invalid('Ambiguity requires finite candidates and clarification');
  if (result.status === 'NEED_PARAMETERS' && (!result.intents.length || !result.clarification?.missingSlots.length)) invalid('Missing parameters require a determined task and missing slots');
  const ids = new Set([...result.intents, ...result.candidateIntents.flatMap(c => c.intents)].map(item => item.id));
  if (result.clarification?.intentIds.some(id => !ids.has(id))) invalid('Clarification references an unknown task');
});
export type IntentResult = z.infer<typeof IntentResultSchema>;
export const intentJsonSchema = z.toJSONSchema(IntentResultSchema, { target: 'draft-7' });

export const ReadIntentInputSchema = z.union([
  z.strictObject({ runId: PositiveIdSchema }), z.strictObject({ intentCallId: OpaqueIdSchema }),
]);
export type ReadIntentInput = z.infer<typeof ReadIntentInputSchema>;

const hashes = z.array(ResourceHashSchema).max(10000).refine(values =>
  new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1]! < value), 'Hashes must be unique and sorted');
const queryIds = z.array(PositiveIdSchema).refine(values => new Set(values).size === values.length, 'Duplicate Query IDs');
export const PendingClarificationSchema = z.strictObject({ taskText: z.string().min(1).max(65536), missingSlots: uniqueSlots });
const adoptedFields = {
  sourceInputId: PositiveIdSchema, sourceRunId: PositiveIdSchema,
  taskIntents: IntentItemsSchema, contextIntentId: stepId, adoptedSlots: IntentSlotsSchema,
  scopeBatchHashes: hashes, queryIds, pendingClarification: PendingClarificationSchema.nullable(),
};
function hasAdoptedQuery(value: { taskIntents: IntentItem[]; contextIntentId: string; adoptedSlots: IntentSlots }): boolean {
  const item = value.taskIntents.find(item => item.id === value.contextIntentId);
  return item !== undefined && item.l1 !== 'RESULT_DELIVERY' && JSON.stringify(item.slots) === JSON.stringify(value.adoptedSlots);
}
const AutomaticQueryContextRecordSchema = z.strictObject({
  sessionId: PositiveIdSchema, nativeLeafId: OpaqueIdSchema, version: PositiveIdSchema, ...adoptedFields,
}).refine(hasAdoptedQuery, 'Context requires the unique adopted query and its exact full slots');
export const AdoptedContextFactSchema = z.strictObject({
  contract: z.literal('medclaw.query-context-entry/v2'), ...adoptedFields, decisionId: PositiveIdSchema,
}).refine(hasAdoptedQuery, 'Context requires a determined query');
export type AdoptedContextFact = z.infer<typeof AdoptedContextFactSchema>;
export const FormContextFactSchema = z.strictObject({
  contract: z.literal('medclaw.query-form-context/v1'), decisionId: PositiveIdSchema,
  sourceRunId: PositiveIdSchema, sourceInputId: PositiveIdSchema, params: QueryParamsSchema,
  queryIds: queryIds.length(1), scopeBatchHashes: hashes,
});
export type FormContextFact = z.infer<typeof FormContextFactSchema>;
export const FormExecutionFactSchema = z.strictObject({ contract: z.literal('medclaw.query-form-execution/v1'),
  decisionId: PositiveIdSchema, queryId: PositiveIdSchema, resultHash: ResourceHashSchema });
export type FormExecutionFact = z.infer<typeof FormExecutionFactSchema>;
export const FormQueryContextRecordSchema = FormContextFactSchema.extend({
  sessionId: PositiveIdSchema, nativeLeafId: OpaqueIdSchema, version: PositiveIdSchema, pendingClarification: z.null(),
});
export type FormQueryContextRecord = z.infer<typeof FormQueryContextRecordSchema>;
export const QueryContextRecordSchema = z.union([AutomaticQueryContextRecordSchema, FormQueryContextRecordSchema]);
export type QueryContextRecord = z.infer<typeof QueryContextRecordSchema>;
export const QueryContextFactSchema = z.union([AdoptedContextFactSchema, FormContextFactSchema]);
export type QueryContextFact = z.infer<typeof QueryContextFactSchema>;
export const ValidationIssueSchema = z.strictObject({
  code: z.enum(['missing_slot', 'ambiguous_entity', 'entity_not_found', 'data_missing', 'data_coverage_missing',
    'unsupported_capability', 'hierarchy_conflict', 'confusable_pair', 'suspected_ood', 'invalid_combination',
    'explicit_condition_conflict', 'scope_violation', 'invalid_value']),
  intentId: stepId.nullable(), slot: label, severity: z.enum(['needs_input', 'warning', 'invalid']),
  message: z.string().min(1).max(1024), candidates: uniqueLabels,
  sourceSpan: z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
    .refine(value => value.end > value.start).optional(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;
export const IntentValidationSchema = z.strictObject({
  contract: z.literal('medclaw.intent-validation/v2'), state: z.enum(['pending', 'valid', 'invalid', 'not_run']),
  finalStatus: IntentStatusSchema.nullable(), adoptedIntents: IntentItemsSchema, missingSlots: uniqueSlots,
  issues: z.array(ValidationIssueSchema).max(64),
  resolvedDeviceIds: z.array(z.strictObject({ intentId: stepId, deviceIds: queryIds })).max(8),
  reviewRequired: z.boolean(), rawOutputTruncated: z.boolean(), checkedAt: TimestampSchema.nullable(),
}).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.state === 'valid' && (value.finalStatus === null || value.checkedAt === null)) invalid('Valid requires a semantic status and completed check');
  if (value.state === 'valid' && value.finalStatus === 'RESOLVED' && !value.adoptedIntents.length) invalid('Resolved requires an adopted task');
  if (value.state === 'valid' && value.finalStatus === 'NEED_PARAMETERS' && (!value.adoptedIntents.length || !value.missingSlots.length)) invalid('Missing parameters require a determined task');
  if (value.state === 'valid' && value.finalStatus === 'UNSUPPORTED_DATA' && !value.adoptedIntents.length
    && !value.issues.some(issue => issue.code === 'unsupported_capability' && issue.slot === 'taxonomy' && issue.intentId === null)) invalid('Unregistered domain tasks need an explicit taxonomy issue');
  if (value.reviewRequired && (value.rawOutputTruncated || value.finalStatus === 'NEED_PARAMETERS' || value.finalStatus === 'UNSUPPORTED_DATA')) invalid('Truncation, missing parameters and unsupported capabilities cannot trigger review');
  if (value.state === 'valid' && value.resolvedDeviceIds.some(item => !value.adoptedIntents.some(intent => intent.id === item.intentId))) invalid('Resolved entities reference an unknown task');
  if (new Set(value.resolvedDeviceIds.map(item => item.intentId)).size !== value.resolvedDeviceIds.length) invalid('Duplicate entity resolution');
});
export type IntentValidation = z.infer<typeof IntentValidationSchema>;
export const RuleEvaluationSchema = z.strictObject({
  ruleVersion: z.literal(INTENT_VERSIONS.ruleVersion), ruleId: label.nullable(), inputHash: ResourceHashSchema,
  outcome: z.enum(['hit', 'miss', 'conflict']), reasonCode: label, checkedAt: TimestampSchema,
}).refine(value => value.outcome !== 'hit' || value.ruleId !== null, 'A complete rule hit needs its registered identity');
export type RuleEvaluation = z.infer<typeof RuleEvaluationSchema>;
export const IntentQueryPlanSchema = z.strictObject({ contract: z.literal('medclaw.intent-query-plan/v1'),
  steps: z.array(z.strictObject({ stepId, dependsOn: z.array(stepId).max(7),
    queries: z.array(z.lazy(() => QueryParamsSchema)).max(64),
    metadata: z.strictObject({ basis: z.literal('snapshot_date'), region: label.nullable() }).nullable(),
  }).refine(step => step.metadata === null ? step.queries.length > 0 : step.queries.length === 0, 'A step has queries or metadata')).min(1).max(8),
}).superRefine((plan, ctx) => {
  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (seen.has(step.stepId) || step.dependsOn.some(id => !seen.has(id)) || new Set(step.dependsOn).size !== step.dependsOn.length)
      ctx.addIssue({ code: 'custom', message: 'Plan steps require unique identities and earlier dependencies' });
    seen.add(step.stepId);
  }
});
export type IntentQueryPlan = z.infer<typeof IntentQueryPlanSchema>;
export const IntentDecisionSchema = z.strictObject({
  intentCallId: OpaqueIdSchema.nullable(), matchedBy: z.enum(['rule', 'qwen_prompt', 'paper_enhanced']).nullable(),
  route: z.enum(['simple', 'agent', 'clarify', 'reject']), status: IntentStatusSchema.nullable(),
  adoptedIntents: IntentItemsSchema, contextIntentId: stepId.nullable(), adoptedSlots: IntentSlotsSchema.nullable(),
  queryParams: z.lazy(() => QueryParamsSchema).nullable(), missingSlots: uniqueSlots, issues: z.array(ValidationIssueSchema).max(64),
  executionPlan: IntentQueryPlanSchema.optional(),
  ruleEvaluation: RuleEvaluationSchema.nullable(),
  decisionSource: z.enum(['deterministic_rule', 'validated_model', 'user_form', 'explicit_agent_fallback']),
  schemaVersion: z.literal(INTENT_VERSIONS.schemaVersion), policyVersion: IntentPolicyVersionSchema,
}).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  const automatic = value.decisionSource === 'deterministic_rule' || value.decisionSource === 'validated_model';
  if (value.decisionSource === 'deterministic_rule' && (value.intentCallId !== null || value.matchedBy !== 'rule' || value.ruleEvaluation?.outcome !== 'hit')) invalid('A rule decision requires a saved complete rule and no model call');
  if (value.decisionSource === 'validated_model' && (value.intentCallId === null || !['qwen_prompt', 'paper_enhanced'].includes(value.matchedBy ?? ''))) invalid('A model decision requires its actual adopted call');
  if (!automatic && (value.intentCallId !== null || value.matchedBy !== null || value.adoptedIntents.length || value.ruleEvaluation !== null)) invalid('A user entry cannot claim model or rule predictions');
  if (automatic && value.status === null) invalid('An automatic route needs its semantic status');
  if (automatic && ['simple', 'agent'].includes(value.route) && (value.status !== 'RESOLVED' || !value.adoptedIntents.length)) invalid('Only resolved tasks may execute');
  const planned = ['medclaw.intent-policy/v4', 'medclaw.intent-policy/v5'].includes(value.policyVersion) && automatic;
  if (planned && value.status === 'RESOLVED' && (value.route !== 'simple' || !value.executionPlan)) invalid('Resolved v4 tasks require a deterministic plan');
  if (value.executionPlan && (!planned || value.route !== 'simple' || value.executionPlan.steps.length !== value.adoptedIntents.length
    || value.executionPlan.steps.some((step, index) => step.stepId !== value.adoptedIntents[index]!.id
      || JSON.stringify(step.dependsOn) !== JSON.stringify(value.adoptedIntents[index]!.dependsOn)))) invalid('Plan must cover the exact adopted tasks');
  if (value.route === 'simple' && (value.status !== 'RESOLVED' || !value.executionPlan && (value.queryParams === null || automatic && value.adoptedIntents.length !== 1))) invalid('Simple requires a resolved query or complete plan');
  if (value.executionPlan) {
    const queries = value.executionPlan.steps.flatMap(step => step.queries);
    const single = value.executionPlan.steps.length === 1 && queries.length === 1;
    if (single ? JSON.stringify(value.queryParams) !== JSON.stringify(queries[0]) : value.queryParams !== null) invalid('Single QueryParams must match the plan; other plans have no single QueryParams');
  }
  if (value.route !== 'simple' && value.queryParams !== null) invalid('Only simple stores compiled QueryParams');
  if (value.route === 'reject' && value.status !== 'OUT_OF_SCOPE') invalid('Rejection is reserved for out of scope');
  if (value.route === 'clarify' && !['AMBIGUOUS', 'NEED_PARAMETERS', 'UNSUPPORTED_DATA'].includes(value.status ?? '')) invalid('Clarification needs a nonexecutable business status');
  if ((value.contextIntentId === null) !== (value.adoptedSlots === null)) invalid('Adopted context ID and slots must be paired');
  if (value.contextIntentId !== null && value.adoptedSlots !== null && !hasAdoptedQuery({ taskIntents: value.adoptedIntents, contextIntentId: value.contextIntentId, adoptedSlots: value.adoptedSlots })) invalid('Adopted conditions must exactly match the selected task');
  if (value.decisionSource === 'explicit_agent_fallback' && (value.route !== 'agent' || value.status !== null || value.contextIntentId !== null)) invalid('Explicit fallback starts an Agent without adopting a failed prediction');
  if (value.decisionSource === 'user_form' && (value.route !== 'simple' || value.status !== 'RESOLVED'
    || value.contextIntentId !== null || value.adoptedSlots !== null || value.missingSlots.length || value.issues.length)) invalid('A form requires its complete query without predictions');
});
export type IntentDecision = z.infer<typeof IntentDecisionSchema>;
export const IntentStepResultSchema = z.strictObject({
  stepId, queryRefs: z.array(z.strictObject({ queryId: PositiveIdSchema, resultHash: ResourceHashSchema }))
    .refine(refs => new Set(refs.map(ref => ref.queryId)).size === refs.length, 'Duplicate Query references'),
  metadata: z.lazy(() => IntentStepMetadataSchema).optional(),
});
export type IntentStepResult = z.infer<typeof IntentStepResultSchema>;
export const IntentExecutionFactSchema = z.strictObject({
  contract: z.literal('medclaw.intent-execution/v1'), decisionId: PositiveIdSchema,
  taskIntents: IntentItemsSchema, stepResults: z.array(IntentStepResultSchema).max(8),
}).refine(value => new Set(value.stepResults.map(item => item.stepId)).size === value.stepResults.length
  && value.stepResults.every(item => value.taskIntents.some(intent => intent.id === item.stepId)), 'Step results require a unique known task');
export type IntentExecutionFact = z.infer<typeof IntentExecutionFactSchema>;
export const IntentAgentTaskSchema = z.strictObject({ contract: z.literal('medclaw.intent-task/v1'),
  decisionId: PositiveIdSchema, taskIntents: IntentItemsSchema.refine(items => items.length > 0) });
export type IntentAgentTask = z.infer<typeof IntentAgentTaskSchema>;
export const IntentQueryStepInputSchema = z.strictObject({ stepId, part: z.number().int().min(0).max(63) });
export type IntentQueryStepInput = z.infer<typeof IntentQueryStepInputSchema>;
export type IntentAgentStepResult = { query: import('./query').QueryRecord } | { batches: import('./query').Batch[] };
export const IntentStepMetadataSchema=z.strictObject({stepId,part:z.literal(0),basis:z.literal('snapshot_date'),batches:z.array(z.lazy(()=>BatchSchema)).min(1)});

export const IntentVersionsSchema = z.strictObject({
  configVersion: ConfigVersionSchema,
  taxonomyVersion: z.literal(INTENT_VERSIONS.taxonomyVersion), ruleVersion: z.literal(INTENT_VERSIONS.ruleVersion),
  classifyPromptVersion: IntentClassifyPromptVersionSchema, verifyPromptVersion: IntentVerifyPromptVersionSchema,
  schemaVersion: z.literal(INTENT_VERSIONS.schemaVersion), policyVersion: IntentPolicyVersionSchema,
});
const groundingSource = {
  source: z.enum(['current_input','pending_task']), quote: z.string().min(1).max(256),
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
};
export const IntentGroundingFactSchema = z.discriminatedUnion('kind', [
  z.strictObject({...groundingSource,kind:z.literal('date'),time:TimeRangeSchema.nullable()}),
  z.strictObject({...groundingSource,kind:z.literal('status'),operation:z.enum(['set','clear','exclude']),value:IntentSlotsSchema.shape.status}),
  z.strictObject({...groundingSource,kind:z.literal('metric'),value:IntentSlotsSchema.shape.metric.unwrap()}),
  z.strictObject({...groundingSource,kind:z.literal('entity'),field:z.enum(['device','region','manufacturer','category','distributor']),value:label,deviceIds:queryIds.max(10000)}),
]);
export type IntentGroundingFact = z.infer<typeof IntentGroundingFactSchema>;
export const IntentGroundingSchema = z.strictObject({contract:z.literal('medclaw.intent-grounding/v1'),
  textHash:ResourceHashSchema,pendingTaskHash:ResourceHashSchema.nullable(),facts:z.array(IntentGroundingFactSchema).max(128)});
export const IntentInputProjectionSchema = z.strictObject({
  contract: z.literal('medclaw.intent-input/v2'), sessionId: PositiveIdSchema, inputId: PositiveIdSchema, runId: PositiveIdSchema,
  baseLeafId: OpaqueIdSchema.nullable(), baseStorageVersion: z.number().int().nonnegative().safe(),
  text: z.string().min(1).max(65536), referenceDate: ReferenceDateSchema, timezone: TimezoneSchema,
  scope: z.lazy(() => RunScopeSchema), scopeBatchHashes: hashes, previousQueryContext: QueryContextRecordSchema.nullable(),
  pendingClarification: PendingClarificationSchema.nullable(),
  recentTurns: z.array(z.strictObject({ nativeEntryId: OpaqueIdSchema, source: z.enum(['user', 'program', 'model']), text: z.string().max(4096) })).max(4),
  selectedEntities: z.array(z.strictObject({ deviceId: PositiveIdSchema, label })).max(10000),
  availableData: z.strictObject({ regions: z.array(label), dates: z.array(ReferenceDateSchema), currencies: uniqueLabels, units: uniqueLabels }),
  enabledL2: z.array(L2Schema).max(23).refine(values => new Set(values).size === values.length), availableToolNames: z.array(label).max(1000),
  versions: IntentVersionsSchema, grounding:IntentGroundingSchema.optional(),
}).refine(value => value.previousQueryContext === null || value.previousQueryContext.sessionId === value.sessionId, 'Previous context must belong to the frozen Session')
  .superRefine((value,ctx)=>{
    if(!value.grounding)return;
    if(!['medclaw.intent-policy/v4','medclaw.intent-policy/v5'].includes(value.versions.policyVersion))ctx.addIssue({code:'custom',message:'Grounding requires policy v4 or v5'});
    for(const fact of value.grounding.facts){
      const text=fact.source==='current_input'?value.text:value.pendingClarification?.taskText;
      if(text===undefined||fact.end<=fact.start||text.slice(fact.start,fact.end)!==fact.quote
        ||fact.kind==='status'&&(fact.operation==='clear'?fact.value!==null:fact.value===null))ctx.addIssue({code:'custom',message:'Grounding source or meaning is invalid'});
    }
  });
export type IntentInputProjection = z.infer<typeof IntentInputProjectionSchema>;
export const FrozenIntentAdmissionSchema = z.strictObject({
  contract: z.literal('medclaw.intent-admission/v1'), selection: z.lazy(() => IntentModelSelectionSchema),
  baseLeafId: OpaqueIdSchema.nullable(), baseStorageVersion: z.number().int().nonnegative().safe(),
  prompts: z.strictObject({
    classify: z.strictObject({ text: z.string().min(1).max(65536), hash: ResourceHashSchema, version: IntentClassifyPromptVersionSchema }),
    verify: z.strictObject({ text: z.string().min(1).max(65536), hash: ResourceHashSchema, version: IntentVerifyPromptVersionSchema }),
  }),
}).refine(value => value.selection.enabled, 'Intent admission requires enabled verified model configuration');
export type FrozenIntentAdmission = z.infer<typeof FrozenIntentAdmissionSchema>;
export const PrepareIntentInputSchema = z.strictObject({ runId: PositiveIdSchema,
  enabledL2: z.array(L2Schema).max(23).refine(values => new Set(values).size === values.length) });
export type PrepareIntentInput = z.infer<typeof PrepareIntentInputSchema>;
export const INTENT_STAGE_INPUT_BYTES = 24 * 1024;
export const IntentStageInputSchema = z.strictObject({
  input: IntentInputProjectionSchema, stage: IntentStageSchema,
  review: z.strictObject({ previousCallId: OpaqueIdSchema, prediction: IntentResultSchema.nullable(), rawHash: ResourceHashSchema,
    rawPreview: z.string().max(4096), issues: z.array(ValidationIssueSchema).max(64), candidates: z.array(IntentCandidateSchema).max(3),
    mode: z.enum(['candidate_selection', 'semantic_correction']).optional() }).nullable(),
}).refine(value => (value.stage === 'classify') === (value.review === null), 'Only verify contains a review')
  .refine(value => !value.review || (value.review.mode === 'semantic_correction'
    ? ['medclaw.intent-verify-prompt/v2','medclaw.intent-verify-prompt/v3','medclaw.intent-verify-prompt/v4'].includes(value.input.versions.verifyPromptVersion) && ['medclaw.intent-policy/v3','medclaw.intent-policy/v4','medclaw.intent-policy/v5'].includes(value.input.versions.policyVersion)
      && value.review.prediction !== null && value.review.candidates.length === 0 && value.review.issues.length > 0
      && value.review.issues.every(issue => issue.code === 'explicit_condition_conflict')
    : value.review.candidates.length > 0), 'Correction requires a complete prediction and only explicit conflicts; selection requires candidates')
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= INTENT_STAGE_INPUT_BYTES, 'Intent stage projection exceeds 24 KiB');
export type IntentStageInput = z.infer<typeof IntentStageInputSchema>;
export const IntentModelInspectionSchema = z.strictObject({
  contract: z.literal('medclaw.intent-model-inspection/v1'), checkedAt: TimestampSchema, available: z.boolean(),
  actualDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  metadata: z.strictObject({ serviceVersion: label.nullable(), family: label.nullable(), parameterSize: label.nullable(), quantization: label.nullable() }).nullable(),
  error: AppErrorSchema.nullable(),
});
export type IntentModelInspection = z.infer<typeof IntentModelInspectionSchema>;
export const IntentHttpObservationSchema = z.strictObject({
  contract: z.literal('medclaw.context-observation/v1'), api: z.literal('ollama-chat'), transport: z.literal('json'),
  observedAt: TimestampSchema, httpStatus: z.number().int().min(200).max(299),
  payloadHash: ResourceHashSchema, projectionHash: ResourceHashSchema, feedbackHash: ResourceHashSchema,
  verifiedNativeRefs: z.array(z.strictObject({ kind: z.enum(['input', 'tool_result']), id: PositiveIdSchema, contentHash: ResourceHashSchema })).max(1000),
});
export type IntentHttpObservation = z.infer<typeof IntentHttpObservationSchema>;
const tokens = z.number().int().nonnegative().safe().nullable();
export const IntentHttpOutcomeSchema = z.strictObject({
  transportState: z.enum(['completed', 'failed', 'cancelled']), rawOutput: z.string().max(65536).nullable(), rawOutputTruncated: z.boolean(),
  responseModel: label.nullable(), doneReason: label.nullable(), httpStatus: z.number().int().min(100).max(599).nullable(), observation: IntentHttpObservationSchema.nullable(),
  startedAt: TimestampSchema, endedAt: TimestampSchema, durationMs: z.number().finite().nonnegative(), inputTokens: tokens, outputTokens: tokens,
  serverTotalDurationNs: tokens, error: AppErrorSchema.nullable(),
});
export type IntentHttpOutcome = z.infer<typeof IntentHttpOutcomeSchema>;
export interface IntentModelClient {
  readonly prompts: Readonly<Record<'classify' | 'verify', Readonly<{ text: string; hash: string; version: string }>>>;
  inspect(configuration: import('./model').IntentModelConfiguration, signal?: AbortSignal): Promise<IntentModelInspection>;
  recognizeIntent(input: IntentStageInput, selection: IntentModelSelection, signal: AbortSignal,
    onDelivered: (fact: IntentHttpObservation) => Promise<void>): Promise<IntentHttpOutcome>;
}
export const IntentReadResultSchema = z.strictObject({
  contract: z.literal('medclaw.intent-read/v2'), runId: PositiveIdSchema, sessionId: PositiveIdSchema, inputId: PositiveIdSchema,
  ruleEvaluation: RuleEvaluationSchema.nullable(),
  calls: z.array(z.strictObject({ id: PositiveIdSchema, callId: OpaqueIdSchema, intentCallId: OpaqueIdSchema,
    stage: IntentStageSchema, previousCallId: OpaqueIdSchema.nullable(), state: z.enum(['started', 'completed', 'failed', 'cancelled']),
    model: z.lazy(() => IntentModelSelectionSchema), snapshotId: PositiveIdSchema, startedAt: TimestampSchema, endedAt: TimestampSchema.nullable(), error: AppErrorSchema.nullable(),
    prediction: IntentResultSchema.nullable(), rawOutput: z.strictObject({ text: z.string().max(65536), truncated: z.boolean() }).nullable(), validation: IntentValidationSchema.nullable(),
  })).max(2),
  decision: IntentDecisionSchema.safeExtend({ id: PositiveIdSchema, createdAt: TimestampSchema }).nullable(),
  execution: z.strictObject({ runStatus: z.lazy(() => RunStatusSchema), queryIds, stepResults: z.array(IntentStepResultSchema).max(8),
    answerId: PositiveIdSchema.nullable(), finalHistorySaved: z.boolean(), requiredPersistenceComplete: z.boolean().nullable() }),
  effectiveContext: QueryContextRecordSchema.nullable(),
}).superRefine((value, ctx) => {
  if (value.calls.some((call, index) => call.intentCallId !== call.callId || (index === 0
    ? call.stage !== 'classify' || call.previousCallId !== null
    : call.stage !== 'verify' || call.previousCallId !== value.calls[0]!.callId))) ctx.addIssue({ code: 'custom', message: 'Calls must preserve their public identity and stage chain' });
  if (value.decision?.intentCallId && !value.calls.some(call => call.callId === value.decision!.intentCallId)) ctx.addIssue({ code: 'custom', message: 'Adopted call must belong to this Run' });
  if (value.effectiveContext && value.effectiveContext.sessionId !== value.sessionId) ctx.addIssue({ code: 'custom', message: 'Context owner mismatch' });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 3 * 1024 * 1024) ctx.addIssue({ code: 'custom', message: 'Intent result exceeds IPC limit' });
});
export type IntentReadResult = z.infer<typeof IntentReadResultSchema>;

export const IntentCallRegistrationSchema = z.strictObject({
  callId: OpaqueIdSchema, runId: PositiveIdSchema, sessionId: PositiveIdSchema, inputId: PositiveIdSchema, snapshotId: PositiveIdSchema,
  selection: z.lazy(() => IntentModelSelectionSchema), input: IntentStageInputSchema, stage: IntentStageSchema,
  previousCallId: OpaqueIdSchema.nullable(), createdAt: TimestampSchema,
}).refine(value => value.selection.enabled && value.runId === value.input.input.runId && value.sessionId === value.input.input.sessionId
  && value.inputId === value.input.input.inputId && value.stage === value.input.stage
  && value.selection.configVersion === value.input.input.versions.configVersion
  && value.previousCallId === (value.input.review?.previousCallId ?? null), 'Registration must preserve the admitted owner, stage and enabled selection');
export type IntentCallRegistration = z.infer<typeof IntentCallRegistrationSchema>;
export const IntentCallCompletionSchema = z.strictObject({
  callId: OpaqueIdSchema, runId: PositiveIdSchema, sessionId: PositiveIdSchema, inputId: PositiveIdSchema, stage: IntentStageSchema,
  state: z.enum(['completed', 'failed', 'cancelled']), outcome: IntentHttpOutcomeSchema,
  parsed: IntentResultSchema.nullable(), validation: IntentValidationSchema,
});
export type IntentCallCompletion = z.infer<typeof IntentCallCompletionSchema>;
export const RouteCommitSchema = z.strictObject({
  runId: PositiveIdSchema, sessionId: PositiveIdSchema, inputId: PositiveIdSchema, decision: IntentDecisionSchema,
  expectedCancelEpoch: z.number().int().nonnegative().safe(), createdAt: TimestampSchema,
});
export type RouteCommit = z.infer<typeof RouteCommitSchema>;
export interface IntentStore {
  prepareIntentInput(input: PrepareIntentInput): IntentInputProjection;
  registerIntentCall(input: IntentCallRegistration): { modelCallPk: number; intentCallPk: number };
  finishIntentCall(input: IntentCallCompletion): void;
  commitRoute(input: RouteCommit): { decisionId: number };
  readIntent(input: ReadIntentInput): IntentReadResult | null;
}

export const ProductResultDetailsSchema = z.strictObject({ contract: z.literal('medclaw.product-result/v1'), source: z.enum(['program', 'user_form']),
  runId: PositiveIdSchema, inputId: PositiveIdSchema, decisionId: PositiveIdSchema,
  kind: z.enum(['result', 'clarification', 'out_of_scope', 'insufficient_evidence']), queryIds,
  missingSlots: uniqueLabels }).refine(value => value.source !== 'user_form'
    || value.kind === 'result' && value.queryIds.length === 1 && value.missingSlots.length === 0, 'A form result requires its one Query');
export type ProductResultDetails = z.infer<typeof ProductResultDetailsSchema>;
export type ProductTurnResult = Pick<ProductResultDetails, 'kind' | 'queryIds' | 'missingSlots'> & { text: string };
export type ProductTurnOwner = {
  runId: number; sessionId: number; inputId: number;
  baseLeafId: string | null; baseStorageVersion: number; occurredAt: string;
};
const productTurnFields = {
  runId: PositiveIdSchema, sessionId: PositiveIdSchema, inputId: PositiveIdSchema,
  baseLeafId: OpaqueIdSchema.nullable(), baseStorageVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  occurredAt: TimestampSchema, execution: IntentExecutionFactSchema, adoptedContext: AdoptedContextFactSchema.nullable(),
};
export const ProductTurnInputSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...productTurnFields, mode: z.literal('program'), text: z.string().refine(value => value.trim().length > 0),
    decisionId: PositiveIdSchema, result: z.strictObject({ kind: ProductResultDetailsSchema.shape.kind, text: z.string().min(1), queryIds, missingSlots: uniqueLabels }) }),
  z.strictObject({ ...productTurnFields, mode: z.literal('agent_task') }),
  z.strictObject({ ...productTurnFields, mode: z.literal('user_form'), text: z.string().min(1), decisionId: PositiveIdSchema,
    result: z.strictObject({ kind: z.literal('result'), text: z.string().min(1), queryIds: queryIds.length(1), missingSlots: uniqueLabels.length(0) }),
    execution: FormExecutionFactSchema, adoptedContext: FormContextFactSchema }),
]).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.mode === 'user_form') {
    if (value.decisionId !== value.execution.decisionId || value.adoptedContext.decisionId !== value.decisionId
      || value.adoptedContext.sourceRunId !== value.runId || value.adoptedContext.sourceInputId !== value.inputId
      || value.result.queryIds[0] !== value.execution.queryId || value.adoptedContext.queryIds[0] !== value.execution.queryId) invalid('Form evidence must belong to its exact input and Query');
    return;
  }
  const refs = new Set(value.execution.stepResults.flatMap(step => step.queryRefs.map(ref => ref.queryId)));
  if (value.mode === 'program' && (value.decisionId !== value.execution.decisionId
    || value.result.queryIds.length !== refs.size || value.result.queryIds.some(id => !refs.has(id)))) invalid('Program result must reference its exact decision and executed Queries');
  const adopted = value.adoptedContext;
  if (adopted && (adopted.sourceRunId !== value.runId || adopted.sourceInputId !== value.inputId || adopted.decisionId !== value.execution.decisionId
    || JSON.stringify(adopted.taskIntents) !== JSON.stringify(value.execution.taskIntents) || adopted.queryIds.some(id => !refs.has(id)))) invalid('Adopted context must belong to this product execution');
});
export type ProductTurnInput = z.infer<typeof ProductTurnInputSchema>;
export type ProductTurnDiscardProof = {
  runId: number; sessionId: number; requestSettled: true; routeSettled: true; requiredFactsSaved: true;
  committedSnapshot: import('./session').NativeHistorySnapshot;
};
export type ProductTurnFact = {
  userEntryId: string | null; resultEntryId: string | null; executionEntryId: string; conditionEntryId: string | null;
  history: import('./session').NativeHistoryCommit;
};
export const ProductSettlementSchema = z.strictObject({ contract: z.literal('medclaw.product-settlement/v1'),
  basis:z.literal('product_history'),nativeUserEntryId:OpaqueIdSchema.nullable(),
  runId: PositiveIdSchema, sessionId: PositiveIdSchema, inputId: PositiveIdSchema,
  admissionClosed: z.literal(true), requestSettled: z.literal(true), routeSettled: z.literal(true),
  requiredFactsSaved: z.literal(true), pendingFactsEmpty: z.literal(true) });
export type ProductSettlement = z.infer<typeof ProductSettlementSchema>;
