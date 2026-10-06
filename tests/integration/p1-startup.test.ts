import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import type { AppError } from '../../packages/contracts/src/error';
import type { HostStartupFailure } from '../../packages/logging/src/host-startup-failure';
import { openDatabase } from '../../packages/storage/src/database';

const migrationNames = ['001_p1.sql', '002_p2.sql', '003_p3.sql', '004_p5.sql', '005_p6.sql'];
function historicalDatabase(path: string, version: number, ending: 'LF' | 'CRLF', changedSchema = false) {
  const db = new Database(path, { create: true, strict: true });
  db.exec('PRAGMA foreign_keys=ON');
  for (const [index, name] of migrationNames.slice(0, version).entries()) {
    const lf = readFileSync(new URL(`../../packages/storage/src/migrations/${name}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    const sql = ending === 'LF' ? lf : lf.replaceAll('\n', '\r\n');
    if (index === 1 || index === 3) db.exec('PRAGMA foreign_keys=OFF');
    try { db.transaction(() => db.exec(changedSchema && index === 2 ? sql.replace('source_device_id TEXT', 'source_device_id  TEXT') : sql)).immediate(); }
    finally { db.exec('PRAGMA foreign_keys=ON'); }
    db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(index + 1, createHash('sha256').update(sql).digest('hex'), '2026-10-02T00:00:00.000Z');
  }
  db.query(`INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at)
    VALUES(1,'native-before','create-before','{ "original": true }','{ "unicode": "器械😀" }','Existing session','2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000Z')`).run();
  db.exec('UPDATE workspace SET active_session_id=1,revision=7 WHERE id=1');
  return db;
}

test('LF schema 3 upgrades under the current checkout without rewriting old checksums or rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p1-lf-upgrade-')), path = join(root, 'app.sqlite');
  try {
    const old = historicalDatabase(path, 3, 'LF');
    const markers = old.query('SELECT * FROM schema_migrations ORDER BY version').all(), sessions = old.query('SELECT * FROM sessions').all();
    old.close();
    const db = openDatabase(path);
    try {
      expect(db.query('SELECT * FROM schema_migrations WHERE version<=3 ORDER BY version').all()).toEqual(markers);
      expect(db.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, {version:9}, { version: 10 }, { version: 11 }]);
      expect(db.query('SELECT * FROM sessions').all()).toEqual(sessions.map(session => ({
        ...session as Record<string, unknown>, metadata_json: '{"titleOrigin":"user"}', metadata_revision: 0, deleted_at: null,native_header_json:null,current_leaf_id:null,history_format_version:null,
      })));
      expect(db.query('SELECT active_session_id,revision FROM workspace').get()).toEqual({ active_session_id: 1, revision: 7 });
      expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
    const reopened = openDatabase(path); reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const ending of ['LF', 'CRLF'] as const) test(`schema 5 created with ${ending} SQL reopens without replacing its migration identities`, () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p1-newline-reopen-')), path = join(root, 'app.sqlite');
  try {
    const old = historicalDatabase(path, 5, ending), markers = old.query('SELECT * FROM schema_migrations ORDER BY version').all(); old.close();
    const db = openDatabase(path);
    try {
      expect(db.query('SELECT * FROM schema_migrations WHERE version<=5 ORDER BY version').all()).toEqual(markers);
      const lifecycleSql = readFileSync(new URL('../../packages/storage/src/migrations/006_session_lifecycle.sql', import.meta.url), 'utf8');
      expect(db.query('SELECT version,checksum FROM schema_migrations WHERE version=6').get()).toEqual({
        version: 6, checksum: createHash('sha256').update(lifecycleSql).digest('hex'),
      });
      expect(db.query('SELECT title,creation_result_json FROM sessions WHERE id=1').get()).toEqual({ title: 'Existing session', creation_result_json: '{ "unicode": "器械😀" }' });
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('newline compatibility rejects content checksum changes and non-newline schema changes', () => {
  for (const mutation of ['checksum', 'schema'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'medclaw-p1-newline-tamper-')), path = join(root, 'app.sqlite');
    try {
      const old = historicalDatabase(path, 5, 'LF', mutation === 'schema');
      if (mutation === 'checksum') {
        const sql = readFileSync(new URL('../../packages/storage/src/migrations/003_p3.sql', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
        old.query('UPDATE schema_migrations SET checksum=? WHERE version=3').run(createHash('sha256').update(`${sql}\n-- changed content`).digest('hex'));
      }
      const markers = old.query('SELECT * FROM schema_migrations ORDER BY version').all(); old.close();
      let unexpectedlyOpened: Database | null = null;
      try { expect(() => { unexpectedlyOpened = openDatabase(path); }).toThrow('storage_migration_failed'); }
      finally { (unexpectedlyOpened as Database | null)?.close(); }
      const original = new Database(path);
      try {
        expect(original.query('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(markers);
        expect(original.query('SELECT title FROM sessions WHERE id=1').get()).toEqual({ title: 'Existing session' });
      } finally { original.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('LF migration failure rolls back new schema and markers while preserving the original database', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p1-lf-rollback-')), path = join(root, 'app.sqlite');
  try {
    const old = historicalDatabase(path, 3, 'LF'), markers = old.query('SELECT * FROM schema_migrations ORDER BY version').all();
    const schema = old.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(); old.close();
    expect(() => openDatabase(path, phase => { if (phase === 'p5_marker') throw new Error('injected commit failure'); })).toThrow('storage_migration_failed');
    const original = new Database(path);
    try {
      expect(original.query('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(markers);
      expect(original.query('SELECT active_session_id,revision FROM workspace').get()).toEqual({ active_session_id: 1, revision: 7 });
      expect(original.query('SELECT title FROM sessions WHERE id=1').get()).toEqual({ title: 'Existing session' });
      expect(original.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).toEqual(schema);
    } finally { original.close(); }
    const recovered = openDatabase(path); recovered.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Host startup retains only the validated phase and error code from split fatal stderr', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p1-startup-fatal-'));
  const entry = join(root, 'host.ts');
  writeFileSync(entry, `process.stdin.once('data', () => {
    process.stderr.write('SECRET-CANARY'.repeat(40)+'\\nMedClaw Host terminated: SECRET-CANARY/host_start_failed.\\nMedClaw Host terminated: sdk_');
    setTimeout(() => { process.stderr.write('version/host_protocol_mismatch.\\n'); process.exit(1); }, 10);
  });`);
  const errors: AppError[] = [];
  const failures: HostStartupFailure[] = [];
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath, onError: error => errors.push(error), onStartupFailure: failure => failures.push(failure) });
  try {
    const state = await host.start();
    expect(state).toMatchObject({ state: 'failed', canStart: true, error: { code: 'host_protocol_mismatch' } });
    expect(errors.some(error => error.code === 'host_protocol_mismatch')).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ phase: 'sdk_version', error: { code: 'host_protocol_mismatch' } });
    expect(JSON.stringify([state, errors, failures])).not.toContain('SECRET-CANARY');
  } finally {
    if (!host.read().canStart && host.read().instanceId) await host.stop(host.read().instanceId!);
    rmSync(root, { recursive: true, force: true });
  }
});

async function mainFailure(mode: 'load' | 'preload') {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p1-main-startup-'));
  const script = join(root, 'main-fixture.ts'), entry = join(root, 'host.ts'), electron = join(root, 'electron.ts');
  writeFileSync(entry, `process.stdin.once('data', () => { process.stderr.write('MedClaw Host terminated: hello/host_start_failed.\\n'); process.exit(1); });`);
  writeFileSync(electron, `export const {app,BrowserWindow,ipcMain,safeStorage,shell,dialog}=globalThis.__startupFixture;`);
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, '../../apps/desktop/src/main/index.ts')], target: 'bun', outdir: join(root, 'bundle'), plugins: [{ name: 'electron-startup-boundary', setup(builder) { builder.onResolve({ filter: /^electron$/ }, () => ({ path: electron })); } }] });
  expect(build.success).toBe(true);
  const main = pathToFileURL(build.outputs[0]!.path).href;
  writeFileSync(script, `import {EventEmitter} from 'node:events';
const handlers=new Map(), app=new EventEmitter(); let window, unhandled=false;
Object.defineProperty(process.versions,'electron',{value:'44.5.1'});
process.on('unhandledRejection',()=>{unhandled=true;});
Object.assign(app,{setName(){},getAppPath:()=>${JSON.stringify(join(root, 'main'))},getPath:()=>${JSON.stringify(root)},setPath(){},requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),exit(){},quit(){}});
class BrowserWindow extends EventEmitter {
  id=1; webContents=Object.assign(new EventEmitter(),{id:1,mainFrame:{url:'file:///startup.html'},send(){},setWindowOpenHandler(){}});
  constructor(){super();window=this;} isDestroyed(){return false;}
  async loadFile(){
    if(${JSON.stringify(mode)}==='preload')this.webContents.emit('preload-error',{},'SECRET-CANARY-path',new Error('SECRET-CANARY-preload'));
    if(${JSON.stringify(mode)}==='load')throw new Error('SECRET-CANARY-load');
  }
}
const ipcMain=Object.assign(new EventEmitter(),{handle:(name,handler)=>handlers.set(name,handler),removeHandler:(name)=>handlers.delete(name)});
globalThis.__startupFixture={app,BrowserWindow,ipcMain,safeStorage:{isEncryptionAvailable:()=>false},shell:{},dialog:{}};
await import(${JSON.stringify(main)});
await Bun.sleep(250);
const diagnostics=await handlers.get('medclaw:request')({sender:window.webContents,senderFrame:window.webContents.mainFrame},{method:'diagnostics.read',payload:{categories:['errors','runtime','host']},operationRef:'startup-diagnostics'});
process.stdout.write(JSON.stringify({diagnostics,unhandled}));
`);
  try {
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, MEDCLAW_HOST_ENTRY: entry, MEDCLAW_BUN_EXECUTABLE: process.execPath }, stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, output, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr.replaceAll('SECRET-CANARY', '[redacted fixture]'));
    expect(stderr).not.toContain('SECRET-CANARY');
    return JSON.parse(output) as { diagnostics: { ok: boolean; data: { entries: { message: string; error?: AppError }[] } }; unhandled: boolean };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('Main catches renderer load rejection and exposes a safe startup diagnostic through IPC', async () => {
  const result = await mainFailure('load');
  expect(result.unhandled).toBe(false);
  expect(result.diagnostics.ok).toBe(true);
  expect(result.diagnostics.data.entries.some(entry => /renderer.*load.*fail/i.test(entry.message))).toBe(true);
  expect(JSON.stringify(result)).not.toContain('SECRET-CANARY');
}, 20000);

test('Main exposes preload failure through diagnostics without paths or exception text', async () => {
  const result = await mainFailure('preload');
  expect(result.unhandled).toBe(false);
  expect(result.diagnostics.ok).toBe(true);
  expect(result.diagnostics.data.entries.some(entry => /preload.*fail/i.test(entry.message))).toBe(true);
  expect(JSON.stringify(result)).not.toContain('SECRET-CANARY');
}, 20000);
