import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { safeError, serviceResult, type AppError } from "../../../contracts/src/error";
import type { Command, CommandContext, RuntimeNotice } from "../../../contracts/src/protocol";
import type { CredentialScope, DiagnoseRequest, ModelRuntimePort, ProviderAccepted, ProviderRequest, PublishedSettings, ResolvedProviderSelection } from "../../../contracts/src/model";
import { canonicalRequest, RuntimeControlViewSchema, safePreview, type AgentRuntimePort, type CancelRunResult, type FinalAgentFact,
  type FinalProviderFact, type ModelCallRecorderPort, type ModelCallStarter, type ProviderOutcome, type RuntimeRunStore, type RunCleanupRecord,
  type RunHandle, type RunView, type StartRunInput } from "../../../contracts/src/run";
import { SubmitInputSchema, type NativeSessionBindings, type SubmitInput, type SubmitResult } from "../../../contracts/src/session";
import type { QueryExecutionContext } from '../../../contracts/src/query';
import type { RunScope } from '../../../contracts/src/run';

type Execution = { handle: RunHandle; operationRef: string; abort: AbortController; nativeTerminal: boolean; cause: "user" | "deadline" | "shutdown" | null;
  cancelAt: string | null; stopped: boolean; executionStarted: boolean | null; fact: FinalProviderFact | FinalAgentFact | null;
  primaryError: AppError | null; failureAt: string | null; secondaryErrors: AppError[]; pendingSave: boolean; sequence: number; task: Promise<void>;
  scope?: RunScope; referenceDate?: string; timezone?: string; toolGap: boolean };
type Recovery = { run: RunView; cleanup: RunCleanupRecord; verified: boolean; at: string };
const now = () => new Date().toISOString();

/** The one owner of root admission and lifecycle, shared by Provider and Agent. */
export class RuntimeService<Resolved extends ResolvedProviderSelection> {
  private execution: Execution | null = null;
  private reservation: { operationRef: string; request: string; kind: "provider" | "agent" } | null = null;
  private readonly recoveries = new Map<number, Recovery>();
  private recoveryError: AppError | null = null;
  private closing = false;
  constructor(readonly instanceId: string, private readonly settings: () => PublishedSettings, private readonly modelRuntime: ModelRuntimePort<Resolved>,
    private readonly store: RuntimeRunStore, private readonly credentials: CredentialScope, private readonly startCall: ModelCallStarter,
    private readonly notice: (notice: RuntimeNotice) => void, private readonly report: (error: AppError) => void,
    private readonly agent: (AgentRuntimePort<Resolved> & NativeSessionBindings) | undefined, private readonly modelControlBusy: () => boolean) {}
  get activeHandle(): RunHandle | null { return this.execution?.handle ?? null; }
  get persistencePending() { return this.execution?.pendingSave ?? this.recoveries.size > 0; }
  get stopPending() { return !!this.execution?.cause && !this.execution.stopped; }
  failToolPersistence(runId: number, error: AppError): void {
    const execution = this.execution;
    if (!execution || execution.handle.runId !== runId || execution.stopped) return;
    execution.toolGap = true;
    this.checkpoint(execution, error); execution.abort.abort();
  }
  bindQueryContext(operationRef: string, expectedRevision: number): QueryExecutionContext {
    const execution = this.execution, workspace = this.store.readWorkspace();
    if (workspace.revision !== expectedRevision) throw new Error('state_conflict');
    if (!execution || execution.handle.kind !== 'agent' || execution.handle.sessionId !== workspace.sessionId || !execution.scope
      || !execution.referenceDate || !execution.timezone || execution.primaryError || execution.abort.signal.aborted || execution.stopped || execution.nativeTerminal) throw new Error('state_conflict');
    if (!isDeepStrictEqual(workspace.batchRefs.map(batch => batch.id), execution.scope.batchIds)
      || !isDeepStrictEqual(workspace.deviceIds.length ? workspace.deviceIds : null, execution.scope.deviceIds)) throw new Error('state_conflict');
    return { runId: execution.handle.runId, inputId: null, sessionId: execution.handle.sessionId!, source: 'user_form',
      callRef: `${execution.handle.runId}:${operationRef}`, scope: structuredClone(execution.scope), referenceDate: execution.referenceDate,
      timezone: execution.timezone, signal: execution.abort.signal, basedOnQueryId: workspace.queryId, workspaceRevision: expectedRevision };
  }
  get busy() { return this.closing || this.modelControlBusy() || this.reservation !== null || this.execution !== null
    || this.recoveryError !== null || this.recoveries.size > 0 || this.store.active() !== null || this.store.recoveryCandidates(this.instanceId).length > 0; }
  read(input: Parameters<RuntimeRunStore["read"]>[0]) { return serviceResult(() => this.store.read(input), "storage_read_failed"); }
  active() { return serviceResult(() => {
    this.store.active();
    return this.execution ? { ...this.execution.handle, persistencePending: this.execution.pendingSave, stopPending: this.stopPending } : null;
  }, "storage_read_failed"); }
  readControl() {
    return serviceResult(() => {
      if (this.recoveryError) throw this.recoveryError;
      const root = this.store.active(), gaps = this.store.recoveryCandidates(this.instanceId), reasons: AppError[] = [];
      if (this.closing || this.modelControlBusy() || this.reservation || this.execution || root) reasons.push(safeError("state_conflict", undefined, { reason: "runtime_busy" }));
      if (this.execution?.cause && !this.execution.stopped) reasons.push(safeError("stop_unconfirmed", undefined, { runId: this.execution.handle.runId }));
      if (this.execution?.pendingSave) reasons.push(safeError("storage_write_failed", undefined, { runId: this.execution.handle.runId }));
      const recoveryCode = (recovery?: Recovery) => !recovery?.verified ? 'stop_unconfirmed' : recovery.cleanup.requiredPersistenceComplete === false ? 'run_save_unavailable' : 'storage_write_failed';
      for (const gap of gaps) reasons.push(safeError(recoveryCode(this.recoveries.get(gap.id)), undefined, { runId: gap.id }));
      for (const recovery of this.recoveries.values()) if (!gaps.some(gap => gap.id === recovery.run.id)) reasons.push(safeError(recoveryCode(recovery), undefined, { runId: recovery.run.id }));
      if (reasons.length > 32) throw new Error("frame_too_large");
      return RuntimeControlViewSchema.parse({ instanceId: this.instanceId, activeRootRun: this.activeHandle, acceptingNewRuns: reasons.length === 0, blockReasons: reasons });
    }, "storage_read_failed");
  }
  private reserve(operationRef: string, original: unknown, kind: "provider" | "agent") {
    if (this.reservation?.operationRef === operationRef && this.reservation.request === canonicalRequest(original)) throw new Error("operation_result_unknown");
    if (this.busy) {
      if (kind === "agent") throw safeError("state_conflict", undefined, { reason: "runtime_busy" });
      throw new Error("runtime_busy");
    }
    this.reservation = { operationRef, request: canonicalRequest(original), kind };
  }
  private recheck(operationRef: string, configVersion: string) {
    if (this.reservation?.operationRef !== operationRef || this.execution || this.closing || this.modelControlBusy()
      || this.recoveries.size || this.store.active() || this.store.recoveryCandidates(this.instanceId).length) throw new Error("runtime_busy");
    if (this.settings().configVersion !== configVersion) throw new Error("config_conflict");
  }
  async submitAgent(input: SubmitInput, context: CommandContext) {
    return serviceResult(async () => {
      if (context.instanceId !== this.instanceId) throw new Error("host_protocol_mismatch");
      const request = SubmitInputSchema.parse(input), original = this.store.findOperation(context.operationRef), previous = this.store.findSubmission({ sessionId: request.sessionId, clientSequence: request.clientSequence });
      if (original || previous) {
        if (!original || original.method !== "session.submit" || !previous || original.result.runId !== previous.runId
          || canonicalRequest(original.originalRequest) !== canonicalRequest(request)) throw new Error("state_conflict");
        return previous;
      }
      this.reserve(context.operationRef, request, "agent");
      try {
        const session = this.store.readSession(request.sessionId);
        if (!session) throw new Error("session_not_found");
        if (!this.agent || !this.agent.read(request.sessionId).available) throw new Error("session_history_invalid");
        const config = this.settings(), resolved = await this.modelRuntime.resolve(request.model, config.configVersion,
          config.credentialRefs[request.model.provider] ?? null, config.requestPolicy, true);
        this.recheck(context.operationRef, config.configVersion);
        const workspace = this.store.readWorkspace(), scope = this.store.freezeAgentScope(workspace, this.agent.toolNames ?? []);
        const started = await this.start({ sessionId: request.sessionId, inputId: null, text: request.text, model: resolved.selection, policy: resolved.policy, goal: "answer",
          workspace, scope, referenceDate: request.referenceDate, timezone: request.timezone, timeoutMs: resolved.policy.timeoutMs,
          agentOptions: this.agent.describe(resolved), submission: { operationRef: context.operationRef, originalSubmitInput: request }, resolved });
        if (!started.ok) throw started.error;
        return { sessionId: request.sessionId, clientSequence: request.clientSequence, inputId: null, runId: started.data.runId } satisfies SubmitResult;
      } finally { if (this.reservation?.operationRef === context.operationRef) this.reservation = null; }
    }, "storage_write_failed", { operationRef: context.operationRef, sessionId: input.sessionId });
  }
  start(input: StartRunInput<Resolved>) {
    return serviceResult(() => {
      const op = input.submission.operationRef;
      if (!this.agent || this.reservation?.kind !== "agent" || this.reservation.operationRef !== op
        || this.reservation.request !== canonicalRequest(input.submission.originalSubmitInput)
        || !isDeepStrictEqual(input.model, input.resolved.selection) || !isDeepStrictEqual(input.policy, input.resolved.policy)) throw new Error("state_conflict");
      this.recheck(op, input.model.configVersion);
      if (!this.agent.read(input.sessionId).available) throw new Error("session_history_invalid");
      const { resolved, ...fields } = input;
      let accepted: SubmitResult;
      try { accepted = this.store.registerAgent({ ...fields, instanceId: this.instanceId, createdAt: now() }); }
      catch (error) {
        const saved = this.store.findOperation(op);
        if (saved?.method !== "session.submit" || canonicalRequest(saved.originalRequest) !== canonicalRequest(input.submission.originalSubmitInput)) throw error;
        accepted = saved.result;
      }
      const execution = this.begin({ runId: accepted.runId, kind: "agent", sessionId: input.sessionId }, op);
      execution.scope = structuredClone(input.scope); execution.referenceDate = input.referenceDate; execution.timezone = input.timezone;
      this.reservation = null;
      execution.task = this.runAgent(execution, input);
      return execution.handle;
    }, "storage_write_failed", { operationRef: input.submission.operationRef, sessionId: input.sessionId });
  }
  async submitProvider(command: Command<ProviderRequest | DiagnoseRequest>, kind: "main" | "diagnostic" = "main"): Promise<ProviderAccepted> {
    const method = kind === "main" ? "model.request" : "model.diagnose", original = this.store.findOperation(command.operationRef);
    if (original) {
      if (original.method !== method || !("runId" in original) || canonicalRequest(original.originalRequest) !== canonicalRequest(command.payload)) throw new Error("state_conflict");
      return { runId: original.runId, operationRef: command.operationRef, reused: true };
    }
    this.reserve(command.operationRef, command.payload, "provider");
    try {
      const payload = command.payload, config = this.settings(), resolved = await this.modelRuntime.resolve(payload.model, config.configVersion,
        config.credentialRefs[payload.model.provider] ?? null, config.requestPolicy);
      this.recheck(command.operationRef, config.configVersion);
      const text = kind === "main" ? (payload as ProviderRequest).text : "请仅回复 OK。";
      const accepted = this.store.registerProvider({ operationRef: command.operationRef, method, originalRequest: payload, instanceId: this.instanceId,
        goal: kind === "main" ? "answer" : "verify", inputText: text, selection: resolved.selection, policy: resolved.policy,
        referenceDate: payload.referenceDate, timezone: payload.timezone, priorRunId: payload.priorRunId, createdAt: now() });
      const execution = this.begin({ runId: accepted.runId, kind: "provider", sessionId: null }, command.operationRef);
      this.reservation = null;
      execution.task = this.runProvider(execution, resolved, text, kind);
      return accepted;
    } finally { if (this.reservation?.operationRef === command.operationRef) this.reservation = null; }
  }
  private begin(handle: RunHandle, operationRef: string): Execution {
    const execution: Execution = { handle, operationRef, abort: new AbortController(), nativeTerminal: false, cause: null, cancelAt: null, stopped: false,
      executionStarted: null, fact: null, primaryError: null, failureAt: null, secondaryErrors: [], pendingSave: false, sequence: 0, task: Promise.resolve(), toolGap: false };
    this.execution = execution; return execution;
  }
  private cleanup(execution: Execution, complete: boolean): RunCleanupRecord {
    return { contract: "medclaw.run-cleanup/v1", executionStarted: execution.executionStarted, stopConfirmed: execution.stopped,
      requiredPersistenceComplete: complete, inputsSettled: true, resourcesReleased: execution.stopped,
      unconfirmedItems: [...(execution.stopped ? [] : ['stop', 'resources']), ...(complete ? [] : ['persistence']), ...(execution.toolGap && !complete ? ['tool_persistence'] : [])], secondaryErrors: execution.secondaryErrors, verifiedAt: complete && execution.stopped ? now() : null };
  }
  private deadline(execution: Execution, timeout: number) {
    return setTimeout(() => {
      if (execution.nativeTerminal || execution.cause) return;
      execution.cause = "deadline"; execution.abort.abort();
      this.checkpoint(execution, safeError("run_timeout"));
    }, timeout);
  }
  private checkpoint(execution: Execution, error: AppError) {
    execution.primaryError ??= error; execution.failureAt ??= now();
    try { this.store.checkpointFailure(execution.handle.runId, execution.primaryError, this.cleanup(execution, false), execution.failureAt); }
    catch { this.persistenceFailure(execution); }
  }
  private persistenceFailure(execution: Execution) {
    execution.pendingSave = true;
    const error = safeError("storage_write_failed", undefined, { runId: execution.handle.runId });
    if (!execution.secondaryErrors.some(item => isDeepStrictEqual(item, error))) execution.secondaryErrors.push(error);
  }
  private terminalError(execution: Execution, outcome: ProviderOutcome | null) {
    return execution.primaryError ?? (execution.cause === "user" ? null : execution.cause === "deadline" ? safeError("run_timeout")
      : execution.cause === "shutdown" ? safeError("host_interrupted") : outcome?.error ?? null);
  }
  private status(execution: Execution, outcome: ProviderOutcome | null) {
    return execution.primaryError ? "failed" : execution.cause === "user" ? "cancelled" : execution.cause || outcome?.error || outcome?.callState !== "completed" ? "failed" : "completed";
  }
  private preview(execution: Execution, text: string) {
    if (this.execution !== execution || execution.stopped || execution.nativeTerminal || execution.primaryError) return;
    const snapshot = safePreview(text);
    this.emit(execution.handle.kind === "agent" ? { type: "agent.preview", sessionId: execution.handle.sessionId!, runId: execution.handle.runId,
      noticeSequence: ++execution.sequence, ...snapshot } : { type: "provider.preview", runId: execution.handle.runId, ...snapshot });
  }
  private async runAgent(execution: Execution, input: StartRunInput<Resolved>) {
    const timer = this.deadline(execution, input.timeoutMs), deadlineAt = performance.now() + input.timeoutMs; let entered = false;
    try {
      const observed = await this.credentials({ purpose: "runtime", operationRef: execution.operationRef, credentialRef: input.model.credentialRef }, () => { entered = true; return this.agent!.execute({
        runId: execution.handle.runId, sessionId: input.sessionId, text: input.text, resolved: input.resolved, agentOptions: input.agentOptions,
        scope: input.scope, referenceDate: input.referenceDate, timezone: input.timezone, signal: execution.abort.signal, deadlineAt }, {
        startCall: time => this.startCall(execution.handle.runId, "main", time), preview: text => this.preview(execution, text),
        fatal: error => { this.checkpoint(execution, error); execution.abort.abort(); },
        nativeTerminal: outcome => { execution.nativeTerminal = true; if (outcome.error && !execution.cause) this.checkpoint(execution, outcome.error); },
      }); });
      execution.stopped = observed.nativeIdle;
      execution.executionStarted = observed.calls.length === 0 ? false : observed.calls.some(call => call.sdkStopReason !== null) ? true : null;
      const outcome = observed.lastOutcome, endedAt = now();
      execution.fact = { status: this.status(execution, outcome), outputText: outcome?.text ?? null, stoppedAt: execution.executionStarted === false ? null : endedAt, endedAt: execution.failureAt ?? endedAt,
        cancelRequestedAt: execution.cancelAt, error: this.terminalError(execution, outcome), calls: observed.calls,
        usage: outcome?.usageDetails ?? (outcome ? { source: outcome.usage.source, unavailableReason: outcome.usage.unavailableReason } : null), cleanup: this.cleanup(execution, true) };
    } catch {
      if (entered) this.checkpoint(execution, safeError("stop_unconfirmed"));
      else {
        execution.stopped = true; execution.executionStarted = false;
        execution.fact = { status: execution.primaryError ? "failed" : execution.cause === "user" ? "cancelled" : "failed", outputText: null, stoppedAt: null,
          endedAt: execution.failureAt ?? now(), cancelRequestedAt: execution.cancelAt, calls: [], cleanup: this.cleanup(execution, true),
          error: execution.cause === "user" ? null : this.terminalError(execution, null) ?? safeError("credential_read_failed") };
      }
    } finally { clearTimeout(timer); }
    if (execution.fact) this.saveFinal(execution);
  }
  private async runProvider(execution: Execution, resolved: Resolved, text: string, kind: "main" | "diagnostic") {
    const timer = this.deadline(execution, resolved.policy.timeoutMs); let recorder: ModelCallRecorderPort | null = null;
    try {
      recorder = this.startCall(execution.handle.runId, kind, now());
      const outcome = await this.credentials({ purpose: "runtime", operationRef: execution.operationRef, credentialRef: resolved.selection.credentialRef },
        () => this.modelRuntime.execute(resolved, text, execution.abort.signal, value => this.preview(execution, value), () => { execution.nativeTerminal = true; }));
      execution.stopped = true; execution.executionStarted = outcome.sdkStopReason === "pending" ? null : true;
      const unsupported = outcome.sdkStopReason === "toolUse" || outcome.sdkStopReason === "deferred";
      const effective = unsupported ? { ...outcome, error: safeError("provider_response_unsupported") } : outcome, endedAt = now();
      execution.fact = { status: this.status(execution, effective), outputText: outcome.text, stoppedAt: endedAt, endedAt: execution.failureAt ?? endedAt, cancelRequestedAt: execution.cancelAt,
        error: this.terminalError(execution, effective), call: recorder.finish(outcome, endedAt),
        usage: outcome.usageDetails ?? { source: outcome.usage.source, unavailableReason: outcome.usage.unavailableReason }, cleanup: this.cleanup(execution, true) };
    } catch {
      execution.stopped = true; execution.executionStarted = recorder ? null : false;
      const endedAt = now(), error = this.terminalError(execution, null) ?? safeError(recorder ? "provider_request_failed" : "storage_write_failed");
      const failure: ProviderOutcome = { sdkStopReason: execution.abort.signal.aborted ? "aborted" : "error", text: "", responseModel: null,
        callState: execution.abort.signal.aborted ? "cancelled" : "failed", usage: { inputTokens: null, outputTokens: null, cost: null, costCurrency: null, source: null, unavailableReason: "request_failed_before_usage" }, error };
      execution.fact = { status: execution.primaryError ? "failed" : execution.cause === "user" ? "cancelled" : "failed", outputText: null, stoppedAt: recorder ? endedAt : null, endedAt: execution.failureAt ?? endedAt,
        cancelRequestedAt: execution.cancelAt, error, ...(recorder ? { call: recorder.finish(failure, endedAt) } : {}), cleanup: this.cleanup(execution, true) };
    } finally { clearTimeout(timer); }
    this.saveFinal(execution);
  }
  private emit(notice: RuntimeNotice) { try { this.notice(notice); } catch { this.report(safeError("preview_delivery_failed")); } }
  private saveFinal(execution: Execution) {
    const fact = execution.fact;
    if (!fact || !execution.stopped) throw new Error("state_conflict");
    let saved = false;
    if (execution.handle.kind === 'agent' && this.agent?.toolPersistencePending?.(execution.handle.runId)) {
      this.persistenceFailure(execution); fact.cleanup = this.cleanup(execution, false);
      this.emit({ type: 'agent.persistence_failed', sessionId: execution.handle.sessionId!, runId: execution.handle.runId,
        noticeSequence: ++execution.sequence, error: safeError('storage_write_failed') });
      return;
    }
    fact.cleanup = this.cleanup(execution, true);
    try {
      if ("calls" in fact) this.store.finalizeAgent(execution.handle.runId, fact); else this.store.finalizeProvider(execution.handle.runId, fact);
      saved = true;
    } catch {
      try { saved = this.store.isFinalSaved(execution.handle.runId, fact); } catch { /* Unknown remains blocked. */ }
    }
    if (saved) {
      this.agent?.releaseToolFacts?.(execution.handle.runId);
      execution.pendingSave = false; if (this.execution === execution) this.execution = null;
      this.emit(execution.handle.kind === "agent" ? { type: "agent.settled", sessionId: execution.handle.sessionId!, runId: execution.handle.runId,
        noticeSequence: ++execution.sequence, status: fact.status } : { type: "provider.settled", runId: execution.handle.runId });
    } else {
      this.persistenceFailure(execution); fact.cleanup = this.cleanup(execution, true);
      this.emit(execution.handle.kind === "agent" ? { type: "agent.persistence_failed", sessionId: execution.handle.sessionId!, runId: execution.handle.runId,
        noticeSequence: ++execution.sequence, error: safeError("storage_write_failed") } : { type: "provider.persistence_failed", runId: execution.handle.runId, error: safeError("storage_write_failed") });
    }
  }
  cancelNow(runId: number): CancelRunResult {
    const execution = this.execution;
    if (execution?.handle.runId === runId && !execution.stopped) {
      if (!execution.nativeTerminal && !execution.cause && !execution.primaryError) { execution.cause = "user"; execution.cancelAt = now(); }
      execution.abort.abort();
      if (execution.cancelAt) { try { this.store.requestCancel(runId, execution.cancelAt); } catch { this.persistenceFailure(execution); } }
    }
    const result = this.store.read({ runId });
    if (result.kind !== "one" || !result.run) throw new Error("run_not_found");
    return { runId, cancelRequested: !!(execution?.handle.runId === runId ? execution.cancelAt : result.run.cancelRequestedAt),
      stopped: execution?.handle.runId === runId ? execution.stopped : result.run.cleanup?.stopConfirmed === true || result.run.cleanup?.executionStarted === false || !!result.run.stoppedAt, committedStatus: result.run.status,
      persistencePending: execution?.handle.runId === runId ? execution.pendingSave : false };
  }
  cancel(runId: number) { return serviceResult(async () => {
    this.cancelNow(runId); const execution = this.execution;
    if (execution?.handle.runId === runId && !execution.stopped) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([execution.task, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
      finally { clearTimeout(timer); }
    }
    return this.cancelNow(runId);
  }, "storage_read_failed", { runId }); }
  retrySaveNow(runId: number) {
    const execution = this.execution, recovery = this.recoveries.get(runId);
    if (recovery) {
      if (!recovery.verified) throw new Error("stop_unconfirmed");
      if (recovery.cleanup.requiredPersistenceComplete !== true) throw new Error('run_save_unavailable');
      this.saveRecovery(recovery);
      if (this.recoveries.has(runId)) throw new Error("storage_write_failed");
    } else {
      if (!execution || execution.handle.runId !== runId || !execution.pendingSave || !execution.stopped || !execution.fact) throw new Error("run_save_unavailable");
      if (execution.handle.kind === 'agent') this.agent?.retryToolPersistence?.(runId);
      this.saveFinal(execution); if (execution.pendingSave) throw new Error("storage_write_failed");
    }
    const result = this.store.read({ runId }); if (result.kind !== "one" || !result.run) throw new Error("run_not_found"); return result.run;
  }
  retrySave(runId: number) { return serviceResult(() => this.retrySaveNow(runId), "storage_write_failed", { runId }); }
  recoverInterrupted(previousProcessExited: boolean) {
    try {
      const candidates = this.store.recoveryCandidates(this.instanceId), at = now();
      for (const run of candidates) {
        const facts = this.store.verifyPriorToolFacts?.(run.id, previousProcessExited, at) ?? {
          stopConfirmed: previousProcessExited ? true : null, requiredPersistenceComplete: true,
          unconfirmedItems: previousProcessExited ? [] : ['stop', 'resources'],
        };
        this.recoveries.set(run.id, { run, at, verified: facts.stopConfirmed === true,
          cleanup: { contract: "medclaw.run-cleanup/v1", executionStarted: run.cleanup?.executionStarted ?? null, stopConfirmed: facts.stopConfirmed,
            requiredPersistenceComplete: facts.requiredPersistenceComplete, inputsSettled: true, resourcesReleased: facts.stopConfirmed,
            unconfirmedItems: facts.unconfirmedItems, secondaryErrors: run.cleanup?.secondaryErrors ?? [], verifiedAt: facts.stopConfirmed === true ? at : run.cleanup?.verifiedAt ?? null } });
      }
      if (previousProcessExited) for (const recovery of [...this.recoveries.values()]) this.saveRecovery(recovery);
      this.recoveryError = null;
    } catch { this.recoveryError = safeError("storage_read_failed"); }
  }
  private saveRecovery(recovery: Recovery) {
    try {
      if (recovery.run.status === "created" || recovery.run.status === "running") this.store.checkpointFailure(recovery.run.id,
        safeError(recovery.run.kind === "provider" ? "host_interrupted" : "runtime_interrupted", undefined, { runId: recovery.run.id }), recovery.cleanup, recovery.at);
      else this.store.saveRunCleanup(recovery.run.id, recovery.cleanup);
      if (recovery.cleanup.stopConfirmed === true && recovery.cleanup.requiredPersistenceComplete === true) this.recoveries.delete(recovery.run.id);
    } catch { this.report(safeError("storage_write_failed", undefined, { runId: recovery.run.id })); }
  }
  async shutdown() {
    this.closing = true; const execution = this.execution;
    if (execution && !execution.nativeTerminal && !execution.cause) { execution.cause = "shutdown"; execution.abort.abort(); }
    if (execution) await execution.task;
    if (this.execution?.pendingSave || this.recoveries.size) throw new Error("storage_write_failed");
    if (this.execution && !this.execution.stopped) throw new Error("stop_unconfirmed");
    return { executionStopped: true };
  }
}
