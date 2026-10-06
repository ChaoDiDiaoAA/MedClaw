import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_SCHEMA_VERSION, HOST_PROTOCOL_VERSION } from "../../packages/contracts/src/protocol";

describe("P1 stage runner", () => {
  test("rejects unknown suite/stage and an empty discovered suite", async () => {
    const { discoverTests, runStage } = await import("../run");
    const root = mkdtempSync(join(tmpdir(), "medclaw-p1-empty-"));
    try {
      expect(() => discoverTests("invalid" as "unit", "P1", root)).toThrow();
      expect(() => discoverTests("unit", "P99", root)).toThrow();
      expect(discoverTests("unit", "P1", root)).toEqual([]);
      const result = await runStage("unit", "P1", { root });
      expect(result.discovered).toBe(0);
      expect(result.executed).toBe(0);
      expect(result.exitCode).not.toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("runs discovered tests without passing the product stage flag to Bun", async () => {
    const { discoverTests, runStage } = await import("../run");
    const root = mkdtempSync(join(tmpdir(), "medclaw-p1-runner-"));
    try {
      mkdirSync(join(root, "tests/unit"), { recursive: true });
      writeFileSync(join(root, "tests/unit/p1.test.ts"),
        'import {test,expect} from "bun:test"; test("actual execution",()=>expect(Bun.argv.includes("--stage")).toBe(false)); test.skip("explicit skip",()=>{});');
      expect(discoverTests("unit", "P1", root)).toHaveLength(1);
      const result = await runStage("unit", "P1", { root });
      expect(result).toMatchObject({ category: "unit", stage: "P1", discoveredFiles: 1, discovered: 2, executed: 1, pass: 1, fail: 0, skip: 1, exitCode: 0 });
      writeFileSync(join(root, "tests/unit/p1.test.ts"), 'import {test,expect} from "bun:test"; test("failure",()=>expect(1).toBe(2));');
      const failed = await runStage("unit", "P1", { root });
      expect(failed).toMatchObject({ executed: 1, pass: 0, fail: 1, skip: 0 });
      expect(failed.exitCode).not.toBe(0);
      writeFileSync(join(root, "tests/unit/p1.test.ts"), 'import {test} from "bun:test"; test.skip("unverified",()=>{});');
      const skipped = await runStage("unit", "P1", { root });
      expect(skipped.executed).toBe(0);
      expect(skipped.exitCode).not.toBe(0);
      writeFileSync(join(root, "tests/unit/p1.test.ts"), 'import "./missing-module.ts";');
      const loadFailure = await runStage("unit", "P1", { root });
      expect(loadFailure).toMatchObject({ pass: 0, fail: 1, exitCode: 1 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20000);
});

const choice = { provider: "openai", modelId: "gpt-test", expectedConfigVersion: "1" };
const selection = {
  provider: "openai", modelId: "gpt-test", endpointRef: null, api: "openai-responses",
  configVersion: "1", credentialRef: null, maxOutputTokens: 4096,
  capabilitySource: "pi_catalog", sdkVersion: "0.87.1",
};
const policy = { timeoutMs: 120000, maxRetries: 0, maxRetryDelayMs: 2000 };
const ui = { navCollapsed: false, detailOpen: false, detailTab: "conditions" } as const;
const definition = {
  providerId: "custom-local", name: "Local", api: "openai-completions", baseUrl: "http://127.0.0.1:8080/v1",
  models: [{ id: "local", name: "Local model", input: ["text"], reasoning: false, contextWindow: 8192,
    maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }],
};
const request = { text: "  original text\n", model: choice, referenceDate: "2024-02-29", timezone: "Asia/Shanghai" };
const snapshot = {
  schemaVersion: "medclaw.settings/p1-v1", configVersion: "1", model: { provider: "openai", modelId: "gpt-test" },
  customProviders: [], credentialRefs: { openai: null }, requestPolicy: policy, ui,
};

describe("P1 model boundaries", () => {
  test("preserves native catalog output metadata while validating user declarations", async () => {
    const { ModelEntryViewSchema } = await import("../../packages/contracts/src/model");
    const native = { provider: "huggingface", id: "thinkingmachines/Inkling-Small", name: "Inkling", api: "openai-completions", input: ["text"], reasoning: false, contextWindow: 524288, maxTokens: 1048576, capabilitySource: "pi_catalog" };
    expect(ModelEntryViewSchema.safeParse(native).success).toBe(true);
    expect(ModelEntryViewSchema.safeParse({ ...native, capabilitySource: "user_declared" }).success).toBe(false);
  });
  test("keeps short and long user text while rejecting blank text and trusted fields", async () => {
    const { ProviderRequestSchema } = await import("../../packages/contracts/src/model");
    expect(ProviderRequestSchema.parse(request).text).toBe("  original text\n");
    expect(ProviderRequestSchema.safeParse({ ...request, text: " \n\t" }).success).toBe(false);
    const text = "长文本😀".repeat(9000);
    expect(ProviderRequestSchema.parse({ ...request, text }).text).toBe(text);
    for (const field of ["maxOutputTokens", "scope", "sdkVersion", "credentialRef", "usage", "sessionId"]) {
      expect(ProviderRequestSchema.safeParse({ ...request, [field]: 1 }).success).toBe(false);
      expect(ProviderRequestSchema.safeParse({ ...request, model: { ...choice, [field]: 1 } }).success).toBe(false);
    }
  });

  test("validates real dates, IANA zones, versions and positive safe identities", async () => {
    const { ProviderRequestSchema, ConfigVersionSchema } = await import("../../packages/contracts/src/model");
    for (const referenceDate of ["2023-02-29", "2024-04-31", "2024-2-29", "2024-00-01"]) {
      expect(ProviderRequestSchema.safeParse({ ...request, referenceDate }).success).toBe(false);
    }
    expect(ProviderRequestSchema.safeParse({ ...request, timezone: "Not/AZone" }).success).toBe(false);
    for (const priorRunId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(ProviderRequestSchema.safeParse({ ...request, priorRunId }).success).toBe(false);
    }
    for (const version of ["-1", "1.5", "01", "", "1e3"]) expect(ConfigVersionSchema.safeParse(version).success).toBe(false);
    expect(ConfigVersionSchema.parse("0")).toBe("0");
    expect(ConfigVersionSchema.parse("9007199254740993")).toBe("9007199254740993");
  });

  test("enforces policy bounds and the documented initialization defaults", async () => {
    const { RequestPolicySchema, DEFAULT_REQUEST_POLICY, DEFAULT_DISPLAY_PREFERENCES, SettingsSnapshotSchema } = await import("../../packages/contracts/src/model");
    expect(DEFAULT_REQUEST_POLICY).toEqual({ timeoutMs: 120000, maxRetries: 0, maxRetryDelayMs: 2000 });
    expect(DEFAULT_DISPLAY_PREFERENCES).toEqual(ui);
    for (const candidate of [
      { ...policy, timeoutMs: 999 }, { ...policy, timeoutMs: Number.MAX_SAFE_INTEGER + 1 }, { ...policy, timeoutMs: 1000.5 },
      { ...policy, maxRetries: 2 }, { ...policy, maxRetries: -1 }, { ...policy, maxRetryDelayMs: 0 },
      { ...policy, maxRetryDelayMs: 5001 }, { ...policy, maxRetryDelayMs: 1.5 }, { ...policy, extra: true },
    ]) expect(RequestPolicySchema.safeParse(candidate).success).toBe(false);
    expect(RequestPolicySchema.safeParse({ timeoutMs: 1000, maxRetries: 1, maxRetryDelayMs: 1 }).success).toBe(true);
    expect(RequestPolicySchema.safeParse({ timeoutMs: 300000, maxRetries: 0, maxRetryDelayMs: 5000 }).success).toBe(true);
    expect(RequestPolicySchema.safeParse({ ...policy, timeoutMs: 300001 }).success).toBe(true);
    const { ui: _ui, ...withoutUi } = snapshot;
    expect(SettingsSnapshotSchema.parse(withoutUi).ui).toEqual(ui);
  });

  test("rejects custom URL secrets and remote plaintext while allowing loopback", async () => {
    const { CustomProviderDefinitionSchema } = await import("../../packages/contracts/src/model");
    for (const baseUrl of ["https://user:key@example.com/v1", "https://example.com/v1?key=x", "https://example.com/v1?",
      "https://example.com/v1#", "http://example.com/v1", "file:///tmp/server", " https://example.com/v1"]) {
      expect(CustomProviderDefinitionSchema.safeParse({ ...definition, baseUrl }).success).toBe(false);
    }
    for (const baseUrl of ["https://example.com/v1", "http://localhost:8080", "http://127.0.0.2", "http://[::1]:8080/v1"]) {
      expect(CustomProviderDefinitionSchema.safeParse({ ...definition, baseUrl }).success).toBe(true);
    }
    expect(CustomProviderDefinitionSchema.safeParse({ ...definition, headers: { Authorization: "secret" } }).success).toBe(false);
  });

  test("requires confirmed integer output limits, text input, unique IDs and consistent pricing", async () => {
    const { CustomProviderDefinitionSchema, ModelSelectionSchema } = await import("../../packages/contracts/src/model");
    const model = definition.models[0]!;
    for (const maxTokens of [undefined, 0, -1, 1.5, 8193]) {
      expect(CustomProviderDefinitionSchema.safeParse({ ...definition, models: [{ ...model, maxTokens }] }).success).toBe(false);
    }
    for (const changed of [{ ...model, outputLimitConfirmed: false }, { ...model, input: ["image"] },
      { ...model, pricingKnown: true, cost: null }, { ...model, pricingKnown: false, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }]) {
      expect(CustomProviderDefinitionSchema.safeParse({ ...definition, models: [changed] }).success).toBe(false);
    }
    expect(CustomProviderDefinitionSchema.safeParse({ ...definition, models: [model, model] }).success).toBe(false);
    expect(CustomProviderDefinitionSchema.safeParse({ ...definition, models: [{ ...model, pricingKnown: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] }).success).toBe(true);
    expect(ModelSelectionSchema.safeParse({ ...selection, maxOutputTokens: 0 }).success).toBe(false);
    expect(ModelSelectionSchema.safeParse({ ...selection, sdkVersion: "0.88.0" }).success).toBe(false);
  });

  test("settings retain credential references and only one previous snapshot", async () => {
    const { PublishedSettingsSchema } = await import("../../packages/contracts/src/model");
    expect(PublishedSettingsSchema.parse({ ...snapshot, previous: snapshot, rollbackFromVersion: "0" }).previous?.credentialRefs).toEqual({ openai: null });
    expect(PublishedSettingsSchema.safeParse({ ...snapshot, previous: { ...snapshot, previous: snapshot }, rollbackFromVersion: null }).success).toBe(false);
    expect(PublishedSettingsSchema.safeParse({ ...snapshot, credentialRefs: { openai: { key: "secret" } }, previous: null, rollbackFromVersion: null }).success).toBe(false);
  });

  test("auth prompt types carry only the relevant bounded safe view", async () => {
    const { AuthPromptViewSchema, AuthStatusViewSchema } = await import("../../packages/contracts/src/model");
    const prompt = { authAttemptId: "auth-1", promptId: "prompt-1", type: "select", message: "Choose", secret: false,
      options: [{ id: "one", label: "One" }] };
    expect(AuthPromptViewSchema.safeParse(prompt).success).toBe(true);
    expect(AuthPromptViewSchema.safeParse({ ...prompt, secret: true }).success).toBe(false);
    expect(AuthPromptViewSchema.safeParse({ ...prompt, options: [] }).success).toBe(false);
    expect(AuthPromptViewSchema.safeParse({ ...prompt, signal: {} }).success).toBe(false);
    expect(AuthStatusViewSchema.safeParse({ providerId: "openai", state: "available", type: "api_key", source: "OPENAI_API_KEY",
      checkKind: "snapshot", checkedAt: "2026-09-30T00:00:00.000Z", key: "secret" }).success).toBe(false);
  });
});

describe("P3 runtime policy contracts", () => {
  test("accepts configurable safe budgets and defaults legacy Settings without widening UI writes", async () => {
    const { AgentPolicySchema, DEFAULT_AGENT_POLICY, SettingsSnapshotSchema } = await import("../../packages/contracts/src/model");
    const { parsePublicPayload, publicMethodSchemas } = await import("../../packages/contracts/src/protocol");
    expect(DEFAULT_AGENT_POLICY).toEqual({ version: "medclaw.agent-policy/v1", maxToolCalls: 24, maxModelCalls: 12, singleToolTimeoutMs: 30000, maxRecoveryAttempts: 2 });
    expect(SettingsSnapshotSchema.parse(snapshot).agentPolicy).toEqual(DEFAULT_AGENT_POLICY);
    const configured = { ...DEFAULT_AGENT_POLICY, maxToolCalls: 501, maxModelCalls: 101, singleToolTimeoutMs: 600001, maxRecoveryAttempts: 0 };
    expect(AgentPolicySchema.parse(configured)).toEqual(configured);
    for (const patch of [{ maxToolCalls: 0 }, { maxModelCalls: 1.5 }, { singleToolTimeoutMs: Number.MAX_SAFE_INTEGER + 1 }, { maxRecoveryAttempts: -1 }, { maxRecoveryAttempts: 0.5 }, { extra: true }]) {
      expect(AgentPolicySchema.safeParse({ ...configured, ...patch }).success).toBe(false);
    }
    expect(parsePublicPayload("model.policy.update", { expectedConfigVersion: "1", policy, agentPolicy: configured })).toHaveProperty("agentPolicy", configured);
    expect(parsePublicPayload("model.policy.update", { expectedConfigVersion: "1", policy })).not.toHaveProperty("agentPolicy");
    expect(() => parsePublicPayload("settings.ui.update", { expectedConfigVersion: "1", patch: { agentPolicy: configured } })).toThrow();
    expect(publicMethodSchemas["model.config.read"].output.safeParse({ configVersion: "1", previousConfigVersion: null, rollbackFromVersion: null, policy, agentPolicy: configured }).success).toBe(true);
  });

  test("keeps unknown control facts explicit and stage errors safe", async () => {
    const { createToolControlObservation, ToolControlObservationSchema } = await import("../../packages/contracts/src/model");
    const { safeError } = await import("../../packages/contracts/src/error");
    const control = createToolControlObservation();
    expect(Object.keys(control)).toHaveLength(25);
    expect(control).toMatchObject({ admission: { status: "not_reached", reason: null }, inputValidation: "not_reached", businessValidation: { pre: "not_reached", post: "not_reached" }, latencyObservation: "missing", executionElapsedMs: null, repairOfToolCallId: null });
    expect(ToolControlObservationSchema.safeParse({ ...control, postflightStatus: "succeeded" }).success).toBe(false);
    expect(ToolControlObservationSchema.safeParse({ ...control, executionElapsedMs: -1 }).success).toBe(false);
    expect(ToolControlObservationSchema.safeParse({ ...control, validationIssues: [{ code: "mismatch", stage: "output", fieldPath: ["id"], rawError: "secret" }] }).success).toBe(false);
    for (const code of ["tool_call_limit", "tool_timeout", "tool_output_inconsistent", "tool_recovery_limit", "tool_postprocess_failed"]) {
      expect(safeError(code, new Error("secret-provider-body"))).toMatchObject({ code });
      expect(safeError(code).message).not.toContain("secret");
    }
  });
});

describe("P1 read and usage boundaries", () => {
  test("run read branches are exclusive and integer pagination stays bounded", async () => {
    const { ReadRunRequestSchema } = await import("../../packages/contracts/src/run");
    expect(ReadRunRequestSchema.parse({ runId: 1 })).toEqual({ runId: 1, outputOffset: 0, outputLimit: 16384, inputOffset: 0, inputLimit: 65536, callOffset: 0, callLimit: 20 });
    expect(ReadRunRequestSchema.parse({ recent: true })).toEqual({ recent: true, limit: 20 });
    for (const invalid of [{ runId: 1, operationRef: "op-1" }, { recent: true, runId: 1 }, { runId: 0 },
      { runId: 1, outputOffset: -1 }, { runId: 1, outputOffset: 0.5 }, { runId: 1, outputLimit: 32769 },
      { runId: 1, outputLimit: 0 }, { recent: true, limit: 51 }, { recent: true, limit: 1.5 }, { recent: true, beforeRunId: 0 }]) {
      expect(ReadRunRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  test("normalized all-zero or absent SDK usage stays unavailable", async () => {
    const { safeUsage } = await import("../../packages/contracts/src/run");
    expect(safeUsage({ input: 0, output: 0, cost: { total: 0 } }, true)).toEqual({ inputTokens: null, outputTokens: null,
      cost: null, costCurrency: null, source: "pi_normalized", unavailableReason: "pi_normalized_zero_or_missing" });
    expect(safeUsage(undefined, true).inputTokens).toBeNull();
    expect(safeUsage({ input: 4, output: 2, cost: { total: 0.01 }, key: "secret" }, true)).toEqual({ inputTokens: 4, outputTokens: 2,
      cost: 0.01, costCurrency: "USD", source: "pi_normalized", unavailableReason: null });
    expect(safeUsage({ input: 4, output: 0, cost: { total: 0 } }, false)).toMatchObject({ inputTokens: 4, outputTokens: null, cost: null, costCurrency: null });
  });

  test("output slices preserve surrogate pairs and preview truncation is explicit", async () => {
    const { sliceOutput, safePreview } = await import("../../packages/contracts/src/run");
    const text = "A😀B";
    expect(sliceOutput(text, 0, 2)).toEqual({ text: "A", offset: 0, nextOffset: 1, totalChars: 4 });
    expect(sliceOutput(text, 1, 1)).toEqual({ text: "😀", offset: 1, nextOffset: 3, totalChars: 4 });
    expect(() => sliceOutput(text, 2, 2)).toThrow();
    expect(safePreview("a".repeat(32767) + "😀")).toEqual({ text: "a".repeat(32767), truncated: true });
  });
});

describe("P1 public and private protocol", () => {
  test("public dispatch retains P1 methods and the current Session management whitelist", async () => {
    const { publicMethodSchemas, parsePublicPayload } = await import("../../packages/contracts/src/protocol");
    expect(Object.keys(publicMethodSchemas).sort()).toEqual([
      "model.list", "model.read", "model.refresh", "operation.cancel", "model.auth.start", "model.auth.respond",
      "model.auth.cancel", "model.auth.status", "model.custom.read", "model.custom.save", "model.configure", "model.policy.update",
      "model.config.read", "model.config.rollback", "model.request", "model.diagnose", "run.active", "run.read", "run.cancel", "run.retrySave",
      "session.create", "session.select", "session.list", "session.read", "session.messages.read", "session.submit", "session.readSubmission", "session.readInput", "session.listInputs", "session.cancelInput", "workspace.read", "workspace.restore", "run.control.read",
      "session.rename", "session.delete", "session.readManagementOperation",
      "session.checkpoints.read", "session.restoreCheckpoint", "session.restore",
      "session.compact", "session.compaction.read", "session.compaction.cancel",
      "settings.ui.read", "settings.ui.update", "diagnostics.read", "host.read", "host.start", "host.stop", "host.restart",
      "data.delete.preview", "data.delete.commit", "data.delete.read", "data.delete.recover", "workspace.update", "data.read", "data.rows", "query.execute", "query.read", "query.list", "evidence.read", "tool.read",
      "import.preview", "import.commit", "import.read", "import.cancel", "import.recover", "evidence.readOperation", "evidence.readArtifact",
      "event.read", "event.subscribe", "context.read",
      "resources.list", "resources.select", "resources.read",
    ].sort());
    for (const method of ["credential.read", "credential.modify.begin", "file.resolve", "settings.prepare", "host.shutdown", "diagnostics.export", "executeShell", "__proto__"]) {
      expect(() => parsePublicPayload(method, {})).toThrow();
    }
    expect(() => parsePublicPayload("run.retrySave", { runId: 1, outputText: "forged", usage: {} })).toThrow();
    expect(() => parsePublicPayload("settings.ui.update", { expectedConfigVersion: "1", patch: {} })).toThrow();
    expect(() => parsePublicPayload("settings.ui.update", { expectedConfigVersion: "1", patch: { model: choice } })).toThrow();
    expect(() => parsePublicPayload("model.custom.save", { definition, expectedConfigVersion: "1", key: "secret" })).toThrow();
    expect(parsePublicPayload("model.custom.save", { definition, expectedConfigVersion: "1", credentialInput: "secret-token-1" })).toHaveProperty("credentialInput", "secret-token-1");
  });

  test("typed host frames validate protocol, caller identity and method payload", async () => {
    const { HostRequestSchema, parseHostFrame } = await import("../../packages/contracts/src/protocol");
    const frame = { protocolVersion: HOST_PROTOCOL_VERSION, kind: "request", requestId: "req-1", instanceId: "instance-1",
      operationRef: "op-1", method: "model.request", payload: request };
    expect(HostRequestSchema.safeParse(frame).success).toBe(true);
    expect(HostRequestSchema.safeParse({ ...frame, protocolVersion: "medclaw.host/p2" }).success).toBe(false);
    expect(HostRequestSchema.safeParse({ ...frame, method: "model.configure", payload: { ...choice, maxOutputTokens: 1 } }).success).toBe(false);
    expect(() => parseHostFrame(JSON.stringify(frame), "other-instance")).toThrow();
    expect(() => parseHostFrame("{not-json", "instance-1")).toThrow();
    expect(() => parseHostFrame(JSON.stringify({ ...frame, raw: "secret" }), "instance-1")).toThrow();
  });

  test("JSONL frame cap counts UTF-8 bytes and notices forbid future event sequence", async () => {
    const { encodeHostFrame, parseHostFrame, NoticeFrameSchema, MAX_FRAME_BYTES } = await import("../../packages/contracts/src/protocol");
    const notice = { protocolVersion: HOST_PROTOCOL_VERSION, kind: "notice", instanceId: "instance-1",
      notice: { type: "provider.preview", runId: 1, text: "hi", truncated: false } } as const;
    expect(encodeHostFrame(notice).endsWith("\n")).toBe(true);
    expect(parseHostFrame(encodeHostFrame(notice), "instance-1")).toEqual(notice);
    expect(NoticeFrameSchema.safeParse({ ...notice, sequence: 1 }).success).toBe(false);
    expect(NoticeFrameSchema.safeParse({ ...notice, notice: { ...notice.notice, text: "a".repeat(32769) } }).success).toBe(false);
    expect(MAX_FRAME_BYTES).toBe(4194304);
    expect(() => parseHostFrame('"' + "中".repeat(1398102) + '"', "instance-1")).toThrow();
  });

  test("private credential leases require typed bodies and never enter public dispatch", async () => {
    const { PrivateCredentialFrameSchema, privateCredentialMethodSchemas, DesktopSecretInputSchema } = await import("../../packages/contracts/src/protocol");
    const base = { protocolVersion: HOST_PROTOCOL_VERSION, kind: "private", instanceId: "instance-1", requestId: "req-1", secret: true };
    expect(PrivateCredentialFrameSchema.safeParse({ ...base, method: "credential.modify.begin", payload: {
      providerId: "openai", context: { purpose: "auth", operationRef: "op-1", authAttemptId: "auth-1" }, operationId: "modify-1", expectedCredentialRef: null,
    } }).success).toBe(true);
    expect(PrivateCredentialFrameSchema.safeParse({ ...base, secret: false, method: "credential.list", payload: {} }).success).toBe(false);
    const commit = privateCredentialMethodSchemas["credential.modify.commit"].input;
    expect(commit.safeParse({ leaseId: "lease-1", expectedVersion: "1", changed: true }).success).toBe(false);
    expect(commit.safeParse({ leaseId: "lease-1", expectedVersion: "1", changed: false, next: { type: "api_key", key: "secret" } }).success).toBe(false);
    expect(commit.safeParse({ leaseId: "lease-1", expectedVersion: "1", changed: true, next: { type: "api_key", key: "secret" } }).success).toBe(true);
    expect(DesktopSecretInputSchema.safeParse({ providerId: "custom-local", purpose: "custom_api_key", value: "new-secret" }).success).toBe(true);
    expect(DesktopSecretInputSchema.safeParse({ providerId: "custom-local", purpose: "read_stored", credentialRef: "ref-1" }).success).toBe(false);
  });

  test("private hello paths and SDK/schema handshake versions are strict", async () => {
    const { HostHelloSchema, HostReadySchema } = await import("../../packages/contracts/src/protocol");
    const hello = { protocolVersion: HOST_PROTOCOL_VERSION, instanceId: "instance-1", startupToken: "startup-token-1", sdkVersion: "0.87.1", expectedSchemaVersion: DATABASE_SCHEMA_VERSION,
      paths: { dataRoot: "D:/isolated", databasePath: "D:/isolated/data/app.sqlite", settingsPath: "D:/isolated/data/settings.json",
        cachePath: "D:/isolated/data/pi-model-cache.json", lockPath: "D:/isolated/runtime/host.lock" } };
    expect(HostHelloSchema.safeParse(hello).success).toBe(true);
    expect(HostHelloSchema.safeParse({ ...hello, paths: { ...hello.paths, databasePath: "relative/app.sqlite" } }).success).toBe(false);
    expect(HostHelloSchema.safeParse({ ...hello, sdkVersion: "0.87.0" }).success).toBe(false);
    expect(HostReadySchema.safeParse({ protocolVersion: HOST_PROTOCOL_VERSION, instanceId: "instance-1", sdkVersion: "0.87.1", schemaVersion: 1, configVersion: "1", dataRoot: "D:/isolated" }).success).toBe(false);
  });
});

describe("P1 safe errors", () => {
  test("keeps refresh, authentication and save failures as explicit product errors", async () => {
    const { safeError } = await import("../../packages/contracts/src/error");
    for (const code of ["provider_refresh_failed", "preview_delivery_failed", "auth_method_unsupported", "run_save_unavailable", "auth_failed"]) {
      expect(safeError(code, new Error("SECRET")).code).toBe(code);
    }
  });

  test("maps arbitrary SDK error message/body/cause to fixed product text", async () => {
    const { safeError, AppErrorSchema } = await import("../../packages/contracts/src/error");
    const native = Object.assign(new Error("SENTINEL-SECRET"), { body: { key: "SENTINEL-SECRET" }, cause: { credential: "SENTINEL-SECRET" } });
    const error = safeError("provider_request_failed", native, { operationRef: "op-1", runId: 1 });
    expect(error).toMatchObject({ code: "provider_request_failed", category: "provider", operationRef: "op-1", runId: 1 });
    expect(JSON.stringify(error)).not.toContain("SENTINEL-SECRET");
    expect(AppErrorSchema.safeParse({ ...error, details: native }).success).toBe(false);
    expect(AppErrorSchema.safeParse({ ...error, requestId: "req-1" }).success).toBe(false);
    expect(AppErrorSchema.safeParse({ ...error, category: "tool", reason: "workspace_revision_mismatch", sessionId: 1, toolCallId: 1 }).success).toBe(true);
  });
});

test("private settings preparation validates the complete published candidate", async () => {
  const { hostPrivateMethodSchemas } = await import("../../packages/contracts/src/protocol");
  expect(hostPrivateMethodSchemas["settings.prepare"].input.safeParse({ token: "prepare-1", candidate: {
    ...snapshot, previous: snapshot, rollbackFromVersion: null,
  } }).success).toBe(true);
  expect(hostPrivateMethodSchemas["settings.prepare"].input.safeParse({ token: "prepare-1", candidate: snapshot }).success).toBe(false);
});

describe("P1 bounded safe diagnostics", () => {
  test("logs reconstruct product errors and suppress arbitrary runtime/stderr content", async () => {
    const { ErrorLog } = await import("../../packages/logging/src/error-log");
    const { RuntimeLog } = await import("../../packages/logging/src/runtime-log");
    const errors = new ErrorLog("host");
    for (let index = 0; index < 51; index++) errors.add({ code: "provider_request_failed", message: "CANARY-SECRET", cause: "CANARY-SECRET" }, { runId: index + 1 });
    expect(errors.read()).toHaveLength(50);
    expect(errors.read()[0]?.runId).toBe(2);
    const runtime = new RuntimeLog("main");
    for (let index = 0; index < 201; index++) runtime.add("host_ready", { instanceId: `instance-${index}` });
    expect(runtime.read()).toHaveLength(200);
    runtime.add("CANARY-SECRET SDK body");
    for (let index = 0; index < 200; index++) runtime.addStderr("CANARY-SECRET token=abc");
    expect(runtime.stderrTail().length).toBeLessThanOrEqual(6000);
    expect(JSON.stringify([errors.read(), runtime.read(), runtime.stderrTail()])).not.toContain("CANARY-SECRET");
  });

  test("prompt traces bound per-run entries and retain only twenty completed runs", async () => {
    const { PromptTrace } = await import("../../packages/logging/src/prompt-trace");
    const traces = new PromptTrace("host");
    for (let runId = 1; runId <= 22; runId++) {
      for (let item = 0; item < 201; item++) traces.add(runId, "call_started", { inputChars: 5 });
      traces.finish(runId);
    }
    traces.add(23, "CANARY-SECRET prompt");
    expect(traces.runRead(1)).toEqual([]);
    expect(traces.runRead(3)).toHaveLength(200);
    expect(new Set(traces.read().map(entry => entry.runId)).size).toBe(21);
    expect(JSON.stringify(traces.read())).not.toContain("CANARY-SECRET");
  });

  test("partial diagnostics default to safe operational entries without prompt traces", async () => {
    const { composeDiagnostics } = await import("../../packages/logging/src/diagnostics");
    const host = { instanceId: null, state: "stopped" as const, canStart: true, sdkVersion: null, schemaVersion: null, error: null };
    const versions = { sdkVersion: "0.87.1" as const, protocolVersion: HOST_PROTOCOL_VERSION, schemaVersion: null, configVersion: "1", bunVersion: null, electronVersion: "44.5.1" };
    const at = "2026-09-30T00:00:00.000Z";
    const result = composeDiagnostics({ host, versions, hostAvailable: false, mainEntries: [
      { category: "runtime", source: "main", at, message: "Host 已就绪" },
      { category: "prompt_trace", source: "main", at, message: "调用阶段" },
    ] });
    expect(result.partial).toBe(true);
    expect(result.missingSources).toEqual(["host"]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.category).toBe("runtime");
  });
});
