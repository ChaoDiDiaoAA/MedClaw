import { PiModelRuntime } from '../../../packages/runtime-pi/src/model-runtime.ts';
import { CustomProviderDefinitionSchema } from '../../../packages/contracts/src/model.ts';
import type { ResolvedRunConfig } from '../types.ts';

export async function resolveEvaluationModel(input:{url:string;model:string}) {
  const runtime=await PiModelRuntime.create({
    credentials:{read:async()=>undefined,list:async()=>[],modify:async()=>{throw new Error('agent_catalog_read_only');},delete:async()=>{throw new Error('agent_catalog_read_only');}},
    modelsStore:{read:async()=>undefined,write:async()=>{throw new Error('agent_catalog_read_only');},delete:async()=>{throw new Error('agent_catalog_read_only');}},
  });
  const models=runtime.native.getModels();
  const endpoint=new URL(input.url);
  // DeepSeek documents these retired names as aliases of Flash; keep the requested wire identity.
  const alias=endpoint.hostname==='api.deepseek.com'&&['deepseek-v4-flash','deepseek-v4-flash-vision-exp'].includes(input.model);
  const lookup=alias?'deepseek/deepseek-flash':input.model;
  const canonical=models.filter(model=>`${model.provider}/${model.id}`===lookup);
  const matches=canonical.length?canonical:models.filter(model=>model.id===lookup);
  if(matches.length!==1)throw new Error('agent_model_not_found_or_ambiguous');
  const native=matches[0]!;
  const api=endpoint.hostname==='api.deepseek.com'&&endpoint.pathname.replace(/\/$/,'')==='/anthropic'?'anthropic-messages':native.api;
  return {runtime,model:{...native,id:alias?input.model:native.id,api,baseUrl:input.url},catalogRef:`${native.provider}/${native.id}`};
}

export async function resolveAgentModel(input:{url:string;key:string;model:string}) {
  const {model:native}=await resolveEvaluationModel(input);
  const cost={input:native.cost.input,output:native.cost.output,cacheRead:native.cost.cacheRead,cacheWrite:native.cost.cacheWrite};
  const pricingKnown=Object.values(cost).every(value=>Number.isFinite(value)&&value>=0);
  const definition=CustomProviderDefinitionSchema.parse({providerId:'medclaw-eval',name:`Evaluation: ${native.provider}/${native.id}`,api:native.api,baseUrl:input.url,
    models:[{id:native.id,name:native.name,input:[...native.input],reasoning:native.reasoning,contextWindow:native.contextWindow,maxTokens:native.maxTokens,outputLimitConfirmed:true,pricingKnown,cost:pricingKnown?cost:null}]});
  const model:ResolvedRunConfig['model']={provider:definition.providerId,model:native.id,maxTokens:native.maxTokens,definition};
  return {model,modelCredential:{providerId:definition.providerId,key:input.key}};
}
