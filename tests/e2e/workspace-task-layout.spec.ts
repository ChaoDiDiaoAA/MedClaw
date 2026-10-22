import { expect, test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

let server: ReturnType<typeof createServer>, url: string, app: ElectronApplication;
const test = base.extend<{ page: Page }>({ page: async ({}, use) => use(await app.firstWindow()) });
test.beforeAll(async () => {
  const directory = resolve('.build/workspace-task-layout'); mkdirSync(directory, { recursive: true });
  const require = createRequire(resolve('apps/desktop/package.json')), entry = join(directory, 'fixture.ts'), bundle = join(directory, 'fixture.js');
  writeFileSync(entry, `import React from ${JSON.stringify(require.resolve('react'))};import{createRoot}from ${JSON.stringify(require.resolve('react-dom/client'))};
    import{DataWorkspace}from ${JSON.stringify(resolve('apps/desktop/src/renderer/data-workspace.tsx'))};
    import{QueryHistory}from ${JSON.stringify(resolve('apps/desktop/src/renderer/query-history.tsx'))};
    import{EvaluationPage}from ${JSON.stringify(resolve('apps/desktop/src/renderer/evaluation.tsx'))};
    import ${JSON.stringify(resolve('apps/desktop/src/renderer/styles.css'))};
    const root=createRoot(document.getElementById('root'));const empty={batches:[],page:1,pageSize:50,batchCount:0,deviceCount:0,snapshotCount:0,changeCount:0,catalogRevision:1,referenceDate:null,timezone:null};
    const host={state:'ready',instanceId:'HostA',canStart:false,sdkVersion:null,schemaVersion:null,error:null};
    const workspace={sessionId:1,revision:1,batchRefs:[],deviceIds:[],queryId:null,selection:null,materialVersion:null};
    globalThis.__calls=[];globalThis.__lostImport=false;globalThis.__lostDeletion=false;
    window.medclaw={pickImportDirectory:async()=>({ok:true,data:{fileToken:'directory-token',directoryName:'Original package'}}),request:async(method,input)=>{
      globalThis.__calls.push({method,input});if(method==='import.preview'&&globalThis.__lostImport)throw new Error('ENGINEERING lost reply');
      if(method==='data.delete.preview'&&globalThis.__lostDeletion)throw new Error('ENGINEERING lost deletion reply');
      if(method==='query.list')return{ok:true,data:{items:[],nextBeforeQueryId:null}};
      if(method==='activity.list')return{ok:true,data:{items:[],nextBeforeEventId:null}};
      if(method==='eval.preflight')return{ok:true,data:{datasetId:'medclaw-agent-v1',selection:'smoke',trials:1,cases:10,plannedTrials:10,readiness:'reviewed',judgeRequestLimit:0,platformConfigured:false,config:null,blockers:[]}};
      if(method==='eval.report.list')return{ok:true,data:{items:[],total:0,page:1,pageSize:50}};
      return{ok:true,data:null};}};
    const evaluation={control:{state:'idle',operationKind:null,stopConfirmed:true,saveConfirmed:true,blockReasons:[],progressCounts:{saved:0,planned:0,pass:0,fail:0,unjudgeable:0,error:0,notRun:0}},pending:{run:null,platform:null,feedback:null},error:null,recoveryError:null,refresh:async()=>{},remember:()=>{},confirm:()=>true};
    globalThis.__render=(mode='data',patch={})=>root.render(React.createElement(mode==='data'?DataWorkspace:mode==='query'?QueryHistory:EvaluationPage,
      mode==='data'?{host,workspace,confirmed:true,batches:[],catalog:empty,catalogStatus:{state:'ready',error:null},onRefresh:()=>{},onUpdate:async()=>true,onDeleteCommit:async()=>({ok:true,data:null}),onDeleteResult:async()=>{},onError:()=>{},...patch}:
      mode==='query'?{host,workspace:{...workspace,batchRefs:[{id:1}]},visible:true,requestedQuery:null,confirmed:true,writable:true,active:null,formRun:null,formPending:null,formResendConfirmed:false,formReason:null,onUpdate:async()=>true,onError:()=>{},onSubmitForm:async()=>{},onReadSubmission:async()=>{},onResendSubmission:async()=>{},...patch}:{visible:true,evaluation,productionBlockReason:null,...patch}));
    globalThis.__render();`);
  execFileSync('bun', ['build', entry, '--target=browser', `--outdir=${directory}`], { cwd: resolve('.'), stdio: 'pipe' });
  server = createServer((request, response) => { const css = request.url === '/fixture.css', js = request.url === '/fixture.js'; response.setHeader('content-type', css ? 'text/css' : js ? 'text/javascript' : 'text/html'); response.end(css ? readFileSync(join(directory, 'fixture.css')) : js ? readFileSync(bundle) : '<link rel="stylesheet" href="/fixture.css"><main id="root"></main><script type="module" src="/fixture.js"></script>'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const main = join(directory, 'browser.cjs'); writeFileSync(main, `const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const window=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});window.loadURL(${JSON.stringify(url)});});`);
  const env = Object.fromEntries(Object.entries(process.env).filter((value): value is [string, string] => value[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [main], env });
});
test.afterAll(async () => { await app?.close(); if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } });

test('Data Workspace separates confirmed empty data, loading and unavailable Host', async ({ page }) => {
  await page.goto(url); await expect(page.getByText('No imported data', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose snapshot directory', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recover an operation', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage imported data', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh imported data', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Next message scope', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Preview delete all imported data', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Apply 0 selected batches', exact: true })).toBeHidden();
  await expect(page.locator('body')).not.toContainText('Unknown batches');
  await page.evaluate(() => Reflect.get(globalThis, '__render')('data', { catalog: null, catalogStatus: { state: 'loading', error: null } }));
  await expect(page.getByText('Reading imported data…', { exact: true })).toBeVisible(); await expect(page.getByText('No imported data', { exact: true })).toBeHidden();
  await page.evaluate(() => Reflect.get(globalThis, '__render')('data', { catalog: null, catalogStatus: { state: 'error', error: 'The imported catalog could not be read.' } }));
  await expect(page.getByRole('alert')).toContainText('The imported catalog could not be read.'); await expect(page.getByText('No imported data', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Refresh imported data', exact: true })).toBeEnabled();
  await page.evaluate(() => Reflect.get(globalThis, '__render')('data', { host: { state: 'stopped', instanceId: 'HostA' }, catalog: null }));
  await expect(page.getByText('Imported data is unavailable while Host is not ready.', { exact: true })).toBeVisible();
});

test('previously verified batches stay read-only while their current catalog is unavailable', async ({ page }) => {
  await page.goto(url); await page.evaluate(() => {
    const batch = { id: 7, snapshotDate: '2026-01-01', region: 'Previously verified region', scopeKey: 'fixture', observedEntityCount: 1, expectedEntityCount: 1, declaredMissingDeviceIds: [], materialVersion: 'fixture-v1' };
    const snapshot = { batches: [batch], catalog: { batches: [batch], batchCount: 51, page: 1, pageSize: 50, catalogRevision: 1, deviceCount: 1, snapshotCount: 1, changeCount: 0 } };
    Reflect.set(globalThis, '__previousCatalog', snapshot); Reflect.get(globalThis, '__render')('data', snapshot);
  });
  await page.getByLabel('Select batch 7', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Apply 1 selected batches', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Manage imported data', exact: true }).click();
  for (const state of ['loading', 'error', 'stopped']) {
    await page.evaluate(state => Reflect.get(globalThis, '__render')('data', { ...Reflect.get(globalThis, '__previousCatalog'), host: { state: state === 'stopped' ? 'stopped' : 'ready', instanceId: 'HostA' }, catalogStatus: { state: state === 'stopped' ? 'unread' : state, error: state === 'error' ? 'Catalog refresh failed.' : null } }), state);
    await expect(page.getByRole('cell', { name: 'Previously verified region', exact: true })).toBeVisible();
    await expect(page.getByText('Previously verified imported data is shown read-only. It has not been reconfirmed by the current Host.', { exact: true })).toBeVisible();
    await expect(page.getByText('No imported data', { exact: true })).toBeHidden();
    await expect(page.getByLabel('Select batch 7', { exact: true })).toBeDisabled();
    for (const name of ['Read batch 7 devices', 'Read batch 7 changes', 'Select batches on this page', 'Apply 1 selected batches', 'Next batch page', 'Delete batch 7', 'Preview delete all imported data']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    if (state === 'error') await expect(page.getByRole('alert')).toContainText('Catalog refresh failed.');
  }
  await page.getByRole('button', { name: 'Edit selection', exact: true }).click();
  await expect(page.getByLabel('Selected device IDs', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Apply devices', exact: true })).toBeDisabled();
});

test('unconfirmed import recovery stays visible when secondary tools close', async ({ page }) => {
  await page.goto(url); await page.evaluate(() => Reflect.set(globalThis, '__lostImport', true));
  await page.getByRole('button', { name: 'Choose snapshot directory', exact: true }).click();
  await expect(page.getByText('Waiting for the saved import result. This operation is checked automatically.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recover an operation', exact: true }).click(); await page.getByRole('button', { name: 'Recover an operation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Read original result', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose snapshot directory', exact: true })).toBeDisabled();
});

test('query task navigation keeps its next conditions mounted', async ({ page }) => {
  await page.goto(url); await page.evaluate(() => Reflect.get(globalThis, '__render')('query'));
  await expect(page.getByText('No saved queries yet.', { exact: true })).toBeVisible(); await expect(page.getByLabel('Region', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'New query', exact: true }).click(); await page.getByLabel('Region', { exact: true }).fill('Retained region');
  await page.getByRole('button', { name: 'Back to query history', exact: true }).click();
  await page.getByRole('button', { name: 'New query', exact: true }).click(); await expect(page.getByLabel('Region', { exact: true })).toHaveValue('Retained region');
  expect(await page.evaluate(() => Reflect.get(globalThis, '__calls').filter((item: { method: string }) => item.method === 'query.list').length)).toBe(1);
});

test('an unconfirmed deletion remains reachable after management closes', async ({ page }) => {
  await page.goto(url); await page.evaluate(() => {
    Reflect.set(globalThis, '__lostDeletion', true);
    const batch = { id: 7, snapshotDate: '2026-01-01', region: 'Fixture region', scopeKey: 'fixture', observedEntityCount: 1, expectedEntityCount: 1, declaredMissingDeviceIds: [], materialVersion: 'fixture-v1' };
    Reflect.get(globalThis, '__render')('data', { batches: [batch], catalog: { batches: [batch], batchCount: 1, page: 1, pageSize: 50, catalogRevision: 1, deviceCount: 1, snapshotCount: 1, changeCount: 0 } });
  });
  const manage = page.getByRole('button', { name: 'Manage imported data', exact: true });
  await manage.click(); await page.getByRole('button', { name: 'Delete batch 7', exact: true }).click();
  const warning = page.getByRole('alert').filter({ hasText: 'Deletion result unconfirmed.' }); await expect(warning).toBeVisible();
  await manage.click(); await expect(warning).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read deletion result', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete batch 7', exact: true })).toBeHidden();
});

test('evaluation defaults to reports and opens setup without rerunning checks', async ({ page }) => {
  await page.goto(url); await page.evaluate(() => Reflect.get(globalThis, '__render')('evaluation'));
  await expect(page.getByText('No evaluation reports', { exact: true })).toBeVisible(); await expect(page.getByLabel('Trials per Case', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'New evaluation', exact: true }).click(); await page.getByLabel('Trials per Case', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Back to reports', exact: true }).click(); await page.getByRole('button', { name: 'New evaluation', exact: true }).click();
  await expect(page.getByLabel('Trials per Case', { exact: true })).toHaveValue('2');
  expect(await page.evaluate(() => Reflect.get(globalThis, '__calls').filter((item: { method: string }) => item.method === 'eval.preflight').length)).toBe(1);
  await page.evaluate(() => Reflect.get(globalThis, '__render')('evaluation', { evaluation: { control: null, pending: { run: null, platform: null, feedback: null }, error: 'Evaluation status could not be read.', recoveryError: null, refresh: async () => {}, remember: () => {}, confirm: () => true } }));
  await expect(page.getByRole('alert')).toContainText('Evaluation status could not be read.');
  await expect(page.getByText('Reading evaluation status…', { exact: true })).toBeHidden();
});
