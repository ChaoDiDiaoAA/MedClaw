import type { HostView } from "../../../../packages/contracts/src/model";
import type { ViewPage } from "./App";
export const hostLabel = (host: HostView) => ({ stopped: "Host stopped", starting: "Host starting", handshaking: "Host connecting", ready: "Host ready", stopping: "Host stopping", failed: "Host failed to start" })[host.state];
export function Sidebar(props: { page: ViewPage; onPage: (page: ViewPage) => void; collapsed: boolean; onCollapse: () => void; host: HostView; children?: React.ReactNode }) {
  return <aside className="sidebar" hidden={props.collapsed}>
    <div className="brand"><span className="brand-mark" aria-hidden="true">M</span><strong>MedClaw</strong><button className="icon-button" aria-label="Collapse navigation" onClick={props.onCollapse}>‹</button></div>
    <nav aria-label="Main navigation"><span className="nav-label">Work</span><button className={props.page === "chat" ? "selected" : ""} aria-current={props.page === "chat" ? "page" : undefined} onClick={() => props.onPage("chat")}><span aria-hidden="true">↗</span>Chat</button><button className={props.page === "data" ? "selected" : ""} aria-current={props.page === "data" ? "page" : undefined} onClick={() => props.onPage("data")}><span aria-hidden="true">▦</span>Data Workspace</button><button className={props.page === "queries" ? "selected" : ""} aria-current={props.page === "queries" ? "page" : undefined} onClick={() => props.onPage("queries")}><span aria-hidden="true">≡</span>Query History</button><span className="nav-label">Models &amp; Resources</span><button className={props.page === "models" ? "selected" : ""} aria-current={props.page === "models" ? "page" : undefined} onClick={() => props.onPage("models")}><span aria-hidden="true">◇</span>Models</button></nav>
    {props.children}
    <div className="sidebar-note"><strong>Session chat</strong><p>Each session keeps its context during this app session. Review the saved run for each message.</p></div>
    <footer><button className={props.page === "settings" ? "selected" : ""} onClick={() => props.onPage("settings")}><span aria-hidden="true">⚙</span>Settings</button><div className={`host-indicator ${props.host.state === "ready" ? "success" : "muted"}`}><span aria-hidden="true">●</span><span>{hostLabel(props.host)}</span></div></footer>
  </aside>;
}
