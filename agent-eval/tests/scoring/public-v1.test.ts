import {test,expect} from 'bun:test';
import {evaluate} from '../../src/scoring/evaluate.ts';
import {aggregate} from '../../src/scoring/aggregate.ts';
import {registry} from '../../src/scoring/registry.ts';
import type {CheckSpec} from '../../src/scoring/types.ts';
import {readJudgeConfig} from '../../src/scoring/judges/client.ts';

test('business success stays independent of process and safety while overall failure remains visible',async()=>{
  const checks:CheckSpec[]=['query.set_exact','efficiency.calls','security.scope','task.success'].map(metricId=>({id:metricId,metricId,version:'v1',kind:'deterministic',required:true,hardConstraint:metricId.startsWith('security.'),unit:'facts',goldKey:'values.'+metricId,evidenceKey:metricId}));
  // Dotted metric names are not paths; use explicit stable keys.
  checks.forEach((check,index)=>{check.goldKey='values.c'+index;check.evidenceKey='c'+index;});
  const scores=await evaluate({trialId:'t',caseId:'c',trialStatus:'completed',task:{checks},gold:{values:{c0:['A'],c1:{max:1},c2:{allowedIds:['A']},c3:{businessScorers:['query.set_exact']}}},observation:{identityChecks:[],missing:[],facts:{c0:['A'],c1:{calls:[{id:'1',kind:'read'},{id:'2',kind:'read'}]},c2:{coverageComplete:true,accessedIds:['B'],evidenceRefs:['q']}}}});
  expect(scores.map(score=>score.status)).toEqual(['PASS','FAIL','FAIL','PASS']);
  expect(aggregate([{trialId:'t',caseId:'c',repetition:1}],[{trialId:'t',caseId:'c',repetition:1,status:'completed'}],scores).totals.fail).toBe(1);
});

test('optional capabilities do not forbid a different valid path',async()=>{
  const check={id:'cap',metricId:'tool.selection',version:'v1',kind:'deterministic',required:true,hardConstraint:false,unit:'opportunities',goldKey:'',evidenceKey:''} as CheckSpec;
  const definition=registry.get('tool.selection');
  const expected={requiredCapabilities:['query'],optionalCapabilities:['read'],forbiddenCapabilities:['write']};
  const context={} as any;
  expect(await definition.evaluate(expected,{coverageComplete:true,capabilities:['query','grep','find']},check,context)).toMatchObject({status:'PASS'});
  expect(await definition.evaluate(expected,{coverageComplete:true,capabilities:['query','write']},check,context)).toMatchObject({status:'FAIL'});
});

test('no selected semantic sample needs no Judge credential or reservation',()=>{
  expect(readJudgeConfig({},'required',false)).toBeNull();
});

test('semantic Judge receives independent facts and business success includes the final answer',async()=>{
  const checks:CheckSpec[]=['answer.faithful','task.success'].map(metricId=>({id:metricId,metricId,version:'v1',kind:metricId==='answer.faithful'?'llm-judge':'deterministic',required:true,hardConstraint:false,unit:'opportunities',goldKey:'values.'+metricId.replace('.','_'),evidenceKey:metricId.replace('.','_')}));
  const at='2026-10-13T00:00:00Z';let recorded=false;
  const result=await evaluate({trialId:'t',caseId:'c',trialStatus:'completed',task:{checks},gold:{values:{answer_faithful:{rubric:'核对金额和缺失值',facts:{priceCents:0,missing:null}},task_success:{}}},observation:{identityChecks:[],missing:[],facts:{answer_faithful:{answer:'错误回答',evidenceRefs:['q'],evidence:{actualPrice:100}}}},onJudgeRequest:()=>{recorded=true;},judge:{judge:async request=>{expect(recorded).toBe(true);expect(request.checks[0]!.rubric).toContain('"priceCents":0');expect(request.checks[0]!.rubric).toContain('"missing":null');return {status:'completed',error:null,results:[{checkId:'answer.faithful',value:0,reason:'Mismatch',evidenceRefs:['q']}],metadata:{baseUrl:'http://127.0.0.1:1/',timeoutMs:30000,model:'controlled-stub',startedAt:at,endedAt:at,durationMs:0,temperature:.8,httpStatus:200,requestId:null,usage:{promptTokens:null,completionTokens:null}}};}}});
  expect(result.map(score=>score.status)).toEqual(['FAIL','FAIL']);
});
