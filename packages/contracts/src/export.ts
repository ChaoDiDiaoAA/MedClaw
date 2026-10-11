import { z } from 'zod';
import { AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema, type AppError, type Result } from './error';
import { AnswerRecordSchema, EvidenceSummarySchema, QueryRecordSchema } from './query';
import { ReferenceDateSchema, TimezoneSchema } from './model';

export const EXPORT_VERSION = 'medclaw.export/v1' as const;
export const ExportHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().nonnegative().safe();
const ids = z.array(PositiveIdSchema).refine(values => new Set(values).size === values.length, 'Duplicate IDs');
export const ExportFormatSchema = z.enum(['csv', 'json', 'markdown']);
export const ExportStateSchema = z.enum(['preparing', 'published', 'registered', 'copying', 'completed', 'failed', 'cancelled', 'interrupted']);
export const ExportCopyStateSchema = z.enum(['not_started', 'copying', 'verified', 'failed', 'unknown']);
export const ExportReferenceSchema = z.strictObject({ operationRef: OpaqueIdSchema });
export const ExportRequestSchema = z.strictObject({
  operationRef: OpaqueIdSchema, priorOperationRef: OpaqueIdSchema.optional(), queryId: PositiveIdSchema, answerId: PositiveIdSchema.nullable(),
  format: ExportFormatSchema, destinationToken: OpaqueIdSchema, destinationIdentity: ExportHashSchema,
}).refine(value => value.priorOperationRef !== value.operationRef, 'An attempt cannot refer to itself');
export const ExportArtifactSchema = z.strictObject({
  id: PositiveIdSchema, operationRef: OpaqueIdSchema, queryId: PositiveIdSchema, format: ExportFormatSchema,
  relativePath: z.string().regex(/^artifacts\/[1-9][0-9]*$/), sha256: ExportHashSchema, metadataSha256: ExportHashSchema.nullable(),
  sizeBytes: bytes, publishedAt: TimestampSchema.nullable(), registeredAt: TimestampSchema,
}).refine(value => value.relativePath === `artifacts/${value.id}`, 'Artifact path must match its identity');
export const ExportFileNameSchema = z.enum(['result.csv', 'metadata.json', 'result.json', 'result.md']);
export const ExportFileSchema = z.strictObject({ path: ExportFileNameSchema, bytes, sha256: ExportHashSchema });
const fileSets = { csv: ['metadata.json', 'result.csv'], json: ['result.json'], markdown: ['result.md'] } as const;
export const ExportManifestSchema = z.strictObject({
  contract: z.literal('medclaw.export-manifest/v1'), artifactId: PositiveIdSchema, originOperationRef: OpaqueIdSchema,
  queryId: PositiveIdSchema, resultHash: ExportHashSchema, answerId: PositiveIdSchema.nullable(), format: ExportFormatSchema,
  exportVersion: z.literal(EXPORT_VERSION), metadataHash: ExportHashSchema, files: z.array(ExportFileSchema).min(1).max(2),
}).refine(value => JSON.stringify(value.files.map(file => file.path).sort()) === JSON.stringify(fileSets[value.format])
  && Number.isSafeInteger(value.files.reduce((total, file) => total + file.bytes, 0)), 'Manifest must contain the complete fixed file set');
export const ExportCopyReceiptSchema = z.strictObject({
  contract: z.literal('medclaw.export-receipt/v1'), operationRef: OpaqueIdSchema, artifactId: PositiveIdSchema,
  destinationIdentity: ExportHashSchema, contentHash: ExportHashSchema, verifiedAt: TimestampSchema,
  files: z.array(z.strictObject({ name: ExportFileNameSchema, bytes, sha256: ExportHashSchema })).min(1).max(2),
}).refine(value => Object.values(fileSets).some(names => JSON.stringify(value.files.map(file => file.name).sort()) === JSON.stringify(names)),
  'Receipt must identify a complete delivered file set');
export const ExportOperationSchema = z.strictObject({
  operationRef: OpaqueIdSchema, priorOperationRef: OpaqueIdSchema.nullable(), state: ExportStateSchema, requestHash: ExportHashSchema,
  queryId: PositiveIdSchema, answerId: PositiveIdSchema.nullable(), format: ExportFormatSchema, artifact: ExportArtifactSchema.nullable(),
  publishedHash: ExportHashSchema.nullable(), copyState: ExportCopyStateSchema, error: AppErrorSchema.nullable(),
  cancelRequestedAt: TimestampSchema.nullable(), updatedAt: TimestampSchema,
}).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.operationRef === value.priorOperationRef) invalid('Attempt cannot refer to itself');
  if (value.artifact && (value.artifact.queryId !== value.queryId || value.artifact.format !== value.format
    || value.artifact.sha256 !== value.publishedHash)) invalid('Artifact must match the original source and published hash');
  if (['registered', 'copying', 'completed'].includes(value.state) && value.artifact === null) invalid('Registered stages require a ready artifact');
  if (value.state === 'published' && value.publishedHash === null) invalid('Published stage requires its hash');
  if (value.state === 'completed' && (value.copyState !== 'verified' || value.error !== null)) invalid('Completion requires verified delivery');
  if (value.copyState === 'verified' && value.state !== 'completed') invalid('Verified delivery must be completed');
  if (value.state === 'copying' && value.copyState !== 'copying') invalid('Copy stage must match copy state');
  if (['failed', 'interrupted'].includes(value.state) && value.error === null) invalid('Failure requires its original safe error');
  if (!['failed', 'cancelled', 'interrupted'].includes(value.state) && value.error !== null) invalid('Active or completed operation cannot claim a failure');
});
export const ExportListInputSchema = z.strictObject({ queryId: PositiveIdSchema, beforeExportId: PositiveIdSchema.optional(), limit: PositiveIdSchema.max(50).default(20) });
export const ExportListSchema = z.strictObject({ items: z.array(ExportOperationSchema).max(50), nextBeforeExportId: PositiveIdSchema.nullable() });
export const ActivityListInputSchema = z.strictObject({ sessionId: PositiveIdSchema.nullable(), beforeEventId: PositiveIdSchema.optional(), limit: PositiveIdSchema.max(100).default(50) });
export const BusinessActivitySchema = z.strictObject({ id: PositiveIdSchema, operationRef: OpaqueIdSchema, type: z.string().min(1).max(128),
  actor: z.enum(['user', 'agent', 'system']), occurredAt: TimestampSchema,
  sessionId: PositiveIdSchema.nullable(), runId: PositiveIdSchema.nullable(), importId: PositiveIdSchema.nullable(), queryId: PositiveIdSchema.nullable(), artifactId: PositiveIdSchema.nullable(), exportId: PositiveIdSchema.nullable(),
  details: z.strictObject({ source: z.enum(['user_form', 'intent', 'agent_tool']).nullable(), answerId: PositiveIdSchema.nullable(), rowCount: bytes.nullable(), batchCount: bytes.nullable(), resultHash: ExportHashSchema.nullable(), copyState: ExportCopyStateSchema.nullable() }),
});
export const ActivityListSchema = z.strictObject({ items: z.array(BusinessActivitySchema).max(100), nextBeforeEventId: PositiveIdSchema.nullable() });
export const FrozenExportSourceSchema = z.strictObject({
  query: QueryRecordSchema, evidence: z.array(EvidenceSummarySchema), answer: AnswerRecordSchema.nullable(),
  referenceDate: ReferenceDateSchema, timezone: TimezoneSchema, sourceAvailability: z.enum(['available', 'deleted']), deletedBatchIds: ids,
}).refine(value => value.query.rows.length <= 100000 && value.evidence.every(item => item.queryId === value.query.id)
  && (value.answer === null || value.answer.sessionId === value.query.sessionId && value.answer.queryIds.includes(value.query.id)), 'Frozen export source ownership or size mismatch');
export const PublishedExportSchema = z.strictObject({
  artifactId: PositiveIdSchema, relativePath: z.string(), manifest: ExportManifestSchema, sha256: ExportHashSchema,
  sizeBytes: bytes, metadataSha256: ExportHashSchema, publishedAt: TimestampSchema.nullable(),
}).refine(value => value.artifactId === value.manifest.artifactId && value.relativePath === `artifacts/${value.artifactId}`
  && value.metadataSha256 === value.manifest.metadataHash && value.sizeBytes === value.manifest.files.reduce((total, file) => total + file.bytes, 0), 'Publication does not match its manifest');
export const DesktopExportDestinationSchema = z.strictObject({ operationRef: OpaqueIdSchema, queryId: PositiveIdSchema, answerId: PositiveIdSchema.nullable(), format: ExportFormatSchema });
export const DesktopExportDestinationResultSchema = z.strictObject({ destinationToken: OpaqueIdSchema, destinationIdentity: ExportHashSchema, displayName: z.string().min(1) }).nullable();
export const ExportDestinationSchema = DesktopExportDestinationSchema.extend({ destinationToken: OpaqueIdSchema, destinationIdentity: ExportHashSchema });
export const ExportDestinationCopySchema = ExportDestinationSchema.extend({ artifactId: PositiveIdSchema, manifest: ExportManifestSchema,
  priorOperationRefs: z.array(OpaqueIdSchema).max(100).refine(values => new Set(values).size === values.length, 'Duplicate prior operations'),
}).refine(value => value.artifactId === value.manifest.artifactId && value.queryId === value.manifest.queryId && value.answerId === value.manifest.answerId
  && value.format === value.manifest.format && !value.priorOperationRefs.includes(value.operationRef), 'Copy must match the authorized artifact');

export type ExportFormat = z.infer<typeof ExportFormatSchema>;
export type ExportState = z.infer<typeof ExportStateSchema>;
export type ExportCopyState = z.infer<typeof ExportCopyStateSchema>;
export type ExportRequest = z.infer<typeof ExportRequestSchema>;
export type ExportArtifact = z.infer<typeof ExportArtifactSchema>;
export type ExportFile = z.infer<typeof ExportFileSchema>;
export type ExportManifest = z.infer<typeof ExportManifestSchema>;
export type ExportCopyReceipt = z.infer<typeof ExportCopyReceiptSchema>;
export type ExportOperation = z.infer<typeof ExportOperationSchema>;
export type FrozenExportSource = z.infer<typeof FrozenExportSourceSchema>;
export type PublishedExport = z.infer<typeof PublishedExportSchema>;
export type ExportPublication = { artifactId: number; originOperationRef: string; format: ExportFormat; source: FrozenExportSource };
export type AcceptedExport = { operationRef: string; requestHash: string; instanceId: string; sessionId: number; queryId: number; answerId: number | null;
  format: ExportFormat; priorExportId: number | null; reuseArtifactId: number | null; createdAt: string };
export type StoredExport = ExportOperation & { id: number; priorExportId: number | null; instanceId: string; sessionId: number;
  reservedArtifactId: number | null; createdAt: string; copyReceipt: ExportCopyReceipt | null };
export interface ExportStore {
  readSource(queryId: number, answerId: number | null): FrozenExportSource;
  accept(input: AcceptedExport): StoredExport;
  find(operationRef: string): StoredExport | null;
  publish(operationRef: string, proof: PublishedExport): void;
  register(operationRef: string, proof: PublishedExport): void;
  beginCopy(operationRef: string): void;
  complete(operationRef: string, receipt: ExportCopyReceipt): void;
  terminate(operationRef: string, state: 'failed' | 'cancelled' | 'interrupted', error: AppError | null, copyState: ExportCopyState): void;
  list(input: z.input<typeof ExportListInputSchema>): z.infer<typeof ExportListSchema>;
  requestCancel(operationRef: string): StoredExport;
  unfinished(): StoredExport[];
}
export interface ExportServicePort {
  readonly busy: boolean;
  export(request: ExportRequest): Promise<Result<ExportOperation>>;
  read(operationRef: string): Promise<Result<ExportOperation | null>>;
  cancel(operationRef: string): Promise<Result<ExportOperation>>;
  recover(operationRef: string): Promise<Result<ExportOperation>>;
  list(input: z.input<typeof ExportListInputSchema>): Promise<Result<z.infer<typeof ExportListSchema>>>;
  shutdown(): Promise<void>;
}
