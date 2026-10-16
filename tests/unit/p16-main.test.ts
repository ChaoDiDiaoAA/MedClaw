import { expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EvaluationController } from '../../apps/desktop/src/main/evaluation-controller';
import { safeError, type Result } from '../../packages/contracts/src/error';
import type { HostView } from '../../packages/contracts/src/model';
import type { EvaluationNotice } from '../../packages/contracts/src/evaluation';

const sourceRoot = resolve(import.meta.dir, '../..'), operationRef = '63faf6f3-1dc9-4768-a23d-52cb734619ef';
const preflightId = '943bfb28-d6f1-4b30-92f7-818d51640817';
const run = { datasetId: 'medclaw-agent-v1', selection: 'smoke' as const, trials: 1, preflightId };
async function setup(mode = 'normal', notify?: (notice: EvaluationNotice) => void) {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p16-main-'));
  const control = { instanceId: 'production-instance', activeRootRun: null, acceptingNewRuns: true, blockReasons: [] as ReturnType<typeof safeError>[], budget: null };
  const hostView: HostView = { instanceId: control.instanceId, state: 'ready', canStart: false, sdkVersion: '0.87.1', schemaVersion: 16, error: null };
  let checkpoint: unknown = null;
  const production = { read: () => hostView, request: async (method: string): Promise<Result<unknown>> => {
    if (method === 'run.control.read') return { ok: true, data: control };
    if (method === 'run.read') return { ok: true, data: { kind: 'one', run: null } };
    if (method === 'session.readSubmission') return { ok: true, data: null };
    if (method === 'evidence.readOperation') return { ok: true, data: checkpoint };
    throw new Error('Unexpected production request: ' + method);
  } };
  const controller = new EvaluationController({ paths: { sourceRoot, configsRoot: join(root, mode), runsRoot: root },
    workerEntry: join(sourceRoot, 'tests/fixtures/p16-main-worker.ts'), bunExecutable: process.execPath, production, notify });
  const requests = async () => (await readFile(join(root, 'worker-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; operationRef: string });
  return { root, controller, control, hostView, requests, setCheckpoint: (value: unknown) => { checkpoint = value; } };
}

test('production and evaluation reserve before awaiting; readonly requests remain available during evaluation', async () => {
  const { root, controller, requests } = await setup();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    await controller.initialize();
    const production = controller.withProductionAdmission('host.restart', { expectedInstanceId: 'production-instance' }, 'restart-operation', async () => { await pending; return 'restarted'; });
    let busy: unknown;
    try { await controller.dispatch('eval.start', run, operationRef); } catch (error) { busy = error; }
    expect(busy).toMatchObject({ code: 'runtime_busy' });
    release(); expect(await production).toBe('restarted');
    const first = await controller.dispatch('eval.start', run, operationRef);
    expect(await controller.dispatch('eval.start', { ...run, preflightId: operationRef }, operationRef)).toEqual(first);
    await expect(controller.dispatch('eval.start', { ...run, trials: 2 }, operationRef)).rejects.toMatchObject({ code: 'state_conflict' });
    expect(await controller.dispatch('eval.cancel', { executionId: 'unrelated-execution' }, preflightId)).toMatchObject({ cancelRequested: false, control: { executionId: 'unrelated-execution' } });
    expect(controller.read()).toMatchObject({ state: 'running', executionId: first.executionId });
    expect(await controller.withProductionAdmission('host.start', {}, 'browse-start', async () => 'ready-for-browsing')).toBe('ready-for-browsing');
    let executed = 0;
    await expect(controller.withProductionAdmission('host.restart', { expectedInstanceId: 'production-instance' }, 'new-restart', async () => { executed++; }))
      .rejects.toMatchObject({ code: 'runtime_busy' });
    expect(executed).toBe(0);
    expect(await controller.dispatch('eval.report.list', {}, preflightId)).toMatchObject({ total: 0 });
    await controller.dispatch('eval.cancel', { executionId: first.executionId }, preflightId);
    expect(await controller.withProductionAdmission('host.restart', { expectedInstanceId: 'production-instance' }, 'safe-restart', async () => 'allowed')).toBe('allowed');
    expect((await requests()).filter(request => request.method === 'eval.start')).toHaveLength(1);
  } finally { release(); await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 40000);

test('runtime refusal blocks evaluation even when activeRootRun is null', async () => {
  const { root, controller, control, requests } = await setup();
  try {
    await controller.initialize();
    control.acceptingNewRuns = false; control.blockReasons = [safeError('storage_write_failed')];
    let busy: unknown;
    try { await controller.dispatch('eval.start', run, operationRef); } catch (error) { busy = error; }
    expect(busy).toMatchObject({ code: 'runtime_busy' });
    expect((await requests()).filter(request => request.method === 'eval.start')).toHaveLength(0);
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 40000);

for (const first of ['production', 'evaluation'] as const) test('concurrent session.submit and eval.start admit only ' + first + ' when it reserves first', async () => {
  const { root, controller, requests } = await setup();
  let release!: () => void, entered!: () => void, productionCalls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), executing = new Promise<void>(resolve => { entered = resolve; });
  const payload = { sessionId: 1, clientSequence: 1, mode: 'send' as const, text: 'ENGINEERING admission', expectedRevision: 0, expectedBatchIds: [], expectedQueryId: null,
    model: { provider: 'fixture', modelId: 'fixture', expectedConfigVersion: '0' }, referenceDate: '2026-01-01', timezone: 'UTC' };
  const submit = () => controller.withProductionAdmission('session.submit', payload, 'original-chat-submit', async () => { productionCalls++; entered(); await gate; return 'accepted'; });
  try {
    await controller.initialize();
    if (first === 'production') {
      const production = submit(), evaluation = controller.dispatch('eval.start', run, operationRef);
      let refusal: unknown; try { await evaluation; } catch (error) { refusal = error; }
      expect(refusal).toMatchObject({ code: 'runtime_busy' }); await executing; release(); expect(await production).toBe('accepted');
      expect((await requests()).filter(item => item.method === 'eval.start')).toHaveLength(0);
    } else {
      const evaluation = controller.dispatch('eval.start', run, operationRef), production = submit();
      let refusal: unknown; try { await production; } catch (error) { refusal = error; }
      expect(refusal).toMatchObject({ code: 'runtime_busy' }); expect(await evaluation).toMatchObject({ accepted: true });
      expect((await requests()).filter(item => item.method === 'eval.start')).toHaveLength(1);
      await controller.dispatch('eval.cancel', { executionId: 'desktop-' + operationRef }, preflightId);
    }
    expect(productionCalls).toBe(first === 'production' ? 1 : 0);
  } finally { release(); await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 40000);

test('late Run notices for the same execution cannot release or replace an active platform operation', async () => {
  const { root, controller } = await setup('late-run-status');
  try {
    const runReceipt = await controller.dispatch('eval.start', run, operationRef);
    await controller.dispatch('eval.cancel', { executionId: runReceipt.executionId }, preflightId);
    await controller.dispatch('eval.resend', { executionId: runReceipt.executionId }, preflightId);
    await controller.dispatch('eval.report.list', {}, operationRef);
    expect(controller.read()).toMatchObject({ operationKind: 'resend', operationRef: preflightId, executionId: runReceipt.executionId,
      state: 'running', stopConfirmed: null, saveConfirmed: null, progress: null });
    let failure: unknown;
    try { await controller.withProductionAdmission('host.restart', { expectedInstanceId: 'production-instance' }, 'late-notice-restart', async () => 'unexpected'); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'runtime_busy' });
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 40000);

test('platform receipt kind must match the requested method even when its operation and execution IDs are valid', async () => {
  const { root, controller } = await setup('wrong-platform-kind');
  try {
    let failure: unknown;
    try { await controller.dispatch('eval.resend', { executionId: 'previous-report' }, operationRef); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'host_protocol_mismatch' });
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 40000);

test('a status reply captured before a terminal notice cannot roll back the confirmed lifecycle', async () => {
  const { root, controller } = await setup('late-status-reply');
  try {
    const receipt = await controller.dispatch('eval.start', run, operationRef);
    expect(await controller.dispatch('eval.status', { executionId: receipt.executionId, operationRef }, preflightId))
      .toMatchObject({ state: 'settled', stopConfirmed: true, saveConfirmed: true });
    expect(controller.read()).toMatchObject({ state: 'settled', stopConfirmed: true, saveConfirmed: true });
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 40000);

test('original checkpoint receipt is checked before the new-execution gate', async () => {
  const { root, controller, setCheckpoint } = await setup();
  try {
    await controller.initialize();
    const first = await controller.dispatch('eval.start', run, operationRef);
    setCheckpoint({ operationRef: 'original-checkpoint', sessionId: 1, targetLeafId: 'leaf', storageVersion: 2, workspaceRevision: 2, committedAt: '2026-01-01T00:00:00.000Z' });
    let prior = false;
    expect(await controller.withProductionAdmission('session.restoreCheckpoint', { sessionId: 1, targetLeafId: 'leaf', expectedStorageVersion: 1, expectedWorkspaceRevision: 1 }, 'original-checkpoint', async original => { prior = original; return 'original-result'; })).toBe('original-result');
    expect(prior).toBe(true);
    await controller.dispatch('eval.cancel', { executionId: first.executionId }, preflightId);
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 40000);

test('worker exit during execution preserves unknown Trial stop and does not rebuild the process', async () => {
  let exited!: () => void;
  const exit = new Promise<void>(resolve => { exited = resolve; });
  const { root, controller, requests } = await setup('exit-running', notice => { if (notice.type === 'eval.status' && notice.control.controllerExited) exited(); });
  try {
    await controller.initialize();
    await controller.dispatch('eval.start', run, operationRef);
    await writeFile(join(root, 'allow-exit'), 'controlled worker crash'); await exit;
    expect(controller.read()).toMatchObject({ state: 'unknown', controllerExited: true, stopConfirmed: null, saveConfirmed: null, executionId: 'desktop-' + operationRef });
    expect(await controller.dispatch('eval.status', { executionId: 'unknown-execution' }, preflightId)).toMatchObject({ state: 'unknown', executionId: 'unknown-execution', operationRef: null, stopConfirmed: null, saveConfirmed: null, controllerExited: true });
    await expect(controller.withProductionAdmission('host.restart', { expectedInstanceId: 'production-instance' }, 'unsafe-restart', async () => 'unexpected')).rejects.toMatchObject({ code: 'runtime_busy' });
    await expect(controller.dispatch('eval.preflight', { datasetId: run.datasetId, selection: run.selection }, preflightId)).rejects.toMatchObject({ code: 'host_interrupted' });
    expect((await requests()).filter(request => request.method === 'eval.start')).toHaveLength(1);
    expect(await controller.shutdown()).toMatchObject({ controllerExited: true, stopConfirmed: null, saveConfirmed: null });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 40000);

test.each(['wrong-controller', 'wrong-operation', 'wrong-method'])('Main rejects %s frames without accepting foreign results', async mode => {
  const { root, controller } = await setup(mode);
  try {
    let failure: unknown;
    try {
      await controller.initialize();
      if (mode !== 'wrong-controller') await controller.dispatch('eval.preflight', { datasetId: run.datasetId, selection: run.selection }, preflightId);
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'host_protocol_mismatch' });
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 40000);

test('Main canonicalizes a private error code instead of forwarding its provider body', async () => {
  const { root, controller } = await setup('unsafe-error');
  try {
    await controller.initialize();
    let failure: unknown;
    try { await controller.dispatch('eval.preflight', { datasetId: run.datasetId, selection: run.selection }, preflightId); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'invalid_argument' });
    expect(JSON.stringify(failure).includes('synthetic-private-provider-body')).toBe(false);
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 40000);

test.each(['wrong-start-result', 'wrong-status-result', 'wrong-cancel-result'])('Main rejects valid-shaped %s with foreign result identity', async mode => {
  const { root, controller } = await setup(mode);
  try {
    await controller.initialize();
    let failure: unknown;
    try {
      if (mode === 'wrong-status-result') await controller.dispatch('eval.status', { executionId: 'requested-execution' }, preflightId);
      else if (mode === 'wrong-start-result') await controller.dispatch('eval.start', run, operationRef);
      else {
        const first = await controller.dispatch('eval.start', run, operationRef);
        await controller.dispatch('eval.cancel', { executionId: first.executionId }, preflightId);
      }
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'host_protocol_mismatch' });
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 40000);

test('shutdown acknowledgement cannot confirm process exit; the same close can finish after actual exit', async () => {
  const { root, controller } = await setup('ack-without-exit');
  try {
    await controller.initialize();
    expect(await controller.shutdown()).toMatchObject({ stopConfirmed: true, saveConfirmed: true, controllerExited: false });
    await writeFile(join(root, 'allow-exit'), 'controlled test process may now exit');
    expect(await controller.shutdown()).toMatchObject({ stopConfirmed: true, saveConfirmed: true, controllerExited: true, gaps: [] });
  } finally { await writeFile(join(root, 'allow-exit'), 'cleanup'); await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 70000);

test('quit during unconfirmed saving keeps the controller alive and blocks fresh execution until save proof arrives', async () => {
  const { root, controller } = await setup('save-unknown');
  try {
    await controller.initialize(); await controller.dispatch('eval.start', run, operationRef);
    expect(await controller.shutdown()).toMatchObject({ stopConfirmed: true, saveConfirmed: false, controllerExited: false });
    expect(controller.read()).toMatchObject({ state: 'unknown', stopConfirmed: true, saveConfirmed: false, controllerExited: false });
    let blocked: unknown;
    try { await controller.withProductionAdmission('host.restart', { expectedInstanceId: 'production-instance' }, 'save-unsafe-restart', async () => 'unexpected'); } catch (error) { blocked = error; }
    expect(blocked).toMatchObject({ code: 'runtime_busy' });
    expect(await controller.dispatch('eval.report.list', {}, preflightId)).toMatchObject({ total: 0 });
    await writeFile(join(root, 'allow-save'), 'controlled save is now confirmed');
    expect(await controller.shutdown()).toMatchObject({ stopConfirmed: true, saveConfirmed: true, controllerExited: true, gaps: [] });
  } finally { await writeFile(join(root, 'allow-save'), 'cleanup'); await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 40000);
