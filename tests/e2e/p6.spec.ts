import {electronTestWindowArgs} from '../fixtures/desktop-dev';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { SessionInput, SubmitResult } from '../../packages/contracts/src/session';
import { createHash } from 'node:crypto';
import { canonicalRequest } from '../../packages/contracts/src/run';
import { safeError } from '../../packages/contracts/src/error';

const root = resolve(import.meta.dirname, '../..'), bun = process.env.MEDCLAW_BUN_EXECUTABLE ?? 'bun';
let app: ElectronApplication, page: Page, temporary: string, server: Server;
type Call = { method: string; payload: Record<string, unknown>; operationRef?: string };
type Rule = { method: string; sessionId?: number; inputId?: number; runId?:number; action?:string; hold?: string; before?: boolean; legacy?: boolean; requestPatch?: Record<string, unknown>; project?: unknown };
type GateState = { drop:string[]; notices:Record<string,unknown>[];  rules: Rule[]; entered: string[]; pending: Record<string, () => void>; calls: Call[]; accepted: (SubmitResult & { mode: string; operationRef: string })[] };
type MainGlobal = typeof globalThis & { __p6Gate: GateState };
type Wire = { model: string; messages: { role: string; content: unknown; tool_call_id?:string; tool_calls?:{id:string;function:{name:string;arguments:string}}[] }[] };
type Reply = {text:string;endGate?:ReturnType<typeof gate>} | {id:string;name:string;args:unknown;leadText?:string};
let steps: ((wire: Wire) => Promise<Reply> | Reply)[] = [], physical = 0;
const wires: Wire[] = [], httpReleases: (() => void)[] = [];
const evidence = join(root, '.build/p6-event-streaming/e2e');
test.describe.configure({ mode: 'serial' });
const input = () => page.getByLabel('Message text', { exact: true });
const queue = () => page.getByTestId('input-queue');
const item = (id: number) => queue().locator(`[data-input-id="${id}"]`);
function gate() { let enter!: () => void, release!: () => void; const value = { entered: new Promise<void>(resolve => { enter = resolve; }), response: new Promise<void>(resolve => { release = resolve; }), enter: () => enter(), release: () => release() }; httpReleases.push(value.release); return value; }
async function rules(values: Rule[]) { await app.evaluate((_, values) => { (globalThis as MainGlobal).__p6Gate.rules.push(...values); }, values); }
async function entered(id: string) { await expect.poll(() => app.evaluate((_, id) => (globalThis as MainGlobal).__p6Gate.entered.includes(id), id)).toBe(true); }
async function release(id: string) { await app.evaluate((_, id) => { (globalThis as MainGlobal).__p6Gate.pending[id]?.(); }, id); }
async function calls() { return app.evaluate(() => (globalThis as MainGlobal).__p6Gate.calls); }
async function accepted() { return app.evaluate(() => (globalThis as MainGlobal).__p6Gate.accepted); }
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
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const csv = (values: string[]) => values.map(value => `"${value.replaceAll('"', '""')}"`).join(',');
  const names = ['A decrease one', 'A decrease two', 'Original manufacturer decrease', 'B unique increase device'];
  const masters = names.map((device_name, i) => ({ record_type: 'master', device_id: String(i + 1).padStart(5, '0'), device_name, source_submission_id: String(i + 1).padStart(5, '0'), source_applicant: 'Synthetic Applicant', category: 'Category', manufacturer: i === 2 ? '模拟厂家-02' : '模拟厂家-01' }));
  const sourceLock = { schema: 'medclaw.source-lock/v1', sources: [{ source: 'fixture', path: 'original.csv', sha256: 'a'.repeat(64) }] };
  const lockHash = hash(canonicalRequest(sourceLock)), cohortHash = hash(canonicalRequest(masters));
  writeFileSync(join(directory, 'source-lock.json'), JSON.stringify(sourceLock)); writeFileSync(join(directory, 'entity-lineage.csv'), `${csv(Object.keys(masters[0]!))}\n${masters.map(master => csv(Object.values(master))).join('\n')}\n`);
  for (const name of ['adjustment-lineage.csv', 'validation-report.json', 'selection-report.json', '使用说明.md']) writeFileSync(join(directory, name), name.endsWith('.json') ? '{}' : 'fixture');
  const columns = ['device_id', 'device_name', 'source_submission_id', 'source_applicant', 'category', 'region', 'snapshot_date', 'price_cents', 'currency', 'unit', 'status', 'manufacturer', 'distributor', 'source_refs_json', 'field_origins_json'];
  const origins = Object.fromEntries(columns.slice(0, 13).map(key => [key, { kind: 'synthetic', ruleId: 'p4-fixture' }]));
  for (const [index, prices] of [[10000, 20000, 10000, 10000], [8000, 15000, 9000, 12000]].entries()) {
    const date = `2026-01-0${index + 1}`;
    const text = `${csv(columns)}\n${masters.map((master, ordinal) => csv([master.device_id, master.device_name, master.source_submission_id, master.source_applicant, 'Category', '浙江', date, String(prices[ordinal]), 'CNY', '件', 'active', master.manufacturer, ordinal === 1 ? '模拟配送-02' : '模拟配送-01', JSON.stringify([{ sourceId: 'fixture', file: 'original.csv', row: ordinal + 1, recordId: master.source_submission_id, sha256: 'a'.repeat(64) }]), JSON.stringify(origins)])).join('\n')}\n`;
    writeFileSync(join(directory, `zhejiang_${date}.csv`), text); writeFileSync(join(directory, `zhejiang_${date}.metadata.json`), JSON.stringify({ contract: 'medclaw.snapshot/v1', mappingVersion: 'medclaw.snapshot/v1', materialVersion: 'p4-fixture/v1', generatorVersion: 'p4-fixture/v1', seed: 1, sourceBundleId: 'p4-fixture', sourceLockHash: lockHash, scopeKey: 'p4-zhejiang', region: '浙江', cohortHash, snapshotDate: date, coverage: 'full', expectedEntityCount: 4, observedEntityCount: 4, declaredMissingEntityIds: [], fileSha256: hash(text), referenceDate: '2026-01-02', timezone: 'Asia/Shanghai' }));
  }
  const files = readdirSync(directory).filter(path => path !== 'manifest.json').sort().map(path => { const bytes = readFileSync(join(directory, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }; });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ status: 'complete', files, businessFiles: 2, businessRows: 8, businessBytes: files.filter(file => /^zhejiang_.*\.csv$/.test(file.path)).reduce((sum, file) => sum + file.bytes, 0), totalPayloadBytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
}


test.beforeAll(async () => {
  test.setTimeout(90000);
  for (const part of ['main', 'preload']) execFileSync(bun, ['build', `apps/desktop/src/${part}/index.ts`, '--target=node', '--format=cjs', '--external=electron', `--outfile=.build/desktop/${part}/index.cjs`], { cwd: root });
  execFileSync(bun, ['build', 'apps/desktop/src/renderer/index.html', '--target=browser', '--outdir=.build/desktop/renderer'], { cwd: root });
  temporary = mkdtempSync(join(tmpdir(), 'medclaw-p6-desktop-')); snapshotPackage(join(temporary,'source'));
  server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const wire = JSON.parse(body) as Wire; wires.push(wire); physical++;
    const next = steps.shift(); if (!next) { response.writeHead(500); response.end('No controlled fixture step'); return; }
    const reply = await next(wire); if (response.destroyed) return;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta='text' in reply ? {role:'assistant',content:reply.text} : {role:'assistant',content:reply.leadText,tool_calls:[{index:0,id:reply.id,type:'function',function:{name:reply.name,arguments:JSON.stringify(reply.args)}}]};
    response.write('data: '+JSON.stringify({id:'p6-response',model:wire.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
    if('text' in reply && reply.endGate){reply.endGate.enter();await reply.endGate.response;}
    response.write('data: '+JSON.stringify({id:'p6-response',model:wire.model,choices:[{index:0,delta:{},finish_reason:'text' in reply?'stop':'tool_calls'}]})+'\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const seam = join(temporary, 'public-gates.cjs');
  writeFileSync(seam, `const {ipcMain,app}=require('electron'); const original=ipcMain.handle.bind(ipcMain);
    const state=globalThis.__p6Gate={rules:[],entered:[],pending:{},calls:[],accepted:[],drop:[],notices:[]};
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
  const hostEntry=join(temporary,'p6-host.ts');
  writeFileSync(hostEntry,`import {existsSync,writeFileSync} from 'node:fs';import {ToolExecutor} from ${JSON.stringify(join(root,'packages/core/src/tools/executor.ts'))};import {EventService} from ${JSON.stringify(join(root,'packages/core/src/events/event-service.ts'))};
  for(const name of ['subscribe','close','closeAll']){const old=EventService.prototype[name];EventService.prototype[name]=function(...args){try{return old.apply(this,args);}finally{writeFileSync(${JSON.stringify(join(temporary,'subscriptions.json'))},JSON.stringify({count:this.subscriptions.size}));}};}
  const original=ToolExecutor.prototype.execute;ToolExecutor.prototype.execute=async function(...args){if(args[2]?.nativeToolCallId==='p6-long-tool'){while(!existsSync(${JSON.stringify(join(temporary,'release-tool'))}))await new Promise(r=>setTimeout(r,20));}return original.apply(this,args);};await import(${JSON.stringify(join(root,'apps/host/src/main.ts'))});`);
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
test.afterAll(async () => { httpReleases.forEach(release => release()); await app?.evaluate(() => Object.values((globalThis as MainGlobal).__p6Gate.pending).forEach(release => release())).catch(() => {}); await app?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); if (temporary) { const target = resolve(temporary), within = relative(resolve(tmpdir()), target); if (within && !within.startsWith('..') && !within.includes(':')) rmSync(target, { recursive: true, force: true }); } });
test.afterEach(async ({}, info) => {
  const name = info.title.replaceAll(/[^a-zA-Z0-9]+/g, '-'); mkdirSync(evidence, { recursive: true });
  if (info.status === info.expectedStatus) { save('dom-' + name, { currentSession: await page.getByTestId('current-session').innerText(), inputQueue: await queue().count() ? await queue().ariaSnapshot() : null, composer: await page.locator('.composer').ariaSnapshot() }); await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true }); }
  else await page?.screenshot({ path: join(evidence, 'failure-' + name + '.png'), fullPage: true }).catch(() => {});
  await app?.evaluate(()=>{(globalThis as MainGlobal).__p6Gate.drop=[];}).catch(()=>{});
});

const timeline=()=>page.getByTestId('run-timeline');
const temporaryBody=()=>page.getByTestId('temporary-run-area');
async function drop(types:string[]){await app.evaluate((_,types)=>{(globalThis as MainGlobal).__p6Gate.drop=types;},types);}
async function events(runId:number){const result=await page.evaluate(runId=>window.medclaw.request('event.read',{runId,afterSequence:0,limit:100}),runId);if(!result.ok)throw new Error(result.error.code);return result.data;}
async function runtimeTab(){if(!await page.getByRole('tab',{name:'Run details',exact:true}).count())await page.getByRole('button',{name:'View run details',exact:true}).click();await page.getByRole('tab',{name:'Run details',exact:true}).click();await expect(page.getByRole('tabpanel',{name:'Run details',exact:true})).toBeVisible();}
async function assertTimeline(runId:number){await runtimeTab();const facts=await events(runId);await expect(timeline()).toHaveAttribute('data-run-id',String(runId));await expect(timeline()).toHaveAttribute('data-cursor',String(facts.range.lastSequence));expect(await timeline().locator('[data-event-sequence]').evaluateAll(nodes=>nodes.map(n=>Number(n.getAttribute('data-event-sequence'))))).toEqual(facts.events.map(e=>e.sequence));return facts;}
async function settled(text:string){await create();steps=[()=>({text})];const accepted=await clickSubmit(text);if(!accepted.runId)throw new Error('Missing Run');await idle();await expect(page.getByText('Saved',{exact:true})).toBeVisible();return {...accepted,runId:accepted.runId};}
function receipt(wire:Wire,id:string):Record<string,unknown>{const returned=wire.messages.filter(m=>m.role==='tool'&&m.tool_call_id===id);expect(returned).toHaveLength(1);return JSON.parse(String(returned[0]!.content));}

test('medical_device_run_commits_timeline_with_authoritative_facts',async()=>{
 test.setTimeout(60000);
 await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Choose snapshot directory',exact:true}).click();await page.getByRole('button',{name:'Confirm import',exact:true}).click();
 await expect(page.getByLabel('Select batch 2',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Select batches on this page',exact:true}).click();await page.getByRole('button',{name:'Apply 2 selected batches',exact:true}).click();
 await page.getByRole('button',{name:'Chat',exact:true}).click();const a=await create();const before=physical;let queryId=0;
 steps=[()=>({id:'p6-scope',name:'read_data_scope',args:{}}),wire=>{const scope=receipt(wire,'p6-scope').scope as {batchIds:number[]};return {id:'p6-query',name:'query_device_changes',args:{batchIds:scope.batchIds,time:{start:'2026-01-02',endExclusive:'2026-01-03'},region:'浙江',changeField:'price',direction:'decrease',threshold:{operator:'gt',value:0.05},page:1,pageSize:50}};},wire=>{const result=receipt(wire,'p6-query');queryId=result.queryId as number;expect(result.totalRows).toBe(3);return {id:'p6-read',name:'read_query',args:{queryId}};},wire=>{expect(receipt(wire,'p6-read').queryId).toBe(queryId);return {text:'浙江医疗器械共有3款价格下降超过5%，已依据原 Query 核实。'};}];
 const accepted=await clickSubmit('查询浙江价格下降超过5%的医疗器械，并补读同一Query');if(!accepted.runId)throw new Error('Missing Run');await idle();const run=await readRun(accepted.runId),facts=await assertTimeline(accepted.runId);
 expect(physical-before).toBe(4);expect(facts.events.filter(e=>e.type==='query_completed')).toHaveLength(1);expect(facts.events.filter(e=>e.type==='tool_started')).toHaveLength(3);expect(facts.events.filter(e=>e.type==='run_completed')).toHaveLength(1);
 const database=sql(`SELECT id,run_id,result_hash FROM queries WHERE run_id=${accepted.runId}`);expect(database).toHaveLength(1);expect(run.answerRef).not.toBeNull();save('medical-device',{sessionId:a,run,facts,database,physicalCalls:physical-before});
});
test('session_switch_keeps_a_events_out_of_b',async()=>{
 const a=await create(),b=await create();await select(a);const paused=gate();steps=[()=>({text:'P6 A持续生成的安全正文',endGate:paused})];const before=physical,origin=await clickSubmit('P6 A session switch');await paused.entered;
 await expect(page.locator('.messages')).toContainText('P6 A持续生成的安全正文');await select(b);await input().fill('P6 B独立草稿');await expect(page.locator('.messages')).not.toContainText('P6 A持续生成的安全正文');paused.release();await idle();await expect(input()).toHaveValue('P6 B独立草稿');await select(a);
 await expect(page.locator('.messages')).toContainText('P6 A持续生成的安全正文');expect(physical-before).toBe(1);save('session-switch',{a,b,origin,physicalCalls:physical-before});
});
test('reconnect_replays_without_new_execution',async()=>{
 const origin=await settled('P6 reconnect saved response'),before=physical,beforeQueries=sql('SELECT COUNT(*) n FROM queries');const facts=await assertTimeline(origin.runId);
 await page.reload();await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible();await assertTimeline(origin.runId);expect(physical).toBe(before);expect(sql('SELECT COUNT(*) n FROM queries')).toEqual(beforeQueries);save('reconnect',{runId:origin.runId,facts,physicalDelta:physical-before});
});
test('lost_terminal_notice_reads_cleanup_and_gate',async()=>{
 await drop(['event.available','agent.settled']);const origin=await settled('P6 terminal notice lost'),before=physical,facts=await assertTimeline(origin.runId);await idle();const control=await page.evaluate(()=>window.medclaw.request('run.control.read',{}));
 expect(control).toMatchObject({ok:true,data:{acceptingNewRuns:true,activeRootRun:null}});expect(facts.events.at(-1)?.type).toBe('run_completed');expect(physical).toBe(before);save('lost-terminal',{run:await readRun(origin.runId),facts,control});
});
test('lost_final_snapshot_refreshes_during_long_tool_without_new_execution',async()=>{
 const a=await create();await drop(['event.stream']);const before=physical;
 steps=[()=>({id:'p6-long-tool',name:'read_data_scope',args:{},leadText:'P6 工具前的完整临时正文'}),()=>({text:'P6 长工具完成后的保存回答'})];const origin=await clickSubmit('P6 long tool snapshot');
 await expect.poll(()=>physical).toBe(before+1);await expect(page.locator('.messages')).toContainText('P6 工具前的完整临时正文');
 await expect.poll(async()=> (await calls()).filter(c=>c.method==='event.subscribe'&&c.payload.action==='open'&&c.payload.runId===origin.runId).length).toBeGreaterThan(1);
 expect(physical-before).toBe(1);expect((await readRun(origin.runId!)).status).toBe('running');writeFileSync(join(temporary,'release-tool'),'release');await idle();expect(physical-before).toBe(2);save('lost-final-snapshot',{a,origin,physicalCalls:physical-before,readOnlyRefreshes:(await calls()).filter(c=>c.method==='event.subscribe'&&c.payload.runId===origin.runId)});
});
test('terminal_before_ended_replaces_temporary_run_body_once',async()=>{
 const a=await create(),paused=gate();await drop(['event.stream']);const before=physical;steps=[()=>({text:'P6 exactly one authoritative final body',endGate:paused})];const origin=await clickSubmit('P6 replacement');await paused.entered;
 await expect(temporaryBody()).toContainText('P6 exactly one authoritative final body');paused.release();await idle();
 await expect(page.getByTestId('chat-native-messages').locator('[data-native-entry-id]').filter({hasText:'P6 exactly one authoritative final body'})).toHaveCount(1);
 await expect(temporaryBody()).toHaveCount(0);
 await app.evaluate(({BrowserWindow},runId)=>{const state=(globalThis as MainGlobal).__p6Gate;state.drop=[];const late=state.notices.findLast(n=>n.type==='event.stream'&&(n.snapshot as {runId:number;phase:string})?.runId===runId&&(n.snapshot as {phase:string}).phase==='ended');if(!late)throw Error('Missing actual ended observation');BrowserWindow.getAllWindows()[0]!.webContents.send('medclaw:notice',late);},origin.runId!);
 await expect(temporaryBody()).toHaveCount(0);await expect(page.locator('.messages').getByText('P6 exactly one authoritative final body',{exact:true})).toHaveCount(1);expect(physical-before).toBe(1);save('terminal-before-ended',{a,origin,native:await page.getByTestId('chat-native-messages').ariaSnapshot()});
});
test('sqlite_history_after_restart_replaces_temporary_display_without_a_model_request',async()=>{
 const origin=await settled('P6 saved result after Host restart'),before=physical;const host=await page.evaluate(()=>window.medclaw.request('host.read',{}));if(!host.ok||!host.data.instanceId)throw Error('Missing Host');await page.evaluate(instanceId=>window.medclaw.request('host.restart',{expectedInstanceId:instanceId}),host.data.instanceId);
 await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible();await expect(page.getByTestId('chat-native-messages')).toContainText('P6 saved result after Host restart');await expect(page.getByTestId('chat-native-messages')).toContainText('Saved history');await expect(temporaryBody()).toHaveCount(0);expect(physical).toBe(before);await assertTimeline(origin.runId);save('history-restored',{origin,run:await readRun(origin.runId),physicalDelta:physical-before});
});
test('slow_renderer_recovers_database_events',async()=>{
 const a=await create(),paused=gate();await drop(['event.available']);steps=[()=>({text:'P6 slow display database recovery',endGate:paused})];const origin=await clickSubmit('P6 slow renderer');await paused.entered;const before=physical;
 await rules([{method:'event.read',runId:origin.runId!,hold:'slow-event-page'}]);await entered('slow-event-page');paused.release();await idle();await release('slow-event-page');await assertTimeline(origin.runId!);expect(physical).toBe(before);save('slow-renderer',{a,origin,facts:await events(origin.runId!),physicalDelta:physical-before});
});
test('reading_anchor_survives_replay_and_back_to_latest_is_explicit',async()=>{
 const a=await create(),b=await create();await select(a);const paused=gate(),text=Array.from({length:65},(_,i)=>`P6 reading line ${i+1}`).join('\n');steps=[()=>({text,endGate:paused})];const origin=await clickSubmit('P6 scroll anchor');await paused.entered;await expect(page.locator('.messages')).toContainText('P6 reading line 65');
 const before=await page.getByTestId('chat-scroll').evaluate(e=>{const article=e.querySelector<HTMLElement>('[data-message-id]')!;e.scrollTop+=article.getBoundingClientRect().top-e.getBoundingClientRect().top+400;e.dispatchEvent(new Event('scroll'));return {top:e.scrollTop,height:e.scrollHeight,offset:article.getBoundingClientRect().top-e.getBoundingClientRect().top,bottom:article.getBoundingClientRect().bottom-e.getBoundingClientRect().top,messageId:article.dataset.messageId};});
 expect(before.top).toBeGreaterThan(0);expect(before.offset).toBeLessThan(0);expect(before.bottom).toBeGreaterThan(0);save('reading-anchor-before',{before,elements:await page.getByTestId('chat-scroll').evaluate(e=>Array.from(e.querySelectorAll<HTMLElement>('[data-native-entry-id], [data-message-id]')).map(node=>({native:node.dataset.nativeEntryId,message:node.dataset.messageId,visible:node.offsetParent!==null,top:node.getBoundingClientRect().top-e.getBoundingClientRect().top,bottom:node.getBoundingClientRect().bottom-e.getBoundingClientRect().top})))});paused.release();await idle();await expect(temporaryBody()).toHaveCount(0);
 const history=await page.evaluate(sessionId=>window.medclaw.request('session.messages.read',{sessionId,limit:100}),a);if(!history.ok)throw Error(history.error.code);const saved=history.data.items.find(item=>item.displayRole==='assistant'&&item.text===text);if(!saved)throw Error('Missing actual native answer');
 const offset=()=>page.locator(`[data-testid="chat-scroll"] [data-native-entry-id="${saved.nativeEntryId}"]`).evaluate(e=>e.getBoundingClientRect().top-e.closest('[data-testid="chat-scroll"]')!.getBoundingClientRect().top);
 save('reading-anchor-after',{before,nativeEntryId:saved.nativeEntryId,actualOffset:await offset(),elements:await page.getByTestId('chat-scroll').evaluate(e=>Array.from(e.querySelectorAll<HTMLElement>('[data-native-entry-id], [data-message-id]')).map(node=>({native:node.dataset.nativeEntryId,message:node.dataset.messageId,visible:node.offsetParent!==null,top:node.getBoundingClientRect().top-e.getBoundingClientRect().top,bottom:node.getBoundingClientRect().bottom-e.getBoundingClientRect().top})))});await expect.poll(async()=>Math.abs(await offset()-before.offset)).toBeLessThanOrEqual(3);await expect(page.getByTestId('back-to-latest')).toBeVisible();const mapped={nativeEntryId:saved.nativeEntryId,offset:await offset()};
 await select(b);await select(a);await expect.poll(async()=>Math.abs(await offset()-before.offset)).toBeLessThanOrEqual(3);
 await assertTimeline(origin.runId!);
 const detail=page.getByTestId('run-details-scroll');
 async function placeTimelineAnchor(){
  await expect(detail).toBeVisible();
  await expect.poll(()=>detail.evaluate(e=>e.scrollHeight-e.clientHeight)).toBeGreaterThan(64);
  await detail.evaluate(e=>{const node=Array.from(e.querySelectorAll<HTMLElement>('[data-event-id]')).find(node=>node.offsetParent!==null);if(!node)throw Error('No displayed timeline event');const box=node.getBoundingClientRect();e.scrollTop+=box.top-e.getBoundingClientRect().top+Math.min(20,box.height/2);e.dispatchEvent(new Event('scroll'));});
  const anchor=await detail.evaluate(e=>{const box=e.getBoundingClientRect();const node=Array.from(e.querySelectorAll<HTMLElement>('[data-event-id]')).find(node=>node.offsetParent!==null&&node.getBoundingClientRect().bottom>box.top&&node.getBoundingClientRect().top<box.bottom);if(!node)throw Error('No visible timeline event at the reading position');return {eventId:node.dataset.eventId!,offset:node.getBoundingClientRect().top-box.top};});
  await expect(detail.locator('[data-event-id="'+anchor.eventId+'"]')).toBeVisible();return anchor;
 }
 const firstTimeline=await placeTimelineAnchor();
 const secondText=Array.from({length:65},(_,i)=>`P6 second Run reading line ${i+1}`).join('\n');steps=[()=>({text:secondText})];const second=await clickSubmit('P6 same Session independent Run reading');await idle();await expect(temporaryBody()).toHaveCount(0);
 const secondHistory=await page.evaluate(sessionId=>window.medclaw.request('session.messages.read',{sessionId,limit:100}),a);if(!secondHistory.ok)throw Error(secondHistory.error.code);const secondSaved=secondHistory.data.items.find(item=>item.displayRole==='assistant'&&item.text===secondText);if(!secondSaved)throw Error('Missing second actual native answer');
 const secondArticle=page.locator(`[data-testid="chat-scroll"] [data-native-entry-id="${secondSaved.nativeEntryId}"]`);await expect(secondArticle).toBeAttached();
 await secondArticle.evaluate(e=>{const container=e.closest<HTMLElement>('[data-testid="chat-scroll"]')!;container.scrollTop+=e.getBoundingClientRect().top-container.getBoundingClientRect().top+300;container.dispatchEvent(new Event('scroll'));});
 const secondOffset=()=>secondArticle.evaluate(e=>e.getBoundingClientRect().top-e.closest('[data-testid="chat-scroll"]')!.getBoundingClientRect().top),secondPosition=await secondOffset();
 await assertTimeline(second.runId!);const secondTimeline=await placeTimelineAnchor(),physicalAfterSecond=physical;
 const timelineOffset=(anchor:{eventId:string})=>detail.locator(`[data-event-id="${anchor.eventId}"]`).evaluate(e=>e.getBoundingClientRect().top-e.closest('[data-testid="run-details-scroll"]')!.getBoundingClientRect().top);
 async function inspect(runId:number){await page.getByRole('button',{name:'Refresh recent runs',exact:true}).evaluate((e:HTMLButtonElement)=>e.click());await expect(page.getByRole('button',{name:`View Run ${runId}`,exact:true})).toBeAttached();await page.getByRole('button',{name:`View Run ${runId}`,exact:true}).evaluate((e:HTMLButtonElement)=>e.click());await expect(page.getByTestId('event-display-status')).toHaveAttribute('data-run-id',String(runId));await assertTimeline(runId);}
 await inspect(origin.runId!);await expect.poll(async()=>Math.abs(await offset()-before.offset)).toBeLessThanOrEqual(3);await expect.poll(async()=>Math.abs(await timelineOffset(firstTimeline)-firstTimeline.offset)).toBeLessThanOrEqual(3);
 await page.getByRole('tab',{name:'Evidence',exact:true}).click();await page.getByRole('tab',{name:'Run details',exact:true}).click();await expect.poll(async()=>Math.abs(await timelineOffset(firstTimeline)-firstTimeline.offset)).toBeLessThanOrEqual(3);
 await inspect(second.runId!);await expect.poll(async()=>Math.abs(await secondOffset()-secondPosition)).toBeLessThanOrEqual(3);await expect.poll(async()=>Math.abs(await timelineOffset(secondTimeline)-secondTimeline.offset)).toBeLessThanOrEqual(3);
 await inspect(origin.runId!);await expect.poll(async()=>Math.abs(await offset()-before.offset)).toBeLessThanOrEqual(3);expect(physical).toBe(physicalAfterSecond);
 await page.getByTestId('back-to-latest').click();await expect.poll(()=>page.locator('.messages').evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight)).toBeLessThan(64);await page.getByTestId('timeline-back-to-latest').click();await expect.poll(()=>detail.evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight)).toBeLessThan(64);
 save('reading-anchor',{a,b,origin,before,mapped,second,secondPosition,firstTimeline,secondTimeline,inspectionPhysicalDelta:physical-physicalAfterSecond,after:await page.locator('.messages').evaluate(e=>({top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight}))});
});
test('subscription_cleanup_handles_late_open_and_reload',async()=>{
 const a=await settled('P6 late open A'),b=await create();await select(b);await rules([{method:'event.subscribe',runId:a.runId,action:'open',hold:'late-open'}]);await select(a.sessionId);await entered('late-open');await select(b);await release('late-open');
 await expect.poll(()=>JSON.parse(readFileSync(join(temporary,'subscriptions.json'),'utf8')).count).toBe(0);const before=physical;
 for(let i=0;i<3;i++){await select(a.sessionId);await expect.poll(()=>JSON.parse(readFileSync(join(temporary,'subscriptions.json'),'utf8')).count).toBe(1);await page.reload();await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible();await expect.poll(()=>JSON.parse(readFileSync(join(temporary,'subscriptions.json'),'utf8')).count).toBe(1);}
 expect(physical).toBe(before);save('subscription-cleanup',{a,b,subscriptions:JSON.parse(readFileSync(join(temporary,'subscriptions.json'),'utf8')),physicalDelta:physical-before});
});
