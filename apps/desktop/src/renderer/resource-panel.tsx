import {useEffect,useRef,useState} from 'react';
import {errorMessage} from '../../../../packages/contracts/src/error';
import type {HostView} from '../../../../packages/contracts/src/model';
import {resourceRefKey,type ResourceSourceInput,type ResourceKind,type ResourceList,type ResourceRef,type ResourceSelection,type ResourceText,type ResourceCatalogReadResult} from '../../../../packages/contracts/src/resources';

export function ResourcePanel(props:{host:HostView;source:ResourceSourceInput|null;selectionPending?:boolean;kind?:ResourceKind;activeRunId?:number|null;refreshToken?:string;onPublished?:()=>void;onEvidence?:()=>void;onSettings?:()=>void;onChat?:()=>void;onNotice?:(notice:string|null)=>void}) {
  const selectionPending=props.selectionPending===true;
  const key=JSON.stringify([props.host.instanceId,props.host.state,props.source,props.kind,selectionPending]), current=useRef(key);current.current=key;
  const readOrder=useRef(0),bodyOrder=useRef(0),saveBusy=useRef<string|null>(null);
  const refreshedVersion=useRef(props.refreshToken);
  const [view,setView]=useState<{key:string;data:ResourceList}|null>(null),[body,setBody]=useState<{key:string;data:ResourceText}|null>(null);
  const [catalog,setCatalog]=useState<{key:string;data:ResourceCatalogReadResult}|null>(null);
  const [notice,setNotice]=useState<{key:string;text:string}|null>(null),[busy,setBusy]=useState<string|null>(null),[search,setSearch]=useState('');
  const [versions,setVersions]=useState<Record<string,string>>({});
  const [filter,setFilter]=useState('All'),[detail,setDetail]=useState<string|null>(null);
  const [activeExpanded,setActiveExpanded]=useState(false);
  const data=view?.key===key?view.data:null, directory=data??(catalog?.key===key?catalog.data:null), text=body?.key===key?body.data:null, ready=props.host.state==='ready'&&!!props.host.instanceId;
  useEffect(()=>{props.onNotice?.(notice?.key===key?notice.text:null);},[key,notice,props.onNotice]);
  const sameSource=(value:ResourceSourceInput,source:ResourceSourceInput)=>value.source===source.source&&(source.source==='run'?value.source==='run'&&value.runId===source.runId:value.source==='selection'&&value.sessionId===source.sessionId);
  async function refresh(page=1) {
    if(!ready||selectionPending)return;const owner=key,source=props.source,order=++readOrder.current;++bodyOrder.current;setBody(null);setBusy(owner);
    try {
      if(!source){
        const result=await window.medclaw.request('resources.catalog.read',{});
        if(current.current!==owner||order!==readOrder.current)return;
        if(result.ok){setCatalog({key:owner,data:result.data});setNotice(null);}else setNotice({key:owner,text:errorMessage(result.error)});
        return;
      }
      const result=await window.medclaw.request('resources.list',{...source,evidencePage:page});
      if(current.current!==owner||order!==readOrder.current)return;
      if(!result.ok){setNotice({key:owner,text:errorMessage(result.error)});return;}
      if(!sameSource(result.data,source))throw new Error('Resource source did not match the requested owner.');
      setView({key:owner,data:result.data});setNotice(null);
    }catch{if(current.current===owner&&order===readOrder.current)setNotice({key:owner,text:'Resource status is unconfirmed. Refresh resources to verify the saved selection.'});}
    finally{if(current.current===owner&&order===readOrder.current)setBusy(null);}
  }
  useEffect(()=>{refreshedVersion.current=props.refreshToken;setView(null);setCatalog(null);setBody(null);setNotice(null);setBusy(null);setVersions({});setSearch('');setFilter('All');setDetail(null);setActiveExpanded(false);void refresh();return()=>{++readOrder.current;++bodyOrder.current;};},[key]);
  useEffect(()=>{if(refreshedVersion.current!==props.refreshToken){refreshedVersion.current=props.refreshToken;void refresh();}},[props.refreshToken]);
  async function publish(selection:ResourceSelection) {
    if(!ready||!data||props.source?.source!=='selection'||saveBusy.current===key)return;
    const owner=key,source=props.source;saveBusy.current=owner;setBusy(owner);setNotice(null);++bodyOrder.current;setBody(null);
    try {
      const result=await window.medclaw.request('resources.select',{sessionId:source.sessionId,expectedConfigVersion:data.configVersion,selection});
      if(current.current!==owner)return;
      if(!result.ok){setNotice({key:owner,text:`${errorMessage(result.error)} Refresh resources to verify the saved selection.`});return;}
      if(result.data.sessionId!==source.sessionId||JSON.stringify(result.data.selection)!==JSON.stringify(selection))throw new Error('Selection receipt mismatch');
      props.onPublished?.();await refresh();
    }catch{if(current.current===owner)setNotice({key:owner,text:'Selection is unconfirmed. Refresh resources to verify the saved selection.'});}
    finally{if(saveBusy.current===owner)saveBusy.current=null;if(current.current===owner)setBusy(null);}
  }
  const selected=(ref:ResourceRef)=>!!data&&(ref.kind==='prompt'?data.selection.prompt!==null&&resourceRefKey(data.selection.prompt)===resourceRefKey(ref):data.selection.skills.some(s=>resourceRefKey(s)===resourceRefKey(ref)));
  function choose(ref:ResourceRef,enabled:boolean) {
    if(!data)return;void publish(ref.kind==='prompt'?{...data.selection,prompt:enabled?ref:null}:{...data.selection,skills:[...data.selection.skills.filter(s=>s.id!==ref.id),...(enabled?[ref]:[])]});
  }
  function showDetail(ref:ResourceRef) {
    ++bodyOrder.current;setBody(null);setDetail(old=>old===resourceRefKey(ref)?null:resourceRefKey(ref));
  }
  async function read(source:ResourceSourceInput,resourceRef:ResourceRef,file:string) {
    if(!ready)return;const owner=key,order=++bodyOrder.current;setBody(null);setNotice(null);
    try {
      const result=await window.medclaw.request('resources.read',{...source,resourceRef,file});
      if(current.current!==owner||order!==bodyOrder.current)return;
      if(!result.ok){setNotice({key:owner,text:errorMessage(result.error)});return;}
      if(!sameSource(result.data,source)||resourceRefKey(result.data.resourceRef)!==resourceRefKey(resourceRef)||result.data.file!==file||source.source==='selection'&&result.data.configVersion!==data?.configVersion)throw new Error('Resource body owner mismatch');
      setBody({key:owner,data:result.data});
    }catch{if(current.current===owner&&order===bodyOrder.current)setNotice({key:owner,text:'Resource body is unconfirmed. Read the original file again.'});}
  }
  const groups=new Map<string,ResourceCatalogReadResult['items']>();
  let shown=0;
  for(const item of directory?.items??[])if((!props.kind||item.ref.kind===props.kind)&&`${item.ref.id} ${item.description??''} ${item.keywords.join(' ')}`.toLowerCase().includes(search.toLowerCase())) {
    const id=`${item.ref.kind}:${item.ref.id}`;groups.set(id,[...(groups.get(id)??[]),item]);
  }
  return <section className="resource-panel resource-catalog" data-testid="resource-panel" aria-label={props.source?.source==='run'?'Resources for this run':props.kind==='prompt'?'Prompt resources':'Skill Hub'}>
    <h2>{props.source?.source==='run'?'Resources for this run':props.kind==='prompt'?'Prompt':'Skill Hub'}</h2>
    {!ready&&<div className="empty-state"><p role="status">{props.host.error?errorMessage(props.host.error):'Host must be ready to read resources.'}</p>{props.onSettings&&<button onClick={props.onSettings}>Open Settings</button>}</div>}
    {ready&&selectionPending&&<div className="empty-state"><p role="status">Session selection is unconfirmed. Verify the current selection in Chat or Data Workspace.</p>{props.onChat&&<button className="quiet" onClick={props.onChat}>Verify session selection</button>}</div>}
    {ready&&!selectionPending&&<>
      {!props.source&&<p className="muted">Select a Session to choose resources. You can browse the full catalog below. {props.onChat&&<button className="quiet" onClick={props.onChat}>Choose session</button>}</p>}
      {props.source&&<details className="advanced-section"><summary>Resource context</summary><p>{props.source.source==='run'?`Run ${props.source.runId} · Frozen versions`:`Session ${props.source.sessionId} · Next run resources`}</p>{data&&<p>Published configuration {data.configVersion}</p>}</details>}
      {props.source?.source==='selection'&&props.activeRunId&&<><p>Applies to the next run</p><details className="advanced-section" onToggle={e=>setActiveExpanded(e.currentTarget.open)}><summary>Active Run {props.activeRunId} keeps its frozen resources</summary>{activeExpanded&&<ResourcePanel host={props.host} source={{source:'run',runId:props.activeRunId}} />}</details></>}
      <button disabled={!ready||busy===key} onClick={()=>void refresh()}>Refresh resources</button>
      {directory&&<>
        {directory.catalogError&&<p role="alert">Resource catalog unavailable: {errorMessage(directory.catalogError)}. Published choices are retained.</p>}
        {!!directory.diagnostics.length&&<details className="advanced-section"><summary>Resource diagnostics</summary>{directory.diagnostics.map((d,i)=><p key={i}>{d.resourceRef?.id??'Catalog'} · {d.reason} · {d.message}</p>)}</details>}
        <label>Search resources<input value={search} onChange={e=>setSearch(e.target.value)} /></label>
        {props.kind!=='prompt'&&<div className="task-nav" role="group" aria-label="Skill status">{['All','Ready','Partial',...(data?['Disabled']:[])].map(value=><button key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{value}</button>)}</div>}
        {props.source?.source==='selection'&&data&&<button className="quiet" disabled={!ready||busy===key} onClick={()=>void publish(props.kind==='prompt'?{...data.selection,prompt:null}:props.kind==='skill'?{...data.selection,skills:[]}:{prompt:null,skills:[]})}>Clear selection</button>}
        {[...groups].map(([id,items])=>{
          const enabled=items.find(item=>selected(item.ref)), item=enabled??items.find(item=>JSON.stringify(item.ref)===versions[id])??items[0]!;
          const matched=item.availability==='ready'&&(item.readiness?.state==='ready'||item.readiness?.state==='no_requirements'),state=matched?'Ready':'Partial';
          if(item.ref.kind==='skill'&&filter!=='All'&&(filter==='Disabled'?!!enabled:filter!==state))return null;
          shown++;
          const expanded=detail===resourceRefKey(item.ref),readiness=item.readiness;
          let readinessLabel='Unknown';
          if(readiness&&readiness.state!=='unknown')readinessLabel=readiness.state==='no_requirements'?'No requirements':`${readiness.matchedCount}/${readiness.totalCount} capabilities`;
          return <article key={id} data-testid="resource-row">
            <div className="resource-summary"><div className="resource-description">
              <h3><button aria-expanded={expanded} onClick={()=>showDetail(item.ref)}>{item.name??item.ref.id}</button></h3>
              <p>{item.description??'Description unavailable'}</p>
              {item.ref.kind==='skill'&&<span className="status-badge" aria-label={`${item.ref.id} readiness`}>{readinessLabel}{!readiness||readiness.state==='unknown'?' · Unconfirmed':matched?' · Ready':' · Requirements missing'}</span>}
              {item.ref.kind==='prompt'&&<span className="status-badge">{item.availability}</span>}
            </div>
              {props.source?.source!=='run'&&<label className="switch-control"><input type="checkbox" role="switch" aria-label={`${enabled?'Disable':'Enable'} ${item.ref.id}`} checked={!!enabled} disabled={!data||props.source?.source!=='selection'||busy===key||!enabled&&(item.availability!=='ready'||item.ref.kind==='skill'&&!matched)} onChange={event=>choose(item.ref,event.target.checked)}/><span className="switch-track" aria-hidden="true"/><span className="switch-label">{!data?'Choose session':saveBusy.current===key?'Saving…':enabled?'Enabled':'Disabled'}</span></label>}
            </div>
            <div className="advanced-section" hidden={!expanded} aria-label={`${item.ref.id} details`}><h4>Resource details</h4>
            <label>{item.ref.id} version<select value={JSON.stringify(item.ref)} disabled={props.source?.source==='run'||busy===key} onChange={e=>{setVersions(old=>({...old,[id]:e.target.value}));const next=items.find(i=>JSON.stringify(i.ref)===e.target.value)!;++bodyOrder.current;setBody(null);setDetail(resourceRefKey(next.ref));if(enabled)choose(next.ref,true);}}>
              {items.map(i=><option key={resourceRefKey(i.ref)} value={JSON.stringify(i.ref)} disabled={i.availability!=='ready'&&!selected(i.ref)}>{i.ref.version} · {i.availability}</option>)}
            </select></label><p>{data?(enabled?'Enabled':'Disabled'):'Select a Session to enable'} · {item.availability}</p>
            {item.disableModelInvocation&&<p>Automatic discovery hidden; explicit Skill invocation remains available.</p>}
            {readiness&&<p>{readiness.basis==='run_scope'?'Run scope':'Configuration preview'}</p>}
            <p>Required tools: {item.requiredTools===null?'Unknown':item.requiredTools.join(', ')||'None'} · Required extensions: {item.requiredExtensions===null?'Unknown':item.requiredExtensions.join(', ')||'None'}</p>
            {readiness?.missingTools.map(tool=><p key={tool.name} className="resource-missing">Missing {tool.name} · Tool not available</p>)}
            {readiness?.requiredTools&&readiness.state!=='unknown'&&<p>Matched tools: {readiness.requiredTools.filter(tool=>!readiness.missingTools.some(missing=>missing.name===tool)).join(', ')||'None'}</p>}
            {item.files.map(file=><button key={file.file} disabled={!ready||!props.source||busy===key||props.source?.source==='selection'&&!selected(item.ref)} onClick={()=>props.source&&void read(props.source,item.ref,file.file)}>Read {item.ref.id} {file.file}</button>)}
            </div>
            {!!item.diagnostics.length&&<div aria-label={`${item.ref.id} diagnostics`}>{item.diagnostics.map((diagnostic,index)=><p key={index}>{diagnostic.reason} · {diagnostic.message}</p>)}</div>}
          </article>;
        })}
        {!shown&&<p className="empty-state">{search||filter!=='All'?'No resources match these filters.':'No resources in this catalog.'}</p>}
        {props.source?.source==='run'&&data&&<><h3>Actual resource evidence</h3><p>Following instructions has not been evaluated</p>{!data.evidence.length&&<p>No recorded resource use on this page. Delivery is unconfirmed.</p>}
          {data.evidence.map((e,i)=><article key={i}><p>{e.kind==='native_read'?'Read':e.kind==='provider_delivery'?'Delivered':'SDK expanded'} · {e.resourceRef.id} {e.resourceRef.version} · {e.coverage}</p>
            {e.originRunId!==(props.source?.source==='run'?props.source.runId:null)&&<p>Historical content from run {e.originRunId}</p>}
            <details className="advanced-section"><summary>Evidence identifiers</summary><p>Input {e.inputId??'None'} · Tool {e.toolCallId??'None'} · Call {e.modelCallId??'None'} · Entry {e.nativeEntryId??'None'}</p></details>
            {e.file&&<button onClick={()=>void read({source:'run',runId:e.originRunId},e.resourceRef,e.file!)}>Read historical {e.resourceRef.id} {e.file}</button>}
            {props.onEvidence&&<button onClick={props.onEvidence}>View Tool, Context and History facts</button>}
          </article>)}<p>Evidence page {data.evidenceInfo.page} · {data.evidenceInfo.totalRows} facts</p>
          <button disabled={busy===key||data.evidenceInfo.page<=1} onClick={()=>void refresh(data.evidenceInfo.page-1)}>Previous evidence page</button><button disabled={busy===key||!data.evidenceInfo.hasMore} onClick={()=>void refresh(data.evidenceInfo.page+1)}>Next evidence page</button>
        </>}
      </>}
    </>}
    {notice?.key===key&&<p role="alert">{notice.text}</p>}
    {busy===key&&<p role="status">Verifying resources…</p>}
    {text&&<><h3>{text.resourceRef.id} {text.resourceRef.version} · {text.file}</h3><pre data-testid="resource-body">{text.content}</pre></>}
  </section>;
}
