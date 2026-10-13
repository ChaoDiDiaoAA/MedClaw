import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { csvRows } from './data-format.ts';

export interface SourceRow {
  key: string; device: string; name: string; submission: string; applicant: string; category: string; region: string;
  date: string; price: number | null; status: string; manufacturer: string; distributor: string | null;
}
export interface Target {
  op: 'current' | 'price' | 'status' | 'distributor' | 'events' | 'aggregate' | 'trend' | 'clarify' | 'refuse' | 'unsupported' | 'explain';
  region?: string; regions?: string[]; date?: string; start?: string; endExclusive?: string; device?: string; name?: string; manufacturer?: string;
  category?: string; status?: string; distributor?: string; threshold?: { operator: 'gt' | 'gte'; percent: number };
  group?: 'category' | 'manufacturer' | 'status' | 'region'; metric?: 'count' | 'changed_device_count' | 'change_count' | 'sum_price' | 'mean_price';
  asOf?: boolean; missing?: string[];
}
export async function readAuthoredSource(path: string): Promise<SourceRow[]> {
  return parseAuthoredSource(await readFile(path, 'utf8'));
}
export function parseAuthoredSource(text: string): SourceRow[] {
  const lines = csvRows(text).map(row => row.join('\t'));
  assert.equal(lines.shift(), 'key\tdevice\tname\tsubmission\tapplicant\tcategory\tregion\tdate\tprice\tstatus\tmanufacturer\tdistributor');
  const rows = lines.map(line => {
    const [key, device, name, submission, applicant, category, region, date, price, status, manufacturer, distributor] = line.split('\t');
    assert.ok(key && device && name && submission && applicant && category && region && date && status && manufacturer && distributor !== undefined);
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(price === 'null' || /^\d+$/.test(price!));
    return { key, device, name, submission, applicant, category, region, date, price: price === 'null' ? null : Number(price), status, manufacturer, distributor: distributor === 'null' ? null : distributor } as SourceRow;
  });
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
  return rows;
}
export const scopeKey = (region: string) => `synthetic-${({ 浙江: 'zj', 河南: 'hn', 陕西: 'sx' } as Record<string, string>)[region]}-v1`;
export function semanticConditions(target: Target) {
  const changes = ['price', 'status', 'distributor', 'events'].includes(target.op) || ['change_count', 'changed_device_count'].includes(target.metric ?? '');
  return { region: target.region ?? null, regions: target.regions ?? null, date: target.date ?? null, start: target.start ?? null, endExclusive: target.endExclusive ?? null,
    sourceDeviceId: target.device ?? null, manufacturer: target.manufacturer ?? null, category: target.category ?? null, status: target.status ?? null,
    snapshotMode: changes ? null : target.asOf ? 'as_of' : 'exact_date', threshold: target.threshold ?? null };
}
const entityKey = (row: SourceRow) => `${row.device}@${scopeKey(row.region)}`;
export function independentExpectation(rows: SourceRow[], target: Target) {
  const inRegion = (row: SourceRow) => (!target.region || row.region === target.region) && (!target.regions || target.regions.includes(row.region));
  const dates = [...new Set(rows.filter(inRegion).map(row => row.date))].sort();
  const requested = target.date ?? '2026-10-02';
  const actual = target.asOf ? dates.filter(date => date <= requested).at(-1) ?? null : dates.includes(requested) ? requested : null;
  const matches = (row: SourceRow) => inRegion(row) && (!target.device || row.device === target.device)
    && (!target.name || row.name === target.name) && (!target.manufacturer || row.manufacturer === target.manufacturer)
    && (!target.category || row.category === target.category) && (!target.status || row.status === target.status) && (!target.distributor || row.distributor === target.distributor);
  const semantic = ['clarify', 'refuse', 'unsupported', 'explain'].includes(target.op);
  const snapshot = semantic ? [] : rows.filter(row => row.date === actual && matches(row));
  const events: { key: string; type: string; old: unknown; new: unknown; device: string; region: string; date: string; field: string; oldPrice: number | null; newPrice: number | null; sourceKeys: string[] }[] = [];
  for (let index = 1; index < dates.length; index++) {
    const before = rows.filter(row => row.date === dates[index - 1]), after = rows.filter(row => row.date === dates[index]);
    for (const device of new Set([...before, ...after].filter(row => !target.region || row.region === target.region).map(row => row.device))) {
      const old = before.find(row => row.device === device), next = after.find(row => row.device === device);
      const row = next ?? old!;
      if (!matches(row) || target.start && dates[index]! < target.start || target.endExclusive && dates[index]! >= target.endExclusive) continue;
      if (!old || !next) events.push({ key: `${entityKey(row)}|${dates[index]}|${next ? 'added' : 'missing'}`, type: next ? 'added' : 'missing', old: old ? 'present' : null, new: next ? 'present' : null, device, region: row.region, date: dates[index]!, field: 'presence', oldPrice: old?.price ?? null, newPrice: next?.price ?? null, sourceKeys: [old?.key, next?.key].filter((key): key is string => !!key) });
      else for (const field of ['price', 'status', 'distributor'] as const) if (old[field] !== next[field]) events.push({ key: `${entityKey(row)}|${dates[index]}|${field}`, type: 'field_changed', old: old[field], new: next[field], device, region: row.region, date: dates[index]!, field, oldPrice: old.price, newPrice: next.price, sourceKeys: [old.key, next.key] });
    }
  }
  let selected = events.filter(event => target.op === 'price' ? event.field === 'price' : target.op === 'status' ? event.field === 'status' : target.op === 'distributor' ? event.field === 'distributor' : true);
  if (target.threshold) selected = selected.filter(event => {
    if (event.field !== 'price' || event.oldPrice === null || event.newPrice === null || event.oldPrice === 0 || event.newPrice >= event.oldPrice) return false;
    // Compare integer cross products; displayed percentages never decide a boundary.
    const decrease = BigInt(event.oldPrice - event.newPrice) * 100n, boundary = BigInt(event.oldPrice) * BigInt(target.threshold!.percent);
    return target.threshold!.operator === 'gt' ? decrease > boundary : decrease >= boundary;
  });
  const changing = ['price', 'status', 'distributor', 'events'].includes(target.op);
  const selectedRows = changing ? rows.filter(row => selected.some(event => event.sourceKeys.includes(row.key))) : snapshot;
  const sets = changing ? [...new Set(selected.map(event => `${event.device}@${scopeKey(event.region)}`))].sort() : snapshot.map(entityKey).sort();
  const numeric = snapshot.filter(row => row.price !== null).map(row => ({ id: entityKey(row), value: row.price!, unit: 'CNY cents' }));
  const aggregate = new Map<string, number>();
  if (target.metric === 'change_count' || target.metric === 'changed_device_count') {
    if (target.group) {
      const perGroup = new Map<string, typeof selected>();
      for (const event of selected) { const row = rows.find(row => row.device === event.device && row.date === event.date) ?? rows.find(row => row.device === event.device)!; const key = row[target.group]; perGroup.set(key, [...perGroup.get(key) ?? [], event]); }
      for (const [key, list] of perGroup) aggregate.set(key, target.metric === 'change_count' ? list.length : new Set(list.map(event => event.device)).size);
    } else aggregate.set('all', target.metric === 'change_count' ? selected.length : new Set(selected.map(event => event.device)).size);
  } else if (target.metric === 'sum_price' || target.metric === 'mean_price') {
    const prices = snapshot.map(row => row.price).filter((price): price is number => price !== null);
    aggregate.set('all', target.metric === 'sum_price' ? prices.reduce((sum, price) => sum + price, 0) : prices.reduce((sum, price) => sum + price, 0) / prices.length);
  } else for (const row of snapshot) { const key = target.group ? row[target.group] : 'all'; aggregate.set(key, (aggregate.get(key) ?? 0) + 1); }
  const trend: { date: string; gap: boolean; value: number | null }[] = [];
  if (target.op === 'trend') {
    for (let day = Date.parse(`${target.start}T00:00:00Z`); day < Date.parse(`${target.endExclusive}T00:00:00Z`); day += 86400000) {
      const date = new Date(day).toISOString().slice(0, 10), covered = dates.includes(date);
      const items = rows.filter(row => row.date === date && matches(row));
      const value = target.metric === 'change_count' ? events.filter(event => event.date === date).length : target.metric === 'changed_device_count' ? new Set(events.filter(event => event.date === date).map(event => event.device)).size : items.length;
      trend.push({ date, gap: !covered, value: covered ? value : null });
    }
  }
  return {
    sets, numeric, aggregate: [...aggregate].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key)), trend,
    diff: selected.map(({ key, type, old, new: next }) => ({ key, type, old, new: next })).sort((a, b) => a.key.localeCompare(b.key)),
    rows: snapshot, sourceKeys: [...new Set((selectedRows.length ? selectedRows : rows.filter(row => !target.region || row.region === target.region)).map(row => row.key))],
    interpretation: { requestedDate: requested, actualDataDate: actual, snapshotMode: target.asOf ? 'as_of' : 'exact_date', region: target.region ?? null, scopeKey: target.region ? scopeKey(target.region) : null, isStale: actual === null ? null : actual !== requested, quantityUnit: target.metric?.includes('change') ? target.metric === 'change_count' ? 'events' : 'identifiers' : 'records', nullPriceDeviceIds: snapshot.filter(row => row.price === null).map(entityKey), ratioUnknown: selected.filter(event => event.field === 'price' && (event.oldPrice === null || event.oldPrice === 0)).map(event => event.key) },
  };
}
