import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { HostController } from "../../apps/desktop/src/main/host-controller";
import { MainSettings } from "../../apps/desktop/src/main/settings";
import { MainCredentials, SecretInputs } from "../../apps/desktop/src/main/credentials";
import { safeError, type Result } from "../../packages/contracts/src/error";
import type { PublicMethod, PublicPayload, PublicReturn } from "../../packages/contracts/src/protocol";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
let invoke: (channel: string, payload: unknown) => Promise<unknown> = async () => null;
let bridge: { request<M extends PublicMethod>(method: M, payload: PublicPayload<M>, op?: string): Promise<Result<PublicReturn<M>>> };
mock.module("electron", () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) }, shell: { openExternal: async () => {} }, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcRenderer: { on: () => {}, send: () => {}, invoke: (name: string, payload: unknown) => invoke(name, payload) }, contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } } }));
const roots: string[] = [];
afterEach(() => { handlers.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const submission = { sessionId: 1, clientSequence: 1, text: "original", mode: "send" as const, expectedRevision: 1, expectedBatchIds: [] as [], expectedQueryId: null,
  model: { provider: "fixture", modelId: "fixture", expectedConfigVersion: "1" }, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" };
const accepted = { sessionId: 1, clientSequence: 1, inputId: null, runId: 7 };
async function setup(prior: boolean, policyPublication = false) {
  const root = mkdtempSync(join(tmpdir(), "medclaw-p2-ipc-")); roots.push(root);
  const calls: { method: string; payload: unknown; op?: string }[] = []; let syncs = 0;
  const host = { read: () => ({ state: "ready", instanceId: "host-1" }), request: async (method: string, payload: unknown, op?: string) => {
    calls.push({ method, payload, op }); return { ok: true, data: method === "run.read" ? { kind: "one", run: null } : method === "session.readSubmission" ? prior ? accepted : null : accepted };
  } } as unknown as HostController;
  const settings = new MainSettings(join(root, "settings.json"), policyPublication ? { async prepare() {}, async commit() {}, async abort() {} } : undefined);
  settings.read(); settings.synchronize = async () => { syncs++; if (policyPublication) return settings.read(); throw new Error("config_write_failed"); };
  const credentials = new MainCredentials(join(root, "credentials.json"), { isEncryptionAvailable: () => false, encryptString: () => { throw new Error("unavailable"); }, decryptString: () => { throw new Error("unavailable"); } });
  const mainFrame = { url: "file:///desktop.html" }, window = { id: 1, webContents: { id: 10, mainFrame }, on: () => {} } as unknown as BrowserWindow;
  const { registerIpc } = await import("../../apps/desktop/src/main/ipc-handlers");
  registerIpc({ window, host, settings, credentials, inputs: new SecretInputs(), diagnostics: async () => { throw new Error("unused"); }, report: () => {}, notify: () => {} });
  const event = { sender: { id: 10, mainFrame }, senderFrame: mainFrame };
  async function request(method: string, payload: unknown, op = "original-operation", from = event) { return await handlers.get("medclaw:request")!(from, { method, payload, operationRef: op }) as Result<unknown>; }
  return { calls, request, syncs: () => syncs, host };
}
test("Main checks original Session identity before current configuration/auth synchronization", async () => {
  const c = await setup(true);
  expect(await c.request("session.submit", submission)).toEqual({ ok: true, data: accepted }); expect(c.syncs()).toBe(0);
  expect(c.calls.at(-1)).toEqual({ method: "session.submit", payload: submission, op: "original-operation" });
  expect(c.calls.some(c => c.method === "session.readSubmission")).toBe(true);
});

test("Main exposes and publishes Agent policy through the existing policy IPC without widening UI", async () => {
  const { DEFAULT_AGENT_POLICY } = await import("../../packages/contracts/src/model");
  const c = await setup(false, true);
  expect(await c.request("model.config.read", {})).toMatchObject({ ok: true, data: { agentPolicy: DEFAULT_AGENT_POLICY, configVersion: "1" } });
  const policy = { timeoutMs: 800000, maxRetries: 0, maxRetryDelayMs: 2000 };
  const agentPolicy = { ...DEFAULT_AGENT_POLICY, maxToolCalls: 99 };
  expect(await c.request("model.policy.update", { expectedConfigVersion: "1", policy, agentPolicy }, "policy-1")).toMatchObject({ ok: true, data: { policy, agentPolicy, configVersion: "2" } });
  expect(await c.request("model.policy.update", { expectedConfigVersion: "2", policy: { ...policy, timeoutMs: 900000 } }, "policy-2")).toMatchObject({ ok: true, data: { agentPolicy, configVersion: "3" } });
  expect(await c.request("model.policy.update", { expectedConfigVersion: "1", policy, agentPolicy }, "policy-conflict")).toMatchObject({ ok: false, error: { code: "config_conflict" } });
  expect(await c.request("settings.ui.update", { expectedConfigVersion: "3", patch: { agentPolicy } }, "policy-ui")).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
});
test("new Session Send synchronizes configuration after read-only identity probes", async () => {
  const c = await setup(false); expect(await c.request("session.submit", submission)).toMatchObject({ ok: false, error: { code: "config_write_failed" } });
  expect(c.syncs()).toBe(1); expect(c.calls.some(c => c.method === "session.submit")).toBe(false);
});
test("Main rejects injected native scope and untrusted frames before any Host request", async () => {
  const c = await setup(true);
  expect(await c.request("session.submit", { ...submission, scope: {} })).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
  expect(await c.request("session.submit", submission, "op", { sender: { id: 99, mainFrame: { url: "file:///desktop.html" } }, senderFrame: { url: "file:///desktop.html" } })).toMatchObject({ ok: false, error: { code: "access_denied" } });
  expect(c.calls).toHaveLength(0);
});
test("Session create replay forwards its original identity and revision without configuration synchronization or injected dates", async () => {
  const c = await setup(false);
  const created = { session: { id: 1, title: "", nativeSessionId: "native-a", kind: "user", status: "active", storageVersion: 0, leafId: null, nextSubmissionSequence: 1 },
    workspace: { revision: 1, sessionId: 1, materialVersion: null, batchRefs: [], deviceIds: [], queryId: null, activeView: "data", selection: null } };
  c.host.request = async (method, payload, op) => { c.calls.push({ method, payload, op }); return { ok: true, data: created }; };
  expect(await c.request("session.create", { expectedWorkspaceRevision: 0 }, "create-original")).toEqual({ ok: true, data: created });
  expect(c.syncs()).toBe(0); expect(c.calls).toEqual([{ method: "session.create", payload: { expectedWorkspaceRevision: 0, selectOnCreate: true }, op: "create-original" }]);
});
test("Main preserves unknown writes and rejects a changed in-flight original Session request", async () => {
  const c = await setup(true);
  c.host.request = async (method, payload, op) => { c.calls.push({ method, payload, op }); return method === "run.read" ? { ok: true, data: { kind: "one", run: null } }
    : method === "session.readSubmission" ? { ok: true, data: accepted } : { ok: false, error: safeError("operation_result_unknown", undefined, { operationRef: op }) }; };
  expect(await c.request("session.submit", submission)).toMatchObject({ ok: false, error: { code: "operation_result_unknown", operationRef: "original-operation" } });
  const count = c.calls.length;
  expect(await c.request("session.submit", { ...submission, text: "different" })).toMatchObject({ ok: false, error: { code: "state_conflict" } });
  expect(c.calls).toHaveLength(count); expect(c.syncs()).toBe(0);
});
test("Preload separates invalid input from unknown invoked writes and never turns read errors into null", async () => {
  await import("../../apps/desktop/src/preload/index"); let invoked = 0;
  invoke = async () => { invoked++; return { ok: true, data: "broken reply" }; };
  expect(await bridge.request("session.submit", submission, "known-op")).toMatchObject({ ok: false, error: { code: "operation_result_unknown", operationRef: "known-op" } });
  expect(await bridge.request("workspace.read", {})).toMatchObject({ ok: false, error: { code: "host_protocol_mismatch" } });
  expect(await bridge.request("session.submit", { ...submission, text: " " }, "bad-input")).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
  expect(invoked).toBe(2);
  invoke = async () => { throw new Error("invoke disconnected"); };
  expect(await bridge.request("session.create", { expectedWorkspaceRevision: 0 }, "create-op")).toMatchObject({ ok: false, error: { code: "operation_result_unknown", operationRef: "create-op" } });
  invoke = async () => ({ ok: false, error: safeError("storage_read_failed") });
  expect(await bridge.request("session.readSubmission", { sessionId: 1, clientSequence: 1 })).toMatchObject({ ok: false, error: { code: "storage_read_failed" } });
});
