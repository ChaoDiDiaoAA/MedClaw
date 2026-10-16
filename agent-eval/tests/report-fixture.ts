import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cases,datasetInfo } from '../src/datasets/medclaw-agent-v1.ts';
import { goldDefinitions,sourceReferences } from '../src/datasets/medclaw-agent-v1.gold.ts';
import { loadSnapshot,snapshotCompiled,type DatasetSnapshot } from '../src/datasets.ts';
import { aggregate } from '../src/scoring/aggregate.ts';
import { hydrateReport,writeJsonExclusive,writeReport,writeFileExclusive } from '../src/reports/write.ts';
import type { EvaluationReport,ExecutionSnapshot } from '../src/types.ts';
import {registry,scoringCriteria} from '../src/scoring/registry.ts';
const directory=join(import.meta.dir,'../src/fixtures');
export function datasetFixture():DatasetSnapshot {
  const item=structuredClone(cases[0]!);
  return {contract:'medclaw-dataset-snapshot/v1',info:{...datasetInfo,id:'controlled-fixture'},cases:[item],smokeIds:[item.id],gold:{[item.id]:structuredClone(goldDefinitions[item.id]!)},sourceReferences,productResources:[],fixtures:Object.fromEntries(readdirSync(directory).filter(name=>name!=='README.md').map(name=>[name,readFileSync(join(directory,name),'utf8')])),review:{contract:'medclaw-data-review/v1',qualityRuns:'NOT_RUN',cases:{[item.id]:{state:'pending',checkedBy:null,checkedAt:null,method:'Engineering fixture, no quality claim',unresolved:['No independent real evaluation']}}}};
}
export function reportFixture():EvaluationReport {
  const dataset=loadSnapshot(datasetFixture()),task=dataset.cases[0]!,executionId='controlled-fixture',trialId=task.id+'-r1';
  const config={version:1 as const,environment:'test',model:{provider:'fixture',model:'fixture',maxTokens:256},intent:{baseUrl:'http://127.0.0.1:11434',model:'qwen3.5:0.8b' as const},policy:{},retention:'preserve_all' as const};
  const snapshot:ExecutionSnapshot={contract:'medclaw-execution-snapshot/v1',executionId,dataset:dataset.snapshot,compiled:snapshotCompiled(dataset),config,criteria:scoringCriteria(task.expected.checks.map(check=>check.metricId)),source:{sdk:'0.87.1'}};
  const plan=[{trialId,caseId:task.id,repetition:1}],trials=[{...plan[0]!,status:'not_run' as const,instanceId:null,startedAt:null,endedAt:null,reason:'controlled fixture',stopped:null,closed:null,observationRef:null}];
  const scores=task.expected.checks.map(check=>({trialId,caseId:task.id,metricId:check.metricId,name:registry.get(check.metricId).name,version:check.version,method:check.kind,checkId:check.id,scope:{kind:'trial' as const,ref:trialId},applicable:true,required:check.required,hardConstraint:check.hardConstraint,status:'NOT_RUN' as const,unit:check.unit,value:null,numerator:null,denominator:null,evidenceRefs:[],reason:'Controlled fixture, no real run',missing:[],actual:null,expected:dataset.gold[task.id]!.values[check.evidenceKey]}));
  const definitions=dataset.cases.map(item=>({id:item.id,version:1 as const,name:item.name,category:item.category,evalType:item.evalType,tags:item.tags}));
  const aggregation=aggregate(plan,trials,scores,definitions);
  return hydrateReport({contract:'medclaw-evaluation-report/v1',executionId,snapshotRef:'snapshot.json',dataset:{id:'controlled-fixture',version:1},cases:definitions,modules:dataset.modules,plan,trials,scores,judgeCalls:[],evidenceManifest:[],totals:aggregation.totals,aggregation,reviewCandidates:[],createdAt:'2026-10-13T00:00:00.000Z'},snapshot);
}
export function runConfigFixture() {
  return {...reportFixture().config,model:{url:'https://agent.example.invalid/v1',key:'private-agent-config-key',model:'openai/gpt-4o-mini'}};
}
export async function saveReportFixture(root:string,report=reportFixture(),observations:Record<string,unknown>={}) {
  await writeJsonExclusive(join(root,'snapshot.json'),report.snapshot);
  const evidence=[];
  for(const trial of report.trials) {
    const path='evidence/'+trial.trialId+'/trial.json';
    await writeJsonExclusive(join(root,path),trial);evidence.push({path,sensitivity:'private' as const});
    const events='evidence/'+trial.trialId+'/events.jsonl';
    const scoring=report.snapshot.plan===undefined?'':JSON.stringify({at:report.createdAt,kind:'scoring.completed',value:{trialId:trial.trialId,scores:report.scores.filter(score=>score.trialId===trial.trialId)}})+'\n';
    await writeFileExclusive(join(root,events),scoring);evidence.push({path:events,sensitivity:'private' as const});
    if(trial.observationRef) {await writeJsonExclusive(join(root,trial.observationRef),observations[trial.trialId]??{executionId:report.executionId,trialId:trial.trialId,instanceId:trial.instanceId,observedFrom:trial.startedAt,observedUntil:trial.endedAt,identityChecks:[{id:'engineering-owner',passed:true,reason:'Controlled artificial observation'}],facts:{},missing:[]});evidence.push({path:trial.observationRef,sensitivity:'private' as const});}
  }
  return writeReport(root,report,evidence);
}
