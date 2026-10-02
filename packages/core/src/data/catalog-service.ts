import { z } from "zod";
import { PositiveIdSchema } from "../../../contracts/src/error";
import { BusinessDataSchema, BusinessDateSchema, PageSchema, TimeRangeSchema, type Batch, type BusinessData, type CatalogFilters, type CatalogStore, type Device, type PageInput, type QueryContext, type QueryParams, type Snapshot, type SnapshotReference } from "../../../contracts/src/query";
import { RunScopeSchema } from "../../../contracts/src/run";
import { TimezoneSchema } from "../../../contracts/src/model";
import { ToolContextIdentitySchema, type ToolExecutionContext } from "../../../contracts/src/tool";

export function pageItems<T>(items: T[], input: PageInput) {
  const { page, pageSize } = PageSchema.parse({ page: input.page, pageSize: input.pageSize });
  return { items: structuredClone(items.slice((page - 1) * pageSize, page * pageSize)), totalRows: items.length, page, pageSize };
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
}
const inRange = (date: string, time: z.infer<typeof TimeRangeSchema>) => date >= time.start && date < time.endExclusive;
export function nextDate(date: string): string { return new Date(Date.parse(`${BusinessDateSchema.parse(date)}T00:00:00Z`) + 86400000).toISOString().slice(0, 10); }

/** Immutable, validated imported facts; importing and changing workspace selection remain product commands. */
export class CatalogService {
  private readonly data: BusinessData;
  private readonly batchById: Map<number, Batch>;
  private readonly deviceById: Map<number, Device>;
  private readonly snapshotById: Map<number, Snapshot>;
  private readonly snapshotByPair = new Map<string, Snapshot>();
  private readonly store: CatalogStore | null;
  constructor(data: BusinessData | CatalogStore) {
    this.store = 'readBatches' in data ? data : null;
    this.data = this.store ? { batches: [], devices: [], snapshots: [], changes: [] } : BusinessDataSchema.parse(data);
    const unique = <T extends { id: number }>(items: T[]) => {
      const map = new Map(items.map(item => [item.id, item]));
      if (map.size !== items.length) throw new Error("input_invalid");
      return map;
    };
    this.batchById = unique(this.data.batches); this.deviceById = unique(this.data.devices); this.snapshotById = unique(this.data.snapshots);
    if (this.store) return;
    unique(this.data.changes);
    const sourceDeviceKeys = new Set<string>(), snapshotDevices = new Map<number, number[]>(), eventKeys = new Set<string>();
    for (const device of this.data.devices) {
      const key = JSON.stringify([device.sourceBundleId, device.sourceDeviceId]);
      if (sourceDeviceKeys.has(key)) throw new Error("input_invalid"); sourceDeviceKeys.add(key);
    }
    for (const snapshot of this.data.snapshots) {
      const key = `${snapshot.batchId}:${snapshot.deviceId}`, batch = this.batchById.get(snapshot.batchId);
      if (!batch || !this.deviceById.has(snapshot.deviceId) || batch.region !== snapshot.region
        || this.deviceById.get(snapshot.deviceId)!.sourceBundleId !== batch.sourceBundleId || this.snapshotByPair.has(key)) throw new Error("input_invalid");
      this.snapshotByPair.set(key, snapshot);
      const ids = snapshotDevices.get(snapshot.batchId) ?? []; ids.push(snapshot.deviceId); snapshotDevices.set(snapshot.batchId, ids);
    }
    for (const change of this.data.changes) {
      const old = this.batchById.get(change.oldBatchId), next = this.batchById.get(change.newBatchId);
      if (!old || !next || !this.deviceById.has(change.deviceId) || old.scopeKey !== next.scopeKey || old.snapshotDate >= next.snapshotDate
        || next.previousBatchId !== old.id) throw new Error("input_invalid");
      const oldRow = this.snapshotByPair.get(`${old.id}:${change.deviceId}`), newRow = this.snapshotByPair.get(`${next.id}:${change.deviceId}`);
      const key = JSON.stringify([change.oldBatchId, change.newBatchId, change.deviceId, change.kind, change.field]);
      if (eventKeys.has(key) || change.kind !== "field_changed" && change.field !== null) throw new Error("input_invalid"); eventKeys.add(key);
      if (change.kind === "added" ? !!oldRow || !newRow : change.kind === "missing" ? !oldRow || !!newRow : !oldRow || !newRow || change.field === null)
        throw new Error("input_invalid");
      if (change.kind === "field_changed") {
        const field = change.field === "price" ? "priceCents" : change.field!;
        if (oldRow![field] !== change.oldValue || newRow![field] !== change.newValue || change.oldValue === change.newValue) throw new Error("input_invalid");
      }
    }
    const scopeDates = new Set<string>(), groups = new Map<string, Batch[]>();
    for (const batch of this.data.batches) {
      const key = `${batch.scopeKey}:${batch.snapshotDate}`;
      if (scopeDates.has(key) || (snapshotDevices.get(batch.id)?.length ?? 0) !== batch.observedEntityCount) throw new Error("input_invalid");
      scopeDates.add(key);
      const group = groups.get(batch.scopeKey) ?? []; group.push(batch); groups.set(batch.scopeKey, group);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
      const first = group[0]!, cohort = this.data.devices.filter(device => device.sourceBundleId === first.sourceBundleId).map(device => device.id);
      for (const [index, batch] of group.entries()) {
        if (batch.sourceBundleId !== first.sourceBundleId || batch.sourceLockHash !== first.sourceLockHash || batch.region !== first.region
          || batch.cohortHash !== first.cohortHash || batch.expectedEntityCount !== cohort.length || batch.observedEntityCount > batch.expectedEntityCount
          || batch.previousBatchId !== (index === 0 ? null : group[index - 1]!.id)) throw new Error("input_invalid");
        const observed = snapshotDevices.get(batch.id) ?? [], missing = batch.declaredMissingDeviceIds;
        if (new Set(missing).size !== missing.length || missing.some(id => !cohort.includes(id) || observed.includes(id))
          || observed.length + missing.length !== cohort.length) throw new Error("input_invalid");
      }
    }
    freeze(this.data);
  }

  assertContext(context: QueryContext) {
    if ('nativeToolCallId' in context) ToolContextIdentitySchema.parse(context);
    else {
      PositiveIdSchema.parse(context.runId); PositiveIdSchema.parse(context.sessionId); RunScopeSchema.parse(context.scope);
      z.enum(['agent_tool', 'user_form', 'intent']).parse(context.source); z.string().min(1).max(512).parse(context.callRef);
      if (context.inputId !== null) throw new Error('invalid_argument');
      TimezoneSchema.parse(context.timezone);
    }
    BusinessDateSchema.parse(context.referenceDate); context.signal.throwIfAborted();
    if (this.store) {
      const batches = context.scope.batchIds.filter(id => !this.batchById.has(id));
      if (batches.length) for (const batch of this.store.readBatches(batches)) this.batchById.set(batch.id, batch);
      const devices = context.scope.deviceIds?.filter(id => !this.deviceById.has(id)) ?? [];
      if (devices.length) for (const device of this.store.readDevices(devices)) this.deviceById.set(device.id, device);
    }
    if (context.scope.batchIds.some(id => !this.batchById.has(id)) || context.scope.deviceIds?.some(id => !this.deviceById.has(id))) throw new Error("access_denied");
  }
  revision() { return this.store?.readRevision() ?? Math.max(0, ...this.data.batches.map(batch => batch.catalogRevision)); }
  private batch(id: number) { return this.batchById.get(id) ?? this.store?.readBatches([id])[0]; }
  private device(id: number) {
    const existing = this.deviceById.get(id);
    if (existing) return existing;
    const device = this.store?.readDevices([id])[0];
    if (device) this.deviceById.set(id, device);
    return device;
  }
  batches(ids: number[], context: QueryContext): Batch[] {
    this.assertContext(context);
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !context.scope.batchIds.includes(id))) throw new Error("access_denied");
    ids.forEach(id => PositiveIdSchema.parse(id));
    const rows = ids.map(id => this.batchById.get(id)!);
    if (rows.length !== ids.length) throw new Error('access_denied');
    return rows.sort((a, b) => a.scopeKey.localeCompare(b.scopeKey) || a.snapshotDate.localeCompare(b.snapshotDate) || a.id - b.id);
  }
  snapshots(ids: number[], context: QueryContext, filters: CatalogFilters = {}) {
    this.batches(ids, context);
    if (this.store) return this.store.readSnapshots(ids, context.scope.deviceIds, filters);
    return this.data.snapshots.filter(row => ids.includes(row.batchId) && (context.scope.deviceIds === null || context.scope.deviceIds.includes(row.deviceId)));
  }
  changes(ids: number[], context: QueryContext, filters: CatalogFilters = {}) {
    this.batches(ids, context);
    if (this.store) return this.store.readChanges(ids, context.scope.batchIds, context.scope.deviceIds, filters);
    return this.data.changes.filter(row => ids.includes(row.newBatchId) && context.scope.batchIds.includes(row.oldBatchId)
      && (context.scope.deviceIds === null || context.scope.deviceIds.includes(row.deviceId)));
  }
  snapshot(id: number, context: QueryContext) {
    return this.snapshotRows([PositiveIdSchema.parse(id)], context)[0]!;
  }
  snapshotRows(ids: number[], context: QueryContext): Snapshot[] {
    this.assertContext(context);
    const rows = this.store ? this.store.readSnapshotsById(ids) : ids.map(id => this.snapshotById.get(PositiveIdSchema.parse(id))).filter((row): row is Snapshot => !!row);
    if (rows.length !== new Set(ids).size || rows.some(row => !context.scope.batchIds.includes(row.batchId)
      || context.scope.deviceIds !== null && !context.scope.deviceIds.includes(row.deviceId))) throw new Error('access_denied');
    const byId = new Map(rows.map(row => [row.id, row]));
    return ids.map(id => byId.get(id)!);
  }
  snapshotReferences(ids: number[], context: QueryContext): SnapshotReference[] {
    this.assertContext(context);
    const rows = this.store ? this.store.readSnapshotReferences(ids) : ids.map(id => this.snapshotById.get(id)).filter((row): row is Snapshot => !!row);
    if (rows.length !== new Set(ids).size || rows.some(row => !context.scope.batchIds.includes(row.batchId)
      || context.scope.deviceIds !== null && !context.scope.deviceIds.includes(row.deviceId))) throw new Error('access_denied');
    return rows.map(({ id, batchId, deviceId, sourceRowRef }) => ({ id, batchId, deviceId, sourceRowRef }));
  }
  summarize(params: QueryParams, batchIds: number[], context: QueryContext) {
    this.assertContext(context);
    if (batchIds.length) this.batches(batchIds, context);
    return this.store?.summarize(params, batchIds, context.scope.batchIds, context.scope.deviceIds) ?? null;
  }
  snapshotFor(batchId: number, deviceId: number, context: QueryContext) {
    this.batches([batchId], context);
    if (context.scope.deviceIds !== null && !context.scope.deviceIds.includes(deviceId)) throw new Error("access_denied");
    return this.store ? this.store.readSnapshotFor(batchId, deviceId) : this.snapshotByPair.get(`${batchId}:${deviceId}`) ?? null;
  }
  readScope(context: ToolExecutionContext) {
    this.assertContext(context); return structuredClone({ scope: context.scope, referenceDate: context.referenceDate, timezone: context.timezone });
  }
  listBatches(input: PageInput & { time?: z.infer<typeof TimeRangeSchema> }, context: ToolExecutionContext) {
    this.assertContext(context); const time = input.time && TimeRangeSchema.parse(input.time);
    const batches = context.scope.batchIds.length ? this.batches(context.scope.batchIds, context) : [];
    return pageItems(batches.filter(batch => !time || inRange(batch.snapshotDate, time)), input);
  }
  readBatch(batchId: number, context: ToolExecutionContext) { return structuredClone(this.batches([batchId], context)[0]!); }
  selectBatches(ids: number[], time: z.infer<typeof TimeRangeSchema> | undefined, mode: "exact_date" | "as_of", context: QueryContext, region?: string) {
    const all = this.batches(ids, context).filter(batch => region === undefined || batch.region === region), target = time ? TimeRangeSchema.parse(time) : { start: context.referenceDate, endExclusive: nextDate(context.referenceDate) };
    if (mode === "exact_date" && nextDate(target.start) !== target.endExclusive) throw new Error("invalid_argument");
    const selected: Batch[] = [];
    for (const scopeKey of new Set(all.map(batch => batch.scopeKey))) {
      const candidates = all.filter(batch => batch.scopeKey === scopeKey && (mode === "exact_date" ? batch.snapshotDate === target.start : batch.snapshotDate < target.endExclusive));
      const batch = candidates.at(-1);
      if (!batch) throw new Error("data_coverage_missing");
      selected.push(batch);
    }
    return selected;
  }
  checkCoverage(input: { time: z.infer<typeof TimeRangeSchema>; snapshotMode: "exact_date" | "as_of"; requirePredecessor: boolean }, context: ToolExecutionContext) {
    this.assertContext(context); const time = TimeRangeSchema.parse(input.time), all = context.scope.batchIds.length ? this.batches(context.scope.batchIds, context) : [];
    const selected = new Map<number, Batch>(), missingDates = new Set<string>();
    for (const scopeKey of new Set(all.map(batch => batch.scopeKey))) {
      const group = all.filter(batch => batch.scopeKey === scopeKey);
      if (input.snapshotMode === "as_of") {
        const batch = group.filter(batch => batch.snapshotDate < time.endExclusive).at(-1);
        if (batch) selected.set(batch.id, batch); else missingDates.add(new Date(Date.parse(`${time.endExclusive}T00:00:00Z`) - 86400000).toISOString().slice(0, 10));
      } else for (let date = time.start; date < time.endExclusive; date = nextDate(date)) {
        const batch = group.find(batch => batch.snapshotDate === date);
        if (batch) selected.set(batch.id, batch); else missingDates.add(date);
      }
    }
    if (!all.length) missingDates.add(time.start);
    const missingPredecessorBatchIds = [...new Set([...selected.values()].filter(batch => input.requirePredecessor && batch.previousBatchId !== null && !context.scope.batchIds.includes(batch.previousBatchId)).map(batch => batch.previousBatchId!))].sort((a, b) => a - b);
    return { batchIds: [...selected.keys()].sort((a, b) => a - b), missingDates: [...missingDates].sort(), missingPredecessorBatchIds,
      complete: all.length > 0 && missingDates.size === 0 && missingPredecessorBatchIds.length === 0 && (!input.requirePredecessor || [...selected.values()].every(batch => batch.previousBatchId !== null)) };
  }
  listFilterValues(input: PageInput & { field: "manufacturer" | "distributor" | "category" | "status" | "region"; batchIds: number[] }, context: ToolExecutionContext) {
    const values = [...new Set(this.snapshots(input.batchIds, context).map(row => row[input.field]).filter((value): value is string => value !== null))].sort();
    const page = pageItems(values, input); return { values: page.items, totalRows: page.totalRows, page: page.page, pageSize: page.pageSize };
  }
  resolveDevice(input: PageInput & { text: string; matchBy: "name" | "source_id" | "submission_id" }, context: ToolExecutionContext) {
    this.assertContext(context); const text = z.string().trim().min(1).max(512).parse(input.text).toLocaleLowerCase("en-US");
    const available = context.scope.batchIds.length ? this.snapshots(context.scope.batchIds, context) : [];
    const ids = [...new Set(available.filter(row => {
      const device = this.device(row.deviceId)!;
      const candidate = input.matchBy === "name" ? row.deviceName : input.matchBy === "source_id" ? device.sourceDeviceId : device.sourceSubmissionId;
      return input.matchBy === "name" ? candidate.toLocaleLowerCase("en-US").includes(text) : candidate.toLocaleLowerCase("en-US") === text;
    }).map(row => row.deviceId))].sort((a, b) => a - b);
    const page = pageItems(ids.map(id => this.readDevice(id, context)), input);
    return { resolution: ids.length === 0 ? "none" as const : ids.length === 1 ? "unique" as const : "ambiguous" as const, ...page };
  }
  readDevice(deviceId: number, context: QueryContext) {
    this.assertContext(context); PositiveIdSchema.parse(deviceId);
    const rows = context.scope.batchIds.length ? this.snapshots(context.scope.batchIds, context, { deviceIds: [deviceId] }).filter(row => row.deviceId === deviceId) : [];
    const snapshot = rows.sort((a, b) => this.batch(b.batchId)!.snapshotDate.localeCompare(this.batch(a.batchId)!.snapshotDate) || b.id - a.id)[0];
    if (!snapshot) throw new Error("access_denied");
    return structuredClone({ ...this.device(deviceId)!, deviceName: snapshot.deviceName });
  }
}
