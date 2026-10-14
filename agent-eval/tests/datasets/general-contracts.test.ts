import {test,expect} from 'bun:test';
import {loadDataset,loadSnapshot,snapshotCompiled} from '../../src/datasets.ts';
import {ScorerExpectationsSchema} from '../../src/evaluation.ts';

test('new authored tool and time contracts reject ambiguous or invalid thresholds',()=>{
  expect(ScorerExpectationsSchema.safeParse({'tool.precision':{allowedCapabilities:['query_current_devices']},'evidence.freshness':{mode:'business_date',maxLagDays:0},'efficiency.latency_budget':{maxMs:1000}}).success).toBe(true);
  for(const expectation of [
    {'tool.precision':{allowedCapabilities:['invented_tool']}},
    {'tool.error_rate':{maxRate:1.1}},
    {'tool.recovery':{maxRetries:-1,allowedTools:['query_current_devices'],allowStop:true}},
    {'evidence.freshness':{mode:'business_date',maxLagDays:-1}},
    {'evidence.freshness':{mode:'age',asOf:'yesterday',maxAgeMs:1000}},
    {'efficiency.latency_budget':{maxMs:0}},
  ])expect(ScorerExpectationsSchema.safeParse(expectation).success).toBe(false);
});

test('primary dataset compiles independent tool allowlists, time scope and diagnostic error rate',async()=>{
  const dataset=await loadDataset(),id='mc-v1-tool-read-only',item=dataset.cases.find(item=>item.id===id)!;
  expect(dataset.gold[id]!.values.tool_recall).toEqual({requiredCapabilities:['query_current_devices']});
  expect((dataset.gold[id]!.values.tool_precision as {allowedCapabilities:string[]}).allowedCapabilities).toContain('query_current_devices');
  expect((dataset.gold[id]!.values.tool_precision as {allowedCapabilities:string[]}).allowedCapabilities).not.toContain('write');
  expect(dataset.gold[id]!.values.evidence_freshness).toEqual({mode:'business_date',date:'2026-10-02',maxLagDays:0});
  expect(item.expected.checks.find(check=>check.metricId==='tool.error_rate')).toMatchObject({required:false});
  expect(dataset.gold['mc-v1-tool-retry-transient']!.values.answer_partial_failure).toMatchObject({expectedFailureMode:'tool_timeout',requireDisclosure:true});
});

test('compiler keeps authored latency and error budgets explicit and freshness independent of Gold observations',async()=>{
  const snapshot=structuredClone((await loadDataset()).snapshot);snapshot.review.state='pending';
  const id='mc-v1-tool-read-only',item=snapshot.cases.find(item=>item.id===id)!;
  item.scorers.push('efficiency.latency_budget');
  snapshot.gold[id]!.scorerExpectations!['efficiency.latency_budget']={maxMs:2500};
  snapshot.gold[id]!.scorerExpectations!['tool.error_rate']={maxRate:.25};
  (item.expected.expectedFacts as {facts:{interpretation:{actualDataDate:string}}}).facts.interpretation.actualDataDate='2030-01-01';
  const compiled=loadSnapshot(snapshot);
  expect(compiled.gold[id]!.values.efficiency_latency_budget).toEqual({maxMs:2500});
  expect(compiled.gold[id]!.values.evidence_freshness).toEqual({mode:'business_date',date:'2026-10-02',maxLagDays:0});
  expect(compiled.cases.find(item=>item.id===id)!.expected.checks.find(check=>check.metricId==='tool.error_rate')).toMatchObject({required:true,threshold:.25});
});

test('compiler rejects contradictory tool permissions and controlled failure contracts',async()=>{
  const original=(await loadDataset()).snapshot;
  const permission=structuredClone(original);permission.review.state='pending';
  permission.gold['mc-v1-tool-read-only']!.scorerExpectations!['tool.precision']!.allowedCapabilities.push('write');
  expect(()=>loadSnapshot(permission)).toThrow('scorer_capability_forbidden');
  const failure=structuredClone(original);failure.review.state='pending';
  failure.gold['mc-v1-tool-retry-transient']!.scorerExpectations!['tool.recovery']!.expectedFailureMode='resource_unavailable';
  expect(()=>loadSnapshot(failure)).toThrow('controlled_failure_expectation_mismatch');
});

test('independent verifier rejects forged compiled tool and time expectations',async()=>{
  const dataset=await loadDataset();
  const program=`import copy,importlib.util,json,sys
spec=importlib.util.spec_from_file_location('verifier',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
data=json.load(sys.stdin);module.verify_compiled(data['snapshot'],data['compiled'])
id='mc-v1-tool-read-only'
for mutate in [
 lambda c:c[id]['values']['tool_precision']['allowedCapabilities'].append('write'),
 lambda c:c[id]['values']['evidence_freshness'].__setitem__('date','2030-01-01'),
 lambda c:next(x for x in c[id]['checks'] if x['metricId']=='tool.error_rate').__setitem__('required',True),
]:
 changed=copy.deepcopy(data['compiled']);mutate(changed)
 try:module.verify_compiled(data['snapshot'],changed)
 except ValueError:continue
 raise RuntimeError('forged compiled expectation accepted')
print('rejected')`;
  const process=Bun.spawn(['python','-O','-c',program,import.meta.dir+'/../../scripts/verify-stage-one.py'],{stdin:new Blob([JSON.stringify({snapshot:dataset.snapshot,compiled:snapshotCompiled(dataset)})]),stdout:'pipe',stderr:'pipe'});
  expect(await new Response(process.stderr).text()).toBe('');
  expect((await new Response(process.stdout).text()).trim()).toBe('rejected');
  expect(await process.exited).toBe(0);
});
