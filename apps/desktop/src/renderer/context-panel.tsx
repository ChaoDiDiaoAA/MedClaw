import { useEffect, useRef, useState } from 'react';
import type { WorkspaceChange, WorkspaceView } from '../../../../packages/contracts/src/workspace';
import type { RunScope } from '../../../../packages/contracts/src/run';
import type { SessionInput } from '../../../../packages/contracts/src/session';
import type { ContextReadResult } from '../../../../packages/contracts/src/context';
import type { HostView } from '../../../../packages/contracts/src/model';
import { errorMessage } from '../../../../packages/contracts/src/error';

/** Original call ownership is independent of the page's editable Workspace. */
export function ContextDetails(props: {host:HostView;callId:string;runId:number;sessionId:number|null}) {
  const [result,setResult] = useState<ContextReadResult|null>(null), [loading,setLoading] = useState(false), [error,setError] = useState<string|null>(null);
  const key = JSON.stringify([props.host.instanceId,props.host.state,props.callId,props.runId,props.sessionId]), target = useRef({key,epoch:0}), mounted = useRef(true), order = useRef(0);
  if (target.current.key !== key) target.current = {key,epoch:target.current.epoch+1};
  useEffect(() => {mounted.current = true;return () => {mounted.current = false;};},[]);
  useEffect(() => {setResult(null);setError(null);setLoading(false);order.current++;},[key]);
  async function read() {
    const captured = {...target.current,order:++order.current}; setLoading(true); setError(null);
    try {
      const reply = await window.medclaw.request('context.read',{callId:props.callId});
      if (!mounted.current || captured.epoch !== target.current.epoch || captured.order !== order.current) return;
      if (!reply.ok) setError(errorMessage(reply.error));
      else {
        const value = reply.data, owner = value.kind === 'snapshot' ? value.snapshot : value;
        if (owner.runId !== props.runId || owner.sessionId !== props.sessionId || (value.kind === 'snapshot' ? value.selectedCallId : value.callId) !== props.callId) setError('Context ownership could not be verified. Read the original call again.');
        else setResult(value);
      }
    } catch { if (mounted.current && captured.epoch === target.current.epoch && captured.order === order.current) setError('Context could not be read. Try reading the original call again.'); }
    finally {if (mounted.current && captured.epoch === target.current.epoch && captured.order === order.current) setLoading(false);}
  }
  return <section className="context-detail" data-testid="context-details" data-call-id={props.callId} aria-label={`Context for call ${props.callId}`}>
    <button disabled={props.host.state !== 'ready'} aria-disabled={loading} aria-busy={loading} onClick={() => {if (!loading) void read();}} aria-label={`${result ? 'Refresh' : 'View'} context for call ${props.callId}`}>{loading ? 'Reading context…' : result ? 'Refresh context' : 'View context'}</button>
    {error && <p role="alert" className="error-text">{error}</p>}
    {result?.kind === 'not_recorded' && <p role="status">{result.reason === 'pre_p8' ? 'Context was not recorded for this pre-P8 call.' : 'Context snapshots do not apply to this Provider, diagnostic or compaction call.'}</p>}
    {result?.kind === 'snapshot' && <>
      <p className="tiny">Snapshot {result.snapshot.id} · Run {result.snapshot.runId} · Session {result.snapshot.sessionId} · Input {result.snapshot.inputId ?? 'Unknown'} · Selection revision {result.snapshot.workspaceContext?.revision ?? 'Unknown'}</p>
      <h4>Selected materials</h4>
      {!result.snapshot.selectedRefs.length && <p className="muted">No material references were selected.</p>}
      {result.snapshot.selectedRefs.map(ref => <details key={`${ref.kind}:${ref.id}:${ref.channel}`}><summary>{ref.kind.replaceAll('_',' ')} {ref.id} · {ref.channel === 'native_history' ? 'Native history observed' : 'Product projection'}</summary><dl className="facts"><dt>Version</dt><dd>{ref.version}</dd></dl></details>)}
      <details><summary>Rendered materials and sources</summary><pre>{result.snapshot.renderedProjection}</pre></details>
      <details><summary>Frozen runtime feedback</summary><pre>{result.snapshot.runtimeFeedback}</pre></details>
      {!!result.snapshot.omitted.length && <p role="status">Optional rows omitted to fit the material limit: {result.snapshot.omitted.map(item => `${item.kind} ${item.id}: ${item.omittedRows}`).join('; ')}.</p>}
      <h4>Actual delivery associations</h4>
      {result.evidence === 'persistence_gap' && <p role="alert" className="error-text">Delivery evidence has not been confirmed saved. Retry saving the original Run.</p>}
      {result.evidence === 'unconfirmed' && <p role="status">Delivery is unconfirmed for this call. Saving a snapshot does not confirm a model request.</p>}
      {result.deliveries.map(delivery => <details key={`${delivery.modelCallId}:${delivery.snapshotId}`} open><summary>Call {delivery.callId} · Saved HTTP observation</summary><dl className="facts"><dt>API</dt><dd>{delivery.observation.api}</dd><dt>Response</dt><dd>HTTP {delivery.observation.httpStatus} · {delivery.deliveredAt}</dd><dt>Provider input verified</dt><dd>{delivery.observation.verifiedNativeRefs.map(ref => `${ref.kind} ${ref.id}`).join(', ') || 'No additional native references verified'}</dd></dl></details>)}
      <p className="tiny muted">Matched materials and a successful HTTP response establish delivery evidence. They do not establish model understanding or answer quality.</p>
    </>}
  </section>;
}

export function ContextPanel(props: { workspace: WorkspaceView | null; confirmed: boolean; frozen?: RunScope; frozenInput?: SessionInput | null; frozenRunId?: number; disabled?: boolean; recovery?: 'verify' | 'restart' | null; onVerify?: () => void; onUpdate: (change: WorkspaceChange) => Promise<boolean> }) {
  const [devices, setDevices] = useState(''), [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
  const dirty = useRef(false), session = useRef(props.workspace?.sessionId);
  useEffect(() => { if (session.current !== props.workspace?.sessionId) dirty.current = false; session.current = props.workspace?.sessionId; if (!dirty.current) setDevices(props.workspace?.deviceIds.join(', ') ?? ''); setError(null); }, [props.workspace?.revision, props.workspace?.sessionId]);
  async function applyDevices() {
    const ids = devices.trim() ? devices.split(/[,\s]+/).filter(Boolean).map(Number) : [];
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) { setError('Enter distinct positive device IDs, separated by commas.'); return; }
    setSaving(true); setError(null);
    try { if (await props.onUpdate({ deviceIds: ids })) dirty.current = false; } finally { setSaving(false); }
  }
  return <section className="context-panel" aria-label="Data selection">
    <div className="section-heading"><div><span className="eyebrow">Next message</span><h3>Data selection</h3></div><span className="status-chip">{props.confirmed ? `Revision ${props.workspace?.revision ?? 0}` : 'Selection unconfirmed'}</span></div>
    {props.recovery === 'verify' && <button disabled={props.disabled} onClick={props.onVerify}>Verify saved selection</button>}
    {props.recovery === 'restart' && <p role="status">Verify status in Settings and restart the Host.</p>}
    {props.workspace?.notices?.map((notice, index) => <p role="status" key={`${notice.kind}:${notice.targetId}:${index}`}>Selection cleared because its reference is no longer available.</p>)}
    <p className="tiny muted">{props.workspace?.batchRefs.length ? `${props.workspace.batchRefs.length} selected batches · ${props.workspace.materialVersion ?? 'Unknown material version'}` : 'Select imported batches in Data Workspace to make them available to the next message.'}</p>
    {!!props.workspace?.batchRefs.length && <p className="tiny">{props.workspace.batchRefs.map(batch => `${batch.id} (${batch.snapshotDate})`).join(', ')}</p>}
    <div className="selection-fields"><label>Device IDs<input aria-label="Selected device IDs" value={devices} placeholder="All devices in the selected batches" onChange={event => { dirty.current = true; setDevices(event.target.value); }} disabled={!props.confirmed || props.disabled || saving} /></label><button disabled={!props.confirmed || props.disabled || saving} onClick={() => void applyDevices()}>{saving ? 'Applying…' : 'Apply devices'}</button></div>
    {props.workspace?.queryId && <p className="tiny">Selected saved query: {props.workspace.queryId}</p>}
    {props.workspace?.selection && <div data-testid="confirmed-selection"><p className="tiny">Selected {props.workspace.selection.kind} {props.workspace.selection.targetId} · {props.workspace.selection.rowKey ?? 'Whole evidence'} · {props.workspace.selection.field ?? 'Whole row'}</p><button disabled={!props.confirmed || props.disabled || saving} onClick={() => void props.onUpdate({ selection: null })}>Clear selection</button></div>}
    {props.frozen && <details><summary>Current Run uses its frozen selection</summary><p className="tiny">Batches: {props.frozen.batchIds.join(', ') || 'None'} · Devices: {props.frozen.deviceIds?.join(', ') || 'All in scope'}</p></details>}
    {props.frozenInput?.workspaceContext && <details data-testid="frozen-input-context"><summary>Original accepted Input {props.frozenInput.id} · Run {props.frozenRunId}</summary><p className="tiny">Session {props.frozenInput.sessionId} · Revision {props.frozenInput.workspaceContext.revision} · Batches {props.frozenInput.workspaceContext.batchRefs.map(batch => batch.id).join(', ') || 'None'} · Devices {props.frozenInput.workspaceContext.deviceIds.join(', ') || 'All in scope'}</p><p className="tiny">Query {props.frozenInput.workspaceContext.queryId ?? 'None'} · {props.frozenInput.workspaceContext.selection ? `${props.frozenInput.workspaceContext.selection.rowKey ?? 'Whole evidence'} · ${props.frozenInput.workspaceContext.selection.field ?? 'Whole row'}` : 'No fine selection'}</p></details>}
    {error && <p role="alert" className="error-text">{error}</p>}
  </section>;
}
