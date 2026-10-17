import { AppErrorSchema, safeError, type Result } from '@medclaw/contracts/error';
import { MaintenanceReplySchema, MaintenanceRequestSchema, type MaintenanceInput, type MaintenanceOutput } from '@medclaw/contracts/maintenance';
import { acquireStoppedWriterLease, acquireWriterLock, inspectWriterLock, prepareRestartRecovery, type WriterLease } from './writer-lock';
import { createHostJob, inspectStoppedJob } from './windows-job';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquireUpgradeLeases } from './upgrade';

let buffer = Buffer.alloc(0), accepted = false;
const cancellation = new AbortController();
process.stdin.on('data', (chunk: Buffer) => {
  if (accepted) return;
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > 65536) process.exit(1);
  const end = buffer.indexOf(10); if (end < 0) return;
  accepted = true;
  void (async () => {
    const request = MaintenanceRequestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end))));
    if (end + 1 !== buffer.length || request.workerInstanceId !== process.env.MEDCLAW_MAINTENANCE_INSTANCE) process.exit(1);
    let result: Result<MaintenanceOutput<MaintenanceInput>>, lease: WriterLease | undefined;
    try {
      const owner = { instanceId: request.workerInstanceId, startupToken: request.workerInstanceId }, job = createHostJob(owner);
      const input = request.input;
      if (input.action === 'process.checkDomain') {
        const proof = inspectStoppedJob(input.owner, input.domain);
        result = { ok: true, data: { stopped: proof !== null, processTreeProof: proof, canPrepareRecovery: false } };
      } else if (input.action === 'process.check' || input.action === 'process.prepareRecovery') {
        if (input.action === 'process.prepareRecovery') prepareRestartRecovery(input.lockPath, input.owner);
        result = { ok: true, data: inspectWriterLock(input.lockPath, input.owner) };
      } else if (input.action === 'upgrade.check') {
        const guard = await acquireUpgradeLeases(input.sourceRoot, owner, job);
        try { result = { ok: true, data: { checkedRoots: guard.checkedRoots } }; }
        finally { guard.release(); }
      } else {
        const { createBackup, restoreBackup, readBackup, readRestore } = await import('@medclaw/storage/backup');
        if (input.action === 'backup.read') result = { ok: true, data: await (input.kind === 'create' ? readBackup : readRestore)(input.sourceRoot, request.operationRef) };
        else {
          const root = await realpath(input.sourceRoot);
          if (root.toLowerCase() !== resolve(input.sourceRoot).toLowerCase()) throw new Error('access_denied');
          if (input.action === 'backup.restore') {
            const target = resolve(input.targetRoot), roots = [root, await realpath(input.sourceBackup), await realpath(dirname(input.installManifestPath)),
              join(await realpath(dirname(target)), basename(target))];
            const outside = (value: string) => isAbsolute(value) || value === '..' || value.startsWith('..' + sep);
            for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++)
              if (!outside(relative(roots[i]!, roots[j]!)) || !outside(relative(roots[j]!, roots[i]!))) throw new Error('access_denied');
          }
          await mkdir(join(root, 'runtime'), { recursive: true });
          if ((await realpath(join(root, 'runtime'))).toLowerCase() !== join(root, 'runtime').toLowerCase()) throw new Error('access_denied');
          lease = await acquireStoppedWriterLease({ lockPath: join(root, 'runtime/host.lock'), owner, processDomain: job.domain });
          const { validateNativeHistory } = await import('../../../packages/runtime-pi/src/memory-store');
          if (input.action === 'backup.create') result = { ok: true, data: await createBackup({ ...input, operationRef: request.operationRef, validateHistory: validateNativeHistory }, cancellation.signal) };
          else {
            result = { ok: true, data: await restoreBackup({ ...input, operationRef: request.operationRef, validateHistory: validateNativeHistory,
              leaseTemporaryRoot: async root => {
                await mkdir(join(root, 'runtime'));
                return acquireWriterLock({ lockPath: join(root, 'runtime/host.lock'), owner, processDomain: job.domain });
              } }, cancellation.signal) };
          }
        }
      }
      lease?.release(); lease = undefined;
      if (job.readActiveProcesses() !== 1) throw new Error('host_stop_unconfirmed');
    } catch (error) {
      const known = AppErrorSchema.safeParse(error);
      const code = error instanceof Error ? error.message : '', fallback = request.input.action === 'backup.create' ? 'backup_write_failed'
        : request.input.action === 'backup.restore' ? 'restore_failed' : request.input.action === 'backup.read' ? 'backup_invalid' : 'host_stop_unconfirmed';
      const publicationFailure = (request.input.action === 'backup.create' || request.input.action === 'backup.restore')
        && ['export_destination_invalid', 'destination_conflict', 'publish_failed'].includes(known.success ? known.data.code : code);
      const safe = safeError(publicationFailure ? fallback : code, error, { operationRef: request.operationRef });
      result = { ok: false, error: known.success && !publicationFailure ? known.data : safe.code !== 'internal_error' ? safe : safeError(fallback, error, { operationRef: request.operationRef }) };
    } finally {
      lease?.release();
    }
    const { input: _input, ...identity } = request;
    const reply = MaintenanceReplySchema.parse({ ...identity, action: request.input.action, result });
    await new Promise<void>((done, reject) => process.stdout.write(JSON.stringify(reply) + '\n', error => error ? reject(error) : done()));
    process.exit(0);
  })().catch(() => process.exit(1));
});
process.stdin.on('end', () => { if (!accepted) process.exit(1); else cancellation.abort(); });
