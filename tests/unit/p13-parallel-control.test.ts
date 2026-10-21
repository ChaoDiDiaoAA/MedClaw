import { expect, test } from 'bun:test';
import { RunControl } from '../../packages/core/src/runtime/run-control';

const scope = { batchIds: [1], deviceIds: null, allowedToolNames: ['read'], allowedResourceRefs: [], artifactIds: [], readOnly: true };
function control() { return new RunControl({ runId: 1, scope, signal: new AbortController().signal, deadlineAt: performance.now() + 60_000 }); }

test('P13 sibling budget consumption requires a fresh preparation without consuming a second request', () => {
  const root = control(); root.admitModelCall();
  const left = root.createChild(2, scope, new AbortController().signal), right = root.createChild(3, scope, new AbortController().signal);
  const first = left.previewModelCall(), stale = right.previewModelCall();
  left.admitModelCall(first);
  expect(right.isModelCallPreviewCurrent(stale)).toBe(false);
  expect(root.readBudget().modelCalls.used).toBe(2);
  const preparedAgain = right.previewModelCall();
  expect(right.isModelCallPreviewCurrent(preparedAgain)).toBe(true);
  right.admitModelCall(preparedAgain);
  expect(root.readBudget().modelCalls.used).toBe(3);
  expect(right.isModelCallPreviewCurrent(preparedAgain)).toBe(false);
});

test('P13 cancelling one child closes its own admission while its sibling and parent can continue', () => {
  const root = control(), cancel = new AbortController(); root.admitModelCall();
  const child = root.createChild(2, scope, cancel.signal), sibling = root.createChild(3, scope, new AbortController().signal);
  cancel.abort();
  expect(() => child.admitModelCall()).toThrow('tool_cancelled');
  sibling.admitModelCall(); root.admitModelCall();
  expect(root.readBudget().modelCalls.used).toBe(3);
});
