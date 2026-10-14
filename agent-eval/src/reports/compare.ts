import { isDeepStrictEqual } from 'node:util';
import type { EvaluationReport } from '../types.ts';
import {reportMetricCatalog} from './analysis.ts';

export function compareReports(baseline:EvaluationReport,candidate:EvaluationReport) {
  const factors=candidate.config.comparison?.factors??[];
  if(candidate.config.comparison&&candidate.config.comparison.baselineExecutionId!==baseline.executionId)throw new Error('comparison_incompatible_baseline');
  const conditions=(report:EvaluationReport)=>{
    const config=structuredClone(report.config);delete config.comparison;
    if(config.model.definition) {
      const definition=config.model.definition as unknown as Record<string,unknown>;
      if(factors.includes('model.model')){delete definition.models;delete definition.name;delete definition.api;}
      else if(factors.includes('model.maxTokens'))for(const model of config.model.definition.models)delete (model as unknown as Record<string,unknown>).maxTokens;
    }
    for(const path of factors) {if(path==='source')continue;const [group,key]=path.split('.');if(key)delete (config[group as keyof typeof config] as Record<string,unknown>)[key];else delete (config as Record<string,unknown>)[group!];}
    const catalogVersion=report.snapshot.qualityMetricCatalogVersion??'v1';
    return {dataset:report.snapshot.dataset,compiled:report.snapshot.compiled,criteria:report.snapshot.criteria,qualityMetricCatalogVersion:catalogVersion,qualityMetricCatalog:reportMetricCatalog(report),source:factors.includes('source')?null:report.snapshot.source,plan:report.plan.map(({caseId,repetition})=>({caseId,repetition})),config};
  };
  if(!isDeepStrictEqual(conditions(baseline),conditions(candidate)))throw new Error('comparison_incompatible_recorded_conditions');
  return {baseline:baseline.executionId,candidate:candidate.executionId,matchedTrials:baseline.plan.length,declaredFactors:factors,first:{baseline:baseline.trials.filter(t=>t.repetition===1),candidate:candidate.trials.filter(t=>t.repetition===1)},repeated:{baseline:baseline.aggregation,candidate:candidate.aggregation},totals:{baseline:baseline.totals,candidate:candidate.totals}};
}
