import {useEffect,useRef,useState} from 'react';
import type {HostView} from '../../../../packages/contracts/src/model';
import {errorMessage} from '../../../../packages/contracts/src/error';
import type {ResourceSourceInput,ResourceList} from '../../../../packages/contracts/src/resources';
export function ResourceInput(props:{host:HostView;source:ResourceSourceInput|null;configVersion?:string;visible:boolean;value:string;disabled:boolean;onChange:(text:string)=>void;canSend:boolean;onSend:()=>void}){
  const key=JSON.stringify([props.host.instanceId,props.host.state,props.source,props.configVersion]),owner=useRef(key);owner.current=key;
  const [view,setView]=useState<{key:string;data:ResourceList}|null>(null),[failure,setFailure]=useState<{key:string;text:string}|null>(null);
  const [dismissed,setDismissed]=useState<string|null>(null),[active,setActive]=useState(-1),input=useRef<HTMLTextAreaElement>(null),reading=useRef<string|null>(null);
  const query=/^\/[^\s]*$/.test(props.value)&&props.visible&&!props.disabled, data=view?.key===key?view.data:null;
  const problem=failure?.key===key?failure.text:null;
  async function refresh(){
    if(!props.source||props.host.state!=='ready'||!props.host.instanceId||reading.current===key)return;
    const target=key,source=props.source;reading.current=target;setFailure(null);
    try{
      const result=await window.medclaw.request('resources.list',source);
      if(owner.current!==target)return;
      if(!result.ok){setFailure({key:target,text:errorMessage(result.error)});return;}
      if(result.data.source!==source.source||(source.source==='run'?result.data.source!=='run'||result.data.runId!==source.runId:result.data.source!=='selection'||result.data.sessionId!==source.sessionId))throw new Error('Resource source mismatch');
      setView({key:target,data:result.data});
    }catch{if(owner.current===target)setFailure({key:target,text:'Resource commands are unconfirmed. Refresh before choosing a command.'});}
    finally{if(reading.current===target)reading.current=null;}
  }
  useEffect(()=>{if(query&&!data&&!problem)void refresh();},[query,key,data,problem]);
  useEffect(()=>{setActive(-1);setDismissed(null);},[props.value,key]);
  useEffect(()=>{if(input.current){input.current.style.height='auto';input.current.style.height=Math.min(160,input.current.scrollHeight+input.current.offsetHeight-input.current.clientHeight)+'px';}},[props.value,key]);
  useEffect(()=>()=>{owner.current='unmounted';},[]);
  const candidates=(data?.items??[]).filter(item=>item.enabled&&item.availability==='ready').map(item=>({item,command:item.ref.kind==='skill'?'/skill:'+item.ref.id:'/'+item.ref.id}))
    .filter(value=>value.command.toLowerCase().startsWith(props.value.toLowerCase()));
  const open=query&&dismissed!==props.value&&candidates.length>0;
  function choose(index:number){const candidate=candidates[index];if(!open||!candidate)return;props.onChange(candidate.command+' ');input.current?.focus();}
  return <>
    <label className="sr-only" htmlFor="message-text">Message text</label><textarea id="message-text" ref={input} value={props.value} disabled={props.disabled} placeholder="Type a message…"
      aria-controls={open?'resource-commands':undefined} aria-expanded={open} aria-autocomplete="list" aria-activedescendant={open&&active>=0?'resource-command-'+active:undefined}
      onChange={e=>props.onChange(e.target.value)} onKeyDown={e=>{
        if(e.nativeEvent.isComposing||e.keyCode===229)return;
        if(open&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const down=e.key==='ArrowDown';setActive(index=>{if(index<0)return down?0:candidates.length-1;return (index+(down?1:-1)+candidates.length)%candidates.length;});return;}
        if(open&&e.key==='Escape'){e.preventDefault();setDismissed(props.value);return;}
        if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(open){choose(active<0?0:active);}else if(props.canSend&&props.value.trim())props.onSend();}
      }}/>
    {open&&<div role="listbox" id="resource-commands" aria-label="Resource commands" className="resource-input-menu">{(['skill','prompt']as const).map(kind=>{
      const items=candidates.map((value,index)=>({...value,index})).filter(value=>value.item.ref.kind===kind);
      return items.length>0&&<div role="group" aria-label={kind==='skill'?'Skills':'Prompt Templates'} key={kind}><strong>{kind==='skill'?'Skills':'Prompt Templates'}</strong>{items.map(({item,command,index})=><button type="button" role="option" aria-selected={active===index} id={'resource-command-'+index} key={command} onClick={()=>choose(index)}>{command} · {item.name??item.ref.id} · {item.ref.version}</button>)}</div>;
    })}</div>}
    {query&&problem&&<p role="alert">{problem} <button onClick={()=>void refresh()}>Refresh resource commands</button></p>}
  </>;
}
