import { contextBridge, ipcRenderer } from "electron";
import { DesktopNoticeSchema, publicMethodSchemas, PublicMethodSchema, DesktopSecretInputSchema, DesktopSecretInputResultSchema, DesktopImportDirectorySchema, DesktopImportDirectoryResultSchema, isReadOnlyMethod, type PublicMethod, type PublicPayload, type PublicReturn, type DesktopNotice, type DesktopSecretInput } from "../../../../packages/contracts/src/protocol.ts";
import { resultSchema, OpaqueIdSchema, safeError, type Result } from "../../../../packages/contracts/src/error.ts";
import { AuthLinkUrlSchema } from "../../../../packages/contracts/src/model.ts";
import { DesktopExportDestinationSchema, DesktopExportDestinationResultSchema } from '../../../../packages/contracts/src/export';

const listeners = new Set<(notice: DesktopNotice & { instanceId: string | null }) => void>();
ipcRenderer.on("medclaw:notice", (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const { instanceId, ...notice } = raw as Record<string, unknown>;
  const parsed = DesktopNoticeSchema.safeParse(notice);
  if (!parsed.success || (instanceId !== null && !OpaqueIdSchema.safeParse(instanceId).success)) return;
  listeners.forEach(listener => { try { listener(structuredClone({ ...parsed.data, instanceId: instanceId as string | null })); } catch {
    // Send only a fixed signal. User content, stack traces and provider errors
    // never enter this diagnostic channel.
    try { ipcRenderer.send('medclaw:observer-error'); } catch {}
  } });
});
const bridge = {
  async request<M extends PublicMethod>(method: M, payload: PublicPayload<M>, operationRef?: string): Promise<Result<PublicReturn<M>>> {
    let name: PublicMethod, body: unknown, identity: string, parsingPayload = false;
    try {
      name = PublicMethodSchema.parse(method);
      identity = OpaqueIdSchema.parse(operationRef ?? crypto.randomUUID());
      parsingPayload = true;
      body = publicMethodSchemas[name].input.parse(payload);
      parsingPayload = false;
    } catch { return { ok: false, error: safeError(parsingPayload && method === "session.messages.read" ? "input_invalid" : "invalid_argument") }; }
    try {
      const result: unknown = await ipcRenderer.invoke("medclaw:request", { method: name, payload: body, operationRef: identity });
      return resultSchema(publicMethodSchemas[name].output).parse(result) as Result<PublicReturn<M>>;
    } catch { return { ok: false, error: safeError(isReadOnlyMethod(name) ? "host_protocol_mismatch" : "operation_result_unknown", undefined, { operationRef: identity }) }; }
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
