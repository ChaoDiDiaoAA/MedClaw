import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { AppErrorSchema, safeError, type Result } from '@medclaw/contracts/error';
import { BackupRecordSchema, LaunchSelectionSchema, RestoreRecordSchema, MAINTENANCE_PROTOCOL_VERSION, MaintenanceReplySchema, MaintenanceRequestSchema,
  type BackupReceipt, type RestoreReceipt, type MaintenanceContext, type MaintenanceSelection, type MaintenanceInput, type MaintenanceOutput, type HostJobDomain } from '@medclaw/contracts/maintenance';
import { RuntimeControlViewSchema } from '@medclaw/contracts/run';
import type { HostController } from './host-controller';
import type { FileTokens } from './file-tokens';
import { atomicWriteJson } from './settings';

type WorkerOwner = { instanceId: string; startupToken: string; domain: HostJobDomain; processExited: boolean };

export async function requestMaintenance<I extends MaintenanceInput>(options: { bunExecutable: string; maintenanceEntry: string; signal?: AbortSignal; onWorker?(owner: WorkerOwner): void }, input: I, operationRef: string): Promise<Result<MaintenanceOutput<I>>> {
  if (!isAbsolute(options.bunExecutable) || !isAbsolute(options.maintenanceEntry)) return { ok: false, error: safeError('access_denied') };
  const request = MaintenanceRequestSchema.parse({ protocolVersion: MAINTENANCE_PROTOCOL_VERSION, requestId: randomUUID(), operationRef, workerInstanceId: randomUUID(), input });
  return new Promise(resolve => {
    let finished = false, output = Buffer.alloc(0), invalid = false, stopping = false;
    const child = spawn(options.bunExecutable, ['--no-env-file', options.maintenanceEntry], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MEDCLAW_MAINTENANCE_INSTANCE: request.workerInstanceId } });
    const owner: WorkerOwner = { instanceId: request.workerInstanceId, startupToken: request.workerInstanceId, processExited: false,
      domain: { contract: 'medclaw.host-job/v1', jobName: `Local\\MedClaw.${request.workerInstanceId}.${request.workerInstanceId}`, createdAt: new Date().toISOString() } };
    options.onWorker?.(owner);
    let killTimer: ReturnType<typeof setTimeout> | undefined, unconfirmedTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: Result<MaintenanceOutput<I>>) => { if (!finished) { finished = true; clearTimeout(timer); clearTimeout(killTimer); clearTimeout(unconfirmedTimer); options.signal?.removeEventListener('abort', stop); resolve(result); } };
    const failure = () => ({ ok: false as const, error: safeError('host_stop_unconfirmed', undefined, { operationRef }) });
    const stop = () => {
      if (stopping || finished) return;
      stopping = true; invalid = true; child.stdin.end();
      killTimer = setTimeout(() => { child.kill(); unconfirmedTimer = setTimeout(() => finish(failure()), 10000); }, 10000);
    };
    const timer = setTimeout(stop, input.action === 'backup.create' || input.action === 'backup.restore' ? 600000 : 10000);
    options.signal?.addEventListener('abort', stop, { once: true });
    child.on('error', () => finish(failure())); child.stdin.on('error', () => { invalid = true; });
    child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk: Buffer) => { if (output.length + chunk.length > 65536) stop(); else output = Buffer.concat([output, chunk]); });
    child.once('close', code => {
      owner.processExited = true;
      if (invalid || code !== 0) return finish(failure());
      try {
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(output);
        if (!raw.endsWith('\n') || raw.slice(0, -1).includes('\n')) throw new Error();
        const reply = MaintenanceReplySchema.parse(JSON.parse(raw));
        if (reply.requestId !== request.requestId || reply.operationRef !== operationRef || reply.workerInstanceId !== request.workerInstanceId || reply.action !== input.action
          || input.action === 'backup.read' && reply.result.ok && reply.result.data !== null && 'kind' in reply.result.data && reply.result.data.kind !== input.kind) throw new Error();
        if (reply.result.ok && reply.result.data) {
          const data = reply.result.data;
          if ('operationRef' in data && data.operationRef !== operationRef) throw new Error();
          if ('owner' in input && 'processTreeProof' in data && data.processTreeProof
            && (data.processTreeProof.instanceId !== input.owner.instanceId
              || input.action === 'process.checkDomain' && data.processTreeProof.basis !== 'windows_job_empty')) throw new Error();
        }
        finish(reply.result as Result<MaintenanceOutput<I>>);
      } catch { finish(failure()); }
    });
    child.stdin.write(JSON.stringify(request) + '\n');
    if (options.signal?.aborted) stop();
  });
}

export interface MaintenanceControllerOptions {
  dataRoot: string; selectionRoot: string; installManifestPath: string; bunExecutable: string; maintenanceEntry: string; files: FileTokens;
  host: Pick<HostController, 'read' | 'request' | 'stop' | 'refreshStopProof'>;
  writesBusy(): boolean;
  appClosing?(): boolean;
}
type ActiveMaintenance = { operationRef: string; key: unknown; abort: AbortController; worker: WorkerOwner | null; settled: boolean; pending: Promise<Result<BackupReceipt | RestoreReceipt>> };
function readRecord(root: string, kind: 'create' | 'restore') {
  const path = join(root, kind === 'create' ? 'receipt.json' : 'data/restore-receipt.json');
  if (!existsSync(path)) return null;
  if (statSync(path).size > 1048576) throw new Error('backup_invalid');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (kind === 'create') {
    const record = BackupRecordSchema.parse(raw);
    return basename(realpathSync(root)) === 'MedClaw-backup-' + record.receipt.operationRef ? record : null;
  }
  const record = RestoreRecordSchema.parse(raw);
  return record.request.targetRoot === realpathSync(root) ? record : null;
}
export class MaintenanceController {
  private active: ActiveMaintenance | null = null;
  private readonly writes = new Set<Promise<unknown>>();
  private closing = false;
  constructor(private readonly options: MaintenanceControllerOptions) {}
  get busy(): boolean { return this.active !== null || this.closing || this.options.appClosing?.() === true; }
  assertWritable(): void { if (this.busy) throw new Error('maintenance_busy'); }
  async withWrite<T>(work: () => Promise<T>, original = false): Promise<T> {
    if (!original) this.assertWritable();
    const task = Promise.resolve().then(work); this.writes.add(task);
    try { return await task; } finally { this.writes.delete(task); }
  }
  selectResult(root: string, context: MaintenanceContext): MaintenanceSelection {
    const create = readRecord(root, 'create'), restored = readRecord(root, 'restore');
    if (!!create === !!restored) throw new Error('backup_invalid');
    const record = create ?? restored!, kind = create ? 'create' : 'restore';
    const grant = this.options.files.issueMaintenance(context.windowId, record.receipt.operationRef, 'backup-result', root);
    return { resultToken: grant.fileToken, resultLabel: grant.directoryName, originalOperationRef: record.receipt.operationRef, originalKind: kind };
  }
  async read(input: { resultToken: string; kind: 'create' | 'restore' }, context: MaintenanceContext): Promise<Result<BackupReceipt | RestoreReceipt | null>> {
    try {
      await this.refresh();
      const root = this.options.files.resolveMaintenance(input.resultToken, context.windowId, context.operationRef, 'backup-result');
      const record = readRecord(root, input.kind);
      return { ok: true, data: record?.receipt.operationRef === context.operationRef ? record.receipt : null };
    } catch (error) { return this.failure(error, context.operationRef, 'backup_invalid'); }
  }
  async create(input: { destinationToken: string }, context: MaintenanceContext): Promise<Result<BackupReceipt>> {
    try {
      const destinationRoot = this.options.files.resolveMaintenance(input.destinationToken, context.windowId, context.operationRef, 'backup-destination');
      const original = readRecord(join(destinationRoot, 'MedClaw-backup-' + context.operationRef), 'create');
      if (original) {
        if (original.receipt.operationRef !== context.operationRef || !isDeepStrictEqual(original.request, { kind: 'create', sourceRoot: this.options.dataRoot, destinationRoot })) throw new Error('state_conflict');
        return { ok: true, data: original.receipt as BackupReceipt };
      }
      return this.perform({ action: 'backup.create', sourceRoot: this.options.dataRoot, destinationRoot, installManifestPath: this.options.installManifestPath }, context) as Promise<Result<BackupReceipt>>;
    } catch (error) { return this.failure(error, context.operationRef, 'backup_write_failed'); }
  }
  async restore(input: { sourceToken: string; targetRootToken: string }, context: MaintenanceContext): Promise<Result<RestoreReceipt>> {
    try {
      const sourceBackup = this.options.files.resolveMaintenance(input.sourceToken, context.windowId, context.operationRef, 'backup-source');
      const targetRoot = this.options.files.resolveMaintenance(input.targetRootToken, context.windowId, context.operationRef, 'restore-target');
      const original = readRecord(targetRoot, 'restore');
      if (original) {
        if (original.receipt.operationRef !== context.operationRef || !isDeepStrictEqual(original.request, { kind: 'restore', sourceBackup, targetRoot })) throw new Error('state_conflict');
        if (this.options.dataRoot === targetRoot) return { ok: true, data: original.receipt as RestoreReceipt };
      }
      return this.perform({ action: 'backup.restore', sourceRoot: this.options.dataRoot, sourceBackup, targetRoot, installManifestPath: this.options.installManifestPath }, context) as Promise<Result<RestoreReceipt>>;
    } catch (error) { return this.failure(error, context.operationRef, 'restore_failed'); }
  }
  private failure(error: unknown, operationRef: string, fallback: string): Result<never> {
    const known = AppErrorSchema.safeParse(error), safe = safeError(error instanceof Error ? error.message : fallback, error, { operationRef });
    return { ok: false, error: known.success ? known.data : safe.code === 'internal_error' ? safeError(fallback, error, { operationRef }) : safe };
  }
  private perform(input: Extract<MaintenanceInput, { action: 'backup.create' | 'backup.restore' }>, context: MaintenanceContext): Promise<Result<BackupReceipt | RestoreReceipt>> {
    if (this.active) {
      if (this.active.operationRef === context.operationRef && isDeepStrictEqual(this.active.key, input)) return this.active.pending;
      return Promise.resolve(this.failure(new Error('maintenance_busy'), context.operationRef, 'maintenance_busy'));
    }
    if (this.busy) return Promise.resolve(this.failure(new Error('maintenance_busy'), context.operationRef, 'maintenance_busy'));
    const active: ActiveMaintenance = { operationRef: context.operationRef, key: input, abort: new AbortController(), worker: null, settled: false, pending: Promise.resolve({ ok: false, error: safeError('maintenance_busy') }) };
    this.active = active;
    active.pending = (async () => {
      let unconfirmed = false;
      try {
        if (this.writes.size || this.options.writesBusy()) throw new Error('maintenance_busy');
        await this.options.host.refreshStopProof();
        let host = this.options.host.read();
        if (host.state === 'ready' && host.instanceId) {
          const response = await this.options.host.request('run.control.read', {}, context.operationRef, undefined, host.instanceId);
          if (!response.ok) throw response.error;
          const control = RuntimeControlViewSchema.parse(response.data);
          if (control.instanceId !== host.instanceId || control.activeRootRun || !control.acceptingNewRuns || control.blockReasons.length
            || this.writes.size || this.options.writesBusy()) throw new Error('maintenance_busy');
          active.abort.signal.throwIfAborted();
          host = await this.options.host.stop(host.instanceId, true);
        }
        active.abort.signal.throwIfAborted();
        if (host.state === 'ready' && host.error?.code === 'maintenance_busy') throw host.error;
        if (!host.canStart || !['stopped', 'failed'].includes(host.state)) throw new Error('host_stop_unconfirmed');
        if (input.action === 'backup.create' && (!host.shutdown || host.shutdown.executionStopped !== true || host.shutdown.requiredPersistenceComplete !== true
          || host.shutdown.databaseClosed !== true || !host.shutdown.processExited || host.shutdown.processTreeStopped !== true)) throw new Error('maintenance_busy');
        if (this.writes.size || this.options.writesBusy()) throw new Error('maintenance_busy');
        const result = await requestMaintenance({ bunExecutable: this.options.bunExecutable, maintenanceEntry: this.options.maintenanceEntry, signal: active.abort.signal,
          onWorker: owner => { active.worker = owner; unconfirmed = true; } }, input, context.operationRef);
        if (!result.ok && result.error.code === 'host_stop_unconfirmed') return result;
        if (!active.worker || !await this.workerStopped(active.worker)) throw new Error('host_stop_unconfirmed');
        unconfirmed = false;
        if (!result.ok) return result;
        if (input.action === 'backup.restore') {
          const receipt = result.data as RestoreReceipt;
          try {
            atomicWriteJson(join(this.options.selectionRoot, 'launch.json'), LaunchSelectionSchema.parse({ contract: 'medclaw.launch/v1', activeDataRoot: input.targetRoot, restoreOperationRef: receipt.operationRef }));
          } catch { throw new Error('restore_failed'); }
        }
        return result;
      } catch (error) { return this.failure(error, context.operationRef, input.action === 'backup.create' ? 'backup_write_failed' : 'restore_failed'); }
      finally { active.settled = true; if (!unconfirmed && this.active === active) this.active = null; }
    })();
    return active.pending;
  }
  private async workerStopped(worker: WorkerOwner): Promise<boolean> {
    if (!worker.processExited) return false;
    try {
      const result = await requestMaintenance({ bunExecutable: this.options.bunExecutable, maintenanceEntry: this.options.maintenanceEntry },
        { action: 'process.checkDomain', owner: { instanceId: worker.instanceId, startupToken: worker.startupToken }, domain: worker.domain }, randomUUID());
      return result.ok && result.data.stopped;
    } catch { return false; }
  }
  async refresh(): Promise<void> {
    const active = this.active;
    if (active?.settled && active.worker && await this.workerStopped(active.worker) && this.active === active) this.active = null;
  }
  async shutdown(): Promise<{ stopped: boolean }> {
    this.closing = true;
    try { const active = this.active; active?.abort.abort(); await active?.pending; await Promise.allSettled([...this.writes]); await this.refresh(); return { stopped: this.active === null && this.writes.size === 0 }; }
    finally { this.closing = false; }
  }
}
