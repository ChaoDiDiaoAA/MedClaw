import { open, readFile, unlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { HostHelloSchema, HostRequestSchema, HostPrivateRequestSchema, PrivateCredentialReplySchema, NoticeFrameSchema, encodeHostFrame, publicMethodSchemas, hostPrivateMethodSchemas, isReadOnlyMethod, MAX_FRAME_BYTES, HOST_PROTOCOL_VERSION, type HostHello, type HostRequest, type RuntimeNotice, type PrivateCredentialMethod } from "../../../packages/contracts/src/protocol.ts";
import { PublishedSettingsSchema } from "../../../packages/contracts/src/model.ts";
import { AppErrorSchema, safeError, OpaqueIdSchema, type Result } from "../../../packages/contracts/src/error.ts";
import { openDatabase, SCHEMA_VERSION } from "../../../packages/storage/src/database.ts";
import { Repositories } from "../../../packages/storage/src/repositories.ts";
import { PiModelRuntime, CatalogStore, SDK_VERSION, installedSdkVersion, type ResolvedModel } from "../../../packages/runtime-pi/src/model-runtime.ts";
import { BridgeCredentialStore } from "../../../packages/runtime-pi/src/credential-store.ts";
import { ModelCallRecorder } from "../../../packages/runtime-pi/src/model-call-recorder.ts";
import { Application } from "../../../packages/core/src/application.ts";
import { SessionService } from "../../../packages/core/src/session/session-service.ts";
import { WorkspaceService } from "../../../packages/core/src/workspace/workspace-service.ts";
import { PiAgentRuntime } from "../../../packages/runtime-pi/src/agent-runtime.ts";
import { ErrorLog } from "../../../packages/logging/src/error-log.ts";
import { RuntimeLog } from "../../../packages/logging/src/runtime-log.ts";
import { PromptTrace } from "../../../packages/logging/src/prompt-trace.ts";

const errorLog = new ErrorLog("host"), runtimeLog = new RuntimeLog("host"), promptTrace = new PromptTrace();

let hello: HostHello | null = null, application: Application<ResolvedModel> | null = null;
let sessions: SessionService | null = null, workspace: WorkspaceService | null = null;
let database: ReturnType<typeof openDatabase> | null = null;
let locked = false, closing = false, controlCount = 0;
let terminating = false, shutdownTask: Promise<void> | null = null, fatalTask: Promise<void> | null = null;
let startupPhase = "hello";
let writes: Promise<unknown> = Promise.resolve();
const pending = new Map<string, { method: PrivateCredentialMethod; resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
const previews = new Map<number, Extract<RuntimeNotice, { type: "provider.preview" | "agent.preview" }>>();
let previewTimer: ReturnType<typeof setTimeout> | null = null;
function sendRaw(line: string): Promise<void> {
  if (Buffer.byteLength(line.trimEnd(), "utf8") > MAX_FRAME_BYTES) throw new Error("frame_too_large");
  if (++controlCount > 256) { controlCount--; throw new Error("runtime_busy"); }
  const next = writes.catch(() => {}).then(() => new Promise<void>((resolve, reject) => process.stdout.write(line, error => error ? reject(error) : resolve())));
  writes = next.finally(() => controlCount--);
  return next;
}
function notice(notice: RuntimeNotice) {
  if (!hello || (closing && (notice.type === "provider.preview" || notice.type === "agent.preview"))) return;
  if (notice.type === "provider.preview") promptTrace.add(notice.runId, "provider.preview");
  if (notice.type === "provider.settled" || notice.type === "agent.settled") { promptTrace.add(notice.runId, "run_saved"); promptTrace.finish(notice.runId); }
  if (notice.type === "provider.persistence_failed" || notice.type === "agent.persistence_failed") { errorLog.add(notice.error, { runId: notice.runId }); promptTrace.add(notice.runId, notice.type); }
  if (notice.type === "auth.finished") runtimeLog.add("auth_finished");
  if (notice.type === "provider.preview" || notice.type === "agent.preview") {
    previews.set(notice.runId, notice);
    if (!previewTimer) previewTimer = setTimeout(() => { previewTimer = null; const latest = [...previews.values()]; previews.clear(); latest.forEach(n => void sendNotice(n).catch(() => {})); }, 32);
  } else {
    if (notice.type === "provider.settled" || notice.type === "provider.persistence_failed" || notice.type === "agent.settled" || notice.type === "agent.persistence_failed") previews.delete(notice.runId);
    void sendNotice(notice).catch(() => {});
  }
}
function sendNotice(notice: RuntimeNotice) {
  return sendRaw(encodeHostFrame(NoticeFrameSchema.parse({ protocolVersion: HOST_PROTOCOL_VERSION, kind: "notice", instanceId: hello!.instanceId, notice })));
}
async function credentials(method: string, payload: unknown): Promise<unknown> {
  if (!hello || terminating) throw new Error("host_interrupted");
  const requestId = crypto.randomUUID();
  const promise = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("operation_result_unknown")); }, 10000);
    pending.set(requestId, { method: method as PrivateCredentialMethod, resolve, reject, timer });
  });
  void promise.catch(() => {});
  try { await sendRaw(encodeHostFrame({ protocolVersion: HOST_PROTOCOL_VERSION, kind: "private", instanceId: hello.instanceId, requestId, secret: true, method: method as PrivateCredentialMethod, payload } as never)); }
  catch (error) { const call = pending.get(requestId); if (call) { clearTimeout(call.timer); pending.delete(requestId); call.reject(error); } }
  return promise;
}
function processAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return true;
  try { process.kill(pid as number, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function acquireLock(config: HostHello) {
  const root = await realpath(config.paths.dataRoot);
  if (resolve(root).toLowerCase() !== resolve(config.paths.dataRoot).toLowerCase()) throw new Error("access_denied");
  for (const path of Object.values(config.paths)) {
    if (!isAbsolute(path)) throw new Error("access_denied");
    const part = relative(root, path);
    if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error("access_denied");
    if (path !== config.paths.dataRoot) {
      const parent = await realpath(dirname(path));
      const parentPart = relative(root, parent);
      if (parentPart === ".." || parentPart.startsWith(`..${sep}`) || isAbsolute(parentPart)) throw new Error("access_denied");
    }
  }
  try {
    const handle = await open(config.paths.lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, instanceId: config.instanceId, startupToken: config.startupToken })); await handle.sync(); await handle.close(); locked = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let previous: { pid?: unknown; instanceId?: unknown; startupToken?: unknown };
    try { previous = JSON.parse(await readFile(config.paths.lockPath, "utf8")); }
    catch { throw new Error("host_stop_unconfirmed"); }
    if (!previous || !OpaqueIdSchema.safeParse(previous.instanceId).success || !OpaqueIdSchema.safeParse(previous.startupToken).success) throw new Error("host_stop_unconfirmed");
    if (processAlive(previous.pid)) throw new Error("host_stop_unconfirmed");
    await unlink(config.paths.lockPath); await acquireLock(config);
  }
}
async function releaseLock() {
  if (!locked || !hello) return;
  try {
    const current = JSON.parse(await readFile(hello.paths.lockPath, "utf8"));
    if (current.pid === process.pid && current.instanceId === hello.instanceId && current.startupToken === hello.startupToken) await unlink(hello.paths.lockPath);
  } finally { locked = false; }
}
function shutdownHost(): Promise<void> {
  if (shutdownTask) return shutdownTask;
  closing = true;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = null; previews.clear();
  return shutdownTask = (async () => {
    await application?.shutdown();
    database?.close(); database = null; await releaseLock();
  })();
}
async function initialize(raw: unknown) {
  const config = HostHelloSchema.parse(raw);
  if (config.instanceId !== process.env.MEDCLAW_INSTANCE_ID || config.startupToken !== process.env.MEDCLAW_STARTUP_TOKEN || process.env.AWS_MAX_ATTEMPTS !== "1") throw new Error("host_protocol_mismatch");
  startupPhase = "sdk_version";
  const actualVersion = await installedSdkVersion();
  if (actualVersion !== SDK_VERSION) throw new Error("host_protocol_mismatch");
  startupPhase = "writer_lock";
  hello = config; await acquireLock(config);
  startupPhase = "settings_read";
  const settings = PublishedSettingsSchema.parse(JSON.parse(await readFile(config.paths.settingsPath, "utf8")));
  startupPhase = "database_open"; database = openDatabase(config.paths.databasePath);
  const repositories = new Repositories(database);
  try { repositories.recoverInterrupted(config.instanceId, new Date().toISOString()); }
  catch { errorLog.add(safeError("storage_write_failed")); }
  const credentialStore = new BridgeCredentialStore(credentials);
  startupPhase = "pi_runtime";
  const runtime = await PiModelRuntime.create({ credentials: credentialStore, modelsStore: await CatalogStore.open(config.paths.cachePath, error => errorLog.add(error)) });
  startupPhase = "custom_registration";
  await runtime.installCustom(settings.customProviders.map(p => p.definition));
  const agent = new PiAgentRuntime(runtime, config.paths.dataRoot);
  application = new Application(config.instanceId, settings, runtime, repositories,
    (context, action) => credentialStore.withContext(context, action),
    (runId, kind, time) => new ModelCallRecorder(repositories, runId, kind, time),
    notice, error => errorLog.add(error), agent);
  application.runs.recoverInterrupted(true); // The writer lock proves that the previous owning process exited.
  sessions = new SessionService(config.instanceId, repositories, agent, (input, context) => application!.runs.submitAgent(input, context), () => application!.runs.activeHandle);
  workspace = new WorkspaceService(repositories);
  await sendRaw(`${JSON.stringify({ protocolVersion: HOST_PROTOCOL_VERSION, instanceId: config.instanceId, sdkVersion: actualVersion, schemaVersion: SCHEMA_VERSION, configVersion: settings.configVersion, dataRoot: config.paths.dataRoot })}\n`);
  runtimeLog.add("host_ready");
  startupPhase = "ready";
}
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw result.error; return result.data; }
async function dispatch(request: HostRequest): Promise<unknown> {
  const app = application;
  if (!app || !hello) throw new Error("host_not_ready");
  switch (request.method) {
    case "model.list": case "model.read": return app.directory();
    case "model.refresh": return { ...await app.refresh(request.operationRef, request.payload.providerId), directory: await app.directory() };
    case "operation.cancel": return app.cancelOperation(request.payload.operationRef);
    case "model.auth.start": return app.startAuth(request.operationRef, request.payload.providerId, request.payload.type);
    case "model.auth.respond": return app.respondAuth(request.payload.authAttemptId, request.payload.promptId, request.payload.value);
    case "model.auth.cancel": return app.cancelAuth(request.payload.authAttemptId);
    case "model.auth.status": return app.authStatus(request.payload.providerId, request.payload.authAttemptId);
    case "model.custom.read": return { configVersion: app.config.configVersion, definitions: app.config.customProviders.filter(p => !request.payload.providerId || p.definition.providerId === request.payload.providerId).map(p => p.definition) };
    case "model.request": return app.submitProvider(request, "main");
    case "model.diagnose": return app.submitProvider(request, "diagnostic");
    case "run.read": return unwrap(await app.runs.read(request.payload));
    case "run.active": return unwrap(await app.runs.active());
    case "run.control.read": return unwrap(await app.runs.readControl());
    case "run.cancel": return unwrap(await app.runs.cancel(request.payload.runId));
    case "run.retrySave": return unwrap(await app.runs.retrySave(request.payload.runId));
    case "session.create": return unwrap(await sessions!.create(request.payload, request));
    case "session.select": return unwrap(await sessions!.select(request.payload));
    case "session.list": return unwrap(await sessions!.list(request.payload));
    case "session.read": return unwrap(await sessions!.read(request.payload.sessionId));
    case "session.submit": return unwrap(await sessions!.submit(request.payload, request));
    case "session.readSubmission": return unwrap(await sessions!.readSubmission(request.payload));
    case "workspace.read": return unwrap(await workspace!.read());
    case "workspace.restore": return unwrap(await workspace!.restore());
    case "settings.prepare": return app.prepareConfig(request.payload.token, request.payload.candidate);
    case "settings.commit": { app.commitConfig(request.payload.token, request.payload.publishedVersion); return { configVersion: app.config.configVersion, selection: (await app.directory()).selection }; }
    case "settings.abort": await app.abortConfig(request.payload.token); return { aborted: true };
    case "host.shutdown":
      if (request.payload.expectedInstanceId !== hello.instanceId) throw new Error("host_protocol_mismatch");
      await shutdownHost(); return { executionStopped: true, databaseClosed: true };
    case "diagnostics.read": return { partial: false, missingSources: [], versions: { sdkVersion: SDK_VERSION, protocolVersion: HOST_PROTOCOL_VERSION, schemaVersion: SCHEMA_VERSION, configVersion: app.config.configVersion, bunVersion: Bun.version, electronVersion: null }, host: { instanceId: hello.instanceId, state: "ready", canStart: false, sdkVersion: SDK_VERSION, schemaVersion: SCHEMA_VERSION, error: null }, entries: [...errorLog.read(), ...runtimeLog.read(), ...promptTrace.read()].filter(entry => request.payload.categories.includes(entry.category)) };
    default: throw new Error("access_denied"); // Main owns all publication, display and Host-control methods.
  }
}
async function request(raw: unknown) {
  const frame = HostRequestSchema.parse(raw);
  if (frame.instanceId !== hello?.instanceId) throw new Error("host_protocol_mismatch");
  let result: Result<unknown>;
  try {
    if (closing && frame.method !== "host.shutdown") throw new Error("runtime_busy");
    runtimeLog.add("request_received", { operationRef: frame.operationRef });
    const data = await dispatch(frame);
    const schema = frame.method in hostPrivateMethodSchemas ? hostPrivateMethodSchemas[frame.method as keyof typeof hostPrivateMethodSchemas].output : publicMethodSchemas[frame.method as keyof typeof publicMethodSchemas].output;
    try { result = { ok: true, data: schema.parse(data) }; }
    catch { throw safeError(isReadOnlyMethod(frame.method) ? "host_protocol_mismatch" : "operation_result_unknown", undefined, { operationRef: frame.operationRef }); }
  } catch (error) { const known = AppErrorSchema.safeParse(error); const safe = known.success ? { ...known.data, operationRef: frame.operationRef }
    : safeError(error instanceof Error ? error.message : "internal_error", error, { operationRef: frame.operationRef }); errorLog.add(safe); result = { ok: false, error: safe }; }
  if (terminating) return;
  await sendRaw(encodeHostFrame({ protocolVersion: HOST_PROTOCOL_VERSION, kind: "reply", instanceId: frame.instanceId, requestId: frame.requestId, result } as never));
  if (frame.method === "host.shutdown" && result.ok) { closing = true; await writes; process.exit(0); }
}
async function handle(raw: unknown) {
  if (terminating) return;
  if (!hello) { await initialize(raw); return; }
  if ((raw as { kind?: string } | null)?.kind === "private") {
    const reply = PrivateCredentialReplySchema.parse(raw);
    if (reply.instanceId !== hello.instanceId) throw new Error("host_protocol_mismatch");
    const call = pending.get(reply.requestId);
    if (!call || call.method !== reply.method) return;
    pending.delete(reply.requestId); clearTimeout(call.timer);
    reply.result.ok ? call.resolve(reply.result.data) : call.reject(new Error(reply.result.error.code)); return;
  }
  await request(raw);
}
function fatal(error?: unknown): Promise<void> {
  if (fatalTask) return fatalTask;
  closing = true; terminating = true;
  pending.forEach(p => { clearTimeout(p.timer); p.reject(new Error("host_interrupted")); }); pending.clear();
  return fatalTask = (async () => {
    try { await shutdownHost(); } catch { /* Recovery will mark any unknown execution after this writer exits. */ }
    try { database?.close(); database = null; await releaseLock(); } catch {}
    const code = safeError(error instanceof Error ? error.message : "host_interrupted").code;
    process.stderr.write(`MedClaw Host terminated: ${startupPhase}/${code}.\n`);
    process.exit(1);
  })();
}
let input = Buffer.alloc(0), initialization: Promise<void> | null = null, inflight = 0;
const decoder = new TextDecoder("utf-8", { fatal: true });
process.stdin.on("data", (chunk: Buffer) => {
  if (terminating) return;
  input = Buffer.concat([input, chunk]);
  if (input.length > MAX_FRAME_BYTES && input.indexOf(10) < 0) { void fatal(new Error("frame_too_large")); return; }
  let end: number;
  while ((end = input.indexOf(10)) !== -1) {
    const line = input.subarray(0, end); input = input.subarray(end + 1);
    if (line.length > MAX_FRAME_BYTES || ++inflight > 256) { void fatal(new Error(line.length > MAX_FRAME_BYTES ? "frame_too_large" : "runtime_busy")); return; }
    let raw: unknown;
    try { raw = JSON.parse(decoder.decode(line)); } catch { void fatal(new Error("invalid_frame")); return; }
    if (!initialization) initialization = handle(raw).catch(fatal).finally(() => inflight--);
    // Credential replies must be processed during initialization, which itself awaits them.
    else if (hello && (raw as { kind?: string } | null)?.kind === "private") void handle(raw).catch(fatal).finally(() => inflight--);
    else void initialization.then(() => handle(raw)).catch(fatal).finally(() => inflight--);
  }
});
process.stdin.on("end", () => void fatal());
process.on("SIGTERM", () => void fatal());
