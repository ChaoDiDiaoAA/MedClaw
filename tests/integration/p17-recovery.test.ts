import { expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { RuntimeService } from '../../packages/core/src/runtime/runtime-service';
import { Application } from '../../packages/core/src/application';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import { DEFAULT_INTENT_MODEL, PublishedSettingsSchema } from '../../packages/contracts/src/model';
import type { IntentModelClient } from '../../packages/contracts/src/intent';
import { SubmitInputSchema, SessionDetailSchema, SessionCheckpointPageSchema, SessionCheckpointReceiptSchema } from '../../packages/contracts/src/session';
import { ReadRunResultSchema, RunCleanupRecordSchema, type AgentExecutionObservation } from '../../packages/contracts/src/run';
import { RunToolsViewSchema } from '../../packages/contracts/src/tool';
import { DiagnosticsViewSchema } from '../../packages/contracts/src/protocol';
import { safeError, type Result } from '../../packages/contracts/src/error';
import { nativeHistoryFixture } from '../fixtures/p9-memory';
import { sessionHostFixture } from '../fixtures/p9-host';
import { ImportService } from '../../packages/core/src/data/import-service';
import { SqliteImportStore } from '../../packages/storage/src/import-store';
import { ArtifactStore } from '../../packages/storage/src/artifact-store';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MainSettings } from '../../apps/desktop/src/main/settings';
import { DataDeletionService } from '../../packages/core/src/data/data-deletion-service';
import { SqliteDataDeletionStore } from '../../packages/storage/src/data-deletion-store';
import { SqliteWriteTransactions } from '../../packages/storage/src/write-transactions';
import { DataDeleteOperationSchema } from '../../packages/contracts/src/data-deletion';
import { packageFixture } from '../fixtures/snapshot-package';
import { agentRuntimeFixture } from '../fixtures/agent-runtime';
import { p13AgentInput } from '../fixtures/p13-subagent';

const time = '2026-10-17T00:00:00.000Z';
const proof = { instanceId: 'host-old', basis: 'windows_job_empty' as const, observedAt: time };
const modelRuntime = () => PiModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore() });

for (const moment of ['active', 'settled'] as const) test(`import shutdown refuses an unsaved receipt after the ${moment} operation has stopped`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-import-save-')), db = openDatabase(join(root, 'app.sqlite'));
  const store = new SqliteImportStore(db), artifacts = new ArtifactStore(db, join(root, 'artifacts'));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const service = new ImportService({ store, artifacts, instanceId: 'original-host', resolveToken: async () => {
    entered(); if (moment === 'active') { await gate; return root; } throw new Error('file_token_invalid');
  } });
  try {
    db.exec("CREATE TRIGGER p17_import_save_failure BEFORE UPDATE OF state ON imports BEGIN SELECT RAISE(ABORT,'ENGINEERING receipt save failure'); END;");
    const operation = service.preview({ operationRef: 'original-import', fileToken: 'authorized', mappingVersion: 'medclaw.snapshot/v1' });
    await started;
    if (moment === 'settled') expect(await operation).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    const shutdown = service.shutdown().then(() => null, error => error);
    release(); expect(await operation).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(await shutdown).toMatchObject({ message: 'operation_result_unknown' });
    expect(store.read('original-import')).toMatchObject({ instanceId: 'original-host', operation: { state: 'preparing', error: null, result: null } });
    db.exec('DROP TRIGGER p17_import_save_failure');
    await expect(service.shutdown()).rejects.toThrow('operation_result_unknown');
    const restarted = new ImportService({ store: new SqliteImportStore(db), artifacts, instanceId: 'new-host',
      resolveToken: () => { throw new Error('ENGINEERING recovery must not replay source access'); } });
    expect(await restarted.recover('original-import')).toMatchObject({ ok: true, data: { operationRef: 'original-import', state: 'interrupted', result: null, error: { code: 'host_interrupted' } } });
    expect(db.query('SELECT COUNT(*) n FROM batches').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) n FROM model_calls').get()).toEqual({ n: 0 });
    await restarted.shutdown();
  } finally {
    release(); await service.shutdown().catch(() => {}); db.close();
    const part = relative(realpathSync(tmpdir()), realpathSync(root));
    if (part === '..' || part.startsWith('../') || part.startsWith('..\\') || isAbsolute(part)) throw new Error('ENGINEERING fixture root escaped temp');
    rmSync(root, { recursive: true, force: true });
  }
});

test('real Host cannot claim required persistence after an import receipt save failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-host-import-save-'));
  let sourceRequests = 0, failed = false;
  const host = new HostController({ dataRoot: root, hostEntry: join(import.meta.dir, '../../apps/host/src/main.ts'), bunExecutable: process.execPath,
    onCredentialRequest: async frame => {
      if (frame.method === 'file.resolve') {
        sourceRequests++;
        const fault = new Database(host.paths.databasePath);
        try { fault.exec("CREATE TRIGGER p17_import_save_failure BEFORE UPDATE OF state ON imports BEGIN SELECT RAISE(ABORT,'ENGINEERING receipt save failure'); END;"); }
        finally { fault.close(); }
        return { ok: false, error: safeError('file_token_invalid') };
      }
      return { ok: true, data: frame.method === 'credential.list' ? [] : frame.method === 'export.destination.settlePrevious' ? { stopped: true } : null };
    } });
  try {
    new MainSettings(host.paths.settingsPath).read();
    expect(await host.start()).toMatchObject({ state: 'ready' });
    expect(await host.request('import.preview', { operationRef: 'original-import', fileToken: 'authorized', mappingVersion: 'medclaw.snapshot/v1' }, 'original-import'))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(await host.stop(host.read().instanceId!)).toMatchObject({ state: 'failed', shutdown: {
      requiredPersistenceComplete: null, databaseClosed: null, processExited: true, processTreeStopped: true, error: { code: 'operation_result_unknown' } } });
    const stopped = new Database(host.paths.databasePath);
    try {
      expect(stopped.query('SELECT operation_ref,state,result_json FROM imports').all()).toEqual([{ operation_ref: 'original-import', state: 'preparing', result_json: null }]);
      stopped.exec('DROP TRIGGER p17_import_save_failure');
    } finally { stopped.close(); }
    expect(await host.start()).toMatchObject({ state: 'ready' });
    expect(sourceRequests).toBe(1);
    expect(await host.request('import.recover', { operationRef: 'original-import' }, 'original-import'))
      .toMatchObject({ ok: true, data: { operationRef: 'original-import', state: 'interrupted', result: null } });
    expect(sourceRequests).toBe(1);
    expect(await host.stop(host.read().instanceId!)).toMatchObject({ state: 'stopped', shutdown: { requiredPersistenceComplete: true } });
  } catch (error) { failed = true; throw error; }
  finally {
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    if (!host.read().canStart || host.read().shutdown?.processTreeStopped !== true) {
      console.error('P17_HOST_FIXTURE_RETAINED ' + JSON.stringify({ root, instanceId: host.read().instanceId }));
      if (!failed) throw new Error('ENGINEERING Host stop unconfirmed; fixture retained');
    } else {
      const part = relative(realpathSync(tmpdir()), realpathSync(root));
      if (part === '..' || part.startsWith('../') || part.startsWith('..\\') || isAbsolute(part)) throw new Error('ENGINEERING fixture root escaped temp');
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 45000);
for (const window of ['active', 'settled', 'lost-ack'] as const) test(`deletion shutdown preserves facts after ${window} cleanup save failure`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-deletion-save-')), source = join(root, 'source'); packageFixture(source);
  const db = openDatabase(join(root, 'app.sqlite')), repo = new Repositories(db), artifacts = new ArtifactStore(db, join(root, 'artifacts'));
  const imports = new ImportService({ store: new SqliteImportStore(db), artifacts, instanceId: 'original-host', resolveToken: () => source });
  const store = new SqliteDataDeletionStore(db, repo), service = new DataDeletionService(store, artifacts, 'original-host');
  const transactions = SqliteWriteTransactions.forDatabase(db), immediate = transactions.immediate.bind(transactions), deleteFile = artifacts.deleteManagedFile.bind(artifacts);
  let entered!: () => void, release!: () => void, deletionCalls = 0, lostAck = false;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  try {
    unwrap(await imports.preview({ operationRef: 'original-import', fileToken: 'authorized', mappingVersion: 'medclaw.snapshot/v1' }));
    unwrap(await imports.commit({ operationRef: 'original-import', fileToken: 'authorized' }));
    const originalSource = readFileSync(join(source, 'zhejiang_2026-01-02.csv'));
    const preview = unwrap(await service.preview({ operationRef: 'original-delete', target: { kind: 'batches', batchIds: [2] }, expectedCatalogRevision: 1, expectedWorkspaceRevision: repo.readWorkspace().revision }));
    const input = { operationRef: 'original-delete', expectedCatalogRevision: 1, expectedWorkspaceRevision: preview.preview.workspaceRevision };
    artifacts.deleteManagedFile = async (...args) => { deletionCalls++; if (deletionCalls === 1) { entered(); await gate; } await deleteFile(...args); };
    const operation = service.commit(input); await started;
    const receipt = store.read('original-delete')!.receipt;
    if (window === 'lost-ack') transactions.immediate = <T>(action: () => T): T => {
      const value = immediate(action);
      if (!lostAck && db.query<{ state: string }, []>("SELECT json_extract(cleanup_json,'$.state') state FROM data_deletions WHERE operation_ref='original-delete'").get()?.state === 'complete') {
        lostAck = true; throw new Error('ENGINEERING cleanup acknowledgement lost after commit');
      }
      return value;
    };
    else db.exec("CREATE TRIGGER p17_cleanup_save_failure BEFORE UPDATE OF cleanup_json ON data_deletions BEGIN SELECT RAISE(ABORT,'ENGINEERING cleanup save failure'); END;");
    const shutdown = window === 'active' ? service.shutdown().then(() => null, error => error) : null;
    release(); const result = await operation;
    expect(store.read('original-delete')).toMatchObject({ state: 'committed', receipt, cleanup: { state: window === 'lost-ack' ? 'complete' : 'pending' } });
    expect(result.ok).toBe(false);
    if (window === 'lost-ack') expect(lostAck).toBe(true);
    expect(shutdown ? await shutdown : await service.shutdown().then(() => null, error => error)).toMatchObject({ message: 'operation_result_unknown' });
    transactions.immediate = immediate;
    if (window !== 'lost-ack') db.exec('DROP TRIGGER p17_cleanup_save_failure');
    expect(await service.read('original-delete')).toMatchObject({ ok: true, data: { state: 'committed', receipt } });
    expect(() => store.assertIdle('original-delete')).toThrow('operation_result_unknown');
    expect(await service.recover('original-delete')).toMatchObject({ ok: false, error: { code: 'host_interrupted' } });
    await expect(service.shutdown()).rejects.toThrow('operation_result_unknown');
    const callsBeforeRestart = deletionCalls;
    await new DataDeletionService(new SqliteDataDeletionStore(db, repo), artifacts, 'observer-host').shutdown();
    expect(deletionCalls).toBe(callsBeforeRestart);
    expect(store.read('original-delete')).toMatchObject({ cleanup: { state: window === 'lost-ack' ? 'complete' : 'pending' } });
    const restarted = new DataDeletionService(new SqliteDataDeletionStore(db, repo), artifacts, 'new-host');
    expect(await restarted.commit(input)).toMatchObject({ ok: true, data: { state: 'committed', receipt } });
    expect(deletionCalls).toBe(callsBeforeRestart);
    expect(await restarted.recover('original-delete')).toMatchObject({ ok: true, data: { state: 'committed', receipt, cleanup: { state: 'complete' } } });
    if (window === 'lost-ack') expect(deletionCalls).toBe(callsBeforeRestart);
    expect(db.query("SELECT COUNT(*) n FROM business_events WHERE type='data.batch_deleted'").get()).toEqual({ n: 1 });
    expect(db.query('SELECT revision FROM catalog_state').get()).toEqual({ revision: 2 });
    expect(db.query('SELECT COUNT(*) n FROM model_calls').get()).toEqual({ n: 0 });
    expect(readFileSync(join(source, 'zhejiang_2026-01-02.csv'))).toEqual(originalSource);
    await restarted.shutdown(); await imports.shutdown();
  } finally {
    release(); transactions.immediate = immediate;
    await service.shutdown().catch(() => {}); await imports.shutdown().catch(() => {});
    artifacts.deleteManagedFile = deleteFile; db.close();
    const part = relative(realpathSync(tmpdir()), realpathSync(root));
    if (part === '..' || part.startsWith('../') || part.startsWith('..\\') || isAbsolute(part)) throw new Error('ENGINEERING fixture root escaped temp');
    rmSync(root, { recursive: true, force: true });
  }
});

test('real Host cannot claim required persistence after a batch deletion cleanup save failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-host-deletion-save-')), source = join(root, 'source'); packageFixture(source);
  let sourceRequests = 0, failed = false;
  const host = new HostController({ dataRoot: root, hostEntry: join(import.meta.dir, '../../apps/host/src/main.ts'), bunExecutable: process.execPath,
    onCredentialRequest: async frame => {
      if (frame.method === 'file.resolve') { sourceRequests++; return { ok: true, data: source }; }
      return { ok: true, data: frame.method === 'credential.list' ? [] : frame.method === 'export.destination.settlePrevious' ? { stopped: true } : null };
    } });
  try {
    new MainSettings(host.paths.settingsPath).read(); expect(await host.start()).toMatchObject({ state: 'ready' });
    unwrap(await host.request('import.preview', { operationRef: 'original-import', fileToken: 'authorized', mappingVersion: 'medclaw.snapshot/v1' }, 'original-import'));
    unwrap(await host.request('import.commit', { operationRef: 'original-import', fileToken: 'authorized' }, 'original-import'));
    const preview = DataDeleteOperationSchema.parse(unwrap(await host.request('data.delete.preview', { operationRef: 'original-delete', target: { kind: 'batches', batchIds: [2] }, expectedCatalogRevision: 1, expectedWorkspaceRevision: 0 }, 'original-delete')));
    const input = { operationRef: 'original-delete', expectedCatalogRevision: 1, expectedWorkspaceRevision: preview.preview.workspaceRevision };
    const fault = new Database(host.paths.databasePath);
    try { fault.exec("CREATE TRIGGER p17_cleanup_save_failure BEFORE UPDATE OF cleanup_json ON data_deletions WHEN OLD.state='committed' BEGIN SELECT RAISE(ABORT,'ENGINEERING cleanup save failure'); END;"); }
    finally { fault.close(); }
    expect(await host.request('data.delete.commit', input, 'original-delete')).toMatchObject({ ok: false });
    expect(await host.stop(host.read().instanceId!)).toMatchObject({ state: 'failed', shutdown: {
      requiredPersistenceComplete: null, databaseClosed: null, processExited: true, processTreeStopped: true, error: { code: 'operation_result_unknown' } } });
    const stopped = new Database(host.paths.databasePath); let receipt: string;
    try {
      receipt = stopped.query<{ receipt_json: string }, []>('SELECT receipt_json FROM data_deletions').get()!.receipt_json;
      expect(stopped.query("SELECT state,json_extract(cleanup_json,'$.state') cleanup FROM data_deletions").get()).toEqual({ state: 'committed', cleanup: 'pending' });
      stopped.exec('DROP TRIGGER p17_cleanup_save_failure');
    } finally { stopped.close(); }
    expect(await host.start()).toMatchObject({ state: 'ready' });
    expect(sourceRequests).toBe(2);
    expect(await host.request('data.delete.read', { operationRef: 'original-delete' }, 'original-delete')).toMatchObject({ ok: true, data: { state: 'committed', cleanup: { state: 'pending' } } });
    expect(await host.request('data.delete.recover', { operationRef: 'original-delete' }, 'original-delete')).toMatchObject({ ok: true, data: { state: 'committed', cleanup: { state: 'complete' } } });
    const checked = new Database(host.paths.databasePath, { readonly: true });
    try {
      expect(checked.query('SELECT receipt_json FROM data_deletions').get()).toEqual({ receipt_json: receipt });
      expect(checked.query("SELECT COUNT(*) n FROM business_events WHERE type='data.batch_deleted'").get()).toEqual({ n: 1 });
      expect(checked.query('SELECT revision FROM catalog_state').get()).toEqual({ revision: 2 });
      expect(checked.query('SELECT COUNT(*) n FROM model_calls').get()).toEqual({ n: 0 });
    } finally { checked.close(); }
    expect(sourceRequests).toBe(2);
    expect(await host.stop(host.read().instanceId!)).toMatchObject({ state: 'stopped', shutdown: { requiredPersistenceComplete: true } });
  } catch (error) { failed = true; throw error; }
  finally {
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    if (!host.read().canStart || host.read().shutdown?.processTreeStopped !== true) {
      console.error('P17_HOST_FIXTURE_RETAINED ' + JSON.stringify({ root, instanceId: host.read().instanceId }));
      if (!failed) throw new Error('ENGINEERING Host stop unconfirmed; fixture retained');
    } else {
      const part = relative(realpathSync(tmpdir()), realpathSync(root));
      if (part === '..' || part.startsWith('../') || part.startsWith('..\\') || isAbsolute(part)) throw new Error('ENGINEERING fixture root escaped temp');
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 45000);

function fixture(name: 'grep' | 'bash', startExecution = true) {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-recovery-')), db = openDatabase(join(root, 'app.sqlite')), repo = new Repositories(db);
  const sessionId = repo.createSession({ expectedWorkspaceRevision: 0 }, 'create', 'native', time).session.id, workspace = repo.readWorkspace();
  const request = SubmitInputSchema.parse({ sessionId, clientSequence: 1, text: 'ENGINEERING interrupted query', mode: 'send', expectedRevision: workspace.revision,
    expectedBatchIds: [], expectedQueryId: null, model: { provider: 'test', modelId: 'text', expectedConfigVersion: '1' }, referenceDate: '2026-10-17', timezone: 'Asia/Shanghai' });
  const policy = { timeoutMs: 1000, maxRetries: 0 as const, maxRetryDelayMs: 2000 };
  const model = { provider: 'test', modelId: 'text', endpointRef: null, api: 'openai-completions', configVersion: '1', credentialRef: null,
    maxOutputTokens: 1024, capabilitySource: 'pi_catalog' as const, sdkVersion: '0.87.1' as const };
  const runId = repo.registerAgent({ sessionId, inputId: null, text: request.text, model, policy, goal: 'answer', workspace,
    scope: { batchIds: [], deviceIds: null, allowedToolNames: [name], allowedResourceRefs: [], artifactIds: [], readOnly: name === 'grep' },
    referenceDate: request.referenceDate, timezone: request.timezone, timeoutMs: policy.timeoutMs, submission: { operationRef: 'submit', originalSubmitInput: request },
    instanceId: 'host-old', agentOptions: { requestedThinkingLevel: 'off', effectiveThinkingLevel: 'off' }, createdAt: time }).runId;
  if (startExecution) {
    repo.startCall(runId, 'model-1', 'main', time);
    db.query(`INSERT INTO tool_calls(session_id,run_id,native_tool_call_id,model_call_id,tool_name,tool_version,effect,execution_mode,args_json,status,requested_at,started_at)
      VALUES(?,?,'tool-1',(SELECT id FROM model_calls WHERE call_id='model-1'),?,'0.87.1',?,'parallel','{}','running',?,?)`)
      .run(sessionId, runId, name, name === 'grep' ? 'READ' : 'LOCAL_WRITE', time, time);
  }
  const settings = PublishedSettingsSchema.parse({ schemaVersion: 'medclaw.settings/p1-v1', configVersion: '1', model: null, customProviders: [], credentialRefs: {},
    requestPolicy: policy, ui: { navCollapsed: false, detailOpen: false, detailTab: 'conditions' }, previous: null, rollbackFromVersion: null });
  return { root, db, repo, runId, settings };
}
test('a created Run recovers its original submission without starting calls, tools or a replacement Run', async () => {
  const c = fixture('grep', false); let requests = 0;
  try {
    expect(c.repo.read({ runId: c.runId })).toMatchObject({ kind: 'one', run: { status: 'created', startedAt: null, stoppedAt: null, endedAt: null, calls: [] } });
    const identitySql = 'SELECT id,session_id,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,input_text,created_at,started_at,stopped_at FROM runs WHERE id=?';
    const original = c.db.query(identitySql).get(c.runId);
    const runtime = new RuntimeService('host-new', () => c.settings, await modelRuntime(), c.repo, (_context, action) => action(),
      () => { requests++; throw new Error('Recovery must not request a model'); }, () => {}, () => {}, undefined, () => false);
    runtime.recoverInterrupted(false, proof);
    expect(await runtime.readControl()).toMatchObject({ ok: true, data: { acceptingNewRuns: false } });
    expect(c.db.query(identitySql).get(c.runId)).toEqual(original);
    expect(c.repo.read({ runId: c.runId })).toMatchObject({ kind: 'one', run: { status: 'created', error: null } });
    runtime.recoverInterrupted(true, proof);
    expect(await runtime.readControl()).toMatchObject({ ok: true, data: { acceptingNewRuns: true } });
    const recovered = c.repo.read({ runId: c.runId });
    expect(recovered).toMatchObject({ kind: 'one', run: { id: c.runId, status: 'failed', startedAt: null, stoppedAt: null, calls: [],
      error: { code: 'runtime_interrupted' }, cleanup: { executionStarted: null, stopConfirmed: true, requiredPersistenceComplete: true,
        inputsSettled: true, resourcesReleased: true, processTreeProof: proof } } });
    expect(c.db.query(identitySql).get(c.runId)).toEqual(original);
    expect(c.db.query('SELECT (SELECT count(*) FROM runs) runs,(SELECT count(*) FROM model_calls) calls,(SELECT count(*) FROM tool_calls) tools,(SELECT count(*) FROM queries) queries').get())
      .toEqual({ runs: 1, calls: 0, tools: 0, queries: 0 });
    runtime.recoverInterrupted(true, proof);
    expect(c.repo.read({ runId: c.runId })).toEqual(recovered); expect(requests).toBe(0);
  } finally {
    c.db.close();
    const target = realpathSync(c.root), parent = realpathSync(tmpdir()), part = relative(parent, target);
    if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('ENGINEERING recovery cleanup root changed');
    rmSync(target, { recursive: true, force: true });
  }
});

for (const terminal of [null, 'failed', 'cancelled'] as const)
for (const unknownCleanup of terminal === null ? [false] : [false, true])
test('matching Job proof closes a read-only tool gap while preserving original ' + (terminal ?? 'nonterminal') + ' facts' + (unknownCleanup ? ' with unknown cleanup' : ''), async () => {
  const c = fixture('grep');
  try {
    const originalError = safeError('storage_write_failed');
    if (terminal) c.db.query("UPDATE runs SET status=?,ended_at=?,error_json=? WHERE id=?").run(terminal, time, JSON.stringify(originalError), c.runId);
    const priorCleanup = unknownCleanup ? RunCleanupRecordSchema.parse({ contract: 'medclaw.run-cleanup/v1', executionStarted: true, stopConfirmed: null,
      requiredPersistenceComplete: false, inputsSettled: true, resourcesReleased: false, unconfirmedItems: ['stop', 'resources'],
      secondaryErrors: [safeError('storage_write_failed')], verifiedAt: null }) : null;
    if (priorCleanup) c.db.query('UPDATE runs SET cleanup_json=? WHERE id=?').run(JSON.stringify(priorCleanup), c.runId);
    const runtime = new RuntimeService('host-new', () => c.settings, await modelRuntime(), c.repo, (_context, action) => action(),
      () => { throw new Error('Recovery must not request a model'); }, () => {}, () => {}, undefined, () => false);
    runtime.recoverInterrupted(true, proof);
    expect(await runtime.readControl()).toMatchObject({ ok: true, data: { acceptingNewRuns: true } });
    expect(c.repo.read({ runId: c.runId })).toMatchObject({ kind: 'one', run: { status: terminal ?? 'failed',
      ...(terminal ? { error: originalError, endedAt: time } : {}), cleanup: { stopConfirmed: true, requiredPersistenceComplete: true, processTreeProof: proof,
        ...(priorCleanup ? { executionStarted: true, secondaryErrors: priorCleanup.secondaryErrors } : {}) } } });
    expect(c.db.query('SELECT status,result_json,stopped_at FROM tool_calls').get()).toEqual({ status: 'failed', stopped_at: time,
      result_json: JSON.stringify({ outcomeUnknown: true, recoveredAfterHostExit: true }) });
    expect(c.db.query('SELECT count(*) n FROM model_calls').get()).toEqual({ n: 1 });
    expect(c.db.query('SELECT count(*) n FROM queries').get()).toEqual({ n: 0 });
  } finally { c.db.close(); rmSync(c.root, { recursive: true, force: true }); }
});
test('a different Job owner does not release a command and a valid proof does not hide unknown local writes', () => {
  const c = fixture('bash');
  try {
    const rows = c.db.query('SELECT * FROM tool_calls').all();
    expect(c.repo.verifyPriorToolFacts(c.runId, true, time, { ...proof, instanceId: 'unrelated' }).stopConfirmed).toBe(null);
    expect(c.db.query('SELECT * FROM tool_calls').all()).toEqual(rows);
    expect(c.repo.verifyPriorToolFacts(c.runId, true, time, proof)).toMatchObject({ stopConfirmed: true, requiredPersistenceComplete: false, unconfirmedItems: ['tool_effect_unknown'] });
  } finally { c.db.close(); rmSync(c.root, { recursive: true, force: true }); }
});
for (const outcome of ['completed', 'failed'] as const) test(`Application shutdown waits for aborted metadata refresh ${outcome} before declaring execution stopped`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-refresh-stop-')), db = openDatabase(join(root, 'app.sqlite'));
  const runtime = await modelRuntime(), app = new Application('host-refresh', new MainSettings(join(root, 'settings.json')).read(), runtime,
    new Repositories(db), (_context, action) => action(), () => { throw new Error('ENGINEERING no model request expected'); }, () => {});
  let release!: () => void, calls = 0, aborted = false, shutdownComplete = false;
  const held = new Promise<void>(resolve => { release = resolve; }), failure = new Error('ENGINEERING metadata refresh failure');
  const refresh = spyOn(runtime, 'refresh').mockImplementation(async (_provider, signal) => {
    calls++; signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    await held;
    if (outcome === 'failed') throw failure;
    return { aborted: signal.aborted, errors: [] };
  });
  const original = app.refresh('refresh-original', 'openai').then(value => ({ value }), error => ({ error }));
  const stopping = app.shutdown().then(value => { shutdownComplete = true; return value; });
  try {
    await Bun.sleep(0);
    expect(aborted).toBe(true); expect(shutdownComplete).toBe(false);
    expect(app.cancelOperation('refresh-original')).toEqual({ cancelRequested: true, settled: false });
    await expect(app.refresh('refresh-later', 'openai')).rejects.toThrow('runtime_busy');
    release();
    expect(await stopping).toEqual({ executionStopped: true });
    expect(await original).toEqual(outcome === 'failed' ? { error: failure } : { value: { aborted: true, errors: [] } });
    expect(app.cancelOperation('refresh-original')).toEqual({ cancelRequested: false, settled: true });
    expect(calls).toBe(1);
  } finally {
    release(); await Promise.allSettled([original, stopping]); refresh.mockRestore(); db.close();
    const target = realpathSync(root), part = relative(realpathSync(tmpdir()), target);
    if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('ENGINEERING refresh cleanup root changed');
    rmSync(target, { recursive: true, force: true });
  }
});

for (const variant of ['main', 'child', 'save_failure'] as const) {
const saveFailure = variant === 'save_failure', child = variant === 'child', requestCount = child ? 2 : 1;
test(`Application shutdown stops its real ${child ? 'parent and child Agents' : 'Agent'} before delayed inspection cleanup${saveFailure ? ' and retains a failed Run save' : ''}`, async () => {
  let release!: () => void, inspectionAborted = false, inspections = 0, socketClosed = false, shutdownComplete = false, failed = false;
  const held = new Promise<void>(resolve => { release = resolve; }), inspectionFailure = safeError('intent_model_unavailable');
  const client: IntentModelClient = {
    prompts: { classify: { text: 'ENGINEERING unused classify', version: 'engineering/v1' }, verify: { text: 'ENGINEERING unused verify', version: 'engineering/v1' } },
    async inspect(_configuration, signal) {
      inspections++; if (!signal) throw new Error('ENGINEERING inspection requires its owner signal');
      signal.addEventListener('abort', () => { inspectionAborted = true; }, { once: true });
      await held; throw inspectionFailure;
    },
    async recognizeIntent() { throw new Error('ENGINEERING no inference expected from a settings inspection'); },
  };
  const f = await agentRuntimeFixture(index => child && index === 1
    ? { role: 'assistant', tool_calls: [{ index: 0, id: 'p17-order-child', type: 'function', function: { name: 'Agent', arguments: JSON.stringify(p13AgentInput) } }] }
    : new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ id: 'p17-stop-order', model: 'fixture',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ENGINEERING pending main response' }, finish_reason: null }] }) + '\n\n')); },
    cancel() { socketClosed = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }), false, undefined, { client, configuration: { ...DEFAULT_INTENT_MODEL, enabled: false } });
  let runId: number | null = null, inspection: Promise<unknown> | undefined, stopping: Promise<unknown> | undefined;
  let fault: ReturnType<typeof spyOn<Repositories, 'finalizeAgent'>> | undefined;
  let historyChange: AgentExecutionObservation['history']; const execute = f.agent.execute.bind(f.agent);
  const observation = spyOn(f.agent, 'execute').mockImplementation(async (...args) => {
    const value = await execute(...args); historyChange = value.history ? structuredClone(value.history) : undefined; return value;
  });
  try {
    const accepted = unwrap(await f.app.runs.submitAgent(f.request('ENGINEERING main shutdown ownership'), { instanceId: 'host', operationRef: 'p17-order-main' }));
    if (accepted.runId === null) throw new Error('ENGINEERING main Run was not accepted'); runId = accepted.runId;
    await until(async () => f.requests.length === requestCount);
    inspection = f.app.inspectIntentModel({ baseUrl: DEFAULT_INTENT_MODEL.baseUrl, modelTag: DEFAULT_INTENT_MODEL.modelTag })
      .then(value => ({ value }), error => ({ error }));
    if (saveFailure) fault = spyOn(f.repos, 'finalizeAgent').mockImplementation(() => { throw safeError('storage_write_failed'); });
    stopping = f.app.shutdown().then(value => { shutdownComplete = true; return { value }; }, error => { shutdownComplete = true; return { error }; });
    expect(inspectionAborted).toBe(true); expect(inspections).toBe(1);
    const deadline = Date.now() + 2000; let stopped = false;
    while (Date.now() < deadline) {
      const original = f.repos.read({ runId });
      if (!f.app.stopPending && (saveFailure ? f.app.persistencePending : original.kind === 'one' && original.run?.status === 'failed' && original.run.error?.code === 'host_interrupted')) { stopped = true; break; }
      await Bun.sleep(5);
    }
    expect(stopped).toBe(true); expect(f.app.stopPending).toBe(false); expect(f.app.persistencePending).toBe(saveFailure);
    expect(shutdownComplete).toBe(false); expect(f.agent.readAvailability(1).availability).not.toBe('unloaded');
    await until(async () => socketClosed); expect(f.requests).toHaveLength(requestCount);
    const history = f.repos.readHistorySnapshot(1); if (!history) throw new Error('ENGINEERING persisted history unavailable');
    if (saveFailure) {
      const control = unwrap(await f.app.runs.readControl()); expect(control.acceptingNewRuns).toBe(false);
      expect(control.blockReasons).toContainEqual(expect.objectContaining({ code: 'storage_write_failed', runId }));
    }
    else expect(f.repos.read({ runId })).toMatchObject({ kind: 'one', run: { status: 'failed', error: { code: 'host_interrupted' },
      calls: [child ? { state: 'completed', sdkStopReason: 'toolUse' } : { state: 'cancelled', sdkStopReason: 'aborted' }],
      cleanup: { stopConfirmed: true, requiredPersistenceComplete: true, resourcesReleased: true } } });
    if (child) {
      const children = f.db.query<{ id: number; session_id: number }, []>("SELECT id,session_id FROM runs WHERE kind='child'").all();
      expect(children).toHaveLength(1); const owned = children[0]!;
      expect(owned.session_id).not.toBe(1); expect(f.repos.readSession(owned.session_id)).toBeNull();
      expect(f.repos.read({ runId: owned.id })).toMatchObject({ kind: 'one', run: { kind: 'child', parentRunId: runId, status: 'cancelled',
        error: { code: 'tool_cancelled' }, calls: [{ state: 'cancelled', sdkStopReason: 'aborted' }],
        cleanup: { stopConfirmed: true, requiredPersistenceComplete: true, resourcesReleased: true }, childResult: { parentRunId: runId, childSessionId: owned.session_id } } });
      expect(f.repos.readWorkspace().sessionId).toBe(1);
    }
    release(); expect(await inspection).toEqual({ error: inspectionFailure });
    if (saveFailure) {
      expect(await stopping).toMatchObject({ error: { message: 'storage_write_failed' } });
      expect(f.agent.readAvailability(1).availability).not.toBe('unloaded'); fault!.mockRestore(); fault = undefined;
      expect(await f.app.runs.retrySave(runId)).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'host_interrupted' },
        calls: [{ state: 'cancelled', sdkStopReason: 'aborted' }], cleanup: { stopConfirmed: true, requiredPersistenceComplete: true } } });
      expect(await f.app.shutdown()).toEqual({ executionStopped: true });
      if (!historyChange) throw new Error('ENGINEERING original SDK history change unavailable');
      expect(historyChange.expectedStorageVersion).toBe(history.storageVersion);
      expect(f.repos.readHistorySnapshot(1)).toEqual({ ...history, header: historyChange.header, activeLeafId: historyChange.activeLeafId,
        storageVersion: history.storageVersion + 1, entries: [...history.entries, ...historyChange.newEntries] });
    } else {
      expect(await stopping).toEqual({ value: { executionStopped: true } }); expect(f.repos.readHistorySnapshot(1)).toEqual(history);
    }
    expect(f.agent.readAvailability(1).availability).toBe('unloaded'); expect(f.requests).toHaveLength(requestCount);
  } catch (error) { failed = true; throw error; }
  finally {
    release(); fault?.mockRestore(); await Promise.allSettled([inspection, stopping]); observation.mockRestore();
    try {
      if (runId !== null && f.app.persistencePending) { const saved = await f.app.runs.retrySave(runId); if (!saved.ok) throw saved.error; }
      await f.app.shutdown();
      const target = realpathSync(f.root), part = relative(realpathSync(tmpdir()), target);
      if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('ENGINEERING shutdown fixture root changed');
      await f.close();
    } catch (error) { console.error('P17_SHUTDOWN_ORDER_FIXTURE_RETAINED ' + JSON.stringify({ root: f.root })); if (!failed) throw error; }
  }
}, 20000);
}

test('Application shutdown cancels the original SDK auth prompt and waits for its cleanup before disposing Sessions', async () => {
  const f = await agentRuntimeFixture();
  let release!: () => void, loginSettled = false, shutdownComplete = false, logins = 0, failed = false;
  const held = new Promise<void>(resolve => { release = resolve; }), original = f.runtime.login.bind(f.runtime);
  const login = spyOn(f.runtime, 'login').mockImplementation(async (...args) => {
    logins++;
    try { return await original(...args); }
    finally { loginSettled = true; await held; }
  });
  let stopping: Promise<unknown> | undefined;
  try {
    const history = f.repos.readHistorySnapshot(1);
    expect(f.runtime.supportsAuth('p11-fixture', 'api_key')).toBe(true);
    const attempt = await f.app.startAuth('p17-shutdown-auth', 'p11-fixture', 'api_key');
    await until(async () => (await f.app.authStatus('p11-fixture', attempt.authAttemptId)).attempt?.state === 'waiting_input');
    const promptId = (await f.app.authStatus('p11-fixture', attempt.authAttemptId)).attempt?.pendingPromptId;
    if (!promptId) throw new Error('ENGINEERING original SDK auth prompt unavailable');
    stopping = f.app.shutdown().then(value => { shutdownComplete = true; return { value }; }, error => { shutdownComplete = true; return { error }; });
    await until(async () => loginSettled);
    expect(shutdownComplete).toBe(false); expect(f.agent.readAvailability(1).availability).not.toBe('unloaded');
    expect(() => f.app.respondAuth(attempt.authAttemptId, promptId, 'ENGINEERING obsolete input')).toThrow('auth_prompt_invalid');
    release(); expect(await stopping).toEqual({ value: { executionStopped: true } });
    const status = await f.app.authStatus('p11-fixture', attempt.authAttemptId);
    expect(status).toMatchObject({ auth: { state: 'available', type: 'api_key' }, attempt: { state: 'cancelled', pendingPromptId: null, error: null, endedAt: expect.any(String) } });
    expect(f.agent.readAvailability(1).availability).toBe('unloaded'); expect(logins).toBe(1);
    expect(f.repos.readHistorySnapshot(1)).toEqual(history); expect(f.repos.read({ recent: true })).toMatchObject({ kind: 'recent', runs: [] });
    expect(f.requests).toHaveLength(0); expect(f.db.query('SELECT id FROM model_calls').all()).toEqual([]);
  } catch (error) { failed = true; throw error; }
  finally {
    release(); await Promise.allSettled([stopping]); login.mockRestore();
    try {
      await f.app.shutdown();
      const target = realpathSync(f.root), part = relative(realpathSync(tmpdir()), target);
      if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('ENGINEERING auth shutdown fixture root changed');
      await f.close();
    } catch (error) { console.error('P17_AUTH_SHUTDOWN_FIXTURE_RETAINED ' + JSON.stringify({ root: f.root })); if (!failed) throw error; }
  }
}, 20000);

test('shutdown disposes every idle native Session binding without deleting its saved history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-sessions-'));
  try {
    const history = nativeHistoryFixture(), agent = new PiAgentRuntime(await modelRuntime(), root, history.history);
    history.bind(agent, 1); history.bind(agent, 2);
    expect(agent.readAvailability(1).availability).toBe('ready'); expect(agent.readAvailability(2).availability).toBe('ready');
    await agent.disposeIdleSessions();
    expect(agent.readAvailability(1).availability).toBe('unloaded'); expect(agent.readAvailability(2).availability).toBe('unloaded');
    expect((await history.history.store.load(1)).ok).toBe(true); expect((await history.history.store.load(2)).ok).toBe(true);
    await agent.ensureLoaded(2); expect(agent.readAvailability(2).availability).toBe('ready'); await agent.disposeIdleSessions();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('an idle binding with an unsaved native mutation cannot be discarded during shutdown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-session-save-'));
  try {
    const history = nativeHistoryFixture();
    const agent = new PiAgentRuntime(await modelRuntime(), root, { ...history.history, commitSync: () => { throw safeError('storage_write_failed'); } });
    history.bind(agent, 1);
    const bindings = Reflect.get(agent, 'sessions') as Map<number, { manager: import('@earendil-works/pi-coding-agent').SessionManager }>;
    try { bindings.get(1)!.manager.appendCustomEntry('ENGINEERING unsaved', { value: 1 }); } catch {}
    await expect(agent.disposeIdleSessions()).rejects.toMatchObject({ code: 'storage_write_failed' });
    expect(agent.readAvailability(1).availability).toBe('blocked'); expect(bindings.has(1)).toBe(true);
    expect(await history.history.store.load(1)).toMatchObject({ ok: true, data: { entries: [], storageVersion: 1 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function unwrap<T>(result: Result<T>): T { if (!result.ok) throw result.error; return result.data; }
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!await check()) { if (Date.now() > end) throw new Error('ENGINEERING recovery condition timeout'); await Bun.sleep(10); }
}

for (const name of ['grep', 'find'] as const) for (const interruption of ['timeout', 'cancel', 'host-kill'] as const) test(`actual Pi ${name} ${interruption} stops its owned search process without replay`, async () => {
  const f = await sessionHostFixture('search-process'), directory = join(f.host.paths.dataRoot, '搜索 中文 空格'), marker = join(f.host.paths.dataRoot, 'native-search-process.json');
  const input = { pattern: name === 'grep' ? 'ENGINEERING' : '*.txt', path: directory, limit: 10000 };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    mkdirSync(directory);
    for (let index = 0; index < 3000; index++) writeFileSync(join(directory, `sample-${index}.txt`), 'ENGINEERING search fixture\n');
    const session = await f.create(`create-search-${name}-${interruption}`);
    f.search(name, input);
    const accepted = await f.send(session.session.id, 'ENGINEERING execute the supplied isolated search once', `search-${name}-${interruption}`);
    await until(async () => existsSync(marker));
    const owned = JSON.parse(readFileSync(marker, 'utf8')) as { pid: number; program: string; path: string; instanceId: string };
    expect(owned).toMatchObject({ program: name === 'grep' ? 'rg.exe' : 'fd.exe', instanceId: f.host.read().instanceId });
    const diagnostics = DiagnosticsViewSchema.parse(unwrap(await f.host.request('diagnostics.read', { categories: ['versions'] })));
    expect(owned.path).toBe(diagnostics.dependencies!.find(dependency => dependency.name === (name === 'grep' ? 'rg' : 'fd'))!.path);
    expect(alive(owned.pid)).toBe(true);
    const original = f.sql('SELECT id,run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json FROM tool_calls');
    expect(original).toHaveLength(1);
    expect(original[0]).toMatchObject({ run_id: accepted.runId, session_id: session.session.id, tool_name: name, tool_version: '0.87.1', effect: 'READ' });
    expect(JSON.parse((original[0] as { args_json: string }).args_json)).toEqual(input);
    if (interruption === 'cancel') expect(await f.host.request('run.cancel', { runId: accepted.runId })).toMatchObject({ ok: true, data: { cancelRequested: true, stopped: true } });
    if (interruption === 'host-kill') {
      const oldInstance = await f.kill();
      await until(async () => !alive(owned.pid));
      const requests = f.requests.length;
      expect(await f.host.start()).toMatchObject({ state: 'ready' });
      expect(f.requests).toHaveLength(requests);
      expect(ReadRunResultSchema.parse(unwrap(await f.host.request('run.read', { runId: accepted.runId })))).toMatchObject({ kind: 'one', run: { status: 'failed', error: { code: 'runtime_interrupted' }, cleanup: { stopConfirmed: true, requiredPersistenceComplete: true, processTreeProof: { instanceId: oldInstance } } } });
      expect(f.sql('SELECT result_json FROM tool_calls')).toEqual([{ result_json: JSON.stringify({ outcomeUnknown: true, recoveredAfterHostExit: true }) }]);
      await f.idle();
      const current = SessionDetailSchema.parse(unwrap(await f.host.request('session.read', { sessionId: session.session.id })));
      expect(await f.host.request('session.restore', { sessionId: session.session.id, expectedLeafId: current.session.leafId })).toMatchObject({ ok: true });
      const next = await f.send(session.session.id, 'ENGINEERING explicit new turn after interrupted search', `after-search-${name}`);
      await f.idle();
      expect(f.requests).toHaveLength(requests + 1);
      expect(ReadRunResultSchema.parse(unwrap(await f.host.request('run.read', { runId: next.runId })))).toMatchObject({ kind: 'one', run: { status: 'completed' } });
    } else {
      await f.idle();
      await until(async () => !alive(owned.pid));
      const calls = RunToolsViewSchema.parse(unwrap(await f.host.request('tool.read', { runId: accepted.runId })));
      expect(calls.items).toHaveLength(1);
      expect(calls.items[0]).toMatchObject({ name, status: interruption === 'cancel' ? 'cancelled' : 'failed', stoppedAt: expect.any(String), error: { code: interruption === 'cancel' ? 'tool_cancelled' : 'tool_timeout' } });
      if (interruption === 'timeout') expect(calls.items[0]!.control).toMatchObject({ effectiveTimeoutMs: 1000, timeoutRequestedAt: expect.any(String), latencyObservation: 'right_censored' });
    }
    expect(f.sql('SELECT id,run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json FROM tool_calls')).toEqual(original);
    expect(f.sql('SELECT id FROM runs')).toHaveLength(interruption === 'host-kill' ? 2 : 1);
  } finally { await f.close(); }
}, 45000);

for (const name of ['grep', 'find'] as const) test(`actual Pi ${name} preserves its SDK result limit and provider delivery on Chinese space paths`, async () => {
  const f = await sessionHostFixture(), directory = join(f.host.paths.dataRoot, '正常 搜索');
  try {
    mkdirSync(directory);
    for (let index = 0; index < 12; index++) writeFileSync(join(directory, `sample-${index}.txt`), 'ENGINEERING ' + 'x'.repeat(3000) + '\n');
    const session = await f.create(`create-search-limit-${name}`), input = { pattern: name === 'grep' ? 'ENGINEERING' : '*.txt', path: directory, limit: 3 };
    f.search(name, input);
    const accepted = await f.send(session.session.id, 'ENGINEERING execute the bounded isolated search once', `search-limit-${name}`);
    await f.idle();
    const calls = RunToolsViewSchema.parse(unwrap(await f.host.request('tool.read', { runId: accepted.runId })));
    expect(calls.items).toHaveLength(1);
    expect(calls.items[0]).toMatchObject({ name, version: '0.87.1', status: 'succeeded', sdkReturned: true, sdkResultIsError: false, consumptionEvidence: 'provider_input_verified' });
    expect(calls.items[0]!.resultPreview).toContain('SDK result limit reached');
    if (name === 'grep') expect(calls.items[0]!.nativeOutputTruncated).toBe(true);
    const delivery = JSON.parse((f.sql('SELECT delivery_json FROM tool_calls')[0] as { delivery_json: string }).delivery_json);
    expect(delivery.message.details).toMatchObject({ [name === 'grep' ? 'matchLimitReached' : 'resultLimitReached']: 3 });
    expect(f.requests).toHaveLength(2);
    expect(f.sql('SELECT id FROM runs')).toHaveLength(1);
  } finally { await f.close(); }
}, 45000);

for (const name of ['bash', 'powershell'] as const) for (const interruption of ['timeout', 'cancel', 'host-kill', 'stop-refusal'] as const) {
  test(interruption === 'stop-refusal' ? `actual Pi ${name} stop refusal keeps its real command blocked until the owned Host tree is killed`
    : `actual Pi ${name} ${interruption} stops its owned child tree and preserves the original tool fact`, async () => {
    const git = Bun.which('git');
    if (!git) throw new Error('ENGINEERING Git for Windows is required for the native command fixture');
    const bashDirectory = join(dirname(dirname(git)), 'bin');
    if (!existsSync(join(bashDirectory, 'bash.exe'))) throw new Error('ENGINEERING Git for Windows Bash is unavailable');
    // Exercise SDK PATH discovery with the existing Git installation, without changing its shell factory or global PATH.
    const f = await sessionHostFixture(interruption === 'stop-refusal' ? 'command-stop-refusal' : undefined, bashDirectory), marker = join(f.host.paths.dataRoot, 'command-processes.json'), grandMarker = join(f.host.paths.dataRoot, 'command-grandchild.json');
    const script = join(f.host.paths.dataRoot, '命令 tree.js');
    writeFileSync(script, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
      if(process.argv.includes('grandchild'))writeFileSync(${JSON.stringify(grandMarker)},JSON.stringify({pid:process.pid}));
      else{const child=spawn(process.execPath,[import.meta.filename,'grandchild'],{stdio:'inherit',windowsHide:true});writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,grandchild:child.pid}));}
      setInterval(()=>{},1000);`);
    const quote = (value: string) => name === 'powershell' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
    const command = `${name === 'powershell' ? '& ' : ''}${quote(process.execPath)} ${quote(script)}`;
    const input = { command, ...(interruption === 'timeout' ? { timeout: 4 } : {}) };
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      const diagnostics = DiagnosticsViewSchema.parse(unwrap(await f.host.request('diagnostics.read', { categories: ['versions'] })));
      expect(diagnostics.dependencies?.find(dependency => dependency.name === 'bash')).toMatchObject({ path: realpathSync(join(bashDirectory, 'bash.exe')), source: 'sdk_standard_discovery', version: expect.any(String) });
      const session = await f.create(`create-native-${name}-${interruption}`);
      f.command(name, input);
      const accepted = await f.send(session.session.id, 'ENGINEERING execute the supplied isolated command once', `native-${name}-${interruption}`);
      await until(async () => existsSync(marker) && existsSync(grandMarker));
      const owned = JSON.parse(readFileSync(marker, 'utf8')) as { pid: number; grandchild: number };
      expect(JSON.parse(readFileSync(grandMarker, 'utf8'))).toEqual({ pid: owned.grandchild });
      expect(alive(owned.pid)).toBe(true); expect(alive(owned.grandchild)).toBe(true);
      const before = f.sql('SELECT id,run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json FROM tool_calls');
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ run_id: accepted.runId, session_id: session.session.id, tool_name: name, tool_version: '0.87.1', effect: 'LOCAL_WRITE', args_json: JSON.stringify(input) });
      if (interruption === 'cancel' || interruption === 'stop-refusal') {
        const cancelled = await f.host.request('run.cancel', { runId: accepted.runId }); expect(cancelled).toMatchObject({ ok: true });
        if (interruption === 'stop-refusal') expect(cancelled).toMatchObject({ ok: true, data: { cancelRequested: true, stopped: false } });
      }
      if (interruption === 'stop-refusal') {
        await until(async () => f.stopRefused());
        expect(alive(owned.pid)).toBe(true); expect(alive(owned.grandchild)).toBe(true);
        expect(f.sql('SELECT status FROM tool_calls')).toEqual([{ status: 'running' }]);
        expect(await f.host.request('run.control.read', {})).toMatchObject({ ok: true, data: { acceptingNewRuns: false } });
      }
      if (interruption === 'host-kill' || interruption === 'stop-refusal') {
        const prior = ReadRunResultSchema.parse(unwrap(await f.host.request('run.read', { runId: accepted.runId })));
        if (prior.kind !== 'one' || !prior.run) throw new Error('ENGINEERING original Run unavailable');
        expect(prior.run.status).not.toBe('completed');
        const terminal = prior.run.status === 'failed' || prior.run.status === 'cancelled';
        const oldInstance = await f.kill();
        await until(async () => !alive(owned.pid) && !alive(owned.grandchild));
        const requests = f.requests.length;
        expect(await f.host.start()).toMatchObject({ state: 'ready' });
        expect(f.requests).toHaveLength(requests);
        const recovered = ReadRunResultSchema.parse(unwrap(await f.host.request('run.read', { runId: accepted.runId })));
        expect(recovered).toMatchObject({ kind: 'one', run: { status: terminal ? prior.run.status : 'failed', error: terminal ? prior.run.error : { code: 'runtime_interrupted' }, cleanup: {
          stopConfirmed: true, requiredPersistenceComplete: false, unconfirmedItems: expect.arrayContaining(['tool_effect_unknown']), processTreeProof: { instanceId: oldInstance } } } });
        expect(f.sql('SELECT result_json FROM tool_calls')).toEqual([{ result_json: JSON.stringify({ outcomeUnknown: true, recoveredAfterHostExit: true }) }]);
        expect(await f.host.request('run.control.read', {})).toMatchObject({ ok: true, data: { acceptingNewRuns: false } });
      } else {
        await f.idle();
        await until(async () => !alive(owned.pid) && !alive(owned.grandchild));
        const calls = RunToolsViewSchema.parse(unwrap(await f.host.request('tool.read', { runId: accepted.runId })));
        expect(calls.items).toHaveLength(1);
        expect(calls.items[0]).toMatchObject({ name, version: '0.87.1', status: interruption === 'cancel' ? 'cancelled' : 'failed', stoppedAt: expect.any(String) });
        expect(calls.items[0]!.control?.outputValidation).toBe('not_reached');
        const run = ReadRunResultSchema.parse(unwrap(await f.host.request('run.read', { runId: accepted.runId })));
        expect(run).toMatchObject({ kind: 'one', run: { cleanup: { stopConfirmed: true, requiredPersistenceComplete: true } } });
      }
      expect(f.sql('SELECT id,run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json FROM tool_calls')).toEqual(before);
      expect(f.sql('SELECT id FROM runs')).toHaveLength(1);
    } finally { await f.close(); }
  }, 45000);
}

for (const name of ['bash', 'powershell'] as const) test(`actual Pi ${name} long output preserves its full SDK file and delivered truncation fact`, async () => {
  const git = Bun.which('git');
  if (!git) throw new Error('ENGINEERING Git for Windows is required');
  const f = await sessionHostFixture(undefined, join(dirname(dirname(git)), 'bin'));
  const script = join(f.host.paths.dataRoot, '长输出 tree.js'); let fullOutputPath: string | undefined;
  writeFileSync(script, `for(let index=0;index<2500;index++)console.log('ENGINEERING '+index+' '+ 'x'.repeat(60));`);
  const quote = (value: string) => name === 'powershell' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
  try {
    const session = await f.create(`create-long-output-${name}`);
    f.command(name, { command: `${name === 'powershell' ? '& ' : ''}${quote(process.execPath)} ${quote(script)}` });
    const accepted = await f.send(session.session.id, 'ENGINEERING execute the supplied isolated output command once', `long-output-${name}`);
    await f.idle();
    const calls = RunToolsViewSchema.parse(unwrap(await f.host.request('tool.read', { runId: accepted.runId })));
    expect(calls.items).toHaveLength(1);
    expect(calls.items[0]).toMatchObject({ name, status: 'succeeded', sdkReturned: true, sdkResultIsError: false, nativeOutputTruncated: true, consumptionEvidence: 'provider_input_verified' });
    const delivery = JSON.parse((f.sql('SELECT delivery_json FROM tool_calls')[0] as { delivery_json: string }).delivery_json) as { message: { details: { fullOutputPath: string; truncation: { truncated: boolean } } } };
    expect(delivery.message.details.truncation.truncated).toBe(true);
    const selected = realpathSync(delivery.message.details.fullOutputPath), path = relative(realpathSync(tmpdir()), selected);
    expect(path && path !== '..' && !path.startsWith('..') && !isAbsolute(path)).toBeTruthy();
    fullOutputPath = selected;
    const original = readFileSync(selected, 'utf8');
    expect(original).toContain('ENGINEERING 0 '); expect(original).toContain('ENGINEERING 2499 ');
    expect(original.trim().split('\n')).toHaveLength(2500);
    expect(f.requests).toHaveLength(2); expect(f.sql('SELECT id FROM runs')).toHaveLength(1);
  } finally { await f.close(); if (fullOutputPath) rmSync(fullOutputPath); }
}, 45000);

for (const barrier of ['checkpoint-before', 'checkpoint-after'] as const) test('real Host kill at ' + barrier + ' preserves the position transaction and requires explicit continuation', async () => {
  const f = await sessionHostFixture(barrier);
  try {
    const a = await f.create('p17-position-session');
    await f.send(a.session.id, 'ENGINEERING P17 first saved turn', 'p17-first'); await f.idle();
    const points = SessionCheckpointPageSchema.parse(unwrap(await f.host.request('session.checkpoints.read', { sessionId: a.session.id })));
    const second = await f.send(a.session.id, 'ENGINEERING P17 second saved turn', 'p17-second'); await f.idle();
    const detail = SessionDetailSchema.parse(unwrap(await f.host.request('session.read', { sessionId: a.session.id }))), workspace = await f.workspace();
    const request = { sessionId: a.session.id, targetLeafId: points.items[0]!.nativeLeafId, expectedStorageVersion: detail.session.storageVersion, expectedWorkspaceRevision: workspace.revision };
    expect(request.targetLeafId).not.toBe(detail.session.leafId);
    const memories = f.sql('SELECT * FROM memories ORDER BY id'), answers = f.sql('SELECT * FROM answers ORDER BY id'), queries = f.sql('SELECT * FROM queries ORDER BY id');
    expect(answers).toHaveLength(2);
    const oldPosition = f.sql('SELECT current_leaf_id,storage_version FROM sessions ORDER BY id'), operationRef = 'p17-resume-' + barrier;
    f.arm(); const pending = f.host.request('session.restoreCheckpoint', request, operationRef);
    await until(async () => f.reached());
    const faultPosition = f.sql('SELECT current_leaf_id,storage_version FROM sessions ORDER BY id');
    if (barrier === 'checkpoint-before') expect(faultPosition).toEqual(oldPosition);
    else expect(faultPosition).toEqual([{ current_leaf_id: request.targetLeafId, storage_version: request.expectedStorageVersion + 1 }]);
    expect(f.sql("SELECT id FROM business_events WHERE type='session_checkpoint_restored'")).toHaveLength(barrier === 'checkpoint-before' ? 0 : 1);
    const instance = await f.kill();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'operation_result_unknown', operationRef } });
    const network = f.requests.length;
    expect(await f.host.restart(instance)).toMatchObject({ state: 'ready' }); await f.idle();
    expect(f.requests).toHaveLength(network);
    expect(f.sql('SELECT current_leaf_id,storage_version FROM sessions ORDER BY id')).toEqual(faultPosition);
    expect(f.sql('SELECT * FROM memories ORDER BY id')).toEqual(memories);
    expect(f.sql('SELECT * FROM answers ORDER BY id')).toEqual(answers);
    expect(f.sql('SELECT * FROM queries ORDER BY id')).toEqual(queries);
    const original = await f.host.request('evidence.readOperation', { kind: 'session_checkpoint', operationRef });
    let receipt;
    if (barrier === 'checkpoint-before') {
      expect(original).toEqual({ ok: true, data: null });
      receipt = SessionCheckpointReceiptSchema.parse(unwrap(await f.host.request('session.restoreCheckpoint', request, 'p17-explicit-position')));
    } else {
      receipt = SessionCheckpointReceiptSchema.parse(unwrap(original));
      expect(await f.host.request('session.restoreCheckpoint', request, operationRef)).toEqual({ ok: true, data: receipt });
    }
    expect(receipt).toMatchObject({ sessionId: a.session.id, targetLeafId: request.targetLeafId, storageVersion: request.expectedStorageVersion + 1, workspaceRevision: request.expectedWorkspaceRevision + 1 });
    expect(await f.host.request('session.restore', { sessionId: a.session.id, expectedLeafId: request.targetLeafId }, 'p17-explicit-session')).toMatchObject({ ok: true, data: { runtime: { availability: 'ready' } } });
    expect(f.requests).toHaveLength(network);
    expect(f.sql('SELECT current_leaf_id,storage_version FROM sessions ORDER BY id')).toEqual([{ current_leaf_id: request.targetLeafId, storage_version: receipt.storageVersion }]);
    const fresh = await f.send(a.session.id, 'ENGINEERING P17 explicit branch after recovery', 'p17-new-run'); await f.idle();
    expect(fresh.runId).not.toBe(second.runId); expect(f.requests).toHaveLength(network + 1);
    expect(JSON.stringify(f.requests.at(-1))).toContain('ENGINEERING P17 first saved turn');
    expect(JSON.stringify(f.requests.at(-1))).not.toContain('ENGINEERING P17 second saved turn');
  } finally { await f.close(); }
}, 60000);

test('committed checkpoint survives SDK assembly failure and original replay cannot pretend the Session is ready', async () => {
  const f = await sessionHostFixture('checkpoint-rebuild-failure');
  try {
    const a = await f.create('p17-rebuild-session');
    await f.send(a.session.id, 'ENGINEERING P17 earlier branch', 'p17-rebuild-first'); await f.idle();
    const points = SessionCheckpointPageSchema.parse(unwrap(await f.host.request('session.checkpoints.read', { sessionId: a.session.id })));
    await f.send(a.session.id, 'ENGINEERING P17 abandoned branch', 'p17-rebuild-second'); await f.idle();
    const before = SessionDetailSchema.parse(unwrap(await f.host.request('session.read', { sessionId: a.session.id }))), workspace = await f.workspace();
    const input = { sessionId: a.session.id, targetLeafId: points.items[0]!.nativeLeafId, expectedStorageVersion: before.session.storageVersion, expectedWorkspaceRevision: workspace.revision }, operationRef = 'p17-rebuild-position';
    const memories = f.sql('SELECT * FROM memories ORDER BY id');
    f.arm();
    expect(await f.host.request('session.restoreCheckpoint', input, operationRef)).toMatchObject({ ok: false, error: { code: 'resource_unavailable', reason: 'session_restore_failed' } });
    expect(f.reached()).toBe(true);
    const receipt = SessionCheckpointReceiptSchema.parse(unwrap(await f.host.request('evidence.readOperation', { kind: 'session_checkpoint', operationRef })));
    expect(receipt).toMatchObject({ targetLeafId: input.targetLeafId, storageVersion: input.expectedStorageVersion + 1, workspaceRevision: input.expectedWorkspaceRevision + 1 });
    expect(await f.host.request('session.read', { sessionId: a.session.id })).toMatchObject({ ok: true, data: { session: { leafId: input.targetLeafId, storageVersion: receipt.storageVersion }, runtime: { availability: 'blocked' } } });
    let rejected: unknown;
    try { await f.send(a.session.id, 'ENGINEERING blocked send', 'p17-blocked-send'); } catch (error) { rejected = error; }
    expect(rejected).toMatchObject({ code: 'session_history_invalid', reason: 'session_restore_failed', operationRef: 'p17-blocked-send' });
    expect(f.sql('SELECT id FROM runs')).toHaveLength(2); expect(f.requests).toHaveLength(2);
    expect(await f.host.request('session.restoreCheckpoint', input, operationRef)).toEqual({ ok: true, data: receipt });
    expect(await f.host.request('session.read', { sessionId: a.session.id })).toMatchObject({ ok: true, data: { runtime: { availability: 'blocked' } } });
    expect(f.sql('SELECT * FROM memories ORDER BY id')).toEqual(memories);
    expect(await f.host.request('session.restore', { sessionId: a.session.id, expectedLeafId: before.session.leafId }, 'p17-stale-restore')).toMatchObject({ ok: false, error: { code: 'state_conflict', reason: 'history_version_mismatch' } });
    expect(await f.host.request('session.restore', { sessionId: a.session.id, expectedLeafId: input.targetLeafId }, 'p17-rebuild-current')).toMatchObject({ ok: true, data: { runtime: { availability: 'ready' } } });
    expect(f.requests).toHaveLength(2);
    expect(f.sql('SELECT current_leaf_id,storage_version FROM sessions')).toEqual([{ current_leaf_id: input.targetLeafId, storage_version: receipt.storageVersion }]);
    await f.send(a.session.id, 'ENGINEERING P17 explicit after assembly repair', 'p17-rebuild-new'); await f.idle();
    expect(f.requests).toHaveLength(3);
    expect(JSON.stringify(f.requests.at(-1))).toContain('ENGINEERING P17 earlier branch');
    expect(JSON.stringify(f.requests.at(-1))).not.toContain('ENGINEERING P17 abandoned branch');
  } catch (error) {
    console.error('P17_REBUILD_DIAGNOSTIC ' + JSON.stringify({ state: f.host.read().state, canStart: f.host.read().canStart,
      errorCode: f.host.read().error?.code ?? null, modelRequests: f.requests.length,
      positions: f.sql('SELECT id,current_leaf_id,storage_version FROM sessions ORDER BY id'), runCount: f.sql('SELECT id FROM runs').length }));
    throw error;
  } finally { await f.close(); }
}, 60000);

test('a real Host crash with A running and B selected preserves both histories and restores no execution automatically', async () => {
  const f = await sessionHostFixture();
  try {
    const a = await f.create('p17-A'), b = await f.create('p17-B');
    await f.select(a.session.id); await f.send(a.session.id, 'ENGINEERING P17 A saved', 'p17-A-first'); await f.idle();
    await f.select(b.session.id); await f.send(b.session.id, 'ENGINEERING P17 B saved', 'p17-B-first'); await f.idle();
    await f.select(a.session.id); f.hold(true);
    const active = await f.send(a.session.id, 'ENGINEERING P17 A interrupted', 'p17-A-running');
    await until(async () => f.requests.length === 3); await f.select(b.session.id);
    const workspace = await f.workspace(), memories = f.sql('SELECT * FROM memories ORDER BY id'), answers = f.sql('SELECT * FROM answers ORDER BY id');
    const identities = f.sql('SELECT id,session_id,operation_ref,client_sequence FROM session_inputs ORDER BY id');
    expect(workspace.sessionId).toBe(b.session.id);
    const instance = await f.kill(); f.hold(false);
    expect(await f.host.restart(instance)).toMatchObject({ state: 'ready' }); await f.idle();
    expect(await f.workspace()).toEqual(workspace); expect(f.requests).toHaveLength(3);
    expect(f.sql('SELECT * FROM memories ORDER BY id')).toEqual(memories);
    expect(f.sql('SELECT * FROM answers ORDER BY id')).toEqual(answers);
    expect(f.sql('SELECT id,session_id,operation_ref,client_sequence FROM session_inputs ORDER BY id')).toEqual(identities);
    const run = ReadRunResultSchema.parse(unwrap(await f.host.request('run.read', { runId: active.runId })));
    expect(run).toMatchObject({ kind: 'one', run: { sessionId: a.session.id, status: 'failed', error: { code: 'runtime_interrupted' }, cleanup: { stopConfirmed: true, requiredPersistenceComplete: true } } });
    const aDetail = SessionDetailSchema.parse(unwrap(await f.host.request('session.read', { sessionId: a.session.id }))), bDetail = SessionDetailSchema.parse(unwrap(await f.host.request('session.read', { sessionId: b.session.id })));
    expect(aDetail.runtime.availability).toBe('unloaded'); expect(bDetail.runtime.availability).toBe('unloaded');
    expect(JSON.stringify(aDetail.history)).toContain('ENGINEERING P17 A saved'); expect(JSON.stringify(aDetail.history)).not.toContain('ENGINEERING P17 B saved');
    expect(JSON.stringify(bDetail.history)).toContain('ENGINEERING P17 B saved'); expect(JSON.stringify(bDetail.history)).not.toContain('ENGINEERING P17 A saved');
    expect(JSON.stringify(aDetail.history)).not.toContain('ENGINEERING temporary');
    await f.select(a.session.id);
    expect(await f.host.request('session.restore', { sessionId: a.session.id, expectedLeafId: aDetail.session.leafId }, 'p17-explicit-A')).toMatchObject({ ok: true, data: { runtime: { availability: 'ready' } } });
    expect(f.requests).toHaveLength(3);
    const fresh = await f.send(a.session.id, 'ENGINEERING P17 A explicit new input', 'p17-A-new'); await f.idle();
    expect(fresh.runId).not.toBe(active.runId); expect(f.requests).toHaveLength(4);
    expect(JSON.stringify(f.requests.at(-1))).toContain('ENGINEERING P17 A saved'); expect(JSON.stringify(f.requests.at(-1))).not.toContain('ENGINEERING P17 B saved');
  } finally { await f.close(); }
}, 60000);

test('an unsaved later idle Session keeps every native binding available for shutdown recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-later-session-save-'));
  try {
    const history = nativeHistoryFixture();
    const agent = new PiAgentRuntime(await modelRuntime(), root, { ...history.history, commitSync: () => { throw safeError('storage_write_failed'); } });
    history.bind(agent, 1); history.bind(agent, 2);
    const bindings = Reflect.get(agent, 'sessions') as Map<number, { manager: import('@earendil-works/pi-coding-agent').SessionManager }>;
    const originals = await Promise.all([1, 2].map(id => history.history.store.load(id)));
    try { bindings.get(2)!.manager.appendCustomEntry('ENGINEERING later unsaved', { value: 2 }); } catch {}
    const error: unknown = await agent.disposeIdleSessions().then(() => null, error => error);
    const availability = [1, 2].map(id => agent.readAvailability(id)), retained = [...bindings.keys()];
    const stored = await Promise.all([1, 2].map(id => history.history.store.load(id)));
    writeFileSync(join(root, 'binding-facts.json'), JSON.stringify({ availability, retained, originals, stored, error }));
    expect(error).toMatchObject({ code: 'storage_write_failed' });
    expect(availability).toMatchObject([{ availability: 'ready' }, { availability: 'blocked' }]);
    expect(retained).toEqual([1, 2]); expect(stored).toEqual(originals);
  } finally {
    // Retain the original release observations for diagnosis.
    console.log('P17_LATER_BINDING_ROOT_RETAINED ' + root);
  }
});
