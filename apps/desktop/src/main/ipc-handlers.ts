import { ipcMain, shell, dialog, type BrowserWindow } from "electron";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { createPublicMethodSchemas, publicMethodSchemas, PublicMethodSchema, DesktopSecretInputSchema, DesktopSecretDiscardSchema, DesktopImportDirectorySchema, isReadOnlyMethod, type PublicMethod, type PublicPayload, type PrivateCredentialFrame, type DiagnosticsView, type RuntimeNotice } from "../../../../packages/contracts/src/protocol.ts";
import { AppErrorSchema, OpaqueIdSchema, safeError, type Result } from "../../../../packages/contracts/src/error.ts";
import { AuthLinkUrlSchema, type PublishedSettings } from "../../../../packages/contracts/src/model.ts";
import { HostController } from "./host-controller.ts";
import { MainSettings, type PublishOptions } from "./settings.ts";
import { MainCredentials, SecretInputs } from "./credentials.ts";
import { FileTokens } from "./file-tokens.ts";

export async function privateCredentialRequest(credentials: MainCredentials, frame: PrivateCredentialFrame, fileTokens?: FileTokens, windowId?: number): Promise<Result<unknown>> {
  try {
    let data: unknown;
    switch (frame.method) {
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
export function registerIpc(options: { window: BrowserWindow; host: HostController; settings: MainSettings; credentials: MainCredentials; inputs: SecretInputs; fileTokens?: FileTokens; diagnostics(categories: string[]): Promise<DiagnosticsView>; report(error: ReturnType<typeof safeError>): void; notify(notice: RuntimeNotice): void }) {
  const { window, host, settings, credentials, inputs } = options;
  const operations = new Map<string, { method: PublicMethod; payload: unknown }>();
  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender.id !== window.webContents.id || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith("file:")) throw new Error("access_denied");
  };
  const requireHost = () => { if (host.read().state !== "ready") throw new Error("host_not_ready"); };
  const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw result.error; return result.data; };
  const request = async (method: PublicMethod | "settings.prepare" | "settings.commit" | "settings.abort", payload: unknown, operationRef?: string) => unwrap(await host.request(method, payload, operationRef));
  const synchronize = async () => {
    requireHost();
    return settings.synchronize();
  };
  const publish = async (expected: string, patch: Parameters<MainSettings["publish"]>[1], kind: "model" | "custom" | "policy" | "ui" | "rollback", targetConfigVersion?: string, coordination: Pick<PublishOptions, "beforeWrite" | "onUnpublished"> = {}) => {
    const result = await settings.publish(expected, patch, { kind, ...(targetConfigVersion ? { targetConfigVersion } : {}), ...coordination,
      beforeWrite: async candidate => { await coordination.beforeWrite?.(candidate); if (kind !== "ui") await checkSelectionAuth(candidate.model); },
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
      case "settings.ui.read": { const s = settings.read(); return { configVersion: s.configVersion, ui: s.ui }; }
      case "settings.ui.update": { const p = raw as { expectedConfigVersion: string; patch: PublishedSettings["ui"] }; const s = await publish(p.expectedConfigVersion, { ui: p.patch }, "ui"); if (host.read().state === "ready") await synchronize(); options.notify({ type: "config.changed", configVersion: s.configVersion }); return { configVersion: s.configVersion, ui: s.ui }; }
      case "model.config.read": { const s = settings.read(); return { configVersion: s.configVersion, previousConfigVersion: s.previous?.configVersion ?? null, rollbackFromVersion: s.rollbackFromVersion, policy: s.requestPolicy, agentPolicy: s.agentPolicy, runtimeConfiguration: s.runtimeConfiguration, toolConfiguration: s.toolConfiguration }; }
      case "diagnostics.read": return options.diagnostics((raw as { categories: string[] }).categories);
      case "model.configure": {
        await synchronize(); const p = raw as { provider: string; modelId: string; expectedConfigVersion: string };
        const s = await publish(p.expectedConfigVersion, { model: { provider: p.provider, modelId: p.modelId }, credentialRefs: credentials.captureRefs() }, "model");
        const dir = await request("model.read", {}) as { selection: unknown }; return { configVersion: s.configVersion, selection: dir.selection };
      }
      case "model.policy.update": { await synchronize(); const p = raw as PublicPayload<'model.policy.update'>; const s = await publish(p.expectedConfigVersion, { ...(p.policy ? { requestPolicy: p.policy } : {}), ...(p.agentPolicy ? { agentPolicy: p.agentPolicy } : {}), ...(p.runtimeConfiguration ? { runtimeConfiguration: p.runtimeConfiguration } : {}), ...(p.toolConfiguration ? { toolConfiguration: p.toolConfiguration } : {}) }, "policy"); return { configVersion: s.configVersion, policy: s.requestPolicy, agentPolicy: s.agentPolicy, runtimeConfiguration: s.runtimeConfiguration, toolConfiguration: s.toolConfiguration }; }
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
    let method: PublicMethod | undefined, operationRef: string | undefined, replyReceived = false;
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
      const schema = ['data.read', 'data.rows', 'query.read', 'query.list', 'evidence.read', 'tool.read'].includes(method)
        ? createPublicMethodSchemas()[method].input : publicMethodSchemas[method].input;
      const parsed = JSON.parse(JSON.stringify(schema.parse(payload))) as unknown;
      if ((method === "import.preview" || method === "import.commit") && (parsed as { operationRef: string }).operationRef !== operationRef) throw new Error("state_conflict");
      if (method === "model.request" || method === "model.diagnose" || method === "session.submit" || method === "session.create") {
        const old = operations.get(operationRef);
        if (old && (old.method !== method || !isDeepStrictEqual(old.payload, parsed))) throw new Error("state_conflict");
        operations.set(operationRef, { method, payload: parsed });
        if (operations.size > 100) operations.delete(operations.keys().next().value!);
      }
      const reply = await dispatch(method, parsed, operationRef); replyReceived = true;
      const data = publicMethodSchemas[method].output.parse(reply);
      return { ok: true, data };
    } catch (error) { const known = AppErrorSchema.safeParse(error); const safe = known.success ? known.data : safeError(error instanceof z.ZodError
      ? replyReceived && method && !isReadOnlyMethod(method) ? "operation_result_unknown" : "invalid_argument"
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
  window.on("closed", () => { inputs.closeWindow(window.id); options.fileTokens?.closeWindow(window.id); ["medclaw:request", "medclaw:secret-input", "medclaw:secret-discard", "medclaw:open-auth-link", "medclaw:import-directory"].forEach(channel => ipcMain.removeHandler(channel)); });
  return { synchronize, publishCredentials: async () => {
    const current = settings.read(), refs = credentials.captureRefs();
    if (isDeepStrictEqual(current.credentialRefs, refs)) return;
    await publish(current.configVersion, { credentialRefs: refs, customProviders: current.customProviders.map(p => ({ ...p, credentialRef: refs[p.definition.providerId] ?? null })) }, "model");
  } };
}
