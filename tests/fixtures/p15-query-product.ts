import { BusinessDataSchema, createQuerySchemas, type BusinessData, type QueryParams } from '../../packages/contracts/src/query';
import { intentCatalogData } from './p14-intent';

// ENGINEERING data: overlapping identifiers in two scopes, missing dates, zero/null prices and mixed units.
export function queryProductData(deviceCount = 502) {
  const seed = intentCatalogData();
  const devices = Array.from({ length: deviceCount }, (_, index) => ({ ...seed.devices[0]!, id: index + 1,
    sourceDeviceId: String(index + 1), sourceSubmissionId: `ENGINEERING-${index + 1}` }));
  const batches = [
    ...seed.batches.map(batch => ({ ...batch, snapshotDate: batch.id === 3 ? '2026-10-11' : batch.snapshotDate })),
    { ...seed.batches[0]!, id: 4, scopeKey: 'ENGINEERING-jiangsu', region: '江苏', previousBatchId: null },
    { ...seed.batches[2]!, id: 5, scopeKey: 'ENGINEERING-jiangsu', region: '江苏', snapshotDate: '2026-10-11', previousBatchId: 4 },
  ].map(batch => ({ ...batch, expectedEntityCount: deviceCount, observedEntityCount: deviceCount - (batch.id === 2 ? 1 : 0),
    declaredMissingDeviceIds: batch.id === 2 ? [deviceCount] : [] }));
  const snapshots = batches.flatMap(batch => devices.filter(device => batch.id !== 2 || device.id !== deviceCount).map(device => ({
    ...seed.snapshots[0]!, id: (batch.id - 1) * deviceCount + device.id, batchId: batch.id, deviceId: device.id,
    deviceName: `ENGINEERING device ${device.id}`, region: batch.region, sourceRowRef: String(device.id),
    unit: device.id % 3 === 0 ? '盒' : '件', status: batch.id === 3 && device.id === 1 ? 'suspended' : 'active', priceCents: device.id === 2 ? null : device.id === 1 && [1, 4].includes(batch.id) ? 0 : 100 + batch.id,
  })));
  const changes: BusinessData['changes'] = [2, 3, 5].map((batchId, index) => {
    const oldBatchId = batches.find(batch => batch.id === batchId)!.previousBatchId!;
    const oldValue = snapshots.find(row => row.batchId === oldBatchId && row.deviceId === 1)!.priceCents!;
    const newValue = snapshots.find(row => row.batchId === batchId && row.deviceId === 1)!.priceCents!;
    return { ...seed.changes[0]!, id: index + 1, deviceId: 1, oldBatchId, newBatchId: batchId, oldValue, newValue,
      deltaCents: newValue - oldValue, ratio: oldValue === 0 ? null : (newValue - oldValue) / oldValue };
  });
  changes.push({ ...changes[1]!, id: 4, field: 'status', oldValue: 'active', newValue: 'suspended', deltaCents: null, ratio: null });
  return BusinessDataSchema.parse({ batches, devices, snapshots, changes });
}

export function queryProductParams(overrides: Partial<QueryParams> = {}): QueryParams {
  return createQuerySchemas().QueryParamsSchema.parse({ kind: 'current', population: 'snapshot', snapshotMode: 'exact_date',
    batchIds: [3], ...overrides });
}
