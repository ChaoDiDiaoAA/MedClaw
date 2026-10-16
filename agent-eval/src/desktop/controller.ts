import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import {
  EvaluationOperationRefSchema, EvaluationControlViewSchema, evaluationMethodSchemas, EvaluationNoticeSchema,
  type DesktopEvaluationRequest, type EvaluationMethod, type EvaluationReturn, type EvaluationControlView, type EvaluationNotice,
  type EvaluationPayload, type EvaluationControlFrame,
} from '../../../packages/contracts/src/evaluation';
import { safeError, type Result } from '../../../packages/contracts/src/error';
import { EvaluationFrameDecoder, encodeEvaluationFrame } from '../../../packages/contracts/src/evaluation-transport';
import { EvaluationService, type PreparedPlatformTask } from './service';
import { PlatformReceiptSaveError } from '../langfuse/export';
import { diagnostic, projectProgress, projectTrial } from './presentation';
import { parseTrials, runExperiment } from '../execution/runner';
import { JudgeClient } from '../scoring/judges/client';

type BaseOperation = { view: EvaluationControlView; abort: AbortController; done: Promise<void> };
type RunOperation = BaseOperation & { kind: 'run'; request: DesktopEvaluationRequest; accepted: Promise<EvaluationReturn<'eval.start'>> };
type PlatformOperation = BaseOperation & { kind: 'platform'; request: { method: 'eval.resend' | 'eval.review.sync'; operationRef: string; executionId: string };
  accepted: Promise<EvaluationReturn<'eval.resend'>>; task?: PreparedPlatformTask; retrySave?: () => Promise<void> };
type Operation = RunOperation | PlatformOperation;
export class EvaluationWorker {
  private readonly operations = new Map<string, Operation>();
  private current: Operation | null = null;
  private sequence = 0;
  private closing = false;
  constructor(readonly service: EvaluationService, readonly controllerInstanceId: string, private readonly notify: (notice: EvaluationNotice) => void) { EvaluationOperationRefSchema.parse(controllerInstanceId); }
  private idle(): EvaluationControlView {
    return { controllerInstanceId: this.controllerInstanceId, operationRef: null, operationKind: null, executionId: null, state: 'idle', sequence: this.sequence,
      currentTrial: null, progress: null, stopConfirmed: true, saveConfirmed: true, controllerExited: false, blockReasons: [], result: null, error: null,
      progressCounts: { planned: 0, saved: 0, pass: 0, fail: 0, unjudgeable: 0, error: 0, notRun: 0 } };
  }
  private statusNotice(operation: Operation) {
    operation.view.sequence = ++this.sequence;
    const notice = EvaluationNoticeSchema.parse({ type: 'eval.status', controllerInstanceId: this.controllerInstanceId, executionId: operation.view.executionId, sequence: this.sequence, control: operation.view });
    try { this.notify(structuredClone(notice)); } catch { /* Status reads retain the original facts if notification delivery fails. */ }
  }
  private finish(operation: RunOperation, facts: Awaited<ReturnType<EvaluationService['executionFacts']>>, error: unknown = null) {
    operation.view.stopConfirmed = facts.stopConfirmed; operation.view.saveConfirmed = facts.saveConfirmed;
    operation.view.result = { kind: 'run', report: facts.summary };
    operation.view.state = facts.stopConfirmed === true && facts.saveConfirmed === true ? 'settled' : 'unknown';
    operation.view.error = error === null ? null : safeError(error instanceof Error ? error.message : 'internal_error');
    operation.view.blockReasons = operation.view.state === 'unknown' ? [diagnostic('stop_or_save_unconfirmed')] : [];
    if (facts.summary?.totals) operation.view.progressCounts = { ...facts.summary.totals, saved: facts.summary.recorded };
    this.statusNotice(operation);
  }
  private async execute(operation: RunOperation, payload: EvaluationPayload<'eval.start'>, receipt: EvaluationReturn<'eval.start'>,
    accept: (receipt: EvaluationReturn<'eval.start'>) => void, reject: (error: unknown) => void) {
    let enteredRunner = false, knownAbsent = false, admitted = false;
    try {
      const original = await this.service.findOriginal(operation.view.executionId!);
      if (original.exists) {
        if (!original.request) throw new Error('artifact_not_ready');
        if (!isDeepStrictEqual(original.request, operation.request)) {
          operation.request = original.request; operation.accepted = Promise.resolve(receipt);
          throw new Error('state_conflict');
        }
        this.finish(operation, await this.service.executionFacts(operation.view.executionId!));
        admitted = true; accept(receipt); return;
      }
      if (await this.service.readActiveExecution() === operation.view.executionId) throw new Error('artifact_not_ready');
      knownAbsent = true;
      admitted = true; accept(receipt);
      const prepared = await this.service.prepareRun(payload);
      const secrets = [prepared.modelCredential.key, ...(prepared.judgeConfig ? [prepared.judgeConfig.apiKey] : [])];
      operation.view.progressCounts.planned = prepared.plan.length;
      const judge = prepared.judgeConfig ? await JudgeClient.create(prepared.judgeConfig, { plannedTrials: prepared.judged.length, trialIds: prepared.judged.map(trial => trial.trialId) }) : undefined;
      if (!operation.abort.signal.aborted) operation.view.state = 'running';
      this.statusNotice(operation); enteredRunner = true;
      const saved = new Set<string>();
      await runExperiment({ datasetRoot: prepared.options.datasetId, runsRoot: join(this.service.paths.runsRoot, 'business'), executionId: operation.view.executionId!,
        selection: prepared.options.selection, trials: prepared.options.trials, config: prepared.config, modelCredential: prepared.modelCredential,
        judgeMode: 'required', judge, signal: operation.abort.signal, desktopRequest: operation.request, expectedSource: prepared.expectedSource,
        onProgress: trial => { operation.view.currentTrial = projectTrial({ ...trial, observationRef: null }, secrets); this.statusNotice(operation); },
        onEvent: event => {
          const progress = projectProgress(event, secrets);
          operation.view.progress = progress;
          if (operation.view.currentTrial?.trialId !== event.trialId) operation.view.currentTrial = null;
          if (event.kind === 'saved' && !saved.has(event.trialId)) {
            saved.add(event.trialId); operation.view.progressCounts.saved++;
            const key = { PASS: 'pass', FAIL: 'fail', UNJUDGEABLE: 'unjudgeable', ERROR: 'error', NOT_RUN: 'notRun' } as const;
            if (event.status) operation.view.progressCounts[key[event.status]]++;
          }
          operation.view.sequence = ++this.sequence;
          try { this.notify({ type: 'eval.progress', controllerInstanceId: this.controllerInstanceId, executionId: operation.view.executionId, sequence: this.sequence, progress }); } catch {}
          if (event.kind === 'saved') this.statusNotice(operation);
        } });
      this.finish(operation, await this.service.executionFacts(operation.view.executionId!));
    } catch (error) {
      const beforeExecution = knownAbsent && (!enteredRunner || error instanceof Error && error.message === 'evaluation_runtime_changed');
      this.finish(operation, beforeExecution ? { summary: null, stopConfirmed: true, saveConfirmed: true } : await this.service.executionFacts(operation.view.executionId!), error);
      if (!admitted) reject(error);
    }
  }
  private start(payload: EvaluationPayload<'eval.start'>, operationRef: string) {
    const input = evaluationMethodSchemas['eval.start'].input.parse(payload);
    const request: DesktopEvaluationRequest = { operationRef, datasetId: input.datasetId, selection: input.selection, trials: parseTrials(input.trials === undefined ? undefined : String(input.trials), input.selection) };
    const receipt = { operationRef, executionId: 'desktop-' + operationRef, accepted: true as const };
    const previous = this.operations.get(operationRef);
    if (previous) { if (previous.kind !== 'run' || !isDeepStrictEqual(previous.request, request)) throw new Error('state_conflict'); return previous.accepted; }
    if (this.closing || this.current && this.current.view.state !== 'settled') throw new Error('runtime_busy');
    let accept!: (receipt: EvaluationReturn<'eval.start'>) => void, reject!: (error: unknown) => void;
    const accepted = new Promise<EvaluationReturn<'eval.start'>>((resolve, fail) => { accept = resolve; reject = fail; });
    void accepted.catch(() => {});
    const operation: RunOperation = { kind: 'run', request, view: { ...this.idle(), operationKind: 'run', operationRef, executionId: receipt.executionId, state: 'starting', stopConfirmed: null, saveConfirmed: null }, abort: new AbortController(), accepted, done: Promise.resolve() };
    this.operations.set(operationRef, operation); this.current = operation; this.statusNotice(operation);
    operation.done = this.execute(operation, input, receipt, accept, reject);
    return accepted;
  }
  private platformError(error: unknown) {
    const code = error instanceof Error ? error.message : '';
    return safeError(/^(?:langfuse_http_|langfuse_(?:transport|response)|review_sync_)/.test(code) || (error instanceof Error && error.name === 'AbortError')
      ? 'evaluation_platform_failed' : code);
  }
  private async finishPlatform(operation: PlatformOperation, error: ReturnType<typeof safeError> | null, saveConfirmed: boolean) {
    operation.view.stopConfirmed = true; operation.view.saveConfirmed = saveConfirmed; operation.view.error = error;
    if (operation.task) try {
      operation.view.result = { kind: operation.view.operationKind === 'resend' ? 'resend' : 'review_sync', platform: await operation.task.readState() };
    } catch { operation.view.saveConfirmed = null; operation.view.error = safeError('artifact_not_ready'); }
    operation.view.state = operation.view.saveConfirmed === true ? 'settled' : 'unknown';
    operation.view.blockReasons = operation.view.state === 'unknown' ? [diagnostic('platform_save_unconfirmed')] : [];
    this.statusNotice(operation);
  }
  private async executePlatform(operation: PlatformOperation, receipt: EvaluationReturn<'eval.resend'>,
    accept: (receipt: EvaluationReturn<'eval.resend'>) => void, reject: (error: unknown) => void) {
    let admitted = false;
    try {
      operation.task = operation.request.method === 'eval.resend' ? await this.service.startResend(operation.request.executionId, operation.abort.signal)
        : await this.service.startReviewSync(operation.request.executionId, operation.abort.signal);
      if (!operation.abort.signal.aborted) operation.view.state = 'running';
      admitted = true; accept(receipt); this.statusNotice(operation);
      await operation.task.execute(); await this.finishPlatform(operation, null, true);
    } catch (error) {
      if (error instanceof PlatformReceiptSaveError) operation.retrySave = error.retrySave;
      await this.finishPlatform(operation, this.platformError(error), !operation.retrySave);
      if (!admitted) reject(error);
    }
  }
  private startPlatform(method: 'eval.resend' | 'eval.review.sync', executionId: string, operationRef: string) {
    const request = { method, executionId, operationRef }, previous = this.operations.get(operationRef);
    if (previous) { if (previous.kind !== 'platform' || !isDeepStrictEqual(previous.request, request)) throw new Error('state_conflict'); return previous.accepted; }
    if (this.closing || this.current && this.current.view.state !== 'settled') throw new Error('runtime_busy');
    const operationKind = method === 'eval.resend' ? 'resend' : 'review_sync';
    const receipt: EvaluationReturn<'eval.resend'> = { executionId, operationRef, operationKind, accepted: true };
    let accept!: (receipt: EvaluationReturn<'eval.resend'>) => void, reject!: (error: unknown) => void;
    const accepted = new Promise<EvaluationReturn<'eval.resend'>>((resolve, fail) => { accept = resolve; reject = fail; }); void accepted.catch(() => {});
    const operation: PlatformOperation = { kind: 'platform', request, accepted, abort: new AbortController(), done: Promise.resolve(),
      view: { ...this.idle(), operationKind, operationRef, executionId, state: 'starting', stopConfirmed: null, saveConfirmed: null } };
    this.operations.set(operationRef, operation); this.current = operation; this.statusNotice(operation);
    operation.done = this.executePlatform(operation, receipt, accept, reject); return accepted;
  }
  async request<M extends EvaluationMethod>(method: M, raw: unknown, operationRef: string): Promise<EvaluationReturn<M>> {
    EvaluationOperationRefSchema.parse(operationRef);
    let data: unknown;
    switch (method) {
      case 'eval.start': data = await this.start(evaluationMethodSchemas['eval.start'].input.parse(raw), operationRef); break;
      case 'eval.cancel': {
        const { executionId } = evaluationMethodSchemas['eval.cancel'].input.parse(raw), operation = this.current;
        const cancelRequested = !!operation && operation.view.operationKind === 'run' && operation.view.executionId === executionId && ['starting', 'running', 'cancelling'].includes(operation.view.state);
        if (cancelRequested) { operation!.abort.abort(); operation!.view.state = 'cancelling'; this.statusNotice(operation!); }
        data = { cancelRequested, control: operation?.view.executionId === executionId ? operation.view : await this.request('eval.status', { executionId }, operationRef) }; break;
      }
      case 'eval.status': {
        const input = evaluationMethodSchemas['eval.status'].input.parse(raw);
        if (input.platform) {
          const known = input.operationRef ? this.operations.get(input.operationRef) : undefined;
          if (known && (known.kind !== 'platform' || known.view.executionId !== input.executionId || known.view.operationKind !== input.platform)) throw new Error('state_conflict');
          const result = { kind: input.platform, platform: await this.service.readPlatformState(input.executionId!, input.platform, input.page, input.pageSize) };
          data = known ? { ...known.view, result } : { ...this.idle(), executionId: input.executionId!, operationRef: input.operationRef ?? null,
            state: 'unknown', stopConfirmed: null, saveConfirmed: null, result, blockReasons: input.operationRef ? [diagnostic('operation_result_unknown')] : [] }; break;
        }
        const byOperation = input.operationRef ? this.operations.get(input.operationRef) : undefined;
        let byExecution: Operation | undefined;
        if (input.executionId) {
          if (byOperation?.view.executionId === input.executionId) byExecution = byOperation;
          else if (!input.operationRef && this.current?.view.executionId === input.executionId) byExecution = this.current;
          else byExecution = [...this.operations.values()].find(item => item.view.executionId === input.executionId);
        }
        if (byOperation && input.executionId && byOperation.view.executionId !== input.executionId || byExecution && input.operationRef && byExecution.view.operationRef !== input.operationRef) throw new Error('state_conflict');
        const operation = byOperation ?? byExecution ?? (!input.operationRef && !input.executionId ? this.current : null);
        if (!operation && (input.executionId || input.operationRef)) {
          const executionId = input.executionId ?? 'desktop-' + input.operationRef;
          const original = await this.service.findOriginal(executionId);
          const facts = await this.service.executionFacts(executionId);
          if (original.request && input.operationRef && original.request.operationRef !== input.operationRef) throw new Error('state_conflict');
          if (original.request) {
            const settled = facts.stopConfirmed === true && facts.saveConfirmed === true;
            const view: EvaluationControlView = { ...this.idle(), operationKind: 'run', operationRef: original.request.operationRef, executionId,
              state: settled ? 'settled' : 'unknown', stopConfirmed: facts.stopConfirmed, saveConfirmed: facts.saveConfirmed,
              result: { kind: 'run', report: facts.summary }, blockReasons: settled ? [] : [diagnostic('stop_or_save_unconfirmed')] };
            if (facts.summary?.totals) view.progressCounts = { ...facts.summary.totals, saved: facts.summary.recorded };
            this.operations.set(original.request.operationRef, { kind: 'run', request: original.request, view, abort: new AbortController(),
              accepted: Promise.resolve({ operationRef: original.request.operationRef, executionId, accepted: true }), done: Promise.resolve() });
            data = view; break;
          }
          data = { ...this.idle(), operationKind: null, operationRef: input.operationRef ?? null,
            executionId: input.executionId ?? (original.exists ? executionId : null), state: 'unknown', stopConfirmed: facts.stopConfirmed, saveConfirmed: facts.saveConfirmed,
            result: { kind: 'run', report: facts.summary }, blockReasons: [diagnostic('operation_result_unknown')] }; break;
        }
        if (!operation && !input.operationRef && !input.executionId) {
          const executionId = await this.service.readActiveExecution();
          if (executionId) {
            const desktop = EvaluationOperationRefSchema.safeParse(executionId.startsWith('desktop-') ? executionId.slice(8) : null);
            const facts = await this.service.executionFacts(executionId);
            data = { ...this.idle(), operationKind: desktop.success ? 'run' : null, operationRef: desktop.success ? desktop.data : null, executionId,
              state: desktop.success ? 'unknown' : 'blocked', stopConfirmed: facts.stopConfirmed, saveConfirmed: facts.saveConfirmed,
              result: facts.summary ? { kind: 'run', report: facts.summary } : null,
              blockReasons: [diagnostic(desktop.success ? 'stop_or_save_unconfirmed' : 'external_execution_lock')] }; break;
          }
        }
        data = operation?.kind === 'platform' && operation.task ? { ...operation.view,
          result: { kind: operation.view.operationKind === 'resend' ? 'resend' : 'review_sync', platform: await operation.task.readState(input.page, input.pageSize) } } : operation?.view ?? this.idle(); break;
      }
      case 'eval.preflight': data = await this.service.preflight(evaluationMethodSchemas['eval.preflight'].input.parse(raw)); break;
      case 'eval.report.list': data = await this.service.listReports(evaluationMethodSchemas['eval.report.list'].input.parse(raw)); break;
      case 'eval.report.read': data = await this.service.readReportSection(evaluationMethodSchemas['eval.report.read'].input.parse(raw)); break;
      case 'eval.evidence.read': data = await this.service.readEvidence(evaluationMethodSchemas['eval.evidence.read'].input.parse(raw)); break;
      case 'eval.compare': { const input = evaluationMethodSchemas['eval.compare'].input.parse(raw); data = await this.service.compare(input.baselineExecutionId, input.candidateExecutionId); break; }
      case 'eval.review.record': data = await this.service.recordLocalFeedback(evaluationMethodSchemas['eval.review.record'].input.parse(raw), operationRef); break;
      case 'eval.resend': case 'eval.review.sync': data = await this.startPlatform(method, evaluationMethodSchemas['eval.resend'].input.parse(raw).executionId, operationRef); break;
      default: throw new Error('invalid_argument');
    }
    return evaluationMethodSchemas[method].output.parse(structuredClone(data)) as EvaluationReturn<M>;
  }
  async shutdown() {
    this.closing = true;
    const operation = this.current;
    if (operation && ['starting', 'running', 'cancelling'].includes(operation.view.state)) { operation.abort.abort(); operation.view.state = 'cancelling'; this.statusNotice(operation); }
    if (operation) await operation.done;
    if (operation?.kind === 'platform' && (operation.retrySave || operation.view.saveConfirmed !== true)) {
      try { await operation.retrySave?.(); operation.retrySave = undefined; await this.finishPlatform(operation, operation.view.error, true); }
      catch (error) { await this.finishPlatform(operation, this.platformError(error), false); }
    }
    const view = operation?.view ?? await this.request('eval.status', {}, this.controllerInstanceId);
    return { stopConfirmed: view.stopConfirmed, saveConfirmed: view.saveConfirmed, controllerExited: false, executionId: view.executionId, gaps: view.blockReasons };
  }
}

export async function runEvaluationControlProcess() {
  const decoder = new EvaluationFrameDecoder();
  let worker: EvaluationWorker | null = null, blocked = false;
  let pendingStatus: EvaluationNotice | null = null, pendingProgress: EvaluationNotice | null = null;
  const write = async (frame: EvaluationControlFrame) => {
    const line = encodeEvaluationFrame(frame);
    await new Promise<void>((resolve, reject) => process.stdout.write(line, error => error ? reject(error) : resolve()));
  };
  const notify = (notice: EvaluationNotice) => {
    if (blocked) { if (notice.type === 'eval.status') pendingStatus = notice; else pendingProgress = notice; return; }
    try { blocked = !process.stdout.write(encodeEvaluationFrame({ protocolVersion: 'medclaw.evaluation-control/v1', kind: 'notice', controllerInstanceId: worker!.controllerInstanceId, notice })); } catch {}
  };
  process.stdout.on('drain', () => {
    blocked = false;
    const notices = [pendingStatus, pendingProgress].filter((notice): notice is EvaluationNotice => notice !== null).sort((a, b) => a.sequence - b.sequence);
    pendingStatus = null; pendingProgress = null; notices.forEach(notify);
  });
  try {
    for await (const chunk of process.stdin) for (const frame of decoder.push(chunk)) {
      if (!worker) {
        if (frame.kind !== 'hello') throw new Error('invalid_frame');
        const service = new EvaluationService(frame.paths); await service.initializeRuntime();
        worker = new EvaluationWorker(service, frame.controllerInstanceId, notify);
        await write({ protocolVersion: frame.protocolVersion, controllerInstanceId: frame.controllerInstanceId, kind: 'ready' }); continue;
      }
      if (frame.controllerInstanceId !== worker.controllerInstanceId) throw new Error('host_protocol_mismatch');
      if (frame.kind === 'shutdown' && !('proof' in frame)) {
        const proof = await worker.shutdown(); await write({ ...frame, proof });
        if (proof.stopConfirmed === true && proof.saveConfirmed === true) return;
      } else if (frame.kind === 'request') {
        let result: Result<unknown>;
        try { result = { ok: true, data: await worker.request(frame.request.method, frame.request.payload, frame.request.operationRef) }; }
        catch (error) { result = { ok: false, error: safeError(error instanceof Error ? error.message : 'invalid_argument') }; }
        const reply = { protocolVersion: frame.protocolVersion, controllerInstanceId: frame.controllerInstanceId, kind: 'reply' as const,
          requestId: frame.requestId, operationRef: frame.request.operationRef, method: frame.request.method, result };
        try { await write(reply); }
        catch (error) { if (!(error instanceof Error) || error.message !== 'frame_too_large') throw error; await write({ ...reply, result: { ok: false, error: safeError('report_page_too_large') } }); }
      } else throw new Error('invalid_frame');
    }
    decoder.finish();
  } finally { if (worker) await worker.shutdown(); }
}
if (import.meta.main) runEvaluationControlProcess().catch(() => { process.stderr.write('Evaluation control stopped with unconfirmed protocol or lifecycle facts.\n'); process.exitCode = 1; });
