import { readFile } from 'node:fs/promises';
import { resolve,join,relative } from 'node:path';
import { DataCheckResultsSchema } from '../src/evaluation.ts';
import { loadDataset, snapshotCompiled,type LoadedDataset } from '../src/datasets.ts';
import { scoringCriteria } from '../src/scoring/registry.ts';
import { assertNoDatasetHashes } from '../src/data-format.ts';
import {parseFixtureCatalog} from '../src/dataset-fixtures.ts';
import {parseAuthoredSource} from '../src/independent-gold.ts';
import {evidencePath,replaceJson} from '../src/reports/write.ts';
export function verificationInputPaths(dataset:LoadedDataset) {
  const ids=dataset.manifest.id==='medclaw-badcase-v1'?['medclaw-agent-v1','medclaw-badcase-v1']:['medclaw-agent-v1'];
  if(!ids.includes(dataset.manifest.id))throw new Error('verification_dataset_unknown');
  const origins=Object.values(dataset.snapshot.caseOrigins??{});
  return [...new Set([...ids.flatMap(id=>['datasets/'+id+'.ts','datasets/'+id+'.gold.ts','datasets/'+id+'.review.json']),
    'evaluation.ts','dataset-compiler.ts','datasets.ts','scoring/registry.ts','scoring/general.ts','scoring/project-general.ts','scoring/project-observation.ts','scoring/project-harness.ts','scoring/evaluate.ts','../../packages/contracts/src/business-tools.ts','../scripts/verify-stage-one.py','../scripts/export-data.ts','../scripts/record-data-checks.ts',
    ...Object.keys(dataset.snapshot.fixtures).map(name=>'fixtures/'+name),'../../resources/skills/query/v1/SKILL.md','../../resources/skills/query/v1/references/facts-and-assumptions.md',
    ...Object.values(dataset.snapshot.sourceReferences).map(ref=>'../../'+ref.path),
    ...origins.flatMap(origin=>['../../agent-eval/records/'+origin.batchId+'/issues.md','../../'+origin.evidencePacketRef])])].sort();
}
export async function recordDataChecks(resultsPath:string) {
  const result=DataCheckResultsSchema.parse(JSON.parse(await readFile(resultsPath,'utf8')));
  const directory=resolve(import.meta.dir,'../src');
  const id=result.datasetId??'medclaw-agent-v1';if(!['medclaw-agent-v1','medclaw-badcase-v1'].includes(id))throw new Error('verification_dataset_unknown');
  const dataset=await loadDataset(id),inputPaths=verificationInputPaths(dataset),repository=resolve(directory,'../..');
  if(Object.keys(result.inputs).sort().join()!==inputPaths.join())throw new Error('verification_inputs_incomplete');
  for(const [path,content] of Object.entries(result.inputs)) {
    const confined=await evidencePath(repository,relative(repository,resolve(directory,path)).replaceAll('\\','/'));
    if(await readFile(confined,'utf8')!==content)throw new Error('verification_inputs_changed');
  }
  const catalog=parseFixtureCatalog(dataset.snapshot.fixtures),stages=dataset.cases.reduce((n,item)=>n+1+(dataset.snapshot.gold[item.id]!.initial?1:0),0);
  if(result.cases!==dataset.cases.length||result.stages!==stages||result.sourceRows!==parseAuthoredSource(dataset.snapshot.fixtures[catalog.source.ref]!).length)throw new Error('verification_case_mismatch');
  const path=join(directory,'datasets/'+id+'.review.json'),review=JSON.parse(await readFile(path,'utf8'));
  review.state='verified';review.verification={...result,inputs:undefined};
  review.verifiedData={info:dataset.snapshot.info,smokeIds:dataset.snapshot.smokeIds,cases:dataset.snapshot.cases,gold:dataset.snapshot.gold,fixtures:dataset.snapshot.fixtures,sourceReferences:dataset.snapshot.sourceReferences,productResources:dataset.snapshot.productResources,authoring:Object.fromEntries(Object.entries(review.cases).map(([id,value]:[string,any])=>[id,value.authoring])),compiled:snapshotCompiled(dataset),criteria:scoringCriteria(dataset.cases.flatMap(item=>item.expected.checks.map(check=>check.metricId))),
    ...dataset.snapshot.caseOrigins?{caseOrigins:dataset.snapshot.caseOrigins}:{},...dataset.snapshot.lineage?{lineage:dataset.snapshot.lineage}:{}};
  for(const item of dataset.cases)review.cases[item.id]={...review.cases[item.id],state:'verified',checkedBy:result.checker,checkedAt:result.checkedAt,method:result.methods.join('; '),unresolved:[]};
  assertNoDatasetHashes(review);await replaceJson(path,review);
  return {cases:result.cases,qualityRuns:'NOT_RUN',...result.datasetId?{datasetId:result.datasetId}:{}};
}
if(import.meta.main)console.log(JSON.stringify(await recordDataChecks(process.argv[2]??'')));
