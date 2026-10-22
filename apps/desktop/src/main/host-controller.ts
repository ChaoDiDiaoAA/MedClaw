import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from 'node:util';
import { WriterLockRecordSchema, type WriterLockRecord, type HostShutdownProof } from '@medclaw/contracts/maintenance';
import { requestMaintenance } from './maintenance-controller';
import type { z } from 'zod';
import { OpaqueIdSchema, safeError, type AppError, type Result } from "@medclaw/contracts/error";
import { SDK_VERSION, type HostView } from "@medclaw/contracts/model";
import { HostStartupFailureReader, type HostStartupFailure } from '../../../../packages/logging/src/host-startup-failure';
import {
  DATABASE_SCHEMA_VERSION, HOST_PROTOCOL_VERSION, MAX_FRAME_BYTES,
  HostHelloSchema, HostReadySchema, HostRequestSchema, HostShutdownResultSchema, PrivateCredentialFrameSchema, PrivateCredentialReplySchema,
  encodeHostFrame, parseHostFrame, hostPrivateMethodSchemas, publicOutputSchema, isReadOnlyMethod,
  type DesktopNotice, type HostHello, type HostPrivateMethod, type HostReady,
  type PrivateCredentialFrame, type PublicHostRequest,
} from "@medclaw/contracts/protocol";

export interface HostControllerOptions {
  dataRoot: string;
  hostEntry: string;
  bunExecutable?: string;
  resourceRoot?: string;
  installManifestPath?: string;
  maintenanceEntry?: string;
  onCredentialRequest?: (frame: PrivateCredentialFrame) => Promise<Result<unknown>>;
  onNotice?: (notice: DesktopNotice) => void;
  onError?: (error: AppError) => void;
  onStartupFailure?: (failure: HostStartupFailure) => void;
  onStarting?: (instanceId: string) => void;
  onExit?: (instanceId: string) => void;
}
type HostMethod = PublicHostRequest["method"] | HostPrivateMethod;
type Pending = { method: HostMethod; operationRef: string; output:z.ZodType; timer: ReturnType<typeof setTimeout>; resolve: (result: Result<unknown>) => void };
const waitForExit = async (exited: Promise<void>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 10000); timer.unref(); })]); }
  finally { clearTimeout(timer); }
};

export class HostController {
  readonly paths: HostHello["paths"];
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private checkingStop: Promise<void> | null = null;
  private verifiedLock: WriterLockRecord | null = null;
  private exited: Promise<void> = Promise.resolve();
  private view: HostView = { instanceId: null, state: "stopped", canStart: true, sdkVersion: null, schemaVersion: null, error: null };
  private handshake: { resolve: (ready: HostReady) => void; reject: (error: AppError) => void } | null = null;
  private buffer = Buffer.alloc(0);
  private writes = { tail: Promise.resolve(), count: 0 };
  private pending = new Map<string, Pending>();
  private credentialCount = 0;
  private preview: Extract<DesktopNotice, { type: "provider.preview" | "agent.preview" }> | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private streams = new Map<string, Extract<DesktopNotice, { type: 'event.stream' }>>();
  private streamRevisions = new Map<string, number>();
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private diagnostic(error: AppError) { try { this.options.onError?.(error); } catch { /* Reporting cannot alter Host control. */ } }
  private deliverNotice(notice: DesktopNotice) {
    try { this.options.onNotice?.(structuredClone(notice)); }
    catch { this.diagnostic(safeError('preview_delivery_failed')); }
  }
  private clearStreams() {
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = null; this.streams.clear(); this.streamRevisions.clear();
  }
  private streamNotice(notice: Extract<DesktopNotice, { type: 'event.stream' }>) {
    const snapshot = notice.snapshot;
    const objectId = snapshot.type === 'message.snapshot' ? snapshot.messageId : snapshot.nativeToolCallId;
    const key = JSON.stringify([notice.subscriptionId, snapshot.runId, snapshot.streamConnection, snapshot.type, objectId]);
    if (snapshot.revision <= (this.streamRevisions.get(key) ?? 0)) return;
    this.streamRevisions.delete(key); this.streamRevisions.set(key, snapshot.revision);
    if (this.streamRevisions.size > 512) this.streamRevisions.delete(this.streamRevisions.keys().next().value!);
    if (snapshot.phase === 'ended') { this.streams.delete(key); this.deliverNotice(notice); return; }
    this.streams.set(key, structuredClone(notice));
    // Overflow discards temporary display data only. Same-sid snapshot refresh
    // recovers the latest bounded source; it never re-enters execution.
    if (this.streams.size > 256) this.streams.delete(this.streams.keys().next().value!);
    if (!this.streamTimer) this.streamTimer = setTimeout(() => {
      this.streamTimer = null; const notices = [...this.streams.values()]; this.streams.clear();
      notices.forEach(value => this.deliverNotice(value));
    }, 32);
  }
  constructor(private readonly options: HostControllerOptions) {
    if (!isAbsolute(options.dataRoot) || !isAbsolute(options.hostEntry)) throw new Error("invalid_argument");
    mkdirSync(options.dataRoot, { recursive: true });
    const dataRoot = realpathSync(options.dataRoot);
    for (const directory of [join(dataRoot, "data"), join(dataRoot, "runtime")]) {
      mkdirSync(directory, { recursive: true });
      if (!realpathSync(directory).startsWith(`${dataRoot}${sep}`)) throw new Error("access_denied");
    }
    this.paths = { dataRoot, databasePath: join(dataRoot, "data/app.sqlite"), settingsPath: join(dataRoot, "data/settings.json"), cachePath: join(dataRoot, "data/pi-model-cache.json"), lockPath: join(dataRoot, "runtime/host.lock") };
  }
  private lockAvailable(): boolean {
    try {
      const lock = WriterLockRecordSchema.parse(JSON.parse(readFileSync(this.paths.lockPath, 'utf8')));
      return isDeepStrictEqual(lock, this.verifiedLock);
    } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  }
  read(): HostView { return structuredClone({ ...this.view, canStart: this.child === null && this.starting === null && this.view.state !== 'stopping' && this.lockAvailable() }); }
  private settleStoppedState(): void {
    const saved = this.view.shutdown;
    if (this.child || this.view.state !== 'stopping' || !saved?.processExited) return;
    if (saved.processTreeStopped !== true) { this.view.error ??= safeError('host_stop_unconfirmed'); return; }
    const clean = saved.executionStopped === true && saved.requiredPersistenceComplete === true && saved.databaseClosed === true;
    this.view.state = clean ? 'stopped' : 'failed';
    this.view.error = clean ? null : saved.error ?? safeError('host_interrupted');
  }
  refreshStopProof(): Promise<void> {
    if (this.child) return Promise.resolve();
    this.checkingStop ??= this.readStopProof().finally(() => { this.checkingStop = null; this.status(); });
    return this.checkingStop;
  }
  private async readStopProof(): Promise<void> {
    if (this.child) return;
    this.verifiedLock = null; this.view.canPrepareRecovery = false;
    let lock: WriterLockRecord;
    try { lock = WriterLockRecordSchema.parse(JSON.parse(readFileSync(this.paths.lockPath, 'utf8'))); }
    catch (error) {
      if (this.view.shutdown) this.view.shutdown.processTreeStopped = null;
      this.settleStoppedState();
      return;
    }
    const result = await requestMaintenance({ bunExecutable: this.options.bunExecutable ?? process.execPath,
      maintenanceEntry: this.options.maintenanceEntry ?? resolve(import.meta.dir, '../../../../apps/host/src/maintenance.ts') },
      { action: 'process.check', owner: { instanceId: lock.instanceId, startupToken: lock.startupToken }, lockPath: this.paths.lockPath }, randomUUID());
    if (this.child) return;
    this.view.canPrepareRecovery = result.ok && result.data.canPrepareRecovery;
    if (result.ok && result.data.stopped && result.data.processTreeProof?.instanceId === lock.instanceId) this.verifiedLock = lock;
    if (this.view.shutdown) this.view.shutdown.processTreeStopped = this.verifiedLock && lock.instanceId === this.view.instanceId ? true : null;
    this.settleStoppedState();
  }
  async prepareRecovery(): Promise<HostView> {
    if (this.child || this.starting) throw new Error('runtime_busy');
    const lock = WriterLockRecordSchema.parse(JSON.parse(readFileSync(this.paths.lockPath, 'utf8')));
    const result = await requestMaintenance({ bunExecutable: this.options.bunExecutable ?? process.execPath,
      maintenanceEntry: this.options.maintenanceEntry ?? resolve(import.meta.dir, '../../../../apps/host/src/maintenance.ts') },
      { action: 'process.prepareRecovery', owner: { instanceId: lock.instanceId, startupToken: lock.startupToken }, lockPath: this.paths.lockPath }, randomUUID());
    if (!result.ok) throw result.error;
    await this.refreshStopProof(); return this.read();
  }
  private status() { this.deliverNotice({ type: "host.status", host: this.read() }); }
  private settle(requestId: string, result: Result<unknown>) {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId); clearTimeout(pending.timer); pending.resolve(result);
  }
  private interrupt(error: AppError) {
    for (const [requestId, pending] of this.pending) this.settle(requestId, { ok: false, error: safeError(isReadOnlyMethod(pending.method) ? error.code : "operation_result_unknown", undefined, { operationRef: pending.operationRef }) });
    this.preview = null;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
  }
  private fail(code: string) {
    if (this.view.error && this.view.state !== 'ready') return;
    const error = safeError(code);
    this.view = { ...this.view, state: this.child ? "stopping" : "failed", error };
    this.handshake?.reject(error); this.handshake = null;
    this.interrupt(error);
    this.diagnostic(error); this.status();
    this.child?.kill();
  }
  private write(line: string, current: () => boolean = () => true): Promise<void> {
    const child = this.child;
    const writes = this.writes;
    if (writes.count >= 256) return Promise.reject(new Error("runtime_busy"));
    writes.count++;
    const queued = writes.tail.then(() => new Promise<void>((done, reject) => {
      if (!child || this.child !== child || child.stdin.destroyed || !current()) return reject(new Error("host_interrupted"));
      let flushed = false, drained = false, completed = false;
      const finish = (error?: Error | null) => {
        if (completed) return;
        if (!error && (!flushed || !drained)) return;
        completed = true;
        child.stdin.off("drain", onDrain); child.stdin.off("close", onClose);
        if (error) reject(error); else done();
      };
      const onDrain = () => { drained = true; finish(); };
      const onClose = () => finish(new Error("host_interrupted"));
      child.stdin.once("close", onClose);
      const accepted = child.stdin.write(line, error => {
        flushed = true; finish(error);
      });
      drained = accepted;
      if (!accepted && !completed) child.stdin.once("drain", onDrain);
      finish();
    })).finally(() => writes.count--);
    writes.tail = queued.catch(() => {});
    return queued;
  }
  private async credential(frame: PrivateCredentialFrame) {
    if (this.credentialCount >= 256) throw new Error("runtime_busy");
    this.credentialCount++;
    try {
      const child = this.child;
      let result: Result<unknown>;
      try { result = await this.options.onCredentialRequest?.(frame) ?? { ok: false, error: safeError("credential_storage_unavailable") }; }
      catch { result = { ok: false, error: safeError("credential_read_failed") }; }
      if (this.child !== child || this.view.instanceId !== frame.instanceId) return;
      const reply = PrivateCredentialReplySchema.parse({ protocolVersion: HOST_PROTOCOL_VERSION, kind: "private", secret: true, instanceId: frame.instanceId, requestId: frame.requestId, method: frame.method, result });
      await this.write(encodeHostFrame(reply));
    } finally { this.credentialCount--; }
  }
  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end: number;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      if (end > MAX_FRAME_BYTES) throw new Error("frame_too_large");
      const line = new TextDecoder("utf-8", { fatal: true }).decode(this.buffer.subarray(0, end));
      this.buffer = this.buffer.subarray(end + 1);
      if (this.handshake) {
        const raw = JSON.parse(line);
        if (raw?.kind === "private") {
          const frame = PrivateCredentialFrameSchema.parse(raw);
          if (frame.instanceId !== this.view.instanceId) throw new Error("host_protocol_mismatch");
          const child = this.child;
          void this.credential(frame).catch(() => { if (this.child === child) this.fail("invalid_frame"); });
          continue;
        }
        const ready = HostReadySchema.parse(raw);
        if (ready.instanceId !== this.view.instanceId || ready.dataRoot !== this.paths.dataRoot) throw new Error("host_protocol_mismatch");
        const handshake = this.handshake; this.handshake = null;
        this.view = { ...this.view, state: this.view.state === "stopping" ? "stopping" : "ready", sdkVersion: ready.sdkVersion, schemaVersion: ready.schemaVersion, error: this.view.state === 'stopping' ? this.view.error : null };
        this.status(); handshake.resolve(ready); continue;
      }
      const frame = parseHostFrame(line, this.view.instanceId!);
      if (frame.kind === "reply") {
        const pending = this.pending.get(frame.requestId);
        if (!pending) { this.diagnostic(safeError("invalid_frame")); continue; }
        const result: Result<unknown> = frame.result.ok ? { ok: true, data: pending.output.parse(frame.result.data) } : frame.result;
        this.settle(frame.requestId, result);
      } else if (frame.kind === "private" && "payload" in frame) {
        const child = this.child;
        void this.credential(frame).catch(() => { if (this.child === child) this.fail("invalid_frame"); });
      } else if (frame.kind === "notice") {
        if (frame.notice.type === 'event.stream') this.streamNotice(frame.notice);
        else if (frame.notice.type === "provider.preview" || frame.notice.type === "agent.preview") {
          // ponytail: one root Run needs one pending preview; use per-Run slots when subruns ship.
          this.preview = structuredClone(frame.notice);
          if (!this.previewTimer) {
            this.previewTimer = setTimeout(() => {
              this.previewTimer = null; const preview = this.preview; this.preview = null;
              if (preview) this.deliverNotice(preview);
            }, 32);
          }
        } else {
          if ((frame.notice.type === "provider.settled" || frame.notice.type === "provider.persistence_failed" || frame.notice.type === "agent.settled" || frame.notice.type === "agent.persistence_failed") && this.preview?.runId === frame.notice.runId) this.preview = null;
          this.deliverNotice(frame.notice);
        }
      } else throw new Error("invalid_frame");
    }
    if (this.buffer.length > MAX_FRAME_BYTES) throw new Error("frame_too_large");
  }
  async start(): Promise<HostView> {
    if (this.child || this.starting) throw new Error('runtime_busy');
    const work = this.startOwned(); this.starting = work;
    try { await work; } finally { this.starting = null; this.status(); }
    return this.read();
  }
  private async startOwned(): Promise<void> {
    await this.refreshStopProof();
    if (this.view.state === 'stopping' || !this.lockAvailable()) {
      this.view = { ...this.view, state: this.view.state === 'stopping' ? 'stopping' : 'failed', error: safeError("host_stop_unconfirmed") };
      this.diagnostic(this.view.error!); this.status(); return;
    }
    const instanceId = randomUUID(); const startupToken = randomUUID();
    this.view = { instanceId, state: "starting", canStart: false, sdkVersion: null, schemaVersion: null, error: null };
    this.buffer = Buffer.alloc(0); this.writes = { tail: Promise.resolve(), count: 0 };
    this.clearStreams();
    const ready = new Promise<HostReady>((resolve, reject) => { this.handshake = { resolve, reject }; });
    void ready.catch(() => {});
    const child = spawn(this.options.bunExecutable ?? "bun", ["--no-env-file", resolve(this.options.hostEntry)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AWS_MAX_ATTEMPTS: "1", MEDCLAW_INSTANCE_ID: instanceId, MEDCLAW_STARTUP_TOKEN: startupToken, PI_CODING_AGENT_DIR: join(this.paths.dataRoot, 'runtime/sdk') } });
    const startupFailure: { value: HostStartupFailure | null } = { value: null };
    const failureReader = new HostStartupFailureReader();
    this.child = child;
    this.exited = new Promise<void>(done => child.once("close", (code, signal) => { void (async () => {
      if (this.child === child) {
        this.child = null; this.preview = null; this.clearStreams();
        const stopped = this.view.state === "stopping" && (!this.view.error || this.view.error.code === "host_stop_unconfirmed") && code === 0 && signal === null;
        const failed = this.view.error !== null;
        const error = this.view.error ?? startupFailure.value?.error ?? safeError("host_interrupted");
        if (startupFailure.value) { try { this.options.onStartupFailure?.(startupFailure.value); } catch { /* Diagnostics cannot alter Host control. */ } }
        this.handshake?.reject(error); this.handshake = null;
        this.interrupt(error);
        this.view = { ...this.view, state: stopped ? "stopping" : "failed", canStart: false, error: stopped ? null : error };
        this.view.shutdown = { executionStopped: null, requiredPersistenceComplete: null, databaseClosed: null, processTreeStopped: null, error: null,
          ...this.view.shutdown, processExited: true };
        if (!stopped && !failed) this.diagnostic(error);
        this.options.onExit?.(instanceId); await this.refreshStopProof();
      }
      done();
    })().catch(() => { this.diagnostic(safeError('host_stop_unconfirmed')); done(); }); }));
    const exited = this.exited;
    child.on("error", () => { if (this.child === child) this.fail("host_start_failed"); });
    child.stdin.on("error", () => { if (this.child === child && this.view.state !== "stopping") this.fail("host_interrupted"); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      try { this.receive(chunk); }
      catch (error) { this.fail(error instanceof Error && error.message === "frame_too_large" ? "frame_too_large" : this.view.state === "handshaking" ? "host_protocol_mismatch" : "invalid_frame"); }
    });
    const outputClosed = () => {
      if (this.child !== child) return;
      if (this.buffer.length) this.fail('invalid_frame');
      else if (this.view.state !== 'stopping') {
        if (this.handshake) {
          // Keep startup diagnostics readable until close confirms the failed process.
          this.view.state = 'stopping'; this.status(); child.kill();
        } else this.fail('host_interrupted');
      }
    };
    child.stdout.on('end', outputClosed); child.stdout.on('close', outputClosed); child.stdout.on('error', outputClosed);
    // Never forward raw stderr, which can contain provider secrets. A fatal
    // startup line is useful only after its phase/code are validated and exit is confirmed.
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child === child && this.handshake) failureReader.push(chunk, failure => { startupFailure.value = failure; });
    });
    this.options.onStarting?.(instanceId);
    this.view.state = "handshaking"; this.status();
    // The full imported catalog requires a synchronous integrity check before ready.
    const timer = setTimeout(() => { if (this.child === child && this.handshake) this.fail("host_start_failed"); }, 60000);
    try {
      const hello = HostHelloSchema.parse({ protocolVersion: HOST_PROTOCOL_VERSION, instanceId, startupToken, sdkVersion: SDK_VERSION, expectedSchemaVersion: DATABASE_SCHEMA_VERSION, paths: this.paths,
        resourceRoot: this.options.resourceRoot ?? resolve(import.meta.dir, '../../../../resources'),
        installManifestPath: this.options.installManifestPath ?? resolve(import.meta.dir, '../../../../.build/package-resources/medclaw/install.json') });
      await this.write(`${JSON.stringify(hello)}\n`);
      await ready;
    } catch {
      if (this.child === child && !this.view.error && this.read().state !== "stopping") this.fail("host_start_failed");
      await waitForExit(exited);
      if (this.child === child) { this.view.state = "stopping"; this.view.error ??= safeError("host_stop_unconfirmed"); this.status(); }
    } finally { clearTimeout(timer); }
  }
  async request(method: HostMethod, payload: unknown, operationRef: string = randomUUID(), requestId: string = randomUUID(), expectedInstanceId?: string): Promise<Result<unknown>> {
    if (expectedInstanceId && expectedInstanceId !== this.view.instanceId) return { ok: false, error: safeError('host_interrupted', undefined, { operationRef }) };
    if (!this.child || (this.view.state !== "ready" && !(this.view.state === "stopping" && method === "host.shutdown"))) return { ok: false, error: safeError("host_not_ready") };
    const frame = HostRequestSchema.parse({ protocolVersion: HOST_PROTOCOL_VERSION, kind: "request", instanceId: this.view.instanceId, requestId, operationRef, method, payload });
    if (this.pending.has(requestId)) throw new Error("state_conflict");
    if (this.pending.size >= 256) return { ok: false, error: safeError("runtime_busy", undefined, { operationRef }) };
    const line = encodeHostFrame(frame);
    if (method === 'event.subscribe' && (frame.payload as { action: string }).action === 'close') {
      const sid = (frame.payload as { subscriptionId: string }).subscriptionId;
      for (const key of this.streams.keys()) if (JSON.parse(key)[0] === sid) this.streams.delete(key);
      for (const key of this.streamRevisions.keys()) if (JSON.parse(key)[0] === sid) this.streamRevisions.delete(key);
    }
    let pending: Pending;
    const reply = new Promise<Result<unknown>>(resolve => {
      const timer = setTimeout(() => this.settle(requestId, { ok: false, error: safeError(isReadOnlyMethod(method) ? "host_not_ready" : "operation_result_unknown", undefined, { operationRef }) }), 10000);
      const output=method in hostPrivateMethodSchemas?hostPrivateMethodSchemas[method as HostPrivateMethod].output:publicOutputSchema(method as PublicHostRequest['method'],frame.payload);
      pending = { method, operationRef, output, timer, resolve };
      this.pending.set(requestId, pending);
    });
    void this.write(line, () => this.pending.get(requestId) === pending).catch(() => {
      if (this.pending.get(requestId) === pending) this.settle(requestId, { ok: false, error: safeError(isReadOnlyMethod(method) ? "host_interrupted" : "operation_result_unknown", undefined, { operationRef }) });
    });
    return reply;
  }
  async stop(expectedInstanceId: string, requireIdle = false): Promise<HostView> {
    if (expectedInstanceId !== this.view.instanceId) throw new Error("host_protocol_mismatch");
    const child = this.child;
    if (!child) { await this.exited; return this.read(); }
    const exited = this.exited;
    if (this.view.error?.code === 'maintenance_busy') this.view.error = null;
    this.view.state = "stopping"; this.status(); this.preview = null; this.clearStreams();
    const response = this.request('host.shutdown', { expectedInstanceId, ...(requireIdle ? { requireIdle: true } : {}) });
    const shutdown = response.then(result => {
      if (this.view.instanceId !== expectedInstanceId) return;
      const proof: HostShutdownProof = { executionStopped: null, requiredPersistenceComplete: null, databaseClosed: null,
        processExited: this.child === null, processTreeStopped: this.view.shutdown?.processTreeStopped ?? null, error: result.ok ? null : result.error };
      if (result.ok) {
        const saved = HostShutdownResultSchema.parse(result.data);
        proof.executionStopped = saved.executionStopped; proof.requiredPersistenceComplete = saved.requiredPersistenceComplete ?? null; proof.databaseClosed = saved.databaseClosed;
      }
      this.view.shutdown = proof;
      this.settleStoppedState();
    }).catch(() => { this.diagnostic(safeError('host_stop_unconfirmed')); });
    if (requireIdle) {
      const result = await response; await shutdown;
      if (!result.ok && result.error.code === 'maintenance_busy' && this.child === child) {
        this.view.state = 'ready'; this.view.error = result.error; delete this.view.shutdown; this.status(); return this.read();
      }
    }
    await waitForExit(exited);
    if (this.child === child) { child.kill(); await waitForExit(exited); }
    if (this.child === child) { this.view.error ??= safeError("host_stop_unconfirmed"); this.status(); }
    await shutdown;
    return this.read();
  }
  async restart(expectedInstanceId: string): Promise<HostView> { await this.stop(expectedInstanceId); return this.read().canStart ? this.start() : this.read(); }
}
