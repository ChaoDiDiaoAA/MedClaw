import { z } from 'zod';
import { IntentInputProjectionSchema, IntentItemSchema, IntentResultSchema, IntentValidationSchema, IntentStageInputSchema,
  INTENT_TAXONOMY, L0Schema, L1Schema, L2Schema,
  type IntentInputProjection, type IntentItem, type IntentResult, type IntentValidation, type ValidationIssue, type IntentCandidate, type IntentStageInput } from '../../../contracts/src/intent';
import { safeError, type Result } from '../../../contracts/src/error';
import { type QueryExecutionContext, type Snapshot } from '../../../contracts/src/query';
import { canonicalRequest } from '../../../contracts/src/run';
import { CatalogService, nextDate } from '../data/catalog-service';
import { INTENT_CAPABILITIES, CONFUSABLE_PAIRS } from './taxonomy';
import { compileIntentStepQueries } from './route-policy';

export function validateIntentResult(raw: string): Result<IntentResult> {
  try {
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('intent_output_invalid');
    return { ok: true, data: IntentResultSchema.parse(JSON.parse(raw)) };
  } catch { return { ok: false, error: safeError('intent_output_invalid') }; }
}
const distinct = (values: readonly string[]) => [...new Set(values)].sort();
const same = (left: unknown, right: unknown) => canonicalRequest(left) === canonicalRequest(right);
const currentPurposes = new Set(['PRODUCT_SEARCH', 'PRODUCT_DETAIL', 'COMPANY_PRODUCTS', 'PRODUCT_COMPARE']);
const changePurposes = new Set(['NEW_RECORDS', 'FIELD_CHANGES', 'PRICE_ANOMALY']);
export type EntityResolution = { deviceIds: number[]; issues: ValidationIssue[] };
export type PredictionCheck = { prediction: IntentResult | null; validation: IntentValidation; candidates: IntentCandidate[] };
const hierarchyHeader = z.object({ status: z.literal('RESOLVED'), intents: z.array(z.object({ l0: L0Schema, l1: L1Schema, l2: L2Schema }).passthrough()).min(1).max(8) }).passthrough();

export class IntentValidator {
  constructor(private readonly catalog: CatalogService) {}
  readFreshness(raw:IntentItem,context:import('../../../contracts/src/query').QueryContext) {
    const item=IntentItemSchema.parse(raw);
    if(item.l2!=='FRESHNESS'||item.parameters.basis!=='snapshot_date')throw safeError('access_denied');
    const batches=this.catalog.batches(context.scope.batchIds,context).filter(batch=>item.slots.region===null||batch.region===item.slots.region);
    if(!batches.length)throw safeError('data_missing');
    return batches;
  }
  resolveEntities(raw: IntentItem, context: QueryExecutionContext): EntityResolution {
    const item = IntentItemSchema.parse(raw), issues: ValidationIssue[] = [], ids: number[] = [];
    const values = [...(item.slots.device === null ? [] : [item.slots.device]), ...(item.l2 === 'PRODUCT_COMPARE' ? item.parameters.devices : [])];
    for (const value of values) {
      const result = this.catalog.resolveDevice({ text: value, matchBy: 'name', page: 1, pageSize: 20 }, context);
      if (result.resolution !== 'unique') issues.push({ code: result.resolution === 'none' ? 'entity_not_found' : 'ambiguous_entity',
        intentId: item.id, slot: 'device', severity: 'needs_input', message: result.resolution === 'none' ? 'No authorized device matches this name.' : 'Select one of the authorized devices.',
        candidates: [...new Set(result.items.map(device => device.deviceName))].slice(0, 20).map(name => name.slice(0, 256)) });
      else ids.push(result.items[0]!.id);
    }
    if (item.l2 === 'PRODUCT_COMPARE' && ids.length > 0 && new Set(ids).size !== ids.length) issues.push({ code: 'invalid_combination',
      intentId: item.id, slot: 'devices', severity: 'invalid', message: 'A comparison requires distinct devices.', candidates: [] });
    return { deviceIds: issues.length ? [] : [...new Set(ids)], issues };
  }
  validateQueryParams(raw: IntentResult, context: QueryExecutionContext, frozen: IntentInputProjection, checkedAt: string): IntentValidation {
    const result = IntentResultSchema.parse(raw), input = IntentInputProjectionSchema.parse(frozen);
    if (input.runId !== context.runId || input.inputId !== context.inputId || input.sessionId !== context.sessionId
      || input.referenceDate !== context.referenceDate || input.timezone !== context.timezone || !same(input.scope, context.scope)) throw new Error('access_denied');
    this.catalog.assertContext(context);
    const batches = input.scope.batchIds.length ? this.catalog.batches(input.scope.batchIds, context) : [];
    const rows = batches.length ? this.catalog.snapshots(input.scope.batchIds, context) : [];
    if (!same(distinct(batches.map(batch => batch.contentHash)), input.scopeBatchHashes)
      || !same(distinct(batches.map(batch => batch.region)), distinct(input.availableData.regions))
      || !same(distinct(batches.map(batch => batch.snapshotDate)), distinct(input.availableData.dates))
      || !same(distinct(rows.map(row => row.currency)), distinct(input.availableData.currencies))
      || !same(distinct(rows.map(row => row.unit)), distinct(input.availableData.units))) throw new Error('state_conflict');
    const issues: ValidationIssue[] = [], resolvedDeviceIds: IntentValidation['resolvedDeviceIds'] = [], adopted = structuredClone(result.intents);
    const issue = (item: IntentItem | null, code: ValidationIssue['code'], slot: string, severity: ValidationIssue['severity'], message: string, candidates: string[] = []) => {
      issues.push({ code, intentId: item?.id ?? null, slot, severity, message, candidates: candidates.slice(0, 20).map(value => value.slice(0, 256)) });
    };
    if (result.status === 'UNSUPPORTED_DATA' && !adopted.length) issue(null, 'unsupported_capability', 'taxonomy', 'needs_input',
      'This domain task has no registered L2. Start an explicit Agent run to analyze it.');
    for (const item of adopted) {
      const cap = INTENT_CAPABILITIES[item.l2], slots = item.slots;
      if (cap.state === 'disabled' || !input.enabledL2.includes(item.l2) || cap.tools.some(tool => !input.availableToolNames.includes(tool) || !input.scope.allowedToolNames.includes(tool))) {
        issue(item, 'unsupported_capability', 'capability', 'needs_input', 'The required data or execution capability is not enabled.');
      }
      for (const slot of cap.requiredSlots) if (slots[slot] === null) issue(item, 'missing_slot', slot, 'needs_input', 'A required parameter is missing.');
      for (const parameter of cap.requiredParameters) {
        const value = parameter === 'resultRef' ? item.resultRef : Reflect.get(item.parameters, parameter);
        if (value == null || Array.isArray(value) && !value.length) issue(item, 'missing_slot', parameter, 'needs_input', 'A required parameter is missing.');
      }
      const selected = batches.filter(batch => slots.region === null || batch.region === slots.region);
      if (slots.region !== null && !selected.length) issue(item, 'scope_violation', 'region', 'invalid', 'The region is outside the authorized Scope.');
      if (!batches.length) issue(item, 'data_missing', 'batchIds', 'needs_input', 'No authorized data batches are available.');
      else if (currentPurposes.has(item.l2) && slots.region === null && distinct(selected.map(batch => batch.region)).length !== 1) {
        issue(item, 'missing_slot', 'region', 'needs_input', 'Select a unique region for this listing.', distinct(selected.map(batch => batch.region)));
      }
      for (const field of ['manufacturer', 'category', 'distributor'] as const) {
        const values = field === 'manufacturer' && item.l2 === 'COMPANY_COMPARE' ? [...item.parameters.manufacturers, ...(slots[field] ? [slots[field]!] : [])]
          : slots[field] === null ? [] : [slots[field]!];
        const vocabulary = distinct(rows.map(row => row[field]).filter((value): value is string => value !== null));
        for (const value of values) {
          if (!vocabulary.length) issue(item, 'data_missing', field, 'needs_input', 'The requested field is absent in the available data.');
          else if (!vocabulary.includes(value)) issue(item, 'entity_not_found', field, 'needs_input', 'Use a canonical value from the authorized data.', vocabulary);
        }
      }
      const entities = this.resolveEntities(item, context); issues.push(...entities.issues);
      if (entities.deviceIds.length) resolvedDeviceIds.push({ intentId: item.id, deviceIds: entities.deviceIds });
      if (item.l2 === 'NEW_RECORDS' && slots.changeKind !== null && slots.changeKind !== 'added'
        || item.l2 === 'FIELD_CHANGES' && slots.changeKind !== null && slots.changeKind !== 'field_changed'
        || item.l2 === 'PRICE_ANOMALY' && (slots.changeField !== null && slots.changeField !== 'price' || slots.changeKind !== null && slots.changeKind !== 'field_changed')) {
        issue(item, 'invalid_combination', 'changeKind', 'invalid', 'The change condition contradicts the selected purpose.');
      }
      if (item.l2 === 'PRICE_ANOMALY' && item.parameters.method === 'statistical') issue(item, 'unsupported_capability', 'method', 'needs_input', 'Statistical anomaly detection is not implemented.');
      if (item.l2 === 'FRESHNESS' && item.parameters.basis === 'capture_time') issue(item, 'data_missing', 'basis', 'needs_input', 'Capture timestamps are unavailable; snapshot dates are a different basis.');
      if (item.l2 === 'CATEGORY_STATS' && slots.groupBy !== null && slots.groupBy !== 'category'
        || item.l2 === 'REGION_STATS' && slots.groupBy !== null && slots.groupBy !== 'region'
        || item.l2 === 'COMPANY_RANK' && slots.groupBy !== null && slots.groupBy !== 'manufacturer'
        || item.l2 === 'PRICE_TREND' && (slots.groupBy !== null && slots.groupBy !== 'date' || slots.metric !== null && !['mean_price', 'sum_price'].includes(slots.metric))) {
        issue(item, 'invalid_combination', 'groupBy', 'invalid', 'The metric or grouping contradicts the selected purpose.');
      }
      if ((cap.queryKind === 'current' || cap.queryKind === 'changes') && (slots.metric !== null || slots.groupBy !== null || slots.topN !== null)) {
        issue(item, 'unsupported_capability', 'metric', 'needs_input', 'This listing does not implement the requested aggregation or ranking.');
      }
      if (currentPurposes.has(item.l2) && (slots.changeKind !== null || slots.changeField !== null || slots.direction !== null || slots.threshold !== null)) {
        issue(item, 'invalid_combination', 'changeField', 'invalid', 'Current snapshots cannot use change filters.');
      }
      if ((slots.direction !== null || slots.threshold !== null) && slots.changeField !== 'price' && item.l2 !== 'PRICE_ANOMALY') issue(item, 'invalid_combination', 'changeField', 'invalid', 'Price filters require a price change purpose.');
      const latest = distinct(selected.map(batch => batch.snapshotDate)).at(-1);
      if (slots.time === null && latest && (currentPurposes.has(item.l2) || cap.queryKind === 'aggregate' || item.l2==='COMPANY_COMPARE')) {
        slots.time = { start: latest, endExclusive: nextDate(latest) };
      }
      const targetTime = slots.time ?? (!cap.requiredSlots.includes('time') && latest ? { start: latest, endExclusive: nextDate(latest) } : null);
      const times = item.l2 === 'PERIOD_COMPARE' ? item.parameters.periods : targetTime === null ? [] : [targetTime];
      const changes=changePurposes.has(item.l2)||['change_count','changed_device_count'].includes(slots.metric??'');
      for (const time of times) {
        if (currentPurposes.has(item.l2) && nextDate(time.start) !== time.endExclusive) issue(item, 'invalid_combination', 'time', 'invalid', 'A current snapshot needs one exact target day.');
        const selectedRows: Snapshot[] = [];
        for (const scopeKey of new Set(selected.map(batch => batch.scopeKey))) {
          const group = selected.filter(batch => batch.scopeKey === scopeKey);
          for (let date = time.start; date < time.endExclusive; date = nextDate(date)) {
            const batch = group.find(value => value.snapshotDate === date);
            if (!batch || changes && (batch.previousBatchId === null || !input.scope.batchIds.includes(batch.previousBatchId))) {
              issue(item, 'data_coverage_missing', 'time', 'needs_input', 'The exact requested period or its predecessor is missing.'); break;
            }
            selectedRows.push(...rows.filter(row => row.batchId === batch.id
              && (!entities.deviceIds.length || entities.deviceIds.includes(row.deviceId))
              && (['manufacturer', 'category', 'distributor', 'status'] as const).every(field => slots[field] === null || row[field] === slots[field])));
          }
        }
        for (const field of ['category', 'manufacturer'] as const) if (cap.requiredFields.includes(field) && selectedRows.length && selectedRows.every(row => row[field] === null)) {
          issue(item, 'data_missing', field, 'needs_input', 'The required grouping or comparison field is absent from the selected population.');
        }
        const prices = item.l2 === 'PRICE_ANOMALY' || item.l2 === 'PRICE_TREND' || slots.metric === 'mean_price' || slots.metric === 'sum_price';
        if (prices && selectedRows.length && selectedRows.every(row => row.priceCents === null)) issue(item, 'data_missing', 'price', 'needs_input', 'Price values are unavailable.');
        if (prices && (distinct(selectedRows.map(row => row.currency)).length > 1 || distinct(selectedRows.map(row => row.unit)).length > 1)) issue(item, 'unsupported_capability', 'unit', 'needs_input', 'Prices cannot be combined across currencies or units.');
      }
      if (adopted.length === 1) this.explicitConditions(item, input, issue);
      if (!issues.some(value => value.intentId === item.id)) {
        try { compileIntentStepQueries(item, input, entities.deviceIds); }
        catch { issue(item, 'invalid_combination', 'queryParams', 'invalid', 'The requested metric, population or filters cannot form a valid query.'); }
      }
    }
    if (!issues.length && ['NEED_PARAMETERS', 'UNSUPPORTED_DATA'].includes(result.status)) issue(null, 'invalid_combination', 'status', 'invalid',
      'The predicted missing or unsupported conclusion has no matching program evidence.');
    const invalid = issues.some(value => value.severity === 'invalid'), unsupported = issues.some(value => ['data_missing', 'data_coverage_missing', 'unsupported_capability'].includes(value.code));
    const missingSlots = distinct(issues.filter(value => ['missing_slot', 'entity_not_found'].includes(value.code)).map(value => `${value.intentId}.${value.slot}`));
    const status = invalid ? null : unsupported ? 'UNSUPPORTED_DATA' : issues.some(value => value.code === 'ambiguous_entity') ? 'AMBIGUOUS'
      : missingSlots.length ? 'NEED_PARAMETERS' : result.status;
    this.catalog.checkActive(context);
    return IntentValidationSchema.parse({ contract: 'medclaw.intent-validation/v2', state: invalid ? 'invalid' : 'valid', finalStatus: status,
      adoptedIntents: invalid ? [] : adopted, missingSlots: missingSlots.slice(0, 20), issues: issues.slice(0, 64),
      resolvedDeviceIds: invalid ? [] : resolvedDeviceIds, reviewRequired: false, rawOutputTruncated: false, checkedAt });
  }
  checkPrediction(raw: string, context: QueryExecutionContext, rawStage: IntentStageInput, checkedAt: string, truncated = false): PredictionCheck {
    const stage = IntentStageInputSchema.parse(rawStage), parsed = validateIntentResult(raw);
    const failed = (prediction: IntentResult | null, code: ValidationIssue['code'], candidates: IntentCandidate[] = []): PredictionCheck => ({ prediction,
      candidates, validation: IntentValidationSchema.parse({ contract: 'medclaw.intent-validation/v2', state: truncated ? 'not_run' : 'invalid',
        finalStatus: null, adoptedIntents: [], missingSlots: [], issues: truncated ? [] : [{ code, intentId: null, slot: 'output', severity: 'invalid',
          message: candidates.length ? 'Compare only the safe registered candidates.' : 'The output cannot be adopted safely.', candidates: [] }],
        resolvedDeviceIds: [], reviewRequired: candidates.length > 0 && !truncated, rawOutputTruncated: truncated, checkedAt: truncated ? null : checkedAt }) });
    if (truncated) return failed(null, 'invalid_value');
    if (!parsed.ok) {
      if (stage.stage === 'verify') return failed(null, 'invalid_value');
      let repaired: IntentResult | null = null;
      try {
        const header = hierarchyHeader.parse(JSON.parse(raw));
        if (header.intents.some(item => item.l0 !== INTENT_TAXONOMY[item.l2].l0 || item.l1 !== INTENT_TAXONOMY[item.l2].l1)) {
          repaired = IntentResultSchema.parse({ ...header, intents: header.intents.map(item => ({ ...item,
            l0: INTENT_TAXONOMY[item.l2].l0, l1: INTENT_TAXONOMY[item.l2].l1 })) });
        }
      } catch { /* Only the two legal parent labels can be repaired into review candidates. */ }
      if (repaired) {
        const checked = this.validateQueryParams(repaired, context, stage.input, checkedAt);
        if (checked.state === 'valid' && checked.finalStatus === 'RESOLVED') return failed(null, 'hierarchy_conflict', [{ reasonCode: 'hierarchy_conflict', intents: checked.adoptedIntents }]);
      }
      return failed(null, 'invalid_value');
    }
    const prediction = parsed.data;
    if (stage.stage === 'verify') {
      const candidates = stage.review!.candidates;
      if (prediction.intents.length && !candidates.some(candidate => same(candidate.intents, prediction.intents))
        || prediction.candidateIntents.some(candidate => !candidates.some(allowed => same(allowed.intents, candidate.intents)))) return failed(prediction, 'scope_violation');
      return { prediction, validation: this.validateQueryParams(prediction, context, stage.input, checkedAt), candidates: [] };
    }
    const validation = this.validateQueryParams(prediction, context, stage.input, checkedAt);
    if (validation.state !== 'valid' || validation.finalStatus !== 'AMBIGUOUS' || !prediction.candidateIntents.length) return { prediction, validation, candidates: [] };
    const candidates: IntentCandidate[] = [];
    for (const candidate of prediction.candidateIntents) {
      const checked = this.validateQueryParams({ contract: 'medclaw.intent/v2', status: 'RESOLVED', intents: candidate.intents, candidateIntents: [], clarification: null }, context, stage.input, checkedAt);
      if (checked.state !== 'valid') return failed(prediction, 'scope_violation');
      candidates.push({ ...candidate, intents: checked.adoptedIntents });
    }
    const labels = new Set(candidates.flatMap(candidate => candidate.intents.map(item => item.l2)));
    const confusion = candidates.length >= 2 && candidates.every(candidate => candidate.reasonCode === 'confusable_pair' && candidate.intents.length === 1)
      && labels.size === 2 && CONFUSABLE_PAIRS.some(pair => pair.every(label => labels.has(label)));
    const suspectedOod = candidates.every(candidate => candidate.reasonCode === 'suspected_ood') && /医疗器械|器械|注册证|厂家|配送商/.test(stage.input.text);
    if (!confusion && !suspectedOod) return { prediction, validation, candidates: [] };
    return { prediction, validation: IntentValidationSchema.parse({ ...validation, reviewRequired: true }), candidates };
  }
  private explicitConditions(item: IntentItem, input: IntentInputProjection,
    issue: (item: IntentItem, code: ValidationIssue['code'], slot: string, severity: ValidationIssue['severity'], message: string) => void) {
    const { text, referenceDate } = input, slots = item.slots;
    const conflict = (slot: string) => issue(item, 'explicit_condition_conflict', slot, 'invalid', 'The prediction contradicts an explicit user condition.');
    for (const [slot, expression] of [['manufacturer', '厂家|生产企业'], ['distributor', '配送商|配送企业'], ['region', '区域|地区'], ['category', '类别'], ['status', '器械状态']] as const) {
      if (new RegExp(`(?:不限|不限制|取消|清除)(?:${expression})`).test(text) && slots[slot] !== null) conflict(slot);
    }
    const percentages = [...text.matchAll(/(\d+(?:\.\d+)?)\s*[%％]/g)];
    if (percentages.length === 1 && slots.threshold !== null) {
      if (slots.threshold.value !== Number(`${percentages[0]![1]}e-2`)) conflict('threshold');
      const comparison = /(?:不超过|大于等于|小于等于|不低于|不少于|至少|至多|超过|大于|高于|低于|小于|不到|>=|<=|≥|≤|>|<)\s*\d+(?:\.\d+)?\s*[%％]/.exec(text)?.[0];
      if (comparison) { const expected = /^(?:大于等于|至少|不低于|不少于|>=|≥)/.test(comparison) ? 'gte'
        : /^(?:不超过|小于等于|至多|<=|≤)/.test(comparison) ? 'lte' : /^(?:低于|小于|不到|<)/.test(comparison) ? 'lt' : 'gt';
        if (slots.threshold.operator !== expected) conflict('threshold'); }
    }
    if (/涨幅|上涨|增加价格/.test(text) && !/跌幅|下降|下跌/.test(text) && slots.direction === 'decrease') conflict('direction');
    if (/跌幅|下降|下跌/.test(text) && !/涨幅|上涨/.test(text) && slots.direction === 'increase') conflict('direction');
    const anchors = [...text.matchAll(/\d{4}-\d{2}-\d{2}|昨天|上个月|今天|前天/g)];
    if (anchors.length === 1 && slots.time !== null && item.l2 !== 'PERIOD_COMPARE') {
      let expected: { start: string; endExclusive: string } | null = null;
      if (anchors[0]![0] === '昨天') expected = { start: new Date(Date.parse(referenceDate + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10), endExclusive: referenceDate };
      else if (anchors[0]![0] === '前天') { const start = new Date(Date.parse(referenceDate + 'T00:00:00Z') - 2 * 86400000).toISOString().slice(0, 10); expected = { start, endExclusive: nextDate(start) }; }
      else if (anchors[0]![0] === '今天') expected = { start: referenceDate, endExclusive: nextDate(referenceDate) };
      else if (anchors[0]![0] === '上个月') { const date = new Date(referenceDate + 'T00:00:00Z'); date.setUTCDate(1); const endExclusive = date.toISOString().slice(0, 10); date.setUTCMonth(date.getUTCMonth() - 1); expected = { start: date.toISOString().slice(0, 10), endExclusive }; }
      else if (currentPurposes.has(item.l2)) { try { expected = { start: anchors[0]![0], endExclusive: nextDate(anchors[0]![0]) }; } catch { conflict('time'); } }
      if (expected && !same(expected, slots.time)) conflict('time');
    }
  }
}
