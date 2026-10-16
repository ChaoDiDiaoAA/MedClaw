import { expect, test, spyOn } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as crypto from 'node:crypto';
import * as doctor from '../../agent-eval/src/doctor';
import { reportFixture, runConfigFixture, saveReportFixture } from '../../agent-eval/tests/report-fixture';

const sourceRoot = resolve(import.meta.dir, '../..');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p16-service-'));
  return { root, paths: { sourceRoot, configsRoot: join(root, 'configs'), runsRoot: join(root, 'runs') } };
}
async function files(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const path of await readdir(root, { recursive: true, withFileTypes: true })) if (path.isFile()) {
    const full = join(path.parentPath, path.name);
    output[full] = await readFile(full, 'utf8');
  }
  return output;
}

test('readonly report and export state work without configuration and create no IDs, files or network requests', async () => {
  const { EvaluationService } = await import('../../agent-eval/src/desktop/service');
  const { root, paths } = await fixture();
  try {
    const report = reportFixture();
    await saveReportFixture(join(paths.runsRoot, 'business', report.executionId), report);
    const service = new EvaluationService(paths), before = await files(root);
    const id = spyOn(crypto, 'randomUUID'), fetch = spyOn(globalThis, 'fetch');
    try {
      expect(await service.listReports({ page: 1, pageSize: 50 })).toMatchObject({ total: 1, items: [{ executionId: report.executionId, archiveState: 'complete' }] });
      expect(await service.readExportState(report.executionId)).toMatchObject({ exportExists: false, state: 'disabled', remaining: 0 });
      expect(await service.readReportSection({ executionId: report.executionId, section: 'feedback', page: 1, pageSize: 50 })).toMatchObject({ total: 0, items: [] });
      expect(id).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
      expect(await files(root)).toEqual(before);
    } finally { id.mockRestore(); fetch.mockRestore(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('report projection redacts configured credentials before any preflight, even with an incomplete model configuration', async () => {
  const { EvaluationService } = await import('../../agent-eval/src/desktop/service');
  const { root, paths } = await fixture(), report = reportFixture();
  try {
    await mkdir(paths.configsRoot, { recursive: true });
    await writeFile(join(paths.configsRoot, 'agent.json'), JSON.stringify({ model: { key: 'opaque-agent-credential' } }));
    await writeFile(join(paths.configsRoot, 'environment'), 'MEDCLAW_JUDGE_API_KEY=opaque-judge-credential\n');
    report.scores[0]!.reason = 'Original opaque-agent-credential and opaque-judge-credential';
    const { aggregate } = await import('../../agent-eval/src/scoring/aggregate');
    const aggregation = aggregate(report.plan, report.trials, report.scores, report.cases, report.snapshot.criteria as Parameters<typeof aggregate>[4]);
    report.aggregation = aggregation; report.totals = aggregation.totals;
    await saveReportFixture(join(paths.runsRoot, 'business', report.executionId), report);
    const before = await files(root), fetch = spyOn(globalThis, 'fetch');
    try {
      const service = new EvaluationService(paths);
      const view = await service.readReportSection({ executionId: report.executionId, section: 'scores' });
      expect(JSON.stringify(view)).not.toContain('opaque-agent-credential');
      expect(JSON.stringify(view)).not.toContain('opaque-judge-credential');
      expect(JSON.stringify(view)).toContain('[Redacted]');
      expect(fetch).not.toHaveBeenCalled(); expect(await files(root)).toEqual(before);
    } finally { fetch.mockRestore(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('preflight computes dynamic members and Judge limits offline and blocks pending data or missing configuration', async () => {
  const { EvaluationService } = await import('../../agent-eval/src/desktop/service');
  const { root, paths } = await fixture();
  try {
    await mkdir(paths.configsRoot, { recursive: true });
    await writeFile(join(paths.configsRoot, 'agent.json'), JSON.stringify(runConfigFixture()));
    await writeFile(join(paths.configsRoot, 'environment'), 'MEDCLAW_JUDGE_BASE_URL=https://judge.example.invalid/v1\nMEDCLAW_JUDGE_MODEL=openai/gpt-4o-mini\nMEDCLAW_JUDGE_API_KEY=judge-private-key\n');
    const service = new EvaluationService(paths); await service.initializeRuntime();
    const before = await files(root), fetch = spyOn(globalThis, 'fetch');
    try {
      const smoke = await service.preflight({ datasetId: 'medclaw-agent-v1', selection: 'smoke' });
      expect(smoke).toMatchObject({ cases: 10, trials: 1, plannedTrials: 10, blockers: [] });
      expect(smoke.judgeRequestLimit).toBeGreaterThan(0); expect(smoke.judgeRequestLimit).toBeLessThanOrEqual(10);
      const full = await service.preflight({ datasetId: 'medclaw-agent-v1', selection: 'full', trials: 4 });
      expect(full).toMatchObject({ cases: 50, trials: 4, plannedTrials: 200, judgeRequestLimit: 116 });
      expect(JSON.stringify(full)).not.toContain('judge-private-key'); expect(JSON.stringify(full)).not.toContain('private-agent-config-key');
      const pending = await service.preflight({ datasetId: 'medclaw-badcase-v1', selection: 'full' });
      expect(pending.blockers.map(item => item.code)).toContain('dataset_review_pending');
      expect(fetch).not.toHaveBeenCalled(); expect(await files(root)).toEqual(before);
      await unlink(join(paths.configsRoot, 'agent.json'));
      expect((await service.preflight({ datasetId: 'medclaw-agent-v1', selection: 'smoke' })).blockers.map(item => item.code)).toContain('evaluation_config_unavailable');
    } finally { fetch.mockRestore(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

test('configuration or resource changes invalidate Check while module changes require restarting the app', async () => {
  const { EvaluationService } = await import('../../agent-eval/src/desktop/service');
  const { root, paths } = await fixture(), inventory = await doctor.sourceInventory();
  const source = spyOn(doctor, 'sourceInventory').mockResolvedValue(inventory);
  try {
    await mkdir(paths.configsRoot, { recursive: true });
    await writeFile(join(paths.configsRoot, 'agent.json'), JSON.stringify(runConfigFixture()));
    await writeFile(join(paths.configsRoot, 'environment'), 'MEDCLAW_JUDGE_BASE_URL=https://judge.example.invalid/v1\nMEDCLAW_JUDGE_MODEL=openai/gpt-4o-mini\nMEDCLAW_JUDGE_API_KEY=judge-private-key\n');
    const service = new EvaluationService(paths); await service.initializeRuntime();
    const check = await service.preflight({ datasetId: 'medclaw-agent-v1', selection: 'smoke' });
    const config = runConfigFixture(); config.policy = { timeoutMs: 1000 };
    await writeFile(join(paths.configsRoot, 'agent.json'), JSON.stringify(config));
    await expect(service.prepareRun({ datasetId: check.datasetId, selection: check.selection, trials: check.trials, preflightId: check.preflightId })).rejects.toThrow('config_conflict');
    const current = await service.preflight({ datasetId: 'medclaw-agent-v1', selection: 'smoke' });
    source.mockResolvedValue({ ...inventory, resources: { changed: 'reread material' } });
    await expect(service.prepareRun({ datasetId: current.datasetId, selection: current.selection, trials: current.trials, preflightId: current.preflightId })).rejects.toThrow('config_conflict');
    const next = await service.preflight({ datasetId: 'medclaw-agent-v1', selection: 'smoke' });
    expect(next.blockers).toEqual([]);
    source.mockResolvedValue({ ...inventory, files: { ...inventory.files as object, 'module.ts': 'changed' } });
    await expect(service.prepareRun({ datasetId: next.datasetId, selection: next.selection, trials: next.trials, preflightId: next.preflightId })).rejects.toThrow('evaluation_runtime_changed');
    await expect(service.preflight({ datasetId: 'medclaw-agent-v1', selection: 'smoke' })).rejects.toThrow('evaluation_runtime_changed');
    source.mockResolvedValue(inventory);
    await expect(service.preflight({ datasetId: 'medclaw-agent-v1', selection: 'smoke' })).rejects.toThrow('evaluation_runtime_changed');
    expect(await service.listReports({ page: 1, pageSize: 50 })).toMatchObject({ total: 0 });
  } finally { source.mockRestore(); await rm(root, { recursive: true, force: true }); }
}, 30000);

test('partial archives expose only recorded checks and preserve missing Trial and scoring gaps without writing reports', async () => {
  const { EvaluationService } = await import('../../agent-eval/src/desktop/service');
  const { readPartialExecution } = await import('../../agent-eval/src/reports/write');
  const { root, paths } = await fixture(), report = reportFixture();
  const archive = join(paths.runsRoot, 'business', report.executionId), trial = report.trials[0]!;
  try {
    await saveReportFixture(archive, report);
    report.snapshot.plan = [...report.plan, { ...report.plan[0]!, trialId: trial.caseId + '-r2', repetition: 2 }];
    await writeFile(join(archive, 'snapshot.json'), JSON.stringify(report.snapshot));
    await writeFile(join(archive, 'evidence', trial.trialId, 'events.jsonl'), JSON.stringify({ at: report.createdAt, kind: 'scoring.completed', value: { trialId: trial.trialId, scores: report.scores } }) + '\n');
    await unlink(join(archive, 'report.json'));
    const before = await files(root), service = new EvaluationService(paths);
    const partial = await readPartialExecution(archive);
    expect(partial.trials).toHaveLength(1); expect(partial.scores).toHaveLength(report.scores.length); expect(partial.gaps.length).toBeGreaterThan(0);
    expect(await service.listReports({ page: 1, pageSize: 50 })).toMatchObject({ items: [{ archiveState: 'partial', planned: 2, recorded: 1, quality: null, aggregation: null }] });
    expect(await service.readReportSection({ executionId: report.executionId, section: 'scores', page: 1, pageSize: 50 })).toMatchObject({ total: report.scores.length });
    await expect(service.compare(report.executionId, report.executionId)).rejects.toThrow();
    expect(await files(root)).toEqual(before);
    await writeFile(join(archive, 'evidence', trial.trialId, 'events.jsonl'), '{"kind":"scoring.completed"');
    expect((await readPartialExecution(archive)).scores).toEqual([]);
    const foreign = structuredClone(report.scores); foreign[0]!.caseId = 'foreign';
    await writeFile(join(archive, 'evidence', trial.trialId, 'events.jsonl'), JSON.stringify({ at: report.createdAt, kind: 'scoring.completed', value: { trialId: trial.trialId, scores: foreign } }) + '\n');
    expect((await readPartialExecution(archive)).scores).toEqual([]);
    await writeFile(join(archive, 'report.json'), '{');
    expect(await service.listReports({ page: 1, pageSize: 50 })).toMatchObject({ items: [{ archiveState: 'unreadable' }] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('evidence and feedback filters select original identities without hiding invalid feedback bindings', async () => {
  const { EvaluationService } = await import('../../agent-eval/src/desktop/service');
  const { aggregate } = await import('../../agent-eval/src/scoring/aggregate');
  const { root, paths } = await fixture(), report = reportFixture(), trial = report.trials[0]!;
  const archive = join(paths.runsRoot, 'business', report.executionId);
  trial.status = 'infra_error'; trial.instanceId = 'engineering-host'; trial.startedAt = report.createdAt; trial.endedAt = report.createdAt;
  trial.stopped = true; trial.closed = true; trial.observationRef = 'evidence/' + trial.trialId + '/observation.json';
  report.scores[0]!.evidenceRefs = ['query:42:page:1'];
  const aggregation = aggregate(report.plan, report.trials, report.scores, report.cases, report.snapshot.criteria as Parameters<typeof aggregate>[4]);
  report.aggregation = aggregation; report.totals = aggregation.totals;
  const observation = { executionId: report.executionId, trialId: trial.trialId, instanceId: trial.instanceId,
    observedFrom: report.createdAt, observedUntil: report.createdAt, identityChecks: [], missing: [], facts: {
      queryPages: [{ query: { id: 42, batchIds: [] }, page: { page: 1, rows: [{ value: 'selected-original' }] } },
        { query: { id: 99, batchIds: [] }, page: { page: 1, rows: [{ value: 'unrelated-original' }] } }], providerRequests: [{ key: 'private-provider-request' }],
    } };
  try {
    await saveReportFixture(archive, report, { [trial.trialId]: observation });
    const service = new EvaluationService(paths);
    const evidence = await service.readEvidence({ executionId: report.executionId, trialId: trial.trialId, evidenceRef: 'query:42:page:1' });
    expect(evidence.summary.text).toContain('selected-original'); expect(evidence.summary.text).not.toContain('unrelated-original');
    expect(evidence.summary.text).not.toContain('private-provider-request');
    await expect(service.readEvidence({ executionId: report.executionId, trialId: trial.trialId, evidenceRef: 'query:99:page:1' })).rejects.toThrow('access_denied');
    await service.recordLocalFeedback({ executionId: report.executionId, caseId: trial.caseId, trialId: trial.trialId, reviewer: 'Engineering reviewer', status: 'UNJUDGEABLE', comment: 'Original engineering review', evidenceRefs: [] }, crypto.randomUUID());
    const before = await readFile(join(archive, 'review.json'), 'utf8');
    expect(await service.readReportSection({ executionId: report.executionId, section: 'feedback', caseId: 'missing-case' })).toMatchObject({ total: 0, items: [] });
    expect(await service.readReportSection({ executionId: report.executionId, section: 'feedback', trialId: 'missing-trial' })).toMatchObject({ total: 0, items: [] });
    expect(await service.readReportSection({ executionId: report.executionId, section: 'feedback', caseId: trial.caseId, trialId: trial.trialId })).toMatchObject({ total: 1 });
    expect(await readFile(join(archive, 'review.json'), 'utf8')).toBe(before);
    await writeFile(join(archive, 'review.json'), JSON.stringify({ contract: 'medclaw-review/v1', executionId: report.executionId, conflicts: [], queues: {}, receipts: [],
      feedback: [{ id: 'feedback-1', value: { contract: 'medclaw-human-feedback/v1', source: 'local', sourceId: 'feedback-original', reviewedAt: report.createdAt,
        executionId: 'foreign', caseId: trial.caseId, trialId: trial.trialId, reviewer: 'Reviewer', status: 'PASS', comment: 'Actual review', evidenceRefs: [] } }] }));
    await expect(service.readReportSection({ executionId: report.executionId, section: 'feedback', caseId: 'missing-case' })).rejects.toThrow('feedback_identity_mismatch');
  } finally { await rm(root, { recursive: true, force: true }); }
});
