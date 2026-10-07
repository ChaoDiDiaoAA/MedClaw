import { z } from 'zod';
import { OpaqueIdSchema, PositiveIdSchema, TimestampSchema, type AppError } from './error';
import { ModelSelectionSchema, AgentPolicySchema, RequestPolicySchema } from './model';
import { RuntimeConfigurationSchema } from './runtime-config';
import { StoredToolConfigurationSchema } from './tool-config';
import { FrozenRunResourcesSchema } from './resources';
import { RunScopeSchema, type RunScope, type FinalCallFact, type RunCleanupRecord } from './run';
import type { NativeHistoryCommit, CompactionSaveFact, InitialNativeHistory } from './session';

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
  parentInputId: PositiveIdSchema.nullable(), promptHash: hash, nativeEntryId: OpaqueIdSchema,
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
  queryRefs: z.array(z.strictObject({ queryId: PositiveIdSchema, resultHash: hash })).refine(refs => new Set(refs.map(r => r.queryId)).size === refs.length, 'Unique queries required'),
  evidenceIds: z.array(PositiveIdSchema).refine(ids => new Set(ids).size === ids.length, 'Unique evidence required'),
  gaps: z.array(z.string().min(1).max(8192)).max(1000), truncated: z.boolean(),
  originalReply: NativeAgentReplySchema, originalReplyHash: hash, finalLeafId: OpaqueIdSchema.nullable(),
  storageVersion: PositiveIdSchema, committedAt: TimestampSchema,
});
export const ChildResultViewSchema = ChildResultSchema.omit({ originalReply: true });
export type ChildResult = z.infer<typeof ChildResultSchema>;
export type ChildResultView = z.infer<typeof ChildResultViewSchema>;
export const FrozenChildConfigSchema = BoundChildIdentitySchema.safeExtend({
  contract: z.literal('medclaw.subagent/v1'), originSnapshotId: PositiveIdSchema, parentInputId: PositiveIdSchema.nullable(), promptHash: hash,
  pluginVersion: z.literal('0.19.0'), pluginGitHead: z.literal('4f572eaa04c09d3dbc16e4a5f13a16b295e84e14'),
  pluginIntegrity: z.string().startsWith('sha512-'), patchHash: hash,
  toolNames: z.array(z.string().min(1).max(256)).max(1000).refine(names => new Set(names).size === names.length && !names.some(n => ['Agent', 'edit', 'write', 'bash', 'powershell'].includes(n)), 'Only unique child tools allowed'),
  depth: z.literal(1), foreground: z.literal(true), scope: z.lazy(() => RunScopeSchema),
  model: ModelSelectionSchema, policy: RequestPolicySchema, agentPolicy: AgentPolicySchema,
  runtimeConfiguration: RuntimeConfigurationSchema, toolConfiguration: StoredToolConfigurationSchema,
  resources: FrozenRunResourcesSchema.optional(),
}).refine(c => c.scope.readOnly && c.toolNames.length===c.scope.allowedToolNames.length && c.toolNames.every(name => c.scope.allowedToolNames.includes(name)), 'Frozen tools must match child scope');
export type FrozenChildConfig = z.infer<typeof FrozenChildConfigSchema>;
export type RegisterChildInput = {
  parentRunId: number; originToolCallId: number; pluginAgentId: string; nativeSessionId: string;
  prompt: string; initialHistory: InitialNativeHistory; createdAt: string;
  frozen: Omit<FrozenChildConfig, 'childRunId' | 'childSessionId'>;
};
export type FinalChildFact = {
  status: 'completed' | 'failed' | 'cancelled'; endedAt: string; outputText: string; error: AppError | null;
  calls: FinalCallFact[]; history: NativeHistoryCommit; cleanup: RunCleanupRecord;
  compactions: CompactionSaveFact[]; childResult: ChildResult;
};
export type CommittedChildResult = { identity: BoundChildIdentity; result: ChildResult; persistence: 'committed' };
export type CommittedChildExecutionProof = Pick<BoundChildIdentity, 'parentRunId' | 'originToolCallId' | 'childRunId'> & {
  childOutcome: 'completed'; originalReplyHash: string; finalLeafId: string | null; storageVersion: number;
};
