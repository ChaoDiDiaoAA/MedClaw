import { createHash } from 'node:crypto';
import { canonicalRequest } from '../../contracts/src/run';
import type { Batch, Change, QueryRecord, Snapshot } from '../../contracts/src/query';
import { WorkspaceSelectionSchema, type WorkspaceSelection } from '../../contracts/src/workspace';

const digest = (value: unknown) => createHash('sha256').update(canonicalRequest(value)).digest('hex');
function identity(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('storage_read_failed');
  return String(value);
}
/** Resolve against the entire saved result, before a caller applies pagination. */
export function queryRowKeys(record: QueryRecord): (string | null)[] {
  const keys = record.rows.map(row => record.kind === 'current' ? `snapshot:${identity(row.snapshotId)}`
    : record.kind === 'changes' ? `change:${identity(row.eventId)}` : `row:${digest(row)}`);
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return keys.map(key => counts.get(key) === 1 ? key : null);
}
export function resolveQueryRow(record: QueryRecord, key: string): QueryRecord['rows'][number] {
  const index = queryRowKeys(record).findIndex(candidate => candidate === key);
  if (index < 0) throw new Error('access_denied');
  return record.rows[index]!;
}
/** Only trusted catalog DTOs and their actual batches may describe a data selection. */
export function describeDataSelection(item: Snapshot | Change, batches: readonly Batch[]): WorkspaceSelection {
  const batch = (id: number) => {
    const found = batches.find(value => value.id === id);
    if (!found) throw new Error('access_denied');
    return { id: found.id, contentHash: found.contentHash };
  };
  return WorkspaceSelectionSchema.parse('batchId' in item
    ? {formatVersion:1,kind:'device',targetId:identity(item.deviceId),targetVersion:batch(item.batchId).contentHash,rowKey:`snapshot:${identity(item.id)}`,field:null}
    : {formatVersion:1,kind:'change',targetId:identity(item.id),targetVersion:digest({oldBatch:batch(item.oldBatchId),newBatch:batch(item.newBatchId),calculationVersion:item.calculationVersion}),rowKey:`change:${identity(item.id)}`,field:null});
}

export function assertSelectionField(object: Record<string, unknown>, field: string | null): void {
  if (field === null) return;
  if (['__proto__','prototype','constructor'].includes(field) || !Object.hasOwn(object, field)) throw new Error('invalid_argument');
  const value = object[field];
  if (!(value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))) throw new Error('invalid_argument');
}
