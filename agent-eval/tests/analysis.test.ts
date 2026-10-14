import {expect,test} from 'bun:test';
import {planTrials} from '../src/execution/runner.ts';
import {reportFixture} from './report-fixture.ts';
import type {EvaluationScore} from '../src/scoring/types.ts';

async function analyzer(){
  const module=await import('../src/reports/analysis.ts').catch(()=>null);
  expect(module,'The shared pure report analyzer must exist').not.toBeNull();
  return module!;
}
test('hard constraints with incomplete evidence invalidate repeated estimates even when not required',async()=>{
  const {deriveReportAnalysis}=await analyzer(),report=input([1,0,1]);
  report.scores.push({...report.scores[1]!,checkId:'hard',required:false,hardConstraint:true,status:'UNJUDGEABLE',value:null});
  expect(deriveReportAnalysis(report).cases[0]!.passAtK).toBeNull();
});
test('legacy formulas and zero opportunities remain explicit',async()=>{
  const {deriveReportAnalysis}=await analyzer(),report=input([1]),snapshot=reportFixture().snapshot;
  snapshot.criteria=[{id:'query.numeric',version:'v1',formula:'Archived numeric contract',unit:'archived-unit',direction:'lower',dimension:'result'}];
  delete snapshot.qualityMetricCatalog;
  expect(deriveReportAnalysis({...report,snapshot}).qualityMetrics.find(row=>row.id==='query.numeric')!).toMatchObject({formula:'Archived numeric contract',unit:'archived-unit',direction:'lower'});
  Object.assign(report.scores[0]!,{denominator:0,numerator:0,value:null,applicable:false});
  expect(deriveReportAnalysis(report).qualityMetrics.find(row=>row.id==='query.numeric')!.coverage).toBe('zero_denominator');
});
function input(values:number[],reason:string|null=null){
  const base=reportFixture(),plan=planTrials([base.cases[0]!.id],values.length);
  const trials=plan.map(item=>({...base.trials[0]!,...item,status:'completed' as const,startedAt:base.createdAt,endedAt:base.createdAt,reason,stopped:true,closed:true}));
  const scores:EvaluationScore[]=plan.map((item,index)=>({...base.scores[0]!,trialId:item.trialId,caseId:item.caseId,checkId:'numeric',metricId:'query.numeric',name:'数值正确率',scope:{kind:'run',ref:'native-run-'+index},status:values[index]===0?'FAIL':'PASS',value:values[index]!,numerator:values[index]!,denominator:1,reason:'controlled observation',missing:[],actual:null,expected:null}));
  return {plan,trials,scores,cases:base.cases};
}
test('repeated statistics use each Case planned identities and the HumanEval estimator',async()=>{
  const {deriveReportAnalysis}=await analyzer(),report=input([1,0,1]),analysis=deriveReportAnalysis(report),group=analysis.cases[0]!;
  expect(analysis.contract).toBe('medclaw-report-analysis/v1');
  expect(group.planned).toBe(3);expect(group.pass).toBe(2);expect(group.fail).toBe(1);expect(group.allPassed).toBe(false);
  expect(group.confirmedPassRate).toBeCloseTo(2/3);expect(group.successRate).toBeCloseTo(2/3);
  expect(group.passAtK).toEqual({'1':2/3,'2':1,'3':1});
  expect(group.variance).toBeCloseTo(1/3);expect(group.first.trialId).toBe(report.plan[0]!.trialId);
  expect(group.metrics).toHaveLength(1);expect(group.metrics[0]!.numeric.count).toBe(3);
  expect(analysis.qualityMetrics).toHaveLength(39);expect(new Set(analysis.qualityMetrics.map(row=>row.id)).size).toBe(39);
  expect(analysis.qualityMetrics.some(row=>row.id==='task.end_to_end')).toBe(false);
});
test('sample variance keeps units and native run IDs do not split the same check',async()=>{
  const {deriveReportAnalysis}=await analyzer(),analysis=deriveReportAnalysis(input([10,20,30])),row=analysis.cases[0]!.metrics[0]!;
  expect(row.numeric).toMatchObject({count:3,mean:20,variance:100,standardDeviation:10});
  const singleton=deriveReportAnalysis(input([1])).cases[0]!;
  expect(singleton.variance).toBeNull();expect(singleton.metrics[0]!.numeric.variance).toBeNull();
});
test('Provider and incomplete evidence cannot produce success randomness estimates even with a FAIL score',async()=>{
  const {deriveReportAnalysis}=await analyzer();
  for(const kind of ['provider','unknown','not_run']){
    const report=input([1,0,1]);
    if(kind==='provider')report.trials[1]!.reason='provider_request_failed';
    if(kind==='unknown'){report.scores[1]!.status='UNJUDGEABLE';report.scores[1]!.value=null;report.scores[1]!.missing=['query result'];}
    if(kind==='not_run')Object.assign(report.trials[1]!,{status:'not_run',startedAt:null,reason:'execution_cancelled_before_start'});
    const group=deriveReportAnalysis(report).cases[0]!;
    expect(group.successRate).toBeNull();expect(group.passAtK).toBeNull();expect(group.variance).toBeNull();expect(group.gaps.length).toBeGreaterThan(0);
    expect(group.planned).toBe(3);
  }
});

test('blocked observations stay in raw formulas but not numeric repeat variance',async()=>{
  const {deriveReportAnalysis}=await analyzer(),report=input([1,0,1]);
  Object.assign(report.trials[1]!,{reason:'provider_request_failed',closed:false});
  const group=deriveReportAnalysis(report).cases[0]!,metric=group.metrics[0]!;
  expect(group.passAtK).toBeNull();expect(metric).toMatchObject({numerator:2,denominator:3,value:2/3});
  expect(metric.numeric).toMatchObject({count:2,mean:1,variance:0,coverage:2/3,planned:3});
  expect(metric.numeric.gaps).toContain('incomplete_numeric_support');
  expect(metric.gaps.some(gap=>gap.includes(report.trials[1]!.trialId))).toBe(true);
});
test('Case metrics never contain another Case checks and missing observations stay unknown',async()=>{
  const {deriveReportAnalysis}=await analyzer(),a=input([1]),b=input([1]);
  b.plan[0]={caseId:'another',repetition:1,trialId:'another-r1'};
  Object.assign(b.trials[0]!,b.plan[0]);Object.assign(b.scores[0]!,{...b.plan[0],metricId:'tool.params',checkId:'params'});
  const analysis=deriveReportAnalysis({plan:[...a.plan,...b.plan],trials:[...a.trials,...b.trials],scores:[...a.scores,...b.scores],cases:[...a.cases,{...a.cases[0]!,id:'another'}]});
  expect(analysis.cases[0]!.metrics.map(row=>row.metricId)).toEqual(['query.numeric']);
  expect(analysis.cases[1]!.metrics.map(row=>row.metricId)).toEqual(['tool.params']);
  const unresolved=input([1]);unresolved.scores[0]!.status='UNJUDGEABLE';unresolved.scores[0]!.value=null;
  expect(deriveReportAnalysis(unresolved).cases[0]!.allPassed).toBeNull();
});
