import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runConfigFixture,reportFixture,saveReportFixture} from './report-fixture.ts';

async function configuredRoot(environment:string) {
  const root=await mkdtemp(join(tmpdir(),'mc-presets-'));
  await mkdir(join(root,'agent-eval/configs'),{recursive:true});
  await writeFile(join(root,'agent-eval/configs/agent.json'),JSON.stringify(runConfigFixture()));
  await writeFile(join(root,'agent-eval/configs/environment'),environment);
  return root;
}
const judgeEnvironment='# 中文注释\nMEDCLAW_JUDGE_BASE_URL="https://judge.example.invalid/v1"\nMEDCLAW_JUDGE_MODEL="independent judge"\nMEDCLAW_JUDGE_API_KEY=local-judge-key\nMEDCLAW_EVAL_BACKEND=langfuse\n';

test('presets reject missing, duplicate and cross-mode arguments',async()=>{
  const {parsePreset}=await import('../src/presets.ts');
  expect(parsePreset(['smoke','--','--check'])).toEqual({mode:'smoke',check:true});
  expect(parsePreset(['full'])).toEqual({mode:'full',check:false});
  for(const args of [[],['unknown'],['smoke','--freeze','x'],['full','--execution-id','x'],['upload'],['upload','--execution-id','../x'],['smoke','--check','--check'],['full','--freeze','archive'],['upload','--execution-id','a','--execution-id','b'],['smoke','--judge-output-budget','256']])expect(()=>parsePreset(args)).toThrow();
});

test('fixed environment parsing handles comments and quotes without Shell fallback or global mutation',async()=>{
  const {readPresetEnvironment,mainPreset}=await import('../src/presets.ts');
  const root=await configuredRoot(judgeEnvironment);
  const old=process.env.MEDCLAW_JUDGE_API_KEY;
  process.env.MEDCLAW_JUDGE_API_KEY='shell-must-not-win';
  try {
    expect(await readPresetEnvironment(root)).toMatchObject({MEDCLAW_JUDGE_MODEL:'independent judge',MEDCLAW_JUDGE_API_KEY:'local-judge-key'});
    expect(process.env.MEDCLAW_JUDGE_API_KEY).toBe('shell-must-not-win');
    await writeFile(join(root,'agent-eval/configs/environment'),judgeEnvironment.replace('MEDCLAW_JUDGE_API_KEY=local-judge-key',''));
    await expect(mainPreset(['smoke','--check'],root,()=>{})).rejects.toThrow('Partial');
    expect(process.env.MEDCLAW_JUDGE_API_KEY).toBe('shell-must-not-win');
  } finally {if(old===undefined)delete process.env.MEDCLAW_JUDGE_API_KEY;else process.env.MEDCLAW_JUDGE_API_KEY=old;await rm(root,{recursive:true,force:true});}
});

test('local smoke/full checks build fixed plans and check first execution without creating runs or calling models',async()=>{
  const {mainPreset}=await import('../src/presets.ts');
  let calls=0;const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){calls++;return new Response('must not call',{status:500});}});
  const root=await configuredRoot(judgeEnvironment.replace('https://judge.example.invalid/v1',server.url.href));
  try {
    const summaries:any[]=[];
    for(const mode of ['smoke','full']) {
      expect(await mainPreset([mode,'--check'],root,value=>summaries.push(value))).toBe(0);
      const summary=summaries.at(-1);
      expect(summary.blockers).toEqual([]);
      expect(summary).toMatchObject({mode,check:true,backend:'local',cases:mode==='smoke'?10:50,repeat:mode==='smoke'?1:3,plannedTrials:mode==='smoke'?10:150,ready:true});
    }
    expect(await Bun.file(join(root,'agent-eval/runs/.active-execution.json')).exists()).toBe(false);
    expect(await readdir(join(root,'agent-eval'))).toEqual(['configs']);
    expect(calls).toBe(0);
    const printed=JSON.stringify(summaries);expect(printed).not.toContain('local-judge-key');expect(printed).not.toContain(runConfigFixture().model.key);
    expect(printed).not.toContain('outputBudget');expect(printed).not.toContain('outputLimit');
  } finally {server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('upload check uses only platform configuration and an explicit archived execution, with no writes',async()=>{
  const {mainPreset}=await import('../src/presets.ts');
  let calls=0;const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){calls++;return Response.json({});}});
  const root=await mkdtemp(join(tmpdir(),'mc-upload-preset-'));
  try {
    await mkdir(join(root,'agent-eval/configs'),{recursive:true});
    await writeFile(join(root,'agent-eval/configs/environment'),`LANGFUSE_BASE_URL=${server.url.href}\nLANGFUSE_PUBLIC_KEY=public\nLANGFUSE_SECRET_KEY=local-platform-key\nMEDCLAW_LANGFUSE_SERVER_VERSION=3.120.0\n`);
    const report=reportFixture(),trial=report.trials[0]!;
    trial.startedAt=report.createdAt;trial.endedAt=report.createdAt;trial.status='infra_error';trial.instanceId='controlled-host';trial.observationRef='evidence/'+trial.trialId+'/observation.json';
    const {aggregate}=await import('../src/scoring/aggregate.ts');report.aggregation=aggregate(report.plan,report.trials,report.scores,report.cases);report.totals=(report.aggregation as any).totals;
    const archive=join(root,'agent-eval/runs',report.executionId);await saveReportFixture(archive,report);
    const original=await readFile(join(archive,'report.json'),'utf8'),summaries:any[]=[];
    expect(await mainPreset(['upload','--execution-id',report.executionId,'--check'],root,value=>summaries.push(value))).toBe(0);
    expect(summaries[0]).toMatchObject({mode:'upload',check:true,ready:true,executionId:report.executionId});
    expect(await readFile(join(archive,'report.json'),'utf8')).toBe(original);
    expect(await Bun.file(join(archive,'export.json')).exists()).toBe(false);
    expect(await Bun.file(join(archive,'.export.lock')).exists()).toBe(false);
    expect(calls).toBe(0);
    expect(JSON.stringify(summaries)).not.toContain('local-platform-key');
    await writeFile(join(root,'agent-eval/configs/environment'),`LANGFUSE_BASE_URL=http://remote.invalid\nLANGFUSE_PUBLIC_KEY=public\nLANGFUSE_SECRET_KEY=local-platform-key\nMEDCLAW_LANGFUSE_SERVER_VERSION=3.120.0\n`);
    await expect(mainPreset(['upload','--execution-id',report.executionId,'--check'],root,()=>{})).rejects.toThrow('https');
  } finally {server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('root scripts separate terminal and desktop E2E without implicit environment loading',async()=>{
  const scripts=(await Bun.file(join(import.meta.dir,'../../package.json')).json()).scripts;
  expect(scripts['test:e2e']).toBe('bun --no-env-file tests/run.ts e2e');
  expect(scripts['test:e2e:desktop']).toBe('bun --no-env-file tests/run.ts desktop');
  for(const mode of ['smoke','full','upload'])expect(scripts['eval:'+mode]).toBe('bun --no-env-file agent-eval/src/presets.ts '+mode);
});

test('shared admission gives the runtime and preflight the same blockers',async()=>{
  const {runBlockers,sourceInventory,doctor}=await import('../src/doctor.ts');
  const {loadDataset}=await import('../src/datasets.ts');
  const {resolveRunConfig}=await import('../src/scoring/judges/client.ts');
  const dataset=await loadDataset('medclaw-agent-v1'),source=await sourceInventory();
  expect((await doctor()).blockers).toEqual(runBlockers(dataset,source));
  const {config}=await resolveRunConfig(runConfigFixture(),{},'off',false);
  const blockers=runBlockers(dataset,source,config,{required:true,configured:false});
  expect(blockers).toContain('independent_judge_unconfigured');
  expect(runBlockers(dataset,source,config,{required:false,configured:false})).toEqual(runBlockers(dataset,source));
});
