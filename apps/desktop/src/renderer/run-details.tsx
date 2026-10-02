import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../../../packages/contracts/src/error";
import type { DesktopDisplayPreferences, HostView } from "../../../../packages/contracts/src/model";
import type { ActiveRunView, OutputPage, ReadRunResult, RunView, RuntimeControlView } from "../../../../packages/contracts/src/run";
import type { PublicReturn } from "../../../../packages/contracts/src/protocol";

const statusLabel = { created: "Registered", running: "Running", completed: "Completed and saved", failed: "Failure saved", cancelled: "Cancelled and saved" };
export function RunDetails(props: { run: RunView | null; host: HostView; viewSessionId: number | null; tab: DesktopDisplayPreferences["detailTab"]; active: ActiveRunView | null; control: RuntimeControlView | null; onTab: (tab: DesktopDisplayPreferences["detailTab"]) => void; onClose: () => void; onError: (message: string | null) => void; onRun: (run: RunView) => void; onRetrySaved: () => void; onQuery?: (queryId: number, sessionId: number) => void }) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1280);
  const [recent, setRecent] = useState<Extract<ReadRunResult, { kind: "recent" }> | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [output, setOutput] = useState<OutputPage | null>(props.run?.output ?? null);
  const [tools, setTools] = useState<PublicReturn<"tool.read"> | null>(null), [queries, setQueries] = useState<PublicReturn<"query.list"> | null>(null);
  const [toolsLoading, setToolsLoading] = useState(false), toolOrder = useRef(0);
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
  useEffect(() => { setTools(null); setQueries(null); toolOrder.current++; setToolsLoading(false); }, [run?.id, props.host.instanceId, props.viewSessionId]);
  useEffect(() => { if (props.host.state === "ready" && run?.kind === "agent") void readTools(); }, [props.host.state, props.host.instanceId, run?.id, run?.status]);
  async function readTools(page = 1) {
    if (!run || run.kind !== "agent") return;
    const scope = { ...target.current, token: ++toolOrder.current }, runId = run.id; setToolsLoading(true);
    const [result, history] = await Promise.all([window.medclaw.request("tool.read", { runId, page, pageSize: 20 }), window.medclaw.request("query.list", { sessionId: run.sessionId, limit: 20 })]);
    if (!mounted.current || scope.token !== toolOrder.current || scope.instanceId !== target.current.instanceId || scope.runId !== target.current.runId || scope.sessionId !== target.current.sessionId) return;
    if (result.ok && result.data.runId === runId) setTools(result.data); else if (!result.ok) setReadError(errorMessage(result.error));
    if (history.ok) setQueries(history.data); else setReadError(errorMessage(history.error));
    setToolsLoading(false);
  }
  async function readRecent(beforeRunId?: number) {
    const scope = capture();
    setLoading(true); setReadError(null);
    const result = await window.medclaw.request("run.read", { recent: true, limit: 20, ...(beforeRunId ? { beforeRunId } : {}) });
    if (!owns(scope)) return;
    if (result.ok && result.data.kind === "recent") setRecent(result.data);
    else if (!result.ok) setReadError(errorMessage(result.error));
    setLoading(false);
  }
  async function readOne(runId: number) {
    const scope = capture();
    setReadError(null); setLoading(true);
    const result = await window.medclaw.request("run.read", { runId });
    if (!owns(scope)) return;
    if (result.ok && result.data.kind === "one") {
      if (result.data.run?.id === runId) { props.onRun(result.data.run); setOutput(result.data.run.output); }
      else setReadError("Run not found. Read it again using its original ID.");
    } else if (!result.ok) setReadError(errorMessage(result.error));
    setLoading(false);
  }
  async function pageOutput(offset: number) {
    if (!run) return; const scope = capture(); setLoading(true);
    const result = await window.medclaw.request("run.read", { runId: run.id, outputOffset: offset });
    if (!owns(scope)) return;
    if (result.ok && result.data.kind === "one" && result.data.run?.id === run.id) setOutput(result.data.run.output);
    else if (!result.ok) props.onError(errorMessage(result.error));
    setLoading(false);
  }
  async function retrySave() {
    if (!retryRunId) return; const scope = capture(); setLoading(true);
    const result = await window.medclaw.request("run.retrySave", { runId: retryRunId });
    if (result.ok && mounted.current && scope.instanceId === target.current.instanceId) props.onRetrySaved();
    if (!owns(scope)) return;
    if (result.ok) { if (result.data.id === scope.runId) { props.onRun(result.data); setOutput(result.data.output); } }
    else props.onError(errorMessage(result.error));
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
  return <>{narrow && <div className="drawer-scrim" onClick={props.onClose} aria-hidden="true" />}<aside ref={panel} className={`run-details ${narrow ? "drawer" : ""}`} role={narrow ? "dialog" : "complementary"} aria-modal={narrow || undefined} aria-label="Run details" onKeyDown={keys}>
    <header className="detail-header"><div><span className="eyebrow">Saved facts</span><h2>Run details</h2></div><button ref={close} className="icon-button" aria-label="Close run details" onClick={props.onClose}>×</button></header>
    <div className="detail-tabs" role="tablist" aria-label="Run details tabs"><button role="tab" id="conditions-tab" aria-controls="conditions-panel" aria-selected={props.tab === "conditions"} onClick={() => props.onTab("conditions")}>Conditions</button><button role="tab" id="evidence-tab" aria-controls="evidence-panel" disabled={run?.kind !== "agent"} aria-selected={props.tab === "evidence"} onClick={() => props.onTab("evidence")}>Evidence</button><button role="tab" id="runtime-tab" aria-controls="runtime-panel" aria-selected={props.tab === "runtime"} onClick={() => props.onTab("runtime")}>Run details</button></div>
    <div className="detail-scroll">
      {retryRunId && <div className="persistence-notice" role="status"><p>Required facts for Run {retryRunId} have not been saved. Retry saving the original facts; new runs remain blocked.</p><button disabled={loading || props.host.state !== "ready"} onClick={() => void retrySave()}>Retry save</button></div>}
      {props.control && !props.control.acceptingNewRuns && <div role="status"><strong>New runs are blocked</strong>{props.control.blockReasons.map((reason, index) => <p className="tiny" key={index}>{reason.runId ? "Run " + reason.runId + " · " : ""}{errorMessage(reason)}</p>)}</div>}
      {run ? <><div className="detail-run"><strong>Run {run.id}</strong><span className="status-chip">{statusLabel[run.status]}</span></div>
        <section id="conditions-panel" role="tabpanel" aria-labelledby="conditions-tab" hidden={props.tab !== "conditions"}><dl className="facts"><dt>Model</dt><dd>{run.model.provider} / {run.model.modelId}</dd><dt>Native API</dt><dd>{run.model.api}</dd><dt>Trusted output limit</dt><dd>{run.model.maxOutputTokens} · {run.model.capabilitySource}</dd><dt>Total timeout</dt><dd>{run.policy.timeoutMs} ms</dd><dt>Native retry policy</dt><dd>{run.policy.maxRetries} retries · Maximum suggested delay {run.policy.maxRetryDelayMs} ms</dd><dt>Time context</dt><dd>{run.referenceDate} · {run.timezone}</dd><dt>Purpose</dt><dd>{run.goal === "verify" ? "Model connection verification" : "This single-turn text request"}</dd><dt>Original operation ID</dt><dd><code>{run.operationRef}</code></dd><dt>Host instance</dt><dd><code>{run.instanceId}</code></dd><dt>Previous run reference</dt><dd>{run.priorRunId ?? "None"}</dd></dl>{tools && <><h3>Frozen tool scope</h3><dl className="facts"><dt>Batches</dt><dd>{tools.scope.batchIds.join(', ') || 'None'}</dd><dt>Devices</dt><dd>{tools.scope.deviceIds?.join(', ') || 'All devices in scope'}</dd><dt>Tools</dt><dd>{tools.scope.allowedToolNames.join(', ') || 'None'}</dd><dt>Artifacts</dt><dd>{tools.scope.artifactIds.join(', ') || 'None'}</dd></dl></>}<p className="tiny muted">The output limit and tool scope are frozen for this request. Costs are estimated by the SDK.</p></section>
        <section id="evidence-panel" role="tabpanel" aria-labelledby="evidence-tab" hidden={props.tab !== "evidence"}><h3>Saved queries from this Run</h3>{queries?.items.filter(query => query.runId === run.id).map(query => <article className="call-summary" key={query.id}><strong>Query {query.id} · {query.kind}</strong><p className="tiny">{query.totalRows} rows · {query.calculationVersion}</p><p className="tiny"><code>{query.resultHash}</code></p><button onClick={() => props.onQuery?.(query.id, query.sessionId)} disabled={!props.onQuery}>Read Query {query.id} and evidence</button></article>)}{!queries?.items.some(query => query.runId === run.id) && <p className="muted">No Query from this Run appears on the recent history page. Native file and command tools can complete without a Query.</p>}<button disabled={toolsLoading || run.kind !== 'agent'} onClick={() => void readTools()}>Refresh Run facts</button></section>
        <section id="runtime-panel" role="tabpanel" aria-labelledby="runtime-tab" hidden={props.tab !== "runtime"}><dl className="facts"><dt>Persistence</dt><dd>{run.persistence}</dd><dt>Registered</dt><dd>{run.createdAt}</dd><dt>Started</dt><dd>{run.startedAt ?? "Not started"}</dd><dt>Cancellation requested</dt><dd>{run.cancelRequestedAt ?? "None"}</dd><dt>Execution stopped</dt><dd>{run.stoppedAt ?? "Not confirmed"}</dd><dt>Final state saved</dt><dd>{run.endedAt ?? "Not confirmed"}</dd></dl>{run.error && <p role="alert" className="error-text">{run.error.code} · {errorMessage(run.error)}</p>}
          <h3>Actual call summary</h3>{!run.calls.length && <p className="muted">No SDK call records found yet.</p>}{run.calls.map(call => <article className="call-summary" key={call.callId}><p><strong>{call.state}</strong> · {call.kind} · {call.granularity}</p><dl className="facts"><dt>Call ID</dt><dd><code>{call.callId}</code></dd><dt>Logical call number</dt><dd>{call.attempt} · HTTP attempt count unknown</dd><dt>Response model</dt><dd>{call.responseModel ?? "Unknown"}</dd><dt>SDK stop reason</dt><dd>{call.sdkStopReason ?? "Unknown"}</dd><dt>Duration</dt><dd>{call.durationMs === null ? "Unknown" : `${call.durationMs} ms`}</dd><dt>Input / output tokens</dt><dd>{call.inputTokens ?? "Unknown"} / {call.outputTokens ?? "Unknown"}</dd><dt>Estimated cost</dt><dd>{call.cost === null ? "Unknown" : `${call.cost} ${call.costCurrency}`}</dd><dt>Usage source</dt><dd>{call.usageSource ?? "Unknown"}</dd><dt>Unavailable reason</dt><dd>{call.unavailableReason ?? "None"}</dd></dl>{call.error && <p className="error-text">{call.error.code} · {errorMessage(call.error)}</p>}</article>)}
          {run.kind === 'agent' && <section data-testid="tool-call-details"><div className="section-heading"><h3>Tool calls</h3><button disabled={toolsLoading || props.host.state !== 'ready'} onClick={() => void readTools(tools?.page ?? 1)}>Refresh tools</button></div>{toolsLoading && <p role="status">Reading saved tool facts…</p>}{tools && !tools.items.length && <p className="muted">No saved tool calls on this page.</p>}{tools?.items.map(call => <article className="tool-call-summary" key={call.id}><p><strong>{call.name}</strong> <span className="status-chip">{call.status}</span></p><dl className="facts"><dt>Original call</dt><dd><code>{call.nativeToolCallId}</code></dd><dt>Version / mode</dt><dd>{call.version} · {call.executionMode}</dd><dt>Model call</dt><dd>{call.modelCallId ?? 'Not recorded'}</dd><dt>Execution stopped</dt><dd>{call.stoppedAt ?? 'Not confirmed'}</dd><dt>SDK delivery</dt><dd>{call.sdkReturned ? 'SDK result saved' : 'SDK return not confirmed'}</dd><dt>Native result entry</dt><dd><code>{call.nativeEntryId ?? 'None'}</code></dd><dt>Model consumption</dt><dd>{call.nextModelCallId ? `Included in model call ${call.nextModelCallId}` : 'No later model call confirmed'}</dd><dt>Consumption observed</dt><dd>{call.consumedAt ?? 'Not recorded'}</dd></dl>{call.error && <p role="alert" className="error-text">{errorMessage(call.error)}</p>}<details><summary>Final input and result previews{call.truncated ? ' · Truncated' : ''}</summary><pre className="tool-result-text">{call.inputPreview}</pre><pre className="tool-result-text">{call.resultPreview}</pre></details></article>)}{tools && <div className="actions"><button disabled={toolsLoading || tools.page <= 1} onClick={() => void readTools(tools.page - 1)}>Previous tools page</button><button disabled={toolsLoading || tools.page * tools.pageSize >= tools.totalRows} onClick={() => void readTools(tools.page + 1)}>Next tools page</button></div>}</section>}
          <h3>Saved output</h3><p className="tiny muted">{output ? `${output.offset}–${output.offset + output.text.length} / ${output.totalChars} characters` : "Not read back yet"}</p><pre className="saved-output" data-testid="saved-output">{output?.text || "No saved text output"}</pre><div className="actions"><button disabled={loading || !output?.offset} onClick={() => void pageOutput(0)}>Back to first section</button><button disabled={loading || output?.nextOffset == null} onClick={() => { if (output?.nextOffset != null) void pageOutput(output.nextOffset); }}>Read next output section</button><button disabled={loading} onClick={() => void readOne(run.id)}>Read this run again</button></div>
        </section>
      </> : <p className="muted">Select a recent run to review its saved facts.</p>}
      <section className="recent-runs"><div className="section-heading"><h3>Recent runs</h3><button disabled={loading} onClick={() => void readRecent()}>Refresh recent runs</button></div>{readError && <p role="alert" className="error-text">{readError}</p>}{recent && !recent.runs.length && !readError && <p className="muted">No saved runs on this page.</p>}{recent?.runs.map(item => <button key={item.id} onClick={() => void readOne(item.id)} aria-label={`View Run ${item.id}`}><strong>Run {item.id} · {statusLabel[item.status]}</strong><span>{item.model.provider} / {item.model.modelId}</span><span className="tiny">{item.createdAt}</span></button>)}{recent?.nextBeforeRunId && <button disabled={loading} onClick={() => void readRecent(recent.nextBeforeRunId!)}>Read earlier runs</button>}</section>
    </div>
  </aside></>;
}
