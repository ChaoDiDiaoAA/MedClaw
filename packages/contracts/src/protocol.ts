import { z } from "zod";
import { AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema, resultSchema, type Result } from "./error";
import {
  AgentPolicySchema, ApiIdSchema, AuthAttemptViewSchema, AuthNotifyViewSchema, AuthPromptViewSchema, AuthStatusViewSchema,
  ConfigVersionSchema, CredentialRefSchema, CustomProviderDefinitionSchema, DesktopDisplayPreferencesSchema,
  DiagnoseRequestSchema, HostViewSchema, ModelChoiceSchema, ModelDirectoryViewSchema, ModelSelectionSchema,
  ProviderAcceptedSchema, ProviderIdSchema, ProviderRequestSchema, RequestPolicySchema,
  SDK_VERSION, SecretInputTokenSchema, PublishedSettingsSchema,
} from "./model";
import { ActiveRunViewSchema, CancelRunResultSchema, ReadRunRequestSchema, ReadRunResultSchema, RunViewSchema, RuntimeControlViewSchema } from "./run";
import { ListSessionsRequestSchema, NewSessionInputSchema, NewSessionResultSchema, ReadSubmissionRequestSchema, SelectSessionInputSchema,
  ReadInputRequestSchema, ListInputsRequestSchema, CancelInputRequestSchema, SessionInputSchema, SessionInputPageSchema, SessionDetailSchema, SessionPageSchema, SubmitInputSchema, SubmitResultSchema } from "./session";
import { WorkspaceViewSchema, UpdateWorkspaceRequestSchema } from "./workspace";
import { ImportPreviewRequestSchema, ImportCommitRequestSchema, ImportPreviewSchema, ImportOperationSchema, ImportReferenceSchema, ArtifactSchema, DataCatalogSchema, DataRowsSchema } from "./data";
import { BUSINESS_RULES, createQuerySchemas, EvidenceViewSchema, PageSchema, QueryRequestParamsSchema, QuerySummarySchema, QueryViewSchema } from './query';
import { TOOL_READ_RULES, RunToolsViewSchema } from './tool';
import { StoredToolConfigurationSchema, normalizeToolConfiguration } from './tool-config';
import { RuntimeConfigurationSchema, normalizeRuntimeConfiguration, projectRuntimePolicies } from './runtime-config';
import { ReadSessionMessagesInputSchema, SessionMessagePageSchema } from "./messages";

import { ReadEventsInputSchema, EventPageSchema, EventSubscribeInputSchema, EventSubscribeResultSchema, EventAvailableNoticeSchema, EventStreamNoticeSchema } from './event';

export const HOST_PROTOCOL_VERSION = "medclaw.host/p6-v1" as const;
export const DATABASE_SCHEMA_VERSION = 5 as const;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const SECRET_INPUT_TTL_MS = 300000;
export function isReadOnlyMethod(method: string): boolean {
  return method === "event.subscribe" || method.endsWith(".read") || method.endsWith(".list") || method.endsWith(".status") || method.startsWith('evidence.read') || method === 'data.rows' || method === 'tool.read' || method === "run.active" || method === "workspace.restore" || method === "session.readSubmission" || method === "session.readInput" || method === "session.listInputs";
}
export const EmptyPayloadSchema = z.strictObject({});
const accepted = z.strictObject({ accepted: z.literal(true) });
const cancelOperation = z.strictObject({ cancelRequested: z.boolean(), settled: z.boolean() });
const expectedVersion = { expectedConfigVersion: ConfigVersionSchema };
const instanceControl = z.strictObject({ expectedInstanceId: OpaqueIdSchema });
const configurableSelection = z.strictObject({ configVersion: ConfigVersionSchema, selection: ModelSelectionSchema });
const uiResult = z.strictObject({ configVersion: ConfigVersionSchema, ui: DesktopDisplayPreferencesSchema });
const policyUpdateInput = z.strictObject({
  ...expectedVersion,
  policy: RequestPolicySchema.optional(),
  agentPolicy: AgentPolicySchema.optional(),
  runtimeConfiguration: RuntimeConfigurationSchema.optional(),
  toolConfiguration: StoredToolConfigurationSchema.optional(),
}).superRefine((input, context) => {
  if (!input.policy && !input.agentPolicy && !input.toolConfiguration && !input.runtimeConfiguration) context.addIssue({ code: 'custom', message: 'At least one policy or tool configuration is required' });
  try { normalizeRuntimeConfiguration({ ...input, requestPolicy: input.policy }); }
  catch { context.addIssue({ code: 'custom', path: ['runtimeConfiguration'], message: 'Conflicting runtime configuration and policy' }); }
});
const policyResultFields = {
  configVersion: ConfigVersionSchema,
  policy: RequestPolicySchema,
  agentPolicy: AgentPolicySchema,
  runtimeConfiguration: RuntimeConfigurationSchema.optional(),
  toolConfiguration: StoredToolConfigurationSchema.optional(),
};
function normalizePolicyResult<T extends z.infer<z.ZodObject<typeof policyResultFields>>>(result: T, context: z.RefinementCtx) {
  try {
    const toolConfiguration = normalizeToolConfiguration({ toolConfiguration: result.toolConfiguration });
    const runtimeConfiguration = normalizeRuntimeConfiguration({ ...result, requestPolicy: result.policy });
    const projection = projectRuntimePolicies(runtimeConfiguration);
    return { ...result, policy: projection.requestPolicy, agentPolicy: projection.agentPolicy, runtimeConfiguration, toolConfiguration };
  } catch {
    context.addIssue({ code: 'custom', path: ['toolConfiguration'], message: 'Conflicting runtime configuration and policy' });
    return z.NEVER;
  }
}
export const DiagnosticsCategorySchema = z.enum(["versions", "host", "errors", "runtime", "prompt_trace"]);
export const DiagnosticsEntrySchema = z.strictObject({
  category: z.enum(["errors", "runtime", "prompt_trace"]), source: z.enum(["main", "host"]), at: TimestampSchema,
  operationRef: OpaqueIdSchema.optional(), runId: PositiveIdSchema.optional(), message: z.string().max(2000), error: AppErrorSchema.optional(),
});
export const DiagnosticsVersionsSchema = z.strictObject({
  sdkVersion: z.literal(SDK_VERSION), protocolVersion: z.literal(HOST_PROTOCOL_VERSION), schemaVersion: PositiveIdSchema.nullable(),
  configVersion: ConfigVersionSchema.nullable(), bunVersion: z.string().min(1).max(128).nullable(), electronVersion: z.string().min(1).max(128).nullable(),
});
export const DiagnosticsViewSchema = z.strictObject({
  partial: z.boolean(), missingSources: z.array(z.enum(["main", "host"])).max(2), versions: DiagnosticsVersionsSchema,
  host: HostViewSchema, entries: z.array(DiagnosticsEntrySchema).max(8300),
});

/** Each public method owns its exact input and output; private control and secrets are absent. */
export const publicMethodSchemas = {
  "event.read": { input: ReadEventsInputSchema, output: EventPageSchema },
  "event.subscribe": { input: EventSubscribeInputSchema, output: EventSubscribeResultSchema },
  "model.list": { input: EmptyPayloadSchema, output: ModelDirectoryViewSchema },
  "model.read": { input: EmptyPayloadSchema, output: ModelDirectoryViewSchema },
  "model.refresh": {
    input: z.strictObject({ providerId: ProviderIdSchema.optional() }),
    output: z.strictObject({ aborted: z.boolean(), errors: z.array(z.strictObject({ providerId: ProviderIdSchema, error: AppErrorSchema })).max(10000), directory: ModelDirectoryViewSchema }),
  },
  "operation.cancel": { input: z.strictObject({ operationRef: OpaqueIdSchema }), output: cancelOperation },
  "model.auth.start": {
    input: z.strictObject({ providerId: ProviderIdSchema, type: z.enum(["api_key", "oauth"]) }),
    output: z.strictObject({ authAttemptId: OpaqueIdSchema, state: z.literal("running") }),
  },
  "model.auth.respond": {
    input: z.strictObject({ authAttemptId: OpaqueIdSchema, promptId: OpaqueIdSchema, value: z.string().max(4096) }), output: accepted,
  },
  "model.auth.cancel": { input: z.strictObject({ authAttemptId: OpaqueIdSchema }), output: cancelOperation },
  "model.auth.status": {
    input: z.strictObject({ providerId: ProviderIdSchema, authAttemptId: OpaqueIdSchema.optional() }),
    output: z.strictObject({ auth: AuthStatusViewSchema, attempt: AuthAttemptViewSchema.nullable() }),
  },
  "model.custom.read": {
    input: z.strictObject({ providerId: ProviderIdSchema.optional() }),
    output: z.strictObject({ configVersion: ConfigVersionSchema, definitions: z.array(CustomProviderDefinitionSchema).max(10000) }),
  },
  "model.custom.save": {
    input: z.strictObject({ definition: CustomProviderDefinitionSchema, ...expectedVersion, credentialInput: SecretInputTokenSchema.optional() }),
    output: z.strictObject({ configVersion: ConfigVersionSchema, definition: CustomProviderDefinitionSchema, registered: z.boolean() }),
  },
  "model.configure": { input: ModelChoiceSchema, output: configurableSelection },
  "model.policy.update": { input: policyUpdateInput, output: z.strictObject(policyResultFields).transform(normalizePolicyResult) },
  "model.config.read": {
    input: EmptyPayloadSchema,
    output: z.strictObject({ ...policyResultFields, previousConfigVersion: ConfigVersionSchema.nullable(), rollbackFromVersion: ConfigVersionSchema.nullable() }).transform(normalizePolicyResult),
  },
  "model.config.rollback": {
    input: z.strictObject({ ...expectedVersion, targetConfigVersion: ConfigVersionSchema }),
    output: z.strictObject({ configVersion: ConfigVersionSchema, rollbackFromVersion: ConfigVersionSchema, selection: ModelSelectionSchema.nullable() }),
  },
  "model.request": { input: ProviderRequestSchema, output: ProviderAcceptedSchema },
  "model.diagnose": { input: DiagnoseRequestSchema, output: ProviderAcceptedSchema },
  "session.create": { input: NewSessionInputSchema, output: NewSessionResultSchema },
  "session.select": { input: SelectSessionInputSchema, output: WorkspaceViewSchema },
  "session.list": { input: ListSessionsRequestSchema, output: SessionPageSchema },
  "session.read": { input: z.strictObject({ sessionId: PositiveIdSchema }), output: SessionDetailSchema.nullable() },
  "session.messages.read": { input: ReadSessionMessagesInputSchema, output: SessionMessagePageSchema },
  "session.submit": { input: SubmitInputSchema, output: SubmitResultSchema },
  "session.readInput": { input: ReadInputRequestSchema, output: SessionInputSchema.nullable() },
  "session.listInputs": { input: ListInputsRequestSchema, output: SessionInputPageSchema },
  "session.cancelInput": { input: CancelInputRequestSchema, output: SessionInputSchema },
  "session.readSubmission": { input: ReadSubmissionRequestSchema, output: SubmitResultSchema.nullable() },
  "workspace.read": { input: EmptyPayloadSchema, output: WorkspaceViewSchema },
  "workspace.restore": { input: EmptyPayloadSchema, output: WorkspaceViewSchema },
  "workspace.update": { input: UpdateWorkspaceRequestSchema, output: WorkspaceViewSchema },
  'data.read': { input: PageSchema.extend({ page: PositiveIdSchema.optional(), pageSize: PositiveIdSchema.optional() }), output: DataCatalogSchema },
  'data.rows': { input: PageSchema.extend({ page: PositiveIdSchema.optional(), pageSize: PositiveIdSchema.optional(), kind: z.enum(['devices', 'changes']), batchId: PositiveIdSchema }), output: DataRowsSchema },
  'query.execute': { input: z.strictObject({ params: QueryRequestParamsSchema, expectedRevision: z.number().int().nonnegative() }), output: QueryViewSchema },
  'query.read': { input: PageSchema.extend({ page: PositiveIdSchema.optional(), pageSize: PositiveIdSchema.optional(), queryId: PositiveIdSchema }), output: QueryViewSchema },
  'query.list': { input: z.strictObject({ sessionId: PositiveIdSchema, beforeQueryId: PositiveIdSchema.optional(), limit: PositiveIdSchema.optional() }), output: z.strictObject({ items: z.array(QuerySummarySchema), nextBeforeQueryId: PositiveIdSchema.nullable() }) },
  'evidence.read': { input: PageSchema.extend({ page: PositiveIdSchema.optional(), pageSize: PositiveIdSchema.optional(), queryId: PositiveIdSchema, evidenceId: PositiveIdSchema }), output: EvidenceViewSchema },
  'tool.read': { input: z.strictObject({ runId: PositiveIdSchema, page: PositiveIdSchema.optional(), pageSize: PositiveIdSchema.optional() }), output: RunToolsViewSchema },
  "import.preview": { input: ImportPreviewRequestSchema, output: ImportPreviewSchema },
  "import.commit": { input: ImportCommitRequestSchema, output: ImportOperationSchema },
  "import.read": { input: ImportReferenceSchema, output: ImportOperationSchema.nullable() },
  "import.cancel": { input: ImportReferenceSchema, output: ImportOperationSchema },
  "import.recover": { input: ImportReferenceSchema, output: ImportOperationSchema },
  "evidence.readOperation": { input: z.strictObject({ kind: z.literal("import"), operationRef: OpaqueIdSchema }), output: ImportOperationSchema.nullable() },
  "evidence.readArtifact": { input: z.strictObject({ artifactId: PositiveIdSchema }), output: ArtifactSchema.nullable() },
  "run.control.read": { input: EmptyPayloadSchema, output: RuntimeControlViewSchema },
  "run.active": { input: EmptyPayloadSchema, output: ActiveRunViewSchema.nullable() },
  "run.read": { input: ReadRunRequestSchema, output: ReadRunResultSchema },
  "run.cancel": { input: z.strictObject({ runId: PositiveIdSchema }), output: CancelRunResultSchema },
  "run.retrySave": { input: z.strictObject({ runId: PositiveIdSchema }), output: RunViewSchema },
  "settings.ui.read": { input: EmptyPayloadSchema, output: uiResult },
  "settings.ui.update": {
    input: z.strictObject({ ...expectedVersion, patch: DesktopDisplayPreferencesSchema.partial().refine(patch => Object.keys(patch).length > 0, "At least one display preference is required") }), output: uiResult,
  },
  "diagnostics.read": {
    input: z.strictObject({ categories: z.array(DiagnosticsCategorySchema).max(5).refine(categories => new Set(categories).size === categories.length).default(["versions", "host", "errors", "runtime"]) }), output: DiagnosticsViewSchema,
  },
  "host.read": { input: EmptyPayloadSchema, output: HostViewSchema },
  "host.start": { input: EmptyPayloadSchema, output: HostViewSchema },
  "host.stop": { input: instanceControl, output: HostViewSchema },
  "host.restart": { input: instanceControl, output: HostViewSchema },
} as const;
export type PublicMethod = keyof typeof publicMethodSchemas;
/** Wire contracts stay structural; trusted owners apply the current or frozen policy. */
export function createPublicMethodSchemas() {
  const query = createQuerySchemas();
  const presentation = TOOL_READ_RULES;
  return {
    ...publicMethodSchemas,
    'data.read': { ...publicMethodSchemas['data.read'], input: query.PageSchema },
    'data.rows': { ...publicMethodSchemas['data.rows'], input: query.PageSchema.extend({ kind: z.enum(['devices', 'changes']), batchId: PositiveIdSchema }) },
    'query.read': { ...publicMethodSchemas['query.read'], input: query.PageSchema.extend({ queryId: PositiveIdSchema }) },
    'query.list': { ...publicMethodSchemas['query.list'], input: z.strictObject({ sessionId: PositiveIdSchema, beforeQueryId: PositiveIdSchema.optional(), limit: PositiveIdSchema.max(presentation.maxPageSize).default(presentation.defaultPageSize) }) },
    'evidence.read': { ...publicMethodSchemas['evidence.read'], input: query.PageSchema.extend({ queryId: PositiveIdSchema, evidenceId: PositiveIdSchema, pageSize: PositiveIdSchema.max(BUSINESS_RULES.maxPageSize).default(BUSINESS_RULES.evidencePageSize) }) },
    'tool.read': { ...publicMethodSchemas['tool.read'], input: z.strictObject({ runId: PositiveIdSchema, page: PositiveIdSchema.default(presentation.defaultPage), pageSize: PositiveIdSchema.max(presentation.maxPageSize).default(presentation.defaultPageSize) }).refine(value => Number.isSafeInteger((value.page - 1) * value.pageSize), 'Page offset must be a safe integer') },
  };
}
export type PublicPayload<M extends PublicMethod> = z.input<(typeof publicMethodSchemas)[M]["input"]>;
export type ParsedPublicPayload<M extends PublicMethod> = z.output<(typeof publicMethodSchemas)[M]["input"]>;
export type PublicReturn<M extends PublicMethod> = z.output<(typeof publicMethodSchemas)[M]["output"]>;
export const PublicMethodSchema = z.enum(Object.keys(publicMethodSchemas) as [PublicMethod, ...PublicMethod[]]);
export function parsePublicPayload<M extends PublicMethod>(method: M, payload: unknown): ParsedPublicPayload<M>;
export function parsePublicPayload(method: string, payload: unknown): unknown;
export function parsePublicPayload(method: string, payload: unknown): unknown {
  const name = PublicMethodSchema.parse(method);
  return publicMethodSchemas[name].input.parse(payload);
}
export interface Command<T> { requestId: string; instanceId: string; operationRef: string; payload: T }
export type CommandContext = Pick<Command<unknown>, "instanceId" | "operationRef">;
export interface Reply<T> { requestId: string; result: Result<T> }
export const commandSchema = <S extends z.ZodType>(payload: S) => z.strictObject({ requestId: OpaqueIdSchema, instanceId: OpaqueIdSchema, operationRef: OpaqueIdSchema, payload });
export const replySchema = <S extends z.ZodType>(data: S) => z.strictObject({ requestId: OpaqueIdSchema, result: resultSchema(data) });

export const AbsolutePathSchema = z.string().min(1).max(32768).refine(path => !/[\u0000-\u001f]/.test(path)
  && (/^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path) || path.startsWith("/")), "Expected an absolute trusted path");
export const HostHelloSchema = z.strictObject({
  protocolVersion: z.literal(HOST_PROTOCOL_VERSION), instanceId: OpaqueIdSchema, startupToken: OpaqueIdSchema,
  sdkVersion: z.literal(SDK_VERSION), expectedSchemaVersion: z.literal(DATABASE_SCHEMA_VERSION),
  paths: z.strictObject({ dataRoot: AbsolutePathSchema, databasePath: AbsolutePathSchema, settingsPath: AbsolutePathSchema, cachePath: AbsolutePathSchema, lockPath: AbsolutePathSchema }),
});
export const HostReadySchema = z.strictObject({
  protocolVersion: z.literal(HOST_PROTOCOL_VERSION), instanceId: OpaqueIdSchema, sdkVersion: z.literal(SDK_VERSION),
  schemaVersion: z.literal(DATABASE_SCHEMA_VERSION), configVersion: ConfigVersionSchema, dataRoot: AbsolutePathSchema,
});
export const HostShutdownRequestSchema = instanceControl;
export const HostShutdownResultSchema = z.strictObject({ executionStopped: z.boolean(), databaseClosed: z.boolean() });
export const hostPrivateMethodSchemas = {
  "host.shutdown": { input: HostShutdownRequestSchema, output: HostShutdownResultSchema },
  "settings.prepare": { input: z.strictObject({ token: OpaqueIdSchema, candidate: PublishedSettingsSchema }), output: z.strictObject({ prepared: z.literal(true), selection: ModelSelectionSchema.nullable() }) },
  "settings.commit": { input: z.strictObject({ token: OpaqueIdSchema, publishedVersion: ConfigVersionSchema }), output: z.strictObject({ configVersion: ConfigVersionSchema, selection: ModelSelectionSchema.nullable() }) },
  "settings.abort": { input: z.strictObject({ token: OpaqueIdSchema }), output: z.strictObject({ aborted: z.literal(true) }) },
} as const;
export type HostPrivateMethod = keyof typeof hostPrivateMethodSchemas;
const hostFields = { protocolVersion: z.literal(HOST_PROTOCOL_VERSION), kind: z.literal("request"), requestId: OpaqueIdSchema, instanceId: OpaqueIdSchema, operationRef: OpaqueIdSchema };
const hostRequest = <M extends string, S extends z.ZodType>(method: M, payload: S) => z.strictObject({ ...hostFields, method: z.literal(method), payload });
export const PublicHostRequestSchema = z.discriminatedUnion("method", [
  hostRequest("event.read", publicMethodSchemas["event.read"].input),
  hostRequest("event.subscribe", publicMethodSchemas["event.subscribe"].input),
  hostRequest("model.list", publicMethodSchemas["model.list"].input),
  hostRequest("model.read", publicMethodSchemas["model.read"].input),
  hostRequest("model.refresh", publicMethodSchemas["model.refresh"].input),
  hostRequest("operation.cancel", publicMethodSchemas["operation.cancel"].input),
  hostRequest("model.auth.start", publicMethodSchemas["model.auth.start"].input),
  hostRequest("model.auth.respond", publicMethodSchemas["model.auth.respond"].input),
  hostRequest("model.auth.cancel", publicMethodSchemas["model.auth.cancel"].input),
  hostRequest("model.auth.status", publicMethodSchemas["model.auth.status"].input),
  hostRequest("model.custom.read", publicMethodSchemas["model.custom.read"].input),
  hostRequest("model.custom.save", publicMethodSchemas["model.custom.save"].input),
  hostRequest("model.configure", publicMethodSchemas["model.configure"].input),
  hostRequest("model.policy.update", publicMethodSchemas["model.policy.update"].input),
  hostRequest("model.config.read", publicMethodSchemas["model.config.read"].input),
  hostRequest("model.config.rollback", publicMethodSchemas["model.config.rollback"].input),
  hostRequest("model.request", publicMethodSchemas["model.request"].input),
  hostRequest("model.diagnose", publicMethodSchemas["model.diagnose"].input),
  hostRequest("session.create", publicMethodSchemas["session.create"].input),
  hostRequest("session.select", publicMethodSchemas["session.select"].input),
  hostRequest("session.list", publicMethodSchemas["session.list"].input),
  hostRequest("session.read", publicMethodSchemas["session.read"].input),
  hostRequest("session.messages.read", publicMethodSchemas["session.messages.read"].input),
  hostRequest("session.submit", publicMethodSchemas["session.submit"].input),
  hostRequest("session.readInput", publicMethodSchemas["session.readInput"].input),
  hostRequest("session.listInputs", publicMethodSchemas["session.listInputs"].input),
  hostRequest("session.cancelInput", publicMethodSchemas["session.cancelInput"].input),
  hostRequest("session.readSubmission", publicMethodSchemas["session.readSubmission"].input),
  hostRequest("workspace.read", publicMethodSchemas["workspace.read"].input),
  hostRequest("workspace.restore", publicMethodSchemas["workspace.restore"].input),
  hostRequest("workspace.update", publicMethodSchemas["workspace.update"].input),
  hostRequest('data.read', publicMethodSchemas['data.read'].input),
  hostRequest('data.rows', publicMethodSchemas['data.rows'].input),
  hostRequest('query.execute', publicMethodSchemas['query.execute'].input),
  hostRequest('query.read', publicMethodSchemas['query.read'].input),
  hostRequest('query.list', publicMethodSchemas['query.list'].input),
  hostRequest('evidence.read', publicMethodSchemas['evidence.read'].input),
  hostRequest('tool.read', publicMethodSchemas['tool.read'].input),
  hostRequest("import.preview", publicMethodSchemas["import.preview"].input),
  hostRequest("import.commit", publicMethodSchemas["import.commit"].input),
  hostRequest("import.read", publicMethodSchemas["import.read"].input),
  hostRequest("import.cancel", publicMethodSchemas["import.cancel"].input),
  hostRequest("import.recover", publicMethodSchemas["import.recover"].input),
  hostRequest("evidence.readOperation", publicMethodSchemas["evidence.readOperation"].input),
  hostRequest("evidence.readArtifact", publicMethodSchemas["evidence.readArtifact"].input),
  hostRequest("run.control.read", publicMethodSchemas["run.control.read"].input),
  hostRequest("run.active", publicMethodSchemas["run.active"].input),
  hostRequest("run.read", publicMethodSchemas["run.read"].input),
  hostRequest("run.cancel", publicMethodSchemas["run.cancel"].input),
  hostRequest("run.retrySave", publicMethodSchemas["run.retrySave"].input),
  hostRequest("settings.ui.read", publicMethodSchemas["settings.ui.read"].input),
  hostRequest("settings.ui.update", publicMethodSchemas["settings.ui.update"].input),
  hostRequest("diagnostics.read", publicMethodSchemas["diagnostics.read"].input),
  hostRequest("host.read", publicMethodSchemas["host.read"].input),
  hostRequest("host.start", publicMethodSchemas["host.start"].input),
  hostRequest("host.stop", publicMethodSchemas["host.stop"].input),
  hostRequest("host.restart", publicMethodSchemas["host.restart"].input),
]);
export const HostPrivateRequestSchema = z.discriminatedUnion("method", [
  hostRequest("host.shutdown", hostPrivateMethodSchemas["host.shutdown"].input),
  hostRequest("settings.prepare", hostPrivateMethodSchemas["settings.prepare"].input),
  hostRequest("settings.commit", hostPrivateMethodSchemas["settings.commit"].input),
  hostRequest("settings.abort", hostPrivateMethodSchemas["settings.abort"].input),
]);
export const HostRequestSchema = z.union([PublicHostRequestSchema, HostPrivateRequestSchema]);
const hostOutputSchema = z.union([...Object.values(publicMethodSchemas).map(method => method.output), ...Object.values(hostPrivateMethodSchemas).map(method => method.output)]);
export const HostReplySchema = z.strictObject({ protocolVersion: z.literal(HOST_PROTOCOL_VERSION), kind: z.literal("reply"), instanceId: OpaqueIdSchema, requestId: OpaqueIdSchema, result: resultSchema(hostOutputSchema) });
export const ProviderNoticeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("provider.preview"), runId: PositiveIdSchema, text: z.string().max(32768), truncated: z.boolean() }),
  z.strictObject({ type: z.literal("provider.settled"), runId: PositiveIdSchema }),
  z.strictObject({ type: z.literal("provider.persistence_failed"), runId: PositiveIdSchema, error: AppErrorSchema }),
]);
const agentIdentity = { sessionId: PositiveIdSchema, runId: PositiveIdSchema, noticeSequence: PositiveIdSchema };
export const AgentNoticeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("agent.preview"), ...agentIdentity, text: z.string().max(32768), truncated: z.boolean() }),
  z.strictObject({ type: z.literal("agent.settled"), ...agentIdentity, status: z.enum(["completed", "failed", "cancelled"]) }),
  z.strictObject({ type: z.literal("agent.persistence_failed"), ...agentIdentity, error: AppErrorSchema }),
]);
export const RuntimeNoticeSchema = z.union([
  ProviderNoticeSchema, AgentNoticeSchema, EventAvailableNoticeSchema, EventStreamNoticeSchema,
  z.strictObject({ type: z.literal("auth.prompt"), prompt: AuthPromptViewSchema }),
  z.strictObject({ type: z.literal("auth.notify"), notification: AuthNotifyViewSchema }),
  z.strictObject({ type: z.literal("auth.finished"), attempt: AuthAttemptViewSchema }),
  z.strictObject({ type: z.literal("model.refresh.status"), operationRef: OpaqueIdSchema, state: z.enum(["running", "completed", "aborted", "failed"]), error: AppErrorSchema.nullable() }),
  z.strictObject({ type: z.literal("config.changed"), configVersion: ConfigVersionSchema }),
]);
export const DesktopNoticeSchema = z.union([RuntimeNoticeSchema, z.strictObject({ type: z.literal("host.status"), host: HostViewSchema })]);
export const NoticeFrameSchema = z.strictObject({ protocolVersion: z.literal(HOST_PROTOCOL_VERSION), kind: z.literal("notice"), instanceId: OpaqueIdSchema, notice: RuntimeNoticeSchema });

// OAuth extension fields belong to Pi's private credential format, never to public projections.
const secretValue = z.string().max(65536);
export const CredentialSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("api_key"), key: secretValue.optional(), env: z.record(z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/), secretValue).optional() }),
  z.object({ type: z.literal("oauth"), refresh: secretValue, access: secretValue, expires: z.number().finite().nonnegative() }).catchall(z.json()),
]);
export const CredentialInfoSchema = z.strictObject({ providerId: ProviderIdSchema, type: z.enum(["api_key", "oauth"]) });
export const PrivateCredentialContextSchema = z.strictObject({
  purpose: z.enum(["auth", "runtime", "rollback"]), operationRef: OpaqueIdSchema,
  authAttemptId: OpaqueIdSchema.optional(), credentialRef: CredentialRefSchema.nullable().optional(),
});
const credentialProvider = { providerId: ProviderIdSchema, context: PrivateCredentialContextSchema };
const leaseId = { leaseId: OpaqueIdSchema };
const credentialCommit = z.discriminatedUnion("changed", [
  z.strictObject({ ...leaseId, expectedVersion: ConfigVersionSchema, changed: z.literal(false) }),
  z.strictObject({ ...leaseId, expectedVersion: ConfigVersionSchema, changed: z.literal(true), next: CredentialSchema }),
]);
export const privateCredentialMethodSchemas = {
  "file.resolve": { input: z.strictObject({ fileToken: OpaqueIdSchema, operationRef: OpaqueIdSchema }), output: AbsolutePathSchema },
  "credential.read": { input: z.strictObject(credentialProvider), output: CredentialSchema.nullable() },
  "credential.list": { input: EmptyPayloadSchema, output: z.array(CredentialInfoSchema).max(10000) },
  "credential.delete": { input: z.strictObject(credentialProvider), output: z.null() },
  "credential.modify.begin": {
    input: z.strictObject({ ...credentialProvider, expectedCredentialRef: CredentialRefSchema.nullable(), operationId: OpaqueIdSchema }),
    output: z.strictObject({ leaseId: OpaqueIdSchema, version: ConfigVersionSchema, current: CredentialSchema.nullable() }),
  },
  "credential.modify.commit": { input: credentialCommit, output: CredentialSchema.nullable() },
  "credential.modify.abort": { input: z.strictObject(leaseId), output: z.null() },
} as const;
export type PrivateCredentialMethod = keyof typeof privateCredentialMethodSchemas;
export type PrivateCredentialPayload<M extends PrivateCredentialMethod> = z.infer<(typeof privateCredentialMethodSchemas)[M]["input"]>;
export type PrivateCredentialReturn<M extends PrivateCredentialMethod> = z.infer<(typeof privateCredentialMethodSchemas)[M]["output"]>;
const privateFields = { protocolVersion: z.literal(HOST_PROTOCOL_VERSION), kind: z.literal("private"), instanceId: OpaqueIdSchema, requestId: OpaqueIdSchema, secret: z.literal(true) };
const privateRequest = <M extends string, S extends z.ZodType>(method: M, payload: S) => z.strictObject({ ...privateFields, method: z.literal(method), payload });
export const PrivateCredentialFrameSchema = z.discriminatedUnion("method", [
  privateRequest("file.resolve", privateCredentialMethodSchemas["file.resolve"].input),
  privateRequest("credential.read", privateCredentialMethodSchemas["credential.read"].input),
  privateRequest("credential.list", privateCredentialMethodSchemas["credential.list"].input),
  privateRequest("credential.delete", privateCredentialMethodSchemas["credential.delete"].input),
  privateRequest("credential.modify.begin", privateCredentialMethodSchemas["credential.modify.begin"].input),
  privateRequest("credential.modify.commit", privateCredentialMethodSchemas["credential.modify.commit"].input),
  privateRequest("credential.modify.abort", privateCredentialMethodSchemas["credential.modify.abort"].input),
]);
const privateReply = <M extends string, S extends z.ZodType>(method: M, output: S) => z.strictObject({ ...privateFields, method: z.literal(method), result: resultSchema(output) });
export const PrivateCredentialReplySchema = z.discriminatedUnion("method", [
  privateReply("file.resolve", privateCredentialMethodSchemas["file.resolve"].output),
  privateReply("credential.read", privateCredentialMethodSchemas["credential.read"].output),
  privateReply("credential.list", privateCredentialMethodSchemas["credential.list"].output),
  privateReply("credential.delete", privateCredentialMethodSchemas["credential.delete"].output),
  privateReply("credential.modify.begin", privateCredentialMethodSchemas["credential.modify.begin"].output),
  privateReply("credential.modify.commit", privateCredentialMethodSchemas["credential.modify.commit"].output),
  privateReply("credential.modify.abort", privateCredentialMethodSchemas["credential.modify.abort"].output),
]);
/** New input only: Main binds the returned one-use token to the invoking window/provider. */
export const DesktopSecretInputSchema = z.strictObject({ providerId: ProviderIdSchema, purpose: z.literal("custom_api_key"), value: z.string().min(1).max(4096) });
export const DesktopImportDirectorySchema = z.strictObject({ operationRef: OpaqueIdSchema });
export const DesktopImportDirectoryResultSchema = z.strictObject({ fileToken: OpaqueIdSchema, directoryName: z.string().min(1) }).nullable();
export const DesktopSecretInputResultSchema = z.strictObject({ token: SecretInputTokenSchema, expiresAt: TimestampSchema });
export const DesktopSecretDiscardSchema = z.strictObject({ token: SecretInputTokenSchema });

export type HostRequest = z.infer<typeof HostRequestSchema>;
export type PublicHostRequest = z.infer<typeof PublicHostRequestSchema>;
export type HostReply = z.infer<typeof HostReplySchema>;
export type HostHello = z.infer<typeof HostHelloSchema>;
export type HostReady = z.infer<typeof HostReadySchema>;
export type HostShutdownRequest = z.infer<typeof HostShutdownRequestSchema>;
export type HostShutdownResult = z.infer<typeof HostShutdownResultSchema>;
export type ProviderNotice = z.infer<typeof ProviderNoticeSchema>;
export type RuntimeNotice = z.infer<typeof RuntimeNoticeSchema>;
export type DesktopNotice = z.infer<typeof DesktopNoticeSchema>;
export type NoticeFrame = z.infer<typeof NoticeFrameSchema>;
export type Credential = z.infer<typeof CredentialSchema>;
export type PrivateCredentialContext = z.infer<typeof PrivateCredentialContextSchema>;
export type PrivateCredentialFrame = z.infer<typeof PrivateCredentialFrameSchema>;
export type PrivateCredentialReply = z.infer<typeof PrivateCredentialReplySchema>;
export type DesktopSecretInput = z.infer<typeof DesktopSecretInputSchema>;
export type DesktopSecretInputResult = z.infer<typeof DesktopSecretInputResultSchema>;
export type DiagnosticsEntry = z.infer<typeof DiagnosticsEntrySchema>;
export type DiagnosticsView = z.infer<typeof DiagnosticsViewSchema>;
export const HostFrameSchema = z.union([HostRequestSchema, HostReplySchema, NoticeFrameSchema, PrivateCredentialFrameSchema, PrivateCredentialReplySchema]);
export type HostFrame = z.infer<typeof HostFrameSchema>;

export function parseHostFrame(line: string, expectedInstanceId: string): HostFrame {
  if (new TextEncoder().encode(line.endsWith("\n") ? line.slice(0, -1) : line).byteLength > MAX_FRAME_BYTES) throw new Error("frame_too_large");
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new Error("invalid_frame"); }
  const frame = HostFrameSchema.parse(parsed);
  if (frame.instanceId !== OpaqueIdSchema.parse(expectedInstanceId)) throw new Error("host_protocol_mismatch");
  return frame;
}
export function encodeHostFrame(frame: HostFrame): string {
  const value = HostFrameSchema.parse(frame);
  const line = JSON.stringify(value);
  // ponytail: whole catalog is one 4 MiB frame; add model pagination only after a measured overflow.
  if (new TextEncoder().encode(line).byteLength > MAX_FRAME_BYTES) throw new Error(value.kind === "reply" ? "model_catalog_too_large" : "frame_too_large");
  return `${line}\n`;
}
