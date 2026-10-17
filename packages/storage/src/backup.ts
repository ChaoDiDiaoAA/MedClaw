import { Database } from 'bun:sqlite';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AbsolutePathSchema, OpaqueIdSchema, TimestampSchema } from '../../contracts/src/error';
import { BackupRecordSchema, BackupReceiptSchema, InstallManifestSchema, InstallRelativePathSchema, MaintenanceOperationRefSchema, RestoreRecordSchema, RestoreReceiptSchema, type BackupReceipt, type InstallManifest, type RestoreReceipt } from '../../contracts/src/maintenance';
import { PublishedSettingsSchema } from '../../contracts/src/model';
import type { NativeHistorySnapshot } from '../../contracts/src/session';
import { ArtifactStore, filesEqual } from './artifact-store';
import { SqliteMemoryStore } from './memory-store';
import { SqliteToolStore } from './tool-store';
import { Repositories } from './repositories';
import { pinDirectory, publishNoReplace } from './publish-no-replace';
import { SCHEMA_VERSION, validateDatabaseSnapshot } from './schema-validation';

const operationIdentity = MaintenanceOperationRefSchema;
const payloadFile = z.strictObject({ path: InstallRelativePathSchema, bytes: z.number().int().nonnegative().safe() });
const artifactIdentity = z.strictObject({ id: z.number().int().positive().safe(), operationRef: OpaqueIdSchema, kind: z.enum(['import', 'export']), status: z.enum(['reserved', 'ready']) });
const backupManifest = z.strictObject({ contract: z.literal('medclaw.backup/v1'), operationRef: operationIdentity, createdAt: TimestampSchema,
  installation: InstallManifestSchema, files: z.array(payloadFile).min(2).max(50000), artifacts: z.array(artifactIdentity).max(50000) });
const createRequest = BackupRecordSchema.shape.request;
const restoreRequest = RestoreRecordSchema.shape.request;
const backupRecord = BackupRecordSchema;
const restoreRecord = RestoreRecordSchema;
type Validation = { validateHistory: (snapshot: NativeHistorySnapshot) => NativeHistorySnapshot };
export type CreateBackupInput = Validation & { operationRef: string; sourceRoot: string; destinationRoot: string; installManifestPath: string };
export type RestoreBackupInput = Validation & { operationRef: string; sourceBackup: string; targetRoot: string; installManifestPath: string;
  leaseTemporaryRoot: (root: string) => Promise<{ release(): void }> };
type PayloadFile = z.infer<typeof payloadFile>;
type ArtifactIdentity = z.infer<typeof artifactIdentity>;
type DirectoryIdentity = { dev: bigint; ino: bigint };

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function directory(path: string): Promise<string> {
  AbsolutePathSchema.parse(path);
  const stat = await lstat(path), canonical = await realpath(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical.toLowerCase() !== resolve(path).toLowerCase()) throw new Error('access_denied');
  return canonical;
}
async function removeTemporary(path: string, parent: string, identity: DirectoryIdentity): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (dirname(resolve(path)).toLowerCase() !== parent.toLowerCase() || (await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()
    || current.isSymbolicLink() || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('access_denied');
  await rm(path, { recursive: true, force: true });
}
function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
}
function separate(paths: string[]): void {
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++)
    if (within(paths[i]!, paths[j]!) || within(paths[j]!, paths[i]!)) throw new Error('access_denied');
}
async function json(path: string, maxBytes = 65536): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('backup_invalid');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function installation(path: string): Promise<InstallManifest> { return InstallManifestSchema.parse(await json(path, 1048576)); }
async function inventory(root: string, signal: AbortSignal): Promise<PayloadFile[]> {
  const files: PayloadFile[] = [];
  async function visit(path: string) {
    signal.throwIfAborted();
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name), stat = await lstat(target);
      if (stat.isSymbolicLink() || !within(root, await realpath(target))) throw new Error('backup_invalid');
      if (stat.isDirectory()) await visit(target);
      else if (stat.isFile()) files.push(payloadFile.parse({ path: relative(root, target).split(sep).join('/'), bytes: stat.size }));
      else throw new Error('backup_invalid');
      if (files.length > 50000) throw new Error('backup_invalid');
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
async function writeJson(path: string, value: unknown) {
  const file = await open(path, 'wx');
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
}
async function copyPayload(source: string, target: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('backup_invalid');
  const input = await open(source, 'r'); let output;
  try {
    const opened = await input.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('backup_invalid');
    await mkdir(dirname(target), { recursive: true }); output = await open(target, 'wx');
    const buffer = Buffer.alloc(65536); let position = 0;
    while (position < Number(before.size)) {
      signal.throwIfAborted();
      const count = Math.min(buffer.length, Number(before.size) - position), read = await input.read(buffer, 0, count, position);
      if (read.bytesRead !== count) throw new Error('backup_invalid');
      await output.writeFile(buffer.subarray(0, count)); position += count;
    }
    await output.sync();
    const current = await lstat(source, { bigint: true });
    if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.mtimeNs !== before.mtimeNs) throw new Error('backup_invalid');
  } finally { await input.close(); await output?.close(); }
  if (!(await filesEqual(source, target, signal))) throw new Error('backup_invalid');
}
async function validateContent(db: Database, root: string, validation: Validation, signal: AbortSignal): Promise<ArtifactIdentity[]> {
  validateDatabaseSnapshot(db, SCHEMA_VERSION);
  const memory = new SqliteMemoryStore(db, validation.validateHistory);
  for (const session of db.query<{ id: number }, []>('SELECT id FROM sessions ORDER BY id').all()) {
    signal.throwIfAborted(); const result = await memory.load(session.id);
    if (!result.ok) throw result.error;
  }
  const tools = new SqliteToolStore(db), repositories = new Repositories(db);
  for (const row of db.query<{ id: number }, []>('SELECT id FROM queries ORDER BY id').all()) {
    signal.throwIfAborted(); const query = tools.readQuery(row.id);
    if (!query) throw new Error('backup_invalid');
    for (const evidence of tools.listEvidence(row.id)) {
      if (evidence.calculationVersion !== query.calculationVersion || evidence.batchIds.some(id => !query.batchIds.includes(id))) throw new Error('backup_invalid');
    }
  }
  // Deleted Sessions retain their historical rows; the public Answer reader deliberately denies them.
  for (const row of db.query<{ run_id: number }, []>(`SELECT a.run_id FROM answers a JOIN sessions s ON s.id=a.session_id
    WHERE s.kind='user' AND s.status='active' ORDER BY a.id`).all()) {
    signal.throwIfAborted(); if (!repositories.readAnswer(row.run_id)) throw new Error('backup_invalid');
  }
  const artifacts = new ArtifactStore(db, join(root, 'artifacts'));
  const rows = db.query<{ id: number; operation_ref: string; kind: string; status: string }, []>('SELECT id,operation_ref,kind,status FROM artifacts ORDER BY id').all();
  for (const row of rows) {
    signal.throwIfAborted();
    if (row.status === 'ready') {
      if (row.kind === 'import') await artifacts.verifyManifest(row.id, row.operation_ref);
      else await artifacts.verifyExport(row.id, undefined, signal);
    }
  }
  return rows.map(row => artifactIdentity.parse({ id: row.id, operationRef: row.operation_ref, kind: row.kind, status: row.status }));
}
function matchingInstallation(value: unknown, current: InstallManifest): void {
  // Compare explicit versions before parsing so compatibility failures retain their own error.
  const raw = value as Record<string, unknown> | null;
  if (!raw || ['appVersion', 'sdkVersion', 'schemaVersion', 'bunVersion', 'protocolVersion', 'platform', 'arch', 'electronVersion'].some(key => raw[key] !== current[key as keyof InstallManifest])
    || !isDeepStrictEqual(raw.resources, current.resources) || !isDeepStrictEqual(raw.plugins, current.plugins) || !isDeepStrictEqual(raw.binaries, current.binaries)) throw new Error('backup_incompatible');
}
async function validateBackup(root: string, current: InstallManifest, validation: Validation, signal: AbortSignal) {
  const raw = await json(join(root, 'manifest.json'), 8 * 1024 * 1024);
  matchingInstallation((raw as { installation?: unknown })?.installation, current);
  const manifest = backupManifest.parse(raw), record = backupRecord.parse(await json(join(root, 'receipt.json')));
  if (record.receipt.operationRef !== manifest.operationRef || record.receipt.createdAt !== manifest.createdAt
    || record.receipt.appVersion !== current.appVersion || record.receipt.schemaVersion !== current.schemaVersion
    || new Set(manifest.files.map(file => file.path.toLowerCase())).size !== manifest.files.length) throw new Error('backup_invalid');
  const actual = (await inventory(root, signal)).filter(file => !['manifest.json', 'receipt.json'].includes(file.path));
  if (!isDeepStrictEqual(actual, manifest.files)) throw new Error('backup_invalid');
  const permitted = new Set(manifest.artifacts.map(artifact => String(artifact.id)));
  if (manifest.files.some(file => !['data/app.sqlite', 'data/settings.json'].includes(file.path)
    && (!file.path.startsWith('artifacts/') || !permitted.has(file.path.split('/')[1]!)))
    || !manifest.files.some(file => file.path === 'data/app.sqlite') || !manifest.files.some(file => file.path === 'data/settings.json')) throw new Error('backup_invalid');
  PublishedSettingsSchema.parse(await json(join(root, 'data/settings.json'), 8 * 1024 * 1024));
  const db = new Database(join(root, 'data/app.sqlite'), { readonly: true, strict: true });
  try { if (!isDeepStrictEqual(await validateContent(db, root, validation, signal), manifest.artifacts)) throw new Error('backup_invalid'); }
  finally { db.close(); }
  return { manifest, record };
}

export async function readBackup(root: string, operationRef: string): Promise<BackupReceipt | null> {
  operationIdentity.parse(operationRef);
  if (!(await exists(root))) return null;
  root = await directory(root);
  if (!(await exists(join(root, 'receipt.json')))) return null;
  const record = backupRecord.parse(await json(join(root, 'receipt.json')));
  return record.receipt.operationRef === operationRef && basename(root) === 'MedClaw-backup-' + operationRef ? record.receipt : null;
}
export async function readRestore(root: string, operationRef: string): Promise<RestoreReceipt | null> {
  operationIdentity.parse(operationRef);
  if (!(await exists(root))) return null;
  root = await directory(root);
  if (!(await exists(join(root, 'data/restore-receipt.json')))) return null;
  const record = restoreRecord.parse(await json(join(root, 'data/restore-receipt.json'), 1048576));
  return record.receipt.operationRef === operationRef && record.request.targetRoot === root ? record.receipt : null;
}
/** Caller holds the source WriterLease and has confirmed execution and required saves stopped. */
export async function createBackup(input: CreateBackupInput, signal: AbortSignal): Promise<BackupReceipt> {
  operationIdentity.parse(input.operationRef);
  const sourceRoot = await directory(input.sourceRoot), destinationRoot = await directory(input.destinationRoot);
  const request = createRequest.parse({ kind: 'create', sourceRoot, destinationRoot }), current = await installation(input.installManifestPath);
  const finalRoot = join(destinationRoot, 'MedClaw-backup-' + input.operationRef);
  if (await exists(finalRoot)) {
    const old = backupRecord.parse(await json(join(finalRoot, 'receipt.json')));
    if (old.receipt.operationRef !== input.operationRef || !isDeepStrictEqual(old.request, request)) throw new Error('state_conflict');
    await validateBackup(await directory(finalRoot), current, input, signal); return old.receipt;
  }
  separate([sourceRoot, destinationRoot, await directory(dirname(input.installManifestPath))]);
  const unpinSource = await pinDirectory(sourceRoot, signal); let unpinDestination: (() => Promise<void>) | undefined, temporary: string | undefined, temporaryIdentity: DirectoryIdentity | undefined;
  try {
    unpinDestination = await pinDirectory(destinationRoot, signal); signal.throwIfAborted();
    const settingsPath = join(sourceRoot, 'data/settings.json'), settingsStat = await lstat(settingsPath);
    if (!settingsStat.isFile() || settingsStat.isSymbolicLink() || settingsStat.size > 8 * 1024 * 1024) throw new Error('backup_invalid');
    const settingsBytes = await readFile(settingsPath), manifestBytes = await readFile(input.installManifestPath);
    PublishedSettingsSchema.parse(JSON.parse(settingsBytes.toString('utf8')));
    const sourcePath = join(sourceRoot, 'data/app.sqlite');
    if ((await lstat(sourcePath)).isSymbolicLink() || !within(sourceRoot, await realpath(sourcePath))) throw new Error('backup_invalid');
    temporary = await mkdtemp(join(destinationRoot, '.MedClaw-backup-' + input.operationRef + '-'));
    temporaryIdentity = await lstat(temporary, { bigint: true });
    const source = new Database(sourcePath, { readonly: true, strict: true });
    let identities: ArtifactIdentity[];
    try {
      identities = await validateContent(source, sourceRoot, input, signal);
      await mkdir(join(temporary, 'data'));
      source.query('VACUUM INTO ?').run(join(temporary, 'data/app.sqlite'));
    } finally { source.close(); }
    const snapshot = await open(join(temporary, 'data/app.sqlite'), 'r+'); try { await snapshot.sync(); } finally { await snapshot.close(); }
    await copyPayload(settingsPath, join(temporary, 'data/settings.json'), signal);
    for (const artifact of identities) {
      const path = join(sourceRoot, 'artifacts', String(artifact.id));
      if (!(await exists(path))) { if (artifact.status === 'ready') throw new Error('backup_invalid'); continue; }
      await directory(path);
      for (const file of await inventory(path, signal)) await copyPayload(join(path, file.path), join(temporary, 'artifacts', String(artifact.id), file.path), signal);
    }
    if (!(await readFile(settingsPath)).equals(settingsBytes) || !(await readFile(input.installManifestPath)).equals(manifestBytes)) throw new Error('state_conflict');
    const createdAt = new Date().toISOString(), receipt = BackupReceiptSchema.parse({ operationRef: input.operationRef, kind: 'create', state: 'completed', appVersion: current.appVersion, schemaVersion: current.schemaVersion, sdkVersion: current.sdkVersion, createdAt });
    const manifest = backupManifest.parse({ contract: 'medclaw.backup/v1', operationRef: input.operationRef, createdAt, installation: current, files: await inventory(temporary, signal), artifacts: identities });
    await writeJson(join(temporary, 'manifest.json'), manifest); await writeJson(join(temporary, 'receipt.json'), { request, receipt });
    await validateBackup(temporary, current, input, signal);
    await publishNoReplace(temporary, finalRoot, 'directory', signal); temporary = undefined;
    return receipt;
  } finally {
    try { if (temporary && temporaryIdentity) await removeTemporary(temporary, destinationRoot, temporaryIdentity); }
    finally { try { await unpinDestination?.(); } finally { await unpinSource(); } }
  }
}
/** Publishes verified data only. Main separately publishes launch.json and performs relaunch. */
export async function restoreBackup(input: RestoreBackupInput, signal: AbortSignal): Promise<RestoreReceipt> {
  operationIdentity.parse(input.operationRef);
  const requestedTarget = resolve(AbsolutePathSchema.parse(input.targetRoot));
  const sourceBackup = await directory(input.sourceBackup), parent = await directory(dirname(requestedTarget));
  const targetRoot = join(parent, basename(requestedTarget));
  const request = restoreRequest.parse({ kind: 'restore', sourceBackup, targetRoot }), current = await installation(input.installManifestPath);
  separate([sourceBackup, targetRoot, await directory(dirname(input.installManifestPath))]);
  if (await exists(targetRoot)) {
    await directory(targetRoot);
    if (!(await exists(join(targetRoot, 'data/restore-receipt.json')))) throw new Error('restore_failed');
    const old = restoreRecord.parse(await json(join(targetRoot, 'data/restore-receipt.json'), 1048576));
    if (old.receipt.operationRef !== input.operationRef || !isDeepStrictEqual(old.request, request)) throw new Error('state_conflict');
    matchingInstallation(old.installation, current);
    try {
      const { manifest } = await validateBackup(sourceBackup, current, input, signal);
      if (basename(sourceBackup) !== 'MedClaw-backup-' + manifest.operationRef) throw new Error('backup_invalid');
      if (old.sourceOperationRef !== manifest.operationRef || old.receipt.appVersion !== current.appVersion || old.receipt.schemaVersion !== current.schemaVersion) throw new Error('restore_failed');
      const settings = PublishedSettingsSchema.parse(await json(join(targetRoot, 'data/settings.json'), 8 * 1024 * 1024));
      if (settings.configVersion !== old.receipt.configVersion || settings.previous !== null || settings.rollbackFromVersion !== null
        || Object.values(settings.credentialRefs).some(value => value !== null) || settings.customProviders.some(provider => provider.credentialRef !== null)) throw new Error('restore_failed');
      const db = new Database(join(targetRoot, 'data/app.sqlite'), { readonly: true, strict: true });
      try { await validateContent(db, targetRoot, input, signal); } finally { db.close(); }
      for (const file of manifest.files) if (file.path !== 'data/settings.json' && !(await filesEqual(join(sourceBackup, file.path), join(targetRoot, file.path), signal))) throw new Error('restore_failed');
      return old.receipt;
    } catch { throw new Error('restore_failed'); }
  }
  const unpinSource = await pinDirectory(sourceBackup, signal); let unpinTarget: (() => Promise<void>) | undefined, temporary: string | undefined, temporaryIdentity: DirectoryIdentity | undefined, lease: { release(): void } | undefined;
  try {
    unpinTarget = await pinDirectory(parent, signal);
    let checked: Awaited<ReturnType<typeof validateBackup>>;
    try { checked = await validateBackup(sourceBackup, current, input, signal); }
    catch (error) { if (error instanceof Error && error.message === 'backup_incompatible') throw error; throw new Error('backup_invalid'); }
    const { manifest } = checked;
    if (basename(sourceBackup) !== 'MedClaw-backup-' + manifest.operationRef) throw new Error('backup_invalid');
    temporary = await mkdtemp(join(parent, '.MedClaw-restore-' + input.operationRef + '-'));
    temporaryIdentity = await lstat(temporary, { bigint: true });
    lease = await input.leaseTemporaryRoot(temporary);
    for (const file of manifest.files) await copyPayload(join(sourceBackup, file.path), join(temporary, file.path), signal);
    const settings = PublishedSettingsSchema.parse(await json(join(temporary, 'data/settings.json'), 8 * 1024 * 1024));
    const restored = PublishedSettingsSchema.parse({ ...settings, configVersion: (BigInt(settings.configVersion) + 1n).toString(),
      credentialRefs: Object.fromEntries(Object.keys(settings.credentialRefs).map(provider => [provider, null])),
      customProviders: settings.customProviders.map(provider => ({ ...provider, credentialRef: null })), previous: null, rollbackFromVersion: null });
    const settingsFile = await open(join(temporary, 'data/settings.json'), 'w');
    try { await settingsFile.writeFile(JSON.stringify(restored)); await settingsFile.sync(); } finally { await settingsFile.close(); }
    const db = new Database(join(temporary, 'data/app.sqlite'), { readonly: true, strict: true });
    try { await validateContent(db, temporary, input, signal); } finally { db.close(); }
    const receipt = RestoreReceiptSchema.parse({ operationRef: input.operationRef, kind: 'restore', state: 'completed', appVersion: current.appVersion, schemaVersion: current.schemaVersion, sdkVersion: current.sdkVersion, restoredAt: new Date().toISOString(), configVersion: restored.configVersion });
    await writeJson(join(temporary, 'data/restore-receipt.json'), { request, sourceOperationRef: manifest.operationRef, installation: current, receipt });
    lease.release(); lease = undefined;
    await publishNoReplace(temporary, targetRoot, 'directory', signal); temporary = undefined;
    return receipt;
  } finally {
    try { lease?.release(); if (temporary && temporaryIdentity) await removeTemporary(temporary, parent, temporaryIdentity); }
    finally { try { await unpinTarget?.(); } finally { await unpinSource(); } }
  }
}
