import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../../../packages/contracts/src/error";
import type { HostView } from "../../../../packages/contracts/src/model";
import type { SessionInput } from "../../../../packages/contracts/src/session";

export type InputQueueSnapshot = { items: SessionInput[]; cursor: number | null; hasMore: boolean; loaded: boolean; loading: boolean; error: string | null };
const empty = (): InputQueueSnapshot => ({ items: [], cursor: null, hasMore: false, loaded: false, loading: false, error: null });
const unsettled = (input: SessionInput) => input.processingStatus === 'pending';

/** Ordinary reads are scoped to one Host and original Session. Mutation generations reject held older reads. */
export function useInputQueue(host: HostView) {
  const [snapshots, setSnapshots] = useState<Record<number, InputQueueSnapshot>>({});
  const values = useRef(snapshots), owner = useRef({ instanceId: host.instanceId, state: host.state, epoch: 0 }), mounted = useRef(true);
  const lists = useRef(new Map<number, Promise<void>>()), reads = useRef(new Map<number, Promise<SessionInput | null>>());
  const generations = useRef(new Map<number, number>()), listGenerations = useRef(new Map<number, number>());
  if (owner.current.instanceId !== host.instanceId || owner.current.state !== host.state) owner.current = { instanceId: host.instanceId, state: host.state, epoch: owner.current.epoch + 1 };
  const capture = () => ({ ...owner.current }), owns = (scope: ReturnType<typeof capture>) => mounted.current && owner.current.epoch === scope.epoch && owner.current.state === 'ready';
  const change = useCallback((sessionId: number, update: (old: InputQueueSnapshot) => InputQueueSnapshot) => {
    const next = { ...values.current, [sessionId]: update(values.current[sessionId] ?? empty()) }; values.current = next; setSnapshots(next);
  }, []);
  const merge = useCallback((input: SessionInput) => change(input.sessionId, old => {
    const prior = old.items.find(item => item.id === input.id);
    if (prior && (input.updatedAt < prior.updatedAt || prior.status !== 'queued' && input.status === 'queued'
      || prior.processingStatus !== 'pending' && input.processingStatus === 'pending')) return old;
    return { ...old, items: [...old.items.filter(item => item.id !== input.id), input].sort((a, b) => a.clientSequence - b.clientSequence) };
  }), [change]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; owner.current.epoch++; }; }, []);
  useEffect(() => { values.current = {}; setSnapshots({}); lists.current.clear(); reads.current.clear(); generations.current.clear(); listGenerations.current.clear(); }, [host.instanceId]);
  const accept = useCallback((input: SessionInput) => {
    generations.current.set(input.id, (generations.current.get(input.id) ?? 0) + 1);
    listGenerations.current.set(input.sessionId, (listGenerations.current.get(input.sessionId) ?? 0) + 1);
    merge(input);
  }, [merge]);
  const readInput = useCallback((inputId: number, sessionId: number): Promise<SessionInput | null> => {
    const existing = reads.current.get(inputId); if (existing) return existing;
    const scope = capture(), generation = generations.current.get(inputId) ?? 0;
    if (scope.state !== 'ready') return Promise.resolve(null);
    let task!: Promise<SessionInput | null>; task = (async () => {
      try {
        const result = await window.medclaw.request('session.readInput', { inputId });
        if (!owns(scope) || generation !== (generations.current.get(inputId) ?? 0)) return null;
        if (!result.ok) change(sessionId, old => ({ ...old, error: 'Input read unavailable. ' + errorMessage(result.error) }));
        else if (result.data?.id === inputId && result.data.sessionId === sessionId) { merge(result.data); return result.data; }
        else change(sessionId, old => ({ ...old, error: 'Input read unavailable. Keep the original Input ID and read it again.' }));
      } catch { if (owns(scope) && generation === (generations.current.get(inputId) ?? 0)) change(sessionId, old => ({ ...old, error: 'Input read unavailable. Read the original Input again.' })); }
      finally { if (reads.current.get(inputId) === task) reads.current.delete(inputId); }
      return null;
    })();
    reads.current.set(inputId, task); return task;
  }, [change, merge]);
  const readPage = useCallback((sessionId: number, kind: 'first' | 'more' | 'new' = 'first'): Promise<void> => {
    const existing = lists.current.get(sessionId); if (existing) return existing;
    const scope = capture(), old = values.current[sessionId] ?? empty(), generation = listGenerations.current.get(sessionId) ?? 0;
    if (scope.state !== 'ready' || kind === 'more' && !old.hasMore || kind === 'new' && old.hasMore) return Promise.resolve();
    const afterClientSequence = kind === 'more' ? old.cursor : kind === 'new' ? old.items.at(-1)?.clientSequence ?? null : null;
    change(sessionId, current => ({ ...current, loading: true }));
    let task!: Promise<void>; task = (async () => {
      try {
        const result = await window.medclaw.request('session.listInputs', { sessionId, afterClientSequence, limit: 50 });
        if (!owns(scope) || generation !== (listGenerations.current.get(sessionId) ?? 0)) return;
        if (!result.ok) { change(sessionId, current => ({ ...current, error: 'Input read unavailable. ' + errorMessage(result.error) })); return; }
        if (result.data.sessionId !== sessionId) { change(sessionId, current => ({ ...current, error: 'Input read unavailable. Reply does not match the original Session.' })); return; }
        for (const input of result.data.items) merge(input);
        change(sessionId, current => ({ ...current, loaded: true, error: null, cursor: result.data.nextClientSequence, hasMore: result.data.hasMore }));
      } catch { if (owns(scope)) change(sessionId, current => ({ ...current, error: 'Input read unavailable. Read the original Session again.' })); }
      finally { if (lists.current.get(sessionId) === task) lists.current.delete(sessionId); if (owns(scope)) change(sessionId, current => ({ ...current, loading: false })); }
    })();
    lists.current.set(sessionId, task); return task;
  }, [change, merge]);
  const refresh = useCallback(async (sessionId: number, first = false) => {
    const old = values.current[sessionId];
    await Promise.all([readPage(sessionId, first || !old?.loaded ? 'first' : 'new'), ...(old?.items.filter(unsettled).map(input => readInput(input.id, sessionId)) ?? [])]);
  }, [readPage, readInput]);
  return { snapshots, values, accept, readInput, readPage, refresh };
}

const status = { queued: 'Queued', consumed: 'Consumed', failed: 'Failed', cancelled: 'Cancelled', delivery_unknown: 'Delivery unknown' };
const processing = { pending: 'Pending', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };
export function InputQueue(props: { snapshot: InputQueueSnapshot | null; sessionId: number | null; ready: boolean; cancelling: number[];
  onRefresh: () => void; onMore: () => void; onCancel: (input: SessionInput) => void }) {
  const value = props.snapshot;
  return <section data-testid="input-queue" className="input-queue" aria-label="Input queue">
    <div className="section-heading"><h3>Input queue</h3><div className="actions"><button disabled={!props.ready || !props.sessionId || value?.loading} onClick={props.onRefresh}>Refresh inputs</button>{value?.hasMore && <button disabled={!props.ready || value.loading} onClick={props.onMore}>Load more inputs</button>}</div></div>
    {value?.loading && <p role="status" className="tiny">Reading inputs…</p>}
    {value?.error && <p role="alert" className="error-text">{value.error} Showing the last confirmed inputs.</p>}
    {value?.loaded && !value.items.length && !value.error && <p className="tiny muted">No inputs in this Session.</p>}
    {value?.items.map(input => <article key={input.id} data-input-id={input.id} className="session-input"><div className="input-heading"><strong>{input.mode === 'follow_up' ? 'Follow Up' : input.mode === 'steer' ? 'Steer' : 'Send'} · Input {input.id}</strong><span>{status[input.status]} / {processing[input.processingStatus]}</span></div>
      <div className="input-text">{input.text}</div><p className="tiny muted">Session {input.sessionId} · Sequence {input.clientSequence}{input.targetRunId ? ` · Original Run ${input.targetRunId}` : ''}{input.runId ? ` · Consumed by Run ${input.runId}` : ''}{input.nativeEntryId ? ` · Native entry ${input.nativeEntryId}` : ''}</p>
      {input.textInfo.truncated && <p className="tiny muted">Input display truncated · {input.text.length} / {input.textInfo.totalChars} characters</p>}
      {input.error && <p role="alert" className="error-text">{errorMessage(input.error)}</p>}
      {input.status === 'delivery_unknown' && <p className="tiny error-text">Consumption unconfirmed. Read the original Input or Stop its original Run.</p>}
      {input.status === 'queued' && <button disabled={!props.ready || props.cancelling.includes(input.id)} onClick={() => props.onCancel(input)}>{props.cancelling.includes(input.id) ? 'Cancelling' : 'Cancel input'}</button>}
    </article>)}
  </section>;
}
