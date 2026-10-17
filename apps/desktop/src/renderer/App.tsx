import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { errorMessage, safeError, type Result } from "../../../../packages/contracts/src/error";
import type {DataDeleteCommitRequest,DataDeleteOperation} from '../../../../packages/contracts/src/data-deletion';
import type { AuthAttemptView, AuthNotifyView, AuthPromptView, DesktopDisplayPreferences, HostView, ModelChoice, ModelDirectoryView, ProviderAccepted } from "../../../../packages/contracts/src/model";
import type { DesktopNotice, DesktopSecretInput, DesktopSecretInputResult, DesktopMethod, DesktopPayload, DesktopReturn, PublicReturn } from "../../../../packages/contracts/src/protocol";
import type { ActiveRunView, RunView, RuntimeControlView } from "../../../../packages/contracts/src/run";
import { RenameSessionInputSchema, DeleteSessionInputSchema, type NewSessionInput, type SessionDetail, type SessionInput, type SessionView, type SubmitInput, type SubmitResult, type SessionManagementReceipt, type SessionMetadataView, type RenameSessionInput, type DeleteSessionInput } from "../../../../packages/contracts/src/session";
import type { WorkspaceChange, WorkspaceView } from "../../../../packages/contracts/src/workspace";
import type { RestoreSessionCheckpointInput, RestoreSessionInput, SessionCheckpointReceipt } from '../../../../packages/contracts/src/session';
import { Sidebar } from "./sidebar";
import { SessionList, sessionDisplayTitle, newSessionDraft, selectSessionModelDraft, acceptSubmissionDraft, type SessionDraft, type SessionManagementEditor } from "./session-list";
import { Chat } from "./chat";
import { useInputQueue } from "./input-queue";
import { ModelsPage, type DirectoryReadStatus } from "./models-page";
import { SettingsPage } from "./settings-page";
import { RunDetails } from "./run-details";
import type { IntentAction } from './intent-panel';
import { ResourcePanel } from './resource-panel';
import { ExtensionsPage } from './extensions-page';
import { DataWorkspace } from "./data-workspace";
import { QueryHistory } from "./query-history";
import { EvaluationPage, evaluationExecutionBlockReason, useEvaluationControl } from './evaluation';
import { useRunEvents } from "./use-run-events";
import { canonicalRequest } from '../../../../packages/contracts/src/run';
import type { QueryParams } from '../../../../packages/contracts/src/query';
import type { DesktopExportDestinationSchema, DesktopExportDestinationResultSchema } from '../../../../packages/contracts/src/export';
import "./styles.css";

export interface DesktopBridge {
  request<M extends DesktopMethod>(method: M, payload: DesktopPayload<M>, operationRef?: string): Promise<Result<DesktopReturn<M>>>;
  subscribe(listener: (notice: DesktopNotice & { instanceId: string | null }) => void): () => void;
  secretInput(input: DesktopSecretInput): Promise<Result<DesktopSecretInputResult>>;
  discardSecret(token: string): Promise<void>;
  openAuthLink(url: string): Promise<Result<null>>;
  pickImportDirectory(operationRef: string): Promise<Result<{ fileToken: string; directoryName: string } | null>>;
  chooseExportDestination(input: import('zod').z.infer<typeof DesktopExportDestinationSchema>): Promise<Result<import('zod').z.infer<typeof DesktopExportDestinationResultSchema>>>;
}
declare global { interface Window { medclaw: DesktopBridge } }
export type ViewPage = "chat" | "data" | "queries" | "models" | "prompt" | "skills" | "extensions" | "evaluation" | "settings";
const initialUi: DesktopDisplayPreferences = { navCollapsed: false, detailOpen: false, detailTab: "conditions" };
const initialHost: HostView = { instanceId: null, state: "starting", canStart: false, sdkVersion: null, schemaVersion: null, error: null };
const released = (run: RunView) => ["completed", "failed", "cancelled"].includes(run.status) && !!run.cleanup
  && (run.cleanup.executionStarted === false || run.cleanup.stopConfirmed === true) && run.cleanup.requiredPersistenceComplete === true
  && run.cleanup.resourcesReleased === true && run.cleanup.inputsSettled === true && run.cleanup.unconfirmedItems.length === 0;
type ManagementOperation = { operationRef: string; instance: string; method: 'session.rename'; input: RenameSessionInput }
  | { operationRef: string; instance: string; method: 'session.delete'; input: DeleteSessionInput };
type ManagementEditor = SessionManagementEditor & { workspaceRevision: number; pending: ManagementOperation | null };

function StartupFailure() {
  return <main className="page-content"><h1>Desktop startup failed</h1><p role="alert">The desktop connection could not be established. Restart the desktop application.</p><p>Sending is unavailable until the desktop connection and saved selection are confirmed.</p><button onClick={() => window.location.reload()}>Reload desktop page</button></main>;
}
export function App() {
  const [failed, setFailed] = useState(false), fail = useCallback(() => setFailed(true), []);
  const bridge = window.medclaw;
  if (failed || !bridge || ['request', 'subscribe', 'secretInput', 'discardSecret', 'openAuthLink', 'pickImportDirectory'].some(key => typeof bridge[key as keyof DesktopBridge] !== 'function')) return <StartupFailure />;
  return <ConnectedApp onBridgeFailure={fail} />;
}
function ConnectedApp({ onBridgeFailure }: { onBridgeFailure: () => void }) {
  const evaluation = useEvaluationControl();
  const executionBlockReason = evaluationExecutionBlockReason(evaluation.control), executionBlockRef = useRef(executionBlockReason);
  executionBlockRef.current = executionBlockReason;
  const [page, setPage] = useState<ViewPage>("chat"), [ui, setUi] = useState(initialUi), [uiVersion, setUiVersion] = useState("0");
  const [uiAvailable, setUiAvailable] = useState(false);
  const uiConfigVersion = useRef('0'), uiReadOrder = useRef(0), uiUpdates = useRef(Promise.resolve(true));
  const [host, setHost] = useState(initialHost), [directory, setDirectory] = useState<ModelDirectoryView | null>(null), [directoryCurrent, setDirectoryCurrent] = useState(false);
  const [directoryStatus, setDirectoryStatus] = useState<DirectoryReadStatus>({ state: 'unread', error: null });
  const intentDefaults = useRef<{ instanceId: string | null; enabled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null), [active, setActive] = useState<ActiveRunView | null>(null), [control, setControl] = useState<RuntimeControlView | null>(null);
  const [run, setRun] = useState<RunView | null>(null), [preview, setPreview] = useState<{ text: string; truncated: boolean } | null>(null);
  const [compactionProgress,setCompactionProgress]=useState<Extract<DesktopNotice,{type:'compaction.progress'}>|null>(null),compactionRevisions=useRef(new Map<string,number>());
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null), [workspaceConfirmed, setWorkspaceConfirmed] = useState(false), [selecting, setSelecting] = useState(false);
  const [catalog, setCatalog] = useState<PublicReturn<"data.read"> | null>(null), catalogRead = useRef(0);
  const [requestedQuery, setRequestedQuery] = useState<{ queryId: number; ownerSessionId: number } | null>(null);
  const [queryFormRun,setQueryFormRun]=useState<{sessionId:number;runId:number;inputId:number}|null>(null);
  const [sessions, setSessions] = useState<SessionView[]>([]), [nextSession, setNextSession] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, SessionDetail>>({}), [drafts, setDrafts] = useState<Record<number, SessionDraft>>({});
  const [management, setManagement] = useState<ManagementEditor | null>(null), managementRef = useRef(management);
  const metadata = useRef(new Map<number, SessionMetadataView>()), deletedSessions = useRef(new Set<number>());
  const sessionListGeneration = useRef(0), sessionListRead = useRef(0);
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
  const workspaceMutation = useRef<{ instance: string | null; kind: 'create' | 'select' | 'update' | 'restore' } | { instance: string; kind: 'delete' | 'batch-delete'; operationRef: string } | {instance:string;kind:'checkpoint';operationRef:string;input:RestoreSessionCheckpointInput} | null>(null);
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
  const pendingDraftTime = useRef(new Map<number, Set<'referenceDate' | 'timezone'>>());
  const hostNoticeEpoch = useRef(0);
  const bridgeFailed = useRef(false);
  const failBridge = useCallback(() => { bridgeFailed.current = true; onBridgeFailure(); }, [onBridgeFailure]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  hostRef.current = host; runRef.current = run; workspaceRef.current = workspace; sessionsRef.current = sessions; draftsRef.current = drafts; directoryRef.current = directory; catalogRef.current = catalog;
  activeRef.current = active; controlRef.current = control; detailsRef.current = details; pageRef.current = page;
  managementRef.current = management;
  const showManagement = (value: ManagementEditor | null) => { managementRef.current = value; setManagement(value); };
  const mergeSession = useCallback((value: SessionView): SessionView | null => {
    const prior = metadata.current.get(value.id);
    if (deletedSessions.current.has(value.id) && value.status !== 'deleted') return null;
    const next = prior && prior.metadataRevision >= value.metadataRevision ? { ...value, ...prior } : value;
    metadata.current.set(value.id, { id: next.id, title: next.title, status: next.status, metadataRevision: next.metadataRevision, deletedAt: next.deletedAt });
    if (next.status === 'deleted') deletedSessions.current.add(next.id);
    return next;
  }, []);

  const intentDefault = () => intentDefaults.current?.instanceId === hostRef.current.instanceId ? intentDefaults.current.enabled : null;
  const editDraft = useCallback((sessionId: number, patch: Partial<SessionDraft>) => {
    const pending = pendingDraftTime.current.get(sessionId), prior = draftsRef.current[sessionId];
    if (patch.text !== undefined && patch.text !== prior?.text) patch = { ...patch, intentRunId: undefined };
    for (const field of ['referenceDate', 'timezone'] as const) if (patch[field] !== undefined && patch[field] !== prior?.[field]) pending?.delete(field);
    if (pending?.size === 0) pendingDraftTime.current.delete(sessionId);
    setDrafts(old => { const next = { ...old, [sessionId]: { ...(old[sessionId] ?? newSessionDraft(null, catalogRef.current, intentDefault())), ...patch } }; draftsRef.current = next; return next; });
  }, []);
  const defaultModel = () => directoryRef.current?.selection ? { provider: directoryRef.current.selection.provider, modelId: directoryRef.current.selection.modelId, expectedConfigVersion: directoryRef.current.configVersion } : null;
  const ensureDraft = useCallback((sessionId: number, model?: ModelChoice | null) => {
    if (!draftsRef.current[sessionId]) {
      const draft = newSessionDraft(model ?? defaultModel(), catalogRef.current, intentDefault());
      // Unknown imported facts cannot be treated as an empty catalog. Only the
      // first confirmed catalog may initialize fields the user has not edited.
      if (!catalogRef.current) { draft.referenceDate = ''; draft.timezone = ''; }
      editDraft(sessionId, draft);
      if (!catalogRef.current) pendingDraftTime.current.set(sessionId, new Set(['referenceDate', 'timezone']));
    }
  }, [editDraft]);
  const readUi = useCallback(async () => {
    const order = ++uiReadOrder.current;
    try {
      const result = await window.medclaw.request("settings.ui.read", {});
      if (order !== uiReadOrder.current || !mounted.current || bridgeFailed.current) return;
      if (result.ok) { uiConfigVersion.current = result.data.configVersion; setUi(result.data.ui); setUiVersion(result.data.configVersion); setUiAvailable(true); }
      else { setUiAvailable(false); setError(errorMessage(result.error)); }
    } catch { if (order === uiReadOrder.current) failBridge(); }
  }, [failBridge]);
  const readDirectory = useCallback(async () => {
    if (hostRef.current.state !== 'ready') return;
    const instance = hostRef.current.instanceId, order = ++directoryRead.current;
    const owns = () => mounted.current && instance === hostRef.current.instanceId && hostRef.current.state === 'ready' && order === directoryRead.current;
    setDirectoryCurrent(false); setDirectoryStatus({ state: 'loading', error: null });
    try {
      const [result, config] = await Promise.all([window.medclaw.request("model.read", {}), window.medclaw.request('model.config.read', {})]);
      if (!owns()) return;
      if (result.ok && config.ok && result.data.configVersion === config.data.configVersion) {
      intentDefaults.current = { instanceId: instance, enabled: config.data.intentModel?.enabled === true };
      const defaultRouting: SessionDraft['routing'] = intentDefaults.current.enabled ? { mode: 'intent', originRunId: null } : null;
      directoryRef.current = result.data; setDirectory(result.data); setDirectoryCurrent(true); setDirectoryStatus({ state: 'ready', error: null });
      setDrafts(old => { const next = Object.fromEntries(Object.entries(old).map(([id, draft]) => {
        const model = draft.model ?? result.data.selection;
        const routing = draft.routing === undefined ? draft.pending ? draft.pending.input.mode === 'send' ? draft.pending.input.routing ?? null : null : defaultRouting : draft.routing;
        return [id, { ...draft, routing, model: model ? { provider: model.provider, modelId: model.modelId, expectedConfigVersion: result.data.configVersion } : null }];
      })); draftsRef.current = next; return next; });
      } else { const message = !result.ok ? errorMessage(result.error) : !config.ok ? errorMessage(config.error) : 'The model configuration changed. Reload the published directory.'; setDirectoryStatus({ state: 'error', error: message }); setError(message); }
    } catch { if (owns()) { const message = 'The model directory could not be read. Reload the published directory.'; setDirectoryStatus({ state: 'error', error: message }); setError(message); } }
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
    if (result.ok) {
      catalogRef.current = result.data; setCatalog(result.data);
      const defaults = newSessionDraft(null, result.data);
      setDrafts(old => {
        const next = { ...old };
        for (const [id, pending] of pendingDraftTime.current) {
          const draft = next[id]; if (!draft) continue;
          next[id] = { ...draft, ...Object.fromEntries([...pending].map(field => [field, defaults[field]])) };
          pendingDraftTime.current.delete(id);
        }
        draftsRef.current = next; return next;
      });
    } else setError(errorMessage(result.error));
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
    if (released(value)) {
      settled.current.add(runId); previews.current.delete(runId);
      if (value.kind === 'agent' && value.status === 'completed') {
        const draft = draftsRef.current[value.sessionId];
        if (draft?.intentRunId === value.id && draft.text === value.inputText) editDraft(value.sessionId, { text: '', intentRunId: undefined });
      }
    }
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
      if (result.data?.session.id === sessionId) {
        const session = mergeSession(result.data.session); if (!session) return;
        if (session.status === 'active') ensureDraft(sessionId);
        const next = { ...detailsRef.current, [sessionId]: { ...result.data, session } }; detailsRef.current = next; setDetails(next);
        setSessions(old => { const next = old.flatMap(value => value.id === sessionId ? session.status === 'active' ? [session] : [] : [value]); sessionsRef.current = next; return next; });
      }
    } finally { if (sessionReads.current.get(sessionId) === task) {
      sessionReads.current.delete(sessionId);
      if (sessionReadAgain.current.delete(sessionId) && mounted.current && instance === hostRef.current.instanceId && hostRef.current.state === 'ready') void readSession(sessionId);
    } } })();
    sessionReads.current.set(sessionId, task); return task;
  }, [ensureDraft, mergeSession]);
  const readSessions = useCallback(async (beforeSessionId?: number) => {
    const instance = hostRef.current.instanceId, generation = sessionListGeneration.current, order = ++sessionListRead.current;
    const result = await window.medclaw.request("session.list", { ...(beforeSessionId ? { beforeSessionId } : {}), limit: 20 });
    if (instance !== hostRef.current.instanceId || generation !== sessionListGeneration.current || order !== sessionListRead.current) return;
    if (!result.ok) { setError(errorMessage(result.error)); return; }
    const values = result.data.sessions.flatMap(value => { const current = mergeSession(value); return current?.status === 'active' ? [current] : []; });
    setSessions(old => { const next = beforeSessionId ? [...old.filter(value => !deletedSessions.current.has(value.id)), ...values.filter(s => !old.some(known => known.id === s.id))] : values;
      sessionsRef.current = next; return next; });
    setNextSession(result.data.nextBeforeSessionId);
  }, [mergeSession]);
  const applyWorkspace = useCallback((value: WorkspaceView, instance: string | null, confirm = true) => {
    if (instance !== hostRef.current.instanceId || value.revision < (workspaceRef.current?.revision ?? 0) || value.sessionId !== null && deletedSessions.current.has(value.sessionId)) return false;
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
    if (result.ok) applyWorkspace(result.data, instance, confirm);
    else {
      confirmedWorkspace.current = false; setWorkspaceConfirmed(false);
      setWorkspaceRecovery(unknownWorkspaceInstance.current === instance ? 'restart' : 'verify');
      setError(errorMessage(result.error));
    }
  }, [applyWorkspace]);
  async function refreshHistory(sessionId:number,operationRef?:string) {
    const instance=hostRef.current.instanceId;
    await Promise.all([readSession(sessionId),readActive(),readWorkspace(),refreshInputs(sessionId,true)]);
    if(instance===hostRef.current.instanceId&&workspaceMutation.current?.kind==='checkpoint'&&workspaceMutation.current.operationRef===operationRef){workspaceMutation.current=null;setSelecting(false);}
  }
  async function resumeCheckpoint(input:RestoreSessionCheckpointInput,operationRef:string):Promise<Result<SessionCheckpointReceipt>> {
    if(executionBlockRef.current)return {ok:false,error:safeError('runtime_busy')};
    const instance=hostRef.current.instanceId;
    if(!instance||hostRef.current.state!=='ready'||workspaceMutation.current||!confirmedWorkspace.current||workspaceRef.current?.sessionId!==input.sessionId
      ||workspaceRef.current.revision!==input.expectedWorkspaceRevision||detailsRef.current[input.sessionId]?.session.storageVersion!==input.expectedStorageVersion)return {ok:false,error:safeError('state_conflict')};
    workspaceMutation.current={instance,kind:'checkpoint',operationRef,input};setSelecting(true);
    sessionReadOrder.current.set(input.sessionId,(sessionReadOrder.current.get(input.sessionId)??0)+1);
    let result:Result<SessionCheckpointReceipt>;
    try{result=await window.medclaw.request('session.restoreCheckpoint',input,operationRef);}catch{result={ok:false,error:safeError('operation_result_unknown')};}
    if(instance!==hostRef.current.instanceId)return {ok:false,error:safeError('operation_result_unknown')};
    // Read the current selection independently. A historical Receipt never owns Workspace.
    if(result.ok||result.error.code!=='operation_result_unknown')await refreshHistory(input.sessionId,operationRef);
    return result;
  }
  async function restoreSession(input:RestoreSessionInput):Promise<Result<SessionDetail>> {
    if(executionBlockRef.current)return {ok:false,error:safeError('runtime_busy')};
    const instance=hostRef.current.instanceId;
    if(!instance||hostRef.current.state!=='ready'||workspaceMutation.current||workspaceRef.current?.sessionId!==input.sessionId)return {ok:false,error:safeError('state_conflict')};
    workspaceMutation.current={instance,kind:'restore'};setSelecting(true);
    try{return await window.medclaw.request('session.restore',input,crypto.randomUUID());}
    finally{if(instance===hostRef.current.instanceId){await refreshHistory(input.sessionId);if(workspaceMutation.current?.kind==='restore'){workspaceMutation.current=null;setSelecting(false);}}}
  }
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
    const uiRead = readUi(); if (hostRef.current.state !== "ready" || bridgeFailed.current) { await uiRead; return; }
    const instance = hostRef.current.instanceId;
    const results = await Promise.allSettled([uiRead, readDirectory(), readActive(), readSessions(), readCatalog(), (async () => {
      if (instance === hostRef.current.instanceId && hostRef.current.state === "ready") {
        if (restoredInstance.current !== instance) await restoreWorkspace();
        else if (!workspaceMutation.current) await readWorkspace(confirmedWorkspace.current);
      }
    })()]);
    if (instance === hostRef.current.instanceId && !bridgeFailed.current && results.some(result => result.status === 'rejected')) setError('Some desktop data could not be read. Read it again before using it.');
  }, [readUi, readDirectory, readActive, readSessions, readWorkspace, readCatalog, restoreWorkspace]);

  useEffect(() => { try { return window.medclaw.subscribe(notice => {
    if (notice.type === "host.status") {
      hostNoticeEpoch.current++;
      const prior = hostRef.current.instanceId; hostRef.current = notice.host; setHost(notice.host);
      if (notice.host.state !== "ready") { directoryRead.current++; setDirectoryStatus({ state: 'unread', error: null }); setDirectoryCurrent(false); setControl(null); confirmedWorkspace.current = false; setWorkspaceConfirmed(false); }
      if (notice.host.instanceId !== prior) {
        setCompactionProgress(null);compactionRevisions.current.clear();
        sessionListGeneration.current++;
        if (managementRef.current?.pending) showManagement({ ...managementRef.current, busy: false, unknown: true, error: 'The Host changed. Read the original operation after the saved selection is restored.' });
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
    if(notice.type==='compaction.progress'&&notice.runId!==null) {
      if(settled.current.has(notice.runId)||activeRef.current?.runId!==notice.runId||activeRef.current.sessionId!==notice.sessionId)return;
      const key=JSON.stringify([notice.instanceId,notice.sessionId,notice.runId,notice.operationRef]);if(notice.revision<=(compactionRevisions.current.get(key)??0))return;
      compactionRevisions.current.set(key,notice.revision);if(compactionRevisions.current.size>50)compactionRevisions.current.delete(compactionRevisions.current.keys().next().value!);
      setCompactionProgress(notice);void readRun(notice.runId);void readActive();return;
    }
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
      setCompactionProgress(previous=>previous?.runId===notice.runId?null:previous);
      if (settled.current.size > 50) settled.current.delete(settled.current.values().next().value!);
      if (runRef.current?.id === notice.runId) setPreview(null);
      void readActive(); void readRun(notice.runId);
      if (notice.type === "agent.settled") { void readSession(notice.sessionId); void refreshInputs(notice.sessionId); }
    } else if (notice.type === "provider.persistence_failed" || notice.type === "agent.persistence_failed") { setError(errorMessage(notice.error)); void readActive(); }
    else if (notice.type === "auth.prompt") { setPrompt(notice.prompt); setPage("models"); }
    else if (notice.type === "auth.notify") setAuthNotify(notice.notification);
    else if (notice.type === "auth.finished") { setAuthAttempt(notice.attempt); setPrompt(null); setAuthNotify(null); void readDirectory(); }
    else if (notice.type === "config.changed") void changed();
  }); } catch { failBridge(); } }, [changed, readActive, readDirectory, readRun, readSession, refreshInputs, failBridge]);
  useEffect(() => {
    if (bridgeFailed.current) return;
    const epoch = hostNoticeEpoch.current, owns = () => mounted.current && !bridgeFailed.current && epoch === hostNoticeEpoch.current;
    void readUi();
    void (async () => { try { const result = await window.medclaw.request("host.read", {}); if (!owns()) return; if (result.ok) { hostRef.current = result.data; setHost(result.data); } else failBridge(); } catch { if (owns()) failBridge(); } })();
  }, [readUi, failBridge]);
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
    if (deletedSessions.current.has(sessionId)) { setError('This session was deleted. Its saved history remains readable.'); return; }
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
  async function confirmDataDeletion(value:DataDeleteOperation){
    const marker=workspaceMutation.current,instance=hostRef.current.instanceId;
    if(marker?.kind==='batch-delete'&&marker.operationRef!==value.operationRef)return;
    if(marker?.kind==='batch-delete'&&unknownWorkspaceInstance.current===instance&&value.state!=='committed'){await readWorkspace(false);setError('Deletion has no final receipt yet. Verify status and restart the Host before another write.');return;}
    if(marker?.kind==='batch-delete'&&marker.instance===instance){unknownWorkspaceInstance.current=null;workspaceMutation.current=null;setSelecting(false);}
    await Promise.all([readWorkspace(),readCatalog(),readActive()]);
  }
  async function commitDataDeletion(input:DataDeleteCommitRequest):Promise<Result<DataDeleteOperation>>{
    const instance=hostRef.current.instanceId;
    if(!instance||!confirmedWorkspace.current||workspaceMutation.current||hostRef.current.state!=='ready')return{ok:false,error:safeError('workspace_revision_mismatch')};
    workspaceMutation.current={instance,kind:'batch-delete',operationRef:input.operationRef};setSelecting(true);
    const unknown=()=>{if(instance===hostRef.current.instanceId){unknownWorkspaceInstance.current=instance;confirmedWorkspace.current=false;setWorkspaceConfirmed(false);setWorkspaceRecovery('restart');setSelecting(false);}};
    try{
      const result=await window.medclaw.request('data.delete.commit',input,input.operationRef);
      if(instance!==hostRef.current.instanceId)return{ok:false,error:safeError('operation_result_unknown')};
      if(result.ok){await confirmDataDeletion(result.data);return result;}
      if(result.error.code==='operation_result_unknown')unknown();else{workspaceMutation.current=null;setSelecting(false);await Promise.all([readWorkspace(),readCatalog()]);}
      return result;
    }catch{unknown();return{ok:false,error:safeError('operation_result_unknown')};}
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
        creation.current = null; setCreationUnknown(false);
        await Promise.all([readSessions(), readWorkspace(), readSession(result.data.session.id)]);
        if (instance === hostRef.current.instanceId && !deletedSessions.current.has(result.data.session.id) && detailsRef.current[result.data.session.id]?.session.status === 'active') ensureDraft(result.data.session.id, original.model);
        setPage("chat");
      } else { setError(errorMessage(result.error)); if (result.error.code === "operation_result_unknown") { setCreationUnknown(true); confirmedWorkspace.current = false; setWorkspaceConfirmed(false); } else { creation.current = null; setCreationUnknown(false); } }
    } finally { if (workspaceMutation.current?.instance === instance && workspaceMutation.current.kind === 'create') { workspaceMutation.current = null; createBusy.current = false; setCreating(false); setSelecting(false); if (confirmedWorkspace.current && desiredSession.current !== null && !desiredSessionNeedsConfirmation.current) void selectSession(desiredSession.current); } }
  }
  function openManagement(target: SessionView, action: 'rename' | 'delete') {
    if (hostRef.current.state !== 'ready' || managementRef.current?.pending || target.status !== 'active' || deletedSessions.current.has(target.id)) return;
    if (action === 'delete' && (!confirmedWorkspace.current || workspaceMutation.current || !workspaceRef.current)) return;
    showManagement({ action, target, title: target.title, visible: true, busy: false, unknown: false, error: null, workspaceRevision: workspaceRef.current?.revision ?? 0, pending: null });
  }
  function invalidateManagement(sessionId: number) {
    sessionListGeneration.current++;
    sessionReadOrder.current.set(sessionId, (sessionReadOrder.current.get(sessionId) ?? 0) + 1);
  }
  function ownsDelete(original: ManagementOperation) {
    const marker = workspaceMutation.current;
    return original.method === 'session.delete' && marker?.kind === 'delete' && marker.instance === original.instance && marker.operationRef === original.operationRef;
  }
  async function confirmManagement(receipt: SessionManagementReceipt, original: ManagementOperation, instance: string) {
    if (instance !== hostRef.current.instanceId || managementRef.current?.pending?.operationRef !== original.operationRef) return;
    if (receipt.operationRef !== original.operationRef || receipt.method !== original.method || receipt.session.id !== original.input.sessionId
      || original.method === 'session.rename' && receipt.session.title !== original.input.title) {
      showManagement({ ...managementRef.current, busy: false, unknown: true, error: 'The reply does not match the original operation. Keep it and read its result.' });
      if (ownsDelete(original)) { unknownWorkspaceInstance.current = instance; confirmedWorkspace.current = false; setWorkspaceConfirmed(false); setWorkspaceRecovery('restart'); setSelecting(false); }
      return;
    }
    invalidateManagement(receipt.session.id);
    if (receipt.method === 'session.delete') {
      deletedSessions.current.add(receipt.session.id); metadata.current.set(receipt.session.id, receipt.session);
      const next = { ...draftsRef.current }; delete next[receipt.session.id]; draftsRef.current = next; setDrafts(next); pendingDraftTime.current.delete(receipt.session.id);
      setSessions(old => { const next = old.filter(value => value.id !== receipt.session.id); sessionsRef.current = next; return next; });
      if (desiredSession.current === receipt.session.id) { desiredSession.current = null; desiredSessionNeedsConfirmation.current = false; setPendingSessionChoice(null); }
      if (ownsDelete(original)) {
        if (unknownWorkspaceInstance.current === original.instance) unknownWorkspaceInstance.current = null;
        confirmedWorkspace.current = false; setWorkspaceConfirmed(false); setWorkspaceRecovery('verify'); setSelecting(true);
      }
    }
    // A receipt is immutable history. Only fresh current reads can update the view.
    await Promise.all([readSession(receipt.session.id), readSessions(), ...(receipt.method === 'session.delete' ? [readWorkspace(ownsDelete(original) || confirmedWorkspace.current)] : [])]);
    if (instance === hostRef.current.instanceId && ownsDelete(original)) { workspaceMutation.current = null; setSelecting(false); }
    if (instance === hostRef.current.instanceId && managementRef.current?.pending?.operationRef === original.operationRef) showManagement(null);
  }
  async function saveManagement() {
    const editor = managementRef.current, instance = hostRef.current.instanceId;
    if (!editor || editor.busy || editor.pending || !instance || hostRef.current.state !== 'ready' || deletedSessions.current.has(editor.target.id)) return;
    if (editor.action === 'delete' && (!confirmedWorkspace.current || workspaceMutation.current)) return;
    const rename = editor.action === 'rename' ? RenameSessionInputSchema.safeParse({ sessionId: editor.target.id, title: editor.title, expectedMetadataRevision: editor.target.metadataRevision }) : null;
    if (rename && !rename.success) { showManagement({ ...editor, error: 'Use a session name containing 1–256 characters after trimming spaces.' }); return; }
    const original: ManagementOperation = rename?.success ? { method: 'session.rename', operationRef: crypto.randomUUID(), instance, input: rename.data }
      : { method: 'session.delete', operationRef: crypto.randomUUID(), instance, input: DeleteSessionInputSchema.parse({ sessionId: editor.target.id, expectedMetadataRevision: editor.target.metadataRevision, expectedWorkspaceRevision: editor.workspaceRevision }) };
    showManagement({ ...editor, busy: true, error: null, pending: original }); invalidateManagement(editor.target.id);
    if (original.method === 'session.delete') { workspaceMutation.current = { instance, kind: 'delete', operationRef: original.operationRef }; setSelecting(true); }
    try {
      const result = original.method === 'session.rename' ? await window.medclaw.request(original.method, original.input, original.operationRef) : await window.medclaw.request(original.method, original.input, original.operationRef);
      if (managementRef.current?.pending?.operationRef !== original.operationRef) return;
      if (instance !== hostRef.current.instanceId || !result.ok && result.error.code === 'operation_result_unknown') {
        showManagement({ ...managementRef.current, busy: false, unknown: true, error: 'The result is unconfirmed. Read the original operation before trying another action.' });
        if (instance === hostRef.current.instanceId && ownsDelete(original)) { unknownWorkspaceInstance.current = instance; confirmedWorkspace.current = false; setWorkspaceConfirmed(false); setWorkspaceRecovery('restart'); setSelecting(false); }
        return;
      }
      if (result.ok) { await confirmManagement(result.data, original, instance); return; }
      if (ownsDelete(original)) { workspaceMutation.current = null; setSelecting(false); }
      await Promise.all([readSession(editor.target.id), ...(original.method === 'session.delete' ? [readWorkspace()] : [])]);
      if (instance === hostRef.current.instanceId && managementRef.current?.pending?.operationRef === original.operationRef) showManagement({ ...editor, target: detailsRef.current[editor.target.id]?.session ?? editor.target, workspaceRevision: workspaceRef.current?.revision ?? editor.workspaceRevision, busy: false, pending: null, error: errorMessage(result.error) });
    } catch {
      if (managementRef.current?.pending?.operationRef === original.operationRef) showManagement({ ...managementRef.current, busy: false, unknown: true, error: 'The result is unconfirmed. Keep the original operation and read it again.' });
      if (instance === hostRef.current.instanceId && ownsDelete(original)) { unknownWorkspaceInstance.current = instance; confirmedWorkspace.current = false; setWorkspaceConfirmed(false); setWorkspaceRecovery('restart'); setSelecting(false); }
    }
  }
  async function readManagement() {
    const editor = managementRef.current, original = editor?.pending, instance = hostRef.current.instanceId;
    if (!editor || !original || editor.busy || !instance || hostRef.current.state !== 'ready') return;
    showManagement({ ...editor, busy: true });
    try {
      const result = await window.medclaw.request('session.readManagementOperation', { operationRef: original.operationRef });
      if (instance !== hostRef.current.instanceId || managementRef.current?.pending?.operationRef !== original.operationRef) return;
      if (result.ok && result.data) { await confirmManagement(result.data, original, instance); return; }
      if (result.ok && !result.data && original.instance !== instance && successfulRestoreInstance.current === instance) {
        await Promise.all([readSession(original.input.sessionId), readWorkspace(confirmedWorkspace.current)]);
        if (instance === hostRef.current.instanceId) showManagement({ ...editor, busy: false, unknown: false, pending: null, visible: true, target: detailsRef.current[editor.target.id]?.session ?? editor.target, workspaceRevision: workspaceRef.current?.revision ?? editor.workspaceRevision, error: 'The original operation was not found after Host restart. Review this action before saving again.' });
        return;
      }
      showManagement({ ...editor, busy: false, unknown: true, error: result.ok ? 'The original operation is not recorded yet. Keep its identity and read it again.' : errorMessage(result.error) });
    } catch { if (instance === hostRef.current.instanceId) showManagement({ ...editor, busy: false, unknown: true, error: 'The original operation could not be read. Keep its identity and read it again.' }); }
  }
  function ownsPending(sessionId: number, pending: NonNullable<SessionDraft['pending']>) {
    const current = draftsRef.current[sessionId]?.pending;
    return current?.operationRef === pending.operationRef && current.input.sessionId === pending.input.sessionId && current.input.clientSequence === pending.input.clientSequence;
  }
  function startNewAttempt(target: { instanceId: string | null; sessionId: number; pending: NonNullable<SessionDraft['pending']> }) {
    if (target.instanceId !== hostRef.current.instanceId || hostRef.current.state !== 'ready' || workspaceRef.current?.sessionId !== target.sessionId
      || !confirmedWorkspace.current || workspaceMutation.current || selectBusy.current || sendBusy.current || deletedSessions.current.has(target.sessionId)
      || detailsRef.current[target.sessionId]?.session.status !== 'active' || !ownsPending(target.sessionId, target.pending) || !draftsRef.current[target.sessionId]?.confirmedFailure) return;
    editDraft(target.sessionId, { pending: null, confirmedFailure: false, resendConfirmed: false }); setError(null);
  }
  async function acceptedAgent(value: SubmitResult, pending: NonNullable<SessionDraft["pending"]>) {
    if (!ownsPending(pending.input.sessionId, pending)) return;
    // Sequence lookup cannot prove operationRef ownership after an identity conflict.
    if (draftsRef.current[pending.input.sessionId]?.confirmedFailure) {
      setError('The original submission has a confirmed failure. Its original identity is retained. Start a new attempt to submit the current draft.'); return;
    }
    if (value.sessionId !== pending.input.sessionId || value.clientSequence !== pending.input.clientSequence) { setError("The acceptance reply does not match the original submission. Keep it and read its result."); return; }
    const instance = hostRef.current.instanceId;
    let healthy = false;
    if (value.inputId !== null) {
      const original = await readInput(value.inputId, value.sessionId);
      if (instance !== hostRef.current.instanceId || !ownsPending(pending.input.sessionId, pending)) return;
      if (!original || original.clientSequence !== value.clientSequence || original.mode !== pending.input.mode) {
        editDraft(value.sessionId, { confirmedFailure: false, resendConfirmed: false });
        setError('The original Input is unavailable. Keep the original draft and read its submission again.');
      } else if (original.status === 'failed' || original.status === 'cancelled' || original.processingStatus === 'failed' || original.status === 'delivery_unknown') {
        editDraft(value.sessionId, { confirmedFailure: original.status !== 'delivery_unknown', resendConfirmed: false });
        setError(original.error ? errorMessage(original.error) : `Input ${original.id} ${original.status === 'delivery_unknown' ? 'consumption is unconfirmed' : 'failed or was cancelled'}. The original draft is retained.`);
      } else healthy = original.status === 'queued' || original.status === 'consumed';
      if(original&&original.clientSequence===value.clientSequence&&original.mode===pending.input.mode&&value.runId!==null
        &&pending.input.mode==='send'&&pending.input.routing?.mode==='user_form')setQueryFormRun({sessionId:value.sessionId,runId:value.runId,inputId:value.inputId});
    } else if (value.runId !== null) {
      const original = await readRun(value.runId);
      if (instance !== hostRef.current.instanceId || !ownsPending(pending.input.sessionId, pending)) return;
      healthy = original?.kind === 'agent' && original.sessionId === value.sessionId && original.clientSequence === value.clientSequence;
      if (!healthy) { editDraft(value.sessionId, { confirmedFailure: false, resendConfirmed: false }); setError('The original Run is unavailable. Keep the original draft and read its submission again.'); }
    }
    if (workspaceRef.current?.sessionId === value.sessionId) inspectedRun.current = null;
    const draft = draftsRef.current[value.sessionId];
    if (healthy && draft) { const next = acceptSubmissionDraft(draft, pending, value.runId); if (next !== draft) editDraft(value.sessionId, next); }
    await Promise.all([...(value.inputId !== null && value.runId !== null ? [readRun(value.runId)] : []), readSession(value.sessionId), readActive()]);
  }
  function canStartIntentAction(source:RunView) {
    if(executionBlockRef.current)return false;
    const sessionId=workspaceRef.current?.sessionId,draft=sessionId?draftsRef.current[sessionId]:null;
    const pending=draft?.pending,knownFailure=!pending||draft?.confirmedFailure===true&&source.kind==='agent'&&['failed','cancelled'].includes(source.status)
      &&pending.input.mode==='send'&&pending.operationRef===source.operationRef&&pending.input.sessionId===source.sessionId&&pending.input.clientSequence===source.clientSequence;
    return source.kind==='agent'&&source.sessionId===sessionId&&source.id===runRef.current?.id&&source.inputId!==null&&released(source)
      &&hostRef.current.state==='ready'&&!!hostRef.current.instanceId&&detailsRef.current[source.sessionId]?.session.status==='active'
      &&controlRef.current?.acceptingNewRuns===true&&!!draft?.model&&knownFailure&&!sendBusy.current&&!workspaceMutation.current&&!selectBusy.current&&confirmedWorkspace.current&&directoryCurrent;
  }
  async function startIntentAction(source:RunView,mode:IntentAction) {
    if(source.kind!=='agent'||!canStartIntentAction(source))return;
    if(mode==='explicit_agent_fallback'){setPage('queries');setError('Review and confirm query conditions before execution.');return;}
    const sessionId=source.sessionId,instance=hostRef.current.instanceId,workspace=workspaceRef.current!,draft=draftsRef.current[sessionId]!;
    const unchanged=()=>mounted.current&&hostRef.current.state==='ready'&&hostRef.current.instanceId===instance&&workspaceRef.current?.sessionId===sessionId
      &&workspaceRef.current.revision===workspace.revision&&!workspaceMutation.current&&!selectBusy.current&&runRef.current?.id===source.id
      &&draftsRef.current[sessionId]===draft&&detailsRef.current[sessionId]?.session.status==='active';
    sendBusy.current=sessionId;setSending(sessionId);setError(null);
    try{
      const chunks:string[]=[];let offset=0,total:number|null=null;
      while(true){
        const result:Result<PublicReturn<'run.read'>>=await window.medclaw.request('run.read',{runId:source.id,inputOffset:offset,inputLimit:65536});
        if(!unchanged())return;
        if(!result.ok)throw new Error(errorMessage(result.error));
        const original:RunView|null=result.data.kind==='one'?result.data.run:null;
        if(original?.kind!=='agent'||original.id!==source.id||original.sessionId!==sessionId||original.inputId!==source.inputId
          ||original.operationRef!==source.operationRef||original.instanceId!==source.instanceId||original.referenceDate!==source.referenceDate||original.timezone!==source.timezone||!released(original))throw new Error('The original task is unconfirmed. Refresh the original Run.');
        const part=original.inputPage;total??=part.totalChars;
        if(part.offset!==offset||part.totalChars!==total||offset+part.text.length>total
          ||(part.nextOffset===null?offset+part.text.length!==total:part.nextOffset!==offset+part.text.length||part.nextOffset<=offset||part.nextOffset>=total))throw new Error('The original task is incomplete. Refresh the original Run.');
        chunks.push(part.text);if(part.nextOffset===null)break;offset=part.nextOffset;
      }
      const text=chunks.join('');
      if(draft.pending&&(draft.pending.input.text!==text||draft.pending.input.referenceDate!==source.referenceDate||draft.pending.input.timezone!==source.timezone))throw new Error('The retained submission does not match the original task. Read its original submission.');
      if(draft.text!==''&&draft.text!==text){setError('Keep or clear the current draft before retrying the original task.');return;}
      if(!unchanged())return;
      const next:SessionDraft={...draft,text,referenceDate:source.referenceDate,timezone:source.timezone,mode:'send',routing:{mode,originRunId:source.id},intentRunId:undefined,pending:null,confirmedFailure:false,resendConfirmed:false};
      editDraft(sessionId,next);sendBusy.current=null;
      await sendSession(false,next);
    }catch(error){if(unchanged())setError(error instanceof Error?error.message:'The original task could not be read. Refresh the original Run.');}
    finally{sendBusy.current=null;setSending(null);}
  }
  async function submitQueryForm(params:QueryParams) {
    const sessionId=workspaceRef.current?.sessionId,draft=sessionId?draftsRef.current[sessionId]:null;
    if(!draft)return;
    await sendSession(false,{...draft,text:'Query form: '+canonicalRequest(params),mode:'send',routing:{mode:'user_form',params}});
  }
  async function sendSession(retry = false,preparedDraft?:SessionDraft) {
    if(!retry&&executionBlockRef.current){setError(executionBlockRef.current);return;}
    const sessionId = workspaceRef.current?.sessionId, draft = preparedDraft??(sessionId ? draftsRef.current[sessionId] : null), instance = hostRef.current.instanceId;
    if (!sessionId || !draft || !instance || deletedSessions.current.has(sessionId) || detailsRef.current[sessionId]?.session.status !== 'active' || hostRef.current.state !== 'ready' || sendBusy.current || workspaceMutation.current || !confirmedWorkspace.current) return;
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
    const pending = retry ? draft.pending : { operationRef: crypto.randomUUID(), input: mode === 'send' ? { ...fields, mode, ...(draft.routing ? { routing: draft.routing } : {}) } : { ...fields, mode, targetRunId: originalControl!.runId } satisfies SubmitInput };
    if (!pending) return;
    editDraft(sessionId, { pending, mode: pending.input.mode, resendConfirmed: false, confirmedFailure: false }); sendBusy.current = sessionId; setSending(sessionId); setError(null);
    try {
      const result = await window.medclaw.request("session.submit", pending.input, pending.operationRef);
      if (instance !== hostRef.current.instanceId || !ownsPending(sessionId, pending)) return;
      if (result.ok) await acceptedAgent(result.data, pending);
      else { setError(errorMessage(result.error)); editDraft(sessionId, { confirmedFailure: result.error.code !== 'operation_result_unknown', resendConfirmed: false }); await Promise.all([readSession(sessionId), readActive(), refreshInputs(sessionId)]); }
    } finally { sendBusy.current = null; setSending(null); }
  }
  async function lookupSubmission() {
    const sessionId = workspaceRef.current?.sessionId, pending = sessionId ? draftsRef.current[sessionId]?.pending : null, instance = hostRef.current.instanceId;
    if (!pending || !sessionId) return;
    const result = await window.medclaw.request("session.readSubmission", { sessionId: pending.input.sessionId, clientSequence: pending.input.clientSequence });
    if (instance !== hostRef.current.instanceId || !ownsPending(sessionId, pending)) return;
    if (result.ok && result.data) await acceptedAgent(result.data, pending);
    else {
      editDraft(sessionId, { resendConfirmed: false });
      if (!result.ok) { setError(errorMessage(result.error)); return; }
      const [gate, original] = await Promise.all([window.medclaw.request('run.control.read', {}), window.medclaw.request('session.read', { sessionId: pending.input.sessionId })]);
      if (instance !== hostRef.current.instanceId || !ownsPending(sessionId, pending)) return;
      const canRetry = gate.ok && original.ok && original.data?.session.status === 'active' && original.data.history.available && (pending.input.mode === 'send' ? gate.data.acceptingNewRuns && gate.data.activeRootRun === null
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
    const update = uiUpdates.current.then(async () => {
      if (!mounted.current || bridgeFailed.current) return false;
      ++uiReadOrder.current;
      try {
        const result = await window.medclaw.request("settings.ui.update", { expectedConfigVersion: uiConfigVersion.current, patch });
        if (!mounted.current || bridgeFailed.current) return false;
        ++uiReadOrder.current;
        if (result.ok) { uiConfigVersion.current = result.data.configVersion; setUi(result.data.ui); setUiVersion(result.data.configVersion); if (hostRef.current.state === "ready") void readDirectory(); return true; }
        setError(errorMessage(result.error)); await readUi(); return false;
      } catch { failBridge(); return false; }
    });
    uiUpdates.current = update;
    return update;
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
  const current = workspace?.sessionId && !deletedSessions.current.has(workspace.sessionId) ? workspace.sessionId : null, currentDetail = current ? details[current] ?? null : null, draft = current ? drafts[current] ?? null : null;
  const runEvents = useRunEvents(host, run, page === 'chat' || ui.detailOpen && ui.detailTab === 'runtime', (runId, sessionId) => {
    void readActive();void readRun(runId);
    if(runRef.current?.kind!=='child'||runRef.current.id!==runId){void readSession(sessionId);void refreshInputs(sessionId);}
  });
  const runningSession = sessions.find(s => s.id === active?.sessionId);
  const queueRun = current && currentDetail?.session.inputControl ? selectedRuns.current.get(current) ?? null : null;
  const queueRootInput = queueRun?.inputId && current ? inputQueue.snapshots[current]?.items.find(value => value.id === queueRun.inputId) ?? null : null;
  const frozenRun = active?.kind === 'agent' && active.sessionId ? selectedRuns.current.get(active.sessionId) : run?.kind === 'agent' ? run : null;
  const frozenInput = frozenRun?.inputId ? inputQueue.snapshots[frozenRun.sessionId]?.items.find(value => value.id === frozenRun.inputId) ?? null : null;
  let productionBlockReason: string | null = null;
  if (!(host.state === 'stopped' && host.canStart)) {
    if (host.state !== 'ready' || !control || control.instanceId !== host.instanceId) productionBlockReason = 'Chat execution readiness is unconfirmed.';
    else if (!control.acceptingNewRuns || control.activeRootRun || control.blockReasons.length) productionBlockReason = 'A chat action is running or still requires stopping or saving.';
  }
  return <div className={"desktop " + (ui.navCollapsed ? "nav-collapsed " : "") + (ui.detailOpen ? "has-details" : "")}>
    <Sidebar page={page} onPage={page => { setRequestedQuery(null); setPage(page); }} collapsed={ui.navCollapsed} onCollapse={() => void updateUi({ navCollapsed: true })} host={host}>
      <SessionList sessions={sessions} current={current} running={active?.sessionId ?? null} creating={creating} canCreate={host.state === "ready" && workspaceConfirmed && !selecting} canSelect={host.state === 'ready' && workspaceConfirmed} canRecoverCreate={host.state === 'ready' && !selecting && workspaceRecovery !== 'restart' && successfulRestoreInstance.current === host.instanceId}
        management={management} canManage={host.state === 'ready' && !management?.pending} canDelete={host.state === 'ready' && workspaceConfirmed && !selecting} onManage={openManagement}
        onManagementTitle={title => { if (managementRef.current && !managementRef.current.pending) showManagement({ ...managementRef.current, title, error: null }); }} onManagementSave={() => void saveManagement()}
        onManagementClose={() => { if (managementRef.current && !managementRef.current.busy) showManagement(managementRef.current.pending ? { ...managementRef.current, visible: false } : null); }} onManagementRead={() => void readManagement()} onRefresh={() => void readSessions()}
        creationUnknown={creationUnknown} nextBefore={nextSession} onCreate={() => void createSession()} onRecoverCreate={() => void createSession(true)} onSelect={id => void selectSession(id)} onMore={() => void readSessions(nextSession!)} />
      {pendingSessionChoice !== null && <p role="status">Session {pendingSessionChoice} is still your requested selection. <button disabled={!workspaceConfirmed || selecting} onClick={() => void selectSession(pendingSessionChoice)}>Confirm Session {pendingSessionChoice}</button></p>}
    </Sidebar>
    <main className="workspace">
      <header className="page-header"><div className="header-title">{ui.navCollapsed && <button className="quiet" onClick={() => void updateUi({ navCollapsed: false })}>Expand navigation</button>}<h1>{{ chat: "Chat", data: "Data Workspace", queries: "Query History", models: "Models", prompt:"Prompt", skills:"Skills", extensions:"Extensions", evaluation: 'Evaluation', settings: "Settings" }[page]}</h1></div><button ref={detailsButton} className="quiet" onClick={() => void updateUi({ detailOpen: true })}>View run details</button></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss notice" onClick={() => setError(null)}>×</button></div>}
      <section className="page-content chat-page" hidden={page !== "chat"}><Chat executionBlockReason={executionBlockReason} compactionProgress={compactionProgress} visible={page === 'chat'} sessionId={current} onCreate={() => void createSession()} directory={directory} directoryCurrent={directoryCurrent} directoryStatus={directoryStatus} host={host} active={active} control={control} run={run} preview={preview} events={runEvents.state} onFinalSource={runEvents.setFinalSource}
        workspace={workspace} workspaceConfirmed={workspaceConfirmed} workspacePending={selecting} workspaceRecovery={workspaceRecovery} onVerifyWorkspace={() => void restoreWorkspace()} onWorkspace={updateWorkspace} dataDefaults={catalog}
        session={currentDetail} draft={draft} selecting={selecting || !workspaceConfirmed} sending={sending !== null && sending === current} runningTitle={runningSession ? sessionDisplayTitle(runningSession) : null}
        queueRun={queueRun} queueRootInput={queueRootInput} frozenInput={frozenInput} frozenRunId={frozenRun?.id} inputs={current ? inputQueue.snapshots[current] ?? null : null} cancellingInputs={cancellingInputs}
        onRefreshInputs={() => { if (current) void refreshInputs(current, true); }} onMoreInputs={() => { if (current) void readInputPage(current, 'more'); }} onCancelInput={original => void cancelInput(original)}
        onResumeCheckpoint={resumeCheckpoint} onRestoreSession={restoreSession} onHistoryVerified={refreshHistory}
        onDraft={patch => { if (current) editDraft(current, patch); }} onUseForSession={useForSession} onSend={() => void sendSession()} onResend={() => void sendSession(true)} onNewAttempt={pending => { if (current) startNewAttempt({ instanceId: host.instanceId, sessionId: current, pending }); }} onLookup={() => void lookupSubmission()} onStop={() => void stop()} onModels={() => setPage("models")} /></section>
      <section className="page-content" hidden={page !== "data"}><DataWorkspace host={host} workspace={workspace} confirmed={workspaceConfirmed && !selecting} workspaceRecovery={workspaceRecovery} onVerifyWorkspace={() => void restoreWorkspace()} onDeleteCommit={commitDataDeletion} onDeleteResult={confirmDataDeletion} catalog={catalog} batches={catalog?.batches ?? []} onRefresh={page => void readCatalog(page)} onUpdate={updateWorkspace} onError={setError} /></section>
      <section className="page-content" hidden={page !== "queries"}><QueryHistory visible={page === "queries"} requestedQuery={requestedQuery} host={host} workspace={workspace} confirmed={workspaceConfirmed && !selecting} writable={!!control?.acceptingNewRuns&&!executionBlockReason} active={active} onUpdate={updateWorkspace} onError={setError}
        formRun={queryFormRun} formPending={draft?.pending??null} formResendConfirmed={!!draft?.resendConfirmed} onSubmitForm={submitQueryForm}
        onReadSubmission={lookupSubmission} onResendSubmission={()=>sendSession(true)}
         formReason={executionBlockReason??(sending!==null?'A submission is being confirmed.':draft?.pending?'Read the original submission before starting another query.':!control?.acceptingNewRuns?'Wait for execution and saving to settle.':!draft?.model?'Select valid model metadata for this Session.':!draft.referenceDate||!draft.timezone?'Set the reference date and timezone in the Session.':null)}/></section>
      <section className="page-content" hidden={page !== "models"}><ModelsPage executionBlockReason={executionBlockReason} directory={directory} directoryCurrent={directoryCurrent} directoryStatus={directoryStatus} host={host} active={active} control={control}
        sessionTarget={workspaceConfirmed && !selecting && current && currentDetail && host.instanceId ? { instanceId: host.instanceId, sessionId: current } : null} onUseForSession={useForSession}
        prompt={prompt} notification={authNotify} attempt={authAttempt} onChanged={changed} onAccepted={acceptedProvider} onError={setError} /></section>
      <section className="page-content" hidden={page !== "settings"}><SettingsPage executionBlockReason={executionBlockReason} ui={ui} uiAvailable={uiAvailable} onReadUi={readUi} host={host} configVersion={uiVersion} onUi={updateUi} onChanged={changed} onError={setError} onHost={setHost} /></section>
      <section className="page-content" hidden={page !== 'evaluation'}><EvaluationPage visible={page === 'evaluation'} evaluation={evaluation}
        productionBlockReason={productionBlockReason} /></section>
      {(page==='prompt'||page==='skills')&&<section className="page-content"><ResourcePanel host={host} source={workspaceConfirmed&&!selecting&&current?{source:'selection',sessionId:current}:null} kind={page==='prompt'?'prompt':'skill'} activeRunId={active?.sessionId===current?active?.runId:null} onPublished={()=>void readDirectory()} /></section>}
      {page==='extensions'&&<section className="page-content"><ExtensionsPage executionBlockReason={executionBlockReason} host={host} sessionId={workspaceConfirmed&&!selecting?current:null} runId={run?.kind==='agent'&&run.sessionId===current?run.id:null} activeRunId={active?.runId??null} stopping={!!active?.stopPending||!!active?.persistencePending} onStop={()=>void stop()} onDetails={()=>void updateUi({detailOpen:true})} onPublished={()=>void readDirectory()} /></section>}
    </main>
    {ui.detailOpen && <RunDetails inputs={inputQueue.snapshots[run?.kind === "agent" ? run.sessionId : current ?? 0] ?? null} onRefreshInputs={() => { const id=run?.kind === "agent" ? run.sessionId : current; if(id)void refreshInputs(id,true); }} onMoreInputs={() => { const id=run?.kind === "agent" ? run.sessionId : current; if(id)void readInputPage(id,"more"); }} cancellingInputs={cancellingInputs} onCancelInput={original => void cancelInput(original)} run={run} host={host} viewSessionId={current} tab={ui.detailTab} active={active} control={control} events={runEvents.state} onResumeGap={runEvents.resumeGap} onTab={tab => void updateUi({ detailTab: tab })} onClose={() => void closeDetails()} onError={setError}
      onIntentAction={(source,mode)=>void startIntentAction(source,mode)} intentActionsDisabled={!run||!canStartIntentAction(run)}
      onQuery={(queryId, sessionId) => { setRequestedQuery({ queryId, ownerSessionId: sessionId }); setPage("queries"); }}
      onRun={value => { inspectedRun.current = value.id; runRef.current = value; setRun(value); setPreview(null); }} onRetrySaved={() => { void readActive(); if (activeRef.current?.sessionId) { void readSession(activeRef.current.sessionId); void refreshInputs(activeRef.current.sessionId); } }} />}
  </div>;
}
createRoot(document.getElementById("root")!).render(<App />);
