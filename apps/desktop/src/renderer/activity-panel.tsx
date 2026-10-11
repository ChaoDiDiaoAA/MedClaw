import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../../packages/contracts/src/error';
import type { HostView } from '../../../../packages/contracts/src/model';
import type { PublicReturn } from '../../../../packages/contracts/src/protocol';

export function ActivityPanel(props: { visible: boolean; host: HostView; sessionId: number | null; revision: string }) {
  const [page, setPage] = useState<PublicReturn<'activity.list'> | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const [global, setGlobal] = useState(false), sessionId = global ? null : props.sessionId;
  const owner = `${props.host.instanceId}:${global}:${sessionId}`, current = useRef(owner), order = useRef(0); current.current = owner;
  async function read(beforeEventId?: number) {
    const key = owner, token = ++order.current; setLoading(true);
    try {
      const result = await window.medclaw.request('activity.list', { sessionId, ...(beforeEventId ? { beforeEventId } : {}) });
      if (key !== current.current || token !== order.current) return;
      if (result.ok) { setPage(old => beforeEventId && old ? { items: [...old.items, ...result.data.items.filter(item => !old.items.some(known => known.id === item.id))], nextBeforeEventId: result.data.nextBeforeEventId } : result.data); setError(null); }
      else setError(errorMessage(result.error));
    } catch { if (key === current.current && token === order.current) setError('Business activity could not be read.'); }
    finally { if (key === current.current && token === order.current) setLoading(false); }
  }
  useEffect(() => { setPage(null); setError(null); setLoading(false); order.current++; }, [owner]);
  useEffect(() => { if (props.visible && props.host.state === 'ready' && (global || sessionId)) void read(); return () => { order.current++; }; }, [props.visible, props.host.state, owner, props.revision]);
  return <section className="panel" aria-label="Business activity"><h2>Business activity</h2><p>Committed business facts. Live Run progress is shown in Timeline; technical details are shown in Diagnostics.</p>
    <label>Activity scope<select value={global ? 'global' : 'session'} onChange={event => setGlobal(event.target.value === 'global')}><option value="session">Current Session</option><option value="global">Global imports and data operations</option></select></label>
    <button disabled={loading || props.host.state !== 'ready' || !global && !sessionId} onClick={() => void read()}>Refresh activity</button>
    {error && <p role="alert">{error}</p>}{page && !page.items.length && <p>No recorded activity.</p>}
    <ol>{page?.items.map(item => <li key={item.id}>{item.type} · {item.actor} · {item.occurredAt}{item.queryId && ` · Query ${item.queryId}`}{item.artifactId && ` · Artifact ${item.artifactId}`}{item.runId && ` · Run ${item.runId}`}<br /><code>{item.operationRef}</code></li>)}</ol>
    {page?.nextBeforeEventId && <button disabled={loading} onClick={() => void read(page.nextBeforeEventId!)}>More activity</button>}
  </section>;
}
