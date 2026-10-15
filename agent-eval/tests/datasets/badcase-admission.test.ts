import {expect,test} from 'bun:test';
import {mkdtemp,readFile,readdir,rm,writeFile,mkdir,copyFile} from 'node:fs/promises';import {join,dirname,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {loadDataset,loadSnapshot,snapshotCompiled,materializeInputs,preparePublicMaterials,type DatasetLineage} from '../../src/datasets.ts';
import {scoringCriteria} from '../../src/scoring/registry.ts';
import {planTrials,runExperiment} from '../../src/execution/runner.ts';
import {runBlockers} from '../../src/doctor.ts';
import {recordDataChecks,verificationInputPaths} from '../../scripts/record-data-checks.ts';
import {reportFixture} from '../report-fixture.ts';
import {readReport} from '../../src/reports/write.ts';
import {cases as currentCases} from '../../src/datasets/medclaw-badcase-v1.ts';
import {goldDefinitions as currentGold} from '../../src/datasets/medclaw-badcase-v1.gold.ts';

const primary=await loadDataset();
async function controlledSourceFixture(root:string,suite:Awaited<ReturnType<typeof loadDataset>>,full=false){
  // Engineering-only fixture; never restore or certify the user's deleted source records.
  const repository=resolve(import.meta.dir,'../../..');
  for(const reference of Object.values(suite.snapshot.sourceReferences).filter(reference=>reference.kind==='product-spec')){
    const destination=join(root,reference.path);await mkdir(dirname(destination),{recursive:true});await copyFile(join(repository,reference.path),destination);
  }
  const origins=Object.entries(suite.snapshot.caseOrigins!);
  for(const batchId of new Set(origins.map(([,origin])=>origin.batchId))){
    const directory=join(root,'agent-eval/records',batchId);await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'issues.md'),'# Artificial engineering fixture, not a recovered Issue\n'+origins.map(([,origin])=>origin.issueId).join('\n'));
    await writeFile(join(directory,'admission-evidence.json'),JSON.stringify({batchId,capturedBy:'controlled-engineering-fixture',capturedAt:'2026-10-15T00:00:00.000Z',sources:origins.filter(([,origin])=>origin.batchId===batchId).map(([caseId,origin])=>({caseId,sourceExecutionId:origin.sourceExecutionId,sourceCaseId:origin.sourceCaseId,sourceTrialId:origin.sourceTrialId,evidenceRefs:origin.evidenceRefs}))}));
  }
  if(full)for(const path of verificationInputPaths(suite).filter(path=>!path.startsWith('../../agent-eval/records/'))){
    const destination=resolve(root,'agent-eval/src',path);await mkdir(dirname(destination),{recursive:true});await copyFile(resolve(repository,'agent-eval/src',path),destination);
  }
}
function provenanceFixture() {
  const snapshot=structuredClone(primary.snapshot),item=snapshot.cases.find(item=>item.id==='mc-v1-intent-resolve')!;
  snapshot.info.id='origin-fixture';snapshot.cases=[item];snapshot.smokeIds=[item.id];snapshot.gold={[item.id]:snapshot.gold[item.id]!};
  snapshot.review={...snapshot.review,state:'pending',cases:{[item.id]:{...snapshot.review.cases[item.id],state:'pending',checkedBy:null,checkedAt:null}}};
  const origin={batchId:'fixture-batch',issueId:'MC-BC-004',evidencePacketRef:'agent-eval/records/fixture-batch/admission-evidence.json',sourceExecutionId:'source-execution',sourceCaseId:item.id,sourceTrialId:item.id+'-r1',derivedFromCaseId:item.id,purpose:'challenge',changes:[],
    evidenceRefs:[{path:'agent-eval/runs/business/source-execution/evidence/'+item.id+'-r1/observation.json',pointer:'/executionId',value:'source-execution'}]};
  const lineage:DatasetLineage={contract:'medclaw-eval-lineage/v1',version:1,groups:[{id:'synthetic-procurement-v1',sourceRefs:['fixtures/procurement.csv'],caseIds:[item.id],partition:'developer_visible',exposure:'developer_visible',origin:'synthetic_authored',parentGroupIds:[],notes:'Explicit same-source family, not a holdout'}]};
  return {...snapshot,caseOrigins:{[item.id]:origin},lineage};
}
function seal(snapshot:ReturnType<typeof provenanceFixture>) {
  const dataset=loadSnapshot(snapshot);snapshot.review.state='verified';
  const {review,...content}=snapshot;
  review.verifiedData=structuredClone({...content,contract:undefined,authoring:Object.fromEntries(Object.entries(review.cases).map(([id,value]:[string,any])=>[id,value.authoring])),compiled:snapshotCompiled(dataset),criteria:scoringCriteria(dataset.cases.flatMap(item=>item.expected.checks.map(check=>check.metricId)))});
  delete review.verifiedData.contract;
  return snapshot;
}

test('pending supplementary suite uses current declarations and preserves dated review history',async()=>{
  const reviewPath=join(import.meta.dir,'../../src/datasets/medclaw-badcase-v1.review.json'),before=await readFile(reviewPath,'utf8'),historical=JSON.parse(before);
  const suite=await loadDataset('medclaw-badcase-v1');
  expect(suite.manifest.members).toEqual(['mc-bc-intent-zh-name','mc-v1-intent-resolve','mc-v1-intent-clarify-region']);
  expect(planTrials(suite.manifest.members,3)).toHaveLength(9);expect(primary.manifest.members).toHaveLength(50);expect(primary.manifest.smoke).toHaveLength(10);
  expect(suite.snapshot.cases).toEqual(currentCases);expect(suite.snapshot.gold).toEqual(currentGold);
  expect(suite.snapshot.review.verifiedData).toEqual(historical.verifiedData);expect(suite.snapshot.review.verification).toEqual(historical.verification);
  expect(suite.snapshot.review.cases).toEqual(historical.cases);expect(suite.snapshot.review.state).toBe('pending');
  expect(Object.values(suite.reviews).every(review=>review.state==='pending')).toBe(true);
  expect(await readFile(reviewPath,'utf8')).toBe(before);
  expect(suite.manifest.readiness).toBe('draft');
  expect(suite.snapshot.cases[0]!.name).toContain('中文');expect(suite.manifest.members).not.toContain('mc-bc-intent-source-id');
});

test('explicit provenance survives compilation and draft review still blocks execution',()=>{
  const snapshot=provenanceFixture(),dataset=loadSnapshot(snapshot);
  expect(dataset.lineage).toEqual(snapshot.lineage);expect(dataset.cases[0]!.lineageGroupIds).toEqual(['synthetic-procurement-v1']);
  expect(runBlockers(dataset,{sdk:'0.87.1',patch:'present'})).toContain('dataset_review_pending');
});

test('verified provenance and lineage edits invalidate their review',()=>{
  const snapshot=seal(provenanceFixture());expect(loadSnapshot(snapshot).manifest.readiness).toBe('draft');
  const changedOrigin=structuredClone(snapshot);changedOrigin.caseOrigins['mc-v1-intent-resolve']!.evidenceRefs[0]!.value='changed';
  expect(()=>loadSnapshot(changedOrigin)).toThrow('review_content_changed');
  const changedLineage=structuredClone(snapshot);changedLineage.lineage.groups[0]!.notes='changed';
  expect(()=>loadSnapshot(changedLineage)).toThrow('review_content_changed');
});

test('origin references reject traversal, invalid pointers and evidence from another execution',()=>{
  for(const change of [{path:'../outside.json'},{pointer:'/bad~escape'},{path:'agent-eval/runs/business/other/evidence/mc-v1-intent-resolve-r1/observation.json'}]) {
    const snapshot=provenanceFixture();Object.assign(snapshot.caseOrigins['mc-v1-intent-resolve']!.evidenceRefs[0]!,change);
    expect(()=>loadSnapshot(snapshot)).toThrow();
  }
});

test('origins cannot be orphaned or silently omitted for a member',()=>{
  const orphan=provenanceFixture();(orphan.caseOrigins as Record<string,unknown>).orphan=orphan.caseOrigins['mc-v1-intent-resolve'];
  expect(()=>loadSnapshot(orphan)).toThrow();
  const missing=provenanceFixture();delete (missing.caseOrigins as Record<string,unknown>)['mc-v1-intent-resolve'];
  expect(()=>loadSnapshot(missing)).toThrow();
});

test('explicit lineage rejects missing members, orphan source files, duplicate groups and false holdouts',()=>{
  for(const change of [{caseIds:[]},{caseIds:['orphan']},{sourceRefs:['fixtures/missing.csv']},{partition:'blind_holdout',exposure:'unexposed'},{parentGroupIds:['missing-parent']}]) {
    const snapshot=provenanceFixture();Object.assign(snapshot.lineage.groups[0]!,change);expect(()=>loadSnapshot(snapshot)).toThrow();
  }
  const duplicate=provenanceFixture();duplicate.lineage.groups.push(structuredClone(duplicate.lineage.groups[0]!));expect(()=>loadSnapshot(duplicate)).toThrow();
});

test('a different dataset ID cannot bypass budget and failure-mapping authoring checks',()=>{
  const snapshot=provenanceFixture();snapshot.review.cases['mc-v1-intent-resolve'].authoring.budget.necessary=999;
  expect(()=>loadSnapshot(snapshot)).toThrow('budget_review_mismatch');
});

test('private origin excerpts never enter materialized model inputs',async()=>{
  const snapshot=provenanceFixture();snapshot.caseOrigins['mc-v1-intent-resolve']!.evidenceRefs[0]!.value='private-origin-marker';
  const dataset=loadSnapshot(snapshot),root=await mkdtemp(join(tmpdir(),'mc-badcase-input-'));
  try {const inputs=await materializeInputs(dataset.cases[0]!,join(root,'inputs'));for(const file of await preparePublicMaterials(dataset.cases[0]!,inputs))expect(await readFile(file.path,'utf8')).not.toContain('private-origin-marker');}
  finally{await rm(root,{recursive:true,force:true});}
});

test('independent supplementary audit recomputes truth and rejects changed origins, controls and reused cases',async()=>{
  const suite=await loadDataset('medclaw-badcase-v1'),root=await mkdtemp(join(tmpdir(),'mc-badcase-audit-'));
  try {
    await controlledSourceFixture(root,suite);
    await writeFile(join(root,'suite.json'),JSON.stringify(suite.snapshot));await writeFile(join(root,'primary.json'),JSON.stringify(primary.snapshot));
    const program=`import copy, importlib.util, json, pathlib, sys
spec=importlib.util.spec_from_file_location('verifier',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
module.REPOSITORY=pathlib.Path(sys.argv[2]).parent
suite=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8'));primary=json.loads(pathlib.Path(sys.argv[3]).read_text(encoding='utf-8'))
count,stages=module.verify_badcase(suite,primary)
mutations=[
 lambda s:s['gold']['mc-bc-intent-zh-name']['facts']['numeric'][0].__setitem__('value',8101),
 lambda s:s['cases'][1].__setitem__('name','rewritten parent'),
 lambda s:s['caseOrigins']['mc-bc-intent-zh-name']['evidenceRefs'][0].__setitem__('value','forged'),
 lambda s:s['caseOrigins']['mc-bc-intent-zh-name'].__setitem__('issueId','MC-BC-001'),
 lambda s:s['caseOrigins']['mc-bc-intent-zh-name'].__setitem__('derivedFromCaseId','nonexistent-parent'),
 lambda s:s['caseOrigins']['mc-bc-intent-zh-name'].__setitem__('purpose','regression'),
 lambda s:s['caseOrigins']['mc-bc-intent-zh-name'].__setitem__('changes',[]),
 lambda s:s['caseOrigins']['mc-bc-intent-zh-name']['evidenceRefs'][0].__setitem__('path','../outside.json'),
 lambda s:s['lineage']['groups'][0].__setitem__('partition','blind_holdout'),
 lambda s:s['cases'][0]['input'].__setitem__('prompt','查询浙江A，答案8100分'),
 lambda s:s['cases'][0]['expected'].__setitem__('maxToolCalls',0),
]
for mutate in mutations:
 changed=copy.deepcopy(suite);mutate(changed)
 try:module.verify_badcase(changed,primary)
 except (ValueError,KeyError):continue
 raise RuntimeError('changed candidate accepted')
print(json.dumps({'cases':len(suite['cases']),'sourceRows':count,'stages':stages,'rejected':len(mutations)}))`;
    for(const flags of [[],['-O']]) {
      const proc=Bun.spawn(['python',...flags,'-c',program,join(import.meta.dir,'../../scripts/verify-stage-one.py'),join(root,'suite.json'),join(root,'primary.json')],{stdout:'pipe',stderr:'pipe'});
      const output=await new Response(proc.stdout).text(),error=await new Response(proc.stderr).text();
      expect(error).toBe('');expect(await proc.exited).toBe(0);expect(JSON.parse(output)).toEqual({cases:3,sourceRows:24,stages:3,rejected:11});
    }
  } finally{await rm(root,{recursive:true,force:true});}
},30000);

test('recording supplementary review requires its complete actual verification inputs',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-badcase-review-'));
  try {
    const path=join(root,'incomplete.json');await writeFile(path,JSON.stringify({contract:'medclaw-data-check-results/v1',datasetId:'medclaw-badcase-v1',status:'passed',checker:'controlled-checker',checkedAt:'2026-10-14T00:00:00.000Z',assertions:1,cases:3,stages:3,sourceRows:24,methods:['controlled missing-input test'],inputs:{},qualityRuns:'NOT_RUN',exposure:'developer_visible',unresolvedDataChecks:[]}));
    await expect(recordDataChecks(path)).rejects.toThrow('verification_inputs_incomplete');
  } finally{await rm(root,{recursive:true,force:true});}
});

test('the existing read-only verifier selects the supplementary dataset without changing either review',async()=>{
  const suite=await loadDataset('medclaw-badcase-v1'),root=await mkdtemp(join(tmpdir(),'mc-controlled-source-audit-'));
  const files=['medclaw-agent-v1','medclaw-badcase-v1'].map(id=>join(import.meta.dir,'../../src/datasets',id+'.review.json'));
  const before=await Promise.all(files.map(path=>readFile(path,'utf8')));
  try{
  await controlledSourceFixture(root,suite,true);
  const program=`import importlib.util,pathlib,sys
spec=importlib.util.spec_from_file_location('verifier',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
module.REPOSITORY=pathlib.Path(sys.argv[2]);module.ROOT=module.REPOSITORY/'agent-eval/src'
sys.argv=[str(module.SCRIPTS/'verify-stage-one.py'),'medclaw-badcase-v1'];module.main()`;
  for(const flags of [[],['-O']]) {
    const proc=Bun.spawn(['python',...flags,'-c',program,join(import.meta.dir,'../../scripts/verify-stage-one.py'),root],{stdout:'pipe',stderr:'pipe'});
    const output=await new Response(proc.stdout).text(),error=await new Response(proc.stderr).text();expect(error).toBe('');expect(await proc.exited).toBe(0);
    expect(JSON.parse(output)).toMatchObject({datasetId:'medclaw-badcase-v1',cases:3,stages:3,sourceRows:24,qualityRuns:'NOT_RUN'});
  }
  expect(await Promise.all(files.map(path=>readFile(path,'utf8')))).toEqual(before);
  }finally{await rm(root,{recursive:true,force:true});}
},30000);

test('supplementary identity cannot discard mandatory provenance and fall back to legacy defaults',async()=>{
  const snapshot=structuredClone((await loadDataset('medclaw-badcase-v1')).snapshot);snapshot.review.state='pending';delete snapshot.caseOrigins;delete snapshot.lineage;
  expect(()=>loadSnapshot(snapshot)).toThrow('case_origin_identity');
  expect(loadSnapshot(primary.snapshot).manifest.members).toHaveLength(50);
});

test('frozen scalar evidence remains auditable without the machine-local raw run directories',async()=>{
  const suite=await loadDataset('medclaw-badcase-v1'),root=await mkdtemp(join(tmpdir(),'mc-portable-origin-'));
  try {
    await controlledSourceFixture(root,suite);
    await writeFile(join(root,'suite.json'),JSON.stringify(suite.snapshot));
    const program=`import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('verifier',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
module.REPOSITORY=pathlib.Path(sys.argv[2]);suite=json.loads((module.REPOSITORY/'suite.json').read_text(encoding='utf-8'))
result=module.verify_origins(suite)
print(json.dumps(result))`;
    const proc=Bun.spawn(['python','-O','-c',program,join(import.meta.dir,'../../scripts/verify-stage-one.py'),root],{stdout:'pipe',stderr:'pipe'});
    const output=await new Response(proc.stdout).text(),error=await new Response(proc.stderr).text();expect(error).toBe('');expect(await proc.exited).toBe(0);expect(JSON.parse(output)).toEqual({frozen:12,original:0});
  } finally{await rm(root,{recursive:true,force:true});}
});

test('missing original ledger and frozen source packet block admission instead of inventing source proof',async()=>{
  const suite=await loadDataset('medclaw-badcase-v1'),root=await mkdtemp(join(tmpdir(),'mc-missing-admission-source-'));
  try{
    await writeFile(join(root,'suite.json'),JSON.stringify(suite.snapshot));
    const program=`import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('verifier',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
module.REPOSITORY=pathlib.Path(sys.argv[2]);suite=json.loads((module.REPOSITORY/'suite.json').read_text(encoding='utf-8'))
try:module.verify_origins(suite)
except ValueError:print('source_missing_blocked')
else:raise RuntimeError('Missing admission proof accepted')`;
    const proc=Bun.spawn(['python','-O','-c',program,join(import.meta.dir,'../../scripts/verify-stage-one.py'),root],{stdout:'pipe',stderr:'pipe'});
    expect((await new Response(proc.stdout).text()).trim()).toBe('source_missing_blocked');expect(await proc.exited).toBe(0);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('draft supplementary execution archives all nine blocked Trials and private provenance without model calls',async()=>{
  const snapshot=structuredClone((await loadDataset('medclaw-badcase-v1')).snapshot);snapshot.review.state='pending';
  const root=await mkdtemp(join(tmpdir(),'mc-badcase-plan-'));
  try {
    const source=join(root,'dataset.json');await writeFile(source,JSON.stringify(snapshot));
    const report=await runExperiment({datasetRoot:source,runsRoot:join(root,'runs'),executionId:'controlled-badcase-draft',selection:'full',trials:3,config:reportFixture().config,judgeMode:'off'});
    expect(report.plan).toHaveLength(9);expect(report.totals.notRun).toBe(9);expect(report.trials.every(trial=>trial.startedAt===null)).toBe(true);expect(report.judgeCalls).toHaveLength(0);
    const loaded=await readReport(join(root,'runs','controlled-badcase-draft','report.json'));expect(loaded.snapshot.dataset.caseOrigins).toEqual(snapshot.caseOrigins);
    const {deriveBadcases}=await import('../../src/reports/badcases.ts');
    const archive=join(root,'runs','controlled-badcase-draft'),index=await deriveBadcases(archive);expect(index.summary.candidates).toBe(0);
    expect((await readdir(archive)).sort()).toEqual(['evidence','report.json','snapshot.json']);
  } finally{await rm(root,{recursive:true,force:true});}
},30000);
