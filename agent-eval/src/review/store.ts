import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { dirname,join,resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readReport,writeJsonExclusive,replaceJson,evidencePath } from '../reports/write.ts';
import { acquireEvaluationWriteLock } from '../reports/write-lock.ts';
import { assertSafeExport } from '../langfuse/map.ts';
import {reviewCandidates} from './candidates.ts';
import {ensureExport,inspectExport,PlatformReceiptSaveError} from '../langfuse/export.ts';
export const FeedbackSchema=z.strictObject({contract:z.literal('medclaw-human-feedback/v1'),source:z.enum(['local','langfuse']),sourceId:z.string().min(1).max(200),reviewer:z.string().trim().min(1).max(200),reviewedAt:z.iso.datetime(),executionId:z.string().min(1),caseId:z.string().min(1),trialId:z.string().min(1),status:z.enum(['PASS','FAIL','UNJUDGEABLE']),comment:z.string().trim().min(1).max(4000),evidenceRefs:z.array(z.string())});
export type HumanFeedback=z.infer<typeof FeedbackSchema>;
export interface ReviewDocument {contract:'medclaw-review/v1';executionId:string;feedback:{id:string;value:HumanFeedback}[];conflicts:HumanFeedback[];queues:Record<string,unknown>;receipts:unknown[]}
const rootOf=(path:string)=>path.endsWith('.json')?dirname(resolve(path)):resolve(path);
export async function readReview(reportPath:string):Promise<ReviewDocument> {
  const report=await readReport(reportPath),root=rootOf(reportPath);
  try {const document=JSON.parse(await readFile(await evidencePath(root,'review.json'),'utf8'));if(document.contract!=='medclaw-review/v1'||document.executionId!==report.executionId||!Array.isArray(document.feedback)||!Array.isArray(document.conflicts)||!document.queues||!Array.isArray(document.receipts))throw new Error('review_binding_invalid');return document;}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    let platform:{queues:Record<string,unknown>;receipts:unknown[]}|undefined;
    try{await evidencePath(root,'export.json');platform=(await inspectExport(reportPath)).document.review;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    return {contract:'medclaw-review/v1',executionId:report.executionId,feedback:[],conflicts:[],queues:platform?.queues??{},receipts:platform?.receipts??[]};
  }
}
export async function updateReview<T>(reportPath:string,update:(document:ReviewDocument)=>Promise<T>|T):Promise<T> {
  const root=rootOf(reportPath),release=await acquireEvaluationWriteLock(root,'review');
  let pendingSave:PlatformReceiptSaveError|undefined;
  try{
    const document=await readReview(reportPath),result=await update(document);
    if(document.feedback.length||document.conflicts.length)await replaceJson(join(root,'review.json'),document);
    else {
      const releaseExport=await acquireEvaluationWriteLock(root,'export');
      try{const {document:exported}=await ensureExport(reportPath);exported.review={queues:document.queues,receipts:document.receipts};await replaceJson(join(root,'export.json'),exported);}finally{try{await releaseExport();}catch{throw new PlatformReceiptSaveError(releaseExport);}}
    }
    return result;
  }catch(error){if(error instanceof PlatformReceiptSaveError)pendingSave=error;throw error;}
  finally{
    try{await release();}
    catch{const save=pendingSave?.retrySave;throw new PlatformReceiptSaveError(async()=>{await release();await save?.();});}
  }
}
export async function recordFeedback(reportPath:string,input:unknown):Promise<{state:'recorded'|'duplicate';id:string}> {
  const feedback=FeedbackSchema.parse(input),report=await readReport(reportPath);assertSafeExport(feedback);
  if(feedback.executionId!==report.executionId||!report.plan.some(item=>item.trialId===feedback.trialId&&item.caseId===feedback.caseId))throw new Error('feedback_identity_mismatch');
  let conflict=false;
  const result=await updateReview(reportPath,document=>{
    const updateCandidates=()=>{
      const candidates=reviewCandidates(report.snapshot.dataset.info.reviewPolicy,report.trials.map(trial=>({trialId:trial.trialId,caseId:trial.caseId,risks:report.snapshot.dataset.cases.find(item=>item.id===trial.caseId)!.risks,scores:report.scores.filter(score=>score.trialId===trial.trialId)})),[...document.feedback.map(item=>item.value),...document.conflicts]);
      const policy=report.snapshot.dataset.info.reviewPolicy as {triggers?:string[]}|undefined;
      if(policy?.triggers?.includes('disputed'))for(const conflict of document.conflicts){let candidate=candidates.find(item=>item.trialId===conflict.trialId&&item.caseId===conflict.caseId);if(!candidate){candidate={trialId:conflict.trialId,caseId:conflict.caseId,reasons:[],checkIds:[],evidenceRefs:[]};candidates.push(candidate);}if(!candidate.reasons.includes('disputed'))candidate.reasons.push('disputed');candidate.evidenceRefs=[...new Set([...candidate.evidenceRefs,...conflict.evidenceRefs])];}
      document.queues.reviewCandidates=candidates;
    };
    const existing=document.feedback.find(item=>item.value.source===feedback.source&&item.value.sourceId===feedback.sourceId);
    if(existing){if(isDeepStrictEqual(existing.value,feedback))return {state:'duplicate' as const,id:existing.id};document.conflicts.push(feedback);updateCandidates();conflict=true;return {state:'duplicate' as const,id:existing.id};}
    const id=randomUUID();document.feedback.push({id,value:feedback});updateCandidates();return {state:'recorded' as const,id};
  });
  if(conflict)throw new Error('feedback_conflict_preserved');return result;
}
export async function listFeedback(reportPath:string):Promise<HumanFeedback[]> {
  const report=await readReport(reportPath),document=await readReview(reportPath);
  return document.feedback.map(item=>{const value=FeedbackSchema.parse(item.value);if(value.executionId!==report.executionId||!report.plan.some(trial=>trial.trialId===value.trialId&&trial.caseId===value.caseId))throw new Error('feedback_identity_mismatch');return value;});
}
