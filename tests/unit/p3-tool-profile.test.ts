import { expect, test } from 'bun:test';
import type { MeasurementContext } from '../../packages/contracts/src/model';
import { createToolControlObservation } from '../../packages/contracts/src/model';
import type { ToolObservation } from '../../packages/contracts/src/tool';
import { buildToolProfiles, groupWorkload } from '../../packages/core/src/tools/tool-profile';

const measurement: MeasurementContext = {
  version: 'medclaw.tool-measurement/v1',
  sdkVersion: '0.87.1',
  environmentKey: 'test-environment',
  cutoffAt: '2026-10-02T00:00:00.000Z',
  maxToolCallId: 100,
};
function observation(id: number, elapsed = id): ToolObservation {
  return {
    id,
    name: 'read_batch',
    version: '1.0.0',
    status: 'succeeded',
    requestedAt: '2026-10-01T00:00:00.000Z',
    startedAt: '2026-10-01T00:00:00.000Z',
    stoppedAt: '2026-10-01T00:00:00.001Z',
    measurementContext: measurement,
    modelKey: 'test/model/0.87.1',
    sdkReturned: true,
    consumedAt: null,
    control: createToolControlObservation({
      environmentKey: measurement.environmentKey,
      workloadBucket: groupWorkload({ batchIds: [1] }),
      executionElapsedMs: elapsed,
      observedElapsedMs: elapsed,
      latencyObservation: 'complete',
    }),
  };
}

test('P3 profiles use the recent fifty executions and need twenty normal complete samples', () => {
  const observations = Array.from({ length: 60 }, (_, index) => observation(index + 1));
  const snapshot = buildToolProfiles({ maxToolCallId: 100, observations }, measurement);
  expect(snapshot.profiles).toHaveLength(1);
  expect(snapshot.profiles[0]).toMatchObject({ sampleCount: 50, completeSamples: 50, p95Ms: 58, timeoutRate: 0 });
  expect(buildToolProfiles({ maxToolCallId: 100, observations: observations.slice(0, 19) }, measurement).profiles[0]?.p95Ms).toBeNull();
});

test('P3 timeout ratio excludes unknown in-flight executions and censored values never enter P95', () => {
  const observations = Array.from({ length: 20 }, (_, index) => observation(index + 1, 10));
  for (let index = 0; index < 5; index++) observations.push({
    ...observation(index + 21, 200),
    status: 'failed',
    control: createToolControlObservation({
      environmentKey: measurement.environmentKey,
      workloadBucket: groupWorkload({ batchIds: [1] }),
      timeoutRequestedAt: '2026-10-01T00:00:00.000Z',
      observedElapsedMs: 200,
      latencyObservation: 'right_censored',
    }),
  });
  observations.push({ ...observation(26), status: 'running', stoppedAt: null });
  const profile = buildToolProfiles({ maxToolCallId: 100, observations }, measurement).profiles[0]!;
  expect(profile.timeoutRate).toBe(0.2);
  expect(profile.p95Ms).toBeNull();
  expect(profile.reliability.timeouts).toBe(5);
});

test('P3 profiles separate environment, SDK, version and input buckets and skip missing historical measurement', () => {
  const normal = observation(1);
  const other = { ...observation(2), version: '2.0.0' };
  const missing = { ...observation(3), measurementContext: null, control: null };
  const environment = {
    ...observation(4),
    measurementContext: { ...measurement, environmentKey: 'other' },
    control: { ...observation(4).control!, environmentKey: 'other' },
  };
  const snapshot = buildToolProfiles({ maxToolCallId: 100, observations: [normal, other, missing, environment] }, measurement);
  expect(snapshot.profiles).toHaveLength(3);
  expect(snapshot.profiles.every(profile => profile.p95Ms === null)).toBe(true);
  expect(groupWorkload({ batchIds: [1], time: { start: '2026-01-01', endExclusive: '2026-02-02' }, pageSize: 500 })).toContain('days=32+');
  expect(groupWorkload({ data: 'x'.repeat(5000) }, undefined, true)).toContain('bytes=4-64KiB');
});

test('P3 reliability separates expected refusals, cancellation and persistence from actual execution failure', () => {
  const observations = ['access_denied', 'invalid_argument', 'data_coverage_missing', 'storage_write_failed', 'internal_error'].map((code, index) => ({
    ...observation(index + 1),
    status: 'failed' as const,
    control: createToolControlObservation({
      environmentKey: measurement.environmentKey,
      workloadBucket: groupWorkload({ batchIds: [1] }),
      failureStage: 'execution',
      failureClass: code,
    }),
  }));
  const profile = buildToolProfiles({ maxToolCallId: 100, observations }, measurement).profiles[0]!;
  expect(profile.reliability.executionFailures).toBe(1);
  expect(profile.reliability.permissionRejections).toBe(1);
  expect(profile.reliability.expectedDataShortages).toBe(1);
  expect(profile.reliability.persistenceFailures).toBe(1);
  expect(buildToolProfiles(null, measurement)).toMatchObject({ available: false, profiles: [] });
});
