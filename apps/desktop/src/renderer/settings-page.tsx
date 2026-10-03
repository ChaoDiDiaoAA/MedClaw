import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../../../packages/contracts/src/error";
import { type DesktopDisplayPreferences, type HostView } from "../../../../packages/contracts/src/model";
import { RUNTIME_CONFIG, type RuntimeConfiguration } from '../../../../packages/contracts/src/runtime-config';
import { TOOL_CONFIG, type ToolConfiguration } from '../../../../packages/contracts/src/tool-config';
import type { PublicReturn } from "../../../../packages/contracts/src/protocol";
import { Diagnostics } from "./diagnostics";
import { hostLabel } from "./sidebar";

const budgetLabels: Record<keyof RuntimeConfiguration['runBudget'], string> = {
  maxToolCalls: 'Tool call budget',
  maxModelCalls: 'Model call budget',
  timeoutMs: 'Run timeout (milliseconds)',
  singleToolTimeoutMs: 'Tool timeout (milliseconds)',
  maxRecoveryAttempts: 'Recovery round budget',
};

export function SettingsPage(props: { ui: DesktopDisplayPreferences; host: HostView; configVersion: string; onUi: (patch: Partial<DesktopDisplayPreferences>) => Promise<boolean>; onChanged: () => Promise<void>; onError: (message: string | null) => void; onHost: (host: HostView) => void }) {
  const [draft, setDraft] = useState(props.ui);
  const [runtimeConfiguration, setRuntimeConfiguration] = useState<RuntimeConfiguration>(() => structuredClone(RUNTIME_CONFIG));
  const [toolConfiguration, setToolConfiguration] = useState<ToolConfiguration>(() => structuredClone(TOOL_CONFIG));
  const [config, setConfig] = useState<PublicReturn<"model.config.read"> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rollbackConfirm, setRollbackConfirm] = useState(false);
  const uiDirty = useRef(false);
  const policyDirty = useRef(false);
  useEffect(() => { if (!uiDirty.current) setDraft(props.ui); }, [props.ui]);
  useEffect(() => { void readConfig(); }, [props.configVersion, props.host.state]);
  async function readConfig() {
    const result = await window.medclaw.request("model.config.read", {});
    if (result.ok) { setConfig(result.data); if (!policyDirty.current) { setRuntimeConfiguration(result.data.runtimeConfiguration); setToolConfiguration(result.data.toolConfiguration); } }
    else props.onError(errorMessage(result.error));
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
  async function control(action: "start" | "stop" | "restart") {
    setBusy(true); setMessage(null);
    const result = action === "start" ? await window.medclaw.request("host.start", {}) : props.host.instanceId ? await window.medclaw.request(action === "stop" ? "host.stop" : "host.restart", { expectedInstanceId: props.host.instanceId }) : null;
    if (result?.ok) props.onHost(result.data); else if (result && !result.ok) props.onError(errorMessage(result.error));
    setBusy(false);
  }
  return <div className="settings-layout">
    {message && <p className="success-text" role="status">{message}</p>}
    <section className="panel"><div className="section-heading"><h2>Display preferences</h2></div><p className="muted">You can save these preferences when Host is unavailable. Form drafts and published values are retained separately.</p><div className="checkbox-row"><label><input type="checkbox" checked={draft.navCollapsed} onChange={event => { uiDirty.current = true; setDraft(value => ({ ...value, navCollapsed: event.target.checked })); }} />Collapse navigation</label><label><input type="checkbox" checked={draft.detailOpen} onChange={event => { uiDirty.current = true; setDraft(value => ({ ...value, detailOpen: event.target.checked })); }} />Open run details</label></div><label>Default details tab<select value={draft.detailTab} onChange={event => { uiDirty.current = true; setDraft(value => ({ ...value, detailTab: event.target.value as DesktopDisplayPreferences["detailTab"] })); }}><option value="conditions">Conditions</option><option value="runtime">Run details</option></select></label><p className="tiny muted">Published: navigation {props.ui.navCollapsed ? "collapsed" : "expanded"}, details {props.ui.detailOpen ? "open" : "closed"}, tab {props.ui.detailTab}</p><button className="primary" disabled={busy} onClick={() => void saveUi()}>Save display preferences</button></section>
    <section className="panel"><div className="section-heading"><h2>Model request policy</h2><button onClick={() => void readConfig()}>Reload published configuration</button></div><p className="muted">Active runs keep their frozen configuration. Published changes apply to new runs.</p><form onSubmit={event => { event.preventDefault(); void savePolicy(); }}>
      <fieldset><legend>RunBudget</legend><div className="form-grid">{(Object.keys(budgetLabels) as (keyof RuntimeConfiguration['runBudget'])[]).map(key => <label key={key}>{budgetLabels[key]}<input type="number" min={key === 'timeoutMs' ? 1000 : key === 'maxRecoveryAttempts' ? 0 : 1} max={Number.MAX_SAFE_INTEGER} step="1" required value={runtimeConfiguration.runBudget[key]} onChange={event => editBudget(key, Number(event.target.value))} /></label>)}</div></fieldset>
      <fieldset><legend>LLM request</legend><div className="form-grid"><label>Native retries<select value={runtimeConfiguration.llm.maxRetries} onChange={event => { policyDirty.current = true; setRuntimeConfiguration(current => ({ ...current, llm: { ...current.llm, maxRetries: Number(event.target.value) as 0 | 1 } })); }}><option value="0">0</option><option value="1">1</option></select></label><label>Server retry delay limit (milliseconds)<input type="number" min="1" max="5000" step="1" required value={runtimeConfiguration.llm.maxRetryDelayMs} onChange={event => { policyDirty.current = true; setRuntimeConfiguration(current => ({ ...current, llm: { ...current.llm, maxRetryDelayMs: Number(event.target.value) } })); }} /></label></div></fieldset>
      <fieldset><legend>Tool result</legend><label>Result text limit (UTF-8 bytes)<input type="number" min="1024" max={Number.MAX_SAFE_INTEGER} step="1" required value={toolConfiguration.maxResultBytes} onChange={event => { policyDirty.current = true; setToolConfiguration({ maxResultBytes: Number(event.target.value) }); }} /></label></fieldset>
      <p className="tiny muted">Tool attempts include SDK parameter rejections. Recovery rounds share the same Run budget. Each Run saves its accepted configuration.</p><button className="primary" type="submit" disabled={busy || props.host.state !== "ready" || !config}>Publish request policy</button></form></section>
    <section className="panel"><h2>Previous configuration</h2><p>{config ? config.previousConfigVersion ? "Previous configuration available for rollback" : "No configuration available for rollback" : "Reading configuration"}</p><p className="muted">Verify the previous models, definitions and credentials before publishing a rollback. Saved runs keep their original configuration.</p><button disabled={busy || props.host.state !== "ready" || !config?.previousConfigVersion} onClick={() => setRollbackConfirm(true)}>Roll back to previous configuration</button>{rollbackConfirm && <div className="confirmation" role="alertdialog" aria-label="Confirm configuration rollback"><p>Verify the previous configuration and publish a rollback?</p><button onClick={() => setRollbackConfirm(false)}>Keep current configuration</button><button className="danger" onClick={() => void rollback()}>Confirm rollback publication</button></div>}</section>
    <section className="panel"><div className="section-heading"><h2>Host</h2><span>{hostLabel(props.host)}</span></div><p className="muted">Instance {props.host.instanceId ?? "None"}</p>{props.host.error && <p role="alert" className="error-text">{errorMessage(props.host.error)}</p>}<div className="actions"><button disabled={busy || !props.host.canStart} onClick={() => void control("start")}>Start Host</button><button disabled={busy || !props.host.instanceId || ["stopped", "stopping"].includes(props.host.state)} onClick={() => void control("stop")}>Stop Host</button><button disabled={busy || !props.host.instanceId || props.host.state !== "ready"} onClick={() => void control("restart")}>Restart Host</button></div></section>
    <Diagnostics onError={props.onError} />
  </div>;
}
