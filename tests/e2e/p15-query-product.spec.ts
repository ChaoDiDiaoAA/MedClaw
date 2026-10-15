import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { bunExecutable, createStartupPackage, launchActualDev, readStartupFacts } from '../fixtures/desktop-dev';

test.use({ actionTimeout: 10000 });

test('p15 actual desktop form, correction, evidence, history, activity and three explicit export formats', async () => {
  test.setTimeout(180000);
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-desktop-')), dataRoot = join(root, 'product'), source = join(root, 'source'), output = join(root, 'deliveries');
  createStartupPackage(source); mkdirSync(output);
  const nextCsv = readFileSync(join(source, 'zhejiang_2026-01-01.csv'), 'utf8').replaceAll('2026-01-01', '2026-01-02').replace('"100"', '"150"');
  writeFileSync(join(source, 'zhejiang_2026-01-02.csv'), nextCsv);
  const nextMetadata = JSON.parse(readFileSync(join(source, 'zhejiang_2026-01-01.metadata.json'), 'utf8'));
  writeFileSync(join(source, 'zhejiang_2026-01-02.metadata.json'), JSON.stringify({ ...nextMetadata, snapshotDate: '2026-01-02' }));
  const files = readdirSync(source).filter(name => name !== 'manifest.json').sort().map(path => { const bytes = readFileSync(join(source, path)); return { path, bytes: bytes.length }; });
  const businessBytes = Buffer.byteLength(nextCsv) + readFileSync(join(source, 'zhejiang_2026-01-01.csv')).length;
  writeFileSync(join(source, 'manifest.json'), JSON.stringify({ status: 'complete', files, businessFiles: 2, businessRows: 2, businessBytes, totalPayloadBytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
  const mainObserver = join(root, 'destination-observer.cjs');
  writeFileSync(mainObserver, `module.exports=({dialog,ipcMain})=>{const fs=require('fs'),path=require('path'),root=${JSON.stringify(root)};
    dialog.showSaveDialog=async(_,options)=>{const cancel=path.join(root,'cancel-dialog');if(fs.existsSync(cancel)){fs.unlinkSync(cancel);return {canceled:true};}return {canceled:false,filePath:path.join(${JSON.stringify(output)},options.defaultPath)};};
    const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>handle(channel,async(event,envelope)=>{const result=await fn(event,envelope);const lost=path.join(root,'lose-create-reply');if(channel==='medclaw:request'&&envelope?.method==='export.create'&&fs.existsSync(lost)){fs.unlinkSync(lost);throw new Error('ENGINEERING lost accepted reply');}return result;});};`);
  const executeSql = (sql: string) => execFileSync(bunExecutable, ['-e', "import{Database}from'bun:sqlite';const db=new Database(process.argv[1]);db.exec(process.argv[2]);db.close();", join(dataRoot, 'data/app.sqlite'), sql]);
  let desktop: Awaited<ReturnType<typeof launchActualDev>> | undefined, verified = false;
  try {
    desktop = await launchActualDev(root, dataRoot, source, undefined, undefined, mainObserver);
    const page = desktop.page; await page.setViewportSize({ width: 1100, height: 720 });
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    expect((await page.evaluate(async () => {
      const directory = await window.medclaw.request('model.read', {}); if (!directory.ok) throw new Error(directory.error.code);
      const secret = await window.medclaw.secretInput({ providerId: 'p15-fixture', purpose: 'custom_api_key', value: 'ENGINEERING' }); if (!secret.ok) throw new Error(secret.error.code);
      const saved = await window.medclaw.request('model.custom.save', { expectedConfigVersion: directory.data.configVersion, credentialInput: secret.data.token,
        definition: { providerId: 'p15-fixture', name: 'ENGINEERING metadata', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', models: [{ id: 'fixture', name: 'ENGINEERING metadata', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] } });
      if (!saved.ok) throw new Error(saved.error.code);
      return window.medclaw.request('model.configure', { provider: 'p15-fixture', modelId: 'fixture', expectedConfigVersion: saved.data.configVersion });
    })).ok).toBe(true);
    await page.getByRole('button', { name: 'Models', exact: true }).click(); await page.getByRole('button', { name: 'Reload published directory', exact: true }).click();
    await page.getByRole('button', { name: 'New Session', exact: true }).click();
    await page.getByRole('button', { name: 'Data Workspace', exact: true }).click(); await page.getByRole('button', { name: 'Choose snapshot directory', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Confirm import', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Confirm import', exact: true }).click();
    await page.getByLabel('Select batch 1', { exact: true }).check(); await page.getByRole('button', { name: 'Apply 1 selected batches', exact: true }).click();
    await page.getByRole('button', { name: 'Query History', exact: true }).click(); await page.getByLabel('On date', { exact: true }).fill('2026-01-01');
    await expect(page.getByRole('button', { name: 'Run query', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Run query', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Query 1 · Current devices', exact: true })).toBeVisible();
    await expect(page.getByTestId('query-results')).toContainText('Startup fixture device');
    await page.getByRole('button', { name: 'Read evidence 1', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Evidence 1', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Export saved result', exact: true })).toBeVisible();
    await expect(page.getByLabel('Business activity', { exact: true })).toContainText('query_committed');
    await page.getByRole('combobox', { name: 'Activity scope', exact: true }).selectOption('global');
    await expect(page.getByLabel('Business activity', { exact: true })).toContainText('import.imported');
    await expect(page.getByLabel('Business activity', { exact: true })).not.toContainText('query_committed');
    await page.getByRole('combobox', { name: 'Activity scope', exact: true }).selectOption('session');
    await expect(page.getByLabel('Business activity', { exact: true })).toContainText('query_committed');
    for (const [format, file] of [['csv', 'query-1.csv-export/result.csv'], ['json', 'query-1.json'], ['markdown', 'query-1.md']] as const) {
      await page.getByRole('combobox', { name: 'Export format', exact: true }).selectOption(format);
      await page.getByRole('button', { name: 'Choose destination and export', exact: true }).click();
      await expect(page.getByLabel('Export saved result', { exact: true }).getByText('Delivery verified', { exact: true }).first()).toBeVisible({ timeout: 30000 });
      await expect.poll(() => existsSync(join(output, file))).toBe(true); expect(readFileSync(join(output, file), 'utf8')).toContain('Startup fixture device');
    }
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('suspended'); await page.getByRole('button', { name: 'Run query', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Query 2 · Current devices', exact: true })).toBeVisible(); await expect(page.getByText('No rows matched these saved conditions.', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption(''); await page.getByRole('button', { name: 'Run query', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Query 3 · Current devices', exact: true })).toBeVisible(); await expect(page.getByTestId('query-results')).toContainText('Startup fixture device');
    expect(await page.evaluate(async () => { const r = await window.medclaw.request('query.read', { queryId: 3 }); return r.ok && r.data.query.basedOnQueryId; })).toBe(2);
    writeFileSync(join(root, 'cancel-dialog'), 'cancel');
    const choose = page.getByRole('button', { name: 'Choose destination and export', exact: true }); await choose.focus(); await page.keyboard.press('Enter'); await expect(choose).toBeFocused();
    expect(await page.evaluate(async () => { const r = await window.medclaw.request('export.list', { queryId: 3 }); return r.ok && r.data.items.length; })).toBe(0);
    await page.getByRole('combobox', { name: 'Query kind', exact: true }).selectOption('changes'); await page.getByLabel('Start date', { exact: true }).fill('2026-01-01'); await page.getByLabel('End date (exclusive)', { exact: true }).fill('2026-01-02');
    await page.getByRole('button', { name: 'Run query', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Query 4 · Device changes', exact: true })).toBeVisible(); await expect(page.getByText('baseline_no_predecessor:1', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Query kind', exact: true }).selectOption('aggregate'); await page.getByRole('combobox', { name: 'Population', exact: true }).selectOption('snapshot'); await page.getByLabel('On date', { exact: true }).fill('2026-01-01');
    await page.getByRole('button', { name: 'Run query', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Query 5 · Grouped statistics', exact: true })).toBeVisible(); await expect(page.getByTestId('query-results')).toContainText('devices');
    await page.getByRole('combobox', { name: 'Query kind', exact: true }).selectOption('trend'); await page.getByLabel('Start date', { exact: true }).fill('2026-01-01'); await page.getByLabel('End date (exclusive)', { exact: true }).fill('2026-01-03');
    await page.getByRole('button', { name: 'Run query', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Query 6 · Daily trend', exact: true })).toBeVisible(); await expect(page.getByText('Complete saved trend · 2 / 2 points', { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: /count.*devices/ })).toBeVisible(); await expect(page.getByTestId('query-results')).toContainText('true');
    executeSql("CREATE TRIGGER p15_delivery_fault BEFORE UPDATE OF state ON exports WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'ENGINEERING receipt save'); END");
    writeFileSync(join(root, 'lose-create-reply'), 'lose'); await page.getByRole('combobox', { name: 'Export format', exact: true }).selectOption('json'); await choose.click();
    await expect(page.getByRole('button', { name: 'Read original export', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Read original export', exact: true }).click();
    await expect(page.getByText('Delivery result unknown', { exact: true })).toBeVisible({ timeout: 30000 }); expect(existsSync(join(output, 'query-6.json'))).toBe(true);
    executeSql('DROP TRIGGER p15_delivery_fault'); await page.getByRole('button', { name: 'Verify and recover artifact', exact: true }).click(); await expect(page.getByText('Delivery result unknown', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Choose destination for new attempt', exact: true }).click(); await expect(page.getByText('Delivery verified', { exact: true })).toBeVisible({ timeout: 30000 });
    const exports = await page.evaluate(async () => { const r = await window.medclaw.request('export.list', { queryId: 6 }); if (!r.ok) throw new Error(r.error.code); return r.data.items; });
    expect(exports).toHaveLength(2); expect(exports[0]!.artifact?.id).toBe(exports[1]!.artifact?.id); expect(exports[0]!.priorOperationRef).toBe(exports[1]!.operationRef);
    await page.getByRole('button', { name: 'Refresh query history', exact: true }).click(); await page.getByRole('button', { name: 'Read Query 1 from Run 1', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Query 1 · Current devices', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Data Workspace', exact: true }).click(); await page.getByLabel('Select batch 2', { exact: true }).check(); await page.getByRole('button', { name: 'Apply 2 selected batches', exact: true }).click();
    await page.getByRole('button', { name: 'Query History', exact: true }).click(); await page.getByRole('button', { name: 'Read Query 1 from Run 1', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Query 1 · Current devices', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Query kind', exact: true }).selectOption('changes'); await page.getByLabel('Start date', { exact: true }).fill('2026-01-02'); await page.getByLabel('End date (exclusive)', { exact: true }).fill('2026-01-03');
    await page.getByRole('button', { name: 'Run query', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Query 7 · Device changes', exact: true })).toBeVisible();
    expect(await page.evaluate(async () => { const r = await window.medclaw.request('query.read', { queryId: 7 }); if (!r.ok) throw new Error(r.error.code); return { batchIds: r.data.query.params.batchIds, basedOnQueryId: r.data.query.basedOnQueryId, rows: r.data.query.totalRows }; })).toEqual({ batchIds: [1, 2], basedOnQueryId: null, rows: 1 });
    const facts = readStartupFacts(dataRoot); expect(facts.calls).toBe(0); expect(facts.runs).toBe(7); verified = true;
  } finally {
    await desktop?.close();
    const within = relative(resolve(tmpdir()), resolve(root));
    if (verified && within && !within.startsWith('..') && !within.includes(':') && (!desktop || existsSync(join(root, 'dev-exit-confirmed')))) rmSync(root, { recursive: true, force: true });
    else console.log('P15 unverified acceptance root retained:', root);
  }
});
