import {useEffect,useRef,useState} from 'react';
import {errorMessage} from '../../../../packages/contracts/src/error';
import type {HostView} from '../../../../packages/contracts/src/model';
import type {ExtensionsReadResult} from '../../../../packages/contracts/src/protocol';
import type {ExtensionStatus,ExtensionsCatalogReadResult} from '../../../../packages/contracts/src/extensions';
import type {SubagentsList} from '../../../../packages/contracts/src/subagent';

type AgentDraft={roleId:string;content:string;expectedContent:string|null;existing:boolean;unknown:boolean};
export function SubagentManager(props:{host:HostView;sessionId:number|null;visible:boolean;onNotice?:(notice:string|null)=>void}) {
  const key=JSON.stringify([props.host.instanceId,props.sessionId]),owner=useRef(key);owner.current=key;
  const drafts=useRef(new Map<string,AgentDraft>()),order=useRef(0),writing=useRef(false);
  const [view,setView]=useState<{key:string;data:SubagentsList}|null>(null),[draftView,setDraftView]=useState<{key:string;draft:AgentDraft}|null>(null);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState<string|null>(null);
  const draft=draftView?.key===key?draftView.draft:null,ready=props.visible&&props.host.state==='ready'&&!!props.host.instanceId&&props.sessionId!==null;
  let draftNotice:string|null=null;
  if(draft?.unknown)draftNotice='Agent save is unconfirmed. Verify the saved content before another save.';
  else if(draft&&draft.content!==draft.expectedContent)draftNotice='Agent draft has unsaved changes.';
  useEffect(()=>{props.onNotice?.(notice??draftNotice);},[notice,draftNotice,props.onNotice]);
  function edit(patch:Partial<AgentDraft>,original=draft){if(!original)return;const next={...original,...patch};drafts.current.set(key,next);setDraftView({key,draft:next});}
  async function refresh(){
    if(!ready)return;const target=key,sequence=++order.current;
    try{const result=await window.medclaw.request('subagents.list',{source:'selection',sessionId:props.sessionId!});if(owner.current!==target||sequence!==order.current)return;
      if(result.ok)setView({key:target,data:result.data});else setNotice(errorMessage(result.error));
    }catch{if(owner.current===target)setNotice('Agent list is unconfirmed. Refresh agents.');}
  }
  useEffect(()=>{setNotice(null);setBusy(writing.current);setDraftView(drafts.current.has(key)?{key,draft:drafts.current.get(key)!}:null);if(ready)void refresh();return()=>{++order.current;};},[key,ready]);
  useEffect(()=>()=>{owner.current='unmounted';},[]);
  async function read(roleId:string){
    if(!ready||busy)return;const target=key,sequence=++order.current;setBusy(true);setNotice(null);
    try{const result=await window.medclaw.request('subagents.read',{source:'selection',sessionId:props.sessionId!,roleId});if(owner.current!==target||sequence!==order.current)return;
      if(!result.ok){setNotice(errorMessage(result.error));return;}
      if(result.data.roleId!==roleId||!result.data.editable)throw new Error('Agent owner mismatch');
      const next={roleId,content:result.data.content,expectedContent:result.data.expectedContent,existing:true,unknown:false};drafts.current.set(key,next);setDraftView({key,draft:next});
    }catch{if(owner.current===target)setNotice('Original agent content is unconfirmed. Read it again.');}finally{if(owner.current===target&&sequence===order.current)setBusy(false);}
  }
  function newAgent(){const next={roleId:'new-role',content:'---\nname: new-role\ndescription: Independent supplied-material analysis\ntools: []\n---\nAnalyze only the task materials supplied by the parent.\n',expectedContent:null,existing:false,unknown:false};drafts.current.set(key,next);setDraftView({key,draft:next});setNotice(null);}
  async function save(){
    if(!ready||!draft||draft.unknown||writing.current)return;const target=key,original=draft;writing.current=true;setBusy(true);setNotice(null);
    try{const result=await window.medclaw.request('subagents.save',{sessionId:props.sessionId!,roleId:original.roleId,content:original.content,expectedContent:original.expectedContent});if(owner.current!==target)return;
      if(!result.ok){edit({unknown:['storage_write_failed','operation_result_unknown'].includes(result.error.code)},original);setNotice(errorMessage(result.error)+' Draft retained.');return;}
      if(result.data.roleId!==original.roleId||result.data.content!==original.content)throw new Error('Agent save owner mismatch');
      edit({expectedContent:result.data.content,existing:true,unknown:false},original);setNotice('Agent saved for subsequent Runs.');await refresh();
    }catch{if(owner.current===target){edit({unknown:true},original);setNotice('Agent save is unconfirmed. Draft retained; verify the saved content before another save.');}}
    finally{writing.current=false;setBusy(false);}
  }
  async function verifySave(){
    if(!ready||!draft||busy)return;const target=key,original=draft;setBusy(true);
    try{const result=await window.medclaw.request('subagents.read',{source:'selection',sessionId:props.sessionId!,roleId:original.roleId});if(owner.current!==target)return;
      if(!result.ok){if(result.error.reason==='resource_missing')edit({unknown:false},original);setNotice(errorMessage(result.error)+' Draft retained.');return;}
      if(result.data.roleId!==original.roleId)throw new Error('Agent owner mismatch');
      if(result.data.content===original.content){edit({expectedContent:result.data.content,existing:true,unknown:false},original);setNotice('Agent saved for subsequent Runs.');await refresh();}
      else{edit({unknown:false},original);setNotice('Saved content differs from this draft. Draft retained. Read the current agent explicitly before replacing it.');}
    }catch{if(owner.current===target)setNotice('Agent save is still unconfirmed. Draft retained.');}finally{if(owner.current===target)setBusy(false);}
  }
  return <section className="panel" aria-label="Agent management" hidden={!props.visible}><h2>Manage agents</h2><p>Role edits apply to subsequent Runs. Editing a built-in role saves a user override.</p>
    {!ready?<p>{props.host.state!=='ready'?(props.host.error?errorMessage(props.host.error):'Host must be ready to manage agents.'):'Select a confirmed user Session to manage agents.'}</p>:<><button disabled={busy} onClick={()=>void refresh()}>Refresh agents</button><button disabled={busy} onClick={newAgent}>New agent</button>
      {view?.key!==key&&!notice&&<p role="status">Reading agents…</p>}
      {view?.key===key&&view.data.items.length===0&&<p>No agents are available for this Session.</p>}
      {view?.key===key&&view.data.items.map(item=><article key={item.roleId}><strong>{item.roleId}</strong> · {item.available?'Available':'Unavailable'}<p>{item.description??'Invalid role declaration'}</p>{item.reasons.length>0&&<p>{item.reasons.join(', ')}</p>}<button disabled={busy||!item.valid} onClick={()=>void read(item.roleId)}>Edit agent {item.roleId}</button><details className="advanced-section"><summary>Agent details</summary><p>Source: {item.source}</p></details></article>)}
      {draft&&<><label>Agent ID<input aria-label="Agent ID" value={draft.roleId} disabled={busy||draft.existing||draft.unknown} onChange={event=>edit({roleId:event.target.value})}/></label><label>Agent content<textarea aria-label="Agent content" rows={14} value={draft.content} disabled={busy||draft.unknown} onChange={event=>edit({content:event.target.value})}/></label>
      <button disabled={busy||draft.unknown||!draft.roleId||!draft.content} onClick={()=>void save()}>Save agent</button><button disabled={busy} onClick={()=>void verifySave()}>Verify agent save</button>{draft.existing&&<button disabled={busy} onClick={()=>void read(draft.roleId)}>Read current agent and replace draft</button>}</>}
    </>}{(notice??draftNotice)&&<p role="status">{notice??draftNotice}</p>}</section>;
}

export function ExtensionsPage(props:{refreshToken?:string;executionBlockReason?:string|null;host:HostView;sessionId:number|null;runId:number|null;activeRunId:number|null;stopping:boolean;onStop:()=>void;onDetails:()=>void;onPublished:()=>void;onSettings?:()=>void;onChat?:()=>void;onNotice?:(notice:string|null)=>void}) {
  const key=JSON.stringify([props.host.instanceId,props.host.state,props.sessionId,props.runId]),current=useRef(key);current.current=key;
  const order=useRef(0),writing=useRef(false);
  const refreshedVersion=useRef(props.refreshToken);
  const [view,setView]=useState<{key:string;selection:Extract<ExtensionsReadResult,{source:'selection'}>;run:Extract<ExtensionsReadResult,{source:'run'}>|null}|null>(null);
  const [catalog,setCatalog]=useState<{key:string;data:ExtensionsCatalogReadResult}|null>(null),[configuring,setConfiguring]=useState(false),[reading,setReading]=useState(false);
  const [draft,setDraft]=useState<boolean|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState<string|null>(null),[status,setStatus]=useState<ExtensionStatus|null>(null);
  useEffect(()=>{props.onNotice?.(notice??(draft!==null?'Extension selection has unsaved changes.':null));},[notice,draft,props.onNotice]);
  const data=view?.key===key?view:null,hostReady=props.host.state==='ready'&&!!props.host.instanceId,ready=hostReady&&props.sessionId!==null;
  const available=data?.selection.available??(catalog?.key===key?catalog.data.available:null);
  const extensionRef=available?.ref??data?.selection.selection.extension;
  async function refresh() {
    if(!hostReady)return;const owner=key,seq=++order.current;setReading(true);
    try {
      if(props.sessionId===null){
        const result=await window.medclaw.request('extensions.catalog.read',{});
        if(current.current!==owner||seq!==order.current)return;
        if(result.ok){setCatalog({key:owner,data:result.data});setNotice(null);}else setNotice(errorMessage(result.error));
        return;
      }
      const selection=await window.medclaw.request('extensions.read',{source:'selection',sessionId:props.sessionId});
      const run=props.runId===null?null:await window.medclaw.request('extensions.read',{source:'run',runId:props.runId});
      if(current.current!==owner||seq!==order.current)return;
      if(!selection.ok){setNotice(errorMessage(selection.error));return;}
      if(selection.data.source!=='selection'||selection.data.sessionId!==props.sessionId)throw new Error('Owner mismatch');
      if(run&&!run.ok){setNotice(errorMessage(run.error));return;}
      if(run?.ok&&(run.data.source!=='run'||run.data.runId!==props.runId||run.data.sessionId!==props.sessionId))throw new Error('Owner mismatch');
      setView({key:owner,selection:selection.data,run:run?.ok&&run.data.source==='run'?run.data:null});
    }catch{if(current.current===owner&&seq===order.current)setNotice('Extension status is unconfirmed. Refresh to verify original facts.');}
    finally{if(current.current===owner&&seq===order.current)setReading(false);}
  }
  useEffect(()=>{
    setView(null);setCatalog(null);setDraft(null);setNotice(null);setStatus(null);setBusy(false);setReading(false);
    if(!hostReady)return;
    void refresh();
    const unsubscribe=window.medclaw.subscribe(notice=>{if(notice.instanceId===props.host.instanceId&&(!('sessionId' in notice)||notice.sessionId===props.sessionId))void refresh();});
    return()=>{++order.current;unsubscribe();};
  },[key]);
  useEffect(()=>{if(refreshedVersion.current!==props.refreshToken){refreshedVersion.current=props.refreshToken;void refresh();}},[props.refreshToken]);
  async function publish() {
    if(!ready||!data||draft===null||writing.current)return;writing.current=true;setBusy(true);setNotice(null);const owner=key;
    try {
      const extension=draft?data.selection.available?.ref:null;if(draft&&!extension)return;
      const result=await window.medclaw.request('extensions.select',{sessionId:props.sessionId!,expectedConfigVersion:data.selection.configVersion,selection:{extension:extension??null}});
      if(current.current!==owner)return;
      if(!result.ok){setNotice(errorMessage(result.error));return;}
      if(result.data.sessionId!==props.sessionId)throw new Error('Owner mismatch');
      setDraft(null);setNotice('Saved for the next assembly.');props.onPublished();await refresh();
    }catch{if(current.current===owner)setNotice('Selection is unconfirmed. Refresh before saving again.');}
    finally{writing.current=false;if(current.current===owner)setBusy(false);}
  }
  const live=data?.selection.live,proof=live??data?.run?.assembly;
  async function command() {
    if(props.executionBlockReason){setNotice(props.executionBlockReason);return;}
    if(!live||busy)return;const owner=key,assemblyId=live.assemblyId;setBusy(true);setNotice(null);
    try {
      const result=await window.medclaw.request('extensions.command',{instanceId:live.instanceId,sessionId:live.sessionId,runId:live.runId,assemblyId,command:'extension_status'});
      if(current.current!==owner||data?.selection.live?.assemblyId!==assemblyId)return;
      if(!result.ok){setNotice(errorMessage(result.error));return;}
      if(result.data.assemblyId!==assemblyId||result.data.runId!==live.runId||result.data.instanceId!==live.instanceId)throw new Error('Owner mismatch');
      setStatus(result.data);
    }catch{if(current.current===owner)setNotice('Original extension command completion is unconfirmed.');}
    finally{if(current.current===owner)setBusy(false);}
  }
  return <section className="panel" data-testid="extensions-panel"><h2>Trusted Pi Extensions</h2>
    {!hostReady?<div className="empty-state"><p role="status">{props.host.error?errorMessage(props.host.error):'Host must be ready to read extensions.'}</p>{props.onSettings&&<button onClick={props.onSettings}>Open Settings</button>}</div>:<>
      <div className="panel-heading"><p className="muted">Trusted tools for your conversations.</p><button className="quiet" disabled={busy||reading} onClick={()=>void refresh()}>Refresh extensions</button></div>
      {reading&&<p role="status">Reading extensions…</p>}
      {extensionRef&&<article className="resource-summary"><div><h3>{extensionRef.id}</h3><p>{available?'Tool audit and a read-only runtime status command.':'Selected extension is unavailable. You can disable it for the next assembly.'}</p><span className="status-badge">{available?'First party':'Unavailable'} · {extensionRef.version}{data?data.selection.selection.extension?' · Enabled for this Session':' · Disabled':''}</span></div><button disabled={!ready} onClick={()=>setConfiguring(value=>!value)} aria-expanded={configuring}>Configure extension</button></article>}
      {!ready&&<p>Select a confirmed user Session to configure extensions. {props.onChat&&<button className="quiet" onClick={props.onChat}>Choose session</button>}</p>}
      {catalog?.key===key&&catalog.data.diagnostics.map((error,index)=><p role="alert" key={index}>{errorMessage(error)}</p>)}
      {!reading&&!notice&&!extensionRef&&(data||catalog?.key===key)&&<p>No validated extension is available.</p>}
      {data&&<>
        <div hidden={!configuring} className="task-surface">
        <p>Selection: {data.selection.selection.extension?'Enabled for next assembly':'Disabled'}</p>
        <p>Extensions run as trusted host code with OS permissions. This version provides a tool audit and a read-only status command.</p>
        <label className="switch-control"><input type="checkbox" role="switch" aria-label="Enable tool-audit" checked={draft??!!data.selection.selection.extension} disabled={busy||!data.selection.available&&!(draft??!!data.selection.selection.extension)} onChange={event=>setDraft(event.target.checked)}/><span className="switch-track" aria-hidden="true"/><span className="switch-label">Enable tool-audit</span></label>
        <button disabled={busy||draft===null||props.activeRunId!==null} onClick={()=>void publish()}>Save extension selection</button>
        </div>
        {draft!==null&&<p role="status">Extension selection has unsaved changes.</p>}
        {props.activeRunId!==null&&<p>Stop Run {props.activeRunId} and confirm release before changing selection. <button onClick={props.onStop} disabled={props.stopping}>Stop active Run</button></p>}
        <p>Actual assembly: {proof?`${live?'Current':'Recorded'} ${proof.state}`:'No assembly evidence'}</p>
        <details className="advanced-section"><summary>Extension runtime details</summary>
        <p>Session {props.sessionId} · Configuration {data.selection.configVersion}</p>
        {data.selection.available&&<p>First party · {data.selection.available.ref.id}@{data.selection.available.ref.version} · Pi {data.selection.available.sdkVersion}</p>}
        {proof&&<>
          <p>Owner: Host {proof.instanceId} · Session {proof.sessionId} · Run {proof.runId} · Assembly <code>{proof.assemblyId}</code></p>
          <p>Callable tools: {proof.callableTools.join(', ')||'None'} · Commands: {proof.callableCommands.join(', ')||'None'}</p>
          <p>Observed calls: {proof.hookCounts.tool_call} · Resources released: {String(proof.resourcesReleased)}</p>
        </>}
        </details>
        {proof?.diagnostics.map((error,index)=><p role="alert" key={index}>{error.code}: {errorMessage(error)}</p>)}
        {data.run&&<p>Run {data.run.runId} evidence: {data.run.evidence} · Required facts saved: {String(data.run.cleanup?.requiredPersistenceComplete??'Unconfirmed')}</p>}
        {props.runId!==null&&<button onClick={props.onDetails}>View original run facts</button>}
        <button disabled={!!props.executionBlockReason||busy||!live||live.state!=='active'||live.resourcesReleased||props.stopping||props.activeRunId!==live.runId} onClick={()=>void command()}>Read extension status</button>{props.executionBlockReason&&<p role="status">{props.executionBlockReason}</p>}
        {status&&live?.assemblyId===status.assemblyId&&<details className="advanced-section" open><summary>Extension status response</summary><pre data-testid="extension-command">{JSON.stringify(status,null,2)}</pre></details>}
        {data.selection.diagnostics.map((error,index)=><p role="alert" key={index}>{errorMessage(error)}</p>)}
      </>}
    </>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
