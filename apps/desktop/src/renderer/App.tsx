import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { errorMessage, type Result } from "../../../../packages/contracts/src/error";
import type { AuthAttemptView, AuthNotifyView, AuthPromptView, DesktopDisplayPreferences, HostView, ModelChoice, ModelDirectoryView, ProviderAccepted } from "../../../../packages/contracts/src/model";
import type { DesktopNotice, DesktopSecretInput, DesktopSecretInputResult, PublicMethod, PublicPayload, PublicReturn } from "../../../../packages/contracts/src/protocol";
import type { ActiveRunView, RunView, RuntimeControlView } from "../../../../packages/contracts/src/run";
import type { NewSessionInput, SessionDetail, SessionView, SubmitInput, SubmitResult } from "../../../../packages/contracts/src/session";
import type { WorkspaceChange, WorkspaceView } from "../../../../packages/contracts/src/workspace";
import { Sidebar } from "./sidebar";
import { SessionList, sessionDisplayTitle, newSessionDraft, selectSessionModelDraft, acceptSubmissionDraft, type SessionDraft } from "./session-list";
import { Chat } from "./chat";
import { ModelsPage } from "./models-page";
import { SettingsPage } from "./settings-page";
import { RunDetails } from "./run-details";
import { DataWorkspace } from "./data-workspace";
import { QueryHistory } from "./query-history";
import "./styles.css";

export interface DesktopBridge {
  request<M extends PublicMethod>(method: M, payload: PublicPayload<M>, operationRef?: string): Promise<Result<PublicReturn<M>>>;
  subscribe(listener: (notice: DesktopNotice & { instanceId: string | null }) => void): () => void;
  secretInput(input: DesktopSecretInput): Promise<Result<DesktopSecretInputResult>>;
  discardSecret(token: string): Promise<void>;
  openAuthLink(url: string): Promise<Result<null>>;
  pickImportDirectory(operationRef: string): Promise<Result<{ fileToken: string; directoryName: string } | null>>;
}
declare global { interface Window { medclaw: DesktopBridge } }
export type ViewPage = "chat" | "data" | "queries" | "models" | "settings";
const initialUi: DesktopDisplayPreferences = { navCollapsed: false, detailOpen: false, detailTab: "conditions" };
const initialHost: HostView = { instanceId: null, state: "starting", canStart: false, sdkVersion: null, schemaVersion: null, error: null };
const released = (run: RunView) => ["completed", "failed", "cancelled"].includes(run.status) && !!run.cleanup
  && (run.cleanup.executionStarted === false || run.cleanup.stopConfirmed === true) && run.cleanup.requiredPersistenceComplete === true
  && run.cleanup.resourcesReleased === true && run.cleanup.inputsSettled === true && run.cleanup.unconfirmedItems.length === 0;

export function App() {
  const [page, setPage] = useState<ViewPage>("chat"), [ui, setUi] = useState(initialUi), [uiVersion, setUiVersion] = useState("0");
  const [host, setHost] = useState(initialHost), [directory, setDirectory] = useState<ModelDirectoryView | null>(null), [directoryCurrent, setDirectoryCurrent] = useState(false);
  const [error, setError] = useState<string | null>(null), [active, setActive] = useState<ActiveRunView | null>(null), [control, setControl] = useState<RuntimeControlView | null>(null);
  const [run, setRun] = useState<RunView | null>(null), [preview, setPreview] = useState<{ text: string; truncated: boolean } | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null), [workspaceConfirmed, setWorkspaceConfirmed] = useState(false), [selecting, setSelecting] = useState(false);
  const [catalog, setCatalog] = useState<PublicReturn<"data.read"> | null>(null), catalogRead = useRef(0);
  const [requestedQuery, setRequestedQuery] = useState<number | null>(null);
  const [sessions, setSessions] = useState<SessionView[]>([]), [nextSession, setNextSession] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, SessionDetail>>({}), [drafts, setDrafts] = useState<Record<number, SessionDraft>>({});
  const [creating, setCreating] = useState(false), [creationUnknown, setCreationUnknown] = useState(false), [sending, setSending] = useState<number | null>(null);
  const [prompt, setPrompt] = useState<AuthPromptView | null>(null), [authNotify, setAuthNotify] = useState<AuthNotifyView | null>(null), [authAttempt, setAuthAttempt] = useState<AuthAttemptView | null>(null);
  const hostRef = useRef(host), runRef = useRef(run), workspaceRef = useRef(workspace), sessionsRef = useRef(sessions), draftsRef = useRef(drafts), directoryRef = useRef(directory), catalogRef = useRef(catalog);
  const selectedRuns = useRef(new Map<number, RunView>()), settled = useRef(new Set<number>());
  const previews = useRef(new Map<number, { sessionId: number | null; sequence: number; text: string; truncated: boolean }>());
  const selectBusy = useRef(false), desiredSession = useRef<number | null>(null), sendBusy = useRef<number | null>(null), createBusy = useRef(false);
  const creation = useRef<{ operationRef: string; input: NewSessionInput; model: ModelChoice | null } | null>(null);
  const directoryRead = useRef(0), activeRead = useRef(0), detailsButton = useRef<HTMLButtonElement>(null);
  const workspaceChangeBusy = useRef(false);
  hostRef.current = host; runRef.current = run; workspaceRef.current = workspace; sessionsRef.current = sessions; draftsRef.current = drafts; directoryRef.current = directory; catalogRef.current = catalog;

  const editDraft = useCallback((sessionId: number, patch: Partial<SessionDraft>) => {
    setDrafts(old => { const next = { ...old, [sessionId]: { ...(old[sessionId] ?? newSessionDraft(null, catalogRef.current)), ...patch } }; draftsRef.current = next; return next; });
  }, []);
  const defaultModel = () => directoryRef.current?.selection ? { provider: directoryRef.current.selection.provider, modelId: directoryRef.current.selection.modelId, expectedConfigVersion: directoryRef.current.configVersion } : null;
  const ensureDraft = useCallback((sessionId: number, model?: ModelChoice | null) => {
    if (!draftsRef.current[sessionId]) editDraft(sessionId, newSessionDraft(model ?? defaultModel(), catalogRef.current));
  }, [editDraft]);
  const readUi = useCallback(async () => {
    const result = await window.medclaw.request("settings.ui.read", {});
    if (result.ok) { setUi(result.data.ui); setUiVersion(result.data.configVersion); } else setError(errorMessage(result.error));
  }, []);
  const readDirectory = useCallback(async () => {
    const instance = hostRef.current.instanceId, order = ++directoryRead.current;
    const result = await window.medclaw.request("model.read", {});
    if (instance !== hostRef.current.instanceId || order !== directoryRead.current) return;
    if (result.ok) {
      directoryRef.current = result.data; setDirectory(result.data); setDirectoryCurrent(true);
      setDrafts(old => { const next = Object.fromEntries(Object.entries(old).map(([id, draft]) => {
        const model = draft.model ?? result.data.selection;
        return [id, { ...draft, model: model ? { provider: model.provider, modelId: model.modelId, expectedConfigVersion: result.data.configVersion } : null }];
      })); draftsRef.current = next; return next; });
    } else { setDirectoryCurrent(false); setError(errorMessage(result.error)); }
  }, []);
  const readActive = useCallback(async () => {
    const instance = hostRef.current.instanceId, order = ++activeRead.current;
    const [gate, current] = await Promise.all([window.medclaw.request("run.control.read", {}), window.medclaw.request("run.active", {})]);
    if (instance !== hostRef.current.instanceId || order !== activeRead.current) return;
    if (gate.ok && gate.data.instanceId === instance) setControl(gate.data); else { setControl(null); if (!gate.ok) setError(errorMessage(gate.error)); }
    if (current.ok) setActive(current.data); else setError(errorMessage(current.error));
  }, []);
  const readCatalog = useCallback(async (page = 1) => {
    const instance = hostRef.current.instanceId, order = ++catalogRead.current;
    const result = await window.medclaw.request("data.read", { page });
    if (instance !== hostRef.current.instanceId || order !== catalogRead.current) return;
    if (result.ok) { catalogRef.current = result.data; setCatalog(result.data); } else setError(errorMessage(result.error));
  }, []);
  const readRun = useCallback(async (runId: number) => {
    const instance = hostRef.current.instanceId, result = await window.medclaw.request("run.read", { runId });
    if (instance !== hostRef.current.instanceId) return;
    if (!result.ok) { setError(errorMessage(result.error)); return; }
    if (result.data.kind !== "one" || !result.data.run) return;
    const value = result.data.run;
    if (value.kind === "agent") {
      const prior = selectedRuns.current.get(value.sessionId);
      if (!prior || value.id >= prior.id) selectedRuns.current.set(value.sessionId, value);
    }
    if (released(value)) { settled.current.add(runId); previews.current.delete(runId); }
    if (value.kind === "provider" && runRef.current?.id === runId || value.kind === "agent" && workspaceRef.current?.sessionId === value.sessionId
      && selectedRuns.current.get(value.sessionId)?.id === value.id) {
      runRef.current = value; setRun(value);
      const cached = previews.current.get(runId); setPreview(cached && !settled.current.has(runId) ? cached : null);
    }
  }, []);
  const readSession = useCallback(async (sessionId: number) => {
    const instance = hostRef.current.instanceId, result = await window.medclaw.request("session.read", { sessionId });
    if (instance !== hostRef.current.instanceId) return;
    if (!result.ok) { setError(errorMessage(result.error)); return; }
    if (result.data) { ensureDraft(sessionId); setDetails(old => ({ ...old, [sessionId]: result.data! })); }
  }, [ensureDraft]);
  const readSessions = useCallback(async (beforeSessionId?: number) => {
    const instance = hostRef.current.instanceId, result = await window.medclaw.request("session.list", { ...(beforeSessionId ? { beforeSessionId } : {}), limit: 20 });
    if (instance !== hostRef.current.instanceId) return;
    if (!result.ok) { setError(errorMessage(result.error)); return; }
    setSessions(old => { const next = beforeSessionId ? [...old, ...result.data.sessions.filter(s => !old.some(known => known.id === s.id))] : result.data.sessions;
      sessionsRef.current = next; return next; });
    setNextSession(result.data.nextBeforeSessionId);
  }, []);
  const applyWorkspace = useCallback((value: WorkspaceView, instance: string | null) => {
    if (instance !== hostRef.current.instanceId || value.revision < (workspaceRef.current?.revision ?? 0)) return;
    workspaceRef.current = value; setWorkspace(value); setWorkspaceConfirmed(true);
    const cached = value.sessionId ? selectedRuns.current.get(value.sessionId) ?? null : null;
    runRef.current = cached; setRun(cached); setPreview(cached ? previews.current.get(cached.id) ?? null : null);
    if (value.sessionId) {
      void readSession(value.sessionId);
      void window.medclaw.request("run.read", { recent: true, sessionId: value.sessionId, limit: 1 }).then(result => {
        if (instance === hostRef.current.instanceId && result.ok && result.data.kind === "recent" && result.data.runs[0]) void readRun(result.data.runs[0].id);
      });
    }
  }, [readRun, readSession]);
  const readWorkspace = useCallback(async () => {
    const instance = hostRef.current.instanceId, result = await window.medclaw.request("workspace.read", {});
    if (instance !== hostRef.current.instanceId) return;
    if (result.ok) applyWorkspace(result.data, instance); else { setWorkspaceConfirmed(false); setError(errorMessage(result.error)); }
  }, [applyWorkspace]);
  const changed = useCallback(async () => {
    await readUi(); if (hostRef.current.state !== "ready") return;
    const instance = hostRef.current.instanceId;
    await Promise.all([readDirectory(), readActive(), readSessions(), (async () => {
      await readCatalog();
      if (instance === hostRef.current.instanceId && hostRef.current.state === "ready") await readWorkspace();
    })()]);
  }, [readUi, readDirectory, readActive, readSessions, readWorkspace, readCatalog]);

  useEffect(() => window.medclaw.subscribe(notice => {
    if (notice.type === "host.status") {
      const prior = hostRef.current.instanceId; hostRef.current = notice.host; setHost(notice.host);
      if (notice.host.state !== "ready") { setDirectoryCurrent(false); setControl(null); setWorkspaceConfirmed(false); }
      if (notice.host.instanceId !== prior) {
        setPrompt(null); setAuthNotify(null); setAuthAttempt(null); setDetails({}); setSessions([]); sessionsRef.current = [];
        setActive(null); setControl(null); setWorkspace(null); workspaceRef.current = null; setRun(null); runRef.current = null;
        setCatalog(null); catalogRef.current = null; catalogRead.current++;
        previews.current.clear(); settled.current.clear(); selectedRuns.current.clear(); setPreview(null);
      } return;
    }
    if (notice.instanceId && notice.instanceId !== hostRef.current.instanceId) return;
    if (notice.type === "provider.preview" || notice.type === "agent.preview") {
      const known = runRef.current?.id === notice.runId ? runRef.current : notice.type === "agent.preview" ? selectedRuns.current.get(notice.sessionId) : null;
      if (settled.current.has(notice.runId) || known?.id === notice.runId && released(known)) return;
      const sessionId = notice.type === "agent.preview" ? notice.sessionId : null, sequence = notice.type === "agent.preview" ? notice.noticeSequence : 0;
      const prior = previews.current.get(notice.runId);
      if (notice.type === "agent.preview" && prior && (prior.sessionId !== sessionId || sequence <= prior.sequence)) return;
      const cached = { sessionId, sequence, text: notice.text, truncated: notice.truncated }; previews.current.set(notice.runId, cached);
      if (previews.current.size > 50) previews.current.delete(previews.current.keys().next().value!);
      if (runRef.current?.id === notice.runId && (sessionId === null || workspaceRef.current?.sessionId === sessionId)) setPreview(cached);
    } else if (notice.type === "provider.settled" || notice.type === "agent.settled") {
      settled.current.add(notice.runId); previews.current.delete(notice.runId);
      if (settled.current.size > 50) settled.current.delete(settled.current.values().next().value!);
      if (runRef.current?.id === notice.runId) setPreview(null);
      void readActive(); void readRun(notice.runId);
      if (notice.type === "agent.settled") void readSession(notice.sessionId);
    } else if (notice.type === "provider.persistence_failed" || notice.type === "agent.persistence_failed") { setError(errorMessage(notice.error)); void readActive(); }
    else if (notice.type === "auth.prompt") { setPrompt(notice.prompt); setPage("models"); }
    else if (notice.type === "auth.notify") setAuthNotify(notice.notification);
    else if (notice.type === "auth.finished") { setAuthAttempt(notice.attempt); setPrompt(null); setAuthNotify(null); void readDirectory(); }
    else if (notice.type === "config.changed") void changed();
  }), [changed, readActive, readDirectory, readRun, readSession]);
  useEffect(() => { void readUi(); void window.medclaw.request("host.read", {}).then(result => { if (result.ok) { hostRef.current = result.data; setHost(result.data); } else setError(errorMessage(result.error)); }); }, [readUi]);
  useEffect(() => { if (host.state === "ready") void changed(); }, [host.instanceId, host.state, changed]);
  useEffect(() => {
    if (host.state !== "ready") return;
    const timer = setInterval(() => { void readActive(); if (runRef.current && !released(runRef.current)) void readRun(runRef.current.id); }, 1000);
    return () => clearInterval(timer);
  }, [host.state, readActive, readRun]);

  async function selectSession(sessionId: number) {
    setRequestedQuery(null); desiredSession.current = sessionId; if (selectBusy.current || workspaceChangeBusy.current) return;
    selectBusy.current = true; setSelecting(true); const instance = hostRef.current.instanceId;
    try {
      while (desiredSession.current !== null && instance === hostRef.current.instanceId) {
        const target = desiredSession.current; desiredSession.current = null;
        const current = workspaceRef.current; if (!current) { setWorkspaceConfirmed(false); await readWorkspace(); break; }
        const result = await window.medclaw.request("session.select", { sessionId: target, expectedWorkspaceRevision: current.revision });
        if (instance !== hostRef.current.instanceId) break;
        if (result.ok) applyWorkspace(result.data, instance);
        else { setWorkspaceConfirmed(false); setError(errorMessage(result.error)); await readWorkspace(); }
      }
    } finally { selectBusy.current = false; setSelecting(false); }
  }
  async function updateWorkspace(change: WorkspaceChange) {
    const original = workspaceRef.current, instance = hostRef.current.instanceId;
    if (!original || !workspaceConfirmed || workspaceChangeBusy.current || selectBusy.current || hostRef.current.state !== "ready") return false;
    workspaceChangeBusy.current = true; setSelecting(true); setError(null);
    try {
      const result = await window.medclaw.request("workspace.update", { change, expectedRevision: original.revision }, crypto.randomUUID());
      if (instance !== hostRef.current.instanceId) return false;
      if (result.ok) { applyWorkspace(result.data, instance); return true; }
      setWorkspaceConfirmed(false); setError(errorMessage(result.error)); await readWorkspace(); return false;
    } finally { workspaceChangeBusy.current = false; setSelecting(false); if (desiredSession.current !== null) void selectSession(desiredSession.current); }
  }
  async function createSession(retry = false) {
    if (createBusy.current || selectBusy.current || workspaceChangeBusy.current || !workspaceRef.current || !workspaceConfirmed) return;
    if (!retry && creation.current) { setError("Recover the original creation first."); return; }
    creation.current ??= { operationRef: crypto.randomUUID(), input: { expectedWorkspaceRevision: workspaceRef.current.revision, selectOnCreate: true }, model: defaultModel() };
    const original = creation.current, instance = hostRef.current.instanceId; createBusy.current = true; setCreating(true); setError(null);
    try {
      const result = await window.medclaw.request("session.create", original.input, original.operationRef);
      if (instance !== hostRef.current.instanceId) { setCreationUnknown(true); return; }
      if (result.ok) {
        ensureDraft(result.data.session.id, original.model); applyWorkspace(result.data.workspace, instance);
        creation.current = null; setCreationUnknown(false); await Promise.all([readSessions(), readWorkspace(), readSession(result.data.session.id)]); setPage("chat");
      } else { setError(errorMessage(result.error)); if (result.error.code === "operation_result_unknown") setCreationUnknown(true); else { creation.current = null; setCreationUnknown(false); } }
    } finally { createBusy.current = false; setCreating(false); }
  }
  async function acceptedAgent(value: SubmitResult, pending: NonNullable<SessionDraft["pending"]>) {
    if (value.sessionId !== pending.input.sessionId || value.clientSequence !== pending.input.clientSequence) { setError("The acceptance reply does not match the original submission. Keep it and read its result."); return; }
    const draft = draftsRef.current[value.sessionId];
    if (draft) { const next = acceptSubmissionDraft(draft, pending); if (next !== draft) editDraft(value.sessionId, next); }
    await Promise.all([readRun(value.runId), readSession(value.sessionId), readActive()]);
  }
  async function sendSession(retry = false) {
    const sessionId = workspaceRef.current?.sessionId, draft = sessionId ? draftsRef.current[sessionId] : null, instance = hostRef.current.instanceId;
    if (!sessionId || !draft || !instance || sendBusy.current || selecting || !workspaceConfirmed) return;
    if (!retry && (!draft.model || draft.pending || !control?.acceptingNewRuns || !draft.text.trim() || !draft.referenceDate || !draft.timezone.trim())) return;
    const pending = retry ? draft.pending : { operationRef: crypto.randomUUID(), input: { sessionId, clientSequence: details[sessionId]?.session.nextSubmissionSequence ?? 0,
      text: draft.text, mode: "send", expectedRevision: workspaceRef.current!.revision, expectedBatchIds: workspaceRef.current!.batchRefs.map(batch => batch.id), expectedQueryId: workspaceRef.current!.queryId, model: draft.model!,
      referenceDate: draft.referenceDate, timezone: draft.timezone } satisfies SubmitInput };
    if (!pending) return;
    editDraft(sessionId, { pending }); sendBusy.current = sessionId; setSending(sessionId); setError(null);
    try {
      const result = await window.medclaw.request("session.submit", pending.input, pending.operationRef);
      if (instance !== hostRef.current.instanceId) return;
      if (result.ok) await acceptedAgent(result.data, pending);
      else { setError(errorMessage(result.error)); if (result.error.code !== "operation_result_unknown") editDraft(sessionId, { pending: null }); }
    } finally { sendBusy.current = null; setSending(null); }
  }
  async function lookupSubmission() {
    const sessionId = workspaceRef.current?.sessionId, pending = sessionId ? draftsRef.current[sessionId]?.pending : null, instance = hostRef.current.instanceId;
    if (!pending || !sessionId) return;
    const result = await window.medclaw.request("session.readSubmission", { sessionId: pending.input.sessionId, clientSequence: pending.input.clientSequence });
    if (instance !== hostRef.current.instanceId) return;
    if (result.ok && result.data) await acceptedAgent(result.data, pending);
    else setError(result.ok ? "The original submission was not found. Keep its identity; you can resend the original request." : errorMessage(result.error));
  }
  function useForSession(target: { instanceId: string; sessionId: number }, choice: ModelChoice) {
    const session = sessionsRef.current.find(s => s.id === target.sessionId) ?? details[target.sessionId]?.session;
    const next = selectSessionModelDraft(draftsRef.current[target.sessionId], { session, instanceId: hostRef.current.instanceId, configVersion: directoryRef.current?.configVersion }, target, choice);
    if (!next) { setError("The session or model directory has changed. Select the model again."); return; }
    editDraft(target.sessionId, next); setError(null);
  }
  async function updateUi(patch: Partial<DesktopDisplayPreferences>) {
    const result = await window.medclaw.request("settings.ui.update", { expectedConfigVersion: uiVersion, patch });
    if (result.ok) { setUi(result.data.ui); setUiVersion(result.data.configVersion); if (hostRef.current.state === "ready") void readDirectory(); return true; }
    setError(errorMessage(result.error)); void readUi(); return false;
  }
  async function acceptedProvider(value: ProviderAccepted) {
    const result = await window.medclaw.request("run.read", { runId: value.runId });
    if (result.ok && result.data.kind === "one") { runRef.current = result.data.run; setRun(result.data.run); setPreview(previews.current.get(value.runId) ?? null); }
    setPage("chat"); await readActive();
  }
  async function stop() {
    if (!active) return;
    const id = active.runId, result = await window.medclaw.request("run.cancel", { runId: id });
    if (!result.ok) setError(errorMessage(result.error)); await Promise.all([readActive(), readRun(id)]);
  }
  async function closeDetails() { await updateUi({ detailOpen: false }); detailsButton.current?.focus(); }
  const current = workspace?.sessionId ?? null, currentDetail = current ? details[current] ?? null : null, draft = current ? drafts[current] ?? null : null;
  const runningSession = sessions.find(s => s.id === active?.sessionId);
  return <div className={"desktop " + (ui.navCollapsed ? "nav-collapsed " : "") + (ui.detailOpen ? "has-details" : "")}>
    <Sidebar page={page} onPage={page => { setRequestedQuery(null); setPage(page); }} collapsed={ui.navCollapsed} onCollapse={() => void updateUi({ navCollapsed: true })} host={host}>
      <SessionList sessions={sessions} current={current} running={active?.sessionId ?? null} creating={creating} canCreate={host.state === "ready" && workspaceConfirmed && !selecting}
        creationUnknown={creationUnknown} nextBefore={nextSession} onCreate={() => void createSession()} onRecoverCreate={() => void createSession(true)} onSelect={id => void selectSession(id)} onMore={() => void readSessions(nextSession!)} />
    </Sidebar>
    <main className="workspace">
      <header className="page-header"><div className="header-title">{ui.navCollapsed && <button className="quiet" onClick={() => void updateUi({ navCollapsed: false })}>Expand navigation</button>}<h1>{{ chat: "Chat", data: "Data Workspace", queries: "Query History", models: "Models", settings: "Settings" }[page]}</h1></div><button ref={detailsButton} className="quiet" onClick={() => void updateUi({ detailOpen: !ui.detailOpen })}>View run details</button></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss notice" onClick={() => setError(null)}>×</button></div>}
      <section className="page-content chat-page" hidden={page !== "chat"}><Chat directory={directory} directoryCurrent={directoryCurrent} host={host} active={active} control={control} run={run} preview={preview}
        workspace={workspace} workspaceConfirmed={workspaceConfirmed} onWorkspace={updateWorkspace} dataDefaults={catalog}
        session={currentDetail} draft={draft} selecting={selecting || !workspaceConfirmed} sending={sending === current} runningTitle={runningSession ? sessionDisplayTitle(runningSession) : null}
        onDraft={patch => { if (current) editDraft(current, patch); }} onUseForSession={useForSession} onSend={() => void sendSession()} onResend={() => void sendSession(true)} onLookup={() => void lookupSubmission()} onStop={() => void stop()} onModels={() => setPage("models")} /></section>
      <section className="page-content" hidden={page !== "data"}><DataWorkspace host={host} workspace={workspace} confirmed={workspaceConfirmed && !selecting} catalog={catalog} batches={catalog?.batches ?? []} onRefresh={page => void readCatalog(page)} onUpdate={updateWorkspace} onError={setError} /></section>
      <section className="page-content" hidden={page !== "queries"}><QueryHistory visible={page === "queries"} requestedQueryId={requestedQuery} host={host} workspace={workspace} confirmed={workspaceConfirmed && !selecting} active={active} onUpdate={updateWorkspace} onError={setError} /></section>
      <section className="page-content" hidden={page !== "models"}><ModelsPage directory={directory} directoryCurrent={directoryCurrent} host={host} active={active} control={control}
        sessionTarget={workspaceConfirmed && !selecting && current && currentDetail && host.instanceId ? { instanceId: host.instanceId, sessionId: current } : null} onUseForSession={useForSession}
        prompt={prompt} notification={authNotify} attempt={authAttempt} onChanged={changed} onAccepted={acceptedProvider} onError={setError} /></section>
      <section className="page-content" hidden={page !== "settings"}><SettingsPage ui={ui} host={host} configVersion={uiVersion} onUi={updateUi} onChanged={changed} onError={setError} onHost={setHost} /></section>
    </main>
    {ui.detailOpen && <RunDetails run={run} host={host} viewSessionId={current} tab={ui.detailTab} active={active} control={control} onTab={tab => void updateUi({ detailTab: tab })} onClose={() => void closeDetails()} onError={setError}
      onQuery={(queryId, sessionId) => { if (workspaceRef.current?.sessionId !== sessionId) void selectSession(sessionId); setRequestedQuery(queryId); setPage("queries"); }}
      onRun={value => { runRef.current = value; setRun(value); setPreview(null); }} onRetrySaved={() => void readActive()} />}
  </div>;
}
createRoot(document.getElementById("root")!).render(<App />);
