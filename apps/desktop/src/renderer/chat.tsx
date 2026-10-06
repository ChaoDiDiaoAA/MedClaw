import { errorMessage, safeError, type Result } from "../../../../packages/contracts/src/error";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HostView, ModelChoice, ModelDirectoryView } from "../../../../packages/contracts/src/model";
import type { ActiveRunView, RunView, RuntimeControlView } from "../../../../packages/contracts/src/run";
import type { InputMode, SessionDetail, SessionInput,CompactionOperationView } from "../../../../packages/contracts/src/session";
import type { SessionCheckpoint, SessionCheckpointPage, SessionCheckpointReceipt, RestoreSessionCheckpointInput, RestoreSessionInput } from '../../../../packages/contracts/src/session';
import type { WorkspaceChange, WorkspaceView } from "../../../../packages/contracts/src/workspace";
import { sessionDisplayTitle, type SessionDraft } from "./session-list";
import { ContextPanel } from "./context-panel";
import type { SessionMessagePage, SessionMessageView } from "../../../../packages/contracts/src/messages";
import type { PublicReturn } from "../../../../packages/contracts/src/protocol";
import { type InputQueueSnapshot } from "./input-queue";
import { finalDisplaySource, resolveReadingAnchor, shouldRecordScroll, type ReadingAnchor, type RunEventProjectionState } from './use-run-events';
import type { DirectoryReadStatus } from './models-page';

// Each public page stays bounded; the displayed collection is independent of that DTO.
type MessageAvailability = { available: boolean; hasPage: boolean; hasHistory: boolean; hasMore: boolean; unavailable: boolean; runCovered: boolean };
export function NativeMessages(props: { host: HostView; sessionId: number | null; nativeSessionId?: string | null; visible: boolean;
  context: string; revision?: string | null; testId: string; requiredRunId?: number | null; excludeRunId?: number | null; onChanged?: () => void; onAvailability?: (value: MessageAvailability) => void; onCreate?: () => void }) {
  const key = JSON.stringify([props.host.instanceId, props.host.state, props.sessionId, props.nativeSessionId, props.visible, props.context, props.revision]);
  const target = useRef({ key, epoch: 0 }), generation = useRef(0), mounted = useRef(true);
  if (target.current.key !== key) { target.current = { key, epoch: target.current.epoch + 1 }; generation.current++; }
  type View = { key: string; sessionId: number | null; pages: SessionMessagePage[]; loading: boolean; error: string | null };
  const [view, setView] = useState<View>({ key, sessionId: props.sessionId, pages: [], loading: false, error: null }), viewRef = useRef(view);
  const [reference, setReference] = useState<string | null>(null), referenceOrder = useRef(0);
  const current = view.key === key ? view : view.sessionId === props.sessionId ? { ...view, loading: false } : { key, sessionId: props.sessionId, pages: [], loading: false, error: null }, last = current.pages.at(-1);
  const write = (value: View) => { viewRef.current = value; setView(value); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; referenceOrder.current++; }; }, []);
  useEffect(() => { referenceOrder.current++; setReference(null); if (props.visible && props.host.state === 'ready' && props.sessionId) void read(false); }, [key, props.revision]);
  // Startup may read the current path before its separately requested Run arrives.
  // Reconcile that Run against already verified pages without another history read.
  useEffect(() => { if(view.key===key&&!current.loading&&!current.error&&current.pages.length) availability(current.pages,true); }, [key,props.requiredRunId,current.pages,current.loading,current.error,view.key]);
  function availability(pages: SessionMessagePage[], available: boolean, unavailable = false) {
    props.onAvailability?.({ available, unavailable: unavailable && pages.length === 0, hasPage: pages.length > 0, hasHistory: pages.some(value => value.items.length > 0 || value.hasMore), hasMore: pages.at(-1)?.hasMore ?? false,
      runCovered: !!props.requiredRunId && pages.some(page => page.items.some(item => item.runId === props.requiredRunId || item.references.includes('run:' + props.requiredRunId))) });
  }
  async function read(append: boolean) {
    if (!props.visible || props.host.state !== 'ready' || !props.sessionId || !props.host.instanceId) return;
    const old = viewRef.current.key === key ? viewRef.current : { key, sessionId: props.sessionId, pages: [], loading: false, error: null }, tail = old.pages.at(-1);
    if (append && (!tail?.hasMore || old.loading)) return;
    const leafId = append ? tail!.leafId : null, afterEntryId = append ? tail!.nextEntryId : null;
    const scope = { ...target.current, instanceId: props.host.instanceId, sessionId: props.sessionId, generation: ++generation.current, leafId, afterEntryId };
    const owns = () => mounted.current && target.current.key === scope.key && target.current.epoch === scope.epoch && generation.current === scope.generation;
    referenceOrder.current++; setReference(null);
    write({ ...old, loading: true, error: null });
    try {
      const result = await window.medclaw.request('session.messages.read', { sessionId: scope.sessionId, leafId, afterEntryId, limit: 50 });
      if (!owns()) return;
      if (!result.ok) {
        const unavailable = ['resource_unavailable', 'session_history_unavailable', 'session_history_invalid'].includes(result.error.code) && !old.pages.length;
        write({ ...old, loading: true, error: (unavailable ? 'Message history unavailable. ' : 'Message history read failed. ') + errorMessage(result.error) }); availability(old.pages, false, unavailable); return;
      }
      const page = result.data, now = viewRef.current.pages.at(-1);
      if (page.sessionId !== scope.sessionId || props.nativeSessionId && page.nativeSessionId !== props.nativeSessionId
        || append && (now?.leafId !== scope.leafId || now?.nextEntryId !== scope.afterEntryId || page.leafId !== scope.leafId || page.nativeSessionId !== now.nativeSessionId)) {
        write({ ...old, loading: true, error: 'Message history read failed. The reply did not match the original session and leaf.' }); availability(old.pages, false); return;
      }
      const pages = append ? [...old.pages, page] : [page];
      write({ key: scope.key, sessionId: scope.sessionId, pages, loading: true, error: null }); props.onChanged?.(); availability(pages, true);
    } catch { if (owns()) { write({ ...old, loading: true, error: 'Message history read failed. Read the original session again.' }); availability(old.pages, false); } }
    finally { if (owns()) write({ ...viewRef.current, loading: false }); }
  }
  async function readReference(message: SessionMessageView, ref: string) {
    const scope = { ...target.current, generation: generation.current, order: ++referenceOrder.current }, sessionId = props.sessionId;
    const owns = () => mounted.current && scope.key === target.current.key && scope.epoch === target.current.epoch && scope.generation === generation.current && scope.order === referenceOrder.current;
    setReference('Reading original reference ' + ref + '…');
    let available = false, summary = '';
    try {
      const [kind, value] = ref.split(':'), id = Number(value);
      if (kind === 'run') {
        const result = await window.medclaw.request('run.read', { runId: id });
        available = result.ok && result.data.kind === 'one' && result.data.run?.id === id && result.data.run.sessionId === sessionId;
        if (result.ok && result.data.kind === 'one' && available) summary = 'Run ' + id + ' · ' + result.data.run!.status + ' · ' + result.data.run!.persistence;
      } else if (kind === 'tool' && message.runId) {
        let lastPage: number | null = null;
        for (let page = 1; lastPage === null || page <= lastPage; page++) {
          if (!owns()) return;
          const result: Result<PublicReturn<'tool.read'>> = await window.medclaw.request('tool.read', { runId: message.runId, page, pageSize: 50 });
          if (!owns()) return;
          if (!result.ok || result.data.runId !== message.runId || result.data.page !== page || result.data.pageSize !== 50) break;
          // Pin the finite read bound from the first original Run page; later growth does not extend it.
          lastPage ??= Math.max(1, Math.ceil(result.data.totalRows / result.data.pageSize));
          const tool = result.data.items.find(item => item.id === id && item.runId === message.runId && item.sessionId === sessionId);
          if (tool) { available = true; summary = 'Tool ' + id + ' · ' + tool.status; break; }
        }
      } else if ((kind === 'query' || kind === 'evidence') && message.runId) {
        const queryId = kind === 'query' ? id : Number(message.references.find(value => value.startsWith('query:'))?.split(':')[1]);
        if (Number.isSafeInteger(queryId) && queryId > 0) {
          const query = await window.medclaw.request('query.read', { queryId, page: 1, pageSize: 50 });
          if (owns() && query.ok && query.data.query.id === queryId && query.data.query.runId === message.runId && query.data.query.sessionId === sessionId) {
            if (kind === 'query') { available = true; summary = 'Query ' + id + ' · ' + query.data.query.totalRows + ' rows'; }
            else {
              const evidence = await window.medclaw.request('evidence.read', { queryId, evidenceId: id, page: 1, pageSize: 50 });
              available = evidence.ok && evidence.data.evidence.id === id && evidence.data.evidence.queryId === queryId;
              if (available) summary = 'Evidence ' + id;
            }
          }
        }
      }
    } catch { /* An unavailable original reference remains visible without selecting another target. */ }
    if (owns()) setReference(available ? summary : 'Original reference ' + ref + ' unavailable. Keep its original Session and Run; read it again there.');
  }
  const seen = new Set<string>(), items = current.pages.flatMap(page => page.items).filter(item => { if (seen.has(item.nativeEntryId)) return false; seen.add(item.nativeEntryId); return !(props.excludeRunId && (item.runId === props.excludeRunId || item.references.includes('run:' + props.excludeRunId))); });
  return <section className="native-messages" data-testid={props.testId} aria-label="Native session messages">
    <div className="section-heading"><h3>Native memory · Session {props.sessionId ?? 'unavailable'}</h3><div className="actions"><button disabled={!props.visible || props.host.state !== 'ready' || !props.sessionId} onClick={() => void read(false)}>Refresh messages</button>{last?.hasMore && <button disabled={current.loading || !props.visible || props.host.state !== 'ready'} onClick={() => void read(true)}>Load more messages</button>}</div></div>
    <p className="tiny muted">Messages at this session's selected history position. Run and Answer saving are separate facts.</p>
    {last?.hasMore && <p className="tiny evidence-gap">Native history page incomplete. Load more messages to read this leaf. Read the full saved output in Run details.</p>}
    {current.pages.length > 0 && view.key !== key && <p className="tiny evidence-gap">Last verified message page from the prior display connection. Current native history is being rechecked.</p>}
    {last && <p className="tiny message-origin">Native session <code>{last.nativeSessionId}</code> · Leaf <code>{last.leafId ?? 'None'}</code> · {last.source === 'native_memory' ? 'Native memory' : 'Saved history'}</p>}
    {current.loading && <p role="status">Reading native messages…</p>}
    {current.error && <p className="error-text" role="alert">{current.error}{current.pages.length ? ' Showing the last read leaf.' : ''}</p>}
    {current.error && props.onCreate && <button onClick={props.onCreate}>Create new session</button>}
    {last && !items.length && !current.error && <p className="muted">{last.hasMore ? 'More native entries are available; this page has no visible messages.' : 'No native messages in this session.'}</p>}
    {items.map(message => <article key={message.nativeEntryId} data-native-entry-id={message.nativeEntryId} data-run-id={message.runId ?? undefined} className="native-message"><strong>{message.displayRole.replaceAll('_', ' ')}</strong>
      <div className="answer-text">{message.text ?? 'Structured native entry; body omitted.'}</div>
      <p className="tiny muted">Native entry <code>{message.nativeEntryId}</code>{message.runId ? ' · Original Run ' + message.runId : ''}{message.toolCallRef ? ' · Tool call ' + message.toolCallRef : ''}</p>
      {message.textInfo.truncated && <p className="tiny muted">Native message display truncated · {message.text?.length ?? 0} / {message.textInfo.totalChars} characters</p>}
      {message.textInfo.redacted && <p className="tiny muted">Unsafe native fields omitted.</p>}
      {!!message.references.length && <div className="actions" aria-label="Original message references">{message.references.map(ref => <button key={ref} onClick={() => void readReference(message, ref)}>Read {ref}</button>)}</div>}
    </article>)}
    {reference && <p role="status" className="tiny">{reference}</p>}
  </section>;
}

export function SessionCheckpoints(props:{host:HostView;session:SessionDetail|null;workspace:WorkspaceView|null;visible:boolean;blocked:boolean;
  onResumeCheckpoint:(input:RestoreSessionCheckpointInput,operationRef:string)=>Promise<Result<SessionCheckpointReceipt>>;
  onRestoreSession:(input:RestoreSessionInput)=>Promise<Result<SessionDetail>>;onHistoryVerified:(sessionId:number,operationRef?:string)=>Promise<void>}) {
  const key=JSON.stringify([props.host.instanceId,props.host.state,props.session?.session.id,props.session?.session.nativeSessionId,props.session?.session.leafId,props.session?.session.storageVersion,props.visible]);
  const identityKey=JSON.stringify([props.host.instanceId,props.host.state,props.session?.session.id,props.visible]);
  const owner=useRef({key,epoch:0}),mounted=useRef(true),order=useRef(0),dialog=useRef<HTMLDialogElement>(null),cancel=useRef<HTMLButtonElement>(null),trigger=useRef<HTMLButtonElement|null>(null);
  const action=useRef({key:identityKey,order:0});if(action.current.key!==identityKey)action.current={key:identityKey,order:action.current.order+1};
  if(owner.current.key!==key){owner.current={key,epoch:owner.current.epoch+1};order.current++;}
  const [page,setPage]=useState<{key:string;value:SessionCheckpointPage}|null>(null),[loading,setLoading]=useState(false),[message,setMessage]=useState<string|null>(null);
  const [selected,setSelected]=useState<SessionCheckpoint|null>(null),[busy,setBusy]=useState(false);
  type Pending={instance:string;input:RestoreSessionCheckpointInput;operationRef:string;receipt:SessionCheckpointReceipt|null;unknown:boolean};
  const [pending,setPending]=useState<Pending|null>(null),pendingRef=useRef(pending);pendingRef.current=pending;
  const current=page?.key===key?page.value:null,original=pending?.input.sessionId===props.session?.session.id?pending:null;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;order.current++;};},[]);
  useEffect(()=>{setSelected(null);setLoading(false);if(props.visible&&props.host.state==='ready'&&props.session)void read(false);},[key]);
  useEffect(()=>{setMessage(null);setBusy(false);},[identityKey]);
  useEffect(()=>{if(selected){dialog.current?.showModal();cancel.current?.focus();}else if(dialog.current?.open)dialog.current.close();},[selected]);
  function close(){setSelected(null);trigger.current?.focus();}
  async function read(append:boolean){
    if(!props.session||props.host.state!=='ready'||!props.visible)return;
    const scope={...owner.current,order:++order.current},sessionId=props.session.session.id,after=append?current?.nextAnswerId:null;
    const owns=()=>mounted.current&&scope.key===owner.current.key&&scope.epoch===owner.current.epoch&&scope.order===order.current;
    setLoading(true);
    try{const result=await window.medclaw.request('session.checkpoints.read',{sessionId,...(after?{afterAnswerId:after}:{}),limit:20});if(!owns())return;
      if(!result.ok){setMessage('Saved turns could not be read. '+errorMessage(result.error));return;}
      if(result.data.sessionId!==sessionId||result.data.storageVersion!==props.session.session.storageVersion){setMessage('History changed. Refresh this session before choosing a saved turn.');return;}
      setPage({key:scope.key,value:{...result.data,items:append?[...current!.items,...result.data.items]:result.data.items}});
    }catch{if(owns())setMessage('Saved turns could not be read. Read this session again.');}finally{if(owns())setLoading(false);}
  }
  async function resume(){
    if(!selected||!props.session||!props.workspace||props.blocked||busy||original?.unknown||!props.host.instanceId)return;
    if(!current)return;const scope={key:identityKey,order:++action.current.order},input={sessionId:props.session.session.id,targetLeafId:selected.nativeLeafId,expectedStorageVersion:current.storageVersion,expectedWorkspaceRevision:props.workspace.revision};
    const attempt:Pending={instance:props.host.instanceId,input,operationRef:crypto.randomUUID(),receipt:null,unknown:false};pendingRef.current=attempt;setPending(attempt);close();setBusy(true);
    let result:Result<SessionCheckpointReceipt>;try{result=await props.onResumeCheckpoint(input,attempt.operationRef);}catch{result={ok:false,error:safeError('operation_result_unknown')};}
    if(!mounted.current||pendingRef.current?.operationRef!==attempt.operationRef)return;
    const unknown=!result.ok&&['operation_result_unknown','resource_unavailable','stop_unconfirmed'].includes(result.error.code);
    const next={...attempt,receipt:result.ok?result.data:null,unknown};pendingRef.current=next;setPending(next);
    if(action.current.key===scope.key&&action.current.order===scope.order){setBusy(false);setMessage(result.ok?'History position saved. Continue with a new message.':result.error.reason==='session_restore_failed'?'History position saved. This session cannot continue yet.':unknown?'Restore result unconfirmed. Read the original restore before another action.':errorMessage(result.error));}
  }
  async function readOriginal(){
    const attempt=pendingRef.current,instance=props.host.instanceId;if(!attempt||!instance||props.host.state!=='ready')return;
    const scope={key:identityKey,order:++action.current.order},owns=()=>mounted.current&&action.current.key===scope.key&&action.current.order===scope.order&&pendingRef.current?.operationRef===attempt.operationRef;
    setBusy(true);
    try{const result=await window.medclaw.request('evidence.readOperation',{kind:'session_checkpoint',operationRef:attempt.operationRef});
      if(!owns())return;
      if(!result.ok){setMessage('Original restore could not be read. '+errorMessage(result.error));return;}
      const receipt=result.data;
      if(!receipt){if(instance!==attempt.instance){await props.onHistoryVerified(attempt.input.sessionId,attempt.operationRef);if(!owns())return;const next={...attempt,unknown:false};pendingRef.current=next;setPending(next);setMessage('Original restore not recorded in this Host. Review saved turns before a new action.');}else setMessage('The original restore is not recorded. Keep its identity and read it again, or restart Host to confirm absence.');return;}
      if(!('targetLeafId' in receipt)||receipt.operationRef!==attempt.operationRef||receipt.sessionId!==attempt.input.sessionId||receipt.targetLeafId!==attempt.input.targetLeafId){setMessage('Original restore reply did not match its owner.');return;}
      const next={...attempt,receipt,unknown:false};pendingRef.current=next;setPending(next);setMessage(`Original restore saved · Session ${receipt.sessionId} · Version ${receipt.storageVersion}.`);
      await props.onHistoryVerified(attempt.input.sessionId,attempt.operationRef);
    }catch{if(owns())setMessage('Original restore could not be read. Keep its identity and read it again.');}finally{if(owns())setBusy(false);}
  }
  async function repair(){
    if(!props.session||props.blocked||busy||original?.unknown)return;const scope={key:identityKey,order:++action.current.order},owns=()=>mounted.current&&scope.key===action.current.key&&scope.order===action.current.order;setBusy(true);
    try{const result=await props.onRestoreSession({sessionId:props.session.session.id,expectedLeafId:props.session.session.leafId});if(owns())setMessage(result.ok?'Session restored. Continue with a new message.':errorMessage(result.error));}
    catch{if(owns())setMessage('Session restore unconfirmed. Refresh this session before continuing.');}finally{if(owns())setBusy(false);}
  }
  return <section className="native-messages" data-testid="session-checkpoints" aria-label="Saved turns">
    <div className="section-heading"><h3>Saved turns</h3><button disabled={loading||!props.session||props.host.state!=='ready'} onClick={()=>void read(false)}>Refresh saved turns</button></div>
    {loading&&<p role="status">Reading saved turns…</p>}{message&&<p role="status">{message}</p>}
    {props.session?.runtime?.availability==='blocked'&&<p role="alert">This session cannot continue yet. Restore session before sending.</p>}
    {current?.items.map(point=><article key={point.answerId}><p>Question: {point.questionSummary}</p><p>Answer: {point.answerSummary}</p><p className="tiny muted">{point.committedAt} · {point.isCurrentBranch?'Current branch':'Other branch'} · Run {point.runId}</p>{point.conditionSummary&&<p>{point.conditionSummary}</p>}
      <button disabled={props.blocked||busy||!!original?.unknown} onClick={event=>{trigger.current=event.currentTarget;setSelected(point);}}>Resume from here · Run {point.runId}</button></article>)}
    {current&&!current.items.length&&<p>No completed saved turns.</p>}{current?.hasMore&&<button disabled={loading} onClick={()=>void read(true)}>Load more saved turns</button>}
    {original&&<p className="tiny">Original restore <code>{original.operationRef}</code>{original.receipt?' · Saved':''} <button disabled={busy||props.host.state!=='ready'} onClick={()=>void readOriginal()}>Read original restore</button></p>}
    {props.session?.runtime?.availability==='blocked'&&<button disabled={props.blocked||busy||!!original?.unknown} onClick={()=>void repair()}>Restore session</button>}
    <dialog ref={dialog} aria-labelledby="resume-title" onCancel={event=>{event.preventDefault();close();}}><h3 id="resume-title">Resume from this saved turn?</h3><p>Continue from the selected completed turn. Later branches, Queries and Answers remain saved. Your draft is kept. The next Send starts a new Run.</p><div className="actions"><button ref={cancel} onClick={close}>Cancel</button><button disabled={busy||props.blocked} onClick={()=>void resume()}>Resume from here</button></div></dialog>
  </section>;
}

export function SessionCompaction(props:{host:HostView;session:SessionDetail|null;model:ModelChoice|null;visible:boolean;blockedReason:string|null;control:RuntimeControlView|null;
  onHistoryVerified:(sessionId:number,operationRef?:string)=>Promise<void>;onRestoreSession:(input:RestoreSessionInput)=>Promise<Result<SessionDetail>>}) {
  type Attempt={operationRef:string;instanceId:string;view:CompactionOperationView|null;unknown:boolean;revision:number;readOrder:number;reading?:{instanceId:string;again:boolean}};
  const attempts=useRef(new Map<number,Attempt>()),target=useRef(props),mounted=useRef(true);
  target.current=props;
  const [,render]=useState(0),[message,setMessage]=useState<{sessionId:number;text:string}|null>(null),[working,setWorking]=useState(false);
  const sessionId=props.session?.session.id??null,attempt=sessionId?attempts.current.get(sessionId):undefined,view=attempt?.view;
  const refresh=()=>{if(mounted.current)render(value=>value+1);};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    const original=props.session?.compactionOperation;
    if(sessionId&&original&&!attempts.current.has(sessionId)){attempts.current.set(sessionId,{operationRef:original.operationRef,instanceId:props.host.instanceId??'',view:original,unknown:false,revision:0,readOrder:0});refresh();}
    setWorking(false);if(props.visible&&props.host.state==='ready'&&sessionId&&attempts.current.has(sessionId))void readOriginal(sessionId,true);
  },[sessionId,props.host.instanceId,props.host.state,props.visible,props.session?.compactionOperation?.operationRef]);
  useEffect(()=>{
    try{return window.medclaw.subscribe(notice=>{
      const current=target.current,id=current.session?.session.id,original=id?attempts.current.get(id):undefined;
      if(notice.type!=='compaction.progress'||!current.visible||notice.instanceId!==current.host.instanceId||notice.runId!==null||notice.sessionId!==id||!original||notice.operationRef!==original.operationRef||original.view?.receipt&&notice.phase!=='finished'||notice.revision<=original.revision)return;
      original.revision=notice.revision;void readOriginal(id!,true);
    });}catch{return;}
  },[]);
  useEffect(()=>{
    if(!props.visible||props.host.state!=='ready'||!sessionId||!attempt||view?.receipt||view?.phase==='blocked')return;
    const timer=setInterval(()=>void readOriginal(sessionId),500);return()=>clearInterval(timer);
  },[sessionId,props.host.instanceId,props.host.state,props.visible,attempt?.operationRef,view?.phase,!!view?.receipt]);
  async function readOriginal(id:number,followUp=false) {
    const current=target.current,original=attempts.current.get(id),instance=current.host.instanceId;
    if(!original||!instance||current.host.state!=='ready')return;
    if(original.reading?.instanceId===instance){if(followUp)original.reading.again=true;return;}
    const reading={instanceId:instance,again:false};original.reading=reading;
    const order=++original.readOrder,owns=()=>mounted.current&&target.current.host.instanceId===instance&&target.current.session?.session.id===id&&attempts.current.get(id)===original&&original.readOrder===order;
    try {
      const result=await window.medclaw.request('session.compaction.read',{sessionId:id,operationRef:original.operationRef});if(!owns())return;
      if(!result.ok){setMessage({sessionId:id,text:errorMessage(result.error)});return;}
      if(!result.data){
        if(instance!==original.instanceId){await current.onHistoryVerified(id,original.operationRef);if(!owns())return;attempts.current.delete(id);setMessage({sessionId:id,text:'Original compaction not recorded in this Host. Review saved history before another action.'});}
        else {original.unknown=true;setMessage({sessionId:id,text:'Original compaction is not recorded. Keep its identity and read it again.'});}
        refresh();return;
      }
      if(result.data.sessionId!==id||result.data.operationRef!==original.operationRef)return;
      // A durable receipt outranks all progress, including late notices and stale reads.
      if(original.view?.receipt&&!result.data.receipt)return;
      original.view=result.data;original.unknown=false;refresh();
      if(result.data.receipt||result.data.phase==='blocked')await current.onHistoryVerified(id,original.operationRef);
    } catch {if(owns())setMessage({sessionId:id,text:'Compaction read unconfirmed. Read the original operation again.'});}
    finally {if(original.reading===reading){original.reading=undefined;if(reading.again&&owns())void readOriginal(id);}}
  }
  async function compact() {
    const current=target.current,id=current.session?.session.id,instance=current.host.instanceId;
    if(!id||!instance||!current.model||current.blockedReason||working||attempts.current.get(id)?.unknown||attempts.current.get(id)&&!attempts.current.get(id)!.view?.receipt)return;
    const previous=attempts.current.get(id),original:Attempt={operationRef:crypto.randomUUID(),instanceId:instance,view:null,unknown:true,revision:0,readOrder:0};attempts.current.set(id,original);setWorking(true);setMessage(null);refresh();
    try {
      const result=await window.medclaw.request('session.compact',{sessionId:id,expectedStorageVersion:current.session!.session.storageVersion,model:current.model},original.operationRef);
      if(!mounted.current||target.current.host.instanceId!==instance||target.current.session?.session.id!==id)return;
      if(result.ok&&result.data.operationRef===original.operationRef&&result.data.sessionId===id){original.view=result.data;original.unknown=false;}
      else if(!result.ok){const unknown=['operation_result_unknown','resource_unavailable','stop_unconfirmed'].includes(result.error.code);original.unknown=unknown;if(!unknown){if(previous)attempts.current.set(id,previous);else attempts.current.delete(id);}setMessage({sessionId:id,text:unknown?'Compaction acceptance unconfirmed. Read the original operation.':errorMessage(result.error)});}
      refresh();await current.onHistoryVerified(id,original.operationRef);if(!original.unknown)void readOriginal(id);
    } catch {setMessage({sessionId:id,text:'Compaction acceptance unconfirmed. Read the original operation.'});}
    finally {if(mounted.current&&target.current.session?.session.id===id)setWorking(false);}
  }
  async function cancel() {
    if(!sessionId||!attempt||working||view?.receipt)return;const instance=props.host.instanceId;setWorking(true);
    const owns=()=>mounted.current&&target.current.session?.session.id===sessionId&&target.current.host.instanceId===instance;
    try {const result=await window.medclaw.request('session.compaction.cancel',{sessionId,operationRef:attempt.operationRef},crypto.randomUUID());if(!owns())return;
      if(!result.ok)setMessage({sessionId,text:errorMessage(result.error)});else {attempt.view=result.data.operation;refresh();}await readOriginal(sessionId);
    } catch {if(owns())setMessage({sessionId,text:'Cancellation unconfirmed. Read the original compaction.'});}
    finally {if(owns())setWorking(false);}
  }
  async function restore() {
    if(!props.session||working)return;const id=props.session.session.id,instance=props.host.instanceId;setWorking(true);
    const owns=()=>mounted.current&&target.current.session?.session.id===id&&target.current.host.instanceId===instance;
    try {const result=await props.onRestoreSession({sessionId:id,expectedLeafId:props.session.session.leafId});if(owns()){setMessage({sessionId:id,text:result.ok?'Session restored from saved history.':errorMessage(result.error)});await readOriginal(id);}}
    catch {if(owns())setMessage({sessionId:id,text:'Session restore unconfirmed. Read its saved history.'});}
    finally {if(owns())setWorking(false);}
  }
  const disabledReason=props.blockedReason??(attempt?.unknown?'Read the original compaction before another action.':attempt&&!view?.receipt?'The original compaction is still running.':null);
  return <section className="native-messages" data-testid="session-compaction" aria-label="Context compaction">
    <div className="section-heading"><h3>Context compaction</h3><button disabled={!!disabledReason||working} title={disabledReason??undefined} aria-describedby={disabledReason?'compaction-disabled':undefined} onClick={()=>void compact()}>Compact context</button></div>
    {disabledReason&&<p id="compaction-disabled" className="tiny muted">{disabledReason}</p>}
    {attempt&&<><p className="tiny">Original operation <code>{attempt.operationRef}</code></p><button disabled={working||props.host.state!=='ready'} onClick={()=>sessionId&&void readOriginal(sessionId,true)}>Read original compaction</button>{!view?.receipt&&<button disabled={working||props.host.state!=='ready'} onClick={()=>void cancel()}>Cancel compaction</button>}</>}
    <div aria-live="polite" aria-atomic="true">{view&&<p>Compaction · {view.status} · {view.phase}</p>}{message?.sessionId===sessionId&&<p role="status">{message.text}</p>}</div>
    {view&&<><dl className="facts"><dt>Native generated</dt><dd>{view.nativeGenerated===null?'Unknown':view.nativeGenerated?'Yes':'No'}</dd><dt>Native saved</dt><dd>{view.nativeSaved?'Yes':'No'}</dd><dt>Can continue</dt><dd>{view.canContinue?'Yes':'No'}</dd></dl>{view.receipt&&<p className="tiny">SDK context tokens before {view.receipt.tokensBefore??'Unknown'} · estimated after {view.receipt.estimatedTokensAfter??'Unknown'} · saved version {view.receipt.storageVersion??'None'}</p>}{view.error&&<p role="alert" className="error-text">{errorMessage(view.error)}</p>}
      {view.calls.map(call=><p key={call.callId} className="tiny">Compaction call <code>{call.callId}</code> · {call.state} · input / output tokens {call.inputTokens??'Unknown'} / {call.outputTokens??'Unknown'} · cost {call.cost??'Unknown'}{call.unavailableReason?' · '+call.unavailableReason:''}</p>)}
      {(view.phase==='blocked'||view.receipt&&!view.nativeSaved)&&!props.control?.acceptingNewRuns&&view.error?.code!=='stop_unconfirmed'&&<button disabled={working||props.host.state!=='ready'} onClick={()=>void restore()}>Restore compaction session</button>}
    </>}
  </section>;
}

export function Chat(props: { compactionProgress?:{sessionId:number;runId:number|null;phase:string}|null;visible: boolean; sessionId: number | null; onCreate: () => void; directory: ModelDirectoryView | null; directoryCurrent: boolean; directoryStatus?: DirectoryReadStatus; host: HostView; active: ActiveRunView | null; control: RuntimeControlView | null;
  run: RunView | null; preview: { text: string; truncated: boolean } | null; session: SessionDetail | null; draft: SessionDraft | null;
  events: RunEventProjectionState | null; onFinalSource: (source: 'native' | 'saved' | 'unavailable') => void;
  selecting: boolean; sending: boolean; runningTitle: string | null; onDraft: (patch: Partial<SessionDraft>) => void; onSend: () => void; onResend: () => void;
  onNewAttempt: (pending: NonNullable<SessionDraft['pending']>) => void;
  onResumeCheckpoint:(input:RestoreSessionCheckpointInput,operationRef:string)=>Promise<Result<SessionCheckpointReceipt>>;
  onRestoreSession:(input:RestoreSessionInput)=>Promise<Result<SessionDetail>>;onHistoryVerified:(sessionId:number,operationRef?:string)=>Promise<void>;
  onLookup: () => void; onStop: () => void; onModels: () => void; workspace: WorkspaceView | null; workspaceConfirmed: boolean; workspacePending?: boolean; workspaceRecovery?: 'verify' | 'restart' | null; onVerifyWorkspace?: () => void; onWorkspace: (change: WorkspaceChange) => Promise<boolean>;
  dataDefaults: { batchCount: number; referenceDate: string | null; timezone: string | null } | null;
  queueRun: RunView | null; queueRootInput: SessionInput | null; frozenInput?: SessionInput | null; frozenRunId?: number; inputs: InputQueueSnapshot | null; cancellingInputs: number[];
  onRefreshInputs: () => void; onMoreInputs: () => void; onCancelInput: (input: SessionInput) => void;
  onUseForSession: (target: { instanceId: string; sessionId: number }, choice: ModelChoice) => void }) {
  const [following, setFollowing] = useState(true), input = useRef<HTMLTextAreaElement>(null), scroll = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, { following: boolean; top: number; anchor: ReadingAnchor | null; offset: number }>()), followingRef = useRef(following);
  const restoring = useRef(false), restorationFrame = useRef<number | null>(null), readingTarget = useRef<string | null>(null);
  const scrollIntent = useRef<{ key: string; height: number; viewport: number; until: number } | null>(null);
  const [contentUpdated, setContentUpdated] = useState<string | null>(null);
  followingRef.current = following;
  const [messageRevision, setMessageRevision] = useState(0);
  const availabilityKey = JSON.stringify([props.host.instanceId, props.host.state, props.sessionId, props.session?.session.nativeSessionId, props.visible, props.session?.session.leafId, props.run?.id]);
  const availabilityTarget = useRef({ key: availabilityKey, epoch: 0 });
  if (availabilityTarget.current.key !== availabilityKey) availabilityTarget.current = { key: availabilityKey, epoch: availabilityTarget.current.epoch + 1 };
  const availabilityEpoch = availabilityTarget.current.epoch;
  const [messageAvailability, setMessageAvailability] = useState<(MessageAvailability & { epoch: number }) | null>(null);
  const currentAvailability = messageAvailability?.epoch === availabilityEpoch ? messageAvailability : null;
  const draft = props.draft, choice = draft?.model;
  const provider = props.directory?.providers.find(provider => provider.id === choice?.provider);
  const model = props.directory?.models.find(model => model.provider === choice?.provider && model.id === choice?.modelId);
  const configuredProviders = new Set(props.directory?.providers.filter(provider => provider.auth.state === "available").map(provider => provider.id));
  const models = props.directory?.models.filter(model => configuredProviders.has(model.provider) && model.input.includes("text") && model.maxTokens !== null) ?? [];
  const selectedModel = models.find(model => model.provider === choice?.provider && model.id === choice?.modelId);
  const choiceValue = selectedModel ? JSON.stringify([selectedModel.provider, selectedModel.id]) : "";
  const candidateRun = props.run?.kind === "agent" && props.run.sessionId !== props.session?.session.id ? null : props.run;
  // A complete, verified current path proves that a saved Run belongs elsewhere.
  // Keep that Run available in details without appending its discarded branch to chat.
  const offBranch = candidateRun?.kind === 'agent' && ['completed', 'failed', 'cancelled'].includes(candidateRun.status)
    && candidateRun.cleanup?.requiredPersistenceComplete === true && currentAvailability?.hasPage
    && !currentAvailability.hasMore && !currentAvailability.runCovered;
  const run = offBranch ? null : candidateRun;
  const readingKey = props.sessionId === null ? null : `${props.sessionId}:${candidateRun?.id ?? 'history'}:chat`;
  const inputControl = props.session?.session.inputControl, queueRun = props.queueRun, original = props.queueRootInput?.workspaceContext;
  const mode: InputMode = inputControl ? draft?.mode ?? 'send' : 'send';
  const label = mode === 'follow_up' ? 'Follow Up' : mode === 'steer' ? 'Steer' : 'Send';
  const queueReason = !inputControl ? 'No original Run is accepting inputs' : !inputControl.acceptingInputs ? inputControl.blockReasons[0] ? errorMessage(inputControl.blockReasons[0]) : 'The original Run has closed input admission'
    : queueRun?.kind !== 'agent' || queueRun.id !== inputControl.runId || !original ? 'Read the original Run and Input before queueing'
    : draft?.model?.provider !== queueRun.model.provider || draft.model.modelId !== queueRun.model.modelId ? 'Model changes apply after the original Run. Restore its model to queue an input.'
    : draft.referenceDate !== queueRun.referenceDate || draft.timezone !== queueRun.timezone ? 'Restore the original Run reference date and time zone to queue an input.'
    : !props.workspace || props.workspace.sessionId !== props.sessionId || props.workspace.batchRefs.some(batch => !original.batchRefs.some(known => known.id === batch.id))
      || original.deviceIds.length > 0 && (!props.workspace.deviceIds.length || props.workspace.deviceIds.some(id => !original.deviceIds.includes(id))) ? 'The selected data exceeds the original Run scope. Wait and Send a new message.'
    : props.inputs?.items.some(input => input.targetRunId === queueRun.id && input.status === 'delivery_unknown') ? 'Input consumption is unconfirmed. Read the original Input or Stop its original Run.' : null;
  const commonReason = props.host.state !== "ready" ? "Waiting for Host to be ready" : props.selecting ? "Session selection is unconfirmed" : !props.session ? "Create or select a session"
    : !props.session.history.available ? "Saved history is unavailable. Read this session again or create a new session." : props.session.runtime?.availability==='blocked' ? 'This session cannot continue yet. Restore session before sending.' : draft?.pending ? "Read the original submission first"
    : currentAvailability?.available === false ? currentAvailability.unavailable ? 'Native message history is unavailable. Refresh messages or create a new session.' : 'Native message history read failed. Refresh messages before sending.'
    : !draft?.referenceDate ? "Enter a reference date in Message time context" : !draft.timezone.trim() ? "Enter a time zone in Message time context" : null;
  const sendReason = !props.directoryCurrent ? "Reload the model directory in Models" : !choice ? "Select a session model" : !model || !model.input.includes("text") ? "The session model is unavailable. Select another model."
    : !model.maxTokens ? "Confirm the model output limit" : provider?.auth.state !== "available" ? "Authenticate the provider first" : !props.control ? "Run availability is unconfirmed"
    : !props.control.acceptingNewRuns ? (props.control.blockReasons[0] ? errorMessage(props.control.blockReasons[0]) : "Wait for the original run to stop and be saved") : null;
  const reason = commonReason ?? (mode === 'send' ? sendReason : queueReason);
  const showActions = !!inputControl && props.active?.kind === 'agent' && props.active.sessionId === props.sessionId && props.active.runId === inputControl.runId;
  const menuBlocked = !draft || props.selecting || props.sending || !!draft.pending || props.host.state !== 'ready';
  const actionKey = JSON.stringify([props.host.instanceId, props.host.state, props.sessionId, inputControl?.runId, props.active?.runId, props.visible]);
  const [actionMenu, setActionMenu] = useState<string | null>(null), actionGroup = useRef<HTMLDivElement>(null), actionTrigger = useRef<HTMLButtonElement>(null);
  const menuEdge = useRef<'first' | 'last'>('first'), menuOpen = actionMenu === actionKey && showActions && !menuBlocked;
  useEffect(() => { setActionMenu(null); }, [actionKey, menuBlocked]);
  useEffect(() => {
    if (!menuOpen) return;
    const items = actionGroup.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    if (items?.length) items[menuEdge.current === 'last' ? items.length - 1 : 0]?.focus();
    else actionGroup.current?.querySelector<HTMLElement>('[role="menu"]')?.focus();
    const outside = (event: PointerEvent) => { if (!actionGroup.current?.contains(event.target as Node)) setActionMenu(null); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menuOpen]);
  const closeActions = () => { setActionMenu(null); actionTrigger.current?.focus(); };
  const openActions = (edge: 'first' | 'last') => { if (!showActions || menuBlocked) return; menuEdge.current = edge; setActionMenu(actionKey); };
  function chooseAction(next: InputMode) {
    if (!menuOpen || menuBlocked || commonReason || (next === 'send' ? sendReason : queueReason)) return;
    props.onDraft({ mode: next }); closeActions();
  }
  const status = props.active && props.active.runId === run?.id && props.active.stopPending ? "Stopping; waiting for confirmation"
    : props.active && props.active.runId === run?.id && props.active.persistencePending ? "Waiting to save"
    : run?.status === "completed" ? "Saved" : run?.status === "cancelled" ? "Cancelled and saved"
    : run?.status === "failed" ? props.active?.runId === run.id ? "Failed; cleanup unconfirmed" : "Failure saved" : run ? "Generating; not saved" : null;
  const events = props.events && props.events.runId === run?.id && props.events.sessionId === props.sessionId ? props.events : null;
  const savedFinal = !!run && ['completed', 'failed', 'cancelled'].includes(run.status) && run.cleanup?.requiredPersistenceComplete === true;
  const temporary = run?.kind === 'agent' ? events?.finalSource === 'temporary' : !!props.preview || run?.status === 'running' || run?.status === 'created';
  const historyUnavailable = !currentAvailability?.hasPage && (currentAvailability?.unavailable || props.session?.history.available === false);
  const showRunBody = run?.kind === 'agent' ? events?.finalSource === 'saved' : temporary || historyUnavailable || run?.kind === 'provider';
  useEffect(() => {
    if (!run || !events) return;
    const source = finalDisplaySource(run, { available: currentAvailability?.available ?? false, runCovered: currentAvailability?.runCovered ?? false, unavailable: historyUnavailable });
    if (source) props.onFinalSource(source);
  }, [savedFinal, events?.runId, currentAvailability?.available, currentAvailability?.runCovered, historyUnavailable]);
  const streamKey = JSON.stringify(events?.snapshots.map(value => [value.type, value.revision, value.streamConnection]));
  const readingElementKey = (element: HTMLElement) => element.dataset.nativeEntryId ? 'native:' + element.dataset.nativeEntryId : 'message:' + element.dataset.streamConnection + '/' + element.dataset.messageId;
  useLayoutEffect(() => {
    const container = scroll.current; if (!container || !readingKey || !props.visible) return;
    readingTarget.current = readingKey; restoring.current = true;
    if (restorationFrame.current !== null) cancelAnimationFrame(restorationFrame.current);
    restorationFrame.current = requestAnimationFrame(() => { restoring.current = false; restorationFrame.current = null; });
    const position = positions.current.get(readingKey);
    if (position?.following === false) {
      followingRef.current = false; setFollowing(false);
      const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-native-entry-id], [data-message-id]')).filter(element => element.offsetParent !== null);
      const resolved = position.anchor ? resolveReadingAnchor(position.anchor, elements.map(readingElementKey), events?.nativeEntries ?? {}) : null;
      const anchor = resolved?.key ? elements.find(element => readingElementKey(element) === resolved.key) : null;
      if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - position.offset;
      else container.scrollTop = position.top;
      if (resolved?.contentUpdated && elements.length > 0) setContentUpdated(readingKey);
    } else { followingRef.current = true; setFollowing(true); container.scrollTop = container.scrollHeight; }
  }, [readingKey, props.visible, messageRevision, streamKey, events?.finalSource, run?.output.text]);
  useEffect(() => () => { if (restorationFrame.current !== null) cancelAnimationFrame(restorationFrame.current); }, []);
  function markScrollIntent() {
    const container = scroll.current; if (!container || !readingKey) return;
    restoring.current = false;
    scrollIntent.current = { key: readingKey, height: container.scrollHeight, viewport: container.clientHeight, until: performance.now() + 500 };
  }
  function rememberPosition(event: React.UIEvent<HTMLDivElement>) {
    const container = scroll.current; if (!container || !props.visible || !readingKey || readingTarget.current !== readingKey || restoring.current && event.nativeEvent.isTrusted) return;
    const intent = scrollIntent.current;
    // Layout can clamp an up-scrolled position to the bottom of a shorter intermediate
    // DOM. Only explicit input in this same region and geometry may change its intent.
    const userInitiated = !event.nativeEvent.isTrusted || !!intent && intent.key === readingKey && intent.height === container.scrollHeight && intent.viewport === container.clientHeight && intent.until >= performance.now();
    if (!shouldRecordScroll(positions.current.get(readingKey), container.scrollHeight, container.clientHeight, userInitiated)) return;
    const follows = container.scrollHeight - container.scrollTop - container.clientHeight < 64;
    const top = container.getBoundingClientRect().top;
    const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-native-entry-id], [data-message-id]')).filter(element => element.offsetParent !== null);
    const index = elements.findIndex(element => element.getBoundingClientRect().bottom > top), anchor = elements[index];
    const anchorKey = anchor ? readingElementKey(anchor) : null, mapped = anchorKey ? events?.nativeEntries[anchorKey] : null;
    positions.current.set(readingKey, { following: follows, top: container.scrollTop, anchor: anchor && anchorKey ? { key: anchorKey, nativeEntryId: anchor.dataset.nativeEntryId ?? (mapped?.startsWith('native:') ? mapped.slice(7) : null), neighbors: [elements[index + 1], elements[index - 1]].filter((element): element is HTMLElement => !!element).map(readingElementKey) } : null, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 });
    if (positions.current.size > 50) positions.current.delete(positions.current.keys().next().value!);
    followingRef.current = follows; setFollowing(follows);
  }
  useEffect(() => { if (input.current) { input.current.style.height = "auto"; input.current.style.height = Math.min(160, input.current.scrollHeight + input.current.offsetHeight - input.current.clientHeight) + "px"; } }, [draft?.text, props.session?.session.id]);
  return <div className="chat-layout">
    <div className="session-heading"><strong data-testid="current-session">{props.session ? "Viewing: " + sessionDisplayTitle(props.session.session) : "No session selected"}</strong>
      {props.active && <span data-testid="running-session" className="status-chip">Running: {props.runningTitle ?? "Provider"} · Run {props.active.runId}</span>}</div>
    <div className="messages" data-testid="chat-scroll" ref={scroll} onScroll={rememberPosition} onWheel={markScrollIntent} onPointerDown={markScrollIntent} onPointerMove={event => { if (event.buttons) markScrollIntent(); }} onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) markScrollIntent(); }}>
      <div className="reading-width">
        {!run && !currentAvailability?.hasHistory && currentAvailability?.available !== false && props.session?.history.available !== false && <div className="chat-empty"><span className="eyebrow">Session chat</span><h2>{props.session ? "Start a conversation" : "Create a session"}</h2><p>Each session keeps its saved history across restarts. Review the saved run for each message.</p><button className="primary" onClick={props.onModels}>Configure models</button></div>}
        {props.sessionId && <NativeMessages host={props.host} sessionId={props.sessionId} nativeSessionId={props.session?.session.nativeSessionId} visible={props.visible} context="chat" revision={props.session?.session.leafId} testId="chat-native-messages" requiredRunId={candidateRun?.id} excludeRunId={run?.kind === 'agent' && events?.finalSource !== 'native' ? run.id : null} onCreate={props.onCreate} onChanged={() => setMessageRevision(value => value + 1)} onAvailability={value => setMessageAvailability({ ...value, epoch: availabilityEpoch })} />}
        {events && <div className="stream-display-status" data-testid="event-display-status" data-run-id={events.runId} data-cursor={events.cursor}><p className="tiny muted">Run {events.runId} display · {events.phase} · committed cursor {events.cursor}</p>{(events.finalSource === 'native' || events.finalSource === 'temporary') && <span className="status-chip" data-testid="run-save-status">{status}</span>}{events.error && <p role="alert" className="error-text">{events.error}</p>}{events.phase === 'disconnected' && <p role="status">Disconnected. Retaining verified facts; reconnect restores display.</p>}{events.snapshotsIncomplete && <p className="evidence-gap">Some temporary content is unavailable. Temporary text is not a saved history.</p>}</div>}
        {events?.finalSource === 'temporary' && <section data-testid="temporary-run-area" data-run-id={events.runId} aria-label="Temporary Run display">
          <div className="user-message"><span className="message-label">User</span><div>{run?.inputText}</div></div>
          <p className="tiny muted">Temporary output · Run and Answer saving unconfirmed</p>
          {events.snapshots.filter(value => value.type === 'message.snapshot').map(value => value.type === 'message.snapshot' && <article className="model-answer" key={value.streamConnection + ':' + value.messageId} data-message-id={value.messageId} data-stream-connection={value.streamConnection} data-native-entry-ref={value.nativeEntryId ?? undefined} data-run-id={value.runId} data-testid="temporary-message"><div className="answer-heading"><strong>Assistant</strong><span className="status-chip">{value.phase}</span></div><div className="answer-text">{value.blocks.map(block => <span key={block.contentIndex}>{block.text}</span>)}</div>{value.truncated && <p className="tiny muted">Temporary display truncated. Read saved facts after completion.</p>}</article>)}
          {!events.snapshots.some(value => value.type === 'message.snapshot') && <p className="muted">Waiting for temporary model output.</p>}
          {events.snapshots.filter(value => value.type === 'tool.snapshot').map(value => value.type === 'tool.snapshot' && <p className="tiny tool-progress" key={value.nativeToolCallId} data-testid="temporary-tool" data-native-tool-call-id={value.nativeToolCallId}>Tool {value.nativeToolCallId} · {value.phase} · temporary observation{value.toolCallId ? ' · saved call ' + value.toolCallId : ' · saved call not yet identified'}</p>)}
          {savedFinal && !currentAvailability?.runCovered && <p className="evidence-gap">Final Run facts are saved. Reading authoritative messages for this Run.</p>}
        </section>}
        {events?.finalSource === 'unavailable' && <p className="evidence-gap" data-testid="final-content-unavailable">Final content is unavailable. Run and Answer saving remains unconfirmed; read the original facts again.</p>}
        {props.session && !props.session.history.available && <button onClick={props.onCreate}>Create new session</button>}
        {run && (run.kind === 'provider' || showRunBody || !events) && <>{run.kind === "provider" && <p className="muted">Provider diagnostic · Run {run.id}</p>}{showRunBody && <div className="user-message"><span className="message-label">User</span><div>{run.inputText}</div></div>}
          <article className="model-answer" data-testid={showRunBody && savedFinal ? 'saved-final-area' : undefined} data-run-id={run.id}><div className="answer-heading"><strong>Assistant</strong><span className="status-chip">{status}</span></div>
            <p className="tiny muted">{temporary ? 'Temporary output · Run and Answer saving unconfirmed' : historyUnavailable ? 'Saved run output; native history unavailable' : run.kind === 'provider' ? 'Saved diagnostic output · Review Run details' : currentAvailability?.hasMore ? 'Native history page incomplete. Load more messages to read this leaf. Read the full saved output in Run details.' : currentAvailability?.hasPage ? 'Native history: in memory. Read the full saved output in Run details.' : 'Native history coverage unconfirmed. Read the full saved output in Run details.'}</p>
            {showRunBody && <div className="answer-text" data-testid="run-output">{props.preview?.text ?? (run.output.text || "Waiting for model output")}</div>}
            {props.preview?.truncated && <p className="muted">The live preview was truncated. Read the full saved output in Run details.</p>}
            {showRunBody && run.output.nextOffset !== null && !props.preview && <p className="muted">Showing {run.output.text.length} / {run.output.totalChars} characters. Read the full output in Run details.</p>}
            {run.error && <p role="alert" className="error-text">{errorMessage(run.error)}</p>}</article></>}
        <SessionCheckpoints host={props.host} session={props.session} workspace={props.workspace} visible={props.visible} blocked={props.selecting||props.sending||!props.workspaceConfirmed||!!props.draft?.pending||props.control?.acceptingNewRuns!==true||props.host.state!=='ready'} onResumeCheckpoint={props.onResumeCheckpoint} onRestoreSession={props.onRestoreSession} onHistoryVerified={props.onHistoryVerified}/>
        <SessionCompaction host={props.host} session={props.session} model={choice??null} visible={props.visible} control={props.control} blockedReason={props.selecting||props.sending||!props.workspaceConfirmed||props.draft?.pending?'Verify the current session and original input first.':!props.session?'Create or select a session.':props.session.runtime.availability==='blocked'?'Restore the session before compacting.':sendReason} onHistoryVerified={props.onHistoryVerified} onRestoreSession={props.onRestoreSession}/>
        {props.compactionProgress?.sessionId===props.sessionId&&props.compactionProgress.runId===props.active?.runId&&<p role="status" aria-live="polite">Automatic context compaction · {props.compactionProgress.phase}</p>}
      </div>
    </div>
    {contentUpdated === readingKey && !following && <p className="tiny evidence-gap reading-update" data-testid="reading-content-updated">Content updated. Kept the nearest available message.</p>}
    {!following && <button className="new-content" data-testid="back-to-latest" onClick={() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; if (readingKey) positions.current.set(readingKey, { following: true, top: scroll.current?.scrollTop ?? 0, anchor: null, offset: 0 }); followingRef.current = true; setFollowing(true); setContentUpdated(null); }}>New content · Back to latest</button>}
    <div className="composer-wrap"><div className="composer reading-width">
      <div className="composer-model"><span aria-hidden="true">◇</span><div className="composer-model-choice">
        <select aria-label="Session model" value={choiceValue} disabled={props.host.state !== "ready" || props.selecting || !props.session || !draft || !props.directoryCurrent} onChange={event => {
          const selected = models.find(model => JSON.stringify([model.provider, model.id]) === event.target.value);
          if (selected && props.directory && props.session && props.host.instanceId) props.onUseForSession({ instanceId: props.host.instanceId, sessionId: props.session.session.id },
            { provider: selected.provider, modelId: selected.id, expectedConfigVersion: props.directory.configVersion });
        }}>
          <option value="" disabled>{props.directoryCurrent ? models.length ? "Select a session model" : "No configured models. Configure a model first." : props.directoryStatus?.state === 'loading' ? "Loading model directory…" : props.directoryStatus?.state === 'error' ? "Model directory read failed. Open Models to retry." : props.directory ? "Model directory needs verification" : "Model directory not yet read"}</option>
          {models.map(model => <option key={JSON.stringify([model.provider, model.id])} value={JSON.stringify([model.provider, model.id])}>{model.name} · {model.provider} / {model.id}</option>)}
        </select>
        {!selectedModel && <span className="tiny" data-testid="session-model">{choice ? "The selected model is unavailable. Select a configured model." : "No session model selected"}</span>}
      </div><button className="quiet" onClick={props.onModels}>Manage models</button></div>
      {props.active && <p className="tiny muted">Model changes apply to the next message. The current run uses its frozen configuration.</p>}
      {mode !== 'send' && queueRun && <p className="tiny muted">Queueing for original Run {queueRun.id} · {queueRun.model.provider} / {queueRun.model.modelId} · {queueRun.referenceDate} · {queueRun.timezone}</p>}
      <label className="sr-only" htmlFor="message-text">Message text</label><textarea id="message-text" ref={input} value={draft?.text ?? ""} disabled={!draft} placeholder="Type a message…" onChange={event => props.onDraft({ text: event.target.value })} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!reason && !props.sending && draft?.text.trim()) props.onSend(); }
      }} />
      <div className="composer-bottom"><span className="tiny muted">Shift+Enter for a new line</span><div className="actions">
        {draft?.pending && <><button disabled={props.sending} onClick={props.onLookup}>Read original submission</button><button disabled={props.sending || !draft.resendConfirmed || !props.workspaceConfirmed || props.selecting || (draft.pending.input.mode === 'send' ? !props.control?.acceptingNewRuns : !inputControl?.acceptingInputs || inputControl.runId !== draft.pending.input.targetRunId)} onClick={props.onResend}>Resend original submission</button>{draft.confirmedFailure && <button disabled={props.sending || props.selecting || props.host.state !== 'ready' || !props.workspaceConfirmed} onClick={() => props.onNewAttempt(draft.pending!)}>Start a new attempt</button>}</>}
        {props.active && <><button className="danger" disabled={props.host.state !== "ready"} onClick={props.onStop}>Stop generating</button><span className="tiny" data-testid="stop-target">Stops {props.active.sessionId ? `Session ${props.active.sessionId}` : 'Provider'} · Run {props.active.runId}</span></>}
        <div className="message-actions" ref={actionGroup}>
          <button className="primary" disabled={!!reason || props.sending || !draft?.text.trim()} title={reason ?? undefined} onClick={props.onSend}>{props.sending ? "Submitting…" : label}</button>
          {showActions && <button ref={actionTrigger} className="primary message-action-trigger" aria-label="Message actions" aria-haspopup="menu" aria-expanded={menuOpen} disabled={menuBlocked} onClick={() => menuOpen ? closeActions() : openActions('first')} onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openActions(event.key === 'ArrowUp' ? 'last' : 'first'); }
          }}><span aria-hidden="true">▾</span></button>}
          {menuOpen && <div role="menu" tabIndex={-1} aria-label="Message actions" className="message-action-menu" onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeActions(); }
            else if (event.key === 'Tab') setActionMenu(null);
            else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault(); const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
              if (!items.length) return; const current = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }
          }}>{(['send', 'steer', 'follow_up'] as const).map(value => {
            const disabledReason = commonReason ?? (value === 'send' ? sendReason : queueReason);
            return <button key={value} role="menuitem" aria-current={value === mode ? 'true' : undefined} disabled={!!disabledReason} title={disabledReason ?? undefined} onClick={() => chooseAction(value)}>{value === 'follow_up' ? 'Follow Up' : value === 'steer' ? 'Steer' : 'Send'}</button>;
          })}</div>}
        </div>
      </div></div>{reason && <p className="composer-reason" role="status">{reason}</p>}
    </div><details className="chat-data-context reading-width"><summary>Data for next message · {props.workspace?.batchRefs.length ?? 0} batches</summary><ContextPanel frozenInput={props.frozenInput} frozenRunId={props.frozenRunId} workspace={props.workspace} confirmed={props.workspaceConfirmed} disabled={props.workspacePending ?? props.selecting} recovery={props.workspaceRecovery} onVerify={props.onVerifyWorkspace} onUpdate={props.onWorkspace} /></details><details className="reference-fields reading-width"><summary>Message time context</summary><label>Reference date<input type="date" value={draft?.referenceDate ?? ""} disabled={!draft} onChange={event => props.onDraft({ referenceDate: event.target.value })} /></label><label>Time zone<input value={draft?.timezone ?? ""} disabled={!draft} onChange={event => props.onDraft({ timezone: event.target.value })} /></label>{props.dataDefaults && props.dataDefaults.batchCount > 0 && (!props.dataDefaults.referenceDate || !props.dataDefaults.timezone) && <p className="tiny muted" data-testid="data-time-defaults-missing">Imported data has no common default date or time zone. Choose the reference date and time zone for the next message.</p>}{props.dataDefaults?.referenceDate && props.dataDefaults.timezone && <div className="actions"><span className="tiny muted" data-testid="data-time-defaults">Data defaults: {props.dataDefaults.referenceDate} · {props.dataDefaults.timezone}</span><button disabled={!draft || !!draft.pending} onClick={() => props.onDraft({ referenceDate: props.dataDefaults!.referenceDate!, timezone: props.dataDefaults!.timezone! })}>Use data defaults</button></div>}</details></div>
  </div>;
}
