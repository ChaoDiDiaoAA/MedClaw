import { expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { dlopen, ptr } from 'bun:ffi';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as filesystem from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteMemoryStore } from '../../packages/storage/src/memory-store';
import { validateNativeHistory } from '../../packages/runtime-pi/src/memory-store';
import { memoryNativeFixture } from '../fixtures/p9-memory';
import { MainSettings } from '../../apps/desktop/src/main/settings';
import { SqliteImportStore } from '../../packages/storage/src/import-store';
import { ArtifactStore } from '../../packages/storage/src/artifact-store';
import { SqliteExportStore } from '../../packages/storage/src/export-store';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MaintenanceController } from '../../apps/desktop/src/main/maintenance-controller';
import { FileTokens } from '../../apps/desktop/src/main/file-tokens';
import type { PublishedSettings } from '../../packages/contracts/src/model';
import type { HostJobDomain } from '../../packages/contracts/src/maintenance';

// Storage-only snapshot tests inject a lease; the private-worker test exercises the real Windows lease.
const controlledTemporaryLease = async () => ({ release() {} });

async function backupFixture(withQuery = false) {
  const directory = mkdtempSync(join(tmpdir(), 'medclaw-p17-备份 路径-')), sourceRoot = join(directory, 'source'), destinationRoot = join(directory, 'backups');
  mkdirSync(join(sourceRoot, 'data'), { recursive: true }); mkdirSync(destinationRoot);
  const database = openDatabase(join(sourceRoot, 'data/app.sqlite')), memory = new SqliteMemoryStore(database, validateNativeHistory), repo = new Repositories(database);
  const native = memoryNativeFixture(), at = '2026-10-17T00:00:00.000Z';
  const session = repo.createSession({ expectedWorkspaceRevision: 0 }, 'create', native.header.id, at, { header: native.header, entries: [], activeLeafId: null }).session;
  const committed = await memory.commit({ sessionId: session.id, runId: null, expectedStorageVersion: 1, header: native.header, newEntries: native.entries, activeLeafId: native.activeLeafId });
  if (!committed.ok) throw committed.error;
  const query = withQuery ? seedWorkspaceQueries(database, repo).current : null;
  const importState = new SqliteImportStore(database).begin({ operationRef: 'reserved-original', fileToken: 'fixture', mappingVersion: 'medclaw.snapshot/v1' }, 'fixture');
  const artifactId = importState.operation.artifactId!;
  mkdirSync(join(sourceRoot, `artifacts/${artifactId}/input`), { recursive: true }); writeFileSync(join(sourceRoot, `artifacts/${artifactId}/input/partial.csv`), 'ENGINEERING incomplete content');
  const settings = new MainSettings(join(sourceRoot, 'data/settings.json')).read();
  writeFileSync(join(sourceRoot, 'data/settings.json'), JSON.stringify({ ...settings, configVersion: '9007199254740993', credentialRefs: { openai: 'secret-ref' } }));
  writeFileSync(join(sourceRoot, 'data/credentials.enc.json'), 'DO NOT BACK UP');
  mkdirSync(join(directory, 'installation')); const installManifestPath = join(directory, 'installation/install.json');
  writeFileSync(installManifestPath, JSON.stringify({ contract: 'medclaw.install/v1', appVersion: '0.1.0', platform: 'win32', arch: 'x64', sdkVersion: '0.87.1', bunVersion: '1.4.0', electronVersion: '44.5.1', protocolVersion: 'medclaw.host/p17-v2', schemaVersion: 16,
    hostEntry: 'runtime/apps/host/src/main.ts', maintenanceEntry: 'runtime/apps/host/src/maintenance.ts', resourceRoot: 'runtime/resources', resources: [], plugins: [], binaries: [{ name: 'bun', version: '1.4.0', source: 'ENGINEERING fixture', path: 'bin/bun.exe' }] }));
  const input = { operationRef: 'backup-original', sourceRoot, destinationRoot, installManifestPath, validateHistory: validateNativeHistory };
  return { directory, sourceRoot, destinationRoot, database, memory, repo, session, artifactId, query, input, close() { database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function seedStandaloneAnswer(f: Awaited<ReturnType<typeof backupFixture>>) {
  const leaf = f.database.query<{ current_leaf_id: string }, [number]>('SELECT current_leaf_id FROM sessions WHERE id=?').get(f.session.id)!.current_leaf_id;
  f.database.query("INSERT INTO answers(run_id,session_id,input_id,kind,text,query_ids_json,missing_slots_json,native_leaf_id,created_at) VALUES(?,?,NULL,'result','Standalone saved answer',?,'[]',?,?)")
    .run(f.query!.runId, f.session.id, JSON.stringify([f.query!.id]), leaf, '2026-10-17T00:00:00.000Z');
  f.database.query('UPDATE runs SET cleanup_json=? WHERE id=?').run(JSON.stringify({ contract: 'medclaw.run-cleanup/v1', executionStarted: false,
    stopConfirmed: true, requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: true,
    unconfirmedItems: [], secondaryErrors: [], verifiedAt: '2026-10-17T00:00:00.000Z' }), f.query!.runId);
  return f.query!.runId;
}

test('unpublished backup and restore receipts are not completed results or valid restore sources', async () => {
  const { createBackup, restoreBackup, readBackup, readRestore } = await import('../../packages/storage/src/backup');
  const f = await backupFixture(), signal = new AbortController().signal;
  try {
    const created = await createBackup(f.input, signal), sourceBackup = join(f.destinationRoot, 'MedClaw-backup-backup-original');
    const temporary = join(f.destinationRoot, '.MedClaw-backup-backup-original-unpublished'); cpSync(sourceBackup, temporary, { recursive: true });
    expect(await readBackup(temporary, f.input.operationRef)).toBeNull();
    const input = { operationRef: 'restore-published', sourceBackup: temporary, targetRoot: join(f.directory, 'restored'),
      installManifestPath: f.input.installManifestPath, validateHistory: validateNativeHistory, leaseTemporaryRoot: controlledTemporaryLease };
    await expect(restoreBackup(input, signal)).rejects.toThrow('backup_invalid'); expect(existsSync(input.targetRoot)).toBe(false);
    const restored = await restoreBackup({ ...input, sourceBackup }, signal);
    const restoreTemporary = join(f.directory, '.MedClaw-restore-restore-published-unpublished'); cpSync(input.targetRoot, restoreTemporary, { recursive: true });
    expect(await readRestore(restoreTemporary, input.operationRef)).toBeNull();
    expect(await readBackup(sourceBackup, f.input.operationRef)).toEqual(created); expect(await readRestore(input.targetRoot, input.operationRef)).toEqual(restored);
    const moved = join(f.directory, 'external-copy', 'MedClaw-backup-backup-original'); cpSync(sourceBackup, moved, { recursive: true });
    expect(await readBackup(moved, f.input.operationRef)).toEqual(created);
    expect(await restoreBackup({ ...input, sourceBackup: moved, operationRef: 'restore-copied', targetRoot: join(f.directory, 'copied-restored') }, signal)).toMatchObject({ state: 'completed' });
    expect(existsSync(temporary)).toBe(true); expect(existsSync(restoreTemporary)).toBe(true);
  } finally { f.close(); }
}, 45000);

test('backup restore rejects oversized manifests and file lists before traversing payloads', async () => {
  const { createBackup, restoreBackup } = await import('../../packages/storage/src/backup');
  const f = await backupFixture(), signal = new AbortController().signal;
  let traversal: ReturnType<typeof spyOn<typeof filesystem, 'readdir'>> | undefined;
  try {
    await createBackup(f.input, signal); const sourceBackup = join(f.destinationRoot, 'MedClaw-backup-backup-original');
    const path = join(sourceBackup, 'manifest.json'), original = readFileSync(path, 'utf8');
    traversal = spyOn(filesystem, 'readdir');
    const oversized = original + ' '.repeat(8 * 1024 * 1024 + 1 - Buffer.byteLength(original));
    const manifest = JSON.parse(original); manifest.files = Array.from({ length: 50001 }, (_, index) => ({ path: `artifacts/${f.artifactId}/file-${index}`, bytes: 0 }));
    for (const [index, value] of [oversized, JSON.stringify(manifest)].entries()) {
      writeFileSync(path, value); traversal.mockClear(); const targetRoot = join(f.directory, 'rejected-limit-' + index);
      await expect(restoreBackup({ operationRef: 'restore-limit-' + index, sourceBackup, targetRoot,
        installManifestPath: f.input.installManifestPath, validateHistory: validateNativeHistory, leaseTemporaryRoot: controlledTemporaryLease }, signal)).rejects.toThrow('backup_invalid');
      expect(existsSync(targetRoot)).toBe(false);
      expect(traversal.mock.calls.some(([path]) => path === sourceBackup)).toBe(false);
      expect(readdirSync(f.directory).some(name => name.startsWith('.MedClaw-restore-'))).toBe(false);
    }
    traversal.mockRestore(); traversal = undefined; writeFileSync(path, original);
    expect(await restoreBackup({ operationRef: 'restore-limit-valid', sourceBackup, targetRoot: join(f.directory, 'valid-limit'),
      installManifestPath: f.input.installManifestPath, validateHistory: validateNativeHistory, leaseTemporaryRoot: controlledTemporaryLease }, signal)).toMatchObject({ state: 'completed' });
    expect(existsSync(join(f.sourceRoot, 'data/app.sqlite'))).toBe(true);
  } finally { traversal?.mockRestore(); f.close(); }
}, 30000);

test('backup inventory rejects the 50001st payload entry without silently truncating or copying it', async () => {
  const { createBackup } = await import('../../packages/storage/src/backup');
  const f = await backupFixture(), readDirectory = filesystem.readdir, payload = join(f.sourceRoot, `artifacts/${f.artifactId}/input`);
  const entries = await readDirectory(payload, { withFileTypes: true });
  // Repeat one real file to exercise the traversal limit without creating 50001 physical files.
  const oversized = Array.from({ length: 50001 }, () => entries[0]!);
  const listing = spyOn(filesystem, 'readdir').mockImplementation(((...args: Parameters<typeof readDirectory>) =>
    args[0] === payload ? Promise.resolve(oversized) : Reflect.apply(readDirectory, filesystem, args)) as typeof readDirectory);
  try {
    await expect(createBackup(f.input, new AbortController().signal)).rejects.toThrow('backup_invalid');
    expect(readdirSync(f.destinationRoot)).toEqual([]);
    expect(readFileSync(join(payload, 'partial.csv'), 'utf8')).toBe('ENGINEERING incomplete content');
    expect(f.database.query('SELECT status FROM artifacts WHERE id=?').get(f.artifactId)).toEqual({ status: 'reserved' });
  } finally { listing.mockRestore(); f.close(); }
}, 60000);

test('oversized nonsecret settings reject backup and restore without replacing an earlier valid backup', async () => {
  const { createBackup, restoreBackup, readBackup } = await import('../../packages/storage/src/backup');
  const f = await backupFixture(), signal = new AbortController().signal;
  try {
    const receipt = await createBackup(f.input, signal), sourceBackup = join(f.destinationRoot, 'MedClaw-backup-backup-original');
    const sourceSettings = join(f.sourceRoot, 'data/settings.json'), settings = readFileSync(sourceSettings, 'utf8');
    const oversized = settings + ' '.repeat(8 * 1024 * 1024 + 1 - Buffer.byteLength(settings));
    writeFileSync(sourceSettings, oversized);
    const reads = spyOn(filesystem, 'readFile');
    try {
      await expect(createBackup({ ...f.input, operationRef: 'settings-over-limit' }, signal)).rejects.toThrow('backup_invalid');
      expect(reads.mock.calls.some(([path]) => path === sourceSettings)).toBe(false);
    } finally { reads.mockRestore(); }
    expect(existsSync(join(f.destinationRoot, 'MedClaw-backup-settings-over-limit'))).toBe(false);
    expect(readFileSync(sourceSettings, 'utf8')).toBe(oversized); writeFileSync(sourceSettings, settings);
    const backupSettings = join(sourceBackup, 'data/settings.json'), manifestPath = join(sourceBackup, 'manifest.json'), originalManifest = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(originalManifest); manifest.files.find((file: { path: string }) => file.path === 'data/settings.json').bytes = Buffer.byteLength(oversized);
    writeFileSync(backupSettings, oversized); writeFileSync(manifestPath, JSON.stringify(manifest));
    const targetRoot = join(f.directory, 'settings-rejected');
    await expect(restoreBackup({ operationRef: 'restore-settings-limit', sourceBackup, targetRoot, installManifestPath: f.input.installManifestPath,
      validateHistory: validateNativeHistory, leaseTemporaryRoot: controlledTemporaryLease }, signal)).rejects.toThrow('backup_invalid');
    expect(existsSync(targetRoot)).toBe(false); expect(readFileSync(backupSettings, 'utf8')).toBe(oversized);
    writeFileSync(backupSettings, settings); writeFileSync(manifestPath, originalManifest);
    expect(await readBackup(sourceBackup, f.input.operationRef)).toEqual(receipt);
    expect(readdirSync(f.destinationRoot)).toEqual(['MedClaw-backup-backup-original']);
  } finally { f.close(); }
}, 30000);

test('snapshot roots reject equality, nesting in both directions and junction aliases before publication', async () => {
  const { createBackup, restoreBackup } = await import('../../packages/storage/src/backup');
  const f = await backupFixture(), signal = new AbortController().signal;
  try {
    const installation = join(f.directory, 'installation'), installBytes = readFileSync(f.input.installManifestPath);
    for (const root of [join(f.sourceRoot, 'nested'), join(installation, 'nested'), join(f.destinationRoot, 'nested')]) mkdirSync(root);
    const sourceInstall = join(f.sourceRoot, 'install.json'), nestedSourceInstall = join(f.sourceRoot, 'nested/install.json'), destinationInstall = join(f.destinationRoot, 'install.json'), nestedDestinationInstall = join(f.destinationRoot, 'nested/install.json');
    for (const path of [sourceInstall, nestedSourceInstall, destinationInstall, nestedDestinationInstall]) writeFileSync(path, installBytes);
    const sourceAlias = join(f.directory, 'source-alias'), destinationAlias = join(f.directory, 'destination-alias'), installAlias = join(f.directory, 'install-alias');
    symlinkSync(f.sourceRoot, sourceAlias, 'junction'); symlinkSync(f.destinationRoot, destinationAlias, 'junction'); symlinkSync(installation, installAlias, 'junction');
    const cases = [
      { destinationRoot: f.sourceRoot }, { destinationRoot: join(f.sourceRoot, 'nested') }, { sourceRoot: join(f.sourceRoot, 'nested'), destinationRoot: f.sourceRoot },
      { installManifestPath: sourceInstall }, { installManifestPath: nestedSourceInstall }, { sourceRoot: join(installation, 'nested') },
      { destinationRoot: installation }, { destinationRoot: join(installation, 'nested') }, { installManifestPath: nestedDestinationInstall }, { installManifestPath: destinationInstall },
      { sourceRoot: sourceAlias }, { destinationRoot: destinationAlias }, { installManifestPath: join(installAlias, 'install.json') },
    ];
    for (const [index, input] of cases.entries()) {
      await expect(createBackup({ ...f.input, ...input, operationRef: 'roots-rejected-' + index }, signal)).rejects.toThrow('access_denied');
      expect(existsSync(join(input.destinationRoot ?? f.destinationRoot, 'MedClaw-backup-roots-rejected-' + index))).toBe(false);
    }
    await createBackup(f.input, signal); const sourceBackup = join(f.destinationRoot, 'MedClaw-backup-backup-original');
    const backupAlias = join(f.directory, 'backup-alias'), parentAlias = join(f.directory, 'parent-alias'), targetAlias = join(f.directory, 'target-alias');
    symlinkSync(sourceBackup, backupAlias, 'junction'); symlinkSync(f.sourceRoot, parentAlias, 'junction'); symlinkSync(f.sourceRoot, targetAlias, 'junction');
    const restores = [
      { targetRoot: sourceBackup }, { targetRoot: join(sourceBackup, 'nested') }, { targetRoot: f.destinationRoot },
      { targetRoot: installation }, { targetRoot: join(installation, 'nested') }, { targetRoot: f.directory },
      { targetRoot: join(f.directory, 'alias-source-target'), sourceBackup: backupAlias }, { targetRoot: join(parentAlias, 'nested-target') }, { targetRoot: targetAlias },
    ];
    for (const [index, input] of restores.entries()) {
      await expect(restoreBackup({ operationRef: 'restore-roots-' + index, sourceBackup, ...input, installManifestPath: f.input.installManifestPath,
        validateHistory: validateNativeHistory, leaseTemporaryRoot: controlledTemporaryLease }, signal)).rejects.toThrow('access_denied');
    }
    expect(readFileSync(f.input.installManifestPath)).toEqual(installBytes); expect(existsSync(join(sourceBackup, 'receipt.json'))).toBe(true);
    expect(readFileSync(join(f.sourceRoot, 'data/credentials.enc.json'), 'utf8')).toBe('DO NOT BACK UP');
  } finally { f.close(); }
}, 45000);

test('the real restore worker separates the old data root from backup and installation roots', async () => {
  const { createBackup } = await import('../../packages/storage/src/backup');
  const { requestMaintenance } = await import('../../apps/desktop/src/main/maintenance-controller');
  const { inspectStoppedJob } = await import('../../apps/host/src/windows-job');
  const f = await backupFixture();
  const workers: { instanceId: string; startupToken: string; domain: HostJobDomain; processExited: boolean }[] = [];
  try {
    await createBackup(f.input, new AbortController().signal);
    const sourceBackup = join(f.destinationRoot, 'MedClaw-backup-backup-original'), installation = join(f.directory, 'installation');
    mkdirSync(join(installation, 'nested'));
    const nestedInstallation = join(f.sourceRoot, 'resources'); mkdirSync(nestedInstallation);
    const nestedManifest = join(nestedInstallation, 'install.json'); writeFileSync(nestedManifest, readFileSync(f.input.installManifestPath));
    const before = readFileSync(join(sourceBackup, 'data/app.sqlite'));
    const cases = [{ sourceRoot: sourceBackup }, { sourceRoot: f.destinationRoot }, { sourceRoot: join(sourceBackup, 'data') },
      { sourceRoot: installation }, { sourceRoot: join(installation, 'nested') }, { sourceRoot: f.sourceRoot, installManifestPath: nestedManifest },
      { sourceRoot: f.sourceRoot, targetRoot: f.sourceRoot }, { sourceRoot: f.sourceRoot, targetRoot: join(f.sourceRoot, 'nested-target') }, { sourceRoot: f.sourceRoot, targetRoot: f.directory }];
    for (const [index, input] of cases.entries()) {
      const sourceRoot = input.sourceRoot, targetRoot = input.targetRoot ?? join(f.directory, 'worker-roots-' + index);
      expect(await requestMaintenance({ bunExecutable: process.execPath, maintenanceEntry: resolve(import.meta.dir, '../../apps/host/src/maintenance.ts'), onWorker: worker => workers.push(worker) },
        { action: 'backup.restore', sourceRoot, sourceBackup, targetRoot, installManifestPath: input.installManifestPath ?? f.input.installManifestPath }, 'worker-roots-' + index))
        .toMatchObject({ ok: false, error: { code: 'access_denied' } });
      if (input.targetRoot === undefined || targetRoot.endsWith('nested-target')) expect(existsSync(targetRoot)).toBe(false);
      expect(existsSync(join(sourceRoot, 'runtime'))).toBe(false);
    }
    expect(readFileSync(join(sourceBackup, 'data/app.sqlite'))).toEqual(before); expect(existsSync(join(f.sourceRoot, 'data/app.sqlite'))).toBe(true);
  } finally {
    if (workers.some(worker => !worker.processExited || inspectStoppedJob(worker, worker.domain) === null)) throw new Error('ENGINEERING root-check worker stop unknown; retained ' + f.directory);
    if (realpathSync(f.directory) !== resolve(f.directory) || !f.directory.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING root-check cleanup root changed');
    f.close();
  }
}, 45000);

test('backup rejects an unreadable standalone Query before publication even when SQLite integrity passes', async () => {
  const { createBackup } = await import('../../packages/storage/src/backup');
  const f = await backupFixture(true);
  try {
    const bad = f.database.query(`INSERT INTO queries(session_id,run_id,input_id,call_ref,kind,source,based_on_query_id,params_json,batch_ids_json,material_version,catalog_revision,result_json,created_at)
      SELECT session_id,run_id,input_id,'unreadable-standalone',kind,source,based_on_query_id,params_json,batch_ids_json,material_version,catalog_revision,'{}',created_at FROM queries WHERE id=?`).run(f.query!.id);
    expect(f.database.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    await expect(createBackup(f.input, new AbortController().signal)).rejects.toThrow('storage_read_failed');
    expect(existsSync(join(f.destinationRoot, 'MedClaw-backup-backup-original'))).toBe(false);
    expect(f.database.query('SELECT result_json FROM queries WHERE id=?').get(Number(bad.lastInsertRowid))).toEqual({ result_json: '{}' });
  } finally { f.close(); }
}, 30000);

test('backup rejects an Answer with a missing saved Query while retaining the original facts', async () => {
  const { createBackup } = await import('../../packages/storage/src/backup');
  const f = await backupFixture(true);
  try {
    const runId = seedStandaloneAnswer(f);
    expect(f.repo.readAnswer(runId)).toMatchObject({ text: 'Standalone saved answer', queryIds: [f.query!.id] });
    f.database.query("UPDATE answers SET query_ids_json='[999999]' WHERE run_id=?").run(runId);
    expect(f.database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    await expect(createBackup(f.input, new AbortController().signal)).rejects.toThrow('access_denied');
    expect(existsSync(join(f.destinationRoot, 'MedClaw-backup-backup-original'))).toBe(false);
    expect(f.database.query('SELECT query_ids_json FROM answers WHERE run_id=?').get(runId)).toEqual({ query_ids_json: '[999999]' });
  } finally { f.close(); }
}, 30000);

test('standalone Query and Answer facts survive independent restore for active and soft-deleted Sessions', async () => {
  const { createBackup, restoreBackup } = await import('../../packages/storage/src/backup');
  const f = await backupFixture(true);
  try {
    const runId = seedStandaloneAnswer(f), original = f.repo.readAnswer(runId), signal = new AbortController().signal;
    for (const state of ['active', 'deleted']) {
      if (state === 'deleted') f.repo.deleteSession({ sessionId: f.session.id, expectedMetadataRevision: 0,
        expectedWorkspaceRevision: f.repo.readWorkspace().revision }, 'delete-for-backup', '2026-10-17T00:00:00.000Z');
      const operationRef = 'backup-'+state, targetRoot = join(f.directory, 'restored-'+state);
      await createBackup({ ...f.input, operationRef }, signal);
      await restoreBackup({ operationRef: 'restore-'+state, sourceBackup: join(f.destinationRoot, 'MedClaw-backup-'+operationRef), targetRoot,
        installManifestPath: f.input.installManifestPath, validateHistory: validateNativeHistory, leaseTemporaryRoot: controlledTemporaryLease }, signal);
      const db = new Database(join(targetRoot, 'data/app.sqlite'), { readonly: true, strict: true });
      try {
        expect(db.query('SELECT * FROM queries ORDER BY id').all()).toEqual(f.database.query('SELECT * FROM queries ORDER BY id').all());
        expect(db.query('SELECT * FROM answers ORDER BY id').all()).toEqual(f.database.query('SELECT * FROM answers ORDER BY id').all());
        const repo = new Repositories(db);
        if (state === 'active') expect(repo.readAnswer(runId)).toEqual(original);
        else expect(() => repo.readAnswer(runId)).toThrow('access_denied');
      } finally { db.close(); }
    }
  } finally { f.close(); }
}, 30000);

test('public Query Answer and complete history reads survive stopped-root backup and independent Host restore without replay', async () => {
  const f = await backupFixture(true), files = new FileTokens(), hosts: HostController[] = [];
  const runId = seedStandaloneAnswer(f), originalHistory = await f.memory.load(f.session.id);
  f.database.close();
  const makeHost = (dataRoot: string) => {
    const host = new HostController({ dataRoot, hostEntry: resolve(import.meta.dir, '../../apps/host/src/main.ts'), bunExecutable: process.execPath,
      onCredentialRequest: async frame => {
        if (frame.method === 'credential.list') return { ok: true, data: [] };
        if (frame.method === 'export.destination.settlePrevious') return { ok: true, data: { stopped: true } };
        return { ok: true, data: null };
      } });
    hosts.push(host); return host;
  };
  let maintenance: MaintenanceController | undefined;
  try {
    const source = makeHost(f.sourceRoot);
    expect(await source.start()).toMatchObject({ state: 'ready' });
    const queryInput = { queryId: f.query!.id, page: 1, pageSize: 2 }, answerInput = { runId };
    const originalQuery = await source.request('query.read', queryInput), originalAnswer = await source.request('answer.read', answerInput);
    expect(originalQuery).toMatchObject({ ok: true }); expect(originalAnswer).toMatchObject({ ok: true, data: { queryIds: [f.query!.id] } });
    const messagesInput = { sessionId: f.session.id, limit: 100 }, originalMessages = await source.request('session.messages.read', messagesInput);
    expect(originalMessages).toMatchObject({ ok: true });
    const selectionRoot = join(f.directory, 'selection'), targetParent = join(f.directory, 'restored-roots');
    mkdirSync(selectionRoot); mkdirSync(targetParent);
    maintenance = new MaintenanceController({ dataRoot: f.sourceRoot, selectionRoot, installManifestPath: f.input.installManifestPath,
      bunExecutable: process.execPath, maintenanceEntry: resolve(import.meta.dir, '../../apps/host/src/maintenance.ts'), files, host: source, writesBusy: () => false });
    const context = { operationRef: 'public-backup', windowId: 7 }, destinationToken = files.issueMaintenance(7, context.operationRef, 'backup-destination', f.destinationRoot).fileToken;
    const backup = await maintenance.create({ destinationToken }, context);
    expect(backup).toMatchObject({ ok: true, data: { kind: 'create', operationRef: context.operationRef } });
    expect(source.read()).toMatchObject({ state: 'stopped', shutdown: { executionStopped: true, requiredPersistenceComplete: true,
      databaseClosed: true, processExited: true, processTreeStopped: true } });
    const sourceBackup = join(f.destinationRoot, 'MedClaw-backup-' + context.operationRef);
    const snapshot = new Database(join(sourceBackup, 'data/app.sqlite'), { readonly: true, strict: true });
    try { expect(await new SqliteMemoryStore(snapshot, validateNativeHistory).load(f.session.id)).toEqual(originalHistory); }
    finally { snapshot.close(); }
    const restoreContext = { operationRef: 'public-restore', windowId: 7 };
    const sourceToken = files.issueMaintenance(7, restoreContext.operationRef, 'backup-source', sourceBackup).fileToken;
    const targetRootToken = files.issueMaintenance(7, restoreContext.operationRef, 'restore-target', targetParent).fileToken;
    const targetRoot = files.resolveMaintenance(targetRootToken, 7, restoreContext.operationRef, 'restore-target');
    const restored = await maintenance.restore({ sourceToken, targetRootToken }, restoreContext);
    expect(restored).toMatchObject({ ok: true, data: { kind: 'restore', configVersion: '9007199254740994' } });
    expect(JSON.parse(readFileSync(join(selectionRoot, 'launch.json'), 'utf8'))).toMatchObject({ activeDataRoot: targetRoot, restoreOperationRef: restoreContext.operationRef });
    const target = makeHost(targetRoot);
    expect(await target.start()).toMatchObject({ state: 'ready' });
    expect(await target.request('query.read', queryInput)).toEqual(originalQuery);
    expect(await target.request('answer.read', answerInput)).toEqual(originalAnswer);
    expect(await target.request('session.messages.read', messagesInput)).toEqual(originalMessages);
    expect(await target.stop(target.read().instanceId!)).toMatchObject({ state: 'stopped', shutdown: { executionStopped: true,
      requiredPersistenceComplete: true, databaseClosed: true, processExited: true, processTreeStopped: true } });
    for (const root of [f.sourceRoot, targetRoot]) {
      const database = new Database(join(root, 'data/app.sqlite'), { readonly: true, strict: true });
      try {
        expect(await new SqliteMemoryStore(database, validateNativeHistory).load(f.session.id)).toEqual(originalHistory);
        expect(database.query('SELECT id FROM runs ORDER BY id').all()).toEqual([{ id: runId }]);
        expect(database.query('SELECT COUNT(*) n FROM model_calls').get()).toEqual({ n: 0 });
      } finally { database.close(); }
    }
  } finally {
    for (const host of hosts) {
      if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
      const proof = host.read().shutdown;
      if (proof?.executionStopped !== true || proof.requiredPersistenceComplete !== true || proof.databaseClosed !== true
        || !proof.processExited || proof.processTreeStopped !== true) {
        console.error('P17_PUBLIC_RESTORE_RETAINED ' + JSON.stringify({ root: f.directory, host: host.read() }));
        throw new Error('ENGINEERING public restore stop or save unconfirmed');
      }
    }
    if (maintenance && !(await maintenance.shutdown()).stopped) throw new Error('ENGINEERING maintenance stop unconfirmed; retained ' + f.directory);
    if (realpathSync(f.directory) !== resolve(f.directory) || !f.directory.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING cleanup root changed');
    f.close();
  }
}, 60000);

test('snapshot validation reads the committed WAL and rejects a changed schema without migration or repair', async () => {
  const { validateDatabaseSnapshot } = await import('../../packages/storage/src/schema-validation');
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-snapshot-'));
  const path = join(root, 'app.sqlite'), source = openDatabase(path);
  try {
    const before = source.query('SELECT * FROM schema_migrations ORDER BY version').all();
    const reader = new Database(path, { readonly: true, strict: true });
    try {
      expect(() => validateDatabaseSnapshot(reader, 16)).not.toThrow();
      expect(() => validateDatabaseSnapshot(reader, 15)).toThrow('storage_migration_failed');
      reader.query('VACUUM INTO ?').run(join(root, 'snapshot.sqlite'));
    } finally { reader.close(); }
    const snapshot = new Database(join(root, 'snapshot.sqlite'), { strict: true });
    try {
      expect(snapshot.query('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(before);
      snapshot.exec('CREATE TABLE unexpected(value TEXT) STRICT');
      expect(() => validateDatabaseSnapshot(snapshot, 16)).toThrow('storage_migration_failed');
      expect(snapshot.query("SELECT name FROM sqlite_schema WHERE name='unexpected'").get()).not.toBeNull();
    } finally { snapshot.close(); }
    expect(source.query('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(before);
    expect(source.query("SELECT name FROM sqlite_schema WHERE name='unexpected'").get()).toBeNull();
  } finally { source.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a stopped-root backup preserves WAL history branches and reserved files, and replays only its original receipt', async () => {
  const { createBackup, readBackup } = await import('../../packages/storage/src/backup');
  const f = await backupFixture();
  try {
    const original = await f.memory.load(f.session.id), signal = new AbortController().signal;
    const receipt = await createBackup(f.input, signal), path = join(f.destinationRoot, 'MedClaw-backup-backup-original');
    expect(receipt).toMatchObject({ operationRef: 'backup-original', kind: 'create', state: 'completed', schemaVersion: 16, sdkVersion: '0.87.1' });
    expect(await readBackup(path, 'backup-original')).toEqual(receipt);
    expect(await createBackup(f.input, signal)).toEqual(receipt);
    const snapshot = new Database(join(path, 'data/app.sqlite'), { readonly: true, strict: true });
    try {
      expect(await new SqliteMemoryStore(snapshot, validateNativeHistory).load(f.session.id)).toEqual(original);
      expect(snapshot.query('SELECT status FROM artifacts WHERE id=?').get(f.artifactId)).toEqual({ status: 'reserved' });
    } finally { snapshot.close(); }
    expect(readFileSync(join(path, `artifacts/${f.artifactId}/input/partial.csv`), 'utf8')).toBe('ENGINEERING incomplete content');
    expect(readdirSync(join(path, 'data')).sort()).toEqual(['app.sqlite', 'settings.json']);
    await expect(createBackup({ ...f.input, sourceRoot: f.destinationRoot }, signal)).rejects.toThrow('state_conflict');
    expect(await f.memory.load(f.session.id)).toEqual(original);
  } finally { f.close(); }
}, 30000);

test('ready exports retain verified query content and an altered restored root cannot be silently reactivated', async () => {
  const { createBackup, restoreBackup, readRestore } = await import('../../packages/storage/src/backup');
  const f = await backupFixture(true);
  try {
    const signal = new AbortController().signal, store = new SqliteExportStore(f.database), artifacts = new ArtifactStore(f.database, join(f.sourceRoot, 'artifacts'));
    const source = store.readSource(f.query!.id, null), request = { operationRef: 'export-original', queryId: f.query!.id, answerId: null, format: 'json' as const, destinationToken: 'fixture' };
    const accepted = store.accept({ operationRef: request.operationRef, request, instanceId: 'fixture', sessionId: f.session.id, queryId: request.queryId, answerId: null, format: request.format, priorExportId: null, reuseArtifactId: null, createdAt: '2026-10-17T00:00:00.000Z' });
    const published = await artifacts.publishExport({ artifactId: accepted.reservedArtifactId!, originOperationRef: request.operationRef, format: request.format, source }, signal);
    store.publish(request.operationRef, published); store.register(request.operationRef, published);
    await createBackup(f.input, signal);
    const input = { operationRef: 'restore-export', sourceBackup: join(f.destinationRoot, 'MedClaw-backup-backup-original'), targetRoot: join(f.directory, 'restored'), installManifestPath: f.input.installManifestPath, validateHistory: validateNativeHistory, leaseTemporaryRoot: controlledTemporaryLease };
    const receipt = await restoreBackup(input, signal), restored = new Database(join(input.targetRoot, 'data/app.sqlite'), { strict: true });
    try {
      const proof = await new ArtifactStore(restored, join(input.targetRoot, 'artifacts')).verifyExport(published.artifactId);
      expect(proof.manifest).toEqual(published.manifest); expect(restored.query('SELECT * FROM queries').all()).toEqual(f.database.query('SELECT * FROM queries').all());
      restored.exec('CREATE TABLE unexpected(value TEXT) STRICT');
    } finally { restored.close(); }
    await expect(restoreBackup(input, signal)).rejects.toThrow('restore_failed');
    expect(await readRestore(input.targetRoot, input.operationRef)).toEqual(receipt);
    expect(existsSync(join(f.sourceRoot, 'data/app.sqlite'))).toBe(true);
  } finally { f.close(); }
}, 30000);

test('backup includes only declared product facts and never copies runtime caches evaluation materials or external deliveries', async () => {
  const { createBackup } = await import('../../packages/storage/src/backup');
  const f = await backupFixture();
  try {
    for (const name of ['runtime', 'pi-model-cache', 'outputs', 'Cache', 'evaluation/configs', 'evaluation/datasets', 'evaluation/runs']) {
      const path = join(f.sourceRoot, name); mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'private-original.txt'), 'ENGINEERING excluded original ' + name);
    }
    const external = join(f.directory, 'external-delivery.txt'); writeFileSync(external, 'ENGINEERING external original');
    await createBackup(f.input, new AbortController().signal);
    const root = join(f.destinationRoot, 'MedClaw-backup-' + f.input.operationRef), manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    expect(manifest.files.map((file: { path: string }) => file.path).sort()).toEqual([
      `artifacts/${f.artifactId}/input/partial.csv`, 'data/app.sqlite', 'data/settings.json',
    ].sort());
    expect(readdirSync(root).sort()).toEqual(['artifacts', 'data', 'manifest.json', 'receipt.json']);
    expect(manifest.artifacts).toEqual([{ id: f.artifactId, operationRef: 'reserved-original', kind: 'import', status: 'reserved' }]);
    for (const name of ['runtime', 'pi-model-cache', 'outputs', 'Cache', 'evaluation/configs', 'evaluation/datasets', 'evaluation/runs'])
      expect(readFileSync(join(f.sourceRoot, name, 'private-original.txt'), 'utf8')).toBe('ENGINEERING excluded original ' + name);
    expect(readFileSync(external, 'utf8')).toBe('ENGINEERING external original');
  } finally { f.close(); }
}, 30000);

test('restore rechecks installation combinations and manifest boundaries while historical receipts remain readable', async () => {
  const { createBackup, restoreBackup, readBackup } = await import('../../packages/storage/src/backup');
  const f = await backupFixture();
  try {
    const signal = new AbortController().signal, receipt = await createBackup(f.input, signal);
    const sourceBackup = join(f.destinationRoot, 'MedClaw-backup-' + f.input.operationRef), manifestPath = join(sourceBackup, 'manifest.json');
    const original = readFileSync(manifestPath, 'utf8'), manifest = JSON.parse(original), targetRoot = join(f.directory, 'rejected-boundary');
    const input = { operationRef: 'rejected-boundary', sourceBackup, targetRoot, installManifestPath: f.input.installManifestPath,
      validateHistory: validateNativeHistory, leaseTemporaryRoot: controlledTemporaryLease };
    const mismatches = { appVersion: '0.2.0', sdkVersion: '0.87.2', schemaVersion: 15, bunVersion: '1.3.0', protocolVersion: 'medclaw.host/wrong',
      platform: 'linux', arch: 'arm64', electronVersion: '44.5.0', resources: [{ name: 'unexpected' }], plugins: [{ name: 'unexpected' }], binaries: [] };
    for (const [key, value] of Object.entries(mismatches)) {
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, installation: { ...manifest.installation, [key]: value } }));
      await expect(restoreBackup(input, signal)).rejects.toThrow('backup_incompatible');
      expect(existsSync(targetRoot)).toBe(false); expect(await readBackup(sourceBackup, f.input.operationRef)).toEqual(receipt);
    }
    const settings = manifest.files.find((file: { path: string }) => file.path === 'data/settings.json');
    for (const files of [manifest.files.filter((file: { path: string }) => file.path !== 'data/settings.json'),
      [...manifest.files, { ...settings, path: 'DATA/settings.json' }],
      manifest.files.map((file: { path: string; bytes: number }) => file.path === settings.path ? { ...file, bytes: file.bytes + 1 } : file),
      ...['../outside', 'D:/outside.csv', '/absolute', 'artifacts/../outside', 'artifacts\\outside'].map(path => [{ ...settings, path }, ...manifest.files])]) {
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, files }));
      await expect(restoreBackup(input, signal)).rejects.toThrow('backup_invalid'); expect(existsSync(targetRoot)).toBe(false);
    }
    writeFileSync(manifestPath, original); const settingsPath = join(sourceBackup, 'data/settings.json'), settingsBytes = readFileSync(settingsPath);
    rmSync(settingsPath);
    await expect(restoreBackup(input, signal)).rejects.toThrow('backup_invalid'); expect(existsSync(targetRoot)).toBe(false);
    writeFileSync(settingsPath, settingsBytes);
    expect(await readBackup(sourceBackup, f.input.operationRef)).toEqual(receipt);
    expect(await restoreBackup(input, signal)).toMatchObject({ kind: 'restore', configVersion: '9007199254740994' });
    expect(readFileSync(manifestPath, 'utf8')).toBe(original);
    expect(readFileSync(join(f.sourceRoot, 'data/credentials.enc.json'), 'utf8')).toBe('DO NOT BACK UP');
  } finally { f.close(); }
  // Each case pins real Windows directories; allow the whole serial matrix to finish.
}, 120000);

test('disk-full failure and cancellation leave the previous backup and source facts intact', async () => {
  const { createBackup } = await import('../../packages/storage/src/backup');
  const f = await backupFixture();
  let failure: ReturnType<typeof spyOn> | undefined;
  try {
    const signal = new AbortController().signal, original = await createBackup(f.input, signal);
    const fs = await import('node:fs/promises'), originalOpen = fs.open;
    failure = spyOn(fs, 'open').mockImplementation((...args: Parameters<typeof originalOpen>) => {
      if (String(args[0]).includes('.MedClaw-backup-disk-full-') && String(args[0]).endsWith('settings.json')) throw Object.assign(new Error('ENGINEERING disk full'), { code: 'ENOSPC' });
      return originalOpen(...args);
    });
    await expect(createBackup({ ...f.input, operationRef: 'disk-full' }, signal)).rejects.toThrow('ENGINEERING disk full');
    failure.mockRestore(); failure = undefined;
    expect(readdirSync(f.destinationRoot)).toEqual(['MedClaw-backup-backup-original']);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(createBackup({ ...f.input, operationRef: 'cancelled' }, cancelled.signal)).rejects.toThrow();
    const { readBackup } = await import('../../packages/storage/src/backup');
    expect(await readBackup(join(f.destinationRoot, 'MedClaw-backup-backup-original'), f.input.operationRef)).toEqual(original);
    expect((await f.memory.load(f.session.id)).ok).toBe(true);
  } finally { failure?.mockRestore(); f.close(); }
}, 30000);

test('restore publishes a separate root once, clears credentials and preserves the original branches and numeric version', async () => {
  const { createBackup, restoreBackup, readRestore } = await import('../../packages/storage/src/backup');
  const f = await backupFixture(true);
  try {
    const runId = seedStandaloneAnswer(f), originalRun = f.database.query('SELECT * FROM runs WHERE id=?').get(runId), originalAnswer = f.repo.readAnswer(runId);
    const definition: PublishedSettings['customProviders'][number]['definition'] = { providerId: 'backup-custom', name: 'ENGINEERING backup custom', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1',
      models: [{ id: 'fixture', name: 'ENGINEERING', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024,
        outputLimitConfirmed: true, pricingKnown: false, cost: null }] };
    const sourcePath = join(f.sourceRoot, 'data/settings.json');
    writeFileSync(sourcePath, JSON.stringify({ ...JSON.parse(readFileSync(sourcePath, 'utf8')), customProviders: [{ definition, credentialRef: 'custom-secret-ref' }] }));
    const sourceSettings = new MainSettings(join(f.sourceRoot, 'data/settings.json')), source = sourceSettings.read();
    const sourcePublished = await sourceSettings.publish(source.configVersion, { ui: { detailOpen: !source.ui.detailOpen } }, { kind: 'ui' });
    expect(sourcePublished).toMatchObject({ configVersion: '9007199254740994', previous: { configVersion: source.configVersion, credentialRefs: { openai: 'secret-ref' } } });
    const signal = new AbortController().signal;
    await createBackup(f.input, signal);
    const input = { operationRef: 'restore-original', sourceBackup: join(f.destinationRoot, 'MedClaw-backup-backup-original'), targetRoot: join(f.directory, 'restored'), installManifestPath: f.input.installManifestPath, validateHistory: validateNativeHistory, leaseTemporaryRoot: controlledTemporaryLease };
    const receipt = await restoreBackup(input, signal);
    expect(receipt).toMatchObject({ operationRef: input.operationRef, kind: 'restore', configVersion: '9007199254740995' });
    expect(await restoreBackup(input, signal)).toEqual(receipt); expect(await readRestore(input.targetRoot, input.operationRef)).toEqual(receipt);
    const settings = JSON.parse(readFileSync(join(input.targetRoot, 'data/settings.json'), 'utf8'));
    expect(settings).toMatchObject({ configVersion: receipt.configVersion, credentialRefs: { openai: null }, previous: null, rollbackFromVersion: null });
    expect(settings.customProviders).toEqual([{ definition, credentialRef: null }]);
    expect(existsSync(join(input.targetRoot, 'data/credentials.enc.json'))).toBe(false);
    let prepared = 0, committed = 0;
    const settingsPath = join(input.targetRoot, 'data/settings.json'), originalSettings = readFileSync(settingsPath, 'utf8');
    const restoredSettings = new MainSettings(settingsPath, {
      async prepare(_token, candidate) { prepared++; expect(candidate.credentialRefs).toEqual({ openai: null }); expect(candidate.customProviders).toEqual([{ definition, credentialRef: null }]); },
      async commit() { committed++; }, async abort() {},
    });
    for (const targetConfigVersion of [source.configVersion, sourcePublished.configVersion]) {
      await expect(restoredSettings.publish(receipt.configVersion, {}, { kind: 'rollback', targetConfigVersion })).rejects.toThrow('config_conflict');
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe(originalSettings); expect([prepared, committed]).toEqual([0, 0]);
    const changed = await restoredSettings.publish(receipt.configVersion, { ui: { detailOpen: !settings.ui.detailOpen } }, { kind: 'ui' });
    expect(changed).toMatchObject({ configVersion: '9007199254740996', previous: { configVersion: receipt.configVersion, credentialRefs: { openai: null } } });
    const rolledBack = await restoredSettings.publish(changed.configVersion, {}, { kind: 'rollback', targetConfigVersion: receipt.configVersion });
    expect(rolledBack).toMatchObject({ configVersion: '9007199254740997', rollbackFromVersion: receipt.configVersion, ui: settings.ui,
      credentialRefs: { openai: null }, previous: { configVersion: changed.configVersion } });
    expect([prepared, committed]).toEqual([1, 1]); expect(existsSync(join(input.targetRoot, 'data/credentials.enc.json'))).toBe(false);
    const restored = new Database(join(input.targetRoot, 'data/app.sqlite'), { readonly: true, strict: true });
    try {
      expect(await new SqliteMemoryStore(restored, validateNativeHistory).load(f.session.id)).toEqual(await f.memory.load(f.session.id));
      expect(restored.query('SELECT * FROM runs WHERE id=?').get(runId)).toEqual(originalRun);
      expect(new Repositories(restored).readAnswer(runId)).toEqual(originalAnswer);
    } finally { restored.close(); }
    expect(sourceSettings.read()).toEqual(sourcePublished);
    expect(sourceSettings.read().customProviders).toEqual([{ definition, credentialRef: 'custom-secret-ref' }]);
    expect(readFileSync(join(f.sourceRoot, 'data/credentials.enc.json'), 'utf8')).toBe('DO NOT BACK UP');
    mkdirSync(join(f.directory, 'existing'));
    await expect(restoreBackup({ ...input, operationRef: 'other-restore', targetRoot: join(f.directory, 'existing') }, signal)).rejects.toThrow('restore_failed');
    expect(readdirSync(join(f.directory, 'existing'))).toEqual([]);
  } finally { f.close(); }
}, 30000);

test('invalid backup content and resource versions cannot overwrite or activate an existing root', async () => {
  const { createBackup, restoreBackup } = await import('../../packages/storage/src/backup');
  const f = await backupFixture();
  try {
    const signal = new AbortController().signal;
    await createBackup(f.input, signal);
    const sourceBackup = join(f.destinationRoot, 'MedClaw-backup-backup-original'), targetRoot = join(f.directory, 'rejected');
    const manifestPath = join(sourceBackup, 'manifest.json'), original = readFileSync(manifestPath, 'utf8');
    writeFileSync(manifestPath, original.replace('"appVersion":"0.1.0"', '"appVersion":"0.2.0"'));
    await expect(restoreBackup({ operationRef: 'invalid-version', sourceBackup, targetRoot, installManifestPath: f.input.installManifestPath, validateHistory: validateNativeHistory, leaseTemporaryRoot: controlledTemporaryLease }, signal)).rejects.toThrow('backup_incompatible');
    expect(existsSync(targetRoot)).toBe(false); writeFileSync(manifestPath, original);
    writeFileSync(join(sourceBackup, 'unexpected-private.txt'), 'not declared');
    await expect(restoreBackup({ operationRef: 'invalid-content', sourceBackup, targetRoot, installManifestPath: f.input.installManifestPath, validateHistory: validateNativeHistory, leaseTemporaryRoot: controlledTemporaryLease }, signal)).rejects.toThrow('backup_invalid');
    expect(existsSync(targetRoot)).toBe(false);
    rmSync(join(sourceBackup, 'unexpected-private.txt'));
    symlinkSync(f.sourceRoot, join(sourceBackup, 'external'), 'junction');
    await expect(restoreBackup({ operationRef: 'invalid-link', sourceBackup, targetRoot, installManifestPath: f.input.installManifestPath, validateHistory: validateNativeHistory, leaseTemporaryRoot: controlledTemporaryLease }, signal)).rejects.toThrow('backup_invalid');
    expect(existsSync(targetRoot)).toBe(false); expect(existsSync(join(f.sourceRoot, 'data/app.sqlite'))).toBe(true);
  } finally { f.close(); }
}, 30000);

test('private maintenance takes a stopped-root lease without destroying the old Host identity and refuses a live writer', async () => {
  const { requestMaintenance } = await import('../../apps/desktop/src/main/maintenance-controller');
  const f = await backupFixture();
  const lockPath = join(f.sourceRoot, 'runtime/host.lock'); mkdirSync(join(f.sourceRoot, 'runtime'));
  const jobModule = resolve(import.meta.dir, '../../apps/host/src/windows-job.ts'), lockModule = resolve(import.meta.dir, '../../apps/host/src/writer-lock.ts');
  const startWriter = () => Bun.spawn([process.execPath, '--no-env-file', '-e', `
    import { createHostJob } from ${JSON.stringify(jobModule)};
    import { acquireWriterLock } from ${JSON.stringify(lockModule)};
    const owner = { instanceId: crypto.randomUUID(), startupToken: crypto.randomUUID() };
    const job = createHostJob(owner), lease = await acquireWriterLock({ lockPath: ${JSON.stringify(lockPath)}, owner, processDomain: job.domain });
    process.stdout.write('READY\\n'); process.stdin.resume(); process.stdin.on('end', () => { lease.release(); process.exit(0); });
  `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const writer = startWriter();
  try {
    const reader = writer.stdout.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toBe('READY\n');
    const options = { bunExecutable: process.execPath, maintenanceEntry: resolve(import.meta.dir, '../../apps/host/src/maintenance.ts') };
    const input = { action: 'backup.create' as const, sourceRoot: f.sourceRoot, destinationRoot: f.destinationRoot, installManifestPath: f.input.installManifestPath };
    const denied = await requestMaintenance(options, input, 'private-blocked');
    expect(denied).toMatchObject({ ok: false, error: { code: 'host_stop_unconfirmed' } });
    expect(readdirSync(f.destinationRoot)).toEqual([]);
    writer.stdin.end(); expect(await writer.exited).toBe(0); const originalLock = readFileSync(lockPath, 'utf8');
    const created = await requestMaintenance(options, input, 'private-original');
    expect(created).toMatchObject({ ok: true, data: { operationRef: 'private-original', kind: 'create', state: 'completed' } });
    expect(readFileSync(lockPath, 'utf8')).toBe(originalLock);
    const read = await requestMaintenance(options, { action: 'backup.read', sourceRoot: join(f.destinationRoot, 'MedClaw-backup-private-original'), kind: 'create' }, 'private-original');
    expect(read).toEqual(created);
    const targetRoot = join(f.directory, 'private-restored');
    const restored = await requestMaintenance(options, { action: 'backup.restore', sourceRoot: f.sourceRoot, sourceBackup: join(f.destinationRoot, 'MedClaw-backup-private-original'), targetRoot, installManifestPath: f.input.installManifestPath }, 'private-restore');
    expect(restored).toMatchObject({ ok: true, data: { operationRef: 'private-restore', kind: 'restore', configVersion: '9007199254740994' } });
    const targetLock = JSON.parse(readFileSync(join(targetRoot, 'runtime/host.lock'), 'utf8'));
    expect(targetLock.processDomain).toMatchObject({ contract: 'medclaw.host-job/v1' }); expect(targetLock.instanceId).not.toBe(JSON.parse(originalLock).instanceId);
    expect(readFileSync(lockPath, 'utf8')).toBe(originalLock);
  } finally { writer.kill(); await writer.exited; f.close(); }
}, 45000);

test('a real directory publication lock reports restore failure while retaining the backup and original root', async () => {
  const { createBackup } = await import('../../packages/storage/src/backup');
  const { requestMaintenance } = await import('../../apps/desktop/src/main/maintenance-controller');
  const f = await backupFixture();
  const native = dlopen(join(process.env.SystemRoot!, 'System32/kernel32.dll'), {
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' }, CloseHandle: { args: ['u64'], returns: 'bool' },
  });
  let handle: number | bigint = 0;
  try {
    await createBackup(f.input, new AbortController().signal);
    const path = Buffer.from(f.directory + '\0', 'utf16le');
    handle = native.symbols.CreateFileW(ptr(path), 0x10000, 7, null, 3, 0x02000000, 0);
    expect(BigInt(handle)).not.toBe(0xffffffffffffffffn);
    const targetRoot = join(f.directory, 'blocked-restore'), sourceBackup = join(f.destinationRoot, 'MedClaw-backup-backup-original');
    const result = await requestMaintenance({ bunExecutable: process.execPath, maintenanceEntry: resolve(import.meta.dir, '../../apps/host/src/maintenance.ts') },
      { action: 'backup.restore', sourceRoot: f.sourceRoot, sourceBackup, targetRoot, installManifestPath: f.input.installManifestPath }, 'blocked-publication');
    expect(result).toMatchObject({ ok: false, error: { code: 'restore_failed', operationRef: 'blocked-publication' } });
    expect(existsSync(targetRoot)).toBe(false); expect(existsSync(join(sourceBackup, 'receipt.json'))).toBe(true); expect(existsSync(join(f.sourceRoot, 'data/app.sqlite'))).toBe(true);
  } finally { if (handle && BigInt(handle) !== 0xffffffffffffffffn) native.symbols.CloseHandle(handle); native.close(); f.close(); }
}, 30000);
