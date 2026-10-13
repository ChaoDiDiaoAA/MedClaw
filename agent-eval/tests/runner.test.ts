import { test, expect } from 'bun:test';
import { executePlan, planTrials, runExperiment } from '../src/execution/runner.ts';
import { reportFixture,runConfigFixture,saveReportFixture } from './report-fixture.ts';
import { createDatasetFixture } from './datasets/fixture.ts';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readReport } from '../src/reports/write.ts';

test('plans every repetition before execution and does not lose trials on unsafe stop', async () => {
  const plan = planTrials(['case-1', 'case-2'], 3);
  expect(plan).toHaveLength(6); let launched = 0;
  const result = await executePlan(plan, async item => {
    launched++;
    return { ...reportFixture().trials[0]!, ...item, status: 'failed', startedAt: new Date().toISOString(), stopped: null, closed: false, observation:null, reason: 'stop_unconfirmed' };
  });
  expect(launched).toBe(1); expect(result).toHaveLength(6);
  expect(result.slice(1).every(item => item.status === 'not_run' && item.reason === 'previous_trial_stop_or_save_unconfirmed')).toBe(true);
});

test('first Full records its complete plan and independent report even when data review is pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-runner-'));
  try {
    const datasetRoot = join(root, 'dataset'); await createDatasetFixture(datasetRoot);
    const report = await runExperiment({ datasetRoot, runsRoot: join(root, 'runs'), executionId: 'controlled-admission', selection: 'full', repeat: 3, config: reportFixture().config, judgeMode: 'off' });
    expect(report.plan).toHaveLength(3);
    expect(report.trials.every(trial => trial.status === 'not_run' && trial.startedAt === null)).toBe(true);
    expect(report.totals.notRun).toBe(report.plan.length);
    const path = join(root, 'runs', report.executionId, 'report.json');
    expect((await readReport(path)).snapshot).toEqual(report.snapshot);
    expect(await readFile(path, 'utf8')).toContain('dataset_review_pending');
    expect(await readFile(join(root,'runs',report.executionId,'evidence',report.trials[0]!.trialId,'events.jsonl'),'utf8')).toBe('');
    await expect(runExperiment({ datasetRoot, runsRoot: join(root, 'runs'), executionId: 'controlled-admission', selection: 'smoke', repeat: 1, config: reportFixture().config, judgeMode: 'off' })).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
test('cancellation and preflight blockers preserve all planned NOT_RUN outcomes', async () => {
  const signal = AbortSignal.abort();
  const result = await executePlan(planTrials(['case-1'], 3), async () => { throw new Error('must_not_start'); }, { signal });
  expect(result.every(item => item.status === 'not_run')).toBe(true);
  const blocked = await executePlan(planTrials(['case-1'], 1), async () => { throw new Error('must_not_start'); }, { blockers: ['dataset_review_pending'] });
  expect(blocked[0]!.reason).toContain('dataset_review_pending');
  expect(() => planTrials(['case-1', 'case-1'], 1)).toThrow();
});

test('env-derived Judge identity is archived without credentials or calls when admission blocks execution',async()=>{
  const {JudgeClient,resolveRunConfig}=await import('../src/scoring/judges/client.ts');
  const root=await mkdtemp(join(tmpdir(),'mc-env-judge-'));
  let calls=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){calls++;return new Response('must_not_call',{status:500});}});
  try{
    const datasetRoot=join(root,'dataset');await createDatasetFixture(datasetRoot);
    const {config,modelCredential,judgeConfig}=await resolveRunConfig(runConfigFixture(),{MEDCLAW_JUDGE_BASE_URL:server.url.href,MEDCLAW_JUDGE_MODEL:'controlled-judge',MEDCLAW_JUDGE_API_KEY:'private-judge-key'},'required',true);
    const judge=new JudgeClient(judgeConfig!,{plannedTrials:1});
    const report=await runExperiment({datasetRoot,runsRoot:join(root,'runs'),executionId:'env-judge-blocked',selection:'smoke',repeat:1,config,modelCredential,judge,judgeMode:'required'});
    expect(report.trials.every(trial=>trial.status==='not_run')).toBe(true);
    const path=join(root,'runs',report.executionId,'snapshot.json');
    const archived=await readFile(path,'utf8');
    expect(JSON.parse(archived).config.judge).toEqual(judge.configuration);
    expect(archived.includes('private-judge-key')).toBe(false);
    expect(archived.includes(modelCredential.key)).toBe(false);
    expect(Object.hasOwn(JSON.parse(archived).config.judge,'apiKey')).toBe(false);
    expect((await readReport(join(root,'runs',report.executionId,'report.json'))).config.judge).toEqual(config.judge);
    expect(calls).toBe(0);
  }finally{server.stop(true);await rm(root,{recursive:true,force:true});}
});
test('an execution archive is readable but cannot become an executable dataset',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-archive-readonly-'));
  try{
    await saveReportFixture(root);
    await expect(runExperiment({datasetRoot:root,runsRoot:join(root,'runs'),executionId:'must-not-launch',selection:'smoke',repeat:1,config:reportFixture().config,judgeMode:'off'})).rejects.toThrow('execution_archive_read_only');
    expect(await Bun.file(join(root,'runs/.active-execution.json')).exists()).toBe(false);
  }finally{await rm(root,{recursive:true,force:true});}
});
