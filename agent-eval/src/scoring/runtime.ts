import { equal, opportunities, ratio, record, unknown } from './rules.ts';
import type { CheckSpec, EvaluationScore, RuleResult } from './types.ts';

export function judgeableCoverage(expected: unknown, scores: Pick<EvaluationScore, 'checkId' | 'status' | 'applicable'>[], check: CheckSpec): RuleResult {
  if (!record(expected) || !Array.isArray(expected.checkIds) || !expected.checkIds.every((id: unknown) => typeof id === 'string' && id.length > 0) || new Set(expected.checkIds).size !== expected.checkIds.length || expected.checkIds.includes(check.id)) return unknown('Coverage requires unique recorded planned check IDs excluding itself');
  const missing = expected.checkIds.filter((id: string) => !scores.some(s => s.checkId === id));
  const applicable = scores.filter(s => expected.checkIds.includes(s.checkId) && s.applicable);
  return ratio(applicable.filter(s => ['PASS', 'FAIL'].includes(s.status)).length, applicable.length + missing.length, check, { planned: expected.checkIds.length, missingCheckIds: missing, gaps: applicable.filter(s => !['PASS', 'FAIL'].includes(s.status)).map(s => ({ checkId: s.checkId, status: s.status })) });
}

export function correctionMeasurement(actual: unknown): RuleResult {
  if (!record(actual) || !Array.isArray(actual.inputs) || !actual.inputs.every((i: unknown) => record(i) && typeof i.inputId === 'string' && i.inputId.length > 0 && ['initial', 'correction', 'followup'].includes(i.kind) && typeof i.recordRef === 'string' && i.recordRef.length > 0) || new Set(actual.inputs.map((i: any) => i.inputId)).size !== actual.inputs.length) return unknown('Original classified user input IDs and records are required');
  const corrections = actual.inputs.filter((i: any) => i.kind === 'correction').length;
  if (!Array.isArray(actual.activeIntervals) || !actual.activeIntervals.every((i: unknown) => record(i) && typeof i.startMonoMs === 'number' && Number.isFinite(i.startMonoMs) && typeof i.endMonoMs === 'number' && Number.isFinite(i.endMonoMs) && i.endMonoMs >= i.startMonoMs && typeof i.timerRef === 'string' && i.timerRef.length > 0)) return { ...unknown('Active user time is unknown; no duration estimated'), numerator: corrections, details: { correctionInputs: corrections, activeMs: null } };
  const intervals = [...actual.activeIntervals].sort((a: any, b: any) => a.startMonoMs - b.startMonoMs);
  if (intervals.some((i: any, index: number) => index > 0 && i.startMonoMs < intervals[index - 1].endMonoMs)) return unknown('Active timer intervals overlap');
  const activeMs = intervals.reduce((sum: number, i: any) => sum + i.endMonoMs - i.startMonoMs, 0);
  return { status: 'PASS', value: corrections, numerator: corrections, denominator: 1, reason: 'Original correction count and active user time measured', evidenceRefs: [...actual.inputs.map((i: any) => i.recordRef), ...intervals.map((i: any) => i.timerRef)], details: { correctionInputs: corrections, activeMs } };
}

export function retryPolicy(expected: unknown, actual: unknown, check: CheckSpec): RuleResult {
  const result = opportunities(expected, actual, check, (g, a) => {
    if (!Array.isArray(g.allowedReasons) || !g.allowedReasons.every((r: unknown) => typeof r === 'string') || !Number.isSafeInteger(g.maxAttempts) || g.maxAttempts < 1 || typeof g.kind !== 'string' || !Array.isArray(a.attempts) || !a.attempts.length || !Number.isSafeInteger(a.hiddenReplays) || typeof a.logicalRequestId !== 'string' || !a.logicalRequestId || !a.attempts.every((attempt: unknown) => record(attempt) && typeof attempt.attemptId === 'string' && attempt.attemptId.length > 0 && typeof attempt.kind === 'string' && typeof attempt.reason === 'string' && typeof attempt.priorAttemptId !== 'undefined' && typeof attempt.recordRef === 'string' && attempt.recordRef.length > 0)) return null;
    if (new Set(a.attempts.map((x: any) => x.attemptId)).size !== a.attempts.length) return false;
    return a.hiddenReplays === 0 && a.attempts.length <= g.maxAttempts && a.attempts.every((attempt: any, index: number) => attempt.kind === g.kind && (index === 0 ? attempt.priorAttemptId === null && attempt.reason === 'initial' : attempt.priorAttemptId === a.attempts[index - 1].attemptId && g.allowedReasons.includes(attempt.reason)));
  });
  if (record(actual) && Array.isArray(actual.opportunities)) {
    const attempts = actual.opportunities.flatMap((o: any) => record(o.actual) && Array.isArray(o.actual.attempts) ? o.actual.attempts.slice(1) : []);
    result.details = { ...(record(result.details) ? result.details : {}), observedRetryAttempts: attempts.length, retriesByKind: Object.fromEntries([...new Set(attempts.map((a: any) => a.kind))].filter(k => typeof k === 'string').map(kind => [kind, attempts.filter((a: any) => a.kind === kind).length])) };
  }
  return result;
}

export function exportedExact(expected: unknown, actual: unknown, check: CheckSpec): RuleResult {
  if (!record(expected) || !record(actual) || !Array.isArray(expected.rows) || !Array.isArray(expected.sets) || !record(expected.metadata) || typeof expected.format !== 'string' || typeof expected.sourceQueryAlias !== 'string' || !Array.isArray(actual.rows) || !Array.isArray(actual.sets) || !record(actual.metadata) || !Array.isArray(actual.fileRows) || !Array.isArray(actual.queryRows) || !Array.isArray(actual.columns) || !actual.columns.every((x: unknown) => typeof x === 'string') || typeof actual.sourceQueryAlias !== 'string' || typeof actual.format !== 'string' || typeof actual.queryId !== 'number' || typeof actual.artifactId !== 'number' || !record(actual.fileMetadata)) return unknown('Registered export file contents, original Query rows, metadata and independent export Gold are required');
  const declaredFields = ['key', 'device', 'name', 'category', 'region', 'date', 'price', 'status', 'manufacturer', 'distributor'];
  const validRow = (row: unknown) => record(row) && typeof row.key === 'string' && typeof row.device === 'string' && Object.keys(row).every(key => declaredFields.includes(key));
  if (![...expected.rows, ...actual.rows].every(validRow) || new Set(expected.rows.map((r: any) => r.key)).size !== expected.rows.length || new Set(actual.rows.map((r: any) => r.key)).size !== actual.rows.length) return unknown('Export rows require unique source keys and declared exportable columns');
  const rowsMatch = expected.rows.length === actual.rows.length && expected.rows.every((g: any) => { const a = actual.rows.find((r: any) => r.key === g.key); return a && Object.keys(g).every(key => equal(g[key], a[key])); });
  const fileMatches = equal(actual.fileRows, actual.queryRows);
  const metadataMatches = Object.entries(expected.metadata).every(([key, value]) => Object.hasOwn(actual.metadata, key) && equal(value, actual.metadata[key]));
  const setsMatch = expected.sets.length === actual.sets.length && new Set(actual.sets).size === actual.sets.length && expected.sets.every((id: unknown) => actual.sets.includes(id));
  const identityMatches = expected.format === actual.format && expected.sourceQueryAlias === actual.sourceQueryAlias && actual.fileMetadata.query?.id === actual.queryId && actual.fileMetadata.artifactId === actual.artifactId;
  const columnsMatch=expected.requiredColumns===undefined||Array.isArray(expected.requiredColumns)&&expected.requiredColumns.every((column:unknown)=>typeof column==='string'&&actual.columns.includes(column));
  return ratio(Number(rowsMatch && fileMatches && metadataMatches && setsMatch && identityMatches && columnsMatch), 1, check, { rowsMatch, fileMatches, metadataMatches, setsMatch, identityMatches, columnsMatch, originalRows: actual.queryRows.length });
}
