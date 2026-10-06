import { expect,spyOn,test } from 'bun:test';
import { agentRuntimeFixture } from '../fixtures/agent-runtime';
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { acceptContextInput } from '../fixtures/p8-context';
import { RuntimeService } from '../../packages/core/src/runtime/runtime-service';
import { restoreNativeManager } from '../../packages/runtime-pi/src/memory-store';
import { memoryAssistant } from '../fixtures/p9-memory';

async function engineeringExtension(f:Awaited<ReturnType<typeof agentRuntimeFixture>>,change:(source:string)=>string) {
  const entry=join(f.author,'extensions/tool-audit/v1/index.ts');writeFileSync(entry,change(readFileSync(entry,'utf8')));
  const descriptor=await f.agent.readExtensionDescriptor();if(!descriptor)throw new Error('No descriptor');
  const {previous,rollbackFromVersion,...prior}=f.app.config;
  const candidate=PublishedSettingsSchema.parse({...f.app.config,configVersion:String(Number(f.app.config.configVersion)+1),previous:prior,extensions:{bySession:{'1':{extension:descriptor.ref}}}});
  await f.app.prepareConfig('fixture-select',candidate);f.app.commitConfig('fixture-select',candidate.configVersion);
}

async function eventually(action:()=>boolean) {for(let i=0;i<5000&&!action();i++)await Bun.sleep(2);expect(action()).toBe(true);}

test('p12 timed-out close blocks reuse and retry observes the same late completion before releasing saved facts',async()=>{
  let finish!:()=>void,calls=0;const pending=new Promise<void>(resolve=>{finish=resolve;});
  (globalThis as any).p12Close=()=>{calls++;return pending;};const f=await agentRuntimeFixture();
  try {
    await engineeringExtension(f,source=>source.replace('Promise.resolve().then(() => { closed = true;', 'Promise.resolve().then(async () => { await (globalThis as any).p12Close(); closed = true;'));
    const result=await f.app.runs.submitAgent(f.request('Close fixture'),{instanceId:'host',operationRef:'close-send'});if(!result.ok||!result.data.runId)throw new Error('No Run');const runId=result.data.runId;
    await eventually(()=>{const read=f.repos.read({runId});return read.kind==='one'&&read.run?.status==='completed';});
    expect(f.app.runs.busy).toBe(true);expect(f.agent.readExtensionCleanup(runId)).toMatchObject({state:'active',resourcesReleased:false});expect(calls).toBe(1);
    expect(await f.app.runs.retrySave(runId)).toMatchObject({ok:false});expect(calls).toBe(1);
    expect(await f.app.runs.submitAgent(f.request('Blocked'),{instanceId:'host',operationRef:'blocked-send'})).toMatchObject({ok:false});
    finish();await eventually(()=>f.agent.readExtensionCleanup(runId)?.resourcesReleased===true);
    const save=f.repos.saveRunCleanup.bind(f.repos);f.repos.saveRunCleanup=()=>{throw new Error('ENGINEERING cleanup save');};
    expect(await f.app.runs.retrySave(runId)).toMatchObject({ok:false});expect(f.app.runs.busy).toBe(true);expect(calls).toBe(1);f.repos.saveRunCleanup=save;
    expect(await f.app.runs.retrySave(runId)).toMatchObject({ok:true,data:{status:'completed',cleanup:{resourcesReleased:true,extensions:{state:'disposed'}}}});
    expect(calls).toBe(1);expect(f.app.runs.busy).toBe(false);expect(f.requests).toHaveLength(1);
  } finally {finish();delete (globalThis as any).p12Close;await f.close();}
},30000);

for(const throws of [false,true])test('p12 active fixed command '+(throws?'captures handler failure':'returns original owner without model or input'),async()=>{
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  const f=await agentRuntimeFixture(async()=>{await pending;return {role:'assistant',content:'ENGINEERING'};});
  try {
    await engineeringExtension(f,source=>throws?source.replace('handler: async () => { readStatus(); }',"handler: async () => { throw new Error('ENGINEERING command'); }"):source);
    const result=await f.app.runs.submitAgent(f.request('Active command'),{instanceId:'host',operationRef:'command-send'});if(!result.ok||!result.data.runId)throw new Error('No Run');const runId=result.data.runId;
    await eventually(()=>f.requests.length===1);const proof=f.agent.readExtensionCleanup(runId)!;
    const stored=f.repos.read({runId});expect(stored).toMatchObject({kind:'one',run:{cleanup:{extensions:{state:'active',assemblyId:proof.assemblyId}}}});
    const owner={instanceId:proof.instanceId,sessionId:proof.sessionId,runId,assemblyId:proof.assemblyId,command:'extension_status' as const};
    const inputs=f.db.query<{n:number},[]>('SELECT count(*) AS n FROM session_inputs').get()!.n;
    const value=await f.app.executeExtensionCommand(owner).catch(error=>error);
    const {command,...identity}=owner;expect(value).toMatchObject(throws?{code:'extension_command_failed'}:identity);
    expect(f.requests).toHaveLength(1);expect(f.db.query<{n:number},[]>('SELECT count(*) AS n FROM session_inputs').get()!.n).toBe(inputs);
    expect(await f.app.executeExtensionCommand({...owner,assemblyId:'stale'}).catch(error=>error)).toMatchObject({code:'state_conflict'});
    for(const mode of ['steer','follow_up'] as const)expect(await f.app.runs.submitAgent({...f.request('  /extension_status details'),mode,targetRunId:runId},{instanceId:'host',operationRef:mode+'-slash'})).toMatchObject({ok:false,error:{code:'extension_command_required'}});
    expect(f.db.query<{n:number},[]>('SELECT count(*) AS n FROM session_inputs').get()!.n).toBe(inputs);expect(f.requests).toHaveLength(1);
    release();await f.settle();expect(await f.app.executeExtensionCommand(owner).catch(error=>error)).toMatchObject({code:'state_conflict'});
    expect(await f.app.runs.submitAgent(f.request('/extension_status'),{instanceId:'host',operationRef:'ordinary-slash'})).toMatchObject({ok:false,error:{code:'extension_command_required'}});
    expect(f.db.query<{n:number},[]>('SELECT count(*) AS n FROM session_inputs').get()!.n).toBe(inputs);expect(f.requests).toHaveLength(1);
    expect(f.db.query<{n:number},[]>('SELECT count(*) AS n FROM runs').get()!.n).toBe(1);
  } finally {release();await f.close();}
},30000);

test('p12 enabled extension keeps one original assembly through real automatic compaction and acknowledgement',async()=>{
  const f=await agentRuntimeFixture((_index,payload)=>({role:'assistant',content:JSON.stringify(payload).includes('MedClaw trusted runtime feedback')?'ENGINEERING main answer':'ENGINEERING native summary'}),true);
  try {
    const saved=await f.history.store.load(1);if(!saved.ok)throw saved.error;
    const manager=restoreNativeManager(saved.data,f.root),existing=manager.getEntries().length;
    manager.appendModelChange('p11-fixture','fixture');manager.appendThinkingLevelChange('off');
    for(let index=0;index<6;index++){
      manager.appendMessage({role:'user',content:`ENGINEERING ${index} ${'x'.repeat(160)}`,timestamp:index*2+1});
      const assistant={...memoryAssistant('ENGINEERING '+ 'y'.repeat(160),'fixture'),provider:'p11-fixture',timestamp:index*2+2};
      if(index===5)assistant.usage={...assistant.usage,input:32600,totalTokens:32600};manager.appendMessage(assistant);
    }
    f.history.commitSync({sessionId:1,runId:null,expectedStorageVersion:saved.data.storageVersion,header:manager.getHeader()!,newEntries:manager.getEntries().slice(existing),activeLeafId:manager.getLeafId()});
    await f.agent.restore(1);
    const describe=f.agent.describe.bind(f.agent);spyOn(f.agent,'describe').mockImplementation(resolved=>({...describe(resolved),compaction:{contract:'medclaw.compaction/v1',enabled:true,reserveTokens:256,keepRecentTokens:128}}));
    const assemblies=new Set<string>(),save=f.repos.saveRunCleanup.bind(f.repos);f.repos.saveRunCleanup=(id,cleanup)=>{if(cleanup.extensions)assemblies.add(cleanup.extensions.assemblyId);return save(id,cleanup);};
    const accepted=await f.app.runs.submitAgent(f.request('ENGINEERING continue after summary'),{instanceId:'host',operationRef:'extension-auto-compact'});if(!accepted.ok||!accepted.data.runId)throw new Error('No Run');const runId=accepted.data.runId;
    await f.settle();
    const read=f.repos.read({runId});if(read.kind!=='one'||!read.run?.cleanup?.extensions)throw new Error('No assembly proof');const proof=read.run.cleanup.extensions;
    expect(proof).toMatchObject({runId,sessionId:1,state:'disposed',resourcesReleased:true});
    expect([...assemblies]).toEqual([proof.assemblyId]);
    expect(read).toMatchObject({kind:'one',run:{status:'completed',cleanup:{resourcesReleased:true}}});
    const calls=f.db.query<{call_id:string;kind:string;run_id:number;input_id:number|null;compaction_json:string|null},[]>('SELECT call_id,kind,run_id,input_id,json_extract(model_json,\'$.compaction\') compaction_json FROM model_calls ORDER BY id').all();
    expect(calls.filter(call=>call.kind==='main')).toHaveLength(1);expect(calls.filter(call=>call.kind==='compaction').length).toBeGreaterThan(0);
    for(const call of calls){expect(call.run_id).toBe(runId);if(call.kind==='compaction'){expect(call.input_id).toBeNull();expect(JSON.parse(call.compaction_json!)).toMatchObject({source:'auto',reason:'threshold',nativeEntryId:expect.any(String),savedStorageVersion:expect.any(Number)});}}
    expect(f.requests).toHaveLength(calls.length);expect(JSON.stringify(f.requests[0])).not.toContain('MedClaw trusted runtime feedback');expect(JSON.stringify(f.requests.at(-1))).toContain('ENGINEERING native summary');
    expect(f.db.query("SELECT id FROM memories WHERE entry_type='compaction'").all()).toHaveLength(1);expect(f.db.query("SELECT id FROM runtime_events WHERE type='compaction_completed'").all()).toHaveLength(1);
    for(const call of calls.filter(call=>call.kind==='main'))expect(f.contexts.read({callId:call.call_id})).toMatchObject({kind:'snapshot',snapshot:{sessionId:1,runId}});
  } finally {await f.close();}
},30000);

for(const failureAt of [1,2,'after_root'] as const)test('p12 necessary assembly journal failure '+failureAt+' prevents model dispatch and releases only the actual partial instance',async()=>{
  const f=await agentRuntimeFixture();let writes=0;const save=f.repos.saveRunCleanup.bind(f.repos);delete(globalThis as any).p12Journal;
  try {
    await engineeringExtension(f,source=>'globalThis.p12Journal=(globalThis.p12Journal??0)+1;\n'+source);
    if(failureAt==='after_root'){await f.app.runs.submitAgent(f.request('Prior enabled root'),{instanceId:'host',operationRef:'prior-journal-root'});await f.settle();(globalThis as any).p12Journal=0;}
    const before=f.requests.length;
    f.repos.saveRunCleanup=(...args)=>{if(++writes===(failureAt==='after_root'?1:failureAt))throw new Error('ENGINEERING journal');return save(...args);};
    const result=await f.app.runs.submitAgent(f.request('Journal fixture'),{instanceId:'host',operationRef:'journal-send'});if(!result.ok||!result.data.runId)throw new Error('No Run');await f.settle();
    expect(f.requests).toHaveLength(before);expect((globalThis as any).p12Journal??0).toBe(failureAt===2?1:0);
    expect(f.repos.read({runId:result.data.runId})).toMatchObject({kind:'one',run:{status:'failed',error:{code:'storage_write_failed'},cleanup:{resourcesReleased:true,extensions:{state:'disposed'}}}});
  } finally {f.repos.saveRunCleanup=save;delete(globalThis as any).p12Journal;await f.close();}
},30000);

test('p12 failure before entering the agent records no assembly and releases the accepted root',async()=>{
  const f=await agentRuntimeFixture(undefined,true),begin=f.repos.beginInputDelivery.bind(f.repos);
  try {
    f.repos.beginInputDelivery=()=>{throw new Error('ENGINEERING pre-agent delivery failure');};
    const accepted=await f.app.runs.submitAgent(f.request('Never entered'),{instanceId:'host',operationRef:'not-entered'});if(!accepted.ok||!accepted.data.runId)throw new Error('No Run');await f.settle();
    expect(f.requests).toHaveLength(0);expect(f.agent.readExtensionCleanup(accepted.data.runId)).toBeNull();
    expect(f.repos.read({runId:accepted.data.runId})).toMatchObject({kind:'one',run:{status:'failed',cleanup:{executionStarted:false,resourcesReleased:true,extensionReleaseBasis:'not_loaded'}}});
    expect(await f.app.readExtensions({source:'run',runId:accepted.data.runId})).toMatchObject({evidence:'recorded',assembly:null});
    f.repos.beginInputDelivery=begin;
    expect(await f.app.runs.submitAgent(f.request('Next real enabled root'),{instanceId:'host',operationRef:'after-not-entered'})).toMatchObject({ok:true});await f.settle();expect(f.requests).toHaveLength(1);
  } finally {f.repos.beginInputDelivery=begin;await f.close();}
},30000);

for(const repositoryRecovery of [false,true])test('p12 accepted but unjournaled assembly recovers only after actual owner exit '+repositoryRecovery,async()=>{
  const f=await agentRuntimeFixture(undefined,true);
  try {
    const extensions=await f.agent.freezeExtensions(1,f.app.config),accepted=acceptContextInput(f.db,{consume:false,legacy:true,history:true,repositories:f.repos,extensions});
    const createRecovery=()=>new RuntimeService('recovered-host',()=>f.app.config,f.runtime,f.repos,async(_context,action)=>action(),()=>{throw new Error('No model call expected');},()=>{},()=>{},f.agent,()=>false);
    let recovery=createRecovery();
    recovery.recoverInterrupted(false);expect(recovery.busy).toBe(true);
    if(repositoryRecovery){f.repos.recoverInterrupted('recovered-host',new Date().toISOString());recovery=createRecovery();}
    recovery.recoverInterrupted(true);expect(recovery.busy).toBe(false);expect(f.requests).toHaveLength(0);
    expect(f.repos.read({runId:accepted.input.runId})).toMatchObject({kind:'one',run:{status:'failed',cleanup:{stopConfirmed:true,resourcesReleased:true,extensionReleaseBasis:'owner_process_exited'}}});
    expect(await f.app.readExtensions({source:'run',runId:accepted.input.runId})).toMatchObject({assembly:null});
  } finally {await f.close();}
},30000);

test('p12 Stop fences a suspended module and observes its eventual single cleanup without reloading',async()=>{
  let finish!:()=>void;const load=new Promise<void>(resolve=>{finish=resolve;});
  (globalThis as any).p12Load=load;(globalThis as any).p12LoadStarted=false;const f=await agentRuntimeFixture();
  try {
    await engineeringExtension(f,source=>"(globalThis as any).p12LoadStarted=true;await (globalThis as any).p12Load;\n"+source);
    const result=await f.app.runs.submitAgent(f.request('Suspended load'),{instanceId:'host',operationRef:'load-send'});if(!result.ok||!result.data.runId)throw new Error('No Run');const runId=result.data.runId;
    await eventually(()=>(globalThis as any).p12LoadStarted);await f.app.runs.cancel(runId);
    await eventually(()=>{const read=f.repos.read({runId});return read.kind==='one'&&read.run?.status==='cancelled';});
    expect(f.requests).toHaveLength(0);expect(f.app.runs.busy).toBe(true);expect(f.agent.readExtensionCleanup(runId)).toMatchObject({state:'load_failed',resourcesReleased:false});
    finish();await eventually(()=>f.agent.readExtensionCleanup(runId)?.resourcesReleased===true);
    expect(await f.app.runs.retrySave(runId)).toMatchObject({ok:true,data:{status:'cancelled',cleanup:{resourcesReleased:true}}});expect(f.requests).toHaveLength(0);
  } finally {finish();delete(globalThis as any).p12Load;delete(globalThis as any).p12LoadStarted;await f.close();}
},30000);

test('p12 native read keeps SDK semantics after legal Hook path mutation',async()=>{
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'native-call',type:'function',function:{name:'read',arguments:JSON.stringify({path:'missing-original.txt'})}}]}:{role:'assistant',content:'ENGINEERING'});
  try {
    const path=join(f.root,'ENGINEERING-native.txt');writeFileSync(path,'ENGINEERING native content');
    await engineeringExtension(f,source=>source.replace('seenToolCalls++;',`seenToolCalls++;if(event.toolName==='read')event.input.path=${JSON.stringify(path)};`));
    const result=await f.app.runs.submitAgent(f.request('Native read'),{instanceId:'host',operationRef:'native-send'});if(!result.ok||!result.data.runId)throw new Error('No Run');await f.settle();
    const row=f.db.query<{args_json:string,result_json:string,status:string},[number]>('SELECT args_json,result_json,status FROM tool_calls WHERE run_id=?').get(result.data.runId)!;
    expect(row.status).toBe('succeeded');expect(JSON.parse(row.args_json).path).toBe(path);expect(JSON.parse(row.result_json).content[0].text).toBe('ENGINEERING native content');expect(f.errors).toEqual([]);
  } finally {await f.close();}
},30000);

for(const delayed of [false,true])test('p12 session_start '+(delayed?'Stop retains original candidate until the tracked Hook settles':'failure prevents first model call and disposes candidate'),async()=>{
  let finish!:()=>void;const wait=new Promise<void>(resolve=>{finish=resolve;});(globalThis as any).p12Start=wait;(globalThis as any).p12Started=false;const f=await agentRuntimeFixture();
  try {
    await engineeringExtension(f,source=>source.replace("pi.on('session_start', () => { readStatus(); })",delayed?"pi.on('session_start', async () => {(globalThis as any).p12Started=true;await (globalThis as any).p12Start;readStatus();})":"pi.on('session_start', () => {throw new Error('ENGINEERING startup');})"));
    const result=await f.app.runs.submitAgent(f.request('Startup fixture'),{instanceId:'host',operationRef:'start-send'});if(!result.ok||!result.data.runId)throw new Error('No Run');const runId=result.data.runId;
    if(delayed){await eventually(()=>(globalThis as any).p12Started);await f.app.runs.cancel(runId);await eventually(()=>{const read=f.repos.read({runId});return read.kind==='one'&&read.run?.status==='cancelled';});expect(f.agent.readExtensionCleanup(runId)).toMatchObject({state:'load_failed',resourcesReleased:false});finish();await eventually(()=>f.agent.readExtensionCleanup(runId)?.resourcesReleased===true);expect(await f.app.runs.retrySave(runId)).toMatchObject({ok:true,data:{status:'cancelled'}});}
    else {await f.settle();const read=await f.app.readExtensions({source:'run',runId});expect(read).toMatchObject({assembly:{loadedAt:null,state:'disposed',resourcesReleased:true}});}
    expect(f.requests).toHaveLength(0);
  } finally {finish();delete(globalThis as any).p12Start;delete(globalThis as any).p12Started;await f.close();}
},30000);

for(const fault of ['schema','scope','critical','observation'] as const) test('p12 final boundary '+fault,async()=>{
  let queryId=0;
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'fault-call',type:'function',function:{name:'read_query_page',arguments:JSON.stringify({queryId,page:1,pageSize:100})}}]}:{role:'assistant',content:'ENGINEERING'});
  try {
    const saved=seedWorkspaceQueries(f.db,f.repos);queryId=saved.current.id;let otherQueryId=0;
    if(fault==='scope') {
      const b=f.agent.allocate();const created=f.repos.createSession({expectedWorkspaceRevision:f.repos.readWorkspace().revision},'create-b',b.nativeSessionId,new Date().toISOString(),b.history);b.bind(created.session.id);
      f.db.query("INSERT INTO runs(id,session_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at) VALUES(11,?,'agent','host','saved-b',1,?,'running','answer','saved-b',json_object('agent',json_object('nativeSessionId',?)),?,'{}','2026-10-04','Asia/Shanghai',?)").run(created.session.id,JSON.stringify({sessionId:created.session.id,clientSequence:1}),b.nativeSessionId,JSON.stringify(saved.context.scope),new Date().toISOString());
      const {id,...query}=saved.current;
      otherQueryId=saved.store.commitQuery({...query,sessionId:created.session.id,runId:11,callRef:'11:saved-b'},[],{sessionId:created.session.id,runId:11,nativeToolCallId:'saved-b',scope:saved.context.scope,referenceDate:saved.context.referenceDate,timezone:saved.context.timezone,signal:saved.context.signal}).id;
      expect(saved.store.readQuery(otherQueryId,1)).toBeNull();
      expect(saved.store.readQuery(otherQueryId,created.session.id)?.sessionId).toBe(created.session.id);
      f.db.query("UPDATE runs SET status='completed',ended_at=? WHERE id=11").run(new Date().toISOString());
      f.repos.selectSession({sessionId:1,expectedWorkspaceRevision:f.repos.readWorkspace().revision},new Date().toISOString());
    }
    await engineeringExtension(f,source=>fault==='schema'?source.replace('Math.min(event.input.pageSize, 20)', '-1'):
      fault==='critical'?source.replace('seenToolCalls++;', "seenToolCalls++;throw new Error('ENGINEERING critical');"):
      fault==='observation'?source.replace("pi.on('tool_result', () => {})", "pi.on('tool_result', event => {event.content=[{type:'text',text:'FORGED'}];event.details={forged:true};throw new Error('ENGINEERING observation');})"):
      fault==='scope'?source.replace('seenToolCalls++;',`seenToolCalls++;event.input.queryId=${otherQueryId};`):source);
    const result=await f.app.runs.submitAgent(f.request('Fault page'),{instanceId:'host',operationRef:'fault-send'});if(!result.ok||!result.data.runId)throw new Error('No Run');await f.settle();
    const row=f.db.query<{args_json:string,status:string,error_json:string,result_json:string},[number]>('SELECT args_json,status,error_json,result_json FROM tool_calls WHERE run_id=?').get(result.data.runId)!;
    expect(row.status).toBe(fault==='observation'?'succeeded':'failed');
    if(fault==='schema') {expect(JSON.parse(row.args_json).pageSize).toBe(-1);expect(JSON.parse(row.error_json).code).toBe('tool_input_invalid');}
    if(fault==='scope')expect(JSON.parse(row.error_json).code).toBe('access_denied');
    if(fault==='critical')expect(f.requests).toHaveLength(1);
    if(fault==='observation'){expect(JSON.parse(row.result_json).queryId).toBe(queryId);expect(f.requests).toHaveLength(2);}
    const read=await f.app.readExtensions({source:'run',runId:result.data.runId});if(read.source!=='run'||!read.assembly)throw new Error('No proof');
    expect(read.assembly.resourcesReleased).toBe(true);expect(f.errors.filter(error=>(error as {code?:string}).code==='storage_write_failed')).toEqual([]);
  } finally {await f.close();}
},30000);

test('p12 Hook final pageSize is executed, recorded and delivered, while native request retains original arguments',async()=>{
  let queryId=0;
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'page-call',type:'function',function:{name:'read_query_page',arguments:JSON.stringify({queryId,page:1,pageSize:100})}}]}:{role:'assistant',content:'ENGINEERING'},true);
  try {
    queryId=seedWorkspaceQueries(f.db,f.repos).current.id;
    const result=await f.app.runs.submitAgent(f.request('Read saved page'),{instanceId:'host',operationRef:'page-send'});if(!result.ok||!result.data.runId)throw new Error('No Run');await f.settle();
    const row=f.db.query<{args_json:string,result_json:string,delivery_json:string,status:string},[number]>('SELECT args_json,result_json,delivery_json,status FROM tool_calls WHERE run_id=?').get(result.data.runId)!;
    expect(row.status).toBe('succeeded');expect(JSON.parse(row.args_json)).toEqual({queryId,page:1,pageSize:20});
    expect(JSON.parse(row.delivery_json).control.hookInput.changed).toBe(true);
    expect(f.requests[1]!.messages).toContainEqual(expect.objectContaining({role:'tool',content:expect.stringContaining('"pageSize":20')}));
    expect(f.errors).toEqual([]);
  } finally {await f.close();}
},30000);

test('p12 real extension tool uses the common executor, recorder and native history with original owner',async()=>{
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'extension-call',type:'function',function:{name:'extension_runtime_status',arguments:'{}'}}]}:{role:'assistant',content:'ENGINEERING'},true);
  let delivery:Parameters<typeof f.toolStore.recordDelivery>|undefined;const record=f.toolStore.recordDelivery.bind(f.toolStore);
  spyOn(f.toolStore,'recordDelivery').mockImplementation((...args)=>{delivery=args;return record(...args);});
  try {
    const result=await f.app.runs.submitAgent(f.request('Inspect runtime'),{instanceId:'host',operationRef:'extension-send'});
    if(!result.ok)throw result.error;if(!result.data.runId)throw new Error('No root Run'); const runId=result.data.runId;
    await f.settle();
    expect(f.requests).toHaveLength(2);expect(f.errors).toEqual([]);
    const tools=f.db.query<{args_json:string,result_json:string},[number]>('SELECT args_json,result_json FROM tool_calls WHERE run_id=?').all(runId);
    expect(tools).toHaveLength(1);expect(JSON.parse(tools[0]!.args_json)).toEqual({});
    expect(JSON.parse(tools[0]!.result_json)).toMatchObject({instanceId:'host',sessionId:1,runId,seenToolCalls:1});
    expect(f.repos.readRunExtensions(runId)?.selection.extension).not.toBeNull();
    const stored=f.repos.read({runId});if(stored.kind!=='one'||!stored.run)throw new Error('Missing Run');expect(stored.run.status).toBe('completed');expect(stored.run.cleanup).toMatchObject({budgetSummary:{toolCalls:1},extensions:{runId,state:'disposed',resourcesReleased:true}});
    if(!delivery)throw new Error('No original SDK delivery');const before=f.db.query('SELECT * FROM tool_calls').all(),events=f.db.query('SELECT * FROM runtime_events').all();
    record(...delivery);record(...delivery);
    expect(f.db.query('SELECT * FROM tool_calls').all()).toEqual(before);expect(f.db.query('SELECT * FROM runtime_events').all()).toEqual(events);expect(f.requests).toHaveLength(2);
    const read=await f.app.readExtensions({source:'run',runId});expect(read).toMatchObject({evidence:'recorded',assembly:{runId,sessionId:1,state:'disposed',resourcesReleased:true}});
    if(read.source!=='run'||!read.assembly)throw new Error('Missing assembly');expect(read.assembly.hookCounts).toEqual({input:1,context:2,tool_call:1,tool_result:1});
  } finally {await f.close();}
},30000);

test('p12 disabled product assembly never evaluates the explicit extension entry',async()=>{
  const f=await agentRuntimeFixture();const marker=globalThis as Record<string,unknown>;delete marker.p12DisabledEvaluation;
  try {
    const entry=join(f.author,'extensions/tool-audit/v1/index.ts');writeFileSync(entry,'globalThis.p12DisabledEvaluation=1;\n'+readFileSync(entry,'utf8'));
    const result=await f.app.runs.submitAgent(f.request('/extension_status ordinary disabled input'),{instanceId:'host',operationRef:'disabled-send'});
    if(!result.ok||!result.data.runId)throw new Error('No disabled Run');await f.settle();
    expect(marker.p12DisabledEvaluation).toBeUndefined();expect(f.requests).toHaveLength(1);
    expect(f.repos.readRunExtensions(result.data.runId)).toMatchObject({selection:{extension:null},source:null});
    const read=await f.app.readExtensions({source:'run',runId:result.data.runId});expect(read).toMatchObject({evidence:'recorded',assembly:null});
  } finally {delete marker.p12DisabledEvaluation;await f.close();}
},30000);

test('p12 fresh root assemblies do not reuse mutable counters or duplicate prior subscriptions',async()=>{
  const f=await agentRuntimeFixture(index=>index%2===1?{role:'assistant',tool_calls:[{index:0,id:'status-'+index,type:'function',function:{name:'extension_runtime_status',arguments:'{}'}}]}:{role:'assistant',content:'ENGINEERING'},true);
  try {
    const proofs=[];
    for(const text of ['First','Second']) {
      const result=await f.app.runs.submitAgent(f.request(text),{instanceId:'host',operationRef:text});if(!result.ok||!result.data.runId)throw new Error('No Run');await f.settle();
      const read=await f.app.readExtensions({source:'run',runId:result.data.runId});if(read.source!=='run'||!read.assembly)throw new Error('No proof');proofs.push(read.assembly);
      expect(read.assembly.hookCounts).toEqual({input:1,context:2,tool_call:1,tool_result:1});
      expect(f.db.query<{n:number},[number]>('SELECT count(*) AS n FROM tool_calls WHERE run_id=?').get(result.data.runId)?.n).toBe(1);
    }
    expect(proofs[0]!.assemblyId).not.toBe(proofs[1]!.assemblyId);expect(f.errors).toEqual([]);expect(f.requests).toHaveLength(4);
  } finally {await f.close();}
},30000);

test('p12 observation input and context cannot transform the actual input, provider payload or native history',async()=>{
  const f=await agentRuntimeFixture();
  try {
    await engineeringExtension(f,source=>source.replace("pi.on('input', () => { inputObservations++; })", "pi.on('input', event => {inputObservations++;event.text='FORGED INPUT';return {action:'transform',text:'FORGED RETURN'};})")
      .replace("pi.on('context', () => { contextObservations++; })", "pi.on('context', event => {contextObservations++;event.messages.length=0;return {messages:[]};})"));
    const text='ENGINEERING original observation';
    const result=await f.app.runs.submitAgent(f.request(text),{instanceId:'host',operationRef:'observation-send'});if(!result.ok||!result.data.runId)throw new Error('No Run');await f.settle();
    expect(f.requests).toHaveLength(1);expect(JSON.stringify(f.requests[0])).toContain(text);expect(JSON.stringify(f.requests[0])).not.toContain('FORGED');
    const messages=await f.agent.readMessages({sessionId:1,leafId:null,afterEntryId:null,limit:100});expect(JSON.stringify(messages)).toContain(text);expect(JSON.stringify(messages)).not.toContain('FORGED');
    const read=await f.app.readExtensions({source:'run',runId:result.data.runId});if(read.source!=='run'||!read.assembly)throw new Error('No proof');expect(read.assembly.hookCounts.input).toBe(1);expect(read.assembly.hookCounts.context).toBe(1);
  } finally {await f.close();}
},30000);

for(const conflict of ['command','read','read_query_page'])test('p12 '+conflict+' registration conflict fails before the first model call and releases the partial trusted fixture',async()=>{
  const f=await agentRuntimeFixture();
  try {
    const entry=join(f.author,'extensions/tool-audit/v1/index.ts'),source=readFileSync(entry,'utf8');writeFileSync(entry,conflict==='command'?source.replace("pi.registerCommand('extension_status'", "pi.registerCommand('extension_status',{description:'ENGINEERING duplicate',handler:async()=>{}});\n    pi.registerCommand('extension_status'"):source.replace("pi.registerTool({ name: 'extension_runtime_status'",`pi.registerTool({ name: '${conflict}'`));
    const descriptor=await f.agent.readExtensionDescriptor();if(!descriptor)throw new Error('No descriptor');
    const {previous,rollbackFromVersion,...prior}=f.app.config;
    const candidate=PublishedSettingsSchema.parse({...f.app.config,configVersion:'2',previous:prior,extensions:{bySession:{'1':{extension:descriptor.ref}}}});
    await f.app.prepareConfig('fixture-select',candidate);f.app.commitConfig('fixture-select','2');
    const result=await f.app.runs.submitAgent(f.request('Fault fixture'),{instanceId:'host',operationRef:'duplicate-send'});if(!result.ok||!result.data.runId)throw new Error('No original failed Run');await f.settle();
    expect(f.requests).toHaveLength(0);
    const read=await f.app.readExtensions({source:'run',runId:result.data.runId});expect(read).toMatchObject({assembly:{loadedAt:null,state:'disposed',resourcesReleased:true}});
    if(read.source!=='run'||!read.assembly)throw new Error('No proof');expect(read.assembly.diagnostics.some(error=>error.code==='extension_conflict')).toBe(true);
  } finally {await f.close();}
},30000);
