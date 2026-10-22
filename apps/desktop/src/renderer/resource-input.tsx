import {useEffect,useRef,useState} from 'react';
import type {HostView} from '../../../../packages/contracts/src/model';
import {errorMessage} from '../../../../packages/contracts/src/error';
import type {ResourceSourceInput} from '../../../../packages/contracts/src/resources';
type CommandItem={group:'skills'|'subagents'|'prompt_templates'|'extension_commands';id:string;command:string;description:string;available:boolean;reasons:string[]};
const commandGroups={skills:'Skills',subagents:'Subagents',prompt_templates:'Prompt Templates',extension_commands:'Extension Commands'} as const;
export function ResourceInput(props:{host:HostView;source:ResourceSourceInput|null;configVersion?:string;visible:boolean;value:string;disabled:boolean;onChange:(text:string)=>void;canSend:boolean;onSend:()=>void;onManageAgents?:()=>void}){
  const key=JSON.stringify([props.host.instanceId,props.host.state,props.source,props.configVersion]),owner=useRef(key);owner.current=key;
  const [view,setView]=useState<{key:string;data:CommandItem[]}|null>(null),[failure,setFailure]=useState<{key:string;text:string}|null>(null);
  const [dismissed,setDismissed]=useState<string|null>(null),[active,setActive]=useState(-1),input=useRef<HTMLTextAreaElement>(null),reading=useRef<string|null>(null);
  const query=/^\/[^\s]*$/.test(props.value)&&props.visible&&!props.disabled, data=view?.key===key?view.data:null;
  const problem=failure?.key===key?failure.text:null;
  async function refresh(){
    if(!props.source||props.host.state!=='ready'||!props.host.instanceId||reading.current===key)return;
    const target=key,source=props.source;reading.current=target;setFailure(null);
    try{
      const result=source.source==='selection'?await window.medclaw.request('input.commands.list',{sessionId:source.sessionId}):await window.medclaw.request('resources.list',source);
      if(owner.current!==target)return;
      if(!result.ok){setFailure({key:target,text:errorMessage(result.error)});return;}
      const items:CommandItem[]=source.source==='selection'?(result.data.items as CommandItem[]):('source' in result.data&&result.data.source==='run'&&result.data.runId===source.runId?result.data.items.filter(item=>item.enabled&&item.availability==='ready').map(item=>({group:item.ref.kind==='skill'?'skills' as const:'prompt_templates' as const,id:item.ref.id,command:item.ref.kind==='skill'?'/skill:'+item.ref.id:'/'+item.ref.id,description:item.description??item.ref.id,available:true,reasons:[]})):[]);
      setView({key:target,data:items});
    }catch{if(owner.current===target)setFailure({key:target,text:'Resource commands are unconfirmed. Refresh before choosing a command.'});}
    finally{if(reading.current===target)reading.current=null;}
  }
  useEffect(()=>{if(query)void refresh();},[query,key]);
  useEffect(()=>{setActive(-1);setDismissed(null);},[props.value,key]);
  useEffect(()=>{if(input.current){input.current.style.height='auto';input.current.style.height=Math.min(160,input.current.scrollHeight+input.current.offsetHeight-input.current.clientHeight)+'px';}},[props.value,key]);
  useEffect(()=>()=>{owner.current='unmounted';},[]);
  const candidates=(data??[]).filter(item=>item.command.toLowerCase().startsWith(props.value.toLowerCase()));
  const open=query&&dismissed!==props.value&&!!data;
  function choose(index:number){const candidate=candidates[index];if(!open||!candidate?.available)return;props.onChange(candidate.command.replace(/\s+$/,'')+' ');input.current?.focus();}
  return <>
    <label className="sr-only" htmlFor="message-text">Message text</label><textarea id="message-text" rows={1} ref={input} value={props.value} disabled={props.disabled} placeholder="Type a message…"
      aria-controls={open?'resource-commands':undefined} aria-expanded={open} aria-autocomplete="list" aria-activedescendant={open&&active>=0?'resource-command-'+active:undefined}
      onChange={e=>props.onChange(e.target.value)} onKeyDown={e=>{
        if(e.nativeEvent.isComposing||e.keyCode===229)return;
        if(open&&candidates.length&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const down=e.key==='ArrowDown';setActive(index=>{if(index<0)return down?0:candidates.length-1;return (index+(down?1:-1)+candidates.length)%candidates.length;});return;}
        if(open&&e.key==='Escape'){e.preventDefault();setDismissed(props.value);return;}
        if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(open&&candidates.length){choose(active<0?candidates.findIndex(item=>item.available):active);}else if(props.canSend&&props.value.trim())props.onSend();}
      }}/>
    {open&&<div role="listbox" id="resource-commands" aria-label="Resource commands" className="resource-input-menu">{(Object.keys(commandGroups) as (keyof typeof commandGroups)[]).map(group=>{
      const items=candidates.map((item,index)=>({item,index})).filter(value=>value.item.group===group);
      return <div role="group" aria-label={commandGroups[group]} key={group}><strong>{commandGroups[group]}</strong>{items.map(({item,index})=><button type="button" role="option" disabled={!item.available} aria-selected={active===index} id={'resource-command-'+index} key={item.group+':'+item.id} title={item.reasons.join(', ')} onClick={()=>choose(index)}>{item.command} · {item.description}{!item.available?' · Unavailable':''}</button>)}{group==='subagents'&&props.onManageAgents&&<button type="button" onClick={props.onManageAgents}>Manage agents</button>}</div>;
    })}</div>}
    {query&&problem&&<p role="alert">{problem} <button onClick={()=>void refresh()}>Refresh resource commands</button></p>}
  </>;
}
