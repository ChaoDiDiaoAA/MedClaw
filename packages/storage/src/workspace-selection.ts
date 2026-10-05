import type { Database } from 'bun:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { SqliteCatalogStore } from './catalog-store';
import { SqliteToolStore } from './tool-store';
import { WorkspaceStateSchema, type WorkspaceState, type WorkspaceView } from '../../contracts/src/workspace';
import { businessToolSchemas } from '../../contracts/src/business-tools';
function fail(code: string): never { throw new Error(code); }
function checked<T>(schema: z.ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); return parsed.success ? parsed.data : fail('invalid_argument'); }
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

export function readWorkspaceBatchReferences(db: Database, ids: number[]) {
    const rows = ids.map(batchId => {
      const row = db.query<{ id: number; content_hash: string; snapshot_date: string; scope_key: string; material_version: string }, [number]>(
        `SELECT id,content_hash,snapshot_date,scope_key,material_version FROM batches WHERE id=?${(!!db.query("SELECT name FROM pragma_table_info('batches') WHERE name='status'").get())?" AND status='active'":""}`).get(batchId);
      if (!row) fail("access_denied");
      return row;
    });
    const versions = new Set(rows.map(row => row.material_version));
    if (versions.size > 1) fail("invalid_argument");
    return { refs: rows.map(row => ({ id: row.id, contentHash: row.content_hash, snapshotDate: row.snapshot_date, scopeKey: row.scope_key })),
      materialVersion: rows[0]?.material_version ?? null };
}

export function readWorkspaceQuery(db: Database, queryId: number, state: WorkspaceState) {
    const query = new SqliteToolStore(db).readQuery(queryId);
    if (!query || query.sessionId !== state.sessionId || query.batchIds.some(id => !state.batchRefs.some(batch => batch.id === id))
      || state.deviceIds.length > 0 && (query.scopeDeviceIds === null || query.scopeDeviceIds.some(id => !state.deviceIds.includes(id)))) fail('access_denied');
    return query;
}

export function validateWorkspaceSelection(db: Database, selection: WorkspaceSelection, state: WorkspaceState) {
    const catalog = new SqliteCatalogStore(db), store = new SqliteToolStore(db);
    const batchIds = state.batchRefs.map(batch => batch.id);
    const inScope = (batchId: number, deviceId: number) => {
      if (!batchIds.includes(batchId) || state.deviceIds.length > 0 && !state.deviceIds.includes(deviceId)) fail('access_denied');
    };
    const snapshot = (key: string) => {
      const item = catalog.readSnapshot(Number(key.slice(9)));
      if (!item) fail('access_denied');
      inScope(item.batchId, item.deviceId);
      return item;
    };
    if (selection.kind === 'device') {
      const item = snapshot(selection.rowKey), version = state.batchRefs.find(batch => batch.id === item.batchId)!.contentHash;
      if (item.deviceId !== Number(selection.targetId) || version !== selection.targetVersion) fail('access_denied');
      assertSelectionField(item, selection.field);
    } else if (selection.kind === 'change') {
      const item = catalog.readChanges(batchIds, batchIds, state.deviceIds.length ? state.deviceIds : null).find(item => item.id === Number(selection.targetId));
      if (!item || selection.rowKey !== `change:${item.id}`) fail('access_denied');
      const expected = describeDataSelection(item, catalog.readBatches([item.oldBatchId, item.newBatchId]));
      if (expected.targetVersion !== selection.targetVersion) fail('access_denied');
      assertSelectionField(item, selection.field);
    } else {
      if (state.queryId === null) fail('access_denied');
      const query = readWorkspaceQuery(db, state.queryId, state);
      if (selection.targetVersion !== query.resultHash) fail('access_denied');
      if (selection.kind === 'query-row') {
        if (Number(selection.targetId) !== query.id) fail('access_denied');
        const row = resolveQueryRow(query, selection.rowKey);
        if (query.kind === 'current') {
          const item = snapshot(selection.rowKey);
          if (!query.snapshotIds.includes(item.id)) fail('access_denied');
        } else if (query.kind === 'changes') {
          const change = catalog.readChanges(batchIds, batchIds, state.deviceIds.length ? state.deviceIds : null).find(item => item.id === Number(selection.rowKey.slice(7)));
          if (!change || !query.eventIds.includes(change.id)) fail('access_denied');
        }
        assertSelectionField(row, selection.field);
      } else {
        const evidence = store.readEvidence(Number(selection.targetId));
        if (!evidence || evidence.queryId !== query.id || evidence.resultHash !== query.resultHash || evidence.batchIds.some(id => !batchIds.includes(id))) fail('access_denied');
        if (selection.rowKey === null) { if (selection.field !== null) fail('invalid_argument'); }
        else {
          const item = snapshot(selection.rowKey);
          if (!evidence.snapshotIds.includes(item.id) || !query.snapshotIds.includes(item.id)) fail('access_denied');
          assertSelectionField(item, selection.field);
        }
      }
    }
}

export function freezeWorkspaceScope(db: Database, workspace: WorkspaceView, toolNames: readonly string[]) {
    const selected = checked(WorkspaceStateSchema, { revision: workspace.revision, sessionId: workspace.sessionId, materialVersion: workspace.materialVersion,
      batchRefs: workspace.batchRefs, deviceIds: workspace.deviceIds, queryId: workspace.queryId, activeView: workspace.activeView, selection: workspace.selection });
    const ids = selected.batchRefs.map(batch => batch.id);
    const batches = readWorkspaceBatchReferences(db, ids);
    if (!isDeepStrictEqual(batches.refs, selected.batchRefs) || batches.materialVersion !== selected.materialVersion) fail("access_denied");
    const names = [...toolNames], supported = new Set([...Object.keys(businessToolSchemas), "read", "grep", "find", "ls", "edit", "write", "bash", "powershell"]);
    if (new Set(names).size !== names.length || names.some(name => !supported.has(name))) fail("invalid_argument");
    for (const deviceId of selected.deviceIds) {
      if (!ids.some(batchId => db.query("SELECT id FROM snapshots WHERE batch_id=? AND device_id=?").get(batchId, deviceId))) fail("access_denied");
    }
    if (selected.queryId !== null) readWorkspaceQuery(db, selected.queryId,selected);
    if (selected.selection !== null) validateWorkspaceSelection(db, selected.selection,selected);
    const artifacts = ids.flatMap(batchId => {
      const row = db.query<{ artifact_id: number | null }, [number]>("SELECT i.artifact_id FROM batches b JOIN imports i ON i.id=b.import_id WHERE b.id=?").get(batchId);
      return row?.artifact_id === null || row === null ? [] : [row.artifact_id];
    });
    return { batchIds: [...ids], deviceIds: selected.deviceIds.length ? [...selected.deviceIds] : null, allowedToolNames: names,
      allowedResourceRefs: [], artifactIds: [...new Set(artifacts)], readOnly: !names.some(name => ["edit", "write", "bash", "powershell"].includes(name)) };
}
