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
import { sourceInventory,runBlockers } from '../doctor.ts';
import { assertSafeExport } from '../langfuse/map.ts';
import { projectPublicEvidence } from '../data-format.ts';
import {assertJudgeMatches} from '../scoring/judges/client.ts';

const unsafeTrial=(trial:TrialResult)=>Boolean(trial.startedAt&&(trial.stopped!==true||trial.closed!==true))||['necessary_save_unconfirmed','trial_exception_stop_unknown','host_stop_unconfirmed'].includes(trial.reason??'');
export function planTrials(caseIds:string[],repeat:number):TrialPlan[] {
  if(!caseIds.length||new Set(caseIds).size!==caseIds.length||!Number.isSafeInteger(repeat)||repeat<1||repeat>3)throw new Error('trial_plan_invalid');
  caseIds.forEach(id=>ExecutionIdSchema.parse(id));
  return caseIds.flatMap(caseId=>Array.from({length:repeat},(_,i)=>({caseId,repetition:i+1,trialId:ExecutionIdSchema.parse(caseId+'-r'+(i+1))})));
}
export async function executePlan(plan:TrialPlan[],run:(item:TrialPlan)=>Promise<TrialResult>,options:{signal?:AbortSignal;blockers?:string[];onProgress?:(trial:TrialResult)=>void}={}) {
  const trials:TrialResult[]=[];let unsafe=false;
  for(const item of plan) {
    const reason=unsafe?'previous_trial_stop_or_save_unconfirmed':options.signal?.aborted?'execution_cancelled_before_start':options.blockers?.length?options.blockers.join(';'):null;
    let trial:TrialResult;
    if(reason)trial={...item,status:'not_run',instanceId:null,startedAt:null,endedAt:null,reason,stopped:null,closed:null,observation:null};
    else {try{trial=await run(item);}catch{trial={...item,status:'infra_error',instanceId:null,startedAt:null,endedAt:new Date().toISOString(),reason:'trial_exception_stop_unknown',stopped:null,closed:null,observation:null};unsafe=true;}if(unsafeTrial(trial))unsafe=true;}
    trials.push(trial);options.onProgress?.(trial);
  }
  return trials;
}
export interface RunOptions {
  datasetRoot:string;runsRoot:string;executionId:string;selection:'smoke'|'full';repeat:number;
  config:ResolvedRunConfig;modelCredential?:AgentModelCredential;judgeMode:'required'|'off';judge?:Judge;signal?:AbortSignal;
  onProgress?:(trial:TrialResult)=>void;controlledFixture?:boolean;
}
export async function runExperiment(options:RunOptions):Promise<EvaluationReport> {
  ExecutionIdSchema.parse(options.executionId);const config=ResolvedRunConfigSchema.parse(options.config);assertSafeExport(config);
  const dataset=await loadDataset(options.datasetRoot);
  if(dataset.cases.some(item=>!item.steps.length))throw new Error('execution_archive_read_only');
  if(dataset.manifest.id==='medclaw-agent-v1'&&(options.selection==='full'?options.repeat!==3:options.repeat!==1))throw new Error('benchmark_plan_must_be_smoke10x1_or_full50x3');
  const members=options.selection==='smoke'?dataset.manifest.smoke:dataset.manifest.members,plan=planTrials(members,options.repeat);
  const judged=plan.filter(trial=>dataset.cases.find(item=>item.id===trial.caseId)!.expected.checks.some(check=>check.kind==='llm-judge'));
  if(options.judgeMode!=='off'&&judged.length&&options.judge)assertJudgeMatches(config.judge,options.judge.configuration);
  const root=resolve(options.runsRoot);await mkdir(root,{recursive:true});
  const lockPath=join(root,'.active-execution.json'),lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({executionId:options.executionId,pid:process.pid}));await lock.close();
  let keepLock=false;
  try {
    const executionRoot=join(root,options.executionId);await mkdir(executionRoot);
    const source=await sourceInventory();
    const criteria=scoringCriteria(dataset.cases.flatMap(item=>item.expected.checks.map(check=>check.metricId)));
    const snapshot:ExecutionSnapshot={contract:'medclaw-execution-snapshot/v1',executionId:options.executionId,dataset:dataset.snapshot,compiled:snapshotCompiled(dataset),config,criteria,source};
    await writeJsonExclusive(join(executionRoot,'snapshot.json'),snapshot);
    const blockers=runBlockers(dataset,source,config,{required:options.judgeMode==='required'&&judged.length>0,configured:!!options.judge});
    keepLock=true;
    const trials=await executePlan(plan,item=>runTrial({...item,executionId:options.executionId,case:dataset.cases.find(task=>task.id===item.caseId)!,datasetRoot:dataset.root,fixtureFiles:dataset.snapshot.fixtures,productResources:dataset.snapshot.productResources,config,controlledFixture:options.controlledFixture,modelCredential:options.modelCredential,trialRoot:join(executionRoot,'evidence',item.trialId),signal:options.signal}),{blockers,signal:options.signal,onProgress:options.onProgress});
    const scores:EvaluationScore[]=[],judgeCalls:{trialId:string;result:JudgeResult}[]=[];
    const evidenceFiles:{path:string;sensitivity:'private'}[]=[];
    for(const trial of trials) {
      const task=dataset.cases.find(task=>task.id===trial.caseId)!;
      const directory=join(executionRoot,'evidence',trial.trialId);await mkdir(directory,{recursive:true});
      const events=await open(join(directory,'events.jsonl'),'a',0o600);await events.close();
      const journal=async(kind:string,value:unknown)=>{const event=projectPublicEvidence({kind,at:new Date().toISOString(),value});await appendFile(join(directory,'events.jsonl'),JSON.stringify(event)+'\n',{mode:0o600});};
      scores.push(...await evaluate({trialId:trial.trialId,caseId:trial.caseId,task:{checks:task.expected.checks},input:task,result:trial,gold:dataset.gold[trial.caseId]!,observation:trial.observation,trialStatus:trial.status,judge:options.judgeMode==='off'?undefined:options.judge,signal:options.signal,onJudgeRequest:request=>journal('judge.request',request),onJudgeResult:async result=>{await journal('judge.result',result);judgeCalls.push({trialId:trial.trialId,result});}}));
      try{await stat(join(directory,'trial.json'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const {observation,...state}=trial;await writeJsonExclusive(join(directory,'trial.json'),{...state,observationRef:observation?'observation.json':null,lifecycle:{}});}
      if(trial.observation)try{await stat(join(directory,'observation.json'));}catch{await writeJsonExclusive(join(directory,'observation.json'),projectPublicEvidence(trial.observation));}
      const walk=async(dir:string)=>{for(const item of await readdir(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isSymbolicLink())throw new Error('linked_trial_evidence');if(item.isDirectory()){if(item.name==='product'||item.name==='inputs'||item.name==='projection')continue;await walk(path);}else if(item.isFile())evidenceFiles.push({path:relative(executionRoot,path).replaceAll('\\','/'),sensitivity:'private'});}};
      await walk(directory);
    }
    const cases=dataset.cases.map(item=>({id:item.id,version:1 as const,name:item.name,category:item.category,evalType:item.evalType,tags:item.tags}));
    const aggregation=aggregate(plan,trials,scores,cases);
    const archivedTrials=trials.map(({observation,...trial})=>({...trial,observationRef:observation?'evidence/'+trial.trialId+'/observation.json':null}));
    const candidates=reviewCandidates(dataset.snapshot.info.reviewPolicy,trials.map(trial=>({trialId:trial.trialId,caseId:trial.caseId,risks:dataset.cases.find(item=>item.id===trial.caseId)!.risks,scores:scores.filter(score=>score.trialId===trial.trialId)})));
    const report=hydrateReport({contract:'medclaw-evaluation-report/v1',executionId:options.executionId,snapshotRef:'snapshot.json',dataset:{id:dataset.manifest.id,version:1},cases,modules:dataset.modules,plan,trials:archivedTrials,scores:projectPublicEvidence(scores),judgeCalls:projectPublicEvidence(judgeCalls),evidenceManifest:[],totals:aggregation.totals,aggregation,reviewCandidates:candidates,createdAt:new Date().toISOString()},snapshot);
    const saved=await writeReport(executionRoot,report,evidenceFiles);keepLock=trials.some(unsafeTrial);return saved;
  } finally {
    if(keepLock)await writeFile(lockPath,JSON.stringify({executionId:options.executionId,pid:process.pid,state:'stop_or_save_unconfirmed'}),{mode:0o600});else await unlink(lockPath);
  }
}
