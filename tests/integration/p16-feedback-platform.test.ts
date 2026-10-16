import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EvaluationService } from '../../agent-eval/src/desktop/service';
import { EvaluationWorker } from '../../agent-eval/src/desktop/controller';
import type { EvaluationNotice } from '../../packages/contracts/src/evaluation';
import { EvaluationController } from '../../apps/desktop/src/main/evaluation-controller';
import type { HostView } from '../../packages/contracts/src/model';
import { exportReport, type PlatformConfig } from '../../agent-eval/src/langfuse/export';
import { syncReview } from '../../agent-eval/src/review/platform';
import { recordFeedback } from '../../agent-eval/src/review/store';
import { reportFixture, saveReportFixture } from '../../agent-eval/tests/report-fixture';
import { aggregate } from '../../agent-eval/src/scoring/aggregate';
import * as files from '../../agent-eval/src/reports/write';
import * as storage from 'node:fs/promises';
import * as scoring from '../../agent-eval/src/scoring/evaluate';
import * as runner from '../../agent-eval/src/execution/runner';

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'medclaw-p16-platform-')), root = join(temporary, 'runs/business/controlled-fixture'), report = reportFixture(), trial = report.trials[0]!;
  Object.assign(trial, { status: 'completed', instanceId: 'controlled-host', startedAt: report.createdAt, endedAt: report.createdAt,
    stopped: true, closed: true, observationRef: 'evidence/' + trial.trialId + '/observation.json' });
  const aggregation = aggregate(report.plan, report.trials, report.scores, report.cases); report.aggregation = aggregation; report.totals = aggregation.totals;
  await saveReportFixture(root, report, { [trial.trialId]: { executionId: report.executionId, trialId: trial.trialId, instanceId: trial.instanceId,
    observedFrom: report.createdAt, observedUntil: report.createdAt, identityChecks: [],
    facts: { modelCalls: [{ id: 1, runId: 2, startedAt: report.createdAt, endedAt: report.createdAt }], queries: [] }, missing: [] } });
  const originalReport = await readFile(join(root, 'report.json'), 'utf8'), originalSnapshot = await readFile(join(root, 'snapshot.json'), 'utf8');
  const judge = spyOn(scoring, 'evaluate').mockRejectedValue(new Error('No rescoring is permitted'));
  const model = spyOn(runner, 'runExperiment').mockRejectedValue(new Error('No model execution is permitted'));
  const config = (baseUrl: string): PlatformConfig => ({ baseUrl, publicKey: 'controlled-public', secretKey: 'controlled-private', serverVersion: 'controlled', transport: 'otel-http-json/v1' });
  const paths = { sourceRoot: resolve(import.meta.dir, '../..'), configsRoot: join(temporary, 'configs'), runsRoot: join(temporary, 'runs') };
  return { root, paths, report, trial, config, async close() {
    expect(judge).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'report.json'), 'utf8')).toBe(originalReport);
    expect(await readFile(join(root, 'snapshot.json'), 'utf8')).toBe(originalSnapshot);
    judge.mockRestore(); model.mockRestore(); await rm(temporary, { recursive: true, force: true });
  } };
}

const platformRef = '63faf6f3-1dc9-4768-a23d-52cb734619ef', controllerRef = '943bfb28-d6f1-4b30-92f7-818d51640817';
async function platformWorker(f: Awaited<ReturnType<typeof fixture>>, baseUrl: string, method: 'eval.resend' | 'eval.review.sync', notify: (notice: EvaluationNotice) => void = () => {}) {
  await mkdir(f.paths.configsRoot, { recursive: true });
  await writeFile(join(f.paths.configsRoot, 'environment'), `LANGFUSE_BASE_URL=${baseUrl}\nLANGFUSE_PUBLIC_KEY=controlled-public\nLANGFUSE_SECRET_KEY=controlled-private\nMEDCLAW_LANGFUSE_SERVER_VERSION=controlled\n`);
  const service = new EvaluationService(f.paths); await service.initializeRuntime();
  if (method === 'eval.review.sync') for (const ref of ['c85a8476-22d6-4b3a-87a8-1091f9a2b34e', '96e451b0-98d4-45d8-863f-32900c7bc7c4']) {
    await service.recordLocalFeedback({ executionId: f.report.executionId, caseId: f.trial.caseId, trialId: f.trial.trialId,
      reviewer: 'Controlled reviewer', status: 'PASS', comment: 'Controlled submitted feedback', evidenceRefs: [] }, ref);
  }
  return { service, worker: new EvaluationWorker(service, controllerRef, notify) };
}

function actualController(f: Awaited<ReturnType<typeof fixture>>, notify: (notice: EvaluationNotice) => void) {
  const production: HostView = { instanceId: null, state: 'stopped', canStart: true, sdkVersion: null, schemaVersion: null, error: null };
  return new EvaluationController({ paths: f.paths, workerEntry: join(f.paths.sourceRoot, 'agent-eval/src/desktop/controller.ts'), bunExecutable: process.execPath,
    production: { read: () => production, request: async () => { throw new Error('The stopped production Host must not execute'); } }, notify });
}

test('actual Main and Bun reserve platform work, keep receipt reads from changing admission and confirm real worker exit', async () => {
  const f = await fixture(); let requests = 0, release!: () => void, received!: () => void, settled!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), observed = new Promise<void>(resolve => { received = resolve; }), done = new Promise<void>(resolve => { settled = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => { requests++; await request.json(); received(); await hold; return Response.json({}); } });
  await platformWorker(f, server.url.href, 'eval.resend');
  const controller = actualController(f, notice => { if (notice.type === 'eval.status' && notice.control.state === 'settled') settled(); });
  try {
    expect(await controller.dispatch('eval.resend', { executionId: f.report.executionId }, platformRef)).toMatchObject({ accepted: true, operationKind: 'resend' });
    await observed;
    let blocked: unknown; try { await controller.withProductionAdmission('host.restart', { expectedInstanceId: 'old-host' }, 'platform-blocked', async () => 'unexpected'); } catch (error) { blocked = error; }
    expect(blocked).toMatchObject({ code: 'runtime_busy' });
    expect(await controller.dispatch('eval.status', { executionId: f.report.executionId, platform: 'resend', pageSize: 1 }, controllerRef))
      .toMatchObject({ state: 'unknown', result: { kind: 'resend', platform: { unknown: 1, remaining: 1 } } });
    expect(controller.read()).toMatchObject({ state: 'running', operationRef: platformRef });
    release(); await done;
    expect(controller.read()).toMatchObject({ state: 'settled', result: { kind: 'resend', platform: { state: 'complete', accepted: 2 } } });
    expect(await controller.withProductionAdmission('host.restart', { expectedInstanceId: 'old-host' }, 'platform-finished', async () => 'allowed')).toBe('allowed');
    expect(requests).toBe(2);
    expect(await controller.shutdown()).toMatchObject({ stopConfirmed: true, saveConfirmed: true, controllerExited: true });
  } finally { release(); await controller.shutdown(); server.stop(true); await f.close(); }
}, 40000);

test('actual Bun retains a response-save failure across refused Main shutdown and later saves without another request', async () => {
  const f = await fixture(), destination = join(f.root, 'export.json'), backup = join(f.root, 'controlled-export-before-response.json');
  let requests = 0, restored = false, failed!: () => void;
  const unknown = new Promise<void>(resolve => { failed = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    requests++; await request.json();
    await rename(destination, backup); await mkdir(destination); return Response.json({});
  } });
  await platformWorker(f, server.url.href, 'eval.resend');
  const controller = actualController(f, notice => { if (notice.type === 'eval.status' && notice.control.state === 'unknown' && notice.control.stopConfirmed === true && notice.control.saveConfirmed !== true) failed(); });
  try {
    await controller.dispatch('eval.resend', { executionId: f.report.executionId }, platformRef); await unknown;
    expect(await controller.shutdown()).toMatchObject({ stopConfirmed: true, saveConfirmed: null, controllerExited: false });
    expect(JSON.parse(await readFile(backup, 'utf8')).state.receipts).toMatchObject([{ state: 'unknown' }]);
    expect(requests).toBe(1);
    await rmdir(destination); await rename(backup, destination); restored = true;
    expect(await controller.shutdown()).toMatchObject({ stopConfirmed: true, saveConfirmed: true, controllerExited: true });
    expect(JSON.parse(await readFile(destination, 'utf8')).state.receipts).toMatchObject([{ state: 'accepted' }]);
    expect(requests).toBe(1);
  } finally {
    if (!restored && await Bun.file(backup).exists()) { await rmdir(destination); await rename(backup, destination); }
    await controller.shutdown(); server.stop(true); await f.close();
  }
}, 40000);

test('platform-only independent configuration is visible without an Agent configuration and preflight makes no requests', async () => {
  const f = await fixture();
  try {
    const { service } = await platformWorker(f, 'http://127.0.0.1:1', 'eval.resend');
    expect(await service.preflight({ datasetId: 'medclaw-agent-v1', selection: 'smoke' })).toMatchObject({ platformConfigured: true, config: null,
      blockers: [{ code: 'evaluation_config_unavailable' }] });
    expect(await Bun.file(join(f.root, 'export.json')).exists()).toBe(false);
  } finally { await f.close(); }
});

test.each(['eval.resend', 'eval.review.sync'] as const)('%s reservation-save failure reports storage failure without sending a request', async method => {
  const f = await fixture(); let requests = 0, finished!: () => void;
  const terminal = new Promise<void>(resolve => { finished = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { requests++; return Response.json({}); } });
  const { worker } = await platformWorker(f, server.url.href, method, notice => { if (notice.type === 'eval.status' && notice.control.state === 'settled') finished(); });
  const replace = files.replaceJson;
  const failure = spyOn(files, 'replaceJson').mockImplementation(async (path, value) => {
    const document = value as { state?: { receipts: { state: string }[] }; receipts?: { kind: string; receipts: { state: string }[] }[] };
    if (path.endsWith('export.json') && document.state?.receipts.some(receipt => receipt.state === 'unknown')
      || path.endsWith('review.json') && document.receipts?.some(attempt => attempt.kind === 'sync' && attempt.receipts.some(receipt => receipt.state === 'unknown'))) throw new Error('Controlled reservation write failure');
    await replace(path, value);
  });
  try {
    await worker.request(method, { executionId: f.report.executionId }, platformRef); await terminal;
    expect(await worker.request('eval.status', { operationRef: platformRef }, controllerRef)).toMatchObject({ state: 'settled', stopConfirmed: true, saveConfirmed: true,
      error: { code: 'storage_write_failed' }, result: { platform: { accepted: 0, unknown: 0, remaining: 2 } } });
    expect(requests).toBe(0);
  } finally { failure.mockRestore(); await worker.shutdown(); server.stop(true); await f.close(); }
}, 30000);

test('sync response identity mismatch stays unknown and an explicit new attempt reuses the same feedback IDs', async () => {
  const f = await fixture(), ids: string[] = []; let invalid = true, finished!: () => void;
  const terminal = new Promise<void>(resolve => { finished = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const body = await request.json() as { id: string }; ids.push(body.id);
    return Response.json(invalid ? { id: 'foreign-receipt', error: 'synthetic-private-provider-body' } : { id: body.id });
  } });
  const { worker } = await platformWorker(f, server.url.href, 'eval.review.sync', notice => { if (notice.type === 'eval.status' && notice.control.state === 'settled') finished(); });
  try {
    await worker.request('eval.review.sync', { executionId: f.report.executionId }, platformRef); await terminal;
    const state = await worker.request('eval.status', { operationRef: platformRef }, controllerRef);
    expect(state).toMatchObject({ state: 'settled', error: { code: 'evaluation_platform_failed' }, result: { platform: { unknown: 1, accepted: 0, remaining: 1 } } });
    expect(JSON.stringify(state)).not.toContain('synthetic-private-provider-body'); expect(ids).toHaveLength(1);
    invalid = false;
    const service = new EvaluationService(f.paths); await service.initializeRuntime();
    let completed!: () => void; const done = new Promise<void>(resolve => { completed = resolve; });
    const restarted = new EvaluationWorker(service, controllerRef, notice => { if (notice.type === 'eval.status' && notice.control.state === 'settled') completed(); });
    await restarted.request('eval.review.sync', { executionId: f.report.executionId }, controllerRef); await done;
    expect(await restarted.request('eval.status', {}, platformRef)).toMatchObject({ result: { kind: 'review_sync', platform: { state: 'complete', accepted: 2, unknown: 0 } } });
    expect(ids).toHaveLength(3); expect(ids[0]).toBe(ids[1]); expect(new Set(ids).size).toBe(2); await restarted.shutdown();
  } finally { await worker.shutdown(); server.stop(true); await f.close(); }
}, 30000);

test('response persistence recovery refuses to overwrite a newer original export attempt', async () => {
  const f = await fixture(); let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => { requests++; await request.json(); return Response.json({}); } });
  const replace = files.replaceJson;
  const failure = spyOn(files, 'replaceJson').mockImplementation(async (path, value) => {
    if (path.endsWith('export.json') && (value as { state?: { receipts: { state: string }[] } }).state?.receipts.some(receipt => receipt.state === 'accepted')) throw new Error('Controlled save failure');
    await replace(path, value);
  });
  try {
    let error: unknown; try { await exportReport(f.root, 'langfuse', f.config(server.url.href)); } catch (caught) { error = caught; }
    failure.mockRestore();
    const path = join(f.root, 'export.json'), current = JSON.parse(await readFile(path, 'utf8'));
    current.state.attempts.push({ at: new Date().toISOString(), state: 'error', receipts: [] });
    const newer = JSON.stringify(current); await writeFile(path, newer);
    let conflict: unknown; try { await (error as { retrySave(): Promise<void> }).retrySave(); } catch (caught) { conflict = caught; }
    expect(conflict).toMatchObject({ message: 'state_conflict' });
    expect(await readFile(path, 'utf8')).toBe(newer); expect(requests).toBe(1);
  } finally { failure.mockRestore(); server.stop(true); await f.close(); }
});

test.each(['eval.resend', 'eval.review.sync'] as const)('%s is accepted before HTTP completes, pages actual receipts and shuts down without sending another item', async method => {
  const f = await fixture(); let requests = 0, release!: () => void, observed!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), received = new Promise<void>(resolve => { observed = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    requests++; const body = await request.json() as { id?: string }; observed(); await hold; return Response.json(body.id ? { id: body.id } : {});
  } });
  const { worker } = await platformWorker(f, server.url.href, method);
  const operationKind = method === 'eval.resend' ? 'resend' : 'review_sync';
  try {
    const initial = await worker.request('eval.status', { executionId: f.report.executionId, platform: operationKind }, controllerRef);
    expect(initial.result).toMatchObject({ kind: operationKind, platform: { exportExists: false, state: 'disabled' } });
    expect(await Bun.file(join(f.root, 'export.json')).exists()).toBe(false);
    const receipt = await worker.request(method, { executionId: f.report.executionId }, platformRef);
    expect(receipt).toEqual({ operationRef: platformRef, executionId: f.report.executionId, operationKind, accepted: true });
    await received;
    expect(await worker.request(method, { executionId: f.report.executionId }, platformRef)).toEqual(receipt);
    let conflict: unknown; try { await worker.request(method, { executionId: 'other-execution' }, platformRef); } catch (error) { conflict = error; }
    expect(conflict).toMatchObject({ message: 'state_conflict' });
    const active = await worker.request('eval.status', { operationRef: platformRef, executionId: f.report.executionId, page: 1, pageSize: 1 }, controllerRef);
    expect(active).toMatchObject({ state: 'running', operationKind, result: { kind: operationKind, platform: { unknown: 1, remaining: 1, receipts: { total: 1, items: [{ state: 'unknown' }] } } } });
    expect(await worker.request('eval.cancel', { executionId: f.report.executionId }, controllerRef)).toMatchObject({ cancelRequested: false, control: { state: 'running' } });
    let busy: unknown; try { await worker.request('eval.start', { datasetId: 'medclaw-agent-v1', selection: 'smoke', preflightId: controllerRef }, controllerRef); } catch (error) { busy = error; }
    expect(busy).toMatchObject({ message: 'runtime_busy' });
    expect(await worker.shutdown()).toMatchObject({ stopConfirmed: true, saveConfirmed: true });
    expect(await worker.request('eval.status', { operationRef: platformRef }, controllerRef)).toMatchObject({ state: 'settled', result: { kind: operationKind, platform: { unknown: 1, remaining: 1 } } });
    expect(requests).toBe(1);
    expect(JSON.stringify(await worker.request('eval.status', {}, controllerRef))).not.toContain('controlled-private');
    const restarted = new EvaluationWorker(new EvaluationService(f.paths), controllerRef, () => {});
    const history = await restarted.request('eval.status', { operationRef: platformRef, executionId: f.report.executionId, platform: operationKind }, controllerRef);
    expect(history).toMatchObject({ state: 'unknown', stopConfirmed: null, saveConfirmed: null, result: { kind: operationKind, platform: { unknown: 1, remaining: 1 } } });
    expect(requests).toBe(1);
  } finally { release(); await worker.shutdown(); server.stop(true); await f.close(); }
}, 30000);

for (const releaseFailure of [false, true]) test.each(['eval.resend', 'eval.review.sync'] as const)('%s retains failed response persistence' + (releaseFailure ? ' with failed owner release' : '') + ' and shutdown retries only saving its actual receipt', async method => {
  const f = await fixture(); let requests = 0, failed = true, refusingRelease = false, recoveryReleaseFailure = releaseFailure, terminal!: () => void;
  const ended = new Promise<void>(resolve => { terminal = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => { requests++; const body = await request.json() as { id?: string }; return Response.json(body.id ? { id: body.id } : {}); } });
  const { worker } = await platformWorker(f, server.url.href, method, notice => { if (notice.type === 'eval.status' && ['unknown', 'settled'].includes(notice.control.state)) terminal(); });
  const unlink = storage.unlink;
  const ownerFailure = spyOn(storage, 'unlink').mockImplementation(async path => {
    if (refusingRelease && typeof path === 'string' && path.startsWith(f.root) && /\.(export|review)\.lock[\\/][0-9a-f-]+\.json$/.test(path)) throw Object.assign(new Error('Controlled owner release failure'), { code: 'EACCES' });
    return unlink(path);
  });
  const replace = files.replaceJson;
  const failure = spyOn(files, 'replaceJson').mockImplementation(async (path, value) => {
    const saved = value as { state?: { receipts: { state: string }[] }; receipts?: { kind: string; receipts: { state: string }[] }[] };
    const accepted = path.endsWith('export.json') && saved.state?.receipts.some(receipt => receipt.state === 'accepted')
      || path.endsWith('review.json') && saved.receipts?.some(attempt => attempt.kind === 'sync' && attempt.receipts.some(receipt => receipt.state === 'accepted'));
    if (failed && accepted) { refusingRelease = releaseFailure; throw new Error('Controlled response persistence failed'); }
    await replace(path, value);
    if (!failed && accepted && recoveryReleaseFailure) { recoveryReleaseFailure = false; refusingRelease = true; }
  });
  try {
    await worker.request(method, { executionId: f.report.executionId }, platformRef); await ended;
    expect(await worker.shutdown()).toMatchObject({ stopConfirmed: true, saveConfirmed: false });
    expect(await worker.request('eval.status', { operationRef: platformRef }, controllerRef)).toMatchObject({ state: 'unknown', result: { platform: { accepted: 0, unknown: 1 } } });
    expect(requests).toBe(1); failed = false; refusingRelease = false;
    if (releaseFailure) {
      expect(await worker.shutdown()).toMatchObject({ stopConfirmed: true, saveConfirmed: false });
      expect(await worker.request('eval.status', { operationRef: platformRef }, controllerRef)).toMatchObject({ state: 'unknown', result: { platform: { accepted: 1, unknown: 0, remaining: 1 } } });
      expect(requests).toBe(1); refusingRelease = false;
    }
    expect(await worker.shutdown()).toMatchObject({ stopConfirmed: true, saveConfirmed: true });
    expect(await worker.request('eval.status', { operationRef: platformRef }, controllerRef)).toMatchObject({ state: 'settled', result: { platform: { accepted: 1, unknown: 0, remaining: 1 } } });
    expect(requests).toBe(1);
  } finally { failed = false; refusingRelease = false; failure.mockRestore(); ownerFailure.mockRestore(); await worker.shutdown(); server.stop(true); await f.close(); }
}, 30000);

test('local explicit feedback needs no configuration, retries with its original timestamp and preserves conflicts without changing scores', async () => {
  const f = await fixture(), service = new EvaluationService(f.paths), operationRef = 'c85a8476-22d6-4b3a-87a8-1091f9a2b34e';
  const input = { executionId: f.report.executionId, caseId: f.trial.caseId, trialId: f.trial.trialId, reviewer: 'Controlled reviewer',
    status: 'PASS' as const, comment: 'Explicit controlled local feedback', evidenceRefs: [] };
  try {
    expect(await service.readReportSection({ executionId: input.executionId, section: 'feedback' })).toMatchObject({ total: 0 });
    expect(await Bun.file(join(f.root, 'review.json')).exists()).toBe(false);
    const first = await service.recordLocalFeedback(input, operationRef);
    expect(first.state).toBe('recorded');
    const saved = JSON.parse(await readFile(join(f.root, 'review.json'), 'utf8'));
    expect(saved.feedback[0].value).toMatchObject({ source: 'local', sourceId: 'desktop-' + operationRef, ...input });
    expect(await service.recordLocalFeedback(input, operationRef)).toEqual({ state: 'duplicate', id: first.id });
    expect(JSON.parse(await readFile(join(f.root, 'review.json'), 'utf8')).feedback).toEqual(saved.feedback);
    let conflict: unknown; try { await service.recordLocalFeedback({ ...input, comment: 'A real conflicting correction' }, operationRef); } catch (error) { conflict = error; }
    expect(conflict).toMatchObject({ message: 'feedback_conflict_preserved' });
    expect(JSON.parse(await readFile(join(f.root, 'review.json'), 'utf8')).conflicts).toHaveLength(1);
    let denied: unknown; try { await service.recordLocalFeedback({ ...input, evidenceRefs: ['../../foreign'] }, '96e451b0-98d4-45d8-863f-32900c7bc7c4'); } catch (error) { denied = error; }
    expect(denied).toMatchObject({ message: 'access_denied' });
    expect(await Bun.file(join(f.root, 'export.json')).exists()).toBe(false);
  } finally { await f.close(); }
});

test('resend checkpoints each attempt before HTTP and reuses accepted IDs after cancellation and restart', async () => {
  const f = await fixture(), abort = new AbortController(), beforeSend: string[][] = [], posted: unknown[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const saved = JSON.parse(await readFile(join(f.root, 'export.json'), 'utf8'));
    beforeSend.push(saved.state.receipts.map((receipt: { state: string }) => receipt.state));
    posted.push(await request.json()); return Response.json({});
  } });
  const replace = files.replaceJson;
  const checkpoint = spyOn(files, 'replaceJson').mockImplementation(async (path, value) => {
    await replace(path, value);
    if (path.endsWith('export.json') && (value as { state?: { receipts: { state: string }[] } }).state?.receipts.some(receipt => receipt.state === 'accepted')) abort.abort();
  });
  try {
    const first = await exportReport(f.root, 'langfuse', f.config(server.url.href), abort.signal);
    expect(posted).toHaveLength(1); expect(beforeSend).toEqual([['unknown']]);
    expect(first).toMatchObject({ state: 'error', receipts: [{ state: 'accepted' }] });
    const partial = JSON.parse(await readFile(join(f.root, 'export.json'), 'utf8'));
    expect(partial.envelope.events.length).toBeGreaterThan(1);
    checkpoint.mockRestore();
    expect((await exportReport(f.root, 'langfuse', f.config(server.url.href))).state).toBe('complete');
    const final = JSON.parse(await readFile(join(f.root, 'export.json'), 'utf8'));
    expect(final.envelope).toEqual(partial.envelope);
    expect(final.state.attempts[0]).toEqual(partial.state.attempts[0]);
    expect(posted).toHaveLength(final.envelope.events.length);
  } finally { checkpoint.mockRestore(); server.stop(true); await f.close(); }
});

test.each(['before_request', 'after_response'] as const)('resend %s save failure stops sending and preserves the actual durable receipt', async scenario => {
  const f = await fixture(); let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => { requests++; await request.json(); return Response.json({}); } });
  const replace = files.replaceJson;
  const failure = spyOn(files, 'replaceJson').mockImplementation(async (path, value) => {
    const state = (value as { state?: { receipts: { state: string }[] } }).state;
    if (path.endsWith('export.json') && state?.receipts.some(receipt => receipt.state === (scenario === 'before_request' ? 'unknown' : 'accepted'))) throw new Error('Controlled receipt save failure');
    await replace(path, value);
  });
  try {
    let error: unknown;
    try { await exportReport(f.root, 'langfuse', f.config(server.url.href)); } catch (caught) { error = caught; }
    expect(error).toBeDefined(); expect(requests).toBe(scenario === 'before_request' ? 0 : 1);
    const saved = JSON.parse(await readFile(join(f.root, 'export.json'), 'utf8'));
    expect(saved.state.receipts.map((receipt: { state: string }) => receipt.state)).toEqual(scenario === 'before_request' ? [] : ['unknown']);
    if (scenario === 'after_response') {
      failure.mockRestore();
      expect(typeof (error as { retrySave?: unknown }).retrySave).toBe('function');
      await (error as { retrySave(): Promise<void> }).retrySave();
      expect(requests).toBe(1);
      expect(JSON.parse(await readFile(join(f.root, 'export.json'), 'utf8')).state.receipts).toMatchObject([{ state: 'accepted' }]);
    }
  } finally { failure.mockRestore(); server.stop(true); await f.close(); }
});

test('pre-cancelled resend sends nothing and creates no platform identities', async () => {
  const f = await fixture(), abort = new AbortController(); abort.abort();
  try {
    let error: unknown; try { await exportReport(f.root, 'langfuse', f.config('http://127.0.0.1:1'), abort.signal); } catch (caught) { error = caught; }
    expect(error).toBeDefined(); expect(await Bun.file(join(f.root, 'export.json')).exists()).toBe(false);
  } finally { await f.close(); }
});

test('feedback sync saves unknown before HTTP and accepted before the next item, then skips accepted IDs', async () => {
  const f = await fixture(), abort = new AbortController(), ids: string[] = [];
  for (const sourceId of ['first', 'second']) await recordFeedback(f.root, { contract: 'medclaw-human-feedback/v1', source: 'local', sourceId,
    reviewer: 'Controlled reviewer', reviewedAt: f.report.createdAt, executionId: f.report.executionId, caseId: f.trial.caseId, trialId: f.trial.trialId,
    status: 'PASS', comment: 'Controlled explicit feedback', evidenceRefs: [] });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const body = await request.json() as { id: string }; ids.push(body.id);
    const review = JSON.parse(await readFile(join(f.root, 'review.json'), 'utf8'));
    expect(review.receipts.at(-1).receipts.at(-1)).toMatchObject({ id: body.id, state: 'unknown' });
    return Response.json({ id: body.id });
  } });
  const replace = files.replaceJson;
  const checkpoint = spyOn(files, 'replaceJson').mockImplementation(async (path, value) => {
    await replace(path, value);
    if (path.endsWith('review.json') && (value as { receipts?: { kind: string; receipts: { state: string }[] }[] }).receipts?.some(attempt => attempt.kind === 'sync' && attempt.receipts.some(receipt => receipt.state === 'accepted'))) abort.abort();
  });
  try {
    await syncReview(f.root, f.config(server.url.href), abort.signal);
    expect(ids).toHaveLength(1);
    checkpoint.mockRestore(); await syncReview(f.root, f.config(server.url.href)); await syncReview(f.root, f.config(server.url.href));
    expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(2);
    const review = JSON.parse(await readFile(join(f.root, 'review.json'), 'utf8'));
    expect(review.receipts[0].receipts).toMatchObject([{ id: ids[0], state: 'accepted' }]);
  } finally { checkpoint.mockRestore(); server.stop(true); await f.close(); }
});

test('sync without explicit local feedback creates no review or export record and sends nothing', async () => {
  const f = await fixture();
  try {
    expect(await syncReview(f.root, f.config('http://127.0.0.1:1'))).toMatchObject({ receipts: [] });
    expect(await Bun.file(join(f.root, 'export.json')).exists()).toBe(false);
    expect(await Bun.file(join(f.root, 'review.json')).exists()).toBe(false);
  } finally { await f.close(); }
});
