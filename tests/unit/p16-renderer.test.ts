import { expect, test } from 'bun:test';
import type { Result } from '../../packages/contracts/src/error';
import type { EvaluationControlView, EvaluationNotice } from '../../packages/contracts/src/evaluation';
import type { DesktopNotice } from '../../packages/contracts/src/protocol';

const controllerInstanceId = '3f2d7cc8-0abe-4d66-a53f-738064d20fa6';
const operationRef = '435cbd9c-f42b-4e59-a24c-79e3f9738df3';
const executionId = 'desktop-' + operationRef;
function control(patch: Partial<EvaluationControlView> = {}): EvaluationControlView {
  return { controllerInstanceId, operationKind: 'run', operationRef, executionId, state: 'running', sequence: 1,
    currentTrial: null, progress: null, progressCounts: { planned: 10, saved: 0, pass: 0, fail: 0, unjudgeable: 0, error: 0, notRun: 0 },
    stopConfirmed: null, saveConfirmed: null, controllerExited: false, blockReasons: [], result: null, error: null, ...patch };
}
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
async function renderer() {
  const module = await import('../../apps/desktop/src/renderer/evaluation').catch(() => null);
  expect(module).not.toBeNull();
  if (!module) throw new Error('Evaluation renderer is not implemented');
  return module;
}

test('p16 smaller pages preserve the original first item and stop shrinking at one', async () => {
  const module = await renderer();
  expect('smallerEvaluationPage' in module).toBe(true);
  const smaller = (module as unknown as { smallerEvaluationPage: (page: number, pageSize: number) => { page: number; pageSize: number } | null }).smallerEvaluationPage;
  expect(smaller(2, 25)).toEqual({ page: 3, pageSize: 12 });
  expect(smaller(1, 50)).toEqual({ page: 1, pageSize: 25 });
  expect(smaller(8, 1)).toBeNull();
  let current = { page: 2, pageSize: 25 };
  while (current.pageSize > 1) {
    const first = (current.page - 1) * current.pageSize, next = smaller(current.page, current.pageSize)!;
    expect((next.page - 1) * next.pageSize).toBeLessThanOrEqual(first);
    expect(next.page * next.pageSize).toBeGreaterThan(first); current = next;
  }
});

test('p16 original feedback lookup scans beyond the first page and rejects foreign bindings', async () => {
  const module = await renderer(); expect('findEvaluationFeedback' in module).toBe(true);
  const find = (module as unknown as { findEvaluationFeedback: (bridge: unknown, pending: unknown) => Promise<unknown> }).findEvaluationFeedback;
  const pending = { operationKind: 'review_record', operationRef, executionId, caseId: 'case-one', trialId: 'trial-one' };
  const item = { id: 'original-feedback', source: 'local', sourceId: 'desktop-' + operationRef, reviewer: 'Reviewer', reviewedAt: '2026-01-01T00:00:00.000Z',
    executionId, caseId: pending.caseId, trialId: pending.trialId, status: 'PASS', comment: 'Original', evidenceRefs: [], conflict: false };
  const pages: number[] = [];
  expect(await find({ request: async (_method: unknown, payload: { page: number }) => { pages.push(payload.page); return { ok: true, data: { section: 'feedback', executionId, archiveState: 'complete', page: payload.page, pageSize: 50, total: 51,
    items: payload.page === 1 ? Array.from({ length: 50 }, (_, i) => ({ ...item, sourceId: 'other-' + i })) : [item] } }; } }, pending)).toEqual(item);
  expect(pages).toEqual([1, 2]);
  await expect(find({ request: async () => ({ ok: true, data: { section: 'feedback', executionId: 'foreign', archiveState: 'complete', page: 1, pageSize: 50, total: 1, items: [item] } }) }, pending)).rejects.toBeDefined();
});

test('p16 subscribes before reading current status and keeps a terminal notice over the older first response', async () => {
  const { watchEvaluationControl } = await renderer(), order: string[] = [], delivered: EvaluationControlView[] = [];
  let listener: ((notice: DesktopNotice & { instanceId: string | null }) => void) | undefined;
  let reply!: (value: Result<EvaluationControlView>) => void;
  const response = new Promise<Result<EvaluationControlView>>(resolve => { reply = resolve; });
  const watcher = watchEvaluationControl({
    subscribe: receive => { order.push('subscribe'); listener = receive; return () => { listener = undefined; }; },
    request: async (_method, payload) => { expect(payload).toEqual({}); order.push('status'); return response; },
  }, value => delivered.push(value), () => {});
  const reading = watcher.refresh();
  const settled = control({ sequence: 3, state: 'settled', stopConfirmed: true, saveConfirmed: true });
  listener!({ type: 'eval.status', instanceId: null, controllerInstanceId, executionId, sequence: 3, control: settled });
  reply({ ok: true, data: control() }); await reading;
  expect(order).toEqual(['subscribe', 'status']);
  expect(delivered.at(-1)).toMatchObject({ sequence: 3, state: 'settled', stopConfirmed: true });
  watcher.dispose(); expect(listener).toBeUndefined();
});

test('p16 ignores foreign and older notices and never lets progress replace a terminal control state', async () => {
  const { mergeEvaluationNotice } = await renderer();
  const settled = control({ sequence: 7, state: 'settled', stopConfirmed: true, saveConfirmed: true });
  for (const incoming of [control({ sequence: 6 }), control({ sequence: 8, controllerInstanceId: 'a0c3f4c0-cd55-4c39-9a64-361d5612416f' })]) {
    const notice: EvaluationNotice = { type: 'eval.status', controllerInstanceId: incoming.controllerInstanceId, executionId: incoming.executionId, sequence: incoming.sequence, control: incoming };
    expect(mergeEvaluationNotice(settled, notice)).toBe(settled);
  }
  const progress: EvaluationNotice = { type: 'eval.progress', controllerInstanceId, executionId, sequence: 8,
    progress: { trialId: 'trial-1', caseId: 'case-1', repetition: 1, index: 1, total: 10, kind: 'phase', phase: 'execute', elapsedMs: 1 } };
  expect(mergeEvaluationNotice(settled, progress)).toBe(settled);
  expect(mergeEvaluationNotice(control(), { ...progress, executionId: 'other-execution' })).toMatchObject({ sequence: 1, progress: null });
  expect(mergeEvaluationNotice(control(), progress)).toMatchObject({ sequence: 8, state: 'running', progress: { phase: 'execute' } });
});

test('p16 rejects a status notice whose nested identity disagrees and ignores pending reads after disposal', async () => {
  const { mergeEvaluationNotice, watchEvaluationControl } = await renderer(), original = control();
  expect(mergeEvaluationNotice(original, { type: 'eval.status', controllerInstanceId, executionId, sequence: 4, control: control({ sequence: 3 }) })).toBe(original);
  let reply!: (value: Result<EvaluationControlView>) => void;
  const response = new Promise<Result<EvaluationControlView>>(resolve => { reply = resolve; }), delivered: EvaluationControlView[] = [];
  const watcher = watchEvaluationControl({ subscribe: () => () => {}, request: () => response }, value => delivered.push(value), () => {});
  const reading = watcher.refresh(); watcher.dispose(); reply({ ok: true, data: original }); await reading;
  expect(delivered).toEqual([]);
});

test('p16 preserves stop or save uncertainty and keeps external CLI occupancy outside the desktop chat gate', async () => {
  const { evaluationExecutionBlockReason } = await renderer();
  expect(evaluationExecutionBlockReason(control())).not.toBeNull();
  expect(evaluationExecutionBlockReason(control({ state: 'settled', stopConfirmed: true, saveConfirmed: null }))).not.toBeNull();
  expect(evaluationExecutionBlockReason(control({ state: 'settled', stopConfirmed: true, saveConfirmed: true }))).toBeNull();
  expect(evaluationExecutionBlockReason(control({ state: 'blocked', blockReasons: [{ code: 'external_execution_lock', message: 'An external execution owns this archive.', trialId: null }] }))).toBeNull();
});

test('p16 pending references survive reload without writing private content or replacing an unconfirmed action', async () => {
  const { rememberEvaluationOperation, readEvaluationPending } = await renderer(), saved = storage();
  expect(readEvaluationPending(saved)).toEqual({ schemaVersion: 1, run: null, feedback: null, platform: null });
  expect(saved.values.size).toBe(0);
  const run = { operationKind: 'run' as const, operationRef, datasetId: 'medclaw-agent-v1', selection: 'smoke' as const, trials: 1 };
  rememberEvaluationOperation(saved, run);
  expect(readEvaluationPending(saved).run).toEqual(run);
  expect(() => rememberEvaluationOperation(saved, { ...run, operationRef: '073d3d91-d5eb-4f61-9ee1-25d37bf3f464' })).toThrow();
  expect(() => rememberEvaluationOperation(saved, { ...run, trials: 3 })).toThrow();
  expect(readEvaluationPending(saved).run).toEqual(run);
  expect(() => rememberEvaluationOperation(saved, { ...run, key: 'synthetic-secret-must-not-save' })).toThrow();
  expect([...saved.values.values()].join('')).not.toContain('synthetic-secret-must-not-save');
});

test('p16 confirmation only clears the matching pending reference and preserves other operation kinds', async () => {
  const { rememberEvaluationOperation, clearEvaluationOperation, readEvaluationPending } = await renderer(), saved = storage();
  rememberEvaluationOperation(saved, { operationKind: 'run', operationRef, datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1 });
  const feedback = { operationKind: 'review_record' as const, operationRef: '073d3d91-d5eb-4f61-9ee1-25d37bf3f464', executionId, caseId: 'case-1', trialId: 'trial-1' };
  rememberEvaluationOperation(saved, feedback);
  clearEvaluationOperation(saved, 'run', feedback.operationRef);
  expect(readEvaluationPending(saved).run?.operationRef).toBe(operationRef);
  clearEvaluationOperation(saved, 'run', operationRef);
  expect(readEvaluationPending(saved)).toEqual({ schemaVersion: 1, run: null, feedback, platform: null });
});

test('p16 corrupt or unavailable pending storage cannot be silently treated as an empty confirmed action', async () => {
  const { rememberEvaluationOperation, readEvaluationPending } = await renderer(), saved = storage();
  saved.values.set('medclaw.evaluation.pending.v1', '{broken');
  expect(() => readEvaluationPending(saved)).toThrow();
  const denied = { getItem: () => null, setItem: () => { throw new Error('Storage denied'); }, removeItem: () => { throw new Error('Storage denied'); } };
  expect(() => rememberEvaluationOperation(denied, { operationKind: 'run', operationRef, datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1 })).toThrow();
});

test('p16 a synchronous status transport failure does not prevent the next explicit refresh from recovering', async () => {
  const { watchEvaluationControl } = await renderer(), delivered: EvaluationControlView[] = [], errors: (string | null)[] = [];
  let first = true;
  const watcher = watchEvaluationControl({ subscribe: () => () => {}, request: () => {
    if (first) { first = false; throw new Error('Controlled transport interruption'); }
    return Promise.resolve({ ok: true, data: control({ state: 'settled', stopConfirmed: true, saveConfirmed: true }) });
  } }, value => delivered.push(value), value => errors.push(value));
  await watcher.refresh(); expect(delivered).toEqual([]);
  await watcher.refresh();
  expect(delivered.at(-1)).toMatchObject({ state: 'settled', stopConfirmed: true, saveConfirmed: true });
  expect(errors.at(-1)).toBeNull(); watcher.dispose();
});

test('p16 an inconsistent notice is replaced by a fresh current status and cannot supply its own stop proof', async () => {
  const { watchEvaluationControl } = await renderer(), delivered: EvaluationControlView[] = [];
  let listener: ((notice: DesktopNotice & { instanceId: string | null }) => void) | undefined, first = true;
  const watcher = watchEvaluationControl({ subscribe: receive => { listener = receive; return () => { listener = undefined; }; }, request: () => {
    const result = first ? control() : control({ sequence: 3, state: 'settled', stopConfirmed: true, saveConfirmed: true }); first = false;
    return Promise.resolve({ ok: true, data: result });
  } }, value => delivered.push(value), () => {});
  await watcher.refresh();
  listener!({ type: 'eval.status', instanceId: null, controllerInstanceId, executionId, sequence: 2,
    control: control({ sequence: 1, state: 'settled', stopConfirmed: true, saveConfirmed: true }) });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(delivered.at(-1)).toMatchObject({ sequence: 3, state: 'settled', stopConfirmed: true, saveConfirmed: true });
  watcher.dispose();
});
