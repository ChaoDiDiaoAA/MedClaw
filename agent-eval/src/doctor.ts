import { readFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { loadDataset,type LoadedDataset } from './datasets.ts';
import type { ResolvedRunConfig } from './types.ts';
const root=resolve(import.meta.dir,'../..');
export async function sourceInventory():Promise<Record<string,unknown>> {
  const packageText=await readFile(join(root,'package.json'),'utf8'),manifest=JSON.parse(packageText);
  const installed=JSON.parse(await readFile(join(root,'node_modules/@earendil-works/pi-coding-agent/package.json'),'utf8'));
  const patch=Object.values(manifest.patchedDependencies??{})[0] as string|undefined;
  const resources=Object.fromEntries(await Promise.all([...new Bun.Glob('**/*').scanSync({cwd:join(root,'resources'),onlyFiles:true})].sort().map(async path=>{const content=await readFile(join(root,'resources',path),'utf8');return [path.replaceAll('\\','/'),content];})));
  let patchContent='missing';if(patch)try{patchContent=await readFile(join(root,patch),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const paths=['apps/host/src','apps/desktop/src/main','packages','agent-eval/src'].flatMap(folder=>[...new Bun.Glob('**/*.{ts,py}').scanSync({cwd:join(root,folder),onlyFiles:true})].map(path=>folder+'/'+path.replaceAll('\\','/'))).sort();
  const files=Object.fromEntries(await Promise.all(paths.map(async path=>{const content=await readFile(join(root,path),'utf8');return [path,content];})));
  return {sdk:installed.version,patch:patchContent,packageJson:packageText,resources,files};
}
export function runBlockers(dataset:LoadedDataset,source:Record<string,unknown>,config?:ResolvedRunConfig,judge?:{required:boolean;configured:boolean}) {
  const blockers:string[]=[];
  if(source.sdk!=='0.87.1')blockers.push('sdk_version_mismatch');
  if(source.patch==='missing')blockers.push('declared_subagent_patch_missing');
  if(dataset.manifest.readiness!=='reviewed')blockers.push('dataset_review_pending');
  if(judge?.required&&!judge.configured)blockers.push('independent_judge_unconfigured');
  return blockers;
}
export async function doctor(datasetRoot='medclaw-agent-v1') {
  const source=await sourceInventory(),dataset=await loadDataset(datasetRoot),blockers=runBlockers(dataset,source);
  return {contract:'medclaw-eval-doctor/v1',source:{sdk:source.sdk,patchPresent:source.patch!=='missing'},dataset:{id:dataset.manifest.id,version:1,readiness:dataset.manifest.readiness,cases:dataset.cases.length,smoke:dataset.manifest.smoke.length},ready:blockers.length===0,blockers,quality:'NOT_RUN'};
}
