import type { RunEventProjectionState } from './use-run-events';
import { useRef, useState } from 'react';
import { errorMessage } from '../../../../packages/contracts/src/error';

export function Timeline(props: { state: RunEventProjectionState | null; onResumeGap: () => void; onQuery?: (queryId: number) => void }) {
  const state = props.state;
  const [reference, setReference] = useState<{ scope: string; text: string } | null>(null);
  const scope = state ? `${state.runId}:${state.sessionId}` : 'none', target = useRef(scope); target.current = scope;
  async function readInput(inputId: number) {
    if (!state) return; const original = scope;
    const result = await window.medclaw.request('session.readInput', { inputId });
    if (target.current !== original) return;
    setReference({ scope: original, text: result.ok && result.data && result.data.id === inputId && result.data.sessionId === state.sessionId && (result.data.runId ?? result.data.targetRunId) === state.runId
      ? `Original Input ${inputId} · ${result.data.status} · processing ${result.data.processingStatus}` : !result.ok ? errorMessage(result.error) : 'Original Input unavailable. Keep its original Run and Session.' });
  }
  if (!state) return null;
  return <section className="event-timeline" data-testid="run-timeline" data-run-id={state.runId} data-cursor={state.cursor} aria-label={`Timeline for Run ${state.runId}`}>
    <div className="section-heading"><h3>Committed Timeline · Run {state.runId}</h3><span className="status-chip" data-testid="event-subscription-state">{state.phase}</span></div>
    <p className="tiny muted">Database facts · delivered through sequence {state.cursor}. Display recovery does not execute the Run.</p>
    {state.phase === 'disconnected' && <p role="status">Event display disconnected. Showing the last verified Timeline.</p>}
    {(state.phase === 'opening' || state.phase === 'replaying') && <p role="status">Reading committed Run events…</p>}
    {state.prefixUnrecorded && <p className="evidence-gap" data-testid="event-prefix-unrecorded">Earlier trajectory was not recorded. This Run began before its first P6 event.</p>}
    {state.error && <p className="error-text" role="alert">{state.error}</p>}
    {state.gap && <div className="evidence-gap" data-testid="event-gap"><p>A committed event segment is unavailable. The gap remains marked.</p><p className="tiny">Available range {state.gap.firstSequence ?? 'empty'}–{state.gap.lastSequence}</p>{state.gap.resumeAfterSequence !== null && <button onClick={props.onResumeGap}>Read available events after gap</button>}</div>}
    {!state.events.length && <p className="muted">No committed P6 events are available for this Run.</p>}
    <ol>{state.events.map(event => <li key={event.eventId} data-event-id={event.eventId} data-event-sequence={event.sequence} data-event-type={event.type}>
      <div><strong>{event.type.replaceAll('_', ' ')}</strong><span className="tiny muted"> · sequence {event.sequence}</span></div>
      <time className="tiny muted" dateTime={event.occurredAt}>{event.occurredAt}</time>
      {'inputId' in event.payload && <p className="tiny"><button onClick={() => { if ('inputId' in event.payload) void readInput(event.payload.inputId); }}>Read original Input {event.payload.inputId}</button> · {event.payload.status} · processing {event.payload.processingStatus}{'phase' in event.payload ? ' · ' + event.payload.phase : ''}</p>}
      {'nativeToolCallId' in event.payload && <p className="tiny"><a href={`#tool-call-${event.payload.callId}`}>Tool {event.payload.callId}</a> · {event.payload.status}{event.payload.queryIds.length > 0 ? ' · Queries ' + event.payload.queryIds.join(', ') : ''}</p>}
      {event.type === 'context_delivered' && <p className="tiny">Context {event.payload.snapshotId} · original Call {event.payload.callId} · delivery saved</p>}
      {event.type==='compaction_completed'&&<p className="tiny">{event.payload.reason} · native entry <code>{event.payload.nativeEntryId}</code> · saved version {event.payload.storageVersion} · SDK tokens before {event.payload.tokensBefore} · estimated after {event.payload.estimatedTokensAfter??'Unknown'}</p>}
      {'queryId' in event.payload && <button onClick={() => { if ('queryId' in event.payload) props.onQuery?.(event.payload.queryId); }} disabled={!props.onQuery}>Read original Query {event.payload.queryId}</button>}
      {'answerId' in event.payload && <p className="tiny">Answer {event.payload.answerId ?? 'not available'} · execution stop {event.payload.stopConfirmed === true ? 'confirmed' : 'unconfirmed'}. Runtime admission is read separately.</p>}
      {'errorCode' in event.payload && event.payload.errorCode && <p className="tiny error-text">{event.payload.errorCode}</p>}
    </li>)}</ol>
    {reference?.scope === scope && <p role="status" className="tiny">{reference.text}</p>}
  </section>;
}
