import { MeasurementContextSchema, ToolProfileSnapshotSchema, type MeasurementContext, type ToolProfileSnapshot } from '@medclaw/contracts/model';
import { canonicalRequest, type RunScope } from '@medclaw/contracts/run';
import { ToolObservationSchema, type ToolObservation } from '@medclaw/contracts/tool';

export const TOOL_PROFILE_RULES = Object.freeze({
  windowDays: 30,
  observationLimit: 2000,
  perGroupLimit: 50,
  minimumCompleteSamples: 20,
  percentile: 0.95,
  timeoutRateFallback: 0.2,
  batchCountBounds: [1, 31],
  timeSpanDaysBounds: [1, 31],
  pageSizeBounds: [100, 500],
  nativeInputBytesBounds: [4096, 65536],
});

type Observations = {
  maxToolCallId: number | null;
  observations: ToolObservation[];
};
const sizeBucket = (size: number | null, low: number, high: number, labels: string[]) =>
  size === null ? 'n/a' : labels[size <= low ? 0 : size <= high ? 1 : 2]!;

/** Input dimensions are known before execution; result size is deliberately absent. */
export function groupWorkload(input: unknown, scope?: RunScope, native = false): string {
  const stats = TOOL_PROFILE_RULES;
  const bucket = (size: number | null, bounds: number[], labels: string[]) => sizeBucket(size, bounds[0]!, bounds[1]!, labels);
  const fields = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  if (native) {
    const bytes = Buffer.byteLength(canonicalRequest(input) ?? 'null', 'utf8');
    return `batches=n/a;days=n/a;page=n/a;bytes=${bucket(bytes, stats.nativeInputBytesBounds, ['0-4KiB', '4-64KiB', '64KiB+'])}`;
  }
  const count = Array.isArray(fields.batchIds) ? fields.batchIds.length : typeof fields.batchId === 'number' ? 1 : scope?.batchIds.length ?? null;
  const batches = count === 0 ? null : count;
  const time = fields.time !== null && typeof fields.time === 'object' ? fields.time as Record<string, unknown> : {};
  const start = typeof time.start === 'string' ? Date.parse(`${time.start}T00:00:00.000Z`) : NaN;
  const end = typeof time.endExclusive === 'string' ? Date.parse(`${time.endExclusive}T00:00:00.000Z`) : NaN;
  const days = Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.ceil((end - start) / 86400000) : null;
  const page = typeof fields.pageSize === 'number' ? fields.pageSize : null;
  return `batches=${bucket(batches, stats.batchCountBounds, ['1', '2-31', '32+'])};days=${bucket(days, stats.timeSpanDaysBounds, ['1', '2-31', '32+'])};page=${bucket(page, stats.pageSizeBounds, ['1-100', '101-500', '501+'])};bytes=n/a`;
}

export function buildToolProfiles(input: Observations | null, context: MeasurementContext): ToolProfileSnapshot {
  const measurement = MeasurementContextSchema.parse(context);
  const statistics = TOOL_PROFILE_RULES;
  const snapshot: ToolProfileSnapshot = {
    version: 'medclaw.tool-profile/v1',
    cutoffAt: measurement.cutoffAt,
    maxToolCallId: measurement.maxToolCallId,
    windowDays: statistics.windowDays,
    observationLimit: statistics.observationLimit,
    perGroupLimit: statistics.perGroupLimit,
    minimumCompleteSamples: statistics.minimumCompleteSamples,
    available: input !== null,
    profiles: [],
  };
  if (input === null) return snapshot;
  const cutoff = Date.parse(measurement.cutoffAt);
  const groups = new Map<string, ToolObservation[]>();
  const observations = input.observations.filter(row => ToolObservationSchema.safeParse(row).success
    && measurement.maxToolCallId !== null && row.id <= measurement.maxToolCallId
    && Date.parse(row.requestedAt) <= cutoff && Date.parse(row.requestedAt) >= cutoff - statistics.windowDays * 86400000)
    .sort((a, b) => b.id - a.id).slice(0, statistics.observationLimit);
  for (const row of observations) {
    const stored = row.measurementContext;
    if (!stored || !row.control?.workloadBucket || !row.control.environmentKey || stored.environmentKey !== row.control.environmentKey) continue;
    const key = canonicalRequest([row.name, row.version, stored.sdkVersion, stored.version, stored.environmentKey, row.control.workloadBucket]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const rows of groups.values()) {
    const first = rows[0]!;
    const stored = first.measurementContext!;
    const executions = rows.filter(row => row.startedAt !== null).slice(0, statistics.perGroupLimit);
    const known = executions.filter(row => row.stoppedAt !== null && row.status !== 'running' && row.status !== 'requested');
    const timeouts = known.filter(row => row.control?.timeoutRequestedAt !== null && row.control?.timeoutRequestedAt !== undefined);
    const complete = executions.filter(row => row.status === 'succeeded' && row.stoppedAt !== null
      && row.control?.latencyObservation === 'complete' && row.control.executionElapsedMs !== null && row.control.timeoutRequestedAt === null)
      .map(row => row.control!.executionElapsedMs!).sort((a, b) => a - b);
    const timeoutRate = known.length ? timeouts.length / known.length : null;
    const reliability: Record<string, number> = {
      executionFailures: 0,
      inputRejections: 0,
      outputValidationFailures: 0,
      businessValidationFailures: 0,
      preflightFailures: 0,
      postflightFailures: 0,
      timeouts: timeouts.length,
      cancellations: 0,
      originalResultUnknown: 0,
      confirmedRecoveries: 0,
      permissionRejections: 0,
      expectedDataShortages: 0,
      persistenceFailures: 0,
      complete: executions.filter(row => row.control?.latencyObservation === 'complete').length,
      rightCensored: executions.filter(row => row.control?.latencyObservation === 'right_censored').length,
      missing: executions.filter(row => row.control?.latencyObservation === 'missing').length,
    };
    const selected = new Set(executions.map(row => row.id));
    for (const row of rows.filter(row => row.startedAt === null || selected.has(row.id))) {
      const control = row.control!;
      const code = control.failureClass;
      if (row.status === 'failed' && ['execution', 'execute'].includes(control.failureStage ?? '')
        && !['timeout', 'tool_timeout', 'run_timeout', 'access_denied', 'invalid_argument', 'tool_input_invalid', 'data_coverage_missing',
          'storage_write_failed', 'storage_read_failed', 'tool_cancelled', 'runtime_interrupted', 'tool_output_invalid', 'tool_output_inconsistent'].includes(code ?? '')
        && control.timeoutRequestedAt === null) reliability.executionFailures!++;
      if (code === 'access_denied') reliability.permissionRejections!++;
      if (code === 'data_coverage_missing') reliability.expectedDataShortages!++;
      if (code === 'storage_write_failed' || code === 'storage_read_failed') reliability.persistenceFailures!++;
      if (control.inputValidation === 'failed') reliability.inputRejections!++;
      if (control.outputValidation === 'failed') reliability.outputValidationFailures!++;
      if (control.businessValidation.pre === 'failed' || control.businessValidation.post === 'failed') reliability.businessValidationFailures!++;
      if (control.preflightStatus === 'blocked' || control.preflightStatus === 'failed') reliability.preflightFailures!++;
      if (control.postflightStatus === 'failed') reliability.postflightFailures!++;
      if (row.status === 'cancelled') reliability.cancellations!++;
      if (row.startedAt !== null && row.stoppedAt === null) reliability.originalResultUnknown!++;
      if (control.recoveryAction === 'recovered' && row.sdkReturned) {
        reliability.confirmedRecoveries!++;
      }
    }
    snapshot.profiles.push({
      name: first.name,
      version: first.version,
      sdkVersion: stored.sdkVersion,
      measurementVersion: stored.version,
      environmentKey: stored.environmentKey,
      workloadBucket: first.control!.workloadBucket!,
      sampleCount: executions.length,
      completeSamples: complete.length,
      percentile: statistics.percentile,
      latencyQuantileMs: complete.length >= statistics.minimumCompleteSamples && (timeoutRate === null || timeoutRate < statistics.timeoutRateFallback)
        ? complete[Math.ceil(complete.length * statistics.percentile) - 1]! : null,
      p95Ms: statistics.percentile === 0.95 && complete.length >= statistics.minimumCompleteSamples
        && (timeoutRate === null || timeoutRate < statistics.timeoutRateFallback) ? complete[Math.ceil(complete.length * statistics.percentile) - 1]! : null,
      timeoutRate,
      reliability,
    });
  }
  return ToolProfileSnapshotSchema.parse(snapshot);
}
