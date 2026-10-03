import { z } from 'zod';
import { PositiveIdSchema } from './error';
import { BUSINESS_RULES, createQuerySchemas, BatchSchema, BusinessDateSchema, DeviceViewSchema, EvidenceSchema, FieldOriginsSchema, QueryPageSchema, QueryRecordSchema, SnapshotSchema, SourceRefSchema } from './query';
import { RunScopeSchema } from './run';
import { ReferenceDateSchema, TimezoneSchema } from './model';


function buildBusinessToolSchemas() {
  const { BatchIdsSchema, ChangesQuerySchema, CurrentQuerySchema, PaginationShape, TimeRangeSchema } = createQuerySchemas();
  const policy = BUSINESS_RULES;
  const queryPageSchema = QueryPageSchema.extend({ rows: QueryPageSchema.shape.rows.max(policy.maxPageSize), ...PaginationShape });
  return {
    check_data_coverage: {
      input: z.strictObject({
        time: TimeRangeSchema,
        snapshotMode: z.enum(['exact_date', 'as_of']).default(policy.coverageSnapshotMode),
        requirePredecessor: z.boolean().default(policy.coverageRequirePredecessor),
      }),
      output: z.strictObject({
        batchIds: z.array(PositiveIdSchema),
        missingDates: z.array(BusinessDateSchema),
        missingPredecessorBatchIds: z.array(PositiveIdSchema),
        complete: z.boolean(),
      }),
    },
    list_batches: {
      input: z.strictObject({
        time: TimeRangeSchema.optional(),
        ...PaginationShape,
      }),
      output: z.strictObject({
        items: z.array(BatchSchema).max(policy.maxPageSize),
        totalRows: z.number().int().nonnegative(),
        ...PaginationShape,
      }),
    },
    list_filter_values: {
      input: z.strictObject({
        batchIds: BatchIdsSchema,
        field: z.enum(['manufacturer', 'distributor', 'category', 'status', 'region']),
        ...PaginationShape,
      }),
      output: z.strictObject({
        values: z.array(z.string()).max(policy.maxPageSize),
        totalRows: z.number().int().nonnegative(),
        ...PaginationShape,
      }),
    },
    list_query_evidence: {
      input: z.strictObject({
        queryId: PositiveIdSchema,
        ...PaginationShape,
      }),
      output: z.strictObject({
        items: z.array(EvidenceSchema.pick({
          id: true,
          queryId: true,
          batchIds: true,
          resultHash: true,
          materialVersion: true,
        })).max(policy.maxPageSize),
        totalRows: z.number().int().nonnegative(),
        ...PaginationShape,
      }),
    },
    query_current_devices: {
      input: CurrentQuerySchema,
      output: queryPageSchema,
    },
    query_device_changes: {
      input: ChangesQuerySchema,
      output: queryPageSchema,
    },
    read_batch: {
      input: z.strictObject({
        batchId: PositiveIdSchema,
      }),
      output: BatchSchema,
    },
    read_data_scope: {
      input: z.strictObject({}),
      output: z.strictObject({
        scope: RunScopeSchema,
        referenceDate: ReferenceDateSchema,
        timezone: TimezoneSchema,
      }),
    },
    read_device: {
      input: z.strictObject({
        deviceId: PositiveIdSchema,
      }),
      output: DeviceViewSchema,
    },
    read_evidence_rows: {
      input: z.strictObject({
        evidenceId: PositiveIdSchema,
        ...PaginationShape,
      }),
      output: z.strictObject({
        items: z.array(SnapshotSchema).max(policy.maxPageSize),
        totalRows: z.number().int().nonnegative(),
        ...PaginationShape,
      }),
    },
    read_query_evidence: {
      input: z.strictObject({
        evidenceId: PositiveIdSchema,
      }),
      output: EvidenceSchema,
    },
    read_query_page: {
      input: z.strictObject({
        queryId: PositiveIdSchema,
        ...PaginationShape,
      }),
      output: queryPageSchema,
    },
    read_query: {
      input: z.strictObject({
        queryId: PositiveIdSchema,
      }),
      output: QueryRecordSchema.pick({
        kind: true,
        params: true,
        batchIds: true,
        resultHash: true,
        warnings: true,
        calculationVersion: true,
        createdAt: true,
        interpretation: true,
      }).extend({
        queryId: PositiveIdSchema,
        totalRows: z.number().int().nonnegative(),
      }),
    },
    read_source_metadata: {
      input: z.strictObject({
        evidenceId: PositiveIdSchema,
        ...PaginationShape,
      }),
      output: z.strictObject({
        items: z.array(z.strictObject({
          snapshotId: PositiveIdSchema,
          sourceRowRef: z.string(),
          sourceRefs: z.array(SourceRefSchema),
          fieldOrigins: FieldOriginsSchema,
        })).max(policy.maxPageSize),
        totalRows: z.number().int().nonnegative(),
        ...PaginationShape,
      }),
    },
    resolve_device: {
      input: z.strictObject({
        text: z.string().trim().min(1).max(policy.maxDeviceSearchLength),
        matchBy: z.enum(['name', 'source_id', 'submission_id']).default(policy.resolveMatchBy),
        ...PaginationShape,
      }),
      output: z.strictObject({
        resolution: z.enum(['none', 'unique', 'ambiguous']),
        items: z.array(DeviceViewSchema).max(policy.maxPageSize),
        totalRows: z.number().int().nonnegative(),
        ...PaginationShape,
      }),
    },
  } as const;
}

export const businessToolSchemas = buildBusinessToolSchemas();
export function createBusinessToolSchemas() { return businessToolSchemas; }

export type BusinessToolName = keyof typeof businessToolSchemas;
export type BusinessToolInput<Name extends BusinessToolName> = z.infer<(typeof businessToolSchemas)[Name]['input']>;
export type BusinessToolOutput<Name extends BusinessToolName> = z.infer<(typeof businessToolSchemas)[Name]['output']>;
