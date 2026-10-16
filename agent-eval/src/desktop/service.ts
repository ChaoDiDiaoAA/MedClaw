import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  EvaluationPathsSchema, EvaluationRunOptionsSchema, EvaluationPaginationSchema, evaluationMethodSchemas,
  DesktopEvaluationRequestSchema, EvaluationOperationRefSchema,
  EvaluationExportViewSchema, type EvaluationExportView, type EvaluationPaths, type EvaluationPayload, type EvaluationRunOptions, type EvaluationReportSummary,
} from '../../../packages/contracts/src/evaluation';
import { loadDataset, loadSnapshot } from '../datasets';
import { sourceInventory, runBlockers } from '../doctor';
import { parseTrials, planTrials } from '../execution/runner';
import { readPresetEnvironment } from '../presets';
import { resolveRunConfig } from '../scoring/judges/client';
import { readReport, readPartialExecution, evidencePath } from '../reports/write';
import { compareReports } from '../reports/compare';
import { readReview, recordFeedback, FeedbackSchema } from '../review/store';
import { inspectExport, exportReport, platformConfig } from '../langfuse/export';
import { readSyncState, syncReview } from '../review/platform';
import { diagnostic, pageItems, projectSummary, projectReportSection, projectEvidence, summarizeValue, unreadableSummary, safeText } from './presentation';

const sourceKeys = ['sdk', 'patch', 'packageJson', 'files'] as const;
const runtimeSource = (source: Record<string, unknown>) => Object.fromEntries(sourceKeys.map(key => [key, source[key]]));
const errorCode = (error: unknown) => error instanceof Error && ['execution_id_ambiguous', 'linked_execution_archive', 'execution_report_not_found', 'report_snapshot_identity_mismatch', 'partial_snapshot_invalid'].includes(error.message) ? error.message : 'evaluation_archive_invalid';
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export interface PreparedPlatformTask { execute(): Promise<unknown>; readState(page?: number, pageSize?: number): Promise<EvaluationExportView> }
export class EvaluationService {
  readonly paths: EvaluationPaths;
  private startupSource: Record<string, unknown> | null = null;
  private runtimeChanged = false;
  private secrets: string[] = [];
  private readonly preflights = new Map<string, { options: EvaluationRunOptions; originals: unknown }>();
  constructor(paths: EvaluationPaths) { this.paths = EvaluationPathsSchema.parse(paths); }
  async initializeRuntime() { if (this.startupSource === null) this.startupSource = runtimeSource(await sourceInventory()); }
  private async readSource() {
    if (this.runtimeChanged) throw new Error('evaluation_runtime_changed');
    if (this.startupSource === null) throw new Error('host_not_ready');
    const source = await sourceInventory();
    if (!isDeepStrictEqual(this.startupSource, runtimeSource(source))) { this.runtimeChanged = true; throw new Error('evaluation_runtime_changed'); }
    return source;
  }
  private async readEnvironment() {
    const env = await readPresetEnvironment(this.paths.sourceRoot, this.paths.configsRoot);
    this.secrets = [...new Set([...this.secrets, ...Object.entries(env).flatMap(([key, value]) => value && /key|secret|password/i.test(key) ? [value] : [])])];
    return env;
  }
  private async readProjectionSecrets() {
    try { await this.readEnvironment(); } catch {}
    try {
      const raw = JSON.parse(await readFile(join(this.paths.configsRoot, 'agent.json'), 'utf8'));
      if (typeof raw?.model?.key === 'string') this.secrets = [...new Set([...this.secrets, raw.model.key])];
    } catch {}
  }
  private async prepare(input: EvaluationRunOptions) {
    const options = EvaluationRunOptionsSchema.parse(input);
    if (!['medclaw-agent-v1', 'medclaw-badcase-v1'].includes(options.datasetId)) throw new Error('invalid_argument');
    const source = await this.readSource(), dataset = await loadDataset(options.datasetId);
    const members = options.selection === 'smoke' ? dataset.manifest.smoke : dataset.manifest.members;
    const trials = parseTrials(options.trials === undefined ? undefined : String(options.trials), options.selection);
    const plan = planTrials(members, trials), judged = plan.filter(item => dataset.cases.find(task => task.id === item.caseId)!.expected.checks.some(check => check.kind === 'llm-judge'));
    const blockers = runBlockers(dataset, source).map(code => diagnostic(code));
    let resolved: Awaited<ReturnType<typeof resolveRunConfig>> | null = null, platformConfigured = false, raw: unknown = null, env: Record<string, string | undefined> = {};
    try { env = await this.readEnvironment(); try { platformConfig(env); platformConfigured = true; } catch {} } catch {}
    try {
      raw = JSON.parse(await readFile(join(this.paths.configsRoot, 'agent.json'), 'utf8'));
      this.secrets = [...this.secrets,
        ...(raw && typeof raw === 'object' && 'model' in raw && raw.model && typeof raw.model === 'object' && 'key' in raw.model && typeof raw.model.key === 'string' ? [raw.model.key] : [])];
      resolved = await resolveRunConfig(raw, env, 'required', judged.length > 0);
    } catch { blockers.push(diagnostic('evaluation_config_unavailable')); }
    let lock: string | null = null;
    try { lock = await readFile(await evidencePath(join(this.paths.runsRoot, 'business'), '.active-execution.json'), 'utf8'); blockers.push(diagnostic('runtime_busy')); } catch (error) { if (!absent(error)) blockers.push(diagnostic('stop_unconfirmed')); }
    return { options: { ...options, trials }, dataset, plan, judged, resolved, source, env, blockers, platformConfigured,
      originals: { options: { ...options, trials }, dataset: dataset.snapshot, source, raw, env, lock } };
  }
  async preflight(input: EvaluationRunOptions) {
    const prepared = await this.prepare(input), preflightId = randomUUID();
    this.preflights.clear(); this.preflights.set(preflightId, { options: prepared.options, originals: prepared.originals });
    return { preflightId, datasetId: prepared.options.datasetId, selection: prepared.options.selection, trials: prepared.options.trials,
      cases: prepared.plan.length / prepared.options.trials, plannedTrials: prepared.plan.length, judgeRequestLimit: prepared.judged.length,
      readiness: prepared.dataset.manifest.readiness, config: prepared.resolved ? summarizeValue({ agent: prepared.resolved.config.model.model,
        endpoint: prepared.resolved.config.model.definition?.baseUrl, intent: prepared.resolved.config.intent.model, judge: prepared.resolved.config.judge?.model,
        policy: prepared.resolved.config.policy, retention: prepared.resolved.config.retention }, this.secrets) : null,
      platformConfigured: prepared.platformConfigured, blockers: prepared.blockers };
  }
  async prepareRun(input: EvaluationPayload<'eval.start'>) {
    const { preflightId, ...options } = evaluationMethodSchemas['eval.start'].input.parse(input), previous = this.preflights.get(preflightId);
    const prepared = await this.prepare(options);
    if (!previous || !isDeepStrictEqual(previous.options, prepared.options) || !isDeepStrictEqual(previous.originals, prepared.originals)) throw new Error('config_conflict');
    if (prepared.blockers.length || !prepared.resolved) throw new Error(prepared.blockers[0]?.code ?? 'config_read_failed');
    return { ...prepared, ...prepared.resolved, expectedSource: this.startupSource! };
  }
  async findOriginal(executionId: string) {
    let root: string;
    try { root = await this.archiveRoot(executionId); }
    catch (error) { if (error instanceof Error && error.message === 'execution_report_not_found') return { exists: false, request: null }; throw error; }
    try {
      const snapshot = JSON.parse(await readFile(await evidencePath(root, 'snapshot.json'), 'utf8'));
      const parsed = DesktopEvaluationRequestSchema.safeParse(snapshot.desktopRequest);
      if (snapshot.contract !== 'medclaw-execution-snapshot/v1' || snapshot.executionId !== executionId || !parsed.success || executionId !== 'desktop-' + parsed.data.operationRef) return { exists: true, request: null };
      const request = parsed.data, dataset = loadSnapshot(snapshot.dataset);
      const members = request.selection === 'smoke' ? dataset.manifest.smoke : dataset.manifest.members;
      return { exists: true, request: request.datasetId === dataset.manifest.id && isDeepStrictEqual(snapshot.plan, planTrials(members, request.trials)) ? request : null };
    } catch { return { exists: true, request: null }; }
  }
  async readActiveExecution(): Promise<string | null> {
    try {
      const path = await evidencePath(join(this.paths.runsRoot, 'business'), '.active-execution.json');
      const lock = JSON.parse(await readFile(path, 'utf8'));
      return evaluationMethodSchemas['eval.cancel'].input.parse({ executionId: lock.executionId }).executionId;
    } catch (error) { if (absent(error)) return null; throw new Error('artifact_not_ready'); }
  }
  async executionFacts(executionId: string): Promise<{ summary: EvaluationReportSummary | null; stopConfirmed: boolean | null; saveConfirmed: boolean | null }> {
    try {
      const { root, archive } = await this.readArchive(executionId), complete = 'contract' in archive;
      const plan = complete ? archive.plan : archive.snapshot.plan!;
      let stopped = archive.trials.length === plan.length;
      for (const trial of archive.trials) {
        const stored = JSON.parse(await readFile(await evidencePath(root, 'evidence/' + trial.trialId + '/trial.json'), 'utf8'));
        const proof = stored.lifecycle?.shutdown ?? stored.lifecycle?.['startup-shutdown'];
        if (proof || trial.startedAt !== null || ['host_stop_unconfirmed', 'trial_exception_stop_unknown', 'necessary_save_unconfirmed'].includes(trial.reason ?? '')) {
          if (trial.stopped !== true || trial.closed !== true || proof?.stopped !== true || proof?.closed !== true || proof?.processExited !== true || !Array.isArray(proof.residuals) || proof.residuals.length) stopped = false;
        }
      }
      return { summary: projectSummary(archive, this.secrets), stopConfirmed: stopped ? true : null, saveConfirmed: complete ? true : null };
    } catch { return { summary: null, stopConfirmed: null, saveConfirmed: null }; }
  }
  private async archiveRoot(executionId: string) {
    evaluationMethodSchemas['eval.cancel'].input.parse({ executionId });
    const roots: string[] = [];
    for (const category of ['business', 'research']) {
      const directory = join(this.paths.runsRoot, category), root = join(directory, executionId);
      try {
        for (const path of [directory, root]) { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('linked_execution_archive'); }
        roots.push(root);
      } catch (error) { if (!absent(error)) throw error; }
    }
    if (roots.length !== 1) throw new Error(roots.length ? 'execution_id_ambiguous' : 'execution_report_not_found');
    return roots[0]!;
  }
  private async readArchive(executionId: string) {
    // Report browsing must redact known keys even when Check has never succeeded.
    await this.readProjectionSecrets();
    const root = await this.archiveRoot(executionId);
    let final = false;
    try { await evidencePath(root, 'report.json'); final = true; } catch (error) { if (!absent(error)) throw error; }
    const archive = final ? await readReport(root) : await readPartialExecution(root);
    if (archive.snapshot.executionId !== executionId) throw new Error('report_snapshot_identity_mismatch');
    return { root, archive };
  }
  async listReports(input: EvaluationPayload<'eval.report.list'>) {
    const { page, pageSize } = EvaluationPaginationSchema.parse(input), ids = new Set<string>();
    for (const category of ['business', 'research']) {
      try { for (const entry of await readdir(join(this.paths.runsRoot, category), { withFileTypes: true })) if (entry.isDirectory() || entry.isSymbolicLink()) ids.add(entry.name); }
      catch (error) { if (!absent(error)) throw error; }
    }
    const reports: EvaluationReportSummary[] = [];
    for (const id of ids) {
      if (!evaluationMethodSchemas['eval.cancel'].input.safeParse({ executionId: id }).success) continue;
      try { reports.push(projectSummary((await this.readArchive(id)).archive, this.secrets)); }
      catch (error) { reports.push(unreadableSummary(id, errorCode(error))); }
    }
    reports.sort((a, b) => ((b.createdAt ?? b.startedAt) ?? '').localeCompare((a.createdAt ?? a.startedAt) ?? '') || a.executionId.localeCompare(b.executionId));
    return pageItems(reports, page, pageSize);
  }
  async readReportSection(input: EvaluationPayload<'eval.report.read'>) {
    const request = evaluationMethodSchemas['eval.report.read'].input.parse(input), { archive, root } = await this.readArchive(request.executionId);
    if (request.section !== 'feedback') return projectReportSection(archive, request, this.secrets);
    if (!('contract' in archive)) throw new Error('artifact_not_ready');
    const review = await readReview(root), values = [...review.feedback.map(item => ({ id: item.id, value: item.value, conflict: false })), ...review.conflicts.map(value => ({ id: value.sourceId, value, conflict: true }))];
    const items = values.map(item => { const value = FeedbackSchema.parse(item.value);
      if (value.executionId !== archive.executionId || !archive.plan.some(trial => trial.trialId === value.trialId && trial.caseId === value.caseId)) throw new Error('feedback_identity_mismatch');
      return { id: item.id, source: value.source, sourceId: value.sourceId, reviewer: safeText(value.reviewer, this.secrets), reviewedAt: value.reviewedAt,
      executionId: value.executionId, caseId: value.caseId, trialId: value.trialId, status: value.status, comment: safeText(value.comment, this.secrets), evidenceRefs: value.evidenceRefs, conflict: item.conflict }; })
      .filter(item => (!request.caseId || item.caseId === request.caseId) && (!request.trialId || item.trialId === request.trialId));
    return evaluationMethodSchemas['eval.report.read'].output.parse({ section: 'feedback', executionId: request.executionId, archiveState: 'complete', ...pageItems(items, request.page, request.pageSize) });
  }
  async readExportState(executionId: string, page = 1, pageSize = 50) {
    const { root, archive } = await this.readArchive(executionId);
    if (!('contract' in archive)) throw new Error('artifact_not_ready');
    const empty = { exportExists: false, state: 'disabled' as const, accepted: 0, rejected: 0, unknown: 0, remaining: 0, receipts: pageItems([], page, pageSize) };
    try { await evidencePath(root, 'export.json'); } catch (error) { if (absent(error)) return empty; throw error; }
    const { document } = await inspectExport(root), receipts = document.state.receipts;
    return { exportExists: true, state: document.state.state, accepted: receipts.filter(item => item.state === 'accepted').length,
      rejected: receipts.filter(item => item.state === 'rejected').length, unknown: receipts.filter(item => item.state === 'unknown').length,
      remaining: document.envelope.events.filter(event => !receipts.some(receipt => receipt.eventId === event.id)).length, receipts: pageItems(receipts.map(item => ({ ...item, safeError: item.safeError === null ? null : safeText(item.safeError, this.secrets) })), page, pageSize) };
  }
  async recordLocalFeedback(input: EvaluationPayload<'eval.review.record'>, operationRef: string) {
    EvaluationOperationRefSchema.parse(operationRef);
    const request = evaluationMethodSchemas['eval.review.record'].input.parse(input), { root, archive } = await this.readArchive(request.executionId);
    if (!('contract' in archive)) throw new Error('artifact_not_ready');
    if (request.evidenceRefs.some(ref => !archive.scores.some(score => score.trialId === request.trialId && score.evidenceRefs.includes(ref)))) throw new Error('access_denied');
    await this.readReportSection({ executionId: request.executionId, section: 'feedback', page: 1, pageSize: 1 });
    const sourceId = 'desktop-' + operationRef, prior = (await readReview(root)).feedback.find(record => record.value.source === 'local' && record.value.sourceId === sourceId);
    return recordFeedback(root, { ...request, contract: 'medclaw-human-feedback/v1', source: 'local', sourceId, reviewedAt: prior?.value.reviewedAt ?? new Date().toISOString() });
  }
  async readPlatformState(executionId: string, kind: 'resend' | 'review_sync', page = 1, pageSize = 50): Promise<EvaluationExportView> {
    if (kind === 'resend') return EvaluationExportViewSchema.parse(await this.readExportState(executionId, page, pageSize));
    const { root, archive } = await this.readArchive(executionId);
    if (!('contract' in archive)) throw new Error('artifact_not_ready');
    await this.readReportSection({ executionId, section: 'feedback', page: 1, pageSize: 1 });
    const state = await readSyncState(root); let exportExists = true;
    try { await evidencePath(root, 'export.json'); } catch (error) { if (absent(error)) exportExists = false; else throw error; }
    return EvaluationExportViewSchema.parse({ exportExists, state: state.state, accepted: state.receipts.filter(receipt => receipt.state === 'accepted').length,
      rejected: state.receipts.filter(receipt => receipt.state === 'rejected').length, unknown: state.receipts.filter(receipt => receipt.state === 'unknown').length,
      remaining: state.remaining, receipts: pageItems(state.receipts.map(receipt => ({ eventId: receipt.id, state: receipt.state, receivedAt: receipt.receivedAt,
        safeError: receipt.safeError === null ? null : safeText(receipt.safeError, this.secrets) })), page, pageSize) });
  }
  private async platformConfiguration() {
    let env: Record<string, string | undefined>;
    try { env = await this.readEnvironment(); } catch { throw new Error('langfuse_config_incomplete'); }
    return platformConfig(env);
  }
  async startResend(executionId: string, signal: AbortSignal): Promise<PreparedPlatformTask> {
    const { root, archive } = await this.readArchive(executionId);
    if (!('contract' in archive)) throw new Error('artifact_not_ready');
    if (!archive.trials.some(trial => trial.startedAt)) throw new Error('export_no_started_trials');
    const config = await this.platformConfiguration();
    return { execute: () => exportReport(root, 'langfuse', config, signal), readState: (page, pageSize) => this.readPlatformState(executionId, 'resend', page, pageSize) };
  }
  async startReviewSync(executionId: string, signal: AbortSignal): Promise<PreparedPlatformTask> {
    const { root, archive } = await this.readArchive(executionId);
    if (!('contract' in archive)) throw new Error('artifact_not_ready');
    const state = await this.readPlatformState(executionId, 'review_sync');
    if (state.receipts.total + state.remaining === 0) throw new Error('review_no_local_feedback');
    const config = await this.platformConfiguration();
    return { execute: () => syncReview(root, config, signal), readState: (page, pageSize) => this.readPlatformState(executionId, 'review_sync', page, pageSize) };
  }
  async compare(baselineExecutionId: string, candidateExecutionId: string) {
    const baseline = await this.readArchive(baselineExecutionId), candidate = await this.readArchive(candidateExecutionId);
    if (!('contract' in baseline.archive) || !('contract' in candidate.archive)) throw new Error('artifact_not_ready');
    return { baselineExecutionId, candidateExecutionId, comparison: summarizeValue(compareReports(baseline.archive, candidate.archive), this.secrets) };
  }
  async readEvidence(input: EvaluationPayload<'eval.evidence.read'>) {
    const request = evaluationMethodSchemas['eval.evidence.read'].input.parse(input), { archive, root } = await this.readArchive(request.executionId);
    if (!archive.scores.some(score => score.trialId === request.trialId && score.evidenceRefs.includes(request.evidenceRef))) throw new Error('access_denied');
    const trial = archive.trials.find(item => item.trialId === request.trialId);
    if (!trial || !trial.observationRef) throw new Error('artifact_not_ready');
    const observation = JSON.parse(await readFile(await evidencePath(root, trial.observationRef), 'utf8'));
    if (/https?:|[\\]|\.\./.test(request.evidenceRef)) throw new Error('access_denied');
    return { executionId: request.executionId, trialId: request.trialId, evidenceRef: request.evidenceRef,
      ...projectEvidence(observation.facts ?? {}, request.evidenceRef, this.secrets, request.page, request.pageSize) };
  }
}
