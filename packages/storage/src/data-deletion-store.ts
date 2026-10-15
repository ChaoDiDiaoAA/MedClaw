import type {Database} from 'bun:sqlite';
import {canonicalRequest} from '../../contracts/src/run';
import {safeError} from '../../contracts/src/error';
import {DataDeletePreviewRequestSchema,DataDeleteCommitRequestSchema,DataDeleteOperationSchema,DataDeletePreviewSchema,
 type DataDeletePreviewRequest,type DataDeleteCommitRequest,type DataDeleteOperation,type DataDeleteFile} from '../../contracts/src/data-deletion';
import {Repositories} from './repositories';
import {SqliteWriteTransactions} from './write-transactions';
import {omitLegacyFields,legacyWorkspaceContext} from './legacy-business-fields';

type Row={operation_ref:string;request_json:string;preview_json:string;commit_request_json:string|null;receipt_json:string|null;state:'ready'|'committed';cleanup_json:string;updated_at:string};
const encode=(ids:number[])=>JSON.stringify(ids);
export class SqliteDataDeletionStore {
 private readonly transactions:SqliteWriteTransactions;
 constructor(private readonly db:Database,private readonly repositories:Repositories,private readonly assertRuntimeIdle:()=>void=()=>{}){this.transactions=SqliteWriteTransactions.forDatabase(db);}
 private row(operationRef:string){return this.db.query<Row,[string]>('SELECT * FROM data_deletions WHERE operation_ref=?').get(operationRef);}
 read(operationRef:string):DataDeleteOperation|null{const row=this.row(operationRef);if(!row)return null;const preview=omitLegacyFields(JSON.parse(row.preview_json),['previewHash']) as Record<string,unknown>,receipt=row.receipt_json?JSON.parse(row.receipt_json):null;preview.files=(preview.files as unknown[]).map(file=>omitLegacyFields(file,['sha256']));if(receipt)receipt.workspace=legacyWorkspaceContext(receipt.workspace);return DataDeleteOperationSchema.parse({operationRef:row.operation_ref,state:row.state,preview,receipt,cleanup:JSON.parse(row.cleanup_json),updatedAt:row.updated_at});}
 private count(sql:string,params:(string|number)[]=[]){return this.db.query<{n:number},(string|number)[]>(sql).get(...params)!.n;}
 importGeneration(){return this.count("SELECT COALESCE(MAX(id),0) n FROM business_events WHERE type IN ('import.imported','import.duplicate')");}
 private checkImportGeneration(expected?:number){if(expected!==undefined&&this.importGeneration()!==expected)throw new Error('state_conflict');}
 private deletableDevices(batchIds:number[]){return this.db.query<{id:number},[string]>(`SELECT d.id FROM devices d WHERE d.id IN (
 SELECT json_extract(c.value,'$.deviceId') FROM batches b,json_each(b.cohort_json) c WHERE b.id IN (SELECT value FROM json_each(?1))
 UNION SELECT device_id FROM snapshots WHERE batch_id IN (SELECT value FROM json_each(?1))
 UNION SELECT device_id FROM change_events WHERE old_batch_id IN (SELECT value FROM json_each(?1)) OR new_batch_id IN (SELECT value FROM json_each(?1)))
 AND NOT EXISTS(SELECT 1 FROM snapshots s WHERE s.device_id=d.id AND s.batch_id NOT IN (SELECT value FROM json_each(?1)))
 AND NOT EXISTS(SELECT 1 FROM change_events e WHERE e.device_id=d.id AND e.old_batch_id NOT IN (SELECT value FROM json_each(?1)) AND e.new_batch_id NOT IN (SELECT value FROM json_each(?1))) ORDER BY d.id`).all(encode(batchIds)).map(row=>row.id);}
 targetIds(input:DataDeletePreviewRequest):number[]{return this.db.query<{id:number},[string,string]>("SELECT id FROM batches WHERE status='active' AND (?='all' OR id IN (SELECT value FROM json_each(?))) ORDER BY id").all(input.target.kind,input.target.kind==='batches'?encode(input.target.batchIds):'[]').map(row=>row.id);}
 assertIdle(operationRef?:string){
  this.assertRuntimeIdle();
  if(this.count("SELECT COUNT(*) n FROM runs WHERE status IN ('created','running')")||this.count("SELECT COUNT(*) n FROM session_inputs WHERE processing_status='pending'")||this.count("SELECT COUNT(*) n FROM imports WHERE state IN ('preparing','committing')"))throw safeError('state_conflict',undefined,{reason:'runtime_busy'});
  if(this.count("SELECT COUNT(*) n FROM data_deletions WHERE state='committed' AND json_extract(cleanup_json,'$.state')<>'complete' AND operation_ref<>?",[operationRef??'']))throw new Error('operation_result_unknown');
 }
 preview(raw:DataDeletePreviewRequest,instanceId:string,time:string,files:DataDeleteFile[],importGeneration?:number):DataDeleteOperation{
  const input=DataDeletePreviewRequestSchema.parse(raw);
  return this.transactions.immediate(()=>{
   const prior=this.row(input.operationRef);if(prior){if(prior.request_json!==canonicalRequest(input))throw new Error('state_conflict');return this.read(input.operationRef)!;}
   if(this.repositories.findOperation(input.operationRef))throw new Error('state_conflict');
   for(const table of ['imports','session_inputs'])if(this.db.query(`SELECT id FROM ${table} WHERE operation_ref=?`).get(input.operationRef))throw new Error('state_conflict');
   this.assertIdle();
   this.checkImportGeneration(importGeneration);
   const revision=this.count('SELECT revision n FROM catalog_state WHERE id=1'),workspace=this.repositories.readWorkspace();
   if(workspace.revision!==input.expectedWorkspaceRevision)throw new Error('workspace_revision_mismatch');
   if(revision!==input.expectedCatalogRevision)throw new Error('state_conflict');
   const rows=this.db.query<{id:number;snapshot_date:string},[string,string]>("SELECT id,snapshot_date FROM batches WHERE status='active' AND (?='all' OR id IN (SELECT value FROM json_each(?))) ORDER BY id").all(input.target.kind,input.target.kind==='batches'?encode(input.target.batchIds):'[]');
   if(!rows.length||input.target.kind==='batches'&&rows.length!==input.target.batchIds.length)throw new Error('access_denied');
   const ids=rows.map(row=>row.id),encoded=encode(ids);
   const base={operationRef:input.operationRef,catalogRevision:revision,workspaceRevision:workspace.revision,batches:rows.map(row=>({id:row.id,snapshotDate:row.snapshot_date})),
    snapshotCount:this.count('SELECT COUNT(*) n FROM snapshots WHERE batch_id IN (SELECT value FROM json_each(?))',[encoded]),
    changeCount:this.count('SELECT COUNT(*) n FROM change_events WHERE old_batch_id IN (SELECT value FROM json_each(?1)) OR new_batch_id IN (SELECT value FROM json_each(?1))',[encoded]),
    deviceCount:this.deletableDevices(ids).length,
    queryCount:this.count('SELECT COUNT(*) n FROM queries q WHERE EXISTS(SELECT 1 FROM json_each(q.batch_ids_json) b WHERE b.value IN (SELECT value FROM json_each(?)))',[encoded]),
    workspaceWillChange:workspace.batchRefs.some(ref=>ids.includes(ref.id)),files:[...files].sort((a,b)=>a.artifactId-b.artifactId||a.path.localeCompare(b.path))};
   const preview=DataDeletePreviewSchema.parse(base);
   this.db.query("INSERT INTO data_deletions(operation_ref,instance_id,request_json,preview_json,state,cleanup_json,created_at,updated_at) VALUES(?,?,?,?,'ready',?,?,?)").run(input.operationRef,instanceId,canonicalRequest(input),canonicalRequest(preview),canonicalRequest({state:'pending',remainingCount:files.length,error:null}),time,time);
   return this.read(input.operationRef)!;
  });
 }
 commit(raw:DataDeleteCommitRequest,time:string,importGeneration?:number):DataDeleteOperation{
  const input=DataDeleteCommitRequestSchema.parse(raw);
  return this.transactions.immediate(()=>{
   const row=this.row(input.operationRef),operation=this.read(input.operationRef);if(!row||!operation)throw new Error('operation_not_found');
   if(row.commit_request_json&&canonicalRequest(omitLegacyFields(JSON.parse(row.commit_request_json),['previewHash']))!==canonicalRequest(input))throw new Error('state_conflict');
   const p=operation.preview;
   if(input.expectedCatalogRevision!==p.catalogRevision||input.expectedWorkspaceRevision!==p.workspaceRevision)throw new Error('state_conflict');
   if(operation.state==='committed')return operation;
   this.assertIdle(input.operationRef);
   this.checkImportGeneration(importGeneration);
   if(this.repositories.readWorkspace().revision!==p.workspaceRevision)throw new Error('workspace_revision_mismatch');
   if(this.count('SELECT revision n FROM catalog_state WHERE id=1')!==p.catalogRevision)throw new Error('state_conflict');
   const ids=p.batches.map(batch=>batch.id),encoded=encode(ids);
   if(this.count("SELECT COUNT(*) n FROM batches WHERE status='active' AND id IN (SELECT value FROM json_each(?))",[encoded])!==ids.length)throw new Error('state_conflict');
   const devices=this.deletableDevices(ids);if(devices.length!==p.deviceCount)throw new Error('state_conflict');
   this.db.query('DELETE FROM change_events WHERE old_batch_id IN (SELECT value FROM json_each(?1)) OR new_batch_id IN (SELECT value FROM json_each(?1))').run(encoded);
   this.db.query('DELETE FROM snapshots WHERE batch_id IN (SELECT value FROM json_each(?))').run(encoded);
   this.db.query('DELETE FROM devices WHERE id IN (SELECT value FROM json_each(?))').run(encode(devices));
   this.db.query("UPDATE batches SET status='deleted',deleted_at=?,deletion_operation_ref=? WHERE id IN (SELECT value FROM json_each(?)) AND status='active'").run(time,input.operationRef,encoded);
   this.db.query('UPDATE catalog_state SET revision=revision+1,updated_at=? WHERE id=1 AND revision=?').run(time,p.catalogRevision);
   const workspace=this.repositories.reconcileDeletedWorkspace(p.workspaceRevision,time);
   const receipt={operationRef:input.operationRef,batchIds:ids,snapshotCount:p.snapshotCount,changeCount:p.changeCount,deviceCount:p.deviceCount,catalogRevision:p.catalogRevision+1,workspace,committedAt:time};
   const cleanup={state:p.files.length?'pending':'complete',remainingCount:p.files.length,error:null};
   this.db.query("UPDATE data_deletions SET state='committed',commit_request_json=?,receipt_json=?,cleanup_json=?,updated_at=? WHERE operation_ref=?").run(canonicalRequest(input),canonicalRequest(receipt),canonicalRequest(cleanup),time,input.operationRef);
   this.db.query("INSERT INTO business_events(operation_ref,type,actor,details_json,occurred_at) VALUES(?,'data.batch_deleted','user',?,?)").run(input.operationRef,canonicalRequest(receipt),time);
   return this.read(input.operationRef)!;
  });
 }
 saveCleanup(operationRef:string,cleanup:DataDeleteOperation['cleanup'],time:string){return this.transactions.immediate(()=>{const operation=this.read(operationRef);if(!operation||operation.state!=='committed')throw new Error('state_conflict');this.db.query('UPDATE data_deletions SET cleanup_json=?,updated_at=? WHERE operation_ref=?').run(canonicalRequest(cleanup),time,operationRef);return this.read(operationRef)!;});}
}
