import { test, expect } from 'bun:test';
import { runConfigFixture } from './report-fixture.ts';
import { resolveRunConfig } from '../src/scoring/judges/client.ts';
import { RunConfigSchema } from '../src/types.ts';
import { reportFixture } from './report-fixture.ts';
import { compareReports } from '../src/reports/compare.ts';
import { prepareInstance } from '../src/execution/instance.ts';
import { unwrap,ProductAdapter } from '../src/adapters/product.ts';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HOST_PROTOCOL_VERSION } from '../../packages/contracts/src/protocol.ts';

const agentInput=runConfigFixture;

test('DeepSeek official Anthropic endpoint selects Messages without changing native model limits',async()=>{
  const input=agentInput();input.model.model='deepseek-flash';input.model.url='https://api.deepseek.com';
  const baseline=await resolveRunConfig(input,{},'off',false);
  for(const url of ['https://api.deepseek.com/anthropic','https://api.deepseek.com/anthropic/']) {
    const resolved=await resolveRunConfig({...input,model:{...input.model,url}}, {},'off',false);
    expect(resolved.config.model.definition).toMatchObject({api:'anthropic-messages',baseUrl:url});
    expect(resolved.config.model.definition!.models).toEqual(baseline.config.model.definition!.models);
    expect(resolved.config.model.maxTokens).toBe(baseline.config.model.maxTokens);
    expect(resolved.modelCredential).toEqual(baseline.modelCredential);
  }
  const other=await resolveRunConfig({...input,model:{...input.model,url:'https://proxy.example.invalid/anthropic'}},{},'off',false);
  expect(other.config.model.definition!.api).toBe(baseline.config.model.definition!.api);
});

test('author model requires only url/key/model and rejects manual native limits',()=>{
  const input=agentInput();
  expect(RunConfigSchema.parse(input).model).toEqual(input.model);
  for(const extra of [{provider:'openai'},{maxTokens:2048},{contextWindow:4096}])expect(()=>RunConfigSchema.parse({...input,model:{...input.model,...extra}})).toThrow();
  for(const key of ['url','key','model']) {
    const incomplete:Record<string,unknown>={...input.model};delete incomplete[key];
    expect(()=>RunConfigSchema.parse({...input,model:incomplete})).toThrow();
  }
  expect(()=>RunConfigSchema.parse({...input,model:{...input.model,key:' '}})).toThrow();
  expect(()=>RunConfigSchema.parse({...input,model:{...input.model,url:'https://user:secret@agent.example.invalid/v1'}})).toThrow();
});

test('native catalog resolves input/output capabilities offline and keeps the key out of the recorded config',async()=>{
  const {config,modelCredential,judgeConfig}=await resolveRunConfig(agentInput(),{},'off',true);
  expect(config.model).toMatchObject({model:'gpt-4o-mini',maxTokens:16384});
  expect(config.model.definition).toMatchObject({baseUrl:agentInput().model.url,models:[{id:'gpt-4o-mini',contextWindow:128000,maxTokens:16384}]});
  expect(modelCredential).toEqual({providerId:config.model.provider,key:agentInput().model.key});
  expect(judgeConfig).toBeNull();
  expect(JSON.stringify(config).includes(agentInput().model.key)).toBe(false);
  expect(Object.hasOwn(config.model,'key')).toBe(false);
  expect(Object.hasOwn(config.model,'url')).toBe(false);
  expect(agentInput().model).not.toHaveProperty('maxTokens');
});

test('unknown and ambiguous model references cannot invent capabilities or silently select another model',async()=>{
  const input=agentInput();
  await expect(resolveRunConfig({...input,model:{...input.model,model:'missing-model-v1'}},{},'off',false)).rejects.toThrow('agent_model_not_found_or_ambiguous');
  await expect(resolveRunConfig({...input,model:{...input.model,model:'gpt-4o-mini'}},{},'off',false)).rejects.toThrow('agent_model_not_found_or_ambiguous');
});

test('declared model changes compare their derived native capabilities but cannot hide endpoint changes',async()=>{
  const input=agentInput(),a=reportFixture(),b=reportFixture();
  Object.assign(a.config,(await resolveRunConfig(input,{},'off',false)).config);
  Object.assign(b.config,(await resolveRunConfig({...input,model:{...input.model,model:'openai/gpt-4o'}},{},'off',false)).config);
  b.config.comparison={baselineExecutionId:a.executionId,factors:['model.model']};
  expect(compareReports(a,b).matchedTrials).toBe(1);
  b.config.model.definition!.baseUrl='https://different.example.invalid/v1';
  expect(()=>compareReports(a,b)).toThrow('incompatible');
});

test('private Agent credentials are scoped to their provider and runtime reference without entering traces',async()=>{
  const {modelCredential}=await resolveRunConfig(agentInput(),{},'off',false);
  const adapter=new ProductAdapter({dataRoot:tmpdir(),tracePath:join(tmpdir(),'unused-model-trace'),modelCredential});
  adapter.instanceId='controlled-instance';
  let reply:any;
  Reflect.set(adapter,'write',async(frame:unknown)=>{reply=frame;});
  const request=(providerId:string,credentialRef?:string|null,purpose='runtime')=>Reflect.get(adapter,'privateRequest').call(adapter,
    {protocolVersion:HOST_PROTOCOL_VERSION,kind:'private',instanceId:adapter.instanceId,requestId:'controlled-read',secret:true,method:'credential.read',payload:{providerId,context:{purpose,operationRef:'controlled-operation',...(credentialRef!==undefined?{credentialRef}:{})}}});
  await request(modelCredential.providerId,'eval-model-key');
  expect(reply.result).toEqual({ok:true,data:{type:'api_key',key:modelCredential.key}});
  await request('another-provider');expect(reply.result).toEqual({ok:true,data:null});
  for(const ref of [null,'wrong-reference']){await request(modelCredential.providerId,ref);expect(reply.result.ok).toBe(false);}
  await request(modelCredential.providerId,'eval-model-key','auth');expect(reply.result.ok).toBe(false);
  expect(adapter.traces).toEqual([]);
});

test('real local Host uses the configured endpoint, key and native capabilities without inference',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-model-connection-'));
  const paths:string[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
    const path=new URL(request.url).pathname;paths.push(path);
    if(path==='/api/version')return Response.json({version:'controlled-metadata'});
    if(path==='/api/tags')return Response.json({models:[{name:'qwen3.5:0.8b'}]});
    if(path==='/api/show')return Response.json({details:{family:'controlled',parameter_size:'fixture',quantization_level:'fixture'}});
    return new Response('Inference forbidden',{status:403});
  }});
  let product;
  try{
    const input=agentInput();input.model.url=server.url.href+'v1';input.intent.baseUrl=server.url.href.slice(0,-1);
    const {config,modelCredential}=await resolveRunConfig(input,{},'off',false);
    product=await prepareInstance({trialRoot:join(root,'trial'),config,modelCredential});
    const directory=unwrap(await product.request('model.read',{}));
    expect(directory.selection).toMatchObject({provider:config.model.provider,modelId:'gpt-4o-mini',maxOutputTokens:16384});
    expect(directory.providers.find(provider=>provider.id===config.model.provider)?.auth.state).toBe('available');
    expect(directory.models.find(model=>model.provider===config.model.provider)).toMatchObject({contextWindow:128000,maxTokens:16384});
    expect(unwrap(await product.request('model.custom.read',{providerId:config.model.provider})).definitions[0]?.baseUrl).toBe(input.model.url);
    expect((await readFile(product.paths.settingsPath,'utf8')).includes(modelCredential.key)).toBe(false);
    expect((await readFile(join(root,'trial/events.jsonl'),'utf8')).includes(modelCredential.key)).toBe(false);
    expect(paths.every(path=>['/api/version','/api/tags','/api/show'].includes(path))).toBe(true);
  }finally{if(product)expect(await product.stop()).toMatchObject({stopped:true,closed:true,processExited:true});server.stop(true);await rm(root,{recursive:true,force:true});}
},30000);
