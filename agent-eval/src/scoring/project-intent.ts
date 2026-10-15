import { IntentReadResultSchema,IntentResultSchema,RuleEvaluationSchema,IntentDecisionSchema } from '../../../packages/contracts/src/intent.ts';
import {z} from 'zod';
import { equal,record } from './rules.ts';
import { projectObservation,type ObservationProjection } from './project-observation.ts';
import type { CheckSpec,EvaluationContext } from './types.ts';
import { canonicalRequest } from '../../../packages/contracts/src/run.ts';

const PublicRule=z.strictObject(RuleEvaluationSchema.shape);
const PublicDecision=z.strictObject(IntentDecisionSchema.shape).extend({ruleEvaluation:PublicRule.nullable(),id:z.number().int().positive(),createdAt:z.iso.datetime()});
const PublicIntent=z.object({protocolValidated:z.literal(true),contract:IntentReadResultSchema.shape.contract,runId:z.number().int().positive(),sessionId:z.number().int().positive(),inputId:z.number().int().positive(),decision:PublicDecision.nullable(),calls:z.array(z.object({callId:z.string(),intentCallId:z.string(),stage:z.enum(['classify','verify']),previousCallId:z.string().nullable(),state:z.enum(['started','completed','failed','cancelled']),prediction:IntentResultSchema.nullable(),rawOutput:z.object({text:z.string(),truncated:z.boolean()}).nullable(),validation:z.object({reviewRequired:z.boolean()}).nullable()})).max(2),execution:z.object({queryIds:z.array(z.number().int().positive()),requiredPersistenceComplete:z.boolean().nullable()})}).refine(value=>value.calls.every((call,index)=>call.callId===call.intentCallId&&(index===0?call.stage==='classify'&&call.previousCallId===null:call.stage==='verify'&&call.previousCallId===value.calls[0]!.callId))&&(!value.decision?.intentCallId||value.calls.some(call=>call.callId===value.decision!.intentCallId)));

export async function projectIntent(check:CheckSpec,context:EvaluationContext):Promise<ObservationProjection> {
  const facts=context.observation!.facts,aliases=record(facts.aliases)?facts.aliases:{};
  const alias=check.scope?.ref,binding=Array.isArray(aliases.runs)?aliases.runs.filter((item:any)=>item.alias===alias):[];
  if(binding.length!==1)return {evidenceRefs:[],reason:'Intent stage has no unique controller Run binding'};
  const runId=binding[0].runId,items=(Array.isArray(facts.intents)?facts.intents:[]).filter((item:any)=>item.runId===runId);
  if(items.length!==1)return {evidenceRefs:[],reason:'Required intent.read record is missing or duplicated'};
  const parsed=items[0]?.protocolValidated===true?PublicIntent.safeParse(items[0]):IntentReadResultSchema.safeParse(items[0]);if(!parsed.success)return {evidenceRefs:[],reason:'Original intent record fails its owner/stage contract'};
  const original=parsed.data,ref=`intent:${runId}`,channels:any[]=original.calls.map(call=>{
    let prediction;try{prediction=IntentResultSchema.parse(JSON.parse(call.rawOutput?.text??''));}catch{}
    return {channel:call.stage,callId:call.callId,raw:call.rawOutput?.text,truncated:call.rawOutput?.truncated??false,missing:call.state!=='completed'||call.rawOutput===null,prediction,recordMismatch:prediction!==undefined&&!equal(prediction,call.prediction),evidenceRef:`${ref}:call:${call.callId}`};
  });
  if(!original.calls.length)channels.push({channel:'classify',notRun:original.decision?.decisionSource==='deterministic_rule',missing:original.decision?.decisionSource!=='deterministic_rule',evidenceRef:ref});
  if(original.calls[0]?.validation?.reviewRequired&&!original.calls.some(call=>call.stage==='verify'))channels.push({channel:'verify',missing:true,evidenceRef:ref});
  const decision=original.decision;
  const publicExpected=(context.gold.values as Record<string,any>)?.[check.evidenceKey];
  if(publicExpected?.program?.queryKind) {
    if(!decision)return {evidenceRefs:[ref],reason:'Adopted intent decision missing'};
    const conditions=await projectObservation({...check,metricId:'query.conditions'},context);
    const queries=(Array.isArray(facts.queries)?facts.queries:[]).filter((query:any)=>query.runId===runId);
    const planned=decision.executionPlan?.steps.flatMap(step=>step.queries)??(decision.queryParams?[decision.queryParams]:[]);
    return {actual:{status:decision.status,route:decision.route,conditions:conditions?.actual,queryKinds:queries.map((query:any)=>query.kind),planVerified:queries.length>0&&equal([...original.execution.queryIds].sort(),queries.map((query:any)=>query.id).sort())&&equal(planned.map(canonicalRequest).sort(),queries.map((query:any)=>canonicalRequest(query.params)).sort())&&channels.every(channel=>!channel.missing&&!channel.truncated&&!channel.recordMismatch)},evidenceRefs:[ref,...conditions?.evidenceRefs??[]]};
  }
  if(!decision)channels.push({channel:'adopted',missing:true,evidenceRef:ref});
  else {
    const expected=(context.gold.values as Record<string,any>)?.[check.evidenceKey];
    const conditions=await projectObservation({...check,metricId:'query.conditions'},context);
    const queries=Array.isArray(facts.queries)?facts.queries.filter((query:any)=>query.runId===runId):[];
    const planned=decision.executionPlan?.steps.flatMap(step=>step.queries)??(decision.queryParams?[decision.queryParams]:[]);
    const contracts=expected?.program?.queryContracts;
    const contractVerified=Array.isArray(contracts)&&contracts.length===queries.length&&equal(contracts.map(canonicalRequest).sort(),queries.map((query:any)=>canonicalRequest(Object.fromEntries(Object.keys(contracts[0]??{}).map(key=>[key,query.params[key]])))).sort());
    const planVerified=contractVerified&&conditions?.actual!==undefined&&equal(conditions.actual,expected?.program?.conditions)&&equal(planned.map(canonicalRequest).sort(),queries.map((query:any)=>canonicalRequest(query.params)).sort());
    channels.push({channel:'adopted',callId:decision.intentCallId,route:decision.route,queryIds:original.execution.queryIds,planVerified,evidenceRef:`${ref}:decision:${decision.id}`,
      prediction:{status:decision.status,intents:decision.adoptedIntents,candidateIntents:original.calls.find(call=>call.callId===decision.intentCallId)?.prediction?.candidateIntents??[],
        clarification:original.calls.find(call=>call.callId===decision.intentCallId)?.prediction?.clarification??null,missingSlots:decision.missingSlots}});
  }
  return {actual:{runId,channels},evidenceRefs:[ref]};
}
