import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const SCHEMA_VERSION = 2;
const migrations = ["001_p1.sql", "002_p2.sql"].map(name => {
  const sql = readFileSync(new URL(`./migrations/${name}`, import.meta.url));
  return { sql: sql.toString("utf8"), checksum: createHash("sha256").update(sql).digest("hex") };
});
const runColumns = "id,session_id,input_id,kind,prior_run_id,instance_id,status,goal,input_text,output_text,config_json,scope_json,workspace_json,reference_date,timezone,error_json,created_at,started_at,cancel_requested_at,stopped_at,ended_at,cleanup_json,usage_json";
function validate(db: Database, version: number) {
  const tables = db.query<{ name: string; strict: number }, []>("SELECT name,strict FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const expected = version === 1 ? "model_calls,runs,schema_migrations" : "model_calls,runs,schema_migrations,sessions,workspace";
  if (tables.map(row => row.name).join(",") !== expected || tables.some(row => row.strict !== 1)
    || db.query("PRAGMA foreign_key_check").all().length
    || db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("storage_migration_failed");
  const indexes = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  if (indexes.map(row => row.name).join(",") !== (version === 1 ? "model_calls_run,runs_one_root,runs_provider_operation_ref" : "model_calls_run,runs_one_root,runs_provider_operation_ref,runs_session_recent")) throw new Error("storage_migration_failed");
  const triggers = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
  if (triggers.map(row => row.name).join(",") !== (version === 1 ? "" : "model_calls_owner_insert,model_calls_owner_update")) throw new Error("storage_migration_failed");
  if (version === 2 && db.query("SELECT c.id FROM model_calls c JOIN runs r ON r.id=c.run_id WHERE c.session_id IS NOT r.session_id").all().length) throw new Error("storage_migration_failed");
}

// The Host verifies its root and exclusive process identity before calling this.
export function openDatabase(path: string, beforeMigrationCommit?: () => void): Database {
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
    }
    validate(db, SCHEMA_VERSION);
    return db;
  } catch {
    db.close();
    throw new Error("storage_migration_failed");
  }
}
