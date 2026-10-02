import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { canonicalRequest } from '../../packages/contracts/src/run';
import { safeError } from '../../packages/contracts/src/error';

const root = resolve(import.meta.dirname, '../..'), bun = process.env.MEDCLAW_BUN_EXECUTABLE ?? 'bun';
let app: ElectronApplication, page: Page, temporary: string, server: Server, nativeRunId: number;
const providerUserTexts: string[] = [];
let dateQueryGate: { entered: Promise<void>; reply: Promise<void>; markEntered: () => void; release: () => void } | null = null;
test.describe.configure({ mode: 'serial' });
function snapshotPackage(directory: string) {
  mkdirSync(directory, { recursive: true });
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const csv = (values: string[]) => values.map(value => `"${value.replaceAll('"', '""')}"`).join(',');
  const masters = Array.from({ length: 55 }, (_, index) => ({ record_type: 'master', device_id: String(index + 1).padStart(5, '0'), device_name: index === 0 ? 'UI fixture device' : `UI fixture device ${index + 1}`, source_submission_id: '00009', source_applicant: 'Applicant', category: 'Category', manufacturer: 'Synthetic manufacturer' }));
  const sourceLock = { schema: 'medclaw.source-lock/v1', sources: [{ source: 'fixture', path: 'original.csv', sha256: 'a'.repeat(64) }] };
  const lockHash = hash(canonicalRequest(sourceLock)), cohortHash = hash(canonicalRequest(masters));
  writeFileSync(join(directory, 'source-lock.json'), JSON.stringify(sourceLock));
  writeFileSync(join(directory, 'entity-lineage.csv'), `${csv(Object.keys(masters[0]!))}\n${masters.map(master => csv(Object.values(master))).join('\n')}\n`);
  for (const name of ['adjustment-lineage.csv', 'validation-report.json', 'selection-report.json', '使用说明.md']) writeFileSync(join(directory, name), name.endsWith('.json') ? '{}' : 'fixture');
  const columns = ['device_id', 'device_name', 'source_submission_id', 'source_applicant', 'category', 'region', 'snapshot_date', 'price_cents', 'currency', 'unit', 'status', 'manufacturer', 'distributor', 'source_refs_json', 'field_origins_json'];
  const origins = Object.fromEntries(columns.slice(0, 13).map(key => [key, { kind: 'synthetic', ruleId: 'ui-fixture' }]));
  const refs = [{ sourceId: 'fixture', file: 'original.csv', row: 1, recordId: '00009', sha256: 'a'.repeat(64) }];
  for (const [index, price] of [100, 80].entries()) {
    const date = `2026-01-0${index + 1}`, text = `${csv(columns)}\n${masters.map((master, ordinal) => csv([master.device_id, master.device_name, '00009', 'Applicant', 'Category', '浙江', date, String(price), 'CNY', '件', index === 1 && ordinal === 54 ? 'suspended' : 'active', 'Synthetic manufacturer', 'Distributor', JSON.stringify(refs), JSON.stringify(origins)])).join('\n')}\n`;
    writeFileSync(join(directory, `zhejiang_${date}.csv`), text);
    writeFileSync(join(directory, `zhejiang_${date}.metadata.json`), JSON.stringify({ contract: 'medclaw.snapshot/v1', mappingVersion: 'medclaw.snapshot/v1', materialVersion: 'ui-fixture/v1', generatorVersion: 'ui-fixture/v1', seed: 1, sourceBundleId: 'ui-fixture', sourceLockHash: lockHash, scopeKey: 'ui-scope', region: '浙江', cohortHash, snapshotDate: date, coverage: 'full', expectedEntityCount: masters.length, observedEntityCount: masters.length, declaredMissingEntityIds: [], fileSha256: hash(text), referenceDate: '2026-01-02', timezone: 'Asia/Shanghai' }));
  }
  const files = readdirSync(directory).sort().map(path => { const bytes = readFileSync(join(directory, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }; });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ status: 'complete', files, businessFiles: 2, businessRows: masters.length * 2, businessBytes: files.filter(file => /^zhejiang_.*\.csv$/.test(file.path)).reduce((sum, file) => sum + file.bytes, 0), totalPayloadBytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
}
test.beforeAll(async () => {
  test.setTimeout(90000);
  for (const part of ['main', 'preload']) execFileSync(bun, ['build', `apps/desktop/src/${part}/index.ts`, '--target=node', '--format=cjs', '--external=electron', `--outfile=.build/desktop/${part}/index.cjs`], { cwd: root });
  execFileSync(bun, ['build', 'apps/desktop/src/renderer/index.html', '--target=browser', '--outdir=.build/desktop/renderer'], { cwd: root });
  temporary = mkdtempSync(join(tmpdir(), 'medclaw-p3-ui-')); snapshotPackage(join(temporary, 'source'));
  const counts = new Map<string, number>();
  server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body), text = JSON.stringify(payload.messages.filter((message: { role: string }) => message.role === 'user').at(-1)?.content ?? ''), count = counts.get(text) ?? 0;
    providerUserTexts.push(text);
    if (dateQueryGate && text.includes('Hold date query scope')) { dateQueryGate.markEntered(); await dateQueryGate.reply; }
    counts.set(text, count + 1); response.writeHead(200, { 'content-type': 'text/event-stream' });
    const tool = count === 0 && text.includes('Query fixture data') ? { id: 'ui-query-call', name: 'query_current_devices', arguments: { batchIds: [1, 2], snapshotMode: 'exact_date' } }
      : count === 0 && text.includes('Write fixture file') ? { id: 'ui-write-call', name: 'write', arguments: { path: 'ui-result.txt', content: 'Actual Pi write from the UI fixture' } } : null;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content: 'P3 saved reply' };
    response.write(`data: ${JSON.stringify({ id: 'ui-response', model: payload.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'ui-response', model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture server port');
  const require = createRequire(join(root, 'apps/desktop/package.json')), electronPath: string = require('electron');
  const playwright = createRequire(createRequire(import.meta.url).resolve('@playwright/test/package.json')), core = createRequire(playwright.resolve('playwright/package.json')).resolve('playwright-core/package.json');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])), MEDCLAW_HOST_ENTRY: join(root, 'apps/host/src/main.ts'), MEDCLAW_BUN_EXECUTABLE: execFileSync(bun, ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).trim() };
  delete env.ELECTRON_RUN_AS_NODE;
  const delayedImport = join(temporary, 'delayed-import.cjs');
  // Lose one commit reply and keep its original operation ready until the UI reads it again.
  writeFileSync(delayedImport, `
    const { ipcMain } = require('electron');
    const handle = ipcMain.handle.bind(ipcMain);
    const state = globalThis.__p3DelayedImport = { enabled: false, pending: null, operationRef: null, commits: 0, reads: 0, catalogDelayMs: 0, catalogDefaultsUnknown: false, toolProjection: null, toolRunId: null };
    ipcMain.handle = (channel, listener) => handle(channel, async (event, envelope) => {
      if (channel !== 'medclaw:request') return listener(event, envelope);
      // UI fixtures change public projections only; original execution and saved facts remain intact.
      if (state.toolProjection && envelope.payload.runId === state.toolRunId && ['tool.read', 'run.read'].includes(envelope.method)) {
        const result = await listener(event, envelope);
        if (!result.ok) return result;
        if (envelope.method === 'run.read') return state.toolProjection === 'legacy' && result.data.kind === 'one'
          ? { ...result, data: { ...result.data, run: { ...result.data.run, control: null, cleanup: { ...result.data.run.cleanup, budgetSummary: null } } } }
          : result;
        return { ...result, data: { ...result.data, items: result.data.items.map(call => state.toolProjection === 'postflight-failure'
          ? { ...call, sdkResultIsError: true, control: { ...call.control, postflightStatus: 'failed', hookFailure: { stage: 'afterToolCall', code: 'tool_postprocess_failed' } } }
          : { ...call, sdkReturned: false, sdkResultIsError: null, nativeEntryId: null, ...(state.toolProjection === 'legacy' ? { control: null } : {}) }) } };
      }
      if (envelope.method === 'data.read') {
        const result = await listener(event, envelope);
        if (state.catalogDelayMs) await new Promise(resolve => setTimeout(resolve, state.catalogDelayMs));
        return state.catalogDefaultsUnknown && result.ok ? { ...result, data: { ...result.data, referenceDate: null, timezone: null } } : result;
      }
      if (envelope.method === 'import.commit') state.commits++;
      if (state.enabled && envelope.method === 'import.commit') {
        state.enabled = false;
        state.operationRef = envelope.payload.operationRef;
        state.pending = () => listener(event, envelope);
        return { ok: false, error: { ...${JSON.stringify(safeError('operation_result_unknown'))}, operationRef: state.operationRef } };
      }
      if (state.pending && envelope.method === 'import.read' && envelope.payload.operationRef === state.operationRef) {
        state.reads++;
        if (state.reads === 2) {
          const commit = state.pending;
          state.pending = null;
          void commit();
        }
      }
      return listener(event, envelope);
    });
  `);
  app = await electron.launch({ executablePath: electronPath, args: ['-r', join(dirname(core), 'lib/server/electron/loader.js'), '-r', delayedImport, join(root, '.build/desktop/main/index.cjs'), '--medclaw-data-root', join(temporary, 'data')], env, timeout: 30000 });
  page = await app.firstWindow(); await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, join(temporary, 'source'));
  const configured = await page.evaluate(async baseUrl => {
    const directory = await window.medclaw.request('model.read', {}); if (!directory.ok) throw new Error(directory.error.code);
    const input = await window.medclaw.secretInput({ providerId: 'p3-ui', purpose: 'custom_api_key', value: 'P3-UI-LOCAL-FIXTURE' }); if (!input.ok) throw new Error(input.error.code);
    const saved = await window.medclaw.request('model.custom.save', { expectedConfigVersion: directory.data.configVersion, credentialInput: input.data.token, definition: { providerId: 'p3-ui', name: 'P3 UI fixture', api: 'openai-completions', baseUrl, models: [{ id: 'fixture', name: 'P3 fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] } });
    if (!saved.ok) throw new Error(saved.error.code);
    return window.medclaw.request('model.configure', { provider: 'p3-ui', modelId: 'fixture', expectedConfigVersion: saved.data.configVersion });
  }, `http://127.0.0.1:${address.port}/v1`);
  expect(configured.ok).toBe(true);
});
test.afterAll(async () => {
  dateQueryGate?.release();
  await app?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (temporary) { const path = resolve(temporary), inside = relative(resolve(tmpdir()), path); if (inside && !inside.startsWith('..') && !inside.includes(':')) rmSync(path, { recursive: true, force: true }); }
});

test('P3 Settings publishes configurable Agent budgets with the existing policy version', async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Tool call budget', { exact: true })).toHaveValue('24');
  await expect(page.getByLabel('Model call budget', { exact: true })).toHaveValue('12');
  await page.getByLabel('Run timeout (milliseconds)', { exact: true }).fill('600000');
  await page.getByLabel('Tool call budget', { exact: true }).fill('80');
  await page.getByLabel('Model call budget', { exact: true }).fill('40');
  await page.getByLabel('Tool timeout (milliseconds)', { exact: true }).fill('100000');
  await page.getByLabel('Recovery round budget', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Publish request policy', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Request policy published; applies to the next run' })).toBeVisible();
  const changed = await page.evaluate(() => window.medclaw.request('model.config.read', {}));
  if (!changed.ok) throw new Error(changed.error.code);
  expect(changed.data.policy.timeoutMs).toBe(600000);
  expect(changed.data.agentPolicy).toMatchObject({ maxToolCalls: 80, maxModelCalls: 40, singleToolTimeoutMs: 100000, maxRecoveryAttempts: 0 });
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Tool call budget', { exact: true })).toHaveValue('80');
  await page.getByLabel('Run timeout (milliseconds)', { exact: true }).fill('120000');
  await page.getByLabel('Tool call budget', { exact: true }).fill('24');
  await page.getByLabel('Model call budget', { exact: true }).fill('12');
  await page.getByLabel('Tool timeout (milliseconds)', { exact: true }).fill('30000');
  await page.getByLabel('Recovery round budget', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Publish request policy', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Request policy published; applies to the next run' })).toBeVisible();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
});
test('P3 imports the authorized directory, applies batches and preserves the chat draft', async () => {
  await page.getByRole('button', { name: 'New Session', exact: true }).click(); await expect(page.getByTestId('current-session')).toContainText('New Session 1');
  await page.getByLabel('Message text', { exact: true }).fill('Draft survives data selection');
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Choose snapshot directory', exact: true }).click(); await expect(page.getByTestId('import-state')).toHaveText('ready');
  await expect(page.getByText('2 batches', { exact: false }).first()).toBeVisible();
  const originalOperation = await page.getByLabel('Import operation ID', { exact: true }).inputValue();
  await app.evaluate(() => { (globalThis as typeof globalThis & { __p3DelayedImport: { enabled: boolean } }).__p3DelayedImport.enabled = true; });
  await page.getByRole('button', { name: 'Confirm import', exact: true }).click(); await expect(page.getByTestId('import-state')).toHaveText('imported');
  await expect(page.getByLabel('Import operation ID', { exact: true })).toHaveValue(originalOperation);
  await expect(page.getByRole('alert').filter({ hasText: 'The original operation result is unconfirmed' })).toHaveCount(0);
  const delayed = await app.evaluate(() => {
    const state = (globalThis as typeof globalThis & { __p3DelayedImport: { commits: number; reads: number; operationRef: string } }).__p3DelayedImport;
    return { commits: state.commits, reads: state.reads, operationRef: state.operationRef };
  });
  expect(delayed.commits).toBe(1); expect(delayed.reads).toBe(2); expect(delayed.operationRef).toBe(originalOperation);
  await expect(page.getByTestId('import-result')).toContainText('110 accepted rows');
  await page.getByRole('button', { name: 'Read batch 2 devices', exact: true }).click(); await expect(page.getByTestId('data-rows')).toContainText('80 CNY cents');
  await page.getByRole('button', { name: 'Read batch 2 changes', exact: true }).click(); await expect(page.getByTestId('data-rows')).toContainText('Ratio: -0.2');
  await page.getByRole('button', { name: 'Select batches on this page', exact: true }).click(); await page.getByRole('button', { name: 'Apply 2 selected batches', exact: true }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); await expect(page.getByLabel('Message text', { exact: true })).toHaveValue('Draft survives data selection');
  await expect(page.getByText('Data for next message · 2 batches', { exact: true })).toBeVisible();
});
test('P3 actual business tool creates a saved query with inspectable source evidence', async () => {
  await app.evaluate(() => { (globalThis as typeof globalThis & { __p3DelayedImport: { catalogDelayMs: number } }).__p3DelayedImport.catalogDelayMs = 500; });
  await page.reload();
  await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('current-session')).toContainText('New Session 1');
  await expect(page.getByLabel('Reference date', { exact: true })).toHaveValue('2026-01-02');
  await expect(page.getByLabel('Time zone', { exact: true })).toHaveValue('Asia/Shanghai');
  await app.evaluate(() => { (globalThis as typeof globalThis & { __p3DelayedImport: { catalogDelayMs: number } }).__p3DelayedImport.catalogDelayMs = 0; });
  await page.locator('.reference-fields summary').click();
  await expect(page.getByTestId('data-time-defaults')).toContainText('2026-01-02');
  await page.getByRole('button', { name: 'Use data defaults', exact: true }).click();
  await expect(page.getByLabel('Reference date', { exact: true })).toHaveValue('2026-01-02');
  await expect(page.getByLabel('Time zone', { exact: true })).toHaveValue('Asia/Shanghai');
  await page.getByLabel('Reference date', { exact: true }).fill('2026-01-01');
  await page.locator('.reference-fields').screenshot({ path: test.info().outputPath('p3-reference-date-override.png') });
  await page.getByLabel('Message text', { exact: true }).fill('Query fixture data'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('run-output')).toHaveText('P3 saved reply'); await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  const savedRun = await page.evaluate(() => window.medclaw.request('run.read', { recent: true, sessionId: 1, limit: 1 }));
  if (!savedRun.ok || savedRun.data.kind !== 'recent' || !savedRun.data.runs[0]) throw new Error('Missing saved date-override run');
  expect(savedRun.data.runs[0].referenceDate).toBe('2026-01-01');
  expect(savedRun.data.runs[0].timezone).toBe('Asia/Shanghai');
  const queryTools = await page.evaluate(runId => window.medclaw.request('tool.read', { runId }), savedRun.data.runs[0].id);
  if (!queryTools.ok || !queryTools.data.items.some(call => call.name === 'query_current_devices' && call.status === 'succeeded')) throw new Error(`Missing executed fixture query: ${JSON.stringify({ calls: queryTools.ok ? queryTools.data.items.map(call => ({ name: call.name, status: call.status, error: call.error?.code })) : queryTools.error.code, fixtureUser: providerUserTexts.at(-1)?.slice(0, 180) })}`);
  await page.getByLabel('Reference date', { exact: true }).fill('2026-01-02');
  const frozenRun = await page.evaluate(runId => window.medclaw.request('run.read', { runId }), savedRun.data.runs[0].id);
  if (!frozenRun.ok || frozenRun.data.kind !== 'one' || !frozenRun.data.run) throw new Error('Missing original frozen run');
  expect(frozenRun.data.run.referenceDate).toBe('2026-01-01');
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  await expect(page.getByTestId('current-session')).toContainText('New Session 2');
  await expect(page.getByLabel('Reference date', { exact: true })).toHaveValue('2026-01-02');
  await expect(page.getByLabel('Time zone', { exact: true })).toHaveValue('Asia/Shanghai');
  await page.getByRole('button', { name: 'New Session 1', exact: true }).click();
  await expect(page.getByLabel('Reference date', { exact: true })).toHaveValue('2026-01-02');
  await page.getByRole('button', { name: 'Query History', exact: true }).click();
  await page.getByRole('button', { name: /Read Query 1/ }).click(); await expect(page.getByTestId('query-results')).toContainText('UI fixture device');
  await expect(page.getByTestId('query-results')).toContainText('100');
  const interpretation = page.getByLabel('Saved query result', { exact: true });
  await expect(interpretation.getByTestId('query-requested-date')).toHaveText('2026-01-01');
  await expect(interpretation.getByTestId('query-data-dates')).toHaveText('2026-01-01');
  await expect(interpretation.getByTestId('query-interpretation')).toContainText('2026-01-01');
  await page.getByRole('button', { name: 'Read evidence 1', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Evidence 1', exact: true })).toBeVisible();
  await expect(page.getByLabel('Query evidence')).toContainText('synthetic'); await expect(page.getByLabel('Query evidence')).toContainText('original.csv');
  await expect(page.getByRole('button', { name: 'Run query', exact: true })).toBeDisabled();
  await app.evaluate(() => { (globalThis as typeof globalThis & { __p3DelayedImport: { catalogDefaultsUnknown: boolean } }).__p3DelayedImport.catalogDefaultsUnknown = true; });
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh imported data', exact: true }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByTestId('data-time-defaults-missing')).toBeVisible();
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  await expect(page.getByTestId('current-session')).toContainText('New Session 3');
  await expect(page.getByLabel('Reference date', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Time zone', { exact: true })).toHaveValue('');
  await page.getByLabel('Message text', { exact: true }).fill('Needs an explicit time context');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Enter a reference date');
  await page.getByLabel('Reference date', { exact: true }).fill('2026-01-02');
  await expect(page.getByRole('status')).toContainText('Enter a time zone');
  await page.getByLabel('Time zone', { exact: true }).fill('Asia/Shanghai');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'New Session 1', exact: true }).click();
  await expect(page.getByLabel('Reference date', { exact: true })).toHaveValue('2026-01-02');
  await app.evaluate(() => { (globalThis as typeof globalThis & { __p3DelayedImport: { catalogDefaultsUnknown: boolean } }).__p3DelayedImport.catalogDefaultsUnknown = false; });
  await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh imported data', exact: true }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByTestId('data-time-defaults')).toBeVisible();
});
test('P3 actual native write has separate execution, SDK delivery and model-consumption facts', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); await page.getByLabel('Message text', { exact: true }).fill('Write fixture file'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  const run = await page.evaluate(() => window.medclaw.request('run.read', { recent: true, sessionId: 1, limit: 1 }));
  if (!run.ok || run.data.kind !== 'recent' || !run.data.runs[0]) throw new Error('Missing saved run');
  nativeRunId = run.data.runs[0].id;
  expect(readFileSync(join(temporary, 'data/runtime', String(run.data.runs[0].id), 'work/scratch/ui-result.txt'), 'utf8')).toBe('Actual Pi write from the UI fixture');
  await page.getByRole('button', { name: 'View run details', exact: true }).click(); await page.getByRole('tab', { name: 'Run details', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Run details', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tool-call-details')).toBeVisible();
  await expect(page.getByTestId('tool-call-details')).toContainText('write');
  await expect(page.getByTestId('tool-call-details')).toContainText('SDK result saved');
  await expect(page.getByTestId('tool-call-details')).toContainText('Included in model call');
  await expect(page.getByTestId('run-agent-policy')).toContainText('24');
  await expect(page.getByTestId('run-agent-policy')).toContainText('12');
  await expect(page.getByTestId('run-tool-profile')).toContainText('Insufficient samples');
  await expect(page.getByTestId('run-budget-summary')).toContainText('1 tool attempts');
  await expect(page.getByTestId('tool-call-details')).toContainText('Original execution');
  await expect(page.getByTestId('tool-call-details')).toContainText('After-tool hook');
  await expect(page.getByTestId('tool-call-details')).toContainText('passed');
  await expect(page.getByTestId('tool-call-details')).toContainText('Latency observation');
  await page.getByTestId('tool-call-details').scrollIntoViewIfNeeded(); await page.screenshot({ path: test.info().outputPath('p3-tool-details.png') });
});

test('P3 query dates and quantities remain explicit across stale snapshots, result pages and evidence pages', async () => {
  let markEntered!: () => void, release!: () => void;
  dateQueryGate = { entered: new Promise<void>(resolve => { markEntered = resolve; }), reply: new Promise<void>(resolve => { release = resolve; }), markEntered: () => markEntered(), release: () => release() };
  try {
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByLabel('Message text', { exact: true }).fill('Hold date query scope'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await dateQueryGate.entered;
    await page.getByRole('button', { name: 'Query History', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run query', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Start date', { exact: true })).toHaveCount(0);
    await page.getByLabel('On date', { exact: true }).fill('2026-01-01');
    await page.getByRole('button', { name: 'Run query', exact: true }).click();
    const result = page.getByLabel('Saved query result', { exact: true });
    await expect(result.getByTestId('query-requested-date')).toHaveText('2026-01-01');
    await expect(result.getByTestId('query-data-dates')).toHaveText('2026-01-01');
    await expect(result.getByTestId('query-snapshot-selection')).toHaveText('Exact date');
    await expect(result.getByTestId('query-quantity')).toHaveText('55 records');
    await expect(result.getByTestId('query-interpretation')).toContainText('Snapshot records');
    await expect(result.getByTestId('query-interpretation')).toContainText('All statuses');
    await page.getByRole('button', { name: 'Next result page', exact: true }).click();
    await expect(result.getByTestId('query-results').getByRole('row')).toHaveCount(6);
    await expect(result.getByTestId('query-quantity')).toHaveText('55 records');
    await result.getByRole('button', { name: /Read evidence \d+/, exact: false }).first().click();
    const evidence = page.getByLabel('Query evidence', { exact: true });
    await expect(evidence.getByTestId('query-quantity')).toHaveText('55 records');
    await evidence.getByRole('button', { name: 'Next evidence page', exact: true }).click();
    await expect(evidence.getByRole('row')).toHaveCount(6);
    await expect(evidence.getByTestId('query-quantity')).toHaveText('55 records');
    await expect(evidence).toContainText('Showing 5 evidence snapshots');
    await page.getByLabel('On date', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Run query', exact: true }).click();
    await expect(result.getByTestId('query-requested-date')).toHaveText('2026-01-02');
    await expect(result.getByTestId('query-data-dates')).toHaveText('2026-01-02');
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('active');
    await page.getByRole('button', { name: 'Run query', exact: true }).click();
    await expect(result.getByTestId('query-quantity')).toHaveText('54 records');
    await expect(result.getByTestId('query-interpretation')).toContainText('active');
    await page.getByRole('combobox', { name: 'Snapshot mode', exact: true }).selectOption('as_of');
    await page.getByLabel('As of date', { exact: true }).fill('2026-01-03');
    await page.getByRole('button', { name: 'Run query', exact: true }).click();
    await expect(result.getByTestId('query-requested-date')).toHaveText('2026-01-03');
    await expect(result.getByTestId('query-data-dates')).toHaveText('2026-01-02');
    await expect(result.getByTestId('query-quantity')).toHaveText('54 records');
    await expect(result.getByTestId('query-snapshot-selection')).toHaveText('Latest on or before requested date');
    await expect(result.getByRole('status')).toContainText('Some selected data scopes use earlier snapshots');
    await expect(result.getByRole('status')).toContainText('The complete quantity for the requested date is unknown');
    await expect(result).not.toContainText('as_of_freshness:');
    await page.getByRole('button', { name: 'Close run details', exact: true }).click();
    await result.getByTestId('query-interpretation').scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('p3-query-date-quantity.png') });
    await page.getByRole('combobox', { name: 'Snapshot mode', exact: true }).selectOption('exact_date');
    await page.getByRole('button', { name: 'Run query', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Required dates or predecessor batches are missing' })).toBeVisible();
    await expect(result.getByTestId('query-quantity')).toHaveText('54 records');
    await page.getByRole('combobox', { name: 'Query kind', exact: true }).selectOption('trend');
    await expect(result.getByTestId('query-snapshot-selection')).toHaveText('Latest on or before requested date');
    await expect(page.getByLabel('Start date', { exact: true })).toBeVisible();
    await expect(page.getByLabel('End date (exclusive)', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Query kind', exact: true }).selectOption('changes');
    await expect(page.getByLabel('Start date', { exact: true })).toBeVisible();
    await expect(page.getByLabel('End date (exclusive)', { exact: true })).toBeVisible();
  } finally { dateQueryGate.release(); dateQueryGate = null; }
});

test('P3 active and saved Runs retain frozen budgets while Settings changes apply to the next Run', async () => {
  test.setTimeout(60000);
  let markEntered!: () => void, release!: () => void;
  dateQueryGate = { entered: new Promise<void>(resolve => { markEntered = resolve; }), reply: new Promise<void>(resolve => { release = resolve; }), markEntered: () => markEntered(), release: () => release() };
  try {
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByLabel('Message text', { exact: true }).fill('Hold date query scope for budget publication');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await dateQueryGate.entered;
    const active = await page.evaluate(() => window.medclaw.request('run.active', {}));
    if (!active.ok || !active.data) throw new Error('Missing active fixture Run');
    const runId = active.data.runId;
    await page.getByRole('button', { name: 'View run details', exact: true }).click();
    await page.getByRole('tab', { name: 'Run details', exact: true }).click();
    await expect(page.getByTestId('run-agent-policy')).toContainText('24');
    await expect(page.getByTestId('run-budget-summary')).toContainText('1 used');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Tool call budget', { exact: true }).fill('80');
    await page.getByRole('button', { name: 'Publish request policy', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Request policy published; applies to the next run' })).toBeVisible();
    await expect(page.getByTestId('run-agent-policy')).toContainText('24');
    const frozen = await page.evaluate(id => window.medclaw.request('run.read', { runId: id }), runId);
    if (!frozen.ok || frozen.data.kind !== 'one' || frozen.data.run?.kind !== 'agent') throw new Error('Missing active frozen Run');
    expect(frozen.data.run.control?.agentPolicy?.maxToolCalls).toBe(24);
    dateQueryGate.release();
    await expect.poll(async () => {
      const result = await page.evaluate(() => window.medclaw.request('run.control.read', {}));
      return result.ok && result.data.acceptingNewRuns;
    }).toBe(true);
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByLabel('Message text', { exact: true }).fill('New Run after budget publication');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByTestId('run-output')).toHaveText('P3 saved reply');
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByTestId('run-agent-policy')).toContainText('80');
    const original = await page.evaluate(id => window.medclaw.request('run.read', { runId: id }), runId);
    if (!original.ok || original.data.kind !== 'one' || original.data.run?.kind !== 'agent') throw new Error('Missing saved frozen Run');
    expect(original.data.run.control?.agentPolicy?.maxToolCalls).toBe(24);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Tool call budget', { exact: true }).fill('24');
    await page.getByRole('button', { name: 'Publish request policy', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Request policy published; applies to the next run' })).toBeVisible();
  } finally { dateQueryGate.release(); dateQueryGate = null; }
});

test('P3 Run Details distinguishes after-tool failures, unconfirmed consumption and legacy projections', async () => {
  const modelRequests = providerUserTexts.length;
  const project = (mode: string | null) => app.evaluate((_, { mode, runId }) => {
    const state = (globalThis as typeof globalThis & { __p3DelayedImport: { toolProjection: string | null; toolRunId: number } }).__p3DelayedImport;
    state.toolProjection = mode;
    state.toolRunId = runId;
  }, { mode, runId: nativeRunId });
  const details = page.getByTestId('tool-call-details');
  try {
    await project('postflight-failure');
    if (!await page.getByRole('button', { name: 'Close run details', exact: true }).isVisible()) await page.getByRole('button', { name: 'View run details', exact: true }).click();
    await page.getByRole('tab', { name: 'Run details', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh recent runs', exact: true }).click();
    await page.getByRole('button', { name: `View Run ${nativeRunId}`, exact: true }).click();
    await expect(details.locator('dt:has-text("Original execution") + dd')).toHaveText('succeeded');
    await expect(details.locator('dt:has-text("After-tool hook") + dd')).toHaveText('failed');
    await expect(details.locator('dt:has-text("SDK result status") + dd')).toHaveText('Error result delivered');
    await expect(details.locator('dt:has-text("Model consumption") + dd')).toContainText('Included in model call');
    await project('undelivered');
    await page.getByRole('button', { name: 'Refresh tools', exact: true }).click();
    await expect(details.locator('dt:has-text("SDK result status") + dd')).toHaveText('Not delivered');
    await expect(details.locator('dt:has-text("Model consumption") + dd')).toHaveText('No later model call confirmed');
    await expect(details.locator('dt:has-text("Consumption observed") + dd')).toHaveText('Not recorded');
    await project('legacy');
    await page.getByRole('button', { name: 'Read this run again', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh tools', exact: true }).click();
    await expect(page.getByTestId('run-agent-policy')).toContainText('Unknown');
    await expect(page.getByTestId('run-budget-summary')).toContainText('Unknown');
    await expect(page.getByTestId('run-tool-profile')).toContainText('Unknown');
    await expect(details).toContainText('No control observation was saved');
    expect(providerUserTexts.length).toBe(modelRequests);
  } finally { await project(null).catch(() => {}); }
});
