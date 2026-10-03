import type { StreamSnapshot, StreamSnapshotReader } from './event';
import { z } from "zod";
import { AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema } from "./error";
import { AgentPolicySchema, BudgetSummarySchema, MeasurementContextSchema, ModelSelectionSchema, ReferenceDateSchema, RequestPolicySchema, TimezoneSchema, ToolProfileSnapshotSchema } from "./model";
import type { AppError } from "./error";
import type { AgentPolicy, BudgetSummary, DiagnoseRequest, MeasurementContext, ModelSelection, ProviderAccepted, ProviderRequest, RequestPolicy, ToolProfileSnapshot } from "./model";
import type { NewSessionInput, NewSessionResult, SubmitInput, SubmitResult, SessionStore, InputStore, InputAdapterPort, InputSettlementProof, InputControl } from "./session";
import type { WorkspaceView } from "./workspace";
import { StoredToolConfigurationSchema, type ToolConfiguration } from './tool-config';
import { RuntimeConfigurationSchema, type RuntimeConfiguration } from './runtime-config';

export const RunStatusSchema = z.enum(["created", "running", "completed", "failed", "cancelled"]);
export const SdkStopReasonSchema = z.enum(["stop", "length", "toolUse", "error", "aborted", "deferred"]);
export const RunScopeSchema = z.strictObject({
  batchIds: z.array(PositiveIdSchema), deviceIds: z.array(PositiveIdSchema).nullable(),
  allowedToolNames: z.array(z.string().min(1).max(256)).max(1000), allowedResourceRefs: z.array(z.string().min(1).max(256)).max(1000),
  artifactIds: z.array(PositiveIdSchema).max(10000), readOnly: z.boolean(),
});
const nullableAmount = z.number().finite().nonnegative().nullable();
const nullableToken = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const safeLabel = z.string().min(1).max(256);
export const ModelCallViewSchema = z.strictObject({
  id: PositiveIdSchema, inputId: PositiveIdSchema.nullable().default(null), callId: OpaqueIdSchema, kind: z.enum(["main", "diagnostic"]), state: z.enum(["started", "completed", "failed", "cancelled"]),
  granularity: z.literal("logical_request"), attempt: z.literal(1), attemptCountUnknown: z.literal(true), model: ModelSelectionSchema,
  responseModel: z.string().min(1).max(256).nullable(), sdkStopReason: SdkStopReasonSchema.nullable(),
  startedAt: TimestampSchema, endedAt: TimestampSchema.nullable(), durationMs: nullableAmount,
  inputTokens: nullableToken, outputTokens: nullableToken, cost: nullableAmount, costCurrency: z.literal("USD").nullable(),
  usageSource: safeLabel.nullable(), unavailableReason: safeLabel.nullable(), error: AppErrorSchema.nullable(),
});
const pageSchema = (limit: number) => z.strictObject({
  text: z.string().max(limit), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nextOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(), totalChars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).refine(page => page.offset <= page.totalChars && page.offset + page.text.length <= page.totalChars
  && (page.nextOffset === null ? page.offset + page.text.length === page.totalChars : page.nextOffset === page.offset + page.text.length && page.nextOffset < page.totalChars), "Inconsistent output page");
export const OutputPageSchema = pageSchema(32768);
export const InputPageSchema = pageSchema(65536);
export const RunCleanupRecordSchema = z.strictObject({
  contract: z.literal("medclaw.run-cleanup/v1"), executionStarted: z.boolean().nullable(), stopConfirmed: z.boolean().nullable(),
  requiredPersistenceComplete: z.boolean().nullable(), inputsSettled: z.boolean().nullable(), resourcesReleased: z.boolean().nullable(),
  unconfirmedItems: z.array(z.string().min(1).max(64).regex(/^[a-z][a-z0-9_.:-]*$/)).max(32),
  secondaryErrors: z.array(AppErrorSchema).max(32), verifiedAt: TimestampSchema.nullable(),
  budgetSummary: BudgetSummarySchema.nullable().optional(),
});
export const RunCleanupSummarySchema = RunCleanupRecordSchema.omit({ contract: true, unconfirmedItems: true, secondaryErrors: true }).extend({
  unconfirmedCount: z.number().int().min(0).max(32), secondaryErrorCount: z.number().int().min(0).max(32),
});
const runFields = {
  id: PositiveIdSchema, status: RunStatusSchema, operationRef: OpaqueIdSchema, instanceId: OpaqueIdSchema, inputId: z.null(),
  inputText: z.string().max(65536), inputPage: InputPageSchema, runtimeConfiguration: RuntimeConfigurationSchema.nullable().optional(), model: ModelSelectionSchema, policy: RequestPolicySchema, priorRunId: PositiveIdSchema.nullable(),
  referenceDate: ReferenceDateSchema, timezone: TimezoneSchema, createdAt: TimestampSchema, startedAt: TimestampSchema.nullable(),
  cancelRequestedAt: TimestampSchema.nullable(), stoppedAt: TimestampSchema.nullable(), endedAt: TimestampSchema.nullable(), error: AppErrorSchema.nullable(),
  cleanup: RunCleanupRecordSchema.nullable(), answerRef: PositiveIdSchema.nullable(), output: OutputPageSchema, persistence: z.literal("committed"),
};
export const ProviderRunViewSchema = z.strictObject({ ...runFields, kind: z.literal("provider"), sessionId: z.null(),
  goal: z.enum(["answer", "verify"]), calls: z.array(ModelCallViewSchema).max(1) });
export const AgentRunViewSchema = z.strictObject({ ...runFields, inputId: PositiveIdSchema.nullable(), kind: z.literal("agent"), sessionId: PositiveIdSchema,
  clientSequence: PositiveIdSchema, nativeSessionId: OpaqueIdSchema, goal: z.literal("answer"),
  calls: z.array(ModelCallViewSchema).max(50), nextCallOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  control: z.strictObject({
    toolConfiguration: StoredToolConfigurationSchema.nullable().optional(),
    runtimeConfiguration: RuntimeConfigurationSchema.nullable().optional(),
    agentPolicy: AgentPolicySchema.nullable(),
    measurementContext: MeasurementContextSchema.nullable(),
    toolProfileSnapshot: ToolProfileSnapshotSchema.nullable(),
  }).nullable().optional(),
});
export const RunViewSchema = z.discriminatedUnion("kind", [ProviderRunViewSchema, AgentRunViewSchema]);
const outputPaging = { outputOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0), outputLimit: z.number().int().min(1).max(32768).default(16384) };
const onePaging = { ...outputPaging, inputOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  inputLimit: z.number().int().min(1).max(65536).default(65536), callOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  callLimit: z.number().int().min(1).max(50).default(20) };
export const ReadRunRequestSchema = z.union([
  z.strictObject({ runId: PositiveIdSchema, ...onePaging }),
  z.strictObject({ operationRef: OpaqueIdSchema, ...onePaging }),
  z.strictObject({ recent: z.literal(true), beforeRunId: PositiveIdSchema.optional(), limit: z.number().int().min(1).max(50).default(20),
    sessionId: PositiveIdSchema.optional(), kind: z.enum(["provider", "agent"]).optional() }),
]);
const recentFields = { inputText: z.string().max(2048), cleanupSummary: RunCleanupSummarySchema.nullable() };
export const RecentRunViewSchema = z.discriminatedUnion("kind", [
  ProviderRunViewSchema.omit({ output: true, inputPage: true, calls: true, cleanup: true }).extend(recentFields),
  AgentRunViewSchema.omit({ output: true, inputPage: true, calls: true, cleanup: true, nextCallOffset: true }).extend(recentFields),
]);
export const ReadRunResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("one"), run: RunViewSchema.nullable() }),
  z.strictObject({ kind: z.literal("recent"), runs: z.array(RecentRunViewSchema).max(50), nextBeforeRunId: PositiveIdSchema.nullable() }),
]);
export const CancelRunResultSchema = z.strictObject({
  runId: PositiveIdSchema, cancelRequested: z.boolean(), stopped: z.boolean(), committedStatus: RunStatusSchema, persistencePending: z.boolean(),
});
export const RunHandleSchema = z.strictObject({ runId: PositiveIdSchema, kind: z.enum(["provider", "agent"]), sessionId: PositiveIdSchema.nullable() });
export const ActiveRunViewSchema = RunHandleSchema.extend({ persistencePending: z.boolean(), stopPending: z.boolean() });
const budgetCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const callBudgetSchema = z.strictObject({
  limit: PositiveIdSchema,
  used: budgetCount,
  remaining: budgetCount,
});
export const RuntimeBudgetViewSchema = z.strictObject({
  runId: PositiveIdSchema,
  toolCalls: callBudgetSchema,
  modelCalls: callBudgetSchema,
  remainingTimeMs: z.number().finite().nonnegative().nullable(),
  recovery: z.strictObject({
    episodeId: OpaqueIdSchema.nullable(),
    used: budgetCount,
    remaining: budgetCount,
    unresolvedItems: z.array(z.string().min(1).max(256)).max(1000),
  }),
});
export const RuntimeControlViewSchema = z.strictObject({ instanceId: OpaqueIdSchema, activeRootRun: RunHandleSchema.nullable(),
  acceptingNewRuns: z.boolean(), blockReasons: z.array(AppErrorSchema).max(32), budget: RuntimeBudgetViewSchema.nullable().optional() });
export const UsageViewSchema = z.strictObject({
  inputTokens: nullableToken, outputTokens: nullableToken, cost: nullableAmount, costCurrency: z.literal("USD").nullable(),
  source: z.literal("pi_normalized").nullable(), unavailableReason: safeLabel.nullable(),
});
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RunHandle = z.infer<typeof RunHandleSchema>;
export type RuntimeControlView = z.infer<typeof RuntimeControlViewSchema>;
export type RuntimeBudgetView = z.infer<typeof RuntimeBudgetViewSchema>;
export type RunCleanupRecord = z.infer<typeof RunCleanupRecordSchema>;
export type RunScope = z.infer<typeof RunScopeSchema>;
export type ModelCallView = z.infer<typeof ModelCallViewSchema>;
export type RunView = z.infer<typeof RunViewSchema>;
export type ReadRunRequest = z.infer<typeof ReadRunRequestSchema>;
export type ReadRunResult = z.infer<typeof ReadRunResultSchema>;
export type CancelRunResult = z.infer<typeof CancelRunResultSchema>;
export type ActiveRunView = z.infer<typeof ActiveRunViewSchema>;
export type UsageView = z.infer<typeof UsageViewSchema>;
export type OutputPage = z.infer<typeof OutputPageSchema>;
export const P2AgentOptionsSchema = z.strictObject({ requestedThinkingLevel: z.literal("off"),
  effectiveThinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]) });
export type P2AgentOptions = z.infer<typeof P2AgentOptionsSchema>;

/** Internal Run facts and ports, injected by Host; they are not public IPC payloads. */
export interface ProviderUsageDetails {
  source?: string | null; unavailableReason?: string | null;
  cacheRead?: number | null; cacheWrite?: number | null; cacheWrite1h?: number | null;
  reasoning?: number | null; totalTokens?: number | null; costSource?: string | null;
}
export interface ProviderOutcome {
  sdkStopReason: z.infer<typeof SdkStopReasonSchema> | "pending";
  text: string; responseModel: string | null;
  callState: "completed" | "failed" | "cancelled";
  usage: UsageView; usageDetails?: ProviderUsageDetails;
  error: AppError | null;
}
export interface RegisterProviderInput {
  operationRef: string; method: "model.request" | "model.diagnose";
  originalRequest: ProviderRequest | DiagnoseRequest;
  instanceId: string; goal: "answer" | "verify"; inputText: string;
  selection: ModelSelection; policy: RequestPolicy; runtimeConfiguration?: RuntimeConfiguration;
  referenceDate: string; timezone: string; priorRunId?: number; createdAt: string;
}
export interface ProviderOperation {
  runId: number; operationRef: string; method: "model.request" | "model.diagnose";
  originalRequest: ProviderRequest | DiagnoseRequest; run: RunView;
}
export type FinalCallFact = Pick<ModelCallView,
  "callId" | "state" | "responseModel" | "sdkStopReason" | "endedAt" | "durationMs" |
  "inputTokens" | "outputTokens" | "cost" | "costCurrency" | "usageSource" | "unavailableReason" | "error"
> & { state: "completed" | "failed" | "cancelled" };
export interface FinalProviderFact {
  status: "completed" | "failed" | "cancelled"; outputText: string | null;
  stoppedAt: string | null; endedAt: string; cancelRequestedAt?: string | null;
  error: AppError | null; call?: FinalCallFact;
  usage?: ProviderUsageDetails | null;
  cleanup?: RunCleanupRecord | { oldProcessExited?: boolean; observationGap?: boolean; previousInstanceId?: string; errors?: AppError[] } | null;
}
interface AgentStartCommon {
  sessionId: number; text: string; model: ModelSelection; policy: RequestPolicy; goal: "answer";
  workspace: WorkspaceView; scope: RunScope; referenceDate: string; timezone: string; timeoutMs: number; agentOptions: P2AgentOptions;
  agentPolicy?: AgentPolicy;
  runtimeConfiguration?: RuntimeConfiguration;
  toolConfiguration?: ToolConfiguration;
  measurementContext?: MeasurementContext;
  toolProfileSnapshot?: ToolProfileSnapshot;
}
export type AgentStartFields = AgentStartCommon & ({ inputId: null; submission: { operationRef: string; originalSubmitInput: SubmitInput } } | { inputId: number; submission: null });
export type StartRunInput<Resolved> = AgentStartFields & { resolved: Resolved };
export type RegisterAgentInput = AgentStartFields & { instanceId: string; createdAt: string };
export type AgentExecutionObservation = { nativeIdle: true; lastOutcome: ProviderOutcome | null; calls: FinalCallFact[]; budgetSummary?: BudgetSummary; inputSettlement?: InputSettlementProof };
export type AgentRuntimePort<Resolved> = {
  readSnapshots?: StreamSnapshotReader["readSnapshots"];
  readonly inputAdapter?: InputAdapterPort;
  readInputControl?: (runId: number) => InputControl | null;
  inputPersistencePending?: (runId: number) => boolean;
  retryInputPersistence?: (runId: number) => void;
  releaseInputFacts?: (runId: number) => void;
  readonly toolNames?: readonly string[];
  toolPersistencePending?: (runId: number) => boolean;
  retryToolPersistence?: (runId: number) => void;
  releaseToolFacts?: (runId: number) => void;
  captureToolProfiles?: (scope: RunScope) => { measurementContext: MeasurementContext; toolProfileSnapshot: ToolProfileSnapshot };
  readBudget?: (runId: number) => RuntimeBudgetView | null;
  describe: (resolved: Resolved) => P2AgentOptions;
  execute: (input: { runId: number; sessionId: number; inputId?: number | null; text: string; resolved: Resolved; agentOptions: P2AgentOptions; signal: AbortSignal; deadlineAt: number;
    scope?: RunScope; referenceDate?: string; timezone?: string; agentPolicy?: AgentPolicy; runtimeConfiguration?: RuntimeConfiguration; toolConfiguration?: ToolConfiguration; measurementContext?: MeasurementContext; toolProfileSnapshot?: ToolProfileSnapshot },
    callbacks: { stream?: (snapshot: StreamSnapshot) => void; startCall: (time: string) => ModelCallRecorderPort; preview: (text: string) => void; nativeTerminal: (outcome: ProviderOutcome) => void;
      fatal?: (error: AppError) => void; inputStore?: InputStore; admissionClosed?: () => void }) => Promise<AgentExecutionObservation>;
};
export type FinalAgentFact = Omit<FinalProviderFact, "call" | "cleanup"> & { calls: FinalCallFact[]; cleanup: RunCleanupRecord; inputSettlement?: InputSettlementProof };
export type StoredOperation = ProviderOperation
  | { method: "session.create"; operationRef: string; originalRequest: NewSessionInput; result: NewSessionResult }
  | { method: "session.submit"; operationRef: string; originalRequest: SubmitInput; result: SubmitResult };
export function canonicalRequest(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
    : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, val]) => [key, ordered(val)])) : item;
  return JSON.stringify(ordered(value));
}
export interface ProviderRunStore {
  findProviderOperation(operationRef: string): ProviderOperation | null;
  registerProvider(input: RegisterProviderInput): ProviderAccepted;
  startCall(runId: number, callId: string, kind: "main" | "diagnostic", time: string): void;
  requestCancel(runId: number, time: string): boolean;
  finalizeProvider(runId: number, fact: FinalProviderFact): RunView;
  read(request: z.input<typeof ReadRunRequestSchema>): ReadRunResult;
  active(): RunHandle | null;
}
export interface RuntimeRunStore extends ProviderRunStore, SessionStore, InputStore {
  freezeAgentScope(workspace: WorkspaceView, toolNames: readonly string[]): RunScope;
  registerAgent(input: RegisterAgentInput): SubmitResult;
  finalizeAgent(runId: number, fact: FinalAgentFact): RunView;
  isFinalSaved(runId: number, fact: FinalProviderFact | FinalAgentFact): boolean;
  checkpointFailure(runId: number, error: AppError, cleanup: RunCleanupRecord, time: string): void;
  saveRunCleanup(runId: number, cleanup: RunCleanupRecord): void;
  recoveryCandidates(instanceId: string): RunView[];
  verifyPriorInputFacts?(runId: number, previousProcessExited: boolean, time: string): { inputsSettled: boolean; requiredPersistenceComplete: boolean; unconfirmedItems: string[] };
  verifyPriorToolFacts?(runId: number, previousProcessExited: boolean, time: string): {
    stopConfirmed: boolean | null; requiredPersistenceComplete: boolean; unconfirmedItems: string[];
  };
  recoverInterrupted(instanceId: string, time: string): number;
}
export interface ModelCallRecorderPort {
  readonly callId?: string;
  finish(outcome: ProviderOutcome, endedAt: string): FinalCallFact;
}
export type ModelCallStarter = (runId: number, kind: "main" | "diagnostic", time: string) => ModelCallRecorderPort;

/** Pi initializes omitted usage fields to zero; zero alone does not establish usage or free pricing. */
export function safeUsage(value: unknown, pricingKnown: boolean): UsageView {
  const usage = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const knownPositive = (field: unknown) => typeof field === "number" && Number.isSafeInteger(field) && field > 0 ? field : null;
  const inputTokens = knownPositive(usage.input);
  const outputTokens = knownPositive(usage.output);
  const costData = typeof usage.cost === "object" && usage.cost !== null ? usage.cost as Record<string, unknown> : {};
  const total = costData.total;
  const observed = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(field => knownPositive(field) !== null);
  const cost = pricingKnown && observed && typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null;
  return { inputTokens, outputTokens, cost, costCurrency: cost === null ? null : "USD", source: "pi_normalized",
    unavailableReason: !observed ? "pi_normalized_zero_or_missing" : inputTokens === null || outputTokens === null ? "pi_normalized_partial" : cost === null ? "pricing_unknown" : null };
}

const highSurrogate = (value: number) => value >= 0xd800 && value <= 0xdbff;
const lowSurrogate = (value: number) => value >= 0xdc00 && value <= 0xdfff;
export function sliceText(text: string, offset: number, limit: number, maxLimit: number): OutputPage {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit
    || offset > text.length || offset > 0 && highSurrogate(text.charCodeAt(offset - 1)) && lowSurrogate(text.charCodeAt(offset))) throw new RangeError("Invalid text page");
  let end = Math.min(text.length, offset + limit);
  if (end < text.length && highSurrogate(text.charCodeAt(end - 1)) && lowSurrogate(text.charCodeAt(end))) end = end - offset === 1 ? end + 1 : end - 1;
  return { text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalChars: text.length };
}
export function sliceOutput(text: string, offset = 0, limit = 16384): OutputPage { return sliceText(text, offset, limit, 32768); }
export function safePreview(text: string, limit = 32768): { text: string; truncated: boolean } {
  let end = Math.min(text.length, limit);
  if (end < text.length && highSurrogate(text.charCodeAt(end - 1)) && lowSurrogate(text.charCodeAt(end))) end--;
  return { text: text.slice(0, end), truncated: end < text.length };
}
