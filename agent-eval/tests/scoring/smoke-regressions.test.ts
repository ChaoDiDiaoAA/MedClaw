import {expect,test} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectObservation,observedConditions} from '../../src/scoring/project-observation.ts';
import {evaluate} from '../../src/scoring/evaluate.ts';
import {QueryParamsSchema} from '../../../packages/contracts/src/query.ts';
import {commandEffects} from '../../src/scoring/command-effects.ts';
import {toolDeliveryRequest} from '../../src/scoring/project-harness.ts';
import {projectToolCall} from '../../../packages/runtime-pi/src/messages.ts';
import {safeError} from '../../../packages/contracts/src/error.ts';
import {ToolCallRecordSchema} from '../../../packages/contracts/src/tool.ts';
import type {CheckSpec,EvaluationContext} from '../../src/scoring/types.ts';

const check=(metricId:string):CheckSpec=>({id:metricId,metricId,version:'v1',kind:'deterministic',required:true,hardConstraint:false,unit:'calls',goldKey:'values.expected',evidenceKey:'expected'});
const original=(kind:string,value:any)=>({selector:{kind,runId:value.runId,sessionId:value.sessionId,...kind==='tool'?{toolCallId:value.id}:{}},ownerInstanceId:'host',original:value,bytes:Buffer.byteLength(JSON.stringify(value)),protocolValidated:true});
function context(metric:string):EvaluationContext {
  return {trialId:'trial',caseId:'case',trialStatus:'completed',task:{checks:[check(metric)]},gold:{values:{expected:{max:5}}},observation:{trialId:'trial',instanceId:'host',identityChecks:[],missing:[],facts:{queries:[],runs:[],toolCalls:[],toolOriginals:[],collectionCompleteness:{tools:true,children:true,queries:true}}}};
}

test('read-command options that write files or execute helpers cannot prove a read-only operation',()=>{
  for(const command of ['find . -fprint0 changed.txt','find . -fls changed.txt'])expect(commandEffects(command).effects).toContain('write');
  for(const command of ['rg --pre ./mutating-helper needle materials/source-audit.md','rg --hostname-bin ./mutating-helper needle .'])expect(commandEffects(command).unknown).toBe(true);
});

test('ToolView previews and verified originals join on identity and shared status, not entire shape',async()=>{
  const c=context('efficiency.calls'),facts=c.observation!.facts;
  const tool={id:8,runId:1,sessionId:1,name:'read',nativeToolCallId:'native-8',status:'succeeded',input:{path:'guide'},data:{content:[{type:'text',text:'Full content'}]},sdkReturned:true};
  facts.toolCalls=[{id:8,runId:1,sessionId:1,name:'read',nativeToolCallId:'native-8',status:'succeeded',inputPreview:'guide',resultPreview:'Full…',truncated:true,sdkReturned:true}];
  facts.toolOriginals=[original('tool',tool)];
  expect(await projectObservation(check('efficiency.calls'),c)).toMatchObject({actual:{calls:[{id:'8',kind:'read'}]}});
  (facts.toolCalls as any[])[0].status='failed';
  expect((await projectObservation(check('efficiency.calls'),c))?.actual).toBeUndefined();
  (facts.toolCalls as any[])[0].status='succeeded';
  facts.toolOriginals=[original('tool',{...tool,sessionId:99})];
  expect((await projectObservation(check('efficiency.calls'),c))?.actual).toBeUndefined();
});

test('real failed native ToolView error enrichment preserves completeness, while error or owner changes do not',async()=>{
  const c=context('efficiency.calls'),facts=c.observation!.facts;
  const tool=ToolCallRecordSchema.parse({id:8,runId:1,sessionId:1,name:'read',version:'0.87.1',executionMode:'sequential',nativeToolCallId:'native-8',status:'failed',input:{path:'missing'},data:{nativeError:'ENOENT'},error:safeError('internal_error'),sdkReturned:false,nativeEntryId:null});
  facts.toolCalls=[projectToolCall(tool)];facts.toolOriginals=[original('tool',tool)];
  expect((await projectObservation(check('efficiency.calls'),c))?.actual).toEqual({calls:[{id:'8',kind:'read'}]});
  (facts.toolCalls as any[])[0].error.code='tool_timeout';
  expect((await projectObservation(check('efficiency.calls'),c))?.actual).toBeUndefined();
  facts.toolCalls=[projectToolCall(tool)];(facts.toolCalls as any[])[0].error.toolCallId=99;
  expect((await projectObservation(check('efficiency.calls'),c))?.actual).toBeUndefined();
});

test('verified SDK deliveries bind supported provider wire formats without guessing ambiguous tool identities',()=>{
  const c=context('resource.read'),facts=c.observation!.facts;
  facts.runs=[{id:1,sessionId:1,instanceId:'host'}];
  const tool={id:8,runId:1,sessionId:1,name:'read',nativeToolCallId:'native-8',modelCallId:'before',sdkReturned:true,sdkDelivery:{toolCallId:'native-8',content:[{type:'text',text:'Complete source text'}],isError:false}};
  const request=(payload:unknown)=>{const body=JSON.stringify(payload);const raw={instanceId:'host',runId:1,sessionId:1,callId:'after',body,sequence:1,bytes:Buffer.byteLength(body)};facts.providerRequests=[{...original('request',[raw]),selector:{kind:'request',runId:1,sessionId:1,callId:'after'}}];};
  facts.toolOriginals=[original('tool',tool)];
  for(const payload of [
    {messages:[{role:'tool',tool_call_id:'native-8',content:'Complete source text'}]},
    {input:[{type:'function_call_output',call_id:'native-8',output:'Complete source text'}]},
    {messages:[{role:'user',content:[{toolResult:{toolUseId:'native-8',content:[{text:'Complete source text'}],status:'success'}}]}]},
    {contents:[{role:'user',parts:[{functionResponse:{id:'native-8',name:'read',response:{output:'Complete source text'}}}]}]},
  ]){request(payload);expect(toolDeliveryRequest(facts,tool)?.callId).toBe('after');}
  const composite={...tool,nativeToolCallId:'native-8|responses-item',sdkDelivery:{...tool.sdkDelivery,toolCallId:'native-8|responses-item'}};
  facts.toolOriginals=[original('tool',composite)];request({input:[{type:'custom_tool_call_output',call_id:'native-8',output:'Complete source text'}]});
  expect(toolDeliveryRequest(facts,composite)?.callId).toBe('after');
  facts.toolOriginals=[original('tool',composite),original('tool',{...composite,id:9,nativeToolCallId:'native-8|other-item'})];
  expect(toolDeliveryRequest(facts,composite)).toBeUndefined();
  request({contents:[{role:'user',parts:[{functionResponse:{name:'read',response:{output:'Complete source text'}}}]}]});
  expect(toolDeliveryRequest(facts,tool)).toBeUndefined();
  request({input:[{type:'function_call_output',call_id:'another-tool',output:'Complete source text'}]});
  expect(toolDeliveryRequest(facts,tool)).toBeUndefined();
});

test('whole-Trial budget counts preparation, retries and children once, and rejects missing attempts',async()=>{
  const c=context('efficiency.calls'),facts=c.observation!.facts;
  const tools=[{id:1,runId:1,sessionId:1,name:'read',status:'succeeded'},{id:2,runId:2,sessionId:1,name:'query_current',status:'failed'},{id:3,runId:2,sessionId:1,name:'query_current',status:'succeeded'},{id:4,runId:3,sessionId:2,name:'read',status:'succeeded'}];
  facts.toolCalls=[...tools,tools[3]];facts.toolOriginals=tools.map(tool=>original('tool',tool));
  facts.runs=[{id:1,cleanup:{budgetSummary:{toolCalls:1}}},{id:2,cleanup:{budgetSummary:{toolCalls:2}}},{id:3,kind:'child',cleanup:{budgetSummary:{toolCalls:1}}}];
  expect((await projectObservation(check('efficiency.calls'),c))?.actual).toEqual({calls:tools.map(tool=>({id:String(tool.id),kind:tool.name}))});
  (facts.runs as any[])[2].cleanup.budgetSummary.toolCalls=2;
  expect((await projectObservation(check('efficiency.calls'),c))?.actual).toBeUndefined();
});

test('effective region is proved by complete imported batch scope, never by Gold or returned rows',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-scope-regression-'));
  try {
    const path='input/zhejiang_2026-10-02.csv',content='device_id,snapshot_date,region\nSYN-ZJ-A,2026-10-02,浙江\n';
    const manifest=JSON.stringify({artifactId:1,operationRef:'import',files:[{path,bytes:Buffer.byteLength(content)}]});
    await mkdir(join(root,'input'));await writeFile(join(root,path),content);await writeFile(join(root,'manifest.json'),manifest);
    const facts:Record<string,unknown>={batches:[{id:1,region:'浙江',snapshotDate:'2026-10-02',scopeKey:'zj',observedEntityCount:1}],operations:[{kind:'import',artifactId:1,result:{batchIds:[1]}}],artifacts:[{id:1,operationRef:'import',protocolValidated:true}],artifactFiles:[{artifactId:1,relativePath:path,evidencePath:join(root,path),content,bytes:Buffer.byteLength(content)},{artifactId:1,relativePath:'manifest.json',evidencePath:join(root,'manifest.json'),content:manifest,bytes:Buffer.byteLength(manifest)}]};
    const params=QueryParamsSchema.parse({kind:'current',population:'snapshot',snapshotMode:'exact_date',batchIds:[1],time:{start:'2026-10-02',endExclusive:'2026-10-03'}});
    expect(await observedConditions(facts,params)).toMatchObject({region:'浙江',date:'2026-10-02'});
    expect(await observedConditions(facts,params,false)).toMatchObject({region:null});
    (facts.batches as any[])[0].region='河南';
    expect(await observedConditions(facts,params)).toBeUndefined();
    (facts.batches as any[])[0].region='浙江';facts.operations=[];
    expect(await observedConditions(facts,params)).toBeUndefined();
    expect(await observedConditions(facts,{...params,region:'河南'})).toMatchObject({region:'河南'});
  } finally {await rm(root,{recursive:true,force:true});}
});

test('parent query scoring accepts only its verified, delivered child query',async()=>{
  const c=context('query.aggregate'),facts=c.observation!.facts as any;
  c.task.checks[0]!.scope={kind:'run',ref:'turn-1'};
  const scope={batchIds:[1],deviceIds:null,allowedToolNames:['Agent','query_aggregate'],allowedResourceRefs:[],artifactIds:[],readOnly:true};
  facts.aliases={runs:[{alias:'turn-1',runId:1}]};
  facts.runs=[{id:1,sessionId:1,kind:'agent',instanceId:'host'},{id:2,sessionId:2,kind:'child',instanceId:'host',parentRunId:1,originToolCallId:8,childResult:{queryRefs:[{queryId:11}],text:'Verified six devices',truncated:false,outcome:'completed'}}];
  facts.runOriginals=[original('run',{runId:1,sessionId:1,scope}),original('run',{runId:2,sessionId:2,scope,child:{parentRunId:1,parentSessionId:1,childRunId:2,childSessionId:2,originToolCallId:8,scope}})];
  const tool={id:8,runId:1,sessionId:1,name:'Agent',nativeToolCallId:'agent-8',modelCallId:'before',sdkReturned:true,sdkDelivery:{toolCallId:'agent-8',content:[{type:'text',text:'Verified six devices'}],isError:false},data:{content:[{type:'text',text:'Verified six devices'}]}};
  facts.toolOriginals=[original('tool',tool)];facts.toolCalls=[tool];
  const body=JSON.stringify({messages:[{role:'tool',tool_call_id:'agent-8',content:'Verified six devices'}]});
  const request={instanceId:'host',sessionId:1,runId:1,callId:'after',body,sequence:1,bytes:Buffer.byteLength(body)};
  facts.providerRequests=[{...original('request',[request]),selector:{kind:'request',runId:1,sessionId:1,callId:'after'}}];
  const params=QueryParamsSchema.parse({kind:'aggregate',population:'snapshot',snapshotMode:'exact_date',metric:'count',batchIds:[1],region:'浙江',time:{start:'2026-10-02',endExclusive:'2026-10-03'}});
  const query={id:11,runId:2,sessionId:2,kind:'aggregate',params,batchIds:[1],scopeDeviceIds:null,callRef:'2:count',warnings:[],calculationVersion:'v1',createdAt:'2026-10-14T00:00:00.000Z',totalRows:1};
  facts.queryPages=[{query,page:{queryId:11,rows:[{value:6}],totalRows:1,page:1,pageSize:10,warnings:[],calculationVersion:'v1',evidenceIds:[],targetVersion:'query:11:v1',rowKeys:['row:11:0']},evidence:[]}];
  expect((await projectObservation(c.task.checks[0]!,c))?.actual).toEqual([{key:'all',count:6}]);
  facts.providerRequests=[];
  expect((await projectObservation(c.task.checks[0]!,c))?.actual).toBeUndefined();
  facts.providerRequests=[{...original('request',[request]),selector:{kind:'request',runId:1,sessionId:1,callId:'after'}}];
  facts.runs[1].parentRunId=99;
  expect((await projectObservation(c.task.checks[0]!,c))?.actual).toBeUndefined();
});
