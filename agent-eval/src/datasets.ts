import { lstat, readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, join, basename, relative } from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import { cases as builtInCases, datasetInfo, smokeIds } from './datasets/medclaw-agent-v1.ts';
import { goldDefinitions, sourceReferences } from './datasets/medclaw-agent-v1.gold.ts';
import * as badcaseDataset from './datasets/medclaw-badcase-v1.ts';
import {goldDefinitions as badcaseGold,sourceReferences as badcaseReferences} from './datasets/medclaw-badcase-v1.gold.ts';
import type { GoldDefinition } from './evaluation.ts';
import { fixtureMaterials, loadFixtureFiles, loadProductResources, parseFixtureCatalog,fixtureConversation } from './dataset-fixtures.ts';
import { assertNoDatasetHashes, importFiles } from './data-format.ts';
import { compileCase } from './dataset-compiler.ts';
import {CommonRequiredMetrics} from './dataset-compiler.ts';
import {scoringCriteria} from './scoring/registry.ts';
import { Categories, RelativePathSchema, DatasetManifestSchema, EvalCaseSchema, ReviewSchema, ProductResourceSchema, GoldDefinitionSchema, SourceReferenceSchema, CheckSpecSchema, CaseOriginsSchema, DatasetLineageSchema, type CaseOrigins, type ProductResource, type CheckSpec, type CaseDefinition, type DatasetManifest, type DatasetLineage, type EvalCase, type EvalGold } from './evaluation.ts';
export * from './evaluation.ts';
export { CommonRequiredMetrics } from './dataset-compiler.ts';

export const HarnessModules = Categories;
export interface DatasetSnapshot {
  contract:'medclaw-dataset-snapshot/v1'; info:{id:string;version:1;name:string;description:string;createdAt:string;referenceDate:string;timezone:'Asia/Shanghai';scoringVersion:'v1';reviewPolicy?:unknown}; cases:CaseDefinition[]; smokeIds:string[];
  gold:Record<string,GoldDefinition>; fixtures:Record<string,string>; review:any;
  sourceReferences:Record<string,ReturnType<typeof SourceReferenceSchema.parse>>;productResources:ProductResource[];
  caseOrigins?:CaseOrigins;lineage?:DatasetLineage;
}
export type CompiledDataset = Record<string,{checks:CheckSpec[];values:Record<string,unknown>}>;
export function snapshotCompiled(dataset:LoadedDataset):CompiledDataset {return JSON.parse(JSON.stringify(Object.fromEntries(dataset.cases.map(item=>[item.id,{checks:item.expected.checks,values:dataset.gold[item.id]!.values}]))));}
export interface LoadedDataset {
  root:string; manifest:DatasetManifest; cases:EvalCase[]; gold:Record<string,EvalGold>;
  reviews:Record<string,ReturnType<typeof ReviewSchema.parse>>; lineage:DatasetLineage;
  modules:Record<typeof Categories[number],string[]>; snapshot:DatasetSnapshot;
}
const fail=(reason:string):never=>{throw new Error('dataset_invalid:'+reason);};
export function moduleIndex(cases:Pick<CaseDefinition,'id'|'category'>[]) {
  return Object.fromEntries(Categories.map(category=>[category,cases.filter(item=>item.category===category).map(item=>item.id)])) as LoadedDataset['modules'];
}
export function loadSnapshot(raw:unknown,root='archived',archived?:CompiledDataset):LoadedDataset {
  assertNoDatasetHashes(raw); const snapshot=raw as DatasetSnapshot;
  if(snapshot?.contract!=='medclaw-dataset-snapshot/v1'||snapshot.info?.version!==1||snapshot.info.scoringVersion!=='v1'||!Array.isArray(snapshot.cases)||!Array.isArray(snapshot.smokeIds)||!snapshot.gold||!snapshot.fixtures||!snapshot.review||!snapshot.sourceReferences||!Array.isArray(snapshot.productResources))fail('snapshot_contract');
  const definitions=snapshot.cases.map(item=>EvalCaseSchema.parse(item)),ids=definitions.map(item=>item.id);
  const provenance={...snapshot.caseOrigins===undefined?{}:{caseOrigins:CaseOriginsSchema.parse(snapshot.caseOrigins)},...snapshot.lineage===undefined?{}:{lineage:DatasetLineageSchema.parse(snapshot.lineage)}};
  const {compiled:_reviewedChecks,criteria:_reviewedCriteria,...reviewedData}=snapshot.review.verifiedData??{};
  if(snapshot.review.state==='verified'&&!isDeepStrictEqual(reviewedData,{info:snapshot.info,smokeIds:snapshot.smokeIds,cases:snapshot.cases,gold:snapshot.gold,fixtures:snapshot.fixtures,sourceReferences:snapshot.sourceReferences,productResources:snapshot.productResources,authoring:Object.fromEntries(Object.entries(snapshot.review.cases??{}).map(([id,review]:[string,any])=>[id,review.authoring])),...provenance}))fail('review_content_changed');
  if(new Set(ids.map(id=>id.toLowerCase())).size!==ids.length||new Set(snapshot.smokeIds).size!==snapshot.smokeIds.length||snapshot.smokeIds.some(id=>!ids.includes(id)))fail('case_or_smoke_identity');
  if(Object.keys(snapshot.gold).some(id=>!ids.includes(id))||Object.keys(snapshot.review.cases??{}).some(id=>!ids.includes(id)))fail('orphan_gold_or_review');
  const catalog=parseFixtureCatalog(snapshot.fixtures);
  const lineage:DatasetLineage=provenance.lineage??{contract:'medclaw-eval-lineage/v1',version:1,groups:[{id:'synthetic-procurement-v1',sourceRefs:['fixtures/procurement.csv'],caseIds:ids,partition:'developer_visible',exposure:'developer_visible',origin:'synthetic_authored',parentGroupIds:[],notes:'Shared explicit synthetic business facts and authoring templates'}]};
  if(snapshot.info.id==='medclaw-badcase-v1'&&!provenance.caseOrigins)fail('case_origin_identity');
  if(provenance.caseOrigins) {
    if(!provenance.lineage||Object.keys(provenance.caseOrigins).length!==ids.length||ids.some(id=>!Object.hasOwn(provenance.caseOrigins!,id)))fail('case_origin_identity');
    for(const origin of Object.values(provenance.caseOrigins))for(const ref of origin.evidenceRefs) {
      if(origin.evidencePacketRef!==`agent-eval/records/${origin.batchId}/admission-evidence.json`)fail('case_origin_evidence_identity');
      const roots=[`agent-eval/runs/business/${origin.sourceExecutionId}/evidence/${origin.sourceTrialId}/`,`agent-eval/records/${origin.batchId}/reproductions/${origin.sourceExecutionId}/evidence/${origin.sourceTrialId}/`];
      if(!roots.some(root=>ref.path===root+'observation.json'||ref.path===root+'trial.json'))fail('case_origin_evidence_identity');
    }
    if(lineage.groups.some(group=>group.partition!=='developer_visible'||group.exposure!=='developer_visible'))fail('case_origin_exposure');
  }
  if(provenance.lineage) {
    const groupIds=lineage.groups.map(group=>group.id.toLowerCase()),members=new Set(lineage.groups.flatMap(group=>group.caseIds));
    if(new Set(groupIds).size!==groupIds.length||members.size!==ids.length||ids.some(id=>!members.has(id)))fail('lineage_identity');
    for(const group of lineage.groups)if(!group.caseIds.length||!group.sourceRefs.length||group.caseIds.some(id=>!ids.includes(id))
      ||group.sourceRefs.some(ref=>!ref.startsWith('fixtures/')||!Object.hasOwn(snapshot.fixtures,ref.slice(9)))
      ||group.parentGroupIds.some(id=>id===group.id||!groupIds.includes(id.toLowerCase())))fail('lineage_reference');
  }
  for(const value of Object.values(snapshot.sourceReferences))SourceReferenceSchema.parse(value);
  const resourceIds=new Set<string>();
  for(const resource of snapshot.productResources){ProductResourceSchema.parse(resource);const id=resource.kind+':'+resource.id+'@'+resource.version;if(resourceIds.has(id)||new Set(resource.files.map(file=>file.path)).size!==resource.files.length||resource.files.some(file=>Buffer.byteLength(file.content)!==file.bytes))fail('product_resource_identity_or_bytes');resourceIds.add(id);}
  const source=snapshot.fixtures[catalog.source.ref]??fail('source_fixture_missing');
  const sources:EvalGold['sources']=[{materialRef:'materials/procurement.csv',rowKeys:[],fields:['price','status','distributor','date'],method:'Independent CSV/Decimal recomputation',original:{id:catalog.source.id,path:'materials/procurement.csv',content:source,origin:catalog.source.origin,license:catalog.source.license,obtainedAt:catalog.source.obtainedAt,businessTime:catalog.source.businessTime,author:catalog.source.author,exposure:'developer_visible',processing:catalog.source.processing,group:{id:catalog.source.id,partition:'developer_visible',parentGroupIds:[],notes:'Developer-visible synthetic material; no blind holdout claim'}}}];
  const cases:EvalCase[]=[],gold:LoadedDataset['gold']={},reviews:LoadedDataset['reviews']={};
  for(const item of definitions) {
    if(item.expected.goldRef&&item.expected.goldRef!==item.id)fail('gold_identity:'+item.id);
    const definition=GoldDefinitionSchema.parse(snapshot.gold[item.id]??fail('gold_metadata_missing:'+item.id));
    if(item.sourceRef&&!snapshot.sourceReferences[item.sourceRef])fail('source_reference_missing:'+item.id);
    const materials=fixtureMaterials(item.input.fixture.ref,snapshot.fixtures),common={id:snapshot.info.id,version:1 as const,referenceDate:snapshot.info.referenceDate,timezone:'Asia/Shanghai' as const,scoringVersion:'v1' as const,smoke:snapshot.smokeIds.includes(item.id)};
    let compiled:ReturnType<typeof compileCase>;
    if(archived){
      const recorded=archived[item.id]??fail('archived_compiled_case_missing');
      if(!Array.isArray(recorded.checks)||!recorded.checks.length||!recorded.values||new Set(recorded.checks.map(check=>check.id)).size!==recorded.checks.length)fail('archived_compiled_contract');
      for(const check of recorded.checks){CheckSpecSchema.parse(check);if(!check.id.startsWith(item.id+':')||!Object.hasOwn(recorded.values,check.evidenceKey)||check.goldKey!=='values.'+check.evidenceKey)fail('archived_check_binding');}
      for(const metric of CommonRequiredMetrics){const checks=recorded.checks.filter(check=>check.metricId===metric);if(checks.length!==1||!checks[0]!.required||(metric!=='task.success'&&(!checks[0]!.hardConstraint||checks[0]!.kind!=='deterministic')))fail('archived_required_check_missing');}
      for(const metric of [...item.scorers,'tool.selection','efficiency.calls',...(item.expected.mustHaveEvidence?['evidence.present']:[])])if(recorded.checks.filter(check=>check.metricId===metric&&(check.required||metric==='tool.error_rate'&&definition.scorerExpectations?.['tool.error_rate']?.maxRate===undefined)).length!==1)fail('archived_authored_check_missing');
      compiled={compiled:{...item,version:1,dataset:common,requires:item.expected.requiredCapabilities??[],materialRefs:Object.keys(materials),lineageGroupIds:['synthetic-procurement-v1'],input:{...item.input,materials},setup:[],steps:[],expected:{...item.expected,success:[item.expected.expectedAnswerHint],failure:item.expected.forbiddenConditions,checks:recorded.checks}},gold:{schemaVersion:1,caseId:item.id,version:1,values:recorded.values,sources}};
    }else compiled=compileCase(item,definition,materials,sources,common,catalog.profiles[item.input.fixture.ref],snapshot.productResources,fixtureConversation(snapshot.fixtures,catalog.profiles[item.input.fixture.ref]?.initialConversation?.source));
    const review=snapshot.review.cases[item.id]??fail('review_missing:'+item.id);
    reviews[item.id]=ReviewSchema.parse({schemaVersion:1,caseId:item.id,caseVersion:1,goldVersion:1,authoredBy:'MedClaw evaluation authoring',...review});
    if(snapshot.info.id==='medclaw-agent-v1'||snapshot.info.id==='medclaw-badcase-v1'||provenance.caseOrigins||provenance.lineage){
      const authoring=reviews[item.id]!.authoring??fail('authoring_review_missing:'+item.id);
      if(!item.sourceRef)fail('authoring_review_missing:'+item.id);
      if(authoring.budget.necessary+authoring.budget.verification+authoring.budget.recovery!==item.expected.maxToolCalls)fail('budget_review_mismatch:'+item.id);
      if(!isDeepStrictEqual(authoring.failures.map(failure=>failure.condition),item.expected.forbiddenConditions)||authoring.failures.some(failure=>failure.scorers.some(id=>!compiled.compiled.expected.checks.some(check=>check.metricId===id))))fail('failure_scorer_mapping:'+item.id);
      if(authoring.harness.some(id=>!compiled.compiled.expected.checks.some(check=>check.metricId===id)))fail('harness_review_mapping:'+item.id);
    }
    compiled.compiled.lineageGroupIds=lineage.groups.filter(group=>group.caseIds.includes(item.id)).map(group=>group.id);
    cases.push(compiled.compiled);gold[item.id]=compiled.gold;
  }
  const {reviewPolicy:_policy,...info}=snapshot.info;
  const manifest=DatasetManifestSchema.parse({contract:'medclaw-agent-dataset/v1',...info,readiness:snapshot.review.state==='verified'&&cases.every(item=>reviews[item.id]!.state==='verified')?'reviewed':'draft',members:ids,smoke:snapshot.smokeIds});
  const result={root,manifest,cases,gold,reviews,lineage,modules:moduleIndex(cases),snapshot};
  if(snapshot.review.state==='verified'&&(!isDeepStrictEqual(_reviewedChecks,snapshotCompiled(result))||!archived&&!isDeepStrictEqual(_reviewedCriteria,scoringCriteria(cases.flatMap(item=>item.expected.checks.map(check=>check.metricId))))))fail('review_criteria_changed');
  if(snapshot.info.id==='medclaw-agent-v1')assertStageOneCoverage(result);
  return result;
}
export async function loadDataset(location='medclaw-agent-v1'):Promise<LoadedDataset> {
  const directory=resolve(import.meta.dir,'datasets');
  const declaration=location==='medclaw-badcase-v1'?{info:badcaseDataset.datasetInfo,cases:badcaseDataset.cases,smokeIds:badcaseDataset.smokeIds,gold:badcaseGold,sourceReferences:badcaseReferences,caseOrigins:badcaseDataset.caseOrigins,lineage:badcaseDataset.lineage}
    :location==='medclaw-agent-v1'||resolve(location)===directory?{info:datasetInfo,cases:builtInCases,smokeIds,gold:goldDefinitions,sourceReferences}:null;
  if(declaration) {
    const fixtures=await loadFixtureFiles();
    const review=JSON.parse(await readFile(join(directory,declaration.info.id+'.review.json'),'utf8'));
    // Preserve the pending admission's authored conditions when its primary parent evolves.
    const frozen=declaration.info.id==='medclaw-badcase-v1'?review.verifiedData:undefined;
    if(frozen)for(const [id,authoring] of Object.entries(frozen.authoring??{}))if(review.cases[id])review.cases[id]={...review.cases[id],authoring};
    return loadSnapshot({contract:'medclaw-dataset-snapshot/v1',...declaration,...frozen?{cases:frozen.cases,gold:frozen.gold}:{},fixtures,productResources:await loadProductResources(fixtures),review},directory);
  }
  const path=resolve(location),info=await lstat(path); if(info.isSymbolicLink())fail('linked_snapshot');
  const raw=JSON.parse(await readFile(info.isDirectory()?join(path,'snapshot.json'):path,'utf8'));
  if(raw.dataset&&!raw.compiled)fail('archived_compiled_checks_missing');
  return loadSnapshot(raw.dataset??raw,path,raw.compiled);
}
export function materialFiles(ref:string,materials:EvalCase['input']['materials']) {
  RelativePathSchema.parse(ref);const material=materials[ref]??fail('unknown_material:'+ref);
  if(!ref.startsWith('materials/'))fail('material_scope');
  if(material.kind==='file'&&(material.files.length!==1||material.files[0]!.path!==basename(ref)))fail('file_identity');
  return material.files.map(file=>{RelativePathSchema.parse(file.path);if(Buffer.byteLength(file.content)!==file.bytes)fail('material_bytes');return {...file,path:material.kind==='file'?ref:ref+'/'+file.path};});
}
/** No Gold argument: only public input fixtures reach the product workspace. */
export async function materializeInputs(item:EvalCase,directory:string) {
  const root=resolve(directory),paths=new Set<string>(),files:{path:string;content:string}[]=[];
  for(const ref of item.materialRefs) {
    materialFiles(ref,item.input.materials);const material=item.input.materials[ref]!;
    for(const file of importFiles(material)) {
      const path=material.kind==='file'?ref:ref+'/'+file.path;RelativePathSchema.parse(path);
      if(paths.has(path.toLowerCase()))fail('overlapping_materials');paths.add(path.toLowerCase());
      files.push({path,content:file.content});
    }
  }
  await mkdir(root);
  for(const file of files) {
      const target=join(root,file.path);await mkdir(join(target,'..'),{recursive:true});
      if(relative(await realpath(root),await realpath(join(target,'..'))).startsWith('..'))fail('material_escape');
      await writeFile(target,file.content,{encoding:'utf8',flag:'wx'});
  }
  return root;
}
export interface PublicMaterial {ref:string;path:string;bytes:number}
export async function preparePublicMaterials(item:EvalCase,directory:string,absentRefs:readonly string[]=[]):Promise<PublicMaterial[]> {
  const root=await realpath(directory),files:PublicMaterial[]=[];
  for(const ref of item.materialRefs) {
    const material=item.input.materials[ref];
    if(material?.kind!=='file')continue;
    RelativePathSchema.parse(ref);
    if(!ref.startsWith('materials/')||material.files.length!==1)fail('public_material_invalid');
    const path=join(root,ref),file=material.files[0]!;
    let current=root;for(const part of ref.split('/')){current=join(current,part);if((await lstat(current)).isSymbolicLink())fail('linked_public_material');}
    if(await realpath(path)!==path||!(await lstat(path)).isFile()||await readFile(path,'utf8')!==file.content||Buffer.byteLength(file.content)!==file.bytes)fail('public_material_content_changed');
    files.push({ref,path,bytes:file.bytes});
  }
  for(const ref of absentRefs) {
    RelativePathSchema.parse(ref);if(!ref.startsWith('materials/'))fail('absent_material_invalid');
    try{await lstat(join(root,ref));fail('declared_absent_fixture_exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  return files;
}
export function projectInput(dataset:LoadedDataset,caseId:string,stepId:string) {
  const item=dataset.cases.find(item=>item.id===caseId)??fail('unknown_case');
  const action=item.steps.find(step=>step.id===stepId)?.action;
  if(action?.action!=='send')return fail('only_current_send');
  return {prompt:action.prompt,referenceDate:dataset.manifest.referenceDate,timezone:dataset.manifest.timezone,workspaceContext:item.input.workspaceContext,materials:item.materialRefs.flatMap(ref=>materialFiles(ref,item.input.materials)).map(({path,content,bytes})=>({path,content,bytes}))};
}
export function datasetCoverage(dataset:LoadedDataset) {
  return {modules:dataset.modules,categories:Object.fromEntries(Categories.map(category=>[category,dataset.modules[category].length])),evalTypes:Object.fromEntries(['capability','regression'].map(type=>[type,dataset.cases.filter(item=>item.evalType===type).length])),metrics:Object.fromEntries([...new Set(dataset.cases.flatMap(item=>item.expected.checks.map(check=>check.metricId)))].map(id=>[id,dataset.cases.filter(item=>item.expected.checks.some(check=>check.metricId===id)).length]))};
}
export function assertStageOneCoverage(dataset:LoadedDataset) {
  if(dataset.cases.length!==50||dataset.manifest.smoke.length!==10||Categories.some(category=>!dataset.modules[category].length))fail('50_cases_11_harness_10_smoke_required');
}
export function auditLineage(dataset:LoadedDataset) {return {groups:dataset.lineage.groups.length,developerVisibleCases:dataset.cases.length,blindHoldoutCases:0,issues:['Developer-visible synthetic fixtures; not an unseen holdout.']};}
