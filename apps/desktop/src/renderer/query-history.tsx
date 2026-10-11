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

export function QueryHistory(props: { visible: boolean; requestedQuery: { queryId: number; ownerSessionId: number } | null; host: HostView; workspace: WorkspaceView | null; confirmed: boolean; writable: boolean; active: ActiveRunView | null; onUpdate: (change: WorkspaceChange) => Promise<boolean>; onError: (message: string | null) => void;
  formRun:{sessionId:number;runId:number;inputId:number}|null;formPending:SessionDraft['pending'];formResendConfirmed:boolean;formReason:string|null;
  onSubmitForm:(params:QueryParams)=>Promise<void>;onReadSubmission:()=>Promise<void>;onResendSubmission:()=>Promise<void> }) {
  const [history, setHistory] = useState<PublicReturn<'query.list'> | null>(null), [view, setView] = useState<PublicReturn<'query.read'> | null>(null), [evidence, setEvidence] = useState<PublicReturn<'evidence.read'> | null>(null), [loading, setLoading] = useState(false);
  const formReadOrder=useRef(0);
  const [activityRevision, setActivityRevision] = useState(0);
  const target = useRef<{ instanceId: string | null; sessionId: number | null; queryId: number | null; ownerSessionId: number | null }>({ instanceId: props.host.instanceId, sessionId: props.workspace?.sessionId ?? null, queryId: null, ownerSessionId: null }), order = useRef(0), listOrder = useRef(0), mounted = useRef(true);
  target.current.instanceId = props.host.instanceId; target.current.sessionId = props.workspace?.sessionId ?? null;
  const capture = () => ({ ...target.current, order: ++order.current });
  const owns = (scope: ReturnType<typeof capture>) => mounted.current && scope.order === order.current && scope.instanceId === target.current.instanceId && scope.ownerSessionId === target.current.ownerSessionId && scope.queryId === target.current.queryId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { order.current++; listOrder.current++; target.current.queryId = null; setHistory(null); setView(null); setEvidence(null); setLoading(false); }, [props.host.instanceId, props.workspace?.sessionId]);
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
    const result = await window.medclaw.request('query.list', { sessionId, ...(beforeQueryId ? { beforeQueryId } : {}) });
    if (!mounted.current || instanceId !== target.current.instanceId || sessionId !== target.current.sessionId || token !== listOrder.current) return;
    if (result.ok) setHistory(old => beforeQueryId && old ? { items: [...old.items, ...result.data.items.filter(query => !old.items.some(known => known.id === query.id))], nextBeforeQueryId: result.data.nextBeforeQueryId } : result.data);
    else props.onError(errorMessage(result.error));
  }
  async function readQuery(queryId: number, page?: number, ownerSessionId = view?.query.id === queryId ? view.query.sessionId : props.workspace?.sessionId ?? null) {
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
    <section className="panel"><div className="section-heading"><div><span className="eyebrow">Saved facts for this Session</span><h2>Query history</h2></div><button disabled={props.host.state !== 'ready' || !props.workspace?.sessionId} onClick={() => void readHistory()}>Refresh query history</button></div>
      {!props.workspace?.sessionId ? <p className="muted">Select a Session to read its saved queries.</p> : history && !history.items.length ? <p className="muted">No saved queries yet. Ask the Agent to query the selected batches.</p> : !history ? <p className="muted">Query history has not been read yet.</p> : <div className="query-history-list">{history.items.map(query => <button key={query.id} aria-label={`Read Query ${query.id} from Run ${query.runId}`} className={view?.query.id === query.id ? 'selected' : ''} onClick={() => void readQuery(query.id)}><strong>Query {query.id} · {query.kind}</strong><span>{query.interpretation ? `${queryQuantityLabel(query.interpretation)} · ${queryBasisLabel[query.interpretation.basis]}` : `${query.totalRows} result rows`} · Run {query.runId}</span>{query.interpretation && <span className="tiny muted">Requested {query.interpretation.requestedDate ?? (query.interpretation.requestedTime ? `${query.interpretation.requestedTime.start} – ${query.interpretation.requestedTime.endExclusive} (exclusive)` : 'Not recorded')} · Data {queryDataDatesLabel(query.interpretation.dataDates)}{query.interpretation.status ? ` · ${query.interpretation.status}` : ''}</span>}<span className="tiny muted">{query.createdAt}</span></button>)}</div>}
      {history?.nextBeforeQueryId && <button disabled={loading} onClick={() => void readHistory(history.nextBeforeQueryId!)}>Read earlier queries</button>}
      {view && <p role="status">Viewing Query {view.query.id} from Session {view.query.sessionId}</p>}{view && <button disabled={!props.confirmed || loading || view.query.sourceAvailability === "deleted" || view.query.sessionId !== props.workspace?.sessionId} onClick={() => void props.onUpdate({ batchIds: view.query.batchIds, deviceIds: view.query.scopeDeviceIds ?? [], queryId: view.query.id, activeView: 'query' })}>Use Query {view.query.id} for next message</button>}
      {props.formPending?.input.mode==='send'&&props.formPending.input.routing?.mode==='user_form' && <div className="persistence-notice" role="status"><p>Original query submission · Session {props.formPending.input.sessionId} · Sequence {props.formPending.input.clientSequence}</p><p className="tiny"><code>{props.formPending.operationRef}</code></p><div className="actions"><button disabled={props.host.state !== 'ready' || loading} onClick={() => void props.onReadSubmission()}>Read original query submission</button><button disabled={props.host.state !== 'ready' || loading || !props.formResendConfirmed} onClick={() => void props.onResendSubmission()}>Resend original query submission</button></div></div>}
    </section>
    <QueryPanel workspace={props.workspace} query={view?.query ?? null} page={view?.page ?? null} evidence={evidence} loading={loading} canSelect={props.confirmed && view?.query.sessionId === props.workspace?.sessionId} onSelect={selection => view ? props.onUpdate({ queryId: view.query.id, activeView: selection.kind === "evidence" ? "evidence" : "query", selection }) : Promise.resolve(false)} executeReason={executeReason} onPage={page => { if (view) void readQuery(view.query.id, page); }} onEvidence={id => void readEvidence(id)} onEvidencePage={page => { if (evidence) void readEvidence(evidence.evidence.id, page); }} onExecute={execute} />
    {view?.query.kind === 'trend' && <QueryTrend query={view.query} instanceId={props.host.instanceId} visible={props.visible && props.host.state === 'ready'} />}
    {view && <ExportPanel visible={props.visible} host={props.host} query={view.query} writable={props.writable && props.confirmed && view.query.sessionId === props.workspace?.sessionId} onChanged={() => setActivityRevision(value => value + 1)} />}
    <ActivityPanel visible={props.visible} host={props.host} sessionId={props.workspace?.sessionId ?? null} revision={`${activityRevision}:${props.active?.runId ?? ''}:${props.formRun?.runId ?? ''}`} />
  </div>;
}
