import {useEffect,useRef,useState} from 'react';
import {errorMessage} from '../../../../packages/contracts/src/error';
import type {HostView} from '../../../../packages/contracts/src/model';
import {resourceRefKey,type ResourceSourceInput,type ResourceKind,type ResourceList,type ResourceRef,type ResourceSelection,type ResourceText} from '../../../../packages/contracts/src/resources';

export function ResourcePanel(props:{host:HostView;source:ResourceSourceInput|null;kind?:ResourceKind;activeRunId?:number|null;refreshToken?:string;onPublished?:()=>void;onEvidence?:()=>void}) {
  const key=JSON.stringify([props.host.instanceId,props.host.state,props.source,props.kind]), current=useRef(key);current.current=key;
  const readOrder=useRef(0),bodyOrder=useRef(0),saveBusy=useRef<string|null>(null);
  const [view,setView]=useState<{key:string;data:ResourceList}|null>(null),[body,setBody]=useState<{key:string;data:ResourceText}|null>(null);
  const [notice,setNotice]=useState<{key:string;text:string}|null>(null),[busy,setBusy]=useState<string|null>(null),[search,setSearch]=useState('');
  const [versions,setVersions]=useState<Record<string,string>>({});
  const [activeExpanded,setActiveExpanded]=useState(false);
  const data=view?.key===key?view.data:null, text=body?.key===key?body.data:null, ready=props.host.state==='ready'&&!!props.host.instanceId&&!!props.source;
  const sameSource=(value:ResourceSourceInput,source:ResourceSourceInput)=>value.source===source.source&&(source.source==='run'?value.source==='run'&&value.runId===source.runId:value.source==='selection'&&value.sessionId===source.sessionId);
  async function refresh(page=1) {
    if(!ready||!props.source)return;const owner=key,source=props.source,order=++readOrder.current;++bodyOrder.current;setBody(null);setBusy(owner);
    try {
      const result=await window.medclaw.request('resources.list',{...source,evidencePage:page});
      if(current.current!==owner||order!==readOrder.current)return;
      if(!result.ok){setNotice({key:owner,text:errorMessage(result.error)});return;}
      if(!sameSource(result.data,source))throw new Error('Resource source did not match the requested owner.');
      setView({key:owner,data:result.data});setNotice(null);
    }catch{if(current.current===owner&&order===readOrder.current)setNotice({key:owner,text:'Resource status is unconfirmed. Refresh resources to verify the saved selection.'});}
    finally{if(current.current===owner&&order===readOrder.current)setBusy(null);}
  }
  useEffect(()=>{setView(null);setBody(null);setNotice(null);setBusy(null);setVersions({});setSearch('');setActiveExpanded(false);void refresh();return()=>{++readOrder.current;++bodyOrder.current;};},[key,props.refreshToken]);
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
  const groups=new Map<string,NonNullable<typeof data>['items']>();
  for(const item of data?.items??[])if((!props.kind||item.ref.kind===props.kind)&&`${item.ref.id} ${item.description??''} ${item.keywords.join(' ')}`.toLowerCase().includes(search.toLowerCase())) {
    const id=`${item.ref.kind}:${item.ref.id}`;groups.set(id,[...(groups.get(id)??[]),item]);
  }
  return <section className="resource-panel" data-testid="resource-panel" aria-label={props.source?.source==='run'?'Resources for this run':props.kind==='prompt'?'Prompt resources':'Skill Hub'}>
    <h2>{props.source?.source==='run'?'Resources for this run':props.kind==='prompt'?'Prompt':'Skill Hub'}</h2>
    {!props.source?<p>Select a Session to view and choose resources.</p>:<>
      <p>{props.source.source==='run'?`Run ${props.source.runId} · Frozen versions`:`Session ${props.source.sessionId} · Next run resources`}</p>
      {props.source.source==='selection'&&props.activeRunId&&<><p>Applies to the next run</p><details onToggle={e=>setActiveExpanded(e.currentTarget.open)}><summary>Active Run {props.activeRunId} keeps its frozen resources</summary>{activeExpanded&&<ResourcePanel host={props.host} source={{source:'run',runId:props.activeRunId}} />}</details></>}
      <button disabled={!ready||busy===key} onClick={()=>void refresh()}>Refresh resources</button>
      {data&&<><p>Published configuration {data.configVersion}</p>
        {data.catalogError&&<p role="alert">Resource catalog unavailable: {errorMessage(data.catalogError)}. Published choices are retained.</p>}
        {!!data.diagnostics.length&&<details><summary>Resource diagnostics</summary>{data.diagnostics.map((d,i)=><p key={i}>{d.resourceRef?.id??'Catalog'} · {d.reason} · {d.message}</p>)}</details>}
        <label>Search resources<input value={search} onChange={e=>setSearch(e.target.value)} /></label>
        {props.source.source==='selection'&&<button disabled={!ready||busy===key} onClick={()=>void publish(props.kind==='prompt'?{...data.selection,prompt:null}:props.kind==='skill'?{...data.selection,skills:[]}:{prompt:null,skills:[]})}>Clear selection</button>}
        {[...groups].map(([id,items])=>{
          const enabled=items.find(item=>selected(item.ref)), item=enabled??items.find(item=>JSON.stringify(item.ref)===versions[id])??items[0]!;
          return <article key={id}><h3>{item.ref.id}</h3><p>{item.description??'Description unavailable'}</p>
            <label>{item.ref.id} version<select value={JSON.stringify(item.ref)} disabled={props.source?.source==='run'||busy===key} onChange={e=>{setVersions(old=>({...old,[id]:e.target.value}));const next=items.find(i=>JSON.stringify(i.ref)===e.target.value)!;if(enabled)choose(next.ref,true);}}>
              {items.map(i=><option key={resourceRefKey(i.ref)} value={JSON.stringify(i.ref)} disabled={i.availability!=='ready'&&!selected(i.ref)}>{i.ref.version} · {i.availability}</option>)}
            </select></label><p>{enabled?'Enabled':'Disabled'} · {item.availability}</p>
            {item.disableModelInvocation&&<p>Automatic discovery hidden; explicit Skill invocation remains available.</p>}
            <p>Required tools: {item.requiredTools===null?'Unknown':item.requiredTools.join(', ')||'None'} · Required extensions: {item.requiredExtensions===null?'Unknown':item.requiredExtensions.join(', ')||'None'}</p>
            {props.source?.source==='selection'&&<button disabled={!ready||busy===key||!enabled&&item.availability!=='ready'} onClick={()=>choose(item.ref,!enabled)}>{enabled?'Disable':'Enable'} {item.ref.id}</button>}
            {item.files.map(file=><button key={file.file} disabled={!ready||busy===key||props.source?.source==='selection'&&!selected(item.ref)} onClick={()=>props.source&&void read(props.source,item.ref,file.file)}>Read {item.ref.id} {file.file}</button>)}
          </article>;
        })}
        {props.source.source==='run'&&<><h3>Actual resource evidence</h3><p>Following instructions has not been evaluated</p>{!data.evidence.length&&<p>No recorded resource use on this page. Delivery is unconfirmed.</p>}
          {data.evidence.map((e,i)=><article key={i}><p>{e.kind==='native_read'?'Read':e.kind==='provider_delivery'?'Delivered':'SDK expanded'} · {e.resourceRef.id} {e.resourceRef.version} · {e.coverage}</p>
            {e.originRunId!==(props.source?.source==='run'?props.source.runId:null)&&<p>Historical content from run {e.originRunId}</p>}
            <p>Input {e.inputId??'None'} · Tool {e.toolCallId??'None'} · Call {e.modelCallId??'None'} · Entry {e.nativeEntryId??'None'}</p>
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
