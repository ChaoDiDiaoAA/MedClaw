import { readFile,mkdir,writeFile,appendFile } from 'node:fs/promises';
import { resolve,dirname,join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { JudgeClient,readJudgeConfig } from './client.ts';
import { ANSWER_QUALITY_RUBRIC } from './answer-quality.ts';
import { evidencePath,writeJsonExclusive } from '../../reports/write.ts';
import { assertNoDatasetHashes } from '../../data-format.ts';
import { ExecutionIdSchema } from '../../types.ts';
export interface CalibrationSample {
  id: string; partition: 'tune' | 'validation'; sourceId: string;
  reference: { checker: string; method: string; checkedAt: string; recordRef: string; sourceRef: string; value: number | null; severe: boolean; evidenceRefs: string[] } | null;
  judgeValue: number | null; judgeEvidenceRefs?: string[];
}
export function assessCalibration(samples: CalibrationSample[], limits: { maxFalseAccept: number; maxFalseReject: number; maxSevereMiss: number }) {
  if (!samples.length || new Set(samples.map(x => x.id)).size !== samples.length) throw new Error('Calibration samples must have unique identities');
  for (const value of Object.values(limits)) if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid calibration threshold');
  for (const sample of samples) {
    const h = sample.reference;
    if (!h || !h.checker.trim() || !h.method.trim() || !Number.isFinite(Date.parse(h.checkedAt)) || !h.recordRef.trim() || !h.sourceRef.trim() || !sample.sourceId.trim() || !h.evidenceRefs.length || !h.evidenceRefs.every(x => x.trim()) || h.value !== null && ![0, .5, 1].includes(h.value) || sample.judgeValue !== null && ![0, .5, 1].includes(sample.judgeValue)) throw new Error('Independently verified reference, source and fixed rubric values are required');
  }
  const tuneSources = new Set(samples.filter(x => x.partition === 'tune').map(x => x.sourceId));
  const validation = samples.filter(x => x.partition === 'validation');
  if (!validation.length) throw new Error('Held-out validation references are required');
  if (validation.some(x => tuneSources.has(x.sourceId))) throw new Error('Calibration tune/validation source overlap');
  const rejected = validation.filter(x => x.reference!.value !== null && x.reference!.value < 1);
  const accepted = validation.filter(x => x.reference!.value === 1);
  const severe = validation.filter(x => x.reference!.severe);
  const falseAccept = rejected.filter(x => x.judgeValue === 1).length;
  const falseReject = accepted.filter(x => x.judgeValue !== null && x.judgeValue < 1).length;
  const severeMiss = severe.filter(x => x.judgeValue === 1).length;
  const rate = (n: number, d: number) => d ? n / d : null;
  const rates = { falseAccept: rate(falseAccept, rejected.length), falseReject: rate(falseReject, accepted.length), severeMiss: rate(severeMiss, severe.length) };
  const unknown = validation.filter(x => x.judgeValue === null || x.reference!.value === null).length;
  const evidenceChecked = validation.filter(x => x.judgeEvidenceRefs !== undefined);
  const evidenceCorrect = evidenceChecked.filter(x => x.judgeEvidenceRefs!.length > 0 && x.judgeEvidenceRefs!.every(ref => x.reference!.evidenceRefs.includes(ref))).length;
  return { validation: validation.length, tune: samples.length - validation.length, falseAccept, falseReject, severeMiss, unknown, rates,
    evidenceChecked: evidenceChecked.length, evidenceCorrect, referenceIds: validation.map(x => x.id),
    passed: samples.some(x => x.partition === 'tune') && unknown === 0 && evidenceChecked.length === validation.length && evidenceCorrect === validation.length && rates.falseAccept !== null && rates.falseReject !== null && rates.severeMiss !== null && rates.falseAccept <= limits.maxFalseAccept && rates.falseReject <= limits.maxFalseReject && rates.severeMiss <= limits.maxSevereMiss };
}

const marker=z.string().min(1).max(10000);
const judgement=z.union([z.literal(0),z.literal(.5),z.literal(1),z.null()]);
export const ReferenceSchema=z.strictObject({contract:z.literal('medclaw-judge-calibration-references/v1'),rubricVersion:z.literal('v1'),limits:z.strictObject({maxFalseAccept:z.number().min(0).max(1),maxFalseReject:z.number().min(0).max(1),maxSevereMiss:z.number().min(0).max(1)}),samples:z.array(z.strictObject({id:ExecutionIdSchema,partition:z.enum(['tune','validation']),sourceId:marker,answer:marker,rubric:marker,evidence:z.array(z.strictObject({ref:marker,path:marker})).min(1),reference:z.strictObject({path:marker})})).min(1)});
export const VerifiedReferenceSchema=z.strictObject({contract:z.literal('medclaw-judge-reference/v1'),state:z.literal('verified'),sampleId:marker,sourceId:marker,verification:z.strictObject({checker:marker,method:z.enum(['independent-recomputation','source-audit','programmatic-check','agent-audit','human-review']),checkedAt:z.iso.datetime()}),rubricVersion:z.literal('v1'),sample:z.strictObject({id:marker,sourceId:marker,answer:marker,rubric:marker,evidence:z.record(marker,z.string())}),sourceRef:marker,evidenceRefs:z.array(marker).min(1),value:judgement,severe:z.boolean()});
export async function calibrateReferences(args:{referencesPath:string;executionId:string;outputPath:string;env:Record<string,string|undefined>;signal?:AbortSignal;controlledFixture?:boolean}) {
  ExecutionIdSchema.parse(args.executionId);
  const referencePath=resolve(args.referencesPath),base=dirname(referencePath),references=ReferenceSchema.parse(JSON.parse(await readFile(referencePath,'utf8')));
  assertNoDatasetHashes(references);
  const prepared=[];
  for(const item of references.samples) {
    if(new Set(item.evidence.map(entry=>entry.ref)).size!==item.evidence.length)throw new Error('duplicate_calibration_evidence');
    const evidence:Record<string,string>={};
    for(const entry of item.evidence) {const bytes=await readFile(await evidencePath(base,entry.path));if(bytes.length>256*1024)throw new Error('calibration_evidence_too_large');evidence[entry.ref]=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
    const reference=VerifiedReferenceSchema.parse(JSON.parse(await readFile(await evidencePath(base,item.reference.path),'utf8')));
    const sample={id:item.id,sourceId:item.sourceId,answer:item.answer,rubric:item.rubric,evidence};
    if(!isDeepStrictEqual(reference.sample,sample)||reference.sampleId!==item.id||reference.sourceId!==item.sourceId||!item.evidence.some(entry=>entry.ref===reference.sourceRef)||reference.evidenceRefs.some(ref=>!Object.hasOwn(evidence,ref)))throw new Error('calibration_review_content_mismatch');
    assertNoDatasetHashes(reference);assertNoDatasetHashes(evidence);
    prepared.push({sample:{...sample,partition:item.partition},reference:{...reference.verification,recordRef:'evidence/'+item.id+'/trial.json',sourceRef:reference.sourceRef,value:reference.value,severe:reference.severe,evidenceRefs:reference.evidenceRefs}});
  }
  const contentSources=new Set(prepared.filter(item=>item.sample.partition==='tune').flatMap(item=>Object.values(item.sample.evidence)));
  if(prepared.some(item=>item.sample.partition==='validation'&&Object.values(item.sample.evidence).some(content=>contentSources.has(content))))throw new Error('calibration_tune_validation_content_overlap');
  const empty=prepared.map(item=>({id:item.sample.id,sourceId:item.sample.sourceId,partition:item.sample.partition,reference:item.reference,judgeValue:null}));
  assessCalibration(empty,references.limits);
  const config=readJudgeConfig(args.env,'required',true)!;
  if(JSON.stringify(prepared).includes(config.apiKey))throw new Error('calibration_credential_boundary');
  const client=await JudgeClient.create(config,{plannedTrials:prepared.length,trialIds:prepared.map(item=>item.sample.id)});
  const root=resolve(args.outputPath);await mkdir(dirname(root),{recursive:true});await mkdir(root);
  const snapshot={contract:'medclaw-calibration-snapshot/v1',executionId:args.executionId,rubricVersion:references.rubricVersion,systemRubric:ANSWER_QUALITY_RUBRIC,judge:client.configuration,limits:references.limits,model:config.model,samples:prepared.map(item=>item.sample)};
  await writeJsonExclusive(join(root,'snapshot.json'),snapshot);
  const samples=[];
  for(const item of prepared) {
    const path=join(root,'evidence',item.sample.id);await mkdir(path,{recursive:true});
    const request={trialId:item.sample.id,checks:[{checkId:item.sample.id,rubric:item.sample.rubric,evidenceRefs:Object.keys(item.sample.evidence)}],answer:item.sample.answer,evidence:item.sample.evidence};
    await writeJsonExclusive(join(path,'trial.json'),{sample:item.sample,reference:item.reference,request});
    await writeFile(join(path,'events.jsonl'),JSON.stringify({kind:'judge.request',at:new Date().toISOString(),request})+'\n',{flag:'wx',mode:0o600});
    const result=await client.judge(request,args.signal);
    await writeJsonExclusive(join(path,'observation.json'),{request,result});
    await appendFile(join(path,'events.jsonl'),JSON.stringify({kind:'judge.result',at:new Date().toISOString(),result})+'\n');
    const judged=result.results.find(check=>check.checkId===item.sample.id);
    samples.push({id:item.sample.id,sourceId:item.sample.sourceId,partition:item.sample.partition,reference:item.reference,judgeValue:judged?.value??null,judgeEvidenceRefs:judged?.evidenceRefs??[]});
  }
  const assessment=assessCalibration(samples,references.limits),report={contract:'medclaw-judge-calibration/v1',executionId:args.executionId,actualRun:args.controlledFixture!==true,controlledFixture:args.controlledFixture===true,createdAt:new Date().toISOString(),model:config.model,assessment,passed:assessment.passed};
  await writeJsonExclusive(join(root,'report.json'),report);
  try{
    const {writeBadcases}=await import('../../reports/badcases.ts'),index=await writeBadcases(join(root,'report.json'));
    console.error(`[诊断] 校准候选 ${index.summary.candidates}；sample ${index.summary.samples}；诊断缺口 ${index.gaps.length}；需核验后确认根因`);
    if(!index.candidates.length&&!index.commonEvents.length&&!index.gaps.length)console.error('[诊断] 候选、共同事件和诊断缺口均为空；无诊断文件需要保存');
    else console.error(`[诊断入口] ${join(root,'badcases.json')}\n[诊断入口] ${join(root,'badcases.md')}`);
  }catch{console.error('[诊断] 分析文件保存失败；原校准报告已保留');throw new Error('badcase_artifacts_failed');}
  return report;
}
