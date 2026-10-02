import { createHash } from 'node:crypto';
import { canonicalRequest } from '../../../contracts/src/run';
import type { DiffEvent } from '../../../contracts/src/data';
import type { Snapshot } from '../../../contracts/src/query';

export const DIFF_CALCULATION_VERSION = 'medclaw.diff/v1';
export class DiffService {
  compare(oldRows: Snapshot[], newRows: Snapshot[], oldBatchId: number, newBatchId: number): DiffEvent[] {
    if (oldBatchId === newBatchId) throw new Error('input_invalid');
    const oldById = new Map(oldRows.map(row => [row.deviceId, row]));
    const newById = new Map(newRows.map(row => [row.deviceId, row]));
    const events: DiffEvent[] = [];
    const add = (deviceId: number, kind: DiffEvent['kind'], field: DiffEvent['field'], oldValue: DiffEvent['oldValue'], newValue: DiffEvent['newValue']) => {
      const price = field === 'price' && typeof oldValue === 'number' && typeof newValue === 'number';
      events.push({ eventKey: createHash('sha256').update(canonicalRequest([oldBatchId, newBatchId, deviceId, kind, field, DIFF_CALCULATION_VERSION])).digest('hex'), deviceId, oldBatchId, newBatchId, kind, field, oldValue, newValue, deltaCents: price ? newValue - oldValue : null, ratio: price && oldValue !== 0 ? (newValue - oldValue) / oldValue : null, calculationVersion: DIFF_CALCULATION_VERSION });
    };
    for (const deviceId of [...new Set([...oldById.keys(), ...newById.keys()])].sort((a, b) => a - b)) {
      const old = oldById.get(deviceId), next = newById.get(deviceId);
      if (!old) { add(deviceId, 'added', null, null, null); continue; }
      if (!next) { add(deviceId, 'missing', null, null, null); continue; }
      for (const [field, key] of [['price', 'priceCents'], ['status', 'status'], ['distributor', 'distributor']] as const) if (old[key] !== next[key]) add(deviceId, 'field_changed', field, old[key], next[key]);
    }
    return events;
  }
}
