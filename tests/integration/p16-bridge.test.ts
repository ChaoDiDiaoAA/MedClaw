import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { BrowserWindow } from 'electron';
import type { DesktopBridge } from '../../apps/desktop/src/renderer/App';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { EvaluationController } from '../../apps/desktop/src/main/evaluation-controller';
import { MainSettings } from '../../apps/desktop/src/main/settings';
import { MainCredentials, SecretInputs } from '../../apps/desktop/src/main/credentials';
import { safeError } from '../../packages/contracts/src/error';

const isolated = process.env.MEDCLAW_P16_BRIDGE_CHILD === '1';
const handlers = new Map<string, (...args: any[]) => any>(), listeners = new Map<string, (...args: any[]) => any>();
let bridge: DesktopBridge, invoke: (name: string, input: unknown) => Promise<unknown>;
if (isolated) mock.module(createRequire(new URL('../../apps/desktop/package.json', import.meta.url)).resolve('electron'), () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) },
  ipcRenderer: { on: (name: string, handler: (...args: any[]) => any) => listeners.set(name, handler), send() {}, invoke: (name: string, input: unknown) => invoke(name, input) },
  contextBridge: { exposeInMainWorld: (_name: string, value: DesktopBridge) => { bridge = value; } },
  shell: { openExternal: async () => {} }, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));
function bridgeTest(name: string, body: () => Promise<void>) {
  test(name, async () => {
    if (isolated) return body();
    const child = Bun.spawn([process.execPath, 'test', import.meta.path, '-t', '^' + name + '$'], { env: { ...process.env, MEDCLAW_P16_BRIDGE_CHILD: '1' }, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) process.stderr.write(stdout + stderr);
    expect(code).toBe(0); expect(stripVTControlCharacters(stderr)).toMatch(/\b1 pass\b[\s\S]*\b0 fail\b/);
  }, 60000);
}
const operationRef = 'c85a8476-22d6-4b3a-87a8-1091f9a2b34e', otherRef = '96e451b0-98d4-45d8-863f-32900c7bc7c4';
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p16-bridge-')), sourceRoot = resolve(import.meta.dir, '../..');
  const host = new HostController({ dataRoot: join(root, 'production'), hostEntry: join(sourceRoot, 'apps/host/src/main.ts'), bunExecutable: process.execPath,
    onCredentialRequest: async frame => frame.method === 'export.destination.settlePrevious' ? { ok: true, data: { stopped: true } }
      : frame.method === 'credential.list' ? { ok: true, data: [] } : frame.method === 'credential.read' ? { ok: true, data: null } : { ok: false, error: safeError('access_denied') } });
  const evaluation = new EvaluationController({ paths: { sourceRoot, configsRoot: join(root, 'normal'), runsRoot: join(root, 'eval') },
    workerEntry: join(sourceRoot, 'tests/fixtures/p16-main-worker.ts'), bunExecutable: process.execPath, production: host,
    notify: notice => listeners.get('medclaw:notice')?.({}, { ...notice, instanceId: null }) });
  // The fixture records only into its own test root.
  await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'eval')));
  const mainFrame = { url: 'file:///desktop.html' }, sender = { id: 10, mainFrame };
  const window = { id: 1, webContents: sender, on() {} } as unknown as BrowserWindow;
  const settings = new MainSettings(host.paths.settingsPath); settings.read();
  const { registerIpc } = await import('../../apps/desktop/src/main/ipc-handlers');
  registerIpc({ window, host, evaluation, settings,
    credentials: new MainCredentials(join(root, 'credentials.json'), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() }),
    inputs: new SecretInputs(), diagnostics: async () => { throw new Error('unused'); }, report() {}, notify() {} });
  const direct = (input: unknown, event = { sender, senderFrame: mainFrame }) => handlers.get('medclaw:request')!(event, input);
  invoke = async (name, input) => handlers.get(name)!({ sender, senderFrame: mainFrame }, input);
  await import('../../apps/desktop/src/preload/index.ts');
  try { await evaluation.initialize(); expect(await host.start()).toMatchObject({ state: 'ready' }); }
  catch (error) { await evaluation.shutdown(); if (host.read().instanceId) await host.stop(host.read().instanceId!); throw error; }
  return { client: bridge, host, evaluation, direct, mainFrame, sender, async close() {
    const proof = await evaluation.shutdown(); expect(proof).toMatchObject({ stopConfirmed: true, saveConfirmed: true, controllerExited: true });
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    expect(host.read().canStart).toBe(true); await rm(root, { recursive: true, force: true }); handlers.clear();
  } };
}

bridgeTest('p16 real Preload and Main route evaluation only after sender and payload checks', async () => {
  const f = await setup(); try {
    expect(await f.client.request('eval.report.list', {}, operationRef)).toMatchObject({ ok: true, data: { total: 0 } });
    expect(await f.client.request('eval.report.list', {}, 'legacy-operation')).toMatchObject({ ok: false, error: { code: 'invalid_argument' } });
    const input = { method: 'eval.report.list', payload: {}, operationRef };
    expect(await f.direct(input, { sender: { ...f.sender, id: 99 }, senderFrame: f.mainFrame })).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(await f.direct(input, { sender: f.sender, senderFrame: { url: 'file:///foreign.html' } })).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(await f.direct({ ...input, payload: { runsRoot: 'C:/foreign' } })).toMatchObject({ ok: false, error: { code: 'invalid_argument' } });
    expect(await f.direct({ ...input, method: 'settings.prepare' })).toMatchObject({ ok: false, error: { code: 'invalid_argument' } });
    let delivered = 0;
    const release = f.client.subscribe(notice => { if (notice.type === 'eval.status') delivered++; });
    const control = f.evaluation.read(), notice = { type: 'eval.status', controllerInstanceId: control.controllerInstanceId, sequence: control.sequence, executionId: control.executionId, control };
    listeners.get('medclaw:notice')!({}, { ...notice, instanceId: f.host.read().instanceId });
    expect(delivered).toBe(0);
    listeners.get('medclaw:notice')!({}, { ...notice, instanceId: null }); expect(delivered).toBe(1); release();
  } finally { await f.close(); }
});

bridgeTest('p16 Main bridge blocks new execution while retaining Host browsing and original evaluation identity', async () => {
  const f = await setup(); try {
    expect(await f.client.request('run.control.read', {})).toMatchObject({ ok: true, data: { instanceId: f.host.read().instanceId, activeRootRun: null, acceptingNewRuns: true, blockReasons: [] } });
    const input = { datasetId: 'medclaw-agent-v1', selection: 'smoke' as const, trials: 1, preflightId: otherRef };
    const first = await f.client.request('eval.start', input, operationRef); expect(first).toMatchObject({ ok: true }); if (!first.ok) throw first.error;
    expect(await f.client.request('eval.start', { ...input, preflightId: operationRef }, operationRef)).toEqual(first);
    expect(await f.client.request('host.restart', { expectedInstanceId: f.host.read().instanceId! }, 'blocked-restart')).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    expect(await f.client.request('host.stop', { expectedInstanceId: f.host.read().instanceId! }, 'stop-browsing-host')).toMatchObject({ ok: true, data: { state: 'stopped' } });
    expect(await f.client.request('host.start', {}, 'browse-host')).toMatchObject({ ok: true, data: { state: 'ready' } });
    expect(await f.client.request('workspace.read', {}, 'browse-workspace')).toMatchObject({ ok: true });
    expect(await f.client.request('eval.status', { operationRef, executionId: 'foreign-execution' }, otherRef)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await f.client.request('eval.cancel', { executionId: first.data.executionId }, otherRef)).toMatchObject({ ok: true, data: { cancelRequested: true, control: { state: 'settled' } } });
    expect(await f.client.request('host.restart', { expectedInstanceId: f.host.read().instanceId! }, 'allowed-restart')).toMatchObject({ ok: true, data: { state: 'ready' } });
  } finally { await f.close(); }
});
