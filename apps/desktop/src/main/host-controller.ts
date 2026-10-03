import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { OpaqueIdSchema, safeError, type AppError, type Result } from "@medclaw/contracts/error";
import { SDK_VERSION, type HostView } from "@medclaw/contracts/model";
import {
  DATABASE_SCHEMA_VERSION, HOST_PROTOCOL_VERSION, MAX_FRAME_BYTES,
  HostHelloSchema, HostReadySchema, HostRequestSchema, PrivateCredentialFrameSchema, PrivateCredentialReplySchema,
  encodeHostFrame, parseHostFrame, hostPrivateMethodSchemas, publicMethodSchemas, isReadOnlyMethod,
  type DesktopNotice, type HostHello, type HostPrivateMethod, type HostReady,
  type PrivateCredentialFrame, type PublicHostRequest,
} from "@medclaw/contracts/protocol";

export interface HostControllerOptions {
  dataRoot: string;
  hostEntry: string;
  bunExecutable?: string;
  onCredentialRequest?: (frame: PrivateCredentialFrame) => Promise<Result<unknown>>;
  onNotice?: (notice: DesktopNotice) => void;
  onError?: (error: AppError) => void;
  onStarting?: (instanceId: string) => void;
  onExit?: (instanceId: string) => void;
}
type HostMethod = PublicHostRequest["method"] | HostPrivateMethod;
type Pending = { method: HostMethod; operationRef: string; timer: ReturnType<typeof setTimeout>; resolve: (result: Result<unknown>) => void };
const waitForExit = async (exited: Promise<void>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 10000); timer.unref(); })]); }
  finally { clearTimeout(timer); }
};

export class HostController {
  readonly paths: HostHello["paths"];
  private child: ChildProcessWithoutNullStreams | null = null;
  private exited: Promise<void> = Promise.resolve();
  private view: HostView = { instanceId: null, state: "stopped", canStart: true, sdkVersion: null, schemaVersion: null, error: null };
  private handshake: { resolve: (ready: HostReady) => void; reject: (error: AppError) => void } | null = null;
  private buffer = Buffer.alloc(0);
  private writes = { tail: Promise.resolve(), count: 0 };
  private pending = new Map<string, Pending>();
  private credentialCount = 0;
  private preview: Extract<DesktopNotice, { type: "provider.preview" | "agent.preview" }> | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
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
      const lock = JSON.parse(readFileSync(this.paths.lockPath, "utf8")) as { pid?: unknown; instanceId?: unknown; startupToken?: unknown };
      if (!Number.isSafeInteger(lock.pid) || (lock.pid as number) <= 0 || !OpaqueIdSchema.safeParse(lock.instanceId).success || !OpaqueIdSchema.safeParse(lock.startupToken).success) return false;
      try { process.kill(lock.pid as number, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  }
  read(): HostView { return { ...this.view, canStart: this.child === null && this.lockAvailable(), error: this.view.error ? { ...this.view.error } : null }; }
  private status() { this.options.onNotice?.({ type: "host.status", host: this.read() }); }
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
    if (this.view.error) return;
    const error = safeError(code);
    this.view = { ...this.view, state: this.child ? "stopping" : "failed", error };
    this.handshake?.reject(error); this.handshake = null;
    this.interrupt(error);
    this.options.onError?.(error); this.status();
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
        this.view = { ...this.view, state: this.view.state === "stopping" ? "stopping" : "ready", sdkVersion: ready.sdkVersion, schemaVersion: ready.schemaVersion, error: null };
        this.status(); handshake.resolve(ready); continue;
      }
      const frame = parseHostFrame(line, this.view.instanceId!);
      if (frame.kind === "reply") {
        const pending = this.pending.get(frame.requestId);
        if (!pending) { this.options.onError?.(safeError("invalid_frame")); continue; }
        const schema = pending.method in hostPrivateMethodSchemas
          ? hostPrivateMethodSchemas[pending.method as HostPrivateMethod]
          : publicMethodSchemas[pending.method as PublicHostRequest["method"]];
        const result: Result<unknown> = frame.result.ok ? { ok: true, data: schema.output.parse(frame.result.data) } : frame.result;
        this.settle(frame.requestId, result);
      } else if (frame.kind === "private" && "payload" in frame) {
        const child = this.child;
        void this.credential(frame).catch(() => { if (this.child === child) this.fail("invalid_frame"); });
      } else if (frame.kind === "notice") {
        if (frame.notice.type === "provider.preview" || frame.notice.type === "agent.preview") {
          // ponytail: one root Run needs one pending preview; use per-Run slots when subruns ship.
          this.preview = structuredClone(frame.notice);
          if (!this.previewTimer) {
            this.previewTimer = setTimeout(() => {
              this.previewTimer = null; const preview = this.preview; this.preview = null;
              if (preview) { try { this.options.onNotice?.(preview); } catch { this.options.onError?.(safeError("preview_delivery_failed")); } }
            }, 32);
          }
        } else {
          if ((frame.notice.type === "provider.settled" || frame.notice.type === "provider.persistence_failed" || frame.notice.type === "agent.settled" || frame.notice.type === "agent.persistence_failed") && this.preview?.runId === frame.notice.runId) this.preview = null;
          this.options.onNotice?.(structuredClone(frame.notice));
        }
      } else throw new Error("invalid_frame");
    }
    if (this.buffer.length > MAX_FRAME_BYTES) throw new Error("frame_too_large");
  }
  async start(): Promise<HostView> {
    if (this.child) throw new Error("runtime_busy");
    if (!this.lockAvailable()) {
      this.view = { ...this.view, state: "failed", error: safeError("host_stop_unconfirmed") };
      this.options.onError?.(this.view.error!); this.status(); return this.read();
    }
    const instanceId = randomUUID(); const startupToken = randomUUID();
    this.view = { instanceId, state: "starting", canStart: false, sdkVersion: null, schemaVersion: null, error: null };
    this.buffer = Buffer.alloc(0); this.writes = { tail: Promise.resolve(), count: 0 };
    const ready = new Promise<HostReady>((resolve, reject) => { this.handshake = { resolve, reject }; });
    void ready.catch(() => {});
    const child = spawn(this.options.bunExecutable ?? "bun", ["--no-env-file", resolve(this.options.hostEntry)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AWS_MAX_ATTEMPTS: "1", MEDCLAW_INSTANCE_ID: instanceId, MEDCLAW_STARTUP_TOKEN: startupToken } });
    this.child = child;
    this.exited = new Promise<void>(done => child.once("close", () => {
      if (this.child === child) {
        this.child = null; this.preview = null;
        const stopped = this.view.state === "stopping" && (!this.view.error || this.view.error.code === "host_stop_unconfirmed");
        const failed = this.view.error !== null;
        const error = this.view.error ?? safeError("host_interrupted");
        this.handshake?.reject(error); this.handshake = null;
        this.interrupt(error);
        this.view = { ...this.view, state: stopped ? "stopped" : "failed", canStart: true, error: stopped ? null : error };
        if (!stopped && !failed) this.options.onError?.(error);
        this.options.onExit?.(instanceId); this.status();
      }
      done();
    }));
    const exited = this.exited;
    child.on("error", () => { if (this.child === child) this.fail("host_start_failed"); });
    child.stdin.on("error", () => { if (this.child === child && this.view.state !== "stopping") this.fail("host_interrupted"); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      try { this.receive(chunk); }
      catch (error) { this.fail(error instanceof Error && error.message === "frame_too_large" ? "frame_too_large" : this.view.state === "handshaking" ? "host_protocol_mismatch" : "invalid_frame"); }
    });
    child.stdout.on("end", () => { if (this.child === child && this.buffer.length) this.fail("invalid_frame"); });
    // Never forward raw stderr, which can contain provider secrets.
    child.stderr.on("data", () => {});
    this.options.onStarting?.(instanceId);
    this.view.state = "handshaking"; this.status();
    const timer = setTimeout(() => { if (this.child === child && this.handshake) this.fail("host_start_failed"); }, 10000);
    try {
      const hello = HostHelloSchema.parse({ protocolVersion: HOST_PROTOCOL_VERSION, instanceId, startupToken, sdkVersion: SDK_VERSION, expectedSchemaVersion: DATABASE_SCHEMA_VERSION, paths: this.paths });
      await this.write(`${JSON.stringify(hello)}\n`);
      await ready;
    } catch {
      if (this.child === child && !this.view.error && this.read().state !== "stopping") this.fail("host_start_failed");
      await waitForExit(exited);
      if (this.child === child) { this.view.state = "stopping"; this.view.error ??= safeError("host_stop_unconfirmed"); this.status(); }
    } finally { clearTimeout(timer); }
    return this.read();
  }
  async request(method: HostMethod, payload: unknown, operationRef: string = randomUUID(), requestId: string = randomUUID()): Promise<Result<unknown>> {
    if (!this.child || (this.view.state !== "ready" && !(this.view.state === "stopping" && method === "host.shutdown"))) return { ok: false, error: safeError("host_not_ready") };
    const frame = HostRequestSchema.parse({ protocolVersion: HOST_PROTOCOL_VERSION, kind: "request", instanceId: this.view.instanceId, requestId, operationRef, method, payload });
    if (this.pending.has(requestId)) throw new Error("state_conflict");
    if (this.pending.size >= 256) return { ok: false, error: safeError("runtime_busy", undefined, { operationRef }) };
    const line = encodeHostFrame(frame);
    let pending: Pending;
    const reply = new Promise<Result<unknown>>(resolve => {
      const timer = setTimeout(() => this.settle(requestId, { ok: false, error: safeError(isReadOnlyMethod(method) ? "host_not_ready" : "operation_result_unknown", undefined, { operationRef }) }), 10000);
      pending = { method, operationRef, timer, resolve };
      this.pending.set(requestId, pending);
    });
    void this.write(line, () => this.pending.get(requestId) === pending).catch(() => {
      if (this.pending.get(requestId) === pending) this.settle(requestId, { ok: false, error: safeError(isReadOnlyMethod(method) ? "host_interrupted" : "operation_result_unknown", undefined, { operationRef }) });
    });
    return reply;
  }
  async stop(expectedInstanceId: string): Promise<HostView> {
    if (expectedInstanceId !== this.view.instanceId) throw new Error("host_protocol_mismatch");
    const child = this.child;
    if (!child) return this.read();
    const exited = this.exited;
    this.view.state = "stopping"; this.status(); this.preview = null;
    void this.request("host.shutdown", { expectedInstanceId }).catch(() => {});
    await waitForExit(exited);
    if (this.child === child) { child.kill(); await waitForExit(exited); }
    if (this.child === child) { this.view.error ??= safeError("host_stop_unconfirmed"); this.status(); }
    return this.read();
  }
  async restart(expectedInstanceId: string): Promise<HostView> { await this.stop(expectedInstanceId); return this.child ? this.read() : this.start(); }
}
