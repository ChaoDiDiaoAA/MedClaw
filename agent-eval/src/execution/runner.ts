import { mkdir,open,unlink,writeFile,readFile,stat,readdir,appendFile } from 'node:fs/promises';
import { join,resolve,relative } from 'node:path';
import { loadDataset,snapshotCompiled } from '../datasets.ts';
import {reviewCandidates} from '../review/candidates.ts';
import { runTrial } from './trial.ts';
import { evaluate } from '../scoring/evaluate.ts';
import { aggregate } from '../scoring/aggregate.ts';
import {scoringCriteria} from '../scoring/registry.ts';
import type { Judge,JudgeResult,EvaluationScore } from '../scoring/types.ts';
import { ExecutionIdSchema,ResolvedRunConfigSchema,type AgentModelCredential,type TrialPlan,type TrialResult,type EvaluationReport,type ResolvedRunConfig,type ExecutionSnapshot } from '../types.ts';
import { writeJsonExclusive,writeReport,hydrateReport } from '../reports/write.ts';
import {writeBadcases} from '../reports/badcases.ts';
import { sourceInventory,runBlockers } from '../doctor.ts';
import { assertSafeExport } from '../langfuse/map.ts';
import { projectPublicEvidence } from '../data-format.ts';
import {assertJudgeMatches} from '../scoring/judges/client.ts';
import {trialProgress,type ProgressEvent} from './progress.ts';
import {qualityMetricCatalog} from '../scoring/registry.ts';
import {deriveCaseAnalysis} from '../reports/analysis.ts';

const unsafeTrial=(trial:TrialResult)=>Boolean(trial.startedAt&&(trial.stopped!==true||trial.closed!==true))||['necessary_save_unconfirmed','trial_exception_stop_unknown','host_stop_unconfirmed'].includes(trial.reason??'');
export function parseTrials(value:string|undefined,selection:'smoke'|'full'):number {
  if(value===undefined)return selection==='smoke'?1:3;
  if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1)throw new Error('trials_must_be_a_positive_decimal_integer');
  return Number(value);
}
export function planTrials(caseIds:string[],trials:number):TrialPlan[] {
  if(!caseIds.length||new Set(caseIds).size!==caseIds.length||!Number.isSafeInteger(trials)||trials<1||!Number.isSafeInteger(caseIds.length*trials)||caseIds.length*trials>0xffffffff)throw new Error('trial_plan_invalid');
  caseIds.forEach(id=>ExecutionIdSchema.parse(id));
  return caseIds.flatMap(caseId=>Array.from({length:trials},(_,i)=>({caseId,repetition:i+1,trialId:ExecutionIdSchema.parse(caseId+'-r'+(i+1))})));
}
export async function executePlan(plan:TrialPlan[],run:(item:TrialPlan)=>Promise<TrialResult>,options:{signal?:AbortSignal;blockers?:string[];onProgress?:(trial:TrialResult)=>void|Promise<void>}={}) {
  const trials:TrialResult[]=[];let unsafe=false;
  for(const item of plan) {
    const reason=unsafe?'previous_trial_stop_or_save_unconfirmed':options.signal?.aborted?'execution_cancelled_before_start':options.blockers?.length?options.blockers.join(';'):null;
    let trial:TrialResult;
    if(reason)trial={...item,status:'not_run',instanceId:null,startedAt:null,endedAt:null,reason,stopped:null,closed:null,observation:null};
    else {try{trial=await run(item);}catch{trial={...item,status:'infra_error',instanceId:null,startedAt:null,endedAt:new Date().toISOString(),reason:'trial_exception_stop_unknown',stopped:null,closed:null,observation:null};unsafe=true;}if(unsafeTrial(trial))unsafe=true;}
    trials.push(trial);await options.onProgress?.(trial);
  }
  return trials;
}
export interface RunOptions {
  datasetRoot:string;runsRoot:string;executionId:string;selection:'smoke'|'full';trials:number;
  config:ResolvedRunConfig;modelCredential?:AgentModelCredential;judgeMode:'required'|'off';judge?:Judge;signal?:AbortSignal;
  onProgress?:(trial:TrialResult)=>void;controlledFixture?:boolean;
  onEvent?:(event:ProgressEvent)=>void;
}
export async function runExperiment(options:RunOptions):Promise<EvaluationReport> {
  ExecutionIdSchema.parse(options.executionId);const config=ResolvedRunConfigSchema.parse(options.config);assertSafeExport(config);
  const dataset=await loadDataset(options.datasetRoot);
  if(dataset.cases.some(item=>!item.steps.length))throw new Error('execution_archive_read_only');
  const members=options.selection==='smoke'?dataset.manifest.smoke:dataset.manifest.members;
  if(dataset.manifest.id==='medclaw-agent-v1'&&members.length!==(options.selection==='full'?50:10))throw new Error('benchmark_members_must_be_smoke10_or_full50');
  const plan=planTrials(members,options.trials);
  const judged=plan.filter(trial=>dataset.cases.find(item=>item.id===trial.caseId)!.expected.checks.some(check=>check.kind==='llm-judge'));
  if(options.judgeMode!=='off'&&judged.length&&options.judge)assertJudgeMatches(config.judge,options.judge.configuration);
  const root=resolve(options.runsRoot);await mkdir(root,{recursive:true});
  const lockPath=join(root,'.active-execution.json'),lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({executionId:options.executionId,pid:process.pid}));await lock.close();
  let keepLock=false;
  try {
    const executionRoot=join(root,options.executionId);await mkdir(executionRoot);
    const source=await sourceInventory();
    const criteria=scoringCriteria(dataset.cases.flatMap(item=>item.expected.checks.map(check=>check.metricId)));
    const snapshot:ExecutionSnapshot={contract:'medclaw-execution-snapshot/v1',executionId:options.executionId,dataset:dataset.snapshot,compiled:snapshotCompiled(dataset),config,criteria,source,plan,preparationTurns:Object.fromEntries(dataset.cases.map(task=>[task.id,task.steps.filter(step=>step.action.action==='send'&&step.action.alias.startsWith('prepare-')).length]))};
    snapshot.qualityMetricCatalogVersion='v2';snapshot.qualityMetricCatalog=qualityMetricCatalog('v2');
    await writeJsonExclusive(join(executionRoot,'snapshot.json'),snapshot);
    const blockers=runBlockers(dataset,source,config,{required:options.judgeMode==='required'&&judged.length>0,configured:!!options.judge});
    keepLock=true;
    const scores:EvaluationScore[]=[],judgeCalls:{trialId:string;result:JudgeResult}[]=[];
    const savedTrials:TrialResult[]=[],summarizedCases=new Set<string>();
    const cases=dataset.cases.map(item=>({id:item.id,version:1 as const,name:item.name,category:item.category,evalType:item.evalType,tags:item.tags}));
    const evidenceFiles:{path:string;sensitivity:'private'}[]=[];
    const progress=new Map<string,ReturnType<typeof trialProgress>>();
    const forTrial=(item:TrialPlan)=>{
      let value=progress.get(item.trialId);
      if(!value){value=trialProgress(item,plan.findIndex(trial=>trial.trialId===item.trialId)+1,plan.length,event=>options.onEvent?.({...event,trialsPerCase:plan.filter(trial=>trial.caseId===item.caseId).length}));progress.set(item.trialId,value);}return value;
    };
    let trials:TrialResult[];
    try {trials=await executePlan(plan,item=>runTrial({...item,executionId:options.executionId,case:dataset.cases.find(task=>task.id===item.caseId)!,datasetRoot:dataset.root,fixtureFiles:dataset.snapshot.fixtures,productResources:dataset.snapshot.productResources,config,controlledFixture:options.controlledFixture,modelCredential:options.modelCredential,trialRoot:join(executionRoot,'evidence',item.trialId),signal:options.signal,onPhase:phase=>forTrial(item).phase(phase)}),{blockers,signal:options.signal,onProgress:async trial=>{
      const current=forTrial(trial);current.emit({kind:'execution',executionStatus:trial.status,reason:trial.reason});current.phase('score');
      const task=dataset.cases.find(task=>task.id===trial.caseId)!;
      const directory=join(executionRoot,'evidence',trial.trialId);await mkdir(directory,{recursive:true});
      const events=await open(join(directory,'events.jsonl'),'a',0o600);await events.close();
      let journalFailed=false;
      const journal=async(kind:string,value:unknown)=>{try{const event=projectPublicEvidence({kind,at:new Date().toISOString(),value});await appendFile(join(directory,'events.jsonl'),JSON.stringify(event)+'\n',{mode:0o600});}catch(error){journalFailed=true;throw error;}};
      const trialScores=await evaluate({trialId:trial.trialId,caseId:trial.caseId,task:{checks:task.expected.checks},input:task,result:trial,gold:dataset.gold[trial.caseId]!,observation:trial.observation,trialStatus:trial.status,judge:options.judgeMode==='off'?undefined:options.judge,signal:options.signal,onJudgeRequest:request=>journal('judge.request',request),onJudgeResult:async result=>{await journal('judge.result',result);judgeCalls.push({trialId:trial.trialId,result});}});
      if(journalFailed)throw new Error('necessary_save_unconfirmed');
      scores.push(...trialScores);
      const status=aggregate([trial],[trial],trialScores).trials[0]!.status;
      current.emit({kind:'score',status,executionStatus:trial.status,checks:trialScores});current.phase('save');
      try{await stat(join(directory,'trial.json'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const {observation,...state}=trial;await writeJsonExclusive(join(directory,'trial.json'),{...state,observationRef:observation?'observation.json':null,lifecycle:{}});}
      if(trial.observation)try{await stat(join(directory,'observation.json'));}catch{await writeJsonExclusive(join(directory,'observation.json'),projectPublicEvidence(trial.observation));}
      await journal('scoring.completed',{trialId:trial.trialId,status,scores:trialScores});
      const walk=async(dir:string)=>{for(const item of await readdir(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isSymbolicLink())throw new Error('linked_trial_evidence');if(item.isDirectory()){if(item.name==='product'||item.name==='inputs'||item.name==='projection')continue;await walk(path);}else if(item.isFile())evidenceFiles.push({path:relative(executionRoot,path).replaceAll('\\','/'),sensitivity:'private'});}};
      await walk(directory);
      current.emit({kind:'saved',status,evidenceRef:'evidence/'+trial.trialId+'/'});current.close();options.onProgress?.(trial);
      savedTrials.push(trial);
      if(!summarizedCases.has(trial.caseId)&&savedTrials.filter(item=>item.caseId===trial.caseId).length===plan.filter(item=>item.caseId===trial.caseId).length){
        summarizedCases.add(trial.caseId);
        const caseSummary=deriveCaseAnalysis({plan,trials:savedTrials,scores,cases,snapshot},trial.caseId);
        const unsafe=savedTrials.some(item=>item.caseId===trial.caseId&&unsafeTrial(item));
        current.emit({kind:'case_summary',status,caseSummary,reason:unsafe?'stop_or_save_unconfirmed':undefined});
      }
    }});}finally{for(const item of progress.values())item.close();}
    const aggregation=aggregate(plan,trials,scores,cases);
    const archivedTrials=trials.map(({observation,...trial})=>({...trial,observationRef:observation?'evidence/'+trial.trialId+'/observation.json':null}));
    const candidates=reviewCandidates(dataset.snapshot.info.reviewPolicy,trials.map(trial=>({trialId:trial.trialId,caseId:trial.caseId,risks:dataset.cases.find(item=>item.id===trial.caseId)!.risks,scores:scores.filter(score=>score.trialId===trial.trialId)})));
    const report=hydrateReport({contract:'medclaw-evaluation-report/v1',executionId:options.executionId,snapshotRef:'snapshot.json',dataset:{id:dataset.manifest.id,version:1},cases,modules:dataset.modules,plan,trials:archivedTrials,scores:projectPublicEvidence(scores),judgeCalls:projectPublicEvidence(judgeCalls),evidenceManifest:[],totals:aggregation.totals,aggregation,reviewCandidates:candidates,createdAt:new Date().toISOString()},snapshot);
    const saved=await writeReport(executionRoot,report,evidenceFiles);keepLock=trials.some(unsafeTrial);
    try{await writeBadcases(join(executionRoot,'report.json'));}catch{console.error('[诊断] 分析文件保存失败；原报告和成绩已保留');throw new Error('badcase_artifacts_failed');}
    return saved;
  } finally {
    if(keepLock)await writeFile(lockPath,JSON.stringify({executionId:options.executionId,pid:process.pid,state:'stop_or_save_unconfirmed'}),{mode:0o600});else await unlink(lockPath);
  }
}
