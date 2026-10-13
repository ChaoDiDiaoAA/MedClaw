import type { AggregateTrial, Aggregation, EvaluationScore, MetricSummary, PlannedTrial, ScoreStatus, TrialJudgement } from './types.ts';
import { requiredOutcome } from './evaluate.ts';
import { record } from './rules.ts';
import { scorerPolicy } from './registry.ts';

const ratio = (n: number, d: number) => d === 0 ? null : n / d;
const countStatuses = (statuses: ScoreStatus[]) => ({ pass: statuses.filter(x => x === 'PASS').length, fail: statuses.filter(x => x === 'FAIL').length,
  unjudgeable: statuses.filter(x => x === 'UNJUDGEABLE').length, error: statuses.filter(x => x === 'ERROR').length, notRun: statuses.filter(x => x === 'NOT_RUN').length });
const combined = (statuses: ScoreStatus[]): ScoreStatus => statuses.includes('FAIL') ? 'FAIL' : statuses.includes('ERROR') ? 'ERROR' : statuses.includes('UNJUDGEABLE') ? 'UNJUDGEABLE' : statuses.includes('NOT_RUN') ? 'NOT_RUN' : 'PASS';

export function aggregate(plan: PlannedTrial[], results: AggregateTrial[], scores: EvaluationScore[],definitions:{id:string;category:string;evalType:string}[]=[],criteria?:readonly {id:string;dimension:string}[]): Aggregation {
  if (new Set(plan.map(x => x.trialId)).size !== plan.length) throw new Error('Duplicate planned trial identity');
  if (new Set(results.map(x => x.trialId)).size !== results.length || results.some(x => !plan.some(p => p.trialId === x.trialId && p.caseId === x.caseId && p.repetition === x.repetition))) throw new Error('Trial results do not match immutable plan');
  if (scores.some(x => !plan.some(p => p.trialId === x.trialId && p.caseId === x.caseId))) throw new Error('Score is outside immutable plan');
  const scoreKeys = scores.map(x => JSON.stringify([x.trialId, x.metricId, x.version, x.method, x.checkId, x.scope]));
  if (new Set(scoreKeys).size !== scoreKeys.length) throw new Error('Duplicate score identity');
  const trials: TrialJudgement[] = plan.map(item => {
    const result = results.find(x => x.trialId === item.trialId), selected = scores.filter(x => x.trialId === item.trialId);
    const executionStatus = result?.status ?? 'not_run';
    let status = requiredOutcome(selected);
    if (executionStatus === 'failed') status = 'FAIL';
    else if (status !== 'FAIL' && executionStatus === 'infra_error') status = 'ERROR';
    else if (status !== 'FAIL' && ['not_run', 'planned', 'preparing', 'cancelled'].includes(executionStatus)) status = 'NOT_RUN';
    else if (status === 'PASS' && executionStatus !== 'completed') status = 'UNJUDGEABLE';
    return { ...item, status, executionStatus, started: !!result?.startedAt || ['running', 'completed', 'failed', 'cancelled'].includes(executionStatus), completed: executionStatus === 'completed', gaps: selected.filter(x => x.applicable && !['PASS', 'FAIL'].includes(x.status)).map(x => `${x.checkId}: ${x.status}: ${x.reason}`) };
  });
  const cases = [...new Set(plan.map(x => x.caseId))].map(caseId => {
    const members = trials.filter(x => x.caseId === caseId).sort((a, b) => a.repetition - b.repetition);
    return { caseId, planned: members.length, started: members.filter(x => x.started).length, completed: members.filter(x => x.completed).length,
      first: members[0]!, repeats: members.slice(1), allPass: members.every(x => x.status === 'PASS'), status: combined(members.map(x => x.status)) };
  });
  const keys = [...new Set(scores.map(x => JSON.stringify([x.metricId, x.version, x.method, x.unit])))];
  const metrics: MetricSummary[] = keys.map(key => {
    const selected = scores.filter(x => JSON.stringify([x.metricId, x.version, x.method, x.unit]) === key), first = selected[0]!;
    const plannedCases = new Set(selected.map(x => x.caseId));
    const missingTrials = plan.filter(x => plannedCases.has(x.caseId) && !selected.some(s => s.trialId === x.trialId));
    const applicable = selected.filter(x => x.applicable);
    const counts = countStatuses([...applicable.map(x => x.status), ...missingTrials.map(() => 'NOT_RUN' as const)]);
    const anyNumerator = applicable.some(x => x.numerator !== null), anyDenominator = applicable.some(x => x.denominator !== null);
    const numerator = anyNumerator ? applicable.reduce((n, x) => n + (x.numerator ?? 0), 0) : null;
    const denominator = anyDenominator ? applicable.reduce((n, x) => n + (x.denominator ?? 0), 0) : null;
    const incomplete = missingTrials.length > 0 || applicable.some(x => x.value === null && x.denominator !== 0);
    let value = numerator === null || denominator === null || applicable.some(x => x.numerator === null && x.denominator !== 0) ? null : ratio(numerator, denominator);
    let details: unknown = { complete: !incomplete, missingPlannedTrials: missingTrials.map(x => x.trialId) };
    if(first.metricId.startsWith('intent.')&&first.metricId!=='intent.macro_f1') {
      const channels=Object.fromEntries(['classify','verify','adopted'].map(channel=>{
        const observed=selected.flatMap(score=>record(score.details)&&Array.isArray(score.details.channels)?score.details.channels.filter((item:any)=>item.channel===channel):[]);
        const applicable=observed.filter(item=>item.applicable!==false),complete=applicable.every(item=>['PASS','FAIL'].includes(item.status)&&item.numerator!==null&&item.denominator!==null);
        const n=applicable.reduce((sum,item)=>sum+(item.numerator??0),0),d=applicable.reduce((sum,item)=>sum+(item.denominator??0),0);
        return [channel,{...countStatuses(applicable.map(item=>item.status)),notCalled:observed.length-applicable.length,numerator:complete?n:null,denominator:d,value:complete?ratio(n,d):null}];
      }));
      value=null;details={channels,missingPlannedTrials:missingTrials.map(x=>x.trialId)};
    }
    if (first.metricId === 'intent.macro_f1') {
      if(applicable.some(score=>record(score.details)&&Array.isArray(score.details.channels))) {
        const channels=Object.fromEntries(['classify','verify','adopted'].map(channel=>{
          const observed=applicable.flatMap(score=>record(score.details)&&Array.isArray(score.details.channels)?score.details.channels.filter((item:any)=>item.channel===channel):[]);
          const confusion=new Map<string,any>();
          for(const item of observed)for(const itemClass of item.details?.classes??[]) {
            const prior=confusion.get(itemClass.l2)??{l2:itemClass.l2,tp:0,fp:0,fn:0,support:0,predicted:0};
            for(const field of ['tp','fp','fn','support','predicted'])prior[field]+=itemClass[field];confusion.set(itemClass.l2,prior);
          }
          const classes=[...confusion.values()].map(item=>({...item,precision:ratio(item.tp,item.tp+item.fp),recall:ratio(item.tp,item.tp+item.fn),f1:ratio(2*item.tp,2*item.tp+item.fp+item.fn)})),supported=classes.filter(item=>item.f1!==null);
          return [channel,{...countStatuses(observed.filter(item=>item.applicable!==false).map(item=>item.status)),notCalled:observed.filter(item=>item.applicable===false).length,classes,
            macroF1:observed.some(item=>!['PASS','FAIL'].includes(item.status)&&item.applicable!==false)?null:ratio(supported.reduce((sum,item)=>sum+item.f1,0),supported.length+observed.flatMap(item=>item.details?.unknownLabels??[]).length),
            unknownLabels:observed.flatMap(item=>item.details?.unknownLabels??[]),zeroSupport:classes.filter(item=>!item.support).map(item=>item.l2)}];
        }));
        value=null;details={channels,reason:'Prediction and program adoption have separate class denominators; no blended macro average'};
      } else {
      const confusion = new Map<string, { label: string; tp: number; fp: number; fn: number }>();
      for (const s of applicable) if (record(s.details) && Array.isArray(s.details.classes)) for (const c of s.details.classes) {
        const existing = confusion.get(c.label) ?? { label: c.label, tp: 0, fp: 0, fn: 0 };
        existing.tp += c.tp; existing.fp += c.fp; existing.fn += c.fn; confusion.set(c.label, existing);
      }
      const classes = [...confusion.values()].map(c => ({ ...c, f1: ratio(2 * c.tp, 2 * c.tp + c.fp + c.fn) }));
      const supported = classes.filter(c => c.f1 !== null);
      value = incomplete ? null : ratio(supported.reduce((sum, c) => sum + c.f1!, 0), supported.length);
      details = { classes };
      }
    }
    return { metricId: first.metricId, version: first.version, method: first.method, unit: first.unit, planned: selected.length + missingTrials.length,
      applicable: applicable.length + missingTrials.length, ...counts, inapplicable: selected.length - applicable.length, numerator, denominator, value,
      judgeablePassRate: ratio(counts.pass, counts.pass + counts.fail), judgeableCoverage: ratio(counts.pass + counts.fail, applicable.length + missingTrials.length), trialIds: plan.filter(x => plannedCases.has(x.caseId)).map(x => x.trialId), ...(details ? { details } : {}) };
  });
  const modules=Object.fromEntries(['task','tool','skill','resource','context','memory','compaction','subagent','intent','security','export'].map(module=>{
    const selected=scores.filter(score=>definitions.length?definitions.some(item=>item.id===score.caseId&&item.category===module):score.metricId.startsWith(module+'.')),applicable=selected.filter(score=>score.applicable);
    return [module,{declaredCases:[...new Set(selected.map(score=>score.caseId))].sort(),checks:selected.length,applicable:applicable.length,judgeable:applicable.filter(score=>['PASS','FAIL'].includes(score.status)).length,...countStatuses(applicable.map(score=>score.status))}];
  }));
  const dimensionOf=(id:string)=>{if(criteria){const criterion=criteria.find(item=>item.id===id);if(!criterion)throw new Error('archived_metric_criterion_missing:'+id);return criterion.dimension;}try{return scorerPolicy(id).dimension;}catch{return undefined;}};
  const dimensions=Object.fromEntries(['result','process','safety','infrastructure'].map(dimension=>[dimension,metrics.filter(metric=>dimensionOf(metric.metricId)===dimension)]));
  const evalTypes=Object.fromEntries(['capability','regression'].map(type=>[type,countStatuses(trials.filter(trial=>definitions.some(item=>item.id===trial.caseId&&item.evalType===type)).map(trial=>trial.status))]));
  return { trials, cases, metrics,modules,dimensions,evalTypes,business:metrics.filter(metric=>/^(query|diff|answer)\./.test(metric.metricId)),runtimeGates:metrics.filter(metric=>/^(facility|host)\./.test(metric.metricId)), totals: { planned: plan.length, ...countStatuses(trials.map(x => x.status)) } };
}
