import { equal, ratio, record, unknown } from './rules.ts';
import type { CheckSpec, RuleResult } from './types.ts';

const fields = ['region', 'regions', 'date', 'start', 'endExclusive', 'sourceDeviceId', 'manufacturer', 'category', 'status', 'snapshotMode', 'threshold'];
const regions = (value: unknown): value is string[] | null => value === null || Array.isArray(value) && value.length > 0 && value.every(region => typeof region === 'string' && region.length > 0) && new Set(value).size === value.length;

export function queryConditions(expected: unknown, actual: unknown, check: CheckSpec): RuleResult {
  if (!record(expected) || !record(actual) || !fields.every(field => Object.hasOwn(expected, field) && Object.hasOwn(actual, field))) return unknown('Independent Gold and original Query conditions require every declared filter field');
  if (!regions(expected.regions)) return unknown('Independent Gold regions are malformed or duplicated');
  if (!regions(actual.regions)) return { ...ratio(0, 1, check), reason: 'Observed Query regions are malformed or duplicated' };
  // Region identity is unordered. Every other field and the complete object key set remain strict.
  const normalize = (value: Record<string, any>) => ({ ...value, regions: value.regions === null ? null : [...value.regions].sort() });
  return ratio(Number(equal(normalize(expected), normalize(actual))), 1, check);
}
