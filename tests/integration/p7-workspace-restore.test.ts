import { afterEach, expect, test, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as filesystem from 'node:fs/promises';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { ArtifactStore } from '../../packages/storage/src/artifact-store';
import { WorkspaceService } from '../../packages/core/src/workspace/workspace-service';
import { SqliteCatalogStore } from '../../packages/storage/src/catalog-store';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { QueryService } from '../../packages/core/src/data/query-service';
import { CurrentQuerySchema } from '../../packages/contracts/src/query';
import { canonicalRequest } from '../../packages/contracts/src/run';
import type { ManagedImportInspection, WorkspaceStore } from '../../packages/contracts/src/workspace';

const at='2026-10-04T00:00:00.000Z', roots:string[]=[], handles:Database[]=[];
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
afterEach(()=>{ handles.splice(0).forEach(db=>db.close()); roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})); });
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'p7-restore-')); roots.push(root);
  const db=openDatabase(join(root,'db.sqlite')); handles.push(db);
  const repos=new Repositories(db), artifacts=new ArtifactStore(db,join(root,'artifacts'));
  repos.createSession({expectedWorkspaceRevision:0},'create','native',at);
  for(const id of [1,2]) {
    db.query(`INSERT INTO imports(id,operation_ref,instance_id,state,preview_request_hash,preview_request_json,manifest_path,created_at,updated_at) VALUES(?,?,'host','imported','hash','{}',?,?,?)`).run(id,`import-${id}`,`${id}/manifest.json`,at,at);
    mkdirSync(artifacts.inputPath(id),{recursive:true}); writeFileSync(join(artifacts.inputPath(id),'data.csv'),`data-${id}`);
    const files=[{path:'data.csv',bytes:6,sha256:hash(`data-${id}`)}],sourceHash=hash(canonicalRequest(files));
    const manifest={schema:'medclaw.artifact/import/v1',artifactId:id,operationRef:`import-${id}`,role:'snapshot_package',files:files.map(f=>({...f,path:`input/${f.path}`})),sourceHash,metadataHash:hash('metadata'),mappingVersion:'mapping/v1',calculationVersion:'diff/v1',sourceLockHash:'lock',sourceBundleId:'bundle',materialVersion:'material/v1',verifiedAt:at};
    const text=canonicalRequest(manifest); writeFileSync(artifacts.manifestPath(id),text);
    db.query(`INSERT INTO artifacts(id,operation_ref,kind,import_id,format,relative_path,sha256,bytes,metadata_sha256,registered_at,mime_type,metadata_json,status) VALUES(?,?,'import',?,'csv',?,?,6,?,?,'application/x-directory',?,'ready')`).run(id,`import-${id}`,id,String(id),sourceHash,hash(text),at,text);
    db.query('UPDATE imports SET artifact_id=? WHERE id=?').run(id,id);
    db.query(`INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at) VALUES(?,?,?,?,'浙江','material/v1','bundle','lock',?,'full','cohort',1,1,'[]','{}',1,NULL,1,?)`).run(id,id,`scope-${id}`,`2026-10-0${id}`,hash(`batch-${id}`),at);
    db.query(`INSERT INTO devices(id,source_device_id,source_bundle_id,source_submission_id,source_refs_json,created_at) VALUES(?,?,'bundle','submission','[]',?)`).run(id,`device-${id}`,at);
    db.query(`INSERT INTO snapshots(id,batch_id,device_id,device_name,region,price_cents,currency,unit,status,source_row_ref,source_refs_json,field_origins_json) VALUES(?,?,?,'器械','浙江',100,'CNY','台','active','row','[]','{}')`).run(id,id,id);
  }
  repos.updateWorkspace({batchIds:[1,2],deviceIds:[1,2]},1,at);
  const inspector=artifacts as ArtifactStore & {inspectManagedImport(id:number):Promise<ManagedImportInspection>};
  const store=repos as Repositories & WorkspaceStore;
  const service=new (WorkspaceService as unknown as new (store:WorkspaceStore, artifacts:typeof inspector)=>WorkspaceService)(store,inspector);
  const sql=()=>db.query('SELECT * FROM workspace').get();
  return {root,db,repos,store,artifacts,inspector,service,sql};
}
function queryFixture() {
  const f=fixture();f.repos.updateWorkspace({deviceIds:[]},2,at);const scope=f.repos.freezeAgentScope(f.repos.readWorkspace(),[]);
  f.db.query(`INSERT INTO runs(id,session_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at)
    VALUES(10,1,'agent','host','query-submit',1,'{"sessionId":1,"clientSequence":1}','running','answer','query','{"agent":{"nativeSessionId":"native"}}',?,'{}','2026-10-04','Asia/Shanghai',?)`).run(JSON.stringify(scope),at);
  const store=new SqliteToolStore(f.db),queries=new QueryService(new CatalogService(new SqliteCatalogStore(f.db)),store);
  const page=queries.current(CurrentQuerySchema.parse({batchIds:[2],time:{start:'2026-10-02',endExclusive:'2026-10-03'}}),{sessionId:1,runId:10,nativeToolCallId:'current',scope,referenceDate:'2026-10-04',timezone:'Asia/Shanghai',signal:new AbortController().signal});
  f.db.query("UPDATE runs SET status='completed',ended_at=? WHERE id=10").run(at);
  const query=store.readQuery(page.queryId)!;
  f.repos.updateWorkspace({queryId:query.id,activeView:'evidence',selection:{formatVersion:1,kind:'evidence',targetId:String(page.evidenceIds[0]),targetVersion:query.resultHash,rowKey:'snapshot:2',field:'priceCents'}},3,at);
  return {...f,query,evidenceId:page.evidenceIds[0]!};
}

test('managed copy remains valid after original source directory moves; restore is a complete SQL no-op',async()=>{
  const f=fixture(); mkdirSync(join(f.root,'source')); renameSync(join(f.root,'source'),join(f.root,'source-moved'));
  expect(typeof f.inspector.inspectManagedImport).toBe('function');
  expect(await f.inspector.inspectManagedImport(1)).toEqual({status:'valid'});
  const before=f.sql(), result=await f.service.restore(); expect(result.ok).toBe(true); expect(f.sql()).toEqual(before);
});
test.each(['hash','missing','manifest'] as const)('determinate %s damage clears only its original batch and dependent device once',async damage=>{
  const f=fixture(), before=f.repos.readWorkspace();
  if(damage==='hash')writeFileSync(join(f.artifacts.inputPath(1),'data.csv'),'broken');
  else rmSync(damage==='missing'?join(f.artifacts.inputPath(1),'data.csv'):f.artifacts.manifestPath(1));
  const result=await f.service.restore(); expect(result.ok).toBe(true); if(!result.ok)return;
  expect(result.data.batchRefs.map(b=>b.id)).toEqual([2]); expect(result.data.deviceIds).toEqual([2]); expect(result.data.revision).toBe(before.revision+1);
  expect(result.data).toHaveProperty('notices'); expect(JSON.stringify(f.sql())).not.toContain('reference_cleared');
  expect(f.db.query('SELECT status FROM artifacts ORDER BY id').all()).toEqual([{status:'ready'},{status:'ready'}]);
  const saved=f.sql(); expect((await f.service.restore()).ok).toBe(true); expect(f.sql()).toEqual(saved);
});
test('unreachable managed root preserves all original SQL bytes',async()=>{
  const f=fixture(),before=f.sql(); renameSync(join(f.root,'artifacts'),join(f.root,'offline'));
  const result=await f.service.restore(); expect(result.ok).toBe(false); expect(f.sql()).toEqual(before);
});
test.each(['EACCES','EIO','EBUSY'])('%s mixed with invalid refs prevents partial cleanup',async code=>{
  const f=fixture(),before=f.sql(); writeFileSync(join(f.artifacts.inputPath(1),'data.csv'),'broken');
  const actual=f.inspector.inspectManagedImport?.bind(f.inspector);
  f.inspector.inspectManagedImport=async id=>id===2?{status:'unavailable',reason:'temporary_io'}:actual!(id);
  const result=await f.service.restore(); expect(result.ok).toBe(false); expect(f.sql()).toEqual(before);
});
test('file checks happen outside SQLite and concurrent selection wins over restore cleanup',async()=>{
  const f=fixture(); writeFileSync(join(f.artifacts.inputPath(1),'data.csv'),'broken');
  const actual=f.inspector.inspectManagedImport?.bind(f.inspector); let selected:unknown;
  f.inspector.inspectManagedImport=async id=>{ expect(f.db.inTransaction).toBe(false); const result=await actual!(id); if(id===2){f.repos.updateWorkspace({batchIds:[2],deviceIds:[2]},2,at);selected=f.sql();} return result; };
  const result=await f.service.restore(); expect(result.ok).toBe(false); if(!result.ok)expect(result.error.reason).toBe('workspace_revision_mismatch'); expect(f.sql()).toEqual(selected);
});
test('unchanged revision with changed dependencies conflicts instead of repairing a drifted BatchRef',async()=>{
  const f=fixture(),before=f.sql(); const actual=f.inspector.inspectManagedImport?.bind(f.inspector);
  f.inspector.inspectManagedImport=async id=>{const result=await actual!(id);if(id===2)f.db.query("UPDATE batches SET content_hash=? WHERE id=1").run(hash('drift'));return result;};
  const result=await f.service.restore(); expect(result.ok).toBe(false); expect(f.sql()).toEqual(before);
});
test('pre-commit failure rolls back the full cleanup row and returns no successful notice',async()=>{
  const f=fixture(),before=f.sql(); writeFileSync(join(f.artifacts.inputPath(1),'data.csv'),'broken');
  const repos=new Repositories(f.db,()=>{throw new Error('storage_write_failed');});
  const service=new (WorkspaceService as unknown as new (store:WorkspaceStore, artifacts:typeof f.inspector)=>WorkspaceService)(repos as Repositories & WorkspaceStore,f.inspector);
  const result=await service.restore(); expect(result.ok).toBe(false);expect(f.sql()).toEqual(before);
});
test('corrupt saved Workspace JSON returns safe storage error without clearing',async()=>{
  const f=fixture(); f.db.query("UPDATE workspace SET batch_refs_json='{}'").run(); const before=f.sql();
  const result=await f.service.restore(); expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('storage_read_failed');expect(f.sql()).toEqual(before);
});
test('DB read failure and managed DB failure are unavailable without writes',async()=>{
  const f=fixture(),before=f.sql(); expect(typeof f.inspector.inspectManagedImport).toBe('function');
  const bad=new ArtifactStore({query(){throw new Error('private SQLite failure');}} as unknown as Database,join(f.root,'artifacts'));
  expect(await (bad as typeof f.inspector).inspectManagedImport(1)).toEqual({status:'unavailable',reason:'storage_unavailable'});
  const store={...f.store,inspectWorkspace(){throw new Error('storage_read_failed');}} as unknown as WorkspaceStore;
  const service=new (WorkspaceService as unknown as new (store:WorkspaceStore, artifacts:typeof f.inspector)=>WorkspaceService)(store,f.inspector);
  expect((await service.restore()).ok).toBe(false);expect(f.sql()).toEqual(before);
});

test.each(['EACCES','EIO','EBUSY'])('managed inspection classifies actual %s filesystem rejection as unavailable',async code=>{
  const f=fixture(),before=f.sql(),actual=filesystem.lstat;
  const failure=Object.assign(new Error('private filesystem path'),{code});
  const fault=spyOn(filesystem,'lstat').mockImplementation((async (...args:Parameters<typeof filesystem.lstat>)=>{
    if(String(args[0])===f.artifacts.manifestPath(1))throw failure;
    return actual(...args);
  }) as typeof filesystem.lstat);
  try {
    expect(await f.inspector.inspectManagedImport(1)).toEqual({status:'unavailable',reason:'temporary_io'});
    const result=await f.service.restore();expect(result.ok).toBe(false);expect(f.sql()).toEqual(before);
  } finally {fault.mockRestore();}
});
test('malformed persisted JSON bytes are a read error and preserve the entire row',async()=>{
  const f=fixture();f.db.exec('PRAGMA ignore_check_constraints=ON');f.db.query("UPDATE workspace SET selection_json='{'").run();const before=f.sql();
  const result=await f.service.restore();expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('storage_read_failed');expect(f.sql()).toEqual(before);
});
test('an already drifted BatchRef is removed, never rebuilt with the current database hash',async()=>{
  const f=fixture();f.db.query('UPDATE batches SET content_hash=? WHERE id=1').run(hash('changed'));
  const result=await f.service.restore();expect(result.ok).toBe(true);if(result.ok){expect(result.data.batchRefs.map(b=>b.id)).toEqual([2]);expect(result.data.deviceIds).toEqual([2]);}
});
test('missing Session clears only its session reference while legal batch scope survives',async()=>{
  const f=fixture();f.db.exec('PRAGMA foreign_keys=OFF');f.db.query('DELETE FROM sessions WHERE id=1').run();
  const result=await f.service.restore();expect(result.ok).toBe(true);if(result.ok){expect(result.data.sessionId).toBeNull();expect(result.data.batchRefs.map(b=>b.id)).toEqual([1,2]);expect(result.data.deviceIds).toEqual([1,2]);}
});
test.each(['metadata','owner','snapshot','device'])('%s dependency drift after file verification conflicts without a revision change',async kind=>{
  const f=fixture();f.repos.updateWorkspace({selection:{formatVersion:1,kind:'device',targetId:'1',targetVersion:hash('batch-1'),rowKey:'snapshot:1',field:'priceCents'}},2,at);
  const before=f.sql(),actual=f.inspector.inspectManagedImport.bind(f.inspector);
  f.inspector.inspectManagedImport=async id=>{const result=await actual(id);if(id===2){
    if(kind==='metadata')f.db.query("UPDATE artifacts SET metadata_sha256=? WHERE id=1").run(hash('new metadata'));
    if(kind==='owner')f.db.query("UPDATE imports SET manifest_path='other' WHERE id=1").run();
    if(kind==='snapshot')f.db.query('UPDATE snapshots SET price_cents=200 WHERE id=1').run();
    if(kind==='device')f.db.query("UPDATE devices SET source_submission_id='other' WHERE id=1").run();
  }return result;};
  const result=await f.service.restore();expect(result.ok).toBe(false);if(!result.ok)expect(result.error.reason).toBe('workspace_revision_mismatch');expect(f.sql()).toEqual(before);
});
test('the final IMMEDIATE recheck rejects changes occurring after the second inspection',async()=>{
  const f=fixture(),before=f.sql();writeFileSync(join(f.artifacts.inputPath(1),'data.csv'),'broken');
  const store:WorkspaceStore={readWorkspace:()=>f.store.readWorkspace(),updateWorkspace:(...args)=>f.store.updateWorkspace(...args),inspectWorkspace:(...args)=>f.store.inspectWorkspace(...args),commitWorkspaceRestore:(...args)=>{
    f.db.query("UPDATE imports SET manifest_path='changed' WHERE id=2").run();return f.store.commitWorkspaceRestore(...args);
  }};
  const result=await new WorkspaceService(store,f.inspector).restore();expect(result.ok).toBe(false);if(!result.ok)expect(result.error.reason).toBe('workspace_revision_mismatch');expect(f.sql()).toEqual(before);
});
test('managed ownership, manifest metadata and unexpected file membership cannot be trusted',async()=>{
  const f=fixture();writeFileSync(join(f.artifacts.inputPath(1),'extra.csv'),'extra');
  expect(await f.inspector.inspectManagedImport(1)).toEqual({status:'invalid',reason:'hash_mismatch'});
  f.db.query("UPDATE imports SET manifest_path='another/manifest.json' WHERE id=2").run();
  expect(await f.inspector.inspectManagedImport(2)).toEqual({status:'invalid',reason:'owner_mismatch'});
});
test('valid selected Evidence restores without changing Query, Evidence, Run or event facts',async()=>{
  const f=queryFixture(),names=['workspace','queries','query_evidence','runs','runtime_events','business_events','artifacts','batches','snapshots','model_calls','session_inputs'];
  const before=Object.fromEntries(names.map(name=>[name,f.db.query(`SELECT * FROM ${name} ORDER BY id`).all()]));
  const result=await f.service.restore();expect(result.ok).toBe(true);if(result.ok){expect(result.data.activeView).toBe('evidence');expect(result.data.selection?.targetId).toBe(String(f.evidenceId));}
  expect(Object.fromEntries(names.map(name=>[name,f.db.query(`SELECT * FROM ${name} ORDER BY id`).all()]))).toEqual(before);
});
test.each(['query','evidence'])('%s dependencies changing after file verification conflict while original workspace survives',async kind=>{
  const f=queryFixture(),before=f.sql(),actual=f.inspector.inspectManagedImport.bind(f.inspector);
  f.inspector.inspectManagedImport=async id=>{const result=await actual(id);if(kind==='query'){f.db.exec('DROP TRIGGER queries_update_immutable');f.db.query("UPDATE queries SET created_at='2026-10-04T00:00:01.000Z' WHERE id=?").run(f.query.id);}else{f.db.exec('DROP TRIGGER query_evidence_update_immutable');f.db.query("UPDATE query_evidence SET source_bundle_id='other' WHERE id=?").run(f.evidenceId);}return result;};
  const result=await f.service.restore();expect(result.ok).toBe(false);if(!result.ok)expect(result.error.reason).toBe('workspace_revision_mismatch');expect(f.sql()).toEqual(before);
});
test('unverifiable saved Query JSON is an integrity error that does not clear the workspace',async()=>{
  const f=queryFixture();f.db.exec('DROP TRIGGER queries_update_immutable');f.db.query("UPDATE queries SET result_json='{}' WHERE id=?").run(f.query.id);const before=f.sql();
  const result=await f.service.restore();expect(result.ok).toBe(false);expect(f.sql()).toEqual(before);
});

