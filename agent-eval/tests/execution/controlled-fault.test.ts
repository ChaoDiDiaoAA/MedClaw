import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AppErrorSchema, safeError } from '../../../packages/contracts/src/error';
import { businessToolSchemas } from '../../../packages/contracts/src/business-tools';
import { HostHelloSchema, HOST_PROTOCOL_VERSION, DATABASE_SCHEMA_VERSION } from '../../../packages/contracts/src/protocol';
import type { AnyToolDefinition, ToolExecutionContext } from '../../../packages/contracts/src/tool';
import { CatalogService } from '../../../packages/core/src/data/catalog-service';
import { QueryService } from '../../../packages/core/src/data/query-service';
import { EvidenceReader } from '../../../packages/core/src/evidence/evidence-reader';
import { createQueryIntentStepTool } from '../../../packages/core/src/intent/agent-tool';
import { RunControl } from '../../../packages/core/src/runtime/run-control';
import { createControlledToolFault } from '../../../packages/core/src/tools/controlled-fault';
import { ToolExecutor } from '../../../packages/core/src/tools/executor';
import { ToolRecorder } from '../../../packages/core/src/tools/recorder';
import { ToolRegistry } from '../../../packages/core/src/tools/registry';
import { createBusinessTools } from '../../../packages/core/src/tools/tools';
import { initializeToolStorage, SqliteToolStore } from '../../../packages/storage/src/tool-store';

const databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
const currentInput = { batchIds: [1] };
const intentInput = { stepId: 's1', part: 0 };

function fixture(fault?: 'query-timeout-once') {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id INTEGER PRIMARY KEY);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,session_id INTEGER REFERENCES sessions(id),status TEXT,scope_json TEXT,reference_date TEXT,timezone TEXT,UNIQUE(id,session_id));
    INSERT INTO sessions VALUES(1),(2);`);
  const scope = { batchIds: [1], deviceIds: null,
    allowedToolNames: ['query_current_devices', 'query_intent_step', 'list_batches'], allowedResourceRefs: [], artifactIds: [], readOnly: true };
  const context = (nativeToolCallId: string, patch: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
    runId: 1, sessionId: 1, nativeToolCallId, scope, referenceDate: '2026-10-12', timezone: 'Asia/Shanghai',
    signal: new AbortController().signal, ...patch,
  });
  db.query("INSERT INTO runs VALUES(1,1,'running',?,'2026-10-12','Asia/Shanghai')").run(JSON.stringify(scope));
  db.query("INSERT INTO runs VALUES(2,2,'running',?,'2026-10-12','Asia/Shanghai')").run(JSON.stringify({ ...scope, allowedToolNames: [] }));
  initializeToolStorage(db);
  const catalog = new CatalogService({ batches: [{ id: 1, scopeKey: 'empty-fixture', snapshotDate: '2026-10-12', region: 'fixture',
    coverage: 'full', previousBatchId: null, materialVersion: 'fixture/v1', sourceBundleId: 'fixture', sourceLockHash: 'lock',
    contentHash: 'content', cohortHash: 'cohort', catalogRevision: 1, expectedEntityCount: 0, observedEntityCount: 0,
    declaredMissingDeviceIds: [] }], devices: [], snapshots: [], changes: [] });
  const store = new SqliteToolStore(db), queries = new QueryService(catalog, store), evidence = new EvidenceReader(catalog, queries, store);
  const recorder = new ToolRecorder(store), wrap = createControlledToolFault(fault);
  const intent = createQueryIntentStepTool(async (_input, executionContext) => {
    const result = queries.current(businessToolSchemas.query_current_devices.input.parse(currentInput), executionContext);
    return { query: queries.read(result.queryId, executionContext) };
  });
  const configure = (extraDefinitions: readonly AnyToolDefinition[] = [intent]) =>
    new ToolExecutor(new ToolRegistry(wrap([...createBusinessTools({ catalog, queries, evidence }), ...extraDefinitions])), recorder);
  const counts = () => ({ queries: db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM queries').get()!.n,
    evidence: db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM query_evidence').get()!.n });
  return { db, store, context, configure, counts };
}

test('controlled query timeout is recorded after start, replays its native ID and permits a fresh retry', async () => {
  const f = fixture('query-timeout-once'), executor = f.configure(), context = f.context('first');
  const control = new RunControl({ runId: 1, scope: context.scope, signal: context.signal,
    deadlineAt: performance.now() + 30000, totalTimeoutMs: 30000 });
  const failed = await executor.execute('query_current_devices', currentInput, context, control);
  expect(failed).toMatchObject({ status: 'failed', error: { code: 'tool_timeout' } });
  expect(failed.status !== 'succeeded' && AppErrorSchema.safeParse(failed.error).success).toBe(true);
  const saved = f.store.readCall(context);
  expect(saved).toMatchObject({ status: 'failed', data: null, error: { code: 'tool_timeout' }, sdkReturned: false, nativeEntryId: null,
    control: { failureStage: 'execution', failureClass: 'tool_timeout' } });
  const timing = f.db.query<{ started_at: string; ended_at: string }, []>('SELECT started_at,ended_at FROM tool_calls').get()!;
  expect(timing.started_at).toBeString(); expect(timing.ended_at).toBeString();
  expect(f.counts()).toEqual({ queries: 0, evidence: 0 });
  expect(await executor.execute('query_current_devices', currentInput, context, control)).toMatchObject({ status: 'failed', error: { code: 'tool_timeout' } });
  expect(f.store.readCall(context)).toEqual(saved); expect(f.counts()).toEqual({ queries: 0, evidence: 0 });
  expect(await executor.execute('query_current_devices', currentInput, f.context('retry'), control)).toMatchObject({ status: 'succeeded', data: { queryId: 1 } });
  expect(f.counts()).toEqual({ queries: 1, evidence: 1 });
  expect(f.db.query('SELECT COUNT(*) AS n FROM tool_calls').get()).toEqual({ n: 2 });
});

test.each(['query_current_devices', 'query_intent_step'])('one fault is shared across both query names and repeated configure calls, starting with %s', async firstName => {
  const f = fixture('query-timeout-once'), first = f.configure();
  const firstInput = firstName === 'query_current_devices' ? currentInput : intentInput;
  expect(await first.execute(firstName, firstInput, f.context('first'))).toMatchObject({ status: 'failed', error: { code: 'tool_timeout' } });
  expect(f.counts()).toEqual({ queries: 0, evidence: 0 });
  const next = f.configure(), secondName = firstName === 'query_current_devices' ? 'query_intent_step' : 'query_current_devices';
  const secondInput = secondName === 'query_current_devices' ? currentInput : intentInput;
  expect(await next.execute(secondName, secondInput, f.context('second'))).toMatchObject({ status: 'succeeded',
    data: secondName === 'query_intent_step' ? { id: 1 } : { queryId: 1 } });
  expect(await next.execute(firstName, firstInput, f.context('third'))).toMatchObject({ status: 'succeeded',
    data: firstName === 'query_intent_step' ? { id: 2 } : { queryId: 2 } });
  expect(f.counts()).toEqual({ queries: 2, evidence: 2 });
});

test('invalid, forbidden, aborted and inactive calls do not consume the controlled fault', async () => {
  const f = fixture('query-timeout-once'), executor = f.configure();
  const invalid = f.context('invalid');
  expect(await executor.execute('query_current_devices', { batchIds: 'invalid' }, invalid)).toMatchObject({ status: 'failed', error: { code: 'tool_input_invalid' } });
  const denied = f.context('denied', { runId: 2, sessionId: 2, scope: { ...invalid.scope, allowedToolNames: [] } });
  expect(await executor.execute('query_current_devices', currentInput, denied)).toMatchObject({ status: 'failed', error: { code: 'access_denied' } });
  const abort = new AbortController(); abort.abort();
  expect(await executor.execute('query_current_devices', currentInput, f.context('aborted', { signal: abort.signal }))).toMatchObject({ status: 'cancelled', error: { code: 'tool_cancelled' } });
  const inactive = f.context('inactive', { checkActive: () => { throw safeError('tool_cancelled'); } });
  expect(await executor.execute('query_intent_step', intentInput, inactive)).toMatchObject({ status: 'failed', error: { code: 'tool_cancelled' } });
  expect(f.db.query('SELECT started_at FROM tool_calls').all()).toEqual(Array.from({ length: 4 }, () => ({ started_at: null })));
  expect(f.counts()).toEqual({ queries: 0, evidence: 0 });
  expect(await executor.execute('query_intent_step', intentInput, f.context('admitted'))).toMatchObject({ status: 'failed', error: { code: 'tool_timeout' } });
  expect(f.counts()).toEqual({ queries: 0, evidence: 0 });
});

test('the active check after recorder.start still precedes fault consumption', async () => {
  const f = fixture('query-timeout-once'), executor = f.configure(); let checks = 0;
  const context = f.context('inactive-after-start', { checkActive: () => { if (++checks === 2) throw safeError('tool_cancelled'); } });
  expect(await executor.execute('query_current_devices', currentInput, context)).toMatchObject({ status: 'failed', error: { code: 'tool_cancelled' } });
  expect(f.db.query('SELECT started_at FROM tool_calls').get()).toMatchObject({ started_at: expect.any(String) });
  expect(f.counts()).toEqual({ queries: 0, evidence: 0 });
  expect(await executor.execute('query_current_devices', currentInput, f.context('admitted'))).toMatchObject({ status: 'failed', error: { code: 'tool_timeout' } });
});

test('an omitted fault preserves normal execution and other tools never consume the enabled fault', async () => {
  const normal = fixture(), executor = normal.configure();
  expect(await executor.execute('query_current_devices', currentInput, normal.context('normal'))).toMatchObject({ status: 'succeeded', data: { queryId: 1 } });
  expect(await normal.configure().execute('query_intent_step', intentInput, normal.context('intent'))).toMatchObject({ status: 'succeeded', data: { id: 2 } });
  expect(normal.counts()).toEqual({ queries: 2, evidence: 2 });
  const controlled = fixture('query-timeout-once'), enabled = controlled.configure();
  expect(await enabled.execute('list_batches', {}, controlled.context('list'))).toMatchObject({ status: 'succeeded', data: { totalRows: 1 } });
  expect(await enabled.execute('query_current_devices', currentInput, controlled.context('first-query'))).toMatchObject({ status: 'failed', error: { code: 'tool_timeout' } });
  expect(controlled.counts()).toEqual({ queries: 0, evidence: 0 });
});

test('HostHello accepts only the explicit optional controlled query-timeout fixture', () => {
  const hello = { protocolVersion: HOST_PROTOCOL_VERSION, instanceId: 'controlled', startupToken: 'token', sdkVersion: '0.87.1',
    expectedSchemaVersion: DATABASE_SCHEMA_VERSION, paths: { dataRoot: '/fixture', databasePath: '/fixture/app.sqlite',
      settingsPath: '/fixture/settings.json', cachePath: '/fixture/cache', lockPath: '/fixture/host.lock' } };
  expect(HostHelloSchema.safeParse(hello).success).toBe(true);
  expect(HostHelloSchema.safeParse({ ...hello, controlledToolFault: 'query-timeout-once' }).success).toBe(true);
  for (const fault of ['other', { tool: 'query_current_devices', code: 'tool_timeout' }, ['query-timeout-once'], null]) {
    expect(HostHelloSchema.safeParse({ ...hello, controlledToolFault: fault }).success).toBe(false);
  }
});
