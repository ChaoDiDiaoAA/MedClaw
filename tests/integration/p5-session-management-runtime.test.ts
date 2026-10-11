import { sqliteHistory } from '../fixtures/p9-memory';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { ArtifactStore } from '../../packages/storage/src/artifact-store';
import { SessionService } from '../../packages/core/src/session/session-service';
import { WorkspaceService } from '../../packages/core/src/workspace/workspace-service';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import { ModelCallRecorder } from '../../packages/runtime-pi/src/model-call-recorder';
import { Application } from '../../packages/core/src/application';
import { ProviderAcceptedSchema, PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { mergeRuntimeConfigurationPolicies } from '../../packages/contracts/src/runtime-config';
import { NewSessionResultSchema, SessionDetailSchema, SessionManagementReceiptSchema, SubmitResultSchema, type SubmitInput } from '../../packages/contracts/src/session';
import { RuntimeControlViewSchema } from '../../packages/contracts/src/run';
import { canonicalRequest } from '../../packages/contracts/src/run';
import { WorkspaceViewSchema } from '../../packages/contracts/src/workspace';
import { safeError, type Result } from '../../packages/contracts/src/error';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MainSettings, atomicWriteJson } from '../../apps/desktop/src/main/settings';
import { DATABASE_SCHEMA_VERSION } from '../../packages/contracts/src/protocol';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 7000;
  while (!await check()) { if (Date.now() > end) throw new Error('Management fixture condition timed out'); await Bun.sleep(5); }
}
const definition = (baseUrl: string) => ({ providerId: 'p5-management', name: 'Management fixture', api: 'openai-completions', baseUrl,
  models: [{ id: 'fixture', name: 'Fixture', input: ['text' as const], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true as const, pricingKnown: false, cost: null }] });
function provider() {
  const gate = deferred(), requested = deferred(), requests: unknown[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json()); requested.release(); await gate.promise;
    const event = { id: 'management', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Management fixture complete' }, finish_reason: 'stop' }] };
    return new Response('data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, requested: requested.promise, release: gate.release, close: () => server.stop(true) };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-session-management-runtime-')), db = openDatabase(join(root, 'app.sqlite')), repo = new Repositories(db,undefined,undefined,undefined,sqliteHistory(db).store);
  const http = provider(), credentials = new InMemoryCredentialStore();
  await credentials.modify('p5-management', async () => ({ type: 'api_key', key: 'fixture-only' }));
  const model = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() }); await model.installCustom([definition(http.url)]);
  const settings = PublishedSettingsSchema.parse({ schemaVersion: 'medclaw.settings/p1-v1', configVersion: '1', model: null, customProviders: [], credentialRefs: {},
    requestPolicy: { timeoutMs: 10000, maxRetries: 0, maxRetryDelayMs: 2000 }, previous: null, rollbackFromVersion: null });
  const agent = new PiAgentRuntime(model, root, sqliteHistory(db));
  const app = new Application('management-host', settings, model, repo, (_context, action) => action(),
    (runId, kind, at) => new ModelCallRecorder(repo, runId, kind, at), () => {}, () => {}, agent);
  const context = (operationRef: string) => ({ instanceId: 'management-host', operationRef });
  const service = new SessionService('management-host', repo, agent, (input, command) => app.runs.submitAgent(input, command), () => app.runs.activeHandle,
    sessionId => app.runs.readInputControl(sessionId), (inputId, command) => app.runs.cancelInput(inputId, command), app.runs);
  const a = unwrap(await service.create({ expectedWorkspaceRevision: 0 }, context('create-a')));
  const b = unwrap(await service.create({ expectedWorkspaceRevision: a.workspace.revision }, context('create-b')));
  unwrap(await service.select({ sessionId: a.session.id, expectedWorkspaceRevision: b.workspace.revision }));
  const input = (sessionId = a.session.id): SubmitInput => ({ mode: 'send', sessionId, clientSequence: repo.readSession(sessionId)!.nextSubmissionSequence,
    text: 'Analyze original session', expectedRevision: repo.readWorkspace().revision, expectedBatchIds: [], expectedQueryId: null,
    model: { provider: 'p5-management', modelId: 'fixture', expectedConfigVersion: '1' }, referenceDate: '2026-10-04', timezone: 'Asia/Shanghai' });
  const deletion = (sessionId: number) => ({ sessionId, expectedMetadataRevision: repo.readSession(sessionId)!.metadataRevision, expectedWorkspaceRevision: repo.readWorkspace().revision });
  closes.push(async () => { http.release(); await app.shutdown().catch(() => {}); http.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, db, repo, http, model, agent, app, service, context, a, b, input, deletion };
}

test('rename during an actual A root preserves execution and idle B deletion does not stop or retarget A', async () => {
  const c = await fixture(), accepted = unwrap(await c.service.submit(c.input(), c.context('send-a')));
  if (accepted.runId === null || accepted.inputId === null) throw new Error('Missing root Input/Run');
  await c.http.requested;
  const workspace = c.repo.readWorkspace(), handle = c.app.runs.activeHandle, rows = c.db.query('SELECT id,session_id,input_id FROM runs').all();
  const renamed = unwrap(await c.service.rename({ sessionId: c.a.session.id, title: '  Original 会话 A  ', expectedMetadataRevision: 0 }, c.context('rename-running')));
  expect(renamed.session).toMatchObject({ id: c.a.session.id, title: 'Original 会话 A', metadataRevision: 1, status: 'active' });
  expect(renamed.workspace).toBeNull();
  const deleted = unwrap(await c.service.delete(c.deletion(c.b.session.id), c.context('delete-idle-b')));
  expect(deleted.session.status).toBe('deleted'); expect(c.repo.readWorkspace()).toEqual(workspace);
  expect(c.app.runs.activeHandle).toEqual(handle); expect(c.db.query('SELECT id,session_id,input_id FROM runs').all()).toEqual(rows);
  expect(await c.service.delete(c.deletion(c.a.session.id), c.context('delete-running-a'))).toMatchObject({ ok: false, error: { code: 'state_conflict', reason: 'runtime_busy' } });
  expect(c.repo.readSession(c.a.session.id)?.status).toBe('active'); expect(c.http.requests).toHaveLength(1);
  c.http.release(); await until(() => c.app.runs.activeHandle === null);
});

test('trusted Session reservation blocks target deletion during real model resolve and permits deleting unrelated idle Session', async () => {
  const c = await fixture(), entered = deferred(), resume = deferred(), original = c.model.resolve.bind(c.model);
  const held = spyOn(c.model, 'resolve').mockImplementation(async (...args) => { entered.release(); await resume.promise; return original(...args); });
  try {
    const submitted = c.service.submit(c.input(), c.context('send-resolving')); await entered.promise;
    expect(c.app.runs.activeHandle).toBeNull(); expect(c.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    expect(await c.service.delete(c.deletion(c.a.session.id), c.context('delete-resolving'))).toMatchObject({ ok: false, error: { reason: 'runtime_busy' } });
    expect(unwrap(await c.service.delete(c.deletion(c.b.session.id), c.context('delete-other-during-resolve'))).session.status).toBe('deleted');
    expect(c.http.requests).toHaveLength(0); resume.release(); unwrap(await submitted); await c.http.requested;
    c.http.release(); await until(() => c.app.runs.activeHandle === null);
  } finally { resume.release(); held.mockRestore(); }
});

test('delete wins against a preflight Send and leaves no deleted Session Input, Run or provider request', async () => {
  const c = await fixture(), request = c.input();
  const sent = c.service.submit(request, c.context('send-after-preflight'));
  const deleted = c.service.delete(c.deletion(c.a.session.id), c.context('delete-before-admission'));
  expect(unwrap(await deleted).session.status).toBe('deleted');
  expect(await sent).toMatchObject({ ok: false, error: { code: 'state_conflict', reason: 'session_deleted' } });
  expect(c.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
  expect(c.db.query('SELECT COUNT(*) AS n FROM session_inputs').get()).toEqual({ n: 0 });
  expect(c.http.requests).toHaveLength(0);
});

test('Provider resolve reservation has no Session ownership and does not block deleting an idle Session', async () => {
  const c = await fixture(), entered = deferred(), resume = deferred(), original = c.model.resolve.bind(c.model);
  const held = spyOn(c.model, 'resolve').mockImplementation(async (...args) => { entered.release(); await resume.promise; return original(...args); });
  try {
    const submitted = c.app.runs.submitProvider({ ...c.context('provider-resolving'), requestId: 'provider-request', payload: { model: { provider: 'p5-management', modelId: 'fixture', expectedConfigVersion: '1' },
      text: 'Independent provider request', referenceDate: '2026-10-04', timezone: 'Asia/Shanghai' } });
    await entered.promise;
    expect(unwrap(await c.service.delete(c.deletion(c.a.session.id), c.context('delete-during-provider-resolve'))).session.status).toBe('deleted');
    expect(c.http.requests).toHaveLength(0); resume.release();
    const accepted = await submitted; await c.http.requested;
    expect(c.app.runs.activeHandle).toEqual({ runId: accepted.runId, kind: 'provider', sessionId: null });
    c.http.release(); await until(() => c.app.runs.activeHandle === null); expect(c.http.requests).toHaveLength(1);
  } finally { resume.release(); held.mockRestore(); }
});

test.each([['agent', 'rename'], ['agent', 'delete'], ['provider', 'rename'], ['provider', 'delete'], ['diagnostic', 'rename'], ['diagnostic', 'delete']] as const)
('in-flight %s operation identity cannot be claimed by unrelated Session %s', async (source, method) => {
  const c = await fixture(), entered = deferred(), resume = deferred(), original = c.model.resolve.bind(c.model), operationRef = `reserved-${source}`;
  const held = spyOn(c.model, 'resolve').mockImplementation(async (...args) => { entered.release(); await resume.promise; return original(...args); });
  try {
    const request = c.input(), providerRequest = { model: request.model, ...(source === 'diagnostic' ? {} : { text: 'Original Provider identity' }), referenceDate: request.referenceDate, timezone: request.timezone };
    const pending = source === 'agent' ? c.service.submit(request, c.context(operationRef)).then(result => unwrap(result).runId)
      : c.app.runs.submitProvider({ ...c.context(operationRef), requestId: `${source}-request`, payload: providerRequest }, source === 'diagnostic' ? 'diagnostic' : 'main').then(result => result.runId);
    void pending.catch(() => {}); // A failing assertion still releases the real resolve in finally.
    await entered.promise;
    const workspace = c.repo.readWorkspace(), session = c.repo.readSession(c.b.session.id);
    expect(unwrap(await c.service.readManagementOperation({ operationRef }))).toBeNull();
    expect(await (method === 'rename' ? c.service.rename({ sessionId: c.b.session.id, title: 'Stolen identity', expectedMetadataRevision: 0 }, c.context(operationRef))
      : c.service.delete(c.deletion(c.b.session.id), c.context(operationRef))))
      .toMatchObject({ ok: false, error: { code: 'state_conflict', operationRef } });
    expect(c.repo.readSession(c.b.session.id)).toEqual(session); expect(c.repo.readWorkspace()).toEqual(workspace);
    expect(c.repo.findOperation(operationRef)).toBeNull(); expect(c.http.requests).toHaveLength(0);
    expect(unwrap(await c.service.readManagementOperation({ operationRef }))).toBeNull();
    expect(unwrap(await c.service.rename({ sessionId: c.b.session.id, title: 'Allowed B', expectedMetadataRevision: 0 }, c.context(`${operationRef}-rename-b`))).session.title).toBe('Allowed B');
    expect(unwrap(await c.service.delete(c.deletion(c.b.session.id), c.context(`${operationRef}-delete-b`))).session.status).toBe('deleted');
    expect(c.repo.readWorkspace()).toEqual(workspace);
    resume.release();
    const runId = await pending;
    if (runId === null) throw new Error('Missing original reserved root');
    expect(c.repo.findOperation(operationRef)?.method).toBe(source === 'agent' ? 'session.submit' : source === 'diagnostic' ? 'model.diagnose' : 'model.request');
    await c.http.requested; expect(c.app.runs.activeHandle).toEqual({ runId, kind: source === 'agent' ? 'agent' : 'provider', sessionId: source === 'agent' ? c.a.session.id : null });
    expect(unwrap(await c.service.readManagementOperation({ operationRef }))).toBeNull();
    expect(await c.service.rename({ sessionId: c.b.session.id, title: 'Still stolen', expectedMetadataRevision: 2 }, c.context(operationRef))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    c.http.release(); await until(() => c.app.runs.activeHandle === null); expect(c.http.requests).toHaveLength(1);
  } finally { resume.release(); held.mockRestore(); }
});

test('management replay returns the original receipt before current state and mismatched operation identities are rejected', async () => {
  const c = await fixture(), request = { sessionId: c.a.session.id, title: 'Initial user title', expectedMetadataRevision: 0 };
  const receipt = unwrap(await c.service.rename(request, c.context('original-rename')));
  unwrap(await c.service.rename({ ...request, title: 'Later title', expectedMetadataRevision: 1 }, c.context('later-rename')));
  expect(unwrap(await c.service.rename(request, c.context('original-rename')))).toEqual(receipt);
  expect(unwrap(await c.service.readManagementOperation({ operationRef: 'original-rename' }))).toEqual(receipt);
  expect(await c.service.readManagementOperation({ operationRef: 'not-yet-committed' })).toEqual({ ok: true, data: null });
  expect(await c.service.rename({ ...request, title: 'Different' }, c.context('original-rename'))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await c.service.delete(c.deletion(c.a.session.id), c.context('original-rename'))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await c.service.rename(request, c.context('create-a'))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  const removal = c.deletion(c.a.session.id), removed = unwrap(await c.service.delete(removal, c.context('original-delete')));
  unwrap(await c.service.select({ sessionId: c.b.session.id, expectedWorkspaceRevision: c.repo.readWorkspace().revision }));
  const workspace = c.repo.readWorkspace();
  expect(unwrap(await c.service.delete(removal, c.context('original-delete')))).toEqual(removed);
  expect(c.repo.readWorkspace()).toEqual(workspace);
  expect(await c.service.delete(c.deletion(c.a.session.id), c.context('new-delete'))).toMatchObject({ ok: false, error: { reason: 'session_deleted' } });
  expect(unwrap(await c.service.create({ expectedWorkspaceRevision: 0 }, c.context('create-a')))).toEqual(c.a);
  expect(c.repo.readWorkspace()).toEqual(workspace);
});

test('an unwired management gate refuses new writes but still returns already committed original receipts', async () => {
  const c = await fixture(), service = new SessionService('management-host', c.repo, c.agent,
    (input, command) => c.app.runs.submitAgent(input, command), () => c.app.runs.activeHandle);
  const rename = { sessionId: c.b.session.id, title: 'Wired rename', expectedMetadataRevision: 0 }, workspace = c.repo.readWorkspace();
  expect(await service.rename(rename, c.context('unwired-rename'))).toMatchObject({ ok: false, error: { reason: 'runtime_busy' } });
  const renamed = unwrap(await c.service.rename(rename, c.context('wired-rename')));
  expect(unwrap(await service.rename(rename, c.context('wired-rename')))).toEqual(renamed);
  const request = c.deletion(c.b.session.id);
  expect(await service.delete(request, c.context('unwired-delete'))).toMatchObject({ ok: false, error: { reason: 'runtime_busy' } });
  expect(c.repo.readSession(c.b.session.id)?.status).toBe('active'); expect(c.repo.readWorkspace()).toEqual(workspace);
  const receipt = unwrap(await c.service.delete(request, c.context('wired-delete')));
  expect(unwrap(await service.delete(request, c.context('wired-delete')))).toEqual(receipt);
});

test('delete rejects a changed Workspace confirmation and metadata version without a mutation', async () => {
  const c = await fixture(), confirmation = c.deletion(c.a.session.id);
  unwrap(await c.service.select({ sessionId: c.b.session.id, expectedWorkspaceRevision: c.repo.readWorkspace().revision }));
  const before = c.repo.readWorkspace();
  expect(await c.service.delete(confirmation, c.context('stale-delete-confirmation'))).toMatchObject({ ok: false, error: { reason: 'workspace_revision_mismatch' } });
  expect(await c.service.delete({ ...c.deletion(c.a.session.id), expectedMetadataRevision: 2 }, c.context('stale-metadata'))).toMatchObject({ ok: false, error: { reason: 'session_metadata_revision_mismatch' } });
  expect(c.repo.readSession(c.a.session.id)?.status).toBe('active'); expect(c.repo.readWorkspace()).toEqual(before);
  expect(c.http.requests).toHaveLength(0);
});

test('target Stop is unconfirmed until actual Pi settles and delete neither stops nor releases it', async () => {
  const c = await fixture(), accepted = unwrap(await c.service.submit(c.input(), c.context('send-stop')));
  if (accepted.runId === null) throw new Error('Missing root'); await c.http.requested;
  expect(c.app.runs.cancelNow(accepted.runId).stopped).toBe(false);
  const refused = c.service.delete(c.deletion(c.a.session.id), c.context('delete-before-stop-proof'));
  expect(await refused).toMatchObject({ ok: false, error: { code: 'stop_unconfirmed', runId: accepted.runId } });
  expect(c.repo.readSession(c.a.session.id)?.status).toBe('active');
  c.http.release(); await until(() => c.app.runs.activeHandle === null);
  expect(unwrap(await c.service.delete(c.deletion(c.a.session.id), c.context('delete-after-stop-proof'))).session.status).toBe('deleted');
});

test('actual terminal final-save failure blocks target deletion and same-fact retry releases it without another model request', async () => {
  const c = await fixture(), accepted = unwrap(await c.service.submit(c.input(), c.context('send-save')));
  if (accepted.runId === null) throw new Error('Missing root'); await c.http.requested;
  c.db.exec("CREATE TEMP TRIGGER management_final_failure BEFORE UPDATE OF output_text ON runs BEGIN SELECT RAISE(ABORT,'fixture final write failed'); END");
  c.http.release(); await until(() => c.app.runs.persistencePending);
  expect(c.repo.readInput({ inputId: accepted.inputId! })).toMatchObject({ status: 'consumed', processingStatus: 'pending' });
  expect(await c.service.delete(c.deletion(c.a.session.id), c.context('delete-save-gap'))).toMatchObject({ ok: false, error: { code: 'storage_write_failed', runId: accepted.runId } });
  expect(c.repo.readSession(c.a.session.id)?.status).toBe('active'); expect(c.http.requests).toHaveLength(1);
  c.db.exec('DROP TRIGGER management_final_failure'); unwrap(await c.app.runs.retrySave(accepted.runId));
  expect(c.app.runs.activeHandle).toBeNull();
  expect(unwrap(await c.service.delete(c.deletion(c.a.session.id), c.context('delete-saved'))).session.status).toBe('deleted');
  expect(c.http.requests).toHaveLength(1);
});

test('shared unreadable recovery facts block delete but lookup reports a storage fault rather than false absence', async () => {
  const c = await fixture(), confirmation = c.deletion(c.a.session.id);
  c.db.close(); c.app.runs.recoverInterrupted(false);
  expect(await c.service.delete(confirmation, c.context('delete-shared-read-gap'))).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await c.service.readManagementOperation({ operationRef: 'unreadable-operation' })).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
});

test('unattributed recovery read failure stays globally blocked until a healthy recovery inspection closes that gap', async () => {
  const c = await fixture(), accepted = unwrap(await c.service.submit(c.input(), c.context('send-before-recovery-fault')));
  if (accepted.runId === null) throw new Error('Missing root'); await c.http.requested;
  c.http.release(); await until(() => c.app.runs.activeHandle === null);
  const saved = c.db.query<{ cleanup_json: string; instance_id: string }, [number]>('SELECT cleanup_json,instance_id FROM runs WHERE id=?').get(accepted.runId)!;
  c.db.exec('PRAGMA ignore_check_constraints=ON');
  c.db.query('UPDATE runs SET cleanup_json=?,instance_id=? WHERE id=?').run('{', 'previous-host', accepted.runId);
  c.app.runs.recoverInterrupted(false);
  expect(await c.app.runs.readControl()).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  c.db.query('UPDATE runs SET cleanup_json=?,instance_id=? WHERE id=?').run(saved.cleanup_json, saved.instance_id, accepted.runId);
  c.db.exec('PRAGMA ignore_check_constraints=OFF');
  const workspace = c.repo.readWorkspace();
  expect(await c.service.delete(c.deletion(c.b.session.id), c.context('delete-through-shared-recovery-error'))).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(c.repo.readSession(c.b.session.id)?.status).toBe('active'); expect(c.repo.readWorkspace()).toEqual(workspace);
  c.app.runs.recoverInterrupted(false);
  expect(unwrap(await c.service.delete(c.deletion(c.b.session.id), c.context('delete-after-healthy-recovery'))).session.status).toBe('deleted');
  expect(c.http.requests).toHaveLength(1);
});

test.each(['rename', 'delete'] as const)('actual managed-file restore rejects its old Session fingerprint after concurrent %s', async method => {
  const c = await fixture(), artifacts = new ArtifactStore(c.db, join(c.root, 'artifacts')), at = new Date().toISOString();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  c.db.query("INSERT INTO imports(id,operation_ref,instance_id,state,preview_request_hash,preview_request_json,manifest_path,created_at,updated_at) VALUES(1,'managed-import','management-host','imported','hash','{}','1/manifest.json',?,?)").run(at, at);
  mkdirSync(artifacts.inputPath(1), { recursive: true }); writeFileSync(join(artifacts.inputPath(1), 'data.csv'), 'data-1');
  const files = [{ path: 'data.csv', bytes: 6, sha256: hash('data-1') }], sourceHash = hash(canonicalRequest(files));
  const manifest = { schema: 'medclaw.artifact/import/v1', artifactId: 1, operationRef: 'managed-import', role: 'snapshot_package', files: files.map(file => ({ ...file, path: `input/${file.path}` })),
    sourceHash, metadataHash: hash('metadata'), mappingVersion: 'mapping/v1', calculationVersion: 'diff/v1', sourceLockHash: 'lock', sourceBundleId: 'bundle', materialVersion: 'material/v1', verifiedAt: at };
  const text = canonicalRequest(manifest); writeFileSync(artifacts.manifestPath(1), text);
  c.db.query("INSERT INTO artifacts(id,operation_ref,kind,import_id,format,relative_path,sha256,bytes,metadata_sha256,registered_at,mime_type,metadata_json,status) VALUES(1,'managed-import','import',1,'csv','1',?,6,?,?,'application/x-directory',?,'ready')").run(sourceHash, hash(text), at, text);
  c.db.query('UPDATE imports SET artifact_id=1 WHERE id=1').run();
  c.db.query("INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at) VALUES(1,1,'managed','2026-10-04','浙江','material/v1','bundle','lock',?,'full','cohort',0,0,'[]','{}',1,NULL,1,?)").run(hash('batch-1'), at);
  c.repo.updateWorkspace({ batchIds: [1] }, c.repo.readWorkspace().revision, at);
  const entered = deferred(), resume = deferred(), inspect = artifacts.inspectManagedImport.bind(artifacts);
  const held = spyOn(artifacts, 'inspectManagedImport').mockImplementation(async id => { const result = await inspect(id); expect(result).toEqual({ status: 'valid' }); entered.release(); await resume.promise; return result; });
  const service = new WorkspaceService(c.repo, artifacts);
  try {
    const restore = service.restore(); await entered.promise; const before = c.repo.readWorkspace();
    if (method === 'rename') unwrap(await c.service.rename({ sessionId: c.a.session.id, title: 'Changed during file verification', expectedMetadataRevision: 0 }, c.context('rename-during-restore')));
    else unwrap(await c.service.delete(c.deletion(c.a.session.id), c.context('delete-during-restore')));
    const current = c.repo.readWorkspace(); if (method === 'rename') expect(current).toEqual(before);
    resume.release(); expect(await restore).toMatchObject({ ok: false, error: { reason: 'workspace_revision_mismatch' } });
    expect(c.repo.readWorkspace()).toEqual(current); expect(c.http.requests).toHaveLength(0);
  } finally { resume.release(); held.mockRestore(); }
});

test('deleted Session keeps original native and SQLite history readable and rejects new select/submit/rename', async () => {
  const c = await fixture(), request = c.input(), accepted = unwrap(await c.service.submit(request, c.context('send-history')));
  await c.http.requested; c.http.release(); await until(() => c.app.runs.activeHandle === null);
  const detail = unwrap(await c.service.read(c.a.session.id)), messages = unwrap(await c.service.readMessages({ sessionId: c.a.session.id, leafId: null, afterEntryId: null, limit: 50 }));
  const inputs = c.repo.listInputs({ sessionId: c.a.session.id }), events = c.db.query('SELECT * FROM runtime_events').all();
  unwrap(await c.service.delete(c.deletion(c.a.session.id), c.context('delete-history')));
  expect(unwrap(await c.service.read(c.a.session.id)).history).toEqual(detail.history);
  expect(unwrap(await c.service.readMessages({ sessionId: c.a.session.id, leafId: null, afterEntryId: null, limit: 50 }))).toEqual(messages);
  expect(unwrap(await c.service.readSubmission({ sessionId: c.a.session.id, clientSequence: 1 }))).toEqual(accepted);
  expect(unwrap(await c.service.submit(request, c.context('send-history')))).toEqual(accepted);
  expect(c.repo.listInputs({ sessionId: c.a.session.id })).toEqual(inputs); expect(c.db.query('SELECT * FROM runtime_events').all()).toEqual(events);
  expect(await c.service.select({ sessionId: c.a.session.id, expectedWorkspaceRevision: c.repo.readWorkspace().revision })).toMatchObject({ ok: false, error: { reason: 'session_deleted' } });
  expect(await c.service.submit({ ...request, clientSequence: 2 }, c.context('new-send-deleted'))).toMatchObject({ ok: false, error: { reason: 'session_deleted' } });
  expect(await c.service.rename({ sessionId: c.a.session.id, title: 'Revive', expectedMetadataRevision: 1 }, c.context('new-rename-deleted'))).toMatchObject({ ok: false, error: { reason: 'session_deleted' } });
  expect(c.http.requests).toHaveLength(1); expect(c.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
});

test('actual schema6 Host routes immutable management receipts and permits deleting B while A streams', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-session-management-host-')), http = provider();
  const host = new HostController({ dataRoot: root, hostEntry: resolve('apps/host/src/main.ts'), bunExecutable: process.execPath,
    onCredentialRequest: async frame => frame.method === 'export.destination.settlePrevious' ? { ok: true, data: { stopped: true } } : frame.method === 'credential.list' ? { ok: true, data: [] } : frame.method === 'credential.read'
      ? { ok: true, data: frame.payload.providerId === 'p5-management' ? { type: 'api_key', key: 'fixture-only' } : null } : { ok: false, error: safeError('access_denied') } });
  const initial = new MainSettings(host.paths.settingsPath).read();
  atomicWriteJson(host.paths.settingsPath, PublishedSettingsSchema.parse({ ...initial, model: { provider: 'p5-management', modelId: 'fixture' },
    customProviders: [{ definition: definition(http.url), credentialRef: null }], ...mergeRuntimeConfigurationPolicies(initial, { requestPolicy: { timeoutMs: 10000, maxRetries: 0, maxRetryDelayMs: 2000 } }) }));
  try {
    expect(await host.start()).toMatchObject({ state: 'ready', schemaVersion: DATABASE_SCHEMA_VERSION, error: null });
    const workspace = async () => WorkspaceViewSchema.parse(unwrap(await host.request('workspace.read', {})));
    const a = NewSessionResultSchema.parse(unwrap(await host.request('session.create', { expectedWorkspaceRevision: 0 }, 'host-create-a')));
    const b = NewSessionResultSchema.parse(unwrap(await host.request('session.create', { expectedWorkspaceRevision: (await workspace()).revision }, 'host-create-b')));
    unwrap(await host.request('session.select', { sessionId: a.session.id, expectedWorkspaceRevision: (await workspace()).revision }));
    const request = { mode: 'send', sessionId: a.session.id, clientSequence: 1, text: 'Actual Host management', expectedRevision: (await workspace()).revision,
      expectedBatchIds: [], expectedQueryId: null, model: { provider: 'p5-management', modelId: 'fixture', expectedConfigVersion: '1' }, referenceDate: '2026-10-04', timezone: 'Asia/Shanghai' };
    const accepted = SubmitResultSchema.parse(unwrap(await host.request('session.submit', request, 'host-send-a'))); await http.requested;
    const original = await workspace(), rename = { sessionId: a.session.id, title: 'Host original title', expectedMetadataRevision: 0 };
    const receipt = SessionManagementReceiptSchema.parse(unwrap(await host.request('session.rename', rename, 'host-original-rename')));
    expect(unwrap(await host.request('session.readManagementOperation', { operationRef: 'host-original-rename' }))).toEqual(receipt);
    expect(unwrap(await host.request('session.rename', rename, 'host-original-rename'))).toEqual(receipt);
    expect(await host.request('session.delete', { sessionId: a.session.id, expectedMetadataRevision: 1, expectedWorkspaceRevision: original.revision }, 'host-delete-running')).toMatchObject({ ok: false, error: { reason: 'runtime_busy' } });
    const deleted = SessionManagementReceiptSchema.parse(unwrap(await host.request('session.delete', { sessionId: b.session.id, expectedMetadataRevision: 0, expectedWorkspaceRevision: original.revision }, 'host-delete-b')));
    expect(deleted.session.status).toBe('deleted'); expect(await workspace()).toEqual(original);
    expect(unwrap(await host.request('run.active', {}))).toMatchObject({ runId: accepted.runId, sessionId: a.session.id });
    http.release(); await until(async () => RuntimeControlViewSchema.parse(unwrap(await host.request('run.control.read', {}))).acceptingNewRuns);
    expect(SessionDetailSchema.parse(unwrap(await host.request('session.read', { sessionId: b.session.id }))).session.status).toBe('deleted');
    expect(http.requests).toHaveLength(1);
  } finally { http.release(); if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!); http.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

test.each([['agent', 'rename'], ['agent', 'delete'], ['provider', 'rename'], ['provider', 'delete']] as const)
('actual Host rejects %s operation identity stealing by Session %s during real resolve', async (source, method) => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-session-management-host-identity-')), http = provider(), entered = deferred(), resume = deferred();
  let holdResolve = false;
  const host = new HostController({ dataRoot: root, hostEntry: resolve('apps/host/src/main.ts'), bunExecutable: process.execPath,
    onCredentialRequest: async frame => {
      if (frame.method === 'export.destination.settlePrevious') return { ok: true, data: { stopped: true } };
      if (frame.method === 'credential.list') return { ok: true, data: [] };
      if (frame.method !== 'credential.read') return { ok: false, error: safeError('access_denied') };
      if (holdResolve && frame.payload.providerId === 'p5-management') { entered.release(); await resume.promise; }
      return { ok: true, data: frame.payload.providerId === 'p5-management' ? { type: 'api_key', key: 'fixture-only' } : null };
    } });
  const initial = new MainSettings(host.paths.settingsPath).read();
  atomicWriteJson(host.paths.settingsPath, PublishedSettingsSchema.parse({ ...initial, model: { provider: 'p5-management', modelId: 'fixture' },
    customProviders: [{ definition: definition(http.url), credentialRef: null }], ...mergeRuntimeConfigurationPolicies(initial, { requestPolicy: { timeoutMs: 10000, maxRetries: 0, maxRetryDelayMs: 2000 } }) }));
  try {
    expect(await host.start()).toMatchObject({ state: 'ready', error: null });
    const workspace = async () => WorkspaceViewSchema.parse(unwrap(await host.request('workspace.read', {})));
    const a = NewSessionResultSchema.parse(unwrap(await host.request('session.create', { expectedWorkspaceRevision: 0 }, 'identity-create-a')));
    const b = NewSessionResultSchema.parse(unwrap(await host.request('session.create', { expectedWorkspaceRevision: a.workspace.revision }, 'identity-create-b')));
    unwrap(await host.request('session.select', { sessionId: a.session.id, expectedWorkspaceRevision: b.workspace.revision }));
    const before = await workspace(), operationRef = `host-reserved-${source}`, common = { text: 'Original Host identity', model: { provider: 'p5-management', modelId: 'fixture', expectedConfigVersion: '1' }, referenceDate: '2026-10-04', timezone: 'Asia/Shanghai' };
    holdResolve = true;
    const pending = source === 'agent' ? host.request('session.submit', { ...common, mode: 'send', sessionId: a.session.id, clientSequence: 1, expectedRevision: before.revision, expectedBatchIds: [], expectedQueryId: null }, operationRef)
      : host.request('model.request', common, operationRef);
    await entered.promise;
    expect(unwrap(await host.request('session.readManagementOperation', { operationRef }))).toBeNull();
    expect(await (method === 'rename' ? host.request('session.rename', { sessionId: b.session.id, title: 'Stolen Host identity', expectedMetadataRevision: 0 }, operationRef)
      : host.request('session.delete', { sessionId: b.session.id, expectedMetadataRevision: 0, expectedWorkspaceRevision: before.revision }, operationRef)))
      .toMatchObject({ ok: false, error: { code: 'state_conflict', operationRef } });
    expect(SessionDetailSchema.parse(unwrap(await host.request('session.read', { sessionId: b.session.id }))).session).toMatchObject({ title: b.session.title, metadataRevision: 0, status: 'active' });
    expect(await workspace()).toEqual(before); expect(http.requests).toHaveLength(0);
    expect(unwrap(await host.request('session.readManagementOperation', { operationRef }))).toBeNull();
    expect(SessionManagementReceiptSchema.parse(unwrap(await host.request('session.rename', { sessionId: b.session.id, title: 'Allowed Host B', expectedMetadataRevision: 0 }, `${operationRef}-rename-b`))).session.title).toBe('Allowed Host B');
    expect(SessionManagementReceiptSchema.parse(unwrap(await host.request('session.delete', { sessionId: b.session.id, expectedMetadataRevision: 1, expectedWorkspaceRevision: before.revision }, `${operationRef}-delete-b`))).session.status).toBe('deleted');
    expect(await workspace()).toEqual(before);
    holdResolve = false; resume.release();
    const accepted = unwrap(await pending), runId = source === 'agent' ? SubmitResultSchema.parse(accepted).runId : ProviderAcceptedSchema.parse(accepted).runId;
    await http.requested;
    expect(unwrap(await host.request('run.active', {}))).toEqual({ runId, kind: source === 'agent' ? 'agent' : 'provider', sessionId: source === 'agent' ? a.session.id : null, persistencePending: false, stopPending: false });
    expect(unwrap(await host.request('session.readManagementOperation', { operationRef }))).toBeNull();
    expect(await host.request('session.rename', { sessionId: b.session.id, title: 'Still stolen', expectedMetadataRevision: 2 }, operationRef)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    http.release(); await until(async () => RuntimeControlViewSchema.parse(unwrap(await host.request('run.control.read', {}))).acceptingNewRuns);
    expect(http.requests).toHaveLength(1);
  } finally { holdResolve = false; resume.release(); http.release(); if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!); http.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
