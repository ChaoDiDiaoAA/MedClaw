import { createHash } from "node:crypto";
import { z } from 'zod';
import { BUSINESS_RULES, createQuerySchemas, QueryInterpretationSchema, QueryPageSchema, type Batch, type CatalogSummary, type ChangesQueryInput, type CurrentQueryInput, type Evidence, type QueryContext, type QueryExecutionContext, type QueryParams, type QueryParamsInput, type QueryRecord, type QueryStore, type Snapshot } from "../../../contracts/src/query";
import { AppErrorSchema, PositiveIdSchema, safeError, type Result } from "../../../contracts/src/error";
import { canonicalRequest } from "../../../contracts/src/run";
import type { ToolExecutionContext } from "../../../contracts/src/tool";
import { CatalogService, nextDate } from "./catalog-service";

const calculationVersion = "medclaw.query/v1";
const callRef = (context: QueryContext) => 'callRef' in context ? context.callRef : `${context.runId}:${context.nativeToolCallId}`;
type Calculation = Pick<QueryRecord, 'batchIds' | 'rows' | 'snapshotIds' | 'eventIds' | 'warnings'>;
type Filters = Pick<CurrentQueryInput, "deviceIds" | "region" | "manufacturer" | "category" | "distributor" | "status">;
const matches = (row: Snapshot, input: Filters) => (!input.deviceIds || input.deviceIds.includes(row.deviceId))
  && (["region", "manufacturer", "category", "distributor", "status"] as const).every(field => input[field] === undefined || row[field] === input[field]);

export class QueryService {
  constructor(private readonly catalog: CatalogService, private readonly store: QueryStore) {}
  private transaction<T>(action: () => T, context: QueryContext): T {
    const checked = () => {
      this.catalog.checkActive(context);
      const result = action();
      this.catalog.checkActive(context);
      return result;
    };
    return this.store.withQueryTransaction ? this.store.withQueryTransaction(checked) : checked();
  }
  private assertFilters(input: Filters & { batchIds: number[] }, context: QueryContext) {
    this.catalog.assertContext(context); this.store.assertContext(context);
    const batches = this.catalog.batches(input.batchIds, context);
    if (input.region !== undefined && !batches.some(batch => batch.region === input.region)
      || input.deviceIds?.some(id => context.scope.deviceIds !== null && !context.scope.deviceIds.includes(id))) throw new Error("access_denied");
    if (input.deviceIds) for (const id of input.deviceIds) this.catalog.readDevice(id, context);
  }
  private replay(kind: QueryRecord["kind"], params: CurrentQueryInput | ChangesQueryInput | QueryParams, context: QueryContext) {
    const found = this.store.findQuery(callRef(context));
    if (!found) return null;
    if (found.kind !== kind || canonicalRequest(found.params) !== canonicalRequest(params)
      || (found.source ?? 'agent_tool') !== ('source' in context ? context.source : 'agent_tool')) throw new Error("state_conflict");
    return this.read(found.id, context);
  }
  current(input: CurrentQueryInput, context: ToolExecutionContext) {
    return this.transaction(() => {
    const params = createQuerySchemas().CurrentQuerySchema.parse(input); this.assertFilters(params, context);
    const previous = this.replay("current", params, context); if (previous) return this.project(previous, params, context);
    const result = this.calculateCurrent(params, context);
    return this.project(this.commit('current', params, result.batchIds, result.rows, result.snapshotIds, result.eventIds, result.warnings, context), params, context);
    }, context);
  }
  private calculateCurrent(params: CurrentQueryInput, context: QueryContext): Calculation {
    const batches = this.catalog.selectBatches(params.batchIds, params.time, params.snapshotMode, context, params.region);
    const snapshots = this.catalog.snapshots(batches.map(batch => batch.id), context, params).filter(row => matches(row, params));
    snapshots.sort((a, b) => (params.sort === "asc" ? 1 : -1) * (a.deviceId - b.deviceId)
      || batches.find(batch => batch.id === a.batchId)!.scopeKey.localeCompare(batches.find(batch => batch.id === b.batchId)!.scopeKey) || a.id - b.id);
    const rows = snapshots.map(row => ({ snapshotId: row.id, batchId: row.batchId, deviceId: row.deviceId,
      date: batches.find(batch => batch.id === row.batchId)!.snapshotDate, scopeKey: batches.find(batch => batch.id === row.batchId)!.scopeKey,
      deviceName: row.deviceName, region: row.region, category: row.category, manufacturer: row.manufacturer,
      distributor: row.distributor, status: row.status, priceCents: row.priceCents, currency: row.currency, unit: row.unit }));
    const cutoff = params.time?.endExclusive ?? nextDate(context.referenceDate);
    const target = new Date(Date.parse(`${cutoff}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const warnings = params.snapshotMode === "as_of" ? batches.filter(batch => batch.snapshotDate !== target).map(batch => `as_of_freshness:${batch.id}:${batch.snapshotDate}:${target}`) : [];
    return { batchIds: batches.map(batch => batch.id), rows, snapshotIds: snapshots.map(row => row.id), eventIds: [], warnings };
  }
  changes(input: ChangesQueryInput, context: ToolExecutionContext) {
    return this.transaction(() => {
    const params = createQuerySchemas().ChangesQuerySchema.parse(input); this.assertFilters(params, context);
    const previous = this.replay("changes", params, context); if (previous) return this.project(previous, params, context);
    const result = this.calculateChanges(params, context);
    return this.project(this.commit('changes', params, result.batchIds, result.rows, result.snapshotIds, result.eventIds, result.warnings, context), params, context);
    }, context);
  }
  private calculateChanges(params: ChangesQueryInput, context: QueryContext, requireCoverage = true): Calculation {
    const all = this.catalog.batches(params.batchIds, context).filter(batch => params.region === undefined || batch.region === params.region), batches = all.filter(batch => batch.snapshotDate >= params.time.start && batch.snapshotDate < params.time.endExclusive);
    if (requireCoverage) for (const scopeKey of new Set(all.map(batch => batch.scopeKey))) {
      for (let date = params.time.start; date < params.time.endExclusive; date = nextDate(date)) {
        if (!batches.some(batch => batch.scopeKey === scopeKey && batch.snapshotDate === date)) throw new Error("data_coverage_missing");
      }
    }
    for (const batch of batches) if (batch.previousBatchId !== null) this.catalog.batches([batch.previousBatchId], context);
    const warnings = batches.filter(batch => batch.previousBatchId === null).map(batch => `baseline_no_predecessor:${batch.id}`);
    const events = this.catalog.changes(batches.map(batch => batch.id), context, params).filter(event => (!params.changeKind || event.kind === params.changeKind) && (!params.changeField || event.field === params.changeField));
    const matched = events.map(event => {
      this.catalog.checkActive(context);
      const old = this.catalog.snapshotFor(event.oldBatchId, event.deviceId, context), next = this.catalog.snapshotFor(event.newBatchId, event.deviceId, context);
      if (event.kind === 'added' ? old !== null || next === null : event.kind === 'missing' ? old === null || next !== null : old === null || next === null)
        throw new Error('tool_output_inconsistent');
      if (event.kind === 'field_changed') {
        const field = event.field === 'price' ? 'priceCents' : event.field!;
        if (old![field] !== event.oldValue || next![field] !== event.newValue || event.oldValue === event.newValue
          || event.field === 'price' && (old!.currency !== next!.currency || old!.unit !== next!.unit)) throw new Error('tool_output_inconsistent');
      }
      const snapshot = next ?? old!;
      const deltaCents = event.field === "price" && old?.priceCents !== null && old?.priceCents !== undefined && next?.priceCents !== null && next?.priceCents !== undefined ? next.priceCents - old.priceCents : null;
      const ratio = deltaCents === null || !old?.priceCents ? null : deltaCents / old.priceCents;
      if (!matches(snapshot, params) || params.direction && (deltaCents === null || (params.direction === "increase" ? deltaCents <= 0 : deltaCents >= 0))) return null;
      if (params.threshold) {
        const threshold = params.threshold, magnitude = ratio === null ? null : Math.abs(ratio);
        if (magnitude === null || !(threshold.operator === "gt" ? magnitude > threshold.value : threshold.operator === "gte" ? magnitude >= threshold.value : threshold.operator === "lt" ? magnitude < threshold.value : magnitude <= threshold.value)) return null;
      }
      const batch = batches.find(batch => batch.id === event.newBatchId)!;
      return { row: { eventId: event.id, deviceId: event.deviceId, deviceName: snapshot.deviceName, oldBatchId: event.oldBatchId,
        newBatchId: event.newBatchId, date: batch.snapshotDate, scopeKey: batch.scopeKey, kind: event.kind, field: event.field,
        region: snapshot.region, category: snapshot.category, manufacturer: snapshot.manufacturer, status: snapshot.status, currency: snapshot.currency, unit: snapshot.unit,
        oldValue: event.oldValue, newValue: event.newValue, deltaCents, ratio }, snapshotIds: [old?.id, next?.id].filter((id): id is number => id !== undefined) };
    }).filter((item): item is NonNullable<typeof item> => item !== null);
    matched.sort((a, b) => (params.sort === "asc" ? 1 : -1) * (a.row.date.localeCompare(b.row.date) || a.row.deviceId - b.row.deviceId)
      || a.row.scopeKey.localeCompare(b.row.scopeKey) || (a.row.field ?? "").localeCompare(b.row.field ?? "") || a.row.eventId - b.row.eventId);
    const actualBatchIds = [...new Set([...batches.map(batch => batch.id), ...batches.map(batch => batch.previousBatchId).filter((id): id is number => id !== null)])];
    return { batchIds: actualBatchIds, rows: matched.map(item => item.row), snapshotIds: [...new Set(matched.flatMap(item => item.snapshotIds))], eventIds: matched.map(item => item.row.eventId), warnings };
  }
  private listingFilters(params: QueryParams) {
    return { batchIds: params.batchIds, time: params.time ?? undefined, sort: params.sort, page: params.page, pageSize: params.pageSize,
      deviceIds: params.deviceIds ?? undefined, region: params.region ?? undefined, manufacturer: params.manufacturer ?? undefined,
      category: params.category ?? undefined, distributor: params.distributor ?? undefined, status: params.status ?? undefined };
  }
  async execute(input: QueryParamsInput, context: QueryExecutionContext): Promise<Result<QueryRecord>> {
    try {
      return this.transaction(() => {
      const params = createQuerySchemas().QueryParamsSchema.parse(input);
      const filters = this.listingFilters(params);
      this.assertFilters(filters, context);
      const prior = this.replay(params.kind, params, context);
      if (prior) return { ok: true, data: prior };
      if (context.basedOnQueryId != null) this.read(context.basedOnQueryId, context);
      let result: Calculation;
      if (params.kind === 'current') result = this.calculateCurrent(createQuerySchemas().CurrentQuerySchema.parse({ ...filters, snapshotMode: params.snapshotMode }), context);
      else if (params.kind === 'changes') result = this.calculateChanges(createQuerySchemas().ChangesQuerySchema.parse({ ...filters, changeKind: params.changeKind ?? undefined,
        changeField: params.changeField ?? undefined, direction: params.direction ?? undefined, threshold: params.threshold ?? undefined }), context);
      else result = this.calculateSummary(params, context);
      const record = this.commit(params.kind, params, result.batchIds, result.rows, result.snapshotIds, result.eventIds, result.warnings, context);
      return { ok: true, data: record };
      }, context);
    } catch (error) {
      const trusted = AppErrorSchema.safeParse(error);
      return { ok: false, error: safeError(trusted.success ? trusted.data.code : error instanceof z.ZodError ? 'invalid_argument' : context.signal.aborted ? 'tool_cancelled' : error instanceof Error ? error.message : 'internal_error', undefined,
        { runId: context.runId, sessionId: context.sessionId }) };
    }
  }
  private calculateSummary(params: QueryParams, context: QueryExecutionContext): Calculation {
    const all = this.catalog.batches(params.batchIds, context).filter(batch => params.region === null || batch.region === params.region);
    const batches = params.population === 'snapshot' && params.kind === 'aggregate'
      ? this.catalog.selectBatches(params.batchIds, params.time ?? undefined, params.snapshotMode!, context, params.region ?? undefined)
      : all.filter(batch => params.time !== null && batch.snapshotDate >= params.time.start && batch.snapshotDate < params.time.endExclusive);
    const warnings: string[] = [];
    if (params.population === 'changes') {
      if (params.kind === 'aggregate') for (const scopeKey of new Set(all.map(batch => batch.scopeKey))) for (let date = params.time!.start; date < params.time!.endExclusive; date = nextDate(date)) {
        if (!batches.some(batch => batch.scopeKey === scopeKey && batch.snapshotDate === date)) throw new Error('data_coverage_missing');
      }
      for (const batch of batches) {
        if (batch.previousBatchId !== null) this.catalog.batches([batch.previousBatchId], context);
        else warnings.push(`baseline_no_predecessor:${batch.id}`);
      }
    } else if (params.snapshotMode === 'as_of') {
      const cutoff = params.time?.endExclusive ?? nextDate(context.referenceDate);
      const target = new Date(Date.parse(`${cutoff}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      for (const batch of batches) if (batch.snapshotDate !== target) warnings.push(`as_of_freshness:${batch.id}:${batch.snapshotDate}:${target}`);
    }
    const batchIds = [...new Set([...batches.map(batch => batch.id), ...(params.population === 'changes' ? batches.map(batch => batch.previousBatchId).filter((id): id is number => id !== null) : [])])];
    const summarized = this.catalog.summarize(params, batches.map(batch => batch.id), context) ?? this.memorySummary(params, batches.map(batch => batch.id), context);
    let rows = summarized.rows;
    const unit = params.metric === 'change_count' ? 'events' : params.metric === 'sum_price' || params.metric === 'mean_price' ? 'cents' : 'devices';
    if (params.kind === 'trend') {
      const dimensions = [...(params.groupBy && params.groupBy !== 'date' ? [params.groupBy] : []), ...(unit === 'cents' ? ['currency', 'priceUnit'] : [])];
      const grouping = (row: QueryRecord['rows'][number]) => Object.fromEntries(dimensions.map(field => [field, row[field] ?? null]));
      const groups = new Map(rows.map(row => [canonicalRequest(grouping(row)), grouping(row)]));
      if (!groups.size) groups.set('{}', {});
      const grid: QueryRecord['rows'] = [];
      for (let date = params.time!.start; date < params.time!.endExclusive; date = nextDate(date)) {
        this.catalog.checkActive(context);
        const missing = [...new Set(all.map(batch => batch.scopeKey))].filter(scopeKey => !batches.some(batch => batch.scopeKey === scopeKey && batch.snapshotDate === date));
        for (const scopeKey of missing) warnings.push(`date_gap:${scopeKey}:${date}`);
        for (const [key, dimensionValues] of groups) {
          const matched = rows.filter(row => row.date === date && canonicalRequest(grouping(row)) === key);
          if (!missing.length && matched.length) grid.push(...matched.map(row => ({ ...row, gap: false })));
          else grid.push({ date, ...dimensionValues, metric: params.metric,
            value: missing.length || unit === 'cents' ? null : 0, unit, matchedRows: 0, gap: missing.length > 0,
            ...(unit === 'cents' ? { validCount: 0, zeroCount: 0, missingCount: 0 } : {}) });
        }
      }
      rows = grid;
    }
    const direction = params.sort === 'asc' ? 1 : -1;
    const groupKey = (row: QueryRecord['rows'][number]) => canonicalRequest({ ...(params.groupBy && params.groupBy !== 'date' ? { [params.groupBy]: row[params.groupBy] ?? null } : {}),
      ...(unit === 'cents' ? { currency: row.currency ?? null, priceUnit: row.priceUnit ?? null } : {}) });
    rows.sort((a, b) => (params.kind === 'trend' ? direction * String(a.date).localeCompare(String(b.date))
      : a.value === null ? b.value === null ? 0 : 1 : b.value === null ? -1 : direction * (Number(a.value) - Number(b.value)))
      || (groupKey(a) < groupKey(b) ? -1 : groupKey(a) > groupKey(b) ? 1 : 0));
    if (params.topN !== null) rows = rows.slice(0, params.topN);
    return { batchIds: batchIds.length ? batchIds : params.batchIds, rows, snapshotIds: summarized.snapshotIds, eventIds: summarized.eventIds, warnings };
  }
  private memorySummary(params: QueryParams, batchIds: number[], context: QueryExecutionContext): CatalogSummary {
    const filters = this.listingFilters(params);
    let source: Pick<Calculation, 'rows' | 'snapshotIds' | 'eventIds'>;
    if (params.population === 'snapshot') {
      const batches = this.catalog.batches(params.batchIds, context);
      const snapshots = batchIds.length ? this.catalog.snapshots(batchIds, context).filter(row => matches(row, filters)) : [];
      source = { rows: snapshots.map(row => ({ ...Object.fromEntries(Object.entries(row).filter(([, value]) => value === null || typeof value === 'number' || typeof value === 'string')),
        deviceId: row.deviceId, date: batches.find(batch => batch.id === row.batchId)!.snapshotDate, scopeKey: batches.find(batch => batch.id === row.batchId)!.scopeKey })),
        snapshotIds: snapshots.map(row => row.id), eventIds: [] };
    } else source = this.calculateChanges(createQuerySchemas().ChangesQuerySchema.parse({ ...filters, changeKind: params.changeKind ?? undefined, changeField: params.changeField ?? undefined,
      direction: params.direction ?? undefined, threshold: params.threshold ?? undefined }), context, params.kind !== 'trend');
    const price = params.metric === 'sum_price' || params.metric === 'mean_price';
    const groups = new Map<string, { dimensions: QueryRecord['rows'][number]; items: QueryRecord['rows'] }>();
    for (const row of source.rows) {
      this.catalog.checkActive(context);
      const dimensions: QueryRecord['rows'][number] = {};
      if (params.kind === 'trend' || params.groupBy === 'date') dimensions.date = row.date!;
      if (params.groupBy && params.groupBy !== 'date') dimensions[params.groupBy] = row[params.groupBy] ?? null;
      if (price) { dimensions.currency = row.currency!; dimensions.priceUnit = row.unit!; }
      const key = canonicalRequest(dimensions);
      const group = groups.get(key) ?? { dimensions, items: [] };
      group.items.push(row); groups.set(key, group);
    }
    if (!groups.size && params.kind === 'aggregate' && !params.groupBy && !price) groups.set('{}', { dimensions: {}, items: [] });
    const rows = [...groups.values()].map(group => {
      const values = group.items.map(row => row.priceCents).filter((value): value is number => typeof value === 'number');
      const total = values.reduce((sum, value) => sum + value, 0);
      if (!Number.isSafeInteger(total)) throw new Error('query_result_too_large');
      return { ...group.dimensions, metric: params.metric, matchedRows: group.items.length, unit: params.metric === 'change_count' ? 'events' : price ? 'cents' : 'devices',
        value: params.metric === 'count' || params.metric === 'changed_device_count' ? new Set(group.items.map(row => canonicalRequest([row.deviceId, row.scopeKey]))).size
          : params.metric === 'change_count' ? group.items.length : !values.length ? null : params.metric === 'sum_price' ? total : total / values.length,
        ...(price ? { validCount: values.length, zeroCount: values.filter(value => value === 0).length, missingCount: group.items.length - values.length } : {}) };
    });
    return { rows, snapshotIds: source.snapshotIds, eventIds: source.eventIds };
  }
  private interpretation(kind: QueryRecord['kind'], params: QueryRecord['params'], batches: Batch[], rows: QueryRecord['rows'], context?: QueryContext) {
    const snapshot = 'population' in params ? params.population === 'snapshot' : kind === 'current';
    const point = kind === 'current' || kind === 'aggregate' && snapshot;
    const snapshotMode = 'snapshotMode' in params ? params.snapshotMode : null;
    const requestedTime = params.time ?? (point && context ? { start: context.referenceDate, endExclusive: nextDate(context.referenceDate) } : null);
    const requestedDate = point && requestedTime ? snapshotMode === 'as_of'
      ? new Date(Date.parse(`${requestedTime.endExclusive}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : requestedTime.start : null;
    const dataDates = [...new Set(batches.filter(batch => (params.region == null || batch.region === params.region) && (point || !requestedTime
      || batch.snapshotDate >= requestedTime.start && batch.snapshotDate < requestedTime.endExclusive)).map(batch => batch.snapshotDate))].sort();
    const basis = kind === 'current' ? 'snapshot_records' : kind === 'changes' ? 'change_events'
      : 'metric' in params && params.metric === 'count' ? 'distinct_device_identifiers_per_scope'
      : 'metric' in params && params.metric === 'changed_device_count' ? 'changed_device_identifiers_per_scope'
      : 'metric' in params && (params.metric === 'sum_price' || params.metric === 'mean_price') ? params.metric : 'change_events';
    const quantity = kind === 'current' || kind === 'changes' ? rows.length
      : kind === 'aggregate' && 'groupBy' in params && params.groupBy === null && rows.length === 1 && typeof rows[0]!.value === 'number' ? rows[0]!.value : null;
    return QueryInterpretationSchema.parse({
      requestedDate,
      requestedTime,
      referenceDate: context?.referenceDate ?? null,
      timezone: context?.timezone ?? null,
      dataDates,
      snapshotMode,
      basis,
      status: params.status ?? null,
      quantity,
      unit: basis === 'snapshot_records' ? 'records' : basis === 'change_events' ? 'events'
        : basis === 'sum_price' || basis === 'mean_price' ? 'CNY cents' : 'identifiers',
      isStale: requestedDate === null ? null : dataDates.some(date => date < requestedDate),
    });
  }
  private commit(kind: QueryRecord["kind"], params: CurrentQueryInput | ChangesQueryInput | QueryParams, batchIds: number[], rows: QueryRecord["rows"], snapshotIds: number[], eventIds: number[], warnings: string[], context: QueryContext) {
    this.catalog.checkActive(context);
    // ponytail: freeze rows in JSON up to the fixed capacity ceiling; use indexed SQL paging if larger results are needed.
    if (rows.length > BUSINESS_RULES.maxSavedRows) throw new Error("query_result_too_large");
    const scopeDeviceIds = params.deviceIds ?? context.scope.deviceIds;
    const batches = this.catalog.batches(batchIds, context), groups = new Map<string, typeof batches>();
    const interpretation = this.interpretation(kind, params, batches, rows, context);
    this.assertRows({ kind, params, batchIds, scopeDeviceIds, snapshotIds, eventIds }, rows, batches);
    const resultHash = createHash("sha256").update(canonicalRequest({ kind, params, batchIds, scopeDeviceIds, rows, interpretation, calculationVersion })).digest("hex");
    const evidence: Omit<Evidence, "id" | "queryId">[] = [];
    for (const batch of batches) {
      const key = canonicalRequest([batch.sourceBundleId, batch.materialVersion, batch.sourceLockHash]);
      const group = groups.get(key) ?? []; group.push(batch); groups.set(key, group);
    }
    const sourceEvents = new Map(eventIds.length ? this.catalog.changes(batchIds, context).map(event => [event.id, event]) : []);
    const referencedSnapshots = this.catalog.snapshotReferences(snapshotIds, context);
    if (new Set(snapshotIds).size !== snapshotIds.length || new Set(eventIds).size !== eventIds.length
      || eventIds.some(id => !sourceEvents.has(id)) || referencedSnapshots.some(row => !batchIds.includes(row.batchId))) throw new Error('tool_output_inconsistent');
    for (const group of groups.values()) {
      const ids = group.map(batch => batch.id), groupSnapshots = referencedSnapshots.filter(row => ids.includes(row.batchId));
      const groupEvents = eventIds.filter(id => ids.includes(sourceEvents.get(id)?.newBatchId ?? -1));
      evidence.push({ batchIds: ids, snapshotIds: groupSnapshots.map(row => row.id), eventIds: groupEvents,
        sourceRowRefs: [...new Set(groupSnapshots.map(row => row.sourceRowRef))], calculationVersion,
        materialVersion: group[0]!.materialVersion, sourceBundleId: group[0]!.sourceBundleId, sourceLockHash: group[0]!.sourceLockHash, resultHash,
        filters: params, provenance: 'synthetic-derived' });
    }
    this.catalog.checkActive(context);
    const materialVersions = [...new Set(batches.map(batch => batch.materialVersion))].sort();
    return this.store.commitQuery({ sessionId: context.sessionId, runId: context.runId, callRef: callRef(context),
      source: 'source' in context ? context.source : 'agent_tool', catalogRevision: this.catalog.revision(), materialVersion: materialVersions.join(','),
      basedOnQueryId: 'basedOnQueryId' in context ? context.basedOnQueryId ?? null : null,
      kind, params, batchIds, scopeDeviceIds, rows, snapshotIds, eventIds, warnings, interpretation, calculationVersion, resultHash, createdAt: new Date().toISOString() }, evidence, context);
  }
  read(queryId: number, context: QueryContext): QueryRecord {
    this.catalog.assertContext(context); if (this.store.assertReadContext) this.store.assertReadContext(context); else this.store.assertContext(context);
    const delegated='nativeToolCallId' in context&&context.delegationSource!==undefined;
    const id=PositiveIdSchema.parse(queryId);
    const own=delegated?null:this.store.readQuery(id,context.sessionId);
    if(own&&own.sessionId!==context.sessionId)throw new Error('access_denied');
    const record = own ?? ('nativeToolCallId' in context&&context.modelCallId&&context.contextSnapshotId!=null ? this.store.readChildQuery?.(id,context) : null);
    if (!record) throw new Error("access_denied");
    const batches = this.catalog.batches(record.batchIds, context);
    if (record.id !== queryId || 'kind' in record.params && record.params.kind !== record.kind
      || record.kind === 'current' && record.batchIds.some(id => !record.params.batchIds.includes(id))
      || record.scopeDeviceIds !== null && record.params.deviceIds != null && canonicalRequest(record.scopeDeviceIds) !== canonicalRequest(record.params.deviceIds)
      || new Set(record.snapshotIds).size !== record.snapshotIds.length || new Set(record.eventIds).size !== record.eventIds.length
      || record.kind === 'current' && (record.eventIds.length !== 0 || record.snapshotIds.length !== record.rows.length)
      || record.kind === 'changes' && record.eventIds.length !== record.rows.length) throw new Error('tool_output_inconsistent');
    if (context.scope.deviceIds !== null && (record.scopeDeviceIds === null || record.scopeDeviceIds.some(id => !context.scope.deviceIds!.includes(id)))
      || record.params.deviceIds?.some(id => context.scope.deviceIds !== null && !context.scope.deviceIds.includes(id))
      || (record.kind === 'current' || record.kind === 'changes') && record.rows.some(row => typeof row.deviceId !== "number" || context.scope.deviceIds !== null && !context.scope.deviceIds.includes(row.deviceId))) throw new Error("access_denied");
    if (record.interpretation) {
      const saved = record.interpretation;
      const expected = this.interpretation(record.kind, record.params, batches, record.rows,
        saved.referenceDate === null ? undefined : { ...context, referenceDate: saved.referenceDate, timezone: saved.timezone ?? context.timezone });
      if (canonicalRequest({ ...expected, timezone: saved.timezone }) !== canonicalRequest(saved)
        || record.kind === 'current' && saved.requestedDate !== null && saved.dataDates.some(date => saved.snapshotMode === 'exact_date' ? date !== saved.requestedDate : date > saved.requestedDate!))
        throw new Error('tool_output_inconsistent');
    }
    this.catalog.checkActive(context);
    // Legacy queries retain their saved hash and leave an omitted original cutoff unknown.
    return structuredClone({ ...record, interpretation: record.interpretation ?? this.interpretation(record.kind, record.params, batches, record.rows) });
  }
  page(input: { queryId: number; page: number; pageSize: number }, context: QueryContext) {
    const record = this.read(input.queryId, context); return this.project(record, createQuerySchemas().PageSchema.parse({ page: input.page, pageSize: input.pageSize }), context);
  }
  async readQueryResult(queryId: number, context: QueryContext): Promise<Result<QueryRecord>> {
    try { return { ok: true, data: this.read(queryId, context) }; }
    catch (error) { const trusted = AppErrorSchema.safeParse(error); return { ok: false, error: safeError(trusted.success ? trusted.data.code : error instanceof Error ? error.message : 'storage_read_failed', undefined, { runId: context.runId, sessionId: context.sessionId }) }; }
  }
  private project(record: QueryRecord, input: { page: number; pageSize: number }, context: QueryContext) {
    const rows = record.rows.slice((input.page - 1) * input.pageSize, input.page * input.pageSize);
    const evidence = this.store.listEvidence(record.id);
    if (evidence.some(item => item.queryId !== record.id || item.resultHash !== record.resultHash || item.calculationVersion !== record.calculationVersion)) throw new Error('tool_output_inconsistent');
    const batches = this.catalog.batches(record.batchIds, context);
    this.assertRows(record, rows, batches);
    if (record.kind === 'current') {
      const references = new Map(this.catalog.snapshotReferences(rows.map(row => row.snapshotId as number), context).map(row => [row.id, row]));
      if (rows.some(row => references.get(row.snapshotId as number)?.batchId !== row.batchId || references.get(row.snapshotId as number)?.deviceId !== row.deviceId))
        throw new Error('tool_output_inconsistent');
    } else if (record.kind === 'changes') {
      for (const row of rows) {
        const old = this.catalog.snapshotFor(row.oldBatchId as number, row.deviceId as number, context);
        const next = this.catalog.snapshotFor(row.newBatchId as number, row.deviceId as number, context);
        if (batches.find(batch => batch.id === row.newBatchId)?.previousBatchId !== row.oldBatchId
          || (row.kind === 'added' ? old !== null || next === null : row.kind === 'missing' ? old === null || next !== null : old === null || next === null)
          || [old?.id, next?.id].some(id => id !== undefined && !record.snapshotIds.includes(id))) throw new Error('tool_output_inconsistent');
      }
    }
    return QueryPageSchema.parse({ queryId: record.id, rows, totalRows: record.rows.length,
      page: input.page, pageSize: input.pageSize, warnings: record.warnings, calculationVersion: record.calculationVersion, evidenceIds: evidence.map(item => item.id), interpretation: record.interpretation });
  }
  private assertRows(record: Pick<QueryRecord, 'kind' | 'params' | 'batchIds' | 'scopeDeviceIds' | 'snapshotIds' | 'eventIds'>, rows: QueryRecord['rows'], batches?: Batch[]): void {
    if (record.kind !== 'current' && record.kind !== 'changes') return;
    const identities = new Set<number>();
    const allowedIds = new Set(record.kind === 'current' ? record.snapshotIds : record.eventIds);
    const allowedBatches = new Set(record.batchIds), allowedDevices = record.scopeDeviceIds === null ? null : new Set(record.scopeDeviceIds);
    const batchById = new Map(batches?.map(batch => [batch.id, batch]));
    for (const row of rows) {
      const id = record.kind === 'current' ? row.snapshotId : row.eventId;
      const batchId = record.kind === 'current' ? row.batchId : row.newBatchId;
      const batch = batchById.get(batchId as number);
      if (typeof id !== 'number' || !allowedIds.has(id) || identities.has(id)
        || typeof batchId !== 'number' || !allowedBatches.has(batchId) || typeof row.deviceId !== 'number'
        || allowedDevices !== null && !allowedDevices.has(row.deviceId)
        || batch && (row.date !== batch.snapshotDate || row.scopeKey !== batch.scopeKey || row.region !== batch.region)
        || record.params.region != null && row.region !== record.params.region
        || record.params.status != null && row.status !== record.params.status
        || record.params.time && ((row.date as string) < record.params.time.start || (row.date as string) >= record.params.time.endExclusive)
          && (record.kind !== 'current' || !('snapshotMode' in record.params) || record.params.snapshotMode !== 'as_of'))
        throw new Error('tool_output_inconsistent');
      if (record.kind === 'current') {
        const date = record.params.time?.start;
        if (date && 'snapshotMode' in record.params && record.params.snapshotMode === 'exact_date' && row.date !== date || row.currency !== 'CNY' || typeof row.unit !== 'string')
          throw new Error('tool_output_inconsistent');
      } else if (typeof row.oldBatchId !== 'number' || !allowedBatches.has(row.oldBatchId) || row.currency !== 'CNY' || typeof row.unit !== 'string')
        throw new Error('tool_output_inconsistent');
      identities.add(id);
    }
  }
}
