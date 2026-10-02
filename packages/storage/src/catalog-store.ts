import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { PositiveIdSchema } from '../../contracts/src/error';
import { BatchSchema, ChangeSchema, DeviceSchema, QueryRowSchema, SnapshotSchema, type Batch, type CatalogFilters, type CatalogStore, type CatalogSummary, type Change, type Device, type QueryParams, type Snapshot, type SnapshotReference } from '../../contracts/src/query';

type Row = Record<string, unknown>;
type Binding = string | number | null;
const IdsSchema = z.array(PositiveIdSchema).max(10000);
const ids = (values: number[]) => JSON.stringify(IdsSchema.parse(values));
const decode = (value: unknown) => JSON.parse(z.string().parse(value)) as unknown;

export class SqliteCatalogStore implements CatalogStore {
  constructor(private readonly db: Database) {}
  private rows(sql: string, params: Binding[] = []): Row[] {
    try { return this.db.query<Row, Binding[]>(sql).all(...params); }
    catch { throw new Error('storage_read_failed'); }
  }
  private parse<T>(read: () => T): T {
    try { return read(); }
    catch { throw new Error('storage_read_failed'); }
  }
  readRevision() {
    return this.parse(() => z.number().int().nonnegative().parse(this.rows('SELECT revision FROM catalog_state WHERE id=1')[0]?.revision));
  }
  readBatches(values: number[]): Batch[] {
    return this.parse(() => this.rows('SELECT * FROM batches WHERE id IN (SELECT value FROM json_each(?)) ORDER BY scope_key,snapshot_date,id', [ids(values)]).map(row => BatchSchema.parse({
      id: row.id,
      scopeKey: row.scope_key,
      snapshotDate: row.snapshot_date,
      region: row.region,
      coverage: row.coverage,
      previousBatchId: row.previous_batch_id,
      materialVersion: row.material_version,
      sourceBundleId: row.source_bundle_id,
      sourceLockHash: row.source_lock_hash,
      contentHash: row.content_hash,
      cohortHash: row.cohort_hash,
      catalogRevision: row.catalog_revision,
      expectedEntityCount: row.expected_entity_count,
      observedEntityCount: row.observed_entity_count,
      declaredMissingDeviceIds: decode(row.declared_missing_json),
    })));
  }
  readDevices(values: number[]): Device[] {
    return this.parse(() => this.rows('SELECT * FROM devices WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id', [ids(values)]).map(row => DeviceSchema.parse({
      id: row.id,
      sourceDeviceId: row.source_device_id,
      sourceBundleId: row.source_bundle_id,
      sourceSubmissionId: row.source_submission_id,
      sourceApplicant: row.source_applicant,
      sourceRefs: decode(row.source_refs_json),
    })));
  }
  private snapshot(row: Row): Snapshot {
    return SnapshotSchema.parse({
      id: row.id,
      batchId: row.batch_id,
      deviceId: row.device_id,
      deviceName: row.device_name,
      category: row.category,
      region: row.region,
      priceCents: row.price_cents,
      currency: row.currency,
      unit: row.unit,
      status: row.status,
      manufacturer: row.manufacturer,
      distributor: row.distributor,
      sourceRowRef: row.source_row_ref,
      sourceRefs: decode(row.source_refs_json),
      fieldOrigins: decode(row.field_origins_json),
    });
  }
  private filters(filters: CatalogFilters, expression: (column: string) => string, clauses: string[], params: Binding[]) {
    for (const [field, column] of [['region', 'region'], ['manufacturer', 'manufacturer'], ['category', 'category'], ['distributor', 'distributor'], ['status', 'status']] as const) {
      if (filters[field] != null) {
        clauses.push(`${expression(column)}=?`);
        params.push(filters[field]);
      }
    }
    if (filters.deviceIds !== undefined && filters.deviceIds !== null) {
      clauses.push(`${expression('device_id')} IN (SELECT value FROM json_each(?))`);
      params.push(ids(filters.deviceIds));
    }
  }
  private snapshotSelection(batchIds: number[], deviceIds: number[] | null, filters: CatalogFilters) {
      const params: Binding[] = [ids(batchIds)];
      const clauses = ['s.batch_id IN (SELECT value FROM json_each(?))'];
      if (deviceIds !== null) { clauses.push('s.device_id IN (SELECT value FROM json_each(?))'); params.push(ids(deviceIds)); }
      this.filters(filters, column => `s.${column}`, clauses, params);
      return { from: `FROM snapshots s JOIN batches b ON b.id=s.batch_id WHERE ${clauses.join(' AND ')}`, params };
  }
  readSnapshots(batchIds: number[], deviceIds: number[] | null, filters: CatalogFilters = {}): Snapshot[] {
    return this.parse(() => {
      const selected = this.snapshotSelection(batchIds, deviceIds, filters);
      return this.rows(`SELECT s.* ${selected.from} ORDER BY s.device_id,b.scope_key,b.snapshot_date,s.id`, selected.params).map(row => this.snapshot(row));
    });
  }
  private changeSelection(newBatchIds: number[], oldBatchIds: number[], deviceIds: number[] | null, filters: CatalogFilters) {
      const params: Binding[] = [ids(newBatchIds), ids(oldBatchIds)];
      const clauses = ['e.new_batch_id IN (SELECT value FROM json_each(?))', 'e.old_batch_id IN (SELECT value FROM json_each(?))'];
      if (deviceIds !== null) { clauses.push('e.device_id IN (SELECT value FROM json_each(?))'); params.push(ids(deviceIds)); }
      this.filters(filters, column => column === 'device_id' ? 'e.device_id' : `CASE WHEN n.id IS NOT NULL THEN n.${column} ELSE o.${column} END`, clauses, params);
      for (const [field, column] of [['changeKind', 'kind'], ['changeField', 'field']] as const) {
        if (filters[field] != null) { clauses.push(`e.${column}=?`); params.push(filters[field]); }
      }
      if (filters.direction) clauses.push(`o.price_cents IS NOT NULL AND n.price_cents IS NOT NULL AND (n.price_cents-o.price_cents)${filters.direction === 'increase' ? '>' : '<'}0`);
      if (filters.threshold) {
        const operator = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[filters.threshold.operator];
        clauses.push(`o.price_cents>0 AND n.price_cents IS NOT NULL AND ABS(CAST(n.price_cents-o.price_cents AS REAL)/o.price_cents)${operator}?`);
        params.push(filters.threshold.value);
      }
      return { from: `FROM change_events e JOIN batches b ON b.id=e.new_batch_id
        LEFT JOIN snapshots o ON o.batch_id=e.old_batch_id AND o.device_id=e.device_id
        LEFT JOIN snapshots n ON n.batch_id=e.new_batch_id AND n.device_id=e.device_id
        WHERE ${clauses.join(' AND ')}`, params };
  }
  readChanges(newBatchIds: number[], oldBatchIds: number[], deviceIds: number[] | null, filters: CatalogFilters = {}): Change[] {
    return this.parse(() => {
      const selected = this.changeSelection(newBatchIds, oldBatchIds, deviceIds, filters);
      return this.rows(`SELECT e.* ${selected.from} ORDER BY b.snapshot_date,e.device_id,b.scope_key,e.field,e.id`, selected.params).map(row => ChangeSchema.parse({
          id: row.id,
          deviceId: row.device_id,
          oldBatchId: row.old_batch_id,
          newBatchId: row.new_batch_id,
          kind: row.kind,
          field: row.field,
          oldValue: row.old_value_json === null ? null : decode(row.old_value_json),
          newValue: row.new_value_json === null ? null : decode(row.new_value_json),
          deltaCents: row.delta_cents,
          ratio: row.ratio,
          calculationVersion: row.calculation_version,
        }));
    });
  }
  readSnapshot(id: number): Snapshot | null {
    return this.parse(() => {
      const row = this.rows('SELECT * FROM snapshots WHERE id=?', [PositiveIdSchema.parse(id)])[0];
      return row ? this.snapshot(row) : null;
    });
  }
  readSnapshotsById(values: number[]): Snapshot[] {
    return this.parse(() => this.rows('SELECT * FROM snapshots WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
      [JSON.stringify(z.array(PositiveIdSchema).max(200000).parse(values))]).map(row => this.snapshot(row)));
  }
  readSnapshotReferences(values: number[]): SnapshotReference[] {
    return this.parse(() => this.rows('SELECT id,batch_id,device_id,source_row_ref FROM snapshots WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
      [JSON.stringify(z.array(PositiveIdSchema).max(200000).parse(values))]).map(row => ({
        id: PositiveIdSchema.parse(row.id),
        batchId: PositiveIdSchema.parse(row.batch_id),
        deviceId: PositiveIdSchema.parse(row.device_id),
        sourceRowRef: z.string().parse(row.source_row_ref),
      })));
  }
  summarize(input: QueryParams, batchIds: number[], allowedOldBatchIds: number[], deviceIds: number[] | null): CatalogSummary {
    return this.parse(() => {
      const snapshot = input.population === 'snapshot';
      const selected = snapshot ? this.snapshotSelection(batchIds, deviceIds, input) : this.changeSelection(batchIds, allowedOldBatchIds, deviceIds, input);
      const expression = (column: string) => snapshot ? `s.${column}` : `CASE WHEN n.id IS NOT NULL THEN n.${column} ELSE o.${column} END`;
      const dimensions: { key: string; expression: string }[] = [];
      if (input.kind === 'trend' || input.groupBy === 'date') dimensions.push({ key: 'date', expression: 'b.snapshot_date' });
      if (input.groupBy && input.groupBy !== 'date') dimensions.push({ key: input.groupBy, expression: expression(input.groupBy) });
      const price = input.metric === 'sum_price' || input.metric === 'mean_price';
      if (price) dimensions.push({ key: 'currency', expression: 's.currency' }, { key: 'priceUnit', expression: 's.unit' });
      const select = dimensions.map(dimension => `${dimension.expression} AS "${dimension.key}"`);
      const grouping = dimensions.length ? `GROUP BY ${dimensions.map(dimension => dimension.expression).join(',')}` : '';
      const measure = input.metric === 'count' ? 'COUNT(DISTINCT json_array(s.device_id,b.scope_key))'
        : input.metric === 'changed_device_count' ? 'COUNT(DISTINCT json_array(e.device_id,b.scope_key))'
        : input.metric === 'change_count' ? 'COUNT(*)' : input.metric === 'sum_price' ? 'SUM(s.price_cents)' : 'AVG(s.price_cents)';
      select.push(`${measure} AS value`, 'COUNT(*) AS matchedRows');
      if (price) select.push('COUNT(s.price_cents) AS validCount', 'COALESCE(SUM(CASE WHEN s.price_cents=0 THEN 1 ELSE 0 END),0) AS zeroCount', 'COALESCE(SUM(CASE WHEN s.price_cents IS NULL THEN 1 ELSE 0 END),0) AS missingCount');
      const rows = this.rows(`SELECT ${select.join(',')} ${selected.from} ${grouping}`, selected.params).map(row => QueryRowSchema.parse({
        ...row,
        metric: input.metric,
        unit: input.metric === 'change_count' ? 'events' : price ? 'cents' : 'devices',
      }));
      if (rows.some(row => typeof row.value === 'number' && (input.metric === 'sum_price' || input.metric === 'count' || input.metric === 'change_count' || input.metric === 'changed_device_count') && !Number.isSafeInteger(row.value))) throw new Error('storage_read_failed');
      const references = this.rows(snapshot ? `SELECT s.id AS snapshotId ${selected.from} ORDER BY s.id`
        : `SELECT e.id AS eventId,o.id AS oldSnapshotId,n.id AS newSnapshotId ${selected.from} ORDER BY e.id`, selected.params);
      return { rows, snapshotIds: [...new Set(references.flatMap(row => snapshot ? [PositiveIdSchema.parse(row.snapshotId)]
        : [row.oldSnapshotId, row.newSnapshotId].filter((id): id is number => typeof id === 'number')))],
        eventIds: snapshot ? [] : references.map(row => PositiveIdSchema.parse(row.eventId)) };
    });
  }
  readSnapshotFor(batchId: number, deviceId: number): Snapshot | null {
    return this.parse(() => {
      const row = this.rows('SELECT * FROM snapshots WHERE batch_id=? AND device_id=?', [PositiveIdSchema.parse(batchId), PositiveIdSchema.parse(deviceId)])[0];
      return row ? this.snapshot(row) : null;
    });
  }
}
