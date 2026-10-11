import { expect, test } from 'bun:test';
import { IntentInputProjectionSchema, IntentResultSchema, IntentDecisionSchema } from '../../packages/contracts/src/intent';
import { INTENT_VERSIONS } from '../../packages/contracts/src/model';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { IntentValidator } from '../../packages/core/src/intent/validate';
import { decideIntentRoute } from '../../packages/core/src/intent/route-policy';
import { intentInput, intentCatalogData, emptyIntentSlots } from '../fixtures/p14-intent';
import { renderQueryAnswer } from '../../packages/core/src/intent/render-query-answer';
import { openDatabase } from '../../packages/storage/src/database';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { queryProductParams } from '../fixtures/p15-query-product';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('p15 resolved comparison freezes both dates in a deterministic plan, with no Agent route', () => {
  const data = intentCatalogData();
  const input = IntentInputProjectionSchema.parse({ ...intentInput(), versions: { ...intentInput().versions, ...INTENT_VERSIONS },
    text: '比较浙江2026-10-09和2026-10-10的快照记录总数，不限状态',
    scope: { ...intentInput().scope, batchIds: [2, 3], allowedToolNames: ['query_current_devices', 'query_device_changes', 'read_query', 'list_query_evidence'] }, scopeBatchHashes: data.batches.slice(1).map(b => b.contentHash),
    enabledL2: ['PERIOD_COMPARE'], availableToolNames: ['query_current_devices', 'query_device_changes', 'read_query', 'list_query_evidence'],
    availableData: { regions: ['浙江'], dates: ['2026-10-09', '2026-10-10'], currencies: ['CNY'], units: ['件'] } });
  const periods = [{ start: '2026-10-09', endExclusive: '2026-10-10' }, { start: '2026-10-10', endExclusive: '2026-10-11' }];
  const result = IntentResultSchema.parse({ contract: 'medclaw.intent/v2', status: 'RESOLVED',
    intents: [{ id: 's1', l0: 'STATISTICAL_ANALYSIS', l1: 'COMPARATIVE_ANALYSIS', l2: 'PERIOD_COMPARE',
      slots: { ...emptyIntentSlots(), region: '浙江', metric: 'count' }, parameters: { periods }, dependsOn: [], resultRef: null }], candidateIntents: [], clarification: null });
  const checked = new IntentValidator(new CatalogService(data)).validateQueryParams(result,
    { runId: 3, sessionId: 1, inputId: 2, scope: input.scope, source: 'intent', callRef: 'test', referenceDate: input.referenceDate,
      timezone: input.timezone, signal: new AbortController().signal }, input, '2026-10-11T01:00:00.000Z');
  expect(checked.state).toBe('valid'); expect(checked.finalStatus).toBe('RESOLVED');
  const decision = decideIntentRoute(result, checked, input, { stage: 'classify', callId: 'actual-model-call' });
  expect(decision.route).toBe('simple'); expect(decision.queryParams).toBeNull();
  const plan = decision.executionPlan!;
  expect(plan.steps).toHaveLength(1); expect(plan.steps[0]!.queries.map(q => q.time)).toEqual(periods);
  expect(plan.steps[0]!.queries.every(q => q.snapshotMode === 'exact_date' && JSON.stringify(q.batchIds) === '[2,3]')).toBe(true);
  expect(IntentDecisionSchema.safeParse({ ...decision, executionPlan: { ...plan, steps: [] } }).success).toBe(false);
  const legacy = decideIntentRoute(result, checked, { ...input, versions: { ...input.versions, policyVersion: 'medclaw.intent-policy/v3' } }, { stage: 'classify', callId: 'legacy-call' });
  expect(legacy.route).toBe('agent'); expect('executionPlan' in legacy).toBe(false);
});

test('p15 fact rendering weights means, preserves unknown and zero, and rejects mismatched plan results',()=>{
  const root=mkdtempSync(join(tmpdir(),'medclaw-p15-render-')),db=openDatabase(join(root,'app.sqlite'));
  try{
    const base=seedWorkspaceQueries(db).current,params=queryProductParams({kind:'trend',metric:'mean_price',groupBy:'date',snapshotMode:'exact_date',time:{start:'2026-01-01',endExclusive:'2026-01-03'}});
    const row={currency:'CNY',priceUnit:'件',gap:false};
    const query={...base,kind:'trend' as const,params,callRef:'intent:10:1:s1:0',rows:[{...row,value:100,validCount:1},{...row,value:200,validCount:3}]};
    const plan={contract:'medclaw.intent-query-plan/v1' as const,steps:[{stepId:'s1',dependsOn:[],queries:[params],metadata:null}]};
    expect(renderQueryAnswer(plan,[query],[]).text).toContain('Value: 175 CNY cents');
    expect(renderQueryAnswer(plan,[{...query,rows:[{...row,value:0,validCount:1}]}],[]).text).toContain('Value: 0 CNY cents');
    for(const rows of [[{...row,value:null,validCount:0}],[{...row,value:0,gap:true,validCount:1}],
      [{...row,value:100,validCount:1},{...row,priceUnit:'盒',value:200,validCount:1}]])expect(renderQueryAnswer(plan,[{...query,rows}],[]).text).toContain('Value: unknown / incomplete');
    expect(()=>renderQueryAnswer(plan,[{...query,params:{...params,sort:'desc'}}],[])).toThrow();
    expect(()=>renderQueryAnswer(plan,[query,{...query,id:999}],[])).toThrow();
    for(const metric of ['count','changed_device_count'] as const){
      const distinctParams={...params,metric,population:metric==='changed_device_count'?'changes' as const:'snapshot' as const,snapshotMode:metric==='changed_device_count'?null:params.snapshotMode},distinctPlan={...plan,steps:[{...plan.steps[0]!,queries:[distinctParams,distinctParams]}]};
      const a={...query,params:distinctParams,rows:[{date:'2026-01-01',value:1},{date:'2026-01-02',value:1}]};
      const b={...a,id:999,callRef:'intent:10:1:s1:1',rows:[]};
      const text=renderQueryAnswer(distinctPlan,[a,b],[]).text;
      expect(text).toContain('Value: unknown / incomplete');expect(text).not.toContain('Difference (part 1 - part 0): -2');
    }
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
