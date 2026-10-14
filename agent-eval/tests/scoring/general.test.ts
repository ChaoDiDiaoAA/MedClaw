import {expect,test,spyOn} from 'bun:test';
import {registry,qualityMetricCatalog,metricLedger} from '../../src/scoring/registry.ts';
import {evaluate} from '../../src/scoring/evaluate.ts';
import {projectGeneralTools} from '../../src/scoring/project-general.ts';
import * as observation from '../../src/scoring/project-observation.ts';
import type {CheckSpec,EvaluationContext} from '../../src/scoring/types.ts';

const check=(id:string):CheckSpec=>({id,metricId:id,version:'v1',kind:'deterministic',required:true,hardConstraint:false,unit:'opportunities',goldKey:'expected',evidenceKey:'actual',threshold:1});
const context=():EvaluationContext=>({trialId:'t',caseId:'c',trialStatus:'completed',task:{checks:[]},gold:{},observation:null});
const call=(id:string,capability='query',status='succeeded')=>({id,capabilities:[capability],status,originalValid:true,finalValid:true});
const tools=(calls:unknown[])=>({complete:true,calls});
const score=(id:string,g:unknown,a:unknown)=>registry.get(id).evaluate(g,a,check(id),context());

test('v2 adds independent coverage without replacing the original 39 identities',()=>{
  const old=qualityMetricCatalog('v1'),current=qualityMetricCatalog('v2');
  expect(old).toHaveLength(39);expect(current).toHaveLength(50);
  expect(current.filter(m=>registry.get(m.id).kind==='llm-judge')).toHaveLength(19);
  expect(old.every(m=>current.some(n=>n.id===m.id))).toBe(true);
  expect(new Set([...metricLedger.map(m=>m.id),'tool.failure_handling','query.facts','query.coverage','evidence.present',...current.map(m=>m.id)]).size).toBe(140);
});
test('recall counts distinct required capabilities, including failed invocations; precision counts relevant calls',async()=>{
  const actual=tools([call('1'),call('2','read'),call('3','query','failed')]);
  expect(await score('tool.recall',{requiredCapabilities:['query','delegate']},actual)).toMatchObject({value:.5,numerator:1,denominator:2,status:'FAIL'});
  expect(await score('tool.precision',{allowedCapabilities:['query']},actual)).toMatchObject({value:2/3,numerator:2,denominator:3});
  expect(await score('tool.recall',{requiredCapabilities:[]},tools([]))).toMatchObject({applicable:false,value:null,denominator:0});
  expect(await score('tool.precision',{allowedCapabilities:['query']},tools([]))).toMatchObject({applicable:false,value:null});
});
test('tool error counts remain visible with expected failures; duplicate or incomplete calls stay unknown',async()=>{
  const actual=tools([call('1','query','failed'),call('2')]);
  expect(await score('tool.error_rate',{maxRate:.5},actual)).toMatchObject({value:.5,numerator:1,denominator:2,status:'PASS'});
  expect(await score('tool.error_rate',{maxRate:0},actual)).toMatchObject({status:'FAIL',value:.5});
  expect(await score('tool.error_rate',{},actual)).toMatchObject({details:{measurementOnly:true},value:.5});
  expect(await score('tool.recall',{requiredCapabilities:['query']},{...actual,complete:false})).toMatchObject({status:'UNJUDGEABLE'});
  expect(await score('tool.precision',{allowedCapabilities:['query']},tools([call('1'),call('1')]))).toMatchObject({status:'UNJUDGEABLE'});
});
test('argument validity verifies both original and final schema proofs and preserves missing proof',async()=>{
  expect(await score('tool.argument_validity',{},tools([{...call('1'),finalValid:false}]))).toMatchObject({status:'FAIL',value:0});
  expect(await score('tool.argument_validity',{},tools([{...call('1'),originalValid:null}]))).toMatchObject({status:'UNJUDGEABLE'});
});
const sources=(businessTime='2026-10-02')=>({complete:true,sources:[{id:'source',version:'batch:1',businessTime,evidenceRef:'original:source'}]});
test('provenance requires resolvable identity, version, business time and original reference',async()=>{
  expect(await score('evidence.provenance',{},sources())).toMatchObject({status:'PASS'});
  const missing=sources();missing.sources[0]!.version='';
  expect(await score('evidence.provenance',{},missing)).toMatchObject({status:'FAIL'});
  expect(await score('evidence.provenance',{}, {...sources(),complete:false})).toMatchObject({status:'UNJUDGEABLE'});
});
test('freshness checks all supporting business dates, not newest fetch time; historical queries remain valid',async()=>{
  const g={mode:'business_date',date:'2026-10-02',maxLagDays:0};
  expect(await score('evidence.freshness',g,sources())).toMatchObject({status:'PASS'});
  const actual=sources();actual.sources.push({...actual.sources[0]!,id:'old',businessTime:'2026-09-28'});
  expect(await score('evidence.freshness',g,actual)).toMatchObject({status:'FAIL',numerator:1,denominator:2});
  expect(await score('evidence.freshness',g,sources('2026-10-03'))).toMatchObject({status:'FAIL'});
  expect(await score('evidence.freshness',g,sources('not-a-date'))).toMatchObject({status:'UNJUDGEABLE'});
  expect(await score('evidence.freshness',{mode:'age',asOf:'2026-10-02T00:00:00Z',maxAgeMs:1000},sources('2026-10-01T23:59:59Z'))).toMatchObject({status:'PASS'});
});
test('latency compares confirmed monotonic execution only; absent budget is inapplicable',async()=>{
  const a={startedMonoMs:100,stoppedMonoMs:200,stopConfirmed:true};
  expect(await score('efficiency.latency_budget',{maxMs:100},a)).toMatchObject({status:'PASS',value:100,details:{budgetMs:100}});
  expect(await score('efficiency.latency_budget',{maxMs:99},a)).toMatchObject({status:'FAIL'});
  expect(await score('efficiency.latency_budget',{},a)).toMatchObject({applicable:false,value:null});
  expect(await score('efficiency.latency_budget',{maxMs:100},{...a,stopConfirmed:false})).toMatchObject({status:'UNJUDGEABLE'});
});
test('recovery needs causal failure delivery, justified attempts and actual result; unrelated success cannot pass',async()=>{
  const g={maxRetries:1,allowedTools:['query'],allowStop:false,expectedFailureMode:'tool_timeout'};
  const a={complete:true,failures:[{id:'f',delivered:true,code:'tool_timeout',attempts:[{id:'r',name:'query',freshIdentity:true,justified:true,succeeded:true}],sideEffects:0,targetVerified:true,stopped:true}]};
  expect(await score('tool.recovery',g,a)).toMatchObject({status:'PASS',details:{recovered:1}});
  expect(await score('tool.recovery',g,{...a,failures:[{...a.failures[0],targetVerified:false}]})).toMatchObject({status:'FAIL'});
  expect(await score('tool.recovery',{...g,maxRetries:0,allowStop:true},{...a,failures:[{...a.failures[0],attempts:[],targetVerified:null}]})).toMatchObject({status:'PASS',details:{safeStops:1}});
  expect(await score('tool.recovery',g,{...a,failures:[{...a.failures[0],delivered:false}]})).toMatchObject({status:'UNJUDGEABLE'});
  expect(await score('tool.recovery',g,{...a,failures:[]})).toMatchObject({status:'UNJUDGEABLE',applicable:true});
  expect(await score('tool.recovery',g,{...a,failures:[{...a.failures[0],code:'unrelated_failure'}]})).toMatchObject({status:'UNJUDGEABLE',applicable:true});
  expect(await score('tool.recovery',{...g,expectedFailureMode:undefined},{...a,failures:[]})).toMatchObject({applicable:false});
});
test('new semantic partial-failure rubric shares one request and applicability never masks missing expected behavior',async()=>{
  const ids=['answer.partial_failure','answer.faithful'];let requests=0;
  const tool={id:1,runId:1,sessionId:1,name:'query_current_devices',status:'failed',error:{code:'tool_timeout'}};
  const c=context();c.gold={values:{}};c.observation={identityChecks:[],missing:[],facts:{queryPages:[],evidencePages:[],queries:[],toolCalls:[tool],toolOriginals:[original({kind:'tool',toolCallId:1,runId:1,sessionId:1},tool)],answers:[{id:1,runId:1,sessionId:1,inputId:1,kind:'result',text:'The query failed and no price is verified.',queryIds:[],missingSlots:[],nativeLeafId:'answer',createdAt:'2026-10-14T00:00:00Z',resultSource:'agent'}]}};
  c.task.checks=ids.map(id=>({...check(id),kind:'llm-judge',goldKey:'values.'+id.replaceAll('.','_'),evidenceKey:id.replaceAll('.','_')}));
  for(const id of ids){const key=id.replaceAll('.','_');(c.gold.values as any)[key]={rubric:'Actual failure disclosures, not keywords',requireDisclosure:true,expectedFailureMode:'tool_timeout'};c.observation.facts[key]={answer:'A limitation with supporting records',evidenceRefs:['failure'],evidence:{failure:'Original tool failure'}};}
  c.judge={judge:async request=>{requests++;return {status:'completed',error:null,results:request.checks.map(check=>({checkId:check.checkId,value:1,reason:'Supported',evidenceRefs:check.evidenceRefs})),metadata:{baseUrl:'http://localhost/',model:'controlled',timeoutMs:30000,startedAt:'',endedAt:'',durationMs:0,temperature:.8,httpStatus:200,requestId:null,usage:{promptTokens:null,completionTokens:null}}};}};
  expect((await evaluate(c)).every(x=>x.status==='PASS')).toBe(true);expect(requests).toBe(1);
  tool.error.code='unrelated_error';c.observation.facts.toolOriginals=[original({kind:'tool',toolCallId:1,runId:1,sessionId:1},tool)];
  expect((await evaluate(c))[0]).toMatchObject({status:'UNJUDGEABLE',applicable:true});
  c.judge=undefined;expect((await evaluate(c)).every(x=>x.status==='NOT_RUN')).toBe(true);
});

const original=(selector:Record<string,unknown>,value:unknown)=>({selector,protocolValidated:true,original:value,bytes:Buffer.byteLength(JSON.stringify(value))});
function projected(id:string,expected:unknown):EvaluationContext {
  const tool={id:1,runId:1,sessionId:1,name:'query_current_devices',input:{n:'bad'},status:'failed',nativeToolCallId:'native1',modelCallId:'model1',control:{inputValidation:'failed'}};
  const history={sessionId:1,entries:[{type:'message',message:{content:[{type:'toolCall',id:'native1',arguments:{n:1}}]}}]};
  const body=JSON.stringify({tools:[{type:'function',function:{name:tool.name,parameters:{type:'object',properties:{n:{type:'number'}},required:['n'],additionalProperties:false}}}]});
  const requests=[{runId:1,sessionId:1,callId:'model1',body,bytes:Buffer.byteLength(body)}];
  return {...context(),task:{checks:[{...check(id),scope:{kind:'run',ref:'turn-1'}}]},gold:{expected},observation:{trialId:'t',identityChecks:[],missing:[],facts:{aliases:{runs:[{alias:'turn-1',runId:1}]},toolCalls:[tool],toolOriginals:[original({kind:'tool',toolCallId:1,runId:1,sessionId:1},tool)],nativeHistory:[original({kind:'history',sessionId:1},history)],providerRequests:[original({kind:'request',runId:1,sessionId:1,callId:'model1'},requests)],modelCalls:[{callId:'model1'}]}}};
}
test('new scorers project native originals rather than relying on metric-shaped observations',async()=>{
  expect((await evaluate(projected('tool.recall',{requiredCapabilities:['query']})))[0]).toMatchObject({status:'PASS',evidenceRefs:['original:tool:1']});
  expect((await evaluate(projected('tool.argument_validity',{})))[0]).toMatchObject({status:'FAIL',actual:{complete:true,calls:[{originalValid:true,finalValid:false}]}});
  const coercible=projected('tool.argument_validity',{}),facts=coercible.observation!.facts as any;
  const history={sessionId:1,entries:[{message:{content:[{type:'toolCall',id:'native1',arguments:{n:'1'}}]}}]};
  facts.nativeHistory=[original({kind:'history',sessionId:1},history)];
  expect((await evaluate(coercible))[0]).toMatchObject({status:'FAIL',actual:{calls:[{originalValid:false}]}});
  const c=projected('tool.recall',{requiredCapabilities:['query']});c.observation!.facts.collectionCompleteness={tools:false,children:true};
  c.observation!.facts.actual=tools([call('spoofed')]);
  expect((await evaluate(c))[0]).toMatchObject({status:'UNJUDGEABLE'});
  c.observation!.facts.collectionCompleteness={tools:true,children:true};c.task.checks[0]!.scope!.ref='unknown';
  expect((await evaluate(c))[0]).toMatchObject({status:'UNJUDGEABLE'});
});

test('recovery retains disallowed attempts and proves each successive failure delivery',async()=>{
  const g={maxRetries:2,allowedTools:['query_current_devices'],allowStop:false,expectedFailureMode:'tool_timeout'};
  const c=projected('tool.recovery',g),facts=c.observation!.facts as any;
  c.gold={values:{actual:g}};
  const failed=(id:number)=>({id,runId:1,sessionId:1,name:'query_current_devices',input:{date:'2026-10-02'},status:'failed',nativeToolCallId:'n'+id,modelCallId:'m'+id,error:{code:'tool_timeout',retryable:true},sdkReturned:true,sdkDelivery:{toolCallId:'n'+id,isError:true,content:[{type:'text',text:'timeout'+id}]}});
  const first=failed(1),second=failed(2),success={...failed(3),status:'succeeded',error:null,sdkDelivery:{isError:false}};
  facts.toolCalls=[first,second,success];facts.toolOriginals=facts.toolCalls.map((tool:any)=>original({kind:'tool',toolCallId:tool.id,runId:1,sessionId:1},tool));
  facts.queries=[];facts.collectionCompleteness={tools:true,children:true,queries:true};
  facts.providerRequests=[first,second].map(tool=>{const body=JSON.stringify({messages:[{role:'tool',tool_call_id:tool.nativeToolCallId,content:tool.sdkDelivery.content[0].text}]}),callId='m'+(tool.id+1),request={runId:1,sessionId:1,callId,body,bytes:Buffer.byteLength(body)};return original({kind:'request',runId:1,sessionId:1,callId},[request]);});
  let projection=await projectGeneralTools(c.task.checks[0]!,c);
  expect((projection!.actual as any).failures[0].attempts.map((attempt:any)=>attempt.justified)).toEqual([true,true]);
  second.name='forbidden_tool';facts.toolOriginals=facts.toolCalls.map((tool:any)=>original({kind:'tool',toolCallId:tool.id,runId:1,sessionId:1},tool));
  projection=await projectGeneralTools(c.task.checks[0]!,c);
  expect((projection!.actual as any).failures[0].attempts.map((attempt:any)=>attempt.name)).toEqual(['forbidden_tool','query_current_devices']);
  second.name='query_current_devices';facts.toolOriginals=facts.toolCalls.map((tool:any)=>original({kind:'tool',toolCallId:tool.id,runId:1,sessionId:1},tool));
  const target={...check('query.numeric'),id:'target',scope:{kind:'run' as const,ref:'turn-1'},evidenceKey:'target'};
  const goldValues=c.gold.values as Record<string,unknown>;c.task.checks.push(target);goldValues.target=[{id:'price',value:1,unit:'cents'}];
  let targetQueryId=10;const business=spyOn(observation,'projectObservation').mockImplementation(async()=>({actual:goldValues.target,evidenceRefs:['query:'+targetQueryId+':page:1']}));
  try{
    facts.queries=[{id:10,callRef:'1:n3'},{id:99,callRef:'1:unrelated-later-call'}];
    projection=await projectGeneralTools(c.task.checks[0]!,c);
    expect((projection!.actual as any).failures[0].targetVerified).toBe(true);
    targetQueryId=99;projection=await projectGeneralTools(c.task.checks[0]!,c);
    expect((projection!.actual as any).failures[0].targetVerified).toBeNull();
  }finally{business.mockRestore();}
});
test('future or malformed business dates are not accepted as fresh; timestamp timezone remains valid',async()=>{
  const criterion={mode:'age',asOf:'2026-10-02T00:00:00Z',maxAgeMs:1000};
  expect(await score('evidence.freshness',criterion,sources('2026-10-02T07:59:59+08:00'))).toMatchObject({status:'PASS'});
  expect(await score('evidence.freshness',{mode:'business_date',date:'2026-03-02',maxLagDays:5},sources('2026-02-30'))).toMatchObject({status:'UNJUDGEABLE'});
});
