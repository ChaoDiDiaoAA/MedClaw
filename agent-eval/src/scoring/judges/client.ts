import { performance } from 'node:perf_hooks';
import type { Judge, JudgeMetadata, JudgeRequest, JudgeResult } from '../types.ts';
import { record } from '../rules.ts';
import { ANSWER_QUALITY_RUBRIC } from './answer-quality.ts';
import { isDeepStrictEqual } from 'node:util';
import { JudgeConfigurationSchema,RunConfigSchema,type AgentModelCredential,type ResolvedRunConfig,type JudgeConfiguration } from '../../types.ts';
import { resolveAgentModel,resolveEvaluationModel } from '../../adapters/model.ts';
import { textOf,SDK_VERSION } from '../../../../packages/runtime-pi/src/model-runtime.ts';
import { safeUsage } from '../../../../packages/contracts/src/run.ts';

export function assertJudgeMatches(expected:JudgeConfiguration|undefined,actual:JudgeConfiguration|undefined) {
  if(!expected||!actual||!isDeepStrictEqual(JudgeConfigurationSchema.parse(expected),JudgeConfigurationSchema.parse(actual)))throw new Error('judge_configuration_mismatch');
}

export function assertJudgeCallMatches(expected:JudgeConfiguration|undefined,metadata:JudgeMetadata) {
  assertJudgeMatches(expected,expected&&{baseUrl:metadata.baseUrl,model:metadata.model,timeoutMs:metadata.timeoutMs,temperature:metadata.temperature,systemRubric:expected.systemRubric,
    ...metadata.nativeModel?{nativeModel:metadata.nativeModel}:{},
    ...Object.hasOwn(metadata,'outputLimit')?{outputLimit:metadata.outputLimit}:{}});
}

export interface JudgeConfig { baseUrl: string; model: string; apiKey: string; timeoutMs: number }
export type JudgeMode = 'off' | 'auto' | 'required';
function validateUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Invalid Judge base URL; plaintext HTTP is limited to loopback');
  return url;
}
export function readJudgeConfig(env: Record<string, string | undefined>, mode: JudgeMode, selected: boolean): JudgeConfig | null {
  const values = [env.MEDCLAW_JUDGE_BASE_URL, env.MEDCLAW_JUDGE_MODEL, env.MEDCLAW_JUDGE_API_KEY];
  const configured = values.filter(x => x?.trim()).length;
  if (configured > 0 && configured < 3) throw new Error('Partial MEDCLAW_JUDGE configuration');
  if (mode === 'off') return null;
  if (!selected) return null;
  if (!configured) {
    if (mode === 'required' || selected) throw new Error('Independent Judge configuration is required');
    return null;
  }
  const url = validateUrl(values[0]!);
  return { baseUrl: url.toString(), model: values[1]!.trim(), apiKey: values[2]!, timeoutMs: 30000 };
}
export async function resolveRunConfig(raw: unknown, env: Record<string, string | undefined>, mode: JudgeMode, selected: boolean): Promise<{config:ResolvedRunConfig;modelCredential:AgentModelCredential;judgeConfig:JudgeConfig|null}> {
  const input = RunConfigSchema.parse(raw);
  const judgeConfig = readJudgeConfig(env, mode, selected);
  const {model,modelCredential}=await resolveAgentModel(input.model);
  const judge=judgeConfig?await resolveJudgeModel(judgeConfig):undefined;
  const config = {...input,model,...judge?{judge:judge.configuration}:{}};
  return {config,modelCredential,judgeConfig};
}
async function resolveJudgeModel(config:JudgeConfig) {
  const resolved=await resolveEvaluationModel({url:config.baseUrl,model:config.model}).catch(error=>{
    if(error instanceof Error&&error.message==='agent_model_not_found_or_ambiguous')throw new Error('judge_model_not_found_or_ambiguous');
    throw error;
  });
  const {model,catalogRef,runtime}=resolved;
  runtime.native.registerProvider('medclaw-judge',{name:'Evaluation Judge',baseUrl:model.baseUrl,api:model.api,models:[{...model}]});
  const refresh=await runtime.native.refresh({allowNetwork:false});
  const registered=runtime.native.getModel('medclaw-judge',model.id);
  if(refresh.aborted||refresh.errors.size||!registered)throw new Error('judge_provider_registration_failed');
  const configuration=JudgeConfigurationSchema.parse({baseUrl:config.baseUrl,model:config.model,timeoutMs:config.timeoutMs,
    nativeModel:{catalogRef,api:model.api,contextWindow:model.contextWindow,maxTokens:model.maxTokens,sdkVersion:SDK_VERSION}});
  return {...resolved,model:registered,configuration};
}
const exactKeys = (x: Record<string, any>, keys: string[]) => Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
function parseResults(content: string, request: JudgeRequest): JudgeResult['results'] {
  const parsed: unknown = JSON.parse(content);
  if (!record(parsed) || !exactKeys(parsed, ['results']) || !Array.isArray(parsed.results) || parsed.results.length !== request.checks.length) throw new Error('Invalid Judge response schema');
  const seen = new Set<string>();
  for (const result of parsed.results) {
    if (!record(result) || !exactKeys(result, ['checkId', 'value', 'reason', 'evidenceRefs'])) throw new Error('Invalid Judge result keys');
    const check = request.checks.find(x => x.checkId === result.checkId);
    if (!check || seen.has(result.checkId)) throw new Error('Unknown or duplicate Judge check');
    seen.add(result.checkId);
    if (result.value !== null && (![0, .5, 1].includes(result.value) || !Number.isFinite(result.value))) throw new Error('Judge value is out of fixed rubric range');
    if (typeof result.reason !== 'string' || !result.reason.trim() || result.reason.length > 2000) throw new Error('Judge reason is empty or too long');
    if (!Array.isArray(result.evidenceRefs) || !result.evidenceRefs.every((ref: unknown) => typeof ref === 'string' && check.evidenceRefs.includes(ref)) || new Set(result.evidenceRefs).size !== result.evidenceRefs.length || (result.value !== null && result.evidenceRefs.length === 0)) throw new Error('Judge references unsupported evidence');
  }
  return parsed.results;
}

export class JudgeClient implements Judge {
  readonly configuration:JudgeConfiguration;
  private readonly attempted = new Set<string>();
  static async create(config:JudgeConfig,plan:{plannedTrials:number;trialIds?:string[]}) {
    if(!Number.isSafeInteger(plan.plannedTrials)||plan.plannedTrials<0)throw new Error('Invalid Judge request plan');
    if (!config.apiKey.trim() || !config.model.trim() || !Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 30000) throw new Error('Invalid Judge configuration');
    validateUrl(config.baseUrl);
    if (plan.trialIds && (plan.trialIds.length !== plan.plannedTrials || new Set(plan.trialIds).size !== plan.trialIds.length)) throw new Error('Judge plan identities must be unique and complete');
    return new JudgeClient(config,plan,await resolveJudgeModel(config));
  }
  private constructor(private readonly config:JudgeConfig,private readonly plan:{plannedTrials:number;trialIds?:string[]},private readonly resolved:Awaited<ReturnType<typeof resolveJudgeModel>>) {
    this.configuration=Object.freeze(resolved.configuration);
  }
  async judge(request: JudgeRequest, signal?: AbortSignal): Promise<JudgeResult> {
    if (this.attempted.has(request.trialId)) throw new Error('Judge already attempted for this trial');
    if (this.attempted.size >= this.plan.plannedTrials || this.plan.trialIds && !this.plan.trialIds.includes(request.trialId)) throw new Error('Judge request is outside planned trials');
    this.attempted.add(request.trialId);
    const started = performance.now(), controller = new AbortController();
    const metadata: JudgeMetadata = { baseUrl:this.configuration.baseUrl,timeoutMs:this.configuration.timeoutMs,model: this.config.model,nativeModel:this.configuration.nativeModel, startedAt: new Date().toISOString(), endedAt: '', durationMs: 0, temperature: .8, httpStatus: null, requestId: null, usage: { promptTokens: null, completionTokens: null } };
    const cancel = () => controller.abort(new Error('Judge cancelled'));
    const timer = setTimeout(() => controller.abort(new Error('Judge timeout')), this.config.timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let results: JudgeResult['results'] = [], error: string | null = null;
    try {
      if (!request.checks.length || new Set(request.checks.map(x => x.checkId)).size !== request.checks.length || request.checks.some(x => !x.rubric.trim() || !x.evidenceRefs.length)) throw new Error('Judge request requires unique checks, recorded rubrics, and evidence');
      controller.signal.throwIfAborted();
      const message=await this.resolved.runtime.native.completeSimple(this.resolved.model,
        {systemPrompt:ANSWER_QUALITY_RUBRIC,messages:[{role:'user',content:JSON.stringify(request),timestamp:Date.now()}]},
        {apiKey:this.config.apiKey,temperature:.8,signal:controller.signal,timeoutMs:this.config.timeoutMs,maxRetries:0,
          fetch:Object.assign(async (input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
            const response=await fetch(input,{...init,redirect:'error'});
            metadata.httpStatus=response.status;
            const requestId=response.headers.get('x-request-id')??response.headers.get('request-id');
            if(requestId?.includes(this.config.apiKey))throw new Error('Judge response echoed protected credentials');
            metadata.requestId=requestId?.slice(0,256)??null;
            return response;
          },{preconnect:fetch.preconnect})});
      if(JSON.stringify(message).includes(this.config.apiKey))throw new Error('Judge response echoed protected credentials');
      if(metadata.httpStatus!==null&&(metadata.httpStatus<200||metadata.httpStatus>=300))throw new Error(`Judge HTTP ${metadata.httpStatus}`);
      if(message.stopReason!=='stop'||message.content.some(part=>part.type==='toolCall'))throw new Error('Judge response is truncated or malformed');
      const usage=safeUsage(message.usage,false);
      metadata.usage={promptTokens:usage.inputTokens,completionTokens:usage.outputTokens};
      const parsed=parseResults(textOf(message),request);
      if(JSON.stringify(parsed).includes(this.config.apiKey))throw new Error('Judge response echoed protected credentials');
      results=parsed;
    } catch (cause) {
      // Provider bodies and exception messages may contain credentials; retain only controlled categories.
      const message = cause instanceof Error ? cause.message : '';
      error = controller.signal.aborted ? signal?.aborted ? 'Judge cancelled' : 'Judge timeout' : /^(Judge|Invalid|Unknown)/.test(message) ? message.replaceAll(this.config.apiKey, '[redacted]') : 'Judge transport or JSON protocol error';
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      metadata.endedAt = new Date().toISOString();
      metadata.durationMs = performance.now() - started;
    }
    return { status: error ? 'error' : 'completed', results, error, metadata };
  }
}
