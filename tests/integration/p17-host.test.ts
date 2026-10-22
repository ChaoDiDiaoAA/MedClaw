import { expect, spyOn, test } from 'bun:test';
import { dlopen, ptr } from 'bun:ffi';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MainSettings } from '../../apps/desktop/src/main/settings';
import type { Result } from '../../packages/contracts/src/error';
import { WriterLockRecordSchema } from '../../packages/contracts/src/maintenance';

const jobModule = pathToFileURL(resolve(import.meta.dir, '../../apps/host/src/windows-job.ts')).href;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => Promise<boolean>, timeout = 10000) {
  const end = Date.now() + timeout;
  do { if (await check()) return; await Bun.sleep(50); } while (Date.now() < end);
  throw new Error('controlled_process_did_not_stop');
}
async function inspect(owner: { instanceId: string; startupToken: string }, domain: unknown) {
  const { inspectStoppedJob } = await import('../../apps/host/src/windows-job');
  return inspectStoppedJob(owner, domain);
}

test('concurrent stopped-Host proof reads share one real owner check and retain restart admission', async () => {
  const { fixture, finishHostFixture, createHostDiagnostics } = await import('../fixtures/p1-host');
  const maintenance = await import('../../apps/desktop/src/main/maintenance-controller');
  const { root, entry } = await fixture(), diagnostic = createHostDiagnostics();
  const notices: ReturnType<HostController['read']>[] = [];
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath,
    onStarting: instanceId => diagnostic.starting(instanceId, (host as unknown as { child: ChildProcessWithoutNullStreams }).child),
    onNotice: notice => { diagnostic.onNotice(notice); if (notice.type === 'host.status') notices.push(notice.host); },
    onError: diagnostic.onError, onExit: diagnostic.onExit });
  let observer: ReturnType<typeof spyOn> | undefined, failed = false;
  try {
    const ready = await host.start(); expect(ready.state).toBe('ready');
    expect(await host.stop(ready.instanceId!)).toMatchObject({ state: 'stopped', canStart: true });
    notices.length = 0;
    observer = spyOn(maintenance, 'requestMaintenance');
    const checking = Promise.all([host.refreshStopProof(), host.refreshStopProof(), host.refreshStopProof()]);
    expect(host.read()).toMatchObject({ state: 'stopped', canStart: false });
    await checking;
    expect(observer.mock.calls).toHaveLength(1);
    expect(observer.mock.calls[0]?.[1]).toMatchObject({ action: 'process.check' });
    expect(host.read()).toMatchObject({ state: 'stopped', canStart: true, shutdown: { processTreeStopped: true } });
    expect(notices.at(-1)).toMatchObject({ instanceId: ready.instanceId, state: 'stopped', canStart: true,
      shutdown: { executionStopped: true, requiredPersistenceComplete: true, databaseClosed: true, processExited: true, processTreeStopped: true } });
  } catch (error) { failed = true; throw error; }
  finally { observer?.mockRestore(); await finishHostFixture(host, root, entry, diagnostic, failed); }
}, 30000);
test('duplicate replies arriving after request timeout remain diagnostics without retransmission or Host failure', async () => {
  const { fixture, finishHostFixture, createHostDiagnostics } = await import('../fixtures/p1-host');
  const { root, entry } = await fixture('duplicate'), diagnostic = createHostDiagnostics();
  let release: ((result: Result<unknown>) => void) | undefined, calls = 0, failed = false;
  const errors: string[] = [];
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath,
    onNotice: diagnostic.onNotice, onExit: diagnostic.onExit,
    onError: error => { errors.push(error.code); diagnostic.onError(error); },
    onCredentialRequest: async () => { calls++; return new Promise<Result<unknown>>(resolve => { release = resolve; }); } });
  try {
    const ready = await host.start(); expect(ready.state).toBe('ready');
    expect(await host.request('model.list', {}, 'original-timeout-operation')).toMatchObject({ ok: false,
      error: { code: 'host_not_ready', operationRef: 'original-timeout-operation' } });
    expect(release).toBeFunction(); expect(calls).toBe(1);
    release!({ ok: true, data: null });
    await until(async () => errors.length === 3);
    expect(errors).toEqual(['invalid_frame', 'invalid_frame', 'invalid_frame']);
    expect(host.read()).toMatchObject({ instanceId: ready.instanceId, state: 'ready', error: null });
    expect((host as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
    expect(calls).toBe(1);
  } catch (error) { failed = true; throw error; }
  finally { release?.({ ok: true, data: null }); await finishHostFixture(host, root, entry, diagnostic, failed); }
}, 60000);

test('an old credential callback cannot write its private reply into a restarted Host connection', async () => {
  const { fixture, finishHostFixture, createHostDiagnostics } = await import('../fixtures/p1-host');
  const { root, entry } = await fixture('pre-ready'), diagnostic = createHostDiagnostics();
  let held = false, release: ((result: Result<unknown>) => void) | undefined, failed = false;
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath,
    onStarting: instanceId => diagnostic.starting(instanceId, (host as unknown as { child: ChildProcessWithoutNullStreams }).child),
    onNotice: diagnostic.onNotice, onError: diagnostic.onError, onExit: diagnostic.onExit,
    onCredentialRequest: async frame => {
      if (frame.method === 'credential.read' && !held) { held = true; return new Promise<Result<unknown>>(resolve => { release = resolve; }); }
      return { ok: true, data: frame.method === 'credential.list' ? [] : null };
    } });
  const starting = host.start(); void starting.catch(() => {});
  try {
    await until(async () => held);
    const oldInstance = host.read().instanceId, child = (host as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const exited = (host as unknown as { exited: Promise<void> }).exited;
    expect(child.kill('SIGKILL')).toBe(true); await exited; await starting;
    const ready = await host.start(); expect(ready.state).toBe('ready'); expect(ready.instanceId).not.toBe(oldInstance);
    release!({ ok: true, data: null });
    expect(await host.request('model.list', {}, 'new-connection-read')).toMatchObject({ ok: true, data: { providers: [], models: [] } });
    expect(host.read()).toMatchObject({ instanceId: ready.instanceId, state: 'ready', error: null });
    expect(diagnostic.events.filter(event => event.event === 'start')).toHaveLength(2);
  } catch (error) { failed = true; throw error; }
  finally { release?.({ ok: true, data: null }); await finishHostFixture(host, root, entry, diagnostic, failed); await Promise.allSettled([starting]); }
}, 30000);

test('late ready preserves the stop-unconfirmed error and cannot reopen domain admission', async () => {
  const { fixture, finishHostFixture, createHostDiagnostics } = await import('../fixtures/p1-host');
  const { root, entry } = await fixture('late-ready'), diagnostic = createHostDiagnostics();
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath,
    onStarting: instanceId => diagnostic.starting(instanceId, (host as unknown as { child: ChildProcessWithoutNullStreams }).child),
    onNotice: diagnostic.onNotice, onError: diagnostic.onError, onExit: diagnostic.onExit });
  const starting = host.start(); void starting.catch(() => {});
  let blockedKill: ReturnType<typeof spyOn> | undefined, failed = false;
  try {
    await until(async () => existsSync(join(root, 'hello-accepted')));
    const child = (host as unknown as { child: ChildProcessWithoutNullStreams }).child;
    expect(alive(child.pid!)).toBe(true);
    expect(host.read().state).toBe('handshaking');
    blockedKill = spyOn(child, 'kill').mockReturnValue(true);
    const instanceId = host.read().instanceId!;
    expect(await host.stop(instanceId)).toMatchObject({ instanceId, state: 'stopping', canStart: false,
      error: { code: 'host_stop_unconfirmed' }, shutdown: { processExited: false, processTreeStopped: null } });
    expect(alive(child.pid!)).toBe(true);
    writeFileSync(join(root, 'emit-ready'), 'continue controlled handshake');
    expect(await starting).toMatchObject({ instanceId, state: 'stopping', canStart: false, error: { code: 'host_stop_unconfirmed' } });
    expect(await host.request('session.create', { expectedWorkspaceRevision: 0 }, 'late-stop-write')).toMatchObject({ ok: false, error: { code: 'host_not_ready' } });
    expect(diagnostic.events.filter(event => event.event === 'start')).toHaveLength(1);
  } catch (error) { failed = true; throw error; }
  finally { blockedKill?.mockRestore(); await finishHostFixture(host, root, entry, diagnostic, failed); await Promise.allSettled([starting]); }
}, 60000);

for (const { mode, afterRefusal, readerClose } of [
  { mode: 'stdout-eof', afterRefusal: false, readerClose: false },
  { mode: 'stdout-eof-after-refusal', afterRefusal: true, readerClose: false },
  { mode: 'reader-close', afterRefusal: false, readerClose: true },
]) test((readerClose ? 'reader disconnect' : 'stdout EOF') + ' closes domain admission and preserves the pending write as unknown' + (afterRefusal ? ' after a maintenance refusal' : ''), async () => {
  const { fixture, finishHostFixture, createHostDiagnostics } = await import('../fixtures/p1-host');
  const { root, entry } = await fixture(mode), diagnostic = createHostDiagnostics();
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath,
    onStarting: instanceId => diagnostic.starting(instanceId, (host as unknown as { child: ChildProcessWithoutNullStreams }).child),
    onNotice: diagnostic.onNotice, onError: diagnostic.onError, onExit: diagnostic.onExit });
  let failed = false;
  try {
    const ready = await host.start(); expect(ready.state).toBe('ready');
    if (afterRefusal) expect(await host.stop(ready.instanceId!, true)).toMatchObject({ state: 'ready', instanceId: ready.instanceId, error: { code: 'maintenance_busy' } });
    const child = (host as unknown as { child: ChildProcessWithoutNullStreams }).child;
    expect(alive(child.pid!)).toBe(true);
    const pending = host.request('session.create', { expectedWorkspaceRevision: 0 }, 'eof-write');
    if (readerClose) {
      await until(async () => existsSync(join(root, 'received.jsonl')));
      child.stdout.destroy(); await until(async () => child.stdout.closed);
    } else await until(async () => child.stdout.readableEnded);
    expect(diagnostic.transitions.some(view => view.state === 'stopping' && view.error?.code === 'host_interrupted')).toBe(true);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'operation_result_unknown', operationRef: 'eof-write' } });
    await (host as unknown as { exited: Promise<void> }).exited;
    expect(host.read()).toMatchObject({ instanceId: ready.instanceId, state: 'failed', canStart: true,
      error: { code: 'host_interrupted' }, shutdown: { processExited: true, processTreeStopped: true, requiredPersistenceComplete: null } });
    const received = readFileSync(join(root, 'received.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(received).toHaveLength(1); expect(received[0]).toMatchObject({ method: 'session.create', operationRef: 'eof-write' });
    expect(diagnostic.events.filter(event => event.event === 'start')).toHaveLength(1);
  } catch (error) { failed = true; throw error; }
  finally { await finishHostFixture(host, root, entry, diagnostic, failed); }
}, 30000);

test('Windows Job tracks the owned Host, child and grandchild and confirms their death after force kill', async () => {
  expect(process.platform).toBe('win32'); expect(process.arch).toBe('x64');
  const root = mkdtempSync(join(tmpdir(), 'MedClaw P17 进程-'));
  const owner = { instanceId: crypto.randomUUID(), startupToken: crypto.randomUUID() };
  const grandchildSource = 'console.log(process.pid);setInterval(()=>{},1000)';
  const childSource = 'const child=Bun.spawn([process.execPath,"--no-env-file","-e",' + JSON.stringify(grandchildSource) + '],{stdout:"pipe"});'
    + 'const reader=child.stdout.getReader();const {value}=await reader.read();console.log(JSON.stringify({child:process.pid,grandchild:Number(new TextDecoder().decode(value))}));setInterval(()=>{},1000);';
  const script = join(root, 'owner.ts');
  writeFileSync(script, 'const mod=await import(' + JSON.stringify(jobModule) + ').catch(()=>null);'
    + 'if(!mod){console.log(JSON.stringify({missing:true}));process.exit(0);}'
    + 'const job=mod.createHostJob(' + JSON.stringify(owner) + ');'
    + 'const child=Bun.spawn([process.execPath,"--no-env-file","-e",' + JSON.stringify(childSource) + '],{stdout:"pipe"});'
    + 'const reader=child.stdout.getReader();const {value}=await reader.read();'
    + 'console.log(JSON.stringify({domain:job.domain,count:job.readActiveProcesses(),...JSON.parse(new TextDecoder().decode(value))}));setInterval(()=>{},1000);');
  const child = Bun.spawn([process.execPath, '--no-env-file', script], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  let descendants: number[] = [], domain: unknown, failed = false;
  try {
    const reader = child.stdout.getReader(), message = await Promise.race([reader.read(), Bun.sleep(15000).then(() => { throw new Error('job_fixture_timeout'); })]);
    const ready = JSON.parse(new TextDecoder().decode(message.value));
    expect(ready.missing).not.toBe(true); descendants = [ready.child, ready.grandchild]; domain = ready.domain;
    expect(ready.count).toBe(3); expect(descendants.every(alive)).toBe(true);
    expect(await inspect(owner, ready.domain)).toBe(null);
    child.kill(); await child.exited;
    await until(async () => descendants.every(pid => !alive(pid)));
    expect(await inspect(owner, ready.domain)).toMatchObject({ instanceId: owner.instanceId, basis: 'windows_job_empty' });
  } catch (error) { failed = true; throw error; }
  finally {
    child.kill(); await child.exited;
    let stopped = false;
    try { stopped = !!domain && !!await inspect(owner, domain) && descendants.every(pid => !alive(pid)); } catch {}
    if (stopped) {
      const target = realpathSync(root);
      if (!target.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING Job cleanup root changed');
      rmSync(target, { recursive: true, force: true });
    } else {
      console.error('P17_JOB_FIXTURE_RETAINED ' + JSON.stringify({ root, instanceId: owner.instanceId }));
      if (!failed) throw new Error('ENGINEERING owned Job stop unconfirmed');
    }
  }
}, 30000);

test('the real Host retains its Job identity and confirms shutdown before a new writer can start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-real-'));
  const host = new HostController({ dataRoot: root, hostEntry: resolve(import.meta.dir, '../../apps/host/src/main.ts'), bunExecutable: process.execPath,
    onCredentialRequest: async frame => ({ ok: true, data: frame.method === 'credential.list' ? [] : frame.method === 'export.destination.settlePrevious' ? { stopped: true } : null }) });
  try {
    new MainSettings(host.paths.settingsPath).read();
    expect(await host.start()).toMatchObject({ state: 'ready', canStart: false, error: null });
    const instanceId = host.read().instanceId!;
    const installedManifest = JSON.parse(readFileSync(resolve(import.meta.dir, '../../.build/package-resources/medclaw/install.json'), 'utf8'));
    const bundledVersion = (name: string) => installedManifest.binaries.find((binary: { name: string }) => binary.name === name).version;
    const diagnostics = await host.request('diagnostics.read', { categories: ['versions'] });
    expect(diagnostics).toMatchObject({ ok: true, data: { dependencies: [
      { name: 'rg', version: bundledVersion('rg'), source: 'installed_bundle' }, { name: 'fd', version: bundledVersion('fd'), source: 'installed_bundle' },
      { name: 'bash', source: 'sdk_standard_discovery' }, { name: 'powershell', source: 'sdk_standard_discovery' },
    ] } });
    const lock = JSON.parse(readFileSync(host.paths.lockPath, 'utf8'));
    expect(lock).toMatchObject({ instanceId, processDomain: { contract: 'medclaw.host-job/v1' } });
    expect(await host.stop(instanceId)).toMatchObject({ state: 'stopped', canStart: true,
      shutdown: { executionStopped: true, requiredPersistenceComplete: true, databaseClosed: true, processExited: true, processTreeStopped: true } });
    expect(JSON.parse(readFileSync(host.paths.lockPath, 'utf8'))).toEqual(lock);
    const starts = await Promise.allSettled([host.start(), host.start()]);
    expect(starts.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(starts.filter(value => value.status === 'rejected')).toHaveLength(1);
    expect(host.read()).toMatchObject({ state: 'ready', canStart: false }); expect(host.read().instanceId).not.toBe(instanceId);
  } finally {
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    rmSync(root, { recursive: true, force: true });
  }
}, 45000);

test('normal Host exit stays stopping until its retained ownership and tree can be verified', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-stop-proof-'));
  let savedLock: string | undefined, exited = false;
  const host = new HostController({ dataRoot: root, hostEntry: resolve(import.meta.dir, '../../apps/host/src/main.ts'), bunExecutable: process.execPath,
    onExit: () => { exited = true; if (savedLock) writeFileSync(host.paths.lockPath, '{unreadable-original-owner'); },
    onCredentialRequest: async frame => ({ ok: true, data: frame.method === 'credential.list' ? [] : frame.method === 'export.destination.settlePrevious' ? { stopped: true } : null }) });
  try {
    new MainSettings(host.paths.settingsPath).read();
    const ready = await host.start(); expect(ready.state).toBe('ready');
    savedLock = readFileSync(host.paths.lockPath, 'utf8');
    const stopped = await host.stop(ready.instanceId!);
    expect(stopped).toMatchObject({ state: 'stopping', canStart: false, error: { code: 'host_stop_unconfirmed' },
      shutdown: { executionStopped: true, requiredPersistenceComplete: true, databaseClosed: true, processExited: true, processTreeStopped: null } });
    expect(exited).toBe(true);
    expect(await host.start()).toMatchObject({ instanceId: ready.instanceId, state: 'stopping', canStart: false, error: { code: 'host_stop_unconfirmed' } });
    writeFileSync(host.paths.lockPath, savedLock); await host.refreshStopProof();
    expect(host.read()).toMatchObject({ state: 'stopped', canStart: true, error: null, shutdown: { processTreeStopped: true } });
  } finally {
    if (host.read().instanceId && !exited) await host.stop(host.read().instanceId!);
    if (exited && savedLock) { writeFileSync(host.paths.lockPath, savedLock); await host.refreshStopProof(); }
    if (host.read().canStart) rmSync(root, { recursive: true, force: true });
  }
}, 45000);

test('a controlled Host close with a remaining real Job member cannot admit a second writer', async () => {
  const { fixture, finishHostFixture, createHostDiagnostics } = await import('../fixtures/p1-host');
  const { root, entry } = await fixture(), diagnostic = createHostDiagnostics();
  const kernel = dlopen(join(process.env.SystemRoot!, 'System32/kernel32.dll'), {
    OpenJobObjectW: { args: ['u32', 'bool', 'ptr'], returns: 'u64' },
    OpenProcess: { args: ['u32', 'bool', 'u32'], returns: 'u64' },
    AssignProcessToJobObject: { args: ['u64', 'u64'], returns: 'bool' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
  }).symbols;
  let handle: number | bigint = 0, member: ReturnType<typeof Bun.spawn> | undefined, failed = false;
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath,
    onStarting: instanceId => diagnostic.starting(instanceId, (host as unknown as { child: ChildProcessWithoutNullStreams }).child),
    onNotice: diagnostic.onNotice, onError: diagnostic.onError, onExit: diagnostic.onExit });
  try {
    const ready = await host.start(); expect(ready.state).toBe('ready');
    const bytes = readFileSync(host.paths.lockPath, 'utf8'), owner = JSON.parse(bytes);
    expect(owner).toMatchObject({ pid: (host as unknown as { child: ChildProcessWithoutNullStreams }).child.pid,
      instanceId: ready.instanceId, processDomain: { jobName: 'Local\\MedClaw.' + ready.instanceId + '.' + owner.startupToken } });
    const name = Buffer.from(owner.processDomain.jobName + '\0', 'utf16le');
    handle = kernel.OpenJobObjectW(4 | 1, false, ptr(name)); expect(BigInt(handle)).not.toBe(0n);
    // A captured test process and retained handle make the late-member failure window deterministic.
    member = Bun.spawn([process.execPath, '--no-env-file', '-e', 'setInterval(()=>{},1000)'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    const processHandle = kernel.OpenProcess(0x100 | 1, false, member.pid);
    expect(BigInt(processHandle)).not.toBe(0n);
    try { expect(kernel.AssignProcessToJobObject(handle, processHandle)).toBe(true); }
    finally { kernel.CloseHandle(processHandle); }
    expect(await host.stop(ready.instanceId!)).toMatchObject({ instanceId: ready.instanceId, state: 'stopping', canStart: false,
      error: { code: 'host_stop_unconfirmed' }, shutdown: { executionStopped: true, requiredPersistenceComplete: true,
        databaseClosed: true, processExited: true, processTreeStopped: null } });
    expect(member.exitCode).toBe(null); expect(await inspect(owner, owner.processDomain)).toBe(null);
    expect(await host.start()).toMatchObject({ instanceId: ready.instanceId, state: 'stopping', canStart: false });
    expect(diagnostic.events.filter(event => event.event === 'start')).toHaveLength(1);
    expect(readFileSync(host.paths.lockPath, 'utf8')).toBe(bytes);
    member.kill(); await member.exited;
    await host.refreshStopProof();
    expect(host.read()).toMatchObject({ instanceId: ready.instanceId, state: 'stopped', canStart: true,
      error: null, shutdown: { processTreeStopped: true } });
    expect(diagnostic.events.filter(event => event.event === 'start')).toHaveLength(1);
    expect(readFileSync(host.paths.lockPath, 'utf8')).toBe(bytes);
  } catch (error) { failed = true; throw error; }
  finally {
    if (member) { member.kill(); await member.exited; }
    if (handle) kernel.CloseHandle(handle);
    await host.refreshStopProof();
    await finishHostFixture(host, root, entry, diagnostic, failed);
  }
}, 30000);

test('a real Job query access denial keeps a cleanly exited Host stopping until the original Job can be inspected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-job-access-'));
  const kernel = dlopen(join(process.env.SystemRoot!, 'System32/kernel32.dll'), {
    OpenJobObjectW: { args: ['u32', 'bool', 'ptr'], returns: 'u64' },
    GetLastError: { args: [], returns: 'u32' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
    LocalFree: { args: ['u64'], returns: 'u64' },
  }).symbols;
  const security = dlopen(join(process.env.SystemRoot!, 'System32/advapi32.dll'), {
    GetKernelObjectSecurity: { args: ['u64', 'u32', 'ptr', 'u32', 'ptr'], returns: 'bool' },
    SetKernelObjectSecurity: { args: ['u64', 'u32', 'ptr'], returns: 'bool' },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ['ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
  }).symbols;
  let handle: number | bigint = 0, original: Buffer | undefined, descriptor = 0, denied = false, starts = 0, failed = false;
  const host = new HostController({ dataRoot: root, hostEntry: resolve(import.meta.dir, '../../apps/host/src/main.ts'), bunExecutable: process.execPath,
    onStarting: () => { starts++; },
    onCredentialRequest: async frame => ({ ok: true, data: frame.method === 'credential.list' ? [] : frame.method === 'export.destination.settlePrevious' ? { stopped: true } : null }) });
  try {
    new MainSettings(host.paths.settingsPath).read();
    const ready = await host.start(); expect(ready.state).toBe('ready');
    const bytes = readFileSync(host.paths.lockPath, 'utf8'), owner = JSON.parse(bytes);
    expect(owner).toMatchObject({ pid: (host as unknown as { child: ChildProcessWithoutNullStreams }).child.pid,
      instanceId: ready.instanceId, processDomain: { jobName: 'Local\\MedClaw.' + ready.instanceId + '.' + owner.startupToken } });
    const name = Buffer.from(owner.processDomain.jobName + '\0', 'utf16le');
    // Retain only this test's Job so an empty-but-inaccessible Job still exists after its Host exits.
    handle = kernel.OpenJobObjectW(0x20000 | 0x40000 | 4, false, ptr(name));
    expect(BigInt(handle)).not.toBe(0n);
    const length = Buffer.alloc(4);
    expect(security.GetKernelObjectSecurity(handle, 4, null, 0, ptr(length))).toBe(false);
    expect(length.readUInt32LE()).toBeGreaterThan(0);
    original = Buffer.alloc(length.readUInt32LE());
    expect(security.GetKernelObjectSecurity(handle, 4, ptr(original), original.length, ptr(length))).toBe(true);
    const encoded = Buffer.from('D:(D;;0x0004;;;WD)\0', 'utf16le'), converted = Buffer.alloc(8);
    expect(security.ConvertStringSecurityDescriptorToSecurityDescriptorW(ptr(encoded), 1, ptr(converted), null)).toBe(true);
    descriptor = Number(converted.readBigUInt64LE());
    expect(security.SetKernelObjectSecurity(handle, 4, descriptor)).toBe(true); denied = true;
    const query = kernel.OpenJobObjectW(4, false, ptr(name));
    const queryError = kernel.GetLastError();
    if (query) kernel.CloseHandle(query);
    expect(BigInt(query)).toBe(0n); expect(queryError).toBe(5);
    await expect(inspect(owner, owner.processDomain)).rejects.toThrow('host_stop_unconfirmed');
    expect(await host.stop(ready.instanceId!)).toMatchObject({ instanceId: ready.instanceId, state: 'stopping', canStart: false,
      error: { code: 'host_stop_unconfirmed' }, shutdown: { executionStopped: true, requiredPersistenceComplete: true,
        databaseClosed: true, processExited: true, processTreeStopped: null } });
    expect(readFileSync(host.paths.lockPath, 'utf8')).toBe(bytes);
    expect(await host.start()).toMatchObject({ instanceId: ready.instanceId, state: 'stopping', canStart: false });
    expect(starts).toBe(1);
    expect(security.SetKernelObjectSecurity(handle, 4, ptr(original))).toBe(true); denied = false;
    expect(await inspect(owner, owner.processDomain)).toMatchObject({ instanceId: ready.instanceId, basis: 'windows_job_empty' });
    await host.refreshStopProof();
    expect(host.read()).toMatchObject({ instanceId: ready.instanceId, state: 'stopped', canStart: true,
      error: null, shutdown: { processTreeStopped: true } });
    expect(starts).toBe(1); expect(readFileSync(host.paths.lockPath, 'utf8')).toBe(bytes);
  } catch (error) { failed = true; throw error; }
  finally {
    if (denied && original && !security.SetKernelObjectSecurity(handle, 4, ptr(original))) {
      console.error('P17_JOB_ACCESS_FIXTURE_RETAINED ' + JSON.stringify({ root, instanceId: host.read().instanceId }));
      if (!failed) throw new Error('ENGINEERING owned Job security restoration unconfirmed');
    } else {
      if (descriptor) kernel.LocalFree(descriptor);
      if (handle) kernel.CloseHandle(handle);
      if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
      await host.refreshStopProof();
      if (host.read().canStart) {
        const target = realpathSync(root);
        if (!target.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING Job cleanup root changed');
        rmSync(target, { recursive: true, force: true });
      } else {
        console.error('P17_JOB_ACCESS_FIXTURE_RETAINED ' + JSON.stringify({ root, instanceId: host.read().instanceId }));
        if (!failed) throw new Error('ENGINEERING owned Job stop unconfirmed');
      }
    }
  }
}, 45000);

for (const mode of ['alias', 'missing'] as const) test(`PowerShell ${mode === 'alias' ? 'uses the original SDK path when realpath is denied' : 'must execute successfully before SQLite opens or Host becomes ready'}`, async () => {
  const { finishHostFixture, createHostDiagnostics } = await import('../fixtures/p1-host');
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-powershell-')), entry = join(root, 'host-entry.ts'), diagnostic = createHostDiagnostics();
  const shellModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'utils/shell.js')).href;
  const selected = (await import(shellModule)).getPowerShellConfig();
  // Mock only this owned Host process; the successful case still executes real PowerShell with SDK arguments.
  writeFileSync(entry, `import {mock} from 'bun:test';
const fs = await import('node:fs/promises'), originalRealpath = fs.realpath;
const shell = await import(${JSON.stringify(shellModule)}), selected = shell.getPowerShellConfig();
${mode === 'alias' ? `mock.module('node:fs/promises', () => ({...fs, realpath: async (path, options) => {
  if (String(path) === selected.shell) throw Object.assign(new Error('ENGINEERING alias cannot be canonicalized'), {code:'EACCES'});
  return originalRealpath(path, options);
}}));` : `mock.module(${JSON.stringify(shellModule)}, () => ({...shell, getPowerShellConfig: () => ({...selected, shell:${JSON.stringify(join(root, 'missing-pwsh.exe'))}})}));`}
await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../../apps/host/src/main.ts')).href)});
`);
  const failures: unknown[] = [];
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath,
    onStartupFailure: value => failures.push(value), onNotice: diagnostic.onNotice, onError: diagnostic.onError, onExit: diagnostic.onExit,
    onStarting: instanceId => diagnostic.starting(instanceId, (host as unknown as { child: ChildProcessWithoutNullStreams }).child),
    onCredentialRequest: async frame => ({ ok: true, data: frame.method === 'credential.list' ? [] : frame.method === 'export.destination.settlePrevious' ? { stopped: true } : null }) });
  let failed = false;
  try {
    new MainSettings(host.paths.settingsPath).read();
    const state = await host.start();
    if (mode === 'alias') {
      expect(state).toMatchObject({ state: 'ready', error: null });
      expect(await host.request('diagnostics.read', { categories: ['versions'] })).toMatchObject({ ok: true, data: { dependencies: [
        { name: 'rg', source: 'installed_bundle' }, { name: 'fd', source: 'installed_bundle' },
        { name: 'bash', source: 'sdk_standard_discovery' }, { name: 'powershell', path: selected.shell, source: 'sdk_standard_discovery' },
      ] } });
      expect(failures).toEqual([]);
    } else {
      expect(state).toMatchObject({ state: 'failed', error: { code: 'host_dependency_unavailable', reason: 'dependency_powershell_unavailable' } });
      expect(failures).toMatchObject([{ phase: 'native_dependencies', error: { code: 'host_dependency_unavailable', reason: 'dependency_powershell_unavailable' } }]);
      expect(await Bun.file(host.paths.databasePath).exists()).toBe(false);
      expect(diagnostic.transitions.some(value => value.state === 'ready')).toBe(false);
    }
  } catch (error) { failed = true; throw error; }
  finally { await finishHostFixture(host, root, entry, diagnostic, failed); }
}, 30000);

test('missing bundled native tools fail before opening SQLite and report a safe dependency reason', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-missing-dependency-')), manifestPath = join(root, 'install.json');
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, '../../.build/package-resources/medclaw/install.json'), 'utf8'));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, binaries: manifest.binaries.filter((binary: { name: string }) => binary.name === 'bun') }));
  const failures: unknown[] = [];
  const host = new HostController({ dataRoot: root, hostEntry: resolve(import.meta.dir, '../../apps/host/src/main.ts'), bunExecutable: process.execPath,
    installManifestPath: manifestPath, onStartupFailure: value => failures.push(value),
    onCredentialRequest: async frame => ({ ok: true, data: frame.method === 'credential.list' ? [] : frame.method === 'export.destination.settlePrevious' ? { stopped: true } : null }) });
  try {
    new MainSettings(host.paths.settingsPath).read();
    expect(await host.start()).toMatchObject({ state: 'failed', error: { code: 'host_dependency_unavailable', reason: 'dependency_rg_unavailable' } });
    expect(failures).toMatchObject([{ phase: 'native_dependencies', error: { code: 'host_dependency_unavailable', reason: 'dependency_rg_unavailable' } }]);
    expect(await Bun.file(host.paths.databasePath).exists()).toBe(false);
  } finally {
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('a failed new Host cannot inherit an older ownership tree proof', async () => {
  const { fixture, finishHostFixture, createHostDiagnostics } = await import('../fixtures/p1-host');
  const { root, entry } = await fixture('reject-restart'), diagnostic = createHostDiagnostics();
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath });
  let failed = false;
  try {
    const ready = await host.start(); expect(ready.state).toBe('ready');
    expect(await host.stop(ready.instanceId!)).toMatchObject({ state: 'stopped', shutdown: { processTreeStopped: true } });
    const rejected = await host.start();
    expect(rejected.instanceId).not.toBe(ready.instanceId);
    expect(rejected).toMatchObject({ state: 'failed', canStart: true, shutdown: { processExited: true, processTreeStopped: null } });
  } catch (error) { failed = true; throw error; }
  finally { await finishHostFixture(host, root, entry, diagnostic, failed); }
}, 30000);

test('a blocked SDK cache preserves the obstruction and reports storage failure before SQLite opens', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-sdk-storage-'));
  const host = new HostController({ dataRoot: root, hostEntry: resolve(import.meta.dir, '../../apps/host/src/main.ts'), bunExecutable: process.execPath });
  const obstruction = join(root, 'runtime/sdk/bin'); mkdirSync(join(root, 'runtime/sdk')); writeFileSync(obstruction, 'ENGINEERING owned obstruction');
  try {
    new MainSettings(host.paths.settingsPath).read();
    expect(await host.start()).toMatchObject({ state: 'failed', error: { code: 'storage_write_failed' } });
    expect(readFileSync(obstruction, 'utf8')).toBe('ENGINEERING owned obstruction');
    expect(await Bun.file(host.paths.databasePath).exists()).toBe(false);
  } finally {
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('the evaluation ProductAdapter records actual tree stop and required-save proof for its owned Host', async () => {
  const { ProductAdapter } = await import('../../agent-eval/src/adapters/product');
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-evaluation-stop-'));
  const adapter = new ProductAdapter({ dataRoot: root, tracePath: join(root, 'trace.jsonl') });
  try {
    mkdirSync(join(root, 'data'));
    new MainSettings(join(root, 'data/settings.json')).read();
    await adapter.start();
    expect(await adapter.stop()).toMatchObject({ stopped: true, closed: true, processExited: true,
      processTreeStopped: true, requiredPersistenceComplete: true, residuals: [] });
  } finally { await adapter.stop(); rmSync(root, { recursive: true, force: true }); }
}, 45000);

test('exclusive writer ownership survives stale-lock takeover and rejects concurrent or unrelated writers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-lock-')), lockPath = join(root, 'host.lock');
  const module = pathToFileURL(resolve(import.meta.dir, '../../apps/host/src/writer-lock.ts')).href;
  const owner = { instanceId: crypto.randomUUID(), startupToken: crypto.randomUUID() };
  const worker = (identity: typeof owner, stay: boolean) => Bun.spawn([process.execPath, '--no-env-file', '-e',
    'try{const mod=await import(' + JSON.stringify(module) + ').catch(()=>null);if(!mod){console.log(JSON.stringify({missing:true}));process.exit(0);}'
    + 'const {createHostJob}=await import(' + JSON.stringify(jobModule) + ');const owner=' + JSON.stringify(identity) + ';'
    + 'const job=createHostJob(owner);const lease=await mod.acquireWriterLock({lockPath:' + JSON.stringify(lockPath) + ',owner,processDomain:job.domain});'
    + 'console.log(JSON.stringify({acquired:true,previous:lease.previous,proof:lease.processTreeProof}));'
    + (stay ? 'setInterval(()=>{},1000);' : 'lease.release();')
    + '}catch(e){console.log(JSON.stringify({error:e.message}));}'], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const first = worker(owner, true);
  try {
    const reader = first.stdout.getReader(), value = await reader.read(), ready = JSON.parse(new TextDecoder().decode(value.value));
    expect(ready.acquired).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ ...owner, processDomain: { contract: 'medclaw.host-job/v1' } });
    const second = worker({ instanceId: crypto.randomUUID(), startupToken: crypto.randomUUID() }, false);
    const rejected = JSON.parse(await new Response(second.stdout).text()); await second.exited;
    expect(rejected).toEqual({ error: 'host_stop_unconfirmed' });
    first.kill(); await first.exited;
    const priorOwner = JSON.parse(readFileSync(lockPath, 'utf8'));
    writeFileSync(lockPath, JSON.stringify({ ...priorOwner, pid: process.pid }));
    const takeover = worker({ instanceId: crypto.randomUUID(), startupToken: crypto.randomUUID() }, false);
    const result = JSON.parse(await new Response(takeover.stdout).text()); expect(await takeover.exited).toBe(0);
    expect(result.acquired).toBe(true); expect(result.previous).toMatchObject(owner);
    expect(result.proof).toMatchObject({ instanceId: owner.instanceId, basis: 'windows_job_empty' });
    expect(alive(process.pid)).toBe(true);
    const saved = JSON.parse(readFileSync(lockPath, 'utf8')); expect(saved.instanceId).not.toBe(owner.instanceId);
  } finally { first.kill(); await first.exited; rmSync(root, { recursive: true, force: true }); }
}, 40000);

test('the private maintenance worker checks legacy ownership without inventing tree proof or opening a database', async () => {
  const module = await import('../../apps/desktop/src/main/maintenance-controller').catch(() => null);
  expect(module?.requestMaintenance).toBeFunction();
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-legacy-'));
  try {
    const ended = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' }); await ended.exited;
    const owner = { instanceId: crypto.randomUUID(), startupToken: crypto.randomUUID() }, lockPath = join(root, 'host.lock');
    writeFileSync(lockPath, JSON.stringify({ ...owner, pid: ended.pid }));
    const options = { bunExecutable: process.execPath, maintenanceEntry: resolve(import.meta.dir, '../../apps/host/src/maintenance.ts') };
    const result = await module!.requestMaintenance(options, { action: 'process.check', owner, lockPath }, crypto.randomUUID());
    expect(result).toMatchObject({ ok: true, data: { stopped: false, processTreeProof: null, canPrepareRecovery: true } });
    expect(readFileSync(lockPath, 'utf8')).toBe(JSON.stringify({ ...owner, pid: ended.pid }));
    const wrong = await module!.requestMaintenance(options, { action: 'process.check', owner: { ...owner, startupToken: 'wrong' }, lockPath }, crypto.randomUUID());
    expect(wrong).toMatchObject({ ok: false, error: { code: 'host_stop_unconfirmed' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('Main prepares a legacy restart observation once without admitting a Host or initializing SQLite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-legacy-prepare-'));
  let starts = 0, failed = false;
  const host = new HostController({ dataRoot: root, hostEntry: resolve(import.meta.dir, '../../apps/host/src/main.ts'),
    bunExecutable: process.execPath, onStarting: () => { starts++; } });
  try {
    const ended = Bun.spawn([process.execPath, '--no-env-file', '-e', ''], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    expect(await ended.exited).toBe(0);
    const owner = { instanceId: crypto.randomUUID(), startupToken: crypto.randomUUID(), pid: ended.pid };
    const original = JSON.stringify(owner); writeFileSync(host.paths.lockPath, original);
    await host.refreshStopProof();
    expect(host.read()).toMatchObject({ instanceId: null, canStart: false, canPrepareRecovery: true });
    expect(readFileSync(host.paths.lockPath, 'utf8')).toBe(original);
    expect(await host.prepareRecovery()).toMatchObject({ instanceId: null, canStart: false, canPrepareRecovery: true });
    const preparedBytes = readFileSync(host.paths.lockPath, 'utf8');
    expect(WriterLockRecordSchema.parse(JSON.parse(preparedBytes))).toEqual({ ...owner, recoveryBootMarker: expect.any(String) });
    expect(await host.prepareRecovery()).toMatchObject({ instanceId: null, canStart: false, canPrepareRecovery: true });
    expect(readFileSync(host.paths.lockPath, 'utf8')).toBe(preparedBytes);
    expect(await host.start()).toMatchObject({ instanceId: null, state: 'failed', canStart: false,
      canPrepareRecovery: true, error: { code: 'host_stop_unconfirmed' } });
    expect(starts).toBe(0); expect(host.read().shutdown).toBeUndefined();
    expect(readFileSync(host.paths.lockPath, 'utf8')).toBe(preparedBytes);
    expect(existsSync(host.paths.databasePath)).toBe(false); expect(existsSync(host.paths.settingsPath)).toBe(false);
  } catch (error) { failed = true; throw error; }
  finally {
    const view = host.read();
    if (view.instanceId && !view.canStart) { try { await host.stop(view.instanceId); } catch {} }
    // A failed maintenance observation may still own its file; preserve that root instead of guessing.
    if (!failed && starts === 0) {
      const target = realpathSync(root);
      if (!target.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING legacy cleanup root changed');
      rmSync(target, { recursive: true, force: true });
    } else console.error('P17_LEGACY_PREPARE_FIXTURE_RETAINED ' + JSON.stringify({ root, instanceId: view.instanceId }));
  }
}, 45000);

test('legacy preparation preserves its record on wrong ownership, PID reuse and an unavailable boot observation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-legacy-refusal-'));
  const module = pathToFileURL(resolve(import.meta.dir, '../../apps/host/src/writer-lock.ts')).href;
  const lockPath = join(root, 'host.lock'), systemRoot = process.env.SystemRoot;
  let child: ReturnType<typeof Bun.spawn> | undefined, failed = false;
  try {
    const ended = Bun.spawn([process.execPath, '--no-env-file', '-e', ''], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    expect(await ended.exited).toBe(0);
    const owner = { instanceId: crypto.randomUUID(), startupToken: crypto.randomUUID() };
    for (const scenario of ['wrong-owner', 'live-pid', 'missing-boot-source']) {
      const original = JSON.stringify({ ...owner, pid: scenario === 'live-pid' ? process.pid : ended.pid });
      writeFileSync(lockPath, original);
      const input = { module, lockPath, owner, scenario, missingWindows: join(root, 'missing-windows') };
      const script = 'const input=' + JSON.stringify(input) + ';const mod=await import(input.module);let kernelReady=false;'
        + 'if(input.scenario==="missing-boot-source"){const checked=mod.inspectWriterLock(input.lockPath,input.owner);'
        + 'if(!checked.canPrepareRecovery)throw new Error("ENGINEERING legacy precondition changed");kernelReady=true;process.env.SystemRoot=input.missingWindows;}'
        + 'let code=null;try{mod.prepareRestartRecovery(input.lockPath,input.scenario==="wrong-owner"?{...input.owner,startupToken:"wrong"}:input.owner);}'
        + 'catch(error){code=error.message;}console.log(JSON.stringify({code,kernelReady}));';
      const worker = Bun.spawn([process.execPath, '--no-env-file', '-e', script], { stdout: 'pipe', stderr: 'pipe', windowsHide: true }); child = worker;
      const output = await new Response(worker.stdout).text(); expect(await worker.exited).toBe(0);
      expect(JSON.parse(output)).toEqual({ code: 'host_stop_unconfirmed', kernelReady: scenario === 'missing-boot-source' });
      expect(readFileSync(lockPath, 'utf8')).toBe(original);
      expect(existsSync(join(root, 'data/app.sqlite'))).toBe(false);
      expect(process.env.SystemRoot).toBe(systemRoot); expect(alive(process.pid)).toBe(true);
    }
  } catch (error) { failed = true; throw error; }
  finally {
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    if (!failed) {
      const target = realpathSync(root);
      if (!target.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING legacy cleanup root changed');
      rmSync(target, { recursive: true, force: true });
    } else console.error('P17_LEGACY_REFUSAL_FIXTURE_RETAINED ' + JSON.stringify({ root }));
  }
}, 30000);

test('a maintenance shutdown refusal keeps the same Host alive and requires an explicit ordinary stop', async () => {
  const { fixture } = await import('../fixtures/p1-host');
  const { root, entry } = await fixture('maintenance-refusal');
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath });
  try {
    const started = await host.start(); expect(started.state).toBe('ready');
    const refused = await host.stop(started.instanceId!, true);
    expect(refused).toMatchObject({ state: 'ready', instanceId: started.instanceId, canStart: false, error: { code: 'maintenance_busy' } });
    expect((await host.stop(started.instanceId!)).state).toBe('stopped');
  } finally { const view = host.read(); if (view.instanceId && !view.canStart) await host.stop(view.instanceId); rmSync(root, { recursive: true, force: true }); }
}, 30000);
