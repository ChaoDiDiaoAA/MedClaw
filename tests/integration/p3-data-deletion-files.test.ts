import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,existsSync,readFileSync,renameSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openDatabase} from '../../packages/storage/src/database';
import {Repositories} from '../../packages/storage/src/repositories';
import {SqliteImportStore} from '../../packages/storage/src/import-store';
import {ArtifactStore} from '../../packages/storage/src/artifact-store';
import {SqliteDataDeletionStore} from '../../packages/storage/src/data-deletion-store';
import {ImportService} from '../../packages/core/src/data/import-service';
import {WorkspaceService} from '../../packages/core/src/workspace/workspace-service';
import {packageFixture} from '../fixtures/snapshot-package';
import {CatalogService} from '../../packages/core/src/data/catalog-service';
import {SqliteCatalogStore} from '../../packages/storage/src/catalog-store';
const module=await import('../../packages/core/src/data/data-deletion-service').catch(()=>null);
async function fixture(options:Parameters<typeof packageFixture>[1]={}){expect(module?.DataDeletionService).toBeFunction();const root=mkdtempSync(join(tmpdir(),'batch-files-')),source=join(root,'source');packageFixture(source,{prices:[100,80,90],...options});const db=openDatabase(join(root,'app.sqlite')),artifacts=new ArtifactStore(db,join(root,'artifacts')),repos=new Repositories(db),imports=new ImportService({store:new SqliteImportStore(db),artifacts,resolveToken:()=>source,instanceId:'host'});const p=await imports.preview({operationRef:'import',fileToken:'token',mappingVersion:'medclaw.snapshot/v1'});expect(p.ok).toBe(true);if(!p.ok)throw p.error;const done=await imports.commit({operationRef:'import',previewHash:p.data.previewHash,fileToken:'token'});expect(done.ok).toBe(true);repos.createSession({expectedWorkspaceRevision:0},'session','native','2026-10-04T00:00:00.000Z');repos.updateWorkspace({batchIds:[1,2,3]},1,'2026-10-04T00:00:00.000Z');const store=new SqliteDataDeletionStore(db,repos),service=new module!.DataDeletionService(store,artifacts,'host');return {root,source,db,artifacts,repos,store,service,imports,dispose(){db.close();rmSync(root,{recursive:true,force:true});}};}
const preview=(f:Awaited<ReturnType<typeof fixture>>,target:{kind:'all'}|{kind:'batches';batchIds:number[]}={kind:'batches',batchIds:[2]})=>f.service.preview({operationRef:'delete',target,expectedCatalogRevision:1,expectedWorkspaceRevision:f.repos.readWorkspace().revision});
async function commit(f:Awaited<ReturnType<typeof fixture>>,p:Awaited<ReturnType<typeof preview>>){expect(p.ok).toBe(true);if(!p.ok)throw p.error;return f.service.commit({operationRef:'delete',previewHash:p.data.preview.previewHash,expectedCatalogRevision:1,expectedWorkspaceRevision:p.data.preview.workspaceRevision});}
test('batch deletion cleans only selected managed payload and import/Workspace recovery accepts the proved missing files',async()=>{const f=await fixture();try{const original=readFileSync(join(f.source,'zhejiang_2026-01-02.csv'));const p=await preview(f),done=await commit(f,p);expect(done.ok).toBe(true);if(!done.ok)throw done.error;expect(done.data.cleanup.state).toBe('complete');expect(existsSync(join(f.artifacts.inputPath(1),'zhejiang_2026-01-02.csv'))).toBe(false);expect(existsSync(join(f.artifacts.inputPath(1),'zhejiang_2026-01-01.csv'))).toBe(true);expect(readFileSync(join(f.source,'zhejiang_2026-01-02.csv'))).toEqual(original);expect(f.db.query('SELECT COUNT(*) n FROM snapshots').get()).toEqual({n:2});expect(f.db.query('SELECT COUNT(*) n FROM change_events').get()).toEqual({n:0});const recovery=await f.imports.recover('import');expect(recovery.ok).toBe(true);const restored=await new WorkspaceService(f.repos,f.artifacts).restore();expect(restored.ok).toBe(true);if(restored.ok)expect(restored.data.batchRefs.map(ref=>ref.id)).toEqual([1,3]);}finally{f.dispose();}});
test('batch deletion all removes every copied input payload but retains the immutable published manifest',async()=>{const f=await fixture();try{const p=await preview(f,{kind:'all'}),done=await commit(f,p);expect(done.ok).toBe(true);if(!done.ok)throw done.error;expect(done.data.cleanup.state).toBe('complete');for(const file of done.data.preview.files)expect(existsSync(join(f.root,'artifacts',String(file.artifactId),file.path))).toBe(false);expect(existsSync(f.artifacts.manifestPath(1))).toBe(true);expect(f.db.query('SELECT COUNT(*) n FROM devices').get()).toEqual({n:0});expect((await f.imports.recover('import')).ok).toBe(true);}finally{f.dispose();}});
test('batch deletion cleanup failure remains committed and explicit recover does not repeat database deletion',async()=>{const f=await fixture();try{const p=await preview(f),original=f.artifacts.deleteManagedFile.bind(f.artifacts);let fail=true;f.artifacts.deleteManagedFile=async(...args:Parameters<typeof original>)=>{if(fail){fail=false;throw new Error('fixture-secret');}return original(...args);};const done=await commit(f,p);expect(done.ok).toBe(true);if(!done.ok)throw done.error;expect(done.data.state).toBe('committed');expect(done.data.cleanup.state).toBe('failed');expect(JSON.stringify(done)).not.toContain('fixture-secret');const recovered=await f.service.recover('delete');expect(recovered.ok).toBe(true);if(recovered.ok)expect(recovered.data.cleanup.state).toBe('complete');expect(f.db.query("SELECT COUNT(*) n FROM business_events WHERE type='data.batch_deleted'").get()).toEqual({n:1});expect(f.db.query('SELECT revision FROM catalog_state').get()).toEqual({revision:2});}finally{f.dispose();}});

test('deletion checks every duplicate managed copy and catalog caches cannot hide a deleted predecessor',async()=>{const f=await fixture();try{
 const p=await f.imports.preview({operationRef:'duplicate',fileToken:'token',mappingVersion:'medclaw.snapshot/v1'});expect(p.ok).toBe(true);if(!p.ok)throw p.error;expect((await f.imports.commit({operationRef:'duplicate',previewHash:p.data.previewHash,fileToken:'token'})).ok).toBe(true);
 const catalog=new CatalogService(new SqliteCatalogStore(f.db)),context={runId:1,sessionId:1,inputId:null,source:'user_form' as const,callRef:'check',scope:{batchIds:[1,2,3],deviceIds:null,allowedToolNames:[],allowedResourceRefs:[],artifactIds:[],readOnly:true},referenceDate:'2026-01-03',timezone:'Asia/Shanghai',signal:new AbortController().signal};expect(catalog.batches([2],context)).toHaveLength(1);
 const deletion=await preview(f);expect(deletion.ok).toBe(true);if(!deletion.ok)throw deletion.error;expect(deletion.data.preview.files).toHaveLength(4);expect((await commit(f,deletion)).ok).toBe(true);
 for(const artifact of [1,2]){expect(existsSync(join(f.artifacts.inputPath(artifact),'zhejiang_2026-01-02.csv'))).toBe(false);expect(existsSync(join(f.artifacts.inputPath(artifact),'entity-lineage.csv'))).toBe(true);}
 const next={...context,scope:{...context.scope,batchIds:[1,3]}};expect(catalog.batches([3],next)).toHaveLength(1);expect(catalog.snapshots([3],next)).toHaveLength(1);expect(()=>catalog.batches([2],next)).toThrow('data_coverage_missing');expect((await f.imports.recover('duplicate')).ok).toBe(true);
 const gap=await f.imports.preview({operationRef:'history-insert',fileToken:'token',mappingVersion:'medclaw.snapshot/v1'});expect(gap.ok).toBe(true);if(gap.ok)expect(gap.data.canCommit).toBe(false);
}finally{f.dispose();}});

test('complete deletion reimports the original package with new payload and batch identities',async()=>{const f=await fixture();try{expect((await commit(f,await preview(f,{kind:'all'}))).ok).toBe(true);const p=await f.imports.preview({operationRef:'reimport',fileToken:'token',mappingVersion:'medclaw.snapshot/v1'});expect(p.ok).toBe(true);if(!p.ok)throw p.error;const done=await f.imports.commit({operationRef:'reimport',previewHash:p.data.previewHash,fileToken:'token'});expect(done.ok).toBe(true);if(!done.ok)throw done.error;expect(done.data.result!.batchIds.every(id=>id>3)).toBe(true);expect(f.db.query<{id:number},[]>('SELECT id FROM devices').get()!.id).toBeGreaterThan(1);expect(f.db.query<{id:number},[]>('SELECT MIN(id) id FROM snapshots').get()!.id).toBeGreaterThan(3);expect((await f.imports.recover('import')).ok).toBe(true);}finally{f.dispose();}});

test('a duplicate published after preview invalidates the frozen cleanup plan',async()=>{const f=await fixture();try{
 const deletion=await preview(f);const p=await f.imports.preview({operationRef:'late-copy',fileToken:'token',mappingVersion:'medclaw.snapshot/v1'});expect(p.ok).toBe(true);if(!p.ok)throw p.error;
 expect((await f.imports.commit({operationRef:'late-copy',previewHash:p.data.previewHash,fileToken:'token'})).ok).toBe(true);
 const rejected=await commit(f,deletion);expect(rejected.ok).toBe(false);if(!rejected.ok)expect(rejected.error.code).toBe('state_conflict');expect(f.db.query('SELECT COUNT(*) n FROM snapshots').get()).toEqual({n:3});expect(f.store.read('delete')?.state).toBe('ready');
}finally{f.dispose();}});

test('device deletion counts include never-observed cohort members and retain unrelated orphan identities',async()=>{const f=await fixture({expectedCount:4,observedCounts:[3,3,3]});try{
 f.db.query("INSERT INTO devices(source_device_id,source_bundle_id,source_submission_id,source_refs_json,created_at) VALUES('unrelated','other','other','[]','2026-10-04')").run();
 const p=await preview(f,{kind:'all'});expect(p.ok).toBe(true);if(!p.ok)throw p.error;expect(p.data.preview.deviceCount).toBe(4);const done=await commit(f,p);expect(done.ok).toBe(true);if(done.ok)expect(done.data.receipt!.deviceCount).toBe(4);
 expect(f.db.query('SELECT source_device_id FROM devices').all()).toEqual([{source_device_id:'unrelated'}]);
}finally{f.dispose();}});

test('catalog missing-set identities remain verifiable after deletion removes their live devices',async()=>{const f=await fixture({expectedCount:4,observedCounts:[3,2,4]});try{
 const store=new SqliteCatalogStore(f.db);expect(store.readCatalog(1,50).snapshotCount).toBe(9);
 const original=f.db.query<{metadata_json:string},[]>('SELECT metadata_json FROM batches WHERE id=2').get()!.metadata_json;
 f.db.query("UPDATE batches SET metadata_json=json_set(metadata_json,'$.declaredMissingEntityIds',json(?)) WHERE id=2").run(JSON.stringify(['wrong-one','wrong-two']));expect(()=>store.readCatalog(1,50)).toThrow('tool_output_inconsistent');
 f.db.query('UPDATE batches SET metadata_json=? WHERE id=2').run(original);
 const p=await preview(f,{kind:'batches',batchIds:[1,3]});expect((await commit(f,p)).ok).toBe(true);expect(store.readCatalog(1,50).batches[0]!.observedEntityCount).toBe(2);
 expect(f.db.query('SELECT COUNT(*) n FROM devices').get()).toEqual({n:2});
 f.db.query("UPDATE batches SET metadata_json=json_set(metadata_json,'$.declaredMissingEntityIds',json(?)) WHERE id=2").run(JSON.stringify(['wrong-one','wrong-two']));expect(()=>store.readCatalog(1,50)).toThrow('tool_output_inconsistent');
}finally{f.dispose();}});

test('a duplicate finishing during commit file verification is detected inside the business transaction',async()=>{const f=await fixture();try{
 const deletion=await preview(f),original=f.artifacts.assertDeletionOwner.bind(f.artifacts);let once=true;
 f.artifacts.assertDeletionOwner=async(id:number)=>{await original(id);if(once){once=false;const p=await f.imports.preview({operationRef:'racing-copy',fileToken:'token',mappingVersion:'medclaw.snapshot/v1'});if(!p.ok)throw p.error;expect((await f.imports.commit({operationRef:'racing-copy',previewHash:p.data.previewHash,fileToken:'token'})).ok).toBe(true);}};
 const rejected=await commit(f,deletion);expect(rejected.ok).toBe(false);if(!rejected.ok)expect(rejected.error.code).toBe('state_conflict');expect(f.db.query('SELECT COUNT(*) n FROM snapshots').get()).toEqual({n:3});
}finally{f.dispose();}});

test('a junction replacing managed input cannot delete the original source and traversal is rejected',async()=>{const f=await fixture();try{
 const p=await preview(f),original=f.store.commit.bind(f.store);f.store.commit=(...args:Parameters<typeof original>)=>{const result=original(...args);renameSync(f.artifacts.inputPath(1),join(f.root,'kept-copy'));symlinkSync(f.source,f.artifacts.inputPath(1),'junction');return result;};
 const done=await commit(f,p);expect(done.ok).toBe(true);if(!done.ok)throw done.error;expect(done.data.state).toBe('committed');expect(done.data.cleanup.state).toBe('failed');expect(existsSync(join(f.source,'zhejiang_2026-01-02.csv'))).toBe(true);
 await expect(f.artifacts.deleteManagedFile({artifactId:1,path:'../source/zhejiang_2026-01-02.csv'},'delete')).rejects.toThrow();
}finally{f.dispose();}});

test('published artifact metadata stays immutable while a separate source projection identifies deleted files',async()=>{const f=await fixture();try{
 const original=f.db.query('SELECT metadata_json,metadata_sha256 FROM artifacts WHERE id=1').get();expect((await commit(f,await preview(f))).ok).toBe(true);const read=await f.artifacts.read(1);expect(read.ok).toBe(true);if(!read.ok||!read.data||!('sourceAvailability' in read.data))throw new Error('fixture');expect(read.data.sourceAvailability).toBe('deleted');expect(read.data.deletedBatchIds).toEqual([2]);expect(read.data.unavailableFiles).toHaveLength(2);expect(f.db.query('SELECT metadata_json,metadata_sha256 FROM artifacts WHERE id=1').get()).toEqual(original);
}finally{f.dispose();}});
