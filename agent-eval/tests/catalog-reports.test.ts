import {expect,test} from 'bun:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {qualityMetricCatalog} from '../src/scoring/registry.ts';
import {assertQualityMetricCatalog,deriveReportAnalysis} from '../src/reports/analysis.ts';
import {readReport} from '../src/reports/write.ts';
import {compareReports} from '../src/reports/compare.ts';
import {mapReport} from '../src/langfuse/map.ts';
import {terminalProgress,terminalReport} from '../src/terminal.ts';
import {reportFixture,saveReportFixture} from './report-fixture.ts';

test('catalog identity is checked against the declared version, including same-size substitutions',()=>{
  const v1=qualityMetricCatalog('v1'),v2=qualityMetricCatalog('v2');
  expect(()=>assertQualityMetricCatalog(v1,'v1')).not.toThrow();
  expect(()=>assertQualityMetricCatalog(v2,'v2')).not.toThrow();
  expect(()=>assertQualityMetricCatalog(v1,'v2')).toThrow('quality_metric_catalog_invalid');
  expect(()=>assertQualityMetricCatalog(v2,'v1')).toThrow('quality_metric_catalog_invalid');
  const replaced=structuredClone(v1);replaced[0]={...replaced[0]!,id:'efficiency.calls'};
  expect(()=>assertQualityMetricCatalog(replaced,'v1')).toThrow('quality_metric_catalog_invalid');
  const malformed=structuredClone(v2);malformed[0]!.direction='sideways' as 'higher';
  expect(()=>assertQualityMetricCatalog(malformed,'v2')).toThrow('quality_metric_catalog_invalid');
});

test('comparison rejects catalog changes and normalizes an unversioned historical catalog',()=>{
  const baseline=reportFixture(),candidate=reportFixture();candidate.executionId='catalog-candidate';
  candidate.snapshot.qualityMetricCatalogVersion='v1';candidate.snapshot.qualityMetricCatalog=qualityMetricCatalog('v1');
  expect(compareReports(baseline,candidate).matchedTrials).toBe(1);
  candidate.snapshot.qualityMetricCatalog[0]!.formula='Changed recorded formula';
  expect(()=>compareReports(baseline,candidate)).toThrow('comparison_incompatible_recorded_conditions');
  candidate.snapshot.qualityMetricCatalogVersion='v2';candidate.snapshot.qualityMetricCatalog=qualityMetricCatalog('v2');
  expect(()=>compareReports(baseline,candidate)).toThrow('comparison_incompatible_recorded_conditions');
});

test('comparison fallback uses archived formulas when only one old report froze a catalog',()=>{
  const baseline=reportFixture(),candidate=reportFixture(),metricId='query.numeric';
  for(const report of [baseline,candidate]){
    const criteria=report.snapshot.criteria as {id:string;formula:string;unit:string;direction:'higher'|'lower'}[];
    Object.assign(criteria.find(row=>row.id===metricId)!,{formula:'Historical formula',unit:'archived-unit',direction:'lower'});
  }
  candidate.snapshot.qualityMetricCatalog=qualityMetricCatalog('v1');
  Object.assign(candidate.snapshot.qualityMetricCatalog.find(row=>row.id===metricId)!,{formula:'Historical formula',unit:'archived-unit',direction:'lower'});
  expect(compareReports(baseline,candidate).matchedTrials).toBe(1);
});

test('analysis preserves historical 39-item catalogs and uses the recorded v2 fallback',()=>{
  const legacy=reportFixture();
  expect(deriveReportAnalysis(legacy).coverage.formal).toBe(39);
  expect(deriveReportAnalysis(legacy).qualityMetrics.find(row=>row.id==='tool.recall')).toBeUndefined();
  expect(deriveReportAnalysis(legacy).qualityMetrics.find(row=>row.id==='compaction.fact_retention')!.coverage).toBe('historical_not_configured');
  legacy.snapshot.qualityMetricCatalog=qualityMetricCatalog('v1');
  legacy.snapshot.qualityMetricCatalog[0]!.name='Archived display label';
  const frozen=deriveReportAnalysis(legacy);
  expect(frozen.coverage.formal).toBe(39);expect(frozen.qualityMetrics[0]!.name).toBe('Archived display label');
  legacy.snapshot.qualityMetricCatalogVersion='v2';delete legacy.snapshot.qualityMetricCatalog;
  const current=deriveReportAnalysis(legacy);
  expect(current.coverage.formal).toBe(50);
  expect(current.qualityMetrics.find(row=>row.id==='tool.recall')!.coverage).toBe('historical_not_configured');
});

test('archive reads retain the frozen catalog and reject a mismatched or unknown version',async()=>{
  for(const version of ['v1','v2'] as const){
    const root=await mkdtemp(join(tmpdir(),'mc-catalog-')),report=reportFixture();
    report.snapshot.qualityMetricCatalog=qualityMetricCatalog(version);
    if(version==='v2')report.snapshot.qualityMetricCatalogVersion=version;
    try{
      await saveReportFixture(root,report);
      const loaded=await readReport(root);
      expect(loaded.analysis!.coverage.formal).toBe(version==='v1'?39:50);
      expect(loaded.snapshot.qualityMetricCatalog).toEqual(report.snapshot.qualityMetricCatalog);
      const snapshotPath=join(root,'snapshot.json'),snapshot=JSON.parse(await readFile(snapshotPath,'utf8'));
      snapshot.qualityMetricCatalogVersion=version==='v1'?'v2':'v1';await writeFile(snapshotPath,JSON.stringify(snapshot));
      await expect(readReport(root)).rejects.toThrow('quality_metric_catalog_invalid');
      snapshot.qualityMetricCatalogVersion='v3';await writeFile(snapshotPath,JSON.stringify(snapshot));
      await expect(readReport(root)).rejects.toThrow('quality_metric_catalog_invalid');
    }finally{await rm(root,{recursive:true,force:true});}
  }
});

test('terminal and platform mapping preserve new metric units and do not invent Judge generations',()=>{
  const report=reportFixture(),trial=report.trials[0]!;
  trial.status='completed';trial.startedAt=report.createdAt;trial.endedAt=report.createdAt;trial.stopped=true;trial.closed=true;
  report.snapshot.qualityMetricCatalogVersion='v2';report.snapshot.qualityMetricCatalog=qualityMetricCatalog('v2');
  const observations=[
    {metricId:'tool.error_rate',value:.25,numerator:1,denominator:4,unit:'opportunities',method:'deterministic' as const},
    {metricId:'efficiency.calls',value:7,numerator:7,denominator:1,unit:'tool calls',method:'deterministic' as const},
    {metricId:'answer.partial_failure',value:1,numerator:1,denominator:1,unit:'opportunities',method:'llm-judge' as const},
  ];
  report.scores=observations.map(item=>({...report.scores[0]!,...item,checkId:item.metricId,applicable:true,status:'PASS' as const,missing:[],reason:'Controlled mapping fixture'}));
  const lines:string[]=[],render=terminalProgress(line=>lines.push(line));
  render({caseId:trial.caseId,trialId:trial.trialId,repetition:1,index:1,total:1,kind:'score',phase:'score',elapsedMs:1,status:'PASS',checks:report.scores});
  for(const metric of observations)expect(lines.some(line=>line.includes(metric.metricId)&&line.includes(metric.unit))).toBe(true);
  const envelope=mapReport(report),scores=envelope.events.filter(event=>event.kind==='score');
  expect(scores.map(event=>[event.payload.name,event.payload.value,(event.payload.metadata as any).unit])).toEqual([
    ['tool.error_rate',.25,'opportunities'],['efficiency.calls',7,'tool calls'],['answer.partial_failure',1,'opportunities'],
  ]);
  const spans=envelope.events.filter(event=>event.kind==='span').map(event=>(event.payload.resourceSpans as any)[0].scopeSpans[0].spans[0]);
  expect(spans.some(span=>span.name.startsWith('judge/'))).toBe(false);
  expect(spans.some(span=>span.attributes.some((attribute:any)=>attribute.key==='langfuse.observation.type'&&attribute.value.stringValue==='generation'))).toBe(false);
  report.scores=[];report.snapshot.criteria=[];
  terminalReport(report,'report.json',line=>lines.push(line));
  expect(lines.some(line=>line.includes('0/50'))).toBe(true);
});
