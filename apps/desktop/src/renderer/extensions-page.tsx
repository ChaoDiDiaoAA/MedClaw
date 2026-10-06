import {useEffect,useRef,useState} from 'react';
import {errorMessage} from '../../../../packages/contracts/src/error';
import type {HostView} from '../../../../packages/contracts/src/model';
import type {ExtensionsReadResult} from '../../../../packages/contracts/src/protocol';
import type {ExtensionStatus} from '../../../../packages/contracts/src/extensions';

export function ExtensionsPage(props:{host:HostView;sessionId:number|null;runId:number|null;activeRunId:number|null;stopping:boolean;onStop:()=>void;onDetails:()=>void;onPublished:()=>void}) {
  const key=JSON.stringify([props.host.instanceId,props.host.state,props.sessionId,props.runId]),current=useRef(key);current.current=key;
  const order=useRef(0),writing=useRef(false);
  const [view,setView]=useState<{key:string;selection:Extract<ExtensionsReadResult,{source:'selection'}>;run:Extract<ExtensionsReadResult,{source:'run'}>|null}|null>(null);
  const [draft,setDraft]=useState<boolean|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState<string|null>(null),[status,setStatus]=useState<ExtensionStatus|null>(null);
  const data=view?.key===key?view:null,ready=props.host.state==='ready'&&!!props.host.instanceId&&props.sessionId!==null;
  async function refresh() {
    if(!ready||props.sessionId===null)return;const owner=key,seq=++order.current;
    try {
      const selection=await window.medclaw.request('extensions.read',{source:'selection',sessionId:props.sessionId});
      const run=props.runId===null?null:await window.medclaw.request('extensions.read',{source:'run',runId:props.runId});
      if(current.current!==owner||seq!==order.current)return;
      if(!selection.ok){setNotice(errorMessage(selection.error));return;}
      if(selection.data.source!=='selection'||selection.data.sessionId!==props.sessionId)throw new Error('Owner mismatch');
      if(run&&!run.ok){setNotice(errorMessage(run.error));return;}
      if(run?.ok&&(run.data.source!=='run'||run.data.runId!==props.runId||run.data.sessionId!==props.sessionId))throw new Error('Owner mismatch');
      setView({key:owner,selection:selection.data,run:run?.ok&&run.data.source==='run'?run.data:null});
    }catch{if(current.current===owner&&seq===order.current)setNotice('Extension status is unconfirmed. Refresh to verify original facts.');}
  }
  useEffect(()=>{
    setView(null);setDraft(null);setNotice(null);setStatus(null);setBusy(false);void refresh();
    const unsubscribe=window.medclaw.subscribe(notice=>{if(notice.instanceId===props.host.instanceId&&(!('sessionId' in notice)||notice.sessionId===props.sessionId))void refresh();});
    return()=>{++order.current;unsubscribe();};
  },[key]);
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
  return <section data-testid="extensions-panel"><h2>Trusted Pi Extensions</h2>
    {!ready?<p>Select a confirmed user Session to inspect extensions.</p>:<>
      <p>Session {props.sessionId} · Configuration {data?.selection.configVersion??'Unconfirmed'}</p>
      <button disabled={busy} onClick={()=>void refresh()}>Refresh extensions</button>
      {data&&<>
        <p>Selection: {data.selection.selection.extension?'Enabled for next assembly':'Disabled'}</p>
        {data.selection.available&&<p>First party · {data.selection.available.ref.id}@{data.selection.available.ref.version} · Pi {data.selection.available.sdkVersion} · Hash <code>{data.selection.available.ref.treeHash}</code></p>}
        <p>Extensions run as trusted host code with OS permissions. This version provides a tool audit and a read-only status command.</p>
        <label><input type="checkbox" aria-label="Enable tool-audit" checked={draft??!!data.selection.selection.extension} disabled={busy||!data.selection.available&&!(draft??!!data.selection.selection.extension)} onChange={event=>setDraft(event.target.checked)}/> Enable tool-audit</label>
        <button disabled={busy||draft===null||props.activeRunId!==null} onClick={()=>void publish()}>Save extension selection</button>
        {props.activeRunId!==null&&<p>Stop Run {props.activeRunId} and confirm release before changing selection. <button onClick={props.onStop} disabled={props.stopping}>Stop active Run</button></p>}
        <p>Actual assembly: {proof?`${live?'Current':'Recorded'} ${proof.state}`:'No assembly evidence'}</p>
        {proof&&<>
          <p>Owner: Host {proof.instanceId} · Session {proof.sessionId} · Run {proof.runId} · Assembly <code>{proof.assemblyId}</code></p>
          <p>Callable tools: {proof.callableTools.join(', ')||'None'} · Commands: {proof.callableCommands.join(', ')||'None'}</p>
          <p>Observed calls: {proof.hookCounts.tool_call} · Resources released: {String(proof.resourcesReleased)}</p>
          {proof.diagnostics.map((error,index)=><p role="alert" key={index}>{error.code}: {errorMessage(error)}</p>)}
        </>}
        {data.run&&<p>Run {data.run.runId} evidence: {data.run.evidence} · Required facts saved: {String(data.run.cleanup?.requiredPersistenceComplete??'Unconfirmed')}</p>}
        {props.runId!==null&&<button onClick={props.onDetails}>View original run facts</button>}
        <button disabled={busy||!live||live.state!=='active'||live.resourcesReleased||props.stopping||props.activeRunId!==live.runId} onClick={()=>void command()}>Read extension status</button>
        {status&&live?.assemblyId===status.assemblyId&&<pre data-testid="extension-command">{JSON.stringify(status,null,2)}</pre>}
        {data.selection.diagnostics.map((error,index)=><p role="alert" key={index}>{errorMessage(error)}</p>)}
      </>}
    </>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
