import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';
import { ArtifactStore, PACKAGE_LIMITS, hashFile, listPackageFiles, permittedRelativePath } from '../../packages/storage/src/artifact-store';
import { SqliteImportStore } from '../../packages/storage/src/import-store';
import { ArtifactSchema } from '../../packages/contracts/src/data';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test('P3 managed package keeps original delivery manifest separate and cannot imply business readiness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p3-artifacts-')); roots.push(root);
  const source = join(root, 'source'); mkdirSync(source); writeFileSync(join(source, 'manifest.json'), '{"status":"complete"}'); writeFileSync(join(source, 'source-lock.json'), '{}');
  const db = openDatabase(join(root, 'app.sqlite')); try {
    const artifacts = new ArtifactStore(db, join(root, 'artifacts')), imports = new SqliteImportStore(db);
    const operation = imports.begin({ operationRef: 'reserved', fileToken: 'opaque-token', mappingVersion: 'medclaw.snapshot/v1' }, 'instance');
    const id = operation.operation.artifactId!;
    await artifacts.copy(id, 'reserved', source, new AbortController().signal);
    expect(readFileSync(join(artifacts.inputPath(id), 'manifest.json'), 'utf8')).toBe('{"status":"complete"}');
    expect(artifacts.manifestPath(id)).toBe(join(root, 'artifacts', String(id), 'manifest.json'));
    expect(artifacts.manifestPath(id)).not.toBe(join(artifacts.inputPath(id), 'manifest.json'));
    const read = await artifacts.read(id), artifact = read.ok ? ArtifactSchema.parse(read.data) : null;
    expect(artifact?.status).toBe('reserved'); expect(artifact?.sourceLockHash).toBeNull();
    expect(imports.read('reserved')?.operation.result).toBeNull(); expect(imports.revision()).toBe(0);
    await expect(artifacts.copy(id, 'other-operation', source, new AbortController().signal)).rejects.toThrow('state_conflict');
    await expect(artifacts.verifyManifest(id, 'reserved')).rejects.toThrow('artifact_not_ready');
  } finally { db.close(); }
});
test('P3 inventory and hashing enforce authorized membership, byte count and symlink boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p3-artifacts-')); roots.push(root);
  const source = join(root, 'source'), outside = join(root, 'outside'); mkdirSync(source); mkdirSync(outside); writeFileSync(join(source, 'one.csv'), 'a,b\n1,2\n'); writeFileSync(join(outside, 'private.csv'), 'outside');
  expect(await listPackageFiles(source)).toEqual(['one.csv']); expect((await hashFile(join(source, 'one.csv'))).bytes).toBe(8);
  for (const path of ['../outside', '/absolute', 'C:/absolute', 'folder\\escaped', 'a/../b', 'a//b']) expect(permittedRelativePath(path)).toBe(false);
  symlinkSync(outside, join(source, 'linked'), 'junction');
  await expect(listPackageFiles(source)).rejects.toThrow('import_invalid');
});
test('P3 directory limits reject oversized inventories before copying payload bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p3-artifacts-')); roots.push(root);
  const source = join(root, 'files'), oversized = join(root, 'bytes'); mkdirSync(source); mkdirSync(oversized);
  for (let index = 0; index <= PACKAGE_LIMITS.files; index++) writeFileSync(join(source, `${index}.csv`), '');
  await expect(listPackageFiles(source)).rejects.toThrow('import_invalid');
  const file = join(oversized, 'large.csv'); writeFileSync(file, ''); truncateSync(file, PACKAGE_LIMITS.bytes + 1);
  await expect(listPackageFiles(oversized)).rejects.toThrow('import_invalid');
});

test('P3 inventory accepts a 1 GiB input within the enlarged package capacity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p3-artifacts-')); roots.push(root);
  const file = join(root, 'large.csv'); writeFileSync(file, ''); truncateSync(file, 1024 * 1024 * 1024);
  expect(await listPackageFiles(root)).toEqual(['large.csv']);
});
