import type { HostView } from "../../../../packages/contracts/src/model";
import type { ViewPage } from "./App";
import { Icon } from "./icons";
export const hostLabel = (host: HostView) => ({ stopped: "Host stopped", starting: "Host starting", handshaking: "Host connecting", ready: "Host ready", stopping: "Host stopping", failed: "Host failed to start" })[host.state];
const groups = [
  { label: 'Work', items: [{ page: 'chat', label: 'Chat' }, { page: 'data', label: 'Data Workspace' }, { page: 'queries', label: 'Query History' }] },
  { label: 'Models & Resources', items: [{ page: 'models', label: 'Models' }, { page: 'prompt', label: 'Prompt' }, { page: 'skills', label: 'Skills' }, { page: 'extensions', label: 'Extensions' }] },
  { label: 'Quality', items: [{ page: 'evaluation', label: 'Evaluation' }] },
] as const;

export function Sidebar(props: { page: ViewPage; onPage: (page: ViewPage) => void; collapsed: boolean; onCollapse: () => void; host: HostView }) {
  return <aside className="sidebar" aria-label="Application navigation">
    <div className="brand"><span className="brand-mark" aria-hidden="true">M</span><strong className="nav-text">MedClaw</strong></div>
    <button className="navigation-toggle icon-button" aria-label={props.collapsed ? 'Expand navigation' : 'Collapse navigation'} title={props.collapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!props.collapsed} onClick={props.onCollapse}><Icon name="panel" /></button>
    <nav aria-label="Main navigation">{groups.map(group => <div className="nav-group" key={group.label}>
      <span className="nav-label">{group.label}</span>
      {group.items.map(item => <button key={item.page} aria-label={item.label} title={item.label} className={props.page === item.page ? 'selected' : ''} aria-current={props.page === item.page ? 'page' : undefined} onClick={() => props.onPage(item.page)}>
        <Icon name={item.page === 'queries' ? 'history' : item.page} /><span className="nav-text">{item.label}</span>
      </button>)}
    </div>)}</nav>
    <footer><button aria-label="Settings" title="Settings" className={props.page === 'settings' ? 'selected' : ''} aria-current={props.page === 'settings' ? 'page' : undefined} onClick={() => props.onPage('settings')}><Icon name="settings" /><span className="nav-text">Settings</span></button>
      <button className={`host-indicator ${props.host.state === 'ready' ? 'success' : props.host.state === 'failed' ? 'error' : 'muted'}`} aria-label={hostLabel(props.host)} title={hostLabel(props.host)} onClick={()=>props.onPage('settings')}><span aria-hidden="true">●</span><span className="nav-text">{hostLabel(props.host)}</span></button>
    </footer>
  </aside>;
}
