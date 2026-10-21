import { z } from 'zod';
import { OpaqueIdSchema, PositiveIdSchema, TimestampSchema, type AppError } from './error';
import { ModelSelectionSchema, AgentPolicySchema, RequestPolicySchema } from './model';
import { RuntimeConfigurationSchema } from './runtime-config';
import { StoredToolConfigurationSchema } from './tool-config';
import { FrozenRunResourcesSchema, RESOURCE_LIMITS } from './resources';
import { RunScopeSchema, type RunScope, type FinalCallFact, type RunCleanupRecord } from './run';
import type { NativeHistoryCommit, CompactionSaveFact, InitialNativeHistory } from './session';
import type { StartCallContext } from './context';
import type { ModelCallRecorderPort, ProviderOutcome } from './run';

export const SUBAGENT_ROLE_LIMITS = Object.freeze({ fileBytes: 64 * 1024, roles: 128 });
export const SubagentRoleIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const SubagentRoleToolsSchema = z.array(z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)).max(32)
  .refine(names => new Set(names).size === names.length && names.every(name =>
    !['Agent', 'edit', 'write', 'bash', 'powershell', 'query_intent_step'].includes(name) && !/^(?:import|export)(?:_|$)/i.test(name)), 'Only unique read-only role tool declarations are allowed');
export const SubagentRoleContentSchema = z.string().min(1).refine(content =>
  new TextEncoder().encode(content).byteLength <= SUBAGENT_ROLE_LIMITS.fileBytes && !/[\u0000]/.test(content)
  && content.isWellFormed(), 'Expected bounded UTF-8 role content');
export const SubagentRoleSourceRefSchema = z.strictObject({ kind: z.enum(['builtin', 'user']), file: z.string().min(1).max(256) });
export const SubagentRoleDiagnosticSchema = z.strictObject({
  roleId: SubagentRoleIdSchema.nullable(), source: SubagentRoleSourceRefSchema,
  reason: z.enum(['resource_missing', 'resource_invalid', 'resource_conflict', 'resource_too_large', 'resource_path_invalid', 'resource_changed']),
  message: z.string().min(1).max(1000),
});
export const SubagentRoleSnapshotSchema = z.strictObject({
  roleId: SubagentRoleIdSchema, description: z.string().min(1).max(1024), source: SubagentRoleSourceRefSchema,
  content: SubagentRoleContentSchema, declaredTools: SubagentRoleToolsSchema,
});
export const SubagentRoleItemSchema = SubagentRoleSnapshotSchema.omit({ content: true }).extend({
  description: z.string().min(1).max(1024).nullable(), declaredTools: SubagentRoleToolsSchema.nullable(),
  availability: z.enum(['ready', 'invalid', 'conflict']), diagnostics: z.array(SubagentRoleDiagnosticSchema).max(256),
});
export const SaveSubagentRoleFileInputSchema = z.strictObject({
  roleId: SubagentRoleIdSchema, content: SubagentRoleContentSchema, expectedContent: SubagentRoleContentSchema.nullable(),
});
export const FrozenRunSubagentsSchema = z.strictObject({ roles: z.array(SubagentRoleSnapshotSchema).max(SUBAGENT_ROLE_LIMITS.roles),
  diagnostics: z.array(SubagentRoleDiagnosticSchema).max(256), indexText: z.string().max(64 * 1024),
}).refine(value => new Set(value.roles.map(role => role.roleId)).size === value.roles.length
  && new TextEncoder().encode(JSON.stringify(value)).byteLength <= RESOURCE_LIMITS.runBytes, 'Unique bounded role snapshots are required');
export type SubagentRoleSnapshot = z.infer<typeof SubagentRoleSnapshotSchema>;
export type SubagentRoleDiagnostic = z.infer<typeof SubagentRoleDiagnosticSchema>;
export type SubagentRoleItem = z.infer<typeof SubagentRoleItemSchema>;
export type FrozenRunSubagents = z.infer<typeof FrozenRunSubagentsSchema>;
export type SaveSubagentRoleFileInput = z.infer<typeof SaveSubagentRoleFileInputSchema>;
export type SubagentRoleSource = {
  discover(): Promise<{ items: SubagentRoleItem[] }>;
  read(roleId: string): Promise<SubagentRoleSnapshot>;
  save(input: SaveSubagentRoleFileInput): Promise<SubagentRoleSnapshot>;
  capture(): Promise<Pick<FrozenRunSubagents, 'roles' | 'diagnostics'>>;
};
const selectedRoles = z.strictObject({ source: z.literal('selection'), sessionId: PositiveIdSchema });
const recordedRoles = z.strictObject({ source: z.literal('run'), runId: PositiveIdSchema });
export const SubagentsListInputSchema = z.discriminatedUnion('source', [selectedRoles, recordedRoles]);
export const SubagentsReadInputSchema = z.discriminatedUnion('source', [selectedRoles.extend({ roleId: SubagentRoleIdSchema }), recordedRoles.extend({ roleId: SubagentRoleIdSchema })]);
export const SubagentsSaveInputSchema = SaveSubagentRoleFileInputSchema.extend({ sessionId: PositiveIdSchema });
export const SubagentsListItemSchema = z.strictObject({ roleId: SubagentRoleIdSchema, description: z.string().max(1024).nullable(),
  source: z.enum(['builtin', 'user']), valid: z.boolean(), available: z.boolean(), reasons: z.array(z.string().min(1).max(128)).max(32),
  declaredTools: SubagentRoleToolsSchema.nullable() });
export const SubagentsListSchema = z.strictObject({ items: z.array(SubagentsListItemSchema).max(SUBAGENT_ROLE_LIMITS.roles), recorded: z.boolean(),
  reasons: z.array(z.string().min(1).max(128)).max(32), diagnostics: z.array(SubagentRoleDiagnosticSchema).max(256) });
export const SubagentsReadSchema = SubagentRoleSnapshotSchema.extend({ diagnostics: z.array(SubagentRoleDiagnosticSchema).max(256),
  editable: z.boolean(), expectedContent: SubagentRoleContentSchema.nullable(),
}).refine(value => value.editable ? value.expectedContent === value.content : value.expectedContent === null, 'Editing requires the exact current content');
export type SubagentsListInput = z.infer<typeof SubagentsListInputSchema>;
export type SubagentsReadInput = z.infer<typeof SubagentsReadInputSchema>;
export type SubagentsSaveInput = z.infer<typeof SubagentsSaveInputSchema>;
export type SubagentsList = z.infer<typeof SubagentsListSchema>;
export type SubagentsRead = z.infer<typeof SubagentsReadSchema>;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export function childScopeWithin(child: RunScope, parent: RunScope): boolean {
  return child.readOnly && child.batchIds.every(id => parent.batchIds.includes(id))
    && (parent.deviceIds === null || child.deviceIds !== null && child.deviceIds.every(id => parent.deviceIds!.includes(id)))
    && child.allowedToolNames.every(name => parent.allowedToolNames.includes(name))
    && child.allowedResourceRefs.every(ref => parent.allowedResourceRefs.includes(ref))
    && child.artifactIds.every(id => parent.artifactIds.includes(id));
}
export const BoundChildIdentitySchema = z.strictObject({
  instanceId: OpaqueIdSchema, parentRunId: PositiveIdSchema, parentSessionId: PositiveIdSchema,
  originToolCallId: PositiveIdSchema, originNativeToolCallId: OpaqueIdSchema,
  pluginAgentId: OpaqueIdSchema, nativeSessionId: OpaqueIdSchema,
  childRunId: PositiveIdSchema, childSessionId: PositiveIdSchema,
}).refine(i => i.childRunId !== i.parentRunId && i.childSessionId !== i.parentSessionId, 'Child must have independent identity');
export type BoundChildIdentity = z.infer<typeof BoundChildIdentitySchema>;
export const DelegationSourceSchema = z.strictObject({
  parentRunId: PositiveIdSchema, originToolCallId: PositiveIdSchema, parentSnapshotId: PositiveIdSchema,
  parentInputId: PositiveIdSchema.nullable(), nativeEntryId: OpaqueIdSchema,
});
export type DelegationSource = z.infer<typeof DelegationSourceSchema>;

// JSON only: an SDK tool reply contains text/image blocks; no functions or ambient state.
export const NativeAgentReplySchema = z.strictObject({
  content: z.array(z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('text'), text: z.string() }),
    z.strictObject({ type: z.literal('image'), data: z.string(), mimeType: z.string().min(1) }),
  ])), details: z.json(), usage: z.json().optional(), terminate: z.boolean().optional(),
});
export type NativeAgentReply = z.infer<typeof NativeAgentReplySchema>;
export const ChildResultSchema = z.strictObject({
  contract: z.literal('medclaw.child-result/v1'), childRunId: PositiveIdSchema, childSessionId: PositiveIdSchema,
  parentRunId: PositiveIdSchema, originToolCallId: PositiveIdSchema, pluginAgentId: OpaqueIdSchema, nativeSessionId: OpaqueIdSchema,
  outcome: z.enum(['completed', 'failed', 'cancelled']), text: z.string(),
  queryRefs: z.array(z.strictObject({ queryId: PositiveIdSchema })).refine(refs => new Set(refs.map(r => r.queryId)).size === refs.length, 'Unique queries required'),
  evidenceIds: z.array(PositiveIdSchema).refine(ids => new Set(ids).size === ids.length, 'Unique evidence required'),
  gaps: z.array(z.string().min(1).max(8192)).max(1000), truncated: z.boolean(),
  originalReply: NativeAgentReplySchema, finalLeafId: OpaqueIdSchema.nullable(),
  storageVersion: PositiveIdSchema, committedAt: TimestampSchema,
});
export const ChildResultViewSchema = ChildResultSchema.omit({ originalReply: true });
export type ChildResult = z.infer<typeof ChildResultSchema>;
export type ChildResultView = z.infer<typeof ChildResultViewSchema>;
export const FrozenChildConfigSchema = BoundChildIdentitySchema.safeExtend({
  contract: z.literal('medclaw.subagent/v1'), originSnapshotId: PositiveIdSchema, parentInputId: PositiveIdSchema.nullable(),
  pluginVersion: z.literal('0.19.0'), pluginGitHead: z.literal('4f572eaa04c09d3dbc16e4a5f13a16b295e84e14'),
  pluginIntegrity: z.string().startsWith('sha512-'), patchHash: hash.optional(),
  patchRevision: z.literal('medclaw-managed/2026-10-21').optional(),
  role: z.lazy(() => SubagentRoleSnapshotSchema).optional(),
  toolNames: z.array(z.string().min(1).max(256)).max(1000).refine(names => new Set(names).size === names.length && !names.some(n => ['Agent', 'edit', 'write', 'bash', 'powershell'].includes(n)), 'Only unique child tools allowed'),
  depth: z.literal(1), foreground: z.literal(true), scope: z.lazy(() => RunScopeSchema),
  model: ModelSelectionSchema, policy: RequestPolicySchema, agentPolicy: AgentPolicySchema,
  runtimeConfiguration: RuntimeConfigurationSchema, toolConfiguration: StoredToolConfigurationSchema,
  resources: FrozenRunResourcesSchema.optional(),
}).refine(c => (!!c.patchRevision || !!c.patchHash) && c.scope.readOnly && c.toolNames.length===c.scope.allowedToolNames.length && c.toolNames.every(name => c.scope.allowedToolNames.includes(name)), 'Frozen tools and build must match child scope');
export type FrozenChildConfig = z.infer<typeof FrozenChildConfigSchema>;
export type RegisterChildInput = {
  parentRunId: number; originToolCallId: number; pluginAgentId: string; nativeSessionId: string;
  prompt: string; initialHistory: InitialNativeHistory; createdAt: string;
  frozen: Omit<FrozenChildConfig, 'childRunId' | 'childSessionId'>;
};
export type ChildExecutionObservation = {
  identity: BoundChildIdentity; nativeIdle: true; calls: FinalCallFact[]; history: NativeHistoryCommit;
  cleanup: RunCleanupRecord; outcome: ProviderOutcome | null; error: AppError | null; compactions: CompactionSaveFact[];
};
// Internal to the original plugin factory; no public spawn or Session input entry.
export type ChildRuntimeCallbacks = {
  own(pluginAgentId: string, stop: () => Promise<void>): () => void;
  register(input: RegisterChildInput): BoundChildIdentity;
  reconcile?(pluginAgentId:string):BoundChildIdentity|null;
  startCall(runId: number, time: string, context?: StartCallContext): ModelCallRecorderPort;
  compaction?(identity: BoundChildIdentity): import('./session').AutoCompactionCallbacks;
  stream?(snapshot: import('./event').StreamSnapshot): void;
  finish(identity: BoundChildIdentity, observation: ChildExecutionObservation, reply: NativeAgentReply): CommittedChildResult;
  released(identity: BoundChildIdentity): void;
};
export type FinalChildFact = {
  status: 'completed' | 'failed' | 'cancelled'; endedAt: string; outputText: string; error: AppError | null;
  calls: FinalCallFact[]; history: NativeHistoryCommit; cleanup: RunCleanupRecord;
  compactions: CompactionSaveFact[]; childResult: ChildResult;
};
export type CommittedChildResult = { identity: BoundChildIdentity; result: ChildResult; persistence: 'committed' };
export type CommittedChildExecutionProof = Pick<BoundChildIdentity, 'parentRunId' | 'originToolCallId' | 'childRunId'> & {
  childOutcome: 'completed'; originalReply: NativeAgentReply; finalLeafId: string | null; storageVersion: number;
};
