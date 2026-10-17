import { afterEach, expect, test, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SqliteImportStore } from '../../packages/storage/src/import-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import { validateNativeHistory } from '../../packages/runtime-pi/src/memory-store';
import { SqliteMemoryStore } from '../../packages/storage/src/memory-store';
import { SqliteWriteTransactions } from '../../packages/storage/src/write-transactions';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { memoryAssistant, memoryAt } from '../fixtures/p9-memory';
import { acceptContextInput } from '../fixtures/p8-context';
import { ModelCallRecorder } from '../../packages/runtime-pi/src/model-call-recorder';
import type { FinalAgentFact } from '../../packages/contracts/src/run';
import { sqliteHistory } from '../fixtures/p9-memory';
import { RuntimeService } from '../../packages/core/src/runtime/runtime-service';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { SessionService } from '../../packages/core/src/session/session-service';
import { Application } from '../../packages/core/src/application';
import { WorkspaceService } from '../../packages/core/src/workspace/workspace-service';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { CurrentQuerySchema } from '../../packages/contracts/src/query';
import {SqliteToolStore} from '../../packages/storage/src/tool-store';
import {SqliteCatalogStore} from '../../packages/storage/src/catalog-store';
import {CatalogService} from '../../packages/core/src/data/catalog-service';
import {QueryService} from '../../packages/core/src/data/query-service';
import {EvidenceReader} from '../../packages/core/src/evidence/evidence-reader';
import {createBusinessTools} from '../../packages/core/src/tools/tools';
import {ToolRegistry} from '../../packages/core/src/tools/registry';
import {ToolRecorder} from '../../packages/core/src/tools/recorder';
import {ToolExecutor} from '../../packages/core/src/tools/executor';

test('p9 final Answer uses original frozen and committed Query references, and keeps Query facts when final COMMIT fails',async()=>{
  const base=await setup(),native=base.agent.allocate();base.repo.createSession({expectedWorkspaceRevision:0},'reference-session',native.nativeSessionId,memoryAt,native.history);native.bind(1);
  const saved=seedWorkspaceQueries(base.db,base.repo);base.repo.updateWorkspace({queryId:saved.current.id},base.repo.readWorkspace().revision,memoryAt);
  const f=await stoppedAnswer(base),scope=f.repo.freezeAgentScope(f.repo.readWorkspace(),[]);
  const own=saved.queries.current(CurrentQuerySchema.parse({batchIds:[1],time:{start:'2026-10-04',endExclusive:'2026-10-05'}}),{sessionId:1,runId:f.input.runId,nativeToolCallId:'ENGINEERING-query',scope,referenceDate:'2026-10-05',timezone:'Asia/Shanghai',signal:new AbortController().signal});
  f.repo.updateWorkspace({queryId:saved.secondQueryId},f.repo.readWorkspace().revision,memoryAt);
  const prefix=f.db.query('SELECT * FROM memories').all(),queries=f.db.query('SELECT * FROM queries').all();
  f.db.exec("CREATE TEMP TRIGGER fail_answer BEFORE INSERT ON answers BEGIN SELECT RAISE(ABORT,'ENGINEERING final failure'); END;");
  expect(()=>f.repo.finalizeAgent(f.input.runId,f.fact)).toThrow();expect(f.db.query('SELECT * FROM queries').all()).toEqual(queries);expect(f.db.query('SELECT * FROM memories').all()).toEqual(prefix);expect(f.db.query('SELECT * FROM answers').all()).toEqual([]);
  f.db.exec('DROP TRIGGER fail_answer');commitAnswer(f);
  const ids=[saved.current.id,own.queryId].sort((a,b)=>a-b);expect(JSON.parse(f.db.query<{query_ids_json:string},[]>('SELECT query_ids_json FROM answers').get()!.query_ids_json)).toEqual(ids);
  expect(ids).not.toContain(saved.secondQueryId);expect(f.repo.isFinalSaved(f.input.runId,f.fact)).toBe(true);expect(f.requests).toHaveLength(1);
});

for(const defect of ['version','params','evidence','source','session','scope','source_rows','source_metadata'] as const)test(`p9 invalid ${defect} Query reference rolls back final history, Answer, input and Run without removing prior Query`,async()=>{
  const base=await setup(),native=base.agent.allocate();base.repo.createSession({expectedWorkspaceRevision:0},'reference-invalid',native.nativeSessionId,memoryAt,native.history);native.bind(1);
  const saved=seedWorkspaceQueries(base.db,base.repo);base.repo.updateWorkspace({queryId:saved.current.id},base.repo.readWorkspace().revision,memoryAt);
  const f=await stoppedAnswer(base);
  // Simulate externally corrupted saved data; production immutable triggers stay covered elsewhere.
  if(['version','params','session'].includes(defect))f.db.exec('DROP TRIGGER queries_update_immutable');
  if(['evidence','source_rows','source_metadata'].includes(defect))f.db.exec('DROP TRIGGER query_evidence_update_immutable');
  if(defect==='source'||defect==='session')f.db.exec('PRAGMA foreign_keys=OFF');
  if(defect==='version')f.db.query("UPDATE queries SET result_json=json_set(result_json,'$.calculationVersion',?) WHERE id=?").run('ENGINEERING-altered-version',saved.current.id);
  if(defect==='params')f.db.query("UPDATE queries SET params_json=json_set(params_json,'$.region','ENGINEERING-altered') WHERE id=?").run(saved.current.id);
  if(defect==='evidence')f.db.query('UPDATE query_evidence SET calculation_version=? WHERE id=?').run('ENGINEERING-altered-version',saved.evidenceId);
  if(defect==='source_rows')f.db.query("UPDATE query_evidence SET source_row_refs_json='[\"ENGINEERING foreign source\"]' WHERE id=?").run(saved.evidenceId);
  if(defect==='source_metadata')f.db.query("UPDATE query_evidence SET source_bundle_id='ENGINEERING foreign bundle' WHERE id=?").run(saved.evidenceId);
  if(defect==='source')f.db.query("UPDATE batches SET status='deleted',deleted_at=?,deletion_operation_ref='ENGINEERING-delete' WHERE id=1").run(memoryAt);
  if(defect==='session'){const other=f.agent.allocate();f.repo.createSession({expectedWorkspaceRevision:f.repo.readWorkspace().revision},'reference-other',other.nativeSessionId,memoryAt,other.history);other.bind(2);f.db.query('UPDATE queries SET session_id=2 WHERE id=?').run(saved.current.id);}
  if(defect==='scope')f.db.query("UPDATE runs SET scope_json=json_set(scope_json,'$.batchIds',json('[]')) WHERE id=?").run(f.input.runId);
  f.db.exec('PRAGMA foreign_keys=ON');
  const facts=['memories','answers','session_inputs','runs','runtime_events','queries'].map(table=>f.db.query(`SELECT * FROM ${table}`).all());
  let failure:unknown;try{f.repo.finalizeAgent(f.input.runId,f.fact);}catch(error){failure=error;}expect(failure).toMatchObject({code:'answer_evidence_invalid'});
  expect(['memories','answers','session_inputs','runs','runtime_events','queries'].map(table=>f.db.query(`SELECT * FROM ${table}`).all())).toEqual(facts);expect(f.requests).toHaveLength(1);
});

test('p9 actual SDK read of an old Query contributes only its saved and provider-verified reference to the final Answer',async()=>{
  const base=await setup({tools:true}),native=base.agent.allocate();base.repo.createSession({expectedWorkspaceRevision:0},'actual-read-session',native.nativeSessionId,memoryAt,native.history);native.bind(1);
  const saved=seedWorkspaceQueries(base.db,base.repo);base.readQuery(saved.current.id);const f=await stoppedAnswer(base);
  expect(f.requests).toHaveLength(2);expect(JSON.stringify(f.requests[1])).toContain(saved.current.calculationVersion);
  const receipt=f.db.query<{delivery_json:string},[]>('SELECT delivery_json FROM tool_calls').get()!;expect(JSON.parse(receipt.delivery_json)).toMatchObject({sdkReturned:true,consumptionEvidence:'provider_input_verified',nextModelCallId:f.fact.calls[1]!.callId});
  f.repo.updateWorkspace({queryId:saved.secondQueryId},f.repo.readWorkspace().revision,memoryAt);commitAnswer(f);
  expect(JSON.parse(f.db.query<{query_ids_json:string},[]>('SELECT query_ids_json FROM answers').get()!.query_ids_json)).toEqual([saved.current.id]);expect(f.repo.isFinalSaved(f.input.runId,f.fact)).toBe(true);expect(f.requests).toHaveLength(2);
});

for(const name of ['read_query_page','list_query_evidence','read_query_evidence'] as const)test(`p9 actual ${name} delivery keeps its original Query identity in Answer`,async()=>{
  const base=await setup({tools:true}),native=base.agent.allocate();base.repo.createSession({expectedWorkspaceRevision:0},'read-variant',native.nativeSessionId,memoryAt,native.history);native.bind(1);
  const saved=seedWorkspaceQueries(base.db,base.repo);base.readQuery(saved.current.id,name,name==='read_query_evidence'?{evidenceId:saved.evidenceId}:{queryId:saved.current.id,page:1,pageSize:10});const f=await stoppedAnswer(base);
  expect(f.requests).toHaveLength(2);expect(f.db.query('SELECT tool_name,status FROM tool_calls').get()).toEqual({tool_name:name,status:'succeeded'});commitAnswer(f);
  expect(JSON.parse(f.db.query<{query_ids_json:string},[]>('SELECT query_ids_json FROM answers').get()!.query_ids_json)).toEqual([saved.current.id]);expect(f.repo.isFinalSaved(f.input.runId,f.fact)).toBe(true);
});

function applicationFor(f:Awaited<ReturnType<typeof setup>>,instanceId='host') {
  const settings=PublishedSettingsSchema.parse({schemaVersion:'medclaw.settings/p1-v1',configVersion:'1',model:null,customProviders:[],credentialRefs:{},requestPolicy:{timeoutMs:10000,maxRetries:0,maxRetryDelayMs:2000},previous:null,rollbackFromVersion:null});
  const app=new Application(instanceId,settings,f.runtime,f.repo,(_context,action)=>action(),(runId,kind,time)=>new ModelCallRecorder(f.repo,runId,kind,time),()=>{},()=>{},f.agent);
  const sessions=new SessionService('host',f.repo,f.agent,(input,context)=>app.runs.submitAgent(input,context),()=>app.runs.activeHandle,sessionId=>app.runs.readInputControl(sessionId),(inputId,context)=>app.runs.cancelInput(inputId,context),app.runs,f.tx);
  return {app,sessions,workspace:new WorkspaceService(f.repo,undefined,()=>app.runs.assertNoHistoryMutation())};
}

const closers:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const close of closers.splice(0))await close();});
async function setup(options:{tools?:boolean;models?:string[]}={}) {
  const root=mkdtempSync(join(tmpdir(),'medclaw-p9-runtime-')),db=openDatabase(join(root,'app.sqlite')),tx=SqliteWriteTransactions.forDatabase(db);
  let requestedRead:{name:string;args:Record<string,number>}|null=null;const requests:unknown[]=[];const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){requests.push(await request.json());const tool=requestedRead;requestedRead=null;return new Response(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta:tool===null?{role:'assistant',content:'ENGINEERING answer'}:{role:'assistant',tool_calls:[{index:0,id:'ENGINEERING-read',type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]},finish_reason:tool===null?'stop':'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}});
  const credentials=new InMemoryCredentialStore();await credentials.modify('p9-fixture',async()=>({type:'api_key',key:'ENGINEERING'}));
  const runtime=await PiModelRuntime.create({credentials,modelsStore:new InMemoryModelsStore()});
  await runtime.installCustom([{providerId:'p9-fixture',name:'ENGINEERING',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.port}/v1`,models:(options.models??['fixture']).map(id=>({id,name:'ENGINEERING',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,outputLimitConfirmed:true,pricingKnown:false,cost:null}))}]);
  const history=sqliteHistory(db),store=history.store;
  const repo=new Repositories(db,undefined,undefined,tx,store);
  closers.push(()=>{server.stop(true);db.close();rmSync(root,{recursive:true,force:true});});
  const facts=new SqliteToolStore(db),catalog=new CatalogService(new SqliteCatalogStore(db)),queries=new QueryService(catalog,facts),evidence=new EvidenceReader(catalog,queries,facts),registry=new ToolRegistry(createBusinessTools({catalog,queries,evidence})),recorder=new ToolRecorder(facts);
  const agent=new PiAgentRuntime(runtime,root,history,options.tools?{registry,recorder,executor:new ToolExecutor(registry,recorder)}:undefined);let sequence=0;
  function seed(text:string,full=true) {
    const manager=SessionManager.inMemory(root),created=repo.createSession({expectedWorkspaceRevision:repo.readWorkspace().revision},`create-${++sequence}`,manager.getSessionId(),memoryAt,{header:manager.getHeader(),entries:[],activeLeafId:null});
    if(full){manager.appendModelChange('p9-fixture','fixture');manager.appendThinkingLevelChange('off');manager.appendMessage({role:'user',content:text,timestamp:1});const leaf=manager.appendMessage({...memoryAssistant(`ENGINEERING reply ${text}`),provider:'p9-fixture',model:'fixture'});manager.appendCustomEntry('p9.abandoned',{text:'ENGINEERING abandoned'});manager.branch(leaf);}
    return {sessionId:created.session.id,manager};
  }
  return {root,db,repo,store,agent,history,runtime,requests,seed,tx,readQuery:(id:number,name='read_query',args:Record<string,number>={queryId:id})=>{requestedRead={name,args};}};
}

async function stoppedAnswer(existing?:Awaited<ReturnType<typeof setup>>) {
  const f=existing??await setup();if(!existing){const allocated=f.agent.allocate();f.repo.createSession({expectedWorkspaceRevision:0},'create-final',allocated.nativeSessionId,memoryAt,allocated.history);allocated.bind(1);}
  const resolved=await f.runtime.resolve({provider:'p9-fixture',modelId:'fixture',expectedConfigVersion:'1'},'1',null,{timeoutMs:10000,maxRetries:0,maxRetryDelayMs:2000});
  const accepted=acceptContextInput(f.db,{consume:false,model:resolved.selection,legacy:true,history:true,toolNames:f.agent.toolNames}),input=accepted.input;
  f.repo.beginInputDelivery(input.inputId,'host',memoryAt);
  const observed=await f.agent.execute({sessionId:1,runId:input.runId,inputId:input.inputId,text:accepted.request.text,resolved,agentOptions:f.agent.describe(resolved),scope:input.scope,workspaceContext:input.workspaceContext,referenceDate:accepted.request.referenceDate,timezone:accepted.request.timezone,signal:new AbortController().signal,deadlineAt:performance.now()+10000},
    {startCall:at=>new ModelCallRecorder(f.repo,input.runId,'main',at),preview:()=>{},nativeTerminal:()=>{},inputStore:f.repo});
  const endedAt=new Date().toISOString(),fact:FinalAgentFact={status:'completed',outputText:observed.lastOutcome!.text,stoppedAt:endedAt,endedAt,error:null,calls:observed.calls,history:observed.history,inputSettlement:observed.inputSettlement,
    cleanup:{contract:'medclaw.run-cleanup/v1',executionStarted:true,stopConfirmed:true,requiredPersistenceComplete:true,inputsSettled:true,resourcesReleased:true,unconfirmedItems:[],secondaryErrors:[],verifiedAt:endedAt}};
  return {...f,input,fact,request:accepted.request};
}
function commitAnswer(f:Awaited<ReturnType<typeof stoppedAnswer>>) {
  f.repo.finalizeAgent(f.input.runId,f.fact);f.agent.acknowledgeHistorySaved(f.fact.history!,f.fact.history!.expectedStorageVersion+1);
  f.agent.releaseInputFacts(f.input.runId);f.agent.releaseToolFacts(f.input.runId);f.agent.releaseHistoryFacts(f.input.runId);
}

test('p9 interrupted recovery validates only committed native history and preserves independent context and stop gaps',async()=>{
  const f=await stoppedAnswer();
  let unsaved:unknown;try{await f.agent.disposeIdleSessions();}catch(error){unsaved=error;}
  expect(unsaved).toMatchObject({code:'storage_write_failed'});
  const row=f.db.query<{native_entry_id:string;entry_json:string},[]>('SELECT native_entry_id,entry_json FROM memories LIMIT 1').get()!;
  f.db.query("UPDATE memories SET entry_json=json_set(entry_json,'$.timestamp','ENGINEERING-bad-time') WHERE native_entry_id=?").run(row.native_entry_id);
  // A restarted Host has a fresh SDK instance; it cannot retain the interrupted process's unsaved tail.
  const {app}=applicationFor({...f,agent:new PiAgentRuntime(f.runtime,f.root,f.history)},'recovered-host');app.runs.recoverInterrupted(true);
  expect(app.runs.persistencePending).toBe(true);expect(await app.runs.readControl()).toMatchObject({ok:true,data:{acceptingNewRuns:false}});
  expect(f.repo.read({runId:f.input.runId})).toMatchObject({kind:'one',run:{status:'failed',cleanup:{stopConfirmed:true,requiredPersistenceComplete:false,unconfirmedItems:expect.arrayContaining(['history_persistence'])}}});
  expect(await app.runs.retrySave(f.input.runId)).toMatchObject({ok:false,error:{code:'run_save_unavailable'}});expect(f.requests).toHaveLength(1);
  // Repair the exact saved bytes, never invent the uncommitted assistant tail.
  f.db.query('UPDATE memories SET entry_json=? WHERE native_entry_id=?').run(row.entry_json,row.native_entry_id);
  expect(await app.runs.retrySave(f.input.runId)).toMatchObject({ok:true,data:{status:'failed'}});expect(app.runs.persistencePending).toBe(false);expect(f.db.query('SELECT * FROM answers').all()).toEqual([]);expect(f.requests).toHaveLength(1);await app.shutdown();
});

test('p9 checkpoint list derives completed user turns on all retained branches, with eligible descending cursors and no writes',async()=>{
  const f=await stoppedAnswer();expect(f.repo.readCheckpoints({sessionId:1})).toMatchObject({items:[],nextAnswerId:null,hasMore:false});commitAnswer(f);
  const next=await stoppedAnswer(f);commitAnswer(next);
  const changes=f.db.query('SELECT total_changes() n').get(),first=f.repo.readCheckpoints({sessionId:1,limit:1});
  expect(first).toMatchObject({sessionId:1,items:[{answerId:2,runId:next.input.runId,nativeLeafId:next.fact.history!.activeLeafId,questionSummary:'Why did this decline?',answerSummary:'ENGINEERING answer',conditionSummary:null,isCurrentBranch:true}],nextAnswerId:2,hasMore:true});
  expect(f.repo.readCheckpoints({sessionId:1,afterAnswerId:2,limit:1})).toMatchObject({items:[{answerId:1,nativeLeafId:f.fact.history!.activeLeafId,isCurrentBranch:true}],nextAnswerId:null,hasMore:false});
  expect(()=>f.repo.readCheckpoints({sessionId:1,afterAnswerId:999})).toThrow();expect(f.db.query('SELECT total_changes() n').get()).toEqual(changes);
  const move=await f.store.commit({sessionId:1,runId:null,expectedStorageVersion:next.fact.history!.expectedStorageVersion+1,header:next.fact.history!.header,newEntries:[],activeLeafId:f.fact.history!.activeLeafId});expect(move.ok).toBe(true);
  expect(f.repo.readCheckpoints({sessionId:1}).items.map(point=>[point.answerId,point.isCurrentBranch])).toEqual([[2,false],[1,true]]);
});

test('p9 checkpoint position, versions and original receipt commit together; replay never overwrites later Workspace',async()=>{
  const f=await stoppedAnswer();commitAnswer(f);const target=f.fact.history!.activeLeafId!,request={sessionId:1,targetLeafId:target,expectedStorageVersion:f.repo.readSession(1)!.storageVersion,expectedWorkspaceRevision:f.repo.readWorkspace().revision};
  const before=f.db.query('SELECT * FROM memories').all(),answer=f.db.query('SELECT * FROM answers').all();
  const receipt=f.tx.immediate(()=>f.repo.restoreCheckpointInTransaction(request,'resume-A',memoryAt));
  expect(receipt).toEqual({operationRef:'resume-A',sessionId:1,targetLeafId:target,storageVersion:request.expectedStorageVersion+1,workspaceRevision:request.expectedWorkspaceRevision+1,committedAt:memoryAt});
  expect(f.repo.readSession(1)).toMatchObject({leafId:target,storageVersion:receipt.storageVersion});expect(f.repo.readWorkspace()).toMatchObject({revision:receipt.workspaceRevision,sessionId:1,queryId:null,selection:null});
  expect(f.db.query('SELECT * FROM memories').all()).toEqual(before);expect(f.db.query('SELECT * FROM answers').all()).toEqual(answer);
  const b=f.seed('ENGINEERING B',false),workspace=f.repo.readWorkspace(),changes=f.db.query('SELECT total_changes() n').get();
  expect(f.tx.immediate(()=>f.repo.restoreCheckpointInTransaction(request,'resume-A',memoryAt))).toEqual(receipt);
  expect(f.repo.readCheckpointOperation('resume-A')).toEqual({request,receipt});expect(f.repo.findOperation('resume-A')).toMatchObject({method:'session.restoreCheckpoint',originalRequest:request,result:receipt});
  expect(f.repo.readWorkspace()).toEqual(workspace);expect(workspace.sessionId).toBe(b.sessionId);expect(f.db.query('SELECT total_changes() n').get()).toEqual(changes);
  expect(()=>f.tx.immediate(()=>f.repo.restoreCheckpointInTransaction({...request,targetLeafId:'wrong'},'resume-A',memoryAt))).toThrow();
});

for(const operation of ['final','checkpoint'] as const)test(`p9 actual ${operation} COMMIT lock failure retains original database facts and retry uses no model request`,async()=>{
  const f=await stoppedAnswer();if(operation==='checkpoint')commitAnswer(f);
  f.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0;');
  const tables=['sessions','workspace','memories','answers','session_inputs','runs','runtime_events','business_events'],facts=()=>tables.map(table=>f.db.query(`SELECT * FROM ${table} ORDER BY id`).all()),before=facts();
  const reader=new Database(join(f.root,'app.sqlite'),{readonly:true});
  const request={sessionId:1,targetLeafId:f.fact.history!.activeLeafId!,expectedStorageVersion:f.repo.readSession(1)!.storageVersion,expectedWorkspaceRevision:f.repo.readWorkspace().revision};
  const save=()=>operation==='final'?f.repo.finalizeAgent(f.input.runId,f.fact):f.tx.immediate(()=>f.repo.restoreCheckpointInTransaction(request,'locked-checkpoint',memoryAt));
  try{reader.exec('BEGIN');reader.query('SELECT * FROM sessions').all();expect(save).toThrow();expect(f.db.inTransaction).toBe(false);expect(facts()).toEqual(before);reader.exec('ROLLBACK');}
  finally{if(reader.inTransaction)reader.exec('ROLLBACK');reader.close();}
  save();expect(f.requests).toHaveLength(1);
  if(operation==='final')expect(f.repo.isFinalSaved(f.input.runId,f.fact)).toBe(true);else expect(f.repo.readCheckpointOperation('locked-checkpoint')?.receipt.storageVersion).toBe(request.expectedStorageVersion+1);
});

test('p9 checkpoint operation identity cannot later be claimed by an import preview',async()=>{
  const f=await stoppedAnswer();commitAnswer(f);const input={sessionId:1,targetLeafId:f.fact.history!.activeLeafId!,expectedStorageVersion:f.repo.readSession(1)!.storageVersion,expectedWorkspaceRevision:f.repo.readWorkspace().revision};
  f.tx.immediate(()=>f.repo.restoreCheckpointInTransaction(input,'checkpoint-import-collision',memoryAt));
  const store=new SqliteImportStore(f.db),before=f.db.query('SELECT * FROM imports').all();
  expect(()=>store.begin({operationRef:'checkpoint-import-collision',fileToken:'ENGINEERING',mappingVersion:'medclaw.snapshot/v1'},'host')).toThrow('state_conflict');
  expect(f.db.query('SELECT * FROM imports').all()).toEqual(before);expect(f.repo.readCheckpointOperation('checkpoint-import-collision')).not.toBeNull();
});

test('p9 checkpoint lost return confirms one original receipt; a new identity at the same leaf increments both versions once',async()=>{
  const f=await stoppedAnswer();commitAnswer(f);const {app,sessions}=applicationFor(f),input={sessionId:1,targetLeafId:f.fact.history!.activeLeafId!,expectedStorageVersion:f.repo.readSession(1)!.storageVersion,expectedWorkspaceRevision:f.repo.readWorkspace().revision};
  const immediate=f.tx.immediate.bind(f.tx);let lost=false;
  const hook=spyOn(f.tx,'immediate').mockImplementation(action=>{const result=immediate(action);if(!lost&&result&&typeof result==='object'&&'operationRef'in result&&result.operationRef==='position-return-lost'){lost=true;throw new Error('ENGINEERING saved position return lost');}return result;});
  let receipt;try{receipt=await sessions.restoreCheckpoint(input,{instanceId:'host',operationRef:'position-return-lost'});}finally{hook.mockRestore();}
  expect(lost).toBe(true);expect(receipt).toMatchObject({ok:true,data:{storageVersion:input.expectedStorageVersion+1,workspaceRevision:input.expectedWorkspaceRevision+1}});expect(f.requests).toHaveLength(1);
  const original=f.db.query('SELECT * FROM memories').all(),version=f.repo.readSession(1)!.storageVersion;
  expect(await sessions.restoreCheckpoint({...input,expectedStorageVersion:version,expectedWorkspaceRevision:f.repo.readWorkspace().revision},{instanceId:'host',operationRef:'new-same-position'})).toMatchObject({ok:true,data:{storageVersion:version+1}});
  expect(f.db.query("SELECT id FROM business_events WHERE type='session_checkpoint_restored'").all()).toHaveLength(2);expect(f.db.query('SELECT * FROM memories').all()).toEqual(original);
  const changes=f.db.query('SELECT total_changes() n').get();expect(await sessions.restoreCheckpoint(input,{instanceId:'host',operationRef:'position-return-lost'})).toEqual(receipt);expect(f.db.query('SELECT total_changes() n').get()).toEqual(changes);await app.shutdown();
});

test('p9 checkpoint original read rejects damaged ownership and preserves null absence; schema rejects non-user sessions',async()=>{
  const f=await stoppedAnswer();commitAnswer(f);const input={sessionId:1,targetLeafId:f.fact.history!.activeLeafId!,expectedStorageVersion:f.repo.readSession(1)!.storageVersion,expectedWorkspaceRevision:f.repo.readWorkspace().revision};
  f.tx.immediate(()=>f.repo.restoreCheckpointInTransaction(input,'read-owned',memoryAt));expect(f.repo.readCheckpointOperation('not-recorded')).toBeNull();
  f.db.exec('SAVEPOINT damaged');try{f.db.exec("UPDATE business_events SET actor='agent' WHERE operation_ref='read-owned'");expect(()=>f.repo.readCheckpointOperation('read-owned')).toThrow();}finally{f.db.exec('ROLLBACK TO damaged; RELEASE damaged');}
  expect(()=>f.db.exec("UPDATE sessions SET kind='child' WHERE id=1")).toThrow();expect(f.repo.readSession(1)!.kind).toBe('user');
  expect(f.repo.readCheckpointOperation('read-owned')).toMatchObject({receipt:{sessionId:1}});expect(f.requests).toHaveLength(1);
});

for(const table of ['sessions','workspace','business_events'])test(`p9 checkpoint ${table} write failure rolls back position, Workspace and receipt`,async()=>{
  const f=await stoppedAnswer();commitAnswer(f);const request={sessionId:1,targetLeafId:f.fact.history!.activeLeafId!,expectedStorageVersion:f.repo.readSession(1)!.storageVersion,expectedWorkspaceRevision:f.repo.readWorkspace().revision},session=f.repo.readSession(1),workspace=f.repo.readWorkspace();
  f.db.exec(`CREATE TEMP TRIGGER p9_restore_fail BEFORE ${table==='business_events'?'INSERT':'UPDATE'} ON ${table} BEGIN SELECT RAISE(ABORT,'ENGINEERING position failure'); END;`);
  expect(()=>f.tx.immediate(()=>f.repo.restoreCheckpointInTransaction(request,'resume-failure',memoryAt))).toThrow();
  expect(f.repo.readSession(1)).toEqual(session);expect(f.repo.readWorkspace()).toEqual(workspace);expect(f.repo.readCheckpointOperation('resume-failure')).toBeNull();
  f.db.exec('DROP TRIGGER p9_restore_fail');expect(f.tx.immediate(()=>f.repo.restoreCheckpointInTransaction(request,'resume-failure',memoryAt))).toMatchObject({storageVersion:request.expectedStorageVersion+1});
});

test('p9 checkpoint admission rejects stale versions, non-user targets and persisted input or execution gaps without moving history',async()=>{
  const f=await stoppedAnswer();commitAnswer(f);const request={sessionId:1,targetLeafId:f.fact.history!.activeLeafId!,expectedStorageVersion:f.repo.readSession(1)!.storageVersion,expectedWorkspaceRevision:f.repo.readWorkspace().revision};
  const tables=['sessions','workspace','business_events'],facts=()=>tables.map(table=>f.db.query(`SELECT * FROM ${table} ORDER BY id`).all()),before=facts();
  for(const bad of [{...request,expectedStorageVersion:0},{...request,expectedWorkspaceRevision:0},{...request,targetLeafId:f.input.nativeEntryId},{...request,targetLeafId:'missing'}])expect(()=>f.tx.immediate(()=>f.repo.restoreCheckpointInTransaction(bad,'resume-bad',memoryAt))).toThrow();
  expect(facts()).toEqual(before);
  acceptContextInput(f.db,{consume:false,legacy:true,history:true});expect(()=>f.tx.immediate(()=>f.repo.restoreCheckpointInTransaction(request,'resume-running',memoryAt))).toThrow();expect(f.repo.readCheckpointOperation('resume-running')).toBeNull();
});

test('p9 public checkpoint commit survives failed rebuilding; original replay is read-only, explicit restore repairs without replay and next Send branches',async()=>{
  const f=await stoppedAnswer();commitAnswer(f);const next=await stoppedAnswer(f);commitAnswer(next);const {app,sessions}=applicationFor(f);
  const input={sessionId:1,targetLeafId:f.fact.history!.activeLeafId!,expectedStorageVersion:f.repo.readSession(1)!.storageVersion,expectedWorkspaceRevision:f.repo.readWorkspace().revision},context={instanceId:'host',operationRef:'resume-public'};
  const sdk=await import('@earendil-works/pi-coding-agent'),failure=spyOn(sdk,'createAgentSession').mockRejectedValueOnce(new Error('ENGINEERING restore assembly failure'));
  try{expect(await sessions.restoreCheckpoint(input,context)).toMatchObject({ok:false,error:{code:'resource_unavailable',reason:'session_restore_failed',operationRef:context.operationRef,sessionId:1}});}finally{failure.mockRestore();}
  const original=f.repo.readCheckpointOperation(context.operationRef)!;expect(original.receipt).toMatchObject({targetLeafId:input.targetLeafId,storageVersion:input.expectedStorageVersion+1,workspaceRevision:input.expectedWorkspaceRevision+1});
  expect(f.agent.readAvailability(1).availability).toBe('blocked');await expect(f.agent.ensureLoaded(1)).rejects.toMatchObject({reason:'session_restore_failed'});
  const writes=f.db.query('SELECT total_changes() n').get(),loads=spyOn(f.agent,'restore');
  try{expect(await sessions.restoreCheckpoint(input,context)).toEqual({ok:true,data:original.receipt});expect(loads).not.toHaveBeenCalled();}finally{loads.mockRestore();}
  expect(await sessions.restore({sessionId:1,expectedLeafId:next.fact.history!.activeLeafId}, {instanceId:'host',operationRef:'restore-stale'})).toMatchObject({ok:false,error:{code:'state_conflict',reason:'history_version_mismatch'}});
  expect(await sessions.restore({sessionId:1,expectedLeafId:input.targetLeafId},{instanceId:'host',operationRef:'restore-current'})).toMatchObject({ok:true,data:{session:{leafId:input.targetLeafId},runtime:{availability:'ready'}}});
  expect(f.db.query('SELECT total_changes() n').get()).toEqual(writes);expect(f.requests).toHaveLength(2);
  const result=await sessions.submit({...next.request,clientSequence:3,text:'ENGINEERING new branch question',expectedRevision:original.receipt.workspaceRevision},{instanceId:'host',operationRef:'send-new-branch'});expect(result).toMatchObject({ok:true,data:{runId:3}});
  const deadline=performance.now()+5000;while(app.runs.activeHandle&&performance.now()<deadline)await Bun.sleep(5);
  expect(f.repo.read({runId:3})).toMatchObject({kind:'one',run:{status:'completed'}});expect(f.requests).toHaveLength(3);
  const body=f.requests[2] as {messages:{role:string;content:string}[]};expect(body.messages.filter(message=>message.role==='user')).toHaveLength(2);
  const firstNew=f.db.query<{entry_json:string},[number]>("SELECT entry_json FROM memories WHERE run_id=? AND json_extract(entry_json,'$.message.role')='user' ORDER BY sequence LIMIT 1").get(3)!;
  const start=f.db.query<{entry_json:string},[number]>('SELECT entry_json FROM memories WHERE run_id=? ORDER BY sequence LIMIT 1').get(3)!;
  expect(JSON.parse(start.entry_json).parentId).toBe(input.targetLeafId);
  let parent=JSON.parse(firstNew.entry_json).parentId as string|null;
  while(parent!==input.targetLeafId){const entry=f.db.query<{entry_json:string;run_id:number},[string]>('SELECT entry_json,run_id FROM memories WHERE native_entry_id=?').get(parent!)!,native=JSON.parse(entry.entry_json);expect(entry.run_id).toBe(3);expect(['model_change','thinking_level_change']).toContain(native.type);parent=native.parentId;}
  expect(f.db.query('SELECT id FROM answers ORDER BY id').all()).toHaveLength(3);await app.shutdown();
});

test('p9 asynchronous history reservation blocks selection, creation, model changes, Workspace writes, deletion and shutdown until candidate resolves',async()=>{
  const f=await stoppedAnswer();commitAnswer(f);const {app,sessions,workspace}=applicationFor(f);let started!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;}),held=new Promise<void>(resolve=>{release=resolve;}),restore=f.agent.restore.bind(f.agent);
  const hook=spyOn(f.agent,'restore').mockImplementation(async id=>{started();await held;await restore(id);});
  const result=sessions.restore({sessionId:1,expectedLeafId:f.fact.history!.activeLeafId},{instanceId:'host',operationRef:'restore-held'});await entered;
  try {
    expect(app.runs.historyMutationPending).toBe(true);expect(await app.runs.readControl()).toMatchObject({ok:true,data:{acceptingNewRuns:false}});
    expect(await sessions.select({sessionId:1,expectedWorkspaceRevision:1})).toMatchObject({ok:false,error:{reason:'runtime_busy'}});
    expect(await sessions.create({expectedWorkspaceRevision:1},{instanceId:'host',operationRef:'create-during-restore'})).toMatchObject({ok:false,error:{reason:'runtime_busy'}});
    expect(await sessions.rename({sessionId:1,title:'ENGINEERING rename',expectedMetadataRevision:0},{instanceId:'host',operationRef:'rename-held'})).toMatchObject({ok:false,error:{reason:'runtime_busy'}});
    expect(await sessions.delete({sessionId:1,expectedMetadataRevision:0,expectedWorkspaceRevision:1},{instanceId:'host',operationRef:'delete-held'})).toMatchObject({ok:false,error:{reason:'runtime_busy'}});
    await expect(app.prepareConfig('config-held',{...app.config,configVersion:'2'})).rejects.toMatchObject({reason:'runtime_busy'});
    expect(await workspace.update({activeView:'data'},1)).toMatchObject({ok:false,error:{reason:'runtime_busy'}});expect(await workspace.restore()).toMatchObject({ok:false,error:{reason:'runtime_busy'}});
    await expect(app.shutdown()).rejects.toMatchObject({reason:'runtime_busy'});expect(f.requests).toHaveLength(1);
  } finally {release();hook.mockRestore();}
  expect(await result).toMatchObject({ok:true,data:{runtime:{availability:'ready'}}});expect(app.runs.historyMutationPending).toBe(false);await app.shutdown();
});

test('p9 Workspace restore begun before a history reservation rechecks its write gate after asynchronous inspection',async()=>{
  const f=await stoppedAnswer();commitAnswer(f);const {app,sessions}=applicationFor(f),before=f.repo.readWorkspace();
  let inspected!:()=>void,finishInspection!:()=>void,restoring!:()=>void,finishRestore!:()=>void;
  const inspectionStarted=new Promise<void>(r=>{inspected=r;}),inspectionHeld=new Promise<void>(r=>{finishInspection=r;});
  const restoreStarted=new Promise<void>(r=>{restoring=r;}),restoreHeld=new Promise<void>(r=>{finishRestore=r;});
  const inspect=f.repo.inspectWorkspace.bind(f.repo),restore=f.agent.restore.bind(f.agent);
  const inspectHook=spyOn(f.repo,'inspectWorkspace').mockImplementation(invalid=>({...inspect(invalid),artifactIds:[99]}));
  const restoreHook=spyOn(f.agent,'restore').mockImplementation(async id=>{restoring();await restoreHeld;await restore(id);});
  const workspace=new WorkspaceService(f.repo,{inspectManagedImport:async()=>{inspected();await inspectionHeld;return {status:'valid'};}},()=>app.runs.assertNoHistoryMutation());
  const pendingWorkspace=workspace.restore();await inspectionStarted;
  const pendingHistory=sessions.restore({sessionId:1,expectedLeafId:f.fact.history!.activeLeafId},{instanceId:'host',operationRef:'restore-after-inspection'});await restoreStarted;
  try{finishInspection();expect(await pendingWorkspace).toMatchObject({ok:false,error:{reason:'runtime_busy'}});expect(f.repo.readWorkspace()).toEqual(before);expect(f.requests).toHaveLength(1);}
  finally{finishInspection();finishRestore();inspectHook.mockRestore();restoreHook.mockRestore();}
  expect(await pendingHistory).toMatchObject({ok:true});await app.shutdown();
});

for(const afterRelease of [false,true])test(`p9 committed final release failure (${afterRelease?'after':'before'} release) retains original fact and blocks admission until release-only retry`,async()=>{
  const f=await setup(),allocated=f.agent.allocate();f.repo.createSession({expectedWorkspaceRevision:0},'create-release',allocated.nativeSessionId,memoryAt,allocated.history);allocated.bind(1);
  const settings=PublishedSettingsSchema.parse({schemaVersion:'medclaw.settings/p1-v1',configVersion:'1',model:null,customProviders:[],credentialRefs:{},requestPolicy:{timeoutMs:10000,maxRetries:0,maxRetryDelayMs:2000},previous:null,rollbackFromVersion:null});
  const notices:unknown[]=[],release=f.agent.releaseHistoryFacts.bind(f.agent),frozen=spyOn(f.agent,'readFinalHistory');let fail=true;
  const hook=spyOn(f.agent,'releaseHistoryFacts').mockImplementation(runId=>{if(afterRelease)release(runId);if(fail){fail=false;throw new Error('ENGINEERING release failure');}if(!afterRelease)release(runId);});
  const service=new RuntimeService('host',()=>settings,f.runtime,f.repo,(_context,action)=>action(),(runId,kind,time)=>new ModelCallRecorder(f.repo,runId,kind,time),notice=>notices.push(notice),()=>{},f.agent,()=>false);
  try {
    const result=await service.submitAgent({sessionId:1,clientSequence:1,text:'ENGINEERING release answer',mode:'send',model:{provider:'p9-fixture',modelId:'fixture',expectedConfigVersion:'1'},expectedRevision:1,expectedBatchIds:[],expectedQueryId:null,referenceDate:'2026-10-05',timezone:'Asia/Shanghai'}, {instanceId:'host',operationRef:'send-release'});
    if(!result.ok||result.data.runId===null)throw new Error('Expected accepted real Run');const runId=result.data.runId;
    const deadline=performance.now()+5000;while((f.repo.read({runId}).kind!=='one'||!service.persistencePending)&&performance.now()<deadline)await Bun.sleep(5);
    expect(f.repo.read({runId})).toMatchObject({kind:'one',run:{status:'completed',answerNativeLeafId:expect.any(String)}});
    expect(service.persistencePending).toBe(true);expect(service.activeHandle?.runId).toBe(runId);expect(await service.readControl()).toMatchObject({ok:true,data:{acceptingNewRuns:false}});
    expect(notices).toContainEqual(expect.objectContaining({type:'agent.persistence_failed',runId}));
    const original=f.db.query('SELECT * FROM runs').all(),answer=f.db.query('SELECT * FROM answers').all(),changes=f.db.query('SELECT total_changes() n').get();
    expect(await service.retrySave(runId)).toMatchObject({ok:true,data:{status:'completed'}});
    expect(f.db.query('SELECT total_changes() n').get()).toEqual(changes);expect(f.db.query('SELECT * FROM runs').all()).toEqual(original);expect(f.db.query('SELECT * FROM answers').all()).toEqual(answer);
    expect(frozen).toHaveBeenCalledTimes(1);expect(service.activeHandle).toBeNull();expect(service.persistencePending).toBe(false);expect(f.requests).toHaveLength(1);
  } finally {hook.mockRestore();frozen.mockRestore();await service.shutdown().catch(()=>{});}
});

test('p9 ordinary commit with a lost return confirms original database evidence and never repeats a model request',async()=>{
  const f=await setup(),allocated=f.agent.allocate();f.repo.createSession({expectedWorkspaceRevision:0},'create-unknown',allocated.nativeSessionId,memoryAt,allocated.history);allocated.bind(1);
  const real=f.tx.immediate.bind(f.tx);let lost=false;
  const hook=spyOn(f.tx,'immediate').mockImplementation(action=>{const result=real(action);if(!lost&&f.db.query('SELECT id FROM memories LIMIT 1').get()){lost=true;throw new Error('ENGINEERING committed return lost');}return result;});
  try {
    const resolved=await f.runtime.resolve({provider:'p9-fixture',modelId:'fixture',expectedConfigVersion:'1'},'1',null,{timeoutMs:10000,maxRetries:0,maxRetryDelayMs:2000});
    const accepted=acceptContextInput(f.db,{consume:false,model:resolved.selection,legacy:true,history:true});f.repo.beginInputDelivery(accepted.input.inputId,'host',memoryAt);
    const observed=await f.agent.execute({sessionId:1,runId:accepted.input.runId,inputId:accepted.input.inputId,text:accepted.request.text,resolved,agentOptions:f.agent.describe(resolved),scope:accepted.input.scope,workspaceContext:accepted.input.workspaceContext,referenceDate:accepted.request.referenceDate,timezone:accepted.request.timezone,signal:new AbortController().signal,deadlineAt:performance.now()+10000},{startCall:at=>new ModelCallRecorder(f.repo,accepted.input.runId,'main',at),preview:()=>{},nativeTerminal:()=>{},inputStore:f.repo});
    expect(lost).toBe(true);expect(observed.lastOutcome?.callState).toBe('completed');expect(f.agent.hasPendingHistoryPersistence(accepted.input.runId)).toBe(false);expect(f.requests).toHaveLength(1);
  } finally {hook.mockRestore();}
});

for(const table of ['memories','sessions','answers','session_inputs','runs','runtime_events','business_events'])test(`p9 atomic final rollback at ${table} retains committed prefix and pending input, then retries without another request`,async()=>{
  const f=await stoppedAnswer();expect(f.fact.history!.newEntries.length).toBeGreaterThan(0);
  const tables=['memories','sessions','answers','session_inputs','runs','model_calls','runtime_events','business_events'];
  const facts=()=>tables.map(name=>f.db.query(`SELECT * FROM ${name} ORDER BY id`).all()),before=facts();
  expect(f.db.query('SELECT id FROM answers').all()).toEqual([]);expect(f.repo.readInput({inputId:f.input.inputId})!.processingStatus).toBe('pending');
  const update=['sessions','session_inputs','runs'].includes(table),when=table==='session_inputs'?"WHEN NEW.processing_status='completed'":table==='runs'?"WHEN NEW.status='completed'":table==='runtime_events'?"WHEN NEW.type='run_completed'":'';
  f.db.exec(`CREATE TEMP TRIGGER p9_final_failure BEFORE ${update?'UPDATE':'INSERT'} ON ${table} ${when} BEGIN SELECT RAISE(ABORT,'ENGINEERING final rollback'); END;`);
  expect(()=>f.repo.finalizeAgent(f.input.runId,f.fact)).toThrow();expect(facts()).toEqual(before);expect(f.repo.isFinalSaved(f.input.runId,f.fact)).toBe(false);expect(f.requests).toHaveLength(1);
  f.db.exec('DROP TRIGGER p9_final_failure');f.repo.finalizeAgent(f.input.runId,f.fact);
  expect(f.repo.isFinalSaved(f.input.runId,f.fact)).toBe(true);expect(f.repo.readInput({inputId:f.input.inputId})).toMatchObject({status:'consumed',processingStatus:'completed'});
  expect(f.db.query('SELECT native_leaf_id,input_id,text FROM answers').get()).toEqual({native_leaf_id:f.fact.history!.activeLeafId,input_id:f.input.inputId,text:f.fact.outputText});
  expect(f.db.query('SELECT status FROM runs').get()).toEqual({status:'completed'});expect(await f.store.load(1)).toMatchObject({ok:true,data:{activeLeafId:f.fact.history!.activeLeafId,storageVersion:f.fact.history!.expectedStorageVersion+1}});
  f.agent.acknowledgeHistorySaved(f.fact.history!,f.fact.history!.expectedStorageVersion+1);f.agent.releaseInputFacts(f.input.runId);f.agent.releaseToolFacts(f.input.runId);f.agent.releaseHistoryFacts(f.input.runId);expect(f.requests).toHaveLength(1);
});

test('p9 original final proof survives later leaf changes and rejects missing original Answer, input or events',async()=>{
  const f=await stoppedAnswer();f.repo.finalizeAgent(f.input.runId,f.fact);expect(f.repo.isFinalSaved(f.input.runId,f.fact)).toBe(true);
  expect(await f.store.commit({sessionId:1,runId:f.input.runId,expectedStorageVersion:f.fact.history!.expectedStorageVersion+1,header:f.fact.history!.header,newEntries:[],activeLeafId:null})).toMatchObject({ok:true});
  expect(f.repo.isFinalSaved(f.input.runId,f.fact)).toBe(true);expect(f.repo.confirmHistorySaved(f.fact.history!)).toEqual({storageVersion:f.fact.history!.expectedStorageVersion+1});
  for(const mutation of ["UPDATE answers SET native_leaf_id=NULL","UPDATE session_inputs SET processing_status='failed'","DELETE FROM runtime_events WHERE type='run_completed'","DELETE FROM runtime_events WHERE type='history_saved'","DELETE FROM business_events WHERE type='answer_committed'"]) {
    f.db.exec('SAVEPOINT proof_damage');try{f.db.exec(mutation);expect(f.repo.isFinalSaved(f.input.runId,f.fact)).toBe(false);}finally{f.db.exec('ROLLBACK TO proof_damage');f.db.exec('RELEASE proof_damage');}
  }
});

test('p9 successful final facts cannot omit or substitute their native assistant and original Run history',async()=>{
  const f=await stoppedAnswer(),before=f.db.query('SELECT * FROM sessions').all();
  for(const bad of [{...f.fact,history:undefined},{...f.fact,outputText:'ENGINEERING invented answer'},{...f.fact,history:{...f.fact.history!,activeLeafId:f.repo.readSession(1)!.leafId}},{...f.fact,history:{...f.fact.history!,runId:999}}]) {
    expect(()=>f.repo.finalizeAgent(f.input.runId,bad)).toThrow();expect(f.db.query('SELECT * FROM sessions').all()).toEqual(before);expect(f.db.query('SELECT * FROM answers').all()).toEqual([]);
  }
  expect(f.requests).toHaveLength(1);
});

test('p9 a first successful final cannot adopt an assistant already saved outside the final transaction',async()=>{
  const f=await stoppedAnswer(),result=await f.store.commit(f.fact.history!);if(!result.ok)throw result.error;
  const bad={...f.fact,history:{...f.fact.history!,expectedStorageVersion:result.data.storageVersion}};
  expect(()=>f.repo.finalizeAgent(f.input.runId,bad)).toThrow();expect(f.db.query('SELECT id FROM answers').all()).toEqual([]);
  expect(f.repo.readInput({inputId:f.input.inputId})).toMatchObject({processingStatus:'pending'});
});

test('p9 root input history proof must identify its owned native user, never an assistant',async()=>{
  const f=await stoppedAnswer();f.db.query('UPDATE session_inputs SET native_entry_id=? WHERE id=?').run(f.fact.history!.activeLeafId,f.input.inputId);
  expect(()=>f.repo.finalizeAgent(f.input.runId,f.fact)).toThrow();expect(f.db.query('SELECT id FROM answers').all()).toEqual([]);
});

test('p9 lost-return proof rejects a malformed terminal payload even if its few projected fields match',async()=>{
  const f=await stoppedAnswer();f.repo.finalizeAgent(f.input.runId,f.fact);
  f.db.exec("UPDATE runtime_events SET payload_json=json_remove(payload_json,'$.contract') WHERE type='run_completed'");
  expect(f.repo.isFinalSaved(f.input.runId,f.fact)).toBe(false);
});

test('p9 actual Runtime reads SQLite without loading; public factory restores all entries and non-last leaf with no request or write',async()=>{
  const f=await setup(),a=f.seed('ENGINEERING A'),b=f.seed('ENGINEERING B');
  for(const s of[a,b])expect(await f.store.commit({sessionId:s.sessionId,runId:null,expectedStorageVersion:1,header:s.manager.getHeader(),newEntries:s.manager.getEntries(),activeLeafId:s.manager.getLeafId()})).toMatchObject({ok:true});
  const before=f.db.query('SELECT total_changes() n').get();
  expect(f.agent.readAvailability(a.sessionId)).toEqual({availability:'unloaded',error:null});
  expect(await f.agent.read(a.sessionId)).toMatchObject({available:true,storageVersion:2,leafId:a.manager.getLeafId(),messages:[{role:'user',text:'ENGINEERING A'},{role:'assistant',text:'ENGINEERING reply ENGINEERING A'}]});
  expect(await f.agent.readMessages({sessionId:b.sessionId,leafId:null,afterEntryId:null,limit:50})).toMatchObject({source:'sqlite_history',leafId:b.manager.getLeafId()});
  expect(f.agent.readAvailability(b.sessionId).availability).toBe('unloaded');
  await f.agent.ensureLoaded(a.sessionId);await f.agent.ensureLoaded(b.sessionId);
  const bindings=Reflect.get(f.agent,'sessions') as Map<number,{manager:SessionManager;session:AgentSession}>;
  for(const s of[a,b]){const bound=bindings.get(s.sessionId)!;expect(bound.manager.getHeader()).toEqual(s.manager.getHeader());expect(bound.manager.getEntries()).toEqual(s.manager.getEntries());expect(bound.manager.getLeafId()).toBe(s.manager.getLeafId());expect(bound.session.agent.state.messages).toEqual(s.manager.buildSessionContext().messages);expect(bound.session.isIdle).toBe(true);expect(f.agent.readAvailability(s.sessionId)).toEqual({availability:'ready',error:null});}
  expect(bindings.get(a.sessionId)!.manager).not.toBe(bindings.get(b.sessionId)!.manager);expect(bindings.get(a.sessionId)!.session).not.toBe(bindings.get(b.sessionId)!.session);
  expect(f.db.query('SELECT total_changes() n').get()).toEqual(before);expect(f.requests).toEqual([]);
});

test('p9 cold and null-leaf histories retain all old branches without factory defaults or writes',async()=>{
  const f=await setup(),cold=f.seed('ENGINEERING cold',false),reset=f.seed('ENGINEERING reset');reset.manager.resetLeaf();
  expect(await f.store.commit({sessionId:reset.sessionId,runId:null,expectedStorageVersion:1,header:reset.manager.getHeader(),newEntries:reset.manager.getEntries(),activeLeafId:null})).toMatchObject({ok:true});
  const before=f.db.query('SELECT total_changes() n').get();await f.agent.ensureLoaded(cold.sessionId);await f.agent.ensureLoaded(reset.sessionId);
  const bindings=Reflect.get(f.agent,'sessions') as Map<number,{manager:SessionManager;session?:AgentSession}>;
  expect(bindings.get(cold.sessionId)!.session).toBeUndefined();expect(bindings.get(reset.sessionId)!.session).toBeUndefined();expect(bindings.get(reset.sessionId)!.manager.getEntries()).toEqual(reset.manager.getEntries());
  expect(await f.agent.readMessages({sessionId:reset.sessionId,leafId:null,afterEntryId:null,limit:50})).toMatchObject({items:[],leafId:null,source:'sqlite_history'});expect(f.db.query('SELECT total_changes() n').get()).toEqual(before);expect(f.requests).toEqual([]);
});

test('p9 restores M1 to M2 native model history without a request; the next explicit Run applies M3 and preserves original IDs',async()=>{
  const f=await setup({models:['fixture','second','third']}),a=f.seed('ENGINEERING model history');a.manager.appendModelChange('p9-fixture','second');
  expect(await f.store.commit({sessionId:1,runId:null,expectedStorageVersion:1,header:a.manager.getHeader(),newEntries:a.manager.getEntries(),activeLeafId:a.manager.getLeafId()})).toMatchObject({ok:true});
  const saved=f.db.query('SELECT * FROM memories ORDER BY sequence').all(),changes=f.db.query('SELECT total_changes() n').get();await f.agent.ensureLoaded(1);
  const bindings=Reflect.get(f.agent,'sessions') as Map<number,{manager:SessionManager;session:AgentSession}>;expect(bindings.get(1)!.session.model?.id).toBe('second');expect(bindings.get(1)!.manager.getEntries()).toEqual(a.manager.getEntries());expect(f.requests).toEqual([]);expect(f.db.query('SELECT total_changes() n').get()).toEqual(changes);
  const resolved=await f.runtime.resolve({provider:'p9-fixture',modelId:'third',expectedConfigVersion:'1'},'1',null,{timeoutMs:10000,maxRetries:0,maxRetryDelayMs:2000});
  const accepted=acceptContextInput(f.db,{consume:false,model:resolved.selection,legacy:true,history:true});f.repo.beginInputDelivery(accepted.input.inputId,'host',memoryAt);
  const observation=await f.agent.execute({sessionId:1,runId:accepted.input.runId,inputId:accepted.input.inputId,text:accepted.request.text,resolved,agentOptions:f.agent.describe(resolved),scope:accepted.input.scope,workspaceContext:accepted.input.workspaceContext,referenceDate:accepted.request.referenceDate,timezone:accepted.request.timezone,signal:new AbortController().signal,deadlineAt:performance.now()+10000},{startCall:at=>new ModelCallRecorder(f.repo,accepted.input.runId,'main',at),preview:()=>{},nativeTerminal:()=>{},inputStore:f.repo});
  expect(observation.lastOutcome?.callState).toBe('completed');expect(f.requests).toHaveLength(1);expect(f.requests[0]).toMatchObject({model:'third'});expect(JSON.stringify(f.requests[0])).toContain('ENGINEERING model history');
  expect(f.db.query('SELECT * FROM memories ORDER BY sequence').all().slice(0,saved.length)).toEqual(saved);const models=bindings.get(1)!.manager.getEntries().filter(e=>e.type==='model_change').map(e=>e.modelId);expect(models).toEqual(['fixture','second','third']);
});

test('p9 failed rebuilding blocks only its Session; ensureLoaded never retries it and explicit restore has no replay',async()=>{
  const f=await setup(),a=f.seed('ENGINEERING A'),b=f.seed('ENGINEERING B');
  for(const s of[a,b])expect(await f.store.commit({sessionId:s.sessionId,runId:null,expectedStorageVersion:1,header:s.manager.getHeader(),newEntries:s.manager.getEntries(),activeLeafId:s.manager.getLeafId()})).toMatchObject({ok:true});
  const before=f.db.query('SELECT total_changes() n').get(),sdk=await import('@earendil-works/pi-coding-agent');
  const failure=spyOn(sdk,'createAgentSession').mockRejectedValueOnce(new Error('ENGINEERING assembly failure'));
  try{await expect(f.agent.ensureLoaded(a.sessionId)).rejects.toMatchObject({code:'session_history_unavailable',reason:'session_restore_failed'});}finally{failure.mockRestore();}
  expect(f.agent.readAvailability(a.sessionId)).toMatchObject({availability:'blocked',error:{reason:'session_restore_failed'}});
  await expect(f.agent.ensureLoaded(a.sessionId)).rejects.toMatchObject({reason:'session_restore_failed'});await f.agent.ensureLoaded(b.sessionId);expect(f.agent.readAvailability(b.sessionId).availability).toBe('ready');
  expect(await f.agent.read(a.sessionId)).toMatchObject({available:true,leafId:a.manager.getLeafId()});await f.agent.restore(a.sessionId);expect(f.agent.readAvailability(a.sessionId).availability).toBe('ready');
  expect(f.db.query('SELECT total_changes() n').get()).toEqual(before);expect(f.requests).toEqual([]);
});
