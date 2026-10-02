import { describe, expect, spyOn, test } from 'bun:test';
import { performance } from 'node:perf_hooks';
import { DEFAULT_AGENT_POLICY, createToolControlObservation, type MeasurementContext } from '../../packages/contracts/src/model';
import type { ToolObservation } from '../../packages/contracts/src/tool';
import { buildToolProfiles } from '../../packages/core/src/tools/tool-profile';

const modulePath = '../../packages/core/src/runtime/run-control';
const scope = { batchIds: [1], deviceIds: null, allowedToolNames: ['read_data_scope', 'read_query'], allowedResourceRefs: [], artifactIds: [], readOnly: true };
const policy = { version: 'medclaw.agent-policy/v1' as const, maxToolCalls: 2, maxModelCalls: 3, singleToolTimeoutMs: 30, maxRecoveryAttempts: 2 };

async function controller(overrides: Partial<typeof policy> = {}) {
  const runtime = await import(modulePath).catch(() => null);
  expect(runtime).not.toBeNull();
  if (!runtime) throw new Error('Run control is missing');
  return new runtime.RunControl({ runId: 1, policy: { ...policy, ...overrides }, scope, signal: new AbortController().signal,
    deadlineAt: performance.now() + 10000, totalTimeoutMs: 10000 });
}

test('Run control counts rejected attempts once and preserves each original admission', async () => {
  const control = await controller();
  control.admitModelCall();
  control.observeToolAttempt('a', 'read_data_scope', {});
  control.observeToolAttempt('b', 'unknown_tool', {});
  control.observeToolAttempt('c', 'read_data_scope', {});
  control.observeToolAttempt('a', 'read_data_scope', {});
  expect(control.readBudget().toolCalls).toEqual({ limit: 2, used: 3, remaining: 0 });
  expect(control.admitToolCall('a', 'read_data_scope', {})).toBeNull();
  expect(control.admitToolCall('c', 'read_data_scope', {})?.code).toBe('tool_call_limit');
  expect(control.admitToolCall('a', 'read_query', {})?.code).toBe('state_conflict');
});

test('last model request disables tools and the next request is refused before admission', async () => {
  const control = await controller({ maxModelCalls: 2 });
  expect(control.admitModelCall().allowTools).toBe(true);
  expect(control.admitModelCall().allowTools).toBe(false);
  expect(() => control.admitModelCall()).toThrow('agent_call_limit');
  expect(control.readBudget().modelCalls).toEqual({ limit: 2, used: 2, remaining: 0 });
  control.observeToolAttempt('late', 'read_data_scope', {});
  expect(control.admitToolCall('late', 'read_data_scope', {})?.code).toBe('tool_call_limit');
});

test('budget and time convergence preserve the final answer reserve without granting an extra model request', async () => {
  const { RunControl } = await import(modulePath);
  const monotonic = spyOn(performance, 'now').mockReturnValue(100000);
  try {
    const control = new RunControl({ runId: 1, policy: { ...policy, maxToolCalls: 4, maxModelCalls: 10, singleToolTimeoutMs: 5000 },
      scope, signal: new AbortController().signal, deadlineAt: 110000, totalTimeoutMs: 10000 });
    control.admitModelCall();
    for (const id of ['a', 'b', 'c']) control.observeToolAttempt(id, 'read_data_scope', {});
    expect(JSON.parse(control.admitModelCall().feedback).converge).toBe(true);
    monotonic.mockReturnValue(107501);
    expect(JSON.parse(control.admitModelCall().feedback).converge).toBe(true);
    monotonic.mockReturnValue(108500);
    control.observeToolAttempt('insufficient', 'read_data_scope', {});
    expect(() => control.beginToolExecution('insufficient', 'read_data_scope', '1.0.0', {})).toThrow('run_timeout');
    expect(control.observation('insufficient').effectiveTimeoutMs).toBeNull();
    monotonic.mockReturnValue(109001);
    expect(control.admitModelCall().allowTools).toBe(false);
    monotonic.mockReturnValue(110001);
    expect(() => control.admitModelCall()).toThrow('run_timeout');
    expect(control.readBudget().modelCalls.used).toBe(4);
    control.dispose();
    const timeOnly = new RunControl({ runId: 2, policy: { ...policy, maxToolCalls: 100, maxModelCalls: 100 }, scope,
      signal: new AbortController().signal, deadlineAt: 120000, totalTimeoutMs: 10000 });
    monotonic.mockReturnValue(117501);
    expect(JSON.parse(timeOnly.admitModelCall().feedback).converge).toBe(true);
  } finally { monotonic.mockRestore(); }
});

test('tool deadline signals cancellation but measures actual late settlement separately', async () => {
  const control = await controller();
  control.admitModelCall();
  control.observeToolAttempt('slow', 'read_data_scope', {});
  const lease = control.beginToolExecution('slow', 'read_data_scope', '1.0.0', {});
  await new Promise(resolve => lease.signal.addEventListener('abort', resolve, { once: true }));
  expect(() => lease.checkActive()).toThrow('tool_timeout');
  expect(control.observation('slow').executionElapsedMs).toBeNull();
  await new Promise(resolve => setTimeout(resolve, 5));
  const observed = control.finishToolExecution('slow', { status: 'failed', error: { code: 'tool_timeout' } });
  expect(observed.latencyObservation).toBe('right_censored');
  expect(observed.observedElapsedMs).toBeGreaterThanOrEqual(30);
  expect(observed.stopLagMs).toBeGreaterThan(0);
  expect(observed.timeoutRequestedAt).not.toBeNull();
});

test('unrelated successes and new failures do not reset the current repair episode', async () => {
  const control = await controller({ maxToolCalls: 20, maxModelCalls: 10, maxRecoveryAttempts: 1 });
  control.admitModelCall();
  control.observeToolAttempt('bad', 'read_query', { queryId: 1 });
  control.noteFailure('bad', { code: 'tool_input_invalid', stage: 'sdk' });
  const episode = control.readBudget().recovery.episodeId;
  expect(control.admitModelCall().allowTools).toBe(true);
  control.observeToolAttempt('unrelated', 'read_data_scope', {});
  control.finishToolExecution('unrelated', { status: 'succeeded', data: {} });
  control.acknowledgeDelivery('unrelated');
  control.observeToolAttempt('another', 'read_query', { queryId: 2 });
  control.noteFailure('another', { code: 'tool_input_invalid', stage: 'sdk' });
  expect(control.readBudget().recovery.episodeId).toBe(episode);
  expect(control.readBudget().recovery.used).toBe(1);
  expect(control.admitModelCall().allowTools).toBe(false);
});

test('after failure keeps the original execution diagnosis while adding its own stage fact', async () => {
  const control = await controller();
  control.observeToolAttempt('bad', 'read_query', { queryId: 1 });
  control.noteFailure('bad', { code: 'tool_output_inconsistent', stage: 'business_post', recordId: 1 });
  control.finishToolExecution('bad', { status: 'failed', error: { code: 'tool_output_inconsistent' } });
  control.updateObservation('bad', { postflightStatus: 'failed', hookFailure: { stage: 'afterToolCall', code: 'tool_postprocess_failed' } });
  control.noteFailure('bad', { code: 'tool_postprocess_failed', stage: 'after_hook', recordId: 1 });
  expect(control.observation('bad')).toMatchObject({ failureClass: 'tool_output_inconsistent', failureStage: 'business_post',
    postflightStatus: 'failed', hookFailure: { stage: 'afterToolCall', code: 'tool_postprocess_failed' } });
  expect(control.feedback()).toContain('tool_postprocess_failed');
});

test('a lease discarded before execution leaves no timeout or execution measurement', async () => {
  const control = await controller();
  control.observeToolAttempt('unstarted', 'read_data_scope', {});
  const lease = control.beginToolExecution('unstarted', 'read_data_scope', '1.0.0', {});
  control.releaseToolExecution('unstarted');
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(lease.signal.aborted).toBe(false);
  expect(control.observation('unstarted')).toMatchObject({ executionElapsedMs: null, timeoutRequestedAt: null, latencyObservation: 'missing' });
});

describe('dynamic frozen Profile timeouts', () => {
  async function profiled(name: string, elapsed: number, options: { complete?: number; timeouts?: number; ceiling?: number; remaining?: number } = {}) {
    const complete = options.complete ?? 20, timeouts = options.timeouts ?? 0;
    const measurement: MeasurementContext = { version: 'medclaw.tool-measurement/v1', sdkVersion: '0.87.1', environmentKey: 'profile-control-fixture',
      cutoffAt: '2026-10-02T00:00:00.000Z', maxToolCallId: complete + timeouts };
    const workloadBucket = name === 'write' ? 'batches=n/a;days=n/a;page=n/a;bytes=0-4KiB' : 'batches=1;days=n/a;page=n/a;bytes=n/a';
    const observations: ToolObservation[] = Array.from({ length: complete + timeouts }, (_, index) => ({
      id: index + 1, name, version: '1.0.0', status: index < complete ? 'succeeded' : 'failed',
      requestedAt: '2026-10-01T00:00:00.000Z', startedAt: '2026-10-01T00:00:00.000Z', stoppedAt: '2026-10-01T00:00:01.000Z',
      measurementContext: measurement, modelKey: 'fixture/model', sdkReturned: true, consumedAt: null,
      control: createToolControlObservation({ environmentKey: measurement.environmentKey, workloadBucket,
        latencyObservation: index < complete ? 'complete' : 'right_censored', executionElapsedMs: index < complete ? elapsed : null,
        observedElapsedMs: index < complete ? elapsed : 1000, timeoutRequestedAt: index < complete ? null : '2026-10-01T00:00:00.900Z' }),
    }));
    const toolProfileSnapshot = buildToolProfiles({ maxToolCallId: measurement.maxToolCallId, observations }, measurement);
    const { RunControl } = await import(modulePath);
    const control = new RunControl({ runId: 1, policy: { ...DEFAULT_AGENT_POLICY, singleToolTimeoutMs: options.ceiling ?? 30000 },
      scope: { ...scope, allowedToolNames: [name], readOnly: name !== 'write' }, signal: new AbortController().signal,
      deadlineAt: performance.now() + (options.remaining ?? 120000), totalTimeoutMs: 10000,
      measurementContext: measurement, toolProfileSnapshot });
    control.observeToolAttempt('profile-call', name, {});
    return { control, toolProfileSnapshot };
  }

  test('twenty complete historical executions supply twice P95 to the actual tool lease', async () => {
    const { control, toolProfileSnapshot } = await profiled('read_data_scope', 800);
    try {
      expect(toolProfileSnapshot.profiles[0]).toMatchObject({ completeSamples: 20, p95Ms: 800 });
      control.beginToolExecution('profile-call', 'read_data_scope', '1.0.0', {});
      expect(control.observation('profile-call').effectiveTimeoutMs).toBe(1600);
    } finally { control.dispose(); }
  });

  test('fast observed reads and query or write tools retain their respective latency floors', async () => {
    for (const [name, expected] of [['read_data_scope', 1000], ['query_current_devices', 5000], ['write', 5000]] as const) {
      const { control } = await profiled(name, 10);
      try {
        control.beginToolExecution('profile-call', name, '1.0.0', {});
        expect(control.observation('profile-call').effectiveTimeoutMs).toBe(expected);
      } finally { control.dispose(); }
    }
  });

  test('insufficient normal samples and twenty percent known timeouts fall back to configured time', async () => {
    for (const sample of [{ complete: 19, timeouts: 0 }, { complete: 20, timeouts: 5 }]) {
      const { control, toolProfileSnapshot } = await profiled('read_data_scope', 800, { ...sample, ceiling: 7000 });
      try {
        expect(toolProfileSnapshot.profiles[0]?.p95Ms).toBeNull();
        control.beginToolExecution('profile-call', 'read_data_scope', '1.0.0', {});
        expect(control.observation('profile-call').effectiveTimeoutMs).toBe(7000);
      } finally { control.dispose(); }
    }
  });

  test('the frozen ceiling and remaining execution time constrain the estimated timeout', async () => {
    const capped = await profiled('read_data_scope', 6000, { ceiling: 4000 });
    try {
      capped.control.beginToolExecution('profile-call', 'read_data_scope', '1.0.0', {});
      expect(capped.control.observation('profile-call').effectiveTimeoutMs).toBe(4000);
    } finally { capped.control.dispose(); }
    const monotonic = spyOn(performance, 'now').mockReturnValue(100000);
    try {
      const remaining = await profiled('read_data_scope', 800, { remaining: 2500 });
      try {
        remaining.control.beginToolExecution('profile-call', 'read_data_scope', '1.0.0', {});
        expect(remaining.control.observation('profile-call').effectiveTimeoutMs).toBe(1500);
      } finally { remaining.control.dispose(); }
    } finally { monotonic.mockRestore(); }
  });
});
