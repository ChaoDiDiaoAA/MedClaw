import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../../packages/contracts/src/error';
import type { HostView } from '../../../../packages/contracts/src/model';
import type { PublicReturn } from '../../../../packages/contracts/src/protocol';
import type { ActiveRunView } from '../../../../packages/contracts/src/run';
import type { QueryParams } from '../../../../packages/contracts/src/query';
import type { WorkspaceChange, WorkspaceView } from '../../../../packages/contracts/src/workspace';
import { QueryPanel, queryBasisLabel, queryDataDatesLabel, queryQuantityLabel } from './query-panel';
import type { SessionDraft } from './session-list';
import { ExportPanel } from './export-panel';
import { ActivityPanel } from './activity-panel';
import { QueryTrend } from './query-trend';

export function QueryHistory(props: { visible: boolean; requestedQuery: { queryId: number; ownerSessionId: number } | null; host: HostView; workspace: WorkspaceView | null; confirmed: boolean; writable: boolean; active: ActiveRunView | null; onData?: () => void; onChat?: () => void; onUpdate: (change: WorkspaceChange) => Promise<boolean>; onError: (message: string | null) => void;
  formRun:{sessionId:number;runId:number;inputId:number}|null;formPending:SessionDraft['pending'];formResendConfirmed:boolean;formReason:string|null;
  onSubmitForm:(params:QueryParams)=>Promise<void>;onReadSubmission:()=>Promise<void>;onResendSubmission:()=>Promise<void> }) {
  const [history, setHistory] = useState<PublicReturn<'query.list'> | null>(null), [view, setView] = useState<PublicReturn<'query.read'> | null>(null), [evidence, setEvidence] = useState<PublicReturn<'evidence.read'> | null>(null), [loading, setLoading] = useState(false);
  const formReadOrder=useRef(0);
  const [task, setTask] = useState<'history' | 'form' | 'result'>('history'), [exportOpen, setExportOpen] = useState(false), [activityOpen, setActivityOpen] = useState(false);
  const [historyState, setHistoryState] = useState<'unread' | 'loading' | 'ready' | 'error'>('unread'), [historyError, setHistoryError] = useState<string | null>(null);
  const [activityRevision, setActivityRevision] = useState(0);
  const target = useRef<{ instanceId: string | null; sessionId: number | null; queryId: number | null; ownerSessionId: number | null }>({ instanceId: props.host.instanceId, sessionId: props.workspace?.sessionId ?? null, queryId: null, ownerSessionId: null }), order = useRef(0), listOrder = useRef(0), mounted = useRef(true);
  target.current.instanceId = props.host.instanceId; target.current.sessionId = props.workspace?.sessionId ?? null;
  const capture = () => ({ ...target.current, order: ++order.current });
  const owns = (scope: ReturnType<typeof capture>) => mounted.current && scope.order === order.current && scope.instanceId === target.current.instanceId && scope.ownerSessionId === target.current.ownerSessionId && scope.queryId === target.current.queryId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { order.current++; listOrder.current++; target.current.queryId = null; setHistory(null); setView(null); setEvidence(null); setLoading(false); setHistoryState('unread'); setHistoryError(null); setTask('history'); setExportOpen(false); }, [props.host.instanceId, props.workspace?.sessionId]);
  useEffect(()=>{
    const token=++formReadOrder.current,form=props.formRun,instance=props.host.instanceId;
    if(!props.visible||props.host.state!=='ready'||!form||form.sessionId!==props.workspace?.sessionId)return;
    let found = false;
    const read = () => void window.medclaw.request('intent.read',{runId:form.runId}).then(result=>{
      if(!mounted.current||token!==formReadOrder.current||instance!==target.current.instanceId||form.sessionId!==target.current.sessionId)return;
      if(!result.ok){props.onError(errorMessage(result.error));return;}
      const saved=result.data;
      if(saved?.decision?.decisionSource!=='user_form'||saved.inputId!==form.inputId||saved.sessionId!==form.sessionId)return;
      if(saved.execution.queryIds.length===1&&!found){found=true;void readQuery(saved.execution.queryIds[0]!,undefined,form.sessionId);}
    }).catch(()=>{if(token===formReadOrder.current&&instance===target.current.instanceId)props.onError('The original query submission could not be read.');});
    read(); const timer = props.active?.runId === form.runId ? setInterval(() => { if (!found) read(); }, 1000) : undefined;
    return ()=>{formReadOrder.current++;clearInterval(timer);};
  },[props.visible,props.host.state,props.host.instanceId,props.workspace?.sessionId,props.formRun,props.active?.runId]);
  useEffect(() => { if (props.visible && props.host.state === 'ready') void readHistory(); }, [props.visible, props.host.state, props.host.instanceId, props.workspace?.sessionId, props.active?.runId]);
  useEffect(() => { if (props.visible && props.requestedQuery && props.host.state === 'ready') void readQuery(props.requestedQuery.queryId, undefined, props.requestedQuery.ownerSessionId); }, [props.visible, props.requestedQuery, props.host.state, props.host.instanceId, props.workspace?.sessionId]);
  async function readHistory(beforeQueryId?: number) {
    const instanceId = target.current.instanceId, sessionId = target.current.sessionId, token = ++listOrder.current;
    if (!sessionId) return;
    setHistoryState('loading'); setHistoryError(null);
    try {
      const result = await window.medclaw.request('query.list', { sessionId, ...(beforeQueryId ? { beforeQueryId } : {}) });
      if (!mounted.current || instanceId !== target.current.instanceId || sessionId !== target.current.sessionId || token !== listOrder.current) return;
      if (result.ok) { setHistory(old => beforeQueryId && old ? { items: [...old.items, ...result.data.items.filter(query => !old.items.some(known => known.id === query.id))], nextBeforeQueryId: result.data.nextBeforeQueryId } : result.data); setHistoryState('ready'); }
      else { setHistoryState('error'); setHistoryError(errorMessage(result.error)); props.onError(errorMessage(result.error)); }
    } catch { if (mounted.current && instanceId === target.current.instanceId && sessionId === target.current.sessionId && token === listOrder.current) { setHistoryState('error'); setHistoryError('Query history could not be read. Refresh query history to try again.'); } }
  }
  async function readQuery(queryId: number, page?: number, ownerSessionId = view?.query.id === queryId ? view.query.sessionId : props.workspace?.sessionId ?? null) {
    setTask('result');
    if (target.current.queryId !== queryId) { target.current.queryId = queryId; setView(null); setEvidence(null); }
    target.current.ownerSessionId = ownerSessionId;
    const scope = capture(); setLoading(true);
    const result = await window.medclaw.request('query.read', { queryId, page });
    if (!owns(scope)) return;
    if (result.ok && result.data.query.id === queryId && result.data.query.sessionId === scope.ownerSessionId) setView(result.data);
    else props.onError(result.ok ? 'The saved query belongs to another session.' : errorMessage(result.error));
    setLoading(false);
  }
  async function readEvidence(evidenceId: number, page?: number) {
    const queryId = target.current.queryId; if (!queryId) return;
    const scope = capture(); setLoading(true);
    const result = await window.medclaw.request('evidence.read', { queryId, evidenceId, page });
    if (!owns(scope)) return;
    if (result.ok && result.data.evidence.queryId === queryId && result.data.evidence.id === evidenceId) setEvidence(result.data);
    else props.onError(result.ok ? 'The evidence reply does not match this query.' : errorMessage(result.error));
    setLoading(false);
  }
  async function execute(params: QueryParams) {
    if (!props.workspace?.sessionId || executeReason) return;
    const scope=capture();setLoading(true);props.onError(null);
    const sameScope=view&&view.query.batchIds.length===params.batchIds.length&&params.batchIds.every(id=>view.query.batchIds.includes(id))
      &&(view.query.scopeDeviceIds??[]).length===props.workspace.deviceIds.length&&props.workspace.deviceIds.every(id=>view.query.scopeDeviceIds?.includes(id));
    // Adopting a Query also adopts its actual source scope; keep the user's wider selection.
    try{if(view&&sameScope&&view.query.sessionId===props.workspace.sessionId&&view.query.sourceAvailability!=='deleted'&&props.workspace.queryId!==view.query.id){
      if(!await props.onUpdate({queryId:view.query.id,activeView:'query'}))return;
    }await props.onSubmitForm(params);if(owns(scope))await readHistory();}
    finally{if(owns(scope))setLoading(false);}
  }
  const executeReason = props.host.state !== 'ready' ? 'Waiting for Host to be ready.' : !props.confirmed ? 'Confirm the current data selection first.' : !props.workspace?.sessionId ? 'Select a Session first.' : !props.workspace.batchRefs.length ? 'Select imported batches in Data Workspace first.' : props.active?'Wait for the active Run and its saving to settle.':props.formReason;
  return <div className="query-history-layout">
    <div className="task-page-heading"><div><h2>Query history</h2><p className="muted">Read saved results or query the selected data.</p></div><div className="task-page-actions"><button className="primary" disabled={props.host.state !== 'ready' || !props.workspace?.sessionId} onClick={() => setTask('form')}>New query</button>{task !== 'history' && <button onClick={() => setTask('history')}>Back to query history</button>}<button aria-expanded={activityOpen} onClick={() => setActivityOpen(value => !value)}>View activity</button>{task === 'result' && view && <><button onClick={() => setTask('form')}>Edit query conditions</button><button aria-expanded={exportOpen} onClick={() => setExportOpen(value => !value)}>Export saved result</button></>}</div></div>
    {historyError && <p role="alert" className="error-text">{historyError}</p>}
    <section className="panel query-task-list" hidden={task !== 'history'}><div className="section-heading"><h3>Saved queries</h3><button disabled={props.host.state !== 'ready' || !props.workspace?.sessionId || historyState === 'loading'} onClick={() => void readHistory()}>Refresh query history</button></div>
      {props.host.state !== 'ready' ? <p role="status">Query history is unavailable while Host is not ready.</p> : !props.workspace?.sessionId ? <div className="workspace-empty"><p>Select a Session to read its saved queries.</p>{props.onChat && <button onClick={props.onChat}>Open Chat</button>}</div> : historyState === 'loading' && !history ? <p role="status">Reading query history…</p> : historyState === 'error' && !history ? null : history && !history.items.length ? <div className="workspace-empty"><h3>No saved queries yet.</h3>{!props.workspace.batchRefs.length ? <><p className="muted">Select imported batches to start a query.</p>{props.onData && <button onClick={props.onData}>Open Data Workspace</button>}</> : <p className="muted">Start a new query or ask the Agent about the selected batches.</p>}</div> : !history ? <p className="muted">Query history has not been read yet.</p> : <div className="query-history-list">{history.items.map(query => <button key={query.id} aria-label={`Read Query ${query.id} from Run ${query.runId}`} className={view?.query.id === query.id ? 'selected' : ''} onClick={() => void readQuery(query.id)}><strong>Query {query.id} · {query.kind}</strong><span>{query.interpretation ? `${queryQuantityLabel(query.interpretation)} · ${queryBasisLabel[query.interpretation.basis]}` : `${query.totalRows} result rows`}</span>{query.interpretation && <span className="tiny muted">Requested {query.interpretation.requestedDate ?? (query.interpretation.requestedTime ? `${query.interpretation.requestedTime.start} – ${query.interpretation.requestedTime.endExclusive} (exclusive)` : 'Not recorded')} · Data {queryDataDatesLabel(query.interpretation.dataDates)}{query.interpretation.status ? ` · ${query.interpretation.status}` : ''}</span>}<span className="tiny muted">{query.createdAt}</span></button>)}</div>}
      {history?.nextBeforeQueryId && <button disabled={loading} onClick={() => void readHistory(history.nextBeforeQueryId!)}>Read earlier queries</button>}
    </section>
      {task === 'result' && view && <div className="query-task-toolbar"><p role="status">Viewing Query {view.query.id} from Session {view.query.sessionId}</p><button disabled={!props.confirmed || loading || view.query.sourceAvailability === "deleted" || view.query.sessionId !== props.workspace?.sessionId} onClick={() => void props.onUpdate({ batchIds: view.query.batchIds, deviceIds: view.query.scopeDeviceIds ?? [], queryId: view.query.id, activeView: 'query' })}>Use Query {view.query.id} for next message</button></div>}
      {props.formPending?.input.mode==='send'&&props.formPending.input.routing?.mode==='user_form' && <div className="persistence-notice" role="status"><p>Read the original query submission before another query.</p><details className="advanced-section"><summary>Original query submission identity</summary><p>Original query submission · Session {props.formPending.input.sessionId} · Sequence {props.formPending.input.clientSequence}</p><p className="tiny"><code>{props.formPending.operationRef}</code></p></details><div className="actions"><button disabled={props.host.state !== 'ready' || loading} onClick={() => void props.onReadSubmission()}>Read original query submission</button><button disabled={props.host.state !== 'ready' || loading || !props.formResendConfirmed} onClick={() => void props.onResendSubmission()}>Resend original query submission</button></div></div>}
    <QueryPanel formVisible={task === 'form'} resultVisible={task === 'result'} workspace={props.workspace} query={view?.query ?? null} page={view?.page ?? null} evidence={evidence} loading={loading} canSelect={props.confirmed && view?.query.sessionId === props.workspace?.sessionId} onSelect={selection => view ? props.onUpdate({ queryId: view.query.id, activeView: selection.kind === "evidence" ? "evidence" : "query", selection }) : Promise.resolve(false)} executeReason={executeReason} onPage={page => { if (view) void readQuery(view.query.id, page); }} onEvidence={id => void readEvidence(id)} onEvidencePage={page => { if (evidence) void readEvidence(evidence.evidence.id, page); }} onExecute={execute} />
    {view?.query.kind === 'trend' && <div hidden={task !== 'result'}><QueryTrend query={view.query} instanceId={props.host.instanceId} visible={props.visible && props.host.state === 'ready'} /></div>}
    {view && <ExportPanel expanded={exportOpen && task === 'result'} visible={props.visible} host={props.host} query={view.query} writable={props.writable && props.confirmed && view.query.sessionId === props.workspace?.sessionId} onChanged={() => setActivityRevision(value => value + 1)} />}
    <ActivityPanel expanded={activityOpen} visible={props.visible} host={props.host} sessionId={props.workspace?.sessionId ?? null} revision={`${activityRevision}:${props.active?.runId ?? ''}:${props.formRun?.runId ?? ''}`} />
  </div>;
}
