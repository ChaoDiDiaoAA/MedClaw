import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema, type AppError } from '../../contracts/src/error';
import { canonicalRequest, RunScopeSchema } from '../../contracts/src/run';
import { EvidenceSummarySchema } from '../../contracts/src/query';
import { EXPORT_VERSION, ExportArtifactSchema, ExportCopyReceiptSchema, ExportFormatSchema, ExportHashSchema, ExportListInputSchema,
  ExportOperationSchema, FrozenExportSourceSchema, PublishedExportSchema, type AcceptedExport, type ExportCopyReceipt, type ExportCopyState,
  type ExportStore, type FrozenExportSource, type PublishedExport, type StoredExport } from '../../contracts/src/export';
import { SqliteToolStore } from './tool-store';
import { HistorySourceStore } from './history-source-store';
import { Repositories } from './repositories';
import { SqliteWriteTransactions } from './write-transactions';

const terminal = (state: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(state);
const hash = (value: unknown) => createHash('sha256').update(canonicalRequest(value)).digest('hex');
const json = (value: unknown) => value === null ? null : canonicalRequest(value);
type ExportRow = { id: number; operation_ref: string; prior_export_id: number | null; prior_operation_ref: string | null; instance_id: string;
  session_id: number; query_id: number; answer_id: number | null; format: string; request_hash: string; state: string; artifact_id: number | null;
  published_hash: string | null; copy_state: string; copy_receipt_json: string | null; error_json: string | null;
  cancel_requested_at: string | null; created_at: string; updated_at: string };
type ArtifactRow = { id: number; operation_ref: string; kind: string; export_id: number | null; query_id: number | null; format: string;
  relative_path: string | null; sha256: string | null; bytes: number | null; metadata_sha256: string | null; published_at: string | null;
  registered_at: string | null; status: string; metadata_json: string };

export class SqliteExportStore implements ExportStore {
  private readonly transactions: SqliteWriteTransactions;
  constructor(private readonly db: Database) { this.transactions = SqliteWriteTransactions.forDatabase(db); }

  readSource(queryId: number, answerId: number | null): FrozenExportSource {
    PositiveIdSchema.parse(queryId); PositiveIdSchema.nullable().parse(answerId);
    const store = new SqliteToolStore(this.db), query = store.readQuery(queryId);
    if (!query) throw new Error('operation_not_found');
    const owner = this.db.query<{ kind: string; session_id: number; scope_json: string; reference_date: string; timezone: string;
      session_kind: string; session_status: string }, [number]>(`SELECT r.*,s.kind session_kind,s.status session_status
      FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id=?`).get(query.runId);
    if (!owner || owner.kind !== 'agent' || owner.session_kind !== 'user' || owner.session_status !== 'active' || owner.session_id !== query.sessionId) throw new Error('access_denied');
    const scope = RunScopeSchema.parse(JSON.parse(owner.scope_json));
    if (query.batchIds.some(id => !scope.batchIds.includes(id)) || scope.deviceIds !== null
      && (query.scopeDeviceIds === null || query.scopeDeviceIds.some(id => !scope.deviceIds!.includes(id)))) throw new Error('access_denied');
    const history = new HistorySourceStore(this.db);
    history.query(queryId, 1, 1); // Reuse historical hash verification; never execute QueryService.
    const answerRun = answerId === null ? null : this.db.query<{ run_id: number }, [number]>('SELECT run_id FROM answers WHERE id=?').get(answerId);
    if (answerId !== null && !answerRun) throw new Error('access_denied');
    const answer = answerRun ? new Repositories(this.db).readAnswer(answerRun.run_id) : null;
    if (answerId !== null && (!answer || answer.id !== answerId || answer.sessionId !== query.sessionId || !answer.queryIds.includes(queryId))) throw new Error('access_denied');
    const evidence = store.listEvidence(queryId).map(item => {
      if (item.resultHash !== query.resultHash || item.batchIds.some(id => !query.batchIds.includes(id))) throw new Error('storage_read_failed');
      const { snapshotIds, eventIds, sourceRowRefs: _refs, ...metadata } = item;
      return EvidenceSummarySchema.parse({ ...metadata, snapshotCount: snapshotIds.length, eventCount: eventIds.length });
    });
    return FrozenExportSourceSchema.parse({ query, evidence, answer, referenceDate: owner.reference_date, timezone: owner.timezone, ...history.availability(query.batchIds) });
  }

  find(operationRef: string): StoredExport | null {
    OpaqueIdSchema.parse(operationRef);
    const row = this.db.query<ExportRow, [string]>('SELECT e.*,p.operation_ref prior_operation_ref FROM exports e LEFT JOIN exports p ON p.id=e.prior_export_id WHERE e.operation_ref=?').get(operationRef);
    if (!row) return null;
    const artifact = row.artifact_id === null ? null : this.artifact(row.artifact_id);
    if (row.artifact_id !== null && !artifact) throw new Error('storage_read_failed');
    if (artifact && (artifact.kind !== 'export' || artifact.query_id !== row.query_id || artifact.format !== row.format)) throw new Error('storage_read_failed');
    const copyReceipt = row.copy_receipt_json === null ? null : ExportCopyReceiptSchema.parse(JSON.parse(row.copy_receipt_json));
    const operation = ExportOperationSchema.parse({ operationRef, priorOperationRef: row.prior_operation_ref, state: row.state, requestHash: row.request_hash,
      queryId: row.query_id, answerId: row.answer_id, format: row.format, artifact: artifact?.status === 'ready' ? ExportArtifactSchema.parse({ id: artifact.id,
        operationRef: artifact.operation_ref, queryId: artifact.query_id, format: artifact.format, relativePath: artifact.relative_path, sha256: artifact.sha256,
        metadataSha256: artifact.metadata_sha256, sizeBytes: artifact.bytes, publishedAt: artifact.published_at, registeredAt: artifact.registered_at }) : null,
      publishedHash: row.published_hash, copyState: row.copy_state, error: row.error_json === null ? null : AppErrorSchema.parse(JSON.parse(row.error_json)),
      cancelRequestedAt: row.cancel_requested_at, updatedAt: row.updated_at });
    if (operation.state === 'completed' && (!copyReceipt || copyReceipt.operationRef !== operationRef || copyReceipt.artifactId !== operation.artifact?.id
      || copyReceipt.contentHash !== operation.publishedHash)) throw new Error('storage_read_failed');
    return { ...operation, id: row.id, priorExportId: row.prior_export_id, instanceId: row.instance_id, sessionId: row.session_id,
      reservedArtifactId: row.artifact_id, createdAt: row.created_at, copyReceipt };
  }

  accept(input: AcceptedExport): StoredExport {
    return this.transactions.immediate(() => {
      OpaqueIdSchema.parse(input.operationRef); ExportHashSchema.parse(input.requestHash);
      const old = this.find(input.operationRef);
      if (old) { if (old.requestHash !== input.requestHash) throw new Error('state_conflict'); return old; }
      OpaqueIdSchema.parse(input.instanceId); TimestampSchema.parse(input.createdAt); ExportFormatSchema.parse(input.format);
      const source = this.readSource(input.queryId, input.answerId);
      if (source.query.sessionId !== input.sessionId) throw new Error('access_denied');
      if (this.db.query(`SELECT operation_ref FROM imports WHERE operation_ref=?1 UNION ALL SELECT operation_ref FROM data_deletions WHERE operation_ref=?1
        UNION ALL SELECT creation_operation_ref FROM sessions WHERE creation_operation_ref=?1
        UNION ALL SELECT submission_operation_ref FROM runs WHERE submission_operation_ref=?1
        UNION ALL SELECT operation_ref FROM business_events WHERE operation_ref=?1 LIMIT 1`).get(input.operationRef)) throw new Error('state_conflict');
      const prior = input.priorExportId === null ? null : this.db.query<{ operation_ref: string }, [number]>('SELECT operation_ref FROM exports WHERE id=?').get(PositiveIdSchema.parse(input.priorExportId));
      if (input.priorExportId !== null && !prior) throw new Error('operation_not_found');
      const priorRecord = prior ? this.required(prior.operation_ref) : null;
      if (priorRecord && (priorRecord.sessionId !== input.sessionId || !terminal(priorRecord.state))) throw new Error('state_conflict');
      const reused = input.reuseArtifactId === null ? null : this.artifact(PositiveIdSchema.parse(input.reuseArtifactId));
      if (input.reuseArtifactId !== null && (!reused || reused.status !== 'ready' || reused.kind !== 'export' || reused.query_id !== input.queryId || reused.format !== input.format
        || priorRecord?.reservedArtifactId !== reused.id || priorRecord.queryId !== input.queryId || priorRecord.answerId !== input.answerId || priorRecord.format !== input.format)) throw new Error('state_conflict');
      const inserted = this.db.query(`INSERT INTO exports(operation_ref,prior_export_id,instance_id,session_id,query_id,answer_id,format,request_hash,state,artifact_id,published_hash,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'preparing',?,?,?,?)`).run(input.operationRef, input.priorExportId, input.instanceId, input.sessionId, input.queryId,
          input.answerId, input.format, input.requestHash, reused?.id ?? null, reused?.sha256 ?? null, input.createdAt, input.createdAt);
      if (!reused) {
        const artifact = this.db.query(`INSERT INTO artifacts(operation_ref,kind,export_id,query_id,format,mime_type)
          VALUES(?,'export',?,?,?,?)`).run(input.operationRef, inserted.lastInsertRowid, input.queryId, input.format, input.format === 'csv' ? 'application/x-directory' : input.format === 'json' ? 'application/json' : 'text/markdown');
        this.db.query('UPDATE exports SET artifact_id=? WHERE id=?').run(artifact.lastInsertRowid, inserted.lastInsertRowid);
        this.db.query('UPDATE artifacts SET relative_path=? WHERE id=?').run(`artifacts/${artifact.lastInsertRowid}`, artifact.lastInsertRowid);
      }
      return this.required(input.operationRef);
    });
  }

  publish(operationRef: string, input: PublishedExport): void {
    this.transactions.immediate(() => {
      const record = this.required(operationRef), proof = this.checkProof(record, input);
      if (record.state === 'published') { if (record.publishedHash !== proof.sha256) throw new Error('state_conflict'); return; }
      if (record.state !== 'preparing') throw new Error('state_conflict');
      this.saveArtifact(record, proof, false);
      this.db.query("UPDATE exports SET state='published',published_hash=?,updated_at=? WHERE id=?").run(proof.sha256, new Date().toISOString(), record.id);
    });
  }

  register(operationRef: string, input: PublishedExport): void {
    this.transactions.immediate(() => {
      const record = this.required(operationRef), proof = this.checkProof(record, input), original = this.artifact(proof.artifactId)!;
      if (record.state === 'completed' || record.state === 'copying') {
        if (record.publishedHash !== proof.sha256 || original.status !== 'ready') throw new Error('state_conflict'); return;
      }
      if (original.status !== 'ready') {
        this.saveArtifact(record, proof, true);
        this.db.query(`INSERT INTO business_events(operation_ref,type,actor,session_id,query_id,artifact_id,export_id,details_json,occurred_at)
          VALUES(?,'export_registered','system',?,?,?,?,?,?)`).run(original.operation_ref, record.sessionId, record.queryId, proof.artifactId,
            original.export_id, json({ resultHash: proof.manifest.resultHash, rowCount: this.readSource(record.queryId, record.answerId).query.rows.length, copyState: 'not_started' }), new Date().toISOString());
      }
      this.db.query('UPDATE exports SET state=?,published_hash=?,updated_at=? WHERE id=?').run(terminal(record.state) ? record.state : 'registered', proof.sha256, new Date().toISOString(), record.id);
    });
  }

  beginCopy(operationRef: string): void {
    this.transactions.immediate(() => {
      const record = this.required(operationRef);
      if (record.state === 'copying') return;
      if (record.state !== 'registered' || !record.artifact) throw new Error('state_conflict');
      this.db.query("UPDATE exports SET state='copying',copy_state='copying',updated_at=? WHERE id=?").run(new Date().toISOString(), record.id);
    });
  }

  complete(operationRef: string, input: ExportCopyReceipt): void {
    this.transactions.immediate(() => {
      const record = this.required(operationRef), receipt = ExportCopyReceiptSchema.parse(input);
      if (record.state === 'completed') { if (canonicalRequest(record.copyReceipt) !== canonicalRequest(receipt)) throw new Error('state_conflict'); return; }
      if (record.state !== 'copying' || !record.artifact || receipt.operationRef !== operationRef || receipt.artifactId !== record.artifact.id
        || receipt.contentHash !== record.publishedHash) throw new Error('state_conflict');
      const source = this.readSource(record.queryId, record.answerId), manifest = this.artifact(record.artifact.id)!;
      const proof = this.checkProof(record, { artifactId: manifest.id, relativePath: manifest.relative_path, manifest: JSON.parse(manifest.metadata_json), sha256: manifest.sha256,
        sizeBytes: manifest.bytes, metadataSha256: manifest.metadata_sha256, publishedAt: manifest.published_at });
      const expectedHash = hash({ queryId: record.queryId, resultHash: source.query.resultHash, answerId: record.answerId,
        answerTextHash: source.answer ? createHash('sha256').update(source.answer.text).digest('hex') : null,
        format: record.format, exportVersion: EXPORT_VERSION, priorOperationRef: record.priorOperationRef, destinationIdentity: receipt.destinationIdentity });
      if (expectedHash !== record.requestHash || canonicalRequest(receipt.files.map(file => ({ path: file.name, bytes: file.bytes, sha256: file.sha256 })).sort((a, b) => a.path.localeCompare(b.path)))
        !== canonicalRequest([...proof.manifest.files].sort((a, b) => a.path.localeCompare(b.path)))) throw new Error('state_conflict');
      this.db.query("UPDATE exports SET state='completed',copy_state='verified',copy_receipt_json=?,updated_at=? WHERE id=?").run(json(receipt), receipt.verifiedAt, record.id);
      this.db.query(`INSERT INTO business_events(operation_ref,type,actor,session_id,query_id,artifact_id,export_id,details_json,occurred_at)
        VALUES(?,'export_copied','user',?,?,?,?,?,?)`).run(operationRef, record.sessionId, record.queryId, receipt.artifactId, record.id,
          json({ resultHash: source.query.resultHash, rowCount: source.query.rows.length, copyState: 'verified' }), receipt.verifiedAt);
    });
  }

  terminate(operationRef: string, state: 'failed' | 'cancelled' | 'interrupted', error: AppError | null, copyState: ExportCopyState): void {
    this.transactions.immediate(() => {
      const record = this.required(operationRef);
      if (terminal(record.state)) {
        if (record.state !== state || record.copyState !== copyState || canonicalRequest(record.error) !== canonicalRequest(error)) throw new Error('state_conflict'); return;
      }
      ExportOperationSchema.parse({ ...this.publicView(record), state, error, copyState });
      this.db.query('UPDATE exports SET state=?,error_json=?,copy_state=?,updated_at=? WHERE id=?').run(state, json(error), copyState, new Date().toISOString(), record.id);
    });
  }

  list(input: z.input<typeof ExportListInputSchema>) {
    const request = ExportListInputSchema.parse(input);
    this.readSource(request.queryId, null);
    const rows = this.db.query<{ id: number; operation_ref: string }, [number, number | null, number]>(
      'SELECT id,operation_ref FROM exports WHERE query_id=? AND (?2 IS NULL OR id<?2) ORDER BY id DESC LIMIT ?3').all(request.queryId, request.beforeExportId ?? null, request.limit + 1);
    const hasMore = rows.length > request.limit, page = rows.slice(0, request.limit);
    return { items: page.map(row => this.publicView(this.required(row.operation_ref))), nextBeforeExportId: hasMore ? page.at(-1)!.id : null };
  }

  requestCancel(operationRef: string): StoredExport {
    return this.transactions.immediate(() => {
      const record = this.required(operationRef);
      if (!terminal(record.state) && record.cancelRequestedAt === null) this.db.query('UPDATE exports SET cancel_requested_at=?,updated_at=? WHERE id=?').run(new Date().toISOString(), new Date().toISOString(), record.id);
      return this.required(operationRef);
    });
  }

  unfinished(): StoredExport[] {
    return this.db.query<{ operation_ref: string }, []>("SELECT operation_ref FROM exports WHERE state NOT IN ('completed','failed','cancelled','interrupted') ORDER BY id")
      .all().map(row => this.required(row.operation_ref));
  }

  publicView(record: StoredExport) { return ExportOperationSchema.parse(Object.fromEntries(Object.keys(ExportOperationSchema.shape).map(key => [key, record[key as keyof StoredExport]]))); }
  private artifact(artifactId: number) { return this.db.query<ArtifactRow, [number]>('SELECT * FROM artifacts WHERE id=?').get(artifactId); }
  private required(operationRef: string): StoredExport { const record = this.find(operationRef); if (!record) throw new Error('operation_not_found'); return record; }
  private checkProof(record: StoredExport, input: unknown): PublishedExport {
    const proof = PublishedExportSchema.parse(input), artifact = this.artifact(proof.artifactId), source = this.readSource(record.queryId, record.answerId);
    if (!artifact || record.reservedArtifactId !== artifact.id || artifact.kind !== 'export' || artifact.query_id !== record.queryId || artifact.format !== record.format
      || proof.manifest.originOperationRef !== artifact.operation_ref || proof.manifest.queryId !== record.queryId || proof.manifest.resultHash !== source.query.resultHash
      || proof.manifest.answerId !== record.answerId || proof.manifest.format !== record.format
      || proof.sha256 !== hash([...proof.manifest.files].sort((a, b) => a.path.localeCompare(b.path)))) throw new Error('state_conflict');
    if (artifact.status === 'ready' && (artifact.sha256 !== proof.sha256 || artifact.metadata_sha256 !== proof.metadataSha256
      || canonicalRequest(JSON.parse(artifact.metadata_json)) !== canonicalRequest(proof.manifest))) throw new Error('state_conflict');
    return proof;
  }
  private saveArtifact(record: StoredExport, proof: PublishedExport, ready: boolean): void {
    const original = this.artifact(proof.artifactId)!;
    if (original.status === 'ready') return;
    if (original.export_id !== record.id) throw new Error('state_conflict');
    this.db.query(`UPDATE artifacts SET relative_path=?,sha256=?,bytes=?,metadata_sha256=?,published_at=?,metadata_json=?,status=?,registered_at=? WHERE id=?`)
      .run(proof.relativePath, proof.sha256, proof.sizeBytes, proof.metadataSha256, original.published_at ?? proof.publishedAt, json(proof.manifest), ready ? 'ready' : 'reserved', ready ? new Date().toISOString() : null, proof.artifactId);
  }
}
