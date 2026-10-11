import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {HostController} from '../../apps/desktop/src/main/host-controller';
import {MainSettings,atomicWriteJson} from '../../apps/desktop/src/main/settings';
import {PublishedSettingsSchema,ModelDirectoryViewSchema} from '../../packages/contracts/src/model';
import {openDatabase} from '../../packages/storage/src/database';
import {Repositories} from '../../packages/storage/src/repositories';
import {memoryAssistant,memoryAt,sqliteHistory} from '../fixtures/p9-memory';

for(const barrier of ['generation_before','generation_after','commit_before','commit_after'] as const)test(`p10 actual Host crash at ${barrier} preserves original facts and never replays compaction`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'medclaw-p10-host-')),arm=join(root,'arm'),reached=join(root,'reached'),entry=join(root,'controlled-host.ts'),requests:unknown[]=[];
  writeFileSync(entry,`import{existsSync,unlinkSync,writeFileSync}from'node:fs';import{PiAgentRuntime}from ${JSON.stringify(resolve('packages/runtime-pi/src/agent-runtime.ts'))};import{Repositories}from ${JSON.stringify(resolve('packages/storage/src/repositories.ts'))};import{SqliteWriteTransactions}from ${JSON.stringify(resolve('packages/storage/src/write-transactions.ts'))};
    const block=()=>{if(!existsSync(${JSON.stringify(arm)}))return;unlinkSync(${JSON.stringify(arm)});writeFileSync(${JSON.stringify(reached)},'ENGINEERING');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);};
    const describe=PiAgentRuntime.prototype.describe;PiAgentRuntime.prototype.describe=function(model){return {...describe.call(this,model),compaction:{contract:'medclaw.compaction/v1',enabled:false,reserveTokens:256,keepRecentTokens:128}};};
    ${barrier.startsWith('generation')?`const compact=PiAgentRuntime.prototype.compact;PiAgentRuntime.prototype.compact=async function(...args){${barrier==='generation_before'?'block();':''}const result=await compact.apply(this,args);${barrier==='generation_after'?'block();':''}return result;};`:barrier==='commit_before'?`const commit=Repositories.prototype.commitCompactionInTransaction;Repositories.prototype.commitCompactionInTransaction=function(...args){if(args[1].operationRef==='manual-crash')block();return commit.apply(this,args);};`:`const immediate=SqliteWriteTransactions.prototype.immediate;SqliteWriteTransactions.prototype.immediate=function(action){const result=immediate.call(this,action);if(!this.db.inTransaction&&this.db.query("SELECT id FROM business_events WHERE type='session_compaction_finished' AND operation_ref='manual-crash'").get())block();return result;};`}
    await import(${JSON.stringify(resolve('apps/host/src/main.ts'))});`);
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){requests.push(await request.json());return new Response(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'ENGINEERING original summary Shanghai'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}});
  const host=new HostController({dataRoot:root,hostEntry:entry,bunExecutable:process.execPath,onCredentialRequest:async frame=>frame.method==='export.destination.settlePrevious'?{ok:true,data:{stopped:true}}:frame.method==='credential.list'?{ok:true,data:[{providerId:'p10-fixture',type:'api_key'}]}:frame.method==='credential.read'?{ok:true,data:frame.payload.providerId==='p10-fixture'?{type:'api_key',key:'ENGINEERING'}:null}:{ok:true,data:null}});
  const initial=new MainSettings(host.paths.settingsPath).read();atomicWriteJson(host.paths.settingsPath,PublishedSettingsSchema.parse({...initial,model:{provider:'p10-fixture',modelId:'fixture'},customProviders:[{credentialRef:null,definition:{providerId:'p10-fixture',name:'ENGINEERING',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.port}/v1`,models:[{id:'fixture',name:'ENGINEERING',input:['text'],reasoning:false,contextWindow:4096,maxTokens:128,outputLimitConfirmed:true,pricingKnown:false,cost:null}]}}]}));
  const db=openDatabase(host.paths.databasePath),history=sqliteHistory(db),repo=new Repositories(db,undefined,undefined,undefined,history.store),manager=SessionManager.inMemory(root);
  manager.appendModelChange('p10-fixture','fixture');manager.appendThinkingLevelChange('off');
  for(let i=0;i<6;i++){manager.appendMessage({role:'user',content:'ENGINEERING '+ 'x'.repeat(160),timestamp:i*2+1});manager.appendMessage({...memoryAssistant('y'.repeat(160),'fixture'),provider:'p10-fixture',timestamp:i*2+2});}
  repo.createSession({expectedWorkspaceRevision:0},'create',manager.getSessionId(),memoryAt,{header:manager.getHeader(),entries:[],activeLeafId:null});history.commitSync({sessionId:1,runId:null,expectedStorageVersion:1,header:manager.getHeader(),newEntries:manager.getEntries(),activeLeafId:manager.getLeafId()});db.close();
  const sql=(query:string)=>{const read=new Database(host.paths.databasePath,{readonly:true});try{return read.query(query).all();}finally{read.close();}};
  try {
    expect(await host.start()).toMatchObject({state:'ready'});const oldInstance=host.read().instanceId!;
    const configured=await host.request('model.read',{});if(!configured.ok)throw new Error('ENGINEERING model read');const configVersion=ModelDirectoryViewSchema.parse(configured.data).configVersion;
    writeFileSync(arm,'ENGINEERING');const pending=host.request('session.compact',{sessionId:1,expectedStorageVersion:2,model:{provider:'p10-fixture',modelId:'fixture',expectedConfigVersion:configVersion}},'manual-crash');
    const deadline=Date.now()+10000;while(!existsSync(reached)){if(Date.now()>deadline)throw new Error('ENGINEERING crash barrier not reached');await Bun.sleep(10);}
    const before={history:sql('SELECT * FROM memories ORDER BY id'),position:sql('SELECT current_leaf_id,storage_version FROM sessions'),calls:sql('SELECT call_id,state,input_tokens,output_tokens,cost FROM model_calls ORDER BY id')};
    const child=Reflect.get(host,'child') as ChildProcessWithoutNullStreams,exited=new Promise<void>(done=>child.once('close',()=>done()));expect(child.kill('SIGKILL')).toBe(true);await exited;await pending;
    const count=requests.length;expect(await host.restart(oldInstance)).toMatchObject({state:'ready'});expect(host.read().instanceId).not.toBe(oldInstance);
    expect(await host.request('session.compaction.read',{sessionId:1,operationRef:'manual-crash'})).toMatchObject({ok:true,data:barrier==='commit_after'?{status:'completed',nativeGenerated:true,nativeSaved:true}:{status:'interrupted',nativeGenerated:null,nativeSaved:false}});
    expect(sql('SELECT * FROM memories ORDER BY id')).toEqual(before.history);expect(sql('SELECT current_leaf_id,storage_version FROM sessions')).toEqual(before.position);
    expect(sql('SELECT call_id,state,input_tokens,output_tokens,cost FROM model_calls ORDER BY id')).toEqual(before.calls);expect(requests).toHaveLength(count);
    expect(sql('SELECT id FROM runs')).toEqual([]);expect(sql('SELECT id FROM answers')).toEqual([]);expect(sql('SELECT id FROM session_inputs')).toEqual([]);
    if(barrier!=='generation_before')expect(before.calls.length).toBeGreaterThan(0);
    expect(await host.request('session.restore',{sessionId:1,expectedLeafId:Reflect.get(before.position[0]!,'current_leaf_id')},'restore-original')).toMatchObject({ok:true});expect(requests).toHaveLength(count);
  } finally {
    try{if(host.read().instanceId&&!host.read().canStart)await host.stop(host.read().instanceId!);}finally{server.stop(true);rmSync(root,{recursive:true,force:true});}
  }
},40000);
