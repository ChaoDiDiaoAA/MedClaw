import type {Database} from 'bun:sqlite';
import {BUSINESS_RULES, QuerySummarySchema, EvidenceSummarySchema, QueryViewSchema, EvidenceViewSchema} from '../../contracts/src/query';
import {SqliteCatalogStore} from './catalog-store';
import {SqliteToolStore} from './tool-store';
import {queryRowKeys,queryTargetVersion} from './workspace-selection';

/** Availability is a live projection, never a rewrite of frozen historical results. */
export class HistorySourceStore {
 private readonly store:SqliteToolStore;
 constructor(private readonly db:Database){this.store=new SqliteToolStore(db);}
 availability(batchIds:number[]){const rows=this.db.query<{id:number;status:string},[string]>('SELECT id,status FROM batches WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(batchIds));if(rows.length!==new Set(batchIds).size)throw new Error('storage_read_failed');const deletedBatchIds=rows.filter(row=>row.status==='deleted').map(row=>row.id).sort((a,b)=>a-b);return{sourceAvailability:deletedBatchIds.length?'deleted' as const:'available' as const,deletedBatchIds};}
 query(queryId:number,page:number,pageSize:number){
  const query=this.store.readQuery(queryId);if(!query)throw new Error('operation_not_found');
  const {rows,snapshotIds:_s,eventIds:_e,...metadata}=query,offset=(page-1)*pageSize;
  return QueryViewSchema.parse({query:QuerySummarySchema.parse({...metadata,totalRows:rows.length,...this.availability(query.batchIds)}),
   page:{queryId,rows:rows.slice(offset,offset+pageSize),totalRows:rows.length,page,pageSize,warnings:query.warnings,calculationVersion:query.calculationVersion,evidenceIds:this.store.listEvidence(queryId).map(e=>e.id),interpretation:query.interpretation,targetVersion:queryTargetVersion(query),rowKeys:queryRowKeys(query).slice(offset,offset+pageSize)},
   evidence:this.store.listEvidence(queryId).slice(0,BUSINESS_RULES.evidenceSummaryLimit).map(e=>{const{snapshotIds,eventIds,sourceRowRefs:_r,...rest}=e;return EvidenceSummarySchema.parse({...rest,snapshotCount:snapshotIds.length,eventCount:eventIds.length});})});
 }
 evidence(queryId:number,evidenceId:number,page:number,pageSize:number){
  const query=this.query(queryId,1,1).query,record=this.store.readEvidence(evidenceId);if(!record||record.queryId!==queryId||record.calculationVersion!==query.calculationVersion||record.batchIds.some(id=>!query.batchIds.includes(id)))throw new Error('access_denied');
  const {snapshotIds,eventIds,sourceRowRefs:_r,...metadata}=record,availability=this.availability(record.batchIds);
  const rows=availability.sourceAvailability==='deleted'?[]:new SqliteCatalogStore(this.db).readSnapshotsById(snapshotIds);
  if(availability.sourceAvailability==='available'&&(rows.length!==new Set(snapshotIds).size||rows.some(row=>!record.batchIds.includes(row.batchId))))throw new Error('tool_output_inconsistent');
  const byId=new Map(rows.map(row=>[row.id,row])),items=availability.sourceAvailability==='deleted'?[]:snapshotIds.slice((page-1)*pageSize,page*pageSize).map(id=>byId.get(id)!);
  return EvidenceViewSchema.parse({...availability,evidence:EvidenceSummarySchema.parse({...metadata,snapshotCount:snapshotIds.length,eventCount:eventIds.length}),items,targetVersion:queryTargetVersion(query),rowKeys:items.map(row=>`snapshot:${row.id}`),totalRows:snapshotIds.length,page,pageSize});
 }
}
