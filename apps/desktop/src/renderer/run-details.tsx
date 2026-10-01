import { useEffect, useRef, useState } from "react";
import type { DesktopDisplayPreferences, HostView } from "../../../../packages/contracts/src/model";
import type { ActiveRunView, OutputPage, ReadRunResult, RunView, RuntimeControlView } from "../../../../packages/contracts/src/run";

const statusLabel = { created: "已登记", running: "执行中", completed: "已完成并保存", failed: "失败事实已保存", cancelled: "已取消并保存" };
export function RunDetails(props: { run: RunView | null; host: HostView; viewSessionId: number | null; tab: DesktopDisplayPreferences["detailTab"]; active: ActiveRunView | null; control: RuntimeControlView | null; onTab: (tab: DesktopDisplayPreferences["detailTab"]) => void; onClose: () => void; onError: (message: string | null) => void; onRun: (run: RunView) => void; onRetrySaved: () => void }) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1280);
  const [recent, setRecent] = useState<Extract<ReadRunResult, { kind: "recent" }> | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [output, setOutput] = useState<OutputPage | null>(props.run?.output ?? null);
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const run = props.run;
  const target = useRef({ instanceId: props.host.instanceId, runId: run?.id ?? null, sessionId: props.viewSessionId }), order = useRef(0), mounted = useRef(true);
  target.current = { instanceId: props.host.instanceId, runId: run?.id ?? null, sessionId: props.viewSessionId };
  const capture = () => ({ ...target.current, order: ++order.current });
  const owns = (scope: ReturnType<typeof capture>) => mounted.current && scope.order === order.current && scope.instanceId === target.current.instanceId
    && scope.runId === target.current.runId && scope.sessionId === target.current.sessionId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const retryRunId = props.active?.persistencePending ? props.active.runId : props.control?.blockReasons.find(reason => reason.code === "storage_write_failed" && reason.runId)?.runId ?? null;
  useEffect(() => {
    const media = matchMedia("(max-width: 1279px)");
    const change = () => setNarrow(media.matches); media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => { if (narrow) close.current?.focus(); }, [narrow]);
  useEffect(() => { setOutput(run?.output ?? null); setLoading(false); setReadError(null); }, [run?.id, props.viewSessionId, props.host.instanceId]);
  useEffect(() => { if (output?.offset === 0 && run?.output.offset === 0) setOutput(run.output); }, [run?.output.text]);
  useEffect(() => { if (props.host.state === "ready") void readRecent(); }, [props.host.state, props.host.instanceId]);
  async function readRecent(beforeRunId?: number) {
    const scope = capture();
    setLoading(true); setReadError(null);
    const result = await window.medclaw.request("run.read", { recent: true, limit: 20, ...(beforeRunId ? { beforeRunId } : {}) });
    if (!owns(scope)) return;
    if (result.ok && result.data.kind === "recent") setRecent(result.data);
    else if (!result.ok) setReadError(result.error.message);
    setLoading(false);
  }
  async function readOne(runId: number) {
    const scope = capture();
    setReadError(null); setLoading(true);
    const result = await window.medclaw.request("run.read", { runId });
    if (!owns(scope)) return;
    if (result.ok && result.data.kind === "one") {
      if (result.data.run?.id === runId) { props.onRun(result.data.run); setOutput(result.data.run.output); }
      else setReadError("该 Run 未查到，请按原身份重新读取。");
    } else if (!result.ok) setReadError(result.error.message);
    setLoading(false);
  }
  async function pageOutput(offset: number) {
    if (!run) return; const scope = capture(); setLoading(true);
    const result = await window.medclaw.request("run.read", { runId: run.id, outputOffset: offset });
    if (!owns(scope)) return;
    if (result.ok && result.data.kind === "one" && result.data.run?.id === run.id) setOutput(result.data.run.output);
    else if (!result.ok) props.onError(result.error.message);
    setLoading(false);
  }
  async function retrySave() {
    if (!retryRunId) return; const scope = capture(); setLoading(true);
    const result = await window.medclaw.request("run.retrySave", { runId: retryRunId });
    if (result.ok && mounted.current && scope.instanceId === target.current.instanceId) props.onRetrySaved();
    if (!owns(scope)) return;
    if (result.ok) { if (result.data.id === scope.runId) { props.onRun(result.data); setOutput(result.data.output); } }
    else props.onError(result.error.message);
    setLoading(false);
  }
  function keys(event: React.KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); props.onClose(); }
    if (narrow && event.key === "Tab") {
      const focusable = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]') ?? []).filter(element => element.offsetParent !== null);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }
  return <>{narrow && <div className="drawer-scrim" onClick={props.onClose} aria-hidden="true" />}<aside ref={panel} className={`run-details ${narrow ? "drawer" : ""}`} role={narrow ? "dialog" : "complementary"} aria-modal={narrow || undefined} aria-label="运行核查" onKeyDown={keys}>
    <header className="detail-header"><div><span className="eyebrow">已保存事实</span><h2>运行核查</h2></div><button ref={close} className="icon-button" aria-label="关闭运行详情" onClick={props.onClose}>×</button></header>
    <div className="detail-tabs" role="tablist" aria-label="运行核查页签"><button role="tab" id="conditions-tab" aria-controls="conditions-panel" aria-selected={props.tab === "conditions"} onClick={() => props.onTab("conditions")}>执行条件</button><button role="tab" disabled aria-selected={false}>业务证据</button><button role="tab" id="runtime-tab" aria-controls="runtime-panel" aria-selected={props.tab === "runtime"} onClick={() => props.onTab("runtime")}>运行详情</button></div>
    <div className="detail-scroll">
      {retryRunId && <div className="persistence-notice" role="status"><p>Run {retryRunId} 的必要事实尚未保存。只重试原事实保存，保持新运行门禁。</p><button disabled={loading || props.host.state !== "ready"} onClick={() => void retrySave()}>重试保存</button></div>}
      {props.control && !props.control.acceptingNewRuns && <div role="status"><strong>当前禁止新运行</strong>{props.control.blockReasons.map((reason, index) => <p className="tiny" key={index}>{reason.runId ? "Run " + reason.runId + " · " : ""}{reason.message}</p>)}</div>}
      {run ? <><div className="detail-run"><strong>Run {run.id}</strong><span className="status-chip">{statusLabel[run.status]}</span></div>
        <section id="conditions-panel" role="tabpanel" aria-labelledby="conditions-tab" hidden={props.tab !== "conditions"}><dl className="facts"><dt>模型</dt><dd>{run.model.provider} / {run.model.modelId}</dd><dt>原生 API</dt><dd>{run.model.api}</dd><dt>可信输出上限</dt><dd>{run.model.maxOutputTokens} · {run.model.capabilitySource}</dd><dt>总期限</dt><dd>{run.policy.timeoutMs} ms</dd><dt>原生重试政策</dt><dd>{run.policy.maxRetries} 次 · 建议等待上限 {run.policy.maxRetryDelayMs} ms</dd><dt>时间锚点</dt><dd>{run.referenceDate} · {run.timezone}</dd><dt>用途</dt><dd>{run.goal === "verify" ? "模型连接验证" : "此次单轮文本"}</dd><dt>原操作身份</dt><dd><code>{run.operationRef}</code></dd><dt>Host 实例</dt><dd><code>{run.instanceId}</code></dd><dt>前一 Run 引用</dt><dd>{run.priorRunId ?? "无"}</dd></dl><p className="tiny muted">输出上限是请求冻结的可信能力值，费用按 SDK 估算。</p></section>
        <section id="runtime-panel" role="tabpanel" aria-labelledby="runtime-tab" hidden={props.tab !== "runtime"}><dl className="facts"><dt>保存</dt><dd>{run.persistence}</dd><dt>登记</dt><dd>{run.createdAt}</dd><dt>开始</dt><dd>{run.startedAt ?? "尚未开始"}</dd><dt>请求取消</dt><dd>{run.cancelRequestedAt ?? "无"}</dd><dt>执行停止</dt><dd>{run.stoppedAt ?? "尚未确认"}</dd><dt>终态保存</dt><dd>{run.endedAt ?? "尚未确认"}</dd></dl>{run.error && <p role="alert" className="error-text">{run.error.code} · {run.error.message}</p>}
          <h3>实际调用摘要</h3>{!run.calls.length && <p className="muted">尚未查到 SDK 调用记录。</p>}{run.calls.map(call => <article className="call-summary" key={call.callId}><p><strong>{call.state}</strong> · {call.kind} · {call.granularity}</p><dl className="facts"><dt>调用身份</dt><dd><code>{call.callId}</code></dd><dt>逻辑调用序号</dt><dd>{call.attempt} · HTTP 尝试次数未知</dd><dt>响应模型</dt><dd>{call.responseModel ?? "未知"}</dd><dt>SDK 停止原因</dt><dd>{call.sdkStopReason ?? "未知"}</dd><dt>耗时</dt><dd>{call.durationMs === null ? "未知" : `${call.durationMs} ms`}</dd><dt>输入 / 输出 Token</dt><dd>{call.inputTokens ?? "未知"} / {call.outputTokens ?? "未知"}</dd><dt>估算费用</dt><dd>{call.cost === null ? "未知" : `${call.cost} ${call.costCurrency}`}</dd><dt>用量来源</dt><dd>{call.usageSource ?? "未知"}</dd><dt>未提供原因</dt><dd>{call.unavailableReason ?? "无"}</dd></dl>{call.error && <p className="error-text">{call.error.code} · {call.error.message}</p>}</article>)}
          <h3>已保存输出</h3><p className="tiny muted">{output ? `${output.offset}–${output.offset + output.text.length} / ${output.totalChars} 字符` : "尚未读回"}</p><pre className="saved-output" data-testid="saved-output">{output?.text || "没有已保存的文本输出"}</pre><div className="actions"><button disabled={loading || !output?.offset} onClick={() => void pageOutput(0)}>回到首段</button><button disabled={loading || output?.nextOffset == null} onClick={() => { if (output?.nextOffset != null) void pageOutput(output.nextOffset); }}>读取下一段全文</button><button disabled={loading} onClick={() => void readOne(run.id)}>重读此 Run</button></div>
        </section>
      </> : <p className="muted">选择最近 Run 核查已保存事实。</p>}
      <section className="recent-runs"><div className="section-heading"><h3>最近运行</h3><button disabled={loading} onClick={() => void readRecent()}>刷新最近运行</button></div>{readError && <p role="alert" className="error-text">{readError}</p>}{recent && !recent.runs.length && !readError && <p className="muted">当前页没有已保存的 Run。</p>}{recent?.runs.map(item => <button key={item.id} onClick={() => void readOne(item.id)} aria-label={`查看 Run ${item.id}`}><strong>Run {item.id} · {statusLabel[item.status]}</strong><span>{item.model.provider} / {item.model.modelId}</span><span className="tiny">{item.createdAt}</span></button>)}{recent?.nextBeforeRunId && <button disabled={loading} onClick={() => void readRecent(recent.nextBeforeRunId!)}>读取更早运行</button>}</section>
    </div>
  </aside></>;
}
