import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../packages/storage/src/database';
const at='2026-10-03T00:00:00.000Z';
function legacy(path:string) {
 const db=new Database(path);
 for(const [i,name] of ['001_p1.sql','002_p2.sql','003_p3.sql','004_p5.sql'].entries()) {
  db.exec('PRAGMA foreign_keys=OFF');const sql=readFileSync(new URL(`../../packages/storage/src/migrations/${name}`,import.meta.url));db.exec(sql.toString());
  db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(i+1,createHash('sha256').update(sql).digest('hex'),at);
 }
 db.exec('PRAGMA foreign_keys=ON');
 db.query("INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at) VALUES(1,'n','c','{}','{}','旧😀',?,?)").run(at,at);
 db.query("INSERT INTO runs(id,session_id,kind,instance_id,status,goal,input_text,config_json,scope_json,workspace_json,submission_operation_ref,submission_client_sequence,submission_request_json,reference_date,timezone,created_at) VALUES(1,1,'agent','old','failed','answer','原文😀',json_object('agent',json_object('nativeSessionId','n'),'unknown',NULL),'{}','{}','legacy',1,json_object('sessionId',1,'clientSequence',1),'2026-10-03','Asia/Shanghai',?)").run(at);
 return db;
}
test('schema4_to_latest_preserves_old_rows_and_checksums_with_only_lifecycle_metadata_added',()=>{
 const root=mkdtempSync(join(tmpdir(),'p6-storage-')),path=join(root,'app.sqlite');let db=legacy(path);
 try {
  // Populate every old domain table, including schema4 inputs, rather than proving empty-table equality.
  db.transaction(()=>db.exec(`
   INSERT INTO model_calls(id,call_id,run_id,session_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,started_at) VALUES(1,'legacy-call',1,1,'main',1,'logical_request',1,'{ "unknown": null }','failed','${at}');
   INSERT INTO imports(id,operation_ref,instance_id,state,preview_request_hash,preview_request_json,artifact_id,created_at,updated_at) VALUES(1,'import','old','imported','hash','{ "raw": "器械😀" }',1,'${at}','${at}');
   INSERT INTO artifacts(id,operation_ref,kind,import_id,format,mime_type) VALUES(1,'artifact','import',1,'csv','text/csv');
   INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at) VALUES(1,1,'scope','2026-10-01','浙江','v','bundle','lock','hash','full','cohort',1,1,'[]','{}',1,NULL,1,'${at}'),(2,1,'scope','2026-10-02','浙江','v','bundle','lock','hash2','full','cohort',1,1,'[]','{}',0,1,2,'${at}');
   INSERT INTO devices(id,source_device_id,source_bundle_id,source_submission_id,source_refs_json,created_at) VALUES(1,'device','bundle','submission','[ "原始引用" ]','${at}');
   INSERT INTO snapshots(id,batch_id,device_id,device_name,region,currency,unit,source_row_ref,source_refs_json,field_origins_json) VALUES(1,1,1,'器械😀','浙江','CNY','台','row','[]','{}'),(2,2,1,'器械😀','浙江','CNY','台','row2','[]','{}');
   INSERT INTO change_events(id,event_key,device_id,old_batch_id,new_batch_id,kind,field,old_value_json,new_value_json,calculation_version,created_at) VALUES(1,'change',1,1,2,'field_changed','price','100','200','v','${at}');
   INSERT INTO tool_calls(id,session_id,run_id,native_tool_call_id,model_call_id,tool_name,tool_version,effect,execution_mode,args_json,status,requested_at) VALUES(1,1,1,'tool',1,'current','v','READ','sequential','{ "batchIds": [1] }','requested','${at}');
   INSERT INTO queries(id,session_id,run_id,call_ref,kind,params_hash,params_json,batch_ids_json,result_json,result_hash,created_at) VALUES(1,1,1,'query','current','params','{ "raw": true }','[1]','{ "raw": "原结果" }','result','${at}');
   INSERT INTO query_evidence(id,query_id,batch_ids_json,snapshot_ids_json,event_ids_json,source_row_refs_json,calculation_version,material_version,source_bundle_id,source_lock_hash,result_hash) VALUES(1,1,'[1]','[1]','[]','[ "row" ]','v','v','bundle','lock','result');
   INSERT INTO answers(id,run_id,session_id,kind,text,query_ids_json,created_at) VALUES(1,1,1,'result','旧答案😀','[1]','${at}');
   INSERT INTO business_events(id,operation_ref,type,actor,session_id,run_id,import_id,query_id,artifact_id,details_json,occurred_at) VALUES(1,'legacy-event','answer_committed','agent',1,1,1,1,1,'{ "raw": null }','${at}');
   INSERT INTO session_inputs(id,session_id,client_sequence,operation_ref,mode,status,processing_status,content_json,target_run_id,run_id,native_entry_id,created_at,processed_at,updated_at) VALUES(1,1,2,'legacy-input','follow_up','consumed','failed','{ "raw": "旧输入😀", "unknown": null }',1,1,'original-entry','${at}','${at}','${at}');
  `)).immediate();
  const names=db.query<{name:string},[]>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all().map(r=>r.name);
  const before=names.map(n=>db.query(`SELECT * FROM ${n} ORDER BY id`).all());expect(names).toHaveLength(17);expect(before.every(rows=>rows.length>0)).toBe(true);const markers=db.query('SELECT * FROM schema_migrations ORDER BY version').all();db.close();db=openDatabase(path);
  expect(db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations'").all()).toHaveLength(22);
  names.forEach((n,i)=>expect(db.query(`SELECT * FROM ${n} ORDER BY id`).all()).toEqual(n==='sessions'
   ? before[i]!.map(row=>({...row as Record<string,unknown>,metadata_json:'{"titleOrigin":"user"}',metadata_revision:0,deleted_at:null,native_header_json:null,current_leaf_id:null,history_format_version:null}))
   : n==='tool_calls'?before[i]!.map(row=>({...row as Record<string,unknown>,context_snapshot_id:null})):n==='batches'?before[i]!.map(row=>({...row as Record<string,unknown>,status:'active',deleted_at:null,deletion_operation_ref:null,cohort_json:'[{"deviceId":1,"sourceDeviceId":"device"}]'})):before[i]));
  expect(db.query('SELECT * FROM schema_migrations ORDER BY version').all().slice(0,4)).toEqual(markers);
  expect(db.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([1,2,3,4,5,6,7,8,9,10].map(version=>({version})));
  expect(db.query('SELECT * FROM runtime_events').all()).toEqual([]);
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);expect(db.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test('failed_migration_leaves_schema4_and_no_event_table',()=>{
 const root=mkdtempSync(join(tmpdir(),'p6-storage-')),path=join(root,'app.sqlite');legacy(path).close();
 try {
  expect(()=>openDatabase(path,phase=>{if(phase==='p6_marker')throw new Error('injected');}).close()).toThrow('storage_migration_failed');
  const db=new Database(path);try{expect(db.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{version:1},{version:2},{version:3},{version:4}]);expect(db.query("SELECT name FROM sqlite_schema WHERE name='runtime_events'").get()).toBeNull();}finally{db.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});



import { SqliteWriteTransactions } from '../../packages/storage/src/write-transactions';
test('nested_commit_never_wakes_before_outer_commit_and_coalesces_run_keys',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE facts(id INTEGER PRIMARY KEY)');const tx=new SqliteWriteTransactions(db);const seen:number[]=[];
 try{tx.immediate(()=>{db.exec('INSERT INTO facts VALUES(1)');tx.immediate(()=>{for(let i=0;i<10000;i++)tx.afterCommit(()=>seen.push(db.query<{n:number},[]>('SELECT count(*) n FROM facts').get()!.n),'event.run:1');});expect(seen).toEqual([]);});expect(seen).toEqual([1]);}finally{db.close();}
});
test('outer_rollback_discards_inner_after_commit',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE facts(id INTEGER PRIMARY KEY)');const tx=new SqliteWriteTransactions(db);const seen:string[]=[];
 try{expect(()=>tx.immediate(()=>{tx.immediate(()=>{db.exec('INSERT INTO facts VALUES(1)');tx.afterCommit(()=>seen.push('commit'));});throw new Error('rollback');})).toThrow('rollback');expect(seen).toEqual([]);expect(db.query('SELECT * FROM facts').all()).toEqual([]);}finally{db.close();}
});
test('rejects_thenable_no_frame_and_unmanaged_outer_transactions',()=>{
 const db=new Database(':memory:');const tx=new SqliteWriteTransactions(db);
 try{expect(()=>tx.afterCommit(()=>{})).toThrow();expect(()=>tx.immediate(()=>Promise.resolve(1))).toThrow();expect(()=>db.transaction(()=>tx.immediate(()=>1)).immediate()).toThrow();}finally{db.close();}
});
import { SqliteEventStore } from '../../packages/storage/src/event-store';
import type { RegisteredEventDraft } from '../../packages/contracts/src/event';
function eventFixture(action:(db:Database,tx:SqliteWriteTransactions,store:SqliteEventStore)=>void){
 const root=mkdtempSync(join(tmpdir(),'p6-events-')),path=join(root,'app.sqlite');legacy(path).close();const db=openDatabase(path),tx=SqliteWriteTransactions.forDatabase(db);
 try{action(db,tx,new SqliteEventStore(db,tx));}finally{db.close();rmSync(root,{recursive:true,force:true});}
}
const draft:RegisteredEventDraft={type:'run_created',payload:{contract:'medclaw.event/v1',sessionId:1,kind:'agent',configVersion:'1'},runId:1,sessionId:1,source:'application',sourceConnection:null,sourceSequence:null,toolCallId:null,occurredAt:at,receivedAt:at};
test('source_replay_deduplicates_without_allocating_sequence',()=>eventFixture((_db,tx,store)=>{
 tx.immediate(()=>{const first=store.appendInTransaction({...draft,sourceConnection:'real-source',sourceSequence:1});expect(first.sequence).toBe(1);expect(store.appendInTransaction({...draft,sourceConnection:'real-source',sourceSequence:1})).toEqual(first);expect(()=>store.appendInTransaction({...draft,sourceConnection:'real-source',sourceSequence:1,type:'run_started'})).toThrow('state_conflict');expect(store.appendInTransaction({...draft,type:'run_started'}).sequence).toBe(2);});expect(store.range(1)).toEqual({firstSequence:1,lastSequence:2});expect(store.readWindow({runId:1,afterSequence:0,throughSequence:2,limit:50}).map(e=>e.sequence)).toEqual([1,2]);
}));
test('event_owner_and_safe_json_are_validated',()=>eventFixture((db,tx,store)=>{
 expect(()=>store.appendInTransaction(draft)).toThrow();tx.immediate(()=>{expect(()=>store.appendInTransaction({...draft,sessionId:2})).toThrow();expect(()=>store.appendInTransaction({...draft,payload:{...draft.payload,secret:'raw'}} as RegisteredEventDraft)).toThrow();expect(()=>store.appendInTransaction({...draft,toolCallId:99})).toThrow();});expect(db.query('SELECT * FROM runtime_events').all()).toEqual([]);
}));
test('stored_corruption_and_numeric_gaps_are_errors',()=>eventFixture((db,tx,store)=>{
 tx.immediate(()=>{store.appendInTransaction(draft);store.appendInTransaction({...draft,type:'run_started'});});db.exec("UPDATE runtime_events SET payload_json='{}' WHERE sequence=1");expect(()=>store.readWindow({runId:1,afterSequence:0,throughSequence:2,limit:50})).toThrow('storage_read_failed');db.exec('DELETE FROM runtime_events WHERE sequence=1');expect(()=>store.readWindow({runId:1,afterSequence:0,throughSequence:2,limit:50})).toThrow();
}));
import { EventService } from '../../packages/core/src/events/event-service';
test('real_event_service_writer_notifies_only_after_commit_and_isolates_double_error',()=>eventFixture((db,tx,store)=>{
 const notifications:number[]=[],diagnostics:string[]=[];
 class ObservedService extends EventService {override notifyCommitted(runId:number){notifications.push(runId);throw new Error('secret raw');}}
 const service=new ObservedService(store,tx,()=>at,()=>{}, {readSnapshots:()=>({streamConnection:null,snapshots:[],incomplete:false})},error=>{diagnostics.push(error.message);throw new Error('diagnostic failed');});
 tx.immediate(()=>{service.appendInTransaction(draft);service.appendInTransaction({...draft,type:'run_started'});expect(notifications).toEqual([]);});expect(notifications).toEqual([1]);expect(diagnostics).toHaveLength(1);expect(diagnostics[0]).not.toContain('secret');expect(db.query('SELECT sequence FROM runtime_events ORDER BY sequence').all()).toEqual([{sequence:1},{sequence:2}]);
 expect(()=>tx.immediate(()=>{service.appendInTransaction({...draft,type:'run_started'});throw new Error('rollback');})).toThrow('rollback');expect(notifications).toEqual([1]);expect(store.range(1).lastSequence).toBe(2);
}));
test('inner_rollback_discards_only_its_callbacks_and_commit_failure_discards_all',()=>eventFixture((db,tx,store)=>{
 const seen:string[]=[];
 tx.immediate(()=>{store.appendInTransaction(draft);tx.afterCommit(()=>seen.push('outer'));expect(()=>tx.immediate(()=>{store.appendInTransaction({...draft,type:'run_started'});tx.afterCommit(()=>seen.push('inner'));throw new Error('inner');})).toThrow('inner');});expect(seen).toEqual(['outer']);expect(store.range(1).lastSequence).toBe(1);
 expect(()=>tx.immediate(()=>{db.query("INSERT INTO runtime_events(run_id,session_id,sequence,type,source,payload_json,occurred_at,received_at) VALUES(999,1,1,'run_started','application','{}',?,?)").run(at,at);tx.afterCommit(()=>seen.push('failed commit'));})).toThrow();expect(seen).toEqual(['outer']);expect(db.query('SELECT run_id FROM runtime_events').all()).toEqual([{run_id:1}]);
}));
test('ten_thousand_input_events_keep_every_sequence_and_one_run_wakeup',()=>eventFixture((db,tx,store)=>{
 const seen:number[]=[];class Observed extends EventService{override notifyCommitted(runId:number){seen.push(runId);}}
 const service=new Observed(store,tx,()=>at,()=>{}, {readSnapshots:()=>({streamConnection:null,snapshots:[],incomplete:false})});
 tx.immediate(()=>{const insert=db.query("INSERT INTO session_inputs(id,session_id,client_sequence,operation_ref,mode,status,content_json,target_run_id,created_at,updated_at) VALUES(?,1,?,?,'follow_up','queued','{}',1,?,?)");for(let i=1;i<=10000;i++){insert.run(i,i,'input-'+i,at,at);service.appendInTransaction({...draft,type:'input_queued',payload:{contract:'medclaw.event/v1',inputId:i,targetRunId:1,runId:null,status:'queued',processingStatus:'pending',errorCode:null}});}expect(seen).toHaveLength(0);});expect(seen).toEqual([1]);expect(store.range(1)).toEqual({firstSequence:1,lastSequence:10000});expect(db.query('SELECT COUNT(*) n FROM runtime_events').get()).toEqual({n:10000});
}));
test('object_ownership_rejects_cross_run_input_and_tool',()=>eventFixture((db,tx,store)=>{
 tx.immediate(()=>{
  db.query("INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at) VALUES(2,'n2','c2','{}','{}','other',?,?)").run(at,at);
  db.query("INSERT INTO runs(id,session_id,kind,instance_id,status,goal,input_text,config_json,scope_json,workspace_json,submission_operation_ref,submission_client_sequence,submission_request_json,reference_date,timezone,created_at) VALUES(2,2,'agent','old','failed','answer','x',json_object('agent',json_object('nativeSessionId','n2')),'{}','{}','legacy2',1,json_object('sessionId',2,'clientSequence',1),'2026-10-03','Asia/Shanghai',?)").run(at);
  db.query("INSERT INTO session_inputs(id,session_id,client_sequence,operation_ref,mode,status,content_json,target_run_id,created_at,updated_at) VALUES(1,2,1,'input','follow_up','queued','{}',2,?,?)").run(at,at);
  expect(()=>store.appendInTransaction({...draft,type:'input_queued',payload:{contract:'medclaw.event/v1',inputId:1,targetRunId:1,runId:null,status:'queued',processingStatus:'pending',errorCode:null}})).toThrow('storage_write_failed');
  db.query("INSERT INTO tool_calls(id,session_id,run_id,native_tool_call_id,tool_name,tool_version,effect,execution_mode,args_json,status,requested_at) VALUES(1,2,2,'native','current','v','READ','sequential','{}','requested',?)").run(at);
  expect(()=>store.appendInTransaction({...draft,type:'tool_requested',toolCallId:1,payload:{contract:'medclaw.event/v1',callId:1,nativeToolCallId:'native',status:'requested',queryIds:[],errorCode:null}})).toThrow('storage_write_failed');
 });expect(db.query('SELECT * FROM runtime_events').all()).toEqual([]);
}));
test('source_redelivery_with_new_receive_time_returns_original_event',()=>eventFixture((_db,tx,store)=>{
 tx.immediate(()=>{const event=store.appendInTransaction({...draft,sourceConnection:'connection',sourceSequence:0});expect(store.appendInTransaction({...draft,sourceConnection:'connection',sourceSequence:0,receivedAt:'2026-10-03T01:00:00.000Z'})).toEqual(event);});expect(store.range(1).lastSequence).toBe(1);
}));
