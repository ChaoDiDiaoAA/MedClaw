import { expect,test } from 'bun:test';
import { authorIntent,intentMetrics } from './intent-fixture.ts';
import { evaluate } from '../../src/scoring/evaluate.ts';
import { aggregate } from '../../src/scoring/aggregate.ts';
import type { CheckSpec } from '../../src/scoring/types.ts';

const gold=()=>authorIntent({op:'current',region:'浙江',date:'2026-10-02',device:'SYN-ZJ-A'},'turn-1');
const check=(metricId:string):CheckSpec=>({id:metricId,metricId,name:intentMetrics[metricId as keyof typeof intentMetrics],version:'v1',kind:'deterministic',required:true,hardConstraint:false,unit:'intent stage opportunities',goldKey:'expected',evidenceKey:'actual',direction:metricId==='intent.false_refusal'?'lower':'higher',threshold:metricId==='intent.false_refusal'?0:1});
const channel=(prediction:any,channel='classify')=>({channel,callId:'call-'+channel,raw:JSON.stringify(prediction),prediction,evidenceRef:'intent:1:'+channel,route:'simple',queryIds:[1],planVerified:true});
const score=async(metric:string,expected:any,channels:any[])=>{
  channels=[...channels];
  if(!channels.some(item=>item.channel==='classify'))channels.unshift(channel(expected.prediction));
  if(!channels.some(item=>item.channel==='adopted'))channels.push({...channel({...expected.prediction,status:expected.program.status,missingSlots:expected.program.missingSlots},'adopted'),route:expected.program.allowedRoutes[0],queryIds:expected.program.queryAllowed?[1]:[]});
  return (await evaluate({trialId:'trial',caseId:'MC-001',trialStatus:'completed',task:{checks:[check(metric)]},gold:{expected},observation:{facts:{actual:{runId:1,channels}},identityChecks:[],missing:[]}}))[0]!;
};

test('original JSON, exact business slots and display names retain separate classify/verify/adopted grades',async()=>{
  const expected=gold(),first=channel(expected.prediction),verified=channel(expected.prediction,'verify'),adopted=channel(expected.prediction,'adopted');
  expect(await score('intent.json',expected,[first,verified,adopted])).toMatchObject({status:'PASS',name:'intent_json_validity'});
  verified.raw='bad';expect(await score('intent.json',expected,[first,verified,adopted])).toMatchObject({status:'FAIL'});
  verified.raw=JSON.stringify(expected.prediction);verified.prediction=structuredClone(expected.prediction);verified.prediction.intents[0].slots.region='河南';
  const result=await score('intent.slots_exact',expected,[first,verified,adopted]);expect(result.status).toBe('FAIL');
  expect((result.details as any).channels.map((item:any)=>[item.channel,item.status])).toEqual([['classify','PASS'],['verify','FAIL'],['adopted','PASS']]);
  expect(await score('intent.slots_exact',expected,[{...first,truncated:true}])).toMatchObject({status:'UNJUDGEABLE'});
});
test('task IDs and clarification wording are normalized, dependencies and full slot fields remain strict',async()=>{
  const expected=authorIntent({op:'clarify',region:'浙江',missing:['deviceIdentity']},'turn-1'),prediction=structuredClone(expected.prediction);
  prediction.clarification!.question='哪一个来源编号？';prediction.candidateIntents[0]!.intents[0]!.id='s7';prediction.clarification!.intentIds=['s7'];
  expect(await score('intent.slots_exact',expected,[channel(prediction)])).toMatchObject({status:'PASS'});
  prediction.candidateIntents[0]!.intents[0]!.slots.device='另一个对象';expect(await score('intent.slots_exact',expected,[channel(prediction)])).toMatchObject({status:'FAIL'});
});
test('multi-intent F1 uses per-stage label multisets; zero support and unknown labels are disclosed',async()=>{
  const expected=authorIntent({op:'current',region:'陕西',date:'2026-10-02'},'turn-1'),prediction=structuredClone(expected.prediction);
  prediction.intents.reverse();
  const result=await score('intent.macro_f1',expected,[channel(prediction)]);expect(result.value).toBe(1);
  expect((result.details as any).channels[0].details.zeroSupport).toContain('CERT_LOOKUP');
  prediction.intents=[];expect((await score('intent.macro_f1',expected,[channel(prediction)])).status).toBe('FAIL');
  prediction.intents=structuredClone(expected.prediction.intents);(prediction.intents[0] as any).l2='UNKNOWN';expect(((await score('intent.macro_f1',expected,[channel(prediction)])).details as any).channels[0].details.unknownLabels).toEqual(['UNKNOWN']);
  const scores=[await score('intent.macro_f1',gold(),[channel(gold().prediction)])];
  const summary=aggregate([{trialId:'trial',caseId:'MC-001',repetition:1}],[{trialId:'trial',caseId:'MC-001',repetition:1,status:'completed',startedAt:'2026-10-12T00:00:00Z'}],scores);
  expect(summary.metrics[0]!.value).toBeNull();expect(summary.metrics[0]!.details).toMatchObject({channels:{classify:{macroF1:1},verify:{macroF1:null}}});
});
test('clarification, OOD refusal, unsupported domain facts and legal empty results have distinct denominators',async()=>{
  const clarify=authorIntent({op:'clarify',region:'浙江',missing:['time']},'turn-1'),clarifyChannel=channel(clarify.prediction,'adopted');clarifyChannel.route='clarify';clarifyChannel.queryIds=[];
  expect(await score('intent.clarify_recall',clarify,[clarifyChannel])).toMatchObject({status:'PASS',denominator:1});
  const refusal=authorIntent({op:'refuse',missing:['hospitalInventory']},'fixture'),rejected=channel(refusal.prediction,'adopted');rejected.route='reject';rejected.queryIds=[];
  expect(await score('intent.refusal_recall',refusal,[rejected])).toMatchObject({status:'PASS'});
  const unsupported=authorIntent({op:'unsupported',region:'浙江',device:'SYN-ZJ-A',missing:['certificateExpiry']},'fixture');
  expect(await score('intent.false_refusal',unsupported,[channel(unsupported.prediction)])).toMatchObject({status:'PASS',numerator:0});
  expect(await score('intent.refusal_recall',unsupported,[channel(unsupported.prediction)])).toMatchObject({applicable:false,denominator:0,value:null});
  expect(await score('intent.false_refusal',gold(),[channel(refusal.prediction)])).toMatchObject({status:'FAIL',numerator:1});
  expect(await score('intent.false_refusal',gold(),[channel(gold().prediction)])).toMatchObject({status:'PASS',numerator:0});
});
test('program route requires actual compiled plan proof, missing required verification is not N/A',async()=>{
  const expected=gold(),adopted=channel(expected.prediction,'adopted');
  expect(await score('intent.route_exact',expected,[adopted])).toMatchObject({status:'PASS'});
  adopted.planVerified=false;expect(await score('intent.route_exact',expected,[adopted])).toMatchObject({status:'FAIL'});
  expect(await score('intent.slots_exact',expected,[channel(expected.prediction),{channel:'verify',missing:true}])).toMatchObject({status:'UNJUDGEABLE'});
});
test('program missing slots cannot be replaced by the original model clarification',async()=>{
  const expected=authorIntent({op:'clarify',region:'浙江',missing:['time']},'turn-1'),adopted=channel(expected.prediction,'adopted');
  Object.assign(adopted,{prediction:{...expected.prediction,missingSlots:['s1.device']},route:'clarify',queryIds:[]});
  expect(await score('intent.clarify_recall',expected,[adopted])).toMatchObject({status:'FAIL'});
  expect(await score('intent.slots_exact',expected,[adopted])).toMatchObject({status:'FAIL'});
  adopted.prediction.missingSlots=['s1.time'];
  expect(await score('intent.clarify_recall',expected,[adopted])).toMatchObject({status:'PASS'});
});
test('independent authored intent preserves explicit status, ambiguity structure and disabled delivery',()=>{
  expect(authorIntent({op:'status',region:'浙江',status:'suspended',start:'2026-09-29',endExclusive:'2026-09-30'},'turn-1').prediction.intents[0]!.slots.status).toBe('suspended');
  expect(authorIntent({op:'status',region:'浙江',status:'active',start:'2026-10-01',endExclusive:'2026-10-02'},'turn-1').prediction.intents[0]!.slots.status).toBe('active');
  expect(authorIntent({op:'clarify',region:'浙江',missing:['deviceIdentity']},'turn-1').prediction.intents).toEqual([]);
  expect(authorIntent({op:'current',region:'陕西',date:'2026-10-02'},'turn-1').prediction.status).toBe('UNSUPPORTED_DATA');
});
