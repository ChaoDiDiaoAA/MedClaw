import { expect, test, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import type { AppError } from '../../packages/contracts/src/error';
import { safeError, type Result } from '../../packages/contracts/src/error';
import { createRequire } from 'node:module';
import type { BrowserWindow } from 'electron';
import { MainSettings } from '../../apps/desktop/src/main/settings';
import { MainCredentials, SecretInputs } from '../../apps/desktop/src/main/credentials';
import type { DesktopNotice, PublicMethod } from '../../packages/contracts/src/protocol';
import { HOST_PROTOCOL_VERSION, DATABASE_SCHEMA_VERSION } from '../../packages/contracts/src/protocol';
import { atomicWriteJson } from '../../apps/desktop/src/main/settings';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { NewSessionResultSchema, SubmitResultSchema } from '../../packages/contracts/src/session';
import { RuntimeControlViewSchema } from '../../packages/contracts/src/run';
import { WorkspaceViewSchema } from '../../packages/contracts/src/workspace';
import { EventPageSchema, EventSubscribeResultSchema } from '../../packages/contracts/src/event';
import { providerFixture } from '../fixtures/p1-provider';

const handlers = new Map<string, (...args: any[]) => unknown>();
const rendererHandlers = new Map<string, (...args: any[]) => void>();
let preloadBridge: any;
mock.module(createRequire(new URL('../../apps/desktop/package.json', import.meta.url)).resolve('electron'), () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) },
  shell: { openExternal: async () => {} }, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcRenderer: { on: (name: string, handler: (...args: any[]) => void) => rendererHandlers.set(name, handler), send: () => {}, invoke: async () => null },
  contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { preloadBridge = value; } },
}));

async function ownerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p6-owner-'));
  const mainFrame = { url: 'file:///desktop.html' };
  const listeners = new Map<string, (...args: any[]) => void>();
  const contentsListeners = new Map<string, (...args: any[]) => void>();
  const window = { id: 1, isDestroyed: () => false, webContents: { id: 10, mainFrame, on: (name: string, fn: (...args: any[]) => void) => contentsListeners.set(name, fn) }, on: (name: string, fn: (...args: any[]) => void) => listeners.set(name, fn) } as unknown as BrowserWindow;
  let instanceId = 'host-1', next: Result<unknown> | null = null, delayed: (() => Promise<Result<unknown>>) | null = null;
  const calls: { method: string; payload: any; instance: string | undefined }[] = [];
  const host = { read: () => ({ state: 'ready', instanceId, canStart: false, sdkVersion: '0.87.1', schemaVersion:10, error: null }), request: async (method: string, payload: any, _operation?: string, _request?: string, expected?: string) => {
    calls.push({ method, payload, instance: expected });
    if (expected && expected !== instanceId) return { ok: false, error: safeError('host_interrupted') };
    if (payload.action === 'close') return { ok: true, data: { action: 'close', subscriptionId: payload.subscriptionId, closed: true } };
    if (delayed) { const action = delayed; delayed = null; return action(); }
    if (next) { const value = next; next = null; return value; }
    return { ok: true, data: { action: 'open', subscriptionId: payload.subscriptionId, runId: payload.runId, sessionId: 2, highWatermark: 0, range: { firstSequence: null, lastSequence: 0 }, streamConnection: null, snapshots: [], snapshotsIncomplete: false } };
  } } as unknown as HostController;
  const settings = new MainSettings(join(root, 'settings.json')); settings.read();
  const credentials = new MainCredentials(join(root, 'credentials.json'), { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable'); }, decryptString: () => { throw new Error('unavailable'); } });
  const { registerIpc } = await import('../../apps/desktop/src/main/ipc-handlers');
  const ipc = registerIpc({ window, host, settings, credentials, inputs: new SecretInputs(), diagnostics: async () => { throw new Error('unused'); }, report: () => {}, notify: () => {} });
  const from = { sender: { id: 10, mainFrame }, senderFrame: mainFrame };
  const request = (payload: unknown, event = from) => handlers.get('medclaw:request')!(event, { method: 'event.subscribe', payload, operationRef: 'observation' }) as Promise<Result<unknown>>;
  const open = { action: 'open', subscriptionId: 'view-a', runId: 3, afterSequence: 0, limit: 50 };
  const notice: DesktopNotice = { type: 'event.available', subscriptionId: 'view-a', runId: 3, sessionId: 2, highWatermark: 1, resyncRequired: false };
  return { ipc, open, notice, request, calls, fail: () => { next = { ok: false, error: safeError('resource_unavailable') }; }, delay: (action: () => Promise<Result<unknown>>) => { delayed = action; }, navigate: () => contentsListeners.get('did-start-navigation')?.({}, 'file:///desktop.html', false, true), instance: (id: string) => { instanceId = id; }, close: () => { listeners.get('closed')?.(); rmSync(root, { recursive: true, force: true }); } };
}

test('subscription_id_is_bound_to_window_and_host_instance', async () => {
  const c = await ownerFixture();
  try {
    expect(await c.request(c.open)).toMatchObject({ ok: true });
    expect((c.ipc as any).acceptEventNotice(c.notice, 'host-1')).toBe(true);
    expect((c.ipc as any).acceptEventNotice(c.notice, 'host-2')).toBe(false);
    expect((c.ipc as any).acceptEventNotice({ ...c.notice, runId: 4 }, 'host-1')).toBe(false);
    expect(await c.request({ ...c.open, runId: 4 })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    const before = c.calls.length;
    expect(await c.request({ action: 'close', subscriptionId: 'view-a' }, { sender: { id: 99, mainFrame: { url: 'file:///evil.html' } }, senderFrame: { url: 'file:///evil.html' } })).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(c.calls).toHaveLength(before);
    (c.ipc as any).closeInstance('host-1'); c.instance('host-2');
    expect((c.ipc as any).acceptEventNotice(c.notice, 'host-2')).toBe(false);
  } finally { c.close(); }
});

test('failed_new_open_owner_is_cleaned_without_removing_successful_refresh_owner', async () => {
  const c = await ownerFixture();
  try {
    c.fail(); expect(await c.request(c.open)).toMatchObject({ ok: false });
    expect((c.ipc as any).acceptEventNotice(c.notice, 'host-1')).toBe(false);
    expect(c.calls.some(call => call.payload.action === 'close')).toBe(true);
    expect(await c.request(c.open)).toMatchObject({ ok: true });
    c.fail(); expect(await c.request(c.open)).toMatchObject({ ok: false });
    expect((c.ipc as any).acceptEventNotice(c.notice, 'host-1')).toBe(true);
    expect(await c.request({ action: 'close', subscriptionId: 'view-a' })).toMatchObject({ ok: true });
    expect((c.ipc as any).acceptEventNotice(c.notice, 'host-1')).toBe(false);
  } finally { c.close(); }
});

test('late_open_after_window_cleanup_does_not_leak_or_close_new_instance_sid', async () => {
  const c = await ownerFixture(); let resolve!: (value: Result<unknown>) => void;
  try {
    c.delay(() => new Promise(done => { resolve = done; }));
    const opening = c.request(c.open); await Bun.sleep(0); c.navigate();
    resolve({ ok: true, data: { action: 'open', subscriptionId: 'view-a', runId: 3, sessionId: 2, highWatermark: 0, range: { firstSequence: null, lastSequence: 0 }, streamConnection: null, snapshots: [], snapshotsIncomplete: false } });
    expect(await opening).toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' } });
    expect((c.ipc as any).acceptEventNotice(c.notice, 'host-1')).toBe(false);
    expect(c.calls.filter(call => call.payload.action === 'close').every(call => call.instance === 'host-1')).toBe(true);
  } finally { c.close(); }
});

test('late_old_instance_open_cannot_remove_reused_sid_from_new_host', async () => {
  const c = await ownerFixture(); let resolve!: (value: Result<unknown>) => void;
  try {
    c.delay(() => new Promise(done => { resolve = done; }));
    const old = c.request(c.open); await Bun.sleep(0);
    c.ipc.closeInstance('host-1'); c.instance('host-2');
    expect(await c.request(c.open)).toMatchObject({ ok: true });
    resolve({ ok: true, data: { action: 'open', subscriptionId: 'view-a', runId: 3, sessionId: 2, highWatermark: 0, range: { firstSequence: null, lastSequence: 0 }, streamConnection: null, snapshots: [], snapshotsIncomplete: false } });
    expect(await old).toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' } });
    expect(c.ipc.acceptEventNotice(c.notice, 'host-2')).toBe(true);
    expect(c.calls.filter(call => call.payload.action === 'close').every(call => call.instance === 'host-1')).toBe(true);
  } finally { c.close(); }
});

test('preload_listener_failure_is_isolated_and_release_removes_only_its_listener', async () => {
  // A child loads the real module independently of prior stages' cached Electron mocks.
  const root=mkdtempSync(join(tmpdir(),'p6-preload-')),script=join(root,'observe.ts');
  writeFileSync(script,`import {mock} from 'bun:test';let bridge;const handlers=new Map();let diagnostics=0;
    mock.module(${JSON.stringify(createRequire(new URL('../../apps/desktop/package.json',import.meta.url)).resolve('electron'))},()=>({ipcRenderer:{on:(name,fn)=>handlers.set(name,fn),send:()=>{diagnostics++},invoke:async()=>null},contextBridge:{exposeInMainWorld:(_name,value)=>{bridge=value}}}));
    await import(${JSON.stringify(resolve(import.meta.dirname,'../../apps/desktop/src/preload/index.ts'))});
    let first=0,second=0;const a=bridge.subscribe(()=>{first++;throw Error('display error')});const b=bridge.subscribe(()=>{second++});
    const deliver=()=>handlers.get('medclaw:notice')({}, {type:'config.changed',configVersion:'1',instanceId:'host-1'});
    deliver();a();deliver();b();deliver();console.log(JSON.stringify({first,second,diagnostics}));`);
  try{const child=Bun.spawn([process.execPath,script],{stdout:'pipe',stderr:'pipe'});const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(stderr).toBe('');expect(exit).toBe(0);expect(JSON.parse(stdout)).toMatchObject({first:1,second:2});}
  finally{rmSync(root,{recursive:true,force:true});}
});

test('temporary_snapshots_coalesce_per_run_message_and_ended_flushes_without_regression', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'medclaw-p6-stream-')), entry = join(temporary, 'controlled-host.ts');
  writeFileSync(entry, `
    import {createInterface} from 'node:readline';
    let hello:any; const send=(v:any)=>process.stdout.write(JSON.stringify(v)+'\\n');
    const reply=(v:any,data:any)=>send({protocolVersion:hello.protocolVersion,kind:'reply',instanceId:hello.instanceId,requestId:v.requestId,result:{ok:true,data}});
    const snap=(runId:number,messageId:string,revision:number,phase:string)=>send({protocolVersion:hello.protocolVersion,kind:'notice',instanceId:hello.instanceId,notice:{type:'event.stream',subscriptionId:'view-'+runId,snapshot:{type:'message.snapshot',runId,sessionId:2,streamConnection:'connection-'+runId,messageId,ordinal:1,revision,phase,modelCallId:null,nativeEntryId:null,blocks:[{contentIndex:0,text:messageId+'-'+revision}],totalChars:(messageId+'-'+revision).length,truncated:false}}});
    createInterface({input:process.stdin}).on('line',line=>{
      const value=JSON.parse(line);
      if(!hello){hello=value;send({protocolVersion:hello.protocolVersion,instanceId:hello.instanceId,sdkVersion:hello.sdkVersion,schemaVersion:hello.expectedSchemaVersion,configVersion:'1',dataRoot:hello.paths.dataRoot});}
      else if(value.method==='event.subscribe'){
        reply(value,{action:'open',subscriptionId:value.payload.subscriptionId,runId:value.payload.runId,sessionId:2,highWatermark:0,range:{firstSequence:null,lastSequence:0},streamConnection:null,snapshots:[],snapshotsIncomplete:false});
        snap(3,'first',1,'streaming');snap(3,'second',1,'streaming');snap(3,'first',2,'streaming');snap(4,'other',1,'streaming');snap(3,'first',3,'ended');snap(3,'first',2,'streaming');
      }else if(value.method==='host.shutdown'){reply(value,{executionStopped:true,databaseClosed:true});setTimeout(()=>process.exit(0),10);}
    });
  `);
  const notices: DesktopNotice[] = [];
  const host = new HostController({ dataRoot: join(temporary, 'data'), hostEntry: entry, bunExecutable: process.execPath, onNotice: notice => notices.push(notice) });
  try {
    expect((await host.start()).state).toBe('ready');
    expect(await host.request('event.subscribe', { action: 'open', subscriptionId: 'view-3', runId: 3, afterSequence: 0, limit: 50 })).toMatchObject({ ok: true });
    await Bun.sleep(80);
    const snapshots = notices.flatMap(notice => notice.type === 'event.stream' ? [notice.snapshot] : []);
    expect(snapshots.filter(s => s.type === 'message.snapshot' && s.messageId === 'first')).toHaveLength(1);
    expect(snapshots.find(s => s.type === 'message.snapshot' && s.messageId === 'first')).toMatchObject({ revision: 3, phase: 'ended' });
    expect(snapshots.some(s => s.type === 'message.snapshot' && s.messageId === 'second')).toBe(true);
    expect(snapshots.some(s => s.runId === 4)).toBe(true);
  } finally { if (host.read().instanceId) await host.stop(host.read().instanceId!); rmSync(temporary, { recursive: true, force: true }); }
}, 15000);

test('host_requests_read_and_open_close_use_p6_contract_and_never_reexecute', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p6-real-host-')), provider = providerFixture('slow');
  const notices: DesktopNotice[] = [];
  const host = new HostController({ dataRoot: root, hostEntry: resolve('apps/host/src/main.ts'), bunExecutable: process.execPath,
    onNotice: notice => notices.push(notice), onCredentialRequest: async frame => frame.method === 'credential.list'
      ? { ok: true, data: [{ providerId: 'p6-fixture', type: 'api_key' }] }
      : frame.method === 'credential.read' ? { ok: true, data: frame.payload.providerId === 'p6-fixture' ? { type: 'api_key', key: 'fixture-only' } : null }
      : { ok: false, error: safeError('access_denied') } });
  const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw result.error; return result.data; };
  const wait = async (predicate: () => Promise<boolean> | boolean) => { const end = Date.now() + 7000; while (!await predicate()) { if (Date.now() > end) throw new Error('Host event condition timed out'); await Bun.sleep(20); } };
  const initial = new MainSettings(host.paths.settingsPath).read();
  const definition = { providerId: 'p6-fixture', name: 'Fixture', api: 'openai-completions', baseUrl: provider.url,
    models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] };
  atomicWriteJson(host.paths.settingsPath, PublishedSettingsSchema.parse({ ...initial, model: { provider: 'p6-fixture', modelId: 'fixture' }, customProviders: [{ definition, credentialRef: null }] }));
  try {
    expect(await host.start()).toMatchObject({ state: 'ready', schemaVersion: DATABASE_SCHEMA_VERSION, sdkVersion: '0.87.1' });
    expect(unwrap(await host.request('diagnostics.read', { categories: ['runtime'] }))).toMatchObject({ versions: { protocolVersion: HOST_PROTOCOL_VERSION, schemaVersion:10, sdkVersion: '0.87.1' } });
    const workspace = () => host.request('workspace.read', {}).then(result => WorkspaceViewSchema.parse(unwrap(result)));
    const session = NewSessionResultSchema.parse(unwrap(await host.request('session.create', { expectedWorkspaceRevision: (await workspace()).revision }, 'create-stream'))).session;
    const accepted = SubmitResultSchema.parse(unwrap(await host.request('session.submit', { sessionId: session.id, clientSequence: 1, text: 'P6 original input', mode: 'send', expectedRevision: (await workspace()).revision, expectedBatchIds: [], expectedQueryId: null,
      model: { provider: 'p6-fixture', modelId: 'fixture', expectedConfigVersion: '1' }, referenceDate: '2026-10-03', timezone: 'Asia/Shanghai' }, 'send-stream')));
    expect(accepted.runId).not.toBeNull(); const runId = accepted.runId!;
    const open = { action: 'open' as const, subscriptionId: 'actual-host-view', runId, afterSequence: 0, limit: 50 };
    const ack = EventSubscribeResultSchema.parse(unwrap(await host.request('event.subscribe', open)));
    expect(ack).toMatchObject({ action: 'open', runId, sessionId: session.id });
    const first = EventPageSchema.parse(unwrap(await host.request('event.read', { runId, afterSequence: 0 })));
    expect(first.events.some(event => event.type === 'run_created')).toBe(true);
    expect(first.events.some(event => event.type === 'input_accepted')).toBe(true);
    await provider.requested;
    await wait(async () => { const refreshed = EventSubscribeResultSchema.parse(unwrap(await host.request('event.subscribe', open))); return refreshed.action === 'open' && refreshed.snapshots.some(snapshot => snapshot.type === 'message.snapshot' && snapshot.blocks.some(block => block.text.includes('你好'))); });
    expect(await host.request('event.read', { runId, afterSequence: -1 })).toMatchObject({ ok: false, error: { code: 'event_cursor_invalid', runId, eventRange: { runId, firstSequence: 1 } } });
    expect(await host.request('run.cancel', { runId })).toMatchObject({ ok: true, data: { stopped: true } });
    await wait(async () => RuntimeControlViewSchema.parse(unwrap(await host.request('run.control.read', {}))).acceptingNewRuns);
    const saved = EventPageSchema.parse(unwrap(await host.request('event.read', { runId, afterSequence: 0 })));
    expect(saved.events.filter(event => event.type === 'run_cancelled')).toHaveLength(1);
    expect(await host.request('event.subscribe', { action: 'close', subscriptionId: open.subscriptionId })).toMatchObject({ ok: true, data: { closed: true } });
    expect(await host.request('event.subscribe', { action: 'close', subscriptionId: open.subscriptionId })).toMatchObject({ ok: true, data: { closed: true } });
    EventSubscribeResultSchema.parse(unwrap(await host.request('event.subscribe', { ...open, subscriptionId: 'reconnected-original' })));
    expect(EventPageSchema.parse(unwrap(await host.request('event.read', { runId, afterSequence: 0 }))).events).toEqual(saved.events);
    expect(provider.requests).toHaveLength(1);
    expect(notices.some(notice => notice.type === 'agent.preview')).toBe(false);
    expect(host.read().state).toBe('ready');
  } finally { if (host.read().instanceId) await host.stop(host.read().instanceId!); provider.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

// This fixture controls only transport. Parsing, the child process and the
// production HostController remain real; domain/SDK coverage is separate.
test('ordinary_notice_listener_failure_does_not_kill_host', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'medclaw-p6-notice-'));
  const entry = join(temporary, 'controlled-host.ts');
  writeFileSync(entry, `
    import {createInterface} from 'node:readline';
    const lines=createInterface({input:process.stdin});
    let hello:any;
    const send=(value:any)=>process.stdout.write(JSON.stringify(value)+'\\n');
    lines.on('line',line=>{
      const value=JSON.parse(line);
      if(!hello){hello=value;send({protocolVersion:hello.protocolVersion,
        instanceId:hello.instanceId,sdkVersion:hello.sdkVersion,
        schemaVersion:hello.expectedSchemaVersion,configVersion:'1',
        dataRoot:hello.paths.dataRoot});
        setTimeout(()=>send({protocolVersion:hello.protocolVersion,kind:'notice',
          instanceId:hello.instanceId,notice:{type:'config.changed',configVersion:'2'}}),40);
      }else if(value.method==='host.shutdown'){
        send({protocolVersion:hello.protocolVersion,kind:'reply',instanceId:hello.instanceId,
          requestId:value.requestId,result:{ok:true,data:{executionStopped:true,databaseClosed:true}}});
        setTimeout(()=>process.exit(0),10);
      }
    });
  `);
  let seen!: () => void;
  const observed = new Promise<void>(resolve => { seen = resolve; });
  const errors: AppError[] = [];
  const host = new HostController({dataRoot: join(temporary,'data'), hostEntry: entry,
    bunExecutable: process.execPath, onError: error => errors.push(error),
    onNotice: notice => {
      if (notice.type === 'config.changed') { seen(); throw new Error('ordinary-display-error'); }
    }});
  try {
    expect((await host.start()).state).toBe('ready');
    await observed;
    expect(host.read().state).toBe('ready');
    expect(errors.some(error => error.code === 'preview_delivery_failed')).toBe(true);
    expect(errors.some(error => error.code === 'invalid_frame')).toBe(false);
  } finally {
    const instance = host.read().instanceId;
    if (instance) await host.stop(instance);
    const within = relative(resolve(tmpdir()),resolve(temporary));
    if (within && !within.startsWith('..') && !within.includes(':')) rmSync(temporary,{recursive:true,force:true});
  }
},15000);
