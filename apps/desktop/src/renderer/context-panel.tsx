import { useEffect, useRef, useState } from 'react';
import type { WorkspaceChange, WorkspaceView } from '../../../../packages/contracts/src/workspace';
import type { RunScope } from '../../../../packages/contracts/src/run';
import type { SessionInput } from '../../../../packages/contracts/src/session';

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
