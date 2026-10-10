import { expect, test } from 'bun:test';
import { INTENT_TAXONOMY } from '../../packages/contracts/src/intent';
import { INTENT_CAPABILITIES, CONFUSABLE_PAIRS } from '../../packages/core/src/intent/taxonomy';

test('p14 every registered leaf has explicit parameters, fields, real calculation/tool and activation conditions', () => {
  expect(Object.keys(INTENT_CAPABILITIES).sort()).toEqual(Object.keys(INTENT_TAXONOMY).sort());
  const tools = new Set(['read_data_scope', 'list_batches', 'read_batch', 'check_data_coverage', 'list_filter_values',
    'resolve_device', 'read_device', 'query_current_devices', 'query_device_changes', 'read_query', 'read_query_page',
    'list_query_evidence', 'read_query_evidence', 'read_evidence_rows', 'read_source_metadata']);
  for (const capability of Object.values(INTENT_CAPABILITIES)) {
    expect(capability.requiredFields.length).toBeGreaterThan(0);
    expect(capability.conditions.length).toBeGreaterThan(0);
    expect(capability.requiredSlots).toBeArray();
    expect(capability.requiredParameters).toBeArray();
    for (const tool of capability.tools) expect(tools.has(tool)).toBe(true);
    if (capability.state === 'conditional') expect(capability.queryKind !== null || capability.tools.length > 0).toBe(true);
  }
});

test('p14 registered labels never activate nonexistent certificate, audit, export or ranking capabilities', () => {
  for (const leaf of ['CERT_LOOKUP', 'COMPANY_PROFILE', 'PRICE_CHANGE_RANK', 'CERT_STATUS_CHANGE', 'CERT_EXPIRY_WARNING',
    'MISSING_FIELDS', 'DUPLICATES', 'MONITOR_REPORT', 'EXPORT_RESULT'] as const) {
    expect(INTENT_CAPABILITIES[leaf].state).toBe('disabled');
  }
  expect(INTENT_CAPABILITIES.PRICE_ANOMALY.conditions).toContain('method=explicit_threshold');
  expect(INTENT_CAPABILITIES.FRESHNESS.conditions).toContain('basis=snapshot_date');
  expect(INTENT_CAPABILITIES.PRICE_TREND.queryKind).toBe('trend');
  expect(INTENT_CAPABILITIES.PRICE_TREND.tools).toEqual([]);
});

test('p14 six confusion pairs use registered distinct leaves', () => {
  expect(CONFUSABLE_PAIRS).toHaveLength(6);
  expect(new Set(CONFUSABLE_PAIRS.map(pair => [...pair].sort().join(':'))).size).toBe(6);
  for (const [left, right] of CONFUSABLE_PAIRS) {
    expect(left).not.toBe(right);
    expect(Object.hasOwn(INTENT_TAXONOMY, left) && Object.hasOwn(INTENT_TAXONOMY, right)).toBe(true);
  }
});
