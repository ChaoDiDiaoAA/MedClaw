import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { launchActualDev, readStartupFacts } from '../fixtures/desktop-dev';
import { MainSettings } from '../../apps/desktop/src/main/settings';
import { createServer, type ServerResponse } from 'node:http';
import { HostViewSchema } from '../../packages/contracts/src/model';
import { EvaluationControlViewSchema } from '../../packages/contracts/src/evaluation';
import { safeError } from '../../packages/contracts/src/error';

async function desktopFixture(beforeLaunch?: (dataRoot: string) => void, missingBun = false) {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-桌面 维护-')), dataRoot = join(root, '用户 数据'), destination = join(root, '备份 目录'), targetParent = join(root, '恢复 目录');
  mkdirSync(destination); mkdirSync(targetParent);
  const choices = join(root, 'dialog-choices.json'), observer = join(root, 'file-dialog.cjs'), captured = join(root, 'restore-selection.json');
  const discardControl = join(root, 'discard-control.json'), discardEntered = join(root, 'discard-entered.json'), discardRelease = join(root, 'discard-release');
  const supportControl = join(root, 'support-control.json'), supportEntered = join(root, 'support-entered.json'), supportRelease = join(root, 'support-release');
  const quitSeen = join(root, 'before-quit-observed'), exitSeen = join(root, 'exit-observed.json');
  const hostNotice = join(root, 'host-notice.json'), evaluationNotice = join(root, 'evaluation-notice.json');
  const backupExchange = join(root, 'backup-exchange.json'), unknownBackup = join(root, 'unknown-backup-reply.json');
  writeFileSync(choices, '[]');
  // Only selection, reply failure and owned-file pauses are controlled; Main and its consumers execute unchanged.
  writeFileSync(observer, `module.exports=({app,dialog,ipcMain})=>{
    const fs=require('fs'), files=require('node:fs/promises'), open=files.open;
    app.on('before-quit',()=>fs.writeFileSync(${JSON.stringify(quitSeen)},'ENGINEERING ordinary app.quit'));
    app.on('browser-window-created',(_,window)=>{
      const send=window.webContents.send.bind(window.webContents);window.webContents.send=(channel,...args)=>{
        const notice=args[0];if(channel==='medclaw:notice'&&notice?.type==='host.status')fs.writeFileSync(${JSON.stringify(hostNotice)},JSON.stringify(notice.host));
        if(channel==='medclaw:notice'&&notice?.type==='eval.status')fs.writeFileSync(${JSON.stringify(evaluationNotice)},JSON.stringify(notice.control));
        return send(channel,...args);
      };
    });
    const exit=app.exit.bind(app);app.exit=code=>{fs.writeFileSync(${JSON.stringify(exitSeen)},JSON.stringify({code:code??0,pid:process.pid}));return exit(code);};
    files.open=async function(...args){
      const file=await Reflect.apply(open,this,args), path=String(args[0]), paths=require('path');
      if(args[1]==='wx'&&paths.dirname(path)===${JSON.stringify(destination)}&&paths.basename(path).startsWith('.MedClaw-support-')){
        const sync=file.sync.bind(file);file.sync=async()=>{
          const control=fs.existsSync(${JSON.stringify(supportControl)})?JSON.parse(fs.readFileSync(${JSON.stringify(supportControl)},'utf8')):null;
          if(control){fs.writeFileSync(${JSON.stringify(supportEntered)},JSON.stringify({temporary:path,id:control.id,pid:process.pid}));
            const deadline=Date.now()+30000;while(!fs.existsSync(${JSON.stringify(supportRelease)})||fs.readFileSync(${JSON.stringify(supportRelease)},'utf8')!==control.id){
              if(Date.now()>deadline)throw new Error('ENGINEERING support sync gate expired');await new Promise(done=>setTimeout(done,10));
            }}return sync();};
      }return file;
    };
    ${missingBun ? 'process.env.MEDCLAW_BUN_EXECUTABLE='+JSON.stringify(join(root, 'missing-bun.exe'))+';' : ''}
    const handle=ipcMain.handle.bind(ipcMain);
    ipcMain.handle=(channel,listener)=>handle(channel,channel==='medclaw:request'?async(event,envelope)=>{
      if(envelope?.method==='maintenance.discardSelection'){
        const fs=require('fs'), control=fs.existsSync(${JSON.stringify(discardControl)})?JSON.parse(fs.readFileSync(${JSON.stringify(discardControl)},'utf8')):null;
        fs.writeFileSync(${JSON.stringify(discardEntered)},JSON.stringify({operationRef:envelope.operationRef,...control}));
        if(control?.mode==='hold'){
          const deadline=Date.now()+30000;
          while(!fs.existsSync(${JSON.stringify(discardRelease)})||fs.readFileSync(${JSON.stringify(discardRelease)},'utf8')!==control.id){
            if(Date.now()>deadline)throw new Error('ENGINEERING discard reply gate expired');await new Promise(done=>setTimeout(done,10));
          }
        }
        if(control?.mode==='reject')return listener(event,{...envelope,payload:{unexpected:true}});
      }
      const result=await listener(event,envelope);
      if(envelope?.method==='backup.create'){
        const fs=require('fs'), prior=fs.existsSync(${JSON.stringify(backupExchange)})?JSON.parse(fs.readFileSync(${JSON.stringify(backupExchange)},'utf8')):null;
        fs.writeFileSync(${JSON.stringify(backupExchange)},JSON.stringify({calls:(prior?.calls??0)+1,request:envelope,original:result}));
        if(result.ok&&fs.existsSync(${JSON.stringify(unknownBackup)}))return{ok:false,error:{...JSON.parse(fs.readFileSync(${JSON.stringify(unknownBackup)},'utf8')),operationRef:envelope.operationRef}};
      }
      if(envelope?.method==='backup.select'&&envelope.payload?.purpose==='restore'&&result.ok&&result.data)
        require('fs').writeFileSync(${JSON.stringify(captured)},JSON.stringify({operationRef:envelope.operationRef,selection:result.data}));
      return result;
    }:listener);
    dialog.showOpenDialog=async()=>{
    const fs=require('fs'), choices=JSON.parse(fs.readFileSync(${JSON.stringify(choices)},'utf8')), path=choices.shift();
    fs.writeFileSync(${JSON.stringify(choices)},JSON.stringify(choices));return{canceled:!path,filePaths:path?[path]:[]};
  }};`);
  beforeLaunch?.(dataRoot);
  const desktop = await launchActualDev(root, dataRoot, undefined, undefined, undefined, observer);
  desktop.page.setDefaultTimeout(10000);
  const releaseDiscard = () => { if (existsSync(discardControl)) writeFileSync(discardRelease, JSON.parse(readFileSync(discardControl, 'utf8')).id); };
  const releaseSupport = () => { if (existsSync(supportControl)) writeFileSync(supportRelease, JSON.parse(readFileSync(supportControl, 'utf8')).id); };
  return { ...desktop, root, dataRoot, destination, targetParent,
    discard(mode: 'hold' | 'reject') { const id = crypto.randomUUID(); writeFileSync(discardControl, JSON.stringify({ mode, id })); return id; },
    discardRequest() { return existsSync(discardEntered) ? JSON.parse(readFileSync(discardEntered, 'utf8')) as { operationRef: string; mode?: string; id?: string } : null; },
    releaseDiscard, pendingChoices: () => JSON.parse(readFileSync(choices, 'utf8')) as string[],
    holdSupport() { const id = crypto.randomUUID(); writeFileSync(supportControl, JSON.stringify({ id })); return id; },
    supportWrite() { return existsSync(supportEntered) ? JSON.parse(readFileSync(supportEntered, 'utf8')) as { temporary: string; id: string; pid: number } : null; }, releaseSupport,
    requestQuit() { writeFileSync(join(root, 'request-dev-quit'), 'quit'); }, quitSeen: () => existsSync(quitSeen),
    exitSeen: () => existsSync(exitSeen) ? JSON.parse(readFileSync(exitSeen, 'utf8')) as { code: number; pid: number } : null,
    hostNotice: () => existsSync(hostNotice) ? HostViewSchema.parse(JSON.parse(readFileSync(hostNotice, 'utf8'))) : null,
    evaluationNotice: () => existsSync(evaluationNotice) ? EvaluationControlViewSchema.parse(JSON.parse(readFileSync(evaluationNotice, 'utf8'))) : null,
    loseBackupReply() { writeFileSync(unknownBackup, JSON.stringify(safeError('operation_result_unknown'))); },
    backupExchange: () => existsSync(backupExchange) ? JSON.parse(readFileSync(backupExchange, 'utf8')) as { calls: number; request: { operationRef: string; payload: unknown }; original: unknown } : null,
    lastRestoreSelection() { return JSON.parse(readFileSync(captured, 'utf8')) as { operationRef: string; selection: { sourceToken: string; targetRootToken: string } }; }, choose(paths: string[]) { writeFileSync(choices, JSON.stringify(paths)); }, async dispose(expectedExitCode = 0) {
    releaseDiscard(); releaseSupport();
    await desktop.close(expectedExitCode);
    const part = relative(resolve(tmpdir()), resolve(root));
    if (existsSync(join(root, 'dev-exit-confirmed')) && part && part !== '..' && !part.startsWith('..')) rmSync(root, { recursive: true, force: true });
  } };
}

async function expectBothRestoreGrantsRevoked(desktop: Awaited<ReturnType<typeof desktopFixture>>, canceled: ReturnType<Awaited<ReturnType<typeof desktopFixture>>['lastRestoreSelection']>) {
  const host = await desktop.page.evaluate(() => window.medclaw.request('host.read', {})), before = readStartupFacts(desktop.dataRoot);
  desktop.choose([desktop.destination, desktop.targetParent]);
  const fresh = await desktop.page.evaluate(operationRef => window.medclaw.request('backup.select', { purpose: 'restore' }, operationRef), canceled.operationRef);
  if (!fresh.ok || !fresh.data?.sourceToken || !fresh.data.targetRootToken) throw new Error('ENGINEERING fresh same-operation grants missing');
  const inputs = [
    { sourceToken: canceled.selection.sourceToken, targetRootToken: fresh.data.targetRootToken },
    { sourceToken: fresh.data.sourceToken, targetRootToken: canceled.selection.targetRootToken },
  ];
  for (const input of inputs) expect(await desktop.page.evaluate(request => window.medclaw.request('backup.restore', request.input, request.operationRef), { input, operationRef: canceled.operationRef }))
    .toMatchObject({ ok: false, error: { code: 'access_denied' } });
  expect(await desktop.page.evaluate(() => window.medclaw.request('host.read', {}))).toEqual(host);
  const after = readStartupFacts(desktop.dataRoot);
  for (const key of ['workspace', 'sessions', 'runs', 'calls'] as const) expect(after[key]).toEqual(before[key]);
  expect(readdirSync(desktop.targetParent)).toEqual([]); expect(readdirSync(desktop.destination)).toEqual([]);
}

test('P17 development desktop creates a stopped-root backup and reads its original receipt without a model request', async ({}) => {
  test.setTimeout(90000);
  const desktop = await desktopFixture();
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Support', exact: true }).click();
    await page.locator('summary').filter({ hasText: /^Diagnostics and support$/ }).click();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Support', exact: true }).click();
    await page.getByRole('button', { name: 'Read diagnostics', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Selected tool dependencies' }).getByRole('row')).toHaveCount(5, { timeout: 10000 });
    desktop.choose([desktop.destination]);
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Backup and restore', exact: true }).click();
    await page.getByRole('button', { name: 'Choose backup destination', exact: true }).click({ timeout: 5000 });
    const confirmation = page.getByRole('alertdialog', { name: 'Confirm data backup' });
    await expect(confirmation).toBeVisible(); await confirmation.getByRole('button', { name: 'Confirm backup', exact: true }).click();
    await expect(page.getByText('Backup completed. Host remains stopped.', { exact: true })).toBeVisible({ timeout: 30000 });
    const directory = readdirSync(desktop.destination).find(name => name.startsWith('MedClaw-backup-'))!;
    const record = JSON.parse(readFileSync(join(desktop.destination, directory, 'receipt.json'), 'utf8'));
    desktop.choose([join(desktop.destination, directory)]);
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Backup and restore', exact: true }).click();
    await page.getByRole('button', { name: 'Read original result', exact: true }).click();
    await page.locator('summary').filter({ hasText: /^Backup receipt details$/ }).click();
    await expect(page.getByText('Original operation: ' + record.receipt.operationRef, { exact: true })).toBeVisible({ timeout: 10000 });
    expect(readStartupFacts(desktop.dataRoot)).toMatchObject({ runs: 0, calls: 0 });
    expect(record.receipt).toMatchObject({ kind: 'create', state: 'completed', sdkVersion: '0.87.1', schemaVersion: 17 });
  } finally { await desktop.dispose(); }
});

test('P17 malformed settings preserve their bytes and leave Main diagnostics available before explicit repair', async () => {
  test.setTimeout(90000); let original = '';
  const desktop = await desktopFixture(dataRoot => {
    mkdirSync(join(dataRoot, 'data'), { recursive: true }); const path = join(dataRoot, 'data/settings.json');
    new MainSettings(path).read(); original = readFileSync(path, 'utf8'); writeFileSync(path, '{broken-settings');
  });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host failed to start', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'General', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save display preferences', exact: true })).toBeDisabled();
    const diagnostics = await page.evaluate(() => window.medclaw.request('diagnostics.read', { categories: ['versions', 'errors', 'runtime'] }));
    expect(diagnostics).toMatchObject({ ok: true, data: { partial: true, versions: { configVersion: null } } });
    const path = join(desktop.dataRoot, 'data/settings.json'); expect(readFileSync(path, 'utf8')).toBe('{broken-settings');
    expect(existsSync(join(desktop.dataRoot, 'data/app.sqlite'))).toBe(false);
    const stopped = await page.evaluate(() => window.medclaw.request('host.read', {})); expect(stopped).toMatchObject({ ok: true, data: { canStart: true } });
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'General', exact: true }).click();
    writeFileSync(path, original); await page.getByRole('button', { name: 'Start Host', exact: true }).click();
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'General', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save display preferences', exact: true })).toBeEnabled();
    expect(readStartupFacts(desktop.dataRoot)).toMatchObject({ runs: 0, calls: 0 });
  } finally { await desktop.dispose(); }
});

test('P17 invalid launch selection opens only Main diagnostics and does not choose an empty business root', async ({}) => {
  test.setTimeout(90000);
  const desktop = await desktopFixture(dataRoot => { mkdirSync(dataRoot, { recursive: true }); writeFileSync(join(dataRoot, 'launch.json'), '{broken-selection'); });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host failed to start', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    expect(await page.evaluate(() => window.medclaw.request('host.read', {}))).toMatchObject({ ok: true, data: { instanceId: null, canStart: false, error: { reason: 'desktop_bootstrap_failed' } } });
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const diagnostics = await page.evaluate(() => window.medclaw.request('diagnostics.read', { categories: ['errors', 'runtime'] }));
    expect(diagnostics).toMatchObject({ ok: true, data: { partial: true, missingSources: ['host'] } });
    expect(await page.evaluate(() => window.medclaw.request('host.start', {}))).toMatchObject({ ok: false, error: { reason: 'desktop_bootstrap_failed' } });
    expect(readFileSync(join(desktop.dataRoot, 'launch.json'), 'utf8')).toBe('{broken-selection');
    for (const file of ['data/app.sqlite', 'data/settings.json', 'runtime/host.lock']) expect(existsSync(join(desktop.dataRoot, file))).toBe(false);
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Support', exact: true }).click();
    await page.locator('summary').filter({ hasText: /^Diagnostics and support$/ }).click();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Support', exact: true }).click();
    await page.getByRole('button', { name: 'Read diagnostics', exact: true }).click();
  } finally {
    // Remove only the deliberately invalid selection after proving that bootstrap created no writer.
    rmSync(join(desktop.dataRoot, 'launch.json')); await desktop.dispose(1);
  }
});

test('P17 missing Bun leaves the trusted desktop shell usable while execution and maintenance stay blocked', async () => {
  test.setTimeout(90000); const desktop = await desktopFixture(undefined, true);
  try {
    const { page } = desktop;
    await expect(page.getByText('Host failed to start', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'General', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start Host', exact: true })).toBeDisabled();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Backup and restore', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Choose backup destination', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.medclaw.request('diagnostics.read', { categories: ['versions', 'errors', 'runtime'] }))).toMatchObject({ ok: true, data: { partial: true, versions: { bunVersion: null } } });
    expect(await page.evaluate(() => window.medclaw.request('backup.select', { purpose: 'create' }))).toMatchObject({ ok: false, error: { reason: 'desktop_bootstrap_failed' } });
    for (const file of ['data/app.sqlite', 'data/settings.json', 'runtime/host.lock']) expect(existsSync(join(desktop.dataRoot, file))).toBe(false);
  } finally { await desktop.dispose(1); }
});

test('P17 development restore selection retains failed cancellation and waits for Main revocation of both original grants', async ({}) => {
  test.setTimeout(90000);
  const desktop = await desktopFixture();
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    desktop.choose([desktop.destination, desktop.targetParent]);
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Backup and restore', exact: true }).click();
    await page.getByRole('button', { name: 'Choose backup to restore', exact: true }).click({ timeout: 5000 });
    const confirmation = page.getByRole('alertdialog', { name: 'Confirm data restore' });
    await expect(confirmation).toBeVisible(); await expect(confirmation.getByText(/credentials/i)).toBeVisible();
    const canceled = desktop.lastRestoreSelection();
    desktop.discard('reject'); await confirmation.getByRole('button', { name: 'Keep current data', exact: true }).click();
    await expect(confirmation.getByRole('button', { name: 'Keep current data', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert')).toBeVisible(); await expect(confirmation).toBeVisible();
    await expect(page.getByText('Selection cancelled.', { exact: true })).toHaveCount(0);
    expect(desktop.discardRequest()?.operationRef).toBe(canceled.operationRef);
    const gate = desktop.discard('hold'); await confirmation.getByRole('button', { name: 'Keep current data', exact: true }).click();
    await expect.poll(() => desktop.discardRequest()?.id).toBe(gate);
    await expect(confirmation).toBeVisible(); await expect(confirmation.getByRole('button', { name: 'Confirm restore', exact: true })).toBeDisabled();
    await expect(page.getByText('Selection cancelled.', { exact: true })).toHaveCount(0);
    desktop.releaseDiscard(); await expect(page.getByText('Selection cancelled.', { exact: true })).toBeVisible(); await expect(confirmation).toHaveCount(0);
    await expectBothRestoreGrantsRevoked(desktop, canceled);
    expect(readStartupFacts(desktop.dataRoot)).toMatchObject({ runs: 0, calls: 0 });
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible();
  } finally { await desktop.dispose(); }
});

for (const action of ['replace', 'read'] as const) test('P17 development ' + action + ' revokes the prior restore grants before its next native choice', async () => {
  test.setTimeout(90000); const desktop = await desktopFixture();
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Backup and restore', exact: true }).click();
    desktop.choose([desktop.destination, desktop.targetParent]); await page.getByRole('button', { name: 'Choose backup to restore', exact: true }).click();
    await expect(page.getByRole('alertdialog', { name: 'Confirm data restore' })).toBeVisible();
    const prior = desktop.lastRestoreSelection(), nextChoices = action === 'replace' ? [desktop.destination, desktop.targetParent] : [desktop.destination];
    desktop.choose(nextChoices); const gate = desktop.discard('hold');
    await page.getByRole('button', { name: action === 'replace' ? 'Choose backup to restore' : 'Read original result', exact: true }).click();
    await expect.poll(() => desktop.discardRequest()?.id).toBe(gate); expect(desktop.discardRequest()?.operationRef).toBe(prior.operationRef);
    expect(desktop.pendingChoices()).toEqual(nextChoices);
    desktop.releaseDiscard(); await expect.poll(() => desktop.pendingChoices()).toEqual([]);
    if (action === 'replace') {
      await expect(page.getByRole('alertdialog', { name: 'Confirm data restore' })).toBeVisible();
      expect(desktop.lastRestoreSelection().operationRef).not.toBe(prior.operationRef);
    } else { await expect(page.getByRole('alertdialog', { name: 'Confirm data restore' })).toHaveCount(0); await expect(page.getByRole('alert')).toBeVisible(); }
    await expectBothRestoreGrantsRevoked(desktop, prior);
  } finally { await desktop.dispose(); }
});

test('P17 development A running B browsing keeps its draft through an owned Host crash and starts no recovery request', async ({}) => {
  test.setTimeout(120000);
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-桌面 草稿-')), dataRoot = join(root, '用户 数据');
  const observer = join(root, 'observe-host.cjs'), capturedPath = join(root, 'captured-host.json'), killRequest = join(root, 'kill-owned-host'), killedPath = join(root, 'owned-host-killed.json');
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const settingsPath = join(dataRoot, 'data/settings.json'), settings = new MainSettings(settingsPath).read();
  if (settings.intentModel?.enabled) writeFileSync(settingsPath, JSON.stringify({ ...settings, intentModel: { ...settings.intentModel, enabled: false } }));
  writeFileSync(observer, [
    'module.exports=({app})=>{const cp=require("node:child_process"),fs=require("node:fs");const spawn=cp.spawn;let captured=null;',
    'cp.spawn=function(file,args,options){const child=spawn(file,args,options);const env=options?.env;',
    'if(env?.MEDCLAW_INSTANCE_ID&&env?.MEDCLAW_STARTUP_TOKEN&&args?.[0]==="--no-env-file"&&args[1]===' + JSON.stringify(resolve('apps/host/src/main.ts')) + '){',
    'captured={child,instanceId:env.MEDCLAW_INSTANCE_ID,startupToken:env.MEDCLAW_STARTUP_TOKEN};child.once("spawn",()=>fs.writeFileSync(' + JSON.stringify(capturedPath) + ',JSON.stringify({pid:child.pid,instanceId:env.MEDCLAW_INSTANCE_ID})));}return child;};',
    'const timer=setInterval(()=>{if(!fs.existsSync(' + JSON.stringify(killRequest) + '))return;fs.unlinkSync(' + JSON.stringify(killRequest) + ');let result={killAccepted:false};',
    'try{const owner=JSON.parse(fs.readFileSync(' + JSON.stringify(join(dataRoot, 'runtime/host.lock')) + ',"utf8"));',
    'if(captured&&captured.child.exitCode===null&&captured.child.signalCode===null&&owner.pid===captured.child.pid&&owner.instanceId===captured.instanceId&&owner.startupToken===captured.startupToken)',
    'result={killAccepted:captured.child.kill("SIGKILL"),instanceId:captured.instanceId};}catch{}',
    'fs.writeFileSync(' + JSON.stringify(killedPath) + ',JSON.stringify(result));},20);timer.unref();app.once("will-quit",()=>clearInterval(timer));};',
  ].join('\n'));
  const requests: unknown[] = [], pending = new Set<ServerResponse>(); let hold = false, failed = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) { response.writeHead(404); response.end(); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ id: 'p17-draft-' + requests.length, model: 'fixture', choices: [{ index: 0,
        delta: { role: 'assistant', content: hold ? 'ENGINEERING transient' : 'ENGINEERING saved answer' }, finish_reason: null }] }) + '\n\n');
      if (hold) { pending.add(response); response.once('close', () => pending.delete(response)); }
      else response.end('data: ' + JSON.stringify({ id: 'p17-draft-' + requests.length, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } catch { response.destroy(); }
  });
  let desktop: Awaited<ReturnType<typeof launchActualDev>> | undefined, cleanupConfirmed = false;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const running = await launchActualDev(root, dataRoot, undefined, undefined, undefined, observer); desktop = running;
    const { page } = running; page.setDefaultTimeout(10000);
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const configured = await page.evaluate(async baseUrl => {
      const directory = await window.medclaw.request('model.read', {}); if (!directory.ok) throw new Error(directory.error.code);
      const token = await window.medclaw.secretInput({ providerId: 'p17-draft-fixture', purpose: 'custom_api_key', value: 'LOCAL-FIXTURE-ONLY' }); if (!token.ok) throw new Error(token.error.code);
      const saved = await window.medclaw.request('model.custom.save', { expectedConfigVersion: directory.data.configVersion, credentialInput: token.data.token,
        definition: { providerId: 'p17-draft-fixture', name: 'P17 draft fixture', api: 'openai-completions', baseUrl,
          models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] } });
      if (!saved.ok) throw new Error(saved.error.code);
      return window.medclaw.request('model.configure', { provider: 'p17-draft-fixture', modelId: 'fixture', expectedConfigVersion: saved.data.configVersion });
    }, 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1');
    expect(configured.ok).toBe(true); expect(requests).toHaveLength(0);
    const workspace = () => page.evaluate(async () => { const result = await window.medclaw.request('workspace.read', {}); if (!result.ok) throw new Error(result.error.code); return result.data; });
    const detail = (sessionId: number) => page.evaluate(async sessionId => { const result = await window.medclaw.request('session.read', { sessionId }); if (!result.ok || !result.data) throw new Error('ENGINEERING Session unavailable'); return result.data; }, sessionId);
    const idle = () => expect.poll(() => page.evaluate(async () => { const result = await window.medclaw.request('run.control.read', {}); return result.ok && result.data.acceptingNewRuns; })).toBe(true);
    const select = async (sessionId: number) => {
      await page.locator('.session-row[data-session-id="' + sessionId + '"]').getByRole('button').first().click();
      await expect.poll(async () => (await workspace()).sessionId).toBe(sessionId);
    };
    const create = async () => {
      const prior = (await workspace()).sessionId;
      await page.getByRole('button', { name: 'New Session', exact: true }).click();
      await expect.poll(async () => (await workspace()).sessionId).not.toBe(prior);
      const id = (await workspace()).sessionId; if (!id) throw new Error('ENGINEERING Session not created'); return id;
    };
    const submit = (sessionId: number, text: string, operationRef: string) => page.evaluate(async input => {
      const w = await window.medclaw.request('workspace.read', {}), d = await window.medclaw.request('session.read', { sessionId: input.sessionId }),
        model = await window.medclaw.request('model.read', {});
      if (!w.ok || !d.ok || !d.data || !model.ok) throw new Error('ENGINEERING submission source unavailable');
      const result = await window.medclaw.request('session.submit', { sessionId: input.sessionId, clientSequence: d.data.session.nextSubmissionSequence,
        text: input.text, mode: 'send', expectedRevision: w.data.revision, expectedBatchIds: [], expectedQueryId: null,
        model: { provider: 'p17-draft-fixture', modelId: 'fixture', expectedConfigVersion: model.data.configVersion }, referenceDate: '2026-10-17', timezone: 'Asia/Shanghai' }, input.operationRef);
      if (!result.ok) throw new Error(result.error.code);
      if (result.data.runId === null) throw new Error('ENGINEERING root submission did not create a Run');
      return result.data.runId;
    }, { sessionId, text, operationRef });
    const a = await create(); await submit(a, 'ENGINEERING desktop A saved', 'p17-desktop-A-saved'); await idle();
    const b = await create(); await submit(b, 'ENGINEERING desktop B saved', 'p17-desktop-B-saved'); await idle();
    await expect(page.getByTestId('run-save-status')).toHaveText('Saved');
    await expect(page.getByTestId('run-save-status')).toBeAttached();
    await expect(page.getByTestId('run-save-status')).toBeHidden();
    const composer = page.getByLabel('Message text', { exact: true }), draft = 'ENGINEERING B unsent draft', savedB = (await detail(b)).history;
    await select(a); hold = true;
    if (!await page.getByLabel('Message routing', { exact: true }).isVisible()) await page.locator('.composer-bottom > details.composer-routing > summary').click();
    await page.getByLabel('Message routing', { exact: true }).selectOption('main_agent');
    await page.getByLabel('Reference date', { exact: true }).fill('2026-10-17'); await page.getByLabel('Time zone', { exact: true }).fill('Asia/Shanghai');
    await composer.fill('ENGINEERING desktop A stopped'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => requests.length).toBe(3); await expect.poll(() => pending.size).toBe(1);
    const stopping = await page.evaluate(() => window.medclaw.request('run.active', {}));
    if (!stopping.ok || !stopping.data || stopping.data.sessionId !== a) throw new Error('ENGINEERING UI submission owner unavailable');
    const stoppedRunId = stopping.data.runId;
    await expect(page.getByText('Generating; not saved', { exact: true }).first()).toBeVisible();
    await select(b);
    await composer.fill(draft);
    await expect(page.getByTestId('stop-target')).toHaveText(`Stops Session ${a} · Run ${stoppedRunId}`);
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click(); await idle();
    await expect.poll(() => pending.size).toBe(0);
    expect(await page.evaluate(runId => window.medclaw.request('run.read', { runId }), stoppedRunId))
      .toMatchObject({ ok: true, data: { kind: 'one', run: { sessionId: a, status: 'cancelled', cleanup: { stopConfirmed: true, requiredPersistenceComplete: true } } } });
    expect((await detail(b)).history).toEqual(savedB); await expect(composer).toHaveValue(draft);
    await select(a); await expect(page.getByText('Cancelled and saved', { exact: true }).first()).toBeVisible();
    const activeRunId = await submit(a, 'ENGINEERING desktop A interrupted', 'p17-desktop-A-running');
    await expect.poll(() => requests.length).toBe(4); await select(b);
    await composer.fill(draft); await expect(composer).toHaveValue(draft);
    const before = { workspace: await workspace(), a: (await detail(a)).history, b: (await detail(b)).history };
    const oldHost = await page.evaluate(() => window.medclaw.request('host.read', {}));
    expect(oldHost.ok).toBe(true);
    await expect.poll(() => existsSync(capturedPath)).toBe(true);
    expect(JSON.parse(readFileSync(capturedPath, 'utf8')).instanceId).toBe(oldHost.ok ? oldHost.data.instanceId : null);
    writeFileSync(killRequest, 'kill only captured owner');
    await expect.poll(() => existsSync(killedPath)).toBe(true); expect(JSON.parse(readFileSync(killedPath, 'utf8'))).toMatchObject({ killAccepted: true });
    await expect(page.getByText('Host failed to start', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await expect(composer).toHaveValue(draft); hold = false;
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Collapse navigation', exact: true }).check();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'General', exact: true }).click();
    await page.getByRole('button', { name: 'Save display preferences', exact: true }).click();
    await expect(page.getByText('Display preferences published', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.medclaw.request('settings.ui.read', {}))).toMatchObject({ ok: true, data: { ui: { navCollapsed: true } } });
    await page.getByRole('button', { name: 'Expand navigation', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Support', exact: true }).click();
    await page.locator('summary').filter({ hasText: /^Diagnostics and support$/ }).click();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Support', exact: true }).click();
    await page.getByRole('button', { name: 'Read diagnostics', exact: true }).click();
    await expect(page.locator('.diagnostics')).toContainText('failed · ' + (oldHost.ok ? oldHost.data.instanceId : ''));
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'General', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start Host', exact: true })).toBeEnabled({ timeout: 15000 });
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'General', exact: true }).click();
    await page.getByRole('button', { name: 'Start Host', exact: true }).click();
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Chat', exact: true }).click(); await idle();
    expect(await workspace()).toEqual(before.workspace); await expect(composer).toHaveValue(draft);
    expect((await detail(a)).history).toEqual(before.a); expect((await detail(b)).history).toEqual(before.b); expect(requests).toHaveLength(4);
    const interrupted = await page.evaluate(runId => window.medclaw.request('run.read', { runId }), activeRunId);
    expect(interrupted).toMatchObject({ ok: true, data: { kind: 'one', run: { sessionId: a, status: 'failed', error: { code: 'runtime_interrupted' },
      cleanup: { stopConfirmed: true, requiredPersistenceComplete: true, processTreeProof: { instanceId: oldHost.ok ? oldHost.data.instanceId : null } } } } });
    await select(a);
    const source = await detail(a);
    expect(await page.evaluate(input => window.medclaw.request('session.restore', input, 'p17-desktop-A-restore'), { sessionId: a, expectedLeafId: source.session.leafId }))
      .toMatchObject({ ok: true, data: { runtime: { availability: 'ready' } } });
    expect(requests).toHaveLength(4);
    const freshRunId = await submit(a, 'ENGINEERING desktop A new input', 'p17-desktop-A-new'); await idle();
    expect(freshRunId).not.toBe(activeRunId); expect(requests).toHaveLength(5);
    expect(JSON.stringify(requests.at(-1))).toContain('ENGINEERING desktop A saved'); expect(JSON.stringify(requests.at(-1))).not.toContain('ENGINEERING desktop B saved');
    await select(b); await expect(composer).toHaveValue(draft);
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanupError: unknown;
    if (desktop) {
      let expectedExitCode = 0;
      try {
        const view = await desktop.page.evaluate(() => window.medclaw.request('host.read', {}));
        if (view.ok && view.data.state === 'failed') expectedExitCode = 1;
      } catch { /* The owned launcher can still request Main shutdown after a Renderer failure. */ }
      try { await desktop.close(expectedExitCode); cleanupConfirmed = true; }
      catch (error) { cleanupError = error; console.error('P17_DESKTOP_DRAFT_FIXTURE_RETAINED ' + JSON.stringify({ root })); }
    }
    for (const response of pending) response.destroy();
    if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (!failed && cleanupConfirmed && existsSync(join(root, 'dev-exit-confirmed'))) {
      const target = realpathSync(root), part = relative(realpathSync(tmpdir()), target);
      if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('ENGINEERING draft cleanup root changed');
      rmSync(target, { recursive: true, force: true });
    } else console.error('P17_DESKTOP_DRAFT_FIXTURE_RETAINED ' + JSON.stringify({ root }));
    if (cleanupError && !failed) throw cleanupError;
  }
});

test('P17 development desktop exports partial support and reads the original file after Renderer reload without Host or model calls', async ({}) => {
  test.setTimeout(90000);
  const desktop = await desktopFixture();
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Runtime', exact: true }).click();
    await page.getByRole('button', { name: 'Stop Host', exact: true }).click();
    await expect(page.getByText('Host stopped', { exact: true }).first()).toBeVisible();
    desktop.choose([desktop.destination]);
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Support', exact: true }).click();
    await page.getByRole('button', { name: 'Choose support destination', exact: true }).click({ timeout: 5000 });
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Support', exact: true }).click();
    await page.getByRole('button', { name: 'Export support bundle', exact: true }).click();
    await expect(page.getByText(/Support bundle completion receipt/)).toBeVisible();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'General', exact: true }).click();
    await expect(page.getByText(/Support bundle completion receipt/)).toBeVisible();
    const names = readdirSync(desktop.destination); expect(names).toHaveLength(1);
    const path = join(desktop.destination, names[0]!), original = readFileSync(path, 'utf8'), record = JSON.parse(original);
    expect(record).toMatchObject({ contract: 'medclaw.support/v1', receipt: { partial: true }, diagnostics: { partial: true, missingSources: ['host'], host: { state: 'stopped' } } });
    expect(original).not.toContain(desktop.dataRoot); expect(readStartupFacts(desktop.dataRoot)).toMatchObject({ runs: 0, calls: 0 });
    await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Support', exact: true }).click();
    desktop.choose([path]); await page.getByRole('button', { name: 'Read original support bundle', exact: true }).click();
    await expect(page.getByText(/Support bundle completion receipt/)).toBeVisible();
    await expect(page.getByText('Original support operation: '+record.request.operationRef, { exact: true })).toBeVisible();
    expect(readFileSync(path, 'utf8')).toBe(original);
    await expect(page.getByText('Host stopped', { exact: true }).first()).toBeVisible();
    await page.getByText(/Support bundle completion receipt/).scrollIntoViewIfNeeded();
  } finally { await desktop.dispose(); }
});

test('P17 ordinary Main quit waits for the original support file sync and rejects new writes before clean exit', async ({}) => {
  test.setTimeout(90000); const desktop = await desktopFixture();
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const beforeHost = await page.evaluate(() => window.medclaw.request('host.read', {})), ui = await page.evaluate(() => window.medclaw.request('settings.ui.read', {}));
    if (!ui.ok) throw new Error('ENGINEERING initial display configuration unavailable');
    const settings = readFileSync(join(desktop.dataRoot, 'data/settings.json'), 'utf8');
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); desktop.choose([desktop.destination]);
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Support', exact: true }).click();
    await page.getByRole('button', { name: 'Choose support destination', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Support', exact: true }).click();
    const gate = desktop.holdSupport(); await page.getByRole('button', { name: 'Export support bundle', exact: true }).click();
    await expect.poll(() => desktop.supportWrite()?.id).toBe(gate);
    const write = desktop.supportWrite()!; const pending = JSON.parse(readFileSync(write.temporary, 'utf8'));
    expect(pending).toMatchObject({ contract: 'medclaw.support/v1', receipt: { state: 'completed' } });
    const target = join(desktop.destination, 'MedClaw-support-' + pending.request.operationRef + '.json'); expect(existsSync(target)).toBe(false);
    desktop.requestQuit(); await expect.poll(desktop.quitSeen).toBe(true);
    expect(desktop.child.exitCode).toBeNull(); expect(desktop.exitSeen()).toBeNull(); expect(page.isClosed()).toBe(false);
    expect(await page.evaluate(() => window.medclaw.request('host.read', {}))).toEqual(beforeHost);
    expect(await page.evaluate(input => window.medclaw.request('settings.ui.update', input), { expectedConfigVersion: ui.data.configVersion, patch: { navCollapsed: !ui.data.ui.navCollapsed } }))
      .toMatchObject({ ok: false, error: { code: 'maintenance_busy' } });
    expect(readFileSync(join(desktop.dataRoot, 'data/settings.json'), 'utf8')).toBe(settings);
    desktop.releaseSupport(); await expect.poll(() => desktop.child.exitCode, { timeout: 15000 }).toBe(0);
    expect(desktop.exitSeen()).toEqual({ code: 0, pid: write.pid });
    expect(desktop.hostNotice()).toMatchObject({ instanceId: beforeHost.ok ? beforeHost.data.instanceId : null, state: 'stopped', canStart: true,
      shutdown: { executionStopped: true, requiredPersistenceComplete: true, databaseClosed: true, processExited: true, processTreeStopped: true } });
    expect(desktop.evaluationNotice()).toMatchObject({ stopConfirmed: true, saveConfirmed: true, controllerExited: true, executionId: null });
    const published = JSON.parse(readFileSync(target, 'utf8')); expect(published).toEqual(pending); expect(existsSync(write.temporary)).toBe(false);
    expect(readStartupFacts(desktop.dataRoot)).toMatchObject({ runs: 0, calls: 0 });
  } finally { await desktop.dispose(); }
});

test('P17 development unknown backup result retains its original identity and reads the real receipt without another create', async ({}) => {
  test.setTimeout(90000); const desktop = await desktopFixture();
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); desktop.choose([desktop.destination]);
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Backup and restore', exact: true }).click();
    await page.getByRole('button', { name: 'Choose backup destination', exact: true }).click();
    desktop.loseBackupReply(); await page.getByRole('alertdialog', { name: 'Confirm data backup' }).getByRole('button', { name: 'Confirm backup', exact: true }).click();
    await expect(page.getByText('Completion was not confirmed. Select the result directory to read the original receipt.', { exact: true })).toBeVisible({ timeout: 30000 });
    const exchange = desktop.backupExchange(); if (!exchange) throw new Error('ENGINEERING original backup exchange missing');
    const operationRef = exchange.request.operationRef;
    expect(exchange, JSON.stringify(exchange.original)).toMatchObject({ calls: 1, original: { ok: true, data: { operationRef, kind: 'create', state: 'completed' } } });
    expect(exchange.request.payload).toEqual({ destinationToken: expect.any(String) });
    await expect(page.getByText('Operation to check: ' + operationRef, { exact: true })).toBeVisible();
    await expect(page.getByText('Backup completed. Host remains stopped.', { exact: true })).toHaveCount(0);
    const directory = join(desktop.destination, 'MedClaw-backup-' + operationRef), original = readFileSync(join(directory, 'receipt.json'), 'utf8');
    expect(readdirSync(desktop.destination)).toEqual(['MedClaw-backup-' + operationRef]);
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Backup and restore', exact: true }).click();
    desktop.choose([directory]); await page.getByRole('button', { name: 'Read original result', exact: true }).click();
    await page.locator('summary').filter({ hasText: /^Backup receipt details$/ }).click();
    await expect(page.getByText('Original operation: ' + operationRef, { exact: true })).toBeVisible();
    await expect(page.getByText('Operation to check: ' + operationRef, { exact: true })).toHaveCount(0);
    expect(desktop.backupExchange()?.calls).toBe(1); expect(readFileSync(join(directory, 'receipt.json'), 'utf8')).toBe(original);
    expect(readStartupFacts(desktop.dataRoot)).toMatchObject({ runs: 0, calls: 0 });
    await expect(page.getByText('Host stopped', { exact: true }).first()).toBeVisible();
  } finally { await desktop.dispose(); }
});

test('P17 actual desktop preserves an offline Ollama failure and requires explicit Main Agent submission', async ({}) => {
  test.setTimeout(120000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'MedClaw 离线意图-'))), dataRoot = join(root, '用户 数据');
  const metadataRequests: string[] = [], mainRequests: unknown[] = [];
  const metadata = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const path = request.method + ' ' + request.url; metadataRequests.push(path);
      response.setHeader('content-type', 'application/json');
      if (path === 'GET /api/version') response.end(JSON.stringify({ version: 'ENGINEERING-protocol-fixture' }));
      else if (path === 'GET /api/tags') response.end(JSON.stringify({ models: [{ name: 'qwen3.5:0.8b' }] }));
      else if (path === 'POST /api/show' && JSON.parse(body).model === 'qwen3.5:0.8b') response.end(JSON.stringify({ details: { family: 'ENGINEERING fixture' } }));
      else { response.statusCode = 404; response.end('{}'); }
    } catch { response.destroy(); }
  });
  const main = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) { response.writeHead(404); response.end(); return; }
      let body = ''; for await (const chunk of request) body += chunk; mainRequests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ id: 'p17-offline-main', model: 'fixture', choices: [{ index: 0,
        delta: { role: 'assistant', content: 'ENGINEERING explicit Main Agent answer' }, finish_reason: null }] }) + '\n\n');
      response.end('data: ' + JSON.stringify({ id: 'p17-offline-main', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } catch { response.destroy(); }
  });
  const listen = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const close = async (server: ReturnType<typeof createServer>) => { if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
  let desktop: Awaited<ReturnType<typeof launchActualDev>> | undefined, failed = false, stopped = false;
  try {
    await listen(metadata); await listen(main);
    const address = metadata.address(), mainAddress = main.address();
    if (!address || typeof address === 'string' || !mainAddress || typeof mainAddress === 'string') throw new Error('ENGINEERING loopback address missing');
    const intentUrl = 'http://127.0.0.1:' + address.port;
    const running = await launchActualDev(root, dataRoot); desktop = running;
    const { page } = running; page.setDefaultTimeout(10000);
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const configured = await page.evaluate(async baseUrl => {
      const directory = await window.medclaw.request('model.read', {}); if (!directory.ok) throw new Error(directory.error.code);
      const token = await window.medclaw.secretInput({ providerId: 'p17-offline-main-fixture', purpose: 'custom_api_key', value: 'LOCAL-FIXTURE-ONLY' }); if (!token.ok) throw new Error(token.error.code);
      const saved = await window.medclaw.request('model.custom.save', { expectedConfigVersion: directory.data.configVersion, credentialInput: token.data.token,
        definition: { providerId: 'p17-offline-main-fixture', name: 'P17 offline Main fixture', api: 'openai-completions', baseUrl,
          models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] } });
      if (!saved.ok) throw new Error(saved.error.code);
      return window.medclaw.request('model.configure', { provider: 'p17-offline-main-fixture', modelId: 'fixture', expectedConfigVersion: saved.data.configVersion });
    }, 'http://127.0.0.1:' + mainAddress.port + '/v1');
    expect(configured.ok).toBe(true);
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    const panel = page.locator('section[aria-labelledby="intent-model-title"]');
    await page.getByRole('navigation', { name: 'Model tasks' }).getByRole('button', { name: 'Local routing', exact: true }).click();
    await expect(panel.getByLabel('Ollama URL', { exact: true })).toBeEnabled();
    await panel.getByLabel('Ollama URL', { exact: true }).fill(intentUrl);
    await panel.getByLabel('Verification record', { exact: true }).fill('ENGINEERING local protocol fixture, not model weights');
    await panel.getByRole('button', { name: 'Verify local model', exact: true }).click();
    await expect(panel.getByText('Local model tag and protocol metadata verified.', { exact: true })).toBeVisible();
    await panel.getByRole('checkbox', { name: 'Enable intent routing', exact: true }).check();
    await panel.getByRole('button', { name: 'Apply configuration', exact: true }).click();
    await expect(panel.getByText('Intent configuration applied.', { exact: true })).toBeVisible();
    expect(metadataRequests.length).toBeGreaterThanOrEqual(6); expect(metadataRequests.every(path => ['GET /api/version', 'GET /api/tags', 'POST /api/show'].includes(path))).toBe(true);
    expect(mainRequests).toHaveLength(0); expect(readStartupFacts(dataRoot)).toMatchObject({ runs: 0, calls: 0 });
    await close(metadata);
    await expect(fetch(intentUrl + '/api/version', { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    const inspectedCount = metadataRequests.length;
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: 'New Session', exact: true }).click();
    const message = page.getByLabel('Message text', { exact: true }), routing = page.getByLabel('Message routing', { exact: true });
    await expect(routing).toHaveValue('intent');
    if (!await page.getByLabel('Reference date', { exact: true }).isVisible()) await page.locator('.composer-bottom > details.composer-routing > summary').click();
    await page.getByLabel('Reference date', { exact: true }).fill('2026-10-17'); await page.getByLabel('Time zone', { exact: true }).fill('Asia/Shanghai');
    const text = 'ENGINEERING offline intent must not invoke Main Agent automatically';
    await message.fill(text); await page.getByRole('button', { name: 'Send', exact: true }).click();
    const recent = () => page.evaluate(async () => { const result = await window.medclaw.request('run.read', { recent: true }); return result.ok && result.data.kind === 'recent' ? result.data.runs[0] : null; });
    await expect.poll(async () => (await recent())?.status).toBe('failed');
    const original = await recent(); if (!original) throw new Error('ENGINEERING offline Run missing');
    expect(original.error?.code).toBe('intent_offline'); await expect(message).toHaveValue(text);
    const originalRun = await page.evaluate(runId => window.medclaw.request('run.read', { runId }), original.id);
    const originalIntent = await page.evaluate(runId => window.medclaw.request('intent.read', { runId }), original.id);
    expect(originalIntent).toMatchObject({ ok: true, data: { runId: original.id, calls: [], decision: null,
      execution: { runStatus: 'failed', queryIds: [], finalHistorySaved: false, requiredPersistenceComplete: true } } });
    expect(readStartupFacts(dataRoot)).toMatchObject({ runs: 1, calls: 0 }); expect(mainRequests).toHaveLength(0);
    await page.getByRole('button', { name: 'View run details', exact: true }).click();
    await page.getByRole('tab', { name: 'Run details', exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: 'Run details', exact: true }).getByRole('alert')).toHaveText('intent_offline · The local intent service could not be reached. A new recognition attempt is required.');
    await page.getByRole('button', { name: 'Close run details', exact: true }).click();
    const lookup = page.getByRole('button', { name: 'Read original submission', exact: true });
    if (await lookup.isVisible()) { await lookup.click(); await page.getByRole('button', { name: 'Start a new attempt', exact: true }).click(); }
    if (!await routing.isVisible()) await page.locator('.composer-bottom > details.composer-routing > summary').click();
    await routing.selectOption('main_agent'); await expect(message).toHaveValue(text);
    expect(mainRequests).toHaveLength(0); expect(readStartupFacts(dataRoot)).toMatchObject({ runs: 1, calls: 0 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await recent())?.status).toBe('completed');
    const explicit = await recent(); expect(explicit?.id).not.toBe(original.id);
    expect(mainRequests).toHaveLength(1); expect(metadataRequests).toHaveLength(inspectedCount);
    await expect(page.getByTestId('chat-native-messages')).toContainText('ENGINEERING explicit Main Agent answer');
    expect(readStartupFacts(dataRoot)).toMatchObject({ runs: 2, calls: 1 });
    expect(await page.evaluate(runId => window.medclaw.request('run.read', { runId }), original.id)).toEqual(originalRun);
    expect(await page.evaluate(runId => window.medclaw.request('intent.read', { runId }), original.id)).toEqual(originalIntent);
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    await panel.getByRole('button', { name: 'Verify local model', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('The local intent service could not be reached.');
    await panel.getByRole('checkbox', { name: 'Enable intent routing', exact: true }).uncheck();
    await panel.getByRole('button', { name: 'Apply configuration', exact: true }).click();
    await expect(panel.getByText('Intent configuration applied.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.medclaw.request('model.config.read', {}))).toMatchObject({ ok: true, data: { intentModel: { enabled: false, baseUrl: intentUrl } } });
    expect(await page.evaluate(runId => window.medclaw.request('run.read', { runId }), original.id)).toEqual(originalRun);
    expect(await page.evaluate(runId => window.medclaw.request('intent.read', { runId }), original.id)).toEqual(originalIntent);
    expect(mainRequests).toHaveLength(1); expect(metadataRequests).toHaveLength(inspectedCount); expect(readStartupFacts(dataRoot)).toMatchObject({ runs: 2, calls: 1 });
    await running.close(); desktop = undefined; stopped = true;
  } catch (error) { failed = true; throw error; }
  finally {
    try { if (desktop) { await desktop.close(); stopped = true; } }
    catch (error) { console.error('P17_OFFLINE_CLEANUP_UNCONFIRMED ' + root); if (!failed) { failed = true; throw error; } }
    finally {
      await close(metadata); await close(main);
      const within = relative(realpathSync(tmpdir()), root);
      if (!failed && stopped && existsSync(join(root, 'dev-exit-confirmed')) && within && within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within)) rmSync(root, { recursive: true, force: true });
      else console.error('P17_OFFLINE_ROOT_RETAINED ' + root);
    }
  }
});
