import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase, SCHEMA_VERSION } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
const at='2026-10-04T00:00:00.000Z', later='2026-10-04T00:01:00.000Z';
const migrations=['001_p1.sql','002_p2.sql','003_p3.sql','004_p5.sql','005_p6.sql'];
function fixture(){const root=mkdtempSync(join(tmpdir(),'session-lifecycle-')),path=join(root,'app.sqlite'),db=openDatabase(path),repos=new Repositories(db);return {root,path,db,repos,dispose(){db.close();rmSync(root,{recursive:true,force:true});}};}
function create(f:ReturnType<typeof fixture>,op='create'){return f.repos.createSession({expectedWorkspaceRevision:f.repos.readWorkspace().revision},op,`native-${op}`,at);}
test('schema6 migration preserves original identity and JSON, initializes only proved default title origins',()=>{
 const root=mkdtempSync(join(tmpdir(),'lifecycle-migration-')),path=join(root,'app.sqlite');let db=new Database(path);
 try{
  db.exec('PRAGMA foreign_keys=OFF');for(const [i,name] of migrations.entries()){db.exec("PRAGMA foreign_keys=OFF");const sql=readFileSync(new URL(`../../packages/storage/src/migrations/${name}`,import.meta.url));db.exec(sql.toString());db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(i+1,createHash('sha256').update(sql).digest('hex'),at);}
  const insert=db.query('INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)');
  insert.run(1,'native-1','old-1','{ "expectedWorkspaceRevision": 0 }',JSON.stringify({session:{id:1,title:'新会话 1',nativeSessionId:'native-1',kind:'user',status:'active',storageVersion:0,leafId:null,nextSubmissionSequence:1},workspace:{revision:1,sessionId:1,materialVersion:null,batchRefs:[],deviceIds:[],queryId:null,activeView:'data',selection:null}}),'新会话 1','{ "other": "字节😀" }',at,at);
  insert.run(2,'native-2','old-2','{}','{"session":{"id":2,"title":"original"}}','新会话 2','{"other":42}',at,at);
  const old=db.query<Record<string,unknown>,[]>('SELECT * FROM sessions ORDER BY id').all(),markers=db.query('SELECT * FROM schema_migrations').all();db.close();db=openDatabase(path);
  expect(SCHEMA_VERSION).toBe(11);const rows=db.query<Record<string,unknown>,[]>('SELECT * FROM sessions ORDER BY id').all();
  for(const [i,row] of rows.entries()){for(const [key,value] of Object.entries(old[i]!))if(key!=='metadata_json')expect(row[key]).toEqual(value);expect(row.metadata_revision).toBe(0);expect(row.deleted_at).toBeNull();}
  expect(JSON.parse(String(rows[0]!.metadata_json))).toEqual({other:'字节😀',titleOrigin:'default'});expect(JSON.parse(String(rows[1]!.metadata_json))).toEqual({other:42,titleOrigin:'user'});
  expect(db.query('SELECT * FROM schema_migrations WHERE version<=5').all()).toEqual(markers);expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);expect(db.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
  expect(db.query("SELECT name FROM sqlite_schema WHERE name='sessions_user_status_id'").get()).not.toBeNull();
  const repos=new Repositories(db);expect(repos.readSession(1)?.title).toBe('New Session 1');expect(repos.readSession(2)?.title).toBe('新会话 2');expect(repos.findOperation('old-1')).toMatchObject({result:{session:{title:'新会话 1',metadataRevision:0,deletedAt:null}}});expect(db.query('SELECT creation_result_json FROM sessions WHERE id=1').get()).toEqual({creation_result_json:old[0]!.creation_result_json});
  mkdirSync(new URL('../../.superpowers/session-lifecycle/',import.meta.url),{recursive:true});
  writeFileSync(new URL('../../.superpowers/session-lifecycle/storage-migration-integrity.json',import.meta.url),JSON.stringify({before:old,after:rows,originalMarkers:markers,markers:db.query('SELECT * FROM schema_migrations ORDER BY version').all(),foreignKeyCheck:db.query('PRAGMA foreign_key_check').all(),integrityCheck:db.query('PRAGMA integrity_check').get(),tables:db.query("SELECT name,strict FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()},null,2));
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test('rename normalizes user title, no-op persists receipt without changing versions, original receipts never become current state',()=>{
 const f=fixture();try{const s=create(f),ws=f.repos.readWorkspace(),request={sessionId:s.session.id,title:'  中文新会话 1  ',expectedMetadataRevision:0};
 const first=f.repos.renameSession(request,'rename',later);expect(first).toMatchObject({method:'session.rename',workspace:null,session:{title:'中文新会话 1',metadataRevision:1,status:'active',deletedAt:null}});expect(f.repos.readWorkspace()).toEqual(ws);
 const original=f.db.query('SELECT updated_at FROM sessions WHERE id=?').get(s.session.id);const noop=f.repos.renameSession({...request,title:'中文新会话 1',expectedMetadataRevision:1},'noop',at);expect(noop.session.metadataRevision).toBe(1);expect(f.db.query('SELECT updated_at FROM sessions WHERE id=?').get(s.session.id)).toEqual(original);
 f.repos.renameSession({...request,title:'second',expectedMetadataRevision:1},'second',later);expect(f.repos.renameSession(request,'rename',at)).toEqual(first);expect(f.repos.readManagementOperation({operationRef:'rename'})).toEqual(first);expect(f.repos.readSession(s.session.id)?.title).toBe('second');expect(f.repos.readManagementOperation({operationRef:'missing'})).toBeNull();
 }finally{f.dispose();}
});
test('metadata validation, CAS and overflow leave no management writes',()=>{
 const f=fixture();try{const s=create(f),request={sessionId:s.session.id,title:'valid',expectedMetadataRevision:0};for(const title of [' ','x'.repeat(257)])expect(()=>f.repos.renameSession({...request,title},title===' '?'blank':'long',at)).toThrow();
 expect(()=>f.repos.renameSession({...request,expectedMetadataRevision:1},'stale',at)).toThrow();f.repos.renameSession({...request,title:'x'.repeat(256)},'max-title',at);
 f.db.query('UPDATE sessions SET metadata_revision=? WHERE id=?').run(Number.MAX_SAFE_INTEGER,s.session.id);expect(()=>f.repos.renameSession({...request,expectedMetadataRevision:Number.MAX_SAFE_INTEGER},'overflow',at)).toThrow();expect(f.repos.readManagementOperation({operationRef:'overflow'})).toBeNull();
 }finally{f.dispose();}
});
test('delete current is dual CAS and atomic with workspace cleanup; noncurrent leaves workspace untouched',()=>{
 const f=fixture();try{const a=create(f,'a'),b=create(f,'b'),ws=f.repos.readWorkspace();
 expect(()=>f.repos.deleteSession({sessionId:a.session.id,expectedMetadataRevision:0,expectedWorkspaceRevision:ws.revision-1},'stale-delete',at)).toThrow();expect(f.repos.readSession(a.session.id)?.status).toBe('active');
 const removed=f.repos.deleteSession({sessionId:a.session.id,expectedMetadataRevision:0,expectedWorkspaceRevision:ws.revision},'delete-a',later);expect(removed.workspace).toEqual(ws);expect(f.repos.readWorkspace()).toEqual(ws);
 const current=f.repos.deleteSession({sessionId:b.session.id,expectedMetadataRevision:0,expectedWorkspaceRevision:ws.revision},'delete-b',later);expect(current.workspace).toMatchObject({sessionId:null,queryId:null,selection:null,revision:ws.revision+1});expect(current.session).toMatchObject({status:'deleted',metadataRevision:1,deletedAt:later});expect(f.repos.listSessions({})).toEqual({sessions:[],nextBeforeSessionId:null});expect(f.repos.readSession(a.session.id)?.status).toBe('deleted');
 const c=create(f,'c');expect(f.repos.deleteSession({sessionId:b.session.id,expectedMetadataRevision:0,expectedWorkspaceRevision:ws.revision},'delete-b',at)).toEqual(current);expect(f.repos.readWorkspace().sessionId).toBe(c.session.id);
 expect(()=>f.repos.selectSession({sessionId:b.session.id,expectedWorkspaceRevision:f.repos.readWorkspace().revision},at)).toThrow();expect(()=>f.repos.renameSession({sessionId:b.session.id,title:'revive',expectedMetadataRevision:1},'revive',at)).toThrow();expect(f.db.query('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({n:3});
 }finally{f.dispose();}
});
test('list filters deleted in SQL before pagination and retains immutable creation snapshots',()=>{
 const f=fixture();try{for(let n=1;n<=6;n++)create(f,`s${n}`);for(const sessionId of [6,4,2])f.repos.deleteSession({sessionId,expectedMetadataRevision:0,expectedWorkspaceRevision:f.repos.readWorkspace().revision},`delete-${sessionId}`,later);
 const first=f.repos.listSessions({limit:2});expect(first.sessions.map(s=>s.id)).toEqual([5,3]);expect(first.nextBeforeSessionId).toBe(3);expect(f.repos.listSessions({limit:2,beforeSessionId:3}).sessions.map(s=>s.id)).toEqual([1]);expect(f.repos.findOperation('s6')).toMatchObject({method:'session.create',result:{session:{status:'active',metadataRevision:0,deletedAt:null}}});
 }finally{f.dispose();}
});
test('management conflicts across operation sources, strict column facts, and rollback protect receipts',()=>{
 const f=fixture();try{const s=create(f),request={sessionId:s.session.id,title:'new',expectedMetadataRevision:0};expect(()=>f.repos.renameSession(request,'create',at)).toThrow();const renamed=f.repos.renameSession(request,'rename',later);
 expect(()=>f.repos.renameSession({...request,title:'other'},'rename',at)).toThrow();expect(()=>f.repos.deleteSession({sessionId:s.session.id,expectedMetadataRevision:1,expectedWorkspaceRevision:1},'rename',at)).toThrow();
 const fail=new Repositories(f.db,()=>{throw new Error('commit-fault');});expect(()=>fail.deleteSession({sessionId:s.session.id,expectedMetadataRevision:1,expectedWorkspaceRevision:1},'fault',at)).toThrow('commit-fault');expect(f.repos.readSession(s.session.id)).toMatchObject({status:'active',metadataRevision:1});expect(f.repos.readWorkspace().sessionId).toBe(s.session.id);expect(f.repos.readManagementOperation({operationRef:'fault'})).toBeNull();
 f.db.query("UPDATE business_events SET actor='system' WHERE operation_ref='rename'").run();expect(()=>f.repos.readManagementOperation({operationRef:'rename'})).toThrow('storage_read_failed');expect(renamed.session.title).toBe('new');
 }finally{f.dispose();}
});
test('workspace restore fingerprint detects metadata changes without workspace revision changes',()=>{
 const f=fixture();try{const s=create(f),inspection=f.repos.inspectWorkspace();f.repos.renameSession({sessionId:s.session.id,title:'changed',expectedMetadataRevision:0},'rename',later);expect(f.repos.readWorkspace().revision).toBe(inspection.state.revision);expect(()=>f.repos.commitWorkspaceRestore(inspection.state.revision,inspection.fingerprint,inspection.candidate,later)).toThrow();}finally{f.dispose();}
});
import { DEFAULT_REQUEST_POLICY } from '../../packages/contracts/src/model';
import { safeError } from '../../packages/contracts/src/error';
import { toWorkspaceContext } from '../../packages/contracts/src/workspace';
const closed={contract:'medclaw.run-cleanup/v1' as const,executionStarted:false,stopConfirmed:true,requiredPersistenceComplete:true,inputsSettled:true,resourcesReleased:true,unconfirmedItems:[],secondaryErrors:[],verifiedAt:later};
function sendPlan(f:ReturnType<typeof fixture>,sessionId:number){const workspace=f.repos.readWorkspace(),model={provider:'p',modelId:'m',api:'openai-completions',endpointRef:null,credentialRef:null,configVersion:'1',maxOutputTokens:100,capabilitySource:'user_declared' as const,sdkVersion:'0.87.1' as const},scope={batchIds:[],deviceIds:null,allowedToolNames:[],allowedResourceRefs:[],artifactIds:[],readOnly:true};
 const request={sessionId,clientSequence:1,text:'original',mode:'send' as const,expectedRevision:workspace.revision,expectedBatchIds:[],expectedQueryId:null,model:{provider:'p',modelId:'m',expectedConfigVersion:'1'},referenceDate:'2026-10-04',timezone:'Asia/Shanghai'};
 return {operationRef:'send',originalSubmitInput:request,createdAt:at,content:{contract:'medclaw.session-input/v1' as const,originalSubmitInput:request,text:request.text,workspaceContext:toWorkspaceContext(workspace),scope,model,referenceDate:request.referenceDate,timezone:request.timezone,deliveryAttempt:null},execution:{mode:'send' as const,run:{sessionId,goal:'answer' as const,text:request.text,model,policy:DEFAULT_REQUEST_POLICY,workspace,scope,referenceDate:request.referenceDate,timezone:request.timezone,timeoutMs:DEFAULT_REQUEST_POLICY.timeoutMs,agentOptions:{requestedThinkingLevel:'off' as const,effectiveThinkingLevel:'off' as const},instanceId:'host',createdAt:at}}};
}
function expectCode(action:()=>unknown,code:string,reason?:string){let caught:unknown;try{action();}catch(error){caught=error;}expect(caught).toMatchObject(reason?{code,reason}:{code});}
test('target durable Run/Input closure blocks delete; closed consumed history remains readable after delete and original replay',()=>{
 const f=fixture();try{const s=create(f),plan=sendPlan(f,s.session.id),accepted=f.repos.acceptInput(plan);if(accepted.runId===null||accepted.inputId===null)throw new Error('Expected root');
 const request={sessionId:s.session.id,expectedMetadataRevision:0,expectedWorkspaceRevision:s.workspace.revision};expectCode(()=>f.repos.deleteSession(request,'running',later),'runtime_busy');
 f.db.query("UPDATE runs SET status='failed',ended_at=?,cleanup_json=? WHERE id=?").run(later,JSON.stringify(closed),accepted.runId);expectCode(()=>f.repos.deleteSession(request,'pending',later),'runtime_busy');
 f.repos.beginInputDelivery(accepted.inputId,'host',at);f.repos.recordInputFailure(accepted.inputId,{sessionId:s.session.id,targetRunId:accepted.runId,at:later,error:safeError('input_delivery_unknown'),proof:{kind:'delivery_unknown',reason:'delivery_unconfirmed'}});
 expectCode(()=>f.repos.deleteSession(request,'unknown-pending',later),'runtime_busy');
 f.repos.verifyPriorInputFacts(accepted.runId,true,later);expect(f.repos.readInput({inputId:accepted.inputId})).toMatchObject({status:'delivery_unknown',processingStatus:'failed'});expectCode(()=>f.repos.deleteSession(request,'unknown-terminal',later),'runtime_busy');
 f.repos.recordInputConsumption(accepted.inputId,{sessionId:s.session.id,runId:accepted.runId,nativeEntryId:'proved-entry',at:later});const original=f.repos.readInput({inputId:accepted.inputId});
 f.db.query('UPDATE runs SET cleanup_json=? WHERE id=?').run(JSON.stringify({...closed,requiredPersistenceComplete:false}),accepted.runId);expectCode(()=>f.repos.deleteSession(request,'save-gap',later),'runtime_busy');
 f.db.query('UPDATE runs SET cleanup_json=? WHERE id=?').run(JSON.stringify(closed),accepted.runId);const removed=f.repos.deleteSession(request,'delete',later);expect(removed.session.status).toBe('deleted');expect(f.repos.readInput({inputId:accepted.inputId})).toEqual(original);expect(f.repos.findSubmission({sessionId:s.session.id,clientSequence:1})).toEqual(accepted);expect(f.repos.acceptInput(plan)).toEqual(accepted);
 const newer={...plan,operationRef:'new',originalSubmitInput:{...plan.originalSubmitInput,clientSequence:2},content:{...plan.content,originalSubmitInput:{...plan.originalSubmitInput,clientSequence:2}}};expectCode(()=>f.repos.acceptInput(newer),'state_conflict','session_deleted');expectCode(()=>f.repos.renameSession({sessionId:s.session.id,title:'new',expectedMetadataRevision:1},'new-name',later),'state_conflict','session_deleted');
 expect(f.db.query('PRAGMA foreign_key_check').all()).toEqual([]);expect(f.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({n:1});expect(f.db.query('SELECT COUNT(*) AS n FROM session_inputs').get()).toEqual({n:1});
 }finally{f.dispose();}
});
test('management lookup rejects cross-source duplicate facts and strictly corrupted receipt identity',()=>{
 const f=fixture();try{const s=create(f),receipt=f.repos.renameSession({sessionId:s.session.id,title:'renamed',expectedMetadataRevision:0},'rename',later);
 f.db.query("INSERT INTO business_events(operation_ref,type,actor,session_id,details_json,occurred_at) SELECT 'create',type,actor,session_id,details_json,occurred_at FROM business_events WHERE operation_ref='rename'").run();expectCode(()=>f.repos.findOperation('create'),'state_conflict');expectCode(()=>f.repos.readManagementOperation({operationRef:'create'}),'storage_read_failed');
 f.db.query("UPDATE business_events SET details_json=json_set(details_json,'$.receipt.operationRef','different') WHERE operation_ref='rename'").run();expectCode(()=>f.repos.readManagementOperation({operationRef:'rename'}),'storage_read_failed');expect(receipt.session.id).toBe(s.session.id);
 }finally{f.dispose();}
});
test('schema6 lifecycle CHECKs reject invalid status/time/revision; lookup storage failure is not null',()=>{
 const f=fixture();try{const s=create(f);for(const sql of ["UPDATE sessions SET status='deleted'", "UPDATE sessions SET deleted_at='2026-10-04T00:00:00.000Z'", "UPDATE sessions SET status='archived'", "UPDATE sessions SET metadata_revision=-1", "UPDATE sessions SET metadata_revision=9007199254740992", "UPDATE sessions SET status='deleted',deleted_at='invalid'"])expect(()=>f.db.exec(sql)).toThrow();expect(f.repos.readSession(s.session.id)?.status).toBe('active');f.db.close();expectCode(()=>f.repos.readManagementOperation({operationRef:'none'}),'storage_read_failed');}finally{rmSync(f.root,{recursive:true,force:true});}
});
test('schema6 migration copy, rename and marker failures roll back schema and original rows',()=>{
 for(const phase of ['lifecycle_copy','lifecycle_rename','lifecycle_marker']){const root=mkdtempSync(join(tmpdir(),'lifecycle-fault-')),path=join(root,'app.sqlite');let db=new Database(path);
 try{for(const [i,name] of migrations.entries()){db.exec('PRAGMA foreign_keys=OFF');const sql=readFileSync(new URL(`../../packages/storage/src/migrations/${name}`,import.meta.url));db.exec(sql.toString());db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(i+1,createHash('sha256').update(sql).digest('hex'),at);}
 db.query("INSERT INTO sessions(native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at) VALUES('native','create','{}','{}','legacy',?,?)").run(at,at);const before=db.query('SELECT * FROM sessions').all(),markers=db.query('SELECT * FROM schema_migrations').all();db.close();expect(()=>openDatabase(path,point=>{if(point===phase)throw new Error('migration-fault');})).toThrow('storage_migration_failed');db=new Database(path);expect(db.query('SELECT * FROM sessions').all()).toEqual(before);expect(db.query('SELECT * FROM schema_migrations').all()).toEqual(markers);expect(db.query("SELECT name FROM sqlite_schema WHERE name='sessions_lifecycle'").get()).toBeNull();db.close();db=openDatabase(path);expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}}
});
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { SqliteCatalogStore } from '../../packages/storage/src/catalog-store';
import { QueryService } from '../../packages/core/src/data/query-service';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { describeDataSelection } from '../../packages/storage/src/workspace-selection';
import { CurrentQuerySchema } from '../../packages/contracts/src/query';
function dataFixture(f:ReturnType<typeof fixture>){
 f.db.query("INSERT INTO imports(id,operation_ref,instance_id,state,preview_request_hash,preview_request_json,created_at,updated_at) VALUES(1,'import','host','imported','hash','{}',?,?)").run(at,at);
 for(const batch of [1,2])f.db.query("INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at) VALUES(?,1,'scope',?,'浙江','v','bundle','lock',?,'full','cohort',1,1,'[]','{}',?,?,1,?)").run(batch,`2026-10-0${batch}`,String(batch).repeat(64),batch===1?1:0,batch===1?null:1,at);
 f.db.query("INSERT INTO devices(id,source_device_id,source_bundle_id,source_submission_id,source_refs_json,created_at) VALUES(1,'device','bundle','submission','[]',?)").run(at);
 for(const batch of [1,2])f.db.query("INSERT INTO snapshots(id,batch_id,device_id,device_name,region,price_cents,currency,unit,status,source_row_ref,source_refs_json,field_origins_json) VALUES(?,?,1,'器械','浙江',100,'CNY','台','active','row','[]','{}')").run(batch,batch);
 f.db.query("INSERT INTO change_events(id,event_key,device_id,old_batch_id,new_batch_id,kind,field,old_value_json,new_value_json,delta_cents,ratio,calculation_version,created_at) VALUES(1,'change',1,1,2,'field_changed','price','100','80',-20,-0.2,'diff/v1',?)").run(at);
 f.repos.updateWorkspace({batchIds:[1,2],deviceIds:[1]},f.repos.readWorkspace().revision,at);
}
test('current deletion preserves valid batches/devices and compatible device/change selections, clears actual Query/evidence view',()=>{
 for(const selection of [null,{formatVersion:1 as const,kind:'device' as const,targetId:'1',targetVersion:'2'.repeat(64),rowKey:'snapshot:2',field:'priceCents'}, {formatVersion:1 as const,kind:'change' as const,targetId:'1',targetVersion:'diff/v1',rowKey:'change:1',field:'deltaCents'}]){
  const f=fixture();try{const s=create(f);dataFixture(f);const scope=f.repos.freezeAgentScope(f.repos.readWorkspace(),[]);
  f.db.query("INSERT INTO runs(id,session_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at) VALUES(10,1,'agent','host','query',1,'{\"sessionId\":1,\"clientSequence\":1}','running','answer','query','{\"agent\":{\"nativeSessionId\":\"native-create\"}}',?,'{}','2026-10-04','Asia/Shanghai',?)").run(JSON.stringify(scope),at);
  const store=new SqliteToolStore(f.db),queries=new QueryService(new CatalogService(new SqliteCatalogStore(f.db)),store);
  const result=queries.current(CurrentQuerySchema.parse({batchIds:[1,2],time:{start:'2026-10-02',endExclusive:'2026-10-03'}}),{sessionId:1,runId:10,nativeToolCallId:'current',scope,referenceDate:'2026-10-04',timezone:'Asia/Shanghai',signal:new AbortController().signal});
  f.db.query("UPDATE runs SET status='completed',ended_at=?,cleanup_json=? WHERE id=10").run(later,JSON.stringify(closed));
  const ws=f.repos.readWorkspace();if(selection?.kind!=='change')f.repos.updateWorkspace({queryId:result.queryId},ws.revision,at);
  const compatible=selection?.kind==='change'?describeDataSelection(new SqliteCatalogStore(f.db).readChanges([2],[1],null)[0]!,new SqliteCatalogStore(f.db).readBatches([1,2])):selection;
  const chosen=compatible??{formatVersion:1 as const,kind:'evidence' as const,targetId:String(result.evidenceIds[0]),targetVersion:store.readQuery(result.queryId)!.resultHash,rowKey:null,field:null};
  f.repos.updateWorkspace({selection:chosen,activeView:selection?.kind==='change'?'changes':'evidence'},f.repos.readWorkspace().revision,at);
  const before=f.repos.readWorkspace(),rows=f.db.query('SELECT * FROM queries').all(),evidence=f.db.query('SELECT * FROM query_evidence').all();
  const removed=f.repos.deleteSession({sessionId:s.session.id,expectedMetadataRevision:0,expectedWorkspaceRevision:before.revision},'delete',later);expect(removed.workspace).toMatchObject({sessionId:null,queryId:null,batchRefs:before.batchRefs,deviceIds:[1],materialVersion:'v',activeView:selection?.kind==='change'?'changes':'data',selection:compatible,revision:before.revision+1});expect(f.db.query('SELECT * FROM queries').all()).toEqual(rows);expect(f.db.query('SELECT * FROM query_evidence').all()).toEqual(evidence);expect(f.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  }finally{f.dispose();}
 }
});
test('confirmed legacy default Chinese title becomes literal user title on rename, while no-op preserves origin',()=>{
 const f=fixture();try{const s=create(f);f.db.query("UPDATE sessions SET title='新会话 1',metadata_json=json_set(metadata_json,'$.titleOrigin','default','$.other',42) WHERE id=?").run(s.session.id);expect(f.repos.readSession(s.session.id)?.title).toBe('New Session 1');
 f.repos.renameSession({sessionId:s.session.id,title:'New Session 1',expectedMetadataRevision:0},'noop',at);expect(f.db.query('SELECT title,metadata_revision,metadata_json FROM sessions').get()).toEqual({title:'新会话 1',metadata_revision:0,metadata_json:'{"titleOrigin":"default","other":42}'});
 const changed=f.repos.renameSession({sessionId:s.session.id,title:'新会话 1',expectedMetadataRevision:0},'literal',later);expect(changed.session).toMatchObject({title:'新会话 1',metadataRevision:1});expect(JSON.parse(String(f.db.query<{metadata_json:string},[]>('SELECT metadata_json FROM sessions').get()!.metadata_json))).toEqual({titleOrigin:'user',other:42});
 }finally{f.dispose();}
});
test('fresh schema6 database closes and reopens repeatedly with unchanged schema and checksums',()=>{
 const root=mkdtempSync(join(tmpdir(),'lifecycle-reopen-')),path=join(root,'db.sqlite');let db=openDatabase(path);try{const f={root,path,db,repos:new Repositories(db),dispose(){}};create(f);const before=db.query('SELECT * FROM schema_migrations ORDER BY version').all();for(let n=0;n<3;n++){db.close();db=openDatabase(path);expect(db.query('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(before);expect(new Repositories(db).readSession(1)).toMatchObject({status:'active',metadataRevision:0,deletedAt:null});}}finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test('management operation identity conflicts with real Input, legacy Run and Provider sources without changing metadata',()=>{
 for(const source of ['input','legacy','provider'] as const){const f=fixture();try{const s=create(f),plan=sendPlan(f,s.session.id),run=plan.execution.run;
 if(source==='input')f.repos.acceptInput(plan);
 else if(source==='legacy')f.repos.registerAgent({...run,inputId:null,submission:{operationRef:'send',originalSubmitInput:plan.originalSubmitInput}});
 else f.repos.registerProvider({operationRef:'send',method:'model.request',originalRequest:{text:'original',model:plan.originalSubmitInput.model,referenceDate:'2026-10-04',timezone:'Asia/Shanghai'},instanceId:'host',goal:'answer',inputText:'original',selection:run.model,policy:DEFAULT_REQUEST_POLICY,referenceDate:'2026-10-04',timezone:'Asia/Shanghai',createdAt:at});
 expectCode(()=>f.repos.renameSession({sessionId:s.session.id,title:'conflict',expectedMetadataRevision:0},'send',later),'state_conflict');expect(f.repos.readSession(s.session.id)?.metadataRevision).toBe(0);expect(f.db.query("SELECT COUNT(*) AS n FROM business_events WHERE type IN ('session_renamed','session_deleted')").get()).toEqual({n:0});
 const renamed=f.repos.renameSession({sessionId:s.session.id,title:'running rename allowed',expectedMetadataRevision:0},'rename',later);expect(renamed.session.metadataRevision).toBe(1);expect(f.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({n:1});
 }finally{f.dispose();}}
});

// These expectations describe display numbering independently of durable Session IDs.
function removeNumberedSession(f: ReturnType<typeof fixture>, sessionId: number, operationRef: string) {
 const current = f.repos.readSession(sessionId)!;
 return f.repos.deleteSession({sessionId, expectedMetadataRevision:current.metadataRevision,
  expectedWorkspaceRevision:f.repos.readWorkspace().revision}, operationRef, later);
}
function renameNumberedSession(f: ReturnType<typeof fixture>, sessionId: number, title: string, operationRef: string) {
 const current = f.repos.readSession(sessionId)!;
 return f.repos.renameSession({sessionId, title, expectedMetadataRevision:current.metadataRevision}, operationRef, later);
}

test('default numbering reuses a deleted display gap without renumbering durable identities or old receipts', () => {
 const f=fixture();try{
  const first=create(f,'number-first'),second=create(f,'number-second'),third=create(f,'number-third');
  const oldRows=f.db.query<{id:number;creation_result_json:string},[]>('SELECT id,creation_result_json FROM sessions ORDER BY id').all();
  removeNumberedSession(f,second.session.id,'number-delete-second');
  const fourth=create(f,'number-fourth');
  expect(fourth.session).toMatchObject({id:4,title:'New Session 2'});
  expect(f.repos.readSession(first.session.id)?.title).toBe('New Session 1');
  expect(f.repos.readSession(third.session.id)?.title).toBe('New Session 3');
  expect(f.db.query('SELECT id,creation_result_json FROM sessions WHERE id<=3 ORDER BY id').all()).toEqual(oldRows);
  expect(f.repos.findOperation('number-second')).toMatchObject({result:{session:{id:2,title:'New Session 2',status:'active'}}});
  expect(f.db.query('SELECT metadata_json FROM sessions WHERE id=4').get()).toEqual({metadata_json:'{"titleOrigin":"default"}'});
  expect(f.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(f.db.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
 }finally{f.dispose();}
});

test('default numbering starts at one after every user Session is deleted while durable IDs keep increasing', () => {
 const f=fixture();try{
  const first=create(f,'clear-first'),second=create(f,'clear-second');
  removeNumberedSession(f,first.session.id,'clear-delete-first');removeNumberedSession(f,second.session.id,'clear-delete-second');
  expect(f.repos.listSessions({})).toEqual({sessions:[],nextBeforeSessionId:null});
  const next=create(f,'clear-new');expect(next.session).toMatchObject({id:3,title:'New Session 1',metadataRevision:0});
  expect(f.db.query('SELECT id,status,title FROM sessions ORDER BY id').all()).toEqual([
   {id:1,status:'deleted',title:'New Session 1'},{id:2,status:'deleted',title:'New Session 2'},{id:3,status:'active',title:'New Session 1'},
  ]);
 }finally{f.dispose();}
});

test('default numbering counts literal user default-shaped names and releases numbers after renaming away', () => {
 const f=fixture();try{
  const first=create(f,'rename-first'),second=create(f,'rename-second');
  renameNumberedSession(f,first.session.id,'我的分析','rename-first-custom');
  renameNumberedSession(f,second.session.id,'New Session 1','rename-second-user');
  const third=create(f,'rename-third');expect(third.session).toMatchObject({id:3,title:'New Session 2'});
  expect(f.db.query('SELECT metadata_json FROM sessions WHERE id=2').get()).toEqual({metadata_json:'{"titleOrigin":"user"}'});
  renameNumberedSession(f,second.session.id,'后续分析','rename-second-custom');
  const fourth=create(f,'rename-fourth');expect(fourth.session).toMatchObject({id:4,title:'New Session 1'});
  expect(f.repos.readSession(first.session.id)?.title).toBe('我的分析');expect(f.repos.readSession(second.session.id)?.title).toBe('后续分析');
 }finally{f.dispose();}
});

test('default numbering scans active names beyond the first sidebar page', () => {
 const f=fixture();try{
  for(let index=1;index<=105;index++)create(f,`page-${index}`);
  const visible=f.repos.listSessions({limit:50});expect(visible.sessions).toHaveLength(50);
  expect(visible.sessions.some(session=>session.id===1)).toBe(false);
  removeNumberedSession(f,2,'page-delete-two');
  const next=create(f,'page-new');expect(next.session).toMatchObject({id:106,title:'New Session 2'});
  expect(f.repos.readSession(1)?.title).toBe('New Session 1');
 }finally{f.dispose();}
});

test('default numbering matches only exact positive safe integer names and leaves user language unchanged', () => {
 const f=fixture();try{
  const titles=['New Session 01','New Session 0','New Session +1','New Session 1 extra','New Session 9007199254740992','新会话 1'];
  for(const [index,title] of titles.entries()){
   const made=create(f,`exact-${index}`);renameNumberedSession(f,made.session.id,title,`exact-rename-${index}`);
  }
  const next=create(f,'exact-new');expect(next.session).toMatchObject({id:7,title:'New Session 1'});
  expect(f.repos.listSessions({limit:50}).sessions.slice(1).map(session=>session.title)).toEqual([...titles].reverse());
 }finally{f.dispose();}
});

test('default numbering uses the public legacy Chinese default projection without rewriting its stored title or creation JSON', () => {
 const f=fixture();try{
  const first=create(f,'legacy-default'),second=create(f,'legacy-user'),third=create(f,'legacy-delete');
  f.db.query("UPDATE sessions SET title='新会话 1',metadata_json=json_set(metadata_json,'$.titleOrigin','default','$.other','保留') WHERE id=?").run(first.session.id);
  renameNumberedSession(f,second.session.id,'新会话 2','legacy-user-rename');removeNumberedSession(f,third.session.id,'legacy-delete-three');
  const original=f.db.query('SELECT id,title,metadata_json,creation_result_json FROM sessions WHERE id<=3 ORDER BY id').all();
  expect(f.repos.readSession(first.session.id)?.title).toBe('New Session 1');expect(f.repos.readSession(second.session.id)?.title).toBe('新会话 2');
  const next=create(f,'legacy-new');expect(next.session).toMatchObject({id:4,title:'New Session 2'});
  expect(f.db.query('SELECT id,title,metadata_json,creation_result_json FROM sessions WHERE id<=3 ORDER BY id').all()).toEqual(original);
 }finally{f.dispose();}
});

test('default numbering rolls back an unpublished allocation and reopens with immutable original creation receipts', () => {
 const f=fixture();let reopened:Database|null=null;try{
  const first=create(f,'recover-first');renameNumberedSession(f,first.session.id,'分析历史','recover-custom');
  const before=f.db.query('SELECT * FROM sessions ORDER BY id').all(),workspace=f.repos.readWorkspace();
  const faulty=new Repositories(f.db,()=>{throw new Error('numbering-commit-fault');});
  expect(()=>faulty.createSession({expectedWorkspaceRevision:workspace.revision},'recover-new','native-recover-new',later)).toThrow('numbering-commit-fault');
  expect(f.db.query('SELECT * FROM sessions ORDER BY id').all()).toEqual(before);expect(f.repos.readWorkspace()).toEqual(workspace);
  expect(f.repos.findOperation('recover-new')).toBeNull();
  const request={expectedWorkspaceRevision:workspace.revision};const accepted=f.repos.createSession(request,'recover-new','native-recover-new',later);
  expect(accepted.session).toMatchObject({id:2,title:'New Session 1'});
  const originalJson=f.db.query('SELECT creation_result_json FROM sessions WHERE id=2').get();
  renameNumberedSession(f,accepted.session.id,'New Session 7','recover-rename');
  const current=create(f,'recover-current');expect(current.session).toMatchObject({id:3,title:'New Session 1'});
  f.db.close();reopened=openDatabase(f.path);const repos=new Repositories(reopened);
  expect(repos.createSession(request,'recover-new','another-native',at)).toEqual(accepted);
  expect(repos.readSession(2)?.title).toBe('New Session 7');expect(repos.readWorkspace().sessionId).toBe(3);
  expect(reopened.query('SELECT creation_result_json FROM sessions WHERE id=2').get()).toEqual(originalJson);
  expect(reopened.query('PRAGMA foreign_key_check').all()).toEqual([]);expect(reopened.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
 }finally{reopened?.close();f.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('default numbering explicitly persists default origin before schema6 migration and preserves it on same-name rename', () => {
 const root=mkdtempSync(join(tmpdir(),'numbering-old-schema-')),path=join(root,'db.sqlite');let db=new Database(path);
 try{
  for(const [index,name] of migrations.slice(0,2).entries()){
   db.exec('PRAGMA foreign_keys=OFF');
   const sql=readFileSync(new URL(`../../packages/storage/src/migrations/${name}`,import.meta.url));db.exec(sql.toString());
   db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'),at);
  }
  const repos=new Repositories(db);repos.createSession({expectedWorkspaceRevision:0},'origin-first','native-origin-first',at);
  db.query("UPDATE sessions SET title='保留历史' WHERE id=1").run();
  const made=repos.createSession({expectedWorkspaceRevision:1},'origin-second','native-origin-second',later);
  expect(made.session).toMatchObject({id:2,title:'New Session 1'});
  expect(db.query('SELECT metadata_json FROM sessions WHERE id=2').get()).toEqual({metadata_json:'{"titleOrigin":"default"}'});
  const originalJson=db.query('SELECT creation_result_json FROM sessions WHERE id=2').get();
  db.close();db=openDatabase(path);const migrated=new Repositories(db);
  expect(db.query('SELECT metadata_json FROM sessions WHERE id=2').get()).toEqual({metadata_json:'{"titleOrigin":"default"}'});
  migrated.renameSession({sessionId:2,title:'New Session 1',expectedMetadataRevision:0},'origin-noop',later);
  expect(db.query('SELECT metadata_revision,metadata_json FROM sessions WHERE id=2').get()).toEqual({metadata_revision:0,metadata_json:'{"titleOrigin":"default"}'});
  migrated.renameSession({sessionId:2,title:'用户命名',expectedMetadataRevision:0},'origin-user',later);
  expect(db.query('SELECT metadata_revision,metadata_json FROM sessions WHERE id=2').get()).toEqual({metadata_revision:1,metadata_json:'{"titleOrigin":"user"}'});
  expect(db.query('SELECT creation_result_json FROM sessions WHERE id=2').get()).toEqual(originalJson);
  expect(migrated.findOperation('origin-second')).toMatchObject({result:{session:{id:2,title:'New Session 1'}}});
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);expect(db.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
