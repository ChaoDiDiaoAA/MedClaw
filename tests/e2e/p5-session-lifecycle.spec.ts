import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { safeError } from '../../packages/contracts/src/error';
import type { SessionManagementReceipt } from '../../packages/contracts/src/session';
import { canonicalRequest } from '../../packages/contracts/src/run';

const root = resolve(import.meta.dirname, '../..'), bun = process.env.MEDCLAW_BUN_EXECUTABLE ?? 'bun';
let app: ElectronApplication, page: Page, temporary: string, server: Server;
type Call = { method: string; payload: Record<string, unknown>; operationRef: string; startedAt: number; completedAt?: number };
type Rule = { method: string; sessionId?: number; operationRef?: string; hold?: string; defer?: boolean; unknown?: boolean; project?: unknown };
type Gates = { rules: Rule[]; calls: Call[]; entered: string[]; pending: Record<string, () => void>; receipts: SessionManagementReceipt[] };
type MainGlobal = typeof globalThis & { __lifecycle: Gates };
let physicalCalls = 0;
let queryFlow = false, queryId = 0;
const evidence = join(root, '.build/session-lifecycle/e2e');
test.describe.configure({ mode: 'serial' });
const composer = () => page.getByLabel('Message text', { exact: true });
const row = (id: number) => page.locator(`.session-row[data-session-id="${id}"]`);
const editor = () => page.getByRole('dialog');
async function calls() { return app.evaluate(() => (globalThis as MainGlobal).__lifecycle.calls); }
async function rules(values: Rule[]) { await app.evaluate((_, values) => { (globalThis as MainGlobal).__lifecycle.rules.push(...values); }, values); }
async function entered(id: string) { await expect.poll(() => app.evaluate((_, id) => (globalThis as MainGlobal).__lifecycle.entered.includes(id), id)).toBe(true); }
async function release(id: string) { await app.evaluate((_, id) => { (globalThis as MainGlobal).__lifecycle.pending[id]?.(); }, id); }
async function workspace() { const value = await page.evaluate(() => window.medclaw.request('workspace.read', {})); if (!value.ok) throw new Error(value.error.code); return value.data; }
async function session(id: number) { const value = await page.evaluate(sessionId => window.medclaw.request('session.read', { sessionId }), id); if (!value.ok || !value.data) throw new Error('Missing Session'); return value.data.session; }
async function create() {
  const prior = (await workspace()).sessionId;
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  await expect.poll(async () => (await workspace()).sessionId).not.toBe(prior);
  const id = (await workspace()).sessionId!, title = (await session(id)).title; await expect(row(id).locator('button[aria-pressed]')).toHaveText(title); await expect(page.getByTestId('current-session')).toContainText(title); return id;
}
async function select(id: number) { await row(id).locator('button[aria-pressed]').click(); await expect(page.getByTestId('current-session')).toContainText((await session(id)).title); }
async function action(id: number, name: 'Rename' | 'Delete') { await row(id).getByRole('button', { name: /^Session actions for / }).click(); await row(id).getByRole('menuitem', { name, exact: true }).click(); await expect(editor()).toBeVisible(); }
async function rename(id: number, title: string) { await action(id, 'Rename'); await editor().getByLabel('Session name').fill(title); await editor().getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor()).toHaveCount(0); }
async function remove(id: number) { await action(id, 'Delete'); await editor().getByRole('button', { name: 'Delete session', exact: true }).click(); await expect(editor()).toHaveCount(0); await expect(row(id)).toHaveCount(0); }
async function idle() { await expect.poll(async () => { const value = await page.evaluate(() => window.medclaw.request('run.control.read', {})); return value.ok && value.data.acceptingNewRuns; }).toBe(true); }
function sql(query: string) { return JSON.parse(execFileSync(bun, ['-e', 'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); console.log(JSON.stringify(db.query(process.argv[2]).all())); db.close();', join(temporary, 'data', 'data', 'app.sqlite'), query], { cwd: root, encoding: 'utf8' })); }
function save(name: string, value: unknown) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, name + '.json'), JSON.stringify(value, null, 2)); }

function snapshotPackage(directory: string) {
  mkdirSync(directory, { recursive: true });
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const csv = (values: string[]) => values.map(value => `"${value.replaceAll('"', '""')}"`).join(',');
  const masters = ['First device', 'Second device'].map((device_name, i) => ({ record_type: 'master', device_id: String(i + 1).padStart(5, '0'), device_name, source_submission_id: String(i + 1).padStart(5, '0'), source_applicant: 'Synthetic Applicant', category: 'Category', manufacturer: 'Synthetic Manufacturer' }));
  const sourceLock = { schema: 'medclaw.source-lock/v1', sources: [{ source: 'fixture', path: 'original.csv', sha256: 'a'.repeat(64) }] };
  const lockHash = hash(canonicalRequest(sourceLock)), cohortHash = hash(canonicalRequest(masters));
  writeFileSync(join(directory, 'source-lock.json'), JSON.stringify(sourceLock)); writeFileSync(join(directory, 'entity-lineage.csv'), `${csv(Object.keys(masters[0]!))}\n${masters.map(master => csv(Object.values(master))).join('\n')}\n`);
  for (const name of ['adjustment-lineage.csv', 'validation-report.json', 'selection-report.json', '使用说明.md']) writeFileSync(join(directory, name), name.endsWith('.json') ? '{}' : 'fixture');
  const columns = ['device_id', 'device_name', 'source_submission_id', 'source_applicant', 'category', 'region', 'snapshot_date', 'price_cents', 'currency', 'unit', 'status', 'manufacturer', 'distributor', 'source_refs_json', 'field_origins_json'];
  const origins = Object.fromEntries(columns.slice(0, 13).map(key => [key, { kind: 'synthetic', ruleId: 'lifecycle-fixture' }]));
  for (const [index, prices] of [[10000, 20000], [8000, 15000]].entries()) {
    const date = `2026-01-0${index + 1}`;
    const text = `${csv(columns)}\n${masters.map((master, ordinal) => csv([master.device_id, master.device_name, master.source_submission_id, master.source_applicant, 'Category', '浙江', date, String(prices[ordinal]), 'CNY', '件', 'active', master.manufacturer, 'Synthetic Distributor', JSON.stringify([{ sourceId: 'fixture', file: 'original.csv', row: ordinal + 1, recordId: master.source_submission_id, sha256: 'a'.repeat(64) }]), JSON.stringify(origins)])).join('\n')}\n`;
    writeFileSync(join(directory, `zhejiang_${date}.csv`), text); writeFileSync(join(directory, `zhejiang_${date}.metadata.json`), JSON.stringify({ contract: 'medclaw.snapshot/v1', mappingVersion: 'medclaw.snapshot/v1', materialVersion: 'lifecycle-fixture/v1', generatorVersion: 'lifecycle-fixture/v1', seed: 1, sourceBundleId: 'lifecycle-fixture', sourceLockHash: lockHash, scopeKey: 'lifecycle-zhejiang', region: '浙江', cohortHash, snapshotDate: date, coverage: 'full', expectedEntityCount: 2, observedEntityCount: 2, declaredMissingEntityIds: [], fileSha256: hash(text), referenceDate: '2026-01-02', timezone: 'Asia/Shanghai' }));
  }
  const files = readdirSync(directory).sort().map(path => { const bytes = readFileSync(join(directory, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }; });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ status: 'complete', files, businessFiles: 2, businessRows: 4, businessBytes: files.filter(file => /^zhejiang_.*\.csv$/.test(file.path)).reduce((sum, file) => sum + file.bytes, 0), totalPayloadBytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
}

test.beforeAll(async () => {
  test.setTimeout(90000);
  for (const part of ['main', 'preload']) execFileSync(bun, ['build', `apps/desktop/src/${part}/index.ts`, '--target=node', '--format=cjs', '--external=electron', `--outfile=.build/desktop/${part}/index.cjs`], { cwd: root });
  execFileSync(bun, ['build', 'apps/desktop/src/renderer/index.html', '--target=browser', '--outdir=.build/desktop/renderer'], { cwd: root });
  temporary = mkdtempSync(join(tmpdir(), 'medclaw-session-lifecycle-')); snapshotPackage(join(temporary, 'source'));
  server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const wire = JSON.parse(body); physicalCalls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (queryFlow) {
      const scopeMessage = wire.messages.find((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'lifecycle-scope');
      const queryMessage = wire.messages.find((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'lifecycle-query');
      const tool = !scopeMessage ? { id: 'lifecycle-scope', name: 'read_data_scope', args: {} } : !queryMessage ? { id: 'lifecycle-query', name: 'query_device_changes', args: { batchIds: JSON.parse(scopeMessage.content).scope.batchIds, time: { start: '2026-01-02', endExclusive: '2026-01-03' }, changeField: 'price', direction: 'decrease', page: 1, pageSize: 50 } } : null;
      if (queryMessage) { queryId = JSON.parse(queryMessage.content).queryId; queryFlow = false; }
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: 'assistant', content: 'The saved query remains readable.' };
      response.end(`data: ${JSON.stringify({ id: 'lifecycle-query-response', model: wire.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'lifecycle-query-response', model: wire.model, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`); return;
    }
    response.write(`data: ${JSON.stringify({ id: 'lifecycle', model: wire.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Lifecycle reply' }, finish_reason: null }] })}\n\n`);
    const timer = setTimeout(() => { response.end(`data: ${JSON.stringify({ id: 'lifecycle', model: wire.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); }, JSON.stringify(wire.messages).includes('lifecycle-live') ? 30000 : 50);
    response.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const seam = join(temporary, 'public-gates.cjs');
  writeFileSync(seam, `const {ipcMain}=require('electron');const original=ipcMain.handle.bind(ipcMain);
    const state=globalThis.__lifecycle={rules:[],calls:[],entered:[],pending:{},receipts:[]};
    ipcMain.handle=(channel,listener)=>original(channel,async(event,envelope)=>{
      if(channel!=='medclaw:request')return listener(event,envelope);
      const p=envelope.payload;const call={method:envelope.method,payload:p,operationRef:envelope.operationRef,startedAt:Date.now()};state.calls.push(call);
      const index=state.rules.findIndex(r=>r.method===envelope.method&&(r.sessionId===undefined||r.sessionId===p.sessionId)&&(r.operationRef===undefined||r.operationRef===p.operationRef));
      const rule=index<0?null:state.rules.splice(index,1)[0];
      const hold=async()=>{state.entered.push(rule.hold);await new Promise(resolve=>state.pending[rule.hold]=resolve);delete state.pending[rule.hold];};
      const invoke=async()=>{const result=await listener(event,envelope);call.completedAt=Date.now();if(['session.rename','session.delete'].includes(envelope.method)&&result.ok)state.receipts.push(result.data);return result;};
      if(rule?.defer){void(async()=>{await hold();await invoke();})();return {ok:false,error:{code:'operation_result_unknown',message:'Operation result is unknown',operationRef:envelope.operationRef}};}
      let result=await invoke();if(rule?.hold)await hold();if(rule?.project)result=rule.project;
      if(rule?.unknown)return {ok:false,error:{code:'operation_result_unknown',message:'Operation result is unknown',operationRef:envelope.operationRef}};return result;
    });`);
  const require = createRequire(join(root, 'apps/desktop/package.json')), electronPath: string = require('electron');
  const playwright = createRequire(createRequire(import.meta.url).resolve('@playwright/test/package.json')), core = createRequire(playwright.resolve('playwright/package.json')).resolve('playwright-core/package.json');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])), MEDCLAW_HOST_ENTRY: join(root, 'apps/host/src/main.ts'), MEDCLAW_BUN_EXECUTABLE: execFileSync(bun, ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).trim() };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: electronPath, args: ['-r', join(dirname(core), 'lib/server/electron/loader.js'), '-r', seam, join(root, '.build/desktop/main/index.cjs'), '--medclaw-data-root', join(temporary, 'data')], env, timeout: 30000 });
  page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 }); await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, join(temporary, 'source'));
  const configured = await page.evaluate(async baseUrl => {
    const directory = await window.medclaw.request('model.read', {}); if (!directory.ok) throw new Error(directory.error.code);
    const token = await window.medclaw.secretInput({ providerId: 'lifecycle-fixture', purpose: 'custom_api_key', value: 'LOCAL-FIXTURE-ONLY' }); if (!token.ok) throw new Error(token.error.code);
    const saved = await window.medclaw.request('model.custom.save', { expectedConfigVersion: directory.data.configVersion, credentialInput: token.data.token, definition: { providerId: 'lifecycle-fixture', name: 'Lifecycle fixture', api: 'openai-completions', baseUrl, models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] } }); if (!saved.ok) throw new Error(saved.error.code);
    return window.medclaw.request('model.configure', { provider: 'lifecycle-fixture', modelId: 'fixture', expectedConfigVersion: saved.data.configVersion });
  }, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`); expect(configured.ok).toBe(true);
});
test.afterAll(async () => {
  await app?.evaluate(() => Object.values((globalThis as MainGlobal).__lifecycle.pending).forEach(release => release())).catch(() => {}); await app?.close();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (temporary) { const target = resolve(temporary), within = relative(resolve(tmpdir()), target); if (within && !within.startsWith('..') && !within.includes(':')) rmSync(target, { recursive: true, force: true }); }
});
test.afterEach(async ({}, info) => { if (page) { const name = info.title.replaceAll(/[^a-zA-Z0-9]+/g, '-') + (info.repeatEachIndex ? `-repeat-${info.repeatEachIndex}` : ''); mkdirSync(evidence, { recursive: true }); save('dom-' + name, { sidebar: await page.getByRole('region', { name: 'Sessions', exact: true }).ariaSnapshot(), calls: await calls() }); await page.screenshot({ path: join(evidence, name + '.png') }); } });

test('session menus and rename keyboard editing preserve selection and literal user titles', async () => {
  const a = await create(); await composer().fill('A independent draft'); const b = await create(); await composer().fill('B independent draft');
  const before = await workspace(), menu = row(a).getByRole('button', { name: /^Session actions for / });
  await expect(menu).toBeVisible();
  await menu.focus(); await page.keyboard.press('Enter'); await expect(row(a).getByRole('menu')).toBeVisible(); await page.keyboard.press('Escape'); await expect(menu).toBeFocused();
  expect(await workspace()).toEqual(before); await expect(composer()).toHaveValue('B independent draft');
  await action(a, 'Rename'); await expect(editor().getByLabel('Session name')).toBeFocused(); await editor().getByLabel('Session name').fill(`新会话 ${a}`); await page.keyboard.press('Enter'); await expect(editor()).toHaveCount(0);
  await expect(row(a).getByRole('button', { name: `新会话 ${a}`, exact: true })).toBeVisible(); expect((await session(a)).title).toBe(`新会话 ${a}`); expect((await session(a)).metadataRevision).toBe(1);
  await rename(a, `  新会话 ${a}  `); expect((await session(a)).metadataRevision).toBe(1);
  const sameTitleReceipt = await app.evaluate(() => (globalThis as MainGlobal).__lifecycle.receipts.at(-1)); expect(sameTitleReceipt?.method).toBe('session.rename'); expect(sameTitleReceipt?.session.metadataRevision).toBe(1);
  expect(await workspace()).toEqual(before); await select(a); await expect(composer()).toHaveValue('A independent draft'); await select(b); await expect(composer()).toHaveValue('B independent draft');
  await action(a, 'Rename'); await editor().getByLabel('Session name').fill('   '); await editor().getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor().getByRole('alert')).toBeVisible(); await expect(editor().getByLabel('Session name')).toHaveValue('   ');
  await page.keyboard.press('Escape'); await expect(editor()).toHaveCount(0); await expect(row(a).getByRole('button', { name: /^Session actions for / })).toBeFocused(); expect((await session(a)).metadataRevision).toBe(1);
  save('menus-and-literal-title', { a, b, before, after: await workspace(), session: await session(a), sql: sql(`SELECT id,title,status,metadata_revision,deleted_at FROM sessions WHERE id=${a}`) });
});

test('live rename and deleting an unrelated idle session preserve the original Run and Stop target', async () => {
  const a = await create(), b = await create(); await composer().fill('B retained during A'); await select(a); const beforeCalls = physicalCalls;
  await composer().fill('lifecycle-live original A'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => physicalCalls).toBe(beforeCalls + 1);
  const gate = await page.evaluate(() => window.medclaw.request('run.control.read', {})); if (!gate.ok || !gate.data.activeRootRun) throw new Error('Missing live original Run'); const runId = gate.data.activeRootRun.runId;
  await rename(a, 'Live A'); await expect(row(a)).toContainText('Running'); await select(b); await expect(composer()).toHaveValue('B retained during A');
  await expect(page.getByRole('button', { name: /^Stop/ }).first()).toBeEnabled(); await select(a); const before = await workspace();
  await action(a, 'Delete'); await editor().getByRole('button', { name: 'Delete session', exact: true }).click(); await expect(editor().getByRole('alert')).toBeVisible(); expect((await session(a)).status).toBe('active');
  await editor().getByRole('button', { name: 'Cancel', exact: true }).click(); await remove(b); expect(await workspace()).toEqual(before);
  const still = await page.evaluate(() => window.medclaw.request('run.control.read', {})); expect(still.ok && still.data.activeRootRun?.runId).toBe(runId); expect(physicalCalls).toBe(beforeCalls + 1);
  await page.getByRole('button', { name: /^Stop/ }).first().click(); await idle();
  expect((await calls()).filter(call => call.method === 'run.cancel').at(-1)?.payload.runId).toBe(runId);
  expect((await session(b)).status).toBe('deleted'); save('live-owner-and-idle-delete', { a, b, runId, before, after: await workspace(), physicalCalls, sql: sql(`SELECT id,title,status,metadata_revision,deleted_at FROM sessions WHERE id IN (${a},${b})`) });
});

test('metadata and workspace conflicts retain edited names and drafts until an explicit new action', async () => {
  const a = await create(); await composer().fill('A CAS draft'); const b = await create(); await composer().fill('B CAS draft');
  await action(a, 'Rename'); await editor().getByLabel('Session name').fill('Keep my edited name');
  const external = await page.evaluate(async sessionId => { const original = await window.medclaw.request('session.read', { sessionId }); if (!original.ok || !original.data) throw new Error('Missing target'); return window.medclaw.request('session.rename', { sessionId, title: 'External current name', expectedMetadataRevision: original.data.session.metadataRevision }); }, a); expect(external.ok).toBe(true);
  await editor().getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor().getByRole('alert')).toBeVisible(); await expect(editor().getByLabel('Session name')).toHaveValue('Keep my edited name');
  await page.keyboard.press('Escape'); await expect(editor()).toHaveCount(0); await expect(composer()).toHaveValue('B CAS draft');
  await action(a, 'Delete'); const moved = await page.evaluate(async sessionId => { const w = await window.medclaw.request('workspace.read', {}); if (!w.ok) throw new Error('Missing workspace'); return window.medclaw.request('session.select', { sessionId, expectedWorkspaceRevision: w.data.revision }); }, a); expect(moved.ok).toBe(true);
  await editor().getByRole('button', { name: 'Delete session', exact: true }).click(); await expect(editor().getByRole('alert')).toBeVisible(); expect((await session(a)).status).toBe('active');
  await editor().getByRole('button', { name: 'Cancel', exact: true }).click(); await select(b); await expect(composer()).toHaveValue('B CAS draft');
  save('conflict-preserves-edits', { a, b, session: await session(a), workspace: await workspace() });
});

test('lost rename replies query the original identity and cannot overwrite a newer title or another draft', async () => {
  const a = await create(); await composer().fill('A unknown rename draft'); const b = await create(); await composer().fill('B unknown rename draft');
  await rules([{ method: 'session.rename', sessionId: a, unknown: true }]); await action(a, 'Rename'); await editor().getByLabel('Session name').fill('Original lost title'); await editor().getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor().getByRole('button', { name: 'Read original rename', exact: true })).toBeVisible(); await editor().getByRole('button', { name: 'Keep for later', exact: true }).click();
  const original = (await calls()).filter(call => call.method === 'session.rename' && call.payload.sessionId === a).at(-1)!;
  const newer = await page.evaluate(async sessionId => { const old = await window.medclaw.request('session.read', { sessionId }); if (!old.ok || !old.data) throw new Error('Missing target'); return window.medclaw.request('session.rename', { sessionId, title: 'Newest current title', expectedMetadataRevision: old.data.session.metadataRevision }); }, a); expect(newer.ok).toBe(true);
  await rules([{ method: 'session.readManagementOperation', operationRef: original.operationRef, hold: 'rename-lookup' }]); await page.getByRole('button', { name: 'Read original rename', exact: true }).click(); await entered('rename-lookup');
  await select(a); await expect(composer()).toHaveValue('A unknown rename draft'); await select(b); await release('rename-lookup');
  await expect(row(a).getByRole('button', { name: 'Newest current title', exact: true })).toBeVisible(); await expect(composer()).toHaveValue('B unknown rename draft'); expect((await workspace()).sessionId).toBe(b);
  expect((await calls()).filter(call => call.method === 'session.rename' && call.operationRef === original.operationRef)).toHaveLength(1);
  save('lost-rename-original-identity', { a, b, original, current: await session(a), receipts: await app.evaluate(() => (globalThis as MainGlobal).__lifecycle.receipts) });
});

test('a null lookup cannot release a late delete and only its positive receipt clears the original draft', async () => {
  const b = await create(); await composer().fill('B survives delete recovery'); const a = await create(); await composer().fill('A retained until positive receipt');
  await rules([{ method: 'session.delete', sessionId: a, defer: true, hold: 'late-delete' }]); await action(a, 'Delete'); await editor().getByRole('button', { name: 'Delete session', exact: true }).click(); await entered('late-delete');
  await expect(editor().getByRole('button', { name: 'Read original delete', exact: true })).toBeVisible(); await editor().getByRole('button', { name: 'Keep for later', exact: true }).click();
  await page.getByRole('button', { name: 'Read original delete', exact: true }).click(); await expect(page.getByText('The original operation is not recorded yet. Keep its identity and read it again.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeDisabled(); await expect(row(b).getByRole('button', { name: (await session(b)).title, exact: true })).toBeDisabled();
  await expect(composer()).toHaveValue('A retained until positive receipt'); expect((await session(a)).status).toBe('active');
  const original = (await calls()).filter(call => call.method === 'session.delete' && call.payload.sessionId === a).at(-1)!;
  await rules([{ method: 'session.readManagementOperation', operationRef: original.operationRef, project: { ok: false, error: safeError('storage_read_failed') } }]);
  await page.getByRole('button', { name: 'Read original delete', exact: true }).click(); await expect(page.locator('.session-management-recovery')).toContainText('Unable to read saved run facts.');
  await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeDisabled(); await expect(composer()).toHaveValue('A retained until positive receipt');
  await release('late-delete');
  await expect.poll(async () => (await session(a)).status).toBe('deleted'); await page.getByRole('button', { name: 'Read original delete', exact: true }).click();
  await expect(row(a)).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Create a session', exact: true })).toBeVisible(); expect((await workspace()).sessionId).toBeNull();
  await select(b); await expect(composer()).toHaveValue('B survives delete recovery'); expect((await calls()).filter(call => call.method === 'session.delete' && call.operationRef === original.operationRef)).toHaveLength(1);
  const rejected = await page.evaluate(async sessionId => { const w = await window.medclaw.request('workspace.read', {}); if (!w.ok) throw new Error('Missing workspace'); return window.medclaw.request('session.select', { sessionId, expectedWorkspaceRevision: w.data.revision }); }, a); expect(rejected.ok).toBe(false);
  save('late-delete-null-and-positive', { a, b, original, deleted: await session(a), workspace: await workspace(), sql: sql(`SELECT id,status,metadata_revision,deleted_at FROM sessions WHERE id=${a}`) });
});

test('a historical delete receipt cannot replace a later real Workspace selection', async () => {
  const b = await create(); await composer().fill('B current after committed delete'); const a = await create(); await composer().fill('A original deleted draft');
  await rules([{ method: 'session.delete', sessionId: a, unknown: true }]); await action(a, 'Delete'); await editor().getByRole('button', { name: 'Delete session', exact: true }).click();
  await expect(editor().getByRole('button', { name: 'Read original delete', exact: true })).toBeVisible(); await editor().getByRole('button', { name: 'Keep for later', exact: true }).click();
  const original = (await calls()).filter(call => call.method === 'session.delete' && call.payload.sessionId === a).at(-1)!;
  const oldReceipt = await page.evaluate(operationRef => window.medclaw.request('session.readManagementOperation', { operationRef }), original.operationRef);
  if (!oldReceipt.ok || !oldReceipt.data || oldReceipt.data.method !== 'session.delete') throw new Error('Missing historical delete'); expect(oldReceipt.data.workspace.sessionId).toBeNull();
  const selected = await page.evaluate(async sessionId => { const w = await window.medclaw.request('workspace.read', {}); if (!w.ok) throw new Error('Missing workspace'); return window.medclaw.request('session.select', { sessionId, expectedWorkspaceRevision: w.data.revision }); }, b); expect(selected.ok).toBe(true);
  const latest = await workspace(); await page.getByRole('button', { name: 'Read original delete', exact: true }).click();
  await expect(row(a)).toHaveCount(0); await expect(page.getByTestId('current-session')).toContainText((await session(b)).title); await expect(composer()).toHaveValue('B current after committed delete'); expect(await workspace()).toEqual(latest);
  expect((await calls()).filter(call => call.method === 'session.delete' && call.operationRef === original.operationRef)).toHaveLength(1);
  save('historical-delete-new-selection', { a, b, oldReceipt, latest, current: await workspace(), original });
});

test('late list and creation receipts cannot resurrect a deleted Session or its old selection', async () => {
  const a = await create(), b = await create(); await composer().fill('B latest draft');
  await rules([{ method: 'session.list', hold: 'old-list' }]); await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click(); await entered('old-list');
  await remove(a); await release('old-list'); await expect(row(a)).toHaveCount(0); await expect(composer()).toHaveValue('B latest draft'); expect((await workspace()).sessionId).toBe(b);
  await rules([{ method: 'session.create', hold: 'old-create' }]); await page.getByRole('button', { name: 'New Session', exact: true }).click(); await entered('old-create');
  const c = (await workspace()).sessionId!; const deleted = await page.evaluate(async sessionId => { const [detail, w] = await Promise.all([window.medclaw.request('session.read', { sessionId }), window.medclaw.request('workspace.read', {})]); if (!detail.ok || !detail.data || !w.ok) throw new Error('Missing delete target'); return window.medclaw.request('session.delete', { sessionId, expectedMetadataRevision: detail.data.session.metadataRevision, expectedWorkspaceRevision: w.data.revision }); }, c); expect(deleted.ok).toBe(true);
  await release('old-create'); await expect(row(c)).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Create a session', exact: true })).toBeVisible(); expect((await workspace()).sessionId).toBeNull();
  await select(b); await expect(composer()).toHaveValue('B latest draft'); save('late-list-and-create', { a, b, c, current: await workspace(), deletedA: await session(a), deletedC: await session(c) });
});

test('an old Host management reply is ignored and original recovery reads the current title', async () => {
  const a = await create(), b = await create(); await composer().fill('B draft across restart');
  await rules([{ method: 'session.rename', sessionId: a, hold: 'old-host-rename' }]); await action(a, 'Rename'); await editor().getByLabel('Session name').fill('Before restart title'); await editor().getByRole('button', { name: 'Save', exact: true }).click(); await entered('old-host-rename');
  const restarted = await page.evaluate(async () => { const h = await window.medclaw.request('host.read', {}); if (!h.ok || !h.data.instanceId) throw new Error('Missing Host'); return window.medclaw.request('host.restart', { expectedInstanceId: h.data.instanceId }); }); expect(restarted.ok).toBe(true);
  await release('old-host-rename'); await expect(editor().getByRole('button', { name: 'Read original rename', exact: true })).toBeVisible(); await editor().getByRole('button', { name: 'Keep for later', exact: true }).click();
  await expect(row(b).getByRole('button', { name: (await session(b)).title, exact: true })).toBeEnabled(); await select(b);
  const newer = await page.evaluate(async sessionId => { const current = await window.medclaw.request('session.read', { sessionId }); if (!current.ok || !current.data) throw new Error('Missing target'); return window.medclaw.request('session.rename', { sessionId, title: 'After restart current title', expectedMetadataRevision: current.data.session.metadataRevision }); }, a); expect(newer.ok).toBe(true);
  await page.getByRole('button', { name: 'Read original rename', exact: true }).click(); await expect(row(a).getByRole('button', { name: 'After restart current title', exact: true })).toBeVisible(); await expect(composer()).toHaveValue('B draft across restart'); expect((await workspace()).sessionId).toBe(b);
  save('old-host-management', { a, b, current: await session(a), workspace: await workspace() });
});

test('an old Host delete receipt cannot release a newer Host unknown selection gate', async () => {
  const b = await create(); await composer().fill('B draft across independent gates'); const c = await create(); const a = await create();
  await rules([{ method: 'session.delete', sessionId: a, unknown: true }]); await action(a, 'Delete'); await editor().getByRole('button', { name: 'Delete session', exact: true }).click();
  await expect(editor().getByRole('button', { name: 'Read original delete', exact: true })).toBeVisible(); await editor().getByRole('button', { name: 'Keep for later', exact: true }).click();
  const original = (await calls()).filter(call => call.method === 'session.delete' && call.payload.sessionId === a).at(-1)!;
  const restart = () => page.evaluate(async () => { const h = await window.medclaw.request('host.read', {}); if (!h.ok || !h.data.instanceId) throw new Error('Missing Host'); return window.medclaw.request('host.restart', { expectedInstanceId: h.data.instanceId }); });
  expect((await restart()).ok).toBe(true); await expect(row(b).locator('button[aria-pressed]')).toBeEnabled(); await select(b); await expect(composer()).toHaveValue('B draft across independent gates');
  await rules([{ method: 'session.select', sessionId: c, defer: true, hold: 'h2-late-select' }]); await row(c).locator('button[aria-pressed]').click(); await entered('h2-late-select'); await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeDisabled();
  const pendingSelect = (await calls()).filter(call => call.method === 'session.select' && call.payload.sessionId === c).at(-1)!;
  await page.getByRole('button', { name: 'Read original delete', exact: true }).click(); await expect(page.getByRole('button', { name: 'Read original delete', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeDisabled(); await expect(row(c).locator('button[aria-pressed]')).toBeDisabled(); await expect(composer()).toHaveValue('B draft across independent gates'); expect((await workspace()).sessionId).toBe(b);
  await release('h2-late-select'); await expect.poll(async () => (await workspace()).sessionId).toBe(c); await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeDisabled();
  expect((await restart()).ok).toBe(true); await expect(row(b).locator('button[aria-pressed]')).toBeEnabled(); await select(b); await expect(composer()).toHaveValue('B draft across independent gates');
  expect((await calls()).filter(call => call.method === 'session.delete' && call.operationRef === original.operationRef)).toHaveLength(1); expect((await calls()).filter(call => call.method === 'session.select' && call.operationRef === pendingSelect.operationRef)).toHaveLength(1);
  save('independent-host-gates', { a, b, c, original, pendingSelect, workspace: await workspace() });
});

test('a positive delete waits for the current Workspace read and a failed read keeps writes closed', async () => {
  const b = await create(); await composer().fill('B survives failed fresh Workspace'); const a = await create(); await composer().fill('A deleted only after receipt');
  await rules([{ method: 'workspace.read', hold: 'delete-fresh-workspace', project: { ok: false, error: safeError('storage_read_failed') } }]); await action(a, 'Delete'); await editor().getByRole('button', { name: 'Delete session', exact: true }).click(); await entered('delete-fresh-workspace');
  await expect(row(a)).toHaveCount(0); await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeDisabled(); await expect(row(b).locator('button[aria-pressed]')).toBeDisabled();
  await release('delete-fresh-workspace'); await expect(editor()).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Create a session', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click(); await page.getByRole('button', { name: 'Verify saved selection', exact: true }).click(); await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled();
  await select(b); await expect(composer()).toHaveValue('B survives failed fresh Workspace'); save('positive-delete-fresh-read-failure', { a, b, workspace: await workspace(), deleted: await session(a) });
});

test('historical positive and null management lookups cannot waive a newer explicit Workspace verification', async () => {
  const b = await create(); await composer().fill('B retains its read failure draft');
  for (const committed of [true, false]) {
    const a = await create(); await composer().fill('A preserved until its original result'); await action(a, 'Delete');
    if (!committed) {
      const renamed = await page.evaluate(async sessionId => { const s = await window.medclaw.request('session.read', { sessionId }); if (!s.ok || !s.data) throw new Error('Missing target'); return window.medclaw.request('session.rename', { sessionId, title: 'Invalidate original delete metadata', expectedMetadataRevision: s.data.session.metadataRevision }); }, a); expect(renamed.ok).toBe(true);
    }
    await rules([{ method: 'session.delete', sessionId: a, unknown: true }]); await editor().getByRole('button', { name: 'Delete session', exact: true }).click(); await expect(editor().getByRole('button', { name: 'Read original delete', exact: true })).toBeVisible(); await editor().getByRole('button', { name: 'Keep for later', exact: true }).click();
    const original = (await calls()).filter(call => call.method === 'session.delete' && call.payload.sessionId === a).at(-1)!;
    const restarted = await page.evaluate(async () => { const h = await window.medclaw.request('host.read', {}); if (!h.ok || !h.data.instanceId) throw new Error('Missing Host'); return window.medclaw.request('host.restart', { expectedInstanceId: h.data.instanceId }); }); expect(restarted.ok).toBe(true); await expect(row(b).locator('button[aria-pressed]')).toBeEnabled(); await select(b);
    await rules([{ method: 'workspace.read', project: { ok: false, error: safeError('storage_read_failed') } }]);
    const ui = await page.evaluate(async () => { const before = await window.medclaw.request('settings.ui.read', {}); if (!before.ok) throw new Error('Missing settings'); return window.medclaw.request('settings.ui.update', { expectedConfigVersion: before.data.configVersion, patch: { detailOpen: before.data.ui.detailOpen } }); }); expect(ui.ok).toBe(true);
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeDisabled(); await page.getByRole('button', { name: 'Read original delete', exact: true }).click();
    if (!committed) { await expect(editor()).toBeVisible(); await expect(editor().getByRole('alert')).toContainText('not found after Host restart'); await editor().getByRole('button', { name: 'Cancel', exact: true }).click(); }
    else await expect(page.getByRole('button', { name: 'Read original delete', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeDisabled(); await expect(composer()).toHaveValue('B retains its read failure draft');
    await page.getByRole('button', { name: 'Data Workspace', exact: true }).click(); await page.getByRole('button', { name: 'Verify saved selection', exact: true }).click(); await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Chat', exact: true }).click();
    expect((await calls()).filter(call => call.method === 'session.delete' && call.operationRef === original.operationRef)).toHaveLength(1); save(`historical-${committed ? 'positive' : 'null'}-lookup-read-failure`, { a, b, original, workspace: await workspace(), current: await session(a) });
  }
});

test('deleting the current query owner clears query and selection while retaining selected batches, devices and history', async () => {
  const b = await create(); await composer().fill('B survives query owner deletion'); const a = await create();
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Choose snapshot directory', exact: true }).click(); await expect(page.getByTestId('import-state')).toHaveText('ready');
  await page.getByRole('button', { name: 'Confirm import', exact: true }).click(); await expect(page.getByTestId('import-state')).toHaveText('imported');
  await page.getByRole('button', { name: 'Select batches on this page', exact: true }).click(); await page.getByRole('button', { name: 'Apply 2 selected batches', exact: true }).click();
  const devices = sql('SELECT id FROM devices ORDER BY id') as { id: number }[];
  await page.locator('.page-content:not([hidden])').getByLabel('Selected device IDs', { exact: true }).fill(String(devices[0]!.id)); await page.locator('.page-content:not([hidden])').getByRole('button', { name: 'Apply devices', exact: true }).click();
  await expect.poll(async () => (await workspace()).deviceIds).toEqual([devices[0]!.id]);
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); queryFlow = true; const beforePhysical = physicalCalls;
  await composer().fill('Save actual lifecycle query'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => queryId).toBeGreaterThan(0); await idle();
  expect(physicalCalls).toBe(beforePhysical + 3); const runId = sql(`SELECT run_id FROM queries WHERE id=${queryId}`)[0].run_id;
  const clientSequence = (await calls()).filter(call => call.method === 'session.submit' && call.payload.sessionId === a).at(-1)!.payload.clientSequence as number;
  await composer().fill('A query owner draft'); await page.getByRole('button', { name: 'Query History', exact: true }).click(); await page.getByRole('button', { name: `Read Query ${queryId} from Run ${runId}`, exact: true }).click(); await expect(page.getByTestId('query-results')).toBeVisible();
  await page.getByRole('button', { name: `Use Query ${queryId} for next message`, exact: true }).click();
  const savedQuery = await page.evaluate(queryId => window.medclaw.request('query.read', { queryId }), queryId); if (!savedQuery.ok) throw new Error(savedQuery.error.code);
  await page.getByRole('button', { name: `Select Query ${queryId} ${savedQuery.data.page.rowKeys[0]} field deltaCents`, exact: true }).click(); await expect.poll(async () => (await workspace()).selection?.field).toBe('deltaCents');
  const before = await workspace(), history = sql(`SELECT (SELECT COUNT(*) FROM runs WHERE session_id=${a}) AS runs,(SELECT COUNT(*) FROM session_inputs WHERE session_id=${a}) AS inputs,(SELECT COUNT(*) FROM queries WHERE session_id=${a}) AS queries,(SELECT COUNT(*) FROM runtime_events WHERE run_id=${runId}) AS events`), physical = physicalCalls;
  expect(before.sessionId).toBe(a); expect(before.queryId).toBe(queryId); expect(before.activeView).toBe('query'); expect(before.selection?.kind).toBe('query-row');
  await remove(a); await page.getByRole('button', { name: 'Chat', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Create a session', exact: true })).toBeVisible();
  const after = await workspace(); expect(after).toEqual({ ...before, revision: before.revision + 1, sessionId: null, queryId: null, selection: null, activeView: 'data' });
  expect(sql(`SELECT (SELECT COUNT(*) FROM runs WHERE session_id=${a}) AS runs,(SELECT COUNT(*) FROM session_inputs WHERE session_id=${a}) AS inputs,(SELECT COUNT(*) FROM queries WHERE session_id=${a}) AS queries,(SELECT COUNT(*) FROM runtime_events WHERE run_id=${runId}) AS events`)).toEqual(history);
  const reads = await page.evaluate(async ({ sessionId, queryId, runId, evidenceId, clientSequence }) => {
    const submission = await window.medclaw.request('session.readSubmission', { sessionId, clientSequence });
    if (!submission.ok || !submission.data?.inputId) throw new Error('Original Input receipt is unavailable');
    return { session: await window.medclaw.request('session.read', { sessionId }), input: await window.medclaw.request('session.readInput', { inputId: submission.data.inputId }), submission, run: await window.medclaw.request('run.read', { runId }), query: await window.medclaw.request('query.read', { queryId }), evidence: await window.medclaw.request('evidence.read', { queryId, evidenceId }), events: await window.medclaw.request('event.read', { runId, afterSequence: 0, limit: 100 }) };
  }, { sessionId: a, queryId, runId, evidenceId: savedQuery.data.page.evidenceIds[0]!, clientSequence });
  expect(reads.session.ok && reads.session.data?.session.status).toBe('deleted'); for (const [kind, value] of Object.entries(reads)) expect(value.ok, `${kind} remains readable`).toBe(true);
  expect(reads.submission.ok && reads.submission.data?.runId).toBe(runId); expect(reads.query.ok && reads.query.data.query.id).toBe(queryId); expect(reads.events.ok && reads.events.data.events.length).toBeGreaterThan(0); expect(physicalCalls).toBe(physical); await expect(row(a)).toHaveCount(0);
  await select(b); await expect(composer()).toHaveValue('B survives query owner deletion'); save('current-query-owner-delete', { a, b, before, after, history, reads, physical });
});

test('SQL pagination and deleting the last visible Session preserve history without automatic creation', async () => {
  test.setTimeout(60000);
  const existing = sql('SELECT id FROM sessions WHERE status=\'active\' ORDER BY id') as { id: number }[];
  for (const { id } of existing) { const deleted = await page.evaluate(async sessionId => { const [detail, w] = await Promise.all([window.medclaw.request('session.read', { sessionId }), window.medclaw.request('workspace.read', {})]); if (!detail.ok || !detail.data || !w.ok) throw new Error('Missing target'); return window.medclaw.request('session.delete', { sessionId, expectedMetadataRevision: detail.data.session.metadataRevision, expectedWorkspaceRevision: w.data.revision }); }, id); expect(deleted.ok).toBe(true); }
  const ids = await page.evaluate(async () => { const ids: number[] = []; for (let index = 0; index < 24; index++) { const w = await window.medclaw.request('workspace.read', {}); if (!w.ok) throw new Error('Missing workspace'); const created = await window.medclaw.request('session.create', { expectedWorkspaceRevision: w.data.revision }); if (!created.ok) throw new Error(created.error.code); ids.push(created.data.session.id); } return ids; });
  await page.reload(); await expect(row(ids.at(-1)!)).toBeVisible(); await expect(page.locator('.session-row')).toHaveCount(20); await page.getByRole('button', { name: 'More sessions', exact: true }).click(); await expect(page.locator('.session-row')).toHaveCount(24);
  await remove(ids[4]!); await page.getByRole('button', { name: 'More sessions', exact: true }).click(); await expect(page.locator('.session-row')).toHaveCount(23);
  for (const id of ids.filter(id => id !== ids[4] && id !== ids.at(-1))) await page.evaluate(async sessionId => { const [detail, w] = await Promise.all([window.medclaw.request('session.read', { sessionId }), window.medclaw.request('workspace.read', {})]); if (!detail.ok || !detail.data || !w.ok) throw new Error('Missing target'); const result = await window.medclaw.request('session.delete', { sessionId, expectedMetadataRevision: detail.data.session.metadataRevision, expectedWorkspaceRevision: w.data.revision }); if (!result.ok) throw new Error(result.error.code); }, id);
  await page.reload(); await expect(page.locator('.session-row')).toHaveCount(1); const before = (await calls()).filter(call => call.method === 'session.create').length, count = sql('SELECT COUNT(*) AS n FROM sessions')[0].n;
  await remove(ids.at(-1)!); await expect(page.locator('.session-row')).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Create a session', exact: true })).toBeVisible(); expect((await workspace()).sessionId).toBeNull();
  expect((await calls()).filter(call => call.method === 'session.create')).toHaveLength(before); expect(sql('SELECT COUNT(*) AS n FROM sessions')[0].n).toBe(count); expect(physicalCalls).toBe(4);
  await rules([{ method: 'session.list', project: { ok: false, error: safeError('storage_read_failed') } }]); await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click(); await expect(page.locator('.error-banner')).toBeVisible();
  save('pagination-and-last-delete', { ids, count, workspace: await workspace(), sql: sql('SELECT id,status,metadata_revision,deleted_at FROM sessions ORDER BY id') });
});

test('a fresh default title reuses the smallest free display number while deleted identities remain distinct', async () => {
  const before = sql('SELECT MAX(id) AS id,COUNT(*) AS n FROM sessions')[0], physical = physicalCalls;
  await expect(page.locator('.session-row')).toHaveCount(0);
  const first = await create(); expect(first).toBe(before.id + 1); expect((await session(first)).title).toBe('New Session 1');
  await composer().fill('First fresh Session draft'); const second = await create(); expect(second).toBe(first + 1); expect((await session(second)).title).toBe('New Session 2');
  await composer().fill('Second fresh Session draft'); await remove(first); await expect(composer()).toHaveValue('Second fresh Session draft');
  const third = await create(); expect(third).toBe(second + 1); expect((await session(third)).title).toBe('New Session 1');
  await expect(row(third).locator('button[aria-pressed]')).toHaveText('New Session 1'); await expect(row(first)).toHaveCount(0);
  expect((await session(first)).status).toBe('deleted'); expect((await session(first)).title).toBe('New Session 1');
  await rename(third, '用户会话'); const fourth = await create(); expect(fourth).toBe(third + 1); expect((await session(fourth)).title).toBe('New Session 1');
  expect((await session(third)).title).toBe('用户会话'); expect(sql('SELECT COUNT(*) AS n FROM sessions')[0].n).toBe(before.n + 4); expect(physicalCalls).toBe(physical);
  save('default-number-vs-identity', { before, first, second, third, fourth, sessions: await Promise.all([session(first), session(second), session(third), session(fourth)]), sql: sql(`SELECT id,title,status,metadata_revision FROM sessions WHERE id>=${first} ORDER BY id`), physical });
});
