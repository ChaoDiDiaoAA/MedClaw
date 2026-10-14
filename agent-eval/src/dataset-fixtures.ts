import { parseAuthoredSource, scopeKey } from './independent-gold.ts';
import { FixtureCatalogSchema, ProductResourceSchema, type ProductResource, type EvalCase } from './evaluation.ts';
import {csvRows} from './data-format.ts';
import { readFile, lstat, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {DEFAULT_COMPACTION_SETTINGS,estimateTokens,findCutPoint,type SessionEntry} from '@earendil-works/pi-coding-agent';
import {z} from 'zod';

export const fixtureIds = ['procurement','zj-only','source-audit','injected-guide','private-canary','missing-guide','query-skill','query-timeout-once','compaction-history'] as const;
export const FixtureCatalogFile = 'medclaw-agent-v1.fixtures.json';

export function fixtureInventory(catalog: ReturnType<typeof FixtureCatalogSchema.parse>) {
  return [...new Set([FixtureCatalogFile, catalog.source.ref, ...Object.values(catalog.profiles).flatMap(profile => [...profile.files, ...profile.controllerFiles,...profile.initialConversation?[profile.initialConversation]:[]].map(file => file.source))])].sort();
}
export function parseFixtureCatalog(files: Record<string, string>) {
  const catalog = FixtureCatalogSchema.parse(JSON.parse(files[FixtureCatalogFile] ?? 'null'));
  if(fixtureIds.filter(id=>id!=='compaction-history').some(id=>!catalog.profiles[id])||Object.keys(catalog.profiles).some(id=>!fixtureIds.includes(id as typeof fixtureIds[number])))throw new Error('fixture_profiles_invalid');
  if (catalog.profiles['zj-only']!.regions.join() !== '浙江' || catalog.profiles['zj-only']!.files.length || catalog.profiles['private-canary']!.controllerFiles.length !== 1) throw new Error('fixture_scope_invalid');
  const expected = fixtureInventory(catalog);
  if (Object.keys(files).sort().join() !== expected.join()) throw new Error('fixture_inventory_invalid');
  for (const [ref, profile] of Object.entries(catalog.profiles)) {
    if (profile.files.some(file => file.source === 'privacy-canary.txt')) throw new Error('controller_fixture_in_public_input');
    if (profile.controllerFiles.length && ref !== 'private-canary') throw new Error('controller_fixture_profile_invalid');
    if (profile.resources && (ref !== 'query-skill' || profile.resources.skills.length !== 1 || profile.resources.skills[0]?.id !== 'query')) throw new Error('fixture_resources_invalid');
    if (profile.controlledToolFault && ref !== 'query-timeout-once') throw new Error('fixture_fault_invalid');
    if(profile.initialConversation&&(ref!=='compaction-history'||profile.initialConversation.source!=='procurement-handoff.json'))throw new Error('fixture_conversation_invalid');
    const paths = profile.files.map(file => file.path.toLowerCase());
    if (new Set(paths).size !== paths.length || paths.some(path => path === 'materials/procurement.csv' || /^materials\/(zj|hn)-snapshot(?:\/|$)/.test(path))) throw new Error('overlapping_fixture_files');
  }
  for (const name of expected) if (typeof files[name] !== 'string' || !files[name]!.trim()) throw new Error('fixture_file_missing:' + name);
  return catalog;
}
const HandoffSchema=z.strictObject({contract:z.literal('medclaw-procurement-handoff/v1'),origin:z.literal('synthetic_authored'),author:z.string().min(1),license:z.literal('CC0-1.0'),method:z.string().min(1),rounds:z.array(z.strictObject({id:z.string().min(1),prompt:z.string().min(1).max(18000)})).length(8)});
export function fixtureConversation(files:Record<string,string>,source?:string):string[] {
  if(!source)return [];
  const handoff=HandoffSchema.parse(JSON.parse(files[source]??'null'));
  if(new Set(handoff.rounds.map(turn=>turn.id)).size!==handoff.rounds.length||new Set(handoff.rounds.map(turn=>turn.prompt)).size!==handoff.rounds.length)throw new Error('duplicate_handoff_turn');
  return handoff.rounds.map(turn=>turn.prompt);
}
export function compactionHistoryEligibility(prompts:readonly string[]) {
  const entries:SessionEntry[]=prompts.map((content,index)=>({type:'message',id:'estimate-'+index,parentId:index?'estimate-'+(index-1):null,timestamp:new Date(0).toISOString(),message:{role:'user',content,timestamp:0}}));
  const estimatedTokens=entries.reduce((total,entry)=>total+(entry.type==='message'?estimateTokens(entry.message):0),0),keepRecentTokens=DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
  const cut=findCutPoint(entries,0,entries.length,keepRecentTokens);
  return {estimatedTokens,keepRecentTokens,firstKeptEntryIndex:cut.firstKeptEntryIndex,sourceInPrefix:cut.firstKeptEntryIndex>0};
}
export async function loadFixtureFiles(directory = join(import.meta.dir, 'fixtures')) {
  const root = resolve(directory);
  if ((await lstat(root)).isSymbolicLink() || !(await lstat(root)).isDirectory()) throw new Error('linked_fixture_root');
  const read = async (name: string) => {
    const path = join(root, name), info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || (await realpath(path)) !== join(await realpath(root), name)) throw new Error('linked_fixture_file');
    return readFile(path, 'utf8');
  };
  const manifest = await read(FixtureCatalogFile);
  const catalog = FixtureCatalogSchema.parse(JSON.parse(manifest));
  const files = Object.fromEntries(await Promise.all(fixtureInventory(catalog).map(async name => [name, name === FixtureCatalogFile ? manifest : await read(name)])));
  parseFixtureCatalog(files);
  return files;
}

/** Capture actual product files once; archives never reopen the installed resource. */
export async function loadProductResources(files:Record<string,string>, repository=resolve(import.meta.dir,'../..')):Promise<ProductResource[]> {
  const catalog=parseFixtureCatalog(files),selected=new Map<string,{id:string;version:'v1'}>();
  for(const profile of Object.values(catalog.profiles))for(const skill of profile.resources?.skills??[])selected.set(skill.id,skill);
  const resources:ProductResource[]=[];
  for(const skill of selected.values()) {
    if(skill.id!=='query')throw new Error('unsupported_product_resource');
    const directory=join(repository,'resources','skills',skill.id,skill.version),root=await realpath(directory);
    if((await lstat(directory)).isSymbolicLink())throw new Error('linked_product_resource');
    const captured=[];
    for(const path of ['SKILL.md','references/facts-and-assumptions.md']) {
      let current=directory;for(const part of path.split('/')){current=join(current,part);if((await lstat(current)).isSymbolicLink())throw new Error('linked_product_resource');}
      if(await realpath(current)!==join(root,path))throw new Error('product_resource_escape');
      const content=await readFile(current,'utf8');captured.push({path,content,bytes:Buffer.byteLength(content)});
    }
    resources.push(ProductResourceSchema.parse({kind:'skill',...skill,files:captured}));
  }
  return resources;
}

/** Controller-only synthetic files never become public materials. */
export async function materializeControlFixtures(ref: string, files: Record<string, string>, workRoot: string) {
  const profile = parseFixtureCatalog(files).profiles[ref];
  if (!profile) throw new Error('unknown_fixture:' + ref);
  if (!profile.controllerFiles.length) return;
  const root = resolve(workRoot);
  if ((await lstat(root)).isSymbolicLink()) throw new Error('linked_fixture_root');
  const privateRoot = join(root, 'private');
  await mkdir(privateRoot);
  if ((await realpath(privateRoot)) !== join(await realpath(root), 'private')) throw new Error('controller_fixture_escape');
  for (const file of profile.controllerFiles) await writeFile(join(root, file.path), files[file.source]!, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
const csv = (rows: unknown[][]) => rows.map(row => row.map(value => {
  const text = value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? '"'+text.replaceAll('"','""')+'"' : text;
}).join(',')).join('\n')+'\n';

/** Public source transformation only. No expected answer, Gold or review data is accepted. */
export function fixtureMaterials(ref: string, inputs: Record<string, string>): EvalCase['input']['materials'] {
  const catalog = parseFixtureCatalog(inputs), profile = catalog.profiles[ref];
  if (!profile) throw new Error('unknown_fixture:'+ref);
  let source = inputs[catalog.source.ref]!;
  if(profile.regions.length < 2) {const [header,...rows]=csvRows(source);source=csv([header!,...rows.filter(row=>profile.regions.includes(row[6] as '浙江' | '河南'))]);}
  const rows = parseAuthoredSource(source), result: EvalCase['input']['materials'] = {};
  for (const region of profile.regions) {
    const items = rows.filter(row=>row.region===region), dates=[...new Set(items.map(row=>row.date))].sort();
    const files: {path:string;content:string;bytes:number}[]=[];
    const put=(path:string, content:unknown)=>{const text=typeof content==='string'?content:JSON.stringify(content,null,2)+'\n'; files.push({path,content:text,bytes:Buffer.byteLength(text)});};
    put('source-lock.json',{schema:'medclaw.source-lock/v1',sources:[{source:catalog.source.id,path:'materials/procurement.csv',origin:'synthetic',author:catalog.source.author,license:catalog.source.license}]});
    const masters=items.filter(row=>row.date===dates[0]).map(row=>({record_type:'master',device_id:row.device,device_name:row.name,source_submission_id:row.submission,source_applicant:row.applicant,category:row.category}));
    put('entity-lineage.csv',csv([Object.keys(masters[0]!),...masters.map(row=>Object.values(row))]));
    for(const date of dates) {
      const day=items.filter(row=>row.date===date), name=`zhejiang_${date}.csv`;
      const columns=['device_id','device_name','source_submission_id','source_applicant','category','region','snapshot_date','price_cents','currency','unit','status','manufacturer','distributor','source_refs_json','field_origins_json'];
      put(name,csv([columns,...day.map(row=>[row.device,row.name,row.submission,row.applicant,row.category,row.region,row.date,row.price,'CNY','件',row.status,row.manufacturer,row.distributor,[{sourceId:'synthetic-procurement-v1',file:'materials/procurement.csv',recordId:row.key,row:rows.findIndex(value=>value.key===row.key)+2}],Object.fromEntries(columns.slice(0,13).map(field=>[field,{kind:'synthetic',ruleId:'authored-table-direct/v1'}]))])]));
      put(name.replace('.csv','.metadata.json'),{contract:'medclaw.snapshot/v1',mappingVersion:'medclaw.snapshot/v1',materialVersion:'eval-synthetic/v1',generatorVersion:'direct-mapping/v1',seed:0,sourceBundleId:`eval-${scopeKey(region)}`,scopeKey:scopeKey(region),region,snapshotDate:date,coverage:'full',expectedEntityCount:3,observedEntityCount:day.length,declaredMissingEntityIds:[],referenceDate:'2026-10-02',timezone:'Asia/Shanghai'});
    }
    put('adjustment-lineage.csv','record_type,rule_id,description\nnone,authored-table-direct/v1,Direct fictional source mapping\n');
    put('selection-report.json',{status:'authored_synthetic',entities:3,blindHoldout:false});
    put('validation-report.json',{status:'author_self_check_only',rowCount:items.length,qualityRuns:'NOT_RUN'});
    put('使用说明.md',`# Synthetic procurement material: ${region}\nAmounts are integer CNY cents; zero and missing values differ. September 30 has no snapshot. The zhejiang_ prefix is the product import format; the region field defines the actual region.\n`);
    put('manifest.json',{status:'complete',files:files.map(file=>({path:file.path,bytes:file.bytes})),businessFiles:dates.length,businessRows:items.length,businessBytes:files.filter(file=>/^zhejiang_.*\.csv$/.test(file.path)).reduce((n,file)=>n+file.bytes,0),totalPayloadBytes:files.reduce((n,file)=>n+file.bytes,0)});
    result[`materials/${region==='浙江'?'zj':'hn'}-snapshot`]={kind:'directory',files,sourceContent:source};
  }
  const addFile=(path:string,content:string)=>{result[path]={kind:'file',files:[{path:path.split('/').at(-1)!,content,bytes:Buffer.byteLength(content)}]};};
  addFile('materials/procurement.csv',source);
  for (const file of profile.files) addFile(file.path, inputs[file.source]!);
  const publicPaths = Object.entries(result).flatMap(([path, material]) => material.files.map(file => (material.kind === 'file' ? path : path + '/' + file.path).toLowerCase()));
  if (profile.absentFiles.some(path => publicPaths.includes(path.toLowerCase()))) throw new Error('declared_absent_fixture_exists');
  return result;
}
