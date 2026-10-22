import { expect, test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { getSkillReadiness, type ResourceItem } from '../../packages/contracts/src/resources';

let server: ReturnType<typeof createServer>, url: string, app: ElectronApplication;
const test = base.extend<{ page: Page }>({ page: async ({}, use) => use(await app.firstWindow()) });
test.beforeAll(async () => {
  const directory = resolve('.build/p11-skill-readiness'); mkdirSync(directory, { recursive: true });
  const require = createRequire(resolve('apps/desktop/package.json')), entry = join(directory, 'fixture.ts'), bundle = join(directory, 'fixture.js');
  writeFileSync(entry, `import React from ${JSON.stringify(require.resolve('react'))};import{createRoot}from ${JSON.stringify(require.resolve('react-dom/client'))};import{ResourcePanel}from ${JSON.stringify(resolve('apps/desktop/src/renderer/resource-panel.tsx'))};
    const root=createRoot(document.getElementById('root'));globalThis.__pending=[];globalThis.__published=0;
    window.medclaw={request:(method,input)=>new Promise((resolve,reject)=>globalThis.__pending.push({method,input,resolve,reject,done:false}))};
    globalThis.__render=(source={source:'selection',sessionId:1},instanceId='HostA')=>root.render(React.createElement(ResourcePanel,{host:{state:'ready',instanceId},source,kind:'skill',onPublished:()=>globalThis.__published++}));globalThis.__render();`);
  execFileSync('bun', ['build', entry, '--target=browser', `--outfile=${bundle}`], { cwd: resolve('.'), stdio: 'pipe' });
  server = createServer((request, response) => { response.setHeader('content-type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html'); response.end(request.url === '/fixture.js' ? readFileSync(bundle) : '<main id="root"></main><script type="module" src="/fixture.js"></script>'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const main = join(directory, 'browser.cjs'); writeFileSync(main, `const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}}).loadURL(${JSON.stringify(url)}));`);
  const env = Object.fromEntries(Object.entries(process.env).filter((value): value is [string, string] => value[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [main], env });
});
test.afterAll(async () => { await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
type Pending = { method: string; input: unknown; done: boolean };
const requests = (page: Page, method: string): Promise<Pending[]> => page.evaluate(method => Reflect.get(globalThis, '__pending').filter((item: Pending) => item.method === method).map(({ method, input, done }: Pending) => ({ method, input, done })), method);
async function reply(page: Page, method: string, value: unknown) {
  await expect.poll(async () => (await requests(page, method)).filter(item => !item.done).length).toBeGreaterThan(0);
  await page.evaluate(({ method, value }) => { const item = Reflect.get(globalThis, '__pending').find((item: Pending) => item.method === method && !item.done); item.done = true; item.resolve(value); }, { method, value });
}
const ref = (id: string) => ({ kind: 'skill' as const, id, version: 'v1' });
function item(id: string, tools: string[] | null = ['read', 'read_data_scope'], available: string[] | null = tools, enabled = true): ResourceItem {
  return { ref: ref(id), name: id, description: `ENGINEERING ${id} Skill description`, keywords: [id], enabled, availability: 'ready', disableModelInvocation: false,
    files: [{ file: 'SKILL.md', bytes: 10 }], requiredTools: tools, requiredExtensions: [], diagnostics: [], readiness: getSkillReadiness(tools, available, 'configuration') };
}
function list(items = [item('query'), item('partial', undefined, ['read']), item('unavailable', undefined, []), item('no-requirements', []),
  { ...item('broken'), availability: 'invalid' as const }, { ...item('legacy', null), readiness: undefined }, item('disabled', undefined, undefined, false)], configVersion = '1') {
  return { source: 'selection', sessionId: 1, configVersion, selection: { prompt: null, skills: items.filter(value => value.enabled).map(value => value.ref) }, items,
    diagnostics: [], catalogError: null, evidence: [], evidenceInfo: { page: 1, pageSize: 50, totalRows: 0, hasMore: false } };
}
const row = (page: Page, id: string) => page.getByTestId('resource-row').filter({ has: page.getByRole('button', { name: id, exact: true }) });

test('p11 Skill filters distinguish readiness, enablement and invalid resources without changing capabilities', async ({ page }) => {
  await page.goto(url); await reply(page, 'resources.list', { ok: true, data: list() });
  await expect(page.getByRole('group', { name: 'Skill status' })).toBeVisible();
  await expect(page.getByTestId('resource-row')).toHaveCount(7);
  await expect(row(page, 'query')).toContainText('2/2 capabilities');
  await expect(row(page, 'partial')).toContainText('1/2 capabilities');
  await expect(row(page, 'partial').getByLabel('Disable partial')).toBeEnabled();
  await row(page,'partial').getByRole('button',{name:'partial',exact:true}).click();await expect(row(page, 'partial')).toContainText('Missing read_data_scope');
  await expect(row(page, 'unavailable')).toContainText('0/2 capabilities');
  await expect(row(page, 'no-requirements')).toContainText('No requirements');
  await expect(row(page, 'legacy')).toContainText('Unknown');
  await page.getByRole('button', { name: 'Ready', exact: true }).click();
  await expect(page.getByTestId('resource-row')).toHaveCount(3);
  await expect(row(page, 'broken')).toHaveCount(0);
  await page.getByRole('button', { name: 'Partial', exact: true }).click();
  await expect(page.getByTestId('resource-row')).toHaveCount(4);
  await expect(row(page, 'broken')).toContainText('2/2 capabilities');
  await page.getByRole('button', { name: 'Disabled', exact: true }).click();
  await expect(page.getByTestId('resource-row')).toHaveCount(1);
  await expect(row(page, 'disabled')).toContainText('2/2 capabilities');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByLabel('Search resources').fill('partial');
  await expect(page.getByTestId('resource-row')).toHaveCount(1);
  expect(await requests(page, 'resources.select')).toHaveLength(0);
  expect(await requests(page, 'resources.read')).toHaveLength(0);
  expect(await requests(page, 'model.request')).toHaveLength(0);
});

test('p11 unmet requirements block enabling while a saved unavailable Skill can still be disabled',async({page})=>{
  await page.goto(url);
  await reply(page,'resources.list',{ok:true,data:list([item('partial',undefined,['read'],false),item('unavailable',undefined,[],false)])});
  await expect(page.getByRole('switch',{name:'Enable partial',exact:true})).toBeDisabled();
  await expect(page.getByRole('switch',{name:'Enable unavailable',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Refresh resources',exact:true}).click();
  await reply(page,'resources.list',{ok:true,data:list([item('partial',undefined,['read'],true)])});
  await expect(page.getByRole('switch',{name:'Disable partial',exact:true})).toBeEnabled();
});

test('p11 Skill names open metadata and only selected versions allow body reads; stale detail results are ignored', async ({ page }) => {
  await page.goto(url); await reply(page, 'resources.list', { ok: true, data: list() });
  await expect(page.getByRole('button', { name: 'Read query SKILL.md', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'query', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Read query SKILL.md', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Read query SKILL.md', exact: true }).click();
  await page.getByRole('button', { name: 'disabled', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Read disabled SKILL.md', exact: true })).toBeDisabled();
  await reply(page, 'resources.read', { ok: true, data: { source: 'selection', sessionId: 1, configVersion: '1', resourceRef: ref('query'), file: 'SKILL.md', content: 'STALE_QUERY_BODY', bytes: 16 } });
  await expect(page.getByTestId('resource-panel').filter({visible:true})).not.toContainText('STALE_QUERY_BODY');
  await page.getByRole('button', { name: 'query', exact: true }).click();
  await page.getByRole('button', { name: 'Read query SKILL.md', exact: true }).click();
  const content = '<script>ENGINEERING literal</script>';
  await reply(page, 'resources.read', { ok: true, data: { source: 'selection', sessionId: 1, configVersion: '1', resourceRef: ref('query'), file: 'SKILL.md', content, bytes: content.length } });
  await expect(page.getByTestId('resource-body')).toHaveText(content);
  expect(await page.getByTestId('resource-body').locator('script').count()).toBe(0);
  expect(await requests(page, 'resources.select')).toHaveLength(0);
});

test('p11 disabling preserves matching counts and waits for confirmed configuration rather than an optimistic toggle', async ({ page }) => {
  await page.goto(url); const original = list(); await reply(page, 'resources.list', { ok: true, data: original });
  await page.getByRole('switch', { name: 'Disable query', exact: true }).click();
  expect((await requests(page, 'resources.select'))[0]!.input).toMatchObject({ sessionId: 1, expectedConfigVersion: '1' });
  await reply(page, 'resources.select', { ok: false, error: { code: 'config_version_conflict' } });
  await expect(page.getByRole('switch', { name: 'Disable query', exact: true })).toBeVisible();
  await expect(row(page, 'query')).toContainText('2/2 capabilities');
  await page.getByRole('switch', { name: 'Disable query', exact: true }).click();
  const updated = list(original.items.map(value => value.ref.id === 'query' ? { ...value, enabled: false } : value), '2');
  await reply(page, 'resources.select', { ok: true, data: { sessionId: 1, configVersion: '2', selection: updated.selection } });
  await reply(page, 'resources.list', { ok: true, data: updated });
  await expect(page.getByRole('switch', { name: 'Enable query', exact: true })).toBeVisible();
  await expect(row(page, 'query')).toContainText('2/2 capabilities');
  expect(await page.evaluate(() => Reflect.get(globalThis, '__published'))).toBe(1);
});
