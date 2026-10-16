import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { AppErrorSchema, errorMessage, safeError, type Result } from '../../../../packages/contracts/src/error';
import {
  DesktopEvaluationRequestSchema, EvaluationControlViewSchema, EvaluationNoticeSchema, EvaluationOperationRefSchema, ExecutionIdSchema, evaluationMethodSchemas,
  type EvaluationControlView, type EvaluationNotice, type EvaluationPayload, type EvaluationReturn, type EvaluationDiagnostic, type EvaluationValueSummary,
} from '../../../../packages/contracts/src/evaluation';
import type { DesktopBridge } from './App';

const pendingKey = 'medclaw.evaluation.pending.v1';
const PendingRunSchema = DesktopEvaluationRequestSchema.extend({ operationKind: z.literal('run') });
const PendingFeedbackSchema = z.strictObject({ operationKind: z.literal('review_record'), operationRef: EvaluationOperationRefSchema,
  executionId: ExecutionIdSchema, caseId: ExecutionIdSchema, trialId: ExecutionIdSchema });
const PendingPlatformSchema = z.strictObject({ operationKind: z.enum(['resend', 'review_sync']), operationRef: EvaluationOperationRefSchema, executionId: ExecutionIdSchema });
const PendingOperationSchema = z.discriminatedUnion('operationKind', [PendingRunSchema, PendingFeedbackSchema, PendingPlatformSchema]);
const PendingSchema = z.strictObject({ schemaVersion: z.literal(1), run: PendingRunSchema.nullable(), feedback: PendingFeedbackSchema.nullable(), platform: PendingPlatformSchema.nullable() });
type PendingOperation = z.infer<typeof PendingOperationSchema>;
type Pending = z.infer<typeof PendingSchema>;
type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const emptyPending = (): Pending => ({ schemaVersion: 1, run: null, feedback: null, platform: null });
const pendingSlot = (kind: PendingOperation['operationKind']) => kind === 'run' ? 'run' : kind === 'review_record' ? 'feedback' : 'platform';
const recoveryMessage = 'Evaluation recovery is unavailable. Existing results remain readable.';

export function readEvaluationPending(storage: RecoveryStorage): Pending {
  const raw = storage.getItem(pendingKey);
  return raw === null ? emptyPending() : PendingSchema.parse(JSON.parse(raw));
}
export function rememberEvaluationOperation(storage: RecoveryStorage, raw: unknown): Pending {
  const operation = PendingOperationSchema.parse(raw), pending = readEvaluationPending(storage), slot = pendingSlot(operation.operationKind), previous = pending[slot];
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(operation)) throw new Error('pending_evaluation_conflict');
    return pending;
  }
  const next = PendingSchema.parse({ ...pending, [slot]: operation });
  storage.setItem(pendingKey, JSON.stringify(next));
  return next;
}
export function clearEvaluationOperation(storage: RecoveryStorage, kind: PendingOperation['operationKind'], operationRef: string): Pending {
  const pending = readEvaluationPending(storage), slot = pendingSlot(kind);
  if (pending[slot]?.operationRef !== operationRef) return pending;
  const next = { ...pending, [slot]: null };
  if (!next.run && !next.feedback && !next.platform) storage.removeItem(pendingKey);
  else storage.setItem(pendingKey, JSON.stringify(next));
  return next;
}

function checkedEvaluationNotice(raw: unknown): EvaluationNotice | null {
  const parsed = EvaluationNoticeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const notice = parsed.data;
  if (notice.type === 'eval.status' && (notice.control.controllerInstanceId !== notice.controllerInstanceId || notice.control.executionId !== notice.executionId || notice.control.sequence !== notice.sequence)) return null;
  return notice;
}
export function mergeEvaluationNotice(current: EvaluationControlView, raw: EvaluationNotice): EvaluationControlView {
  const notice = checkedEvaluationNotice(raw);
  if (!notice) return current;
  if (notice.controllerInstanceId !== current.controllerInstanceId || notice.sequence <= current.sequence) return current;
  if (notice.type === 'eval.status') return notice.control;
  if (current.operationKind !== 'run' || !['starting', 'running', 'cancelling'].includes(current.state) || notice.executionId !== current.executionId) return current;
  return { ...current, sequence: notice.sequence, progress: notice.progress };
}
export function evaluationExecutionBlockReason(control: EvaluationControlView | null): string | null {
  if (!control || control.blockReasons.some(reason => reason.code === 'external_execution_lock')) return null;
  if (control.state === 'unknown' || control.stopConfirmed !== true || control.saveConfirmed !== true) return 'Evaluation stop or save is unconfirmed. Check its status before new execution.';
  if (['starting', 'running', 'cancelling'].includes(control.state)) return 'An evaluation action is running. Wait for it to stop and save before new execution.';
  return null;
}

type CurrentStatusBridge = {
  request(method: 'eval.status', payload: EvaluationPayload<'eval.status'>): Promise<Result<EvaluationControlView>>;
  subscribe: DesktopBridge['subscribe'];
};
export function watchEvaluationControl(bridge: CurrentStatusBridge, onChange: (control: EvaluationControlView) => void, onError: (message: string | null) => void) {
  let current: EvaluationControlView | null = null, disposed = false, reading: Promise<void> | null = null;
  // Keep the latest status and progress per instance until the first snapshot establishes its identity.
  const buffered = new Map<string, EvaluationNotice>();
  const release = bridge.subscribe(raw => {
    if (disposed || raw.type !== 'eval.status' && raw.type !== 'eval.progress') return;
    const { instanceId, ...payload } = raw;
    if (instanceId !== null) return;
    const notice = checkedEvaluationNotice(payload);
    if (!notice) { onError('An evaluation update could not be confirmed. Refresh its status.'); void refresh(); return; }
    if (!current) {
      const key = notice.controllerInstanceId + ':' + notice.type, previous = buffered.get(key);
      if (!previous || previous.sequence < notice.sequence) buffered.set(key, notice);
      return;
    }
    const next = mergeEvaluationNotice(current, notice);
    if (next !== current) { current = next; onChange(next); }
  });
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (reading) return reading;
    reading = Promise.resolve().then(async () => {
      try {
        if (disposed) return;
        const result = await bridge.request('eval.status', {});
        if (disposed) return;
        if (!result.ok) { onError(errorMessage(result.error)); return; }
        const snapshot = EvaluationControlViewSchema.parse(result.data);
        if (current && current.controllerInstanceId !== snapshot.controllerInstanceId) { onError('The evaluation connection changed. Reload this page before another action.'); return; }
        let next = current && current.sequence >= snapshot.sequence ? current : snapshot;
        for (const notice of [...buffered.values()].sort((a, b) => a.sequence - b.sequence)) next = mergeEvaluationNotice(next, notice);
        buffered.clear(); current = next; onChange(next); onError(null);
      } catch { if (!disposed) onError('Evaluation status could not be confirmed. Refresh its status.'); }
      finally { reading = null; }
    });
    return reading;
  }
  return { refresh, dispose() { disposed = true; buffered.clear(); release(); } };
}

export function useEvaluationControl() {
  const [control, setControl] = useState<EvaluationControlView | null>(null), [error, setError] = useState<string | null>(null);
  const watcher = useRef<ReturnType<typeof watchEvaluationControl> | null>(null);
  const [recovery, setRecovery] = useState(() => {
    try { return { pending: readEvaluationPending(window.sessionStorage), error: null as string | null }; }
    catch { return { pending: emptyPending(), error: recoveryMessage }; }
  });
  useEffect(() => {
    try {
      const live = watchEvaluationControl(window.medclaw, setControl, setError); watcher.current = live;
      void live.refresh();
      return () => { watcher.current = null; live.dispose(); };
    } catch { setError('Evaluation status is unavailable. Refresh its status before another evaluation.'); }
  }, []);
  const refresh = useCallback(() => watcher.current?.refresh() ?? Promise.resolve(), []);
  const remember = useCallback((operation: PendingOperation) => {
    try { setRecovery({ pending: rememberEvaluationOperation(window.sessionStorage, operation), error: null }); }
    catch (error) {
      if (error instanceof Error && error.message === 'pending_evaluation_conflict') throw safeError('state_conflict');
      setRecovery(previous => ({ ...previous, error: recoveryMessage })); throw safeError('storage_write_failed');
    }
  }, []);
  const confirm = useCallback((kind: PendingOperation['operationKind'], operationRef: string) => {
    try { setRecovery({ pending: clearEvaluationOperation(window.sessionStorage, kind, operationRef), error: null }); return true; }
    catch { setRecovery(previous => ({ ...previous, error: recoveryMessage })); return false; }
  }, []);
  return { control, error, refresh, pending: recovery.pending, recoveryError: recovery.error, remember, confirm };
}

const controlLabels = { idle: 'Idle', starting: 'Starting', running: 'Running', cancelling: 'Stopping', settled: 'Finished', blocked: 'Blocked', unknown: 'Unconfirmed' };
const proofLabel = (value: boolean | null) => value === true ? 'Confirmed' : value === false ? 'Unconfirmed' : 'Unknown';
export function smallerEvaluationPage(page: number, pageSize: number) {
  if (pageSize <= 1) return null;
  const size = Math.max(1, Math.floor(pageSize / 2));
  return { page: Math.floor(((page - 1) * pageSize) / size) + 1, pageSize: size };
}
function ValueSummary({ value }: { value: EvaluationValueSummary }) {
  return <><pre className="json-facts">{value.text}</pre>{value.redacted && <p className="tiny">Sensitive values are hidden.</p>}{value.truncated && <p className="tiny">Shortened summary. The original value is preserved.</p>}</>;
}
type ReportQuery = EvaluationPayload<'eval.report.read'> & { page: number; pageSize: number };
type Section = EvaluationReturn<'eval.report.read'>;
const sections = ['summary', 'cases', 'trials', 'scores', 'coverage', 'feedback', 'diagnostics'] as const;
type Feedback = Extract<Section, { section: 'feedback' }>['items'][number];
type ReviewTarget = Pick<EvaluationPayload<'eval.review.record'>, 'executionId' | 'caseId' | 'trialId' | 'evidenceRefs'>;
export async function findEvaluationFeedback(bridge: Pick<DesktopBridge, 'request'>, pending: z.infer<typeof PendingFeedbackSchema>): Promise<Feedback | null> {
  let page = 1, pageSize = 50, total: number | null = null;
  for (;;) {
    const result = await bridge.request('eval.report.read', { executionId: pending.executionId, section: 'feedback', page, pageSize });
    if (!result.ok) {
      const smaller = result.error.code === 'report_page_too_large' ? smallerEvaluationPage(page, pageSize) : null;
      if (smaller) { ({ page, pageSize } = smaller); continue; }
      throw result.error;
    }
    const view = evaluationMethodSchemas['eval.report.read'].output.parse(result.data);
    if (view.section !== 'feedback' || view.executionId !== pending.executionId || view.page !== page || view.pageSize !== pageSize || total !== null && total !== view.total) throw safeError('state_conflict');
    total = view.total;
    const found = view.items.find(item => item.source === 'local' && item.sourceId === 'desktop-' + pending.operationRef && item.executionId === pending.executionId && item.caseId === pending.caseId && item.trialId === pending.trialId);
    if (found) return found;
    if (page * pageSize >= total) return null;
    page++;
  }
}

function EvaluationReview({ visible, summary, target, evaluation, platformConfigured, productionBlockReason }: {
  visible: boolean; summary: EvaluationReturn<'eval.report.list'>['items'][number] | null; target: ReviewTarget | null;
  evaluation: ReturnType<typeof useEvaluationControl>; platformConfigured: boolean | null; productionBlockReason: string | null;
}) {
  const [reviewer, setReviewer] = useState(''), [comment, setComment] = useState(''), [status, setStatus] = useState<'PASS' | 'FAIL' | 'UNJUDGEABLE'>('UNJUDGEABLE');
  const [refs, setRefs] = useState<string[]>([]), [feedbackMessage, setFeedbackMessage] = useState<string | null>(null), [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false), submittingRef = useRef(false), recoveryOrder = useRef(0);
  const [recovering, setRecovering] = useState(false), [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<{ kind: 'resend' | 'review_sync'; view: EvaluationControlView } | null>(null), [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [delivering, setDelivering] = useState(false), deliveryRef = useRef(false), deliveryOrder = useRef(0);
  const [localFeedback, setLocalFeedback] = useState(false), [pendingRead, setPendingRead] = useState<string | null>(null);
  const deliveryKind = useRef<'resend' | 'review_sync'>('review_sync'), targetRef = useRef(target); targetRef.current = target;
  const executionId = summary?.executionId, selectedRef = useRef(executionId); selectedRef.current = executionId;
  const full = summary?.archiveState === 'complete', blockReason = evaluationExecutionBlockReason(evaluation.control);
  const writeBlocked = !!blockReason || !!evaluation.error || !evaluation.control || !!evaluation.recoveryError;
  const formAvailable = full && target?.executionId === executionId;
  useEffect(() => { setRefs([]); setFeedbackMessage(null); setFeedbackError(null); }, [target]);
  async function recoverFeedback() {
    const pending = evaluation.pending.feedback; if (!pending) return;
    const order = ++recoveryOrder.current; setRecovering(true); setRecoveryMessage(null);
    try {
      const found = await findEvaluationFeedback(window.medclaw, pending);
      if (order !== recoveryOrder.current) return;
      if (found) { if (evaluation.confirm('review_record', pending.operationRef)) setRecoveryMessage(found.conflict ? 'Original feedback confirmed. Both versions were preserved.' : 'Original feedback confirmed.'); }
      else setRecoveryMessage('Original feedback is unconfirmed. Its submission identity is preserved; no feedback was sent again.');
    } catch { if (order === recoveryOrder.current) setRecoveryMessage('Original feedback could not be confirmed. Its submission identity is preserved.'); }
    finally { if (order === recoveryOrder.current) setRecovering(false); }
  }
  async function submit() {
    if (submittingRef.current || !formAvailable || !target || evaluation.pending.feedback || writeBlocked || !reviewer.trim() || reviewer.trim().length > 200 || !comment.trim() || comment.trim().length > 4000) return;
    submittingRef.current = true; setSubmitting(true); setFeedbackMessage(null); setFeedbackError(null);
    const operation = { operationKind: 'review_record' as const, operationRef: crypto.randomUUID(), executionId: target.executionId, caseId: target.caseId, trialId: target.trialId };
    try {
      evaluation.remember(operation);
      const result = await window.medclaw.request('eval.review.record', { ...target, evidenceRefs: refs, reviewer: reviewer.trim(), comment: comment.trim(), status }, operation.operationRef);
      if (result.ok) { evaluation.confirm('review_record', operation.operationRef); if (targetRef.current === target) { setFeedbackMessage('Feedback saved.'); setComment(''); } else setRecoveryMessage('Original feedback confirmed.'); if (selectedRef.current === target.executionId) setLocalFeedback(true); }
      else { setFeedbackError(errorMessage(result.error)); if (['invalid_argument', 'access_denied', 'artifact_not_ready', 'runtime_busy'].includes(result.error.code)) evaluation.confirm('review_record', operation.operationRef); }
    } catch (error) { const parsed = AppErrorSchema.safeParse(error); setFeedbackError(parsed.success ? errorMessage(parsed.data) : 'Feedback submission is unconfirmed. Read the original feedback before submitting again.'); }
    finally { submittingRef.current = false; setSubmitting(false); }
  }
  async function readDelivery(kind: 'resend' | 'review_sync', page = 1, pending = false) {
    const original = pending ? evaluation.pending.platform : null, selected = original?.executionId ?? executionId;
    if (!selected) return;
    deliveryKind.current = kind;
    const order = ++deliveryOrder.current; setDeliveryError(null);
    try {
      const result = await window.medclaw.request('eval.status', { executionId: selected, platform: kind, page, pageSize: 20, ...(original ? { operationRef: original.operationRef } : {}) });
      if (order !== deliveryOrder.current || !pending && selectedRef.current !== selected) return;
      if (!result.ok) { setDeliveryError(errorMessage(result.error)); return; }
      if (result.data.executionId !== selected || result.data.result?.kind !== kind) { setDeliveryError('The delivery reply does not match this report.'); return; }
      setDelivery({ kind, view: result.data });
      const value = result.data.result.platform;
      if (kind === 'review_sync' && selected === selectedRef.current) setLocalFeedback(value.receipts.total + value.remaining > 0);
      if (original) setPendingRead(original.operationRef);
    } catch { if (order === deliveryOrder.current) setDeliveryError('Delivery status could not be read. No data was sent.'); }
  }
  async function deliver(kind: 'resend' | 'review_sync', retry = false) {
    const original = retry ? evaluation.pending.platform : null, selected = original?.executionId ?? executionId;
    if (deliveryRef.current || !selected || writeBlocked || productionBlockReason || platformConfigured === false || (!retry && (!full || !!evaluation.pending.platform || kind === 'resend' && !summary?.startedAt || kind === 'review_sync' && !localFeedback)) || retry && (!original || pendingRead !== original.operationRef)) return;
    deliveryRef.current = true; setDelivering(true); setDeliveryError(null);
    deliveryKind.current = kind; setDelivery(null);
    const operation = original ?? { operationKind: kind, operationRef: crypto.randomUUID(), executionId: selected };
    try {
      evaluation.remember(operation);
      const result = kind === 'resend' ? await window.medclaw.request('eval.resend', { executionId: selected }, operation.operationRef) : await window.medclaw.request('eval.review.sync', { executionId: selected }, operation.operationRef);
      if (!result.ok) { setDeliveryError(errorMessage(result.error)); if (!original && ['invalid_argument', 'runtime_busy', 'artifact_not_ready', 'langfuse_config_incomplete', 'export_no_started_trials', 'review_no_local_feedback', 'access_denied'].includes(result.error.code)) evaluation.confirm(operation.operationKind, operation.operationRef); }
    } catch (error) { const parsed = AppErrorSchema.safeParse(error); setDeliveryError(parsed.success ? errorMessage(parsed.data) : 'Delivery acceptance is unconfirmed. Read the original delivery before retrying.'); }
    finally { await evaluation.refresh(); deliveryRef.current = false; setDelivering(false); }
  }
  useEffect(() => { if (visible && evaluation.pending.feedback && !submittingRef.current) void recoverFeedback(); }, [visible, submitting, evaluation.pending.feedback?.operationRef]);
  useEffect(() => {
    deliveryOrder.current++; deliveryKind.current = 'review_sync'; setDelivery(null); setDeliveryError(null); setLocalFeedback(false);
    if (visible && full) void readDelivery('review_sync');
  }, [executionId, full, visible]);
  useEffect(() => {
    const current = evaluation.control;
    if (!current || current.executionId !== executionId || current.result?.kind === 'run' || !current.result || current.result.kind !== deliveryKind.current) return;
    deliveryOrder.current++; setDelivery({ kind: current.result.kind, view: current });
    if (current.result.kind === 'review_sync') setLocalFeedback(current.result.platform.receipts.total + current.result.platform.remaining > 0);
  }, [evaluation.control?.sequence, executionId]);
  useEffect(() => () => { recoveryOrder.current++; deliveryOrder.current++; }, []);
  const platform = delivery?.view.result && delivery.view.result.kind !== 'run' ? delivery.view.result.platform : null;
  return <>
    {(evaluation.pending.feedback || recoveryMessage) && <section className="panel" aria-label="Original feedback status"><h2>Original feedback</h2>{evaluation.pending.feedback && <><p>Trial {evaluation.pending.feedback.trialId}. Reloading only reads the original submission.</p><button disabled={recovering} onClick={() => void recoverFeedback()}>Read original feedback</button></>}{recoveryMessage && <p role="status">{recoveryMessage}</p>}</section>}
    {formAvailable && target && <section className="panel" aria-labelledby="evaluation-feedback"><h2 id="evaluation-feedback">Local feedback</h2><p>Case {target.caseId} · Trial {target.trialId}</p><p className="muted">Records a human review alongside the original automatic Scores.</p>
      <div className="form-grid"><label>Reviewer<input value={reviewer} disabled={submitting} maxLength={200} onChange={event => setReviewer(event.target.value)} /></label><label>Review status<select disabled={submitting} aria-label="Review status" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option>PASS</option><option>FAIL</option><option>UNJUDGEABLE</option></select></label></div>
      <label>Comment<textarea value={comment} disabled={submitting} maxLength={4000} onChange={event => setComment(event.target.value)} /></label>
      <fieldset><legend>Evidence references</legend>{target.evidenceRefs.length ? target.evidenceRefs.map(ref => <label className="checkbox-label" key={ref}><input type="checkbox" checked={refs.includes(ref)} onChange={event => setRefs(previous => event.target.checked ? [...previous, ref] : previous.filter(value => value !== ref))} />{ref}</label>) : <p>No evidence references were selected from the original Scores.</p>}</fieldset>
      {feedbackError && <p role="alert" className="error-text">{feedbackError}</p>}{feedbackMessage && <p role="status">{feedbackMessage}</p>}
      <button disabled={submitting || writeBlocked || !!evaluation.pending.feedback || !reviewer.trim() || !comment.trim()} onClick={() => void submit()}>Submit feedback</button>
    </section>}
    {summary && <section className="panel" aria-labelledby="evaluation-delivery"><h2 id="evaluation-delivery">Report delivery</h2><p><code>{executionId}</code></p>
      {platformConfigured === false ? <p>Independent platform configuration is incomplete. Local reports and feedback remain available.</p> : platformConfigured === null ? <p>Independent platform configuration is checked before sending.</p> : <p>Sending uses the independent platform configuration.</p>}
      {!full && <p>Only complete saved reports can be sent.</p>}{blockReason && <p role="status">{blockReason}</p>}
      <div className="actions"><button disabled={!full || !summary.startedAt || delivering || writeBlocked || !!productionBlockReason || platformConfigured === false || !!evaluation.pending.platform} onClick={() => void deliver('resend')}>Upload / Resend</button><button disabled={!full || !localFeedback || delivering || writeBlocked || !!productionBlockReason || platformConfigured === false || !!evaluation.pending.platform} onClick={() => void deliver('review_sync')}>Sync feedback</button>
        <button disabled={!full} onClick={() => void readDelivery('resend')}>Read upload status</button><button disabled={!full} onClick={() => void readDelivery('review_sync')}>Read feedback sync status</button></div>
      {evaluation.pending.platform && <div className="persistence-notice"><p>Unconfirmed delivery for {evaluation.pending.platform.executionId}. Its original identity is preserved.</p><button onClick={() => void readDelivery(evaluation.pending.platform!.operationKind, 1, true)}>Read pending delivery</button><button disabled={delivering || writeBlocked || !!productionBlockReason || platformConfigured === false || pendingRead !== evaluation.pending.platform.operationRef} onClick={() => void deliver(evaluation.pending.platform!.operationKind, true)}>Retry original delivery</button></div>}
      {deliveryError && <p role="alert" className="error-text">{deliveryError}</p>}
      {delivery && platform && <><p>{delivery.kind === 'resend' ? 'Upload status' : 'Feedback sync status'} for {delivery.view.executionId} · {delivery.view.state === 'unknown' ? 'Historical action unconfirmed' : controlLabels[delivery.view.state]}</p><p>Delivery: <span data-testid="evaluation-delivery-state">{platform.state}</span></p><p>Accepted {platform.accepted} · Rejected {platform.rejected} · Unknown {platform.unknown} · Remaining {platform.remaining}</p>{!platform.exportExists && <p>No upload envelope is saved. Viewing does not create one.</p>}
        {platform.receipts.items.map(item => <p key={item.eventId}><code>{item.eventId}</code> · {item.state}{item.safeError && ' · ' + item.safeError}</p>)}
        <div className="actions"><button disabled={platform.receipts.page <= 1} onClick={() => void readDelivery(delivery.kind, platform.receipts.page - 1)}>Previous delivery page</button><span>Page {platform.receipts.page}</span><button disabled={platform.receipts.page * platform.receipts.pageSize >= platform.receipts.total} onClick={() => void readDelivery(delivery.kind, platform.receipts.page + 1)}>Next delivery page</button></div></>}
    </section>}
  </>;
}

function EvaluationReports({ visible, revision, evaluation, platformConfigured, productionBlockReason }: { visible: boolean; revision: string; evaluation: ReturnType<typeof useEvaluationControl>; platformConfigured: boolean | null; productionBlockReason: string | null }) {
  const [reports, setReports] = useState<EvaluationReturn<'eval.report.list'> | null>(null), [listError, setListError] = useState<string | null>(null);
  const [listing, setListing] = useState(false), listOrder = useRef(0);
  const [query, setQuery] = useState<ReportQuery | null>(null), queryRef = useRef<ReportQuery | null>(null);
  const [summary, setSummary] = useState<EvaluationReturn<'eval.report.list'>['items'][number] | null>(null);
  const [detail, setDetail] = useState<Section | null>(null), [detailError, setDetailError] = useState<string | null>(null);
  const [countChanged, setCountChanged] = useState(false);
  const [oversize, setOversize] = useState(false), [loading, setLoading] = useState(false), detailOrder = useRef(0);
  const [evidence, setEvidence] = useState<EvaluationReturn<'eval.evidence.read'> | null>(null), [evidenceError, setEvidenceError] = useState<string | null>(null);
  const evidenceOrder = useRef(0), [evidencePage, setEvidencePage] = useState(1);
  const [pair, setPair] = useState({ baselineExecutionId: '', candidateExecutionId: '' }), pairRef = useRef(pair); pairRef.current = pair;
  const [comparison, setComparison] = useState<EvaluationReturn<'eval.compare'> | null>(null), [compareError, setCompareError] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false), compareOrder = useRef(0);
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  async function readList(page = reports?.page ?? 1, pageSize = reports?.pageSize ?? 50) {
    const order = ++listOrder.current; setListing(true); setListError(null);
    try {
      const result = await window.medclaw.request('eval.report.list', { page, pageSize });
      if (order !== listOrder.current) return;
      if (result.ok) setReports(result.data); else setListError(errorMessage(result.error));
    } catch { if (order === listOrder.current) setListError('Evaluation reports could not be read. Refresh to try again.'); }
    finally { if (order === listOrder.current) setListing(false); }
  }
  async function readSection(next: ReportQuery, preserve = false) {
    const order = ++detailOrder.current; queryRef.current = next; setQuery(next); setLoading(true); setDetailError(null); setOversize(false);
    if (!preserve) { setDetail(null); setCountChanged(false); setEvidence(null); setEvidenceError(null); evidenceOrder.current++; }
    try {
      const result = await window.medclaw.request('eval.report.read', next);
      if (order !== detailOrder.current) return;
      if (result.ok && result.data.executionId === next.executionId && result.data.section === next.section) {
        setCountChanged(preserve && detail !== null && detail.section !== 'summary' && result.data.section !== 'summary' && detail.section === result.data.section && detail.total !== result.data.total);
        setDetail(result.data);
        if (result.data.section === 'summary') setSummary(result.data.summary);
      } else { setDetailError(result.ok ? 'The report reply does not match this selection.' : errorMessage(result.error)); setOversize(!result.ok && result.error.code === 'report_page_too_large'); }
    } catch { if (order === detailOrder.current) setDetailError('This report section could not be read. Its original files are preserved.'); }
    finally { if (order === detailOrder.current) setLoading(false); }
  }
  function open(item: NonNullable<typeof reports>['items'][number]) {
    setSummary(item); void readSection({ executionId: item.executionId, section: 'summary', page: 1, pageSize: 50 });
  }
  async function readEvidence(trialId: string, evidenceRef: string, page = 1) {
    const selected = queryRef.current; if (!selected) return;
    const order = ++evidenceOrder.current; setEvidence(null); setEvidenceError(null); setEvidencePage(page);
    try {
      const result = await window.medclaw.request('eval.evidence.read', { executionId: selected.executionId, trialId, evidenceRef, page, pageSize: 20 });
      if (order !== evidenceOrder.current || queryRef.current !== selected) return;
      if (result.ok && result.data.executionId === selected.executionId && result.data.trialId === trialId && result.data.evidenceRef === evidenceRef) setEvidence(result.data);
      else setEvidenceError(result.ok ? 'The evidence reply does not match this selection.' : errorMessage(result.error));
    } catch { if (order === evidenceOrder.current && queryRef.current === selected) setEvidenceError('This evidence could not be read. Its original files are preserved.'); }
  }
  function changePair(next: typeof pair) { pairRef.current = next; setPair(next); compareOrder.current++; setComparison(null); setCompareError(null); setComparing(false); }
  async function compare() {
    const selected = pairRef.current; if (!selected.baselineExecutionId || !selected.candidateExecutionId || comparing) return;
    const order = ++compareOrder.current; setComparing(true); setComparison(null); setCompareError(null);
    try {
      const result = await window.medclaw.request('eval.compare', selected);
      if (order !== compareOrder.current) return;
      if (result.ok && result.data.baselineExecutionId === selected.baselineExecutionId && result.data.candidateExecutionId === selected.candidateExecutionId) setComparison(result.data);
      else setCompareError(result.ok ? 'The comparison reply does not match these reports.' : errorMessage(result.error));
    } catch { if (order === compareOrder.current) setCompareError('These saved reports could not be compared. Their original scores are preserved.'); }
    finally { if (order === compareOrder.current) setComparing(false); }
  }
  useEffect(() => { if (visible) void readList(); }, [visible, revision]);
  useEffect(() => () => { listOrder.current++; detailOrder.current++; evidenceOrder.current++; compareOrder.current++; }, []);
  const page = detail && detail.section !== 'summary' ? detail : null;
  const complete = reports?.items.filter(item => item.archiveState === 'complete') ?? [];
  return <>
    <section className="panel" aria-labelledby="evaluation-reports"><div className="section-heading"><h2 id="evaluation-reports">Evaluation reports</h2><button disabled={listing} onClick={() => void readList()}>Refresh reports</button></div>
      {listError && <p role="alert" className="error-text">{listError}</p>}
      {!reports ? <p role="status">{listing ? 'Reading evaluation reports…' : 'Reports have not been read.'}</p> : !reports.total ? <p>No evaluation reports</p> : <>
        <div className="model-list">{reports.items.map(item => <article className="model-row" key={item.executionId}><div className="section-heading"><code>{item.executionId}</code><button aria-label={'Open ' + item.executionId} onClick={() => open(item)}>Open report</button></div>
          <p>{item.archiveState === 'partial' ? 'Partial results' : item.archiveState === 'unreadable' ? 'Report unavailable' : 'Saved report'} · {item.recorded} of {item.planned} Trials</p>
          {item.createdAt ? <p className="tiny">Created {item.createdAt}</p> : item.startedAt ? <p className="tiny">Started {item.startedAt}</p> : <p className="tiny">Time unavailable</p>}
          {item.gaps.map((gap, index) => <p key={index} className="tiny">{diagnosticMessage(gap)}</p>)}</article>)}</div>
        <div className="actions"><button disabled={listing || reports.page <= 1} onClick={() => void readList(reports.page - 1)}>Previous reports</button><span>Page {reports.page} · {reports.total} reports</span><button disabled={listing || reports.page * reports.pageSize >= reports.total} onClick={() => void readList(reports.page + 1)}>Next reports</button></div>
      </>}
    </section>
    {query && summary && <section className="panel" aria-labelledby="evaluation-report-detail"><h2 id="evaluation-report-detail">Report details</h2><p><code>{query.executionId}</code></p>
      {summary.qualityMetricCatalogVersion && <p>Catalog {summary.qualityMetricCatalogVersion}</p>}
      <p>Recorded Trials: {summary.recorded} of {summary.planned}</p>
      {summary.archiveState === 'partial' && <><h3>Partial results</h3><p>Missing Trials remain unconfirmed. No final quality is available.</p></>}
      {summary.archiveState === 'unreadable' && <h3>Report unavailable</h3>}
      {summary.totals && <p>PASS {summary.totals.pass} · FAIL {summary.totals.fail} · UNJUDGEABLE {summary.totals.unjudgeable} · ERROR {summary.totals.error} · NOT_RUN {summary.totals.notRun}</p>}
      {summary.gaps.map((gap, index) => <p key={index} role="status">{diagnosticMessage(gap)}</p>)}
      <div className="form-grid"><label>Report section<select aria-label="Report section" value={query.section} disabled={summary.archiveState === 'unreadable'} onChange={event => void readSection({ ...query, section: event.target.value as ReportQuery['section'], page: 1 })}>{sections.map(section => <option key={section} disabled={summary.archiveState !== 'complete' && ['coverage', 'feedback'].includes(section)} value={section}>{section.charAt(0).toUpperCase() + section.slice(1)}</option>)}</select></label>
        {['cases', 'trials', 'scores', 'feedback'].includes(query.section) && <label>Case filter<input value={query.caseId ?? ''} onChange={event => void readSection({ ...query, caseId: event.target.value || undefined, trialId: undefined, page: 1 })} /></label>}
        {['trials', 'scores', 'feedback'].includes(query.section) && <label>Trial filter<input value={query.trialId ?? ''} onChange={event => void readSection({ ...query, trialId: event.target.value || undefined, page: 1 })} /></label>}</div>
      {detailError && <p role="alert" className="error-text">{detailError}</p>}
      {countChanged && <p role="status">Saved item count changed. This page reflects the latest read; refresh other pages.</p>}
      {loading && <p role="status">Reading report section…</p>}
      {oversize && <div className="actions">{query.pageSize > 1 ? <button disabled={loading} onClick={() => { const smaller = smallerEvaluationPage(query.page, query.pageSize); if (smaller) void readSection({ ...query, ...smaller }, true); }}>Load smaller page</button> : <p>This item cannot be displayed. Read Summary or Diagnostics; its original Score and denominator are preserved.</p>}
        <button disabled={loading} onClick={() => void readSection({ ...query, page: query.page + 1 })}>Read next page</button></div>}
      {detail?.section === 'summary' && <>{detail.summary.aggregation && <details><summary>Task results</summary><ValueSummary value={detail.summary.aggregation} /></details>}{detail.summary.analysis && <details><summary>Quality coverage and engineering conditions</summary><ValueSummary value={detail.summary.analysis} /></details>}</>}
      {page && <><p>Original items: <span data-testid="evaluation-section-total">{page.total}</span></p>
        {!page.items.length && <p>No saved items in this section.</p>}
        {page.section === 'cases' && page.items.map(item => <article className="model-row" key={item.id}><h3>{item.name}</h3><p><code>{item.id}</code> · {item.category} · {item.evalType} · {item.status ?? 'Unconfirmed'}</p><p>{item.recorded} of {item.planned} Trials</p><button onClick={() => void readSection({ ...query, section: 'trials', caseId: item.id, trialId: undefined, page: 1 })}>Read Trials for {item.id}</button>{item.analysis && <ValueSummary value={item.analysis} />}</article>)}
        {page.section === 'trials' && page.items.map(item => <article className="model-row" key={item.trialId}><h3>{item.trialId}</h3><p>Case {item.caseId} · repetition {item.repetition} · {item.status}</p><p>Stopped: {proofLabel(item.stopped)} · Closed: {proofLabel(item.closed)}</p>{item.reason && <p>{item.reason}</p>}<div className="actions"><button onClick={() => void readSection({ ...query, section: 'scores', caseId: item.caseId, trialId: item.trialId, page: 1 })}>Read Scores for {item.trialId}</button><button disabled={summary.archiveState !== 'complete'} onClick={() => setReviewTarget({ executionId: query.executionId, caseId: item.caseId, trialId: item.trialId, evidenceRefs: [] })}>Review Trial {item.trialId}</button></div></article>)}
        {page.section === 'scores' && page.items.map(item => <article className="model-row" data-testid="evaluation-score" key={item.trialId + ':' + item.checkId + ':' + item.scope.kind + ':' + item.scope.ref}><h3>{item.name} · {item.status}</h3><p><code>{item.checkId}</code></p><p>Case {item.caseId} · Trial {item.trialId} · {item.metricId} {item.version} · {item.method}</p><p>Scope {item.scope.kind}: {item.scope.ref} · {item.applicable ? 'Applicable' : 'Not applicable'} · {item.required ? 'Required' : 'Optional'} · {item.hardConstraint ? 'Hard constraint' : 'Standard check'}</p><p>Value {item.value ?? 'Unavailable'} · Numerator {item.numerator ?? 'Unavailable'} · Denominator {item.denominator ?? 'Unavailable'} · {item.unit}</p><p>{item.reason}</p>{item.missing.length > 0 && <p>Missing: {item.missing.join('; ')}</p>}<details><summary>Expected</summary><ValueSummary value={item.expected} /></details><details><summary>Actual</summary><ValueSummary value={item.actual} /></details><div className="actions"><button disabled={summary.archiveState !== 'complete'} onClick={() => setReviewTarget({ executionId: query.executionId, caseId: item.caseId, trialId: item.trialId, evidenceRefs: [...new Set(page.items.filter(score => score.trialId === item.trialId).flatMap(score => score.evidenceRefs))] })}>Review Trial {item.trialId}</button>{item.evidenceRefs.map(ref => <button key={ref} onClick={() => void readEvidence(item.trialId, ref)}>Read evidence {ref}</button>)}</div></article>)}
        {page.section === 'coverage' && page.items.map(item => <article className="model-row" key={item.metricId + ':' + item.version}><h3>{item.metricId} {item.version}</h3><ValueSummary value={item.summary} /></article>)}
        {page.section === 'feedback' && page.items.map((item, index) => <article className="model-row" key={item.id + ':' + item.sourceId + ':' + index}><h3>{item.status} · {item.reviewer}</h3><p>Case {item.caseId} · Trial {item.trialId} · {item.source} · {item.reviewedAt}</p><p><code>{item.sourceId}</code></p><p>{item.comment}</p>{item.conflict && <p role="status">Both versions were preserved.</p>}</article>)}
        {page.section === 'diagnostics' && page.items.map((item, index) => <p key={index}>{item.trialId && <code>{item.trialId}: </code>}{diagnosticMessage(item)}</p>)}
        <div className="actions"><button disabled={loading || page.page <= 1} onClick={() => void readSection({ ...query, page: page.page - 1, pageSize: page.pageSize }, true)}>Previous section page</button><span>Page {page.page} · {page.pageSize} per page</span><button disabled={loading || page.page * page.pageSize >= page.total} onClick={() => void readSection({ ...query, page: page.page + 1, pageSize: page.pageSize }, true)}>Next section page</button><button disabled={loading} onClick={() => void readSection(query, true)}>Refresh section</button></div>
      </>}
      {evidenceError && <p role="alert" className="error-text">{evidenceError}</p>}
      {evidence && <section aria-label="Selected evidence"><h3>Evidence {evidence.evidenceRef}</h3><p>Trial {evidence.trialId} · Page {evidencePage}</p><ValueSummary value={evidence.summary} />{evidence.gaps.map((gap, index) => <p key={index}>{diagnosticMessage(gap)}</p>)}<div className="actions"><button disabled={evidencePage <= 1} onClick={() => void readEvidence(evidence.trialId, evidence.evidenceRef, evidencePage - 1)}>Previous evidence page</button><button onClick={() => void readEvidence(evidence.trialId, evidence.evidenceRef, evidencePage + 1)}>Next evidence page</button></div></section>}
    </section>}
    <EvaluationReview visible={visible} summary={summary} target={reviewTarget} evaluation={evaluation} platformConfigured={platformConfigured} productionBlockReason={productionBlockReason} />
    <section className="panel" aria-labelledby="evaluation-compare"><h2 id="evaluation-compare">Compare reports</h2><p className="muted">Compare original saved scores using their recorded conditions.</p><div className="form-grid">
      <label>Baseline report<select aria-label="Baseline report" value={pair.baselineExecutionId} onChange={event => changePair({ ...pair, baselineExecutionId: event.target.value })}><option value="">Select a saved report</option>{complete.map(item => <option value={item.executionId} key={item.executionId}>{item.executionId}</option>)}</select></label>
      <label>Candidate report<select aria-label="Candidate report" value={pair.candidateExecutionId} onChange={event => changePair({ ...pair, candidateExecutionId: event.target.value })}><option value="">Select a saved report</option>{complete.map(item => <option value={item.executionId} key={item.executionId}>{item.executionId}</option>)}</select></label></div>
      <button disabled={comparing || !pair.baselineExecutionId || !pair.candidateExecutionId} onClick={() => void compare()}>Compare saved reports</button>{compareError && <p role="alert" className="error-text">{compareError}</p>}{comparison && <ValueSummary value={comparison.comparison} />}
    </section>
  </>;
}
const diagnosticMessage = (item: EvaluationDiagnostic) => ({
  evaluation_config_unavailable: 'Independent Agent or Judge configuration is missing or invalid.',
  dataset_review_pending: 'This dataset has unresolved review requirements and cannot run yet.',
  independent_judge_unconfigured: 'Configure the independent Judge for the applicable semantic checks.',
  sdk_version_mismatch: 'The installed evaluation runtime does not match the required version.',
  declared_subagent_patch_missing: 'A required evaluation runtime patch is missing.',
  runtime_busy: 'Another execution owns the evaluation archive. Wait for it to stop and save.',
  external_execution_lock: 'An independent execution owns this archive. Use its original entry to check it.',
  stop_or_save_unconfirmed: 'The original evaluation stop or save is unconfirmed. Its files are preserved.',
  operation_result_unknown: 'The original action could not be confirmed. Keep its identity and check again.',
} as Record<string, string>)[item.code] ?? item.message;
export function EvaluationPage({ visible, evaluation, productionBlockReason }: { visible: boolean; evaluation: ReturnType<typeof useEvaluationControl>; productionBlockReason: string | null }) {
  const { control, pending } = evaluation;
  const [options, setOptions] = useState({ datasetId: 'medclaw-agent-v1', selection: 'smoke' as 'smoke' | 'full', trials: '1' });
  const [preflight, setPreflight] = useState<EvaluationReturn<'eval.preflight'> | null>(null), [checking, setChecking] = useState(false);
  const [platformConfigured, setPlatformConfigured] = useState<boolean | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null), [actionError, setActionError] = useState<string | null>(null), [restartRequired, setRestartRequired] = useState(false);
  const [starting, setStarting] = useState(false), [cancelling, setCancelling] = useState(false);
  const checkOrder = useRef(0), checkedOnce = useRef(false), startingRef = useRef(false), cancellingRef = useRef(false);
  const optionRef = useRef(options); optionRef.current = options;
  const validTrials = /^\d+$/.test(options.trials) && Number.isSafeInteger(Number(options.trials)) && Number(options.trials) >= 1;
  const blockReason = evaluationExecutionBlockReason(control);
  const runBlocked = !preflight || preflight.blockers.length > 0 || !validTrials || checking || starting || !!blockReason || !!productionBlockReason || !!evaluation.recoveryError || !!pending.run || !control || !!evaluation.error || restartRequired;
  const [lookup, setLookup] = useState<{ operationRef: string; control: EvaluationControlView | null; error: string | null } | null>(null);
  const [reading, setReading] = useState(false), readOrder = useRef(0);
  function changeOptions(next: typeof options) {
    optionRef.current = next; setOptions(next); checkOrder.current++; setPreflight(null); setCheckError(null); setChecking(false);
  }
  async function check() {
    const selected = optionRef.current;
    if (!/^\d+$/.test(selected.trials) || !Number.isSafeInteger(Number(selected.trials)) || Number(selected.trials) < 1) return;
    const order = ++checkOrder.current; setChecking(true); setPreflight(null); setCheckError(null);
    try {
      const result = await window.medclaw.request('eval.preflight', { datasetId: selected.datasetId, selection: selected.selection, trials: Number(selected.trials) });
      if (order !== checkOrder.current) return;
      if (result.ok) { setPreflight(result.data); setPlatformConfigured(result.data.platformConfigured); }
      else { setCheckError(errorMessage(result.error)); if (result.error.code === 'evaluation_runtime_changed') setRestartRequired(true); }
    } catch { if (order === checkOrder.current) setCheckError('Evaluation requirements could not be read. Check again before running.'); }
    finally { if (order === checkOrder.current) setChecking(false); }
  }
  async function start() {
    if (startingRef.current || runBlocked || !preflight) return;
    startingRef.current = true; setStarting(true); setActionError(null);
    const operation: z.infer<typeof PendingRunSchema> = { operationKind: 'run', operationRef: crypto.randomUUID(), datasetId: preflight.datasetId, selection: preflight.selection, trials: preflight.trials };
    try {
      evaluation.remember(operation);
      const result = await window.medclaw.request('eval.start', { preflightId: preflight.preflightId, datasetId: operation.datasetId, selection: operation.selection, trials: operation.trials }, operation.operationRef);
      if (!result.ok) {
        setActionError(errorMessage(result.error));
        if (['invalid_argument', 'config_conflict', 'runtime_busy', 'evaluation_runtime_changed', 'config_read_failed', 'access_denied'].includes(result.error.code)) evaluation.confirm('run', operation.operationRef);
        if (result.error.code === 'evaluation_runtime_changed') setRestartRequired(true);
        if (['config_conflict', 'evaluation_runtime_changed', 'config_read_failed'].includes(result.error.code)) setPreflight(null);
      }
    } catch (error) {
      const parsed = AppErrorSchema.safeParse(error);
      setActionError(parsed.success ? errorMessage(parsed.data) : 'Run acceptance is unconfirmed. Read the original evaluation before another Run.');
    } finally { await evaluation.refresh(); startingRef.current = false; setStarting(false); }
  }
  async function cancel() {
    if (cancellingRef.current || control?.operationKind !== 'run' || !control.executionId || !['starting', 'running', 'cancelling'].includes(control.state)) return;
    cancellingRef.current = true; setCancelling(true); setActionError(null);
    try {
      const result = await window.medclaw.request('eval.cancel', { executionId: control.executionId });
      if (!result.ok) setActionError(errorMessage(result.error));
      else if (!result.data.cancelRequested) setActionError('This evaluation is no longer accepting cancellation. Read its original status.');
    } catch { setActionError('Cancellation could not be confirmed. Refresh the original evaluation status.'); }
    finally { await evaluation.refresh(); cancellingRef.current = false; setCancelling(false); }
  }
  async function readOriginal(operation: Exclude<PendingOperation, { operationKind: 'review_record' }>) {
    const order = ++readOrder.current; setReading(true);
    try {
      const executionId = operation.operationKind === 'run' ? 'desktop-' + operation.operationRef : operation.executionId;
      const result = await window.medclaw.request('eval.status', { executionId, operationRef: operation.operationRef,
        ...(operation.operationKind === 'run' ? {} : { platform: operation.operationKind }) });
      if (order !== readOrder.current) return;
      setLookup({ operationRef: operation.operationRef, control: result.ok ? result.data : null, error: result.ok ? null : errorMessage(result.error) });
      if (result.ok && result.data.state === 'settled' && result.data.stopConfirmed === true && result.data.saveConfirmed === true && result.data.operationRef === operation.operationRef) evaluation.confirm(operation.operationKind, operation.operationRef);
    } catch { if (order === readOrder.current) setLookup({ operationRef: operation.operationRef, control: null, error: 'The original action could not be confirmed. Check again before another action.' }); }
    finally { if (order === readOrder.current) setReading(false); }
  }
  useEffect(() => { if (visible && pending.run) void readOriginal(pending.run); }, [visible, pending.run?.operationRef]);
  useEffect(() => { if (visible && pending.platform) void readOriginal(pending.platform); }, [visible, pending.platform?.operationRef]);
  useEffect(() => { if (visible && !checkedOnce.current) { checkedOnce.current = true; void check(); } }, [visible]);
  useEffect(() => {
    if (control?.operationKind !== 'run' || !control.error) return;
    if (['config_conflict', 'config_read_failed', 'evaluation_runtime_changed'].includes(control.error.code)) setPreflight(null);
    if (control.error.code === 'evaluation_runtime_changed') setRestartRequired(true);
  }, [control?.operationKind, control?.operationRef, control?.error?.code]);
  useEffect(() => {
    if (pending.run && control?.operationKind === 'run' && control.operationRef === pending.run.operationRef && control.state === 'settled' && control.stopConfirmed === true && control.saveConfirmed === true) evaluation.confirm('run', pending.run.operationRef);
  }, [pending.run?.operationRef, control?.operationRef, control?.state, control?.stopConfirmed, control?.saveConfirmed]);
  useEffect(() => {
    if (pending.platform && control?.operationKind === pending.platform.operationKind && control.operationRef === pending.platform.operationRef && control.state === 'settled' && control.stopConfirmed === true && control.saveConfirmed === true) evaluation.confirm(pending.platform.operationKind, pending.platform.operationRef);
  }, [pending.platform?.operationRef, control?.operationRef, control?.state, control?.stopConfirmed, control?.saveConfirmed]);
  return <div className="models-layout">
    {productionBlockReason && <p role="status">{productionBlockReason}</p>}
    {evaluation.error && <p role="alert" className="error-text">{evaluation.error}</p>}
    {evaluation.recoveryError && <p role="alert" className="error-text">{evaluation.recoveryError}</p>}
    {actionError && <p role="alert" className="error-text">{actionError}</p>}
    <section className="panel" aria-labelledby="evaluation-setup">
      <div className="section-heading"><h2 id="evaluation-setup">Evaluation setup</h2><span role="status">{checking ? 'Checking requirements…' : preflight ? 'Requirements checked' : 'Check required'}</span></div>
      <p className="muted">Uses the independent evaluation configuration. Checking does not run models or contact the platform.</p>
      <div className="form-grid"><label>Dataset<select value={options.datasetId} onChange={event => changeOptions({ datasetId: event.target.value, selection: event.target.value === 'medclaw-badcase-v1' ? 'full' : 'smoke', trials: event.target.value === 'medclaw-badcase-v1' ? '3' : '1' })}>
        <option value="medclaw-agent-v1">Main Agent dataset</option><option value="medclaw-badcase-v1">Badcase dataset</option></select></label>
        <label>Selection<select value={options.selection} onChange={event => changeOptions({ ...optionRef.current, selection: event.target.value === 'full' ? 'full' : 'smoke', trials: event.target.value === 'full' ? '3' : '1' })}><option value="smoke">Smoke</option><option value="full">Full</option></select></label>
        <label>Trials per Case<input type="number" min="1" step="1" value={options.trials} onChange={event => changeOptions({ ...optionRef.current, trials: event.target.value })} /></label></div>
      {!validTrials && <p role="alert" className="error-text">Enter a positive whole number of Trials.</p>}
      {checkError && <p role="alert" className="error-text">{checkError}</p>}
      {restartRequired && <p role="status">Restart the app after confirming the original evaluation has stopped and saved.</p>}
      {preflight && <><dl className="facts"><dt>Cases</dt><dd>{preflight.cases}</dd><dt>Planned Trials</dt><dd data-testid="evaluation-planned-trials">{preflight.plannedTrials}</dd>
        <dt>Judge request limit</dt><dd>{preflight.judgeRequestLimit}</dd><dt>Dataset review</dt><dd>{preflight.readiness === 'reviewed' ? 'Reviewed' : 'Review pending'}</dd></dl>
        {preflight.config ? <details><summary>Independent configuration</summary><pre>{preflight.config.text}</pre>{preflight.config.redacted && <p className="tiny">Sensitive values are hidden.</p>}{preflight.config.truncated && <p className="tiny">This is a shortened configuration summary.</p>}</details> : <p>Independent model configuration is unavailable.</p>}
        {preflight.blockers.map((item, index) => <p role="status" key={item.code + ':' + index}>{diagnosticMessage(item)}</p>)}
      </>}
      {blockReason && <p role="status">{blockReason}</p>}
      <div className="actions"><button disabled={checking || !validTrials} onClick={() => void check()}>Check evaluation</button><button className="primary" disabled={runBlocked} onClick={() => void start()}>Run evaluation</button></div>
    </section>
    <section className="panel" aria-labelledby="evaluation-current">
      <div className="section-heading"><h2 id="evaluation-current">Current evaluation</h2><button onClick={() => void evaluation.refresh()}>Refresh evaluation status</button></div>
      {control?.error && <p role="alert" className="error-text">Last action error: {errorMessage(control.error)}</p>}
      {control ? <><dl className="facts"><dt>Status</dt><dd data-testid="evaluation-control-state">{controlLabels[control.state]}</dd>
        {control.executionId && <><dt>Execution</dt><dd><code>{control.executionId}</code></dd></>}
        <dt>Stopped</dt><dd>{proofLabel(control.stopConfirmed)}</dd><dt>Saved</dt><dd>{proofLabel(control.saveConfirmed)}</dd>
        {control.operationKind === 'run' && <><dt>Saved Trials</dt><dd data-testid="evaluation-saved-trials">{control.progressCounts.saved}</dd><dt>Planned Trials</dt><dd>{control.progressCounts.planned}</dd></>}</dl>
        {control.progress && <><p role="status">{control.progress.kind === 'heartbeat' ? 'Waiting' : 'Stage'}: {control.progress.phase.replaceAll('_', ' ')} · Trial {control.progress.index} of {control.progress.total} · repetition {control.progress.repetition}</p><p className="tiny">Case {control.progress.caseId} · Trial {control.progress.trialId} · {Math.floor(control.progress.elapsedMs / 1000)} seconds elapsed</p>{control.progress.reason && <p>{control.progress.reason}</p>}</>}
        {control.operationKind === 'run' && <p className="tiny">PASS {control.progressCounts.pass} · FAIL {control.progressCounts.fail} · UNJUDGEABLE {control.progressCounts.unjudgeable} · ERROR {control.progressCounts.error} · NOT_RUN {control.progressCounts.notRun}</p>}
        {control.blockReasons.map((reason, index) => <p key={reason.code + ':' + index} role="status">{diagnosticMessage(reason)}</p>)}
        {control.operationKind === 'run' && ['starting', 'running', 'cancelling'].includes(control.state) && <button disabled={cancelling || control.state === 'cancelling'} onClick={() => void cancel()}>Cancel evaluation</button>}
      </> : <p role="status">Reading evaluation status…</p>}
    </section>
    {(pending.run || pending.platform || pending.feedback) && <section className="panel" aria-labelledby="evaluation-pending">
      <h2 id="evaluation-pending">Unconfirmed actions</h2><p>Read the original action before starting another of the same kind. Reloading this page does not repeat it.</p>
      {pending.run && <button disabled={reading} onClick={() => void readOriginal(pending.run!)}>Check original evaluation</button>}
      {pending.platform && <button disabled={reading} onClick={() => void readOriginal(pending.platform!)}>Check original delivery</button>}
      {pending.feedback && <p>Feedback submission is unconfirmed for Trial {pending.feedback.trialId}. Read its original report before submitting again.</p>}
      {lookup?.error && <p role="alert" className="error-text">{lookup.error}</p>}
      {lookup?.control && <p role="status">{lookup.control.state === 'unknown' ? 'Original action unconfirmed' : 'Original action: ' + controlLabels[lookup.control.state]}</p>}
    </section>}
    <EvaluationReports visible={visible} revision={control?.state === 'settled' ? String(control.sequence) : ''} evaluation={evaluation} platformConfigured={platformConfigured} productionBlockReason={productionBlockReason} />
  </div>;
}
