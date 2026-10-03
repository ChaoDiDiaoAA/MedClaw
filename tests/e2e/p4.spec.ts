import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { SessionMessagePage, SessionMessageView } from '../../packages/contracts/src/messages';
import { canonicalRequest } from '../../packages/contracts/src/run';
import type { SubmitResult } from '../../packages/contracts/src/session';
import { safeError } from '../../packages/contracts/src/error';

const root = resolve(import.meta.dirname, '../..'), bun = process.env.MEDCLAW_BUN_EXECUTABLE ?? 'bun';
let app: ElectronApplication, page: Page, temporary: string, server: Server, httpCount = 0;
test.describe.configure({ mode: 'serial' });
type Rule = { method?: string; sessionId?: number; runId?: number; page?: number; leafId?: string | null; hold?: string; project?: unknown };
type Gate = { rules: Rule[]; entered: string[]; pending: Record<string, () => void>; calls: { method: string; sessionId?: number; runId?: number; page?: number; pageSize?: number; leafId?: string | null; afterEntryId?: string | null; clientSequence?: number; operationRef?: string }[]; toolProjection: string | null; accepted: (SubmitResult & { operationRef: string; batchIds: number[]; referenceDate: string; timezone: string })[] };
type MainGlobal = typeof globalThis & { __p4Gate: Gate };
const entry = (id: string, text: string, extra: Partial<SessionMessageView> = {}): SessionMessageView => ({ nativeEntryId: id, parentEntryId: null, entryType: 'message', displayRole: 'assistant', text, references: [], inputId: null, runId: null, toolCallRef: null, textInfo: { totalChars: text.length, truncated: false, redacted: false }, ...extra });
const projection = (sessionId: number, nativeSessionId: string, leafId: string, items: SessionMessageView[], cursor: string | null = null): { ok: true; data: SessionMessagePage } => ({ ok: true, data: { sessionId, nativeSessionId, leafId, source: 'native_memory', items, nextEntryId: cursor, hasMore: cursor !== null } });
const region = () => page.getByTestId('chat-native-messages');
const input = () => page.getByLabel('Message text', { exact: true });
async function rules(values: Rule[]) { await app.evaluate((_, values) => { (globalThis as MainGlobal).__p4Gate.rules.push(...values); }, values); }
async function entered(id: string) { await expect.poll(() => app.evaluate((_, id) => (globalThis as MainGlobal).__p4Gate.entered.includes(id), id)).toBe(true); }
async function release(id: string) { await app.evaluate((_, id) => { (globalThis as MainGlobal).__p4Gate.pending[id]?.(); }, id); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function calls() { return app.evaluate(() => (globalThis as MainGlobal).__p4Gate.calls); }
async function create() { await page.getByRole('button', { name: 'New Session', exact: true }).click(); const w = await page.evaluate(() => window.medclaw.request('workspace.read', {})); if (!w.ok || !w.data.sessionId) throw new Error('No selected session'); await expect(page.getByTestId('current-session')).toContainText(`New Session ${w.data.sessionId}`); const s = await page.evaluate(id => window.medclaw.request('session.read', { sessionId: id }), w.data.sessionId); if (!s.ok || !s.data) throw new Error('No session'); return s.data.session; }
async function select(id: number) { await page.getByRole('button', { name: `New Session ${id}`, exact: true }).click(); await expect(page.getByTestId('current-session')).toContainText(`New Session ${id}`); }
async function refresh() { await region().getByRole('button', { name: 'Refresh messages', exact: true }).click(); }

// T06 scripts observe the actual loopback wire. Raw requests are never persisted.
type WireMessage = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
type Wire = { model: string; messages: WireMessage[] };
type Reply = { text: string } | { id: string; name: string; args: unknown };
let script: ((wire: Wire) => Promise<Reply> | Reply)[] | null = null, scriptIndex = 0, inFlight = 0;
const scriptErrors: string[] = [], wireFacts: { ordinal: number; toolIds: string[]; userCount: number }[] = [];
const httpReleases: (() => void)[] = [];
const evidenceDirectory = join(root, '.build/p4-messages/final-fix-e2e');
function arm(steps: NonNullable<typeof script>) { expect(inFlight).toBe(0); script = steps; scriptIndex = 0; scriptErrors.length = 0; wireFacts.length = 0; }
function gate() { let enter!: () => void, release!: () => void; const value = { entered: new Promise<void>(resolve => { enter = resolve; }), response: new Promise<void>(resolve => { release = resolve; }), enter: () => enter(), release: () => release() }; httpReleases.push(value.release); return value; }
function receipt<T>(wire: Wire, id: string): T {
  const original = wire.messages.flatMap(message => message.tool_calls ?? []).filter(call => call.id === id);
  const returned = wire.messages.filter(message => message.role === 'tool' && message.tool_call_id === id);
  expect(original).toHaveLength(1); expect(returned).toHaveLength(1);
  return JSON.parse(typeof returned[0]!.content === 'string' ? returned[0]!.content : JSON.stringify(returned[0]!.content)) as T;
}
type ScopeReceipt = { scope: { batchIds: number[]; deviceIds: number[] | null }; referenceDate: string; timezone: string };
type QueryReceipt = { queryId: number; totalRows: number; rows: { deviceId: number; deltaCents: number; ratio: number; deviceName: string }[]; evidenceIds: number[] };
async function accepted() { return app.evaluate(() => (globalThis as MainGlobal).__p4Gate.accepted); }
async function readRun(runId: number) { const result = await page.evaluate(runId => window.medclaw.request('run.read', { runId, callLimit: 50 }), runId); if (!result.ok || result.data.kind !== 'one' || !result.data.run) throw new Error('Missing original Run'); return result.data.run; }
async function messages(sessionId: number, leafId: string | null = null, limit = 100, afterEntryId: string | null = null) {
  const result = await page.evaluate(input => window.medclaw.request('session.messages.read', input), { sessionId, leafId, afterEntryId, limit });
  if (!result.ok) throw new Error(result.error.code); return result.data;
}
async function idle() { await expect.poll(async () => { const control = await page.evaluate(() => window.medclaw.request('run.control.read', {})); return control.ok && control.data.acceptingNewRuns && !control.data.activeRootRun && inFlight === 0; }).toBe(true); }
async function reference() { if (!await page.locator('.reference-fields').evaluate(element => (element as HTMLDetailsElement).open)) await page.locator('.reference-fields summary').click(); await page.getByLabel('Reference date', { exact: true }).fill('2026-01-02'); await page.getByLabel('Time zone', { exact: true }).fill('Asia/Shanghai'); }
async function send(text: string) {
  await idle(); await reference(); const before = (await accepted()).length;
  const workspace = await page.evaluate(() => window.medclaw.request('workspace.read', {})); if (!workspace.ok) throw new Error('No Workspace');
  await input().fill(text); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await accepted()).length).toBe(before + 1);
  const origin = (await accepted())[before]!; expect(origin.sessionId).toBe(workspace.data.sessionId); expect(origin.batchIds).toEqual(workspace.data.batchRefs.map(batch => batch.id));
  await idle(); const run = await readRun(origin.runId);
  expect(run).toMatchObject({ kind: 'agent', sessionId: origin.sessionId, clientSequence: origin.clientSequence, status: 'completed', persistence: 'committed', referenceDate: origin.referenceDate, timezone: origin.timezone }); expect(run.answerRef).not.toBeNull();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible(); return { origin, run };
}
function saveEvidence(name: string, value: unknown) { mkdirSync(evidenceDirectory, { recursive: true }); writeFileSync(join(evidenceDirectory, name + '.json'), JSON.stringify(value, null, 2)); }
async function shot(name: string) { mkdirSync(evidenceDirectory, { recursive: true }); await page.screenshot({ path: join(evidenceDirectory, name + '.png'), fullPage: true }); }
async function messageShots(name: string, native: SessionMessagePage) {
  if (await page.locator('.reference-fields').evaluate(element => (element as HTMLDetailsElement).open)) await page.locator('.reference-fields summary').click();
  await refresh();
  for (const [index, item] of native.items.filter(item => item.displayRole === 'user' || item.displayRole === 'assistant').entries()) {
    const article = region().locator(`[data-native-entry-id="${item.nativeEntryId}"]`); await expect(article).toBeVisible();
    await article.locator('.answer-text').evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))); await shot(`${name}-message-${index + 1}`);
  }
}
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
  temporary = mkdtempSync(join(tmpdir(), 'medclaw-p4-t06-')); snapshotPackage(join(temporary, 'source')); snapshotPackage(join(evidenceDirectory, 'finished-package'));
  server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); httpCount++;
    if (script) {
      inFlight++; const ordinal = ++scriptIndex;
      wireFacts.push({ ordinal, toolIds: payload.messages.filter((m: WireMessage) => m.role === 'tool').map((m: WireMessage) => m.tool_call_id!), userCount: payload.messages.filter((m: WireMessage) => m.role === 'user').length });
      try {
        const step = script[ordinal - 1]; if (!step) throw new Error(`Unexpected scripted HTTP ${ordinal}`);
        const reply = await step(payload);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = 'text' in reply ? { role: 'assistant', content: reply.text } : { role: 'assistant', tool_calls: [{ index: 0, id: reply.id, type: 'function', function: { name: reply.name, arguments: JSON.stringify(reply.args) } }] };
        for (const [value, finish] of [[delta, null], [{}, 'text' in reply ? 'stop' : 'tool_calls']]) response.write(`data: ${JSON.stringify({ id: 'p4-t06-response', model: payload.model, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } catch (error) { scriptErrors.push(String(error)); response.writeHead(500); response.end('controlled fixture assertion failed'); }
      finally { inFlight--; }
      return;
    }
    const last = JSON.stringify(payload.messages.filter((message: { role: string }) => message.role === 'user').at(-1)?.content ?? '');
    const hasTool = payload.messages.some((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'p4-scope');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const tool = last.includes('slow A') && !hasTool;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'p4-scope', type: 'function', function: { name: 'read_data_scope', arguments: '{}' } }] } : { role: 'assistant', content: 'P4 temporary reply' };
    const send = (delta: unknown, finish: string | null) => response.write(`data: ${JSON.stringify({ id: 'p4-response', model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send(delta, null);
    const complete = () => { send(tool ? {} : { content: ' saved' }, tool ? 'tool_calls' : 'stop'); response.end('data: [DONE]\n\n'); };
    if (last.includes('slow A') && hasTool) { const timer = setTimeout(complete, 30000); response.on('close', () => clearTimeout(timer)); } else complete();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const seam = join(temporary, 'public-gates.cjs');
  writeFileSync(seam, `const {ipcMain}=require('electron'); const original=ipcMain.handle.bind(ipcMain);
    const state=globalThis.__p4Gate={rules:[],entered:[],pending:{},calls:[],toolProjection:null,accepted:[]};
    ipcMain.handle=(channel,listener)=>original(channel,async(event,envelope)=>{
      if(channel!=='medclaw:request')return listener(event,envelope);
      const p=envelope.payload; state.calls.push({method:envelope.method,sessionId:p.sessionId,runId:p.runId,page:p.page,pageSize:p.pageSize,leafId:p.leafId,afterEntryId:p.afterEntryId,clientSequence:p.clientSequence,...(envelope.method==='session.submit'?{operationRef:envelope.operationRef}:{})});
      const index=state.rules.findIndex(r=>(!r.method||r.method===envelope.method)&&(r.sessionId===undefined||r.sessionId===p.sessionId)&&(r.runId===undefined||r.runId===p.runId)&&(r.page===undefined||r.page===p.page)&&(!Object.hasOwn(r,'leafId')||r.leafId===p.leafId));
      const rule=index<0?null:state.rules.splice(index,1)[0]; let result=await listener(event,envelope);
      if(envelope.method==='session.submit'&&result.ok)state.accepted.push({...result.data,operationRef:envelope.operationRef,batchIds:p.expectedBatchIds,referenceDate:p.referenceDate,timezone:p.timezone});
      if(rule?.project)result=rule.project;
      if(envelope.method==='tool.read'&&result.ok&&state.toolProjection) result={...result,data:{...result.data,items:result.data.items.map(c=>({...c,name:'bash',version:'INTERNAL-WRAPPER-VERSION',sdkReturned:state.toolProjection!=='unconfirmed',sdkResultIsError:false,nativeOutputTruncated:state.toolProjection==='truncated'?true:state.toolProjection==='verified'?false:undefined,nextModelCallId:'old-call',consumedAt:'old-time',consumptionEvidence:state.toolProjection==='verified'?'provider_input_verified':undefined,truncated:true}))}};
      if(rule?.hold){state.entered.push(rule.hold);await new Promise(resolve=>state.pending[rule.hold]=resolve);delete state.pending[rule.hold];}
      return result;
    });`);
  const hostEntry = join(temporary, 't06-host.ts');
  const sdkEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
  // Isolated prototype observers preserve real Host and public SDK behavior. No production toggle.
  writeFileSync(hostEntry, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    import {SqliteToolStore} from ${JSON.stringify(join(root, 'packages/storage/src/tool-store.ts'))};
    import {QueryService} from ${JSON.stringify(join(root, 'packages/core/src/data/query-service.ts'))};
    import {SessionManager} from ${JSON.stringify(sdkEntry)};
    const control=${JSON.stringify(temporary)}, faultFile=control+'/fault.json', release=control+'/release-fault';
    let executions=0;const changes=QueryService.prototype.changes;
    QueryService.prototype.changes=function(input,context){if(context.nativeToolCallId==='p4-fault-query'){executions++;writeFileSync(control+'/query-executions.json',JSON.stringify({executions}))}return changes.call(this,input,context)};
    const delivery=SqliteToolStore.prototype.recordDelivery;
    SqliteToolStore.prototype.recordDelivery=function(context,entry,message){
      if(context.nativeToolCallId==='p4-fault-query'&&!existsSync(release)){
        const call=this.readCall(context),query=this.readQuery(call?.data?.queryId);
        if(call?.name!=='query_device_changes'||call.status!=='succeeded'||!query||query.runId!==context.runId||query.sessionId!==context.sessionId||query.callRef!==context.runId+':'+context.nativeToolCallId)throw Error('fixture_identity_invalid');
        writeFileSync(faultFile,JSON.stringify({runId:context.runId,sessionId:context.sessionId,toolId:call.id,queryId:query.id,resultHash:query.resultHash,nativeEntryId:entry,toolCallId:message.toolCallId,isError:message.isError,executions}));throw Error('storage_write_failed');
      }return delivery.call(this,context,entry,message);
    };
    const factory=SessionManager.inMemory;
    SessionManager.inMemory=function(...args){const manager=factory.apply(this,args);if(existsSync(control+'/seed-structure')){
      const secret='STRUCTURE-CANARY';manager.appendMessage({role:'user',content:[{type:'text',text:'ordinary seeded user',textSignature:secret},{type:'image',data:secret,mimeType:'image/png'}],timestamp:1});
      manager.appendMessage({role:'assistant',content:[{type:'text',text:'x'.repeat(8191)+'😀'+'\\u0000',textSignature:secret},{type:'thinking',thinking:secret,thinkingSignature:secret},{type:'toolCall',id:'seeded-read',name:'read',arguments:{path:secret},thoughtSignature:secret}],api:'openai-completions',provider:'seeded',model:'seeded',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:2});
      manager.appendMessage({role:'toolResult',toolName:'read',toolCallId:'seeded-read',content:[{type:'text',text:secret}],details:{path:secret,command:secret,file:secret,unknown:secret},isError:false,timestamp:3});
      manager.appendCustomEntry(secret,{private:secret});manager.appendCustomMessageEntry(secret,secret,true,{details:secret});
      const original=JSON.stringify(manager.getEntries());const read=manager.getEntries.bind(manager);manager.getEntries=()=>{const entries=read();writeFileSync(control+'/seed-observed.json',JSON.stringify({nativeSessionId:manager.getSessionId(),unchanged:JSON.stringify(entries)===original}));return entries};
    }return manager};
    await import(${JSON.stringify(join(root, 'apps/host/src/main.ts'))});`);
  writeFileSync(join(evidenceDirectory, 'host-entry.ts'), readFileSync(hostEntry));
  const require = createRequire(join(root, 'apps/desktop/package.json')), electronPath: string = require('electron');
  const playwright = createRequire(createRequire(import.meta.url).resolve('@playwright/test/package.json')), core = createRequire(playwright.resolve('playwright/package.json')).resolve('playwright-core/package.json');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])), MEDCLAW_HOST_ENTRY: hostEntry, MEDCLAW_BUN_EXECUTABLE: execFileSync(bun, ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).trim() };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: electronPath, args: ['-r', join(dirname(core), 'lib/server/electron/loader.js'), '-r', seam, join(root, '.build/desktop/main/index.cjs'), '--medclaw-data-root', join(temporary, 'data')], env, timeout: 30000 });
  page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 }); await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, join(temporary, 'source'));
  const configured = await page.evaluate(async baseUrl => {
    const directory = await window.medclaw.request('model.read', {}); if (!directory.ok) throw new Error(directory.error.code);
    const token = await window.medclaw.secretInput({ providerId: 'p4-t04', purpose: 'custom_api_key', value: 'P4-LOCAL-NONSECRET-FIXTURE' }); if (!token.ok) throw new Error(token.error.code);
    const saved = await window.medclaw.request('model.custom.save', { expectedConfigVersion: directory.data.configVersion, credentialInput: token.data.token, definition: { providerId: 'p4-t04', name: 'P4 local fixture', api: 'openai-completions', baseUrl, models: [{ id: 'fixture', name: 'P4 fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] } }); if (!saved.ok) throw new Error(saved.error.code);
    return window.medclaw.request('model.configure', { provider: 'p4-t04', modelId: 'fixture', expectedConfigVersion: saved.data.configVersion });
  }, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`); expect(configured.ok).toBe(true);
});
test.afterAll(async () => {
  httpReleases.forEach(release => release());
  await app?.evaluate(() => Object.values((globalThis as MainGlobal).__p4Gate.pending).forEach(release => release())).catch(() => {});
  await app?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (temporary) { const path = resolve(temporary), inside = relative(resolve(tmpdir()), path); if (inside && !inside.startsWith('..') && !inside.includes(':')) rmSync(path, { recursive: true, force: true }); }
});

test.afterEach(async ({}, info) => { if (info.status !== info.expectedStatus) { await shot('failed-' + info.title.replaceAll(/[^a-zA-Z0-9]+/g, '-')).catch(() => {}); saveEvidence('failed-script-' + info.title.replaceAll(/[^a-zA-Z0-9]+/g, '-'), { scriptIndex, scriptErrors, httpCount, inFlight, wireFacts }); } await app?.evaluate(() => { (globalThis as MainGlobal).__p4Gate.toolProjection = null; }).catch(() => {}); });

test('RunDetails rejects held historical and output replies across A2 to B to A2', async () => {
  const a = await create();
  arm([() => ({ text: 'FINAL-FIX-A1' }), () => ({ text: 'FINAL-FIX-A2-FIRST-' + 'x'.repeat(16400) + '-A2-TAIL' }), () => ({ text: 'FINAL-FIX-B' })]);
  const a1 = await send('FINAL-FIX-A1-INPUT'), a2 = await send('FINAL-FIX-A2-INPUT');
  const b = await create(); await send('FINAL-FIX-B-INPUT'); await select(a.id);
  await showRun(a2.run.id); const details = page.getByRole('complementary', { name: 'Run details', exact: true });
  await expect(details.locator('.detail-run')).toContainText(`Run ${a2.run.id}`);
  await rules([{ method: 'run.read', runId: a1.run.id, hold: 'final-fix-A1' }]);
  await details.getByRole('button', { name: `View Run ${a1.run.id}`, exact: true }).click(); await entered('final-fix-A1');
  await select(b.id); await select(a.id); await expect(details.locator('.detail-run')).toContainText(`Run ${a2.run.id}`);
  await release('final-fix-A1'); await expect(details.locator('.detail-run')).toContainText(`Run ${a2.run.id}`);
  await expect(page.getByTestId('saved-output')).toHaveText(a2.run.output.text);
  await rules([{ method: 'run.read', runId: a2.run.id, hold: 'final-fix-output' }]);
  await details.getByRole('button', { name: 'Read next output section', exact: true }).click(); await entered('final-fix-output');
  await select(b.id); await select(a.id); await expect(page.getByTestId('saved-output')).toHaveText(a2.run.output.text);
  await release('final-fix-output'); await expect(page.getByTestId('saved-output')).toHaveText(a2.run.output.text);
  await details.getByRole('button', { name: 'Read next output section', exact: true }).click();
  await expect(page.getByTestId('saved-output')).toHaveText(('FINAL-FIX-A2-FIRST-' + 'x'.repeat(16400) + '-A2-TAIL').slice(a2.run.output.nextOffset!));
  await details.getByRole('button', { name: 'Back to first section', exact: true }).click(); await expect(page.getByTestId('saved-output')).toHaveText(a2.run.output.text);
  await rules([{ method: 'run.read', runId: a1.run.id, hold: 'final-fix-error', project: { ok: false, error: safeError('storage_read_failed') } }]);
  await details.getByRole('button', { name: `View Run ${a1.run.id}`, exact: true }).click(); await entered('final-fix-error');
  await select(b.id); await select(a.id);
  await rules([{ method: 'run.read', runId: a2.run.id, hold: 'final-fix-current-loading' }]);
  await details.getByRole('button', { name: 'Read this run again', exact: true }).click(); await entered('final-fix-current-loading');
  await release('final-fix-error'); await expect(details.getByRole('alert')).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'Read this run again', exact: true })).toBeDisabled();
  await release('final-fix-current-loading'); await expect(details.getByRole('button', { name: 'Read this run again', exact: true })).toBeEnabled();
  await expect(details.locator('.detail-run')).toContainText(`Run ${a2.run.id}`);
  await page.getByRole('button', { name: 'Close run details', exact: true }).click();
  saveEvidence('final-fix-run-details-ownership', { aSessionId: a.id, bSessionId: b.id, a1: a1.origin, a2: a2.origin, heldHistoricalRunId: a1.run.id, selectedRunAfterReturn: a2.run.id, outputFirstOffset: a2.run.output.offset, outputNextOffset: a2.run.output.nextOffset, rejected: ['historical reply', 'output page', 'old error'], currentLoadingPreserved: true }); script = null;
});

test('healthy native exchange appears once and partial history never claims final answer coverage', async () => {
  const a = await create(); arm([() => ({ text: 'FINAL-FIX-ONCE-ANSWER' })]);
  const completed = await send('FINAL-FIX-ONCE-INPUT'); await refresh(); const native = await messages(a.id);
  const user = native.items.find(item => item.displayRole === 'user' && item.runId === completed.run.id)!;
  const answer = native.items.find(item => item.displayRole === 'assistant' && item.runId === completed.run.id)!;
  expect(user).toBeDefined(); expect(answer).toBeDefined();
  const transcript = page.locator('.messages');
  await expect(region().locator(`[data-native-entry-id="${user.nativeEntryId}"] .answer-text`)).toHaveText(completed.run.inputText);
  await expect(region().locator(`[data-native-entry-id="${answer.nativeEntryId}"] .answer-text`)).toHaveText('FINAL-FIX-ONCE-ANSWER');
  await expect(transcript.getByText(completed.run.inputText, { exact: true })).toHaveCount(1);
  await expect(transcript.getByText('FINAL-FIX-ONCE-ANSWER', { exact: true })).toHaveCount(1);
  await expect(page.getByTestId('run-output')).toHaveCount(0);
  await rules([{ method: 'session.messages.read', sessionId: a.id, project: { ok: false, error: safeError('storage_read_failed') } }]);
  await refresh(); await expect(region().getByRole('alert')).toContainText('Message history read failed');
  await expect(region().locator(`[data-native-entry-id="${answer.nativeEntryId}"]`)).toBeVisible();
  await expect(transcript).not.toContainText('Saved run output; native history unavailable');
  await expect(page.getByText('Native message history read failed. Refresh messages before sending.', { exact: true })).toBeVisible();
  const leading = entry('final-fix-leading', 'FINAL-FIX-TOOL-LEADING', { runId: completed.run.id, references: [`run:${completed.run.id}`] });
  const partial = projection(a.id, a.nativeSessionId, 'final-fix-paged-leaf', [user, leading], 'final-fix-leading');
  await rules([{ method: 'session.messages.read', sessionId: a.id, project: partial }]); await refresh();
  await expect(region()).toContainText('FINAL-FIX-TOOL-LEADING'); await expect(transcript).toContainText('Native history page incomplete');
  await expect(transcript).toContainText('Read the full saved output in Run details');
  await expect(region().locator(`[data-native-entry-id="${answer.nativeEntryId}"]`)).toHaveCount(0);
  await showRun(completed.run.id); await expect(page.getByTestId('saved-output')).toHaveText('FINAL-FIX-ONCE-ANSWER'); await page.getByRole('button', { name: 'Close run details', exact: true }).click();
  await rules([{ method: 'session.messages.read', sessionId: a.id, leafId: 'final-fix-paged-leaf', project: projection(a.id, a.nativeSessionId, 'final-fix-paged-leaf', [answer]) }]);
  await region().getByRole('button', { name: 'Load more messages', exact: true }).click();
  await expect(region().locator(`[data-native-entry-id="${answer.nativeEntryId}"] .answer-text`)).toHaveText('FINAL-FIX-ONCE-ANSWER');
  await expect(transcript.getByText('FINAL-FIX-ONCE-ANSWER', { exact: true })).toHaveCount(1);
  await expect(transcript).not.toContainText('Native history page incomplete');
  expect((await calls()).filter(call => call.method === 'session.messages.read' && call.leafId === 'final-fix-paged-leaf').at(-1)).toMatchObject({ sessionId: a.id, afterEntryId: leading.nativeEntryId });
  // Explicit absence on a newly owned target has no valid page to preserve.
  const b = await create(); await rules([{ method: 'session.messages.read', sessionId: a.id, project: { ok: false, error: safeError('resource_unavailable') } }]); await select(a.id);
  await expect(transcript).toContainText('Saved run output; native history unavailable'); await expect(page.getByTestId('run-output')).toHaveText('FINAL-FIX-ONCE-ANSWER');
  await expect(region().locator('[data-native-entry-id]')).toHaveCount(0); await refresh();
  await expect(region().locator(`[data-native-entry-id="${answer.nativeEntryId}"]`)).toBeVisible(); await expect(page.getByTestId('run-output')).toHaveCount(0);
  saveEvidence('final-fix-chat-transcript', { original: completed.origin, nativeSessionId: native.nativeSessionId, leafId: native.leafId, originalUserEntryId: user.nativeEntryId, finalAssistantEntryId: answer.nativeEntryId, partialLeaf: partial.data.leafId, leadingEntryId: leading.nativeEntryId, partialHasMore: true, fullSavedOutputInspected: true, readFailureKeptOriginalPage: true, unavailableFallbackTarget: a.id, visitedSession: b.id, finalAnswerCount: 1 }); script = null;
});

// Removing any target/epoch/generation/leaf guard must let a held reply corrupt the visible page.
test('chat message pages reject late session, host and leaf replies', async () => {
  const readHttpBefore = httpCount, a = await create(), b = await create(); await select(a.id); await expect(region()).toContainText('No native messages');
  await rules([{ method: 'session.messages.read', sessionId: a.id, hold: 'old-A', project: projection(a.id, a.nativeSessionId, 'old-A-leaf', [entry('old-A-entry', 'OLD A MUST NOT APPEAR')], 'old-A-cursor') }]);
  await refresh(); await entered('old-A');
  await rules([{ method: 'session.messages.read', sessionId: b.id, project: projection(b.id, b.nativeSessionId, 'B-leaf', [entry('B-entry', 'B current messages')], 'B-cursor') }]);
  await select(b.id); await expect(region()).toContainText('B current messages'); await expect(page.getByRole('heading', { name: 'Start a conversation', exact: true })).toHaveCount(0); await release('old-A');
  await expect(region()).not.toContainText('OLD A'); await expect(region()).toContainText('B-leaf'); await expect(region().getByRole('button', { name: 'Load more messages' })).toBeEnabled();
  await select(a.id); await expect(region()).toContainText('No native messages');
  await rules([{ method: 'session.messages.read', sessionId: a.id, hold: 'A-before-return', project: projection(a.id, a.nativeSessionId, 'retired-A-leaf', [entry('retired-A', 'RETIRED A VIEW')]) }]); await refresh(); await entered('A-before-return');
  await select(b.id); await rules([{ method: 'session.messages.read', sessionId: a.id, project: projection(a.id, a.nativeSessionId, 'returned-A-leaf', [entry('returned-A', 'Current returned A view')]) }]); await select(a.id); await expect(region()).toContainText('Current returned A view'); await release('A-before-return'); await expect(region()).not.toContainText('RETIRED A VIEW');
  await rules([{ method: 'session.messages.read', sessionId: a.id, project: projection(a.id, a.nativeSessionId, 'leaf-one', [entry('one', 'Old captured leaf')], 'cursor-one') }]); await refresh(); await expect(region()).toContainText('Old captured leaf');
  await rules([{ method: 'session.messages.read', sessionId: a.id, leafId: 'leaf-one', hold: 'old-leaf', project: projection(a.id, a.nativeSessionId, 'leaf-one', [entry('old-tail', 'OLD LEAF TAIL')]) }]);
  await region().getByRole('button', { name: 'Load more messages' }).click(); await entered('old-leaf');
  await rules([{ method: 'session.messages.read', sessionId: a.id, leafId: null, project: projection(a.id, a.nativeSessionId, 'leaf-two', [entry('same-1', 'Repeated text'), entry('same-2', 'Repeated text')], 'cursor-two') }]);
  await refresh(); await expect(region().locator('[data-native-entry-id]')).toHaveCount(2); await release('old-leaf'); await expect(region()).not.toContainText('OLD LEAF'); await expect(region()).not.toContainText('Old captured leaf'); await expect(region()).toContainText('leaf-two');
  await rules([{ method: 'session.messages.read', sessionId: a.id, hold: 'old-error', project: { ok: false, error: { code: 'native_state_invalid', category: 'session', message: 'Old error', retryable: false } } }]); await refresh(); await entered('old-error');
  await rules([{ method: 'session.messages.read', sessionId: a.id, hold: 'current-loading', project: projection(a.id, a.nativeSessionId, 'empty-projection', [], 'hidden-cursor') }]); await refresh(); await entered('current-loading'); await release('old-error'); await expect(region().getByRole('status')).toContainText('Reading native messages'); await expect(region().getByRole('alert')).toHaveCount(0); await release('current-loading'); await expect(region()).toContainText('More native entries');
  await rules([{ method: 'session.messages.read', sessionId: a.id, leafId: 'empty-projection', project: projection(a.id, a.nativeSessionId, 'empty-projection', [entry('visible', 'Visible after omitted page')]) }]); await region().getByRole('button', { name: 'Load more messages' }).click(); await expect(region()).toContainText('Visible after omitted page');
  expect((await calls()).filter(call => call.method === 'session.messages.read' && call.leafId === 'empty-projection').at(-1)).toMatchObject({ sessionId: a.id, afterEntryId: 'hidden-cursor' });
  await input().fill('Draft survives failed message read'); await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled(); await rules([{ method: 'session.messages.read', sessionId: a.id, project: { ok: false, error: { code: 'native_state_invalid', category: 'session', message: 'Current failure', retryable: false } } }]); await refresh(); await expect(region().getByRole('alert')).toContainText('Message history read failed'); await expect(region()).toContainText('Visible after omitted page'); await expect(input()).toHaveValue('Draft survives failed message read'); await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled(); await expect(region().getByRole('button', { name: 'Create new session', exact: true })).toBeVisible();
  const detail = await page.evaluate(id => window.medclaw.request('session.read', { sessionId: id }), a.id); if (!detail.ok || !detail.data) throw new Error('Missing metadata');
  const hostBefore = await page.evaluate(() => window.medclaw.request('host.read', {})); if (!hostBefore.ok) throw new Error('Missing host');
  await select(b.id); await rules([{ method: 'session.read', sessionId: a.id, hold: 'old-metadata', project: { ok: true, data: { ...detail.data, session: { ...detail.data.session, nextSubmissionSequence: 99 }, history: { ...detail.data.history, available: false, reason: 'native_state_invalid' } } } }]); await select(a.id); await entered('old-metadata');
  await rules([{ method: 'session.read', sessionId: a.id, hold: 'new-metadata' }]);
  await app.evaluate(({ BrowserWindow }, ids) => BrowserWindow.getAllWindows()[0]!.webContents.send('medclaw:notice', { type: 'agent.settled', instanceId: ids.instanceId, sessionId: ids.sessionId, runId: 999999, noticeSequence: 1, status: 'completed' }), { instanceId: hostBefore.data.instanceId, sessionId: a.id });
  await entered('new-metadata'); await release('new-metadata'); await expect(region()).toContainText('No native messages'); await release('old-metadata'); await expect(page.getByText('This session cannot continue after a restart. Create a new session.', { exact: true })).toHaveCount(0); await expect(input()).toHaveValue('Draft survives failed message read');
  await rules([{ method: 'session.messages.read', sessionId: a.id, hold: 'old-host', project: projection(a.id, a.nativeSessionId, 'HOST OLD', [entry('host-old', 'OLD HOST TEXT')]) }]); await refresh(); await entered('old-host');
  const host = await page.evaluate(() => window.medclaw.request('host.read', {})); if (!host.ok || !host.data.instanceId) throw new Error('No host');
  expect(await page.evaluate(instanceId => window.medclaw.request('host.restart', { expectedInstanceId: instanceId }), host.data.instanceId)).toMatchObject({ ok: true });
  await expect(page.getByText('This session cannot continue after a restart. Create a new session.', { exact: true })).toBeVisible(); await release('old-host'); await expect(region()).not.toContainText('OLD HOST TEXT'); await expect(region()).not.toContainText('HOST OLD'); expect(httpCount).toBe(readHttpBefore);
  expect(await page.evaluate(sessionId => window.medclaw.request('session.messages.read', { sessionId, leafId: null, afterEntryId: null, limit: 50 }), a.id)).toMatchObject({ ok: false, error: { code: 'resource_unavailable' } }); expect(httpCount).toBe(readHttpBefore);
});

// Binding Stop and tool reads to the displayed B instead of the original active A breaks this test.
test('viewing B while A runs preserves B draft and keeps Stop and tool results on A', async () => {
  const a = await create(), b = await create(); await input().fill('B previously saved message'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(page.getByText('Saved', { exact: true })).toBeVisible(); await select(a.id); const before = httpCount;
  await input().fill('slow A tool'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => httpCount).toBe(before + 2); await expect(page.getByTestId('run-output')).toHaveText('P4 temporary reply');
  const active = await page.evaluate(() => window.medclaw.request('run.active', {})); if (!active.ok || !active.data) throw new Error('No active run'); const runId = active.data.runId;
  const original = await page.evaluate(runId => window.medclaw.request('run.read', { runId }), runId); if (!original.ok || original.data.kind !== 'one' || !original.data.run || original.data.run.kind !== 'agent') throw new Error('No original run');
  await select(b.id); await input().fill('B independent unsent draft'); const bHistory = await messages(b.id), bAnswer = bHistory.items.find(item => item.displayRole === 'assistant')!; await expect(region().locator(`[data-native-entry-id="${bAnswer.nativeEntryId}"] .answer-text`)).toHaveText('P4 temporary reply saved'); await expect(page.getByTestId('run-output')).toHaveCount(0); await expect(region()).not.toContainText('slow A tool');
  await page.getByRole('button', { name: 'View run details', exact: true }).click(); await page.getByRole('tab', { name: 'Run details', exact: true }).click(); await page.getByRole('button', { name: `View Run ${runId}`, exact: true }).click();
  const details = page.getByTestId('run-native-messages'); await expect(details).toContainText('Session ' + a.id); await expect(details).toContainText('tool result'); await expect(page.getByTestId('tool-call-details')).toContainText('read_data_scope'); await expect(input()).toHaveValue('B independent unsent draft');
  const host = await page.evaluate(() => window.medclaw.request('host.read', {})); if (!host.ok) throw new Error('No host'); await rules([{ method: 'run.read', sessionId: b.id, hold: 'B-refresh-original-details' }]);
  const directory = await page.evaluate(() => window.medclaw.request('model.read', {})); if (!directory.ok) throw new Error('No directory');
  await app.evaluate(({ BrowserWindow }, ids) => BrowserWindow.getAllWindows()[0]!.webContents.send('medclaw:notice', { type: 'config.changed', ...ids }), { instanceId: host.data.instanceId, configVersion: directory.data.configVersion }); await entered('B-refresh-original-details'); await release('B-refresh-original-details'); await expect(details).toContainText('Session ' + a.id); await expect(page.getByTestId('tool-call-details')).toContainText('read_data_scope');
  const workspace = await page.evaluate(() => window.medclaw.request('workspace.read', {})); expect(workspace).toMatchObject({ ok: true, data: { sessionId: b.id } });
  await rules([{ method: 'session.messages.read', sessionId: a.id, project: projection(a.id, a.nativeSessionId, 'reference-leaf', [entry('reference', 'Original references', { runId, references: [`run:${runId}`, `tool:${1}`, 'query:999999', 'evidence:999999'] })]) }]);
  await details.getByRole('button', { name: 'Refresh messages', exact: true }).click(); await expect(details).toContainText('Original references');
  const mutationsBeforeReferences = (await calls()).filter(call => ['session.select', 'workspace.update'].includes(call.method)).length;
  await details.getByRole('button', { name: `Read run:${runId}`, exact: true }).click(); await expect(details.getByRole('status')).toContainText(`Run ${runId}`); await details.getByRole('button', { name: 'Read tool:1', exact: true }).click(); await expect(details.getByRole('status')).toContainText('Tool 1 · succeeded');
  // Consumer-only projection: rejecting the real second tools page would lose a proven original reference.
  // The fixture executed one actual read_data_scope call; these 51 records do not claim 51 SDK executions.
  const sourceTools = await page.evaluate(runId => window.medclaw.request('tool.read', { runId, page: 1, pageSize: 50 }), runId);
  if (!sourceTools.ok || !sourceTools.data.items[0]) throw new Error('No original saved tool fixture');
  const projectedCalls = Array.from({ length: 51 }, (_, index) => ({ ...sourceTools.data.items[0]!, id: index + 1, nativeToolCallId: 'projected-original-' + (index + 1) }));
  const toolsPage = (pageNumber: number, items = projectedCalls.slice((pageNumber - 1) * 50, pageNumber * 50), totalRows = 51) => ({ ok: true, data: { ...sourceTools.data, runId, page: pageNumber, pageSize: 50, totalRows, items } });
  await rules([{ method: 'session.messages.read', sessionId: a.id, project: projection(a.id, a.nativeSessionId, 'tool-reference-leaf', [entry('tool-reference-51', 'Original later tool reference', { runId, toolCallRef: 'projected-original-51', references: [`run:${runId}`, 'tool:51', 'query:999999', 'evidence:999999'] })]) }]);
  await details.getByRole('button', { name: 'Refresh messages', exact: true }).click(); await expect(details).toContainText('Original later tool reference');
  const toolReads = async () => (await calls()).filter(call => call.method === 'tool.read');
  let readStart = (await toolReads()).length;
  await rules([{ method: 'tool.read', runId, page: 1, project: toolsPage(1) }, { method: 'tool.read', runId, page: 2, project: toolsPage(2) }]);
  await details.getByRole('button', { name: 'Read tool:51', exact: true }).click(); await expect(details.getByRole('status')).toHaveText('Tool 51 · succeeded');
  expect((await toolReads()).slice(readStart)).toEqual([{ method: 'tool.read', runId, page: 1, pageSize: 50 }, { method: 'tool.read', runId, page: 2, pageSize: 50 }]);
  readStart = (await toolReads()).length;
  await rules([{ method: 'tool.read', runId, page: 1, project: toolsPage(1) }, { method: 'tool.read', runId, page: 2, project: toolsPage(2, [{ ...projectedCalls[50]!, sessionId: b.id }], 5000) }]);
  await details.getByRole('button', { name: 'Read tool:51', exact: true }).click(); await expect(details.getByRole('status')).toContainText('Original reference tool:51 unavailable');
  expect((await toolReads()).slice(readStart)).toEqual([{ method: 'tool.read', runId, page: 1, pageSize: 50 }, { method: 'tool.read', runId, page: 2, pageSize: 50 }]);
  await rules([{ method: 'tool.read', runId, page: 1, project: toolsPage(1) }, { method: 'tool.read', runId, page: 2, hold: 'old-tool-page-two', project: toolsPage(2) }]);
  await details.getByRole('button', { name: 'Read tool:51', exact: true }).click(); await entered('old-tool-page-two'); await details.getByRole('button', { name: `Read run:${runId}`, exact: true }).click(); await expect(details.getByRole('status')).toContainText(`Run ${runId}`); const newerReference = await details.getByRole('status').innerText(); await release('old-tool-page-two'); await expect(details.getByRole('status')).toHaveText(newerReference);
  readStart = (await toolReads()).length;
  await rules([{ method: 'tool.read', runId, page: 1, hold: 'retired-tool-page-one', project: toolsPage(1) }]);
  await details.getByRole('button', { name: 'Read tool:51', exact: true }).click(); await entered('retired-tool-page-one'); await details.getByRole('button', { name: `Read run:${runId}`, exact: true }).click(); await expect(details.getByRole('status')).toHaveText(newerReference); await release('retired-tool-page-one'); await expect(details.getByRole('status')).toHaveText(newerReference);
  expect((await toolReads()).slice(readStart)).toEqual([{ method: 'tool.read', runId, page: 1, pageSize: 50 }]);
  await details.getByRole('button', { name: 'Read query:999999', exact: true }).click(); await expect(details).toContainText('Original reference query:999999 unavailable'); await details.getByRole('button', { name: 'Read evidence:999999', exact: true }).click(); await expect(details).toContainText('Original reference evidence:999999 unavailable');
  expect((await calls()).filter(call => ['session.select', 'workspace.update'].includes(call.method)).length).toBe(mutationsBeforeReferences);
  expect(await page.evaluate(() => window.medclaw.request('workspace.read', {}))).toMatchObject(workspace);
  await page.getByRole('button', { name: 'Close run details', exact: true }).click(); await page.getByRole('button', { name: 'Stop generating', exact: true }).click(); await expect(input()).toHaveValue('B independent unsent draft'); await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  expect((await calls()).filter(call => call.method === 'run.cancel').at(-1)?.runId).toBe(runId);
  await select(a.id); await expect(page.getByText('Cancelled and saved', { exact: true })).toBeVisible(); await refresh(); await expect(region()).toContainText('slow A tool');
  const saved = await page.evaluate(async runId => ({ run: await window.medclaw.request('run.read', { runId }), tools: await window.medclaw.request('tool.read', { runId, page: 1, pageSize: 20 }) }), runId);
  expect(saved.run).toMatchObject({ ok: true, data: { kind: 'one', run: { id: runId, sessionId: a.id, status: 'cancelled', model: original.data.run.model, control: original.data.run.control } } }); expect(saved.tools).toMatchObject({ ok: true, data: { runId, items: [{ nativeToolCallId: 'p4-scope', status: 'succeeded' }] } }); expect(httpCount).toBe(before + 2);
});

// Scroll following must not resume on a page read, hidden-page update, or temporary preview.
test('temporary output and saved messages remain separate while scrolling', async () => {
  const a = await create(); const before = httpCount;
  await input().fill('short saved message'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  const native = await page.evaluate(id => window.medclaw.request('session.messages.read', { sessionId: id, leafId: null, afterEntryId: null, limit: 50 }), a.id); if (!native.ok) throw new Error('No native messages');
  const rows = Array.from({ length: 50 }, (_, index) => { const text = 'Historical native text ' + index + '\n' + 'Synthetic line\n'.repeat(8); return entry('history-' + index, text, index === 0 ? { textInfo: { totalChars: text.length + 100, truncated: true, redacted: true } } : {}); });
  await rules([{ method: 'session.messages.read', sessionId: a.id, project: projection(a.id, a.nativeSessionId, 'scroll-leaf', rows, 'scroll-cursor') }]); await refresh(); await expect(region().locator('[data-native-entry-id]')).toHaveCount(50); await expect(region()).toContainText('Native memory'); await expect(region()).not.toContainText('Saved'); await expect(page.getByTestId('run-output')).toHaveCount(0); await expect(page.locator('.model-answer')).toContainText('Native history page incomplete');
  await expect(region()).toContainText('Native message display truncated'); await expect(region()).toContainText('Unsafe native fields omitted');
  await page.locator('.messages').evaluate(element => { element.scrollTop = 200; element.dispatchEvent(new Event('scroll')); }); await expect(page.getByRole('button', { name: 'New content · Back to latest', exact: true })).toBeVisible();
  await rules([{ method: 'session.messages.read', sessionId: a.id, leafId: 'scroll-leaf', project: projection(a.id, a.nativeSessionId, 'scroll-leaf', [entry('tail', 'Native tail')]) }]); await region().getByRole('button', { name: 'Load more messages' }).click(); await expect(region().locator('[data-native-entry-id]')).toHaveCount(51); expect(await page.locator('.messages').evaluate(element => element.scrollTop)).toBeCloseTo(200, 0);
  await page.getByRole('button', { name: 'Models', exact: true }).click(); const hiddenTop = await page.locator('.messages').evaluate(element => element.scrollTop); const messageReads = (await calls()).filter(call => call.method === 'session.messages.read').length;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); expect(await page.locator('.messages').evaluate(element => element.scrollTop)).toBe(hiddenTop); expect((await calls()).filter(call => call.method === 'session.messages.read').length).toBe(messageReads);
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); await page.getByRole('button', { name: 'New content · Back to latest', exact: true }).click(); await expect.poll(() => page.locator('.messages').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
  await input().fill('slow A scroll'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => httpCount).toBe(before + 3); await expect(page.getByTestId('run-output')).toHaveText('P4 temporary reply'); await expect(page.locator('.model-answer')).toContainText('Temporary output'); await expect(page.locator('.model-answer')).not.toContainText('Saved');
  await rules([{ method: 'session.messages.read', sessionId: a.id, project: projection(a.id, a.nativeSessionId, 'preview-scroll-leaf', rows) }]); await refresh(); await expect(region().locator('[data-native-entry-id]')).toHaveCount(50);
  await page.locator('.messages').evaluate(element => { element.scrollTop = 200; element.dispatchEvent(new Event('scroll')); }); await expect(page.getByRole('button', { name: 'New content · Back to latest', exact: true })).toBeVisible();
  const facts = await page.evaluate(async () => ({ host: await window.medclaw.request('host.read', {}), active: await window.medclaw.request('run.active', {}) })); if (!facts.host.ok || !facts.active.ok || !facts.active.data) throw new Error('Missing original preview target');
  const previewTarget = { instanceId: facts.host.data.instanceId, sessionId: a.id, runId: facts.active.data.runId };
  await app.evaluate(({ BrowserWindow }, ids) => BrowserWindow.getAllWindows()[0]!.webContents.send('medclaw:notice', { type: 'agent.preview', ...ids, noticeSequence: 999, text: 'New temporary preview while reading', truncated: true }), previewTarget); await expect(page.getByTestId('run-output')).toHaveText('New temporary preview while reading'); expect(await page.locator('.messages').evaluate(element => element.scrollTop)).toBeCloseTo(200, 0); await expect(region()).not.toContainText('New temporary preview');
  await page.getByRole('button', { name: 'Models', exact: true }).click(); const previewHiddenTop = await page.locator('.messages').evaluate(element => element.scrollTop), previewHiddenReads = (await calls()).filter(call => call.method === 'session.messages.read').length;
  await app.evaluate(({ BrowserWindow }, ids) => BrowserWindow.getAllWindows()[0]!.webContents.send('medclaw:notice', { type: 'agent.preview', ...ids, noticeSequence: 1000, text: 'Hidden temporary preview', truncated: false }), previewTarget); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); expect(await page.locator('.messages').evaluate(element => element.scrollTop)).toBe(previewHiddenTop); expect((await calls()).filter(call => call.method === 'session.messages.read').length).toBe(previewHiddenReads); await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('button', { name: 'View run details', exact: true }).click(); await page.getByRole('tab', { name: 'Run details', exact: true }).click(); await app.evaluate(() => { (globalThis as MainGlobal).__p4Gate.toolProjection = 'unconfirmed'; }); await page.getByRole('button', { name: 'Refresh tools', exact: true }).click();
  const tool = page.getByTestId('tool-call-details'); await expect(tool.locator('dt:has-text("SDK result status") + dd')).toHaveText('Unknown; SDK receipt unconfirmed'); await expect(tool).toContainText('Model consumption: Unknown'); await expect(tool.locator('dt:has-text("Native output truncated") + dd')).toHaveText('Unknown'); await expect(tool).toContainText('Command exit code: Unknown'); await expect(tool).not.toContainText('INTERNAL-WRAPPER-VERSION');
  await app.evaluate(() => { (globalThis as MainGlobal).__p4Gate.toolProjection = 'truncated'; }); await page.getByRole('button', { name: 'Refresh tools', exact: true }).click(); await expect(tool.locator('dt:has-text("Native output truncated") + dd')).toHaveText('Yes'); await expect(tool).toContainText('Model consumption: Unknown');
  await app.evaluate(() => { (globalThis as MainGlobal).__p4Gate.toolProjection = 'verified'; }); await page.getByRole('button', { name: 'Refresh tools', exact: true }).click(); await expect(tool.locator('dt:has-text("Model consumption") + dd')).toContainText('Included in model call old-call'); await expect(tool.locator('dt:has-text("Native output truncated") + dd')).toHaveText('No');
  const evidence = join(root, '.build/p4-messages'); mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 't04-1440x900.png') });
  await page.setViewportSize({ width: 1100, height: 720 }); await expect(page.getByRole('dialog', { name: 'Run details', exact: true })).toBeVisible(); await page.screenshot({ path: join(evidence, 't04-1100x720.png') }); await page.setViewportSize({ width: 760, height: 720 });
  const close = page.getByRole('button', { name: 'Close run details', exact: true }); await close.focus(); await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('dialog', { name: 'Run details', exact: true })).toContainText('Native memory'); expect(await page.getByRole('dialog').evaluate(element => element.contains(document.activeElement))).toBe(true); await page.screenshot({ path: join(evidence, 't04-narrow-drawer.png') }); await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'View run details', exact: true })).toBeFocused(); await page.screenshot({ path: join(evidence, 't04-narrow-focus.png') });
  await page.setViewportSize({ width: 1100, height: 720 }); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.insertCSS('html { font-size: 28px !important; }')); expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('28px'); await page.getByRole('button', { name: 'View run details', exact: true }).click(); await expect(close).toBeVisible(); await page.screenshot({ path: join(evidence, 't04-200pct-css.png') }); await close.click();
  const sendButton = page.getByRole('button', { name: 'Send', exact: true }); await sendButton.scrollIntoViewIfNeeded(); const sendBounds = await sendButton.boundingBox(); expect(sendBounds).not.toBeNull(); expect(sendBounds!.x + sendBounds!.width).toBeLessThanOrEqual(1100); expect(sendBounds!.y + sendBounds!.height).toBeLessThanOrEqual(720); await page.screenshot({ path: join(evidence, 't04-200pct-css-chat.png') });
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click(); await expect(page.getByText('Cancelled and saved', { exact: true })).toBeVisible(); expect(httpCount).toBe(before + 3);
});

async function showRun(runId: number) { await page.getByRole('button', { name: 'View run details', exact: true }).click(); await page.getByRole('tab', { name: 'Run details', exact: true }).click(); await page.getByRole('button', { name: `View Run ${runId}`, exact: true }).click(); }
async function queryFact(queryId: number, runId: number, sessionId: number, toolId: string, expectedRows: number) {
  const result = await page.evaluate(queryId => window.medclaw.request('query.read', { queryId }), queryId); if (!result.ok) throw new Error(result.error.code);
  expect(result.data.query).toMatchObject({ id: queryId, runId, sessionId, callRef: `${runId}:${toolId}`, source: 'agent_tool', totalRows: expectedRows, scopeDeviceIds: null, interpretation: { requestedDate: null, requestedTime: { start: '2026-01-02', endExclusive: '2026-01-03' }, dataDates: ['2026-01-02'], referenceDate: '2026-01-02', timezone: 'Asia/Shanghai', basis: 'change_events', unit: 'events', quantity: expectedRows } });
  const facts = [];
  for (const summary of result.data.evidence) { const read = await page.evaluate(input => window.medclaw.request('evidence.read', input), { queryId, evidenceId: summary.id }); if (!read.ok) throw new Error(read.error.code); expect(read.data.evidence).toMatchObject({ id: summary.id, queryId, resultHash: result.data.query.resultHash, calculationVersion: result.data.query.calculationVersion, materialVersion: result.data.query.materialVersion, provenance: 'synthetic-derived', snapshotCount: expectedRows * 2, eventCount: expectedRows }); facts.push(read.data.evidence); }
  expect(facts).toHaveLength(1); return { query: result.data.query, evidence: facts };
}

// A model-free read interval cannot add a logical call or physical HTTP invocation.
test('A queries Zhejiang changes, follows up, corrects the manufacturer and keeps its own branch after browsing B', async () => {
  test.setTimeout(120000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 1200)); await page.setViewportSize({ width: 1600, height: 1200 });
  const a = await create(), b = await create(); await select(a.id);
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click(); await page.getByRole('button', { name: 'Choose snapshot directory', exact: true }).click(); await expect(page.getByTestId('import-state')).toHaveText('ready');
  await page.getByRole('button', { name: 'Confirm import', exact: true }).click(); await expect(page.getByTestId('import-state')).toHaveText('imported'); await expect(page.getByTestId('import-result')).toContainText('8 accepted rows');
  await page.getByRole('button', { name: 'Select batches on this page', exact: true }).click(); await page.getByRole('button', { name: 'Apply 2 selected batches', exact: true }).click(); await page.getByRole('button', { name: 'Chat', exact: true }).click();
  if (!await page.locator('.reference-fields').evaluate(element => (element as HTMLDetailsElement).open)) await page.locator('.reference-fields summary').click();
  await page.getByRole('button', { name: 'Use data defaults', exact: true }).click();
  const w = await page.evaluate(() => window.medclaw.request('workspace.read', {})); if (!w.ok) throw new Error('No Workspace'); const batchIds = w.data.batchRefs.map(batch => batch.id); expect(batchIds).toHaveLength(2); expect(w.data.deviceIds).toEqual([]);
  const queries: Record<string, QueryReceipt> = {}, scopes: ScopeReceipt[] = [], next = gate();
  const checkScope = (wire: Wire, id: string) => { const value = receipt<ScopeReceipt>(wire, id); expect(value).toMatchObject({ scope: { batchIds, deviceIds: null }, referenceDate: '2026-01-02', timezone: 'Asia/Shanghai' }); scopes.push(value); return value.scope.batchIds; };
  const args = (ids: number[], corrected: boolean, increase = false) => ({ batchIds: ids, time: { start: '2026-01-02', endExclusive: '2026-01-03' }, region: '浙江', changeField: 'price', direction: increase ? 'increase' : 'decrease', manufacturer: corrected ? '模拟厂家-01' : '模拟厂家-02', ...(!corrected ? { distributor: '模拟配送-01' } : {}), sort: 'asc', page: 1, pageSize: 50 });
  const triplet = (key: string, corrected: boolean, increase = false): NonNullable<typeof script> => [
    () => ({ id: `p4-${key}-scope`, name: 'read_data_scope', args: {} }),
    wire => ({ id: `p4-${key}-query`, name: 'query_device_changes', args: args(checkScope(wire, `p4-${key}-scope`), corrected, increase) }),
    wire => { const value = receipt<QueryReceipt>(wire, `p4-${key}-query`); expect(value.totalRows).toBe(corrected && !increase ? 2 : 1); expect(value.rows.map(row => row.deltaCents)).toEqual(increase ? [2000] : corrected ? [-2000, -5000] : [-1000]); expect(value.rows.map(row => row.ratio)).toEqual(increase ? [0.2] : corrected ? [-0.2, -0.25] : [-0.1]); expect(value.evidenceIds).toHaveLength(1); queries[key] = value; return { text: key === 'b' ? 'B-P4-ANSWER-UNIQUE' : `A-P4-${key}-ANSWER ${value.totalRows} change events` }; },
  ];
  const a4 = triplet('a4', true), firstA4 = a4[0]!;
  a4[0] = async wire => { const text = JSON.stringify(wire.messages); for (const marker of ['A-P4-DECREASE', 'A-P4-STATS', 'A-P4-CORRECTION', 'A-P4-NEXT']) expect(text).toContain(marker); for (const marker of ['B-P4-UNIQUE', 'B-P4-ANSWER-UNIQUE', 'p4-b-scope', 'p4-b-query', 'B unique increase device']) expect(text).not.toContain(marker); next.enter(); await next.response; return firstA4(wire); };
  const before = httpCount, origins = [];
  arm([...triplet('a1', false),
    () => ({ id: 'p4-a2-scope', name: 'read_data_scope', args: {} }),
    wire => { checkScope(wire, 'p4-a2-scope'); return { id: 'p4-a2-summary', name: 'read_query', args: { queryId: queries.a1!.queryId } }; },
    wire => { const summary = receipt<{ queryId: number; totalRows: number; params: { manufacturer: string; distributor: string } }>(wire, 'p4-a2-summary'); expect(summary).toMatchObject({ queryId: queries.a1!.queryId, totalRows: 1, params: { manufacturer: '模拟厂家-02', distributor: '模拟配送-01' } }); return { id: 'p4-a2-page', name: 'read_query_page', args: { queryId: queries.a1!.queryId, page: 1, pageSize: 50 } }; },
    wire => { const value = receipt<QueryReceipt>(wire, 'p4-a2-page'); expect(value).toMatchObject({ queryId: queries.a1!.queryId, totalRows: 1, rows: [{ deltaCents: -1000, ratio: -0.1 }] }); return { text: 'A-P4-STATS-ANSWER 1 change event; decline 1000 cents, 10%' }; },
    ...triplet('a3', true), ...triplet('b', true, true), ...a4]);
  origins.push(await send('A-P4-DECREASE 浙江降价器械，模拟厂家-02、模拟配送-01'));
  const queryListBefore = await page.evaluate(sessionId => window.medclaw.request('query.list', { sessionId }), a.id); if (!queryListBefore.ok) throw new Error(queryListBefore.error.code);
  origins.push(await send('A-P4-STATS 追问刚才结果的数量和降幅'));
  expect(await page.evaluate(sessionId => window.medclaw.request('query.list', { sessionId }), a.id)).toEqual(queryListBefore);
  origins.push(await send('A-P4-CORRECTION 改为模拟厂家-01，取消配送企业限制'));
  const oldA = await messages(a.id); await shot('driving-A-correction'); await select(b.id); origins.push(await send('B-P4-UNIQUE 只查模拟厂家-01涨价')); const oldB = await messages(b.id); await shot('driving-B'); await messageShots('driving-B', oldB);
  expect(a.nativeSessionId).not.toBe(b.nativeSessionId); const readBefore = httpCount;
  const bFact = await queryFact(queries.b!.queryId, origins[3]!.run.id, b.id, 'p4-b-query', 1);
  await select(a.id); const oldFacts = [await queryFact(queries.a1!.queryId, origins[0]!.run.id, a.id, 'p4-a1-query', 1), await queryFact(queries.a3!.queryId, origins[2]!.run.id, a.id, 'p4-a3-query', 2)];
  expect(oldFacts[1]!.query.params.manufacturer).toBe('模拟厂家-01'); expect(oldFacts[1]!.query.params.distributor ?? null).toBeNull();
  await page.getByRole('button', { name: 'Query History', exact: true }).click(); await page.getByRole('button', { name: `Read Query ${queries.a1!.queryId} from Run ${origins[0]!.run.id}`, exact: true }).click(); await expect(page.getByLabel('Saved query result', { exact: true })).toContainText('Original manufacturer decrease'); await page.getByRole('button', { name: `Read evidence ${queries.a1!.evidenceIds[0]}`, exact: true }).click(); await expect(page.getByLabel('Query evidence', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Chat', exact: true }).click();
  for (const record of origins) expect((await readRun(record.run.id)).calls.map(call => call.callId)).toEqual(record.run.calls.map(call => call.callId));
  expect(httpCount).toBe(readBefore); expect(inFlight).toBe(0);
  const continuation = send('A-P4-NEXT 继续按纠正后的条件查浙江降价'); await next.entered; await shot('driving-A-next-wire-gate'); next.release(); origins.push(await continuation);
  const currentA = await messages(a.id), unchangedA = await messages(a.id, oldA.leafId), unchangedB = await messages(b.id, oldB.leafId);
  expect(unchangedA).toEqual(oldA); expect(unchangedB).toEqual(oldB); expect(currentA.leafId).not.toBe(oldA.leafId); expect(currentA.items.filter(item => item.displayRole === 'user').map(item => item.text)).not.toContain('B-P4-UNIQUE 只查模拟厂家-01涨价');
  const finalFact = await queryFact(queries.a4!.queryId, origins[4]!.run.id, a.id, 'p4-a4-query', 2); expect(new Set(Object.values(queries).map(q => q.queryId)).size).toBe(4);
  const allAQueries = await page.evaluate(sessionId => window.medclaw.request('query.list', { sessionId }), a.id); if (!allAQueries.ok) throw new Error(allAQueries.error.code); expect(allAQueries.data.items.map(query => query.id).sort((a, b) => a - b)).toEqual([queries.a1!.queryId, queries.a3!.queryId, queries.a4!.queryId].sort((a, b) => a - b));
  const toolFacts = [];
  for (const record of origins) { const tools = await page.evaluate(runId => window.medclaw.request('tool.read', { runId, page: 1, pageSize: 50 }), record.run.id); if (!tools.ok) throw new Error(tools.error.code); for (const tool of tools.data.items) { expect(tool).toMatchObject({ sessionId: record.origin.sessionId, runId: record.run.id, sdkReturned: true, status: 'succeeded', consumptionEvidence: 'provider_input_verified' }); expect(record.run.calls.map(call => call.callId)).toContain(tool.nextModelCallId); const native = (tool.sessionId === a.id ? currentA : oldB).items.find(item => item.toolCallRef === tool.nativeToolCallId); expect(native).toMatchObject({ nativeEntryId: tool.nativeEntryId, runId: tool.runId }); } toolFacts.push(...tools.data.items.map(tool => ({ id: tool.id, sessionId: tool.sessionId, runId: tool.runId, nativeToolCallId: tool.nativeToolCallId, modelCallId: tool.modelCallId, nextModelCallId: tool.nextModelCallId, nativeEntryId: tool.nativeEntryId, consumptionEvidence: tool.consumptionEvidence }))); }
  expect(scriptErrors).toEqual([]); expect(httpCount - before).toBe(16); expect(origins.flatMap(record => record.run.calls)).toHaveLength(16); expect(toolFacts).toHaveLength(11); expect(scopes).toHaveLength(5);
  await refresh(); await expect(region()).toContainText('A-P4-NEXT'); await shot('driving-A-complete'); await messageShots('driving-A', currentA);
  saveEvidence('driving', { controlledProvider: true, isolatedRoot: temporary, origins: origins.map(({ origin, run }) => ({ ...origin, nativeSessionId: run.kind === 'agent' ? run.nativeSessionId : null, answerRef: run.answerRef, calls: run.calls.map(call => call.callId) })), scopeCount: scopes.length, physicalCalls: httpCount - before, toolFacts, queries: [...oldFacts, bFact, finalFact].map(fact => fact.query), evidence: [...oldFacts, bFact, finalFact].flatMap(fact => fact.evidence), aLeaf: currentA.leafId, oldALeaf: oldA.leafId, bLeaf: oldB.leafId, entries: [...currentA.items.map(item => ({ sessionId: a.id, ...item })), ...oldB.items.map(item => ({ sessionId: b.id, ...item }))], wireFacts }); script = null;
});

test('lost submission reply is looked up before reading the original messages without a resend', async () => {
  const a = await create(), b = await create(); await select(a.id); await idle(); const responseGate = gate(), before = httpCount, acceptedBefore = (await accepted()).length, callsBefore = (await calls()).length;
  arm([async wire => { expect(JSON.stringify(wire.messages)).toContain('P4-LOST-ORIGINAL'); responseGate.enter(); await responseGate.response; return { text: 'P4-LOST-SAVED-ANSWER' }; }]);
  await rules([{ method: 'session.submit', sessionId: a.id, project: { ok: false, error: safeError('operation_result_unknown') } }]);
  await input().fill('P4-LOST-ORIGINAL'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await responseGate.entered;
  await expect(page.getByRole('button', { name: 'Read original submission', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Resend original submission', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  const original = (await accepted())[acceptedBefore]!; expect(original).toMatchObject({ sessionId: a.id, clientSequence: a.nextSubmissionSequence });
  await rules([{ method: 'session.readSubmission', sessionId: a.id, project: { ok: true, data: null } }]); await page.getByRole('button', { name: 'Read original submission', exact: true }).click(); await expect(page.getByRole('button', { name: 'Read original submission', exact: true })).toBeEnabled(); await expect(input()).toHaveValue('P4-LOST-ORIGINAL');
  await rules([{ method: 'session.readSubmission', sessionId: a.id, hold: 'original-lookup' }]); await page.getByRole('button', { name: 'Read original submission', exact: true }).click(); await entered('original-lookup');
  await select(b.id); await input().fill('P4-B-UNSENT-DRAFT'); const mutations = (await calls()).filter(call => ['session.select', 'workspace.update'].includes(call.method)).length; await release('original-lookup');
  await expect.poll(async () => (await calls()).some(call => call.method === 'run.read' && call.runId === original.runId)).toBe(true); await expect(input()).toHaveValue('P4-B-UNSENT-DRAFT'); await expect(region()).not.toContainText('P4-LOST-ORIGINAL');
  expect((await calls()).filter(call => ['session.select', 'workspace.update'].includes(call.method)).length).toBe(mutations); expect((await accepted()).length).toBe(acceptedBefore + 1); expect(httpCount).toBe(before + 1);
  await select(a.id); await expect(page.getByRole('button', { name: 'Read original submission', exact: true })).toHaveCount(0); await refresh(); await expect(region()).toContainText('P4-LOST-ORIGINAL'); await shot('lost-reply-original-lookup');
  const bridge = (await calls()).slice(callsBefore), submit = bridge.filter(call => call.method === 'session.submit'), lookups = bridge.filter(call => call.method === 'session.readSubmission'); expect(submit).toHaveLength(1); expect(lookups).toHaveLength(2); expect(lookups.every(call => call.sessionId === a.id && call.clientSequence === original.clientSequence)).toBe(true);
  expect(bridge.findIndex(call => call.method === 'session.readSubmission')).toBeGreaterThan(bridge.findIndex(call => call.method === 'session.submit'));
  expect(bridge.findIndex(call => call.method === 'run.read' && call.runId === original.runId)).toBeGreaterThan(bridge.findIndex(call => call.method === 'session.readSubmission'));
  responseGate.release(); await idle(); const run = await readRun(original.runId); expect(run).toMatchObject({ status: 'completed', sessionId: a.id, clientSequence: original.clientSequence }); expect(run.answerRef).not.toBeNull();
  const readBefore = httpCount, callIds = run.calls.map(call => call.callId), history = await messages(a.id); expect(history.items.filter(item => item.displayRole === 'user' && item.text === 'P4-LOST-ORIGINAL')).toHaveLength(1); await refresh(); await expect(region()).toContainText('P4-LOST-SAVED-ANSWER'); expect((await readRun(original.runId)).calls.map(call => call.callId)).toEqual(callIds); expect(httpCount).toBe(readBefore); expect(scriptErrors).toEqual([]);
  saveEvidence('lost-reply', { controlledProvider: true, original, physicalCalls: httpCount - before, lookupCount: lookups.length, submits: submit.length, callIds, nativeSessionId: history.nativeSessionId, leafId: history.leafId, entries: history.items.map(item => ({ nativeEntryId: item.nativeEntryId, parentEntryId: item.parentEntryId, runId: item.runId })), bridge }); script = null;
});

test('tool success survives failed delivery without a falsely consumed message or answer', async () => {
  test.setTimeout(60000); const a = await create(); await idle(); await reference(); const before = httpCount, acceptedBefore = (await accepted()).length;
  arm([() => ({ id: 'p4-fault-scope', name: 'read_data_scope', args: {} }), wire => { const scope = receipt<ScopeReceipt>(wire, 'p4-fault-scope'); return { id: 'p4-fault-query', name: 'query_device_changes', args: { batchIds: scope.scope.batchIds, time: { start: '2026-01-02', endExclusive: '2026-01-03' }, region: '浙江', changeField: 'price', direction: 'decrease', manufacturer: '模拟厂家-01', page: 1, pageSize: 50 } }; }]);
  await input().fill('P4-DELIVERY-SAVE-FAULT'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => existsSync(join(temporary, 'fault.json'))).toBe(true);
  const fault = JSON.parse(readFileSync(join(temporary, 'fault.json'), 'utf8')) as { runId: number; sessionId: number; toolId: number; queryId: number; resultHash: string; nativeEntryId: string; toolCallId: string; isError: boolean; executions: number };
  const origin = (await accepted())[acceptedBefore]!; expect(fault).toMatchObject({ runId: origin.runId, sessionId: a.id, toolCallId: 'p4-fault-query', isError: false, executions: 1 });
  await expect.poll(async () => { const active = await page.evaluate(() => window.medclaw.request('run.active', {})); return active.ok && active.data?.persistencePending; }).toBe(true);
  const failed = await readRun(origin.runId); expect(failed).toMatchObject({ status: 'failed', answerRef: null, error: { code: 'storage_write_failed' } });
  const control = await page.evaluate(() => window.medclaw.request('run.control.read', {})); expect(control).toMatchObject({ ok: true, data: { acceptingNewRuns: false, activeRootRun: { runId: origin.runId } } });
  const readTools = () => page.evaluate(runId => window.medclaw.request('tool.read', { runId, page: 1, pageSize: 50 }), origin.runId);
  const unsaved = await readTools(); if (!unsaved.ok) throw new Error(unsaved.error.code); const target = unsaved.data.items.find(tool => tool.nativeToolCallId === 'p4-fault-query'); expect(target).toMatchObject({ id: fault.toolId, sessionId: a.id, runId: origin.runId, status: 'succeeded', sdkReturned: false, nativeEntryId: null, sdkResultIsError: null }); expect(target?.nextModelCallId ?? null).toBeNull(); expect(target?.consumedAt ?? null).toBeNull(); expect(target?.consumptionEvidence).toBeUndefined();
  const fact = await queryFact(fault.queryId, origin.runId, a.id, 'p4-fault-query', 2), native = await messages(a.id); expect(fact.query.resultHash).toBe(fault.resultHash); expect(native.items.find(item => item.toolCallRef === 'p4-fault-query')).toMatchObject({ nativeEntryId: fault.nativeEntryId, displayRole: 'tool_result', runId: null });
  await showRun(origin.runId); const details = page.getByTestId('tool-call-details').locator('article').filter({ hasText: 'p4-fault-query' }); await expect(details).toContainText('succeeded'); await expect(details).toContainText('SDK return not confirmed'); await expect(details).toContainText('Model consumption: Unknown'); await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeEnabled(); await details.getByText('SDK return not confirmed', { exact: true }).scrollIntoViewIfNeeded(); await shot('delivery-save-failed-tool'); await shot('delivery-save-failed');
  await expect(page.locator('.model-answer')).toContainText('Waiting to save'); await expect(page.locator('.model-answer').getByRole('alert')).toContainText('Run facts have not been confirmed saved');
  await rules([{ method: 'run.retrySave', runId: origin.runId, hold: 'final-fix-retry-error' }]);
  await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await entered('final-fix-retry-error');
  const b = await create(); await select(a.id); await expect(page.locator('.detail-run')).toContainText(`Run ${origin.runId}`);
  await release('final-fix-retry-error'); await expect(page.locator('.error-banner')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.medclaw.request('run.control.read', {}))).toMatchObject({ ok: true, data: { acceptingNewRuns: false } }); expect(httpCount).toBe(before + 2);
  writeFileSync(join(temporary, 'release-fault'), 'release original saved closure');
  await rules([{ method: 'run.retrySave', runId: origin.runId, hold: 'final-fix-retry-success' }]);
  await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await entered('final-fix-retry-success'); await select(b.id);
  const beforeSuccessRelease = (await calls()).length; await release('final-fix-retry-success'); await idle();
  await expect(page.locator('.detail-run')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toHaveCount(0);
  expect((await calls()).slice(beforeSuccessRelease).some(call => call.method === 'run.active')).toBe(true); await select(a.id);
  const saved = await readRun(origin.runId); expect(saved).toMatchObject({ status: 'failed', answerRef: null, cleanup: { stopConfirmed: true, requiredPersistenceComplete: true } }); expect(saved.calls.map(call => call.callId)).toEqual(failed.calls.map(call => call.callId));
  const tools = await readTools(); if (!tools.ok) throw new Error(tools.error.code); const retried = tools.data.items.find(tool => tool.id === fault.toolId); expect(retried).toMatchObject({ status: 'succeeded', sdkReturned: true, sdkResultIsError: false, nativeEntryId: fault.nativeEntryId }); expect(retried?.nextModelCallId ?? null).toBeNull(); expect(retried?.consumedAt ?? null).toBeNull(); expect(retried?.consumptionEvidence).toBeUndefined();
  const recoveredNative = await messages(a.id, native.leafId); expect(recoveredNative.leafId).toBe(native.leafId); const nativeOnly = (value: SessionMessagePage) => value.items.map(({ runId, references, ...entry }) => entry); expect(nativeOnly(recoveredNative)).toEqual(nativeOnly(native)); expect(recoveredNative.items.find(item => item.toolCallRef === 'p4-fault-query')).toMatchObject({ nativeEntryId: fault.nativeEntryId, runId: origin.runId, references: [`run:${origin.runId}`, `tool:${fault.toolId}`, `query:${fault.queryId}`, `evidence:${fact.evidence[0]!.id}`] }); expect((await queryFact(fault.queryId, origin.runId, a.id, 'p4-fault-query', 2)).query).toEqual(fact.query); expect(httpCount).toBe(before + 2); expect(scriptErrors).toEqual([]); expect(JSON.parse(readFileSync(join(temporary, 'query-executions.json'), 'utf8')).executions).toBe(1);
  await page.getByRole('button', { name: 'Refresh tools', exact: true }).click(); await expect(details).toContainText('SDK result saved'); await expect(details).toContainText('Model consumption: Unknown'); await details.getByText('SDK result saved', { exact: true }).scrollIntoViewIfNeeded(); await shot('delivery-save-retried-tool'); await shot('delivery-save-retried'); await page.getByRole('button', { name: 'Close run details', exact: true }).click();
  saveEvidence('delivery-save', { controlledProvider: true, origin, fault, physicalCalls: httpCount - before, nativeSessionId: native.nativeSessionId, leafId: native.leafId, logicalCallIds: saved.calls.map(call => call.callId), query: fact.query, evidence: fact.evidence, failed: { status: failed.status, answerRef: failed.answerRef }, saved: { status: saved.status, answerRef: saved.answerRef, cleanup: saved.cleanup }, originalEntry: fault.nativeEntryId, tools: tools.data.items.map(tool => ({ id: tool.id, nativeToolCallId: tool.nativeToolCallId, sdkReturned: tool.sdkReturned, nativeEntryId: tool.nativeEntryId, nextModelCallId: tool.nextModelCallId, consumptionEvidence: tool.consumptionEvidence })), nativeHistoryPresentBeforeReceiptSave: true }); script = null;
});

test('actual same-text submissions, cursors and native structural omission remain model-free on reads', async () => {
  const a = await create(); await expect(region()).toContainText('No native messages'); const empty = await messages(a.id); expect(empty).toMatchObject({ source: 'native_memory', leafId: null, items: [], hasMore: false });
  const before = httpCount, text = 'P4-SAME-ACTUAL-TEXT';
  arm([wire => { expect(wire.messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes(text))).toHaveLength(1); return { text: 'P4-SAME-FIRST' }; }, wire => { expect(wire.messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes(text))).toHaveLength(2); return { text: 'P4-SAME-SECOND' }; }, () => ({ text: 'P4-CURSOR-B' })]);
  const one = await send(text), two = await send(text); expect(one.origin.clientSequence).not.toBe(two.origin.clientSequence); expect(one.run.id).not.toBe(two.run.id); const nativeA = await messages(a.id); const users = nativeA.items.filter(item => item.displayRole === 'user' && item.text === text); expect(users).toHaveLength(2); expect(new Set(users.map(item => item.nativeEntryId)).size).toBe(2); expect(users.map(item => item.runId)).toEqual([one.run.id, two.run.id]); await refresh(); await expect(region().getByText(text, { exact: true })).toHaveCount(2);
  const b = await create(), bRun = await send('P4-CURSOR-B-USER'), nativeB = await messages(b.id), foreign = nativeB.items.find(item => item.displayRole === 'user')!; await select(a.id); await idle();
  const readBefore = httpCount, workspace = await page.evaluate(() => window.medclaw.request('workspace.read', {}));
  const invalid = await page.evaluate(input => window.medclaw.request('session.messages.read', input), { sessionId: a.id, leafId: nativeA.leafId, afterEntryId: foreign.nativeEntryId, limit: 1 }); expect(invalid).toMatchObject({ ok: false, error: { code: 'input_invalid', reason: 'message_cursor_invalid' } });
  const badLeaf = await page.evaluate(input => window.medclaw.request('session.messages.read', input), { sessionId: a.id, leafId: 'absent-leaf', afterEntryId: null, limit: 1 }); expect(badLeaf).toMatchObject({ ok: false, error: { code: 'input_invalid', reason: 'message_cursor_invalid' } });
  let afterEntryId: string | null = null; const paged: SessionMessageView[] = [];
  do { const nextPage: SessionMessagePage = await messages(a.id, nativeA.leafId, 1, afterEntryId); paged.push(...nextPage.items); afterEntryId = nextPage.nextEntryId; } while (afterEntryId);
  expect(paged).toEqual(nativeA.items); expect(await page.evaluate(() => window.medclaw.request('workspace.read', {}))).toEqual(workspace); expect(await messages(a.id)).toEqual(nativeA);
  for (const record of [one, two, bRun]) expect((await readRun(record.run.id)).calls.map(call => call.callId)).toEqual(record.run.calls.map(call => call.callId)); expect(httpCount).toBe(readBefore); expect(scriptErrors).toEqual([]);
  script = null; writeFileSync(join(temporary, 'seed-structure'), 'test-only never send'); const seeded = await create(); rmSync(join(temporary, 'seed-structure'));
  const structural = await messages(seeded.id), dto = JSON.stringify(structural); expect(dto).not.toContain('STRUCTURE-CANARY'); for (const key of ['thinkingSignature', 'textSignature', 'base64', 'command', 'details']) expect(dto).not.toContain(key); expect(Buffer.byteLength(dto)).toBeLessThanOrEqual(3 * 1024 * 1024);
  const seededAnswer = structural.items.find(item => item.displayRole === 'assistant'); expect(seededAnswer).toMatchObject({ text: 'x'.repeat(8191), textInfo: { totalChars: 8194, truncated: true, redacted: true } }); expect(structural.items.find(item => item.displayRole === 'tool_result')).toMatchObject({ text: null, toolCallRef: 'seeded-read', textInfo: { redacted: true } });
  await refresh(); await expect(region()).toContainText('Native message display truncated'); await expect(region()).toContainText('Unsafe native fields omitted'); await expect(region()).not.toContainText('STRUCTURE-CANARY'); expect(await region().ariaSnapshot()).not.toContain('STRUCTURE-CANARY');
  const preserved = JSON.parse(readFileSync(join(temporary, 'seed-observed.json'), 'utf8')); expect(preserved).toEqual({ nativeSessionId: seeded.nativeSessionId, unchanged: true }); expect(httpCount).toBe(readBefore); await shot('actual-structure-test-only');
  saveEvidence('same-text-and-safe-reads', { controlledProvider: true, physicalCalls: httpCount - before, sameText: [one.origin, two.origin], nativeSessionId: nativeA.nativeSessionId, leafId: nativeA.leafId, distinctUserEntries: users.map(item => ({ nativeEntryId: item.nativeEntryId, runId: item.runId })), cursorErrors: [invalid.ok ? null : { code: invalid.error.code, reason: invalid.error.reason }, badLeaf.ok ? null : { code: badLeaf.error.code, reason: badLeaf.error.reason }], paginationCount: paged.length, readPhysicalDelta: httpCount - readBefore, logicalIds: [one, two, bRun].flatMap(record => record.run.calls.map(call => call.callId)), structuralFixture: { testOnly: true, sentToModel: false, nativeSessionId: seeded.nativeSessionId, unchanged: preserved.unchanged, dtoBytes: Buffer.byteLength(dto), leafId: structural.leafId, nativeEntryIds: structural.items.map(item => item.nativeEntryId) } });
});
