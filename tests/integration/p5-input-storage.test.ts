import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, SCHEMA_VERSION } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
const at='2026-10-03T00:00:00.000Z';
test('schema3 upgrades all original columns and checksums to schema4 without rewriting legacy facts',()=>{
 const root=mkdtempSync(join(tmpdir(),'p5-storage-')), path=join(root,'app.sqlite');
 let db=new Database(path);
 try {
  for(const [i,name] of ['001_p1.sql','002_p2.sql','003_p3.sql'].entries()) {
   db.exec('PRAGMA foreign_keys=OFF'); const sql=readFileSync(new URL(`../../packages/storage/src/migrations/${name}`,import.meta.url)); db.exec(sql.toString());
   db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(i+1,createHash('sha256').update(sql).digest('hex'),at);
  }
  db.query(`INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at) VALUES(1,'n','create','{}','{}','legacy',?,?)`).run(at,at);
  db.query(`INSERT INTO runs(id,session_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at) VALUES(1,1,'agent','old','legacy',4,'{"sessionId":1,"clientSequence":4}','failed','answer','原文😀','{"agent":{"nativeSessionId":"n"}}','{}','{}','2026-10-03','Asia/Shanghai',?)`).run(at);
  db.exec(`
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
  `);
  const names=db.query<{name:string},[]>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name);
  const before=Object.fromEntries(names.map(n=>[n,db.query(`SELECT * FROM ${n}`).all()])); db.close(); db=openDatabase(path);
  expect(Object.values(before).every(rows=>rows.length>0)).toBe(true);expect(SCHEMA_VERSION).toBe(4); expect(db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).toHaveLength(18);
  for(const n of names) expect(db.query(`SELECT * FROM ${n}`).all().slice(0,before[n]!.length)).toEqual(before[n]);
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]); expect(db.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
  expect(new Repositories(db).readInput({inputId:999})).toBeNull();
  const after=Object.fromEntries(names.map(n=>[n,db.query(`SELECT * FROM ${n}`).all().slice(0,before[n]!.length)]));
  writeFileSync(join(root,'migration-integrity.json'),JSON.stringify({before,after,foreignKeyCheck:db.query('PRAGMA foreign_key_check').all(),integrityCheck:db.query('PRAGMA integrity_check').get(),strictTables:db.query("SELECT name,strict FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),markers:db.query('SELECT version,checksum FROM schema_migrations ORDER BY version').all()},null,2));
  const markers=db.query('SELECT * FROM schema_migrations ORDER BY version').all();db.close();db=openDatabase(path);expect(db.query('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(markers);
 } finally {db.close();rmSync(root,{recursive:true,force:true});}
});
test('schema4 rejects invalid dual-state and missing queued target',()=>{
 const root=mkdtempSync(join(tmpdir(),'p5-storage-')); const db=openDatabase(join(root,'app.sqlite'));
 try {expect(db.query("SELECT name FROM sqlite_schema WHERE name='session_inputs'").get()).not.toBeNull();}
 finally {db.close();rmSync(root,{recursive:true,force:true});}
});

import { DEFAULT_REQUEST_POLICY } from '../../packages/contracts/src/model';
import { safeError } from '../../packages/contracts/src/error';
const model={provider:'p',modelId:'m',api:'openai-completions',endpointRef:null,credentialRef:null,configVersion:'1',maxOutputTokens:100,capabilitySource:'user_declared' as const,sdkVersion:'0.87.1' as const};
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'p5-storage-'));const db=openDatabase(join(root,'app.sqlite'));const repos=new Repositories(db);
 const s=repos.createSession({expectedWorkspaceRevision:0},'create','n',at); const workspace=s.workspace;
 const scope={batchIds:[],deviceIds:null,allowedToolNames:[],allowedResourceRefs:[],artifactIds:[],readOnly:true};
 const request={sessionId:s.session.id,clientSequence:1,text:'same',mode:'send' as const,expectedRevision:workspace.revision,expectedBatchIds:[],expectedQueryId:null,model:{provider:'p',modelId:'m',expectedConfigVersion:'1'},referenceDate:'2026-10-03',timezone:'Asia/Shanghai'};
 const content={contract:'medclaw.session-input/v1' as const,originalSubmitInput:request,text:request.text,workspaceContext:workspace,scope,model,referenceDate:request.referenceDate,timezone:request.timezone,deliveryAttempt:null};
 const run={sessionId:s.session.id,goal:'answer' as const,text:request.text,model,policy:DEFAULT_REQUEST_POLICY,workspace,scope,referenceDate:request.referenceDate,timezone:request.timezone,timeoutMs:DEFAULT_REQUEST_POLICY.timeoutMs,agentOptions:{requestedThinkingLevel:'off' as const,effectiveThinkingLevel:'off' as const},instanceId:'host',createdAt:at};
 const plan={operationRef:'send',originalSubmitInput:request,content,createdAt:at,execution:{mode:'send' as const,run}};
 return {db,repos,plan,dispose(){db.close();rmSync(root,{recursive:true,force:true});}};
}
test('dual input keys distinguish two queued null Run facts and preserve original acceptance',()=>{
 const f=fixture();try{
 const accepted=f.repos.acceptInput(f.plan);expect(accepted.inputId).not.toBeNull();expect(f.repos.acceptInput(f.plan)).toEqual(accepted);
 const queue=(seq:number,op:string)=>{const request={...f.plan.originalSubmitInput,mode:'steer' as const,targetRunId:accepted.runId!,clientSequence:seq};return {...f.plan,operationRef:op,originalSubmitInput:request,content:{...f.plan.content,originalSubmitInput:request},execution:{mode:'steer' as const,targetRunId:accepted.runId!}};};
 const a=f.repos.acceptInput(queue(2,'a')); const b=f.repos.acceptInput(queue(3,'b'));expect(a.runId).toBeNull();expect(b.runId).toBeNull();
 expect(()=>f.repos.acceptInput(queue(3,'a'))).toThrow('state_conflict');expect(f.repos.readSession(1)?.nextSubmissionSequence).toBe(4);
 expect(f.repos.inputsForRun(accepted.runId!)).toHaveLength(3);
 }finally{f.dispose();}
});
test('consumption may precede delivery acknowledgement; repeated facts preserve terminal processing',()=>{
 const f=fixture();try{const r=f.repos.acceptInput(f.plan), input=r.inputId!,run=r.runId!;
 f.repos.beginInputDelivery(input,'host',at);f.repos.recordInputConsumption(input,{sessionId:1,runId:run,nativeEntryId:'entry',at});f.repos.recordInputDelivery(input,at);
 const proof={runId:run,admissionClosed:true,preflightSettled:true,nativeIdle:true,nativeQueuesEmpty:true,pendingPersistence:false,removals:[],unconfirmedInputIds:[]};
 f.repos.settleRunInputs(run,'failed',at,proof);f.repos.recordInputConsumption(input,{sessionId:1,runId:run,nativeEntryId:'entry',at});
 expect(f.repos.readInput({inputId:input})).toMatchObject({status:'consumed',processingStatus:'failed',processedAt:at,deliveredAt:at});
 expect(()=>f.repos.recordInputFailure(input,{sessionId:1,targetRunId:run,at,error:safeError('input_hook_handled'),proof:{kind:'not_consumed',reason:'hook_handled'}})).toThrow('state_conflict');
 }finally{f.dispose();}
});
test('root input is used for Run and model call; proof-only message links expose only consumed entries',()=>{
 const f=fixture();try{const r=f.repos.acceptInput(f.plan);f.repos.startCall(r.runId!,'call','main',at);
 expect(f.db.query('SELECT input_id FROM runs WHERE id=?').get(r.runId!)).toEqual({input_id:r.inputId});expect(f.db.query('SELECT input_id FROM model_calls').get()).toEqual({input_id:r.inputId});
 f.repos.beginInputDelivery(r.inputId!,'host',at);f.repos.recordInputConsumption(r.inputId!,{sessionId:1,runId:r.runId!,nativeEntryId:'entry',at});
 expect(f.repos.readMessageInputLinks(1,['entry','other'])).toEqual(new Map([['entry',{inputId:r.inputId!,runId:r.runId!}]]));expect(f.repos.read({runId:r.runId!})).toMatchObject({run:{inputId:r.inputId,operationRef:'send',clientSequence:1}});
 }finally{f.dispose();}
});
test('restart applies pending classification and preserves already terminal processing time',()=>{
 const f=fixture();try{const root=f.repos.acceptInput(f.plan),run=root.runId!;
 const queue=(seq:number)=>{const request={...f.plan.originalSubmitInput,clientSequence:seq,mode:'follow_up' as const,targetRunId:run};return f.repos.acceptInput({...f.plan,operationRef:`q${seq}`,originalSubmitInput:request,content:{...f.plan.content,originalSubmitInput:request},execution:{mode:'follow_up',targetRunId:run}}).inputId!;};
 const consumed=queue(2),unknown=queue(3),handled=queue(4);
 f.repos.beginInputDelivery(consumed,'host',at);f.repos.recordInputConsumption(consumed,{sessionId:1,runId:run,nativeEntryId:'c',at});f.repos.beginInputDelivery(unknown,'host',at);
 f.repos.recordInputFailure(handled,{sessionId:1,targetRunId:run,at,error:safeError('input_hook_handled'),proof:{kind:'not_consumed',reason:'hook_handled'}});
 const later='2026-10-03T01:00:00.000Z';expect(f.repos.verifyPriorInputFacts(run,false,later).inputsSettled).toBe(false);
 expect(f.repos.verifyPriorInputFacts(run,true,later)).toEqual({inputsSettled:true,requiredPersistenceComplete:true,unconfirmedItems:[]});
 expect(f.repos.readInput({inputId:root.inputId!})).toMatchObject({status:'cancelled',processingStatus:'cancelled'});
 expect(f.repos.readInput({inputId:consumed})).toMatchObject({status:'consumed',processingStatus:'failed',nativeEntryId:'c'});
 expect(f.repos.readInput({inputId:unknown})).toMatchObject({status:'delivery_unknown',processingStatus:'failed'});
 expect(f.repos.readInput({inputId:handled})).toMatchObject({status:'failed',processingStatus:'failed',processedAt:at});
 f.repos.recordInputConsumption(unknown,{sessionId:1,runId:run,nativeEntryId:'late',at:later});expect(f.repos.readInput({inputId:unknown})).toMatchObject({status:'consumed',processingStatus:'failed',processedAt:later});
 }finally{f.dispose();}
});
test('safe input pages retain canonical text, reject foreign cursor and distinguish corrupt JSON',()=>{
 const f=fixture();try{const text='😀'.repeat(5000),plan={...f.plan,originalSubmitInput:{...f.plan.originalSubmitInput,text},content:{...f.plan.content,text,originalSubmitInput:{...f.plan.originalSubmitInput,text}},execution:{...f.plan.execution,run:{...f.plan.execution.run,text}}};const r=f.repos.acceptInput(plan);
 expect(f.repos.readInput({inputId:r.inputId!})?.text.length).toBe(8192);expect(f.repos.readInput({inputId:r.inputId!})?.textInfo).toEqual({totalChars:10000,truncated:true});
 expect(JSON.parse((f.db.query<{content_json:string},[number]>('SELECT content_json FROM session_inputs WHERE id=?').get(r.inputId!))!.content_json).text).toBe(text);
 expect(()=>f.repos.listInputs({sessionId:2,afterClientSequence:1})).toThrow();expect(f.repos.listInputs({sessionId:1})).toMatchObject({hasMore:false,nextClientSequence:null});
 f.db.exec('DROP TRIGGER session_inputs_identity_immutable');f.db.query("UPDATE session_inputs SET content_json='{}' WHERE id=?").run(r.inputId!);expect(()=>f.repos.readInput({inputId:r.inputId!})).toThrow('storage_read_failed');
 }finally{f.dispose();}
});
import { initializeToolStorage, SqliteToolStore } from '../../packages/storage/src/tool-store';
test('formal query context accepts only trusted root input and rejects a forged identity',()=>{
 const f=fixture();try{const r=f.repos.acceptInput(f.plan);f.repos.startCall(r.runId!,'call','main',at);
 const context={sessionId:1,runId:r.runId!,inputId:r.inputId!,source:'user_form' as const,callRef:'query',scope:f.plan.content.scope,referenceDate:f.plan.content.referenceDate,timezone:f.plan.content.timezone,signal:new AbortController().signal};
 expect(()=>new SqliteToolStore(f.db).assertContext(context)).not.toThrow();
 expect(()=>new SqliteToolStore(f.db).assertContext({...context,inputId:999})).toThrow();
 }finally{f.dispose();}
});
test('schema4 copy, rename and marker faults roll back to reopenable schema3 with no temporary table',()=>{
 for(const phase of ['p5_copy','p5_rename','p5_marker']){
 const root=mkdtempSync(join(tmpdir(),'p5-fault-')),path=join(root,'app.sqlite');let db=new Database(path);
 try{
  for(const [i,name] of ['001_p1.sql','002_p2.sql','003_p3.sql'].entries()){db.exec('PRAGMA foreign_keys=OFF');const sql=readFileSync(new URL(`../../packages/storage/src/migrations/${name}`,import.meta.url));db.exec(sql.toString());db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(i+1,createHash('sha256').update(sql).digest('hex'),at);}
  const schema=db.query('SELECT name,sql FROM sqlite_schema ORDER BY name').all();db.close();
  let failed=false;try{openDatabase(path,(point?:string)=>{if(point===phase)throw new Error(phase);}).close();}catch(error){failed=(error as Error).message==='storage_migration_failed';}expect(failed).toBe(true);
  db=new Database(path);expect(db.query('SELECT name,sql FROM sqlite_schema ORDER BY name').all()).toEqual(schema);expect(db.query('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({n:3});db.close();
  db=openDatabase(path);expect(db.query('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({n:4});
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
 }
});
test('fixed targets, immutable canonical identity, dual states and cross Session input FKs are enforced',()=>{
 const f=fixture();try{const r=f.repos.acceptInput(f.plan),input=r.inputId!,run=r.runId!;
 for(const sql of ["UPDATE session_inputs SET status='failed'", "UPDATE session_inputs SET processing_status='completed'", "UPDATE session_inputs SET operation_ref='other'", "UPDATE session_inputs SET target_run_id=NULL", "DELETE FROM session_inputs"]){expect(()=>f.db.exec(sql)).toThrow();}
 f.repos.beginInputDelivery(input,'host',at);expect(()=>f.repos.beginInputDelivery(input,'other',at)).toThrow('state_conflict');
 f.db.query('UPDATE runs SET status=\'failed\' WHERE id=?').run(run);
 const secondRequest={...f.plan.originalSubmitInput,clientSequence:2};const second=f.repos.acceptInput({...f.plan,operationRef:'second',originalSubmitInput:secondRequest,content:{...f.plan.content,originalSubmitInput:secondRequest}});
 expect(()=>f.db.query('UPDATE session_inputs SET target_run_id=? WHERE id=?').run(second.runId!,input)).toThrow();
 f.repos.createSession({expectedWorkspaceRevision:1},'create-b','b',at);
 expect(()=>f.db.query(`INSERT INTO model_calls(call_id,run_id,session_id,input_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,started_at) VALUES('bad',?,2,?,'main',1,'logical_request',1,'{}','started',?)`).run(run,input,at)).toThrow();
 expect(()=>f.db.query(`INSERT INTO queries(session_id,run_id,input_id,call_ref,kind,params_hash,params_json,batch_ids_json,result_json,result_hash,created_at) VALUES(2,?,?,'bad','current','h','{}','[]','{}','h',?)`).run(run,input,at)).toThrow();
 expect(()=>f.db.query(`INSERT INTO answers(run_id,session_id,input_id,kind,text,query_ids_json,created_at) VALUES(?,2,?,'result','bad','[]',?)`).run(run,input,at)).toThrow();
 expect(()=>f.db.query(`INSERT INTO runs(kind,input_id,instance_id,status,goal,input_text,config_json,scope_json,reference_date,timezone,created_at) VALUES('provider',?,'h','failed','answer','x','{"providerRequest":{"operationRef":"bad"}}','{}','2026-10-03','Asia/Shanghai',?)`).run(input,at)).toThrow();
 f.repos.recordInputConsumption(input,{sessionId:1,runId:run,nativeEntryId:'entry',at});
 expect(f.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
 }finally{f.dispose();}
});
test('finalization persists consumed processing, root Answer, Run and cleanup in one rollbackable transaction',()=>{
 const f=fixture();try{const scope={...f.plan.content.scope,allowedToolNames:['ls']};const p={...f.plan,content:{...f.plan.content,scope},execution:{mode:'send' as const,run:{...f.plan.execution.run,scope}}};const r=f.repos.acceptInput(p),run=r.runId!,input=r.inputId!;
 f.repos.beginInputDelivery(input,'host',at);f.repos.recordInputConsumption(input,{sessionId:1,runId:run,nativeEntryId:'entry',at});f.repos.startCall(run,'answer-call','main',at);
 const view=f.repos.read({runId:run});if(view.kind!=='one'||!view.run)throw new Error('missing');const calls=view.run.calls.map(c=>({...c,state:'completed' as const,endedAt:at,durationMs:0,sdkStopReason:'stop' as const}));
 const proof={runId:run,admissionClosed:true,preflightSettled:true,nativeIdle:true,nativeQueuesEmpty:true,pendingPersistence:false,removals:[],unconfirmedInputIds:[]};
 const cleanup={contract:'medclaw.run-cleanup/v1' as const,executionStarted:true,stopConfirmed:true,requiredPersistenceComplete:true,inputsSettled:true,resourcesReleased:true,unconfirmedItems:[],secondaryErrors:[],verifiedAt:at};const fact={status:'completed' as const,outputText:'answer',endedAt:at,stoppedAt:at,error:null,calls,cleanup,inputSettlement:proof};
 expect(()=>f.repos.finalizeAgent(run,{...fact,inputSettlement:{...proof,nativeIdle:false}})).toThrow('state_conflict');expect(f.repos.readInput({inputId:input})?.processingStatus).toBe('pending');expect(f.db.query('SELECT * FROM answers').all()).toEqual([]);
 const failing=new Repositories(f.db,()=>{throw new Error('commit fault');});expect(()=>failing.finalizeAgent(run,fact)).toThrow('commit fault');expect(f.repos.readInput({inputId:input})?.processingStatus).toBe('pending');
 const saved=f.repos.finalizeAgent(run,fact);expect(saved.cleanup?.inputsSettled).toBe(true);expect(f.repos.readInput({inputId:input})?.processingStatus).toBe('completed');expect(f.db.query('SELECT input_id,run_id FROM answers').all()).toEqual([{input_id:input,run_id:run}]);expect(f.repos.finalizeAgent(run,fact)).toEqual(saved);expect(f.db.query('SELECT * FROM answers').all()).toHaveLength(1);expect(f.repos.isFinalSaved(run,fact)).toBe(true);
 }finally{f.dispose();}
});
test('safe failed closure preserves unknown history but settles processing; source gaps still block',()=>{
 const f=fixture();try{const r=f.repos.acceptInput(f.plan),input=r.inputId!,run=r.runId!;f.repos.beginInputDelivery(input,'host',at);f.repos.recordInputFailure(input,{sessionId:1,targetRunId:run,at,error:safeError('input_delivery_unknown'),proof:{kind:'delivery_unknown',reason:'append_failed'}});
 const proof={runId:run,admissionClosed:true,preflightSettled:true,nativeIdle:true,nativeQueuesEmpty:true,pendingPersistence:false,removals:[],unconfirmedInputIds:[input]};
 expect(()=>f.repos.settleRunInputs(run,'failed',at,{...proof,pendingPersistence:true})).toThrow('state_conflict');expect(()=>f.repos.settleRunInputs(run,'completed',at,proof)).toThrow('state_conflict');
 expect(()=>f.repos.settleRunInputs(run,'failed',at,proof)).not.toThrow();expect(f.repos.readInput({inputId:input})).toMatchObject({status:'delivery_unknown',processingStatus:'failed',processedAt:at,runId:null,nativeEntryId:null});
 }finally{f.dispose();}
});
test('closed undelivered input requires no fabricated removal and settles as never dispatched',()=>{
 const f=fixture();try{const r=f.repos.acceptInput(f.plan),input=r.inputId!,run=r.runId!;const proof={runId:run,admissionClosed:true,preflightSettled:true,nativeIdle:true,nativeQueuesEmpty:true,pendingPersistence:false,removals:[],unconfirmedInputIds:[]};
 expect(()=>f.repos.settleRunInputs(run,'cancelled',at,{...proof,preflightSettled:false})).toThrow('state_conflict');expect(()=>f.repos.settleRunInputs(run,'cancelled',at,proof)).not.toThrow();expect(f.repos.readInput({inputId:input})).toMatchObject({status:'cancelled',processingStatus:'cancelled',processedAt:at});
 }finally{f.dispose();}
});
import { CurrentQuerySchema } from '../../packages/contracts/src/query';
test('formal Query SQL and read projection persist the original root Input',()=>{
 const f=fixture();try{
 f.db.exec(`INSERT INTO imports(id,operation_ref,instance_id,state,preview_request_hash,preview_request_json,created_at,updated_at) VALUES(1,'imp','h','imported','h','{}','${at}','${at}');
 INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,catalog_revision,created_at) VALUES(1,1,'s','2026-10-03','浙江','v','b','l','h','full','c',0,0,'[]','{"referenceDate":"2026-10-03","timezone":"Asia/Shanghai"}',1,1,'${at}');`);
 const workspace=f.repos.updateWorkspace({batchIds:[1]},1,at),scope={...f.plan.content.scope,batchIds:[1],allowedToolNames:['query_current_devices']};
 const request={...f.plan.originalSubmitInput,expectedRevision:workspace.revision,expectedBatchIds:[1]};const plan={...f.plan,originalSubmitInput:request,content:{...f.plan.content,originalSubmitInput:request,scope,workspaceContext:workspace},execution:{mode:'send' as const,run:{...f.plan.execution.run,workspace,scope}}};const badRequest={...request,timezone:'UTC'};
 const badPlan={...plan,operationRef:'wrong-timezone',originalSubmitInput:badRequest,content:{...plan.content,timezone:'UTC',originalSubmitInput:badRequest},execution:{mode:'send' as const,run:{...plan.execution.run,timezone:'UTC'}}};
 expect(()=>f.repos.acceptInput(badPlan)).toThrow('invalid_argument');expect(f.db.query('SELECT * FROM session_inputs').all()).toEqual([]);
 const r=f.repos.acceptInput(plan);f.repos.startCall(r.runId!,'query-call','main',at);
 const context={sessionId:1,runId:r.runId!,inputId:r.inputId!,source:'user_form' as const,callRef:'q',scope,referenceDate:request.referenceDate,timezone:request.timezone,signal:new AbortController().signal};
 const query={sessionId:1,runId:r.runId!,inputId:r.inputId!,callRef:'q',source:'user_form' as const,kind:'current' as const,params:CurrentQuerySchema.parse({batchIds:[1]}),batchIds:[1],scopeDeviceIds:null,rows:[],snapshotIds:[],eventIds:[],warnings:[],calculationVersion:'query/v1',resultHash:'h',createdAt:at};
 const saved=new SqliteToolStore(f.db).commitQuery(query,[],context);expect(saved.inputId).toBe(r.inputId);expect(f.db.query('SELECT input_id FROM queries').get()).toEqual({input_id:r.inputId});
 }finally{f.dispose();}
});
test('old Run and new Input identities share monotone sequence space and replay original legacy acceptance',()=>{
 const f=fixture();try{const old=f.repos.registerAgent({...f.plan.execution.run,inputId:null,submission:{operationRef:'legacy',originalSubmitInput:f.plan.originalSubmitInput}});f.db.query("UPDATE runs SET status='failed' WHERE id=?").run(old.runId);
 expect(f.repos.acceptInput({...f.plan,operationRef:'legacy'})).toEqual(old);expect(()=>f.repos.acceptInput(f.plan)).toThrow('state_conflict');expect(()=>f.repos.acceptInput({...f.plan,operationRef:'create'})).toThrow('state_conflict');
 const request={...f.plan.originalSubmitInput,clientSequence:5};const accepted=f.repos.acceptInput({...f.plan,originalSubmitInput:request,content:{...f.plan.content,originalSubmitInput:request}});expect(f.repos.readSession(1)?.nextSubmissionSequence).toBe(6);
 const queued={...request,clientSequence:3,mode:'steer' as const,targetRunId:accepted.runId!};expect(()=>f.repos.acceptInput({...f.plan,operationRef:'q',originalSubmitInput:queued,content:{...f.plan.content,originalSubmitInput:queued},execution:{mode:'steer',targetRunId:accepted.runId!}})).toThrow('state_conflict');expect(f.db.query('SELECT * FROM session_inputs').all()).toHaveLength(1);
 }finally{f.dispose();}
});
test('entry identity cannot be borrowed by a second input and cancellation rejects opposite late evidence',()=>{
 const f=fixture();try{const r=f.repos.acceptInput(f.plan),run=r.runId!,root=r.inputId!;const request={...f.plan.originalSubmitInput,mode:'steer' as const,targetRunId:run,clientSequence:2};const queued=f.repos.acceptInput({...f.plan,operationRef:'q',originalSubmitInput:request,content:{...f.plan.content,originalSubmitInput:request},execution:{mode:'steer',targetRunId:run}}).inputId!;
 for(const input of [root,queued])f.repos.beginInputDelivery(input,'host',at);f.repos.recordInputConsumption(root,{sessionId:1,runId:run,nativeEntryId:'entry',at});expect(()=>f.repos.recordInputConsumption(queued,{sessionId:1,runId:run,nativeEntryId:'entry',at})).toThrow('native_state_invalid');
 f.repos.recordInputCancellation({kind:'removed',inputId:queued,runId:run,at},at);expect(()=>f.repos.recordInputConsumption(queued,{sessionId:1,runId:run,nativeEntryId:'late',at})).toThrow('native_state_invalid');expect(f.repos.readInput({inputId:queued})).toMatchObject({status:'cancelled',processingStatus:'cancelled',nativeEntryId:null});
 }finally{f.dispose();}
});
test('acceptance transaction fault commits neither Input nor Run',()=>{
 const f=fixture();try{const fail=new Repositories(f.db,()=>{throw new Error('acceptance fault');});expect(()=>fail.acceptInput(f.plan)).toThrow('acceptance fault');expect(f.db.query('SELECT * FROM session_inputs').all()).toEqual([]);expect(f.db.query('SELECT * FROM runs').all()).toEqual([]);expect(f.repos.acceptInput(f.plan).inputId).toBe(1);}finally{f.dispose();}
});
test('original acceptance lookup precedes later frozen materials and never begins another delivery',()=>{
 const f=fixture();try{const r=f.repos.acceptInput(f.plan);f.repos.beginInputDelivery(r.inputId!,'host',at);const replay={...f.plan,content:{...f.plan.content,text:'new frozen text',deliveryAttempt:{instanceId:'other',startedAt:at}}};expect(f.repos.acceptInput(replay)).toEqual(r);expect(f.db.query('SELECT COUNT(*) AS n FROM session_inputs').get()).toEqual({n:1});expect(f.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({n:1});}finally{f.dispose();}
});

test('isolated legacy tool schema rejects nonnull input rather than dropping its identity',()=>{
 const db=new Database(':memory:');try{db.exec("PRAGMA foreign_keys=ON; CREATE TABLE sessions(id INTEGER PRIMARY KEY) STRICT; CREATE TABLE runs(id INTEGER PRIMARY KEY,session_id INTEGER NOT NULL REFERENCES sessions(id),status TEXT NOT NULL,scope_json TEXT NOT NULL,reference_date TEXT NOT NULL,timezone TEXT NOT NULL,UNIQUE(id,session_id)) STRICT;INSERT INTO sessions VALUES(1);");
 const scope={batchIds:[],deviceIds:null,allowedToolNames:[],allowedResourceRefs:[],artifactIds:[],readOnly:true};db.query("INSERT INTO runs VALUES(1,1,'running',?,'2026-10-03','Asia/Shanghai')").run(JSON.stringify(scope));initializeToolStorage(db);const store=new SqliteToolStore(db),context={sessionId:1,runId:1,inputId:null,source:'user_form' as const,callRef:'q',scope,referenceDate:'2026-10-03',timezone:'Asia/Shanghai',signal:new AbortController().signal};
 expect(()=>store.assertContext(context)).not.toThrow();expect(()=>store.assertContext({...context,inputId:1})).toThrow('access_denied');expect(db.query('SELECT * FROM queries').all()).toEqual([]);
 }finally{db.close();}
});
import { canonicalRequest } from '../../packages/contracts/src/run';
function rootWithManyInputs(f: ReturnType<typeof fixture>, count = 10001) {
  const root = f.repos.acceptInput(f.plan);
  if (root.runId === null || root.inputId === null) throw new Error('Expected root acceptance');
  const runId = root.runId;
  const queuePlan = (seq: number) => {
    const request = { ...f.plan.originalSubmitInput, clientSequence: seq, mode: 'steer' as const, targetRunId: runId };
    return { ...f.plan, operationRef: `large-${seq}`, originalSubmitInput: request,
      content: { ...f.plan.content, originalSubmitInput: request }, execution: { mode: 'steer' as const, targetRunId: runId } };
  };
  const insert = f.db.query("INSERT INTO session_inputs(session_id,client_sequence,operation_ref,mode,status,content_json,target_run_id,created_at,updated_at) VALUES(?,?,?,'steer','queued',?,?,?,?)");
  f.db.transaction(() => {
    for (let seq = 2; seq < count; seq++) {
      const plan = queuePlan(seq);
      insert.run(plan.originalSubmitInput.sessionId, seq, plan.operationRef, canonicalRequest(plan.content), root.runId, at, at);
    }
  }).immediate();
  const boundary = f.repos.acceptInput(queuePlan(count));
  if (boundary.inputId === null) throw new Error('Expected queued Input');
  expect(boundary.runId).toBeNull();
  expect(f.db.query('SELECT COUNT(*) AS n FROM session_inputs').get()).toEqual({ n: count });
  return { runId: root.runId, inputId: root.inputId, boundaryId: boundary.inputId };
}
test('more than 10000 accepted inputs finalize without dropping the boundary Input or blocking cleanup', () => {
  const f = fixture();
  try {
    const root = rootWithManyInputs(f);
    f.repos.beginInputDelivery(root.inputId, 'host', at);
    f.repos.recordInputConsumption(root.inputId, { sessionId: 1, runId: root.runId, nativeEntryId: 'large-root', at });
    const proof = { runId: root.runId, admissionClosed: true, preflightSettled: true, nativeIdle: true,
      nativeQueuesEmpty: true, pendingPersistence: false, removals: [], unconfirmedInputIds: [] };
    const fact = { status: 'failed' as const, outputText: null, stoppedAt: null, endedAt: at, error: safeError('runtime_interrupted'), calls: [],
      cleanup: { contract: 'medclaw.run-cleanup/v1' as const, executionStarted: false, stopConfirmed: true,
        requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: true, unconfirmedItems: [], secondaryErrors: [], verifiedAt: at }, inputSettlement: proof };
    expect(() => f.repos.finalizeAgent(root.runId, fact)).not.toThrow();
    expect(f.db.query("SELECT COUNT(*) AS n FROM session_inputs WHERE processing_status<>'pending'").get()).toEqual({ n: 10001 });
    expect(f.repos.readInput({ inputId: root.boundaryId })).toMatchObject({ status: 'cancelled', processingStatus: 'cancelled', processedAt: at });
    expect(f.repos.isFinalSaved(root.runId, fact)).toBe(true);
    expect(f.repos.recoveryCandidates('next-host')).toEqual([]);
    expect(f.repos.inputsForRun(root.runId)).toHaveLength(10001);
  } finally { f.dispose(); }
}, 15000);
test('recovery classifies every accepted input beyond 10000 and preserves all processed facts', () => {
  const f = fixture();
  try {
    const root = rootWithManyInputs(f);
    const attempted = f.repos.readInput({ sessionId: 1, clientSequence: 10000 });
    if (!attempted) throw new Error('Expected tail input');
    f.repos.beginInputDelivery(attempted.id, 'host', at);
    f.repos.beginInputDelivery(root.boundaryId, 'host', at);
    f.repos.recordInputConsumption(root.boundaryId, { sessionId: 1, runId: root.runId, nativeEntryId: 'large-tail', at });
    const later = '2026-10-03T02:00:00.000Z';
    expect(f.repos.verifyPriorInputFacts(root.runId, true, later)).toEqual({ inputsSettled: true, requiredPersistenceComplete: true, unconfirmedItems: [] });
    expect(f.db.query("SELECT COUNT(*) AS n FROM session_inputs WHERE processing_status<>'pending'").get()).toEqual({ n: 10001 });
    expect(f.repos.readInput({ inputId: attempted.id })).toMatchObject({ status: 'delivery_unknown', processingStatus: 'failed', processedAt: later });
    expect(f.repos.readInput({ inputId: root.boundaryId })).toMatchObject({ status: 'consumed', processingStatus: 'failed', processedAt: later, nativeEntryId: 'large-tail' });
    expect(f.repos.recoverInterrupted('next-host', later)).toBe(1);
    expect(f.repos.recoveryCandidates('next-host')).toEqual([]);
    expect(f.repos.readInput({ inputId: root.boundaryId })?.processedAt).toBe(later);
    expect(f.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { f.dispose(); }
}, 15000);
