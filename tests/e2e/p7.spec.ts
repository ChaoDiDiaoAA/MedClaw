import {electronTestWindowArgs} from '../fixtures/desktop-dev';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { SessionInput, SubmitResult } from '../../packages/contracts/src/session';
import { canonicalRequest } from '../../packages/contracts/src/run';
import { safeError } from '../../packages/contracts/src/error';

const root = resolve(import.meta.dirname, '../..'), bun = process.env.MEDCLAW_BUN_EXECUTABLE ?? 'bun';
let app: ElectronApplication, page: Page, temporary: string, server: Server;
type Call = { method: string; payload: Record<string, unknown>; operationRef?: string };
type Rule = { method: string; sessionId?: number; inputId?: number; runId?:number; action?:string; hold?: string; before?: boolean; legacy?: boolean; requestPatch?: Record<string, unknown>; project?: unknown };
type GateState = { drop:string[]; notices:Record<string,unknown>[];  rules: Rule[]; entered: string[]; pending: Record<string, () => void>; calls: Call[]; accepted: (SubmitResult & { mode: string; operationRef: string })[] };
type MainGlobal = typeof globalThis & { __p7Gate: GateState };
type Wire = { model: string; messages: { role: string; content: unknown; tool_call_id?:string; tool_calls?:{id:string;function:{name:string;arguments:string}}[] }[] };
type Reply = {text:string;endGate?:ReturnType<typeof gate>} | {id:string;name:string;args:unknown;leadText?:string};
let steps: ((wire: Wire) => Promise<Reply> | Reply)[] = [], physical = 0;
const wires: Wire[] = [], httpReleases: (() => void)[] = [];
const evidence = join(root, '.build/p7-workspace/e2e');
test.describe.configure({ mode: 'serial' });
const input = () => page.getByLabel('Message text', { exact: true });
const queue = () => page.getByTestId('input-queue');
const item = (id: number) => queue().locator(`[data-input-id="${id}"]`);
function gate() { let enter!: () => void, release!: () => void; const value = { entered: new Promise<void>(resolve => { enter = resolve; }), response: new Promise<void>(resolve => { release = resolve; }), enter: () => enter(), release: () => release() }; httpReleases.push(value.release); return value; }
async function rules(values: Rule[]) { await app.evaluate((_, values) => { (globalThis as MainGlobal).__p7Gate.rules.push(...values); }, values); }
async function entered(id: string) { await expect.poll(() => app.evaluate((_, id) => (globalThis as MainGlobal).__p7Gate.entered.includes(id), id)).toBe(true); }
async function release(id: string) { await app.evaluate((_, id) => { (globalThis as MainGlobal).__p7Gate.pending[id]?.(); }, id); }
async function calls() { return app.evaluate(() => (globalThis as MainGlobal).__p7Gate.calls); }
async function accepted() { return app.evaluate(() => (globalThis as MainGlobal).__p7Gate.accepted); }
async function create() { await page.getByRole('button', { name: 'New Session', exact: true }).click(); const w = await page.evaluate(() => window.medclaw.request('workspace.read', {})); if (!w.ok || !w.data.sessionId) throw new Error('Missing Session'); await expect(page.getByTestId('current-session')).toContainText(await sessionTitle(w.data.sessionId)); return w.data.sessionId; }
async function sessionTitle(id: number) { const value = await page.evaluate(sessionId => window.medclaw.request('session.read', { sessionId }), id); if (!value.ok || !value.data) throw new Error('Missing Session title'); return value.data.session.title; }
async function select(id: number) { await page.locator(`.session-row[data-session-id="${id}"]`).locator('button[aria-pressed]').click(); await expect(page.getByTestId('current-session')).toContainText(await sessionTitle(id)); }
async function idle() { await expect.poll(async () => { const value = await page.evaluate(() => window.medclaw.request('run.control.read', {})); return value.ok && value.data.acceptingNewRuns && value.data.activeRootRun === null; }).toBe(true); }
async function readInput(id: number) { const value = await page.evaluate(inputId => window.medclaw.request('session.readInput', { inputId }), id); if (!value.ok || !value.data) throw new Error('Missing original Input'); return value.data; }
async function readRun(id: number) { const value = await page.evaluate(runId => window.medclaw.request('run.read', { runId }), id); if (!value.ok || value.data.kind !== 'one' || !value.data.run) throw new Error('Missing original Run'); return value.data.run; }
async function clickSubmit(text: string, mode: 'send' | 'steer' | 'follow_up' = 'send') { const before = (await accepted()).length; const actions = page.getByRole('button', { name: 'Message actions', exact: true }); if (mode !== 'send') { await actions.click(); await page.getByRole('menuitem', { name: mode === 'follow_up' ? 'Follow Up' : mode === 'steer' ? 'Steer' : 'Send', exact: true }).click(); } await input().fill(text); await page.getByRole('button', { name: mode === 'follow_up' ? 'Follow Up' : mode === 'steer' ? 'Steer' : 'Send', exact: true }).click(); await expect.poll(async () => (await accepted()).length).toBe(before + 1); return (await accepted())[before]!; }
function sql(query: string) { return JSON.parse(execFileSync(bun, ['-e', 'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); console.log(JSON.stringify(db.query(process.argv[2]).all())); db.close();', join(temporary, 'data', 'data', 'app.sqlite'), query], { encoding: 'utf8', cwd: root })); }
function save(name: string, data: unknown) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, name + '.json'), JSON.stringify(data, null, 2)); }

function snapshotPackage(directory: string) {
  mkdirSync(directory, { recursive: true });
  const csv = (values: string[]) => values.map(value => `"${value.replaceAll('"', '""')}"`).join(',');
  const names = ['A decrease one', 'A decrease two', 'Original manufacturer decrease', 'B unique increase device'];
  const masters = names.map((device_name, i) => ({ record_type: 'master', device_id: String(i + 1).padStart(5, '0'), device_name, source_submission_id: String(i + 1).padStart(5, '0'), source_applicant: 'Synthetic Applicant', category: 'Category', manufacturer: i === 2 ? '模拟厂家-02' : '模拟厂家-01' }));
  const sourceLock = { schema: 'medclaw.source-lock/v2', sources: [{ source: 'fixture', path: 'original.csv' }] };
  writeFileSync(join(directory, 'source-lock.json'), JSON.stringify(sourceLock)); writeFileSync(join(directory, 'entity-lineage.csv'), `${csv(Object.keys(masters[0]!))}\n${masters.map(master => csv(Object.values(master))).join('\n')}\n`);
  for (const name of ['adjustment-lineage.csv', 'validation-report.json', 'selection-report.json', '使用说明.md']) writeFileSync(join(directory, name), name.endsWith('.json') ? '{}' : 'fixture');
  const columns = ['device_id', 'device_name', 'source_submission_id', 'source_applicant', 'category', 'region', 'snapshot_date', 'price_cents', 'currency', 'unit', 'status', 'manufacturer', 'distributor', 'source_refs_json', 'field_origins_json'];
  const origins = Object.fromEntries(columns.slice(0, 13).map(key => [key, { kind: 'synthetic', ruleId: 'p4-fixture' }]));
  for (const [index, prices] of [[10000, 20000, 10000, 10000], [8000, 15000, 9000, 12000]].entries()) {
    const date = `2026-01-0${index + 1}`;
    const text = `${csv(columns)}\n${masters.map((master, ordinal) => csv([master.device_id, master.device_name, master.source_submission_id, master.source_applicant, 'Category', '浙江', date, String(prices[ordinal]), 'CNY', '件', 'active', master.manufacturer, ordinal === 1 ? '模拟配送-02' : '模拟配送-01', JSON.stringify([{ sourceId: 'fixture', file: 'original.csv', row: ordinal + 1, recordId: master.source_submission_id }]), JSON.stringify(origins)])).join('\n')}\n`;
    writeFileSync(join(directory, `zhejiang_${date}.csv`), text); writeFileSync(join(directory, `zhejiang_${date}.metadata.json`), JSON.stringify({ contract: 'medclaw.snapshot/v2', mappingVersion: 'medclaw.snapshot/v1', materialVersion: 'p4-fixture/v1', generatorVersion: 'p4-fixture/v1', seed: 1, sourceBundleId: 'p4-fixture', scopeKey: 'p4-zhejiang', region: '浙江', snapshotDate: date, coverage: 'full', expectedEntityCount: 4, observedEntityCount: 4, declaredMissingEntityIds: [], referenceDate: '2026-01-02', timezone: 'Asia/Shanghai' }));
  }
  const files = readdirSync(directory).filter(path => path !== 'manifest.json').sort().map(path => { const bytes = readFileSync(join(directory, path)); return { path, bytes: bytes.length }; });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ status: 'complete', files, businessFiles: 2, businessRows: 8, businessBytes: files.filter(file => /^zhejiang_.*\.csv$/.test(file.path)).reduce((sum, file) => sum + file.bytes, 0), totalPayloadBytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
}


test.beforeAll(async () => {
  test.setTimeout(90000);
  for (const part of ['main', 'preload']) execFileSync(bun, ['build', `apps/desktop/src/${part}/index.ts`, '--target=node', '--format=cjs', '--external=electron', `--outfile=.build/desktop/${part}/index.cjs`], { cwd: root });
  execFileSync(bun, ['build', 'apps/desktop/src/renderer/index.html', '--target=browser', '--outdir=.build/desktop/renderer'], { cwd: root });
  temporary = mkdtempSync(join(tmpdir(), 'medclaw-p7-desktop-')); snapshotPackage(join(temporary,'source'));
  server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const wire = JSON.parse(body) as Wire; wires.push(wire); physical++;
    const next = steps.shift(); if (!next) { response.writeHead(500); response.end('No controlled fixture step'); return; }
    const reply = await next(wire); if (response.destroyed) return;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta='text' in reply ? {role:'assistant',content:reply.text} : {role:'assistant',content:reply.leadText,tool_calls:[{index:0,id:reply.id,type:'function',function:{name:reply.name,arguments:JSON.stringify(reply.args)}}]};
    response.write('data: '+JSON.stringify({id:'p7-response',model:wire.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
    if('text' in reply && reply.endGate){reply.endGate.enter();await reply.endGate.response;}
    response.write('data: '+JSON.stringify({id:'p7-response',model:wire.model,choices:[{index:0,delta:{},finish_reason:'text' in reply?'stop':'tool_calls'}]})+'\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const seam = join(temporary, 'public-gates.cjs');
  writeFileSync(seam, `const {ipcMain,app}=require('electron'); const original=ipcMain.handle.bind(ipcMain);
    const state=globalThis.__p7Gate={rules:[],entered:[],pending:{},calls:[],accepted:[],drop:[],notices:[]};
    // Keep Playwright's frame-based actionability checks independent of Windows occlusion.
    app.on('browser-window-created',(_,win)=>{win.webContents.setBackgroundThrottling(false);const send=win.webContents.send.bind(win.webContents);win.webContents.send=(channel,...args)=>{if(channel==='medclaw:notice'){state.notices.push(structuredClone(args[0]));if(state.drop.includes(args[0].type))return;}return send(channel,...args);};});
    ipcMain.handle=(channel,listener)=>original(channel,async(event,envelope)=>{
      if(channel!=='medclaw:request')return listener(event,envelope);
      const p=envelope.payload; state.calls.push({method:envelope.method,payload:p,operationRef:envelope.operationRef});
      const index=state.rules.findIndex(r=>r.method===envelope.method&&(r.sessionId===undefined||r.sessionId===p.sessionId)&&(r.inputId===undefined||r.inputId===p.inputId)&&(r.runId===undefined||r.runId===p.runId)&&(!r.action||r.action===p.action));
      const rule=index<0?null:state.rules.splice(index,1)[0];
      const hold=async()=>{state.entered.push(rule.hold);await new Promise(resolve=>state.pending[rule.hold]=resolve);delete state.pending[rule.hold];};
      if(rule?.hold&&rule.before)await hold();
      let result=await listener(event,rule?.requestPatch?{...envelope,payload:{...p,...rule.requestPatch}}:envelope);
      if(envelope.method==='session.submit'&&result.ok)state.accepted.push({...result.data,mode:p.mode,operationRef:envelope.operationRef});
      if(rule?.project)result=rule.project;
      if(rule?.legacy&&result.ok)result={ok:true,data:{...result.data,inputId:null}};
      if(rule?.hold&&!rule.before)await hold();return result;
    });`);
  const hostEntry=join(temporary,'p7-host.ts');
  writeFileSync(hostEntry,`import {existsSync,writeFileSync} from 'node:fs';import {ToolExecutor} from ${JSON.stringify(join(root,'packages/core/src/tools/executor.ts'))};import {EventService} from ${JSON.stringify(join(root,'packages/core/src/events/event-service.ts'))};
  for(const name of ['subscribe','close','closeAll']){const old=EventService.prototype[name];EventService.prototype[name]=function(...args){try{return old.apply(this,args);}finally{writeFileSync(${JSON.stringify(join(temporary,'subscriptions.json'))},JSON.stringify({count:this.subscriptions.size}));}};}
  const original=ToolExecutor.prototype.execute;ToolExecutor.prototype.execute=async function(...args){if(args[2]?.nativeToolCallId==='p7-long-tool'){while(!existsSync(${JSON.stringify(join(temporary,'release-tool'))}))await new Promise(r=>setTimeout(r,20));}return original.apply(this,args);};
  const {WorkspaceService}=await import(${JSON.stringify(join(root,'packages/core/src/workspace/workspace-service.ts'))});const restore=WorkspaceService.prototype.restore;WorkspaceService.prototype.restore=async function(){if(existsSync(${JSON.stringify(join(temporary,'hold-restore'))})){writeFileSync(${JSON.stringify(join(temporary,'entered-restore'))},'entered');while(existsSync(${JSON.stringify(join(temporary,'hold-restore'))}))await new Promise(r=>setTimeout(r,20));}return restore.call(this);};await import(${JSON.stringify(join(root,'apps/host/src/main.ts'))});`);
  const require = createRequire(join(root, 'apps/desktop/package.json')), electronPath: string = require('electron');
  const playwright = createRequire(createRequire(import.meta.url).resolve('@playwright/test/package.json')), core = createRequire(playwright.resolve('playwright/package.json')).resolve('playwright-core/package.json');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])), MEDCLAW_HOST_ENTRY: hostEntry, MEDCLAW_BUN_EXECUTABLE: execFileSync(bun, ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).trim() };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: electronPath, args: [...electronTestWindowArgs,'-r', join(dirname(core), 'lib/server/electron/loader.js'), '-r', seam, join(root, '.build/desktop/main/index.cjs'), '--medclaw-data-root', join(temporary, 'data')], env, timeout: 30000 });
  page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 1000 }); await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},join(temporary,'source'));
  const configured = await page.evaluate(async baseUrl => {
    const directory = await window.medclaw.request('model.read', {}); if (!directory.ok) throw new Error(directory.error.code);
    const token = await window.medclaw.secretInput({ providerId: 'p6-fixture', purpose: 'custom_api_key', value: 'P6-LOCAL-NONSECRET' }); if (!token.ok) throw new Error(token.error.code);
    const saved = await window.medclaw.request('model.custom.save', { expectedConfigVersion: directory.data.configVersion, credentialInput: token.data.token, definition: { providerId: 'p6-fixture', name: 'P6 controlled fixture', api: 'openai-completions', baseUrl, models: ['first', 'second'].map(id => ({ id, name: 'P6 ' + id, input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null })) } }); if (!saved.ok) throw new Error(saved.error.code);
    return window.medclaw.request('model.configure', { provider: 'p6-fixture', modelId: 'first', expectedConfigVersion: saved.data.configVersion });
  }, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`); expect(configured.ok).toBe(true);
});
test.afterAll(async () => { httpReleases.forEach(release => release()); await app?.evaluate(() => Object.values((globalThis as MainGlobal).__p7Gate.pending).forEach(release => release())).catch(() => {}); await app?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); if (temporary) { const target = resolve(temporary), within = relative(resolve(tmpdir()), target); if (within && !within.startsWith('..') && !within.includes(':')) rmSync(target, { recursive: true, force: true }); } });
test.afterEach(async ({}, info) => {
  const name = info.title.replaceAll(/[^a-zA-Z0-9]+/g, '-'); mkdirSync(evidence, { recursive: true });
  if (info.status === info.expectedStatus) { save('dom-' + name, { currentSession: await page.getByTestId('current-session').innerText(), inputQueue: await queue().count() ? await queue().ariaSnapshot() : null, composer: await page.locator('.composer').count() ? await page.locator('.composer').ariaSnapshot() : null }); await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true }); }
  else {
    save('failure-' + name, { host: await page.evaluate(() => window.medclaw.request('host.read', {})), diagnostics: await page.evaluate(() => window.medclaw.request('diagnostics.read', { categories: ['host', 'errors', 'runtime'] })), calls: await calls() });
    await page?.screenshot({ path: join(evidence, 'failure-' + name + '.png'), fullPage: true }).catch(() => {});
  }
  await app?.evaluate(()=>{(globalThis as MainGlobal).__p7Gate.drop=[];}).catch(()=>{});
});

const timeline=()=>page.getByTestId('run-timeline');
const temporaryBody=()=>page.getByTestId('temporary-run-area');
async function drop(types:string[]){await app.evaluate((_,types)=>{(globalThis as MainGlobal).__p7Gate.drop=types;},types);}
async function events(runId:number){const result=await page.evaluate(runId=>window.medclaw.request('event.read',{runId,afterSequence:0,limit:100}),runId);if(!result.ok)throw new Error(result.error.code);return result.data;}
async function runtimeTab(){if(!await page.getByRole('tab',{name:'Run details',exact:true}).count())await page.getByRole('button',{name:'View run details',exact:true}).click();await page.getByRole('tab',{name:'Run details',exact:true}).click();await expect(page.getByRole('tab',{name:'Run details',exact:true})).toHaveAttribute('aria-selected','true');await page.getByRole('button',{name:'Refresh recent runs',exact:true}).click();}
async function assertTimeline(runId:number){await runtimeTab();const facts=await events(runId);await expect(timeline()).toHaveAttribute('data-run-id',String(runId));await expect(timeline()).toHaveAttribute('data-cursor',String(facts.range.lastSequence));expect(await timeline().locator('[data-event-sequence]').evaluateAll(nodes=>nodes.map(n=>Number(n.getAttribute('data-event-sequence'))))).toEqual(facts.events.map(e=>e.sequence));return facts;}
async function settled(text:string){await create();steps=[()=>({text})];const accepted=await clickSubmit(text);if(!accepted.runId)throw new Error('Missing Run');await idle();await expect(page.getByText('Saved',{exact:true})).toBeVisible();return {...accepted,runId:accepted.runId};}
function receipt(wire:Wire,id:string):Record<string,unknown>{const returned=wire.messages.filter(m=>m.role==='tool'&&m.tool_call_id===id);expect(returned).toHaveLength(1);return JSON.parse(String(returned[0]!.content));}


test('A13 new Host instance restores saved selection once and starts no Run or model', async () => {
  await expect.poll(async () => (await calls()).filter(call => call.method === 'workspace.restore').length).toBe(1);
  expect(sql('SELECT count(*) AS n FROM runs')[0].n).toBe(0);
  expect(physical).toBe(0);
  save('A13-startup', { calls: await calls(), workspace: sql('SELECT * FROM workspace'), physical });
});

test('A11 New Session holds the shared selection gate and retains the current draft', async () => {
  const original = await create(); await input().fill('Draft survives new Session confirmation');
  await rules([{ method: 'session.create', hold: 'create-selection', before: true }]);
  await page.getByRole('button', { name: 'New Session', exact: true }).click(); await entered('create-selection');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply 0 selected batches', exact: true })).toBeDisabled();
  await release('create-selection');
  await expect.poll(() => page.evaluate(async () => { const w = await window.medclaw.request('workspace.read', {}); return w.ok ? w.data.sessionId : null; })).not.toBe(original);
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); await select(original);
  await expect(input()).toHaveValue('Draft survives new Session confirmation');
  expect(sql('SELECT count(*) AS n FROM runs')[0].n).toBe(0); expect(physical).toBe(0);
  save('A11-creation-gate', { calls: await calls(), workspace: sql('SELECT * FROM workspace'), physical });
});

test('A08 definite restore failure can be explicitly verified in the same Host instance', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const existing = await create();
  await rules([{ method: 'workspace.restore', project: { ok: false, error: safeError('storage_read_failed') } }]);
  await page.reload(); await page.getByRole('button', { name: 'Data Workspace', exact: true }).click(); await expect(page.getByText('Selection unconfirmed', { exact: true }).last()).toBeVisible();
  const before = (await calls()).filter(call => call.method === 'workspace.restore').length;
  const host = await page.evaluate(() => window.medclaw.request('host.read', {}));
  await expect(page.locator(`.session-row[data-session-id="${existing}"]`).locator('button[aria-pressed]')).toBeDisabled();
  await page.evaluate(() => window.medclaw.request('workspace.read', {}));
  await expect(page.getByRole('button', { name: 'Apply 0 selected batches', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.locator('.chat-data-context > summary').click();
  await expect(page.getByRole('button', { name: 'Verify saved selection', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Verify saved selection', exact: true }).click();
  await expect.poll(async () => (await calls()).filter(call => call.method === 'workspace.restore').length).toBe(before + 1);
  await expect(page.getByText('Selection unconfirmed', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.medclaw.request('host.read', {}))).toEqual(host);
  save('A08-manual-verify', { calls: await calls(), host, workspace: sql('SELECT * FROM workspace'), physical });
});

test('A05 a lost creation receipt can recover its original identity without creating a second Session', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const before = sql('SELECT count(*) AS n FROM sessions WHERE kind=\'user\'')[0].n;
  await rules([{ method: 'session.create', project: { ok: false, error: safeError('operation_result_unknown') } }]);
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  const recover = page.getByRole('button', { name: 'Recover original creation', exact: true });
  await expect(recover).toBeEnabled();
  expect(sql('SELECT count(*) AS n FROM sessions WHERE kind=\'user\'')[0].n).toBe(before + 1);
  const created = sql('SELECT active_session_id FROM workspace')[0].active_session_id;
  await recover.click(); await expect(recover).toHaveCount(0);
  await expect(page.getByTestId('current-session')).toContainText(await sessionTitle(created));
  expect(sql('SELECT count(*) AS n FROM sessions WHERE kind=\'user\'')[0].n).toBe(before + 1);
  const requests = (await calls()).filter(call => call.method === 'session.create').slice(-2);
  expect(requests[0]).toEqual(requests[1]);
  expect(sql('SELECT count(*) AS n FROM runs')[0].n).toBe(0); expect(physical).toBe(0);
  save('A05-original-create-recovery', { requests, created, workspace: sql('SELECT * FROM workspace') });
});



test('A03 device and change choices use saved stable identities and server versions', async () => {
  await create(); await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Choose snapshot directory', exact: true }).click(); await expect(page.getByTestId('import-state')).toHaveText('ready');
  await page.getByRole('button', { name: 'Confirm import', exact: true }).click(); await expect(page.getByTestId('import-state')).toHaveText('imported');
  await page.getByRole('button', { name: 'Select batches on this page', exact: true }).click(); await page.getByRole('button', { name: 'Apply 2 selected batches', exact: true }).click();
  await page.getByRole('button', { name: 'Read batch 2 devices', exact: true }).click();
  await expect(page.getByTestId('data-rows')).toBeVisible();
  const identity = sql('SELECT id,device_id FROM snapshots WHERE batch_id=2 ORDER BY id')[0];
  await page.getByRole('button', { name: `Select snapshot ${identity.id}`, exact: true }).click();
  await expect(page.getByTestId('confirmed-selection').last()).toContainText(`snapshot:${identity.id}`);
  const device = sql('SELECT * FROM workspace')[0], selection = JSON.parse(device.selection_json);
  expect(selection).toMatchObject({ kind: 'device', targetId: String(identity.device_id), rowKey: `snapshot:${identity.id}`, field: null });
  expect(selection.targetVersion).toBe('batch:2:p4-fixture/v1');
  await page.getByRole('button', { name: 'Read batch 2 changes', exact: true }).click();
  const event = sql('SELECT id FROM change_events WHERE new_batch_id=2 ORDER BY id')[0];
  await page.getByRole('button', { name: `Select change ${event.id}`, exact: true }).click();
  await expect(page.getByTestId('confirmed-selection').last()).toContainText(`change:${event.id}`);
  expect(JSON.parse(sql('SELECT selection_json FROM workspace')[0].selection_json)).toMatchObject({ kind: 'change', targetId: String(event.id), rowKey: `change:${event.id}` });
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  expect(sql('SELECT selection_json FROM workspace')[0].selection_json).toBeNull();
  save('A03-data-selection', { device, workspace: sql('SELECT * FROM workspace'), physical });
});

test('A10 unknown selection remains locked after read until explicit Host restart', async () => {
  await create(); await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Clear batch selection', exact: true }).click();
  await rules([{ method: 'workspace.update', project: { ok: false, error: safeError('operation_result_unknown') } }]);
  const before = (await calls()).filter(call => call.method === 'workspace.update').length;
  await page.getByRole('button', { name: 'Apply 0 selected batches', exact: true }).click();
  await expect(page.getByText('Verify status in Settings and restart the Host.', { exact: true }).last()).toBeVisible();
  await page.evaluate(() => window.medclaw.request('workspace.read', {}));
  await expect(page.getByRole('button', { name: 'Apply 0 selected batches', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Verify saved selection', exact: true })).toHaveCount(0);
  expect((await calls()).filter(call => call.method === 'workspace.update')).toHaveLength(before + 1);
  const oldHost = await page.evaluate(() => window.medclaw.request('host.read', {}));
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Restart Host', exact: true }).click();
  await expect.poll(async () => { const host = await page.evaluate(() => window.medclaw.request('host.read', {})); return host.ok && oldHost.ok && host.data.state === 'ready' && host.data.instanceId !== oldHost.data.instanceId; }).toBe(true);
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply 0 selected batches', exact: true })).toBeEnabled();
  expect(sql('SELECT count(*) AS n FROM runs')[0].n).toBe(0); expect(physical).toBe(0);
  save('A10-unknown-restart', { oldHost, host: await page.evaluate(() => window.medclaw.request('host.read', {})), calls: await calls(), workspace: sql('SELECT * FROM workspace'), physical });
});

test('A12 viewing B keeps the running A ownership, frozen Input and Stop target', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const original = await savedQuery();
  await page.getByRole('button', { name: `Use Query ${original.queryId} for next message`, exact: true }).click();
  const held = gate(); steps = [() => ({ text: 'A owns this live answer.', endGate: held })];
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const acceptedA = await clickSubmit('Keep running A'); await held.entered;
  await expect(page.getByTestId('running-session')).toContainText(await sessionTitle(original.sessionId));
  const b = await create(); await input().fill('B draft remains unsent');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.getByTestId('running-session')).toContainText(`Run ${acceptedA.runId}`);
  await expect(page.getByTestId('stop-target')).toContainText(`Session ${original.sessionId}`);
  await expect(page.getByTestId('chat-scroll')).not.toContainText('A owns this live answer.');
  if (!await page.locator('.chat-data-context').evaluate(element => (element as HTMLDetailsElement).open)) await page.locator('.chat-data-context > summary').click();
  await expect(page.getByTestId('frozen-input-context')).toContainText(`Input ${acceptedA.inputId}`);
  await expect(page.getByTestId('frozen-input-context')).toContainText(`Query ${original.queryId}`);
  await runtimeTab(); await page.getByRole('button', { name: `View Run ${original.runId}`, exact: true }).click();
  await expect(timeline()).toHaveAttribute('data-run-id',String(original.runId));
  await expect(page.getByRole('tabpanel',{name:'Run details',exact:true})).toBeVisible();
  const before = sql('SELECT * FROM workspace')[0];
  await page.getByRole('button', { name: `Read original Query ${original.queryId}`, exact: true }).first().click();
  await expect(page.getByTestId('query-results')).toBeVisible(); expect(sql('SELECT * FROM workspace')[0]).toEqual(before);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click(); held.release(); await idle();
  const stops = (await calls()).filter(call => call.method === 'run.cancel').slice(-1); expect(stops[0].payload.runId).toBe(acceptedA.runId);
  const fact = await readRun(acceptedA.runId!); expect(fact).toMatchObject({ sessionId: original.sessionId, status: 'cancelled' });
  expect(sql(`SELECT count(*) AS n FROM runs WHERE session_id=${b}`)[0].n).toBe(0);
  await expect(input()).toHaveValue('B draft remains unsent');
  expect((await events(acceptedA.runId!)).events.every(event => event.runId === acceptedA.runId)).toBe(true);
  save('A12-active-A-view-B', { original, b, acceptedA, stops, run: fact, input: await readInput(acceptedA.inputId!), workspace: sql('SELECT * FROM workspace'), events: await events(acceptedA.runId!), physical });
});

test('A14 old Query and Evidence replies cannot replace a newer independent detail target', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); const a = await savedQuery();
  const viewA = await page.evaluate(queryId => window.medclaw.request('query.read', { queryId }), a.queryId); if (!viewA.ok) throw Error(viewA.error.code);
  await rules([{ method: 'query.read', hold: 'old-query-reply' }]);
  await page.getByRole('button', { name: `Read Query ${a.queryId} from Run ${a.runId}`, exact: true }).click(); await entered('old-query-reply');
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); const b = await savedQuery();
  const before = sql('SELECT * FROM workspace')[0]; await release('old-query-reply');
  await expect(page.getByText(`Viewing Query ${b.queryId} from Session ${b.sessionId}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`Viewing Query ${a.queryId} from Session ${a.sessionId}`, { exact: true })).toHaveCount(0);
  const viewB = await page.evaluate(queryId => window.medclaw.request('query.read', { queryId }), b.queryId); if (!viewB.ok) throw Error(viewB.error.code);
  await rules([{ method: 'evidence.read', hold: 'old-evidence-reply' }]);
  await page.getByRole('button', { name: `Read evidence ${viewB.data.page.evidenceIds[0]}`, exact: true }).click(); await entered('old-evidence-reply');
  await select(a.sessionId); await page.getByRole('button', { name: `Read Query ${a.queryId} from Run ${a.runId}`, exact: true }).click();
  await page.getByRole('button', { name: `Read evidence ${viewA.data.page.evidenceIds[0]}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: `Evidence ${viewA.data.page.evidenceIds[0]}`, exact: true })).toBeVisible();
  const final = sql('SELECT * FROM workspace')[0]; await release('old-evidence-reply');
  await expect(page.getByRole('heading', { name: `Evidence ${viewB.data.page.evidenceIds[0]}`, exact: true })).toHaveCount(0);
  expect(sql('SELECT * FROM workspace')[0]).toEqual(final);
  save('A14-old-details', { a, b, before, final, calls: await calls() });
});

test('A13 nonempty saved selection restores once after explicit Host restart without automatic execution', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); const original = await savedQuery();
  const view = await page.evaluate(queryId => window.medclaw.request('query.read', { queryId }), original.queryId); if (!view.ok) throw Error(view.error.code);
  await page.getByRole('button', { name: `Select Query ${original.queryId} ${view.data.page.rowKeys[0]} field deltaCents`, exact: true }).click();
  await expect.poll(() => sql('SELECT active_query_id FROM workspace')[0].active_query_id).toBe(original.queryId);
  const before = sql('SELECT * FROM workspace')[0], models = physical, count = sql('SELECT count(*) AS n FROM runs')[0].n, restores = (await calls()).filter(call => call.method === 'workspace.restore').length;
  const old = await page.evaluate(() => window.medclaw.request('host.read', {}));
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Restart Host', exact: true }).click();
  await expect.poll(async () => { const host = await page.evaluate(() => window.medclaw.request('host.read', {})); return host.ok && old.ok && host.data.state === 'ready' && host.data.instanceId !== old.data.instanceId; }).toBe(true);
  await expect.poll(async () => (await calls()).filter(call => call.method === 'workspace.restore').length).toBe(restores + 1);
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click(); await expect(page.getByTestId('confirmed-selection').last()).toContainText(view.data.page.rowKeys[0]!);
  expect(sql('SELECT * FROM workspace')[0]).toEqual(before); expect(physical).toBe(models); expect(sql('SELECT count(*) AS n FROM runs')[0].n).toBe(count);
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); await input().fill('No automatic history resurrection');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  const detail = await page.evaluate(sessionId => window.medclaw.request('session.read', { sessionId }), original.sessionId);
  expect(detail).toMatchObject({ ok: true, data: { history: { available: true },runtime:{availability:'unloaded'} } });
  save('A13-nonempty-restart', { old, host: await page.evaluate(() => window.medclaw.request('host.read', {})), before, workspace: sql('SELECT * FROM workspace'), detail, models, count });
});

async function dataScope() {
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
  const catalog = await page.evaluate(() => window.medclaw.request('data.read', {}));
  if (!catalog.ok || !catalog.data.batchCount) {
    await page.getByRole('button', { name: 'Choose snapshot directory', exact: true }).click(); await expect(page.getByTestId('import-state')).toHaveText('ready');
    await page.getByRole('button', { name: 'Confirm import', exact: true }).click(); await expect(page.getByTestId('import-state')).toHaveText('imported');
  }
  await page.getByRole('button', { name: 'Select batches on this page', exact: true }).click(); await page.getByRole('button', { name: 'Apply 2 selected batches', exact: true }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
}
async function savedQuery() {
  const sessionId = await create(); await dataScope();
  let queryId = 0;
  steps = [() => ({ id: 'p7-source-scope', name: 'read_data_scope', args: {} }), wire => ({ id: 'p7-source-query', name: 'query_device_changes', args: { batchIds: (receipt(wire, 'p7-source-scope').scope as {batchIds:number[]}).batchIds, time: { start: '2026-01-02', endExclusive: '2026-01-03' }, changeField: 'price', direction: 'decrease', page: 1, pageSize: 50 } }), wire => { queryId = receipt(wire, 'p7-source-query').queryId as number; return { text: 'Three saved device decreases.' }; }];
  const accepted = await clickSubmit('Create saved P7 Query'); await idle(); expect(queryId).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Query History', exact: true }).click();
  await page.getByRole('button', { name: `Read Query ${queryId} from Run ${accepted.runId}`, exact: true }).click();
  await expect(page.getByTestId('query-results')).toBeVisible(); return { sessionId, queryId, runId: accepted.runId! };
}

test('A03 Query row and field selections use immutable page sidecars', async () => {
  const query = await savedQuery(), saved = sql(`SELECT result_json FROM queries WHERE id=${query.queryId}`)[0];
  const viewed = await page.evaluate(queryId => window.medclaw.request('query.read', { queryId }), query.queryId); if (!viewed.ok) throw Error(viewed.error.code);
  const key = viewed.data.page.rowKeys[0]!;
  await page.getByRole('button', { name: `Select Query ${query.queryId} ${key} field deltaCents`, exact: true }).click();
  await expect.poll(() => sql('SELECT selection_json FROM workspace')[0].selection_json).not.toBeNull();
  const workspace = sql('SELECT * FROM workspace')[0];
  expect(JSON.parse(workspace.selection_json)).toMatchObject({ kind: 'query-row', targetId: String(query.queryId), targetVersion: viewed.data.page.targetVersion, rowKey: key, field: 'deltaCents' });
  expect(sql(`SELECT result_json FROM queries WHERE id=${query.queryId}`)[0]).toEqual(saved);
  const evidenceId = viewed.data.page.evidenceIds[0]!; await page.getByRole('button', { name: `Read evidence ${evidenceId}`, exact: true }).click();
  await page.getByRole('button', { name: `Select Evidence ${evidenceId}`, exact: true }).click();
  await expect.poll(() => JSON.parse(sql('SELECT selection_json FROM workspace')[0].selection_json).kind).toBe('evidence');
  save('A03-query-evidence', { query, saved, viewed: viewed.data, workspace: sql('SELECT * FROM workspace'), providerRequests: physical });
});

test('A04 opening original Query across Sessions reads its owner without adopting it', async () => {
  const original = await savedQuery(); await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const viewedSession = await create(), before = sql('SELECT * FROM workspace')[0];
  await runtimeTab(); await page.getByRole('button', { name: `View Run ${original.runId}`, exact: true }).click();
  await page.getByRole('button', { name: `Read original Query ${original.queryId}`, exact: true }).first().click();
  await expect(page.getByTestId('query-results')).toBeVisible();
  expect(sql('SELECT * FROM workspace')[0]).toEqual(before);
  await expect(page.getByRole('button', { name: `Use Query ${original.queryId} for next message`, exact: true })).toBeDisabled();
  await expect(page.getByText(`Viewing Query ${original.queryId} from Session ${original.sessionId}`, { exact: true })).toBeVisible();
  const denied = await page.evaluate(({ queryId, revision }) => window.medclaw.request('workspace.update', { expectedRevision: revision, change: { queryId } }), { queryId: original.queryId, revision: before.revision });
  expect(denied).toMatchObject({ ok: false, error: { code: 'access_denied' } });
  expect(sql('SELECT active_session_id FROM workspace')[0].active_session_id).toBe(viewedSession);
  save('A04-independent-query', { original, viewedSession, before, denied, workspace: sql('SELECT * FROM workspace'), physical });
});

test('A06 A07 accepted Query field stays frozen while the current batch changes', async () => {
  const original = await savedQuery();
  const viewed = await page.evaluate(queryId => window.medclaw.request('query.read', { queryId }), original.queryId); if (!viewed.ok) throw Error(viewed.error.code);
  const rowKey = viewed.data.page.rowKeys[0]!;
  await page.getByRole('button', { name: `Select Query ${original.queryId} ${rowKey} field deltaCents`, exact: true }).click();
  await expect.poll(() => sql('SELECT active_query_id FROM workspace')[0].active_query_id).toBe(original.queryId);
  const frozen = JSON.parse(sql('SELECT selection_json FROM workspace')[0].selection_json), originalRevision = sql('SELECT revision FROM workspace')[0].revision;
  const held = gate(), beforeRequests = physical; let nextQuery = 0, delivered: unknown;
  steps = [async () => { held.enter(); await held.response; return { id: 'p7-frozen-scope', name: 'read_data_scope', args: {} }; }, wire => {
    const output = receipt(wire, 'p7-frozen-scope'), workspace = output.workspaceContext as {queryId:number;revision:number;selection:unknown}; delivered = output;
    expect(workspace).toMatchObject({ queryId: original.queryId, revision: originalRevision, selection: frozen });
    return { id: 'p7-frozen-query', name: 'query_device_changes', args: { batchIds: (output.scope as {batchIds:number[]}).batchIds, time: { start: '2026-01-02', endExclusive: '2026-01-03' }, changeField: 'price', direction: 'decrease', page: 1, pageSize: 50 } };
  }, wire => { nextQuery = receipt(wire, 'p7-frozen-query').queryId as number; return { text: 'The original saved row decreased within its original batches.' }; }];
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); const accepted = await clickSubmit('这一项为什么下降？'); await held.entered;
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click(); await page.getByLabel('Select batch 1', { exact: true }).uncheck(); await page.getByRole('button', { name: 'Apply 1 selected batches', exact: true }).click();
  await expect.poll(() => JSON.parse(sql('SELECT batch_refs_json FROM workspace')[0].batch_refs_json).map((ref:{id:number}) => ref.id)).toEqual([2]);
  held.release(); await idle(); expect(nextQuery).toBeGreaterThan(original.queryId);
  const inputFact = sql(`SELECT * FROM session_inputs WHERE id=${accepted.inputId}`)[0], runFact = sql(`SELECT * FROM runs WHERE id=${accepted.runId}`)[0], queryFact = sql(`SELECT * FROM queries WHERE id=${nextQuery}`)[0];
  expect(JSON.parse(inputFact.content_json).workspaceContext).toMatchObject({ revision: originalRevision, queryId: original.queryId, selection: frozen });
  expect(JSON.parse(runFact.workspace_json).selection).toEqual(frozen); expect(JSON.parse(runFact.scope_json).batchIds).toEqual([1,2]);
  expect(JSON.parse(queryFact.params_json).batchIds).toEqual([1,2]); expect(queryFact.based_on_query_id).toBe(original.queryId);
  expect(physical - beforeRequests).toBe(3);
  save('A06-A07-driving-task', { original, accepted, frozen, originalRevision, delivered, inputFact, runFact, queryFact, currentWorkspace: sql('SELECT * FROM workspace'), providerRequests: physical - beforeRequests, wires: wires.slice(-3) });
});

test('A11 stale Apply preserves the user selection draft and requires explicit confirmation', async () => {
  await create(); await dataScope(); await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
  await page.getByLabel('Select batch 1', { exact: true }).uncheck();
  await rules([{ method: 'workspace.update', hold: 'stale-apply', before: true }]);
  const revision=sql('SELECT revision FROM workspace')[0].revision;
  await page.getByRole('button', { name: 'Apply 1 selected batches', exact: true }).click();await entered('stale-apply');
  const newer=await page.evaluate(revision=>window.medclaw.request('workspace.update',{expectedRevision:revision,change:{batchIds:[1]}}),revision);expect(newer.ok).toBe(true);
  await release('stale-apply');await expect(page.getByText('Selection unconfirmed',{exact:true}).last()).toBeVisible();
  await expect(page.getByLabel('Select batch 1',{exact:true})).not.toBeChecked();await expect(page.getByLabel('Select batch 2',{exact:true})).toBeChecked();
  await page.getByRole('button',{name:'Verify saved selection',exact:true}).click();await expect(page.getByRole('button',{name:'Apply 1 selected batches',exact:true})).toBeEnabled();
  const before=sql('SELECT * FROM workspace')[0];await page.getByRole('button',{name:'Apply 1 selected batches',exact:true}).click();
  await expect.poll(()=>JSON.parse(sql('SELECT batch_refs_json FROM workspace')[0].batch_refs_json).map((ref:{id:number})=>ref.id)).toEqual([2]);
  save('A11-conflict-draft',{newer,before,workspace:sql('SELECT * FROM workspace'),calls:await calls()});
});


test('A11 fast Session choices confirm the latest target without replaying intermediate intent',async()=>{
  await page.getByRole('button',{name:'Chat',exact:true}).click();
  const a=await create(),b=await create(),c=await create(),before=(await calls()).length,runCount=sql('SELECT count(*) AS n FROM runs')[0].n,modelCount=physical;
  await rules([{method:'session.select',sessionId:a,hold:'first-session-choice',before:true}]);
  await page.locator(`.session-row[data-session-id="${a}"]`).locator('button[aria-pressed]').click();await entered('first-session-choice');
  await page.locator(`.session-row[data-session-id="${b}"]`).locator('button[aria-pressed]').click();await page.locator(`.session-row[data-session-id="${c}"]`).locator('button[aria-pressed]').click();await release('first-session-choice');
  await expect(page.getByTestId('current-session')).toContainText(await sessionTitle(c));
  await expect.poll(()=>sql('SELECT active_session_id FROM workspace')[0].active_session_id).toBe(c);
  const selected=(await calls()).slice(before).filter(call=>call.method==='session.select').map(call=>call.payload.sessionId);expect(selected).toEqual([a,c]);
  expect(sql('SELECT count(*) AS n FROM runs')[0].n).toBe(runCount);expect(physical).toBe(modelCount);
  save('A11-latest-target',{a,b,c,selected,workspace:sql('SELECT * FROM workspace'),runCount,modelCount});
});

async function notifyConfigChanged() {
  const host = await page.evaluate(() => window.medclaw.request('host.read', {}));
  const directory = await page.evaluate(() => window.medclaw.request('model.read', {}));
  if (!host.ok || !directory.ok) throw Error('Host not ready');
  await app.evaluate(({ BrowserWindow }, notice) => BrowserWindow.getAllWindows()[0].webContents.send('medclaw:notice', notice), { type: 'config.changed', instanceId: host.data.instanceId, configVersion: directory.data.configVersion });
}

test('A11 equal revision notices are neutral but contradictory state requires a fact read and explicit verification', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); await create(); await dataScope();
  const saved = await page.evaluate(() => window.medclaw.request('workspace.read', {})); if (!saved.ok) throw Error(saved.error.code);
  await rules([{ method: 'workspace.read', project: { ok: true, data: { ...saved.data, notices: [{ code: 'reference_cleared', kind: 'selection', targetId: '999' }] } } }]);
  await notifyConfigChanged(); await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply 2 selected batches', exact: true })).toBeEnabled();
  const reads = (await calls()).filter(call => call.method === 'workspace.read').length;
  await rules([{ method: 'workspace.read', project: { ok: true, data: { ...saved.data, deviceIds: [1] } } }]); await notifyConfigChanged();
  await expect(page.getByText('The selection reply is inconsistent. Verify the saved selection before continuing.', { exact: true })).toBeVisible();
  await expect.poll(async () => (await calls()).filter(call => call.method === 'workspace.read').length).toBe(reads + 2);
  await expect(page.getByRole('button', { name: 'Apply 2 selected batches', exact: true })).toBeDisabled();
  expect(sql('SELECT device_ids_json FROM workspace')[0].device_ids_json).toBe('[]');
  await page.getByRole('button', { name: 'Verify saved selection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply 2 selected batches', exact: true })).toBeEnabled();
  save('A11-equal-revision', { saved: saved.data, workspace: sql('SELECT * FROM workspace'), calls: await calls() });
});

test('A11 rejected selection receipt preserves the latest Session intent until explicit confirmation', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); const a = await create(), b = await create(); await select(a);
  const saved = await page.evaluate(() => window.medclaw.request('workspace.read', {})); if (!saved.ok) throw Error(saved.error.code);
  await rules([{ method: 'session.select', sessionId: a, hold: 'inconsistent-session', project: { ok: true, data: { ...saved.data, activeView: 'query' } } }]);
  const before = (await calls()).filter(call => call.method === 'session.select').length;
  await page.locator(`.session-row[data-session-id="${a}"]`).locator('button[aria-pressed]').click(); await entered('inconsistent-session');
  await page.locator(`.session-row[data-session-id="${b}"]`).locator('button[aria-pressed]').click(); await release('inconsistent-session');
  await expect(page.getByRole('button', { name: `Confirm Session ${b}`, exact: true })).toBeDisabled();
  expect((await calls()).filter(call => call.method === 'session.select')).toHaveLength(before + 1);
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click(); await page.getByRole('button', { name: 'Verify saved selection', exact: true }).click();
  await expect(page.getByRole('button', { name: `Confirm Session ${b}`, exact: true })).toBeEnabled();
  expect(sql('SELECT active_session_id FROM workspace')[0].active_session_id).toBe(a);
  await page.getByRole('button', { name: `Confirm Session ${b}`, exact: true }).click();
  await expect.poll(() => sql('SELECT active_session_id FROM workspace')[0].active_session_id).toBe(b);
  save('A11-rejected-receipt', { a, b, calls: await calls(), workspace: sql('SELECT * FROM workspace') });
});

test('A08 transient ordinary Workspace read failure offers same-instance verification', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); await create(); await dataScope();
  const host = await page.evaluate(() => window.medclaw.request('host.read', {})), before = sql('SELECT * FROM workspace')[0];
  await rules([{ method: 'workspace.read', project: { ok: false, error: safeError('storage_read_failed') } }]); await notifyConfigChanged();
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
  await expect(page.getByText('Selection unconfirmed', { exact: true }).last()).toBeVisible();
  const verify = page.getByRole('button', { name: 'Verify saved selection', exact: true }); await expect(verify).toBeEnabled();
  await notifyConfigChanged(); await expect(page.getByRole('button', { name: 'Apply 2 selected batches', exact: true })).toBeDisabled();
  await verify.click(); await expect(page.getByRole('button', { name: 'Apply 2 selected batches', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.medclaw.request('host.read', {}))).toEqual(host);
  expect(sql('SELECT * FROM workspace')[0]).toEqual(before);
  save('A08-ordinary-read-recovery', { host, before, workspace: sql('SELECT * FROM workspace'), calls: await calls() });
});

test('A10 truly slow restore stays locked after late commit and cannot be unlocked by old creation recovery', async () => {
  test.setTimeout(60000);
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); await create(); await dataScope();
  await rules([{ method: 'session.create', project: { ok: false, error: safeError('operation_result_unknown') } }]);
  await page.getByRole('button', { name: 'New Session', exact: true }).click(); await expect(page.getByRole('button', { name: 'Recover original creation', exact: true })).toBeEnabled();
  writeFileSync(join(temporary, 'hold-restore'), 'hold');
  const beforeCalls = (await calls()).filter(call => call.method === 'workspace.restore').length;
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Restart Host', exact: true }).click();
  await expect.poll(() => existsSync(join(temporary, 'entered-restore')),{timeout:15000}).toBe(true);
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
  await expect(page.getByText('Verify status in Settings and restart the Host.', { exact: true }).last()).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Recover original creation', exact: true })).toBeDisabled();
  rmSync(join(temporary, 'hold-restore')); const read = await page.evaluate(() => window.medclaw.request('workspace.read', {}));
  expect(read.ok).toBe(true); await notifyConfigChanged();
  await expect(page.getByRole('button', { name: 'Apply 2 selected batches', exact: true })).toBeDisabled();
  expect((await calls()).filter(call => call.method === 'workspace.restore')).toHaveLength(beforeCalls + 1);
  const runs = sql('SELECT count(*) AS n FROM runs')[0].n, models = physical;
  expect(await page.evaluate(() => window.medclaw.request('host.read', {}))).toMatchObject({ ok: true, data: { state: 'ready', error: null } });
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Restart Host', exact: true }).click();
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply 2 selected batches', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Recover original creation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Recover original creation', exact: true })).toHaveCount(0);
  expect(sql('SELECT count(*) AS n FROM runs')[0].n).toBe(runs); expect(physical).toBe(models);
  save('A10-slow-restore-ui', { read, workspace: sql('SELECT * FROM workspace'), calls: await calls(), runs, models });
});

test('A14 minimum window, keyboard row selection and 200 percent zoom keep tables and details accessible', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); const query = await savedQuery();
  const view = await page.evaluate(queryId => window.medclaw.request('query.read', { queryId }), query.queryId); if (!view.ok) throw Error(view.error.code);
  if (await page.getByRole('button', { name: 'Close run details', exact: true }).count()) await page.getByRole('button', { name: 'Close run details', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1100, 720); win.webContents.setZoomFactor(2); });
  await page.setViewportSize({ width: 1100, height: 720 });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(550);
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(360);
  await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
  const choice = page.getByRole('button', { name: `Select Query ${query.queryId} ${view.data.page.rowKeys[0]} field deltaCents`, exact: true });
  await choice.focus(); await expect(choice).toBeFocused(); await page.keyboard.press('Enter');
  const selectedBounds = await choice.boundingBox(); expect(selectedBounds).not.toBeNull();
  expect(selectedBounds!.x).toBeGreaterThanOrEqual(0); expect(selectedBounds!.x + selectedBounds!.width).toBeLessThanOrEqual(550);
  expect(selectedBounds!.y).toBeGreaterThanOrEqual(0); expect(selectedBounds!.y + selectedBounds!.height).toBeLessThanOrEqual(360);
  await expect.poll(() => JSON.parse(sql('SELECT selection_json FROM workspace')[0].selection_json).field).toBe('deltaCents');
  const table = page.getByTestId('query-results').locator('..');
  const geometry = await table.evaluate(element => ({ overflowX: getComputedStyle(element).overflowX, width: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(geometry.overflowX).toBe('auto'); expect(geometry.scrollWidth).toBeGreaterThan(geometry.width);
  await page.getByRole('button', { name: 'View run details', exact: true }).focus(); await page.keyboard.press('Enter');
  const close = page.getByRole('button', { name: 'Close run details', exact: true }); await expect(close).toBeVisible(); await close.focus(); await page.keyboard.press('Escape');
  await expect(close).toHaveCount(0); await expect(page.getByRole('button', { name: 'View run details', exact: true })).toBeFocused();
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  writeFileSync(join(evidence, 'A14-minimum-zoom-keyboard.png'), Buffer.from(png, 'base64'));
  save('A14-accessible-layout', { geometry, selectedBounds, configuredViewport: page.viewportSize(), actualViewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio })), zoomFactor: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), query, workspace: sql('SELECT * FROM workspace') });
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setZoomFactor(1); win.setSize(1440, 1000); }); await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Expand navigation', exact: true }).click();
});
