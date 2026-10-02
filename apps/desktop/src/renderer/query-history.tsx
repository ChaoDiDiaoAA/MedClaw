import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../../packages/contracts/src/error';
import type { HostView } from '../../../../packages/contracts/src/model';
import type { PublicReturn } from '../../../../packages/contracts/src/protocol';
import type { ActiveRunView } from '../../../../packages/contracts/src/run';
import type { QueryParams } from '../../../../packages/contracts/src/query';
import type { WorkspaceChange, WorkspaceView } from '../../../../packages/contracts/src/workspace';
import { QueryPanel, queryBasisLabel, queryDataDatesLabel, queryQuantityLabel } from './query-panel';

export function QueryHistory(props: { visible: boolean; requestedQueryId: number | null; host: HostView; workspace: WorkspaceView | null; confirmed: boolean; active: ActiveRunView | null; onUpdate: (change: WorkspaceChange) => Promise<boolean>; onError: (message: string | null) => void }) {
  const [history, setHistory] = useState<PublicReturn<'query.list'> | null>(null), [view, setView] = useState<PublicReturn<'query.read'> | null>(null), [evidence, setEvidence] = useState<PublicReturn<'evidence.read'> | null>(null), [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<{ sessionId: number; runId: number; operationRef: string; uncertain: boolean; payload: { params: QueryParams; expectedRevision: number } } | null>(null);
  const target = useRef<{ instanceId: string | null; sessionId: number | null; queryId: number | null }>({ instanceId: props.host.instanceId, sessionId: props.workspace?.sessionId ?? null, queryId: null }), order = useRef(0), listOrder = useRef(0), mounted = useRef(true);
  target.current.instanceId = props.host.instanceId; target.current.sessionId = props.workspace?.sessionId ?? null;
  const capture = () => ({ ...target.current, order: ++order.current });
  const owns = (scope: ReturnType<typeof capture>) => mounted.current && scope.order === order.current && scope.instanceId === target.current.instanceId && scope.sessionId === target.current.sessionId && scope.queryId === target.current.queryId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { order.current++; listOrder.current++; target.current.queryId = null; setHistory(null); setView(null); setEvidence(null); setLoading(false); }, [props.host.instanceId, props.workspace?.sessionId]);
  useEffect(() => { setPending(value => value ? { ...value, uncertain: true } : null); }, [props.host.instanceId]);
  useEffect(() => { if (props.visible && props.host.state === 'ready') void readHistory(); }, [props.visible, props.host.state, props.host.instanceId, props.workspace?.sessionId, props.active?.runId]);
  useEffect(() => { if (props.visible && props.confirmed && props.requestedQueryId && props.host.state === 'ready') void readQuery(props.requestedQueryId); }, [props.visible, props.confirmed, props.requestedQueryId, props.host.instanceId, props.workspace?.sessionId]);
  async function readHistory(beforeQueryId?: number) {
    const instanceId = target.current.instanceId, sessionId = target.current.sessionId, token = ++listOrder.current;
    if (!sessionId) return;
    const result = await window.medclaw.request('query.list', { sessionId, limit: 20, ...(beforeQueryId ? { beforeQueryId } : {}) });
    if (!mounted.current || instanceId !== target.current.instanceId || sessionId !== target.current.sessionId || token !== listOrder.current) return;
    if (result.ok) setHistory(old => beforeQueryId && old ? { items: [...old.items, ...result.data.items.filter(query => !old.items.some(known => known.id === query.id))], nextBeforeQueryId: result.data.nextBeforeQueryId } : result.data);
    else props.onError(errorMessage(result.error));
  }
  async function readQuery(queryId: number, page = 1) {
    if (target.current.queryId !== queryId) { target.current.queryId = queryId; setView(null); setEvidence(null); }
    const scope = capture(); setLoading(true);
    const result = await window.medclaw.request('query.read', { queryId, page, pageSize: 50 });
    if (!owns(scope)) return;
    if (result.ok && result.data.query.id === queryId && result.data.query.sessionId === scope.sessionId) setView(result.data);
    else props.onError(result.ok ? 'The saved query belongs to another session.' : errorMessage(result.error));
    setLoading(false);
  }
  async function readEvidence(evidenceId: number, page = 1) {
    const queryId = target.current.queryId; if (!queryId) return;
    const scope = capture(); setLoading(true);
    const result = await window.medclaw.request('evidence.read', { queryId, evidenceId, page, pageSize: 50 });
    if (!owns(scope)) return;
    if (result.ok && result.data.evidence.queryId === queryId && result.data.evidence.id === evidenceId) setEvidence(result.data);
    else props.onError(result.ok ? 'The evidence reply does not match this query.' : errorMessage(result.error));
    setLoading(false);
  }
  async function execute(params: QueryParams) {
    if (!props.workspace?.sessionId || !props.active || pending || !props.confirmed) return;
    const original = { sessionId: props.workspace.sessionId, runId: props.active.runId, operationRef: crypto.randomUUID(), uncertain: false, payload: { params, expectedRevision: props.workspace.revision } };
    setPending(original); await submit(original);
  }
  async function submit(original: NonNullable<typeof pending>) {
    const scope = capture(); setLoading(true); props.onError(null);
    const result = await window.medclaw.request('query.execute', original.payload, original.operationRef);
    if (!mounted.current || scope.instanceId !== target.current.instanceId) return;
    if (!result.ok) {
      if (owns(scope)) props.onError(errorMessage(result.error));
      if (result.error.code === 'operation_result_unknown') setPending(value => value?.operationRef === original.operationRef ? { ...value, uncertain: true } : value);
      else if (!original.uncertain) setPending(value => value?.operationRef === original.operationRef ? null : value);
    } else {
      const matchesOriginal = result.data.query.sessionId === original.sessionId && result.data.query.runId === original.runId;
      if (matchesOriginal) setPending(value => value?.operationRef === original.operationRef ? null : value);
      if (owns(scope) && matchesOriginal) {
        target.current.queryId = result.data.query.id; setView(result.data); setEvidence(null); await readHistory();
      } else if (owns(scope)) props.onError('The query reply does not match the original Run and Session. Read its saved identity before continuing.');
    }
    if (scope.instanceId === target.current.instanceId && scope.sessionId === target.current.sessionId) setLoading(false);
  }
  async function findOriginal() {
    if (!pending) return;
    const original = pending, instanceId = target.current.instanceId;
    const result = await window.medclaw.request('query.list', { sessionId: original.sessionId, limit: 50 });
    if (!mounted.current || instanceId !== target.current.instanceId) return;
    if (!result.ok) { props.onError(errorMessage(result.error)); return; }
    const query = result.data.items.find(query => query.callRef === original.operationRef);
    if (!query) { props.onError('The original query was not found on this history page. Keep its operation ID; resend the original request to read a saved result without creating a replacement Run.'); return; }
    setPending(value => value?.operationRef === original.operationRef ? null : value);
    if (target.current.sessionId === original.sessionId) await readQuery(query.id);
  }
  const executeReason = props.host.state !== 'ready' ? 'Waiting for Host to be ready.' : !props.confirmed ? 'Confirm the current data selection first.' : !props.workspace?.sessionId ? 'Select a Session first.' : pending ? 'Read the original query result before starting another query.' : !props.workspace.batchRefs.length ? 'Select imported batches in Data Workspace first.' : !props.active || props.active.kind !== 'agent' || props.active.sessionId !== props.workspace.sessionId ? 'A query form uses the original active Run for this Session. Start a message, or ask the Agent to query the selected data.' : props.active.stopPending || props.active.persistencePending ? 'The original Run is stopping or waiting to save.' : null;
  return <div className="query-history-layout">
    <section className="panel"><div className="section-heading"><div><span className="eyebrow">Saved facts for this Session</span><h2>Query history</h2></div><button disabled={props.host.state !== 'ready' || !props.workspace?.sessionId} onClick={() => void readHistory()}>Refresh query history</button></div>
      {!props.workspace?.sessionId ? <p className="muted">Select a Session to read its saved queries.</p> : history && !history.items.length ? <p className="muted">No saved queries yet. Ask the Agent to query the selected batches.</p> : !history ? <p className="muted">Query history has not been read yet.</p> : <div className="query-history-list">{history.items.map(query => <button key={query.id} aria-label={`Read Query ${query.id} from Run ${query.runId}`} className={view?.query.id === query.id ? 'selected' : ''} onClick={() => void readQuery(query.id)}><strong>Query {query.id} · {query.kind}</strong><span>{query.interpretation ? `${queryQuantityLabel(query.interpretation)} · ${queryBasisLabel[query.interpretation.basis]}` : `${query.totalRows} result rows`} · Run {query.runId}</span>{query.interpretation && <span className="tiny muted">Requested {query.interpretation.requestedDate ?? (query.interpretation.requestedTime ? `${query.interpretation.requestedTime.start} – ${query.interpretation.requestedTime.endExclusive} (exclusive)` : 'Not recorded')} · Data {queryDataDatesLabel(query.interpretation.dataDates)}{query.interpretation.status ? ` · ${query.interpretation.status}` : ''}</span>}<span className="tiny muted">{query.createdAt}</span></button>)}</div>}
      {history?.nextBeforeQueryId && <button disabled={loading} onClick={() => void readHistory(history.nextBeforeQueryId!)}>Read earlier queries</button>}
      {view && <button disabled={!props.confirmed || loading} onClick={() => void props.onUpdate({ batchIds: view.query.batchIds, deviceIds: view.query.scopeDeviceIds ?? [], queryId: view.query.id, activeView: 'query' })}>Use Query {view.query.id} for next message</button>}
      {pending && <div className="persistence-notice" role="status"><p>Original query · Session {pending.sessionId} · Run {pending.runId}</p><p className="tiny"><code>{pending.operationRef}</code></p><div className="actions"><button disabled={props.host.state !== 'ready' || loading} onClick={() => void findOriginal()}>Read original query result</button><button disabled={props.host.state !== 'ready' || loading} onClick={() => void submit(pending)}>Resend original query</button></div></div>}
    </section>
    <QueryPanel workspace={props.workspace} query={view?.query ?? null} page={view?.page ?? null} evidence={evidence} loading={loading} executeReason={executeReason} onPage={page => { if (view) void readQuery(view.query.id, page); }} onEvidence={id => void readEvidence(id)} onEvidencePage={page => { if (evidence) void readEvidence(evidence.evidence.id, page); }} onExecute={execute} />
  </div>;
}
