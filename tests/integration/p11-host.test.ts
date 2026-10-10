import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow } from 'electron';
import { Database } from 'bun:sqlite';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MainSettings, atomicWriteJson } from '../../apps/desktop/src/main/settings';
import { MainCredentials, SecretInputs } from '../../apps/desktop/src/main/credentials';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { ResourceListSchema, ResourceSelectionReceiptSchema, ResourceTextSchema, type ResourceSelection } from '../../packages/contracts/src/resources';
import { safeError, type Result } from '../../packages/contracts/src/error';
import type { PublicMethod, PublicPayload, PublicReturn } from '../../packages/contracts/src/protocol';

const handlers = new Map<string, (...args: any[]) => any>();
let invoke: (name: string, payload: unknown) => Promise<unknown>, bridge: { request<M extends PublicMethod>(method: M, payload: PublicPayload<M>, op?: string): Promise<Result<PublicReturn<M>>> };
const childFixture = process.env.MEDCLAW_P11_HOST_CHILD === '1';
// Preload module evaluation and its Electron mock must not leak into other stages.
if (childFixture) mock.module(createRequire(new URL('../../apps/desktop/package.json', import.meta.url)).resolve('electron'), () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) },
  shell: { openExternal: async () => {} }, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcRenderer: { on() {}, send() {}, invoke: (name: string, payload: unknown) => invoke(name, payload) }, contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } },
}));
function hostTest(name: string, body: () => Promise<void>, timeout: number) {
  test(name, async () => {
    if (childFixture) return body();
    const child = Bun.spawn([process.execPath, 'test', import.meta.path, '-t', '^' + name + '$'], { env: { ...process.env, MEDCLAW_P11_HOST_CHILD: '1' }, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) process.stderr.write(stdout + stderr);
    expect(code).toBe(0); expect(stderr).toMatch(/\n\s*1 pass\n\s*1 filtered out\n\s*0 fail\b/);
  }, timeout);
}
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw result.error; return result.data; }
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-host-')), privateMethods: string[] = [];
  const host = new HostController({ dataRoot: root, hostEntry: resolve('apps/host/src/main.ts'), bunExecutable: process.execPath, onCredentialRequest: async frame => {
    privateMethods.push(frame.method); return frame.method === 'credential.list' ? { ok: true, data: [] } : frame.method === 'credential.read' ? { ok: true, data: null } : { ok: false, error: safeError('access_denied') };
  } });
  const initial = new MainSettings(host.paths.settingsPath).read();
  // A valid model definition with deliberately absent authentication; resource browsing needs no model.
  atomicWriteJson(host.paths.settingsPath, PublishedSettingsSchema.parse({ ...initial, model: { provider: 'p11-fixture', modelId: 'fixture' }, customProviders: [{ credentialRef: null, definition: {
    providerId: 'p11-fixture', name: 'Engineering', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', name: 'Engineering', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }],
  } }] }));
  let failWrite = false, loseCommit = false; const commits: string[] = [];
  const settings = new MainSettings(host.paths.settingsPath, {
    prepare: async (token, candidate) => unwrap(await host.request('settings.prepare', { token, candidate })),
    commit: async (token, publishedVersion) => { commits.push(token); const result = unwrap(await host.request('settings.commit', { token, publishedVersion })); if (loseCommit) { loseCommit = false; throw new Error('ENGINEERING lost commit reply'); } return result; },
    abort: async token => unwrap(await host.request('settings.abort', { token })),
    readVersion: async () => (unwrap(await host.request('diagnostics.read', { categories: [] })) as { versions: { configVersion: string } }).versions.configVersion,
  }, (path, value) => { if (failWrite) throw new Error('ENGINEERING write failed'); atomicWriteJson(path, value); });
  const mainFrame = { url: 'file:///desktop.html' }, window = { id: 1, webContents: { id: 10, mainFrame }, on() {} } as unknown as BrowserWindow;
  const credentials = new MainCredentials(join(root, 'credentials.json'), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() });
  const { registerIpc } = await import('../../apps/desktop/src/main/ipc-handlers');
  registerIpc({ window, host, settings, credentials, inputs: new SecretInputs(), diagnostics: async () => { throw new Error('unused'); }, report() {}, notify() {} });
  invoke = async (name, envelope) => handlers.get(name)!({ sender: { id: 10, mainFrame }, senderFrame: mainFrame }, envelope);
  await import('../../apps/desktop/src/preload/index.ts');
  const client = bridge;
  try { expect(await host.start()).toMatchObject({ state: 'ready', schemaVersion:13 }); } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  const first = unwrap(await host.request('session.create', { expectedWorkspaceRevision: 0 }, 'create-a')) as { session: { id: number }; workspace: { revision: number } };
  const second = unwrap(await host.request('session.create', { expectedWorkspaceRevision: first.workspace.revision }, 'create-b')) as { session: { id: number } };
  const sql = (query: string) => { const db = new Database(host.paths.databasePath, { readonly: true }); try { return db.query(query).all(); } finally { db.close(); } };
  return { host, settings, client, first: first.session.id, second: second.session.id, privateMethods, commits, sql, failWrite: (value: boolean) => { failWrite = value; }, loseCommit: () => { loseCommit = true; },
    close: async () => { try { if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!); } finally { rmSync(root, { recursive: true, force: true }); handlers.clear(); } } };
}

hostTest('p11 real Main Preload Host publish per-session choices without authentication or model side effects', async () => {
  const f = await setup(); try {
    const list = ResourceListSchema.parse(unwrap(await f.client.request('resources.list', { source: 'selection', sessionId: f.first })));
    expect(list.items).toHaveLength(2); const prompt = list.items.find(i => i.ref.kind === 'prompt')!.ref, skill = list.items.find(i => i.ref.kind === 'skill')!.ref;
    const selection: ResourceSelection = { prompt, skills: [skill] };
    const receipt = ResourceSelectionReceiptSchema.parse(unwrap(await f.client.request('resources.select', { sessionId: f.first, expectedConfigVersion: '1', selection }, 'select-a')));
    expect(receipt).toEqual({ sessionId: f.first, configVersion: '2', selection }); expect(f.settings.read().resources?.bySession[String(f.first)]).toEqual(selection);
    expect(ResourceTextSchema.parse(unwrap(await f.client.request('resources.read', { source: 'selection', sessionId: f.first, resourceRef: skill, file: 'SKILL.md' }))).content).toContain('read_data_scope');
    expect(await f.client.request('resources.read', { source: 'selection', sessionId: f.second, resourceRef: skill, file: 'SKILL.md' })).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(await f.client.request('resources.select', { sessionId: f.second, expectedConfigVersion: '1', selection }, 'stale-b')).toMatchObject({ ok: false, error: { code: 'config_conflict' } });
    unwrap(await f.client.request('resources.select', { sessionId: f.second, expectedConfigVersion: '2', selection: { prompt: null, skills: [skill] } }, 'select-b'));
    expect(f.settings.read().resources?.bySession[String(f.first)]).toEqual(selection); expect(f.settings.read().resources?.bySession[String(f.second)]?.skills).toEqual([skill]);
    expect(await f.client.request('model.configure', { provider: 'p11-fixture', modelId: 'fixture', expectedConfigVersion: '3' }, 'auth-still-required')).toMatchObject({ ok: false, error: { code: 'model_auth_missing' } });
    expect(await f.host.request('resources.select', { sessionId: f.first, expectedConfigVersion: '3', selection }, 'host-cannot-publish')).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(f.sql('SELECT * FROM runs')).toHaveLength(0); expect(f.sql('SELECT * FROM model_calls')).toHaveLength(0);
  } finally { await f.close(); }
}, 60000);

hostTest('p11 publication write failure preserves old choices and lost commit reply is proven by read without republishing', async () => {
  const f = await setup(); try {
    const list = ResourceListSchema.parse(unwrap(await f.client.request('resources.list', { source: 'selection', sessionId: f.first }))), selection = { prompt: list.items.find(i => i.ref.kind === 'prompt')!.ref, skills: [] };
    f.failWrite(true); expect(await f.client.request('resources.select', { sessionId: f.first, expectedConfigVersion: '1', selection }, 'write-fail')).toMatchObject({ ok: false, error: { code: 'config_write_failed' } });
    expect(f.settings.read().configVersion).toBe('1'); expect((unwrap(await f.host.request('diagnostics.read', { categories: [] })) as { versions: { configVersion: string } }).versions.configVersion).toBe('1');
    f.failWrite(false); f.loseCommit(); expect(await f.client.request('resources.select', { sessionId: f.first, expectedConfigVersion: '1', selection }, 'reply-lost')).toMatchObject({ ok: false, error: { code: 'config_write_failed' } });
    expect(f.settings.read().configVersion).toBe('2');
    const recovered = ResourceListSchema.parse(unwrap(await f.client.request('resources.list', { source: 'selection', sessionId: f.first })));
    expect(recovered.selection).toEqual(selection); expect(recovered.configVersion).toBe('2'); expect(new Set(f.commits).size).toBe(1);
    expect(await f.client.request('resources.select', { sessionId: f.first, expectedConfigVersion: '1', selection }, 'same-old-expected')).toMatchObject({ ok: false, error: { code: 'config_conflict' } });
    const before = f.settings.read(); await expect(f.settings.publish('2', { model: null }, { kind: 'resources' })).rejects.toThrow('invalid_argument'); expect(f.settings.read()).toEqual(before);
    expect(await f.client.request('resources.select', { sessionId: f.first, expectedConfigVersion: '2', selection: { prompt: { ...selection.prompt, treeHash: 'a'.repeat(64) }, skills: [] } }, 'same-version-changed')).toMatchObject({ ok: false, error: { reason: 'resource_changed' } });
    expect(await f.host.request('resources.list', { source: 'selection', sessionId: 999 })).toMatchObject({ ok: false, error: { code: 'input_invalid', reason: 'session_not_found' } });
    const publicationError = await f.settings.publish('2', { resources: { bySession: { '999': selection } } }, { kind: 'policy' }).then(() => null, error => error);
    expect(publicationError).toMatchObject({ code: 'input_invalid', reason: 'session_not_found' });
    expect(f.settings.read()).toEqual(before);
    const { previous, rollbackFromVersion, ...snapshot } = before;
    expect(await f.host.request('settings.prepare', { token: 'wrong-host-cas', candidate: { ...before, configVersion: '3', previous: { ...snapshot, configVersion: '1' }, resources: { bySession: {} } } })).toMatchObject({ ok: false, error: { code: 'config_conflict' } });
    unwrap(await f.host.request('session.delete', { sessionId: f.first, expectedMetadataRevision: 0, expectedWorkspaceRevision: 2 }, 'delete-a'));
    expect(await f.client.request('resources.select', { sessionId: f.first, expectedConfigVersion: '2', selection: { prompt: null, skills: [] } }, 'deleted-a')).toMatchObject({ ok: false, error: { reason: 'session_deleted' } });
    expect(f.settings.read()).toEqual(before);
    expect(f.sql('SELECT * FROM runs')).toHaveLength(0); expect(f.sql('SELECT * FROM model_calls')).toHaveLength(0);
  } finally { f.failWrite(false); await f.close(); }
}, 60000);
