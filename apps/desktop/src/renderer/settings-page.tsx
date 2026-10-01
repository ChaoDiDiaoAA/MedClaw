import { useEffect, useRef, useState } from "react";
import { DEFAULT_REQUEST_POLICY, type DesktopDisplayPreferences, type HostView, type RequestPolicy } from "../../../../packages/contracts/src/model";
import type { PublicReturn } from "../../../../packages/contracts/src/protocol";
import { Diagnostics } from "./diagnostics";
import { hostLabel } from "./sidebar";

export function SettingsPage(props: { ui: DesktopDisplayPreferences; host: HostView; configVersion: string; onUi: (patch: Partial<DesktopDisplayPreferences>) => Promise<boolean>; onChanged: () => Promise<void>; onError: (message: string | null) => void; onHost: (host: HostView) => void }) {
  const [draft, setDraft] = useState(props.ui);
  const [policy, setPolicy] = useState<RequestPolicy>({ ...DEFAULT_REQUEST_POLICY });
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
    if (result.ok) { setConfig(result.data); if (!policyDirty.current) setPolicy(result.data.policy); }
    else props.onError(result.error.message);
  }
  async function saveUi() { setBusy(true); const saved = await props.onUi(draft); if (saved) { uiDirty.current = false; setMessage("显示偏好已发布"); } setBusy(false); }
  async function savePolicy() {
    if (!config) return; setBusy(true); setMessage(null);
    const result = await window.medclaw.request("model.policy.update", { expectedConfigVersion: config.configVersion, policy });
    if (result.ok) { policyDirty.current = false; setMessage("请求政策已发布，下次运行生效"); await props.onChanged(); }
    else { props.onError(result.error.message); await readConfig(); }
    setBusy(false);
  }
  async function rollback() {
    if (!config?.previousConfigVersion) return; setBusy(true); setRollbackConfirm(false);
    const result = await window.medclaw.request("model.config.rollback", { expectedConfigVersion: config.configVersion, targetConfigVersion: config.previousConfigVersion });
    if (result.ok) { policyDirty.current = false; uiDirty.current = false; setMessage("回退配置已发布"); await props.onChanged(); await readConfig(); }
    else { props.onError(result.error.message); await readConfig(); }
    setBusy(false);
  }
  async function control(action: "start" | "stop" | "restart") {
    setBusy(true); setMessage(null);
    const result = action === "start" ? await window.medclaw.request("host.start", {}) : props.host.instanceId ? await window.medclaw.request(action === "stop" ? "host.stop" : "host.restart", { expectedInstanceId: props.host.instanceId }) : null;
    if (result?.ok) props.onHost(result.data); else if (result && !result.ok) props.onError(result.error.message);
    setBusy(false);
  }
  return <div className="settings-layout">
    {message && <p className="success-text" role="status">{message}</p>}
    <section className="panel"><div className="section-heading"><h2>显示偏好</h2></div><p className="muted">Host 不可用时仍可保存。表单草稿与已发布值分别保留。</p><div className="checkbox-row"><label><input type="checkbox" checked={draft.navCollapsed} onChange={event => { uiDirty.current = true; setDraft(value => ({ ...value, navCollapsed: event.target.checked })); }} />折叠导航</label><label><input type="checkbox" checked={draft.detailOpen} onChange={event => { uiDirty.current = true; setDraft(value => ({ ...value, detailOpen: event.target.checked })); }} />打开运行详情</label></div><label>默认详情页签<select value={draft.detailTab} onChange={event => { uiDirty.current = true; setDraft(value => ({ ...value, detailTab: event.target.value as DesktopDisplayPreferences["detailTab"] })); }}><option value="conditions">执行条件</option><option value="runtime">运行详情</option></select></label><p className="tiny muted">当前已发布：导航{props.ui.navCollapsed ? "折叠" : "展开"}，详情{props.ui.detailOpen ? "打开" : "关闭"}，页签 {props.ui.detailTab}</p><button className="primary" disabled={busy} onClick={() => void saveUi()}>保存显示偏好</button></section>
    <section className="panel"><div className="section-heading"><h2>模型请求政策</h2><button onClick={() => void readConfig()}>重读已发布配置</button></div><p className="muted">活动 Run 保留其冻结政策。SDK 不支持的重试配置会在发送前明确拒绝。</p><form onSubmit={event => { event.preventDefault(); void savePolicy(); }}><div className="form-grid"><label>Run 总期限（毫秒）<input type="number" min="1000" max="300000" step="1" value={policy.timeoutMs} onChange={event => { policyDirty.current = true; setPolicy(value => ({ ...value, timeoutMs: Number(event.target.value) })); }} /></label><label>原生重试次数<select value={policy.maxRetries} onChange={event => { policyDirty.current = true; setPolicy(value => ({ ...value, maxRetries: Number(event.target.value) as 0 | 1 })); }}><option value="0">0</option><option value="1">1</option></select></label><label>服务端建议等待上限（毫秒）<input type="number" min="1" max="5000" step="1" value={policy.maxRetryDelayMs} onChange={event => { policyDirty.current = true; setPolicy(value => ({ ...value, maxRetryDelayMs: Number(event.target.value) })); }} /></label></div><button className="primary" type="submit" disabled={busy || props.host.state !== "ready" || !config}>发布请求政策</button></form></section>
    <section className="panel"><h2>上一版配置</h2><p>{config ? config.previousConfigVersion ? "已保存可回退的上一版配置" : "尚无可回退配置" : "正在读取配置"}</p><p className="muted">核验旧模型、定义和凭据后发布回退配置。已保存的 Run 保留原配置。</p><button disabled={busy || props.host.state !== "ready" || !config?.previousConfigVersion} onClick={() => setRollbackConfirm(true)}>回退到上一版配置</button>{rollbackConfirm && <div className="confirmation" role="alertdialog" aria-label="确认配置回退"><p>核验上一版配置并发布回退？</p><button onClick={() => setRollbackConfirm(false)}>保留当前配置</button><button className="danger" onClick={() => void rollback()}>确认发布回退</button></div>}</section>
    <section className="panel"><div className="section-heading"><h2>Host</h2><span>{hostLabel(props.host)}</span></div><p className="muted">实例 {props.host.instanceId ?? "无"}</p>{props.host.error && <p role="alert" className="error-text">{props.host.error.message}</p>}<div className="actions"><button disabled={busy || !props.host.canStart} onClick={() => void control("start")}>启动 Host</button><button disabled={busy || !props.host.instanceId || ["stopped", "stopping"].includes(props.host.state)} onClick={() => void control("stop")}>停止 Host</button><button disabled={busy || !props.host.instanceId || props.host.state !== "ready"} onClick={() => void control("restart")}>重启 Host</button></div></section>
    <Diagnostics onError={props.onError} />
  </div>;
}
