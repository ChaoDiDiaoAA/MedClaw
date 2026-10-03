import { errorMessage, type Result } from "../../../../packages/contracts/src/error";
import { useEffect, useRef, useState } from "react";
import type { HostView, ModelChoice, ModelDirectoryView } from "../../../../packages/contracts/src/model";
import type { ActiveRunView, RunView, RuntimeControlView } from "../../../../packages/contracts/src/run";
import type { SessionDetail } from "../../../../packages/contracts/src/session";
import type { WorkspaceChange, WorkspaceView } from "../../../../packages/contracts/src/workspace";
import { sessionDisplayTitle, type SessionDraft } from "./session-list";
import { ContextPanel } from "./context-panel";
import type { SessionMessagePage, SessionMessageView } from "../../../../packages/contracts/src/messages";
import type { PublicReturn } from "../../../../packages/contracts/src/protocol";

// Each public page stays bounded; the displayed collection is independent of that DTO.
type MessageAvailability = { available: boolean; hasPage: boolean; hasHistory: boolean; hasMore: boolean; unavailable: boolean };
export function NativeMessages(props: { host: HostView; sessionId: number | null; nativeSessionId?: string | null; visible: boolean;
  context: string; revision?: string | null; testId: string; onChanged?: () => void; onAvailability?: (value: MessageAvailability) => void; onCreate?: () => void }) {
  const key = JSON.stringify([props.host.instanceId, props.host.state, props.sessionId, props.nativeSessionId, props.visible, props.context, props.revision]);
  const target = useRef({ key, epoch: 0 }), generation = useRef(0), mounted = useRef(true);
  if (target.current.key !== key) { target.current = { key, epoch: target.current.epoch + 1 }; generation.current++; }
  type View = { key: string; pages: SessionMessagePage[]; loading: boolean; error: string | null };
  const [view, setView] = useState<View>({ key, pages: [], loading: false, error: null }), viewRef = useRef(view);
  const [reference, setReference] = useState<string | null>(null), referenceOrder = useRef(0);
  const current = view.key === key ? view : { key, pages: [], loading: false, error: null }, last = current.pages.at(-1);
  const write = (value: View) => { viewRef.current = value; setView(value); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; referenceOrder.current++; }; }, []);
  useEffect(() => { referenceOrder.current++; setReference(null); if (props.visible && props.host.state === 'ready' && props.sessionId) void read(false); }, [key, props.revision]);
  async function read(append: boolean) {
    if (!props.visible || props.host.state !== 'ready' || !props.sessionId || !props.host.instanceId) return;
    const old = viewRef.current.key === key ? viewRef.current : { key, pages: [], loading: false, error: null }, tail = old.pages.at(-1);
    if (append && (!tail?.hasMore || old.loading)) return;
    const leafId = append ? tail!.leafId : null, afterEntryId = append ? tail!.nextEntryId : null;
    const scope = { ...target.current, instanceId: props.host.instanceId, sessionId: props.sessionId, generation: ++generation.current, leafId, afterEntryId };
    const owns = () => mounted.current && target.current.key === scope.key && target.current.epoch === scope.epoch && generation.current === scope.generation;
    const availability = (pages: SessionMessagePage[], available: boolean, unavailable = false) => props.onAvailability?.({ available, unavailable: unavailable && pages.length === 0, hasPage: pages.length > 0, hasHistory: pages.some(value => value.items.length > 0 || value.hasMore), hasMore: pages.at(-1)?.hasMore ?? false });
    referenceOrder.current++; setReference(null);
    write({ ...old, loading: true, error: null });
    try {
      const result = await window.medclaw.request('session.messages.read', { sessionId: scope.sessionId, leafId, afterEntryId, limit: 50 });
      if (!owns()) return;
      if (!result.ok) {
        const unavailable = ['resource_unavailable', 'session_history_unavailable', 'session_history_invalid'].includes(result.error.code) && !old.pages.length;
        write({ ...old, loading: true, error: (unavailable ? 'Message history unavailable. ' : 'Message history read failed. ') + errorMessage(result.error) }); availability(old.pages, false, unavailable); return;
      }
      const page = result.data, now = viewRef.current.pages.at(-1);
      if (page.sessionId !== scope.sessionId || props.nativeSessionId && page.nativeSessionId !== props.nativeSessionId
        || append && (now?.leafId !== scope.leafId || now?.nextEntryId !== scope.afterEntryId || page.leafId !== scope.leafId || page.nativeSessionId !== now.nativeSessionId)) {
        write({ ...old, loading: true, error: 'Message history read failed. The reply did not match the original session and leaf.' }); availability(old.pages, false); return;
      }
      const pages = append ? [...old.pages, page] : [page];
      write({ key: scope.key, pages, loading: true, error: null }); props.onChanged?.(); availability(pages, true);
    } catch { if (owns()) { write({ ...old, loading: true, error: 'Message history read failed. Read the original session again.' }); availability(old.pages, false); } }
    finally { if (owns()) write({ ...viewRef.current, loading: false }); }
  }
  async function readReference(message: SessionMessageView, ref: string) {
    const scope = { ...target.current, generation: generation.current, order: ++referenceOrder.current }, sessionId = props.sessionId;
    const owns = () => mounted.current && scope.key === target.current.key && scope.epoch === target.current.epoch && scope.generation === generation.current && scope.order === referenceOrder.current;
    setReference('Reading original reference ' + ref + '…');
    let available = false, summary = '';
    try {
      const [kind, value] = ref.split(':'), id = Number(value);
      if (kind === 'run') {
        const result = await window.medclaw.request('run.read', { runId: id });
        available = result.ok && result.data.kind === 'one' && result.data.run?.id === id && result.data.run.sessionId === sessionId;
        if (result.ok && result.data.kind === 'one' && available) summary = 'Run ' + id + ' · ' + result.data.run!.status + ' · ' + result.data.run!.persistence;
      } else if (kind === 'tool' && message.runId) {
        let lastPage: number | null = null;
        for (let page = 1; lastPage === null || page <= lastPage; page++) {
          if (!owns()) return;
          const result: Result<PublicReturn<'tool.read'>> = await window.medclaw.request('tool.read', { runId: message.runId, page, pageSize: 50 });
          if (!owns()) return;
          if (!result.ok || result.data.runId !== message.runId || result.data.page !== page || result.data.pageSize !== 50) break;
          // Pin the finite read bound from the first original Run page; later growth does not extend it.
          lastPage ??= Math.max(1, Math.ceil(result.data.totalRows / result.data.pageSize));
          const tool = result.data.items.find(item => item.id === id && item.runId === message.runId && item.sessionId === sessionId);
          if (tool) { available = true; summary = 'Tool ' + id + ' · ' + tool.status; break; }
        }
      } else if ((kind === 'query' || kind === 'evidence') && message.runId) {
        const queryId = kind === 'query' ? id : Number(message.references.find(value => value.startsWith('query:'))?.split(':')[1]);
        if (Number.isSafeInteger(queryId) && queryId > 0) {
          const query = await window.medclaw.request('query.read', { queryId, page: 1, pageSize: 50 });
          if (owns() && query.ok && query.data.query.id === queryId && query.data.query.runId === message.runId && query.data.query.sessionId === sessionId) {
            if (kind === 'query') { available = true; summary = 'Query ' + id + ' · ' + query.data.query.totalRows + ' rows'; }
            else {
              const evidence = await window.medclaw.request('evidence.read', { queryId, evidenceId: id, page: 1, pageSize: 50 });
              available = evidence.ok && evidence.data.evidence.id === id && evidence.data.evidence.queryId === queryId;
              if (available) summary = 'Evidence ' + id;
            }
          }
        }
      }
    } catch { /* An unavailable original reference remains visible without selecting another target. */ }
    if (owns()) setReference(available ? summary : 'Original reference ' + ref + ' unavailable. Keep its original Session and Run; read it again there.');
  }
  const seen = new Set<string>(), items = current.pages.flatMap(page => page.items).filter(item => { if (seen.has(item.nativeEntryId)) return false; seen.add(item.nativeEntryId); return true; });
  return <section className="native-messages" data-testid={props.testId} aria-label="Native session messages">
    <div className="section-heading"><h3>Native memory · Session {props.sessionId ?? 'unavailable'}</h3><div className="actions"><button disabled={!props.visible || props.host.state !== 'ready' || !props.sessionId} onClick={() => void read(false)}>Refresh messages</button>{last?.hasMore && <button disabled={current.loading || !props.visible || props.host.state !== 'ready'} onClick={() => void read(true)}>Load more messages</button>}</div></div>
    <p className="tiny muted">Messages in this app session. Run and Answer saving are separate facts.</p>
    {last && <p className="tiny message-origin">Native session <code>{last.nativeSessionId}</code> · Leaf <code>{last.leafId ?? 'None'}</code> · {last.source === 'native_memory' ? 'Native memory' : 'Saved history'}</p>}
    {current.loading && <p role="status">Reading native messages…</p>}
    {current.error && <p className="error-text" role="alert">{current.error}{current.pages.length ? ' Showing the last read leaf.' : ''}</p>}
    {current.error && props.onCreate && <button onClick={props.onCreate}>Create new session</button>}
    {last && !items.length && !current.error && <p className="muted">{last.hasMore ? 'More native entries are available; this page has no visible messages.' : 'No native messages in this session.'}</p>}
    {items.map(message => <article key={message.nativeEntryId} data-native-entry-id={message.nativeEntryId} className="native-message"><strong>{message.displayRole.replaceAll('_', ' ')}</strong>
      <div className="answer-text">{message.text ?? 'Structured native entry; body omitted.'}</div>
      <p className="tiny muted">Native entry <code>{message.nativeEntryId}</code>{message.runId ? ' · Original Run ' + message.runId : ''}{message.toolCallRef ? ' · Tool call ' + message.toolCallRef : ''}</p>
      {message.textInfo.truncated && <p className="tiny muted">Native message display truncated · {message.text?.length ?? 0} / {message.textInfo.totalChars} characters</p>}
      {message.textInfo.redacted && <p className="tiny muted">Unsafe native fields omitted.</p>}
      {!!message.references.length && <div className="actions" aria-label="Original message references">{message.references.map(ref => <button key={ref} onClick={() => void readReference(message, ref)}>Read {ref}</button>)}</div>}
    </article>)}
    {reference && <p role="status" className="tiny">{reference}</p>}
  </section>;
}

export function Chat(props: { visible: boolean; sessionId: number | null; onCreate: () => void; directory: ModelDirectoryView | null; directoryCurrent: boolean; host: HostView; active: ActiveRunView | null; control: RuntimeControlView | null;
  run: RunView | null; preview: { text: string; truncated: boolean } | null; session: SessionDetail | null; draft: SessionDraft | null;
  selecting: boolean; sending: boolean; runningTitle: string | null; onDraft: (patch: Partial<SessionDraft>) => void; onSend: () => void; onResend: () => void;
  onLookup: () => void; onStop: () => void; onModels: () => void; workspace: WorkspaceView | null; workspaceConfirmed: boolean; onWorkspace: (change: WorkspaceChange) => Promise<boolean>;
  dataDefaults: { batchCount: number; referenceDate: string | null; timezone: string | null } | null;
  onUseForSession: (target: { instanceId: string; sessionId: number }, choice: ModelChoice) => void }) {
  const [following, setFollowing] = useState(true), input = useRef<HTMLTextAreaElement>(null), scroll = useRef<HTMLDivElement>(null);
  const [messageRevision, setMessageRevision] = useState(0);
  const availabilityKey = JSON.stringify([props.host.instanceId, props.host.state, props.sessionId, props.session?.session.nativeSessionId, props.visible, props.session?.session.leafId]);
  const availabilityTarget = useRef({ key: availabilityKey, epoch: 0 });
  if (availabilityTarget.current.key !== availabilityKey) availabilityTarget.current = { key: availabilityKey, epoch: availabilityTarget.current.epoch + 1 };
  const availabilityEpoch = availabilityTarget.current.epoch;
  const [messageAvailability, setMessageAvailability] = useState<(MessageAvailability & { epoch: number }) | null>(null);
  const currentAvailability = messageAvailability?.epoch === availabilityEpoch ? messageAvailability : null;
  const draft = props.draft, choice = draft?.model;
  const provider = props.directory?.providers.find(provider => provider.id === choice?.provider);
  const model = props.directory?.models.find(model => model.provider === choice?.provider && model.id === choice?.modelId);
  const configuredProviders = new Set(props.directory?.providers.filter(provider => provider.auth.state === "available").map(provider => provider.id));
  const models = props.directory?.models.filter(model => configuredProviders.has(model.provider) && model.input.includes("text") && model.maxTokens !== null) ?? [];
  const selectedModel = models.find(model => model.provider === choice?.provider && model.id === choice?.modelId);
  const choiceValue = selectedModel ? JSON.stringify([selectedModel.provider, selectedModel.id]) : "";
  const run = props.run?.kind === "agent" && props.run.sessionId !== props.session?.session.id ? null : props.run;
  const reason = props.host.state !== "ready" ? "Waiting for Host to be ready" : props.selecting ? "Session selection is unconfirmed" : !props.session ? "Create or select a session"
    : !props.session.history.available ? "This session cannot continue after a restart. Create a new session." : draft?.pending ? "Read the original submission first"
    : currentAvailability?.available === false ? currentAvailability.unavailable ? 'Native message history is unavailable. Refresh messages or create a new session.' : 'Native message history read failed. Refresh messages before sending.'
    : !draft?.referenceDate ? "Enter a reference date in Message time context" : !draft.timezone.trim() ? "Enter a time zone in Message time context"
    : !props.directoryCurrent ? "Reload the model directory in Models" : !choice ? "Select a session model" : !model || !model.input.includes("text") ? "The session model is unavailable. Select another model."
    : !model.maxTokens ? "Confirm the model output limit" : provider?.auth.state !== "available" ? "Authenticate the provider first" : !props.control ? "Run availability is unconfirmed"
    : !props.control.acceptingNewRuns ? (props.control.blockReasons[0] ? errorMessage(props.control.blockReasons[0]) : "Wait for the original run to stop and be saved") : null;
  const status = props.active && props.active.runId === run?.id && props.active.stopPending ? "Stopping; waiting for confirmation"
    : props.active && props.active.runId === run?.id && props.active.persistencePending ? "Waiting to save"
    : run?.status === "completed" ? "Saved" : run?.status === "cancelled" ? "Cancelled and saved"
    : run?.status === "failed" ? props.active?.runId === run.id ? "Failed; cleanup unconfirmed" : "Failure saved" : run ? "Generating; not saved" : null;
  const temporary = !!props.preview || run?.status === 'running' || run?.status === 'created';
  const historyUnavailable = !currentAvailability?.hasPage && (currentAvailability?.unavailable || props.session?.history.available === false);
  const showRunBody = temporary || historyUnavailable || run?.kind === 'provider';
  useEffect(() => { if (input.current) { input.current.style.height = "auto"; input.current.style.height = Math.min(160, input.current.scrollHeight + input.current.offsetHeight - input.current.clientHeight) + "px"; } }, [draft?.text, props.session?.session.id]);
  useEffect(() => { if (props.visible && following && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [props.preview?.text, run?.output.text, following, props.sessionId, props.visible, messageRevision]);
  return <div className="chat-layout">
    <div className="session-heading"><strong data-testid="current-session">{props.session ? "Viewing: " + sessionDisplayTitle(props.session.session) : "No session selected"}</strong>
      {props.active && <span data-testid="running-session" className="status-chip">Running: {props.runningTitle ?? "Provider"} · Run {props.active.runId}</span>}</div>
    <div className="messages" ref={scroll} onScroll={() => { if (!props.visible) return; const element = scroll.current!; setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 64); }}>
      <div className="reading-width">
        {!run && !currentAvailability?.hasHistory && currentAvailability?.available !== false && props.session?.history.available !== false && <div className="chat-empty"><span className="eyebrow">Session chat</span><h2>{props.session ? "Start a conversation" : "Create a session"}</h2><p>Each session keeps its context during this app session. Review the saved run for each message.</p><button className="primary" onClick={props.onModels}>Configure models</button></div>}
        {props.sessionId && <NativeMessages host={props.host} sessionId={props.sessionId} nativeSessionId={props.session?.session.nativeSessionId} visible={props.visible} context="chat" revision={props.session?.session.leafId} testId="chat-native-messages" onCreate={props.onCreate} onChanged={() => setMessageRevision(value => value + 1)} onAvailability={value => setMessageAvailability({ ...value, epoch: availabilityEpoch })} />}
        {props.session && !props.session.history.available && <button onClick={props.onCreate}>Create new session</button>}
        {run && <>{run.kind === "provider" && <p className="muted">Provider diagnostic · Run {run.id}</p>}{showRunBody && <div className="user-message"><span className="message-label">User</span><div>{run.inputText}</div></div>}
          <article className="model-answer"><div className="answer-heading"><strong>Assistant</strong><span className="status-chip">{status}</span></div>
            <p className="tiny muted">{temporary ? 'Temporary output · Run and Answer saving unconfirmed' : historyUnavailable ? 'Saved run output; native history unavailable' : run.kind === 'provider' ? 'Saved diagnostic output · Review Run details' : currentAvailability?.hasMore ? 'Native history page incomplete. Load more messages to read this leaf. Read the full saved output in Run details.' : currentAvailability?.hasPage ? 'Native history: in memory. Read the full saved output in Run details.' : 'Native history coverage unconfirmed. Read the full saved output in Run details.'}</p>
            {showRunBody && <div className="answer-text" data-testid="run-output">{props.preview?.text ?? (run.output.text || "Waiting for model output")}</div>}
            {props.preview?.truncated && <p className="muted">The live preview was truncated. Read the full saved output in Run details.</p>}
            {showRunBody && run.output.nextOffset !== null && !props.preview && <p className="muted">Showing {run.output.text.length} / {run.output.totalChars} characters. Read the full output in Run details.</p>}
            {run.error && <p role="alert" className="error-text">{errorMessage(run.error)}</p>}</article></>}
      </div>
    </div>
    {!following && <button className="new-content" onClick={() => setFollowing(true)}>New content · Back to latest</button>}
    <div className="composer-wrap"><div className="composer reading-width">
      <div className="composer-model"><span aria-hidden="true">◇</span><div className="composer-model-choice">
        <select aria-label="Session model" value={choiceValue} disabled={props.host.state !== "ready" || props.selecting || !props.session || !draft || !props.directoryCurrent} onChange={event => {
          const selected = models.find(model => JSON.stringify([model.provider, model.id]) === event.target.value);
          if (selected && props.directory && props.session && props.host.instanceId) props.onUseForSession({ instanceId: props.host.instanceId, sessionId: props.session.session.id },
            { provider: selected.provider, modelId: selected.id, expectedConfigVersion: props.directory.configVersion });
        }}>
          <option value="" disabled>{props.directoryCurrent ? models.length ? "Select a session model" : "No configured models. Configure a model first." : "Loading model directory…"}</option>
          {models.map(model => <option key={JSON.stringify([model.provider, model.id])} value={JSON.stringify([model.provider, model.id])}>{model.name} · {model.provider} / {model.id}</option>)}
        </select>
        {!selectedModel && <span className="tiny" data-testid="session-model">{choice ? "The selected model is unavailable. Select a configured model." : "No session model selected"}</span>}
      </div><button className="quiet" onClick={props.onModels}>Manage models</button></div>
      {props.active && <p className="tiny muted">Model changes apply to the next message. The current run uses its frozen configuration.</p>}
      <label className="sr-only" htmlFor="message-text">Message text</label><textarea id="message-text" ref={input} value={draft?.text ?? ""} disabled={!draft} placeholder="Type a message…" onChange={event => props.onDraft({ text: event.target.value })} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!reason && !props.sending && draft?.text.trim()) props.onSend(); }
      }} />
      <div className="composer-bottom"><span className="tiny muted">Shift+Enter for a new line</span><div className="actions">
        {draft?.pending && <><button disabled={props.sending} onClick={props.onLookup}>Read original submission</button><button disabled={props.sending} onClick={props.onResend}>Resend original submission</button></>}
        {props.active && <button className="danger" disabled={props.host.state !== "ready"} onClick={props.onStop}>Stop generating</button>}
        <button className="primary" disabled={!!reason || props.sending || !draft?.text.trim()} title={reason ?? undefined} onClick={props.onSend}>{props.sending ? "Submitting…" : "Send"}</button>
      </div></div>{reason && <p className="composer-reason" role="status">{reason}</p>}
    </div><details className="chat-data-context reading-width"><summary>Data for next message · {props.workspace?.batchRefs.length ?? 0} batches</summary><ContextPanel workspace={props.workspace} confirmed={props.workspaceConfirmed} disabled={props.selecting} onUpdate={props.onWorkspace} /></details><details className="reference-fields reading-width"><summary>Message time context</summary><label>Reference date<input type="date" value={draft?.referenceDate ?? ""} disabled={!draft} onChange={event => props.onDraft({ referenceDate: event.target.value })} /></label><label>Time zone<input value={draft?.timezone ?? ""} disabled={!draft} onChange={event => props.onDraft({ timezone: event.target.value })} /></label>{props.dataDefaults && props.dataDefaults.batchCount > 0 && (!props.dataDefaults.referenceDate || !props.dataDefaults.timezone) && <p className="tiny muted" data-testid="data-time-defaults-missing">Imported data has no common default date or time zone. Choose the reference date and time zone for the next message.</p>}{props.dataDefaults?.referenceDate && props.dataDefaults.timezone && <div className="actions"><span className="tiny muted" data-testid="data-time-defaults">Data defaults: {props.dataDefaults.referenceDate} · {props.dataDefaults.timezone}</span><button disabled={!draft || !!draft.pending} onClick={() => props.onDraft({ referenceDate: props.dataDefaults!.referenceDate!, timezone: props.dataDefaults!.timezone! })}>Use data defaults</button></div>}</details></div>
  </div>;
}
