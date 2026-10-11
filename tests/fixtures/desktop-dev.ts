import { chromium, type Browser, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { canonicalRequest } from '../../packages/contracts/src/run';

export const projectRoot = resolve(import.meta.dirname, '../..');
export const bunExecutable = process.env.MEDCLAW_BUN_EXECUTABLE ?? execFileSync('bun', ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).trim();

export async function launchActualDev(temporary: string, dataRoot: string, importDirectory?: string, beforePageAcquisition?: () => void, controlledHostEntry?: string, controlledMainEntry?: string): Promise<{ page: Page; browser: Browser; child: ChildProcess; close(): Promise<void> }> {
  mkdirSync(temporary, { recursive: true });
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const observer = join(temporary, 'observe.cjs');
  const quitRequest = join(temporary, 'request-dev-quit');
  const exitConfirmation = join(temporary, 'dev-exit-confirmed');
  // This observes the ordinary launcher. It does not replace app.whenReady,
  // create a Host wrapper, register a provider, or alter readiness decisions.
  writeFileSync(observer, `if(process.versions.electron){
    ${controlledHostEntry ? `process.env.MEDCLAW_HOST_ENTRY=${JSON.stringify(controlledHostEntry)};` : ''}
    const Module=require('module'), original=Module._load;let observed=false;
    Module._load=function(name,...rest){const value=original.call(this,name,...rest);
      if(name==='electron'&&value.app&&!observed){observed=true;
        ${controlledMainEntry ? `const observe=require(${JSON.stringify(controlledMainEntry)});if(typeof observe==='function')observe(value);` : ''}
        value.app.commandLine.appendSwitch('remote-debugging-port',${JSON.stringify(String(port))});
        value.app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
        value.app.on('browser-window-created',(_,window)=>window.hide());
        require('fs').writeFileSync(${JSON.stringify(join(temporary, 'observed-main.json'))},JSON.stringify({pid:process.pid}));
        const quitCheck=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(quitRequest)}))value.app.quit();},100);quitCheck.unref();
        value.app.once('will-quit',()=>clearInterval(quitCheck));
        ${importDirectory ? `value.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(importDirectory)}]});` : ''}
      }return value;
    };
  }`);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(observer)}` };
  // A clean root must not inherit the engineer's model credentials.
  for (const name of Object.keys(env)) if (/(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|CREDENTIAL|AWS_|AZURE_|GOOGLE_)/i.test(name)) delete env[name];
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(bunExecutable, ['run', 'dev:desktop', '--data-root', dataRoot], { cwd: projectRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-24000); };
  child.stdout!.on('data', collect); child.stderr!.on('data', collect);
  const exited = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
  void exited.catch(() => {});
  let browser: Browser | undefined;
  const confirmExit = async () => {
    // Ask the ordinary Main to quit even when CDP/page acquisition failed. Main's
    // existing before-quit handler still owns Host shutdown and lock removal.
    writeFileSync(quitRequest, 'quit');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Actual dev Main/Host exit is unconfirmed; retain its isolated root')), 15000); })]);
      writeFileSync(exitConfirmation, 'exited');
    } finally { clearTimeout(timer); }
  };
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && child.exitCode === null) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!browser) throw new Error(`Actual dev launcher did not expose its window (exit=${child.exitCode}, outputChars=${output.length})`);
    beforePageAcquisition?.();
    const context = browser.contexts()[0]!;
    let page = context.pages()[0];
    if (!page) page = await context.waitForEvent('page', { timeout: 15000 });
    await page.waitForLoadState('domcontentloaded');
    return { page, browser, child, async close() {
      try { await confirmExit(); } finally { await browser!.close(); }
      if (child.exitCode !== 0) throw new Error(`Actual dev launcher exited ${child.exitCode}`);
    } };
  } catch (error) {
    try { await confirmExit(); } finally { await browser?.close(); }
    throw error;
  }
}

export function createStartupPackage(root: string) {
  mkdirSync(root, { recursive: true });
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const csv = (values: string[]) => values.map(value => `"${value.replaceAll('"', '""')}"`).join(',');
  const master = { record_type: 'master', device_id: '00001', device_name: 'Startup fixture device', source_submission_id: '00009', source_applicant: 'Applicant', category: 'Category', manufacturer: 'Synthetic manufacturer' };
  const sourceLock = { schema: 'medclaw.source-lock/v1', sources: [{ source: 'fda', path: 'fixture.zip', sha256: 'a'.repeat(64), url: 'https://example.invalid/source' }] };
  writeFileSync(join(root, 'source-lock.json'), JSON.stringify(sourceLock));
  writeFileSync(join(root, 'entity-lineage.csv'), `${csv(Object.keys(master))}\n${csv(Object.values(master))}\n`);
  for (const name of ['adjustment-lineage.csv', 'validation-report.json', 'selection-report.json', '使用说明.md']) writeFileSync(join(root, name), name.endsWith('.json') ? '{}' : 'Engineering fixture');
  const headers = ['device_id', 'device_name', 'source_submission_id', 'source_applicant', 'category', 'region', 'snapshot_date', 'price_cents', 'currency', 'unit', 'status', 'manufacturer', 'distributor', 'source_refs_json', 'field_origins_json'];
  const origins = Object.fromEntries(headers.slice(0, 13).map(key => [key, { kind: 'synthetic', ruleId: 'startup-fixture' }]));
  const refs = [{ sourceId: 'fda', file: 'fixture.zip', row: 1, recordId: '00009', sha256: 'a'.repeat(64) }];
  const text = `${csv(headers)}\r\n${csv(['00001', master.device_name, '00009', 'Applicant', 'Category', '浙江', '2026-01-01', '100', 'CNY', '件', 'active', master.manufacturer, 'Distributor', JSON.stringify(refs), JSON.stringify(origins)])}\r\n`;
  writeFileSync(join(root, 'zhejiang_2026-01-01.csv'), text);
  writeFileSync(join(root, 'zhejiang_2026-01-01.metadata.json'), JSON.stringify({ contract: 'medclaw.snapshot/v1', mappingVersion: 'medclaw.snapshot/v1', materialVersion: 'startup-fixture/v1', generatorVersion: 'startup-fixture/v1', seed: 1, sourceBundleId: 'fixture', sourceLockHash: hash(canonicalRequest(sourceLock)), scopeKey: 'startup-scope', region: '浙江', cohortHash: hash(canonicalRequest([master])), snapshotDate: '2026-01-01', coverage: 'full', expectedEntityCount: 1, observedEntityCount: 1, declaredMissingEntityIds: [], fileSha256: hash(text), referenceDate: '2026-01-01', timezone: 'Asia/Shanghai' }));
  const files = readdirSync(root).sort().map(path => { const bytes = readFileSync(join(root, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }; });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ status: 'complete', files, businessFiles: 1, businessRows: 1, businessBytes: Buffer.byteLength(text), totalPayloadBytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
}

export function createLegacyLfRoot(dataRoot: string) {
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const script = join(dataRoot, 'legacy-fixture.ts');
  writeFileSync(script, `import {Database} from 'bun:sqlite';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
    const db=new Database(${JSON.stringify(join(dataRoot, 'data/app.sqlite'))},{create:true,strict:true});
    for(const [i,name] of ['001_p1.sql','002_p2.sql','003_p3.sql'].entries()){
      const sql=readFileSync(${JSON.stringify(join(projectRoot, 'packages/storage/src/migrations'))}+'/'+name,'utf8').replaceAll('\\r\\n','\\n');
      if(i===1)db.exec('PRAGMA foreign_keys=OFF');
      db.transaction(()=>{db.exec(sql);db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(i+1,createHash('sha256').update(sql).digest('hex'),'2026-10-01T00:00:00Z');}).immediate();
      db.exec('PRAGMA foreign_keys=ON');
    }
    db.query("INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at) VALUES(9,'old-native-session','old-session-create','{}','{}','Preserved legacy session','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')").run();
    db.query('UPDATE workspace SET active_session_id=9,revision=4').run();db.close();
  `);
  execFileSync(bunExecutable, [script], { cwd: projectRoot });
}

export function readStartupFacts(dataRoot: string) {
  const output = execFileSync(bunExecutable, ['-e', `import{Database}from'bun:sqlite';const db=new Database(${JSON.stringify(join(dataRoot, 'data/app.sqlite'))},{readonly:true});
    console.log(JSON.stringify({migrations:db.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version').all(),workspace:db.query('SELECT * FROM workspace').get(),sessions:db.query('SELECT id,title FROM sessions ORDER BY id').all(),runs:db.query('SELECT count(*) AS n FROM runs').get().n,calls:db.query('SELECT count(*) AS n FROM model_calls').get().n}));db.close();`], { cwd: projectRoot, encoding: 'utf8' });
  return JSON.parse(output) as { migrations: { version: number; checksum: string; applied_at: string }[]; workspace: { revision: number; active_session_id: number | null }; sessions: { id: number; title: string }[]; runs: number; calls: number };
}

export function setFixtureMigrationChecksum(dataRoot: string, checksum: string) {
  execFileSync(bunExecutable, ['-e', `import{Database}from'bun:sqlite';const db=new Database(${JSON.stringify(join(dataRoot, 'data/app.sqlite'))});db.query('UPDATE schema_migrations SET checksum=? WHERE version=3').run(${JSON.stringify(checksum)});db.close();`], { cwd: projectRoot });
}
