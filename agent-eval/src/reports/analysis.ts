import type {EvaluationReport,ExecutionSnapshot,TrialPlan} from '../types.ts';
import type {AggregateTrial,EvaluationScore,MetricSummary,TrialJudgement} from '../scoring/types.ts';
import {aggregate} from '../scoring/aggregate.ts';
import {qualityMetricCatalog,type QualityMetricDefinition,type QualityMetricCatalogVersion} from '../scoring/registry.ts';

type CaseMetadata=EvaluationReport['cases'][number];
export interface AnalysisInput {
  plan:TrialPlan[];trials:(AggregateTrial&{reason?:string|null;stopped?:boolean|null;closed?:boolean|null})[];scores:EvaluationScore[];cases:CaseMetadata[];
  snapshot?:Pick<ExecutionSnapshot,'compiled'|'criteria'|'qualityMetricCatalog'|'qualityMetricCatalogVersion'>;
}
export interface NumericStatistics {count:number;mean:number|null;variance:number|null;standardDeviation:number|null;planned:number;coverage:number;gaps:string[]}
export interface CaseMetricAnalysis extends MetricSummary {
  checkId:string;name:string;direction:'higher'|'lower';scopeKind:string;evidenceRefs:string[];gaps:string[];numeric:NumericStatistics;
}
export interface CaseAnalysis {
  caseId:string;name:string;planned:number;started:number;completed:number;saved:number;
  pass:number;fail:number;unjudgeable:number;error:number;notRun:number;first:TrialJudgement;
  attempts:TrialJudgement[];confirmedPassRate:number;allPassed:boolean|null;successRate:number|null;
  passAtK:Record<string,number>|null;variance:number|null;standardDeviation:number|null;gaps:string[];metrics:CaseMetricAnalysis[];
}
export interface QualityMetricCoverage extends QualityMetricDefinition {
  coverage:'measured'|'partial'|'not_selected'|'outside_dataset'|'historical_not_configured'|'inapplicable'|'zero_denominator'|'unjudgeable'|'error'|'not_run';
  configuredCases:string[];selectedCases:string[];measuredTrials:number;summary:MetricSummary|null;gaps:string[];
}
export interface ReportAnalysis {
  contract:'medclaw-report-analysis/v1';cases:CaseAnalysis[];qualityMetrics:QualityMetricCoverage[];
  coverage:{formal:number;configured:number;selected:number;measured:number;complete:number};
  completeTask:{metricId:'task.end_to_end';planned:number;pass:number;confirmedPassRate:number|null;value:number|null};
  supplementaryMetrics:MetricSummary[];
  dataset:{cases:number;validCases:number;successRate:number|null;passAtK:Record<string,{value:number;validCases:number}>};
}
const finite=(value:number)=>Number.isFinite(value)?value:null;
function statistics(values:number[],planned:number):NumericStatistics {
  let mean=0,m2=0;
  values.forEach((value,index)=>{const delta=value-mean;mean+=delta/(index+1);m2+=delta*(value-mean);});
  const variance=values.length>1?finite(Math.max(0,m2/(values.length-1))):null;
  return {count:values.length,mean:values.length?finite(mean):null,variance,standardDeviation:variance===null?null:Math.sqrt(variance),planned,coverage:planned?values.length/planned:0,
    gaps:[...(values.length<planned?['incomplete_numeric_support']:[]),...(values.length&&(!Number.isFinite(mean)||!Number.isFinite(m2))?['numeric_range_exceeded']:[])]};
}
function passEstimates(total:number,correct:number):Record<string,number> {
  const result:Record<string,number>={};let none=1;
  for(let k=1;k<=total;k++){none=k>total-correct?0:none*(total-correct-k+1)/(total-k+1);result[k]=k===1?correct/total:Math.max(0,Math.min(1,1-none));}
  return result;
}
function blocked(trial:AnalysisInput['trials'][number]):boolean {
  return ['infra_error','not_run','cancelled','planned','preparing','running'].includes(trial.status)||
    /provider_request_failed|insufficient_balance|stop_unconfirmed|save_unconfirmed|host_|facility_|evidence_collection/.test(trial.reason??'')||
    Boolean(trial.startedAt&&(trial.stopped!==true||trial.closed!==true));
}
function archivedCriteria(input:AnalysisInput) {
  return Array.isArray(input.snapshot?.criteria)?input.snapshot.criteria as {id:string;dimension:string;direction:'higher'|'lower'}[]:undefined;
}
export function reportMetricCatalog(input:AnalysisInput):QualityMetricDefinition[] {
  if(input.snapshot?.qualityMetricCatalog)return input.snapshot.qualityMetricCatalog;
  return qualityMetricCatalog(input.snapshot?.qualityMetricCatalogVersion??'v1').map(row=>{
    const archived=(input.snapshot?.criteria as QualityMetricDefinition[]|undefined)?.find(criterion=>criterion.id===row.id);
    return archived?{...row,version:archived.version,formula:archived.formula,unit:archived.unit,direction:archived.direction}:row;
  });
}
export function assertQualityMetricCatalog(value:unknown,version:QualityMetricCatalogVersion='v1'):asserts value is QualityMetricDefinition[] {
  if(!['v1','v2'].includes(version))throw new Error('quality_metric_catalog_invalid');
  const ids=qualityMetricCatalog(version).map(row=>row.id);
  if(!Array.isArray(value)||value.length!==ids.length||new Set(value.map(row=>row?.id)).size!==ids.length||value.some(row=>!row||!ids.includes(row.id)||['name','version','formula','unit'].some(key=>typeof row[key]!=='string'||!row[key].trim())||!['higher','lower'].includes(row.direction)))throw new Error('quality_metric_catalog_invalid');
}
export function deriveCaseAnalysis(input:AnalysisInput,caseId:string):CaseAnalysis {
  const plan=input.plan.filter(item=>item.caseId===caseId),trials=input.trials.filter(item=>item.caseId===caseId),scores=input.scores.filter(score=>score.caseId===caseId);
  if(!plan.length)throw new Error('analysis_case_outside_plan');
  const definition=input.cases.find(item=>item.id===caseId);if(!definition)throw new Error('analysis_case_definition_missing');
  const criteria=archivedCriteria(input),summary=aggregate(plan,trials,scores,[definition],criteria);
  const attempts=[...summary.trials].sort((a,b)=>a.repetition-b.repetition);
  const counts=summary.totals,gaps=[...new Set([
    ...attempts.filter(item=>!['PASS','FAIL'].includes(item.status)).map(item=>item.trialId+':'+item.status),
    ...trials.filter(blocked).map(item=>item.trialId+':execution_or_evidence_blocked'),
    ...trials.filter(item=>Boolean(item.startedAt&&(item.stopped!==true||item.closed!==true))||/stop_unconfirmed|save_unconfirmed/.test(item.reason??'')).map(item=>item.trialId+':stop_or_save_unconfirmed'),
    ...scores.filter(score=>score.applicable&&(score.required||score.hardConstraint)&&!['PASS','FAIL'].includes(score.status)).map(score=>score.trialId+':'+score.checkId+':'+score.status),
  ])];
  const valid=trials.length===plan.length&&gaps.length===0,binary=statistics(attempts.map(item=>Number(item.status==='PASS')),plan.length);
  const catalog=reportMetricCatalog(input);
  const metricGroups=new Map<string,EvaluationScore[]>();
  for(const score of scores){const key=JSON.stringify([score.checkId,score.metricId,score.version,score.method,score.unit,score.scope.kind]);const group=metricGroups.get(key)??[];group.push(score);metricGroups.set(key,group);}
  const metrics=[...metricGroups.values()].map(group=>{
    const first=group[0]!,metric=aggregate(plan,trials,group,[definition],criteria).metrics[0]!;
    const duplicateScopes=new Set(group.map(score=>score.trialId)).size!==group.length;
    const blockedScores=group.filter(score=>{const trial=trials.find(trial=>trial.trialId===score.trialId);return !trial||blocked(trial);});
    const values=duplicateScopes?[]:group.filter(score=>!blockedScores.includes(score)&&score.applicable&&['PASS','FAIL'].includes(score.status)&&score.value!==null&&Number.isFinite(score.value)&&score.denominator!==0&&!score.missing.length).map(score=>score.value!);
    const metadata=catalog.find(row=>row.id===first.metricId),numeric=statistics(values,plan.length);
    const metricGaps=[...new Set([...group.flatMap(score=>[...score.missing,...(score.applicable&&!['PASS','FAIL'].includes(score.status)?[score.checkId+':'+score.status]:[])]),...blockedScores.map(score=>score.trialId+':execution_or_evidence_blocked')])];
    if(duplicateScopes){numeric.gaps.push('multiple_scopes_without_stable_opportunity_binding');metricGaps.push('multiple_scopes_without_stable_opportunity_binding');}
    return {...metric,checkId:first.checkId,name:metadata?.name??first.name,direction:metadata?.direction??criteria?.find(item=>item.id===first.metricId)?.direction??'higher' as const,
      scopeKind:first.scope.kind,evidenceRefs:[...new Set(group.flatMap(score=>score.evidenceRefs))],gaps:metricGaps,numeric};
  });
  return {caseId,name:definition.name,planned:plan.length,started:attempts.filter(item=>item.started).length,completed:attempts.filter(item=>item.completed).length,saved:trials.length,
    pass:counts.pass,fail:counts.fail,unjudgeable:counts.unjudgeable,error:counts.error,notRun:counts.notRun,first:attempts[0]!,attempts,confirmedPassRate:counts.pass/plan.length,
    allPassed:counts.pass===plan.length?true:counts.fail?false:null,successRate:valid?counts.pass/plan.length:null,passAtK:valid?passEstimates(plan.length,counts.pass):null,
    variance:valid?binary.variance:null,standardDeviation:valid?binary.standardDeviation:null,gaps,metrics};
}
export function deriveReportAnalysis(input:AnalysisInput):ReportAnalysis {
  const catalog=reportMetricCatalog(input);assertQualityMetricCatalog(catalog,input.snapshot?.qualityMetricCatalogVersion??'v1');
  const cases=[...new Set(input.plan.map(item=>item.caseId))].map(id=>deriveCaseAnalysis(input,id));
  const aggregation=aggregate(input.plan,input.trials,input.scores,input.cases,archivedCriteria(input));
  const declared=(id:string)=>input.snapshot?.compiled?Object.entries(input.snapshot.compiled).filter(([,item])=>item.checks.some(check=>check.metricId===id)).map(([caseId])=>caseId):[...new Set(input.scores.filter(score=>score.metricId===id).map(score=>score.caseId))];
  const qualityMetrics=catalog.map(metadata=>{
    const configuredCases=declared(metadata.id),selectedCases=configuredCases.filter(id=>input.plan.some(item=>item.caseId===id)),scores=input.scores.filter(score=>score.metricId===metadata.id),applicable=scores.filter(score=>score.applicable);
    const measuredTrials=new Set(applicable.filter(score=>['PASS','FAIL'].includes(score.status)&&score.value!==null).map(score=>score.trialId)).size,summary=aggregation.metrics.find(row=>row.metricId===metadata.id)??null;
    const coverage:QualityMetricCoverage['coverage']=!configuredCases.length?(input.snapshot?.qualityMetricCatalog?'outside_dataset':'historical_not_configured'):!selectedCases.length?'not_selected':!scores.length?'not_run':scores.every(score=>score.denominator===0)?'zero_denominator':!applicable.length?'inapplicable':
      measuredTrials?(applicable.every(score=>['PASS','FAIL'].includes(score.status)&&score.value!==null)?'measured':'partial'):applicable.some(score=>score.status==='ERROR')?'error':applicable.some(score=>score.status==='UNJUDGEABLE')?'unjudgeable':'not_run';
    const positiveDelegation=Object.values(input.snapshot?.compiled??{}).some(item=>item.checks.some(check=>{const expected=item.values[check.evidenceKey];return check.metricId==='subagent.delegation'&&typeof expected==='object'&&expected!==null&&'delegate' in expected&&expected.delegate===true;}));
    return {...metadata,coverage,configuredCases,selectedCases,measuredTrials,summary,gaps:[...new Set([...applicable.flatMap(score=>score.missing),...metadata.id==='subagent.delegation'&&configuredCases.length&&!positiveDelegation?['positive_autonomous_delegation_not_configured']:[]])]};
  });
  const valid=cases.filter(item=>item.successRate!==null),passAtK:ReportAnalysis['dataset']['passAtK']={};
  for(const key of new Set(valid.flatMap(item=>Object.keys(item.passAtK!)))){const eligible=valid.filter(item=>Object.hasOwn(item.passAtK!,key));passAtK[key]={value:eligible.reduce((sum,item)=>sum+item.passAtK![key]!,0)/eligible.length,validCases:eligible.length};}
  return {contract:'medclaw-report-analysis/v1',cases,qualityMetrics,coverage:{formal:catalog.length,configured:qualityMetrics.filter(row=>row.configuredCases.length).length,selected:qualityMetrics.filter(row=>row.selectedCases.length).length,measured:qualityMetrics.filter(row=>row.measuredTrials).length,complete:qualityMetrics.filter(row=>row.coverage==='measured').length},
    completeTask:{metricId:'task.end_to_end',planned:input.plan.length,pass:aggregation.totals.pass,confirmedPassRate:input.plan.length?aggregation.totals.pass/input.plan.length:null,value:cases.every(item=>item.successRate!==null)&&input.plan.length?aggregation.totals.pass/input.plan.length:null},
    supplementaryMetrics:aggregation.metrics.filter(row=>!catalog.some(metric=>metric.id===row.metricId)),dataset:{cases:cases.length,validCases:valid.length,successRate:valid.length?valid.reduce((sum,item)=>sum+item.successRate!,0)/valid.length:null,passAtK}};
}
