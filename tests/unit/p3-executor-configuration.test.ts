import { expect, test } from 'bun:test';
import { ToolExecutor } from '../../packages/core/src/tools/executor';
import type { ToolExecutionContext } from '../../packages/contracts/src/tool';

const context: ToolExecutionContext = {
  runId: 1, sessionId: 1, nativeToolCallId: 'bytes', referenceDate: '2026-01-01', timezone: 'Asia/Shanghai',
  signal: new AbortController().signal,
  scope: { batchIds: [1], deviceIds: null, allowedToolNames: ['read'], allowedResourceRefs: [], artifactIds: [], readOnly: true },
};
const delivery = (result: unknown, isError = false, maxResultBytes = 1024) =>
  ToolExecutor.afterToolUse('sdk_delivery', result, context, undefined, { isError, maxResultBytes });

test('final delivery counts UTF8 across text blocks at the exact boundary and excludes images/details/usage', () => {
  const result = { content: [{ type: 'text', text: '中'.repeat(341) }, { type: 'text', text: 'x' },
    { type: 'image', data: 'a'.repeat(3000), mimeType: 'image/png' }], details: { huge: 'd'.repeat(3000) }, usage: { huge: 'u'.repeat(3000) } };
  expect(delivery(result)).toEqual({ result, isError: false });
  const overflow = { ...result, content: [...result.content, { type: 'text', text: 'x' }] };
  const checked = delivery(overflow);
  expect(checked.isError).toBe(true);
  expect(JSON.parse(checked.result.content[0]!.text!)).toMatchObject({ error: { code: 'tool_result_too_large' } });
  expect(checked.result.details).toEqual(result.details);
  expect(checked.result.usage).toEqual(result.usage);
  expect(checked.result.content[1]).toEqual(result.content[2]);
});

test('early SDK error remains an error and is safely reduced to one complete error envelope', () => {
  const checked = delivery({ content: [{ type: 'text', text: 'secret'.repeat(1000) }], details: {} }, true);
  expect(checked.isError).toBe(true);
  expect(Buffer.byteLength(checked.result.content[0]!.text!)).toBeLessThanOrEqual(1024);
  expect(() => JSON.parse(checked.result.content[0]!.text!)).not.toThrow();
  expect(checked.result.content[0]!.text).not.toContain('secret');
});

import { performance } from 'node:perf_hooks';
import { RunScopeSchema } from '../../packages/contracts/src/run';
import { PositiveIdSchema } from '../../packages/contracts/src/error';
import { DEFAULT_AGENT_POLICY } from '../../packages/contracts/src/model';
import type { ToolCallIdentity, ToolCallRecord, ToolCallStore, ToolResult } from '../../packages/contracts/src/tool';
import { ToolRegistry } from '../../packages/core/src/tools/registry';
import { ToolRecorder } from '../../packages/core/src/tools/recorder';
import { RunControl } from '../../packages/core/src/runtime/run-control';

function executionFixture(output: unknown, findCommittedQuery?: ConstructorParameters<typeof ToolExecutor>[2]) {
  const rows = new Map<string, ToolCallRecord>();
  const store: ToolCallStore = {
    assertContext() {}, readCall(ctx) { return rows.get(ctx.nativeToolCallId) ?? null; },
    request(tool: ToolCallIdentity, input, ctx) {
      const previous = this.readCall(ctx); if (previous) return previous;
      const row: ToolCallRecord = { id: rows.size + 1, runId: ctx.runId, sessionId: ctx.sessionId, nativeToolCallId: ctx.nativeToolCallId,
        name: tool.name, version: tool.version, executionMode: tool.executionMode, input, status: 'requested', data: null, error: null, sdkReturned: false, nativeEntryId: null };
      rows.set(ctx.nativeToolCallId, row); return row;
    },
    transition(id, from, status, result?: ToolResult<unknown>, observed?: ToolCallRecord['control']) {
      const row = [...rows.values()].find(row => row.id === id)!;
      if (row.status !== from) throw new Error('state_conflict');
      Object.assign(row, { status, data: result?.data ?? null, error: result && result.status !== 'succeeded' ? result.error : null, control: observed }); return row;
    }, recordDelivery() {},
  };
  const ctx = { ...context, scope: { ...context.scope, allowedToolNames: ['query_current_devices'] } };
  const control = new RunControl({ runId: 1, policy: DEFAULT_AGENT_POLICY, scope: ctx.scope, signal: ctx.signal, deadlineAt: performance.now() + 10000, totalTimeoutMs: 10000 });
  let count = 0;
  const registry = new ToolRegistry([{ name: 'query_current_devices', version: '1.0.0', label: 'Query', description: 'Read query.', effect: 'READ', executionMode: 'parallel',
    inputSchema: RunScopeSchema.pick({}).strict(), outputSchema: PositiveIdSchema, async execute() { count++; return output; } }]);
  const recorder = new ToolRecorder(store), executor = new ToolExecutor(registry, recorder, findCommittedQuery);
  return { ctx, control, recorder, executor, rows, store, get count() { return count; } };
}
test('trusted committed Query identity survives output failure and prevents identical recomputation', async () => {
  const c = executionFixture({ invalid: true }, { findCommittedQuery: ctx => ({ id: 9, runId: ctx.runId, sessionId: ctx.sessionId, kind: 'current', callRef: `${ctx.runId}:${ctx.nativeToolCallId}` }) });
  try {
    expect(await c.executor.execute('query_current_devices', {}, c.ctx, c.control)).toMatchObject({ status: 'failed', error: { code: 'tool_output_invalid' } });
    expect(await c.executor.execute('query_current_devices', {}, { ...c.ctx, nativeToolCallId: 'new-query' }, c.control)).toMatchObject({ error: { code: 'operation_result_unknown' } });
    expect(c.count).toBe(1); expect(c.recorder.blocked(c.ctx)).toBeUndefined();
  } finally { c.control.dispose(); }
});
test('untrusted Session/Run/kind/callRef cannot become a committed Query recovery identity', async () => {
  const c = executionFixture({ invalid: true }, { findCommittedQuery: () => ({ id: 9, runId: 2, sessionId: 2, kind: 'changes', callRef: 'unrelated' }) });
  try {
    await c.executor.execute('query_current_devices', {}, c.ctx, c.control);
    await c.executor.execute('query_current_devices', {}, { ...c.ctx, nativeToolCallId: 'new-query' }, c.control);
    expect(c.count).toBe(1); expect(c.recorder.blocked(c.ctx)).toBeUndefined();
  } finally { c.control.dispose(); }
});
test('output serialization failure stays an output failure and does not block persistence', async () => {
  const circular: Record<string, unknown> = {}; circular.self = circular;
  expect(ToolExecutor.afterToolUse('execution_settlement', { status: 'succeeded', data: circular }, context)).toMatchObject({ error: { code: 'tool_output_invalid' } });
});
test('unknown Query commit state prevents blind retry without claiming a storage write failure', async () => {
  const c = executionFixture({ invalid: true }, { findCommittedQuery: () => { throw new Error('storage_read_failed'); } });
  try {
    expect(await c.executor.execute('query_current_devices', {}, c.ctx, c.control)).toMatchObject({ error: { code: 'tool_output_invalid' } });
    expect(await c.executor.execute('query_current_devices', {}, { ...c.ctx, nativeToolCallId: 'new-query' }, c.control)).toMatchObject({ error: { code: 'operation_result_unknown' } });
    expect(c.count).toBe(1); expect(c.recorder.blocked(c.ctx)).toBeUndefined();
  } finally { c.control.dispose(); }
});
test('recorder schema errors do not become storage faults or block the Run', async () => {
  const invalid = PositiveIdSchema.safeParse(0);
  if (invalid.success) throw new Error('Expected invalid output');
  const c = executionFixture(1);
  c.store.transition = () => { throw invalid.error; };
  try {
    expect(await c.executor.execute('query_current_devices', {}, c.ctx, c.control)).toMatchObject({ error: { code: 'invalid_argument' } });
    expect(c.recorder.blocked(c.ctx)).toBeUndefined();
    expect(c.recorder.persistencePending(c.ctx.runId)).toBe(false);
  } finally { c.control.dispose(); }
});
