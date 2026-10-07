import { z } from "zod";
import { AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema, type AppError } from "./error";
import { RunScopeSchema, type RunScope } from "./run";
import { MeasurementContextSchema, ReferenceDateSchema, TimezoneSchema, ToolControlObservationSchema, type ToolControlObservation } from "./model";
import type { ToolConfiguration } from './tool-config';
import { WorkspaceContextSchema, RevisionSchema, type WorkspaceContext } from './workspace';
import { ResourceReadFactSchema, type ResourceReadFact } from './resources';
import { DelegationSourceSchema, type DelegationSource } from './subagent';

export const TOOL_READ_RULES = Object.freeze({
  defaultPage: 1,
  defaultPageSize: 20,
  maxPageSize: 50,
  inputPreviewChars: 8192,
  resultPreviewChars: 16384,
});

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
  contextSnapshotId?: number | null; modelCallId?: string;
  runId: number; sessionId: number; nativeToolCallId: string; scope: RunScope;
  referenceDate: string; timezone: string; signal: AbortSignal;
  checkActive?: () => void;
  toolConfiguration?: ToolConfiguration;
  workspaceContext?: WorkspaceContext | null;
  workspaceInputId?: number | null;
  basedOnQueryId?: number | null;
  workspaceRevision?: number;
  delegationSource?: DelegationSource;
};
export const ToolContextFieldsSchema = z.object({
  contextSnapshotId: PositiveIdSchema.nullable().optional(), modelCallId: OpaqueIdSchema.optional(),
  runId: PositiveIdSchema, sessionId: PositiveIdSchema, nativeToolCallId: z.string().min(1).max(256),
  scope: RunScopeSchema, referenceDate: ReferenceDateSchema, timezone: TimezoneSchema,
  workspaceContext: WorkspaceContextSchema.nullable().optional(), workspaceInputId: PositiveIdSchema.nullable().optional(),
  basedOnQueryId: PositiveIdSchema.nullable().optional(), workspaceRevision: RevisionSchema.optional(),
  delegationSource: DelegationSourceSchema.optional(),
});
export const ToolContextIdentitySchema = ToolContextFieldsSchema.superRefine((identity, ctx) => {
  if ((identity.contextSnapshotId != null) !== (identity.modelCallId !== undefined)) ctx.addIssue({ code: 'custom', message: 'Context requires both original call and snapshot' });
  if(identity.delegationSource) {
    if(identity.workspaceContext!==null||identity.workspaceInputId!==null||identity.basedOnQueryId!==null||identity.workspaceRevision!==undefined
      ||identity.contextSnapshotId==null||identity.modelCallId===undefined)ctx.addIssue({code:'custom',message:'Delegated tool requires its own context and no user Workspace'});
    return;
  }
  const keys = ['workspaceContext', 'workspaceInputId', 'basedOnQueryId', 'workspaceRevision'] as const;
  if (!keys.some(key => identity[key] !== undefined)) return;
  if (keys.some(key => identity[key] === undefined) || !identity.workspaceContext) {
    ctx.addIssue({ code: 'custom', message: 'Workspace identity requires the complete frozen group' }); return;
  }
  if (identity.workspaceContext.sessionId !== identity.sessionId || identity.workspaceContext.revision !== identity.workspaceRevision
    || identity.workspaceContext.queryId !== identity.basedOnQueryId) ctx.addIssue({ code: 'custom', message: 'Frozen workspace identity mismatch' });
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
  contextSnapshotId: PositiveIdSchema.nullable().optional(),
  id: PositiveIdSchema, runId: PositiveIdSchema, sessionId: PositiveIdSchema,
  nativeToolCallId: z.string().min(1).max(256), name: z.string(), version: z.string(),
  executionMode: ToolExecutionModeSchema, input: z.unknown(),
  status: z.enum(["requested", "running", "succeeded", "failed", "cancelled"]),
  data: z.unknown().nullable(), error: AppErrorSchema.nullable(),
  sdkReturned: z.boolean(), nativeEntryId: z.string().nullable(),
  sdkDelivery: ToolSdkDeliverySchema.optional(),
  resourceRead: ResourceReadFactSchema.optional(),
  modelCallId: z.string().min(1).optional(),
  stoppedAt: z.string().min(1).optional(),
  nextModelCallId: z.string().min(1).optional(),
  consumedAt: z.string().min(1).optional(),
  consumptionEvidence: z.literal("provider_input_verified").optional(),
  control: ToolControlObservationSchema.nullable().optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;
export const ToolCallViewSchema = ToolCallRecordSchema.omit({ input: true, data: true, sdkDelivery: true }).extend({
  sdkResultIsError: z.boolean().nullable().optional(),
  nativeOutputTruncated: z.boolean().nullable().optional(),
  inputPreview: z.string(),
  resultPreview: z.string(),
  truncated: z.boolean(),
});
export type ToolCallView = z.infer<typeof ToolCallViewSchema>;
export const RunToolsViewSchema = z.strictObject({
  runId: PositiveIdSchema,
  scope: RunScopeSchema,
  items: z.array(ToolCallViewSchema),
  totalRows: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1),
});
export const ToolObservationSchema = z.strictObject({
  id: PositiveIdSchema,
  name: z.string().min(1).max(256),
  version: z.string().min(1).max(128),
  status: ToolCallRecordSchema.shape.status,
  requestedAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  stoppedAt: TimestampSchema.nullable(),
  control: ToolControlObservationSchema.nullable(),
  measurementContext: MeasurementContextSchema.nullable(),
  modelKey: z.string().min(1).max(512).nullable(),
  sdkReturned: z.boolean(),
  consumedAt: TimestampSchema.nullable(),
});
export type ToolObservation = z.infer<typeof ToolObservationSchema>;
export interface ToolCallStore {
  assertContext(context: ToolExecutionContext): void;
  request(tool: ToolCallIdentity, input: unknown, context: ToolExecutionContext): ToolCallRecord;
  readCall(context: ToolExecutionContext): ToolCallRecord | null;
  transition(id: number, from: ToolCallRecord["status"], to: ToolCallRecord["status"], result?: ToolResult<unknown>, control?: ToolControlObservation): ToolCallRecord;
  mergeControl?(context: ToolExecutionContext, patch: Partial<ToolControlObservation>): ToolCallRecord;
  readToolObservations?(input: { cutoffAt: string; maxToolCallId?: number | null; limit: number; windowDays: number }): { maxToolCallId: number | null; observations: ToolObservation[] };
  recordDelivery(context: ToolExecutionContext, nativeEntryId: string, message?: ToolSdkDelivery): void;
  recordResourceRead?(context: ToolExecutionContext, fact: ResourceReadFact): void;
  recordConsumption?(context: ToolExecutionContext, nextCallId: string, evidence?: "provider_input_verified"): void;
  recordFailedRequest?(tool: ToolCallIdentity, input: unknown, context: ToolExecutionContext, error: AppError, requestedAt: string): void;
}
