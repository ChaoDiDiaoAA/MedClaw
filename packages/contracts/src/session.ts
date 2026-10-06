import { z } from "zod";
import { AppErrorSchema, TimestampSchema, OpaqueIdSchema, PositiveIdSchema } from "./error";
import { ModelChoiceSchema, ModelSelectionSchema, ReferenceDateSchema, TimezoneSchema } from "./model";
import { RevisionSchema, WorkspaceViewSchema, WorkspaceContextSchema } from "./workspace";
import type { WorkspaceView, WorkspaceChange, WorkspaceContext } from "./workspace";
import { RunScopeSchema,ModelCallViewSchema } from "./run";
import type { AppError, Result } from "./error";
import type { StoredOperation, RunHandle, RegisterAgentInput } from "./run";
import type { ReadSessionMessagesInput, SessionMessagePage } from "./messages";
import { ResourceInputPlanSchema, NativeInputReceiptSchema, RESOURCE_LIMITS, type ResourceInputPlan, type NativeInputReceipt } from './resources';

export const NewSessionInputSchema = z.strictObject({ selectOnCreate: z.literal(true).default(true), expectedWorkspaceRevision: RevisionSchema });
export const SelectSessionInputSchema = z.strictObject({ sessionId: PositiveIdSchema, expectedWorkspaceRevision: RevisionSchema });
export const SessionTitleSchema = z.string().trim().min(1).max(256);
export const RenameSessionInputSchema = z.strictObject({ sessionId: PositiveIdSchema, title: SessionTitleSchema, expectedMetadataRevision: RevisionSchema });
export const DeleteSessionInputSchema = z.strictObject({ sessionId: PositiveIdSchema, expectedMetadataRevision: RevisionSchema, expectedWorkspaceRevision: RevisionSchema });
export const ReadManagementOperationInputSchema = z.strictObject({ operationRef: OpaqueIdSchema });
const metadataFields = { id: PositiveIdSchema, title: z.string().max(256), status: z.enum(['active', 'deleted']), metadataRevision: RevisionSchema, deletedAt: TimestampSchema.nullable() };
export const SessionMetadataViewSchema = z.strictObject(metadataFields)
  .refine(session => (session.status === 'deleted') === (session.deletedAt !== null), 'Deletion time must match session lifecycle');
const receiptFields = { operationRef: OpaqueIdSchema, committedAt: TimestampSchema };
const RenameSessionReceiptSchema = z.strictObject({ ...receiptFields, method: z.literal('session.rename'),
  session: SessionMetadataViewSchema.refine(session => session.status === 'active'), workspace: z.null() });
const DeleteSessionReceiptSchema = z.strictObject({ ...receiptFields, method: z.literal('session.delete'),
  session: SessionMetadataViewSchema.refine(session => session.status === 'deleted'), workspace: WorkspaceViewSchema });
export const SessionManagementReceiptSchema = z.discriminatedUnion('method', [RenameSessionReceiptSchema, DeleteSessionReceiptSchema]);
export const SessionManagementDetailsSchema = z.union([
  z.strictObject({ format: z.literal('medclaw.session-management/v1'), originalRequest: RenameSessionInputSchema, receipt: RenameSessionReceiptSchema }),
  z.strictObject({ format: z.literal('medclaw.session-management/v1'), originalRequest: DeleteSessionInputSchema, receipt: DeleteSessionReceiptSchema }),
]).refine(details => details.originalRequest.sessionId === details.receipt.session.id, 'Management receipt target differs from original request');
export const InputControlSchema = z.strictObject({ runId: PositiveIdSchema, acceptingInputs: z.boolean(), blockReasons: z.array(AppErrorSchema).max(32) });
export type InputControl = z.infer<typeof InputControlSchema>;
export const SessionViewSchema = z.strictObject({
  ...metadataFields, nativeSessionId: OpaqueIdSchema, kind: z.literal("user"),
  inputControl: InputControlSchema.nullable(), storageVersion: RevisionSchema, leafId: OpaqueIdSchema.nullable(), nextSubmissionSequence: PositiveIdSchema,
}).refine(session => (session.status === 'deleted') === (session.deletedAt !== null), 'Deletion time must match session lifecycle');
export const NewSessionResultSchema = z.strictObject({ session: SessionViewSchema, workspace: WorkspaceViewSchema });
export const ListSessionsRequestSchema = z.strictObject({ beforeSessionId: PositiveIdSchema.optional(), limit: z.number().int().min(1).max(50).default(20) });
export const SessionPageSchema = z.strictObject({ sessions: z.array(SessionViewSchema).max(50), nextBeforeSessionId: PositiveIdSchema.nullable() });
export const BasicMessagePreviewSchema = z.strictObject({
  nativeEntryId: OpaqueIdSchema, role: z.enum(["user", "assistant"]), text: z.string().max(8192),
  totalChars: RevisionSchema, truncated: z.boolean(),
});
export const SessionRuntimeViewSchema = z.strictObject({ availability: z.enum(['unloaded', 'ready', 'blocked']), error: AppErrorSchema.nullable() })
  .refine(value => value.availability === 'blocked' ? value.error !== null : value.error === null, 'Blocked instances require a safe error');
export type SessionRuntimeView = z.infer<typeof SessionRuntimeViewSchema>;
export const SessionDetailSchema = z.strictObject({
  compactionOperation:z.lazy(()=>CompactionOperationViewSchema).nullable().optional(),
  session: SessionViewSchema, runningRunId: PositiveIdSchema.nullable(),
  runtime:SessionRuntimeViewSchema,
  history: z.strictObject({ available: z.boolean(), reason: z.enum(["host_restart", "native_state_invalid", "history_not_recorded"]).nullable(),
    messages: z.array(BasicMessagePreviewSchema).max(32), truncated: z.boolean() }),
});
export const InputModeSchema = z.enum(["send", "steer", "follow_up"]);
export const ReadSessionCheckpointsInputSchema = z.strictObject({ sessionId: PositiveIdSchema, afterAnswerId: PositiveIdSchema.nullable().default(null), limit: PositiveIdSchema.max(100).default(50) });
export const SessionCheckpointSchema = z.strictObject({ answerId: PositiveIdSchema, runId: PositiveIdSchema, nativeLeafId: OpaqueIdSchema, committedAt: TimestampSchema,
  questionSummary: z.string().max(512), answerSummary: z.string().max(512), conditionSummary: z.null(), isCurrentBranch: z.boolean() });
export const SessionCheckpointPageSchema = z.strictObject({ sessionId: PositiveIdSchema, storageVersion: RevisionSchema, items: z.array(SessionCheckpointSchema).max(100), nextAnswerId: PositiveIdSchema.nullable(), hasMore: z.boolean() })
  .refine(page => page.hasMore ? page.items.length > 0 && page.nextAnswerId === page.items.at(-1)!.answerId : page.nextAnswerId === null, 'Checkpoint cursor must identify the last returned eligible answer');
export const RestoreSessionCheckpointInputSchema = z.strictObject({ sessionId: PositiveIdSchema, targetLeafId: OpaqueIdSchema, expectedStorageVersion: RevisionSchema, expectedWorkspaceRevision: RevisionSchema });
export const SessionCheckpointReceiptSchema = z.strictObject({ operationRef: OpaqueIdSchema, sessionId: PositiveIdSchema, targetLeafId: OpaqueIdSchema, storageVersion: RevisionSchema.positive(), workspaceRevision: RevisionSchema.positive(), committedAt: TimestampSchema });
export const SessionCheckpointDetailsSchema = z.strictObject({ format: z.literal('medclaw.session-checkpoint/v1'), request: RestoreSessionCheckpointInputSchema,
  before: z.strictObject({ leafId: OpaqueIdSchema.nullable(), storageVersion: RevisionSchema, workspaceRevision: RevisionSchema }), receipt: SessionCheckpointReceiptSchema })
  .refine(value => value.request.sessionId === value.receipt.sessionId && value.request.targetLeafId === value.receipt.targetLeafId
    && value.request.expectedStorageVersion === value.before.storageVersion && value.request.expectedWorkspaceRevision === value.before.workspaceRevision
    && value.receipt.storageVersion === value.before.storageVersion + 1 && value.receipt.workspaceRevision === value.before.workspaceRevision + 1, 'Checkpoint receipt must match the original request and committed versions');
export const RestoreSessionInputSchema = z.strictObject({ sessionId: PositiveIdSchema, expectedLeafId: OpaqueIdSchema.nullable() });
export type ReadSessionCheckpointsInput = z.input<typeof ReadSessionCheckpointsInputSchema>;
export type SessionCheckpoint = z.infer<typeof SessionCheckpointSchema>;
export type SessionCheckpointPage = z.infer<typeof SessionCheckpointPageSchema>;
export type RestoreSessionCheckpointInput = z.infer<typeof RestoreSessionCheckpointInputSchema>;
export type SessionCheckpointReceipt = z.infer<typeof SessionCheckpointReceiptSchema>;
export type SessionCheckpointDetails = z.infer<typeof SessionCheckpointDetailsSchema>;
export type RestoreSessionInput = z.infer<typeof RestoreSessionInputSchema>;
/** Opaque locked-version native data; validated with public SDK types at runtime-pi. */
export const NATIVE_HISTORY_FORMAT = 'pi-session/3;pi-sdk/0.87.1';
export interface NativeHistorySnapshot { sessionId: number; nativeSessionId: string; header: unknown; entries: unknown[]; activeLeafId: string | null; storageVersion: number }
export interface NativeHistoryCommit { sessionId: number; runId: number | null; expectedStorageVersion: number; header: unknown; newEntries: unknown[]; activeLeafId: string | null }
export interface MemoryStore {
  load(sessionId: number): Promise<Result<NativeHistorySnapshot>>;
  commit(change: NativeHistoryCommit): Promise<Result<{ storageVersion: number }>>;
  listEntries(sessionId: number, afterSequence: number, limit: number): Promise<Result<unknown[]>>;
}
export const CompactSessionInputSchema = z.strictObject({ sessionId: PositiveIdSchema, expectedStorageVersion: RevisionSchema, model: ModelChoiceSchema });
export const ReadCompactionInputSchema = z.strictObject({ sessionId: PositiveIdSchema, operationRef: OpaqueIdSchema });
export const CompactionReasonSchema = z.enum(['manual', 'threshold', 'overflow']);
export const CompactionStatusSchema = z.enum(['running', 'completed', 'no_op', 'failed', 'cancelled', 'interrupted', 'unconfirmed']);
export const CompactionPhaseSchema = z.enum(['accepted', 'summarizing', 'saving', 'stopping', 'blocked', 'finished']);
const compactionIdentity = { contract: z.literal('medclaw.compaction/v1'), operationRef: OpaqueIdSchema, sessionId: PositiveIdSchema };
const compactionCallIds = z.array(OpaqueIdSchema).refine(ids => new Set(ids).size === ids.length, 'Duplicate compaction calls');
export const CompactionReceiptSchema = z.strictObject({
  ...compactionIdentity, runId: PositiveIdSchema.nullable(), reason: CompactionReasonSchema,
  status: z.enum(['completed', 'no_op', 'failed', 'cancelled', 'interrupted']), nativeGenerated: z.boolean().nullable(), nativeSaved: z.boolean(),
  nativeEntryId: OpaqueIdSchema.nullable(), firstKeptEntryId: OpaqueIdSchema.nullable(), tokensBefore: RevisionSchema.nullable(), estimatedTokensAfter: RevisionSchema.nullable(),
  baseStorageVersion: RevisionSchema, storageVersion: RevisionSchema.nullable(), activeLeafId: OpaqueIdSchema.nullable(), callIds: compactionCallIds,
  continuationEligibleAtCommit: z.boolean(), cancelRequestedAt: TimestampSchema.nullable(), stoppedAt: TimestampSchema, finishedAt: TimestampSchema,
  noOpReason: z.enum(['nothing_to_compact', 'already_compacted']).nullable(), error: AppErrorSchema.nullable(),
}).superRefine((receipt, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if ((receipt.reason === 'manual') !== (receipt.runId === null)) invalid('Compaction Run owner mismatch');
  if (receipt.nativeSaved && (receipt.nativeGenerated !== true || !receipt.nativeEntryId || !receipt.firstKeptEntryId || receipt.storageVersion === null || receipt.storageVersion <= receipt.baseStorageVersion)) invalid('Saved compaction requires native identity and committed version');
  if (!receipt.nativeSaved && receipt.storageVersion !== null) invalid('Unsaved compaction cannot claim a version');
  if (receipt.nativeGenerated === false && (receipt.nativeEntryId !== null || receipt.firstKeptEntryId !== null || receipt.tokensBefore !== null || receipt.estimatedTokensAfter !== null)) invalid('Ungenerated compaction cannot claim native result fields');
  if (receipt.status === 'completed' && (!receipt.nativeSaved || receipt.error !== null || receipt.noOpReason !== null || receipt.callIds.length === 0)) invalid('Completed compaction requires saved calls and history');
  if (receipt.status === 'no_op' && (receipt.nativeGenerated !== false || receipt.nativeSaved || receipt.callIds.length || !receipt.noOpReason || receipt.error !== null)) invalid('No-op cannot claim generation or model calls');
  if (receipt.status !== 'no_op' && receipt.noOpReason !== null) invalid('No-op reason requires no-op status');
  if (['failed', 'interrupted'].includes(receipt.status) && receipt.error === null) invalid('Failed compaction requires a safe error');
  if (['failed', 'cancelled', 'interrupted'].includes(receipt.status) && receipt.continuationEligibleAtCommit) invalid('Stopped compaction cannot continue');
  if (receipt.status === 'cancelled' && !receipt.cancelRequestedAt) invalid('Cancellation requires its original request');
});
export const CompactionOperationViewSchema = z.strictObject({
  calls:z.array(ModelCallViewSchema).max(50).default([]),
  ...compactionIdentity, status: CompactionStatusSchema, phase: CompactionPhaseSchema, revision: RevisionSchema,
  nativeGenerated: z.boolean().nullable(), nativeSaved: z.boolean(), canContinue: z.boolean(), receipt: CompactionReceiptSchema.nullable(), error: AppErrorSchema.nullable(),
}).superRefine((view, ctx) => {
  const receipt = view.receipt;
  if (receipt ? receipt.sessionId !== view.sessionId || receipt.operationRef !== view.operationRef || receipt.status !== view.status || receipt.nativeGenerated !== view.nativeGenerated || receipt.nativeSaved !== view.nativeSaved
    : !['running', 'unconfirmed'].includes(view.status) || view.nativeSaved) ctx.addIssue({ code: 'custom', message: 'Compaction view must match its original receipt' });
  if (view.canContinue && (view.status !== 'completed' && view.status !== 'no_op' || !receipt?.continuationEligibleAtCommit)) ctx.addIssue({ code: 'custom', message: 'Continuation requires an eligible original receipt' });
});
export const CancelCompactionResultSchema = z.strictObject({ operation: CompactionOperationViewSchema, disposition: z.enum(['requested', 'already_requested', 'already_finished']) });
export const CompactionCallOwnerSchema = z.strictObject({ operationRef: OpaqueIdSchema, sessionId: PositiveIdSchema, runId: PositiveIdSchema.nullable(), source: z.enum(['manual', 'auto']), reason: CompactionReasonSchema,
  model: ModelSelectionSchema, baseStorageVersion: RevisionSchema, baseLeafId: OpaqueIdSchema.nullable(), ordinal: PositiveIdSchema,
}).refine(owner => owner.source === 'manual' ? owner.runId === null && owner.reason === 'manual' : owner.runId !== null && owner.reason !== 'manual', 'Compaction call owner mismatch');
export const CompactionSaveFactSchema = z.strictObject({ operationRef: OpaqueIdSchema, sessionId: PositiveIdSchema, runId: PositiveIdSchema, reason: z.enum(['threshold', 'overflow']),
  nativeEntryId: OpaqueIdSchema, firstKeptEntryId: OpaqueIdSchema, tokensBefore: RevisionSchema, estimatedTokensAfter: RevisionSchema.nullable(), baseStorageVersion: RevisionSchema, callIds: compactionCallIds.min(1) });
export const FrozenCompactionSchema = z.strictObject({ model: ModelSelectionSchema, baseStorageVersion: RevisionSchema, baseLeafId: OpaqueIdSchema.nullable(),
  settings: z.strictObject({ enabled: z.boolean(), reserveTokens: PositiveIdSchema, keepRecentTokens: RevisionSchema }), budget: z.strictObject({ maxModelCalls: PositiveIdSchema, timeoutMs: PositiveIdSchema }), instanceId: OpaqueIdSchema, startedAt: TimestampSchema });
export const StoredCompactionOperationSchema = z.strictObject({ operationRef: OpaqueIdSchema, request: CompactSessionInputSchema, frozen: FrozenCompactionSchema, cancelRequestedAt: TimestampSchema.nullable(), receipt: CompactionReceiptSchema.nullable() })
  .refine(value => value.request.expectedStorageVersion === value.frozen.baseStorageVersion && (!value.receipt || value.receipt.operationRef === value.operationRef && value.receipt.sessionId === value.request.sessionId && value.receipt.reason === 'manual'), 'Compaction operation identity mismatch');
export type CompactSessionInput = z.infer<typeof CompactSessionInputSchema>;
export type ReadCompactionInput = z.infer<typeof ReadCompactionInputSchema>;
export type CompactionReason = z.infer<typeof CompactionReasonSchema>;
export type CompactionPhase = z.infer<typeof CompactionPhaseSchema>;
export type CompactionReceipt = z.infer<typeof CompactionReceiptSchema>;
export type CompactionOperationView = z.infer<typeof CompactionOperationViewSchema>;
export type CancelCompactionResult = z.infer<typeof CancelCompactionResultSchema>;
export type CompactionCallOwner = z.infer<typeof CompactionCallOwnerSchema>;
export const CompactionCallMetadataSchema = z.strictObject({ contract: z.literal('medclaw.compaction/v1'), operationRef: OpaqueIdSchema, source: z.enum(['manual','auto']), reason: CompactionReasonSchema,
  ordinal: PositiveIdSchema, baseStorageVersion: RevisionSchema, baseLeafId: OpaqueIdSchema.nullable(), nativeEntryId: OpaqueIdSchema.nullable(), savedStorageVersion: RevisionSchema.nullable(), operationEndedAt: TimestampSchema.nullable(), operationError: AppErrorSchema.nullable() })
  .refine(value => (value.source === 'manual') === (value.reason === 'manual') && (value.nativeEntryId === null) === (value.savedStorageVersion === null), 'Compaction call evidence mismatch');
export type CompactionSaveFact = z.infer<typeof CompactionSaveFactSchema>;
export type FrozenCompaction = z.infer<typeof FrozenCompactionSchema>;
export type StoredCompactionOperation = z.infer<typeof StoredCompactionOperationSchema>;
export type NativeCompactionObservation = { nativeGenerated: boolean; nativeIdle: true; change: NativeHistoryCommit | null; result: Pick<CompactionReceipt, 'nativeEntryId' | 'firstKeptEntryId' | 'tokensBefore' | 'estimatedTokensAfter' | 'callIds' | 'noOpReason' | 'error'> };
export type CompactionExecutionInput<Resolved> = { operationRef: string; sessionId: number; resolved: Resolved; frozen: FrozenCompaction; signal: AbortSignal; deadlineAt: number };
export type CompactionCallbacks = { startCall: (time: string, ordinal: number) => import('./run').ModelCallRecorderPort; finishCall: (fact: import('./run').FinalCallFact) => void; progress: (phase: CompactionPhase) => void };
export type AutoCompactionCallbacks = { begin: (reason: 'threshold' | 'overflow', time: string) => string; startCall: (operationRef: string, time: string, ordinal: number) => import('./run').ModelCallRecorderPort;
  finishCall: (operationRef: string, fact: import('./run').FinalCallFact) => void; save: (change: NativeHistoryCommit, fact: CompactionSaveFact) => number; failed: (operationRef: string, error: AppError, endedAt: string, nativeGenerated?:boolean) => void; progress: (operationRef: string, phase: CompactionPhase) => void };
export type RestoreDiscardProof = { sessionId: number; operationRef: string; nativeIdle: true; nativeQueuesEmpty: true; observersSettled: true; requiredCallFactsSaved: true; persistentSnapshot: NativeHistorySnapshot };
export const InputStatusSchema = z.enum(["queued", "consumed", "failed", "cancelled", "delivery_unknown"]);
export const InputProcessingStatusSchema = z.enum(["pending", "completed", "failed", "cancelled"]);
const submissionFields = {
  clientSequence: PositiveIdSchema.max(Number.MAX_SAFE_INTEGER - 1), sessionId: PositiveIdSchema, text: z.string().refine(text => text.trim().length > 0, "Text must not be blank"),
  expectedRevision: RevisionSchema, expectedBatchIds: z.array(PositiveIdSchema).refine(ids => new Set(ids).size === ids.length, "Duplicate batches"),
  expectedQueryId: PositiveIdSchema.nullable(), model: ModelChoiceSchema, referenceDate: ReferenceDateSchema, timezone: TimezoneSchema,
};
export const SubmitInputSchema = z.discriminatedUnion("mode", [
  z.strictObject({ ...submissionFields, mode: z.literal("send") }),
  z.strictObject({ ...submissionFields, mode: z.literal("steer"), targetRunId: PositiveIdSchema }),
  z.strictObject({ ...submissionFields, mode: z.literal("follow_up"), targetRunId: PositiveIdSchema }),
]);
const resultFields = { sessionId: PositiveIdSchema, clientSequence: PositiveIdSchema };
export const SubmitResultSchema = z.union([
  z.strictObject({ ...resultFields, inputId: z.null(), runId: PositiveIdSchema }),
  z.strictObject({ ...resultFields, inputId: PositiveIdSchema, runId: PositiveIdSchema.nullable() }),
]);
export const ReadInputRequestSchema = z.union([z.strictObject({ inputId: PositiveIdSchema }), z.strictObject(resultFields)]);
export const ListInputsRequestSchema = z.strictObject({ sessionId: PositiveIdSchema, afterClientSequence: PositiveIdSchema.nullable().default(null), limit: z.number().int().min(1).max(100).default(50) });
export const CancelInputRequestSchema = z.strictObject({ inputId: PositiveIdSchema });
export const MAX_INPUT_TEXT_CHARS = 8192;
export const MAX_INPUT_PAGE_BYTES = 3 * 1024 * 1024;
export const SessionInputSchema = z.strictObject({
  id: PositiveIdSchema, sessionId: PositiveIdSchema, clientSequence: PositiveIdSchema, mode: InputModeSchema,
  text: z.string().max(MAX_INPUT_TEXT_CHARS), textInfo: z.strictObject({ totalChars: RevisionSchema, truncated: z.boolean() }), workspaceContext: WorkspaceContextSchema.nullable(),
  status: InputStatusSchema, processingStatus: InputProcessingStatusSchema, targetRunId: PositiveIdSchema.nullable(), runId: PositiveIdSchema.nullable(), nativeEntryId: OpaqueIdSchema.nullable(),
  deliveredAt: TimestampSchema.nullable(), processedAt: TimestampSchema.nullable(), createdAt: TimestampSchema, updatedAt: TimestampSchema, error: AppErrorSchema.nullable(),
}).superRefine((input, ctx) => {
  const valid = input.status === "consumed" || input.status === "queued" && input.processingStatus === "pending"
    || input.status === "failed" && input.processingStatus === "failed" || input.status === "cancelled" && input.processingStatus === "cancelled"
    || input.status === "delivery_unknown" && input.processingStatus !== "completed";
  if (!valid) ctx.addIssue({ code: "custom", message: "Invalid input state combination" });
  if ((input.processingStatus === "pending") !== (input.processedAt === null)) ctx.addIssue({ code: "custom", message: "Processing time must match processing state" });
  if (input.status === "consumed" && (input.runId === null || input.nativeEntryId === null || input.targetRunId !== input.runId)) ctx.addIssue({ code: "custom", message: "Consumption requires original Run and native entry evidence" });
  if (input.status !== "consumed" && (input.runId !== null || input.nativeEntryId !== null)) ctx.addIssue({ code: "custom", message: "Unconsumed input cannot claim native consumption" });
  if (input.textInfo.truncated ? input.textInfo.totalChars <= input.text.length : input.textInfo.totalChars !== input.text.length) ctx.addIssue({ code: "custom", message: "Inconsistent input preview" });
});
export const SessionInputPageSchema = z.strictObject({ sessionId: PositiveIdSchema, items: z.array(SessionInputSchema).max(100), nextClientSequence: PositiveIdSchema.nullable(), hasMore: z.boolean() })
  .refine(page => new TextEncoder().encode(JSON.stringify(page)).byteLength <= MAX_INPUT_PAGE_BYTES, "Input page exceeds UTF-8 JSON budget")
  .refine(page => page.items.every((item, index) => item.sessionId === page.sessionId && (!index || item.clientSequence > page.items[index - 1]!.clientSequence))
    && (page.hasMore ? page.items.length > 0 && page.nextClientSequence === page.items.at(-1)!.clientSequence : page.nextClientSequence === null), "Inconsistent input page cursor or ownership");
export const InputContentSchema = z.strictObject({ contract: z.literal("medclaw.session-input/v1"), originalSubmitInput: SubmitInputSchema,
  text: z.string(), workspaceContext: WorkspaceContextSchema, scope: RunScopeSchema, model: ModelSelectionSchema, referenceDate: ReferenceDateSchema, timezone: TimezoneSchema,
  deliveryAttempt: z.strictObject({ instanceId: OpaqueIdSchema, startedAt: TimestampSchema }).nullable(),
  resourceInputPlan: ResourceInputPlanSchema.optional(), nativeInput: NativeInputReceiptSchema.optional() })
  .refine(c => !c.resourceInputPlan || c.text === c.originalSubmitInput.text && c.text.isWellFormed()
    && new TextEncoder().encode(JSON.stringify(c)).byteLength <= (c.nativeInput ? RESOURCE_LIMITS.inputSavedBytes : RESOURCE_LIMITS.inputAcceptBytes), 'P11 input identity or capacity mismatch')
  .refine(c => !c.nativeInput || !!c.resourceInputPlan, 'Native receipt requires original resource input plan');
export type InputContent = z.infer<typeof InputContentSchema>;
export type InputMode = z.infer<typeof InputModeSchema>;
export type InputStatus = z.infer<typeof InputStatusSchema>;
export type InputProcessingStatus = z.infer<typeof InputProcessingStatusSchema>;
export type SessionInput = z.infer<typeof SessionInputSchema>;
export type SessionInputPage = z.infer<typeof SessionInputPageSchema>;
export type ReadInputRequest = z.infer<typeof ReadInputRequestSchema>;
export type ListInputsRequest = z.input<typeof ListInputsRequestSchema>;
export type CancelInputRequest = z.infer<typeof CancelInputRequestSchema>;
export interface InputBinding { inputId: number; sessionId: number; targetRunId: number; mode: InputMode; text: string; stopEpoch: number; workspaceContext?: WorkspaceContext; inputPlan?: ResourceInputPlan; nativeReceiptLimitBytes?: number }
export type ConsumedWorkspace = { inputId: number; nativeEntryId: string; workspaceContext: WorkspaceContext };
export type InputCancelProof = { kind: "removed"; inputId: number; runId: number; at: string }
  | { kind: "consumed"; inputId: number; runId: number; nativeEntryId: string } | { kind: "unknown"; inputId: number; error: AppError };
export interface InputSettlementProof { runId: number; admissionClosed: boolean; preflightSettled: boolean; nativeIdle: boolean; nativeQueuesEmpty: boolean; pendingPersistence: boolean;
  removals: Extract<InputCancelProof, { kind: "removed" }>[]; unconfirmedInputIds: number[] }
export interface InputAdapterPort { deliver(input: InputBinding): Promise<void>; cancel(inputId: number): Promise<InputCancelProof>;
  close(runId: number, outcome: "completed" | "failed" | "cancelled"): Promise<InputSettlementProof>; persistencePending(runId: number): boolean; retryPersistence(runId: number): void;
  readConsumedWorkspace?(runId: number): ConsumedWorkspace | null }
export type PreparedInput = { operationRef: string; originalSubmitInput: SubmitInput; content: InputContent; createdAt: string;
  execution: { mode: "send"; run: Omit<RegisterAgentInput, "inputId" | "submission"> } | { mode: "steer" | "follow_up"; targetRunId: number } };
export interface InputStore {
  /** Same-Session facts for original native history entries, before Provider delivery. */
  readResourceOrigins?(sessionId: number, nativeEntryIds: readonly string[]): import('./resources').ResourceEvidence[];
  acceptInput(plan: PreparedInput): SubmitResult;
  beginInputDelivery(inputId: number, instanceId: string, at: string): void;
  recordInputDelivery(inputId: number, at: string): void;
  recordInputConsumption(inputId: number, fact: { sessionId: number; runId: number; nativeEntryId: string; at: string; nativeInput?: NativeInputReceipt }): void;
  recordInputFailure(inputId: number, fact: { sessionId: number; targetRunId: number; at: string; error: AppError;
    proof: { kind: "not_consumed"; reason: "hook_handled" | "dispatch_rejected" | "start_failed" } | { kind: "delivery_unknown"; reason: "append_failed" | "delivery_unconfirmed" | "remove_unconfirmed" } }): void;
  recordInputCancellation(proof: InputCancelProof, at: string): SessionInput;
  readInput(input: ReadInputRequest): SessionInput | null;
  listInputs(input: ListInputsRequest): SessionInputPage;
  inputsForRun(runId: number): SessionInput[];
  settleRunInputs(runId: number, status: "completed" | "failed" | "cancelled", at: string, proof: InputSettlementProof): void;
}
export const ReadSubmissionRequestSchema = z.strictObject({ sessionId: PositiveIdSchema, clientSequence: PositiveIdSchema });
export type NewSessionInput = z.input<typeof NewSessionInputSchema>;
export type RenameSessionInput = z.infer<typeof RenameSessionInputSchema>;
export type DeleteSessionInput = z.infer<typeof DeleteSessionInputSchema>;
export type ReadManagementOperationInput = z.infer<typeof ReadManagementOperationInputSchema>;
export type SessionMetadataView = z.infer<typeof SessionMetadataViewSchema>;
export type SessionManagementReceipt = z.infer<typeof SessionManagementReceiptSchema>;
export type SessionManagementDetails = z.infer<typeof SessionManagementDetailsSchema>;
export type SelectSessionInput = z.infer<typeof SelectSessionInputSchema>;
export type SessionView = z.infer<typeof SessionViewSchema>;
export type NewSessionResult = z.infer<typeof NewSessionResultSchema>;
export type SessionPage = z.infer<typeof SessionPageSchema>;
export type SessionDetail = z.infer<typeof SessionDetailSchema>;
export type BasicMessagePreview = z.infer<typeof BasicMessagePreviewSchema>;
export type SubmitInput = z.infer<typeof SubmitInputSchema>;
export type SubmitResult = z.infer<typeof SubmitResultSchema>;
export type ReadSubmissionRequest = z.infer<typeof ReadSubmissionRequestSchema>;
export type NativeSessionPreview = SessionDetail["history"] & { leafId: string | null;storageVersion:number };
export type InitialNativeHistory = Pick<NativeHistorySnapshot,'header'|'entries'|'activeLeafId'>;
export type NativeSessionBindings = {
  allocate: () => { nativeSessionId: string; history:InitialNativeHistory; bind: (sessionId: number) => void; discard: () => void };
  read: (sessionId: number) => Promise<NativeSessionPreview>;
  readMessages: (input: ReadSessionMessagesInput) => Promise<SessionMessagePage>;
  ensureLoaded: (sessionId:number)=>Promise<void>;
  restore: (sessionId:number)=>Promise<void>;
  discardCompactionForRestore?:(proof:Omit<RestoreDiscardProof,'persistentSnapshot'>)=>Promise<void>;
  readAvailability: (sessionId:number)=>SessionRuntimeView;
};
/** Product persistence port; native SDK objects stay in the Host's adapter. */
export interface SessionStore extends Pick<InputStore, "readInput" | "listInputs"> {
  acceptCompaction(request: CompactSessionInput, operationRef: string, frozen: FrozenCompaction): StoredCompactionOperation;
  readCompactionOperation(input: ReadCompactionInput): StoredCompactionOperation | null;
  requestCompactionCancel(input: ReadCompactionInput, requestedAt: string): boolean;
  startCompactionCall(input: {callId: string; owner: CompactionCallOwner; startedAt: string}): void;
  finishCompactionCall(owner: CompactionCallOwner, fact: import('./run').FinalCallFact): void;
  commitCompactionInTransaction(change: NativeHistoryCommit | null, fact: CompactionReceipt | CompactionSaveFact): number;
  createSession(input: NewSessionInput, operationRef: string, nativeSessionId: string, time: string, initialHistory:InitialNativeHistory): NewSessionResult;
  selectSession(input: SelectSessionInput, time: string): WorkspaceView;
  renameSession(input: RenameSessionInput, operationRef: string, time: string): SessionManagementReceipt;
  deleteSession(input: DeleteSessionInput, operationRef: string, time: string): SessionManagementReceipt;
  readManagementOperation(input: ReadManagementOperationInput): SessionManagementReceipt | null;
  readCheckpoints(input:ReadSessionCheckpointsInput):SessionCheckpointPage;
  restoreCheckpointInTransaction(input:RestoreSessionCheckpointInput,operationRef:string,time:string):SessionCheckpointReceipt;
  readCheckpointOperation(operationRef:string):{request:RestoreSessionCheckpointInput;receipt:SessionCheckpointReceipt}|null;
  assertHistoryMutationAllowed(sessionId:number):void;
  readSession(sessionId: number): SessionView | null;
  listSessions(input: { beforeSessionId?: number; limit?: number }): SessionPage;
  readWorkspace(): WorkspaceView;
  updateWorkspace(change: WorkspaceChange, expectedRevision: number, time: string): WorkspaceView;
  findOperation(operationRef: string): StoredOperation | null;
  findSubmission(input: ReadSubmissionRequest): SubmitResult | null;
  readMessageInputLinks(sessionId: number, nativeEntryIds: readonly string[]): Map<string, { inputId: number; runId: number }>;
  readMessageLinks(sessionId: number, nativeEntryIds: readonly string[]): Map<string, { runId: number; toolCallRef: string | null; references: string[] }>;
  active(): RunHandle | null;
}
