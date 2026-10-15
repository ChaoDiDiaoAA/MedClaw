import { safeError } from '../../../contracts/src/error';
import { QueryParamsSchema, type QueryRecord } from '../../../contracts/src/query';
import { canonicalRequest } from '../../../contracts/src/run';
import type { IntentQueryPlan, IntentStepResult, ProductTurnResult } from '../../../contracts/src/intent';

/** A submitted Query is the only authority for business values. */
export function renderQueryAnswer(plan: IntentQueryPlan, queries: QueryRecord[], metadataFacts: IntentStepResult[]): ProductTurnResult {
  const lines: string[] = [], ids: number[] = [];
  const scalar = (query: QueryRecord): number | null => {
    const params = QueryParamsSchema.parse(query.params);
    if (query.kind === 'current' || query.kind === 'changes') return query.interpretation?.quantity ?? query.rows.length;
    if (!query.rows.length) return params.metric === 'mean_price' ? null : 0;
    if (query.rows.some(row => typeof row.value !== 'number' || row.gap === true)) return null;
    if (['count','changed_device_count'].includes(params.metric ?? '') && query.rows.length > 1) return null;
    if (['sum_price','mean_price'].includes(params.metric ?? '') && new Set(query.rows.map(row => canonicalRequest([row.currency,row.priceUnit]))).size !== 1) return null;
    if (params.metric === 'mean_price') {
      const count = query.rows.reduce((sum,row)=>sum+Number(row.validCount ?? 0),0);
      return count ? query.rows.reduce((sum,row)=>sum+Number(row.value)*Number(row.validCount ?? 0),0)/count : null;
    }
    return query.rows.reduce((sum,row)=>sum+Number(row.value),0);
  };
  for (const step of plan.steps) {
    lines.push(`Step ${step.stepId}`);
    if (step.metadata) {
      const fact=metadataFacts.find(value=>value.stepId===step.stepId)?.metadata;
      if (!fact || fact.basis!==step.metadata.basis) throw safeError('answer_evidence_invalid');
      lines.push(`Snapshot freshness (not capture time): ${canonicalRequest(fact.batches.map(batch=>({batchId:batch.id,date:batch.snapshotDate,region:batch.region})))}`);
      continue;
    }
    const parts=step.queries.map((params,part)=>{
      const suffix=`:${step.stepId}:${part}`, query=queries.find(value=>value.callRef.endsWith(suffix));
      if(!query || canonicalRequest(query.params)!==canonicalRequest(params) || ids.includes(query.id))throw safeError('answer_evidence_invalid');
      ids.push(query.id);lines.push(`Part ${part}: Query #${query.id}`, `Frozen conditions: ${canonicalRequest(params)}`,
        `Interpretation: ${canonicalRequest(query.interpretation ?? null)}`,
        `Complete result rows: ${query.rows.length}. Preview: first ${Math.min(20,query.rows.length)} rows.`,canonicalRequest(query.rows.slice(0,20)),
        `Warnings: ${canonicalRequest(query.warnings)}`);
      const amount=['sum_price','mean_price'].includes(params.metric ?? '');
      if(amount)lines.push('Amounts are CNY cents; currency and priceUnit are recorded on each row. Zero and null are distinct. Means use validCount weights.');
      const value=scalar(query);
      lines.push(`Value: ${value===null?'unknown / incomplete':value}${amount?' CNY cents':''}`);
      return {query,value,params};
    });
    if(parts.length===2) {
      const [a,b]=parts as [typeof parts[number],typeof parts[number]];
      const money=['sum_price','mean_price'].includes(a.params.metric ?? '');
      const units=(q:QueryRecord)=>[...new Set(q.rows.map(row=>canonicalRequest([row.currency,row.priceUnit])))].sort();
      const compatible=a.params.metric===b.params.metric && a.params.population===b.params.population && a.params.snapshotMode===b.params.snapshotMode
        && (!money || canonicalRequest(units(a.query))===canonicalRequest(units(b.query))&&units(a.query).length===1);
      lines.push(`Difference (part 1 - part 0): ${compatible && a.value!==null && b.value!==null?b.value-a.value:'unknown / incompatible or incomplete'}${money?' CNY cents':''}`,
        'For comparison, equal counts do not establish equal device sets.');
    }
  }
  if(ids.length!==queries.length)throw safeError('answer_evidence_invalid');
  lines.push('Causes are unknown without supporting evidence. Values describe the recorded data; synthetic data do not establish real-world facts.');
  return {kind:'result',text:lines.join('\n'),queryIds:ids,missingSlots:[]};
}
