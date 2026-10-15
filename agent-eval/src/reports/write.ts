import { lstat, realpath, readFile, writeFile, mkdir,rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ExecutionIdSchema, ResolvedRunConfigSchema, type EvaluationReport, type ExecutionSnapshot } from '../types.ts';
import { loadSnapshot, RelativePathSchema } from '../datasets.ts';
import { aggregate } from '../scoring/aggregate.ts';
import {assertJudgeCallMatches,assertCountedJudgeResult} from '../scoring/judges/client.ts';
import {reviewCandidates} from '../review/candidates.ts';
import {deriveReportAnalysis,assertQualityMetricCatalog} from './analysis.ts';
import {projectObservation} from '../scoring/project-observation.ts';
import type {ObservationLike} from '../scoring/types.ts';
import {record} from '../scoring/rules.ts';

export async function executionReportPath(runsRoot:string,executionId:string):Promise<string> {
  const id=ExecutionIdSchema.parse(executionId),matches:string[]=[];
  for(const category of ['business','research']) {
    let path=resolve(runsRoot);
    try {
      for(const part of [category,id,'report.json']) {
        path=join(path,part);const info=await lstat(path);
        if(info.isSymbolicLink())throw new Error('linked_execution_archive');
        if(part==='report.json'?!info.isFile():!info.isDirectory())throw new Error('execution_archive_invalid');
      }
      matches.push(path);
    } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  if(matches.length!==1)throw new Error(matches.length?'execution_id_ambiguous':'execution_report_not_found');
  return matches[0]!;
}

export async function evidencePath(root:string,path:string) {
  RelativePathSchema.parse(path);const base=await realpath(root),target=resolve(base,path),part=relative(base,target);
  if(part==='..'||part.startsWith('..'+sep)||isAbsolute(part))throw new Error('evidence_path_escape');
  let current=base;
  for(const name of part.split(sep)) {current=join(current,name);if((await lstat(current)).isSymbolicLink())throw new Error('linked_evidence_rejected');}
  if(await realpath(target)!==target||!(await lstat(target)).isFile())throw new Error('evidence_not_regular');
  return target;
}
export async function writeFileExclusive(path:string,value:string|Uint8Array) {
  await mkdir(dirname(path),{recursive:true});await writeFile(path,value,{flag:'wx',mode:0o600});
}
export async function writeJsonExclusive(path:string,value:unknown) {await writeFileExclusive(path,JSON.stringify(value,null,2)+'\n');}
export async function replaceJson(path:string,value:unknown) {const temporary=path+'.'+randomUUID()+'.tmp';await writeFileExclusive(temporary,JSON.stringify(value,null,2)+'\n');await rename(temporary,path);}
export function hydrateReport(raw:Omit<EvaluationReport,'snapshot'|'config'>,snapshot:ExecutionSnapshot):EvaluationReport {
  Object.defineProperties(raw,{snapshot:{value:snapshot,enumerable:false},config:{value:snapshot.config,enumerable:false}});
  return raw as EvaluationReport;
}
const scoreStatus=z.enum(['PASS','FAIL','UNJUDGEABLE','ERROR','NOT_RUN']);
const finiteNullable=z.number().finite().nullable();
const ScoreSchema=z.object({trialId:z.string(),caseId:z.string(),metricId:z.string(),version:z.literal('v1'),checkId:z.string(),name:z.string(),method:z.enum(['deterministic','llm-judge']),status:scoreStatus,applicable:z.boolean(),required:z.boolean(),hardConstraint:z.boolean(),unit:z.string(),scope:z.object({kind:z.enum(['trial','run','call','opportunity']),ref:z.string()}),value:finiteNullable,numerator:finiteNullable,denominator:finiteNullable,evidenceRefs:z.array(z.string()),reason:z.string(),missing:z.array(z.string())});
export async function writeReport(root:string,report:EvaluationReport,files:{path:string;sensitivity:'private'|'approved-summary'}[]=[]) {
  if(report.snapshot.qualityMetricCatalog)report.analysis=deriveReportAnalysis(report);
  report.evidenceManifest=[];
  for(const file of files) {const bytes=await readFile(await evidencePath(root,file.path));report.evidenceManifest.push({...file,bytes:bytes.length});}
  await writeJsonExclusive(join(root,'report.json'),report);
  return readReport(root);
}
export async function readReport(location:string):Promise<EvaluationReport> {
  const path=resolve(location),root=path.endsWith('.json')?dirname(path):path;
  const raw=JSON.parse(await readFile(await evidencePath(root,'report.json'),'utf8')) as Omit<EvaluationReport,'snapshot'|'config'>;
  const snapshot=JSON.parse(await readFile(await evidencePath(root,'snapshot.json'),'utf8')) as ExecutionSnapshot;

  if(raw.contract!=='medclaw-evaluation-report/v1'||snapshot.contract!=='medclaw-execution-snapshot/v1'||raw.executionId!==snapshot.executionId||raw.snapshotRef!=='snapshot.json')throw new Error('report_snapshot_identity_mismatch');
  ExecutionIdSchema.parse(raw.executionId);ResolvedRunConfigSchema.parse(snapshot.config);
  if(snapshot.qualityMetricCatalogVersion!==undefined&&!['v1','v2'].includes(snapshot.qualityMetricCatalogVersion))throw new Error('quality_metric_catalog_invalid');
  if(snapshot.qualityMetricCatalog!==undefined)assertQualityMetricCatalog(snapshot.qualityMetricCatalog,snapshot.qualityMetricCatalogVersion??'v1');
  if(!snapshot.compiled)throw new Error('archived_compiled_checks_missing');
  const dataset=loadSnapshot(snapshot.dataset,root,snapshot.compiled);
  if(snapshot.dataset.review.state==='verified'&&!isDeepStrictEqual(snapshot.criteria,snapshot.dataset.review.verifiedData?.criteria))throw new Error('review_criteria_changed');
  const criteria=z.array(z.object({id:z.string(),name:z.string().optional(),version:z.literal('v1'),kind:z.enum(['deterministic','llm-judge']),formula:z.string().min(1),dimension:z.enum(['result','process','safety','infrastructure']),hardConstraint:z.boolean(),unit:z.string(),threshold:z.number().finite(),direction:z.enum(['higher','lower'])})).parse(snapshot.criteria);
  for(const metric of snapshot.qualityMetricCatalog??[]){const criterion=criteria.find(item=>item.id===metric.id);if(criterion&&['version','formula','unit','direction'].some(key=>metric[key as keyof typeof metric]!==criterion[key as keyof typeof criterion]))throw new Error('quality_metric_catalog_criteria_mismatch');}
  if(new Set(criteria.map(criterion=>criterion.id)).size!==criteria.length||criteria.length!==new Set(dataset.cases.flatMap(item=>item.expected.checks.map(check=>check.metricId))).size)throw new Error('report_criteria_mismatch');
  for(const item of dataset.cases)for(const check of item.expected.checks){
    const criterion=criteria.find(criterion=>criterion.id===check.metricId);
    const expected=dataset.gold[item.id]?.values[check.evidenceKey],errorLimit=record(expected)?expected.maxRate:undefined;
    const thresholdMatches=check.metricId==='tool.error_rate'?check.threshold===errorLimit&&check.required===(errorLimit!==undefined):criterion?.threshold===check.threshold;
    if(!criterion||criterion.version!==check.version||criterion.kind!==check.kind||criterion.hardConstraint!==check.hardConstraint||criterion.unit!==check.unit||!thresholdMatches||criterion.direction!==check.direction)throw new Error('report_criteria_mismatch');
  }
  if(!isDeepStrictEqual(raw.dataset,{id:dataset.manifest.id,version:1})||!isDeepStrictEqual(raw.modules,dataset.modules))throw new Error('report_dataset_mismatch');
  const cases=dataset.cases.map(item=>({id:item.id,version:1,name:item.name,category:item.category,evalType:item.evalType,tags:item.tags}));
  if(!isDeepStrictEqual(cases,raw.cases))throw new Error('report_case_metadata_mismatch');
  if(!Array.isArray(raw.plan)||!Array.isArray(raw.trials)||!Array.isArray(raw.scores)||!Array.isArray(raw.evidenceManifest)||!Array.isArray(raw.judgeCalls)||!Number.isFinite(Date.parse(raw.createdAt)))throw new Error('report_contract_invalid');
  if(snapshot.plan!==undefined&&!isDeepStrictEqual(snapshot.plan,raw.plan))throw new Error('snapshot_plan_mismatch');
  if(raw.trials.length!==raw.plan.length||new Set(raw.plan.map(item=>item.trialId)).size!==raw.plan.length||new Set(raw.trials.map(item=>item.trialId)).size!==raw.trials.length||raw.scores.some(score=>!raw.plan.some(item=>item.trialId===score.trialId&&item.caseId===score.caseId)))throw new Error('report_plan_identity_mismatch');
  const paths=new Set<string>();
  const journals=new Map<string,any[]>();
  const observations=new Map<string,ObservationLike>(),semanticConstraints=new Set<string>();
  for(const file of raw.evidenceManifest) {
    if(paths.has(file.path)||!['private','approved-summary'].includes(file.sensitivity))throw new Error('duplicate_or_invalid_evidence');
    paths.add(file.path);const bytes=await readFile(await evidencePath(root,file.path));
    if(bytes.length!==file.bytes)throw new Error('evidence_bytes_mismatch');
    if(file.path.endsWith('.json'))JSON.parse(bytes.toString('utf8'));
    if(file.path.endsWith('.jsonl')) {
      const records=bytes.toString('utf8').split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
      for(const event of records) {if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.kind!=='string'||!event.kind.trim()||typeof event.at!=='string'||!Number.isFinite(Date.parse(event.at)))throw new Error('event_journal_record_invalid');}
      journals.set(file.path,records);
    }
  }
  for(const plan of raw.plan) {
    ExecutionIdSchema.parse(plan.trialId);
    if(!Number.isSafeInteger(plan.repetition)||plan.repetition<1||!dataset.manifest.members.includes(plan.caseId))throw new Error('report_plan_invalid');
    const trial=raw.trials.find(item=>item.trialId===plan.trialId);
    if(!trial)throw new Error('report_trial_missing');
    if(trial.caseId!==plan.caseId||trial.repetition!==plan.repetition||!['completed','cancelled','failed','infra_error','not_run'].includes(trial.status)||trial.status==='not_run'&&trial.startedAt!==null)throw new Error('report_trial_identity_invalid');
    const stateRef='evidence/'+trial.trialId+'/trial.json';if(!paths.has(stateRef))throw new Error('trial_state_reference_missing');
    if(!paths.has('evidence/'+trial.trialId+'/events.jsonl'))throw new Error('event_journal_reference_missing');
    const stored=JSON.parse(await readFile(await evidencePath(root,stateRef),'utf8'));
    const {lifecycle,...state}=stored;
    if(!isDeepStrictEqual({...state,observationRef:state.observationRef==='observation.json'?'evidence/'+trial.trialId+'/observation.json':state.observationRef},trial))throw new Error('report_trial_state_mismatch');
    if(trial.observationRef!==null) {
      if(trial.observationRef!=='evidence/'+trial.trialId+'/observation.json'||!paths.has(trial.observationRef))throw new Error('observation_reference_invalid');
      const observation=JSON.parse(await readFile(await evidencePath(root,trial.observationRef),'utf8'));
      if(observation.executionId!==raw.executionId||observation.trialId!==trial.trialId||observation.instanceId!==trial.instanceId||!Array.isArray(observation.identityChecks)||observation.identityChecks.some((check:any)=>!check.passed))throw new Error('observation_identity_mismatch');
      for(const file of observation.facts?.artifactFiles??[]) {
        const ref='evidence/'+trial.trialId+'/'+file.evidencePath;
        if(file.evidencePath!=='artifacts/'+file.artifactId+'/'+file.relativePath||!paths.has(ref))throw new Error('artifact_reference_invalid');
        const bytes=await readFile(await evidencePath(root,ref));
        if(typeof file.content!=='string'||bytes.length!==file.bytes||!bytes.equals(Buffer.from(file.content)))throw new Error('artifact_content_mismatch');
      }
      observations.set(trial.trialId,{...observation,facts:{...observation.facts,evidenceRoot:join(root,'evidence',trial.trialId)}});
    } else if(trial.status==='completed')throw new Error('completed_trial_missing_observation');
    const task=dataset.cases.find(item=>item.id===plan.caseId)!;
    const scores=raw.scores.filter(score=>score.trialId===plan.trialId);
    if(snapshot.plan!==undefined) {
      const events=journals.get('evidence/'+trial.trialId+'/events.jsonl')!,recorded=events.filter(event=>event.kind==='scoring.completed');
      if(recorded.length!==1||recorded[0].value?.trialId!==trial.trialId||!isDeepStrictEqual(recorded[0].value.scores,scores))throw new Error('scoring_journal_binding_mismatch');
    }
    if(scores.length!==task.expected.checks.length)throw new Error('report_check_coverage_mismatch');
    for(const check of task.expected.checks) {
      const score=scores.find(score=>score.checkId===check.id);if(!score)throw new Error('report_check_missing');
      ScoreSchema.parse(score);
      if(/^(query|diff|export|answer)\./.test(check.metricId)&&!isDeepStrictEqual(score.expected,dataset.gold[task.id]!.values[check.evidenceKey]))throw new Error('report_expected_content_mismatch');
      if(score.method==='llm-judge'&&['task.verify_completion','task.false_completion','evidence.coverage','evidence.valid'].includes(check.metricId)&&!isDeepStrictEqual(score.expected,dataset.gold[task.id]!.values[check.evidenceKey]))throw new Error('report_expected_content_mismatch');
      const criterion=criteria.find(criterion=>criterion.id===check.metricId)!;
      if(score.caseId!==task.id||score.metricId!==check.metricId||score.version!==check.version||score.method!==check.kind||score.required!==check.required||score.hardConstraint!==check.hardConstraint||score.unit!==check.unit||criterion.name!==undefined&&score.name!==criterion.name||trial.status==='not_run'&&score.status!=='NOT_RUN'||score.denominator!==null&&score.denominator<0)throw new Error('report_check_contract_mismatch');
      if(score.details&&typeof score.details==='object'&&'contract' in score.details&&score.details.contract==='medclaw-answer-constraint/v1'){
        if(score.method!=='llm-judge'||score.status!=='FAIL'||!['answer.empty','answer.clarify','answer.refuse'].includes(check.metricId)||!observations.has(trial.trialId))throw new Error('semantic_constraint_binding_mismatch');
        // Verify only the recorded deterministic gate; never rerun Judge or replace archived Scores.
        const projected=await projectObservation(check,{trialId:trial.trialId,caseId:task.id,trialStatus:trial.status,task:{checks:task.expected.checks},gold:dataset.gold[task.id]!,observation:observations.get(trial.trialId)!,input:task});
        const proof=projected?.constraint;
        if(!proof||['status','value','numerator','denominator','reason','evidenceRefs','details'].some(key=>!isDeepStrictEqual(score[key as keyof typeof score],proof[key as keyof typeof proof])))throw new Error('semantic_constraint_binding_mismatch');
        semanticConstraints.add(trial.trialId+':'+check.id);
      }
    }
  }
  if(new Set(raw.judgeCalls.map(call=>call.trialId)).size!==raw.judgeCalls.length)throw new Error('duplicate_judge_call');
  for(const call of raw.judgeCalls) {
    if(!raw.trials.some(trial=>trial.trialId===call.trialId&&trial.startedAt!==null&&trial.status==='completed'))throw new Error('judge_trial_identity_mismatch');
    const metadata=call.result.metadata,judge=snapshot.config.judge;
    assertJudgeCallMatches(judge,metadata);
    const events=journals.get('evidence/'+call.trialId+'/events.jsonl')!;
    const requests=events.filter(event=>event.kind==='judge.request'),results=events.filter(event=>event.kind==='judge.result');
    if(requests.length!==1||results.length!==1||requests[0].value?.trialId!==call.trialId||events.indexOf(requests[0])>=events.indexOf(results[0])||!isDeepStrictEqual(results[0].value,call.result))throw new Error('judge_journal_binding_mismatch');
    const checks=requests[0].value.checks;
    if(!Array.isArray(checks)||!checks.length||new Set(checks.map(check=>check.checkId)).size!==checks.length||checks.some(check=>!raw.scores.some(score=>score.trialId===call.trialId&&score.checkId===check.checkId&&score.method==='llm-judge')||typeof check.rubric!=='string'||!check.rubric.trim()||!Array.isArray(check.evidenceRefs)||!check.evidenceRefs.length)||!Number.isFinite(Date.parse(metadata.startedAt))||!Number.isFinite(Date.parse(metadata.endedAt)))throw new Error('judge_request_contract_invalid');
    for(const check of checks){
      const score=raw.scores.find(score=>score.trialId===call.trialId&&score.checkId===check.checkId)!;
      const counted=score.expected&&typeof score.expected==='object'&&!Array.isArray(score.expected)?(score.expected as Record<string,unknown>).counted:undefined;
      if(!isDeepStrictEqual(check.counted,counted))throw new Error('judge_counted_request_mismatch');
      if(counted&&call.result.status==='completed'){
        const result=call.result.results.find(result=>result.checkId===check.checkId);if(!result)throw new Error('judge_counted_result_missing');
        assertCountedJudgeResult(result,check.counted);
        if(score.numerator!==(result.numerator??null)||score.denominator!==(result.denominator??check.counted.denominator??null))throw new Error('judge_counted_score_mismatch');
      }
    }
  }
  if(raw.scores.some(score=>score.method==='llm-judge'&&['PASS','FAIL'].includes(score.status)&&!semanticConstraints.has(score.trialId+':'+score.checkId)&&!raw.judgeCalls.some(call=>call.trialId===score.trialId&&call.result.results.some(result=>result.checkId===score.checkId&&result.value===score.value))))throw new Error('judge_score_binding_missing');
  const aggregation=aggregate(raw.plan,raw.trials,raw.scores,raw.cases,criteria);
  if(!isDeepStrictEqual(raw.aggregation,aggregation)||!isDeepStrictEqual(raw.totals,aggregation.totals))throw new Error('report_aggregation_mismatch');
  if(raw.analysis!==undefined&&!isDeepStrictEqual(raw.analysis,deriveReportAnalysis({...raw,snapshot})))throw new Error('report_analysis_mismatch');
  const candidates=reviewCandidates(snapshot.dataset.info.reviewPolicy,raw.trials.map(trial=>({trialId:trial.trialId,caseId:trial.caseId,risks:dataset.cases.find(item=>item.id===trial.caseId)!.risks,scores:raw.scores.filter(score=>score.trialId===trial.trialId)})));
  if(!isDeepStrictEqual(raw.reviewCandidates,candidates))throw new Error('report_review_candidates_mismatch');
  return hydrateReport(raw,snapshot);
}
