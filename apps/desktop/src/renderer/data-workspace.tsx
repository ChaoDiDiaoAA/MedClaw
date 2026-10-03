import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../../packages/contracts/src/error';
import type { Artifact, ImportOperation, ImportPreview } from '../../../../packages/contracts/src/data';
import type { HostView } from '../../../../packages/contracts/src/model';
import type { Batch } from '../../../../packages/contracts/src/query';
import type { PublicReturn } from '../../../../packages/contracts/src/protocol';
import type { WorkspaceChange, WorkspaceView } from '../../../../packages/contracts/src/workspace';
import { ContextPanel } from './context-panel';

const unsettled = (operation: ImportOperation | null) => !!operation && ['preparing', 'committing'].includes(operation.state);
export function DataWorkspace(props: { host: HostView; workspace: WorkspaceView | null; confirmed: boolean; batches: Batch[]; catalog: PublicReturn<'data.read'> | null; onRefresh: (page?: number) => void; onUpdate: (change: WorkspaceChange) => Promise<boolean>; onError: (message: string | null) => void }) {
  const [operation, setOperation] = useState<ImportOperation | null>(null), [preview, setPreview] = useState<ImportPreview | null>(null), [artifact, setArtifact] = useState<Artifact | null>(null);
  const [operationRef, setOperationRef] = useState(''), [lookup, setLookup] = useState(''), [directoryName, setDirectoryName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [selected, setSelected] = useState<number[]>([]), [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<PublicReturn<'data.rows'> | null>(null), [rowKind, setRowKind] = useState<'devices' | 'changes'>('devices'), [rowBatch, setRowBatch] = useState<number | null>(null), [rowsLoading, setRowsLoading] = useState(false);
  const rowTarget = useRef<{ instanceId: string | null; batchId: number | null; kind: 'devices' | 'changes' }>({ instanceId: props.host.instanceId, batchId: rowBatch, kind: rowKind }), rowOrder = useRef(0);
  rowTarget.current = { instanceId: props.host.instanceId, batchId: rowBatch, kind: rowKind };
  const original = useRef<{ operationRef: string; fileToken: string } | null>(null), committing = useRef<string | null>(null), current = useRef({ instanceId: props.host.instanceId, operationRef }), mounted = useRef(true), readOrder = useRef(0);
  current.current = { instanceId: props.host.instanceId, operationRef };
  const capture = () => ({ ...current.current });
  const owns = (target: ReturnType<typeof capture>) => mounted.current && target.instanceId === current.current.instanceId && target.operationRef === current.current.operationRef;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setSelected(props.workspace?.batchRefs.map(batch => batch.id) ?? []); }, [props.workspace?.revision]);
  useEffect(() => { original.current = null; committing.current = null; setBusy(false); setUnknown(!!current.current.operationRef); }, [props.host.instanceId]);
  useEffect(() => { setRows(null); rowOrder.current++; setRowsLoading(false); }, [props.host.instanceId]);
  async function readRows(batchId: number, kind: 'devices' | 'changes', page = 1) {
    if (rowTarget.current.batchId !== batchId || rowTarget.current.kind !== kind) setRows(null);
    setRowBatch(batchId); setRowKind(kind); rowTarget.current = { instanceId: props.host.instanceId, batchId, kind };
    const target = { ...rowTarget.current }, order = ++rowOrder.current; setRowsLoading(true);
    const result = await window.medclaw.request('data.rows', { batchId, kind, page });
    if (!mounted.current || order !== rowOrder.current || target.instanceId !== rowTarget.current.instanceId || target.batchId !== rowTarget.current.batchId || target.kind !== rowTarget.current.kind) return;
    if (result.ok && result.data.kind === kind) setRows(result.data); else props.onError(result.ok ? 'The data reply does not match this view.' : errorMessage(result.error));
    setRowsLoading(false);
  }
  async function readOperation(ref = current.current.operationRef) {
    if (!ref) return;
    const instanceId = current.current.instanceId, order = ++readOrder.current;
    const result = await window.medclaw.request('import.read', { operationRef: ref });
    if (!mounted.current || instanceId !== current.current.instanceId || order !== readOrder.current || ref !== current.current.operationRef) return;
    if (!result.ok) { if (result.error.code === 'operation_result_unknown') setUnknown(true); else props.onError(errorMessage(result.error)); return; }
    const waitingForCommit = committing.current === ref && !!result.data && ['preparing', 'ready'].includes(result.data.state);
    if (result.data && !waitingForCommit) committing.current = null;
    setOperation(result.data); setPreview(result.data?.preview ?? null); setUnknown(waitingForCommit || !result.data && original.current?.operationRef === ref);
    if (!result.data) props.onError('No saved import was found for this operation ID. Keep the original ID if the request result is unconfirmed.');
    if (result.data?.artifactId) {
      const copy = await window.medclaw.request('evidence.readArtifact', { artifactId: result.data.artifactId });
      if (!mounted.current || instanceId !== current.current.instanceId || ref !== current.current.operationRef || order !== readOrder.current) return;
      if (copy.ok) setArtifact(copy.data); else props.onError(errorMessage(copy.error));
    } else setArtifact(null);
    if (result.data?.result?.status === 'imported' || result.data?.result?.status === 'duplicate') props.onRefresh();
  }
  useEffect(() => {
    if (props.host.state !== 'ready' || !operationRef || !unknown && !unsettled(operation)) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await readOperation(); if (!disposed) timer = setTimeout(() => void poll(), 1000); };
    timer = setTimeout(() => void poll(), 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [props.host.state, props.host.instanceId, operationRef, operation?.state, unknown]);
  async function chooseDirectory() {
    if (busy || unknown || unsettled(operation)) return;
    const ref = crypto.randomUUID(), instanceId = current.current.instanceId;
    setBusy(true); props.onError(null);
    try {
      const selection = await window.medclaw.pickImportDirectory(ref);
      if (!mounted.current || instanceId !== current.current.instanceId) return;
      if (!selection.ok) { props.onError(errorMessage(selection.error)); return; }
      const selected = selection.data;
      if (!selected) return;
      original.current = { operationRef: ref, fileToken: selected.fileToken };
      current.current.operationRef = ref; setOperationRef(ref); setLookup(ref); setDirectoryName(selected.directoryName); setOperation(null); setPreview(null); setArtifact(null); setUnknown(true);
      const result = await window.medclaw.request('import.preview', { operationRef: ref, fileToken: selected.fileToken, mappingVersion: 'medclaw.snapshot/v1' }, ref);
      if (!owns({ instanceId, operationRef: ref })) return;
      if (result.ok) { setPreview(result.data); setUnknown(false); } else { if (result.error.code !== 'operation_result_unknown') props.onError(errorMessage(result.error)); setUnknown(result.error.code === 'operation_result_unknown'); }
      await readOperation(ref);
    } catch { if (instanceId === current.current.instanceId) { props.onError('The directory selection or import reply is unconfirmed. Read the original operation before trying again.'); setUnknown(!!current.current.operationRef); } }
    finally { if (mounted.current && instanceId === current.current.instanceId) setBusy(false); }
  }
  async function commit() {
    const request = original.current, value = preview, target = capture();
    if (!request || !value?.canCommit || request.operationRef !== value.operationRef || busy || unknown || operation?.state !== 'ready') return;
    committing.current = request.operationRef; setBusy(true); setUnknown(true); props.onError(null);
    try {
      const result = await window.medclaw.request('import.commit', { ...request, previewHash: value.previewHash }, request.operationRef);
      if (!owns(target)) return;
      if (result.ok) { committing.current = null; setOperation(result.data); setUnknown(false); props.onRefresh(); } else { if (result.error.code !== 'operation_result_unknown') { committing.current = null; props.onError(errorMessage(result.error)); } setUnknown(result.error.code === 'operation_result_unknown'); }
      await readOperation(request.operationRef);
    } finally { if (owns(target)) setBusy(false); }
  }
  async function control(method: 'import.cancel' | 'import.recover') {
    const target = capture(); if (!target.operationRef) return;
    const result = await window.medclaw.request(method, { operationRef: target.operationRef }, crypto.randomUUID());
    if (!owns(target)) return;
    if (result.ok) { setOperation(result.data); setPreview(result.data.preview); setUnknown(false); } else if (result.error.code === 'operation_result_unknown') setUnknown(true); else props.onError(errorMessage(result.error));
    await readOperation();
  }
  function lookUp() {
    const ref = lookup.trim(); if (!ref || busy) return;
    current.current.operationRef = ref; setOperationRef(ref); setOperation(null); setPreview(null); setArtifact(null); setUnknown(true);
    if (original.current?.operationRef !== ref) { original.current = null; committing.current = null; setDirectoryName(null); }
    void readOperation(ref);
  }
  async function applySelection() { setSaving(true); try { await props.onUpdate({ batchIds: selected, activeView: 'data' }); } finally { setSaving(false); } }
  return <div className="data-layout">
    <section className="panel"><div className="section-heading"><div><span className="eyebrow">Snapshot packages</span><h2>Import data</h2></div><button className="primary" disabled={props.host.state !== 'ready' || busy || unknown || unsettled(operation)} onClick={() => void chooseDirectory()}>Choose snapshot directory</button></div>
      <p className="muted">Preview the package and confirm its dates, scope and row counts before importing it.</p>
      <div className="operation-lookup"><label>Import operation ID<input value={lookup} onChange={event => setLookup(event.target.value)} placeholder="Read an earlier import using its original ID" /></label><button disabled={props.host.state !== 'ready' || !lookup.trim() || busy} onClick={lookUp}>Read import</button></div>
      {(busy || unknown) && <p role="status">{unknown ? 'Waiting for the saved import result. This operation is checked automatically.' : committing.current || operation?.state === 'committing' ? 'Importing the confirmed package…' : 'Preparing the selected snapshot package…'}</p>}
      {operationRef && <div className="import-operation"><p><strong>{directoryName ?? 'Saved import'}</strong> <span className="status-chip" data-testid="import-state">{operation?.state ?? 'Result unconfirmed'}</span></p><p className="tiny">Original operation ID: <code>{operationRef}</code></p>
        {preview && <><dl className="facts"><dt>Date range</dt><dd>{preview.dateRange.start || 'Not established'} – {preview.dateRange.endInclusive || 'Not established'}</dd><dt>Region / scope</dt><dd>{preview.region || 'Not established'} · {preview.scopeKeys.join(', ') || 'Not established'}</dd><dt>Material version</dt><dd>{preview.materialVersion || 'Not established'}</dd><dt>Package counts</dt><dd>{preview.fileCount} files · {preview.batchCount} batches · {preview.entityCount} devices · {preview.rowCount} rows</dd><dt>New / duplicate batches</dt><dd>{preview.newBatchCount} / {preview.duplicateBatchCount}</dd><dt>Time context</dt><dd>{preview.referenceDate || 'Not established'} · {preview.timezone || 'Not established'}</dd><dt>Preview hash</dt><dd><code>{preview.previewHash || 'No complete preview'}</code></dd></dl>
          {preview.issues.length > 0 && <div className="import-issues"><h3>Package issues</h3>{preview.issues.map((issue, index) => <p className="error-text tiny" key={index}>{issue.file ?? 'Package'}{issue.row ? ` · Row ${issue.row}` : ''}{issue.field ? ` · ${issue.field}` : ''} · {issue.code} · {issue.message}</p>)}</div>}
          {preview.canCommit && operation?.state === 'ready' && <div className="confirmation"><p>Confirm this preview to import all new batches in one transaction.</p>{!original.current && <p className="tiny muted">Choose and preview the directory again under a new operation ID to authorize a new import.</p>}<button className="primary" disabled={busy || unknown || !original.current || props.host.state !== 'ready'} onClick={() => void commit()}>Confirm import</button></div>}
        </>}
        {operation?.result && <p data-testid="import-result">{operation.result.status} · {operation.result.acceptedRows} accepted rows · {operation.result.duplicateRows} duplicate rows · {operation.result.rejectedRows} rejected rows</p>}
        {operation?.error && <p role="alert" className="error-text">{errorMessage(operation.error)}</p>}
        {artifact && <p className="tiny">Managed copy: Artifact {artifact.id} · {artifact.status} · {artifact.bytes ?? 'Unknown'} bytes. A saved copy alone does not confirm imported batches.</p>}
        <div className="actions"><button disabled={props.host.state !== 'ready'} onClick={() => void readOperation()}>Read original result</button><button disabled={props.host.state !== 'ready' || !!operation?.result || operation?.state === 'cancelled'} onClick={() => void control('import.cancel')}>Cancel import</button><button disabled={props.host.state !== 'ready' || busy || unsettled(operation)} onClick={() => void control('import.recover')}>Verify saved operation</button></div>
      </div>}
    </section>
    <section className="panel"><div className="section-heading"><div><span className="eyebrow">Imported facts</span><h2>Available batches</h2></div><button disabled={props.host.state !== 'ready'} onClick={() => props.onRefresh()}>Refresh imported data</button></div>
      <p className="tiny muted">Catalog revision: {props.catalog?.catalogRevision ?? 'Unconfirmed'} · {props.catalog?.batchCount ?? 'Unknown'} batches · {props.catalog?.deviceCount ?? 'Unknown'} devices · {props.catalog?.snapshotCount ?? 'Unknown'} snapshots · {props.catalog?.changeCount ?? 'Unknown'} changes. Selecting batches changes the next message. A running request keeps its original scope.</p>
      {!props.batches.length && <p className="muted">Import a valid snapshot package to select its batches.</p>}
      {!!props.batches.length && <div className="table-scroll"><table><thead><tr><th scope="col">Use</th><th scope="col">Batch / date</th><th scope="col">Region / scope</th><th scope="col">Observed / expected</th><th scope="col">Declared missing</th><th scope="col">Material version</th><th scope="col">Read</th></tr></thead><tbody>{props.batches.map(batch => <tr key={batch.id}><td><input type="checkbox" aria-label={`Select batch ${batch.id}`} checked={selected.includes(batch.id)} disabled={!props.confirmed || saving} onChange={event => setSelected(old => event.target.checked ? [...old, batch.id] : old.filter(id => id !== batch.id))} /></td><td>{batch.id} · {batch.snapshotDate}</td><td>{batch.region}<br /><span className="tiny muted">{batch.scopeKey}</span></td><td>{batch.observedEntityCount} / {batch.expectedEntityCount}</td><td>{batch.declaredMissingDeviceIds.length}</td><td>{batch.materialVersion}</td><td><button disabled={rowsLoading} onClick={() => void readRows(batch.id, 'devices')}>Read batch {batch.id} devices</button><button disabled={rowsLoading} onClick={() => void readRows(batch.id, 'changes')}>Read batch {batch.id} changes</button></td></tr>)}</tbody></table></div>}
      <div className="actions"><button disabled={!props.confirmed || saving} onClick={() => setSelected(old => [...new Set([...old, ...props.batches.map(batch => batch.id)])])}>Select batches on this page</button><button disabled={!props.confirmed || saving} onClick={() => setSelected([])}>Clear batch selection</button><button className="primary" disabled={!props.confirmed || saving} onClick={() => void applySelection()}>{saving ? 'Applying…' : `Apply ${selected.length} selected batches`}</button>{props.catalog && <><button disabled={props.catalog.page <= 1} onClick={() => props.onRefresh(props.catalog!.page - 1)}>Previous batch page</button><button disabled={props.catalog.page * props.catalog.pageSize >= props.catalog.batchCount} onClick={() => props.onRefresh(props.catalog!.page + 1)}>Next batch page</button></>}</div>
    </section>
    {rowBatch && <section className="panel"><div className="section-heading"><h2>Batch {rowBatch} · {rowKind === 'devices' ? 'Devices' : 'Changes'}</h2><div className="actions"><button disabled={rowsLoading} onClick={() => void readRows(rowBatch, 'devices')}>Devices</button><button disabled={rowsLoading} onClick={() => void readRows(rowBatch, 'changes')}>Changes</button></div></div>{rowsLoading && <p role="status">Reading saved data…</p>}{rows && <><p className="tiny muted">{rows.totalRows} rows · Page {rows.page}</p>{!rows.items.length ? <p>No saved rows on this page.</p> : <div className="table-scroll"><table data-testid="data-rows"><thead><tr>{rows.kind === 'devices' ? <><th>Device / snapshot</th><th>Price / status</th><th>Manufacturer / distributor</th><th>Source row / origins</th></> : <><th>Device / event</th><th>Kind / field</th><th>Old / new value</th><th>Delta / ratio</th></>}</tr></thead><tbody>{rows.items.map(item => <tr key={item.id}>{'deviceName' in item ? <><td>{item.deviceId} · {item.deviceName}<br /><span className="tiny">Snapshot {item.id}</span></td><td>{item.priceCents === null ? 'Missing price' : `${item.priceCents} CNY cents / ${item.unit}`}<br />{item.status ?? 'Missing status'}</td><td>{item.manufacturer ?? 'Missing'}<br />{item.distributor ?? 'Missing'}</td><td>{item.sourceRowRef}<details><summary>Field origins</summary>{Object.entries(item.fieldOrigins).map(([field, origin]) => <p className="tiny" key={field}>{field} · {origin.kind} · {origin.ruleId}</p>)}</details></td></> : <><td>{item.deviceId} · Event {item.id}</td><td>{item.kind} · {item.field ?? 'None'}</td><td>{item.oldValue === null ? 'Missing' : String(item.oldValue)} → {item.newValue === null ? 'Missing' : String(item.newValue)}</td><td>{item.deltaCents ?? 'Not applicable'} CNY cents<br />Ratio: {item.ratio ?? 'Undefined'}</td></>}</tr>)}</tbody></table></div>}<div className="actions"><button disabled={rowsLoading || rows.page <= 1} onClick={() => void readRows(rowBatch, rowKind, rows.page - 1)}>Previous data page</button><button disabled={rowsLoading || rows.page * rows.pageSize >= rows.totalRows} onClick={() => void readRows(rowBatch, rowKind, rows.page + 1)}>Next data page</button></div></>}</section>}
    <section className="panel"><ContextPanel workspace={props.workspace} confirmed={props.confirmed} onUpdate={props.onUpdate} /></section>
  </div>;
}
