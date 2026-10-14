import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportFixture, saveReportFixture } from './report-fixture.ts';
import { aggregate } from '../src/scoring/aggregate.ts';
import { reviewCandidates } from '../src/review/candidates.ts';
import { assessCalibration } from '../src/scoring/judges/calibration.ts';
import { JudgeConfigurationSchema, type EvaluationReport } from '../src/types.ts';
import { cases } from '../src/datasets/medclaw-agent-v1.ts';

const module = () => import('../src/reports/badcases.ts');
const at = '2026-10-13T00:00:00.000Z';
const withRoot = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'mc-badcases-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
};
function healthy() {
  const report = reportFixture(), trial = report.trials[0]!;
  Object.assign(trial, { status: 'completed', instanceId: 'controlled-host', startedAt: at, endedAt: at, reason: null, stopped: true, closed: true, observationRef: `evidence/${trial.trialId}/observation.json` });
  for (const score of report.scores) Object.assign(score, score.method === 'llm-judge'
    ? { applicable: false, status: 'UNJUDGEABLE', reason: 'Not applicable in this engineering fixture', denominator: 0 }
    : { status: 'PASS', value: 1, numerator: 1, denominator: 1, reason: 'Controlled passing result' });
  return report;
}
function recount(report: EvaluationReport) {
  report.aggregation = aggregate(report.plan, report.trials, report.scores, report.cases, report.snapshot.criteria as { id: string; dimension: string }[]);
  report.totals = (report.aggregation as ReturnType<typeof aggregate>).totals;
  report.reviewCandidates = reviewCandidates(report.snapshot.dataset.info.reviewPolicy, report.trials.map(trial => ({ ...trial, risks: [], scores: report.scores.filter(score => score.trialId === trial.trialId) })));
}
async function save(root: string, report = healthy(), facts: Record<string, unknown> = {}) {
  recount(report);
  const observations = Object.fromEntries(report.trials.filter(trial => trial.observationRef).map(trial => [trial.trialId, {
    executionId: report.executionId, trialId: trial.trialId, instanceId: trial.instanceId, observedFrom: at, observedUntil: at,
    identityChecks: [{ id: 'engineering-owner', passed: true, reason: 'Controlled identity' }], facts, missing: [],
  }]));
  return saveReportFixture(root, report, observations);
}
const failingHistory = () => [{ selector: { kind: 'history', runId: 1, sessionId: 1 }, protocolValidated: true, ownerInstanceId: 'controlled-host', original: {
  sessionId: 1, entries: [{ id: 'native-1', type: 'message', message: { role: 'assistant', stopReason: 'error', errorMessage: '402 {"error":{"message":"Insufficient Balance"}} SECRET-native-body' } }],
} }];
function expectedCancellation() {
  const report = healthy();
  report.snapshot.dataset.cases[0]!.input.turns = structuredClone(cases.find(task => task.id === 'mc-v1-subagent-cancel')!.input.turns);
  const facts = {
    aliases: { source: 'controller-accepted-public-identities', runs: [{ alias: 'turn-1', runId: 17 }] },
    runs: [
      { id: 17, kind: 'agent', sessionId: 1, status: 'cancelled', cancelRequestedAt: at, error: null, parentRunId: null, originToolCallId: null },
      { id: 18, kind: 'child', sessionId: 2, status: 'cancelled', cancelRequestedAt: at, error: null, parentRunId: 17, originToolCallId: 7 },
    ],
    modelCalls: [{ runId: 17, sessionId: 1, callId: 'parent-call', kind: 'main', state: 'cancelled', error: null }, { runId: 18, sessionId: 2, callId: 'child-call', kind: 'main', state: 'cancelled', error: null }],
    toolCalls: [{ id: 7, runId: 17, sessionId: 1, name: 'Agent', status: 'cancelled', error: { code: 'tool_cancelled' } }, { id: 8, runId: 18, sessionId: 2, name: 'query_data', status: 'cancelled', error: { code: 'tool_cancelled' } }],
    operations: [{ kind: 'compaction', sessionId: 1, status: 'cancelled', error: null, operationRef: 'cancelled-compaction', receipt: { runId: 17, sessionId: 1, status: 'cancelled' } }],
  };
  return { report, facts };
}
async function calibration(root: string, matchReferences = false) {
  const judge = JudgeConfigurationSchema.parse({ baseUrl: 'https://judge.example.invalid/v1', model: 'fixture-judge' });
  const samples = ['tune-good', 'validation-bad', 'validation-good'].map((id, i) => ({ id, sourceId: `source-${id}`, partition: i === 0 ? 'tune' as const : 'validation' as const, answer: 'SECRET-answer', rubric: 'SECRET-rubric', evidence: { [`source-${id}`]: `SECRET-evidence-${id}` } }));
  const results = [];
  for (const [i, sample] of samples.entries()) {
    const reference = { checker: 'independent agent', method: 'agent-audit', checkedAt: at, recordRef: `evidence/${sample.id}/trial.json`, sourceRef: sample.sourceId, value: i === 1 ? 0 : 1, severe: i === 1, evidenceRefs: [sample.sourceId] };
    const request = { trialId: sample.id, checks: [{ checkId: sample.id, rubric: sample.rubric, evidenceRefs: [sample.sourceId] }], answer: sample.answer, evidence: sample.evidence };
    const judgeValue = matchReferences ? reference.value : 1;
    const result = { status: 'completed', results: [{ checkId: sample.id, value: judgeValue, reason: 'SECRET-judge-body', evidenceRefs: [sample.sourceId] }], error: null, metadata: { ...judge, startedAt: at, endedAt: at, durationMs: 0, httpStatus: 200, requestId: null, usage: { promptTokens: null, completionTokens: null } } };
    const base = join(root, 'evidence', sample.id); await mkdir(base, { recursive: true });
    await writeFile(join(base, 'trial.json'), JSON.stringify({ sample, reference, request }));
    await writeFile(join(base, 'observation.json'), JSON.stringify({ request, result }));
    await writeFile(join(base, 'events.jsonl'), [{ kind: 'judge.request', at, request }, { kind: 'judge.result', at, result }].map(value => JSON.stringify(value)).join('\n') + '\n');
    results.push({ id: sample.id, sourceId: sample.sourceId, partition: sample.partition, reference, judgeValue, judgeEvidenceRefs: [sample.sourceId] });
  }
  const limits = { maxFalseAccept: 0, maxFalseReject: 0, maxSevereMiss: 0 }, assessment = assessCalibration(results, limits);
  await writeFile(join(root, 'snapshot.json'), JSON.stringify({ contract: 'medclaw-calibration-snapshot/v1', executionId: 'calibration-fixture', rubricVersion: 'v1', systemRubric: judge.systemRubric, judge, limits, model: judge.model, samples }));
  await writeFile(join(root, 'report.json'), JSON.stringify({ contract: 'medclaw-judge-calibration/v1', executionId: 'calibration-fixture', actualRun: false, controlledFixture: true, createdAt: at, model: judge.model, assessment, passed: assessment.passed }));
}

test('badcase derivation exposes a read-only archive API', async () => {
  expect(await module().then(value => typeof value.deriveBadcases, () => 'missing')).toBe('function');
});

test('candidate identities and score facts preserve archived results without echoing private values', async () => withRoot(async root => {
  const report = healthy(), score = report.scores.find(score => score.metricId === 'query.numeric')!;
  Object.assign(score, { status: 'FAIL', value: 0, numerator: 0, actual: 'SECRET-actual', expected: report.snapshot.compiled[score.caseId]!.values.query_numeric, reason: 'SECRET-score-reason', evidenceRefs: ['tool:7'] });
  await save(root, report, { input: 'SECRET-input', output: 'SECRET-output' });
  const { deriveBadcases, renderBadcases } = await module(), before = await readFile(join(root, 'report.json'), 'utf8');
  const index = await deriveBadcases(join(root, 'report.json')), candidate = index.candidates[0]!;
  expect(index).toMatchObject({ contract: 'medclaw-badcase-index/v1', executionId: report.executionId, kind: 'evaluation', summary: { candidates: 1, signals: 1, trials: 1, samples: 0, cases: 1, commonEvents: 0 } });
  expect(candidate).toMatchObject({ caseId: score.caseId, trialId: score.trialId, sampleId: null, checkIds: [score.checkId] });
  expect(candidate.signals).toContain('score_fail'); expect(candidate.statuses).toContain('FAIL');
  expect(candidate.evidenceRefs).toContainEqual({ path: 'report.json', pointer: `/scores/${report.scores.indexOf(score)}` });
  expect(candidate.feedbackRefs).toEqual([]);
  expect(JSON.stringify(index) + renderBadcases(index)).not.toContain('SECRET-');
  expect(await readFile(join(root, 'report.json'), 'utf8')).toBe(before);
  expect((await readdir(root)).sort()).toEqual(['evidence', 'report.json', 'snapshot.json']);
}));

test('inapplicable results and Judge not called are not execution failures', async () => withRoot(async root => {
  const report = healthy(), judge = report.scores.find(score => score.method === 'llm-judge')!;
  Object.assign(judge, { applicable: true, status: 'NOT_RUN', denominator: null, reason: 'Independent Judge is disabled or not configured' });
  await save(root, report);
  const index = await (await module()).deriveBadcases(root);
  expect(index.candidates).toEqual([]);
}));

test('an unjudgeable check does not assert that the archive itself lacks evidence', async () => withRoot(async root => {
  const report=healthy(),score=report.scores.find(score=>score.metricId==='query.numeric')!;
  Object.assign(score,{status:'UNJUDGEABLE',value:null,numerator:null,denominator:null,missing:[],reason:'The scorer cannot represent this independently verified condition.'});
  await save(root,report);
  const candidate=(await (await module()).deriveBadcases(root)).candidates[0]!;
  expect(candidate.signals).toContain('score_unjudgeable');
  expect(candidate.gaps.some(gap=>gap.includes('scorer support'))).toBe(true);
  expect(candidate.gaps.join(' ')).not.toContain('Recorded evidence is insufficient');
}));

test('plain NOT_RUN stays absent but an actual interrupted execution is a blocked candidate', async () => withRoot(async root => {
  const plain = join(root, 'plain'), blocked = join(root, 'blocked');
  await saveReportFixture(plain);
  const report = reportFixture(); report.trials[0]!.reason = 'previous_trial_stop_or_save_unconfirmed';
  await saveReportFixture(blocked, report);
  const { deriveBadcases } = await module();
  expect((await deriveBadcases(plain)).summary.candidates).toBe(0);
  const index = await deriveBadcases(blocked);
  expect(index.candidates[0]!.signals).toContain('execution_blocked');
  expect(index.candidates[0]!.statuses).toContain('NOT_RUN');
}));

test('PASS trials retain unexpected recovered tool failures and explicit status inconsistency', async () => withRoot(async root => {
  await save(root, healthy(), { toolCalls: [
    { id: 1, name: 'query_data', runId: 1, status: 'failed', error: { code: 'tool_timeout', message: 'SECRET-tool' } },
    { id: 2, name: 'query_data', runId: 1, status: 'succeeded', error: null },
  ], aliases: { source: 'controller-accepted-public-identities', lastSendAlias: 'final', runs: [{ alias: 'final', runId: 1 }] },
  runs: [{ id: 1, kind: 'agent', status: 'failed', error: { code: 'provider_request_failed', message: 'SECRET-run' } }] });
  const index = await (await module()).deriveBadcases(root), candidate = index.candidates[0]!;
  expect(candidate.signals).toContain('recovered_failure');
  expect(candidate.signals).toContain('status_inconsistency');
  expect(candidate.statuses).toContain('PASS');
  expect(candidate.evidenceRefs).toContainEqual({ path: `evidence/${candidate.trialId}/observation.json`, pointer: '/facts/toolCalls/0' });
  expect(JSON.stringify(index)).not.toContain('SECRET-');
}));

test('an earlier failed Run followed by a completed final bound Run is not a status contradiction', async () => withRoot(async root => {
  await save(root, healthy(), {
    aliases: { source: 'controller-accepted-public-identities', lastSendAlias: 'final', runs: [{ alias: 'first', runId: 1 }, { alias: 'final', runId: 2 }] },
    runs: [{ id: 1, kind: 'agent', status: 'failed', error: { code: 'provider_request_failed' } }, { id: 2, kind: 'agent', status: 'completed', error: null }],
  });
  const candidate = (await (await module()).deriveBadcases(root)).candidates[0]!;
  expect(candidate.signals).toContain('observed_failure');
  expect(candidate.signals).not.toContain('status_inconsistency');
}));

test('a missing final Run identity leaves a consistency gap instead of an invented contradiction', async () => withRoot(async root => {
  await save(root, healthy(), { runs: [{ id: 1, kind: 'agent', status: 'failed', error: { code: 'provider_request_failed' } }] });
  const candidate = (await (await module()).deriveBadcases(root)).candidates[0]!;
  expect(candidate.signals).toContain('observed_failure');
  expect(candidate.signals).not.toContain('status_inconsistency');
  expect(candidate.gaps.join(' ')).toContain('final Run identity');
}));

test('authored expected faults do not become recovered-failure badcases', async () => withRoot(async root => {
  const report = healthy(); report.snapshot.dataset.cases[0]!.expected.expectedFailureMode = 'tool_timeout';
  await save(root, report, { toolCalls: [{ id: 1, name: 'query_data', status: 'failed', error: { code: 'tool_timeout' } }, { id: 2, name: 'query_data', status: 'succeeded' }] });
  expect((await (await module()).deriveBadcases(root)).candidates).toEqual([]);
}));

test('authored cancellation suppresses only its proven parent and child cancellation records', async () => withRoot(async root => {
  const { report, facts } = expectedCancellation(); await save(root, report, facts);
  expect((await (await module()).deriveBadcases(root)).candidates).toEqual([]);
}));

test('unexpected, unbound or erroneous cancellations remain badcase signals', async () => withRoot(async root => {
  const { deriveBadcases } = await module();
  for (const scenario of ['no-authored-cancel', 'wrong-alias', 'missing-owner', 'unrelated-child', 'actual-error', 'failed-status'] as const) {
    const { report, facts } = expectedCancellation();
    if (scenario === 'no-authored-cancel') delete report.snapshot.dataset.cases[0]!.input.turns;
    if (scenario === 'wrong-alias') facts.aliases.runs[0]!.runId = 99;
    if (scenario === 'missing-owner') Reflect.deleteProperty(facts.modelCalls[1]!, 'runId');
    if (scenario === 'unrelated-child') facts.runs[1]!.parentRunId = 99;
    if (scenario === 'actual-error') Object.assign(facts.modelCalls[1]!, { error: { code: 'provider_request_failed' } });
    if (scenario === 'failed-status') facts.toolCalls[1]!.status = 'failed';
    const path = join(root, scenario); await save(path, report, facts);
    expect((await deriveBadcases(path)).candidates[0]!.signals).toContain('observed_failure');
  }
}));

test('a cancelled Trial execution remains a candidate even when its Case authors cancellation', async () => withRoot(async root => {
  const { report, facts } = expectedCancellation(); report.trials[0]!.status = 'cancelled';
  await save(root, report, facts);
  expect((await (await module()).deriveBadcases(root)).candidates[0]!.signals).toContain('execution_failure');
}));

test('one common native balance event has separate candidate, trial and case counts', async () => withRoot(async root => {
  const report = healthy(), first = report.trials[0]!, secondId = first.trialId + '-repeat';
  report.plan.push({ trialId: secondId, caseId: first.caseId, repetition: 2 });
  report.trials.push({ ...first, trialId: secondId, repetition: 2, observationRef: `evidence/${secondId}/observation.json` });
  report.scores.push(...report.scores.map(score => ({ ...score, trialId: secondId, scope: { ...score.scope, ref: secondId } })));
  await save(root, report, { nativeHistory: failingHistory() });
  const index = await (await module()).deriveBadcases(root);
  expect(index.summary).toEqual({ candidates: 2, signals: 2, trials: 2, samples: 0, cases: 1, commonEvents: 1 });
  expect(index.commonEvents[0]!.candidateIds).toHaveLength(2);
  expect(index.candidates.every(candidate => candidate.commonEventIds.length === 1)).toBe(true);
  expect(JSON.stringify(index)).not.toContain('SECRET-');
}));

test('normalized compaction errors remain an evidence gap instead of a raw HTTP 402 claim', async () => withRoot(async root => {
  await save(root, healthy(), { modelCalls: [{ callId: 'compaction-call', kind: 'compaction', state: 'failed', error: { code: 'compaction_failed', reason: 'compaction_model_failed' } }] });
  const index = await (await module()).deriveBadcases(root);
  expect(index.candidates[0]!.suspectedNodes).toContain('compaction');
  expect(index.commonEvents).toEqual([]);
  expect(index.candidates[0]!.gaps.join(' ')).toContain('provider');
  expect(JSON.stringify(index)).not.toContain('402');
}));

test('balance symptoms from different recorded providers remain separate common events', async () => withRoot(async root => {
  const histories = failingHistory();
  const second = structuredClone(histories[0]!);
  Object.assign(histories[0]!.original.entries[0]!.message, { provider: 'provider-a', model: 'model-a' });
  Object.assign(second.original.entries[0]!.message, { provider: 'provider-b', model: 'model-b' });
  await save(root, healthy(), { nativeHistory: [...histories, second] });
  const index = await (await module()).deriveBadcases(root);
  expect(index.summary.commonEvents).toBe(2);
  expect(new Set(index.commonEvents.map(event => event.id)).size).toBe(2);
  expect(index.candidates[0]!.commonEventIds).toHaveLength(2);
}));

test('unowned model records cannot establish a recovered failure', async () => withRoot(async root => {
  await save(root, healthy(), { modelCalls: [{ kind: 'main', state: 'failed', error: { code: 'provider_request_failed' } }, { kind: 'main', state: 'completed', error: null }] });
  const candidate = (await (await module()).deriveBadcases(root)).candidates[0]!;
  expect(candidate.signals).toContain('observed_failure');
  expect(candidate.signals).not.toContain('recovered_failure');
}));

test('failure identities come only from cited records and retain the original Run, call and operation IDs', async () => withRoot(async root => {
  await save(root, healthy(), {
    runs: [{ id: 17, status: 'failed', error: { code: 'provider_request_failed' } }, { id: 99, status: 'completed', error: null }],
    modelCalls: [{ runId: 17, callId: 'original-model-call', kind: 'compaction', operationRef: 'original-operation', state: 'failed', error: { code: 'compaction_failed' } }, { runId: 99, callId: 'unrelated-success', kind: 'main', state: 'completed', error: null }],
    toolCalls: [{ runId: 17, modelCallId: 'original-model-call', name: 'query_data', status: 'failed', error: { code: 'tool_timeout' } }],
    operations: [{ operationRef: 'original-operation', kind: 'compaction', status: 'failed', error: { code: 'compaction_failed' } }],
  });
  const { deriveBadcases, renderBadcases } = await module(), index = await deriveBadcases(root), candidate = index.candidates[0]!;
  expect(candidate.runIds).toEqual([17]);
  expect(candidate.callIds).toEqual(['original-model-call']);
  expect(candidate.operationRefs).toEqual(['original-operation']);
  const markdown = renderBadcases(index);
  expect(markdown).toContain('model calls original\\-model\\-call'); expect(markdown).toContain('operations original\\-operation');
  expect(markdown).not.toContain('unrelated\\-success');
}));

test('only real feedback creates disagreement and feedback paths are never dereferenced', async () => withRoot(async root => {
  const report = healthy(), trial = report.trials[0]!;
  await save(root, report);
  const { deriveBadcases } = await module(); expect((await deriveBadcases(root)).candidates).toEqual([]);
  await writeFile(join(root, 'review.json'), JSON.stringify({ contract: 'medclaw-review/v1', executionId: report.executionId, feedback: [{ id: 'actual-review', value: {
    contract: 'medclaw-human-feedback/v1', source: 'local', sourceId: 'review-source', reviewer: '<script>SECRET-reviewer</script>', reviewedAt: at,
    executionId: report.executionId, caseId: trial.caseId, trialId: trial.trialId, status: 'FAIL', comment: 'SECRET-comment', evidenceRefs: ['../../private-feedback', 'https://example.invalid/private'],
  } }], conflicts: [], queues: {}, receipts: [] }));
  const index = await deriveBadcases(root), candidate = index.candidates[0]!;
  expect(candidate.signals).toContain('human_disagreement');
  expect(candidate.feedbackRefs).toEqual([{ path: 'review.json', pointer: '/feedback/0' }]);
  expect(candidate.gaps.join(' ')).toContain('feedback');
  expect(JSON.stringify(index)).not.toContain('SECRET-');
  expect(JSON.stringify(index)).not.toContain('../');
}));

test('comparable regression uses original scores and incompatible baselines create a comparison gap', async () => withRoot(async root => {
  const baseline = join(root, 'baseline'), candidate = join(root, 'candidate'), other = join(root, 'other');
  await save(baseline);
  const changed = healthy(); Object.assign(changed.scores.find(score => score.metricId === 'query.numeric')!, { status: 'FAIL', value: 0, numerator: 0 }); await save(candidate, changed);
  const incompatible = healthy(); incompatible.config.model.model = 'other-model'; await save(other, incompatible);
  const { deriveBadcases } = await module();
  expect((await deriveBadcases(candidate, baseline)).candidates[0]!.signals).toContain('comparable_regression');
  const gap = await deriveBadcases(other, baseline);
  expect(gap.comparison?.status).toBe('incompatible'); expect(gap.gaps.join(' ')).toContain('comparison');
  expect(gap.candidates).toEqual([]);
}));

test('failed calibration preserves sample identity and does not call or echo Judge data', async () => withRoot(async root => {
  await calibration(root);
  const { deriveBadcases } = await module(), index = await deriveBadcases(root), candidate = index.candidates[0]!;
  expect(index).toMatchObject({ kind: 'calibration', summary: { candidates: 1, trials: 0, samples: 1, cases: 0, commonEvents: 0 } });
  expect(candidate).toMatchObject({ sampleId: 'validation-bad', caseId: null, trialId: null, runIds: [], callIds: [], operationRefs: [] });
  expect(candidate.signals).toContain('calibration_disagreement');
  expect(candidate.feedbackRefs).toEqual([]);
  expect(candidate.facts.join(' ')).toContain('agent-audit');
  expect(JSON.stringify(index)).not.toContain('SECRET-');
  const observationPath = join(root, 'evidence/validation-bad/observation.json'), observation = JSON.parse(await readFile(observationPath, 'utf8'));
  observation.result.results[0].checkId = 'foreign'; await writeFile(observationPath, JSON.stringify(observation));
  await expect(deriveBadcases(root)).rejects.toThrow('calibration');
}));

test('calibration assessment cannot contradict its archived reference and Judge results', async () => withRoot(async root => {
  await calibration(root);
  const path = join(root, 'report.json'), report = JSON.parse(await readFile(path, 'utf8'));
  report.assessment.falseAccept = 0; await writeFile(path, JSON.stringify(report));
  await expect((await module()).deriveBadcases(root)).rejects.toThrow('calibration_assessment');
}));

test('invalid report identities and actual escaped or linked archive paths fail closed', async () => withRoot(async root => {
  const archive = join(root, 'archive'); await save(archive);
  const { deriveBadcases } = await module(), path = join(archive, 'report.json'), original = await readFile(path, 'utf8');
  const raw = JSON.parse(original); raw.executionId = 'foreign'; await writeFile(path, JSON.stringify(raw));
  await expect(deriveBadcases(archive)).rejects.toThrow();
  await writeFile(path, original);
  const escaped = JSON.parse(original); escaped.evidenceManifest.push({ path: '../outside.json', sensitivity: 'private', bytes: 2 });
  await writeFile(join(root, 'outside.json'), '{}'); await writeFile(path, JSON.stringify(escaped));
  await expect(deriveBadcases(archive)).rejects.toThrow();
  await writeFile(path, original);
  const evidence = join(archive, 'evidence'), moved = join(root, 'outside-evidence');
  await mkdir(moved); await rm(evidence, { recursive: true }); await symlink(moved, evidence, 'junction');
  await expect(deriveBadcases(archive)).rejects.toThrow('linked_evidence');
}));

test('a linked archive root is rejected before reading through it', async () => withRoot(async root => {
  const archive = join(root, 'archive'), linked = join(root, 'linked'); await save(archive);
  await symlink(archive, linked, 'junction');
  await expect((await module()).deriveBadcases(linked)).rejects.toThrow('linked_execution_archive');
}));

test('Markdown is deterministic, escapes user text and links only safe relative evidence', async () => withRoot(async root => {
  const report = healthy(); Object.assign(report.scores[0]!, { status: 'FAIL', value: 0, numerator: 0 }); await save(root, report);
  const { deriveBadcases, renderBadcases } = await module(), index = await deriveBadcases(root);
  index.candidates[0]!.facts.push('<img src=x onerror=alert(1)> [click](https://example.invalid) | new\n# heading');
  const markdown = renderBadcases(index);
  expect(markdown).toBe(renderBadcases(index));
  expect(markdown).not.toContain('<img'); expect(markdown).not.toContain('[click](https://');
  expect(markdown).toContain('(report.json#');
}));

test('writing derived files is idempotent, rejects conflicts and leaves originals unchanged', async () => withRoot(async root => {
  const report = healthy(); Object.assign(report.scores[0]!, { status: 'ERROR', value: null, numerator: null }); await save(root, report);
  const originals = ['report.json', 'snapshot.json', `evidence/${report.trials[0]!.trialId}/trial.json`, report.trials[0]!.observationRef!];
  const before = await Promise.all(originals.map(path => readFile(join(root, path), 'utf8')));
  const { writeBadcases, renderBadcases } = await module(), index = await writeBadcases(root);
  expect(JSON.parse(await readFile(join(root, 'badcases.json'), 'utf8'))).toEqual(index);
  expect(await readFile(join(root, 'badcases.md'), 'utf8')).toBe(renderBadcases(index));
  expect(await writeBadcases(root)).toEqual(index);
  await writeFile(join(root, 'badcases.md'), 'user-owned conflict');
  await expect(writeBadcases(root)).rejects.toThrow('badcases_output_conflict');
  expect(await readFile(join(root, 'badcases.md'), 'utf8')).toBe('user-owned conflict');
  expect(await Promise.all(originals.map(path => readFile(join(root, path), 'utf8')))).toEqual(before);
}));

test('an empty evaluation diagnosis creates no files and preserves existing historical diagnostics', async () => withRoot(async root => {
  await save(root);
  const before = await readdir(root), original = await readFile(join(root, 'report.json'), 'utf8');
  const { writeBadcases, renderBadcases } = await module(), index = await writeBadcases(root);
  expect(index).toMatchObject({ kind: 'evaluation', candidates: [], commonEvents: [], gaps: [] });
  expect(await readdir(root)).toEqual(before);
  const json = JSON.stringify(index, null, 2) + '\n', markdown = renderBadcases(index);
  await writeFile(join(root, 'badcases.json'), json); await writeFile(join(root, 'badcases.md'), markdown);
  await writeBadcases(root);
  expect(await readFile(join(root, 'badcases.json'), 'utf8')).toBe(json);
  expect(await readFile(join(root, 'badcases.md'), 'utf8')).toBe(markdown);
  expect(await readFile(join(root, 'report.json'), 'utf8')).toBe(original);
}));

for (const missingJournal of [false, true]) test(`calibration ${missingJournal ? 'gap-only diagnosis is saved' : 'empty diagnosis creates no files'} without business Trial identities`, async () => withRoot(async root => {
  await calibration(root, true);
  if (missingJournal) await rm(join(root, 'evidence/validation-good/events.jsonl'));
  const before = await readdir(root), original = await readFile(join(root, 'report.json'), 'utf8');
  const { writeBadcases, renderBadcases } = await module(), index = await writeBadcases(root);
  expect(index).toMatchObject({ kind: 'calibration', candidates: [], commonEvents: [], summary: { trials: 0, samples: 0, cases: 0 } });
  if (missingJournal) {
    expect(index.gaps).toHaveLength(1);
    expect(index.gaps[0]).toContain('validation-good');
    expect(JSON.parse(await readFile(join(root, 'badcases.json'), 'utf8'))).toEqual(index);
    expect(await readFile(join(root, 'badcases.md'), 'utf8')).toBe(renderBadcases(index));
  } else {
    expect(index.gaps).toEqual([]);
    expect(await readdir(root)).toEqual(before);
  }
  expect(await readFile(join(root, 'report.json'), 'utf8')).toBe(original);
}));

test('derived writer rejects linked outputs and reports new filesystem write failures', async () => withRoot(async root => {
  const archive = join(root, 'archive'), report = healthy();
  Object.assign(report.scores[0]!, { status: 'ERROR', value: null, numerator: null }); await save(archive, report);
  const { writeBadcases } = await module(), outside = join(root, 'outside'); await mkdir(outside);
  await symlink(outside, join(archive, 'badcases.json'), 'junction');
  await expect(writeBadcases(archive)).rejects.toThrow('linked_evidence');
  expect(await readdir(outside)).toEqual([]);
  await rm(join(archive, 'badcases.json'));
  await mkdir(join(archive, 'badcases.md'));
  await expect(writeBadcases(archive)).rejects.toThrow();
  expect(await readdir(join(archive, 'badcases.md'))).toEqual([]);
}));

test('matching derived files refresh after genuine new feedback without changing the source report', async () => withRoot(async root => {
  const report = healthy(), trial = report.trials[0]!; await save(root, report);
  const { writeBadcases } = await module(), original = await readFile(join(root, 'report.json'), 'utf8');
  expect((await writeBadcases(root)).summary.candidates).toBe(0);
  expect(await readdir(root)).not.toContain('badcases.json');
  await writeFile(join(root, 'review.json'), JSON.stringify({ contract: 'medclaw-review/v1', executionId: report.executionId, feedback: [{ id: 'new-review', value: {
    contract: 'medclaw-human-feedback/v1', source: 'local', sourceId: 'new-review', reviewer: 'reviewer', reviewedAt: at,
    executionId: report.executionId, caseId: trial.caseId, trialId: trial.trialId, status: 'FAIL', comment: 'Actual independent disagreement', evidenceRefs: [],
  } }], conflicts: [], queues: {}, receipts: [] }));
  expect((await writeBadcases(root)).summary.candidates).toBe(1);
  expect(await readFile(join(root, 'report.json'), 'utf8')).toBe(original);
}));
