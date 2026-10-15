import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';

const removed: Record<string, string[]> = {
  imports: ['preview_request_hash', 'commit_request_hash', 'fingerprint'],
  batches: ['source_lock_hash', 'content_hash', 'cohort_hash'],
  queries: ['params_hash', 'result_hash'], query_evidence: ['source_lock_hash', 'result_hash'],
  query_contexts: ['scope_batch_hashes_json'], artifacts: ['sha256', 'metadata_sha256'], exports: ['request_hash', 'published_hash'],
};

function legacyDatabase(path: string, markers: { version: number; checksum: string; applied_at: string }[]) {
  const db = new Database(path, { create: true, strict: true });
  try {
  const directory = new URL('../../packages/storage/src/migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^0(?:0[1-9]|1[0-5])_.*\.sql$/.test(name)).sort()) {
    db.exec('PRAGMA foreign_keys=OFF');
    db.transaction(() => db.exec(readFileSync(new URL(name, directory), 'utf8'))).immediate();
  }
  for (const row of markers.filter(row => row.version <= 15)) db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(row.version, row.checksum, row.applied_at);
  db.query(`INSERT INTO imports(id,operation_ref,instance_id,state,preview_request_hash,preview_request_json,created_at,updated_at)
    VALUES(3,'legacy:import','old-host','ready','archived-value',?,'2026-10-01','2026-10-01')`).run('{"operationRef":"legacy:import","fileToken":"original","mappingVersion":"medclaw.snapshot/v1"}');
  db.exec(`INSERT INTO artifacts(id,operation_ref,kind,import_id,format,mime_type,metadata_json,status)
    VALUES(4,'legacy:artifact','import',3,'csv','application/x-directory','{"source":"original content"}','reserved');`);
  db.query(`INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,
    source_lock_hash,content_hash,cohort_hash,coverage,expected_entity_count,observed_entity_count,declared_missing_json,
    metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at)
    VALUES(5,3,'region:source','2026-10-01','浙江','original/v1','source/v1','archived-lock','archived-content','archived-cohort',
    'full',0,0,'[]',?,1,NULL,1,'2026-10-01')`).run('{"original":"kept verbatim","nested":{"hash":"user text"}}');
  } finally { db.close(); }
}

test('schema16 removes business columns while preserving old records, JSON and migration identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-business-migration-'));
  try {
    const fresh = openDatabase(join(root, 'fresh.sqlite'));
    const markers = fresh.query<{version:number;checksum:string;applied_at:string}, []>('SELECT * FROM schema_migrations ORDER BY version').all();
    fresh.close();
    expect(markers.at(-1)?.version).toBe(16);
    const path = join(root, 'legacy.sqlite');
    legacyDatabase(path, markers);
    const db = openDatabase(path);
    try {
      for (const [table, columns] of Object.entries(removed)) {
        const actual = db.query<{name:string}, []>(`PRAGMA table_info(${table})`).all().map(column => column.name);
        expect(columns.filter(column => actual.includes(column))).toEqual([]);
      }
      expect(db.query('SELECT id,operation_ref FROM imports').all()).toEqual([{id:3,operation_ref:'legacy:import'}]);
      expect(db.query<{metadata_json:string;import_id:number}, []>('SELECT metadata_json,import_id FROM batches WHERE id=5').get())
        .toEqual({metadata_json:'{"original":"kept verbatim","nested":{"hash":"user text"}}',import_id:3});
      expect(db.query('SELECT * FROM schema_migrations WHERE version<=15 ORDER BY version').all()).toEqual(markers.filter(row => row.version <= 15));
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
    } finally { db.close(); }
  } finally {
    if(dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unexpected temporary root');
    rmSync(root, {recursive:true,force:true,maxRetries:4,retryDelay:25});
  }
});

test('failed identity migration leaves the old schema and records available for a later retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-business-rollback-'));
  try {
    const fresh = openDatabase(join(root, 'fresh.sqlite'));
    const markers = fresh.query<{version:number;checksum:string;applied_at:string}, []>('SELECT * FROM schema_migrations ORDER BY version').all();
    fresh.close();
    const path = join(root, 'legacy.sqlite'); legacyDatabase(path, markers);
    let attempt: Database | undefined;
    try {
      expect(() => { attempt = openDatabase(path, phase => { if(phase === 'business_identity_marker') throw new Error('injected'); }); }).toThrow();
    } finally { attempt?.close(); }
    const old = new Database(path);
    expect(old.query('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({version:15});
    expect(old.query('SELECT content_hash FROM batches WHERE id=5').get()).toEqual({content_hash:'archived-content'});
    old.close();
    const restored = openDatabase(path); expect(restored.query('PRAGMA foreign_key_check').all()).toEqual([]); restored.close();
  } finally {
    if(dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unexpected temporary root');
    rmSync(root, {recursive:true,force:true,maxRetries:4,retryDelay:25});
  }
});
