import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, SCHEMA_VERSION } from '../../packages/storage/src/database';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { memoryAt, memoryNativeFixture, memoryAssistant, sqliteHistory } from '../fixtures/p9-memory';
import { contextModel } from '../fixtures/p8-context';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteWriteTransactions } from '../../packages/storage/src/write-transactions';
import type { CompactionReceipt, CompactionCallOwner, CompactionSaveFact } from '../../packages/contracts/src/session';
import { canonicalRequest, type FinalCallFact } from '../../packages/contracts/src/run';
import { DEFAULT_REQUEST_POLICY } from '../../packages/contracts/src/model';
import {SqliteEventStore} from '../../packages/storage/src/event-store';
import { toWorkspaceContext } from '../../packages/contracts/src/workspace';
import { SqliteContextStore } from '../../packages/storage/src/context-store';

function schema9() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p10-')), path = join(root, 'app.sqlite'), db = new Database(path, { strict: true });
  const names = ['001_p1.sql','002_p2.sql','003_p3.sql','004_p5.sql','005_p6.sql','006_session_lifecycle.sql','007_batch_deletion.sql','008_p8.sql','009_p9.sql'];
  for (const [i,name] of names.entries()) {
    db.exec('PRAGMA foreign_keys=OFF'); const sql = readFileSync(new URL(`../../packages/storage/src/migrations/${name}`, import.meta.url)); db.exec(sql.toString());
    db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(i+1,createHash('sha256').update(sql).digest('hex'),memoryAt);
  }
  db.exec('PRAGMA foreign_keys=ON'); seedWorkspaceQueries(db);
  db.query(`INSERT INTO model_calls(id,call_id,run_id,session_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,started_at)
    VALUES(21,'original',10,1,'main',1,'logical_request',1,'{ "context": { "snapshotId": 31 }, "raw": "工程😀" }','started',?)`).run(memoryAt);
  db.query(`INSERT INTO context_snapshots(id,run_id,session_id,sequence,snapshot_json,created_at) VALUES(31,10,1,1,'{ "contract": "medclaw.context/v1", "raw": "工程😀" }',?)`).run(memoryAt);
  db.query('INSERT INTO context_deliveries(model_call_id,snapshot_id,run_id,session_id,delivered_at) VALUES(21,31,10,1,?)').run(memoryAt);
  db.query(`INSERT INTO tool_calls(session_id,run_id,native_tool_call_id,model_call_id,context_snapshot_id,tool_name,tool_version,effect,execution_mode,args_json,status,result_json,requested_at,ended_at)
    VALUES(1,10,'schema9-tool',21,31,'read_query','0.87.1','READ','sequential','{}','succeeded','{ "raw": "工程😀" }',?,?)`).run(memoryAt,memoryAt);
  const native = memoryNativeFixture();
  db.transaction(() => {
    db.query('UPDATE sessions SET native_session_id=?,native_header_json=?,history_format_version=?,storage_version=2,current_leaf_id=? WHERE id=1')
      .run(native.header.id,JSON.stringify(native.header),'pi-session/3;pi-sdk/0.87.1',native.activeLeafId);
    for (const [i,entry] of native.entries.entries()) db.query('INSERT INTO memories(session_id,native_entry_id,parent_entry_id,sequence,entry_type,entry_json,run_id,recorded_at) VALUES(1,?,?,?,?,?,10,?)')
      .run(entry.id,entry.parentId,i+1,entry.type,JSON.stringify(entry),memoryAt);
  }).immediate();
  const tables = db.query<{name:string},[]>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all().map(row=>row.name);
  const rows = tables.map(name=>db.query<Record<string, unknown>, []>(`SELECT * FROM ${name} ORDER BY id`).all());
  return { root,path,db,tables,rows };
}

test('p10 schema9 migration preserves complete old rows and native/P8 references while admitting only explicit manual ownership', () => {
  const f = schema9(); let db = f.db;
  try {
    db.close(); db = openDatabase(f.path); expect(SCHEMA_VERSION).toBe(13);
    for (const [i,name] of f.tables.entries()) {
      const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM ${name} ORDER BY id`).all();
      expect(rows.map((row, n) => Object.fromEntries(Object.keys(f.rows[i]![n]!).map(key => [key, row[key]])))).toEqual(f.rows[i]);
    }
    expect(db.query<Record<string, unknown>, []>('SELECT parent_run_id,origin_tool_call_id,child_result_json FROM runs').all().every(row => Object.values(row).every(value => value === null))).toBe(true);
    expect(db.query('SELECT version FROM schema_migrations').all()).toHaveLength(13);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]); expect(db.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
    expect(db.query('PRAGMA foreign_keys').get()).toEqual({foreign_keys:1});
    const metadata = { compaction: { contract: 'medclaw.compaction/v1', operationRef: 'manual', source: 'manual', reason: 'manual', ordinal: 1 } };
    const insert = (callId:string, runId:number|null, sessionId:number|null, kind:string, model:unknown, inputId:number|null=null) => db.query(`INSERT INTO model_calls(call_id,run_id,session_id,input_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,started_at)
      VALUES(?,?,?,?,?,1,'logical_request',1,?,'started',?)`).run(callId,runId,sessionId,inputId,kind,JSON.stringify(model),memoryAt);
    expect(()=>insert('manual',null,1,'compaction',metadata)).not.toThrow();
    for (const [i,invalid] of [
      [null,1,'main',{}], [null,null,'compaction',metadata], [10,1,'compaction',metadata], [null,1,'compaction',{compaction:{...metadata.compaction,reason:undefined}}],
      [null,1,'compaction',{compaction:{...metadata.compaction,source:'auto',reason:'threshold'}}], [null,1,'compaction',metadata,1],
      [10,1,'compaction',{compaction:{...metadata.compaction,source:'auto',reason:'wrong'}}],
    ].entries()) expect(()=>insert(`invalid-${i}`,invalid[0] as number|null,invalid[1] as number|null,invalid[2] as string,invalid[3],invalid[4] as number|undefined)).toThrow();
    expect(()=>insert('automatic',10,1,'compaction',{compaction:{...metadata.compaction,source:'auto',reason:'threshold'}})).not.toThrow();
    expect(()=>db.query(`INSERT INTO tool_calls(session_id,run_id,native_tool_call_id,model_call_id,context_snapshot_id,tool_name,tool_version,effect,execution_mode,args_json,status,requested_at)
      VALUES(1,10,'forged-tool',(SELECT id FROM model_calls WHERE call_id='manual'),NULL,'read_query','0.87.1','READ','sequential','{}','requested',?)`).run(memoryAt)).toThrow('tool_model_owner_mismatch');
    expect(db.query("SELECT name FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' AND strict<>1").all()).toEqual([]);
    expect(()=>db.query('UPDATE model_calls SET session_id=NULL WHERE id=21').run()).toThrow('model_call_owner_mismatch');
  } finally { db.close(); rmSync(f.root,{recursive:true,force:true}); }
});

for (const fault of ['p10_copy','p10_rename','p10_marker']) test(`p10 ${fault} failure rolls back schema and every old field to schema9`, () => {
  const f = schema9(); f.db.close();
  try {
    let reached = false;
    let unexpected: Database | undefined;
    try { expect(()=>{unexpected=openDatabase(f.path,phase=>{if(phase===fault){reached=true;throw new Error('ENGINEERING fault');}});}).toThrow('storage_migration_failed'); }
    finally { unexpected?.close(); }
    expect(reached).toBe(true);
    const raw = new Database(f.path,{strict:true});
    try {
      expect(raw.query('SELECT version FROM schema_migrations').all()).toHaveLength(9);
      for (const [i,name] of f.tables.entries()) expect(raw.query(`SELECT * FROM ${name} ORDER BY id`).all()).toEqual(f.rows[i]);
      expect(raw.query("SELECT name FROM sqlite_schema WHERE name='model_calls_p10'").get()).toBeNull();
      expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { raw.close(); }
    const recovered = openDatabase(f.path); recovered.close();
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test('p10 manual operation reserves one identity across start, cancellation and terminal facts without creating a Run', () => {
  const root = mkdtempSync(join(tmpdir(),'medclaw-p10-manual-')), db = openDatabase(join(root,'app.sqlite'));
  try {
    const repos = new Repositories(db), native = memoryNativeFixture();
    repos.createSession({expectedWorkspaceRevision:0},'create',native.header.id,memoryAt,{header:native.header,entries:[],activeLeafId:null});
    const accept = Reflect.get(repos,'acceptCompaction'); expect(accept).toBeDefined();
    const request = {sessionId:1,expectedStorageVersion:1,model:{provider:contextModel.provider,modelId:contextModel.modelId,expectedConfigVersion:'1'}};
    const frozen = {model:contextModel,baseStorageVersion:1,baseLeafId:null,settings:{enabled:true,reserveTokens:256,keepRecentTokens:128},budget:{maxModelCalls:4,timeoutMs:5000},instanceId:'host',startedAt:memoryAt};
    const accepted = accept.call(repos,request,'manual',frozen);
    expect(accept.call(repos,request,'manual',frozen)).toEqual(accepted);
    expect(()=>accept.call(repos,{...request,expectedStorageVersion:2},'manual',frozen)).toThrow('state_conflict');
    expect(repos.findOperation('manual')).toMatchObject({method:'session.compact',originalRequest:request,result:accepted});
    const read = Reflect.get(repos,'readCompactionOperation'), cancel = Reflect.get(repos,'requestCompactionCancel');
    expect(()=>read.call(repos,{sessionId:2,operationRef:'manual'})).toThrow('access_denied');
    expect(cancel.call(repos,{sessionId:1,operationRef:'manual'},memoryAt)).toBe(true);
    expect(cancel.call(repos,{sessionId:1,operationRef:'manual'},memoryAt)).toBe(false);
    const receipt: CompactionReceipt = {contract:'medclaw.compaction/v1',operationRef:'manual',sessionId:1,runId:null,reason:'manual',status:'cancelled',nativeGenerated:false,nativeSaved:false,
      nativeEntryId:null,firstKeptEntryId:null,tokensBefore:null,estimatedTokensAfter:null,baseStorageVersion:1,storageVersion:null,activeLeafId:null,callIds:[],continuationEligibleAtCommit:false,
      cancelRequestedAt:memoryAt,stoppedAt:memoryAt,finishedAt:memoryAt,noOpReason:null,error:null};
    const tx = SqliteWriteTransactions.forDatabase(db), commit = Reflect.get(repos,'commitCompactionInTransaction');
    expect(()=>commit.call(repos,null,receipt)).toThrow();
    expect(tx.immediate(()=>commit.call(repos,null,receipt))).toBe(1);
    expect(tx.immediate(()=>commit.call(repos,null,receipt))).toBe(1);
    expect(read.call(repos,{sessionId:1,operationRef:'manual'})).toMatchObject({receipt,cancelRequestedAt:memoryAt});
    expect(repos.findOperation('manual')).toMatchObject({method:'session.compact',result:{receipt}});
    expect(cancel.call(repos,{sessionId:1,operationRef:'manual'},memoryAt)).toBe(false);
    expect(db.query("SELECT type FROM business_events WHERE operation_ref='manual' ORDER BY id").all()).toEqual([{type:'session_compaction_started'},{type:'session_compaction_cancel_requested'},{type:'session_compaction_finished'}]);
    for (const table of ['runs','session_inputs','answers','model_calls','runtime_events']) expect(db.query(`SELECT id FROM ${table}`).all()).toEqual([]);
    expect(db.query('SELECT storage_version FROM sessions').get()).toEqual({storage_version:1});
  } finally { db.close(); rmSync(root,{recursive:true,force:true}); }
});

test('p10 each actual summary has a separately durable call; owner, ordinal, duplicate and after-cancel guards precede any Provider request', () => {
  const root = mkdtempSync(join(tmpdir(),'medclaw-p10-call-')), db = openDatabase(join(root,'app.sqlite'));
  try {
    const repos = new Repositories(db), native = memoryNativeFixture();
    repos.createSession({expectedWorkspaceRevision:0},'create',native.header.id,memoryAt,{header:native.header,entries:[],activeLeafId:null});
    const start = Reflect.get(repos,'startCompactionCall'); expect(start).toBeDefined();
    const request = {sessionId:1,expectedStorageVersion:1,model:{provider:contextModel.provider,modelId:contextModel.modelId,expectedConfigVersion:'1'}};
    const frozen = {model:contextModel,baseStorageVersion:1,baseLeafId:null,settings:{enabled:true,reserveTokens:256,keepRecentTokens:128},budget:{maxModelCalls:4,timeoutMs:5000},instanceId:'host',startedAt:memoryAt};
    Reflect.get(repos,'acceptCompaction').call(repos,request,'manual',frozen);
    const owner: CompactionCallOwner = {operationRef:'manual',sessionId:1,runId:null,source:'manual',reason:'manual',model:contextModel,baseStorageVersion:1,baseLeafId:null,ordinal:1};
    expect(()=>start.call(repos,{callId:'invalid',owner:{...owner,ordinal:2},startedAt:memoryAt})).toThrow();
    start.call(repos,{callId:'first',owner,startedAt:memoryAt});
    expect(new SqliteContextStore(db).read({callId:'first'})).toEqual({kind:'not_recorded',runId:null,sessionId:1,callId:'first',reason:'not_applicable'});
    const fact: FinalCallFact = {callId:'first',state:'completed',responseModel:'fixture',sdkStopReason:'stop',endedAt:memoryAt,durationMs:3,inputTokens:10,outputTokens:2,cost:null,costCurrency:null,usageSource:'provider',unavailableReason:'pricing_unknown',error:null};
    const finish = Reflect.get(repos,'finishCompactionCall'); finish.call(repos,owner,fact); finish.call(repos,owner,fact);
    expect(()=>finish.call(repos,owner,{...fact,inputTokens:20})).toThrow('state_conflict');
    expect(()=>finish.call(repos,{...owner,sessionId:2},fact)).toThrow();
    start.call(repos,{callId:'second',owner:{...owner,ordinal:2},startedAt:memoryAt});
    expect(db.query('SELECT run_id,session_id,input_id,kind,state,input_tokens FROM model_calls ORDER BY id').all()).toEqual([
      {run_id:null,session_id:1,input_id:null,kind:'compaction',state:'completed',input_tokens:10},
      {run_id:null,session_id:1,input_id:null,kind:'compaction',state:'started',input_tokens:null}]);
    Reflect.get(repos,'requestCompactionCancel').call(repos,{sessionId:1,operationRef:'manual'},memoryAt);
    expect(()=>start.call(repos,{callId:'late',owner:{...owner,ordinal:3},startedAt:memoryAt})).toThrow('state_conflict');
    expect(repos.findOperation('manual')).toMatchObject({method:'session.compact'});
    expect(db.query('SELECT id FROM context_snapshots').all()).toEqual([]); expect(db.query('SELECT id FROM context_deliveries').all()).toEqual([]);
  } finally { db.close(); rmSync(root,{recursive:true,force:true}); }
});

for (const buffered of [false,true]) test(`p10 ${buffered ? 'buffered' : 'direct'} Run registration freezes actual enabled compaction settings`, () => {
  const root = mkdtempSync(join(tmpdir(),'medclaw-p10-freeze-')), db = openDatabase(join(root,'app.sqlite'));
  try {
    const repos = new Repositories(db), native = memoryNativeFixture();
    repos.createSession({expectedWorkspaceRevision:0},'create',native.header.id,memoryAt,{header:native.header,entries:[],activeLeafId:null});
    const workspace = toWorkspaceContext(repos.readWorkspace()), scope = repos.freezeAgentScope(workspace,[]);
    const agentOptions = {requestedThinkingLevel:'off' as const,effectiveThinkingLevel:'off' as const,compaction:{contract:'medclaw.compaction/v1' as const,enabled:true,reserveTokens:256,keepRecentTokens:128}};
    const request = {sessionId:1,clientSequence:1,mode:'send' as const,text:'ENGINEERING',expectedRevision:workspace.revision,expectedBatchIds:[],expectedQueryId:null,
      model:{provider:contextModel.provider,modelId:contextModel.modelId,expectedConfigVersion:'1'},referenceDate:'2026-10-05',timezone:'Asia/Shanghai'};
    const run = {sessionId:1,text:request.text,model:contextModel,policy:DEFAULT_REQUEST_POLICY,goal:'answer' as const,workspace,scope,referenceDate:request.referenceDate,timezone:request.timezone,
      timeoutMs:DEFAULT_REQUEST_POLICY.timeoutMs,agentOptions,instanceId:'host',createdAt:memoryAt};
    const accepted = buffered ? repos.acceptInput({operationRef:'send',originalSubmitInput:request,createdAt:memoryAt,
      content:{contract:'medclaw.session-input/v1',originalSubmitInput:request,text:request.text,workspaceContext:workspace,scope,model:contextModel,referenceDate:request.referenceDate,timezone:request.timezone,deliveryAttempt:null},
      execution:{mode:'send',run}}) : repos.registerAgent({...run,inputId:null,submission:{operationRef:'send',originalSubmitInput:request}});
    const stored = db.query<{config_json:string},[number]>('SELECT config_json FROM runs WHERE id=?').get(accepted.runId!)!, config = JSON.parse(stored.config_json);
    expect(config.agent).toMatchObject({...agentOptions,autoCompaction:true,autoRetry:false});
    expect(repos.read({runId:accepted.runId!})).toMatchObject({kind:'one',run:{status:'created'}});
    config.agent.autoCompaction = false; db.query('UPDATE runs SET config_json=? WHERE id=?').run(JSON.stringify(config),accepted.runId!);
    expect(()=>repos.read({runId:accepted.runId!})).toThrow('storage_read_failed');
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

function savedCompactionFixture(source:'manual'|'auto',candidate=false) {
  const root=mkdtempSync(join(tmpdir(),'medclaw-p10-atomic-')),db=openDatabase(join(root,'app.sqlite')),history=sqliteHistory(db),tx=SqliteWriteTransactions.forDatabase(db),repos=new Repositories(db,undefined,undefined,tx,history.store),native=memoryNativeFixture();
  repos.createSession({expectedWorkspaceRevision:0},'create',native.header.id,memoryAt,{header:native.header,entries:[],activeLeafId:null});
  history.commitSync({sessionId:1,runId:null,expectedStorageVersion:1,header:native.header,newEntries:native.entries,activeLeafId:native.activeLeafId});
  const frozen={model:contextModel,baseStorageVersion:2,baseLeafId:native.activeLeafId,settings:{enabled:true,reserveTokens:256,keepRecentTokens:128},budget:{maxModelCalls:4,timeoutMs:5000},instanceId:'host',startedAt:memoryAt};
  let runId:number|null=null;
  if(source==='manual')repos.acceptCompaction({sessionId:1,expectedStorageVersion:2,model:{provider:contextModel.provider,modelId:contextModel.modelId,expectedConfigVersion:'1'}},'compact',frozen);
  else {
    const workspace=toWorkspaceContext(repos.readWorkspace()),scope=repos.freezeAgentScope(workspace,[]);
    runId=repos.registerAgent({sessionId:1,inputId:null,text:'ENGINEERING',model:contextModel,policy:DEFAULT_REQUEST_POLICY,goal:'answer',workspace,scope,referenceDate:'2026-10-05',timezone:'Asia/Shanghai',timeoutMs:DEFAULT_REQUEST_POLICY.timeoutMs,
      agentOptions:{requestedThinkingLevel:'off',effectiveThinkingLevel:'off',compaction:{contract:'medclaw.compaction/v1',...frozen.settings}},historyContract:'medclaw.history/p9-v1',instanceId:'host',createdAt:memoryAt,
      submission:{operationRef:'run',originalSubmitInput:{sessionId:1,clientSequence:1,mode:'send',text:'ENGINEERING',expectedRevision:workspace.revision,expectedBatchIds:[],expectedQueryId:null,model:{provider:contextModel.provider,modelId:contextModel.modelId,expectedConfigVersion:'1'},referenceDate:'2026-10-05',timezone:'Asia/Shanghai'}}}).runId;
  }
  const reason=source==='manual'?'manual' as const:candidate?'threshold' as const:'overflow' as const;
  let answerId:string|null=null;
  if(candidate){repos.startCall(runId!,'main','main',memoryAt);native.manager.appendMessage({role:'user',content:'ENGINEERING',timestamp:3});answerId=native.manager.appendMessage(memoryAssistant('ENGINEERING final answer'));}
  const summaryFacts:FinalCallFact[]=[];
  for(const ordinal of [1,2]) {
    const owner:CompactionCallOwner={operationRef:'compact',sessionId:1,runId,source,reason,model:contextModel,baseStorageVersion:2,baseLeafId:native.activeLeafId,ordinal};
    repos.startCompactionCall({owner,callId:`summary-${ordinal}`,startedAt:memoryAt});
    const callFact:FinalCallFact={callId:`summary-${ordinal}`,state:'completed',responseModel:'fixture',sdkStopReason:'stop',endedAt:memoryAt,durationMs:1,inputTokens:10,outputTokens:2,cost:null,costCurrency:null,usageSource:'provider',unavailableReason:'pricing_unknown',error:null};
    repos.finishCompactionCall(owner,callFact);summaryFacts.push(callFact);
  }
  const nativeEntryId=native.manager.appendCompaction('ENGINEERING preserved summary',native.userId,123,{references:['query:12']});
  const change={sessionId:1,runId,expectedStorageVersion:2,header:native.header,newEntries:native.manager.getEntries().slice(native.entries.length),activeLeafId:nativeEntryId};
  const fact:CompactionReceipt|CompactionSaveFact=source==='auto'?{operationRef:'compact',sessionId:1,runId:runId!,reason:candidate?'threshold':'overflow',nativeEntryId,firstKeptEntryId:native.userId,tokensBefore:123,estimatedTokensAfter:12,baseStorageVersion:2,callIds:['summary-1','summary-2']}:
    {contract:'medclaw.compaction/v1',operationRef:'compact',sessionId:1,runId:null,reason:'manual',status:'completed',nativeGenerated:true,nativeSaved:true,nativeEntryId,firstKeptEntryId:native.userId,tokensBefore:123,estimatedTokensAfter:12,
      baseStorageVersion:2,storageVersion:3,activeLeafId:nativeEntryId,callIds:['summary-1','summary-2'],continuationEligibleAtCommit:true,cancelRequestedAt:null,stoppedAt:memoryAt,finishedAt:memoryAt,noOpReason:null,error:null};
  return {db,root,repos,history,tx,native,change,fact,nativeEntryId,runId,answerId,summaryFacts,close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}

for(const source of ['manual','auto'] as const)test(`p10 ${source} compaction commits original bytes, call links and completion evidence in one idempotent transaction`,()=>{
  const f=savedCompactionFixture(source);
  try {
    const before=['sessions','memories','model_calls','business_events','runtime_events'].map(table=>f.db.query(`SELECT * FROM ${table}`).all());
    f.db.exec("CREATE TEMP TRIGGER reject_compaction BEFORE UPDATE ON model_calls BEGIN SELECT RAISE(ABORT,'ENGINEERING rollback'); END;");
    expect(()=>f.tx.immediate(()=>f.repos.commitCompactionInTransaction(f.change,f.fact))).toThrow();
    expect(['sessions','memories','model_calls','business_events','runtime_events'].map(table=>f.db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    f.db.exec('DROP TRIGGER reject_compaction');
    expect(f.tx.immediate(()=>f.repos.commitCompactionInTransaction(f.change,f.fact))).toBe(3);
    const count=f.db.query('SELECT * FROM runtime_events').all().length;
    expect(f.tx.immediate(()=>f.repos.commitCompactionInTransaction(f.change,f.fact))).toBe(3);expect(f.db.query('SELECT * FROM runtime_events').all()).toHaveLength(count);
    const calls=f.db.query<{model_json:string},[]>('SELECT model_json FROM model_calls ORDER BY id').all();
    expect(calls.map(call=>JSON.parse(call.model_json).compaction)).toMatchObject([{nativeEntryId:f.nativeEntryId,savedStorageVersion:3},{nativeEntryId:f.nativeEntryId,savedStorageVersion:3}]);
    expect(f.db.query<{entry_json:string},[string]>('SELECT entry_json FROM memories WHERE native_entry_id=?').get(f.nativeEntryId)?.entry_json).toBe(canonicalRequest(f.change.newEntries[0]));
    expect(f.db.query('SELECT id FROM answers').all()).toEqual([]);
    if('contract' in f.fact)expect(f.repos.readCompactionOperation({sessionId:1,operationRef:'compact'})?.receipt).toEqual(f.fact);
    else expect(f.db.query("SELECT type FROM runtime_events WHERE type='compaction_completed'").all()).toEqual([{type:'compaction_completed'}]);
    const later={...f.change,expectedStorageVersion:3,newEntries:[],activeLeafId:f.native.userId};f.history.commitSync(later);
    expect(f.tx.immediate(()=>f.repos.commitCompactionInTransaction(f.change,f.fact))).toBe(3);
  } finally {f.close();}
});

test('p10 threshold compaction and the genuine final candidate commit with Answer and Run; a lost result is proven without another history version',()=>{
  const f=savedCompactionFixture('auto',true);
  try {
    const fact:import('../../packages/contracts/src/run').FinalAgentFact={status:'completed',outputText:'ENGINEERING final answer',stoppedAt:memoryAt,endedAt:memoryAt,cancelRequestedAt:null,error:null,
      calls:[{...f.summaryFacts[0]!,callId:'main'},...f.summaryFacts],history:f.change,compactions:[f.fact as CompactionSaveFact],
      cleanup:{contract:'medclaw.run-cleanup/v1',executionStarted:true,stopConfirmed:true,requiredPersistenceComplete:true,inputsSettled:true,resourcesReleased:true,unconfirmedItems:[],secondaryErrors:[],verifiedAt:memoryAt}};
    const prefix=f.db.query('SELECT * FROM memories').all();
    f.db.exec("CREATE TEMP TRIGGER fail_answer BEFORE INSERT ON answers BEGIN SELECT RAISE(ABORT,'ENGINEERING final failure'); END;");
    expect(()=>f.repos.finalizeAgent(f.runId!,fact)).toThrow();expect(f.db.query('SELECT * FROM memories').all()).toEqual(prefix);
    expect(f.db.query("SELECT id FROM runtime_events WHERE type='compaction_completed'").all()).toEqual([]);expect(f.db.query('SELECT id FROM answers').all()).toEqual([]);
    f.db.exec('DROP TRIGGER fail_answer');f.repos.finalizeAgent(f.runId!,fact);
    expect(f.db.query('SELECT text,native_leaf_id FROM answers').get()).toEqual({text:fact.outputText,native_leaf_id:f.nativeEntryId});
    expect(f.db.query("SELECT type FROM runtime_events WHERE type IN ('history_saved','compaction_completed','run_completed') ORDER BY id").all()).toEqual([{type:'history_saved'},{type:'compaction_completed'},{type:'run_completed'}]);
    expect(f.repos.isFinalSaved(f.runId!,fact)).toBe(true);expect(f.repos.finalizeAgent(f.runId!,fact)).toMatchObject({status:'completed'});
    expect(f.repos.readSession(1)?.storageVersion).toBe(3);expect(f.db.query('SELECT id FROM answers').all()).toHaveLength(1);
    const verify=Reflect.get(f.repos,'verifyPriorCompactionFacts');expect(verify).toBeDefined();expect(verify.call(f.repos,f.runId!)).toEqual({requiredPersistenceComplete:true,unconfirmedItems:[]});
    f.db.query("DELETE FROM runtime_events WHERE type='compaction_completed'").run();expect(f.repos.isFinalSaved(f.runId!,fact)).toBe(false);
    expect(verify.call(f.repos,f.runId!)).toMatchObject({requiredPersistenceComplete:false,unconfirmedItems:expect.arrayContaining(['compaction_persistence'])});
  } finally {f.close();}
});

test('p10 unfinished automatic compaction is an independent recovery gap; a proven summary failure preserves completed calls without inventing P8 snapshots',()=>{
  const f=savedCompactionFixture('auto');
  try {
    f.db.query("UPDATE runs SET config_json=json_set(config_json,'$.agent.contextContract','medclaw.context/v1') WHERE id=?").run(f.runId!);
    expect(f.repos.verifyPriorContextFacts(f.runId!)).toEqual({requiredPersistenceComplete:true,unconfirmedItems:[]});
    expect(f.repos.verifyPriorCompactionFacts(f.runId!)).toMatchObject({requiredPersistenceComplete:false,unconfirmedItems:expect.arrayContaining(['compaction_operation_unconfirmed'])});
    f.repos.finishAutoCompaction('compact',f.runId!,{code:'compaction_failed',message:'Engineering failure',category:'runtime',retryable:false,reason:'compaction_model_failed'},memoryAt);
    expect(f.repos.verifyPriorCompactionFacts(f.runId!)).toEqual({requiredPersistenceComplete:true,unconfirmedItems:[]});
    expect(f.db.query('SELECT state,input_tokens FROM model_calls').all()).toEqual([{state:'completed',input_tokens:10},{state:'completed',input_tokens:10}]);
    expect(f.db.query('SELECT id FROM context_snapshots').all()).toEqual([]);
    expect(()=>f.tx.immediate(()=>f.repos.commitCompactionInTransaction(f.change,f.fact))).toThrow('state_conflict');
  } finally {f.close();}
});

test('p10 committed compaction events prove their original native and call owners, deduplicate, and reject terminal late appends',()=>{
  const f=savedCompactionFixture('auto');
  try {
    f.tx.immediate(()=>f.repos.commitCompactionInTransaction(f.change,f.fact));
    const events=new SqliteEventStore(f.db,f.tx),range=events.range(f.runId!),event=events.readWindow({runId:f.runId!,afterSequence:0,throughSequence:range.lastSequence,limit:100}).find(value=>value.type==='compaction_completed')!;
    const {eventId:_id,sequence:_sequence,...draft}=event;
    expect(f.tx.immediate(()=>events.appendInTransaction(draft))).toEqual(event);expect(events.range(f.runId!)).toEqual(range);
    expect(()=>f.tx.immediate(()=>events.appendInTransaction({...draft,sessionId:999}))).toThrow();
    f.db.query("DELETE FROM runtime_events WHERE type='compaction_completed'").run();
    f.db.query("UPDATE runs SET status='failed' WHERE id=?").run(f.runId!);
    f.tx.immediate(()=>events.appendInTransaction({runId:f.runId!,sessionId:1,type:'run_failed',payload:{contract:'medclaw.event/v1',answerId:null,errorCode:'runtime_interrupted',stopConfirmed:true},source:'host',sourceConnection:null,sourceSequence:null,toolCallId:null,occurredAt:memoryAt,receivedAt:memoryAt}));
    expect(()=>f.tx.immediate(()=>events.appendInTransaction(draft))).toThrow('state_conflict');
  }finally{f.close();}
});
