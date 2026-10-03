import { TOOL_PROFILE_RULES } from '../../packages/core/src/tools/tool-profile';
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { safeError } from '../../packages/contracts/src/error';
import { createToolControlObservation } from '../../packages/contracts/src/model';
import { CurrentQuerySchema } from '../../packages/contracts/src/query';
import type { AnyToolDefinition, ToolExecutionContext } from '../../packages/contracts/src/tool';
import { initializeToolStorage, SqliteToolStore } from '../../packages/storage/src/tool-store';

const handles: Database[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); });
const scope = {
  batchIds: [1],
  deviceIds: null,
  allowedToolNames: ['read_batch'],
  allowedResourceRefs: [],
  artifactIds: [],
  readOnly: true,
};
const tool: AnyToolDefinition = {
  name: 'read_batch',
  version: '1.0.0',
  label: 'Read batch',
  description: 'Read batch',
  effect: 'READ',
  executionMode: 'parallel',
  inputSchema: CurrentQuerySchema,
  outputSchema: CurrentQuerySchema,
  execute: async () => null,
};
function fixture() {
  const db = new Database(':memory:');
  handles.push(db);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE runs(id INTEGER PRIMARY KEY,session_id INTEGER NOT NULL REFERENCES sessions(id),status TEXT NOT NULL,
      scope_json TEXT NOT NULL,reference_date TEXT NOT NULL,timezone TEXT NOT NULL,config_json TEXT NOT NULL,UNIQUE(id,session_id)) STRICT;
    CREATE TABLE model_calls(id INTEGER PRIMARY KEY,run_id INTEGER NOT NULL,session_id INTEGER NOT NULL,call_id TEXT NOT NULL) STRICT;
    INSERT INTO sessions VALUES(1);`);
  db.query("INSERT INTO runs VALUES(1,1,'running',?,'2026-10-01','Asia/Shanghai','{}')").run(JSON.stringify(scope));
  db.exec("INSERT INTO model_calls VALUES(1,1,1,'later-model')");
  initializeToolStorage(db);
  const context: ToolExecutionContext = {
    runId: 1,
    sessionId: 1,
    nativeToolCallId: 'control-call',
    scope,
    referenceDate: '2026-10-01',
    timezone: 'Asia/Shanghai',
    signal: new AbortController().signal,
  };
  return { db, context, store: new SqliteToolStore(db) };
}

test('P3 control-only delivery JSON cannot be consumed before an actual SDK receipt', () => {
  const { db, store, context } = fixture();
  const call = store.request(tool, {}, context);
  store.transition(call.id, 'requested', 'running');
  store.transition(call.id, 'running', 'succeeded', { status: 'succeeded', data: { batchId: 1 } });
  db.query('UPDATE tool_calls SET delivery_json=? WHERE id=?').run(JSON.stringify({ sdkReturned: false, nativeEntryId: null }), call.id);
  expect(() => store.recordConsumption(context, 'later-model')).toThrow('state_conflict');
});

test('P3 query transaction preserves a trusted deadline failure and rolls back before commit', () => {
  const { db, store, context } = fixture();
  let checks = 0;
  const guarded = {
    ...context,
    checkActive: () => { if (++checks >= 2) throw safeError('run_timeout'); },
  };
  let thrown: unknown;
  try {
    store.commitQuery({
      sessionId: 1,
      runId: 1,
      callRef: '1:control-call',
      kind: 'current',
      params: { batchIds: [1], snapshotMode: 'exact_date', page: 1, pageSize: 50, sort: 'asc' },
      batchIds: [1],
      scopeDeviceIds: null,
      rows: [],
      snapshotIds: [],
      eventIds: [],
      warnings: [],
      calculationVersion: 'query/v1',
      resultHash: 'empty',
      createdAt: '2026-10-01T00:00:00.000Z',
    }, [], guarded);
  } catch (error) { thrown = error; }
  expect(thrown).toMatchObject({ code: 'run_timeout' });
  expect(checks).toBeGreaterThanOrEqual(2);
  expect(db.query('SELECT COUNT(*) AS n FROM queries').get()).toEqual({ n: 0 });
});

test('P3 terminal/control save is atomic and after facts retain the first SDK receipt', () => {
  const { db, store, context } = fixture();
  const call = store.request(tool, {}, context);
  store.transition(call.id, 'requested', 'running');
  const control = createToolControlObservation({
    admission: { status: 'passed', reason: null },
    executionElapsedMs: 12,
    observedElapsedMs: 12,
    latencyObservation: 'complete',
  });
  const done = store.transition(call.id, 'running', 'succeeded', { status: 'succeeded', data: { queryId: 7 } }, control);
  expect(done.control).toEqual(control);
  expect(done.sdkReturned).toBe(false);
  expect(done.nativeEntryId).toBeNull();
  store.mergeControl(context, { postflightStatus: 'failed', hookFailure: { stage: 'afterToolCall', code: 'tool_postprocess_failed' } });
  store.recordDelivery(context, 'original-entry');
  store.mergeControl(context, { recoveryAction: 'read_original' });
  store.mergeControl(context, { recoveryAction: 'recovered' });
  store.mergeControl(context, { recoveryAction: 'recovered' });
  store.recordConsumption(context, 'later-model');
  const saved = store.readCall(context)!;
  expect(saved.status).toBe('succeeded');
  expect(saved.data).toEqual({ queryId: 7 });
  expect(saved.control?.hookFailure?.stage).toBe('afterToolCall');
  expect(saved.control?.executionElapsedMs).toBe(12);
  expect(saved.control?.recoveryAction).toBe('recovered');
  expect(saved.sdkReturned).toBe(true);
  expect(saved.nativeEntryId).toBe('original-entry');
  expect(() => store.recordDelivery(context, 'other-entry')).toThrow('state_conflict');
  expect(() => store.mergeControl(context, { executionElapsedMs: 11 })).toThrow('state_conflict');

  const next = store.request(tool, {}, { ...context, nativeToolCallId: 'atomic-failure' });
  store.transition(next.id, 'requested', 'running');
  db.exec(`CREATE TRIGGER reject_control BEFORE UPDATE ON tool_calls
    WHEN NEW.id=${next.id} AND NEW.delivery_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'write failure'); END`);
  expect(() => store.transition(next.id, 'running', 'succeeded', { status: 'succeeded', data: {} }, control)).toThrow('storage_write_failed');
  expect(store.readCall({ ...context, nativeToolCallId: 'atomic-failure' })?.status).toBe('running');
});

test('P3 observation window freezes the maximum ID across all ages and skips later records', () => {
  const { db, store, context } = fixture();
  const old = store.request(tool, {}, context);
  db.query('UPDATE tool_calls SET requested_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z', old.id);
  const first = store.readToolObservations({ limit: TOOL_PROFILE_RULES.observationLimit, windowDays: TOOL_PROFILE_RULES.windowDays, cutoffAt: '2026-10-02T00:00:00.000Z' });
  expect(first.maxToolCallId).toBe(old.id);
  expect(first.observations).toHaveLength(0);
  const recent = store.request(tool, {}, { ...context, nativeToolCallId: 'recent' });
  db.query('UPDATE tool_calls SET requested_at=? WHERE id=?').run('2026-10-01T00:00:00.000Z', recent.id);
  expect(store.readToolObservations({ limit: TOOL_PROFILE_RULES.observationLimit, windowDays: TOOL_PROFILE_RULES.windowDays, cutoffAt: '2026-10-02T00:00:00.000Z', maxToolCallId: first.maxToolCallId }).observations).toHaveLength(0);
  const latest = store.readToolObservations({ limit: TOOL_PROFILE_RULES.observationLimit, windowDays: TOOL_PROFILE_RULES.windowDays, cutoffAt: '2026-10-02T00:00:00.000Z' });
  expect(latest.maxToolCallId).toBe(recent.id);
  expect(latest.observations[0]).toMatchObject({ id: recent.id, control: null, measurementContext: null, sdkReturned: false, consumedAt: null });
  expect(() => store.readToolObservations({ limit: TOOL_PROFILE_RULES.observationLimit, windowDays: TOOL_PROFILE_RULES.windowDays, cutoffAt: 'bad-date' })).toThrow('invalid_argument');
  expect(store.readToolObservations({ windowDays: TOOL_PROFILE_RULES.windowDays, cutoffAt: '2026-10-02T00:00:00.000Z', limit: 2001 }).observations).toHaveLength(1);
  expect(store.readToolObservations({ limit: TOOL_PROFILE_RULES.observationLimit, cutoffAt: '2026-10-02T00:00:00.000Z', windowDays: 366 }).observations).toHaveLength(2);
  expect(() => store.readToolObservations({ windowDays: TOOL_PROFILE_RULES.windowDays, cutoffAt: '2026-10-02T00:00:00.000Z', limit: 0 })).toThrow('invalid_argument');
});

test('P3 saved Query metadata rejects corrupted parameter hashes and conflicting duplicate identities', () => {
  const { db, store, context } = fixture();
  const query = store.commitQuery({
    sessionId: 1,
    runId: 1,
    callRef: '1:control-call',
    kind: 'current',
    params: CurrentQuerySchema.parse({ batchIds: [1] }),
    batchIds: [1],
    scopeDeviceIds: null,
    rows: [],
    snapshotIds: [],
    eventIds: [],
    warnings: [],
    calculationVersion: 'query/v1',
    resultHash: 'empty',
    createdAt: '2026-10-01T00:00:00.000Z',
  }, [], context);
  const saved = db.query<{ params_hash: string; result_json: string }, [number]>('SELECT params_hash,result_json FROM queries WHERE id=?').get(query.id)!;
  db.exec('DROP TRIGGER queries_update_immutable');
  db.query("UPDATE queries SET params_hash='wrong' WHERE id=?").run(query.id);
  let thrown: unknown;
  try { store.readQuery(query.id); } catch (error) { thrown = error; }
  expect(thrown).toMatchObject({ code: 'tool_output_inconsistent' });
  db.query('UPDATE queries SET params_hash=?,result_json=? WHERE id=?').run(saved.params_hash, JSON.stringify({ ...JSON.parse(saved.result_json), runId: 99 }), query.id);
  thrown = undefined;
  try { store.readQuery(query.id); } catch (error) { thrown = error; }
  expect(thrown).toMatchObject({ code: 'tool_output_inconsistent' });
});
