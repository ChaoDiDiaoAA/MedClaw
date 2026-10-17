import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as instance from '../../src/execution/instance.ts';
import * as observe from '../../src/execution/observe.ts';
import { runTrial } from '../../src/execution/trial.ts';
import { ProductAdapter } from '../../src/adapters/product.ts';
import { createDatasetFixture } from '../datasets/fixture.ts';
import { loadDataset } from '../../src/datasets.ts';
import { reportFixture } from '../report-fixture.ts';
import {ActionExecutor} from '../../src/adapters/actions.ts';
import {within} from '../../src/adapters/files.ts';

for(const stoppedAtBoundary of [true,false])test(`latency stop is confirmed at execution boundary: ${stoppedAtBoundary}`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-latency-boundary-')),datasetRoot=join(root,'dataset'),trialRoot=join(root,'trial');
  await createDatasetFixture(datasetRoot);const task=(await loadDataset(datasetRoot)).cases[0]!;task.setup=[];task.steps=[{id:'send',trigger:'ready',timeoutMs:1000,action:{action:'send',sessionAlias:'main',alias:'final',prompt:'Controlled timing',referenceDate:'2026-10-02'}}];
  const product=new ProductAdapter({dataRoot:join(root,'product'),tracePath:join(trialRoot,'events.jsonl')});
  Object.assign(product,{instanceId:'controlled',paths:{dataRoot:product.options.dataRoot}});
  const prepare=spyOn(instance,'prepareInstance').mockResolvedValue(product);
  const execute=spyOn(ActionExecutor.prototype,'execute').mockImplementation(async function(this:ActionExecutor){this.lastSendAlias='final';this.aliases.runs.set('final',1);return null;});
  let readyAt=0;const wait=spyOn(ActionExecutor.prototype,'wait').mockImplementation(async()=>{readyAt=performance.now();});
  const view=spyOn(ActionExecutor.prototype,'runView').mockResolvedValue({id:1,status:stoppedAtBoundary?'completed':'running',cleanup:{stopConfirmed:stoppedAtBoundary,requiredPersistenceComplete:stoppedAtBoundary}} as any);
  const collect=spyOn(observe,'collectObservation').mockResolvedValue({executionId:'controlled',trialId:'latency',instanceId:'controlled',observedFrom:'2026-10-14T00:00:00Z',observedUntil:'2026-10-14T00:00:00Z',identityChecks:[],missing:[],facts:{runs:[{id:1,status:'completed',cleanup:{stopConfirmed:true,requiredPersistenceComplete:true}}]}});
  const stop=spyOn(product,'stop').mockResolvedValue({stopped:true,closed:true,processExited:true,processTreeStopped:true,requiredPersistenceComplete:true,residuals:[]});
  let workRoot:string|undefined;
  try{
    const result=await runTrial({executionId:'controlled',trialId:'latency',caseId:task.id,repetition:1,case:task,datasetRoot,config:reportFixture().config,trialRoot});
    workRoot=JSON.parse(await readFile(join(trialRoot,'trial.json'),'utf8')).lifecycle.workRoot;
    expect(result.observation!.facts.executionTiming).toMatchObject({trialId:'latency',stopConfirmed:stoppedAtBoundary});
    expect((result.observation!.facts.executionTiming as any).startedMonoMs).toBeGreaterThanOrEqual(readyAt);
  }finally{prepare.mockRestore();execute.mockRestore();wait.mockRestore();view.mockRestore();collect.mockRestore();stop.mockRestore();if(workRoot){within(tmpdir(),workRoot);await rm(workRoot,{recursive:true,force:true});}await rm(root,{recursive:true,force:true});}
});

for(const scenario of [
  {name:'intent timeout',status:'failed',error:{code:'intent_timeout',category:'provider'},expected:'infra_error',reason:'intent_timeout'},
  {name:'invalid intent output',status:'failed',error:{code:'intent_output_invalid',category:'provider'},expected:'failed',reason:'intent_output_invalid'},
  {name:'recovered final Run',status:'completed',error:null,expected:'completed',reason:null},
  {name:'intentional cancellation',status:'cancelled',error:null,expected:'completed',reason:null},
] as const)test(`Trial respects ${scenario.name} instead of assuming terminal means success`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-terminal-provider-'));
  const datasetRoot=join(root,'dataset'),trialRoot=join(root,'trial');await createDatasetFixture(datasetRoot);
  const task=(await loadDataset(datasetRoot)).cases[0]!;task.setup=[{action:'read_control'}];task.steps=[];
  const product=new ProductAdapter({dataRoot:join(root,'product'),tracePath:join(trialRoot,'events.jsonl')});
  product.instanceId='controlled-instance';Object.assign(product,{paths:{dataRoot:product.options.dataRoot}});
  const prepare=spyOn(instance,'prepareInstance').mockResolvedValue(product);
  const execute=spyOn(ActionExecutor.prototype,'execute').mockImplementation(async function(this:ActionExecutor){this.lastSendAlias='final';this.aliases.runs.set('final',2);return null;});
  const collect=spyOn(observe,'collectObservation').mockResolvedValue({executionId:'engineering',trialId:'terminal',instanceId:product.instanceId,observedFrom:'2026-10-14T00:00:00.000Z',observedUntil:'2026-10-14T00:00:00.000Z',identityChecks:[],missing:[],facts:{runs:[{id:1,status:'failed',error:{code:'provider_request_failed'}},{id:2,status:scenario.status,error:scenario.error}]}});
  const stop=spyOn(product,'stop').mockResolvedValue({stopped:true,closed:true,processExited:true,processTreeStopped:true,requiredPersistenceComplete:true,residuals:[]});
  let workRoot:string|undefined;
  try {
    const result=await runTrial({executionId:'engineering',trialId:'terminal',caseId:task.id,repetition:1,case:task,datasetRoot,config:reportFixture().config,trialRoot});
    const saved=JSON.parse(await readFile(join(trialRoot,'trial.json'),'utf8'));workRoot=saved.lifecycle.workRoot;
    expect({status:result.status,reason:result.reason}).toEqual({status:scenario.expected,reason:scenario.reason});
    expect(saved.status).toBe(scenario.expected);
  } finally {
    prepare.mockRestore();execute.mockRestore();collect.mockRestore();stop.mockRestore();
    if(workRoot){within(tmpdir(),workRoot);await rm(workRoot,{recursive:true,force:true});}
    await rm(root,{recursive:true,force:true});
  }
});

test('a controller wait RPC failure is infrastructure failure, rather than an Agent execution failure',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-controller-wait-failure-')),datasetRoot=join(root,'dataset'),trialRoot=join(root,'trial');
  await createDatasetFixture(datasetRoot);const task=(await loadDataset(datasetRoot)).cases[0]!;
  task.setup=[];task.steps=[{id:'wait',trigger:'ready',action:{action:'read_control'},timeoutMs:1000}];
  const product=new ProductAdapter({dataRoot:join(root,'product'),tracePath:join(trialRoot,'events.jsonl')});
  product.instanceId='controlled-instance';Object.assign(product,{paths:{dataRoot:product.options.dataRoot}});
  const prepare=spyOn(instance,'prepareInstance').mockResolvedValue(product);
  const wait=spyOn(ActionExecutor.prototype,'wait').mockRejectedValue(Object.assign(new Error('invalid_argument'),{appError:{code:'invalid_argument'}}));
  const collect=spyOn(observe,'collectObservation').mockResolvedValue({executionId:'engineering',trialId:'wait',instanceId:product.instanceId,observedFrom:'2026-10-14T00:00:00.000Z',observedUntil:'2026-10-14T00:00:00.000Z',identityChecks:[],missing:[],facts:{}});
  const stop=spyOn(product,'stop').mockResolvedValue({stopped:true,closed:true,processExited:true,processTreeStopped:true,requiredPersistenceComplete:true,residuals:[]});
  let workRoot:string|undefined;
  try {
    const result=await runTrial({executionId:'engineering',trialId:'wait',caseId:task.id,repetition:1,case:task,datasetRoot,config:reportFixture().config,trialRoot});
    workRoot=JSON.parse(await readFile(join(trialRoot,'trial.json'),'utf8')).lifecycle.workRoot;
    expect(result).toMatchObject({status:'infra_error',reason:'invalid_argument',stopped:true,closed:true});
  } finally {prepare.mockRestore();wait.mockRestore();collect.mockRestore();stop.mockRestore();if(workRoot){within(tmpdir(),workRoot);await rm(workRoot,{recursive:true,force:true});}await rm(root,{recursive:true,force:true});}
});

for (const scenario of [
  { name: 'process exit', proof: { stopped: true, closed: true, processExited: false, processTreeStopped: true, requiredPersistenceComplete: true, residuals: ['process_exit_unconfirmed'] } },
  { name: 'process tree', proof: { stopped: true, closed: true, processExited: true, requiredPersistenceComplete: true, residuals: [] } },
  { name: 'required save', proof: { stopped: true, closed: true, processExited: true, processTreeStopped: true, residuals: [] } },
]) test('Trial preserves unknown ' + scenario.name + ' as infrastructure failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-trial-stop-proof-'));
  const datasetRoot = join(root, 'dataset'), trialRoot = join(root, 'trial');
  await createDatasetFixture(datasetRoot);
  const task = (await loadDataset(datasetRoot)).cases[0]!; task.setup = []; task.steps = [];
  await writeFile(join(datasetRoot, '.controlled-fixture.json'), JSON.stringify({ contract: 'medclaw-controlled-fixture/v1', synthetic: true, containsSecrets: false }));
  const config = reportFixture().config;
  const product = new ProductAdapter({ dataRoot: join(trialRoot, 'product'), tracePath: join(trialRoot, 'trace.jsonl') });
  Object.assign(product, { instanceId: 'instance', paths: { dataRoot: product.options.dataRoot } });
  const proof = scenario.proof;
  const body = { executionId: 'fixture', trialId: 'trial', instanceId: 'instance', observedFrom: '2026-10-12T00:00:00.000Z', observedUntil: '2026-10-12T00:00:00.000Z', identityChecks: [], facts: {}, missing: [] };
  const prepare = spyOn(instance, 'prepareInstance').mockResolvedValue(product);
  const collect = spyOn(observe, 'collectObservation').mockResolvedValue({ ...body });
  const stop = spyOn(product, 'stop').mockResolvedValue(proof);
  try {
    const result = await runTrial({ executionId: 'fixture', trialId: 'trial', caseId: task.id, repetition: 1, case: task, datasetRoot, config, trialRoot });
    expect(result.status).toBe('infra_error');
    expect(result.reason).toBe('host_stop_unconfirmed');
    expect(JSON.parse(await readFile(join(trialRoot, 'trial.json'), 'utf8')).lifecycle.shutdown).toEqual(proof);
    expect(JSON.parse(await readFile(join(trialRoot, 'trial.json'), 'utf8')).lifecycle.cleanup).toMatchObject({ status: 'preserved', reason: 'host_stop_unconfirmed' });
  } finally { prepare.mockRestore(); collect.mockRestore(); stop.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
