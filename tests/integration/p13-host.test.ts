import { expect,test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MainSettings,atomicWriteJson } from '../../apps/desktop/src/main/settings';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { safeError,type Result } from '../../packages/contracts/src/error';
import { NewSessionResultSchema,SessionDetailSchema,SubmitResultSchema,type SubmitInput } from '../../packages/contracts/src/session';
import { SessionMessagePageSchema } from '../../packages/contracts/src/messages';
import { WorkspaceViewSchema } from '../../packages/contracts/src/workspace';
import { ReadRunResultSchema,RuntimeControlViewSchema } from '../../packages/contracts/src/run';
import { p13AgentInput } from '../fixtures/p13-subagent';

function unwrap<T>(result:Result<T>):T {if(!result.ok)throw result.error;return result.data;}
async function until(check:()=>Promise<boolean>){const end=Date.now()+15000;while(!await check()){if(Date.now()>end)throw new Error('ENGINEERING P13 Host timeout');await Bun.sleep(10);}}
async function fixture(barrier?:'child-before'|'child-after'|'child-save-gap'|'child-http-hold'){
  const root=mkdtempSync(join(tmpdir(),'medclaw-p13-host-')),marker=join(root,'reached'),entry=join(root,'barrier-host.ts'),requests:Record<string,unknown>[]=[];
  if(barrier&&barrier!=='child-http-hold')writeFileSync(entry,`import {Repositories} from ${JSON.stringify(resolve('packages/storage/src/repositories.ts'))};import {writeFileSync} from 'node:fs';
    const finalize=Repositories.prototype.finalizeChild;Repositories.prototype.finalizeChild=function(...args){
      ${barrier==='child-save-gap'?`writeFileSync(${JSON.stringify(marker)},'ENGINEERING');throw new Error('ENGINEERING child final save failure');`:''}
      ${barrier==='child-before'?`writeFileSync(${JSON.stringify(marker)},'ENGINEERING');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);`:''}
      const result=finalize.apply(this,args);
      ${barrier==='child-after'?`writeFileSync(${JSON.stringify(marker)},'ENGINEERING');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);`:''}
      return result;};await import(${JSON.stringify(resolve('apps/host/src/main.ts'))});`);
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){requests.push(await request.json() as Record<string,unknown>);const step=requests.length;
    if(barrier==='child-http-hold'&&step===2)return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'ENGINEERING child streaming'},finish_reason:null}]})}\n\n`));}}),{headers:{'content-type':'text/event-stream'}});
    const name=step===1?'Agent':step===2?'read_data_scope':null;
    const delta=name?{role:'assistant',tool_calls:[{index:0,id:'p13-host-'+step,type:'function',function:{name,arguments:JSON.stringify(step===1?p13AgentInput:{})}}]}:{role:'assistant',content:step===3?'ENGINEERING CHILD HOST RESULT':'ENGINEERING PARENT HOST RESULT'};
    return new Response(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta,finish_reason:name?'tool_calls':'stop'}],usage:{prompt_tokens:step*10,completion_tokens:step,total_tokens:step*11}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  }});
  const host=new HostController({dataRoot:root,hostEntry:barrier&&barrier!=='child-http-hold'?entry:resolve('apps/host/src/main.ts'),bunExecutable:process.execPath,
    onCredentialRequest:async frame=>frame.method==='credential.list'?{ok:true,data:[{providerId:'p13-fixture',type:'api_key'}]}:frame.method==='credential.read'?{ok:true,data:frame.payload.providerId==='p13-fixture'?{type:'api_key',key:'ENGINEERING'}:null}:{ok:false,error:safeError('access_denied')}});
  const initial=new MainSettings(host.paths.settingsPath).read();
  atomicWriteJson(host.paths.settingsPath,PublishedSettingsSchema.parse({...initial,model:{provider:'p13-fixture',modelId:'fixture'},customProviders:[{credentialRef:null,definition:{providerId:'p13-fixture',name:'ENGINEERING',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.port}/v1`,models:[{id:'fixture',name:'ENGINEERING',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,outputLimitConfirmed:true,pricingKnown:false,cost:null}]}}]}));
  expect(await host.start()).toMatchObject({state:'ready',schemaVersion:13});
  const sql=(query:string)=>{const db=new Database(host.paths.databasePath,{readonly:true});try{return db.query<Record<string,unknown>,[]>(query).all();}finally{db.close();}};
  const workspace=async()=>WorkspaceViewSchema.parse(unwrap(await host.request('workspace.read',{})));
  const create=async(op:string)=>NewSessionResultSchema.parse(unwrap(await host.request('session.create',{expectedWorkspaceRevision:(await workspace()).revision},op)));
  const idle=()=>until(async()=>RuntimeControlViewSchema.parse(unwrap(await host.request('run.control.read',{}))).acceptingNewRuns);
  const send=async(sessionId:number,op:string)=>{const detail=SessionDetailSchema.parse(unwrap(await host.request('session.read',{sessionId}))),w=await workspace();
    const input:SubmitInput={sessionId,clientSequence:detail.session.nextSubmissionSequence,text:'ENGINEERING independent read-only verification',mode:'send',expectedRevision:w.revision,expectedBatchIds:[],expectedQueryId:null,model:{provider:'p13-fixture',modelId:'fixture',expectedConfigVersion:'1'},referenceDate:'2026-10-07',timezone:'Asia/Shanghai'};
    return SubmitResultSchema.parse(unwrap(await host.request('session.submit',input,op)));};
  return {host,requests,sql,workspace,create,idle,send,reached:()=>existsSync(marker),close:async()=>{try{if(host.read().instanceId&&!host.read().canStart)await host.stop(host.read().instanceId!);}finally{server.stop(true);rmSync(root,{recursive:true,force:true});}}};
}

for(const barrier of ['child-before','child-after'] as const)test('p13 actual Host kill at '+barrier+' reads committed child facts without resuming any Loop',async()=>{
  const f=await fixture(barrier);try{
    const session=await f.create('p13-cold-session');await f.send(session.session.id,'p13-cold-send');await until(async()=>f.reached());
    const histories=f.sql('SELECT * FROM memories ORDER BY id'),before=f.sql("SELECT id,child_result_json FROM runs WHERE kind='child'");
    expect(before).toHaveLength(1);expect(before[0]!.child_result_json===null).toBe(barrier==='child-before');expect(f.requests).toHaveLength(3);
    const old=f.host.read().instanceId!,child=Reflect.get(f.host,'child') as ChildProcessWithoutNullStreams,closed=new Promise<void>(done=>child.once('close',()=>done()));
    expect(child.kill('SIGKILL')).toBe(true);await closed;expect(await f.host.restart(old)).toMatchObject({state:'ready',schemaVersion:13});
    expect(f.requests).toHaveLength(3);expect(f.sql('SELECT * FROM memories ORDER BY id')).toEqual(histories);
    expect(f.sql("SELECT id,child_result_json FROM runs WHERE kind='child'")).toEqual(before);
    const children=ReadRunResultSchema.parse(unwrap(await f.host.request('run.read',{recent:true,parentRunId:1})));expect(children.kind).toBe('recent');
    if(children.kind!=='recent'||children.runs[0]?.kind!=='child')throw new Error('No child read');
    const saved=ReadRunResultSchema.parse(unwrap(await f.host.request('run.read',{runId:children.runs[0].id})));expect(saved.kind==='one'&&saved.run?.status).toBe(barrier==='child-before'?'failed':'completed');
    const history=SessionMessagePageSchema.parse(unwrap(await f.host.request('session.messages.read',{childRunId:children.runs[0].id})));expect(history.items.length).toBeGreaterThan(0);
    expect(await f.host.request('session.select',{sessionId:children.runs[0].sessionId,expectedWorkspaceRevision:(await f.workspace()).revision})).toMatchObject({ok:false});
    expect(f.sql('SELECT id FROM answers')).toEqual([]);expect(f.sql("SELECT id FROM sessions WHERE kind='user'")).toHaveLength(1);expect(f.requests).toHaveLength(3);
  }finally{await f.close();}
},60000);

test('p13 actual Host releases its writer and manager before a new instance rereads independent child history',async()=>{
  const f=await fixture();try{
    const session=await f.create('p13-host-session'),accepted=await f.send(session.session.id,'p13-host-send');await f.idle();expect(f.requests).toHaveLength(4);
    const children=ReadRunResultSchema.parse(unwrap(await f.host.request('run.read',{recent:true,parentRunId:accepted.runId!})));if(children.kind!=='recent'||children.runs[0]?.kind!=='child')throw new Error('No child');
    const id=children.runs[0].id,history=unwrap(await f.host.request('session.messages.read',{childRunId:id})),facts=f.sql('SELECT * FROM memories ORDER BY id');
    expect(await f.host.request('tool.read',{runId:id})).toMatchObject({ok:true,data:{runId:id,scope:{readOnly:true},items:[{name:'read_data_scope',runId:id,sessionId:children.runs[0].sessionId,status:'succeeded'}]}});
    expect(await f.host.request('query.list',{childRunId:id})).toMatchObject({ok:true,data:{items:[]}});
    expect(await f.host.request('query.list',{sessionId:children.runs[0].sessionId})).toMatchObject({ok:false});
    expect(await f.host.request('run.read',{runId:accepted.runId!})).toMatchObject({ok:true,data:{run:{groupUsage:{parent:{modelCalls:2,toolCalls:1,inputTokens:50,outputTokens:5,cost:null},children:{modelCalls:2,toolCalls:1,inputTokens:50,outputTokens:5,cost:null}}}}});
    expect(await f.host.request('run.read',{runId:id})).toMatchObject({ok:true,data:{run:{delivery:{sdkReturned:true,sdkResultIsError:false,consumptionEvidence:'provider_input_verified'},originSnapshotId:1,parentInputId:accepted.inputId}}});
    const old=f.host.read().instanceId!;expect(await f.host.restart(old)).toMatchObject({state:'ready',schemaVersion:13});await f.idle();
    expect(f.host.read().instanceId).not.toBe(old);expect(unwrap(await f.host.request('session.messages.read',{childRunId:id}))).toEqual(history);expect(f.sql('SELECT * FROM memories ORDER BY id')).toEqual(facts);
    expect(f.requests).toHaveLength(4);expect(f.sql("SELECT id FROM sessions WHERE kind='child'")).toHaveLength(1);
  }finally{await f.close();}
},60000);

test('p13 actual Host loss of a child final save fact keeps recovery blocked without synthesizing a result',async()=>{
  const f=await fixture('child-save-gap');try{
    const session=await f.create('p13-gap-session');await f.send(session.session.id,'p13-gap-send');
    await until(async()=>f.reached()&&f.sql("SELECT id FROM runs WHERE kind='agent' AND status='failed' AND json_extract(cleanup_json,'$.requiredPersistenceComplete')=0").length===1);
    const old=f.host.read().instanceId!,child=Reflect.get(f.host,'child') as ChildProcessWithoutNullStreams,closed=new Promise<void>(done=>child.once('close',()=>done()));expect(child.kill('SIGKILL')).toBe(true);await closed;
    expect(await f.host.restart(old)).toMatchObject({state:'ready'});expect(f.requests).toHaveLength(3);
    expect(await f.host.request('run.control.read',{})).toMatchObject({ok:true,data:{acceptingNewRuns:false}});
    expect(await f.host.request('run.retrySave',{runId:1})).toMatchObject({ok:false,error:{code:'run_save_unavailable'}});
    expect(f.sql("SELECT child_result_json FROM runs WHERE kind='child'")).toEqual([{child_result_json:null}]);expect(f.requests).toHaveLength(3);
  }finally{await f.close();}
},60000);

test('p13 actual Main stops only its owned Host while a child HTTP stream is active and restart sends no requests',async()=>{
  const f=await fixture('child-http-hold');try{
    const session=await f.create('p13-stop-host-session');await f.send(session.session.id,'p13-stop-host-send');await until(async()=>f.requests.length===2);
    const old=f.host.read().instanceId!;await expect(f.host.stop('different-instance')).rejects.toThrow('host_protocol_mismatch');expect(f.host.read()).toMatchObject({state:'ready',instanceId:old});expect(f.requests).toHaveLength(2);
    expect(await f.host.stop(old)).toMatchObject({state:'stopped',canStart:true});
    const histories=f.sql('SELECT * FROM memories ORDER BY id'),children=f.sql("SELECT id,status,child_result_json FROM runs WHERE kind='child'");expect(children).toHaveLength(1);
    expect(children[0]!.child_result_json).not.toBeNull();expect(f.sql("SELECT json_extract(cleanup_json,'$.stopConfirmed') AS stopped,json_extract(cleanup_json,'$.resourcesReleased') AS released FROM runs WHERE kind='child'")).toEqual([{stopped:1,released:1}]);
    expect(await f.host.start()).toMatchObject({state:'ready'});expect(f.sql('SELECT * FROM memories ORDER BY id')).toEqual(histories);expect(f.sql("SELECT id,status,child_result_json FROM runs WHERE kind='child'")).toEqual(children);expect(f.requests).toHaveLength(2);
  }finally{await f.close();}
},60000);
