import { ipcMain, shell, dialog, type BrowserWindow } from "electron";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { createPublicMethodSchemas, publicMethodSchemas, publicOutputSchema, PublicMethodSchema, DesktopSecretInputSchema, DesktopSecretDiscardSchema, DesktopImportDirectorySchema, isReadOnlyMethod, type PublicMethod, type PublicPayload, type PrivateCredentialFrame, type DiagnosticsView, type RuntimeNotice } from "../../../../packages/contracts/src/protocol.ts";
import { AppErrorSchema, OpaqueIdSchema, safeError, type Result } from "../../../../packages/contracts/src/error.ts";
import { AuthLinkUrlSchema, type PublishedSettings } from "../../../../packages/contracts/src/model.ts";
import { HostController } from "./host-controller.ts";
import { MainSettings, type PublishOptions } from "./settings.ts";
import { MainCredentials, SecretInputs } from "./credentials.ts";
import { FileTokens } from "./file-tokens.ts";
import { DestinationTokens } from './destination-tokens';
import { DesktopExportDestinationSchema } from '../../../../packages/contracts/src/export';
import { EventSubscribeInputSchema, EventSubscribeResultSchema, type OpenEventSubscriptionInput } from '../../../../packages/contracts/src/event.ts';
import { canonicalRequest } from '../../../../packages/contracts/src/run';
import { SubmitInputSchema } from '../../../../packages/contracts/src/session';

export async function privateCredentialRequest(credentials: MainCredentials, frame: PrivateCredentialFrame, fileTokens?: FileTokens, windowId?: number, destinations?: DestinationTokens): Promise<Result<unknown>> {
  try {
    let data: unknown;
    switch (frame.method) {
      case 'export.destination.describe': case 'export.destination.copy': {
        if (!destinations || windowId === undefined) throw new Error('export_destination_invalid');
        data = frame.method === 'export.destination.describe' ? await destinations.describe(windowId, frame.instanceId, frame.payload)
          : await destinations.copy(windowId, frame.instanceId, frame.payload); break;
      }
      case 'export.destination.cancel': {
        if (!destinations) throw new Error('export_copy_failed'); data = await destinations.cancel(frame.payload.operationRef); break;
      }
      case 'export.destination.settlePrevious': {
        if (!destinations) throw new Error('export_copy_failed'); data = await destinations.settlePrevious(); break;
      }
      case "file.resolve": {
        if (!fileTokens || windowId === undefined) throw new Error("file_token_invalid");
        data = fileTokens.resolve(frame.payload.fileToken, windowId, frame.instanceId, frame.payload.operationRef); break;
      }
      case "credential.read": data = await credentials.read(frame.instanceId, frame.payload); break;
      case "credential.list": data = await credentials.list(frame.instanceId); break;
      case "credential.delete": data = await credentials.delete(frame.instanceId, frame.payload); break;
      case "credential.modify.begin": data = await credentials.begin(frame.instanceId, frame.payload); break;
      case "credential.modify.commit": data = await credentials.commit(frame.instanceId, frame.payload); break;
      case "credential.modify.abort": data = await credentials.abort(frame.instanceId, frame.payload); break;
    }
    return { ok: true, data };
  } catch (error) { return { ok: false, error: safeError(error instanceof Error ? error.message : "credential_read_failed", error) }; }
}
export function registerIpc(options: { window: BrowserWindow; host: HostController; settings: MainSettings; credentials: MainCredentials; inputs: SecretInputs; fileTokens?: FileTokens; destinations?: DestinationTokens; diagnostics(categories: string[]): Promise<DiagnosticsView>; report(error: ReturnType<typeof safeError>): void; notify(notice: RuntimeNotice): void }) {
  const { window, host, settings, credentials, inputs } = options;
  const operations = new Map<string, { method: PublicMethod; payload: unknown }>();
  // Only display subscriptions are owned by a renderer. Pi/Recorder listeners
  // belong to the Run and continue independently when this map is cleared.
  type Owner = { instanceId: string; input: OpenEventSubscriptionInput; sessionId: number | null; ready: boolean };
  const eventOwners = new Map<string, Owner>();
  const closeCaptured = (owner: Owner) => {
    void host.request('event.subscribe', { action: 'close', subscriptionId: owner.input.subscriptionId }, undefined, undefined, owner.instanceId).catch(() => {});
  };
  const clearEventOwners = (instanceId?: string, sendClose = true) => {
    for (const [sid, owner] of eventOwners) {
      if (instanceId && owner.instanceId !== instanceId) continue;
      eventOwners.delete(sid);
      if (sendClose) closeCaptured(owner);
    }
  };
  const trusted = (event: Pick<Electron.IpcMainInvokeEvent, 'sender' | 'senderFrame'>) => {
    if (event.sender.id !== window.webContents.id || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith("file:")) throw new Error("access_denied");
  };
  const requireHost = () => { if (host.read().state !== "ready") throw new Error("host_not_ready"); };
  const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw result.error; return result.data; };
  const request = async (method: PublicMethod | "settings.prepare" | "settings.commit" | "settings.abort", payload: unknown, operationRef?: string) => unwrap(await host.request(method, payload, operationRef));
  const synchronize = async () => {
    requireHost();
    return settings.synchronize();
  };
  const publish = async (expected: string, patch: Parameters<MainSettings["publish"]>[1], kind: "model" | "custom" | "policy" | "ui" | "rollback" | 'resources' | 'extensions' | 'intent', targetConfigVersion?: string, coordination: Pick<PublishOptions, "beforeWrite" | "onUnpublished"> = {}) => {
    const result = await settings.publish(expected, patch, { kind, ...(targetConfigVersion ? { targetConfigVersion } : {}), ...coordination,
      beforeWrite: async candidate => { await coordination.beforeWrite?.(candidate); if (kind !== "ui" && kind !== 'resources' && kind !== 'extensions' && kind !== 'intent') await checkSelectionAuth(candidate.model); },
    });
    if (kind !== "ui") options.notify({ type: "config.changed", configVersion: result.configVersion });
    return result;
  };
  const checkSelectionAuth = async (model: PublishedSettings["model"]) => {
    if (model && (await request("model.auth.status", { providerId: model.provider }) as { auth: { state: string } }).auth.state !== "available") throw new Error("model_auth_missing");
  };
  const dispatch = async (method: PublicMethod, raw: unknown, operationRef: string): Promise<unknown> => {
    switch (method) {
      case "host.read": return host.read();
      case "host.start": return host.start();
      case "host.stop": return host.stop((raw as { expectedInstanceId: string }).expectedInstanceId);
      case "host.restart": return host.restart((raw as { expectedInstanceId: string }).expectedInstanceId);
      case 'event.subscribe': {
        const input = EventSubscribeInputSchema.parse(raw);
        if (input.action === 'close') {
          const owner = eventOwners.get(input.subscriptionId);
          if (!owner) return { action: 'close', subscriptionId: input.subscriptionId, closed: true };
          eventOwners.delete(input.subscriptionId);
          return unwrap(await host.request(method, input, operationRef, undefined, owner.instanceId));
        }
        requireHost();
        const instanceId = host.read().instanceId!;
        const previous = eventOwners.get(input.subscriptionId);
        if (previous && (previous.instanceId !== instanceId || !isDeepStrictEqual(previous.input, input))) throw new Error('state_conflict');
        const owner = previous ?? { instanceId, input: structuredClone(input), sessionId: null, ready: false };
        // Reserve before forwarding: notices can precede the open reply.
        if (!previous) eventOwners.set(input.subscriptionId, owner);
        try {
          const result = EventSubscribeResultSchema.parse(unwrap(await host.request(method, input, operationRef, undefined, instanceId)));
          if (result.action !== 'open' || result.subscriptionId !== input.subscriptionId || result.runId !== input.runId) throw new Error('host_protocol_mismatch');
          if (eventOwners.get(input.subscriptionId) !== owner || host.read().instanceId !== instanceId) {
            closeCaptured(owner); throw new Error('event_subscription_invalid');
          }
          owner.sessionId = result.sessionId; owner.ready = true;
          return result;
        } catch (error) {
          // A failed refresh must retain a previously proven owner. A failed
          // provisional open may have reached Host despite a lost reply.
          if (!previous && !owner.ready && eventOwners.get(input.subscriptionId) === owner) { eventOwners.delete(input.subscriptionId); closeCaptured(owner); }
          throw error;
        }
      }
      case "settings.ui.read": { const s = settings.read(); return { configVersion: s.configVersion, ui: s.ui }; }
      case "settings.ui.update": { const p = raw as { expectedConfigVersion: string; patch: PublishedSettings["ui"] }; const s = await publish(p.expectedConfigVersion, { ui: p.patch }, "ui"); if (host.read().state === "ready") await synchronize(); options.notify({ type: "config.changed", configVersion: s.configVersion }); return { configVersion: s.configVersion, ui: s.ui }; }
      case "model.config.read": { const s = settings.read(); return { configVersion: s.configVersion, intentModel:s.intentModel??null, previousConfigVersion: s.previous?.configVersion ?? null, rollbackFromVersion: s.rollbackFromVersion, policy: s.requestPolicy, agentPolicy: s.agentPolicy, runtimeConfiguration: s.runtimeConfiguration, toolConfiguration: s.toolConfiguration }; }
      case 'model.intent.configure': {
        await synchronize();const p=raw as PublicPayload<'model.intent.configure'>;
        const s=await publish(p.expectedConfigVersion,{intentModel:p.intentModel},'intent');return {configVersion:s.configVersion,intentModel:s.intentModel??null};
      }
      case "diagnostics.read": return options.diagnostics((raw as { categories: string[] }).categories);
      case "model.configure": {
        await synchronize(); const p = raw as { provider: string; modelId: string; expectedConfigVersion: string };
        const s = await publish(p.expectedConfigVersion, { model: { provider: p.provider, modelId: p.modelId }, credentialRefs: credentials.captureRefs() }, "model");
        const dir = await request("model.read", {}) as { selection: unknown }; return { configVersion: s.configVersion, selection: dir.selection };
      }
      case "model.policy.update": { await synchronize(); const p = raw as PublicPayload<'model.policy.update'>; const s = await publish(p.expectedConfigVersion, { ...(p.policy ? { requestPolicy: p.policy } : {}), ...(p.agentPolicy ? { agentPolicy: p.agentPolicy } : {}), ...(p.runtimeConfiguration ? { runtimeConfiguration: p.runtimeConfiguration } : {}), ...(p.toolConfiguration ? { toolConfiguration: p.toolConfiguration } : {}) }, "policy"); return { configVersion: s.configVersion, policy: s.requestPolicy, agentPolicy: s.agentPolicy, runtimeConfiguration: s.runtimeConfiguration, toolConfiguration: s.toolConfiguration }; }
      case 'resources.list': case 'resources.read': case 'extensions.read': {
        const p = raw as PublicPayload<'resources.list' | 'resources.read' | 'extensions.read'>;
        if (p.source === 'selection') await synchronize(); else requireHost();
        return request(method, raw, operationRef);
      }
      case 'resources.select': {
        const current = await synchronize(), p = raw as PublicPayload<'resources.select'>;
        const resources = { bySession: { ...current.resources?.bySession, [String(p.sessionId)]: p.selection } };
        const published = await publish(p.expectedConfigVersion, { resources }, 'resources');
        return { sessionId: p.sessionId, configVersion: published.configVersion, selection: published.resources!.bySession[String(p.sessionId)]! };
      }
      case 'extensions.select': {
        const current=await synchronize(),p=raw as PublicPayload<'extensions.select'>;
        const extensions={bySession:{...current.extensions?.bySession,[String(p.sessionId)]:p.selection}};
        const published=await publish(p.expectedConfigVersion,{extensions},'extensions');
        return {sessionId:p.sessionId,configVersion:published.configVersion,selection:published.extensions!.bySession[String(p.sessionId)]!,effective:'next_assembly' as const};
      }
      case "model.config.rollback": {
        await synchronize(); const p = raw as { expectedConfigVersion: string; targetConfigVersion: string };
        if (!(await request("run.control.read", {}) as { acceptingNewRuns: boolean }).acceptingNewRuns) throw new Error("runtime_busy");
        const old = settings.read().previous;
        if (!old || old.configVersion !== p.targetConfigVersion) throw new Error("config_conflict");
        credentials.validateRefs(old.credentialRefs);
        for (const entry of old.customProviders) if (entry.credentialRef) credentials.validateRefs({ [entry.definition.providerId]: entry.credentialRef });
        // Ambient authentication has no restorable secret. Verify it before publishing rollback.
        if (old.model && !old.credentialRefs[old.model.provider]) {
          const check = await request("model.auth.status", { providerId: old.model.provider }) as { auth: { state: string } };
          if (check.auth.state !== "available") throw new Error("model_auth_missing");
        }
        const bindings = credentials.captureRefs();
        const s = await publish(p.expectedConfigVersion, {}, "rollback", p.targetConfigVersion, {
          beforeWrite: () => credentials.bindRefs(old.credentialRefs),
          onUnpublished: () => credentials.bindRefs(bindings),
        });
        const dir = await request("model.read", {}) as { selection: unknown };
        return { configVersion: s.configVersion, rollbackFromVersion: s.rollbackFromVersion, selection: dir.selection };
      }
      case "model.custom.save": {
        await synchronize();
        const p = raw as { definition: PublishedSettings["customProviders"][number]["definition"]; expectedConfigVersion: string; credentialInput?: string };
        const before = settings.read();
        if (p.expectedConfigVersion !== before.configVersion) throw new Error("config_conflict");
        const directory = await request("model.read", {}) as { providers: { id: string; source: string }[]; customApis: string[] };
        if (directory.providers.some(provider => provider.id === p.definition.providerId && provider.source === "pi_builtin")) throw new Error("provider_id_reserved");
        if (!directory.customApis.includes(p.definition.api)) throw new Error("custom_api_unsupported");
        if (!(await request("run.control.read", {}) as { acceptingNewRuns: boolean }).acceptingNewRuns) throw new Error("runtime_busy");
        const bindings = credentials.captureRefs();
        const credentialRef = p.credentialInput ? crypto.randomUUID() : credentials.activeRef(p.definition.providerId);
        const refs = { ...bindings, ...(credentialRef ? { [p.definition.providerId]: credentialRef } : {}) };
        const customProviders = before.customProviders.filter(present => present.definition.providerId !== p.definition.providerId).concat({ definition: p.definition, credentialRef });
        const s = await publish(p.expectedConfigVersion, { customProviders, credentialRefs: refs }, "custom", undefined, {
          beforeWrite: async () => {
            if (p.credentialInput) {
              const value = inputs.consume(p.credentialInput, { windowId: window.id, providerId: p.definition.providerId, purpose: "custom_api_key" });
              const instanceId = host.read().instanceId!;
              const lease = await credentials.begin(instanceId, { providerId: p.definition.providerId, context: { purpose: "auth", operationRef, credentialRef: null }, expectedCredentialRef: null, operationId: operationRef });
              try { await credentials.commit(instanceId, { leaseId: lease.leaseId, expectedVersion: lease.version, changed: true, next: { type: "api_key", key: value } }, credentialRef!); }
              finally { await credentials.abort(instanceId, { leaseId: lease.leaseId }); }
            }
          },
          onUnpublished: () => credentials.bindRefs(bindings),
        });
        return { configVersion: s.configVersion, definition: p.definition, registered: true };
      }
      default:
        if (method === "model.request" || method === "model.diagnose" || method === "session.submit") {
          // Query a reused identity first; current config/auth must not invalidate the original request.
          requireHost();
          const prior = unwrap(await host.request("run.read", { operationRef })) as { kind: "one"; run: unknown };
          if (method === "session.submit") {
            const p = raw as { sessionId: number; clientSequence: number };
            const sequence = await request("session.readSubmission", { sessionId: p.sessionId, clientSequence: p.clientSequence });
            if (sequence || prior.run) return request(method, raw, operationRef);
          } else if (prior.run) return request(method, raw, operationRef);
          const s = await synchronize();
          const p = raw as { model: { provider: string } };
          if ((credentials.activeRef(p.model.provider) ?? null) !== (s.credentialRefs[p.model.provider] ?? null)) throw new Error("model_auth_sync_failed");
        }
        requireHost(); return request(method, raw, operationRef);
    }
  };
  ipcMain.handle("medclaw:request", async (event, envelope: unknown): Promise<Result<unknown>> => {
    let method: PublicMethod | undefined, operationRef: string | undefined, replyReceived = false, parsingPayload = false;
    try {
      trusted(event);
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || Object.keys(envelope).some(k => !["method", "payload", "operationRef"].includes(k))) throw new Error("invalid_argument");
      const input = envelope as { method: PublicMethod; payload: unknown; operationRef?: string };
      method = PublicMethodSchema.parse(input.method);
      operationRef = OpaqueIdSchema.parse(input.operationRef ?? crypto.randomUUID());
      let payload = input.payload;
      if (method === "model.request" || method === "model.diagnose") {
        if (payload && typeof payload === "object" && !Array.isArray(payload)) payload = { referenceDate: new Date().toLocaleDateString("sv-SE"), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...payload };
      }
      parsingPayload = true;
      const schema = ['data.read', 'data.rows', 'query.read', 'query.list', 'evidence.read', 'tool.read'].includes(method)
        ? createPublicMethodSchemas()[method].input : publicMethodSchemas[method].input;
      const parsed = JSON.parse(JSON.stringify(schema.parse(payload))) as unknown;
      if(method==='session.submit'){
        const submission=SubmitInputSchema.parse(parsed);
        if(submission.mode==='send'&&submission.routing?.mode==='user_form'&&submission.text!=='Query form: '+canonicalRequest(submission.routing.params))throw new Error('invalid_argument');
      }
      parsingPayload = false;
      if ((method === "import.preview" || method === "import.commit") && (parsed as { operationRef: string }).operationRef !== operationRef) throw new Error("state_conflict");
      if (method === "model.request" || method === "model.diagnose" || method === "session.submit" || method === "session.create" || method === "session.rename" || method === "session.delete" || method==='session.restoreCheckpoint'||method==='session.restore') {
        const old = operations.get(operationRef);
        if (old && (old.method !== method || !isDeepStrictEqual(old.payload, parsed))) throw new Error("state_conflict");
        operations.set(operationRef, { method, payload: parsed });
        if (operations.size > 100) operations.delete(operations.keys().next().value!);
      }
      const reply = await dispatch(method, parsed, operationRef); replyReceived = true;
      const data = publicOutputSchema(method,parsed).parse(reply);
      return { ok: true, data };
    } catch (error) { const known = AppErrorSchema.safeParse(error); const safe = known.success ? known.data : safeError(error instanceof z.ZodError
      ? replyReceived && method ? isReadOnlyMethod(method) ? "host_protocol_mismatch" : "operation_result_unknown"
        : parsingPayload && method === "session.messages.read" ? "input_invalid" : "invalid_argument"
      : error instanceof Error ? error.message : "invalid_argument", error, { operationRef }); options.report(safe); return { ok: false, error: safe }; }
  });
  ipcMain.handle("medclaw:secret-input", (event, raw): Result<unknown> => { try { trusted(event); return { ok: true, data: inputs.issue(window.id, DesktopSecretInputSchema.parse(raw)) }; } catch (error) { return { ok: false, error: safeError(error instanceof Error ? error.message : "invalid_argument", error) }; } });
  ipcMain.handle("medclaw:secret-discard", (event, raw) => { trusted(event); inputs.discard(DesktopSecretDiscardSchema.parse(raw).token, window.id); });
  ipcMain.handle("medclaw:open-auth-link", async (event, raw): Promise<Result<null>> => { try { trusted(event); await shell.openExternal(AuthLinkUrlSchema.parse(raw)); return { ok: true, data: null }; } catch { return { ok: false, error: safeError("invalid_argument") }; } });
  ipcMain.handle("medclaw:import-directory", async (event, raw): Promise<Result<unknown>> => {
    try {
      trusted(event); requireHost();
      const request = DesktopImportDirectorySchema.parse(raw), instanceId = host.read().instanceId!;
      const selected = await dialog.showOpenDialog(window, { title: "Select a data package directory", properties: ["openDirectory"] });
      if (selected.canceled || selected.filePaths.length === 0) return { ok: true, data: null };
      if (host.read().instanceId !== instanceId || window.isDestroyed() || !options.fileTokens) throw new Error("file_token_invalid");
      return { ok: true, data: options.fileTokens.issue(window.id, instanceId, request.operationRef, selected.filePaths[0]!) };
    } catch (error) { return { ok: false, error: safeError(error instanceof Error ? error.message : "file_token_invalid") }; }
  });
  ipcMain.handle('medclaw:export-destination', async (event, raw): Promise<Result<unknown>> => {
    try {
      trusted(event); requireHost(); const input = DesktopExportDestinationSchema.parse(raw), instanceId = host.read().instanceId!;
      const selected = await dialog.showSaveDialog(window, { title: input.format === 'csv' ? 'Save CSV export bundle' : 'Save export',
        defaultPath: `query-${input.queryId}.${input.format === 'csv' ? 'csv-export' : input.format === 'json' ? 'json' : 'md'}`,
        buttonLabel: 'Choose destination', ...(input.format === 'csv' ? {} : { filters: [{ name: input.format === 'json' ? 'JSON' : 'Markdown', extensions: [input.format === 'json' ? 'json' : 'md'] }] }) });
      if (selected.canceled || !selected.filePath) return { ok: true, data: null };
      if (host.read().instanceId !== instanceId || host.read().state !== 'ready' || window.isDestroyed() || !options.destinations) throw new Error('export_destination_invalid');
      return { ok: true, data: options.destinations.issue(window.id, instanceId, input, selected.filePath) };
    } catch (error) { return { ok: false, error: safeError(error instanceof z.ZodError ? 'invalid_argument' : 'export_destination_invalid') }; }
  });
  const observerFailure = (event: Electron.IpcMainEvent) => { try { trusted(event); options.report(safeError('preview_delivery_failed')); } catch { /* Fixed diagnostics never cross into execution control. */ } };
  ipcMain.on?.('medclaw:observer-error', observerFailure);
  window.webContents.on?.('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) clearEventOwners(); });
  window.webContents.on?.('render-process-gone', () => clearEventOwners());
  window.webContents.on?.('destroyed', () => clearEventOwners());
  window.on("closed", () => { clearEventOwners(); ipcMain.removeListener?.('medclaw:observer-error', observerFailure); inputs.closeWindow(window.id); options.fileTokens?.closeWindow(window.id); options.destinations?.closeWindow(window.id); ["medclaw:request", "medclaw:secret-input", "medclaw:secret-discard", "medclaw:open-auth-link", "medclaw:import-directory", 'medclaw:export-destination'].forEach(channel => ipcMain.removeHandler(channel)); });
  return { synchronize,
    closeInstance: (instanceId: string) => clearEventOwners(instanceId, false),
    acceptEventNotice: (notice: RuntimeNotice, instanceId: string | null): boolean => {
      if (notice.type !== 'event.available' && notice.type !== 'event.stream') return true;
      const owner = eventOwners.get(notice.subscriptionId);
      if (!owner || owner.instanceId !== instanceId || host.read().instanceId !== instanceId) return false;
      const identity = notice.type === 'event.available' ? notice : notice.snapshot;
      return identity.runId === owner.input.runId && (owner.sessionId === null || identity.sessionId === owner.sessionId);
    },
    publishCredentials: async () => {
    const current = settings.read(), refs = credentials.captureRefs();
    if (isDeepStrictEqual(current.credentialRefs, refs)) return;
    await publish(current.configVersion, { credentialRefs: refs, customProviders: current.customProviders.map(p => ({ ...p, credentialRef: refs[p.definition.providerId] ?? null })) }, "model");
  } };
}
