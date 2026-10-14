import {validateToolArguments,type Tool} from '@earendil-works/pi-ai';
import {equal,record} from './rules.ts';
import {completeToolOriginals,verifiedOriginals,toolDeliveryRequest} from './project-harness.ts';
import {projectObservation,type ObservationProjection} from './project-observation.ts';
import {registry} from './registry.ts';
import type {CheckSpec,EvaluationContext} from './types.ts';

const list=(value:unknown):any[]=>Array.isArray(value)?value:[];
const gap=(reason:string):ObservationProjection=>({evidenceRefs:[],reason});
export const generalToolMetrics=new Set(['tool.recall','tool.precision','tool.error_rate','tool.argument_validity','tool.recovery']);
export function toolCapabilities(name:string):string[]{
  return [...new Set([name,.../^query_(?:current|changes|device_changes|aggregate|trend|intent_step)/.test(name)?['query']:[],...name==='Agent'?['delegate','agent']:[],...name.startsWith('export_')?['export']:[]])];
}
function schemaValidity(name:string,input:unknown,schemas:any[]):boolean|null {
  const schemasForName=schemas.filter(tool=>(tool.function?.name??tool.name)===name).map(tool=>tool.function?.parameters??tool.input_schema??tool.parameters);
  if(!schemasForName.length||schemasForName.some(schema=>!equal(schema,schemasForName[0]))||!record(schemasForName[0]))return null;
  try{return equal(validateToolArguments({name,description:'Recorded tool input',parameters:schemasForName[0]} as Tool,{type:'toolCall',id:'validation',name,arguments:input as Record<string,any>}),input);}catch{return false;}
}
export async function projectGeneralTools(check:CheckSpec,context:EvaluationContext):Promise<ObservationProjection|undefined>{
  if(!generalToolMetrics.has(check.metricId))return;
  const facts=context.observation?.facts;if(!facts)return gap('Original tool inventory missing');
  const all=completeToolOriginals(context);if(!all)return gap('Complete native tool originals, SDK attempts and child inventory required');
  const bindings=list(record(facts.aliases)?facts.aliases.runs:[]),bound=bindings.filter(binding=>binding.alias===check.scope?.ref);
  if(check.scope?.kind==='run'&&bound.length!==1)return gap('Authored tool scope must bind uniquely to a Run');
  const root=check.scope?.kind==='run'?bound[0].runId:undefined;
  const tools=all.filter(tool=>root===undefined||tool.runId===root);
  const refs=tools.map(tool=>'original:tool:'+tool.id),schemas:any[]=[];
  for(const entry of verifiedOriginals(facts,'providerRequests'))for(const req of list(entry.original)){
    if(req.bytes!==Buffer.byteLength(req.body))continue;
    try{const payload=JSON.parse(req.body);if(list(facts.modelCalls).some(call=>call.callId===req.callId&&tools.some(tool=>tool.modelCallId===call.callId)))schemas.push(...list(payload.tools));}catch{}
  }
  const entries=verifiedOriginals(facts,'nativeHistory').flatMap(item=>list(item.original.entries).map(entry=>({...entry,sessionId:item.original.sessionId})));
  const calls=tools.map(tool=>{
    const original=entries.filter(entry=>entry.sessionId===tool.sessionId).flatMap(entry=>list(entry.message?.content)).find(part=>part.type==='toolCall'&&part.id===tool.nativeToolCallId)?.arguments;
    return {id:String(tool.id),capabilities:toolCapabilities(tool.name),status:tool.status,
      originalValid:original===undefined?null:schemaValidity(tool.name,original,schemas),finalValid:schemaValidity(tool.name,tool.input,schemas)};
  });
  if(check.metricId!=='tool.recovery')return {actual:{complete:true,calls},evidenceRefs:refs};
  const values=record(context.gold.values)?context.gold.values:{},g=values[check.evidenceKey];
  if(!record(g))return gap('Independent recovery policy missing');
  const required=context.task.checks.filter(item=>item.required&&/^(query|diff|export)\./.test(item.metricId)&&item.scope?.ref===check.scope?.ref);
  const targets=await Promise.all(required.map(async item=>{
    const projection=await projectObservation(item,context);
    const status=projection?.constraint?.status??(projection?.actual===undefined?'UNJUDGEABLE':(await registry.get(item.metricId).evaluate(values[item.evidenceKey],projection.actual,item,context)).status);
    return {status,queryIds:(projection?.evidenceRefs??[]).flatMap(ref=>{const match=/^query:(\d+)(?::|$)/.exec(ref);return match?[Number(match[1])]:[];})};
  }));
  const statuses=targets.map(target=>target.status),targetQueryIds=[...new Set(targets.flatMap(target=>target.queryIds))];
  const targetVerified=required.length&&statuses.every(status=>status==='PASS')?true:statuses.some(status=>status==='FAIL')?false:null;
  const rawRuns=verifiedOriginals(facts,'runOriginals').map(item=>item.original);
  const failures=tools.filter(tool=>tool.status==='failed').map(failure=>{
    const delivered=toolDeliveryRequest(facts,failure);
    const following=tools.filter(tool=>tool.id>failure.id&&tool.runId===failure.runId).sort((a,b)=>a.id-b.id);
    const firstSuccess=following.findIndex(tool=>tool.status==='succeeded'&&list(g.allowedTools).includes(tool.name)),attempts=firstSuccess<0?following:following.slice(0,firstSuccess+1);
    const run=rawRuns.find(run=>run.id===failure.runId&&run.sessionId===failure.sessionId);
    const stopped=!!run&&['completed','failed','cancelled'].includes(run.status)&&run.cleanup?.stopConfirmed===true&&run.cleanup?.requiredPersistenceComplete===true;
    const failedQueries=Array.isArray(facts.queries)?facts.queries.filter(query=>query.callRef===`${failure.runId}:${failure.nativeToolCallId}`):null;
    const last=attempts.at(-1),recoveredQueryIds=list(facts.queries).filter(query=>last&&query.callRef===`${last.runId}:${last.nativeToolCallId}`).map(query=>query.id);
    // shortcut: Targets must belong to the final attempt; add verified multi-call ownership when such cases are authored.
    const ownTarget=targetVerified===false?false:targetVerified===true&&targetQueryIds.length>0&&targetQueryIds.every(id=>recoveredQueryIds.includes(id))?true:null;
    let causalFailure=failure;
    return {id:String(failure.id),code:failure.error?.code,delivered:!!delivered,
      attempts:attempts.map(attempt=>{const delivery=toolDeliveryRequest(facts,causalFailure),previous=causalFailure;if(attempt.status==='failed')causalFailure=attempt;
        return {id:String(attempt.id),name:attempt.name,freshIdentity:attempt.nativeToolCallId!==previous.nativeToolCallId&&attempt.modelCallId!==previous.modelCallId,
          justified:!!delivery&&(previous.error?.retryable===true||previous.error?.code===g.expectedFailureMode)&&attempt.modelCallId===delivery.callId&&(attempt.name!==previous.name||equal(attempt.input,previous.input)),succeeded:attempt.status==='succeeded'&&attempt.sdkDelivery?.isError===false};}),
      sideEffects:failedQueries===null?null:failedQueries.length,targetVerified:ownTarget,stopped};
  });
  return {actual:{complete:Array.isArray(facts.queries)&&(!record(facts.collectionCompleteness)||facts.collectionCompleteness.queries===true),failures},evidenceRefs:[...refs,...required.map(item=>'check:'+item.id)]};
}
