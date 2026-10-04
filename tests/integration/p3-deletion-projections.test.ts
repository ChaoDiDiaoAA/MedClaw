import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../packages/storage/src/database';
import {seedWorkspaceQueries} from '../fixtures/p7-workspace';
import {SqliteCatalogStore} from '../../packages/storage/src/catalog-store';
import {SqliteDataDeletionStore} from '../../packages/storage/src/data-deletion-store';
import {toWorkspaceContext} from '../../packages/contracts/src/workspace';
import {InputContentSchema} from '../../packages/contracts/src/session';
const history=await import('../../packages/storage/src/history-source-store').catch(()=>null);
const at='2026-10-04T02:00:00.000Z';
function fixture(){const root=mkdtempSync(join(tmpdir(),'delete-projection-')),db=openDatabase(join(root,'app.sqlite')),saved=seedWorkspaceQueries(db);return{db,saved,dispose(){db.close();rmSync(root,{recursive:true,force:true});}};}
test('per-batch catalog verifies distinct actual populations 3/2/4 and rejects inconsistent metadata',()=>{const f=fixture();try{
 f.db.query("UPDATE batches SET expected_entity_count=4,declared_missing_json='[4]',metadata_json=? WHERE id=1").run(JSON.stringify({expectedEntityCount:4,observedEntityCount:3,declaredMissingEntityIds:['four']}));
 f.db.query("INSERT INTO devices(id,source_device_id,source_bundle_id,source_submission_id,source_refs_json,created_at) VALUES(4,'four','bundle','submission','[]',?)").run(at);
 for(const [id,observed,missing] of [[2,2,'[3,4]'],[3,4,'[]']] as const){f.db.query("INSERT INTO batches(import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at) SELECT import_id,scope_key,?,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,4,?,?,'{}',0,1,1,created_at FROM batches WHERE id=1").run(`2026-10-0${id+3}`,observed,missing);
 for(let device=1;device<=observed;device++)f.db.query("INSERT INTO snapshots(batch_id,device_id,device_name,region,price_cents,currency,unit,status,source_row_ref,source_refs_json,field_origins_json) SELECT ?,?,device_name,region,price_cents,currency,unit,status,source_row_ref,source_refs_json,field_origins_json FROM snapshots WHERE id=1").run(id,device);}
 f.db.query("UPDATE batches SET metadata_json=json_object('expectedEntityCount',4,'observedEntityCount',observed_entity_count,'declaredMissingEntityIds',json((SELECT json_group_array(d.source_device_id) FROM json_each(declared_missing_json) j JOIN devices d ON d.id=j.value))) WHERE id>1").run();
 f.db.query("UPDATE batches SET cohort_json=(SELECT json_group_array(json_object('deviceId',id,'sourceDeviceId',source_device_id)) FROM devices)").run();
 const store=new SqliteCatalogStore(f.db);expect('readCatalog' in store).toBe(true);
 const result=(store as SqliteCatalogStore & {readCatalog(page:number,size:number):any}).readCatalog(1,2);expect(result.batches.map((b:any)=>[b.observedEntityCount,b.expectedEntityCount,b.declaredMissingDeviceIds.length])).toEqual([[3,4,1],[2,4,2]]);expect(result.snapshotCount).toBe(9);expect((store as any).readCatalog(2,2).batches[0].observedEntityCount).toBe(4);
 f.db.query('UPDATE batches SET observed_entity_count=3 WHERE id=2').run();expect(()=>(store as any).readCatalog(1,2)).toThrow('tool_output_inconsistent');
}finally{f.dispose();}});
test('deleted historical results remain hash-identical and receive independent unavailable-source projection',()=>{expect(history?.HistorySourceStore).toBeFunction();const f=fixture();try{
 const source=new history!.HistorySourceStore(f.db),prior=f.saved.store.readQuery(f.saved.current.id)!;
 const workspace=f.saved.repos.readWorkspace(),request={sessionId:1,clientSequence:2,mode:'follow_up' as const,targetRunId:10,text:'Saved explanation',expectedRevision:workspace.revision,expectedBatchIds:[1],expectedQueryId:null,model:{provider:'fixture',modelId:'fixture',expectedConfigVersion:'0'},referenceDate:'2026-10-04',timezone:'Asia/Shanghai'};
 const content=InputContentSchema.parse({contract:'medclaw.session-input/v1',originalSubmitInput:request,text:request.text,workspaceContext:toWorkspaceContext(workspace),scope:f.saved.context.scope,model:{provider:'fixture',modelId:'fixture',configVersion:'0',endpointRef:null,api:'openai-completions',credentialRef:null,maxOutputTokens:100,capabilitySource:'user_declared',sdkVersion:'0.87.1'},referenceDate:request.referenceDate,timezone:request.timezone,deliveryAttempt:{instanceId:'host',startedAt:at}});
 f.db.query("INSERT INTO session_inputs(session_id,client_sequence,operation_ref,mode,status,processing_status,content_json,target_run_id,run_id,native_entry_id,created_at,delivered_at,processed_at,updated_at) VALUES(1,2,'saved-input','follow_up','consumed','completed',?,10,10,'saved-entry',?,?,?,?)").run(JSON.stringify(content),at,at,at,at);
 const inputs=f.db.query('SELECT * FROM session_inputs').all(),runs=f.db.query('SELECT scope_json,workspace_json,config_json FROM runs').all(),evidence=f.saved.store.readEvidence(f.saved.evidenceId);
 expect(source.evidence(prior.id,f.saved.evidenceId,1,50).items).toHaveLength(3);
 expect(source.availability(prior.batchIds)).toEqual({sourceAvailability:'available',deletedBatchIds:[]});
 const deletion=new SqliteDataDeletionStore(f.db,f.saved.repos),p=deletion.preview({operationRef:'delete',target:{kind:'all'},expectedCatalogRevision:0,expectedWorkspaceRevision:f.saved.repos.readWorkspace().revision},'host',at,[]);
 deletion.commit({operationRef:'delete',previewHash:p.preview.previewHash,expectedCatalogRevision:0,expectedWorkspaceRevision:p.preview.workspaceRevision},at);
 const view=source.query(f.saved.current.id,1,2);expect(view.query.sourceAvailability).toBe('deleted');expect(view.query.deletedBatchIds).toEqual([1]);expect(view.page.rows).toEqual(prior.rows.slice(0,2));expect(view.query.resultHash).toBe(prior.resultHash);expect(f.saved.store.readQuery(prior.id)).toEqual(prior);
 expect(()=>f.saved.repos.updateWorkspace({queryId:prior.id},f.saved.repos.readWorkspace().revision,at)).toThrow('access_denied');
 const unavailable=source.evidence(prior.id,f.saved.evidenceId,1,50);expect(unavailable.sourceAvailability).toBe('deleted');expect(unavailable.deletedBatchIds).toEqual([1]);expect(unavailable.items).toEqual([]);expect(unavailable.totalRows).toBe(3);expect(f.saved.store.readEvidence(f.saved.evidenceId)).toEqual(evidence);expect(f.db.query('SELECT * FROM session_inputs').all()).toEqual(inputs);expect(f.db.query('SELECT scope_json,workspace_json,config_json FROM runs').all()).toEqual(runs);
}finally{f.dispose();}});
