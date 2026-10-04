import { z } from "zod";
import { PositiveIdSchema } from "./error";
import { ReferenceDateSchema } from './model';

export const RevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const WorkspaceTargetIdSchema = z.string().max(16).regex(/^[1-9][0-9]*$/).refine(id => Number.isSafeInteger(Number(id)), 'Identity exceeds safe integer range');
export const WorkspaceTargetVersionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotKey = z.string().regex(/^snapshot:[1-9][0-9]*$/).refine(key => WorkspaceTargetIdSchema.safeParse(key.slice(9)).success);
const changeKey = z.string().regex(/^change:[1-9][0-9]*$/).refine(key => WorkspaceTargetIdSchema.safeParse(key.slice(7)).success);
export const WorkspaceRowKeySchema = z.union([snapshotKey, changeKey, z.string().regex(/^row:[a-f0-9]{64}$/)]);
const field = z.string().min(1).max(256).regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine(value => !['__proto__', 'prototype', 'constructor'].includes(value), 'Unsafe object field').nullable();
const selectionFields = { formatVersion: z.literal(1), targetId: WorkspaceTargetIdSchema, targetVersion: WorkspaceTargetVersionSchema, field };
export const WorkspaceSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...selectionFields, kind: z.literal('device'), rowKey: snapshotKey }),
  z.strictObject({ ...selectionFields, kind: z.literal('change'), rowKey: changeKey }),
  z.strictObject({ ...selectionFields, kind: z.literal('query-row'), rowKey: WorkspaceRowKeySchema }),
  z.strictObject({ ...selectionFields, kind: z.literal('evidence'), rowKey: snapshotKey.nullable() }),
]).refine(value => value.kind !== 'evidence' || value.rowKey !== null || value.field === null, 'Whole evidence cannot select a field');
export const WorkspaceNoticeSchema = z.strictObject({ code: z.literal('reference_cleared'),
  kind: z.enum(['session', 'batch', 'device', 'query', 'selection']), targetId: WorkspaceTargetIdSchema });
const distinctIds = z.array(PositiveIdSchema).refine(ids => new Set(ids).size === ids.length, 'Duplicate identities');
export const BatchRefSchema = z.strictObject({
  id: PositiveIdSchema,
  contentHash: z.string().min(1),
  snapshotDate: ReferenceDateSchema,
  scopeKey: z.string().min(1),
});
export const WorkspaceChangeSchema = z.strictObject({
  batchIds: distinctIds.optional(),
  deviceIds: distinctIds.optional(),
  queryId: PositiveIdSchema.nullable().optional(),
  activeView: z.enum(['data', 'changes', 'query', 'evidence']).optional(),
  selection: WorkspaceSelectionSchema.nullable().optional(),
});
export const UpdateWorkspaceRequestSchema = z.strictObject({
  change: WorkspaceChangeSchema,
  expectedRevision: RevisionSchema,
});
export const WorkspaceStateSchema = z.strictObject({
  revision: RevisionSchema,
  sessionId: PositiveIdSchema.nullable(),
  materialVersion: z.string().min(1).nullable(),
  batchRefs: z.array(BatchRefSchema).refine(refs => new Set(refs.map(ref => ref.id)).size === refs.length, 'Duplicate batches'),
  deviceIds: distinctIds,
  queryId: PositiveIdSchema.nullable(),
  activeView: z.enum(['data', 'changes', 'query', 'evidence']),
  selection: WorkspaceSelectionSchema.nullable(),
});
export const WorkspaceViewSchema = WorkspaceStateSchema.extend({ notices: z.array(WorkspaceNoticeSchema).optional() });
export const WorkspaceContextSchema = WorkspaceStateSchema.extend({ sessionId: PositiveIdSchema });
/** Freeze only domain state; restore notices are response metadata. */
export function toWorkspaceContext(state: WorkspaceState): WorkspaceContext {
  return WorkspaceContextSchema.parse({ revision: state.revision, sessionId: state.sessionId, materialVersion: state.materialVersion,
    batchRefs: state.batchRefs, deviceIds: state.deviceIds, queryId: state.queryId, activeView: state.activeView, selection: state.selection });
}
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export type WorkspaceView = z.infer<typeof WorkspaceViewSchema>;
export type WorkspaceContext = z.infer<typeof WorkspaceContextSchema>;
export type WorkspaceSelection = z.infer<typeof WorkspaceSelectionSchema>;
export type WorkspaceNotice = z.infer<typeof WorkspaceNoticeSchema>;
export type WorkspaceChange = z.infer<typeof WorkspaceChangeSchema>;
export type BatchRef = z.infer<typeof BatchRefSchema>;
export type WorkspaceInspection = { state: WorkspaceState; candidate: WorkspaceState; artifactIds: number[]; notices: WorkspaceNotice[]; fingerprint: string };
export interface WorkspaceStore {
  readWorkspace(): WorkspaceState;
  updateWorkspace(change: WorkspaceChange, expectedRevision: number, time: string): WorkspaceState;
  inspectWorkspace(invalidArtifactIds?: readonly number[]): WorkspaceInspection;
  commitWorkspaceRestore(expectedRevision: number, expectedFingerprint: string, candidate: WorkspaceState, time: string): WorkspaceState;
}
export type ManagedImportInspection = { status: 'valid' }
  | { status: 'invalid'; reason: 'missing_record' | 'owner_mismatch' | 'hash_mismatch' | 'missing_managed_file' }
  | { status: 'unavailable'; reason: 'root_unavailable' | 'temporary_io' | 'storage_unavailable' };
