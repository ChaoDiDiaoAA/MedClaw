import { z } from "zod";
import { HostShutdownProofSchema } from './maintenance';
import { AppErrorSchema, ConfigVersionSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema } from "./error";
import { ResourceSettingsSchema } from './resources';
import { ExtensionSettingsSchema } from './extensions';
export { ConfigVersionSchema } from './error';
import type { AppError } from "./error";
import type { ProviderOutcome } from "./run";
import { StoredToolConfigurationSchema, normalizeToolConfiguration } from './tool-config';
import { AgentPolicySchema, RequestPolicySchema, RuntimeConfigurationSchema, normalizeRuntimeConfiguration, projectRuntimePolicies } from './runtime-config';
export { DEFAULT_AGENT_POLICY, DEFAULT_REQUEST_POLICY, AgentPolicySchema, RequestPolicySchema } from './runtime-config';

export const SDK_VERSION = "0.87.1" as const;
export const SETTINGS_SCHEMA_VERSION = "medclaw.settings/p1-v1" as const;
const nonblank = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), "Expected a nonblank safe label");
export const ProviderIdSchema = nonblank(128);
export const ModelIdSchema = nonblank(256);
export const ApiIdSchema = nonblank(128);
export const CredentialRefSchema = OpaqueIdSchema;
export const SecretInputTokenSchema = OpaqueIdSchema;
export type SecretInputToken = z.infer<typeof SecretInputTokenSchema>;
// The inference grammar accepts ASCII ranges but drops unsupported \d escapes.
export const ReferenceDateSchema = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Expected a real YYYY-MM-DD date");
export const TimezoneSchema = z.string().min(1).max(128).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Expected an IANA timezone");
export const INTENT_VERSIONS = Object.freeze({
  taxonomyVersion: 'medclaw.intent-taxonomy/v1', ruleVersion: 'medclaw.intent-rules/v1',
  classifyPromptVersion: 'medclaw.intent-classify-prompt/v3', verifyPromptVersion: 'medclaw.intent-verify-prompt/v4',
  schemaVersion: 'medclaw.intent/v2', policyVersion: 'medclaw.intent-policy/v5',
} as const);
// Old frozen calls remain readable; new admissions use INTENT_VERSIONS.
export const IntentClassifyPromptVersionSchema = z.enum(['medclaw.intent-classify-prompt/v1', 'medclaw.intent-classify-prompt/v2', 'medclaw.intent-classify-prompt/v3']);
export const IntentVerifyPromptVersionSchema = z.enum(['medclaw.intent-verify-prompt/v1', 'medclaw.intent-verify-prompt/v2', 'medclaw.intent-verify-prompt/v3', 'medclaw.intent-verify-prompt/v4']);
export const IntentPolicyVersionSchema = z.enum(['medclaw.intent-policy/v2', 'medclaw.intent-policy/v3', 'medclaw.intent-policy/v4', 'medclaw.intent-policy/v5']);

export const IntentBaseUrlSchema = z.string().regex(/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?\/?$/)
  .refine(value => {
    try { return !/[\u0000-\u0020\u007f]/.test(value) && new URL(value).port !== '0'; } catch { return false; }
  }, 'Only numeric HTTP loopback without URL components is allowed');
export const IntentModelConfigurationSchema = z.strictObject({
  contract: z.literal('medclaw.intent-model/v2'), enabled: z.boolean(), baseUrl: IntentBaseUrlSchema,
  modelTag: z.literal('qwen3.5:0.8b'),
  sourceUrl: z.literal('https://ollama.com/library/qwen3.5:0.8b'), verifiedEvidenceRef: nonblank(256).nullable(),
  timeoutMs: z.number().int().min(1000).max(60000),
}).refine(value => !value.enabled || value.verifiedEvidenceRef !== null, 'Enabling requires protocol evidence');
export type IntentModelConfiguration = z.infer<typeof IntentModelConfigurationSchema>;
export const DEFAULT_INTENT_MODEL: Readonly<IntentModelConfiguration> = Object.freeze({
  contract:'medclaw.intent-model/v2',enabled:false,baseUrl:'http://127.0.0.1:11434',modelTag:'qwen3.5:0.8b',
  sourceUrl:'https://ollama.com/library/qwen3.5:0.8b',verifiedEvidenceRef:null,timeoutMs:15000,
});
export const IntentModelSelectionSchema = IntentModelConfigurationSchema.safeExtend({
  configVersion: ConfigVersionSchema, api: z.literal('ollama-chat'),
  taxonomyVersion: z.literal(INTENT_VERSIONS.taxonomyVersion), ruleVersion: z.literal(INTENT_VERSIONS.ruleVersion),
  classifyPromptVersion: IntentClassifyPromptVersionSchema, verifyPromptVersion: IntentVerifyPromptVersionSchema,
  schemaVersion: z.literal(INTENT_VERSIONS.schemaVersion), policyVersion: IntentPolicyVersionSchema,
});
export type IntentModelSelection = z.infer<typeof IntentModelSelectionSchema>;
const positiveLimit = PositiveIdSchema;
const inputSchema = z.array(z.enum(["text", "image"])).min(1).max(2).refine(values => new Set(values).size === values.length, "Duplicate input capability");
export const ModelChoiceSchema = z.strictObject({ provider: ProviderIdSchema, modelId: ModelIdSchema, expectedConfigVersion: ConfigVersionSchema });
export const ModelSelectionSchema = z.strictObject({
  provider: ProviderIdSchema, modelId: ModelIdSchema, endpointRef: OpaqueIdSchema.nullable(), api: ApiIdSchema,
  configVersion: ConfigVersionSchema, credentialRef: CredentialRefSchema.nullable(), maxOutputTokens: positiveLimit,
  capabilitySource: z.enum(["pi_catalog", "user_declared"]), sdkVersion: z.literal(SDK_VERSION),
});
const safeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const elapsedMs = z.number().finite().nonnegative();
const controlCode = z.string().min(1).max(128).regex(/^[a-z][a-z0-9_.:-]*$/);
export const MeasurementContextSchema = z.strictObject({
  version: z.enum(['medclaw.tool-measurement/v1', 'medclaw.tool-measurement/v2']),
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
  percentile: z.number().finite().gt(0).max(1).optional(),
  latencyQuantileMs: elapsedMs.nullable().optional(),
  timeoutRate: z.number().finite().min(0).max(1).nullable(),
  reliability: z.record(nonblank(256), safeCount),
}).refine(profile => profile.percentile === undefined || profile.percentile === 0.95 || profile.p95Ms === null, 'Other quantiles must not be labeled P95');
export const ToolProfileSnapshotSchema = z.strictObject({
  version: z.literal('medclaw.tool-profile/v1'),
  cutoffAt: TimestampSchema,
  maxToolCallId: PositiveIdSchema.nullable(),
  windowDays: PositiveIdSchema,
  observationLimit: PositiveIdSchema,
  perGroupLimit: PositiveIdSchema,
  minimumCompleteSamples: PositiveIdSchema,
  available: z.boolean(),
  profiles: z.array(ToolProfileSchema),
});
export const ToolValidationStatusSchema = z.enum(['passed', 'failed', 'not_applicable', 'not_reached', 'unknown']);
export const ToolAdmissionStatusSchema = z.enum(['passed', 'blocked', 'failed', 'not_reached', 'unknown']);
export const ToolControlObservationSchema = z.strictObject({
  hookInput: z.strictObject({ changed: z.boolean() }).optional(),
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
export const SettingsSnapshotObjectSchema = z.strictObject({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION), configVersion: ConfigVersionSchema,
  intentModel: IntentModelConfigurationSchema.nullable().optional(),
  model: z.strictObject({ provider: ProviderIdSchema, modelId: ModelIdSchema }).nullable(),
  customProviders: z.array(z.strictObject({ definition: CustomProviderDefinitionSchema, credentialRef: CredentialRefSchema.nullable() })).max(10000),
  credentialRefs: z.record(ProviderIdSchema, CredentialRefSchema.nullable()), requestPolicy: RequestPolicySchema.optional(),
  agentPolicy: AgentPolicySchema.optional(),
  runtimeConfiguration: RuntimeConfigurationSchema.optional(),
  toolConfiguration: StoredToolConfigurationSchema.optional(),
  resources: ResourceSettingsSchema.optional(),
  extensions: ExtensionSettingsSchema.optional(),
  ui: DesktopDisplayPreferencesSchema.default(DEFAULT_DISPLAY_PREFERENCES),
}).refine(settings => new Set(settings.customProviders.map(provider => provider.definition.providerId)).size === settings.customProviders.length, "Duplicate custom provider ID");
function normalizeSettings<T extends z.infer<typeof SettingsSnapshotObjectSchema>>(settings: T, context: z.RefinementCtx) {
  try {
    const toolConfiguration = normalizeToolConfiguration(settings);
    const runtimeConfiguration = normalizeRuntimeConfiguration(settings);
    return { ...settings, runtimeConfiguration, toolConfiguration, ...projectRuntimePolicies(runtimeConfiguration) };
  } catch {
    context.addIssue({ code: 'custom', path: ['toolConfiguration'], message: 'Conflicting runtime configuration and policy' });
    return z.NEVER;
  }
}
export const SettingsSnapshotSchema = SettingsSnapshotObjectSchema.transform(normalizeSettings);
export const PublishedSettingsSchema = SettingsSnapshotObjectSchema.safeExtend({ previous: SettingsSnapshotSchema.nullable(), rollbackFromVersion: ConfigVersionSchema.nullable() }).transform(normalizeSettings);
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
  shutdown: HostShutdownProofSchema.optional(), canPrepareRecovery: z.boolean().optional(),
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
