import { readIntentStageMessage } from '../fixtures/p14-intent';
import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {HostController} from '../../apps/desktop/src/main/host-controller';
import {MainSettings,atomicWriteJson} from '../../apps/desktop/src/main/settings';
import {PublishedSettingsSchema,IntentModelConfigurationSchema,type IntentModelConfiguration} from '../../packages/contracts/src/model';
import {IntentModelInspectionSchema,IntentReadResultSchema,type IntentStageInput} from '../../packages/contracts/src/intent';
import {NewSessionResultSchema,SessionDetailSchema,SessionCheckpointPageSchema,SessionCheckpointReceiptSchema,SubmitResultSchema,type SubmitInput} from '../../packages/contracts/src/session';
import {WorkspaceViewSchema} from '../../packages/contracts/src/workspace';
import {RuntimeControlViewSchema,CancelRunResultSchema} from '../../packages/contracts/src/run';
import {ImportPreviewSchema,ImportOperationSchema} from '../../packages/contracts/src/data';
import {safeError,type Result} from '../../packages/contracts/src/error';
import {disabledIntentModel,productIntent,resolvedIntent} from '../fixtures/p14-intent';
import {packageFixture} from '../fixtures/snapshot-package';
import {SessionMessagePageSchema} from '../../packages/contracts/src/messages';
import {EventPageSchema} from '../../packages/contracts/src/event';
import {RunEventProjection} from '../../apps/desktop/src/renderer/use-run-events';

function unwrap<T>(result:Result<T>):T{if(!result.ok)throw result.error;return result.data;}
async function until(check:()=>Promise<boolean>){const end=Date.now()+10000;while(!await check()){if(Date.now()>end)throw new Error('ENGINEERING_HOST_TIMEOUT');await Bun.sleep(10);}}

async function fixture(options?:{mainAuth?:boolean;verify?:boolean}){
  const root=mkdtempSync(join(tmpdir(),'medclaw-p14-host-')),source=join(root,'source'),requests:Record<string,unknown>[]=[],intentRequests:IntentStageInput[]=[],paths:string[]=[];
  packageFixture(source);let digest='a'.repeat(64),offline=false,holdIntent=false,heldStage:'classify'|'verify'='classify',releaseIntent=()=>{};
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const path=new URL(request.url).pathname;paths.push(path);
    if(path.startsWith('/api/')&&offline)return new Response('ENGINEERING unavailable',{status:503});
    if(path==='/api/version')return Response.json({version:'ENGINEERING'});
    if(path==='/api/tags')return Response.json({models:[{name:'qwen3.5:0.8b',digest}]});
    if(path==='/api/show')return Response.json({details:{family:'qwen35',parameter_size:'752.39M',quantization_level:'Q8_0'},template:'ENGINEERING untrusted template'});
    if(path==='/api/chat'){
      const body=await request.json() as {messages:{content:string}[]},stage=readIntentStageMessage(body.messages[1]!.content) as IntentStageInput;intentRequests.push(stage);
      if(holdIntent&&stage.stage===heldStage)await new Promise<void>(done=>{releaseIntent=done;});
      const item={...productIntent(),...(options?.verify&&stage.stage==='classify'?{l0:'DATA_OPERATIONS' as const}:{}),slots:{...productIntent().slots,region:'浙江',time:{start:'2026-01-01',endExclusive:'2026-01-02'}}};
      const result={...resolvedIntent(),intents:stage.stage==='verify'?stage.review!.candidates[0]!.intents:[item]};
      return Response.json({model:'qwen3.5:0.8b',done:true,done_reason:'stop',message:{role:'assistant',content:JSON.stringify(result)},prompt_eval_count:44,eval_count:35});
    }
    if(path!=='/v1/chat/completions')return new Response('ENGINEERING unexpected endpoint',{status:404});
    requests.push(await request.json() as Record<string,unknown>);
    return new Response(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'ENGINEERING answer'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  }});
  const host=new HostController({dataRoot:root,hostEntry:resolve('apps/host/src/main.ts'),bunExecutable:process.execPath,onCredentialRequest:async frame=>
    frame.method==='credential.list'?{ok:true,data:options?.mainAuth===false?[]:[{providerId:'p14-fixture',type:'api_key'}]}:
    frame.method==='credential.read'?{ok:true,data:options?.mainAuth!==false&&frame.payload.providerId==='p14-fixture'?{type:'api_key',key:'ENGINEERING'}:null}:
    frame.method==='file.resolve'&&frame.payload.operationRef==='fixture-import'?{ok:true,data:source}:{ok:false,error:safeError('access_denied')}});
  const initial=new MainSettings(host.paths.settingsPath).read(),definition={providerId:'p14-fixture',name:'ENGINEERING',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.port}/v1`,models:[{id:'fixture',name:'ENGINEERING',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,outputLimitConfirmed:true,pricingKnown:false,cost:null}]};
  atomicWriteJson(host.paths.settingsPath,PublishedSettingsSchema.parse({...initial,intentModel:null,model:{provider:'p14-fixture',modelId:'fixture'},customProviders:[{definition,credentialRef:null}]}));
  const settings=new MainSettings(host.paths.settingsPath,{
    prepare:async(token,candidate)=>unwrap(await host.request('settings.prepare',{token,candidate})),
    commit:async(token,publishedVersion)=>unwrap(await host.request('settings.commit',{token,publishedVersion})),
    abort:async token=>unwrap(await host.request('settings.abort',{token})),
    readVersion:async()=>{const directory=unwrap(await host.request('model.read',{})) as {configVersion:string};return directory.configVersion;},
  });
  const started=await host.start();if(started.state!=='ready')await close();expect(started).toMatchObject({state:'ready',schemaVersion:13});
  const sql=(query:string)=>{const db=new Database(host.paths.databasePath,{readonly:true});try{return db.query(query).all();}finally{db.close();}};
  const workspace=async()=>WorkspaceViewSchema.parse(unwrap(await host.request('workspace.read',{})));
  const create=async(op:string)=>NewSessionResultSchema.parse(unwrap(await host.request('session.create',{expectedWorkspaceRevision:(await workspace()).revision},op)));
  const idle=()=>until(async()=>RuntimeControlViewSchema.parse(unwrap(await host.request('run.control.read',{}))).acceptingNewRuns);
  const intentModel=():IntentModelConfiguration=>IntentModelConfigurationSchema.parse({...disabledIntentModel(),enabled:true,baseUrl:`http://127.0.0.1:${server.port}`,modelDigest:'sha256:'+'a'.repeat(64),verifiedEvidenceRef:'ENGINEERING controlled protocol; not official quality evidence'});
  async function data(){
    const preview=ImportPreviewSchema.parse(unwrap(await host.request('import.preview',{operationRef:'fixture-import',fileToken:'ENGINEERING-token',mappingVersion:'medclaw.snapshot/v1'},'fixture-import')));expect(preview.canCommit).toBe(true);
    const imported=ImportOperationSchema.parse(unwrap(await host.request('import.commit',{operationRef:'fixture-import',fileToken:'ENGINEERING-token',previewHash:preview.previewHash},'fixture-import')));
    return WorkspaceViewSchema.parse(unwrap(await host.request('workspace.update',{expectedRevision:(await workspace()).revision,change:{batchIds:imported.result!.batchIds}})));
  }
  async function send(sessionId:number,text:string,op:string,intent=true){
    const detail=SessionDetailSchema.parse(unwrap(await host.request('session.read',{sessionId}))),w=await workspace();
    const input:SubmitInput={sessionId,clientSequence:detail.session.nextSubmissionSequence,text,mode:'send',expectedRevision:w.revision,expectedBatchIds:w.batchRefs.map(batch=>batch.id),expectedQueryId:w.queryId,
      model:{provider:'p14-fixture',modelId:'fixture',expectedConfigVersion:settings.read().configVersion},referenceDate:'2026-01-02',timezone:'Asia/Shanghai',...(intent?{routing:{mode:'intent' as const,originRunId:null}}:{})};
    return SubmitResultSchema.parse(unwrap(await host.request('session.submit',input,op)));
  }
  async function close(){releaseIntent();try{if(host.read().instanceId&&!host.read().canStart)await host.stop(host.read().instanceId!);}finally{server.stop(true);const inside=relative(tmpdir(),root);if(inside&&!inside.startsWith('..')&&!inside.includes(':'))rmSync(root,{recursive:true,force:true});}}
  return{host,settings,sql,workspace,create,idle,intentModel,data,send,requests,intentRequests,paths,close,identity:(value:string)=>{digest=value;},offline:(value:boolean)=>{offline=value;},holdIntent:(value:boolean,stage:'classify'|'verify'='classify')=>{holdIntent=value;heldStage=stage;if(!value)releaseIntent();}};
}

test('p14 actual Host inspect and absent intent reads are independent read-only operations',async()=>{
  const f=await fixture({mainAuth:false});try{
    const before={runs:f.sql('SELECT * FROM runs'),calls:f.sql('SELECT * FROM model_calls'),settings:f.settings.read()};
    const model=f.intentModel(),inspection=IntentModelInspectionSchema.parse(unwrap(await f.host.request('model.intent.inspect',{baseUrl:model.baseUrl,modelTag:model.modelTag})));
    expect(inspection).toMatchObject({available:true,actualDigest:model.modelDigest,metadata:{family:'qwen35',quantization:'Q8_0'}});
    expect(JSON.stringify(inspection)).not.toContain('untrusted template');expect(unwrap(await f.host.request('intent.read',{runId:999}))).toBeNull();
    expect({runs:f.sql('SELECT * FROM runs'),calls:f.sql('SELECT * FROM model_calls'),settings:f.settings.read()}).toEqual(before);
    expect(f.intentRequests).toHaveLength(0);expect(f.requests).toHaveLength(0);
  }finally{await f.close();}
},20000);

test('p14 independent intent settings publish checks the live digest without main auth or inference and failure retains old config',async()=>{
  const f=await fixture({mainAuth:false});try{
    const initial=f.settings.read(),model=f.intentModel();
    const published=await f.settings.publish(initial.configVersion,{intentModel:model},{kind:'intent'});
    expect(published.intentModel).toEqual(model);expect(published.model).toEqual(initial.model);expect(published.credentialRefs).toEqual(initial.credentialRefs);
    expect(unwrap(await f.host.request('model.read',{}))).toMatchObject({configVersion:published.configVersion});
    f.identity('b'.repeat(64));
    const mismatch=await f.settings.publish(published.configVersion,{intentModel:{...model,timeoutMs:16000}},{kind:'intent'}).then(()=>null,error=>error);
    expect(mismatch).toMatchObject({code:'intent_model_identity_mismatch'});
    expect(f.settings.read()).toEqual(published);
    const stale=await f.settings.publish(initial.configVersion,{intentModel:null},{kind:'intent'}).then(()=>null,error=>error);expect(stale).toMatchObject({code:'config_conflict'});
    const disabled=await f.settings.publish(published.configVersion,{intentModel:{...model,enabled:false}},{kind:'intent'});expect(disabled.intentModel?.enabled).toBe(false);
    expect(f.sql('SELECT * FROM runs')).toEqual([]);expect(f.sql('SELECT * FROM model_calls')).toEqual([]);expect(f.intentRequests).toHaveLength(0);expect(f.requests).toHaveLength(0);
  }finally{await f.close();}
},20000);

for(const [mode,calls] of [['rule',0],['classify',1],['verify',2]] as const)test(`p14 actual Host ${mode} uses ${calls} intent calls and commits one program query without main credentials`,async()=>{
  const f=await fixture({mainAuth:false,verify:mode==='verify'});try{
    await f.settings.publish(f.settings.read().configVersion,{intentModel:f.intentModel()},{kind:'intent'});
    const session=(await f.create('host-root')).session.id;await f.data();
    const text=mode==='rule'?'查询2026-01-01在浙江的全部医疗器械。':'列出浙江2026-01-01的器械清单';
    const accepted=await f.send(session,text,'host-intent');await f.idle();
    expect(unwrap(await f.host.request('run.read',{runId:accepted.runId!}))).toMatchObject({kind:'one',run:{status:'completed'}});
    const intent=IntentReadResultSchema.parse(unwrap(await f.host.request('intent.read',{runId:accepted.runId!})));
    expect(intent).toMatchObject({runId:accepted.runId,inputId:accepted.inputId,sessionId:session,decision:{route:'simple'},execution:{runStatus:'completed',finalHistorySaved:true}});
    expect(intent.execution.answerId ?? 0).toBeGreaterThan(0);
    expect(intent.calls.map(call=>call.stage)).toEqual(calls===0?[]:calls===1?['classify']:['classify','verify']);
    expect(intent.execution.queryIds).toHaveLength(1);expect(intent.effectiveContext?.sourceRunId).toBe(accepted.runId ?? 0);
    expect(f.intentRequests).toHaveLength(calls);expect(f.requests).toHaveLength(0);
    expect(f.sql("SELECT kind FROM model_calls")).toEqual(Array.from({length:calls},()=>({kind:'intent'})));
    const messages=SessionMessagePageSchema.parse(unwrap(await f.host.request('session.messages.read',{sessionId:session})));
    expect(messages.items.filter(item=>item.displayRole==='user')).toHaveLength(1);expect(messages.items.filter(item=>item.displayRole==='program')).toHaveLength(1);
    expect(f.sql('SELECT id FROM runs')).toHaveLength(1);expect(f.sql('SELECT id FROM answers')).toHaveLength(1);
    const before={events:f.sql('SELECT * FROM runtime_events'),queries:f.sql('SELECT * FROM queries'),contexts:f.sql('SELECT * FROM query_contexts')};
    const page=EventPageSchema.parse(unwrap(await f.host.request('event.read',{runId:accepted.runId!,afterSequence:0,throughSequence:null,limit:100})));
    expect(page.events.map(event=>event.sequence)).toEqual(page.events.map((_,index)=>index+1));expect(page.events.length).toBeGreaterThan(8);
    expect(page.events.filter(event=>['intent_rule_evaluated','intent_started','intent_finished','route_decided'].includes(event.type)).map(event=>event.type))
      .toEqual(['intent_rule_evaluated',...Array.from({length:calls},()=>['intent_started','intent_finished'] as const).flat(),'route_decided']);
    for(const call of intent.calls)expect(page.events.filter(event=>event.sourceConnection===`intent:${call.callId}`).map(event=>event.sourceSequence)).toEqual([1,2]);
    const projection=new RunEventProjection(accepted.runId!,session);
    expect(projection.applyPage({...page,events:page.events.slice(0,6),nextSequence:6,hasMore:true})).toBe(true);
    expect(projection.applyPage({...page,events:page.events.slice(7,8),nextSequence:8,hasMore:true})).toBe(false);expect(projection.state.cursor).toBe(6);
    const missing=EventPageSchema.parse(unwrap(await f.host.request('event.read',{runId:accepted.runId!,afterSequence:6,throughSequence:8,limit:100})));
    expect(missing.events.map(event=>event.sequence)).toEqual([7,8]);expect(projection.applyPage(missing)).toBe(true);
    const tail=EventPageSchema.parse(unwrap(await f.host.request('event.read',{runId:accepted.runId!,afterSequence:8,throughSequence:page.nextSequence,limit:100})));
    expect(projection.applyPage(tail)).toBe(true);expect(projection.applyPage(page)).toBe(true);expect(projection.state.events).toEqual(page.events);
    expect(projection.state.terminal).toBe(true);
    expect({events:f.sql('SELECT * FROM runtime_events'),queries:f.sql('SELECT * FROM queries'),contexts:f.sql('SELECT * FROM query_contexts')}).toEqual(before);
    expect(f.intentRequests).toHaveLength(calls);expect(f.requests).toHaveLength(0);
  }finally{await f.close();}
},40000);

test('p14 actual Host strong restart retains program context without replay and checkpoint restores the next real payload',async()=>{
  const f=await fixture();try{
    await f.settings.publish(f.settings.read().configVersion,{intentModel:f.intentModel()},{kind:'intent'});
    const session=(await f.create('restart-root')).session.id;await f.data();
    const firstText='查询2026-01-01在浙江的全部医疗器械。',secondText='查询2026-01-02在浙江的全部医疗器械。';
    const first=await f.send(session,firstText,'restart-first');await f.idle();
    const points=SessionCheckpointPageSchema.parse(unwrap(await f.host.request('session.checkpoints.read',{sessionId:session})));
    expect(points.items).toHaveLength(1);
    const second=await f.send(session,secondText,'restart-second');await f.idle();
    const before={queries:f.sql('SELECT * FROM queries ORDER BY id'),answers:f.sql('SELECT * FROM answers ORDER BY id'),calls:f.sql('SELECT * FROM model_calls ORDER BY id')};
    const instance=f.host.read().instanceId!,child=(f.host as unknown as {child:ChildProcessWithoutNullStreams}).child;
    const exited=new Promise<void>(done=>child.once('close',()=>done()));
    expect(child.kill('SIGKILL')).toBe(true);await exited;
    expect(await f.host.restart(instance)).toMatchObject({state:'ready',schemaVersion:13});await f.idle();
    const detail=SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:session})));
    expect(detail).toMatchObject({runtime:{availability:'unloaded'},currentQueryContext:{sourceRunId:second.runId}});
    const messages=SessionMessagePageSchema.parse(unwrap(await f.host.request('session.messages.read',{sessionId:session})));
    expect(messages.items.filter(item=>item.displayRole==='program')).toHaveLength(2);
    expect(f.sql('SELECT * FROM queries ORDER BY id')).toEqual(before.queries);expect(f.sql('SELECT * FROM answers ORDER BY id')).toEqual(before.answers);
    expect(f.sql('SELECT * FROM model_calls ORDER BY id')).toEqual(before.calls);expect(f.requests).toHaveLength(0);expect(f.intentRequests).toHaveLength(0);
    await f.send(session,'ENGINEERING restarted follow up','restart-agent',false);await f.idle();
    expect(f.requests).toHaveLength(1);const payload=JSON.stringify(f.requests[0]);
    expect(payload.includes(firstText)).toBe(true);expect(payload.includes(secondText)).toBe(true);expect(payload.includes('adoptedQueryContext')).toBe(true);
    for(const item of messages.items.filter(item=>item.displayRole==='program'))expect(payload.includes(JSON.stringify(item.text).slice(1,-1))).toBe(true);
    const current=SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:session}))),workspace=await f.workspace();
    const receipt=SessionCheckpointReceiptSchema.parse(unwrap(await f.host.request('session.restoreCheckpoint',{
      sessionId:session,targetLeafId:points.items[0]!.nativeLeafId,expectedStorageVersion:current.session.storageVersion,expectedWorkspaceRevision:workspace.revision},'restart-restore')));
    expect(receipt.storageVersion).toBe(current.session.storageVersion+1);
    expect(SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:session}))).currentQueryContext?.sourceRunId).toBe(first.runId ?? 0);
    expect(f.requests).toHaveLength(1);expect(f.intentRequests).toHaveLength(0);expect(f.sql('SELECT * FROM queries ORDER BY id')).toEqual(before.queries);
    await f.send(session,'列出浙江2026-01-01的器械清单','restored-classify');await f.idle();
    expect(f.intentRequests).toHaveLength(1);
    const next=JSON.stringify(f.intentRequests[0]);expect(next).toContain(firstText);expect(next).not.toContain(secondText);expect(next).not.toContain('ENGINEERING restarted follow up');
    expect(f.sql('SELECT id FROM queries')).toHaveLength(3);expect(f.requests).toHaveLength(1);
  }finally{await f.close();}
},60000);

test('p14 actual Host interrupted classify is terminal after strong restart and never replaces prior context or replays',async()=>{
  const f=await fixture({mainAuth:false});try{
    await f.settings.publish(f.settings.read().configVersion,{intentModel:f.intentModel()},{kind:'intent'});
    const session=(await f.create('interrupted-root')).session.id;await f.data();
    const first=await f.send(session,'查询2026-01-01在浙江的全部医疗器械。','interrupted-prior');await f.idle();
    f.holdIntent(true);const pending=await f.send(session,'列出浙江2026-01-01的器械清单','interrupted-classify');
    await until(async()=>f.intentRequests.length===1);
    expect(f.sql("SELECT state FROM model_calls WHERE kind='intent'")).toEqual([{state:'started'}]);
    const instance=f.host.read().instanceId!,child=(f.host as unknown as {child:ChildProcessWithoutNullStreams}).child;
    const exited=new Promise<void>(done=>child.once('close',()=>done()));expect(child.kill('SIGKILL')).toBe(true);await exited;f.holdIntent(false);
    expect(await f.host.restart(instance)).toMatchObject({state:'ready',schemaVersion:13});await f.idle();
    expect(unwrap(await f.host.request('run.read',{runId:pending.runId!}))).toMatchObject({kind:'one',run:{status:'failed'}});
    const intent=IntentReadResultSchema.parse(unwrap(await f.host.request('intent.read',{runId:pending.runId!})));
    expect(intent).toMatchObject({decision:null,calls:[{stage:'classify',state:'failed'}],execution:{runStatus:'failed',answerId:null,finalHistorySaved:false}});
    expect(f.sql("SELECT state FROM model_calls WHERE kind='intent'")).toEqual([{state:'failed'}]);
    expect(f.sql('SELECT id FROM queries')).toHaveLength(1);expect(f.sql('SELECT id FROM answers')).toHaveLength(1);expect(f.intentRequests).toHaveLength(1);
    expect(SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:session}))).currentQueryContext?.sourceRunId).toBe(first.runId ?? 0);
    const next=await f.send(session,'列出浙江2026-01-01的器械清单','interrupted-explicit-next');await f.idle();
    expect(next.runId).not.toBe(pending.runId);expect(f.intentRequests).toHaveLength(2);expect(f.requests).toHaveLength(0);
    expect(f.sql('SELECT id FROM queries')).toHaveLength(2);expect(f.sql('SELECT id FROM answers')).toHaveLength(2);
  }finally{await f.close();}
},60000);

for(const stage of ['classify','verify'] as const)test(`p14 actual Host Stop during ${stage} preserves prior conditions and rejects late result execution`,async()=>{
  const f=await fixture({mainAuth:false,verify:stage==='verify'});try{
    await f.settings.publish(f.settings.read().configVersion,{intentModel:f.intentModel()},{kind:'intent'});
    const session=(await f.create('stop-root')).session.id;await f.data();
    const prior=await f.send(session,'查询2026-01-01在浙江的全部医疗器械。','stop-prior');await f.idle();
    f.holdIntent(true,stage);const accepted=await f.send(session,'列出浙江2026-01-01的器械清单','stop-intent');
    const calls=stage==='classify'?1:2;await until(async()=>f.intentRequests.length===calls);
    const stop=CancelRunResultSchema.parse(unwrap(await f.host.request('run.cancel',{runId:accepted.runId!})));
    expect(stop).toMatchObject({cancelRequested:true,stopped:true,committedStatus:'cancelled',persistencePending:false});await f.idle();
    f.holdIntent(false);
    const intent=IntentReadResultSchema.parse(unwrap(await f.host.request('intent.read',{runId:accepted.runId!})));
    expect(intent).toMatchObject({decision:null,execution:{runStatus:'cancelled',answerId:null,finalHistorySaved:false}});
    expect(intent.calls.map(call=>call.state)).toEqual(stage==='classify'?['cancelled']:['completed','cancelled']);
    expect(f.intentRequests).toHaveLength(calls);expect(f.requests).toHaveLength(0);
    expect(f.sql('SELECT id FROM queries')).toHaveLength(1);expect(f.sql('SELECT id FROM answers')).toHaveLength(1);
    expect(SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:session}))).currentQueryContext?.sourceRunId).toBe(prior.runId ?? 0);
    expect(f.sql(`SELECT type FROM runtime_events WHERE run_id=${accepted.runId!} AND type='run_cancelled'`)).toHaveLength(1);
    const again=CancelRunResultSchema.parse(unwrap(await f.host.request('run.cancel',{runId:accepted.runId!})));
    expect(again.committedStatus).toBe('cancelled');expect(f.intentRequests).toHaveLength(calls);
    const next=await f.send(session,'查询2026-01-02在浙江的全部医疗器械。','stop-next');await f.idle();
    expect(next.runId).not.toBe(accepted.runId);expect(f.intentRequests).toHaveLength(calls);expect(f.sql('SELECT id FROM queries')).toHaveLength(2);
  }finally{await f.close();}
},40000);

test('p14 actual Host Session switch isolates conditions and a published intent change applies only to the next root',async()=>{
  const f=await fixture({mainAuth:false});try{
    const enabled=await f.settings.publish(f.settings.read().configVersion,{intentModel:f.intentModel()},{kind:'intent'});
    const a=(await f.create('isolation-A')).session.id,b=(await f.create('isolation-B')).session.id;
    unwrap(await f.host.request('session.select',{sessionId:a,expectedWorkspaceRevision:(await f.workspace()).revision}));
    const batches=(await f.data()).batchRefs.map(batch=>batch.id);
    await f.send(a,'查询2026-01-01在浙江的全部医疗器械。','isolation-prior');await f.idle();
    f.holdIntent(true);const pending=await f.send(a,'列出浙江2026-01-01的器械清单','isolation-running');await until(async()=>f.intentRequests.length===1);
    unwrap(await f.host.request('session.select',{sessionId:b,expectedWorkspaceRevision:(await f.workspace()).revision}));
    expect(SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:b}))).currentQueryContext).toBeNull();
    expect(SessionMessagePageSchema.parse(unwrap(await f.host.request('session.messages.read',{sessionId:b}))).items).toHaveLength(0);
    const changed=await f.settings.publish(enabled.configVersion,{intentModel:{...f.intentModel(),timeoutMs:16000}},{kind:'intent'});
    expect(f.sql("SELECT json_extract(model_json,'$.selection.configVersion') AS version,json_extract(model_json,'$.selection.timeoutMs') AS timeout FROM model_calls WHERE kind='intent'"))
      .toEqual([{version:enabled.configVersion,timeout:15000}]);
    f.holdIntent(false);await f.idle();
    expect(SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:a}))).currentQueryContext?.sourceRunId).toBe(pending.runId ?? 0);
    expect(SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:b}))).currentQueryContext).toBeNull();
    unwrap(await f.host.request('workspace.update',{expectedRevision:(await f.workspace()).revision,change:{batchIds:batches}}));
    const next=await f.send(b,'列出浙江2026-01-01的器械清单','isolation-new-root');await f.idle();
    expect(f.intentRequests).toHaveLength(2);expect(f.intentRequests[1]!.input.previousQueryContext).toBeNull();expect(f.intentRequests[1]!.input.recentTurns).toHaveLength(0);
    expect(f.sql("SELECT json_extract(model_json,'$.selection.configVersion') AS version,json_extract(model_json,'$.selection.timeoutMs') AS timeout FROM model_calls WHERE kind='intent' ORDER BY id"))
      .toEqual([{version:enabled.configVersion,timeout:15000},{version:changed.configVersion,timeout:16000}]);
    expect(SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:b}))).currentQueryContext?.sourceRunId).toBe(next.runId ?? 0);
    expect(SessionMessagePageSchema.parse(unwrap(await f.host.request('session.messages.read',{sessionId:b}))).items.filter(item=>item.displayRole==='program')).toHaveLength(1);
    expect(f.requests).toHaveLength(0);
  }finally{await f.close();}
},40000);
