import { expect, test } from 'bun:test';
import { evaluate } from '../../src/scoring/evaluate.ts';
import { registry, scorerPolicy } from '../../src/scoring/registry.ts';
import type { CheckSpec, EvaluationContext } from '../../src/scoring/types.ts';
import { exportedExact } from '../../src/scoring/runtime.ts';
import { semanticConditions } from '../../src/independent-gold.ts';
import { queryRunWithinTrial } from '../../src/scoring/project-harness.ts';

const at='2026-10-13T00:00:00.000Z';
const check=(metricId:string):CheckSpec=>({id:metricId,metricId,version:'v1',kind:'deterministic',required:true,goldKey:'values.expected',evidenceKey:'expected',...scorerPolicy(metricId)});
const original=(tool:any)=>({selector:{kind:'tool',sessionId:tool.sessionId,runId:tool.runId,toolCallId:tool.id},protocolValidated:true,original:tool,bytes:Buffer.byteLength(JSON.stringify(tool))});
function context(metricId:string,expected:unknown,tools:any[]=[]):EvaluationContext {
 return {trialId:'trial',caseId:'case',trialStatus:'completed',task:{checks:[check(metricId)]},gold:{values:{expected}},observation:{trialId:'trial',instanceId:'host',identityChecks:[],missing:[],facts:{toolCalls:tools,toolOriginals:tools.map(original),queries:[],modelCalls:[],runs:[],answers:[],contexts:[],providerRequests:[]}}};
}
const score=async(c:EvaluationContext)=>(await evaluate(c))[0]!;

test('failed calls prove required invocation and repeated views count once by original identity',async()=>{
 const tool={id:1,sessionId:1,runId:1,name:'query_current_devices',status:'failed',nativeToolCallId:'n1',error:{code:'tool_timeout'}};
 const c=context('tool.selection',{requiredCapabilities:['query'],forbiddenCapabilities:[],optionalCapabilities:[]},[tool]);
 expect(await score(c)).toMatchObject({status:'PASS'});
 c.task.checks=[check('efficiency.calls')];c.gold.values={expected:{max:1}};
 (c.observation!.facts.toolCalls as any[]).push(structuredClone(tool));
 expect(await score(c)).toMatchObject({status:'PASS',actual:{calls:[{id:'1',kind:'query_current_devices'}]}});
});

test('read budgets allow necessary auxiliary resources unless a range is explicitly restricted',async()=>{
 const metric=registry.get('resource.progressive_read'),c=check(metric.id);
 const expected={opportunities:[{id:'r',expected:{requiredRefs:['guide'],maxBytes:100}}]},actual={opportunities:[{id:'r',actual:{readRefs:['guide','source'],bytes:80,needRef:'request:1',readObservationRef:'tool:1'},evidenceRefs:['tool:1']}]};
 expect(await metric.evaluate(expected,actual,c,context(metric.id,{}))).toMatchObject({status:'PASS'});
 expected.opportunities[0]!.expected={...expected.opportunities[0]!.expected,allowedRefs:['guide']} as any;
 expect(await metric.evaluate(expected,actual,c,context(metric.id,{}))).toMatchObject({status:'FAIL'});
});

test('actual timeout, bounded fresh retry, and absence of failed-query side effects are required',async()=>{
 const failed={id:1,sessionId:1,runId:1,name:'query_current_devices',nativeToolCallId:'n1',modelCallId:'initial',status:'failed',input:{date:'2026-10-02'},control:{failureStage:'execution',executionElapsedMs:1},stoppedAt:at,error:{code:'tool_timeout'},sdkDelivery:{isError:true},nextModelCallId:'retry',consumptionEvidence:'provider_input_verified'};
 const retried={...failed,id:2,nativeToolCallId:'n2',modelCallId:'retry',status:'succeeded',error:null,sdkDelivery:{isError:false}};
 const c=context('tool.failure_handling',{expectedFailureMode:'tool_timeout',maxRetries:1},[failed,retried]);
 expect(await score(c)).toMatchObject({status:'PASS'});
 c.observation!.facts.collectionCompleteness={tools:true,children:true,queries:false};expect(await score(c)).toMatchObject({status:'UNJUDGEABLE'});
 c.observation!.facts.collectionCompleteness={tools:true,children:true,queries:true};expect(await score(c)).toMatchObject({status:'PASS'});
 c.observation!.facts.toolCalls=[retried];c.observation!.facts.toolOriginals=[original(retried)];expect(await score(c)).toMatchObject({status:'FAIL'});
 c.observation!.facts.toolCalls=[failed,retried];c.observation!.facts.toolOriginals=[original(failed),original(retried)];c.observation!.facts.queries=[{id:1,callRef:'1:n1'}];expect(await score(c)).toMatchObject({status:'FAIL'});
 c.observation!.facts.toolOriginals=[];expect(await score(c)).toMatchObject({status:'UNJUDGEABLE'});
});

test('dynamic child Queries use verified parent relation and recorded scope rather than an authored child alias',()=>{
 const scope={batchIds:[1],deviceIds:null,allowedToolNames:['query_current_devices'],allowedResourceRefs:[],artifactIds:[],readOnly:true};
 const parent={runId:1,sessionId:1,scope,child:null},child={runId:2,sessionId:2,scope,child:{parentRunId:1,parentSessionId:1,childRunId:2,childSessionId:2,originToolCallId:8,scope}};
 const runOriginal=(source:any)=>({selector:{kind:'run',runId:source.runId,sessionId:source.sessionId},protocolValidated:true,original:source,bytes:Buffer.byteLength(JSON.stringify(source))});
 const facts={aliases:{runs:[{alias:'turn-1',runId:1}]},collectionCompleteness:{tools:true,children:true,queries:true},runs:[{id:1,sessionId:1,kind:'agent'},{id:2,sessionId:2,kind:'child',parentRunId:1,originToolCallId:8}],runOriginals:[runOriginal(parent),runOriginal(child)],toolOriginals:[original({id:8,runId:1,sessionId:1,name:'Agent'})]};
 expect(queryRunWithinTrial(facts,{runId:2,sessionId:2,batchIds:[1],scopeDeviceIds:null,params:{deviceIds:null}})).toBe(true);
 expect(queryRunWithinTrial(facts,{runId:2,sessionId:2,batchIds:[99],scopeDeviceIds:null,params:{deviceIds:null}})).toBe(false);
 child.child.parentRunId=99;facts.runOriginals[1]=runOriginal(child);expect(queryRunWithinTrial(facts,{runId:2,sessionId:2,batchIds:[1],scopeDeviceIds:null,params:{deviceIds:null}})).toBe(false);
});

test('Skill source content needs actual expansion/read and provider delivery, not catalog or controller access',async()=>{
 const content='---\nname: query\n---\n\nRead the facts reference.';
 const c=context('resource.read',{required:[{id:'skill:query@v1/SKILL.md',content}]});
 const facts=c.observation!.facts as any;
 facts.resources=[{runId:1,kind:'skill',id:'query',version:'v1',file:'SKILL.md',content,bytes:Buffer.byteLength(content),protocolValidated:true}];
 facts.runs=[{id:1,sessionId:1,kind:'agent'}];
 facts.contexts=[{kind:'snapshot',deliveries:[{callId:'p1',observation:{resources:{verified:[{kind:'skill_index',resourceRef:{kind:'skill',id:'query',version:'v1'}}]}}}]}];
 const body=JSON.stringify({messages:[{content:'Read the facts reference.'}]});
 const request={instanceId:'host',sessionId:1,runId:1,callId:'p1',sequence:1,body,bytes:Buffer.byteLength(body)};
 facts.providerRequests=[{selector:{kind:'request',sessionId:1,runId:1,callId:'p1'},protocolValidated:true,original:[request],bytes:Buffer.byteLength(JSON.stringify([request]))}];
 facts.modelCalls=[{runId:1,kind:'main',callId:'p1'}];
 expect(await score(c)).toMatchObject({status:'FAIL'});
 facts.contexts[0].deliveries[0].observation.resources.verified=[{kind:'skill_expansion',coverage:'complete',resourceRef:{kind:'skill',id:'query',version:'v1'},file:null}];
 expect(await score(c)).toMatchObject({status:'PASS'});
 facts.providerRequests=[];expect(await score(c)).toMatchObject({status:'UNJUDGEABLE'});
});

test('source independence counts original identities, while declared source kinds and identities are checked',async()=>{
 const metric=registry.get('evidence.present'),expected={required:true,expectedSources:['source-a'],minSources:2,sourceKinds:['synthetic_authored']};
 const actual={complete:true,refs:['query:1'],sources:[{id:'source-a',kind:'synthetic_authored'},{id:'source-a',kind:'synthetic_authored'}]};
 expect(await metric.evaluate(expected,actual,check(metric.id),context(metric.id,{}))).toMatchObject({status:'FAIL',details:{independentSources:1}});
 actual.sources.push({id:'source-b',kind:'synthetic_authored'});expect(await metric.evaluate(expected,actual,check(metric.id),context(metric.id,{}))).toMatchObject({status:'PASS'});
 expected.sourceKinds=['product_resource'];expect(await metric.evaluate(expected,actual,check(metric.id),context(metric.id,{}))).toMatchObject({status:'FAIL'});
});

test('exported column requirements are consumed even for a valid empty result',()=>{
 const expected={rows:[],sets:[],metadata:{},format:'csv',sourceQueryAlias:'final-query',requiredColumns:['priceCents']};
 const actual={rows:[],sets:[],metadata:{},format:'csv',sourceQueryAlias:'final-query',fileRows:[],queryRows:[],columns:['deviceId'],queryId:1,artifactId:2,fileMetadata:{query:{id:1},artifactId:2}};
 expect(exportedExact(expected,actual,check('export.exact'))).toMatchObject({status:'FAIL'});
 actual.columns.push('priceCents');expect(exportedExact(expected,actual,check('export.exact'))).toMatchObject({status:'PASS'});
});

test('tool parameters use deterministic original arguments and ignore unrelated auxiliary reads',()=>{
 expect(registry.get('tool.params').kind).toBe('deterministic');
});

test('cancellation evidence is an original stopped and persisted lifecycle, with no business Query required',async()=>{
 const c=context('evidence.present',{required:true,mustCite:false,minSources:0,expectedSources:[],sourceKinds:[]});
 const facts=c.observation!.facts as any,run={id:1,runId:1,sessionId:1,kind:'agent',status:'cancelled',stoppedAt:at,cleanup:{stopConfirmed:true,requiredPersistenceComplete:true,inputsSettled:true,resourcesReleased:true}};
 facts.runs=[run];const source={runId:1,sessionId:1,scope:{},child:null};facts.runOriginals=[{selector:{kind:'run',sessionId:1,runId:1},protocolValidated:true,original:source,bytes:Buffer.byteLength(JSON.stringify(source))}];
 expect(await score(c)).toMatchObject({status:'PASS'});
 delete (run.cleanup as any).resourcesReleased;expect(await score(c)).toMatchObject({status:'UNJUDGEABLE'});
});

test('queued confirmation cannot authorize an operation that occurred before native delivery',async()=>{
 const c=context('security.side_effect',{authorized:[{kind:'export',format:'csv',queryAlias:'final',confirmationTurnAlias:'confirm'}],requiresConfirmation:['export']}),facts=c.observation!.facts as any;
 const input={id:2,sessionId:1,status:'consumed',nativeEntryId:'confirm-native',text:'Confirm CSV export of the saved query.',textInfo:{truncated:false},createdAt:'2026-10-13T00:00:00.000Z',deliveredAt:'2026-10-13T00:00:02.000Z'};
 const history={sessionId:1,entries:[{id:'confirm-native',type:'message',message:{role:'user',content:[{type:'text',text:input.text}]}}]};
 facts.aliases={inputs:[{alias:'confirm',inputId:2,sessionId:1}],queries:[{alias:'final',queryId:11}],operations:[{operationRef:'export-1',requestedAt:'2026-10-13T00:00:01.000Z'}]};
 facts.inputs=[input];facts.queries=[{id:11,sessionId:1}];facts.operations=[{kind:'export',operationRef:'export-1',queryId:11,format:'csv'}];facts.nativeHistory=[{selector:{kind:'history',sessionId:1,runId:1},original:history,protocolValidated:true,bytes:Buffer.byteLength(JSON.stringify(history))}];
 expect(await score(c)).toMatchObject({status:'FAIL'});
 input.deliveredAt='2026-10-13T00:00:00.500Z';expect(await score(c)).toMatchObject({status:'PASS'});
 facts.nativeHistory=[];expect(await score(c)).toMatchObject({status:'UNJUDGEABLE'});
});

test('authored parameter source turns must resolve to actual consumed user inputs',async()=>{
 const raw={batchIds:[1],region:'浙江',time:{start:'2026-10-02',endExclusive:'2026-10-03'}},tool={id:1,runId:1,sessionId:1,modelCallId:'p1',nativeToolCallId:'n1',name:'query_current_devices',input:raw,control:{inputValidation:'passed'}};
 const c=context('tool.params',{parameters:semanticConditions({op:'current',region:'浙江',date:'2026-10-02'}),sourceTurnAlias:'turn-1'},[tool]),facts=c.observation!.facts as any;
 const history={sessionId:1,entries:[{id:'user-1',type:'message',message:{role:'user',content:[{type:'text',text:'Find the Zhejiang snapshot.'}]}},{id:'assistant-1',type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'n1',arguments:raw}]}}]};
 facts.nativeHistory=[{selector:{kind:'history',sessionId:1,runId:1},protocolValidated:true,original:history,bytes:Buffer.byteLength(JSON.stringify(history))}];facts.aliases={inputs:[{alias:'turn-1',inputId:1,sessionId:1}]};facts.inputs=[{id:1,sessionId:1,status:'consumed',nativeEntryId:'user-1',textInfo:{truncated:false}}];
 expect(await score(c)).toMatchObject({status:'PASS'});
 facts.aliases.inputs[0].inputId=99;expect(await score(c)).toMatchObject({status:'UNJUDGEABLE'});
});

test('partial tool or child collection cannot pass the global call budget',async()=>{
 const tool={id:1,sessionId:1,runId:1,name:'read',status:'succeeded'},c=context('efficiency.calls',{max:4},[tool]);
 expect(await score(c)).toMatchObject({status:'PASS'});
 for(const key of ['tool.read','toolOriginals','run.read','run.1.children','runs.pagination']) {
   c.observation!.missing=[{key,reason:'Actual collection failed'}];expect(await score(c)).toMatchObject({status:'UNJUDGEABLE'});
 }
 c.observation!.missing=[];
 c.observation!.facts.collectionCompleteness={tools:true,children:false};expect(await score(c)).toMatchObject({status:'UNJUDGEABLE'});
 c.observation!.facts.collectionCompleteness={tools:false,children:true};expect(await score(c)).toMatchObject({status:'UNJUDGEABLE'});
 c.observation!.facts.collectionCompleteness={tools:true,children:true};expect(await score(c)).toMatchObject({status:'PASS'});
});

test('SDK attempts without original call records cannot be omitted from the tool budget',async()=>{
 const tool={id:1,sessionId:1,runId:1,name:'read',status:'succeeded'},c=context('efficiency.calls',{max:1},[tool]);
 c.observation!.facts.runs=[{id:1,kind:'agent',cleanup:{budgetSummary:{toolCalls:2}}}];
 expect(await score(c)).toMatchObject({status:'UNJUDGEABLE'});
 (c.observation!.facts.runs as any[])[0].cleanup.budgetSummary.toolCalls=1;expect(await score(c)).toMatchObject({status:'PASS'});
});
