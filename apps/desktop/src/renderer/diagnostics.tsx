import { useState } from "react";
import type { DiagnosticsView } from "../../../../packages/contracts/src/protocol";

export function Diagnostics(props: { onError: (message: string | null) => void }) {
  const [view, setView] = useState<DiagnosticsView | null>(null);
  const [trace, setTrace] = useState(false);
  const [loading, setLoading] = useState(false);
  async function read() {
    setLoading(true);
    try {
      const result = await window.medclaw.request("diagnostics.read", { categories: ["versions", "host", "errors", "runtime", ...(trace ? ["prompt_trace" as const] : [])] });
      if (result.ok) setView(result.data); else props.onError(result.error.message);
    } finally { setLoading(false); }
  }
  return <section className="panel diagnostics" aria-labelledby="diagnostics-title"><div className="section-heading"><h2 id="diagnostics-title">安全诊断</h2><button disabled={loading} onClick={() => void read()}>{loading ? "读取中…" : "读取安全诊断"}</button></div><label className="checkbox-label"><input type="checkbox" checked={trace} onChange={event => setTrace(event.target.checked)} />包含内存中的调用阶段摘要</label><p className="muted">诊断仅包含有界安全摘要。Host 不可达时仍可读取 Main 状态。</p>{view && <><p role="status">{view.partial ? `诊断部分可用，缺失来源：${view.missingSources.join("、")}` : "诊断来源完整"}</p><dl className="facts"><dt>Host</dt><dd>{view.host.state} · {view.host.instanceId ?? "无实例"}</dd></dl><div className="diagnostic-entries">{!view.entries.length && <p className="muted">没有可显示的内存摘要。</p>}{view.entries.map((entry, index) => <article key={index}><span className="tiny muted">{entry.at} · {entry.source} · {entry.category}{entry.runId ? ` · Run ${entry.runId}` : ""}</span><p>{entry.message}</p>{entry.error && <p className="error-text">{entry.error.code} · {entry.error.message}</p>}</article>)}</div></>}</section>;
}
