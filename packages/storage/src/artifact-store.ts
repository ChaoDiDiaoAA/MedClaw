import type { Database } from 'bun:sqlite';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, realpath, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { ArtifactSchema, type Artifact, type CheckedPackage } from '../../contracts/src/data';
import { AppErrorSchema, PositiveIdSchema, serviceResult, type Result } from '../../contracts/src/error';
import { canonicalRequest } from '../../contracts/src/run';
import type { ManagedImportInspection } from '../../contracts/src/workspace';
import type {DataDeleteFile} from '../../contracts/src/data-deletion';
import { z } from 'zod';
import { EXPORT_VERSION, ExportArtifactSchema, ExportManifestSchema, FrozenExportSourceSchema, type ExportArtifact, type ExportFile, type ExportPublication, type FrozenExportSource, type PublishedExport } from '../../contracts/src/export';
import { SqliteExportStore } from './export-store';
import { publishNoReplace } from './publish-no-replace';

const exportHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const currentColumns = ['snapshotId', 'batchId', 'deviceId', 'date', 'scopeKey', 'deviceName', 'region', 'category', 'manufacturer', 'distributor', 'status', 'priceCents', 'priceCNY', 'currency', 'unit'];
const changesColumns = ['eventId', 'deviceId', 'deviceName', 'oldBatchId', 'newBatchId', 'date', 'scopeKey', 'kind', 'field', 'region', 'category', 'manufacturer', 'status', 'currency', 'unit', 'oldValue', 'newValue', 'deltaCents', 'deltaCNY', 'ratio'];
function cny(value: number): string {
  const cents = Math.round(value), absolute = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}
function markdown(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\`|*_[\]{}()#!~]/g, '\\$&').replaceAll('\r', '\\r').replaceAll('\n', '\\n');
}
function exportContent(input: ExportPublication) {
  const source = FrozenExportSourceSchema.parse(input.source), query = source.query, params = query.params;
  const priceMetric = 'metric' in params && (params.metric === 'sum_price' || params.metric === 'mean_price');
  const group = 'groupBy' in params ? params.groupBy : null;
  const columns = query.kind === 'current' ? currentColumns : query.kind === 'changes' ? changesColumns : [
    ...(query.kind === 'trend' || group === 'date' ? ['date'] : []), ...(group && group !== 'date' ? [group] : []),
    ...(priceMetric ? ['currency', 'priceUnit'] : []), 'metric', 'value', ...(priceMetric ? ['valueCNY'] : []), 'unit', 'matchedRows',
    ...(priceMetric ? ['validCount', 'zeroCount', 'missingCount'] : []), ...(query.kind === 'trend' ? ['gap'] : []),
  ];
  const derived: Record<string, string> = { priceCNY: 'priceCents', deltaCNY: 'deltaCents', valueCNY: 'value' };
  const numeric = new Set(['snapshotId', 'batchId', 'deviceId', 'eventId', 'oldBatchId', 'newBatchId', 'priceCents', 'deltaCents', 'ratio', 'value', 'matchedRows', 'validCount', 'zeroCount', 'missingCount']);
  const nullCells: { row: number; column: string }[] = [], escapedCells: { row: number; column: string; original: string }[] = [];
  const display = query.rows.map((row, index) => columns.map(column => {
    const from = derived[column], raw = row[from ?? column] ?? null, value = from && typeof raw === 'number' ? cny(raw) : raw;
    if (value === null) nullCells.push({ row: index + 1, column });
    if (typeof value === 'string' && (/^[\t\r\n]/.test(value) || /^\s*[=+\-@]/.test(value))) escapedCells.push({ row: index + 1, column, original: value });
    return value;
  }));
  const { rows: _rows, snapshotIds: _snapshots, eventIds: _events, ...queryMetadata } = query;
  const metadata = { contract: 'medclaw.export-metadata/v1', exportVersion: EXPORT_VERSION, originOperationRef: input.originOperationRef, artifactId: input.artifactId,
    query: queryMetadata, referenceDate: source.referenceDate, timezone: source.timezone, totalRows: query.rows.length, scope: 'all_saved',
    topN: 'topN' in params ? params.topN : null, evidence: source.evidence, answer: source.answer,
    sourceAvailability: source.sourceAvailability, deletedBatchIds: source.deletedBatchIds,
    columns: columns.map(name => ({ name, type: name === 'gap' ? 'boolean' : ['oldValue', 'newValue'].includes(name) ? 'scalar' : numeric.has(name) ? 'number' : 'string',
      nullable: true, unit: ['priceCents', 'deltaCents'].includes(name) || name === 'value' && priceMetric ? 'CNY cents' : name in derived ? 'CNY' : name === 'ratio' ? 'ratio' : null,
      derivedFrom: derived[name] ?? null, representation: name in derived ? 'csv/markdown display' : 'original' })), nullCells, escapedCells };
  const metadataText = canonicalRequest(metadata), metadataHash = exportHash(metadataText);
  const files: { path: ExportFile['path']; content: Buffer }[] = [];
  if (input.format === 'csv') {
    const cell = (value: string | number | boolean | null) => value === null ? '' : typeof value !== 'string' ? String(value)
      : `"${(/^[\t\r\n]/.test(value) || /^\s*[=+\-@]/.test(value) ? "'" : '') + value.replaceAll('"', '""')}"`;
    files.push({ path: 'result.csv', content: Buffer.from('\uFEFF' + [columns.map(cell).join(','), ...display.map(row => row.map(cell).join(','))].join('\r\n') + '\r\n') },
      { path: 'metadata.json', content: Buffer.from(metadataText) });
  } else if (input.format === 'json') {
    files.push({ path: 'result.json', content: Buffer.from(canonicalRequest({ metadata, rows: query.rows, answer: source.answer })) });
  } else {
    const safeMetadata = metadataText.replaceAll('`', '\\u0060').replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
    const table = [columns.map(markdown), columns.map(() => '---'), ...display.map(row => row.map(value => value === null ? 'Missing' : markdown(String(value))))]
      .map(row => `| ${row.join(' | ')} |`).join('\n');
    files.push({ path: 'result.md', content: Buffer.from(`# Query ${query.id}\n\n${table}\n${source.answer ? `\n## Answer\n\n${markdown(source.answer.text)}\n` : ''}\n## Metadata\n\n\`\`\`json\n${safeMetadata}\n\`\`\`\n`) });
  }
  return { files, metadataHash };
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const managedManifest = z.strictObject({ schema: z.literal('medclaw.artifact/import/v1'), artifactId: PositiveIdSchema,
  operationRef: z.string().min(1), role: z.literal('snapshot_package'), sourceHash: digest, metadataHash: digest,
  files: z.array(z.strictObject({path:z.string(),bytes:z.number().int().nonnegative().safe(),sha256:digest})).min(1).max(300),
  mappingVersion:z.string().min(1),calculationVersion:z.string().min(1),sourceLockHash:z.string().min(1),
  sourceBundleId:z.string().min(1),materialVersion:z.string().min(1),verifiedAt:z.string().datetime() });

export const PACKAGE_LIMITS = { files: 300, bytes: 2 * 1024 * 1024 * 1024, rows: 1000000 } as const;
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
  async publishExport(input: ExportPublication, signal: AbortSignal): Promise<PublishedExport> {
    PositiveIdSchema.parse(input.artifactId); signal.throwIfAborted();
    const row = this.db.query<{ operation_ref: string; kind: string; status: string; query_id: number; format: string }, [number]>('SELECT * FROM artifacts WHERE id=?').get(input.artifactId);
    if (!row || row.kind !== 'export' || row.status !== 'reserved' || row.operation_ref !== input.originOperationRef || row.query_id !== input.source.query.id || row.format !== input.format) throw new Error('state_conflict');
    const source = new SqliteExportStore(this.db).readSource(input.source.query.id, input.source.answer?.id ?? null);
    if (canonicalRequest(source) !== canonicalRequest(input.source)) throw new Error('state_conflict');
    const content = exportContent(input), files = content.files.map(file => ({ path: file.path, bytes: file.content.length, sha256: exportHash(file.content) })).sort((a, b) => a.path.localeCompare(b.path));
    const manifest = ExportManifestSchema.parse({ contract: 'medclaw.export-manifest/v1', artifactId: input.artifactId, originOperationRef: input.originOperationRef,
      queryId: source.query.id, resultHash: source.query.resultHash, answerId: source.answer?.id ?? null, format: input.format, exportVersion: EXPORT_VERSION, metadataHash: content.metadataHash, files });
    await mkdir(this.artifactsRoot, { recursive: true });
    const root = await this.exportRoot(), initialRoot = await lstat(root), opKey = exportHash(input.originOperationRef);
    const temporary = join(root, `.${input.artifactId}.${opKey}.tmp`), target = join(root, String(input.artifactId));
    await mkdir(temporary);
    const initialTemporary = await lstat(temporary);
    let published = false;
    try {
      for (const file of content.files) { signal.throwIfAborted(); await writeFile(join(temporary, file.path), file.content, { flag: 'wx', signal }); }
      await writeFile(join(temporary, 'manifest.json'), canonicalRequest(manifest), { flag: 'wx', signal });
      for (const file of files) {
        const path = join(temporary, file.path), stat = await lstat(path), actual = await hashFile(path, signal);
        if (!stat.isFile() || stat.isSymbolicLink() || actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error('artifact_not_ready');
      }
      const nowRoot = await lstat(root), nowTemporary = await lstat(temporary);
      if (initialRoot.dev !== nowRoot.dev || initialRoot.ino !== nowRoot.ino || nowRoot.isSymbolicLink()
        || initialTemporary.dev !== nowTemporary.dev || initialTemporary.ino !== nowTemporary.ino || nowTemporary.isSymbolicLink()) throw new Error('access_denied');
      await publishNoReplace(temporary, target, 'directory', signal); published = true;
      const proof = await this.verifyExport(input.artifactId);
      return { ...proof, publishedAt: new Date().toISOString() };
    } finally {
      if (!published) {
        try {
          const stat = await lstat(temporary), parent = await lstat(root);
          if (!stat.isSymbolicLink() && stat.dev === initialTemporary.dev && stat.ino === initialTemporary.ino
            && !parent.isSymbolicLink() && parent.dev === initialRoot.dev && parent.ino === initialRoot.ino && await realpath(temporary) === temporary) {
            for (const file of [...content.files.map(file => file.path), 'manifest.json']) { try { await unlink(join(temporary, file)); } catch {} }
            await rmdir(temporary);
          }
        } catch { /* Preserve unconfirmed temporary ownership or cleanup; never delete the published directory. */ }
      }
    }
  }

  async verifyExport(artifactId: number): Promise<PublishedExport> {
    PositiveIdSchema.parse(artifactId);
    const row = this.db.query<{ operation_ref: string; kind: string; query_id: number; format: string; status: string; metadata_json: string;
      sha256: string | null; bytes: number | null; metadata_sha256: string | null; published_at: string | null }, [number]>('SELECT * FROM artifacts WHERE id=?').get(artifactId);
    if (!row || row.kind !== 'export') throw new Error('artifact_not_ready');
    try {
      const root = await this.exportRoot(), directory = join(root, String(artifactId)), stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('artifact_not_ready');
      const manifestStat = await lstat(join(directory, 'manifest.json'));
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 65536) throw new Error('artifact_not_ready');
      const manifest = ExportManifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
      if (manifest.artifactId !== artifactId || manifest.originOperationRef !== row.operation_ref || manifest.queryId !== row.query_id || manifest.format !== row.format) throw new Error('artifact_not_ready');
      if (canonicalRequest((await readdir(directory)).sort()) !== canonicalRequest([...manifest.files.map(file => file.path), 'manifest.json'].sort())) throw new Error('artifact_not_ready');
      for (const file of manifest.files) {
        const path = join(directory, file.path), stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('artifact_not_ready');
        const actual = await hashFile(path);
        if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error('artifact_not_ready');
      }
      const source = new SqliteExportStore(this.db).readSource(manifest.queryId, manifest.answerId);
      if (source.query.resultHash !== manifest.resultHash) throw new Error('artifact_not_ready');
      let metadata: unknown;
      if (manifest.format === 'csv') metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
      else if (manifest.format === 'json') metadata = z.object({ metadata: z.unknown() }).parse(JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))).metadata;
      else {
        const text = await readFile(join(directory, 'result.md'), 'utf8'), start = text.lastIndexOf('```json\n');
        if (start < 0 || !text.endsWith('\n```\n')) throw new Error('artifact_not_ready');
        metadata = JSON.parse(text.slice(start + 8, -5));
      }
      const availability = z.object({ sourceAvailability: z.enum(['available', 'deleted']), deletedBatchIds: z.array(PositiveIdSchema) })
        .refine(value => value.deletedBatchIds.every(id => source.query.batchIds.includes(id)) && new Set(value.deletedBatchIds).size === value.deletedBatchIds.length
          && (value.sourceAvailability === 'deleted') === (value.deletedBatchIds.length > 0)).parse(metadata);
      const expected = exportContent({ artifactId, originOperationRef: manifest.originOperationRef, format: manifest.format, source: { ...source, ...availability } });
      if (expected.metadataHash !== manifest.metadataHash || expected.files.some(file => {
        const stored = manifest.files.find(item => item.path === file.path);
        return !stored || stored.bytes !== file.content.length || stored.sha256 !== exportHash(file.content);
      })) throw new Error('artifact_not_ready');
      const sha256 = exportHash(canonicalRequest(manifest.files)), sizeBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
      if (row.status === 'ready' && (row.sha256 !== sha256 || row.bytes !== sizeBytes || row.metadata_sha256 !== manifest.metadataHash
        || canonicalRequest(JSON.parse(row.metadata_json)) !== canonicalRequest(manifest))) throw new Error('artifact_not_ready');
      return { artifactId, relativePath: `artifacts/${artifactId}`, manifest, sha256, sizeBytes, metadataSha256: manifest.metadataHash, publishedAt: row.published_at };
    } catch (error) {
      if (AppErrorSchema.safeParse(error).success) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (error instanceof z.ZodError || error instanceof SyntaxError || ['ENOENT', 'ENOTDIR'].includes(code ?? '')
        || error instanceof Error && error.message === 'artifact_not_ready') throw new Error('artifact_not_ready');
      throw new Error('storage_read_failed');
    }
  }

  private async exportRoot(): Promise<string> {
    const stat = await lstat(this.artifactsRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('artifact_not_ready');
    return realpath(this.artifactsRoot);
  }
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
    const removed=new Set(pkg?[]:this.deletedFilePaths(id));
    const actualFiles = await listPackageFiles(this.inputPath(id));
    if (canonicalRequest(actualFiles.filter(path=>!removed.has(`input/${path}`))) !== canonicalRequest(manifest.files.filter(file=>!removed.has(file.path)).map(file => file.path.slice(6)).sort())) throw new Error('import_preview_stale');
    for (const file of manifest.files) {
      if (!permittedRelativePath(file.path) || !file.path.startsWith('input/')) throw new Error('import_preview_stale');
      if(removed.has(file.path)&&!actualFiles.includes(file.path.slice(6)))continue;
      const actual = await hashFile(join(this.artifactsRoot, String(id), file.path));
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error('import_preview_stale');
    }
  }
  private deletedFilePaths(id:number,operationRef?:string):string[]{
    if(!this.db.query("SELECT name FROM sqlite_schema WHERE name='data_deletions'").get())return [];
    return this.db.query<{path:string},[number,string|null]>("SELECT json_extract(f.value,'$.path') path FROM data_deletions d,json_each(d.preview_json,'$.files') f WHERE d.state='committed' AND json_extract(f.value,'$.artifactId')=? AND (?2 IS NULL OR d.operation_ref=?2)").all(id,operationRef??null).map(row=>row.path);
  }
  async assertDeletionOwner(id:number){const row=this.db.query<{operation_ref:string},[number]>('SELECT operation_ref FROM artifacts WHERE id=?').get(id);if(!row)throw new Error('artifact_not_ready');await this.verifyManifest(id,row.operation_ref);}
  async planBatchDeletion(batchIds:number[]):Promise<DataDeleteFile[]>{
    const encoded=JSON.stringify(batchIds),targets=this.db.query<{id:number;scope_key:string;snapshot_date:string;metadata_json:string},[string]>("SELECT id,scope_key,snapshot_date,metadata_json FROM batches WHERE status='active' AND id IN (SELECT value FROM json_each(?))").all(encoded);
    const owners=this.db.query<{artifact_id:number;operation_ref:string;result_json:string},[string]>("SELECT artifact_id,operation_ref,result_json FROM imports WHERE state IN ('imported','duplicate') AND artifact_id IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(result_json,'$.batchIds') WHERE value IN (SELECT value FROM json_each(?)))").all(encoded);
    const plans:DataDeleteFile[]=[];
    for(const owner of owners){
      await this.verifyManifest(owner.artifact_id,owner.operation_ref);
      const manifest=managedManifest.parse(JSON.parse(await readFile(this.manifestPath(owner.artifact_id),'utf8')));
      const resultIds=JSON.parse(owner.result_json).batchIds as number[];
      const active=this.db.query<{id:number},[string]>("SELECT id FROM batches WHERE status='active' AND id IN (SELECT value FROM json_each(?))").all(JSON.stringify(resultIds));
      if(active.every(row=>batchIds.includes(row.id))){for(const file of manifest.files)if(!this.deletedFilePaths(owner.artifact_id).includes(file.path))plans.push({artifactId:owner.artifact_id,path:file.path});continue;}
      for(const file of manifest.files.filter(file=>file.path.endsWith('.metadata.json')&&!this.deletedFilePaths(owner.artifact_id).includes(file.path))){
        const metadata=JSON.parse(await readFile(join(this.artifactsRoot,String(owner.artifact_id),file.path),'utf8'));
        const target=targets.find(batch=>batch.scope_key===metadata.scopeKey&&batch.snapshot_date===metadata.snapshotDate&&resultIds.includes(batch.id));
        if(!target)continue;
        if(canonicalRequest(metadata)!==canonicalRequest(JSON.parse(target.metadata_json)))throw new Error('import_preview_stale');
        const csv=file.path.replace(/\.metadata\.json$/,'.csv');if(!manifest.files.some(entry=>entry.path===csv))throw new Error('import_preview_stale');
        plans.push({artifactId:owner.artifact_id,path:file.path},{artifactId:owner.artifact_id,path:csv});
      }
    }
    return plans;
  }
  async deleteManagedFile(file:DataDeleteFile,operationRef:string):Promise<void>{
    if(!permittedRelativePath(file.path)||!file.path.startsWith('input/'))throw new Error('access_denied');
    PositiveIdSchema.parse(file.artifactId);
    if(!this.deletedFilePaths(file.artifactId,operationRef).includes(file.path))throw new Error('access_denied');
    const rootStat=await lstat(this.artifactsRoot);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('access_denied');
    const root=await realpath(this.artifactsRoot),parts=[String(file.artifactId),...file.path.split('/')];let directory=root;
    for(const part of parts.slice(0,-1)){
      directory=join(directory,part);const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('access_denied');
      const rel=relative(root,await realpath(directory));if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('access_denied');
    }
    const target=join(directory,parts.at(-1)!);
    let stat;try{stat=await lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('access_denied');
    const artifact=this.db.query<{operation_ref:string;metadata_sha256:string;metadata_json:string},[number]>('SELECT operation_ref,metadata_sha256,metadata_json FROM artifacts WHERE id=?').get(file.artifactId);
    if(!artifact)throw new Error('artifact_not_ready');
    const manifestText=await readFile(this.manifestPath(file.artifactId),'utf8'),manifest=managedManifest.parse(JSON.parse(manifestText));
    if(createHash('sha256').update(manifestText).digest('hex')!==artifact.metadata_sha256||canonicalRequest(manifest)!==artifact.metadata_json||manifest.artifactId!==file.artifactId||manifest.operationRef!==artifact.operation_ref)throw new Error('artifact_not_ready');
    const expected=manifest.files.find(value=>value.path===file.path);if(!expected)throw new Error('access_denied');
    const actual=await hashFile(target);if(actual.sha256!==expected.sha256||actual.bytes!==expected.bytes)throw new Error('artifact_not_ready');
    await unlink(target);
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
  read(id: number): Promise<Result<Artifact | ExportArtifact | null>> {
    return serviceResult(async () => {
      const row = this.db.query<{ id: number; operation_ref: string; kind: string; query_id: number | null; format: string; relative_path: string | null; metadata_sha256: string | null;
        published_at: string | null; registered_at: string | null; status: string; bytes: number | null; sha256: string | null; metadata_json: string }, [number]>('SELECT * FROM artifacts WHERE id=?').get(PositiveIdSchema.parse(id));
      if (!row) return null;
      if (row.kind === 'export') {
        new SqliteExportStore(this.db).readSource(row.query_id!, null);
        if (row.status !== 'ready') throw new Error('artifact_not_ready');
        const manifest = ExportManifestSchema.parse(JSON.parse(row.metadata_json));
        new SqliteExportStore(this.db).readSource(manifest.queryId, manifest.answerId);
        if (manifest.artifactId !== row.id || manifest.queryId !== row.query_id || manifest.originOperationRef !== row.operation_ref || manifest.format !== row.format
          || row.metadata_sha256 !== manifest.metadataHash || row.bytes !== manifest.files.reduce((total, file) => total + file.bytes, 0)
          || row.sha256 !== exportHash(canonicalRequest([...manifest.files].sort((a, b) => a.path.localeCompare(b.path))))) throw new Error('storage_read_failed');
        return ExportArtifactSchema.parse({ id: row.id, operationRef: row.operation_ref, queryId: row.query_id, format: row.format, relativePath: row.relative_path,
          sha256: row.sha256, metadataSha256: row.metadata_sha256, sizeBytes: row.bytes, publishedAt: row.published_at, registeredAt: row.registered_at });
      }
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const deletedBatchIds=this.db.query("SELECT name FROM sqlite_schema WHERE name='data_deletions'").get()?this.db.query<{id:number},[number]>("SELECT b.id FROM imports i,batches b WHERE i.artifact_id=? AND b.status='deleted' AND b.id IN (SELECT value FROM json_each(i.result_json,'$.batchIds')) ORDER BY b.id").all(row.id).map(batch=>batch.id):[];
      return ArtifactSchema.parse({ id: row.id, operationRef: row.operation_ref, status: row.status, format: 'csv', mimeType: 'application/x-directory', bytes: row.bytes, sha256: row.sha256, sourceLockHash: typeof metadata.sourceLockHash === 'string' ? metadata.sourceLockHash : null, metadata,sourceAvailability:deletedBatchIds.length?'deleted':'available',deletedBatchIds,unavailableFiles:this.deletedFilePaths(row.id) });
    }, 'storage_read_failed');
  }
}
