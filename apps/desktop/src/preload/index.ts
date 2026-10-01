import { contextBridge, ipcRenderer } from "electron";
import { DesktopNoticeSchema, publicMethodSchemas, PublicMethodSchema, DesktopSecretInputSchema, DesktopSecretInputResultSchema, isReadOnlyMethod, type PublicMethod, type PublicPayload, type PublicReturn, type DesktopNotice, type DesktopSecretInput } from "../../../../packages/contracts/src/protocol.ts";
import { resultSchema, OpaqueIdSchema, safeError, type Result } from "../../../../packages/contracts/src/error.ts";
import { AuthLinkUrlSchema } from "../../../../packages/contracts/src/model.ts";

const listeners = new Set<(notice: DesktopNotice & { instanceId: string | null }) => void>();
ipcRenderer.on("medclaw:notice", (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const { instanceId, ...notice } = raw as Record<string, unknown>;
  const parsed = DesktopNoticeSchema.safeParse(notice);
  if (!parsed.success || (instanceId !== null && !OpaqueIdSchema.safeParse(instanceId).success)) return;
  listeners.forEach(listener => listener({ ...parsed.data, instanceId: instanceId as string | null }));
});
const bridge = {
  async request<M extends PublicMethod>(method: M, payload: PublicPayload<M>, operationRef?: string): Promise<Result<PublicReturn<M>>> {
    let name: PublicMethod, body: unknown, identity: string;
    try {
      name = PublicMethodSchema.parse(method);
      body = publicMethodSchemas[name].input.parse(payload);
      identity = OpaqueIdSchema.parse(operationRef ?? crypto.randomUUID());
    } catch { return { ok: false, error: safeError("invalid_argument") }; }
    try {
      const result: unknown = await ipcRenderer.invoke("medclaw:request", { method: name, payload: body, operationRef: identity });
      return resultSchema(publicMethodSchemas[name].output).parse(result) as Result<PublicReturn<M>>;
    } catch { return { ok: false, error: safeError(isReadOnlyMethod(name) ? "host_protocol_mismatch" : "operation_result_unknown", undefined, { operationRef: identity }) }; }
  },
  subscribe(listener: (notice: DesktopNotice & { instanceId: string | null }) => void) { listeners.add(listener); ipcRenderer.send("medclaw:subscribe"); return () => listeners.delete(listener); },
  async secretInput(input: DesktopSecretInput) { return resultSchema(DesktopSecretInputResultSchema).parse(await ipcRenderer.invoke("medclaw:secret-input", DesktopSecretInputSchema.parse(input))); },
  async discardSecret(token: string) { await ipcRenderer.invoke("medclaw:secret-discard", { token: OpaqueIdSchema.parse(token) }); },
  async openAuthLink(url: string): Promise<Result<null>> { return await ipcRenderer.invoke("medclaw:open-auth-link", AuthLinkUrlSchema.parse(url)) as Result<null>; },
};
contextBridge.exposeInMainWorld("medclaw", bridge);
