import { open, readFile, unlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, join } from "node:path";
import { HostHelloSchema, HostRequestSchema, HostPrivateRequestSchema, PrivateCredentialReplySchema, NoticeFrameSchema, encodeHostFrame, publicMethodSchemas, createPublicMethodSchemas, hostPrivateMethodSchemas, isReadOnlyMethod, MAX_FRAME_BYTES, HOST_PROTOCOL_VERSION, type HostHello, type HostRequest, type RuntimeNotice, type PrivateCredentialMethod } from "../../../packages/contracts/src/protocol.ts";
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
import { projectToolCall } from "../../../packages/runtime-pi/src/messages.ts";
import { SqliteCatalogStore } from '../../../packages/storage/src/catalog-store.ts';
import { SqliteToolStore } from '../../../packages/storage/src/tool-store.ts';
import { SqliteImportStore } from '../../../packages/storage/src/import-store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifact-store.ts';
import { CatalogService } from '../../../packages/core/src/data/catalog-service.ts';
import { QueryService } from '../../../packages/core/src/data/query-service.ts';
import { ImportService } from '../../../packages/core/src/data/import-service.ts';
import { EvidenceReader } from '../../../packages/core/src/evidence/evidence-reader.ts';
import { createBusinessTools } from '../../../packages/core/src/tools/tools.ts';
import { ToolRegistry } from '../../../packages/core/src/tools/registry.ts';
import { ToolRecorder } from '../../../packages/core/src/tools/recorder.ts';
import { ToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { RunScopeSchema, canonicalRequest } from '../../../packages/contracts/src/run.ts';
import { BUSINESS_RULES, createStoredQuerySchemas, QuerySummarySchema, EvidenceSummarySchema, type QueryExecutionContext, type QueryRecord, type Evidence } from '../../../packages/contracts/src/query.ts';
import { StoredToolConfigurationSchema } from '../../../packages/contracts/src/tool-config.ts';
import { AbsolutePathSchema } from '../../../packages/contracts/src/protocol.ts';
import { ErrorLog } from "../../../packages/logging/src/error-log.ts";
import { RuntimeLog } from "../../../packages/logging/src/runtime-log.ts";
import { PromptTrace } from "../../../packages/logging/src/prompt-trace.ts";

const errorLog = new ErrorLog("host"), runtimeLog = new RuntimeLog("host"), promptTrace = new PromptTrace();

let hello: HostHello | null = null, application: Application<ResolvedModel> | null = null;
let sessions: SessionService | null = null, workspace: WorkspaceService | null = null;
let repositories: Repositories, catalog: SqliteCatalogStore, toolStore: SqliteToolStore, queries: QueryService, evidence: EvidenceReader, imports: ImportService, artifacts: ArtifactStore;
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
    const stopped = await Promise.allSettled([application?.shutdown(), imports?.shutdown()]);
    for (const result of stopped) if (result.status === 'rejected') throw result.reason;
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
  repositories = new Repositories(database);
  try { repositories.recoverInterrupted(config.instanceId, new Date().toISOString()); }
  catch { errorLog.add(safeError("storage_write_failed")); }
  const credentialStore = new BridgeCredentialStore(credentials);
  startupPhase = "pi_runtime";
  const runtime = await PiModelRuntime.create({ credentials: credentialStore, modelsStore: await CatalogStore.open(config.paths.cachePath, error => errorLog.add(error)) });
  startupPhase = "custom_registration";
  await runtime.installCustom(settings.customProviders.map(p => p.definition));
  catalog = new SqliteCatalogStore(database); toolStore = new SqliteToolStore(database);
  const catalogService = new CatalogService(catalog);
  queries = new QueryService(catalogService, toolStore); evidence = new EvidenceReader(catalogService, queries, toolStore);
  const recorder = new ToolRecorder(toolStore, (error, context) => application?.runs.failToolPersistence(context.runId, error));
  const configure = () => {
    const registry = new ToolRegistry(createBusinessTools({ catalog: catalogService, queries, evidence }));
    const executor = new ToolExecutor(registry, recorder, {
      findCommittedQuery: context => {
        const saved = toolStore.findQuery(`${context.runId}:${context.nativeToolCallId}`);
        return saved && (saved.kind === 'current' || saved.kind === 'changes')
          ? { id: saved.id, sessionId: saved.sessionId, runId: saved.runId, kind: saved.kind, callRef: saved.callRef } : null;
      },
    });
    return { registry, executor };
  };
  const agent = new PiAgentRuntime(runtime, config.paths.dataRoot, { ...configure(), recorder, configure });
  artifacts = new ArtifactStore(database, join(config.paths.dataRoot, 'artifacts'));
  imports = new ImportService({ store: new SqliteImportStore(database), artifacts, instanceId: config.instanceId,
    resolveToken: async (fileToken, operationRef) => AbsolutePathSchema.parse(await credentials('file.resolve', { fileToken, operationRef })) });
  application = new Application(config.instanceId, settings, runtime, repositories,
    (context, action) => credentialStore.withContext(context, action),
    (runId, kind, time) => new ModelCallRecorder(repositories, runId, kind, time),
    notice, error => errorLog.add(error), agent);
  application.runs.recoverInterrupted(true); // The writer lock proves that the previous owning process exited.
  sessions = new SessionService(config.instanceId, repositories, agent, (input, context) => application!.runs.submitAgent(input, context),
    () => application!.runs.activeHandle, sessionId => application!.runs.readInputControl(sessionId),
    (inputId, context) => application!.runs.cancelInput(inputId, context));
  workspace = new WorkspaceService(repositories);
  await sendRaw(`${JSON.stringify({ protocolVersion: HOST_PROTOCOL_VERSION, instanceId: config.instanceId, sdkVersion: actualVersion, schemaVersion: SCHEMA_VERSION, configVersion: settings.configVersion, dataRoot: config.paths.dataRoot })}\n`);
  runtimeLog.add("host_ready");
  startupPhase = "ready";
}
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw result.error; return result.data; }
function summary(query: QueryRecord) {
  const { rows, snapshotIds: _snapshots, eventIds: _events, ...metadata } = query;
  return QuerySummarySchema.parse({ ...metadata, totalRows: rows.length });
}
function evidenceSummary(record: Evidence) {
  const { snapshotIds, eventIds, sourceRowRefs: _sources, ...metadata } = record;
  return EvidenceSummarySchema.parse({ ...metadata, snapshotCount: snapshotIds.length, eventCount: eventIds.length });
}
function readContext(runId: number, requireSelectedSession = true): QueryExecutionContext {
  const row = database!.query<{ kind: string; session_id: number | null; input_id: number | null; scope_json: string; reference_date: string; timezone: string; config_json: string }, [number]>(
    'SELECT kind,session_id,input_id,scope_json,reference_date,timezone,config_json FROM runs WHERE id=?').get(runId);
  if (!row || row.kind !== 'agent' || row.session_id === null || requireSelectedSession && repositories.readWorkspace().sessionId !== row.session_id) throw new Error('access_denied');
  return { runId, inputId: row.input_id, sessionId: row.session_id, source: 'user_form', callRef: `read:${runId}`,
    scope: RunScopeSchema.parse(JSON.parse(row.scope_json)), referenceDate: row.reference_date, timezone: row.timezone,
    signal: new AbortController().signal };
}
function frozenConfiguration(runId: number) {
  const row = database!.query<{ config_json: string }, [number]>('SELECT config_json FROM runs WHERE id=?').get(runId);
  const value = row ? JSON.parse(row.config_json).toolConfiguration : undefined;
  return value === undefined ? undefined : StoredToolConfigurationSchema.parse(value);
}
function queryView(queryId: number, page: number, pageSize: number) {
  const saved = toolStore.readQuery(queryId); if (!saved) throw new Error('operation_not_found');
  const context = readContext(saved.runId), query = queries.read(queryId, context);
  return { query: summary(query), page: queries.page({ queryId, page, pageSize }, context),
    evidence: evidence.readQuery(queryId, context).slice(0, BUSINESS_RULES.evidenceSummaryLimit).map(evidenceSummary) };
}
function dataCatalog(page: number, pageSize: number) {
  const counts = (table: 'batches' | 'devices' | 'snapshots' | 'change_events') => database!.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count;
  const ids = database!.query<{ id: number }, [number, number]>('SELECT id FROM batches ORDER BY snapshot_date,id LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize).map(row => row.id);
  const contexts = database!.query<{ reference_date: string; timezone: string }, []>("SELECT DISTINCT json_extract(metadata_json,'$.referenceDate') AS reference_date,json_extract(metadata_json,'$.timezone') AS timezone FROM batches LIMIT 2").all();
  return { batches: catalog.readBatches(ids), page, pageSize, batchCount: counts('batches'), deviceCount: counts('devices'), snapshotCount: counts('snapshots'), changeCount: counts('change_events'),
    catalogRevision: catalog.readRevision(), referenceDate: contexts.length === 1 ? contexts[0]!.reference_date : null, timezone: contexts.length === 1 ? contexts[0]!.timezone : null };
}
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
    case "session.messages.read": return unwrap(await sessions!.readMessages(request.payload));
    case "session.readSubmission": return unwrap(await sessions!.readSubmission(request.payload));
    case "session.readInput": return unwrap(await sessions!.readInput(request.payload));
    case "session.listInputs": return unwrap(await sessions!.listInputs(request.payload));
    case "session.cancelInput": return unwrap(await sessions!.cancelInput(request.payload.inputId, request));
    case "workspace.read": return unwrap(await workspace!.read());
    case "workspace.restore": return unwrap(await workspace!.restore());
    case 'workspace.update': return unwrap(await workspace!.update(request.payload.change, request.payload.expectedRevision));
    case 'import.preview':
      if (request.operationRef !== request.payload.operationRef) throw new Error('invalid_argument');
      return unwrap(await imports.preview(request.payload));
    case 'import.commit':
      if (request.operationRef !== request.payload.operationRef) throw new Error('invalid_argument');
      return unwrap(await imports.commit(request.payload));
    case 'import.read': case 'evidence.readOperation': return unwrap(await imports.read(request.payload.operationRef));
    case 'import.cancel': return unwrap(await imports.cancel(request.payload.operationRef));
    case 'import.recover': return unwrap(await imports.recover(request.payload.operationRef));
    case 'evidence.readArtifact': return unwrap(await artifacts.read(request.payload.artifactId));
    case 'data.read': {
      const { page, pageSize } = createPublicMethodSchemas()['data.read'].input.parse(request.payload);
      return dataCatalog(page, pageSize);
    }
    case 'data.rows': {
      const { batchId, kind, page, pageSize } = createPublicMethodSchemas()['data.rows'].input.parse(request.payload);
      if (catalog.readBatches([batchId]).length !== 1) throw new Error('access_denied');
      const table = kind === 'devices' ? 'snapshots' : 'change_events', column = kind === 'devices' ? 'batch_id' : 'new_batch_id';
      const totalRows = database!.query<{ count: number }, [number]>(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`).get(batchId)!.count;
      const ids = database!.query<{ id: number }, [number, number, number]>(`SELECT id FROM ${table} WHERE ${column}=? ORDER BY id LIMIT ? OFFSET ?`).all(batchId, pageSize, (page - 1) * pageSize).map(row => row.id);
      return { kind, items: kind === 'devices' ? catalog.readSnapshotsById(ids) : catalog.readChanges([batchId], catalog.readBatches([batchId]).flatMap(batch => batch.previousBatchId === null ? [] : [batch.previousBatchId]), null).slice((page - 1) * pageSize, page * pageSize), totalRows, page, pageSize };
    }
    case 'query.execute': {
      const previous = database!.query<{ id: number }, [string]>("SELECT id FROM queries WHERE source='user_form' AND call_ref=CAST(run_id AS TEXT)||':'||?").get(request.operationRef);
      if (previous) {
        const saved = toolStore.readQuery(previous.id)!;
        const configuration = frozenConfiguration(saved.runId);
        const params = createStoredQuerySchemas(configuration).QueryParamsSchema.parse(request.payload.params);
        if (canonicalRequest(saved.params) !== canonicalRequest(params)) throw new Error('state_conflict');
        const activity = database!.query<{ details_json: string }, [number]>("SELECT details_json FROM business_events WHERE query_id=? AND type='query_committed'").get(saved.id);
        if (!activity || JSON.parse(activity.details_json).workspaceRevision !== request.payload.expectedRevision) throw new Error('state_conflict');
        return queryView(saved.id, params.page, params.pageSize);
      }
      const context = app.runs.bindQueryContext(request.operationRef, request.payload.expectedRevision);
      const saved = unwrap(await queries.execute(request.payload.params, context));
      return queryView(saved.id, saved.params.page, saved.params.pageSize);
    }
    case 'query.read': {
      const { queryId, page, pageSize } = createPublicMethodSchemas()['query.read'].input.parse(request.payload);
      return queryView(queryId, page, pageSize);
    }
    case 'query.list': {
      const { sessionId, beforeQueryId, limit } = createPublicMethodSchemas()['query.list'].input.parse(request.payload);
      if (repositories.readWorkspace().sessionId !== sessionId) throw new Error('access_denied');
      const rows = database!.query<{ id: number }, [number, number, number]>('SELECT id FROM queries WHERE session_id=? AND id<? ORDER BY id DESC LIMIT ?').all(sessionId, beforeQueryId ?? Number.MAX_SAFE_INTEGER, limit + 1);
      return { items: rows.slice(0, limit).map(row => { const saved = toolStore.readQuery(row.id)!; return summary(queries.read(row.id, readContext(saved.runId))); }), nextBeforeQueryId: rows.length > limit ? rows[limit - 1]!.id : null };
    }
    case 'evidence.read': {
      const payload = createPublicMethodSchemas()['evidence.read'].input.parse(request.payload);
      const saved = toolStore.readQuery(payload.queryId); if (!saved) throw new Error('operation_not_found');
      const context = readContext(saved.runId), record = evidence.read(payload.evidenceId, context);
      if (record.queryId !== payload.queryId) throw new Error('access_denied');
      return { ...evidence.rows(payload, context), evidence: evidenceSummary(record) };
    }
    case 'tool.read': {
      const { runId, page, pageSize } = createPublicMethodSchemas()['tool.read'].input.parse(request.payload), context = readContext(runId, false);
      const totalRows = database!.query<{ count: number }, [number]>('SELECT COUNT(*) AS count FROM tool_calls WHERE run_id=?').get(runId)!.count;
      const rows = database!.query<{ native_tool_call_id: string }, [number, number, number]>('SELECT native_tool_call_id FROM tool_calls WHERE run_id=? ORDER BY id LIMIT ? OFFSET ?').all(runId, pageSize, (page - 1) * pageSize);
      const items = rows.map(row => {
        const record = toolStore.readCall({ ...context, nativeToolCallId: row.native_tool_call_id })!;
        return projectToolCall(record);
      });
      return { runId, scope: context.scope, items, totalRows, page, pageSize };
    }
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
    : safeError(error instanceof Error && error.name === 'ZodError' ? 'invalid_argument' : error instanceof Error ? error.message : "internal_error", error, { operationRef: frame.operationRef }); errorLog.add(safe); result = { ok: false, error: safe }; }
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
