import { performance } from 'node:perf_hooks';
import { safeError, type AppError } from '../../../contracts/src/error';
import { createToolControlObservation, type AgentPolicy, type BudgetSummary, type MeasurementContext, type ToolControlObservation, type ToolProfileSnapshot } from '../../../contracts/src/model';
import { canonicalRequest, type RunScope, type RuntimeBudgetView } from '../../../contracts/src/run';
import { groupWorkload, TOOL_PROFILE_RULES } from '../tools/tool-profile';
import { normalizeToolConfiguration, type ToolConfiguration } from '@medclaw/contracts/tool-config';
import { normalizeRuntimeConfiguration, RUNTIME_CONFIG, type RuntimeConfiguration } from '@medclaw/contracts/runtime-config';
import type { ModelAdmissionPreview } from '../../../contracts/src/context';

export const RUN_CONTROL_RULES = Object.freeze({
  callConvergenceRatio: 0.75,
  remainingTimeConvergenceRatio: 0.25,
  answerReserveMaxMs: 10000,
  answerReserveRatio: 0.1,
  readTimeoutFloorMs: 1000,
  workTimeoutFloorMs: 5000,
  timeoutMultiplier: 2,
});

type Failure = { code: string; stage: string; recordId: number | null; queryId: number | null; evidenceId: number | null; queryCommitUnknown?: boolean; delivered: boolean };
type Attempt = {
  name: string;
  raw: unknown;
  prepared?: string;
  allowed: boolean;
  observation: ToolControlObservation;
  lease?: { controller: AbortController; signal: AbortSignal; timer: ReturnType<typeof setTimeout>; started: number; deadline: number; requested: number | null; finished: boolean };
  repairOf?: string;
  repairs?: string[];
  result?: { status: string; data?: unknown; error?: { code: string } };
};
type Options = {
  runId: number;
  policy?: AgentPolicy;
  scope: RunScope;
  signal: AbortSignal;
  deadlineAt: number;
  totalTimeoutMs?: number;
  measurementContext?: MeasurementContext | null;
  toolProfileSnapshot?: ToolProfileSnapshot | null;
  toolConfiguration?: ToolConfiguration;
  runtimeConfiguration?: RuntimeConfiguration;
};

/** One Run's control facts; Pi remains the sole owner of loop and scheduling. */
export class RunControl {
  private readonly attempts = new Map<string, Attempt>();
  private readonly failures = new Map<string, Failure>();
  private toolCalls = 0;
  private modelCalls = 0;
  private toolAdmissionsRejected = 0;
  private modelAdmissionsRejected = 0;
  private allowTools = true;
  private convergenceRequested = false;
  private episodeId: string | null = null;
  private episodeSequence = 0;
  private episodeUsed = 0;
  private recoveryAttempts = 0;
  private stopReason: string | null = null;
  private revision = 0;
  private readonly previews = new WeakMap<ModelAdmissionPreview, {allowTools:boolean; convergence:boolean; episodeUsed:number; recoveryAttempts:number; stopReason:string|null}>();
  private readonly options: Options;
  private readonly configurationSnapshot: ToolConfiguration;
  private readonly runtimeSnapshot: RuntimeConfiguration;
  constructor(options: Options) {
    this.configurationSnapshot = normalizeToolConfiguration(options.toolConfiguration);
    this.runtimeSnapshot = normalizeRuntimeConfiguration({ runtimeConfiguration: options.runtimeConfiguration, agentPolicy: options.policy,
      requestPolicy: options.totalTimeoutMs === undefined ? undefined : { timeoutMs: options.totalTimeoutMs, ...(options.runtimeConfiguration?.llm ?? RUNTIME_CONFIG.llm) } });
    this.options = { ...options, scope: structuredClone(options.scope) };
  }
  get configuration(): ToolConfiguration { return structuredClone(this.configurationSnapshot); }
  get runtimeConfiguration(): RuntimeConfiguration { return structuredClone(this.runtimeSnapshot); }

  private remaining() { return Math.max(0, this.options.deadlineAt - performance.now()); }
  checkActive = () => {
    if (this.options.signal.aborted) throw new Error('tool_cancelled');
    if (this.remaining() <= 0) throw new Error('run_timeout');
  };
  previewModelCall(): ModelAdmissionPreview {
    this.checkActive();
    if (this.modelCalls >= this.runtimeSnapshot.runBudget.maxModelCalls) throw new Error('agent_call_limit');
    const preparedAt = performance.now(), remainingTimeMs = Math.max(0,this.options.deadlineAt - preparedAt), modelCalls = this.modelCalls + 1;
    const scheduling = RUN_CONTROL_RULES;
    const reserve = Math.min(scheduling.answerReserveMaxMs, this.runtimeSnapshot.runBudget.timeoutMs * scheduling.answerReserveRatio);
    const allowTools = modelCalls < this.runtimeSnapshot.runBudget.maxModelCalls && this.toolCalls < this.runtimeSnapshot.runBudget.maxToolCalls
      && remainingTimeMs > reserve && (!this.episodeId || this.episodeUsed < this.runtimeSnapshot.runBudget.maxRecoveryAttempts);
    const episodeUsed = this.episodeUsed + (this.episodeId && allowTools ? 1 : 0), recoveryAttempts = this.recoveryAttempts + (this.episodeId && allowTools ? 1 : 0);
    const convergence = this.convergenceRequested || this.toolCalls >= this.runtimeSnapshot.runBudget.maxToolCalls * scheduling.callConvergenceRatio
      || modelCalls >= this.runtimeSnapshot.runBudget.maxModelCalls * scheduling.callConvergenceRatio
      || remainingTimeMs < this.runtimeSnapshot.runBudget.timeoutMs * scheduling.remainingTimeConvergenceRatio;
    const budget = this.readBudget(); budget.modelCalls.used = modelCalls; budget.modelCalls.remaining = Math.max(0,budget.modelCalls.limit-modelCalls);
    budget.remainingTimeMs = remainingTimeMs; budget.recovery.used = episodeUsed; budget.recovery.remaining = Math.max(0,this.runtimeSnapshot.runBudget.maxRecoveryAttempts-episodeUsed);
    const preview = Object.freeze({revision:this.revision,preparedAt,allowTools,feedback:this.feedback(budget,convergence,allowTools)});
    this.previews.set(preview,{allowTools,convergence,episodeUsed,recoveryAttempts,stopReason:!allowTools && this.episodeId && episodeUsed >= this.runtimeSnapshot.runBudget.maxRecoveryAttempts ? 'tool_recovery_limit' : this.stopReason});
    return preview;
  }
  admitModelCall(preview?: ModelAdmissionPreview): { allowTools: boolean; feedback: string } {
    this.checkActive();
    if (!preview && this.modelCalls >= this.runtimeSnapshot.runBudget.maxModelCalls) { this.modelAdmissionsRejected++; this.stopReason='agent_call_limit'; throw new Error('agent_call_limit'); }
    preview ??= this.previewModelCall();
    const decision = this.previews.get(preview);
    if (!decision || preview.revision !== this.revision) throw new Error('state_conflict');
    this.previews.delete(preview); this.revision++; this.modelCalls++;
    this.allowTools=decision.allowTools; this.convergenceRequested=decision.convergence; this.episodeUsed=decision.episodeUsed; this.recoveryAttempts=decision.recoveryAttempts; this.stopReason=decision.stopReason;
    return {allowTools:preview.allowTools,feedback:preview.feedback};
  }

  observeToolAttempt(id: string, name: string, raw: unknown): void {
    const prior = this.attempts.get(id);
    if (prior) {
      if (prior.name !== name) throw new Error('state_conflict');
      return;
    }
    this.toolCalls++;
    this.revision++;
    const allowed = this.allowTools && this.toolCalls <= this.runtimeSnapshot.runBudget.maxToolCalls;
    this.attempts.set(id, { name, raw: structuredClone(raw), allowed, observation: createToolControlObservation({
      admission: { status: allowed ? 'not_reached' : 'blocked', reason: allowed ? null : 'tool_call_limit' },
      environmentKey: this.options.measurementContext?.environmentKey ?? null,
      workloadBucket: groupWorkload(raw, this.options.scope, !name.includes('_')),
    }) });
    if (!allowed) this.toolAdmissionsRejected++;
  }
  admitToolCall(id: string, name: string, prepared: unknown): AppError | null {
    if (!this.attempts.has(id)) this.observeToolAttempt(id, name, prepared);
    const attempt = this.attempts.get(id)!;
    const value = canonicalRequest(prepared);
    if (attempt.name !== name || attempt.prepared !== undefined && attempt.prepared !== value) return safeError('state_conflict');
    attempt.prepared ??= value;
    if (!attempt.result) attempt.observation.workloadBucket = groupWorkload(prepared, this.options.scope, !name.includes('_'));
    let reason: string | null = null;
    if (!attempt.allowed) reason = 'tool_call_limit';
    else if (!this.options.scope.allowedToolNames.includes(name)) reason = 'access_denied';
    else if (this.options.scope.readOnly && ['edit', 'write', 'bash', 'powershell'].includes(name)) reason = 'access_denied';
    else if (this.options.signal.aborted) reason = 'tool_cancelled';
    else if (this.remaining() <= 0) reason = 'run_timeout';
    const committed = [...this.failures].find(([failedId, failure]) => failedId !== id && (failure.queryId !== null || failure.queryCommitUnknown)
      && this.attempts.get(failedId)?.name === name && this.attempts.get(failedId)?.prepared === value);
    if (!reason && committed && ['query_current_devices', 'query_device_changes'].includes(name)) {
      reason = 'operation_result_unknown';
      attempt.repairOf = committed[0];
      attempt.observation.repairOfToolCallId = committed[1].recordId;
      attempt.observation.recoveryAction = 'read_original_required';
    }
    if (!attempt.result) attempt.observation.admission = { status: reason ? 'blocked' : 'passed', reason };
    return reason ? safeError(reason) : null;
  }
  observation(id: string): ToolControlObservation { return structuredClone(this.attempts.get(id)?.observation ?? createToolControlObservation()); }
  updateObservation(id: string, patch: Partial<ToolControlObservation>): void {
    this.revision++;
    const attempt = this.attempts.get(id);
    if (attempt) attempt.observation = { ...attempt.observation, ...patch };
  }
  releaseToolExecution(id: string): void {
    const attempt = this.attempts.get(id);
    if (!attempt?.lease) return;
    clearTimeout(attempt.lease.timer);
    attempt.lease.finished = true;
    attempt.lease = undefined;
  }
  dispose(): void { for (const id of this.attempts.keys()) this.releaseToolExecution(id); }
  beginToolExecution(id: string, name: string, version: string, prepared: unknown, sdkSignal?: AbortSignal) {
    const error = this.admitToolCall(id, name, prepared);
    if (error) throw new Error(error.code);
    const attempt = this.attempts.get(id)!;
    if (attempt.lease) throw new Error('operation_result_unknown');
    const native = !name.includes('_');
    const bucket = groupWorkload(prepared, this.options.scope, native);
    const profile = this.options.toolProfileSnapshot?.profiles.find(profile => profile.name === name && profile.version === version
      && profile.workloadBucket === bucket && profile.environmentKey === this.options.measurementContext?.environmentKey
      && profile.sdkVersion === this.options.measurementContext?.sdkVersion && profile.measurementVersion === this.options.measurementContext?.version);
    const scheduling = RUN_CONTROL_RULES, statistics = TOOL_PROFILE_RULES;
    const floor = ['query_current_devices', 'query_device_changes', 'edit', 'write', 'bash', 'powershell'].includes(name)
      ? scheduling.workTimeoutFloorMs : scheduling.readTimeoutFloorMs;
    const reserve = Math.min(scheduling.answerReserveMaxMs, this.runtimeSnapshot.runBudget.timeoutMs * scheduling.answerReserveRatio);
    const available = Math.max(0, this.remaining() - reserve);
    const fields = prepared !== null && typeof prepared === 'object' ? prepared as Record<string, unknown> : {};
    const nativeTimeout = ['bash', 'powershell'].includes(name) && typeof fields.timeout === 'number' && fields.timeout > 0
      ? fields.timeout * 1000 : Infinity;
    if (available < Math.min(floor, this.runtimeSnapshot.runBudget.singleToolTimeoutMs, nativeTimeout)) throw new Error('run_timeout');
    const quantile = profile?.percentile === statistics.percentile ? profile.latencyQuantileMs
      : profile?.percentile === undefined && statistics.percentile === 0.95 ? profile?.p95Ms : null;
    const estimate = profile && profile.completeSamples >= statistics.minimumCompleteSamples && quantile !== null && quantile !== undefined
      && (profile.timeoutRate ?? 0) < statistics.timeoutRateFallback
      ? Math.max(floor, scheduling.timeoutMultiplier * quantile) : this.runtimeSnapshot.runBudget.singleToolTimeoutMs;
    const timeout = Math.min(estimate, this.runtimeSnapshot.runBudget.singleToolTimeoutMs, available, nativeTimeout);
    const controller = new AbortController(), started = performance.now(), deadline = started + timeout;
    const signal = AbortSignal.any([this.options.signal, controller.signal, ...(sdkSignal ? [sdkSignal] : [])]);
    const lease = { controller, signal, timer: undefined as unknown as ReturnType<typeof setTimeout>, started, deadline, requested: null as number | null, finished: false };
    const requestTimeout = () => {
      if (lease.finished) return;
      if (performance.now() < deadline) { lease.timer = setTimeout(requestTimeout, Math.min(2147483647, deadline - performance.now())); return; }
      lease.requested ??= performance.now();
      attempt.observation.timeoutRequestedAt ??= new Date().toISOString();
      controller.abort(new Error('tool_timeout'));
    };
    lease.timer = setTimeout(requestTimeout, Math.min(2147483647, timeout));
    signal.addEventListener('abort', () => { lease.requested ??= performance.now(); }, { once: true });
    attempt.lease = lease;
    attempt.observation.effectiveTimeoutMs = timeout;
    attempt.observation.workloadBucket = bucket;
    const eligible = [...this.failures].filter(([failedId, failure]) => failedId !== id && failure.delivered && this.canRepair(this.attempts.get(failedId)!, failure, name, prepared, attempt.raw));
    if (eligible.length === 1) {
      attempt.repairOf = eligible[0]![0];
      attempt.observation.repairOfToolCallId = eligible[0]![1].recordId;
    }
    // An explicit saved Query identity can resolve several related delivery failures.
    if (eligible.length === 1 || eligible.length > 1 && ['read_query', 'read_query_page'].includes(name)
      && eligible.every(([, failure]) => failure.queryId !== null && failure.queryId === eligible[0]![1].queryId)) {
      attempt.repairs = eligible.map(([failedId]) => failedId);
      attempt.observation.recoveryAction = name === 'read_query' || name === 'read_query_page' ? 'read_original' : 'correct_or_retry';
    }
    attempt.observation.repairEpisodeId = this.episodeId;
    return { signal, checkActive: () => {
      this.checkActive();
      if (performance.now() >= deadline) requestTimeout();
      if (signal.aborted) throw new Error(controller.signal.aborted ? 'tool_timeout' : 'tool_cancelled');
    } };
  }
  finishToolExecution(id: string, result: { status: string; data?: unknown; error?: { code: string } }, patch: Partial<ToolControlObservation> = {}) {
    const attempt = this.attempts.get(id);
    if (!attempt) return createToolControlObservation(patch);
    if (attempt.result) return this.observation(id);
    attempt.result = result;
    Object.assign(attempt.observation, patch);
    if (attempt.lease) {
      const lease = attempt.lease;
      clearTimeout(lease.timer);
      lease.finished = true;
      const stopped = performance.now();
      attempt.observation.observedElapsedMs = Math.max(0, stopped - lease.started);
      attempt.observation.executionElapsedMs = lease.requested === null ? attempt.observation.observedElapsedMs : null;
      attempt.observation.latencyObservation = lease.requested === null ? 'complete' : 'right_censored';
      attempt.observation.stopLagMs = lease.requested === null ? null : Math.max(0, stopped - lease.requested);
    }
    if (result.status !== 'succeeded') this.noteFailure(id, { code: result.error?.code ?? 'internal_error', stage: attempt.observation.failureStage ?? 'execution' });
    return this.observation(id);
  }
  noteFailure(id: string, failure: { code: string; stage: string; recordId?: number | null; queryId?: number | null; evidenceId?: number | null; queryCommitUnknown?: boolean }): void {
    this.revision++;
    const attempt = this.attempts.get(id);
    if (!attempt) return;
    if (attempt.observation.failureClass === null) {
      attempt.observation.failureStage = failure.stage;
      attempt.observation.failureOrigin = failure.stage === 'sdk' ? 'sdk' : 'tool_runtime';
      attempt.observation.failureClass = failure.code;
      attempt.observation.failureVisibility = ['tool_output_inconsistent', 'tool_output_invalid'].includes(failure.code) ? 'implicit' : 'explicit';
    }
    if (failure.queryCommitUnknown) attempt.observation.recoveryAction = 'read_original_required';
    if (!failure.queryCommitUnknown && (['tool_cancelled', 'access_denied', 'run_timeout', 'storage_write_failed'].includes(failure.code)
      || failure.code === 'operation_result_unknown' && attempt.observation.recoveryAction === 'read_original_required')) return;
    this.episodeId ??= `${this.options.runId}:repair:${++this.episodeSequence}`;
    attempt.observation.repairEpisodeId = this.episodeId;
    const prior = this.failures.get(id);
    this.failures.set(id, { code: prior?.code ?? failure.code, stage: prior?.stage ?? failure.stage, recordId: failure.recordId ?? prior?.recordId ?? null,
      queryId: failure.queryId ?? prior?.queryId ?? null, evidenceId: failure.evidenceId ?? prior?.evidenceId ?? null,
      queryCommitUnknown: failure.queryCommitUnknown ?? prior?.queryCommitUnknown, delivered: prior?.delivered ?? false });
  }
  private canRepair(failed: Attempt, failure: Failure, name: string, prepared: unknown, raw: unknown): boolean {
    if (!failed) return false;
    if (failure.queryCommitUnknown) return false;
    if (failure.queryId !== null) return prepared !== null && typeof prepared === 'object'
      && ['read_query', 'read_query_page'].includes(name) && 'queryId' in prepared && prepared.queryId === failure.queryId;
    if (failed.name !== name) return false;
    if (failed.prepared !== undefined && failed.prepared === canonicalRequest(prepared)) return true;
    if (failure.code !== 'tool_input_invalid') return false;
    const paths = failed.observation.validationIssues.map(issue => issue.fieldPath);
    if (!paths.length || paths.some(path => path.length === 0)) return false;
    const strip = (input: unknown) => {
      const copy = structuredClone(input);
      for (const path of paths) {
        let value = copy;
        for (const part of path.slice(0, -1)) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
        if (value && typeof value === 'object') delete (value as Record<string, unknown>)[path.at(-1)!];
      }
      return canonicalRequest(copy);
    };
    return strip(failed.raw) === strip(raw);
  }
  acknowledgeDelivery(id: string, isError = false): void {
    this.revision++;
    const failure = this.failures.get(id);
    if (failure) failure.delivered = true;
    const attempt = this.attempts.get(id);
    if (!isError && attempt?.result?.status === 'succeeded' && attempt.observation.postflightStatus !== 'failed' && attempt.repairs?.length) {
      for (const failedId of attempt.repairs) this.failures.delete(failedId);
      attempt.observation.recoveryAction = 'recovered';
      if (this.failures.size === 0) { this.episodeId = null; this.episodeUsed = 0; }
    }
  }
  readBudget(): RuntimeBudgetView {
    return { runId: this.options.runId, toolCalls: { limit: this.runtimeSnapshot.runBudget.maxToolCalls, used: this.toolCalls, remaining: Math.max(0, this.runtimeSnapshot.runBudget.maxToolCalls - this.toolCalls) },
      modelCalls: { limit: this.runtimeSnapshot.runBudget.maxModelCalls, used: this.modelCalls, remaining: Math.max(0, this.runtimeSnapshot.runBudget.maxModelCalls - this.modelCalls) },
      remainingTimeMs: this.remaining(), recovery: { episodeId: this.episodeId, used: this.episodeUsed,
        remaining: Math.max(0, this.runtimeSnapshot.runBudget.maxRecoveryAttempts - this.episodeUsed), unresolvedItems: [...this.failures.keys()] } };
  }
  feedback(budget = this.readBudget(), converge = this.convergenceRequested, allowTools = this.allowTools): string {
    return JSON.stringify({ budget, converge, allowTools,
      failures: [...this.failures].map(([id, failure]) => ({ id, tool: this.attempts.get(id)?.name, code: failure.code, stage: failure.stage,
        queryId: failure.queryId, evidenceId: failure.evidenceId, delivered: failure.delivered,
        hookFailure: this.attempts.get(id)?.observation.hookFailure })),
      instructions: 'Prioritize required facts and validation. Correct only invalid fields. Read saved results by original identity; preserve date, object and scope. Never treat suspicious data as verified. If tools are disabled, answer with saved evidence and unresolved requirements. Verify requested and actual dates, object, scope, quantity basis, units, status, staleness, Query/Evidence and unknowns before answering.' });
  }
  summary(): BudgetSummary {
    return { version: 'medclaw.budget-summary/v1', toolCalls: this.toolCalls, modelCalls: this.modelCalls,
      toolAdmissionsRejected: this.toolAdmissionsRejected, modelAdmissionsRejected: this.modelAdmissionsRejected,
      convergenceRequested: this.convergenceRequested, recoveryAttempts: this.recoveryAttempts, stopReason: this.stopReason, unresolvedItems: [...this.failures.keys()] };
  }
}
