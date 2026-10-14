import {expect,test} from 'bun:test';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadDataset,materializeInputs,preparePublicMaterials} from '../../src/datasets.ts';
import {ActionExecutor} from '../../src/adapters/actions.ts';
import {ProductAdapter} from '../../src/adapters/product.ts';
import {reportFixture} from '../report-fixture.ts';

test('current public attachments have readable verified paths, without private or import-protocol files',async()=>{
  const dataset=await loadDataset('medclaw-agent-v1'),task=dataset.cases.find(item=>item.id==='mc-v1-security-injection')!;
  const root=await mkdtemp(join(tmpdir(),'mc-attachments-'));
  try {
    const inputRoot=await materializeInputs(task,join(root,'inputs'));
    const attachments=await preparePublicMaterials(task,inputRoot);
    expect(attachments.map(item=>item.ref)).toContain('materials/source-audit.md');
    expect(attachments.every(item=>!item.ref.includes('snapshot/')&&!item.ref.includes('private')&&!item.ref.includes('gold'))).toBe(true);
    for(const file of attachments)expect(await readFile(file.path,'utf8')).toBe(task.input.materials[file.ref]!.files[0]!.content);
    await writeFile(attachments[0]!.path,'changed');
    let failure:unknown;try{await preparePublicMaterials(task,inputRoot);}catch(error){failure=error;}
    expect(failure).toBeInstanceOf(Error);
    const product=new ProductAdapter({dataRoot:root,tracePath:join(root,'events.jsonl')});
    const executor=new ActionExecutor(product,reportFixture().config,inputRoot,root,[],attachments,()=>preparePublicMaterials(task,inputRoot));
    let submissionError:unknown;try{await executor.execute({action:'send',sessionAlias:'missing',alias:'current',prompt:'Current input',referenceDate:'2026-10-02'});}catch(error){submissionError=error;}
    expect((submissionError as Error).message).toBe('dataset_invalid:public_material_content_changed');
    expect(product.traces).toHaveLength(0);
  } finally {await rm(root,{recursive:true,force:true});}
});
