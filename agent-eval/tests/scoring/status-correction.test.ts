import { expect,test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authorIntent } from './intent-fixture.ts';
import { evaluate } from '../../src/scoring/evaluate.ts';
import { QueryParamsSchema } from '../../../packages/contracts/src/query.ts';
import { IntentReadResultSchema } from '../../../packages/contracts/src/intent.ts';
import { intentDecision,disabledIntentModel,intentInput } from '../../../tests/fixtures/p14-intent.ts';

const at='2026-10-12T00:00:00.000Z',metrics=['query.conditions','tool.params','intent.slots_exact','intent.route_exact'];
function original(selector:any,value:any) {
  const text=JSON.stringify(value);return {selector,ownerInstanceId:'host',original:value,bytes:Buffer.byteLength(text),protocolValidated:true};
}
for(const [id,status] of [['MC-011','suspended'],['MC-012','active']] as const)test(`${id} correct state passes business, original tool parameters and intent together; null/reversed/split states fail`,async()=>{
  const target={op:'status' as const,region:'浙江',status,start:'2026-09-29',endExclusive:'2026-09-30'};
  const annotation=authorIntent(target,'turn-1');
  const metricsGold:Record<string,unknown>={'query.conditions':annotation.program.conditions,'tool.params':{opportunities:[{id:'template',expected:{parameters:annotation.program.conditions}}]},'intent.slots_exact':annotation,'intent.route_exact':annotation};
  const checks=metrics.map(metricId=>({id:metricId,metricId,version:'v1',kind:'deterministic' as const,required:true,hardConstraint:false,unit:'conditions',goldKey:'values.'+metricId.replaceAll('.','_'),evidenceKey:metricId.replaceAll('.','_'),scope:{kind:'run',ref:'turn-1'}}));
  const gold={values:{...Object.fromEntries(metrics.map(metricId=>[metricId.replaceAll('.','_'),metricsGold[metricId]])),finalStageAlias:'turn-1',stages:{'turn-1':{target}}}};
  for(const mode of ['correct','null','reversed','split'] as const) {
    const actualStatus=mode==='correct'?status:mode==='reversed'?status==='active'?'suspended':'active':null;
    const prediction=authorIntent({...target,status},'turn-1').prediction;
    if(mode!=='split')prediction.intents[0]!.slots.status=actualStatus;
    const params=QueryParamsSchema.parse({kind:'changes',population:'changes',snapshotMode:null,batchIds:[1,2],time:{start:target.start,endExclusive:target.endExclusive},region:'浙江',changeKind:'field_changed',changeField:'status',status:actualStatus});
    const model={...disabledIntentModel(),enabled:true,verifiedEvidenceRef:'fixture',...intentInput().versions,api:'ollama-chat'};
    const call={id:1,callId:'classify',intentCallId:'classify',stage:'classify',previousCallId:null,state:'completed',model,snapshotId:1,startedAt:at,endedAt:at,error:null,prediction,rawOutput:{text:JSON.stringify(prediction),truncated:false},validation:null};
    const decision={...intentDecision(),id:1,createdAt:at,intentCallId:'classify',decisionSource:'validated_model',matchedBy:'qwen_prompt',ruleEvaluation:null,policyVersion:'medclaw.intent-policy/v5',status:'RESOLVED',route:'simple',adoptedIntents:prediction.intents,adoptedSlots:prediction.intents[0]!.slots,missingSlots:[],queryParams:params,
      executionPlan:{contract:'medclaw.intent-query-plan/v1',steps:[{stepId:'s1',dependsOn:[],queries:[params],metadata:null}]}};
    const intent=IntentReadResultSchema.parse({contract:'medclaw.intent-read/v2',runId:1,sessionId:1,inputId:1,ruleEvaluation:null,calls:[call],decision,execution:{runStatus:'completed',queryIds:[11],stepResults:[],answerId:1,finalHistorySaved:true,requiredPersistenceComplete:true},effectiveContext:null});
    const query={id:11,sessionId:1,runId:1,callRef:'1:native-one',kind:'changes',params,batchIds:[1,2],scopeDeviceIds:null,warnings:[],calculationVersion:'v1',createdAt:at,totalRows:0};
    const tool={id:8,runId:1,sessionId:1,modelCallId:'one',nativeToolCallId:'native-one',name:'query_changes',input:params,control:{inputValidation:'passed'}};
    const results=await evaluate({trialId:'trial',caseId:id,trialStatus:'completed',task:{checks},gold,observation:{trialId:'trial',instanceId:'host',identityChecks:[],missing:[],facts:{
      aliases:{runs:[{alias:'turn-1',runId:1}],sessions:[{alias:'main',sessionId:1}],lastSendAlias:'turn-1'},runs:[{id:1,kind:'agent',instanceId:'host',sessionId:1,status:'completed'}],intents:[intent],queries:[query],
      queryPages:[{query,page:{queryId:11,rows:[],totalRows:0,page:1,pageSize:20,warnings:[],calculationVersion:'v1',evidenceIds:[],targetVersion:'query:11:v1',rowKeys:[]},evidence:[]}],
      toolCalls:[tool],toolOriginals:[original({kind:'tool',runId:1,sessionId:1,toolCallId:8},tool)],nativeHistory:[original({kind:'history',runId:1,sessionId:1},{sessionId:1,entries:[{id:'entry',message:{content:[{type:'toolCall',id:'native-one',arguments:params}]}}]})],providerRequests:[],modelCalls:[],answers:[],contexts:[]}}});
    expect(Object.fromEntries(results.map(result=>[result.metricId,result.status]))).toEqual(Object.fromEntries(metrics.map(metric=>[metric,mode==='correct'||mode==='split'&&metric==='intent.slots_exact'?'PASS':'FAIL'])));
  }
});
