import { expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ChildProcess } from 'node:child_process';
import * as childProcesses from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dlopen, ptr } from 'bun:ffi';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteMemoryStore } from '../../packages/storage/src/memory-store';
import { SqliteImportStore } from '../../packages/storage/src/import-store';
import { validateNativeHistory } from '../../packages/runtime-pi/src/memory-store';
import { memoryNativeFixture } from '../fixtures/p9-memory';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { MainSettings } from '../../apps/desktop/src/main/settings';
import { FileTokens } from '../../apps/desktop/src/main/file-tokens';
import { MainCredentials } from '../../apps/desktop/src/main/credentials';
import { EvaluationController } from '../../apps/desktop/src/main/evaluation-controller';
import type { HostView } from '../../packages/contracts/src/model';
import type { Result } from '../../packages/contracts/src/error';
import type { HostJobDomain } from '../../packages/contracts/src/maintenance';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-main-maintenance-')), dataRoot = join(root, 'source'), selectionRoot = join(root, 'selection'), destination = join(root, 'backup-parent'), targetParent = join(root, 'target-parent');
  for (const path of [join(dataRoot, 'data'), selectionRoot, destination, targetParent]) mkdirSync(path, { recursive: true });
  const db = openDatabase(join(dataRoot, 'data/app.sqlite')); db.close(); new MainSettings(join(dataRoot, 'data/settings.json')).read();
  mkdirSync(join(root, 'install')); const installManifestPath = join(root, 'install/install.json');
  writeFileSync(installManifestPath, JSON.stringify({ contract: 'medclaw.install/v1', appVersion: '0.1.0', platform: 'win32', arch: 'x64', sdkVersion: '0.87.1', bunVersion: '1.4.0', electronVersion: '44.5.1', protocolVersion: 'medclaw.host/p17-v2', schemaVersion: 16,
    hostEntry: 'runtime/apps/host/src/main.ts', maintenanceEntry: 'runtime/apps/host/src/maintenance.ts', resourceRoot: 'runtime/resources', resources: [], plugins: [], binaries: [{ name: 'bun', version: '1.4.0', source: 'ENGINEERING fixture', path: 'bin/bun.exe' }] }));
  let view: HostView = { instanceId: 'source-host', state: 'ready', canStart: false, sdkVersion: '0.87.1', schemaVersion: 16, error: null };
  let check!: (value: Result<unknown>) => void, stops = 0, writesBusy = false;
  let gate: Promise<Result<unknown>> | null = null;
  const host = {
    read: () => structuredClone(view), refreshStopProof: async () => {},
    request: async () => gate ?? { ok: true as const, data: { instanceId: 'source-host', activeRootRun: null, acceptingNewRuns: true, blockReasons: [], budget: null } },
    stop: async (instanceId: string, requireIdle?: boolean) => {
      expect(instanceId).toBe('source-host'); expect(requireIdle).toBe(true); stops++;
      view = { ...view, state: 'stopped', canStart: true, shutdown: { executionStopped: true, requiredPersistenceComplete: true, databaseClosed: true, processExited: true, processTreeStopped: true, error: null } };
      return structuredClone(view);
    },
  };
  const files = new FileTokens();
  return { root, dataRoot, selectionRoot, destination, targetParent, files, host, options: { dataRoot, selectionRoot, host, files, installManifestPath,
    bunExecutable: process.execPath, maintenanceEntry: resolve(import.meta.dir, '../../apps/host/src/maintenance.ts'), writesBusy: () => writesBusy },
    pendingControl() { gate = new Promise(done => { check = done; }); },
    releaseControl() { check?.({ ok: true, data: { instanceId: 'source-host', activeRootRun: null, acceptingNewRuns: true, blockReasons: [], budget: null } }); },
    blockWrites(value: boolean) { writesBusy = value; }, get stops() { return stops; },
    failedSource() { view = { ...view, state: 'failed', canStart: true, error: { code: 'storage_migration_failed', category: 'storage', retryable: false, message: 'Database migration failed.' }, shutdown: undefined }; },
    close() { rmSync(root, { recursive: true, force: true }); } };
}

test('maintenance grants are bound to window, purpose, original operation and a five-minute deadline', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-grants-')); let now = 1000;
  try {
    const files = new FileTokens(() => now), grant = files.issueMaintenance(7, 'original', 'backup-destination', root);
    expect(files.resolveMaintenance(grant.fileToken, 7, 'original', 'backup-destination')).toBe(root);
    for (const [windowId, operationRef, purpose] of [[8, 'original', 'backup-destination'], [7, 'other', 'backup-destination'], [7, 'original', 'backup-source']] as const)
      expect(() => files.resolveMaintenance(grant.fileToken, windowId, operationRef, purpose)).toThrow('access_denied');
    now += 300000; expect(() => files.resolveMaintenance(grant.fileToken, 7, 'original', 'backup-destination')).toThrow('access_denied');
    expect(() => files.issueMaintenance(7, 'bad:filename', 'restore-target', root)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discarding a maintenance selection revokes only that window operation and preserves already consumed grants', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-discard-'));
  try {
    const files = new FileTokens(), original = files.issueMaintenance(7, 'original', 'backup-destination', root), unused = files.issueMaintenance(7, 'original', 'restore-target', root);
    const otherWindow = files.issueMaintenance(8, 'original', 'backup-destination', root), otherOperation = files.issueMaintenance(7, 'different', 'backup-destination', root), ordinary = files.issue(7, 'host-instance', 'original', root);
    expect(files.consumeMaintenance).toBeFunction(); expect(files.discardMaintenance).toBeFunction();
    files.consumeMaintenance(7, 'original', [{ token: original.fileToken, purpose: 'backup-destination' }]);
    files.discardMaintenance(7, 'original'); files.discardMaintenance(7, 'original');
    expect(() => files.resolveMaintenance(unused.fileToken, 7, 'original', 'restore-target')).toThrow('access_denied');
    expect(files.resolveMaintenance(original.fileToken, 7, 'original', 'backup-destination')).toBe(root);
    expect(files.resolveMaintenance(otherWindow.fileToken, 8, 'original', 'backup-destination')).toBe(root);
    expect(files.resolveMaintenance(otherOperation.fileToken, 7, 'different', 'backup-destination')).toBe(root);
    expect(files.resolve(ordinary.fileToken, 7, 'host-instance', 'original')).toBe(root);
    const atomic = files.issueMaintenance(7, 'atomic', 'backup-source', root);
    expect(() => files.consumeMaintenance(7, 'atomic', [{ token: atomic.fileToken, purpose: 'backup-source' }, { token: 'missing-target', purpose: 'restore-target' }])).toThrow('access_denied');
    files.discardMaintenance(7, 'atomic'); expect(() => files.resolveMaintenance(atomic.fileToken, 7, 'atomic', 'backup-source')).toThrow('access_denied');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Main reserves maintenance before asynchronous checks and reads an original receipt before new admission', async () => {
  const { MaintenanceController } = await import('../../apps/desktop/src/main/maintenance-controller');
  const f = fixture();
  try {
    const controller = new MaintenanceController(f.options), context = { operationRef: 'backup-original', windowId: 7 };
    const token = f.files.issueMaintenance(7, context.operationRef, 'backup-destination', f.destination).fileToken;
    f.pendingControl(); const pending = controller.create({ destinationToken: token }, context);
    expect(controller.busy).toBe(true); expect(() => controller.assertWritable()).toThrow('maintenance_busy');
    const denied = await controller.create({ destinationToken: token }, { ...context, operationRef: 'other' });
    expect(denied.ok).toBe(false); f.releaseControl();
    const created = await pending; expect(created).toMatchObject({ ok: true, data: { operationRef: context.operationRef, kind: 'create' } });
    expect(controller.busy).toBe(false); expect(f.stops).toBe(1);
    f.blockWrites(true); expect(await controller.create({ destinationToken: token }, context)).toEqual(created);
    const another = f.files.issueMaintenance(7, 'backup-second', 'backup-destination', f.destination).fileToken;
    expect(await controller.create({ destinationToken: another }, { ...context, operationRef: 'backup-second' })).toMatchObject({ ok: false, error: { code: 'maintenance_busy' } });
    expect(f.stops).toBe(1);
    const selected = controller.selectResult(join(f.destination, 'MedClaw-backup-backup-original'), { operationRef: 'select-result', windowId: 7 });
    expect(selected).toMatchObject({ originalOperationRef: context.operationRef, originalKind: 'create' });
    expect(await controller.read({ resultToken: selected.resultToken!, kind: 'create' }, context)).toEqual(created);
  } finally { f.close(); }
}, 30000);

test('pending production and evaluation admission cannot race a backup before a Run exists', async () => {
  const { MaintenanceController } = await import('../../apps/desktop/src/main/maintenance-controller');
  const f = fixture(); let release!: () => void;
  mkdirSync(join(f.root, 'eval'));
  const gate = new Promise<void>(done => { release = done; });
  let controller!: InstanceType<typeof MaintenanceController>;
  const evaluation = new EvaluationController({ paths: { sourceRoot: resolve(import.meta.dir, '../..'), configsRoot: f.root, runsRoot: join(f.root, 'eval') },
    workerEntry: resolve(import.meta.dir, '../fixtures/p16-main-worker.ts'), bunExecutable: process.execPath, production: f.host,
    maintenanceBusy: () => controller.busy });
  controller = new MaintenanceController({ ...f.options, writesBusy: () => evaluation.admissionPending });
  try {
    const pending = evaluation.withProductionAdmission('session.restore', {}, 'before-run-reservation', async () => { await gate; return 'original-work'; });
    expect(evaluation.admissionPending).toBe(true);
    const context = { operationRef: 'backup-race', windowId: 7 }, destinationToken = f.files.issueMaintenance(7, context.operationRef, 'backup-destination', f.destination).fileToken;
    expect(await controller.create({ destinationToken }, context)).toMatchObject({ ok: false, error: { code: 'maintenance_busy' } });
    expect(f.stops).toBe(0); release(); expect(await pending).toBe('original-work'); expect(evaluation.admissionPending).toBe(false);
    f.pendingControl(); const backup = controller.create({ destinationToken }, context); expect(controller.busy).toBe(true);
    await expect(evaluation.dispatch('eval.start', { datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1, preflightId: crypto.randomUUID() }, crypto.randomUUID())).rejects.toMatchObject({ code: 'maintenance_busy' });
    expect(evaluation.read().operationRef).toBeNull(); f.releaseControl(); expect((await backup).ok).toBe(true);
  } finally { release(); f.releaseControl?.(); await evaluation.shutdown(); await controller.shutdown(); f.close(); }
}, 45000);

test('a credential lease remains a maintenance blocker until its original modification is settled', async () => {
  const f = fixture();
  try {
    const credentials = new MainCredentials(join(f.dataRoot, 'data/credentials.enc.json'), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() });
    credentials.attachInstance('credential-owner');
    const lease = await credentials.begin('credential-owner', { providerId: 'test', context: { purpose: 'runtime', operationRef: 'original-credential' }, expectedCredentialRef: null, operationId: 'original-modify' });
    expect(credentials.busy).toBe(true);
    const { MaintenanceController } = await import('../../apps/desktop/src/main/maintenance-controller');
    const controller = new MaintenanceController({ ...f.options, writesBusy: () => credentials.busy }), context = { operationRef: 'backup-credential', windowId: 7 };
    const destinationToken = f.files.issueMaintenance(7, context.operationRef, 'backup-destination', f.destination).fileToken;
    expect(await controller.create({ destinationToken }, context)).toMatchObject({ ok: false, error: { code: 'maintenance_busy' } }); expect(f.stops).toBe(0);
    await credentials.abort('credential-owner', { leaseId: lease.leaseId }); expect(credentials.busy).toBe(false);
  } finally { f.close(); }
});

test('activation failure preserves the published independent root and retries only its original selection', async () => {
  const { MaintenanceController } = await import('../../apps/desktop/src/main/maintenance-controller');
  const f = fixture();
  try {
    const controller = new MaintenanceController(f.options), backupContext = { operationRef: 'backup-original', windowId: 7 };
    const destinationToken = f.files.issueMaintenance(7, backupContext.operationRef, 'backup-destination', f.destination).fileToken;
    expect((await controller.create({ destinationToken }, backupContext)).ok).toBe(true); f.failedSource();
    const context = { operationRef: 'restore-original', windowId: 7 }, sourceBackup = join(f.destination, 'MedClaw-backup-backup-original');
    const sourceToken = f.files.issueMaintenance(7, context.operationRef, 'backup-source', sourceBackup).fileToken;
    const targetRootToken = f.files.issueMaintenance(7, context.operationRef, 'restore-target', f.targetParent).fileToken;
    const targetRoot = f.files.resolveMaintenance(targetRootToken, 7, context.operationRef, 'restore-target');
    const launch = join(f.selectionRoot, 'launch.json'); mkdirSync(launch);
    expect(await controller.restore({ sourceToken, targetRootToken }, context)).toMatchObject({ ok: false, error: { code: 'restore_failed' } });
    const original = readFileSync(join(targetRoot, 'data/restore-receipt.json'), 'utf8');
    expect(JSON.parse(original).receipt.configVersion).toBe('2'); expect(readFileSync(join(f.dataRoot, 'data/settings.json'), 'utf8')).not.toBe('');
    rmdirSync(launch);
    expect(await controller.restore({ sourceToken, targetRootToken }, context)).toMatchObject({ ok: true, data: { configVersion: '2' } });
    expect(readFileSync(join(targetRoot, 'data/restore-receipt.json'), 'utf8')).toBe(original);
    expect(JSON.parse(readFileSync(launch, 'utf8'))).toEqual({ contract: 'medclaw.launch/v1', activeDataRoot: targetRoot, restoreOperationRef: context.operationRef });
    f.blockWrites(true);
    const reopened = new MaintenanceController({ ...f.options, dataRoot: targetRoot });
    expect(await reopened.restore({ sourceToken, targetRootToken }, context)).toMatchObject({ ok: true, data: { configVersion: '2' } });
    expect(readFileSync(join(targetRoot, 'data/restore-receipt.json'), 'utf8')).toBe(original);
  } finally { f.close(); }
}, 45000);

test('Main result lookup rejects unpublished backup and restore directories without changing the published originals', async () => {
  const { MaintenanceController } = await import('../../apps/desktop/src/main/maintenance-controller');
  const f = fixture(), controller = new MaintenanceController(f.options);
  try {
    const backupContext = { operationRef: 'lookup-backup', windowId: 7 };
    const destinationToken = f.files.issueMaintenance(7, backupContext.operationRef, 'backup-destination', f.destination).fileToken;
    const created = await controller.create({ destinationToken }, backupContext); expect(created.ok).toBe(true);
    const sourceBackup = join(f.destination, 'MedClaw-backup-lookup-backup'), backupTemporary = join(f.destination, '.MedClaw-backup-lookup-backup-unpublished');
    cpSync(sourceBackup, backupTemporary, { recursive: true });
    const context = { operationRef: 'lookup-restore', windowId: 7 };
    const sourceToken = f.files.issueMaintenance(7, context.operationRef, 'backup-source', sourceBackup).fileToken;
    const targetRootToken = f.files.issueMaintenance(7, context.operationRef, 'restore-target', f.targetParent).fileToken;
    const restored = await controller.restore({ sourceToken, targetRootToken }, context); expect(restored.ok).toBe(true);
    const target = f.files.resolveMaintenance(targetRootToken, 7, context.operationRef, 'restore-target');
    const restoreTemporary = join(f.targetParent, '.MedClaw-restore-lookup-restore-unpublished');
    cpSync(target, restoreTemporary, { recursive: true });
    const originalLaunch = readFileSync(join(f.selectionRoot, 'launch.json'));
    f.blockWrites(true);
    for (const [root, kind, original] of [[backupTemporary, 'create', backupContext], [restoreTemporary, 'restore', context]] as const) {
      expect(() => controller.selectResult(root, { operationRef: 'select-result', windowId: 7 })).toThrow('backup_invalid');
      const resultToken = f.files.issueMaintenance(7, original.operationRef, 'backup-result', root).fileToken;
      expect(await controller.read({ resultToken, kind }, original)).toEqual({ ok: true, data: null });
    }
    for (const [root, kind, original, result] of [[sourceBackup, 'create', backupContext, created], [target, 'restore', context, restored]] as const) {
      const selection = controller.selectResult(root, { operationRef: 'select-result', windowId: 7 });
      expect(await controller.read({ resultToken: selection.resultToken!, kind }, original)).toEqual(result);
    }
    expect(readFileSync(join(f.selectionRoot, 'launch.json'))).toEqual(originalLaunch); expect(f.stops).toBe(1);
    expect(existsSync(backupTemporary)).toBe(true); expect(existsSync(restoreTemporary)).toBe(true);
  } finally {
    if (!(await controller.shutdown()).stopped) throw new Error('ENGINEERING lookup worker stop unknown; retained ' + f.root);
    if (realpathSync(f.root) !== resolve(f.root) || !f.root.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING lookup cleanup root changed');
    f.close();
  }
}, 45000);

for (const mode of ['valid', 'valid-error', 'request', 'operation', 'worker', 'protocol', 'action', 'kind', 'receipt-operation', 'domain-error-context',
  'missing-newline', 'duplicate', 'trailing-data', 'bad-utf8', 'oversize', 'nonzero', 'killed', 'wrong-proof-owner', 'wrong-proof-basis'] as const)
test('private maintenance reply correlation and framing: ' + mode, async () => {
  const { requestMaintenance } = await import('../../apps/desktop/src/main/maintenance-controller');
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-maintenance-frame-')), entry = join(root, 'reply-worker.ts');
  const errorsModule = resolve(import.meta.dir, '../../packages/contracts/src/error.ts');
  writeFileSync(entry, `
    import { safeError } from ${JSON.stringify(errorsModule)};
    let buffer = ''; const mode = ${JSON.stringify(mode)};
    process.stdin.on('data', chunk => {
      buffer += chunk.toString(); if (!buffer.includes('\\n')) return;
      const { input, ...identity } = JSON.parse(buffer), now = new Date().toISOString();
      const receipt = { operationRef: identity.operationRef, state: 'completed', appVersion: '0.1.0', schemaVersion: 16, sdkVersion: '0.87.1', kind: 'create', createdAt: now };
      let frame = { ...identity, action: input.action, result: { ok: true, data: null } };
      if (input.action === 'process.checkDomain') frame.result.data = { stopped: true, canPrepareRecovery: false,
        processTreeProof: { instanceId: input.owner.instanceId, basis: 'windows_job_empty', observedAt: now } };
      if (mode === 'request') frame.requestId = 'another-request';
      if (mode === 'operation') frame.operationRef = 'another-operation';
      if (mode === 'worker') frame.workerInstanceId = 'another-worker';
      if (mode === 'protocol') frame.protocolVersion = 'medclaw.maintenance/wrong';
      if (mode === 'action') { frame.action = 'backup.create'; frame.result.data = receipt; }
      if (mode === 'kind') frame.result.data = { ...receipt, kind: 'restore', configVersion: '1', restoredAt: now }; 
      if (mode === 'kind') delete frame.result.data.createdAt;
      if (mode === 'receipt-operation') frame.result.data = { ...receipt, operationRef: 'another-receipt' };
      if (mode === 'valid-error' || mode === 'domain-error-context') frame.result = { ok: false,
        error: safeError('backup_invalid', undefined, { operationRef: mode === 'valid-error' ? identity.operationRef : 'another-error-operation' }) };
      if (mode === 'wrong-proof-owner') frame.result.data.processTreeProof.instanceId = 'another-proof-owner';
      if (mode === 'wrong-proof-basis') frame.result.data.processTreeProof.basis = 'system_restarted';
      let output = JSON.stringify(frame) + '\\n';
      if (mode === 'missing-newline') output = output.slice(0, -1);
      if (mode === 'duplicate') output += output;
      if (mode === 'trailing-data') output += 'late-frame';
      if (mode === 'oversize') output = ' '.repeat(65537) + '\\n';
      if (mode === 'bad-utf8') output = Buffer.from([0xff, 0x0a]);
      process.stdout.write(output, () => {
        if (mode === 'killed') process.kill(process.pid, 'SIGKILL');
        else process.exit(mode === 'nonzero' ? 1 : 0);
      });
    });
  `);
  try {
    const operationRef = 'frame-' + mode;
    const input = mode === 'wrong-proof-owner' || mode === 'wrong-proof-basis'
      ? { action: 'process.checkDomain' as const, owner: { instanceId: 'expected-owner', startupToken: 'expected-token' },
        domain: { contract: 'medclaw.host-job/v1' as const, jobName: 'Local\\MedClaw.expected-owner.expected-token', createdAt: new Date().toISOString() } }
      : { action: 'backup.read' as const, sourceRoot: root, kind: 'create' as const };
    const result = await requestMaintenance({ bunExecutable: process.execPath, maintenanceEntry: entry }, input, operationRef);
    if (mode === 'valid') expect(result).toEqual({ ok: true, data: null });
    else if (mode === 'valid-error') expect(result).toMatchObject({ ok: false, error: { code: 'backup_invalid', operationRef } });
    else if (mode === 'domain-error-context') expect(result).toMatchObject({ ok: false, error: { code: 'backup_invalid', operationRef: 'another-error-operation' } });
    else expect(result).toMatchObject({ ok: false, error: { code: 'host_stop_unconfirmed', operationRef } });
  } finally {
    if (realpathSync(root) !== resolve(root) || !root.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING frame cleanup root changed');
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('a worker that has not established its Job cannot be treated as exited after cancellation and a refused kill', async () => {
  const { MaintenanceController } = await import('../../apps/desktop/src/main/maintenance-controller');
  const f = fixture(), entry = join(f.root, 'pre-job-worker.ts'), reached = join(f.root, 'request-reached'), release = join(f.root, 'release');
  const jobModule = resolve(import.meta.dir, '../../apps/host/src/windows-job.ts');
  writeFileSync(entry, `
    import { createHostJob, inspectStoppedJob } from ${JSON.stringify(jobModule)};
    import { existsSync, writeFileSync } from 'node:fs';
    let buffer = '';
    process.stdin.on('end', () => {});
    process.stdin.on('data', chunk => {
      buffer += chunk.toString(); if (!buffer.includes('\\n')) return;
      const { input, ...identity } = JSON.parse(buffer);
      if (input.action === 'process.checkDomain') {
        createHostJob({ instanceId: identity.workerInstanceId, startupToken: identity.workerInstanceId });
        const proof = inspectStoppedJob(input.owner, input.domain);
        process.stdout.write(JSON.stringify({ ...identity, action: input.action, result: { ok: true,
          data: { stopped: proof !== null, processTreeProof: proof, canPrepareRecovery: false } } }) + '\\n', () => process.exit(0));
      } else {
        writeFileSync(${JSON.stringify(reached)}, 'ENGINEERING original request before Job');
        setInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(0); }, 10);
      }
    });
  `);
  let captured: ChildProcess | undefined, exited: Promise<void> | undefined;
  const kill = ChildProcess.prototype.kill, refusal = spyOn(ChildProcess.prototype, 'kill').mockImplementation(function(this: ChildProcess, signal) {
    if (!this.spawnargs.includes(entry)) return kill.call(this, signal);
    captured = this; exited = new Promise<void>(done => this.once('close', () => done())); return false;
  });
  const controller = new MaintenanceController({ ...f.options, maintenanceEntry: entry });
  const context = { operationRef: 'pre-job-original', windowId: 7 }, destinationToken = f.files.issueMaintenance(7, context.operationRef, 'backup-destination', f.destination).fileToken;
  const pending = controller.create({ destinationToken }, context);
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(reached)) { if (Date.now() > deadline) throw new Error('ENGINEERING pre-Job worker timeout'); await Bun.sleep(10); }
    const shutdown = await controller.shutdown();
    expect(captured).toBeDefined(); expect(captured!.exitCode).toBe(null);
    expect(shutdown).toEqual({ stopped: false });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'host_stop_unconfirmed', operationRef: context.operationRef } });
    expect(controller.busy).toBe(true); await controller.refresh(); expect(controller.busy).toBe(true);
    writeFileSync(release, 'ENGINEERING stop original captured worker'); await exited;
    await controller.refresh(); expect(controller.busy).toBe(false);
  } finally {
    refusal.mockRestore(); writeFileSync(release, 'ENGINEERING cleanup original worker'); await pending; await exited;
    if (!captured || captured.exitCode === null || !(await controller.shutdown()).stopped) throw new Error('ENGINEERING pre-Job stop unknown; retained ' + f.root);
    if (realpathSync(f.root) !== resolve(f.root) || !f.root.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING pre-Job cleanup root changed');
    f.close();
  }
}, 45000);

test('an unknown worker result keeps maintenance blocked until its owned Job is independently confirmed empty', async () => {
  const { MaintenanceController } = await import('../../apps/desktop/src/main/maintenance-controller');
  const f = fixture(), entry = join(f.root, 'fault-worker.ts');
  const jobModule = resolve(import.meta.dir, '../../apps/host/src/windows-job.ts');
  writeFileSync(entry, `
    import { createHostJob, inspectStoppedJob } from ${JSON.stringify(jobModule)};
    let input = '';
    process.stdin.on('data', chunk => {
      input += chunk.toString(); if (!input.includes('\\n')) return;
      const request = JSON.parse(input), owner = { instanceId: request.workerInstanceId, startupToken: request.workerInstanceId };
      createHostJob(owner);
      if (request.input.action !== 'process.checkDomain') { process.stdout.write('ENGINEERING invalid frame\\n', () => process.exit(0)); return; }
      const proof = inspectStoppedJob(request.input.owner, request.input.domain), { input: ignored, ...identity } = request;
      process.stdout.write(JSON.stringify({ ...identity, action: 'process.checkDomain', result: { ok: true, data: { stopped: proof !== null, processTreeProof: proof, canPrepareRecovery: false } } }) + '\\n', () => process.exit(0));
    });
  `);
  try {
    const controller = new MaintenanceController({ ...f.options, maintenanceEntry: entry }), context = { operationRef: 'unknown-result', windowId: 7 };
    const destinationToken = f.files.issueMaintenance(7, context.operationRef, 'backup-destination', f.destination).fileToken;
    expect(await controller.create({ destinationToken }, context)).toMatchObject({ ok: false, error: { code: 'host_stop_unconfirmed' } });
    expect(controller.busy).toBe(true); expect(() => controller.assertWritable()).toThrow('maintenance_busy');
    await controller.refresh(); expect(controller.busy).toBe(false);
  } finally { f.close(); }
}, 30000);

for (const kind of ['create', 'restore'] as const) test(`a valid ${kind} reply and exited worker cannot release maintenance while its real Job member remains`, async () => {
  const { MaintenanceController } = await import('../../apps/desktop/src/main/maintenance-controller');
  const { inspectStoppedJob } = await import('../../apps/host/src/windows-job');
  const f = fixture(), entry = join(f.root, 'late-member-worker.ts'), ownerPath = join(f.root, 'worker-owner.json');
  const reached = join(f.root, 'job-count-read'), release = join(f.root, 'release-worker');
  const jobModule = resolve(import.meta.dir, '../../apps/host/src/windows-job.ts'), originalEntry = f.options.maintenanceEntry;
  writeFileSync(entry, `
    import { spyOn } from 'bun:test';
    import * as jobs from ${JSON.stringify(jobModule)};
    import { existsSync, writeFileSync } from 'node:fs';
    const create = jobs.createHostJob;
    spyOn(jobs, 'createHostJob').mockImplementation(owner => {
      const job = create(owner);
      if (!existsSync(${JSON.stringify(ownerPath)})) writeFileSync(${JSON.stringify(ownerPath)}, JSON.stringify({ ...owner, domain: job.domain }));
      return { ...job, readActiveProcesses() {
        const count = job.readActiveProcesses();
        if (!existsSync(${JSON.stringify(reached)})) {
          writeFileSync(${JSON.stringify(reached)}, String(count));
          while (!existsSync(${JSON.stringify(release)})) Bun.sleepSync(10);
        }
        return count;
      } };
    });
    await import(${JSON.stringify(originalEntry)});
  `);
  const native = dlopen(join(process.env.SystemRoot!, 'System32/kernel32.dll'), {
    OpenJobObjectW: { args: ['u32', 'bool', 'ptr'], returns: 'u64' }, OpenProcess: { args: ['u32', 'bool', 'u32'], returns: 'u64' },
    AssignProcessToJobObject: { args: ['u64', 'u64'], returns: 'bool' }, CloseHandle: { args: ['u64'], returns: 'bool' },
  });
  let handle: number | bigint = 0, member: ReturnType<typeof Bun.spawn> | undefined;
  let owner: { instanceId: string; startupToken: string; domain: HostJobDomain } | undefined;
  let controller: InstanceType<typeof MaintenanceController> | undefined, pending: Promise<unknown> | undefined;
  try {
    const backupContext = { operationRef: 'late-backup-original', windowId: 7 };
    const destinationToken = f.files.issueMaintenance(7, backupContext.operationRef, 'backup-destination', f.destination).fileToken;
    if (kind === 'restore') {
      const preparer = new MaintenanceController(f.options);
      expect((await preparer.create({ destinationToken }, backupContext)).ok).toBe(true);
      expect(await preparer.shutdown()).toEqual({ stopped: true }); f.failedSource();
    }
    controller = new MaintenanceController({ ...f.options, maintenanceEntry: entry });
    const context = { operationRef: kind === 'create' ? backupContext.operationRef : 'late-restore-original', windowId: 7 };
    const sourceBackup = join(f.destination, 'MedClaw-backup-' + backupContext.operationRef);
    const sourceToken = kind === 'restore' ? f.files.issueMaintenance(7, context.operationRef, 'backup-source', sourceBackup).fileToken : 'unused-create-source';
    const targetRootToken = f.files.issueMaintenance(7, context.operationRef, 'restore-target', f.targetParent).fileToken;
    const targetRoot = f.files.resolveMaintenance(targetRootToken, 7, context.operationRef, 'restore-target');
    const input = { sourceToken, targetRootToken }, originalSettings = readFileSync(join(f.dataRoot, 'data/settings.json'), 'utf8');
    pending = kind === 'create' ? controller.create({ destinationToken }, context) : controller.restore(input, context);
    const deadline = Date.now() + 10000;
    while (!existsSync(reached)) { if (Date.now() > deadline) throw new Error('ENGINEERING worker barrier timeout'); await Bun.sleep(10); }
    expect(readFileSync(reached, 'utf8')).toBe('1');
    owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    const name = Buffer.from(owner!.domain.jobName + '\0', 'utf16le');
    handle = native.symbols.OpenJobObjectW(4 | 1, false, ptr(name)); expect(BigInt(handle)).not.toBe(0n);
    member = Bun.spawn([process.execPath, '--no-env-file', '-e', 'setInterval(()=>{},1000)'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    const processHandle = native.symbols.OpenProcess(0x100 | 1, false, member.pid); expect(BigInt(processHandle)).not.toBe(0n);
    try { expect(native.symbols.AssignProcessToJobObject(handle, processHandle)).toBe(true); }
    finally { native.symbols.CloseHandle(processHandle); }
    writeFileSync(release, 'ENGINEERING release after the actual Job count');
    expect(await pending).toMatchObject({ ok: false, error: { code: 'host_stop_unconfirmed', operationRef: context.operationRef } });
    expect(member.exitCode).toBe(null); expect(inspectStoppedJob(owner!, owner!.domain)).toBe(null);
    expect(controller.busy).toBe(true); await controller.refresh(); expect(controller.busy).toBe(true);
    const receiptPath = kind === 'create' ? join(sourceBackup, 'receipt.json') : join(targetRoot, 'data/restore-receipt.json');
    const receiptBytes = readFileSync(receiptPath, 'utf8'), receipt = JSON.parse(receiptBytes).receipt;
    expect(receipt).toMatchObject({ kind, operationRef: context.operationRef, state: 'completed' });
    expect(existsSync(join(f.selectionRoot, 'launch.json'))).toBe(false);
    expect(readFileSync(join(f.dataRoot, 'data/settings.json'), 'utf8')).toBe(originalSettings);
    member.kill(); await member.exited;
    await controller.refresh(); expect(controller.busy).toBe(false);
    const retried = kind === 'create' ? await controller.create({ destinationToken }, context) : await controller.restore(input, context);
    expect(retried).toEqual({ ok: true, data: receipt }); expect(readFileSync(receiptPath, 'utf8')).toBe(receiptBytes);
    if (kind === 'restore') expect(JSON.parse(readFileSync(join(f.selectionRoot, 'launch.json'), 'utf8'))).toMatchObject({ activeDataRoot: targetRoot, restoreOperationRef: context.operationRef });
  } finally {
    writeFileSync(release, 'ENGINEERING cleanup release');
    if (member) { member.kill(); await member.exited; }
    await pending;
    if (handle) native.symbols.CloseHandle(handle);
    const stopped = controller ? (await controller.shutdown()).stopped : false;
    if (!stopped || !owner || !inspectStoppedJob(owner, owner.domain)) throw new Error('ENGINEERING worker stop unknown; retained ' + f.root);
    native.close();
    if (realpathSync(f.root) !== resolve(f.root) || !f.root.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING maintenance cleanup root changed');
    f.close();
  }
}, 45000);

test('actual Windows write denial preserves old backups and roots while a read-only installation still permits backup', async () => {
  const { MaintenanceController } = await import('../../apps/desktop/src/main/maintenance-controller');
  const f = fixture(), controller = new MaintenanceController(f.options), saved: { path: string; sddl: string }[] = [];
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $root = [IO.Path]::GetFullPath($request.root).TrimEnd('\\')
    $target = (Resolve-Path -LiteralPath $request.path).ProviderPath
    if (!$target.StartsWith($root + '\\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Outside owned test root' }
    $acl = [IO.Directory]::GetAccessControl($target)
    if ($request.action -eq 'deny') {
      $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $rule = [Security.AccessControl.FileSystemAccessRule]::new($user, [Security.AccessControl.FileSystemRights]::Write,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny)
      [void]$acl.AddAccessRule($rule)
      [IO.Directory]::SetAccessControl($target, $acl)
    } elseif ($request.action -eq 'restore') {
      $acl.SetSecurityDescriptorSddlForm($request.sddl, [Security.AccessControl.AccessControlSections]::Access)
      [IO.Directory]::SetAccessControl($target, $acl)
    } elseif ($request.action -ne 'read') { throw 'Unknown test operation' }
    @{sddl=([IO.Directory]::GetAccessControl($target)).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)} | ConvertTo-Json -Compress
  `;
  const acl = async (path: string, action: 'read' | 'deny' | 'restore', sddl?: string): Promise<string> => {
    if (realpathSync(f.root) !== resolve(f.root) || realpathSync(path) !== resolve(path) || !path.startsWith(f.root + sep)) throw new Error('ENGINEERING ACL root changed');
    const child = Bun.spawn([join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), '-NoLogo', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const timeout = setTimeout(() => child.kill(), 15000);
    try {
      child.stdin.write(JSON.stringify({ root: f.root, path, action, sddl })); child.stdin.end();
      const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (await child.exited !== 0) throw new Error('ENGINEERING native ACL command failed at ' + action + ': ' + error);
      return (JSON.parse(output) as { sddl: string }).sddl;
    } finally { clearTimeout(timeout); }
  };
  const deny = async (path: string) => {
    saved.push({ path, sddl: await acl(path, 'read') }); await acl(path, 'deny');
    expect(() => writeFileSync(join(path, 'ENGINEERING-write-probe'), 'must be denied')).toThrow(/EACCES|EPERM/);
  };
  const restore = async () => {
    const previous = saved.at(-1)!; expect(await acl(previous.path, 'restore', previous.sddl)).toBe(previous.sddl); saved.pop();
  };
  try {
    const originalContext = { operationRef: 'acl-original', windowId: 7 }, destination = (operationRef: string) => f.files.issueMaintenance(7, operationRef, 'backup-destination', f.destination).fileToken;
    const original = await controller.create({ destinationToken: destination(originalContext.operationRef) }, originalContext); expect(original.ok).toBe(true);
    const sourceBackup = join(f.destination, 'MedClaw-backup-acl-original'), receiptBytes = readFileSync(join(sourceBackup, 'receipt.json'));
    const database = readFileSync(join(f.dataRoot, 'data/app.sqlite')), settings = readFileSync(join(f.dataRoot, 'data/settings.json'));
    await deny(f.destination);
    expect(await controller.create({ destinationToken: destination('acl-backup-denied') }, { operationRef: 'acl-backup-denied', windowId: 7 }))
      .toMatchObject({ ok: false, error: { code: 'backup_write_failed' } });
    expect(controller.busy).toBe(false); expect(existsSync(join(f.destination, 'MedClaw-backup-acl-backup-denied'))).toBe(false); await restore();
    await deny(f.targetParent);
    const context = { operationRef: 'acl-restore-denied', windowId: 7 };
    const sourceToken = f.files.issueMaintenance(7, context.operationRef, 'backup-source', sourceBackup).fileToken;
    const targetRootToken = f.files.issueMaintenance(7, context.operationRef, 'restore-target', f.targetParent).fileToken;
    expect(await controller.restore({ sourceToken, targetRootToken }, context)).toMatchObject({ ok: false, error: { code: 'restore_failed' } });
    expect(controller.busy).toBe(false); expect(existsSync(f.files.resolveMaintenance(targetRootToken, 7, context.operationRef, 'restore-target'))).toBe(false);
    expect(existsSync(join(f.selectionRoot, 'launch.json'))).toBe(false); await restore();
    const installation = dirname(f.options.installManifestPath), manifest = readFileSync(f.options.installManifestPath); await deny(installation);
    expect(await controller.create({ destinationToken: destination('acl-install-readonly') }, { operationRef: 'acl-install-readonly', windowId: 7 }))
      .toMatchObject({ ok: true, data: { state: 'completed' } });
    expect(readFileSync(f.options.installManifestPath)).toEqual(manifest); await restore();
    expect(readFileSync(join(sourceBackup, 'receipt.json'))).toEqual(receiptBytes);
    expect(readFileSync(join(f.dataRoot, 'data/app.sqlite'))).toEqual(database); expect(readFileSync(join(f.dataRoot, 'data/settings.json'))).toEqual(settings);
  } finally {
    while (saved.length) await restore();
    if (!(await controller.shutdown()).stopped) throw new Error('ENGINEERING ACL worker stop unknown; retained ' + f.root);
    if (realpathSync(f.root) !== resolve(f.root) || !f.root.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING ACL cleanup root changed');
    f.close();
  }
}, 60000);

for (const kind of ['create', 'restore'] as const)
for (const phase of ['payload-sync', 'before-publish', 'after-publish'] as const)
for (const fault of ['kill', 'cancel', 'disconnect'] as const)
test(`real ${kind} worker preserves commit facts at ${phase} after ${fault}`, async () => {
  const { MaintenanceController } = await import('../../apps/desktop/src/main/maintenance-controller');
  const { inspectStoppedJob } = await import('../../apps/host/src/windows-job');
  const f = fixture(), operationRef = `window-${kind}-${phase}-${fault}`, context = { operationRef, windowId: 7 };
  const entry = join(f.root, 'publication-worker.ts'), reached = join(f.root, 'reached.json'), control = join(f.root, 'control'), release = join(f.root, 'release');
  const ownerPath = join(f.root, 'owner.json'), aborted = join(f.root, 'aborted');
  const jobModule = resolve(import.meta.dir, '../../apps/host/src/windows-job.ts'), publishModule = resolve(import.meta.dir, '../../packages/storage/src/publish-no-replace.ts');
  const sourceBackup = join(f.destination, 'MedClaw-backup-' + (kind === 'create' ? operationRef : 'window-source-original'));
  const targetRoot = kind === 'create' ? sourceBackup : join(f.targetParent, 'MedClaw-restored-' + operationRef);
  writeFileSync(entry, `
    import { spyOn } from 'bun:test';
    import * as jobs from ${JSON.stringify(jobModule)};
    import * as publication from ${JSON.stringify(publishModule)};
    import * as files from 'node:fs/promises';
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { basename, dirname, join } from 'node:path';
    process.stdin.on('end', () => queueMicrotask(() => writeFileSync(${JSON.stringify(aborted)}, 'ENGINEERING original maintenance input ended')));
    const phase = ${JSON.stringify(phase)}, target = ${JSON.stringify(targetRoot)};
    const reached = ${JSON.stringify(reached)}, control = ${JSON.stringify(control)}, release = ${JSON.stringify(release)};
    const createJob = jobs.createHostJob;
    spyOn(jobs, 'createHostJob').mockImplementation(owner => {
      const job = createJob(owner);
      if (!existsSync(${JSON.stringify(ownerPath)})) writeFileSync(${JSON.stringify(ownerPath)}, JSON.stringify({ ...owner, domain: job.domain }));
      return job;
    });
    async function barrier(temporary, signal) {
      if (existsSync(reached)) return;
      signal?.addEventListener('abort', () => writeFileSync(${JSON.stringify(aborted)}, 'ENGINEERING original storage signal'), { once: true });
      writeFileSync(reached, JSON.stringify({ temporary, target }));
      const deadline = Date.now() + 30000;
      while (!existsSync(release)) {
        if (Date.now() > deadline) process.exit(45);
        const command = existsSync(control) ? readFileSync(control, 'utf8') : '';
        if (command === 'kill') process.kill(process.pid, 'SIGKILL');
        await Bun.sleep(10);
      }
    }
    if (phase === 'payload-sync') {
      const open = files.open;
      spyOn(files, 'open').mockImplementation(async (...args) => {
        const file = await Reflect.apply(open, files, args), path = String(args[0]), temporary = dirname(dirname(path));
        if (args[1] === 'wx' && basename(path) === 'settings.json'
          && basename(temporary).startsWith(${JSON.stringify('.MedClaw-' + (kind === 'create' ? 'backup-' : 'restore-') + operationRef + '-')})) {
          const sync = file.sync.bind(file);
          file.sync = async () => { await barrier(temporary); return sync(); };
        }
        return file;
      });
    } else {
      const publish = publication.publishNoReplace;
      spyOn(publication, 'publishNoReplace').mockImplementation(async (source, destination, type, signal) => {
        if (destination !== target || type !== 'directory' || existsSync(reached)) return publish(source, destination, type, signal);
        if (phase === 'before-publish') await barrier(source, signal);
        const result = await publish(source, destination, type, signal);
        if (phase === 'after-publish') await barrier(source, signal);
        return result;
      });
    }
    await import(${JSON.stringify(f.options.maintenanceEntry)});
  `);
  let controller: InstanceType<typeof MaintenanceController> | undefined, pending: Promise<unknown> | undefined;
  let captured: ChildProcess | undefined;
  // Preserve spawn's overloads; every call delegates unchanged to the native implementation.
  const spawn = childProcesses.spawn, capture = spyOn(childProcesses, 'spawn').mockImplementation(((...args: Parameters<typeof childProcesses.spawn>) => {
    const child: ChildProcess = Reflect.apply(spawn, childProcesses, args);
    if (Array.isArray(args[1]) && args[1].includes(entry)) captured = child;
    return child;
  }) as typeof childProcesses.spawn);
  let owner: { instanceId: string; startupToken: string; domain: HostJobDomain } | undefined;
  const waitFor = async (check: () => boolean, label: string) => {
    const deadline = Date.now() + 15000;
    while (!check()) { if (Date.now() > deadline) throw new Error('ENGINEERING publication window timeout: ' + label); await Bun.sleep(10); }
  };
  try {
    const database = new Database(join(f.dataRoot, 'data/app.sqlite'), { strict: true }), repositories = new Repositories(database), native = memoryNativeFixture();
    let artifactId: number;
    try {
      const session = repositories.createSession({ expectedWorkspaceRevision: 0 }, 'window-session', native.header.id, '2026-10-17T00:00:00.000Z',
        { header: native.header, entries: [], activeLeafId: null }).session;
      const memory = await new SqliteMemoryStore(database, validateNativeHistory).commit({ sessionId: session.id, runId: null, expectedStorageVersion: 1,
        header: native.header, newEntries: native.entries, activeLeafId: native.activeLeafId });
      if (!memory.ok) throw memory.error;
      const saved = seedWorkspaceQueries(database, repositories);
      database.query("INSERT INTO answers(run_id,session_id,input_id,kind,text,query_ids_json,missing_slots_json,native_leaf_id,created_at) VALUES(10,1,NULL,'result','ENGINEERING saved before interruption',?,'[]',?,?)")
        .run(JSON.stringify([saved.current.id]), native.activeLeafId, '2026-10-17T00:00:00.000Z');
      artifactId = new SqliteImportStore(database).begin({ operationRef: 'window-artifact', fileToken: 'fixture', mappingVersion: 'medclaw.snapshot/v1' }, 'fixture').operation.artifactId!;
    } finally { database.close(); }
    const artifactRelative = `artifacts/${artifactId}/input/partial.csv`, artifactPath = join(f.dataRoot, artifactRelative);
    mkdirSync(join(f.dataRoot, `artifacts/${artifactId}/input`), { recursive: true }); writeFileSync(artifactPath, 'ENGINEERING original reserved artifact');
    if (kind === 'restore') {
      const preparer = new MaintenanceController(f.options), sourceContext = { operationRef: 'window-source-original', windowId: 7 };
      const destinationToken = f.files.issueMaintenance(7, sourceContext.operationRef, 'backup-destination', f.destination).fileToken;
      expect((await preparer.create({ destinationToken }, sourceContext)).ok).toBe(true); expect(await preparer.shutdown()).toEqual({ stopped: true });
      f.failedSource();
    }
    const sourceSettings = readFileSync(join(f.dataRoot, 'data/settings.json')), sourceDatabase = readFileSync(join(f.dataRoot, 'data/app.sqlite'));
    const destinationToken = f.files.issueMaintenance(7, operationRef, 'backup-destination', f.destination).fileToken;
    const sourceToken = kind === 'restore' ? f.files.issueMaintenance(7, operationRef, 'backup-source', sourceBackup).fileToken : 'unused-create-source';
    const targetRootToken = f.files.issueMaintenance(7, operationRef, 'restore-target', f.targetParent).fileToken;
    controller = new MaintenanceController({ ...f.options, maintenanceEntry: entry });
    pending = kind === 'create' ? controller.create({ destinationToken }, context) : controller.restore({ sourceToken, targetRootToken }, context);
    await waitFor(() => existsSync(reached), 'actual storage barrier');
    owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    const location = JSON.parse(readFileSync(reached, 'utf8')) as { temporary: string; target: string };
    expect(location.target).toBe(targetRoot); expect(controller.busy).toBe(true); expect(inspectStoppedJob(owner!, owner!.domain)).toBeNull();
    const receiptRelative = kind === 'create' ? 'receipt.json' : 'data/restore-receipt.json';
    expect(existsSync(targetRoot)).toBe(phase === 'after-publish');
    expect(existsSync(join(phase === 'after-publish' ? targetRoot : location.temporary, receiptRelative))).toBe(phase !== 'payload-sync');
    const unpublishedReceipt = phase === 'before-publish' ? readFileSync(join(location.temporary, receiptRelative)) : null;
    expect(existsSync(join(f.selectionRoot, 'launch.json'))).toBe(false);
    const forbidden = join(f.root, 'unadmitted-write'), mutate = async () => { writeFileSync(forbidden, 'must not be written'); return 'must not run'; };
    await expect(controller.withWrite(mutate)).rejects.toThrow('maintenance_busy'); expect(existsSync(forbidden)).toBe(false);
    let shutdown: Promise<{ stopped: boolean }> | undefined;
    if (fault === 'cancel') {
      shutdown = controller.shutdown();
      await waitFor(() => existsSync(aborted), 'Main cancellation reached the original maintenance input');
      expect(controller.busy).toBe(true); writeFileSync(release, 'ENGINEERING release after cancellation');
    } else if (fault === 'disconnect') {
      if (!captured?.stdout) throw new Error('ENGINEERING original worker stdout was not captured');
      // Close Main's reader, preserving the worker's runtime-owned handles while the actual operation continues.
      const disconnected = new Promise<void>(done => captured!.stdout!.once('close', done)); captured.stdout.destroy(); await disconnected;
      expect(captured.stdout.destroyed).toBe(true); expect(captured.exitCode).toBeNull();
      expect(controller.busy).toBe(true); expect(inspectStoppedJob(owner!, owner!.domain)).toBeNull();
      await expect(controller.withWrite(mutate)).rejects.toThrow('maintenance_busy'); expect(existsSync(forbidden)).toBe(false);
      writeFileSync(release, 'ENGINEERING let original operation finish without a reply');
    } else writeFileSync(control, 'kill');
    expect(await pending).toMatchObject({ ok: false, error: { code: 'host_stop_unconfirmed', operationRef } });
    if (shutdown) expect(await shutdown).toEqual({ stopped: true });
    else { expect(controller.busy).toBe(true); await waitFor(() => inspectStoppedJob(owner!, owner!.domain) !== null, 'owned worker tree stopped'); await controller.refresh(); }
    expect(controller.busy).toBe(false); expect(existsSync(join(f.selectionRoot, 'launch.json'))).toBe(false);
    const committed = phase === 'after-publish' || fault === 'disconnect';
    expect(existsSync(targetRoot)).toBe(committed);
    const receiptBytes = committed ? readFileSync(join(targetRoot, receiptRelative), 'utf8') : null;
    if (!committed && fault === 'kill') {
      expect(existsSync(location.temporary)).toBe(true);
      expect(() => controller!.selectResult(location.temporary, { operationRef: 'read-unpublished', windowId: 7 })).toThrow('backup_invalid');
    }
    if (!committed && fault === 'cancel') expect(existsSync(location.temporary)).toBe(false);
    expect(readFileSync(join(f.dataRoot, 'data/settings.json'))).toEqual(sourceSettings); expect(readFileSync(join(f.dataRoot, 'data/app.sqlite'))).toEqual(sourceDatabase);
    expect(readFileSync(artifactPath, 'utf8')).toBe('ENGINEERING original reserved artifact');
    const explicit = kind === 'create' ? await controller.create({ destinationToken }, context) : await controller.restore({ sourceToken, targetRootToken }, context);
    expect(explicit).toMatchObject({ ok: true, data: { operationRef, kind, state: 'completed' } });
    const finalReceipt = readFileSync(join(targetRoot, receiptRelative), 'utf8');
    if (receiptBytes !== null) expect(finalReceipt).toBe(receiptBytes);
    if (!committed && fault === 'kill') {
      expect(existsSync(location.temporary)).toBe(true);
      if (unpublishedReceipt !== null) expect(readFileSync(join(location.temporary, receiptRelative))).toEqual(unpublishedReceipt);
    }
    if (kind === 'restore') {
      expect(JSON.parse(finalReceipt).receipt.configVersion).toBe('2');
      expect(JSON.parse(readFileSync(join(f.selectionRoot, 'launch.json'), 'utf8'))).toMatchObject({ activeDataRoot: targetRoot, restoreOperationRef: operationRef });
    }
    expect(readFileSync(join(targetRoot, artifactRelative), 'utf8')).toBe('ENGINEERING original reserved artifact');
    const selected = controller.selectResult(targetRoot, { operationRef: 'read-original', windowId: 7 });
    expect(await controller.read({ resultToken: selected.resultToken!, kind }, context)).toEqual(explicit);
    expect(readFileSync(join(f.dataRoot, 'data/settings.json'))).toEqual(sourceSettings); expect(readFileSync(join(f.dataRoot, 'data/app.sqlite'))).toEqual(sourceDatabase);
  } finally {
    capture.mockRestore();
    writeFileSync(control, 'kill');
    if (!existsSync(reached)) writeFileSync(release, 'ENGINEERING cleanup without an established barrier');
    await pending;
    if (!controller || !(await controller.shutdown()).stopped || !owner || !inspectStoppedJob(owner, owner.domain)) throw new Error('ENGINEERING publication worker stop unknown; retained ' + f.root);
    if (realpathSync(f.root) !== resolve(f.root) || !f.root.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING publication cleanup root changed');
    f.close();
  }
}, 60000);

for (const completion of ['release', 'cancel', 'disconnect'] as const) test('a complete maintenance frame waits for actual exit: ' + completion, async () => {
  const { requestMaintenance } = await import('../../apps/desktop/src/main/maintenance-controller');
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-maintenance-close-')), entry = join(root, 'reply-worker.ts');
  const sent = join(root, 'frame-written'), release = join(root, 'release'), exited = join(root, 'exit-observed');
  writeFileSync(entry, `
    import { existsSync, writeFileSync } from 'node:fs';
    process.on('exit', () => writeFileSync(${JSON.stringify(exited)}, 'ENGINEERING exit'));
    process.stdin.on('end', () => process.exit(0));
    let buffer = '';
    process.stdin.on('data', async chunk => {
      buffer += chunk.toString(); if (!buffer.includes('\\n')) return;
      const { input, ...identity } = JSON.parse(buffer);
      await new Promise(done => process.stdout.write(JSON.stringify({ ...identity, action: input.action, result: { ok: true, data: null } }) + '\\n', done));
      if (${JSON.stringify(completion)} === 'disconnect') await new Promise(done => process.stdout.end(done));
      writeFileSync(${JSON.stringify(sent)}, 'ENGINEERING frame flushed');
      while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
      process.exit(0);
    });
  `);
  const abort = new AbortController(), operationRef = 'close-' + completion;
  const pending = requestMaintenance({ bunExecutable: process.execPath, maintenanceEntry: entry, signal: abort.signal },
    { action: 'backup.read', sourceRoot: root, kind: 'create' }, operationRef);
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(sent)) { if (Date.now() > deadline) throw new Error('ENGINEERING maintenance frame timeout'); await Bun.sleep(10); }
    expect(await Promise.race([pending.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false);
    if (completion === 'cancel') abort.abort(); else writeFileSync(release, 'ENGINEERING explicit exit');
    if (completion === 'cancel') expect(await pending).toMatchObject({ ok: false, error: { code: 'host_stop_unconfirmed', operationRef } });
    else expect(await pending).toEqual({ ok: true, data: null });
    expect(existsSync(exited)).toBe(true);
  } finally {
    writeFileSync(release, 'ENGINEERING cleanup exit'); await pending;
    if (!existsSync(exited)) throw new Error('ENGINEERING maintenance exit unknown; retained ' + root);
    if (realpathSync(root) !== resolve(root) || !root.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING close cleanup root changed');
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
