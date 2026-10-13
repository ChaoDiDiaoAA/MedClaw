import { describe, expect, test } from 'bun:test';
import { evaluate } from '../../src/scoring/evaluate.ts';
import { aggregate } from '../../src/scoring/aggregate.ts';
import { EvaluatorRegistry, registry, metricLedger } from '../../src/scoring/registry.ts';
import type { CheckSpec, EvaluationContext, EvaluationScore } from '../../src/scoring/types.ts';

const check = (metricId: string, extras: Partial<CheckSpec> = {}): CheckSpec => ({ id: metricId, metricId, version: 'v1', kind: 'deterministic', required: true, hardConstraint: false, unit: 'items', goldKey: 'expected', evidenceKey: 'actual', ...extras });
const context = (checks: CheckSpec[], expected: unknown, actual: unknown, trialStatus = 'completed'): EvaluationContext => ({ trialId: 't1', caseId: 'c1', task: { checks }, gold: { expected }, observation: { facts: { actual }, missing: [], identityChecks: [] }, trialStatus });
const score = async (id: string, gold: unknown, observed: unknown, extras: Partial<CheckSpec> = {}) => (await evaluate(context([check(id, extras)], gold, observed)))[0]!;

describe('registry and deterministic semantics', () => {
  test('keeps all 127 identities and all 23 new behavior identities unique', () => {
    expect(metricLedger).toHaveLength(127);
    expect(new Set(metricLedger.map(x => x.id)).size).toBe(127);
    expect(metricLedger.filter(x => x.behavior)).toHaveLength(23);
    expect(() => registry.get('unknown')).toThrow('Unknown metric');
    const entry = registry.get('query.numeric');
    expect(() => new EvaluatorRegistry([entry, entry])).toThrow('Duplicate metric');
  });

  test('set precision and recall use different original denominators; exact rejects duplicates', async () => {
    expect(await score('query.set_precision', ['a', 'b', 'c'], ['a', 'z'])).toMatchObject({ numerator: 1, denominator: 2, value: .5, status: 'FAIL' });
    expect(await score('query.set_recall', ['a', 'b', 'c'], ['a', 'z'])).toMatchObject({ numerator: 1, denominator: 3, value: 1 / 3 });
    expect(await score('query.set_exact', ['a'], ['a', 'a'])).toMatchObject({ value: 0, status: 'FAIL' });
    expect(await score('query.set_recall', [], [])).toMatchObject({ value: null, denominator: 0, applicable: false });
    expect(await score('query.set_exact', [], [])).toMatchObject({ value: 1, status: 'PASS' });
  });

  test('numeric checks units and tolerance and grouping counts extra groups', async () => {
    expect(await score('query.numeric', [{ id: 'a', value: 2, unit: 'CNY', tolerance: .01 }], [{ id: 'a', value: 2.005, unit: 'CNY' }])).toMatchObject({ status: 'PASS' });
    expect(await score('query.numeric', [{ id: 'a', value: 2, unit: 'CNY' }], [{ id: 'a', value: 2, unit: 'USD' }])).toMatchObject({ status: 'FAIL' });
    expect(await score('query.aggregate', [{ key: 'a', count: 2 }], [{ key: 'a', count: 2 }, { key: 'extra', count: 1 }])).toMatchObject({ numerator: 1, denominator: 2, value: .5 });
  });

  test('trend checks gap/date/value and diff checks old/new/type', async () => {
    expect(await score('query.trend', [{ date: '2026-01-01', gap: true, value: null }], [{ date: '2026-01-01', gap: false, value: 0 }])).toMatchObject({ status: 'FAIL' });
    expect(await score('diff.exact', [{ key: 'a', type: 'changed', old: 1, new: 2 }], [{ key: 'a', type: 'changed', old: 0, new: 2 }])).toMatchObject({ status: 'FAIL' });
  });



  test('missing evidence, unsupported semantics, not started, and failed task are distinct', async () => {
    expect(await score('query.numeric', [], undefined)).toMatchObject({ status: 'UNJUDGEABLE', value: null });
    expect(await score('provider.auth', true, true)).toMatchObject({ status: 'UNJUDGEABLE', value: null });
    expect((await evaluate(context([check('query.numeric')], [], [], 'not_run')))[0]).toMatchObject({ status: 'NOT_RUN', value: null });
    expect((await evaluate(context([check('task.success', { version: 'v1', unit: 'trials' })], {}, {}, 'failed')))[0]).toMatchObject({ status: 'FAIL', numerator: 0, denominator: 1 });
  });

  test('failed trial retains determinable hard failure and missing checks', async () => {
    const scores = await evaluate(context([check('query.set_exact', { hardConstraint: true }), check('query.numeric', { evidenceKey: 'missing' })], ['a'], ['b'], 'failed'));
    expect(scores.map(x => x.status)).toEqual(['FAIL', 'UNJUDGEABLE']);
  });

  test('infrastructure failure retains already verified hard security failure and genuine missing evidence', async () => {
    const c = context([check('security.gold', { hardConstraint: true }), check('query.numeric', { evidenceKey: 'missing' })], { canaries: ['GOLD'], forbiddenPaths: ['gold'] }, { coverageComplete: true, accessedPaths: ['gold'], inspected: [{ id: 'output', text: 'GOLD' }], evidenceRefs: ['audit'] }, 'infra_error');
    expect((await evaluate(c)).map(s => s.status)).toEqual(['FAIL', 'UNJUDGEABLE']);
    c.observation = null;
    expect((await evaluate(c)).map(s => s.status)).toEqual(['ERROR', 'ERROR']);
  });

  test('tool params uses original model params and preserves hook correction', async () => {
    const result = await score('tool.params', { opportunities: [{ id: 'call', expected: { parameters: { region: 'Henan' } } }] }, { opportunities: [{ id: 'call', actual: { originalParameters: { region: 'Shaanxi' }, finalParameters: { region: 'Henan' }, schemaValid: true, requestRef: 'raw', callId: 'call' }, evidenceRefs: ['raw'] }] }, { version: 'v1', unit: 'requests' });
    expect(result).toMatchObject({ status: 'FAIL', numerator: 0, denominator: 1 });
    expect(result.actual).toBeDefined();
  });

  test('negative behavior metrics count proven errors; unknown is not success', async () => {
    const gold = { opportunities: [{ id: 'claim', expected: { completed: false } }] };
    const actual = { opportunities: [{ id: 'claim', actual: { claimedComplete: true, completed: false, claimRef: 'answer', factRef: 'run' }, evidenceRefs: ['answer', 'run'] }] };
    expect(await score('task.false_completion', gold, actual, { version: 'v1', direction: 'lower' })).toMatchObject({ status: 'FAIL', numerator: 1, denominator: 1 });
    expect(await score('task.false_completion', gold, { opportunities: [] }, { version: 'v1', direction: 'lower' })).toMatchObject({ status: 'UNJUDGEABLE', numerator: null, denominator: 1 });
  });

  test('unplanned actual behavior is retained as an unknown opportunity, not ignored', async () => {
    const gold = { opportunities: [{ id: 'call', expected: { allowedReasons: ['verification'] } }] };
    const actual = { opportunities: [
      { id: 'call', actual: { newInformation: false, reason: 'verification', callId: 'call', beforeRef: 'before', resultRef: 'result' }, evidenceRefs: ['call'] },
      { id: 'extra', actual: { newInformation: false, reason: 'none', callId: 'extra', beforeRef: 'before', resultRef: 'result' }, evidenceRefs: ['extra'] },
    ] };
    expect(await score('tool.redundancy', gold, actual, { version: 'v1', direction: 'lower' })).toMatchObject({ status: 'UNJUDGEABLE', denominator: 2, value: null });
  });

  test('task success derives required checks without counting itself twice', async () => {
    const scores = await evaluate(context([check('query.set_exact'), check('task.success', { version: 'v1' })], ['a'], ['b']));
    expect(scores.at(-1)).toMatchObject({ metricId: 'task.success', status: 'FAIL', value: 0 });
  });

  test('duplicate check IDs cannot hide an ERROR behind an earlier passing score', async () => {
    const scores = await evaluate(context([check('query.set_exact'), check('query.set_exact')], ['a'], ['a']));
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ status: 'ERROR', value: null });
  });

  test('aggregation keeps planned repeats and sums original counts', async () => {
    const a = await score('query.set_precision', ['a', 'b', 'c'], ['a']);
    const b = { ...await score('query.set_precision', ['a', 'b', 'c'], ['a', 'z', 'y']), trialId: 't2' };
    const plan = [1, 2, 3].map(repetition => ({ trialId: `t${repetition}`, caseId: 'c1', repetition }));
    const summary = aggregate(plan, plan.slice(0, 2).map(x => ({ ...x, status: 'completed', startedAt: 'now' })), [a, b]);
    expect(summary.totals).toMatchObject({ planned: 3, pass: 1, fail: 1, notRun: 1 });
    expect(summary.cases[0]).toMatchObject({ allPass: false, planned: 3 });
    expect(summary.cases[0]!.first.trialId).toBe('t1');
    expect(summary.cases[0]!.repeats).toHaveLength(2);
    expect(summary.metrics[0]).toMatchObject({ numerator: 2, denominator: 4, value: .5 });
  });

  test('hard fail wins over missing required evidence in aggregate', async () => {
    const a = await score('query.set_exact', ['a'], ['b'], { hardConstraint: true });
    const b = { ...a, checkId: 'missing', status: 'UNJUDGEABLE', value: null, numerator: null, denominator: null } as EvaluationScore;
    expect(aggregate([{ trialId: 't1', caseId: 'c1', repetition: 1 }], [{ trialId: 't1', caseId: 'c1', repetition: 1, status: 'completed' }], [a, b]).trials[0]).toMatchObject({ status: 'FAIL' });
  });
});
