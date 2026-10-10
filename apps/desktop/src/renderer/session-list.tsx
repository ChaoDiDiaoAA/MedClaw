import { useEffect, useRef, useState } from "react";
import type { ModelChoice } from "../../../../packages/contracts/src/model";
import type { InputMode, SessionView, SubmitInput } from "../../../../packages/contracts/src/session";

export function sessionDisplayTitle(session: Pick<SessionView, "id" | "title">): string {
  return session.title;
}

export type SessionDraft = { text: string; referenceDate: string; timezone: string; model: ModelChoice | null; mode?: InputMode;
  routing?: Extract<SubmitInput, { mode: 'send' }>['routing'] | null;
  intentRunId?: number;
  resendConfirmed?: boolean; confirmedFailure?: boolean; pending: { operationRef: string; input: SubmitInput } | null };
export function newSessionDraft(model: ModelChoice | null, dataDefaults?: { batchCount: number; referenceDate: string | null; timezone: string | null } | null, intentEnabled: boolean | null = false): SessionDraft {
  return { text: "", referenceDate: dataDefaults && dataDefaults.batchCount > 0 ? dataDefaults.referenceDate ?? "" : new Date().toLocaleDateString("sv-SE"), timezone: dataDefaults && dataDefaults.batchCount > 0 ? dataDefaults.timezone ?? "" : (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"), model, mode: "send", routing: intentEnabled === null ? undefined : intentEnabled ? { mode: 'intent', originRunId: null } : null, pending: null, resendConfirmed: false };
}
export function selectSessionModelDraft(draft: SessionDraft | undefined, context: { instanceId: string | null; configVersion: string | undefined; session: SessionView | undefined },
  target: { instanceId: string; sessionId: number }, choice: ModelChoice): SessionDraft | null {
  if (target.instanceId !== context.instanceId || context.session?.id !== target.sessionId || context.session.kind !== "user"
    || context.session.status !== "active" || choice.expectedConfigVersion !== context.configVersion) return null;
  return { ...(draft ?? newSessionDraft(null)), model: { ...choice } };
}
export function acceptSubmissionDraft(draft: SessionDraft, original: NonNullable<SessionDraft["pending"]>, runId: number | null = null): SessionDraft {
  if (draft.pending?.operationRef !== original.operationRef || draft.pending.input.sessionId !== original.input.sessionId
    || draft.pending.input.clientSequence !== original.input.clientSequence) return draft;
  const intent = original.input.mode === 'send' && original.input.routing?.mode === 'intent';
  return { ...draft, mode: 'send', pending: null, resendConfirmed: false, confirmedFailure: false,
    intentRunId: intent && runId !== null && draft.text === original.input.text ? runId : undefined,
    text: !intent && draft.text === original.input.text ? '' : draft.text };
}
export type SessionManagementEditor = { action: 'rename' | 'delete'; target: SessionView; title: string; visible: boolean; busy: boolean; unknown: boolean; error: string | null };
export function SessionList(props: { sessions: SessionView[]; current: number | null; running: number | null; creating: boolean; canCreate: boolean; canRecoverCreate?: boolean; canSelect?: boolean;
  canManage: boolean; canDelete: boolean; management: SessionManagementEditor | null; onManage: (session: SessionView, action: 'rename' | 'delete') => void;
  onManagementTitle: (title: string) => void; onManagementSave: () => void; onManagementClose: () => void; onManagementRead: () => void; onRefresh: () => void;
  creationUnknown: boolean; nextBefore: number | null; onCreate: () => void; onRecoverCreate: () => void; onSelect: (id: number) => void; onMore: () => void }) {
  const [menu, setMenu] = useState<number | null>(null), triggers = useRef(new Map<number, HTMLButtonElement>());
  const dialog = useRef<HTMLDialogElement>(null), nameInput = useRef<HTMLInputElement>(null), cancel = useRef<HTMLButtonElement>(null), create = useRef<HTMLButtonElement>(null);
  const restoreTarget = useRef<number | null>(null), menuElement = useRef<HTMLDivElement>(null);
  const management = props.management;
  const closeMenu = () => { const id = menu; setMenu(null); if (id !== null) triggers.current.get(id)?.focus(); };
  useEffect(() => {
    if (menu === null) return;
    menuElement.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: MouseEvent) => { if (!menuElement.current?.parentElement?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener('mousedown', outside); return () => document.removeEventListener('mousedown', outside);
  }, [menu]);
  useEffect(() => {
    if (management?.visible) {
      if (!dialog.current?.open) dialog.current?.showModal();
      if (!management.busy && !management.unknown) (management.action === 'rename' ? nameInput.current : cancel.current)?.focus();
      const opened = dialog.current;
      return () => { opened?.close(); (triggers.current.get(restoreTarget.current ?? -1) ?? create.current)?.focus(); };
    }
  }, [management?.visible, management?.action]);
  return <section className="session-list" aria-label="Sessions"><button ref={create} className="primary" disabled={!props.canCreate || props.creating || props.creationUnknown} onClick={props.onCreate}>{props.creating ? "Creating…" : "New Session"}</button>
    {props.creationUnknown && <button onClick={props.onRecoverCreate} disabled={!(props.canRecoverCreate ?? props.canCreate) || props.creating}>Recover original creation</button>}
    {props.sessions.map(session => <div className="session-row" data-session-id={session.id} key={session.id}><button disabled={props.canSelect === false} className={session.id === props.current ? "selected" : ""} aria-pressed={session.id === props.current} onClick={() => props.onSelect(session.id)}>{sessionDisplayTitle(session)}</button>{session.id === props.running && <span className="tiny">Running</span>}
      <button className="session-menu-trigger" ref={button => { if (button) triggers.current.set(session.id, button); else triggers.current.delete(session.id); }} aria-label={`Session actions for ${session.title}`} aria-haspopup="menu" aria-expanded={menu === session.id} onClick={() => setMenu(menu === session.id ? null : session.id)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setMenu(session.id); } }}>⋯</button>
      {menu === session.id && <div ref={menuElement} className="session-menu" role="menu" aria-label={`Actions for ${session.title}`} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')], index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
        else if (event.key === 'Tab') setMenu(null);
      }}><button role="menuitem" disabled={!props.canManage} onClick={() => { restoreTarget.current = session.id; setMenu(null); props.onManage(session, 'rename'); }}>Rename</button><button role="menuitem" className="danger" disabled={!props.canManage || !props.canDelete} onClick={() => { restoreTarget.current = session.id; setMenu(null); props.onManage(session, 'delete'); }}>Delete</button></div>}
    </div>)}
    {props.nextBefore && <button onClick={props.onMore}>More sessions</button>}
    <button className="quiet" onClick={props.onRefresh}>Refresh sessions</button>
    {management?.unknown && !management.visible && <div className="session-management-recovery" role="status"><p>{management.action === 'rename' ? 'Rename' : 'Delete'} result for {management.target.title} is unconfirmed.</p>{management.error && <p>{management.error}</p>}<button disabled={management.busy} onClick={props.onManagementRead}>Read original {management.action}</button></div>}
    {management?.visible && <dialog ref={dialog} className="session-management-dialog" aria-labelledby="session-management-heading" onCancel={event => { event.preventDefault(); if (!management.busy) props.onManagementClose(); }}>
      <form onSubmit={event => { event.preventDefault(); if (!management.busy && !management.unknown) props.onManagementSave(); }}>
        <h2 id="session-management-heading">{management.action === 'rename' ? 'Rename session' : 'Delete session?'}</h2>
        {management.action === 'rename' ? <label>Session name<input ref={nameInput} value={management.title} disabled={management.busy || management.unknown} onChange={event => props.onManagementTitle(event.target.value)} /></label> : <p>Remove “{management.target.title}” from the sidebar? Saved runs, inputs, query results, and event records will remain available. There is no restore option.</p>}
        {management.error && <p className="error-text" role="alert">{management.error}</p>}
        {management.unknown && <p role="status">Keep this original operation until its result is confirmed.</p>}
        <div className="actions">{management.unknown ? <><button type="button" disabled={management.busy} onClick={props.onManagementRead}>Read original {management.action}</button><button type="button" disabled={management.busy} onClick={props.onManagementClose}>Keep for later</button></> : <><button className={management.action === 'delete' ? 'danger' : 'primary'} disabled={management.busy || management.action === 'delete' && !props.canDelete}>{management.busy ? 'Saving…' : management.action === 'rename' ? 'Save' : 'Delete session'}</button><button ref={cancel} type="button" disabled={management.busy} onClick={props.onManagementClose}>Cancel</button></>}</div>
      </form>
    </dialog>}
  </section>;
}
