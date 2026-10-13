import { isDeepStrictEqual } from 'node:util';
import type { CheckSpec, RuleResult } from './types.ts';

export const record = (x: unknown): x is Record<string, any> => x !== null && typeof x === 'object' && !Array.isArray(x);
export const equal = isDeepStrictEqual;
export const unknown = (reason: string, denominator: number | null = null): RuleResult => ({ status: 'UNJUDGEABLE', value: null, numerator: null, denominator, reason, missing: [reason] });
export const unavailable = (): RuleResult => unknown('Native evidence semantics for this metric are not implemented; identity retained in ledger');
export function ratio(numerator: number, denominator: number, check: CheckSpec, details?: unknown): RuleResult {
  if (denominator === 0) return { status: 'UNJUDGEABLE', value: null, numerator, denominator, applicable: false, reason: 'Zero applicable denominator', details };
  const value = numerator / denominator;
  const lower = check.direction === 'lower';
  const pass = lower ? value <= (check.threshold ?? 0) : value >= (check.threshold ?? 1);
  return { status: pass ? 'PASS' : 'FAIL', value, numerator, denominator, reason: pass ? 'Declared criterion satisfied' : 'Declared criterion violated', details };
}
const scalars = (x: unknown): x is (string | number | boolean | null)[] => Array.isArray(x) && x.every(y => y === null || typeof y === 'string' || typeof y === 'boolean' || typeof y === 'number' && Number.isFinite(y));
export function setRule(mode: 'precision' | 'recall' | 'exact', expected: unknown, actual: unknown, check: CheckSpec): RuleResult {
  if (!scalars(expected) || !scalars(actual)) return unknown('Expected and actual sets must contain scalar identities');
  const gold = new Set(expected), predicted = new Set(actual);
  if (gold.size !== expected.length) return unknown('Gold set contains duplicate identities');
  const tp = [...predicted].filter(x => gold.has(x)).length;
  const details = { tp, fp: predicted.size - tp, fn: gold.size - tp, duplicatePredictions: actual.length - predicted.size };
  return mode === 'exact' ? ratio(Number(details.fp === 0 && details.fn === 0 && details.duplicatePredictions === 0), 1, check, details) : ratio(tp, mode === 'precision' ? predicted.size : gold.size, check, details);
}
export function keyedRule(expected: unknown, actual: unknown, check: CheckSpec, key: string, fields: string[], numeric = false): RuleResult {
  if (!Array.isArray(expected) || !Array.isArray(actual)) return unknown('Expected and actual rows are required');
  if (![...expected, ...actual].every(x => record(x) && typeof x[key] === 'string' && fields.every(f => Object.hasOwn(x, f)))) return unknown(`Rows require ${key} and ${fields.join(', ')}`);
  const gold = new Map(expected.map(x => [x[key], x])), observed = new Map(actual.map(x => [x[key], x]));
  if (gold.size !== expected.length) return unknown('Gold row identities are duplicated');
  const keys = new Set([...gold.keys(), ...observed.keys()]);
  let correct = 0;
  for (const id of keys) {
    const g = gold.get(id), a = observed.get(id);
    if (!g || !a || actual.filter(x => x[key] === id).length !== 1) continue;
    if (numeric) {
      if (!Number.isFinite(g.value) || !Number.isFinite(a.value) || typeof g.unit !== 'string' || typeof a.unit !== 'string' || (g.tolerance !== undefined && (!Number.isFinite(g.tolerance) || g.tolerance < 0))) return unknown('Numeric rows require finite values, unit, and nonnegative recorded tolerance', keys.size);
      if (g.unit === a.unit && Math.abs(g.value - a.value) <= (g.tolerance ?? 0)) correct++;
    } else if (fields.every(f => equal(g[f], a[f]))) correct++;
  }
  // Numeric precision uses all required values; unexpected values cannot improve the numerator.
  return ratio(correct, numeric ? gold.size : keys.size, check, { expectedRows: gold.size, actualRows: actual.length, extraKeys: [...observed.keys()].filter(x => !gold.has(x)) });
}
export function exactObject(expected: unknown, actual: unknown, check: CheckSpec): RuleResult {
  if (!record(expected) || !record(actual)) return unknown('Independent expected object and observed object are required');
  return ratio(Number(equal(expected, actual)), 1, check);
}
export function macroF1(expected: unknown, actual: unknown, check: CheckSpec): RuleResult {
  if (!record(expected) || !record(actual) || !Array.isArray(expected.classes) || !Array.isArray(expected.labels) || !Array.isArray(actual.labels) || ![...expected.classes, ...expected.labels, ...actual.labels].every(x => typeof x === 'string')) return unknown('Recorded classes and original prediction/Gold label multisets are required');
  const classes: string[] = expected.classes;
  if (new Set(classes).size !== classes.length || [...expected.labels, ...actual.labels].some(x => !classes.includes(x))) return unknown('Labels must belong to unique recorded classes');
  const counts = classes.map(label => {
    const g = expected.labels.filter((x: string) => x === label).length, p = actual.labels.filter((x: string) => x === label).length;
    const tp = expected.labels.filter((x: string, index: number) => x === label && actual.labels[index] === label).length, fp = p - tp, fn = g - tp;
    return { label, tp, fp, fn, f1: 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : null };
  });
  const supported = counts.filter(x => x.f1 !== null);
  return ratio(supported.reduce((sum, x) => sum + x.f1!, 0), supported.length, check, { classes: counts, unsupportedClasses: counts.filter(x => x.f1 === null).map(x => x.label) });
}

export interface Opportunity { id: string; expected: Record<string, any> }
export type OpportunityRule = (gold: Record<string, any>, actual: Record<string, any>) => boolean | null;
export function opportunities(expected: unknown, actual: unknown, check: CheckSpec, rule: OpportunityRule, negative = false): RuleResult {
  if (!record(expected) || !Array.isArray(expected.opportunities) || !record(actual) || !Array.isArray(actual.opportunities)) return unknown('Independent planned opportunities and observed facts are required');
  const gold: Opportunity[] = expected.opportunities, observed: any[] = actual.opportunities;
  if (!gold.every(x => record(x) && typeof x.id === 'string' && record(x.expected)) || !observed.every(x => record(x) && typeof x.id === 'string')) return unknown('Opportunity identities and independent expected facts are required');
  if (new Set(gold.map(x => x.id)).size !== gold.length || new Set(observed.map(x => x.id)).size !== observed.length) return unknown('Duplicate opportunity identities', gold.length);
  let numerator = 0, failures = 0, missing = 0, notRun = 0, errors = 0;
  const refs: string[] = [], outcomes: { id: string; status: string; numerator:number|null; denominator:number; evidenceRefs:string[] }[] = [];
  for (const g of gold) {
    const a = observed.find(x => x.id === g.id);
    let status: string;
    if (a?.status === 'NOT_RUN') { status = 'NOT_RUN'; notRun++; }
    else if (a?.status === 'ERROR') { status = 'ERROR'; errors++; }
    else if (!a || !record(a.actual) || !Array.isArray(a.evidenceRefs) || !a.evidenceRefs.length || !a.evidenceRefs.every((x: unknown) => typeof x === 'string' && x.length)) { status = 'UNJUDGEABLE'; missing++; }
    else {
      const result = rule(g.expected, a.actual);
      refs.push(...a.evidenceRefs);
      if (result === null) { status = 'UNJUDGEABLE'; missing++; }
      else { if (result) numerator++; if (negative ? result : !result) failures++; status = (negative ? result : !result) ? 'FAIL' : 'PASS'; }
    }
    outcomes.push({ id:g.id,status,numerator:['PASS','FAIL'].includes(status)?Number(negative?status==='FAIL':status==='PASS'):null,denominator:1,evidenceRefs:a?.evidenceRefs??[] });
  }
  const extras = observed.filter(x => !gold.some(g => g.id === x.id));
  for (const extra of extras) { missing++; outcomes.push({id:extra.id,status:'UNJUDGEABLE',numerator:null,denominator:1,evidenceRefs:extra.evidenceRefs??[]}); }
  const result = ratio(numerator, gold.length + extras.length, { ...check, direction: negative ? 'lower' : check.direction }, { opportunities: outcomes, unexpectedOpportunityIds: extras.map(x => x.id) });
  const incomplete = missing + notRun + errors > 0;
  if (incomplete) {
    result.value = null;
    result.numerator = null;
    result.status = failures ? 'FAIL' : errors ? 'ERROR' : missing ? 'UNJUDGEABLE' : 'NOT_RUN';
    result.reason = `${missing} unknown, ${notRun} not run, ${errors} errors; ${failures} proven violations`;
    result.missing = outcomes.filter(x => !['PASS', 'FAIL'].includes(x.status)).map(x => `${x.id}: ${x.status}`);
  }
  result.evidenceRefs = [...new Set(refs)];
  return result;
}
