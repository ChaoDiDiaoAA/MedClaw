import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { ModelDirectoryViewSchema } from '../../packages/contracts/src/model';
import { DataCatalogSchema } from '../../packages/contracts/src/data';

// Only the external desktop bridge is substituted. These tests run the actual
// renderer and assert user-visible admission and results, not fixture call counts.
const root = resolve(import.meta.dirname, '../..'), bun = process.env.MEDCLAW_BUN_EXECUTABLE ?? 'bun';
const ready = { instanceId: 'startup-renderer-instance', state: 'ready', canStart: false, sdkVersion: '0.87.1', schemaVersion:15, error: null };
const directory = ModelDirectoryViewSchema.parse({ configVersion: '0', selection: null, customApis: [],
  providers: [{ id: 'offline-provider', name: 'Offline provider', source: 'pi_builtin', loginTypes: ['api_key'],
    auth: { providerId: 'offline-provider', state: 'unavailable', type: null, source: null, checkKind: 'snapshot', checkedAt: '2026-10-04T00:00:00Z' } }],
  models: [{ provider: 'offline-provider', id: 'offline-model', name: 'Offline model', api: 'openai-completions', input: ['text'], reasoning: false,
    contextWindow: 8192, maxTokens: 1024, capabilitySource: 'pi_catalog' }] });
const authenticatedDirectory = ModelDirectoryViewSchema.parse({ ...directory,
  providers: directory.providers.map(provider => ({ ...provider, auth: { ...provider.auth, state: 'available', type: 'api_key', source: 'fixture' } })),
  selection: { provider: 'offline-provider', modelId: 'offline-model', endpointRef: null, api: 'openai-completions', configVersion: '0',
    credentialRef: 'fixture-credential-ref', maxOutputTokens: 1024, capabilitySource: 'pi_catalog', sdkVersion: '0.87.1' } });
const failure = { ok: false, error: { code: 'resource_unavailable', category: 'storage', message: 'The requested resource is temporarily unavailable.', retryable: true } };
const emptyCatalog = DataCatalogSchema.parse({ batches: [], page: 1, pageSize: 50, batchCount: 0, deviceCount: 0, snapshotCount: 0, changeCount: 0, catalogRevision: 0, referenceDate: null, timezone: null });
const importedCatalog = DataCatalogSchema.parse({ ...emptyCatalog, batchCount: 1, catalogRevision: 1, referenceDate: '2026-01-02', timezone: 'Asia/Shanghai', batches: [{ id: 1, scopeKey: 'imported-scope', snapshotDate: '2026-01-02', region: '浙江', coverage: 'full', previousBatchId: null, materialVersion: 'fixture/v1', sourceBundleId: 'fixture', sourceLockHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), cohortHash: 'c'.repeat(64), catalogRevision: 1, expectedEntityCount: 0, observedEntityCount: 0, declaredMissingDeviceIds: [] }] });
type Fixture = { deletionReadResult?:unknown;deletionLost?:boolean;bridge?: 'missing' | 'subscribe_throw' | 'request_reject'; host?: typeof ready; modelResult?: unknown; catalogResult?: unknown; restoredSession?: boolean; hostReadResult?: unknown; hostReadReject?: boolean; holds?: string[] };
type State = { modelResult: unknown; catalogResult: unknown; pending: Record<string, () => void>; entered: string[]; completed: string[]; holds: string[]; host: typeof ready };
type MainGlobal = typeof globalThis & { __startupRenderer: State };
let temporary: string, app: ElectronApplication | undefined, page: Page;

test.describe.configure({ mode: 'default' });
test.beforeAll(() => {
  temporary = mkdtempSync(join(tmpdir(), 'medclaw-startup-renderer-'));
  execFileSync(bun, ['build', 'apps/desktop/src/renderer/index.html', '--target=browser', `--outdir=${join(temporary, 'renderer')}`], { cwd: root });
});
test.afterEach(async () => { await app?.close(); app = undefined; });
test.afterAll(() => { if (temporary) { const path = resolve(temporary), within = relative(resolve(tmpdir()), path); if (within && !within.startsWith('..') && !within.includes(':')) rmSync(path, { recursive: true, force: true }); } });

async function launch(config: Fixture = {}) {
  const local = join(temporary, String(Date.now())); mkdirSync(local);
  const preload = join(local, 'preload.cjs'), main = join(local, 'main.cjs');
  writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
    const config=${JSON.stringify(config)};
    if(config.bridge!=='missing')contextBridge.exposeInMainWorld('medclaw',{
      request:(method,payload,operationRef)=>config.bridge==='request_reject'?Promise.reject(new Error('private bridge error')):ipcRenderer.invoke('test:request',{method,payload,operationRef}),
      subscribe:(listener)=>{if(config.bridge==='subscribe_throw')throw new Error('private subscription error');const handle=(_,notice)=>listener(notice);ipcRenderer.on('test:notice',handle);return()=>ipcRenderer.removeListener('test:notice',handle);},
      discardSecret:async()=>{},secretInput:async()=>({ok:false,error:${JSON.stringify(failure.error)}}),openAuthLink:async()=>({ok:true,data:null}),pickImportDirectory:async()=>({ok:true,data:null})});`);
  writeFileSync(main, `const {app,BrowserWindow,ipcMain}=require('electron');
    const state=globalThis.__startupRenderer={modelResult:${JSON.stringify(config.modelResult ?? { ok: true, data: directory })},catalogResult:${JSON.stringify(config.catalogResult ?? { ok: true, data: emptyCatalog })},host:${JSON.stringify(config.host ?? ready)},holds:${JSON.stringify(config.holds ?? [])},pending:{},entered:[],completed:[]};
    const session=id=>({id,title:'New Session '+id,nativeSessionId:'native-'+id,kind:'user',status:'active',metadataRevision:0,deletedAt:null,inputControl:null,storageVersion:0,leafId:null,nextSubmissionSequence:1});
    const sessions=${config.restoredSession ? '[session(1)]' : '[]'},inputs=[];let workspace={revision:${config.restoredSession ? '1' : '0'},sessionId:${config.restoredSession ? '1' : 'null'},materialVersion:null,batchRefs:[],deviceIds:[],queryId:null,activeView:'data',selection:null};
    let deletion=null;const ok=data=>({ok:true,data});const failed=${JSON.stringify(failure)};
    ipcMain.handle('test:request',async(_, {method,payload})=>{
      const frozenWorkspace=structuredClone(workspace),rowResult=state.catalogResult.data?.batches?.some(batch=>batch.id===payload.batchId)?ok({kind:payload.kind,items:[],selections:[],totalRows:0,page:1,pageSize:50}):failed;
      const hostReadResult=${JSON.stringify(config.hostReadResult ?? null)}??ok(structuredClone(state.host));
      if(state.holds.includes(method)){if(method==='data.rows')state.holds=state.holds.filter(value=>value!==method);state.entered.push(method);await new Promise(resolve=>state.pending[method]=resolve);delete state.pending[method];}
      state.completed.push(method);
      if(method==='host.read'){if(${JSON.stringify(config.hostReadReject ?? false)})throw new Error('private late host error');return hostReadResult;}
      if(method==='settings.ui.read')return ok({configVersion:'0',ui:{navCollapsed:false,detailOpen:false,detailTab:'conditions'}});
      if(method==='model.read')return state.modelResult;
      if(method==='model.custom.read')return ok({definitions:[]});
      if(method==='data.read')return state.catalogResult;
      if(method==='data.delete.preview'){deletion={operationRef:payload.operationRef,state:'ready',preview:{operationRef:payload.operationRef,previewHash:'a'.repeat(64),catalogRevision:payload.expectedCatalogRevision,workspaceRevision:payload.expectedWorkspaceRevision,batches:[{id:1,snapshotDate:'2026-01-02'}],snapshotCount:0,changeCount:0,deviceCount:0,queryCount:0,workspaceWillChange:false,files:[]},receipt:null,cleanup:{state:'pending',remainingCount:0,error:null},updatedAt:'2026-10-04T00:00:00Z'};return ok(deletion);}
      if(method==='data.delete.commit'){deletion={...deletion,state:'committed',receipt:{operationRef:payload.operationRef,batchIds:[1],snapshotCount:0,changeCount:0,deviceCount:0,catalogRevision:2,workspace,committedAt:'2026-10-04T00:00:00Z'},cleanup:{state:'complete',remainingCount:0,error:null}};state.catalogResult=ok({...state.catalogResult.data,batches:[],batchCount:0,catalogRevision:2});return ${JSON.stringify(config.deletionLost??false)}?{ok:false,error:{code:'operation_result_unknown',category:'storage',message:'The result is unconfirmed.',retryable:false}}:ok(deletion);}
      if(method==='data.rows')return rowResult;
      if(method==='data.delete.read')return ${JSON.stringify(config.deletionReadResult)}??ok(deletion);
      if(method==='run.control.read')return ok({instanceId:state.host.instanceId,activeRootRun:null,acceptingNewRuns:true,blockReasons:[]});
      if(method==='run.active')return ok(null);
      if(method==='run.read')return ok(payload.runId?{kind:'one',run:null}:{kind:'recent',runs:[],nextBeforeRunId:null});
      if(method==='workspace.restore'||method==='workspace.read')return ok(workspace);
      if(method==='session.list')return ok({sessions,nextBeforeSessionId:null});
      if(method==='session.create'){const id=sessions.length+1,value=session(id);sessions.push(value);workspace={...workspace,sessionId:id,revision:workspace.revision+1};return ok({session:value,workspace});}
      if(method==='session.select'){workspace={...workspace,sessionId:payload.sessionId,revision:workspace.revision+1};return ok(workspace);}
      if(method==='session.read')return ok({session:sessions.find(s=>s.id===payload.sessionId),runningRunId:null,runtime:{availability:'ready',error:null},history:{available:true,reason:null,messages:[],truncated:false}});
      if(method==='session.messages.read')return ok({sessionId:payload.sessionId,nativeSessionId:'native-'+payload.sessionId,leafId:null,source:'native_memory',items:[],nextEntryId:null,hasMore:false});
      if(method==='session.listInputs')return ok({sessionId:payload.sessionId,items:inputs.filter(input=>input.sessionId===payload.sessionId),nextClientSequence:null,hasMore:false});
      if(method==='session.submit'){const id=inputs.length+1;inputs.push({id,sessionId:payload.sessionId,clientSequence:payload.clientSequence,mode:payload.mode,text:payload.text,textInfo:{totalChars:payload.text.length,truncated:false},workspaceContext:frozenWorkspace,status:'queued',processingStatus:'pending',targetRunId:7,runId:null,nativeEntryId:null,deliveredAt:null,processedAt:null,createdAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-04T00:00:00Z',error:null});return ok({sessionId:payload.sessionId,clientSequence:payload.clientSequence,inputId:id,runId:7});}
      if(method==='session.readInput')return ok(inputs.find(input=>input.id===payload.inputId)??null);
      return failed;
    });
    app.whenReady().then(()=>{const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:true,nodeIntegration:false}});window.loadFile(${JSON.stringify(join(temporary, 'renderer/index.html'))});});`);
  const require = createRequire(join(root, 'apps/desktop/package.json')), executablePath: string = require('electron');
  const playwright = createRequire(require.resolve('@playwright/test/package.json')), core = createRequire(playwright.resolve('playwright/package.json')).resolve('playwright-core/package.json');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])); delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath, args: ['-r', join(dirname(core), 'lib/server/electron/loader.js'), main], env, timeout: 30000 });
  page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByRole('heading', { name: /Chat|Desktop startup failed/, exact: true })).toBeVisible();
}
async function release(method: string) { await app!.evaluate((_, method) => { const state = (globalThis as MainGlobal).__startupRenderer; state.holds = state.holds.filter(value => value !== method); state.pending[method]?.(); }, method); }
async function models() { await page.getByRole('button', { name: 'Models', exact: true }).click(); }
async function setDirectory(value: unknown) { await app!.evaluate((_, value) => { (globalThis as MainGlobal).__startupRenderer.modelResult = value; }, value); }

test('S07 cold empty Session never displays a submission in progress', async () => {
  await launch();
  await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Submitting…', exact: true })).toHaveCount(0);
  await expect(page.locator('.composer').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
});

test('S05 directory loading has its own visible state', async () => {
  await launch({ holds: ['model.read'] }); await models();
  await expect(page.getByRole('status').filter({ hasText: 'Reading model directory…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled();
  await release('model.read'); await expect(page.getByLabel('Provider', { exact: true }).locator('option')).toHaveCount(2);
});

test('S05 failed first directory read is an error, not an unread or empty directory', async () => {
  await launch({ modelResult: failure }); await models();
  await expect(page.getByRole('status').filter({ hasText: 'Model directory read failed.' })).toBeVisible();
  await expect(page.getByText('The directory has not been read. Reload it when Host is ready.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No models in the current directory', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled();
});

test('S06 slow catalog read does not prevent first Workspace confirmation or New Session', async () => {
  await launch({ holds: ['data.read'] });
  await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  await expect(page.getByTestId('current-session')).toContainText('New Session 1');
  await release('data.read');
});

for (const bridge of ['missing', 'subscribe_throw', 'request_reject'] as const) {
  test(`S04 ${bridge} desktop bridge shows explicit startup failure`, async () => {
    await launch({ bridge });
    await expect(page.getByRole('heading', { name: 'Desktop startup failed', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Restart the desktop application');
    await expect(page.getByText('Host ready', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Submitting…', exact: true })).toHaveCount(0);
    await expect(page.getByText('private bridge error', { exact: true })).toHaveCount(0);
  });
}

test('S05 retained directory stays browseable and explicitly stale after reload failure', async () => {
  await launch(); await models(); await expect(page.getByRole('button', { name: 'Select Offline model', exact: true })).toBeVisible();
  await setDirectory(failure); await page.getByRole('button', { name: 'Reload published directory', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Model directory read failed.' })).toBeVisible();
  await expect(page.getByText(/last readable result is retained/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select Offline model', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set as default model', exact: true })).toBeDisabled();
});

test('S05 healthy empty directory differs from a filtered search with no matches', async () => {
  await launch(); await models();
  await page.getByLabel('Search models', { exact: true }).fill('no matching model');
  await expect(page.getByText('No models match your search', { exact: true })).toBeVisible();
  await setDirectory({ ok: true, data: { ...directory, models: [], providers: [] } });
  await page.getByRole('button', { name: 'Reload published directory', exact: true }).click();
  await expect(page.getByText('No models in the current directory', { exact: true })).toBeVisible();
});

test('S06 unauthenticated Provider is browseable but cannot become a Send candidate', async () => {
  await launch(); await models();
  await expect(page.getByLabel('Provider', { exact: true }).locator('option')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Select Offline model', exact: true })).toBeVisible();
  await page.getByLabel('Provider', { exact: true }).selectOption('offline-provider');
  await expect(page.getByRole('button', { name: 'Sign in with API Key', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  await expect(page.getByTestId('current-session')).toContainText('New Session 1');
  await expect(page.getByLabel('Session model', { exact: true }).locator('option')).toHaveCount(1);
  await expect(page.locator('.composer').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
});

test('S07 actual pending submission belongs to its Session and settles without clearing another draft', async () => {
  await launch({ modelResult: { ok: true, data: authenticatedDirectory }, holds: ['session.submit'] });
  const create = async (id: number) => { await page.getByRole('button', { name: 'New Session', exact: true }).click(); await expect(page.getByTestId('current-session')).toContainText(`New Session ${id}`); };
  const select = async (id: number) => { await page.getByRole('button', { name: `New Session ${id}`, exact: true }).click(); await expect(page.getByTestId('current-session')).toContainText(`New Session ${id}`); };
  await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled();
  await create(1); await create(2);
  await page.getByLabel('Message text', { exact: true }).fill('Unrelated Session 2 draft');
  await select(1); await page.getByLabel('Message text', { exact: true }).fill('Original Session 1 submission');
  await page.locator('.composer').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.composer').getByRole('button', { name: 'Submitting…', exact: true })).toBeDisabled();
  await select(2);
  await expect(page.getByLabel('Message text', { exact: true })).toHaveValue('Unrelated Session 2 draft');
  await expect(page.locator('.composer').getByRole('button', { name: 'Submitting…', exact: true })).toHaveCount(0);
  await select(1);
  await expect(page.locator('.composer').getByRole('button', { name: 'Submitting…', exact: true })).toBeVisible();
  await release('session.submit');
  await expect(page.locator('.composer').getByRole('button', { name: 'Submitting…', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Message text', { exact: true })).toHaveValue('');
  await expect(page.getByTestId('input-queue')).toHaveCount(0);
  await expect.poll(()=>page.evaluate(async()=>{const w=await window.medclaw.request('workspace.read',{});if(!w.ok||!w.data.sessionId)return '';const inputs=await window.medclaw.request('session.listInputs',{sessionId:w.data.sessionId});return inputs.ok?inputs.data.items.map(item=>item.text).join(' '):'';})).toContain('Original Session 1 submission');
  await select(2); await expect(page.getByLabel('Message text', { exact: true })).toHaveValue('Unrelated Session 2 draft');
});

async function timeContext() { await page.getByText('Message time context', { exact: true }).click(); }
test('S06 restored Session waits for slow catalog common metadata rather than using local today', async () => {
  await launch({ restoredSession: true, catalogResult: { ok: true, data: importedCatalog }, holds: ['data.read'] });
  await expect(page.getByTestId('current-session')).toContainText('New Session 1'); await timeContext();
  await release('data.read');
  await expect(page.getByLabel('Reference date', { exact: true })).toHaveValue('2026-01-02');
  await expect(page.getByLabel('Time zone', { exact: true })).toHaveValue('Asia/Shanghai');
});

test('S06 conflicting catalog defaults keep both time fields empty and Send blocked', async () => {
  await launch({ restoredSession: true, modelResult: { ok: true, data: authenticatedDirectory }, catalogResult: { ok: true, data: { ...importedCatalog, referenceDate: null, timezone: null } }, holds: ['data.read'] });
  await expect(page.getByTestId('current-session')).toContainText('New Session 1'); await timeContext();
  await release('data.read');
  await expect(page.getByTestId('data-time-defaults-missing')).toBeVisible();
  await expect(page.getByLabel('Reference date', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Time zone', { exact: true })).toHaveValue('');
  await page.getByLabel('Message text', { exact: true }).fill('Needs explicit date and time zone');
  await expect(page.locator('.composer').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByLabel('Reference date', { exact: true }).fill('2026-01-02');
  await page.getByLabel('Time zone', { exact: true }).fill('   ');
  await expect(page.locator('.composer').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByLabel('Time zone', { exact: true }).fill('UTC');
  await expect(page.locator('.composer').getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

test('S06 manual date entered while catalog is pending survives while untouched timezone initializes', async () => {
  await launch({ restoredSession: true, catalogResult: { ok: true, data: { ...importedCatalog, timezone: 'America/New_York' } }, holds: ['data.read'] });
  await expect(page.getByTestId('current-session')).toContainText('New Session 1'); await timeContext();
  await page.getByLabel('Reference date', { exact: true }).fill('2025-12-31');
  await release('data.read');
  await expect(page.getByLabel('Reference date', { exact: true })).toHaveValue('2025-12-31');
  await expect(page.getByLabel('Time zone', { exact: true })).toHaveValue('America/New_York');
  await page.getByLabel('Time zone', { exact: true }).fill('UTC');
  await app!.evaluate((_, catalog) => { (globalThis as MainGlobal).__startupRenderer.catalogResult = { ok: true, data: catalog }; }, { ...importedCatalog, referenceDate: '2026-02-02', timezone: 'Asia/Tokyo' });
  await models(); await page.getByRole('button', { name: 'Reload published directory', exact: true }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByLabel('Reference date', { exact: true })).toHaveValue('2025-12-31');
  await expect(page.getByLabel('Time zone', { exact: true })).toHaveValue('UTC');
});

for (const scenario of ['stopped', 'same_instance_handshaking', 'failed_result', 'rejected_request'] as const) {
  test(`S04 late initial Host read ${scenario} cannot overwrite a newer ready notice`, async () => {
    const hostReadResult = scenario === 'failed_result' ? failure : { ok: true, data: scenario === 'stopped' ? { ...ready, instanceId: null, state: 'stopped', canStart: true } : { ...ready, state: 'handshaking' } };
    await launch({ holds: ['host.read'], hostReadResult, hostReadReject: scenario === 'rejected_request' });
    await expect.poll(() => app!.evaluate(() => (globalThis as MainGlobal).__startupRenderer.entered.includes('host.read'))).toBe(true);
    await app!.evaluate(({ BrowserWindow }, host) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('test:notice', { type: 'host.status', host, instanceId: host.instanceId }); }, ready);
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled();
    await release('host.read');
    await expect.poll(() => app!.evaluate(() => (globalThis as MainGlobal).__startupRenderer.completed.includes('host.read'))).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'Desktop startup failed', exact: true })).toHaveCount(0);
  });
}

test('B03 deletion lost reply blocks new writes until original committed receipt and current facts are read',async()=>{
 await launch({restoredSession:true,modelResult:{ok:true,data:authenticatedDirectory},catalogResult:{ok:true,data:importedCatalog},deletionLost:true});
 await page.getByLabel('Message text',{exact:true}).fill('Keep my draft');await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Delete batch 1',exact:true}).click();await page.getByRole('button',{name:'Confirm permanent deletion',exact:true}).click();
 await expect(page.getByText('Deletion result unconfirmed. Read this operation before another deletion.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'New Session',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Preview delete all imported data',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Chat',exact:true}).click();await expect(page.getByLabel('Message text',{exact:true})).toHaveValue('Keep my draft');await expect(page.locator('.composer').getByRole('button',{name:'Send',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Read deletion result',exact:true}).click();await expect(page.getByTestId('deletion-result')).toContainText('Data deleted');await expect(page.getByRole('button',{name:'New Session',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Chat',exact:true}).click();await expect(page.getByLabel('Message text',{exact:true})).toHaveValue('Keep my draft');await expect(page.locator('.composer').getByRole('button',{name:'Send',exact:true})).toBeEnabled();
 const completed=await app!.evaluate(()=>(globalThis as MainGlobal).__startupRenderer.completed);expect(completed.filter(method=>method==='data.delete.commit')).toHaveLength(1);expect(completed.filter(method=>method==='session.submit')).toHaveLength(0);
});

for(const [name,result]of [['null',{ok:true,data:null}],['failed',failure]] as const)test('B03 '+name+' deletion lookup does not unlock an unconfirmed write',async()=>{
 await launch({restoredSession:true,catalogResult:{ok:true,data:importedCatalog},deletionLost:true,deletionReadResult:result});await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Delete batch 1',exact:true}).click();await page.getByRole('button',{name:'Confirm permanent deletion',exact:true}).click();await page.getByRole('button',{name:'Read deletion result',exact:true}).click();
 await expect(page.getByRole('button',{name:'New Session',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Preview delete all imported data',exact:true})).toBeDisabled();await expect(page.getByText('Deletion result unconfirmed. Read this operation before another deletion.',{exact:true})).toBeVisible();
});

test('B03 a delayed deletion lookup from an old Host cannot replace the new confirmed display',async()=>{
 await launch({catalogResult:{ok:true,data:importedCatalog},holds:['data.delete.read'],deletionReadResult:failure});await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByLabel('Deletion operation ID',{exact:true}).fill('old-operation');await page.getByRole('button',{name:'Read deletion result',exact:true}).click();
 await expect.poll(()=>app!.evaluate(()=>(globalThis as MainGlobal).__startupRenderer.entered.includes('data.delete.read'))).toBe(true);
 await app!.evaluate(({BrowserWindow},host)=>{const state=(globalThis as MainGlobal).__startupRenderer;state.host=host;for(const window of BrowserWindow.getAllWindows())window.webContents.send('test:notice',{type:'host.status',host,instanceId:host.instanceId});},{...ready,instanceId:'replacement-host'});
 await expect(page.getByRole('button',{name:'New Session',exact:true})).toBeEnabled();await release('data.delete.read');await expect.poll(()=>app!.evaluate(()=>(globalThis as MainGlobal).__startupRenderer.completed.includes('data.delete.read'))).toBe(true);
 await expect(page.getByText('Deletion result unconfirmed. Read this operation before another deletion.',{exact:true})).toHaveCount(0);await expect(page.getByText(failure.error.message,{exact:true})).toHaveCount(0);
});

test('B03 a pre-deletion row reply cannot repopulate the current data view after catalog changes',async()=>{
 await launch({catalogResult:{ok:true,data:importedCatalog},holds:['data.rows']});await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Read batch 1 devices',exact:true}).click();await expect.poll(()=>app!.evaluate(()=>(globalThis as MainGlobal).__startupRenderer.entered.includes('data.rows'))).toBe(true);
 await page.getByRole('button',{name:'Delete batch 1',exact:true}).click();await page.getByRole('button',{name:'Confirm permanent deletion',exact:true}).click();await expect(page.getByTestId('deletion-result')).toContainText('Data deleted');await release('data.rows');await expect.poll(()=>app!.evaluate(()=>(globalThis as MainGlobal).__startupRenderer.completed.filter(method=>method==='data.rows').length)).toBe(2);
 await expect(page.getByText('0 rows · Page 1',{exact:true})).toHaveCount(0);await expect(page.getByTestId('data-rows')).toHaveCount(0);
});
