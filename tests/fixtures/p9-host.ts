import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MainSettings, atomicWriteJson } from '../../apps/desktop/src/main/settings';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { safeError, type Result } from '../../packages/contracts/src/error';
import { NewSessionResultSchema, SessionDetailSchema, SubmitResultSchema, type SubmitInput } from '../../packages/contracts/src/session';
import { WorkspaceViewSchema } from '../../packages/contracts/src/workspace';
import { RuntimeControlViewSchema } from '../../packages/contracts/src/run';

type SessionHostBarrier = 'final-before' | 'final-after' | 'checkpoint-before' | 'checkpoint-after' | 'checkpoint-rebuild-failure' | 'command-stop-refusal' | 'search-process';
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw result.error; return result.data; }
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!await check()) { if (Date.now() > end) throw new Error('ENGINEERING Host condition timeout'); await Bun.sleep(10); }
}

export async function sessionHostFixture(barrier?: SessionHostBarrier, pathPrefix?: string) {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p9-host-')), requests: Record<string, unknown>[] = [];
  let hold = false, nextTool: { name: 'bash' | 'powershell' | 'grep' | 'find'; input: { command: string; timeout?: number } | { pattern: string; path: string; limit?: number } } | null = null;
  const armed = join(root, 'arm'), reached = join(root, 'reached'), refused = join(root, 'command-stop-refused'), entry = join(root, 'barrier-host.ts');
  if (barrier || pathPrefix) {
    const interception = !barrier ? '' : barrier === 'command-stop-refusal'
      ? `const spawn=cp.spawn;spyOn(cp,'spawn').mockImplementation((file,...args)=>{if(typeof file==='string'&&basename(file).toLowerCase()==='taskkill.exe'){writeFileSync(${JSON.stringify(refused)},'ENGINEERING refused');throw Object.assign(new Error('ENGINEERING controlled command stop refusal'),{code:'EACCES'});}return spawn(file,...args);});`
      : barrier === 'search-process'
      // Suspend only the SDK's captured child inside this Host Job, so cancellation cannot race a tiny search.
      // Test-only ABI reference: https://github.com/winsiderss/systeminformer/blob/master/phnt/include/ntpsapi.h
      ? `const {dlopen,ptr}=await import('bun:ffi');const windows=process.env.SystemRoot;
        const kernel=dlopen(windows+'/System32/kernel32.dll',{OpenProcess:{args:['u32','bool','u32'],returns:'u64'},OpenJobObjectW:{args:['u32','bool','ptr'],returns:'u64'},IsProcessInJob:{args:['u64','u64','ptr'],returns:'bool'},CloseHandle:{args:['u64'],returns:'bool'}}).symbols;
        const native=dlopen(windows+'/System32/ntdll.dll',{NtSuspendProcess:{args:['u64'],returns:'i32'}}).symbols;
        const spawn=cp.spawn;spyOn(cp,'spawn').mockImplementation((file,...args)=>{const child=spawn(file,...args),program=typeof file==='string'?basename(file).toLowerCase():'';
          if(['rg.exe','fd.exe'].includes(program)&&!args[0]?.includes('--version'))child.once('spawn',()=>{
            if(child.exitCode!==null||!child.pid)throw new Error('ENGINEERING search exited before the fault window');
            const record=JSON.parse(readFileSync(${JSON.stringify(join(root, 'runtime/host.lock'))},'utf8')),wide=Buffer.from(record.processDomain.jobName+'\\0','utf16le');
            const processHandle=kernel.OpenProcess(0x1800,false,child.pid),jobHandle=kernel.OpenJobObjectW(4,false,ptr(wide)),member=new Uint32Array(1);
            try{if(!processHandle||!jobHandle||!kernel.IsProcessInJob(processHandle,jobHandle,ptr(member))||member[0]!==1||native.NtSuspendProcess(processHandle)!==0)throw new Error('ENGINEERING owned search suspension failed');
              writeFileSync(${JSON.stringify(join(root, 'native-search-process.json.tmp'))},JSON.stringify({pid:child.pid,program,path:file,instanceId:record.instanceId}));renameSync(${JSON.stringify(join(root, 'native-search-process.json.tmp'))},${JSON.stringify(join(root, 'native-search-process.json'))});
            }finally{const processClosed=!processHandle||kernel.CloseHandle(processHandle),jobClosed=!jobHandle||kernel.CloseHandle(jobHandle);if(!processClosed||!jobClosed)throw new Error('ENGINEERING search handle close failed');}
          });return child;});`
      : barrier === 'checkpoint-before'
      ? `const restore=Repositories.prototype.restoreCheckpointInTransaction;Repositories.prototype.restoreCheckpointInTransaction=function(...args){const before=this.beforeCommit;this.beforeCommit=()=>{before?.();block();};try{return restore.apply(this,args);}finally{this.beforeCommit=before;}};`
      : barrier === 'checkpoint-after'
      ? `const restore=PiAgentRuntime.prototype.restore;PiAgentRuntime.prototype.restore=function(...args){block();return restore.apply(this,args);};`
      : barrier === 'checkpoint-rebuild-failure'
      ? `const restore=PiAgentRuntime.prototype.restore;PiAgentRuntime.prototype.restore=async function(...args){if(!existsSync(${JSON.stringify(armed)}))return restore.apply(this,args);unlinkSync(${JSON.stringify(armed)});writeFileSync(${JSON.stringify(reached)},'rebuild-failure');const failure=spyOn(sdk,'createAgentSession').mockRejectedValueOnce(new Error('ENGINEERING restore assembly failure'));try{return await restore.apply(this,args);}finally{failure.mockRestore();}};`
      : `const finalize=Repositories.prototype.finalizeAgent;Repositories.prototype.finalizeAgent=function(...args){${barrier === 'final-before' ? 'block();' : ''}const result=finalize.apply(this,args);${barrier === 'final-after' ? 'block();' : ''}return result;};`;
    writeFileSync(entry, `import{existsSync,readFileSync,renameSync,unlinkSync,writeFileSync}from'node:fs';import{basename}from'node:path';import*as cp from'node:child_process';import{spyOn}from'bun:test';
      import{Repositories}from ${JSON.stringify(resolve('packages/storage/src/repositories.ts'))};
      import{PiAgentRuntime}from ${JSON.stringify(resolve('packages/runtime-pi/src/agent-runtime.ts'))};
      import*as sdk from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))};
      const block=()=>{if(!existsSync(${JSON.stringify(armed)}))return;unlinkSync(${JSON.stringify(armed)});writeFileSync(${JSON.stringify(reached)},${JSON.stringify(barrier)});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);throw new Error('ENGINEERING kill window expired');};
      ${pathPrefix ? `process.env.PATH=${JSON.stringify(pathPrefix)}+';'+(process.env.PATH??'');` : ''}
      ${interception}
      await import(${JSON.stringify(resolve('apps/host/src/main.ts'))});`);
  }
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>); const waiting = hold, tool = nextTool; nextTool = null;
    return new Response(new ReadableStream({ start(controller) {
      const send = (value: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'ENGINEERING-native-command', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] }
        : { role: 'assistant', content: waiting ? 'ENGINEERING temporary' : 'ENGINEERING answer' };
      send({ id: 'ENGINEERING', model: 'fixture', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : waiting ? null : 'stop' }] });
      if (!waiting) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); }
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const host = new HostController({ dataRoot: root, hostEntry: barrier || pathPrefix ? entry : resolve('apps/host/src/main.ts'), bunExecutable: process.execPath,
    onCredentialRequest: async frame => frame.method === 'export.destination.settlePrevious' ? { ok: true, data: { stopped: true } }
      : frame.method === 'credential.list' ? { ok: true, data: [{ providerId: 'p9-fixture', type: 'api_key' }] }
      : frame.method === 'credential.read' ? { ok: true, data: frame.payload.providerId === 'p9-fixture' ? { type: 'api_key', key: 'ENGINEERING' } : null }
      : { ok: false, error: safeError('access_denied') } });
  async function close() {
    try {
      if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
      if (!host.read().canStart) throw new Error('ENGINEERING Host stop unconfirmed');
      const target = realpathSync(root);
      if (target !== host.paths.dataRoot || !target.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING fixture root changed');
      rmSync(target, { recursive: true, force: true });
    } catch (error) { console.error('SESSION_HOST_FIXTURE_RETAINED ' + JSON.stringify({ root, state: host.read().state, canStart: host.read().canStart })); throw error; }
    finally { server.stop(true); }
  }
  try {
    const initial = new MainSettings(host.paths.settingsPath).read();
    const definition = { providerId: 'p9-fixture', name: 'ENGINEERING', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [{ id: 'fixture', name: 'ENGINEERING', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] };
    atomicWriteJson(host.paths.settingsPath, PublishedSettingsSchema.parse({ ...initial,
      ...(barrier === 'search-process' ? { runtimeConfiguration: { ...initial.runtimeConfiguration, runBudget: { ...initial.runtimeConfiguration.runBudget, singleToolTimeoutMs: 1000 } }, agentPolicy: { ...initial.agentPolicy, singleToolTimeoutMs: 1000 } } : {}),
      model: { provider: 'p9-fixture', modelId: 'fixture' }, customProviders: [{ definition, credentialRef: null }] }));
    expect(await host.start()).toMatchObject({ state: 'ready', schemaVersion: 17 });
  } catch (error) { await close(); throw error; }
  const sql = (query: string) => { const db = new Database(host.paths.databasePath, { readonly: true }); try { return db.query(query).all(); } finally { db.close(); } };
  const workspace = async () => WorkspaceViewSchema.parse(unwrap(await host.request('workspace.read', {})));
  const create = async (op: string) => NewSessionResultSchema.parse(unwrap(await host.request('session.create', { expectedWorkspaceRevision: (await workspace()).revision }, op)));
  const select = async (sessionId: number) => unwrap(await host.request('session.select', { sessionId, expectedWorkspaceRevision: (await workspace()).revision }));
  const idle = () => until(async () => RuntimeControlViewSchema.parse(unwrap(await host.request('run.control.read', {}))).acceptingNewRuns);
  async function send(sessionId: number, text: string, op: string) {
    const detail = SessionDetailSchema.parse(unwrap(await host.request('session.read', { sessionId }))), w = await workspace();
    const request: SubmitInput = { sessionId, clientSequence: detail.session.nextSubmissionSequence, text, mode: 'send', expectedRevision: w.revision, expectedBatchIds: [], expectedQueryId: null, model: { provider: 'p9-fixture', modelId: 'fixture', expectedConfigVersion: '1' }, referenceDate: '2026-10-05', timezone: 'Asia/Shanghai' };
    return SubmitResultSchema.parse(unwrap(await host.request('session.submit', request, op)));
  }
  async function kill() {
    const instanceId = host.read().instanceId, child = (host as unknown as { child: ChildProcessWithoutNullStreams | null }).child;
    if (!instanceId || !child) throw new Error('ENGINEERING no owned Host');
    const exited = (host as unknown as { exited: Promise<void> }).exited;
    if (!child.kill('SIGKILL')) throw new Error('ENGINEERING owned Host kill rejected');
    await exited; return instanceId;
  }
  return { host, requests, sql, workspace, create, select, idle, send, close, kill, hold: (value: boolean) => { hold = value; },
    command: (name: 'bash' | 'powershell', input: { command: string; timeout?: number }) => { nextTool = { name, input }; },
    search: (name: 'grep' | 'find', input: { pattern: string; path: string; limit?: number }) => { nextTool = { name, input }; },
    arm: () => writeFileSync(armed, 'ENGINEERING'), reached: () => existsSync(reached), stopRefused: () => existsSync(refused) };
}
