import { performance } from 'node:perf_hooks';
import type { Judge, JudgeMetadata, JudgeRequest, JudgeResult } from '../types.ts';
import { record } from '../rules.ts';
import { ANSWER_QUALITY_RUBRIC } from './answer-quality.ts';
import { isDeepStrictEqual } from 'node:util';
import { JudgeConfigurationSchema,RunConfigSchema,type AgentModelCredential,type ResolvedRunConfig,type JudgeConfiguration } from '../../types.ts';
import { resolveAgentModel } from '../../adapters/model.ts';

export function assertJudgeMatches(expected:JudgeConfiguration|undefined,actual:JudgeConfiguration|undefined) {
  if(!expected||!actual||!isDeepStrictEqual(JudgeConfigurationSchema.parse(expected),JudgeConfigurationSchema.parse(actual)))throw new Error('judge_configuration_mismatch');
}

export function assertJudgeCallMatches(expected:JudgeConfiguration|undefined,metadata:JudgeMetadata) {
  assertJudgeMatches(expected,expected&&{baseUrl:metadata.baseUrl,model:metadata.model,timeoutMs:metadata.timeoutMs,temperature:metadata.temperature,systemRubric:expected.systemRubric,
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
  const config = {...input,model,...judgeConfig?{judge:JudgeConfigurationSchema.parse({baseUrl:judgeConfig.baseUrl,model:judgeConfig.model,timeoutMs:judgeConfig.timeoutMs})}:{}};
  return {config,modelCredential,judgeConfig};
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
  constructor(private readonly config: JudgeConfig, private readonly plan: { plannedTrials: number; trialIds?: string[] }) {
    if(!Number.isSafeInteger(plan.plannedTrials)||plan.plannedTrials<0)throw new Error('Invalid Judge request plan');
    if (!config.apiKey.trim() || !config.model.trim() || !Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 30000) throw new Error('Invalid Judge configuration');
    validateUrl(config.baseUrl);
    this.configuration=Object.freeze(JudgeConfigurationSchema.parse({baseUrl:config.baseUrl,model:config.model,timeoutMs:config.timeoutMs}));
    if (plan.trialIds && (plan.trialIds.length !== plan.plannedTrials || new Set(plan.trialIds).size !== plan.trialIds.length)) throw new Error('Judge plan identities must be unique and complete');
  }
  async judge(request: JudgeRequest, signal?: AbortSignal): Promise<JudgeResult> {
    if (this.attempted.has(request.trialId)) throw new Error('Judge already attempted for this trial');
    if (this.attempted.size >= this.plan.plannedTrials || this.plan.trialIds && !this.plan.trialIds.includes(request.trialId)) throw new Error('Judge request is outside planned trials');
    this.attempted.add(request.trialId);
    const started = performance.now(), controller = new AbortController();
    const metadata: JudgeMetadata = { baseUrl:this.configuration.baseUrl,timeoutMs:this.configuration.timeoutMs,model: this.config.model, startedAt: new Date().toISOString(), endedAt: '', durationMs: 0, temperature: .8, httpStatus: null, requestId: null, usage: { promptTokens: null, completionTokens: null } };
    const cancel = () => controller.abort(new Error('Judge cancelled'));
    const timer = setTimeout(() => controller.abort(new Error('Judge timeout')), this.config.timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let results: JudgeResult['results'] = [], error: string | null = null;
    try {
      if (!request.checks.length || new Set(request.checks.map(x => x.checkId)).size !== request.checks.length || request.checks.some(x => !x.rubric.trim() || !x.evidenceRefs.length)) throw new Error('Judge request requires unique checks, recorded rubrics, and evidence');
      const url = this.config.baseUrl.replace(/\/$/, '') + '/chat/completions';
      const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` }, body: JSON.stringify({ model: this.config.model, temperature: .8, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: ANSWER_QUALITY_RUBRIC }, { role: 'user', content: JSON.stringify(request) }] }), signal: controller.signal });
      metadata.httpStatus = response.status;
      const requestId = response.headers.get('x-request-id');
      if (requestId?.includes(this.config.apiKey)) throw new Error('Judge response echoed protected credentials');
      metadata.requestId = requestId?.slice(0, 256) ?? null;
      if (!response.ok) throw new Error(`Judge HTTP ${response.status}`);
      const responseText = await response.text();
      if (responseText.length > 65536 || responseText.includes(this.config.apiKey)) throw new Error('Judge response exceeded limits or echoed protected credentials');
      const body: unknown = JSON.parse(responseText);
      if (!record(body) || !Array.isArray(body.choices) || body.choices.length !== 1 || body.choices[0]?.finish_reason !== 'stop' || typeof body.choices[0]?.message?.content !== 'string') throw new Error('Judge response is truncated or malformed');
      const tokens = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : null;
      metadata.usage = { promptTokens: tokens(body.usage?.prompt_tokens), completionTokens: tokens(body.usage?.completion_tokens) };
      results = parseResults(body.choices[0].message.content, request);
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
