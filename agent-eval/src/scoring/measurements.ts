import { record, unknown } from './rules.ts';
import type { CheckSpec, RuleResult } from './types.ts';

export function measurement(id: string, actual: unknown, _check: CheckSpec): RuleResult {
  if (!record(actual)) return unknown('Verified native measurement facts are required');
  const measured = (value: number, details?: unknown): RuleResult => ({ status: 'PASS', numerator: value, denominator: 1, value, reason: 'Observed measurement; no quality score inferred', details });
  if (id === 'efficiency.latency') {
    if (!Number.isFinite(actual.startedMonoMs) || !Number.isFinite(actual.stoppedMonoMs) || actual.stoppedMonoMs < actual.startedMonoMs || actual.stopConfirmed !== true) return unknown('Monotonic start and confirmed real stop measurements are required');
    return measured(actual.stoppedMonoMs - actual.startedMonoMs);
  }
  if (!Array.isArray(actual.calls) || !actual.calls.every((x: unknown) => record(x) && typeof x.id === 'string' && typeof x.kind === 'string')) return unknown('Native calls with stable identities and kinds are required');
  const calls = actual.calls as Record<string, any>[];
  if (new Set(calls.map(x => x.id)).size !== calls.length) return unknown('Duplicate native measurement identities');
  if (id === 'efficiency.calls') return measured(calls.length, { byKind: Object.fromEntries([...new Set(calls.map(x => x.kind))].map(kind => [kind, calls.filter(x => x.kind === kind).length])) });
  if (id === 'efficiency.tokens') {
    const complete = calls.filter(x => typeof x.usageSource === 'string' && ['input', 'output', 'cacheRead', 'cacheWrite'].every(k => Number.isSafeInteger(x[k]) && x[k] >= 0));
    const known = complete.reduce((sum, x) => sum + x.input + x.output + x.cacheRead + x.cacheWrite, 0);
    if (complete.length !== calls.length) return { ...unknown('Some native usage is unknown'), numerator: known, details: { knownCalls: complete.length, unknownCalls: calls.length - complete.length, knownLowerBound: known } };
    return measured(known, { calls: calls.length, sources: [...new Set(complete.map(x => x.usageSource))] });
  }
  if (id === 'efficiency.cost') {
    const complete = calls.filter(x => typeof x.costSource === 'string' && Number.isFinite(x.cost) && x.cost >= 0 && typeof x.currency === 'string');
    if (new Set(complete.map(x => x.currency)).size > 1) return unknown('Costs with different currencies cannot be summed');
    const known = complete.reduce((sum, x) => sum + x.cost, 0);
    return complete.length === calls.length ? measured(known, { currency: complete[0]?.currency ?? null }) : { ...unknown('Some call costs are unknown'), numerator: known, details: { knownLowerBound: known, unknownCalls: calls.length - complete.length } };
  }
  return unknown('Measurement-specific native evidence semantics are not implemented');
}
