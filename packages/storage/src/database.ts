import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const SCHEMA_VERSION = 5;
const migrations = ["001_p1.sql", "002_p2.sql", "003_p3.sql", "004_p5.sql", "005_p6.sql"].map(name => {
  const sql = readFileSync(new URL(`./migrations/${name}`, import.meta.url));
  return { sql: sql.toString("utf8"), checksum: createHash("sha256").update(sql).digest("hex") };
});
const runColumns = "id,session_id,input_id,kind,prior_run_id,instance_id,status,goal,input_text,output_text,config_json,scope_json,workspace_json,reference_date,timezone,error_json,created_at,started_at,cancel_requested_at,stopped_at,ended_at,cleanup_json,usage_json";
const schemaQuery = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
const expectedSchemas = (() => {
  const reference = new Database(":memory:", { strict: true });
  try {
    return migrations.map((migration, index) => {
      if(index===1||index===3){
        reference.exec("PRAGMA foreign_keys=OFF");
        if(reference.query<{foreign_keys:number},[]>("PRAGMA foreign_keys").get()?.foreign_keys!==0)throw new Error("storage_migration_failed");
        try{reference.transaction(()=>reference.exec(migration.sql)).immediate();}
        finally{reference.exec("PRAGMA foreign_keys=ON");if(reference.query<{foreign_keys:number},[]>("PRAGMA foreign_keys").get()?.foreign_keys!==1)throw new Error("storage_migration_failed");}
      }else reference.exec(migration.sql);
      return reference.query(schemaQuery).all();
    });
  } finally {
    reference.close();
  }
})();
function validate(db: Database, version: number) {
  const tables = db.query<{ name: string; strict: number }, []>("SELECT name,strict FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  if (!isDeepStrictEqual(db.query(schemaQuery).all(), expectedSchemas[version - 1]) || tables.some(row => row.strict !== 1)
    || db.query("PRAGMA foreign_key_check").all().length
    || db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("storage_migration_failed");
  if (version >= 2 && db.query("SELECT c.id FROM model_calls c JOIN runs r ON r.id=c.run_id WHERE c.session_id IS NOT r.session_id").all().length) throw new Error("storage_migration_failed");
}

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
      if (rows.length < 1 || rows.length > SCHEMA_VERSION || rows.some((row, index) => row.version !== index + 1 || row.checksum !== migrations[index]?.checksum)) throw new Error("storage_migration_failed");
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
    validate(db, SCHEMA_VERSION);
    return db;
  } catch {
    db.close();
    throw new Error("storage_migration_failed");
  }
}
