import { readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { DataCheckResultsSchema } from '../src/evaluation.ts';
import { loadDataset, snapshotCompiled } from '../src/datasets.ts';
import { scoringCriteria } from '../src/scoring/registry.ts';
import { assertNoDatasetHashes } from '../src/data-format.ts';
import { loadFixtureFiles } from '../src/dataset-fixtures.ts';
import {sourceReferences} from '../src/datasets/medclaw-agent-v1.gold.ts';
export async function recordDataChecks(resultsPath:string) {
  const result=DataCheckResultsSchema.parse(JSON.parse(await readFile(resultsPath,'utf8')));
  const directory=resolve(import.meta.dir,'../src');
  const fixtures=await loadFixtureFiles();
  const inputPaths=[...new Set(['datasets/medclaw-agent-v1.ts','datasets/medclaw-agent-v1.gold.ts','datasets/medclaw-agent-v1.review.json',...Object.keys(fixtures).map(name=>'fixtures/'+name),'../../resources/skills/query/v1/SKILL.md','../../resources/skills/query/v1/references/facts-and-assumptions.md',...Object.values(sourceReferences).map(ref=>'../../'+ref.path)])].sort();
  if(Object.keys(result.inputs).sort().join()!==inputPaths.join())throw new Error('verification_inputs_incomplete');
  for(const [path,content] of Object.entries(result.inputs)) {
    if(await readFile(join(directory,path),'utf8')!==content)throw new Error('verification_inputs_changed');
  }
  const dataset=await loadDataset();if(result.cases!==dataset.cases.length||result.stages!==62||result.sourceRows!==24)throw new Error('verification_case_mismatch');
  const path=join(directory,'datasets/medclaw-agent-v1.review.json'),review=JSON.parse(await readFile(path,'utf8'));
  review.state='verified';review.verification={...result,inputs:undefined};
  review.verifiedData={info:dataset.snapshot.info,smokeIds:dataset.snapshot.smokeIds,cases:dataset.snapshot.cases,gold:dataset.snapshot.gold,fixtures:dataset.snapshot.fixtures,sourceReferences:dataset.snapshot.sourceReferences,productResources:dataset.snapshot.productResources,authoring:Object.fromEntries(Object.entries(review.cases).map(([id,value]:[string,any])=>[id,value.authoring])),compiled:snapshotCompiled(dataset),criteria:scoringCriteria(dataset.cases.flatMap(item=>item.expected.checks.map(check=>check.metricId)))};
  for(const item of dataset.cases)review.cases[item.id]={...review.cases[item.id],state:'verified',checkedBy:result.checker,checkedAt:result.checkedAt,method:result.methods.join('; '),unresolved:[]};
  assertNoDatasetHashes(review);await writeFile(path,JSON.stringify(review,null,2)+'\n');
  return {cases:result.cases,qualityRuns:'NOT_RUN'};
}
if(import.meta.main)console.log(JSON.stringify(await recordDataChecks(process.argv[2]??'')));
