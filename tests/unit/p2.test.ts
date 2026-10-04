import { describe, expect, test } from "bun:test";
import { parsePublicPayload, publicMethodSchemas, HostRequestSchema, NoticeFrameSchema, HOST_PROTOCOL_VERSION } from "../../packages/contracts/src/protocol";
import { ReadRunRequestSchema, RunViewSchema } from "../../packages/contracts/src/run";
import { safeError, type AppError } from "../../packages/contracts/src/error";
import { RuntimeLog, safeStageMessage } from "../../packages/logging/src/runtime-log";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Session title presentation preserves canonical public titles including user names matching legacy defaults", async () => {
  const helpers = await import("../../apps/desktop/src/renderer/session-list");
  expect(helpers).toHaveProperty("sessionDisplayTitle");
  for (const [id, title, display] of [[7, "New Session 7", "New Session 7"], [7, "新会话 7", "新会话 7"], [7, "新会话 8", "新会话 8"],
    [7, "新会话 07", "新会话 07"], [7, "新会话 7 自定义😀", "新会话 7 自定义😀"], [7, "我的会话😀", "我的会话😀"]] as const) {
    const session = Object.freeze({ id, title });
    expect(helpers.sessionDisplayTitle(session)).toBe(display);
    expect(session).toEqual({ id, title });
  }
});

test("safe English error projection preserves legacy facts and reason mappings", async () => {
  const helpers = await import("../../packages/contracts/src/error");
  expect(helpers).toHaveProperty("errorMessage");
  for (const [code, reason, display] of [
    ["state_conflict", "runtime_busy", "An operation is still running. Wait or stop it before trying again."],
    ["state_conflict", "workspace_revision_mismatch", "The current view has changed. Read it again before selecting."],
    ["input_invalid", "session_not_found", "Session not found."],
    ["run_timeout", undefined, "The model request exceeded the runtime limit."],
    ["future_error", undefined, "Operation failed. Check diagnostics."],
  ] as const) {
    const legacy: AppError = { code, category: "runtime", message: "旧错误😀 CANARY-SECRET", retryable: false,
      operationRef: "original-op", runId: 3, sessionId: 7, toolCallId: 11, ...(reason ? { reason } : {}) };
    const before = structuredClone(legacy);
    expect(helpers.errorMessage(Object.freeze(legacy))).toBe(display);
    expect(legacy).toEqual(before);
  }
  expect(safeError("tool_cancelled", new Error("CANARY-SECRET"), { toolCallId: 11 })).toEqual({
    code: "tool_cancelled", category: "tool", message: "The tool call was cancelled. Committed query facts remain available under their original identity.", retryable: false, toolCallId: 11,
  });
});

test("safe diagnostics use English summaries and suppress native stderr", () => {
  expect(safeStageMessage("run_saved", { inputChars: 12, outputChars: 4 })).toBe("Run facts saved inputChars=12 outputChars=4");
  expect(safeStageMessage("CANARY-SECRET", { inputChars: -1 })).toBe("Diagnostic content omitted");
  const log = new RuntimeLog();
  log.addStderr("CANARY-SECRET token=abc");
  log.addStderr("run_timeout");
  expect(log.stderrTail()).toBe("Host diagnostic output omitted (23 characters)\nThe model request exceeded the runtime limit.\n");
  expect(log.read().every(entry => entry.message === "Host failure")).toBe(true);
  expect(JSON.stringify(log.read())).not.toContain("CANARY-SECRET");
});

test.each(["P2", "P4"])("%s runner discovers only its stage and rejects empty, skipped, failed and loading-error runs", async (stage) => {
  const { discoverTests, runStage } = await import("../run");
  const root = mkdtempSync(join(tmpdir(), "medclaw-stage-runner-"));
  const prefix = stage.toLowerCase();
  try {
    expect(discoverTests("unit", stage, root)).toEqual([]);
    expect(await runStage("unit", stage, { root })).toMatchObject({ discovered: 0, executed: 0, exitCode: 1 });
    mkdirSync(join(root, "tests/unit"), { recursive: true });
    mkdirSync(join(root, "tests/e2e"), { recursive: true });
    writeFileSync(join(root, "tests/unit/p1.test.ts"), 'throw new Error("must not execute P1");');
    writeFileSync(join(root, `tests/unit/${prefix}.spec.ts`), 'throw new Error("wrong category suffix");');
    writeFileSync(join(root, `tests/e2e/${prefix}.spec.ts`), "");
    const file = join(root, `tests/unit/${prefix}-extra.test.ts`);
    writeFileSync(file, 'import {test,expect} from "bun:test"; test("stage is consumed by project runner",()=>expect(Bun.argv.includes("--stage")).toBe(false)); test.skip("explicit skip",()=>{});');
    expect(discoverTests("unit", stage, root)).toEqual([file]);
    expect(discoverTests("e2e", stage, root)).toHaveLength(1);
    expect(await runStage("unit", stage, { root })).toMatchObject({ stage, discoveredFiles: 1, discovered: 2, executed: 1, pass: 1, fail: 0, skip: 1, exitCode: 0 });
    for (const [source, expected] of [
      ['import {test} from "bun:test"; test.skip("unverified",()=>{});', { executed: 0, pass: 0, skip: 1, exitCode: 1 }],
      ['import {test,expect} from "bun:test"; test("failure",()=>expect(1).toBe(2));', { executed: 1, fail: 1, exitCode: 1 }],
      ['import "./missing-module.ts";', { pass: 0, fail: 1, exitCode: 1 }],
      ["", { executed: 0, exitCode: 1 }],
    ] as const) {
      writeFileSync(file, source);
      expect(await runStage("unit", stage, { root })).toMatchObject(expected);
    }
    for (const args of [["unit"], ["unit", "--stage", "P99"], ["unit", "--stage", stage, "--extra"], ["invalid", "--stage", stage]]) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../run.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).not.toBe(0);
      expect(await new Response(child.stderr).text()).toMatch(/Unknown|Usage/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20000);

test("late model callback keeps its captured Session and rejects an old Host or directory", async () => {
  const helpers = await import("../../apps/desktop/src/renderer/session-list");
  expect(helpers).toHaveProperty("selectSessionModelDraft");
  const context = { instanceId: "host-1", configVersion: "1", session: { id: 1, title: "A", nativeSessionId: "native-a", kind: "user" as const, status: "active" as const, metadataRevision: 0, deletedAt: null, inputControl: null, storageVersion: 0 as const, leafId: null, nextSubmissionSequence: 1 } };
  const dataDefaults = { batchCount: 2, referenceDate: "2026-01-02", timezone: "Asia/Shanghai" };
  const original = helpers.newSessionDraft({ provider: "fixture", modelId: "first", expectedConfigVersion: "1" }, dataDefaults), choice = { provider: "fixture", modelId: "second", expectedConfigVersion: "1" };
  expect(original).toMatchObject({ referenceDate: "2026-01-02", timezone: "Asia/Shanghai" });
  expect(helpers.newSessionDraft(null, { batchCount: 2, referenceDate: null, timezone: null })).toMatchObject({ referenceDate: "", timezone: "" });
  expect(helpers.newSessionDraft(null, { batchCount: 0, referenceDate: null, timezone: null })).toMatchObject({ referenceDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), timezone: expect.any(String) });
  expect(helpers.selectSessionModelDraft({ ...original, referenceDate: "2026-01-01" }, context, { instanceId: "host-1", sessionId: 1 }, choice)).toMatchObject({ referenceDate: "2026-01-01", timezone: "Asia/Shanghai" });
  expect(helpers.selectSessionModelDraft(original, context, { instanceId: "host-1", sessionId: 1 }, choice)?.model).toEqual(choice);
  expect(original.model?.modelId).toBe("first");
  expect(helpers.selectSessionModelDraft(original, context, { instanceId: "old-host", sessionId: 1 }, choice)).toBeNull();
  expect(helpers.selectSessionModelDraft(original, context, { instanceId: "host-1", sessionId: 2 }, choice)).toBeNull();
  expect(helpers.selectSessionModelDraft(original, context, { instanceId: "host-1", sessionId: 1 }, { ...choice, expectedConfigVersion: "0" })).toBeNull();
});

test("accepted original reply cannot clear a newer pending identity or edited draft", async () => {
  const helpers = await import("../../apps/desktop/src/renderer/session-list");
  expect(helpers).toHaveProperty("acceptSubmissionDraft");
  const old = { operationRef: "first", input: submit }, newer = { operationRef: "second", input: { ...submit, clientSequence: 2 } };
  const draft = { ...helpers.newSessionDraft(choice), text: submit.text, pending: newer };
  expect(helpers.acceptSubmissionDraft(draft, old)).toBe(draft);
  expect(helpers.acceptSubmissionDraft({ ...draft, pending: old }, old)).toMatchObject({ text: "", pending: null, model: choice });
  expect(helpers.acceptSubmissionDraft({ ...draft, text: "edited while waiting", pending: old }, old)).toMatchObject({ text: "edited while waiting", pending: null });
});

const choice = { provider: "openai", modelId: "gpt-test", expectedConfigVersion: "1" };
const submit = { sessionId: 1, clientSequence: 1, text: "  保留原输入😀\n", mode: "send" as const, expectedRevision: 0,
  expectedBatchIds: [] as [], expectedQueryId: null, model: choice, referenceDate: "2026-01-01", timezone: "Asia/Shanghai" };
const cleanup = { contract: "medclaw.run-cleanup/v1", executionStarted: true, stopConfirmed: null,
  requiredPersistenceComplete: false, inputsSettled: true, resourcesReleased: false,
  unconfirmedItems: ["stop", "persistence", "resources"], secondaryErrors: [], verifiedAt: null };
const selection = { provider: "openai", modelId: "gpt-test", endpointRef: null, api: "openai-responses", configVersion: "1",
  credentialRef: null, maxOutputTokens: 4096, capabilitySource: "pi_catalog", sdkVersion: "0.87.1" };
const run = { id: 1, kind: "provider", status: "failed", operationRef: "op-1", instanceId: "host-1", sessionId: null, inputId: null,
  goal: "answer", inputText: "hello", inputPage: { text: "hello", offset: 0, nextOffset: null, totalChars: 5 }, model: selection,
  policy: { timeoutMs: 120000, maxRetries: 0, maxRetryDelayMs: 2000 }, priorRunId: null, referenceDate: "2026-01-01", timezone: "Asia/Shanghai",
  createdAt: "2026-10-01T00:00:00.000Z", startedAt: null, cancelRequestedAt: null, stoppedAt: null, endedAt: null,
  error: null, cleanup, answerRef: null, output: { text: "", offset: 0, nextOffset: null, totalChars: 0 }, calls: [], persistence: "committed" };
function method(name: string) {
  const schema = Object.entries(publicMethodSchemas).find(([key]) => key === name)?.[1];
  expect(schema).toBeDefined();
  if (!schema) throw new Error(`Missing P2 public method ${name}`);
  return schema;
}

describe("P2 session and trust contracts", () => {
  test("ordinary Send retains original text and exposes only P2 fields", () => {
    expect(() => parsePublicPayload("session.submit", submit)).not.toThrow();
    expect(parsePublicPayload("session.submit", submit)).toEqual(submit);
    const long = { ...submit, text: "医疗器械😀".repeat(10000) };
    expect(parsePublicPayload("session.submit", long)).toHaveProperty("text", long.text);
  });
  test("Send rejects queues, invalid selected references, unsafe identities and forged runtime fields", () => {
    const schema = method("session.submit").input;
    for (const patch of [{ mode: "steer" }, { mode: "follow_up" }, { expectedBatchIds: [0] }, { expectedQueryId: 0 },
      { sessionId: 0 }, { clientSequence: Number.MAX_SAFE_INTEGER + 1 }, { clientSequence: 0 }, { expectedRevision: -1 },
      { text: " \n" }, { scope: {} }, { inputId: 1 }, { credentialRef: "forged" }, { maxOutputTokens: 1 },
      { referenceDate: "2026-02-30" }, { timezone: "Not/AZone" }]) expect(schema.safeParse({ ...submit, ...patch }).success).toBe(false);
  });
  test("create normalizes selectOnCreate true and requires a confirmed revision", () => {
    expect(parsePublicPayload("session.create", { expectedWorkspaceRevision: 0 })).toEqual({ selectOnCreate: true, expectedWorkspaceRevision: 0 });
    for (const input of [{}, { selectOnCreate: false, expectedWorkspaceRevision: null }, { expectedWorkspaceRevision: -1 },
      { expectedWorkspaceRevision: 0, nativeSessionId: "forged" }]) expect(method("session.create").input.safeParse(input).success).toBe(false);
  });
  test("session reads, selection and list paging are bounded and exclusive", () => {
    expect(parsePublicPayload("session.select", { sessionId: 1, expectedWorkspaceRevision: 0 })).toEqual({ sessionId: 1, expectedWorkspaceRevision: 0 });
    expect(parsePublicPayload("session.list", {})).toEqual({ limit: 20 });
    expect(parsePublicPayload("session.readSubmission", { sessionId: 1, clientSequence: 1 })).toEqual({ sessionId: 1, clientSequence: 1 });
    for (const input of [{ limit: 51 }, { beforeSessionId: 0 }, { limit: 1.5 }]) expect(method("session.list").input.safeParse(input).success).toBe(false);
    for (const name of ["session.checkpoints.read", "session.restoreCheckpoint", "session.cancelInput", "session.submitChannel", "event.read", "credential.read"])
      expect(() => parsePublicPayload(name, {})).toThrow();
  });
  test("P2 frames authenticate method and instance without accepting future execution fields", () => {
    const frame = { protocolVersion: HOST_PROTOCOL_VERSION, kind: "request", requestId: "request-1", instanceId: "host-1",
      operationRef: "operation-1", method: "session.submit", payload: submit };
    expect(HostRequestSchema.safeParse(frame).success).toBe(true);
    expect(HostRequestSchema.safeParse({ ...frame, protocolVersion: "medclaw.host/p1-v1" }).success).toBe(false);
    expect(HostRequestSchema.safeParse({ ...frame, payload: { ...submit, runId: 1 } }).success).toBe(false);
  });
});

describe("P2 run/control and temporary projection contracts", () => {
  test("terminal Run facts allow incomplete cleanup without pretending a stopped execution", () => {
    expect(RunViewSchema.safeParse(run).success).toBe(true);
    expect(RunViewSchema.safeParse({ ...run, cleanup: { ...cleanup, stopConfirmed: false } }).success).toBe(true);
    expect(RunViewSchema.safeParse({ ...run, cleanup: { ...cleanup, stopConfirmed: true, verifiedAt: "2026-10-01T00:00:01.000Z" } }).success).toBe(true);
    for (const bad of [{ ...cleanup, stopConfirmed: "unknown" }, { ...cleanup, unconfirmedItems: Array(33).fill("stop") },
      { ...cleanup, unexpected: true }]) expect(RunViewSchema.safeParse({ ...run, cleanup: bad }).success).toBe(false);
  });
  test("active-empty control can explicitly block admission", () => {
    const control = { instanceId: "host-1", activeRootRun: null, acceptingNewRuns: false, blockReasons: [] };
    expect(method("run.control.read").output.safeParse(control).success).toBe(true);
    expect(method("run.control.read").output.safeParse({ ...control, acceptingNewRuns: null }).success).toBe(false);
    expect(method("run.control.read").input.safeParse({ repair: true }).success).toBe(false);
  });
  test("Agent Run requires the original Session/submission/native identities", () => {
    const agent = { ...run, kind: "agent", sessionId: 1, clientSequence: 1, nativeSessionId: "native-1", nextCallOffset: null };
    expect(RunViewSchema.safeParse(agent).success).toBe(true);
    expect(RunViewSchema.safeParse({ ...agent, sessionId: null }).success).toBe(false);
    expect(RunViewSchema.safeParse({ ...agent, clientSequence: 0 }).success).toBe(false);
    expect(RunViewSchema.safeParse({ ...agent, answerRef: { answerId: 1, nativeLeafId: "invented" } }).success).toBe(false);
  });
  test("one/recent reads bound input and call pages independently of actual Send text", () => {
    expect(ReadRunRequestSchema.parse({ runId: 1 })).toMatchObject({ inputOffset: 0, inputLimit: 65536, callOffset: 0, callLimit: 20 });
    expect(ReadRunRequestSchema.safeParse({ runId: 1, inputLimit: 65537 }).success).toBe(false);
    expect(ReadRunRequestSchema.safeParse({ runId: 1, callLimit: 51 }).success).toBe(false);
    expect(ReadRunRequestSchema.safeParse({ recent: true, sessionId: 1, kind: "agent" }).success).toBe(true);
  });
  test("Agent snapshots carry local sequence and original session/run; no durable event disguise", () => {
    const frame = { protocolVersion: HOST_PROTOCOL_VERSION, kind: "notice", instanceId: "host-1",
      notice: { type: "agent.preview", sessionId: 1, runId: 1, noticeSequence: 1, text: "hello", truncated: false } };
    expect(NoticeFrameSchema.safeParse(frame).success).toBe(true);
    expect(NoticeFrameSchema.safeParse({ ...frame, notice: { ...frame.notice, noticeSequence: 0 } }).success).toBe(false);
    expect(NoticeFrameSchema.safeParse({ ...frame, notice: { ...frame.notice, eventId: 1 } }).success).toBe(false);
  });
});
