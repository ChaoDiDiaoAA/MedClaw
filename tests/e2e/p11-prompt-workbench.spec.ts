import { expect, test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

let server: ReturnType<typeof createServer>, url: string, app: ElectronApplication;
const test = base.extend<{ page: Page }>({ page: async ({}, use) => use(await app.firstWindow()) });
test.beforeAll(async () => {
  const directory = resolve('.build/p11-prompt-workbench'); mkdirSync(directory, { recursive: true });
  const require = createRequire(resolve('apps/desktop/package.json')), entry = join(directory, 'fixture.ts'), bundle = join(directory, 'fixture.js');
  writeFileSync(entry, `import React from ${JSON.stringify(require.resolve('react'))};import{flushSync}from ${JSON.stringify(require.resolve('react-dom'))};import{createRoot}from ${JSON.stringify(require.resolve('react-dom/client'))};import{PromptWorkbench}from ${JSON.stringify(resolve('apps/desktop/src/renderer/prompt-workbench.tsx'))};
    const root=createRoot(document.getElementById('root'));globalThis.__pending=[];globalThis.__listeners=new Set();globalThis.__used=[];globalThis.__copied=[];globalThis.__accepted=0;
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>globalThis.__copied.push(text)}});
    globalThis.__control={instanceId:'HostA',activeRootRun:null,acceptingNewRuns:true,blockReasons:[]};
    window.medclaw={request:(method,input,operationRef)=>{if(method==='run.control.read')return Promise.resolve({ok:true,data:globalThis.__control});return new Promise((resolve,reject)=>globalThis.__pending.push({method,input,operationRef,resolve,reject,done:false}));},subscribe:listener=>{globalThis.__listeners.add(listener);return()=>globalThis.__listeners.delete(listener);}};
    globalThis.__props={host:{state:'ready',instanceId:'HostA'},directory:{configVersion:'7',selection:{provider:'test-provider',modelId:'model-1'},models:[],providers:[]},directoryCurrent:true,control:globalThis.__control,visible:true,canUseInChat:true,onUseInChat:text=>{globalThis.__used.push(text);return true;},onAccepted:()=>globalThis.__accepted++};
    globalThis.__render=(patch={})=>{globalThis.__props={...globalThis.__props,...patch};if(patch.control)globalThis.__control=patch.control;flushSync(()=>root.render(React.createElement(PromptWorkbench,globalThis.__props)));};
    globalThis.__emit=notice=>globalThis.__listeners.forEach(listener=>listener(notice));globalThis.__render();`);
  execFileSync('bun', ['build', entry, '--target=browser', `--outfile=${bundle}`], { cwd: resolve('.'), stdio: 'pipe' });
  server = createServer((request, response) => { response.setHeader('content-type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html'); response.end(request.url === '/fixture.js' ? readFileSync(bundle) : '<main id="root"></main><script type="module" src="/fixture.js"></script>'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const main = join(directory, 'browser.cjs'); writeFileSync(main, `const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});win.loadURL(${JSON.stringify(url)});});`);
  const env = Object.fromEntries(Object.entries(process.env).filter((value): value is [string, string] => value[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [main], env });
});
test.afterAll(async () => { await app?.close(); if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } });

type Pending = { method: string; input: Record<string, unknown>; operationRef?: string; done: boolean };
const requests = (page: Page, method: string): Promise<Pick<Pending, 'input' | 'operationRef' | 'done'>[]> => page.evaluate(method => Reflect.get(globalThis, '__pending').filter((item: Pending) => item.method === method).map(({ input, operationRef, done }: Pending) => ({ input, operationRef, done })), method);
async function respond(page: Page, method: string, data: unknown, ok = true) {
  await expect.poll(async () => (await requests(page, method)).filter(item => !item.done).length).toBeGreaterThan(0);
  await page.evaluate(({ method, data, ok }) => { const item = Reflect.get(globalThis, '__pending').find((item: Pending) => item.method === method && !item.done); item.done = true; item.resolve(ok ? { ok, data } : { ok, error: data }); }, { method, data, ok });
}
const render = (page: Page, patch: unknown) => page.evaluate(patch => Reflect.get(globalThis, '__render')(patch), patch);
const emit = (page: Page, notice: unknown) => page.evaluate(notice => Reflect.get(globalThis, '__emit')(notice), notice);
const failure = (code: string) => ({ code, category: 'runtime', retryable: false, message: code });
function saved(operationRef: string, options: { id?: number; instanceId?: string; status?: string; text?: string; offset?: number; total?: number; next?: number | null; cleanupComplete?: boolean } = {}) {
  const text = options.text ?? '', offset = options.offset ?? 0;
  const terminal = ['completed', 'failed', 'cancelled'].includes(options.status ?? 'running'), complete = options.cleanupComplete ?? terminal;
  return { kind: 'one', run: { id: options.id ?? 41, kind: 'provider', instanceId: options.instanceId ?? 'HostA', operationRef, status: options.status ?? 'running', persistence: 'committed', error: null,
    cleanup: terminal ? { contract: 'medclaw.run-cleanup/v1', executionStarted: true, stopConfirmed: true, requiredPersistenceComplete: complete, inputsSettled: true, resourcesReleased: true, unconfirmedItems: complete ? [] : ['persistence'], secondaryErrors: [], verifiedAt: complete ? '2026-10-21T00:00:00.000Z' : null } : null,
    output: { text, offset, totalChars: options.total ?? text.length, nextOffset: options.next ?? null } } };
}
async function begin(page: Page, text = '请优化我的查询提示，保持原有条件。') {
  await page.getByLabel('Original prompt', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Optimize', exact: true }).click();
  await expect.poll(async () => (await requests(page, 'model.request')).length).toBe(1);
  return (await requests(page, 'model.request'))[0]!.operationRef!;
}

test('p11 workbench uses one published Provider request and copies/uses only the complete editable result across navigation', async ({ page }) => {
  await page.goto(url); await page.getByLabel('Requirements (optional)', { exact: true }).fill('Keep identifiers and evidence requirements.');
  const operationRef = await begin(page), request = (await requests(page, 'model.request'))[0]!;
  expect(request.input.model).toEqual({ provider: 'test-provider', modelId: 'model-1', expectedConfigVersion: '7' });
  expect(Object.keys(request.input).sort()).toEqual(['model', 'referenceDate', 'text', 'timezone']);
  expect(request.input.text).toContain('保持原有条件'); expect(request.input.text).toContain('Keep identifiers'); expect(request.input.text).toContain('language');
  await respond(page, 'model.request', { runId: 41, operationRef, reused: false });
  await respond(page, 'run.read', saved(operationRef));
  await emit(page, { type: 'provider.preview', instanceId: 'HostA', runId: 41, text: 'preview only', truncated: true });
  await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled();
  await emit(page, { type: 'provider.settled', instanceId: 'HostA', runId: 41 });
  await respond(page, 'run.read', saved(operationRef, { status: 'completed', text: 'first\n', total: 12, next: 6 }));
  await expect.poll(async () => (await requests(page, 'run.read')).at(-1)?.input.outputOffset).toBe(6);
  await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('');
  await respond(page, 'run.read', saved(operationRef, { status: 'completed', text: 'second', offset: 6, total: 12 }));
  await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('first\nsecond');
  await page.getByLabel('Optimized prompt', { exact: true }).fill('Edited complete result');
  await render(page, { visible: false }); await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toBeHidden();
  await render(page, { visible: true }); await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Edited complete result');
  await page.getByRole('button', { name: 'Copy', exact: true }).click(); await page.getByRole('button', { name: 'Use in chat', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(globalThis, '__copied'))).toEqual(['Edited complete result']);
  expect(await page.evaluate(() => Reflect.get(globalThis, '__used'))).toEqual(['Edited complete result']);
  expect((await requests(page, 'model.request')).length).toBe(1);
  for (const method of ['session.submit', 'session.create', 'query.current', 'resources.read']) expect(await requests(page, method)).toEqual([]);
  await emit(page, { type: 'provider.preview', instanceId: 'HostA', runId: 41, text: 'late replacement', truncated: false });
  await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Edited complete result');
});

test('p11 Stop before acceptance resolves the original operation and keeps the prior draft on cancellation', async ({ page }) => {
  await page.goto(url); await page.getByLabel('Optimized prompt', { exact: true }).fill('Previous draft');
  const operationRef = await begin(page);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await respond(page, 'run.read', saved(operationRef));
  await expect.poll(async () => (await requests(page, 'run.cancel'))[0]?.input.runId).toBe(41);
  await respond(page, 'run.cancel', { runId: 41, cancelRequested: true, stopped: false, committedStatus: 'running', persistencePending: false });
  await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toBeDisabled();
  await respond(page, 'model.request', { runId: 41, operationRef, reused: false });
  await emit(page, { type: 'provider.settled', instanceId: 'HostA', runId: 41 });
  await respond(page, 'run.read', saved(operationRef, { status: 'cancelled', text: 'Incomplete output' }));
  await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Previous draft');
  expect((await requests(page, 'model.request')).length).toBe(1);
});

test('p11 unknown acceptance and early completion recover by operation without resending or accepting another owner', async ({ page }) => {
  await page.goto(url); const operationRef = await begin(page);
  await emit(page, { type: 'provider.settled', instanceId: 'HostA', runId: 41 });
  await respond(page, 'run.read', saved(operationRef, { status: 'completed', text: 'Recovered complete output' }));
  await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Recovered complete output');
  await respond(page, 'model.request', failure('operation_result_unknown'), false);
  await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Recovered complete output');
  expect((await requests(page, 'model.request')).length).toBe(1);
});

test('p11 lost acceptance stays unresolved after an empty lookup and only the original operation can supply the result', async ({ page }) => {
  await page.goto(url); await page.getByLabel('Optimized prompt', { exact: true }).fill('Prior editable text');
  const operationRef = await begin(page);
  await respond(page, 'model.request', failure('operation_result_unknown'), false);
  await respond(page, 'run.read', { kind: 'one', run: null });
  await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Read original result', exact: true }).click();
  await respond(page, 'run.read', saved(operationRef, { status: 'completed', text: 'Recovered after lookup' }));
  await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Recovered after lookup');
  expect((await requests(page, 'model.request')).length).toBe(1);
});

test('p11 required saving retries storage only and preserves drafts until complete output is verified', async ({ page }) => {
  await page.goto(url); await page.getByLabel('Optimized prompt', { exact: true }).fill('Keep this draft');
  const operationRef = await begin(page); await respond(page, 'model.request', { runId: 41, operationRef, reused: false }); await respond(page, 'run.read', saved(operationRef));
  await emit(page, { type: 'provider.persistence_failed', instanceId: 'HostA', runId: 41, error: failure('persistence_failed') });
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await expect.poll(async () => (await requests(page, 'run.retrySave'))[0]?.input.runId).toBe(41);
  await respond(page, 'run.retrySave', saved(operationRef, { status: 'completed' }).run);
  await respond(page, 'run.read', saved(operationRef, { status: 'completed', text: 'Saved full output' }));
  await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Saved full output');
  expect((await requests(page, 'model.request')).length).toBe(1);
});

test('p11 a committed failed checkpoint with unfinished saving keeps its original operation and editable draft protected', async ({ page }) => {
  await page.goto(url); await page.getByLabel('Optimized prompt', { exact: true }).fill('Last complete draft');
  const operationRef = await begin(page);
  await respond(page, 'model.request', { runId: 41, operationRef, reused: false });
  await respond(page, 'run.read', saved(operationRef, { status: 'failed', cleanupComplete: false, text: 'Uncommitted final answer' }));
  await expect(page.getByRole('button', { name: 'Retry saving', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Last complete draft');
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await respond(page, 'run.retrySave', saved(operationRef, { status: 'failed' }).run);
  await respond(page, 'run.read', saved(operationRef, { status: 'failed' }));
  await expect(page.getByLabel('Optimized prompt', { exact: true })).not.toHaveAttribute('readonly');
  await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Last complete draft');
  expect((await requests(page, 'model.request')).length).toBe(1);
});

test('p11 Host changes reject old replies and recover the same original record', async ({ page }) => {
  await page.goto(url); await page.getByLabel('Optimized prompt', { exact: true }).fill('Retained edit'); const operationRef = await begin(page);
  await render(page, { host: { state: 'ready', instanceId: 'HostB' }, control: { instanceId: 'HostB', activeRootRun: null, acceptingNewRuns: true, blockReasons: [] } });
  await respond(page, 'model.request', { runId: 99, operationRef, reused: false });
  await emit(page, { type: 'provider.preview', instanceId: 'HostA', runId: 99, text: 'stale', truncated: false });
  await respond(page, 'run.read', saved('another-operation', { id: 99, status: 'completed', text: 'wrong owner' }));
  await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Retained edit');
  await page.getByRole('button', { name: 'Read original result', exact: true }).click();
  await respond(page, 'run.read', saved(operationRef, { status: 'failed', text: 'partial result' }));
  await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Retained edit');
  expect((await requests(page, 'model.request')).length).toBe(1);
});

test('p11 execution gates and Use in chat follow current confirmed eligibility', async ({ page }) => {
  await page.goto(url); await page.getByLabel('Original prompt', { exact: true }).fill('Original');
  await render(page, { executionBlockReason: 'Evaluation is active', canUseInChat: false, useInChatReason: 'Select a confirmed Session.' });
  await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toBeDisabled();
  await page.getByLabel('Optimized prompt', { exact: true }).fill('Hand-edited draft');
  await expect(page.getByRole('button', { name: 'Use in chat', exact: true })).toBeDisabled();
  await render(page, { executionBlockReason: null, directoryCurrent: false }); await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toBeDisabled();
  await render(page, { directoryCurrent: true, control: { instanceId: 'HostA', activeRootRun: { runId: 5 }, acceptingNewRuns: false, blockReasons: [] } });
  await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toBeDisabled();
  expect(await requests(page, 'model.request')).toEqual([]);
});
