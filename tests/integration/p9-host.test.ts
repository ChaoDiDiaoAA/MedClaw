import { expect,test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync,rmSync,existsSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MainSettings,atomicWriteJson } from '../../apps/desktop/src/main/settings';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { safeError,type Result } from '../../packages/contracts/src/error';
import { NewSessionResultSchema,SessionDetailSchema,SessionCheckpointPageSchema,SessionCheckpointReceiptSchema,SubmitResultSchema,type SubmitInput } from '../../packages/contracts/src/session';
import { SessionMessagePageSchema } from '../../packages/contracts/src/messages';
import { WorkspaceViewSchema } from '../../packages/contracts/src/workspace';
import { RuntimeControlViewSchema,ReadRunResultSchema } from '../../packages/contracts/src/run';
import { EventPageSchema } from '../../packages/contracts/src/event';

function unwrap<T>(result:Result<T>):T {if(!result.ok)throw result.error;return result.data;}
async function until(check:()=>Promise<boolean>) {const end=Date.now()+10000;while(!await check()){if(Date.now()>end)throw new Error('ENGINEERING Host condition timeout');await Bun.sleep(10);}}
async function fixture(barrier?:'final-before'|'final-after'|'checkpoint-after') {
  const root=mkdtempSync(join(tmpdir(),'medclaw-p9-host-')),requests:Record<string,unknown>[]=[];let hold=false;
  const armed=join(root,'arm'),reached=join(root,'reached'),entry=join(root,'barrier-host.ts');
  if(barrier)writeFileSync(entry,`import{existsSync,unlinkSync,writeFileSync}from'node:fs';import{Repositories}from ${JSON.stringify(resolve('packages/storage/src/repositories.ts'))};import{PiAgentRuntime}from ${JSON.stringify(resolve('packages/runtime-pi/src/agent-runtime.ts'))};
    const block=()=>{if(!existsSync(${JSON.stringify(armed)}))return;unlinkSync(${JSON.stringify(armed)});writeFileSync(${JSON.stringify(reached)},${JSON.stringify(barrier)});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);};
    ${barrier==='checkpoint-after'?`const restore=PiAgentRuntime.prototype.restore;PiAgentRuntime.prototype.restore=function(...args){block();return restore.apply(this,args);};`:`const finalize=Repositories.prototype.finalizeAgent;Repositories.prototype.finalizeAgent=function(...args){${barrier==='final-before'?'block();':''}const result=finalize.apply(this,args);${barrier==='final-after'?'block();':''}return result;};`}
    await import(${JSON.stringify(resolve('apps/host/src/main.ts'))});`);
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){requests.push(await request.json() as Record<string,unknown>);const waiting=hold;return new Response(new ReadableStream({start(controller){const send=(value:unknown)=>controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
    send({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:waiting?'ENGINEERING temporary':'ENGINEERING answer'},finish_reason:waiting?null:'stop'}]});if(!waiting){controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));controller.close();}}}),{headers:{'content-type':'text/event-stream'}});}});
  const host=new HostController({dataRoot:root,hostEntry:barrier?entry:resolve('apps/host/src/main.ts'),bunExecutable:process.execPath,onCredentialRequest:async frame=>frame.method==='export.destination.settlePrevious'?{ok:true,data:{stopped:true}}:frame.method==='credential.list'?{ok:true,data:[{providerId:'p9-fixture',type:'api_key'}]}:frame.method==='credential.read'?{ok:true,data:frame.payload.providerId==='p9-fixture'?{type:'api_key',key:'ENGINEERING'}:null}:{ok:false,error:safeError('access_denied')}});
  const initial=new MainSettings(host.paths.settingsPath).read(),definition={providerId:'p9-fixture',name:'ENGINEERING',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.port}/v1`,models:[{id:'fixture',name:'ENGINEERING',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,outputLimitConfirmed:true,pricingKnown:false,cost:null}]};
  atomicWriteJson(host.paths.settingsPath,PublishedSettingsSchema.parse({...initial,model:{provider:'p9-fixture',modelId:'fixture'},customProviders:[{definition,credentialRef:null}]}));
  expect(await host.start()).toMatchObject({state:'ready',schemaVersion:15});
  const sql=(query:string)=>{const db=new Database(host.paths.databasePath,{readonly:true});try{return db.query(query).all();}finally{db.close();}};
  const workspace=async()=>WorkspaceViewSchema.parse(unwrap(await host.request('workspace.read',{})));
  const create=async(op:string)=>NewSessionResultSchema.parse(unwrap(await host.request('session.create',{expectedWorkspaceRevision:(await workspace()).revision},op)));
  const select=async(sessionId:number)=>unwrap(await host.request('session.select',{sessionId,expectedWorkspaceRevision:(await workspace()).revision}));
  const idle=()=>until(async()=>RuntimeControlViewSchema.parse(unwrap(await host.request('run.control.read',{}))).acceptingNewRuns);
  async function send(sessionId:number,text:string,op:string) {
    const detail=SessionDetailSchema.parse(unwrap(await host.request('session.read',{sessionId}))),w=await workspace();
    const request:SubmitInput={sessionId,clientSequence:detail.session.nextSubmissionSequence,text,mode:'send',expectedRevision:w.revision,expectedBatchIds:[],expectedQueryId:null,model:{provider:'p9-fixture',modelId:'fixture',expectedConfigVersion:'1'},referenceDate:'2026-10-05',timezone:'Asia/Shanghai'};
    return SubmitResultSchema.parse(unwrap(await host.request('session.submit',request,op)));
  }
  async function close(){try{if(host.read().instanceId&&!host.read().canStart)await host.stop(host.read().instanceId!);}finally{server.stop(true);rmSync(root,{recursive:true,force:true});}}
  return {host,requests,sql,workspace,create,select,idle,send,close,hold:(value:boolean)=>{hold=value;},arm:()=>writeFileSync(armed,'ENGINEERING'),reached:()=>existsSync(reached)};
}

for(const barrier of ['final-before','final-after','checkpoint-after'] as const)test(`p9 real Host kill at ${barrier} proves committed facts and never replays execution`,async()=>{
  const f=await fixture(barrier);try{
    const a=await f.create('barrier-session'),first=await f.send(a.session.id,'ENGINEERING first completed turn','barrier-first');await f.idle();
    const oldHistory=f.sql('SELECT * FROM memories ORDER BY id'),oldAnswers=f.sql('SELECT * FROM answers ORDER BY id');
    f.arm();let pending:Promise<unknown>;
    if(barrier==='checkpoint-after'){
      const detail=SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:a.session.id}))),points=SessionCheckpointPageSchema.parse(unwrap(await f.host.request('session.checkpoints.read',{sessionId:a.session.id})));
      pending=f.host.request('session.restoreCheckpoint',{sessionId:a.session.id,targetLeafId:points.items[0]!.nativeLeafId,expectedStorageVersion:detail.session.storageVersion,expectedWorkspaceRevision:(await f.workspace()).revision},'barrier-position');
    }else pending=f.send(a.session.id,'ENGINEERING final barrier turn','barrier-second');
    await until(async()=>f.reached());const committed=f.sql('SELECT * FROM memories ORDER BY id'),answers=f.sql('SELECT * FROM answers ORDER BY id'),position=f.sql('SELECT current_leaf_id,storage_version FROM sessions');
    expect(answers).toHaveLength(barrier==='final-after'?2:1);if(barrier==='checkpoint-after'){expect(committed).toEqual(oldHistory);expect(answers).toEqual(oldAnswers);}else expect(committed.length).toBeGreaterThan(oldHistory.length);
    const instance=f.host.read().instanceId!,child=(f.host as unknown as {child:ChildProcessWithoutNullStreams}).child,exit=new Promise<void>(done=>child.once('close',()=>done()));expect(child.pid).toBeGreaterThan(0);expect(child.kill('SIGKILL')).toBe(true);await exit;await pending;
    const network=f.requests.length;expect(await f.host.restart(instance)).toMatchObject({state:'ready'});await f.idle();
    expect(f.requests).toHaveLength(network);expect(f.sql('SELECT * FROM memories ORDER BY id')).toEqual(committed);expect(f.sql('SELECT * FROM answers ORDER BY id')).toEqual(answers);expect(f.sql('SELECT current_leaf_id,storage_version FROM sessions')).toEqual(position);
    if(barrier==='checkpoint-after')expect(await f.host.request('evidence.readOperation',{kind:'session_checkpoint',operationRef:'barrier-position'})).toMatchObject({ok:true,data:{operationRef:'barrier-position',sessionId:a.session.id}});
    else {const recent=ReadRunResultSchema.parse(unwrap(await f.host.request('run.read',{recent:true})));expect(recent.kind).toBe('recent');if(recent.kind==='recent')expect(recent.runs[0]?.status).toBe(barrier==='final-after'?'completed':'failed');}
    const fresh=await f.send(a.session.id,'ENGINEERING explicit after barrier','barrier-new');expect(fresh.runId).not.toBe(first.runId);await f.idle();expect(f.requests).toHaveLength(network+1);
  }finally{await f.close();}
},40000);

test('p9 real Host restores same-model A/B after restart; checkpoint receipt, full history and branch continuation use public methods',async()=>{
  const f=await fixture();try {
    const a=await f.create('create-A'),b=await f.create('create-B');await f.select(a.session.id);const first=await f.send(a.session.id,'ENGINEERING A original','send-A');await f.idle();
    const points=SessionCheckpointPageSchema.parse(unwrap(await f.host.request('session.checkpoints.read',{sessionId:a.session.id})));expect(points.items).toHaveLength(1);
    await f.send(a.session.id,'ENGINEERING A correction','send-A2');await f.idle();await f.select(b.session.id);await f.send(b.session.id,'ENGINEERING B independent','send-B');await f.idle();
    const old=f.host.read().instanceId!;expect(await f.host.restart(old)).toMatchObject({state:'ready',schemaVersion:15});
    const before=f.sql('SELECT * FROM memories ORDER BY id'),requests=f.requests.length,detail=SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:a.session.id})));
    expect(detail).toMatchObject({runtime:{availability:'unloaded'},history:{available:true}});expect(detail.history.messages).toHaveLength(4);
    expect(SessionMessagePageSchema.parse(unwrap(await f.host.request('session.messages.read',{sessionId:a.session.id}))).items.filter(item=>item.displayRole==='user')).toHaveLength(2);
    expect(f.requests).toHaveLength(requests);expect(f.sql('SELECT * FROM memories ORDER BY id')).toEqual(before);
    await f.select(a.session.id);await f.send(a.session.id,'ENGINEERING A restarted follow up','send-A3');await f.idle();expect(JSON.stringify(f.requests[3])).toContain('ENGINEERING A correction');expect(JSON.stringify(f.requests[3])).not.toContain('ENGINEERING B independent');
    const current=SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:a.session.id}))),w=await f.workspace(),input={sessionId:a.session.id,targetLeafId:points.items[0]!.nativeLeafId,expectedStorageVersion:current.session.storageVersion,expectedWorkspaceRevision:w.revision};
    const receipt=SessionCheckpointReceiptSchema.parse(unwrap(await f.host.request('session.restoreCheckpoint',input,'resume-A')));expect(receipt.storageVersion).toBe(input.expectedStorageVersion+1);
    await f.select(b.session.id);const later=await f.workspace();expect(await f.host.request('evidence.readOperation',{kind:'session_checkpoint',operationRef:'resume-A'})).toEqual({ok:true,data:receipt});
    expect(await f.host.request('session.restoreCheckpoint',input,'resume-A')).toEqual({ok:true,data:receipt});expect(await f.workspace()).toEqual(later);
    expect(await f.host.request('evidence.readOperation',{kind:'session_checkpoint',operationRef:'never-committed'})).toEqual({ok:true,data:null});
    await f.select(a.session.id);const branch=await f.send(a.session.id,'ENGINEERING branch after first','branch-A');await f.idle();expect(branch.runId).not.toBe(first.runId);
    expect(JSON.stringify(f.requests[4])).toContain('ENGINEERING A original');expect(JSON.stringify(f.requests[4])).not.toContain('ENGINEERING A correction');expect(f.sql('SELECT id FROM answers')).toHaveLength(5);
    const events=EventPageSchema.parse(unwrap(await f.host.request('event.read',{runId:first.runId,afterSequence:0,limit:100})));expect(events.events.some(event=>event.type==='history_saved')).toBe(true);
  }finally{await f.close();}
},40000);

test('p9 real Host strong kill keeps only committed prefix; restart never resumes the old Run or turns stream text into Answer',async()=>{
  const f=await fixture();try {
    const a=await f.create('create-kill');await f.send(a.session.id,'ENGINEERING durable prefix','durable');await f.idle();f.hold(true);
    const accepted=await f.send(a.session.id,'ENGINEERING interrupted request','interrupted');await until(async()=>f.requests.length===2);
    const original=f.sql('SELECT * FROM memories ORDER BY id'),instance=f.host.read().instanceId!,child=(f.host as unknown as {child:ChildProcessWithoutNullStreams}).child,exited=new Promise<void>(resolve=>child.once('close',resolve));
    expect(child.kill('SIGKILL')).toBe(true);await exited;f.hold(false);expect(await f.host.restart(instance)).toMatchObject({state:'ready'});
    expect(f.sql('SELECT * FROM memories ORDER BY id')).toEqual(original);expect(f.sql('SELECT id FROM answers')).toHaveLength(1);expect(f.requests).toHaveLength(2);
    expect(ReadRunResultSchema.parse(unwrap(await f.host.request('run.read',{runId:accepted.runId})))).toMatchObject({kind:'one',run:{status:'failed',error:{code:'runtime_interrupted'}}});
    const page=SessionMessagePageSchema.parse(unwrap(await f.host.request('session.messages.read',{sessionId:a.session.id})));expect(JSON.stringify(page)).not.toContain('ENGINEERING temporary');
    const next=await f.send(a.session.id,'ENGINEERING explicit new Run','after-kill');await f.idle();expect(next.runId).not.toBe(accepted.runId);expect(f.requests).toHaveLength(3);expect(f.sql('SELECT id FROM answers')).toHaveLength(2);
  }finally{await f.close();}
},40000);
