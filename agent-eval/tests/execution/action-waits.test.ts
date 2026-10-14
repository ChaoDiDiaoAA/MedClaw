import {expect,test} from 'bun:test';
import {ActionExecutor} from '../../src/adapters/actions.ts';
import type {ProductAdapter} from '../../src/adapters/product.ts';
import {createPublicMethodSchemas} from '../../../packages/contracts/src/protocol.ts';
import {TOOL_READ_RULES} from '../../../packages/contracts/src/tool.ts';
import {reportFixture} from '../report-fixture.ts';

test('tool-result wait follows the Host page limit and finds a saved result on a later page',async()=>{
  const pages:number[]=[],schema=createPublicMethodSchemas()['tool.read'].input;
  const product={async request(method:string,payload:unknown){
    expect(method).toBe('tool.read');const request=schema.parse(payload);pages.push(request.page);
    return {ok:true,data:{runId:request.runId,page:request.page,pageSize:request.pageSize,totalRows:TOOL_READ_RULES.maxPageSize+1,
      items:request.page===1?Array.from({length:request.pageSize},()=>({status:'running'})):[{status:'succeeded'}]}};
  }} as unknown as ProductAdapter;
  const executor=new ActionExecutor(product,reportFixture().config,'','');executor.aliases.runs.set('turn-1',1);
  await executor.wait('tool_result_saved','turn-1',1000);
  expect(pages).toEqual([1,2]);
});

function submissionFixture(replyRunId:number|null,replyInputId:number|null=2,beforeModel?:()=>void,inputOverride:Record<string,unknown>={}) {
  const submitted:unknown[]=[];
  const product={instanceId:'instance',instanceIds:['instance'],async request(method:string,payload:any){
    if(method==='session.read')return {ok:true,data:{session:{nextSubmissionSequence:2}}};
    if(method==='workspace.read')return {ok:true,data:{revision:1,batchRefs:[],queryId:null}};
    if(method==='run.control.read')return {ok:true,data:{instanceId:'instance'}};
    if(method==='session.submit'){submitted.push(payload);return {ok:true,data:{sessionId:1,clientSequence:2,inputId:replyInputId,runId:replyRunId}};}
    if(method==='session.readInput')return {ok:true,data:{id:replyInputId,sessionId:1,clientSequence:2,mode:(submitted.at(-1) as {mode:string}).mode,targetRunId:1,runId:replyRunId,...inputOverride}};
    if(method==='run.read')return {ok:true,data:{kind:'one',run:{id:1,sessionId:1,instanceId:'instance',kind:'agent',status:'completed',stoppedAt:'2026-10-14T00:00:00Z',
      cleanup:{stopConfirmed:true,requiredPersistenceComplete:true,inputsSettled:true,resourcesReleased:true}}}};
    if(method==='answer.read')return {ok:true,data:null};
    throw new Error('unexpected_request:'+method);
  }} as unknown as ProductAdapter;
  const executor=new ActionExecutor(product,reportFixture().config,'','');
  executor.aliases.sessions.set('main',{id:1,nativeSessionId:'native'});executor.aliases.runs.set('turn-1',1);executor.lastSendAlias='turn-1';
  Object.defineProperty(executor,'model',{value:async()=>{beforeModel?.();return {provider:'fixture',modelId:'fixture',expectedConfigVersion:'1'};}});
  return {executor,submitted};
}

for(const mode of ['steer','follow_up'] as const)test(`accepted ${mode} input waits for its original target when consumption has no Run ID yet`,async()=>{
  for(const receiptRunId of [null,1]) {
  const f=submissionFixture(receiptRunId);
  await f.executor.execute({action:'send',sessionAlias:'main',alias:'turn-2',mode,prompt:'Use device B.',referenceDate:'2026-10-02',targetRunAlias:'turn-1'});
  expect(f.executor.aliases.inputs.get('turn-2')).toEqual({sessionId:1,clientSequence:2,inputId:2});
  expect(f.executor.aliases.runs.get('turn-2')).toBe(1);
  await f.executor.wait('run_settled','turn-2',1000);
  expect(f.submitted).toHaveLength(1);expect(f.submitted[0]).toMatchObject({mode,targetRunId:1});
  }
});

test('non-send consumption cannot replace its target Run identity',async()=>{
  const f=submissionFixture(2);
  await expect(f.executor.execute({action:'send',sessionAlias:'main',alias:'turn-2',mode:'steer',prompt:'Use B.',referenceDate:'2026-10-02',targetRunAlias:'turn-1'})).rejects.toThrow('submission_identity_mismatch');
  expect(f.executor.aliases.inputs.has('turn-2')).toBe(false);expect(f.executor.aliases.runs.has('turn-2')).toBe(false);
});

test('normal send with no Run identity never borrows the previous Run',async()=>{
  const f=submissionFixture(null);
  await expect(f.executor.execute({action:'send',sessionAlias:'main',alias:'turn-2',prompt:'New request.',referenceDate:'2026-10-02'})).rejects.toThrow('submission_identity_mismatch');
  expect(f.executor.aliases.runs.has('turn-2')).toBe(false);
});

test('queued submission must retain a real Input identity',async()=>{
  const f=submissionFixture(1,null);
  await expect(f.executor.execute({action:'send',sessionAlias:'main',alias:'turn-2',mode:'follow_up',prompt:'Use B.',referenceDate:'2026-10-02',targetRunAlias:'turn-1'})).rejects.toThrow('submission_identity_mismatch');
  expect(f.executor.aliases.inputs.has('turn-2')).toBe(false);expect(f.executor.aliases.runs.has('turn-2')).toBe(false);
});

test('queued Input identity must match the accepted submission before aliases are bound',async()=>{
  for(const override of [{id:3},{sessionId:2},{clientSequence:3},{mode:'send'},{targetRunId:2},{runId:2}]) {
    const f=submissionFixture(null,2,undefined,override);
    await expect(f.executor.execute({action:'send',sessionAlias:'main',alias:'turn-2',mode:'steer',prompt:'Use B.',referenceDate:'2026-10-02',targetRunAlias:'turn-1'})).rejects.toThrow('submission_identity_mismatch');
    expect(f.executor.aliases.inputs.has('turn-2')).toBe(false);expect(f.executor.aliases.runs.has('turn-2')).toBe(false);
  }
});

test('cancellation during model configuration prevents send admission',async()=>{
  const controller=new AbortController(),f=submissionFixture(2,2,()=>controller.abort(new Error('cancelled')));
  await expect(f.executor.execute({action:'send',sessionAlias:'main',alias:'turn-2',prompt:'New request.',referenceDate:'2026-10-02'},controller.signal)).rejects.toThrow('cancelled');
  expect(f.submitted).toHaveLength(0);expect(f.executor.aliases.inputs.has('turn-2')).toBe(false);
});
