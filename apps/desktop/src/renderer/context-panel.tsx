import { useEffect, useState } from 'react';
import type { WorkspaceChange, WorkspaceView } from '../../../../packages/contracts/src/workspace';
import type { RunScope } from '../../../../packages/contracts/src/run';

export function ContextPanel(props: { workspace: WorkspaceView | null; confirmed: boolean; frozen?: RunScope; disabled?: boolean; onUpdate: (change: WorkspaceChange) => Promise<boolean> }) {
  const [devices, setDevices] = useState(''), [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
  useEffect(() => { setDevices(props.workspace?.deviceIds.join(', ') ?? ''); setError(null); }, [props.workspace?.revision, props.workspace?.sessionId]);
  async function applyDevices() {
    const ids = devices.trim() ? devices.split(/[,\s]+/).filter(Boolean).map(Number) : [];
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) { setError('Enter distinct positive device IDs, separated by commas.'); return; }
    setSaving(true); setError(null);
    try { await props.onUpdate({ deviceIds: ids }); } finally { setSaving(false); }
  }
  return <section className="context-panel" aria-label="Data selection">
    <div className="section-heading"><div><span className="eyebrow">Next message</span><h3>Data selection</h3></div><span className="status-chip">{props.confirmed ? `Revision ${props.workspace?.revision ?? 0}` : 'Selection unconfirmed'}</span></div>
    <p className="tiny muted">{props.workspace?.batchRefs.length ? `${props.workspace.batchRefs.length} selected batches · ${props.workspace.materialVersion ?? 'Unknown material version'}` : 'Select imported batches in Data Workspace to make them available to the next message.'}</p>
    {!!props.workspace?.batchRefs.length && <p className="tiny">{props.workspace.batchRefs.map(batch => `${batch.id} (${batch.snapshotDate})`).join(', ')}</p>}
    <div className="selection-fields"><label>Device IDs<input aria-label="Selected device IDs" value={devices} placeholder="All devices in the selected batches" onChange={event => setDevices(event.target.value)} disabled={!props.confirmed || props.disabled || saving} /></label><button disabled={!props.confirmed || props.disabled || saving} onClick={() => void applyDevices()}>{saving ? 'Applying…' : 'Apply devices'}</button></div>
    {props.workspace?.queryId && <p className="tiny">Selected saved query: {props.workspace.queryId}</p>}
    {props.frozen && <details><summary>Current Run uses its frozen selection</summary><p className="tiny">Batches: {props.frozen.batchIds.join(', ') || 'None'} · Devices: {props.frozen.deviceIds?.join(', ') || 'All in scope'}</p></details>}
    {error && <p role="alert" className="error-text">{error}</p>}
  </section>;
}
