import {test,expect} from 'bun:test';
import {loadDataset,loadSnapshot,materializeInputs,materialFiles} from '../../src/datasets.ts';
import {assertNoDatasetHashes} from '../../src/data-format.ts';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeJsonExclusive} from '../../src/reports/write.ts';
test('authored dataset rejects digest fields and embedded digest placeholders',async()=>{
  const dataset=await loadDataset();expect(()=>assertNoDatasetHashes(dataset.snapshot)).not.toThrow();
  for(const value of [{reportHash:'x'},{metadata:{digest:'x'}},{id:'a'.repeat(64)},{input:'@runtime:context-hash'}])expect(()=>assertNoDatasetHashes(value)).toThrow();
  const changed=structuredClone(dataset.snapshot) as any;changed.info.version=2;expect(()=>loadSnapshot(changed)).toThrow();
});
test('materialized product inputs preserve the authored files byte for byte',async()=>{
  const dataset=await loadDataset(),item=dataset.cases.find(item=>item.materialRefs.some(ref=>item.input.materials[ref]!.kind==='directory'))!;
  const root=await mkdtemp(join(tmpdir(),'mc-hashless-input-'));
  try {
    const inputs=join(root,'inputs');await materializeInputs(item,inputs);
    for(const ref of item.materialRefs)for(const file of materialFiles(ref,item.input.materials))expect(await readFile(join(inputs,file.path),'utf8')).toBe(file.content);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('evidence archive retains original content and opaque identifiers',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-original-evidence-'));
  try {
    const record={callId:'c',body:'{"text":"hello","oldMetadata":{"contentHash":"historical"}}\n',opaqueId:'a'.repeat(64)};
    await writeJsonExclusive(join(root,'original.json'),record);
    expect(JSON.parse(await readFile(join(root,'original.json'),'utf8'))).toEqual(record);
  } finally {await rm(root,{recursive:true,force:true});}
});
