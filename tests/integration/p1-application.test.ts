import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, createProvider, InMemoryCredentialStore, InMemoryModelsStore, type ProviderStreams } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { openDatabase } from "../../packages/storage/src/database.ts";
import { Repositories } from "../../packages/storage/src/repositories.ts";
import { PiModelRuntime } from "../../packages/runtime-pi/src/model-runtime.ts";
import { ModelCallRecorder } from "../../packages/runtime-pi/src/model-call-recorder.ts";
import { Application } from "../../packages/core/src/application.ts";
import { PublishedSettingsSchema } from "../../packages/contracts/src/model.ts";
import type { RuntimeNotice } from "../../packages/contracts/src/protocol.ts";
import { providerFixture } from "../fixtures/p1-provider.ts";

async function setup(mode: Parameters<typeof providerFixture>[0], beforeCommit?: () => void) {
  const path = await mkdtemp(join(tmpdir(), "medclaw-p1-app-"));
  const fixture = providerFixture(mode), db = openDatabase(join(path, "db.sqlite"));
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("p1-fixture", async () => ({ type: "api_key", key: "fixture-only" }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  const definition = { providerId: "p1-fixture", name: "Fixture", api: "openai-completions", baseUrl: fixture.url, models: [{ id: "fixture", name: "Fixture", input: ["text" as const], reasoning: false, contextWindow: 8192, maxTokens: 1024, outputLimitConfirmed: true as const, pricingKnown: false, cost: null }] };
  await runtime.installCustom([definition]);
  const settings = PublishedSettingsSchema.parse({ schemaVersion: "medclaw.settings/p1-v1", configVersion: "1", model: { provider: "p1-fixture", modelId: "fixture" }, customProviders: [{ definition, credentialRef: null }], credentialRefs: {}, requestPolicy: { timeoutMs: 1000, maxRetries: 0, maxRetryDelayMs: 2000 }, ui: { navCollapsed: false, detailOpen: false, detailTab: "conditions" }, previous: null, rollbackFromVersion: null });
  const repositories = new Repositories(db, beforeCommit);
  const notices: RuntimeNotice[] = [];
  const app = new Application("test-instance", settings, runtime, repositories, (_context, action) => action(),
    (runId, kind, time) => new ModelCallRecorder(repositories, runId, kind, time), n => notices.push(n));
  const payload = { text: "hello", model: { provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "1" }, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" };
  const command = { requestId: "request", instanceId: "test-instance", operationRef: crypto.randomUUID(), payload };
  return { app, runtime, credentials, repositories, fixture, notices, command, close: async () => { await app.shutdown(); db.close(); fixture.close(); await rm(path, { recursive: true, force: true }); } };
}
async function until(predicate: () => boolean) { const end = Date.now() + 4000; while (!predicate()) { if (Date.now() > end) throw new Error("test condition timed out"); await Bun.sleep(10); } }
test("Core imports only contracts and platform libraries", async () => {
  const source = await Bun.file(new URL("../../packages/core/src/application.ts", import.meta.url)).text();
  const imports = [...source.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/g)].map(match => match[1]!);
  expect(imports.filter(specifier => !specifier.startsWith("node:") && !specifier.includes("/contracts/") && !specifier.startsWith("@medclaw/contracts/") && !specifier.startsWith("./runtime/"))).toEqual([]);
  expect(source.includes("CredentialSynchronizationError")).toBe(false);
});
test("operation identity returns original and terminals persist before notice", async () => {
  const ctx = await setup("success");
  try {
    const accepted = await ctx.app.submitProvider(ctx.command);
    await until(() => !ctx.app.busy);
    expect((await ctx.app.submitProvider(ctx.command)).reused).toBe(true);
    expect(ctx.fixture.requests).toHaveLength(1);
    await expect(ctx.app.submitProvider({ ...ctx.command, payload: { ...ctx.command.payload, text: "changed" } })).rejects.toThrow("state_conflict");
    const result = ctx.repositories.read({ runId: accepted.runId });
    expect(result.kind === "one" && result.run?.status).toBe("completed");
    expect(result.kind === "one" && result.run?.calls[0]?.attemptCountUnknown).toBe(true);
    expect(ctx.notices).toContainEqual({ type: "provider.settled", runId: accepted.runId });
    expect(ctx.app.cancelProvider(accepted.runId).cancelRequested).toBe(false);
  } finally { await ctx.close(); }
});
test("Stop aborts before DB write and same final fact saves without another HTTP call", async () => {
  let failSave = false;
  const ctx = await setup("slow", () => { if (failSave) throw new Error("storage fixture"); });
  try {
    const accepted = await ctx.app.submitProvider(ctx.command);
    await until(() => ctx.fixture.requests.length === 1);
    failSave = true;
    // DB may fail, but Stop must still reach the SDK immediately.
    const cancel = ctx.app.cancelProvider(accepted.runId);
    expect(cancel.persistencePending).toBe(true);
    await until(() => ctx.notices.some(n => (n as { type: string }).type === "provider.persistence_failed"));
    expect(ctx.app.busy).toBe(true);
    await expect(ctx.app.submitProvider({ ...ctx.command, operationRef: "new-operation" })).rejects.toThrow("runtime_busy");
    failSave = false;
    const saved = ctx.app.retrySave(accepted.runId);
    expect(saved.status).toBe("cancelled");
    expect(saved.cancelRequestedAt).not.toBeNull();
    expect(saved.calls[0]?.state).toBe("cancelled");
    expect(ctx.fixture.requests).toHaveLength(1);
  } finally { failSave = false; await ctx.close(); }
});
test("total deadline becomes failed, never extends through native execution", async () => {
  const ctx = await setup("slow");
  try {
    const accepted = await ctx.app.submitProvider(ctx.command);
    await until(() => !ctx.app.busy);
    const result = ctx.repositories.read({ runId: accepted.runId });
    expect(result.kind === "one" && result.run?.status).toBe("failed");
    expect(result.kind === "one" && result.run?.error?.code).toBe("run_timeout");
    expect(ctx.fixture.requests).toHaveLength(1);
  } finally { await ctx.close(); }
});
test("published selection and policy cannot change a frozen active request", async () => {
  const ctx = await setup("slow");
  try {
    const accepted = await ctx.app.submitProvider(ctx.command);
    await until(() => ctx.fixture.requests.length === 1);
    const original = ctx.app.config;
    const next = { ...original, configVersion: "2", requestPolicy: { ...original.requestPolicy, timeoutMs: 2000 }, ui: { ...original.ui, navCollapsed: true } };
    await ctx.app.prepareConfig("publish-token", next);
    ctx.app.commitConfig("publish-token", "2");
    // Lost commit reply can be looked up under the same token/version.
    ctx.app.commitConfig("publish-token", "2");
    const changedCustom = { ...next, configVersion: "3", customProviders: next.customProviders.map(p => ({ ...p, definition: { ...p.definition, models: p.definition.models.map(m => ({ ...m, maxTokens: 512 })) } })) };
    await expect(ctx.app.prepareConfig("runtime-change", changedCustom)).rejects.toThrow("runtime_busy");
    await expect(ctx.app.prepareConfig("binding-change", { ...next, configVersion: "3", credentialRefs: { "p1-fixture": "new-account" } })).rejects.toThrow("runtime_busy");
    await expect(ctx.app.prepareConfig("rollback-active", { ...original, configVersion: "3", rollbackFromVersion: "1" })).rejects.toThrow("runtime_busy");
    await expect(ctx.app.refresh("refresh-while-active")).rejects.toThrow("runtime_busy");
    await expect(ctx.app.startAuth("login-while-active", "p1-fixture", "api_key")).rejects.toThrow("runtime_busy");
    ctx.app.cancelProvider(accepted.runId);
    await until(() => !ctx.app.busy);
    const result = ctx.repositories.read({ runId: accepted.runId });
    expect(result.kind === "one" && result.run?.model.configVersion).toBe("1");
    expect(result.kind === "one" && result.run?.model.maxOutputTokens).toBe(1024);
    expect(result.kind === "one" && result.run?.policy.timeoutMs).toBe(1000);
    expect(ctx.fixture.requests).toHaveLength(1);
  } finally { await ctx.close(); }
});
test("native API-key interaction binds prompts, supports cancellation and creates no Run", async () => {
  const ctx = await setup("success");
  try {
    const first = await ctx.app.startAuth("login-1", "p1-fixture", "api_key");
    await until(() => ctx.notices.some(n => (n as { type: string }).type === "auth.prompt"));
    const prompt = (ctx.notices.find(n => (n as { type: string }).type === "auth.prompt") as { prompt: { promptId: string; authAttemptId: string } }).prompt;
    expect(prompt.authAttemptId).toBe(first.authAttemptId);
    expect(() => ctx.app.respondAuth(first.authAttemptId, "wrong-prompt", "wrong")).toThrow("auth_prompt_invalid");
    ctx.app.cancelAuth(first.authAttemptId);
    await until(() => ctx.notices.some(n => (n as { type: string }).type === "auth.finished"));
    expect((await ctx.app.authStatus("p1-fixture", first.authAttemptId)).attempt?.state).toBe("cancelled");
    expect(() => ctx.app.respondAuth(first.authAttemptId, prompt.promptId, "late")).toThrow("auth_prompt_invalid");
    ctx.notices.length = 0;
    const second = await ctx.app.startAuth("login-2", "p1-fixture", "api_key");
    await until(() => ctx.notices.some(n => (n as { type: string }).type === "auth.prompt"));
    const next = (ctx.notices.find(n => (n as { type: string }).type === "auth.prompt") as { prompt: { promptId: string } }).prompt;
    ctx.app.respondAuth(second.authAttemptId, next.promptId, "fixture-new-key");
    await until(() => ctx.notices.some(n => (n as { type: string }).type === "auth.finished"));
    expect((await ctx.app.authStatus("p1-fixture", second.authAttemptId)).attempt?.state).toBe("completed");
    expect(ctx.repositories.read({ recent: true }).kind).toBe("recent");
    expect(ctx.repositories.active()).toBeNull();
    expect(ctx.fixture.requests).toHaveLength(0);
  } finally { await ctx.close(); }
});

test("native OAuth interaction carries device notifications and validates live select/manual prompts", async () => {
  const ctx = await setup("success");
  let logins = 0, refreshes = 0, racedPromptCancelled = false;
  try {
    const model = { ...ctx.runtime.native.getModel("p1-fixture", "fixture")!, provider: "p1-oauth" };
    ctx.runtime.native.registerNativeProvider(createProvider({ id: "p1-oauth", models: [model], api: getApiProvider(model.api)!, auth: { oauth: {
      name: "Engineering OAuth",
      async login(interaction) {
        logins++;
        interaction.notify({ type: "info", message: "Fixture authentication", links: [{ url: "https://example.com/help", label: "Help" }] });
        interaction.notify({ type: "auth_url", url: "https://example.com/auth", instructions: "Engineering fixture only" });
        interaction.notify({ type: "device_code", userCode: "FIXTURE-CODE", verificationUri: "https://example.com/device", intervalSeconds: 1, expiresInSeconds: 60 });
        const promptAbort = new AbortController();
        const obsolete = interaction.prompt({ type: "manual_code", message: "Callback race", signal: promptAbort.signal });
        promptAbort.abort();
        await obsolete.catch(() => { racedPromptCancelled = true; });
        expect(interaction.signal.aborted).toBe(false);
        expect(await interaction.prompt({ type: "select", message: "Choose account", options: [{ id: "work", label: "Work", description: "Fixture account" }, { id: "personal", label: "Personal" }] })).toBe("work");
        expect(await interaction.prompt({ type: "manual_code", message: "Paste authorization code" })).toBe("manual-fixture-code");
        expect(await interaction.prompt({ type: "text", message: "Account label" })).toBe("fixture label");
        interaction.notify({ type: "progress", message: "Fixture exchange complete" });
        return { type: "oauth", access: "oauth-access-canary", refresh: "oauth-refresh-canary", expires: Date.now() + 3_600_000 };
      },
      async refresh(credential) { refreshes++; return credential; },
      async toAuth(credential) { return { apiKey: credential.access }; },
    } } }));
    const attempt = await ctx.app.startAuth("native-oauth", "p1-oauth", "oauth");
    await until(() => ctx.notices.some(n => n.type === "auth.prompt" && n.prompt.type === "select"));
    const obsolete = ctx.notices.find(n => n.type === "auth.prompt" && n.prompt.message === "Callback race");
    const selection = ctx.notices.find(n => n.type === "auth.prompt" && n.prompt.type === "select");
    if (obsolete?.type !== "auth.prompt" || selection?.type !== "auth.prompt") throw new Error("fixture prompt missing");
    expect(() => ctx.app.respondAuth(attempt.authAttemptId, obsolete.prompt.promptId, "late callback")).toThrow("auth_prompt_invalid");
    expect(() => ctx.app.respondAuth(attempt.authAttemptId, selection.prompt.promptId, "outside-options")).toThrow("auth_prompt_invalid");
    ctx.app.respondAuth(attempt.authAttemptId, selection.prompt.promptId, "work");
    expect(() => ctx.app.respondAuth(attempt.authAttemptId, selection.prompt.promptId, "personal")).toThrow("auth_prompt_invalid");
    for (const [message, value] of [["Paste authorization code", "manual-fixture-code"], ["Account label", "fixture label"]]) {
      await until(() => ctx.notices.some(n => n.type === "auth.prompt" && n.prompt.message === message));
      const prompt = ctx.notices.find(n => n.type === "auth.prompt" && n.prompt.message === message);
      if (prompt?.type !== "auth.prompt") throw new Error("fixture prompt missing");
      expect(prompt.prompt.authAttemptId).toBe(attempt.authAttemptId);
      ctx.app.respondAuth(attempt.authAttemptId, prompt.prompt.promptId, value!);
    }
    await until(() => ctx.notices.some(n => n.type === "auth.finished"));
    const checked = await ctx.app.authStatus("p1-oauth", attempt.authAttemptId);
    expect(checked.attempt?.state).toBe("completed");
    expect(checked.auth).toMatchObject({ state: "available", type: "oauth", checkKind: "snapshot" });
    expect(racedPromptCancelled).toBe(true);
    expect(ctx.notices.filter(n => n.type === "auth.notify").map(n => n.notification.type)).toEqual(["info", "auth_url", "device_code", "progress"]);
    expect(ctx.notices.filter(n => n.type === "auth.notify").every(n => n.notification.authAttemptId === attempt.authAttemptId)).toBe(true);
    expect(JSON.stringify(ctx.notices)).not.toContain("oauth-access-canary");
    expect(JSON.stringify(ctx.notices)).not.toContain("oauth-refresh-canary");
    expect([logins, refreshes]).toEqual([1, 0]);
    expect(ctx.repositories.read({ recent: true })).toMatchObject({ kind: "recent", runs: [] });
    expect(ctx.fixture.requests).toHaveLength(0);
  } finally { await ctx.close(); }
});

test("native credential synchronization failure keeps committed OAuth and status queries do not relogin", async () => {
  const ctx = await setup("success");
  let logins = 0, refreshes = 0;
  try {
    const model = { ...ctx.runtime.native.getModel("p1-fixture", "fixture")!, provider: "p1-sync" };
    ctx.runtime.native.registerNativeProvider(createProvider({ id: "p1-sync", models: [model], api: getApiProvider(model.api)!, auth: { oauth: {
      name: "Engineering synchronization failure",
      async login() { logins++; return { type: "oauth", access: "committed-access-canary", refresh: "committed-refresh-canary", expires: Date.now() + 3_600_000 }; },
      async refresh(credential) { refreshes++; return credential; },
      async toAuth(credential) { return { apiKey: credential.access }; },
    } }, filterModels(models, credential) {
      // The SDK commits the credential before it refreshes this local availability snapshot.
      if (credential?.type === "oauth") throw new Error("snapshot-canary-do-not-project");
      return models;
    } }));
    const attempt = await ctx.app.startAuth("sync-failure", "p1-sync", "oauth");
    await until(() => ctx.notices.some(n => n.type === "auth.finished"));
    expect(await ctx.credentials.read("p1-sync")).toMatchObject({ type: "oauth", access: "committed-access-canary" });
    for (let i = 0; i < 2; i++) {
      const checked = await ctx.app.authStatus("p1-sync", attempt.authAttemptId);
      expect(checked.attempt).toMatchObject({ state: "sync_unknown", error: { code: "model_auth_sync_failed" }, pendingPromptId: null });
      expect(checked.auth).toMatchObject({ state: "available", type: "oauth", checkKind: "snapshot" });
    }
    expect([logins, refreshes]).toEqual([1, 0]);
    expect(JSON.stringify(ctx.notices)).not.toMatch(/committed-(?:access|refresh)-canary|snapshot-canary/);
    expect(ctx.repositories.read({ recent: true })).toMatchObject({ kind: "recent", runs: [] });
    expect(ctx.fixture.requests).toHaveLength(0);
  } finally { await ctx.close(); }
});

test("Stop before delivery of a native success preserves completed call and cancels the Run", async () => {
  const ctx = await setup("success");
  let release!: () => void, completed!: (reason: string) => void;
  const delivery = new Promise<void>(resolve => { release = resolve; });
  const nativeCompleted = new Promise<string>(resolve => { completed = resolve; });
  try {
    const model = ctx.runtime.native.getModel("p1-fixture", "fixture")!, provider = ctx.runtime.native.getProvider("p1-fixture")!;
    const api: ProviderStreams = getApiProvider(model.api)!;
    ctx.runtime.native.registerNativeProvider(createProvider({ id: provider.id, models: [model], auth: provider.auth, api: {
      stream: api.stream,
      streamSimple(model, context, options) {
        const source = api.streamSimple(model, context, options), relay = createAssistantMessageEventStream();
        void (async () => {
          for await (const event of source) {
            if (event.type === "done") {
              // The actual Pi HTTP parser has succeeded; delay only its terminal delivery.
              completed(event.reason);
              await delivery;
            }
            relay.push(event);
          }
          relay.end(await source.result());
        })();
        return relay;
      },
    } }));
    const accepted = await ctx.app.submitProvider(ctx.command);
    const nativeReason = await nativeCompleted;
    expect(nativeReason).toBe("stop");
    expect(ctx.app.cancelProvider(accepted.runId)).toMatchObject({ cancelRequested: true, stopped: false });
    release();
    await until(() => !ctx.app.busy);
    const result = ctx.repositories.read({ runId: accepted.runId });
    expect(result.kind === "one" && result.run).toMatchObject({ status: "cancelled", calls: [{ state: "completed", sdkStopReason: "stop", responseModel: "actual-fixture" }] });
    expect(result.kind === "one" && result.run?.cancelRequestedAt).not.toBeNull();
    expect(result.kind === "one" && result.run?.output.text).toBe("你好😀 OK");
    expect(ctx.fixture.requests).toHaveLength(1);
  } finally { release(); await ctx.close(); }
});

test("Stop after native terminal lock leaves a completed pending fact unchanged", async () => {
  let writes = 0, failSave = true;
  const ctx = await setup("success", () => { if (++writes >= 3 && failSave) throw new Error("final publication denied"); });
  try {
    const accepted = await ctx.app.submitProvider(ctx.command);
    await until(() => ctx.notices.some(n => n.type === "provider.persistence_failed"));
    expect(ctx.app.cancelProvider(accepted.runId)).toMatchObject({ cancelRequested: false, stopped: true, persistencePending: true });
    failSave = false;
    const result = ctx.app.retrySave(accepted.runId);
    expect(result).toMatchObject({ status: "completed", cancelRequestedAt: null, calls: [{ state: "completed", sdkStopReason: "stop" }] });
    expect(ctx.fixture.requests).toHaveLength(1);
  } finally { failSave = false; await ctx.close(); }
});

test("native unauthorized and dropped connections persist safe failed Run/call facts", async () => {
  for (const mode of ["unauthorized", "drop"] as const) {
    const ctx = await setup(mode);
    try {
      const accepted = await ctx.app.submitProvider(ctx.command);
      await until(() => !ctx.app.busy);
      const result = ctx.repositories.read({ runId: accepted.runId });
      expect(result.kind === "one" && result.run).toMatchObject({ status: "failed", calls: [{ state: "failed", sdkStopReason: "error" }] });
      expect(result.kind === "one" && result.run?.error?.code).toBe("provider_request_failed");
      expect(JSON.stringify(result)).not.toContain("fixture-secret-do-not-project");
      expect(ctx.fixture.requests).toHaveLength(1);
      expect(ctx.notices).toContainEqual({ type: "provider.settled", runId: accepted.runId });
    } finally { await ctx.close(); }
  }
});

test("missing model or authentication is rejected before any Run or native HTTP call", async () => {
  const ctx = await setup("success");
  try {
    await expect(ctx.app.submitProvider({ ...ctx.command, payload: { ...ctx.command.payload, model: { ...ctx.command.payload.model, modelId: "missing" } } })).rejects.toThrow("model_not_found");
    await ctx.credentials.delete("p1-fixture");
    await expect(ctx.app.submitProvider(ctx.command)).rejects.toThrow("model_auth_missing");
    expect(ctx.repositories.read({ recent: true })).toMatchObject({ kind: "recent", runs: [] });
    expect(ctx.fixture.requests).toHaveLength(0);
  } finally { await ctx.close(); }
});
