import { hashBytes, hashValue } from './adapters/product-checksums.ts';
import type { EvalCase, EvalGold } from './evaluation.ts';

const digestField=(key:string)=>/hash|sha256|digest|fingerprint/i.test(key);
function strip(value:any):any {
  if(Array.isArray(value))return value.map(item=>strip(item)??null);
  if(typeof value==='string') {
    try { const parsed=JSON.parse(value); if(parsed&&typeof parsed==='object'){const projected=strip(parsed);return JSON.stringify(parsed)===JSON.stringify(projected)?value:JSON.stringify(projected);} } catch {}
    if(/^(?:sha256:)?[a-f0-9]{64}$|^row:[a-f0-9]{64}$/i.test(value))return undefined;
    return value.replace(/\b[a-f0-9]{64}\b/gi,'');
  }
  if(!value||typeof value!=='object')return value;
  const result=Object.fromEntries(Object.entries(value).flatMap(([key,item])=>{const projected=strip(item);return digestField(key)||projected===undefined?[]:[[key,projected]];}));
  if(typeof result.body==='string'&&typeof result.bytes==='number')result.bytes=Buffer.byteLength(result.body);
  if(result.original!==undefined&&typeof result.bytes==='number')result.bytes=Buffer.byteLength(JSON.stringify(result.original));
  return result;
}
// The embedded format is CSV, including escaped JSON cells and quoted newlines.
export function csvRows(text:string):string[][] {
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
  for(let i=text.startsWith('\ufeff')?1:0;i<text.length;i++) {
    const char=text[i]!;
    if(quoted) {if(char==='"') {if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=char;continue;}
    if(char===','||char==='\n'||char==='\r') {
      row.push(cell);cell='';closed=false;
      if(char!==','){rows.push(row);row=[];if(char==='\r'&&text[i+1]==='\n')i++;}continue;
    }
    if(closed||char==='"'&&cell)throw new Error('dataset_invalid: malformed embedded CSV');
    if(char==='"')quoted=true;else cell+=char;
  }
  if(quoted)throw new Error('dataset_invalid: unterminated embedded CSV');
  if(row.length||cell||closed){row.push(cell);rows.push(row);}
  if(!rows.length||rows.some(row=>row.length!==rows[0]!.length))throw new Error('dataset_invalid: inconsistent embedded CSV columns');
  return rows;
}
const csvText=(rows:string[][])=>rows.map(row=>row.map(cell=>/[",\r\n]/.test(cell)?'"'+cell.replaceAll('"','""')+'"':cell).join(',')).join('\n')+'\n';
function sourceRefs(content:string,transform:(value:any)=>any) {
  const rows=csvRows(content),column=rows[0]!.indexOf('source_refs_json');
  if(column<0)return content;
  for(const row of rows.slice(1))row[column]=JSON.stringify(transform(JSON.parse(row[column]!)));
  return csvText(rows);
}
function updateManifest(files:{path:string;content:string;bytes:number}[],withHashes:boolean) {
  for(const file of files)file.bytes=Buffer.byteLength(file.content);
  const manifest=files.find(file=>file.path==='manifest.json');if(!manifest)return;
  const value=JSON.parse(manifest.content);
  value.files=value.files.map((entry:any)=>{
    const actual=files.find(file=>file.path===entry.path);if(!actual)throw new Error('dataset_invalid: missing manifest input');
    return {path:entry.path,bytes:actual.bytes,...withHashes?{sha256:hashBytes(actual.content)}:{}};
  });
  value.businessBytes=value.files.filter((entry:any)=>/^zhejiang_.*\.csv$/.test(entry.path)).reduce((sum:number,entry:any)=>sum+entry.bytes,0);
  value.totalPayloadBytes=value.files.reduce((sum:number,entry:any)=>sum+entry.bytes,0);
  manifest.content=JSON.stringify(value,null,2)+'\n';manifest.bytes=Buffer.byteLength(manifest.content);
}
/** Only transient importer inputs get checksums; controller originals never enter the input directory. */
export function importFiles(material:EvalCase['input']['materials'][string]) {
  const files=structuredClone(material.files),lockFile=files.find(file=>file.path==='source-lock.json');
  if(material.kind!=='directory'||!lockFile)return files;
  const lock=JSON.parse(lockFile.content),digests=new Map<string,string>();
  for(const entry of lock.sources) {
    if(!material.sourceContent)throw new Error('dataset_invalid: import public source missing: '+entry.path);
    entry.sha256=hashBytes(material.sourceContent);digests.set(entry.source+'\n'+entry.path,entry.sha256);
  }
  lockFile.content=JSON.stringify(lock,null,2)+'\n';
  const entity=files.find(file=>file.path==='entity-lineage.csv');if(!entity)throw new Error('dataset_invalid: entity lineage missing');
  const [headers,...rows]=csvRows(entity.content);
  const masters=rows.map(row=>Object.fromEntries(headers!.map((key,index)=>[key,row[index]!]))).filter(row=>row.record_type==='master').sort((a,b)=>a.device_id!.localeCompare(b.device_id!,'en'));
  for(const file of files.filter(file=>/^zhejiang_.*\.csv$/.test(file.path))) {
    file.content=sourceRefs(file.content,refs=>refs.map((ref:any)=>{
      const sha256=digests.get(ref.sourceId+'\n'+ref.file);if(!sha256)throw new Error('dataset_invalid: unknown import source');
      return {...ref,sha256};
    }));
    const metadata=files.find(item=>item.path===file.path.replace('.csv','.metadata.json'));if(!metadata)throw new Error('dataset_invalid: metadata missing');
    metadata.content=JSON.stringify({...JSON.parse(metadata.content),sourceLockHash:hashValue(lock),cohortHash:hashValue(masters),fileSha256:hashBytes(file.content)},null,2)+'\n';
  }
  updateManifest(files,true);return files;
}

export function assertNoDatasetHashes(record:unknown) {
  const visit=(value:unknown):void=>{
    if(typeof value==='string') {if(/[a-f0-9]{64}|^@runtime:[a-z0-9_.:-]*hash[a-z0-9_.:-]*$/i.test(value))throw new Error('dataset_invalid: stored digest or hash placeholder');}
    else if(Array.isArray(value))value.forEach(visit);
    else if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)) {
      if(digestField(key))throw new Error('dataset_invalid: stored digest field: '+key);visit(item);
    }
  };
  visit(record);
  const materials=(record as EvalCase)?.input?.materials;
  for(const material of Object.values(materials??{}))for(const file of material.files) {
    if(file.path.endsWith('.json'))visit(JSON.parse(file.content));
    else if(file.path.endsWith('.csv'))sourceRefs(file.content,refs=>{visit(refs);return refs;});
  }
}

/** Product protocol checks happen before this archive projection. */
export const projectPublicEvidence = <T>(value:T):T => strip(value) as T;
