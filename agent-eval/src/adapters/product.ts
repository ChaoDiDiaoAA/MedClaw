import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { FileTokens } from '../../../apps/desktop/src/main/file-tokens.ts';
import { DestinationTokens } from '../../../apps/desktop/src/main/destination-tokens.ts';
import { MainSettings } from '../../../apps/desktop/src/main/settings.ts';
import { AppErrorSchema, safeError, type Result } from '../../../packages/contracts/src/error.ts';
import { SDK_VERSION } from '../../../packages/contracts/src/model.ts';
import type { AgentModelCredential } from '../types.ts';
import {
  DATABASE_SCHEMA_VERSION, HOST_PROTOCOL_VERSION, MAX_FRAME_BYTES, HostHelloSchema, HostReadySchema,
  HostRequestSchema, PrivateCredentialReplySchema, encodeHostFrame, parseHostFrame, publicOutputSchema,
  hostPrivateMethodSchemas, isReadOnlyMethod, type HostHello, type HostReady, type PrivateCredentialFrame,
  type PublicMethod, type PublicPayload, type PublicReturn, type HostPrivateMethod,
} from '../../../packages/contracts/src/protocol.ts';

type Method = PublicMethod | HostPrivateMethod;
type Pending = { method: Method; payload: unknown; operationRef: string; resolve: (value: Result<unknown>) => void; timer: ReturnType<typeof setTimeout> };
export interface ProductTrace { at: string; instanceId: string; kind: string; [key: string]: unknown }
export interface ShutdownProof { stopped: boolean | null; closed: boolean | null; processExited: boolean; residuals: string[] }
export interface ProductOptions { dataRoot: string; hostEntry?: string; bunExecutable?: string; tracePath: string; timeoutMs?: number; controlledToolFault?: 'query-timeout-once'; modelCredential?:AgentModelCredential; owner?: { executionId: string; trialId: string; caseId: string } }

/** Only required variables reach the Host; native tools still use the current account permissions. */
export function childEnvironment(dataRoot: string, instanceId: string, startupToken: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[name]) env[name] = process.env[name];
  const systemRoot = env.SystemRoot ?? env.WINDIR;
  env.PATH = systemRoot ? [join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';') : '/usr/bin:/bin';
  return { ...env, HOME: join(dataRoot, 'home'), USERPROFILE: join(dataRoot, 'home'), APPDATA: join(dataRoot, 'home', 'AppData', 'Roaming'),
    LOCALAPPDATA: join(dataRoot, 'home', 'AppData', 'Local'), TEMP: join(dataRoot, 'tmp'), TMP: join(dataRoot, 'tmp'), TMPDIR: join(dataRoot, 'tmp'),
    AWS_MAX_ATTEMPTS: '1', MEDCLAW_INSTANCE_ID: instanceId, MEDCLAW_STARTUP_TOKEN: startupToken };
}

export class ProductAdapter {
  readonly instanceIds: string[] = [];
  readonly fileTokens = new FileTokens();
  readonly destinations: DestinationTokens;
  readonly traces: ProductTrace[] = [];
  paths!: HostHello['paths'];
  instanceId = '';
  ready: HostReady | null = null;
  deadlineAt: number | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private exited: Promise<void> = Promise.resolve();
  private pending = new Map<string, Pending>();
  private expired = new Map<string, Pick<Pending, 'method' | 'payload' | 'operationRef'>>();
  private buffer = Buffer.alloc(0);
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private writes: Promise<void> = Promise.resolve();
  private traceWrites: Promise<void> = Promise.resolve();
  private traceFailure: unknown;
  private mainSettings: MainSettings | null = null;
  private handshake: { resolve(value: HostReady): void; reject(error: unknown): void } | null = null;
  constructor(readonly options: ProductOptions) {
    this.destinations = new DestinationTokens(resolve(options.dataRoot),undefined,async(instanceId,input)=>{
      if(instanceId!==this.instanceId)throw new Error('access_denied');
      unwrap(await this.request('export.copy.verify',input,input.operationRef));
    });
  }

  private settings() {
    return this.mainSettings ??= new MainSettings(this.paths.settingsPath, {
      prepare: async (token, candidate) => unwrap(await this.request('settings.prepare', { token, candidate })),
      commit: async (token, publishedVersion) => unwrap(await this.request('settings.commit', { token, publishedVersion })),
      abort: async token => unwrap(await this.request('settings.abort', { token })),
      readVersion: async () => unwrap(await this.request('model.read', {})).configVersion,
    });
  }

  record(kind: string, value: Record<string, unknown> = {}) {
    const entry = { ...(['controller.evidence.read','export.copy.verify'].includes(String(value.method))?{requestId:value.requestId,method:value.method}:value), kind, at: new Date().toISOString(), instanceId: this.instanceId };
    this.traces.push(entry);
    this.traceWrites = this.traceWrites.then(() => appendFile(this.options.tracePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 })).catch(error => { this.traceFailure = error; });
  }
  async flush() { await this.traceWrites; if (this.traceFailure) throw this.traceFailure; }
  private write(frame: unknown) {
    const line = frame && typeof frame === 'object' && !('kind' in frame)
      ? `${JSON.stringify(HostHelloSchema.parse(frame))}\n` : encodeHostFrame(frame as never);
    this.writes = this.writes.then(() => new Promise<void>((done, reject) => {
      if (!this.child || this.child.stdin.destroyed) return reject(new Error('host_interrupted'));
      this.child.stdin.write(line, error => error ? reject(error) : done());
    }));
    return this.writes;
  }
  private finish(requestId: string, result: Result<unknown>) {
    const pending = this.pending.get(requestId); if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(requestId);
    this.record('reply', { requestId, operationRef: pending.operationRef, method: pending.method, result }); pending.resolve(result);
  }
  private fail(error: unknown) {
    this.handshake?.reject(error); this.handshake = null;
    for (const [id, pending] of this.pending) this.finish(id, { ok: false, error: safeError(isReadOnlyMethod(pending.method) ? 'host_interrupted' : 'operation_result_unknown', undefined, { operationRef: pending.operationRef }) });
    this.record('transport_error', { reason: error instanceof Error ? error.message : 'host_interrupted' });
  }
  private async privateRequest(frame: PrivateCredentialFrame) {
    let result: Result<unknown>;
    try {
      let data: unknown;
      switch (frame.method) {
        case 'credential.list': data = this.options.modelCredential?[{providerId:this.options.modelCredential.providerId,type:'api_key'}]:[]; break;
        case 'credential.read': {
          const credential=this.options.modelCredential;
          if(!credential||frame.payload.providerId!==credential.providerId){data=null;break;}
          if(frame.payload.context.purpose!=='runtime'||frame.payload.context.credentialRef!==undefined&&frame.payload.context.credentialRef!=='eval-model-key')throw new Error('access_denied');
          data={type:'api_key',key:credential.key};break;
        }
        case 'file.resolve': data = this.fileTokens.resolve(frame.payload.fileToken, 1, this.instanceId, frame.payload.operationRef); break;
        case 'export.destination.describe': data = await this.destinations.describe(1, this.instanceId, frame.payload); break;
        case 'export.destination.copy': data = await this.destinations.copy(1, this.instanceId, frame.payload); break;
        case 'export.destination.cancel': data = await this.destinations.cancel(frame.payload.operationRef); break;
        case 'export.destination.settlePrevious': data = await this.destinations.settlePrevious(); break;
        default: throw new Error('access_denied');
      }
      result = { ok: true, data };
    } catch (error) { result = { ok: false, error: safeError(error instanceof Error ? error.message : 'internal_error') }; }
    // The private credential reply is never journaled or projected into Agent inputs.
    await this.write(PrivateCredentialReplySchema.parse({ protocolVersion: HOST_PROTOCOL_VERSION, kind: 'private', instanceId: this.instanceId,
      requestId: frame.requestId, secret: true, method: frame.method, result }));
  }
  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      if (newline > MAX_FRAME_BYTES) throw new Error('frame_too_large');
      const line = this.decoder.decode(this.buffer.subarray(0, newline)); this.buffer = this.buffer.subarray(newline + 1);
      const raw: unknown = JSON.parse(line);
      if (!this.ready && raw && typeof raw === 'object' && !('kind' in raw)) {
        const ready = HostReadySchema.parse(raw);
        if (ready.instanceId !== this.instanceId || ready.dataRoot !== this.paths.dataRoot) throw new Error('host_protocol_mismatch');
        this.ready = ready; this.record('ready', { ready }); this.handshake?.resolve(ready); this.handshake = null; continue;
      }
      const frame = parseHostFrame(line, this.instanceId);
      if (frame.kind === 'private' && 'payload' in frame) { void this.privateRequest(frame).catch(error => this.fail(error)); continue; }
      if (frame.kind === 'notice') { this.record('notice', { notice: frame.notice }); continue; }
      if (frame.kind !== 'reply') throw new Error('host_protocol_mismatch');
      const pending = this.pending.get(frame.requestId) ?? this.expired.get(frame.requestId); if (!pending) throw new Error('unknown_reply_identity');
      const output = pending.method in hostPrivateMethodSchemas
        ? hostPrivateMethodSchemas[pending.method as HostPrivateMethod].output : publicOutputSchema(pending.method as PublicMethod, pending.payload);
      const result = frame.result.ok ? { ok: true as const, data: output.parse(frame.result.data) } : frame.result;
      if (this.expired.delete(frame.requestId)) this.record('late_reply', { requestId: frame.requestId, operationRef: pending.operationRef, method: pending.method, result });
      else this.finish(frame.requestId, result);
    }
    if (this.buffer.length > MAX_FRAME_BYTES) throw new Error('frame_too_large');
  }
  async start(): Promise<HostReady> {
    if (this.child) throw new Error('host_stop_unconfirmed');
    await mkdir(this.options.dataRoot, { recursive: true }); await mkdir(dirname(this.options.tracePath), { recursive: true });
    const dataRoot = await realpath(this.options.dataRoot);
    for (const directory of ['data', 'runtime', 'home', 'home/AppData/Roaming', 'home/AppData/Local', 'tmp', 'work']) await mkdir(join(dataRoot, directory), { recursive: true });
    this.paths = { dataRoot, databasePath: join(dataRoot, 'data', 'app.sqlite'), settingsPath: join(dataRoot, 'data', 'settings.json'), cachePath: join(dataRoot, 'data', 'pi-model-cache.json'), lockPath: join(dataRoot, 'runtime', 'host.lock') };
    this.instanceId = randomUUID(); this.instanceIds.push(this.instanceId); const startupToken = randomUUID();
    await writeFile(join(dirname(this.options.tracePath), 'ownership.json'), JSON.stringify({ contract: 'medclaw-eval-instance/v1', ...this.options.owner,
      dataRoot, instanceIds: this.instanceIds, observedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    this.ready = null; this.buffer = Buffer.alloc(0); this.writes = Promise.resolve();
    this.expired.clear();
    const ready = new Promise<HostReady>((resolve, reject) => { this.handshake = { resolve, reject }; });
    void ready.catch(() => {});
    const timer = setTimeout(() => this.fail(new Error('host_start_timeout')), this.options.timeoutMs ?? 30000);
    const child = spawn(this.options.bunExecutable ?? process.execPath, ['--no-env-file', this.options.hostEntry ?? resolve(import.meta.dir, '../../../apps/host/src/main.ts')],
      { cwd: join(dataRoot, 'work'), env: childEnvironment(dataRoot, this.instanceId, startupToken), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.exited = new Promise(done => child.once('close', (code, signal) => { this.child = null; this.record('process_exit', { code, signal }); this.fail(new Error('host_interrupted')); done(); }));
    child.on('error', error => this.fail(error));
    child.stdout.on('data', chunk => { try { this.receive(chunk); } catch (error) { this.fail(error); child.kill(); } });
    child.stderr.on('data', chunk => this.record('diagnostic', { text: chunk.toString('utf8') }));
    try {
      await writeFile(join(dirname(this.options.tracePath), 'ownership.json'), JSON.stringify({ contract: 'medclaw-eval-instance/v1', ...this.options.owner,
        dataRoot, instanceIds: this.instanceIds, hostPid: child.pid ?? null, observedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      await this.write(HostHelloSchema.parse({ protocolVersion: HOST_PROTOCOL_VERSION, instanceId: this.instanceId, startupToken, sdkVersion: SDK_VERSION, expectedSchemaVersion: DATABASE_SCHEMA_VERSION, paths: this.paths,
        ...(this.options.controlledToolFault ? { controlledToolFault: this.options.controlledToolFault } : {}) }));
      return await ready;
    } finally { clearTimeout(timer); }
  }
  request<M extends PublicMethod>(method: M, payload: PublicPayload<M>, operationRef?: string, timeoutMs?: number): Promise<Result<PublicReturn<M>>>;
  request(method: Method, payload: unknown, operationRef?: string, timeoutMs?: number): Promise<Result<unknown>>;
  async request(method: Method, payload: unknown, operationRef = randomUUID(), timeoutMs = this.options.timeoutMs ?? 30000): Promise<Result<unknown>> {
    if (!this.ready || !this.child) return { ok: false, error: safeError('host_not_ready') };
    if (this.deadlineAt !== null) timeoutMs = Math.max(1, Math.min(timeoutMs, this.deadlineAt - Date.now()));
    const requestId = randomUUID(), frame = HostRequestSchema.parse({ protocolVersion: HOST_PROTOCOL_VERSION, kind: 'request', instanceId: this.instanceId, requestId, operationRef, method, payload });
    // Main owns this public port; reuse its settings owner instead of querying Host or SQLite.
    if (method === 'model.config.read') {
      this.record('request', { requestId, operationRef, method, payload: frame.payload, source: 'main-settings' });
      let result: Result<unknown>;
      try { const s = new MainSettings(this.paths.settingsPath).read();
        result = { ok: true, data: publicOutputSchema(method, payload).parse({ configVersion: s.configVersion, intentModel: s.intentModel ?? null, previousConfigVersion: s.previous?.configVersion ?? null,
          rollbackFromVersion: s.rollbackFromVersion, policy: s.requestPolicy, agentPolicy: s.agentPolicy, runtimeConfiguration: s.runtimeConfiguration, toolConfiguration: s.toolConfiguration }) };
      } catch { result = { ok: false, error: safeError('config_read_failed') }; }
      this.record('reply', { requestId, operationRef, method, result, source: 'main-settings' }); return result;
    }
    if (method === 'model.intent.configure') {
      this.record('request', { requestId, operationRef, method, payload: frame.payload, source: 'main-settings' });
      let result: Result<unknown>;
      try {
        const input = frame.payload as PublicPayload<'model.intent.configure'>;
        const settings = this.settings();
        const directory = unwrap(await this.request('model.read', {}));
        if (directory.configVersion !== settings.read().configVersion) throw new Error('config_conflict');
        const published = await settings.publish(input.expectedConfigVersion, { intentModel: input.intentModel }, { kind: 'intent' });
        result = { ok: true, data: publicOutputSchema(method, payload).parse({ configVersion: published.configVersion, intentModel: published.intentModel ?? null }) };
      } catch (error) { result = { ok: false, error: safeError(error instanceof Error ? error.message : 'config_write_failed') }; }
      this.record('reply', { requestId, operationRef, method, result, source: 'main-settings' }); return result;
    }
    if (method === 'resources.select') {
      this.record('request', { requestId, operationRef, method, payload: frame.payload, source: 'main-settings' });
      let result: Result<unknown>;
      try {
        const input = frame.payload as PublicPayload<'resources.select'>, settings = this.settings(), current = await settings.synchronize();
        const resources = { bySession: { ...current.resources?.bySession, [String(input.sessionId)]: input.selection } };
        const published = await settings.publish(input.expectedConfigVersion, { resources }, { kind: 'resources' });
        result = { ok: true, data: publicOutputSchema(method, payload).parse({ sessionId: input.sessionId,
          configVersion: published.configVersion, selection: published.resources!.bySession[String(input.sessionId)]! }) };
      } catch (error) {
        const known = AppErrorSchema.safeParse(error && typeof error === 'object' && 'appError' in error ? error.appError : error);
        result = { ok: false, error: known.success ? known.data : safeError(error instanceof Error ? error.message : 'config_write_failed') };
      }
      this.record('reply', { requestId, operationRef, method, result, source: 'main-settings' }); return result;
    }
    const result = new Promise<Result<unknown>>(resolve => {
      const timer = setTimeout(() => {
        this.expired.set(requestId, { method, payload: frame.payload, operationRef });
        this.finish(requestId, { ok: false, error: safeError(isReadOnlyMethod(method) ? 'host_interrupted' : 'operation_result_unknown', undefined, { operationRef }) });
      }, timeoutMs);
      this.pending.set(requestId, { method, payload: frame.payload, operationRef, resolve, timer });
    });
    this.record('request', { requestId, operationRef, method, payload: frame.payload });
    try { await this.write(frame); } catch (error) { this.fail(error); }
    return result;
  }
  async stop(timeoutMs = 30000): Promise<ShutdownProof> {
    if (!this.child) return { stopped: null, closed: null, processExited: true, residuals: ['shutdown_ack_missing'] };
    const deadline = Date.now() + timeoutMs;
    if (!this.ready) this.child.stdin.end();
    const result = await this.request('host.shutdown', { expectedInstanceId: this.instanceId }, randomUUID(), timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.exited, new Promise<void>(done => { timer = setTimeout(done, Math.max(0, deadline - Date.now())); })]); clearTimeout(timer);
    const exited = this.child === null;
    const ack = result.ok ? hostPrivateMethodSchemas['host.shutdown'].output.parse(result.data) : null;
    const proof = { stopped: ack?.executionStopped === true && exited ? true : null, closed: ack?.databaseClosed === true && exited ? true : null,
      processExited: exited, residuals: [...(!ack ? ['shutdown_ack_missing'] : []), ...(ack && !ack.executionStopped ? ['execution_stop_unconfirmed'] : []),
        ...(ack && !ack.databaseClosed ? ['database_close_unconfirmed'] : []), ...(!exited ? ['host_process_exit_unconfirmed'] : [])] };
    this.record('shutdown_proof', { proof, timeoutMs }); await this.flush(); return proof;
  }
  async restart() { const proof = await this.stop(); if (proof.stopped !== true || proof.closed !== true) throw Object.assign(new Error('host_stop_unconfirmed'), { shutdownProof: proof, instanceId: this.instanceId }); return this.start(); }
}

export function unwrap<T>(result: Result<T>): T { if (!result.ok) throw Object.assign(new Error(result.error.code), { appError: result.error }); return result.data; }
