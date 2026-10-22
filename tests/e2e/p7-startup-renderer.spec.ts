import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { ModelDirectoryViewSchema, DEFAULT_REQUEST_POLICY, DEFAULT_AGENT_POLICY,type HostView } from '../../packages/contracts/src/model';
import {safeError} from '../../packages/contracts/src/error';
import { publicMethodSchemas } from '../../packages/contracts/src/protocol';
import { DataCatalogSchema } from '../../packages/contracts/src/data';
import { SessionMessageViewSchema, type SessionMessageView } from '../../packages/contracts/src/messages';
import { electronTestWindowArgs } from '../fixtures/desktop-dev';
import {createResourceSource} from '../../packages/runtime-pi/src/resource-loader';
import {getSkillReadiness,type ResourceList} from '../../packages/contracts/src/resources';
import {evaluationMethodSchemas} from '../../packages/contracts/src/evaluation';

// Only the external desktop bridge is substituted. These tests run the actual
// renderer and assert user-visible admission and results, not fixture call counts.
const root = resolve(import.meta.dirname, '../..'), bun = process.env.MEDCLAW_BUN_EXECUTABLE ?? 'bun';
const ready:HostView = { instanceId: 'startup-renderer-instance', state: 'ready', canStart: false, sdkVersion: '0.87.1', schemaVersion:17, error: null };
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
const modelConfiguration = publicMethodSchemas['model.config.read'].output.parse({ configVersion: '0', policy: DEFAULT_REQUEST_POLICY, agentPolicy: DEFAULT_AGENT_POLICY, intentModel: null, previousConfigVersion: null, rollbackFromVersion: null });
const emptyCatalog = DataCatalogSchema.parse({ batches: [], page: 1, pageSize: 50, batchCount: 0, deviceCount: 0, snapshotCount: 0, changeCount: 0, catalogRevision: 0, referenceDate: null, timezone: null });
const importedCatalog = DataCatalogSchema.parse({ ...emptyCatalog, batchCount: 1, catalogRevision: 1, referenceDate: '2026-01-02', timezone: 'Asia/Shanghai', batches: [{ id: 1, scopeKey: 'imported-scope', snapshotDate: '2026-01-02', region: '浙江', coverage: 'full', previousBatchId: null, materialVersion: 'fixture/v1', sourceBundleId: 'fixture', catalogRevision: 1, expectedEntityCount: 0, observedEntityCount: 0, declaredMissingDeviceIds: [] }] });
type Fixture = { deletionReadResult?:unknown;deletionLost?:boolean;bridge?: 'missing' | 'subscribe_throw' | 'request_reject'; host?: typeof ready; modelResult?: unknown; catalogResult?: unknown; sessionCreateResult?: unknown; restoredSession?: boolean; hostReadResult?: unknown; hostReadReject?: boolean; holds?: string[]; viewport?: { width: number; height: number }; sessionTitle?: string; messages?: SessionMessageView[] };
type State = { modelResult: unknown; catalogResult: unknown; pending: Record<string, () => void>; entered: string[]; completed: string[]; holds: string[]; host: typeof ready };
type MainGlobal = typeof globalThis & { __startupRenderer: State };
let temporary: string, app: ElectronApplication | undefined, page: Page;
let resourceItems:ResourceList['items'];
const extensionManifest=JSON.parse(readFileSync(join(root,'resources/extensions/tool-audit/v1/manifest.json'),'utf8'));
const extensionCatalog=publicMethodSchemas['extensions.catalog.read'].output.parse({available:{ref:{id:extensionManifest.id,version:extensionManifest.version},source:'first_party',sdkVersion:extensionManifest.sdkVersion,entry:extensionManifest.entry,hooks:extensionManifest.hooks,tools:extensionManifest.tools,commands:extensionManifest.commands},diagnostics:[]});
const idleEvaluation=evaluationMethodSchemas['eval.status'].output.parse({controllerInstanceId:'00000000-0000-4000-8000-000000000016',operationKind:null,operationRef:null,executionId:null,state:'idle',sequence:0,currentTrial:null,stopConfirmed:true,saveConfirmed:true,controllerExited:true,progress:null,progressCounts:{saved:0,planned:0,pass:0,fail:0,unjudgeable:0,error:0,notRun:0},blockReasons:[],result:null,error:null});
const evaluationPreflight=evaluationMethodSchemas['eval.preflight'].output.parse({preflightId:'00000000-0000-4000-8000-000000000017',datasetId:'medclaw-agent-v1',selection:'smoke',trials:1,cases:10,plannedTrials:10,readiness:'reviewed',judgeRequestLimit:0,platformConfigured:false,config:null,blockers:[]});
const emptyEvaluationReports=evaluationMethodSchemas['eval.report.list'].output.parse({items:[],total:0,page:1,pageSize:50});

test.describe.configure({ mode: 'default' });
test.beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'medclaw-startup-renderer-'));
  resourceItems=(await createResourceSource(join(root,'resources')).discover()).items.map(item=>({...item,readiness:getSkillReadiness(item.requiredTools,['read','read_data_scope','query_current_devices'],'configuration')}));
  execFileSync(bun, ['build', 'apps/desktop/src/renderer/index.html', '--target=browser', `--outdir=${join(temporary, 'renderer')}`], { cwd: root });
});
test.afterEach(async () => { await app?.close(); app = undefined; });
test.afterAll(() => { if (temporary) { const path = resolve(temporary), within = relative(resolve(tmpdir()), path); if (within && !within.startsWith('..') && !within.includes(':')) rmSync(path, { recursive: true, force: true }); } });

async function launch(config: Fixture = {}) {
  const local = join(temporary, String(Date.now())); mkdirSync(local); mkdirSync(join(local, 'profile'));
  const preload = join(local, 'preload.cjs'), main = join(local, 'main.cjs');
  writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
    const config=${JSON.stringify(config)};
    if(config.bridge!=='missing')contextBridge.exposeInMainWorld('medclaw',{
      request:(method,payload,operationRef)=>config.bridge==='request_reject'?Promise.reject(new Error('private bridge error')):ipcRenderer.invoke('test:request',{method,payload,operationRef}),
      subscribe:(listener)=>{if(config.bridge==='subscribe_throw')throw new Error('private subscription error');const handle=(_,notice)=>listener(notice);ipcRenderer.on('test:notice',handle);return()=>ipcRenderer.removeListener('test:notice',handle);},
      discardSecret:async()=>{},secretInput:async()=>({ok:false,error:${JSON.stringify(failure.error)}}),openAuthLink:async()=>({ok:true,data:null}),pickImportDirectory:async()=>({ok:true,data:null})});`);
  writeFileSync(main, `const {app,BrowserWindow,ipcMain}=require('electron');
    app.setPath('userData',${JSON.stringify(join(local, 'profile'))});
    const state=globalThis.__startupRenderer={modelResult:${JSON.stringify(config.modelResult ?? { ok: true, data: directory })},catalogResult:${JSON.stringify(config.catalogResult ?? { ok: true, data: emptyCatalog })},host:${JSON.stringify(config.host ?? ready)},holds:${JSON.stringify(config.holds ?? [])},pending:{},entered:[],completed:[]};
    const session=id=>({id,title:${JSON.stringify(config.sessionTitle ?? null)}??'New Session '+id,nativeSessionId:'native-'+id,kind:'user',status:'active',metadataRevision:0,deletedAt:null,inputControl:null,storageVersion:0,leafId:null,nextSubmissionSequence:1});
    const sessions=${config.restoredSession ? '[session(1)]' : '[]'},inputs=[];let workspace={revision:${config.restoredSession ? '1' : '0'},sessionId:${config.restoredSession ? '1' : 'null'},materialVersion:null,batchRefs:[],deviceIds:[],queryId:null,activeView:'data',selection:null};
    let deletion=null,ui={navCollapsed:false,detailOpen:false,detailTab:'conditions'},uiVersion=0;const ok=data=>({ok:true,data});const failed=${JSON.stringify(failure)};
    ipcMain.handle('test:request',async(_, {method,payload})=>{
      const frozenWorkspace=structuredClone(workspace),rowResult=state.catalogResult.data?.batches?.some(batch=>batch.id===payload.batchId)?ok({kind:payload.kind,items:[],selections:[],totalRows:0,page:1,pageSize:50}):failed;
      const hostReadResult=${JSON.stringify(config.hostReadResult ?? null)}??ok(structuredClone(state.host));
      if(state.holds.includes(method)){if(method==='data.rows')state.holds=state.holds.filter(value=>value!==method);state.entered.push(method);await new Promise(resolve=>state.pending[method]=resolve);delete state.pending[method];}
      state.completed.push(method);
      if(method==='host.read'){if(${JSON.stringify(config.hostReadReject ?? false)})throw new Error('private late host error');return hostReadResult;}
      if(method==='settings.ui.read')return ok({configVersion:String(uiVersion),ui});
      if(method==='settings.ui.update'){ui={...ui,...payload.patch};return ok({configVersion:String(++uiVersion),ui});}
      if(method==='model.read')return state.modelResult;
      if(method==='model.config.read')return ok({...${JSON.stringify(modelConfiguration)},configVersion:state.modelResult.data?.configVersion??'0'});
      if(method==='model.custom.read')return ok({definitions:[]});
      if(method==='resources.catalog.read')return ok({configVersion:'0',items:${JSON.stringify(resourceItems.map(({enabled,...item})=>item))},diagnostics:[],catalogError:null});
      if(method==='resources.list')return ok({source:payload.source,sessionId:payload.sessionId,configVersion:'0',selection:{prompt:null,skills:[]},items:${JSON.stringify(resourceItems)},diagnostics:[],catalogError:null,evidence:[],evidenceInfo:{page:1,pageSize:50,totalRows:0,hasMore:false}});
      if(method==='extensions.catalog.read')return ok(${JSON.stringify(extensionCatalog)});
      if(method==='extensions.read')return ok({source:'selection',sessionId:payload.sessionId,configVersion:'0',selection:{extension:null},available:${JSON.stringify(extensionCatalog.available)},diagnostics:[],live:null});
      if(method==='activity.list')return ok(${JSON.stringify(publicMethodSchemas['activity.list'].output.parse({items:[],nextBeforeEventId:null}))});
      if(method==='query.list')return ok({items:[],page:1,pageSize:50,totalRows:0,hasMore:false});
      if(method==='data.read')return state.catalogResult;
      if(method==='data.delete.preview'){deletion={operationRef:payload.operationRef,state:'ready',preview:{operationRef:payload.operationRef,catalogRevision:payload.expectedCatalogRevision,workspaceRevision:payload.expectedWorkspaceRevision,batches:[{id:1,snapshotDate:'2026-01-02'}],snapshotCount:0,changeCount:0,deviceCount:0,queryCount:0,workspaceWillChange:false,files:[]},receipt:null,cleanup:{state:'pending',remainingCount:0,error:null},updatedAt:'2026-10-04T00:00:00Z'};return ok(deletion);}
      if(method==='data.delete.commit'){deletion={...deletion,state:'committed',receipt:{operationRef:payload.operationRef,batchIds:[1],snapshotCount:0,changeCount:0,deviceCount:0,catalogRevision:2,workspace,committedAt:'2026-10-04T00:00:00Z'},cleanup:{state:'complete',remainingCount:0,error:null}};state.catalogResult=ok({...state.catalogResult.data,batches:[],batchCount:0,catalogRevision:2});return ${JSON.stringify(config.deletionLost??false)}?{ok:false,error:{code:'operation_result_unknown',category:'storage',message:'The result is unconfirmed.',retryable:false}}:ok(deletion);}
      if(method==='data.rows')return rowResult;
      if(method==='data.delete.read')return ${JSON.stringify(config.deletionReadResult)}??ok(deletion);
      if(method==='eval.status')return ok(${JSON.stringify(idleEvaluation)});
      if(method==='eval.preflight')return ok(${JSON.stringify(evaluationPreflight)});
      if(method==='eval.report.list')return ok(${JSON.stringify(emptyEvaluationReports)});
      if(method==='run.control.read')return ok({instanceId:state.host.instanceId,activeRootRun:null,acceptingNewRuns:true,blockReasons:[]});
      if(method==='run.active')return ok(null);
      if(method==='run.read')return ok(payload.runId?{kind:'one',run:null}:{kind:'recent',runs:[],nextBeforeRunId:null});
      if(method==='workspace.restore'||method==='workspace.read')return ok(workspace);
      if(method==='session.list')return ok({sessions,nextBeforeSessionId:null});
      if(method==='session.create'){if(${JSON.stringify(config.sessionCreateResult !== undefined)})return ${JSON.stringify(config.sessionCreateResult ?? null)};const id=sessions.length+1,value=session(id);sessions.push(value);workspace={...workspace,sessionId:id,revision:workspace.revision+1};return ok({session:value,workspace});}
      if(method==='session.select'){workspace={...workspace,sessionId:payload.sessionId,revision:workspace.revision+1};return ok(workspace);}
      if(method==='session.read')return ok({session:sessions.find(s=>s.id===payload.sessionId),runningRunId:null,runtime:{availability:'ready',error:null},history:{available:true,reason:null,messages:[],truncated:false}});
      if(method==='session.messages.read')return ok({sessionId:payload.sessionId,nativeSessionId:'native-'+payload.sessionId,leafId:null,source:'native_memory',items:${JSON.stringify(config.messages ?? [])},nextEntryId:null,hasMore:false});
      if(method==='session.listInputs')return ok({sessionId:payload.sessionId,items:inputs.filter(input=>input.sessionId===payload.sessionId),nextClientSequence:null,hasMore:false});
      if(method==='session.submit'){const id=inputs.length+1;inputs.push({id,sessionId:payload.sessionId,clientSequence:payload.clientSequence,mode:payload.mode,text:payload.text,textInfo:{totalChars:payload.text.length,truncated:false},workspaceContext:frozenWorkspace,status:'queued',processingStatus:'pending',targetRunId:7,runId:null,nativeEntryId:null,deliveredAt:null,processedAt:null,createdAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-04T00:00:00Z',error:null});return ok({sessionId:payload.sessionId,clientSequence:payload.clientSequence,inputId:id,runId:7});}
      if(method==='session.readInput')return ok(inputs.find(input=>input.id===payload.inputId)??null);
      return failed;
    });
    app.whenReady().then(()=>{const window=new BrowserWindow({show:false,width:${config.viewport?.width ?? 1440},height:${config.viewport?.height ?? 1000},webPreferences:{backgroundThrottling:false,preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:true,nodeIntegration:false}});window.loadFile(${JSON.stringify(join(temporary, 'renderer/index.html'))});});`);
  const require = createRequire(join(root, 'apps/desktop/package.json')), executablePath: string = require('electron');
  const playwright = createRequire(require.resolve('@playwright/test/package.json')), core = createRequire(playwright.resolve('playwright/package.json')).resolve('playwright-core/package.json');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])); delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath, args: [...electronTestWindowArgs, '-r', join(dirname(core), 'lib/server/electron/loader.js'), main], env, timeout: 30000 });
  page = await app.firstWindow(); await page.setViewportSize(config.viewport ?? { width: 1440, height: 1000 });
  await expect(page.getByRole('heading', { name: /Chat|Desktop startup failed/, exact: true })).toBeVisible();
}
async function release(method: string) { await app!.evaluate((_, method) => { const state = (globalThis as MainGlobal).__startupRenderer; state.holds = state.holds.filter(value => value !== method); state.pending[method]?.(); }, method); }
async function models() { await page.getByRole('button', { name: 'Models', exact: true }).click(); }
async function setDirectory(value: unknown) { await app!.evaluate((_, value) => { (globalThis as MainGlobal).__startupRenderer.modelResult = value; }, value); }

test('Octop compact composer has no model dropdown and hides routine context bars', async () => {
  await launch();
  const composer = page.locator('.composer'), input = page.getByLabel('Message text', { exact: true });
  await expect(page.getByRole('combobox', { name: 'Session model', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('session-model')).toHaveAttribute('data-model', '');
  await expect(composer.locator('select:visible')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Manage models', exact: true })).toHaveCount(0);
  await expect(page.locator('summary:visible').filter({ hasText: /^(Data for next message(?: ·.*)?|Message time context)$/ })).toHaveCount(0);
  await expect(input).toHaveValue('');
  await expect(input).toBeVisible();
  await expect.poll(async () => (await input.boundingBox())?.height).toBeLessThanOrEqual(60);
  await expect.poll(async () => (await composer.boundingBox())?.height).toBeLessThanOrEqual(180);
  await page.screenshot({ path: test.info().outputPath('compact-chat.png'), timeout: 15000 });
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  await input.fill('Short draft');
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.insertCSS('html { font-size: 28px !important; }'));
  await expect(page.locator('html')).toHaveCSS('font-size', '28px');
  await expect.poll(() => input.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath('compact-chat-200pct.png'), timeout: 15000 });
});

test('Octop theme changes keep the draft and remember the choice after reload', async () => {
  await launch({ restoredSession: true, modelResult: { ok: true, data: authenticatedDirectory } });
  const toggle = page.getByRole('button', { name: 'Dark mode', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('title', 'Switch to dark mode');
  const draft = page.getByLabel('Message text', { exact: true });
  await draft.fill('Keep this draft while changing the theme.');
  await toggle.focus(); await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.composer')).toHaveCSS('background-color', 'rgb(20, 20, 20)');
  await models();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(draft).toHaveValue('Keep this draft while changing the theme.');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('title', 'Switch to light mode');
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('Octop layout keeps an independent session sidebar and an accessible collapsed navigation', async () => {
  await launch();
  await expect.poll(async () => (await page.locator('.sidebar').boundingBox())?.width).toBeCloseTo(220, 0);
  await expect.poll(async () => (await page.getByRole('complementary', { name: 'Conversation history' }).boundingBox())?.width).toBeCloseTo(248, 0);
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByRole('button')).toHaveCount(8);
  await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
  await expect.poll(async () => (await page.locator('.sidebar').boundingBox())?.width).toBeCloseTo(56, 0);
  for (const name of ['Chat', 'Data Workspace', 'Query History', 'Models', 'Prompt', 'Skills', 'Extensions', 'Evaluation']) {
    const button = navigation.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('title', name);
  }
  await navigation.getByRole('button', { name: 'Models', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Models', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Conversation history' })).toBeHidden();
  await navigation.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.setViewportSize({ width: 1100, height: 720 });
  await expect(page.getByRole('complementary', { name: 'Conversation history' })).toBeHidden();
  await page.getByRole('button', { name: 'Show sessions', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Conversation history' })).toBeVisible();
  await expect.poll(async () => (await page.getByRole('complementary', { name: 'Conversation history' }).boundingBox())?.width).toBeCloseTo(248, 0);
});

test('Octop narrow launch keeps sessions beside chat and run details follow the 1600px breakpoint', async () => {
  await launch({ viewport: { width: 1100, height: 720 } });
  const history = page.getByRole('complementary', { name: 'Conversation history' });
  await expect(history).toBeHidden();
  await page.getByRole('button', { name: 'Show sessions', exact: true }).click();
  await expect(history).toBeVisible();
  const historyBounds = await history.boundingBox(), chatBounds = await page.locator('.chat-layout').boundingBox();
  expect(historyBounds).not.toBeNull(); expect(chatBounds).not.toBeNull();
  expect(historyBounds!.x + historyBounds!.width).toBeLessThanOrEqual(chatBounds!.x + 1);
  const trigger = page.getByRole('button', { name: 'View run details', exact: true });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Run details', exact: true });
  await expect(drawer).toBeVisible();
  const close = drawer.getByRole('button', { name: 'Close run details', exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0); await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 1599, height: 900 }); await trigger.click();
  await expect(drawer).toBeVisible();
  await page.setViewportSize({ width: 1600, height: 900 });
  const dock = page.getByRole('complementary', { name: 'Run details', exact: true });
  await expect(dock).toBeVisible(); await expect.poll(async () => (await dock.boundingBox())?.width).toBeCloseTo(400, 0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(drawer).toBeVisible(); await expect(close).toBeFocused();
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
});

test('Octop chat shows only Q&A while technical entries stay mounted and session tools remain available in Settings Runtime', async () => {
  const body = 'Saved assistant message ' + 'with a long readable paragraph. '.repeat(45);
  const message = SessionMessageViewSchema.parse({ nativeEntryId: 'ui-native-assistant', parentEntryId: null, entryType: 'message', displayRole: 'assistant', text: body,
    references: [], inputId: null, runId: null, toolCallRef: null, textInfo: { totalChars: body.length, truncated: false, redacted: false } });
  const questionText = 'A saved user question', toolText = 'Internal tool receipt', markerText = 'Model changed to offline-provider / offline-model';
  const question = SessionMessageViewSchema.parse({ ...message, nativeEntryId: 'ui-native-user', displayRole: 'user', text: questionText, textInfo: { ...message.textInfo, totalChars: questionText.length } });
  const tool = SessionMessageViewSchema.parse({ ...message, nativeEntryId: 'ui-native-tool', displayRole: 'tool_result', text: toolText, textInfo: { ...message.textInfo, totalChars: toolText.length } });
  const marker = SessionMessageViewSchema.parse({ ...message, nativeEntryId: 'ui-native-model-change', entryType: 'model_change', displayRole: 'history_marker', text: markerText, textInfo: { ...message.textInfo, totalChars: markerText.length } });
  const empty = SessionMessageViewSchema.parse({ ...message, nativeEntryId: 'ui-native-empty', text: '', textInfo: { ...message.textInfo, totalChars: 0 } });
  await launch({ restoredSession: true, modelResult: { ok: true, data: authenticatedDirectory },
    sessionTitle: 'A long English session title for reviewing imported regional medical equipment inventory', messages: [question, message, tool, marker, empty] });
  const native = page.getByTestId('chat-native-messages'), saved = native.locator('[data-native-entry-id="ui-native-assistant"]');
  await expect(saved.locator('.answer-text')).toHaveText(body); await expect(saved.locator('.answer-text')).toBeVisible();
  await expect(native.locator('[data-native-entry-id="ui-native-user"] .answer-text')).toHaveText(questionText);
  await expect(native.locator('[data-native-entry-id="ui-native-user"] .answer-text')).toBeVisible();
  await expect(native.locator('article[data-native-entry-id]')).toHaveCount(5);
  await expect(native.locator('article[data-native-entry-id]:visible')).toHaveCount(2);
  for (const id of ['ui-native-tool', 'ui-native-model-change', 'ui-native-empty']) {
    await expect(native.locator(`[data-native-entry-id="${id}"]`)).toBeAttached();
    await expect(native.locator(`[data-native-entry-id="${id}"]`)).toBeHidden();
  }
  await expect(native.locator('.message-origin')).toBeAttached();
  await expect(native.locator('.message-origin')).toBeHidden();
  await expect(native.getByText('Native history details', { exact: true })).toBeAttached();
  await expect(native.getByText('Native history details', { exact: true })).toBeHidden();
  await expect(saved.getByText('Message details', { exact: true })).toBeAttached();
  await expect(saved.getByText('Message details', { exact: true })).toBeHidden();
  const identity = saved.getByText('ui-native-assistant', { exact: true });
  await expect(identity).toBeAttached();
  await expect(identity).toBeHidden();
  await expect(saved.locator('.answer-text')).toBeVisible();
  const savedTurns = page.getByTestId('session-checkpoints'), compaction = page.getByTestId('session-compaction');
  await expect(savedTurns).toBeAttached(); await expect(savedTurns).toBeHidden();
  await expect(compaction).toBeAttached(); await expect(compaction).toBeHidden();
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Runtime', exact: true }).click();
  await expect(savedTurns).toBeVisible(); await expect(compaction).toBeVisible();
  if (!await savedTurns.getByRole('button', { name: 'Refresh saved turns', exact: true }).isVisible()) await savedTurns.getByText('Browse saved turns', { exact: true }).click();
  await expect(savedTurns.getByRole('button', { name: 'Refresh saved turns', exact: true })).toBeVisible();
  if (!await compaction.getByRole('button', { name: 'Compact context', exact: true }).isVisible()) await compaction.getByText('Context tools', { exact: true }).click();
  await expect(compaction.getByRole('button', { name: 'Compact context', exact: true })).toBeVisible();
  await navigation.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(savedTurns).toBeAttached(); await expect(savedTurns).toBeHidden();
  await expect(compaction).toBeAttached(); await expect(compaction).toBeHidden();
  await expect(saved.locator('.answer-text')).toBeVisible();
  await expect(page.locator('.page-header h1')).toHaveCount(1);
  await expect.poll(async () => (await page.locator('.page-header').boundingBox())?.height).toBeCloseTo(56, 0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const screenshots = join(root, 'test-results/ui-redesign'); mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, '1440x1000-chat-long-message.png') });
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1100, height: 720 }, { width: 1920, height: 1080 }]) {
 for (const theme of ['light', 'dark'] as const) {
  test(`Octop ${theme === 'dark' ? 'dark ' : ''}pages preserve the draft and fit ${viewport.width}x${viewport.height}`, async () => {
    test.setTimeout(60000);
    const screenshots = join(root, 'test-results/ui-redesign'); mkdirSync(screenshots, { recursive: true });
    const size = `${viewport.width}x${viewport.height}${theme === 'dark' ? '-dark' : ''}`;
    await launch({ viewport, modelResult: { ok: true, data: authenticatedDirectory }, catalogResult: { ok: true, data: importedCatalog } });
    if (theme === 'dark') await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
    if (viewport.width === 1100) await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId('session-checkpoints')).toBeAttached();
    await expect(page.getByTestId('session-checkpoints')).toBeHidden();
    await expect(page.getByTestId('session-compaction')).toBeHidden();
    await page.screenshot({ path: join(screenshots, `${size}-welcome.png`) });
    if (viewport.width < 1200) await page.getByRole('button', { name: 'Show sessions', exact: true }).click();
    await page.getByRole('button', { name: 'New Session', exact: true }).click();
    await expect(page.getByTestId('session-checkpoints')).toBeAttached();
    await expect(page.getByTestId('session-checkpoints')).toBeHidden();
    const draft = 'Keep this draft while visiting every MedClaw page.';
    await page.getByLabel('Message text', { exact: true }).fill(draft);
    for (const name of ['Chat', 'Data Workspace', 'Query History', 'Models', 'Prompt', 'Skills', 'Extensions', 'Evaluation', 'Settings']) {
      await page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
      await expect(page.locator('.page-header h1')).toHaveText(name);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (name === 'Chat') {
        await expect(page.getByLabel('Message text', { exact: true })).toBeVisible();
        await expect(page.getByLabel('Message routing', { exact: true })).toBeHidden();
      }
      if (name === 'Models') await expect(page.locator('.model-row').first().locator('.model-metadata')).toBeHidden();
      if (name === 'Data Workspace') await expect(page.getByLabel('Import operation ID', { exact: true })).toBeHidden();
      if (name === 'Prompt') await expect(page.getByLabel('Requirements (optional)', { exact: true })).toBeHidden();
      if (name === 'Settings') {
        await expect(page.locator('.settings-layout form').first()).toBeHidden();
        await expect(page.getByRole('button', { name: 'Read Host status', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Read diagnostics', exact: true })).toBeHidden();
        await expect(page.getByRole('button', { name: 'Choose support destination', exact: true })).toBeHidden();
        await expect(page.getByLabel('Include in-memory call stage summaries', { exact: true })).toBeHidden();
      }
      if (name !== 'Chat') {
        await expect(page.getByRole('complementary', { name: 'Conversation history' })).toBeHidden();
        await expect(page.getByTestId('current-session')).toBeAttached();
        await expect(page.getByTestId('current-session')).toBeHidden();
      }
      await page.screenshot({ path: join(screenshots, `${size}-${name.toLowerCase().replaceAll(' ', '-')}.png`) });
    }
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByLabel('Message text', { exact: true })).toHaveValue(draft);
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.insertCSS('html { font-size: 28px !important; }'));
    await expect(page.locator('html')).toHaveCSS('font-size', '28px');
    const send = page.locator('.composer').getByRole('button', { name: 'Send', exact: true });
    await send.scrollIntoViewIfNeeded(); await expect(send).toBeInViewport(); await expect(send).toBeEnabled();
    await send.focus(); await expect(send).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: join(screenshots, `${size}-chat-200pct.png`) });
  });
  test(`Octop ${theme === 'dark' ? 'dark ' : ''}business pages fit ${viewport.width}x${viewport.height} at 200 percent font`, async () => {
    test.setTimeout(60000);
    const screenshots = join(root, 'test-results/ui-redesign'); mkdirSync(screenshots, { recursive: true });
    const size = `${viewport.width}x${viewport.height}${theme === 'dark' ? '-dark' : ''}`;
    await launch({ viewport, restoredSession: true, modelResult: { ok: true, data: authenticatedDirectory }, catalogResult: { ok: true, data: importedCatalog } });
    if (theme === 'dark') await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.insertCSS('html { font-size: 28px !important; }'));
    await expect(page.locator('html')).toHaveCSS('font-size', '28px');
    for(const name of ['Data Workspace','Query History','Models','Prompt','Skills','Extensions','Evaluation','Settings']){
      await page.locator('.sidebar').getByRole('button',{name,exact:true}).click();
      await expect(page.locator('.page-header h1')).toHaveText(name);
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
      if(name==='Data Workspace'&&viewport.width===1100){
        const batches=page.getByRole('region',{name:'Imported batches',exact:true});
        await batches.focus();await expect(batches).toBeFocused();await page.keyboard.press('ArrowRight');
        await expect.poll(()=>batches.evaluate(element=>element.scrollLeft)).toBeGreaterThan(0);
        await batches.evaluate(element=>{element.scrollLeft=0;});
      }
      await page.screenshot({path:join(screenshots,`${size}-${name.toLowerCase().replaceAll(' ','-')}-200pct.png`)});
    }
  });
 }
}

test('ready Host exposes both catalogs without a Session and failed Host shows the real startup reason',async()=>{
  await launch();await page.getByRole('button',{name:'Skills',exact:true}).click();
  const skills=page.getByRole('region',{name:'Skill Hub',exact:true});
  await expect(skills.getByTestId('resource-row')).toHaveCount(16);
  await expect(skills.getByRole('switch').first()).toBeDisabled();
  await expect(skills).toContainText('capabilities');
  await page.getByRole('button',{name:'Extensions',exact:true}).click();
  await expect(page.getByTestId('extensions-panel')).toContainText('tool-audit');
  await expect(page.getByRole('button',{name:'Configure extension',exact:true})).toBeDisabled();
  await expect(page.locator('.host-indicator')).toHaveCSS('color','rgb(24, 121, 78)');
  await app!.close();app=undefined;
  const error=safeError('host_dependency_unavailable',undefined,{reason:'dependency_powershell_unavailable'});
  await launch({host:{...ready,state:'failed',canStart:true,error}});
  await page.getByRole('button',{name:'Skills',exact:true}).click();
  await expect(page.getByRole('region',{name:'Skill Hub',exact:true})).toContainText('PowerShell is unavailable');
  await expect(page.getByRole('region',{name:'Skill Hub',exact:true}).getByTestId('resource-row')).toHaveCount(0);
  await expect(page.locator('.host-indicator')).toHaveCSS('color','rgb(180, 35, 56)');
  await page.locator('.host-indicator').click();
  await expect(page.locator('.page-header h1')).toHaveText('Settings');
  await expect(page.getByRole('button',{name:'Start Host',exact:true})).toBeEnabled();
});

test('pending session selection waits for confirmation before reading resources', async () => {
  await launch({ holds: ['workspace.restore'] });
  const completed = (method: string) => app!.evaluate((_, method) => (globalThis as MainGlobal).__startupRenderer.completed.filter(value => value === method).length, method);
  await expect.poll(() => app!.evaluate(() => (globalThis as MainGlobal).__startupRenderer.entered.includes('workspace.restore'))).toBe(true);
  await models();
  await expect(page.getByLabel('Provider', { exact: true }).locator('option')).toHaveCount(2);
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  const skills = page.getByRole('region', { name: 'Skill Hub', exact: true });
  await expect(skills.getByRole('status')).toHaveText('Session selection is unconfirmed. Verify the current selection in Chat or Data Workspace.');
  await expect(skills.getByRole('button', { name: 'Verify session selection', exact: true })).toBeVisible();
  await expect(skills.getByRole('button', { name: 'Choose session', exact: true })).toHaveCount(0);
  await expect(skills.getByText('No resources in this catalog.', { exact: true })).toHaveCount(0);
  expect(await completed('resources.catalog.read')).toBe(0);
  expect(await completed('resources.list')).toBe(0);

  await release('workspace.restore');
  await expect.poll(() => completed('resources.catalog.read')).toBe(2);
  await expect(skills.getByTestId('resource-row')).toHaveCount(16);
  await expect(skills.getByRole('button', { name: 'Choose session', exact: true })).toBeVisible();
  await expect(skills.getByRole('switch').first()).toBeDisabled();

  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  await expect(page.getByTestId('current-session')).toContainText('New Session 1');
  await expect.poll(() => completed('resources.list')).toBe(2);
  expect(await completed('resources.catalog.read')).toBe(2);
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await expect(skills.getByRole('button', { name: 'Clear selection', exact: true })).toBeEnabled();
  await skills.getByText('Resource context', { exact: true }).click();
  await expect(skills.getByText('Session 1 · Next run resources', { exact: true })).toBeVisible();
});

test('S07 cold empty Session never displays a submission in progress', async () => {
  await launch();
  await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Submitting…', exact: true })).toHaveCount(0);
  await expect(page.locator('.composer').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByLabel('Message text', { exact: true }).fill('First message without a configured model');
  await expect(page.getByRole('status', { name: 'Current chat model', exact: true })).toContainText('No model configured');
  await expect(page.locator('.composer').getByRole('button', { name: 'Send', exact: true })).toHaveAttribute('title', 'Configure a model in Models before sending');
  await expect(page.locator('.composer').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
});

test('S07 first Send creates a Session before submitting the original message exactly once', async () => {
  const firstMessageDirectory = ModelDirectoryViewSchema.parse({ ...authenticatedDirectory, models: [{ ...authenticatedDirectory.models[0]!, id: 'alternate-model', name: 'Alternate model' }, ...authenticatedDirectory.models] });
  await launch({ modelResult: { ok: true, data: firstMessageDirectory }, holds: ['session.create', 'session.submit'] });
  const input = page.getByLabel('Message text', { exact: true }), text = '首条中文消息\n保留原始内容';
  const currentModel = page.getByRole('status', { name: 'Current chat model', exact: true });
  const requests = () => app!.evaluate(() => {
    const state = (globalThis as MainGlobal).__startupRenderer;
    return { entered: state.entered.filter(method => method === 'session.create' || method === 'session.submit'), completed: state.completed.filter(method => method === 'session.create' || method === 'session.submit') };
  });
  try {
    await expect(currentModel).toContainText('Default model');
    await expect(currentModel).toContainText('Offline model');
    await expect(currentModel).toContainText('Offline provider');
    await expect(currentModel).toContainText('Authentication available');
    await models();
    const summary = page.getByTestId('default-model-summary');
    await expect(summary).toContainText('Default model');
    await expect(summary).toContainText('Offline model');
    await expect(summary).toContainText('Provider: Offline provider');
    await expect(summary).toContainText('Authentication available');
    await expect(page.locator('.model-row').first()).toContainText('Offline model');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(input).toBeEditable();
    await input.fill(text);
    const send = page.locator('.composer').getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeEnabled();
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    expect(await requests()).toEqual({ entered: [], completed: [] });
    await send.click();
    await expect.poll(requests).toEqual({ entered: ['session.create'], completed: [] });
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue(text);
    await expect(send).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Creating…', exact: true })).toBeDisabled();
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter' });
    expect(await requests()).toEqual({ entered: ['session.create'], completed: [] });
    await release('session.create');
    await expect(page.getByTestId('current-session')).toContainText('New Session 1');
    await expect.poll(requests).toEqual({ entered: ['session.create', 'session.submit'], completed: ['session.create'] });
    await expect(currentModel).toContainText('Session model');
    await expect(input).toHaveValue(text);
    await expect(page.locator('.composer').getByRole('button', { name: 'Submitting…', exact: true })).toBeDisabled();
    await release('session.submit');
    await expect(input).toHaveValue('');
    const inputs = await page.evaluate(() => window.medclaw.request('session.listInputs', { sessionId: 1 }));
    expect(inputs).toMatchObject({ ok: true, data: { sessionId: 1, items: [{ sessionId: 1, text }] } });
    if (!inputs.ok) throw new Error('Original first message Input is unavailable');
    expect(inputs.data.items).toHaveLength(1);
    expect(await requests()).toEqual({ entered: ['session.create', 'session.submit'], completed: ['session.create', 'session.submit'] });
  } finally {
    await release('session.create');
    await release('session.submit');
  }
});

for (const code of ['resource_unavailable', 'operation_result_unknown'] as const) {
  test(`S07 first Send retains the draft without submitting when Session creation returns ${code}`, async () => {
    await launch({ modelResult: { ok: true, data: authenticatedDirectory }, sessionCreateResult: { ok: false, error: safeError(code) }, holds: ['session.create'] });
    const input = page.getByLabel('Message text', { exact: true }), text = '创建失败时保留首条草稿';
    try {
      await expect(input).toBeEditable();
      await input.fill(text);
      const send = page.locator('.composer').getByRole('button', { name: 'Send', exact: true });
      await expect(send).toBeEnabled();
      await send.click();
      await expect.poll(() => app!.evaluate(() => (globalThis as MainGlobal).__startupRenderer.entered.filter(method => method === 'session.create').length)).toBe(1);
      await release('session.create');
      await expect(page.getByRole('alert')).toContainText(safeError(code).message);
      await expect(input).toHaveValue(text);
      expect(await app!.evaluate(() => (globalThis as MainGlobal).__startupRenderer.completed.filter(method => method === 'session.submit'))).toEqual([]);
      const workspace = await page.evaluate(() => window.medclaw.request('workspace.read', {}));
      expect(workspace).toMatchObject({ ok: true, data: { sessionId: null } });
      if (code === 'operation_result_unknown') {
        await expect(page.getByRole('button', { name: 'Recover original creation', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeDisabled();
        await expect(send).toBeDisabled();
      } else {
        await expect(input).toBeEditable();
        await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled();
      }
    } finally { await release('session.create'); }
  });
}

test('S07 no-session draft survives navigation and belongs only to its first created Session', async () => {
  await launch({ holds: ['session.create'] });
  const create = page.getByRole('button', { name: 'New Session', exact: true });
  const input = page.getByLabel('Message text', { exact: true }), draft = '还没有会话的中文草稿\n第二行内容';
  await expect(create).toBeEnabled();
  await expect(input).toBeEditable();
  await input.fill(draft);
  await models();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(input).toHaveValue(draft);
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
  expect(await app!.evaluate(() => {
    const state = (globalThis as MainGlobal).__startupRenderer;
    return [...state.entered, ...state.completed].filter(method => method === 'session.create' || method === 'session.submit');
  })).toEqual([]);
  await create.click();
  await expect.poll(() => app!.evaluate(() => (globalThis as MainGlobal).__startupRenderer.entered.includes('session.create'))).toBe(true);
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue(draft);
  await release('session.create');
  await expect(page.getByTestId('current-session')).toContainText('New Session 1');
  await expect(input).toBeEditable();
  await expect(input).toHaveValue(draft);
  await create.click();
  await expect(page.getByTestId('current-session')).toContainText('New Session 2');
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'New Session 1', exact: true }).click();
  await expect(page.getByTestId('current-session')).toContainText('New Session 1');
  await expect(input).toHaveValue(draft);
});

test('S05 directory loading has its own visible state', async () => {
  await launch({ holds: ['model.read'] }); await models();
  await expect(page.getByRole('status').filter({ hasText: 'Reading model directory…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Session', exact: true, includeHidden: true })).toBeEnabled();
  await release('model.read'); await expect(page.getByLabel('Provider', { exact: true }).locator('option')).toHaveCount(2);
});

test('S05 failed first directory read is an error, not an unread or empty directory', async () => {
  await launch({ modelResult: failure }); await models();
  await expect(page.getByRole('status').filter({ hasText: 'Model directory read failed.' })).toBeVisible();
  await expect(page.getByText('The directory has not been read. Reload it when Host is ready.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No models in the current directory', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New Session', exact: true, includeHidden: true })).toBeEnabled();
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
  await page.getByRole('button', { name: 'Select Offline model', exact: true }).click();
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

test('Models Configure API Key opens the existing provider authentication task', async () => {
  await launch(); await models();
  await expect(page.getByLabel('Provider', { exact: true }).locator('option')).toHaveCount(2);
  const configure = page.getByRole('button', { name: 'Configure API Key', exact: true });
  await expect(configure).toBeVisible();
  await configure.click();
  await expect(page.getByRole('navigation', { name: 'Model tasks' }).getByRole('button', { name: 'Providers', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'API keys and provider sign-in', exact: true })).toBeVisible();
  await expect(page.getByLabel('Provider to authenticate', { exact: true })).toHaveValue('offline-provider');
  await expect(page.getByLabel('Provider to authenticate', { exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Sign in with API Key', exact: true })).toBeVisible();
});

test('S06 unauthenticated Provider is browseable but cannot become a Send candidate', async () => {
  await launch({ modelResult: { ok: true, data: { ...authenticatedDirectory, providers: directory.providers } } });
  await page.getByLabel('Message text', { exact: true }).fill('First message before authentication');
  await expect(page.getByRole('status', { name: 'Current chat model', exact: true })).toContainText('Authentication required');
  await expect(page.locator('.composer').getByRole('button', { name: 'Send', exact: true })).toHaveAttribute('title', 'Authenticate the provider first');
  await expect(page.locator('.composer').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await models();
  await expect(page.getByLabel('Provider', { exact: true }).locator('option')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Select Offline model', exact: true })).toBeVisible();
  await page.getByLabel('Provider', { exact: true }).selectOption('offline-provider');
  await page.getByRole('navigation', { name: 'Model tasks' }).getByRole('button', { name: 'Providers', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with API Key', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  await expect(page.getByTestId('current-session')).toContainText('New Session 1');
  await expect(page.getByRole('combobox', { name: 'Session model', exact: true })).toHaveCount(0);
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

async function timeContext() { if (!await page.getByLabel('Reference date', { exact: true }).isVisible()) await page.getByText('Message options', { exact: true }).click(); }
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
 await page.getByLabel('Message text',{exact:true}).fill('Keep my draft');await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Manage imported data',exact:true}).click();await page.getByRole('button',{name:'Delete batch 1',exact:true}).click();await page.getByRole('button',{name:'Confirm permanent deletion',exact:true}).click();
 await expect(page.getByText('Deletion result unconfirmed. Read this operation before another deletion.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'New Session',exact:true,includeHidden:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Preview delete all imported data',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Chat',exact:true}).click();await expect(page.getByLabel('Message text',{exact:true})).toHaveValue('Keep my draft');await expect(page.locator('.composer').getByRole('button',{name:'Send',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Read deletion result',exact:true}).click();await expect(page.getByTestId('deletion-result')).toContainText('Data deleted');await expect(page.getByRole('button',{name:'New Session',exact:true,includeHidden:true})).toBeEnabled();
 await page.getByRole('button',{name:'Chat',exact:true}).click();await expect(page.getByLabel('Message text',{exact:true})).toHaveValue('Keep my draft');await expect(page.locator('.composer').getByRole('button',{name:'Send',exact:true})).toBeEnabled();
 const completed=await app!.evaluate(()=>(globalThis as MainGlobal).__startupRenderer.completed);expect(completed.filter(method=>method==='data.delete.commit')).toHaveLength(1);expect(completed.filter(method=>method==='session.submit')).toHaveLength(0);
});

for(const [name,result]of [['null',{ok:true,data:null}],['failed',failure]] as const)test('B03 '+name+' deletion lookup does not unlock an unconfirmed write',async()=>{
 await launch({restoredSession:true,catalogResult:{ok:true,data:importedCatalog},deletionLost:true,deletionReadResult:result});await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Manage imported data',exact:true}).click();await page.getByRole('button',{name:'Delete batch 1',exact:true}).click();await page.getByRole('button',{name:'Confirm permanent deletion',exact:true}).click();await page.getByRole('button',{name:'Read deletion result',exact:true}).click();
 await expect(page.getByRole('button',{name:'New Session',exact:true,includeHidden:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Preview delete all imported data',exact:true})).toBeDisabled();await expect(page.getByText('Deletion result unconfirmed. Read this operation before another deletion.',{exact:true})).toBeVisible();
});

test('B03 a delayed deletion lookup from an old Host cannot replace the new confirmed display',async()=>{
 await launch({catalogResult:{ok:true,data:importedCatalog},holds:['data.delete.read'],deletionReadResult:failure});await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Recover an operation',exact:true}).click();await page.getByLabel('Deletion operation ID',{exact:true}).fill('old-operation');await page.getByRole('button',{name:'Read deletion result',exact:true}).click();
 await expect.poll(()=>app!.evaluate(()=>(globalThis as MainGlobal).__startupRenderer.entered.includes('data.delete.read'))).toBe(true);
 await app!.evaluate(({BrowserWindow},host)=>{const state=(globalThis as MainGlobal).__startupRenderer;state.host=host;for(const window of BrowserWindow.getAllWindows())window.webContents.send('test:notice',{type:'host.status',host,instanceId:host.instanceId});},{...ready,instanceId:'replacement-host'});
 await expect(page.getByRole('button',{name:'New Session',exact:true,includeHidden:true})).toBeEnabled();await release('data.delete.read');await expect.poll(()=>app!.evaluate(()=>(globalThis as MainGlobal).__startupRenderer.completed.includes('data.delete.read'))).toBe(true);
 await expect(page.getByText('Deletion result unconfirmed. Read this operation before another deletion.',{exact:true})).toHaveCount(0);await expect(page.getByText(failure.error.message,{exact:true})).toHaveCount(0);
});

test('B03 a pre-deletion row reply cannot repopulate the current data view after catalog changes',async()=>{
 await launch({catalogResult:{ok:true,data:importedCatalog},holds:['data.rows']});await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Read batch 1 devices',exact:true}).click();await expect.poll(()=>app!.evaluate(()=>(globalThis as MainGlobal).__startupRenderer.entered.includes('data.rows'))).toBe(true);
 await page.getByRole('button',{name:'Manage imported data',exact:true}).click();await page.getByRole('button',{name:'Delete batch 1',exact:true}).click();await page.getByRole('button',{name:'Confirm permanent deletion',exact:true}).click();await expect(page.getByTestId('deletion-result')).toContainText('Data deleted');await release('data.rows');await expect.poll(()=>app!.evaluate(()=>(globalThis as MainGlobal).__startupRenderer.completed.filter(method=>method==='data.rows').length)).toBe(2);
 await expect(page.getByText('0 rows · Page 1',{exact:true})).toHaveCount(0);await expect(page.getByTestId('data-rows')).toHaveCount(0);
});
