import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import { ModelCallRecorder } from '../../packages/runtime-pi/src/model-call-recorder';
import { Application } from '../../packages/core/src/application';
import { SessionService } from '../../packages/core/src/session/session-service';
import { SqliteWriteTransactions } from '../../packages/storage/src/write-transactions';
import { memoryAssistant, memoryAt, sqliteHistory } from '../fixtures/p9-memory';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import type { CompactionCallOwner, CompactionOperationView } from '../../packages/contracts/src/session';
import type { ModelCallStarter } from '../../packages/contracts/src/run';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function fixture(rich=true,hold=false,credentialFails=false,automatic?:'threshold'|'overflow'|'success_overflow'|'pre_threshold'|'length'|'second_overflow'|'summary_failure',largeSummary=false) {
  const root=mkdtempSync(join(tmpdir(),'medclaw-p10-runtime-')),db=openDatabase(join(root,'app.sqlite')),tx=SqliteWriteTransactions.forDatabase(db),requests:unknown[]=[],scopes:unknown[]=[];
  let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
  let mainCalls=0,summaryCalls=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const body=await request.json();requests.push(body);if(hold)await waiting;
    const main=JSON.stringify(body).includes('MedClaw trusted runtime feedback');if(main)mainCalls++;else summaryCalls++;
    if(main&&(automatic==='second_overflow'||['overflow','summary_failure'].includes(automatic??'')&&mainCalls===1))return Response.json({error:{message:'maximum context length exceeded',type:'context_length_exceeded'}},{status:400});
    if(!main&&automatic==='summary_failure'&&summaryCalls===2)return Response.json({error:{message:'ENGINEERING summary failed'}},{status:400});
    const tokens=main&&automatic==='threshold'?3950:main&&automatic==='success_overflow'?4200:10;
    return new Response(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:main?'ENGINEERING main answer':largeSummary?'ENGINEERING '.repeat(2000):'ENGINEERING summary Shanghai approved active'},finish_reason:main&&automatic==='length'&&mainCalls===1?'length':'stop'}],usage:{prompt_tokens:tokens,completion_tokens:2,total_tokens:tokens+2}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}});
  const credentials=new InMemoryCredentialStore();await credentials.modify('p10-fixture',async()=>({type:'api_key',key:'ENGINEERING'}));
  const runtime=await PiModelRuntime.create({credentials,modelsStore:new InMemoryModelsStore()});
  await runtime.installCustom([{providerId:'p10-fixture',name:'ENGINEERING',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.port}/v1`,models:[{id:'fixture',name:'ENGINEERING',reasoning:false,input:['text'],contextWindow:4096,maxTokens:128,outputLimitConfirmed:true,pricingKnown:false,cost:null}]}]);
  const history=sqliteHistory(db),repo=new Repositories(db,undefined,undefined,tx,history.store),agent=new PiAgentRuntime(runtime,root,history);
  const describe=agent.describe.bind(agent);spyOn(agent,'describe').mockImplementation(resolved=>({...describe(resolved),compaction:{contract:'medclaw.compaction/v1',enabled:!!automatic,reserveTokens:256,keepRecentTokens:128}}));
  const manager=SessionManager.inMemory(root);manager.appendModelChange('p10-fixture','fixture');manager.appendThinkingLevelChange('off');
  if(rich)for(let index=0;index<6;index++){manager.appendMessage({role:'user',content:`ENGINEERING ${index} ${'x'.repeat(160)}`,timestamp:index*2+1});const assistant={...memoryAssistant('y'.repeat(160),'fixture'),provider:'p10-fixture',timestamp:index*2+2};if(automatic==='pre_threshold'&&index===5)assistant.usage={...assistant.usage,input:3950,totalTokens:3950};manager.appendMessage(assistant);}
  repo.createSession({expectedWorkspaceRevision:0},'create',manager.getSessionId(),memoryAt,{header:manager.getHeader(),entries:[],activeLeafId:null});
  history.commitSync({sessionId:1,runId:null,expectedStorageVersion:1,header:manager.getHeader(),newEntries:manager.getEntries(),activeLeafId:manager.getLeafId()});
  const settings=PublishedSettingsSchema.parse({schemaVersion:'medclaw.settings/p1-v1',configVersion:'1',model:{provider:'p10-fixture',modelId:'fixture'},customProviders:[],credentialRefs:{},requestPolicy:{timeoutMs:10000,maxRetries:0,maxRetryDelayMs:2000},previous:null,rollbackFromVersion:null});
  const starter=Object.assign((...args:Parameters<ModelCallStarter>)=>new ModelCallRecorder(repo,...args),{forCompaction:(owner:CompactionCallOwner,time:string)=>ModelCallRecorder.forCompaction(repo,owner,time)});
  const app=new Application('host',settings,runtime,repo,(scope,action)=>{scopes.push(scope);if(credentialFails)throw new Error('ENGINEERING credential unavailable');return action();},starter,()=>{},()=>{},agent,undefined,tx);
  const sessions=new SessionService('host',repo,agent,(input,context)=>app.runs.submitAgent(input,context),()=>app.runs.activeHandle,()=>null,undefined,app.runs,tx);
  cleanup.push(async()=>{release();try{await app.shutdown();}catch{}server.stop(true);db.close();rmSync(root,{recursive:true,force:true});});
  const request={sessionId:1,expectedStorageVersion:2,model:{provider:'p10-fixture',modelId:'fixture',expectedConfigVersion:'1'}};
  return {root,db,repo,agent,app,sessions,requests,scopes,request,release,runtime,describe};
}
async function waitFor(condition:()=>boolean) {for(let attempt=0;attempt<400;attempt++){if(condition())return;await Bun.sleep(5);}throw new Error('Engineering condition did not settle');}
async function terminal(f:Awaited<ReturnType<typeof fixture>>,operationRef:string):Promise<CompactionOperationView> {
  let view:CompactionOperationView|null=null;
  for(let attempt=0;attempt<400;attempt++){const read=await Reflect.get(f.sessions,'readCompaction').call(f.sessions,{sessionId:1,operationRef});if(!read.ok)throw read.error;view=read.data;if(view?.receipt&&!f.app.busy)return view;await Bun.sleep(5);}
  throw new Error(`Engineering manual task did not finish: ${JSON.stringify(view)}`);
}

for(const rich of [true,false])test(`p10 manual ${rich?'summary':'no-op'} is accepted once, uses private runtime scope and never creates a Run`,async()=>{
  const f=await fixture(rich),compact=Reflect.get(f.sessions,'compact');expect(compact).toBeDefined();
  const context={instanceId:'host',operationRef:'manual'},accepted=await compact.call(f.sessions,f.request,context);expect(accepted.ok).toBe(true);
  const repeated=await compact.call(f.sessions,f.request,context);expect(repeated.ok).toBe(true);
  const view=await terminal(f,'manual');expect(view).toMatchObject({status:rich?'completed':'no_op',nativeGenerated:rich,nativeSaved:rich,canContinue:true});
  expect(f.requests).toHaveLength(rich?1:0);expect(f.repo.readSession(1)?.storageVersion).toBe(rich?3:2);
  expect(f.scopes).toMatchObject([{purpose:'runtime',operationRef:'manual',credentialRef:null}]);
  for(const table of ['runs','answers','session_inputs','context_snapshots','context_deliveries','runtime_events'])expect(f.db.query(`SELECT id FROM ${table}`).all()).toEqual([]);
  expect(f.db.query('SELECT run_id,session_id,input_id,kind,state FROM model_calls').all()).toEqual(rich?[{run_id:null,session_id:1,input_id:null,kind:'compaction',state:'completed'}]:[]);
  expect((await compact.call(f.sessions,{...f.request,expectedStorageVersion:3},context)).ok).toBe(false);
  expect((await Reflect.get(f.sessions,'readCompaction').call(f.sessions,{sessionId:2,operationRef:'manual'}))).toMatchObject({ok:false,error:{code:'access_denied'}});
});

test('p10 cancelling a pending manual summary preserves one original cancel request and the occupancy until SDK idle',async()=>{
  const f=await fixture(true,true),compact=Reflect.get(f.sessions,'compact');expect(compact).toBeDefined();
  expect((await compact.call(f.sessions,f.request,{instanceId:'host',operationRef:'manual'})).ok).toBe(true);await waitFor(()=>f.requests.length===1);
  expect(f.app.busy).toBe(true);expect(f.app.runs.activeHandle).toBeNull();
  expect((await f.sessions.select({sessionId:1,expectedWorkspaceRevision:f.repo.readWorkspace().revision})).ok).toBe(false);
  const cancel=Reflect.get(f.sessions,'cancelCompaction');
  expect(await cancel.call(f.sessions,{sessionId:1,operationRef:'manual'},{instanceId:'host',operationRef:'cancel-1'})).toMatchObject({ok:true,data:{disposition:'requested'}});
  expect(await cancel.call(f.sessions,{sessionId:1,operationRef:'manual'},{instanceId:'host',operationRef:'cancel-2'})).toMatchObject({ok:true,data:{disposition:'already_requested'}});
  f.release();await waitFor(()=>f.repo.readCompactionOperation({sessionId:1,operationRef:'manual'})?.receipt!=null);
  const result=await f.sessions.readCompaction({sessionId:1,operationRef:'manual'});expect(result).toMatchObject({ok:true,data:{status:'cancelled',nativeSaved:false,canContinue:false,receipt:{cancelRequestedAt:expect.any(String),runId:null}}});
  // Native factory setup added an unsaved system entry: T07 explicit restore must discard it after stop proof.
  expect(f.app.busy).toBe(true);
  expect(f.requests).toHaveLength(1);expect(f.repo.readSession(1)?.storageVersion).toBe(2);
  expect(await cancel.call(f.sessions,{sessionId:1,operationRef:'manual'},{instanceId:'host',operationRef:'cancel-3'})).toMatchObject({ok:true,data:{disposition:'already_finished'}});
  expect(f.db.query("SELECT id FROM business_events WHERE type='session_compaction_cancel_requested'").all()).toHaveLength(1);
});

test('p10 credential failure before manual SDK entry saves a failed receipt and releases occupancy without calls',async()=>{
  const f=await fixture(true,false,true);
  expect(await f.sessions.compact(f.request,{instanceId:'host',operationRef:'credentials'})).toMatchObject({ok:true});
  expect(await terminal(f,'credentials')).toMatchObject({status:'failed',nativeGenerated:false,nativeSaved:false,canContinue:false,error:{code:'credential_read_failed'},receipt:{callIds:[]}});
  expect(f.requests).toHaveLength(0);expect(f.repo.readSession(1)?.storageVersion).toBe(2);expect(f.app.busy).toBe(false);
});

test('p10 stale admission has no side effects and a second identity after saved compaction is a native no-op',async()=>{
  const f=await fixture();
  for(const request of [{...f.request,expectedStorageVersion:1},{...f.request,model:{...f.request.model,expectedConfigVersion:'old'}}])expect(await f.sessions.compact(request,{instanceId:'host',operationRef:'stale'})).toMatchObject({ok:false});
  expect(f.requests).toHaveLength(0);expect(f.repo.readCompactionOperation({sessionId:1,operationRef:'stale'})).toBeNull();
  expect(await f.sessions.compact(f.request,{instanceId:'host',operationRef:'first'})).toMatchObject({ok:true});await terminal(f,'first');
  expect(await f.sessions.compact({...f.request,expectedStorageVersion:3},{instanceId:'host',operationRef:'second'})).toMatchObject({ok:true});
  expect(await terminal(f,'second')).toMatchObject({status:'no_op',receipt:{noOpReason:'already_compacted',callIds:[]}});
  expect(f.requests).toHaveLength(1);expect(f.repo.readSession(1)?.storageVersion).toBe(3);
});

test('p10 lost acceptance and commit returns recover the original durable manual facts without another summary',async()=>{
  const f=await fixture(),accept=f.repo.acceptCompaction.bind(f.repo),commit=f.repo.commitCompactionInTransaction.bind(f.repo);
  spyOn(f.repo,'acceptCompaction').mockImplementation((...args)=>{accept(...args);throw new Error('ENGINEERING accepted return lost');});
  // The transaction commits, then the caller loses its result; read-only proof must recover it.
  const immediate=SqliteWriteTransactions.forDatabase(f.db).immediate.bind(SqliteWriteTransactions.forDatabase(f.db));
  let accepted=false;
  spyOn(SqliteWriteTransactions.forDatabase(f.db),'immediate').mockImplementation(action=>{const result=immediate(action);if(accepted)throw new Error('ENGINEERING committed return lost');return result;});
  spyOn(f.repo,'commitCompactionInTransaction').mockImplementation((...args)=>{const result=commit(...args);accepted=true;return result;});
  expect(await f.sessions.compact(f.request,{instanceId:'host',operationRef:'lost'})).toMatchObject({ok:true});
  expect(await terminal(f,'lost')).toMatchObject({status:'completed',nativeSaved:true});
  expect(await f.sessions.compact(f.request,{instanceId:'host',operationRef:'lost'})).toMatchObject({ok:true,data:{status:'completed'}});
  expect(f.requests).toHaveLength(1);expect(f.db.query("SELECT id FROM business_events WHERE type='session_compaction_finished'").all()).toHaveLength(1);
});

test('p10 production description enables the installed SDK effective defaults',async()=>{
  const f=await fixture(false),resolved=await f.runtime.resolve(f.request.model,'1',null,{timeoutMs:10000,maxRetries:0,maxRetryDelayMs:2000});
  expect(f.describe(resolved).compaction).toEqual({contract:'medclaw.compaction/v1',enabled:true,reserveTokens:16384,keepRecentTokens:20000});
});

for(const reason of ['threshold','overflow','success_overflow','pre_threshold','length'] as const)test(`p10 Core automatic ${reason} records real calls on the original Run and commits genuine SDK history`,async()=>{
  const f=await fixture(true,false,false,reason),workspace=f.repo.readWorkspace();
  const accepted=await f.sessions.submit({sessionId:1,mode:'send',clientSequence:1,text:'ENGINEERING continue',expectedRevision:workspace.revision,expectedBatchIds:[],expectedQueryId:null,model:f.request.model,referenceDate:'2026-10-06',timezone:'Asia/Shanghai'},{instanceId:'host',operationRef:'send'});
  expect(accepted).toMatchObject({ok:true});if(!accepted.ok||!accepted.data.runId)throw new Error('ENGINEERING root not accepted');const runId=accepted.data.runId;
  await waitFor(()=>!f.app.busy);
  const read=f.repo.read({runId});expect(read).toMatchObject({kind:'one',run:{status:'completed'}});
  const calls=f.db.query<{kind:string;run_id:number;input_id:number|null;compaction_json:string|null},[]>("SELECT kind,run_id,input_id,json_extract(model_json,'$.compaction') compaction_json FROM model_calls ORDER BY id").all();
  expect(calls.filter(call=>call.kind==='main')).toHaveLength(reason==='overflow'||reason==='length'?2:1);expect(calls.filter(call=>call.kind==='compaction').length).toBeGreaterThan(0);
  for(const call of calls.filter(call=>call.kind==='compaction')){expect(call.run_id).toBe(runId);expect(call.input_id).toBeNull();expect(JSON.parse(call.compaction_json!)).toMatchObject({source:'auto',reason:reason==='threshold'||reason==='pre_threshold'?'threshold':'overflow',nativeEntryId:expect.any(String),savedStorageVersion:expect.any(Number)});}
  expect(f.db.query('SELECT id FROM answers').all()).toHaveLength(1);expect(f.db.query("SELECT id FROM runtime_events WHERE type='compaction_completed'").all()).toHaveLength(1);
  if(reason==='overflow'){expect(JSON.stringify(f.requests.at(-1))).toContain('ENGINEERING summary Shanghai');expect(f.db.query("SELECT id FROM memories WHERE json_extract(entry_json,'$.type')='context_edit'").all()).toHaveLength(1);}
  if(reason==='pre_threshold')expect(JSON.stringify(f.requests[0])).not.toContain('MedClaw trusted runtime feedback');
});

for(const reason of ['second_overflow','summary_failure'] as const)test(`p10 automatic ${reason} stops without resetting the original call budget or replaying summaries`,async()=>{
  const f=await fixture(true,false,false,reason),workspace=f.repo.readWorkspace();
  const accepted=await f.sessions.submit({sessionId:1,mode:'send',clientSequence:1,text:'ENGINEERING continue',expectedRevision:workspace.revision,expectedBatchIds:[],expectedQueryId:null,model:f.request.model,referenceDate:'2026-10-06',timezone:'Asia/Shanghai'},{instanceId:'host',operationRef:reason});
  expect(accepted).toMatchObject({ok:true});if(!accepted.ok||!accepted.data.runId)throw new Error('ENGINEERING root not accepted');await waitFor(()=>!f.app.busy);
  expect(f.repo.read({runId:accepted.data.runId})).toMatchObject({kind:'one',run:{status:'failed',cleanup:{budgetSummary:{modelCalls:f.requests.length,recoveryAttempts:0}}}});
  expect(f.requests.filter(body=>JSON.stringify(body).includes('MedClaw trusted runtime feedback'))).toHaveLength(reason==='second_overflow'?2:1);
  expect(f.db.query("SELECT id FROM memories WHERE entry_type='compaction'").all()).toHaveLength(reason==='second_overflow'?1:0);
  expect(f.db.query("SELECT id FROM model_calls WHERE kind='compaction'").all()).toHaveLength(2);
});

test('p10 a generated automatic summary exceeding capacity is saved with a failed Run and no continuation',async()=>{
  const f=await fixture(true,false,false,'threshold',true),workspace=f.repo.readWorkspace();
  const accepted=await f.sessions.submit({sessionId:1,mode:'send',clientSequence:1,text:'ENGINEERING continue',expectedRevision:workspace.revision,expectedBatchIds:[],expectedQueryId:null,model:f.request.model,referenceDate:'2026-10-06',timezone:'Asia/Shanghai'},{instanceId:'host',operationRef:'capacity'});
  expect(accepted).toMatchObject({ok:true});if(!accepted.ok||!accepted.data.runId)throw new Error('ENGINEERING root not accepted');
  await waitFor(()=>!f.app.busy);
  expect(f.repo.read({runId:accepted.data.runId})).toMatchObject({kind:'one',run:{status:'failed',error:{code:'compaction_failed',reason:'compaction_capacity'}}});
  expect(f.db.query("SELECT id FROM memories WHERE entry_type='compaction'").all()).toHaveLength(1);expect(f.db.query("SELECT id FROM runtime_events WHERE type='compaction_completed'").all()).toHaveLength(1);expect(f.db.query('SELECT id FROM answers').all()).toHaveLength(0);
  expect(f.requests.filter(body=>JSON.stringify(body).includes('MedClaw trusted runtime feedback'))).toHaveLength(1);
});
