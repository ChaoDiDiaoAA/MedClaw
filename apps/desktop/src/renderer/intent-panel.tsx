import {useEffect,useRef,useState} from 'react';
import {errorMessage} from '../../../../packages/contracts/src/error';
import type {IntentItem,IntentReadResult,IntentSlots,IntentStatus,QueryContextRecord} from '../../../../packages/contracts/src/intent';
import type {HostView} from '../../../../packages/contracts/src/model';

export type IntentAction='intent'|'explicit_agent_fallback';

const label=(name:string)=>name.replace(/([a-z])([A-Z])/g,'$1 $2').replaceAll('_',' ');
const comparisons:Record<string,string>={gt:'>',gte:'≥',lt:'<',lte:'≤'};
const statusText:Record<IntentStatus,string>={
  RESOLVED:'The task is resolved. Saved execution facts are shown below.',
  AMBIGUOUS:'Clarify the intended task using the recorded question and options.',
  NEED_PARAMETERS:'Provide the missing parameters to resolve this task.',
  OUT_OF_SCOPE:'This request is outside the registered medical-device tasks.',
  UNSUPPORTED_DATA:'The current data or tools do not support this task.',
};
function valueText(value:unknown):string {
  if(value===null)return 'Unknown';
  if(Array.isArray(value))return value.map(valueText).join('; ')||'None';
  if(typeof value==='object'){
    const fields=value as Record<string,unknown>;
    if(typeof fields.start==='string'&&typeof fields.endExclusive==='string')return `${fields.start} ≤ date < ${fields.endExclusive}`;
    if(typeof fields.operator==='string'&&Object.hasOwn(comparisons,fields.operator)&&typeof fields.value==='number')return `${comparisons[fields.operator]} ${fields.value}`;
    return Object.entries(fields).map(([key,part])=>`${label(key)}: ${valueText(part)}`).join(' · ');
  }
  return String(value);
}
function Slots({slots}:{slots:IntentSlots}) {
  return <dl className="facts">{Object.entries(slots).filter(([,value])=>value!==null).flatMap(([key,value])=>[
    <dt key={key+'-label'}>{label(key)}</dt>,<dd key={key}>{valueText(value)}</dd>,
  ])}</dl>;
}
function TaskIntents({items}:{items:IntentItem[]}) {
  return <>{items.map(item=><article key={item.id}>
    <p><strong>{item.id}</strong> · {item.l0} / {item.l1} / {item.l2}</p><Slots slots={item.slots}/>
    {Object.keys(item.parameters).length>0&&<dl className="facts">{Object.entries(item.parameters).flatMap(([key,value])=>[
      <dt key={key+'-label'}>{label(key)}</dt>,<dd key={key}>{valueText(value)}</dd>,
    ])}</dl>}
    <p className="tiny">Dependencies: {item.dependsOn.join(', ')||'None'} · Result reference: {item.resultRef?valueText(item.resultRef):'None'}</p>
  </article>)}</>;
}
export function QueryConditions(props:{sessionId:number|null;context:QueryContextRecord|null|undefined;onQuery?:(queryId:number,sessionId:number)=>void}) {
  const context=props.context;
  if(!context||context.sessionId!==props.sessionId)return null;
  return <section className="panel" aria-label="Current query conditions"><h3>Current query conditions</h3>
    <p className="tiny">Source: Run {context.sourceRunId} · Input {context.sourceInputId} · Version {context.version}</p>
    <p className="tiny">Leaf: <code>{context.nativeLeafId}</code></p><Slots slots={context.adoptedSlots}/>
    <p>Saved queries: {context.queryIds.map((id,index)=><span key={id}>{index>0?', ':''}{props.onQuery?<button onClick={()=>props.onQuery!(id,context.sessionId)}>Query #{id}</button>:`Query #${id}`}</span>)}</p>
    {context.pendingClarification&&<p role="status">Pending task: {context.pendingClarification.taskText} · Missing: {context.pendingClarification.missingSlots.join(', ')}</p>}
  </section>;
}
export function IntentPanel(props:{host:HostView;runId:number;sessionId:number;inputId:number|null;refreshToken:string;onQuery?:(queryId:number,sessionId:number)=>void;onAction?:(mode:IntentAction)=>void;actionsDisabled?:boolean}) {
  const key=JSON.stringify([props.host.instanceId,props.host.state,props.runId,props.sessionId,props.inputId]),current=useRef(key);current.current=key;
  const order=useRef(0),[view,setView]=useState<{key:string;data:IntentReadResult|null}|null>(null),[notice,setNotice]=useState<{key:string;text:string}|null>(null),[busy,setBusy]=useState<string|null>(null);
  const data=view?.key===key?view.data:null,ready=props.host.state==='ready'&&!!props.host.instanceId;
  async function read(){
    if(!ready)return;const owner=key,attempt=++order.current;setBusy(owner);
    try{
      const result=await window.medclaw.request('intent.read',{runId:props.runId});
      if(current.current!==owner||attempt!==order.current)return;
      if(!result.ok){setNotice({key:owner,text:errorMessage(result.error)});return;}
      if(result.data&&(result.data.runId!==props.runId||result.data.sessionId!==props.sessionId||result.data.inputId!==props.inputId))throw new Error('Intent owner mismatch');
      setView({key:owner,data:result.data});setNotice(null);
    }catch{if(current.current===owner&&attempt===order.current)setNotice({key:owner,text:'Intent facts are unconfirmed. Refresh the original Run.'});}
    finally{if(current.current===owner&&attempt===order.current)setBusy(null);}
  }
  useEffect(()=>{void read();return()=>{++order.current;};},[key,props.refreshToken]);
  if(view?.key===key&&view.data===null&&!notice)return null;
  const decision=data?.decision;
  return <section aria-label="Intent recognition"><h3>Intent recognition</h3>
    <button disabled={!ready||busy===key} onClick={()=>void read()}>Refresh intent facts</button>
    {notice?.key===key&&<p role="alert">{notice.text}</p>}
    {!data?<p className="muted">Intent facts unconfirmed.</p>:<>
      <p>Intent calls: {data.calls.length}</p>
      {props.onAction&&['completed','failed','cancelled'].includes(data.execution.runStatus)&&data.execution.requiredPersistenceComplete===true&&<div className="actions">
        <p className="tiny">Creates a new Run using the full original task and its data scope.</p>
        <button disabled={props.actionsDisabled||!ready||busy===key||notice?.key===key} onClick={()=>props.onAction!('intent')}>Retry recognition</button>
        {(data.execution.runStatus!=='completed'||decision?.route==='clarify'||decision?.route==='reject')&&<button disabled={props.actionsDisabled||!ready||busy===key||notice?.key===key} onClick={()=>props.onAction!('explicit_agent_fallback')}>Analyze with main agent</button>}
      </div>}
      <section><h4>Rule</h4>{data.ruleEvaluation?<><p>{data.ruleEvaluation.outcome} · {data.ruleEvaluation.ruleId??'No matched rule'}</p><p className="tiny">{data.ruleEvaluation.reasonCode} · {data.ruleEvaluation.ruleVersion} · {data.ruleEvaluation.checkedAt}</p></>:<p>Not evaluated</p>}</section>
      {(['classify','verify'] as const).map(stage=>{const call=data.calls.find(value=>value.stage===stage);return <section key={stage}>
        <h4>{stage==='classify'?'Classification':'Review'}</h4>{!call?<p>Not called</p>:<>
          <p>{call.state} · <code>{call.callId}</code></p><p className="tiny">{call.model.modelTag} · <code>{call.model.modelDigest}</code></p>
          <p className="tiny">Started: {call.startedAt} · Ended: {call.endedAt??'Unconfirmed'}</p>
          {call.previousCallId&&<p className="tiny">Previous call: <code>{call.previousCallId}</code></p>}
          {call.error&&<p role="alert">{errorMessage(call.error)}</p>}
          {call.prediction&&<><p>Predicted status: {call.prediction.status}</p><TaskIntents items={call.prediction.intents}/>
            {call.prediction.candidateIntents.map((candidate,index)=><details key={index}><summary>Candidate {index+1} · {candidate.reasonCode}</summary><TaskIntents items={candidate.intents}/></details>)}
            {call.prediction.clarification&&<div role="status"><p>{call.prediction.clarification.question}</p><p>Missing: {call.prediction.clarification.missingSlots.join(', ')||'None'} · Options: {call.prediction.clarification.options.join('; ')||'None'}</p></div>}
          </>}
          <p>Program validation: {call.validation?.state??'Unconfirmed'}</p>
          {!!call.validation?.adoptedIntents.length&&<details><summary>Program-validated task</summary><TaskIntents items={call.validation.adoptedIntents}/></details>}
          {call.validation&&<><p>Validated status: {call.validation.finalStatus??'Unconfirmed'}</p><p>Missing slots: {call.validation.missingSlots.join(', ')||'None'}</p>{call.validation.issues.map((issue,index)=><p key={index}>{issue.intentId??'Task'} · {issue.code} · {issue.slot}: {issue.message}{issue.candidates.length>0&&` · Options: ${issue.candidates.join('; ')}`}</p>)}</>}
          {call.rawOutput&&<details><summary>Saved model output{call.rawOutput.truncated?' (truncated)':''}</summary><pre>{call.rawOutput.text}</pre></details>}
        </>}</section>;})}
      <section><h4>Adopted</h4>{!decision?<p>No adopted decision</p>:<>
        <p>Decision {decision.id} · {decision.decisionSource} · {decision.matchedBy??'No classifier'} · {decision.status??'Unspecified'}</p>
        {decision.status&&<p>{statusText[decision.status]}</p>}
        <p>Planned route: {decision.route}</p><p className="tiny">Adopted call: <code>{decision.intentCallId??'None'}</code></p>
        <TaskIntents items={decision.adoptedIntents}/><p>Missing slots: {decision.missingSlots.join(', ')||'None'}</p>
        {decision.issues.map((issue,index)=><p key={index}>{issue.code}: {issue.message}</p>)}
      </>}</section>
      <section><h4>Execution</h4><p>Run status: {data.execution.runStatus}</p><p>Final history saved: {data.execution.finalHistorySaved?'Yes':'No'}</p>
        <p>Required persistence complete: {data.execution.requiredPersistenceComplete===null?'Unconfirmed':data.execution.requiredPersistenceComplete?'Yes':'No'}</p>
        <p>Answer: {data.execution.answerId===null?'None':`#${data.execution.answerId}`}</p>
        <p>Saved queries: {data.execution.queryIds.length?data.execution.queryIds.map((id,index)=><span key={id}>{index>0?', ':''}{props.onQuery?<button onClick={()=>props.onQuery!(id,props.sessionId)}>Query #{id}</button>:`Query #${id}`}</span>):'None'}</p>
        {data.execution.stepResults.map(step=><p key={step.stepId}>{step.stepId}: {step.queryRefs.map(ref=>`Query #${ref.queryId}`).join(', ')||'No saved queries'}</p>)}
      </section>
    </>}
  </section>;
}
