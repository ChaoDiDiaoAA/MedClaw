import { z } from "zod";
import { PositiveIdSchema } from "./error";
import { ReferenceDateSchema } from './model';

export const RevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const distinctIds = z.array(PositiveIdSchema).max(10000).refine(ids => new Set(ids).size === ids.length, 'Duplicate identities');
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
  selection: z.null().optional(),
});
export const UpdateWorkspaceRequestSchema = z.strictObject({
  change: WorkspaceChangeSchema,
  expectedRevision: RevisionSchema,
});
export const WorkspaceViewSchema = z.strictObject({
  revision: RevisionSchema,
  sessionId: PositiveIdSchema.nullable(),
  materialVersion: z.string().min(1).nullable(),
  batchRefs: z.array(BatchRefSchema).max(10000).refine(refs => new Set(refs.map(ref => ref.id)).size === refs.length, 'Duplicate batches'),
  deviceIds: distinctIds,
  queryId: PositiveIdSchema.nullable(),
  activeView: z.enum(['data', 'changes', 'query', 'evidence']),
  selection: z.null(),
});
export type WorkspaceView = z.infer<typeof WorkspaceViewSchema>;
export type WorkspaceChange = z.infer<typeof WorkspaceChangeSchema>;
export type BatchRef = z.infer<typeof BatchRefSchema>;
