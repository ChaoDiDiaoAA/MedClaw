import {
  EvaluationReportSectionViewSchema, EvaluationReportSummarySchema, EvaluationProgressSchema, EvaluationValueSummarySchema,
  type EvaluationReportSummary, type EvaluationValueSummary, type EvaluationPayload, type EvaluationDiagnostic,
} from '../../../packages/contracts/src/evaluation';
import type { EvaluationReport, ArchivedTrial } from '../types';
import type { EvaluationScore, Aggregation } from '../scoring/types';
import type { ProgressEvent } from '../execution/progress';
import type { PartialExecution } from '../reports/write';
import { deriveReportAnalysis } from '../reports/analysis';
import { record } from '../scoring/rules';

const privateField = /(?:api.?key|secret|password|credential|authorization|cookie|environment|provider.?request|native.?history|system.?prompt|gold|canar|future.?step|sourceCode|sourceInventory|packageJson|request.?body)|^files$/i;
export function summarizeValue(value: unknown, secrets: readonly string[] = []): EvaluationValueSummary {
  let truncated = false, redacted = false, remaining = 30000;
  const cleanText = (text: string) => {
    let safe = text;
    for (const secret of secrets) if (secret && safe.includes(secret)) { safe = safe.replaceAll(secret, '[Redacted]'); redacted = true; }
    safe = safe.replace(/(?:Bearer\s+\S+|\bsk-[\w-]+|(?:api[_-]?key|secret|password|authorization)\s*[:=]\s*[^\s,;]+)/gi, () => { redacted = true; return '[Redacted]'; });
    if (safe.length > remaining) { safe = safe.slice(0, Math.max(0, remaining)); truncated = true; }
    remaining -= safe.length; return safe;
  };
  const visit = (input: unknown, depth: number): unknown => {
    if (typeof input === 'string') return cleanText(input);
    if (input === null || typeof input === 'boolean' || typeof input === 'number') return input;
    if (typeof input !== 'object') return cleanText(String(input));
    if (depth >= 4 || remaining <= 0) { truncated = true; return '[Truncated]'; }
    const entries = Array.isArray(input) ? input.map((item, i) => [String(i), item] as const) : Object.entries(input);
    if (entries.length > 20) truncated = true;
    const result = entries.slice(0, 20).map(([key, item]) => {
      if (privateField.test(key)) { redacted = true; return [cleanText(key), '[Redacted]'] as const; }
      return [cleanText(key), visit(item, depth + 1)] as const;
    });
    return Array.isArray(input) ? result.map(([, item]) => item) : Object.fromEntries(result);
  };
  const projected = visit(value, 0), encoded = typeof projected === 'string' ? projected : JSON.stringify(projected);
  const text = encoded.length > 32768 ? (truncated = true, encoded.slice(0, 32768)) : encoded;
  return EvaluationValueSummarySchema.parse({ type: Array.isArray(value) ? 'array' : value !== null && typeof value === 'object' ? 'object' : 'primitive',
    total: Array.isArray(value) ? value.length : value !== null && typeof value === 'object' ? Object.keys(value).length : 1, text, truncated, redacted });
}
export function safeText(value: string, secrets: readonly string[] = []): string {
  const text = summarizeValue(value, secrets).text, marker = ' [Truncated]';
  return text.length > 4000 ? text.slice(0, 4000 - marker.length) + marker : text;
}
export function pageItems<T>(items: T[], page: number, pageSize: number) {
  return { page, pageSize, total: items.length, items: items.slice((page - 1) * pageSize, page * pageSize) };
}
export function projectSummary(input: EvaluationReport | PartialExecution, secrets: readonly string[] = []): EvaluationReportSummary {
  const complete = 'contract' in input, snapshot = input.snapshot, trials = input.trials;
  return EvaluationReportSummarySchema.parse({ executionId: snapshot.executionId, datasetId: snapshot.dataset.info.id,
    archiveState: complete ? 'complete' : 'partial', createdAt: complete ? input.createdAt : null,
    startedAt: trials.map(trial => trial.startedAt).filter((at): at is string => at !== null).sort()[0] ?? null,
    planned: complete ? input.plan.length : snapshot.plan!.length, recorded: trials.length,
    qualityMetricCatalogVersion: snapshot.qualityMetricCatalogVersion ?? 'v1', totals: complete ? input.totals : null,
    aggregation: complete ? summarizeValue(input.aggregation, secrets) : null, analysis: complete ? summarizeValue(input.analysis ?? deriveReportAnalysis(input), secrets) : null,
    quality: null, gaps: complete ? [] : input.gaps });
}
export function projectReportSection(input: EvaluationReport | PartialExecution, request: EvaluationPayload<'eval.report.read'>, secrets: readonly string[] = []) {
  const complete = 'contract' in input, summary = projectSummary(input, secrets), { section, page = 1, pageSize = 50 } = request;
  const base = { executionId: input.snapshot.executionId, archiveState: summary.archiveState, section };
  if (section === 'summary') return EvaluationReportSectionViewSchema.parse({ ...base, summary });
  if (!complete && ['coverage', 'feedback'].includes(section)) throw new Error('artifact_not_ready');
  const plan = complete ? input.plan : input.snapshot.plan!;
  let items: unknown[];
  if (section === 'cases') {
    const analysis = complete ? input.analysis ?? deriveReportAnalysis(input) : null;
    items = input.snapshot.dataset.cases.filter(task => !request.caseId || task.id === request.caseId).map(task => ({ id: task.id, name: safeText(task.name, secrets), category: task.category, evalType: task.evalType, tags: task.tags,
      planned: plan.filter(item => item.caseId === task.id).length, recorded: input.trials.filter(item => item.caseId === task.id).length,
      status: complete ? (input.aggregation as Aggregation).cases.find(item => item.caseId === task.id)?.status ?? null : null,
      analysis: analysis ? summarizeValue(analysis.cases.find(item => item.caseId === task.id) ?? null, secrets) : null }));
  }
  else if (section === 'trials') items = input.trials.filter(trial => (!request.caseId || trial.caseId === request.caseId) && (!request.trialId || trial.trialId === request.trialId)).map(trial => projectTrial(trial, secrets));
  else if (section === 'scores') items = input.scores.filter(score => (!request.caseId || score.caseId === request.caseId) && (!request.trialId || score.trialId === request.trialId)).map(score => projectScore(score, secrets));
  else if (section === 'coverage') items = complete ? (input.analysis ?? deriveReportAnalysis(input)).qualityMetrics.map(metric => ({ metricId: metric.id, version: metric.version, summary: summarizeValue(metric, secrets) })) : [];
  else if (section === 'diagnostics') items = complete ? [] : input.gaps;
  else items = [];
  return EvaluationReportSectionViewSchema.parse({ ...base, ...pageItems(items, page, pageSize) });
}
export function projectTrial(trial: ArchivedTrial, secrets: readonly string[] = []) {
  return { trialId: trial.trialId, caseId: trial.caseId, repetition: trial.repetition, status: trial.status, instanceId: trial.instanceId,
    startedAt: trial.startedAt, endedAt: trial.endedAt, reason: trial.reason === null ? null : safeText(trial.reason, secrets), stopped: trial.stopped, closed: trial.closed };
}
export function projectScore(score: EvaluationScore, secrets: readonly string[] = []) {
  return { trialId: score.trialId, caseId: score.caseId, metricId: score.metricId, name: safeText(score.name, secrets), version: score.version, method: score.method,
    checkId: score.checkId, scope: score.scope, required: score.required, hardConstraint: score.hardConstraint, status: score.status, applicable: score.applicable,
    value: score.value, numerator: score.numerator, denominator: score.denominator, unit: score.unit, reason: safeText(score.reason, secrets),
    missing: score.missing.map(item => safeText(item, secrets)), evidenceRefs: score.evidenceRefs, actual: summarizeValue(score.actual, secrets), expected: summarizeValue(score.expected, secrets) };
}
export function projectProgress(event: ProgressEvent, secrets: readonly string[] = []) {
  return EvaluationProgressSchema.parse({ trialId: event.trialId, caseId: event.caseId, repetition: event.repetition, index: event.index, total: event.total, trialsPerCase: event.trialsPerCase,
    kind: event.kind, phase: event.phase, elapsedMs: event.elapsedMs, phaseElapsedMs: event.phaseElapsedMs, executionStatus: event.executionStatus,
    status: event.status, reason: event.reason === undefined || event.reason === null ? event.reason : safeText(event.reason, secrets), checks: event.checks?.map(check => ({ metricId: check.metricId, status: check.status })) });
}
export function projectEvidence(facts: Record<string, unknown>, evidenceRef: string, secrets: readonly string[] = [], page = 1, pageSize = 50) {
  const list = (value: unknown) => Array.isArray(value) ? value.filter(record) : [];
  const fields = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  const parsed = /^(query|evidence|answer|tool|run):(\d+)(?::page:(\d+))?$/.exec(evidenceRef);
  let value: unknown = null;
  if (parsed) {
    const kind = parsed[1], id = Number(parsed[2]), selectedPage = parsed[3] === undefined ? null : Number(parsed[3]);
    if (!Number.isSafeInteger(id) || id < 1 || selectedPage !== null && (!Number.isSafeInteger(selectedPage) || selectedPage < 1)) throw new Error('access_denied');
    if (kind === 'query') {
      const pages = list(facts.queryPages).filter(item => record(item.query) && item.query.id === id && record(item.page) && (selectedPage === null || item.page.page === selectedPage));
      if (pages.length) value = { query: fields(pages[0]!.query, ['id', 'sessionId', 'runId', 'params', 'batchIds', 'calculationVersion', 'createdAt', 'totalRows', 'warnings']),
        pages: pages.map(item => fields(item.page, ['page', 'pageSize', 'totalRows', 'warnings', 'evidenceIds'])), ...pageItems(pages.flatMap(item => Array.isArray(item.page.rows) ? item.page.rows : []), page, pageSize) };
    } else if (kind === 'evidence') {
      const pages = list(facts.evidencePages).filter(item => record(item.evidence) && item.evidence.id === id && (selectedPage === null || item.page === selectedPage));
      if (pages.length) value = { evidence: fields(pages[0]!.evidence, ['id', 'queryId', 'sourceType', 'sourceId', 'sourceVersion', 'sourceTime', 'locator', 'description']),
        ...pageItems(pages.flatMap(item => Array.isArray(item.rows) ? item.rows : []), page, pageSize) };
    } else if (kind === 'answer') {
      const answer = list(facts.answers).find(item => item.id === id);
      if (answer) value = fields(answer, ['id', 'runId', 'sessionId', 'kind', 'text', 'queryIds', 'missingSlots', 'createdAt']);
    } else if (kind === 'tool') {
      const tool = list(facts.toolCalls).find(item => item.id === id);
      if (tool) value = { ...fields(tool, ['id', 'runId', 'name', 'status', 'durationMs']), errorCode: record(tool.error) ? tool.error.code : null };
    } else {
      const run = list(facts.runs).find(item => item.id === id);
      if (run) value = fields(run, ['id', 'sessionId', 'parentRunId', 'kind', 'status', 'startedAt', 'endedAt', 'stopConfirmed', 'saveConfirmed']);
    }
  } else if (evidenceRef === 'controller:execution-timing' && record(facts.executionTiming)) value = fields(facts.executionTiming, ['trialId', 'startedAt', 'endedAt', 'durationMs']);
  else if (/^lifecycle(?::|$)/.test(evidenceRef) && record(facts.lifecycle)) value = fields(facts.lifecycle, ['contract', 'stopped', 'closed', 'processExited', 'stopConfirmed', 'saveConfirmed']);
  return { summary: summarizeValue(value, secrets), gaps: value === null ? [diagnostic(parsed ? 'evidence_reference_missing' : 'evidence_reference_unsupported')] : [] };
}
export function diagnostic(code: string, trialId: string | null = null): EvaluationDiagnostic {
  return { code: /^[a-z][a-z0-9_]{0,127}$/.test(code) ? code : 'evaluation_archive_invalid', message: 'The original evaluation facts could not be verified.', trialId };
}
export function unreadableSummary(executionId: string, code: string): EvaluationReportSummary {
  return { executionId, datasetId: null, archiveState: 'unreadable', createdAt: null, startedAt: null, planned: 0, recorded: 0, qualityMetricCatalogVersion: null,
    totals: null, aggregation: null, analysis: null, quality: null, gaps: [diagnostic(code)] };
}
