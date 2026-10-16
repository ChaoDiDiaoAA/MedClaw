import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EvaluationController } from '../../apps/desktop/src/main/evaluation-controller';
import { reportFixture, saveReportFixture } from '../../agent-eval/tests/report-fixture';
import type { AppError } from '../../packages/contracts/src/error';

const sourceRoot = resolve(import.meta.dir, '../..'), operationRef = '63faf6f3-1dc9-4768-a23d-52cb734619ef';
test('original evaluation replay after app restart precedes production admission and never prepares another Run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p16-original-')), paths = { sourceRoot, configsRoot: join(root, 'configs'), runsRoot: join(root, 'runs') };
  const report = reportFixture(), executionId = 'desktop-' + operationRef, archive = join(paths.runsRoot, 'business', executionId);
  report.executionId = executionId; report.snapshot.executionId = executionId; report.snapshot.plan = report.plan;
  report.snapshot.desktopRequest = { operationRef, datasetId: 'controlled-fixture', selection: 'smoke', trials: 1 };
  await saveReportFixture(archive, report); const original = await readFile(join(archive, 'report.json'), 'utf8');
  let productionRequests = 0;
  const controller = new EvaluationController({ paths, workerEntry: join(sourceRoot, 'agent-eval/src/desktop/controller.ts'), bunExecutable: process.execPath,
    production: { read: () => ({ instanceId: 'busy-production', state: 'ready', canStart: false, sdkVersion: '0.87.1', schemaVersion: 16, error: null }),
      request: async () => { productionRequests++; throw new Error('Original lookup must precede production admission'); } } });
  try {
    const payload = { datasetId: 'controlled-fixture', selection: 'smoke' as const, trials: 1, preflightId: operationRef };
    expect(await controller.dispatch('eval.start', payload, operationRef)).toEqual({ operationRef, executionId, accepted: true });
    expect(productionRequests).toBe(0);
    expect(await controller.dispatch('eval.status', { operationRef, executionId }, operationRef)).toMatchObject({ state: 'settled', stopConfirmed: true, saveConfirmed: true });
    let conflict: unknown;
    try { await controller.dispatch('eval.start', { ...payload, trials: 2 }, operationRef); } catch (error) { conflict = error; }
    expect(conflict).toMatchObject({ code: 'state_conflict' });
    expect(await readFile(join(archive, 'report.json'), 'utf8')).toBe(original);
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 40000);
test('Main uses the actual Bun evaluator for readonly reports without configuration and confirms its real exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p16-main-actual-')), paths = { sourceRoot, configsRoot: join(root, 'configs'), runsRoot: join(root, 'runs') };
  const errors: AppError[] = [];
  const controller = new EvaluationController({ paths, workerEntry: join(sourceRoot, 'agent-eval/src/desktop/controller.ts'), bunExecutable: process.execPath,
    report: error => errors.push(error),
    production: { read: () => ({ instanceId: null, state: 'stopped', canStart: true, sdkVersion: null, schemaVersion: null, error: null }), request: async () => { throw new Error('Stopped production Host must not be called'); } } });
  try {
    const report = reportFixture(); await saveReportFixture(join(paths.runsRoot, 'business', report.executionId), report);
    await controller.initialize();
    expect(await controller.dispatch('eval.report.list', {}, operationRef)).toMatchObject({ total: 1, items: [{ executionId: 'controlled-fixture', archiveState: 'complete' }] });
    expect(await controller.dispatch('eval.preflight', { datasetId: 'medclaw-agent-v1', selection: 'smoke' }, operationRef)).toMatchObject({ plannedTrials: 10, blockers: [{ code: 'evaluation_config_unavailable' }] });
    expect(await readdir(root)).toEqual(['runs']);
    expect(await controller.shutdown()).toMatchObject({ stopConfirmed: true, saveConfirmed: true, controllerExited: true });
    expect(errors).toEqual([]);
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 40000);

test('a previous desktop execution lock is recovered as unknown and blocks new production without being cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p16-main-recovery-')), paths = { sourceRoot, configsRoot: join(root, 'configs'), runsRoot: join(root, 'runs') };
  const controller = new EvaluationController({ paths, workerEntry: join(sourceRoot, 'agent-eval/src/desktop/controller.ts'), bunExecutable: process.execPath,
    production: { read: () => ({ instanceId: null, state: 'stopped', canStart: true, sdkVersion: null, schemaVersion: null, error: null }), request: async () => { throw new Error('Stopped production Host must not be called'); } } });
  try {
    await mkdir(join(paths.runsRoot, 'business'), { recursive: true });
    await writeFile(join(paths.runsRoot, 'business', '.active-execution.json'), JSON.stringify({ executionId: 'desktop-' + operationRef, pid: 12345, state: 'stop_or_save_unconfirmed' }));
    await expect(controller.dispatch('eval.start', { datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1, preflightId: operationRef }, '943bfb28-d6f1-4b30-92f7-818d51640817')).rejects.toMatchObject({ code: 'runtime_busy' });
    await controller.initialize();
    expect(controller.read()).toMatchObject({ state: 'unknown', operationRef, executionId: 'desktop-' + operationRef, stopConfirmed: null, saveConfirmed: null });
    await expect(controller.withProductionAdmission('host.restart', { expectedInstanceId: 'previous-production' }, 'restart-operation', async () => 'unexpected')).rejects.toMatchObject({ code: 'runtime_busy' });
    expect(await readdir(join(paths.runsRoot, 'business'))).toEqual(['.active-execution.json']);
    expect(await controller.shutdown()).toMatchObject({ stopConfirmed: null, saveConfirmed: null });
  } finally {
    // This test never started a Trial; removing its synthetic lock allows its own worker to close.
    await rm(join(paths.runsRoot, 'business', '.active-execution.json'), { force: true });
    await controller.shutdown(); await rm(root, { recursive: true, force: true });
  }
}, 40000);
