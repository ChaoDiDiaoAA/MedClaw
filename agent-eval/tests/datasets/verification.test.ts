import {test,expect} from 'bun:test';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {recordDataChecks} from '../../scripts/record-data-checks.ts';
import {loadDataset} from '../../src/datasets.ts';
test('independent Python verifier is read-only and retains checks under optimization',async()=>{
  const source=join(import.meta.dir,'../../src/datasets/medclaw-agent-v1.review.json'),before=await readFile(source,'utf8');
  const cwd=await mkdtemp(join(tmpdir(),'mc-verify-cwd-'));
  try { for(const flags of [[],['-O']]) {
    const proc=Bun.spawn(['python',...flags,join(import.meta.dir,'../../scripts/verify-stage-one.py')],{cwd,stdout:'pipe',stderr:'pipe'});
    const output=await new Response(proc.stdout).text(),error=await new Response(proc.stderr).text();expect(await proc.exited).toBe(0);expect(error).toBe('');
    const result=JSON.parse(output);expect(result).toMatchObject({status:'passed',cases:50,sourceRows:24,qualityRuns:'NOT_RUN'});expect(result.assertions).toBeGreaterThan(100);
  } } finally { await rm(cwd,{recursive:true,force:true}); }
  expect(await readFile(source,'utf8')).toBe(before);
},30000);
test('data review refuses missing or changed verification input content',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-verify-'));
  try {await expect(recordDataChecks(join(root,'missing.json'))).rejects.toThrow();}finally{await rm(root,{recursive:true,force:true});}
},30000);

test('independent verifier rejects invalid authored contracts and changed product resources in both Python modes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-verify-contract-'));
  try {
    const path=join(root,'snapshot.json');await writeFile(path,JSON.stringify((await loadDataset()).snapshot));
    const script=`import copy, importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location('verify_stage_one', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8'))
mutations = [
    lambda value: value['cases'][0]['expected'].pop('maxToolCalls'),
    lambda value: value['cases'][0]['expected'].__setitem__('maxToolCalls', True),
    lambda value: value['cases'][0]['expected'].__setitem__('maxToolCalls', 1.5),
    lambda value: value['cases'][0]['expected'].__setitem__('mustHaveEvidence', 'true'),
    lambda value: value['cases'][0].__setitem__('sourceRef', 'invented-source'),
    lambda value: value['cases'][0].__setitem__('category', 'tool'),
    lambda value: value['review']['cases'][value['cases'][0]['id']]['authoring']['budget'].__setitem__('necessary', 999),
    lambda value: value['productResources'][0]['files'][0].update(content='fabricated Skill content', bytes=len('fabricated Skill content'.encode('utf-8'))),
    lambda value: value['sourceReferences'][value['cases'][0]['sourceRef']].__setitem__('section', 'invented section'),
    lambda value: value['gold'][value['cases'][0]['id']].setdefault('scorerExpectations', {}).__setitem__('resource.progressive_read', {'requiredRefs': ['materials/source-audit.md'], 'maxBytes': 8192}),
    lambda value: value['gold'][value['cases'][0]['id']]['rubric']['answer.faithful'].pop('fail'),
    lambda value: value['review']['cases'][value['cases'][0]['id']]['authoring']['failures'][0].__setitem__('scorers', ['invented.scorer']),
]
for index, mutate in enumerate(mutations):
    value = copy.deepcopy(original)
    mutate(value)
    try:
        module.verify(value)
    except (ValueError, KeyError):
        continue
    raise RuntimeError('invalid authored contract accepted: ' + str(index))
print(json.dumps({'rejected': len(mutations)}))`;
    for(const flags of [[],['-O']]) {
      const proc=Bun.spawn(['python',...flags,'-c',script,join(import.meta.dir,'../../scripts/verify-stage-one.py'),path],{cwd:root,stdout:'pipe',stderr:'pipe'});
      const output=await new Response(proc.stdout).text(),error=await new Response(proc.stderr).text();
      expect(error).toBe('');expect(await proc.exited).toBe(0);expect(JSON.parse(output).rejected).toBe(12);
    }
  } finally {await rm(root,{recursive:true,force:true});}
},30000);

test('recording data checks requires the actual product Skill inputs and their unchanged content',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-verify-skill-'));
  try {
    const path=join(root,'checks.json');
    const proc=Bun.spawn(['python',join(import.meta.dir,'../../scripts/verify-stage-one.py'),'--output',path],{cwd:root,stdout:'pipe',stderr:'pipe'});
    const error=await new Response(proc.stderr).text();await new Response(proc.stdout).text();expect(error).toBe('');expect(await proc.exited).toBe(0);
    const original=JSON.parse(await readFile(path,'utf8'));
    const skill='../../resources/skills/query/v1/SKILL.md',reference='../../resources/skills/query/v1/references/facts-and-assumptions.md';
    expect(original.inputs[skill]).toContain('name: query');expect(original.inputs[reference]).toContain('Facts and assumptions');
    const missing=structuredClone(original);delete missing.inputs[skill];await writeFile(path,JSON.stringify(missing));
    await expect(recordDataChecks(path)).rejects.toThrow('verification_inputs_incomplete');
    const changed=structuredClone(original);changed.inputs[reference]+='\nchanged';await writeFile(path,JSON.stringify(changed));
    await expect(recordDataChecks(path)).rejects.toThrow('verification_inputs_changed');
  } finally {await rm(root,{recursive:true,force:true});}
},30000);
