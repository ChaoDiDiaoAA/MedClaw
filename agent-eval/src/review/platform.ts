import { z } from 'zod';
import { readReport } from '../reports/write.ts';
import { platformRequest,ensureExport,type PlatformConfig } from '../langfuse/export.ts';
import { assertSafeExport } from '../langfuse/map.ts';
import { readReview,updateReview,listFeedback,recordFeedback } from './store.ts';

const QueueConfigSchema=z.strictObject({name:z.string().min(1),scoreConfigIds:z.array(z.string().min(1)).min(1)});
export async function setupReview(input:unknown,config:PlatformConfig):Promise<unknown> {
  const request=QueueConfigSchema.parse(input);assertSafeExport(request);
  const response=await platformRequest(config,'/api/public/annotation-queues','POST',request) as {id?:unknown};
  if(typeof response.id!=='string')throw new Error('review_setup_receipt_invalid');return response;
}
export async function enqueueReview(reportPath:string,queueId:string,config:PlatformConfig):Promise<unknown> {
  if(!queueId.trim())throw new Error('review_queue_id_invalid');
  const report=await readReport(reportPath),{document}=await ensureExport(reportPath);
  const current=await readReview(reportPath),candidates=[...report.reviewCandidates,...(Array.isArray(current.queues.reviewCandidates)?current.queues.reviewCandidates:[])];
  const traces=report.trials.filter(trial=>trial.startedAt&&trial.observationRef&&candidates.some(candidate=>candidate.trialId===trial.trialId&&candidate.caseId===trial.caseId)).map(trial=>{
    const key=JSON.stringify(['medclaw-trace/v1',[report.executionId,trial.trialId]]),traceId=document.envelope.identities[key];
    if(!traceId)throw new Error('review_trace_binding_missing');return {trialId:trial.trialId,traceId};
  });
  const boundTraces=await updateReview(reportPath,review=>{
    const prior=review.queues[queueId] as {queueId?:string;traces?:{trialId:string;traceId:string}[]}|undefined;
    if(prior&&(prior.queueId!==queueId||!Array.isArray(prior.traces)))throw new Error('review_queue_binding_conflict');
    const merged=new Map<string,{trialId:string;traceId:string}>();
    for(const trace of [...prior?.traces??[],...traces]){
      const expected=document.envelope.identities[JSON.stringify(['medclaw-trace/v1',[report.executionId,trace.trialId]])];
      if(!report.plan.some(trial=>trial.trialId===trace.trialId)||trace.traceId!==expected||merged.has(trace.trialId)&&merged.get(trace.trialId)!.traceId!==trace.traceId)throw new Error('review_queue_binding_conflict');
      merged.set(trace.trialId,trace);
    }
    const bound=[...merged.values()];review.queues[queueId]={queueId,traces:bound};return bound;
  });
  const ids=new Set<string>();
  for(let page=1;;page++) {
    const response=await platformRequest(config,'/api/public/annotation-queues/'+encodeURIComponent(queueId)+'/items?page='+page+'&limit=100','GET') as any;
    if(!Array.isArray(response.data)||!Number.isSafeInteger(response.meta?.totalPages)||response.meta.totalPages<0||page>10000)throw new Error('review_queue_page_invalid');
    response.data.filter((item:any)=>item.objectType==='TRACE').forEach((item:any)=>ids.add(item.objectId));
    if(page>=response.meta.totalPages)break;
  }
  const receipts:{trialId:string;objectId:string;duplicate:boolean}[]=[];
  for(const trace of boundTraces) {
    const duplicate=ids.has(trace.traceId);
    if(!duplicate){const response=await platformRequest(config,'/api/public/annotation-queues/'+encodeURIComponent(queueId)+'/items','POST',{objectId:trace.traceId,objectType:'TRACE'}) as any;if(response.objectId!==trace.traceId)throw new Error('review_enqueue_receipt_invalid');}
    receipts.push({trialId:trace.trialId,objectId:trace.traceId,duplicate});
  }
  await updateReview(reportPath,review=>{review.receipts.push({kind:'enqueue',queueId,at:new Date().toISOString(),receipts});});return {queueId,receipts};
}
export async function importReview(reportPath:string,queueId:string,config:PlatformConfig):Promise<unknown> {
  const report=await readReport(reportPath),review=await readReview(reportPath),binding=review.queues[queueId] as any;
  if(binding?.queueId!==queueId||!Array.isArray(binding.traces))throw new Error('review_queue_binding_conflict');
  const results=[],cursors=new Set<string>();let cursor:string|null=null;
  do {
    const query=new URLSearchParams({source:'ANNOTATION',queueId,fields:'details,subject,annotation',limit:'100',environment:report.config.environment});if(cursor)query.set('cursor',cursor);
    const response=await platformRequest(config,'/api/public/v3/scores?'+query,'GET') as any;
    if(!Array.isArray(response.data)||!response.meta)throw new Error('review_import_page_invalid');
    for(const score of response.data) {
      const traceId=score.subject?.kind==='trace'?score.subject.id:score.subject?.traceId,bound=binding.traces.find((item:any)=>item.traceId===traceId);
      if(!bound)continue;
      const trial=report.trials.find(item=>item.trialId===bound.trialId);if(!trial||score.source!=='ANNOTATION'||typeof score.authorUserId!=='string'||!score.authorUserId)throw new Error('review_import_provenance_missing');
      results.push(await recordFeedback(reportPath,{contract:'medclaw-human-feedback/v1',source:'langfuse',sourceId:score.id,reviewer:score.authorUserId,reviewedAt:score.timestamp,executionId:report.executionId,caseId:trial.caseId,trialId:trial.trialId,status:score.value,comment:score.comment,evidenceRefs:[]}));
    }
    cursor=response.meta.nextCursor??null;if(cursor&&cursors.has(cursor))throw new Error('review_import_cursor_loop');if(cursor)cursors.add(cursor);
  }while(cursor);
  return {imported:results};
}
export async function syncReview(reportPath:string,config:PlatformConfig):Promise<unknown> {
  const report=await readReport(reportPath),{document}=await ensureExport(reportPath),feedback=await listFeedback(reportPath),receipts:{id:string;state:string;receivedAt:string}[]=[];
  for(const item of feedback.filter(item=>item.source==='local')) {
    const traceId=document.envelope.identities[JSON.stringify(['medclaw-trace/v1',[report.executionId,item.trialId]])];if(!traceId)throw new Error('review_trace_binding_missing');
    const id=(await readReview(reportPath)).feedback.find(record=>record.value.source===item.source&&record.value.sourceId===item.sourceId)!.id;
    const payload={id,traceId,name:'human.review',value:item.status,dataType:'CATEGORICAL',comment:item.comment,environment:report.config.environment,metadata:{executionId:report.executionId,trialId:item.trialId,caseId:item.caseId,reviewer:item.reviewer,reviewedAt:item.reviewedAt}};
    assertSafeExport(payload);const response=await platformRequest(config,'/api/public/scores','POST',payload) as any;if(response.id!==id)throw new Error('review_sync_receipt_invalid');receipts.push({id,state:'accepted',receivedAt:new Date().toISOString()});
  }
  await updateReview(reportPath,review=>{review.receipts.push({kind:'sync',receipts});});return {receipts};
}
