import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { CatalogStore, installedSdkVersion, PiModelRuntime } from "../../packages/runtime-pi/src/model-runtime.ts";
import { BridgeCredentialStore } from "../../packages/runtime-pi/src/credential-store.ts";
import { providerFixture } from "../fixtures/p1-provider.ts";

const policy = { timeoutMs: 120000, maxRetries: 0 as const, maxRetryDelayMs: 2000 };
const definition = (url: string) => ({ providerId: "p1-fixture", name: "P1 fixture", api: "openai-completions", baseUrl: url, models: [{ id: "fixture", name: "Fixture", input: ["text" as const], reasoning: false, contextWindow: 8192, maxTokens: 1024, outputLimitConfirmed: true as const, pricingKnown: false, cost: null }] });
async function runtime(url: string, api = "openai-completions") {
  const credentials = new InMemoryCredentialStore();
  const key = api === "openai-codex-responses" ? `fixture.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }))}.unsigned` : "fixture-only-key";
  await credentials.modify("p1-fixture", async () => ({ type: "api_key", key }));
  const result = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  await result.installCustom([{ ...definition(url), api }]);
  return result;
}
describe("P1 native Pi model runtime", () => {
  test("catalog cache rejects unknown and secret metadata without replacing old entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "medclaw-p1-runtime-cache-"));
    try {
      const path = join(root, "models.json"), store = await CatalogStore.open(path);
      const rt = await runtime("http://127.0.0.1:9/v1");
      const model = rt.native.getModel("p1-fixture", "fixture")!;
      const entry = { models: [model], etag: '"opaque-validator"', checkedAt: 123, lastModified: 120 };
      await store.write("p1-fixture", entry);
      const persisted = await readFile(path, "utf8");
      for (const unsafe of [
        { ...model, headers: { Authorization: "cache-canary-secret" } },
        { ...model, headers: { "User-Agent": "cache-canary-secret" } },
        { ...model, extra: "cache-canary-secret" },
        { ...model, compat: { unknown: "cache-canary-secret" } },
        { ...model, providers: [{ id: "safe", name: "Safe", credential: { key: "cache-canary-secret" }, source: "radius" }] },
        { ...model, cost: { ...model.cost, input: "bad" } },
      ]) await expect(store.write("p1-fixture", { ...entry, models: [unsafe as typeof model] })).rejects.toThrow();
      await expect(store.write("p1-fixture", { ...entry, extra: "cache-canary-secret" } as typeof entry)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(persisted);
      expect(await (await CatalogStore.open(path)).read("p1-fixture")).toEqual(entry);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("catalog metadata round trips installed SDK models; corrupt cache warns and preserves file", async () => {
    const root = await mkdtemp(join(tmpdir(), "medclaw-p1-runtime-catalog-"));
    try {
      const path = join(root, "models.json"), store = await CatalogStore.open(path);
      const rt = await runtime("http://127.0.0.1:9/v1");
      for (const provider of rt.native.getProviders()) {
        const models = rt.native.getModels().filter(model => model.provider === provider.id);
        await store.write(provider.id, { models, checkedAt: 123, etag: '"validator"' });
        expect((await (await CatalogStore.open(path)).read(provider.id))?.models).toEqual(models);
      }
      await Bun.write(path, '{"p1-fixture":{"models":[{"key":"cache-secret-canary"}]}}');
      await expect(CatalogStore.open(path)).rejects.toThrow();
      const before = await readFile(path, "utf8"), warnings: unknown[] = [];
      const fallback = await CatalogStore.open(path, warning => warnings.push(warning));
      const restarted = await PiModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: fallback });
      expect(restarted.native.getModels().length).toBeGreaterThan(0);
      expect(warnings).toEqual([expect.objectContaining({ code: "provider_refresh_failed" })]);
      expect(JSON.stringify(warnings)).not.toContain("cache-secret-canary");
      expect(await readFile(path, "utf8")).toBe(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("resolved model and explicit free pricing remain frozen in the call", async () => {
    const fixture = providerFixture();
    try {
      const rt = await runtime(fixture.url);
      await rt.installCustom([{ ...definition(fixture.url), models: [{ ...definition(fixture.url).models[0]!, pricingKnown: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] }]);
      const selected = await rt.resolve({ provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "1" }, "1", "original-ref", policy);
      expect(() => { selected.model.cost.input = 1000; }).toThrow();
      expect(() => { selected.model.maxTokens = 1; }).toThrow();
      expect(() => { selected.policy.maxRetryDelayMs = 5000; }).toThrow();
      expect(() => { selected.selection.credentialRef = "changed-ref"; }).toThrow();
      const result = await rt.execute(selected, "free", new AbortController().signal, () => {});
      expect(result.usage.cost).toBe(0);
      expect(result.usageDetails?.costSource).toBe("pi_estimate");
    } finally { fixture.close(); }
  });

  test("usage caches and reasoning are subsets and negative catalog rates stay unknown", async () => {
    const fixture = providerFixture("cached");
    try {
      const rt = await runtime(fixture.url), choice = { provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "1" };
      const result = await rt.execute(await rt.resolve(choice, "1", null, policy), "cached", new AbortController().signal, () => {});
      expect(result.usage.inputTokens).toBe(7);
      expect(result.usage.outputTokens).toBe(3);
      expect(result.usageDetails).toEqual({ source: "pi_normalized", unavailableReason: "pricing_unknown", cacheRead: 5, cacheWrite: null, cacheWrite1h: null, reasoning: 2, totalTokens: 15, costSource: null });
      const auto = rt.native.getModel("openrouter", "openrouter/auto")!;
      const before = auto.cost.cacheRead;
      try {
        auto.cost.cacheRead = 0.1;
        const unknown = await rt.resolve({ provider: auto.provider, modelId: auto.id, expectedConfigVersion: "1" }, "1", null, policy, false);
        expect(unknown.pricingKnown).toBe(false);
      } finally { auto.cost.cacheRead = before; }
    } finally { fixture.close(); }
  });

  test("partial native usage never becomes a complete total", async () => {
    const fixture = providerFixture("partial");
    try {
      const rt = await runtime(fixture.url);
      const result = await rt.execute(await rt.resolve({ provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "1" }, "1", null, policy), "partial usage", new AbortController().signal, () => {});
      expect(result.usage.inputTokens).toBeNull();
      expect(result.usage.outputTokens).toBe(3);
      expect(result.usageDetails?.totalTokens).toBeNull();
      expect(result.usageDetails?.unavailableReason).toBe("pi_normalized_partial");
    } finally { fixture.close(); }
  });

  test("private credential replies are parsed before Pi receives them", async () => {
    await expect(new BridgeCredentialStore(async () => ({ type: "api_key", key: 42 })).read("p1-fixture")).rejects.toThrow();
    await expect(new BridgeCredentialStore(async () => [{ providerId: "p1-fixture", type: "api_key", key: "private-canary" }]).list()).rejects.toThrow();
    let called = false;
    await expect(new BridgeCredentialStore(async () => ({ leaseId: "lease", version: "bad-version", current: null })).modify("p1-fixture", async () => { called = true; return undefined; })).rejects.toThrow();
    expect(called).toBe(false);
    let sent = false;
    const abort = new AbortController(); abort.abort();
    await expect(new BridgeCredentialStore(async () => { sent = true; return null; }).read("p1-fixture", { signal: abort.signal })).rejects.toThrow();
    expect(sent).toBe(false);
  });

  test("credential lease remains held until an aborted callback settles; undefined keeps value", async () => {
    const calls: { method: string; payload: unknown }[] = [];
    const store = new BridgeCredentialStore(async (method, payload) => {
      calls.push({ method, payload });
      if (method === "credential.modify.begin") return { leaseId: "lease", version: "1", current: null };
      if (method === "credential.modify.commit") return null;
      return null;
    });
    const abort = new AbortController();
    let settle!: () => void, started!: () => void;
    const callback = new Promise<void>(resolve => { settle = resolve; });
    const callbackStarted = new Promise<void>(resolve => { started = resolve; });
    const pending = store.withContext({ purpose: "runtime", operationRef: "original-operation", credentialRef: "original-ref" }, () => store.modify("p1-fixture", async current => {
      expect(current).toBeUndefined();
      started();
      await callback;
      return undefined;
    }, { signal: abort.signal }));
    await callbackStarted;
    abort.abort();
    await Promise.resolve();
    expect(calls.map(call => call.method)).toEqual(["credential.modify.begin"]);
    settle();
    await expect(pending).rejects.toThrow();
    expect(calls.map(call => call.method)).toEqual(["credential.modify.begin", "credential.modify.abort"]);
    expect(await store.modify("p1-fixture", async () => undefined)).toBeUndefined();
    expect(calls.at(-1)).toEqual({ method: "credential.modify.commit", payload: { leaseId: "lease", expectedVersion: "1", changed: false } });
  });
  test("custom target actually changes; native stream and unknown usage", async () => {
    const first = providerFixture(), second = providerFixture("unknown");
    try {
      const rt = await runtime(first.url);
      const choice = { provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "1" };
      const snapshots: string[] = [];
      const resolved = await rt.resolve(choice, "1", null, policy);
      const result = await rt.execute(resolved, "hello", new AbortController().signal, text => snapshots.push(text));
      expect(result.text).toBe("你好😀 OK");
      expect(result.responseModel).toBe("actual-fixture");
      expect(result.callState).toBe("completed");
      expect(result.usage.inputTokens).toBe(7);
      expect(result.usage.cost).toBeNull();
      expect(result.usageDetails).toEqual({ source: "pi_normalized", unavailableReason: "pricing_unknown", cacheRead: null, cacheWrite: null, cacheWrite1h: null, reasoning: null, totalTokens: 10, costSource: null });
      expect(first.requests).toHaveLength(1);
      const sentLimit = first.requests[0]!.body.max_tokens ?? first.requests[0]!.body.max_completion_tokens;
      expect(sentLimit).toBeGreaterThan(0);
      expect(sentLimit).toBeLessThanOrEqual(1024);
      const stable = snapshots[0];
      await rt.installCustom([definition(second.url)]);
      const next = await rt.resolve({ ...choice, expectedConfigVersion: "2" }, "2", null, policy);
      const unknown = await rt.execute(next, "next", new AbortController().signal, () => {});
      expect(second.requests).toHaveLength(1);
      expect(first.requests).toHaveLength(1);
      expect(unknown.usage.inputTokens).toBeNull();
      expect(unknown.usageDetails?.totalTokens).toBeNull();
      expect(snapshots[0]).toBe(stable);
      expect(resolved.selection.maxOutputTokens).toBe(1024);
    } finally { first.close(); second.close(); }
  });
  test("late old native cache cannot overwrite a full custom API update or retain its runtime key", async () => {
    const first = providerFixture();
    const requests: { url: string; authorization: string | null; model: unknown }[] = [];
    const second = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      requests.push({ url: request.url, authorization: request.headers.get("authorization"), model: (await request.json() as { model?: unknown }).model });
      return Response.json({ error: { message: "controlled API update check" } }, { status: 503 });
    } });
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    try {
      const credentials = new InMemoryCredentialStore(), store = new InMemoryModelsStore();
      await credentials.modify("p1-fixture", async () => ({ type: "api_key", key: "new-stored-fixture-key" }));
      const rt = await PiModelRuntime.create({ credentials, modelsStore: store });
      await rt.installCustom([definition(first.url)]);
      await rt.native.setRuntimeApiKey("p1-fixture", "old-runtime-fixture-key");
      const oldModel = rt.native.getModel("p1-fixture", "fixture")!;
      expect((await rt.native.getAuth(oldModel))?.auth.apiKey).toBe("old-runtime-fixture-key");
      await store.write("p1-fixture", { models: [oldModel] });
      const read = store.read.bind(store);
      let started!: () => void, oldCallback!: () => void, delayedOnce = false, oldSignal: AbortSignal | undefined;
      const readStarted = new Promise<void>(resolve => { started = resolve; });
      const callbackCompleted = new Promise<void>(resolve => { oldCallback = resolve; });
      store.read = async (id, options) => {
        const value = await read(id, options);
        if (id === "p1-fixture" && !delayedOnce) {
          delayedOnce = true; oldSignal = options?.signal; started();
          // Ignore cancellation only in this fault fixture so the stale read really returns late.
          await delayed;
        }
        return value;
      };
      // Ordinary P1 custom definitions have no cache reader. The SDK's public refresh hook
      // makes the old registration's cache phase observable without adding a product hook.
      rt.native.registerProvider("p1-fixture", { refreshModels: async context => { oldCallback(); return [...context.stored?.models ?? []]; } });
      await readStarted;
      const nextUrl = `http://127.0.0.1:${second.port}/v1`;
      await rt.installCustom([{ ...definition(nextUrl), api: "openai-responses", models: [{ ...definition(nextUrl).models[0]!, name: "New API model", maxTokens: 512 }] }]);
      expect(oldSignal?.aborted).toBe(true);
      release(); await callbackCompleted; await Bun.sleep(20);
      const model = rt.native.getModel("p1-fixture", "fixture")!;
      expect(model).toMatchObject({ api: "openai-responses", baseUrl: nextUrl, name: "New API model", maxTokens: 512 });
      expect(rt.native.getRegisteredProviderConfig("p1-fixture")?.refreshModels).toBeUndefined();
      expect((await rt.native.getAuth(model))?.auth.apiKey).toBe("new-stored-fixture-key");
      const selected = await rt.resolve({ provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "2" }, "2", null, policy);
      expect((await rt.execute(selected, "New API fixture only", new AbortController().signal, () => {})).callState).toBe("failed");
      expect(requests).toEqual([{ url: `${nextUrl}/responses`, authorization: "Bearer new-stored-fixture-key", model: "fixture" }]);
      expect(first.requests).toHaveLength(0);
    } finally { release(); first.close(); second.stop(true); }
  }, 10000);
  test("native retry is sole request retry and cancellation settles", async () => {
    const fixture = providerFixture("retry");
    try {
      const rt = await runtime(fixture.url);
      const resolved = await rt.resolve({ provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "1" }, "1", null, { ...policy, maxRetries: 1 });
      const result = await rt.execute(resolved, "retry", new AbortController().signal, () => {});
      expect(result.callState).toBe("completed");
      expect(fixture.requests).toHaveLength(2);
    } finally { fixture.close(); }
    const slow = providerFixture("slow");
    try {
      const rt = await runtime(slow.url);
      const resolved = await rt.resolve({ provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "1" }, "1", null, policy);
      const abort = new AbortController();
      const result = await rt.execute(resolved, "cancel", abort.signal, () => abort.abort());
      expect(result.callState).toBe("cancelled");
      expect(slow.requests).toHaveLength(1);
    } finally { slow.close(); }
  });

  test("native 503 retry wait can be aborted and a server wait above policy fails once", async () => {
    const retry = providerFixture("retry"), capped = providerFixture("busy");
    try {
      const rt = await runtime(retry.url);
      const selected = await rt.resolve({ provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "1" }, "1", null, { ...policy, maxRetries: 1 });
      const abort = new AbortController(), pending = rt.execute(selected, "retry wait", abort.signal, () => {});
      await retry.requested;
      await Bun.sleep(75);
      const started = performance.now(); abort.abort();
      expect((await pending).callState).toBe("cancelled");
      expect(performance.now() - started).toBeLessThan(750);
      expect(retry.requests).toHaveLength(1);
      const capRt = await runtime(capped.url);
      const cap = await capRt.resolve({ provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "1" }, "1", null, { ...policy, maxRetries: 1, maxRetryDelayMs: 1 });
      expect((await capRt.execute(cap, "capped wait", new AbortController().signal, () => {})).callState).toBe("failed");
      expect(capped.requests).toHaveLength(1);
    } finally { retry.close(); capped.close(); }
  });

  test("single fetch APIs send once at zero and reject retry one before HTTP", async () => {
    for (const api of ["mistral-conversations", "pi-messages"]) {
      const fixture = providerFixture("busy");
      try {
        const rt = await runtime(fixture.url, api);
        const choice = { provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "1" };
        await expect(rt.resolve(choice, "1", null, { ...policy, maxRetries: 1 })).rejects.toThrow("retry_policy_unsupported");
        expect(fixture.requests).toHaveLength(0);
        const selected = await rt.resolve(choice, "1", null, policy);
        const started = performance.now();
        expect((await rt.execute(selected, "single fetch", new AbortController().signal, () => {})).callState).toBe("failed");
        expect(performance.now() - started).toBeLessThan(750);
        expect(fixture.requests).toHaveLength(1);
      } finally { fixture.close(); }
    }
  });

  test("remaining native retry APIs honor zero and one HTTP retry", async () => {
    for (const api of ["anthropic-messages", "openai-responses", "azure-openai-responses", "openai-codex-responses", "google-generative-ai", "google-vertex"]) {
      const fixture = providerFixture("busy");
      try {
        const rt = await runtime(fixture.url, api), choice = { provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "1" };
        for (const maxRetries of [0, 1] as const) {
          const before = fixture.requests.filter(request => request.method === "POST").length;
          const selected = await rt.resolve(choice, "1", null, { ...policy, maxRetries });
          expect((await rt.execute(selected, "native retry matrix", new AbortController().signal, () => {})).callState).toBe("failed");
          expect(fixture.requests.filter(request => request.method === "POST").length - before).toBe(maxRetries + 1);
        }
      } finally { fixture.close(); }
    }
  }, 20000);

  test("Bedrock native 503 makes one attempt and cancellation settles in owned child env", async () => {
    const busy = providerFixture("busy"), waiting = providerFixture("wait");
    const childScript = `
      import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
      import { PiModelRuntime, installedSdkVersion } from "./packages/runtime-pi/src/model-runtime.ts";
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("p1-bedrock", async () => ({ type:"api_key", key:"fixture-only-key" }));
      const rt = await PiModelRuntime.create({ credentials, modelsStore:new InMemoryModelsStore() });
      await rt.installCustom([{providerId:"p1-bedrock",name:"Bedrock fixture",api:"bedrock-converse-stream",baseUrl:process.argv[1],models:[{id:"fixture",name:"Fixture",input:["text"],reasoning:false,contextWindow:8192,maxTokens:1024,outputLimitConfirmed:true,pricingKnown:false,cost:null}]}]);
      const choice = {provider:"p1-bedrock",modelId:"fixture",expectedConfigVersion:"1"};
      const policy = {timeoutMs:120000,maxRetries:0,maxRetryDelayMs:2000};
      let rejected = false;
      try { await rt.resolve(choice,"1",null,{...policy,maxRetries:1}); } catch (error) { rejected = error.message === "retry_policy_unsupported"; }
      const selected = await rt.resolve(choice,"1",null,policy);
      const abort = new AbortController();
      if (process.argv[2] === "cancel") setTimeout(() => abort.abort(), 500);
      const result = await rt.execute(selected,"native bedrock",abort.signal,()=>{});
      console.log(JSON.stringify({ sdk:await installedSdkVersion(), rejected, state:result.callState }));
    `;
    try {
      for (const [fixture, mode, state] of [[busy, "fail", "failed"], [waiting, "cancel", "cancelled"]] as const) {
        const child = Bun.spawn([process.execPath, "--no-env-file", "-e", childScript, fixture.url, mode], { cwd: process.cwd(), env: { ...process.env, AWS_MAX_ATTEMPTS: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_BEDROCK_FORCE_HTTP1: "1", AWS_EC2_METADATA_DISABLED: "true", AWS_REGION: "us-east-1", NO_PROXY: "127.0.0.1" }, stdout: "pipe", stderr: "pipe" });
        const output = await new Response(child.stdout).text(), error = await new Response(child.stderr).text();
        expect(await child.exited).toBe(0);
        expect(error).toBe("");
        expect(JSON.parse(output)).toEqual({ sdk: "0.87.1", rejected: true, state });
        expect(fixture.requests).toHaveLength(1);
      }
    } finally { busy.close(); waiting.close(); }
  }, 10000);

  test("partial provider refresh keeps failed directory and aborts with caller signal", async () => {
    const credentials = new InMemoryCredentialStore(), rt = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
    const api = getApiProvider("openai-completions")!;
    for (const id of ["p1-refresh-good", "p1-refresh-bad", "p1-refresh-wait"]) {
      await credentials.modify(id, async () => ({ type: "api_key", key: "fixture-key" }));
      const model = { ...rt.native.getModels().find(m => m.api === "openai-completions")!, id: "old", provider: id };
      rt.native.registerNativeProvider(createProvider({ id, models: [model], api, auth: { apiKey: { name: "Fixture", resolve: async ({ credential }) => credential ? { auth: { apiKey: credential.key } } : undefined } }, fetchModels: async ({ signal }) => {
        if (id === "p1-refresh-good") return [{ ...model, id: "new" }];
        if (id === "p1-refresh-bad") throw new Error("refresh-canary-do-not-project");
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        return [{ ...model, id: "late" }];
      } }));
    }
    const refreshed = await rt.refresh(undefined, AbortSignal.timeout(100));
    expect(refreshed.aborted).toBe(true);
    expect(refreshed.errors).toEqual([{ providerId: "p1-refresh-bad", error: expect.objectContaining({ code: "provider_refresh_failed" }) }]);
    expect(rt.native.getModel("p1-refresh-good", "new")).toBeDefined();
    expect(rt.native.getModel("p1-refresh-bad", "old")).toBeDefined();
    expect(rt.native.getModel("p1-refresh-wait", "old")).toBeDefined();
    expect(rt.native.getModel("p1-refresh-wait", "late")).toBeUndefined();
    expect(JSON.stringify(refreshed)).not.toContain("refresh-canary");
  });
});
