import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../../../../packages/contracts/src/error";
import { type DesktopDisplayPreferences, type HostView } from "../../../../packages/contracts/src/model";
import { RUNTIME_CONFIG, type RuntimeConfiguration } from '../../../../packages/contracts/src/runtime-config';
import { TOOL_CONFIG, type ToolConfiguration } from '../../../../packages/contracts/src/tool-config';
import type { PublicReturn } from "../../../../packages/contracts/src/protocol";
import { Diagnostics } from "./diagnostics";
import { hostLabel } from "./sidebar";
import type { MaintenanceSelection, BackupReceipt, RestoreReceipt } from '@medclaw/contracts/maintenance';

const budgetLabels: Record<keyof RuntimeConfiguration['runBudget'], string> = {
  maxToolCalls: 'Tool call budget',
  maxModelCalls: 'Model call budget',
  timeoutMs: 'Run timeout (milliseconds)',
  singleToolTimeoutMs: 'Tool timeout (milliseconds)',
  maxRecoveryAttempts: 'Recovery round budget',
};
type PendingMaintenance = { kind: 'create' | 'restore'; operationRef: string; selection: MaintenanceSelection };

export function SettingsPage(props: { sessionTools?: (visible: boolean) => ReactNode; businessPrompt?: ReactNode; businessPromptNotice?: string | null; executionBlockReason?:string|null;ui: DesktopDisplayPreferences; uiAvailable: boolean; onReadUi: () => Promise<void>; host: HostView; configVersion: string; onUi: (patch: Partial<DesktopDisplayPreferences>) => Promise<boolean>; onChanged: () => Promise<void>; onError: (message: string | null) => void; onHost: (host: HostView) => void }) {
  const [task, setTask] = useState<'general' | 'runtime' | 'backup' | 'support' | 'business'>('general');
  const [runtimeEditor, setRuntimeEditor] = useState<'policy' | 'rollback' | null>(null);
  const [configState, setConfigState] = useState<'unread' | 'loading' | 'ready' | 'error'>('unread');
  const maintenanceUnavailable = props.host.error?.reason === 'desktop_bootstrap_failed';
  const [draft, setDraft] = useState(props.ui);
  const [runtimeConfiguration, setRuntimeConfiguration] = useState<RuntimeConfiguration>(() => structuredClone(RUNTIME_CONFIG));
  const [toolConfiguration, setToolConfiguration] = useState<ToolConfiguration>(() => structuredClone(TOOL_CONFIG));
  const [config, setConfig] = useState<PublicReturn<"model.config.read"> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rollbackConfirm, setRollbackConfirm] = useState(false);
  const [pendingMaintenance, setPendingMaintenance] = useState<PendingMaintenance | null>(null), pendingMaintenanceRef = useRef<PendingMaintenance | null>(null);
  const [maintenanceReceipt, setMaintenanceReceipt] = useState<BackupReceipt | RestoreReceipt | null>(null);
  const [maintenanceAttempt, setMaintenanceAttempt] = useState<string | null>(null);
  const uiDirty = useRef(false);
  const policyDirty = useRef(false);
  useEffect(() => { if (!uiDirty.current) setDraft(props.ui); }, [props.ui]);
  useEffect(() => { void readConfig(); }, [props.configVersion, props.host.state]);
  async function readConfig() {
    setConfigState('loading');
    try {
      const result = await window.medclaw.request("model.config.read", {});
      if (result.ok) { setConfigState('ready'); setConfig(result.data); if (!policyDirty.current) { setRuntimeConfiguration(result.data.runtimeConfiguration); setToolConfiguration(result.data.toolConfiguration); } }
      else { setConfigState('error'); props.onError(errorMessage(result.error)); }
    } catch { setConfigState('error'); props.onError('Published configuration could not be read. Read it again before editing runtime settings.'); }
  }
  async function saveUi() { setBusy(true); const saved = await props.onUi(draft); if (saved) { uiDirty.current = false; setMessage("Display preferences published"); } setBusy(false); }
  async function savePolicy() {
    if (!config) return; setBusy(true); setMessage(null);
    const result = await window.medclaw.request("model.policy.update", { expectedConfigVersion: config.configVersion, runtimeConfiguration, toolConfiguration });
    if (result.ok) { policyDirty.current = false; setMessage("Request policy published; applies to the next run"); await props.onChanged(); }
    else { props.onError(errorMessage(result.error)); await readConfig(); }
    setBusy(false);
  }
  function editBudget(key: keyof RuntimeConfiguration['runBudget'], value: number) {
    policyDirty.current = true;
    setRuntimeConfiguration(current => ({ ...current, runBudget: { ...current.runBudget, [key]: value } }));
  }
  async function rollback() {
    if (!config?.previousConfigVersion) return; setBusy(true); setRollbackConfirm(false);
    const result = await window.medclaw.request("model.config.rollback", { expectedConfigVersion: config.configVersion, targetConfigVersion: config.previousConfigVersion });
    if (result.ok) { policyDirty.current = false; uiDirty.current = false; setMessage("Rollback configuration published"); await props.onChanged(); await readConfig(); }
    else { props.onError(errorMessage(result.error)); await readConfig(); }
    setBusy(false);
  }
  async function control(action: "start" | "stop" | "restart" | 'read' | 'prepareRecovery') {
    if(action==='restart'&&props.executionBlockReason){props.onError(props.executionBlockReason);return;}
    setBusy(true); setMessage(null);
    const result = action === 'read' ? await window.medclaw.request('host.read', {}) : action === 'prepareRecovery' ? await window.medclaw.request('host.prepareRecovery', {})
      : action === "start" ? await window.medclaw.request("host.start", {}) : props.host.instanceId ? await window.medclaw.request(action === "stop" ? "host.stop" : "host.restart", { expectedInstanceId: props.host.instanceId }) : null;
    if (result?.ok) props.onHost(result.data); else if (result && !result.ok) props.onError(errorMessage(result.error));
    if (result?.ok && action === 'prepareRecovery') setMessage('Recovery observation saved. Restart Windows, reopen MedClaw, and read Host status.');
    setBusy(false);
  }
  async function discardPendingMaintenance(): Promise<boolean> {
    const pending = pendingMaintenanceRef.current; if (!pending) return true;
    pendingMaintenanceRef.current = null;
    const result = await window.medclaw.request('maintenance.discardSelection', {}, pending.operationRef);
    if (result.ok) { setPendingMaintenance(null); return true; }
    pendingMaintenanceRef.current = pending; props.onError(errorMessage(result.error)); return false;
  }
  async function cancelMaintenance() {
    if (busy || !pendingMaintenanceRef.current) return;
    setBusy(true); props.onError(null);
    try { if (await discardPendingMaintenance()) setMessage('Selection cancelled.'); } finally { setBusy(false); }
  }
  async function chooseMaintenance(kind: 'create' | 'restore') {
    if (busy) return;
    setBusy(true); setMessage(null); props.onError(null);
    try {
      if (!await discardPendingMaintenance()) return;
      const operationRef = crypto.randomUUID(), result = await window.medclaw.request('backup.select', { purpose: kind }, operationRef);
      if (!result.ok) props.onError(errorMessage(result.error));
      else if (result.data) { const pending = { kind, operationRef, selection: result.data }; pendingMaintenanceRef.current = pending; setPendingMaintenance(pending); }
    } finally { setBusy(false); }
  }
  async function confirmMaintenance() {
    if (!pendingMaintenanceRef.current || busy) return;
    const { kind, selection, operationRef } = pendingMaintenanceRef.current;
    if (kind === 'create' ? !selection.destinationToken : !selection.sourceToken || !selection.targetRootToken) return;
    pendingMaintenanceRef.current = null;
    setBusy(true); setPendingMaintenance(null); setMaintenanceAttempt(operationRef); setMaintenanceReceipt(null); setMessage(null); props.onError(null);
    try {
      const result = kind === 'create' ? await window.medclaw.request('backup.create', { destinationToken: selection.destinationToken! }, operationRef)
        : await window.medclaw.request('backup.restore', { sourceToken: selection.sourceToken!, targetRootToken: selection.targetRootToken! }, operationRef);
      if (result.ok) {
        setMaintenanceReceipt(result.data); setMaintenanceAttempt(null);
        setMessage(kind === 'create' ? 'Backup completed. Host remains stopped.' : 'Data restored. Reopen the application to use the restored data.');
      } else { props.onError(errorMessage(result.error)); setMessage('Completion was not confirmed. Select the result directory to read the original receipt.'); }
      const current = await window.medclaw.request('host.read', {}); if (current.ok) props.onHost(current.data);
    } finally { setBusy(false); }
  }
  async function readMaintenanceResult() {
    if (busy) return;
    setBusy(true); setMessage(null); props.onError(null);
    try {
      if (!await discardPendingMaintenance()) return;
      const chosen = await window.medclaw.request('backup.select', { purpose: 'read' }, crypto.randomUUID());
      if (!chosen.ok) { props.onError(errorMessage(chosen.error)); return; }
      if (!chosen.data) return;
      const { resultToken, originalKind, originalOperationRef } = chosen.data;
      if (!resultToken || !originalKind || !originalOperationRef) { props.onError('The selected result could not be verified.'); return; }
      const result = await window.medclaw.request('backup.read', { resultToken, kind: originalKind }, originalOperationRef);
      if (!result.ok) props.onError(errorMessage(result.error));
      else if (!result.data) setMessage('No completed receipt was found for the original operation.');
      else { setMaintenanceReceipt(result.data); setMaintenanceAttempt(null); setMessage('Original completion receipt found. Read Host status to check the current application.'); }
    } finally { setBusy(false); }
  }
  return <div className="settings-layout task-page">
    <nav className="task-nav" aria-label="Settings tasks">
      <button aria-pressed={task === 'general'} onClick={() => setTask('general')}>General</button>
      <button aria-pressed={task === 'runtime'} onClick={() => setTask('runtime')}>Runtime</button>
      <button aria-pressed={task === 'backup'} onClick={() => setTask('backup')}>Backup and restore</button>
      <button aria-pressed={task === 'support'} onClick={() => setTask('support')}>Support</button>
      {props.businessPrompt && <button aria-pressed={task === 'business'} onClick={() => setTask('business')}>Business prompt</button>}
    </nav>
    {task !== 'business' && props.businessPromptNotice && <p className="error-text" role="alert">{props.businessPromptNotice}</p>}
    {message && <p className="success-text" role="status">{message}</p>}
    {props.host.error && <p role="alert" className="error-text">{errorMessage(props.host.error)}</p>}
    {props.executionBlockReason && <p role="status">{props.executionBlockReason}</p>}
    {uiDirty.current && <p className="tiny" role="status">Display preferences have unsaved changes.</p>}
    {policyDirty.current && <p className="tiny" role="status">Request policy has unsaved changes.</p>}
    {!props.uiAvailable && <p role="status">Saved display preferences are not confirmed. Draft values have not been published.</p>}
    <section className="task-surface" hidden={task !== 'general'}>
      <div className="settings-host-row"><div><strong>Host</strong><span className="muted">{hostLabel(props.host)}</span></div><div className="actions"><button disabled={busy} onClick={() => void control('read')}>Read Host status</button><button disabled={busy || !props.host.canStart} onClick={() => void control('start')}>Start Host</button></div></div>
      <div className="section-heading"><h2>Display preferences</h2><button disabled={busy} onClick={() => void props.onReadUi()}>Read saved display preferences</button></div>
      <div className="checkbox-row"><label><input type="checkbox" checked={draft.navCollapsed} onChange={event => { uiDirty.current = true; setDraft(value => ({ ...value, navCollapsed: event.target.checked })); }} />Collapse navigation</label><label><input type="checkbox" checked={draft.detailOpen} onChange={event => { uiDirty.current = true; setDraft(value => ({ ...value, detailOpen: event.target.checked })); }} />Open run details</label></div>
      <label>Default details tab<select value={draft.detailTab} onChange={event => { uiDirty.current = true; setDraft(value => ({ ...value, detailTab: event.target.value as DesktopDisplayPreferences["detailTab"] })); }}><option value="conditions">Conditions</option><option value="runtime">Run details</option></select></label>
      {props.uiAvailable && <details className="advanced-section"><summary>Saved display details</summary><p className="tiny muted">Published: navigation {props.ui.navCollapsed ? "collapsed" : "expanded"}, details {props.ui.detailOpen ? "open" : "closed"}, tab {props.ui.detailTab}</p><p className="muted">You can save these preferences when Host is unavailable. Form drafts and published values are retained separately.</p></details>}
      <button className="primary" disabled={busy || !props.uiAvailable} onClick={() => void saveUi()}>Save display preferences</button>
    </section>
    <section className="task-surface" hidden={task !== 'runtime'}>
      <div className="section-heading"><h2>Host</h2><span>{hostLabel(props.host)}</span></div><div className="actions"><button disabled={busy || !props.host.canStart} onClick={() => void control("start")}>Start Host</button><button disabled={busy || !props.host.instanceId || ["stopped", "stopping"].includes(props.host.state)} onClick={() => void control("stop")}>Stop Host</button><button disabled={!!props.executionBlockReason || busy || !props.host.instanceId || props.host.state !== "ready"} onClick={() => void control("restart")}>Restart Host</button><button disabled={busy} onClick={() => void control('read')}>Read Host status</button>{props.host.canPrepareRecovery && <button disabled={busy} onClick={() => void control('prepareRecovery')}>Prepare restart recovery</button>}</div><details className="advanced-section"><summary>Host connection details</summary><p className="muted">Instance {props.host.instanceId ?? "None"}</p></details>
      <div className="settings-task-links"><button aria-expanded={runtimeEditor === 'policy'} onClick={() => setRuntimeEditor(value => value === 'policy' ? null : 'policy')}>Edit request policy</button><button aria-expanded={runtimeEditor === 'rollback'} onClick={() => setRuntimeEditor(value => value === 'rollback' ? null : 'rollback')}>Previous configuration</button></div>
      {configState === 'loading' && <p role="status">Reading published configuration…</p>}
      {configState === 'error' && <p role="status" className="error-text">Published configuration is unavailable. Retaining any previously read values.</p>}
      <div className="workspace-tool" hidden={runtimeEditor !== 'policy'}><div className="section-heading"><h2>Model request policy</h2><button onClick={() => void readConfig()}>Reload published configuration</button></div><p className="muted">Active runs keep their frozen configuration. Published changes apply to new runs.</p><form hidden={!config} onSubmit={event => { event.preventDefault(); void savePolicy(); }}>
      <fieldset><legend>RunBudget</legend><div className="form-grid">{(Object.keys(budgetLabels) as (keyof RuntimeConfiguration['runBudget'])[]).map(key => <label key={key}>{budgetLabels[key]}<input type="number" min={key === 'timeoutMs' ? 1000 : key === 'maxRecoveryAttempts' ? 0 : 1} max={Number.MAX_SAFE_INTEGER} step="1" required value={runtimeConfiguration.runBudget[key]} onChange={event => editBudget(key, Number(event.target.value))} /></label>)}</div></fieldset>
      <fieldset><legend>LLM request</legend><div className="form-grid"><label>Native retries<select value={runtimeConfiguration.llm.maxRetries} onChange={event => { policyDirty.current = true; setRuntimeConfiguration(current => ({ ...current, llm: { ...current.llm, maxRetries: Number(event.target.value) as 0 | 1 } })); }}><option value="0">0</option><option value="1">1</option></select></label><label>Server retry delay limit (milliseconds)<input type="number" min="1" max="5000" step="1" required value={runtimeConfiguration.llm.maxRetryDelayMs} onChange={event => { policyDirty.current = true; setRuntimeConfiguration(current => ({ ...current, llm: { ...current.llm, maxRetryDelayMs: Number(event.target.value) } })); }} /></label></div></fieldset>
      <fieldset><legend>Tool result</legend><label>Result text limit (UTF-8 bytes)<input type="number" min="1024" max={Number.MAX_SAFE_INTEGER} step="1" required value={toolConfiguration.maxResultBytes} onChange={event => { policyDirty.current = true; setToolConfiguration({ maxResultBytes: Number(event.target.value) }); }} /></label></fieldset>
      <p className="tiny muted">Tool attempts include SDK parameter rejections. Recovery rounds share the same Run budget. Each Run saves its accepted configuration.</p><button className="primary" type="submit" disabled={busy || props.host.state !== "ready" || !config}>Publish request policy</button></form></div>
      <div className="workspace-tool" hidden={runtimeEditor !== 'rollback'}><h2>Previous configuration</h2><p>{config ? config.previousConfigVersion ? "Previous configuration available for rollback" : "No configuration available for rollback" : configState === 'loading' ? "Reading configuration" : "Configuration unavailable"}</p><p className="muted">Verify the previous models, definitions and credentials before publishing a rollback. Saved runs keep their original configuration.</p><button disabled={busy || props.host.state !== "ready" || !config?.previousConfigVersion} onClick={() => setRollbackConfirm(true)}>Roll back to previous configuration</button></div>
    </section>
    {props.sessionTools && <section className="task-surface" hidden={task !== 'runtime'} aria-label="Current session tools"><h2>Current session tools</h2>{props.sessionTools(task === 'runtime')}</section>}
    {rollbackConfirm && <div className="confirmation" role="alertdialog" aria-label="Confirm configuration rollback"><p>Verify the previous configuration and publish a rollback?</p><button onClick={() => setRollbackConfirm(false)}>Keep current configuration</button><button className="danger" onClick={() => void rollback()}>Confirm rollback publication</button></div>}
    <section className="task-surface" hidden={task !== 'backup'} aria-labelledby="maintenance-title">
      <h2 id="maintenance-title">Backup and restore</h2>
      <p className="muted">Backup requires an idle Host with all changes saved and leaves it stopped. Restore creates a separate data folder and keeps your current data. Model credentials must be configured again.</p>
      <div className="actions"><button disabled={busy || maintenanceUnavailable} onClick={() => void chooseMaintenance('create')}>Choose backup destination</button><button disabled={busy || maintenanceUnavailable} onClick={() => void chooseMaintenance('restore')}>Choose backup to restore</button><button disabled={busy || maintenanceUnavailable} onClick={() => void readMaintenanceResult()}>Read original result</button></div>
    </section>
      {pendingMaintenance && <div className="confirmation" role="alertdialog" aria-label={pendingMaintenance.kind === 'create' ? 'Confirm data backup' : 'Confirm data restore'}>
        <p>{pendingMaintenance.kind === 'create' ? `Create a new backup in ${pendingMaintenance.selection.destinationLabel}?` : `Restore ${pendingMaintenance.selection.sourceLabel} into the new folder ${pendingMaintenance.selection.targetRootLabel}?`}</p>
        {pendingMaintenance.kind === 'restore' && <p>Current data will be retained. You will need to configure model credentials again and explicitly start new queries.</p>}
        <button disabled={busy} onClick={() => void cancelMaintenance()}>{pendingMaintenance.kind === 'create' ? 'Keep working' : 'Keep current data'}</button>
        <button className="primary" disabled={busy || !!props.executionBlockReason} onClick={() => void confirmMaintenance()}>{pendingMaintenance.kind === 'create' ? 'Confirm backup' : 'Confirm restore'}</button>
      </div>}
      {maintenanceAttempt && <p role="status">Operation to check: {maintenanceAttempt}</p>}
      {maintenanceReceipt && <div role="status"><p>{maintenanceReceipt.kind === 'create' ? 'Backup' : 'Restore'} completion receipt</p><details className="advanced-section"><summary>Backup receipt details</summary><p>App {maintenanceReceipt.appVersion}</p><p>Original operation: {maintenanceReceipt.operationRef}</p></details></div>}
    <Diagnostics visible={task === 'support'} onError={props.onError} exportAvailable={!maintenanceUnavailable} />
    <section className="task-surface" aria-label="Business prompt" hidden={task !== 'business'}>{props.businessPrompt}</section>
  </div>;
}
