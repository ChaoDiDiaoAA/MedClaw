import {queryTargetVersion,batchTargetVersion} from '../../packages/storage/src/workspace-selection';
import {SnapshotMetadataSchema} from '../../packages/contracts/src/data';
import {readPackageRows} from '../../packages/storage/src/snapshot-rows';
import { afterEach, expect, test, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
afterEach(()=>{ handles.splice(0).forEach(db=>db.close()); roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})); });
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'p7-restore-')); roots.push(root);
  const db=openDatabase(join(root,'db.sqlite')); handles.push(db);
  const repos=new Repositories(db), artifacts=new ArtifactStore(db,join(root,'artifacts'));
  repos.createSession({expectedWorkspaceRevision:0},'create','native',at);
  for(const id of [1,2]) {
    const date=`2026-10-0${id}`,file=`zhejiang_${date}.csv`,metadataFile=file.replace('.csv','.metadata.json');
    const metadata=SnapshotMetadataSchema.parse({contract:'medclaw.snapshot/v2',mappingVersion:'medclaw.snapshot/v1',materialVersion:'material/v1',generatorVersion:'fixture/v1',seed:1,
      sourceBundleId:'bundle',scopeKey:`scope-${id}`,region:'浙江',snapshotDate:date,coverage:'full',expectedEntityCount:1,observedEntityCount:1,declaredMissingEntityIds:[],referenceDate:'2026-10-04',timezone:'Asia/Shanghai'});
    const columns='device_id device_name source_submission_id source_applicant category region snapshot_date price_cents currency unit status manufacturer distributor source_refs_json field_origins_json'.split(' ');
    const refs=[{sourceId:'fixture',file:'original.csv',row:1,recordId:`device-${id}`}],origins=Object.fromEntries(columns.slice(0,13).map(key=>[key,{kind:'synthetic',ruleId:'fixture'}]));
    const csv=(cells:string[])=>cells.map(cell=>'"'+cell.replaceAll('"','""')+'"').join(',');
    const payload=csv(columns)+'\n'+csv([`device-${id}`,'器械','submission','Applicant','Category','浙江',date,'100','CNY','台','active','Maker','Distributor',JSON.stringify(refs),JSON.stringify(origins)])+'\n';
    mkdirSync(artifacts.inputPath(id),{recursive:true});writeFileSync(join(artifacts.inputPath(id),file),payload);writeFileSync(join(artifacts.inputPath(id),metadataFile),JSON.stringify(metadata));
    const files=[{path:file,bytes:Buffer.byteLength(payload)},{path:metadataFile,bytes:Buffer.byteLength(JSON.stringify(metadata))}],bytes=files.reduce((sum,file)=>sum+file.bytes,0);
    const manifest={schema:'medclaw.artifact/import/v2',artifactId:id,operationRef:`import-${id}`,role:'snapshot_package',files:files.map(f=>({...f,path:`input/${f.path}`})),mappingVersion:'medclaw.snapshot/v1',calculationVersion:'diff/v1',sourceBundleId:'bundle',materialVersion:'material/v1',verifiedAt:at};
    const text=canonicalRequest(manifest);writeFileSync(artifacts.manifestPath(id),text);
    db.query(`INSERT INTO imports(id,operation_ref,instance_id,state,preview_request_json,manifest_path,result_json,created_at,updated_at) VALUES(?,?,'host','imported','{}',?,?,?,?)`).run(id,`import-${id}`,`${id}/manifest.json`,JSON.stringify({batchIds:[id]}),at,at);
    db.query(`INSERT INTO artifacts(id,operation_ref,kind,import_id,format,relative_path,bytes,registered_at,mime_type,metadata_json,status) VALUES(?,?,'import',?,'csv',?,?,?,'application/x-directory',?,'ready')`).run(id,`import-${id}`,id,String(id),bytes,at,text);
    db.query('UPDATE imports SET artifact_id=? WHERE id=?').run(id,id);
    db.query(`INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,coverage,expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at) VALUES(?,?,?,?,'浙江','material/v1','bundle','full',1,1,'[]',?,1,NULL,1,?)`).run(id,id,`scope-${id}`,date,JSON.stringify(metadata),at);
    const row=[...readPackageRows(artifacts.inputPath(id),file,metadata)][0]!;
    db.query(`INSERT INTO devices(id,source_device_id,source_bundle_id,source_submission_id,source_applicant,source_refs_json,created_at) VALUES(?,?,'bundle',?,?,?,?)`).run(id,row.sourceDeviceId,row.sourceSubmissionId,row.sourceApplicant,JSON.stringify(row.sourceRefs),at);
    db.query(`INSERT INTO snapshots(id,batch_id,device_id,device_name,category,region,price_cents,currency,unit,status,manufacturer,distributor,source_row_ref,source_refs_json,field_origins_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,id,id,row.deviceName,row.category,row.region,row.priceCents,row.currency,row.unit,row.status,row.manufacturer,row.distributor,row.sourceRowRef,JSON.stringify(row.sourceRefs),JSON.stringify(row.fieldOrigins));
  }
  repos.updateWorkspace({batchIds:[1,2],deviceIds:[1,2]},1,at);
  const inspector=artifacts as ArtifactStore & {inspectManagedImport(id:number):Promise<ManagedImportInspection>};
  const store=repos as Repositories & WorkspaceStore;
  const service=new (WorkspaceService as unknown as new (store:WorkspaceStore, artifacts:typeof inspector)=>WorkspaceService)(store,inspector);
  const sql=()=>db.query('SELECT * FROM workspace').get();
  return {root,db,repos,store,artifacts,inspector,service,sql,file:(id:number)=>join(artifacts.inputPath(id),`zhejiang_2026-10-0${id}.csv`)};
}
function queryFixture() {
  const f=fixture();f.repos.updateWorkspace({deviceIds:[]},2,at);const scope=f.repos.freezeAgentScope(f.repos.readWorkspace(),[]);
  f.db.query(`INSERT INTO runs(id,session_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at)
    VALUES(10,1,'agent','host','query-submit',1,'{"sessionId":1,"clientSequence":1}','running','answer','query','{"agent":{"nativeSessionId":"native"}}',?,'{}','2026-10-04','Asia/Shanghai',?)`).run(JSON.stringify(scope),at);
  const store=new SqliteToolStore(f.db),queries=new QueryService(new CatalogService(new SqliteCatalogStore(f.db)),store);
  const page=queries.current(CurrentQuerySchema.parse({batchIds:[2],time:{start:'2026-10-02',endExclusive:'2026-10-03'}}),{sessionId:1,runId:10,nativeToolCallId:'current',scope,referenceDate:'2026-10-04',timezone:'Asia/Shanghai',signal:new AbortController().signal});
  f.db.query("UPDATE runs SET status='completed',ended_at=? WHERE id=10").run(at);
  const query=store.readQuery(page.queryId)!;
  f.repos.updateWorkspace({queryId:query.id,activeView:'evidence',selection:{formatVersion:1,kind:'evidence',targetId:String(page.evidenceIds[0]),targetVersion:queryTargetVersion(query),rowKey:'snapshot:2',field:'priceCents'}},3,at);
  return {...f,query,evidenceId:page.evidenceIds[0]!};
}

test('managed copy remains valid after original source directory moves; restore is a complete SQL no-op',async()=>{
  const f=fixture(); mkdirSync(join(f.root,'source')); renameSync(join(f.root,'source'),join(f.root,'source-moved'));
  expect(typeof f.inspector.inspectManagedImport).toBe('function');
  expect(await f.inspector.inspectManagedImport(1)).toEqual({status:'valid'});
  const before=f.sql(), result=await f.service.restore(); expect(result.ok).toBe(true); expect(f.sql()).toEqual(before);
});
test.each(['content','missing','manifest'] as const)('determinate %s damage clears only its original batch and dependent device once',async damage=>{
  const f=fixture(), before=f.repos.readWorkspace();
  if(damage==='content')writeFileSync(f.file(1),readFileSync(f.file(1),'utf8').replace('\"100\"','\"200\"'));
  else rmSync(damage==='missing'?f.file(1):f.artifacts.manifestPath(1));
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
  const f=fixture(),before=f.sql(); writeFileSync(f.file(1),readFileSync(f.file(1),'utf8').replace('\"100\"','\"200\"'));
  const actual=f.inspector.inspectManagedImport?.bind(f.inspector);
  f.inspector.inspectManagedImport=async id=>id===2?{status:'unavailable',reason:'temporary_io'}:actual!(id);
  const result=await f.service.restore(); expect(result.ok).toBe(false); expect(f.sql()).toEqual(before);
});
test('file checks happen outside SQLite and concurrent selection wins over restore cleanup',async()=>{
  const f=fixture(); writeFileSync(f.file(1),readFileSync(f.file(1),'utf8').replace('\"100\"','\"200\"'));
  const actual=f.inspector.inspectManagedImport?.bind(f.inspector); let selected:unknown;
  f.inspector.inspectManagedImport=async id=>{ expect(f.db.inTransaction).toBe(false); const result=await actual!(id); if(id===2){f.repos.updateWorkspace({batchIds:[2],deviceIds:[2]},2,at);selected=f.sql();} return result; };
  const result=await f.service.restore(); expect(result.ok).toBe(false); if(!result.ok)expect(result.error.reason).toBe('workspace_revision_mismatch'); expect(f.sql()).toEqual(selected);
});
test('unchanged revision with changed dependencies conflicts instead of repairing a drifted BatchRef',async()=>{
  const f=fixture(),before=f.sql(); const actual=f.inspector.inspectManagedImport?.bind(f.inspector);
  f.inspector.inspectManagedImport=async id=>{const result=await actual!(id);if(id===2)f.db.query("UPDATE batches SET scope_key='drifted-scope' WHERE id=1").run();return result;};
  const result=await f.service.restore(); expect(result.ok).toBe(false); expect(f.sql()).toEqual(before);
});
test('pre-commit failure rolls back the full cleanup row and returns no successful notice',async()=>{
  const f=fixture(),before=f.sql(); writeFileSync(f.file(1),readFileSync(f.file(1),'utf8').replace('\"100\"','\"200\"'));
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
test('an already drifted BatchRef is removed, never rebuilt with the current database metadata',async()=>{
  const f=fixture();f.db.query("UPDATE batches SET scope_key='drifted-scope' WHERE id=1").run();
  const result=await f.service.restore();expect(result.ok).toBe(true);if(result.ok){expect(result.data.batchRefs.map(b=>b.id)).toEqual([2]);expect(result.data.deviceIds).toEqual([2]);}
});
test('one stale BatchRef sharing a valid managed Artifact preserves the other valid batch reference',async()=>{
  const f=fixture();f.db.query('UPDATE batches SET import_id=1 WHERE id=2').run();
  const one=JSON.parse(readFileSync(f.artifacts.manifestPath(1),'utf8')),two=JSON.parse(readFileSync(f.artifacts.manifestPath(2),'utf8'));
  for(const file of two.files)copyFileSync(join(f.root,'artifacts','2',file.path),join(f.root,'artifacts','1',file.path));
  one.files.push(...two.files);const text=canonicalRequest(one);writeFileSync(f.artifacts.manifestPath(1),text);
  f.db.query('UPDATE artifacts SET metadata_json=?,bytes=? WHERE id=1').run(text,one.files.reduce((sum:number,file:{bytes:number})=>sum+file.bytes,0));
  f.db.query("UPDATE imports SET result_json='{}' WHERE id=2").run();
  f.db.query("UPDATE imports SET result_json='{\"batchIds\":[1,2]}' WHERE id=1").run();
  f.db.query("UPDATE workspace SET batch_refs_json=json_set(batch_refs_json,'$[0].scopeKey','stale-scope')").run();
  expect(await f.inspector.inspectManagedImport(1)).toEqual({status:'valid'});
  const before=f.repos.readWorkspace(),facts=f.db.query('SELECT * FROM batches ORDER BY id').all();
  const result=await f.service.restore();expect(result.ok).toBe(true);if(!result.ok)return;
  expect(result.data.batchRefs).toEqual([before.batchRefs[1]!]);expect(result.data.deviceIds).toEqual([2]);expect(result.data.revision).toBe(before.revision+1);
  expect(result.data).toHaveProperty('notices',[{code:'reference_cleared',kind:'batch',targetId:'1'},{code:'reference_cleared',kind:'device',targetId:'1'}]);
  expect(f.db.query('SELECT * FROM batches ORDER BY id').all()).toEqual(facts);expect(await f.inspector.inspectManagedImport(1)).toEqual({status:'valid'});
  const saved=f.sql();expect((await f.service.restore()).ok).toBe(true);expect(f.sql()).toEqual(saved);
});
test('missing Session clears only its session reference while legal batch scope survives',async()=>{
  const f=fixture();f.db.exec('PRAGMA foreign_keys=OFF');f.db.query('DELETE FROM sessions WHERE id=1').run();
  const result=await f.service.restore();expect(result.ok).toBe(true);if(result.ok){expect(result.data.sessionId).toBeNull();expect(result.data.batchRefs.map(b=>b.id)).toEqual([1,2]);expect(result.data.deviceIds).toEqual([1,2]);}
});
test.each(['metadata','owner','snapshot','device'])('%s dependency drift after file verification conflicts without a revision change',async kind=>{
  const f=fixture();f.repos.updateWorkspace({selection:{formatVersion:1,kind:'device',targetId:'1',targetVersion:'batch:1:material/v1',rowKey:'snapshot:1',field:'priceCents'}},2,at);
  const before=f.sql(),actual=f.inspector.inspectManagedImport.bind(f.inspector);
  f.inspector.inspectManagedImport=async id=>{const result=await actual(id);if(id===2){
    if(kind==='metadata')f.db.query("UPDATE artifacts SET metadata_json=json_set(metadata_json,'$.verifiedAt','2026-10-05T00:00:00.000Z') WHERE id=1").run();
    if(kind==='owner')f.db.query("UPDATE imports SET manifest_path='other' WHERE id=1").run();
    if(kind==='snapshot')f.db.query('UPDATE snapshots SET price_cents=200 WHERE id=1').run();
    if(kind==='device')f.db.query("UPDATE devices SET source_submission_id='other' WHERE id=1").run();
  }return result;};
  const result=await f.service.restore();expect(result.ok).toBe(false);if(!result.ok)expect(result.error.reason).toBe('workspace_revision_mismatch');expect(f.sql()).toEqual(before);
});
test('the final IMMEDIATE recheck rejects changes occurring after the second inspection',async()=>{
  const f=fixture(),before=f.sql();writeFileSync(f.file(1),readFileSync(f.file(1),'utf8').replace('\"100\"','\"200\"'));
  const store:WorkspaceStore={readWorkspace:()=>f.store.readWorkspace(),updateWorkspace:(...args)=>f.store.updateWorkspace(...args),inspectWorkspace:(...args)=>f.store.inspectWorkspace(...args),commitWorkspaceRestore:(...args)=>{
    f.db.query("UPDATE imports SET manifest_path='changed' WHERE id=2").run();return f.store.commitWorkspaceRestore(...args);
  }};
  const result=await new WorkspaceService(store,f.inspector).restore();expect(result.ok).toBe(false);if(!result.ok)expect(result.error.reason).toBe('workspace_revision_mismatch');expect(f.sql()).toEqual(before);
});
test('managed ownership, manifest metadata and unexpected file membership cannot be trusted',async()=>{
  const f=fixture();writeFileSync(join(f.artifacts.inputPath(1),'extra.csv'),'extra');
  expect(await f.inspector.inspectManagedImport(1)).toEqual({status:'invalid',reason:'content_mismatch'});
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
