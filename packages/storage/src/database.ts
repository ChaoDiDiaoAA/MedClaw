import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SCHEMA_VERSION, SCHEMA17_MIGRATION_MARKER, migrationSql, validateDatabaseSchema as validate } from './schema-validation';
export { SCHEMA_VERSION } from './schema-validation';

const migrations = migrationSql.map((sql, index) => {
  if (index === 16) return { sql: sql.toString('utf8'), checksum: SCHEMA17_MIGRATION_MARKER, checksums: [SCHEMA17_MIGRATION_MARKER] };
  // Git checkout newline conversion changes byte hashes without changing SQL.
  // Accept only these two forms of the current content; retain stored identities.
  const lf = sql.toString("utf8").replaceAll("\r\n", "\n");
  const checksums = [lf, lf.replaceAll("\n", "\r\n")].map(text => createHash("sha256").update(text).digest("hex"));
  return { sql: sql.toString("utf8"), checksum: createHash("sha256").update(sql).digest("hex"), checksums };
});
const runColumns = "id,session_id,input_id,kind,prior_run_id,instance_id,status,goal,input_text,output_text,config_json,scope_json,workspace_json,reference_date,timezone,error_json,created_at,started_at,cancel_requested_at,stopped_at,ended_at,cleanup_json,usage_json";

// The Host verifies its root and exclusive process identity before calling this.
export function openDatabase(path: string, beforeMigrationCommit?: (phase?: string) => void): Database {
  if (!isAbsolute(path)) throw new Error("storage_migration_failed");
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;");
    const exists = db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get();
    let version = 0;
    if (exists) {
      const rows = db.query<{ version: number; checksum: string }, []>("SELECT version,checksum FROM schema_migrations ORDER BY version").all();
      if (rows.length < 1 || rows.length > SCHEMA_VERSION || rows.some((row, index) => row.version !== index + 1 || !migrations[index]?.checksums.includes(row.checksum))) throw new Error("storage_migration_failed");
      version = rows.length;
      validate(db, version);
    } else {
      if (db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw new Error("storage_migration_failed");
      db.transaction(() => {
        db.exec(migrations[0]!.sql);
        db.query("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(1,?,?)").run(migrations[0]!.checksum, new Date().toISOString());
        validate(db, 1);
      }).immediate();
      version = 1;
    }
    if (version === 1) {
      const oldRuns = db.query(`SELECT ${runColumns} FROM runs ORDER BY id`).all();
      const oldCalls = db.query("SELECT * FROM model_calls ORDER BY id").all();
      try {
        db.exec("PRAGMA foreign_keys=OFF");
        if (db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys !== 0) throw new Error("storage_migration_failed");
        db.transaction(() => {
          db.exec(migrations[1]!.sql);
          if (!isDeepStrictEqual(oldRuns, db.query(`SELECT ${runColumns} FROM runs ORDER BY id`).all())
            || !isDeepStrictEqual(oldCalls, db.query("SELECT * FROM model_calls ORDER BY id").all())) throw new Error("storage_migration_failed");
          validate(db, 2);
          beforeMigrationCommit?.();
          db.query("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(2,?,?)").run(migrations[1]!.checksum, new Date().toISOString());
        }).immediate();
      } finally {
        db.exec("PRAGMA foreign_keys=ON");
        if (db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys !== 1) throw new Error("storage_migration_failed");
      }
      version = 2;
    }
    if (version === 2) {
      const oldTables = ["runs", "model_calls", "sessions", "workspace"];
      const oldRows = oldTables.map(name => db.query<Record<string, unknown>, []>(`SELECT * FROM ${name} ORDER BY id`).all());
      db.transaction(() => {
        db.exec(migrations[2]!.sql);
        for (const [index, name] of oldTables.entries()) {
          const before = oldRows[index]!;
          const after = db.query<Record<string, unknown>, []>(`SELECT * FROM ${name} ORDER BY id`).all();
          const projected = name === "workspace" ? after.map(row => Object.fromEntries(Object.keys(before[0]!).map(key => [key, row[key]]))) : after;
          if (!isDeepStrictEqual(before, projected)) throw new Error("storage_migration_failed");
        }
        validate(db, 3);
        beforeMigrationCommit?.();
        db.query("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(3,?,?)").run(migrations[2]!.checksum, new Date().toISOString());
      }).immediate();
    }
    if (version <= 3) {
      const names = db.query<{name:string},[]>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all().map(row=>row.name);
      const oldRows = names.map(name=>db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all());
      try {
        db.exec("PRAGMA foreign_keys=OFF");
        if(db.query<{foreign_keys:number},[]>("PRAGMA foreign_keys").get()?.foreign_keys!==0) throw new Error("storage_migration_failed");
        db.transaction(()=> {
          const sql = migrations[3]!.sql;
          const copyEnd = sql.indexOf('DROP TRIGGER model_calls_owner_insert');
          const renameEnd = sql.indexOf('CREATE UNIQUE INDEX runs_one_root');
          db.exec(sql.slice(0,copyEnd)); beforeMigrationCommit?.('p5_copy');
          db.exec(sql.slice(copyEnd,renameEnd)); beforeMigrationCommit?.('p5_rename');
          db.exec(sql.slice(renameEnd));
          for(const [i,name] of names.entries()) if(!isDeepStrictEqual(oldRows[i],db.query(`SELECT * FROM ${name} ORDER BY id`).all())) throw new Error("storage_migration_failed");
          validate(db,4); beforeMigrationCommit?.("p5_marker");
          db.query("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(4,?,?)").run(migrations[3]!.checksum,new Date().toISOString());
        }).immediate();
      } finally {
        db.exec("PRAGMA foreign_keys=ON");
        if(db.query<{foreign_keys:number},[]>("PRAGMA foreign_keys").get()?.foreign_keys!==1) throw new Error("storage_migration_failed");
      }
    }
    if (version <= 4) {
      db.transaction(() => {
        db.exec(migrations[4]!.sql);
        validate(db, 5);
        beforeMigrationCommit?.("p6_marker");
        db.query("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(5,?,?)").run(migrations[4]!.checksum, new Date().toISOString());
      }).immediate();
    }
    if (version <= 5) {
      const names = db.query<{name:string},[]>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all().map(row=>row.name);
      const before = names.map(name=>db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all());
      try {
        db.exec('PRAGMA foreign_keys=OFF');
        if(db.query<{foreign_keys:number},[]>('PRAGMA foreign_keys').get()?.foreign_keys!==0)throw new Error('storage_migration_failed');
        db.transaction(()=>{
          const sql=migrations[5]!.sql, boundary=sql.indexOf('DROP TABLE sessions;');
          db.exec(sql.slice(0,boundary)); beforeMigrationCommit?.('lifecycle_copy');
          db.exec(sql.slice(boundary)); beforeMigrationCommit?.('lifecycle_rename');
          for(const [i,name] of names.entries()) {
            const rows=db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all();
            if(name==='sessions') {
              if(rows.length!==before[i]!.length)throw new Error('storage_migration_failed');
              for(const [n,row] of rows.entries()) {
                const old=before[i]![n]!;
                for(const key of Object.keys(old))if(key!=='metadata_json'&&!isDeepStrictEqual(old[key],row[key]))throw new Error('storage_migration_failed');
                const metadata=JSON.parse(String(old.metadata_json)), next=JSON.parse(String(row.metadata_json));
                for(const key of Object.keys(metadata))if(key!=='titleOrigin'&&!isDeepStrictEqual(metadata[key],next[key]))throw new Error('storage_migration_failed');
                if(!['default','user'].includes(next.titleOrigin)||row.metadata_revision!==0||row.deleted_at!==null)throw new Error('storage_migration_failed');
              }
            }else if(!isDeepStrictEqual(before[i],rows))throw new Error('storage_migration_failed');
          }
          validate(db,6); beforeMigrationCommit?.('lifecycle_marker');
          db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(6,?,?)').run(migrations[5]!.checksum,new Date().toISOString());
        }).immediate();
      } finally {
        db.exec('PRAGMA foreign_keys=ON');
        if(db.query<{foreign_keys:number},[]>('PRAGMA foreign_keys').get()?.foreign_keys!==1)throw new Error('storage_migration_failed');
      }
    }
    if (version <= 6) {
      const names=['batches','devices','snapshots','change_events'];
      const before=names.map(name=>db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all());
      try {
        db.exec('PRAGMA foreign_keys=OFF');
        db.transaction(()=>{
          db.exec(migrations[6]!.sql); beforeMigrationCommit?.('batch_deletion_copy');
          for(const [i,name]of names.entries()){
            const rows=db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all();
            if(rows.length!==before[i]!.length)throw new Error('storage_migration_failed');
            for(const [n,row]of rows.entries())for(const key of Object.keys(before[i]![n]!))
              if(!isDeepStrictEqual(row[key],before[i]![n]![key]))throw new Error('storage_migration_failed');
          }
          validate(db,7);beforeMigrationCommit?.('batch_deletion_marker');
          db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(7,?,?)').run(migrations[6]!.checksum,new Date().toISOString());
        }).immediate();
      }finally{
        db.exec('PRAGMA foreign_keys=ON');
        if(db.query<{foreign_keys:number},[]>('PRAGMA foreign_keys').get()?.foreign_keys!==1)throw new Error('storage_migration_failed');
      }
    }
    if (version <= 7) {
      const names = db.query<{name:string},[]>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all().map(row => row.name);
      const before = names.map(name => db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all());
      db.transaction(() => {
        db.exec(migrations[7]!.sql);
        for (const [i,name] of names.entries()) {
          const after = db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all();
          const projected = name === 'tool_calls' ? after.map(({ context_snapshot_id, ...row }) => { if (context_snapshot_id !== null) throw new Error('storage_migration_failed'); return row; }) : after;
          if (!isDeepStrictEqual(before[i], projected)) throw new Error('storage_migration_failed');
        }
        validate(db, 8); beforeMigrationCommit?.('p8_context_marker');
        db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(8,?,?)').run(migrations[7]!.checksum,new Date().toISOString());
      }).immediate();
    }
    if (version <= 8) {
      const names = db.query<{name:string},[]>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all().map(row => row.name);
      const before = names.map(name => db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all());
      try {
        db.exec('PRAGMA foreign_keys=OFF');
        if(db.query<{foreign_keys:number},[]>('PRAGMA foreign_keys').get()?.foreign_keys!==0) throw new Error('storage_migration_failed');
        db.transaction(() => {
          db.exec(migrations[8]!.sql);
          for (const [i,name] of names.entries()) {
            const rows = db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all();
            if (rows.length !== before[i]!.length) throw new Error('storage_migration_failed');
            const projected = rows.map((row,n) => Object.fromEntries(Object.keys(before[i]![n]!).map(key => [key,row[key]])));
            if (!isDeepStrictEqual(before[i],projected)) throw new Error('storage_migration_failed');
          }
          validate(db,9); beforeMigrationCommit?.('p9_memory_marker');
          db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(9,?,?)').run(migrations[8]!.checksum,new Date().toISOString());
        }).immediate();
      } finally {
        db.exec('PRAGMA foreign_keys=ON');
        if(db.query<{foreign_keys:number},[]>('PRAGMA foreign_keys').get()?.foreign_keys!==1) throw new Error('storage_migration_failed');
      }
    }
    if (version <= 9) {
      const names = db.query<{name:string},[]>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all().map(row => row.name);
      const before = names.map(name => db.query(`SELECT * FROM ${name} ORDER BY id`).all());
      try {
        db.exec('PRAGMA foreign_keys=OFF');
        if (db.query<{foreign_keys:number},[]>('PRAGMA foreign_keys').get()?.foreign_keys !== 0) throw new Error('storage_migration_failed');
        db.transaction(() => {
          const sql = migrations[9]!.sql, copyEnd = sql.indexOf('DROP TABLE model_calls;'), renameEnd = sql.indexOf('CREATE INDEX model_calls_run');
          db.exec(sql.slice(0,copyEnd)); beforeMigrationCommit?.('p10_copy');
          db.exec(sql.slice(copyEnd,renameEnd)); beforeMigrationCommit?.('p10_rename');
          db.exec(sql.slice(renameEnd));
          for (const [i,name] of names.entries()) if (!isDeepStrictEqual(before[i],db.query(`SELECT * FROM ${name} ORDER BY id`).all())) throw new Error('storage_migration_failed');
          validate(db,10); beforeMigrationCommit?.('p10_marker');
          db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(10,?,?)').run(migrations[9]!.checksum,new Date().toISOString());
        }).immediate();
      } finally {
        db.exec('PRAGMA foreign_keys=ON');
        if (db.query<{foreign_keys:number},[]>('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('storage_migration_failed');
      }
    }
    if (version <= 10) {
      db.transaction(() => {
        db.exec(migrations[10]!.sql);
        validate(db, 11); beforeMigrationCommit?.('p11_receipt_marker');
        db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(11,?,?)').run(migrations[10]!.checksum, new Date().toISOString());
      }).immediate();
    }
    if (version <= 11) {
      const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all().map(row => row.name);
      const before = names.map(name => db.query<Record<string, unknown>, []>(`SELECT * FROM ${name} ORDER BY id`).all());
      try {
        db.exec('PRAGMA foreign_keys=OFF');
        if (db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys !== 0) throw new Error('storage_migration_failed');
        db.transaction(() => {
          const sql = migrations[11]!.sql, copyEnd = sql.indexOf('DROP TRIGGER'), renameEnd = sql.indexOf('CREATE INDEX sessions_user_status_id');
          db.exec(sql.slice(0, copyEnd)); beforeMigrationCommit?.('p13_copy');
          db.exec(sql.slice(copyEnd, renameEnd)); beforeMigrationCommit?.('p13_rename');
          db.exec(sql.slice(renameEnd));
          for (const [i, name] of names.entries()) {
            const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM ${name} ORDER BY id`).all();
            if (rows.length !== before[i]!.length || !isDeepStrictEqual(before[i], rows.map((row, n) => Object.fromEntries(Object.keys(before[i]![n]!).map(key => [key, row[key]]))))) throw new Error('storage_migration_failed');
          }
          validate(db, 12); beforeMigrationCommit?.('p13_marker');
          db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(12,?,?)').run(migrations[11]!.checksum, new Date().toISOString());
        }).immediate();
      } finally {
        db.exec('PRAGMA foreign_keys=ON');
        if (db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('storage_migration_failed');
      }
    }
    if (version <= 12) {
      const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all().map(row => row.name);
      const before = names.map(name => db.query(`SELECT * FROM ${name} ORDER BY id`).all());
      try {
        db.exec('PRAGMA foreign_keys=OFF');
        if (db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys !== 0) throw new Error('storage_migration_failed');
        db.transaction(() => {
          const sql = migrations[12]!.sql, copyEnd = sql.indexOf('DROP TABLE model_calls;'), renameEnd = sql.indexOf('CREATE INDEX model_calls_run');
          db.exec(sql.slice(0, copyEnd)); beforeMigrationCommit?.('p14_copy');
          db.exec(sql.slice(copyEnd, renameEnd)); beforeMigrationCommit?.('p14_rename');
          db.exec(sql.slice(renameEnd));
          for (const [index, name] of names.entries()) if (!isDeepStrictEqual(before[index], db.query(`SELECT * FROM ${name} ORDER BY id`).all())) throw new Error('storage_migration_failed');
          validate(db, 13); beforeMigrationCommit?.('p14_marker');
          db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(13,?,?)').run(migrations[12]!.checksum, new Date().toISOString());
        }).immediate();
      } finally {
        db.exec('PRAGMA foreign_keys=ON');
        if (db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('storage_migration_failed');
      }
    }
    if (version <= 13) {
      const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all().map(row => row.name);
      const before = names.map(name => db.query<Record<string, unknown>, []>(`SELECT * FROM ${name} ORDER BY id`).all());
      try {
        db.exec('PRAGMA foreign_keys=OFF');
        if (db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys !== 0) throw new Error('storage_migration_failed');
        db.transaction(() => {
          const sql = migrations[13]!.sql, copyEnd = sql.indexOf('DROP TABLE artifacts;'), renameEnd = sql.indexOf('CREATE TRIGGER exports_identity_immutable');
          db.exec(sql.slice(0, copyEnd)); beforeMigrationCommit?.('p15_copy');
          db.exec(sql.slice(copyEnd, renameEnd)); beforeMigrationCommit?.('p15_rename');
          db.exec(sql.slice(renameEnd));
          for (const [index, name] of names.entries()) {
            const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM ${name} ORDER BY id`).all();
            if (rows.length !== before[index]!.length || !isDeepStrictEqual(before[index], rows.map((row, n) => Object.fromEntries(Object.keys(before[index]![n]!).map(key => [key, row[key]]))))) throw new Error('storage_migration_failed');
          }
          validate(db, 14); beforeMigrationCommit?.('p15_marker');
          db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(14,?,?)').run(migrations[13]!.checksum, new Date().toISOString());
        }).immediate();
      } finally {
        db.exec('PRAGMA foreign_keys=ON');
        if (db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('storage_migration_failed');
      }
    }
    if (version <= 14) {
      const rows = db.query<Record<string, unknown>, []>('SELECT * FROM route_decisions ORDER BY id').all();
      try {
        db.exec('PRAGMA foreign_keys=OFF');
        if (db.query<{foreign_keys:number},[]>('PRAGMA foreign_keys').get()?.foreign_keys !== 0) throw new Error('storage_migration_failed');
        db.transaction(() => {
          const sql = migrations[14]!.sql, copyEnd = sql.indexOf('DROP TRIGGER'), renameEnd = sql.indexOf('CREATE INDEX');
          db.exec(sql.slice(0,copyEnd)); beforeMigrationCommit?.('p15_plan_copy');
          db.exec(sql.slice(copyEnd,renameEnd)); beforeMigrationCommit?.('p15_plan_rename');
          db.exec(sql.slice(renameEnd));
          const actual = db.query<Record<string,unknown>,[]>('SELECT * FROM route_decisions ORDER BY id').all();
          if (!isDeepStrictEqual(rows, actual.map((row,i)=>Object.fromEntries(Object.keys(rows[i]!).map(key=>[key,row[key]]))))) throw new Error('storage_migration_failed');
          validate(db,15); beforeMigrationCommit?.('p15_plan_marker');
          db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(15,?,?)').run(migrations[14]!.checksum,new Date().toISOString());
        }).immediate();
      } finally { db.exec('PRAGMA foreign_keys=ON'); if(db.query<{foreign_keys:number},[]>('PRAGMA foreign_keys').get()?.foreign_keys!==1)throw new Error('storage_migration_failed'); }
    }
    if (version <= 15) {
      const removed: Record<string, string[]> = {
        imports: ['preview_request_hash','commit_request_hash','fingerprint'],
        batches: ['source_lock_hash','content_hash','cohort_hash'], queries: ['params_hash','result_hash'],
        query_evidence: ['source_lock_hash','result_hash'], query_contexts: ['scope_batch_hashes_json'],
        artifacts: ['sha256','metadata_sha256'], exports: ['request_hash','published_hash'],
      };
      const names = db.query<{name:string},[]>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all().map(row => row.name);
      const before = names.map(name => db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all()
        .map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !removed[name]?.includes(key)))));
      try {
        db.exec('PRAGMA foreign_keys=OFF');
        if(db.query<{foreign_keys:number},[]>('PRAGMA foreign_keys').get()?.foreign_keys !== 0) throw new Error('storage_migration_failed');
        db.transaction(() => {
          db.exec(migrations[15]!.sql);
          for(const [index,name] of names.entries()) {
            const rows = db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all();
            const projected = name === 'exports' ? rows.map(({request_json,...row}) => {if(request_json !== null) throw new Error('storage_migration_failed'); return row;}) : rows;
            if(!isDeepStrictEqual(before[index],projected)) throw new Error('storage_migration_failed');
          }
          validate(db,16); beforeMigrationCommit?.('business_identity_marker');
          db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(16,?,?)').run(migrations[15]!.checksum,new Date().toISOString());
        }).immediate();
      } finally { db.exec('PRAGMA foreign_keys=ON'); if(db.query<{foreign_keys:number},[]>('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('storage_migration_failed'); }
    }
    if (version <= 16) {
      db.transaction(() => {
        db.exec(migrations[16]!.sql);
        validate(db, 17); beforeMigrationCommit?.('p13_parallel_marker');
        db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(17,?,?)').run(migrations[16]!.checksum, new Date().toISOString());
      }).immediate();
    }
    validate(db, SCHEMA_VERSION);
    return db;
  } catch {
    db.close();
    throw new Error("storage_migration_failed");
  }
}
