import { expect, test, spyOn } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAX_FRAME_BYTES } from '../../packages/contracts/src/protocol';
import type { EvaluationNotice, EvaluationControlView } from '../../packages/contracts/src/evaluation';
import { EvaluationService } from '../../agent-eval/src/desktop/service';
import { runExperiment } from '../../agent-eval/src/execution/runner';
import type { ProgressEvent } from '../../agent-eval/src/execution/progress';
import { sourceInventory } from '../../agent-eval/src/doctor';
import { createDatasetFixture } from '../../agent-eval/tests/datasets/fixture';
import { reportFixture, runConfigFixture, saveReportFixture } from '../../agent-eval/tests/report-fixture';

const controllerId = '943bfb28-d6f1-4b30-92f7-818d51640817';
const operationRef = '63faf6f3-1dc9-4768-a23d-52cb734619ef';
const sourceRoot = resolve(import.meta.dir, '../..');
async function configuredService() {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p16-controller-'));
  const paths = { sourceRoot, configsRoot: join(root, 'configs'), runsRoot: join(root, 'runs') };
  await mkdir(paths.configsRoot, { recursive: true });
  await writeFile(join(paths.configsRoot, 'agent.json'), JSON.stringify(runConfigFixture()));
  await writeFile(join(paths.configsRoot, 'environment'), 'MEDCLAW_JUDGE_BASE_URL=https://judge.example.invalid/v1\nMEDCLAW_JUDGE_MODEL=openai/gpt-4o-mini\nMEDCLAW_JUDGE_API_KEY=controlled-judge-key\n');
  const service = new EvaluationService(paths); await service.initializeRuntime();
  return { root, paths, service };
}

test('evaluation frames bound unfinished bytes, preserve split UTF-8 and reject old controller identity', async () => {
  const transportPath = Bun.resolveSync('@medclaw/contracts/evaluation-transport', join(sourceRoot, 'apps/desktop/src/main'));
  const { EvaluationFrameDecoder, encodeEvaluationFrame, parseEvaluationFrame }: typeof import('../../packages/contracts/src/evaluation-transport') = await import(transportPath);
  const hello = { protocolVersion: 'medclaw.evaluation-control/v1', kind: 'hello', controllerInstanceId: controllerId,
    paths: { sourceRoot: 'D:/code/医院', configsRoot: 'D:/configs', runsRoot: 'D:/runs' } } as const;
  const bytes = new TextEncoder().encode(encodeEvaluationFrame(hello)), split = bytes.indexOf(0xe5) + 1;
  const decoder = new EvaluationFrameDecoder(controllerId);
  expect(decoder.push(bytes.slice(0, split))).toEqual([]);
  expect(decoder.push(bytes.slice(split))).toEqual([hello]); decoder.finish();
  expect(() => new EvaluationFrameDecoder(controllerId).push(new Uint8Array(MAX_FRAME_BYTES + 1).fill(120))).toThrow('frame_too_large');
  expect(() => parseEvaluationFrame(JSON.stringify(hello), operationRef)).toThrow('host_protocol_mismatch');
  expect(() => encodeEvaluationFrame({ protocolVersion: hello.protocolVersion, controllerInstanceId: controllerId, kind: 'request', requestId: 'large',
    request: { method: 'eval.review.record', operationRef, payload: { executionId: 'e', caseId: 'c', trialId: 't', reviewer: 'Reviewer', status: 'PASS', comment: 'Review', evidenceRefs: Array(20000).fill('r'.repeat(256)) } } })).toThrow('frame_too_large');
});

test('progress keeps plan identity separate from execution state and private observation', async () => {
  const { trialProgress } = await import('../../agent-eval/src/execution/progress');
  const events: ProgressEvent[] = [];
  const trial = { ...reportFixture().plan[0]!, status: 'not_run', observation: { private: 'private-observation' } };
  const progress = trialProgress(trial, 1, 1, event => events.push(event));
  try {
    progress.phase('score');
    progress.emit({ kind: 'score', status: 'NOT_RUN', executionStatus: 'not_run' });
    expect(events[0]!.status).toBeUndefined();
    expect(events[1]).toMatchObject({ status: 'NOT_RUN', executionStatus: 'not_run' });
    expect(JSON.stringify(events)).not.toContain('private-observation');
  } finally { progress.close(); }
});

test('phase heartbeat reports a minute of waiting and closes its timer when the phase changes', async () => {
  const { trialProgress } = await import('../../agent-eval/src/execution/progress');
  const events: ProgressEvent[] = [], clock = spyOn(Date, 'now').mockReturnValue(1000), timers = spyOn(globalThis, 'setInterval'), clear = spyOn(globalThis, 'clearInterval');
  const progress = trialProgress({ trialId: 'case-r1', caseId: 'case', repetition: 1 }, 1, 2, event => events.push(event));
  try {
    progress.phase('execute');
    const [heartbeat, delay] = timers.mock.calls.at(-1)!;
    expect(delay).toBe(60000);
    clock.mockReturnValue(61000);
    if (typeof heartbeat !== 'function') throw new Error('Heartbeat callback missing');
    heartbeat();
    expect(events.at(-1)).toMatchObject({ kind: 'heartbeat', phase: 'execute', elapsedMs: 60000, phaseElapsedMs: 60000, index: 1, total: 2 });
    progress.phase('score');
    expect(clear).toHaveBeenCalledTimes(1);
    progress.close();
    expect(clear).toHaveBeenCalledTimes(2);
  } finally { progress.close(); clock.mockRestore(); timers.mockRestore(); clear.mockRestore(); }
});

test.each(['sdk', 'patch', 'packageJson', 'files'] as const)('Runner rejects changed %s before snapshot or Trial and preserves CLI defaults', async key => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p16-source-')), datasetRoot = join(root, 'dataset'), runsRoot = join(root, 'runs');
  try {
    await createDatasetFixture(datasetRoot);
    const source = await sourceInventory(), expectedSource = { ...source, [key]: 'changed' };
    const options = { datasetRoot, runsRoot, executionId: 'source-guard', selection: 'smoke' as const, trials: 1, config: reportFixture().config, judgeMode: 'off' as const, expectedSource };
    let failure = '';
    try { await runExperiment(options); } catch (error) { failure = error instanceof Error ? error.message : 'unknown'; }
    expect(failure).toBe('evaluation_runtime_changed');
    expect(await Bun.file(join(runsRoot, options.executionId, 'snapshot.json')).exists()).toBe(false);
    expect(await readdir(join(runsRoot, options.executionId))).toEqual([]);
    const legacy = await runExperiment({ ...options, executionId: 'legacy', expectedSource: undefined });
    expect(legacy.plan).toHaveLength(1); expect(legacy.snapshot.desktopRequest).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

test('lost start reply and repeated cancellation preserve one original execution and its full plan', async () => {
  const { EvaluationWorker } = await import('../../agent-eval/src/desktop/controller');
  const { root, paths, service } = await configuredService(), notices: EvaluationNotice[] = [];
  const runner = await import('../../agent-eval/src/execution/runner');
  const originalRun = runner.runExperiment;
  let worker!: InstanceType<typeof EvaluationWorker>;
  const savedViews: Promise<EvaluationControlView>[] = [], phaseViews: Promise<EvaluationControlView>[] = [];
  let runnerFailure: string | null = null;
  const calls = spyOn(runner, 'runExperiment').mockImplementation(options => {
    options.onEvent?.({ trialId: 'mc-v1-task-current-price-r1', caseId: 'mc-v1-task-current-price', repetition: 1, index: 1, total: 10,
      kind: 'execution', phase: 'execute', elapsedMs: 0, executionStatus: 'infra_error', reason: 'Transport failure: ' + options.modelCredential!.key });
    return originalRun({ ...options,
      onProgress: trial => { options.onProgress?.({ ...trial, reason: 'Transport failure: ' + options.modelCredential!.key + ' controlled-judge-key' }); savedViews.push(worker.request('eval.status', { operationRef }, controllerId)); },
      onEvent: event => { options.onEvent?.(event); if (event.kind === 'phase') phaseViews.push(worker.request('eval.status', { operationRef }, controllerId)); } })
      .catch(error => { runnerFailure = error instanceof Error ? error.message : 'unknown'; throw error; });
  });
  const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real model calls are disabled in engineering tests'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), prepare = service.prepareRun.bind(service);
  const held = spyOn(service, 'prepareRun').mockImplementation(async input => { await gate; return prepare(input); });
  try {
    worker = new EvaluationWorker(service, controllerId, notice => notices.push(notice));
    const check = await service.preflight({ datasetId: 'medclaw-agent-v1', selection: 'smoke' });
    const payload = { datasetId: check.datasetId, selection: check.selection, trials: check.trials, preflightId: check.preflightId };
    const first = await worker.request('eval.start', payload, operationRef);
    expect(first).toMatchObject({ accepted: true, executionId: 'desktop-' + operationRef });
    expect(await worker.request('eval.start', payload, operationRef)).toEqual(first);
    await expect(worker.request('eval.start', { ...payload, trials: 2 }, operationRef)).rejects.toThrow('state_conflict');
    expect(await worker.request('eval.cancel', { executionId: first.executionId }, controllerId)).toMatchObject({ cancelRequested: true });
    expect(await worker.request('eval.cancel', { executionId: first.executionId }, controllerId)).toMatchObject({ cancelRequested: true });
    release();
    const shutdown = await worker.shutdown();
    expect(runnerFailure).toBeNull(); expect(calls).toHaveBeenCalledTimes(1);
    const { readReport } = await import('../../agent-eval/src/reports/write');
    expect((await readReport(join(paths.runsRoot, 'business', first.executionId))).plan).toHaveLength(10);
    expect(shutdown).toMatchObject({ stopConfirmed: true, saveConfirmed: true, controllerExited: false });
    const view = await worker.request('eval.status', { operationRef }, controllerId);
    expect(view).toMatchObject({ state: 'settled', stopConfirmed: true, saveConfirmed: true, progressCounts: { planned: 10, saved: 10, notRun: 10 } });
    expect(view).toMatchObject({ progress: { kind: 'case_summary', index: 10, total: 10 } });
    const savedStates = await Promise.all(savedViews), phases = await Promise.all(phaseViews);
    expect(savedStates).toHaveLength(10);
    expect(phases.length).toBeGreaterThan(10);
    for (const state of savedStates) {
      expect(state).toMatchObject({ progress: { kind: 'saved' } });
      expect(state.progress?.trialId).toBe(state.currentTrial?.trialId);
    }
    expect(phases.every(state => state.currentTrial === null)).toBe(true);
    const snapshot = await Bun.file(join(paths.runsRoot, 'business', first.executionId, 'snapshot.json')).json();
    expect(snapshot.desktopRequest).toEqual({ operationRef, datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1 });
    expect(snapshot.expectedSource).toBeUndefined();
    expect((await readdir(join(paths.runsRoot, 'business'))).filter(name => name.startsWith('desktop-'))).toEqual([first.executionId]);
    expect(notices.filter(notice => notice.type === 'eval.progress' && notice.progress.kind === 'saved')).toHaveLength(10);
    let saved = 0;
    for (const notice of notices) if (notice.type === 'eval.progress') {
      if (notice.progress.kind === 'execution') expect(notice.progress.index).toBe(saved + 1);
      if (notice.progress.kind === 'saved') saved = notice.progress.index;
    }
    expect(notices.every((notice, index) => index === 0 || notice.sequence > notices[index - 1]!.sequence)).toBe(true);
    expect(JSON.stringify(notices).includes('private-agent-config-key')).toBe(false);
    expect(JSON.stringify(notices).includes('controlled-judge-key')).toBe(false);
    expect(JSON.stringify(view).includes('private-agent-config-key')).toBe(false);
    expect(JSON.stringify(view).includes('controlled-judge-key')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await unlink(join(paths.configsRoot, 'agent.json'));
    const conflicting = new EvaluationWorker(new EvaluationService(paths), operationRef, () => {});
    let conflict: unknown;
    try { await conflicting.request('eval.start', { ...payload, trials: 2 }, operationRef); } catch (error) { conflict = error; }
    await conflicting.shutdown();
    expect(conflict).toMatchObject({ message: 'state_conflict' });
    expect(await conflicting.request('eval.start', payload, operationRef)).toEqual(first);
    const restored = new EvaluationWorker(new EvaluationService(paths), operationRef, () => {});
    expect(await restored.request('eval.start', payload, operationRef)).toEqual(first);
    expect(await restored.shutdown()).toMatchObject({ stopConfirmed: true, saveConfirmed: true });
    expect(await restored.request('eval.status', { operationRef }, controllerId)).toMatchObject({ state: 'settled', executionId: first.executionId });
    expect(fetch).not.toHaveBeenCalled();
  } finally { release(); held.mockRestore(); calls.mockRestore(); fetch.mockRestore(); await rm(root, { recursive: true, force: true }); }
}, 30000);

test('original desktop lookup rejects dataset or frozen plan that conflicts with its request', async () => {
  const { root, paths, service } = await configuredService();
  try {
    const executionId = 'desktop-' + operationRef, archive = join(paths.runsRoot, 'business', executionId), snapshot = reportFixture().snapshot;
    snapshot.executionId = executionId;
    snapshot.plan = reportFixture().plan;
    snapshot.desktopRequest = { operationRef, datasetId: 'controlled-fixture', selection: 'smoke', trials: 1 };
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, 'snapshot.json'), JSON.stringify(snapshot));
    expect((await service.findOriginal(executionId)).request).toEqual(snapshot.desktopRequest);
    for (const changed of [
      { ...snapshot, desktopRequest: { ...snapshot.desktopRequest, datasetId: 'foreign-dataset' } },
      { ...snapshot, desktopRequest: { ...snapshot.desktopRequest, trials: 2 } },
      { ...snapshot, plan: [{ ...snapshot.plan[0]!, caseId: 'foreign-case' }] },
    ]) {
      await writeFile(join(archive, 'snapshot.json'), JSON.stringify(changed));
      expect(await service.findOriginal(executionId)).toEqual({ exists: true, request: null });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a platform operation and its original Run can share execution identity without conflicting status lookup', async () => {
  const { EvaluationWorker } = await import('../../agent-eval/src/desktop/controller');
  const { root, paths, service } = await configuredService();
  let runFinished!: () => void, platformFinished!: () => void;
  const endedRun = new Promise<void>(resolve => { runFinished = resolve; }), endedPlatform = new Promise<void>(resolve => { platformFinished = resolve; });
  const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real model and platform calls are disabled'));
  const worker = new EvaluationWorker(service, controllerId, notice => {
    if (notice.type === 'eval.status' && notice.control.state === 'settled') {
      if (notice.control.operationKind === 'run') runFinished(); else platformFinished();
    }
  });
  try {
    const check = await service.preflight({ datasetId: 'medclaw-agent-v1', selection: 'smoke' });
    const started = await worker.request('eval.start', { datasetId: check.datasetId, selection: check.selection, trials: check.trials, preflightId: check.preflightId }, operationRef);
    await worker.request('eval.cancel', { executionId: started.executionId }, controllerId); await endedRun;
    const report = await (await import('../../agent-eval/src/reports/write')).readReport(join(paths.runsRoot, 'business', started.executionId)), trial = report.plan[0]!;
    await service.recordLocalFeedback({ executionId: started.executionId, caseId: trial.caseId, trialId: trial.trialId,
      reviewer: 'Controlled reviewer', status: 'UNJUDGEABLE', comment: 'Controlled feedback on an unstarted Trial', evidenceRefs: [] }, controllerId);
    await writeFile(join(paths.configsRoot, 'environment'), 'LANGFUSE_BASE_URL=http://127.0.0.1:1\nLANGFUSE_PUBLIC_KEY=public\nLANGFUSE_SECRET_KEY=private\nMEDCLAW_LANGFUSE_SERVER_VERSION=controlled\n');
    await worker.request('eval.review.sync', { executionId: started.executionId }, controllerId); await endedPlatform;
    expect(await worker.request('eval.status', { operationRef: controllerId, executionId: started.executionId }, operationRef))
      .toMatchObject({ operationKind: 'review_sync', operationRef: controllerId, executionId: started.executionId, state: 'settled' });
    expect(await worker.request('eval.status', { operationRef, executionId: started.executionId }, controllerId)).toMatchObject({ operationKind: 'run', operationRef });
    expect(fetch).not.toHaveBeenCalled();
  } finally { await worker.shutdown(); fetch.mockRestore(); await rm(root, { recursive: true, force: true }); }
}, 30000);

test('readonly original lookup binds the frozen request so later archive loss cannot turn replay into a new execution', async () => {
  const { EvaluationWorker } = await import('../../agent-eval/src/desktop/controller');
  const { root, paths, service } = await configuredService();
  const report = reportFixture(), executionId = 'desktop-' + operationRef;
  report.executionId = executionId; report.snapshot.executionId = executionId; report.snapshot.plan = report.plan;
  report.snapshot.desktopRequest = { operationRef, datasetId: 'controlled-fixture', selection: 'smoke', trials: 1 };
  await saveReportFixture(join(paths.runsRoot, 'business', executionId), report);
  const worker = new EvaluationWorker(service, controllerId, () => {});
  const prepare = spyOn(service, 'prepareRun').mockRejectedValue(new Error('Original replay must not prepare a Run'));
  const original = spyOn(service, 'findOriginal');
  try {
    expect(await worker.request('eval.status', { operationRef, executionId }, controllerId)).toMatchObject({ state: 'settled', stopConfirmed: true, saveConfirmed: true });
    original.mockResolvedValue({ exists: false, request: null });
    expect(await worker.request('eval.start', { datasetId: 'controlled-fixture', selection: 'smoke', trials: 1, preflightId: controllerId }, operationRef))
      .toEqual({ operationRef, executionId, accepted: true });
    await worker.shutdown(); expect(prepare).not.toHaveBeenCalled(); expect(original).toHaveBeenCalledTimes(1);
    let conflict: unknown;
    try { await worker.request('eval.start', { datasetId: 'controlled-fixture', selection: 'full', trials: 1, preflightId: controllerId }, operationRef); } catch (error) { conflict = error; }
    expect(conflict).toMatchObject({ message: 'state_conflict' });
  } finally { prepare.mockRestore(); original.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test.each(['final_report_write', 'after_first_trial_save'] as const)('%s failure keeps saved original Trials and Scores readable without completing archive or releasing lock', async scenario => {
  const { EvaluationWorker } = await import('../../agent-eval/src/desktop/controller');
  const reports = await import('../../agent-eval/src/reports/write');
  const runner = await import('../../agent-eval/src/execution/runner'), originalRun = runner.runExperiment;
  const { root, paths, service } = await configuredService();
  const writer = spyOn(reports, 'writeReport');
  if (scenario === 'final_report_write') writer.mockRejectedValue(new Error('controlled_final_report_write_failure'));
  const execute = spyOn(runner, 'runExperiment').mockImplementation(options => originalRun({ ...options, onProgress: trial => {
    options.onProgress?.(trial);
    if (scenario === 'after_first_trial_save') throw new Error('controlled_worker_failure_after_trial_save');
  } }));
  const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real services are disabled'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), prepare = service.prepareRun.bind(service);
  const held = spyOn(service, 'prepareRun').mockImplementation(async input => { await gate; return prepare(input); });
  const worker = new EvaluationWorker(service, controllerId, () => {});
  try {
    const check = await service.preflight({ datasetId: 'medclaw-agent-v1', selection: 'smoke' });
    const receipt = await worker.request('eval.start', { datasetId: check.datasetId, selection: check.selection, trials: check.trials, preflightId: check.preflightId }, operationRef);
    await worker.request('eval.cancel', { executionId: receipt.executionId }, controllerId);
    release();
    const recorded = scenario === 'final_report_write' ? 10 : 1;
    expect(await worker.shutdown()).toMatchObject({ stopConfirmed: scenario === 'final_report_write' ? true : null, saveConfirmed: null });
    expect(await worker.request('eval.status', { operationRef }, controllerId)).toMatchObject({ state: 'unknown', result: { kind: 'run', report: { archiveState: 'partial', planned: 10, recorded, totals: null } } });
    const archive = join(paths.runsRoot, 'business', receipt.executionId), before = await readFile(join(archive, 'snapshot.json'), 'utf8');
    const scores = await worker.request('eval.report.read', { executionId: receipt.executionId, section: 'scores' }, controllerId);
    if (scores.section !== 'scores') throw new Error('Wrong report section');
    expect(scores.total).toBeGreaterThan(10);
    expect(scores.items.every(score => score.status === 'NOT_RUN')).toBe(true);
    expect(await readFile(join(archive, 'snapshot.json'), 'utf8')).toBe(before);
    expect(await Bun.file(join(archive, 'report.json')).exists()).toBe(false);
    expect(await Bun.file(join(paths.runsRoot, 'business', '.active-execution.json')).exists()).toBe(true);
    const reopened = new EvaluationService(paths);
    expect(await reopened.readReportSection({ executionId: receipt.executionId, section: 'summary' }))
      .toMatchObject({ summary: { archiveState: 'partial', planned: 10, recorded, totals: null, aggregation: null, analysis: null } });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(worker.request('eval.start', { datasetId: check.datasetId, selection: check.selection, trials: 1, preflightId: check.preflightId }, controllerId)).rejects.toThrow('runtime_busy');
    expect(fetch).not.toHaveBeenCalled();
  } finally { release(); await worker.shutdown(); held.mockRestore(); writer.mockRestore(); execute.mockRestore(); fetch.mockRestore(); await rm(root, { recursive: true, force: true }); }
}, 30000);

test('stored shutdown acknowledgement without process exit proof keeps execution stop unknown', async () => {
  const { root, paths, service } = await configuredService(), report = reportFixture(), trial = report.trials[0]!;
  try {
    await saveReportFixture(join(paths.runsRoot, 'business', report.executionId), report);
    const statePath = join(paths.runsRoot, 'business', report.executionId, 'evidence', trial.trialId, 'trial.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.lifecycle = { shutdown: { stopped: true, closed: true, processExited: false, residuals: ['process_exit_unconfirmed'] } };
    await writeFile(statePath, JSON.stringify(state));
    const reportPath = join(paths.runsRoot, 'business', report.executionId, 'report.json');
    const original = JSON.parse(await readFile(reportPath, 'utf8'));
    original.evidenceManifest.find((item: { path: string }) => item.path.endsWith('/trial.json')).bytes = Buffer.byteLength(JSON.stringify(state));
    await writeFile(reportPath, JSON.stringify(original));
    expect(await service.readReportSection({ executionId: report.executionId, section: 'summary' })).toMatchObject({ archiveState: 'complete' });
    const facts = await service.executionFacts(report.executionId);
    expect(facts.stopConfirmed).not.toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an existing execution without a snapshot stays unknown and cannot be cancelled or restarted as a new Run', async () => {
  const { EvaluationWorker } = await import('../../agent-eval/src/desktop/controller');
  const { root, paths, service } = await configuredService();
  try {
    const executionId = 'desktop-' + operationRef;
    await mkdir(join(paths.runsRoot, 'business', executionId), { recursive: true });
    const worker = new EvaluationWorker(service, controllerId, () => {});
    const payload = { datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1, preflightId: controllerId };
    await expect(worker.request('eval.start', payload, operationRef)).rejects.toThrow('artifact_not_ready');
    expect(await worker.shutdown()).toMatchObject({ stopConfirmed: null, saveConfirmed: null });
    expect(await worker.request('eval.cancel', { executionId }, controllerId)).toMatchObject({ cancelRequested: false });
    await worker.shutdown();
    expect(await worker.request('eval.status', { executionId }, controllerId)).toMatchObject({ state: 'unknown' });
    expect(await readdir(join(paths.runsRoot, 'business', executionId))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('startup discovers a previous desktop lock without a snapshot and never turns its same-ID retry into confirmed stopping', async () => {
  const { EvaluationWorker } = await import('../../agent-eval/src/desktop/controller');
  const { root, paths, service } = await configuredService();
  try {
    await mkdir(join(paths.runsRoot, 'business'), { recursive: true });
    const lock = join(paths.runsRoot, 'business', '.active-execution.json');
    const original = JSON.stringify({ executionId: 'desktop-' + operationRef, pid: 12345, state: 'stop_or_save_unconfirmed' });
    await writeFile(lock, original);
    const worker = new EvaluationWorker(service, controllerId, () => {});
    expect(await worker.request('eval.status', {}, controllerId)).toMatchObject({ state: 'unknown', operationRef, executionId: 'desktop-' + operationRef, stopConfirmed: null, saveConfirmed: null });
    expect(await worker.shutdown()).toMatchObject({ stopConfirmed: null, saveConfirmed: null });
    const retry = new EvaluationWorker(service, controllerId, () => {}), check = await service.preflight({ datasetId: 'medclaw-agent-v1', selection: 'smoke' });
    await expect(retry.request('eval.start', { datasetId: check.datasetId, selection: check.selection, trials: check.trials, preflightId: check.preflightId }, operationRef)).rejects.toThrow('artifact_not_ready');
    expect(await retry.shutdown()).toMatchObject({ stopConfirmed: null, saveConfirmed: null });
    expect(await readFile(lock, 'utf8')).toBe(original);
    expect(await readdir(join(paths.runsRoot, 'business'))).toEqual(['.active-execution.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(['shutdown', 'old_controller_frame'] as const)('actual Bun control process handles %s without configuration, models or archive writes', async scenario => {
  const { EvaluationFrameDecoder, encodeEvaluationFrame } = await import('../../packages/contracts/src/evaluation-transport');
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p16-control-process-'));
  const paths = { sourceRoot, configsRoot: join(root, 'configs'), runsRoot: join(root, 'runs') };
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const child = Bun.spawn([process.execPath, '--no-env-file', join(sourceRoot, 'agent-eval/src/desktop/controller.ts')], { cwd: sourceRoot, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader(), decoder = new EvaluationFrameDecoder(controllerId);
  const received: import('../../packages/contracts/src/evaluation').EvaluationControlFrame[] = [];
  const next = async () => {
    while (!received.length) { const chunk = await reader.read(); if (chunk.done) throw new Error('Control process ended before reply'); received.push(...decoder.push(chunk.value)); }
    return received.shift()!;
  };
  try {
    child.stdin.write(encodeEvaluationFrame({ protocolVersion: 'medclaw.evaluation-control/v1', kind: 'hello', controllerInstanceId: controllerId, paths }));
    expect(await next()).toMatchObject({ kind: 'ready', controllerInstanceId: controllerId });
    child.stdin.write(encodeEvaluationFrame({ protocolVersion: 'medclaw.evaluation-control/v1', kind: 'request', controllerInstanceId: controllerId, requestId: 'status', request: { method: 'eval.status', payload: {}, operationRef } }));
    expect(await next()).toMatchObject({ kind: 'reply', requestId: 'status', result: { ok: true, data: { state: 'idle', controllerExited: false } } });
    if (scenario === 'shutdown') {
      child.stdin.write(encodeEvaluationFrame({ protocolVersion: 'medclaw.evaluation-control/v1', kind: 'shutdown', controllerInstanceId: controllerId, requestId: 'close' }));
      expect(await next()).toMatchObject({ kind: 'shutdown', requestId: 'close', proof: { stopConfirmed: true, saveConfirmed: true, controllerExited: false } });
      expect(await child.exited).toBe(0);
    } else {
      child.stdin.write(encodeEvaluationFrame({ protocolVersion: 'medclaw.evaluation-control/v1', kind: 'request', controllerInstanceId: operationRef, requestId: 'old', request: { method: 'eval.status', payload: {}, operationRef } }));
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stderr).text()).not.toContain('private');
    }
    expect(await readdir(root)).toEqual([]);
  } finally { if (child.exitCode === null) { child.kill(); await child.exited; } reader.releaseLock(); await rm(root, { recursive: true, force: true }); }
}, 30000);

test('status rejects two known conflicting identities and keeps explicit unknown identities instead of current results', async () => {
  const { EvaluationWorker } = await import('../../agent-eval/src/desktop/controller');
  const { root, paths, service } = await configuredService();
  const settled = new Map<string, () => void>();
  const worker = new EvaluationWorker(service, controllerId, notice => {
    if (notice.type === 'eval.status' && notice.control.state === 'settled') settled.get(notice.executionId!)?.();
  });
  try {
    for (const ref of [operationRef, controllerId]) {
      const ready = new Promise<void>(resolve => settled.set('desktop-' + ref, resolve));
      await worker.request('eval.start', { datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1, preflightId: controllerId }, ref);
      await ready;
      expect(await worker.request('eval.status', { operationRef: ref }, operationRef)).toMatchObject({ state: 'settled', error: { code: 'config_conflict' } });
    }
    await expect(worker.request('eval.status', { operationRef, executionId: 'desktop-' + controllerId }, controllerId)).rejects.toThrow('state_conflict');
    const unknownRef = '08ecb4f2-1aee-488a-9b52-96fbf13c735c';
    expect(await worker.request('eval.status', { executionId: 'desktop-' + unknownRef }, controllerId))
      .toMatchObject({ state: 'unknown', operationRef: null, executionId: 'desktop-' + unknownRef, stopConfirmed: null, saveConfirmed: null });
    expect(await worker.request('eval.status', { operationRef: unknownRef }, controllerId))
      .toMatchObject({ state: 'unknown', operationRef: unknownRef, executionId: null, stopConfirmed: null, saveConfirmed: null });
    expect(await worker.request('eval.status', {}, operationRef)).toMatchObject({ state: 'settled', operationRef: controllerId, executionId: 'desktop-' + controllerId });
  } finally { await worker.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 30000);
