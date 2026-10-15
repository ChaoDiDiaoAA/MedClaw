import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../../../packages/contracts/src/error";
import { CustomProviderDefinitionSchema, DEFAULT_INTENT_MODEL, IntentModelConfigurationSchema, type IntentModelConfiguration, type AuthAttemptView, type AuthNotifyView, type AuthPromptView, type AuthStatusView, type CustomModelDefinition, type CustomProviderDefinition, type HostView, type ModelDirectoryView, type ProviderAccepted } from "../../../../packages/contracts/src/model";
import type { ModelChoice } from "../../../../packages/contracts/src/model";
import type { ActiveRunView, RuntimeControlView } from "../../../../packages/contracts/src/run";
import type { IntentModelInspection } from '../../../../packages/contracts/src/intent';

function IntentModelSettings({ host, configVersion, onChanged }: { host: HostView; configVersion?: string; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState<IntentModelConfiguration>({ ...DEFAULT_INTENT_MODEL });
  const [version, setVersion] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState<{ instanceId: string | null; baseUrl: string; inspection: IntentModelInspection } | null>(null);
  const [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const ticket = ++generation.current;
    setVersion(null); setError(null);
    setVerified(old => old?.instanceId === host.instanceId ? old : null);
    if (host.state !== 'ready') return;
    setBusy(true);
    void (async () => {
      try {
        const result = await window.medclaw.request('model.config.read', {});
        if (ticket !== generation.current) return;
        if (!result.ok) { setError(errorMessage(result.error)); return; }
        const value = result.data.intentModel ?? { ...DEFAULT_INTENT_MODEL };
        setDraft(value); setVersion(result.data.configVersion);
        setVerified(old => old?.baseUrl === value.baseUrl ? old : null);
      } catch { if (ticket === generation.current) setError('The intent configuration could not be read. Reload the published directory.'); }
      finally { if (ticket === generation.current) setBusy(false); }
    })();
    return () => { generation.current++; };
  }, [host.state, host.instanceId, configVersion]);
  const blocked = host.state !== 'ready' || busy || version === null;
  const verifiedNow = verified?.instanceId === host.instanceId && verified.baseUrl === draft.baseUrl && verified.inspection.available;
  async function inspect() {
    const ticket = generation.current; setBusy(true); setError(null); setMessage(null); setVerified(null);
    try {
      const result = await window.medclaw.request('model.intent.inspect', { baseUrl: draft.baseUrl, modelTag: draft.modelTag });
      if (ticket !== generation.current) return;
      if (!result.ok) { setError(errorMessage(result.error)); return; }
      setVerified({ instanceId: host.instanceId, baseUrl: draft.baseUrl, inspection: result.data });
      if (!result.data.available) { setError(result.data.error ? errorMessage(result.data.error) : 'The local intent model is unavailable.'); return; }
      setMessage('Local model tag and protocol metadata verified.');
    } catch { if (ticket === generation.current) setError('The local intent model could not be verified.'); }
    finally { if (ticket === generation.current) setBusy(false); }
  }
  async function apply() {
    if (blocked) return;
    const parsed = IntentModelConfigurationSchema.safeParse(draft);
    if (!parsed.success) { setError('Check the local URL, timeout and verification record. Enabled routing requires a verified model identity.'); return; }
    if (draft.enabled && !verifiedNow) { setError('Verify the local model before enabling or applying intent routing.'); return; }
    const ticket = generation.current; setBusy(true); setError(null); setMessage(null);
    try {
      const result = await window.medclaw.request('model.intent.configure', { expectedConfigVersion: version!, intentModel: parsed.data });
      if (ticket !== generation.current) return;
      if (!result.ok) { setError(errorMessage(result.error)); return; }
      setVersion(result.data.configVersion); setDraft(result.data.intentModel ?? { ...DEFAULT_INTENT_MODEL }); setMessage('Intent configuration applied.');
      await onChanged();
    } catch { if (ticket === generation.current) setError('The intent configuration could not be applied. Read the published configuration before trying again.'); }
    finally { if (ticket === generation.current) setBusy(false); }
  }
  const metadata = verified?.inspection.metadata;
  return <section className="panel" aria-labelledby="intent-model-title">
    <h2 id="intent-model-title">Intent model</h2>
    <p className="muted">Use the official local Ollama model for intent recognition. The main Agent model is selected separately.</p>
    <p>Official source: <a href={draft.sourceUrl}>{draft.sourceUrl}</a></p>
    <form onSubmit={event => { event.preventDefault(); void apply(); }}>
      <fieldset disabled={blocked}>
        <legend>Local model configuration</legend>
        <div className="form-grid">
          <label>Ollama URL<input value={draft.baseUrl} onChange={event => { setDraft(old => ({ ...old, baseUrl: event.target.value })); setVerified(null); }} /></label>
          <label>Model tag<input value={draft.modelTag} readOnly /></label>
          <label>Intent timeout (ms)<input type="number" min={1000} max={60000} step={1} value={draft.timeoutMs} onChange={event => setDraft(old => ({ ...old, timeoutMs: event.target.valueAsNumber }))} /></label>
          <label>Verification record<input maxLength={256} value={draft.verifiedEvidenceRef ?? ''} onChange={event => setDraft(old => ({ ...old, verifiedEvidenceRef: event.target.value || null }))} placeholder="Official source, identity and protocol evidence reference" /></label>
        </div>
        <label className="checkbox-label"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft(old => ({ ...old, enabled: event.target.checked }))} />Enable intent routing</label>
        <p className="muted">Verification reads local model metadata. It does not generate a response or download a model.</p>
        <div className="actions"><button type="button" onClick={() => void inspect()}>Verify local model</button><button type="submit" className="primary">Apply configuration</button></div>
      </fieldset>
    </form>
    <p>Selected model: <code>{draft.modelTag}</code></p>
    {verified && <p>Observed model: {verified.inspection.available ? draft.modelTag : 'Unavailable'} · {verified.inspection.checkedAt}</p>}
    {metadata && <p className="muted">Ollama {metadata.serviceVersion ?? 'Unknown'} · {metadata.family ?? 'Unknown family'} · {metadata.parameterSize ?? 'Unknown size'} · {metadata.quantization ?? 'Unknown quantization'}</p>}
    {busy && <p role="status">Reading or applying intent configuration…</p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
  </section>;
}

const blankModel = (): CustomModelDefinition => ({ id: "", name: "", input: ["text"], reasoning: false, contextWindow: 8192, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null });
const blankProvider = (): CustomProviderDefinition => ({ providerId: "", name: "", baseUrl: "", api: "", models: [blankModel()] });
const authLabels = { available: "Authentication available", unavailable: "Not authenticated", checking: "Checking", sync_unknown: "Credential sync unconfirmed" };
export type DirectoryReadStatus = { state: 'unread' | 'loading' | 'ready' | 'error'; error: string | null };

export function ModelsPage(props: { directory: ModelDirectoryView | null; directoryCurrent: boolean; directoryStatus?: DirectoryReadStatus; host: HostView; active: ActiveRunView | null; control: RuntimeControlView | null;
  sessionTarget: { instanceId: string; sessionId: number } | null; onUseForSession: (target: { instanceId: string; sessionId: number }, choice: ModelChoice) => void;
  prompt: AuthPromptView | null; notification: AuthNotifyView | null; attempt: AuthAttemptView | null; onChanged: () => Promise<void>; onAccepted: (value: ProviderAccepted) => Promise<void>; onError: (message: string | null) => void }) {
  const [search, setSearch] = useState("");
  const [providerId, setProvider] = useState("");
  const [choice, setChoice] = useState<{ provider: string; modelId: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshRef, setRefreshRef] = useState<string | null>(null);
  const [refreshResult, setRefreshResult] = useState<{ aborted: boolean; errors: { providerId: string; message: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [definitions, setDefinitions] = useState<CustomProviderDefinition[]>([]);
  const [definition, setDefinition] = useState(blankProvider);
  const [confirmed, setConfirmed] = useState<boolean[]>([false]);
  const [key, setKey] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [authProvider, setAuthProvider] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatusView | null>(null);
  const [answer, setAnswer] = useState("");
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const promptInput = useRef<HTMLInputElement | HTMLSelectElement>(null);
  const secretInput = useRef<HTMLInputElement>(null);
  const authInstance = useRef(props.host.instanceId);
  const directory = props.directory;
  const directoryStatus = props.directoryStatus ?? { state: directory ? 'ready' : 'unread', error: null };
  const catalogBlocked = props.host.state !== "ready" || !props.directoryCurrent || busy || !!refreshRef;
  const blocked = catalogBlocked || props.control?.acceptingNewRuns !== true;
  const attempt = props.attempt?.id === attemptId ? props.attempt : null;
  const prompt = props.prompt?.authAttemptId === attemptId ? props.prompt : null;
  const notification = props.notification?.authAttemptId === attemptId ? props.notification : null;
  const authRunning = !!attemptId && (!attempt || ["running", "waiting_input"].includes(attempt.state));
  const visible = directory?.models.filter(model => (!providerId || model.provider === providerId) && `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const selectedProvider = directory?.providers.find(provider => provider.id === providerId);
  useEffect(() => { if (props.host.state === "ready") void readDefinitions(); }, [props.host.state, directory?.configVersion]);
  useEffect(() => { if (authInstance.current !== props.host.instanceId) { authInstance.current = props.host.instanceId; setAttemptId(null); setAuthProvider(null); setAnswer(""); setCancelConfirm(false); } }, [props.host.instanceId]);
  useEffect(() => { setAnswer(prompt?.type === "select" ? prompt.options[0]?.id ?? "" : ""); if (prompt) promptInput.current?.focus(); }, [prompt?.promptId]);
  useEffect(() => () => { if (secretInput.current) secretInput.current.value = ""; }, []);
  async function readDefinitions() {
    const result = await window.medclaw.request("model.custom.read", {});
    if (result.ok) setDefinitions(result.data.definitions); else props.onError(errorMessage(result.error));
  }
  async function refresh() {
    const operationRef = crypto.randomUUID(); setRefreshRef(operationRef); setRefreshResult(null); setMessage(null);
    try {
      const result = await window.medclaw.request("model.refresh", providerId ? { providerId } : {}, operationRef);
      if (result.ok) { setRefreshResult({ aborted: result.data.aborted, errors: result.data.errors.map(item => ({ providerId: item.providerId, message: errorMessage(item.error) })) }); await props.onChanged(); }
      else props.onError(errorMessage(result.error));
    } finally { setRefreshRef(null); }
  }
  async function cancelRefresh() {
    if (!refreshRef) return;
    const result = await window.medclaw.request("operation.cancel", { operationRef: refreshRef });
    if (!result.ok) props.onError(errorMessage(result.error));
  }
  async function publish() {
    if (!choice || !directory) return;
    setBusy(true); setMessage(null);
    try {
      const result = await window.medclaw.request("model.configure", { ...choice, expectedConfigVersion: directory.configVersion });
      if (result.ok) { await props.onChanged(); setMessage("Default model published"); }
      else { props.onError(errorMessage(result.error)); await props.onChanged(); }
    } finally { setBusy(false); }
  }
  function useForSession() {
    if (!props.sessionTarget || !choice || !directory || catalogBlocked) return;
    const target = { ...props.sessionTarget }, selected = { ...choice, expectedConfigVersion: directory.configVersion };
    setMessage(null); props.onUseForSession(target, selected);
  }
  async function diagnose() {
    const selected = directory?.selection;
    if (!selected || !directory) return;
    setBusy(true);
    try {
      const date = new Date();
      const result = await window.medclaw.request("model.diagnose", { model: { provider: selected.provider, modelId: selected.modelId, expectedConfigVersion: directory.configVersion }, referenceDate: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }, crypto.randomUUID());
      if (result.ok) await props.onAccepted(result.data); else props.onError(errorMessage(result.error));
    } finally { setBusy(false); }
  }
  async function startAuth(type: "api_key" | "oauth") {
    if (!providerId) return;
    setBusy(true); setMessage(null); setCancelConfirm(false); setAuthProvider(providerId); setAuthStatus(null);
    const result = await window.medclaw.request("model.auth.start", { providerId, type });
    setBusy(false);
    if (result.ok) setAttemptId(result.data.authAttemptId); else props.onError(errorMessage(result.error));
  }
  async function checkAuth() {
    const id = authProvider ?? providerId; if (!id) return;
    const result = await window.medclaw.request("model.auth.status", { providerId: id, ...(attemptId ? { authAttemptId: attemptId } : {}) });
    if (result.ok) { setAuthStatus(result.data.auth); setMessage(`Authentication status: ${authLabels[result.data.auth.state]}`); await props.onChanged(); }
    else props.onError(errorMessage(result.error));
  }
  async function respond() {
    if (!prompt) return;
    const value = answer; setAnswer(""); if (promptInput.current instanceof HTMLInputElement) promptInput.current.value = "";
    const result = await window.medclaw.request("model.auth.respond", { authAttemptId: prompt.authAttemptId, promptId: prompt.promptId, value });
    if (!result.ok) props.onError(errorMessage(result.error));
  }
  async function cancelAuth() {
    if (!attemptId) return;
    setAnswer(""); setCancelConfirm(false);
    const result = await window.medclaw.request("model.auth.cancel", { authAttemptId: attemptId });
    if (!result.ok) props.onError(errorMessage(result.error));
    else setMessage(result.data.settled ? "Authentication cancelled" : "Cancelling authentication; waiting for confirmation");
  }
  async function openLink(url: string) { const result = await window.medclaw.openAuthLink(url); if (!result.ok) props.onError(errorMessage(result.error)); }
  function editDefinition(value: CustomProviderDefinition) { setDefinition(structuredClone(value)); setConfirmed(value.models.map(() => true)); setKey(""); setFieldError(null); setMessage(null); }
  function updateModel(index: number, patch: Partial<CustomModelDefinition>) { setDefinition(value => ({ ...value, models: value.models.map((model, position) => position === index ? { ...model, ...patch } : model) })); }
  async function saveCustom() {
    setMessage(null); setFieldError(null);
    if (confirmed.some(value => !value)) { setFieldError("Confirm that each output limit matches the service configuration."); return; }
    const parsed = CustomProviderDefinitionSchema.safeParse(definition);
    if (!parsed.success) { setFieldError(`Check the definition: ${parsed.error.issues.map(issue => `${issue.path.join(".")} ${issue.message}`).join("; ")}`); return; }
    if (!directory) return;
    setBusy(true); let token: string | undefined;
    const newKey = key; setKey(""); if (secretInput.current) secretInput.current.value = "";
    try {
      if (newKey) {
        const secret = await window.medclaw.secretInput({ providerId: definition.providerId, purpose: "custom_api_key", value: newKey });
        if (!secret.ok) { setFieldError(errorMessage(secret.error)); return; }
        token = secret.data.token;
      }
      const result = await window.medclaw.request("model.custom.save", { definition: parsed.data, expectedConfigVersion: directory.configVersion, ...(token ? { credentialInput: token } : {}) });
      if (result.ok) { setMessage("Custom definition published"); setDefinition(result.data.definition); await props.onChanged(); await readDefinitions(); }
      else { setFieldError(errorMessage(result.error)); await props.onChanged(); await readDefinitions(); }
    } catch { setFieldError("Save result unconfirmed. Read the published definition and directory."); }
    finally { if (token) { try { await window.medclaw.discardSecret(token); } catch { props.onError("Secret input cleanup unconfirmed. Read the published definition."); } } setBusy(false); }
  }
  return <div className="models-layout">
    <IntentModelSettings host={props.host} configVersion={directory?.configVersion} onChanged={props.onChanged} />
    <section className="panel directory-panel" aria-labelledby="directory-title">
      <div className="section-heading"><div><span className="eyebrow">Pi model directory</span><h2 id="directory-title">Browse and select models</h2></div></div>
      <p className="muted">Published: {directory?.selection ? `${directory.selection.provider} / ${directory.selection.modelId}` : "No model selected"}</p>
      {directoryStatus.state === 'loading' && <p role="status">Reading model directory…</p>}
      {directoryStatus.state === 'error' && <p role="status" className="error-text">Model directory read failed. {directoryStatus.error} Reload the published directory when Host is ready.</p>}
      {directory && !props.directoryCurrent && <p className="error-text" role="status">The directory has not been reverified. The last readable result is retained. Reload the published directory before sending or publishing.</p>}
      <div className="directory-toolbar"><label>Search models<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Provider, model name or ID" /></label><label>Provider<select aria-label="Provider" value={providerId} onChange={event => { setProvider(event.target.value); setAuthProvider(null); }}><option value="">All providers</option>{directory?.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.id}</option>)}</select></label></div>
      <div className="actions"><button disabled={blocked || authRunning} onClick={() => void refresh()}>{refreshRef ? "Refreshing…" : providerId ? "Refresh this provider" : "Refresh directory"}</button>{refreshRef && <button onClick={() => void cancelRefresh()}>Cancel refresh</button>}<button disabled={props.host.state !== "ready"} onClick={() => void props.onChanged()}>Reload published directory</button></div>
      {props.active && <p role="status" className="muted">Running Run {props.active.runId}. Authentication, custom saves and refreshes must wait until the run stops and is saved.</p>}
      {refreshResult && <div role="status"><p>{refreshResult.aborted ? "Refresh cancelled; readable directory retained" : refreshResult.errors.length ? "Some providers failed to refresh; readable directory retained" : "Directory refreshed"}</p>{refreshResult.errors.map(error => <p key={error.providerId} className="error-text">{error.providerId}: {error.message}</p>)}</div>}
      {!directory ? directoryStatus.state === 'unread' && <p role="status">The directory has not been read. Reload it when Host is ready.</p> : !visible.length ? directoryStatus.state === 'ready' && <p role="status">{directory.models.length ? "No models match your search" : "No models in the current directory"}</p> : <div className="model-list" aria-label="Model directory">{visible.map(model => {
        const provider = directory.providers.find(provider => provider.id === model.provider);
        const isChoice = choice?.provider === model.provider && choice.modelId === model.id;
        const published = directory.selection?.provider === model.provider && directory.selection.modelId === model.id;
        return <article key={`${model.provider}/${model.id}`} className={`model-row ${isChoice ? "chosen" : ""}`}><div className="model-heading"><strong>{model.name}</strong>{published && <span className="status-chip">Default model</span>}<button aria-label={`Select ${model.name}`} aria-pressed={isChoice} onClick={() => setChoice({ provider: model.provider, modelId: model.id })}>{isChoice ? "Selected" : "Select"}</button></div><code>{model.provider} / {model.id}</code><div className="model-metadata"><span>API {model.api}</span><span>{model.input.join(" + ")}{model.reasoning ? " · reasoning" : ""}</span><span>Context {model.contextWindow ?? "Unknown"} · Output limit {model.maxTokens ?? "Not provided"}</span><span>{model.capabilitySource}</span><span>{provider?.source} · {provider ? authLabels[provider.auth.state] : "Authentication status unknown"}</span></div></article>;
      })}</div>}
      <div className="selection-actions"><span className="muted">{choice ? `Selected model: ${choice.provider} / ${choice.modelId}` : "Select a model from the directory"}</span><p className="tiny muted">{props.sessionTarget ? `Current session target: Session ${props.sessionTarget.sessionId}` : "Confirm a session before selecting its model."}</p><div className="actions">
        <button disabled={!choice || !props.sessionTarget || catalogBlocked} onClick={useForSession}>Use for this session</button>
        <button className="primary" disabled={!choice || blocked || authRunning} onClick={() => void publish()}>Set as default model</button>
        <button disabled={blocked || !directory?.selection || authRunning} onClick={() => void diagnose()}>Test default model connection</button></div></div>
      {message && <p className="success-text" role="status">{message}</p>}
    </section>
    <section className="panel" aria-labelledby="auth-title"><div className="section-heading"><h2 id="auth-title">Provider authentication</h2><span className="muted">{selectedProvider?.name ?? "Select a provider first"}</span></div>{selectedProvider ? <><p>{authLabels[selectedProvider.auth.state]} · {selectedProvider.auth.type ?? "No credential type"} · Source {selectedProvider.auth.source ?? "Not provided"} · {selectedProvider.auth.checkKind}</p><div className="actions">{selectedProvider.loginTypes.map(type => <button key={type} disabled={blocked || authRunning} onClick={() => void startAuth(type)}>{type === "api_key" ? "Sign in with API Key" : "Sign in with OAuth"}</button>)}<button onClick={() => void checkAuth()}>Read authentication status</button></div>{!selectedProvider.loginTypes.length && <p className="muted">This provider uses environment or system credentials. Configure them at the source, then read authentication status.</p>}</> : <p className="muted">You can browse models without authentication. Sign-in methods are provided by the selected provider.</p>}
      {authStatus && <p role="status">{authStatus.providerId}: {authLabels[authStatus.state]} · {authStatus.checkKind} · {authStatus.checkedAt}</p>}
      {attemptId && <div className="auth-interaction" role="dialog" aria-label="Provider sign-in" onKeyDown={event => { if (event.key === "Escape" && authRunning) { event.preventDefault(); setCancelConfirm(true); } }}><p>Authentication attempt {attemptId} · {attempt?.state ?? "running"}</p>{attempt?.error && <p className="error-text">{errorMessage(attempt.error)}</p>}
        {notification?.type === "auth_url" && <><p><strong>Provider instructions</strong><br />{notification.instructions}</p><button onClick={() => void openLink(notification.url)}>Open sign-in link</button></>}
        {notification?.type === "device_code" && <><p>Device code: <strong>{notification.userCode}</strong></p><button onClick={() => void openLink(notification.verificationUri)}>Open device verification link</button>{notification.expiresInSeconds && <p className="muted">Expires in {notification.expiresInSeconds} seconds</p>}</>}
        {(notification?.type === "info" || notification?.type === "progress") && <><p role="status"><strong>Provider instructions</strong><br />{notification.message}</p>{notification.type === "info" && notification.links?.map(link => <button key={link.url} onClick={() => void openLink(link.url)}>{link.label ?? "Open authentication link"}</button>)}</>}
        {prompt && <form onSubmit={event => { event.preventDefault(); void respond(); }}><p className="tiny muted">Provider instructions</p><label>{prompt.message}{prompt.type === "select" ? <select ref={element => { promptInput.current = element; }} value={answer} onChange={event => setAnswer(event.target.value)}>{prompt.options.map(option => <option key={option.id} value={option.id}>{option.label}{option.description ? ` · ${option.description}` : ""}</option>)}</select> : <input ref={element => { promptInput.current = element; }} type={prompt.secret ? "password" : "text"} autoComplete="off" maxLength={4096} value={answer} onChange={event => setAnswer(event.target.value)} />}</label><button className="primary" type="submit">Submit authentication response</button></form>}
        {authRunning && <button onClick={() => setCancelConfirm(true)}>Cancel this authentication</button>}{cancelConfirm && <div className="confirmation" role="alertdialog" aria-label="Confirm authentication cancellation"><p>Cancel this sign-in and wait for authentication to finish?</p><button onClick={() => setCancelConfirm(false)}>Continue authentication</button><button className="danger" onClick={() => void cancelAuth()}>Confirm authentication cancellation</button></div>}
      </div>}
    </section>
    <section className="panel" aria-labelledby="custom-title"><div className="section-heading"><h2 id="custom-title">Custom providers and models</h2><button onClick={() => { setDefinition(blankProvider()); setConfirmed([false]); setKey(""); setFieldError(null); }}>New definition</button></div><p className="muted">Use a native API supported by the current SDK. Edit public definitions here; new keys are saved securely and separately.</p>
      <div className="custom-definitions">{definitions.map(item => <button key={item.providerId} onClick={() => editDefinition(item)}>Edit {item.name} · {item.providerId} · {item.models.length} models</button>)}</div>
      <form onSubmit={event => { event.preventDefault(); void saveCustom(); }} className="custom-form"><div className="form-grid"><label>Provider ID<input value={definition.providerId} maxLength={128} required onChange={event => setDefinition(value => ({ ...value, providerId: event.target.value }))} /></label><label>Provider name<input value={definition.name} maxLength={256} required onChange={event => setDefinition(value => ({ ...value, name: event.target.value }))} /></label><label>Base URL<input type="url" value={definition.baseUrl} required onChange={event => setDefinition(value => ({ ...value, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" /></label><label>Native API<select value={definition.api} required onChange={event => setDefinition(value => ({ ...value, api: event.target.value }))}><option value="">Select a current SDK API</option>{directory?.customApis.map(api => <option key={api} value={api}>{api}</option>)}</select></label></div>
        {definition.models.map((model, index) => <fieldset key={index}><legend>Model {index + 1}</legend><div className="form-grid"><label>Model ID<input required maxLength={256} value={model.id} onChange={event => updateModel(index, { id: event.target.value })} /></label><label>Model name<input required maxLength={256} value={model.name} onChange={event => updateModel(index, { name: event.target.value })} /></label><label>Context limit<input type="number" min="1" step="1" required value={model.contextWindow} onChange={event => updateModel(index, { contextWindow: Number(event.target.value) })} /></label><label>Output limit<input type="number" min="1" max={model.contextWindow} step="1" required value={model.maxTokens} onChange={event => { updateModel(index, { maxTokens: Number(event.target.value) }); setConfirmed(value => value.map((item, position) => position === index ? false : item)); }} /></label></div><div className="checkbox-row"><label><input type="checkbox" checked disabled />Text input</label><label><input type="checkbox" checked={model.input.includes("image")} onChange={event => updateModel(index, { input: event.target.checked ? ["text", "image"] : ["text"] })} />Image capability metadata</label><label><input type="checkbox" checked={model.reasoning} onChange={event => updateModel(index, { reasoning: event.target.checked })} />Reasoning</label><label><input type="checkbox" checked={confirmed[index] ?? false} onChange={event => setConfirmed(value => value.map((item, position) => position === index ? event.target.checked : item))} />Output limit matches the service configuration</label></div><label className="checkbox-label"><input type="checkbox" checked={model.pricingKnown} onChange={event => updateModel(index, { pricingKnown: event.target.checked, cost: event.target.checked ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : null })} />Known USD rates per million tokens</label>{model.cost && <div className="form-grid pricing-grid">{(["input", "output", "cacheRead", "cacheWrite"] as const).map(field => <label key={field}>{({ input: "Input rate", output: "Output rate", cacheRead: "Cache read rate", cacheWrite: "Cache write rate" })[field]}<input type="number" min="0" step="any" value={model.cost![field]} onChange={event => updateModel(index, { cost: { ...model.cost!, [field]: Number(event.target.value) } })} /></label>)}</div>}{definition.models.length > 1 && <button type="button" onClick={() => { setDefinition(value => ({ ...value, models: value.models.filter((_, position) => position !== index) })); setConfirmed(value => value.filter((_, position) => position !== index)); }}>Remove this draft model</button>}</fieldset>)}
        <button type="button" onClick={() => { setDefinition(value => ({ ...value, models: [...value.models, blankModel()] })); setConfirmed(value => [...value, false]); }}>Add model</button><label>New API Key<input ref={secretInput} type="password" autoComplete="off" maxLength={4096} value={key} onChange={event => setKey(event.target.value)} placeholder="Leave blank to keep current credentials; saved keys are not displayed" /></label>{fieldError && <p id="custom-error" role="alert" className="error-text">{fieldError}</p>}<div className="actions"><button className="primary" disabled={blocked || authRunning || !directory} type="submit">Save custom definition</button><button type="button" disabled={props.host.state !== "ready"} onClick={() => void readDefinitions()}>Read published definitions</button></div>
      </form>
    </section>
  </div>;
}
