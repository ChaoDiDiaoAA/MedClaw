import { expect,test } from 'bun:test';
import { evaluate } from '../../src/scoring/evaluate.ts';
import type { EvaluationContext, JudgeRequest } from '../../src/scoring/types.ts';
const at='2026-10-13T00:00:00.000Z';
test('semantic history expectations bind the authored source turn and Session to actual native evidence',async()=>{
 const history={sessionId:1,storageVersion:1,entries:[{id:'user-one',parentId:null,type:'message',message:{role:'user',content:[{type:'text',text:'Use Zhejiang.'}]}}]};
 let seen:JudgeRequest|undefined;
 const c:EvaluationContext={trialId:'t',caseId:'c',trialStatus:'completed',task:{checks:[{id:'memory',metricId:'memory.history_use',version:'v1',kind:'llm-judge',required:true,hardConstraint:false,unit:'opportunities',goldKey:'values.memory',evidenceKey:'memory',scope:{kind:'run',ref:'turn-2'}}]},gold:{values:{memory:{rubric:'Use the actual earlier regional condition.',sessionAlias:'main',sourceTurnAlias:'turn-1',value:{region:'浙江'}}}},observation:{trialId:'t',instanceId:'host',identityChecks:[],missing:[],facts:{queryPages:[],evidencePages:[],aliases:{sessions:[{alias:'main',sessionId:1}],runs:[{alias:'turn-1',runId:1},{alias:'turn-2',runId:2}],inputs:[{alias:'turn-1',sessionId:1,inputId:1}]},inputs:[{id:1,sessionId:1,status:'consumed',nativeEntryId:'user-one',text:'Use Zhejiang.',textInfo:{truncated:false},createdAt:at}],answers:[{id:1,runId:2,sessionId:1,inputId:2,kind:'result',text:'The Zhejiang synthetic result is available.',queryIds:[],missingSlots:[],nativeLeafId:'answer-two',createdAt:at,resultSource:'agent'}],nativeHistory:[{selector:{kind:'history',sessionId:1,runId:2},protocolValidated:true,bytes:Buffer.byteLength(JSON.stringify(history)),original:history}],modelCalls:[{callId:'p2',runId:2,sessionId:1,kind:'main',context:{nativeHistory:{leafId:'user-one',storageVersion:1}}}],providerRequests:[],contexts:[]}},judge:{judge:async request=>{seen=request;return {status:'completed',error:null,results:[{checkId:'memory',value:1,reason:'Supported actual history',evidenceRefs:request.checks[0]!.evidenceRefs}],metadata:{baseUrl:'http://127.0.0.1:1/',timeoutMs:30000,model:'controlled',startedAt:at,endedAt:at,durationMs:0,temperature:.8,httpStatus:200,requestId:null,usage:{promptTokens:null,completionTokens:null}}};}}};
 expect((await evaluate(c))[0]!.status).toBe('PASS');
 expect(JSON.stringify(seen!.evidence)).toContain('selectedSource');
 (c.gold.values as any).memory.sourceTurnAlias='missing-turn';seen=undefined;
 expect((await evaluate(c))[0]!.status).toBe('UNJUDGEABLE');expect(seen).toBeUndefined();
});
