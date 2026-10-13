import { expect, test } from 'bun:test';
import { evaluate } from '../../src/scoring/evaluate.ts';
import type { CheckSpec } from '../../src/scoring/types.ts';

const conditions = { region: null, regions: ['浙江', '河南'], date: '2026-10-02', start: null, endExclusive: null, sourceDeviceId: null, manufacturer: null, category: null, status: null, snapshotMode: 'exact_date', threshold: null };
const check: CheckSpec = { id: 'conditions', metricId: 'query.conditions', version: 'v1', required: true, hardConstraint: true, kind: 'deterministic', unit: 'queries', goldKey: 'expected', evidenceKey: 'actual' };
const score = async (actual: unknown, expected: unknown = conditions) => (await evaluate({ trialId: 't', caseId: 'c', task: { checks: [check] }, gold: { expected }, observation: { facts: { actual }, identityChecks: [], missing: [] }, trialStatus: 'completed' }))[0]!;

test('multi-region conditions use unordered region identities while all other fields stay strict', async () => {
  expect(await score({ ...conditions, regions: ['河南', '浙江'] })).toMatchObject({ status: 'PASS', numerator: 1, denominator: 1 });
  expect(await score({ ...conditions, regions: ['浙江'] })).toMatchObject({ status: 'FAIL' });
  expect(await score({ ...conditions, regions: ['浙江', '河南', '陕西'] })).toMatchObject({ status: 'FAIL' });
  expect(await score({ ...conditions, regions: ['河南', '浙江'], date: '2026-10-01' })).toMatchObject({ status: 'FAIL' });
  expect(await score({ ...conditions, regions: ['河南', '浙江'], threshold: { operator: 'gt', percent: 5 } })).toMatchObject({ status: 'FAIL' });
});
test('duplicate or malformed region facts cannot pass; incomplete conditions stay unknown', async () => {
  expect(await score({ ...conditions, regions: ['浙江', '河南', '浙江'] })).toMatchObject({ status: 'FAIL' });
  expect(await score({ ...conditions, regions: [{}] })).toMatchObject({ status: 'FAIL' });
  expect(await score(conditions, { ...conditions, regions: ['浙江', '河南', '河南'] })).toMatchObject({ status: 'UNJUDGEABLE', value: null });
  const { date: _date, ...incomplete } = conditions;
  expect(await score(incomplete)).toMatchObject({ status: 'UNJUDGEABLE', value: null });
});
