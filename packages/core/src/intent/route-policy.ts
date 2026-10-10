import { IntentDecisionSchema, IntentResultSchema, IntentValidationSchema, RuleEvaluationSchema, IntentStageSchema,
  type IntentDecision, type IntentInputProjection, type IntentResult, type IntentValidation, type RuleEvaluation, type IntentItem } from '../../../contracts/src/intent';
import { createQuerySchemas, BUSINESS_RULES, type QueryParams } from '../../../contracts/src/query';
import { INTENT_VERSIONS } from '../../../contracts/src/model';
import { INTENT_CAPABILITIES } from './taxonomy';

export type IntentDecisionSource = { rule: RuleEvaluation } | { stage: 'classify' | 'verify'; callId: string };
export function compileIntentQuery(item: IntentItem, input: IntentInputProjection, deviceIds: number[]): QueryParams | null {
  const kind = INTENT_CAPABILITIES[item.l2].queryKind;
  if (kind === null) return null;
  return compileQuery(item,input,deviceIds,kind);
}
function compileQuery(item:IntentItem,input:IntentInputProjection,deviceIds:number[],kind:QueryParams['kind']):QueryParams {
  const { device: _device, ...slots } = item.slots;
  const population = kind === 'changes' || ['change_count', 'changed_device_count'].includes(slots.metric ?? '') ? 'changes' : 'snapshot';
  return createQuerySchemas().QueryParamsSchema.parse({ ...slots, kind, population,
    snapshotMode: population === 'snapshot' ? 'exact_date' : null, batchIds: input.scope.batchIds,
    deviceIds: deviceIds.length ? deviceIds : null,
    changeKind: item.l2 === 'PRICE_ANOMALY' ? 'field_changed' : slots.changeKind,
    changeField: item.l2 === 'PRICE_ANOMALY' ? 'price' : slots.changeField,
    sort: slots.sort ?? BUSINESS_RULES.querySort, page: BUSINESS_RULES.defaultPage, pageSize: BUSINESS_RULES.defaultPageSize });
}
export function compileIntentStepQueries(item:IntentItem,input:IntentInputProjection,deviceIds:number[]):QueryParams[] {
  const direct=compileIntentQuery(item,input,deviceIds);if(direct)return [direct];
  if(item.l2==='PRODUCT_DETAIL')return [compileQuery(item,input,deviceIds,'current')];
  if(item.l2==='FRESHNESS')return [];
  const summarize=(task:IntentItem,ids:number[],period=false)=>{
    const changes=['change_count','changed_device_count'].includes(task.slots.metric??'');
    const grid=!changes&&(period||task.slots.time!==null&&Date.parse(task.slots.time.endExclusive)-Date.parse(task.slots.time.start)>86400000);
    return compileQuery({...task,slots:{...task.slots,groupBy:grid?'date':task.slots.groupBy}},input,ids,grid?'trend':'aggregate');
  };
  if(item.l2==='COMPANY_COMPARE')return item.parameters.manufacturers.map(manufacturer=>summarize({...item,slots:{...item.slots,manufacturer}},deviceIds));
  if(item.l2==='PRODUCT_COMPARE') {
    if(deviceIds.length!==item.parameters.devices.length)throw new Error('intent_output_invalid');
    return deviceIds.map(id=>item.slots.metric===null?compileQuery(item,input,[id],'current'):summarize(item,[id]));
  }
  if(item.l2==='PERIOD_COMPARE')return item.parameters.periods.map(time=>summarize({...item,slots:{...item.slots,time}},deviceIds,true));
  throw new Error('intent_output_invalid');
}
export function decideIntentRoute(raw: IntentResult, checked: IntentValidation, input: IntentInputProjection, source: IntentDecisionSource): IntentDecision {
  IntentResultSchema.parse(raw); const validation = IntentValidationSchema.parse(checked);
  if (validation.state !== 'valid' || validation.finalStatus === null || validation.reviewRequired || validation.rawOutputTruncated) throw new Error('intent_output_invalid');
  const rule = 'rule' in source ? RuleEvaluationSchema.parse(source.rule) : null;
  if (rule?.outcome !== undefined && rule.outcome !== 'hit') throw new Error('state_conflict');
  if ('stage' in source) IntentStageSchema.parse(source.stage);
  const status = validation.finalStatus, intents = validation.adoptedIntents, first = intents[0];
  let route: IntentDecision['route'] = status === 'OUT_OF_SCOPE' ? 'reject' : status === 'RESOLVED' ? 'agent' : 'clarify', queryParams: QueryParams | null = null;
  if (status === 'RESOLVED' && intents.length === 1 && first && INTENT_CAPABILITIES[first.l2].queryKind !== null) {
    queryParams = compileIntentQuery(first, input, validation.resolvedDeviceIds.find(value => value.intentId === first.id)?.deviceIds ?? []);
    route = 'simple';
  }
  const queryIntents = intents.filter(item => item.l1 !== 'RESULT_DELIVERY'), context = queryIntents.length === 1 ? queryIntents[0]! : null;
  return IntentDecisionSchema.parse({ intentCallId: 'callId' in source ? source.callId : null,
    matchedBy: rule ? 'rule' : 'stage' in source && source.stage === 'verify' ? 'paper_enhanced' : 'qwen_prompt', route, status,
    adoptedIntents: intents, contextIntentId: context?.id ?? null, adoptedSlots: context?.slots ?? null, queryParams,
    missingSlots: validation.missingSlots, issues: validation.issues, ruleEvaluation: rule,
    decisionSource: rule ? 'deterministic_rule' : 'validated_model', schemaVersion: INTENT_VERSIONS.schemaVersion, policyVersion: INTENT_VERSIONS.policyVersion });
}
