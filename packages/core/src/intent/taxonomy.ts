import type { IntentSlots, L2 } from '../../../contracts/src/intent';

export interface IntentCapability {
  state: 'conditional' | 'disabled';
  requiredSlots: readonly (keyof IntentSlots)[];
  requiredParameters: readonly string[];
  requiredFields: readonly string[];
  queryKind: 'current' | 'changes' | 'aggregate' | 'trend' | null;
  tools: readonly string[];
  conditions: readonly string[];
}

const capability = (state: IntentCapability['state'], requiredSlots: IntentCapability['requiredSlots'],
  requiredParameters: readonly string[], requiredFields: readonly string[], queryKind: IntentCapability['queryKind'],
  tools: readonly string[], conditions: readonly string[]): IntentCapability =>
  ({ state, requiredSlots, requiredParameters, requiredFields, queryKind, tools, conditions });

// Registration is not admission: validation must prove these conditions against the frozen Scope and installed adapters.
export const INTENT_CAPABILITIES = {
  PRODUCT_SEARCH: capability('conditional', [], [], ['device_id', 'device_name', 'snapshot_date'], 'current',
    ['query_current_devices'], ['unique_scope_region_and_target_date', 'complete_snapshot_coverage']),
  PRODUCT_DETAIL: capability('conditional', ['device'], [], ['device_id', 'snapshot_date'], null,
    ['resolve_device', 'read_device', 'read_source_metadata'], ['unique_device', 'target_date_in_scope']),
  CERT_LOOKUP: capability('disabled', [], ['certificateNumber'], ['certificate_number', 'certificate_status', 'certificate_expiry'], null,
    [], ['certificate_registry_and_source_tool_missing']),
  COMPANY_PROFILE: capability('disabled', ['manufacturer'], [], ['company_profile'], null, [], ['company_profile_source_tool_missing']),
  COMPANY_PRODUCTS: capability('conditional', ['manufacturer'], [], ['manufacturer', 'snapshot_date'], 'current',
    ['list_filter_values', 'query_current_devices'], ['canonical_manufacturer_not_applicant', 'complete_snapshot_coverage']),
  NEW_RECORDS: capability('conditional', ['time', 'changeKind'], [], ['snapshot_date', 'change_kind'], 'changes',
    ['query_device_changes'], ['changeKind=added', 'valid_predecessor_and_complete_coverage']),
  FIELD_CHANGES: capability('conditional', ['time', 'changeKind', 'changeField'], [], ['change_field', 'old_value', 'new_value'], 'changes',
    ['query_device_changes'], ['changeKind=field_changed', 'changeField=price|status|distributor', 'valid_predecessor_and_complete_coverage']),
  PRICE_CHANGE_RANK: capability('disabled', ['time', 'topN', 'sort'], ['rankBy'], ['old_price', 'new_price', 'change_ratio'], null,
    [], ['price_change_ranking_adapter_missing']),
  PRICE_TREND: capability('conditional', ['time', 'metric', 'groupBy'], [], ['price', 'currency', 'unit', 'snapshot_date'], 'trend',
    [], ['validated_program_trend_adapter', 'metric=mean_price|sum_price', 'groupBy=date', 'same_currency_and_unit', 'complete_snapshot_coverage']),
  PRICE_ANOMALY: capability('conditional', ['time', 'direction', 'threshold'], ['method'], ['old_price', 'new_price', 'change_ratio'], 'changes',
    ['query_device_changes'], ['method=explicit_threshold', 'valid_predecessor_and_complete_coverage']),
  CERT_STATUS_CHANGE: capability('disabled', ['time'], [], ['certificate_number', 'certificate_status_history'], null,
    [], ['device_status_is_not_certificate_status', 'certificate_registry_and_source_tool_missing']),
  CERT_EXPIRY_WARNING: capability('disabled', [], ['withinDays'], ['certificate_expiry', 'certificate_status'], null,
    [], ['certificate_registry_and_source_tool_missing']),
  CATEGORY_STATS: capability('conditional', ['metric', 'groupBy'], [], ['category'], 'aggregate', [],
    ['validated_program_aggregate_adapter', 'groupBy=category', 'explicit_population_and_date', 'distinct_count_semantics']),
  REGION_STATS: capability('conditional', ['metric', 'groupBy'], [], ['region'], 'aggregate', [],
    ['validated_program_aggregate_adapter', 'groupBy=region', 'explicit_population_and_date', 'authorized_regions_only']),
  COMPANY_RANK: capability('conditional', ['metric', 'groupBy', 'topN', 'sort'], [], ['manufacturer'], 'aggregate', [],
    ['validated_program_aggregate_adapter', 'groupBy=manufacturer', 'explicit_population_and_date']),
  COMPANY_COMPARE: capability('conditional', ['metric'], ['manufacturers'], ['manufacturer', 'snapshot_date'], null,
    ['query_current_devices', 'query_device_changes', 'read_query', 'list_query_evidence'],
    ['at_least_two_canonical_manufacturers', 'same_population_period_and_units', 'metric_supported_by_actual_tools']),
  PRODUCT_COMPARE: capability('conditional', [], ['devices'], ['device_id', 'snapshot_date'], null,
    ['resolve_device', 'read_device', 'query_device_changes'], ['at_least_two_unique_devices', 'same_population_period_and_units', 'no_certificate_comparison']),
  PERIOD_COMPARE: capability('conditional', ['metric'], ['periods'], ['snapshot_date'], null,
    ['query_current_devices', 'query_device_changes', 'read_query', 'list_query_evidence'],
    ['exactly_two_half_open_periods', 'complete_coverage', 'metric_supported_by_actual_tools']),
  MISSING_FIELDS: capability('disabled', [], ['fields'], ['field_audit'], null, [], ['missing_field_audit_tool_missing']),
  DUPLICATES: capability('disabled', [], ['keyFields'], ['duplicate_audit'], null, [], ['arbitrary_key_duplicate_audit_tool_missing']),
  FRESHNESS: capability('conditional', [], ['basis'], ['snapshot_date'], null, ['read_batch', 'read_source_metadata'],
    ['basis=snapshot_date', 'capture_time_unavailable']),
  MONITOR_REPORT: capability('disabled', ['time'], ['format'], ['query_id', 'evidence_id'], null, [], ['formal_report_service_not_accepted']),
  EXPORT_RESULT: capability('disabled', [], ['format', 'resultRef'], ['query_id', 'result_hash', 'evidence_id'], null, [],
    ['export_service_not_accepted', 'xlsx_requires_separate_implementation_and_acceptance', 'delivery_slots_never_replace_query_context']),
} satisfies Record<L2, IntentCapability>;

export const CONFUSABLE_PAIRS = [
  ['PRICE_CHANGE_RANK', 'PRICE_TREND'], ['NEW_RECORDS', 'CERT_STATUS_CHANGE'],
  ['CERT_EXPIRY_WARNING', 'CERT_STATUS_CHANGE'], ['PRODUCT_DETAIL', 'PRODUCT_COMPARE'],
  ['COMPANY_RANK', 'COMPANY_COMPARE'], ['FRESHNESS', 'CERT_EXPIRY_WARNING'],
] as const satisfies readonly (readonly [L2, L2])[];
