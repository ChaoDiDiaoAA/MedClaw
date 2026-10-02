import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { RuntimeService } from '../../packages/core/src/runtime/runtime-service';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { SubmitInputSchema } from '../../packages/contracts/src/session';
import { RunCleanupRecordSchema } from '../../packages/contracts/src/run';
import { safeError } from '../../packages/contracts/src/error';

const roots: string[] = [];
const handles: Database[] = [];
const time = '2026-10-02T00:00:00.000Z';
const cleanup = RunCleanupRecordSchema.parse({
  contract: 'medclaw.run-cleanup/v1', executionStarted: true, stopConfirmed: null,
  requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: null,
  unconfirmedItems: ['stop', 'resources'], secondaryErrors: [], verifiedAt: null,
});
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(name: string, effect: 'READ' | 'LOCAL_WRITE') {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p3-recovery-'));
  roots.push(root);
  const path = join(root, 'app.sqlite');
  const db = openDatabase(path);
  handles.push(db);
  const repo = new Repositories(db);
  const sessionId = repo.createSession({ expectedWorkspaceRevision: 0 }, 'create', 'native', time).session.id;
  const workspace = repo.readWorkspace();
  const request = SubmitInputSchema.parse({
    sessionId, clientSequence: 1, text: 'Read data', mode: 'send', expectedRevision: workspace.revision,
    expectedBatchIds: [], expectedQueryId: null, model: { provider: 'test', modelId: 'text', expectedConfigVersion: '1' },
    referenceDate: '2026-10-02', timezone: 'Asia/Shanghai',
  });
  const model = { provider: 'test', modelId: 'text', endpointRef: null, api: 'openai-completions', configVersion: '1',
    credentialRef: null, maxOutputTokens: 1024, capabilitySource: 'pi_catalog' as const, sdkVersion: '0.87.1' as const };
  const policy = { timeoutMs: 1000, maxRetries: 0 as const, maxRetryDelayMs: 2000 };
  const { runId } = repo.registerAgent({
    sessionId, inputId: null, text: request.text, model, policy, goal: 'answer', workspace,
    scope: { batchIds: [], deviceIds: null, allowedToolNames: [name], allowedResourceRefs: [], artifactIds: [], readOnly: effect === 'READ' },
    referenceDate: request.referenceDate, timezone: request.timezone, timeoutMs: policy.timeoutMs,
    submission: { operationRef: 'submit', originalSubmitInput: request }, instanceId: 'host-old',
    agentOptions: { requestedThinkingLevel: 'off', effectiveThinkingLevel: 'off' }, createdAt: time,
  });
  repo.startCall(runId, 'model-1', 'main', time);
  db.query(`INSERT INTO tool_calls(session_id,run_id,native_tool_call_id,model_call_id,tool_name,tool_version,effect,execution_mode,
    args_json,status,requested_at,started_at) VALUES(?,?,'tool-1',(SELECT id FROM model_calls WHERE call_id='model-1'),?,'0.87.1',?,'parallel','{}','running',?,?)`)
    .run(sessionId, runId, name, effect, time, time);
  const modelRuntime = await PiModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore() });
  const settings = PublishedSettingsSchema.parse({ schemaVersion: 'medclaw.settings/p1-v1', configVersion: '1', model: null,
    customProviders: [], credentialRefs: {}, requestPolicy: policy, ui: { navCollapsed: false, detailOpen: false, detailTab: 'conditions' },
    previous: null, rollbackFromVersion: null });
  const runtime = (store: Repositories) => new RuntimeService('host-new', () => settings, modelRuntime, store,
    (_context, action) => action(), () => { throw new Error('Recovery must not start a model call'); }, () => {}, () => {}, undefined, () => false);
  return { db, path, repo, runId, runtime, service: runtime(repo) };
}

for (const name of ['bash', 'powershell', 'grep', 'find']) test(`old Host exit does not prove the ${name} child stopped or invent its original result`, async () => {
  const c = await fixture(name, ['bash', 'powershell'].includes(name) ? 'LOCAL_WRITE' : 'READ');
  const before = c.db.query('SELECT * FROM tool_calls').all();
  c.service.recoverInterrupted(true);
  expect(await c.service.readControl()).toMatchObject({ ok: true, data: { acceptingNewRuns: false, blockReasons: [{ code: 'stop_unconfirmed' }] } });
  expect(await c.service.retrySave(c.runId)).toMatchObject({ ok: false, error: { code: 'stop_unconfirmed' } });
  expect(c.db.query('SELECT * FROM tool_calls').all()).toEqual(before);
  expect(c.repo.read({ runId: c.runId })).toMatchObject({ kind: 'one', run: { cleanup: { stopConfirmed: null } } });
  expect(c.db.query('SELECT COUNT(*) AS n FROM model_calls').get()).toEqual({ n: 1 });
});

test('interrupted local write records truthful uncertainty and remains blocked across reopen and save retry', async () => {
  const c = await fixture('write', 'LOCAL_WRITE');
  c.service.recoverInterrupted(true);
  expect(c.db.query('SELECT status,result_json,error_json,stopped_at FROM tool_calls').get()).toMatchObject({
    status: 'failed', result_json: JSON.stringify({ outcomeUnknown: true, recoveredAfterHostExit: true }),
    error_json: JSON.stringify(safeError('runtime_interrupted', undefined, { runId: c.runId, toolCallId: 1 })), stopped_at: null,
  });
  expect(c.repo.read({ runId: c.runId })).toMatchObject({ kind: 'one', run: { cleanup: { stopConfirmed: true, requiredPersistenceComplete: false, unconfirmedItems: ['tool_effect_unknown'] } } });
  const db = openDatabase(c.path);
  handles.push(db);
  const next = c.runtime(new Repositories(db));
  next.recoverInterrupted(true);
  expect(await next.readControl()).toMatchObject({ ok: true, data: { acceptingNewRuns: false, blockReasons: [{ code: 'run_save_unavailable' }] } });
  expect(await next.retrySave(c.runId)).toMatchObject({ ok: false, error: { code: 'run_save_unavailable' } });
  expect(db.query('SELECT COUNT(*) AS n FROM tool_calls').get()).toEqual({ n: 1 });
});

test('a prior tool persistence marker cannot be cleared from terminal rows after original pending facts are lost', async () => {
  const c = await fixture('write', 'LOCAL_WRITE');
  c.db.query("UPDATE tool_calls SET status='succeeded',result_json=?,ended_at=?,stopped_at=?").run(JSON.stringify({ original: true }), time, time);
  c.repo.checkpointFailure(c.runId, safeError('storage_write_failed'), { ...cleanup, stopConfirmed: true, resourcesReleased: true,
    requiredPersistenceComplete: false, unconfirmedItems: ['tool_persistence'], verifiedAt: time }, time);
  const original = c.db.query('SELECT * FROM tool_calls').all();
  c.service.recoverInterrupted(true);
  expect(await c.service.readControl()).toMatchObject({ ok: true, data: { acceptingNewRuns: false, blockReasons: [{ code: 'run_save_unavailable' }] } });
  expect(await c.service.retrySave(c.runId)).toMatchObject({ ok: false, error: { code: 'run_save_unavailable' } });
  expect(c.repo.read({ runId: c.runId })).toMatchObject({ kind: 'one', run: { status: 'failed', error: { code: 'storage_write_failed' }, cleanup: {
    stopConfirmed: true, requiredPersistenceComplete: false, unconfirmedItems: ['tool_persistence'],
  } } });
  expect(c.db.query('SELECT * FROM tool_calls').all()).toEqual(original);
});

test('interrupted read facts and already saved command stop facts can release a recovered Run without any execution', async () => {
  const read = await fixture('read_data_scope', 'READ');
  read.service.recoverInterrupted(false);
  expect(read.db.query('SELECT status FROM tool_calls').get()).toEqual({ status: 'running' });
  expect(await read.service.readControl()).toMatchObject({ ok: true, data: { acceptingNewRuns: false } });
  read.service.recoverInterrupted(true);
  expect(read.db.query('SELECT status,stopped_at FROM tool_calls').get()).toEqual({ status: 'failed', stopped_at: null });
  expect(await read.service.readControl()).toMatchObject({ ok: true, data: { acceptingNewRuns: true } });
  const command = await fixture('bash', 'LOCAL_WRITE');
  command.db.query("UPDATE tool_calls SET status='succeeded',result_json='{}',ended_at=?,stopped_at=?").run(time, time);
  command.service.recoverInterrupted(true);
  expect(await command.service.readControl()).toMatchObject({ ok: true, data: { acceptingNewRuns: true } });
  expect(command.db.query('SELECT status,ended_at,stopped_at FROM tool_calls').get()).toEqual({ status: 'succeeded', ended_at: time, stopped_at: time });
  expect(read.db.query('SELECT COUNT(*) AS n FROM model_calls').get()).toEqual({ n: 1 });
  expect(command.db.query('SELECT COUNT(*) AS n FROM model_calls').get()).toEqual({ n: 1 });
});

test('terminal Run cleanup cannot hide an unresolved tool row and recovery writes roll back on failure', async () => {
  const command = await fixture('bash', 'LOCAL_WRITE');
  command.db.query("UPDATE runs SET status='completed',output_text='Saved answer',ended_at=?,cleanup_json=? WHERE id=?")
    .run(time, JSON.stringify({ ...cleanup, stopConfirmed: true, resourcesReleased: true, unconfirmedItems: [], verifiedAt: time }), command.runId);
  expect(command.repo.recoveryCandidates('host-new')).toHaveLength(1);
  command.service.recoverInterrupted(true);
  expect(await command.service.readControl()).toMatchObject({ ok: true, data: { acceptingNewRuns: false, blockReasons: [{ code: 'stop_unconfirmed' }] } });
  expect(command.db.query('SELECT status,output_text,ended_at FROM runs').get()).toEqual({ status: 'completed', output_text: 'Saved answer', ended_at: time });
  const write = await fixture('write', 'LOCAL_WRITE');
  const before = write.db.query('SELECT * FROM tool_calls').all();
  const broken = new Repositories(write.db, () => { throw new Error('Recovery commit failed'); });
  expect(() => broken.verifyPriorToolFacts(write.runId, true, time)).toThrow('Recovery commit failed');
  expect(write.db.query('SELECT * FROM tool_calls').all()).toEqual(before);
});
