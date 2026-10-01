import type { HostView } from "../../../../packages/contracts/src/model";
import type { ViewPage } from "./App";
export const hostLabel = (host: HostView) => ({ stopped: "Host stopped", starting: "Host starting", handshaking: "Host connecting", ready: "Host ready", stopping: "Host stopping", failed: "Host failed to start" })[host.state];
export function Sidebar(props: { page: ViewPage; onPage: (page: ViewPage) => void; collapsed: boolean; onCollapse: () => void; host: HostView; children?: React.ReactNode }) {
  return <aside className="sidebar" hidden={props.collapsed}>
    <div className="brand"><span className="brand-mark" aria-hidden="true">M</span><strong>MedClaw</strong><button className="icon-button" aria-label="Collapse navigation" onClick={props.onCollapse}>‹</button></div>
    <nav aria-label="Main navigation"><span className="nav-label">Work</span><button className={props.page === "chat" ? "selected" : ""} aria-current={props.page === "chat" ? "page" : undefined} onClick={() => props.onPage("chat")}><span aria-hidden="true">↗</span>Chat</button><span className="nav-label">Models &amp; Resources</span><button className={props.page === "models" ? "selected" : ""} aria-current={props.page === "models" ? "page" : undefined} onClick={() => props.onPage("models")}><span aria-hidden="true">◇</span>Models</button></nav>
    {props.children}
    <div className="sidebar-note"><strong>Session chat</strong><p>会话独立保留本次启动的对话上下文。可随时核查已保存的运行事实。</p></div>
    <footer><button className={props.page === "settings" ? "selected" : ""} onClick={() => props.onPage("settings")}><span aria-hidden="true">⚙</span>Settings</button><div className={`host-indicator ${props.host.state === "ready" ? "success" : "muted"}`}><span aria-hidden="true">●</span><span>{hostLabel(props.host)}</span></div></footer>
  </aside>;
}
