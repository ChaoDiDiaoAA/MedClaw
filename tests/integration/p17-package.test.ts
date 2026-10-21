import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function sources() {
  const mod = await import('../../apps/desktop/build').catch(() => null);
  expect(mod?.stageRuntimeSources).toBeFunction(); return mod!.stageRuntimeSources;
}
test('installation runtime stages actual source and resource consumers while excluding Gold, user data and development tooling', async () => {
  const stage = await sources(), target = mkdtempSync(join(tmpdir(), 'MedClaw 安装 资源-')), root = resolve(import.meta.dir, '../..');
  try {
    const files = await stage(root, target);
    for (const file of ['apps/host/src/main.ts', 'apps/host/src/windows-job.ts', 'apps/host/src/maintenance.ts', 'apps/desktop/src/main/runtime-paths.ts',
      'packages/storage/src/migrations/016_business_identity.sql', 'packages/runtime-pi/package.json', 'agent-eval/src/datasets.ts', 'resources/catalog.json',
      'packages/storage/src/migrations/017_subagent_parallel.sql', 'resources/subagents/medclaw-audit.md', 'resources/subagents/general-analyst.md',
      'resources/subagent-prompts/medclaw-evidence-review.md', 'resources/subagent-prompts/parallel-medclaw-review.md',
      'resources/extensions/tool-audit/v1/index.ts', 'patches/@tintinweb%2Fpi-subagents@0.19.0.patch', 'package.json', 'bun.lock']) {
      expect(files).toContain(file); expect(readFileSync(join(target, file))).toEqual(readFileSync(join(root, file)));
    }
    expect(files.some(file => /(^|\/)(datasets|fixtures|records|runs|node_modules|docs|\.git)(\/|$)/.test(file))).toBe(false);
    expect(files.some(file => /credentials\.enc\.json|(^|\/)auth\.json|(^|\/)app\.sqlite|Gold/.test(file))).toBe(false);
    expect(readdirSync(target).sort()).toEqual(['agent-eval', 'apps', 'bun.lock', 'package.json', 'packages', 'patches', 'resources']);
  } finally { rmSync(target, { recursive: true, force: true }); }
});
test('a drifted first-party runtime package is rejected even while pi-coding-agent still reports 0.87.1', async () => {
  const root = resolve(import.meta.dir, '../..'), runtime = join(root, '.build/package-resources/medclaw/runtime');
  const stage = await sources(); await stage(root, runtime);
  const path = join(runtime, 'node_modules/@earendil-works/chord/package.json'), original = readFileSync(path), temporary = path + '.' + crypto.randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify({ ...JSON.parse(original.toString('utf8')), version: '0.87.2' })); renameSync(temporary, path);
    const script = 'const {installedSdkVersion}=await import(' + JSON.stringify(pathToFileURL(join(runtime, 'packages/runtime-pi/src/model-runtime.ts')).href)
      + ');try{console.log(JSON.stringify({version:await installedSdkVersion()}));}catch(error){console.log(JSON.stringify({code:error.code}));}';
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script], { cwd: runtime, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const output = await new Response(child.stdout).text(); expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({ code: 'host_protocol_mismatch' });
  } finally { writeFileSync(temporary, original); renameSync(temporary, path); }
}, 30000);
test('staging refuses a resource link to files outside its trusted source tree', async () => {
  const stage = await sources(), root = mkdtempSync(join(tmpdir(), 'medclaw-source-link-')), target = mkdtempSync(join(tmpdir(), 'medclaw-stage-link-'));
  try {
    const workspaces = ['apps/host', 'apps/desktop', 'agent-eval', 'packages/contracts'];
    for (const path of ['apps/host/src', 'apps/desktop/src/main', 'agent-eval/src', 'packages/contracts/src', 'resources', 'patches', 'private']) mkdirSync(join(root, path), { recursive: true });
    for (const path of workspaces) writeFileSync(join(root, path, 'package.json'), '{}');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces })); writeFileSync(join(root, 'bun.lock'), '{}');
    writeFileSync(join(root, 'private/secret.txt'), 'ENGINEERING synthetic private material');
    symlinkSync(join(root, 'private'), join(root, 'resources/alias'), 'junction');
    await expect(stage(root, target)).rejects.toThrow('build_source_link_rejected');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});
test('Windows installer pins build versions and preserves user data without automatic launch or updates', async () => {
  const root = resolve(import.meta.dir, '../..'), pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  expect(pkg.version).toBe('0.1.0'); expect(pkg.devDependencies['electron-builder']).toBe('26.15.3');
  expect(pkg.scripts['build:desktop']).toBe('bun apps/desktop/build.ts');
  expect(pkg.scripts['package:desktop']).toContain('--publish never');
  const desktop = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'));
  expect(desktop.dependencies.electron).toBeUndefined(); expect(desktop.devDependencies.electron).toBe('44.5.1');
  const mod = await import('../../apps/desktop/electron-builder.config').catch(() => null);
  expect(mod?.default).toMatchObject({ appId: 'dev.medclaw.desktop', productName: 'MedClaw', asar: true, electronVersion: '44.5.1', publish: null,
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, runAfterFinish: false, deleteAppDataOnUninstall: false, differentialPackage: false } });
  const hooks = readFileSync(join(root, 'apps/desktop/installer.nsh'), 'utf8');
  expect(hooks).toContain('customCheckAppRunning'); expect(hooks).toContain('customUnInstallCheck');
  expect(hooks).toContain('--retain-parent'); expect(hooks).not.toMatch(/KillProcess|taskkill|Stop-Process|--delete-app-data/);
  const node = Bun.which('node'); expect(node).not.toBeNull();
  const child = Bun.spawn([node!, '--input-type=module', '-e', 'const {default:config}=await import('+JSON.stringify(pathToFileURL(join(root, 'apps/desktop/electron-builder.config.ts')).href)+');console.log(JSON.stringify(config.directories));'],
    { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const output = await new Response(child.stdout).text(); expect(await child.exited).toBe(0);
  expect(JSON.parse(output).app).toBe(join(root, '.build/package-app'));
});

test('installer check retains the existing writer lease in its parent until that parent exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'MedClaw 升级 独占-')), project = resolve(import.meta.dir, '../..');
  const entry = join(project, 'apps/host/src/installer-check.ts');
  expect(existsSync(entry)).toBe(true);
  const lockModule = pathToFileURL(join(project, 'apps/host/src/writer-lock.ts')).href;
  const jobModule = pathToFileURL(join(project, 'apps/host/src/windows-job.ts')).href;
  const parent = Bun.spawn([process.execPath, '--no-env-file', '-e',
    'const check=Bun.spawn([process.execPath,"--no-env-file",'+JSON.stringify(entry)+','+JSON.stringify(root)+',"--retain-parent"],{stdout:"pipe",stderr:"pipe",windowsHide:true});'
    +'const output=await new Response(check.stdout).text();console.log(JSON.stringify({code:await check.exited,output}));setInterval(()=>{},1000);'],
    { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  try {
    const reader = parent.stdout.getReader(), first = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(first.value))).toEqual({ code: 0, output: 'ready\n' });
    const lockPath = join(root, 'runtime/host.lock'), original = readFileSync(lockPath, 'utf8');
    const probe = () => Bun.spawn([process.execPath, '--no-env-file', '-e',
      'const {createHostJob}=await import('+JSON.stringify(jobModule)+');const {acquireStoppedWriterLease}=await import('+JSON.stringify(lockModule)+');'
      +'const owner={instanceId:crypto.randomUUID(),startupToken:crypto.randomUUID()},job=createHostJob(owner);'
      +'try{const lease=await acquireStoppedWriterLease({lockPath:'+JSON.stringify(lockPath)+',owner,processDomain:job.domain});lease.release();console.log("acquired");}catch(e){console.log(e.message);}'],
      { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const blocked = probe(); expect((await new Response(blocked.stdout).text()).trim()).toBe('host_stop_unconfirmed'); expect(await blocked.exited).toBe(0);
    parent.kill(); await parent.exited;
    const after = probe(); expect((await new Response(after.stdout).text()).trim()).toBe('acquired'); expect(await after.exited).toBe(0);
    expect(readFileSync(lockPath, 'utf8')).toBe(original);
    expect(existsSync(join(root, 'data/app.sqlite'))).toBe(false);
  } finally { parent.kill(); await parent.exited; rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('upgrade checks reject live writers and invalid root selection without opening SQLite or changing the old identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-upgrade-refusal-')), project = resolve(import.meta.dir, '../..');
  const entry = join(project, 'apps/host/src/installer-check.ts'); mkdirSync(join(root, 'runtime'));
  const lockModule = pathToFileURL(join(project, 'apps/host/src/writer-lock.ts')).href, jobModule = pathToFileURL(join(project, 'apps/host/src/windows-job.ts')).href;
  const holder = Bun.spawn([process.execPath, '--no-env-file', '-e',
    'const {createHostJob}=await import('+JSON.stringify(jobModule)+');const {acquireWriterLock}=await import('+JSON.stringify(lockModule)+');'
    +'const owner={instanceId:crypto.randomUUID(),startupToken:crypto.randomUUID()},job=createHostJob(owner);'
    +'await acquireWriterLock({lockPath:'+JSON.stringify(join(root, 'runtime/host.lock'))+',owner,processDomain:job.domain});console.log("owned");setInterval(()=>{},1000);'],
    { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const check = () => Bun.spawn([process.execPath, '--no-env-file', entry, root, '--check'], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  try {
    await holder.stdout.getReader().read(); const original = readFileSync(join(root, 'runtime/host.lock'), 'utf8');
    const busy = check(); expect(await new Response(busy.stdout).text()).toBe('stop-unconfirmed\n'); expect(await busy.exited).toBe(2);
    expect(readFileSync(join(root, 'runtime/host.lock'), 'utf8')).toBe(original);
    holder.kill(); await holder.exited;
    const options = { bunExecutable: process.execPath, maintenanceEntry: join(project, 'apps/host/src/maintenance.ts') };
    const { requestMaintenance } = await import('../../apps/desktop/src/main/maintenance-controller');
    expect(await requestMaintenance(options, { action: 'upgrade.check', sourceRoot: root }, crypto.randomUUID())).toEqual({ ok: true, data: { checkedRoots: [root] } });
    writeFileSync(join(root, 'launch.json'), '{broken');
    const invalid = check(); expect(await new Response(invalid.stdout).text()).toBe('stop-unconfirmed\n'); expect(await invalid.exited).toBe(2);
    expect(readFileSync(join(root, 'launch.json'), 'utf8')).toBe('{broken'); expect(existsSync(join(root, 'data/app.sqlite'))).toBe(false);
  } finally { holder.kill(); await holder.exited; rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('upgrade checks both the original root and the root selected by the saved restore receipt', async () => {
  const base = mkdtempSync(join(tmpdir(), 'MedClaw 升级 恢复根-')), root = join(base, 'original'), selected = join(base, 'restored'), project = resolve(import.meta.dir, '../..');
  mkdirSync(root); mkdirSync(join(selected, 'data'), { recursive: true }); mkdirSync(join(selected, 'runtime'));
  const installation = JSON.parse(readFileSync(join(project, '.build/package-resources/medclaw/install.json'), 'utf8'));
  const operationRef = 'saved-restore';
  writeFileSync(join(selected, 'data/restore-receipt.json'), JSON.stringify({ request: { kind: 'restore', sourceBackup: join(base, 'backup'), targetRoot: selected },
    sourceOperationRef: 'saved-backup', installation, receipt: { operationRef, kind: 'restore', state: 'completed', appVersion: '0.1.0', sdkVersion: '0.87.1', schemaVersion: 17,
      restoredAt: '2026-10-17T00:00:00.000Z', configVersion: '2' } }));
  writeFileSync(join(root, 'launch.json'), JSON.stringify({ contract: 'medclaw.launch/v1', activeDataRoot: selected, restoreOperationRef: operationRef }));
  const { requestMaintenance } = await import('../../apps/desktop/src/main/maintenance-controller');
  const options = { bunExecutable: process.execPath, maintenanceEntry: join(project, 'apps/host/src/maintenance.ts') };
  try {
    expect(await requestMaintenance(options, { action: 'upgrade.check', sourceRoot: root }, crypto.randomUUID())).toEqual({ ok: true, data: { checkedRoots: [root, selected] } });
    const lockModule = pathToFileURL(join(project, 'apps/host/src/writer-lock.ts')).href, jobModule = pathToFileURL(join(project, 'apps/host/src/windows-job.ts')).href;
    for (const activeRoot of [root, selected]) {
      const child = Bun.spawn([process.execPath, '--no-env-file', '-e',
        'const {createHostJob}=await import('+JSON.stringify(jobModule)+');const {acquireWriterLock}=await import('+JSON.stringify(lockModule)+');'
        +'const owner={instanceId:crypto.randomUUID(),startupToken:crypto.randomUUID()},job=createHostJob(owner);'
        +'await acquireWriterLock({lockPath:'+JSON.stringify(join(activeRoot, 'runtime/host.lock'))+',owner,processDomain:job.domain});console.log("owned");setInterval(()=>{},1000);'],
        { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
      try {
        await child.stdout.getReader().read();
        expect(await requestMaintenance(options, { action: 'upgrade.check', sourceRoot: root }, crypto.randomUUID())).toMatchObject({ ok: false, error: { code: 'host_stop_unconfirmed' } });
      } finally { child.kill(); await child.exited; }
    }
    expect(existsSync(join(root, 'data/app.sqlite'))).toBe(false); expect(existsSync(join(selected, 'data/app.sqlite'))).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 30000);

test('the actual NSIS hook keeps its writer guard after nsExec returns and releases it only on NSIS exit', async () => {
  const project = resolve(import.meta.dir, '../..'), temporary = mkdtempSync(join(tmpdir(), 'MedClaw NSIS 独占-')), root = join(temporary, 'data root');
  const cache = join(process.env.ELECTRON_BUILDER_CACHE ?? join(process.env.LOCALAPPDATA!, 'electron-builder/Cache'), 'nsis-3.0.4.1');
  const compiler = readdirSync(cache, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => join(cache, item.name, 'makensis.exe')).find(existsSync);
  expect(compiler).toBeDefined();
  const executable = join(temporary, 'guard.exe'), ready = join(temporary, 'guard-ready'), close = join(temporary, 'guard-close'), script = join(temporary, 'guard.nsi');
  writeFileSync(script, '\ufeff' + [
    'Unicode true', 'Name "MedClaw controlled guard"', 'OutFile "'+executable+'"', 'SilentInstall silent', 'RequestExecutionLevel user', 'SetCompress off',
    '!define PROJECT_DIR "'+project+'"', '!include "LogicLib.nsh"', '!include "'+join(project, 'apps/desktop/installer.nsh')+'"', 'Section',
    '!insertmacro medclawGuard "--retain-parent" "'+root+'"', 'FileOpen $0 "'+ready+'" w', 'FileWrite $0 "ready"', 'FileClose $0',
    'waiting:', 'IfFileExists "'+close+'" stopped', 'Sleep 100', 'Goto waiting', 'stopped:', 'SectionEnd',
  ].join('\r\n'));
  const compiled = Bun.spawn([compiler!, '/V2', script], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const [code, output, errors] = await Promise.all([compiled.exited, new Response(compiled.stdout).text(), new Response(compiled.stderr).text()]);
  expect({ code, errors: output + errors }).toMatchObject({ code: 0 });
  const child = Bun.spawn([executable, '/S'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
  const { requestMaintenance } = await import('../../apps/desktop/src/main/maintenance-controller');
  const options = { bunExecutable: process.execPath, maintenanceEntry: join(project, 'apps/host/src/maintenance.ts') };
  try {
    const deadline = Date.now() + 30000;
    while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(50);
    expect(existsSync(ready)).toBe(true);
    expect(await requestMaintenance(options, { action: 'upgrade.check', sourceRoot: root }, crypto.randomUUID())).toMatchObject({ ok: false, error: { code: 'host_stop_unconfirmed' } });
    const original = readFileSync(join(root, 'runtime/host.lock'), 'utf8');
    writeFileSync(close, 'close'); expect(await child.exited).toBe(0);
    expect(await requestMaintenance(options, { action: 'upgrade.check', sourceRoot: root }, crypto.randomUUID())).toEqual({ ok: true, data: { checkedRoots: [root] } });
    expect(readFileSync(join(root, 'runtime/host.lock'), 'utf8')).toBe(original);
  } finally {
    writeFileSync(close, 'close'); if (child.exitCode === null) child.kill(); await child.exited;
    const stopped = await requestMaintenance(options, { action: 'upgrade.check', sourceRoot: root }, crypto.randomUUID());
    if (stopped.ok) rmSync(temporary, { recursive: true, force: true });
    else throw new Error('Controlled NSIS root remains unconfirmed; retain its files');
  }
}, 60000);

test('the generated NSIS installer refuses a running MedClaw process without closing it or installing files', async () => {
  const project = resolve(import.meta.dir, '../..'), temporary = mkdtempSync(join(tmpdir(), 'MedClaw NSIS 拒绝 活实例-'));
  const installer = join(project, '.build/installers/MedClaw-0.1.0-win-x64.exe'), executable = join(temporary, 'MedClaw.exe'), target = join(temporary, 'installation');
  expect(existsSync(installer)).toBe(true); copyFileSync(process.execPath, executable);
  const application = Bun.spawn([executable, '--no-env-file', '-e', 'console.log("owned");setInterval(()=>{},1000);'], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  try {
    expect(new TextDecoder().decode((await application.stdout.getReader().read()).value)).toBe('owned\n');
    const attempt = Bun.spawn([installer, '/S', '/D='+target], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    expect(await attempt.exited).toBe(2);
    expect(application.exitCode).toBeNull(); expect(() => process.kill(application.pid, 0)).not.toThrow();
    expect(existsSync(join(target, 'MedClaw.exe'))).toBe(false);
  } finally { application.kill(); await application.exited; rmSync(temporary, { recursive: true, force: true }); }
}, 30000);
