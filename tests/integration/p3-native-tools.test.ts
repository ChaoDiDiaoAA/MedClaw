import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, VERSION, type ToolsOptions } from '@earendil-works/pi-coding-agent';
import { safeError } from '../../packages/contracts/src/error';
import { canonicalRequest } from '../../packages/contracts/src/run';
import { ToolSdkDeliverySchema, type ToolCallIdentity, type ToolCallRecord, type ToolCallStore, type ToolExecutionContext, type ToolResult, type ToolSdkDelivery } from '../../packages/contracts/src/tool';
import { ToolRecorder } from '../../packages/core/src/tools/recorder';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
const names = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'powershell'];
type Call = { name: string; args: Record<string, unknown>; id?: string };
class Calls implements ToolCallStore {
  rows = new Map<string, ToolCallRecord>();
  transitions: string[] = [];
  fail: 'request' | 'finish' | 'delivery' | null = null;
  assertContext(ctx: ToolExecutionContext) {
    if (ctx.runId !== 81 || ctx.sessionId !== 19 || ctx.referenceDate !== '2026-10-02') throw safeError('access_denied');
  }
  readCall(ctx: ToolExecutionContext) { this.assertContext(ctx); return this.rows.get(ctx.nativeToolCallId) ?? null; }
  request(tool: ToolCallIdentity, input: unknown, ctx: ToolExecutionContext) {
    this.assertContext(ctx);
    if (this.fail === 'request') throw new Error('storage_write_failed');
    const prior = this.readCall(ctx);
    if (prior) {
      if (prior.name !== tool.name || prior.version !== tool.version || canonicalRequest(prior.input) !== canonicalRequest(input)) throw safeError('state_conflict');
      return prior;
    }
    const row: ToolCallRecord = { id: this.rows.size + 1, runId: ctx.runId, sessionId: ctx.sessionId, nativeToolCallId: ctx.nativeToolCallId,
      name: tool.name, version: tool.version, executionMode: tool.executionMode, input: structuredClone(input), status: 'requested', data: null,
      error: null, sdkReturned: false, nativeEntryId: null };
    this.rows.set(ctx.nativeToolCallId, row); this.transitions.push(`${tool.name}:requested`); return row;
  }
  transition(id: number, from: ToolCallRecord['status'], to: ToolCallRecord['status'], result?: ToolResult<unknown>) {
    if (this.fail === 'finish' && to !== 'running') throw new Error('storage_write_failed');
    const row = [...this.rows.values()].find(row => row.id === id);
    if (!row || row.status !== from) throw safeError('state_conflict');
    row.status = to; row.data = structuredClone(result?.data ?? null); row.error = result && result.status !== 'succeeded' ? result.error : null;
    this.transitions.push(`${row.name}:${to}`); return row;
  }
  recordDelivery(ctx: ToolExecutionContext, nativeEntryId: string, message?: ToolSdkDelivery) {
    if (this.fail === 'delivery') throw new Error('storage_write_failed');
    const row = this.readCall(ctx);
    if (!row || row.status === 'running' || row.status === 'requested') throw safeError('state_conflict');
    if (row.sdkReturned) { if (row.nativeEntryId !== nativeEntryId) throw safeError('state_conflict'); return; }
    row.sdkReturned = true; row.nativeEntryId = nativeEntryId;
    if (message) row.sdkDelivery = ToolSdkDeliverySchema.parse(structuredClone(message));
  }
}

async function setup(calls: Call[], options: ToolsOptions = {}, repeat = false) {
  const adapter = await import('../../packages/runtime-pi/src/pi-tool-adapter');
  expect(adapter.createPiNativeTools).toBeFunction();
  const root = await mkdtemp(join(tmpdir(), 'medclaw-native-'));
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>);
    const delta = requests.length === 1 || repeat && requests.length === 3
      ? { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id ?? `native-${index + 1}`, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
      : { role: 'assistant', content: 'done' };
    return new Response(`data: ${JSON.stringify({ id: 'native-fixture', choices: [{ index: 0, delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  closers.push(async () => { server.stop(true); const target = resolve(root); if (!target.startsWith(resolve(tmpdir()))) throw new Error('unsafe cleanup'); await rm(target, { recursive: true, force: true }); });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('native-fixture', async () => ({ type: 'api_key', key: 'fixture-only' }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  await runtime.installCustom([{ providerId: 'native-fixture', name: 'Native fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`,
    models: [{ id: 'fixture', name: 'fixture', input: ['text', 'image'], reasoning: false, contextWindow: 32768, maxTokens: 1024,
      outputLimitConfirmed: true, pricingKnown: false, cost: null }] }]);
  const model = await runtime.resolve({ provider: 'native-fixture', modelId: 'fixture', expectedConfigVersion: '1' }, '1', null,
    { timeoutMs: 5000, maxRetries: 0, maxRetryDelayMs: 2000 });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', defaultTools: [],
    packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false, enableInstallTelemetry: false });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'pi'), settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Use the supplied native tools.' });
  await resourceLoader.reload();
  let abortSession: (() => void) | undefined;
  const store = new Calls(), recorder = new ToolRecorder(store, () => abortSession?.()), abort = new AbortController();
  const getContext = (nativeToolCallId: string, signal?: AbortSignal): ToolExecutionContext => ({ runId: 81, sessionId: 19, nativeToolCallId,
    scope: { batchIds: [], deviceIds: null, allowedToolNames: names, allowedResourceRefs: [], artifactIds: [], readOnly: false },
    referenceDate: '2026-10-02', timezone: 'Asia/Shanghai', signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal });
  let workdir: string | undefined;
  const native = adapter.createPiNativeTools(() => { if (!workdir) throw new Error('Run workdir is not bound yet'); return workdir; }, recorder, getContext, options);
  const { session } = await createAgentSession({ cwd: root, agentDir: join(root, 'pi'), modelRuntime: runtime.native, model: model.model,
    thinkingLevel: 'off', tools: names, customTools: native.definitions, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) });
  session.agent.toolExecution = 'sequential';
  workdir = root;
  abortSession = () => { void session.abort(); };
  const unsubscribe = native.bind(session);
  closers.unshift(async () => { await session.abort(); await session.waitForIdle(); unsubscribe(); session.dispose(); });
  return { root, session, store, requests, native, recorder, getContext, setWorkdir(value: string) { workdir = value; } };
}

test('Pi executes all eight native definitions with real files, shell commands, and SDK receipts', async () => {
  const previousOffline = process.env.PI_OFFLINE; process.env.PI_OFFLINE = '1';
  closers.push(async () => { if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline; });
  const git = Bun.which('git'), gitBash = git && join(dirname(git), '..', 'bin', 'bash.exe');
  const c = await setup([
    { name: 'write', args: { path: 'sample.txt', content: 'alpha\nbeta\n' } },
    { name: 'read', args: { path: 'sample.txt' } },
    { name: 'grep', args: { pattern: 'alpha', path: '.' } },
    { name: 'find', args: { pattern: '*.txt', path: '.' } },
    { name: 'ls', args: { path: '.' } },
    { name: 'edit', args: { path: 'sample.txt', oldText: 'alpha', newText: 'edited' } },
    { name: 'bash', args: { command: "printf 'bash-native\\n' > bash.txt; printf 'bash-native\\n'", timeout: 2 } },
    { name: 'powershell', args: { command: "Set-Content -LiteralPath powershell.txt -Value 'powershell-native'; Write-Output 'powershell-native'", timeout: 2 } },
  ], gitBash && await Bun.file(gitBash).exists() ? { bash: { shellPath: gitBash } } : {});
  await c.session.prompt('Execute the native tool sequence.');
  expect(c.requests).toHaveLength(2);
  expect(await readFile(join(c.root, 'sample.txt'), 'utf8')).toBe('edited\nbeta\n');
  const rows = [...c.store.rows.values()];
  expect(rows).toHaveLength(8);
  for (const row of rows) {
    expect(row.version).toBe(VERSION); expect(row.sdkReturned).toBe(true); expect(row.sdkDelivery?.toolName).toBe(row.name);
    expect(c.store.transitions).toContain(`${row.name}:running`);
    expect(c.session.sessionManager.getEntry(row.nativeEntryId!)).toMatchObject({ type: 'message', message: { role: 'toolResult', toolName: row.name } });
  }
  const read = rows.find(row => row.name === 'read')!;
  expect(read.sdkDelivery).toMatchObject({ isError: false, content: [{ type: 'text', text: 'alpha\nbeta\n' }] });
  if (process.platform === 'win32') expect(rows.find(row => row.name === 'powershell')!.status).toBe('succeeded');
  if (gitBash && await Bun.file(gitBash).exists()) expect(rows.find(row => row.name === 'bash')!.status).toBe('succeeded');
  for (const [name, file, output] of [['bash', 'bash.txt', 'bash-native'], ['powershell', 'powershell.txt', 'powershell-native']]) {
    const row = rows.find(row => row.name === name)!;
    if (row.status === 'succeeded') expect(await readFile(join(c.root, file!), 'utf8')).toContain(output!);
    else expect(row.sdkDelivery?.isError).toBe(true);
  }
  const find = rows.find(row => row.name === 'find')!;
  if (find.status === 'failed') expect(JSON.stringify(find.sdkDelivery)).toContain('fd is not available');
  else expect(JSON.stringify(find.sdkDelivery)).toContain('sample.txt');
  expect(JSON.stringify(rows.find(row => row.name === 'grep')!.sdkDelivery)).toContain('sample.txt');
}, 20000);

test('native write replay returns its saved SDK result without repeating the file side effect', async () => {
  const c = await setup([{ name: 'write', args: { path: 'replay.txt', content: 'original' } }], {}, true);
  await c.session.prompt('Write the file.');
  const original = structuredClone([...c.store.rows.values()][0]!);
  await writeFile(join(c.root, 'replay.txt'), 'changed externally');
  await c.session.prompt('Replay the same call identity.');
  expect(await readFile(join(c.root, 'replay.txt'), 'utf8')).toBe('changed externally');
  expect([...c.store.rows.values()]).toEqual([original]);
  expect(c.requests).toHaveLength(4);
});

test('SDK schema and hook refusals are recorded without running native write', async () => {
  const c = await setup([{ name: 'read', args: {} }, { name: 'write', args: { path: 'refused.txt', content: 'blocked' } }]);
  const original = c.session.agent.beforeToolCall;
  c.session.agent.beforeToolCall = async (context, signal) => context.toolCall.name === 'write'
    ? { block: true, reason: 'fixture hook refusal' } : original?.(context, signal);
  await c.session.prompt('Try the refused calls.');
  expect([...c.store.rows.values()]).toMatchObject([
    { name: 'read', status: 'failed', error: { code: 'tool_input_invalid' }, sdkReturned: true },
    { name: 'write', status: 'failed', error: { code: 'access_denied' }, sdkReturned: true },
  ]);
  expect(c.store.transitions.some(value => value.endsWith(':running'))).toBe(false);
  await expect(Bun.file(join(c.root, 'refused.txt')).exists()).resolves.toBe(false);
  expect(JSON.stringify([...c.store.rows.values()][1]!.sdkDelivery)).toContain('fixture hook refusal');
});

test('the original Run workdir getter overrides the SDK session directory for real I/O', async () => {
  const c = await setup([{ name: 'read', args: { path: 'scope.txt' } }, { name: 'write', args: { path: 'created.txt', content: 'run-only' } }]);
  const runWork = join(c.root, 'run-work'); await mkdir(runWork);
  await writeFile(join(c.root, 'scope.txt'), 'session directory'); await writeFile(join(runWork, 'scope.txt'), 'original run directory');
  c.setWorkdir(runWork);
  await c.session.prompt('Read and write in the frozen run directory.');
  expect([...c.store.rows.values()][0]!.sdkDelivery?.content).toEqual([{ type: 'text', text: 'original run directory' }]);
  expect(await readFile(join(runWork, 'created.txt'), 'utf8')).toBe('run-only');
  expect(await Bun.file(join(c.root, 'created.txt')).exists()).toBe(false);
});

test('native errors retain their actual SDK text and replay even if the file later appears', async () => {
  const c = await setup([{ name: 'read', args: { path: 'missing.txt' } }], {}, true);
  await c.session.prompt('Read the missing file.');
  const original = structuredClone([...c.store.rows.values()][0]!);
  expect(original).toMatchObject({ status: 'failed', sdkReturned: true, sdkDelivery: { isError: true } });
  expect(JSON.stringify(original.sdkDelivery)).toContain('missing.txt');
  await writeFile(join(c.root, 'missing.txt'), 'new content must not replace the original error');
  await c.session.prompt('Replay the missing-file call.');
  expect([...c.store.rows.values()]).toEqual([original]); expect(c.requests).toHaveLength(4);
});

test('the actual SDK post-hook result is recorded independently of the successful native execution', async () => {
  const c = await setup([{ name: 'write', args: { path: 'post-hook.txt', content: 'committed' } }]);
  c.session.agent.afterToolCall = async () => ({ content: [{ type: 'text', text: 'actual post-hook result' }], details: { fixture: true }, isError: true });
  await c.session.prompt('Write through the SDK post-hook.');
  const row = [...c.store.rows.values()][0]!;
  expect(await readFile(join(c.root, 'post-hook.txt'), 'utf8')).toBe('committed');
  expect(row).toMatchObject({ status: 'succeeded', sdkReturned: true, sdkDelivery: { isError: true, details: { fixture: true },
    content: [{ type: 'text', text: 'actual post-hook result' }] } });
  expect(JSON.stringify(row.data)).toContain('Successfully wrote');
});

test.each(['request', 'finish', 'delivery'] as const)('native %s save failure stops the next model request without inventing success', async (phase) => {
  const c = await setup([{ name: 'write', args: { path: 'save-gap.txt', content: 'written only after requested/start saves' } }]);
  c.store.fail = phase;
  await c.session.prompt('Write and record the result.');
  expect(c.requests).toHaveLength(1);
  expect(c.recorder.blocked(c.getContext('native-1'))?.code).toBe('storage_write_failed');
  expect(await Bun.file(join(c.root, 'save-gap.txt')).exists()).toBe(phase !== 'request');
  if (phase === 'request') expect(c.store.rows.size).toBe(0);
  else expect([...c.store.rows.values()][0]).toMatchObject({ status: phase === 'finish' ? 'running' : 'succeeded', sdkReturned: false });
});

test('read keeps default image attachments and text truncation metadata', async () => {
  const c = await setup([{ name: 'read', args: { path: 'pixel.png' } }, { name: 'read', args: { path: 'large.txt' } }]);
  await writeFile(join(c.root, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  await writeFile(join(c.root, 'large.txt'), Array.from({ length: 2200 }, (_, index) => `line ${index}`).join('\n'));
  await c.session.prompt('Read both files using default SDK behavior.');
  const rows = [...c.store.rows.values()];
  expect(rows[0]).toMatchObject({ status: 'succeeded' });
  expect(rows[0]!.sdkDelivery?.content).toContainEqual(expect.objectContaining({ type: 'image' }));
  expect(rows[1]!.sdkDelivery).toMatchObject({ isError: false, details: { truncation: { truncated: true } } });
  expect(JSON.stringify(rows[1]!.sdkDelivery)).toContain('Use offset=');
});

test('PowerShell cancellation preserves streamed partial output and stops the real child before its later write', async () => {
  const c = await setup([{ name: 'powershell', args: { command: "Write-Output 'started'; while (-not (Test-Path -LiteralPath release.txt)) { Start-Sleep -Milliseconds 25 }; Set-Content -LiteralPath late.txt -Value 'must not run'", timeout: 10 } }]);
  let started!: () => void;
  const firstOutput = new Promise<void>(resolve => { started = resolve; });
  c.session.agent.subscribe(event => {
    if (event.type === 'tool_execution_update' && JSON.stringify(event.partialResult.content).includes('started')) started();
  });
  const prompt = c.session.prompt('Execute until cancellation.');
  await firstOutput; await c.session.abort(); await prompt;
  // Release a surviving child only after abort returned; this tests stopping without a wall-clock race.
  await writeFile(join(c.root, 'release.txt'), 'release');
  await Bun.sleep(900);
  expect(await Bun.file(join(c.root, 'late.txt')).exists()).toBe(false);
  expect([...c.store.rows.values()][0]).toMatchObject({ status: 'cancelled', sdkDelivery: { isError: true } });
  expect(JSON.stringify([...c.store.rows.values()][0]!.sdkDelivery)).toContain('started');
  expect(c.requests).toHaveLength(1);
}, 20000);

test('the default shell output tail, full output file, and partial updates remain intact', async () => {
  const c = await setup([{ name: 'powershell', args: { command: "1..2105 | ForEach-Object { 'line ' + $_ }; Write-Output 'tail-sentinel'", timeout: 4 } }]);
  let partial = false;
  c.session.agent.subscribe(event => { if (event.type === 'tool_execution_update' && event.partialResult.content.length) partial = true; });
  const previousTemp = process.env.TEMP, previousTmp = process.env.TMP;
  process.env.TEMP = c.root; process.env.TMP = c.root;
  try { await c.session.prompt('Read the SDK-truncated shell output.'); }
  finally {
    if (previousTemp === undefined) delete process.env.TEMP; else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP; else process.env.TMP = previousTmp;
  }
  const delivery = [...c.store.rows.values()][0]!.sdkDelivery;
  expect(delivery).toMatchObject({ isError: false, details: { truncation: { truncated: true } } });
  expect(JSON.stringify(delivery?.content)).toContain('tail-sentinel'); expect(partial).toBe(true);
  const details = delivery!.details;
  if (!details || typeof details !== 'object' || Array.isArray(details) || typeof details.fullOutputPath !== 'string') throw new Error('SDK full output path missing');
  expect(resolve(details.fullOutputPath).startsWith(resolve(c.root))).toBe(true);
  expect(await readFile(details.fullOutputPath, 'utf8')).toContain('line 1');
}, 20000);

if (process.env.MEDCLAW_NATIVE_DEP_CHILD === '1') test('native dependencies in an isolated subprocess', async () => {
  const c = await setup([{ name: 'grep', args: { pattern: 'anything', path: '.' } }, { name: 'find', args: { pattern: '*.txt', path: '.' } }]);
  await c.session.prompt('Use the unavailable search dependencies.');
  expect([...c.store.rows.values()]).toMatchObject([{ name: 'grep', status: 'failed', sdkReturned: true }, { name: 'find', status: 'failed', sdkReturned: true }]);
  expect(JSON.stringify([...c.store.rows.values()][0]!.sdkDelivery)).toContain('ripgrep (rg) is not available');
  expect(JSON.stringify([...c.store.rows.values()][1]!.sdkDelivery)).toContain('fd is not available');
  expect(c.requests).toHaveLength(2);
});

else test('rg and fd dependency errors come from the real SDK without downloads or fake executors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-native-deps-'));
  const env = { ...process.env, PI_CODING_AGENT_DIR: join(root, 'pi'), PI_OFFLINE: '1', MEDCLAW_NATIVE_DEP_CHILD: '1', TEMP: root, TMP: root };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key as keyof typeof env];
  const child = Bun.spawn([process.execPath, 'test', import.meta.path, '-t', '^native dependencies in an isolated subprocess$'],
    { env: { ...env, PATH: root }, cwd: root, stdout: 'pipe', stderr: 'pipe' });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode, output: stdout + stderr }).toMatchObject({ exitCode: 0 });
    expect(stdout + stderr).toContain('1 pass');
  } finally {
    child.kill();
    const target = resolve(root); if (!target.startsWith(resolve(tmpdir()))) throw new Error('unsafe cleanup');
    await rm(target, { recursive: true, force: true });
  }
}, 20000);
