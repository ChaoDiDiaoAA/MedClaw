import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, SCHEMA_VERSION } from '../../packages/storage/src/database';

const roots: string[] = [];
const handles: Database[] = [];
const time = '2026-10-01T00:00:00.000Z';
const tables = ['answers', 'artifacts', 'batches', 'business_events', 'catalog_state', 'change_events', 'devices', 'imports', 'model_calls', 'queries', 'query_evidence', 'runs', 'schema_migrations', 'session_inputs', 'sessions', 'snapshots', 'tool_calls', 'workspace'];
const oldTables = ['model_calls', 'runs', 'schema_migrations', 'sessions', 'workspace'];
function file() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p3-migration-'));
  roots.push(root);
  return join(root, 'app.sqlite');
}
function open(path: string) {
  const db = openDatabase(path);
  handles.push(db);
  return db;
}
function close(db: Database) {
  handles.splice(handles.indexOf(db), 1);
  db.close();
}
function oldDatabase(path: string) {
  const db = new Database(path, { create: true });
  handles.push(db);
  for (const [index, name] of ['001_p1.sql', '002_p2.sql'].entries()) {
    const sql = readFileSync(new URL(`../../packages/storage/src/migrations/${name}`, import.meta.url));
    if (index === 1) db.exec('PRAGMA foreign_keys=OFF');
    db.exec(sql.toString());
    db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(index + 1, createHash('sha256').update(sql).digest('hex'), time);
  }
  db.exec('PRAGMA foreign_keys=ON');
  db.query(`INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at)
    VALUES(1,'native-old','create-old','{ "original": true }','{ "unicode": "器械😀" }','Old session',?,?)`).run(time, time);
  db.query('UPDATE workspace SET active_session_id=1,revision=7,updated_at=? WHERE id=1').run(time);
  db.query(`INSERT INTO runs(id,kind,instance_id,status,goal,input_text,output_text,config_json,scope_json,reference_date,timezone,created_at,ended_at)
    VALUES(1,'provider','old-host','completed','answer','原始输入😀','原始输出',?,?,'2026-10-01','Asia/Shanghai',?,?)`)
    .run('{ "providerRequest": { "operationRef": "old-provider" }, "unknown": null }', '{ "batchIds": [] }', time, time);
  db.query(`INSERT INTO runs(id,session_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,
    config_json,scope_json,workspace_json,reference_date,timezone,error_json,created_at,started_at,ended_at,cleanup_json)
    VALUES(2,1,'agent','old-host','old-submit',1,?,'failed','answer','Agent input',?, ?, ?, '2026-10-01','Asia/Shanghai',?, ?, ?, ?, ?)`)
    .run('{ "sessionId": 1, "clientSequence": 1, "text": "原请求😀" }', '{ "agent": { "nativeSessionId": "native-old" } }',
      '{ "batchIds": [] }', '{ "sessionId": 1, "revision": 7 }', '{ "code": "host_interrupted", "message": "原错误" }', time, time, time,
      '{ "stopConfirmed": null, "unconfirmedItems": [ "stop" ] }');
  db.query(`INSERT INTO model_calls(call_id,run_id,session_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,started_at,ended_at,unavailable_reason)
    VALUES('old-call',2,1,'main',1,'logical_request',1,'{ "unknown": null }','failed',?,?,'unknown')`).run(time, time);
  return db;
}
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('formal P2 upgrades to 18 STRICT latest tables and preserves old rows, JSON bytes, NULL and checksums', () => {
  const path = file();
  const old = oldDatabase(path);
  const before = Object.fromEntries(oldTables.map(name => [name, old.query<Record<string, unknown>, []>(`SELECT * FROM ${name} ORDER BY ${name === 'schema_migrations' ? 'version' : 'id'}`).all()]));
  close(old);
  const db = open(path);
  expect(SCHEMA_VERSION).toBe(4);
  expect(db.query<{ name: string; strict: number }, []>("SELECT name,strict FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
    .toEqual(tables.map(name => ({ name, strict: 1 })));
  for (const name of oldTables) {
    const after = db.query<Record<string, unknown>, []>(`SELECT * FROM ${name} ORDER BY ${name === 'schema_migrations' ? 'version' : 'id'}`).all();
    const oldRows = before[name]!;
    expect(after.slice(0, oldRows.length).map(row => Object.fromEntries(Object.keys(oldRows[0] ?? {}).map(key => [key, row[key]])))).toEqual(oldRows);
  }
  expect(db.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
  expect(db.query('SELECT revision FROM catalog_state WHERE id=1').get()).toEqual({ revision: 0 });
  expect(db.query('SELECT material_version,batch_refs_json,device_ids_json,active_query_id,active_view,selection_json FROM workspace').get())
    .toEqual({ material_version: null, batch_refs_json: '[]', device_ids_json: '[]', active_query_id: null, active_view: 'data', selection_json: null });
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  const migratedRows = db.query('SELECT * FROM schema_migrations ORDER BY version').all();
  close(db);
  const reopened = open(path);
  expect(reopened.query('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(migratedRows);
  expect(reopened.query('SELECT * FROM model_calls').all()).toEqual(before.model_calls);
});

test('late 003 fault rolls back every P3 table, workspace change and migration marker to valid P2', () => {
  const path = file();
  const old = oldDatabase(path);
  const before = Object.fromEntries(oldTables.map(name => [name, old.query(`SELECT * FROM ${name}`).all()]));
  close(old);
  expect(() => {
    const db = openDatabase(path, () => { throw new Error('late 003 fault'); });
    handles.push(db);
  }).toThrow('storage_migration_failed');
  const db = new Database(path);
  handles.push(db);
  expect(db.query("SELECT name FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual(oldTables.map(name => ({ name })));
  for (const name of oldTables) expect(db.query(`SELECT * FROM ${name}`).all()).toEqual(before[name]);
  close(db);
  expect(open(path).query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
});

test('reopening rejects P3 schema drift in columns, triggers, indexes, tables and migration checksum', () => {
  for (const mutation of [
    'ALTER TABLE queries ADD COLUMN unexpected TEXT',
    'DROP TRIGGER tool_calls_terminal_immutable',
    'DROP INDEX snapshots_device_batch',
    'CREATE TABLE unexpected(id INTEGER PRIMARY KEY) STRICT',
    "UPDATE schema_migrations SET checksum='changed' WHERE version=3",
  ]) {
    const path = file();
    const db = open(path);
    expect(SCHEMA_VERSION).toBe(4);
    db.exec(mutation);
    close(db);
    expect(() => openDatabase(path)).toThrow('storage_migration_failed');
  }
});
