import {test,expect} from 'bun:test';
import {loadDataset} from '../../src/datasets.ts';
import {qualityMetricCatalog} from '../../src/scoring/registry.ts';
import {evaluate} from '../../src/scoring/evaluate.ts';
import type {EvaluationContext,CheckSpec,JudgeRequest} from '../../src/scoring/types.ts';

test('primary data connects the original formal metrics and declares the independently unauthored latency gap',async()=>{
  const dataset=await loadDataset('medclaw-agent-v1'),ids=new Set(dataset.cases.flatMap(item=>item.expected.checks.map(check=>check.metricId)));
  expect(dataset.cases).toHaveLength(50);expect(dataset.manifest.smoke).toHaveLength(10);
  for(const item of qualityMetricCatalog('v1'))expect(ids.has(item.id),item.id).toBe(true);
  for(const item of qualityMetricCatalog()) {
    if(item.id==='efficiency.latency_budget')expect(dataset.snapshot.review.coverageGaps[item.id]).toContain('No independently authored');
    else expect(ids.has(item.id),item.id).toBe(true);
  }
  expect(dataset.cases.filter(item=>item.expected.checks.some(check=>check.metricId==='answer.faithful'))).toHaveLength(4);
});

test('semantic opportunity counts and lower-is-better completion claims are not replaced by Trial fractions',async()=>{
  const ids=['evidence.coverage','evidence.valid','task.false_completion'];
  const checks:CheckSpec[]=ids.map(id=>({id,metricId:id,version:'v1',kind:'llm-judge',unit:'opportunities',required:true,hardConstraint:false,threshold:id==='task.false_completion'?0:1,direction:id==='task.false_completion'?'lower':'higher',goldKey:'values.'+id.replaceAll('.','_'),evidenceKey:id.replaceAll('.','_')}));
  let calls=0,seen:JudgeRequest|undefined;
  const at='2026-10-14T00:00:00.000Z';
  const context:EvaluationContext={trialId:'t',caseId:'c',trialStatus:'completed',task:{checks},gold:{values:Object.fromEntries(ids.map(id=>[id.replaceAll('.','_'),{rubric:'Check only actual evidence',counted:{unit:id==='task.false_completion'?'completion-claim':'assertion'}}]))},observation:{identityChecks:[],missing:[],facts:Object.fromEntries(ids.map(id=>[id.replaceAll('.','_'),{answer:'A factual answer',evidenceRefs:['source'],evidence:{source:'Independent facts'}}]))},judge:{judge:async request=>{
    calls++;seen=request;
    return {status:'completed',error:null,results:request.checks.map(check=>({checkId:check.checkId,value:check.checkId==='evidence.coverage'?2/3:check.checkId==='task.false_completion'?0:1,numerator:check.checkId==='evidence.coverage'?2:check.checkId==='task.false_completion'?0:3,denominator:3,reason:'Controlled semantic count',evidenceRefs:['source']})),metadata:{baseUrl:'http://127.0.0.1/',timeoutMs:30000,model:'controlled',startedAt:at,endedAt:at,durationMs:0,temperature:.8,httpStatus:200,requestId:null,usage:{promptTokens:null,completionTokens:null}}};
  }}};
  context.task.checks.push({id:'task',metricId:'task.success',version:'v1',kind:'deterministic',unit:'trial',required:true,hardConstraint:false,goldKey:'values.task',evidenceKey:'task'});
  (context.gold.values as Record<string,unknown>).task={};
  const scores=await evaluate(context);
  expect(calls).toBe(1);expect(seen?.checks.every(check=>!!check.counted)).toBe(true);
  expect(scores[0]).toMatchObject({status:'FAIL',numerator:2,denominator:3,value:2/3});
  expect(scores[1]).toMatchObject({status:'PASS',numerator:3,denominator:3,value:1});
  expect(scores[2]).toMatchObject({status:'PASS',numerator:0,denominator:3,value:0});
  expect(scores[3]).toMatchObject({status:'FAIL'});
});
