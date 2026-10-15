import { readFile } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { evidencePath } from '../../reports/write.ts';
import { assessCalibration } from './calibration.ts';
import {ANSWER_QUALITY_RUBRIC} from './answer-quality.ts';
import {ExecutionIdSchema} from '../../types.ts';
import {JudgeConfigurationSchema} from '../../types.ts';
import {assertJudgeCallMatches} from './client.ts';
export const confinedFile=evidencePath;
export async function readCalibration(path:string) {
  const root=path.endsWith('.json')?dirname(resolve(path)):resolve(path);
  const report=JSON.parse(await readFile(await evidencePath(root,'report.json'),'utf8'));
  const snapshot=JSON.parse(await readFile(await evidencePath(root,'snapshot.json'),'utf8'));

  if(report.contract!=='medclaw-judge-calibration/v1'||snapshot.contract!=='medclaw-calibration-snapshot/v1'||report.executionId!==snapshot.executionId||report.actualRun!==true||report.controlledFixture===true)throw new Error('real_calibration_required');
  if(snapshot.rubricVersion!=='v1'||snapshot.systemRubric!==ANSWER_QUALITY_RUBRIC||report.model!==snapshot.model||report.passed!==true||!Array.isArray(snapshot.samples))throw new Error('calibration_rubric_mismatch');
  const judge=JudgeConfigurationSchema.parse(snapshot.judge);if(judge.model!==snapshot.model)throw new Error('calibration_judge_mismatch');
  const tuneContents=new Set(snapshot.samples.filter((item:any)=>item.partition==='tune').flatMap((item:any)=>Object.values(item.evidence)));
  if(snapshot.samples.some((item:any)=>item.partition==='validation'&&Object.values(item.evidence).some(content=>tuneContents.has(content))))throw new Error('calibration_tune_validation_content_overlap');
  const samples=[];
  for(const item of snapshot.samples) {
    ExecutionIdSchema.parse(item.id);
    const record=JSON.parse(await readFile(await evidencePath(root,'evidence/'+item.id+'/trial.json'),'utf8'));
    const result=JSON.parse(await readFile(await evidencePath(root,'evidence/'+item.id+'/observation.json'),'utf8'));

    const metadata=result.result.metadata;
    assertJudgeCallMatches(judge,metadata);
    const journal=(await readFile(await evidencePath(root,'evidence/'+item.id+'/events.jsonl'),'utf8')).split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));

    if(journal.length!==2||journal[0].kind!=='judge.request'||journal[1].kind!=='judge.result'||journal.some(event=>!Number.isFinite(Date.parse(event.at)))||!isDeepStrictEqual(journal[0].request,record.request)||!isDeepStrictEqual(journal[1].result,result.result))throw new Error('calibration_journal_mismatch');
    if(!Object.hasOwn(item.evidence,record.reference.sourceRef)||record.reference.evidenceRefs.some((ref:string)=>!Object.hasOwn(item.evidence,ref)))throw new Error('calibration_reference_binding_invalid');
    const expectedRequest={trialId:item.id,checks:[{checkId:item.id,rubric:item.rubric,evidenceRefs:Object.keys(item.evidence)}],answer:item.answer,evidence:item.evidence};
    if(!isDeepStrictEqual(record.request,expectedRequest)||result.result.metadata.model!==snapshot.model||result.result.results.length!==1||result.result.results[0].checkId!==item.id)throw new Error('calibration_request_content_mismatch');
    if(!isDeepStrictEqual(record.sample,item)||!isDeepStrictEqual(record.request,result.request)||result.result.status!=='completed'||!Number.isFinite(Date.parse(result.result.metadata.startedAt))||!Number.isFinite(Date.parse(result.result.metadata.endedAt)))throw new Error('calibration_call_binding_invalid');
    const judged=result.result.results.find((check:any)=>check.checkId===item.id);
    samples.push({id:item.id,partition:item.partition,sourceId:item.sourceId,reference:record.reference,judgeValue:judged?.value??null,judgeEvidenceRefs:judged?.evidenceRefs??[]});
  }
  const assessment=assessCalibration(samples,snapshot.limits);
  if(!assessment.passed||!isDeepStrictEqual(report.assessment,assessment))throw new Error('calibration_not_passed');
  return {root,report,snapshot};
}
