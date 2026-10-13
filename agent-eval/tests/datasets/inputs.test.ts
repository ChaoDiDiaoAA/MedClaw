import {test,expect} from 'bun:test';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {loadDataset,materializeInputs} from '../../src/datasets.ts';
import {checkSnapshotPackage} from '../../../packages/core/src/data/import-service.ts';
test('only public fixtures become transient importer inputs; Gold is never needed',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-input-v1-'));
  try {
    const dataset=await loadDataset(),item=dataset.cases[0]!,before=JSON.stringify(item);
    const path=await materializeInputs(item,join(root,'inputs'));
    expect(await readdir(path)).toEqual(['materials']);
    for(const region of ['zj','hn']){const pkg=await checkSnapshotPackage(join(path,'materials/'+region+'-snapshot'));expect(pkg.rowCount).toBe(12);expect(pkg.days).toHaveLength(4);}
    expect(JSON.stringify(item)).toBe(before);
    expect(await Bun.file(join(path,'gold')).exists()).toBe(false);
    expect(await readFile(join(path,'materials/procurement.csv'),'utf8')).toBe(dataset.snapshot.fixtures['procurement.csv']!);
    await expect(materializeInputs(item,path)).rejects.toThrow();
    const bad=structuredClone(item);bad.input.materials[bad.materialRefs[0]!]!.files[0]!.path='../escape';await expect(materializeInputs(bad,join(root,'bad'))).rejects.toThrow();
    expect(await Bun.file(join(root,'bad/materials/zj-snapshot/source-lock.json')).exists()).toBe(false);
    const restricted=dataset.cases.find(item=>item.input.fixture.ref==='zj-only')!;
    expect(restricted.input.materials['materials/procurement.csv']!.files[0]!.content).not.toContain('河南');
    expect((dataset.gold[restricted.id]!.values.security_scope as any).allowedIds.every((id:string)=>id.includes('SYN-ZJ'))).toBe(true);
  }finally{await rm(root,{recursive:true,force:true});}
});
