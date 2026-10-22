import { expect, test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { DEFAULT_INTENT_MODEL } from '../../packages/contracts/src/model';
import { DEFAULT_AGENT_POLICY, DEFAULT_REQUEST_POLICY, RUNTIME_CONFIG } from '../../packages/contracts/src/runtime-config';
import { TOOL_CONFIG } from '../../packages/contracts/src/tool-config';
import type { PublicReturn } from '../../packages/contracts/src/protocol';

let server: ReturnType<typeof createServer>, url: string, app: ElectronApplication;
const test = base.extend<{ page: Page }>({ page: async ({}, use) => use(await app.firstWindow()) });
test.beforeAll(async () => {
  const directory = resolve('.build/p14-intent-renderer'); mkdirSync(directory, { recursive: true });
  const require = createRequire(resolve('apps/desktop/package.json')), entry = join(directory, 'fixture.ts'), bundle = join(directory, 'fixture.js');
  writeFileSync(entry, `import React from ${JSON.stringify(require.resolve('react'))};import{flushSync}from ${JSON.stringify(require.resolve('react-dom'))};import{createRoot}from ${JSON.stringify(require.resolve('react-dom/client'))};import{ModelsPage}from ${JSON.stringify(resolve('apps/desktop/src/renderer/models-page.tsx'))};
    const root=createRoot(document.getElementById('root'));globalThis.__pending=[];globalThis.__changed=0;
    window.medclaw={request:(method,input)=>method==='model.custom.read'?Promise.resolve({ok:true,data:{definitions:[]}}):new Promise(resolve=>globalThis.__pending.push({method,input,resolve,done:false}))};
    globalThis.__props={host:{state:'ready',instanceId:'HostA',canStart:false,sdkVersion:null,schemaVersion:null,error:null},directory:{configVersion:'1',selection:null,models:[],providers:[],customApis:[]},directoryCurrent:true,active:null,control:{instanceId:'HostA',acceptingNewRuns:true,activeRootRun:null,blockReasons:[]},sessionTarget:null,prompt:null,notification:null,attempt:null,onChanged:async()=>{globalThis.__changed++},onUseForSession:()=>{},onAccepted:async()=>{},onError:()=>{}};
    globalThis.__render=(patch={})=>{globalThis.__props={...globalThis.__props,...patch};flushSync(()=>root.render(React.createElement(ModelsPage,globalThis.__props)))};globalThis.__render();`);
  execFileSync('bun', ['build', entry, '--target=browser', `--outfile=${bundle}`], { cwd: resolve('.'), stdio: 'pipe' });
  server = createServer((request, response) => { response.setHeader('content-type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html'); response.end(request.url === '/fixture.js' ? readFileSync(bundle) : '<main id="root"></main><script type="module" src="/fixture.js"></script>'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const main = join(directory, 'browser.cjs'); writeFileSync(main, `const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});win.loadURL(${JSON.stringify(url)});});`);
  const env = Object.fromEntries(Object.entries(process.env).filter((value): value is [string, string] => value[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [main], env });
});
test.afterAll(async () => { await app?.close(); if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } });

type Pending = { method: string; input: Record<string, unknown>; done: boolean };
const requests = (page: Page, method: string): Promise<Pending[]> => page.evaluate(method => Reflect.get(globalThis, '__pending').filter((item: Pending) => item.method === method).map(({ method, input, done }: Pending) => ({ method, input, done })), method);
async function respond(page: Page, method: string, data: unknown, ok = true) {
  await expect.poll(async () => (await requests(page, method)).filter(item => !item.done).length).toBeGreaterThan(0);
  await page.evaluate(({ method, data, ok }) => { const item = Reflect.get(globalThis, '__pending').find((item: Pending) => item.method === method && !item.done); item.done = true; item.resolve(ok ? { ok, data } : { ok, error: data }); }, { method, data, ok });
}
const render = (page: Page, patch: unknown) => page.evaluate(patch => Reflect.get(globalThis, '__render')(patch), patch);
const directory = (configVersion: string) => ({ configVersion, selection: null, models: [], providers: [], customApis: [] });
function configuration(configVersion: string, baseUrl = 'http://127.0.0.1:11434'): PublicReturn<'model.config.read'> {
  return { configVersion, intentModel: { ...DEFAULT_INTENT_MODEL, baseUrl }, previousConfigVersion: null, rollbackFromVersion: null,
    policy: { ...DEFAULT_REQUEST_POLICY }, agentPolicy: { ...DEFAULT_AGENT_POLICY }, runtimeConfiguration: structuredClone(RUNTIME_CONFIG), toolConfiguration: { ...TOOL_CONFIG } };
}
async function ready(page: Page) {
  await page.goto(url);
  await page.getByRole('navigation', { name: 'Model tasks' }).getByRole('button', { name: 'Local routing', exact: true }).click();
  await respond(page, 'model.config.read', configuration('1'));
  await expect(page.getByLabel('Ollama URL', { exact: true })).toBeEnabled();
}

test('local model publication acknowledges a reply after config.changed without replacing the newer configuration', async ({ page }) => {
  await ready(page);
  await page.getByLabel('Ollama URL', { exact: true }).fill('http://127.0.0.1:23456');
  const apply = page.getByRole('button', { name: 'Apply configuration', exact: true });
  await apply.click(); await expect.poll(async () => (await requests(page, 'model.intent.configure')).length).toBe(1);
  await render(page, { directory: directory('3') });
  await respond(page, 'model.config.read', configuration('3', 'http://127.0.0.1:34567'));
  await expect(page.getByLabel('Ollama URL', { exact: true })).toHaveValue('http://127.0.0.1:34567');
  await expect(apply).toBeDisabled();
  await respond(page, 'model.intent.configure', { configVersion: '2', intentModel: configuration('2', 'http://127.0.0.1:23456').intentModel });
  await expect(page.getByText('Intent configuration applied.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Ollama URL', { exact: true })).toHaveValue('http://127.0.0.1:34567');
  await expect(apply).toBeDisabled();
  await respond(page, 'model.config.read', configuration('3', 'http://127.0.0.1:34567'));
  await expect(apply).toBeEnabled(); await apply.click();
  expect((await requests(page, 'model.intent.configure'))[1]?.input.expectedConfigVersion).toBe('3');
});

test('local model publication keeps writes disabled when its current configuration cannot be read back', async ({ page }) => {
  await ready(page);
  const apply = page.getByRole('button', { name: 'Apply configuration', exact: true });
  await apply.click();
  await respond(page, 'model.intent.configure', { configVersion: '2', intentModel: configuration('2').intentModel });
  await respond(page, 'model.config.read', { code: 'host_not_ready', category: 'runtime', retryable: false, message: 'Host unavailable' }, false);
  await expect(page.getByText('Intent configuration applied.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible(); await expect(apply).toBeDisabled();
  await render(page, { directory: directory('3') });
  await respond(page, 'model.config.read', configuration('3'));
  await expect(apply).toBeEnabled();
});

for (const action of ['Verify local model', 'Apply configuration'] as const) {
  test(`local model ignores an old Host ${action} reply`, async ({ page }) => {
    await ready(page);
    const method = action === 'Verify local model' ? 'model.intent.inspect' : 'model.intent.configure';
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect.poll(async () => (await requests(page, method)).length).toBe(1);
    await render(page, { host: { state: 'ready', instanceId: 'HostB', canStart: false, sdkVersion: null, schemaVersion: null, error: null }, directory: directory('7') });
    await respond(page, 'model.config.read', configuration('7', 'http://127.0.0.1:45678'));
    await expect(page.getByLabel('Ollama URL', { exact: true })).toBeEnabled();
    await respond(page, method, method === 'model.intent.configure' ? { configVersion: '2', intentModel: configuration('2').intentModel }
      : { contract: 'medclaw.intent-model-inspection/v1', checkedAt: '2026-10-22T00:00:00.000Z', available: true, metadata: null, error: null });
    await expect(page.getByLabel('Ollama URL', { exact: true })).toHaveValue('http://127.0.0.1:45678');
    await expect(page.getByText('Intent configuration applied.', { exact: true })).toBeHidden();
    await expect(page.getByText('Local model tag and protocol metadata verified.', { exact: true })).toBeHidden();
    expect(await page.evaluate(() => Reflect.get(globalThis, '__changed'))).toBe(0);
    await expect(page.getByRole('button', { name: 'Apply configuration', exact: true })).toBeEnabled();
  });
}
