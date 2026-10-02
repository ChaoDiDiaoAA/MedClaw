import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { ImportOperationSchema, ImportPreviewRequestSchema, ImportCommitRequestSchema, type CheckedPackage, type ImportRecord, type ImportStore, type ImportPreviewRequest, type ImportCommitRequest, type ImportOperation, type ImportPreview, type ImportResult, type ImportRow, type SnapshotMetadata, type DiffEvent } from '../../contracts/src/data';
import { canonicalRequest } from '../../contracts/src/run';
import { SnapshotSchema, type Snapshot } from '../../contracts/src/query';

type ImportDbRow = { id: number; instance_id: string; preview_request_json: string; commit_request_json: string | null; operation_ref: string; prior_operation_ref: string | null; state: string; preview_json: string | null; result_json: string | null; artifact_id: number | null; error_json: string | null; updated_at: string };
type BatchRow = { id: number; snapshot_date: string; source_bundle_id: string; source_lock_hash: string; region: string; cohort_hash: string; metadata_json: string; content_hash: string };
const fingerprint = (value: unknown) => createHash('sha256').update(canonicalRequest(value)).digest('hex');

export class SqliteImportStore implements ImportStore {
  private writesBlocked = false;
  constructor(private readonly db: Database) {}
  read(operationRef: string): ImportRecord | null {
    const row = this.db.query<ImportDbRow, [string]>('SELECT i.*,p.operation_ref prior_operation_ref FROM imports i LEFT JOIN imports p ON p.id=i.prior_import_id WHERE i.operation_ref=?').get(operationRef);
    if (!row) return null;
    return { id: row.id, instanceId: row.instance_id, previewRequest: ImportPreviewRequestSchema.parse(JSON.parse(row.preview_request_json)), commitRequest: row.commit_request_json ? ImportCommitRequestSchema.parse(JSON.parse(row.commit_request_json)) : null,
      operation: ImportOperationSchema.parse({ operationRef: row.operation_ref, priorOperationRef: row.prior_operation_ref, state: row.state, preview: row.preview_json ? JSON.parse(row.preview_json) : null, result: row.result_json ? JSON.parse(row.result_json) : null, artifactId: row.artifact_id, error: row.error_json ? JSON.parse(row.error_json) : null, updatedAt: row.updated_at }) };
  }
  begin(request: ImportPreviewRequest, instanceId: string): ImportRecord {
    this.assertWritable();
    return this.db.transaction(() => {
      const previous = this.read(request.operationRef);
      if (previous) {
        if (canonicalRequest(previous.previewRequest) !== canonicalRequest(request)) throw new Error('state_conflict');
        return previous;
      }
      const prior = request.priorOperationRef ? this.read(request.priorOperationRef) : null;
      if (request.priorOperationRef && !prior) throw new Error('operation_not_found');
      const now = new Date().toISOString();
      const inserted = this.db.query('INSERT INTO imports(operation_ref,prior_import_id,instance_id,state,preview_request_hash,preview_request_json,created_at,updated_at) VALUES(?,?,?,\'preparing\',?,?,?,?)').run(request.operationRef, prior?.id ?? null, instanceId, fingerprint(request), canonicalRequest(request), now, now);
      const artifact = this.db.query('INSERT INTO artifacts(operation_ref,kind,import_id,format,mime_type) VALUES(?,\'import\',?,\'csv\',\'application/x-directory\')').run(request.operationRef, inserted.lastInsertRowid);
      this.db.query('UPDATE imports SET artifact_id=? WHERE id=?').run(artifact.lastInsertRowid, inserted.lastInsertRowid);
      return this.read(request.operationRef)!;
    }).immediate();
  }
  update(operationRef: string, patch: { state: ImportOperation['state']; preview?: ImportPreview; error?: ImportOperation['error']; result?: ImportResult; commitRequest?: ImportCommitRequest }): ImportOperation {
    this.assertWritable();
    const original = this.read(operationRef); if (!original) throw new Error('operation_not_found');
    try {
      const now = new Date().toISOString();
      this.db.query('UPDATE imports SET state=?,preview_json=?,result_json=?,error_json=?,commit_request_json=?,commit_request_hash=?,fingerprint=?,updated_at=?,cancel_requested_at=CASE WHEN ?=\'cancelled\' THEN ? ELSE cancel_requested_at END WHERE operation_ref=?').run(patch.state, patch.preview ? canonicalRequest(patch.preview) : original.operation.preview ? canonicalRequest(original.operation.preview) : null,
        patch.result ? canonicalRequest(patch.result) : original.operation.result ? canonicalRequest(original.operation.result) : null, patch.error === undefined ? original.operation.error ? canonicalRequest(original.operation.error) : null : patch.error ? canonicalRequest(patch.error) : null,
        patch.commitRequest ? canonicalRequest(patch.commitRequest) : original.commitRequest ? canonicalRequest(original.commitRequest) : null, patch.commitRequest ? fingerprint(patch.commitRequest) : original.commitRequest ? fingerprint(original.commitRequest) : null,
        (patch.preview ?? original.operation.preview)?.sourceHash ?? null, now, patch.state, now, operationRef);
      return this.read(operationRef)!.operation;
    } catch (error) { this.writesBlocked = true; throw error; }
  }
  private assertWritable() { if (this.writesBlocked) throw new Error('operation_result_unknown'); }
  revision(): number {
    const row = this.db.query<{ revision: number }, []>('SELECT revision FROM catalog_state WHERE id=1').get();
    if (!row) throw new Error('storage_read_failed'); return row.revision;
  }
  verifyCommitted(operationRef: string): void {
    const record = this.read(operationRef), result = record?.operation.result, preview = record?.operation.preview;
    if (!record || !result || !preview || !['imported', 'duplicate'].includes(record.operation.state)) throw new Error('operation_result_unknown');
    const batches = result.batchIds.map(id => this.db.query<BatchRow, [number]>('SELECT * FROM batches WHERE id=?').get(id));
    if (batches.some(batch => !batch) || batches.length !== preview.batchCount || canonicalRequest(batches.map(batch => batch!.snapshot_date).sort()) !== canonicalRequest(preview.snapshotDates) || batches.some(batch => batch!.source_bundle_id !== result.sourceBundleId)) throw new Error('storage_read_failed');
    const count = result.batchIds.reduce((sum, id) => sum + (this.db.query<{ n: number }, [number]>('SELECT count(*) n FROM snapshots WHERE batch_id=?').get(id)?.n ?? 0), 0);
    const artifact = this.db.query<{ status: string; import_id: number }, [number]>('SELECT status,import_id FROM artifacts WHERE id=?').get(result.artifactId!);
    if (count !== result.rowCount || artifact?.status !== 'ready' || artifact.import_id !== record.id || !this.db.query('SELECT id FROM business_events WHERE operation_ref=? AND type=?').get(operationRef, `import.${result.status}`)) throw new Error('storage_read_failed');
  }
  classify(pkg: CheckedPackage): { newBatchCount: number; duplicateBatchCount: number } {
    let newBatchCount = 0, duplicateBatchCount = 0;
    for (const day of pkg.days) {
      const metadata = day.metadata;
      const latest = this.db.query<BatchRow, [string]>('SELECT * FROM batches WHERE scope_key=? ORDER BY snapshot_date DESC LIMIT 1').get(metadata.scopeKey);
      if (latest && (latest.source_bundle_id !== metadata.sourceBundleId || latest.source_lock_hash !== metadata.sourceLockHash || latest.region !== metadata.region || latest.cohort_hash !== metadata.cohortHash)) throw new Error('import_conflict');
      const existing = this.db.query<BatchRow, [string, string]>('SELECT * FROM batches WHERE scope_key=? AND snapshot_date=?').get(metadata.scopeKey, metadata.snapshotDate);
      if (existing) {
        if (existing.content_hash !== day.contentHash || canonicalRequest(JSON.parse(existing.metadata_json)) !== canonicalRequest(metadata)) throw new Error('import_conflict');
        duplicateBatchCount++;
      } else {
        if (latest && metadata.snapshotDate <= latest.snapshot_date) throw new Error('import_conflict');
        newBatchCount++;
      }
    }
    return { newBatchCount, duplicateBatchCount };
  }
  private snapshots(batchId: number): Snapshot[] {
    return this.db.query<Record<string, unknown>, [number]>('SELECT * FROM snapshots WHERE batch_id=? ORDER BY device_id').all(batchId).map(row => SnapshotSchema.parse({ id: row.id, batchId: row.batch_id, deviceId: row.device_id, deviceName: row.device_name, category: row.category, region: row.region, priceCents: row.price_cents, currency: row.currency, unit: row.unit, status: row.status, manufacturer: row.manufacturer, distributor: row.distributor, sourceRowRef: row.source_row_ref, sourceRefs: JSON.parse(String(row.source_refs_json)), fieldOrigins: JSON.parse(String(row.field_origins_json)) }));
  }
  commit(operationRef: string, pkg: CheckedPackage, preview: ImportPreview, rows: (file: string, metadata: SnapshotMetadata) => Iterable<ImportRow>, diff: (oldRows: Snapshot[], newRows: Snapshot[], oldBatchId: number, newBatchId: number) => DiffEvent[]): ImportOperation {
    this.assertWritable();
    return this.db.transaction(() => {
      const record = this.read(operationRef);
      if (!record || record.operation.state !== 'committing') throw new Error('state_conflict');
      if (record.operation.preview?.previewHash !== preview.previewHash || this.revision() !== preview.catalogRevision) throw new Error('import_preview_stale');
      const classification = this.classify(pkg), now = new Date().toISOString(), revision = preview.catalogRevision + (classification.newBatchCount ? 1 : 0);
      const deviceIds = new Map<string, number>(), createdDeviceIds = new Set<number>();
      const insertDevice = this.db.query('INSERT INTO devices(source_device_id,source_bundle_id,source_submission_id,source_applicant,source_refs_json,created_at) VALUES(?,?,?,?,?,?)');
      const sourceBundleId = pkg.days[0]!.metadata.sourceBundleId;
      for (const master of pkg.masters) {
        const existing = this.db.query<{ id: number; source_bundle_id: string; source_submission_id: string; source_applicant: string | null }, [string]>('SELECT * FROM devices WHERE source_device_id=?').get(master.device_id!);
        if (existing && (existing.source_bundle_id !== sourceBundleId || existing.source_submission_id !== master.source_submission_id || existing.source_applicant !== master.source_applicant)) throw new Error('import_conflict');
        const id = existing?.id ?? Number(insertDevice.run(master.device_id!, sourceBundleId, master.source_submission_id!, master.source_applicant!, '[]', now).lastInsertRowid);
        if (!existing) createdDeviceIds.add(id); deviceIds.set(master.device_id!, id);
      }
      const insertSnapshot = this.db.query('INSERT INTO snapshots(batch_id,device_id,device_name,category,region,price_cents,currency,unit,status,manufacturer,distributor,source_row_ref,source_refs_json,field_origins_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const insertEvent = this.db.query('INSERT INTO change_events(event_key,device_id,old_batch_id,new_batch_id,kind,field,old_value_json,new_value_json,delta_cents,ratio,calculation_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      const batchIds: number[] = []; let acceptedRows = 0, duplicateRows = 0;
      for (const day of pkg.days) {
        const meta = day.metadata;
        const existing = this.db.query<{ id: number }, [string, string]>('SELECT id FROM batches WHERE scope_key=? AND snapshot_date=?').get(meta.scopeKey, meta.snapshotDate);
        if (existing) { batchIds.push(existing.id); duplicateRows += meta.observedEntityCount; continue; }
        const previous = this.db.query<{ id: number }, [string]>('SELECT id FROM batches WHERE scope_key=? ORDER BY snapshot_date DESC LIMIT 1').get(meta.scopeKey);
        const batchId = Number(this.db.query('INSERT INTO batches(import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(record.id, meta.scopeKey, meta.snapshotDate, meta.region, meta.materialVersion, meta.sourceBundleId, meta.sourceLockHash, day.contentHash, meta.coverage, meta.cohortHash, meta.expectedEntityCount, meta.observedEntityCount, canonicalRequest(meta.declaredMissingEntityIds.map(id => deviceIds.get(id)!)), canonicalRequest(meta), previous ? 0 : 1, previous?.id ?? null, revision, now).lastInsertRowid);
        batchIds.push(batchId);
        const content = createHash('sha256').update(canonicalRequest({ metadata: meta, mappingVersion: meta.mappingVersion, calculationVersion: pkg.calculationVersion })).update('\n');
        let dayRows = 0;
        for (const row of rows(day.file, meta)) {
          const deviceId = deviceIds.get(row.sourceDeviceId)!;
          insertSnapshot.run(batchId, deviceId, row.deviceName, row.category, row.region, row.priceCents, row.currency, row.unit, row.status, row.manufacturer, row.distributor, row.sourceRowRef, canonicalRequest(row.sourceRefs), canonicalRequest(row.fieldOrigins));
          if (createdDeviceIds.delete(deviceId)) this.db.query('UPDATE devices SET source_refs_json=? WHERE id=?').run(canonicalRequest(row.sourceRefs), deviceId);
          content.update(canonicalRequest(row)).update('\n'); dayRows++; acceptedRows++;
        }
        if (dayRows !== meta.observedEntityCount || content.digest('hex') !== day.contentHash) throw new Error('import_preview_stale');
        if (previous) for (const event of diff(this.snapshots(previous.id), this.snapshots(batchId), previous.id, batchId)) insertEvent.run(event.eventKey, event.deviceId, event.oldBatchId, event.newBatchId, event.kind, event.field, canonicalRequest(event.oldValue), canonicalRequest(event.newValue), event.deltaCents, event.ratio, event.calculationVersion, now);
      }
      if (classification.newBatchCount) this.db.query('UPDATE catalog_state SET revision=?,updated_at=? WHERE id=1').run(revision, now);
      const result: ImportResult = { importId: record.id, status: classification.newBatchCount ? 'imported' : 'duplicate', batchIds, rowCount: pkg.rowCount, acceptedRows, duplicateRows, rejectedRows: 0, issues: [], sourceBundleId, materialVersion: pkg.days[0]!.metadata.materialVersion, artifactId: record.operation.artifactId };
      const artifact = this.db.query('UPDATE artifacts SET status=\'ready\',published_at=?,registered_at=? WHERE id=? AND metadata_sha256 IS NOT NULL').run(now, now, record.operation.artifactId!);
      if (artifact.changes !== 1) throw new Error('storage_write_failed');
      this.db.query('INSERT INTO business_events(operation_ref,type,actor,import_id,artifact_id,details_json,occurred_at) VALUES(?,?,\'user\',?,?,?,?)').run(operationRef, `import.${result.status}`, record.id, record.operation.artifactId!, canonicalRequest({ batchIds, acceptedRows, duplicateRows, catalogRevision: revision }), now);
      return this.update(operationRef, { state: result.status, result, error: null });
    }).immediate();
  }
}
