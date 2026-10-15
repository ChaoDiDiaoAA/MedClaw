import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../../packages/contracts/src/error';
import type { HostView } from '../../../../packages/contracts/src/model';
import type { PublicReturn } from '../../../../packages/contracts/src/protocol';
import type { ExportFormat, ExportOperation, ExportRequest } from '../../../../packages/contracts/src/export';

const terminal = (state: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(state);
export const exportDeliveryLabel = (operation: ExportOperation) => operation.state === 'completed' && operation.copyState === 'verified' ? 'Delivery verified'
  : operation.copyState === 'unknown' ? 'Delivery result unknown' : operation.artifact ? 'Artifact registered; delivery incomplete' : 'Artifact not registered';

export function ExportPanel(props: { visible: boolean; host: HostView; query: PublicReturn<'query.read'>['query']; writable: boolean; onChanged: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('csv'), [includeAnswer, setIncludeAnswer] = useState(false);
  const [answer, setAnswer] = useState<PublicReturn<'answer.read'>>(null), [run, setRun] = useState<PublicReturn<'run.read'> | null>(null);
  const [operations, setOperations] = useState<PublicReturn<'export.list'> | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  type Pending = { request: ExportRequest; instanceId: string | null; confirmedAbsent: boolean };
  const pendingByQuery = useRef(new Map<number, Pending>()), [pending, setPending] = useState<Pending | null>(null);
  const owner = `${props.host.instanceId}:${props.query.sessionId}:${props.query.id}`, current = useRef(owner), mounted = useRef(true), order = useRef(0), work = useRef(false);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(()=>{if(!busy&&restoreFocus.current){restoreFocus.current=false;if(props.visible)chooseButton.current?.focus();}},[busy,owner,props.visible]);
  current.current = owner;
  const owns = (key: string) => mounted.current && key === current.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; order.current++; }; }, []);
  useEffect(() => {
    order.current++; setOperations(null); setAnswer(null); setRun(null); setError(null); setBusy(false); setIncludeAnswer(false);
    setPending(pendingByQuery.current.get(props.query.id) ?? null);
  }, [owner]);
  async function refresh(beforeExportId?: number) {
    const key = owner, token = ++order.current;
    try {
      const [exports, savedAnswer, savedRun] = await Promise.all([window.medclaw.request('export.list', { queryId: props.query.id, ...(beforeExportId ? { beforeExportId } : {}) }),
        window.medclaw.request('answer.read', { runId: props.query.runId }), window.medclaw.request('run.read', { runId: props.query.runId })]);
      if (!owns(key) || token !== order.current) return;
      if (exports.ok) setOperations(old => beforeExportId && old ? { items: [...old.items, ...exports.data.items.filter(item => !old.items.some(known => known.operationRef === item.operationRef))], nextBeforeExportId: exports.data.nextBeforeExportId } : exports.data);
      else setError(errorMessage(exports.error));
      if (savedAnswer.ok && (savedAnswer.data === null || savedAnswer.data.sessionId === props.query.sessionId && savedAnswer.data.queryIds.includes(props.query.id))) setAnswer(savedAnswer.data);
      else if (!savedAnswer.ok) setError(errorMessage(savedAnswer.error));
      if (savedRun.ok && savedRun.data.kind === 'one' && savedRun.data.run?.sessionId === props.query.sessionId) setRun(savedRun.data);
      else if (!savedRun.ok) setError(errorMessage(savedRun.error));
    } catch { if (owns(key)) setError('The saved export state could not be read. Read the original operation before retrying.'); }
  }
  useEffect(() => { if (props.visible && props.host.state === 'ready') void refresh(); }, [props.visible, props.host.state, owner]);
  const activityFacts = operations?.items.map(item => `${item.operationRef}:${item.state}:${item.copyState}:${item.artifact?.id}`).join('|');
  useEffect(() => { if (activityFacts) props.onChanged(); }, [owner, activityFacts]);
  const ownerRunPending = run?.kind === 'one' && run.run && !terminal(run.run.status);
  const unfinished = operations?.items.some(item => !terminal(item.state)) || ownerRunPending;
  useEffect(() => {
    if (!props.visible || props.host.state !== 'ready' || !unfinished) return;
    const key = owner;
    let reading = false;
    const timer = setInterval(() => { if (reading) return; reading = true; void (async () => {
      try {
        const saved = await Promise.all((operations?.items.filter(item => !terminal(item.state)) ?? []).map(item => window.medclaw.request('export.read', { operationRef: item.operationRef })));
        if (!owns(key)) return;
        for (const result of saved) if (!result.ok) setError(errorMessage(result.error));
        const facts = saved.flatMap(result => result.ok && result.data ? [result.data] : []);
        setOperations(old => old && ({ ...old, items: old.items.map(item => facts.find(fact => fact.operationRef === item.operationRef) ?? item) }));
        if (ownerRunPending) await refresh();
      } catch { if (owns(key)) setError('The saved export state could not be read.'); }
      finally { reading = false; }
    })(); }, 1000); return () => clearInterval(timer);
  }, [props.visible, props.host.state, owner, activityFacts, !!unfinished, !!ownerRunPending]);
  async function send(original: Pending) {
    const key = owner;
    pendingByQuery.current.set(original.request.queryId, original); if (owns(key)) setPending(original);
    try {
      const result = await window.medclaw.request('export.create', original.request, original.request.operationRef);
      if (result.ok) pendingByQuery.current.delete(original.request.queryId);
      if (!owns(key)) return;
      if (result.ok) { setPending(null); setOperations(old => ({ items: [result.data, ...(old?.items.filter(item => item.operationRef !== result.data.operationRef) ?? [])], nextBeforeExportId: old?.nextBeforeExportId ?? null })); props.onChanged(); }
      else setError(errorMessage(result.error));
    } catch { if (owns(key)) setError('The export result is unconfirmed. Read the original operation before retrying.'); }
  }
  async function create(prior?: ExportOperation) {
    if (work.current || !props.writable || pending && !pending.confirmedAbsent) return;
    work.current = true; setBusy(true); setError(null); const key = owner;
    try {
      const source = { operationRef: crypto.randomUUID(), queryId: props.query.id, answerId: prior ? prior.answerId : includeAnswer ? answer?.id ?? null : null, format: prior?.format ?? format };
      const chosen = await window.medclaw.chooseExportDestination(source);
      if (!owns(key)) return;
      if (!chosen.ok) { setError(errorMessage(chosen.error)); return; }
      if (!chosen.data) return;
      await send({ request: { ...source, ...(prior ? { priorOperationRef: prior.operationRef } : {}), destinationToken: chosen.data.destinationToken }, instanceId: props.host.instanceId, confirmedAbsent: false });
    } catch { if (owns(key)) setError('The export destination could not be selected.'); }
    finally { work.current = false; if (owns(key)) { restoreFocus.current=true;setBusy(false); } }
  }
  async function readOriginal() {
    if (!pending || work.current) return;
    work.current = true; setBusy(true); const key = owner, original = pending;
    try {
      const result = await window.medclaw.request('export.read', { operationRef: original.request.operationRef });
      if (!owns(key)) return;
      if (!result.ok) { setError(errorMessage(result.error)); return; }
      if (result.data) { pendingByQuery.current.delete(props.query.id); setPending(null); await refresh(); props.onChanged(); }
      else { const confirmed = { ...original, confirmedAbsent: true }; pendingByQuery.current.set(props.query.id, confirmed); setPending(confirmed); setError('No saved operation exists for this identity. Resend the original request or choose a new destination.'); }
    } catch { if (owns(key)) setError('The original export result is still unconfirmed.'); }
    finally { work.current = false; if (owns(key)) setBusy(false); }
  }
  async function action(method: 'export.read' | 'export.cancel' | 'export.recover', operation: ExportOperation) {
    if (work.current) return; work.current = true; setBusy(true); const key = owner;
    try {
      const result = await window.medclaw.request(method, { operationRef: operation.operationRef });
      if (!owns(key)) return;
      if (!result.ok) setError(errorMessage(result.error));
      else if (result.data === null) setError('The original export operation was not found.');
      await refresh(); props.onChanged();
    } catch { if (owns(key)) setError('Read the original export to confirm the result of this action.'); }
    finally { work.current = false; if (owns(key)) setBusy(false); }
  }
  const ownerRun = run?.kind === 'one' ? run.run : null;
  return <section className="panel" aria-label="Export saved result"><h2>Export saved result</h2>
    <p>Query {props.query.id} is committed. Export includes every saved result row in its original order, including its original top groups limit.</p>
    <p role="status">{answer ? `Answer ${answer.id} committed · Run ${props.query.runId}` : ownerRun && terminal(ownerRun.status) ? `Run ${ownerRun.status}; no committed answer references this Query.` : 'Query committed; final answer pending.'}</p>
    <div className="form-grid"><label>Export format<select value={format} onChange={event => setFormat(event.target.value as ExportFormat)}><option value="csv">CSV bundle with metadata</option><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
      <label><input type="checkbox" checked={includeAnswer} disabled={!answer} onChange={event => setIncludeAnswer(event.target.checked)} />Include committed answer</label></div>
    <button ref={chooseButton} disabled={busy || !props.writable || !!pending && !pending.confirmedAbsent || props.host.state !== 'ready'} onClick={() => void create()}>Choose destination and export</button>
    {pending && <div role="status"><p>Original export · <code>{pending.request.operationRef}</code></p><button disabled={busy || props.host.state !== 'ready'} onClick={() => void readOriginal()}>Read original export</button>
      <button disabled={busy || !pending.confirmedAbsent || pending.instanceId !== props.host.instanceId || props.host.state !== 'ready'} onClick={() => { work.current = true; setBusy(true); void send(pending).finally(() => { work.current = false; if (owns(owner)) setBusy(false); }); }}>Resend original export</button></div>}
    {error && <p role="alert" className="error-text">{error}</p>}
    <button disabled={busy || props.host.state !== 'ready'} onClick={() => void refresh()}>Refresh exports</button>
    {operations?.items.map(operation => <article key={operation.operationRef}><p><strong>{exportDeliveryLabel(operation)}</strong> · {operation.format} · {operation.state} · Copy {operation.copyState}</p>
      <p className="tiny">Operation <code>{operation.operationRef}</code>{operation.priorOperationRef && <> · Prior <code>{operation.priorOperationRef}</code></>}</p>
      {operation.artifact && <p>Artifact {operation.artifact.id} registered</p>}
      {operation.error && <p role="status">{errorMessage(operation.error)}</p>}
      <div className="actions"><button disabled={busy || props.host.state !== 'ready'} onClick={() => void action('export.read', operation)}>Read export result</button>
        {!terminal(operation.state) ? <button disabled={busy || props.host.state !== 'ready'} onClick={() => void action('export.cancel', operation)}>Cancel export</button> : <>
          {operation.state !== 'completed' && <button disabled={busy || props.host.state !== 'ready'} onClick={() => void action('export.recover', operation)}>Verify and recover artifact</button>}
          <button disabled={busy || !props.writable || props.host.state !== 'ready' || !!pending && !pending.confirmedAbsent} onClick={() => void create(operation)}>Choose destination for new attempt</button></>}
      </div></article>)}
    {operations && !operations.items.length && <p>No exports for this Query.</p>}
    {operations?.nextBeforeExportId && <button disabled={busy} onClick={() => void refresh(operations.nextBeforeExportId!)}>More exports</button>}
  </section>;
}
