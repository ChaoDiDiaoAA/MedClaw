import { z } from 'zod';
import { AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema, type Result } from './error';
import { BatchSchema, BusinessDateSchema, ChangeSchema, FieldOriginsSchema, SourceRefSchema, SnapshotSchema, type Snapshot, type Change } from './query';
import { WorkspaceSelectionSchema } from './workspace';

export const ImportPreviewRequestSchema = z.strictObject({
  operationRef: OpaqueIdSchema,
  priorOperationRef: OpaqueIdSchema.optional(),
  fileToken: OpaqueIdSchema,
  mappingVersion: z.literal('medclaw.snapshot/v1'),
});
export const ImportCommitRequestSchema = z.strictObject({
  operationRef: OpaqueIdSchema,
  fileToken: OpaqueIdSchema,
});
export const ImportIssueSchema = z.strictObject({
  file: z.string().nullable(),
  row: PositiveIdSchema.nullable(),
  field: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});
export const ImportPreviewSchema = z.strictObject({
  operationRef: OpaqueIdSchema,
  inputKind: z.literal('snapshot_package'),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  batchCount: z.number().int().nonnegative(),
  entityCount: z.number().int().nonnegative(),
  mappingVersion: z.string(),
  rowCount: z.number().int().nonnegative(),
  sourceBundleId: z.string(),
  materialVersion: z.string(),
  region: z.string(),
  dateRange: z.strictObject({ start: z.string(), endInclusive: z.string() }),
  referenceDate: z.string(),
  timezone: z.string(),
  catalogRevision: z.number().int().nonnegative(),
  newBatchCount: z.number().int().nonnegative(),
  duplicateBatchCount: z.number().int().nonnegative(),
  scopeKeys: z.array(z.string()),
  snapshotDates: z.array(z.string()),
  canCommit: z.boolean(),
  issues: z.array(ImportIssueSchema),
});
export const ImportResultSchema = z.strictObject({
  importId: PositiveIdSchema,
  status: z.enum(['imported', 'duplicate', 'rejected']),
  batchIds: z.array(PositiveIdSchema),
  rowCount: z.number().int().nonnegative(),
  acceptedRows: z.number().int().nonnegative(),
  duplicateRows: z.number().int().nonnegative(),
  rejectedRows: z.number().int().nonnegative(),
  issues: z.array(ImportIssueSchema),
  sourceBundleId: z.string(),
  materialVersion: z.string(),
  artifactId: PositiveIdSchema.nullable(),
});
export const ImportOperationSchema = z.strictObject({
  operationRef: OpaqueIdSchema,
  priorOperationRef: OpaqueIdSchema.nullable(),
  state: z.enum(['preparing', 'ready', 'committing', 'imported', 'duplicate', 'rejected', 'failed', 'cancelled', 'interrupted']),
  preview: ImportPreviewSchema.nullable(),
  result: ImportResultSchema.nullable(),
  artifactId: PositiveIdSchema.nullable(),
  error: AppErrorSchema.nullable(),
  updatedAt: TimestampSchema,
});
export const ImportReferenceSchema = z.strictObject({ operationRef: OpaqueIdSchema });
export const ArtifactSchema = z.strictObject({
  id: PositiveIdSchema,
  operationRef: OpaqueIdSchema,
  status: z.enum(['reserved', 'ready']),
  format: z.literal('csv'),
  mimeType: z.literal('application/x-directory'),
  bytes: z.number().int().nonnegative().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  sourceAvailability:z.enum(['available','deleted']).optional(),
  deletedBatchIds:z.array(PositiveIdSchema).optional(),
  unavailableFiles:z.array(z.string()).optional(),
});
export type ImportPreviewRequest = z.infer<typeof ImportPreviewRequestSchema>;
export type ImportCommitRequest = z.infer<typeof ImportCommitRequestSchema>;
export type ImportIssue = z.infer<typeof ImportIssueSchema>;
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;
export type ImportResult = z.infer<typeof ImportResultSchema>;
export type ImportOperation = z.infer<typeof ImportOperationSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export const DataCatalogSchema = z.strictObject({
  batches: z.array(BatchSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1),
  batchCount: z.number().int().nonnegative(),
  deviceCount: z.number().int().nonnegative(),
  snapshotCount: z.number().int().nonnegative(),
  changeCount: z.number().int().nonnegative(),
  catalogRevision: z.number().int().nonnegative(),
  referenceDate: BusinessDateSchema.nullable(),
  timezone: z.string().nullable(),
});
export const DataRowsSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('devices'), items: z.array(SnapshotSchema), selections: z.array(WorkspaceSelectionSchema), totalRows: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.number().int().min(1) }),
  z.strictObject({ kind: z.literal('changes'), items: z.array(ChangeSchema), selections: z.array(WorkspaceSelectionSchema), totalRows: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.number().int().min(1) }),
]).refine(page => page.items.length === page.selections.length && page.selections.every(item => item.field === null
  && item.kind === (page.kind === 'devices' ? 'device' : 'change')), 'Selections must align with data rows');

export const SnapshotMetadataSchema = z.object({
  contract: z.enum(['medclaw.snapshot/v1', 'medclaw.snapshot/v2']),
  mappingVersion: z.literal('medclaw.snapshot/v1'),
  materialVersion: z.string().min(1),
  generatorVersion: z.string().min(1),
  seed: z.number().int(),
  sourceBundleId: z.string().min(1),
  scopeKey: z.string().min(1),
  region: z.string().min(1),
  snapshotDate: BusinessDateSchema,
  coverage: z.literal('full'),
  expectedEntityCount: z.number().int().positive(),
  observedEntityCount: z.number().int().nonnegative(),
  declaredMissingEntityIds: z.array(z.string().min(1)),
  missingReason: z.string().min(1).optional(),
  referenceDate: BusinessDateSchema,
  timezone: z.string().min(1),
}).passthrough();
export type SnapshotMetadata = z.infer<typeof SnapshotMetadataSchema>;
export const ImportRowSchema = z.strictObject({
  sourceDeviceId: z.string().min(1),
  sourceSubmissionId: z.string().min(1),
  sourceApplicant: z.string().min(1),
  deviceName: z.string().min(1),
  category: z.string().min(1),
  region: z.string().min(1),
  snapshotDate: BusinessDateSchema,
  priceCents: z.number().int().nonnegative().safe().nullable(),
  currency: z.literal('CNY'),
  unit: z.string().min(1),
  status: z.enum(['active', 'suspended', 'delisted', 'recalled']),
  manufacturer: z.string().min(1),
  distributor: z.string().nullable(),
  sourceRefs: z.array(SourceRefSchema.extend({ recordId: z.string().min(1) })).min(1),
  fieldOrigins: FieldOriginsSchema,
  sourceRowRef: z.string(),
});
export type ImportRow = z.infer<typeof ImportRowSchema>;
export type CheckedPackage = {
  root: string;
  files: { path: string; bytes: number }[];
  masters: Record<string, string>[];
  days: { file: string; metadata: SnapshotMetadata }[];
  fileCount: number;
  totalBytes: number;
  rowCount: number;
  calculationVersion: string;
};
export type ImportRecord = {
  id: number;
  instanceId: string;
  previewRequest: ImportPreviewRequest;
  commitRequest: ImportCommitRequest | null;
  operation: ImportOperation;
};
export type DiffEvent = Omit<Change, 'id'> & { eventKey: string };
export interface ImportStore {
  assertWritable(): void;
  read(operationRef: string): ImportRecord | null;
  begin(request: ImportPreviewRequest, instanceId: string): ImportRecord;
  update(operationRef: string, patch: { state: ImportOperation['state']; preview?: ImportPreview; error?: ImportOperation['error']; result?: ImportResult; commitRequest?: ImportCommitRequest }): ImportOperation;
  revision(): number;
  classify(pkg: CheckedPackage, rows: (file: string, metadata: SnapshotMetadata) => Iterable<ImportRow>): { newBatchCount: number; duplicateBatchCount: number };
  verifyCommitted(operationRef: string): void;
  commit(operationRef: string, pkg: CheckedPackage, preview: ImportPreview, rows: (file: string, metadata: SnapshotMetadata) => Iterable<ImportRow>, diff: (oldRows: Snapshot[], newRows: Snapshot[], oldBatchId: number, newBatchId: number) => DiffEvent[]): ImportOperation;
}
export interface ImportServicePort {
  preview(request: ImportPreviewRequest): Promise<Result<ImportPreview>>;
  commit(request: ImportCommitRequest): Promise<Result<ImportOperation>>;
  read(operationRef: string): Promise<Result<ImportOperation | null>>;
  cancel(operationRef: string): Promise<Result<ImportOperation>>;
  recover(operationRef: string): Promise<Result<ImportOperation>>;
}
