import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppErrorSchema, OpaqueIdSchema, safeError, serviceResult, type AppError, type Result } from '../../../contracts/src/error';
import { canonicalRequest } from '../../../contracts/src/run';
import { EXPORT_VERSION, ExportCopyReceiptSchema, ExportOperationSchema, ExportRequestSchema, type ExportDestinationSchema,
  type ExportDestinationCopySchema, type ExportListInputSchema, type ExportOperation, type ExportRequest, type ExportServicePort,
  type ExportStore, type FrozenExportSource, type PublishedExport, type StoredExport, type ExportCopyReceipt, type ExportCopyState } from '../../../contracts/src/export';
import type { ArtifactStore } from '../../../storage/src/artifact-store';

type Destination = {
  describe(input: z.infer<typeof ExportDestinationSchema>): Promise<{ destinationIdentity: string }>;
  copy(input: z.infer<typeof ExportDestinationCopySchema>): Promise<ExportCopyReceipt>;
  cancel(operationRef: string): Promise<{ stopped: boolean }>;
  settlePrevious(): Promise<{ stopped: true }>;
};
type Active = { operationRef: string; requestHash: string; controller: AbortController; accepted: Promise<Result<ExportOperation>>;
  task: Promise<void> | null; copying: boolean; stopped: boolean; saving: boolean; receipt?: ExportCopyReceipt;
  pendingFailure?: { state: 'failed' | 'cancelled'; error: AppError | null; copyState: ExportCopyState } };
const terminal = (state: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(state);
const publicView = (record: StoredExport) => ExportOperationSchema.parse(Object.fromEntries(Object.keys(ExportOperationSchema.shape).map(key => [key, record[key as keyof StoredExport]])));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export class ExportService implements ExportServicePort {
  private active: Active | null = null;
  private closing = false;
  constructor(private readonly instanceId: string, private readonly dependencies: {
    store: ExportStore; artifacts: Pick<ArtifactStore, 'publishExport' | 'verifyExport'>; destination: Destination; assertWritable(): void;
  }) {}
  get busy() { return this.active !== null; }
  private required(operationRef: string) { const record = this.dependencies.store.find(operationRef); if (!record) throw new Error('operation_not_found'); return record; }
  private requestHash(request: ExportRequest, source: FrozenExportSource) {
    return sha(canonicalRequest({ queryId: request.queryId, resultHash: source.query.resultHash, answerId: request.answerId,
      answerTextHash: source.answer ? sha(source.answer.text) : null, format: request.format, exportVersion: EXPORT_VERSION,
      priorOperationRef: request.priorOperationRef ?? null, destinationIdentity: request.destinationIdentity }));
  }
  export(value: ExportRequest): Promise<Result<ExportOperation>> {
    return serviceResult(async () => {
      const request = ExportRequestSchema.parse(value), source = this.dependencies.store.readSource(request.queryId, request.answerId), requestHash = this.requestHash(request, source);
      const old = this.dependencies.store.find(request.operationRef);
      if (old) { if (old.requestHash !== requestHash) throw new Error('state_conflict'); return publicView(old); }
      if (this.active?.operationRef === request.operationRef) {
        if (this.active.requestHash !== requestHash) throw new Error('state_conflict');
        const result = await this.active.accepted; if (!result.ok) throw result.error; return result.data;
      }
      if (this.closing || this.busy) throw new Error('runtime_busy'); this.dependencies.assertWritable();
      let resolve!: (result: Result<ExportOperation>) => void;
      const active: Active = { operationRef: request.operationRef, requestHash, controller: new AbortController(),
        accepted: new Promise(done => { resolve = done; }), task: null, copying: false, stopped: true, saving: false };
      this.active = active; // Reserve before the first asynchronous permission or artifact check.
      const acceptance = await serviceResult(async () => {
        const destination = await this.dependencies.destination.describe(this.destination(request));
        if (destination.destinationIdentity !== request.destinationIdentity) throw new Error('export_destination_invalid');
        active.controller.signal.throwIfAborted();
        const prior = request.priorOperationRef ? this.required(request.priorOperationRef) : null;
        if (prior && (!terminal(prior.state) || prior.sessionId !== source.query.sessionId)) throw new Error('state_conflict');
        let reuse: PublishedExport | null = null;
        if (prior?.artifact && prior.queryId === request.queryId && prior.answerId === request.answerId && prior.format === request.format) {
          try { reuse = await this.dependencies.artifacts.verifyExport(prior.artifact.id); }
          catch (error) { if (!(error instanceof Error && error.message === 'artifact_not_ready') && !(AppErrorSchema.safeParse(error).success && (error as AppError).code === 'artifact_not_ready')) throw error; }
        }
        active.controller.signal.throwIfAborted();
        const priorOperationRefs: string[] = [];
        for (let previous = prior; previous; previous = previous.priorOperationRef ? this.required(previous.priorOperationRef) : null) {
          if (priorOperationRefs.length === 100 || previous.sessionId !== source.query.sessionId) throw new Error('state_conflict');
          priorOperationRefs.push(previous.operationRef);
        }
        const record = this.dependencies.store.accept({ operationRef: request.operationRef, requestHash, instanceId: this.instanceId, sessionId: source.query.sessionId,
          queryId: request.queryId, answerId: request.answerId, format: request.format, priorExportId: prior?.id ?? null, reuseArtifactId: reuse?.artifactId ?? null, createdAt: new Date().toISOString() });
        const accepted = publicView(record);
        active.task = this.execute(active, request, source, record, reuse, priorOperationRefs);
        return accepted;
      }, 'storage_write_failed', { operationRef: request.operationRef });
      resolve(acceptance); if (!acceptance.ok) { if (this.active === active) this.active = null; throw acceptance.error; } return acceptance.data;
    }, 'storage_write_failed');
  }
  private destination(request: ExportRequest) {
    const { operationRef, queryId, answerId, format, destinationToken, destinationIdentity } = request;
    return { operationRef, queryId, answerId, format, destinationToken, destinationIdentity };
  }
  private async execute(active: Active, request: ExportRequest, source: FrozenExportSource, record: StoredExport, reuse: PublishedExport | null, priorOperationRefs: string[]) {
    let stage: 'generation' | 'registration' | 'copy' = 'generation';
    try {
      const proof = reuse ?? await this.dependencies.artifacts.publishExport({ artifactId: record.reservedArtifactId!, originOperationRef: request.operationRef, format: request.format, source }, active.controller.signal);
      stage = 'registration';
      if (!reuse) this.dependencies.store.publish(request.operationRef, proof);
      this.dependencies.store.register(request.operationRef, proof);
      active.controller.signal.throwIfAborted();
      stage = 'copy'; this.dependencies.store.beginCopy(request.operationRef); active.copying = true; active.stopped = false;
      const receipt = ExportCopyReceiptSchema.parse(await this.dependencies.destination.copy({ ...this.destination(request), artifactId: proof.artifactId, manifest: proof.manifest, priorOperationRefs }));
      active.stopped = true; active.receipt = receipt;
      try { this.dependencies.store.complete(request.operationRef, receipt); }
      catch (error) { if (!this.completed(active)) throw error; }
    } catch (error) {
      let copyState: 'unknown' | 'not_started' | 'failed' = active.copying ? 'unknown' : 'not_started';
      const known = AppErrorSchema.safeParse(error), code = known.success ? known.data.code : error instanceof Error ? error.message : '';
      if (active.copying && !active.stopped) {
        try { active.stopped = (await this.dependencies.destination.cancel(request.operationRef)).stopped; } catch { active.stopped = false; }
      }
      if (stage === 'copy' && ['destination_conflict', 'export_destination_invalid'].includes(code)) copyState = 'failed';
      const cancelled = active.controller.signal.aborted;
      const failure = safeError(['destination_conflict', 'export_destination_invalid'].includes(code) ? code
        : stage === 'generation' ? 'export_write_failed' : stage === 'registration' ? 'export_registration_failed' : 'export_copy_failed', undefined, { operationRef: request.operationRef });
      active.pendingFailure = { state: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : failure, copyState };
      try { this.dependencies.store.terminate(request.operationRef, active.pendingFailure.state, active.pendingFailure.error, copyState); }
      catch { active.saving = true; }
    } finally {
      if (this.active === active && active.stopped && !active.saving) this.active = null;
    }
  }
  private completed(active: Active) {
    const saved = this.required(active.operationRef);
    return active.receipt !== undefined && saved.state === 'completed' && canonicalRequest(saved.copyReceipt) === canonicalRequest(active.receipt);
  }
  private settleSave(active: Active) {
    if (!active.saving) return;
    if (!this.completed(active)) {
      const failure = active.pendingFailure; if (!failure) throw new Error('storage_write_failed');
      this.dependencies.store.terminate(active.operationRef, failure.state, failure.error, failure.copyState);
    }
    active.saving = false;
  }
  read(operationRef: string): Promise<Result<ExportOperation | null>> {
    return serviceResult(() => { const record = this.dependencies.store.find(OpaqueIdSchema.parse(operationRef));
      if (!record) return null; this.dependencies.store.readSource(record.queryId, record.answerId); return publicView(record); }, 'storage_read_failed', { operationRef });
  }
  list(input: z.input<typeof ExportListInputSchema>) { return serviceResult(() => this.dependencies.store.list(input), 'storage_read_failed'); }
  cancel(operationRef: string): Promise<Result<ExportOperation>> {
    return serviceResult(async () => {
      const record = this.required(OpaqueIdSchema.parse(operationRef)); this.dependencies.store.readSource(record.queryId, record.answerId);
      if (terminal(record.state)) return publicView(record);
      this.dependencies.store.requestCancel(operationRef);
      const active = this.active;
      if (active?.operationRef === operationRef) {
        active.controller.abort();
        if (active.copying) {
          active.stopped = (await this.dependencies.destination.cancel(operationRef)).stopped;
          if (active.stopped) await active.task;
        }
      }
      return publicView(this.required(operationRef));
    }, 'storage_write_failed', { operationRef });
  }
  recover(operationRef: string): Promise<Result<ExportOperation>> {
    return serviceResult(async () => {
      OpaqueIdSchema.parse(operationRef);
      const pending = this.active;
      if (pending?.operationRef === operationRef && (pending.saving || terminal(this.required(operationRef).state))) {
        await this.dependencies.destination.settlePrevious(); pending.stopped = true;
        await pending.task; this.settleSave(pending); if (this.active === pending) this.active = null;
      }
      const record = this.required(operationRef); this.dependencies.store.readSource(record.queryId, record.answerId);
      if (this.closing || this.busy) throw new Error('runtime_busy'); this.dependencies.assertWritable();
      if (!terminal(record.state) || record.reservedArtifactId === null) throw new Error('state_conflict');
      const artifactId = record.reservedArtifactId;
      const active: Active = { operationRef, requestHash: record.requestHash, controller: new AbortController(), accepted: Promise.resolve({ ok: true, data: publicView(record) }),
        task: null, copying: false, stopped: false, saving: false };
      this.active = active;
      const work = (async () => {
        await this.dependencies.destination.settlePrevious(); active.stopped = true;
        const proof = await this.dependencies.artifacts.verifyExport(artifactId);
        this.dependencies.store.register(operationRef, proof); return publicView(this.required(operationRef));
      })();
      active.task = work.then(() => {}, () => {});
      try { return await work; } finally { if (active.stopped && this.active === active) this.active = null; }
    }, 'storage_read_failed', { operationRef });
  }
  async recoverInterrupted() {
    if (this.busy) throw new Error('runtime_busy');
    await this.dependencies.destination.settlePrevious();
    for (const record of this.dependencies.store.unfinished()) this.dependencies.store.terminate(record.operationRef, 'interrupted', safeError('host_interrupted'),
      record.copyState === 'copying' ? 'unknown' : record.copyState);
  }
  async shutdown() {
    this.closing = true;
    const active = this.active; if (!active) return;
    active.controller.abort();
    await this.dependencies.destination.settlePrevious(); active.stopped = true;
    await active.accepted; await active.task;
    this.settleSave(active);
    if (this.active === active) this.active = null;
  }
}
