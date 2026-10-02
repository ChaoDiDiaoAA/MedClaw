import { performance } from 'node:perf_hooks';
import { safeError, type AppError } from '../../../contracts/src/error';
import { createToolControlObservation, type AgentPolicy, type BudgetSummary, type MeasurementContext, type ToolControlObservation, type ToolProfileSnapshot } from '../../../contracts/src/model';
import { canonicalRequest, type RunScope, type RuntimeBudgetView } from '../../../contracts/src/run';
import { groupWorkload } from '../tools/tool-profile';

type Failure = { code: string; stage: string; recordId: number | null; queryId: number | null; evidenceId: number | null; delivered: boolean };
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
  policy: AgentPolicy;
  scope: RunScope;
  signal: AbortSignal;
  deadlineAt: number;
  totalTimeoutMs: number;
  measurementContext?: MeasurementContext | null;
  toolProfileSnapshot?: ToolProfileSnapshot | null;
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
  private readonly options: Options;
  constructor(options: Options) { this.options = { ...options, policy: structuredClone(options.policy), scope: structuredClone(options.scope) }; }

  private remaining() { return Math.max(0, this.options.deadlineAt - performance.now()); }
  checkActive = () => {
    if (this.options.signal.aborted) throw new Error('tool_cancelled');
    if (this.remaining() <= 0) throw new Error('run_timeout');
  };
  admitModelCall(): { allowTools: boolean; feedback: string } {
    this.checkActive();
    if (this.modelCalls >= this.options.policy.maxModelCalls) {
      this.modelAdmissionsRejected++;
      this.stopReason = 'agent_call_limit';
      throw new Error('agent_call_limit');
    }
    this.modelCalls++;
    const reserve = Math.min(10000, this.options.totalTimeoutMs * 0.1);
    this.allowTools = this.modelCalls < this.options.policy.maxModelCalls && this.toolCalls < this.options.policy.maxToolCalls
      && this.remaining() > reserve && (!this.episodeId || this.episodeUsed < this.options.policy.maxRecoveryAttempts);
    if (this.episodeId && this.allowTools) { this.episodeUsed++; this.recoveryAttempts++; }
    if (!this.allowTools && this.episodeId && this.episodeUsed >= this.options.policy.maxRecoveryAttempts) this.stopReason = 'tool_recovery_limit';
    this.convergenceRequested ||= this.toolCalls >= this.options.policy.maxToolCalls * 0.75
      || this.modelCalls >= this.options.policy.maxModelCalls * 0.75 || this.remaining() < this.options.totalTimeoutMs * 0.25;
    return { allowTools: this.allowTools, feedback: this.feedback() };
  }

  observeToolAttempt(id: string, name: string, raw: unknown): void {
    const prior = this.attempts.get(id);
    if (prior) {
      if (prior.name !== name) throw new Error('state_conflict');
      return;
    }
    this.toolCalls++;
    const allowed = this.allowTools && this.toolCalls <= this.options.policy.maxToolCalls;
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
    const committed = [...this.failures].find(([failedId, failure]) => failedId !== id && failure.queryId !== null
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
    const floor = ['query_current_devices', 'query_device_changes', 'edit', 'write', 'bash', 'powershell'].includes(name) ? 5000 : 1000;
    const reserve = Math.min(10000, this.options.totalTimeoutMs * 0.1);
    const available = Math.max(0, this.remaining() - reserve);
    if (available < Math.min(floor, this.options.policy.singleToolTimeoutMs)) throw new Error('run_timeout');
    const estimate = profile && profile.completeSamples >= 20 && profile.p95Ms !== null && (profile.timeoutRate ?? 0) < 0.2
      ? Math.max(floor, 2 * profile.p95Ms) : this.options.policy.singleToolTimeoutMs;
    const timeout = Math.min(estimate, this.options.policy.singleToolTimeoutMs, available);
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
  noteFailure(id: string, failure: { code: string; stage: string; recordId?: number | null; queryId?: number | null; evidenceId?: number | null }): void {
    const attempt = this.attempts.get(id);
    if (!attempt) return;
    if (attempt.observation.failureClass === null) {
      attempt.observation.failureStage = failure.stage;
      attempt.observation.failureOrigin = failure.stage === 'sdk' ? 'sdk' : 'tool_runtime';
      attempt.observation.failureClass = failure.code;
      attempt.observation.failureVisibility = ['tool_output_inconsistent', 'tool_output_invalid'].includes(failure.code) ? 'implicit' : 'explicit';
    }
    if (['tool_cancelled', 'access_denied', 'run_timeout', 'storage_write_failed'].includes(failure.code)
      || failure.code === 'operation_result_unknown' && attempt.observation.recoveryAction === 'read_original_required') return;
    this.episodeId ??= `${this.options.runId}:repair:${++this.episodeSequence}`;
    attempt.observation.repairEpisodeId = this.episodeId;
    const prior = this.failures.get(id);
    this.failures.set(id, { code: prior?.code ?? failure.code, stage: prior?.stage ?? failure.stage, recordId: failure.recordId ?? prior?.recordId ?? null,
      queryId: failure.queryId ?? prior?.queryId ?? null, evidenceId: failure.evidenceId ?? prior?.evidenceId ?? null, delivered: prior?.delivered ?? false });
  }
  private canRepair(failed: Attempt, failure: Failure, name: string, prepared: unknown, raw: unknown): boolean {
    if (!failed) return false;
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
    return { runId: this.options.runId, toolCalls: { limit: this.options.policy.maxToolCalls, used: this.toolCalls, remaining: Math.max(0, this.options.policy.maxToolCalls - this.toolCalls) },
      modelCalls: { limit: this.options.policy.maxModelCalls, used: this.modelCalls, remaining: Math.max(0, this.options.policy.maxModelCalls - this.modelCalls) },
      remainingTimeMs: this.remaining(), recovery: { episodeId: this.episodeId, used: this.episodeUsed,
        remaining: Math.max(0, this.options.policy.maxRecoveryAttempts - this.episodeUsed), unresolvedItems: [...this.failures.keys()] } };
  }
  feedback(): string {
    return JSON.stringify({ budget: this.readBudget(), converge: this.convergenceRequested, allowTools: this.allowTools,
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
