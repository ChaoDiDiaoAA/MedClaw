import { useState } from "react";
import { errorMessage } from "../../../../packages/contracts/src/error";
import type { DiagnosticsView } from "../../../../packages/contracts/src/protocol";

export function Diagnostics(props: { onError: (message: string | null) => void }) {
  const [view, setView] = useState<DiagnosticsView | null>(null);
  const [trace, setTrace] = useState(false);
  const [loading, setLoading] = useState(false);
  async function read() {
    setLoading(true);
    try {
      const result = await window.medclaw.request("diagnostics.read", { categories: ["versions", "host", "errors", "runtime", ...(trace ? ["prompt_trace" as const] : [])] });
      if (result.ok) setView(result.data); else props.onError(errorMessage(result.error));
    } finally { setLoading(false); }
  }
  return <section className="panel diagnostics" aria-labelledby="diagnostics-title"><div className="section-heading"><h2 id="diagnostics-title">Diagnostics</h2><button disabled={loading} onClick={() => void read()}>{loading ? "Reading…" : "Read diagnostics"}</button></div><label className="checkbox-label"><input type="checkbox" checked={trace} onChange={event => setTrace(event.target.checked)} />Include in-memory call stage summaries</label><p className="muted">Diagnostics include bounded safe summaries. Main status remains available when Host is unreachable.</p>{view && <><p role="status">{view.partial ? `Diagnostics partially available; missing sources: ${view.missingSources.join(", ")}` : "All diagnostic sources available"}</p><dl className="facts"><dt>Host</dt><dd>{view.host.state} · {view.host.instanceId ?? "No instance"}</dd></dl><div className="diagnostic-entries">{!view.entries.length && <p className="muted">No in-memory summaries to display.</p>}{view.entries.map((entry, index) => <article key={index}><span className="tiny muted">{entry.at} · {entry.source} · {entry.category}{entry.runId ? ` · Run ${entry.runId}` : ""}</span><p>{entry.error ? errorMessage(entry.error) : entry.message}</p>{entry.error && <p className="error-text">{entry.error.code} · {errorMessage(entry.error)}</p>}</article>)}</div></>}</section>;
}
