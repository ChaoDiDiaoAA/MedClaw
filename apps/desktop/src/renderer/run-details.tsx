import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "../../../../packages/contracts/src/error";
import type { DesktopDisplayPreferences, HostView } from "../../../../packages/contracts/src/model";
import type { ActiveRunView, OutputPage, ReadRunResult, RunView, RuntimeControlView } from "../../../../packages/contracts/src/run";
import type { PublicReturn } from "../../../../packages/contracts/src/protocol";
import {InputQueue,type InputQueueSnapshot} from "./input-queue";
import type {SessionInput} from "../../../../packages/contracts/src/session";
import { NativeMessages } from "./chat";
import type { ToolCallView } from "../../../../packages/contracts/src/tool";
import { Timeline } from './timeline';
import { ContextDetails } from './context-panel';
import { resolveReadingAnchor, shouldRecordScroll, type ReadingAnchor, type RunEventProjectionState } from './use-run-events';

const consumptionVerified = (call: ToolCallView) => call.sdkReturned && !!call.nativeEntryId && !!call.nextModelCallId && !!call.consumedAt && call.consumptionEvidence === 'provider_input_verified';

const statusLabel = { created: "Registered", running: "Running", completed: "Completed and saved", failed: "Failure saved", cancelled: "Cancelled and saved" };
const readingPositions = new Map<string, { following: boolean; top: number; anchor: ReadingAnchor | null; offset: number }>();
export function RunDetails(props: { inputs?:InputQueueSnapshot|null;cancellingInputs?:number[];onCancelInput?:(input:SessionInput)=>void;onRefreshInputs?:()=>void;onMoreInputs?:()=>void;run: RunView | null; host: HostView; viewSessionId: number | null; tab: DesktopDisplayPreferences["detailTab"]; active: ActiveRunView | null; control: RuntimeControlView | null; events: RunEventProjectionState | null; onResumeGap: () => void; onTab: (tab: DesktopDisplayPreferences["detailTab"]) => void; onClose: () => void; onError: (message: string | null) => void; onRun: (run: RunView) => void; onRetrySaved: () => void; onQuery?: (queryId: number, sessionId: number) => void }) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1280);
  const [recent, setRecent] = useState<Extract<ReadRunResult, { kind: "recent" }> | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [output, setOutput] = useState<OutputPage | null>(props.run?.output ?? null);
  const [tools, setTools] = useState<PublicReturn<"tool.read"> | null>(null), [queries, setQueries] = useState<PublicReturn<"query.list"> | null>(null);
  const [toolsLoading, setToolsLoading] = useState(false), toolOrder = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null), [following, setFollowing] = useState(true);
  const [nativeRevision, setNativeRevision] = useState(0);
  const restoring = useRef(false), restorationFrame = useRef<number | null>(null), readingTarget = useRef<string | null>(null);
  const scrollIntent = useRef<{ key: string; height: number; viewport: number; until: number } | null>(null);
  const [contentUpdated, setContentUpdated] = useState<string | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const run = props.run;
  const readingKey = run ? `${run.sessionId ?? 'provider'}:${run.id}:details:${props.tab}` : null;
  const readingElementKey = (element: HTMLElement) => element.dataset.eventId ? 'event:' + element.dataset.eventId : 'native:' + element.dataset.nativeEntryId;
  useLayoutEffect(() => {
    const container = scroller.current; if (!container || !readingKey) return;
    readingTarget.current = readingKey; restoring.current = true;
    if (restorationFrame.current !== null) cancelAnimationFrame(restorationFrame.current);
    restorationFrame.current = requestAnimationFrame(() => { restoring.current = false; restorationFrame.current = null; });
    const position = readingPositions.get(readingKey);
    if (position?.following === false) {
      const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-event-id], [data-native-entry-id]')).filter(element => element.offsetParent !== null);
      const resolved = position.anchor ? resolveReadingAnchor(position.anchor, elements.map(readingElementKey), {}) : null;
      const anchor = resolved?.key ? elements.find(element => readingElementKey(element) === resolved.key) : null;
      if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - position.offset;
      else container.scrollTop = position.top;
      if (resolved?.contentUpdated && elements.length > 0) setContentUpdated(readingKey);
      setFollowing(false);
    } else { container.scrollTop = props.tab === 'runtime' ? container.scrollHeight : 0; setFollowing(true); }
  }, [readingKey, props.events?.cursor, nativeRevision, following, contentUpdated]);
  useEffect(() => () => { if (restorationFrame.current !== null) cancelAnimationFrame(restorationFrame.current); }, []);
  function markScrollIntent() {
    const container = scroller.current; if (!container || !readingKey) return;
    restoring.current = false;
    scrollIntent.current = { key: readingKey, height: container.scrollHeight, viewport: container.clientHeight, until: performance.now() + 500 };
  }
  function rememberPosition(event: React.UIEvent<HTMLDivElement>) {
    const container = scroller.current; if (!container || !readingKey || readingTarget.current !== readingKey || restoring.current && event.nativeEvent.isTrusted) return;
    const intent = scrollIntent.current;
    const userInitiated = !event.nativeEvent.isTrusted || !!intent && intent.key === readingKey && intent.height === container.scrollHeight && intent.viewport === container.clientHeight && intent.until >= performance.now();
    if (!shouldRecordScroll(readingPositions.get(readingKey), container.scrollHeight, container.clientHeight, userInitiated)) return;
    const follows = container.scrollHeight - container.scrollTop - container.clientHeight < 64, top = container.getBoundingClientRect().top;
    const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-event-id], [data-native-entry-id]')).filter(element => element.offsetParent !== null), index = elements.findIndex(element => element.getBoundingClientRect().bottom > top), anchor = elements[index];
    readingPositions.set(readingKey, { following: follows, top: container.scrollTop, anchor: anchor ? { key: readingElementKey(anchor), nativeEntryId: anchor.dataset.nativeEntryId ?? null, neighbors: [elements[index + 1], elements[index - 1]].filter((element): element is HTMLElement => !!element).map(readingElementKey) } : null, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 });
    if (readingPositions.size > 50) readingPositions.delete(readingPositions.keys().next().value!);
    setFollowing(follows);
  }
  const agentControl = run?.kind === 'agent' ? run.control : null;
  const budget = props.control?.budget && props.control.budget.runId === run?.id ? props.control.budget : null;
  const summary = run?.cleanup?.budgetSummary;
  const milliseconds = (value: number | null | undefined) => value == null ? 'Unknown' : `${Math.round(value)} ms`;
  const profile = agentControl?.toolProfileSnapshot;
  const key = JSON.stringify([props.host.instanceId, props.host.state, run?.id ?? null, props.viewSessionId]);
  const target = useRef({ key, epoch: 0, instanceId: props.host.instanceId, runId: run?.id ?? null, sessionId: props.viewSessionId }), order = useRef(0), mounted = useRef(true);
  if (target.current.key !== key) {
    target.current = { key, epoch: target.current.epoch + 1, instanceId: props.host.instanceId, runId: run?.id ?? null, sessionId: props.viewSessionId };
    order.current++;
  }
  const capture = () => ({ ...target.current, order: ++order.current });
  const owns = (scope: ReturnType<typeof capture>) => mounted.current && scope.epoch === target.current.epoch && scope.order === order.current && scope.instanceId === target.current.instanceId
    && scope.runId === target.current.runId && scope.sessionId === target.current.sessionId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const retryRunId = props.active?.persistencePending ? props.active.runId : props.control?.blockReasons.find(reason => reason.code === "storage_write_failed" && reason.runId)?.runId ?? null;
  useEffect(() => {
    const media = matchMedia("(max-width: 1279px)");
    const change = () => setNarrow(media.matches); media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => { if (narrow) close.current?.focus(); }, [narrow]);
  useEffect(() => { setOutput(run?.output ?? null); setLoading(false); setReadError(null); }, [key]);
  useEffect(() => { if (output?.offset === 0 && run?.output.offset === 0) setOutput(run.output); }, [run?.output.text]);
  useEffect(() => { if (props.host.state === "ready") void readRecent(); }, [props.host.state, props.host.instanceId]);
  useEffect(() => { setTools(null); setQueries(null); toolOrder.current++; setToolsLoading(false); }, [key]);
  useEffect(() => { if (props.host.state === "ready" && run?.kind === "agent") void readTools(); }, [key, run?.status, props.events?.terminal]);
  async function readTools(page?: number) {
    if (!run || run.kind !== "agent") return;
    const scope = { ...target.current, token: ++toolOrder.current }, runId = run.id; setToolsLoading(true);
    const [result, history] = await Promise.all([window.medclaw.request("tool.read", { runId, ...(page !== undefined ? { page } : {}) }), window.medclaw.request("query.list", { sessionId: run.sessionId })]);
    if (!mounted.current || scope.epoch !== target.current.epoch || scope.token !== toolOrder.current || scope.instanceId !== target.current.instanceId || scope.runId !== target.current.runId || scope.sessionId !== target.current.sessionId) return;
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
    <div className="detail-scroll" data-testid="run-details-scroll" ref={scroller} onScroll={rememberPosition} onWheel={markScrollIntent} onPointerDown={markScrollIntent} onPointerMove={event => { if (event.buttons) markScrollIntent(); }} onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) markScrollIntent(); }}>
      {contentUpdated === readingKey && !following && <p className="tiny evidence-gap" data-testid="timeline-content-updated">Content updated. Kept the nearest available Run fact.</p>}
      {!following && <button className="quiet" data-testid="timeline-back-to-latest" onClick={() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; if (readingKey) readingPositions.set(readingKey, { following: true, top: scroller.current?.scrollTop ?? 0, anchor: null, offset: 0 }); setFollowing(true); setContentUpdated(null); }}>Back to latest Run facts</button>}
      {retryRunId && <div className="persistence-notice" role="status"><p>Required facts for Run {retryRunId} have not been saved. Retry saving the original facts; new runs remain blocked.</p><button disabled={loading || props.host.state !== "ready"} onClick={() => void retrySave()}>Retry save</button></div>}
      {props.control && !props.control.acceptingNewRuns && <div role="status"><strong>New runs are blocked</strong>{props.control.blockReasons.map((reason, index) => <p className="tiny" key={index}>{reason.runId ? "Run " + reason.runId + " · " : ""}{errorMessage(reason)}</p>)}</div>}
      {props.inputs?.items.some(input=>input.processingStatus === "pending") && <section aria-label="Pending inputs"><h3>Pending inputs</h3>{props.inputs.items.filter(input=>input.processingStatus === "pending" && (input.targetRunId === run?.id || input.runId === run?.id)).map(input=><article key={input.id}><p>{input.mode} · {input.status}</p><p>{input.text}</p>{input.status === "delivery_unknown" && <p role="alert">Consumption unconfirmed. Stop the original Run or read its saved facts.</p>}{input.status === "queued" && <button disabled={props.host.state!=="ready" || props.cancellingInputs?.includes(input.id)} onClick={()=>props.onCancelInput?.(input)}>Cancel input</button>}</article>)}</section>}
      <details><summary>Input diagnostics</summary><p className="tiny muted">Saved input identities and original results for explicit verification.</p><InputQueue snapshot={props.inputs??null} sessionId={run?.kind==="agent"?run.sessionId:props.viewSessionId} ready={props.host.state==="ready"} cancelling={props.cancellingInputs??[]} onRefresh={()=>props.onRefreshInputs?.()} onMore={()=>props.onMoreInputs?.()} onCancel={input=>props.onCancelInput?.(input)}/></details>
      {run ? <><div className="detail-run"><strong>Run {run.id}</strong><span className="status-chip">{statusLabel[run.status]}</span></div>
        <section id="conditions-panel" role="tabpanel" aria-labelledby="conditions-tab" hidden={props.tab !== "conditions"}><dl className="facts"><dt>Model</dt><dd>{run.model.provider} / {run.model.modelId}</dd><dt>Native API</dt><dd>{run.model.api}</dd><dt>Trusted output limit</dt><dd>{run.model.maxOutputTokens} · {run.model.capabilitySource}</dd><dt>Total timeout</dt><dd>{run.policy.timeoutMs} ms</dd><dt>Native retry policy</dt><dd>{run.policy.maxRetries} retries · Maximum suggested delay {run.policy.maxRetryDelayMs} ms</dd><dt>Time context</dt><dd>{run.referenceDate} · {run.timezone}</dd><dt>Purpose</dt><dd>{run.goal === "verify" ? "Model connection verification" : "This single-turn text request"}</dd><dt>Original operation ID</dt><dd><code>{run.operationRef}</code></dd><dt>Host instance</dt><dd><code>{run.instanceId}</code></dd><dt>Previous run reference</dt><dd>{run.priorRunId ?? "None"}</dd></dl>{tools && <><h3>Frozen tool scope</h3><dl className="facts"><dt>Batches</dt><dd>{tools.scope.batchIds.join(', ') || 'None'}</dd><dt>Devices</dt><dd>{tools.scope.deviceIds?.join(', ') || 'All devices in scope'}</dd><dt>Tools</dt><dd>{tools.scope.allowedToolNames.join(', ') || 'None'}</dd><dt>Artifacts</dt><dd>{tools.scope.artifactIds.join(', ') || 'None'}</dd></dl></>}<p className="tiny muted">The output limit and tool scope are frozen for this request. Costs are estimated by the SDK.</p></section>
        <section id="evidence-panel" role="tabpanel" aria-labelledby="evidence-tab" hidden={props.tab !== "evidence"}><h3>Saved queries from this Run</h3>{queries?.items.filter(query => query.runId === run.id).map(query => <article className="call-summary" key={query.id}><strong>Query {query.id} · {query.kind}</strong><p className="tiny">{query.totalRows} rows · {query.calculationVersion}</p><p className="tiny"><code>{query.resultHash}</code></p><button onClick={() => props.onQuery?.(query.id, query.sessionId)} disabled={!props.onQuery}>Read Query {query.id} and evidence</button></article>)}{!queries?.items.some(query => query.runId === run.id) && <p className="muted">No Query from this Run appears on the recent history page. Native file and command tools can complete without a Query.</p>}<button disabled={toolsLoading || run.kind !== 'agent'} onClick={() => void readTools()}>Refresh Run facts</button></section>
        <section id="runtime-panel" role="tabpanel" aria-labelledby="runtime-tab" hidden={props.tab !== "runtime"}><dl className="facts"><dt>Persistence</dt><dd>{run.persistence}</dd><dt>Saved Run</dt><dd>Run {run.id} · {run.persistence}</dd><dt>Saved Answer</dt><dd>{run.answerRef ? `Answer ${run.answerRef}` : 'Not confirmed'}</dd><dt>Registered</dt><dd>{run.createdAt}</dd><dt>Started</dt><dd>{run.startedAt ?? "Not started"}</dd><dt>Cancellation requested</dt><dd>{run.cancelRequestedAt ?? "None"}</dd><dt>Execution stopped</dt><dd>{run.stoppedAt ?? "Not confirmed"}</dd><dt>Final state saved</dt><dd>{run.endedAt ?? "Not confirmed"}</dd></dl>{run.error && <p role="alert" className="error-text">{run.error.code} · {errorMessage(run.error)}</p>}
          {run.kind === 'agent' && <Timeline state={props.events?.runId === run.id ? props.events : null} onResumeGap={props.onResumeGap} onQuery={queryId => props.onQuery?.(queryId, run.sessionId)} />}
          {run.kind === 'agent' && <NativeMessages host={props.host} sessionId={run.sessionId} nativeSessionId={run.nativeSessionId} visible={props.tab === 'runtime'} context={`${run.id}:${props.viewSessionId}`} revision={run.status} testId="run-native-messages" onChanged={() => setNativeRevision(value => value + 1)} />}
          {run.kind === 'agent' && <>
            <section data-testid="run-agent-policy"><h3>Frozen Agent policy</h3>{agentControl?.agentPolicy ? <dl className="facts"><dt>Tool call budget</dt><dd>{agentControl.agentPolicy.maxToolCalls}</dd><dt>Model call budget</dt><dd>{agentControl.agentPolicy.maxModelCalls}</dd><dt>Tool timeout ceiling</dt><dd>{milliseconds(agentControl.agentPolicy.singleToolTimeoutMs)}</dd><dt>Recovery round budget</dt><dd>{agentControl.agentPolicy.maxRecoveryAttempts}</dd><dt>Policy version</dt><dd>{agentControl.agentPolicy.version}</dd></dl> : <p className="muted">Unknown. This Run has no saved Agent policy.</p>}</section>
            <section data-testid="run-budget-summary"><h3>Run budget</h3>{budget ? <dl className="facts"><dt>Tool attempts</dt><dd>{budget.toolCalls.used} used · {budget.toolCalls.remaining} remaining / {budget.toolCalls.limit}</dd><dt>Model requests</dt><dd>{budget.modelCalls.used} used · {budget.modelCalls.remaining} remaining / {budget.modelCalls.limit}</dd><dt>Remaining time</dt><dd>{milliseconds(budget.remainingTimeMs)}</dd><dt>Recovery rounds</dt><dd>{budget.recovery.used} used · {budget.recovery.remaining} remaining</dd><dt>Recovery episode</dt><dd>{budget.recovery.episodeId ?? 'None'}</dd><dt>Unresolved items</dt><dd>{budget.recovery.unresolvedItems.join(', ') || 'None'}</dd></dl> : summary ? <dl className="facts"><dt>Used calls</dt><dd>{summary.toolCalls} tool attempts · {summary.modelCalls} model requests</dd><dt>Rejected admissions</dt><dd>{summary.toolAdmissionsRejected} tool · {summary.modelAdmissionsRejected} model</dd><dt>Convergence requested</dt><dd>{summary.convergenceRequested ? 'Yes' : 'No'}</dd><dt>Recovery rounds used</dt><dd>{summary.recoveryAttempts}</dd><dt>Stop reason</dt><dd>{summary.stopReason ?? 'None'}</dd><dt>Unresolved items</dt><dd>{summary.unresolvedItems.join(', ') || 'None'}</dd></dl> : <p className="muted">Unknown. No active budget or saved summary is available for this Run.</p>}</section>
            <section data-testid="run-tool-profile"><h3>Frozen tool observations</h3>{profile ? <><p className="tiny">Cutoff {profile.cutoffAt} · Record {profile.maxToolCallId ?? 'None'} · {profile.windowDays} days</p>{!profile.available ? <p className="muted">Statistics unavailable. The configured tool timeout is used.</p> : !profile.profiles.length ? <p className="muted">Insufficient samples. The configured tool timeout is used.</p> : profile.profiles.map(item => <details key={`${item.name}:${item.version}:${item.sdkVersion}:${item.measurementVersion}:${item.environmentKey}:${item.workloadBucket}`}><summary>{item.name} · {item.completeSamples} complete samples</summary><dl className="facts"><dt>Workload</dt><dd>{item.workloadBucket}</dd><dt>P{Math.round((item.percentile ?? 0.95) * 100)} latency</dt><dd>{item.completeSamples < profile.minimumCompleteSamples || (item.latencyQuantileMs ?? item.p95Ms) === null ? 'Insufficient samples' : milliseconds(item.latencyQuantileMs ?? item.p95Ms)}</dd><dt>Known execution timeout ratio</dt><dd>{item.timeoutRate === null ? 'Unknown' : `${Math.round(item.timeoutRate * 100)}%`}</dd><dt>Execution observations</dt><dd>{item.sampleCount}</dd><dt>Environment</dt><dd><code>{item.environmentKey}</code></dd>{Object.entries(item.reliability).flatMap(([kind, count]) => [<dt key={`${kind}-label`}>{kind.replaceAll('_', ' ')}</dt>, <dd key={`${kind}-count`}>{count}</dd>])}</dl></details>)}<p className="tiny muted">Execution observations measure tool behavior. They do not establish task correctness.</p></> : <p className="muted">Unknown. This Run has no saved measurement context or Profile.</p>}</section>
          </>}
          <h3>Actual call summary</h3>{!run.calls.length && <p className="muted">No SDK call records found yet.</p>}{run.calls.map(call => <article className="call-summary" key={call.callId}><p><strong>{call.state}</strong> · {call.kind} · {call.granularity}</p>{call.compaction&&<p className="tiny">{call.compaction.reason} compaction · original operation <code>{call.compaction.operationRef}</code> · native generation {call.compaction.nativeEntryId?"Yes":"Unconfirmed"} · native saved {call.compaction.savedStorageVersion!==null?"Yes":"No"} · entry <code>{call.compaction.nativeEntryId??"Not saved"}</code> · saved version {call.compaction.savedStorageVersion??"None"} · current admission {props.control?.acceptingNewRuns?"Open":"Blocked"}</p>}<dl className="facts"><dt>Call ID</dt><dd><code>{call.callId}</code></dd><dt>Logical call number</dt><dd>{call.attempt} · HTTP attempt count unknown</dd><dt>Response model</dt><dd>{call.responseModel ?? "Unknown"}</dd><dt>SDK stop reason</dt><dd>{call.sdkStopReason ?? "Unknown"}</dd><dt>Duration</dt><dd>{call.durationMs === null ? "Unknown" : `${call.durationMs} ms`}</dd><dt>Input / output tokens</dt><dd>{call.inputTokens ?? "Unknown"} / {call.outputTokens ?? "Unknown"}</dd><dt>Estimated cost</dt><dd>{call.cost === null ? "Unknown" : `${call.cost} ${call.costCurrency}`}</dd><dt>Usage source</dt><dd>{call.usageSource ?? "Unknown"}</dd><dt>Unavailable reason</dt><dd>{call.unavailableReason ?? "None"}</dd></dl>{call.error && <p className="error-text">{call.error.code} · {errorMessage(call.error)}</p>}<ContextDetails host={props.host} callId={call.callId} runId={run.id} sessionId={run.sessionId} /></article>)}
          {run.kind === 'agent' && <section data-testid="tool-call-details"><div className="section-heading"><h3>Tool calls</h3><button disabled={toolsLoading || props.host.state !== 'ready'} onClick={() => void readTools(tools?.page ?? 1)}>Refresh tools</button></div>{toolsLoading && <p role="status">Reading saved tool facts…</p>}{tools && !tools.items.length && <p className="muted">No saved tool calls on this page.</p>}{tools?.items.map(call => <article className="tool-call-summary" id={`tool-call-${call.id}`} key={call.id}><p><strong>{call.name}</strong> <span className="status-chip">{call.status}</span></p><dl className="facts"><dt>Original call</dt><dd><code>{call.nativeToolCallId}</code></dd><dt>Execution mode</dt><dd>{call.executionMode}</dd><dt>Original execution</dt><dd>{call.status}</dd><dt>Model call</dt><dd>{call.modelCallId ?? 'Not recorded'}</dd><dt>Execution stopped</dt><dd>{call.stoppedAt ?? 'Not confirmed'}</dd><dt>SDK delivery</dt><dd>{call.sdkReturned ? 'SDK result saved' : 'SDK return not confirmed'}</dd><dt>SDK result status</dt><dd>{!call.sdkReturned ? 'Unknown; SDK receipt unconfirmed' : call.sdkResultIsError === true ? 'Error result delivered' : call.sdkResultIsError === false ? 'Success result delivered' : 'Unknown'}</dd><dt>Native output truncated</dt><dd>{call.nativeOutputTruncated === true ? 'Yes' : call.nativeOutputTruncated === false ? 'No' : 'Unknown'}</dd><dt>Native result entry</dt><dd><code>{call.nativeEntryId ?? 'None'}</code></dd><dt>Model consumption</dt><dd>{consumptionVerified(call) ? `Included in model call ${call.nextModelCallId}` : 'No later model call confirmed'}</dd><dt>Consumption observed</dt><dd>{consumptionVerified(call) ? call.consumedAt : 'Not recorded'}</dd></dl>{!consumptionVerified(call) && <p className="tiny muted">Model consumption: Unknown. Read the original tool facts again; no later provider input is verified.</p>}{['bash', 'powershell'].includes(call.name) && <p className="tiny muted">Command exit code: Unknown</p>}{call.control ? <><dl className="facts"><dt>Admission</dt><dd>{call.control.admission.status}{call.control.admission.reason ? ` · ${call.control.admission.reason}` : ''}</dd><dt>Before-tool hook</dt><dd>{call.control.preflightStatus}</dd><dt>After-tool hook</dt><dd>{call.control.postflightStatus}</dd><dt>Input / output validation</dt><dd>{call.control.inputValidation} / {call.control.outputValidation}</dd><dt>Business pre / post checks</dt><dd>{call.control.businessValidation.pre} / {call.control.businessValidation.post}</dd><dt>Effective timeout</dt><dd>{milliseconds(call.control.effectiveTimeoutMs)}</dd><dt>Actual execution elapsed</dt><dd>{milliseconds(call.control.executionElapsedMs)}</dd><dt>Observed occupation</dt><dd>{milliseconds(call.control.observedElapsedMs)}</dd><dt>Latency observation</dt><dd>{call.control.latencyObservation.replaceAll('_', ' ')}</dd><dt>Timeout requested</dt><dd>{call.control.timeoutRequestedAt ?? 'Not recorded'}</dd><dt>Stop lag</dt><dd>{milliseconds(call.control.stopLagMs)}</dd><dt>Failure origin / class / stage</dt><dd>{call.control.failureOrigin ?? 'None'} / {call.control.failureClass ?? 'None'} / {call.control.failureStage ?? 'None'}</dd><dt>Failure visibility / persistence</dt><dd>{call.control.failureVisibility} / {call.control.failurePersistence}</dd><dt>Recovery episode</dt><dd>{call.control.repairEpisodeId ?? 'None'}</dd><dt>Original failure call</dt><dd>{call.control.repairOfToolCallId ?? 'Unknown'}</dd><dt>Recovery action</dt><dd>{call.control.recoveryAction ?? 'None'}</dd></dl>{call.control.hookFailure && <p className="error-text" role="status">{call.control.hookFailure.stage} · {errorMessage({ code: call.control.hookFailure.code, category: 'tool', message: 'Tool hook failed.', retryable: false })}</p>}{call.control.validationIssues.length > 0 && <ul aria-label="Validation issues">{call.control.validationIssues.map((issue, index) => <li key={index}>{issue.code} · {issue.stage}{issue.fieldPath.length ? ` · ${issue.fieldPath.join('.')}` : ''}</li>)}</ul>}</> : <p className="muted">Control checks and measurement: Unknown. No control observation was saved.</p>}{call.error && <p role="alert" className="error-text">{errorMessage(call.error)}</p>}<details><summary>Final input and result previews{call.truncated ? ' · Truncated' : ''}</summary><pre className="tool-result-text">{call.inputPreview}</pre><pre className="tool-result-text">{call.resultPreview}</pre></details></article>)}{tools && <div className="actions"><button disabled={toolsLoading || tools.page <= 1} onClick={() => void readTools(tools.page - 1)}>Previous tools page</button><button disabled={toolsLoading || tools.page * tools.pageSize >= tools.totalRows} onClick={() => void readTools(tools.page + 1)}>Next tools page</button></div>}</section>}
          <h3>Saved output</h3><p className="tiny muted">{output ? `${output.offset}–${output.offset + output.text.length} / ${output.totalChars} characters` : "Not read back yet"}</p><pre className="saved-output" data-testid="saved-output">{output?.text || "No saved text output"}</pre><div className="actions"><button disabled={loading || !output?.offset} onClick={() => void pageOutput(0)}>Back to first section</button><button disabled={loading || output?.nextOffset == null} onClick={() => { if (output?.nextOffset != null) void pageOutput(output.nextOffset); }}>Read next output section</button><button disabled={loading} onClick={() => void readOne(run.id)}>Read this run again</button></div>
        </section>
      </> : <p className="muted">Select a recent run to review its saved facts.</p>}
      <section className="recent-runs"><div className="section-heading"><h3>Recent runs</h3><button disabled={loading} onClick={() => void readRecent()}>Refresh recent runs</button></div>{readError && <p role="alert" className="error-text">{readError}</p>}{recent && !recent.runs.length && !readError && <p className="muted">No saved runs on this page.</p>}{recent?.runs.map(item => <button key={item.id} onClick={() => void readOne(item.id)} aria-label={`View Run ${item.id}`}><strong>Run {item.id} · {statusLabel[item.status]}</strong><span>{item.model.provider} / {item.model.modelId}</span><span className="tiny">{item.createdAt}</span></button>)}{recent?.nextBeforeRunId && <button disabled={loading} onClick={() => void readRecent(recent.nextBeforeRunId!)}>Read earlier runs</button>}</section>
    </div>
  </aside></>;
}
