import {test,expect} from 'bun:test';
import {loadDataset,loadSnapshot,projectInput} from '../../src/datasets.ts';
import {datasetFixture} from '../report-fixture.ts';
test('loader rejects duplicate identities, unknown references and hidden authoring fields',async()=>{
  const original=datasetFixture();
  for(const mutate of [(s:any)=>s.cases.push(s.cases[0]),(s:any)=>s.smokeIds.push('missing'),(s:any)=>s.cases[0].scorers.push('unknown.metric'),(s:any)=>s.cases[0].input.fixture.ref='missing',(s:any)=>s.cases[0].input.materials={},(s:any)=>s.cases[0].expected.goldRef='another-case',(s:any)=>s.cases[0].expected.expectedFacts=undefined]) {
    const snapshot=structuredClone(original);mutate(snapshot);expect(()=>loadSnapshot(snapshot)).toThrow();
  }
  expect((await loadDataset()).manifest.version).toBe(1);
});
test('input projection cannot reveal Gold, review policy or future user instructions',async()=>{
  const dataset=await loadDataset(),item=dataset.cases.find(item=>item.category==='context'&&item.input.turns?.some(step=>step.action.action==='send'))!;
  const projection=projectInput(dataset,item.id,'turn-1');
  expect(projection.prompt).toBe(item.input.prompt);
  expect(projection).not.toHaveProperty('gold');
  expect(projection).not.toHaveProperty('expected');
  const turn=item.input.turns!.find(step=>step.action.action==='send')!;
  expect(JSON.stringify(projection)).not.toContain((turn.action as {prompt:string}).prompt);
  expect(()=>projectInput(dataset,item.id,'read-final')).toThrow();
});
