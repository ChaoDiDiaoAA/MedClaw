import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { EvaluationFrameDecoder, encodeEvaluationFrame } from '@medclaw/contracts/evaluation-transport';
import { EvaluationControlViewSchema, EvaluationPathsSchema, EvaluationOperationRefSchema, evaluationMethodSchemas,
  type EvaluationControlView, type EvaluationPaths, type EvaluationMethod, type EvaluationPayload, type EvaluationReturn,
  type EvaluationControlFrame, type EvaluationNotice, type EvaluationShutdownProofSchema } from '@medclaw/contracts/evaluation';
import { AppErrorSchema, safeError, type AppError } from '@medclaw/contracts/error';
import { publicMethodSchemas, publicOutputSchema, type PublicMethod, type PublicReturn } from '@medclaw/contracts/protocol';
import type { HostController } from './host-controller';
import type { z } from 'zod';

type ShutdownProof = z.infer<typeof EvaluationShutdownProofSchema>;
type Pending = { method: EvaluationMethod | 'shutdown'; operationRef: string | null; payload: unknown; timer: ReturnType<typeof setTimeout>; resolve(value: unknown): void; reject(error: AppError): void };
type Admission = { kind: 'evaluation' | 'production' };
type EvaluationOperation = { method: EvaluationMethod; descriptor: unknown; promise: Promise<unknown> };
type ProductionOperation = { method: PublicMethod; payload: unknown; instanceId: string | null; pending: Promise<unknown> | null; result?: { data: unknown }; unconfirmed: boolean };
export interface EvaluationControllerOptions {
  paths: EvaluationPaths; workerEntry: string; bunExecutable?: string;
  production: Pick<HostController, 'read' | 'request'>;
  notify?(notice: EvaluationNotice): void; report?(error: AppError): void;
  maintenanceBusy?(): boolean;
}
const gap = (code: string) => ({ code, message: 'Evaluation lifecycle facts could not be confirmed.', trialId: null });
const executionMethods: PublicMethod[] = ['model.request', 'model.diagnose', 'session.submit', 'session.compact', 'extensions.command', 'session.restoreCheckpoint', 'session.restore', 'host.restart'];

export class EvaluationController {
  private readonly instanceId = randomUUID();
  private readonly pending = new Map<string, Pending>();
  private readonly operations = new Map<string, EvaluationOperation>();
  private readonly productionOperations = new Map<string, ProductionOperation>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private initializing: Promise<void> | null = null;
  private handshake: { resolve(): void; reject(error: AppError): void } | null = null;
  private exited: Promise<void> = Promise.resolve();
  private exitObserved = true;
  private unavailable = false;
  private closing = false;
  private sealed = false;
  private workerSequence = 0;
  private admission: Admission | null = null;
  private initializationPending = false;
  private shutdownTask: Promise<ShutdownProof> | null = null;
  private view: EvaluationControlView;
  constructor(private readonly options: EvaluationControllerOptions) {
    EvaluationPathsSchema.parse(options.paths);
    if (!isAbsolute(options.workerEntry)) throw safeError('invalid_argument');
    this.view = this.idle();
  }
  private idle(): EvaluationControlView {
    return { controllerInstanceId: this.instanceId, operationKind: null, operationRef: null, executionId: null, state: 'idle', sequence: 0,
      currentTrial: null, progress: null, progressCounts: { planned: 0, saved: 0, pass: 0, fail: 0, unjudgeable: 0, error: 0, notRun: 0 },
      stopConfirmed: true, saveConfirmed: true, controllerExited: this.exitObserved, blockReasons: [], result: null, error: null };
  }
  read(): EvaluationControlView { return structuredClone(this.view); }
  get admissionPending(): boolean {
    return this.admission !== null || this.initializationPending || this.evaluationBusy()
      || [...this.productionOperations.values()].some(operation => operation.pending !== null || operation.unconfirmed);
  }
  private diagnostic(error: AppError) { try { this.options.report?.(error); } catch {} }
  private notify(notice: EvaluationNotice) { try { this.options.notify?.(structuredClone(notice)); } catch { this.diagnostic(safeError('preview_delivery_failed')); } }
  private status() {
    this.view.sequence++;
    this.notify({ type: 'eval.status', controllerInstanceId: this.instanceId, executionId: this.view.executionId, sequence: this.view.sequence, control: this.read() });
  }
  private adopt(control: EvaluationControlView, emit = false) {
    if (control.sequence < this.workerSequence) return;
    this.workerSequence = Math.max(this.workerSequence, control.sequence);
    this.view = EvaluationControlViewSchema.parse({ ...control, sequence: this.view.sequence + 1, controllerExited: this.exitObserved });
    if (emit) this.notify({ type: 'eval.status', controllerInstanceId: this.instanceId, executionId: this.view.executionId, sequence: this.view.sequence, control: this.read() });
  }
  private fail(code: string) {
    this.unavailable = true;
    const error = safeError(code);
    this.view.error = error;
    this.view.state = this.view.operationRef || this.view.stopConfirmed !== true || this.view.saveConfirmed !== true ? 'unknown' : 'blocked';
    this.view.blockReasons = [gap('evaluation_controller_unavailable')];
    this.handshake?.reject(error); this.handshake = null;
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error); }
    this.diagnostic(error); this.status();
  }
  private receive(frame: EvaluationControlFrame) {
    if (frame.kind === 'ready') {
      if (!this.handshake) throw new Error('host_protocol_mismatch');
      this.handshake.resolve(); this.handshake = null; return;
    }
    if (frame.kind === 'notice') {
      const notice = frame.notice;
      if (notice.sequence <= this.workerSequence) return;
      this.workerSequence = notice.sequence;
      if (this.view.executionId && notice.executionId !== this.view.executionId) return;
      if (notice.type === 'eval.status' && this.view.operationRef && notice.control.operationRef !== this.view.operationRef) return;
      if (notice.type === 'eval.progress' && this.view.operationKind !== 'run') return;
      if (notice.type === 'eval.status') this.adopt(notice.control, true);
      else {
        this.view.progress = notice.progress; this.view.sequence++;
        this.notify({ ...notice, sequence: this.view.sequence });
      }
      return;
    }
    if (frame.kind !== 'reply' && !(frame.kind === 'shutdown' && 'proof' in frame)) throw new Error('host_protocol_mismatch');
    const pending = this.pending.get(frame.requestId);
    if (!pending) { this.diagnostic(safeError('invalid_frame')); return; }
    if (frame.kind === 'reply' && (pending.method !== frame.method || pending.operationRef !== frame.operationRef) || frame.kind === 'shutdown' && pending.method !== 'shutdown') throw new Error('host_protocol_mismatch');
    if (frame.kind === 'reply' && frame.result.ok) {
      const input = pending.payload as Record<string, unknown>, output = frame.result.data as Record<string, unknown>;
      for (const key of ['executionId', 'trialId', 'evidenceRef', 'baselineExecutionId', 'candidateExecutionId', 'datasetId', 'selection', 'trials']) {
        if (input[key] !== undefined && Object.hasOwn(output, key) && output[key] !== input[key]) throw new Error('host_protocol_mismatch');
      }
      if (['eval.start', 'eval.review.sync', 'eval.resend'].includes(frame.method) && output.operationRef !== pending.operationRef) throw new Error('host_protocol_mismatch');
      if (frame.method === 'eval.start' && output.executionId !== 'desktop-' + pending.operationRef) throw new Error('host_protocol_mismatch');
      if (frame.method === 'eval.resend' && output.operationKind !== 'resend' || frame.method === 'eval.review.sync' && output.operationKind !== 'review_sync') throw new Error('host_protocol_mismatch');
      const control = frame.method === 'eval.status' ? EvaluationControlViewSchema.parse(output) : frame.method === 'eval.cancel' ? evaluationMethodSchemas['eval.cancel'].output.parse(output).control : null;
      if (control && (control.controllerInstanceId !== this.instanceId || input.executionId !== undefined && control.executionId !== input.executionId || input.operationRef !== undefined && control.operationRef !== input.operationRef)) throw new Error('host_protocol_mismatch');
      if (control && input.platform !== undefined && control.result?.kind !== input.platform) throw new Error('host_protocol_mismatch');
    }
    this.pending.delete(frame.requestId); clearTimeout(pending.timer);
    if (frame.kind === 'reply') { if (frame.result.ok) pending.resolve(frame.result.data); else pending.reject(safeError(frame.result.error.code, undefined, { operationRef: frame.operationRef })); }
    else pending.resolve(frame.proof);
  }
  private write(frame: EvaluationControlFrame) {
    const line = encodeEvaluationFrame(frame), child = this.child;
    return new Promise<void>((resolve, reject) => {
      if (!child || child.stdin.destroyed) return reject(safeError('host_interrupted'));
      child.stdin.write(line, error => error ? reject(safeError('host_interrupted')) : resolve());
    });
  }
  private exchange(method: EvaluationMethod | 'shutdown', payload: unknown = {}, operationRef: string = randomUUID()): Promise<unknown> {
    if (!this.child) return Promise.reject(safeError('host_interrupted'));
    if (this.pending.size >= 256) return Promise.reject(safeError('runtime_busy'));
    const requestId = randomUUID();
    const frame: EvaluationControlFrame = method === 'shutdown'
      ? { protocolVersion: 'medclaw.evaluation-control/v1', controllerInstanceId: this.instanceId, kind: 'shutdown', requestId }
      : { protocolVersion: 'medclaw.evaluation-control/v1', controllerInstanceId: this.instanceId, kind: 'request', requestId, request: { method, payload, operationRef } };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(safeError(method === 'shutdown' || method === 'eval.start' || method === 'eval.review.sync' || method === 'eval.resend' || method === 'eval.review.record' ? 'operation_result_unknown' : 'host_not_ready', undefined, { operationRef })); }, 30000);
      timer.unref(); this.pending.set(requestId, { method, operationRef: method === 'shutdown' ? null : operationRef, payload, timer, resolve, reject });
      void this.write(frame).catch(() => {
        const pending = this.pending.get(requestId); if (!pending) return;
        clearTimeout(timer); this.pending.delete(requestId); pending.reject(safeError('operation_result_unknown', undefined, { operationRef }));
      });
    });
  }
  initialize(): Promise<void> {
    if (this.initializing) return this.initializing;
    this.initializationPending = true;
    this.initializing = this.launch().finally(() => { this.initializationPending = false; }); return this.initializing;
  }
  private async launch() {
    const decoder = new EvaluationFrameDecoder(this.instanceId);
    const ready = new Promise<void>((resolve, reject) => { this.handshake = { resolve, reject }; });
    void ready.catch(() => {});
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    const child = spawn(this.options.bunExecutable ?? 'bun', ['--no-env-file', this.options.workerEntry], { cwd: this.options.paths.sourceRoot, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child; this.exitObserved = false; this.view.controllerExited = false;
    this.exited = new Promise<void>(done => {
      const finish = () => {
      if (this.child === child) {
        this.child = null; this.exitObserved = true; this.view.controllerExited = true;
        this.view.blockReasons = this.view.blockReasons.filter(reason => reason.code !== 'evaluation_controller_exit_unconfirmed');
        const safe = this.view.stopConfirmed === true && this.view.saveConfirmed === true;
        if (this.sealed && safe) {
          this.unavailable = true;
          this.handshake?.reject(safeError('host_interrupted')); this.handshake = null;
          for (const [id, pending] of this.pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(safeError('host_interrupted')); }
        } else this.fail(this.view.error?.code ?? 'host_interrupted');
        if (safe) this.view.state = this.view.operationRef ? 'settled' : 'blocked';
        this.status();
      }
      done();
      };
      child.once('exit', () => { finish(); child.stdin.destroy(); });
      child.once('close', () => { if (child.pid === undefined) finish(); });
    });
    child.on('error', () => this.fail('host_start_failed'));
    child.stdin.on('error', () => this.fail('host_interrupted'));
    child.stdout.on('data', (chunk: Buffer) => { try { decoder.push(chunk).forEach(frame => this.receive(frame)); } catch (error) { this.fail(error instanceof Error && error.message === 'frame_too_large' ? 'frame_too_large' : 'host_protocol_mismatch'); } });
    child.stdout.on('end', () => { try { decoder.finish(); } catch { this.fail('host_protocol_mismatch'); } });
    child.stderr.resume();
    const timer = setTimeout(() => this.fail('host_start_failed'), 30000); timer.unref();
    try {
      await this.write({ protocolVersion: 'medclaw.evaluation-control/v1', controllerInstanceId: this.instanceId, kind: 'hello', paths: this.options.paths });
      await ready;
      const control = EvaluationControlViewSchema.parse(await this.exchange('eval.status'));
      this.adopt(control);
    } catch (error) {
      this.unavailable = true;
      if (existsSync(join(this.options.paths.runsRoot, 'business', '.active-execution.json'))) {
        this.view.state = 'unknown'; this.view.stopConfirmed = null; this.view.saveConfirmed = null; this.view.blockReasons = [gap('stop_or_save_unconfirmed')]; this.status();
      }
      throw AppErrorSchema.safeParse(error).success ? error : safeError('host_start_failed');
    } finally { clearTimeout(timer); }
  }
  private evaluationBusy() {
    if (this.view.blockReasons.some(reason => reason.code === 'external_execution_lock')) return false;
    return ['starting', 'running', 'cancelling', 'unknown'].includes(this.view.state) || this.view.stopConfirmed !== true || this.view.saveConfirmed !== true;
  }
  private async productRead(method: PublicMethod, payload: unknown, instanceId: string) {
    const result = await this.options.production.request(method, payload, undefined, undefined, instanceId);
    if (!result.ok) throw result.error;
    return publicOutputSchema(method, payload).parse(result.data);
  }
  private async originalProduction(method: PublicMethod, payload: unknown, operationRef: string): Promise<boolean> {
    const host = this.options.production.read(); if (host.state !== 'ready' || !host.instanceId) return false;
    if (['model.request', 'model.diagnose', 'session.submit'].includes(method)) {
      const result = await this.productRead('run.read', { operationRef }, host.instanceId) as PublicReturn<'run.read'>;
      if (result.kind !== 'one') throw safeError('host_protocol_mismatch');
      if (result.run) return true;
      if (method === 'session.submit') {
        const input = publicMethodSchemas['session.submit'].input.parse(payload);
        return await this.productRead('session.readSubmission', { sessionId: input.sessionId, clientSequence: input.clientSequence }, host.instanceId) !== null;
      }
    } else if (method === 'session.restoreCheckpoint') return await this.productRead('evidence.readOperation', { kind: 'session_checkpoint', operationRef }, host.instanceId) !== null;
    else if (method === 'session.compact') {
      const input = publicMethodSchemas['session.compact'].input.parse(payload);
      return await this.productRead('session.compaction.read', { sessionId: input.sessionId, operationRef }, host.instanceId) !== null;
    }
    return false;
  }
  async withProductionAdmission<T>(method: PublicMethod, payload: unknown, operationRef: string, work: (original: boolean) => Promise<T>): Promise<T> {
    if (method === 'host.start' && this.options.maintenanceBusy?.()) throw safeError('maintenance_busy');
    if (method === 'host.start' && this.closing) throw safeError('runtime_busy');
    if (!executionMethods.includes(method)) return work(false);
    const old = this.productionOperations.get(operationRef);
    if (old && (old.method !== method || !isDeepStrictEqual(old.payload, payload))) throw safeError('state_conflict');
    if (old?.pending) return old.pending as Promise<T>;
    if (old?.result) return old.result.data as T;
    const record: ProductionOperation = old ?? { method, payload: structuredClone(payload), instanceId: this.options.production.read().instanceId, pending: null, unconfirmed: false };
    this.productionOperations.set(operationRef, record);
    const admission: Admission = { kind: 'production' };
    if (!this.admission) this.admission = admission;
    const pending = (async () => {
      let entered = false;
      try {
        const original = await this.originalProduction(method, payload, operationRef);
        if (!original) {
          if (this.options.maintenanceBusy?.()) throw safeError('maintenance_busy');
          if (this.initializing) try { await this.initializing; } catch {}
          if (this.options.maintenanceBusy?.()) throw safeError('maintenance_busy');
          if (this.admission !== admission || this.closing || this.evaluationBusy()) throw safeError('runtime_busy');
        }
        entered = true;
        const result = await work(original); record.unconfirmed = false;
        if (['session.restore', 'host.restart'].includes(method)) record.result = { data: structuredClone(result) };
        else this.productionOperations.delete(operationRef);
        return result;
      } catch (error) {
        const parsed = AppErrorSchema.safeParse(error), code = parsed.success ? parsed.data.code : safeError(error instanceof Error ? error.message : 'internal_error').code;
        record.unconfirmed = entered && ['operation_result_unknown', 'host_interrupted', 'host_not_ready', 'host_protocol_mismatch', 'internal_error'].includes(code);
        if (!record.unconfirmed) this.productionOperations.delete(operationRef);
        throw error;
      } finally { if (this.admission === admission) this.admission = null; record.pending = null; }
    })();
    record.pending = pending; return pending;
  }
  private async productionIdle() {
    const host = this.options.production.read();
    if (host.state === 'stopped' && host.canStart) {
      if ([...this.productionOperations.values()].some(operation => operation.unconfirmed)) throw safeError('runtime_busy');
      return;
    }
    if (host.state !== 'ready' || !host.instanceId) throw safeError('runtime_busy');
    const control = await this.productRead('run.control.read', {}, host.instanceId) as PublicReturn<'run.control.read'>;
    if (this.options.production.read().instanceId !== host.instanceId || control.instanceId !== host.instanceId || control.activeRootRun || !control.acceptingNewRuns || control.blockReasons.length) throw safeError('runtime_busy');
    for (const operation of this.productionOperations.values()) if (operation.unconfirmed && operation.instanceId !== host.instanceId) operation.unconfirmed = false;
    if ([...this.productionOperations.values()].some(operation => operation.unconfirmed)) throw safeError('runtime_busy');
  }
  async dispatch<M extends EvaluationMethod>(method: M, payload: EvaluationPayload<M>, operationRef: string): Promise<EvaluationReturn<M>> {
    EvaluationOperationRefSchema.parse(operationRef);
    const input = evaluationMethodSchemas[method].input.parse(payload);
    if (method === 'eval.status' && (!this.child || this.unavailable) && this.initializing) {
      const request = input as EvaluationPayload<'eval.status'>;
      if (request.platform) throw safeError('host_interrupted');
      if (request.operationRef && request.operationRef === this.view.operationRef && request.executionId && request.executionId !== this.view.executionId
        || request.executionId && request.executionId === this.view.executionId && request.operationRef && request.operationRef !== this.view.operationRef) throw safeError('state_conflict');
      const matches = (!request.operationRef || request.operationRef === this.view.operationRef) && (!request.executionId || request.executionId === this.view.executionId);
      const control = matches ? this.read() : { ...this.idle(), sequence: this.view.sequence, state: 'unknown' as const, operationRef: request.operationRef ?? null, executionId: request.executionId ?? null,
        stopConfirmed: null, saveConfirmed: null, blockReasons: [gap('operation_result_unknown')], error: this.view.error };
      return evaluationMethodSchemas[method].output.parse(control) as EvaluationReturn<M>;
    }
    if (['eval.start', 'eval.review.sync', 'eval.resend'].includes(method)) {
      const raw = input as EvaluationPayload<'eval.start'> & { executionId?: string };
      const descriptor = method === 'eval.start' ? { datasetId: raw.datasetId, selection: raw.selection, trials: raw.trials ?? (raw.selection === 'smoke' ? 1 : 3) } : { executionId: raw.executionId };
      const old = this.operations.get(operationRef);
      if (old) {
        if (old.method !== method || !isDeepStrictEqual(old.descriptor, descriptor)) throw safeError('state_conflict');
        return evaluationMethodSchemas[method].output.parse(await old.promise) as EvaluationReturn<M>;
      }
      const admission: Admission = { kind: 'evaluation' }; if (!this.admission) this.admission = admission;
      const promise = (async () => {
        let sent = false;
        try {
          await this.initialize(); if (this.unavailable) throw safeError('host_interrupted');
          if (method === 'eval.start') {
            const original = EvaluationControlViewSchema.parse(await this.exchange('eval.status', { operationRef, executionId: 'desktop-' + operationRef }));
            if (original.operationKind === 'run' && original.result?.kind === 'run' && original.result.report) {
              const receipt = await this.exchange(method, input, operationRef);
              if (!this.evaluationBusy() || this.view.operationRef === operationRef) this.adopt(original, true);
              return receipt;
            }
          }
          if (this.options.maintenanceBusy?.()) throw safeError('maintenance_busy');
          if (this.admission !== admission || this.closing || this.sealed || this.evaluationBusy() && this.view.operationRef !== operationRef || this.view.blockReasons.some(reason => reason.code === 'external_execution_lock')) throw safeError('runtime_busy');
          await this.productionIdle();
          if (this.options.maintenanceBusy?.()) throw safeError('maintenance_busy');
          this.view = { ...this.idle(), sequence: this.view.sequence, operationRef, operationKind: method === 'eval.start' ? 'run' : method === 'eval.review.sync' ? 'review_sync' : 'resend',
            executionId: method === 'eval.start' ? 'desktop-' + operationRef : raw.executionId!, state: 'starting', stopConfirmed: null, saveConfirmed: null };
          this.status(); sent = true;
          return await this.exchange(method, input, operationRef);
        } catch (error) {
          if (sent && !(this.view.state === 'settled' && this.view.stopConfirmed === true && this.view.saveConfirmed === true)) { this.view.state = 'unknown'; this.view.blockReasons = [gap('operation_result_unknown')]; this.status(); }
          else this.operations.delete(operationRef);
          throw error;
        } finally { if (this.admission === admission) this.admission = null; }
      })();
      this.operations.set(operationRef, { method, descriptor, promise });
      return evaluationMethodSchemas[method].output.parse(await promise) as EvaluationReturn<M>;
    }
    await this.initialize(); if (this.unavailable) throw safeError('host_interrupted');
    const data = evaluationMethodSchemas[method].output.parse(await this.exchange(method, input, operationRef));
    if (method === 'eval.cancel') {
      const cancelled = data as EvaluationReturn<'eval.cancel'>;
      if (cancelled.control.operationRef === this.view.operationRef && cancelled.control.executionId === this.view.executionId) {
        this.adopt(cancelled.control); return { ...cancelled, control: this.read() } as EvaluationReturn<M>;
      }
      return { ...cancelled, control: { ...cancelled.control, sequence: this.view.sequence, controllerExited: this.exitObserved } } as EvaluationReturn<M>;
    }
    if (method === 'eval.status') {
      const request = input as EvaluationPayload<'eval.status'>, control = data as EvaluationControlView;
      if (!request.platform && (!request.operationRef && !request.executionId || control.operationRef === this.view.operationRef && control.executionId === this.view.executionId)) { this.adopt(control); return this.read() as EvaluationReturn<M>; }
      return { ...control, sequence: this.view.sequence, controllerExited: this.exitObserved } as EvaluationReturn<M>;
    }
    return data as EvaluationReturn<M>;
  }
  private proof(): ShutdownProof { return { stopConfirmed: this.view.stopConfirmed, saveConfirmed: this.view.saveConfirmed, controllerExited: this.exitObserved, executionId: this.view.executionId, gaps: this.view.blockReasons }; }
  async shutdown(): Promise<ShutdownProof> {
    this.closing = true; this.sealed = true;
    if (!this.child) { this.closing = false; return this.proof(); }
    if (!this.shutdownTask) this.shutdownTask = (async () => {
      try {
        const proof = await this.exchange('shutdown') as ShutdownProof;
        this.view.stopConfirmed = proof.stopConfirmed; this.view.saveConfirmed = proof.saveConfirmed; this.view.blockReasons = proof.gaps;
        if (proof.stopConfirmed !== true || proof.saveConfirmed !== true) this.view.state = 'unknown';
        this.status();
        if (proof.stopConfirmed === true && proof.saveConfirmed === true) await this.exited;
      } catch { this.view.state = 'unknown'; this.view.blockReasons = [gap('evaluation_shutdown_unconfirmed')]; this.status(); }
      return this.proof();
    })();
    const task = this.shutdownTask;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([task, new Promise<ShutdownProof>(resolve => { timer = setTimeout(() => { this.view.state = 'unknown'; this.view.blockReasons = [gap('evaluation_controller_exit_unconfirmed')]; this.status(); resolve(this.proof()); }, 30000); timer.unref(); })]);
      if (!this.child || result.stopConfirmed !== true || result.saveConfirmed !== true) this.shutdownTask = null;
      return result;
    } finally { clearTimeout(timer); this.closing = false; }
  }
}
