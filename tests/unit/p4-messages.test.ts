import { expect, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
const requireContracts = createRequire(new URL("../../packages/contracts/package.json", import.meta.url));
import { DATABASE_SCHEMA_VERSION, HOST_PROTOCOL_VERSION, HostHelloSchema, HostReadySchema, HostRequestSchema, HostReplySchema, isReadOnlyMethod, parsePublicPayload, publicMethodSchemas, type PublicPayload } from "../../packages/contracts/src/protocol";
import { safeError, serviceResult, type AppError } from "../../packages/contracts/src/error";
import { ToolCallRecordSchema, ToolCallViewSchema, type ToolCallStore, type ToolExecutionContext, type ToolCallView } from "../../packages/contracts/src/tool";
import type { ReadSessionMessagesInput, SessionMessageView, SessionMessagePage } from "../../packages/contracts/src/messages";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
const requireRuntime = createRequire(new URL("../../packages/runtime-pi/package.json", import.meta.url));
async function projection() {
  const module = await Promise.resolve().then(() => import(requireRuntime.resolve("@medclaw/runtime-pi/messages"))).catch(() => null) as typeof import("../../packages/runtime-pi/src/messages") | null;
  expect(module).not.toBeNull();
  if (!module) throw new Error("T02 message projection is missing");
  return module.projectSessionMessages;
}
function native() { return SessionManager.inMemory("C:/medclaw-p4-unit-fixture"); }
function user(manager: SessionManager, text: string) { return manager.appendMessage({ role: "user", content: text, timestamp: 1 }); }
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", content, api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 2,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const request = (patch: Partial<ReadSessionMessagesInput> = {}): ReadSessionMessagesInput => ({ sessionId: 1, leafId: null, afterEntryId: null, limit: 50, ...patch });

const message: SessionMessageView = { nativeEntryId: "entry-1", parentEntryId: null, entryType: "message", displayRole: "user",
  text: "Hello😀", references: [], inputId: null, runId: null, toolCallRef: null,
  textInfo: { totalChars: 7, truncated: false, redacted: false } };
const page: SessionMessagePage = { sessionId: 1, nativeSessionId: "native-1", leafId: "entry-1", source: "native_memory",
  items: [message], nextEntryId: null, hasMore: false };
const frame = { protocolVersion: HOST_PROTOCOL_VERSION, kind: "request", requestId: "request-1", instanceId: "host-1", operationRef: "operation-1",
  method: "session.messages.read", payload: { sessionId: 1 } };

test("P4 message contracts reject invalid cursors, limits, references and oversized pages", async () => {
  const { ReadSessionMessagesInputSchema: input, SessionMessageViewSchema: view, SessionMessagePageSchema: output } = await import(requireContracts.resolve("@medclaw/contracts/messages")) as typeof import("../../packages/contracts/src/messages");
  const parsed: ReadSessionMessagesInput = input.parse({ sessionId: 1 });
  expect(parsed).toEqual({ sessionId: 1, leafId: null, afterEntryId: null, limit: 50 });
  for (const limit of [1, 100]) expect(input.parse({ sessionId: 1, limit }).limit).toBe(limit);
  for (const patch of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { sessionId: 0 }, { sessionId: Number.MAX_SAFE_INTEGER + 1 },
    { leafId: "C:\\history.json" }, { afterEntryId: "/tmp/history" }, { afterEntryId: "" }, { path: "/tmp/history" }])
    expect(input.safeParse({ sessionId: 1, ...patch }).success).toBe(false);
  expect(view.parse({ ...message, references: ["run:1", "tool:2", "query:3", "evidence:4"] }).references).toHaveLength(4);
  for (const references of [["run:0"], ["run:01"], ["run:-1"], ["query:1.5"], ["run:9007199254740992"], ["https://example.org"], ["file:1"],
    ["run:1", "run:1"], Array.from({ length: 17 }, (_, index) => `tool:${index + 1}`)])
    expect(view.safeParse({ ...message, references }).success).toBe(false);
  for (const patch of [{ nativeEntryId: "/tmp/history" }, { parentEntryId: "C:\\history" }, { text: "x".repeat(8193) },
    { references: [], nativeData: {} }, { inputId: 0 }, { runId: 0 }, { toolCallRef: "" }]) expect(view.safeParse({ ...message, ...patch }).success).toBe(false);
  // Provider call IDs retain the existing tool contract rather than the entry/path rule.
  expect(view.parse({ ...message, toolCallRef: "provider/call+id" }).toolCallRef).toBe("provider/call+id");
  expect(output.safeParse(page).success).toBe(true);
  expect(output.safeParse({ ...page, source: "sqlite_history" }).success).toBe(true);
  for (const patch of [{ source: "metadata" }, { items: Array(101).fill(message) }, { nextEntryId: "/tmp/history", hasMore: true }, { extra: true }])
    expect(output.safeParse({ ...page, ...patch }).success).toBe(false);
});

test("P4 textInfo distinguishes unknown hidden content, visible truncation and redaction", async () => {
  const { SessionMessageViewSchema: view } = await import(requireContracts.resolve("@medclaw/contracts/messages")) as typeof import("../../packages/contracts/src/messages");
  expect(view.safeParse({ ...message, text: null, textInfo: { totalChars: null, truncated: false, redacted: true } }).success).toBe(true);
  expect(view.safeParse({ ...message, textInfo: { totalChars: 10, truncated: true, redacted: false } }).success).toBe(true);
  expect(view.safeParse({ ...message, textInfo: { totalChars: 7, truncated: false, redacted: true } }).success).toBe(true);
  for (const textInfo of [{ totalChars: -1, truncated: false, redacted: false }, { totalChars: 7.5, truncated: false, redacted: false },
    { totalChars: 7, truncated: true, redacted: false }, { totalChars: 10, truncated: false, redacted: false },
    { totalChars: null, truncated: true, redacted: true }, { totalChars: 7, truncated: false, redacted: false, thinkingChars: 12 }])
    expect(view.safeParse({ ...message, textInfo }).success).toBe(false);
  expect(view.safeParse({ ...message, text: null, textInfo: { totalChars: 10, truncated: true, redacted: true } }).success).toBe(false);
});

test("P4 output validation budgets escaped and Unicode JSON in UTF-8 below the Host frame cap", async () => {
  const { SessionMessagePageSchema: output } = await import(requireContracts.resolve("@medclaw/contracts/messages")) as typeof import("../../packages/contracts/src/messages");
  const makePage = (text: string): SessionMessagePage => ({ ...page, items: Array.from({ length: 100 }, (_, i) => ({ ...message,
    nativeEntryId: `entry-${i}`, text, textInfo: { totalChars: text.length, truncated: false, redacted: false } })) });
  for (const text of ["x".repeat(8192), "😀".repeat(4096)]) expect(output.safeParse(makePage(text)).success).toBe(true);
  for (const text of ["\u0000".repeat(8192), "\u0000".repeat(4000) + "界".repeat(4192), "界".repeat(8192)]) {
    const candidate = makePage(text);
    if (text.startsWith("\u0000")) {
      expect(new TextEncoder().encode(JSON.stringify(candidate)).byteLength).toBeGreaterThan(3 * 1024 * 1024);
      expect(output.safeParse(candidate).success).toBe(false);
      expect(HostReplySchema.safeParse({ protocolVersion: HOST_PROTOCOL_VERSION, kind: "reply", instanceId: "host-1", requestId: "request-1", result: { ok: true, data: candidate } }).success).toBe(false);
    } else expect(output.safeParse(candidate).success).toBe(true);
  }
  // A structurally valid page crosses the budget through escaped text, not item or character limits.
  const below = makePage("\u0000".repeat(5000)), above = makePage("\u0000".repeat(5300));
  expect(new TextEncoder().encode(JSON.stringify(below)).byteLength).toBeLessThan(3 * 1024 * 1024);
  expect(output.safeParse(below).success).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(above)).byteLength).toBeGreaterThan(3 * 1024 * 1024);
  expect(output.safeParse(above).success).toBe(false);
});

test("P4 message methods use the P5 protocol and schema 4 and classifies message and submission reads as read only", () => {
  const input: PublicPayload<"session.messages.read"> = { sessionId: 1 };
  expect(parsePublicPayload("session.messages.read", input)).toEqual({ sessionId: 1, leafId: null, afterEntryId: null, limit: 50 });
  expect(HostRequestSchema.safeParse(frame).success).toBe(true);
  expect(HostRequestSchema.safeParse({ ...frame, protocolVersion: "medclaw.host/p3-v1" }).success).toBe(false);
  expect(HostRequestSchema.safeParse({ ...frame, protocolVersion: "medclaw.host/p4-v1" }).success).toBe(false);
  expect(HostRequestSchema.safeParse({ ...frame, payload: { sessionId: 1, limit: 101 } }).success).toBe(false);
  const reply = { protocolVersion: HOST_PROTOCOL_VERSION, kind: "reply", instanceId: "host-1", requestId: "request-1", result: { ok: true, data: page } };
  expect(HostReplySchema.safeParse(reply).success).toBe(true);
  expect(HostReplySchema.safeParse({ ...reply, protocolVersion: "medclaw.host/p3-v1" }).success).toBe(false);
  expect(HostReplySchema.safeParse({ ...reply, protocolVersion: "medclaw.host/p4-v1" }).success).toBe(false);
  const ready = { protocolVersion: HOST_PROTOCOL_VERSION, instanceId: "host-1", sdkVersion: "0.87.1", schemaVersion: DATABASE_SCHEMA_VERSION, configVersion: "1", dataRoot: "D:/fixture" };
  expect(HostReadySchema.safeParse(ready).success).toBe(true);
  expect(HostReadySchema.safeParse({ ...ready, schemaVersion: 3 }).success).toBe(false);
  const hello = { protocolVersion: HOST_PROTOCOL_VERSION, instanceId: "host-1", sdkVersion: "0.87.1", expectedSchemaVersion: DATABASE_SCHEMA_VERSION, startupToken: "token-1",
    paths: { dataRoot: "D:/fixture", databasePath: "D:/fixture/db", settingsPath: "D:/fixture/settings", cachePath: "D:/fixture/cache", lockPath: "D:/fixture/lock" } };
  expect(HostHelloSchema.safeParse(hello).success).toBe(true);
  expect(HostHelloSchema.safeParse({ ...hello, protocolVersion: "medclaw.host/p3-v1" }).success).toBe(false);
  expect(HostHelloSchema.safeParse({ ...hello, protocolVersion: "medclaw.host/p4-v1" }).success).toBe(false);
  expect(isReadOnlyMethod("session.messages.read")).toBe(true);
  expect(isReadOnlyMethod("session.readSubmission")).toBe(true);
  expect(isReadOnlyMethod("session.submit")).toBe(false);
  expect(publicMethodSchemas["session.readSubmission"].input.parse({ sessionId: 1, clientSequence: 2 })).toEqual({ sessionId: 1, clientSequence: 2 });
});

const record = { id: 1, runId: 2, sessionId: 3, nativeToolCallId: "provider/call+id", name: "read", version: "1", executionMode: "sequential",
  input: {}, status: "succeeded", data: {}, error: null, sdkReturned: true, nativeEntryId: "entry-1", nextModelCallId: "call-2", consumedAt: "2026-10-02T00:00:00.000Z" };
const { input: _input, data: _data, ...viewFields } = record;
const toolView = { ...viewFields, inputPreview: "omitted", resultPreview: "omitted", truncated: false };

test("optional consumption evidence preserves legacy tool JSON and rejects fabricated tags", () => {
  expect(ToolCallRecordSchema.parse(record)).not.toHaveProperty("consumptionEvidence");
  expect(ToolCallViewSchema.parse(toolView)).not.toHaveProperty("consumptionEvidence");
  for (const schema of [ToolCallRecordSchema, ToolCallViewSchema]) {
    const fixture = schema === ToolCallRecordSchema ? record : toolView;
    expect(schema.parse({ ...fixture, consumptionEvidence: "provider_input_verified" })).toHaveProperty("consumptionEvidence", "provider_input_verified");
    for (const tag of ["consumed", "verified", null, true]) expect(schema.safeParse({ ...fixture, consumptionEvidence: tag }).success).toBe(false);
  }
  // This assignment and both invocations compile against the public port while retaining old implementations.
  const legacy: NonNullable<ToolCallStore["recordConsumption"]> = (_context, _nextCallId) => {};
  const context: ToolExecutionContext = { runId: 2, sessionId: 3, nativeToolCallId: "call", scope: { batchIds: [], deviceIds: [], allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true },
    referenceDate: "2026-01-01", timezone: "Asia/Shanghai", signal: new AbortController().signal };
  legacy(context, "next-call");
  legacy(context, "next-call", "provider_input_verified");
});

test("nativeOutputTruncated retains true false null and omitted legacy View without adding a record field", () => {
  const legacy: ToolCallView = ToolCallViewSchema.parse(toolView);
  expect(legacy).not.toHaveProperty("nativeOutputTruncated");
  for (const nativeOutputTruncated of [true, false, null])
    expect(ToolCallViewSchema.parse({ ...toolView, nativeOutputTruncated })).toHaveProperty("nativeOutputTruncated", nativeOutputTruncated);
  expect(ToolCallViewSchema.safeParse({ ...toolView, nativeOutputTruncated: "false" }).success).toBe(false);
  expect(ToolCallRecordSchema.safeParse({ ...record, nativeOutputTruncated: true }).success).toBe(false);
});

test("unavailable history uses a fixed non-retrying session error without copying native bodies", async () => {
  const expected: AppError = { code: "resource_unavailable", category: "session", message: "The required session history or message structure is unavailable. Read the original saved facts.", retryable: false, sessionId: 1 };
  expect(safeError("resource_unavailable", new Error("CANARY-SECRET"), { sessionId: 1 })).toEqual(expected);
  expect(await serviceResult(() => { throw new Error("resource_unavailable"); }, "storage_read_failed", { sessionId: 1 })).toEqual({ ok: false, error: expected });
  expect(await serviceResult(() => { throw new Error("session_not_found"); }, "storage_read_failed")).toMatchObject({ ok: false, error: { code: "input_invalid", reason: "session_not_found" } });
  expect(await serviceResult(() => { throw safeError("session_history_invalid"); }, "storage_read_failed")).toMatchObject({ ok: false, error: { code: "session_history_invalid" } });
});

test("fixed leaf pages stay on the original ancestor chain while the current leaf advances", async () => {
  const project = await projection(), manager = native(), a = user(manager, "A-first"), second = user(manager, "A-second");
  const first = project(manager, request({ limit: 1 }), new Map([[a, 7]]));
  expect(first).toMatchObject({ leafId: second, nextEntryId: a, hasMore: true, source: "native_memory" });
  expect(first.items[0]).toMatchObject({ nativeEntryId: a, runId: 7, references: ["run:7"], inputId: null });
  user(manager, "A-third"); manager.branch(a); const b = user(manager, "B-only"), before = structuredClone(manager.getEntries());
  const later = project(manager, request({ leafId: first.leafId, afterEntryId: first.nextEntryId, limit: 1 }), new Map());
  expect(later.items.map(item => item.text)).toEqual(["A-second"]);
  expect(later).toMatchObject({ leafId: second, nextEntryId: null, hasMore: false });
  expect(manager.getLeafId()).toBe(b); expect(manager.getEntries()).toEqual(before);
});

test("hidden entries and branch cursors preserve pagination progress", async () => {
  const project = await projection(), manager = native();
  const hidden = Array.from({ length: 101 }, () => manager.appendCustomEntry("hidden", { sentinel: "private" }));
  const visible = user(manager, "after-hidden"), leaf = manager.appendCustomMessageEntry("unregistered", "private", true, {});
  const first = project(manager, request({ limit: 1 }), new Map());
  expect(first).toMatchObject({ items: [], nextEntryId: hidden[99], leafId: leaf, hasMore: true });
  const second = project(manager, request({ limit: 1, leafId: leaf, afterEntryId: first.nextEntryId }), new Map());
  expect(second.items.map(item => item.nativeEntryId)).toEqual([visible]);
  expect(second).toMatchObject({ nextEntryId: visible, hasMore: true });
  expect(project(manager, request({ leafId: leaf, afterEntryId: visible }), new Map())).toMatchObject({ items: [], nextEntryId: null, hasMore: false });
  expect(project(manager, request({ leafId: leaf, afterEntryId: hidden[100], limit: 1 }), new Map()).items[0]?.nativeEntryId).toBe(visible);
  const allHidden = native(); Array.from({ length: 101 }, () => allHidden.appendCustomEntry("hidden"));
  const emptyFirst = project(allHidden, request(), new Map());
  expect(emptyFirst.items).toEqual([]); expect(emptyFirst.hasMore).toBe(true);
  expect(project(allHidden, request({ leafId: emptyFirst.leafId, afterEntryId: emptyFirst.nextEntryId }), new Map())).toMatchObject({ items: [], nextEntryId: null, hasMore: false });
  manager.branch(hidden[0]); const side = user(manager, "other branch");
  for (const patch of [{ leafId: "absent" }, { leafId: leaf, afterEntryId: side }, { leafId: leaf, afterEntryId: "absent" }, { leafId: leaf, afterEntryId: user(native(), "other session") }])
    expect(() => project(manager, request(patch), new Map())).toThrow(expect.objectContaining({ code: "input_invalid", reason: "message_cursor_invalid" }));
});

test("healthy empty history differs from unavailable or invalid native history", async () => {
  const project = await projection(), empty = native();
  expect(project(empty, request(), new Map())).toMatchObject({ items: [], leafId: null, nextEntryId: null, hasMore: false });
  expect(() => project(empty, request({ afterEntryId: "absent" }), new Map())).toThrow(expect.objectContaining({ code: "input_invalid", reason: "message_cursor_invalid" }));
  for (const corrupt of ["missing-parent", "cycle", "duplicate"] as const) {
    const manager = native(), root = user(manager, "root"), child = user(manager, "child"), entries = manager.getEntries();
    if (corrupt === "missing-parent") entries[1]!.parentId = "missing";
    if (corrupt === "cycle") entries[0]!.parentId = child;
    if (corrupt === "duplicate") entries[1]!.id = root;
    expect(() => project(manager, request(), new Map())).toThrow(expect.objectContaining({ code: "session_history_invalid" }));
  }
  const legal = native(), first = user(legal, "first root"); legal.resetLeaf();
  expect(() => project(legal, request(), new Map())).toThrow(expect.objectContaining({ code: "resource_unavailable" }));
  expect(project(legal, request({ leafId: first }), new Map()).items[0]?.text).toBe("first root");
  const second = user(legal, "second root");
  expect(project(legal, request({ leafId: first }), new Map()).items[0]?.text).toBe("first root");
  expect(project(legal, request({ leafId: second }), new Map()).items[0]?.text).toBe("second root");
  const unsupported = native(); unsupported.appendMessage({ role: "bashExecution", command: "private", output: "private", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 });
  expect(() => project(unsupported, request(), new Map())).toThrow(expect.objectContaining({ code: "resource_unavailable" }));
  const brokenLeaf = native(); user(brokenLeaf, "root");
  const pointer = spyOn(brokenLeaf, "getLeafId").mockReturnValue("missing-current-leaf");
  try { expect(() => project(brokenLeaf, request(), new Map())).toThrow(expect.objectContaining({ code: "session_history_invalid" })); }
  finally { pointer.mockRestore(); }
  const future = native(), entry = user(future, "root");
  Object.assign(future.getEntry(entry)!, { type: "future_sdk_entry" });
  expect(() => project(future, request(), new Map())).toThrow(expect.objectContaining({ code: "resource_unavailable" }));
});

for (const corruption of ["missing parent", "cycle"] as const) {
  test(`resetLeaf with ${corruption} stays invalid native history`, async () => {
    const project = await projection(), manager = native(), root = user(manager, "root"), child = user(manager, "child");
    if (corruption === "missing parent") manager.getEntry(child)!.parentId = "missing-parent";
    else manager.getEntry(root)!.parentId = child;
    manager.resetLeaf();
    const before = structuredClone(manager.getEntries());
    expect(() => project(manager, request(), new Map())).toThrow(expect.objectContaining({ code: "session_history_invalid" }));
    expect(manager.getLeafId()).toBeNull(); expect(manager.getEntries()).toEqual(before);
  });
}

test("safe text projection never changes native content or exposes hidden blocks", async () => {
  const project = await projection(), manager = native(), secret = "STRUCTURE-CANARY";
  manager.appendMessage({ role: "system", content: secret, sections: { hidden: secret }, timestamp: 1 });
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "ordinary user", textSignature: secret }, { type: "image", data: secret, mimeType: "image/png" }], timestamp: 1 });
  const text = "x".repeat(8191) + "😀" + "\u0000";
  const answer = manager.appendMessage(assistant([{ type: "text", text, textSignature: secret }, { type: "thinking", thinking: secret, thinkingSignature: secret }, { type: "toolCall", id: "provider/call+id", name: "read", arguments: { path: secret }, thoughtSignature: secret }]));
  const result = manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "provider/call+id", content: [{ type: "text", text: secret }], details: { path: secret }, isError: false, timestamp: 3 });
  manager.appendCustomEntry(secret, { private: secret }); manager.appendCustomMessageEntry(secret, secret, true, { details: secret });
  manager.appendThinkingLevelChange(secret); manager.appendModelChange(secret, secret); manager.appendSessionInfo(secret);
  manager.appendCompaction(secret, null, 42, { private: secret }); manager.appendLabelChange(answer, secret); manager.appendContextEdit(answer, { content: [{ type: "text", text: secret }] });
  const before = structuredClone(manager.getEntries()), page = project(manager, request(), new Map());
  expect(JSON.stringify(page)).not.toContain(secret); expect(manager.getEntries()).toEqual(before);
  expect(page.items.find(item => item.displayRole === "user")).toMatchObject({ text: "ordinary user", textInfo: { totalChars: 13, truncated: false, redacted: true } });
  expect(page.items.find(item => item.nativeEntryId === answer)).toMatchObject({ text: "x".repeat(8191), textInfo: { totalChars: 8194, truncated: true, redacted: true } });
  expect(page.items.find(item => item.nativeEntryId === result)).toMatchObject({ displayRole: "tool_result", toolCallRef: "provider/call+id", text: null, textInfo: { totalChars: null, truncated: false, redacted: true } });
  expect(page.items[0]).toMatchObject({ text: "System instructions omitted", textInfo: { totalChars: 27, truncated: false, redacted: true } });
  expect(page.items.filter(item => item.displayRole === "history_marker")).toHaveLength(6);
});

test("UTF-8 page budget stops before an oversized next item and keeps a progressing cursor", async () => {
  const project = await projection(), manager = native(), entries = Array.from({ length: 100 }, () => user(manager, "\u0000".repeat(8192)));
  const first = project(manager, request({ limit: 100 }), new Map());
  expect(first.items.length).toBeGreaterThan(1); expect(first.items.length).toBeLessThan(100); expect(first.hasMore).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThanOrEqual(3 * 1024 * 1024);
  expect(first.nextEntryId).toBe(entries[first.items.length - 1]);
  const second = project(manager, request({ limit: 100, leafId: first.leafId, afterEntryId: first.nextEntryId }), new Map());
  expect(second.items[0]?.nativeEntryId).toBe(entries[first.items.length]);
  expect([...first.items, ...second.items].map(item => item.nativeEntryId)).toEqual(entries);
  expect(second.hasMore).toBe(false);
});

test("reserved tool enrichment fits the final UTF-8 page budget", async () => {
  const project = await projection(), manager = native();
  for (let i = 0; i < 62; i++) user(manager, "\u0000".repeat(8192));
  for (let i = 0; i < 38; i++) manager.appendMessage({ role: "toolResult", toolCallId: "\u0000".repeat(256), toolName: "read", content: [{ type: "text", text: "private" }], isError: false, timestamp: 1 });
  const page = project(manager, request({ limit: 100 }), new Map());
  const enriched = { ...page, items: page.items.map(item => item.displayRole === "tool_result" ? { ...item, runId: Number.MAX_SAFE_INTEGER,
    references: Array.from({ length: 16 }, (_, i) => `evidence:${Number.MAX_SAFE_INTEGER - i}`) } : item) };
  const { SessionMessagePageSchema } = await import("../../packages/contracts/src/messages");
  expect(page.items.some(item => item.displayRole === "tool_result")).toBe(true);
  expect(SessionMessagePageSchema.safeParse(enriched).success).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(enriched)).byteLength).toBeLessThanOrEqual(3 * 1024 * 1024);
  expect(page.hasMore).toBe(true);
});

test("same text with different native identities remains two messages and unknown ownership stays null", async () => {
  const project = await projection(), manager = native(), one = user(manager, "same text"), two = user(manager, "same text");
  const page = project(manager, request(), new Map([[one, 10]]));
  expect(page.items.map(item => item.nativeEntryId)).toEqual([one, two]);
  expect(page.items.map(item => item.runId)).toEqual([10, null]);
  expect(page.items.map(item => item.inputId)).toEqual([null, null]);
  expect(page.items[1]?.references).toEqual([]);
});
