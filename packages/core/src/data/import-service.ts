import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ImportPreviewRequestSchema, ImportCommitRequestSchema, SnapshotMetadataSchema, type CheckedPackage, type ImportCommitRequest, type ImportOperation, type ImportPreview, type ImportPreviewRequest, type ImportServicePort, type ImportStore } from '../../../contracts/src/data';
import { OpaqueIdSchema, safeError, serviceResult, type Result } from '../../../contracts/src/error';
import { canonicalRequest } from '../../../contracts/src/run';
import { ArtifactStore, PACKAGE_LIMITS, filesEqual, listPackageFiles, permittedRelativePath } from '../../../storage/src/artifact-store';
import { DIFF_CALCULATION_VERSION, DiffService } from './diff-service';

import {readPackageRows,csvObjects,PackageInvalid,invalid} from '../../../storage/src/snapshot-rows';
import {omitLegacyFields} from '../../../storage/src/legacy-business-fields';
export {readPackageRows,readCsvRecords} from '../../../storage/src/snapshot-rows';
function jsonFile(root: string, file: string): unknown {
  try { return JSON.parse(readFileSync(join(root, file), 'utf8').replace(/^\ufeff/, '')); }
  catch (error) { if (error instanceof SyntaxError) invalid(file, null, null); throw error; }
}

const DeliveryManifestSchema = z.strictObject({ status: z.literal('complete'), files: z.array(z.strictObject({ path: z.string(), bytes: z.number().int().nonnegative() })), businessFiles: z.number().int().positive(), businessRows: z.number().int().positive().max(PACKAGE_LIMITS.rows), businessBytes: z.number().int().positive(), totalPayloadBytes: z.number().int().positive() });

export async function checkSnapshotPackage(root: string, mappingVersion = 'medclaw.snapshot/v1', signal?: AbortSignal): Promise<CheckedPackage> {
  let names: string[];
  try { names = await listPackageFiles(root, signal); } catch (error) { if (error instanceof Error && error.message === 'import_invalid') invalid(null, null, 'files'); throw error; }
  if (!names.includes('manifest.json')) invalid('manifest.json', null, null);
  const manifest = DeliveryManifestSchema.safeParse((() => { const value = jsonFile(root, 'manifest.json') as {files?: unknown[]}; return {...value,files:value.files?.map(file => omitLegacyFields(file,['sha256']))}; })());
  if (!manifest.success) invalid('manifest.json', null, null);
  const declared = manifest.data.files;
  if (new Set(declared.map(file => file.path)).size !== declared.length || declared.some(file => !permittedRelativePath(file.path) || file.path === 'manifest.json')) invalid('manifest.json', null, 'files');
  if (canonicalRequest([...declared.map(file => file.path), 'manifest.json'].sort()) !== canonicalRequest(names)) invalid('manifest.json', null, 'files');
  const required = ['entity-lineage.csv', 'source-lock.json', 'adjustment-lineage.csv', 'validation-report.json', 'selection-report.json', '使用说明.md'];
  for (const file of required) if (!names.includes(file)) invalid(file, null, null);
  const files: CheckedPackage['files'] = [];
  for (const path of names) {
    signal?.throwIfAborted();
    const actual = {bytes: statSync(join(root, path)).size}, expected = declared.find(file => file.path === path);
    if (path !== 'manifest.json' && (!expected || expected.bytes !== actual.bytes)) invalid(path, null, 'bytes');
    files.push({ path, ...actual });
  }
  if (declared.reduce((sum, file) => sum + file.bytes, 0) !== manifest.data.totalPayloadBytes) invalid('manifest.json', null, 'totalPayloadBytes');
  for (const file of ['validation-report.json', 'selection-report.json']) jsonFile(root, file);
  for (const _record of csvObjects(join(root, 'adjustment-lineage.csv'), 'adjustment-lineage.csv', undefined, signal)) { signal?.throwIfAborted(); }
  const businessFiles = names.filter(file => /^zhejiang_\d{4}-\d{2}-\d{2}\.csv$/.test(file));
  if (!businessFiles.length || businessFiles.length !== manifest.data.businessFiles || files.filter(file => businessFiles.includes(file.path)).reduce((sum, file) => sum + file.bytes, 0) !== manifest.data.businessBytes) invalid('manifest.json', null, 'businessFiles');
  const allowed = new Set([...required, 'manifest.json', ...businessFiles, ...businessFiles.map(file => file.replace(/\.csv$/, '.metadata.json'))]);
  if (names.includes('README.md')) allowed.add('README.md');
  if (names.some(file => !allowed.has(file)) || [...allowed].some(file => !names.includes(file))) invalid('manifest.json', null, 'files');
  const lockSchema = z.object({ schema: z.enum(['medclaw.source-lock/v1','medclaw.source-lock/v2']), sources: z.array(z.object({ source: z.string().min(1), path: z.string().min(1) }).passthrough()).min(1) }).passthrough();
  const lock = lockSchema.safeParse(jsonFile(root, 'source-lock.json'));
  if (!lock.success) invalid('source-lock.json', null, null);
  const sourceRefs = new Set(lock.data.sources.map(source => canonicalRequest([source.source, source.path])));
  if (sourceRefs.size !== lock.data.sources.length) invalid('source-lock.json', null, 'sources');
  const masters: Record<string, string>[] = [];
  for (const item of csvObjects(join(root, 'entity-lineage.csv'), 'entity-lineage.csv', undefined, signal)) if (item.value.record_type === 'master') {
    if (['device_id', 'device_name', 'source_submission_id', 'source_applicant', 'category'].some(key => !item.value[key])) invalid('entity-lineage.csv', item.row, 'master');
    masters.push(item.value);
    if (masters.length > PACKAGE_LIMITS.rows) invalid('entity-lineage.csv', item.row, 'master');
  }
  masters.sort((a, b) => a.device_id! < b.device_id! ? -1 : a.device_id! > b.device_id! ? 1 : 0);
  const masterById = new Map(masters.map(master => [master.device_id!, master]));
  if (!masters.length || masterById.size !== masters.length) invalid('entity-lineage.csv', null, 'device_id');
  const days: CheckedPackage['days'] = [];
  let rowCount = 0;
  for (const file of businessFiles) {
    const metadataFile = file.replace(/\.csv$/, '.metadata.json');
    const parsed = SnapshotMetadataSchema.safeParse(omitLegacyFields(jsonFile(root, metadataFile), ['fileSha256','sourceLockHash','cohortHash']));
    if (!parsed.success) invalid(metadataFile, null, String(parsed.error.issues[0]?.path[0] ?? 'metadata'));
    const metadata = {...parsed.data,contract:'medclaw.snapshot/v2' as const};
    if (metadata.snapshotDate !== file.slice(9, 19) || metadata.mappingVersion !== mappingVersion || metadata.expectedEntityCount !== masters.length) invalid(metadataFile, null, 'binding');
    try { new Intl.DateTimeFormat('en', { timeZone: metadata.timezone }); } catch { invalid(metadataFile, null, 'timezone'); }
    if (metadata.declaredMissingEntityIds.length && !metadata.missingReason) invalid(metadataFile, null, 'missingReason');
    const ids = new Set<string>();
    for (const row of readPackageRows(root, file, metadata, signal)) {
      const master = masterById.get(row.sourceDeviceId);
      if (!master || ids.has(row.sourceDeviceId)) invalid(file, Number(row.sourceRowRef.split(':').at(-1)), 'device_id');
      if (master.source_submission_id !== row.sourceSubmissionId || master.source_applicant !== row.sourceApplicant || master.device_name !== row.deviceName || master.category !== row.category) invalid(file, Number(row.sourceRowRef.split(':').at(-1)), 'entity-lineage');
      if (row.sourceRefs.some(ref => !sourceRefs.has(canonicalRequest([ref.sourceId, ref.file])))) invalid(file, Number(row.sourceRowRef.split(':').at(-1)), 'source_refs_json');
      ids.add(row.sourceDeviceId); rowCount++;
      if (rowCount > PACKAGE_LIMITS.rows) invalid(file, null, 'rowCount');
      if (rowCount % 500 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); signal?.throwIfAborted(); }
    }
    const missing = new Set(metadata.declaredMissingEntityIds);
    if (missing.size !== metadata.declaredMissingEntityIds.length || [...missing].some(id => !masterById.has(id) || ids.has(id)) || ids.size !== metadata.observedEntityCount || ids.size + missing.size !== masters.length) invalid(metadataFile, null, 'coverage');
    days.push({ file, metadata });
  }
  days.sort((a, b) => a.metadata.snapshotDate.localeCompare(b.metadata.snapshotDate));
  const first = days[0]!.metadata, last = days.at(-1)!.metadata, dates = new Set<string>();
  const bindingKeys = ['sourceBundleId', 'scopeKey', 'region', 'mappingVersion', 'materialVersion', 'generatorVersion', 'seed', 'referenceDate', 'timezone'] as const;
  for (const day of days) {
    if (dates.has(day.metadata.snapshotDate) || bindingKeys.some(key => day.metadata[key] !== first[key])) invalid(day.file.replace(/\.csv$/, '.metadata.json'), null, 'binding');
    dates.add(day.metadata.snapshotDate);
  }
  if (first.referenceDate < first.snapshotDate || first.referenceDate > last.snapshotDate || rowCount !== manifest.data.businessRows) invalid('manifest.json', null, 'businessRows');
  return { root, files, masters, days, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), rowCount, calculationVersion: DIFF_CALCULATION_VERSION };
}

export class ImportService implements ImportServicePort {
  private readonly instanceId: string;
  private closing = false;
  private readonly active = new Map<string, { controller: AbortController; method: 'preview' | 'commit'; request: string; promise: Promise<Result<ImportPreview> | Result<ImportOperation>> }>();
  private readonly diff = new DiffService();
  constructor(private readonly dependencies: { store: ImportStore; artifacts: ArtifactStore; resolveToken: (fileToken: string, operationRef: string) => string | Promise<string>; instanceId?: string; assertWritable?: () => void }) { this.instanceId = dependencies.instanceId ?? randomUUID(); }
  get busy() { return this.active.size > 0; }
  private previewOf(operationRef: string, pkg: CheckedPackage, catalogRevision: number): ImportPreview {
    const classification = this.dependencies.store.classify(pkg,(file,metadata)=>readPackageRows(pkg.root,file,metadata)), first = pkg.days[0]!.metadata;
    const preview: ImportPreview = { operationRef, inputKind: 'snapshot_package', fileCount: pkg.fileCount, totalBytes: pkg.totalBytes, batchCount: pkg.days.length, entityCount: pkg.masters.length, mappingVersion: first.mappingVersion, rowCount: pkg.rowCount, sourceBundleId: first.sourceBundleId, materialVersion: first.materialVersion, region: first.region, dateRange: { start: first.snapshotDate, endInclusive: pkg.days.at(-1)!.metadata.snapshotDate }, referenceDate: first.referenceDate, timezone: first.timezone, catalogRevision, ...classification, scopeKeys: [...new Set(pkg.days.map(day => day.metadata.scopeKey))], snapshotDates: pkg.days.map(day => day.metadata.snapshotDate), canCommit: true, issues: [] };
    return preview;
  }
  preview(request: ImportPreviewRequest): Promise<Result<ImportPreview>> {
    return serviceResult(async () => {
      if (this.closing) throw new Error('host_interrupted');
      const parsed = ImportPreviewRequestSchema.parse(request), current = this.dependencies.store.read(parsed.operationRef);
      if (current && canonicalRequest(current.previewRequest) !== canonicalRequest(parsed)) throw new Error('state_conflict');
      const running = this.active.get(parsed.operationRef);
      if (running) { if (running.method !== 'preview' || running.request !== canonicalRequest(parsed)) throw new Error('state_conflict'); const result = await running.promise; if (!result.ok) throw result.error; return result.data as ImportPreview; }
      if (current) { if (current.operation.preview) return current.operation.preview; throw current.operation.error ?? new Error('operation_result_unknown'); }
      this.dependencies.assertWritable?.();
      const controller = new AbortController();
      const promise = this.prepare(parsed, controller.signal);
      this.active.set(parsed.operationRef, { controller, method: 'preview', request: canonicalRequest(parsed), promise });
      try { const result = await promise; if (!result.ok) throw result.error; return result.data; } finally { this.active.delete(parsed.operationRef); }
    }, 'storage_write_failed', { operationRef: request.operationRef });
  }
  private async prepare(request: ImportPreviewRequest, signal: AbortSignal): Promise<Result<ImportPreview>> {
    return serviceResult(async () => {
      const record = this.dependencies.store.begin(request, this.instanceId), artifactId = record.operation.artifactId!;
      let validated: CheckedPackage | null = null;
      try {
        const sourceRoot = await this.dependencies.resolveToken(request.fileToken, request.operationRef);
        signal.throwIfAborted(); await this.dependencies.artifacts.copy(artifactId, request.operationRef, sourceRoot, signal);
        const pkg = await checkSnapshotPackage(this.dependencies.artifacts.inputPath(artifactId), request.mappingVersion, signal);
        validated = pkg;
        const preview = this.previewOf(request.operationRef, pkg, this.dependencies.store.revision());
        signal.throwIfAborted(); await this.dependencies.artifacts.writeManifest(artifactId, request.operationRef, pkg);
        signal.throwIfAborted(); this.dependencies.store.update(request.operationRef, { state: 'ready', preview, error: null }); return preview;
      } catch (error) {
        if (signal.aborted) { this.dependencies.store.update(request.operationRef, { state: 'cancelled', error: safeError('import_cancelled') }); throw new Error('import_cancelled'); }
        if (error instanceof PackageInvalid || error instanceof Error && ['import_conflict', 'import_invalid'].includes(error.message)) {
          const issue = error instanceof PackageInvalid ? error.issue : { file: null, row: null, field: null, code: error.message, message: error.message === 'import_conflict' ? 'This package conflicts with immutable imported history.' : 'The package directory does not meet the snapshot contract.' };
          const preview: ImportPreview = { operationRef: request.operationRef, inputKind: 'snapshot_package', fileCount: 0, totalBytes: 0, batchCount: 0, entityCount: 0, mappingVersion: request.mappingVersion, rowCount: 0, sourceBundleId: '', materialVersion: '', region: '', dateRange: { start: '', endInclusive: '' }, referenceDate: '', timezone: '', catalogRevision: this.dependencies.store.revision(), newBatchCount: 0, duplicateBatchCount: 0, scopeKeys: [], snapshotDates: [], canCommit: false, issues: [issue, { file: null, row: null, field: 'rowCount', code: 'count_incomplete', message: 'Validation stopped before a complete business row count was established.' }] };
          if (validated) {
            const first = validated.days[0]!.metadata;
            Object.assign(preview, { fileCount: validated.fileCount, totalBytes: validated.totalBytes, batchCount: validated.days.length, entityCount: validated.masters.length, rowCount: validated.rowCount, sourceBundleId: first.sourceBundleId, materialVersion: first.materialVersion, region: first.region, dateRange: { start: first.snapshotDate, endInclusive: validated.days.at(-1)!.metadata.snapshotDate }, referenceDate: first.referenceDate, timezone: first.timezone, scopeKeys: [first.scopeKey], snapshotDates: validated.days.map(day => day.metadata.snapshotDate), issues: [issue] });
          }
          this.dependencies.store.update(request.operationRef, { state: 'rejected', preview, result: { importId: record.id, status: 'rejected', batchIds: [], rowCount: preview.rowCount, acceptedRows: 0, duplicateRows: 0, rejectedRows: preview.rowCount, issues: preview.issues, sourceBundleId: preview.sourceBundleId, materialVersion: preview.materialVersion, artifactId }, error: safeError(issue.code) }); return preview;
        }
        const code = error instanceof Error && error.message === 'file_token_invalid' ? 'file_token_invalid' : 'storage_write_failed';
        this.dependencies.store.update(request.operationRef, { state: 'failed', error: safeError(code) }); throw new Error(code);
      }
    }, 'storage_write_failed', { operationRef: request.operationRef });
  }
  commit(request: ImportCommitRequest): Promise<Result<ImportOperation>> {
    return serviceResult(async () => {
      if (this.closing) throw new Error('host_interrupted');
      const parsed = ImportCommitRequestSchema.parse(request), record = this.dependencies.store.read(parsed.operationRef);
      if (!record) throw new Error('operation_not_found');
      if (record.commitRequest && canonicalRequest(record.commitRequest) !== canonicalRequest(parsed)) throw new Error('state_conflict');
      const active = this.active.get(parsed.operationRef);
      if (active) { if (active.method !== 'commit' || active.request !== canonicalRequest(parsed)) throw new Error('state_conflict'); const result = await active.promise; if (!result.ok) throw result.error; return result.data as ImportOperation; }
      if (['imported', 'duplicate', 'cancelled', 'rejected', 'failed', 'interrupted'].includes(record.operation.state)) return record.operation;
      this.dependencies.assertWritable?.();
      if (record.operation.state !== 'ready' || !record.operation.preview?.canCommit) throw new Error('operation_result_unknown');
      const controller = new AbortController();
      const promise = this.confirm(parsed, controller.signal);
      this.active.set(parsed.operationRef, { controller, method: 'commit', request: canonicalRequest(parsed), promise });
      try { const result = await promise; if (!result.ok) throw result.error; return result.data; } finally { this.active.delete(parsed.operationRef); }
    }, 'storage_write_failed', { operationRef: request.operationRef });
  }
  private async confirm(request: ImportCommitRequest, signal: AbortSignal): Promise<Result<ImportOperation>> {
    return serviceResult(async () => {
      const original = this.dependencies.store.read(request.operationRef)!, preview = original.operation.preview!, artifactId = original.operation.artifactId!;
      try {
        signal.throwIfAborted(); this.dependencies.store.update(request.operationRef, { state: 'committing', commitRequest: request, error: null });
        const source = await this.dependencies.resolveToken(request.fileToken, request.operationRef);
        let pkg: CheckedPackage;
        try {
          const sourcePackage = await checkSnapshotPackage(source, preview.mappingVersion, signal);
          pkg = await checkSnapshotPackage(this.dependencies.artifacts.inputPath(artifactId), preview.mappingVersion, signal);
          await this.dependencies.artifacts.verifyManifest(artifactId, request.operationRef, pkg);
          if (canonicalRequest(sourcePackage) !== canonicalRequest({...pkg,root:sourcePackage.root})) throw new Error('import_preview_stale');
          for(const file of pkg.files) if(!await filesEqual(join(source,file.path),join(pkg.root,file.path),signal)) throw new Error('import_preview_stale');
        } catch (error) { if (signal.aborted) throw error; throw new Error('import_preview_stale'); }
        if (this.dependencies.store.revision() !== preview.catalogRevision || canonicalRequest(this.previewOf(request.operationRef, pkg, preview.catalogRevision)) !== canonicalRequest(preview)) throw new Error('import_preview_stale');
        signal.throwIfAborted();
        return this.dependencies.store.commit(request.operationRef, pkg, preview, (file, metadata) => readPackageRows(pkg.root, file, metadata, signal), (oldRows, newRows, oldId, newId) => this.diff.compare(oldRows, newRows, oldId, newId));
      } catch (error) {
        const code = signal.aborted ? 'import_cancelled' : error instanceof Error && ['import_preview_stale', 'import_conflict', 'file_token_invalid'].includes(error.message) ? error.message : 'storage_write_failed';
        const state = code === 'import_cancelled' ? 'cancelled' : code === 'import_preview_stale' || code === 'import_conflict' ? 'rejected' : 'failed';
        this.dependencies.store.update(request.operationRef, { state, commitRequest: request, ...(state === 'rejected' ? { result: { importId: original.id, status: 'rejected' as const, batchIds: [], rowCount: preview.rowCount, acceptedRows: 0, duplicateRows: 0, rejectedRows: preview.rowCount, issues: [{ file: null, row: null, field: null, code, message: safeError(code).message }], sourceBundleId: preview.sourceBundleId, materialVersion: preview.materialVersion, artifactId } } : {}), error: safeError(code) }); throw new Error(code);
      }
    }, 'storage_write_failed', { operationRef: request.operationRef });
  }
  read(operationRef: string): Promise<Result<ImportOperation | null>> { return serviceResult(() => this.dependencies.store.read(OpaqueIdSchema.parse(operationRef))?.operation ?? null, 'storage_read_failed', { operationRef }); }
  cancel(operationRef: string): Promise<Result<ImportOperation>> {
    return serviceResult(() => {
      const record = this.dependencies.store.read(OpaqueIdSchema.parse(operationRef)); if (!record) throw new Error('operation_not_found');
      if (!['preparing', 'ready', 'committing'].includes(record.operation.state)) return record.operation;
      this.active.get(operationRef)?.controller.abort();
      return this.dependencies.store.update(operationRef, { state: 'cancelled', error: safeError('import_cancelled') });
    }, 'storage_write_failed', { operationRef });
  }
  recover(operationRef: string): Promise<Result<ImportOperation>> {
    return serviceResult(async () => {
      const record = this.dependencies.store.read(OpaqueIdSchema.parse(operationRef)); if (!record) throw new Error('operation_not_found');
      if (this.active.has(operationRef)) throw new Error('runtime_busy');
      if (record.operation.state === 'imported' || record.operation.state === 'duplicate') {
        this.dependencies.store.verifyCommitted(operationRef);
        await this.dependencies.artifacts.verifyManifest(record.operation.artifactId!, operationRef); return record.operation;
      }
      this.dependencies.assertWritable?.();
      if (record.operation.state === 'preparing' || record.operation.state === 'committing') {
        if (record.instanceId === this.instanceId) throw new Error('operation_result_unknown');
        return this.dependencies.store.update(operationRef, { state: 'interrupted', error: safeError('host_interrupted') });
      }
      if (record.operation.state === 'ready') await this.dependencies.artifacts.verifyManifest(record.operation.artifactId!, operationRef);
      return record.operation;
    }, 'storage_read_failed', { operationRef });
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    const operations = [...this.active.values()];
    for (const operation of operations) operation.controller.abort();
    await Promise.allSettled(operations.map(operation => operation.promise));
    this.dependencies.store.assertWritable();
  }
}
