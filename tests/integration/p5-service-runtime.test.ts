import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { SessionService } from '../../packages/core/src/session/session-service';
import { safeError } from '../../packages/contracts/src/error';
import type { NativeSessionBindings } from '../../packages/contracts/src/session';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import { ModelCallRecorder } from '../../packages/runtime-pi/src/model-call-recorder';
import { Application } from '../../packages/core/src/application';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { SubmitInputSchema } from '../../packages/contracts/src/session';
import type { SubmitInput } from '../../packages/contracts/src/session';
import type { RuntimeNotice } from '../../packages/contracts/src/protocol';

const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

function readFixture() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p5-service-'));
  const db = openDatabase(join(root, 'app.sqlite')), repo = new Repositories(db);
  const session = repo.createSession({ expectedWorkspaceRevision: 0 }, 'create-a', 'native-a', new Date().toISOString()).session;
  const native: NativeSessionBindings = {
    allocate: () => { throw new Error('Unexpected allocation'); },
    read: () => ({ available: true, reason: null, leafId: null, messages: [], truncated: false }),
    readMessages: () => { throw new Error('Unexpected message read'); },
  };
  const service = new SessionService('host-a', repo, native, async () => ({ ok: false, error: safeError('runtime_busy') }), () => null);
  closers.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, repo, session, service };
}

// Catches treating healthy absence as a storage fault or starting execution on a read.
test('ordinary input read returns healthy absence without creating a Run', async () => {
  const c = readFixture();
  const before = c.db.query('SELECT COUNT(*) AS n FROM runs').get();
  expect(await c.service.readInput({ sessionId: c.session.id, clientSequence: 1 })).toEqual({ ok: true, data: null });
  expect(c.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual(before);
});

// Catches converting an unreadable database into a false not-submitted conclusion.
test('ordinary input read reports database failure separately from absence', async () => {
  const c = readFixture();
  c.db.close();
  const result = await c.service.readInput({ sessionId: c.session.id, clientSequence: 1 });
  expect(result).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
});

async function runtimeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p5-runtime-'));
  const db = openDatabase(join(root, 'app.sqlite')), repo = new Repositories(db);
  let release!: () => void, received!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { received = resolve; });
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>);
    if (requests.length === 1) { received(); await held; }
    const event = { id: 'p5', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture analysis complete.' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('p5-fixture', async () => ({ type: 'api_key', key: 'fixture-only' }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  await runtime.installCustom([{ providerId: 'p5-fixture', name: 'P5 fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`,
    models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] }]);
  const settings = PublishedSettingsSchema.parse({ schemaVersion: 'medclaw.settings/p1-v1', configVersion: '1', model: null, customProviders: [], credentialRefs: {},
    requestPolicy: { timeoutMs: 10000, maxRetries: 0, maxRetryDelayMs: 2000 }, previous: null, rollbackFromVersion: null });
  const agent = new PiAgentRuntime(runtime, root);
  const notices: RuntimeNotice[] = [];
  const app = new Application('host-a', settings, runtime, repo, (_context, action) => action(),
    (runId, kind, at) => new ModelCallRecorder(repo, runId, kind, at), notice => notices.push(notice), () => {}, agent);
  const service = new SessionService('host-a', repo, agent, (input, context) => app.runs.submitAgent(input, context),
    () => app.runs.activeHandle, sessionId => app.runs.readInputControl(sessionId), (inputId, context) => app.runs.cancelInput(inputId, context));
  const created = await service.create({ expectedWorkspaceRevision: 0 }, { instanceId: 'host-a', operationRef: 'create-a' });
  if (!created.ok) throw new Error(created.error.code);
  const request: SubmitInput = { mode: 'send', sessionId: created.data.session.id, clientSequence: 1, text: 'Analyze A medical devices',
    expectedRevision: created.data.workspace.revision, expectedBatchIds: [], expectedQueryId: null,
    model: { provider: 'p5-fixture', modelId: 'fixture', expectedConfigVersion: '1' }, referenceDate: '2026-10-01', timezone: 'Asia/Shanghai' };
  closers.push(async () => { release(); await app.shutdown().catch(() => {}); server.stop(true); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, repo, app, agent, service, request, requests, requested, release, notices };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Expected runtime state did not arrive'); await Bun.sleep(5); }
}

// Catches legacy null input acceptance, a second root for queued input and unproven consumption.
test('real Send Steer and Follow Up consume distinct inputs in one original Run', async () => {
  const c = await runtimeFixture();
  const accepted = await c.service.submit(c.request, { instanceId: 'host-a', operationRef: 'send-a' });
  expect(structuredClone(accepted)).toMatchObject({ ok: true, data: { inputId: expect.any(Number), runId: expect.any(Number) } });
  if (!accepted.ok || accepted.data.inputId === null || accepted.data.runId === null) throw new Error('Missing P5 root identity');
  await c.requested;
  const root = accepted.data.runId;
  const steer: SubmitInput = { ...c.request, mode: 'steer', targetRunId: root, clientSequence: 2, text: 'Only category two devices' };
  const follow: SubmitInput = { ...c.request, mode: 'follow_up', targetRunId: root, clientSequence: 3, text: 'Then compare manufacturers' };
  SubmitInputSchema.parse(steer); SubmitInputSchema.parse(follow);
  const second = await c.service.submit(steer, { instanceId: 'host-a', operationRef: 'steer-a' });
  const third = await c.service.submit(follow, { instanceId: 'host-a', operationRef: 'follow-a' });
  expect(structuredClone(second)).toMatchObject({ ok: true, data: { inputId: expect.any(Number), runId: null } });
  expect(structuredClone(third)).toMatchObject({ ok: true, data: { inputId: expect.any(Number), runId: null } });
  expect(c.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
  c.release(); await until(() => c.app.runs.activeHandle === null);
  const rows = c.repo.listInputs({ sessionId: c.request.sessionId }).items;
  expect(rows).toHaveLength(3);
  expect(rows.map(row => [row.status, row.processingStatus, row.runId])).toEqual([
    ['consumed', 'completed', root], ['consumed', 'completed', root], ['consumed', 'completed', root],
  ]);
  expect(new Set(rows.map(row => row.nativeEntryId)).size).toBe(3);
  expect(c.db.query('SELECT input_id FROM runs').get()).toEqual({ input_id: accepted.data.inputId });
  const calls = c.db.query('SELECT DISTINCT input_id FROM model_calls').all();
  expect(calls).toEqual([{ input_id: accepted.data.inputId }]);
  const before = c.requests.length;
  expect(await c.service.readSubmission({ sessionId: c.request.sessionId, clientSequence: 2 })).toMatchObject({ ok: true, data: { runId: root } });
  expect(await c.service.submit(steer, { instanceId: 'host-a', operationRef: 'steer-a' })).toMatchObject({ ok: true, data: { runId: root } });
  expect(c.requests.length).toBe(before);
  expect(c.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
});

// Cancellation returns the persisted removal fact for the original Session, even while viewing B.
test('queued cancellation at the native safety point stays bound to A while viewing B', async () => {
  const c = await runtimeFixture();
  const accepted = await c.service.submit(c.request, { instanceId: 'host-a', operationRef: 'send-a' });
  if (!accepted.ok || accepted.data.inputId === null || accepted.data.runId === null) throw new Error('Missing root');
  await c.requested;
  const queued = await c.service.submit({ ...c.request, mode: 'follow_up', targetRunId: accepted.data.runId, clientSequence: 2, text: 'Follow up in A' },
    { instanceId: 'host-a', operationRef: 'follow-a' });
  if (!queued.ok || queued.data.inputId === null) throw new Error('Missing queued input');
  const b = await c.service.create({ expectedWorkspaceRevision: c.repo.readWorkspace().revision }, { instanceId: 'host-a', operationRef: 'create-b' });
  if (!b.ok) throw new Error(b.error.code);
  expect((await c.service.read(b.data.session.id))).toMatchObject({ ok: true, data: { runningRunId: null } });
  expect(await c.service.readInput({ inputId: queued.data.inputId })).toMatchObject({ ok: true, data: { sessionId: c.request.sessionId, status: 'queued' } });
  const cancellation = c.service.cancelInput(queued.data.inputId, { instanceId: 'host-a', operationRef: 'cancel-a' });
  await Bun.sleep(10); c.release();
  expect(await cancellation).toMatchObject({ ok: true, data: { sessionId: c.request.sessionId, status: 'cancelled', processingStatus: 'cancelled', nativeEntryId: null } });
  await until(() => c.app.runs.activeHandle === null);
  expect(c.requests).toHaveLength(1);
  expect(c.repo.readWorkspace().sessionId).toBe(b.data.session.id);
  expect(c.repo.readInput({ inputId: accepted.data.inputId })).toMatchObject({ status: 'consumed', processingStatus: 'completed' });
});

test('consumption save failure retains the exact native fact and retries without another request', async () => {
  const c = await runtimeFixture();
  const accepted = await c.service.submit(c.request, { instanceId: 'host-a', operationRef: 'send-a' });
  if (!accepted.ok || accepted.data.inputId === null || accepted.data.runId === null) throw new Error('Missing root');
  await c.requested;
  c.db.exec("CREATE TRIGGER fail_input_consumption BEFORE UPDATE OF status ON session_inputs WHEN NEW.status='consumed' AND OLD.mode='steer' BEGIN SELECT RAISE(ABORT,'fixture save failure'); END");
  const queued = await c.service.submit({ ...c.request, mode: 'steer', targetRunId: accepted.data.runId, clientSequence: 2, text: 'Correct A' },
    { instanceId: 'host-a', operationRef: 'steer-a' });
  if (!queued.ok || queued.data.inputId === null) throw new Error('Missing queued input');
  c.release();
  await until(() => c.agent.inputPersistencePending(accepted.data.runId!));
  await until(() => c.notices.some(notice => notice.type === 'agent.persistence_failed'));
  expect(c.app.runs.activeHandle?.runId).toBe(accepted.data.runId);
  expect(c.repo.readInput({ inputId: queued.data.inputId })?.status).toBe('queued');
  const requests = c.requests.length;
  c.db.exec('DROP TRIGGER fail_input_consumption');
  expect(await c.app.runs.retrySave(accepted.data.runId)).toMatchObject({ ok: true, data: { status: 'failed', inputId: accepted.data.inputId } });
  expect(c.app.runs.activeHandle).toBeNull();
  expect(c.repo.readInput({ inputId: queued.data.inputId })).toMatchObject({ status: 'consumed', processingStatus: 'failed', runId: accepted.data.runId });
  expect(c.requests.length).toBe(requests);
  expect(c.repo.read({ runId: accepted.data.runId })).toMatchObject({ kind: 'one', run: { status: 'failed' } });
});

test('final save rollback holds the original root; retry commits input and output without native replay', async () => {
  const c = await runtimeFixture();
  const accepted = await c.service.submit(c.request, { instanceId: 'host-a', operationRef: 'send-a' });
  if (!accepted.ok || accepted.data.inputId === null || accepted.data.runId === null) throw new Error('Missing root');
  await c.requested;
  c.db.exec("CREATE TRIGGER fail_run_final BEFORE UPDATE OF status ON runs WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'fixture final save failure'); END");
  c.release(); await until(() => c.notices.some(notice => notice.type === 'agent.persistence_failed'));
  expect(c.repo.readInput({ inputId: accepted.data.inputId })).toMatchObject({ status: 'consumed', processingStatus: 'pending' });
  expect(c.db.query('SELECT COUNT(*) AS n FROM answers').get()).toEqual({ n: 0 });
  expect(await c.app.runs.readControl()).toMatchObject({ ok: true, data: { acceptingNewRuns: false } });
  const requests = c.requests.length;
  c.db.exec('DROP TRIGGER fail_run_final');
  expect(await c.app.runs.retrySave(accepted.data.runId)).toMatchObject({ ok: true, data: { status: 'completed', inputId: accepted.data.inputId } });
  expect(c.app.runs.activeHandle).toBeNull();
  expect(c.repo.readInput({ inputId: accepted.data.inputId })).toMatchObject({ status: 'consumed', processingStatus: 'completed' });
  expect(c.db.query('SELECT input_id,output_text FROM runs').all()).toEqual([{ input_id: accepted.data.inputId, output_text: 'Fixture analysis complete.' }]);
  expect(c.requests.length).toBe(requests);
});

test('Stop closes admission and removes the queued input without starting another model request', async () => {
  const c = await runtimeFixture();
  const accepted = await c.service.submit(c.request, { instanceId: 'host-a', operationRef: 'send-a' });
  if (!accepted.ok || accepted.data.inputId === null || accepted.data.runId === null) throw new Error('Missing root');
  await c.requested;
  const queued = await c.service.submit({ ...c.request, mode: 'follow_up', targetRunId: accepted.data.runId, clientSequence: 2, text: 'Later A' },
    { instanceId: 'host-a', operationRef: 'follow-a' });
  if (!queued.ok || queued.data.inputId === null) throw new Error('Missing queued input');
  const stop = c.app.runs.cancel(accepted.data.runId);
  expect(c.app.runs.readInputControl(c.request.sessionId)?.acceptingInputs).toBe(false);
  c.release(); expect(await stop).toMatchObject({ ok: true, data: { stopped: true, committedStatus: 'cancelled' } });
  await until(() => c.app.runs.activeHandle === null);
  expect(c.repo.readInput({ inputId: queued.data.inputId })).toMatchObject({ status: 'cancelled', processingStatus: 'cancelled', nativeEntryId: null });
  expect(c.repo.readInput({ inputId: accepted.data.inputId })).toMatchObject({ status: 'consumed', processingStatus: 'cancelled' });
  expect(c.requests).toHaveLength(1);
});

test('ordinary original lookup survives lost acceptance and changed Session without conflict-driven replay', async () => {
  const c = await runtimeFixture();
  const accepted = await c.service.submit(c.request, { instanceId: 'host-a', operationRef: 'send-a' });
  if (!accepted.ok || accepted.data.inputId === null || accepted.data.runId === null) throw new Error('Missing root');
  await c.requested;
  const b = await c.service.create({ expectedWorkspaceRevision: c.repo.readWorkspace().revision }, { instanceId: 'host-a', operationRef: 'create-b' });
  if (!b.ok) throw new Error(b.error.code);
  expect(await c.service.readSubmission({ sessionId: c.request.sessionId, clientSequence: 1 })).toEqual({ ok: true, data: accepted.data });
  expect(await c.service.submit(c.request, { instanceId: 'host-a', operationRef: 'send-a' })).toEqual(accepted);
  expect(await c.service.submit({ ...c.request, text: 'Changed meaning' }, { instanceId: 'host-a', operationRef: 'send-a' }))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await c.service.submit(c.request, { instanceId: 'host-a', operationRef: 'different-operation' }))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(c.repo.readWorkspace().sessionId).toBe(b.data.session.id);
  expect(c.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
  expect(c.requests).toHaveLength(1);
  c.release(); await until(() => c.app.runs.activeHandle === null);
});

test('a rejected delivery marker proves no native dispatch and preserves that failure through retry', async () => {
  const c = await runtimeFixture();
  const accepted = await c.service.submit(c.request, { instanceId: 'host-a', operationRef: 'send-a' });
  if (!accepted.ok || accepted.data.inputId === null || accepted.data.runId === null) throw new Error('Missing root');
  await c.requested;
  c.db.exec("CREATE TRIGGER fail_input_write BEFORE UPDATE ON session_inputs WHEN OLD.mode='follow_up' BEGIN SELECT RAISE(ABORT,'fixture input save failure'); END");
  const queued = await c.service.submit({ ...c.request, mode: 'follow_up', targetRunId: accepted.data.runId, clientSequence: 2, text: 'Undispatched' },
    { instanceId: 'host-a', operationRef: 'follow-a' });
  if (!queued.ok || queued.data.inputId === null) throw new Error('Missing queued input');
  c.release(); await until(() => c.notices.some(notice => notice.type === 'agent.persistence_failed'));
  expect(c.requests).toHaveLength(1);
  expect(c.repo.readInput({ inputId: queued.data.inputId })?.status).toBe('queued');
  c.db.exec('DROP TRIGGER fail_input_write');
  expect(await c.app.runs.retrySave(accepted.data.runId)).toMatchObject({ ok: true, data: { status: 'failed' } });
  expect(c.repo.readInput({ inputId: queued.data.inputId })).toMatchObject({ status: 'failed', processingStatus: 'failed', runId: null, nativeEntryId: null });
  expect(c.requests).toHaveLength(1);
});
