import { z } from "zod";
import { PositiveIdSchema, TimestampSchema } from "./error";
import { ReferenceDateSchema, TimezoneSchema } from "./model";
import type { ToolExecutionContext } from "./tool";
import type { RunScope } from "./run";

export const BusinessDateSchema = ReferenceDateSchema;
export const TimeRangeSchema = z.strictObject({ start: BusinessDateSchema, endExclusive: BusinessDateSchema })
  .refine(value => value.start < value.endExclusive && Date.parse(value.endExclusive) - Date.parse(value.start) <= 366 * 86400000, "Invalid date range");
export const PaginationShape = { page: z.number().int().min(1).max(100000).default(1), pageSize: z.number().int().min(1).max(500).default(50) };
export const PageSchema = z.strictObject(PaginationShape);
export type PageInput = z.infer<typeof PageSchema>;
export const BatchIdsSchema = z.array(PositiveIdSchema).min(1).max(10000).refine(ids => new Set(ids).size === ids.length, "Duplicate batch");
export const FilterShape = {
  region: z.string().min(1).max(256).optional(), deviceIds: z.array(PositiveIdSchema).min(1).max(10000).optional(),
  manufacturer: z.string().min(1).max(512).optional(), category: z.string().min(1).max(512).optional(),
  distributor: z.string().min(1).max(512).optional(), status: z.enum(["active", "suspended", "delisted", "recalled"]).optional(),
};
export const CurrentQuerySchema = z.strictObject({ batchIds: BatchIdsSchema, time: TimeRangeSchema.optional(),
  snapshotMode: z.enum(["exact_date", "as_of"]).default("exact_date"), ...FilterShape, sort: z.enum(["asc", "desc"]).default("asc"), ...PaginationShape });
export const ChangesQuerySchema = z.strictObject({ batchIds: BatchIdsSchema, time: TimeRangeSchema,
  changeKind: z.enum(["added", "missing", "field_changed"]).optional(), changeField: z.enum(["price", "status", "distributor"]).optional(),
  direction: z.enum(["increase", "decrease"]).optional(), threshold: z.strictObject({ operator: z.enum(["gt", "gte", "lt", "lte"]), value: z.number().finite().nonnegative() }).optional(),
  ...FilterShape, sort: z.enum(["asc", "desc"]).default("asc"), ...PaginationShape,
}).refine(value => (!value.direction && !value.threshold) || value.changeField === "price", "Price condition requires price field");
export type CurrentQueryInput = z.infer<typeof CurrentQuerySchema>;
export type ChangesQueryInput = z.infer<typeof ChangesQuerySchema>;
export const QueryParamsSchema = z.strictObject({
  kind: z.enum(['current', 'changes', 'aggregate', 'trend']),
  population: z.enum(['snapshot', 'changes']),
  snapshotMode: z.enum(['exact_date', 'as_of']).nullable(),
  batchIds: BatchIdsSchema,
  time: TimeRangeSchema.nullable().default(null),
  region: FilterShape.region.unwrap().nullable().default(null),
  deviceIds: FilterShape.deviceIds.unwrap().nullable().default(null),
  manufacturer: FilterShape.manufacturer.unwrap().nullable().default(null),
  category: FilterShape.category.unwrap().nullable().default(null),
  distributor: FilterShape.distributor.unwrap().nullable().default(null),
  status: FilterShape.status.unwrap().nullable().default(null),
  changeKind: z.enum(['added', 'missing', 'field_changed']).nullable().default(null),
  changeField: z.enum(['price', 'status', 'distributor']).nullable().default(null),
  direction: z.enum(['increase', 'decrease']).nullable().default(null),
  threshold: z.strictObject({ operator: z.enum(['gt', 'gte', 'lt', 'lte']), value: z.number().finite().nonnegative() }).nullable().default(null),
  metric: z.enum(['count', 'changed_device_count', 'sum_price', 'mean_price', 'change_count']).nullable().default(null),
  groupBy: z.enum(['date', 'region', 'category', 'manufacturer', 'status']).nullable().default(null),
  topN: z.number().int().min(1).max(100).nullable().default(null),
  sort: z.enum(['asc', 'desc']).default('asc'),
  ...PaginationShape,
}).superRefine((value, context) => {
  const invalid = (message: string) => context.addIssue({ code: 'custom', message });
  if (value.population === 'snapshot' ? value.snapshotMode === null : value.snapshotMode !== null) invalid('Snapshot mode must match population');
  if (value.population === 'changes' && value.time === null) invalid('Changes require a date range');
  if (value.population === 'snapshot' && (value.changeKind || value.changeField || value.direction || value.threshold)) invalid('Change filters require changes population');
  if ((value.direction || value.threshold) && value.changeField !== 'price') invalid('Price condition requires price field');
  if (value.kind === 'current' && value.population !== 'snapshot' || value.kind === 'changes' && value.population !== 'changes') invalid('Kind must match population');
  if (value.kind === 'current' || value.kind === 'changes') {
    if (value.metric !== null || value.groupBy !== null || value.topN !== null) invalid('Listing does not accept aggregate fields');
  } else {
    if (value.metric === null) invalid('Aggregate metric is required');
    if (value.population === 'snapshot' && (value.metric === 'change_count' || value.metric === 'changed_device_count')
      || value.population === 'changes' && (value.metric === 'count' || value.metric === 'sum_price' || value.metric === 'mean_price')) invalid('Metric must match population');
  }
  if (value.kind === 'trend' && (value.time === null || value.population === 'snapshot' && value.snapshotMode !== 'exact_date' || value.topN !== null)) invalid('Trend requires an exact date grid and no topN');
});
export type QueryParams = z.infer<typeof QueryParamsSchema>;
export type QuerySource = 'agent_tool' | 'intent' | 'user_form';
export type QueryExecutionContext = {
  runId: number;
  inputId: null;
  sessionId: number;
  source: QuerySource;
  callRef: string;
  scope: RunScope;
  referenceDate: string;
  timezone: string;
  signal: AbortSignal;
  basedOnQueryId?: number | null;
  workspaceRevision?: number;
};
export type QueryContext = ToolExecutionContext | QueryExecutionContext;
export type CatalogFilters = {
  deviceIds?: number[] | null;
  region?: string | null;
  manufacturer?: string | null;
  category?: string | null;
  distributor?: string | null;
  status?: z.infer<typeof FilterShape.status> | null;
  changeKind?: z.infer<typeof ChangesQuerySchema>['changeKind'] | null;
  changeField?: z.infer<typeof ChangesQuerySchema>['changeField'] | null;
  direction?: z.infer<typeof ChangesQuerySchema>['direction'] | null;
  threshold?: z.infer<typeof ChangesQuerySchema>['threshold'] | null;
};
export const SourceRefSchema = z.strictObject({ sourceId: z.string(), file: z.string(), recordId: z.string(), row: PositiveIdSchema, sha256: z.string() });
export const FieldOriginSchema = z.strictObject({ kind: z.enum(["public", "synthetic", "synthetic-derived"]), ruleId: z.string().min(1), lastAdjustmentDate: BusinessDateSchema.optional() });
export const FieldOriginsSchema = z.record(z.string(), FieldOriginSchema);
export const BatchSchema = z.strictObject({ id: PositiveIdSchema, scopeKey: z.string(), snapshotDate: BusinessDateSchema,
  region: z.string(), coverage: z.literal("full"), previousBatchId: PositiveIdSchema.nullable(), materialVersion: z.string(),
  sourceBundleId: z.string(), sourceLockHash: z.string(), contentHash: z.string(), cohortHash: z.string(), catalogRevision: z.number().int().nonnegative(),
  expectedEntityCount: z.number().int().nonnegative(), observedEntityCount: z.number().int().nonnegative(),
  declaredMissingDeviceIds: z.array(PositiveIdSchema).max(10000).default([]) });
export const DeviceSchema = z.strictObject({ id: PositiveIdSchema, sourceDeviceId: z.string(), sourceBundleId: z.string(),
  sourceSubmissionId: z.string(), sourceApplicant: z.string().nullable(), sourceRefs: z.array(SourceRefSchema) });
export const DeviceViewSchema = DeviceSchema.extend({ deviceName: z.string() });
export const SnapshotSchema = z.strictObject({ id: PositiveIdSchema, batchId: PositiveIdSchema, deviceId: PositiveIdSchema,
  deviceName: z.string(), category: z.string().nullable(), region: z.string(), priceCents: z.number().int().nonnegative().safe().nullable(),
  currency: z.literal("CNY"), unit: z.string(), status: z.enum(["active", "suspended", "delisted", "recalled"]).nullable(),
  manufacturer: z.string().nullable(), distributor: z.string().nullable(), sourceRowRef: z.string(),
  sourceRefs: z.array(SourceRefSchema), fieldOrigins: FieldOriginsSchema });
export const ChangeSchema = z.strictObject({ id: PositiveIdSchema, deviceId: PositiveIdSchema, oldBatchId: PositiveIdSchema, newBatchId: PositiveIdSchema,
  kind: z.enum(["added", "missing", "field_changed"]), field: z.enum(["price", "status", "distributor"]).nullable(),
  oldValue: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]), newValue: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
  deltaCents: z.number().int().safe().nullable(), ratio: z.number().finite().nullable(), calculationVersion: z.string() });
export const BusinessDataSchema = z.strictObject({ batches: z.array(BatchSchema), devices: z.array(DeviceSchema), snapshots: z.array(SnapshotSchema), changes: z.array(ChangeSchema) });
export type Batch = z.infer<typeof BatchSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type Change = z.infer<typeof ChangeSchema>;
export type BusinessData = z.infer<typeof BusinessDataSchema>;
export const QueryRowSchema = z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()]));
export const QueryInterpretationSchema = z.strictObject({
  requestedDate: BusinessDateSchema.nullable(),
  requestedTime: TimeRangeSchema.nullable(),
  referenceDate: BusinessDateSchema.nullable(),
  timezone: TimezoneSchema.nullable(),
  dataDates: z.array(BusinessDateSchema).max(10000),
  snapshotMode: z.enum(['exact_date', 'as_of']).nullable(),
  basis: z.enum(['snapshot_records', 'distinct_device_identifiers_per_scope', 'change_events', 'changed_device_identifiers_per_scope', 'sum_price', 'mean_price']),
  status: FilterShape.status.unwrap().nullable(),
  quantity: z.number().finite().nonnegative().nullable(),
  unit: z.enum(['records', 'identifiers', 'events', 'CNY cents']),
  isStale: z.boolean().nullable(),
});
export type QueryInterpretation = z.infer<typeof QueryInterpretationSchema>;
export const QueryRecordSchema = z.strictObject({ id: PositiveIdSchema, sessionId: PositiveIdSchema, runId: PositiveIdSchema, callRef: z.string(),
  kind: z.enum(["current", "changes", "aggregate", "trend"]), params: z.union([QueryParamsSchema, ChangesQuerySchema, CurrentQuerySchema]), batchIds: BatchIdsSchema,
  source: z.enum(['agent_tool', 'intent', 'user_form']).optional(),
  catalogRevision: z.number().int().nonnegative().optional(),
  materialVersion: z.string().optional(),
  basedOnQueryId: PositiveIdSchema.nullable().optional(),
  interpretation: QueryInterpretationSchema.optional(),
  scopeDeviceIds: z.array(PositiveIdSchema).max(10000).nullable(),
  rows: z.array(QueryRowSchema).max(100000), snapshotIds: z.array(PositiveIdSchema), eventIds: z.array(PositiveIdSchema),
  warnings: z.array(z.string()), calculationVersion: z.string(), resultHash: z.string(), createdAt: TimestampSchema });
export type QueryRecord = z.infer<typeof QueryRecordSchema>;
export const QuerySummarySchema = QueryRecordSchema.omit({ rows: true, snapshotIds: true, eventIds: true }).extend({
  totalRows: z.number().int().nonnegative(),
});
export type QuerySummary = z.infer<typeof QuerySummarySchema>;
export const QueryPageSchema = z.strictObject({ queryId: PositiveIdSchema, rows: z.array(QueryRowSchema).max(500), totalRows: z.number().int().nonnegative(),
  page: z.number().int().positive(), pageSize: z.number().int().positive().max(500), warnings: z.array(z.string()), calculationVersion: z.string(), evidenceIds: z.array(PositiveIdSchema),
  interpretation: QueryInterpretationSchema.optional() });
export const EvidenceSchema = z.strictObject({ id: PositiveIdSchema, queryId: PositiveIdSchema, batchIds: BatchIdsSchema,
  snapshotIds: z.array(PositiveIdSchema), eventIds: z.array(PositiveIdSchema), sourceRowRefs: z.array(z.string()),
  calculationVersion: z.string(), materialVersion: z.string(), sourceBundleId: z.string(), sourceLockHash: z.string(), resultHash: z.string(),
  filters: z.union([QueryParamsSchema, ChangesQuerySchema, CurrentQuerySchema]).optional(),
  provenance: z.enum(['public', 'synthetic', 'synthetic-derived']).optional() });
export type Evidence = z.infer<typeof EvidenceSchema>;
export const EvidenceSummarySchema = EvidenceSchema.omit({ snapshotIds: true, eventIds: true, sourceRowRefs: true }).extend({
  snapshotCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
});
export type EvidenceSummary = z.infer<typeof EvidenceSummarySchema>;
export const QueryViewSchema = z.strictObject({
  query: QuerySummarySchema,
  page: QueryPageSchema,
  evidence: z.array(EvidenceSummarySchema).max(500),
});
export const EvidenceViewSchema = z.strictObject({
  evidence: EvidenceSummarySchema,
  items: z.array(SnapshotSchema).max(100),
  totalRows: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
});
export type SnapshotReference = Pick<Snapshot, 'id' | 'batchId' | 'deviceId' | 'sourceRowRef'>;
export type CatalogSummary = { rows: QueryRecord['rows']; snapshotIds: number[]; eventIds: number[] };
export interface CatalogStore {
  readRevision(): number;
  readBatches(ids: number[]): Batch[];
  readDevices(ids: number[]): Device[];
  readSnapshots(batchIds: number[], deviceIds: number[] | null, filters?: CatalogFilters): Snapshot[];
  readChanges(newBatchIds: number[], oldBatchIds: number[], deviceIds: number[] | null, filters?: CatalogFilters): Change[];
  readSnapshot(id: number): Snapshot | null;
  readSnapshotsById(ids: number[]): Snapshot[];
  readSnapshotReferences(ids: number[]): SnapshotReference[];
  summarize(params: QueryParams, batchIds: number[], allowedOldBatchIds: number[], deviceIds: number[] | null): CatalogSummary;
  readSnapshotFor(batchId: number, deviceId: number): Snapshot | null;
}
export interface QueryStore {
  withQueryTransaction?<T>(action: () => T): T;
  assertContext(context: QueryContext): void;
  assertReadContext?(context: QueryContext): void;
  findQuery(callRef: string): QueryRecord | null;
  readQuery(id: number): QueryRecord | null;
  readEvidence(id: number): Evidence | null;
  listEvidence(queryId: number): Evidence[];
  commitQuery(query: Omit<QueryRecord, "id">, evidence: Omit<Evidence, "id" | "queryId">[], context: QueryContext): QueryRecord;
}
