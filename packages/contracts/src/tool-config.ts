import { z } from 'zod';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = count.min(1);

// Current mutable Tool settings. Run and LLM budgets belong to runtime-config.ts.
export const TOOL_CONFIG = Object.freeze({
  maxResultBytes: 262144,
});
export const ToolConfigurationSchema = z.strictObject({
  maxResultBytes: positive.min(1024),
});
export type ToolConfiguration = z.infer<typeof ToolConfigurationSchema>;

// The six-group schema below only decodes saved legacy snapshots.
// Removed settings never become active again when publishing or rolling back.
const ratio = z.number().finite().min(0).max(1);
const days = positive.max(Math.floor(Number.MAX_SAFE_INTEGER / 86400000));
// Pi shell timers accept at most a signed 32-bit millisecond delay.
const seconds = positive.max(Math.floor(2147483647 / 1000));
const bounds = z.tuple([positive, positive]).refine(([lower, upper]) => lower < upper, 'Bucket bounds must increase');

export const LegacyToolConfigurationSchema = z.strictObject({
  runtime: z.strictObject({
    maxCalls: positive,
    maxModelCalls: positive,
    maxTimeoutMs: positive.min(1000),
    singleToolTimeoutMs: positive,
    maxResultBytes: positive.min(1024),
    maxRecoveryAttempts: count,
  }),
  scheduling: z.strictObject({
    callConvergenceRatio: ratio,
    remainingTimeConvergenceRatio: ratio,
    answerReserveMaxMs: positive,
    answerReserveRatio: ratio,
    readTimeoutFloorMs: positive,
    workTimeoutFloorMs: positive,
    timeoutMultiplier: z.number().finite().min(1).max(Number.MAX_SAFE_INTEGER),
  }),
  statistics: z.strictObject({
    windowDays: days,
    observationLimit: positive,
    perGroupLimit: positive,
    minimumCompleteSamples: positive,
    percentile: ratio.gt(0),
    timeoutRateFallback: ratio,
    batchCountBounds: bounds,
    timeSpanDaysBounds: z.tuple([days, days]).refine(([lower, upper]) => lower < upper, 'Bucket bounds must increase'),
    pageSizeBounds: bounds,
    nativeInputBytesBounds: bounds,
  }).refine(value => value.minimumCompleteSamples <= value.perGroupLimit && value.perGroupLimit <= value.observationLimit, 'Sample limits must fit the observation window'),
  native: z.strictObject({
    read: z.strictObject({
      offset: positive,
      limit: positive.nullable(),
    }),
    grep: z.strictObject({
      limit: positive,
      context: count,
      ignoreCase: z.boolean(),
      literal: z.boolean(),
    }),
    find: z.strictObject({
      limit: positive,
    }),
    ls: z.strictObject({
      limit: positive,
    }),
    bash: z.strictObject({
      timeout: seconds.nullable(),
    }),
    powershell: z.strictObject({
      timeout: seconds.nullable(),
    }),
  }),
  business: z.strictObject({
    defaultPage: positive,
    defaultPageSize: positive,
    maxPage: positive,
    maxPageSize: positive,
    maxSavedRows: positive,
    maxTimeSpanDays: days,
    maxBatchIds: positive,
    maxDeviceIds: positive,
    maxRegionLength: positive,
    maxFilterTextLength: positive,
    maxDeviceSearchLength: positive,
    querySnapshotMode: z.enum(['exact_date', 'as_of']),
    querySort: z.enum(['asc', 'desc']),
    coverageSnapshotMode: z.enum(['exact_date', 'as_of']),
    coverageRequirePredecessor: z.boolean(),
    resolveMatchBy: z.enum(['name', 'source_id', 'submission_id']),
    maxTopN: positive,
    evidenceSummaryLimit: positive,
    evidencePageSize: positive,
  }).refine(value => value.defaultPage <= value.maxPage && value.defaultPageSize <= value.maxPageSize && value.evidencePageSize <= value.maxPageSize && value.maxPage <= Math.floor(Number.MAX_SAFE_INTEGER / value.maxPageSize), 'Default pagination must fit its maximum and page offsets must be safe integers'),
  presentation: z.strictObject({
    defaultPage: positive,
    defaultPageSize: positive,
    maxPageSize: positive,
    inputPreviewChars: positive,
    resultPreviewChars: positive,
  }).refine(value => value.defaultPageSize <= value.maxPageSize && Number.isSafeInteger((value.defaultPage - 1) * value.defaultPageSize), 'Default pagination must fit its maximum and page offsets must be safe integers'),
});

export type LegacyToolConfiguration = z.infer<typeof LegacyToolConfigurationSchema>;

export const StoredToolConfigurationSchema = z.union([ToolConfigurationSchema, LegacyToolConfigurationSchema]);
export type StoredToolConfiguration = z.infer<typeof StoredToolConfigurationSchema>;

// Decode old snapshots without making their removed settings active again.
export function normalizeToolConfiguration(input?: { toolConfiguration?: unknown } | StoredToolConfiguration): ToolConfiguration {
  const candidate = input && ('maxResultBytes' in input || 'runtime' in input) ? input : input?.toolConfiguration;
  if (candidate === undefined) return ToolConfigurationSchema.parse(TOOL_CONFIG);
  const stored = StoredToolConfigurationSchema.parse(candidate);
  return ToolConfigurationSchema.parse('runtime' in stored ? {
    maxResultBytes: stored.runtime.maxResultBytes,
  } : stored);
}
