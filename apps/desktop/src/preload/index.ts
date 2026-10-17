import { contextBridge, ipcRenderer } from "electron";
import { DesktopNoticeSchema, desktopMethodSchemas, DesktopMethodSchema, DesktopSecretInputSchema, DesktopSecretInputResultSchema, DesktopImportDirectorySchema, DesktopImportDirectoryResultSchema, isDesktopReadOnlyMethod, type DesktopMethod, type DesktopPayload, type DesktopReturn, type DesktopNotice, type DesktopSecretInput } from "../../../../packages/contracts/src/protocol.ts";
import { EvaluationOperationRefSchema } from '../../../../packages/contracts/src/evaluation';
import { resultSchema, OpaqueIdSchema, safeError, type Result } from "../../../../packages/contracts/src/error.ts";
import { AuthLinkUrlSchema } from "../../../../packages/contracts/src/model.ts";
import { DesktopExportDestinationSchema, DesktopExportDestinationResultSchema } from '../../../../packages/contracts/src/export';

const listeners = new Set<(notice: DesktopNotice & { instanceId: string | null }) => void>();
ipcRenderer.on("medclaw:notice", (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const { instanceId, ...notice } = raw as Record<string, unknown>;
  const parsed = DesktopNoticeSchema.safeParse(notice);
  if (!parsed.success || (instanceId !== null && !OpaqueIdSchema.safeParse(instanceId).success)) return;
  if (parsed.data.type.startsWith('eval.') && instanceId !== null) return;
  listeners.forEach(listener => { try { listener(structuredClone({ ...parsed.data, instanceId: instanceId as string | null })); } catch {
    // Send only a fixed signal. User content, stack traces and provider errors
    // never enter this diagnostic channel.
    try { ipcRenderer.send('medclaw:observer-error'); } catch {}
  } });
});
const bridge = {
  async request<M extends DesktopMethod>(method: M, payload: DesktopPayload<M>, operationRef?: string): Promise<Result<DesktopReturn<M>>> {
    let name: DesktopMethod, body: unknown, identity: string, parsingPayload = false;
    try {
      name = DesktopMethodSchema.parse(method);
      identity = (name.startsWith('eval.') ? EvaluationOperationRefSchema : OpaqueIdSchema).parse(operationRef ?? crypto.randomUUID());
      parsingPayload = true;
      body = desktopMethodSchemas[name].input.parse(payload);
      parsingPayload = false;
    } catch { return { ok: false, error: safeError(parsingPayload && method === "session.messages.read" ? "input_invalid" : "invalid_argument") }; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const call = ipcRenderer.invoke("medclaw:request", { method: name, payload: body, operationRef: identity });
      const result: unknown = name === 'backup.create' || name === 'backup.restore' || name === 'diagnostics.export'
        ? await Promise.race([call, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation_result_unknown')), 600000); })]) : await call;
      const parsed = resultSchema(desktopMethodSchemas[name].output).parse(result);
      if (name === 'backup.read' && parsed.ok && parsed.data !== null && typeof parsed.data === 'object' && 'kind' in parsed.data
        && parsed.data.kind !== (body as { kind: string }).kind) throw new Error('host_protocol_mismatch');
      return parsed as Result<DesktopReturn<M>>;
    } catch { return { ok: false, error: safeError(isDesktopReadOnlyMethod(name) ? "host_protocol_mismatch" : "operation_result_unknown", undefined, { operationRef: identity }) }; }
    finally { clearTimeout(timer); }
  },
  subscribe(listener: (notice: DesktopNotice & { instanceId: string | null }) => void) { listeners.add(listener); ipcRenderer.send("medclaw:subscribe"); return () => listeners.delete(listener); },
  async secretInput(input: DesktopSecretInput) { return resultSchema(DesktopSecretInputResultSchema).parse(await ipcRenderer.invoke("medclaw:secret-input", DesktopSecretInputSchema.parse(input))); },
  async discardSecret(token: string) { await ipcRenderer.invoke("medclaw:secret-discard", { token: OpaqueIdSchema.parse(token) }); },
  async openAuthLink(url: string): Promise<Result<null>> { return await ipcRenderer.invoke("medclaw:open-auth-link", AuthLinkUrlSchema.parse(url)) as Result<null>; },
  async pickImportDirectory(operationRef: string) {
    return resultSchema(DesktopImportDirectoryResultSchema).parse(await ipcRenderer.invoke("medclaw:import-directory", DesktopImportDirectorySchema.parse({ operationRef })));
  },
  async chooseExportDestination(input: import('zod').z.infer<typeof DesktopExportDestinationSchema>) {
    try { return resultSchema(DesktopExportDestinationResultSchema).parse(await ipcRenderer.invoke('medclaw:export-destination', DesktopExportDestinationSchema.parse(input))); }
    catch { return { ok: false as const, error: safeError('export_destination_invalid') }; }
  },
};
contextBridge.exposeInMainWorld("medclaw", bridge);
