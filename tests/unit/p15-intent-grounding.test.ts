import { expect, test } from 'bun:test';
import { IntentInputProjectionSchema } from '../../packages/contracts/src/intent';
import { INTENT_VERSIONS } from '../../packages/contracts/src/model';
import { renderIntentContext } from '../../packages/contracts/src/context';
import { groundIntentInput, readExplicitConstraints } from '../../packages/core/src/intent/explicit-constraints';
import { intentInput, intentCatalogData } from '../fixtures/p14-intent';

test('p15 grounding preserves source, negation, clear, date anchor and authorized same-name candidates',()=>{
  const raw=IntentInputProjectionSchema.parse({...intentInput(),versions:{...intentInput().versions,...INTENT_VERSIONS},
    text:'😀昨天甲医疗器械的均价趋势，非在售；不限状态',pendingClarification:{taskText:'浙江2026-10-09在售器械',missingSlots:['time']}});
  const rows=intentCatalogData().snapshots.filter(row=>row.batchId===1);
  const input=groundIntentInput(raw,[...rows,{...rows[0]!,deviceId:99}]);
  expect(input.grounding?.facts).toContainEqual(expect.objectContaining({kind:'date',source:'current_input',quote:'昨天',start:2,end:4,time:{start:'2026-10-09',endExclusive:'2026-10-10'}}));
  expect(input.grounding?.facts).toContainEqual(expect.objectContaining({kind:'status',operation:'exclude',value:'active',quote:'非在售'}));
  expect(input.grounding?.facts).toContainEqual(expect.objectContaining({kind:'status',operation:'clear',value:null,quote:'不限状态'}));
  expect(input.grounding?.facts).toContainEqual(expect.objectContaining({kind:'metric',value:'mean_price',quote:'均价'}));
  expect(input.grounding?.facts).toContainEqual(expect.objectContaining({kind:'entity',field:'device',quote:'甲医疗器械',deviceIds:[1,99]}));
  expect(input.grounding?.facts.some(f=>f.source==='pending_task')).toBe(true);
  expect(input).toMatchObject({text:raw.text,previousQueryContext:null});
  expect(JSON.stringify(input.grounding)).not.toMatch(/"(?:l0|l1|l2|queryParams|intents)"/);
  const invalid=structuredClone(input);invalid.grounding!.facts[0]!.start++;
  expect(IntentInputProjectionSchema.safeParse(invalid).success).toBe(false);
  const rendered=renderIntentContext({input,stage:'classify',review:null});
  expect(JSON.parse(rendered.slice(rendered.indexOf('\n')+1)).input.grounding).toEqual(input.grounding);
});

test('p15 end-day exclusion belongs to the date range rather than an unrelated filter',()=>{
  const date=(text:string)=>readExplicitConstraints(text,'2026-10-11').find(f=>f.kind==='date');
  expect(date('浙江2026-10-09至2026-10-10价格总额趋势，不包含没有价格的记录')).toMatchObject({time:{start:'2026-10-09',endExclusive:'2026-10-11'}});
  expect(date('2026-10-09至2026-10-10（不含结束日）价格总额趋势')).toMatchObject({time:{start:'2026-10-09',endExclusive:'2026-10-10'}});
  expect(date('2026-10-09至2026-10-10，不包括2026-10-10的价格总额趋势')).toMatchObject({time:{start:'2026-10-09',endExclusive:'2026-10-10'}});
});

test('p15 grounding keeps conflicts and resolves ranges without selecting an intent; legacy rendering is unchanged',()=>{
  const old=IntentInputProjectionSchema.parse(intentInput()),legacy=renderIntentContext({input:old,stage:'classify',review:null});
  expect(groundIntentInput(old,[])).toEqual(old);expect('grounding' in old).toBe(false);
  expect(legacy).not.toContain('Frozen IntentStageInput:');
  const input=groundIntentInput(IntentInputProjectionSchema.parse({...old,versions:{...old.versions,...INTENT_VERSIONS},text:'2026-01-01至2026-01-03在售或下架的价格总额'}),[]);
  expect(input.grounding!.facts.filter(f=>f.kind==='status')).toHaveLength(2);
  expect(input.grounding!.facts).toContainEqual(expect.objectContaining({kind:'date',quote:'2026-01-01至2026-01-03',time:{start:'2026-01-01',endExclusive:'2026-01-04'}}));
});
