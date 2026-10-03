import type { SessionManager, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { MAX_MESSAGE_PAGE_BYTES, MAX_MESSAGE_TEXT_CHARS, ReadSessionMessagesInputSchema, SessionMessagePageSchema,
  type ReadSessionMessagesInput, type SessionMessagePage, type SessionMessageView } from "@medclaw/contracts/messages";
import { OpaqueIdSchema, PositiveIdSchema, safeError } from "../../contracts/src/error";
import { ToolCallRecordSchema, ToolCallViewSchema, type ToolCallRecord, type ToolCallView } from "../../contracts/src/tool";
import { ToolControlObservationSchema } from "../../contracts/src/model";
import { businessToolSchemas } from "../../contracts/src/business-tools";
import { safePreview } from "../../contracts/src/run";
import type { ToolSdkDelivery } from "../../contracts/src/tool";
import { isDeepStrictEqual } from "node:util";

const encoder = new TextEncoder();
const markers = {
  thinking_level_change: "Thinking level changed", model_change: "Model changed", usage: "Usage recorded",
  compaction: "History compacted", branch_summary: "Branch summary omitted", context_edit: "Context edit recorded",
  label: "History label omitted", session_info: "Session metadata omitted",
} as const;
const unsupported = (): never => { throw safeError("resource_unavailable"); };
const invalid = (): never => { throw safeError("session_history_invalid"); };
const badCursor = (): never => { throw safeError("input_invalid", undefined, { reason: "message_cursor_invalid" }); };
const nativeToolNames = new Set(["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"]);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Compare receipt identity and content, excluding metadata that is absent from the wire. */
export function sameToolReceipt(message: unknown, receipt: ToolSdkDelivery): boolean {
  const candidate = object(message);
  return candidate?.role === 'toolResult' && candidate.toolCallId === receipt.toolCallId && candidate.toolName === receipt.toolName
    && candidate.isError === receipt.isError && isDeepStrictEqual(candidate.content, receipt.content);
}

/** ponytail: exact wire proof covers short-ID text openai-completions; extend only with SDK-compatible receiver fixtures. */
export function matchProviderToolReceipts(api: string, payload: unknown, receipts: readonly ToolSdkDelivery[]): ToolSdkDelivery[] {
  const messages = object(payload)?.messages;
  if (api !== 'openai-completions' || !Array.isArray(messages)) return [];
  return receipts.filter(receipt => {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(receipt.toolCallId)) return false;
    const texts: string[] = [];
    for (const part of receipt.content) {
      const block = object(part);
      if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text.isWellFormed()) return false;
      texts.push(block.text);
    }
    const text = texts.join('\n');
    if (!text) return false;
    const tools = messages.map(object).filter(message => message?.role === 'tool' && message.tool_call_id === receipt.toolCallId);
    const calls = messages.map(object).filter(message => message?.role === 'assistant').flatMap(message =>
      Array.isArray(message?.tool_calls) ? message.tool_calls.map(object).filter(call => call?.id === receipt.toolCallId) : []);
    // Repeated IDs are ambiguous even when one occurrence appears to match.
    return tools.length === 1 && tools[0]?.content === text && calls.length === 1;
  });
}

/** Public tool views disclose saved execution metadata; arbitrary tool payloads stay in storage. */
export function projectToolCall(record: ToolCallRecord): ToolCallView {
  const native = nativeToolNames.has(record.name), business = Object.hasOwn(businessToolSchemas, record.name);
  const details = native ? object(object(record.data)?.details) : null, truncation = object(details?.truncation);
  const nativeOutputTruncated = native && record.name === "grep" && details?.linesTruncated === true ? true
    : native && typeof truncation?.truncated === "boolean" ? truncation.truncated : null;
  const limitKey = record.name === "grep" ? "matchLimitReached" : record.name === "find" ? "resultLimitReached" : record.name === "ls" ? "entryLimitReached" : null;
  const limit = limitKey ? details?.[limitKey] : null, resultLimitReached = typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0;
  const control = record.control == null ? record.control : { ...ToolControlObservationSchema.parse(record.control), environmentKey: null, workloadBucket: null };
  return ToolCallViewSchema.parse({
    id: record.id, runId: record.runId, sessionId: record.sessionId, nativeToolCallId: record.nativeToolCallId,
    name: native || business ? record.name : "Unknown tool", version: record.version, executionMode: record.executionMode, status: record.status,
    error: record.error === null ? null : safeError(record.error.code, undefined, { runId: record.runId, sessionId: record.sessionId, toolCallId: record.id }),
    sdkReturned: record.sdkReturned, nativeEntryId: record.nativeEntryId,
    ...(record.modelCallId === undefined ? {} : { modelCallId: record.modelCallId }),
    ...(record.stoppedAt === undefined ? {} : { stoppedAt: record.stoppedAt }),
    ...(record.nextModelCallId === undefined ? {} : { nextModelCallId: record.nextModelCallId }),
    ...(record.consumedAt === undefined ? {} : { consumedAt: record.consumedAt }),
    ...(record.consumptionEvidence === undefined ? {} : { consumptionEvidence: record.consumptionEvidence }),
    ...(control === undefined ? {} : { control }),
    sdkResultIsError: record.sdkReturned ? record.sdkDelivery?.isError ?? null : null,
    nativeOutputTruncated,
    inputPreview: native ? "Native tool arguments omitted" : business ? `${record.name}: arguments omitted` : "Tool arguments omitted",
    resultPreview: native ? `Native tool output omitted; read saved execution facts${resultLimitReached ? "; SDK result limit reached" : ""}`
      : business ? `${record.name}: saved result ${record.status}` : "Tool output omitted; read saved execution facts",
    truncated: false,
  });
}

/** Only ordinary visible text contributes to lengths; hidden blocks retain their native content. */
export function projectMessageText(message: SessionMessageEntry["message"]) {
  let text = "", hasText = false, redacted = false;
  if (message.role !== "user" && message.role !== "assistant") return unsupported();
  if (typeof message.content === "string") {
    if (message.role !== "user") return unsupported();
    text = message.content; hasText = true;
  } else {
    if (!Array.isArray(message.content)) return unsupported();
    for (const part of message.content) {
      if (!part || typeof part !== "object") return unsupported();
      if (part.type === "text") {
        if (typeof part.text !== "string") return unsupported();
        text += part.text; hasText = true;
        if (part.textSignature !== undefined) redacted = true;
      } else if (part.type === "image" || part.type === "thinking" || part.type === "toolCall") redacted = true;
      else return unsupported();
    }
  }
  return { ...(hasText ? safePreview(text, MAX_MESSAGE_TEXT_CHARS) : { text: null, truncated: false }), totalChars: hasText ? text.length : null, redacted };
}

function projectEntry(entry: SessionEntry, entryRuns: ReadonlyMap<string, number>): SessionMessageView | null {
  if (entry.type === "custom" || entry.type === "custom_message") return null;
  const base = { nativeEntryId: entry.id, parentEntryId: entry.parentId, entryType: entry.type, inputId: null, runId: null,
    references: [] as string[], toolCallRef: null };
  if (entry.type === "message") {
    const message = entry.message;
    if (!message || typeof message !== "object") return unsupported();
    if (message.role === "custom") return null;
    if (message.role === "user" || message.role === "assistant") {
      const { text, ...textInfo } = projectMessageText(message), runId = entryRuns.get(entry.id) ?? null;
      if (runId !== null && !PositiveIdSchema.safeParse(runId).success) return invalid();
      return { ...base, displayRole: message.role, text, textInfo, runId, references: runId === null ? [] : [`run:${runId}`] };
    }
    if (message.role === "system") {
      const text = "System instructions omitted";
      return { ...base, displayRole: "system", text, textInfo: { totalChars: text.length, truncated: false, redacted: true } };
    }
    if (message.role === "toolResult") {
      if (!ToolCallRecordSchema.shape.nativeToolCallId.safeParse(message.toolCallId).success) return unsupported();
      return { ...base, displayRole: "tool_result", text: null, toolCallRef: message.toolCallId, textInfo: { totalChars: null, truncated: false, redacted: true } };
    }
    return unsupported();
  }
  if (!Object.hasOwn(markers, entry.type)) return unsupported();
  const text = markers[entry.type as keyof typeof markers];
  return { ...base, displayRole: "history_marker", text, textInfo: { totalChars: text.length, truncated: false, redacted: true } };
}

/** Reads raw fixed ancestors; it never changes Pi's branch or its effective model context. */
export function projectSessionMessages(manager: SessionManager, input: ReadSessionMessagesInput, entryRuns: ReadonlyMap<string, number>): SessionMessagePage {
  const request = ReadSessionMessagesInputSchema.parse(input), entries = manager.getEntries(), currentLeaf = manager.getLeafId();
  const nativeSessionId = manager.getSessionId(), ownership = new Map(entryRuns), byId = new Map<string, SessionEntry>();
  if (!OpaqueIdSchema.safeParse(nativeSessionId).success || !Array.isArray(entries)) return invalid();
  // ponytail: Full in-memory validation is O(history); indexed native history belongs to P9.
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !OpaqueIdSchema.safeParse(entry.id).success
      || entry.parentId !== null && !OpaqueIdSchema.safeParse(entry.parentId).success || typeof entry.type !== "string" || byId.has(entry.id)) return invalid();
    byId.set(entry.id, entry);
  }
  const leafId = request.leafId ?? currentLeaf;
  if (request.leafId !== null && !byId.has(request.leafId)) return badCursor();
  if (currentLeaf !== null && !byId.has(currentLeaf)) return invalid();
  const validated = new Set<string>();
  for (const entry of entries) {
    const visiting = new Set<string>();
    let node: SessionEntry | undefined = entry;
    while (node && !validated.has(node.id)) {
      if (visiting.has(node.id)) return invalid();
      visiting.add(node.id);
      if (node.parentId === null) break;
      node = byId.get(node.parentId);
      if (!node) return invalid();
    }
    for (const id of visiting) validated.add(id);
  }
  if (leafId === null && entries.length) return unsupported(); // Only a validated legal resetLeaf position is unavailable.
  const chain = leafId === null ? [] : manager.getBranch(leafId);
  // Native index and entry snapshots must describe the same fixed path.
  let expectedId = leafId;
  for (let i = chain.length - 1; i >= 0; i--) {
    const entry = chain[i]!;
    if (entry.id !== expectedId || byId.get(entry.id) !== entry) return invalid();
    expectedId = entry.parentId;
  }
  if (expectedId !== null) return invalid();
  const afterIndex = request.afterEntryId === null ? -1 : chain.findIndex(entry => entry.id === request.afterEntryId);
  if (request.afterEntryId !== null && afterIndex < 0) return badCursor();
  const page: SessionMessagePage = { sessionId: request.sessionId, nativeSessionId, leafId, source: "native_memory", items: [], nextEntryId: null, hasMore: false };
  let index = afterIndex + 1, scanned = 0, lastScanned = request.afterEntryId, toolItems = 0;
  while (index < chain.length && scanned < 100 && page.items.length < request.limit) {
    const entry = chain[index]!, item = projectEntry(entry, ownership);
    if (item) {
      const nextToolItems = toolItems + (item.displayRole === "tool_result" ? 1 : 0);
      // 512/tool result covers 16 maximal numeric refs and null -> safe runId enrichment (459 bytes).
      // Bound cursor metadata too, since later hidden nodes can have longer IDs than this visible node.
      const candidate = { ...page, items: [...page.items, item], nextEntryId: "x".repeat(256), hasMore: true };
      if (encoder.encode(JSON.stringify(candidate)).byteLength + nextToolItems * 512 > MAX_MESSAGE_PAGE_BYTES) {
        if (!page.items.length) return unsupported(); // A single bounded View must fit, never return a stuck cursor.
        break;
      }
      page.items.push(item); toolItems = nextToolItems;
    }
    lastScanned = entry.id; index++; scanned++;
  }
  page.hasMore = index < chain.length;
  page.nextEntryId = page.hasMore ? lastScanned : null;
  return SessionMessagePageSchema.parse(page);
}
