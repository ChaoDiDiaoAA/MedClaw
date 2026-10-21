import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MainSettings, atomicWriteJson } from '../../apps/desktop/src/main/settings';
import { MainCredentials, SecretInputs } from '../../apps/desktop/src/main/credentials';
import { DestinationTokens } from '../../apps/desktop/src/main/destination-tokens';
import { FileTokens } from '../../apps/desktop/src/main/file-tokens';
import { MaintenanceController } from '../../apps/desktop/src/main/maintenance-controller';
import { EvaluationController } from '../../apps/desktop/src/main/evaluation-controller';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { HOST_PROTOCOL_VERSION, type DiagnosticsView } from '../../packages/contracts/src/protocol';
import { ImportOperationSchema, ImportPreviewSchema } from '../../packages/contracts/src/data';
import { WorkspaceViewSchema } from '../../packages/contracts/src/workspace';
import { SessionDetailSchema, SubmitResultSchema, type SubmitInput } from '../../packages/contracts/src/session';
import { QueryParamsSchema } from '../../packages/contracts/src/query';
import { RuntimeControlViewSchema, canonicalRequest } from '../../packages/contracts/src/run';
import { type Result } from '../../packages/contracts/src/error';
import { disabledIntentModel, productIntent, resolvedIntent } from './p14-intent';
import { packageFixture } from './snapshot-package';

export type AdmissionActor = 'intent preparation' | 'configuration publication' | 'destination copy' | 'support export' | 'evaluation start';
export function unwrap<T>(result: Result<T>): T { if (!result.ok) throw result.error; return result.data; }
export async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('ENGINEERING admission window not reached'); await Bun.sleep(10); }
}
function gate() {
  let armed = false, entered = false, release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  return { arm: () => { armed = true; }, entered: () => entered, release,
    async wait() { if (armed) { armed = false; entered = true; await pending; } } };
}

/** Real Main consumers and Bun Host with test pauses, controlled Electron surfaces and local model responses. */
export async function mainAdmissionFixture(actor: AdmissionActor) {
  const root = mkdtempSync(join(tmpdir(), 'MedClaw 写入交错-')), dataRoot = join(root, 'source'), backupRoot = join(root, 'backup'), external = join(root, 'external');
  for (const path of [dataRoot, backupRoot, external]) mkdirSync(path);
  const armed = join(root, 'intent-armed'), reached = join(root, 'intent-reached'), released = join(root, 'intent-released'), hostEntry = join(root, 'intent-host.ts');
  if (actor === 'intent preparation') writeFileSync(hostEntry, `import {existsSync,unlinkSync,writeFileSync} from 'node:fs';
    import {PiModelRuntime} from ${JSON.stringify(resolve('packages/runtime-pi/src/model-runtime.ts'))};
    const original=PiModelRuntime.prototype.resolve;
    PiModelRuntime.prototype.resolve=async function(...args){const result=await original.apply(this,args);
      if(existsSync(${JSON.stringify(armed)})){unlinkSync(${JSON.stringify(armed)});writeFileSync(${JSON.stringify(reached)},'ENGINEERING');
        const deadline=Date.now()+30000;while(!existsSync(${JSON.stringify(released)})){if(Date.now()>deadline)throw new Error('ENGINEERING intent preparation gate expired');await Bun.sleep(10);}}
      return result;};await import(${JSON.stringify(resolve('apps/host/src/main.ts'))});`);
  const write = actor === 'intent preparation'
    ? { arm: () => writeFileSync(armed, 'ENGINEERING'), entered: () => existsSync(reached), release: () => { if (existsSync(root)) writeFileSync(released, 'ENGINEERING'); } }
    : gate();
  const maintenanceGate = gate(), paths: string[] = [], forwarded: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname; paths.push(path);
    if (path === '/api/version') return Response.json({ version: 'ENGINEERING' });
    if (path === '/api/tags') return Response.json({ models: [{ name: 'qwen3.5:0.8b' }] });
    if (path === '/api/show') return Response.json({ details: { family: 'qwen35', parameter_size: '752.39M', quantization_level: 'Q8_0' } });
    if (path === '/api/chat') return Response.json({ model: 'qwen3.5:0.8b', done: true, done_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify({ ...resolvedIntent(), intents: [{ ...productIntent(), slots: { ...productIntent().slots, region: '浙江', time: { start: '2026-01-01', endExclusive: '2026-01-02' } } }] }) }, prompt_eval_count: 44, eval_count: 35 });
    if (path === '/v1/chat/completions') return new Response(`data: ${JSON.stringify({ id: 'ENGINEERING', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'ENGINEERING answer' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    throw new Error('ENGINEERING unexpected endpoint');
  } });
  const files = new FileTokens(), credentials = new MainCredentials(join(dataRoot, 'data/credentials.enc.json'), {
    isEncryptionAvailable: () => true, encryptString() { throw new Error('ENGINEERING no real credentials'); }, decryptString() { throw new Error('ENGINEERING no real credentials'); },
  });
  const { privateCredentialRequest } = await import('../../apps/desktop/src/main/ipc-handlers');
  let maintenance!: MaintenanceController;
  const host = new HostController({ dataRoot, hostEntry: actor === 'intent preparation' ? hostEntry : resolve('apps/host/src/main.ts'), bunExecutable: process.execPath,
    onStarting: instanceId => { credentials.attachInstance(instanceId); destinations.retainInstance(instanceId); },
    onExit: instanceId => { credentials.confirmHostExit(instanceId); destinations.retainInstance(null); },
    onCredentialRequest: async frame => {
      if (frame.method === 'credential.list') return { ok: true, data: [{ providerId: 'p17-fixture', type: 'api_key' }] };
      if (frame.method === 'credential.read') return { ok: true, data: frame.payload.providerId === 'p17-fixture' ? { type: 'api_key', key: 'ENGINEERING' } : null };
      return privateCredentialRequest(credentials, frame, files, 1, destinations, maintenance);
    },
  });
  const destinations = new DestinationTokens(dataRoot, Date.now, async (instanceId, input) => {
    unwrap(await host.request('export.copy.verify', input, input.operationRef, undefined, instanceId));
    if (actor === 'destination copy' && 'wait' in write) await write.wait();
  });
  const initial = new MainSettings(host.paths.settingsPath).read();
  atomicWriteJson(host.paths.settingsPath, PublishedSettingsSchema.parse({ ...initial,
    model: { provider: 'p17-fixture', modelId: 'fixture' },
    customProviders: [{ definition: { providerId: 'p17-fixture', name: 'ENGINEERING', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`,
      models: [{ id: 'fixture', name: 'ENGINEERING', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] }, credentialRef: null }],
    intentModel: { ...disabledIntentModel(), enabled: true, baseUrl: `http://127.0.0.1:${server.port}`, verifiedEvidenceRef: 'ENGINEERING local protocol only; not quality evidence' },
  }));
  const settings = new MainSettings(host.paths.settingsPath, {
    prepare: async (token, candidate) => { unwrap(await host.request('settings.prepare', { token, candidate })); if (actor === 'configuration publication' && 'wait' in write) await write.wait(); },
    commit: async (token, publishedVersion) => unwrap(await host.request('settings.commit', { token, publishedVersion })),
    abort: async token => unwrap(await host.request('settings.abort', { token })),
    readVersion: async () => (unwrap(await host.request('model.read', {})) as { configVersion: string }).configVersion,
  });
  const evaluation = new EvaluationController({ paths: { sourceRoot: resolve('.'), configsRoot: join(root, 'eval-config'), runsRoot: join(root, 'eval-runs') },
    workerEntry: resolve('agent-eval/src/desktop/controller.ts'), bunExecutable: process.execPath, production: host, maintenanceBusy: () => maintenance.busy });
  maintenance = new MaintenanceController({ dataRoot, selectionRoot: root, files, host,
    writesBusy: () => credentials.busy || destinations.busy || evaluation.admissionPending,
    bunExecutable: process.execPath, maintenanceEntry: resolve('apps/host/src/maintenance.ts'), installManifestPath: resolve('.build/package-resources/medclaw/install.json') });
  const originalRequest = host.request.bind(host);
  host.request = async (...args: Parameters<HostController['request']>) => {
    forwarded.push(args[0]); const result = await originalRequest(...args);
    if (args[0] === 'run.control.read') {
      if (actor === 'evaluation start' && 'wait' in write) await write.wait();
      await maintenanceGate.wait();
    }
    return result;
  };
  const workspace = async () => WorkspaceViewSchema.parse(unwrap(await host.request('workspace.read', {})));
  const idle = () => until(async () => RuntimeControlViewSchema.parse(unwrap(await host.request('run.control.read', {}))).acceptingNewRuns);
  const sql = (query: string) => { const db = new Database(host.paths.databasePath, { readonly: true }); try { return db.query<Record<string, unknown>, []>(query).all(); } finally { db.close(); } };
  async function close() {
    write.release(); maintenanceGate.release();
    try {
      expect(await maintenance.shutdown()).toEqual({ stopped: true });
      expect(await evaluation.shutdown()).toMatchObject({ stopConfirmed: true, saveConfirmed: true, controllerExited: true });
      await destinations.settlePrevious();
      if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
      await host.refreshStopProof();
      expect(host.read()).toMatchObject({ canStart: true });
      if (host.read().shutdown) expect(host.read().shutdown).toMatchObject({ executionStopped: true, requiredPersistenceComplete: true, databaseClosed: true, processExited: true, processTreeStopped: true });
      if (realpathSync(root) !== root || !root.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING admission cleanup root changed');
      rmSync(root, { recursive: true, force: true });
    } catch (error) { console.error('P17_ADMISSION_ROOT_RETAINED ' + root); throw error; }
    finally { server.stop(true); }
  }
  try {
    expect(await host.start()).toMatchObject({ state: 'ready', schemaVersion: 17 });
    const source = join(root, 'payload'), operationRef = crypto.randomUUID(); packageFixture(source);
    const grant = files.issue(1, host.read().instanceId!, operationRef, source);
    expect(ImportPreviewSchema.parse(unwrap(await host.request('import.preview', { operationRef, fileToken: grant.fileToken, mappingVersion: 'medclaw.snapshot/v1' }, operationRef))).canCommit).toBe(true);
    const imported = ImportOperationSchema.parse(unwrap(await host.request('import.commit', { operationRef, fileToken: grant.fileToken }, operationRef)));
    unwrap(await host.request('workspace.update', { expectedRevision: (await workspace()).revision, change: { batchIds: imported.result!.batchIds } }));
  } catch (error) { await close(); throw error; }
  async function submission(sessionId: number, form = false): Promise<SubmitInput> {
    const detail = SessionDetailSchema.parse(unwrap(await host.request('session.read', { sessionId }))), current = await workspace();
    const params = QueryParamsSchema.parse({ kind: 'current', population: 'snapshot', snapshotMode: 'exact_date', batchIds: current.batchRefs.map(batch => batch.id), time: { start: '2026-01-01', endExclusive: '2026-01-02' }, region: '浙江' });
    return { sessionId, clientSequence: detail.session.nextSubmissionSequence, text: form ? 'Query form: ' + canonicalRequest(params) : '列出浙江2026-01-01的器械清单', mode: 'send',
      expectedRevision: current.revision, expectedBatchIds: current.batchRefs.map(batch => batch.id), expectedQueryId: current.queryId,
      model: { provider: 'p17-fixture', modelId: 'fixture', expectedConfigVersion: settings.read().configVersion }, referenceDate: '2026-01-02', timezone: 'Asia/Shanghai',
      routing: form ? { mode: 'user_form', params } : { mode: 'intent', originRunId: null } };
  }
  let diagnosticsReads = 0;
  const diagnostics = async (): Promise<DiagnosticsView> => {
    const snapshot = unwrap(await host.request('diagnostics.read', { categories: ['runtime'] })) as DiagnosticsView;
    diagnosticsReads++; if (actor === 'support export' && 'wait' in write) await write.wait();
    return { ...snapshot, host: host.read(), versions: { sdkVersion: '0.87.1', protocolVersion: HOST_PROTOCOL_VERSION, schemaVersion: 17, configVersion: settings.read().configVersion, bunVersion: Bun.version, electronVersion: '44.5.1' } };
  };
  return { root, dataRoot, backupRoot, external, files, host, settings, maintenance, evaluation, destinations, credentials, inputs: new SecretInputs(),
    write, maintenanceGate, paths, forwarded, diagnostics, diagnosticsReads: () => diagnosticsReads, workspace, submission, idle, sql, close,
    formResult: (result: Result<unknown>) => SubmitResultSchema.parse(unwrap(result)) };
}
