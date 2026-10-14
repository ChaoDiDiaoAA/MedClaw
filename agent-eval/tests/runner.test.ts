import { test, expect, spyOn } from 'bun:test';
import { executePlan, planTrials, runExperiment } from '../src/execution/runner.ts';
import { reportFixture,runConfigFixture,saveReportFixture } from './report-fixture.ts';
import { createDatasetFixture } from './datasets/fixture.ts';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readReport } from '../src/reports/write.ts';
import * as scoring from '../src/scoring/evaluate.ts';
import * as files from 'node:fs/promises';
import * as diagnostics from '../src/reports/badcases.ts';

test('plans arbitrary per-Case Trials in numeric order while preserving archived identities',()=>{
  const plan=planTrials(['case-a','case-b'],10);
  expect(plan).toHaveLength(20);
  expect(plan[9]).toEqual({caseId:'case-a',repetition:10,trialId:'case-a-r10'});
  expect(plan[10]).toEqual({caseId:'case-b',repetition:1,trialId:'case-b-r1'});
  for(const count of [0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER])expect(()=>planTrials(['case'],count)).toThrow();
});

test('Case summary follows all five saved Trials exactly once without a model request',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-case-summary-')),events:any[]=[];
  try{
    const datasetRoot=join(root,'dataset');await createDatasetFixture(datasetRoot);
    const report=await runExperiment({datasetRoot,runsRoot:join(root,'runs'),executionId:'controlled-case-summary',selection:'full',trials:5,config:reportFixture().config,judgeMode:'off',onEvent:event=>events.push(event)});
    expect(report.plan).toHaveLength(5);expect(report.analysis?.cases).toHaveLength(1);
    const groups=events.filter(event=>event.kind==='case_summary');expect(groups).toHaveLength(1);
    expect(groups[0].caseSummary.planned).toBe(5);expect(groups[0].caseSummary.notRun).toBe(5);
    expect(events.indexOf(groups[0])).toBeGreaterThan(events.findLastIndex(event=>event.kind==='saved'));
    expect(events.filter(event=>event.kind==='saved').every(event=>event.trialsPerCase===5)).toBe(true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('derived analysis failure preserves a readable report and releases a safely stopped execution lock',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-diagnostic-save-failure-'));
  const writer=spyOn(diagnostics,'writeBadcases').mockRejectedValue(new Error('controlled_disk_failure'));
  try {
    const datasetRoot=join(root,'dataset');await createDatasetFixture(datasetRoot);
    await expect(runExperiment({datasetRoot,runsRoot:join(root,'runs'),executionId:'diagnostic-save-failure',selection:'full',trials:3,config:reportFixture().config,judgeMode:'off'})).rejects.toThrow('badcase_artifacts_failed');
    const report=await readReport(join(root,'runs/diagnostic-save-failure/report.json'));
    expect(report.totals.notRun).toBe(report.plan.length);
    expect(await Bun.file(join(root,'runs/.active-execution.json')).exists()).toBe(false);
  } finally {writer.mockRestore();await rm(root,{recursive:true,force:true});}
});

test('a failed required Judge journal stops the pipeline even when the scorer returns an ERROR result',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-judge-save-failure-'));
  const append=files.appendFile;let scored=0;const events:string[]=[];
  const save=spyOn(files,'appendFile').mockImplementation(async(path,data,options)=>{
    if(String(data).includes('"kind":"judge.result"'))throw new Error('controlled_disk_failure');
    return append(path,data,options);
  });
  const evaluator=spyOn(scoring,'evaluate').mockImplementation(async context=>{
    scored++;
    try{await context.onJudgeResult?.({status:'error',results:[],error:'controlled',metadata:{baseUrl:'http://127.0.0.1/',timeoutMs:30000,model:'controlled',startedAt:'2026-10-14T00:00:00.000Z',endedAt:'2026-10-14T00:00:00.000Z',durationMs:0,temperature:0.8,httpStatus:null,requestId:null,usage:{promptTokens:null,completionTokens:null}}});}catch{/* The real scorer also records this as a scoring error. */}
    return [];
  });
  try {
    const datasetRoot=join(root,'dataset');await createDatasetFixture(datasetRoot);
    let failure:unknown;
    try{await runExperiment({datasetRoot,runsRoot:join(root,'runs'),executionId:'save-failure',selection:'full',trials:3,config:reportFixture().config,judgeMode:'off',onEvent:event=>events.push(event.kind)});}catch(error){failure=error;}
    expect(scored).toBe(1);expect(failure).toBeInstanceOf(Error);expect(events).not.toContain('saved');
    expect(await Bun.file(join(root,'runs/.active-execution.json')).exists()).toBe(true);
  } finally {evaluator.mockRestore();save.mockRestore();await rm(root,{recursive:true,force:true});}
});

test('cancelled native Smoke startup archives ten trials and reads back without model calls',async()=>{
  const {JudgeClient,resolveRunConfig}=await import('../src/scoring/judges/client.ts');
  const root=await mkdtemp(join(tmpdir(),'mc-native-smoke-startup-'));
  let calls=0;const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){calls++;return new Response('unexpected_call',{status:500});}});
  try {
    const input=runConfigFixture();input.model.url=server.url.href;input.intent.baseUrl=server.url.href;
    const {config,modelCredential,judgeConfig}=await resolveRunConfig(input,{MEDCLAW_JUDGE_BASE_URL:server.url.href,MEDCLAW_JUDGE_MODEL:'deepseek/deepseek-flash',MEDCLAW_JUDGE_API_KEY:'private-judge-key'},'required',true);
    const judge=await JudgeClient.create(judgeConfig!,{plannedTrials:10}),executionId='controlled-native-smoke-startup';
    const report=await runExperiment({datasetRoot:'medclaw-agent-v1',runsRoot:root,executionId,selection:'smoke',trials:1,config,modelCredential,judgeMode:'required',judge,signal:AbortSignal.abort()});
    expect(report.trials).toHaveLength(10);expect(report.trials.every(trial=>trial.status==='not_run'&&trial.startedAt===null)).toBe(true);
    expect(report.judgeCalls).toHaveLength(0);expect(calls).toBe(0);
    const archived=await readReport(join(root,executionId,'report.json'));
    expect(archived.plan).toHaveLength(10);expect(archived.totals.notRun).toBe(10);
    const snapshot=await readFile(join(root,executionId,'snapshot.json'),'utf8');
    expect(snapshot).not.toContain(modelCredential.key);expect(snapshot).not.toContain('private-judge-key');
  } finally {server.stop(true);await rm(root,{recursive:true,force:true});}
},30000);

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

test('each Trial finishes asynchronous scoring and saving before the next execution',async()=>{
  const order:string[]=[];
  await executePlan(planTrials(['first','second'],1),async item=>{order.push('run:'+item.caseId);return {...item,status:'completed',instanceId:null,startedAt:null,endedAt:null,reason:null,stopped:true,closed:true,observation:null};},{onProgress:async trial=>{await Bun.sleep(5);order.push('saved:'+trial.caseId);}});
  expect(order).toEqual(['run:first','saved:first','run:second','saved:second']);
  let launched=0;
  let failure:unknown;
  try{await executePlan(planTrials(['first','second'],1),async item=>{launched++;return {...item,status:'completed',instanceId:null,startedAt:null,endedAt:null,reason:null,stopped:true,closed:true,observation:null};},{onProgress:async()=>{throw new Error('necessary_save_unconfirmed');}});}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(Error);expect(launched).toBe(1);
});

test('first Full records its complete plan and independent report even when data review is pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-runner-'));
  try {
    const datasetRoot = join(root, 'dataset'); await createDatasetFixture(datasetRoot);
    const report = await runExperiment({ datasetRoot, runsRoot: join(root, 'runs'), executionId: 'controlled-admission', selection: 'full', trials: 3, config: reportFixture().config, judgeMode: 'off' });
    expect(report.plan).toHaveLength(3);
    expect(report.trials.every(trial => trial.status === 'not_run' && trial.startedAt === null)).toBe(true);
    expect(report.totals.notRun).toBe(report.plan.length);
    const path = join(root, 'runs', report.executionId, 'report.json');
    expect((await readReport(path)).snapshot).toEqual(report.snapshot);
    expect(await readFile(path, 'utf8')).toContain('dataset_review_pending');
    const events=(await readFile(join(root,'runs',report.executionId,'evidence',report.trials[0]!.trialId,'events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(events).toHaveLength(1);expect(events[0]).toMatchObject({kind:'scoring.completed',value:{status:'NOT_RUN'}});
    expect(report.snapshot.plan).toEqual(report.plan);
    expect(report.snapshot.qualityMetricCatalogVersion).toBe('v2');
    expect(report.snapshot.qualityMetricCatalog).toHaveLength(50);
    const index=await diagnostics.deriveBadcases(path);
    expect(index.contract).toBe('medclaw-badcase-index/v1');expect(index.executionId).toBe(report.executionId);
    expect(index.candidates).toEqual([]);
    expect(await Bun.file(join(root,'runs',report.executionId,'badcases.json')).exists()).toBe(false);
    expect(await Bun.file(join(root,'runs',report.executionId,'badcases.md')).exists()).toBe(false);
    await expect(runExperiment({ datasetRoot, runsRoot: join(root, 'runs'), executionId: 'controlled-admission', selection: 'smoke', trials: 1, config: reportFixture().config, judgeMode: 'off' })).rejects.toThrow();
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
    const {config,modelCredential,judgeConfig}=await resolveRunConfig(runConfigFixture(),{MEDCLAW_JUDGE_BASE_URL:server.url.href,MEDCLAW_JUDGE_MODEL:'deepseek/deepseek-flash',MEDCLAW_JUDGE_API_KEY:'private-judge-key'},'required',true);
    const judge=await JudgeClient.create(judgeConfig!,{plannedTrials:1});
    const report=await runExperiment({datasetRoot,runsRoot:join(root,'runs'),executionId:'env-judge-blocked',selection:'smoke',trials:1,config,modelCredential,judge,judgeMode:'required'});
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
    await expect(runExperiment({datasetRoot:root,runsRoot:join(root,'runs'),executionId:'must-not-launch',selection:'smoke',trials:1,config:reportFixture().config,judgeMode:'off'})).rejects.toThrow('execution_archive_read_only');
    expect(await Bun.file(join(root,'runs/.active-execution.json')).exists()).toBe(false);
  }finally{await rm(root,{recursive:true,force:true});}
});
