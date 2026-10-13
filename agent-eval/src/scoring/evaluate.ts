import { registry } from './registry.ts';
import { ratio, record, unknown } from './rules.ts';
import { projectObservation } from './project-observation.ts';
import { judgeableCoverage } from './runtime.ts';
import type { CheckSpec, EvaluationContext, EvaluationScore, RuleResult, ScoreStatus } from './types.ts';

export function readPath(value: unknown, path: string): unknown {
  if (!path) return undefined;
  let current = value;
  for (const key of path.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || !record(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}
const state = (status: ScoreStatus, reason: string): RuleResult => ({ status, value: null, numerator: null, denominator: null, reason });
export function requiredOutcome(scores: EvaluationScore[]): ScoreStatus {
  const required = scores.filter(x => x.applicable && (x.required || x.hardConstraint));
  if (required.some(x => x.status === 'FAIL')) return 'FAIL';
  if (!required.length) return 'UNJUDGEABLE';
  for (const status of ['ERROR', 'UNJUDGEABLE', 'NOT_RUN'] as const) if (required.some(x => x.status === status)) return status;
  return 'PASS';
}
function wrap(context: EvaluationContext, check: CheckSpec, result: RuleResult, expected: unknown, actual: unknown): EvaluationScore {
  const allowed = ['trial', 'run', 'call', 'opportunity'];
  let name=check.name??check.metricId; try {name=check.name??registry.get(check.metricId).name;} catch {}
  const scope = check.scope ?? { kind: 'trial', ref: context.trialId };
  return { trialId: context.trialId, caseId: context.caseId, metricId: check.metricId, name, version: check.version, method: check.kind,
    checkId: check.id, scope: { kind: allowed.includes(scope.kind) ? scope.kind as EvaluationScore['scope']['kind'] : 'trial', ref: scope.ref },
    applicable: result.applicable ?? true, required: check.required, hardConstraint: check.hardConstraint, unit: check.unit,
    status: result.status, value: result.value, numerator: result.numerator, denominator: result.denominator,
    evidenceRefs: result.evidenceRefs ?? [], reason: result.reason, missing: result.missing ?? [],
    expected: expected === undefined ? null : expected, actual: actual === undefined ? null : actual, ...(result.details === undefined ? {} : { details: result.details }) };
}

export async function evaluate(context: EvaluationContext): Promise<EvaluationScore[]> {
  const scores: EvaluationScore[] = [], semantic: { check: CheckSpec; expected: Record<string, any>; actual: Record<string, any> }[] = [];
  const deferred: CheckSpec[] = [], coverage: CheckSpec[] = [];
  const ids = new Set<string>();
  const repeatedIds = new Set(context.task.checks.filter((check, index, checks) => checks.findIndex(x => x.id === check.id) !== index).map(x => x.id));
  for (const check of context.task.checks) {
    let expected = readPath(context.gold, check.goldKey);
    let actual = readPath(context.observation?.facts, check.evidenceKey);
    let projection;
    const add = (result: RuleResult) => scores.push(wrap(context, check, result, expected, actual));
    if (ids.has(check.id)) continue;
    ids.add(check.id);
    if (repeatedIds.has(check.id)) { add(state('ERROR', 'Duplicate check identity')); continue; }
    if (check.scope && (!['trial', 'run', 'call', 'opportunity'].includes(check.scope.kind) || !check.scope.ref)) { add(state('ERROR', 'Invalid score scope')); continue; }
    let definition;
    try { definition = registry.get(check.metricId); } catch { add(state('ERROR', `Unknown metric: ${check.metricId}`)); continue; }
    if (definition.version !== check.version) { add(unknown('Requested historical scorer version is unavailable; original identity/version preserved')); continue; }
    const applicability = typeof check.applicability === 'string' && check.applicability !== 'always' ? readPath(context.gold, check.applicability) : typeof check.applicability === 'object' ? check.applicability : undefined;
    if (check.applicability !== undefined && check.applicability !== 'always') {
      if (!record(applicability) || typeof applicability.applicable !== 'boolean' || typeof applicability.reason !== 'string' || !applicability.reason.trim()) { add(unknown('Applicability requires independent explicit applicability and reason')); continue; }
      if (!applicability.applicable) { add({ ...state('UNJUDGEABLE', applicability.reason), applicable: false, denominator: 0 }); continue; }
    }
    if (['planned', 'preparing', 'not_run'].includes(context.trialStatus)) { add({ ...state('NOT_RUN', 'Trial has not started'), denominator: ['task.success', 'task.end_to_end', 'execution.completed'].includes(check.metricId) ? 1 : null }); continue; }
    if (context.trialStatus === 'infra_error' && !context.observation) { add(state('ERROR', 'Trial infrastructure failed before trusted evidence was available')); continue; }
    if (context.observation?.trialId && context.observation.trialId !== context.trialId || context.observation?.identityChecks.some(x => !x.passed)) { add(state('ERROR', 'Observation identity verification failed')); continue; }
    if (['task.success', 'task.end_to_end'].includes(check.metricId)) { deferred.push(check); continue; }
    if (check.metricId === 'coverage.judgeable') { coverage.push(check); continue; }
    if (check.metricId === 'execution.completed') { add(ratio(Number(context.trialStatus === 'completed'), 1, check)); continue; }
    if (actual === undefined && context.observation) {
      try {projection = await projectObservation(check, context); if (projection?.actual !== undefined) actual = projection.actual; if(projection?.expected!==undefined)expected=projection.expected;}
      catch {add(state('ERROR','Original evidence projection failed'));continue;}
    }
    if (check.kind === 'llm-judge') {
      if (context.trialStatus !== 'completed') { add(state('NOT_RUN', 'Judge requires completed trial')); continue; }
      if (!context.judge) { add(state('NOT_RUN', 'Independent Judge is disabled or not configured')); continue; }
      if (!record(expected) || typeof expected.rubric !== 'string' || !expected.rubric.trim() || !record(actual) || typeof actual.answer !== 'string' || !actual.answer.trim() || !Array.isArray(actual.evidenceRefs) || !actual.evidenceRefs.length || !Object.hasOwn(actual, 'evidence')) { add(unknown('Recorded rubric, answer, and supported semantic evidence are required')); continue; }
      semantic.push({ check, expected, actual });
      continue;
    }
    if (expected === undefined || actual === undefined) {
      const missing = context.observation?.missing.find(x => x.key === check.evidenceKey);
      add(unknown(projection?.reason ?? missing?.reason ?? `Missing ${expected === undefined ? 'independent Gold' : 'observed evidence'}: ${expected === undefined ? check.goldKey : check.evidenceKey}`));
      continue;
    }
    try { const result = await definition.evaluate(expected, actual, check, context); if (projection?.evidenceRefs.length) result.evidenceRefs = [...new Set([...(result.evidenceRefs ?? []), ...projection.evidenceRefs])]; add(result); }
    catch { add(state('ERROR', 'Deterministic scorer failed')); }
  }
  if (semantic.length) {
    try {
      const request={ trialId: context.trialId,
        checks: semantic.map(x => ({ checkId: x.check.id, rubric: x.expected.rubric+'\nIndependent expectations: '+JSON.stringify({...x.expected,rubric:undefined}), evidenceRefs: x.actual.evidenceRefs })),
        answer: JSON.stringify(semantic.map(x => ({ checkId: x.check.id, answer: x.actual.answer }))),
        evidence: semantic.map(x => ({ checkId: x.check.id, evidence: x.actual.evidence })) };
      await context.onJudgeRequest?.(request);
      const result = await context.judge!.judge(request, context.signal);
      await context.onJudgeResult?.(result);
      for (const item of semantic) {
        const judged = result.results.find(x => x.checkId === item.check.id);
        const outcome: RuleResult = result.status === 'error' ? state('ERROR', result.error ?? 'Judge protocol error') : !judged || judged.value === null ? unknown(judged?.reason ?? 'Judge returned no check result') : {
          ...ratio(judged.value, 1, item.check), reason: judged.reason, evidenceRefs: judged.evidenceRefs,
        };
        scores.push(wrap(context, item.check, outcome, item.expected, item.actual));
      }
    } catch { for (const item of semantic) scores.push(wrap(context, item.check, state('ERROR', 'Judge request or recording failed'), item.expected, item.actual)); }
  }
  const completedCoverage = new Set<string>();
  for (const check of coverage.filter(c => c.required || c.hardConstraint)) {
    const expected = readPath(context.gold, check.goldKey);
    const cycle = record(expected) && Array.isArray(expected.checkIds) && deferred.some(c => expected.checkIds.includes(c.id));
    scores.push(wrap(context, check, cycle ? state('ERROR', 'Required coverage cannot depend on its own derived task outcome') : judgeableCoverage(expected, scores, check), expected, scores.map(s => ({ checkId: s.checkId, status: s.status, applicable: s.applicable }))));
    completedCoverage.add(check.id);
  }
  for (const check of deferred) {
    const expected=readPath(context.gold,check.goldKey);
    const business=scores.filter(score=>/^(query|diff|export|answer)\./.test(score.metricId)||score.metricId==='evidence.present'||record(expected)&&expected.cancelled===true&&score.metricId==='subagent.stop');
    const outcome=requiredOutcome(business);
    const status = context.trialStatus === 'failed' ? 'FAIL' : context.trialStatus === 'infra_error' ? outcome==='FAIL'?'FAIL':'ERROR' : context.trialStatus === 'cancelled' && !(record(expected)&&expected.cancelled===true) ? 'NOT_RUN' : outcome;
    const result: RuleResult = status === 'PASS' || status === 'FAIL' ? ratio(Number(status === 'PASS'), 1, check) : { ...state(status, 'Task cannot be confirmed while required checks are incomplete'), denominator: 1 };
    scores.push(wrap(context, check, result, expected, business.map(score=>({checkId:score.checkId,status:score.status}))));
  }
  for (const check of coverage.filter(c => !completedCoverage.has(c.id))) { const expected = readPath(context.gold, check.goldKey); scores.push(wrap(context, check, judgeableCoverage(expected, scores, check), expected, scores.map(s => ({ checkId: s.checkId, status: s.status, applicable: s.applicable })))); }
  return [...new Set(context.task.checks.map(check => check.id))].flatMap(id => scores.filter(x => x.checkId === id).slice(0, 1));
}
