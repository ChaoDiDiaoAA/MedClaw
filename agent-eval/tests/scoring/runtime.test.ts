import { expect, test } from 'bun:test';
import { evaluate } from '../../src/scoring/evaluate.ts';
import { exportedExact } from '../../src/scoring/runtime.ts';
import type { CheckSpec } from '../../src/scoring/types.ts';

const check = (metricId: string): CheckSpec => ({ id: metricId, metricId, version: 'v1', required: true, hardConstraint: false, kind: 'deterministic', unit: 'original units', goldKey: 'gold', evidenceKey: 'actual' });
const run = async (id: string, gold: unknown, actual: unknown) => (await evaluate({ trialId: 't', caseId: 'c', trialStatus: 'completed', task: { checks: [check(id)] }, gold: { gold }, observation: { facts: { actual }, missing: [], identityChecks: [] } }))[0]!;

test('correction count retains native input identities and active measured time without estimating missing time', async () => {
  const actual = { inputs: [{ inputId: 'i1', kind: 'initial', recordRef: 'input:i1' }, { inputId: 'i2', kind: 'correction', recordRef: 'input:i2' }], activeIntervals: [{ startMonoMs: 10, endMonoMs: 20, timerRef: 'timer' }] };
  expect(await run('efficiency.correction', {}, actual)).toMatchObject({ status: 'PASS', value: 1, numerator: 1, details: { activeMs: 10 } });
  expect(await run('efficiency.correction', {}, { ...actual, activeIntervals: undefined })).toMatchObject({ status: 'UNJUDGEABLE', value: null, numerator: 1, details: { activeMs: null } });
  expect(await run('efficiency.correction', {}, { ...actual, inputs: [...actual.inputs, actual.inputs[0]] })).toMatchObject({ status: 'UNJUDGEABLE' });
  expect(await run('efficiency.correction', {}, {})).toMatchObject({ status: 'UNJUDGEABLE' });
});
test('retry compliance uses original attempt lineage, recorded reasons and limits; hidden replay fails', async () => {
  const gold = { opportunities: [{ id: 'request', expected: { kind: 'provider', maxAttempts: 2, allowedReasons: ['confirmed_transient'] } }] };
  const actual = { opportunities: [{ id: 'request', actual: { logicalRequestId: 'logical', hiddenReplays: 0, attempts: [{ attemptId: 'a1', kind: 'provider', priorAttemptId: null, reason: 'initial', recordRef: 'native:a1' }, { attemptId: 'a2', kind: 'provider', priorAttemptId: 'a1', reason: 'confirmed_transient', recordRef: 'native:a2' }] }, evidenceRefs: ['native:a1', 'native:a2'] }] };
  expect(await run('efficiency.retries', gold, actual)).toMatchObject({ status: 'PASS', numerator: 1, denominator: 1 });
  actual.opportunities[0]!.actual.hiddenReplays = 1;
  expect(await run('efficiency.retries', gold, actual)).toMatchObject({ status: 'FAIL' });
  actual.opportunities[0]!.actual.hiddenReplays = 0; actual.opportunities[0]!.actual.attempts[1]!.priorAttemptId = 'unrelated';
  expect(await run('efficiency.retries', gold, actual)).toMatchObject({ status: 'FAIL' });
  expect(await run('efficiency.retries', gold, { opportunities: [{ id: 'request', actual: {}, evidenceRefs: ['native'] }] })).toMatchObject({ status: 'UNJUDGEABLE' });
});
test('coverage derives all planned check statuses, keeping missing and NOT_RUN in its denominator', async () => {
  const checks = [{ ...check('query.set_exact'), id: 'set', goldKey: 'set' }, { ...check('query.numeric'), id: 'numeric', goldKey: 'numeric', evidenceKey: 'missing' }, { ...check('coverage.judgeable'), required: false, goldKey: 'coverage' }];
  const scores = await evaluate({ trialId: 't', caseId: 'c', trialStatus: 'completed', task: { checks }, gold: { set: ['a'], numeric: [], coverage: { checkIds: ['set', 'numeric', 'planned-missing'] } }, observation: { facts: { actual: ['b'] }, identityChecks: [], missing: [] } });
  expect(scores[2]).toMatchObject({ numerator: 1, denominator: 3, value: 1 / 3, details: { missingCheckIds: ['planned-missing'] } });
});
test('export predicate compares independent rows, metadata and every file cell, not a claimed hash', () => {
  const gold = { rows: [{ key: 'A|2026-01-01', device: 'A', price: 0 }], sets: ['A@scope'], format: 'csv', sourceQueryAlias: 'turn:query:1', metadata: { snapshotMode: 'exact_date' } };
  const actual = { rows: gold.rows, sets: ['A@scope'], format: 'csv', sourceQueryAlias: 'turn:query:1', queryId: 1, artifactId: 2, columns: ['deviceId', 'priceCents'], fileRows: [['10', '0']], queryRows: [['10', '0']], metadata: { snapshotMode: 'exact_date' }, fileMetadata: { query: { id: 1 }, artifactId: 2 } };
  expect(exportedExact(gold, actual, check('export.exact'))).toMatchObject({ status: 'PASS', numerator: 1, denominator: 1 });
  expect(exportedExact(gold, { ...actual, fileRows: [['10', '']] }, check('export.exact'))).toMatchObject({ status: 'FAIL', details: { fileMatches: false } });
  expect(exportedExact({ ...gold, rows: [{ ...gold.rows[0], price: 1 }] }, actual, check('export.exact'))).toMatchObject({ status: 'FAIL', details: { rowsMatch: false } });
  expect(exportedExact(gold, {}, check('export.exact'))).toMatchObject({ status: 'UNJUDGEABLE' });
});
test('facility Judge requires archived independently verifiable reports, not inline pass claims', async () => {
  expect(await run('facility.judge', { maxFalseAccept: 0, maxFalseReject: 0, maxSevereMiss: 0 }, { passed: true })).toMatchObject({ status: 'UNJUDGEABLE' });
  expect(await run('facility.judge', { maxFalseAccept: 0, maxFalseReject: 0, maxSevereMiss: 0 }, { reportPath: 'does-not-exist.fixture.json' })).toMatchObject({ status: 'UNJUDGEABLE' });
});
