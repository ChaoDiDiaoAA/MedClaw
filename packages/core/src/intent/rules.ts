import { createHash } from 'node:crypto';
import { IntentInputProjectionSchema, IntentResultSchema, IntentSlotsSchema, RuleEvaluationSchema, TimeRangeSchema, INTENT_VERSIONS,
  type IntentInputProjection, type IntentResult } from '../../../contracts/src/intent';
import { canonicalRequest } from '../../../contracts/src/run';
import { nextDate } from '../data/catalog-service';

export function evaluateIntentRules(raw: IntentInputProjection, checkedAt: string) {
  const input = IntentInputProjectionSchema.parse(raw), matches: { ruleId: string; result: IntentResult }[] = [];
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const emptySlots = () => IntentSlotsSchema.parse(Object.fromEntries(Object.keys(IntentSlotsSchema.shape).map(key => [key, null])));
  for (const region of new Set(input.availableData.regions)) {
    const current = new RegExp(`^(?:请)?查询(\\d{4}-\\d{2}-\\d{2})在${escape(region)}的全部医疗器械[。]?$`).exec(input.text);
    const changes = new RegExp(`^(?:请)?查询(\\d{4}-\\d{2}-\\d{2})至(\\d{4}-\\d{2}-\\d{2})在${escape(region)}的全部新增医疗器械[。]?$`).exec(input.text);
    if (!current && !changes) continue;
    try {
      const time = TimeRangeSchema.parse({ start: current?.[1] ?? changes![1], endExclusive: nextDate(current?.[1] ?? changes![2]!) });
      const result = IntentResultSchema.parse({ contract: 'medclaw.intent/v2', status: 'RESOLVED',
        intents: [{ id: 's1', l0: current ? 'BASIC_INFO' : 'CHANGE_MONITOR', l1: current ? 'PRODUCT_INFO' : 'RECORD_CHANGE',
          l2: current ? 'PRODUCT_SEARCH' : 'NEW_RECORDS', slots: { ...emptySlots(), region, time, changeKind: current ? null : 'added' },
          parameters: {}, dependsOn: [], resultRef: null }], candidateIntents: [], clarification: null });
      matches.push({ ruleId: current ? 'current.all.exact' : 'added.period.exact', result });
    } catch { /* An invalid calendar or incomplete match is never a rule hit. */ }
  }
  const unique = [...new Map(matches.map(match => [canonicalRequest(match.result), match])).values()];
  return { evaluation: RuleEvaluationSchema.parse({ ruleVersion: INTENT_VERSIONS.ruleVersion,
    ruleId: unique.length === 1 ? unique[0]!.ruleId : null, inputHash: createHash('sha256').update(canonicalRequest(input)).digest('hex'),
    outcome: unique.length === 1 ? 'hit' : unique.length ? 'conflict' : 'miss',
    reasonCode: unique.length === 1 ? 'complete_match' : unique.length ? 'conflicting_complete_matches' : 'no_complete_match', checkedAt }),
    result: unique.length === 1 ? unique[0]!.result : null };
}
