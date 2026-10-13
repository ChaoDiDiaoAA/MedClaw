import { INTENT_TAXONOMY, IntentResultSchema } from '../../../packages/contracts/src/intent.ts';
import { equal, ratio, record, unknown } from './rules.ts';
import type { CheckSpec, RuleResult } from './types.ts';

export function intentJson(_expected: unknown, actual: unknown, check: CheckSpec): RuleResult {
  if (!record(actual) || typeof actual.raw !== 'string' || typeof actual.stage !== 'string' || !['classify', 'verify'].includes(actual.stage) || typeof actual.callId !== 'string') return unknown('Original raw intent output, stage, and call identity are required');
  let value: unknown;
  try { value = JSON.parse(actual.raw); } catch { return ratio(0, 1, check, { stage: actual.stage, callId: actual.callId }); }
  return ratio(Number(IntentResultSchema.safeParse(value).success), 1, check, { stage: actual.stage, callId: actual.callId });
}
export function intentExact(expected: unknown, actual: unknown, check: CheckSpec): RuleResult {
  if (!record(expected) || !record(actual) || !['classify', 'verify'].includes(actual.stage) || typeof actual.callId !== 'string' || !Object.hasOwn(actual, 'prediction')) return unknown('Independent intent Gold and original stage prediction are required');
  if (!IntentResultSchema.safeParse(expected.prediction).success) return unknown('Independent intent Gold does not satisfy medclaw.intent/v2');
  return ratio(Number(equal(expected.prediction, actual.prediction)), 1, check, { stage: actual.stage, callId: actual.callId });
}

/** Compare business structure; task IDs and clarification prose are not classification labels. */
export function intentBusiness(value: any) {
  const normalize = (items: any[]) => items.map((item,index) => ({l0:item.l0,l1:item.l1,l2:item.l2,slots:item.slots,parameters:item.parameters,
    dependsOn:item.dependsOn.map((id:string)=>items.findIndex(other=>other.id===id)),
    resultRef:item.resultRef && 'stepId' in item.resultRef?{step:items.findIndex(other=>other.id===item.resultRef.stepId)}:item.resultRef?{query:'existing'}:null}));
  return {status:value.status,intents:normalize(value.intents??[]),candidates:(value.candidateIntents??[]).map((candidate:any)=>normalize(candidate.intents)),
    missingSlots:intentMissing(value),options:[...(value.clarification?.options??[])].sort()};
}
export function intentMissing(value:any) {
  return [...(value.missingSlots??value.clarification?.missingSlots??[])].map((slot:string)=>{
    const prefix=[...(value.intents??[]),...(value.candidateIntents??[]).flatMap((candidate:any)=>candidate.intents)].find((item:any)=>slot.startsWith(item.id+'.'));
    return prefix?slot.slice(prefix.id.length+1):slot;
  }).sort();
}
export function intentStageScore(expected: unknown, actual: unknown, check: CheckSpec): RuleResult {
  if(record(expected)&&record(expected.program)&&expected.program.queryKind) {
    if(!record(actual)||actual.conditions===undefined||!Array.isArray(actual.queryKinds))return unknown('Actual adopted route and independently checked query conditions required');
    return ratio(Number(actual.status===expected.program.status&&expected.program.allowedRoutes.includes(actual.route)&&equal(actual.conditions,expected.program.conditions)&&actual.queryKinds.length>0&&actual.queryKinds.every((kind:string)=>kind===expected.program.queryKind)&&actual.planVerified===true),1,check);
  }
  if (!record(expected)||!record(expected.prediction)||!record(expected.program)||!record(actual)||!Array.isArray(actual.channels)) return unknown('Independent intent annotation and original stage channels are required');
  if(actual.channels.some((channel:any)=>!record(channel)||!['classify','verify','adopted'].includes(channel.channel))||new Set(actual.channels.map((channel:any)=>channel.channel)).size!==actual.channels.length)return unknown('Duplicate or unknown intent stage identity',1);
  const observed=[...actual.channels];
  for(const channel of ['classify','adopted',...(actual.verifyRequired?['verify']:[])])if(!observed.some((item:any)=>item.channel===channel))observed.push({channel,missing:true});
  const channels = observed.filter((channel:any)=> check.metricId==='intent.route_exact'?channel.channel==='adopted':check.metricId==='intent.json'?channel.channel!=='adopted':true);
  const details:any[]=[];
  for (const channel of channels) {
    const label=channel.channel, prediction=channel.prediction;
    let result:RuleResult;
    if(channel.notRun) result={...unknown('No model prediction occurred'),status:'NOT_RUN',applicable:false,denominator:0};
    else if(channel.missing||channel.truncated) result=unknown('Required original intent stage is missing or truncated',1);
    else if(channel.recordMismatch&&check.metricId!=='intent.json')result=unknown('Saved prediction conflicts with the original model JSON',1);
    else if(check.metricId==='intent.json') result=intentJson(null,{raw:channel.raw,stage:label,callId:channel.callId},check);
    else if(!record(prediction)) result=unknown('Original prediction/adopted structure is missing',1);
    else if(check.metricId==='intent.slots_exact') {
      const gold=structuredClone(expected.prediction);if(label==='adopted'){gold.status=expected.program.status;gold.missingSlots=expected.program.missingSlots;}
      result=ratio(Number(equal(intentBusiness(gold),intentBusiness(prediction))),1,check);
    } else if(check.metricId==='intent.macro_f1') {
      const goldLabels=(expected.prediction.intents??[]).map((item:any)=>item.l2),labels=(prediction.intents??[]).map((item:any)=>item.l2);
      const classes=Object.keys(INTENT_TAXONOMY).map(l2=>{const support=goldLabels.filter((x:string)=>x===l2).length,predicted=labels.filter((x:string)=>x===l2).length,tp=Math.min(support,predicted);
        return {l2,support,predicted,tp,fp:predicted-tp,fn:support-tp,precision:predicted?tp/predicted:null,recall:support?tp/support:null,f1:support+predicted?2*tp/(support+predicted):null};});
      const supported=classes.filter(item=>item.f1!==null),unknownLabels=labels.filter((x:string)=>!Object.hasOwn(INTENT_TAXONOMY,x));
      result=ratio(supported.reduce((sum,item)=>sum+item.f1!,0),supported.length+unknownLabels.length,check,{classes,unknownLabels,zeroSupport:classes.filter(item=>!item.support).map(item=>item.l2)});
    } else if(check.metricId==='intent.clarify_recall') {
      const relevant=['AMBIGUOUS','NEED_PARAMETERS'].includes(expected.prediction.status);
      const missing=label==='adopted'?expected.program.missingSlots:expected.clarification.missingSlots;
      result=ratio(Number(relevant&&['AMBIGUOUS','NEED_PARAMETERS'].includes(prediction.status)&&equal(intentMissing(prediction),[...missing].sort())&&(label!=='adopted'||channel.route==='clarify'&&channel.queryIds?.length===0)),Number(relevant),check);
    } else if(check.metricId==='intent.refusal_recall') {
      const relevant=expected.prediction.status==='OUT_OF_SCOPE';result=ratio(Number(relevant&&prediction.status==='OUT_OF_SCOPE'&&(label!=='adopted'||channel.route==='reject'&&channel.queryIds?.length===0)),Number(relevant),check);
    } else if(check.metricId==='intent.false_refusal') {
      const relevant=expected.prediction.status!=='OUT_OF_SCOPE';result=ratio(Number(relevant&&(prediction.status==='OUT_OF_SCOPE'||label==='adopted'&&channel.route==='reject')),Number(relevant),check);
    } else {
      const requiredPlan=expected.program.plan,actualPlan=(prediction.intents??[]).map((item:any)=>({l2:item.l2,slots:item.slots,parameters:item.parameters}));
      result=ratio(Number(prediction.status===expected.program.status&&expected.program.allowedRoutes.includes(channel.route)&&equal(requiredPlan,actualPlan)&&
        (expected.program.queryAllowed?channel.planVerified===true:channel.queryIds?.length===0)),1,check);
    }
    details.push({channel:label,callId:channel.callId??null,runId:actual.runId,evidenceRef:channel.evidenceRef,...result});
  }
  if(!details.length)return unknown('No required intent channel was observed');
  const applicable=details.filter(item=>item.applicable!==false),failed=applicable.some(item=>item.status==='FAIL');
  const primary=details.find(item=>item.channel===(check.metricId==='intent.route_exact'?'adopted':'classify'))??details[0];
  const status=failed?'FAIL':applicable.some(item=>item.status==='UNJUDGEABLE')?'UNJUDGEABLE':applicable.some(item=>item.status==='NOT_RUN')?'NOT_RUN':applicable.length?'PASS':'UNJUDGEABLE';
  return {...primary,status,applicable:applicable.length>0,details:{channels:details},evidenceRefs:details.map(item=>item.evidenceRef).filter(Boolean),reason:'Classify, actual verify and program adoption are retained as separate channels'};
}
