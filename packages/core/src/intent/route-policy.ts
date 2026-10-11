import { IntentDecisionSchema, IntentResultSchema, IntentValidationSchema, RuleEvaluationSchema, IntentStageSchema,
  type IntentDecision, type IntentInputProjection, type IntentResult, type IntentValidation, type RuleEvaluation, type IntentItem, type IntentQueryPlan } from '../../../contracts/src/intent';
import { createQuerySchemas, BUSINESS_RULES, type QueryParams } from '../../../contracts/src/query';
import { INTENT_VERSIONS } from '../../../contracts/src/model';
import { INTENT_CAPABILITIES } from './taxonomy';

export type IntentDecisionSource = { rule: RuleEvaluation } | { stage: 'classify' | 'verify'; callId: string };
export function compileIntentQuery(item: IntentItem, input: IntentInputProjection, deviceIds: number[], inheritedSnapshotMode:'exact_date'|'as_of'|null=null): QueryParams | null {
  const kind = INTENT_CAPABILITIES[item.l2].queryKind;
  if (kind === null) return null;
  return compileQuery(item,input,deviceIds,kind,inheritedSnapshotMode);
}
function compileQuery(item:IntentItem,input:IntentInputProjection,deviceIds:number[],kind:QueryParams['kind'],inheritedSnapshotMode:'exact_date'|'as_of'|null=null):QueryParams {
  const { device: _device, ...slots } = item.slots;
  const population = kind === 'changes' || ['change_count', 'changed_device_count'].includes(slots.metric ?? '') ? 'changes' : 'snapshot';
  return createQuerySchemas().QueryParamsSchema.parse({ ...slots, kind, population,
    snapshotMode: population === 'snapshot' ? kind==='trend'?'exact_date':inheritedSnapshotMode??'exact_date' : null, batchIds: input.scope.batchIds,
    deviceIds: deviceIds.length ? deviceIds : null,
    changeKind: item.l2 === 'PRICE_ANOMALY' ? 'field_changed' : slots.changeKind,
    changeField: item.l2 === 'PRICE_ANOMALY' ? 'price' : slots.changeField,
    sort: slots.sort ?? BUSINESS_RULES.querySort, page: BUSINESS_RULES.defaultPage, pageSize: BUSINESS_RULES.defaultPageSize });
}
export function compileIntentStepQueries(item:IntentItem,input:IntentInputProjection,deviceIds:number[],inheritedSnapshotMode:'exact_date'|'as_of'|null=null):QueryParams[] {
  const direct=compileIntentQuery(item,input,deviceIds,inheritedSnapshotMode);if(direct)return [direct];
  if(item.l2==='PRODUCT_DETAIL')return [compileQuery(item,input,deviceIds,'current',inheritedSnapshotMode)];
  if(item.l2==='FRESHNESS')return [];
  const summarize=(task:IntentItem,ids:number[],period=false)=>{
    const changes=['change_count','changed_device_count'].includes(task.slots.metric??'');
    const grid=!changes&&(period||task.slots.time!==null&&Date.parse(task.slots.time.endExclusive)-Date.parse(task.slots.time.start)>86400000);
    return compileQuery({...task,slots:{...task.slots,groupBy:grid?'date':task.slots.groupBy}},input,ids,grid?'trend':'aggregate',inheritedSnapshotMode);
  };
  if(item.l2==='COMPANY_COMPARE')return item.parameters.manufacturers.map(manufacturer=>summarize({...item,slots:{...item.slots,manufacturer}},deviceIds));
  if(item.l2==='PRODUCT_COMPARE') {
    if(deviceIds.length!==item.parameters.devices.length)throw new Error('intent_output_invalid');
    return deviceIds.map(id=>item.slots.metric===null?compileQuery(item,input,[id],'current',inheritedSnapshotMode):summarize(item,[id]));
  }
  if(item.l2==='PERIOD_COMPARE')return item.parameters.periods.map(time=>summarize({...item,slots:{...item.slots,time}},deviceIds,true));
  throw new Error('intent_output_invalid');
}
export function decideIntentRoute(raw: IntentResult, checked: IntentValidation, input: IntentInputProjection, source: IntentDecisionSource,inheritedSnapshotMode:'exact_date'|'as_of'|null=null): IntentDecision {
  IntentResultSchema.parse(raw); const validation = IntentValidationSchema.parse(checked);
  if (validation.state !== 'valid' || validation.finalStatus === null || validation.reviewRequired || validation.rawOutputTruncated) throw new Error('intent_output_invalid');
  const rule = 'rule' in source ? RuleEvaluationSchema.parse(source.rule) : null;
  if (rule?.outcome !== undefined && rule.outcome !== 'hit') throw new Error('state_conflict');
  if ('stage' in source) IntentStageSchema.parse(source.stage);
  const status = validation.finalStatus, intents = validation.adoptedIntents, first = intents[0];
  let route: IntentDecision['route'] = status === 'OUT_OF_SCOPE' ? 'reject' : status === 'RESOLVED' ? 'agent' : 'clarify', queryParams: QueryParams | null = null;
  if (status === 'RESOLVED' && intents.length === 1 && first && INTENT_CAPABILITIES[first.l2].queryKind !== null) {
    queryParams = compileIntentQuery(first, input, validation.resolvedDeviceIds.find(value => value.intentId === first.id)?.deviceIds ?? [],inheritedSnapshotMode);
    route = 'simple';
  }
  let executionPlan: IntentQueryPlan | undefined;
  if (status === 'RESOLVED' && ['medclaw.intent-policy/v4', 'medclaw.intent-policy/v5'].includes(input.versions.policyVersion)) {
    executionPlan = { contract: 'medclaw.intent-query-plan/v1', steps: intents.map(item => ({ stepId: item.id, dependsOn: item.dependsOn,
      queries: compileIntentStepQueries(item, input, validation.resolvedDeviceIds.find(value => value.intentId === item.id)?.deviceIds ?? [], inheritedSnapshotMode),
      metadata: item.l2 === 'FRESHNESS' ? { basis: 'snapshot_date', region: item.slots.region } : null })) };
    route = 'simple';
    queryParams = executionPlan.steps.length === 1 && executionPlan.steps[0]!.queries.length === 1 ? executionPlan.steps[0]!.queries[0]! : null;
  }
  const queryIntents = intents.filter(item => item.l1 !== 'RESULT_DELIVERY'), context = queryIntents.length === 1 ? queryIntents[0]! : null;
  return IntentDecisionSchema.parse({ intentCallId: 'callId' in source ? source.callId : null,
    matchedBy: rule ? 'rule' : 'stage' in source && source.stage === 'verify' ? 'paper_enhanced' : 'qwen_prompt', route, status,
    adoptedIntents: intents, contextIntentId: context?.id ?? null, adoptedSlots: context?.slots ?? null, queryParams,
    missingSlots: validation.missingSlots, issues: validation.issues, ruleEvaluation: rule,
    ...(executionPlan ? { executionPlan } : {}),
    decisionSource: rule ? 'deterministic_rule' : 'validated_model', schemaVersion: input.versions.schemaVersion, policyVersion: input.versions.policyVersion });
}
