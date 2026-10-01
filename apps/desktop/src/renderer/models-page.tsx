import { useEffect, useRef, useState } from "react";
import { CustomProviderDefinitionSchema, type AuthAttemptView, type AuthNotifyView, type AuthPromptView, type AuthStatusView, type CustomModelDefinition, type CustomProviderDefinition, type HostView, type ModelDirectoryView, type ProviderAccepted } from "../../../../packages/contracts/src/model";
import type { ModelChoice } from "../../../../packages/contracts/src/model";
import type { ActiveRunView, RuntimeControlView } from "../../../../packages/contracts/src/run";

const blankModel = (): CustomModelDefinition => ({ id: "", name: "", input: ["text"], reasoning: false, contextWindow: 8192, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null });
const blankProvider = (): CustomProviderDefinition => ({ providerId: "", name: "", baseUrl: "", api: "", models: [blankModel()] });
const authLabels = { available: "认证可用", unavailable: "未认证", checking: "正在核验", sync_unknown: "凭据同步尚未确认" };

export function ModelsPage(props: { directory: ModelDirectoryView | null; directoryCurrent: boolean; host: HostView; active: ActiveRunView | null; control: RuntimeControlView | null;
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
    if (result.ok) setDefinitions(result.data.definitions); else props.onError(result.error.message);
  }
  async function refresh() {
    const operationRef = crypto.randomUUID(); setRefreshRef(operationRef); setRefreshResult(null); setMessage(null);
    try {
      const result = await window.medclaw.request("model.refresh", providerId ? { providerId } : {}, operationRef);
      if (result.ok) { setRefreshResult({ aborted: result.data.aborted, errors: result.data.errors.map(item => ({ providerId: item.providerId, message: item.error.message })) }); await props.onChanged(); }
      else props.onError(result.error.message);
    } finally { setRefreshRef(null); }
  }
  async function cancelRefresh() {
    if (!refreshRef) return;
    const result = await window.medclaw.request("operation.cancel", { operationRef: refreshRef });
    if (!result.ok) props.onError(result.error.message);
  }
  async function publish() {
    if (!choice || !directory) return;
    setBusy(true); setMessage(null);
    try {
      const result = await window.medclaw.request("model.configure", { ...choice, expectedConfigVersion: directory.configVersion });
      if (result.ok) { await props.onChanged(); setMessage("模型选择已发布"); }
      else { props.onError(result.error.message); await props.onChanged(); }
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
      if (result.ok) await props.onAccepted(result.data); else props.onError(result.error.message);
    } finally { setBusy(false); }
  }
  async function startAuth(type: "api_key" | "oauth") {
    if (!providerId) return;
    setBusy(true); setMessage(null); setCancelConfirm(false); setAuthProvider(providerId); setAuthStatus(null);
    const result = await window.medclaw.request("model.auth.start", { providerId, type });
    setBusy(false);
    if (result.ok) setAttemptId(result.data.authAttemptId); else props.onError(result.error.message);
  }
  async function checkAuth() {
    const id = authProvider ?? providerId; if (!id) return;
    const result = await window.medclaw.request("model.auth.status", { providerId: id, ...(attemptId ? { authAttemptId: attemptId } : {}) });
    if (result.ok) { setAuthStatus(result.data.auth); setMessage(`认证状态：${authLabels[result.data.auth.state]}`); await props.onChanged(); }
    else props.onError(result.error.message);
  }
  async function respond() {
    if (!prompt) return;
    const value = answer; setAnswer(""); if (promptInput.current instanceof HTMLInputElement) promptInput.current.value = "";
    const result = await window.medclaw.request("model.auth.respond", { authAttemptId: prompt.authAttemptId, promptId: prompt.promptId, value });
    if (!result.ok) props.onError(result.error.message);
  }
  async function cancelAuth() {
    if (!attemptId) return;
    setAnswer(""); setCancelConfirm(false);
    const result = await window.medclaw.request("model.auth.cancel", { authAttemptId: attemptId });
    if (!result.ok) props.onError(result.error.message);
    else setMessage(result.data.settled ? "认证已取消" : "认证取消处理中，等待实际结束");
  }
  async function openLink(url: string) { const result = await window.medclaw.openAuthLink(url); if (!result.ok) props.onError(result.error.message); }
  function editDefinition(value: CustomProviderDefinition) { setDefinition(structuredClone(value)); setConfirmed(value.models.map(() => true)); setKey(""); setFieldError(null); setMessage(null); }
  function updateModel(index: number, patch: Partial<CustomModelDefinition>) { setDefinition(value => ({ ...value, models: value.models.map((model, position) => position === index ? { ...model, ...patch } : model) })); }
  async function saveCustom() {
    setMessage(null); setFieldError(null);
    if (confirmed.some(value => !value)) { setFieldError("请逐个确认输出上限来自该服务实际配置。"); return; }
    const parsed = CustomProviderDefinitionSchema.safeParse(definition);
    if (!parsed.success) { setFieldError(`请检查定义：${parsed.error.issues.map(issue => `${issue.path.join(".")} ${issue.message}`).join("；")}`); return; }
    if (!directory) return;
    setBusy(true); let token: string | undefined;
    const newKey = key; setKey(""); if (secretInput.current) secretInput.current.value = "";
    try {
      if (newKey) {
        const secret = await window.medclaw.secretInput({ providerId: definition.providerId, purpose: "custom_api_key", value: newKey });
        if (!secret.ok) { setFieldError(secret.error.message); return; }
        token = secret.data.token;
      }
      const result = await window.medclaw.request("model.custom.save", { definition: parsed.data, expectedConfigVersion: directory.configVersion, ...(token ? { credentialInput: token } : {}) });
      if (result.ok) { setMessage("自定义定义已发布"); setDefinition(result.data.definition); await props.onChanged(); await readDefinitions(); }
      else { setFieldError(result.error.message); await props.onChanged(); await readDefinitions(); }
    } catch { setFieldError("保存结果尚未确认，请查回已发布定义和目录。"); }
    finally { if (token) { try { await window.medclaw.discardSecret(token); } catch { props.onError("秘密输入清理未确认，请查回已发布定义。"); } } setBusy(false); }
  }
  return <div className="models-layout">
    <section className="panel directory-panel" aria-labelledby="directory-title">
      <div className="section-heading"><div><span className="eyebrow">Pi 动态目录</span><h2 id="directory-title">浏览与选择模型</h2></div></div>
      <p className="muted">已发布：{directory?.selection ? `${directory.selection.provider} / ${directory.selection.modelId}` : "尚未选择模型"}</p>
      {directory && !props.directoryCurrent && <p className="error-text" role="status">目录尚未重新核验，保留上次可读结果。请重读已发布目录后再发送或发布。</p>}
      <div className="directory-toolbar"><label>搜索模型<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="供应商、模型名称或 ID" /></label><label>供应商<select aria-label="供应商" value={providerId} onChange={event => { setProvider(event.target.value); setAuthProvider(null); }}><option value="">所有供应商</option>{directory?.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.id}</option>)}</select></label></div>
      <div className="actions"><button disabled={blocked || authRunning} onClick={() => void refresh()}>{refreshRef ? "刷新中…" : providerId ? "刷新此供应商" : "刷新目录"}</button>{refreshRef && <button onClick={() => void cancelRefresh()}>取消刷新</button>}<button disabled={props.host.state !== "ready"} onClick={() => void props.onChanged()}>重读已发布目录</button></div>
      {props.active && <p role="status" className="muted">正在运行 Run {props.active.runId}，认证、自定义保存与刷新须等待停止并保存。</p>}
      {refreshResult && <div role="status"><p>{refreshResult.aborted ? "刷新已取消，保留可读目录" : refreshResult.errors.length ? "部分供应商刷新失败，保留可读目录" : "目录刷新完成"}</p>{refreshResult.errors.map(error => <p key={error.providerId} className="error-text">{error.providerId}：{error.message}</p>)}</div>}
      {!directory ? <p role="status">目录尚未读回。Host 就绪后可重读。</p> : !visible.length ? <p role="status">{directory.models.length ? "没有符合搜索条件的模型" : "当前目录没有模型"}</p> : <div className="model-list" aria-label="模型目录">{visible.map(model => {
        const provider = directory.providers.find(provider => provider.id === model.provider);
        const isChoice = choice?.provider === model.provider && choice.modelId === model.id;
        const published = directory.selection?.provider === model.provider && directory.selection.modelId === model.id;
        return <article key={`${model.provider}/${model.id}`} className={`model-row ${isChoice ? "chosen" : ""}`}><div className="model-heading"><strong>{model.name}</strong>{published && <span className="status-chip">已发布模型</span>}<button aria-label={`选择 ${model.name}`} aria-pressed={isChoice} onClick={() => setChoice({ provider: model.provider, modelId: model.id })}>{isChoice ? "已选中" : "选择"}</button></div><code>{model.provider} / {model.id}</code><div className="model-metadata"><span>API {model.api}</span><span>{model.input.join(" + ")}{model.reasoning ? " · reasoning" : ""}</span><span>上下文 {model.contextWindow ?? "未知"} · 输出上限 {model.maxTokens ?? "未提供"}</span><span>{model.capabilitySource}</span><span>{provider?.source} · {provider ? authLabels[provider.auth.state] : "认证状态未知"}</span></div></article>;
      })}</div>}
      <div className="selection-actions"><span className="muted">{choice ? `选中的模型：${choice.provider} / ${choice.modelId}` : "选择目录中的模型"}</span><p className="tiny muted">{props.sessionTarget ? `当前会话目标：Session ${props.sessionTarget.sessionId}` : "请先确认一个会话，再为它选模。"}</p><div className="actions">
        <button disabled={!choice || !props.sessionTarget || catalogBlocked} onClick={useForSession}>用于当前会话</button>
        <button className="primary" disabled={!choice || blocked || authRunning} onClick={() => void publish()}>发布全局默认模型</button>
        <button disabled={blocked || !directory?.selection || authRunning} onClick={() => void diagnose()}>验证已发布模型连接</button></div></div>
      {message && <p className="success-text" role="status">{message}</p>}
    </section>
    <section className="panel" aria-labelledby="auth-title"><div className="section-heading"><h2 id="auth-title">供应商认证</h2><span className="muted">{selectedProvider?.name ?? "先筛选供应商"}</span></div>{selectedProvider ? <><p>{authLabels[selectedProvider.auth.state]} · {selectedProvider.auth.type ?? "无凭据类型"} · 来源 {selectedProvider.auth.source ?? "未提供"} · {selectedProvider.auth.checkKind}</p><div className="actions">{selectedProvider.loginTypes.map(type => <button key={type} disabled={blocked || authRunning} onClick={() => void startAuth(type)}>{type === "api_key" ? "使用 API Key 登录" : "使用 OAuth 登录"}</button>)}<button onClick={() => void checkAuth()}>查回认证状态</button></div>{!selectedProvider.loginTypes.length && <p className="muted">此供应商使用环境或系统身份，按来源配置后查回认证状态。</p>}</> : <p className="muted">未认证模型仍可浏览。登录方式由当前供应商提供。</p>}
      {authStatus && <p role="status">{authStatus.providerId}：{authLabels[authStatus.state]} · {authStatus.checkKind} · {authStatus.checkedAt}</p>}
      {attemptId && <div className="auth-interaction" role="dialog" aria-label="供应商登录" onKeyDown={event => { if (event.key === "Escape" && authRunning) { event.preventDefault(); setCancelConfirm(true); } }}><p>认证尝试 {attemptId} · {attempt?.state ?? "running"}</p>{attempt?.error && <p className="error-text">{attempt.error.message}</p>}
        {notification?.type === "auth_url" && <><p>{notification.instructions}</p><button onClick={() => void openLink(notification.url)}>打开登录链接</button></>}
        {notification?.type === "device_code" && <><p>设备码：<strong>{notification.userCode}</strong></p><button onClick={() => void openLink(notification.verificationUri)}>打开设备验证链接</button>{notification.expiresInSeconds && <p className="muted">有效期 {notification.expiresInSeconds} 秒</p>}</>}
        {(notification?.type === "info" || notification?.type === "progress") && <><p role="status">{notification.message}</p>{notification.type === "info" && notification.links?.map(link => <button key={link.url} onClick={() => void openLink(link.url)}>{link.label ?? "打开认证链接"}</button>)}</>}
        {prompt && <form onSubmit={event => { event.preventDefault(); void respond(); }}><label>{prompt.message}{prompt.type === "select" ? <select ref={element => { promptInput.current = element; }} value={answer} onChange={event => setAnswer(event.target.value)}>{prompt.options.map(option => <option key={option.id} value={option.id}>{option.label}{option.description ? ` · ${option.description}` : ""}</option>)}</select> : <input ref={element => { promptInput.current = element; }} type={prompt.secret ? "password" : "text"} autoComplete="off" maxLength={4096} value={answer} onChange={event => setAnswer(event.target.value)} />}</label><button className="primary" type="submit">提交认证答复</button></form>}
        {authRunning && <button onClick={() => setCancelConfirm(true)}>取消此次认证</button>}{cancelConfirm && <div className="confirmation" role="alertdialog" aria-label="确认取消认证"><p>取消此次登录并等待认证任务结束？</p><button onClick={() => setCancelConfirm(false)}>继续认证</button><button className="danger" onClick={() => void cancelAuth()}>确认取消认证</button></div>}
      </div>}
    </section>
    <section className="panel" aria-labelledby="custom-title"><div className="section-heading"><h2 id="custom-title">自定义供应商与模型</h2><button onClick={() => { setDefinition(blankProvider()); setConfirmed([false]); setKey(""); setFieldError(null); }}>新建定义</button></div><p className="muted">使用当前 SDK 已支持的原生 API。这里只编辑非秘密定义，新 Key 单独安全保存。</p>
      <div className="custom-definitions">{definitions.map(item => <button key={item.providerId} onClick={() => editDefinition(item)}>编辑 {item.name} · {item.providerId} · {item.models.length} 个模型</button>)}</div>
      <form onSubmit={event => { event.preventDefault(); void saveCustom(); }} className="custom-form"><div className="form-grid"><label>供应商 ID<input value={definition.providerId} maxLength={128} required onChange={event => setDefinition(value => ({ ...value, providerId: event.target.value }))} /></label><label>供应商名称<input value={definition.name} maxLength={256} required onChange={event => setDefinition(value => ({ ...value, name: event.target.value }))} /></label><label>基础 URL<input type="url" value={definition.baseUrl} required onChange={event => setDefinition(value => ({ ...value, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" /></label><label>原生 API<select value={definition.api} required onChange={event => setDefinition(value => ({ ...value, api: event.target.value }))}><option value="">选择当前 SDK API</option>{directory?.customApis.map(api => <option key={api} value={api}>{api}</option>)}</select></label></div>
        {definition.models.map((model, index) => <fieldset key={index}><legend>模型 {index + 1}</legend><div className="form-grid"><label>模型 ID<input required maxLength={256} value={model.id} onChange={event => updateModel(index, { id: event.target.value })} /></label><label>模型名称<input required maxLength={256} value={model.name} onChange={event => updateModel(index, { name: event.target.value })} /></label><label>上下文上限<input type="number" min="1" step="1" required value={model.contextWindow} onChange={event => updateModel(index, { contextWindow: Number(event.target.value) })} /></label><label>输出上限<input type="number" min="1" max={model.contextWindow} step="1" required value={model.maxTokens} onChange={event => { updateModel(index, { maxTokens: Number(event.target.value) }); setConfirmed(value => value.map((item, position) => position === index ? false : item)); }} /></label></div><div className="checkbox-row"><label><input type="checkbox" checked disabled />文本输入</label><label><input type="checkbox" checked={model.input.includes("image")} onChange={event => updateModel(index, { input: event.target.checked ? ["text", "image"] : ["text"] })} />图片能力元数据</label><label><input type="checkbox" checked={model.reasoning} onChange={event => updateModel(index, { reasoning: event.target.checked })} />Reasoning</label><label><input type="checkbox" checked={confirmed[index] ?? false} onChange={event => setConfirmed(value => value.map((item, position) => position === index ? event.target.checked : item))} />输出上限来自该服务实际配置</label></div><label className="checkbox-label"><input type="checkbox" checked={model.pricingKnown} onChange={event => updateModel(index, { pricingKnown: event.target.checked, cost: event.target.checked ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : null })} />已知每百万 Token 的 USD 费率</label>{model.cost && <div className="form-grid pricing-grid">{(["input", "output", "cacheRead", "cacheWrite"] as const).map(field => <label key={field}>{({ input: "输入费率", output: "输出费率", cacheRead: "缓存读取费率", cacheWrite: "缓存写入费率" })[field]}<input type="number" min="0" step="any" value={model.cost![field]} onChange={event => updateModel(index, { cost: { ...model.cost!, [field]: Number(event.target.value) } })} /></label>)}</div>}{definition.models.length > 1 && <button type="button" onClick={() => { setDefinition(value => ({ ...value, models: value.models.filter((_, position) => position !== index) })); setConfirmed(value => value.filter((_, position) => position !== index)); }}>移除此草稿模型</button>}</fieldset>)}
        <button type="button" onClick={() => { setDefinition(value => ({ ...value, models: [...value.models, blankModel()] })); setConfirmed(value => [...value, false]); }}>添加模型</button><label>新的 API Key<input ref={secretInput} type="password" autoComplete="off" maxLength={4096} value={key} onChange={event => setKey(event.target.value)} placeholder="留空保留当前凭据，已存 Key 不回显" /></label>{fieldError && <p id="custom-error" role="alert" className="error-text">{fieldError}</p>}<div className="actions"><button className="primary" disabled={blocked || authRunning || !directory} type="submit">保存自定义定义</button><button type="button" disabled={props.host.state !== "ready"} onClick={() => void readDefinitions()}>查回已发布定义</button></div>
      </form>
    </section>
  </div>;
}
