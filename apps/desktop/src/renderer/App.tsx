import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { errorMessage, type Result } from "../../../../packages/contracts/src/error";
import type { AuthAttemptView, AuthNotifyView, AuthPromptView, DesktopDisplayPreferences, HostView, ModelChoice, ModelDirectoryView, ProviderAccepted } from "../../../../packages/contracts/src/model";
import type { DesktopNotice, DesktopSecretInput, DesktopSecretInputResult, PublicMethod, PublicPayload, PublicReturn } from "../../../../packages/contracts/src/protocol";
import type { ActiveRunView, RunView, RuntimeControlView } from "../../../../packages/contracts/src/run";
import type { NewSessionInput, SessionDetail, SessionInput, SessionView, SubmitInput, SubmitResult } from "../../../../packages/contracts/src/session";
import type { WorkspaceChange, WorkspaceView } from "../../../../packages/contracts/src/workspace";
import { Sidebar } from "./sidebar";
import { SessionList, sessionDisplayTitle, newSessionDraft, selectSessionModelDraft, acceptSubmissionDraft, type SessionDraft } from "./session-list";
import { Chat } from "./chat";
import { useInputQueue } from "./input-queue";
import { ModelsPage } from "./models-page";
import { SettingsPage } from "./settings-page";
import { RunDetails } from "./run-details";
import { DataWorkspace } from "./data-workspace";
import { QueryHistory } from "./query-history";
import { useRunEvents } from "./use-run-events";
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
  const [requestedQuery, setRequestedQuery] = useState<{ queryId: number; ownerSessionId: number } | null>(null);
  const [sessions, setSessions] = useState<SessionView[]>([]), [nextSession, setNextSession] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, SessionDetail>>({}), [drafts, setDrafts] = useState<Record<number, SessionDraft>>({});
  const [creating, setCreating] = useState(false), [creationUnknown, setCreationUnknown] = useState(false), [sending, setSending] = useState<number | null>(null);
  const [cancellingInputs, setCancellingInputs] = useState<number[]>([]), cancelBusy = useRef(new Set<number>());
  const inputQueue = useInputQueue(host), { readInput, refresh: refreshInputs, readPage: readInputPage, accept: acceptInput } = inputQueue;
  const [prompt, setPrompt] = useState<AuthPromptView | null>(null), [authNotify, setAuthNotify] = useState<AuthNotifyView | null>(null), [authAttempt, setAuthAttempt] = useState<AuthAttemptView | null>(null);
  const hostRef = useRef(host), runRef = useRef(run), workspaceRef = useRef(workspace), sessionsRef = useRef(sessions), draftsRef = useRef(drafts), directoryRef = useRef(directory), catalogRef = useRef(catalog);
  const activeRef = useRef(active), controlRef = useRef(control), detailsRef = useRef(details), pageRef = useRef(page);
  const selectedRuns = useRef(new Map<number, RunView>()), settled = useRef(new Set<number>());
  const inspectedRun = useRef<number | null>(null);
  const previews = useRef(new Map<number, { sessionId: number | null; sequence: number; text: string; truncated: boolean }>());
  const selectBusy = useRef(false), desiredSession = useRef<number | null>(null), sendBusy = useRef<number | null>(null), createBusy = useRef(false);
  const creation = useRef<{ operationRef: string; input: NewSessionInput; model: ModelChoice | null } | null>(null);
  const directoryRead = useRef(0), activeRead = useRef(0), detailsButton = useRef<HTMLButtonElement>(null);
  const workspaceChangeBusy = useRef(false);
  const workspaceMutation = useRef<{ instance: string | null; kind: 'create' | 'select' | 'update' | 'restore' } | null>(null);
  const confirmedWorkspace = useRef(false), unknownWorkspaceInstance = useRef<string | null>(null), restoredInstance = useRef<string | null>(null);
  const successfulRestoreInstance = useRef<string | null>(null);
  const [workspaceRecovery, setWorkspaceRecovery] = useState<'verify' | 'restart' | null>(null);
  const workspaceAuthority = useRef<string | null>(null);
  const inconsistentRead = useRef<string | null>(null);
  const desiredSessionNeedsConfirmation = useRef(false);
  const [pendingSessionChoice, setPendingSessionChoice] = useState<number | null>(null);
  const sessionReadOrder = useRef(new Map<number, number>()), mounted = useRef(true);
  const sessionReads = useRef(new Map<number, Promise<void>>());
  const sessionReadAgain = useRef(new Set<number>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  hostRef.current = host; runRef.current = run; workspaceRef.current = workspace; sessionsRef.current = sessions; draftsRef.current = drafts; directoryRef.current = directory; catalogRef.current = catalog;
  activeRef.current = active; controlRef.current = control; detailsRef.current = details; pageRef.current = page;

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
    if (gate.ok && gate.data.instanceId === instance) { controlRef.current = gate.data; setControl(gate.data); } else { controlRef.current = null; setControl(null); if (!gate.ok) setError(errorMessage(gate.error)); }
    if (current.ok) { activeRef.current = current.data; setActive(current.data); } else setError(errorMessage(current.error));
  }, []);
  const readCatalog = useCallback(async (page = 1) => {
    const instance = hostRef.current.instanceId, order = ++catalogRead.current;
    const result = await window.medclaw.request("data.read", { page });
    if (instance !== hostRef.current.instanceId || order !== catalogRead.current) return;
    if (result.ok) { catalogRef.current = result.data; setCatalog(result.data); } else setError(errorMessage(result.error));
  }, []);
  const readRun = useCallback(async (runId: number): Promise<RunView | null> => {
    const instance = hostRef.current.instanceId, result = await window.medclaw.request("run.read", { runId });
    if (instance !== hostRef.current.instanceId) return null;
    if (!result.ok) { setError(errorMessage(result.error)); return null; }
    if (result.data.kind !== "one" || !result.data.run) return null;
    const value = result.data.run;
    if (value.kind === "agent") {
      const prior = selectedRuns.current.get(value.sessionId);
      if (!prior || value.id >= prior.id) selectedRuns.current.set(value.sessionId, value);
    }
    if (released(value)) { settled.current.add(runId); previews.current.delete(runId); }
    if (inspectedRun.current === value.id || value.kind === "provider" && runRef.current?.id === runId || inspectedRun.current === null && value.kind === "agent" && workspaceRef.current?.sessionId === value.sessionId
      && selectedRuns.current.get(value.sessionId)?.id === value.id) {
      runRef.current = value; setRun(value);
      const cached = previews.current.get(runId); setPreview(cached && !settled.current.has(runId) ? cached : null);
    }
    return value;
  }, []);
  const readSession: (sessionId: number) => Promise<void> = useCallback((sessionId: number): Promise<void> => {
    const existing = sessionReads.current.get(sessionId);
    if (existing) {
      if (!sessionReadAgain.current.has(sessionId)) { sessionReadAgain.current.add(sessionId); sessionReadOrder.current.set(sessionId, (sessionReadOrder.current.get(sessionId) ?? 0) + 1); }
      return existing.then(() => sessionReads.current.get(sessionId) ?? Promise.resolve());
    }
    const instance = hostRef.current.instanceId, order = (sessionReadOrder.current.get(sessionId) ?? 0) + 1;
    sessionReadOrder.current.set(sessionId, order);
    let task!: Promise<void>; task = (async () => { try {
      const result = await window.medclaw.request("session.read", { sessionId });
      if (!mounted.current || instance !== hostRef.current.instanceId || sessionReadOrder.current.get(sessionId) !== order) return;
      if (!result.ok) { setError(errorMessage(result.error)); return; }
      if (result.data?.session.id === sessionId) { ensureDraft(sessionId); const next = { ...detailsRef.current, [sessionId]: result.data }; detailsRef.current = next; setDetails(next); }
    } finally { if (sessionReads.current.get(sessionId) === task) {
      sessionReads.current.delete(sessionId);
      if (sessionReadAgain.current.delete(sessionId) && mounted.current && instance === hostRef.current.instanceId && hostRef.current.state === 'ready') void readSession(sessionId);
    } } })();
    sessionReads.current.set(sessionId, task); return task;
  }, [ensureDraft]);
  const readSessions = useCallback(async (beforeSessionId?: number) => {
    const instance = hostRef.current.instanceId, result = await window.medclaw.request("session.list", { ...(beforeSessionId ? { beforeSessionId } : {}), limit: 20 });
    if (instance !== hostRef.current.instanceId) return;
    if (!result.ok) { setError(errorMessage(result.error)); return; }
    setSessions(old => { const next = beforeSessionId ? [...old, ...result.data.sessions.filter(s => !old.some(known => known.id === s.id))] : result.data.sessions;
      sessionsRef.current = next; return next; });
    setNextSession(result.data.nextBeforeSessionId);
  }, []);
  const applyWorkspace = useCallback((value: WorkspaceView, instance: string | null, confirm = true) => {
    if (instance !== hostRef.current.instanceId || value.revision < (workspaceRef.current?.revision ?? 0)) return false;
    const state = (view: WorkspaceView) => JSON.stringify([view.revision, view.sessionId, view.materialVersion, view.batchRefs, view.deviceIds, view.queryId, view.activeView, view.selection]);
    if (workspaceAuthority.current === instance && workspaceRef.current?.revision === value.revision && state(workspaceRef.current) !== state(value)) {
      confirmedWorkspace.current = false; setWorkspaceConfirmed(false); setWorkspaceRecovery('verify');
      setError('The selection reply is inconsistent. Verify the saved selection before continuing.');
      const identity = `${instance}:${value.revision}`;
      if (inconsistentRead.current !== identity) {
        inconsistentRead.current = identity;
        void window.medclaw.request('workspace.read', {}).then(result => {
          if (instance === hostRef.current.instanceId && result.ok) applyWorkspace(result.data, instance, false);
        });
      }
      return false;
    }
    const selectionChanged = value.sessionId !== workspaceRef.current?.sessionId;
    if (selectionChanged) inspectedRun.current = null;
    workspaceRef.current = value; workspaceAuthority.current = instance; setWorkspace(value);
    const confirmed = confirm && successfulRestoreInstance.current === instance && unknownWorkspaceInstance.current !== instance;
    confirmedWorkspace.current = confirmed; setWorkspaceConfirmed(confirmed);
    if (confirmed) { inconsistentRead.current = null; setWorkspaceRecovery(null); }
    if (selectionChanged || !runRef.current) {
      const cached = value.sessionId ? selectedRuns.current.get(value.sessionId) ?? null : null;
      runRef.current = cached; setRun(cached); setPreview(cached ? previews.current.get(cached.id) ?? null : null);
    }
    if (value.sessionId) {
      void readSession(value.sessionId);
      void window.medclaw.request("run.read", { recent: true, sessionId: value.sessionId, limit: 1 }).then(result => {
        if (instance === hostRef.current.instanceId && result.ok && result.data.kind === "recent" && result.data.runs[0]) void readRun(result.data.runs[0].id);
      });
    }
    return true;
  }, [readRun, readSession]);
  const readWorkspace = useCallback(async (confirm = true) => {
    const instance = hostRef.current.instanceId, result = await window.medclaw.request("workspace.read", {});
    if (instance !== hostRef.current.instanceId) return;
    if (result.ok) applyWorkspace(result.data, instance, confirm); else { confirmedWorkspace.current = false; setWorkspaceConfirmed(false); setError(errorMessage(result.error)); }
  }, [applyWorkspace]);
  const restoreWorkspace = useCallback(async () => {
    const instance = hostRef.current.instanceId;
    if (!instance || hostRef.current.state !== 'ready' || workspaceMutation.current || unknownWorkspaceInstance.current === instance) return;
    workspaceMutation.current = { instance, kind: 'restore' }; restoredInstance.current = instance;
    confirmedWorkspace.current = false; setWorkspaceConfirmed(false); setSelecting(true);
    try {
      const result = await window.medclaw.request('workspace.restore', {});
      if (instance !== hostRef.current.instanceId) return;
      if (result.ok) { successfulRestoreInstance.current = instance; applyWorkspace(result.data, instance); }
      else {
        if (result.error.code === 'operation_result_unknown') { unknownWorkspaceInstance.current = instance; setWorkspaceRecovery('restart'); setError('Verify status in Settings and restart the Host.'); }
        else { setWorkspaceRecovery('verify'); setError(errorMessage(result.error)); }
        await readWorkspace(false);
      }
    } finally { if (workspaceMutation.current?.instance === instance && workspaceMutation.current.kind === 'restore') { workspaceMutation.current = null; setSelecting(false); } }
  }, [applyWorkspace, readWorkspace]);
  const changed = useCallback(async () => {
    await readUi(); if (hostRef.current.state !== "ready") return;
    const instance = hostRef.current.instanceId;
    await Promise.all([readDirectory(), readActive(), readSessions(), (async () => {
      await readCatalog();
      if (instance === hostRef.current.instanceId && hostRef.current.state === "ready") {
        if (restoredInstance.current !== instance) await restoreWorkspace();
        else if (!workspaceMutation.current) await readWorkspace(confirmedWorkspace.current);
      }
    })()]);
  }, [readUi, readDirectory, readActive, readSessions, readWorkspace, readCatalog, restoreWorkspace]);

  useEffect(() => window.medclaw.subscribe(notice => {
    if (notice.type === "host.status") {
      const prior = hostRef.current.instanceId; hostRef.current = notice.host; setHost(notice.host);
      if (notice.host.state !== "ready") { setDirectoryCurrent(false); setControl(null); confirmedWorkspace.current = false; setWorkspaceConfirmed(false); }
      if (notice.host.instanceId !== prior) {
        workspaceMutation.current = null; unknownWorkspaceInstance.current = null; setWorkspaceRecovery(null);
        selectBusy.current = false; workspaceChangeBusy.current = false; createBusy.current = false;
        if (desiredSession.current !== null) { desiredSessionNeedsConfirmation.current = true; setPendingSessionChoice(desiredSession.current); }
        setSelecting(false); setCreating(false);
        setPrompt(null); setAuthNotify(null); setAuthAttempt(null);
        // Keep read-only, previously verified facts visible during reconnection.
        // Admission still requires fresh Host/control/workspace confirmation.
        setActive(null); setControl(null);
        setCatalog(null); catalogRef.current = null; catalogRead.current++;
        previews.current.clear(); settled.current.clear(); setPreview(null);
        sessionReadOrder.current.clear(); sessionReads.current.clear(); sessionReadAgain.current.clear(); cancelBusy.current.clear(); setCancellingInputs([]);
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
      if (notice.type === "agent.settled") { void readSession(notice.sessionId); void refreshInputs(notice.sessionId); }
    } else if (notice.type === "provider.persistence_failed" || notice.type === "agent.persistence_failed") { setError(errorMessage(notice.error)); void readActive(); }
    else if (notice.type === "auth.prompt") { setPrompt(notice.prompt); setPage("models"); }
    else if (notice.type === "auth.notify") setAuthNotify(notice.notification);
    else if (notice.type === "auth.finished") { setAuthAttempt(notice.attempt); setPrompt(null); setAuthNotify(null); void readDirectory(); }
    else if (notice.type === "config.changed") void changed();
  }), [changed, readActive, readDirectory, readRun, readSession, refreshInputs]);
  useEffect(() => { void readUi(); void window.medclaw.request("host.read", {}).then(result => { if (result.ok) { hostRef.current = result.data; setHost(result.data); } else setError(errorMessage(result.error)); }); }, [readUi]);
  useEffect(() => { if (host.state === "ready") void changed(); }, [host.instanceId, host.state, changed]);
  useEffect(() => {
    if (host.state !== "ready") return;
    const timer = setInterval(() => {
      void readActive(); if (runRef.current && !released(runRef.current)) void readRun(runRef.current.id);
      const targets = new Set<number>(); if (pageRef.current === 'chat' && workspaceRef.current?.sessionId) targets.add(workspaceRef.current.sessionId);
      if (activeRef.current?.sessionId) targets.add(activeRef.current.sessionId);
      for (const sessionId of targets) { void readSession(sessionId); void refreshInputs(sessionId); }
    }, 1000);
    return () => clearInterval(timer);
  }, [host.state, readActive, readRun, readSession, refreshInputs]);
  useEffect(() => { if (host.state === 'ready' && page === 'chat' && workspace?.sessionId) void refreshInputs(workspace.sessionId, true); }, [host.instanceId, host.state, page, workspace?.sessionId, refreshInputs]);

  async function selectSession(sessionId: number) {
    setRequestedQuery(null); desiredSession.current = sessionId;
    if (!confirmedWorkspace.current) { desiredSessionNeedsConfirmation.current = true; setPendingSessionChoice(sessionId); return; }
    desiredSessionNeedsConfirmation.current = false; setPendingSessionChoice(null);
    if (workspaceMutation.current || unknownWorkspaceInstance.current === hostRef.current.instanceId || hostRef.current.state !== 'ready') return;
    workspaceMutation.current = { instance: hostRef.current.instanceId, kind: 'select' };
    selectBusy.current = true; setSelecting(true); const instance = hostRef.current.instanceId;
    try {
      while (desiredSession.current !== null && instance === hostRef.current.instanceId) {
        const target = desiredSession.current; desiredSession.current = null;
        const current = workspaceRef.current; if (!current) { setWorkspaceConfirmed(false); await readWorkspace(); break; }
        const result = await window.medclaw.request("session.select", { sessionId: target, expectedWorkspaceRevision: current.revision });
        if (instance !== hostRef.current.instanceId) break;
        if (result.ok) {
          if (!applyWorkspace(result.data, instance)) {
            confirmedWorkspace.current = false; setWorkspaceConfirmed(false); setWorkspaceRecovery('verify');
            desiredSession.current ??= target; desiredSessionNeedsConfirmation.current = true; setPendingSessionChoice(desiredSession.current); break;
          }
        }
        else {
          confirmedWorkspace.current = false; setWorkspaceConfirmed(false); desiredSession.current ??= target;
          desiredSessionNeedsConfirmation.current = true; setPendingSessionChoice(desiredSession.current);
          if (result.error.code === 'operation_result_unknown') { unknownWorkspaceInstance.current = instance; setWorkspaceRecovery('restart'); setError('Verify status in Settings and restart the Host.'); }
          else { setWorkspaceRecovery('verify'); setError(errorMessage(result.error)); }
          await readWorkspace(false); break;
        }
      }
    } finally { if (workspaceMutation.current?.instance === instance && workspaceMutation.current.kind === 'select') { workspaceMutation.current = null; selectBusy.current = false; setSelecting(false); } }
  }
  async function updateWorkspace(change: WorkspaceChange) {
    const original = workspaceRef.current, instance = hostRef.current.instanceId;
    if (!original || !confirmedWorkspace.current || workspaceMutation.current || hostRef.current.state !== "ready") return false;
    workspaceMutation.current = { instance, kind: 'update' };
    workspaceChangeBusy.current = true; setSelecting(true); setError(null);
    try {
      const result = await window.medclaw.request("workspace.update", { change, expectedRevision: original.revision }, crypto.randomUUID());
      if (instance !== hostRef.current.instanceId) return false;
      if (result.ok) return applyWorkspace(result.data, instance);
      confirmedWorkspace.current = false; setWorkspaceConfirmed(false);
      if (desiredSession.current !== null) { desiredSessionNeedsConfirmation.current = true; setPendingSessionChoice(desiredSession.current); }
      if (result.error.code === 'operation_result_unknown') { unknownWorkspaceInstance.current = instance; setWorkspaceRecovery('restart'); setError('Verify status in Settings and restart the Host.'); }
      else { setWorkspaceRecovery('verify'); setError(errorMessage(result.error)); }
      await readWorkspace(false); return false;
    } finally { if (workspaceMutation.current?.instance === instance && workspaceMutation.current.kind === 'update') { workspaceMutation.current = null; workspaceChangeBusy.current = false; setSelecting(false); if (confirmedWorkspace.current && desiredSession.current !== null && !desiredSessionNeedsConfirmation.current) void selectSession(desiredSession.current); } }
  }
  async function createSession(retry = false) {
    if (workspaceMutation.current || !workspaceRef.current || hostRef.current.state !== 'ready' || successfulRestoreInstance.current !== hostRef.current.instanceId
      || unknownWorkspaceInstance.current === hostRef.current.instanceId || !retry && !confirmedWorkspace.current) return;
    if (!retry && creation.current) { setError("Recover the original creation first."); return; }
    creation.current ??= { operationRef: crypto.randomUUID(), input: { expectedWorkspaceRevision: workspaceRef.current.revision, selectOnCreate: true }, model: defaultModel() };
    setRequestedQuery(null); const original = creation.current, instance = hostRef.current.instanceId; workspaceMutation.current = { instance, kind: 'create' }; createBusy.current = true; setCreating(true); setSelecting(true); setError(null);
    try {
      const result = await window.medclaw.request("session.create", original.input, original.operationRef);
      if (instance !== hostRef.current.instanceId) { setCreationUnknown(true); return; }
      if (result.ok) {
        ensureDraft(result.data.session.id, original.model); applyWorkspace(result.data.workspace, instance);
        creation.current = null; setCreationUnknown(false); await Promise.all([readSessions(), readWorkspace(), readSession(result.data.session.id)]); setPage("chat");
      } else { setError(errorMessage(result.error)); if (result.error.code === "operation_result_unknown") { setCreationUnknown(true); confirmedWorkspace.current = false; setWorkspaceConfirmed(false); } else { creation.current = null; setCreationUnknown(false); } }
    } finally { if (workspaceMutation.current?.instance === instance && workspaceMutation.current.kind === 'create') { workspaceMutation.current = null; createBusy.current = false; setCreating(false); setSelecting(false); if (confirmedWorkspace.current && desiredSession.current !== null && !desiredSessionNeedsConfirmation.current) void selectSession(desiredSession.current); } }
  }
  async function acceptedAgent(value: SubmitResult, pending: NonNullable<SessionDraft["pending"]>) {
    if (value.sessionId !== pending.input.sessionId || value.clientSequence !== pending.input.clientSequence) { setError("The acceptance reply does not match the original submission. Keep it and read its result."); return; }
    const instance = hostRef.current.instanceId;
    let healthy = false;
    if (value.inputId !== null) {
      const original = await readInput(value.inputId, value.sessionId);
      if (instance !== hostRef.current.instanceId) return;
      if (!original || original.clientSequence !== value.clientSequence || original.mode !== pending.input.mode) {
        setError('The original Input is unavailable. Keep the original draft and read its submission again.');
      } else if (original.status === 'failed' || original.status === 'cancelled' || original.processingStatus === 'failed' || original.status === 'delivery_unknown') {
        const draft = draftsRef.current[value.sessionId];
        if (original.status !== 'delivery_unknown' && draft?.pending?.operationRef === pending.operationRef) editDraft(value.sessionId, { pending: null, resendConfirmed: false });
        setError(original.error ? errorMessage(original.error) : `Input ${original.id} ${original.status === 'delivery_unknown' ? 'consumption is unconfirmed' : 'failed or was cancelled'}. The original draft is retained.`);
      } else healthy = original.status === 'queued' || original.status === 'consumed';
    } else if (value.runId !== null) {
      const original = await readRun(value.runId);
      if (instance !== hostRef.current.instanceId) return;
      healthy = original?.kind === 'agent' && original.sessionId === value.sessionId && original.clientSequence === value.clientSequence;
      if (!healthy) setError('The original Run is unavailable. Keep the original draft and read its submission again.');
    }
    if (workspaceRef.current?.sessionId === value.sessionId) inspectedRun.current = null;
    const draft = draftsRef.current[value.sessionId];
    if (healthy && draft) { const next = acceptSubmissionDraft(draft, pending); if (next !== draft) editDraft(value.sessionId, next); }
    await Promise.all([...(value.inputId !== null && value.runId !== null ? [readRun(value.runId)] : []), readSession(value.sessionId), readActive()]);
  }
  async function sendSession(retry = false) {
    const sessionId = workspaceRef.current?.sessionId, draft = sessionId ? draftsRef.current[sessionId] : null, instance = hostRef.current.instanceId;
    if (!sessionId || !draft || !instance || hostRef.current.state !== 'ready' || sendBusy.current || workspaceMutation.current || !confirmedWorkspace.current) return;
    const originalControl = detailsRef.current[sessionId]?.session.inputControl, root = selectedRuns.current.get(sessionId);
    const mode = originalControl ? draft.mode ?? 'send' : 'send';
    if (retry && !draft.resendConfirmed) return;
    if (!retry && (!draft.model || draft.pending || mode === 'send' && !controlRef.current?.acceptingNewRuns
      || mode !== 'send' && (!originalControl?.acceptingInputs || root?.id !== originalControl.runId || root.kind !== 'agent')
      || !draft.text.trim() || !draft.referenceDate || !draft.timezone.trim())) return;
    const fields = { sessionId, clientSequence: detailsRef.current[sessionId]?.session.nextSubmissionSequence ?? 0, text: draft.text,
      expectedRevision: workspaceRef.current!.revision, expectedBatchIds: workspaceRef.current!.batchRefs.map(batch => batch.id), expectedQueryId: workspaceRef.current!.queryId,
      model: mode === 'send' ? draft.model! : { provider: root!.model.provider, modelId: root!.model.modelId, expectedConfigVersion: root!.model.configVersion },
      referenceDate: mode === 'send' ? draft.referenceDate : root!.referenceDate, timezone: mode === 'send' ? draft.timezone : root!.timezone };
    const pending = retry ? draft.pending : { operationRef: crypto.randomUUID(), input: mode === 'send' ? { ...fields, mode } : { ...fields, mode, targetRunId: originalControl!.runId } satisfies SubmitInput };
    if (!pending) return;
    editDraft(sessionId, { pending, mode: pending.input.mode, resendConfirmed: false }); sendBusy.current = sessionId; setSending(sessionId); setError(null);
    try {
      const result = await window.medclaw.request("session.submit", pending.input, pending.operationRef);
      if (instance !== hostRef.current.instanceId) return;
      if (result.ok) await acceptedAgent(result.data, pending);
      else { setError(errorMessage(result.error)); if (result.error.code !== "operation_result_unknown") editDraft(sessionId, { pending: null }); await Promise.all([readSession(sessionId), readActive(), refreshInputs(sessionId)]); }
    } finally { sendBusy.current = null; setSending(null); }
  }
  async function lookupSubmission() {
    const sessionId = workspaceRef.current?.sessionId, pending = sessionId ? draftsRef.current[sessionId]?.pending : null, instance = hostRef.current.instanceId;
    if (!pending || !sessionId) return;
    const result = await window.medclaw.request("session.readSubmission", { sessionId: pending.input.sessionId, clientSequence: pending.input.clientSequence });
    if (instance !== hostRef.current.instanceId) return;
    if (result.ok && result.data) await acceptedAgent(result.data, pending);
    else {
      editDraft(sessionId, { resendConfirmed: false });
      if (!result.ok) { setError(errorMessage(result.error)); return; }
      const [gate, original] = await Promise.all([window.medclaw.request('run.control.read', {}), window.medclaw.request('session.read', { sessionId: pending.input.sessionId })]);
      if (instance !== hostRef.current.instanceId) return;
      const canRetry = gate.ok && original.ok && original.data?.history.available && (pending.input.mode === 'send' ? gate.data.acceptingNewRuns && gate.data.activeRootRun === null
        : original.data.session.inputControl?.runId === pending.input.targetRunId && original.data.session.inputControl.acceptingInputs);
      editDraft(sessionId, { resendConfirmed: !!canRetry });
      setError(canRetry ? 'The original submission was not found and execution is confirmed available. You can resend its original identity.' : 'The original submission was not found. Execution is unconfirmed or busy; keep its identity and read it again.');
    }
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
    inspectedRun.current = null;
    const result = await window.medclaw.request("run.read", { runId: value.runId });
    if (result.ok && result.data.kind === "one") { runRef.current = result.data.run; setRun(result.data.run); setPreview(previews.current.get(value.runId) ?? null); }
    setPage("chat"); await readActive();
  }
  async function stop() {
    if (!active) return;
    const id = active.runId, sessionId = active.sessionId, instance = hostRef.current.instanceId, result = await window.medclaw.request("run.cancel", { runId: id });
    if (instance !== hostRef.current.instanceId) return;
    if (!result.ok) setError(errorMessage(result.error)); await Promise.all([readActive(), readRun(id), ...(sessionId ? [readSession(sessionId), refreshInputs(sessionId)] : [])]);
  }
  async function cancelInput(original: SessionInput) {
    if (cancelBusy.current.has(original.id) || hostRef.current.state !== 'ready') return;
    const instance = hostRef.current.instanceId; cancelBusy.current.add(original.id); setCancellingInputs([...cancelBusy.current]); setError(null);
    try {
      const result = await window.medclaw.request('session.cancelInput', { inputId: original.id }, crypto.randomUUID());
      if (instance !== hostRef.current.instanceId) return;
      if (!result.ok) setError(errorMessage(result.error));
      else if (result.data.id === original.id && result.data.sessionId === original.sessionId) { acceptInput(result.data); if (result.data.status === 'consumed') setError(`Input ${original.id} is already consumed. Stop original Run ${result.data.runId} to stop further processing.`); }
      else setError('Cancellation reply did not match the original Input. Read it again.');
      await Promise.all([readInput(original.id, original.sessionId), readSession(original.sessionId), readActive(), ...(original.targetRunId ? [readRun(original.targetRunId)] : [])]);
    } finally { if (instance === hostRef.current.instanceId) { cancelBusy.current.delete(original.id); setCancellingInputs([...cancelBusy.current]); } }
  }
  async function closeDetails() { await updateUi({ detailOpen: false }); detailsButton.current?.focus(); }
  const current = workspace?.sessionId ?? null, currentDetail = current ? details[current] ?? null : null, draft = current ? drafts[current] ?? null : null;
  const runEvents = useRunEvents(host, run, page === 'chat' || ui.detailOpen && ui.detailTab === 'runtime', (runId, sessionId) => {
    void readActive(); void readRun(runId); void readSession(sessionId); void refreshInputs(sessionId);
  });
  const runningSession = sessions.find(s => s.id === active?.sessionId);
  const queueRun = current && currentDetail?.session.inputControl ? selectedRuns.current.get(current) ?? null : null;
  const queueRootInput = queueRun?.inputId && current ? inputQueue.snapshots[current]?.items.find(value => value.id === queueRun.inputId) ?? null : null;
  const frozenRun = active?.kind === 'agent' && active.sessionId ? selectedRuns.current.get(active.sessionId) : run?.kind === 'agent' ? run : null;
  const frozenInput = frozenRun?.inputId ? inputQueue.snapshots[frozenRun.sessionId]?.items.find(value => value.id === frozenRun.inputId) ?? null : null;
  return <div className={"desktop " + (ui.navCollapsed ? "nav-collapsed " : "") + (ui.detailOpen ? "has-details" : "")}>
    <Sidebar page={page} onPage={page => { setRequestedQuery(null); setPage(page); }} collapsed={ui.navCollapsed} onCollapse={() => void updateUi({ navCollapsed: true })} host={host}>
      <SessionList sessions={sessions} current={current} running={active?.sessionId ?? null} creating={creating} canCreate={host.state === "ready" && workspaceConfirmed && !selecting} canSelect={host.state === 'ready' && workspaceConfirmed} canRecoverCreate={host.state === 'ready' && !selecting && workspaceRecovery !== 'restart' && successfulRestoreInstance.current === host.instanceId}
        creationUnknown={creationUnknown} nextBefore={nextSession} onCreate={() => void createSession()} onRecoverCreate={() => void createSession(true)} onSelect={id => void selectSession(id)} onMore={() => void readSessions(nextSession!)} />
      {pendingSessionChoice !== null && <p role="status">Session {pendingSessionChoice} is still your requested selection. <button disabled={!workspaceConfirmed || selecting} onClick={() => void selectSession(pendingSessionChoice)}>Confirm Session {pendingSessionChoice}</button></p>}
    </Sidebar>
    <main className="workspace">
      <header className="page-header"><div className="header-title">{ui.navCollapsed && <button className="quiet" onClick={() => void updateUi({ navCollapsed: false })}>Expand navigation</button>}<h1>{{ chat: "Chat", data: "Data Workspace", queries: "Query History", models: "Models", settings: "Settings" }[page]}</h1></div><button ref={detailsButton} className="quiet" onClick={() => void updateUi({ detailOpen: !ui.detailOpen })}>View run details</button></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss notice" onClick={() => setError(null)}>×</button></div>}
      <section className="page-content chat-page" hidden={page !== "chat"}><Chat visible={page === 'chat'} sessionId={current} onCreate={() => void createSession()} directory={directory} directoryCurrent={directoryCurrent} host={host} active={active} control={control} run={run} preview={preview} events={runEvents.state} onFinalSource={runEvents.setFinalSource}
        workspace={workspace} workspaceConfirmed={workspaceConfirmed} workspacePending={selecting} workspaceRecovery={workspaceRecovery} onVerifyWorkspace={() => void restoreWorkspace()} onWorkspace={updateWorkspace} dataDefaults={catalog}
        session={currentDetail} draft={draft} selecting={selecting || !workspaceConfirmed} sending={sending === current} runningTitle={runningSession ? sessionDisplayTitle(runningSession) : null}
        queueRun={queueRun} queueRootInput={queueRootInput} frozenInput={frozenInput} frozenRunId={frozenRun?.id} inputs={current ? inputQueue.snapshots[current] ?? null : null} cancellingInputs={cancellingInputs}
        onRefreshInputs={() => { if (current) void refreshInputs(current, true); }} onMoreInputs={() => { if (current) void readInputPage(current, 'more'); }} onCancelInput={original => void cancelInput(original)}
        onDraft={patch => { if (current) editDraft(current, patch); }} onUseForSession={useForSession} onSend={() => void sendSession()} onResend={() => void sendSession(true)} onLookup={() => void lookupSubmission()} onStop={() => void stop()} onModels={() => setPage("models")} /></section>
      <section className="page-content" hidden={page !== "data"}><DataWorkspace host={host} workspace={workspace} confirmed={workspaceConfirmed && !selecting} workspaceRecovery={workspaceRecovery} onVerifyWorkspace={() => void restoreWorkspace()} catalog={catalog} batches={catalog?.batches ?? []} onRefresh={page => void readCatalog(page)} onUpdate={updateWorkspace} onError={setError} /></section>
      <section className="page-content" hidden={page !== "queries"}><QueryHistory visible={page === "queries"} requestedQuery={requestedQuery} host={host} workspace={workspace} confirmed={workspaceConfirmed && !selecting} active={active} onUpdate={updateWorkspace} onError={setError} /></section>
      <section className="page-content" hidden={page !== "models"}><ModelsPage directory={directory} directoryCurrent={directoryCurrent} host={host} active={active} control={control}
        sessionTarget={workspaceConfirmed && !selecting && current && currentDetail && host.instanceId ? { instanceId: host.instanceId, sessionId: current } : null} onUseForSession={useForSession}
        prompt={prompt} notification={authNotify} attempt={authAttempt} onChanged={changed} onAccepted={acceptedProvider} onError={setError} /></section>
      <section className="page-content" hidden={page !== "settings"}><SettingsPage ui={ui} host={host} configVersion={uiVersion} onUi={updateUi} onChanged={changed} onError={setError} onHost={setHost} /></section>
    </main>
    {ui.detailOpen && <RunDetails run={run} host={host} viewSessionId={current} tab={ui.detailTab} active={active} control={control} events={runEvents.state} onResumeGap={runEvents.resumeGap} onTab={tab => void updateUi({ detailTab: tab })} onClose={() => void closeDetails()} onError={setError}
      onQuery={(queryId, sessionId) => { setRequestedQuery({ queryId, ownerSessionId: sessionId }); setPage("queries"); }}
      onRun={value => { inspectedRun.current = value.id; runRef.current = value; setRun(value); setPreview(null); }} onRetrySaved={() => { void readActive(); if (activeRef.current?.sessionId) { void readSession(activeRef.current.sessionId); void refreshInputs(activeRef.current.sessionId); } }} />}
  </div>;
}
createRoot(document.getElementById("root")!).render(<App />);
