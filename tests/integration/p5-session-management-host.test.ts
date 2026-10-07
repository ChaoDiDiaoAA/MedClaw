import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MainSettings, atomicWriteJson } from '../../apps/desktop/src/main/settings';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { DATABASE_SCHEMA_VERSION } from '../../packages/contracts/src/protocol';
import { mergeRuntimeConfigurationPolicies } from '../../packages/contracts/src/runtime-config';
import { NewSessionResultSchema, SessionDetailSchema, SessionManagementReceiptSchema, SubmitResultSchema } from '../../packages/contracts/src/session';
import { safeError, type Result } from '../../packages/contracts/src/error';
import { providerFixture } from '../fixtures/p1-provider';
import { openDatabase } from '../../packages/storage/src/database';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';

function unwrap<T>(result: Result<T>): T { if (!result.ok) throw result.error; return result.data; }
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() > deadline) throw Error('Original Host fact not observed'); await Bun.sleep(20); }
}
async function fixture(holdRename = false, savedQueries = false) {
  const temporary = mkdtempSync(join(tmpdir(), 'medclaw-session-host-'));
  const release = join(temporary, 'release'), entered = join(temporary, 'entered'), service = providerFixture();
  const entry = join(temporary, 'host.ts');
  writeFileSync(entry, holdRename ? `import {existsSync,writeFileSync} from 'node:fs';
import {SessionService} from ${JSON.stringify(resolve('packages/core/src/session/session-service.ts'))};
const original=SessionService.prototype.rename;SessionService.prototype.rename=async function(input,context){
if(context.operationRef==='held-rename'){writeFileSync(${JSON.stringify(entered)},'entered');while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(20);}
return original.call(this,input,context);};await import(${JSON.stringify(resolve('apps/host/src/main.ts'))});`
    : `await import(${JSON.stringify(resolve('apps/host/src/main.ts'))});`);
  const host = new HostController({ dataRoot: temporary, hostEntry: entry, bunExecutable: process.execPath,
    onCredentialRequest: async frame => frame.method === 'credential.list' ? { ok: true, data: [{ providerId: 'management-fixture', type: 'api_key' }] }
      : frame.method === 'credential.read' ? { ok: true, data: frame.payload.providerId === 'management-fixture' ? { type: 'api_key', key: 'fixture-only' } : null }
      : { ok: false, error: safeError('access_denied') } });
  const initial = new MainSettings(host.paths.settingsPath).read();
  atomicWriteJson(host.paths.settingsPath, PublishedSettingsSchema.parse({ ...initial, model: { provider: 'management-fixture', modelId: 'fixture' },
    customProviders: [{ definition: { providerId: 'management-fixture', name: 'Fixture', api: 'openai-completions', baseUrl: service.url,
      models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] }, credentialRef: null }],
    ...mergeRuntimeConfigurationPolicies(initial, { requestPolicy: { timeoutMs: 5000, maxRetries: 0, maxRetryDelayMs: 2000 } }) }));
  const db = openDatabase(host.paths.databasePath);
  const saved = savedQueries ? seedWorkspaceQueries(db) : null;
  if (saved) db.query('UPDATE runs SET cleanup_json=? WHERE id=10').run(JSON.stringify({ contract: 'medclaw.run-cleanup/v1', executionStarted: true,
    stopConfirmed: true, requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: true, unconfirmedItems: [], secondaryErrors: [], verifiedAt: '2026-10-04T00:00:00.000Z' }));
  db.close();
  expect(await host.start()).toMatchObject({ state: 'ready', schemaVersion: DATABASE_SCHEMA_VERSION });
  const workspace = async () => unwrap(await host.request('workspace.read', {})) as { revision: number; sessionId: number | null };
  const create = async (op: string) => NewSessionResultSchema.parse(unwrap(await host.request('session.create', { expectedWorkspaceRevision: (await workspace()).revision }, op)));
  const sql = (query: string) => { const db = new Database(host.paths.databasePath, { readonly: true }); try { return db.query(query).all(); } finally { db.close(); } };
  const close = async () => {
    writeFileSync(release, 'released');
    try { if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!); }
    finally { service.close(); const inside = relative(tmpdir(), temporary); if (inside && !inside.startsWith('..') && !inside.includes(':')) rmSync(temporary, { recursive: true, force: true }); }
  };
  return { host, service, workspace, create, sql, close, release, entered, saved };
}

test('M01/M10/M12 real Host management keeps original receipts across later rename and deletion', async () => {
  const f = await fixture();
  try {
    const a = await f.create('create-a'), b = await f.create('create-b');
    const original = { sessionId: a.session.id, title: ' 中文名称 ', expectedMetadataRevision: 0 };
    const first = SessionManagementReceiptSchema.parse(unwrap(await f.host.request('session.rename', original, 'rename-a')));
    expect(first.session).toMatchObject({ title: '中文名称', metadataRevision: 1 });
    expect(await f.host.request('session.rename', { ...original, title: 'changed' }, 'rename-a')).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await f.host.request('session.rename', { ...original, expectedMetadataRevision: 1 }, 'create-a')).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    const noOp = SessionManagementReceiptSchema.parse(unwrap(await f.host.request('session.rename', { ...original, expectedMetadataRevision: 1 }, 'rename-noop')));
    expect(noOp.session.metadataRevision).toBe(1);
    unwrap(await f.host.request('session.rename', { ...original, title: 'later', expectedMetadataRevision: 1 }, 'rename-later'));
    expect(unwrap(await f.host.request('session.readManagementOperation', { operationRef: 'rename-a' }))).toEqual(first);
    expect(unwrap(await f.host.request('session.rename', original, 'rename-a'))).toEqual(first);
    expect(SessionDetailSchema.parse(unwrap(await f.host.request('session.read', { sessionId: a.session.id }))).session.title).toBe('later');
    const ws = await f.workspace();
    unwrap(await f.host.request('session.delete', { sessionId: a.session.id, expectedMetadataRevision: 2, expectedWorkspaceRevision: ws.revision }, 'delete-a'));
    expect(await f.workspace()).toEqual(ws); expect(ws.sessionId).toBe(b.session.id);
    expect(unwrap(await f.host.request('session.create', { expectedWorkspaceRevision: 0 }, 'create-a'))).toEqual(a);
    expect(await f.host.request('session.list', {})).toMatchObject({ ok: true, data: { sessions: [{ id: b.session.id }] } });
    expect(f.sql('SELECT count(*) AS n FROM runs')).toEqual([{ n: 0 }]);
    expect(f.sql('SELECT count(*) AS n FROM business_events WHERE type IN (\'session_renamed\',\'session_deleted\')')).toEqual([{ n: 4 }]);
    expect(f.service.requests).toHaveLength(0);
    const oldInstance = f.host.read().instanceId!;
    expect(await f.host.restart(oldInstance)).toMatchObject({ state: 'ready', schemaVersion:12 });
    expect(await f.host.request('session.readManagementOperation', { operationRef: 'rename-a' }, undefined, undefined, oldInstance)).toMatchObject({ ok: false, error: { code: 'host_interrupted' } });
    expect(unwrap(await f.host.request('session.readManagementOperation', { operationRef: 'rename-a' }))).toEqual(first);
    expect(SessionDetailSchema.parse(unwrap(await f.host.request('session.read', { sessionId: a.session.id }))).session.status).toBe('deleted');
  } finally { await f.close(); }
}, 30000);

test('M04/M14 real Host deleted Session retains original Query and Evidence facts', async () => {
  const f = await fixture(false, true);
  try {
    const saved = f.saved!;
    unwrap(await f.host.request('workspace.update', { expectedRevision: (await f.workspace()).revision, change: { queryId: saved.current.id, activeView: 'evidence' } }));
    const query = unwrap(await f.host.request('query.read', { queryId: saved.current.id }));
    const evidence = unwrap(await f.host.request('evidence.read', { queryId: saved.current.id, evidenceId: saved.evidenceId }));
    const queries = f.sql('SELECT * FROM queries'), records = f.sql('SELECT * FROM query_evidence'), before = await f.workspace();
    unwrap(await f.host.request('session.delete', { sessionId: 1, expectedMetadataRevision: 0, expectedWorkspaceRevision: before.revision }, 'delete-query-session'));
    expect(await f.workspace()).toMatchObject({ sessionId: null, queryId: null, revision: before.revision + 1, activeView: 'data', batchRefs: [{ id: 1 }] });
    expect(unwrap(await f.host.request('query.read', { queryId: saved.current.id }))).toEqual(query);
    expect(unwrap(await f.host.request('evidence.read', { queryId: saved.current.id, evidenceId: saved.evidenceId }))).toEqual(evidence);
    expect(f.sql('SELECT * FROM queries')).toEqual(queries); expect(f.sql('SELECT * FROM query_evidence')).toEqual(records);
    expect(f.service.requests).toHaveLength(0);
  } finally { await f.close(); }
}, 30000);

test('M13 real timed-out Host write can commit after a null lookup', async () => {
  const f = await fixture(true);
  try {
    const a = await f.create('create-held');
    const pending = f.host.request('session.rename', { sessionId: a.session.id, title: 'delayed', expectedMetadataRevision: 0 }, 'held-rename');
    await until(() => existsSync(f.entered));
    expect(await f.host.request('session.readManagementOperation', { operationRef: 'held-rename' })).toEqual({ ok: true, data: null });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'operation_result_unknown', operationRef: 'held-rename' } });
    expect(await f.host.request('session.readManagementOperation', { operationRef: 'held-rename' })).toEqual({ ok: true, data: null });
    writeFileSync(f.release, 'released');
    await until(async () => { const value = await f.host.request('session.readManagementOperation', { operationRef: 'held-rename' }); return value.ok && value.data !== null; });
    expect(SessionDetailSchema.parse(unwrap(await f.host.request('session.read', { sessionId: a.session.id }))).session).toMatchObject({ title: 'delayed', metadataRevision: 1 });
    expect(f.sql("SELECT count(*) AS n FROM business_events WHERE operation_ref='held-rename'")).toEqual([{ n: 1 }]);
    expect(f.service.requests).toHaveLength(0);
  } finally { await f.close(); }
}, 30000);

test('M14 deleted Session retains original real Pi Run Input and Event reads without new execution', async () => {
  const f = await fixture();
  try {
    const a = await f.create('create-run');
    const request = { mode: 'send', sessionId: a.session.id, clientSequence: 1, text: 'original', expectedRevision: a.workspace.revision,
      expectedBatchIds: [], expectedQueryId: null, model: { provider: 'management-fixture', modelId: 'fixture', expectedConfigVersion: '1' }, referenceDate: '2026-10-04', timezone: 'Asia/Shanghai' };
    const accepted = SubmitResultSchema.parse(unwrap(await f.host.request('session.submit', request, 'send-original')));
    await until(async () => { const value = await f.host.request('run.control.read', {}); return value.ok && (value.data as { acceptingNewRuns: boolean }).acceptingNewRuns; });
    const counts = () => f.sql('SELECT (SELECT count(*) FROM runs) AS runs,(SELECT count(*) FROM model_calls) AS calls,(SELECT count(*) FROM session_inputs) AS inputs,(SELECT count(*) FROM runtime_events) AS events');
    const before = counts(), events = unwrap(await f.host.request('event.read', { runId: accepted.runId, afterSequence: 0, limit: 100 }));
    unwrap(await f.host.request('session.delete', { sessionId: a.session.id, expectedMetadataRevision: 0, expectedWorkspaceRevision: (await f.workspace()).revision }, 'delete-run-session'));
    expect(await f.host.request('session.readSubmission', { sessionId: a.session.id, clientSequence: 1 })).toEqual({ ok: true, data: accepted });
    expect(unwrap(await f.host.request('session.submit', request, 'send-original'))).toEqual(accepted);
    expect(await f.host.request('session.readInput', { inputId: accepted.inputId })).toMatchObject({ ok: true, data: { status: 'consumed', processingStatus: 'completed', sessionId: a.session.id } });
    expect(await f.host.request('run.read', { runId: accepted.runId })).toMatchObject({ ok: true, data: { kind: 'one', run: { status: 'completed', sessionId: a.session.id } } });
    expect(unwrap(await f.host.request('event.read', { runId: accepted.runId, afterSequence: 0, limit: 100 }))).toEqual(events);
    for (const [method, payload] of [['session.select', { sessionId: a.session.id, expectedWorkspaceRevision: (await f.workspace()).revision }], ['session.submit', { ...request, clientSequence: 2 }], ['session.rename', { sessionId: a.session.id, title: 'new', expectedMetadataRevision: 1 }]] as const)
      expect(await f.host.request(method, payload, `new-${method}`)).toMatchObject({ ok: false, error: { code: 'state_conflict', reason: 'session_deleted' } });
    expect(counts()).toEqual(before); expect(f.service.requests).toHaveLength(1);
  } finally { await f.close(); }
}, 30000);
