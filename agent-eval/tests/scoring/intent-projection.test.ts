import { expect,test } from 'bun:test';
import { authorIntent } from './intent-fixture.ts';
import { IntentReadResultSchema } from '../../../packages/contracts/src/intent.ts';
import { QueryParamsSchema } from '../../../packages/contracts/src/query.ts';
import { intentDecision,intentRuleFact,disabledIntentModel,intentInput } from '../../../tests/fixtures/p14-intent.ts';
import { evaluate } from '../../src/scoring/evaluate.ts';
import {projectPublicEvidence} from '../../src/data-format.ts';
const at='2026-10-12T00:00:00.000Z';
async function grade(metric:string,gold:any,intent:any,queryPages:any[]=[],archived=false) {
  const parsed=IntentReadResultSchema.parse(intent),original=archived?projectPublicEvidence({...parsed,protocolValidated:true}):parsed;
  return (await evaluate({trialId:'trial',caseId:'fixture',trialStatus:'completed',task:{checks:[{id:'intent',metricId:metric,version:'v1',required:true,hardConstraint:false,kind:'deterministic',unit:'intent stages',goldKey:'values.expected',evidenceKey:'expected',scope:{kind:'run',ref:'turn-1'}}]},gold:{values:{expected:gold,finalStageAlias:'turn-1'}},observation:{trialId:'trial',identityChecks:[],missing:[],facts:{aliases:{runs:[{alias:'turn-1',runId:1}]},intents:[original],queries:queryPages.map(page=>page.query),queryPages}}}))[0]!;
}
function record(decision:any,calls:any[]=[],queryIds:number[]=[]) {
  return {contract:'medclaw.intent-read/v2',runId:1,sessionId:1,inputId:1,ruleEvaluation:decision.ruleEvaluation,calls,decision:{...decision,id:1,createdAt:at},execution:{runStatus:'completed',queryIds,stepResults:[],answerId:1,finalHistorySaved:true,requiredPersistenceComplete:true},effectiveContext:null};
}
test('an internally consistent wrong product plan cannot prove an independent aggregate intent route',async()=>{
  const gold=authorIntent({op:'aggregate',region:'浙江',date:'2026-10-02',metric:'count',group:'category'},'turn-1');
  for(const kind of ['current','aggregate'] as const) {
    const params=QueryParamsSchema.parse({kind,population:'snapshot',snapshotMode:'exact_date',batchIds:[1],time:{start:'2026-10-02',endExclusive:'2026-10-03'},region:'浙江',metric:kind==='aggregate'?'count':null,groupBy:kind==='aggregate'?'category':null});
    const decision={...intentDecision(),route:'simple',policyVersion:'medclaw.intent-policy/v5',adoptedIntents:gold.prediction.intents,adoptedSlots:gold.prediction.intents[0]!.slots,queryParams:params,executionPlan:{contract:'medclaw.intent-query-plan/v1',steps:[{stepId:'s1',dependsOn:[],queries:[params],metadata:null}]}};
    const query={id:11,runId:1,sessionId:1,callRef:'intent:1',kind,params,batchIds:[1],scopeDeviceIds:null,warnings:[],calculationVersion:'v1',resultHash:'result',createdAt:at,totalRows:0};
    const page={query,page:{queryId:11,rows:[],totalRows:0,page:1,pageSize:20,warnings:[],calculationVersion:'v1',evidenceIds:[],targetVersion:'a'.repeat(64),rowKeys:[]},evidence:[]};
    expect((await grade('intent.route_exact',gold,record(decision,[],[11]),[page])).status).toBe(kind==='aggregate'?'PASS':'FAIL');
    expect((await grade('intent.route_exact',gold,record(decision,[],[11]),[page],true)).status).toBe(kind==='aggregate'?'PASS':'FAIL');
  }
});
test('original model JSON and adopted missing fields remain independently bound through intent.read',async()=>{
  const gold=authorIntent({op:'clarify',region:'浙江',missing:['time']},'turn-1');
  const model={...disabledIntentModel(),enabled:true,modelDigest:'sha256:'+'a'.repeat(64),verifiedEvidenceRef:'fixture',...intentInput().versions,api:'ollama-chat'};
  const call={id:1,callId:'classify',intentCallId:'classify',stage:'classify',previousCallId:null,state:'completed',model,snapshotId:1,startedAt:at,endedAt:at,error:null,prediction:gold.prediction,rawOutput:{text:JSON.stringify(gold.prediction),truncated:false},validation:null};
  const decision={...intentDecision(),intentCallId:'classify',matchedBy:'qwen_prompt',decisionSource:'validated_model',ruleEvaluation:null,route:'clarify',status:'NEED_PARAMETERS',adoptedIntents:gold.prediction.intents,adoptedSlots:gold.prediction.intents[0]!.slots,missingSlots:['s1.device']};
  expect((await grade('intent.clarify_recall',gold,record(decision,[call]))).status).toBe('FAIL');
  decision.missingSlots=['s1.time'];expect((await grade('intent.clarify_recall',gold,record(decision,[call]))).status).toBe('PASS');
  const wrong=structuredClone(gold.prediction);wrong.intents[0]!.slots.region='河南';call.rawOutput.text=JSON.stringify(wrong);
  expect((await grade('intent.slots_exact',gold,record(decision,[call]))).status).toBe('UNJUDGEABLE');
  expect((await grade('intent.json',gold,record(decision,[call]))).status).toBe('PASS');
});
