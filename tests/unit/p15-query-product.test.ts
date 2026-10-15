import { expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { discoverTests, runStage } from '../run';
import { queryProductData, queryProductParams } from '../fixtures/p15-query-product';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { openDatabase } from '../../packages/storage/src/database';
import { SqliteExportStore } from '../../packages/storage/src/export-store';
import { ArtifactStore } from '../../packages/storage/src/artifact-store';
import { canonicalRequest } from '../../packages/contracts/src/run';
import { readCsvRecords } from '../../packages/core/src/data/import-service';
import { IntentValidator } from '../../packages/core/src/intent/validate';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { compileIntentQuery } from '../../packages/core/src/intent/route-policy';
import { IntentInputProjectionSchema, IntentItemSchema, IntentResultSchema, IntentStageInputSchema, QueryContextRecordSchema, INTENT_TAXONOMY, type IntentInputProjection } from '../../packages/contracts/src/intent';
import { intentInput, intentCatalogData, resolvedIntent } from '../fixtures/p14-intent';
import { INTENT_CAPABILITIES } from '../../packages/core/src/intent/taxonomy';
import { pinDirectory } from '../../packages/storage/src/publish-no-replace';
import { INTENT_VERSIONS } from '../../packages/contracts/src/model';

test('p15 date grammar preserves ASCII calendar validation without unsupported shorthand in inference schemas', async () => {
  const { ReferenceDateSchema } = await import('../../packages/contracts/src/model');
  const { intentJsonSchema } = await import('../../packages/contracts/src/intent');
  const { businessToolSchemas } = await import('../../packages/contracts/src/business-tools');
  const schemas = [ReferenceDateSchema.toJSONSchema({ target: 'draft-7' }), intentJsonSchema,
    ...['query_current_devices', 'query_device_changes', 'check_data_coverage', 'list_batches'].map(name =>
      businessToolSchemas[name as keyof typeof businessToolSchemas].input.toJSONSchema({ target: 'draft-7' }))];
  for (const schema of schemas) {
    expect(JSON.stringify(schema)).not.toContain('\\d');
    expect(JSON.stringify(schema)).toContain('[0-9]{4}-[0-9]{2}-[0-9]{2}');
  }
  for (const value of ['2000-02-29', '2024-02-29', '2026-01-01', '9999-12-31']) expect(ReferenceDateSchema.safeParse(value).success).toBe(true);
  for (const value of ['1900-02-29', '2025-02-29', '2026-04-31', '2026-13-01', '２０２６-０１-０１', '2026-01-01T00:00:00Z', '2026-1-01']) {
    expect(ReferenceDateSchema.safeParse(value).success).toBe(false);
  }
});

test('p15 directory pin cancellation waits for the helper to close before confirming no outstanding filesystem work', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() { return true; } });
  const spawn = spyOn(childProcess, 'spawn').mockImplementation((() => child) as unknown as typeof childProcess.spawn);
  const controller = new AbortController(); let outcome = 'pending';
  try {
    const pending = pinDirectory('C:/engineering/selected', controller.signal).then(() => { outcome = 'ready'; }, () => { outcome = 'failed'; });
    controller.abort(); child.stdout.write('READY\n'); await Bun.sleep(0);
    expect(outcome).toBe('pending');
    child.emit('close', 0); await pending;
    expect(outcome).toBe('failed'); expect(child.stdin.writableEnded).toBe(true);
  } finally { child.emit('close', 0); spawn.mockRestore(); }
});

function conditionValidation() {
  const data = intentCatalogData(), tools = ['query_current_devices', 'query_device_changes', 'resolve_device', 'read_device', 'read_source_metadata', 'list_filter_values', 'read_batch', 'read_query', 'list_query_evidence'];
  const input = IntentInputProjectionSchema.parse({ ...intentInput(), text: '继续当前条件',
    scope: { ...intentInput().scope, batchIds: [1, 2, 3], allowedToolNames: tools },
    availableToolNames: tools, enabledL2: Object.entries(INTENT_CAPABILITIES).filter(([, cap]) => cap.state === 'conditional').map(([key]) => key),
    availableData: { regions: ['浙江'], dates: data.batches.map(batch => batch.snapshotDate), currencies: ['CNY'], units: ['件'] },
    previousQueryContext: { contract: 'medclaw.query-form-context/v1', sessionId: 1, nativeLeafId: 'leaf', version: 1,
      sourceRunId: 1, sourceInputId: 1, decisionId: 1, params: queryProductParams({ batchIds: [1, 2, 3], time: { start: '2026-10-10', endExclusive: '2026-10-11' } }),
      queryIds: [1], pendingClarification: null } });
  const validator = new IntentValidator(new CatalogService(data));
  const check = (prediction: unknown = resolvedIntent(), projection: IntentInputProjection = input, mode: 'exact_date' | 'as_of' = 'exact_date') => validator.validateQueryParams(IntentResultSchema.parse(prediction),
    { sessionId: input.sessionId, runId: input.runId, inputId: input.inputId, scope: input.scope, source: 'intent', callRef: 'guard', referenceDate: input.referenceDate, timezone: input.timezone, signal: new AbortController().signal }, projection, '2026-10-11T01:00:00.000Z', mode);
  return { input, check, validator };
}

test('p15 a complete prediction that drops an explicit status gets one semantic review without rewriting it', () => {
  const f = conditionValidation(), input = { ...f.input, versions: { ...f.input.versions, ...INTENT_VERSIONS }, text: '列出浙江2026-10-10在售的医疗器械' };
  const prediction = IntentResultSchema.parse(resolvedIntent()), raw = JSON.stringify(prediction);
  const context = { sessionId: input.sessionId, runId: input.runId, inputId: input.inputId, scope: input.scope, source: 'intent' as const,
    callRef: 'guard', referenceDate: input.referenceDate, timezone: input.timezone, signal: new AbortController().signal };
  const first = f.validator.checkPrediction(raw, context, { input, stage: 'classify', review: null }, '2026-10-11T01:00:00.000Z');
  expect(first.prediction).toEqual(prediction);
  expect(first.validation).toMatchObject({ state: 'invalid', adoptedIntents: [], reviewRequired: true });
  expect(first.validation.issues[0]).toMatchObject({ sourceSpan: { start: 14, end: 16 } });
  expect(first.candidates).toEqual([]);
  const review = { mode: 'semantic_correction' as const, previousCallId: 'first', prediction, rawPreview: raw,
    issues: first.validation.issues, candidates: [] };
  const stage = IntentStageInputSchema.parse({ input, stage: 'verify', review });
  const corrected = { ...prediction, intents: prediction.intents.map(item => ({ ...item, slots: { ...item.slots, status: 'active',
    time: { start: '2026-10-10', endExclusive: '2026-10-11' } } })) };
  expect(f.validator.checkPrediction(JSON.stringify(corrected), context, stage, '2026-10-11T01:00:01.000Z').validation)
    .toMatchObject({ state: 'valid', finalStatus: 'RESOLVED', reviewRequired: false });
  expect(f.validator.checkPrediction(raw, context, stage, '2026-10-11T01:00:01.000Z').validation)
    .toMatchObject({ state: 'invalid', adoptedIntents: [], reviewRequired: false });
});

test('p15 explicit two-date comparisons and price metrics are checked against the original request', () => {
  const f = conditionValidation(), base = IntentResultSchema.parse(resolvedIntent());
  const compare = IntentItemSchema.parse({ ...base.intents[0], l0: INTENT_TAXONOMY.PERIOD_COMPARE.l0, l1: INTENT_TAXONOMY.PERIOD_COMPARE.l1, l2: 'PERIOD_COMPARE',
    slots: { ...base.intents[0]!.slots, metric: 'count' }, parameters: { periods: [
      { start: '2026-10-08', endExclusive: '2026-10-09' }, { start: '2026-10-10', endExclusive: '2026-10-11' }] } });
  const input = { ...f.input, text: '比较浙江2026-10-08和2026-10-10两天的快照记录总数，不限状态' };
  if (compare.l2 !== 'PERIOD_COMPARE') throw new Error('expected comparison');
  expect(f.check({ ...base, intents: [compare] }, input)).toMatchObject({ state: 'valid', finalStatus: 'RESOLVED' });
  expect(f.check({ ...base, intents: [{ ...compare, parameters: { periods: [compare.parameters.periods[0], compare.parameters.periods[0]] } }] }, input))
    .toMatchObject({ state: 'invalid', issues: expect.arrayContaining([expect.objectContaining({ code: 'explicit_condition_conflict', slot: 'periods' })]) });
  const trend = IntentItemSchema.parse({ ...base.intents[0], l0: INTENT_TAXONOMY.PRICE_TREND.l0, l1: INTENT_TAXONOMY.PRICE_TREND.l1, l2: 'PRICE_TREND',
    slots: { ...base.intents[0]!.slots, time: { start: '2026-10-08', endExclusive: '2026-10-11' }, metric: 'mean_price', groupBy: 'date' } });
  expect(f.check({ ...base, intents: [trend] }, { ...f.input, text: '浙江2026-10-08至2026-10-10的价格总额趋势' }))
    .toMatchObject({ state: 'invalid', issues: expect.arrayContaining([expect.objectContaining({ code: 'explicit_condition_conflict', slot: 'metric' })]) });
});

test('p15 correction excludes truncated, malformed, missing-parameter and scope-invalid predictions and reads legacy reviews', () => {
  const f = conditionValidation(), input = { ...f.input, text: '列出浙江2026-10-10在售的医疗器械', versions: { ...f.input.versions, ...INTENT_VERSIONS } };
  const context = { sessionId: input.sessionId, runId: input.runId, inputId: input.inputId, scope: input.scope, source: 'intent' as const,
    callRef: 'guard', referenceDate: input.referenceDate, timezone: input.timezone, signal: new AbortController().signal };
  const check = (raw: string, projection: IntentInputProjection = input, truncated = false) => f.validator.checkPrediction(raw, context,
    { input: projection, stage: 'classify', review: null }, '2026-10-11T01:00:00.000Z', truncated);
  const prediction = IntentResultSchema.parse(resolvedIntent()), raw = JSON.stringify(prediction);
  expect(check(raw, input, true).validation.reviewRequired).toBe(false);
  expect(check('not JSON').validation.reviewRequired).toBe(false);
  expect(check(JSON.stringify({ ...prediction, intents: [{ ...prediction.intents[0], slots: { ...prediction.intents[0]!.slots, region: '未授权区域' } }] })).validation.reviewRequired).toBe(false);
  const missing = IntentResultSchema.parse({ ...prediction, intents: [{ ...prediction.intents[0], l0: INTENT_TAXONOMY.NEW_RECORDS.l0,
    l1: INTENT_TAXONOMY.NEW_RECORDS.l1, l2: 'NEW_RECORDS', slots: { ...prediction.intents[0]!.slots, changeKind: 'added' } }] });
  expect(check(JSON.stringify(missing), { ...input, text: '列出浙江新增的器械记录' }).validation).toMatchObject({ finalStatus: 'NEED_PARAMETERS', reviewRequired: false });
  expect(check(raw, { ...input, versions: f.input.versions }).validation.reviewRequired).toBe(false);
  const legacy = { input: { ...input, versions: f.input.versions }, stage: 'verify', review: { previousCallId: 'first', prediction,
    rawPreview: raw, issues: [], candidates: [{ reasonCode: 'schema_recovery', intents: prediction.intents }] } };
  expect(IntentStageInputSchema.safeParse(legacy).success).toBe(true);
  expect(IntentStageInputSchema.safeParse({ ...legacy, review: { ...legacy.review, mode: 'semantic_correction', candidates: [] } }).success).toBe(false);
});

test('p15 a negated status is never silently treated as all statuses or allowed to hide a positive correction', () => {
  const f = conditionValidation(), prediction = IntentResultSchema.parse(resolvedIntent());
  expect(f.check(prediction, { ...f.input, text: '列出浙江2026-10-10非在售的器械' }))
    .toMatchObject({ finalStatus: 'UNSUPPORTED_DATA', reviewRequired: false, issues: expect.arrayContaining([expect.objectContaining({ slot: 'status', code: 'unsupported_capability' })]) });
  const wrong = { ...prediction, intents: [{ ...prediction.intents[0], slots: { ...prediction.intents[0]!.slots, status: 'active' } }] };
  expect(f.check(wrong, { ...f.input, text: '列出浙江2026-10-10的器械，不是在售，只看暂停的' }))
    .toMatchObject({ state: 'invalid', issues: expect.arrayContaining([expect.objectContaining({ slot: 'status', code: 'explicit_condition_conflict' })]) });
});

test('p15 conflicting statuses, invalid dates and result-dependent queries cannot become a guessed frozen plan',()=>{
  const f=conditionValidation(),base=IntentResultSchema.parse(resolvedIntent());
  const input={...f.input,versions:{...f.input.versions,...INTENT_VERSIONS},text:'列出浙江2026-10-10在售或下架的器械'};
  const prediction={...base,intents:[{...base.intents[0],slots:{...base.intents[0]!.slots,status:'active'}}]};
  expect(f.check(prediction,input)).toMatchObject({finalStatus:'UNSUPPORTED_DATA'});
  expect(f.check(base,{...input,text:'列出浙江2026-02-30的器械'})).toMatchObject({state:'invalid'});
  expect(f.check({...base,intents:[{...base.intents[0],resultRef:{queryId:999}}]},{...input,text:'查询这些器械的记录'})).toMatchObject({finalStatus:'UNSUPPORTED_DATA'});
});

test('p15 a multi-metric request requires model-predicted coverage of every explicit metric',()=>{
  const f=conditionValidation(),base=IntentResultSchema.parse(resolvedIntent());
  const input={...f.input,previousQueryContext:null,versions:{...f.input.versions,...INTENT_VERSIONS},text:'查询浙江2026-10-09至2026-10-10的均价和价格总额趋势'};
  const item=IntentItemSchema.parse({...base.intents[0],l0:INTENT_TAXONOMY.PRICE_TREND.l0,l1:INTENT_TAXONOMY.PRICE_TREND.l1,l2:'PRICE_TREND',
    slots:{...base.intents[0]!.slots,time:{start:'2026-10-09',endExclusive:'2026-10-11'},metric:'mean_price',groupBy:'date'}});
  expect(f.check({...base,intents:[item]},input)).toMatchObject({state:'invalid'});
  expect(f.check({...base,intents:[item,{...item,id:'s2',slots:{...item.slots,metric:'sum_price'}}]},input)).toMatchObject({state:'valid',finalStatus:'RESOLVED'});
});

test('p15 form conditions cannot silently collapse multiple devices or switch snapshot semantics through NLU', () => {
  const f = conditionValidation(), previous = f.input.previousQueryContext!;
  if (!('contract' in previous)) throw new Error('expected form');
  const multi = { ...f.input, previousQueryContext: QueryContextRecordSchema.parse({ ...previous, params: { ...previous.params, deviceIds: [1, 2] } }) };
  expect(f.check(resolvedIntent(), multi)).toMatchObject({ finalStatus: 'UNSUPPORTED_DATA', issues: expect.arrayContaining([expect.objectContaining({ slot: 'deviceIds', code: 'unsupported_capability' })]) });
  for (const [text, mode] of [['切换到截至日期最近的快照 as_of', 'exact_date'], ['改为指定日期精确快照 exact_date', 'as_of']] as const) {
    expect(f.check(resolvedIntent(), { ...f.input, text }, mode)).toMatchObject({ finalStatus: 'UNSUPPORTED_DATA', issues: expect.arrayContaining([expect.objectContaining({ slot: 'snapshotMode' })]) });
  }
  expect(f.check()).toMatchObject({ state: 'valid', finalStatus: 'RESOLVED' });
  const one = { ...f.input, previousQueryContext: QueryContextRecordSchema.parse({ ...previous, params: { ...previous.params, deviceIds: [1] } }) };
  expect(f.check(resolvedIntent(), one)).toMatchObject({ finalStatus: 'UNSUPPORTED_DATA', issues: expect.arrayContaining([expect.objectContaining({ slot: 'deviceIds' })]) });
  const item = resolvedIntent().intents[0]!;
  expect(f.check({ ...resolvedIntent(), intents: [{ ...item, slots: { ...item.slots, device: '甲医疗器械' } }] }, one)).toMatchObject({ state: 'valid', finalStatus: 'RESOLVED' });
});

test('p15 full null conditions remain cleared unless the next user explicitly supplies the new filter', () => {
  const f = conditionValidation(), item = resolvedIntent().intents[0]!;
  for (const [field, value] of [['manufacturer', '甲厂'], ['distributor', '配送企业'], ['category', '甲类别'], ['status', 'active']] as const) {
    const prediction = { ...resolvedIntent(), intents: [{ ...item, slots: { ...item.slots, [field]: value } }] };
    expect(f.check(prediction)).toMatchObject({ state: 'invalid', issues: expect.arrayContaining([expect.objectContaining({ slot: field, code: 'explicit_condition_conflict' })]) });
    expect(f.check(prediction, { ...f.input, text: `改为 ${value}` })).toMatchObject({ state: 'valid', finalStatus: 'RESOLVED' });
  }
});

test('p15 localized status and change filters require current user evidence and preserve explicit clears', () => {
  const f = conditionValidation(), item = resolvedIntent().intents[0]!;
  const status = { ...resolvedIntent(), intents: [{ ...item, slots: { ...item.slots, status: 'active' } }] };
  expect(f.check(status, { ...f.input, text: '只看在售的器械' })).toMatchObject({ state: 'valid', finalStatus: 'RESOLVED' });
  expect(f.check(status, { ...f.input, text: '不限器械状态，只看在售的器械' })).toMatchObject({ state: 'invalid' });
  const changes = IntentItemSchema.parse({ ...item, l0: INTENT_TAXONOMY.FIELD_CHANGES.l0, l1: INTENT_TAXONOMY.FIELD_CHANGES.l1, l2: 'FIELD_CHANGES', slots: { ...item.slots, time: { start: '2026-10-10', endExclusive: '2026-10-11' }, direction: 'decrease', changeField: 'price', changeKind: 'field_changed' } });
  const prediction = { ...resolvedIntent(), intents: [changes] };
  for (const text of ['继续当前条件', '继续当前条件，不限制涨跌方向']) {
    expect(f.check(prediction, { ...f.input, text })).toMatchObject({ state: 'invalid', issues: expect.arrayContaining([expect.objectContaining({ slot: 'direction', code: 'explicit_condition_conflict' })]) });
  }
  expect(f.check(prediction, { ...f.input, text: '只看价格字段变化中的下跌' })).toMatchObject({ state: 'valid', finalStatus: 'RESOLVED' });
});

test('p15 as_of validation matches aggregate compilation and does not relax trend coverage', () => {
  const f = conditionValidation(), time = { start: '2026-10-11', endExclusive: '2026-10-12' }, base = resolvedIntent();
  const item = IntentItemSchema.parse({ ...base.intents[0], l0: 'STATISTICAL_ANALYSIS', l1: 'CATEGORY_REGION_STATS', l2: 'CATEGORY_STATS', slots: { ...base.intents[0]!.slots, time, metric: 'count', groupBy: 'category' } });
  const prediction = { ...base, intents: [item] };
  expect(f.check(prediction, f.input, 'as_of')).toMatchObject({ state: 'valid', finalStatus: 'RESOLVED' });
  expect(compileIntentQuery(item, f.input, [], 'as_of')).toMatchObject({ kind: 'aggregate', snapshotMode: 'as_of', time });
  const trend = IntentItemSchema.parse({ ...base.intents[0], l0: INTENT_TAXONOMY.PRICE_TREND.l0, l1: INTENT_TAXONOMY.PRICE_TREND.l1, l2: 'PRICE_TREND', slots: { ...base.intents[0]!.slots, time, metric: 'mean_price', groupBy: 'date' } });
  expect(f.check({ ...base, intents: [trend] }, f.input, 'as_of')).toMatchObject({ finalStatus: 'UNSUPPORTED_DATA', issues: expect.arrayContaining([expect.objectContaining({ code: 'data_coverage_missing' })]) });
  expect(compileIntentQuery(trend, f.input, [], 'as_of')).toMatchObject({ snapshotMode: 'exact_date' });
});

test('p15 an explicit positive product status cannot be silently dropped from a current query', () => {
  const f = conditionValidation(), base = resolvedIntent(), time = { start: '2026-10-10', endExclusive: '2026-10-11' };
  for (const text of ['列出2026-10-10在售医疗器械清单', '列出2026-10-10状态为active的器械']) {
    const prediction = { ...base, intents: [{ ...base.intents[0]!, slots: { ...base.intents[0]!.slots, time, status: null } }] };
    expect(f.check(prediction, { ...f.input, text })).toMatchObject({ state: 'invalid', issues: expect.arrayContaining([expect.objectContaining({ code: 'explicit_condition_conflict', slot: 'status' })]) });
  }
  const active = { ...base, intents: [{ ...base.intents[0]!, slots: { ...base.intents[0]!.slots, time, status: 'active' } }] };
  const previous = f.input.previousQueryContext!; if (!('contract' in previous)) throw new Error('expected form');
  const afterActive = { ...f.input, previousQueryContext: QueryContextRecordSchema.parse({ ...previous, params: { ...previous.params, status: 'active' } }) };
  expect(f.check(active, { ...afterActive, text: '器械状态不限，列出2026-10-10全部器械' })).toMatchObject({ state: 'invalid' });
  expect(f.check({ ...base, intents: [{ ...base.intents[0]!, slots: { ...base.intents[0]!.slots, time } }] }, { ...f.input, text: '查询2026-10-10价格趋势' })).toMatchObject({ state: 'invalid' });
});

test('p15 an explicit comparison cannot silently become one current listing', () => {
  const f = conditionValidation(), base = resolvedIntent();
  const listing = { ...base, intents: [{ ...base.intents[0]!, slots: { ...base.intents[0]!.slots, time: { start: '2026-10-08', endExclusive: '2026-10-09' } } }] };
  for (const text of ['比较浙江2026-10-08和2026-10-10的快照记录总数', '请帮我比较这两个日期的器械数量', '对比两个日期的器械数量', 'Please compare the two dates']) {
    expect(f.check(listing, { ...f.input, text })).toMatchObject({ state: 'invalid', adoptedIntents: [], issues: expect.arrayContaining([expect.objectContaining({ code: 'explicit_condition_conflict', slot: 'l2' })]) });
  }
  for (const text of ['不需要比较，列出2026-10-08器械', '列出名称包含比较的器械', 'List devices without comparison']) {
    expect(f.check(listing, { ...f.input, text })).toMatchObject({ state: 'valid', finalStatus: 'RESOLVED' });
  }
  const comparison = IntentItemSchema.parse({ ...base.intents[0], l0: INTENT_TAXONOMY.PERIOD_COMPARE.l0, l1: INTENT_TAXONOMY.PERIOD_COMPARE.l1, l2: 'PERIOD_COMPARE',
    slots: { ...base.intents[0]!.slots, metric: 'count' }, parameters: { periods: [{ start: '2026-10-08', endExclusive: '2026-10-09' }, { start: '2026-10-10', endExclusive: '2026-10-11' }] } });
  expect(f.check({ ...base, intents: [comparison] }, { ...f.input, text: '比较浙江两个日期的快照记录总数' })).toMatchObject({ state: 'valid', finalStatus: 'RESOLVED' });
});

test('p15 an explicit inclusive date range cannot lose or add dates in an adopted trend', () => {
  const f = conditionValidation(), base = resolvedIntent();
  const trend = IntentItemSchema.parse({ ...base.intents[0], l0: INTENT_TAXONOMY.PRICE_TREND.l0, l1: INTENT_TAXONOMY.PRICE_TREND.l1, l2: 'PRICE_TREND',
    slots: { ...base.intents[0]!.slots, time: { start: '2026-10-08', endExclusive: '2026-10-11' }, metric: 'mean_price', groupBy: 'date' } });
  const prediction = (time: typeof trend.slots.time) => ({ ...base, intents: [{ ...trend, slots: { ...trend.slots, time } }] });
  for (const connector of ['至', '到']) {
    const input = { ...f.input, text: `统计2026-10-08${connector}2026-10-10的每日平均价格趋势` };
    expect(f.check(prediction(trend.slots.time), input)).toMatchObject({ state: 'valid', finalStatus: 'RESOLVED' });
    for (const time of [{ start: '2026-10-08', endExclusive: '2026-10-10' }, { start: '2026-10-09', endExclusive: '2026-10-11' }, { start: '2026-10-08', endExclusive: '2026-10-12' }, null]) {
      expect(f.check(prediction(time), input)).toMatchObject({ state: 'invalid', adoptedIntents: [], issues: expect.arrayContaining([expect.objectContaining({ code: 'explicit_condition_conflict', slot: 'time' })]) });
    }
  }
  const exclusive = { start: '2026-10-08', endExclusive: '2026-10-10' };
  expect(f.check(prediction(exclusive), { ...f.input, text: '统计2026-10-08至2026-10-10（不含结束日）的每日平均价格趋势' })).toMatchObject({ state: 'valid', finalStatus: 'RESOLVED' });
  expect(f.check(prediction(exclusive), { ...f.input, text: '继续原查询的每日平均价格趋势' })).toMatchObject({ state: 'valid', finalStatus: 'RESOLVED' });
});

test('p15 trend reads all saved pages and rejects changed identity or totals while preserving its verified prefix', async () => {
  const { loadTrendRows } = await import('../../apps/desktop/src/renderer/query-trend');
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-trend-')), db = openDatabase(join(root, 'app.sqlite'));
  try {
    const saved = seedWorkspaceQueries(db).current, query = { ...saved, kind: 'trend' as const, totalRows: 501 };
    const rows = Array.from({ length: 501 }, (_, index) => ({ date: '2026-10-04', value: index, gap: false, unit: 'devices', metric: 'count' }));
    const reads: number[] = [], prefixes: number[] = [];
    const read = async (page: number) => { reads.push(page); const part = rows.slice((page - 1) * 500, page * 500); return { query, evidence: [], page: { queryId: query.id, rows: part, totalRows: 501, page, pageSize: 500, targetVersion: `query:${query.id}:${query.calculationVersion}`, rowKeys: part.map(() => null), warnings: [], calculationVersion: query.calculationVersion, evidenceIds: [] } }; };
    expect(await loadTrendRows(query, read, prefix => prefixes.push(prefix.length), () => true)).toEqual(rows);
    expect(reads).toEqual([1, 2]); expect(prefixes).toEqual([500, 501]);
    for (const change of ['identity', 'total', 'empty'] as const) {
      prefixes.length = 0;
      await expect(loadTrendRows(query, async page => { const value = await read(page); return page === 1 ? value : change === 'identity' ? { ...value, query: { ...query, id: query.id+1 } } : change === 'total' ? { ...value, page: { ...value.page, totalRows: 502 } } : { ...value, page: { ...value.page, rows: [], rowKeys: [] } }; }, prefix => prefixes.push(prefix.length), () => true)).rejects.toThrow('inconsistent');
      expect(prefixes).toEqual([500]);
    }
    let active = true; reads.length = 0;
    await expect(loadTrendRows(query, read, () => { active = false; }, () => active)).rejects.toThrow('cancelled'); expect(reads).toEqual([1]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('p15 trend plot separates units, keeps zero and breaks missing values without creating a node per point', async () => {
  const { SavedTrendPlot } = await import('../../apps/desktop/src/renderer/query-trend');
  const { renderToStaticMarkup } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('react-dom/server');
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-trend-plot-')), db = openDatabase(join(root, 'app.sqlite'));
  try {
    const query = { ...seedWorkspaceQueries(db).current, kind: 'trend' as const, totalRows: 5 };
    const row = { metric: 'mean_price', currency: 'CNY', unit: 'cents', priceUnit: '件', gap: false };
    const rows = [{ ...row, date: '2026-10-01', value: 0 }, { ...row, date: '2026-10-02', value: null, gap: true }, { ...row, date: '2026-10-03', value: 20 }, { ...row, date: '2026-10-04', value: null }, { ...row, priceUnit: '盒', date: '2026-10-01', value: 200 }];
    const html = renderToStaticMarkup(SavedTrendPlot({ query, rows }));
    expect(html.match(/data-testid="trend-series"/g)).toHaveLength(2); expect(html).toContain('priceUnit: 件'); expect(html).toContain('priceUnit: 盒');
    expect(html).toContain('1 date gaps. 2 missing values.'); expect(html).toContain('M45.00,190.00'); expect(html.match(/data-testid="trend-series" d="([^"]*)"/)?.[1]?.match(/M/g)).toHaveLength(2);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('p15 form contracts keep complete explicit conditions and require matching product evidence', async () => {
  const { SubmitInputSchema } = await import('../../packages/contracts/src/session');
  const { ProductTurnInputSchema, QueryContextRecordSchema, IntentDecisionSchema, INTENT_VERSIONS } = await import('../../packages/contracts/src/intent');
  const params = queryProductParams({ batchIds: [1] });
  const request = { mode: 'send', sessionId: 1, clientSequence: 1, text: 'Query form: ' + canonicalRequest(params),
    model: { provider: 'ollama', modelId: 'engineering', expectedConfigVersion: '1' }, referenceDate: '2026-10-11', timezone: 'Asia/Shanghai',
    expectedRevision: 1, expectedBatchIds: [1], expectedQueryId: null, routing: { mode: 'user_form', params } };
  expect(SubmitInputSchema.safeParse(request).success).toBe(true);
  const context = { contract: 'medclaw.query-form-context/v1', decisionId: 1, sourceRunId: 2, sourceInputId: 3,
    params, queryIds: [4] };
  expect(QueryContextRecordSchema.safeParse({ ...context, sessionId: 1, nativeLeafId: 'leaf', version: 1, pendingClarification: null }).success).toBe(true);
  const turn = { mode: 'user_form', runId: 2, sessionId: 1, inputId: 3, text: request.text, decisionId: 1,
    baseLeafId: null, baseStorageVersion: 0, occurredAt: '2026-10-11T00:00:00.000Z',
    result: { kind: 'result', text: 'Saved query', queryIds: [4], missingSlots: [] },
    execution: { contract: 'medclaw.query-form-execution/v1', decisionId: 1, queryId: 4 }, adoptedContext: context };
  expect(ProductTurnInputSchema.safeParse(turn).success).toBe(true);
  for (const patch of [{ result: { ...turn.result, queryIds: [5] } }, { decisionId: 2 }, { adoptedContext: { ...context, sourceInputId: 8 } },
    { adoptedContext: { ...context, queryIds: [4, 5] } }]) expect(ProductTurnInputSchema.safeParse({ ...turn, ...patch }).success).toBe(false);
  const decision = { intentCallId: null, matchedBy: null, route: 'simple', status: 'RESOLVED', adoptedIntents: [], contextIntentId: null,
    adoptedSlots: null, queryParams: params, missingSlots: [], issues: [], ruleEvaluation: null, decisionSource: 'user_form',
    schemaVersion: INTENT_VERSIONS.schemaVersion, policyVersion: INTENT_VERSIONS.policyVersion };
  const route = decision;
  expect(IntentDecisionSchema.safeParse(route).success).toBe(true);
  expect(IntentDecisionSchema.safeParse({ ...route, route: 'agent', queryParams: null }).success).toBe(false);
});

test('p15 runner discovers only its stage and rejects unknown stages and zero execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-runner-'));
  try {
    expect(() => discoverTests('unit', 'P150', root)).toThrow('Unknown test stage');
    expect(await runStage('unit', 'P15', { root })).toMatchObject({ discoveredFiles: 0, discovered: 0, executed: 0, exitCode: 1 });
    const directory = join(root, 'tests/unit');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'p15-probe.test.ts');
    writeFileSync(join(directory, 'p14-other.test.ts'), "throw new Error('wrong stage');");
    writeFileSync(file, 'export {};');
    expect(discoverTests('unit', 'P15', root)).toEqual([file]);
    expect(await runStage('unit', 'P15', { root })).toMatchObject({ discoveredFiles: 1, executed: 0, pass: 0, exitCode: 1 });
    for (const category of ['integration', 'e2e', 'desktop'] as const) {
      const other = join(root, 'tests', category === 'desktop' ? 'e2e' : 'integration');
      mkdirSync(other, { recursive: true });
      const candidate = join(other, `p15-probe.${category === 'desktop' ? 'spec' : 'test'}.ts`);
      writeFileSync(candidate, 'export {};');
      expect(discoverTests(category, 'P15', root)).toEqual([candidate]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('p15 engineering fixture contains separate scopes, gaps, shared identifiers and price edge cases beyond one page', () => {
  const data = queryProductData();
  expect(new Set(data.batches.map(batch => batch.scopeKey)).size).toBe(2);
  expect(data.snapshots.filter(row => row.batchId === 3)).toHaveLength(502);
  expect(data.batches.some(batch => batch.snapshotDate === '2026-10-10')).toBe(false);
  expect(data.batches.find(batch => batch.id === 2)?.declaredMissingDeviceIds).toEqual([502]);
  expect(data.snapshots.some(row => row.priceCents === 0)).toBe(true);
  expect(data.snapshots.some(row => row.priceCents === null)).toBe(true);
  expect(new Set(data.snapshots.map(row => row.unit)).size).toBe(2);
  expect(data.changes.filter(row => row.oldValue === 0).every(row => row.ratio === null)).toBe(true);
  expect(data.snapshots.filter(row => row.deviceId === 1 && [3, 5].includes(row.batchId))).toHaveLength(2);
});

test('p15 export contracts reject forged completion, unsafe paths and inconsistent manifests', async () => {
  expect(await Bun.file(new URL('../../packages/contracts/src/export.ts', import.meta.url)).exists()).toBe(true);
  const { ExportRequestSchema, ExportOperationSchema, ExportManifestSchema, ExportCopyReceiptSchema } = await import('../../packages/contracts/src/export');
  const time = '2026-10-11T01:00:00.000Z';
  const request = { operationRef: 'export:one', queryId: 1, answerId: null, format: 'csv', destinationToken: 'grant' };
  expect(ExportRequestSchema.safeParse(request).success).toBe(true);
  expect(ExportRequestSchema.safeParse({ ...request, answerId: undefined }).success).toBe(false);
  expect(ExportRequestSchema.safeParse({ ...request, priorOperationRef: request.operationRef }).success).toBe(false);
  expect(ExportRequestSchema.safeParse({ ...request, destinationPath: 'C:/secret' }).success).toBe(false);
  const manifest = { contract: 'medclaw.export-manifest/v2', artifactId: 2, originOperationRef: request.operationRef, queryId: 1,
    answerId: null, format: 'csv', exportVersion: 'medclaw.export/v2',
    files: [{ path: 'result.csv', bytes: 3 }, { path: 'metadata.json', bytes: 4 }] };
  expect(ExportManifestSchema.safeParse(manifest).success).toBe(true);
  for (const files of [[manifest.files[0]], [manifest.files[0], manifest.files[0]], [{ ...manifest.files[0], path: '../result.csv' }]]) {
    expect(ExportManifestSchema.safeParse({ ...manifest, files }).success).toBe(false);
  }
  const artifact = { id: 2, operationRef: request.operationRef, queryId: 1, format: 'csv', relativePath: 'artifacts/2',
    sizeBytes: 7, publishedAt: time, registeredAt: time };
  const operation = { operationRef: request.operationRef, priorOperationRef: null, state: 'completed',
    queryId: 1, answerId: null, format: 'csv', artifact, copyState: 'verified', error: null, cancelRequestedAt: null, updatedAt: time };
  expect(ExportOperationSchema.safeParse(operation).success).toBe(true);
  for (const patch of [{ artifact: null }, { copyState: 'unknown' }, { artifact: { ...artifact, queryId: 3 } },
    { artifact: { ...artifact, relativePath: 'artifacts/3' } }, { artifact: { ...artifact, relativePath: '../2' } }]) {
    expect(ExportOperationSchema.safeParse({ ...operation, ...patch }).success).toBe(false);
  }
  const receipt = { contract: 'medclaw.export-receipt/v2', operationRef: request.operationRef, artifactId: 2, exportId:1, verifiedAt: time, files: manifest.files.map(file => ({ name: file.path, bytes: file.bytes })) };
  expect(ExportCopyReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(ExportCopyReceiptSchema.safeParse({ ...receipt, files: [receipt.files[0], receipt.files[0]] }).success).toBe(false);
});

test('p15 private destination bridge validates safe capability fields and rejects raw paths', async () => {
  const { PrivateCredentialFrameSchema, PrivateCredentialReplySchema, privateCredentialMethodSchemas, HOST_PROTOCOL_VERSION } = await import('../../packages/contracts/src/protocol');
  const payload = { operationRef: 'export:bridge', queryId: 1, answerId: null, format: 'json', destinationToken: 'grant' };
  const frame = { protocolVersion: HOST_PROTOCOL_VERSION, kind: 'private', secret: true, instanceId: 'host', requestId: 'request', method: 'export.destination.describe', payload };
  expect(PrivateCredentialFrameSchema.safeParse(frame).success).toBe(true);
  expect(PrivateCredentialFrameSchema.safeParse({ ...frame, payload: { ...payload, destinationPath: 'D:/secret' } }).success).toBe(false);
  const { payload: _request, ...replyFields } = frame;
  expect(PrivateCredentialReplySchema.safeParse({ ...replyFields, result: { ok: true, data: { valid:true } } }).success).toBe(true);
  expect(privateCredentialMethodSchemas['export.destination.cancel'].input.safeParse({ operationRef: payload.operationRef }).success).toBe(true);
  expect(privateCredentialMethodSchemas['export.destination.settlePrevious'].output.safeParse({ stopped: false }).success).toBe(false);
});

test('p15 format artifacts preserve every saved row, typed values, formula escapes and explicit cents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-format-')), db = openDatabase(join(root, 'app.sqlite'));
  try {
    const names = [' \t=2+3', '+formula', '', 'quote " pipe | newline\n汉字 <script>`'], seeded = seedWorkspaceQueries(db, undefined, {
      deviceCount: 502, deviceName: id => names[id - 1] ?? `ENGINEERING-${id}`, priceCents: id => id === 1 ? 0 : id === 2 ? null : 105,
    });
    const store = new SqliteExportStore(db), artifacts = new ArtifactStore(db, join(root, 'artifacts'));
    expect(artifacts.publishExport).toBeFunction();
    expect(artifacts.verifyExport).toBeFunction();
    const source = store.readSource(seeded.current.id, null), callsBefore = db.query('SELECT * FROM model_calls').all();
    for (const format of ['csv', 'json', 'markdown'] as const) {
      const operationRef = `format:${format}`,request={operationRef,queryId:source.query.id,answerId:null,format,destinationToken:'grant'};
      const reserved = store.accept({ operationRef, request, instanceId: 'host', sessionId: 1, queryId: source.query.id, answerId: null,
        format, priorExportId: null, reuseArtifactId: null, createdAt: '2026-10-11T01:00:00.000Z' });
      const published = await artifacts.publishExport({ artifactId: reserved.reservedArtifactId!, originOperationRef: operationRef, format, source }, new AbortController().signal);
      expect(store.find(operationRef)?.artifact).toBeNull();
      const directory = join(root, 'artifacts', String(published.artifactId));
      const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
      expect(manifest.files.some((file: { path: string }) => file.path === 'manifest.json')).toBe(false);
      expect(manifest.queryId).toBe(source.query.id);
      if (format === 'csv') {
        const bytes = readFileSync(join(directory, 'result.csv')), csv = bytes.toString('utf8'), metadata = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8'));
        expect([...bytes.subarray(0, 3)]).toEqual([239, 187, 191]);
        expect(metadata.totalRows).toBe(502); expect(metadata.scope).toBe('all_saved'); expect(metadata.query.id).toBe(source.query.id);expect(metadata.query.params).toEqual(source.query.params);
        expect(csv).toContain("' \t=2+3"); expect(csv).toContain("'+formula"); expect(csv).toContain('"priceCents","priceCNY"'); expect(csv).toContain('"1.05"');
        expect(csv.endsWith('\r\n')).toBe(true);
        const records = [...readCsvRecords(join(directory, 'result.csv'))], nameColumn = records[0]!.indexOf('deviceName');
        expect(records).toHaveLength(503);
        expect(records[4]![nameColumn]).toBe(names[3]!);
        expect(metadata.escapedCells).toContainEqual({ row: 1, column: 'deviceName', original: names[0] });
        expect(metadata.nullCells).toContainEqual({ row: 2, column: 'priceCents' });
        expect(metadata.nullCells).not.toContainEqual({ row: 3, column: 'deviceName' });
      } else if (format === 'json') {
        const payload = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
        expect(payload.rows).toEqual(source.query.rows); expect(payload.answer).toBeNull(); expect(payload.metadata.totalRows).toBe(502);
      } else {
        const text = readFileSync(join(directory, 'result.md'), 'utf8');
        expect(text).toContain('Missing'); expect(text).toContain('\\|'); expect(text).toContain('&lt;script&gt;'); expect(text).not.toContain('<script>');
        expect(text).toContain('```json\n'); expect(text).toContain('"totalRows":502');
      }
      store.publish(operationRef, published); store.register(operationRef, published);
      expect(await artifacts.verifyExport(published.artifactId)).toEqual(published);
    }
    expect(db.query('SELECT * FROM model_calls').all()).toEqual(callsBefore);
    expect(db.query('SELECT id FROM queries').all()).toHaveLength(3);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('p15 format empty, topN and mean-price artifacts retain their frozen scope and reject tampered publications', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-format-edge-')), db = openDatabase(join(root, 'app.sqlite'));
  try {
    const seeded = seedWorkspaceQueries(db, undefined, { deviceCount: 4, priceCents: id => id <= 2 ? 99 + id : 197 + id });
    db.exec("UPDATE snapshots SET category=CASE WHEN device_id<=2 THEN 'A' ELSE 'B' END,unit=CASE WHEN device_id<=2 THEN '台' ELSE '盒' END; UPDATE runs SET status='running',ended_at=NULL WHERE id=10");
    const store = new SqliteExportStore(db), artifacts = new ArtifactStore(db, join(root, 'artifacts'));
    const base = { batchIds: [1], time: { start: '2026-10-04', endExclusive: '2026-10-05' } };
    const params = [queryProductParams({ ...base, manufacturer: 'No matching manufacturer' }),
      queryProductParams({ ...base, kind: 'aggregate', metric: 'count', groupBy: 'category', topN: 1 }),
      queryProductParams({ ...base, kind: 'aggregate', metric: 'mean_price' })];
    const queries = [];
    for (const [index, conditions] of params.entries()) { const result = await seeded.queries.execute(conditions, { ...seeded.context, callRef: `format:edge:${index}` }); if (!result.ok) throw result.error; queries.push(result.data); }
    expect(queries.map(query => query.rows.length)).toEqual([0, 1, 2]);
    expect(queries[2]!.rows.map(row => row.value).sort()).toEqual([100.5, 200.5]);
    const queryCount = db.query('SELECT COUNT(*) n FROM queries').get();
    for (const [index, query] of queries.entries()) {
      const source = store.readSource(query.id, null), operationRef = `edge:${index}`;
      const reserved = store.accept({ operationRef, request:{operationRef,queryId:query.id,answerId:null,format:'csv',destinationToken:'grant'}, instanceId: 'host', sessionId: 1, queryId: query.id, answerId: null, format: 'csv', priorExportId: null, reuseArtifactId: null, createdAt: '2026-10-11T01:00:00.000Z' });
      const published = await artifacts.publishExport({ artifactId: reserved.reservedArtifactId!, originOperationRef: operationRef, format: 'csv', source }, new AbortController().signal);
      const directory = join(root, 'artifacts', String(published.artifactId)), payload = join(directory, 'result.csv'), bytes = readFileSync(payload);
      const records = [...readCsvRecords(payload)], metadata = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8'));
      expect(records).toHaveLength(source.query.rows.length + 1); expect(metadata.totalRows).toBe(source.query.rows.length); expect(metadata.query.params).toEqual(params[index]);
      if (index === 0) expect(records[0]).toContain('priceCents');
      if (index === 1) { expect(metadata.topN).toBe(1); expect(source.query.rows[0]).toMatchObject({ category: 'A', value: 2 }); }
      if (index === 2) { expect(records.flat()).toContain('100.5'); expect(records.flat()).toContain('1.01'); expect(records.flat()).toContain('2.01'); expect(records.flat()).toContain('盒'); expect(records.flat()).toContain('台'); }
      expect(await artifacts.verifyExport(published.artifactId)).toEqual({ ...published, publishedAt: null });
      writeFileSync(payload, Buffer.concat([bytes, Buffer.from('tampered')])); await expect(artifacts.verifyExport(published.artifactId)).rejects.toThrow('artifact_not_ready'); writeFileSync(payload, bytes);
      const extra = join(directory, 'unexpected.txt'); writeFileSync(extra, 'unexpected'); await expect(artifacts.verifyExport(published.artifactId)).rejects.toThrow('artifact_not_ready'); rmSync(extra);
    }
    expect(db.query('SELECT COUNT(*) n FROM queries').get()).toEqual(queryCount); expect(db.query('SELECT id FROM model_calls').all()).toHaveLength(0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}, 60000);

test('p15 runner reports actual counts and fails mandatory skips and module loading errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-runner-'));
  const directory = join(root, 'tests/unit');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'p15-probe.test.ts');
  try {
    writeFileSync(file, "import {test} from 'bun:test'; test.skip('required',()=>{});");
    expect(await runStage('unit', 'P15', { root })).toMatchObject({ discovered: 1, executed: 0, skip: 1, exitCode: 1 });
    writeFileSync(file, "import {test} from 'bun:test'; test('real',()=>{}); test.skip('required',()=>{});");
    expect(await runStage('unit', 'P15', { root })).toMatchObject({ discovered: 2, executed: 1, pass: 1, fail: 0, skip: 1, exitCode: 1 });
    writeFileSync(file, "import {test} from 'bun:test'; test('real',()=>{}); throw new Error('load failed');");
    expect((await runStage('unit', 'P15', { root })).exitCode).toBe(1);
    writeFileSync(file, "import {test,expect} from 'bun:test'; test('real',()=>expect(Bun.argv.includes('--stage')).toBe(false));");
    expect(await runStage('unit', 'P15', { root })).toMatchObject({ discoveredFiles: 1, discovered: 1, executed: 1, pass: 1, fail: 0, skip: 0, exitCode: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
