import { z } from "zod";
import { AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema } from "./error";
import type { AppError } from "./error";
import type { ProviderOutcome } from "./run";

export const SDK_VERSION = "0.87.1" as const;
export const SETTINGS_SCHEMA_VERSION = "medclaw.settings/p1-v1" as const;
const nonblank = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), "Expected a nonblank safe label");
export const ProviderIdSchema = nonblank(128);
export const ModelIdSchema = nonblank(256);
export const ApiIdSchema = nonblank(128);
export const ConfigVersionSchema = z.string().max(128).regex(/^(0|[1-9][0-9]*)$/);
export const CredentialRefSchema = OpaqueIdSchema;
export const SecretInputTokenSchema = OpaqueIdSchema;
export type SecretInputToken = z.infer<typeof SecretInputTokenSchema>;
export const ReferenceDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Expected a real YYYY-MM-DD date");
export const TimezoneSchema = z.string().min(1).max(128).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Expected an IANA timezone");
const positiveLimit = PositiveIdSchema;
const inputSchema = z.array(z.enum(["text", "image"])).min(1).max(2).refine(values => new Set(values).size === values.length, "Duplicate input capability");
export const ModelChoiceSchema = z.strictObject({ provider: ProviderIdSchema, modelId: ModelIdSchema, expectedConfigVersion: ConfigVersionSchema });
export const ModelSelectionSchema = z.strictObject({
  provider: ProviderIdSchema, modelId: ModelIdSchema, endpointRef: OpaqueIdSchema.nullable(), api: ApiIdSchema,
  configVersion: ConfigVersionSchema, credentialRef: CredentialRefSchema.nullable(), maxOutputTokens: positiveLimit,
  capabilitySource: z.enum(["pi_catalog", "user_declared"]), sdkVersion: z.literal(SDK_VERSION),
});
export const DEFAULT_REQUEST_POLICY = Object.freeze({ timeoutMs: 120000, maxRetries: 0, maxRetryDelayMs: 2000 } as const);
export const RequestPolicySchema = z.strictObject({
  timeoutMs: z.number().int().min(1000).max(Number.MAX_SAFE_INTEGER), maxRetries: z.union([z.literal(0), z.literal(1)]),
  maxRetryDelayMs: z.number().int().min(1).max(5000),
});
export const DEFAULT_AGENT_POLICY = Object.freeze({
  version: 'medclaw.agent-policy/v1',
  maxToolCalls: 24,
  maxModelCalls: 12,
  singleToolTimeoutMs: 30000,
  maxRecoveryAttempts: 2,
} as const);
const safeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const elapsedMs = z.number().finite().nonnegative();
const controlCode = z.string().min(1).max(128).regex(/^[a-z][a-z0-9_.:-]*$/);
export const AgentPolicySchema = z.strictObject({
  version: z.literal('medclaw.agent-policy/v1'),
  maxToolCalls: PositiveIdSchema,
  maxModelCalls: PositiveIdSchema,
  singleToolTimeoutMs: PositiveIdSchema,
  maxRecoveryAttempts: safeCount,
});
export const MeasurementContextSchema = z.strictObject({
  version: z.literal('medclaw.tool-measurement/v1'),
  sdkVersion: nonblank(128),
  environmentKey: nonblank(256),
  cutoffAt: TimestampSchema,
  maxToolCallId: PositiveIdSchema.nullable(),
});
export const ToolProfileSchema = z.strictObject({
  name: nonblank(256),
  version: nonblank(128),
  sdkVersion: nonblank(128),
  measurementVersion: nonblank(128),
  environmentKey: nonblank(256),
  workloadBucket: nonblank(256),
  sampleCount: safeCount,
  completeSamples: safeCount,
  p95Ms: elapsedMs.nullable(),
  timeoutRate: z.number().finite().min(0).max(1).nullable(),
  reliability: z.record(nonblank(256), safeCount),
});
export const ToolProfileSnapshotSchema = z.strictObject({
  version: z.literal('medclaw.tool-profile/v1'),
  cutoffAt: TimestampSchema,
  maxToolCallId: PositiveIdSchema.nullable(),
  windowDays: PositiveIdSchema,
  observationLimit: PositiveIdSchema,
  perGroupLimit: PositiveIdSchema,
  minimumCompleteSamples: PositiveIdSchema,
  available: z.boolean(),
  profiles: z.array(ToolProfileSchema).max(2000),
});
export const ToolValidationStatusSchema = z.enum(['passed', 'failed', 'not_applicable', 'not_reached', 'unknown']);
export const ToolAdmissionStatusSchema = z.enum(['passed', 'blocked', 'failed', 'not_reached', 'unknown']);
export const ToolControlObservationSchema = z.strictObject({
  version: z.literal('medclaw.tool-control/v1'),
  admission: z.strictObject({
    status: ToolAdmissionStatusSchema,
    reason: controlCode.nullable(),
  }),
  inputValidation: ToolValidationStatusSchema,
  outputValidation: ToolValidationStatusSchema,
  businessValidation: z.strictObject({
    pre: ToolValidationStatusSchema,
    post: ToolValidationStatusSchema,
  }),
  preflightStatus: ToolAdmissionStatusSchema,
  postflightStatus: z.enum(['passed', 'failed', 'not_reached', 'unknown']),
  hookFailure: z.strictObject({
    stage: z.enum(['beforeToolCall', 'afterToolCall']),
    code: controlCode,
  }).nullable(),
  effectiveTimeoutMs: elapsedMs.nullable(),
  executionElapsedMs: elapsedMs.nullable(),
  observedElapsedMs: elapsedMs.nullable(),
  latencyObservation: z.enum(['complete', 'right_censored', 'missing']),
  timeoutRequestedAt: TimestampSchema.nullable(),
  stopLagMs: elapsedMs.nullable(),
  failureOrigin: controlCode.nullable(),
  failureClass: controlCode.nullable(),
  failureStage: controlCode.nullable(),
  failureVisibility: z.enum(['explicit', 'implicit', 'unknown']),
  failurePersistence: z.enum(['transient', 'persistent', 'unknown']),
  validationIssues: z.array(z.strictObject({
    code: controlCode,
    stage: controlCode,
    fieldPath: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/)).max(32),
  })).max(100),
  environmentKey: nonblank(256).nullable(),
  workloadBucket: nonblank(256).nullable(),
  repairEpisodeId: OpaqueIdSchema.nullable(),
  repairOfToolCallId: PositiveIdSchema.nullable(),
  recoveryAction: controlCode.nullable(),
});
export const BudgetSummarySchema = z.strictObject({
  version: z.literal('medclaw.budget-summary/v1'),
  toolCalls: safeCount,
  modelCalls: safeCount,
  toolAdmissionsRejected: safeCount,
  modelAdmissionsRejected: safeCount,
  convergenceRequested: z.boolean(),
  recoveryAttempts: safeCount,
  stopReason: controlCode.nullable(),
  unresolvedItems: z.array(z.string().min(1).max(256)).max(1000),
});
export function createToolControlObservation(patch: Partial<ToolControlObservation> = {}): ToolControlObservation {
  return ToolControlObservationSchema.parse({
    version: 'medclaw.tool-control/v1',
    admission: { status: 'not_reached', reason: null },
    inputValidation: 'not_reached',
    outputValidation: 'not_reached',
    businessValidation: { pre: 'not_reached', post: 'not_reached' },
    preflightStatus: 'not_reached',
    postflightStatus: 'not_reached',
    hookFailure: null,
    effectiveTimeoutMs: null,
    executionElapsedMs: null,
    observedElapsedMs: null,
    latencyObservation: 'missing',
    timeoutRequestedAt: null,
    stopLagMs: null,
    failureOrigin: null,
    failureClass: null,
    failureStage: null,
    failureVisibility: 'unknown',
    failurePersistence: 'unknown',
    validationIssues: [],
    environmentKey: null,
    workloadBucket: null,
    repairEpisodeId: null,
    repairOfToolCallId: null,
    recoveryAction: null,
    ...patch,
  });
}
export const DEFAULT_DISPLAY_PREFERENCES = Object.freeze({ navCollapsed: false, detailOpen: false, detailTab: "conditions" } as const);
export const DesktopDisplayPreferencesSchema = z.strictObject({ navCollapsed: z.boolean(), detailOpen: z.boolean(), detailTab: z.enum(["conditions", "evidence", "runtime"]) });
export const ModelEntryViewSchema = z.strictObject({
  provider: ProviderIdSchema, id: ModelIdSchema, name: nonblank(256), api: ApiIdSchema,
  input: inputSchema, reasoning: z.boolean(), contextWindow: positiveLimit.nullable(), maxTokens: positiveLimit.nullable(),
  capabilitySource: z.enum(["pi_catalog", "user_declared"]),
}).refine(model => model.capabilitySource === "pi_catalog" || model.contextWindow === null || model.maxTokens === null || model.maxTokens <= model.contextWindow, "Declared output limit exceeds context window");
export const AuthStatusViewSchema = z.strictObject({
  providerId: ProviderIdSchema, state: z.enum(["available", "unavailable", "checking", "sync_unknown"]),
  type: z.enum(["api_key", "oauth"]).nullable(), source: nonblank(256).nullable(),
  checkKind: z.enum(["snapshot", "resolved"]), checkedAt: TimestampSchema,
});
export const ProviderViewSchema = z.strictObject({
  id: ProviderIdSchema, name: nonblank(256), loginTypes: z.array(z.enum(["api_key", "oauth"])).max(2).refine(values => new Set(values).size === values.length),
  auth: AuthStatusViewSchema, source: z.enum(["pi_builtin", "custom"]),
}).refine(provider => provider.auth.providerId === provider.id, "Authentication belongs to another provider");
export const ModelDirectoryViewSchema = z.strictObject({
  providers: z.array(ProviderViewSchema).max(10000), models: z.array(ModelEntryViewSchema).max(100000),
  configVersion: ConfigVersionSchema, selection: ModelSelectionSchema.nullable(),
  customApis: z.array(ApiIdSchema).max(1000),
});

export const CustomBaseUrlSchema = z.string().min(1).max(2048).refine(value => {
  if (value !== value.trim() || /[\u0000-\u0020\u007f?#]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) return false;
    return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  } catch { return false; }
}, "Expected an HTTPS URL or HTTP loopback without credentials, query or fragment");
export const ModelCostSchema = z.strictObject({ input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(), cacheRead: z.number().finite().nonnegative(), cacheWrite: z.number().finite().nonnegative() });
export const CustomModelDefinitionSchema = z.strictObject({
  id: ModelIdSchema, name: nonblank(256), input: inputSchema.refine(values => values.includes("text"), "Text input is required"),
  reasoning: z.boolean(), contextWindow: positiveLimit, maxTokens: positiveLimit, outputLimitConfirmed: z.literal(true),
  pricingKnown: z.boolean(), cost: ModelCostSchema.nullable(),
}).refine(model => model.maxTokens <= model.contextWindow, "Output limit exceeds context window")
  .refine(model => model.pricingKnown === (model.cost !== null), "Known pricing requires rates; unknown pricing must remain null");
export const CustomProviderDefinitionSchema = z.strictObject({
  providerId: ProviderIdSchema, name: nonblank(256), api: ApiIdSchema, baseUrl: CustomBaseUrlSchema,
  models: z.array(CustomModelDefinitionSchema).min(1).max(10000),
}).refine(provider => new Set(provider.models.map(model => model.id)).size === provider.models.length, "Duplicate model ID");
export const SettingsSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION), configVersion: ConfigVersionSchema,
  model: z.strictObject({ provider: ProviderIdSchema, modelId: ModelIdSchema }).nullable(),
  customProviders: z.array(z.strictObject({ definition: CustomProviderDefinitionSchema, credentialRef: CredentialRefSchema.nullable() })).max(10000),
  credentialRefs: z.record(ProviderIdSchema, CredentialRefSchema.nullable()), requestPolicy: RequestPolicySchema,
  agentPolicy: AgentPolicySchema.default(DEFAULT_AGENT_POLICY),
  ui: DesktopDisplayPreferencesSchema.default(DEFAULT_DISPLAY_PREFERENCES),
}).refine(settings => new Set(settings.customProviders.map(provider => provider.definition.providerId)).size === settings.customProviders.length, "Duplicate custom provider ID");
export const PublishedSettingsSchema = SettingsSnapshotSchema.safeExtend({ previous: SettingsSnapshotSchema.nullable(), rollbackFromVersion: ConfigVersionSchema.nullable() });
export const ProviderRequestSchema = z.strictObject({
  text: z.string().refine(value => value.trim().length > 0, "Text must not be blank"), model: ModelChoiceSchema,
  referenceDate: ReferenceDateSchema, timezone: TimezoneSchema, priorRunId: PositiveIdSchema.optional(),
});
export const DiagnoseRequestSchema = ProviderRequestSchema.omit({ text: true });
export const ProviderAcceptedSchema = z.strictObject({ runId: PositiveIdSchema, operationRef: OpaqueIdSchema, reused: z.boolean() });
export const AuthAttemptViewSchema = z.strictObject({
  id: OpaqueIdSchema, providerId: ProviderIdSchema,
  state: z.enum(["running", "waiting_input", "completed", "failed", "cancelled", "sync_unknown"]),
  pendingPromptId: OpaqueIdSchema.nullable(), error: AppErrorSchema.nullable(), startedAt: TimestampSchema, endedAt: TimestampSchema.nullable(),
});
const promptFields = { message: z.string().min(1).max(2000), promptId: OpaqueIdSchema, authAttemptId: OpaqueIdSchema };
export const AuthPromptOptionSchema = z.strictObject({ id: ModelIdSchema, label: nonblank(256), description: z.string().max(2000).optional() });
export const AuthPromptViewSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...promptFields, type: z.literal("text"), secret: z.literal(false) }),
  z.strictObject({ ...promptFields, type: z.literal("secret"), secret: z.literal(true) }),
  z.strictObject({ ...promptFields, type: z.literal("manual_code"), secret: z.literal(false) }),
  z.strictObject({ ...promptFields, type: z.literal("select"), secret: z.literal(false), options: z.array(AuthPromptOptionSchema).min(1).max(100).refine(options => new Set(options.map(option => option.id)).size === options.length) }),
]);
export const AuthLinkUrlSchema = z.string().max(8192).refine(value => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && value === value.trim(); }
  catch { return false; }
}, "Expected an HTTP or HTTPS authentication link");
export const AuthNotifyViewSchema = z.discriminatedUnion("type", [
  z.strictObject({ authAttemptId: OpaqueIdSchema, type: z.literal("info"), message: z.string().max(2000), links: z.array(z.strictObject({ url: AuthLinkUrlSchema, label: nonblank(256).optional() })).max(10).optional() }),
  z.strictObject({ authAttemptId: OpaqueIdSchema, type: z.literal("auth_url"), url: AuthLinkUrlSchema, instructions: z.string().max(2000).optional() }),
  z.strictObject({ authAttemptId: OpaqueIdSchema, type: z.literal("device_code"), userCode: z.string().min(1).max(256), verificationUri: AuthLinkUrlSchema, intervalSeconds: positiveLimit.optional(), expiresInSeconds: positiveLimit.optional() }),
  z.strictObject({ authAttemptId: OpaqueIdSchema, type: z.literal("progress"), message: z.string().max(2000) }),
]);
export const HostViewSchema = z.strictObject({
  instanceId: OpaqueIdSchema.nullable(), state: z.enum(["stopped", "starting", "handshaking", "ready", "stopping", "failed"]),
  canStart: z.boolean(), sdkVersion: nonblank(128).nullable(), schemaVersion: PositiveIdSchema.nullable(), error: AppErrorSchema.nullable(),
});

export type ModelChoice = z.infer<typeof ModelChoiceSchema>;
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;
export type RequestPolicy = z.infer<typeof RequestPolicySchema>;
export type AgentPolicy = z.infer<typeof AgentPolicySchema>;
export type MeasurementContext = z.infer<typeof MeasurementContextSchema>;
export type ToolProfile = z.infer<typeof ToolProfileSchema>;
export type ToolProfileSnapshot = z.infer<typeof ToolProfileSnapshotSchema>;
export type ToolControlObservation = z.infer<typeof ToolControlObservationSchema>;
export type BudgetSummary = z.infer<typeof BudgetSummarySchema>;
export type DesktopDisplayPreferences = z.infer<typeof DesktopDisplayPreferencesSchema>;
export type ModelEntryView = z.infer<typeof ModelEntryViewSchema>;
export type AuthStatusView = z.infer<typeof AuthStatusViewSchema>;
export type ProviderView = z.infer<typeof ProviderViewSchema>;
export type ModelDirectoryView = z.infer<typeof ModelDirectoryViewSchema>;
export type CustomModelDefinition = z.infer<typeof CustomModelDefinitionSchema>;
export type CustomProviderDefinition = z.infer<typeof CustomProviderDefinitionSchema>;
export type SettingsSnapshot = z.infer<typeof SettingsSnapshotSchema>;
export type PublishedSettings = z.infer<typeof PublishedSettingsSchema>;
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;
export type DiagnoseRequest = z.infer<typeof DiagnoseRequestSchema>;
export type ProviderAccepted = z.infer<typeof ProviderAcceptedSchema>;
export type AuthAttemptView = z.infer<typeof AuthAttemptViewSchema>;
export type AuthPromptView = z.infer<typeof AuthPromptViewSchema>;
export type AuthNotifyView = z.infer<typeof AuthNotifyViewSchema>;
export type HostView = z.infer<typeof HostViewSchema>;

/** Host-injected internal ports; resolved SDK details remain opaque to Core. */
export interface ResolvedProviderSelection {
  readonly selection: ModelSelection;
  readonly policy: RequestPolicy;
}
export type ModelAuthPrompt = { signal?: AbortSignal } & (
  { type: "text" | "secret" | "manual_code"; message: string } |
  { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
);
export type ModelAuthNotification =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };
export interface ModelAuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: ModelAuthPrompt): Promise<string>;
  notify(event: ModelAuthNotification): void;
}
export interface CredentialContext {
  purpose: "auth" | "runtime" | "rollback"; operationRef: string;
  authAttemptId?: string; credentialRef?: string | null;
}
export type CredentialScope = <T>(context: CredentialContext, action: () => Promise<T>) => Promise<T>;
export interface ModelRuntimePort<Resolved extends ResolvedProviderSelection = ResolvedProviderSelection> {
  directory(configVersion: string, selection?: ModelSelection | null): Promise<ModelDirectoryView>;
  refresh(providerId: string | undefined, signal: AbortSignal): Promise<{ aborted: boolean; errors: { providerId: string; error: AppError }[] }>;
  installCustom(definitions: readonly CustomProviderDefinition[], signal?: AbortSignal): Promise<void>;
  supportsAuth(providerId: string, type: "api_key" | "oauth"): boolean;
  login(providerId: string, type: "api_key" | "oauth", interaction: ModelAuthInteraction): Promise<void>;
  authStatus(providerId: string, signal?: AbortSignal): Promise<AuthStatusView>;
  resolve(choice: ModelChoice, configVersion: string, credentialRef: string | null, policy: RequestPolicy, requireAuth?: boolean): Promise<Resolved>;
  execute(resolved: Resolved, text: string, signal: AbortSignal, onPreview: (text: string) => void, onTerminal?: () => void): Promise<ProviderOutcome>;
}
