import { z } from "zod";
import { AppErrorSchema, PositiveIdSchema, type AppError } from "./error";
import { RunScopeSchema, type RunScope } from "./run";
import { ReferenceDateSchema, TimezoneSchema } from "./model";

export const ToolExecutionModeSchema = z.enum(["sequential", "parallel"]);
export type ToolExecutionMode = z.infer<typeof ToolExecutionModeSchema>;
export interface Tool<I, O> {
  name: string;
  version: string;
  description: string;
  effect: "PURE" | "READ" | "LOCAL_WRITE";
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
}
export interface AgentTool<I, O> extends Tool<I, O> {
  executionMode: ToolExecutionMode;
  execute(input: I, context: ToolExecutionContext): Promise<O>;
}
export interface ToolDefinition<I, O> extends AgentTool<I, O> { label: string }
export type AnyToolDefinition = ToolDefinition<unknown, unknown>;
export type ToolCallIdentity = Pick<AnyToolDefinition, "name" | "version" | "effect" | "executionMode">;
export type ToolExecutionContext = {
  runId: number; sessionId: number; nativeToolCallId: string; scope: RunScope;
  referenceDate: string; timezone: string; signal: AbortSignal;
};
export const ToolContextIdentitySchema = z.object({
  runId: PositiveIdSchema, sessionId: PositiveIdSchema, nativeToolCallId: z.string().min(1).max(256),
  scope: RunScopeSchema, referenceDate: ReferenceDateSchema, timezone: TimezoneSchema,
});
export type ToolResult<O> = { status: "succeeded"; data: O }
  | { status: "failed" | "cancelled"; error: AppError; data?: O };
/** The actual SDK tool-result message, observed after native session history appends it. */
export const ToolSdkDeliverySchema = z.strictObject({
  role: z.literal("toolResult"),
  toolCallId: z.string().min(1).max(256),
  toolName: z.string().min(1),
  content: z.array(z.json()),
  details: z.json().optional(),
  usage: z.json().optional(),
  isError: z.boolean(),
  timestamp: z.number().finite(),
});
export type ToolSdkDelivery = z.infer<typeof ToolSdkDeliverySchema>;
export const ToolCallRecordSchema = z.strictObject({
  id: PositiveIdSchema, runId: PositiveIdSchema, sessionId: PositiveIdSchema,
  nativeToolCallId: z.string().min(1).max(256), name: z.string(), version: z.string(),
  executionMode: ToolExecutionModeSchema, input: z.unknown(),
  status: z.enum(["requested", "running", "succeeded", "failed", "cancelled"]),
  data: z.unknown().nullable(), error: AppErrorSchema.nullable(),
  sdkReturned: z.boolean(), nativeEntryId: z.string().nullable(),
  sdkDelivery: ToolSdkDeliverySchema.optional(),
  modelCallId: z.string().min(1).optional(),
  stoppedAt: z.string().min(1).optional(),
  nextModelCallId: z.string().min(1).optional(),
  consumedAt: z.string().min(1).optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;
export const ToolCallViewSchema = ToolCallRecordSchema.omit({ input: true, data: true, sdkDelivery: true }).extend({
  inputPreview: z.string().max(8192),
  resultPreview: z.string().max(16384),
  truncated: z.boolean(),
});
export const RunToolsViewSchema = z.strictObject({
  runId: PositiveIdSchema,
  scope: RunScopeSchema,
  items: z.array(ToolCallViewSchema).max(50),
  totalRows: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
});
export interface ToolCallStore {
  assertContext(context: ToolExecutionContext): void;
  request(tool: ToolCallIdentity, input: unknown, context: ToolExecutionContext): ToolCallRecord;
  readCall(context: ToolExecutionContext): ToolCallRecord | null;
  transition(id: number, from: ToolCallRecord["status"], to: ToolCallRecord["status"], result?: ToolResult<unknown>): ToolCallRecord;
  recordDelivery(context: ToolExecutionContext, nativeEntryId: string, message?: ToolSdkDelivery): void;
  recordConsumption?(context: ToolExecutionContext, nextCallId: string): void;
  recordFailedRequest?(tool: ToolCallIdentity, input: unknown, context: ToolExecutionContext, error: AppError, requestedAt: string): void;
}
