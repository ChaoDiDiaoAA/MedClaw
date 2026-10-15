import type { EvalCase, EvalGold } from './evaluation.ts';

const digestField=(key:string)=>/hash|sha256|digest|fingerprint/i.test(key);
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
