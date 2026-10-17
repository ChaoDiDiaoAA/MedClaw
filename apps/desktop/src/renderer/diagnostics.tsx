import { useState } from "react";
import { errorMessage } from "../../../../packages/contracts/src/error";
import type { DiagnosticsView, DesktopPayload, DesktopReturn } from "../../../../packages/contracts/src/protocol";

type Categories = NonNullable<DesktopPayload<'diagnostics.export'>['categories']>;
type SupportChoice = NonNullable<DesktopReturn<'diagnostics.selectDestination'>> & { operationRef: string; categories: Categories; attempted: boolean };

export function Diagnostics(props: { onError: (message: string | null) => void; exportAvailable?: boolean }) {
  const [view, setView] = useState<DiagnosticsView | null>(null);
  const [trace, setTrace] = useState(false);
  const [loading, setLoading] = useState(false);
  const [supportBusy, setSupportBusy] = useState(false);
  const [support, setSupport] = useState<SupportChoice | null>(null);
  const [receipt, setReceipt] = useState<DesktopReturn<'diagnostics.export'> | null>(null);
  const categories = (includeTrace = trace): Categories => ['versions', 'host', 'errors', 'runtime', ...(includeTrace ? ['prompt_trace' as const] : [])];
  async function read() {
    setLoading(true);
    try {
      const result = await window.medclaw.request("diagnostics.read", { categories: ["versions", "host", "errors", "runtime", ...(trace ? ["prompt_trace" as const] : [])] });
      if (result.ok) setView(result.data); else props.onError(errorMessage(result.error));
    } finally { setLoading(false); }
  }
  async function discardUnusedSupport(): Promise<boolean> {
    if (!support || support.attempted) return true;
    const result = await window.medclaw.request('maintenance.discardSelection', {}, support.operationRef);
    if (!result.ok) { props.onError(errorMessage(result.error)); return false; }
    setSupport(null); setReceipt(null); return true;
  }
  async function chooseSupport() {
    setSupportBusy(true); props.onError(null);
    try {
      if (!await discardUnusedSupport()) return;
      const operationRef = crypto.randomUUID(), selected = await window.medclaw.request('diagnostics.selectDestination', { purpose: 'create' }, operationRef);
      if (!selected.ok) props.onError(errorMessage(selected.error));
      else if (selected.data) { setSupport({ ...selected.data, operationRef, categories: categories(), attempted: false }); setReceipt(null); }
    } finally { setSupportBusy(false); }
  }
  async function exportSupport() {
    if (!support || support.attempted) return;
    setSupportBusy(true); setSupport({ ...support, attempted: true }); props.onError(null);
    try {
      const result = await window.medclaw.request('diagnostics.export', { destinationToken: support.destinationToken, categories: support.categories }, support.operationRef);
      if (result.ok) setReceipt(result.data);
      else { if (result.error.code === 'maintenance_busy') setSupport({ ...support, attempted: false }); props.onError(errorMessage(result.error)); }
    } finally { setSupportBusy(false); }
  }
  async function readSupport() {
    setSupportBusy(true); props.onError(null);
    try {
      if (!await discardUnusedSupport()) return;
      const selected = await window.medclaw.request('diagnostics.selectDestination', { purpose: 'read' });
      if (!selected.ok) { props.onError(errorMessage(selected.error)); return; }
      if (!selected.data?.original) return;
      const original = selected.data.original;
      setSupport({ ...selected.data, ...original, attempted: true }); setTrace(original.categories.includes('prompt_trace')); setReceipt(null);
      const result = await window.medclaw.request('diagnostics.readExport', { destinationToken: selected.data.destinationToken, categories: original.categories }, original.operationRef);
      if (!result.ok) props.onError(errorMessage(result.error));
      else if (result.data) setReceipt(result.data);
      else props.onError('No original support result is available; the operation remains unconfirmed.');
    } finally { setSupportBusy(false); }
  }
  return <section className="panel diagnostics" aria-labelledby="diagnostics-title">
    <div className="section-heading"><h2 id="diagnostics-title">Diagnostics</h2><button disabled={loading || supportBusy} onClick={() => void read()}>{loading ? "Reading…" : "Read diagnostics"}</button></div>
    <label className="checkbox-label"><input type="checkbox" checked={trace} disabled={supportBusy || support?.attempted} onChange={event => { setTrace(event.target.checked); if (support) setSupport({ ...support, categories: categories(event.target.checked) }); }} />Include in-memory call stage summaries</label>
    <p className="muted">Diagnostics include bounded safe summaries. Main status remains available when Host is unreachable. Read again to refresh this snapshot.</p>
    <p className="muted">Support bundles contain versions, safe stage summaries and errors. Program paths are reduced to file names; credentials, database contents and model text are excluded.</p>
    {props.exportAvailable === false && <p role="status">Repair application startup before selecting or exporting a support bundle.</p>}
    <div className="actions"><button disabled={props.exportAvailable === false || supportBusy || loading} onClick={() => void chooseSupport()}>Choose support destination</button><button disabled={props.exportAvailable === false || supportBusy || loading || !support || support.attempted} onClick={() => void exportSupport()}>Export support bundle</button><button disabled={props.exportAvailable === false || supportBusy || loading} onClick={() => void readSupport()}>Read original support bundle</button></div>
    {support && <><p>{support.displayName}</p><p className="muted">Original support operation: {support.operationRef}</p></>}
    {receipt && <p role="status">Support bundle completion receipt · {receipt.bytes} bytes · {receipt.partial ? 'Partial diagnostic sources' : 'All diagnostic sources available'}. This receipt describes the saved file.</p>}
    {view && <>
      <p role="status">{view.partial ? `Diagnostics partially available; missing sources: ${view.missingSources.join(", ")}` : "All diagnostic sources available"}</p>
      <dl className="facts"><dt>Host snapshot</dt><dd>{view.host.state} · {view.host.instanceId ?? "No instance"}</dd></dl>
      {view.dependencies?.length ? <div className="table-scroll"><table aria-label="Selected tool dependencies"><thead><tr><th>Tool</th><th>Selected program</th><th>Version</th><th>Source</th></tr></thead><tbody>{view.dependencies.map(dependency => <tr key={dependency.name}><td>{dependency.name}</td><td>{dependency.path}</td><td>{dependency.version}</td><td>{dependency.source === 'installed_bundle' ? 'Application bundle' : 'SDK standard discovery'}</td></tr>)}</tbody></table></div> : <p className="muted">Tool selection is unavailable in this diagnostic snapshot.</p>}
      <div className="diagnostic-entries">{!view.entries.length && <p className="muted">No in-memory summaries to display.</p>}{view.entries.map((entry, index) => <article key={index}><span className="tiny muted">{entry.at} · {entry.source} · {entry.category}{entry.runId ? ` · Run ${entry.runId}` : ""}</span><p>{entry.error ? errorMessage(entry.error) : entry.message}</p>{entry.error && <p className="error-text">{entry.error.code} · {errorMessage(entry.error)}</p>}</article>)}</div>
    </>}
  </section>;
}
