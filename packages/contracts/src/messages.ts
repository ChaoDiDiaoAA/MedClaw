import { z } from "zod";
import { OpaqueIdSchema, PositiveIdSchema } from "./error";
import { ToolCallRecordSchema } from "./tool";

export const MAX_MESSAGE_TEXT_CHARS = 8192;
export const MAX_MESSAGE_REFERENCES = 16;
export const MAX_MESSAGE_PAGE_BYTES = 3 * 1024 * 1024;
const encoder = new TextEncoder();
const withinPageBudget = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength <= MAX_MESSAGE_PAGE_BYTES;

const messagePaging = {
  leafId: OpaqueIdSchema.nullable().default(null),
  afterEntryId: OpaqueIdSchema.nullable().default(null),
  limit: z.number().int().min(1).max(100).default(50),
};
export const ReadSessionMessagesInputSchema = z.strictObject({ sessionId: PositiveIdSchema, ...messagePaging })
  .refine(withinPageBudget, "Message input exceeds the UTF-8 JSON budget");
export type ReadSessionMessagesInput = z.infer<typeof ReadSessionMessagesInputSchema>;
export const ReadSessionMessagesRequestSchema = z.union([
  ReadSessionMessagesInputSchema,
  z.strictObject({ childRunId: PositiveIdSchema, ...messagePaging }).refine(withinPageBudget, 'Message input exceeds the UTF-8 JSON budget'),
]);
export type ReadSessionMessagesRequest = z.infer<typeof ReadSessionMessagesRequestSchema>;

const ReferenceSchema = z.string().max(32).regex(/^(run|tool|query|evidence):[1-9][0-9]*$/)
  .refine(reference => Number.isSafeInteger(Number(reference.slice(reference.indexOf(":") + 1))), "Expected a positive safe ID reference");
export const SessionMessageViewSchema = z.strictObject({
  nativeEntryId: OpaqueIdSchema,
  parentEntryId: OpaqueIdSchema.nullable(),
  entryType: z.string().min(1).max(128),
  displayRole: z.enum(["system", "user", "assistant", "tool_result", "product", "history_marker", "program"]),
  text: z.string().max(MAX_MESSAGE_TEXT_CHARS).nullable(),
  references: z.array(ReferenceSchema).max(MAX_MESSAGE_REFERENCES).refine(references => new Set(references).size === references.length, "References must be unique"),
  inputId: PositiveIdSchema.nullable(),
  runId: PositiveIdSchema.nullable(),
  toolCallRef: ToolCallRecordSchema.shape.nativeToolCallId.nullable(),
  textInfo: z.strictObject({
    totalChars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    truncated: z.boolean(),
    redacted: z.boolean(),
  }),
}).refine(({ text, textInfo }) => text === null
  ? textInfo.totalChars === null && !textInfo.truncated
  : textInfo.totalChars !== null && (textInfo.truncated ? textInfo.totalChars > text.length : textInfo.totalChars === text.length),
"Inconsistent visible text length or truncation")
  .refine(message => message.inputId === null || message.displayRole === "user", "Only user entries may carry direct input identity");
export type SessionMessageView = z.infer<typeof SessionMessageViewSchema>;

export const SessionMessagePageSchema = z.strictObject({
  sessionId: PositiveIdSchema,
  nativeSessionId: OpaqueIdSchema,
  leafId: OpaqueIdSchema.nullable(),
  source: z.enum(["native_memory", "sqlite_history"]),
  items: z.array(SessionMessageViewSchema).max(100),
  nextEntryId: OpaqueIdSchema.nullable(),
  hasMore: z.boolean(),
}).refine(page => page.hasMore === (page.nextEntryId !== null), "Inconsistent message page cursor")
  .refine(withinPageBudget, "Message page exceeds the UTF-8 JSON budget");
export type SessionMessagePage = z.infer<typeof SessionMessagePageSchema>;
