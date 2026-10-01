import type { ModelChoice } from "../../../../packages/contracts/src/model";
import type { SessionView, SubmitInput } from "../../../../packages/contracts/src/session";

export type SessionDraft = { text: string; referenceDate: string; timezone: string; model: ModelChoice | null;
  pending: { operationRef: string; input: SubmitInput } | null };
export function newSessionDraft(model: ModelChoice | null): SessionDraft {
  return { text: "", referenceDate: new Date().toLocaleDateString("sv-SE"), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", model, pending: null };
}
export function selectSessionModelDraft(draft: SessionDraft | undefined, context: { instanceId: string | null; configVersion: string | undefined; session: SessionView | undefined },
  target: { instanceId: string; sessionId: number }, choice: ModelChoice): SessionDraft | null {
  if (target.instanceId !== context.instanceId || context.session?.id !== target.sessionId || context.session.kind !== "user"
    || context.session.status !== "active" || choice.expectedConfigVersion !== context.configVersion) return null;
  return { ...(draft ?? newSessionDraft(null)), model: { ...choice } };
}
export function acceptSubmissionDraft(draft: SessionDraft, original: NonNullable<SessionDraft["pending"]>): SessionDraft {
  if (draft.pending?.operationRef !== original.operationRef || draft.pending.input.sessionId !== original.input.sessionId
    || draft.pending.input.clientSequence !== original.input.clientSequence) return draft;
  return { ...draft, pending: null, text: draft.text === original.input.text ? "" : draft.text };
}
export function SessionList(props: { sessions: SessionView[]; current: number | null; running: number | null; creating: boolean; canCreate: boolean;
  creationUnknown: boolean; nextBefore: number | null; onCreate: () => void; onRecoverCreate: () => void; onSelect: (id: number) => void; onMore: () => void }) {
  return <section className="session-list" aria-label="会话列表"><button className="primary" disabled={!props.canCreate || props.creating || props.creationUnknown} onClick={props.onCreate}>{props.creating ? "创建中…" : "New Session"}</button>
    {props.creationUnknown && <button onClick={props.onRecoverCreate} disabled={!props.canCreate || props.creating}>查回原创建</button>}
    {props.sessions.map(session => <div className="session-row" key={session.id}><button className={session.id === props.current ? "selected" : ""} aria-pressed={session.id === props.current} onClick={() => props.onSelect(session.id)}>{session.title}</button>{session.id === props.running && <span className="tiny">运行中</span>}</div>)}
    {props.nextBefore && <button onClick={props.onMore}>更多会话</button>}</section>;
}
