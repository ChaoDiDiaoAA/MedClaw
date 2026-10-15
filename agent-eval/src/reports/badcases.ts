import { readFile, lstat, open, unlink, rename } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ExecutionIdSchema, JudgeConfigurationSchema, type EvaluationReport } from '../types.ts';
import { RelativePathSchema } from '../evaluation.ts';
import { record } from '../scoring/rules.ts';
import type { Aggregation } from '../scoring/types.ts';
import { assertJudgeCallMatches } from '../scoring/judges/client.ts';
import { ANSWER_QUALITY_RUBRIC } from '../scoring/judges/answer-quality.ts';
import { assessCalibration, type CalibrationSample } from '../scoring/judges/calibration.ts';
import { FeedbackSchema, type HumanFeedback } from '../review/store.ts';
import { OpaqueIdSchema, PositiveIdSchema, safeError } from '../../../packages/contracts/src/error.ts';
import { compareReports } from './compare.ts';
import { evidencePath, readReport, writeFileExclusive, writeJsonExclusive, replaceJson } from './write.ts';

export interface BadcaseEvidenceRef { path: string; pointer?: string; line?: number }
export interface BadcaseCandidate {
  id: string; executionId: string; caseId: string | null; trialId: string | null; sampleId: string | null;
  runIds: number[]; callIds: string[]; operationRefs: string[];
  checkIds: string[]; statuses: string[]; signals: string[]; suspectedNodes: string[];
  facts: string[]; hypotheses: string[]; gaps: string[]; evidenceRefs: BadcaseEvidenceRef[];
  feedbackRefs: BadcaseEvidenceRef[]; commonEventIds: string[];
}
export interface BadcaseIndex {
  contract: 'medclaw-badcase-index/v1'; executionId: string; kind: 'evaluation' | 'calibration';
  summary: { candidates: number; signals: number; trials: number; samples: number; cases: number; commonEvents: number };
  candidates: BadcaseCandidate[];
  commonEvents: { id: string; kind: string; facts: string[]; evidenceRefs: BadcaseEvidenceRef[]; candidateIds: string[] }[];
  gaps: string[];
  comparison?: { baselineExecutionId: string; status: 'comparable' | 'incompatible'; gaps: string[] };
}
const rootOf = (path: string) => {
  if (path.endsWith('.json') && basename(path) !== 'report.json') throw new Error('badcases_report_path_invalid');
  return path.endsWith('.json') ? dirname(resolve(path)) : resolve(path);
};
const readJson = async (root: string, path: string): Promise<any> => {
  const value = JSON.parse(await readFile(await evidencePath(root, path), 'utf8'));  return value;
};
const unique = <T>(values: T[]) => [...new Set(values)];
const addRef = (refs: BadcaseEvidenceRef[], ref: BadcaseEvidenceRef) => { if (!refs.some(existing => isDeepStrictEqual(existing, ref))) refs.push(ref); };
const add = (candidate: BadcaseCandidate, signal: string, fact: string, node: string, ref: BadcaseEvidenceRef) => {
  candidate.signals.push(signal); candidate.facts.push(fact); candidate.suspectedNodes.push(node); addRef(candidate.evidenceRefs, ref);
};
const candidateFor = (executionId: string, kind: string, id: string, caseId: string | null): BadcaseCandidate => ({
  id: `${kind}:${id}`, executionId, caseId, trialId: kind === 'trial' ? id : null, sampleId: kind === 'sample' ? id : null,
  runIds: [], callIds: [], operationRefs: [],
  checkIds: [], statuses: [], signals: [], suspectedNodes: [], facts: [], hypotheses: [], gaps: [], evidenceRefs: [], feedbackRefs: [], commonEventIds: [],
});
const emptyIndex = (executionId: string, kind: BadcaseIndex['kind']): BadcaseIndex => ({ contract: 'medclaw-badcase-index/v1', executionId, kind,
  summary: { candidates: 0, signals: 0, trials: 0, samples: 0, cases: 0, commonEvents: 0 }, candidates: [], commonEvents: [], gaps: [] });
function finish(index: BadcaseIndex) {
  for (const candidate of index.candidates) {
    for (const key of ['checkIds', 'statuses', 'signals', 'suspectedNodes', 'facts', 'hypotheses', 'gaps', 'commonEventIds'] as const) candidate[key] = unique(candidate[key]);
    candidate.runIds = unique(candidate.runIds).sort((a, b) => a - b); candidate.callIds = unique(candidate.callIds).sort(); candidate.operationRefs = unique(candidate.operationRefs).sort();
    candidate.evidenceRefs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (!candidate.feedbackRefs.length) candidate.gaps.push('No imported human feedback is recorded for this candidate.');
    if (!candidate.hypotheses.length) candidate.hypotheses.push('Review the cited records before attributing a root cause.');
  }
  index.summary = { candidates: index.candidates.length, signals: index.candidates.reduce((count, item) => count + item.signals.length, 0), trials: new Set(index.candidates.flatMap(item => item.trialId ? [item.trialId] : [])).size,
    samples: new Set(index.candidates.flatMap(item => item.sampleId ? [item.sampleId] : [])).size,
    cases: new Set(index.candidates.flatMap(item => item.caseId ? [item.caseId] : [])).size, commonEvents: index.commonEvents.length };
  return index;
}
function balanceEvent(index: BadcaseIndex, candidate: BadcaseCandidate, ref: BadcaseEvidenceRef, provider: string, model: string) {
  const id = 'provider-insufficient-balance:' + JSON.stringify([provider, model]);
  let event = index.commonEvents.find(event => event.id === id);
  if (!event) { event = { id, kind: 'provider_balance', facts: ['Archived native assistant error records HTTP 402 and Insufficient Balance.', 'Occurrences are grouped by recorded provider/model identity; a shared request or causal chain is not established.'], evidenceRefs: [], candidateIds: [] }; index.commonEvents.push(event); }
  addRef(event.evidenceRefs, ref); event.candidateIds = unique([...event.candidateIds, candidate.id]);
  candidate.commonEventIds.push(id);
  add(candidate, 'provider_balance', 'A native provider balance rejection is recorded.', 'provider', ref);
}
function observeFailures(index: BadcaseIndex, candidate: BadcaseCandidate, observation: any, path: string, task: EvaluationReport['snapshot']['dataset']['cases'][number], completed: boolean, model: EvaluationReport['config']['model']) {
  if (!record(observation.facts)) { candidate.gaps.push('Observed facts are unavailable.'); return; }
  const facts = observation.facts, expected = task.expected.expectedFailureMode;
  const records = (key: string): any[] => Array.isArray(facts[key]) ? facts[key] : [];
  const runs = records('runs'), cancelledRuns = new Set<number>(), aliases = facts.aliases;
  const finalBindings = aliases?.source === 'controller-accepted-public-identities' && typeof aliases.lastSendAlias === 'string' && Array.isArray(aliases.runs)
    ? aliases.runs.filter((binding: any) => binding?.alias === aliases.lastSendAlias) : [];
  const finalRuns = finalBindings.length === 1 && PositiveIdSchema.safeParse(finalBindings[0].runId).success ? runs.filter(run => run?.id === finalBindings[0].runId && run.kind !== 'child') : [];
  const finalRun = finalRuns.length === 1 ? finalRuns[0] : undefined;
  if (completed && aliases?.source === 'controller-accepted-public-identities' && Array.isArray(aliases.runs)) {
    for (const step of task.input.turns ?? []) {
      if (step.action.action !== 'cancel') continue;
      const action = step.action, bindings = aliases.runs.filter((binding: any) => binding?.alias === action.runAlias);
      const parents = runs.filter(run => run?.id === bindings[0]?.runId);
      if (bindings.length !== 1 || parents.length !== 1) continue;
      const parent = parents[0];
      if (parent.kind === 'agent' && parent.status === 'cancelled' && PositiveIdSchema.safeParse(parent.id).success && typeof parent.cancelRequestedAt === 'string' && Number.isFinite(Date.parse(parent.cancelRequestedAt))) cancelledRuns.add(parent.id);
    }
    for (const child of runs) {
      const parent = runs.find(run => cancelledRuns.has(run?.id) && run.id === child?.parentRunId);
      if (child?.kind === 'child' && parent && PositiveIdSchema.safeParse(child.id).success && child.id !== parent.id && child.sessionId !== parent.sessionId
        && records('toolCalls').some(tool => tool?.id === child.originToolCallId && tool.name === 'Agent' && tool.runId === parent.id && tool.sessionId === parent.sessionId)) cancelledRuns.add(child.id);
    }
  }
  if (!['toolCalls', 'modelCalls', 'runs', 'operations', 'nativeHistory'].some(key => records(key).length)) candidate.gaps.push('No archived tool, model, Run, operation or native history sequence is available to establish a cause.');
  if (Array.isArray(observation.missing) && observation.missing.length) { candidate.gaps.push(`The observation records ${observation.missing.length} evidence gap(s).`); addRef(candidate.evidenceRefs, { path, pointer: '/missing' }); }
  for (const key of ['toolCalls', 'modelCalls', 'runs', 'operations']) {
    const items = records(key);
    for (const [i, item] of items.entries()) {
      if (!record(item)) continue;
      const status = item.status ?? item.state;
      if (!['failed', 'error', 'cancelled', 'interrupted', 'unconfirmed'].includes(status) && !record(item.error)) continue;
      const code = record(item.error) && typeof item.error.code === 'string' ? safeError(item.error.code).code : null;
      if (key === 'toolCalls' && expected && code === expected) continue;
      const cancellationOwner = key === 'runs' ? item.id : key === 'operations' && item.kind === 'compaction' ? item.receipt?.runId : item.runId;
      const owner = runs.find(run => run?.id === cancellationOwner);
      if (status === 'cancelled' && cancelledRuns.has(cancellationOwner) && (item.error == null || code === 'tool_cancelled')
        && (key === 'runs' || item.sessionId === owner?.sessionId) && (key !== 'operations' || item.kind === 'compaction' && item.receipt?.status === 'cancelled' && item.receipt.sessionId === owner?.sessionId)) continue;
      const node = item.kind === 'compaction' ? 'compaction' : key === 'toolCalls' ? 'tool' : key === 'modelCalls' ? 'model' : key === 'operations' ? 'operation' : 'execution';
      const ref = { path, pointer: `/facts/${key}/${i}` };
      add(candidate, 'observed_failure', `Archived ${node} record has a failure${code ? ` (${code})` : ''}.`, node, ref);
      const runId = PositiveIdSchema.safeParse(key === 'runs' ? item.id : item.runId);
      if (runId.success) candidate.runIds.push(runId.data);
      if (key === 'modelCalls' || key === 'toolCalls') { const callId = OpaqueIdSchema.safeParse(key === 'modelCalls' ? item.callId : item.modelCallId); if (callId.success) candidate.callIds.push(callId.data); }
      if (key === 'operations' || key === 'modelCalls') { const operationRef = OpaqueIdSchema.safeParse(item.operationRef); if (operationRef.success) candidate.operationRefs.push(operationRef.data); }
      const recovered = items.slice(i + 1).some(next => record(next) && item.runId !== undefined && next.runId === item.runId
        && (item.runId !== null || typeof item.operationRef === 'string' && next.operationRef === item.operationRef)
        && (key === 'toolCalls' && next.name === item.name && next.status === 'succeeded' || key === 'modelCalls' && next.kind === item.kind && next.state === 'completed'));
      if (recovered) add(candidate, 'recovered_failure', 'A later record in the same observed operation stream reports success after a failure.', node, ref);
      if (key === 'runs' && completed && status === 'failed') {
        if (item === finalRun) add(candidate, 'status_inconsistency', 'The Trial is completed while its bound final Run is failed.', 'execution', ref);
        else if (!finalRun) candidate.gaps.push('The final Run identity is unavailable or ambiguous; Trial/Run status consistency cannot be established.');
      }
      if (node === 'compaction') candidate.gaps.push('Normalized compaction errors do not establish the raw provider response or its HTTP status.');
    }
  }
  for (const [i, history] of records('nativeHistory').entries()) {
    if (!record(history) || history.protocolValidated !== true || history.selector?.kind !== 'history' || !Array.isArray(history.original?.entries)) continue;
    for (const [j, entry] of history.original.entries.entries()) {
      const message = entry?.message;
      if (message?.role !== 'assistant' || message.stopReason !== 'error') continue;
      const ref = { path, pointer: `/facts/nativeHistory/${i}/original/entries/${j}/message` };
      const error = typeof message.errorMessage === 'string' ? message.errorMessage : '';
      if (/\b402\b/.test(error) && /insufficient\s+balance/i.test(error)) balanceEvent(index, candidate, ref,
        typeof message.provider === 'string' && message.provider.trim() ? message.provider : model.provider,
        typeof message.model === 'string' && message.model.trim() ? message.model : model.model);
      else add(candidate, 'observed_failure', 'A native assistant error is recorded; raw error content is omitted.', 'provider', ref);
    }
  }
}
async function feedback(root: string, report: EvaluationReport) {
  let document: any;
  try { document = await readJson(root, 'review.json'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (document.contract !== 'medclaw-review/v1' || document.executionId !== report.executionId || !Array.isArray(document.feedback) || !Array.isArray(document.conflicts)) throw new Error('badcases_review_binding_invalid');
  const entries: { value: HumanFeedback; ref: BadcaseEvidenceRef }[] = [];
  for (const key of ['feedback', 'conflicts']) for (const [i, item] of document[key].entries()) {
    if (key === 'feedback' && (typeof item?.id !== 'string' || !item.id)) throw new Error('badcases_feedback_identity_invalid');
    const value = FeedbackSchema.parse(key === 'feedback' ? item.value : item);
    if (value.executionId !== report.executionId || !report.plan.some(trial => trial.trialId === value.trialId && trial.caseId === value.caseId)) throw new Error('feedback_identity_mismatch');
    entries.push({ value, ref: { path: 'review.json', pointer: `/${key}/${i}` } });
  }
  return entries;
}
async function evaluation(root: string, baselinePath?: string) {
  const report = await readReport(root), index = emptyIndex(report.executionId, 'evaluation'), reviews = await feedback(root, report);
  let baseline: EvaluationReport | undefined;
  if (baselinePath) {
    baseline = await readReport(rootOf(baselinePath));
    try { compareReports(baseline, report); index.comparison = { baselineExecutionId: baseline.executionId, status: 'comparable', gaps: [] }; }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('comparison_incompatible')) throw error;
      index.gaps.push('Recorded comparison conditions are incompatible; regression was not inferred.');
      index.comparison = { baselineExecutionId: baseline.executionId, status: 'incompatible', gaps: [...index.gaps] }; baseline = undefined;
    }
  }
  for (const [i, trial] of report.trials.entries()) {
    const candidate = candidateFor(report.executionId, 'trial', trial.trialId, trial.caseId), scores = report.scores.filter(score => score.trialId === trial.trialId);
    const automatic = (report.aggregation as Aggregation).trials.find(item => item.trialId === trial.trialId)!.status;
    candidate.statuses.push(trial.status, automatic);
    const task = report.snapshot.dataset.cases.find(task => task.id === trial.caseId)!;
    const trialRef = { path: 'report.json', pointer: `/trials/${i}` };
    if (['failed', 'infra_error', 'cancelled'].includes(trial.status)) {
      add(candidate, 'execution_failure', `Archived Trial execution status is ${trial.status}.`, 'execution', trialRef); candidate.statuses.push(trial.status);
    }
    if (trial.status === 'not_run' && /^(?:previous_trial_stop_or_save_unconfirmed|execution_cancelled_before_start|execution_interrupted|run_interrupted|blocked_by_interruption)(?:$|:)/.test(trial.reason ?? '')) {
      add(candidate, 'execution_blocked', 'The recorded Trial reason identifies an interrupted or unconfirmed prior execution.', 'execution', trialRef); candidate.statuses.push('NOT_RUN');
    }
    for (const score of scores) {
      if (!score.applicable || !['FAIL', 'ERROR', 'UNJUDGEABLE'].includes(score.status)) continue;
      candidate.checkIds.push(score.checkId); candidate.statuses.push(score.status);
      const position = report.scores.indexOf(score), ref = { path: 'report.json', pointer: `/scores/${position}` };
      add(candidate, `score_${score.status.toLowerCase()}`, `Recorded ${score.metricId} score is ${score.status}.`, score.method === 'llm-judge' ? 'judge' : score.metricId.split('.')[0]!, ref);
      if (score.status === 'UNJUDGEABLE') candidate.gaps.push(`Recorded check ${score.checkId} is unjudgeable; evidence completeness and scorer support require review. This is not a confirmed product failure.`);
      if (score.missing.length) { candidate.gaps.push(`${score.checkId} records ${score.missing.length} missing evidence item(s).`); addRef(candidate.evidenceRefs, { path: 'report.json', pointer: `/scores/${position}/missing` }); }
      if (score.evidenceRefs.length) addRef(candidate.evidenceRefs, { path: 'report.json', pointer: `/scores/${position}/evidenceRefs` });
    }
    if (trial.observationRef) observeFailures(index, candidate, await readJson(root, trial.observationRef), trial.observationRef, task, trial.status === 'completed', report.config.model);
    else candidate.gaps.push('The Trial has no archived observation.');
    const selected = reviews.filter(review => review.value.trialId === trial.trialId);
    if (selected.length && (new Set(selected.map(review => review.value.status)).size > 1 || ['PASS', 'FAIL', 'UNJUDGEABLE'].includes(automatic) && selected.some(review => review.value.status !== automatic))) {
      add(candidate, 'human_disagreement', 'Imported human feedback differs from an archived automatic outcome or another imported feedback record.', 'review', selected[0]!.ref);
    }
    for (const review of selected) {
      candidate.feedbackRefs.push(review.ref); addRef(candidate.evidenceRefs, review.ref);
      if (review.value.evidenceRefs.length) candidate.gaps.push('Imported feedback evidence references are retained in review.json; arbitrary feedback paths were not opened.');
    }
    if (baseline) {
      const previous = baseline.plan.find(item => item.caseId === trial.caseId && item.repetition === trial.repetition);
      for (const score of scores) {
        const prior = baseline.scores.find(item => item.trialId === previous?.trialId && item.checkId === score.checkId && item.metricId === score.metricId && item.version === score.version && item.method === score.method);
        if (!score.applicable || !prior?.applicable || prior.status !== 'PASS' || !['FAIL', 'ERROR', 'UNJUDGEABLE'].includes(score.status)) continue;
        add(candidate, 'comparable_regression', `Comparable archived check ${score.checkId} changed from PASS to ${score.status}.`, 'comparison', { path: 'report.json', pointer: `/scores/${report.scores.indexOf(score)}` });
        candidate.gaps.push('Baseline evidence is in the separately supplied validated archive; no cross-archive relative link is emitted.');
      }
    }
    if (candidate.signals.length) { addRef(candidate.evidenceRefs, trialRef); addRef(candidate.evidenceRefs, { path: 'snapshot.json', pointer: `/dataset/cases/${report.snapshot.dataset.cases.indexOf(task)}` }); index.candidates.push(candidate); }
  }
  return finish(index);
}

const text = z.string().min(1);
const judgement = z.union([z.literal(0), z.literal(.5), z.literal(1), z.null()]);
const sampleSchema = z.object({ id: ExecutionIdSchema, sourceId: text, partition: z.enum(['tune', 'validation']), answer: text, rubric: text, evidence: z.record(text, z.string()) });
const referenceSchema = z.object({ checker: text, method: z.enum(['independent-recomputation', 'source-audit', 'programmatic-check', 'agent-audit', 'human-review']), checkedAt: z.iso.datetime(), recordRef: RelativePathSchema, sourceRef: text, value: judgement, severe: z.boolean(), evidenceRefs: z.array(text).min(1) });
const resultSchema = z.object({ status: z.enum(['completed', 'error']), error: z.string().nullable(), results: z.array(z.object({ checkId: text, value: judgement, reason: z.string(), evidenceRefs: z.array(text) })), metadata: z.object({ baseUrl: text, model: text, timeoutMs: z.number().positive(), temperature: z.literal(.8), startedAt: z.iso.datetime(), endedAt: z.iso.datetime(), durationMs: z.number().nonnegative(), httpStatus: z.number().int().nullable(), requestId: z.string().nullable(), usage: z.object({ promptTokens: z.number().nullable(), completionTokens: z.number().nullable() }) }).passthrough() });
async function calibration(root: string, raw: any, baselinePath?: string) {
  const report = z.object({ contract: z.literal('medclaw-judge-calibration/v1'), executionId: ExecutionIdSchema, actualRun: z.boolean(), controlledFixture: z.boolean(), createdAt: z.iso.datetime(), model: text, passed: z.boolean(), assessment: z.object({ passed: z.boolean(), referenceIds: z.array(text), validation: z.number().int().nonnegative(), tune: z.number().int().nonnegative() }).passthrough() }).parse(raw);
  const snapshot = z.object({ contract: z.literal('medclaw-calibration-snapshot/v1'), executionId: ExecutionIdSchema, rubricVersion: z.literal('v1'), systemRubric: z.literal(ANSWER_QUALITY_RUBRIC), judge: JudgeConfigurationSchema, model: text, limits: z.object({ maxFalseAccept: z.number().min(0).max(1), maxFalseReject: z.number().min(0).max(1), maxSevereMiss: z.number().min(0).max(1) }), samples: z.array(sampleSchema).min(1) }).parse(await readJson(root, 'snapshot.json'));
  if (report.executionId !== snapshot.executionId || report.model !== snapshot.model || snapshot.judge.model !== snapshot.model || report.passed !== report.assessment.passed || report.actualRun === report.controlledFixture || new Set(snapshot.samples.map(sample => sample.id)).size !== snapshot.samples.length) throw new Error('calibration_archive_identity_mismatch');
  const validation = snapshot.samples.filter(sample => sample.partition === 'validation'), tune = snapshot.samples.filter(sample => sample.partition === 'tune');
  if (report.assessment.validation !== validation.length || report.assessment.tune !== tune.length || !isDeepStrictEqual(report.assessment.referenceIds, validation.map(sample => sample.id))) throw new Error('calibration_assessment_binding_invalid');
  const tuneSources = new Set(tune.map(sample => sample.sourceId)), tuneContent = new Set(tune.flatMap(sample => Object.values(sample.evidence)));
  if (validation.some(sample => tuneSources.has(sample.sourceId) || Object.values(sample.evidence).some(content => tuneContent.has(content)))) throw new Error('calibration_source_overlap');
  const index = emptyIndex(report.executionId, 'calibration');
  const assessed: CalibrationSample[] = [];
  if (baselinePath) index.gaps.push('Calibration archives are not comparable evaluation reports; comparison was not inferred.');
  for (const [i, sample] of snapshot.samples.entries()) {
    const statePath = `evidence/${sample.id}/trial.json`, observationPath = `evidence/${sample.id}/observation.json`, state = await readJson(root, statePath), observation = await readJson(root, observationPath);
    const reference = referenceSchema.parse(state.reference), result = resultSchema.parse(observation.result);
    assertJudgeCallMatches(snapshot.judge, result.metadata as Parameters<typeof assertJudgeCallMatches>[1]);
    const expectedRequest = { trialId: sample.id, checks: [{ checkId: sample.id, rubric: sample.rubric, evidenceRefs: Object.keys(sample.evidence) }], answer: sample.answer, evidence: sample.evidence };
    if (!isDeepStrictEqual(state.sample, sample) || !isDeepStrictEqual(state.request, expectedRequest) || !isDeepStrictEqual(observation.request, expectedRequest) || reference.recordRef !== statePath || !Object.hasOwn(sample.evidence, reference.sourceRef) || reference.evidenceRefs.some(ref => !Object.hasOwn(sample.evidence, ref))) throw new Error('calibration_reference_binding_invalid');
    if (result.status === 'completed' ? result.results.length !== 1 || result.results[0]!.checkId !== sample.id || result.error !== null : result.results.length !== 0 || result.error === null) throw new Error('calibration_result_identity_invalid');
    const judged = result.results[0];
    if (judged?.evidenceRefs.some(ref => !Object.hasOwn(sample.evidence, ref))) throw new Error('calibration_result_reference_invalid');
    assessed.push({ id: sample.id, sourceId: sample.sourceId, partition: sample.partition, reference, judgeValue: judged?.value ?? null, judgeEvidenceRefs: judged?.evidenceRefs ?? [] });
    try {
      const journal = (await readFile(await evidencePath(root, `evidence/${sample.id}/events.jsonl`), 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
      if (journal.length !== 2 || journal[0].kind !== 'judge.request' || journal[1].kind !== 'judge.result' || journal.some(event => !Number.isFinite(Date.parse(event.at))) || !isDeepStrictEqual(journal[0].request, state.request) || !isDeepStrictEqual(journal[1].result, observation.result)) throw new Error('calibration_journal_binding_invalid');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; index.gaps.push(`Calibration sample ${sample.id} has no archived event journal.`); }
    const candidate = candidateFor(report.executionId, 'sample', sample.id, null), ref = { path: observationPath, pointer: '/result' };
    if (result.status === 'error') { add(candidate, 'judge_error', 'The archived Judge call ended in error; raw error content is omitted.', 'judge', ref); candidate.statuses.push('ERROR'); }
    else if (judged!.value === null || reference.value === null) { add(candidate, 'calibration_unjudgeable', 'The archived Judge or independent reference has no judgment value.', 'judge', ref); candidate.statuses.push('UNJUDGEABLE'); }
    else if (judged!.value !== reference.value) { add(candidate, 'calibration_disagreement', `Archived Judge value ${judged!.value} differs from independent reference value ${reference.value}.`, 'judge', ref); candidate.statuses.push('FAIL'); }
    if (judged && (!judged.evidenceRefs.length || judged.evidenceRefs.some(ref => !reference.evidenceRefs.includes(ref)))) add(candidate, 'calibration_evidence_gap', 'Archived Judge evidence references do not match the independent reference evidence.', 'judge', ref);
    if (!candidate.signals.length) continue;
    candidate.checkIds.push(sample.id); candidate.facts.push(`Independent reference method: ${reference.method}.`);
    if (report.controlledFixture) candidate.facts.push('This archive is a controlled fixture; it is not a real Judge calibration gate result.');
    addRef(candidate.evidenceRefs, { path: statePath, pointer: '/reference' }); addRef(candidate.evidenceRefs, { path: 'snapshot.json', pointer: `/samples/${i}` }); addRef(candidate.evidenceRefs, { path: 'report.json', pointer: '/assessment' }); index.candidates.push(candidate);
  }
  // Validate the archived aggregate from recorded values; no answer is judged again.
  if (!isDeepStrictEqual(report.assessment, assessCalibration(assessed, snapshot.limits))) throw new Error('calibration_assessment_mismatch');
  if (!report.passed && !index.candidates.length) index.gaps.push('The archived calibration assessment failed without a supported per-sample disagreement; inspect its recorded coverage and limits.');
  return finish(index);
}

/** Derives local triage from recorded results; never reruns a scorer, Judge, export, or review workflow. */
export async function deriveBadcases(reportPath: string, baselinePath?: string): Promise<BadcaseIndex> {
  const root = rootOf(reportPath);
  if ((await lstat(root)).isSymbolicLink()) throw new Error('linked_execution_archive');
  const raw = await readJson(root, 'report.json');
  if (raw.contract === 'medclaw-evaluation-report/v1') return evaluation(root, baselinePath);
  if (raw.contract === 'medclaw-judge-calibration/v1') return calibration(root, raw, baselinePath);
  throw new Error('badcases_report_contract_invalid');
}
const markdownText = (value: string) => value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!).replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ');
function citation(ref: BadcaseEvidenceRef) {
  RelativePathSchema.parse(ref.path);
  if (ref.pointer !== undefined && !/^(?:\/(?:[^~]|~[01])*)*$/.test(ref.pointer)) throw new Error('badcases_evidence_pointer_invalid');
  if (ref.line !== undefined && (!Number.isSafeInteger(ref.line) || ref.line < 1)) throw new Error('badcases_evidence_line_invalid');
  const fragment = ref.pointer !== undefined ? '#' + encodeURIComponent(ref.pointer) : ref.line !== undefined ? '#L' + ref.line : '';
  return `[${markdownText(ref.path + (ref.pointer ?? (ref.line ? ':' + ref.line : '')))}](${ref.path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16))).join('/')}${fragment})`;
}
export function renderBadcases(index: BadcaseIndex): string {
  const lines = [`# Badcase candidates: ${markdownText(index.executionId)}`, '', `Archive kind: ${index.kind}. Candidates: ${index.summary.candidates}; signals: ${index.summary.signals}; affected Trials: ${index.summary.trials}; affected samples: ${index.summary.samples}; affected cases: ${index.summary.cases}; common events: ${index.summary.commonEvents}.`, '', 'Signals count distinct signal types per candidate, summed across candidates. Candidates are evidence-based triage signals; they do not establish human confirmation or a root cause.', ''];
  if (index.comparison) lines.push(`Comparison: ${index.comparison.status}; baseline ${markdownText(index.comparison.baselineExecutionId)}.`, '');
  for (const gap of index.gaps) lines.push(`- Gap: ${markdownText(gap)}`);
  if (index.gaps.length) lines.push('');
  for (const event of index.commonEvents) lines.push(`## Common event: ${markdownText(event.id)}`, '', ...event.facts.map(fact => `- ${markdownText(fact)}`), `- Candidates: ${event.candidateIds.map(markdownText).join(', ')}`, `- Evidence: ${event.evidenceRefs.map(citation).join(', ')}`, '');
  for (const candidate of index.candidates) {
    lines.push(`## ${markdownText(candidate.id)}`, '', `Case: ${markdownText(candidate.caseId ?? 'none')}; Trial: ${markdownText(candidate.trialId ?? 'none')}; sample: ${markdownText(candidate.sampleId ?? 'none')}.`, '',
      `- Signals: ${candidate.signals.map(markdownText).join(', ')}`, `- Recorded statuses: ${candidate.statuses.map(markdownText).join(', ') || 'none'}`, `- Checks: ${candidate.checkIds.map(markdownText).join(', ') || 'none'}`, `- Suspected nodes: ${candidate.suspectedNodes.map(markdownText).join(', ') || 'unknown'}`,
      ...(candidate.runIds ? [`- Related identities: Runs ${candidate.runIds.join(', ') || 'none recorded'}; model calls ${candidate.callIds.map(markdownText).join(', ') || 'none recorded'}; operations ${candidate.operationRefs.map(markdownText).join(', ') || 'none recorded'}.`] : []),
      ...candidate.facts.map(fact => `- Fact: ${markdownText(fact)}`), ...candidate.hypotheses.map(hypothesis => `- Hypothesis: ${markdownText(hypothesis)}`), ...candidate.gaps.map(gap => `- Gap: ${markdownText(gap)}`),
      `- Common events: ${candidate.commonEventIds.map(markdownText).join(', ') || 'none'}`, `- Feedback: ${candidate.feedbackRefs.map(citation).join(', ') || 'none recorded'}`, `- Evidence: ${candidate.evidenceRefs.map(citation).join(', ')}`, '');
  }
  if (!index.candidates.length) lines.push('No candidates were identified from the recorded evidence.', '');
  return lines.join('\n');
}
export async function writeBadcases(reportPath: string): Promise<BadcaseIndex> {
  const root = rootOf(reportPath), index = await deriveBadcases(reportPath);
  if (!index.candidates.length && !index.commonEvents.length && !index.gaps.length) return index;
  const json = JSON.stringify(index, null, 2) + '\n', markdown = renderBadcases(index);
  const lockPath = join(root, '.badcases.lock'), lock = await open(lockPath, 'wx', 0o600); await lock.close();
  const existing = async (path: string) => { try { return await readFile(await evidencePath(root, path), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
  try {
    const oldJson = await existing('badcases.json'), oldMarkdown = await existing('badcases.md');
    if (oldJson === json && oldMarkdown === markdown) return index;
    if (oldJson !== null && oldMarkdown !== null) {
      try {
        const old = JSON.parse(oldJson);
        if (old.contract !== index.contract || old.executionId !== index.executionId || old.kind !== index.kind || renderBadcases(old) !== oldMarkdown) throw new Error('conflict');
      } catch { throw new Error('badcases_output_conflict'); }
    } else if (oldJson !== null && oldJson !== json || oldMarkdown !== null && oldMarkdown !== markdown) throw new Error('badcases_output_conflict');
    if (oldJson === null) await writeJsonExclusive(join(root, 'badcases.json'), index);
    else if (oldJson !== json) await replaceJson(join(root, 'badcases.json'), index);
    if (oldMarkdown === null) await writeFileExclusive(join(root, 'badcases.md'), markdown);
    else if (oldMarkdown !== markdown) {
      const temporary = join(root, `badcases.md.${randomUUID()}.tmp`);
      try { await writeFileExclusive(temporary, markdown); await rename(temporary, join(root, 'badcases.md')); }
      finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    }
    return index;
  } finally { await unlink(lockPath); }
}
