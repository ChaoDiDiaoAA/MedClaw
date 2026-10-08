import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalRequest } from '../../packages/contracts/src/run';
import { openDatabase } from '../../packages/storage/src/database';
import { ArtifactStore } from '../../packages/storage/src/artifact-store';
import { SqliteImportStore } from '../../packages/storage/src/import-store';
import { ImportService, readCsvRecords } from '../../packages/core/src/data/import-service';

const roots: string[] = [];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const csv = (values: string[]) => values.map(value => `"${value.replaceAll('"', '""')}"`).join(',');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

export function packageFixture(root: string, options: { prices?: (number | null)[]; missing?: boolean; scopeKey?: string; referenceDate?: string } = {}) {
  mkdirSync(root, { recursive: true });
  const masters = [{ record_type: 'master', device_id: '00001', device_name: 'Device,\nwith quote "', source_submission_id: '00009', source_applicant: 'Applicant', category: 'Category', manufacturer: 'Synthetic manufacturer' }];
  const cohortHash = hash(canonicalRequest(masters));
  const sourceLock = { schema: 'medclaw.source-lock/v1', sources: [{ source: 'fda', path: 'missing-original.zip', sha256: 'a'.repeat(64), url: 'https://example.invalid/source' }] };
  const sourceLockHash = hash(canonicalRequest(sourceLock));
  writeFileSync(join(root, 'source-lock.json'), JSON.stringify(sourceLock));
  writeFileSync(join(root, 'entity-lineage.csv'), `${csv(Object.keys(masters[0]!))}\n${csv(Object.values(masters[0]!))}\n`);
  for (const name of ['adjustment-lineage.csv', 'validation-report.json', 'selection-report.json', '使用说明.md']) writeFileSync(join(root, name), name.endsWith('.json') ? '{}' : 'auxiliary');
  const refs = [{ sourceId: 'fda', file: 'missing-original.zip', row: 1, recordId: '00009', sha256: 'a'.repeat(64) }];
  const headers = ['device_id', 'device_name', 'source_submission_id', 'source_applicant', 'category', 'region', 'snapshot_date', 'price_cents', 'currency', 'unit', 'status', 'manufacturer', 'distributor', 'source_refs_json', 'field_origins_json'];
  const origins = Object.fromEntries(headers.slice(0, 13).map(key => [key, { kind: 'synthetic', ruleId: 'fixture' }]));
  const prices = options.prices ?? [100, 80];
  for (const [index, price] of prices.entries()) {
    const date = `2026-01-0${index + 1}`;
    const missing = options.missing && index === 1;
    const text = `${csv(headers)}\r\n${missing ? '' : `${csv(['00001', masters[0]!.device_name, '00009', 'Applicant', 'Category', '浙江', date, price === null ? '' : String(price), 'CNY', '件', 'active', 'Synthetic manufacturer', 'Distributor', JSON.stringify(refs), JSON.stringify(origins)])}\r\n`}`;
    writeFileSync(join(root, `zhejiang_${date}.csv`), text);
    writeFileSync(join(root, `zhejiang_${date}.metadata.json`), JSON.stringify({ contract: 'medclaw.snapshot/v1', mappingVersion: 'medclaw.snapshot/v1', materialVersion: 'fixture/v1', generatorVersion: 'fixture/v1', seed: 1, sourceBundleId: 'fixture', sourceLockHash, scopeKey: options.scopeKey ?? 'scope', region: '浙江', cohortHash, snapshotDate: date, coverage: 'full', expectedEntityCount: 1, observedEntityCount: missing ? 0 : 1, declaredMissingEntityIds: missing ? ['00001'] : [], ...(missing ? { missingReason: 'Fixture unavailable' } : {}), fileSha256: hash(text), referenceDate: options.referenceDate ?? `2026-01-0${prices.length}`, timezone: 'Asia/Shanghai' }));
  }
  refreshManifest(root, prices.length, options.missing ? prices.length - 1 : prices.length);
}
export function refreshManifest(root: string, count: number, rowCount: number) {
  const files = readdirSync(root).filter(name => name !== 'manifest.json').sort().map(path => { const bytes = readFileSync(join(root, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }; });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ status: 'complete', files, businessFiles: count, businessRows: rowCount, businessBytes: files.filter(file => /^zhejiang_.*\.csv$/.test(file.path)).reduce((sum, file) => sum + file.bytes, 0), totalPayloadBytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
}
function fixture(options: Parameters<typeof packageFixture>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p3-import-')); roots.push(root);
  const source = join(root, 'source'); packageFixture(source, options);
  const db = openDatabase(join(root, 'app.sqlite'));
  const artifacts = new ArtifactStore(db, join(root, 'artifacts'));
  const store = new SqliteImportStore(db);
  const service = new ImportService({ store, artifacts, resolveToken: token => { if (token !== 'allowed') throw new Error('file_token_invalid'); return source; }, instanceId: 'instance' });
  return { root, source, db, service, store, artifacts, preview: () => service.preview({ operationRef: 'import-1', fileToken: 'allowed', mappingVersion: 'medclaw.snapshot/v1' }) };
}
test('P3 package preview reserves files without business writes; atomic commit computes actual Diff and duplicate stays ready', async () => {
  const f = fixture();
  try {
    const preview = await f.preview(); expect(preview.ok).toBe(true); if (!preview.ok) return;
    expect(preview.data.canCommit).toBe(true); expect(preview.data.rowCount).toBe(2);
    expect(f.db.query('SELECT count(*) n FROM snapshots').get()).toEqual({ n: 0 });
    const operation = await f.service.read('import-1'); expect(operation.ok && operation.data?.state).toBe('ready');
    expect(operation.ok && operation.data?.artifactId).toBeGreaterThan(0);
    const committed = await f.service.commit({ operationRef: 'import-1', previewHash: preview.data.previewHash, fileToken: 'allowed' });
    expect(committed.ok && committed.data.state).toBe('imported');
    expect(f.db.query('SELECT field,delta_cents,ratio FROM change_events').all()).toEqual([{ field: 'price', delta_cents: -20, ratio: -0.2 }]);
    expect(f.db.query('SELECT source_device_id,source_submission_id FROM devices').get()).toEqual({ source_device_id: '00001', source_submission_id: '00009' });
    const duplicate = await f.service.preview({ operationRef: 'import-2', fileToken: 'allowed', mappingVersion: 'medclaw.snapshot/v1' });
    expect(duplicate.ok && duplicate.data.duplicateBatchCount).toBe(2); if (!duplicate.ok) return;
    const result = await f.service.commit({ operationRef: 'import-2', previewHash: duplicate.data.previewHash, fileToken: 'allowed' });
    expect(result.ok && result.data.result?.acceptedRows).toBe(0); expect(result.ok && result.data.state).toBe('duplicate');
    expect(f.store.revision()).toBe(1); expect(f.db.query("SELECT status FROM artifacts ORDER BY id").all()).toEqual([{ status: 'ready' }, { status: 'ready' }]);
    expect(await f.service.commit({ operationRef: 'import-1', previewHash: preview.data.previewHash, fileToken: 'allowed' })).toEqual(committed);
  } finally { f.db.close(); }
});
test('P3 rejects unauthorized token, damaged package and stale source or managed copy', async () => {
  const f = fixture(); try {
    const denied = await f.service.preview({ operationRef: 'denied', fileToken: 'wrong', mappingVersion: 'medclaw.snapshot/v1' });
    expect(denied.ok).toBe(false);
    const preview = await f.preview(); if (!preview.ok) throw new Error('preview');
    writeFileSync(join(f.source, '使用说明.md'), 'changed');
    const stale = await f.service.commit({ operationRef: 'import-1', previewHash: preview.data.previewHash, fileToken: 'allowed' });
    expect(stale.ok).toBe(false); if (!stale.ok) expect(stale.error.code).toBe('import_preview_stale');
    expect(f.store.revision()).toBe(0); expect((await f.service.read('import-1')).ok).toBe(true);
    const broken = await f.service.preview({ operationRef: 'broken', fileToken: 'allowed', mappingVersion: 'medclaw.snapshot/v1' });
    expect(broken.ok && broken.data.canCommit).toBe(false); expect(broken.ok && broken.data.issues[0]?.file).toBe('使用说明.md');
  } finally { f.db.close(); }
});

test('P3 imports optional README only as a manifest-bound package file', async () => {
  const f = fixture(); try {
    writeFileSync(join(f.source, 'README.md'), '# Complete verification dataset\n');
    refreshManifest(f.source, 2, 2);
    const preview = await f.preview();
    expect(preview.ok && preview.data.canCommit).toBe(true);
    if (!preview.ok) throw new Error('preview');
    writeFileSync(join(f.source, 'README.md'), '# Changed after preview\n');
    const stale = await f.service.commit({ operationRef: 'import-1', previewHash: preview.data.previewHash, fileToken: 'allowed' });
    expect(stale).toMatchObject({ ok: false, error: { code: 'import_preview_stale' } });
    expect(f.store.revision()).toBe(0);
    expect(f.db.query('SELECT count(*) n FROM snapshots').get()).toEqual({ n: 0 });
  } finally { f.db.close(); }
});
test('P3 day failure rolls back the whole package and cancellation never commits', async () => {
  const f = fixture(); try {
    const preview = await f.preview(); if (!preview.ok) throw new Error('preview');
    f.db.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON snapshots WHEN NEW.batch_id=2 BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    const failed = await f.service.commit({ operationRef: 'import-1', previewHash: preview.data.previewHash, fileToken: 'allowed' });
    expect(failed.ok).toBe(false); expect(f.store.revision()).toBe(0);
    for (const table of ['devices', 'batches', 'snapshots', 'change_events']) expect(f.db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    f.db.exec('DROP TRIGGER fixture_fail');
    const next = await f.service.preview({ operationRef: 'cancelled', priorOperationRef: 'import-1', fileToken: 'allowed', mappingVersion: 'medclaw.snapshot/v1' });
    if (!next.ok) throw new Error('preview');
    expect((await f.service.cancel('cancelled')).ok).toBe(true);
    const cancelled = await f.service.commit({ operationRef: 'cancelled', previewHash: next.data.previewHash, fileToken: 'allowed' });
    expect(cancelled.ok && cancelled.data.state).toBe('cancelled'); expect(f.store.revision()).toBe(0);
  } finally { f.db.close(); }
});
test('P3 accepted commit stays observable during token validation and cancellation preserves empty business tables', async () => {
  const f = fixture();
  let enter!: () => void;
  let release!: (source: string) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const authorized = new Promise<string>(resolve => { release = resolve; });
  const service = new ImportService({ store: f.store, artifacts: f.artifacts, resolveToken: () => { enter(); return authorized; }, instanceId: 'instance' });
  try {
    const preview = await f.preview(); if (!preview.ok) throw new Error('preview');
    const request = { operationRef: 'import-1', previewHash: preview.data.previewHash, fileToken: 'allowed' };
    const commit = service.commit(request); await entered;
    expect(await service.read(request.operationRef)).toMatchObject({ ok: true, data: { state: 'committing', result: null } });
    expect(f.store.read(request.operationRef)?.commitRequest).toEqual(request);
    expect(f.db.query('SELECT status FROM artifacts').get()).toEqual({ status: 'reserved' });
    for (const table of ['devices', 'batches', 'snapshots', 'change_events']) expect(f.db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(await service.commit({ ...request, fileToken: 'changed' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    const replay = service.commit(request);
    expect(await service.cancel(request.operationRef)).toMatchObject({ ok: true, data: { state: 'cancelled' } });
    release(f.source);
    expect(await commit).toMatchObject({ ok: false, error: { code: 'import_cancelled' } });
    expect(await replay).toMatchObject({ ok: false, error: { code: 'import_cancelled' } });
    expect(await service.read(request.operationRef)).toMatchObject({ ok: true, data: { state: 'cancelled', result: null } });
    expect(f.store.revision()).toBe(0);
    for (const table of ['devices', 'batches', 'snapshots', 'change_events']) expect(f.db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
  } finally {
    const closed = service.shutdown(); release(f.source); await closed; f.db.close();
  }
});

test('P3 stream CSV keeps BOM, leading zeros, escaped quotes and multiline logical records', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p3-csv-')); roots.push(root);
  const file = join(root, 'input.csv'); writeFileSync(file, '\ufeffid,text\r\n00001,"line1\r\nline2,""quoted"""\r\n');
  expect([...readCsvRecords(file)]).toEqual([['id', 'text'], ['00001', 'line1\r\nline2,"quoted"']]);
  writeFileSync(file, 'id,text\n1,"unclosed'); expect(() => [...readCsvRecords(file)]).toThrow();
});
test('P3 strictly appends new dates, preserves duplicate facts and rejects changed history or scope binding', async () => {
  const f = fixture(); try {
    const preview = await f.preview(); if (!preview.ok) throw new Error('preview');
    await f.service.commit({ operationRef: 'import-1', previewHash: preview.data.previewHash, fileToken: 'allowed' });
    packageFixture(f.source, { prices: [100, 80, 70], referenceDate: '2026-01-02' });
    const append = await f.service.preview({ operationRef: 'append', fileToken: 'allowed', mappingVersion: 'medclaw.snapshot/v1' });
    expect(append.ok && append.data.canCommit).toBe(true); if (!append.ok) return;
    expect(append.data.newBatchCount).toBe(1); expect(append.data.duplicateBatchCount).toBe(2);
    const appended = await f.service.commit({ operationRef: 'append', previewHash: append.data.previewHash, fileToken: 'allowed' });
    expect(appended.ok && appended.data.result?.acceptedRows).toBe(1); expect(appended.ok && appended.data.result?.duplicateRows).toBe(2);
    expect(f.store.revision()).toBe(2); expect(f.db.query('SELECT previous_batch_id FROM batches ORDER BY id').all()).toEqual([{ previous_batch_id: null }, { previous_batch_id: 1 }, { previous_batch_id: 2 }]);
    packageFixture(f.source, { prices: [101, 80, 70], referenceDate: '2026-01-02' });
    const conflict = await f.service.preview({ operationRef: 'conflict', fileToken: 'allowed', mappingVersion: 'medclaw.snapshot/v1' });
    expect(conflict.ok && conflict.data.canCommit).toBe(false); expect(conflict.ok && conflict.data.issues[0]?.code).toBe('import_conflict');
    expect(conflict.ok && conflict.data.rowCount).toBe(3); expect(f.store.revision()).toBe(2);
    const metadataPath = join(f.source, 'zhejiang_2026-01-01.metadata.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')); metadata.region = '上海'; writeFileSync(metadataPath, JSON.stringify(metadata)); refreshManifest(f.source, 3, 3);
    const scope = await f.service.preview({ operationRef: 'scope-invalid', fileToken: 'allowed', mappingVersion: 'medclaw.snapshot/v1' });
    expect(scope.ok && scope.data.canCommit).toBe(false); expect(f.store.revision()).toBe(2);
  } finally { f.db.close(); }
});
test('P3 explicit missing and null or zero prices generate different deterministic facts', async () => {
  for (const options of [{ prices: [0, 50] }, { prices: [null, 0] }, { missing: true }]) {
    const f = fixture(options); try {
      const preview = await f.preview(); if (!preview.ok) throw new Error('preview');
      const committed = await f.service.commit({ operationRef: 'import-1', previewHash: preview.data.previewHash, fileToken: 'allowed' });
      expect(committed.ok && committed.data.state).toBe('imported');
      const events = f.db.query('SELECT kind,field,old_value_json,new_value_json,delta_cents,ratio FROM change_events').all();
      if ('missing' in options) expect(events).toEqual([{ kind: 'missing', field: null, old_value_json: 'null', new_value_json: 'null', delta_cents: null, ratio: null }]);
      else expect(events).toEqual([{ kind: 'field_changed', field: 'price', old_value_json: options.prices[0] === null ? 'null' : '0', new_value_json: String(options.prices[1]), delta_cents: options.prices[0] === null ? null : 50, ratio: null }]);
    } finally { f.db.close(); }
  }
});
test('P3 recover reads committed facts after source moves and interrupts only stopped previous instances', async () => {
  const f = fixture(); try {
    const preview = await f.preview(); if (!preview.ok) throw new Error('preview');
    await f.service.commit({ operationRef: 'import-1', previewHash: preview.data.previewHash, fileToken: 'allowed' });
    rmSync(f.source, { recursive: true });
    const restarted = new ImportService({ store: f.store, artifacts: f.artifacts, resolveToken: () => { throw new Error('file_token_invalid'); }, instanceId: 'next-instance' });
    const recovered = await restarted.recover('import-1'); expect(recovered.ok && recovered.data.state).toBe('imported'); expect(f.store.revision()).toBe(1);
    f.store.begin({ operationRef: 'orphan', fileToken: 'expired', mappingVersion: 'medclaw.snapshot/v1' }, 'stopped-instance');
    const interrupted = await restarted.recover('orphan'); expect(interrupted.ok && interrupted.data.state).toBe('interrupted'); expect(interrupted.ok && interrupted.data.result).toBeNull();
    expect(interrupted.ok && interrupted.data.artifactId).toBeGreaterThan(0); expect(f.store.revision()).toBe(1);
    expect((await restarted.read('unknown')).ok).toBe(true);
    const failure = await restarted.cancel('orphan'); expect(failure.ok).toBe(true);
    f.store.begin({ operationRef: 'write-failure', fileToken: 'expired', mappingVersion: 'medclaw.snapshot/v1' }, 'stopped-instance');
    f.db.exec("CREATE TRIGGER read_error BEFORE UPDATE ON imports BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    expect(() => f.store.update('write-failure', { state: 'interrupted' })).toThrow();
    expect(() => f.store.begin({ operationRef: 'blocked', fileToken: 'allowed', mappingVersion: 'medclaw.snapshot/v1' }, 'instance')).toThrow('operation_result_unknown');
  } finally { f.db.close(); }
});
test('P3 revalidates catalog revision and managed copy and guards same-operation method identity', async () => {
  const f = fixture(); try {
    const preview = await f.preview(); if (!preview.ok) throw new Error('preview');
    const different = await f.service.preview({ operationRef: 'import-1', fileToken: 'different', mappingVersion: 'medclaw.snapshot/v1' }); expect(different.ok).toBe(false); if (!different.ok) expect(different.error.code).toBe('state_conflict');
    const second = await f.service.preview({ operationRef: 'import-2', fileToken: 'allowed', mappingVersion: 'medclaw.snapshot/v1' }); if (!second.ok) throw new Error('preview');
    await f.service.commit({ operationRef: 'import-1', previewHash: preview.data.previewHash, fileToken: 'allowed' });
    const stale = await f.service.commit({ operationRef: 'import-2', previewHash: second.data.previewHash, fileToken: 'allowed' }); expect(stale.ok).toBe(false); if (!stale.ok) expect(stale.error.code).toBe('import_preview_stale');
    const third = await f.service.preview({ operationRef: 'import-3', fileToken: 'allowed', mappingVersion: 'medclaw.snapshot/v1' }); if (!third.ok) throw new Error('preview');
    const operation = await f.service.read('import-3'); if (!operation.ok || !operation.data?.artifactId) throw new Error('read');
    writeFileSync(join(f.artifacts.inputPath(operation.data.artifactId), 'validation-report.json'), 'changed');
    const changed = await f.service.commit({ operationRef: 'import-3', previewHash: third.data.previewHash, fileToken: 'allowed' }); expect(changed.ok).toBe(false); if (!changed.ok) expect(changed.error.code).toBe('import_preview_stale'); expect(f.store.revision()).toBe(1);
  } finally { f.db.close(); }
});
test('P3 validates manifest traversal and file membership, source refs, cohort, JSON, amounts and collection counts', async () => {
  for (const scenario of ['extra', 'traversal', 'duplicate-path', 'cohort', 'missing-reason', 'amount', 'json', 'source', 'origins'] as const) {
    const f = fixture(); try {
      const file = join(f.source, 'zhejiang_2026-01-01.csv'), metadataPath = join(f.source, 'zhejiang_2026-01-01.metadata.json');
      if (scenario === 'extra') writeFileSync(join(f.source, 'extra.csv'), 'unknown');
      else if (scenario === 'traversal' || scenario === 'duplicate-path') {
        const manifestPath = join(f.source, 'manifest.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (scenario === 'traversal') manifest.files[0].path = '../escaped'; else manifest.files.push(manifest.files[0]);
        writeFileSync(manifestPath, JSON.stringify(manifest));
      } else if (scenario === 'cohort' || scenario === 'missing-reason') {
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
        if (scenario === 'cohort') metadata.cohortHash = '0'.repeat(64); else metadata.declaredMissingEntityIds = ['00001'];
        writeFileSync(metadataPath, JSON.stringify(metadata)); refreshManifest(f.source, 2, 2);
      } else {
        const records = [...readCsvRecords(file)], headers = records[0]!, row = records[1]!;
        const key = scenario === 'amount' ? 'price_cents' : scenario === 'json' || scenario === 'source' ? 'source_refs_json' : 'field_origins_json';
        row[headers.indexOf(key)] = scenario === 'amount' ? '-0.01' : scenario === 'json' ? '{invalid' : scenario === 'source' ? JSON.stringify([{ sourceId: 'outside', file: 'outside.zip', row: 1, recordId: '1', sha256: 'a'.repeat(64) }]) : '{}';
        const text = records.map(csv).join('\n') + '\n'; writeFileSync(file, text);
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')); metadata.fileSha256 = hash(text); writeFileSync(metadataPath, JSON.stringify(metadata)); refreshManifest(f.source, 2, 2);
      }
      const preview = await f.preview(); expect(preview.ok && preview.data.canCommit).toBe(false); expect(f.store.revision()).toBe(0); expect(f.db.query('SELECT count(*) n FROM batches').get()).toEqual({ n: 0 });
    } finally { f.db.close(); }
  }
});
test('P3 same scope rejects coherent new source bindings and historical backfill', async () => {
  const f = fixture(); try {
    rmSync(join(f.source, 'zhejiang_2026-01-01.csv')); rmSync(join(f.source, 'zhejiang_2026-01-01.metadata.json')); refreshManifest(f.source, 1, 1);
    const initial = await f.preview(); if (!initial.ok) throw new Error('preview');
    const result = await f.service.commit({ operationRef: 'import-1', previewHash: initial.data.previewHash, fileToken: 'allowed' }); expect(result.ok && result.data.state).toBe('imported');
    packageFixture(f.source);
    const backfill = await f.service.preview({ operationRef: 'backfill', fileToken: 'allowed', mappingVersion: 'medclaw.snapshot/v1' }); expect(backfill.ok && backfill.data.canCommit).toBe(false); expect(backfill.ok && backfill.data.issues[0]?.code).toBe('import_conflict');
    for (const file of readdirSync(f.source).filter(file => file.endsWith('.metadata.json'))) { const path = join(f.source, file), metadata = JSON.parse(readFileSync(path, 'utf8')); metadata.sourceBundleId = 'another-source-bundle'; writeFileSync(path, JSON.stringify(metadata)); }
    refreshManifest(f.source, 2, 2);
    const binding = await f.service.preview({ operationRef: 'source-binding', fileToken: 'allowed', mappingVersion: 'medclaw.snapshot/v1' }); expect(binding.ok && binding.data.canCommit).toBe(false); expect(binding.ok && binding.data.issues[0]?.code).toBe('import_conflict'); expect(f.store.revision()).toBe(1); expect(f.db.query('SELECT count(*) n FROM batches').get()).toEqual({ n: 1 });
  } finally { f.db.close(); }
});
test('P3 shutdown waits for active copy cancellation before closing database and rejects new writes', async () => {
  const f = fixture(); try {
    let started!: () => void;
    const copying = new Promise<void>(resolve => { started = resolve; });
    let stopped = false;
    f.artifacts.copy = async (_id, _operationRef, _root, signal) => { started(); await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); }); stopped = true; };
    const preview = f.preview(); await copying;
    await f.service.shutdown(); expect(stopped).toBe(true);
    expect(await preview).toMatchObject({ ok: false, error: { code: 'import_cancelled' } });
    expect(await f.service.read('import-1')).toMatchObject({ ok: true, data: { state: 'cancelled', result: null } });
    expect(await f.service.preview({ operationRef: 'after-shutdown', fileToken: 'allowed', mappingVersion: 'medclaw.snapshot/v1' })).toMatchObject({ ok: false, error: { code: 'host_interrupted' } });
    expect(f.store.read('after-shutdown')).toBeNull(); expect(f.store.revision()).toBe(0);
  } finally { f.db.close(); }
});

test('P3 rejected source directory inventory preserves the import rejection state without business writes', async () => {
  const f = fixture(); try {
    const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'private.csv'), 'outside');
    symlinkSync(outside, join(f.source, 'linked'), 'junction');
    const preview = await f.preview();
    expect(preview).toMatchObject({ ok: true, data: { canCommit: false, issues: [{ code: 'import_invalid' }, { code: 'count_incomplete' }] } });
    expect(await f.service.read('import-1')).toMatchObject({ ok: true, data: { state: 'rejected', result: { status: 'rejected', acceptedRows: 0 } } });
    expect(f.db.query('SELECT status FROM artifacts').get()).toEqual({ status: 'reserved' });
    expect(f.db.query('SELECT count(*) n FROM batches').get()).toEqual({ n: 0 });
    expect(f.store.revision()).toBe(0);
  } finally { f.db.close(); }
});
