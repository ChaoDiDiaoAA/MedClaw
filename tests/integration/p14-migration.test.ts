import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';
import { contextAt } from '../fixtures/p8-context';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { memoryNativeFixture } from '../fixtures/p9-memory';

const migrationNames = ['001_p1.sql', '002_p2.sql', '003_p3.sql', '004_p5.sql', '005_p6.sql',
  '006_session_lifecycle.sql', '007_batch_deletion.sql', '008_p8.sql', '009_p9.sql', '010_p10.sql', '011_p11.sql', '012_p13.sql'];

function schema12() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p14-migration-')), path = join(root, 'app.sqlite');
  const db = new Database(path, { strict: true });
  for (const [index, name] of migrationNames.entries()) {
    db.exec('PRAGMA foreign_keys=OFF');
    const sql = readFileSync(new URL(`../../packages/storage/src/migrations/${name}`, import.meta.url));
    db.exec(sql.toString());
    db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)')
      .run(index + 1, createHash('sha256').update(sql).digest('hex'), contextAt);
  }
  db.exec('PRAGMA foreign_keys=ON');
  seedWorkspaceQueries(db);
  db.query(`INSERT INTO model_calls(id,call_id,run_id,session_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,started_at)
    VALUES(21,'legacy-main',10,1,'main',1,'logical_request',1,'{ "context": { "snapshotId": 31 }, "raw": "工程😀" }','started',?)`).run(contextAt);
  db.query(`INSERT INTO context_snapshots(id,run_id,session_id,sequence,snapshot_json,created_at)
    VALUES(31,10,1,1,'{ "contract": "medclaw.context/v1", "raw": "工程😀" }',?)`).run(contextAt);
  db.query('INSERT INTO context_deliveries(model_call_id,snapshot_id,run_id,session_id,delivered_at) VALUES(21,31,10,1,?)').run(contextAt);
  db.query(`INSERT INTO tool_calls(session_id,run_id,native_tool_call_id,model_call_id,context_snapshot_id,tool_name,tool_version,effect,execution_mode,args_json,status,requested_at)
    VALUES(1,10,'legacy-tool',21,31,'read_query','0.87.1','READ','sequential','{}','requested',?)`).run(contextAt);
  const native = memoryNativeFixture();
  db.transaction(() => {
    db.query('UPDATE sessions SET native_session_id=?,native_header_json=?,history_format_version=?,storage_version=2,current_leaf_id=? WHERE id=1')
      .run(native.header.id, JSON.stringify(native.header), 'pi-session/3;pi-sdk/0.87.1', native.activeLeafId);
    for (const [index, entry] of native.entries.entries()) db.query('INSERT INTO memories(session_id,native_entry_id,parent_entry_id,sequence,entry_type,entry_json,run_id,recorded_at) VALUES(1,?,?,?,?,?,10,?)')
      .run(entry.id, entry.parentId, index + 1, entry.type, JSON.stringify(entry), contextAt);
  }).immediate();
  db.transaction(() => {
    db.query(`INSERT INTO session_inputs(id,session_id,client_sequence,operation_ref,mode,status,content_json,created_at,updated_at)
      VALUES(201,1,2,'p14-input','send','queued','{}',?,?)`).run(contextAt, contextAt);
    db.query(`INSERT INTO runs(id,session_id,input_id,kind,instance_id,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at)
      VALUES(11,1,201,'agent','host','running','answer','ENGINEERING intent task','{"agent":{"nativeSessionId":"native-a"}}','{}','{}','2026-10-05','Asia/Shanghai',?)`).run(contextAt);
    db.query('UPDATE session_inputs SET target_run_id=11 WHERE id=201').run();
  }).immediate();
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all().map(row => row.name);
  const rows = tables.map(name => db.query(`SELECT * FROM ${name} ORDER BY id`).all());
  const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return { root, path, tables, rows, schema, input: { runId: 11, sessionId: 1, inputId: 201 } };
}

test('p14 schema12 upgrade preserves every old field, native/Query/tool/Context reference and P13 constraint', () => {
  const f = schema12();
  let db = openDatabase(f.path);
  try {
    expect(db.query('SELECT version FROM schema_migrations').all()).toHaveLength(13);
    for (const [index, table] of f.tables.entries()) expect(db.query(`SELECT * FROM ${table} ORDER BY id`).all()).toEqual(f.rows[index]);
    for (const table of ['intent_calls', 'route_decisions', 'query_contexts']) expect(db.query('SELECT name FROM sqlite_schema WHERE type=\'table\' AND name=?').get(table)).not.toBeNull();
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.query("SELECT name FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' AND strict<>1").all()).toEqual([]);
    expect(() => db.query('UPDATE model_calls SET session_id=NULL WHERE id=21').run()).toThrow('model_call_owner_mismatch');
    expect(() => db.query(`INSERT INTO model_calls(call_id,session_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,started_at)
      VALUES('invalid-compaction',1,'compaction',1,'logical_request',1,'{}','started',?)`).run(contextAt)).toThrow();
    expect(db.query("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE '%child%'").all().length).toBeGreaterThan(0);
    db.close(); db = openDatabase(f.path);
    expect(db.query('SELECT version FROM schema_migrations').all()).toHaveLength(13);
  } finally { db.close(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const phase of ['p14_copy', 'p14_rename', 'p14_marker']) test(`p14 ${phase} fault rolls back migration and all original rows`, () => {
  const f = schema12();
  let reached = false;
  try {
    expect(() => { const db = openDatabase(f.path, step => { if (step === phase) { reached = true; throw new Error('ENGINEERING migration fault'); } }); db.close(); }).toThrow('storage_migration_failed');
    expect(reached).toBe(true);
    const db = new Database(f.path, { strict: true });
    try {
      expect(db.query('SELECT version FROM schema_migrations').all()).toHaveLength(12);
      for (const [index, table] of f.tables.entries()) expect(db.query(`SELECT * FROM ${table} ORDER BY id`).all()).toEqual(f.rows[index]);
      expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).toEqual(f.schema);
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('p14 SQLite admits 0/1/2 intent calls but refuses duplicate stages, incorrect predecessors and root identities', () => {
  const f = schema12(), db = openDatabase(f.path), owner = f.input;
  try {
    const snapshot = JSON.stringify({ contract: 'medclaw.context/v1', intentSource: { contract: 'medclaw.intent-context/v1', inputId: owner.inputId,
      baseLeafId: db.query<{ current_leaf_id: string }, []>('SELECT current_leaf_id FROM sessions WHERE id=1').get()!.current_leaf_id, baseStorageVersion: 2 } });
    const snapshotId = Number(db.query(`INSERT INTO context_snapshots(run_id,session_id,input_id,sequence,snapshot_json,created_at) VALUES(?,?,?,1,?,?)`)
      .run(owner.runId, owner.sessionId, owner.inputId, snapshot, contextAt).lastInsertRowid);
    const model = JSON.stringify({ selection: { api: 'ollama-chat' }, responseModel: null, sdkStopReason: null, context: { snapshotId, inputId: owner.inputId } });
    const modelCall = (id: string, inputId = owner.inputId, runId = owner.runId, sessionId = owner.sessionId) => Number(db.query(`INSERT INTO model_calls(call_id,run_id,session_id,input_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,started_at)
      VALUES(?,?,?,?,'intent',1,'logical_request',0,?,'started',?)`).run(id, runId, sessionId, inputId, model, contextAt).lastInsertRowid);
    const intentCall = (id: number, stage: string, previous: number | null) => Number(db.query(`INSERT INTO intent_calls(model_call_id,run_id,session_id,input_id,snapshot_id,stage,previous_call_id,taxonomy_version,rule_version,prompt_version,schema_version,input_projection_json,validation_state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'taxonomy','rules','prompt','medclaw.intent/v2','{}','pending',?,?)`).run(id, owner.runId, owner.sessionId, owner.inputId, snapshotId, stage, previous, contextAt, contextAt).lastInsertRowid);
    expect(db.query('SELECT * FROM intent_calls').all()).toEqual([]);
    const classifyModel = modelCall('classify'), classify = intentCall(classifyModel, 'classify', null);
    const verifyModel = modelCall('verify');
    expect(() => intentCall(verifyModel, 'classify', null)).toThrow();
    expect(() => intentCall(verifyModel, 'verify', 999)).toThrow('intent_verify_previous_mismatch');
    expect(() => modelCall('wrong-input', owner.inputId + 999)).toThrow();
    expect(() => modelCall('wrong-root', owner.inputId, 10)).toThrow();
    expect(() => modelCall('wrong-session', owner.inputId, owner.runId, owner.sessionId + 999)).toThrow();
    const verify = intentCall(verifyModel, 'verify', classify);
    expect(db.query('SELECT stage FROM intent_calls ORDER BY id').all()).toEqual([{ stage: 'classify' }, { stage: 'verify' }]);
    expect(() => db.query('UPDATE intent_calls SET previous_call_id=? WHERE id=?').run(verify, verify)).toThrow();
    expect(() => db.query("UPDATE intent_calls SET stage='classify',previous_call_id=NULL WHERE id=?").run(verify)).toThrow();
    expect(() => db.query("UPDATE model_calls SET input_id=NULL WHERE id=?").run(verifyModel)).toThrow();
    expect(() => db.query("UPDATE model_calls SET kind='main' WHERE id=?").run(verifyModel)).toThrow();
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); rmSync(f.root, { recursive: true, force: true }); }
});
