import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import { ModelCallRecorder } from '../../packages/runtime-pi/src/model-call-recorder';
import { contextMessageText, matchProviderContext } from '../../packages/runtime-pi/src/messages';
import { openDatabase } from '../../packages/storage/src/database';
import { SqliteContextStore } from '../../packages/storage/src/context-store';
import { ContextService } from '../../packages/core/src/context/context-service';
import { acceptContextInput } from '../fixtures/p8-context';
import type { AppError } from '../../packages/contracts/src/error';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { SubmitInputSchema } from '../../packages/contracts/src/session';
import { Repositories } from '../../packages/storage/src/repositories';
import { Application } from '../../packages/core/src/application';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { SqliteCatalogStore } from '../../packages/storage/src/catalog-store';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { QueryService } from '../../packages/core/src/data/query-service';
import { EvidenceReader } from '../../packages/core/src/evidence/evidence-reader';
import { createBusinessTools } from '../../packages/core/src/tools/tools';
import { ToolRegistry } from '../../packages/core/src/tools/registry';
import { ToolRecorder } from '../../packages/core/src/tools/recorder';
import { ToolExecutor } from '../../packages/core/src/tools/executor';
import { SqliteWriteTransactions } from '../../packages/storage/src/write-transactions';
import { RuntimeService } from '../../packages/core/src/runtime/runtime-service';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
async function setup(options: { snapshotFailure?: boolean; deliveryFailure?: () => boolean; status?: number; api?: 'openai-completions' | 'google-generative-ai'; payloadReplacement?: unknown; payloadHook?:(payload:unknown)=>unknown|Promise<unknown>; responseFailure?: boolean; responseCancel?:boolean; tools?:boolean; respond?:(index:number)=>Promise<Record<string,unknown>>|Record<string,unknown> } = {}) {
  const root = await mkdtemp(join(tmpdir(),'medclaw-p8-http-')), db = openDatabase(join(root,'app.sqlite'));
  const requests: Record<string,unknown>[] = [];
  const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    requests.push(await request.json() as Record<string,unknown>);
    if (options.status && options.status !== 200) return new Response(JSON.stringify({error:{message:'fixture rejection'}}),{status:options.status,headers:{'content-type':'application/json'}});
    const delta = await options.respond?.(requests.length) ?? {role:'assistant',content:'verified'};
    return new Response(`data: ${JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta,finish_reason:'tool_calls' in delta ? 'tool_calls' : 'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  }});
  const credentials = new InMemoryCredentialStore(); await credentials.modify('p8-fixture',async () => ({type:'api_key',key:'fixture'}));
  const runtime = await PiModelRuntime.create({credentials,modelsStore:new InMemoryModelsStore()});
  const definition = {providerId:'p8-fixture',name:'Fixture',api:options.api ?? 'openai-completions',baseUrl:`http://127.0.0.1:${server.port}/v1`,models:[{id:'fixture',name:'Fixture',input:['text' as const],reasoning:false,contextWindow:32768,maxTokens:1024,outputLimitConfirmed:true as const,pricingKnown:false,cost:null}]};
  await runtime.installCustom([definition]);
  const resolved = await runtime.resolve({provider:'p8-fixture',modelId:'fixture',expectedConfigVersion:'1'},'1',null,{timeoutMs:15000,maxRetries:0,maxRetryDelayMs:2000});
  const contexts = new SqliteContextStore(db), service = new ContextService(contexts,{inspectManagedImport:async () => ({status:'valid' as const})});
  if (options.snapshotFailure) db.exec("CREATE TEMP TRIGGER fail_snapshot BEFORE INSERT ON context_snapshots BEGIN SELECT RAISE(ABORT,'fixture snapshot failure'); END;");
  const recordDelivery = contexts.recordDelivery.bind(contexts);
  contexts.recordDelivery = input => {if(options.deliveryFailure?.()) throw new Error('storage_write_failed');return recordDelivery(input);};
  closers.push(async () => {server.stop(true);db.close();await rm(root,{recursive:true,force:true});});
  return {root,db,runtime,resolved,contexts,service,requests,definition};
}
async function fixture(options: Parameters<typeof setup>[0] = {}) {
  const {root,db,runtime,resolved,contexts,service,requests} = await setup(options);
  const errors: AppError[] = [], controller = new AbortController();
  const toolStore = new SqliteToolStore(db), catalog = new CatalogService(new SqliteCatalogStore(db)), queries = new QueryService(catalog,toolStore), evidence = new EvidenceReader(catalog,queries,toolStore);
  const registry = new ToolRegistry(createBusinessTools({catalog,queries,evidence})), recorder = new ToolRecorder(toolStore,error => {errors.push(error);controller.abort();});
  const agent = new PiAgentRuntime(runtime,root,options.tools ? {registry,recorder,executor:new ToolExecutor(registry,recorder)} : undefined,service), allocated = agent.allocate();
  if ('payloadReplacement' in options || options.payloadHook || options.responseFailure || options.responseCancel) {
    const prepare = Reflect.get(agent,'prepare').bind(agent);
    Reflect.set(agent,'prepare',async (...args:unknown[]) => {
      await prepare(...args);
      const session = (args[0] as {session:AgentSession}).session, original = session.agent.streamFunction;
      session.agent.streamFunction = (model,context,streamOptions) => original(model,context,{...streamOptions,...('payloadReplacement' in options ? {onPayload:() => options.payloadReplacement} : options.payloadHook ? {onPayload:options.payloadHook} : {}),...(options.responseFailure || options.responseCancel ? {onResponse:() => {if(options.responseCancel)controller.abort();if(options.responseFailure)throw new Error('fixture callback failure');}} : {})});
    });
  }
  const f = acceptContextInput(db,{consume:false,nativeSessionId:allocated.nativeSessionId,model:resolved.selection,toolNames:agent.toolNames}); allocated.bind(f.input.sessionId);
  f.repos.beginInputDelivery(f.input.inputId,'host',new Date().toISOString());
  const execute = () => agent.execute({runId:f.input.runId,sessionId:f.input.sessionId,inputId:f.input.inputId,text:f.request.text,resolved,agentOptions:agent.describe(resolved),scope:f.input.scope,workspaceContext:f.input.workspaceContext,referenceDate:f.request.referenceDate,timezone:f.request.timezone,signal:controller.signal,deadlineAt:performance.now()+15000},{startCall:(at,context) => new ModelCallRecorder(f.repos,f.input.runId,'main',at,context),preview:() => {},nativeTerminal:() => {},inputStore:f.repos,fatal:error => {errors.push(error);controller.abort();}});
  return {...f,agent,contexts,service,controller,db,requests,errors,execute};
}

test('p8 original Pi request sends the saved projection and records a real successful HTTP observation', async () => {
  const f = await fixture(), result = await f.execute(); expect(VERSION).toBe('0.87.1');
  expect(f.requests).toHaveLength(1); expect(result.calls).toHaveLength(1); expect(f.errors).toEqual([]);
  const callId = result.calls[0]!.callId, read = f.contexts.read({callId});
  expect(read).toMatchObject({kind:'snapshot',evidence:'saved',selectedCallId:callId});
  if (read.kind !== 'snapshot') throw new Error('missing snapshot');
  const messages = f.requests[0]!.messages as {role:string;content:unknown}[];
  expect(messages.filter(message => contextMessageText(message.content) === read.snapshot.renderedProjection)).toHaveLength(1);
  expect(matchProviderContext('openai-completions',f.requests[0],read.snapshot)).toBe(true);
  expect(read.deliveries[0]?.observation).toMatchObject({httpStatus:200,api:'openai-completions',projectionHash:read.snapshot.projectionHash});
});

test('p8 actually consumed queued input and original tool facts bind distinct snapshots on the real Pi chain', async () => {
  let release!:()=>void;const first = new Promise<void>(resolve => {release = resolve;});
  const f = await fixture({tools:true,respond:async index => {if(index === 1) {await first;return {role:'assistant',tool_calls:[{index:0,id:'p8-tool-one',type:'function',function:{name:'read_data_scope',arguments:'{}'}}]};}return {role:'assistant',content:'two inputs verified'};}});
  const running = f.execute();
  for(let i=0;i<1000 && f.requests.length === 0;i++) await Bun.sleep(2);
  expect(f.requests).toHaveLength(1);
  const pendingCall=f.db.query<{call_id:string},[]>('SELECT call_id FROM model_calls').get()!;
  expect(f.contexts.read({callId:pendingCall.call_id})).toMatchObject({kind:'snapshot',evidence:'unconfirmed',deliveries:[]});
  expect(f.db.query("SELECT * FROM runtime_events WHERE type='context_delivered'").all()).toEqual([]);
  const request = {...f.request,mode:'steer' as const,targetRunId:f.input.runId,clientSequence:2,text:'Second actually consumed input'};
  const accepted = f.repos.acceptInput({operationRef:'p8-queued',originalSubmitInput:request,content:{...f.content,originalSubmitInput:request,text:request.text},createdAt:new Date().toISOString(),execution:{mode:'steer',targetRunId:f.input.runId}});
  f.repos.beginInputDelivery(accepted.inputId!,'host',new Date().toISOString());
  await f.agent.inputAdapter.deliver({inputId:accepted.inputId!,sessionId:f.input.sessionId,targetRunId:f.input.runId,mode:'steer',text:request.text,stopEpoch:0,workspaceContext:f.input.workspaceContext});
  expect(f.repos.readInput({inputId:accepted.inputId!})?.status).toBe('queued');
  expect(f.db.query('SELECT input_id FROM context_snapshots').all()).toEqual([{input_id:f.input.inputId}]);
  release();const result = await running;
  expect(f.errors).toEqual([]);expect(result.calls).toHaveLength(2);expect(f.requests).toHaveLength(2);
  const old = f.contexts.read({callId:result.calls[0]!.callId}), next = f.contexts.read({callId:result.calls[1]!.callId});
  expect(old).toMatchObject({kind:'snapshot',evidence:'saved',snapshot:{inputId:f.input.inputId}});
  expect(next).toMatchObject({kind:'snapshot',evidence:'saved',snapshot:{inputId:accepted.inputId}});
  if(old.kind !== 'snapshot' || next.kind !== 'snapshot') throw new Error('No snapshots');
  expect(old.snapshot.nativeRefs.map(ref => ref.kind)).toEqual(['input']);
  expect(next.snapshot.nativeRefs).toEqual(expect.arrayContaining([expect.objectContaining({kind:'tool_result',originSnapshotId:old.snapshot.id,nativeToolCallId:'p8-tool-one'})]));
  expect(next.deliveries[0]!.observation.verifiedNativeRefs).toEqual(expect.arrayContaining([expect.objectContaining({kind:'tool_result'})]));
  expect(f.db.query('SELECT context_snapshot_id,model_call_id FROM tool_calls').all()).toEqual([{context_snapshot_id:old.snapshot.id,model_call_id:old.deliveries[0]!.modelCallId}]);
  const secondMessages = f.requests[1]!.messages as {role:string;content:unknown}[];
  expect(secondMessages.filter(message => contextMessageText(message.content) === next.snapshot.renderedProjection)).toHaveLength(1);
  const native = f.agent.readMessages({sessionId:f.input.sessionId,leafId:null,afterEntryId:null,limit:50});
  expect(native.items.filter(item => item.displayRole === 'user').map(item => item.text)).toEqual([f.request.text,request.text]);
  expect(native.items.some(item => item.text === next.snapshot.renderedProjection)).toBe(false);
},15000);

test('p8 a third real request verifies old tool facts without replacing their first consumer or origin',async()=>{
  const f=await fixture({tools:true,respond:index=>index<3 ? {role:'assistant',tool_calls:[{index:0,id:`p8-tool-${index}`,type:'function',function:{name:'read_data_scope',arguments:'{}'}}]} : {role:'assistant',content:'three rounds'}}),result=await f.execute();
  expect(f.errors).toEqual([]);expect(f.requests).toHaveLength(3);expect(result.calls).toHaveLength(3);
  const reads=result.calls.map(call=>f.contexts.read({callId:call.callId}));if(reads.some(read=>read.kind!=='snapshot'))throw new Error('No context');
  const last=reads[2]!;if(last.kind!=='snapshot')throw new Error('No final context');
  expect(last.snapshot.nativeRefs.filter(ref=>ref.kind==='tool_result')).toHaveLength(2);expect(last.deliveries[0]!.observation.verifiedNativeRefs).toHaveLength(2);
  const row=f.db.query<{context_snapshot_id:number;delivery_json:string},[]>('SELECT context_snapshot_id,delivery_json FROM tool_calls WHERE native_tool_call_id=\'p8-tool-1\'').get()!;
  expect(row.context_snapshot_id).toBe(result.calls[0]!.context!.snapshotId);expect(JSON.parse(row.delivery_json).nextModelCallId).toBe(result.calls[1]!.callId);
});

for(const delayedStop of [false,true]) test(`p8 Application blocks and repairs original delivery without HTTP replay (stop delayed=${delayedStop})`, async () => {
  let reject = true;
  const f = await setup({deliveryFailure:() => reject}), repo = new Repositories(f.db), agent = new PiAgentRuntime(f.runtime,f.root,undefined,f.service);
  let release!:()=>void;const stopped = new Promise<void>(resolve => {release=resolve;});
  if(delayedStop) {const execute=agent.execute.bind(agent);agent.execute=async (...args) => {const observed=await execute(...args);await stopped;return observed;};}
  const native = agent.allocate(), session = repo.createSession({expectedWorkspaceRevision:0},'app-session',native.nativeSessionId,new Date().toISOString()).session; native.bind(session.id);
  const settings = PublishedSettingsSchema.parse({schemaVersion:'medclaw.settings/p1-v1',configVersion:'1',model:{provider:'p8-fixture',modelId:'fixture'},customProviders:[{definition:f.definition,credentialRef:null}],credentialRefs:{},requestPolicy:{timeoutMs:15000,maxRetries:0,maxRetryDelayMs:2000},ui:{navCollapsed:false,detailOpen:false,detailTab:'conditions'},previous:null,rollbackFromVersion:null});
  const app = new Application('host',settings,f.runtime,repo,(_context,action) => action(),(runId,kind,at,context) => new ModelCallRecorder(repo,runId,kind,at,context),() => {},undefined,agent);
  const request = SubmitInputSchema.parse({sessionId:session.id,clientSequence:1,text:'Original evidence',mode:'send',expectedRevision:repo.readWorkspace().revision,expectedBatchIds:[],expectedQueryId:null,model:{provider:'p8-fixture',modelId:'fixture',expectedConfigVersion:'1'},referenceDate:'2026-10-05',timezone:'Asia/Shanghai'});
  const accepted = await app.runs.submitAgent(request,{instanceId:'host',operationRef:'original-app-input'}); if (!accepted.ok || !accepted.data.runId) throw new Error('submission failed');
  for (let i=0;i<1000 && !(delayedStop ? agent.hasPendingContextPersistence(accepted.data.runId) : app.runs.persistencePending);i++) await Bun.sleep(2);
  const runId = accepted.data.runId; expect(f.requests).toHaveLength(1); expect(app.runs.activeHandle?.runId).toBe(runId);
  expect(JSON.parse(f.db.query<{config_json:string},[number]>('SELECT config_json FROM runs WHERE id=?').get(runId)!.config_json).agent.contextContract).toBe('medclaw.context/v1');
  expect(repo.read({runId})).toMatchObject({kind:'one',run:{cleanup:{requiredPersistenceComplete:false,unconfirmedItems:expect.arrayContaining(['context_persistence'])}}});
  const read = repo.read({runId}); if (read.kind !== 'one' || !read.run) throw new Error('missing run');
  expect(f.contexts.read({callId:read.run.calls[0]!.callId})).toMatchObject({kind:'snapshot',evidence:'persistence_gap'});
  expect(await app.runs.submitAgent({...request,clientSequence:2},{instanceId:'host',operationRef:'blocked-new-input'})).toMatchObject({ok:false,error:{code:'state_conflict',reason:'runtime_busy'}});
  // Completion waits for the original idle observation, then only the original receipt is saved.
  if(delayedStop) {
    expect(await app.runs.cancel(runId)).toMatchObject({ok:true,data:{stopped:false}});
    expect(await app.runs.retrySave(runId)).toMatchObject({ok:false,error:{code:'run_save_unavailable'}});
    expect(app.runs.activeHandle?.runId).toBe(runId);expect(f.requests).toHaveLength(1);
    release();for(let i=0;i<1000 && !app.runs.persistencePending;i++) await Bun.sleep(2);
  }else expect(await app.runs.cancel(runId)).toMatchObject({ok:true,data:{stopped:true,persistencePending:true}});
  expect(app.runs.persistencePending).toBe(true);
  reject = false; const saved = await app.runs.retrySave(runId);
  expect(saved).toMatchObject({ok:true,data:{id:runId,status:'failed',cleanup:{requiredPersistenceComplete:true,unconfirmedItems:[]}}});
  expect(app.runs.activeHandle).toBeNull(); expect(f.requests).toHaveLength(1);
  expect(f.db.query("SELECT * FROM runtime_events WHERE type='context_delivered'").all()).toEqual([]);
  expect(f.db.query('SELECT * FROM context_deliveries').all()).toHaveLength(1);
  await app.runs.shutdown();
},15000);

for(const [phase,table,operation] of [['delivery','context_deliveries','INSERT'],['observation','model_calls','UPDATE'],['event','runtime_events','INSERT']] as const) test(`p8 real HTTP ${phase} transaction failure retains original proof and blocks without another request`,async () => {
  const f = await fixture();
  const condition = phase === 'observation' ? "WHEN json_extract(NEW.model_json,'$.context.observation') IS NOT NULL" : phase === 'event' ? "WHEN NEW.type='context_delivered'" : '';
  f.db.exec(`CREATE TEMP TRIGGER fail_phase BEFORE ${operation} ON ${table} ${condition} BEGIN SELECT RAISE(ABORT,'fixture phase failure'); END;`);
  const result=await f.execute();expect(f.requests).toHaveLength(1);expect(result.calls).toHaveLength(1);
  expect(f.agent.hasPendingContextPersistence(f.input.runId)).toBe(true);expect(f.db.query('SELECT * FROM context_deliveries').all()).toEqual([]);expect(f.db.query("SELECT * FROM runtime_events WHERE type='context_delivered'").all()).toEqual([]);
  f.db.exec('DROP TRIGGER fail_phase');f.agent.retryContextPersistence(f.input.runId);f.agent.retryContextPersistence(f.input.runId);
  expect(f.agent.hasPendingContextPersistence(f.input.runId)).toBe(false);expect(f.requests).toHaveLength(1);expect(f.contexts.read({callId:result.calls[0]!.callId})).toMatchObject({kind:'snapshot',evidence:'saved'});
});

test('p8 snapshot save failure prevents the dependent Pi HTTP request and call registration', async () => {
  const f = await fixture({snapshotFailure:true}); await f.execute();
  expect(f.requests).toHaveLength(0); expect(f.db.query('SELECT * FROM model_calls').all()).toEqual([]);
  expect(f.db.query('SELECT * FROM context_snapshots').all()).toEqual([]);
  expect(f.errors.some(error => error.code === 'storage_write_failed')).toBe(true);
});

for(const phase of ['snapshot_commit','call_registration'] as const) test(`p8 ${phase} failure leaves zero dependent HTTP requests`,async()=>{
  const f=await fixture();let injected=false;
  if(phase==='snapshot_commit'){
    const save=f.contexts.save.bind(f.contexts),tx=SqliteWriteTransactions.forDatabase(f.db);
    f.contexts.save=selection=>tx.immediate(()=>{
      const snapshot=save(selection);
      // Valid immediate Session FK and NULL input bypass the INSERT guard; the invalid Run owner fails only at COMMIT.
      f.db.query('INSERT INTO context_snapshots(run_id,session_id,input_id,sequence,snapshot_json,created_at) VALUES(99999,?,NULL,1,?,?)').run(selection.input.sessionId,JSON.stringify(selection.body),selection.input.createdAt);
      injected=true;
      return snapshot;
    });
  }else f.db.exec("CREATE TEMP TRIGGER fail_call BEFORE INSERT ON model_calls BEGIN SELECT RAISE(ABORT,'fixture call failure'); END;");
  await f.execute();if(phase==='snapshot_commit')expect(injected).toBe(true);
  expect(f.requests).toHaveLength(0);expect(f.db.query('SELECT * FROM model_calls').all()).toEqual([]);
  expect(f.db.query('SELECT * FROM context_snapshots').all()).toHaveLength(phase==='snapshot_commit'?0:1);
  expect(f.db.query('SELECT * FROM context_deliveries').all()).toEqual([]);
});

for(const previousProcessExited of [false,true]) test(`p8 Runtime recovery keeps missing original observation blocked (process exited=${previousProcessExited})`,async()=>{
  const f=await setup(),accepted=acceptContextInput(f.db),snapshot=f.contexts.save(f.contexts.select(accepted.input));
  accepted.repos.startCall(accepted.input.runId,'lost-original-observation','main',snapshot.createdAt,{snapshotId:snapshot.id,inputId:accepted.input.inputId});
  const recovered=new RuntimeService('new-host',()=>{throw new Error('Recovery must not resolve settings');},f.runtime,accepted.repos,(_context,action)=>action(),(runId,kind,at,context)=>new ModelCallRecorder(accepted.repos,runId,kind,at,context),()=>{},()=>{},undefined,()=>false);
  recovered.recoverInterrupted(previousProcessExited);
  expect(recovered.persistencePending).toBe(true);
  expect(await recovered.retrySave(accepted.input.runId)).toMatchObject({ok:false,error:{code:previousProcessExited?'run_save_unavailable':'stop_unconfirmed'}});
  if(previousProcessExited)expect(accepted.repos.read({runId:accepted.input.runId})).toMatchObject({kind:'one',run:{status:'failed',cleanup:{stopConfirmed:true,requiredPersistenceComplete:false,unconfirmedItems:expect.arrayContaining(['context_observation_unknown'])}}});
  expect(f.requests).toHaveLength(0);expect(f.db.query('SELECT * FROM model_calls').all()).toHaveLength(1);expect(f.db.query('SELECT * FROM context_deliveries').all()).toEqual([]);
});

test('p8 deferred FK COMMIT failure after real response rolls back all delivery facts and retries only storage',async () => {
  const f = await fixture(), record=f.contexts.recordDelivery.bind(f.contexts), tx=SqliteWriteTransactions.forDatabase(f.db);let fail=true;
  f.contexts.recordDelivery=input => tx.immediate(() => {
    const result=record(input);
    if(fail)f.db.query('INSERT INTO context_deliveries(model_call_id,snapshot_id,run_id,session_id,delivered_at) VALUES(99999,?,?,?,?)').run(input.snapshotId,input.runId,input.sessionId,input.observation.observedAt);
    return result;
  });
  const result=await f.execute();expect(f.requests).toHaveLength(1);expect(f.agent.hasPendingContextPersistence(f.input.runId)).toBe(true);
  expect(f.db.query('SELECT * FROM context_deliveries').all()).toEqual([]);expect(f.db.query("SELECT * FROM runtime_events WHERE type='context_delivered'").all()).toEqual([]);
  fail=false;f.agent.retryContextPersistence(f.input.runId);expect(f.contexts.read({callId:result.calls[0]!.callId})).toMatchObject({kind:'snapshot',evidence:'saved'});expect(f.requests).toHaveLength(1);
});

test('p8 cancellation during async snapshot preparation leaves no dependent model call or HTTP',async () => {
  const f=await fixture();
  // The injected seam delays the existing service, not the SDK or HTTP receiver.
  const original=f.service.prepare.bind(f.service);
  f.service.prepare=async (...args) => {const snapshot=await original(...args);f.controller.abort();return snapshot;};
  await f.execute();expect(f.db.query('SELECT * FROM context_snapshots').all()).toHaveLength(1);expect(f.db.query('SELECT * FROM model_calls').all()).toEqual([]);expect(f.requests).toHaveLength(0);
});

test('p8 delivery write failure keeps the original receipt and retries storage without another HTTP request', async () => {
  let reject = true; const f = await fixture({deliveryFailure:() => reject}), result = await f.execute();
  expect(f.requests).toHaveLength(1); expect(f.db.query('SELECT * FROM context_deliveries').all()).toEqual([]);
  expect(f.db.query("SELECT * FROM runtime_events WHERE type='context_delivered'").all()).toEqual([]);
  expect(f.agent.hasPendingContextPersistence(f.input.runId)).toBe(true);
  expect(f.errors.some(error => error.code === 'storage_write_failed')).toBe(true);
  reject = false; f.agent.retryContextPersistence(f.input.runId);
  expect(f.agent.hasPendingContextPersistence(f.input.runId)).toBe(false);
  expect(f.contexts.read({callId:result.calls[0]!.callId})).toMatchObject({kind:'snapshot',evidence:'saved'});
  expect(f.requests).toHaveLength(1);
});

test('p8 rejects a replacement payload before HTTP while preserving its unconfirmed call marker', async () => {
  const f = await fixture({payloadReplacement:null}), result = await f.execute();
  expect(f.requests).toHaveLength(0); expect(result.calls).toHaveLength(1);
  expect(result.calls[0]?.context).toMatchObject({payloadVerified:false,observation:null,responseStatus:null});
  expect(f.errors.some(error => error.code === 'context_payload_mismatch')).toBe(true);
  expect(f.db.query('SELECT * FROM context_deliveries').all()).toEqual([]);
});

test('p8 keeps HTTP delivery evidence even when the existing response callback throws', async () => {
  const f = await fixture({responseFailure:true}), result = await f.execute();
  expect(f.requests).toHaveLength(1); expect(result.calls).toHaveLength(1);
  expect(f.contexts.read({callId:result.calls[0]!.callId})).toMatchObject({kind:'snapshot',evidence:'saved'});
  expect(f.agent.hasPendingContextPersistence(f.input.runId)).toBe(false);
});

test('p8 keeps the original positive receipt when an existing response callback cancels',async()=>{
  const f=await fixture({responseCancel:true}),result=await f.execute();
  expect(f.requests).toHaveLength(1);expect(f.contexts.read({callId:result.calls[0]!.callId})).toMatchObject({kind:'snapshot',evidence:'saved'});
});

for(const mode of ['mutation','replacement','async_replacement'] as const) test(`p8 preserves an existing ${mode} payload hook and verifies its effective request`,async()=>{
  const f=await fixture({payloadHook:payload=>{
    const original=payload as Record<string,unknown>;
    if(mode==='mutation'){original.fixtureHook=mode;return undefined;}
    const replacement={...original,fixtureHook:mode};return mode==='replacement'?replacement:Promise.resolve(replacement);
  }}),result=await f.execute();
  expect(f.requests).toHaveLength(1);expect(f.requests[0]!.fixtureHook).toBe(mode);
  expect(f.contexts.read({callId:result.calls[0]!.callId})).toMatchObject({kind:'snapshot',evidence:'saved'});expect(f.errors).toEqual([]);
});

test('p8 rejects APIs without a confirming response hook before call registration or HTTP', async () => {
  const f = await fixture({api:'google-generative-ai'}); await f.execute();
  expect(f.errors.some(error => error.code === 'context_delivery_unsupported')).toBe(true);
  expect(f.requests).toHaveLength(0); expect(f.db.query('SELECT * FROM model_calls').all()).toEqual([]);
});

test('p8 a rejected HTTP request has a snapshot but no successful delivery event', async () => {
  const f = await fixture({status:400}), result = await f.execute();
  expect(f.requests).toHaveLength(1); expect(result.calls).toHaveLength(1);
  expect(f.contexts.read({callId:result.calls[0]!.callId})).toMatchObject({kind:'snapshot',evidence:'unconfirmed',deliveries:[]});
  expect(f.db.query("SELECT * FROM runtime_events WHERE type='context_delivered'").all()).toEqual([]);
});
