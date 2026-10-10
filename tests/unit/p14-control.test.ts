import { expect, test } from 'bun:test';
import { RunControl } from '../../packages/core/src/runtime/run-control';

test('p14 a shared control is accepted only by its original root, frozen Scope, signal and deadline', () => {
  const input = { runId: 1, scope: { batchIds: [2], deviceIds: null, allowedToolNames: ['query_current_devices'],
    allowedResourceRefs: [], artifactIds: [], readOnly: true }, signal: new AbortController().signal, deadlineAt: performance.now() + 15000 };
  const control = new RunControl(input);
  expect(() => control.assertRun(input)).not.toThrow();
  for (const changed of [{ ...input, runId: 2 }, { ...input, scope: { ...input.scope, batchIds: [3] } },
    { ...input, deadlineAt: input.deadlineAt + 1 }, { ...input, signal: new AbortController().signal }]) {
    expect(() => control.assertRun(changed)).toThrow('state_conflict');
  }
  expect(control.readBudget().modelCalls.used).toBe(0);
});
