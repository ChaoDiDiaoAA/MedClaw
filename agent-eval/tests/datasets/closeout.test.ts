import {test,expect} from 'bun:test';
import {loadDataset,loadSnapshot} from '../../src/datasets.ts';
import {loadFixtureFiles} from '../../src/dataset-fixtures.ts';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

for(const autoCRLF of ['true','false'])test(`Git checkout keeps reviewed fixture bytes with core.autocrlf=${autoCRLF}`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-fixture-checkout-'));
  try {
    const git=(...args:string[])=>{
      const result=Bun.spawnSync(['git','-c',`core.autocrlf=${autoCRLF}`,'-c','core.safecrlf=false','-C',root,...args],{stdout:'pipe',stderr:'pipe'});
      if(result.exitCode!==0)throw new Error(new TextDecoder().decode(result.stderr));
    };
    const review=JSON.parse(await readFile(join(import.meta.dir,'../../src/datasets/medclaw-agent-v1.review.json'),'utf8'));
    const {compiled,criteria,authoring,...recorded}=review.verifiedData;
    const fixtures=await loadFixtureFiles(),directory=join(root,'agent-eval/src/fixtures');
    await mkdir(directory,{recursive:true});
    await writeFile(join(root,'.gitattributes'),await readFile(resolve(import.meta.dir,'../../../.gitattributes')));
    for(const name of Object.keys(fixtures))await writeFile(join(directory,name),await readFile(join(import.meta.dir,'../../src/fixtures',name)));
    git('init','--quiet');git('add','--force','.gitattributes','agent-eval/src/fixtures');git('checkout-index','--force','--all');
    const checkedOut=await loadFixtureFiles(directory);
    for(const [name,content] of Object.entries(checkedOut)) {
      expect(content).not.toContain('\r\n');
      expect(content===recorded.fixtures[name]).toBe(true);
    }
    const dataset=loadSnapshot({contract:'medclaw-dataset-snapshot/v1',...recorded,fixtures:checkedOut,review});
    expect(dataset.cases).toHaveLength(50);expect(dataset.manifest.smoke).toHaveLength(10);
  } finally {await rm(root,{recursive:true,force:true});}
},30000);

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
