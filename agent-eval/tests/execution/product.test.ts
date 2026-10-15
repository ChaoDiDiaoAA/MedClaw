import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { childEnvironment, ProductAdapter } from '../../src/adapters/product.ts';
import { cleanupInstance, prepareInstance } from '../../src/execution/instance.ts';
import { unwrap } from '../../src/adapters/product.ts';
import { ActionExecutor, readAllMessages } from '../../src/adapters/actions.ts';
import { verifyPublishedConfiguration } from '../../src/adapters/configuration.ts';
import { collectObservation } from '../../src/execution/observe.ts';
import { runTrial } from '../../src/execution/trial.ts';
import { reportFixture } from '../report-fixture.ts';
import { loadDataset, materializeInputs } from '../../src/datasets.ts';
import type { EvalCase } from '../../src/evaluation.ts';
import { canonicalRequest } from '../../../packages/contracts/src/run.ts';
import { QueryParamsSchema } from '../../../packages/contracts/src/query.ts';
import { evaluate } from '../../src/scoring/evaluate.ts';
import {observedConditions} from '../../src/scoring/project-observation.ts';
import type { CheckSpec } from '../../src/scoring/types.ts';

const intentPaths: string[] = [];
const intentMetadata = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname; intentPaths.push(path);
  if (path === '/api/version') return Response.json({ version: 'ENGINEERING metadata fixture; no model' });
  if (path === '/api/tags') return Response.json({ models: [{ name: 'qwen3.5:0.8b' }] });
  if (path === '/api/show') return Response.json({ details: { family: 'ENGINEERING', parameter_size: 'fixture', quantization_level: 'fixture' } });
  return new Response('ENGINEERING inference prohibited', { status: 403 });
} });
afterAll(() => { intentMetadata.stop(true); expect(intentPaths.every(path => ['/api/version', '/api/tags', '/api/show'].includes(path))).toBe(true); });
const config = () => ({ ...reportFixture().config, model: { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 16384 },
  intent: { baseUrl: `http://127.0.0.1:${intentMetadata.port}`, model: 'qwen3.5:0.8b' as const }, });
function controlledCase(): EvalCase {
  return { id:'controlled',version:1,name:'Controlled lifecycle',category:'memory',difficulty:'regression',evalType:'regression',scorers:[],risks:[],source:'provider-fixture',dataset:{id:'controlled-fixture',version:1,referenceDate:'2026-10-12',timezone:'Asia/Shanghai',scoringVersion:'v1',smoke:true},tags:[],requires:[],materialRefs:[],lineageGroupIds:['engineering'],input:{prompt:'ENGINEERING',workspaceContext:{},fixture:{ref:'procurement'},materials:{}},
    setup: [{ action: 'new_session', alias: 'A' }, { action: 'new_session', alias: 'B' }],
    steps: [{ id: 'select-A', trigger: 'ready', action: { action: 'select_session', sessionAlias: 'A' }, timeoutMs: 10000 },
      { id: 'conflict', trigger: 'ready', action: { action: 'select_session', sessionAlias: 'B', expectedWorkspaceRevision: 0 }, expectedFailure: { code: 'state_conflict', reason: 'workspace_revision_mismatch' }, timeoutMs: 10000 },
      { id: 'history', trigger: 'ready', action: { action: 'read_messages', sessionAlias: 'A' }, timeoutMs: 10000 },
      { id: 'inputs', trigger: 'ready', action: { action: 'list_inputs', sessionAlias: 'B' }, timeoutMs: 10000 },
      { id: 'checkpoints', trigger: 'ready', action: { action: 'read_checkpoints', sessionAlias: 'A' }, timeoutMs: 10000 },
      { id: 'restart', trigger: 'ready', action: { action: 'restart' }, timeoutMs: 20000 },
      { id: 'read', trigger: 'ready', action: { action: 'read_control' }, timeoutMs: 10000 }],
    expected: { maxToolCalls:0,mustHaveEvidence:false, expectedAnswerHint:'ENGINEERING',forbiddenConditions:['Failure'],success: ['ENGINEERING'], failure: ['ENGINEERING'], checks: [], goldRef: 'controlled' } };
}
test('private export copy verification journals correlation without temporary paths or request contents', async () => {
  const root=await mkdtemp(join(tmpdir(),'medclaw-eval-copy-trace-'));
  try {
    const tracePath=join(root,'trace.jsonl'),product=new ProductAdapter({dataRoot:root,tracePath});product.instanceId='host';
    product.record('request',{requestId:'copy-request',method:'export.copy.verify',payload:{operationRef:'copy',exportId:1,artifactId:2,temporaryPath:join(root,'private-copy')}});
    product.record('reply',{requestId:'copy-request',method:'export.copy.verify',result:{ok:true,data:{verified:true}}});
    await product.flush();
    const text=await readFile(tracePath,'utf8');expect(text).not.toContain('temporaryPath');expect(text).not.toContain('private-copy');
    expect(product.traces.every(entry=>entry.requestId==='copy-request'&&entry.method==='export.copy.verify'&&!('payload' in entry)&&!('result' in entry))).toBe(true);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('child environment does not inherit parent keys, judge settings or dotenv', () => {
  const previousMarker = process.env.ENGINEERING_SECRET, previousKey = process.env.OPENAI_API_KEY;
  process.env.ENGINEERING_SECRET = 'do-not-inherit'; process.env.OPENAI_API_KEY = 'do-not-inherit';
  try {
    const env = childEnvironment('D:\\owned', 'instance', 'startup');
    expect(env.ENGINEERING_SECRET).toBeUndefined(); expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.AWS_MAX_ATTEMPTS).toBe('1');
    expect(env.HOME).toBe(join('D:\\owned', 'home')); expect(env.MEDCLAW_INSTANCE_ID).toBe('instance');
  } finally {
    if (previousMarker === undefined) delete process.env.ENGINEERING_SECRET; else process.env.ENGINEERING_SECRET = previousMarker;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});
test('local trial launches without a provenance marker or manual readiness declaration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-eval-local-'));
  try {
    const result = await runTrial({ executionId: 'e', trialId: 't', caseId: 'controlled', repetition: 1, case: controlledCase(), datasetRoot: root,
      config: config(), trialRoot: join(root, 'trial') });
    expect(result).toMatchObject({ status: 'completed', stopped: true, closed: true, reason: null });
    expect(result.observation?.facts.modelCalls).toEqual([]);
    expect(result.observation?.facts.lifecycle).toMatchObject({ isolation: { mode: 'local', childEnvironment: 'minimal' } });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
test('explicit internal fixture mode does not grant model or native tool execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-eval-no-model-'));
  try {
    await writeFile(join(root, '.controlled-fixture.json'), JSON.stringify({ contract: 'medclaw-controlled-fixture/v1', synthetic: true, containsSecrets: false }));
    const item = controlledCase(); item.steps = [{ id: 'send', trigger: 'ready', action: { action: 'send', sessionAlias: 'A', prompt: 'ENGINEERING', alias: 'first', referenceDate: '2026-10-12' }, timeoutMs: 1000 }];
    const result = await runTrial({ executionId: 'e', trialId: 't', caseId: item.id, repetition: 1, case: item, datasetRoot: root, config: config(), controlledFixture: true, trialRoot: join(root, 'trial') });
    expect(result).toMatchObject({ status: 'not_run', reason: 'controlled_fixture_model_execution_disabled', instanceId: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provider HTTP failure uses the selected Anthropic route and is an infrastructure error',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-anthropic-provider-error-')),requests:{path:string;key:string|null}[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
    requests.push({path:new URL(request.url).pathname,key:request.headers.get('x-api-key')});
    return Response.json({error:{type:'not_found_error',message:'ENGINEERING controlled provider failure'}},{status:404});
  }});
  try {
    const {resolveRunConfig}=await import('../../src/scoring/judges/client.ts');
    const {config:selected,modelCredential}=await resolveRunConfig({...config(),model:{url:'https://api.deepseek.com/anthropic',key:'ENGINEERING-LOCAL-KEY',model:'deepseek-flash'}},{},'off',false);
    selected.model.definition!.baseUrl=server.url.href+'anthropic';
    const task=controlledCase();task.setup=[{action:'new_session',alias:'A'}];
    task.steps=[{id:'send',trigger:'ready',action:{action:'send',sessionAlias:'A',alias:'first',prompt:'ENGINEERING provider error',referenceDate:'2026-10-12'},timeoutMs:15000},
      {id:'settled',trigger:'run_settled',targetAlias:'first',action:{action:'read_messages',sessionAlias:'A'},timeoutMs:15000}];
    const result=await runTrial({executionId:'engineering-provider',trialId:'provider-failed',caseId:task.id,repetition:1,case:task,datasetRoot:root,config:selected,modelCredential,trialRoot:join(root,'trial')});
    expect({status:result.status,reason:result.reason,stopped:result.stopped,closed:result.closed}).toEqual({status:'infra_error',reason:'provider_request_failed',stopped:true,closed:true});
    expect(requests).toEqual([{path:'/anthropic/v1/messages',key:'ENGINEERING-LOCAL-KEY'}]);
    expect(result.observation?.facts.runs).toMatchObject([{status:'failed',error:{code:'provider_request_failed'}}]);
    expect(JSON.parse(await readFile(join(root,'trial/trial.json'),'utf8'))).toMatchObject({status:'infra_error',reason:'provider_request_failed'});
  } finally {server.stop(true);await rm(root,{recursive:true,force:true});}
},30000);

test('local Trial sends two real SDK turns and records a tool through a loopback model only', async () => {
  const root=await mkdtemp(join(tmpdir(),'medclaw-eval-sdk-turns-')),requests:unknown[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    requests.push(await request.json());
    const output=requests.length===1?[{type:'function_call',id:'engineering-function',call_id:'engineering-scope-read',name:'read_data_scope',arguments:'{}'}]:[{type:'message',id:'engineering-message',role:'assistant',content:[{type:'output_text',text:'ENGINEERING saved answer '+requests.length}]}];
    const events:unknown[]=output.flatMap((item,output_index)=>[{type:'response.output_item.added',output_index,item},{type:'response.output_item.done',output_index,item}]);
    events.push({type:'response.completed',response:{id:'engineering-turn',status:'completed',output}});
    return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  }});
  let result;
  try {
    const {resolveRunConfig}=await import('../../src/scoring/judges/client.ts');
    const {config:selected,modelCredential}=await resolveRunConfig({...config(),retention:'preserve_on_failure',model:{url:server.url.href+'v1',key:'ENGINEERING-LOCAL-KEY',model:'openai/gpt-4o-mini'}},{},'off',false);
    const task=controlledCase();task.setup=[{action:'new_session',alias:'A'}];
    task.steps=[
      {id:'first',trigger:'ready',action:{action:'send',sessionAlias:'A',alias:'first',prompt:'ENGINEERING first turn',referenceDate:'2026-10-12'},timeoutMs:15000},
      {id:'first-saved',trigger:'run_settled',targetAlias:'first',action:{action:'read_messages',sessionAlias:'A'},timeoutMs:15000},
      {id:'second',trigger:'ready',action:{action:'send',sessionAlias:'A',alias:'second',prompt:'ENGINEERING second turn',referenceDate:'2026-10-12'},timeoutMs:15000},
      {id:'second-saved',trigger:'run_settled',targetAlias:'second',action:{action:'read_messages',sessionAlias:'A'},timeoutMs:15000},
    ];
    result=await runTrial({executionId:'engineering-sdk',trialId:'two-turns',caseId:task.id,repetition:1,case:task,datasetRoot:root,config:selected,modelCredential,trialRoot:join(root,'trial')});
    expect(result).toMatchObject({status:'completed',reason:null,stopped:true,closed:true});
    expect(requests).toHaveLength(3);
    expect(result.observation?.facts.modelCalls).toHaveLength(3);
    expect(result.observation?.facts.toolCalls).toHaveLength(1);
    expect(result.observation?.missing).toEqual([]);
    expect(result.observation?.facts.lifecycle).toMatchObject({cleanup:{status:'removed'}});
    expect((result.observation?.facts.runs as {status:string}[]).every(run=>run.status==='completed')).toBe(true);
    expect(result.observation?.identityChecks.every(check=>check.passed)).toBe(true);
    expect((await readFile(join(root,'trial/events.jsonl'),'utf8')).includes(modelCredential.key)).toBe(false);
    expect(JSON.stringify(requests)).not.toContain('expectedAnswerHint');
  } finally {server.stop(true);if(!result?.startedAt||result.stopped===true&&result.closed===true)await rm(root,{recursive:true,force:true});}
},60000);

test('startup applies policy and verifies transient product identity without storing it in evaluation configuration',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mc-config-'));let product;
 const selected={...config(),policy:{timeoutMs:130000,maxRetries:1 as const,maxRetryDelayMs:1000}};
 try {
  product=await prepareInstance({trialRoot:join(root,'valid'),config:selected});
  const current=unwrap(await product.request('model.config.read',{}));expect(current.policy).toEqual(selected.policy);
  expect(current.intentModel).toMatchObject({enabled:true,});
  await expect(verifyPublishedConfiguration(product,{...selected,intent:{...selected.intent,baseUrl:selected.intent.baseUrl+'/'}})).rejects.toThrow('published_intent_configuration_mismatch');
  await expect(prepareInstance({trialRoot:join(root,'wrong-tokens'),config:{...selected,model:{...selected.model,maxTokens:42}}})).rejects.toThrow('published_model_configuration_mismatch');
  expect(JSON.parse(await readFile(join(root,'wrong-tokens','startup-shutdown.json'),'utf8'))).toMatchObject({stopped:true,closed:true,processExited:true});
 }finally{if(product)expect(await product.stop()).toMatchObject({stopped:true,closed:true,processExited:true});await rm(root,{recursive:true,force:true});}
},60000);
test('real Host public lifecycle creates/selects/restarts same database without model calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-eval-real-host-'));
  try {
    await writeFile(join(root, '.controlled-fixture.json'), JSON.stringify({ contract: 'medclaw-controlled-fixture/v1', synthetic: true, containsSecrets: false }));
    const item = controlledCase(), result = await runTrial({ executionId: 'engineering', trialId: 'lifecycle', caseId: item.id, repetition: 1, case: item,
      datasetRoot: root, config: config(), trialRoot: join(root, 'trial') });
    expect(result.reason).toBeNull(); expect(result.status).toBe('completed'); expect(result.stopped).toBe(true); expect(result.closed).toBe(true);
    expect(result.observation?.facts.modelCalls).toEqual([]); expect(result.observation?.facts.runs).toEqual([]); expect(result.observation?.missing).toEqual([]);
    expect(result.observation?.identityChecks.every(check => check.passed)).toBe(true);
    expect(JSON.parse(await readFile(join(root,'trial','observation.json'),'utf8'))).toEqual(result.observation);
    const trace = (await readFile(join(root, 'trial', 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const ready = trace.filter(row => row.kind === 'ready'); expect(ready).toHaveLength(2); expect(ready[0].instanceId).not.toBe(ready[1].instanceId);
    expect(trace.filter(row => row.kind === 'request').some(row => ['session.submit', 'model.request', 'session.compact'].includes(row.method))).toBe(false);
    expect(await Bun.file(join(root, 'trial', 'observation.json')).exists()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
test('real Host imports public projection, resolves batches and archives actual registered Artifact content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-eval-import-')); let result;
  try {
    await writeFile(join(root, '.controlled-fixture.json'), JSON.stringify({ contract: 'medclaw-controlled-fixture/v1', synthetic: true, containsSecrets: false }));
    // The marker is control material; the product receives only this action's package directory.
    await mkdir(join(root, 'gold')); await writeFile(join(root, 'gold', 'never-read.json'), 'ENGINEERING GOLD NOT PRODUCT INPUT');
    const item = controlledCase(); item.materialRefs=['materials/current'];
    const dataset=await loadDataset('medclaw-agent-v1');
    item.input.materials={'materials/current':dataset.cases[0]!.input.materials['materials/zj-snapshot']!};
    item.setup = [{ action: 'new_session', alias: 'A' }, { action: 'import', alias: 'snapshot', materialRef: 'materials/current' }];
    item.steps = [{ id: 'workspace', trigger: 'ready', timeoutMs: 10000, action: { action: 'select_workspace', batchAliases: ['snapshot:batch:1', 'snapshot:batch:2', 'snapshot:batch:3', 'snapshot:batch:4'] } },
      { id: 'operation', trigger: 'ready', timeoutMs: 10000, action: { action: 'read_operation', operationAlias: 'snapshot', kind: 'import' } }];
    result = await runTrial({ executionId: 'engineering', trialId: 'import', caseId: item.id, repetition: 1, case: item, datasetRoot: root, config: config(), trialRoot: join(root, 'trial') });
    expect(result).toMatchObject({ status: 'completed', stopped: true, closed: true, reason: null }); expect(result.observation?.missing).toEqual([]);
    const operations = result.observation?.facts.operations as { state: string; result: { batchIds: number[]; rowCount: number } }[];
    expect(operations).toHaveLength(1); expect(operations[0]).toMatchObject({ state: 'imported', result: { rowCount: 12 } }); expect(operations[0]!.result.batchIds).toHaveLength(4);
    const files = result.observation?.facts.artifactFiles as { relativePath: string; evidencePath: string; bytes: number }[];
    expect(files.length).toBeGreaterThan(1); expect(files.every(file => !('sha256' in file))).toBe(true);
    const trace = await readFile(join(root, 'trial', 'events.jsonl'), 'utf8'); expect(trace).not.toContain('ENGINEERING GOLD NOT PRODUCT INPUT');
    expect(result.observation?.facts.modelCalls).toEqual([]); expect(result.observation?.identityChecks.every(check => check.passed)).toBe(true);
  } finally { if (!result?.startedAt || result.stopped === true && result.closed === true) await rm(root, { recursive: true, force: true }); }
}, 60000);
test('public reads never restore sessions or replay inputs, unknown alias fails before request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-eval-read-only-')); let product;
  try {
    product = await prepareInstance({ trialRoot: root, config: config() }); const executor = new ActionExecutor(product, config(), root, root);
    await executor.execute({ action: 'new_session', alias: 'A' }); const start = product.traces.length;
    await readAllMessages(product, executor.aliases.sessions.get('A')!.id); await executor.execute({ action: 'read_checkpoints', sessionAlias: 'A' });
    await expect(executor.execute({ action: 'read_input', sessionAlias: 'A', inputAlias: 'missing' })).rejects.toThrow('unknown_alias');
    const observation = await collectObservation({ executionId: 'e', trialId: 't', product, aliases: executor.aliases, trialRoot: root, observedFrom: new Date().toISOString() });
    expect(observation.missing).toEqual([]);
    const writes = product.traces.slice(start).filter(row => row.kind === 'request' && ['session.restore', 'session.restoreCheckpoint', 'session.submit', 'import.recover', 'export.recover'].includes(row.method as string)); expect(writes).toEqual([]);
  } finally { if (product) expect(await product.stop()).toMatchObject({ stopped: true, closed: true, processExited: true }); await rm(root, { recursive: true, force: true }); }
}, 60000);
test('real Host deterministic form Query, all Query/Evidence pages, export and checkpoint restore make zero model calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-eval-form-export-')), observedFrom = new Date().toISOString(); let product;
  try {
    const item=controlledCase();item.materialRefs=['materials/current'];
    const dataset=await loadDataset('medclaw-agent-v1');
    item.input.materials={'materials/current':dataset.cases[0]!.input.materials['materials/zj-snapshot']!};
    const inputRoot=await materializeInputs(item,join(root,'inputs'));
    const selectedConfig = { ...config(), model: { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 16384 } };
    product = await prepareInstance({ trialRoot: join(root, 'trial'), config: selectedConfig, owner: { executionId: 'engineering', trialId: 'form', caseId: 'form' } });
    const executor = new ActionExecutor(product, selectedConfig, inputRoot, join(root, 'trial'));
    await executor.execute({ action: 'new_session', alias: 'A' }); await executor.execute({ action: 'import', alias: 'snapshot', materialRef: 'materials/current' });
    await executor.execute({ action: 'select_workspace', batchAliases: [1, 2, 3, 4].map(index => `snapshot:batch:${index}`) });
    const workspace = unwrap(await product.request('workspace.read', {})), currentConfig = unwrap(await product.request('model.config.read', {})), sessionId = executor.aliases.sessions.get('A')!.id;
    const params = QueryParamsSchema.parse({ kind: 'current', population: 'snapshot', snapshotMode: 'exact_date', batchIds: workspace.batchRefs.map(batch => batch.id), time: { start: '2026-09-28', endExclusive: '2026-09-29' } });
    const accepted = unwrap(await product.request('session.submit', { sessionId, clientSequence: 1, text: `Query form: ${canonicalRequest(params)}`, mode: 'send',
      routing: { mode: 'user_form', params }, expectedRevision: workspace.revision, expectedBatchIds: params.batchIds, expectedQueryId: null,
      model: { provider: 'openai', modelId: 'gpt-4o-mini', expectedConfigVersion: currentConfig.configVersion }, referenceDate: '2026-09-28', timezone: 'Asia/Shanghai' }, 'engineering-form'));
    expect(accepted.runId).not.toBeNull(); if (accepted.runId === null) throw new Error('form_run_missing');
    executor.aliases.runs.set('form', accepted.runId); executor.aliases.inputs.set('form', { sessionId, clientSequence: 1, inputId: accepted.inputId }); executor.lastSendAlias = 'form';
    await executor.wait('run_settled', 'form', 10000);
    await executor.execute({ action: 'export', queryAlias: 'form:query:1', format: 'csv', operationAlias: 'exported' });
    await executor.execute({ action: 'read_checkpoints', sessionAlias: 'A' });
    await executor.execute({ action: 'restore_checkpoint', sessionAlias: 'A', checkpointAlias: 'form:checkpoint', operationAlias: 'restore' });
    await executor.execute({ action: 'read_operation', operationAlias: 'restore', kind: 'session_checkpoint' });
    await executor.execute({ action: 'restore_session', sessionAlias: 'A' });
    const observation = await collectObservation({ executionId: 'engineering', trialId: 'form', product, aliases: executor.aliases, lastSendAlias: executor.lastSendAlias, trialRoot: join(root, 'trial'), observedFrom, pageSize: 2 });
    expect(observation.facts.modelCalls).toEqual([]); expect(observation.facts.toolCalls).toEqual([]); expect(observation.identityChecks.every(check => check.passed)).toBe(true);
    expect(observation.facts.aliases).toMatchObject({ lastSendAlias: 'form', runs: [{ alias: 'form', runId: accepted.runId }], queries: [{ alias: 'form:query:1', queryId: executor.aliases.queries.get('form:query:1') }] });
    expect(observation.facts.catalogPages).toHaveLength(2); expect(observation.facts.batches).toHaveLength(4);
    const queryPages = observation.facts.queryPages as { query: { source: string }; page: { rows: unknown[] } }[];
    expect(queryPages).toHaveLength(2); expect(queryPages.flatMap(page => page.page.rows)).toHaveLength(3); expect(queryPages.every(page => page.query.source === 'user_form')).toBe(true);
    const evidencePages = observation.facts.evidencePages as { items: unknown[] }[]; expect(evidencePages.length).toBeGreaterThan(1); expect(evidencePages.flatMap(page => page.items)).toHaveLength(3);
    expect((observation.facts.operations as { kind: string; state?: string }[]).find(operation => operation.kind === 'export')?.state).toBe('completed');
    expect(observation.missing.filter(item=>item.key.startsWith('artifact.'))).toEqual([]);
    const artifactFiles = observation.facts.artifactFiles as { relativePath: string }[]; expect(artifactFiles.some(file => file.relativePath === 'result.csv')).toBe(true); expect(artifactFiles.some(file => file.relativePath === 'metadata.json')).toBe(true);
    const checks: CheckSpec[] = ['query.conditions', 'query.set_exact', 'query.numeric', 'export.exact'].map(metricId => ({ id: metricId, metricId, version: 'v1', kind: 'deterministic', required: true, hardConstraint: true, unit: 'original facts', goldKey: `values.${metricId.replace('.', '_')}`, evidenceKey: metricId.replace('.', '_') }));
    const values = { finalStageAlias: 'form', query_conditions: { region: '浙江', regions: null, date: '2026-09-28', start: null, endExclusive: null, sourceDeviceId: null, manufacturer: null, category: null, status: null, snapshotMode: 'exact_date', threshold: null },
      query_set_exact: ['A', 'B', 'C'].map(id => `SYN-ZJ-${id}@synthetic-zj-v1`),
      query_numeric: [['A', 10000], ['B', 0]].map(([id, value]) => ({ id: `SYN-ZJ-${id}@synthetic-zj-v1`, value, unit: 'CNY cents' })),
      export_exact: { rows: [['A', 10000], ['B', 0], ['C', null]].map(([id, price]) => ({ key: `SYN-ZJ-${id}|2026-09-28`, device: `SYN-ZJ-${id}`, price })),
        sets: ['A', 'B', 'C'].map(id => `SYN-ZJ-${id}@synthetic-zj-v1`), format: 'csv', sourceQueryAlias: 'form:query:1',
        metadata: { requestedDate: '2026-09-28', actualDataDate: '2026-09-28', snapshotMode: 'exact_date', region: '浙江', scopeKey: 'synthetic-zj-v1', isStale: false, quantityUnit: 'records', nullPriceDeviceIds: ['SYN-ZJ-C@synthetic-zj-v1'] } } };
    const scoring = { trialId: 'form', caseId: 'form', task: { checks }, gold: { values }, observation, trialStatus: 'completed' as const };
    expect((await evaluate(scoring)).map(score => ({ metricId: score.metricId, status: score.status, reason: score.status === 'PASS' ? null : score.reason }))).toEqual(checks.map(check => ({ metricId: check.metricId, status: 'PASS', reason: null })));
    const completeDeviceIds=[...new Set((observation.facts.evidencePages as any[]).flatMap(page=>page.items.map((item:any)=>item.deviceId)))];
    expect(completeDeviceIds).toHaveLength(3);
    const explicitFullScope={...params,deviceIds:completeDeviceIds};
    expect(await observedConditions(observation.facts,explicitFullScope)).toMatchObject({sourceDeviceId:null,region:'浙江',date:'2026-09-28'});
    expect(await observedConditions(observation.facts,{...explicitFullScope,deviceIds:[...completeDeviceIds,completeDeviceIds[0]]})).toMatchObject({sourceDeviceId:null});
    expect(await observedConditions(observation.facts,{...explicitFullScope,deviceIds:completeDeviceIds.slice(0,2)})).toBeUndefined();
    expect(await observedConditions(observation.facts,{...explicitFullScope,deviceIds:[...completeDeviceIds,999999]})).toBeUndefined();
    expect(await observedConditions({...observation.facts,operations:[]},explicitFullScope)).toBeUndefined();
    const incorrect = { ...values, query_numeric: values.query_numeric.map((row, index) => index === 0 ? { ...row, value: 10001 } : row) };
    expect((await evaluate({ ...scoring, gold: { values: incorrect } }))[2]?.status).toBe('FAIL');
    const incorrectExport = { ...values, export_exact: { ...values.export_exact, rows: values.export_exact.rows.map((row, index) => index === 0 ? { ...row, price: 10001 } : row) } };
    expect((await evaluate({ ...scoring, gold: { values: incorrectExport } }))[3]?.status).toBe('FAIL');
    expect((await evaluate({ ...scoring, observation: { ...observation, facts: { ...observation.facts, queryPages: queryPages.slice(0, -1) } } })).every(score => score.status === 'UNJUDGEABLE')).toBe(true);
    expect(observation.missing).toEqual([]);
    expect((observation.facts.nativeHistory as any[]).every(item=>item.protocolValidated===true)).toBe(true);
  } finally { if (product) expect(await product.stop()).toMatchObject({ stopped: true, closed: true, processExited: true }); await rm(root, { recursive: true, force: true }); }
}, 60000);
for (const scenario of [
  { id: 'mc-v1-task-empty-result', date: '2026-10-02', end: '2026-10-03', category: 'defibrillator', device: false },
  { id: 'mc-v1-task-empty-result', date: '2026-10-02', end: '2026-10-03', category: 'defibrillator', device: true },
  { id: 'mc-v1-task-exact-date-gap', date: '2026-09-30', end: '2026-10-01', category: null, device: false },
]) test(`empty results and missing dates retain independent evidence: ${scenario.id}, device=${scenario.device}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-eval-empty-')), observedFrom = new Date().toISOString(); let product;
  try {
    const dataset = await loadDataset(), item = dataset.cases.find(item => item.id === scenario.id)!;
    const inputRoot = await materializeInputs(item, join(root, 'inputs')), selectedConfig = config(), trialRoot = join(root, 'trial');
    product = await prepareInstance({ trialRoot, config: selectedConfig, owner: { executionId: 'engineering', trialId: 'empty', caseId: item.id } });
    const executor = new ActionExecutor(product, selectedConfig, inputRoot, trialRoot);
    await executor.execute({ action: 'new_session', alias: 'main' });
    await executor.execute({ action: 'import', alias: 'zj', materialRef: 'materials/zj-snapshot' });
    await executor.execute({ action: 'select_workspace', batchAliases: [1, 2, 3, 4].map(index => `zj:batch:${index}`), ...(scenario.device ? { device: 'SYN-ZJ-A' } : {}) });
    const workspace = unwrap(await product.request('workspace.read', {})), currentConfig = unwrap(await product.request('model.config.read', {})), sessionId = executor.aliases.sessions.get('main')!.id;
    const params = QueryParamsSchema.parse({ kind: 'current', population: 'snapshot', snapshotMode: 'exact_date', batchIds: workspace.batchRefs.map(batch => batch.id), deviceIds: scenario.device ? workspace.deviceIds : null,
      region: '浙江', category: scenario.category, time: { start: scenario.date, endExclusive: scenario.end } });
    const accepted = unwrap(await product.request('session.submit', { sessionId, clientSequence: 1, text: `Query form: ${canonicalRequest(params)}`, mode: 'send', routing: { mode: 'user_form', params },
      expectedRevision: workspace.revision, expectedBatchIds: params.batchIds, expectedQueryId: null, model: { provider: 'openai', modelId: 'gpt-4o-mini', expectedConfigVersion: currentConfig.configVersion }, referenceDate: '2026-10-02', timezone: 'Asia/Shanghai' }, 'engineering-empty'));
    if (accepted.runId === null) throw new Error('form_run_missing');
    executor.aliases.runs.set('turn-1', accepted.runId); executor.aliases.inputs.set('turn-1', { sessionId, clientSequence: 1, inputId: accepted.inputId }); executor.lastSendAlias = 'turn-1';
    await executor.wait('run_settled', 'turn-1', 10000);
    const observation = await collectObservation({ executionId: 'engineering', trialId: 'empty', product, aliases: executor.aliases, lastSendAlias: executor.lastSendAlias, trialRoot, observedFrom, pageSize: 2 });
    expect(observation.facts.modelCalls).toEqual([]);
    expect((observation.facts.queryPages as any[]).flatMap(page => page.page.rows)).toEqual([]);
    const checks = item.expected.checks.filter(check => ['query.conditions', 'query.set_exact', 'query.numeric', 'query.facts', 'query.coverage', 'evidence.present'].includes(check.metricId)), gold = structuredClone(dataset.gold[item.id]!);
    if (scenario.device) (gold.values.query_conditions as any).sourceDeviceId = 'SYN-ZJ-A';
    if (!scenario.category) expect(checks.some(check => check.metricId === 'query.coverage')).toBe(true);
    const scoring = { trialId: 'empty', caseId: item.id, task: { checks }, gold, observation, trialStatus: 'completed' };
    const scores = await evaluate(scoring), applicable = scores.filter(score => score.applicable);
    expect(applicable.map(score => ({ metric: score.metricId, status: score.status, reason: score.status === 'PASS' ? null : score.reason }))).toEqual(applicable.map(score => ({ metric: score.metricId, status: 'PASS', reason: null })));
    if (scenario.category) expect(scores.find(score => score.metricId === 'query.numeric')).toMatchObject({ applicable: false, denominator: 0, status: 'UNJUDGEABLE' });
    const incorrect = structuredClone(scoring.gold), metric = scenario.category ? 'query.conditions' : 'query.coverage';
    if (scenario.category) (incorrect.values.query_conditions as any).category = 'wrong-category';
    else (incorrect.values.query_coverage as any).complete = true;
    expect((await evaluate({ ...scoring, gold: incorrect })).find(score => score.metricId === metric)!.status).toBe('FAIL');
    if (scenario.device) {
      const missing = { ...observation, facts: { ...observation.facts, identitySnapshots: [] } };
      expect((await evaluate({ ...scoring, observation: missing })).find(score => score.metricId === 'query.conditions')!.status).toBe('UNJUDGEABLE');
      const tampered = { ...observation, facts: { ...observation.facts, identitySnapshots: (observation.facts.identitySnapshots as any[]).map(row => ({ ...row, deviceName: 'wrong identity' })) } };
      expect((await evaluate({ ...scoring, observation: tampered })).find(score => score.metricId === 'query.conditions')!.status).toBe('UNJUDGEABLE');
    } else if (!scenario.category) {
      for (const facts of [
        { ...observation.facts, catalogPages: (observation.facts.catalogPages as any[]).slice(1) },
        { ...observation.facts, operations: [] },
        { ...observation.facts, catalogPages: (observation.facts.catalogPages as any[]).map(page => ({ ...page, batches: page.batches.map((batch: any) => ({ ...batch, snapshotDate: '2026-09-30' })) })) },
      ]) expect((await evaluate({ ...scoring, observation: { ...observation, facts } })).find(score => score.metricId === 'query.coverage')!.status).toBe('UNJUDGEABLE');
    }
  } finally { if (product) expect(await product.stop()).toMatchObject({ stopped: true, closed: true, processExited: true }); await rm(root, { recursive: true, force: true }); }
}, 60000);

test('cleanup rejects active or wrongly owned product roots and retains verified evidence after actual shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-eval-cleanup-')); let product, stopped = false;
  try {
    product = await prepareInstance({ trialRoot: root, config: config(), owner: { executionId: 'engineering', trialId: 'cleanup', caseId: 'cleanup' } });
    const executor = new ActionExecutor(product, config(), root, root); await executor.execute({ action: 'new_session', alias: 'A' });
    const observation = await collectObservation({ executionId: 'engineering', trialId: 'cleanup', product, aliases: executor.aliases, trialRoot: root, observedFrom: new Date().toISOString() });
    const owner = { trialRoot: root, executionId: 'engineering', trialId: 'cleanup', instanceId: product.instanceId, observation };
    await expect(cleanupInstance({ ...owner, proof: { stopped: null, closed: true, processExited: false, residuals: [] } })).rejects.toThrow('cleanup_stop_unconfirmed');
    expect(JSON.parse(await readFile(join(root, 'cleanup.json'), 'utf8'))).toMatchObject({ status: 'preserved', reason: 'cleanup_stop_unconfirmed' });
    await expect(cleanupInstance({ ...owner, proof: { stopped: true, closed: true, processExited: true, residuals: [] } })).rejects.toThrow('cleanup_process_still_alive');
    const proof = await product.stop(); stopped = proof.stopped === true && proof.closed === true;
    await expect(cleanupInstance({ ...owner, executionId: 'other', proof })).rejects.toThrow('cleanup_ownership_unconfirmed');
    await cleanupInstance({ ...owner, proof }); expect(await Bun.file(join(root, 'product', 'data', 'app.sqlite')).exists()).toBe(false); expect(await Bun.file(join(root, 'observation.json')).exists()).toBe(true);
    expect(JSON.parse(await readFile(join(root, 'cleanup.json'), 'utf8'))).toMatchObject({ status: 'removed', reason: null });
  } finally { if (product && !stopped) expect(await product.stop()).toMatchObject({ stopped: true, closed: true }); if (stopped) await rm(root, { recursive: true, force: true }); }
}, 60000);
