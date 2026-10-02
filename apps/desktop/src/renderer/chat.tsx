import { errorMessage } from "../../../../packages/contracts/src/error";
import { useEffect, useRef, useState } from "react";
import type { HostView, ModelChoice, ModelDirectoryView } from "../../../../packages/contracts/src/model";
import type { ActiveRunView, RunView, RuntimeControlView } from "../../../../packages/contracts/src/run";
import type { SessionDetail } from "../../../../packages/contracts/src/session";
import type { WorkspaceChange, WorkspaceView } from "../../../../packages/contracts/src/workspace";
import { sessionDisplayTitle, type SessionDraft } from "./session-list";
import { ContextPanel } from "./context-panel";

export function Chat(props: { directory: ModelDirectoryView | null; directoryCurrent: boolean; host: HostView; active: ActiveRunView | null; control: RuntimeControlView | null;
  run: RunView | null; preview: { text: string; truncated: boolean } | null; session: SessionDetail | null; draft: SessionDraft | null;
  selecting: boolean; sending: boolean; runningTitle: string | null; onDraft: (patch: Partial<SessionDraft>) => void; onSend: () => void; onResend: () => void;
  onLookup: () => void; onStop: () => void; onModels: () => void; workspace: WorkspaceView | null; workspaceConfirmed: boolean; onWorkspace: (change: WorkspaceChange) => Promise<boolean>;
  dataDefaults: { batchCount: number; referenceDate: string | null; timezone: string | null } | null;
  onUseForSession: (target: { instanceId: string; sessionId: number }, choice: ModelChoice) => void }) {
  const [following, setFollowing] = useState(true), input = useRef<HTMLTextAreaElement>(null), scroll = useRef<HTMLDivElement>(null);
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
    : !draft?.referenceDate ? "Enter a reference date in Message time context" : !draft.timezone.trim() ? "Enter a time zone in Message time context"
    : !props.directoryCurrent ? "Reload the model directory in Models" : !choice ? "Select a session model" : !model || !model.input.includes("text") ? "The session model is unavailable. Select another model."
    : !model.maxTokens ? "Confirm the model output limit" : provider?.auth.state !== "available" ? "Authenticate the provider first" : !props.control ? "Run availability is unconfirmed"
    : !props.control.acceptingNewRuns ? (props.control.blockReasons[0] ? errorMessage(props.control.blockReasons[0]) : "Wait for the original run to stop and be saved") : null;
  const status = props.active && props.active.runId === run?.id && props.active.stopPending ? "Stopping; waiting for confirmation"
    : props.active && props.active.runId === run?.id && props.active.persistencePending ? "Waiting to save"
    : run?.status === "completed" ? "Saved" : run?.status === "cancelled" ? "Cancelled and saved"
    : run?.status === "failed" ? props.active?.runId === run.id ? "Failed; cleanup unconfirmed" : "Failure saved" : run ? "Generating; not saved" : null;
  useEffect(() => { if (input.current) { input.current.style.height = "auto"; input.current.style.height = Math.min(160, input.current.scrollHeight + input.current.offsetHeight - input.current.clientHeight) + "px"; } }, [draft?.text, props.session?.session.id]);
  useEffect(() => { if (following && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [props.preview?.text, run?.output.text, following, props.session?.session.id]);
  return <div className="chat-layout">
    <div className="session-heading"><strong data-testid="current-session">{props.session ? "Viewing: " + sessionDisplayTitle(props.session.session) : "No session selected"}</strong>
      {props.active && <span data-testid="running-session" className="status-chip">Running: {props.runningTitle ?? "Provider"} · Run {props.active.runId}</span>}</div>
    <div className="messages" ref={scroll} onScroll={() => { const element = scroll.current!; setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 64); }}>
      <div className="reading-width">
        {!run && <div className="chat-empty"><span className="eyebrow">Session chat</span><h2>{props.session ? "Start a conversation" : "Create a session"}</h2><p>Each session keeps its context during this app session. Review the saved run for each message.</p><button className="primary" onClick={props.onModels}>Configure models</button></div>}
        {!!props.session?.history.messages.length && <details className="history-preview"><summary>Session history (preview) · {props.session.history.messages.length} messages</summary>
          {props.session.history.messages.map(message => <article key={message.nativeEntryId}><strong>{message.role === "user" ? "User" : "Assistant"}</strong><div className="answer-text">{message.text}</div>{message.truncated && <p className="tiny muted">Showing the first {message.text.length} / {message.totalChars} characters.</p>}</article>)}
          {props.session.history.truncated && <p className="muted">Only the most recent 32 message previews are shown.</p>}</details>}
        {run && <>{run.kind === "provider" && <p className="muted">Provider diagnostic · Run {run.id}</p>}<div className="user-message"><span className="message-label">User</span><div>{run.inputText}</div></div>
          <article className="model-answer"><div className="answer-heading"><strong>Assistant</strong><span className="status-chip">{status}</span></div>
            <div className="answer-text" data-testid="run-output">{props.preview?.text ?? (run.output.text || "Waiting for model output")}</div>
            {props.preview?.truncated && <p className="muted">The live preview was truncated. Read the full saved output in Run details.</p>}
            {run.output.nextOffset !== null && !props.preview && <p className="muted">Showing {run.output.text.length} / {run.output.totalChars} characters. Read the full output in Run details.</p>}
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
