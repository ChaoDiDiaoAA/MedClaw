import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { canonicalRequest } from '../../packages/contracts/src/run';
import type { ExportCopyReceipt, FrozenExportSource, PublishedExport } from '../../packages/contracts/src/export';
import { safeError } from '../../packages/contracts/src/error';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteDataDeletionStore } from '../../packages/storage/src/data-deletion-store';
import { ArtifactStore } from '../../packages/storage/src/artifact-store';
import { SqliteExportStore } from '../../packages/storage/src/export-store';
import type { ExportManifest, ExportRequest } from '../../packages/contracts/src/export';
import { ExportOperationSchema } from '../../packages/contracts/src/export';
import { DestinationTokens } from '../../apps/desktop/src/main/destination-tokens';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MainSettings } from '../../apps/desktop/src/main/settings';
import { resolve } from 'node:path';
import { contextModel } from '../fixtures/p8-context';
import { DEFAULT_REQUEST_POLICY } from '../../packages/contracts/src/model';

const at = '2026-10-11T01:00:00.000Z';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function exportServiceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-service-')), db = openDatabase(join(root, 'app.sqlite'));
  const seeded = seedWorkspaceQueries(db), store = new SqliteExportStore(db), artifacts = new ArtifactStore(db, join(root, 'artifacts'));
  const { ExportService } = await import('../../packages/core/src/data/export-service');
  const counts = { describe: 0, copy: 0, cancel: 0, settle: 0 }, copied = deferred<void>();
  let describeGate: Promise<void> | null = null, copyGate: Promise<void> | null = null;
  let describeError: string | null = null, copyError: string | null = null, stopped = true;
  const service = new ExportService('host-p15', { store, artifacts, assertWritable() {}, destination: {
    async describe(input) { counts.describe++; if (describeGate) await describeGate; if (describeError) throw safeError(describeError); return { destinationIdentity: input.destinationIdentity }; },
    async copy(input) { counts.copy++; copied.resolve(); if (copyGate) await copyGate; if (copyError) throw safeError(copyError); return { contract: 'medclaw.export-receipt/v1' as const,
      operationRef: input.operationRef, artifactId: input.artifactId, destinationIdentity: input.destinationIdentity,
      contentHash: createHash('sha256').update(canonicalRequest([...input.manifest.files].sort((a, b) => a.path.localeCompare(b.path)))).digest('hex'), verifiedAt: at,
      files: input.manifest.files.map(file => ({ name: file.path, bytes: file.bytes, sha256: file.sha256 })) }; },
    async cancel() { counts.cancel++; return { stopped }; }, async settlePrevious() { counts.settle++; return { stopped: true as const }; },
  } });
  const request = (operationRef = 'service:original', overrides: Partial<ExportRequest> = {}): ExportRequest => ({ operationRef, queryId: seeded.current.id,
    answerId: null, format: 'json', destinationToken: 'grant', destinationIdentity: 'a'.repeat(64), ...overrides });
  return { root, db, store, artifacts, service, counts, copied, request,
    setDescribeGate(value: Promise<void>) { describeGate = value; }, setCopyGate(value: Promise<void>) { copyGate = value; },
    setDescribeError(value: string | null) { describeError = value; }, setCopyError(value: string | null) { copyError = value; }, setStopped(value: boolean) { stopped = value; },
    async close() { await service.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function settleExport(f: Awaited<ReturnType<typeof exportServiceFixture>>, operationRef: string) {
  for (let n = 0; n < 200; n++) { const result = await f.service.read(operationRef); if (result.ok && result.data && ['completed', 'failed', 'cancelled', 'interrupted'].includes(result.data.state)) return result.data; await Bun.sleep(10); }
  throw new Error('ENGINEERING export did not settle');
}

test('p15 service reserves before describe, joins identical submissions and completes with one real artifact', async () => {
  const f = await exportServiceFixture(), gate = deferred<void>();
  try {
    f.setDescribeGate(gate.promise); const pending = f.service.export(f.request());
    expect(f.service.busy).toBe(true);
    const replay = f.service.export(f.request(undefined, { destinationToken: 'renewed-grant' }));
    expect(await f.service.export(f.request('service:second'))).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    expect(await f.service.export(f.request(undefined, { format: 'csv' }))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(f.counts.describe).toBe(1); gate.resolve();
    expect(await pending).toMatchObject({ ok: true, data: { state: 'preparing', artifact: null } }); expect(await replay).toEqual(await pending);
    const result = await settleExport(f, 'service:original'); expect(result).toMatchObject({ state: 'completed', copyState: 'verified', error: null });
    expect(f.service.busy).toBe(false); expect(f.counts.copy).toBe(1);
    f.setDescribeError('export_destination_invalid');
    expect(await f.service.export(f.request(undefined, { destinationToken: 'expired' }))).toEqual({ ok: true, data: result });
    expect(f.counts.describe).toBe(1); expect(f.counts.copy).toBe(1);
    expect(f.db.query('SELECT * FROM model_calls').all()).toHaveLength(0); expect(f.db.query('SELECT id FROM queries').all()).toHaveLength(3);
    expect((await f.service.list({ queryId: f.request().queryId })).ok).toBe(true);
  } finally { gate.resolve(); await f.close(); }
}, 30000);

test('p15 service preserves unknown delivery and reuses the verified artifact only in a new authorized attempt', async () => {
  const f = await exportServiceFixture();
  try {
    f.setCopyError('export_copy_failed'); expect((await f.service.export(f.request())).ok).toBe(true);
    const original = await settleExport(f, 'service:original'); expect(original).toMatchObject({ state: 'failed', copyState: 'unknown', error: { code: 'export_copy_failed' } });
    expect(original.artifact).not.toBeNull();
    const { updatedAt: _checkedAt, ...originalFacts } = original;
    expect((await f.service.recover(original.operationRef))).toMatchObject({ ok: true, data: originalFacts });
    f.setCopyError(null);
    expect((await f.service.export(f.request('service:retry', { priorOperationRef: original.operationRef, destinationToken: 'new-grant' }))).ok).toBe(true);
    const retry = await settleExport(f, 'service:retry'); expect(retry).toMatchObject({ state: 'completed', copyState: 'verified', artifact: original.artifact });
    expect(f.db.query("SELECT id FROM artifacts WHERE kind='export'").all()).toHaveLength(1);
    expect(f.db.query("SELECT id FROM business_events WHERE type='export_registered'").all()).toHaveLength(1);
    expect(f.db.query("SELECT id FROM business_events WHERE type='export_copied'").all()).toHaveLength(1);
    expect(f.counts.describe).toBe(2); expect(f.counts.copy).toBe(2); expect(f.counts.settle).toBe(1);
  } finally { await f.close(); }
}, 30000);

test('p15 service cancellation waits for actual copying and a verified completion can win', async () => {
  const f = await exportServiceFixture(), gate = deferred<void>();
  try {
    f.setCopyGate(gate.promise); f.setStopped(false);
    expect((await f.service.export(f.request())).ok).toBe(true); await f.copied.promise;
    expect(await f.service.cancel('service:original')).toMatchObject({ ok: true, data: { state: 'copying', copyState: 'copying', cancelRequestedAt: expect.any(String) } });
    expect(f.service.busy).toBe(true); expect(f.counts.cancel).toBe(1);
    expect(await f.service.export(f.request('service:other'))).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    gate.resolve(); const result = await settleExport(f, 'service:original');
    expect(result).toMatchObject({ state: 'completed', copyState: 'verified', cancelRequestedAt: expect.any(String) });
    expect(f.service.busy).toBe(false);
    expect(await f.service.cancel(result.operationRef)).toMatchObject({ ok: true, data: result }); expect(f.counts.cancel).toBe(1);
  } finally { gate.resolve(); await f.close(); }
}, 30000);

test('p15 service keeps a persistence barrier after registration failure and explicit recovery preserves the failed fact', async () => {
  const f = await exportServiceFixture();
  try {
    f.db.exec("CREATE TRIGGER engineering_register_failure BEFORE UPDATE OF status ON artifacts WHEN NEW.kind='export' AND NEW.status='ready' BEGIN SELECT RAISE(ABORT,'ENGINEERING registration failure'); END");
    expect((await f.service.export(f.request())).ok).toBe(true);
    const original = await settleExport(f, 'service:original');
    expect(original).toMatchObject({ state: 'failed', artifact: null, copyState: 'not_started', error: { code: 'export_registration_failed' } });
    expect(original.publishedHash).toBeString(); expect(f.counts.copy).toBe(0); expect(f.service.busy).toBe(false);
    f.db.exec('DROP TRIGGER engineering_register_failure');
    const recovered = await f.service.recover(original.operationRef);
    expect(recovered).toMatchObject({ ok: true, data: { state: 'failed', copyState: 'not_started', error: original.error, publishedHash: original.publishedHash, artifact: { queryId: original.queryId } } });
    expect(f.counts.copy).toBe(0); expect(f.db.query("SELECT id FROM business_events WHERE type='export_registered'").all()).toHaveLength(1);
    expect(f.db.query('SELECT * FROM model_calls').all()).toHaveLength(0);
  } finally { await f.close(); }
}, 30000);

test('p15 service cancellation preserves unknown external effects without reopening the original terminal state', async () => {
  const f = await exportServiceFixture(), gate = deferred<void>();
  try {
    f.setCopyGate(gate.promise); f.setCopyError('export_copy_failed'); f.setStopped(false);
    expect((await f.service.export(f.request())).ok).toBe(true); await f.copied.promise;
    expect((await f.service.cancel('service:original')).ok).toBe(true); f.setStopped(true); gate.resolve();
    const result = await settleExport(f, 'service:original'); expect(result).toMatchObject({ state: 'cancelled', copyState: 'unknown', error: null, cancelRequestedAt: expect.any(String) });
    expect(f.service.busy).toBe(false); expect(await f.service.cancel(result.operationRef)).toMatchObject({ ok: true, data: result });
  } finally { gate.resolve(); await f.close(); }
}, 30000);

test('p15 service confirms a committed completion after a lost storage acknowledgement', async () => {
  const f = await exportServiceFixture(), complete = f.store.complete.bind(f.store);
  try {
    f.store.complete = (ref, receipt) => { complete(ref, receipt); throw new Error('ENGINEERING completion acknowledgement lost'); };
    expect((await f.service.export(f.request())).ok).toBe(true);
    const result = await settleExport(f, 'service:original'); expect(result).toMatchObject({ state: 'completed', copyState: 'verified' });
    expect(f.service.busy).toBe(false);
    expect(f.db.query("SELECT id FROM business_events WHERE type='export_copied'").all()).toHaveLength(1); expect(f.counts.copy).toBe(1);
  } finally { f.store.complete = complete; await f.close(); }
}, 30000);

test('p15 service explicitly retries an unconfirmed failure save before recovering a published artifact', async () => {
  const f = await exportServiceFixture();
  try {
    f.db.exec("CREATE TRIGGER engineering_register_failure BEFORE UPDATE OF status ON artifacts WHEN NEW.kind='export' AND NEW.status='ready' BEGIN SELECT RAISE(ABORT,'ENGINEERING register'); END");
    f.db.exec("CREATE TRIGGER engineering_termination_failure BEFORE UPDATE OF state ON exports WHEN NEW.state='failed' BEGIN SELECT RAISE(ABORT,'ENGINEERING termination'); END");
    expect((await f.service.export(f.request())).ok).toBe(true);
    for (let n = 0; n < 200 && f.store.find('service:original')?.state !== 'published'; n++) await Bun.sleep(10);
    await Bun.sleep(20); expect(f.service.busy).toBe(true); expect(f.counts.copy).toBe(0);
    expect(await f.service.export(f.request('service:new'))).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    f.db.exec('DROP TRIGGER engineering_register_failure; DROP TRIGGER engineering_termination_failure');
    expect(await f.service.recover('service:original')).toMatchObject({ ok: true, data: { state: 'failed', copyState: 'not_started', artifact: { queryId: f.request().queryId }, error: { code: 'export_registration_failed' } } });
    expect(f.service.busy).toBe(false); expect(f.counts.copy).toBe(0);
  } finally { f.db.exec('DROP TRIGGER IF EXISTS engineering_register_failure; DROP TRIGGER IF EXISTS engineering_termination_failure'); await f.service.recover('service:original'); await f.close(); }
}, 30000);

test('p15 service shutdown waits for a recovery verification still using the database', async () => {
  const f = await exportServiceFixture(), gate = deferred<void>(), entered = deferred<void>(), verify = f.artifacts.verifyExport.bind(f.artifacts);
  try {
    f.setCopyError('export_copy_failed'); expect((await f.service.export(f.request())).ok).toBe(true); await settleExport(f, 'service:original');
    f.artifacts.verifyExport = async id => { entered.resolve(); await gate.promise; return verify(id); };
    const recover = f.service.recover('service:original'); await entered.promise;
    let stopped = false; const shutdown = f.service.shutdown().then(() => { stopped = true; }); await Bun.sleep(20);
    expect(stopped).toBe(false); expect(f.service.busy).toBe(true);
    gate.resolve(); expect((await recover).ok).toBe(true); await shutdown; expect(stopped).toBe(true);
  } finally { gate.resolve(); f.artifacts.verifyExport = verify; await f.close(); }
}, 30000);

test('p15 service recovery obtains new Main stop proof before releasing an unknown-copy barrier', async () => {
  const f = await exportServiceFixture();
  try {
    f.setCopyError('export_copy_failed'); f.setStopped(false); expect((await f.service.export(f.request())).ok).toBe(true);
    const original = await settleExport(f, 'service:original'); expect(f.service.busy).toBe(true);
    const result = await f.service.recover(original.operationRef); expect(result).toMatchObject({ ok: true, data: { state: 'failed', copyState: 'unknown', error: original.error } });
    expect(f.counts.settle).toBeGreaterThanOrEqual(1); expect(f.service.busy).toBe(false); expect(f.counts.copy).toBe(1);
  } finally { f.setStopped(true); await f.close(); }
}, 30000);

test('p15 service and activity reads deny deleted sessions and never expose arbitrary details JSON', async () => {
  const f = await exportServiceFixture();
  try {
    expect((await f.service.export(f.request())).ok).toBe(true); const original = await settleExport(f, 'service:original'), repos = new Repositories(f.db);
    f.db.query("INSERT INTO business_events(operation_ref,type,actor,session_id,details_json,occurred_at) VALUES('legacy:unsafe','legacy_event','system',1,?,?)")
      .run(JSON.stringify({ path: 'D:/secret', destinationToken: 'private-grant', source: 'private-grant' }), at);
    const first = repos.listActivity({ sessionId: 1, limit: 1 }); expect(first.items).toHaveLength(1); expect(first.nextBeforeEventId).toBe(first.items[0]!.id);
    expect(first.items[0]!.details).toEqual({ source: null, answerId: null, rowCount: null, batchCount: null, resultHash: null, copyState: null });
    expect(JSON.stringify(first)).not.toContain('secret'); expect(JSON.stringify(first)).not.toContain('private-grant');
    const later = repos.listActivity({ sessionId: 1, beforeEventId: first.nextBeforeEventId! }); expect(later.items.some(item => item.id === first.items[0]!.id)).toBe(false);
    expect(repos.listActivity({ sessionId: null }).items.every(item => item.sessionId === null)).toBe(true);
    f.db.query("INSERT INTO business_events(operation_ref,type,actor,session_id,details_json,occurred_at) VALUES('corrupt:query','query_committed','user',1,'{\"rowCount\":\"secret\"}',?)").run(at);
    expect(() => repos.listActivity({ sessionId: 1 })).toThrow('storage_read_failed');
    f.db.query("UPDATE sessions SET status='deleted',deleted_at=?,metadata_revision=metadata_revision+1 WHERE id=1").run(at);
    expect(await f.service.read(original.operationRef)).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(await f.service.cancel(original.operationRef)).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(await f.service.list({ queryId: original.queryId })).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(() => repos.readAnswer(10)).toThrow('access_denied'); expect(() => repos.listActivity({ sessionId: 1 })).toThrow('access_denied');
  } finally { await f.close(); }
}, 30000);

test('p15 restart waits for Main stop proof, preserves interrupted stages and only explicitly recovers registration', async () => {
  const f = await exportServiceFixture(), gate = deferred<void>();
  const { ExportService } = await import('../../packages/core/src/data/export-service');
  let copies = 0, inspections = 0;
  const restarted = new ExportService('host-new', { store: f.store, artifacts: f.artifacts, assertWritable() {}, destination: {
    async describe() { inspections++; throw new Error('Unexpected new grant'); }, async copy() { copies++; throw new Error('Unexpected copy'); },
    async cancel() { return { stopped: true }; }, async settlePrevious() { await gate.promise; return { stopped: true }; },
  } });
  try {
    const source = f.store.readSource(f.request().queryId, null);
    for (const stage of ['preparing', 'published', 'copying']) {
      const accepted = f.store.accept({ operationRef: `restart:${stage}`, requestHash: 'b'.repeat(64), instanceId: 'host-old', sessionId: 1, queryId: source.query.id, answerId: null, format: 'json', priorExportId: null, reuseArtifactId: null, createdAt: at });
      if (stage !== 'preparing') { const proof = await f.artifacts.publishExport({ artifactId: accepted.reservedArtifactId!, originOperationRef: accepted.operationRef, format: 'json', source }, new AbortController().signal); f.store.publish(accepted.operationRef, proof); if (stage === 'copying') { f.store.register(accepted.operationRef, proof); f.store.beginCopy(accepted.operationRef); } }
    }
    const recovery = restarted.recoverInterrupted(); await Bun.sleep(10); expect(f.store.unfinished()).toHaveLength(3);
    gate.resolve(); await recovery; expect(f.store.unfinished()).toHaveLength(0);
    for (const stage of ['preparing', 'published', 'copying']) expect(await restarted.read(`restart:${stage}`)).toMatchObject({ ok: true, data: { state: 'interrupted', error: { code: 'host_interrupted' }, copyState: stage === 'copying' ? 'unknown' : 'not_started' } });
    expect(await restarted.recover('restart:published')).toMatchObject({ ok: true, data: { state: 'interrupted', copyState: 'not_started', error: { code: 'host_interrupted' }, artifact: { queryId: source.query.id } } });
    expect(await restarted.recover('restart:preparing')).toMatchObject({ ok: false, error: { code: 'artifact_not_ready' } });
    expect(copies).toBe(0); expect(inspections).toBe(0); expect(f.counts.copy).toBe(0);
    expect(f.db.query('SELECT id FROM queries').all()).toHaveLength(3); expect(f.db.query('SELECT id FROM model_calls').all()).toHaveLength(0);
  } finally { gate.resolve(); await restarted.shutdown(); await f.close(); }
}, 30000);

test('p15 destination grants bind every identity, expire and reject protected roots or replaced parents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-grants-')), dataRoot = join(root, 'data'), parent = join(root, 'external');
  mkdirSync(dataRoot); mkdirSync(parent); let clock = 1000;
  try {
    const tokens = new DestinationTokens(dataRoot, () => clock), source = { operationRef: 'grant:original', queryId: 1, answerId: null, format: 'json' as const };
    const grant = tokens.issue(7, 'host', source, join(parent, '汉字 $.json')), input = { ...source, destinationToken: grant.destinationToken, destinationIdentity: grant.destinationIdentity };
    expect(await tokens.describe(7, 'host', input)).toEqual({ destinationIdentity: grant.destinationIdentity });
    expect(JSON.stringify(grant)).not.toContain(parent); expect(grant.displayName).toBe('汉字 $.json');
    for (const [windowId, instanceId, override] of [[8, 'host', {}], [7, 'other-host', {}], [7, 'host', { operationRef: 'other' }],
      [7, 'host', { queryId: 2 }], [7, 'host', { answerId: 1 }], [7, 'host', { format: 'csv' }], [7, 'host', { destinationIdentity: 'b'.repeat(64) }]] as const) {
      await expect(tokens.describe(windowId, instanceId, { ...input, ...override } as typeof input)).rejects.toThrow('export_destination_invalid');
    }
    expect(() => tokens.issue(7, 'host', source, join(dataRoot, 'protected.json'))).toThrow('export_destination_invalid');
    for (const name of ['CON.json', 'bad..', 'bad:name.json', 'trail.json ']) expect(() => tokens.issue(7, 'host', source, join(parent, name))).toThrow('export_destination_invalid');
    clock += 15 * 60 * 1000;
    await expect(tokens.describe(7, 'host', input)).rejects.toThrow('export_destination_invalid');
    const current = tokens.issue(7, 'host', source, join(parent, 'current.json'));
    tokens.closeWindow(7); await expect(tokens.describe(7, 'host', { ...source, destinationToken: current.destinationToken, destinationIdentity: current.destinationIdentity })).rejects.toThrow('export_destination_invalid');
    const replaced = tokens.issue(7, 'host', source, join(parent, 'parent.json'));
    renameSync(parent, join(root, 'original-parent')); mkdirSync(parent);
    await expect(tokens.describe(7, 'host', { ...source, destinationToken: replaced.destinationToken, destinationIdentity: replaced.destinationIdentity })).rejects.toThrow('export_destination_invalid');
    const link = join(root, 'linked-parent'); symlinkSync(parent, link, 'junction');
    expect(() => tokens.issue(7, 'host', source, join(link, 'linked.json'))).toThrow('export_destination_invalid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('p15 destination copies the complete real bundle, persists path-free proof and requires proof for an existing target', async () => {
  const f = await exportServiceFixture(), parent = join(f.root, 'external'); mkdirSync(parent);
  try {
    expect((await f.service.export(f.request())).ok).toBe(true); const first = await settleExport(f, 'service:original');
    const proof = await f.artifacts.verifyExport(first.artifact!.id), tokens = new DestinationTokens(f.root), source = {
      operationRef: 'destination:copy', queryId: first.queryId, answerId: null, format: 'json' as const };
    // The external destination must live outside the managed data root.
    const external = mkdtempSync(join(tmpdir(), 'medclaw-p15-external-'));
    try {
      const target = join(external, '用户 $(literal).json'), grant = tokens.issue(7, 'host', source, target);
      const input = { ...source, destinationToken: grant.destinationToken, destinationIdentity: grant.destinationIdentity, artifactId: proof.artifactId, manifest: proof.manifest, priorOperationRefs: [] };
      const receipt = await tokens.copy(7, 'host', input);
      expect(receipt).toMatchObject({ operationRef: source.operationRef, artifactId: proof.artifactId, destinationIdentity: grant.destinationIdentity, contentHash: proof.sha256 });
      expect(readFileSync(target)).toEqual(readFileSync(join(f.root, 'artifacts', String(proof.artifactId), 'result.json')));
      const stored = readFileSync(join(f.root, 'runtime/export-copies', createHash('sha256').update(source.operationRef).digest('hex') + '.json'), 'utf8');
      expect(stored).not.toContain(external); expect(stored).not.toContain(grant.destinationToken);
      expect(await tokens.copy(7, 'host', input)).toEqual(receipt);
      const retrySource = { ...source, operationRef: 'destination:retry' }, retry = tokens.issue(7, 'host', retrySource, target);
      expect(await tokens.copy(7, 'host', { ...input, ...retrySource, destinationToken: retry.destinationToken, destinationIdentity: retry.destinationIdentity, priorOperationRefs: [source.operationRef] }))
        .toMatchObject({ operationRef: retrySource.operationRef, artifactId: proof.artifactId, contentHash: proof.sha256 });
      const unproved = join(external, 'same-but-unproved.json'); writeFileSync(unproved, readFileSync(target));
      const other = { ...source, operationRef: 'destination:unproved' }, unprovedGrant = tokens.issue(7, 'host', other, unproved);
      await expect(tokens.copy(7, 'host', { ...input, ...other, destinationToken: unprovedGrant.destinationToken, destinationIdentity: unprovedGrant.destinationIdentity })).rejects.toThrow('destination_conflict');
      expect((await tokens.cancel(source.operationRef)).stopped).toBe(true);
      expect(await tokens.settlePrevious()).toEqual({ stopped: true });
    } finally { await tokens.settlePrevious(); rmSync(external, { recursive: true, force: true }); }
  } finally { await f.close(); }
}, 30000);

test('p15 destination delivers CSV metadata and Markdown, rejects tampering and settles cancellation before publication', async () => {
  const f = await exportServiceFixture(), external = mkdtempSync(join(tmpdir(), 'medclaw-p15-destination-formats-')), tokens = new DestinationTokens(f.root);
  try {
    for (const format of ['csv', 'markdown'] as const) {
      const operationRef = `service:${format}`; expect((await f.service.export(f.request(operationRef, { format }))).ok).toBe(true);
      const original = await settleExport(f, operationRef), proof = await f.artifacts.verifyExport(original.artifact!.id);
      const source = { operationRef: `destination:${format}`, queryId: original.queryId, answerId: null, format }, target = join(external, format === 'csv' ? '完整包' : '回答.md');
      const grant = tokens.issue(7, 'host', source, target), input = { ...source, destinationToken: grant.destinationToken, destinationIdentity: grant.destinationIdentity, artifactId: proof.artifactId, manifest: proof.manifest, priorOperationRefs: [] };
      const receipt = await tokens.copy(7, 'host', input); expect(receipt.files).toHaveLength(format === 'csv' ? 2 : 1);
      if (format === 'csv') expect(readdirSync(target).sort()).toEqual(['metadata.json', 'result.csv']);
      for (const file of proof.manifest.files) expect(readFileSync(format === 'csv' ? join(target, file.path) : target)).toEqual(readFileSync(join(f.root, 'artifacts', String(proof.artifactId), file.path)));
      const cancelled = { ...source, operationRef: `destination:cancel-${format}` }, cancelTarget = join(external, `cancel-${format}`), cancelGrant = tokens.issue(7, 'host', cancelled, cancelTarget);
      const pending = tokens.copy(7, 'host', { ...input, ...cancelled, destinationToken: cancelGrant.destinationToken, destinationIdentity: cancelGrant.destinationIdentity });
      const outcome = pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      expect(await tokens.cancel(cancelled.operationRef)).toEqual({ stopped: true }); expect(await outcome).toMatchObject({ ok: false });
      expect(existsSync(cancelTarget)).toBe(false);
      const tampered = { ...source, operationRef: `destination:tamper-${format}` }, tamperTarget = join(external, `tamper-${format}`), tamperGrant = tokens.issue(7, 'host', tampered, tamperTarget);
      const payload = join(f.root, 'artifacts', String(proof.artifactId), proof.manifest.files[0]!.path); writeFileSync(payload, 'ENGINEERING tampered');
      await expect(tokens.copy(7, 'host', { ...input, ...tampered, destinationToken: tamperGrant.destinationToken, destinationIdentity: tamperGrant.destinationIdentity })).rejects.toThrow('artifact_not_ready');
      expect(existsSync(tamperTarget)).toBe(false);
    }
    expect(readdirSync(external).filter(name => name.endsWith('.tmp'))).toEqual([]);
  } finally { await tokens.settlePrevious(); await f.close(); rmSync(external, { recursive: true, force: true }); }
}, 30000);

test('p15 destination pins the granted parent before a junction replacement can receive query bytes', async () => {
  const f = await exportServiceFixture(), external = mkdtempSync(join(tmpdir(), 'medclaw-p15-parent-race-')), parent = join(external, 'selected'), unauthorized = join(external, 'unauthorized');
  mkdirSync(parent); mkdirSync(unauthorized); const tokens = new DestinationTokens(f.root);
  try {
    expect((await f.service.export(f.request())).ok).toBe(true); const operation = await settleExport(f, 'service:original'), proof = await f.artifacts.verifyExport(operation.artifact!.id);
    const source = { operationRef: 'destination:parent-race', queryId: operation.queryId, answerId: null, format: 'json' as const }, target = join(parent, 'result.json'), grant = tokens.issue(7, 'host', source, target);
    const internal = tokens as unknown as { copyFile(source: string, target: string, signal: AbortSignal, created: (identity: string) => void): Promise<void> };
    const original = internal.copyFile.bind(tokens); let blocked = false;
    internal.copyFile = async (...args) => {
      try { renameSync(parent, join(external, 'replaced')); symlinkSync(unauthorized, parent, 'junction'); } catch { blocked = true; }
      await original(...args);
    };
    expect(await tokens.copy(7, 'host', { ...source, destinationToken: grant.destinationToken, destinationIdentity: grant.destinationIdentity, artifactId: proof.artifactId, manifest: proof.manifest, priorOperationRefs: [] })).toMatchObject({ operationRef: source.operationRef });
    expect(blocked).toBe(true); expect(readdirSync(unauthorized)).toEqual([]); expect(readFileSync(target)).toEqual(readFileSync(join(f.root, 'artifacts', String(proof.artifactId), 'result.json')));
  } finally { await tokens.settlePrevious(); await f.close(); rmSync(external, { recursive: true, force: true }); }
}, 30000);

test('p15 destination cancellation during a single file copy removes only its owned temporary file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-partial-')), external = mkdtempSync(join(tmpdir(), 'medclaw-p15-partial-external-'));
  const tokens = new DestinationTokens(root), sourceDirectory = join(root, 'artifacts/1'); mkdirSync(sourceDirectory, { recursive: true });
  try {
    const payload = Buffer.from('ENGINEERING-' + 'x'.repeat(32 * 1024 * 1024)), manifest: ExportManifest = { contract: 'medclaw.export-manifest/v1',
      artifactId: 1, originOperationRef: 'artifact:engineering', queryId: 1, resultHash: 'a'.repeat(64), answerId: null, format: 'json', exportVersion: 'medclaw.export/v1',
      metadataHash: 'b'.repeat(64), files: [{ path: 'result.json', bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }] };
    writeFileSync(join(sourceDirectory, 'result.json'), payload); writeFileSync(join(sourceDirectory, 'manifest.json'), canonicalRequest(manifest));
    const source = { operationRef: 'destination:partial', queryId: 1, answerId: null, format: 'json' as const }, target = join(external, 'result.json');
    const grant = tokens.issue(7, 'host', source, target);
    writeFileSync(join(external, 'user-owned.txt'), 'preserve');
    const opened = deferred<void>(), internal = tokens as unknown as { copyFile(source: string, target: string, signal: AbortSignal, created: (identity: string) => void): Promise<void> };
    const original = internal.copyFile.bind(tokens);
    internal.copyFile = (source, target, signal, created) => original(source, target, signal, identity => { created(identity); opened.resolve(); });
    const outcome = tokens.copy(7, 'host', { ...source, destinationToken: grant.destinationToken, destinationIdentity: grant.destinationIdentity, artifactId: 1, manifest, priorOperationRefs: [] })
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    await opened.promise;
    expect(readdirSync(external).some(name => name.endsWith('.tmp'))).toBe(true);
    expect(await tokens.cancel(source.operationRef)).toEqual({ stopped: true }); expect(await outcome).toMatchObject({ ok: false });
    expect(existsSync(target)).toBe(false); expect(readdirSync(external)).toEqual(['user-owned.txt']); expect(readFileSync(join(external, 'user-owned.txt'), 'utf8')).toBe('preserve');
  } finally { await tokens.settlePrevious(); rmSync(root, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true }); }
}, 30000);

test('p15 Host exports through the private Main capability, blocks concurrent writes and exposes read-only original facts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-host-export-')), external = mkdtempSync(join(tmpdir(), 'medclaw-p15-host-external-'));
  const destinations = new DestinationTokens(root), copying = deferred<void>(), release = deferred<void>();
  const counts = { describe: 0, copy: 0, settle: 0 };
  let holdShutdown = false; const shutdownCopy = deferred<void>(), shutdownRelease = deferred<void>();
  const host = new HostController({ dataRoot: root, hostEntry: resolve('apps/host/src/main.ts'), bunExecutable: process.execPath, onCredentialRequest: async frame => {
    switch (frame.method) {
      case 'credential.list': return { ok: true, data: [] };
      case 'credential.read': return { ok: true, data: null };
      case 'export.destination.settlePrevious': counts.settle++; if (holdShutdown) shutdownRelease.resolve(); return { ok: true, data: await destinations.settlePrevious() };
      case 'export.destination.describe': counts.describe++; return { ok: true, data: await destinations.describe(7, frame.instanceId, frame.payload) };
      case 'export.destination.copy': { counts.copy++; const delayedReceipt = counts.copy === 1; copying.resolve(); await release.promise; if (holdShutdown) { shutdownCopy.resolve(); await shutdownRelease.promise; } const receipt = await destinations.copy(7, frame.instanceId, frame.payload); if (delayedReceipt) await Bun.sleep(11000); return { ok: true, data: receipt }; }
      case 'export.destination.cancel': return { ok: true, data: await destinations.cancel(frame.payload.operationRef) };
      default: return { ok: false, error: safeError('access_denied') };
    }
  } });
  new MainSettings(host.paths.settingsPath).read();
  const db = openDatabase(host.paths.databasePath), seeded = seedWorkspaceQueries(db);
  db.query('UPDATE runs SET config_json=? WHERE id=10').run(canonicalRequest({ selection: contextModel, policy: DEFAULT_REQUEST_POLICY,
    referenceDate: '2026-10-04', timezone: 'Asia/Shanghai', agent: { requestedThinkingLevel: 'off', effectiveThinkingLevel: 'off', stage: 'P2',
      nativeSessionId: 'native-a', tools: [], autoCompaction: false, autoRetry: false, cacheWarming: 'off' } }));
  new Repositories(db).saveRunCleanup(10, { contract: 'medclaw.run-cleanup/v1', executionStarted: false, stopConfirmed: null,
    requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: true, unconfirmedItems: [], secondaryErrors: [], verifiedAt: at });
  db.close();
  const data = <T>(result: import('../../packages/contracts/src/error').Result<T>) => { if (!result.ok) throw result.error; return result.data; };
  try {
    expect(await host.start()).toMatchObject({ state: 'ready', schemaVersion: 15 });
    const source = { operationRef: 'host:export', queryId: seeded.current.id, answerId: null, format: 'csv' as const };
    const target = join(external, 'query-bundle'), grant = destinations.issue(7, host.read().instanceId!, source, target);
    const request = { ...source, destinationToken: grant.destinationToken, destinationIdentity: grant.destinationIdentity };
    expect(data(await host.request('export.create', request, source.operationRef))).toMatchObject({ state: 'preparing', artifact: null });
    await copying.promise;
    expect(data(await host.request('run.control.read', {}))).toMatchObject({ acceptingNewRuns: false });
    expect(await host.request('workspace.update', { expectedRevision: 2, change: { batchIds: [1] } })).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    expect(await host.request('session.create', { expectedWorkspaceRevision: 2 }, 'host:new-session')).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    expect(data(await host.request('query.read', { queryId: source.queryId }))).toMatchObject({ query: { id: source.queryId } });
    expect(data(await host.request('answer.read', { runId: 10 }))).toBeNull();
    release.resolve(); let original: import('../../packages/contracts/src/export').ExportOperation | null = null;
    await Bun.sleep(10500);
    expect(data(await host.request('export.read', { operationRef: source.operationRef }))).toMatchObject({ state: 'copying', copyState: 'copying' });
    expect(data(await host.request('run.control.read', {}))).toMatchObject({ acceptingNewRuns: false });
    const deliveryDeadline = Date.now() + 30000;
    while (Date.now() < deliveryDeadline) { original = ExportOperationSchema.nullable().parse(data(await host.request('export.read', { operationRef: source.operationRef }))); if (original?.state === 'completed') break; await Bun.sleep(20); }
    expect(original).toMatchObject({ state: 'completed', copyState: 'verified', artifact: { queryId: source.queryId } });
    expect(readdirSync(target).sort()).toEqual(['metadata.json', 'result.csv']);
    expect(data(await host.request('evidence.readOperation', { kind: 'export', operationRef: source.operationRef }))).toEqual(original);
    expect(data(await host.request('evidence.readArtifact', { artifactId: original!.artifact!.id }))).toEqual(original!.artifact);
    expect(data(await host.request('export.list', { queryId: source.queryId }))).toMatchObject({ items: [original] });
    const activity = data(await host.request('activity.list', { sessionId: 1 })) as { items: { type: string }[] };
    expect(activity.items.filter(item => item.type.startsWith('export_'))).toHaveLength(2);
    expect(JSON.stringify(activity)).not.toContain(grant.destinationToken); expect(JSON.stringify(activity)).not.toContain(external);
    expect(data(await host.request('export.create', { ...request, destinationToken: 'expired' }, source.operationRef))).toEqual(original);
    expect(counts).toEqual({ describe: 1, copy: 1, settle: 1 });
    const saved = new Database(host.paths.databasePath, { readonly: true });
    try { expect(saved.query('SELECT id FROM model_calls').all()).toHaveLength(0); expect(saved.query('SELECT id FROM queries').all()).toHaveLength(3); }
    finally { saved.close(); }
    holdShutdown = true;
    const pendingSource = { ...source, operationRef: 'host:shutdown-copy' }, pendingGrant = destinations.issue(7, host.read().instanceId!, pendingSource, join(external, 'shutdown-bundle'));
    expect(data(await host.request('export.create', { ...pendingSource, destinationToken: pendingGrant.destinationToken, destinationIdentity: pendingGrant.destinationIdentity }, pendingSource.operationRef))).toMatchObject({ state: 'preparing' });
    await shutdownCopy.promise;
    expect(await host.stop(host.read().instanceId!)).toMatchObject({ state: 'stopped' });
    expect(counts.settle).toBe(2);
    const stopped = new Database(host.paths.databasePath, { readonly: true });
    try { expect(stopped.query('SELECT state,copy_state FROM exports WHERE operation_ref=?').get(pendingSource.operationRef)).toMatchObject({ state: 'cancelled', copy_state: 'unknown' }); }
    finally { stopped.close(); }
  } finally { release.resolve(); if (host.read().instanceId) await host.stop(host.read().instanceId!); await destinations.settlePrevious(); rmSync(root, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true }); }
}, 60000);
const migrations = ['001_p1.sql', '002_p2.sql', '003_p3.sql', '004_p5.sql', '005_p6.sql', '006_session_lifecycle.sql',
  '007_batch_deletion.sql', '008_p8.sql', '009_p9.sql', '010_p10.sql', '011_p11.sql', '012_p13.sql', '013_p14.sql'];
function schema13() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-migration-')), path = join(root, 'app.sqlite');
  const db = new Database(path, { strict: true });
  db.exec('PRAGMA foreign_keys=OFF');
  for (const [index, name] of migrations.entries()) {
    db.exec('PRAGMA foreign_keys=OFF');
    const sql = readFileSync(new URL(`../../packages/storage/src/migrations/${name}`, import.meta.url));
    db.exec(sql.toString());
    db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(index + 1, createHash('sha256').update(sql).digest('hex'), at);
  }
  db.exec('PRAGMA foreign_keys=ON');
  const seeded = seedWorkspaceQueries(db);
  db.query(`INSERT INTO artifacts(id,operation_ref,kind,import_id,format,relative_path,sha256,bytes,metadata_sha256,published_at,registered_at,mime_type,metadata_json,status)
    VALUES(51,'legacy-artifact','import',1,'csv','artifacts/51','sha-preserve',17,'metadata-preserve',?,?,'application/json','{ "raw": "工程😀", "null": null }','ready')`).run(at, at);
  db.query('UPDATE imports SET artifact_id=51 WHERE id=1').run();
  db.query(`INSERT INTO answers(id,run_id,session_id,input_id,kind,text,query_ids_json,missing_slots_json,native_leaf_id,created_at)
    VALUES(61,10,1,NULL,'result','ENGINEERING saved answer',?,'[]',NULL,?)`).run(JSON.stringify([seeded.current.id]), at);
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const before = new Map(tables.map(name => [name, db.query<Record<string, unknown>, []>(`SELECT * FROM ${name} ORDER BY id`).all()]));
  const schema = db.query("SELECT * FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return { root, path, before, schema, queryId: seeded.current.id };
}
function preserved(db: Database, f: ReturnType<typeof schema13>) {
  for (const [table, rows] of f.before) {
    if (table === 'schema_migrations') continue;
    const after = db.query<Record<string, unknown>, []>(`SELECT * FROM ${table} ORDER BY id`).all();
    expect(after.map(row => Object.fromEntries(Object.keys(rows[0] ?? row).map(key => [key, row[key]])))).toEqual(rows);
  }
}

test('p15 migration preserves all schema13 facts and import artifact bytes with valid foreign keys', () => {
  const f = schema13();
  let db = openDatabase(f.path);
  try {
    expect(db.query('SELECT MAX(version) AS n FROM schema_migrations').get()).toEqual({ n: 15 });
    preserved(db, f);
    expect(db.query('SELECT export_id,query_id FROM artifacts WHERE id=51').get()).toEqual({ export_id: null, query_id: null });
    expect(db.query('SELECT export_id FROM business_events WHERE export_id IS NOT NULL').all()).toEqual([]);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    db.close(); db = openDatabase(f.path); preserved(db, f);
  } finally { db.close(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const phase of ['p15_copy', 'p15_rename', 'p15_marker']) test(`p15 migration failure at ${phase} rolls back schema, old rows and marker`, () => {
  const f = schema13();
  try {
    let reached = false;
    let unexpectedlyOpened: Database | undefined;
    try { expect(() => { unexpectedlyOpened = openDatabase(f.path, current => { if (current === phase) { reached = true; throw new Error('ENGINEERING migration fault'); } }); }).toThrow('storage_migration_failed'); }
    finally { unexpectedlyOpened?.close(); }
    expect(reached).toBe(true);
    const raw = new Database(f.path);
    try {
      expect(raw.query('SELECT MAX(version) AS n FROM schema_migrations').get()).toEqual({ n: 13 });
      expect(raw.query("SELECT * FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).toEqual(f.schema);
      for (const [table, rows] of f.before) expect(raw.query(`SELECT * FROM ${table} ORDER BY id`).all()).toEqual(rows);
    } finally { raw.close(); }
    const recovered = openDatabase(f.path);
    try { preserved(recovered, f); expect(recovered.query('SELECT MAX(version) AS n FROM schema_migrations').get()).toEqual({ n: 15 }); }
    finally { recovered.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('p15 export DDL rejects cross-session references, invalid artifact owners and forged or mutable terminal facts', () => {
  const f = schema13(), db = openDatabase(f.path);
  try {
    expect(db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name='exports'").get()).not.toBeNull();
    const insert = db.query(`INSERT INTO exports(operation_ref,instance_id,session_id,query_id,answer_id,format,request_hash,state,created_at,updated_at)
      VALUES(?,'host',?,?,?,'json',?,'preparing',?,?)`);
    expect(() => insert.run('cross-session', 999, f.queryId, 61, 'a'.repeat(64), at, at)).toThrow();
    insert.run('export:original', 1, f.queryId, 61, 'a'.repeat(64), at, at);
    expect(() => db.query("UPDATE exports SET state='completed',copy_state='verified' WHERE operation_ref='export:original'").run()).toThrow();
    expect(() => db.query("UPDATE exports SET query_id=999 WHERE operation_ref='export:original'").run()).toThrow('export_identity_immutable');
    expect(() => db.query(`INSERT INTO artifacts(operation_ref,kind,import_id,export_id,query_id,format,mime_type)
      VALUES('bad-owner','export',1,1,?,'json','application/json')`).run(f.queryId)).toThrow();
    db.query("UPDATE exports SET state='failed',error_json='{}' WHERE operation_ref='export:original'").run();
    expect(() => db.query("UPDATE exports SET state='preparing' WHERE operation_ref='export:original'").run()).toThrow('export_terminal_immutable');
    expect(() => db.query("UPDATE exports SET copy_state='unknown' WHERE operation_ref='export:original'").run()).toThrow('export_terminal_immutable');
    expect(() => db.query("UPDATE exports SET error_json=NULL WHERE operation_ref='export:original'").run()).toThrow('export_terminal_immutable');
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); rmSync(f.root, { recursive: true, force: true }); }
});

const hash = (value: unknown) => createHash('sha256').update(canonicalRequest(value)).digest('hex');
const destination = 'd'.repeat(64);
function requestHash(source: FrozenExportSource, priorOperationRef: string | null = null) {
  return hash({ queryId: source.query.id, resultHash: source.query.resultHash, answerId: source.answer?.id ?? null,
    answerTextHash: source.answer ? createHash('sha256').update(source.answer.text).digest('hex') : null,
    format: 'json', exportVersion: 'medclaw.export/v1', priorOperationRef, destinationIdentity: destination });
}
async function storageFixture() {
  expect(await Bun.file(new URL('../../packages/storage/src/export-store.ts', import.meta.url)).exists()).toBe(true);
  const { SqliteExportStore } = await import('../../packages/storage/src/export-store');
  const f = schema13(), db = openDatabase(f.path), store = new SqliteExportStore(db);
  return { ...f, db, store, close() { db.close(); rmSync(f.root, { recursive: true, force: true }); } };
}
function proof(source: FrozenExportSource, artifactId: number): PublishedExport {
  const files = [{ path: 'result.json' as const, bytes: 7, sha256: 'f'.repeat(64) }];
  return { artifactId, relativePath: `artifacts/${artifactId}`, manifest: { contract: 'medclaw.export-manifest/v1', artifactId,
    originOperationRef: 'export:one', queryId: source.query.id, resultHash: source.query.resultHash, answerId: source.answer?.id ?? null,
    format: 'json', exportVersion: 'medclaw.export/v1', metadataHash: 'e'.repeat(64), files },
    sha256: hash(files), sizeBytes: 7, metadataSha256: 'e'.repeat(64), publishedAt: at };
}
function receipt(published: PublishedExport, operationRef = 'export:one'): ExportCopyReceipt {
  return { contract: 'medclaw.export-receipt/v1', operationRef, artifactId: published.artifactId, destinationIdentity: destination,
    contentHash: published.sha256, verifiedAt: at, files: published.manifest.files.map(file => ({ name: file.path, bytes: file.bytes, sha256: file.sha256 })) };
}

test('p15 storage accepts once, checks original source and commits registration and delivery atomically', async () => {
  const f = await storageFixture();
  try {
    const source = f.store.readSource(f.queryId, 61), input = { operationRef: 'export:one', requestHash: requestHash(source), instanceId: 'host',
      sessionId: 1, queryId: f.queryId, answerId: 61, format: 'json' as const, priorExportId: null, reuseArtifactId: null, createdAt: at };
    const original = f.store.accept(input);
    expect(original).toMatchObject({ state: 'preparing', artifact: null, copyState: 'not_started' });
    expect(f.store.accept(input)).toEqual(original);
    expect(() => f.store.accept({ ...input, requestHash: 'b'.repeat(64) })).toThrow('state_conflict');
    expect(f.db.query('SELECT id FROM exports').all()).toHaveLength(1);
    const published = proof(source, original.reservedArtifactId!);
    f.store.publish(input.operationRef, published);
    expect(f.store.find(input.operationRef)).toMatchObject({ state: 'published', artifact: null, publishedHash: published.sha256 });
    f.db.exec("CREATE TEMP TRIGGER fail_registration BEFORE INSERT ON business_events WHEN NEW.type='export_registered' BEGIN SELECT RAISE(ABORT,'ENGINEERING register fault'); END");
    expect(() => f.store.register(input.operationRef, published)).toThrow();
    expect(f.store.find(input.operationRef)?.state).toBe('published');
    expect(f.db.query('SELECT status FROM artifacts WHERE id=?').get(original.reservedArtifactId!)).toEqual({ status: 'reserved' });
    f.db.exec('DROP TRIGGER fail_registration');
    f.store.register(input.operationRef, published); f.store.register(input.operationRef, published);
    expect(f.store.find(input.operationRef)).toMatchObject({ state: 'registered', artifact: { id: published.artifactId } });
    expect(f.db.query("SELECT id FROM business_events WHERE type='export_registered'").all()).toHaveLength(1);
    f.store.beginCopy(input.operationRef);
    expect(() => f.store.complete(input.operationRef, { ...receipt(published), destinationIdentity: 'c'.repeat(64) })).toThrow('state_conflict');
    expect(() => f.store.complete(input.operationRef, { ...receipt(published), contentHash: 'c'.repeat(64) })).toThrow('state_conflict');
    f.db.exec("CREATE TEMP TRIGGER fail_copy BEFORE INSERT ON business_events WHEN NEW.type='export_copied' BEGIN SELECT RAISE(ABORT,'ENGINEERING receipt fault'); END");
    expect(() => f.store.complete(input.operationRef, receipt(published))).toThrow();
    expect(f.store.find(input.operationRef)).toMatchObject({ state: 'copying', copyReceipt: null });
    f.db.exec('DROP TRIGGER fail_copy');
    f.store.complete(input.operationRef, receipt(published)); f.store.complete(input.operationRef, receipt(published));
    expect(f.store.find(input.operationRef)).toMatchObject({ state: 'completed', copyState: 'verified', copyReceipt: receipt(published) });
    expect(f.db.query("SELECT id FROM business_events WHERE type='export_copied'").all()).toHaveLength(1);
  } finally { f.close(); }
});

test('p15 storage recovery preserves old failure and new attempts reuse the original registered artifact', async () => {
  const f = await storageFixture();
  try {
    const source = f.store.readSource(f.queryId, null), input = { operationRef: 'export:one', requestHash: requestHash(source), instanceId: 'host',
      sessionId: 1, queryId: f.queryId, answerId: null, format: 'json' as const, priorExportId: null, reuseArtifactId: null, createdAt: at };
    const original = f.store.accept(input), published = proof(source, original.reservedArtifactId!);
    f.store.terminate(input.operationRef, 'failed', safeError('storage_write_failed'), 'unknown');
    f.store.register(input.operationRef, { ...published, publishedAt: null });
    expect(f.store.find(input.operationRef)).toMatchObject({ state: 'failed', copyState: 'unknown', error: { code: 'storage_write_failed' },
      artifact: { id: published.artifactId, publishedAt: null } });
    expect(() => f.store.beginCopy(input.operationRef)).toThrow('state_conflict');
    const retry = f.store.accept({ ...input, operationRef: 'export:retry', requestHash: requestHash(source, input.operationRef),
      priorExportId: original.id, reuseArtifactId: published.artifactId });
    f.store.register(retry.operationRef, { ...published, publishedAt: null });
    f.store.beginCopy(retry.operationRef); f.store.complete(retry.operationRef, receipt(published, retry.operationRef));
    expect(f.store.find(retry.operationRef)).toMatchObject({ state: 'completed', priorOperationRef: input.operationRef, artifact: { operationRef: input.operationRef } });
    expect(f.db.query("SELECT id FROM artifacts WHERE kind='export'").all()).toHaveLength(1);
    expect(f.db.query("SELECT id FROM business_events WHERE type='export_registered'").all()).toHaveLength(1);
    expect(f.store.find(input.operationRef)?.state).toBe('failed');
  } finally { f.close(); }
});

test('p15 storage refuses invalid answer links, deleted sessions and corrupt saved queries without hiding read failures', async () => {
  const f = await storageFixture();
  try {
    expect(f.store.readSource(f.queryId, 61).answer?.queryIds).toContain(f.queryId);
    f.db.query("UPDATE answers SET query_ids_json='[]' WHERE id=61").run();
    expect(() => f.store.readSource(f.queryId, 61)).toThrow('access_denied');
    expect(() => f.db.query('UPDATE queries SET result_hash=? WHERE id=?').run('b'.repeat(64), f.queryId)).toThrow('query_immutable');
    f.db.exec('DROP TRIGGER queries_update_immutable'); // Simulate disk corruption beyond normal write admission.
    f.db.query('UPDATE queries SET result_hash=? WHERE id=?').run('b'.repeat(64), f.queryId);
    expect(() => f.store.readSource(f.queryId, null)).toThrow();
    f.db.query("UPDATE sessions SET status='deleted',deleted_at=? WHERE id=1").run(at);
    expect(() => f.store.readSource(f.queryId, null)).toThrow('access_denied');
    f.db.close();
    expect(() => f.store.find('missing')).toThrow();
  } finally { f.close(); }
});

test('p15 storage reserves atomically, pages attempts without effects and retains known publication time on recovery', async () => {
  const f = await storageFixture();
  try {
    const source = f.store.readSource(f.queryId, null), input = { operationRef: 'export:one', requestHash: requestHash(source), instanceId: 'host',
      sessionId: 1, queryId: f.queryId, answerId: null, format: 'json' as const, priorExportId: null, reuseArtifactId: null, createdAt: at };
    f.db.exec("CREATE TEMP TRIGGER fail_reservation BEFORE INSERT ON artifacts WHEN NEW.kind='export' BEGIN SELECT RAISE(ABORT,'ENGINEERING reservation fault'); END");
    expect(() => f.store.accept(input)).toThrow();
    expect(f.store.find(input.operationRef)).toBeNull();
    expect(f.db.query("SELECT id FROM artifacts WHERE kind='export'").all()).toEqual([]);
    f.db.exec('DROP TRIGGER fail_reservation');
    const original = f.store.accept(input), published = proof(source, original.reservedArtifactId!);
    f.store.publish(input.operationRef, published);
    f.store.terminate(input.operationRef, 'failed', safeError('storage_write_failed'), 'not_started');
    f.store.register(input.operationRef, { ...published, publishedAt: null });
    expect(f.store.find(input.operationRef)?.artifact?.publishedAt).toBe(at);
    const next = f.store.accept({ ...input, operationRef: 'export:retry', requestHash: requestHash(source, input.operationRef),
      priorExportId: original.id, reuseArtifactId: published.artifactId });
    const events = f.db.query('SELECT * FROM business_events').all();
    const page = f.store.list({ queryId: f.queryId, limit: 1 });
    expect(page.items.map(item => item.operationRef)).toEqual([next.operationRef]);
    expect(page.nextBeforeExportId).toBe(next.id);
    expect(f.store.list({ queryId: f.queryId, limit: 1, beforeExportId: page.nextBeforeExportId! }).items.map(item => item.operationRef)).toEqual([input.operationRef]);
    expect(f.db.query('SELECT * FROM business_events').all()).toEqual(events);
  } finally { f.close(); }
});

test('p15 storage exports frozen rows after batch deletion and distinguishes missing source records from an empty result', async () => {
  const f = await storageFixture();
  try {
    const before = f.store.readSource(f.queryId, null);
    const repositories = new Repositories(f.db), deletion = new SqliteDataDeletionStore(f.db, repositories);
    const preview = deletion.preview({ operationRef: 'ENGINEERING-delete', target: { kind: 'batches', batchIds: [1] },
      expectedCatalogRevision: 0, expectedWorkspaceRevision: repositories.readWorkspace().revision }, 'host', at, []);
    deletion.commit({ operationRef: preview.operationRef, previewHash: preview.preview.previewHash,
      expectedCatalogRevision: preview.preview.catalogRevision, expectedWorkspaceRevision: preview.preview.workspaceRevision }, at);
    expect(f.db.query('SELECT * FROM snapshots').all()).toEqual([]);
    const after = f.store.readSource(f.queryId, null);
    expect(after.query).toEqual(before.query);
    expect(after).toMatchObject({ sourceAvailability: 'deleted', deletedBatchIds: [1] });
    expect(after.query.rows.length).toBeGreaterThan(0);
    expect(() => f.store.readSource(999, null)).toThrow('operation_not_found');
  } finally { f.close(); }
});

test('p15 storage persists cancellation requests while verified completion can win and terminal delivery cannot restart', async () => {
  const f = await storageFixture();
  try {
    const source = f.store.readSource(f.queryId, null), original = f.store.accept({ operationRef: 'export:one', requestHash: requestHash(source), instanceId: 'host',
      sessionId: 1, queryId: f.queryId, answerId: null, format: 'json', priorExportId: null, reuseArtifactId: null, createdAt: at });
    const published = proof(source, original.reservedArtifactId!);
    f.store.publish(original.operationRef, published); f.store.register(original.operationRef, published); f.store.beginCopy(original.operationRef);
    const requested = f.store.requestCancel(original.operationRef);
    expect(requested.state).toBe('copying'); expect(requested.cancelRequestedAt).not.toBeNull();
    expect(f.store.requestCancel(original.operationRef)).toEqual(requested);
    expect(f.store.unfinished().map(item => item.operationRef)).toEqual([original.operationRef]);
    f.store.complete(original.operationRef, receipt(published));
    const completed = f.store.find(original.operationRef)!;
    expect(completed).toMatchObject({ state: 'completed', copyState: 'verified', cancelRequestedAt: requested.cancelRequestedAt });
    expect(f.store.requestCancel(original.operationRef)).toEqual(completed);
    expect(f.store.unfinished()).toEqual([]);
    expect(() => f.store.terminate(original.operationRef, 'cancelled', null, 'not_started')).toThrow('state_conflict');
  } finally { f.close(); }
});

test('p15 destination publication uses real Windows moves without replacing existing files or empty directories', async () => {
  expect(await Bun.file(new URL('../../packages/storage/src/publish-no-replace.ts', import.meta.url)).exists()).toBe(true);
  const { publishNoReplace } = await import('../../packages/storage/src/publish-no-replace');
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-publish-'));
  try {
    const source = join(root, "stage '汉字.tmp"), target = join(root, 'result $(literal).json');
    writeFileSync(source, 'ENGINEERING 😀');
    await publishNoReplace(source, target, 'file');
    expect(readFileSync(target, 'utf8')).toBe('ENGINEERING 😀'); expect(existsSync(source)).toBe(false);
    writeFileSync(source, 'replacement');
    await expect(publishNoReplace(source, target, 'file')).rejects.toThrow('destination_conflict');
    expect(readFileSync(target, 'utf8')).toBe('ENGINEERING 😀'); expect(readFileSync(source, 'utf8')).toBe('replacement');
    const staging = join(root, 'staging-dir'), existing = join(root, 'existing-dir');
    mkdirSync(staging); mkdirSync(existing); writeFileSync(join(staging, 'file'), 'keep');
    await expect(publishNoReplace(staging, existing, 'directory')).rejects.toThrow('destination_conflict');
    expect(readdirSync(existing)).toEqual([]); expect(readFileSync(join(staging, 'file'), 'utf8')).toBe('keep');
    await expect(publishNoReplace(staging, join(tmpdir(), 'wrong-parent'), 'directory')).rejects.toThrow('invalid_argument');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20000);

test('p15 destination concurrent publication admits exactly one whole directory and preserves the loser', async () => {
  expect(await Bun.file(new URL('../../packages/storage/src/publish-no-replace.ts', import.meta.url)).exists()).toBe(true);
  const { publishNoReplace } = await import('../../packages/storage/src/publish-no-replace');
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-publish-'));
  try {
    const paths = ['one', 'two'].map(name => { const path = join(root, name); mkdirSync(path); writeFileSync(join(path, 'payload'), name); return path; });
    const target = join(root, 'published'), results = await Promise.allSettled(paths.map(path => publishNoReplace(path, target, 'directory')));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const winner = readFileSync(join(target, 'payload'), 'utf8');
    expect(['one', 'two']).toContain(winner);
    expect(existsSync(join(root, winner))).toBe(false);
    const loser = winner === 'one' ? 'two' : 'one';
    expect(readFileSync(join(root, loser, 'payload'), 'utf8')).toBe(loser);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20000);
