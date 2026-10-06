import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { contextAt } from '../fixtures/p8-context';
import { DEFAULT_REQUEST_POLICY } from '../../packages/contracts/src/model';
import { canonicalRequest } from '../../packages/contracts/src/run';
import { toWorkspaceContext } from '../../packages/contracts/src/workspace';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { SqliteContextStore } from '../../packages/storage/src/context-store';
import { ResourceSnapshotSchema, type ResourceSnapshot } from '../../packages/contracts/src/resources';
import { ToolRecorder } from '../../packages/core/src/tools/recorder';
import { acceptContextInput } from '../fixtures/p8-context';

function skillSnapshot(): ResourceSnapshot {
  const content = '---\nname: query\ndescription: ENGINEERING query\n---\nUse known facts.\n', sha256 = createHash('sha256').update(content).digest('hex');
  const metadata = { kind: 'skill', id: 'query', version: 'v1', entry: 'skills/query/v1/SKILL.md', keywords: [], requiredTools: ['read'], requiredExtensions: [], files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(content), sha256 }] };
  return ResourceSnapshotSchema.parse({ ref: { kind: 'skill', id: 'query', version: 'v1', treeHash: createHash('sha256').update(canonicalRequest(metadata)).digest('hex') },
    name: 'query', description: 'ENGINEERING query', keywords: [], disableModelInvocation: false, entry: metadata.entry, requiredTools: ['read'], requiredExtensions: [], files: [{ file: 'SKILL.md', content, bytes: Buffer.byteLength(content), sha256 }] });
}
function plannedInput(repos: Repositories, snapshot?: ResourceSnapshot) {
  repos.createSession({ expectedWorkspaceRevision: 0 }, 'create', 'native', contextAt);
  const workspace = repos.readWorkspace(), context = toWorkspaceContext(workspace), scope = repos.freezeAgentScope(workspace, snapshot ? ['read'] : []);
  if (snapshot) scope.allowedResourceRefs = [`skill:query@v1#${snapshot.ref.treeHash}`];
  const model = { provider: 'fixture', modelId: 'fixture', api: 'openai-completions', endpointRef: null, credentialRef: null, configVersion: '1', maxOutputTokens: 100, capabilitySource: 'user_declared' as const, sdkVersion: '0.87.1' as const };
  const request = { sessionId: context.sessionId, clientSequence: 1, text: '/query raw', mode: 'send' as const, expectedRevision: context.revision, expectedBatchIds: [], expectedQueryId: null,
    model: { provider: model.provider, modelId: model.modelId, expectedConfigVersion: '1' }, referenceDate: '2026-10-06', timezone: 'Asia/Shanghai' };
  const content = { contract: 'medclaw.session-input/v1' as const, originalSubmitInput: request, text: request.text, workspaceContext: context, scope, model, referenceDate: request.referenceDate,
    timezone: request.timezone, deliveryAttempt: null, resourceInputPlan: { kind: 'plain' as const, resourceRef: null, dispatchText: request.text } };
  const resources = { contract: 'medclaw.run-resources/v1' as const, sdkVersion: '0.87.1' as const, sessionId: context.sessionId, configVersion: '1', selection: { prompt: null, skills: snapshot ? [snapshot.ref] : [] }, available: snapshot ? [snapshot] : [], knownPromptNames: [], omitted: [] };
  const run = { sessionId: context.sessionId, goal: 'answer' as const, text: request.text, model, policy: DEFAULT_REQUEST_POLICY, workspace, scope, referenceDate: request.referenceDate, timezone: request.timezone,
    timeoutMs: DEFAULT_REQUEST_POLICY.timeoutMs, agentOptions: { requestedThinkingLevel: 'off' as const, effectiveThinkingLevel: 'off' as const }, instanceId: 'host', createdAt: contextAt, resources };
  return { operationRef: 'send', originalSubmitInput: request, content, createdAt: contextAt, execution: { mode: 'send' as const, run } };
}

test('p11 legacy registration cannot silently discard a supplied resource freeze', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-legacy-route-')), db = openDatabase(join(root, 'app.sqlite'));
  try {
    const repos = new Repositories(db), plan = plannedInput(repos);
    expect(() => repos.registerAgent({ ...plan.execution.run, inputId: null, submission: { operationRef: plan.operationRef, originalSubmitInput: plan.originalSubmitInput } })).toThrow('invalid_argument');
    expect(db.query('SELECT * FROM runs').all()).toHaveLength(0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('p11 consumption stores actual expanded text atomically and preserves the original request across restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-sql-')), path = join(root, 'app.sqlite'); let db = openDatabase(path);
  try {
    const repos = new Repositories(db), accepted = repos.acceptInput(plannedInput(repos));
    const f = { repos, input: { inputId: accepted.inputId!, sessionId: accepted.sessionId, runId: accepted.runId!, nativeEntryId: 'native-input' } };
    f.repos.beginInputDelivery(f.input.inputId, 'host', contextAt);
    expect(() => f.repos.recordInputConsumption(f.input.inputId, { ...f.input, at: contextAt })).toThrow();
    const nativeInput = { text: 'Expanded raw', sha256: createHash('sha256').update('Expanded raw').digest('hex') };
    expect(() => f.repos.recordInputConsumption(f.input.inputId, { ...f.input, at: contextAt, nativeInput: { ...nativeInput, sha256: '0'.repeat(64) } })).toThrow();
    expect(f.repos.readInput({ inputId: f.input.inputId })?.status).toBe('queued');
    f.repos.recordInputConsumption(f.input.inputId, { ...f.input, at: contextAt, nativeInput });
    let c = JSON.parse(db.query<{ content_json: string }, [number]>('SELECT content_json FROM session_inputs WHERE id=?').get(f.input.inputId)!.content_json);
    expect(c.nativeInput).toEqual(nativeInput); expect(c.text).toBe('/query raw'); expect(c.originalSubmitInput.text).toBe('/query raw');
    for (const changed of [{ ...c, text: 'tampered' }, { ...c, nativeInput: { ...nativeInput, text: 'tampered' } }, { ...c, nativeInput: undefined }])
      expect(() => db.query('UPDATE session_inputs SET content_json=? WHERE id=?').run(canonicalRequest(changed), f.input.inputId)).toThrow('input_identity_immutable');
    f.repos.recordInputConsumption(f.input.inputId, { ...f.input, at: contextAt, nativeInput });
    expect(() => f.repos.recordInputConsumption(f.input.inputId, { ...f.input, at: contextAt, nativeInput: { text: 'changed', sha256: createHash('sha256').update('changed').digest('hex') } })).toThrow('state_conflict');
    expect(() => f.repos.recordInputConsumption(f.input.inputId, { ...f.input, sessionId: 2, at: contextAt, nativeInput })).toThrow('state_conflict');
    db.close(); db = openDatabase(path);
    expect(new Repositories(db).readInput({ inputId: f.input.inputId })).toMatchObject({ text: '/query raw', status: 'consumed', nativeEntryId: f.input.nativeEntryId });
    c = JSON.parse(db.query<{ content_json: string }, [number]>('SELECT content_json FROM session_inputs WHERE id=?').get(f.input.inputId)!.content_json);
    expect(c.nativeInput).toEqual(nativeInput);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('p11 consumption failure rolls back receipt, owner state and original native event together', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-atomic-')); const db = openDatabase(join(root, 'app.sqlite'));
  try {
    let fail = false; const repos = new Repositories(db, () => { if (fail) throw new Error('ENGINEERING commit failure'); });
    const plan = plannedInput(repos), accepted = repos.acceptInput(plan), inputId = accepted.inputId!, runId = accepted.runId!;
    repos.beginInputDelivery(inputId, 'host', contextAt);
    const before = db.query('SELECT * FROM session_inputs').all(), events = db.query('SELECT * FROM runtime_events').all();
    const fact = { sessionId: accepted.sessionId, runId, nativeEntryId: 'input', at: contextAt, nativeInput: { text: '/query raw', sha256: createHash('sha256').update('/query raw').digest('hex') } };
    fail = true; expect(() => repos.recordInputConsumption(inputId, fact)).toThrow('ENGINEERING commit failure');
    expect(db.query('SELECT * FROM session_inputs').all()).toEqual(before); expect(db.query('SELECT * FROM runtime_events').all()).toEqual(events);
    fail = false; repos.recordInputConsumption(inputId, fact); repos.recordInputConsumption(inputId, fact);
    expect(db.query("SELECT * FROM runtime_events WHERE type='input_delivered' AND json_extract(payload_json,'$.phase')='native_consumed'").all()).toHaveLength(1);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('p11 schema10 migration changes only its receipt trigger and marker, preserving original facts and rollback', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-migration-')), path = join(root, 'app.sqlite'); let db = new Database(path, { strict: true });
  try {
    const migrations = ['001_p1.sql', '002_p2.sql', '003_p3.sql', '004_p5.sql', '005_p6.sql', '006_session_lifecycle.sql', '007_batch_deletion.sql', '008_p8.sql', '009_p9.sql', '010_p10.sql'];
    db.exec('PRAGMA foreign_keys=OFF');
    for (const [index, name] of migrations.entries()) {
      db.exec('PRAGMA foreign_keys=OFF');
      const sql = readFileSync(new URL('../../packages/storage/src/migrations/' + name, import.meta.url)); db.exec(sql.toString());
      db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(index + 1, createHash('sha256').update(sql).digest('hex'), contextAt);
    }
    db.exec('PRAGMA foreign_keys=ON'); const f = acceptContextInput(db);
    const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    const before = new Map(names.map(n => [n, db.query(`SELECT * FROM ${n}`).all()]));
    const trigger = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_schema WHERE name='session_inputs_identity_immutable'").get()!.sql;
    db.close();
    expect(() => openDatabase(path, phase => { if (phase === 'p11_receipt_marker') throw new Error('ENGINEERING migration failure'); })).toThrow('storage_migration_failed');
    db = new Database(path, { strict: true });
    expect(db.query("SELECT sql FROM sqlite_schema WHERE name='session_inputs_identity_immutable'").get()).toEqual({ sql: trigger });
    for (const n of names) expect(db.query(`SELECT * FROM ${n}`).all()).toEqual(before.get(n)!);
    db.close(); db = openDatabase(path);
    expect(db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => (r as { name: string }).name)).toEqual(names);
    for (const n of names.filter(n => n !== 'schema_migrations')) expect(db.query(`SELECT * FROM ${n}`).all()).toEqual(before.get(n)!);
    expect(db.query('SELECT * FROM schema_migrations ORDER BY version').all().slice(0, 10)).toEqual(before.get('schema_migrations')!);
    expect(db.query('SELECT version FROM schema_migrations').all()).toHaveLength(11);
    expect(new Repositories(db).readInput({ inputId: f.input.inputId })).toMatchObject({ text: 'Why did this decline?', status: 'consumed' });
    expect(new Repositories(db).readRunResources(f.input.runId)).toBeNull();
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('p11 P8 native reference checks rendered receipt text rather than raw command', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-context-')); const db = openDatabase(join(root, 'app.sqlite'));
  try {
    const repos = new Repositories(db), plan = plannedInput(repos), accepted = repos.acceptInput(plan), runId = accepted.runId!, inputId = accepted.inputId!;
    repos.beginInputDelivery(inputId, 'host', contextAt);
    const nativeInput = { text: 'Expanded raw', sha256: createHash('sha256').update('Expanded raw').digest('hex') };
    repos.recordInputConsumption(inputId, { sessionId: accepted.sessionId, runId, nativeEntryId: 'input', at: contextAt, nativeInput });
    const context = new SqliteContextStore(db), input = { runId, inputId, sessionId: accepted.sessionId, nativeEntryId: 'input', scope: plan.content.scope,
      workspaceContext: plan.content.workspaceContext, runtimeFeedback: '', nativeRefs: [{ kind: 'input' as const, id: inputId, nativeEntryId: 'input', contentHash: nativeInput.sha256, nativeToolCallId: null, originSnapshotId: null }], createdAt: contextAt };
    const snapshot = context.save(context.select(input));
    expect(snapshot.nativeRefs[0]!.contentHash).toBe(nativeInput.sha256);
    expect(snapshot.renderedProjection).not.toContain('Expanded raw');
    expect(() => context.select({ ...input, nativeRefs: [{ ...input.nativeRefs[0]!, contentHash: createHash('sha256').update('/query raw').digest('hex') }] })).toThrow('access_denied');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('p11 context delivery binds resource payload to its original saved expected identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-delivery-')); const db = openDatabase(join(root, 'app.sqlite'));
  try {
    const repos = new Repositories(db), resource = skillSnapshot(), plan = plannedInput(repos, resource), accepted = repos.acceptInput(plan), runId = accepted.runId!, inputId = accepted.inputId!;
    repos.beginInputDelivery(inputId, 'host', contextAt);
    repos.recordInputConsumption(inputId, { sessionId: accepted.sessionId, runId, nativeEntryId: 'input', at: contextAt, nativeInput: { text: '/query raw', sha256: createHash('sha256').update('/query raw').digest('hex') } });
    const store = new SqliteContextStore(db), snapshot = store.save(store.select({ runId, inputId, sessionId: accepted.sessionId, nativeEntryId: 'input', scope: plan.content.scope,
      workspaceContext: plan.content.workspaceContext, runtimeFeedback: '', nativeRefs: [], createdAt: contextAt }));
    const index = { resourceRef: resource.ref, originRunId: runId, file: null, kind: 'skill_index' as const, inputId: null, nativeEntryId: null, toolCallId: null, contentHash: 'a'.repeat(64), coverage: 'index' as const };
    repos.startCall(runId, 'call', 'main', contextAt, { snapshotId: snapshot.id, inputId, resources: { expected: [index], payload: null } });
    const resourcePayload = { payloadHash: 'b'.repeat(64), verified: [index] }, observation = { contract: 'medclaw.context-observation/v1' as const, api: 'openai-completions' as const, transport: 'sse' as const, observedAt: contextAt,
      httpStatus: 200, projectionHash: snapshot.projectionHash, feedbackHash: snapshot.feedbackHash, verifiedNativeRefs: [], resources: resourcePayload };
    const delivery = { runId, inputId, sessionId: accepted.sessionId, callId: 'call', snapshotId: snapshot.id, observation };
    expect(() => store.recordDelivery({ ...delivery, observation: { ...observation, resources: { ...resourcePayload, verified: [] } } })).toThrow();
    expect(db.query('SELECT * FROM context_deliveries').all()).toHaveLength(0);
    store.recordDelivery(delivery); store.recordDelivery(delivery);
    expect(repos.readResourceEvidence(runId, 1, 50)).toMatchObject({ totalRows: 1, items: [{ kind: 'provider_delivery', modelCallId: 'call', resourceRef: resource.ref, originRunId: runId, coverage: 'index', payloadHash: resourcePayload.payloadHash }] });
    expect(() => store.recordDelivery({ ...delivery, observation: { ...observation, resources: { ...resourcePayload, payloadHash: 'c'.repeat(64) } } })).toThrow('state_conflict');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('p11 native read annotation verifies returned content and preserves pending save identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-read-')); const db = openDatabase(join(root, 'app.sqlite'));
  try {
    const repos = new Repositories(db), snapshot = skillSnapshot(), plan = plannedInput(repos, snapshot), accepted = repos.acceptInput(plan), runId = accepted.runId!;
    repos.startCall(runId, 'call', 'main', contextAt);
    const store = new SqliteToolStore(db), context = { runId, sessionId: accepted.sessionId, nativeToolCallId: 'read-skill', scope: plan.content.scope, referenceDate: plan.content.referenceDate,
      timezone: plan.content.timezone, signal: new AbortController().signal };
    const call = store.request({ name: 'read', version: 'pi/0.87.1', effect: 'READ', executionMode: 'sequential' }, { path: 'SKILL.md' }, context);
    store.transition(call.id, 'requested', 'running'); store.transition(call.id, 'running', 'succeeded', { status: 'succeeded', data: { ENGINEERING: true } });
    const delivery = { role: 'toolResult' as const, toolCallId: context.nativeToolCallId, toolName: 'read', content: [{ type: 'text', text: snapshot.files[0]!.content }], isError: false, timestamp: 1 };
    store.recordDelivery(context, 'read-entry', delivery);
    const fact = { resourceRef: snapshot.ref, file: 'SKILL.md', fileHash: snapshot.files[0]!.sha256, returnedContentHash: createHash('sha256').update(canonicalRequest(delivery.content)).digest('hex'),
      coverage: 'complete' as const, observedAt: contextAt };
    expect(Reflect.get(store, 'recordResourceRead')).toBeFunction();
    expect(() => Reflect.get(store, 'recordResourceRead').call(store, context, { ...fact, returnedContentHash: '0'.repeat(64) })).toThrow();
    const recorder = new ToolRecorder(store);
    expect(Reflect.get(recorder, 'recordResourceRead')).toBeFunction();
    let fail = true; const save = store.recordResourceRead.bind(store);
    store.recordResourceRead = (owner, observed) => { if (fail) throw new Error('storage_write_failed'); save(owner, observed); };
    expect(() => recorder.recordResourceRead(context, fact)).toThrow(); expect(recorder.persistencePending(runId)).toBe(true);
    expect(store.readCall(context)?.resourceRead).toBeUndefined();
    fail = false; recorder.retryPersistence(runId); expect(recorder.persistencePending(runId)).toBe(false);
    expect(store.readCall(context)).toMatchObject({ sdkDelivery: delivery, resourceRead: fact });
    expect(recorder.blocked(context)?.code).toBe('storage_write_failed');
    store.recordResourceRead(context, fact);
    expect(() => store.recordResourceRead(context, { ...fact, fileHash: '0'.repeat(64) })).toThrow();
    const evidence = repos.readResourceEvidence(runId, 1, 1);
    expect(evidence.totalRows).toBe(1); expect(evidence.items[0]).toMatchObject({ kind: 'native_read', originRunId: runId, toolCallId: call.id, contentHash: fact.returnedContentHash });
    expect(repos.readResourceEvidence(runId, 2, 1)).toEqual({ items: [], totalRows: 1 });
    expect(() => repos.readResourceEvidence(runId, Number.MAX_SAFE_INTEGER, 100)).toThrow('invalid_argument');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('p11 legacy runs remain not recorded after resource methods are introduced', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-legacy-')); const db = openDatabase(join(root, 'app.sqlite'));
  try { const f = acceptContextInput(db); expect(f.repos.readRunResources(f.input.runId)).toBeNull(); expect(f.repos.readResourceEvidence(f.input.runId, 1, 50)).toEqual({ items: [], totalRows: 0 }); }
  finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('p11 run snapshot and input plan commit together and reject invalid owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-freeze-')); const db = openDatabase(join(root, 'app.sqlite'));
  try {
    const repos = new Repositories(db);
    const acceptance = plannedInput(repos), run = acceptance.execution.run, resources = run.resources;
    expect(() => repos.acceptInput({ ...acceptance, execution: { mode: 'send', run: { ...run, resources: { ...resources, sessionId: resources.sessionId + 1 } } } })).toThrow();
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) n FROM session_inputs').get()!.n).toBe(0);
    const accepted = repos.acceptInput(acceptance);
    expect(Reflect.get(repos, 'readRunResources')).toBeFunction();
    expect(repos.readRunResources(accepted.runId!)).toEqual(resources);
    expect(db.query<{ n: number }, []>('SELECT MAX(version) n FROM schema_migrations').get()!.n).toBe(11);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

