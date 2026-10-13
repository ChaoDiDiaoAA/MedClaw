import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { SessionInput, SubmitResult } from '../../packages/contracts/src/session';
import { safeError } from '../../packages/contracts/src/error';

const root = resolve(import.meta.dirname, '../..'), bun = process.env.MEDCLAW_BUN_EXECUTABLE ?? 'bun';
let app: ElectronApplication, page: Page, temporary: string, server: Server;
type Call = { method: string; payload: Record<string, unknown>; operationRef?: string };
type Rule = { method: string; sessionId?: number; inputId?: number; afterClientSequence?: number | null; hold?: string; before?: boolean; legacy?: boolean; requestPatch?: Record<string, unknown>; project?: unknown };
type GateState = { rules: Rule[]; entered: string[]; pending: Record<string, () => void>; calls: Call[]; accepted: (SubmitResult & { mode: string; operationRef: string })[] };
type MainGlobal = typeof globalThis & { __p5Gate: GateState };
type Wire = { model: string; messages: { role: string; content: unknown }[] };
let steps: ((wire: Wire) => Promise<string> | string)[] = [], physical = 0;
const wires: Wire[] = [], httpReleases: (() => void)[] = [];
const evidence = join(root, '.build/p5-session-management/e2e');
test.describe.configure({ mode: 'serial', timeout:60000 });
const input = () => page.getByLabel('Message text', { exact: true });
const queue = () => page.getByTestId('input-queue');
async function inspectInputs(){if(!await page.getByRole("complementary",{name:"Run details",exact:true}).isVisible())await page.getByRole("button",{name:"View run details",exact:true}).click();const summary=page.getByText("Input diagnostics",{exact:true});if(!await queue().isVisible())await summary.click();}
const item = (id: number) => queue().locator(`[data-input-id="${id}"]`);
function gate() { let enter!: () => void, release!: () => void; const value = { entered: new Promise<void>(resolve => { enter = resolve; }), response: new Promise<void>(resolve => { release = resolve; }), enter: () => enter(), release: () => release() }; httpReleases.push(value.release); return value; }
async function rules(values: Rule[]) { await app.evaluate((_, values) => { (globalThis as MainGlobal).__p5Gate.rules.push(...values); }, values); }
async function entered(id: string) { await expect.poll(() => app.evaluate((_, id) => (globalThis as MainGlobal).__p5Gate.entered.includes(id), id)).toBe(true); }
async function release(id: string) { await app.evaluate((_, id) => { (globalThis as MainGlobal).__p5Gate.pending[id]?.(); }, id); }
async function calls() { return app.evaluate(() => (globalThis as MainGlobal).__p5Gate.calls); }
async function accepted() { return app.evaluate(() => (globalThis as MainGlobal).__p5Gate.accepted); }
const row = (id: number) => page.locator(`.session-row[data-session-id="${id}"]`);
async function title(id: number) { const result = await page.evaluate(sessionId => window.medclaw.request('session.read', { sessionId }), id); if (!result.ok || !result.data) throw new Error('Missing Session'); return result.data.session.title; }
async function create() { const before = await page.evaluate(() => window.medclaw.request('workspace.read', {})); await page.getByRole('button', { name: 'New Session', exact: true }).click(); await expect.poll(async () => { const result = await page.evaluate(() => window.medclaw.request('workspace.read', {})); return result.ok ? result.data.sessionId : null; }).not.toBe(before.ok ? before.data.sessionId : null); const w = await page.evaluate(() => window.medclaw.request('workspace.read', {})); if (!w.ok || !w.data.sessionId) throw new Error('Missing Session'); await expect(page.getByTestId('current-session')).toContainText(await title(w.data.sessionId)); return w.data.sessionId; }
async function select(id: number) { await row(id).locator('button[aria-pressed]').click(); await expect(page.getByTestId('current-session')).toContainText(await title(id)); }
async function idle() { await expect.poll(async () => { const value = await page.evaluate(() => window.medclaw.request('run.control.read', {})); return value.ok && value.data.acceptingNewRuns && value.data.activeRootRun === null; }).toBe(true); }
async function readInput(id: number) { const value = await page.evaluate(inputId => window.medclaw.request('session.readInput', { inputId }), id); if (!value.ok || !value.data) throw new Error('Missing original Input'); return value.data; }
async function readRun(id: number) { const value = await page.evaluate(runId => window.medclaw.request('run.read', { runId }), id); if (!value.ok || value.data.kind !== 'one' || !value.data.run) throw new Error('Missing original Run'); return value.data.run; }
const modeName = (mode: 'send' | 'steer' | 'follow_up') => mode === 'follow_up' ? 'Follow Up' : mode === 'steer' ? 'Steer' : 'Send';
async function chooseMode(mode: 'send' | 'steer' | 'follow_up') { await page.getByRole('button', { name: 'Message actions', exact: true }).click(); await page.getByRole('menuitem', { name: modeName(mode), exact: true }).click(); await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toHaveCount(0); }
async function clickSubmit(text: string, mode: 'send' | 'steer' | 'follow_up' = 'send') { const before = (await accepted()).length; if (mode !== 'send') await chooseMode(mode); await input().fill(text); await page.getByRole('button', { name: modeName(mode), exact: true }).click(); await expect.poll(async () => (await accepted()).length).toBe(before + 1); return (await accepted())[before]!; }
function sql(query: string) { return JSON.parse(execFileSync(bun, ['-e', 'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); console.log(JSON.stringify(db.query(process.argv[2]).all())); db.close();', join(temporary, 'data', 'data', 'app.sqlite'), query], { encoding: 'utf8', cwd: root })); }
function save(name: string, data: unknown) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, name + '.json'), JSON.stringify(data, null, 2)); }

test.beforeAll(async () => {
  test.setTimeout(90000);
  for (const part of ['main', 'preload']) execFileSync(bun, ['build', `apps/desktop/src/${part}/index.ts`, '--target=node', '--format=cjs', '--external=electron', `--outfile=.build/desktop/${part}/index.cjs`], { cwd: root });
  execFileSync(bun, ['build', 'apps/desktop/src/renderer/index.html', '--target=browser', '--outdir=.build/desktop/renderer'], { cwd: root });
  temporary = mkdtempSync(join(tmpdir(), 'medclaw-p5-desktop-'));
  server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const wire = JSON.parse(body) as Wire; wires.push(wire); physical++;
    const next = steps.shift(); if (!next) { response.writeHead(500); response.end('No controlled fixture step'); return; }
    const text = await next(wire); if (response.destroyed) return;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish] of [[{ role: 'assistant', content: text }, null], [{}, 'stop']]) response.write(`data: ${JSON.stringify({ id: 'p5-response', model: wire.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const seam = join(temporary, 'public-gates.cjs');
  writeFileSync(seam, `const {ipcMain}=require('electron'); const original=ipcMain.handle.bind(ipcMain);
    const state=globalThis.__p5Gate={rules:[],entered:[],pending:{},calls:[],accepted:[]};
    ipcMain.handle=(channel,listener)=>original(channel,async(event,envelope)=>{
      if(channel!=='medclaw:request')return listener(event,envelope);
      const p=envelope.payload; state.calls.push({method:envelope.method,payload:p,operationRef:envelope.operationRef});
      const index=state.rules.findIndex(r=>r.method===envelope.method&&(r.sessionId===undefined||r.sessionId===p.sessionId)&&(r.inputId===undefined||r.inputId===p.inputId)&&(r.afterClientSequence===undefined||r.afterClientSequence===p.afterClientSequence));
      const rule=index<0?null:state.rules.splice(index,1)[0];
      const hold=async()=>{state.entered.push(rule.hold);await new Promise(resolve=>state.pending[rule.hold]=resolve);delete state.pending[rule.hold];};
      if(rule?.hold&&rule.before)await hold();
      let result=await listener(event,rule?.requestPatch?{...envelope,payload:{...p,...rule.requestPatch}}:envelope);
      if(envelope.method==='session.submit'&&result.ok)state.accepted.push({...result.data,mode:p.mode,operationRef:envelope.operationRef});
      if(rule?.project)result=rule.project;
      if(rule?.legacy&&result.ok)result={ok:true,data:{...result.data,inputId:null}};
      if(rule?.hold&&!rule.before)await hold();return result;
    });`);
  const require = createRequire(join(root, 'apps/desktop/package.json')), electronPath: string = require('electron');
  const playwright = createRequire(createRequire(import.meta.url).resolve('@playwright/test/package.json')), core = createRequire(playwright.resolve('playwright/package.json')).resolve('playwright-core/package.json');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])), MEDCLAW_HOST_ENTRY: join(root, 'apps/host/src/main.ts'), MEDCLAW_BUN_EXECUTABLE: execFileSync(bun, ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).trim() };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: electronPath, args: ['-r', join(dirname(core), 'lib/server/electron/loader.js'), '-r', seam, join(root, '.build/desktop/main/index.cjs'), '--medclaw-data-root', join(temporary, 'data')], env, timeout: 30000 });
  page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 1000 }); await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  const configured = await page.evaluate(async baseUrl => {
    const directory = await window.medclaw.request('model.read', {}); if (!directory.ok) throw new Error(directory.error.code);
    const token = await window.medclaw.secretInput({ providerId: 'p5-fixture', purpose: 'custom_api_key', value: 'P5-LOCAL-NONSECRET' }); if (!token.ok) throw new Error(token.error.code);
    const saved = await window.medclaw.request('model.custom.save', { expectedConfigVersion: directory.data.configVersion, credentialInput: token.data.token, definition: { providerId: 'p5-fixture', name: 'P5 controlled fixture', api: 'openai-completions', baseUrl, models: ['first', 'second'].map(id => ({ id, name: 'P5 ' + id, input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null })) } }); if (!saved.ok) throw new Error(saved.error.code);
    return window.medclaw.request('model.configure', { provider: 'p5-fixture', modelId: 'first', expectedConfigVersion: saved.data.configVersion });
  }, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`); expect(configured.ok).toBe(true);
});
test.afterAll(async () => { httpReleases.forEach(release => release()); await app?.evaluate(() => Object.values((globalThis as MainGlobal).__p5Gate.pending).forEach(release => release())).catch(() => {}); await app?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); if (temporary) { const target = resolve(temporary), within = relative(resolve(tmpdir()), target); if (within && !within.startsWith('..') && !within.includes(':')) rmSync(target, { recursive: true, force: true }); } });
test.afterEach(async ({}, info) => {
  const name = info.title.replaceAll(/[^a-zA-Z0-9]+/g, '-'); mkdirSync(evidence, { recursive: true });
  if (info.status === info.expectedStatus) { save('dom-' + name, { currentSession: await page.getByTestId('current-session').innerText(), inputQueue: await queue().count() ? await queue().ariaSnapshot() : null, composer: await page.locator('.composer').ariaSnapshot() }); await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true }); }
  else await page?.screenshot({ path: join(evidence, 'failure-' + name + '.png'), fullPage: true }).catch(() => {});
});

test('Send, Steer and Follow Up expose real Input identities and cancel only the original queued object', async () => {
  const a = await create(); await expect(page.getByLabel('Input mode', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Message actions', exact: true })).toHaveCount(0);
  await page.screenshot({ path: join(root, '.superpowers/input-menu-numbering/desktop-send-idle.png') });
  const first = gate(); steps = [async wire => { expect(JSON.stringify(wire)).toContain('P5-root'); first.enter(); await first.response; return 'P5 first turn'; }, wire => { expect(JSON.stringify(wire)).toContain('P5-correction'); expect(JSON.stringify(wire)).not.toContain('P5-cancel-me'); return 'P5 final'; }];
  const before = physical, rootInput = await clickSubmit('P5-root'); await first.entered; if (!rootInput.runId || !rootInput.inputId) throw new Error('Send must return both IDs');
  await inspectInputs(); await expect(item(rootInput.inputId)).toContainText('Consumed'); await expect(item(rootInput.inputId)).toContainText('Pending');
  const arrow = page.getByRole('button', { name: 'Message actions', exact: true }), menu = page.getByRole('menu', { name: 'Message actions', exact: true });
  await expect(arrow).toBeVisible(); const beforeChoice = (await calls()).filter(call => call.method === 'session.submit').length;
  await arrow.focus(); await arrow.press('ArrowDown'); await expect(menu.getByRole('menuitem', { name: 'Steer', exact: true })).toBeFocused();
  await page.screenshot({ path: join(root, '.superpowers/input-menu-numbering/desktop-message-actions.png') });
  await page.keyboard.press('ArrowDown'); await expect(menu.getByRole('menuitem', { name: 'Follow Up', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0); await expect(page.getByRole('button', { name: 'Follow Up', exact: true })).toBeVisible();
  expect((await calls()).filter(call => call.method === 'session.submit')).toHaveLength(beforeChoice); expect(physical).toBe(before + 1);
  await arrow.click(); await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(arrow).toBeFocused();
  await arrow.click(); await page.keyboard.press('Tab'); await expect(menu).toHaveCount(0);
  await arrow.click(); await input().click(); await expect(menu).toHaveCount(0);
  await chooseMode('steer'); await input().fill('P5-correction'); await input().press('Shift+Enter'); await expect(input()).toHaveValue('P5-correction\n');
  expect((await calls()).filter(call => call.method === 'session.submit')).toHaveLength(beforeChoice);
  await input().fill('P5-correction'); await input().press('Enter'); await expect.poll(async () => (await accepted()).length).toBe(2);
  const correction = (await accepted())[1]!; await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  const cancelled = await clickSubmit('P5-cancel-me', 'follow_up');
  expect(correction.runId).toBeNull(); expect(cancelled.runId).toBeNull(); if (!correction.inputId || !cancelled.inputId) throw new Error('Queued inputs need IDs');
  await inspectInputs(); await expect(item(cancelled.inputId)).toContainText('Queued'); await item(cancelled.inputId).getByRole('button', { name: 'Cancel input', exact: true }).click();
  await inspectInputs(); await expect(item(cancelled.inputId)).toContainText('Cancelling'); first.release(); await idle();
  await inspectInputs(); await expect(item(cancelled.inputId)).toContainText('Cancelled'); await expect(item(correction.inputId)).toContainText('Consumed'); await expect(item(correction.inputId)).toContainText('Completed');
  const facts = await Promise.all([readInput(rootInput.inputId), readInput(correction.inputId), readInput(cancelled.inputId)]);
  expect(facts[1]!.runId).toBe(rootInput.runId); expect(facts[2]!.runId).toBeNull(); expect(facts[2]!.nativeEntryId).toBeNull(); expect(physical - before).toBe(2);
  expect((await calls()).some(call => call.method === 'run.read' && call.payload.runId === null)).toBe(false);
  const run = await readRun(rootInput.runId); expect(run.inputId).toBe(rootInput.inputId); expect(run.cleanup?.inputsSettled).toBe(true);
  await expect(arrow).toHaveCount(0);
  save('three-modes', { sessionId: a, rootInput, correction, cancelled, facts, runId: run.id, physicalCalls: physical - before, sql: sql(`SELECT id,session_id,target_run_id,run_id,status,processing_status,native_entry_id FROM session_inputs WHERE session_id=${a} ORDER BY client_sequence`) });
});

test('an executed queued reply lost in IPC is read back under A while B and newer drafts remain intact', async () => {
  const a = await create(), b = await create(); await select(a); const first = gate(); steps = [async () => { first.enter(); await first.response; return 'P5 lost first'; }, () => 'P5 lost final'];
  const rootInput = await clickSubmit('P5-lost-root'); await first.entered;
  await rules([{ method: 'session.submit', sessionId: a, project: { ok: false, error: safeError('operation_result_unknown') } }]);
  const lost = await clickSubmit('P5-lost-follow-up', 'follow_up'); if (!lost.inputId) throw new Error('Missing queued ID');
  await expect(page.getByRole('button', { name: 'Read original submission', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Message actions', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Follow Up', exact: true })).toBeDisabled();
  const originalCall = (await calls()).filter(call => call.method === 'session.submit' && call.payload.sessionId === a && call.payload.clientSequence === lost.clientSequence)[0]!;
  expect(originalCall.payload).toMatchObject({ mode: 'follow_up', targetRunId: rootInput.runId, text: 'P5-lost-follow-up' }); expect(originalCall.operationRef).toBe(lost.operationRef);
  await input().fill('P5-A-newer-draft'); await rules([{ method: 'session.readSubmission', sessionId: a, hold: 'lost-query' }]);
  await page.getByRole('button', { name: 'Read original submission', exact: true }).click(); await entered('lost-query'); await select(b); await input().fill('P5-B-draft'); const before = physical;
  await release('lost-query'); await expect.poll(async () => (await calls()).some(call => call.method === 'session.readInput' && call.payload.inputId === lost.inputId)).toBe(true);
  await expect(input()).toHaveValue('P5-B-draft'); await expect(page.getByTestId('current-session')).toContainText(await title(b)); await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Message actions', exact: true })).toHaveCount(0);
  await select(a); await expect(input()).toHaveValue('P5-A-newer-draft'); await expect(page.getByRole('button', { name: 'Read original submission', exact: true })).toHaveCount(0);
  expect(physical).toBe(before); expect((await calls()).filter(call => call.method === 'session.submit' && call.payload.clientSequence === lost.clientSequence && call.payload.sessionId === a)).toHaveLength(1);
  first.release(); await idle(); expect((await readInput(lost.inputId)).processingStatus).toBe('completed'); save('lost-response', { a, b, rootInput, lost, physicalCalls: physical - before, calls: await calls() });
});

test('read failures preserve proven Input states and late queued responses cannot replace cancellation', async () => {
  const a = await create(), first = gate(); steps = [async () => { first.enter(); await first.response; return 'P5 cancellation boundary'; }];
  await clickSubmit('P5-stale-root'); await first.entered; const queued = await clickSubmit('P5-stale-queue', 'follow_up'); if (!queued.inputId) throw new Error('Missing queued ID');
  await inspectInputs(); await rules([{ method: 'session.readInput', inputId: queued.inputId, hold: 'stale-queued' }]); await queue().getByRole('button', { name: 'Refresh inputs', exact: true }).click(); await entered('stale-queued');
  await inspectInputs(); await item(queued.inputId).getByRole('button', { name: 'Cancel input', exact: true }).click(); await expect(item(queued.inputId)).toContainText('Cancelling'); first.release();
  await inspectInputs(); await expect(item(queued.inputId)).toContainText('Cancelled'); await release('stale-queued'); await expect(item(queued.inputId)).toContainText('Cancelled'); await expect(item(queued.inputId)).not.toContainText('Queued'); await idle();
  await inspectInputs(); await rules(Array.from({ length: 4 }, () => ({ method: 'session.listInputs', sessionId: a, project: { ok: false, error: safeError('storage_read_failed') } }))); await queue().getByRole('button', { name: 'Refresh inputs', exact: true }).click();
  await inspectInputs(); await expect(queue().getByRole('alert')).toContainText('Input read unavailable'); await expect(item(queued.inputId)).toContainText('Cancelled'); save('stale-input-read', { sessionId: a, queued, original: await readInput(queued.inputId), calls: await calls() });
});

test('frozen model and time changes close queue controls and a Host rejection keeps the edited draft', async () => {
  const a = await create(), first = gate(); steps = [async () => { first.enter(); await first.response; return 'P5 frozen first'; }, () => 'P5 frozen final'];
  const original = await clickSubmit('P5-frozen-root'); await first.entered; if (!original.runId) throw new Error('Missing root Run'); const rootRun = await readRun(original.runId);
  await chooseMode('steer'); await input().fill('P5-preserve-on-rejection');
  await page.locator('.reference-fields summary').click(); await page.getByLabel('Reference date', { exact: true }).fill('2026-01-01');
  await expect(page.getByRole('button', { name: 'Steer', exact: true })).toBeDisabled(); await expect(page.locator('.composer-reason')).toContainText('Restore the original Run reference date');
  await page.getByLabel('Reference date', { exact: true }).fill(rootRun.referenceDate); await page.getByLabel('Session model', { exact: true }).selectOption(JSON.stringify(['p5-fixture', 'second']));
  await expect(page.getByRole('button', { name: 'Steer', exact: true })).toBeDisabled(); await expect(page.locator('.composer-reason')).toContainText('Restore its model');
  await page.getByRole('button', { name: 'Message actions', exact: true }).click(); await expect(page.getByRole('menuitem', { name: 'Steer', exact: true })).toBeDisabled(); await expect(page.getByRole('menuitem', { name: 'Steer', exact: true })).toHaveAttribute('title', /Restore its model/); await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Message actions', exact: true })).toBeFocused();
  await page.getByLabel('Session model', { exact: true }).selectOption(JSON.stringify(['p5-fixture', 'first'])); await expect(page.getByRole('button', { name: 'Steer', exact: true })).toBeEnabled();
  await rules([{ method: 'session.submit', sessionId: a, requestPatch: { expectedRevision: 999999 } }]); await page.getByRole('button', { name: 'Steer', exact: true }).click();
  await expect(page.locator('.error-banner')).toBeVisible(); await expect(input()).toHaveValue('P5-preserve-on-rejection'); await expect(page.getByRole('button', { name: 'Read original submission', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Steer', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Message actions', exact: true })).toBeDisabled();
  const rejected = (await calls()).filter(call => call.method === 'session.submit' && call.payload.text === 'P5-preserve-on-rejection').at(-1)!;
  await input().fill('P5-frozen-correction'); const count = (await calls()).filter(call => call.method === 'session.submit').length;
  await page.getByRole('button', { name: 'Start a new attempt', exact: true }).click(); await expect(input()).toHaveValue('P5-frozen-correction'); await expect(page.getByRole('button', { name: 'Steer', exact: true })).toBeEnabled();
  expect((await calls()).filter(call => call.method === 'session.submit')).toHaveLength(count); await expect(page.getByRole('button', { name: 'Read original submission', exact: true })).toHaveCount(0);
  const queued = await clickSubmit('P5-frozen-correction', 'steer'); const call = (await calls()).filter(call => call.method === 'session.submit' && call.payload.clientSequence === queued.clientSequence && call.payload.text === 'P5-frozen-correction').at(-1)!;
  expect(call.payload).toMatchObject({ targetRunId: original.runId, model: { provider: rootRun.model.provider, modelId: rootRun.model.modelId, expectedConfigVersion: rootRun.model.configVersion }, referenceDate: rootRun.referenceDate, timezone: rootRun.timezone });
  expect(call.operationRef).not.toBe(rejected.operationRef);
  first.release(); await idle(); save('frozen-context-and-draft', { a, original, queued, frozenConfigVersion: rootRun.model.configVersion, call });
});

test('a cancel command that reaches Host after consumption returns consumed and points at the original Stop', async () => {
  const a = await create(), first = gate(), second = gate(); steps = [async () => { first.enter(); await first.response; return 'P5 race first'; }, async () => { second.enter(); await second.response; return 'P5 race final'; }];
  const original = await clickSubmit('P5-race-root'); await first.entered; const queued = await clickSubmit('P5-race-input', 'follow_up'); if (!queued.inputId) throw new Error('Missing queued Input');
  await inspectInputs(); await rules([{ method: 'session.cancelInput', inputId: queued.inputId, hold: 'cancel-before-host', before: true }]); await item(queued.inputId).getByRole('button', { name: 'Cancel input', exact: true }).click(); await entered('cancel-before-host');
  await inspectInputs(); await expect(item(queued.inputId)).toContainText('Cancelling'); first.release(); await second.entered; await release('cancel-before-host');
  await inspectInputs(); await expect(item(queued.inputId)).toContainText('Consumed'); await expect(item(queued.inputId)).not.toContainText('Cancelled'); await expect(item(queued.inputId).getByRole('button', { name: 'Cancel input', exact: true })).toHaveCount(0);
  await expect(page.locator('.error-banner')).toContainText(`already consumed. Stop original Run ${original.runId}`); const fact = await readInput(queued.inputId); expect(fact.runId).toBe(original.runId); expect(fact.nativeEntryId).not.toBeNull();
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click(); second.release(); await idle(); save('cancel-consumption-race', { a, original, queued, fact, settled: await readInput(queued.inputId) });
});

test('ordinary Input pages load more by sequence without executing model requests', async () => {
  test.setTimeout(60000); const a = await create(), first = gate(); steps = [async () => { first.enter(); await first.response; return 'P5 page first'; }];
  const original = await clickSubmit('P5-page-root'); await first.entered; if (!original.runId) throw new Error('Missing Run'); const rootRun = await readRun(original.runId), before = physical;
  const queued = await page.evaluate(async ({ a, runId, model, referenceDate, timezone }) => {
    const workspace = await window.medclaw.request('workspace.read', {}), detail = await window.medclaw.request('session.read', { sessionId: a }); if (!workspace.ok || !detail.ok || !detail.data) throw new Error('Missing current scope');
    const results = []; for (let index = 0; index < 51; index++) { const result = await window.medclaw.request('session.submit', { sessionId: a, clientSequence: detail.data.session.nextSubmissionSequence + index, text: 'P5-page-' + index, mode: 'follow_up', targetRunId: runId, expectedRevision: workspace.data.revision, expectedBatchIds: workspace.data.batchRefs.map(batch => batch.id), expectedQueryId: workspace.data.queryId, model: { provider: model.provider, modelId: model.modelId, expectedConfigVersion: model.configVersion }, referenceDate, timezone }, crypto.randomUUID()); if (!result.ok) throw new Error(result.error.code); results.push(result.data); } return results;
  }, { a, runId: original.runId, model: rootRun.model, referenceDate: rootRun.referenceDate, timezone: rootRun.timezone });
  await inspectInputs(); await page.getByRole('button', { name: 'Stop generating', exact: true }).click(); first.release(); await idle(); await page.reload(); await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible(); await expect(queue().locator('[data-input-id]')).toHaveCount(50);
  await inspectInputs(); await queue().getByRole('button', { name: 'Load more inputs', exact: true }).click(); await expect(queue().locator('[data-input-id]')).toHaveCount(52); await expect(queue().getByRole('button', { name: 'Load more inputs', exact: true })).toHaveCount(0);
  const all = await page.evaluate(sessionId => window.medclaw.request('session.listInputs', { sessionId, limit: 100 }), a); if (!all.ok) throw new Error(all.error.code); expect(all.data.items).toHaveLength(52); expect(all.data.items.slice(1).every(input => input.status === 'cancelled' && input.runId === null)).toBe(true); expect(physical).toBe(before);
  save('pagination', { a, original, acceptedQueueCount: queued.length, physicalReadDelta: physical - before, ids: all.data.items.map(input => input.id), calls: (await calls()).filter(call => call.method === 'session.listInputs' && call.payload.sessionId === a) });
});

test('accepted inputs reported failed or delivery unknown keep original drafts and never replay automatically', async () => {
  const a = await create(), first = gate(); steps = [async () => { first.enter(); await first.response; return 'P5 outcome root'; }, () => 'P5 outcome final'];
  await clickSubmit('P5-outcome-root'); await first.entered;
  for (const [outcome, text] of [['failed', 'P5-keep-failed-draft'], ['delivery_unknown', 'P5-keep-unknown-draft']] as const) {
    await chooseMode('follow_up'); await input().fill(text); const before = (await accepted()).length;
    await rules([{ method: 'session.submit', sessionId: a, hold: 'accepted-' + outcome }]); await page.getByRole('button', { name: 'Follow Up', exact: true }).click(); await entered('accepted-' + outcome);
    const original = (await accepted())[before]!; if (!original.inputId) throw new Error('Missing actual accepted Input'); const actual = await readInput(original.inputId);
    const projected: SessionInput = { ...actual, status: outcome, processingStatus: outcome === 'failed' ? 'failed' : 'pending', processedAt: outcome === 'failed' ? new Date().toISOString() : null, runId: null, nativeEntryId: null, error: safeError(outcome === 'failed' ? 'input_hook_handled' : 'input_delivery_unknown') };
    await rules([{ method: 'session.readInput', inputId: original.inputId, project: { ok: true, data: projected } }]); await release('accepted-' + outcome);
    await expect(input()).toHaveValue(text); await expect(page.getByRole('button', { name: 'Follow Up', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Read original submission', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Follow Up', exact: true })).toBeDisabled();
    if (outcome === 'failed') { await expect(page.getByRole('button', { name: 'Start a new attempt', exact: true })).toBeVisible(); await expect(page.locator('.error-banner')).toContainText('input'); }
    else { await expect(page.getByRole('button', { name: 'Start a new attempt', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Resend original submission', exact: true })).toBeDisabled(); }
    expect((await calls()).filter(call => call.method === 'session.submit' && call.payload.sessionId === a && call.payload.clientSequence === original.clientSequence)).toHaveLength(1);
    save('accepted-' + outcome, { actualHostAcceptance: original, projectedReadPresentationOnly: projected, draftPreserved: text, submits: 1 });
    if (outcome === 'failed') { const count = (await calls()).filter(call => call.method === 'session.submit').length; await page.getByRole('button', { name: 'Start a new attempt', exact: true }).click(); await expect(input()).toHaveValue(text); expect((await calls()).filter(call => call.method === 'session.submit')).toHaveLength(count); }
  }
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click(); first.release(); await idle();
});

test('an accepted input with an unavailable confirmation read retains its frozen mode until original lookup succeeds', async () => {
  const a = await create(), first = gate(); steps = [async () => { first.enter(); await first.response; return 'Read failure root'; }, () => 'Original confirmed follow up'];
  const rootInput = await clickSubmit('P5-confirm-read-root'); await first.entered; await chooseMode('follow_up'); await input().fill('Preserve this unconfirmed follow up');
  const before = (await accepted()).length, physicalBefore = physical;
  await rules([{ method: 'session.submit', sessionId: a, hold: 'confirmation-read-failure' }]); await page.getByRole('button', { name: 'Follow Up', exact: true }).click(); await entered('confirmation-read-failure');
  const original = (await accepted())[before]!; if (!original.inputId) throw new Error('Missing actual accepted Input');
  await rules([{ method: 'session.readInput', inputId: original.inputId, project: { ok: false, error: safeError('storage_read_failed') } }]); await release('confirmation-read-failure');
  await expect(page.locator('.error-banner')).toContainText('The original Input is unavailable'); await expect(input()).toHaveValue('Preserve this unconfirmed follow up');
  await expect(page.getByRole('button', { name: 'Start a new attempt', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Read original submission', exact: true })).toBeEnabled(); await expect(page.getByRole('button', { name: 'Follow Up', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Message actions', exact: true })).toBeDisabled();
  const originalCall = (await calls()).filter(call => call.method === 'session.submit' && call.payload.sessionId === a && call.payload.clientSequence === original.clientSequence)[0]!;
  expect(originalCall).toMatchObject({ operationRef: original.operationRef, payload: { sessionId: a, clientSequence: original.clientSequence, mode: 'follow_up', targetRunId: rootInput.runId, text: 'Preserve this unconfirmed follow up' } });
  const prior = (await calls()).length; await page.getByRole('button', { name: 'Read original submission', exact: true }).click(); await expect(page.getByRole('button', { name: 'Read original submission', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible(); await expect(input()).toHaveValue('');
  expect((await calls()).slice(prior).filter(call => call.method === 'session.readSubmission')).toHaveLength(1);
  expect((await calls()).slice(prior).find(call => call.method === 'session.readSubmission')?.payload).toEqual({ sessionId: a, clientSequence: original.clientSequence });
  expect((await calls()).filter(call => call.method === 'session.submit' && call.operationRef === original.operationRef)).toHaveLength(1); expect(physical).toBe(physicalBefore); const physicalAfterRead = physical;
  const verified = await readInput(original.inputId); expect(verified.mode).toBe('follow_up'); expect(verified.targetRunId).toBe(rootInput.runId); expect(verified.status).toBe('queued');
  first.release(); await idle(); expect((await readInput(original.inputId)).processingStatus).toBe('completed');
  save('accepted-confirmation-read-error', { a, rootInput, original, originalCall, verified, calls: (await calls()).slice(prior), physicalReadDelta: physicalAfterRead - physicalBefore, physicalAfterOriginalCompletion: physical });
});

test('a late null lookup cannot authorize replay of a different new pending attempt', async () => {
  const a = await create(), b = await create(); await select(a); const first = gate();
  steps = [async () => { first.enter(); await first.response; return 'Original race root'; }, () => 'Actual replacement input'];
  await clickSubmit('P5-old-lookup-root'); await first.entered; await chooseMode('follow_up'); await input().fill('Original rejected follow up');
  await rules([{ method: 'session.submit', sessionId: a, requestPatch: { expectedRevision: 999999 } }]); await page.getByRole('button', { name: 'Follow Up', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start a new attempt', exact: true })).toBeVisible();
  const rejected = (await calls()).filter(call => call.method === 'session.submit' && call.payload.text === 'Original rejected follow up').at(-1)!;
  await rules([{ method: 'session.readSubmission', sessionId: a, hold: 'old-null-lookup' }]); await page.getByRole('button', { name: 'Read original submission', exact: true }).click(); await entered('old-null-lookup');
  await select(b); await input().fill('B independent race draft'); await expect(page.getByRole('button', { name: 'Start a new attempt', exact: true })).toHaveCount(0); await select(a);
  await page.getByRole('button', { name: 'Start a new attempt', exact: true }).click(); await input().fill('Replacement unconfirmed follow up');
  await rules([{ method: 'session.submit', sessionId: a, project: { ok: false, error: safeError('operation_result_unknown') } }]); const replacement = await clickSubmit('Replacement unconfirmed follow up', 'follow_up');
  expect(replacement.operationRef).not.toBe(rejected.operationRef); expect(replacement.clientSequence).toBe(rejected.payload.clientSequence);
  await expect(page.getByRole('button', { name: 'Read original submission', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Start a new attempt', exact: true })).toHaveCount(0);
  await release('old-null-lookup'); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('button', { name: 'Resend original submission', exact: true })).toBeDisabled(); await expect(input()).toHaveValue('Replacement unconfirmed follow up');
  await expect(page.getByRole('button', { name: 'Follow Up', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Read original submission', exact: true }).click(); await expect(page.getByRole('button', { name: 'Read original submission', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  expect((await calls()).filter(call => call.method === 'session.submit' && call.operationRef === replacement.operationRef)).toHaveLength(1);
  first.release(); await idle(); await select(b); await expect(input()).toHaveValue('B independent race draft');
  save('new-attempt-late-null-lookup', { a, b, rejected, replacement, calls: await calls() });
});

test('a confirmed identity conflict cannot treat another operation at the same sequence as its own successful input', async () => {
  const a = await create(), first = gate(); steps = [async () => { first.enter(); await first.response; return 'Conflict owner root'; }, () => 'Actual other operation'];
  const rootInput = await clickSubmit('P5-conflict-root'); await first.entered; await chooseMode('follow_up'); await input().fill('Same sequence and mode with another identity');
  await rules([{ method: 'session.submit', sessionId: a, hold: 'conflict-before-host', before: true }]); await page.getByRole('button', { name: 'Follow Up', exact: true }).click(); await entered('conflict-before-host');
  const rejected = (await calls()).filter(call => call.method === 'session.submit' && call.payload.text === 'Same sequence and mode with another identity').at(-1)!;
  const acceptedOther = await page.evaluate(async original => window.medclaw.request('session.submit', original.payload as unknown as import('../../packages/contracts/src/session').SubmitInput, crypto.randomUUID()), rejected);
  expect(acceptedOther.ok).toBe(true); if (!acceptedOther.ok || !acceptedOther.data.inputId) throw new Error('Missing real conflicting Input');
  await release('conflict-before-host'); await expect(page.getByRole('button', { name: 'Start a new attempt', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Follow Up', exact: true })).toBeDisabled();
  const other = await readInput(acceptedOther.data.inputId); expect(other.clientSequence).toBe(rejected.payload.clientSequence); expect(other.mode).toBe('follow_up'); expect(other.status).toBe('queued'); expect(other.targetRunId).toBe(rootInput.runId);
  const before = (await calls()).filter(call => call.method === 'session.submit').length; await page.getByRole('button', { name: 'Read original submission', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start a new attempt', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Read original submission', exact: true })).toBeVisible(); await expect(input()).toHaveValue('Same sequence and mode with another identity');
  await expect(page.getByRole('button', { name: 'Follow Up', exact: true })).toBeDisabled(); expect((await calls()).filter(call => call.method === 'session.submit')).toHaveLength(before);
  await page.getByRole('button', { name: 'Start a new attempt', exact: true }).click(); await expect(input()).toHaveValue('Same sequence and mode with another identity'); expect((await calls()).filter(call => call.method === 'session.submit')).toHaveLength(before);
  first.release(); await idle(); save('failure-same-sequence-foreign-operation', { a, rootInput, rejected, acceptedOther, other, calls: await calls() });
});

test('a retry that becomes unknown revokes a prior confirmed failure and resends only its frozen original request', async () => {
  const a = await create(), first = gate(); steps = [async () => { first.enter(); await first.response; return 'Retry root only'; }];
  await clickSubmit('P5-retry-failure-root'); await first.entered; await chooseMode('follow_up'); await input().fill('Frozen rejected request');
  await rules([{ method: 'session.submit', sessionId: a, requestPatch: { expectedRevision: 999999 } }]); await page.getByRole('button', { name: 'Follow Up', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start a new attempt', exact: true })).toBeVisible();
  const original = (await calls()).filter(call => call.method === 'session.submit' && call.payload.text === 'Frozen rejected request').at(-1)!;
  await input().fill('Edited text belongs to a future attempt'); await page.getByRole('button', { name: 'Read original submission', exact: true }).click(); await expect(page.getByRole('button', { name: 'Resend original submission', exact: true })).toBeEnabled();
  await rules([{ method: 'session.submit', sessionId: a, requestPatch: { expectedRevision: 999999 }, project: { ok: false, error: safeError('operation_result_unknown') }, hold: 'retry-becomes-unknown' }]);
  await page.getByRole('button', { name: 'Resend original submission', exact: true }).click(); await entered('retry-becomes-unknown'); await expect(page.getByRole('button', { name: 'Start a new attempt', exact: true })).toHaveCount(0);
  await release('retry-becomes-unknown'); await expect(page.getByRole('button', { name: 'Read original submission', exact: true })).toBeEnabled(); await expect(page.getByRole('button', { name: 'Start a new attempt', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resend original submission', exact: true })).toBeDisabled(); await expect(input()).toHaveValue('Edited text belongs to a future attempt'); await expect(page.getByRole('button', { name: 'Follow Up', exact: true })).toBeDisabled();
  const submits = (await calls()).filter(call => call.method === 'session.submit' && call.operationRef === original.operationRef); expect(submits).toHaveLength(2); expect(submits[1]!.payload).toEqual(original.payload);
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click(); first.release(); await idle(); save('retry-failure-becomes-unknown', { a, original, submits, calls: await calls() });
});

test('terminal unknown Input history remains readable without permanent automatic per-input polling', async () => {
  const a = await create(); steps = [() => 'P5 terminal history']; const original = await clickSubmit('P5-terminal-history'); await idle(); if (!original.inputId) throw new Error('Missing actual accepted Input');
  const actual = await readInput(original.inputId), projected: SessionInput = { ...actual, status: 'delivery_unknown', processingStatus: 'failed', runId: null, nativeEntryId: null, processedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: safeError('input_delivery_unknown') };
  await inspectInputs(); await rules([{ method: 'session.listInputs', sessionId: a, project: { ok: true, data: { sessionId: a, items: [projected], nextClientSequence: null, hasMore: false } } }]); await queue().getByRole('button', { name: 'Refresh inputs', exact: true }).click(); await expect(item(original.inputId)).toContainText('Delivery unknown / Failed');
  const before = (await calls()).length;
  await expect.poll(async () => (await calls()).slice(before).filter(call => call.method === 'session.listInputs' && call.payload.sessionId === a).length).toBeGreaterThanOrEqual(2);
  const background = (await calls()).slice(before); expect(background.filter(call => call.method === 'session.readInput' && call.payload.inputId === original.inputId)).toHaveLength(0);
  const explicit = await readInput(original.inputId); expect(explicit.id).toBe(original.inputId); save('terminal-unknown-polling', { actualHostAcceptance: original, projectedReadPresentationOnly: projected, background, explicitReadId: explicit.id });
});

test('legacy acceptance reads only its Run and an old Host input reply is ignored after a real restart', async () => {
  const a = await create(), first = gate(); steps = [async () => { first.enter(); await first.response; return 'P5 legacy completion'; }];
  await rules([{ method: 'session.submit', sessionId: a, hold: 'legacy-send', legacy: true }]);
  await input().fill('P5-legacy-root'); const before = (await accepted()).length; await page.getByRole('button', { name: 'Send', exact: true }).click(); await entered('legacy-send'); await first.entered;
  const original = (await accepted())[before]!; if (!original.runId || !original.inputId) throw new Error('Missing original IDs');
  first.release(); await idle(); const readBefore = (await calls()).length; await release('legacy-send'); await expect(input()).toHaveValue('');
  await expect.poll(async () => (await calls()).slice(readBefore).some(call => call.method === 'run.read' && call.payload.runId === original.runId)).toBe(true);
  const legacyReads = (await calls()).slice(readBefore); expect(legacyReads.some(call => call.method === 'session.readInput')).toBe(false);
  // Establish the terminal Input projection before holding its next read. A
  // background reconciliation of the legacy receipt must not consume this gate.
  await inspectInputs(); await expect(item(original.inputId)).toContainText('Completed');
  await inspectInputs(); await expect(queue().getByRole('button', { name: 'Refresh inputs', exact: true })).toBeEnabled();
  // A genuine Host restart provides a different instance; held old reads cannot populate its cache.
  const old = await page.evaluate(() => window.medclaw.request('host.read', {})); if (!old.ok || !old.data.instanceId) throw new Error('No Host');
  const unknown: SessionInput = { ...(await readInput(original.inputId)), status: 'delivery_unknown', processingStatus: 'pending', runId: null, nativeEntryId: null, processedAt: null, error: safeError('input_delivery_unknown') };
  await inspectInputs(); await rules([{ method: 'session.listInputs', sessionId: a, afterClientSequence: null, hold: 'old-host-list', project: { ok: true, data: { sessionId: a, items: [unknown], nextClientSequence: null, hasMore: false } } }]); await queue().getByRole('button', { name: 'Refresh inputs', exact: true }).click(); await entered('old-host-list');
  const restarted = await page.evaluate(expectedInstanceId => window.medclaw.request('host.restart', { expectedInstanceId }), old.data.instanceId); expect(restarted.ok).toBe(true); if (!restarted.ok) throw new Error(restarted.error.code);
  await expect.poll(async () => { const host = await page.evaluate(() => window.medclaw.request('host.read', {})); return host.ok && host.data.state === 'ready' && host.data.instanceId !== old.data.instanceId; }).toBe(true);
  await inspectInputs(); await release('old-host-list'); await expect(queue()).not.toContainText('Delivery unknown'); await expect(item(original.inputId)).toContainText('Completed');
  expect((await calls()).some(call => call.method === 'session.readInput' && call.payload.inputId === null || call.method === 'run.read' && call.payload.runId === null)).toBe(false);
  save('old-instance', { a, original, oldInstanceId: old.data.instanceId, newInstanceId: restarted.data.instanceId, beforePhysical: physical, afterPhysical: physical });
});

test('message action menus close on Session, original Run and Host changes without submitting a draft', async () => {
  const a = await create(), b = await create(); await select(a); const first = gate();
  steps = [async () => { first.enter(); await first.response; return 'Original Run finishes without correction'; }];
  const original = await clickSubmit('P5-menu-boundary-root'); await first.entered; await chooseMode('steer'); await input().fill('Still an unsent correction');
  const arrow = page.getByRole('button', { name: 'Message actions', exact: true }), menu = page.getByRole('menu', { name: 'Message actions', exact: true });
  const before = (await calls()).filter(call => call.method === 'session.submit').length;
  await arrow.click(); await expect(menu).toBeVisible(); await select(b); await expect(menu).toHaveCount(0); await expect(arrow).toHaveCount(0);
  await select(a); await expect(input()).toHaveValue('Still an unsent correction'); await expect(page.getByRole('button', { name: 'Steer', exact: true })).toBeVisible();
  await arrow.click(); await expect(menu).toBeVisible(); first.release(); await idle(); await expect(menu).toHaveCount(0); await expect(arrow).toHaveCount(0); await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  expect((await calls()).filter(call => call.method === 'session.submit')).toHaveLength(before);

  const second = gate(); steps = [async () => { second.enter(); await second.response; return 'Restarted original Run'; }];
  const next = await clickSubmit('P5-menu-host-boundary'); await second.entered; await chooseMode('follow_up'); await input().fill('Unsent follow up across Host'); await arrow.click(); await expect(menu).toBeVisible();
  const host = await page.evaluate(() => window.medclaw.request('host.read', {})); if (!host.ok || !host.data.instanceId) throw new Error('Missing Host');
  const restart = page.evaluate(expectedInstanceId => window.medclaw.request('host.restart', { expectedInstanceId }), host.data.instanceId);
  await expect(menu).toHaveCount(0); second.release(); const restarted = await restart; expect(restarted.ok).toBe(true);
  await expect.poll(async () => { const result = await page.evaluate(() => window.medclaw.request('host.read', {})); return result.ok && result.data.state === 'ready' && result.data.instanceId !== host.data.instanceId; }).toBe(true);
  await expect(arrow).toHaveCount(0); await expect(input()).toHaveValue('Unsent follow up across Host');
  expect((await calls()).filter(call => call.method === 'session.submit' && call.payload.sessionId === a)).toHaveLength(2);
  save('menu-target-boundaries', { a, b, original, next, oldInstance: host.data.instanceId, restarted, calls: (await calls()).filter(call => call.method === 'session.submit' && call.payload.sessionId === a) });
});
