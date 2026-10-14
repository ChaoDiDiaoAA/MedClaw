import { expect,test } from 'bun:test';
import { evaluate } from '../../src/scoring/evaluate.ts';
import type { EvaluationContext, JudgeRequest } from '../../src/scoring/types.ts';
import {projectObservation} from '../../src/scoring/project-observation.ts';
const at='2026-10-13T00:00:00.000Z';

test('answer rubrics retain compact recovery evidence required by the Case without full provider bodies',async()=>{
 const answerCheck={id:'answer',metricId:'answer.faithful',version:'v1',kind:'llm-judge' as const,required:true,hardConstraint:false,unit:'opportunities',goldKey:'values.answer',evidenceKey:'answer'};
 const tool={id:8,sessionId:1,runId:1,name:'query_current_devices',input:{date:'2026-10-02'},status:'failed',error:{code:'tool_timeout'},sdkReturned:false};
 const c:EvaluationContext={trialId:'t',caseId:'c',trialStatus:'completed',task:{checks:[answerCheck,{...answerCheck,id:'recovery',metricId:'tool.failure_handling',kind:'deterministic',goldKey:'values.recovery',evidenceKey:'recovery'}]},gold:{values:{answer:{rubric:'Require a real tool_timeout and at most one retry.',expectedFailureMode:'tool_timeout'},recovery:{maxRetries:1}}},observation:{trialId:'t',identityChecks:[],missing:[],facts:{queryPages:[],evidencePages:[],answers:[{id:1,runId:1,sessionId:1,inputId:1,kind:'result',text:'Recovered after one timeout.',queryIds:[],missingSlots:[],nativeLeafId:'answer',createdAt:at,resultSource:'agent'}],toolOriginals:[{selector:{kind:'tool',toolCallId:8,runId:1,sessionId:1},protocolValidated:true,bytes:Buffer.byteLength(JSON.stringify(tool)),original:tool}],providerRequests:[],contexts:[]}}};
 const projected=await projectObservation(answerCheck,c);
 expect(JSON.stringify(projected?.actual)).toContain('tool_timeout');
 expect((projected?.actual as any).evidence.items.find((item:any)=>item.ref==='tool:8').value).toMatchObject({status:'failed',error:{code:'tool_timeout'}});
 expect(JSON.stringify(projected?.actual)).not.toContain('providerRequests');
});
test('semantic history expectations bind the authored source turn and Session to actual native evidence',async()=>{
 const history={sessionId:1,storageVersion:1,entries:[{id:'user-one',parentId:null,type:'message',message:{role:'user',content:[{type:'text',text:'Use Zhejiang.'}]}}]};
 let seen:JudgeRequest|undefined;
 const c:EvaluationContext={trialId:'t',caseId:'c',trialStatus:'completed',task:{checks:[{id:'memory',metricId:'memory.history_use',version:'v1',kind:'llm-judge',required:true,hardConstraint:false,unit:'opportunities',goldKey:'values.memory',evidenceKey:'memory',scope:{kind:'run',ref:'turn-2'}}]},gold:{values:{memory:{rubric:'Use the actual earlier regional condition.',sessionAlias:'main',sourceTurnAlias:'turn-1',value:{region:'浙江'}}}},observation:{trialId:'t',instanceId:'host',identityChecks:[],missing:[],facts:{queryPages:[],evidencePages:[],aliases:{sessions:[{alias:'main',sessionId:1}],runs:[{alias:'turn-1',runId:1},{alias:'turn-2',runId:2}],inputs:[{alias:'turn-1',sessionId:1,inputId:1}]},inputs:[{id:1,sessionId:1,status:'consumed',nativeEntryId:'user-one',text:'Use Zhejiang.',textInfo:{truncated:false},createdAt:at}],answers:[{id:1,runId:2,sessionId:1,inputId:2,kind:'result',text:'The Zhejiang synthetic result is available.',queryIds:[],missingSlots:[],nativeLeafId:'answer-two',createdAt:at,resultSource:'agent'}],nativeHistory:[{selector:{kind:'history',sessionId:1,runId:2},protocolValidated:true,bytes:Buffer.byteLength(JSON.stringify(history)),original:history}],modelCalls:[{callId:'p2',runId:2,sessionId:1,kind:'main',context:{nativeHistory:{leafId:'user-one',storageVersion:1}}}],providerRequests:[],contexts:[]}},judge:{judge:async request=>{seen=request;return {status:'completed',error:null,results:[{checkId:'memory',value:1,reason:'Supported actual history',evidenceRefs:request.checks[0]!.evidenceRefs}],metadata:{baseUrl:'http://127.0.0.1:1/',timeoutMs:30000,model:'controlled',startedAt:at,endedAt:at,durationMs:0,temperature:.8,httpStatus:200,requestId:null,usage:{promptTokens:null,completionTokens:null}}};}}};
 expect((await evaluate(c))[0]!.status).toBe('PASS');
 expect(JSON.stringify(seen!.evidence)).toContain('selectedSource');
 (c.gold.values as any).memory.sourceTurnAlias='missing-turn';seen=undefined;
 expect((await evaluate(c))[0]!.status).toBe('UNJUDGEABLE');expect(seen).toBeUndefined();
});

test('semantic batch sends shared answers and evidence once and preserves every check reference',async()=>{
 let seen:JudgeRequest|undefined;
 const checks=['answer.faithful','answer.reasoning'].map((metricId,i)=>({id:'semantic-'+i,metricId,version:'v1' as const,kind:'llm-judge' as const,required:true,hardConstraint:false,unit:'opportunities',goldKey:'values.s'+i,evidenceKey:'s'+i}));
 const actual={answer:'8100 cents = CNY 81.00',evidenceRefs:['query:11'],evidence:{items:[{ref:'query:11',value:{priceCents:8100,date:'2026-10-02'}}]}};
 const c:EvaluationContext={trialId:'t',caseId:'c',trialStatus:'completed',task:{checks},gold:{values:{s0:{rubric:'Allow correct conversion.'},s1:{rubric:'Require the correct date.'}}},observation:{trialId:'t',identityChecks:[],missing:[],facts:{s0:actual,s1:actual}},judge:{judge:async request=>{
   seen=request;return {status:'completed',error:null,results:request.checks.map(check=>({checkId:check.checkId,value:1,reason:'Controlled supported conversion',evidenceRefs:check.evidenceRefs})),metadata:{baseUrl:'http://127.0.0.1:1/',timeoutMs:30000,model:'controlled',startedAt:at,endedAt:at,durationMs:0,temperature:.8,httpStatus:200,requestId:null,usage:{promptTokens:null,completionTokens:null}}};
 }}};
 expect((await evaluate(c)).every(score=>score.status==='PASS')).toBe(true);
 expect(JSON.stringify(seen!.evidence).match(/priceCents/g)).toHaveLength(1);
 expect(JSON.stringify(seen!.answer).match(/8100 cents/g)).toHaveLength(1);
 expect((seen!.evidence as any).items).toHaveLength(1);
 expect(seen!.checks.every(check=>check.evidenceRefs.includes('query:11'))).toBe(true);
});
