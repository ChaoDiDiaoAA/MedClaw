import { expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { BrowserWindow } from 'electron';
import type { DesktopBridge } from '../../apps/desktop/src/renderer/App';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { FileTokens } from '../../apps/desktop/src/main/file-tokens';
import { MainCredentials, SecretInputs } from '../../apps/desktop/src/main/credentials';
import { MainSettings } from '../../apps/desktop/src/main/settings';
import { MaintenanceController } from '../../apps/desktop/src/main/maintenance-controller';
import { DestinationTokens } from '../../apps/desktop/src/main/destination-tokens';
import { HOST_PROTOCOL_VERSION } from '../../packages/contracts/src/protocol';
import { safeError } from '../../packages/contracts/src/error';
import { openDatabase } from '../../packages/storage/src/database';
import type { HostView } from '../../packages/contracts/src/model';
import { NewSessionResultSchema } from '../../packages/contracts/src/session';
import { mainAdmissionFixture, unwrap, until, type AdmissionActor } from '../fixtures/p17-main-admission';

const isolated = process.env.MEDCLAW_P17_BRIDGE_CHILD === '1';
const handlers = new Map<string, (...args: any[]) => any>();
let bridge: DesktopBridge, invoke: (name: string, input: unknown) => Promise<unknown>, directories: string[] = [];
if (isolated) mock.module(createRequire(new URL('../../apps/desktop/package.json', import.meta.url)).resolve('electron'), () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) },
  ipcRenderer: { on() {}, send() {}, invoke: (name: string, input: unknown) => invoke(name, input) },
  contextBridge: { exposeInMainWorld: (_name: string, value: DesktopBridge) => { bridge = value; } },
  shell: { openExternal: async () => {} }, dialog: {
    showOpenDialog: async () => ({ canceled: directories.length === 0, filePaths: directories.length ? [directories.shift()!] : [] }),
    showSaveDialog: async () => ({ canceled: directories.length === 0, filePath: directories.shift() }),
  },
}));
function bridgeTest(name: string, body: () => Promise<void>) {
  test(name, async () => {
    if (isolated) return body();
    const child = Bun.spawn([process.execPath, 'test', import.meta.path, '-t', '^' + name + '$'], { env: { ...process.env, MEDCLAW_P17_BRIDGE_CHILD: '1' }, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) process.stderr.write(stdout + stderr);
    expect(code).toBe(0); expect(stripVTControlCharacters(stderr)).toMatch(/\b1 pass\b[\s\S]*\b0 fail\b/);
  }, 60000);
}

bridgeTest('P17 bootstrap shell accepts only its own main frame and fails safely on preload errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-bootstrap-')), subscriptions = new Map<string, (...args: any[]) => any>(), windowEvents = new Map<string, (...args: any[]) => any>();
  const exits: number[] = [], boxes: unknown[][] = [], notices: unknown[][] = [], mainFrame = {}, sender = { id: 31, mainFrame, send: (...args: unknown[]) => notices.push(args) };
  const electronVersion = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  let loaded!: () => void, locked = false, nativeChoices = 0;
  const ready = new Promise<void>(resolve => { loaded = resolve; });
  const shell = { preloadEntry: join(root, 'preload.cjs'), rendererEntry: join(root, 'renderer.html') };
  writeFileSync(join(root, 'launch.json'), '{original-invalid-selection');
  mock.module(createRequire(new URL('../../apps/desktop/package.json', import.meta.url)).resolve('electron'), () => ({
    app: { hasSingleInstanceLock: () => locked, setPath: (_name: string, value: string) => expect(value).toBe(root), requestSingleInstanceLock: () => { locked = true; return true; }, whenReady: async () => {}, on: (name: string, callback: (...args: any[]) => any) => subscriptions.set('app:' + name, callback), exit: (code: number) => exits.push(code), quit() {} },
    BrowserWindow: class {
      webContents = { ...sender, setWindowOpenHandler: (callback: () => unknown) => expect(callback()).toEqual({ action: 'deny' }), on: (name: string, callback: (...args: any[]) => any) => windowEvents.set(name, callback) };
      constructor(options: unknown) { expect(options).toMatchObject({ webPreferences: { preload: shell.preloadEntry, contextIsolation: true, sandbox: true, nodeIntegration: false } }); }
      isDestroyed() { return false; }
      async loadFile(path: string) { expect(path).toBe(shell.rendererEntry); loaded(); }
    },
    ipcMain: { handle: (name: string, callback: (...args: any[]) => any) => handlers.set(name, callback), on: (name: string, callback: (...args: any[]) => any) => subscriptions.set(name, callback) },
    dialog: { showErrorBox: (...args: unknown[]) => boxes.push(args),
      showOpenDialog: async () => { nativeChoices++; return { canceled: true, filePaths: [] }; },
      showSaveDialog: async () => { nativeChoices++; return { canceled: true }; } },
  }));
  try {
    // The isolated Bun test must supply the Electron metadata consumed by the real diagnostics schema.
    Object.defineProperty(process.versions, 'electron', { value: '44.5.1', configurable: true });
    const { openBootstrapFailure } = await import('../../apps/desktop/src/main/bootstrap-failure');
    openBootstrapFailure({ shell, profileRoot: root, error: safeError('restore_failed') }); await ready;
    const request = (method: string, payload: unknown = {}, event = { sender, senderFrame: mainFrame }) => handlers.get('medclaw:request')!(event, { method, payload, operationRef: 'bootstrap-observation' });
    expect(request('host.read')).toMatchObject({ ok: true, data: { state: 'failed', instanceId: null, canStart: false, sdkVersion: null, schemaVersion: null } });
    expect(request('diagnostics.read', { categories: ['versions'] })).toMatchObject({ ok: true, data: { partial: true, missingSources: ['host'], versions: { bunVersion: null, schemaVersion: null, configVersion: null } } });
    expect(request('workspace.read')).toMatchObject({ ok: false, error: { code: 'restore_failed', reason: 'desktop_bootstrap_failed' } });
    const unauthorized = { destinationToken: crypto.randomUUID(), categories: ['errors'] };
    for (const method of ['diagnostics.export', 'diagnostics.readExport']) expect(request(method, unauthorized))
      .toMatchObject({ ok: false, error: { code: 'restore_failed', reason: 'desktop_bootstrap_failed', operationRef: 'bootstrap-observation' } });
    for (const purpose of ['create', 'read']) expect(request('diagnostics.selectDestination', { purpose }))
      .toMatchObject({ ok: false, error: { code: 'restore_failed', reason: 'desktop_bootstrap_failed' } });
    expect(nativeChoices).toBe(0);
    expect(request('host.read', {}, { sender: { ...sender, id: 32 }, senderFrame: mainFrame })).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(request('host.read', {}, { sender, senderFrame: {} })).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(request('host.read', { unexpected: true })).toMatchObject({ ok: false, error: { code: 'invalid_argument' } });
    subscriptions.get('medclaw:subscribe')!({ sender, senderFrame: {} }); expect(notices).toHaveLength(0);
    subscriptions.get('medclaw:subscribe')!({ sender, senderFrame: mainFrame }); expect(notices).toMatchObject([['medclaw:notice', { type: 'host.status', instanceId: null, host: { state: 'failed' } }]]);
    let prevented = false; windowEvents.get('will-navigate')!({ preventDefault: () => { prevented = true; } }); expect(prevented).toBe(true);
    windowEvents.get('preload-error')!(); expect(boxes).toHaveLength(1); expect(exits).toEqual([1]);
    expect(JSON.stringify(boxes)).not.toContain(root);
    expect(readFileSync(join(root, 'launch.json'), 'utf8')).toBe('{original-invalid-selection');
    for (const path of ['data/app.sqlite', 'data/settings.json', 'runtime/host.lock']) expect(existsSync(join(root, path))).toBe(false);
    expect(readdirSync(root)).toEqual(['launch.json']);
  } finally {
    if (electronVersion) Object.defineProperty(process.versions, 'electron', electronVersion); else Reflect.deleteProperty(process.versions, 'electron'); handlers.clear();
    if (realpathSync(root) !== root || !root.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING bootstrap cleanup root changed');
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ['missing-shell', 'profile-unavailable'] as const) bridgeTest('P17 Main preserves originals and uses a safe native failure for ' + failure, async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-native-startup-')), appPath = join(root, 'app/main'), profile = join(root, 'profile');
  const boxes: unknown[][] = [], exits: number[] = []; let windows = 0;
  mkdirSync(appPath, { recursive: true });
  if (failure === 'missing-shell') { mkdirSync(profile); writeFileSync(join(profile, 'launch.json'), '{original-launch'); }
  else {
    for (const path of ['app/preload', 'app/renderer']) mkdirSync(join(root, path));
    writeFileSync(join(root, 'app/preload/index.cjs'), 'ENGINEERING preload'); writeFileSync(join(root, 'app/renderer/index.html'), 'ENGINEERING renderer');
    writeFileSync(profile, 'ENGINEERING original profile obstruction');
  }
  mock.module(createRequire(new URL('../../apps/desktop/package.json', import.meta.url)).resolve('electron'), () => ({
    app: { isPackaged: false, setName() {}, getAppPath: () => appPath, getPath: () => profile, hasSingleInstanceLock: () => false,
      setPath() { throw Object.assign(new Error('ENGINEERING profile unavailable'), { code: 'EACCES' }); }, requestSingleInstanceLock() { throw new Error('Must not acquire an unknown root'); }, exit: (code: number) => exits.push(code) },
    BrowserWindow: class { constructor() { windows++; throw new Error('Must not create an untrusted shell'); } },
    dialog: { showErrorBox: (...args: unknown[]) => boxes.push(args) }, ipcMain: {}, safeStorage: {}, shell: {},
  }));
  try {
    await import('../../apps/desktop/src/main/index');
    expect(exits).toEqual([1]); expect(boxes).toHaveLength(1); expect(boxes[0]![0]).toBe('MedClaw'); expect(windows).toBe(0);
    expect(JSON.stringify(boxes)).not.toContain(root); expect(JSON.stringify(boxes)).not.toContain('ENGINEERING');
    if (failure === 'missing-shell') expect(readFileSync(join(profile, 'launch.json'), 'utf8')).toBe('{original-launch');
    else expect(readFileSync(profile, 'utf8')).toBe('ENGINEERING original profile obstruction');
    for (const path of ['data/app.sqlite', 'data/settings.json', 'runtime/host.lock']) expect(existsSync(join(profile, path))).toBe(false);
  } finally {
    if (realpathSync(root) !== root || !root.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING startup cleanup root changed');
    rmSync(root, { recursive: true, force: true });
  }
});

bridgeTest('P17 Preload and Main grant a backup and read its original result while the Host is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-bridge-')), dataRoot = join(root, 'source'), destination = join(root, 'backup');
  for (const path of [join(dataRoot, 'data'), destination]) mkdirSync(path, { recursive: true });
  const db = openDatabase(join(dataRoot, 'data/app.sqlite')); db.close();
  const settings = new MainSettings(join(dataRoot, 'data/settings.json')); settings.read();
  const operationRef = crypto.randomUUID(), files = new FileTokens();
  let view: HostView = { instanceId: 'fixture-host', state: 'ready', canStart: false, sdkVersion: '0.87.1', schemaVersion: 17, error: null }, hostRequests = 0;
  const host = { read: () => view, refreshStopProof: async () => {}, request: async (method: string) => {
    hostRequests++; expect(method).toBe('run.control.read');
    return { ok: true, data: { instanceId: view.instanceId, activeRootRun: null, acceptingNewRuns: true, blockReasons: [], budget: null } };
  }, stop: async () => {
    view = { ...view, state: 'stopped', canStart: true, shutdown: { executionStopped: true, requiredPersistenceComplete: true, databaseClosed: true, processExited: true, processTreeStopped: true, error: null } }; return view;
  } } as unknown as HostController;
  const maintenance = new MaintenanceController({ dataRoot, selectionRoot: root, files, host, writesBusy: () => false, bunExecutable: process.execPath,
    maintenanceEntry: resolve(import.meta.dir, '../../apps/host/src/maintenance.ts'), installManifestPath: resolve(import.meta.dir, '../../.build/package-resources/medclaw/install.json') });
  const mainFrame = { url: 'file:///desktop.html' }, sender = { id: 10, mainFrame }, window = { id: 1, webContents: sender, on() {} } as unknown as BrowserWindow;
  const options = { window, host, settings, maintenance, fileTokens: files, credentials: new MainCredentials(join(dataRoot, 'data/credentials.json'), { isEncryptionAvailable: () => false, encryptString() { throw new Error(); }, decryptString() { throw new Error(); } }),
    inputs: new SecretInputs(), diagnostics: async () => { throw new Error('unused'); }, report() {}, notify() {} };
  const { registerIpc } = await import('../../apps/desktop/src/main/ipc-handlers'); registerIpc(options);
  invoke = async (name, input) => handlers.get(name)!({ sender, senderFrame: mainFrame }, input);
  await import('../../apps/desktop/src/preload/index');
  try {
    directories = [destination]; const selected = await bridge.request('backup.select', { purpose: 'create' }, operationRef);
    expect(selected).toMatchObject({ ok: true }); if (!selected.ok || !selected.data?.destinationToken) throw new Error('No granted destination');
    const result = await bridge.request('backup.create', { destinationToken: selected.data.destinationToken }, operationRef);
    expect(result).toMatchObject({ ok: true, data: { operationRef, kind: 'create', state: 'completed' } });
    view = { ...view, state: 'failed' };
    directories = [join(destination, 'MedClaw-backup-' + operationRef)];
    const readSelection = await bridge.request('backup.select', { purpose: 'read' }, crypto.randomUUID());
    expect(readSelection).toMatchObject({ ok: true, data: { originalOperationRef: operationRef, originalKind: 'create' } });
    if (!readSelection.ok || !readSelection.data?.resultToken) throw new Error('No granted result');
    expect(await bridge.request('backup.read', { resultToken: readSelection.data.resultToken, kind: 'create' }, operationRef)).toEqual(result);
    expect(hostRequests).toBe(1);
    expect(await handlers.get('medclaw:request')!({ sender: { ...sender, id: 99 }, senderFrame: mainFrame }, { method: 'backup.select', payload: { purpose: 'read' }, operationRef })).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(await bridge.request('backup.create', { destinationToken: selected.data.destinationToken }, crypto.randomUUID())).toMatchObject({ ok: false, error: { code: 'access_denied' } });
  } finally { await maintenance.shutdown(); handlers.clear(); rmSync(root, { recursive: true, force: true }); }
});

bridgeTest('P17 Preload bounds backup restore and support waits while ordinary requests keep their existing behavior', async () => {
  await import('../../apps/desktop/src/preload/index');
  const timers = spyOn(globalThis, 'setTimeout'), operationRef = crypto.randomUUID();
  invoke = async () => new Promise(() => {});
  try {
    const pending = bridge.request('backup.create', { destinationToken: 'granted-destination' }, operationRef);
    const scheduled = timers.mock.calls.find(call => call[1] === 600000);
    expect(scheduled).toBeDefined();
    if (typeof scheduled?.[0] !== 'function') throw new Error('No bounded wait'); scheduled[0]();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'operation_result_unknown', operationRef } });
    timers.mockClear();
    const support = bridge.request('diagnostics.export', { destinationToken: 'granted-support', categories: ['runtime'] }, operationRef);
    const supportWait = timers.mock.calls.find(call => call[1] === 600000);
    expect(supportWait).toBeDefined();
    if (typeof supportWait?.[0] !== 'function') throw new Error('No bounded support wait'); supportWait[0]();
    expect(await support).toMatchObject({ ok: false, error: { code: 'operation_result_unknown', operationRef } });
    timers.mockClear(); invoke = async () => ({ ok: true, data: { instanceId: null, state: 'stopped', canStart: true, sdkVersion: null, schemaVersion: null, error: null } });
    expect((await bridge.request('host.read', {})).ok).toBe(true); expect(timers.mock.calls).toHaveLength(0);
  } finally { timers.mockRestore(); }
});

bridgeTest('P17 support export and native original-file lookup remain Main-only while Host is failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'MedClaw 支持包 桥接-')), dataRoot = join(root, 'data'), destination = join(root, 'external');
  mkdirSync(dataRoot); mkdirSync(destination);
  const operationRef = crypto.randomUUID(), files = new FileTokens(), settings = new MainSettings(join(dataRoot, 'settings.json')); settings.read();
  const view: HostView = { instanceId: null, state: 'failed', canStart: true, sdkVersion: null, schemaVersion: null, error: null };
  let reads = 0, closing = false;
  let releaseSnapshot!: () => void, enterSnapshot!: () => void;
  const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve; }), snapshotEntered = new Promise<void>(resolve => { enterSnapshot = resolve; });
  const host = { read: () => view, request: async () => { throw new Error('Support must not enter the Host'); } } as unknown as HostController;
  const maintenance = new MaintenanceController({ dataRoot, selectionRoot: root, files, host, writesBusy: () => false, appClosing: () => closing, bunExecutable: process.execPath,
    maintenanceEntry: resolve(import.meta.dir, '../../apps/host/src/maintenance.ts'), installManifestPath: resolve(import.meta.dir, '../../.build/package-resources/medclaw/install.json') });
  const sender = { id: 10, mainFrame: { url: 'file:///desktop.html' } }, window = { id: 1, webContents: sender, on() {} } as unknown as BrowserWindow;
  const { registerIpc } = await import('../../apps/desktop/src/main/ipc-handlers');
  registerIpc({ window, host, settings, maintenance, fileTokens: files, destinations: new DestinationTokens(dataRoot),
    credentials: new MainCredentials(join(dataRoot, 'credentials.json'), { isEncryptionAvailable: () => false, encryptString() { throw new Error(); }, decryptString() { throw new Error(); } }), inputs: new SecretInputs(),
    diagnostics: async () => { reads++; enterSnapshot(); await snapshotGate; return { partial: true, missingSources: ['host'], host: view, entries: [], versions: { sdkVersion: '0.87.1', protocolVersion: HOST_PROTOCOL_VERSION, schemaVersion: null, configVersion: '1', bunVersion: null, electronVersion: '44.5.1' } }; }, report() {}, notify() {} });
  invoke = async (name, input) => handlers.get(name)!({ sender, senderFrame: sender.mainFrame }, input);
  await import('../../apps/desktop/src/preload/index');
  try {
    directories = [destination]; const grant = await bridge.request('diagnostics.selectDestination', { purpose: 'create' }, operationRef);
    expect(grant).toMatchObject({ ok: true }); if (!grant.ok || !grant.data) throw new Error('No support authorization');
    const input = { categories: ['errors', 'runtime'] as Array<'errors' | 'runtime'>, destinationToken: grant.data.destinationToken };
    const publication = bridge.request('diagnostics.export', input, operationRef);
    await snapshotEntered; closing = true; const shutdown = maintenance.shutdown();
    expect(await Promise.race([shutdown.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false);
    releaseSnapshot(); const published = await publication; expect(published).toMatchObject({ ok: true, data: { operationRef, partial: true, state: 'completed' } });
    expect(await shutdown).toEqual({ stopped: true });
    expect(await bridge.request('diagnostics.export', input, operationRef)).toEqual(published);
    const busyRef = crypto.randomUUID(); directories = [destination]; const busyGrant = await bridge.request('diagnostics.selectDestination', { purpose: 'create' }, busyRef);
    if (!busyGrant.ok || !busyGrant.data) throw new Error('No new native support authorization');
    expect(await bridge.request('diagnostics.export', { ...input, destinationToken: busyGrant.data.destinationToken }, busyRef)).toMatchObject({ ok: false, error: { code: 'maintenance_busy' } });
    expect(await bridge.request('diagnostics.export', input, crypto.randomUUID())).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    directories = [join(destination, 'MedClaw-support-'+operationRef+'.json')];
    const selected = await bridge.request('diagnostics.selectDestination', { purpose: 'read' });
    expect(selected).toMatchObject({ ok: true, data: { original: { operationRef, categories: ['errors', 'runtime'] } } });
    if (!selected.ok || !selected.data?.original) throw new Error('No original support authorization');
    expect(await bridge.request('diagnostics.export', { categories: selected.data.original.categories, destinationToken: selected.data.destinationToken }, operationRef)).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(await bridge.request('diagnostics.readExport', { categories: selected.data.original.categories, destinationToken: selected.data.destinationToken }, operationRef)).toEqual(published);
    expect(reads).toBe(1);
    expect(await handlers.get('medclaw:request')!({ sender: { ...sender, id: 99 }, senderFrame: sender.mainFrame }, { method: 'diagnostics.selectDestination', payload: { purpose: 'create' }, operationRef })).toMatchObject({ ok: false, error: { code: 'access_denied' } });
  } finally { releaseSnapshot(); await maintenance.shutdown(); handlers.clear(); rmSync(root, { recursive: true, force: true }); }
});

for (const actor of ['intent preparation', 'configuration publication', 'destination copy', 'support export', 'evaluation start'] satisfies AdmissionActor[]) {
  bridgeTest('P17 real Main maintenance excludes ' + actor + ' in both admission orders', async () => {
    const f = await mainAdmissionFixture(actor), pending: Promise<unknown>[] = [];
    const sender = { id: 10, mainFrame: { url: 'file:///desktop.html' } }, window = { id: 1, webContents: sender, on() {}, isDestroyed: () => false } as unknown as BrowserWindow;
    const { registerIpc } = await import('../../apps/desktop/src/main/ipc-handlers');
    const ipc = registerIpc({ ...f, window, fileTokens: f.files, report() {}, notify() {} });
    invoke = async (name, input) => handlers.get(name)!({ sender, senderFrame: sender.mainFrame }, input);
    await import('../../apps/desktop/src/preload/index');
    const stop = spyOn(f.host, 'stop');
    const facts = () => ({ settings: readFileSync(f.host.paths.settingsPath, 'utf8'), runs: f.sql('SELECT * FROM runs'), inputs: f.sql('SELECT * FROM session_inputs'),
      exports: f.sql('SELECT * FROM exports'), queries: f.sql('SELECT * FROM queries'), files: readdirSync(f.external).sort() });
    const selectBackup = async (operationRef: string) => {
      directories = [f.backupRoot]; const selected = unwrap(await bridge.request('backup.select', { purpose: 'create' }, operationRef));
      if (!selected?.destinationToken) throw new Error('ENGINEERING no backup grant'); return { destinationToken: selected.destinationToken };
    };
    try {
      const session = NewSessionResultSchema.parse(unwrap(await bridge.request('session.create', { expectedWorkspaceRevision: (await f.workspace()).revision }, crypto.randomUUID())));
      let exportQueryId: number | null = null;
      if (actor === 'destination copy') {
        f.formResult(await bridge.request('session.submit', await f.submission(session.session.id, true), crypto.randomUUID())); await f.idle();
        const queries = f.sql('SELECT id FROM queries'); expect(queries).toHaveLength(1);
        const query = queries[0]; if (!query || typeof query.id !== 'number') throw new Error('ENGINEERING form did not save its Query'); exportQueryId = query.id;
      }
      const prepare = async () => {
        const operationRef = crypto.randomUUID();
        if (actor === 'evaluation start') return { operationRef,
          run: () => bridge.request('eval.start', { datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1, preflightId: crypto.randomUUID() }, operationRef) };
        if (actor === 'intent preparation') {
          const input = await f.submission(session.session.id); return { operationRef, run: () => bridge.request('session.submit', input, operationRef) };
        }
        if (actor === 'configuration publication') {
          const current = f.settings.read(), input = { expectedConfigVersion: current.configVersion, policy: { ...current.requestPolicy, timeoutMs: current.requestPolicy.timeoutMs + 1000 } };
          return { operationRef, run: () => bridge.request('model.policy.update', input, operationRef) };
        }
        if (actor === 'destination copy') {
          const source = { operationRef, queryId: exportQueryId!, answerId: null, format: 'json' as const };
          directories = [join(f.external, operationRef + '.json')]; const selected = unwrap(await bridge.chooseExportDestination(source));
          if (!selected) throw new Error('ENGINEERING no export grant');
          return { operationRef, run: async () => {
            const accepted = await bridge.request('export.create', { ...source, destinationToken: selected.destinationToken }, operationRef);
            if (!accepted.ok) return accepted;
            let latest = accepted.data;
            await until(async () => {
              const read = unwrap(await bridge.request('export.read', { operationRef })); if (!read) throw new Error('ENGINEERING export original missing'); latest = read;
              return ['completed', 'failed', 'cancelled', 'interrupted'].includes(latest.state);
            });
            return { ok: true as const, data: latest };
          } };
        }
        directories = [f.external]; const selected = unwrap(await bridge.request('diagnostics.selectDestination', { purpose: 'create' }, operationRef));
        if (!selected) throw new Error('ENGINEERING no support grant');
        return { operationRef, run: () => bridge.request('diagnostics.export', { destinationToken: selected.destinationToken, categories: ['runtime'] }, operationRef) };
      };
      const first = await prepare(), blockedRef = crypto.randomUUID(), blockedInput = await selectBackup(blockedRef), before = facts();
      f.write.arm(); const writing = first.run(); pending.push(writing);
      await Promise.race([until(async () => f.write.entered()), writing.then(result => { if (!result.ok) throw result.error; throw new Error('ENGINEERING write completed before its window'); })]);
      if (actor === 'intent preparation') { expect(f.evaluation.admissionPending).toBe(true); expect(f.sql('SELECT * FROM runs')).toEqual(before.runs); expect(f.sql('SELECT * FROM session_inputs')).toEqual(before.inputs); }
      if (actor === 'configuration publication') expect(readFileSync(f.host.paths.settingsPath, 'utf8')).toBe(before.settings);
      if (actor === 'destination copy') {
        expect(f.destinations.busy).toBe(true); expect(existsSync(join(f.external, first.operationRef + '.json'))).toBe(false);
        expect(f.sql('SELECT state,copy_state FROM exports')).toEqual([{ state: 'copying', copy_state: 'copying' }]);
      }
      if (actor === 'support export') { expect(f.diagnosticsReads()).toBe(1); expect(readdirSync(f.external)).toEqual([]); }
      if (actor === 'evaluation start') {
        expect(f.evaluation.admissionPending).toBe(true); expect(f.evaluation.read().operationRef).toBeNull(); expect(facts()).toEqual(before);
        expect(existsSync(join(f.root, 'eval-runs/business/.active-execution.json'))).toBe(false);
      }
      expect(await bridge.request('backup.create', blockedInput, blockedRef)).toMatchObject({ ok: false, error: { code: 'maintenance_busy' } });
      expect(stop).toHaveBeenCalledTimes(0); expect(f.host.read().state).toBe('ready'); expect(readdirSync(f.backupRoot)).toEqual([]); expect(f.maintenance.busy).toBe(false);
      f.write.release(); const original = await writing; expect(original).toMatchObject({ ok: true }); await f.idle();
      if (actor === 'evaluation start') {
        expect(original).toMatchObject({ data: { operationRef: first.operationRef, executionId: 'desktop-' + first.operationRef, accepted: true } });
        await until(async () => !f.evaluation.admissionPending);
        expect(f.evaluation.read()).toMatchObject({ state: 'settled', operationRef: first.operationRef, stopConfirmed: true, saveConfirmed: true, error: { code: 'config_conflict' } });
        expect(facts()).toEqual(before); expect(existsSync(join(f.root, 'eval-runs/business/.active-execution.json'))).toBe(false);
      }
      if (actor === 'configuration publication') expect(f.settings.read().configVersion).toBe('2');
      if (actor === 'destination copy') expect(original).toMatchObject({ data: { state: 'completed', copyState: 'verified' } });
      if (actor === 'support export') expect(original).toMatchObject({ data: { operationRef: first.operationRef, state: 'completed' } });
      const second = await prepare(), backupRef = crypto.randomUUID(), backupInput = await selectBackup(backupRef), settled = facts(), httpBefore = [...f.paths], diagnosticsBefore = f.diagnosticsReads();
      f.maintenanceGate.arm(); const maintenance = bridge.request('backup.create', backupInput, backupRef); pending.push(maintenance);
      await until(async () => f.maintenanceGate.entered()); expect(f.maintenance.busy).toBe(true); expect(stop).toHaveBeenCalledTimes(0);
      const forwarded = f.forwarded.length;
      expect(await second.run()).toMatchObject({ ok: false, error: { code: 'maintenance_busy' } });
      expect(facts()).toEqual(settled); expect(f.paths).toEqual(httpBefore); expect(f.diagnosticsReads()).toBe(diagnosticsBefore); expect(f.destinations.busy).toBe(false);
      expect(f.forwarded.slice(forwarded).some(method => ['session.submit', 'settings.prepare', 'export.create', 'diagnostics.read'].includes(method))).toBe(false);
      if (actor === 'evaluation start') expect(f.evaluation.read()).toMatchObject({ state: 'settled', operationRef: first.operationRef, stopConfirmed: true, saveConfirmed: true });
      f.maintenanceGate.release(); const backedUp = await maintenance;
      expect(backedUp).toMatchObject({ ok: true, data: { operationRef: backupRef, state: 'completed' } });
      expect(stop).toHaveBeenCalledTimes(1); expect(f.host.read()).toMatchObject({ state: 'stopped', canStart: true, shutdown: { executionStopped: true, requiredPersistenceComplete: true, databaseClosed: true, processExited: true, processTreeStopped: true } });
      const backup = join(f.backupRoot, 'MedClaw-backup-' + backupRef);
      expect(readFileSync(join(backup, 'data/settings.json'), 'utf8')).toBe(settled.settings);
      expect(f.sql('SELECT * FROM queries')).toEqual(settled.queries); expect(readdirSync(f.external).sort()).toEqual(settled.files);
      expect(existsSync(join(f.external, second.operationRef + '.json'))).toBe(false); expect(existsSync(join(f.external, 'MedClaw-support-' + second.operationRef + '.json'))).toBe(false);
      ipc.closeInstance(f.host.read().instanceId!);
    } finally {
      f.write.release(); f.maintenanceGate.release(); await Promise.allSettled(pending); stop.mockRestore(); handlers.clear(); await f.close();
    }
  });
}
