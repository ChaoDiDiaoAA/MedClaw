import {test,expect} from 'bun:test';
import {loadDataset,loadSnapshot} from '../../src/datasets.ts';

test('verified review binds the time basis and Smoke selection as actual content',async()=>{
  const dataset=await loadDataset();
  expect(dataset.snapshot.review.state).toBe('verified');
  for(const mutate of [
    (s:typeof dataset.snapshot)=>{s.info.referenceDate='2027-10-02';},
    (s:typeof dataset.snapshot)=>{s.smokeIds[0]=s.cases.find(item=>!s.smokeIds.includes(item.id))!.id;},
  ]) {
    const snapshot=structuredClone(dataset.snapshot);mutate(snapshot);
    expect(()=>loadSnapshot(snapshot)).toThrow('review_content_changed');
  }
});
test('same v1 identity does not conceal changed business content',async()=>{
  const dataset=await loadDataset(),snapshot=structuredClone(dataset.snapshot);
  const facts=snapshot.cases[0]!.expected.expectedFacts as any;facts.facts.numeric[0].value=9999;
  if(snapshot.review.state==='verified')expect(()=>loadSnapshot(snapshot)).toThrow('review_content_changed');
  snapshot.review.state='pending';for(const item of Object.values(snapshot.review.cases) as any[])item.state='pending';
  const changed=loadSnapshot(snapshot);
  expect(changed.manifest.version).toBe(1);
  expect(changed.snapshot).not.toEqual(dataset.snapshot);
  expect(changed.gold[changed.cases[0]!.id]!.values.query_numeric).toEqual([{id:'SYN-ZJ-A@synthetic-zj-v1',value:9999,unit:'CNY cents'}]);
});
