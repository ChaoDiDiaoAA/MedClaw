import { INTENT_TAXONOMY, IntentResultSchema, IntentSlotsSchema, type IntentItem, type L2 } from '../../../packages/contracts/src/intent.ts';
import type { Target } from '../../src/independent-gold.ts';

export const intentMetrics = {
  'intent.json':'intent_json_validity','intent.macro_f1':'intent_macro_f1','intent.slots_exact':'intent_slots_exact',
  'intent.clarify_recall':'intent_clarify_recall','intent.refusal_recall':'intent_refusal_recall',
  'intent.false_refusal':'intent_false_refusal','intent.route_exact':'intent_route_exact',
} as const;
const nextDay = (day: string) => new Date(Date.parse(day) + 86400000).toISOString().slice(0,10);
export function authorIntent(target: Target, alias: string, previous?: Target) {
  const time = target.start ? {start:target.start,endExclusive:target.endExclusive!} : target.date ? {start:target.date,endExclusive:nextDay(target.date)} :
    target.missing?.includes('deviceIdentity') ? {start:'2026-10-02',endExclusive:'2026-10-03'} : null;
  const slots = IntentSlotsSchema.parse({time,region:target.region ?? null,manufacturer:target.manufacturer ?? null,device:target.device ?? null,category:target.category ?? null,
    changeKind:['price','status','distributor'].includes(target.op)?'field_changed':target.op==='events'?'added':null,
    changeField:['price','status','distributor'].includes(target.op)?target.op as 'price'|'status'|'distributor':null,
    direction:target.threshold?'decrease':null,threshold:target.threshold?{operator:target.threshold.operator,value:target.threshold.percent/100}:null,
    status:target.status ?? null,distributor:null,metric:target.metric ?? null,groupBy:target.group ?? (target.op==='trend'?'date':null),topN:null,sort:null});
  let l2: L2 = target.manufacturer ? 'COMPANY_PRODUCTS' : target.device || target.op==='clarify' && target.missing?.includes('deviceIdentity') ? 'PRODUCT_DETAIL' : 'PRODUCT_SEARCH';
  if (['price','status','distributor'].includes(target.op) || target.op==='clarify' && target.missing?.includes('time')) l2=target.threshold?'PRICE_ANOMALY':'FIELD_CHANGES';
  if (target.op==='events') l2='NEW_RECORDS';
  if (target.op==='aggregate') l2=target.group==='region'?'REGION_STATS':'CATEGORY_STATS';
  if (target.op==='trend') l2='PRICE_TREND';
  if (target.missing?.includes('certificateExpiry')) l2='CERT_LOOKUP';
  const parameters = l2==='PRICE_ANOMALY'?{method:'explicit_threshold' as const}:l2==='CERT_LOOKUP'?{certificateNumber:null}:{};
  const item = {id:'s1',...INTENT_TAXONOMY[l2],l2,slots,parameters,dependsOn:[],resultRef:null};
  const {definition: _, ...task} = item;
  const needsEntity = target.op==='clarify' && target.missing?.includes('deviceIdentity');
  // The recorded taxonomy has no missing-record, overall-total, count-trend or status-group L2.
  const unregistered=false;
  const disabled = target.op==='unsupported'||target.region==='陕西';
  const status = target.op==='refuse'?'OUT_OF_SCOPE':target.op==='clarify'?(needsEntity?'AMBIGUOUS':'NEED_PARAMETERS'):target.op==='unsupported'||unregistered||disabled?'UNSUPPORTED_DATA':'RESOLVED';
  const missingSlots = target.missing ?? [];
  const tasks:any[]=unregistered?[]:[task];
  const prediction = IntentResultSchema.parse({contract:'medclaw.intent/v2',status,intents:status==='OUT_OF_SCOPE'||needsEntity?[]:tasks,
    candidateIntents:needsEntity?[{intents:[task],reasonCode:'confusable_pair'}]:[],
    clarification:target.op==='clarify'?{question:'请明确缺失条件。',intentIds:['s1'],missingSlots,options:needsEntity?['SYN-ZJ-A','SYN-ZJ-B']:[]}:null});
  const route = status==='OUT_OF_SCOPE'?'reject':status!=='RESOLVED'||disabled?'clarify':'simple';
  const conditions=intentConditions(target);
  const changes=['price','status','distributor','events'].includes(target.op)||['change_count','changed_device_count'].includes(target.metric??'');
  const queryContracts=status==='RESOLVED'&&!disabled?prediction.intents.map(intent=>({kind:target.op==='aggregate'?'aggregate':target.op==='trend'?'trend':changes?'changes':'current',population:changes?'changes':'snapshot',snapshotMode:changes?null:target.asOf?'as_of':'exact_date',changeKind:intent.slots.changeKind,changeField:intent.slots.changeField,direction:intent.slots.direction,metric:intent.slots.metric,groupBy:intent.slots.groupBy,topN:intent.slots.topN,sort:intent.slots.sort??'asc',distributor:intent.slots.distributor,status:intent.slots.status})):[];
  return {contract:'medclaw-intent-gold/v1',stageAlias:alias,prediction,
    program:{status:disabled?'UNSUPPORTED_DATA':status,missingSlots:status==='NEED_PARAMETERS'?missingSlots:[],allowedRoutes:[route],target,conditions,queryContracts,queryAllowed:status==='RESOLVED'&&!disabled,
      plan:prediction.intents.map((intent: IntentItem)=>({l2:intent.l2,slots:intent.slots,parameters:intent.parameters})),snapshotMode:target.asOf?'as_of':'exact_date'},
    clarification:{missingSlots,allowed:target.op==='clarify',options:needsEntity?['SYN-ZJ-A','SYN-ZJ-B']:[]},
    context:{sourceAlias:previous?'turn-'+(Number(alias.split('-').at(-1))-1):null,previousTarget:previous??null,effectiveTarget:target,
      clearedFields:previous?Object.keys(previous).filter(key=>!Object.hasOwn(target,key)):[]},
    method:'Independent authored user-goal annotation, prior user targets, original CSV and medclaw.intent/v2 taxonomy. Free question wording and local task identifiers are excluded from exact business comparison.'};
}
export function intentConditions(target:Target) {
  const changes=['price','status','distributor','events'].includes(target.op)||['change_count','changed_device_count'].includes(target.metric??'');
  return {region:target.region??null,regions:target.regions??null,date:target.date??null,start:target.start??null,endExclusive:target.endExclusive??null,sourceDeviceId:target.device??null,manufacturer:target.manufacturer??null,category:target.category??null,status:target.status??null,snapshotMode:changes?null:target.asOf?'as_of':'exact_date',threshold:target.threshold??null};
}
