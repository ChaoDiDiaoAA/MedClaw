import { useEffect, useRef, useState } from "react";
import type { HostView, ModelDirectoryView } from "../../../../packages/contracts/src/model";
import type { ActiveRunView, RunView, RuntimeControlView } from "../../../../packages/contracts/src/run";
import type { SessionDetail } from "../../../../packages/contracts/src/session";
import type { SessionDraft } from "./session-list";

export function Chat(props: { directory: ModelDirectoryView | null; directoryCurrent: boolean; host: HostView; active: ActiveRunView | null; control: RuntimeControlView | null;
  run: RunView | null; preview: { text: string; truncated: boolean } | null; session: SessionDetail | null; draft: SessionDraft | null;
  selecting: boolean; sending: boolean; runningTitle: string | null; onDraft: (patch: Partial<SessionDraft>) => void; onSend: () => void; onResend: () => void;
  onLookup: () => void; onStop: () => void; onModels: () => void }) {
  const [following, setFollowing] = useState(true), input = useRef<HTMLTextAreaElement>(null), scroll = useRef<HTMLDivElement>(null);
  const draft = props.draft, choice = draft?.model;
  const provider = props.directory?.providers.find(provider => provider.id === choice?.provider);
  const model = props.directory?.models.find(model => model.provider === choice?.provider && model.id === choice?.modelId);
  const run = props.run?.kind === "agent" && props.run.sessionId !== props.session?.session.id ? null : props.run;
  const reason = props.host.state !== "ready" ? "等待 Host 就绪" : props.selecting ? "会话选择尚未确认" : !props.session ? "请新建或选择会话"
    : !props.session.history.available ? "本次启动无法继续此会话，请新建会话。" : draft?.pending ? "请先查回原提交"
    : !props.directoryCurrent ? "请在 Models 重读当前目录" : !choice ? "请在 Models 为当前会话选择模型" : !model || !model.input.includes("text") ? "当前会话模型不可用，请重新选择"
    : !model.maxTokens ? "请确认模型输出上限" : provider?.auth.state !== "available" ? "请先完成供应商认证" : !props.control ? "运行准入尚未确认"
    : !props.control.acceptingNewRuns ? props.control.blockReasons[0]?.message ?? "请等待原运行停止并保存" : null;
  const status = props.active && props.active.runId === run?.id && props.active.stopPending ? "停止处理中，尚未确认"
    : props.active && props.active.runId === run?.id && props.active.persistencePending ? "原事实待保存"
    : run?.status === "completed" ? "已提交" : run?.status === "cancelled" ? "已取消并保存"
    : run?.status === "failed" ? props.active?.runId === run.id ? "失败，收尾尚未确认" : "失败事实已保存" : run ? "生成中 · 尚未保存" : null;
  useEffect(() => { if (input.current) { input.current.style.height = "auto"; input.current.style.height = Math.min(160, input.current.scrollHeight) + "px"; } }, [draft?.text, props.session?.session.id]);
  useEffect(() => { if (following && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [props.preview?.text, run?.output.text, following, props.session?.session.id]);
  return <div className="chat-layout">
    <div className="session-heading"><strong data-testid="current-session">{props.session?.session.title ?? "尚未选择会话"}</strong>
      {props.active && <span data-testid="running-session" className="status-chip">正在运行：{props.runningTitle ?? "Provider"} · Run {props.active.runId}</span>}</div>
    <div className="messages" ref={scroll} onScroll={() => { const element = scroll.current!; setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 64); }}>
      <div className="reading-width">
        {!run && <div className="chat-empty"><span className="eyebrow">会话对话</span><h2>{props.session ? "开始本会话的对话" : "创建你的会话"}</h2><p>同一会话保留本次启动的上下文，每次发送均可核查对应运行。</p><button className="primary" onClick={props.onModels}>配置模型</button></div>}
        {!!props.session?.history.messages.length && <details className="history-preview"><summary>本进程会话历史（预览） · {props.session.history.messages.length} 条</summary>
          {props.session.history.messages.map(message => <article key={message.nativeEntryId}><strong>{message.role === "user" ? "User" : "Assistant"}</strong><div className="answer-text">{message.text}</div>{message.truncated && <p className="tiny muted">此条显示前 {message.text.length} / {message.totalChars} 字符。</p>}</article>)}
          {props.session.history.truncated && <p className="muted">仅显示最近 32 条消息预览。</p>}</details>}
        {run && <>{run.kind === "provider" && <p className="muted">Provider 诊断 · Run {run.id}</p>}<div className="user-message"><span className="message-label">User</span><div>{run.inputText}</div></div>
          <article className="model-answer"><div className="answer-heading"><strong>Assistant</strong><span className="status-chip">{status}</span></div>
            <div className="answer-text" data-testid="run-output">{props.preview?.text ?? (run.output.text || "等待模型输出")}</div>
            {props.preview?.truncated && <p className="muted">临时预览已裁剪，最终全文可在运行详情分页查看。</p>}
            {run.output.nextOffset !== null && !props.preview && <p className="muted">此页显示 {run.output.text.length} / {run.output.totalChars} 字符，全文可在运行详情继续读取。</p>}
            {run.error && <p role="alert" className="error-text">{run.error.message}</p>}</article></>}
      </div>
    </div>
    {!following && <button className="new-content" onClick={() => setFollowing(true)}>有新内容 · 返回最新</button>}
    <div className="composer-wrap"><div className="composer reading-width">
      <div className="composer-model"><span aria-hidden="true">◇</span><span data-testid="session-model">{choice ? choice.provider + " / " + choice.modelId : "尚未选择会话模型"}</span><button className="quiet" onClick={props.onModels}>管理模型</button></div>
      {props.active && <p className="tiny muted">选模对下次发送生效，当前运行使用已冻结配置。</p>}
      <label className="sr-only" htmlFor="message-text">消息文本</label><textarea id="message-text" ref={input} value={draft?.text ?? ""} disabled={!draft} placeholder="输入消息…" onChange={event => props.onDraft({ text: event.target.value })} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!reason && !props.sending && draft?.text.trim()) props.onSend(); }
      }} />
      <div className="composer-bottom"><span className="tiny muted">Shift+Enter 换行</span><div className="actions">
        {draft?.pending && <><button disabled={props.sending} onClick={props.onLookup}>查回原操作</button><button disabled={props.sending} onClick={props.onResend}>同参重送</button></>}
        {props.active && <button className="danger" disabled={props.host.state !== "ready"} onClick={props.onStop}>停止生成</button>}
        <button className="primary" disabled={!!reason || props.sending || !draft?.text.trim()} title={reason ?? undefined} onClick={props.onSend}>{props.sending ? "受理中…" : "发送"}</button>
      </div></div>{reason && <p className="composer-reason" role="status">{reason}</p>}
    </div><details className="reference-fields reading-width"><summary>此次时间锚点</summary><label>参考日期<input type="date" value={draft?.referenceDate ?? ""} disabled={!draft} onChange={event => props.onDraft({ referenceDate: event.target.value })} /></label><label>时区<input value={draft?.timezone ?? ""} disabled={!draft} onChange={event => props.onDraft({ timezone: event.target.value })} /></label></details></div>
  </div>;
}
