import type { Database } from 'bun:sqlite';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, realpath, writeFile, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { ArtifactSchema, type Artifact, type CheckedPackage } from '../../contracts/src/data';
import { PositiveIdSchema, serviceResult, type Result } from '../../contracts/src/error';
import { canonicalRequest } from '../../contracts/src/run';
import type { ManagedImportInspection } from '../../contracts/src/workspace';
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const managedManifest = z.strictObject({ schema: z.literal('medclaw.artifact/import/v1'), artifactId: PositiveIdSchema,
  operationRef: z.string().min(1), role: z.literal('snapshot_package'), sourceHash: digest, metadataHash: digest,
  files: z.array(z.strictObject({path:z.string(),bytes:z.number().int().nonnegative().safe(),sha256:digest})).min(1).max(300),
  mappingVersion:z.string().min(1),calculationVersion:z.string().min(1),sourceLockHash:z.string().min(1),
  sourceBundleId:z.string().min(1),materialVersion:z.string().min(1),verifiedAt:z.string().datetime() });

export const PACKAGE_LIMITS = { files: 300, bytes: 512 * 1024 * 1024, rows: 200000 } as const;
export function permittedRelativePath(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.includes('\\') && !path.includes(':') && !path.split('/').some(part => !part || part === '.' || part === '..');
}
export async function listPackageFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const canonicalRoot = await realpath(root);
  if ((await lstat(root)).isSymbolicLink() || !(await lstat(root)).isDirectory()) throw new Error('import_invalid');
  const files: string[] = [];
  let bytes = 0;
  async function visit(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const fullPath = join(path, entry.name), stat = await lstat(fullPath);
      if (stat.isSymbolicLink()) throw new Error('import_invalid');
      const canonical = await realpath(fullPath), rel = relative(canonicalRoot, canonical);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('import_invalid');
      if (stat.isDirectory()) await visit(fullPath);
      else if (stat.isFile()) {
        files.push(relative(root, fullPath).split(sep).join('/'));
        bytes += stat.size;
        if (files.length > PACKAGE_LIMITS.files || bytes > PACKAGE_LIMITS.bytes) throw new Error('import_invalid');
      } else throw new Error('import_invalid');
    }
  }
  await visit(root);
  return files.sort();
}
export async function hashFile(path: string, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path, { signal })) { signal?.throwIfAborted(); bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest('hex') };
}

/** Files are evidence; only the business transaction can mark a reserved Artifact ready. */
export class ArtifactStore {
  constructor(private readonly db: Database, private readonly artifactsRoot: string) {
    if (!isAbsolute(artifactsRoot)) throw new Error('input_invalid');
  }
  inputPath(id: number): string { return join(this.artifactsRoot, String(PositiveIdSchema.parse(id)), 'input'); }
  manifestPath(id: number): string { return join(this.artifactsRoot, String(PositiveIdSchema.parse(id)), 'manifest.json'); }
  async copy(id: number, operationRef: string, root: string, signal: AbortSignal): Promise<void> {
    const record = this.db.query<{ status: string; operation_ref: string }, [number]>('SELECT status,operation_ref FROM artifacts WHERE id=?').get(id);
    if (!record || record.status !== 'reserved' || record.operation_ref !== operationRef) throw new Error('state_conflict');
    const files = await listPackageFiles(root, signal), targetRoot = this.inputPath(id);
    await mkdir(targetRoot, { recursive: true });
    for (const path of files) {
      signal.throwIfAborted();
      if (!permittedRelativePath(path)) throw new Error('import_invalid');
      const target = join(targetRoot, path);
      await mkdir(resolve(target, '..'), { recursive: true });
      await pipeline(createReadStream(join(root, path), { signal }), createWriteStream(target, { flags: 'wx' }), { signal });
    }
  }
  async writeManifest(id: number, operationRef: string, pkg: CheckedPackage): Promise<void> {
    const first = pkg.days[0]!.metadata;
    const manifest = { schema: 'medclaw.artifact/import/v1', artifactId: id, operationRef, role: 'snapshot_package', files: pkg.files.map(file => ({ ...file, path: `input/${file.path}` })), sourceHash: pkg.sourceHash, metadataHash: pkg.metadataHash, mappingVersion: first.mappingVersion, calculationVersion: pkg.calculationVersion, sourceLockHash: first.sourceLockHash, sourceBundleId: first.sourceBundleId, materialVersion: first.materialVersion, verifiedAt: new Date().toISOString() };
    await writeFile(this.manifestPath(id), canonicalRequest(manifest), { flag: 'wx' });
    this.db.query('UPDATE artifacts SET relative_path=?,sha256=?,bytes=?,metadata_sha256=?,metadata_json=? WHERE id=? AND status=\'reserved\'').run(String(id), pkg.sourceHash, pkg.totalBytes, createHash('sha256').update(canonicalRequest(manifest)).digest('hex'), canonicalRequest(manifest), id);
    this.db.query('UPDATE imports SET manifest_path=? WHERE operation_ref=?').run(`${id}/manifest.json`, operationRef);
  }
  async verifyManifest(id: number, operationRef: string, pkg?: CheckedPackage): Promise<void> {
    const row = this.db.query<{ metadata_sha256: string | null; metadata_json: string; status: string; sha256:string|null;bytes:number|null }, [number]>('SELECT metadata_sha256,metadata_json,status,sha256,bytes FROM artifacts WHERE id=?').get(id);
    if (!row?.metadata_sha256) throw new Error('artifact_not_ready');
    const text = await readFile(this.manifestPath(id), 'utf8');
    const parsed = managedManifest.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error('import_preview_stale');
    const manifest = parsed.data;
    if (createHash('sha256').update(text).digest('hex') !== row.metadata_sha256 || manifest.artifactId !== id || manifest.operationRef !== operationRef || canonicalRequest(manifest) !== row.metadata_json) throw new Error('import_preview_stale');
    if (pkg && manifest.sourceHash !== pkg.sourceHash) throw new Error('import_preview_stale');
    const sourceFiles = manifest.files.map(file => ({...file,path:file.path.slice(6)}));
    if (new Set(manifest.files.map(file=>file.path)).size!==manifest.files.length || manifest.sourceHash!==row.sha256
      || createHash('sha256').update(canonicalRequest(sourceFiles)).digest('hex')!==manifest.sourceHash
      || manifest.files.reduce((sum,file)=>sum+file.bytes,0)!==row.bytes) throw new Error('import_preview_stale');
    const actualFiles = await listPackageFiles(this.inputPath(id));
    if (canonicalRequest(actualFiles) !== canonicalRequest(manifest.files.map(file => file.path.slice(6)).sort())) throw new Error('import_preview_stale');
    for (const file of manifest.files) {
      if (!permittedRelativePath(file.path) || !file.path.startsWith('input/')) throw new Error('import_preview_stale');
      const actual = await hashFile(join(this.artifactsRoot, String(id), file.path));
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error('import_preview_stale');
    }
  }
  async inspectManagedImport(id: number): Promise<ManagedImportInspection> {
    let operationRef: string;
    try {
      const row = this.db.query<{operation_ref:string;import_id:number;status:string;relative_path:string|null;metadata_json:string},[number]>('SELECT operation_ref,import_id,status,relative_path,metadata_json FROM artifacts WHERE id=?').get(PositiveIdSchema.parse(id));
      if (!row) return {status:'invalid',reason:'missing_record'};
      const owner = this.db.query<{operation_ref:string;artifact_id:number|null;state:string;manifest_path:string|null},[number]>('SELECT operation_ref,artifact_id,state,manifest_path FROM imports WHERE id=?').get(row.import_id);
      if (!owner || row.status!=='ready' || owner.state!=='imported' && owner.state!=='duplicate'
        || owner.operation_ref!==row.operation_ref || owner.artifact_id!==id || row.relative_path!==String(id) || owner.manifest_path!==`${id}/manifest.json`) return {status:'invalid',reason:'owner_mismatch'};
      JSON.parse(row.metadata_json);
      operationRef=row.operation_ref;
    } catch { return {status:'unavailable',reason:'storage_unavailable'}; }
    try {
      const root=await lstat(this.artifactsRoot);
      if (!root.isDirectory() || root.isSymbolicLink()) return {status:'unavailable',reason:'root_unavailable'};
      await readdir(this.artifactsRoot);
    } catch { return {status:'unavailable',reason:'root_unavailable'}; }
    try {
      const directory=await lstat(join(this.artifactsRoot,String(id)));
      const manifest=await lstat(this.manifestPath(id));
      if (!directory.isDirectory() || directory.isSymbolicLink() || !manifest.isFile() || manifest.isSymbolicLink()) return {status:'invalid',reason:'hash_mismatch'};
      await this.verifyManifest(id,operationRef);
      return {status:'valid'};
    } catch (error) {
      const code=(error as NodeJS.ErrnoException).code;
      if (code==='ENOENT' || code==='ENOTDIR') {
        try { await readdir(this.artifactsRoot); } catch { return {status:'unavailable',reason:'root_unavailable'}; }
        return {status:'invalid',reason:'missing_managed_file'};
      }
      if (error instanceof SyntaxError || error instanceof Error && ['import_preview_stale','import_invalid','artifact_not_ready'].includes(error.message)) return {status:'invalid',reason:'hash_mismatch'};
      return {status:'unavailable',reason: error instanceof Error && error.name==='SQLiteError' ? 'storage_unavailable' : 'temporary_io'};
    }
  }
  read(id: number): Promise<Result<Artifact | null>> {
    return serviceResult(async () => {
      const row = this.db.query<{ id: number; operation_ref: string; status: string; bytes: number | null; sha256: string | null; metadata_json: string }, [number]>('SELECT id,operation_ref,status,bytes,sha256,metadata_json FROM artifacts WHERE id=?').get(PositiveIdSchema.parse(id));
      if (!row) return null;
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      return ArtifactSchema.parse({ id: row.id, operationRef: row.operation_ref, status: row.status, format: 'csv', mimeType: 'application/x-directory', bytes: row.bytes, sha256: row.sha256, sourceLockHash: typeof metadata.sourceLockHash === 'string' ? metadata.sourceLockHash : null, metadata });
    }, 'storage_read_failed');
  }
}
