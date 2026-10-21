import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export const SCHEMA_VERSION = 17;
export const SCHEMA17_MIGRATION_MARKER = 'medclaw.schema/17';
export const migrationSql = ['001_p1.sql', '002_p2.sql', '003_p3.sql', '004_p5.sql', '005_p6.sql', '006_session_lifecycle.sql', '007_batch_deletion.sql', '008_p8.sql', '009_p9.sql', '010_p10.sql', '011_p11.sql', '012_p13.sql', '013_p14.sql', '014_p15.sql', '015_p15_query_plan.sql', '016_business_identity.sql', '017_subagent_parallel.sql']
  .map(name => readFileSync(new URL(`./migrations/${name}`, import.meta.url)));
if (migrationSql[16]!.toString('utf8').trim() !== 'DROP INDEX runs_one_child;') throw new Error('storage_migration_failed');
const schemaRows = (db: Database) => db.query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
  .map(row => ({ ...row, sql: row.sql?.replaceAll('\r\n', '\n') ?? null }));
const expectedSchemas = (() => {
  const reference = new Database(':memory:', { strict: true });
  try {
    return migrationSql.map((sql, index) => {
      if ([1, 3, 5, 6, 8, 9, 11, 12, 13, 14, 15].includes(index)) {
        reference.exec('PRAGMA foreign_keys=OFF');
        if (reference.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys !== 0) throw new Error('storage_migration_failed');
        try { reference.transaction(() => reference.exec(sql.toString('utf8'))).immediate(); }
        finally {
          reference.exec('PRAGMA foreign_keys=ON');
          if (reference.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('storage_migration_failed');
        }
      } else reference.exec(sql.toString('utf8'));
      return schemaRows(reference);
    });
  } finally { reference.close(); }
})();
export function validateDatabaseSchema(db: Database, version: number): void {
  const tables = db.query<{ name: string; strict: number }, []>("SELECT name,strict FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION
    || !isDeepStrictEqual(schemaRows(db), expectedSchemas[version - 1]) || tables.some(row => row.strict !== 1)
    || db.query('PRAGMA foreign_key_check').all().length
    || db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('storage_migration_failed');
  if (version >= 2 && db.query('SELECT c.id FROM model_calls c JOIN runs r ON r.id=c.run_id WHERE c.session_id IS NOT r.session_id').all().length) throw new Error('storage_migration_failed');
}
/** Validate an existing snapshot without creating a database or applying migrations. */
export function validateDatabaseSnapshot(db: Database, expectedVersion: number): void {
  validateDatabaseSchema(db, expectedVersion);
  const versions = db.query<{ version: number; checksum: string }, []>('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
  if (versions.length !== expectedVersion || versions.some((row, index) => row.version !== index + 1
    || row.version === 17 && row.checksum !== SCHEMA17_MIGRATION_MARKER)) throw new Error('storage_migration_failed');
}
