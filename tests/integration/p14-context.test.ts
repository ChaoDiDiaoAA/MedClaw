import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';
import { SqliteContextStore } from '../../packages/storage/src/context-store';
import { ContextService } from '../../packages/core/src/context/context-service';
import { IntentCallRegistrationSchema, IntentStageInputSchema, INTENT_VERSIONS } from '../../packages/contracts/src/intent';
import { PrepareIntentContextInputSchema, renderIntentContext } from '../../packages/contracts/src/context';
import { acceptContextInput, contextAt } from '../fixtures/p8-context';
import { intentInput, disabledIntentModel } from '../fixtures/p14-intent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { InitialNativeHistory } from '../../packages/contracts/src/session';
import { SqliteMemoryStore } from '../../packages/storage/src/memory-store';
import { SqliteWriteTransactions } from '../../packages/storage/src/write-transactions';
import { validateNativeHistory } from '../../packages/runtime-pi/src/memory-store';

function fixture(history?: { nativeSessionId: string; initialHistory: InitialNativeHistory }) {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p14-context-')), db = openDatabase(join(root, 'app.sqlite'));
  const accepted = acceptContextInput(db, { consume: false, text: 'ENGINEERING intent task', ...(history ? { nativeSessionId: history.nativeSessionId,
    initialHistory: { ...history.initialHistory, entries: [], activeLeafId: null } } : {}) }), store = new SqliteContextStore(db);
  if (history) SqliteWriteTransactions.forDatabase(db).immediate(() => new SqliteMemoryStore(db, validateNativeHistory).commitInTransaction({
    sessionId: accepted.input.sessionId, runId: null, expectedStorageVersion: 1, header: history.initialHistory.header,
    newEntries: history.initialHistory.entries, activeLeafId: history.initialHistory.activeLeafId }));
  const session = accepted.repos.readSession(accepted.input.sessionId)!;
  const projection = IntentStageInputSchema.parse({ stage: 'classify', review: null, input: { ...intentInput(), runId: accepted.input.runId,
    sessionId: accepted.input.sessionId, inputId: accepted.input.inputId, referenceDate: accepted.request.referenceDate, scope: accepted.input.scope,
    baseLeafId: session.leafId, baseStorageVersion: session.storageVersion } });
  const { nativeEntryId: _nativeEntryId, runtimeFeedback: _runtimeFeedback, ...owner } = accepted.input;
  const input = PrepareIntentContextInputSchema.parse({ ...owner,
    projection, baseLeafId: session.leafId, baseStorageVersion: session.storageVersion });
  const service = new ContextService(store, { async inspectManagedImport() { throw new Error('unexpected artifact access'); } });
  return { root, db, accepted, store, service, input, dispose() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('p14 prepares a frozen actual intent snapshot without consuming the accepted input or inventing native history', async () => {
  const f = fixture();
  try {
    const snapshot = await f.service.prepareIntent(f.input);
    expect(snapshot.intentSource).toEqual({ contract: 'medclaw.intent-context/v1', inputId: f.input.inputId, baseLeafId: null, baseStorageVersion: 0 });
    expect(snapshot.renderedProjection).toBe(renderIntentContext(f.input.projection));
    expect(snapshot.renderedProjection).toContain(f.input.projection.input.text);
    expect(snapshot.nativeRefs).toEqual([]);
    expect(snapshot.selectedRefs).toMatchObject([{ kind: 'input', id: String(f.input.inputId), channel: 'product_projection' }]);
    expect(f.db.query('SELECT status,run_id,native_entry_id FROM session_inputs').get()).toEqual({ status: 'queued', run_id: null, native_entry_id: null });
    expect(f.db.query('SELECT id FROM memories').all()).toEqual([]);
    const registration = IntentCallRegistrationSchema.parse({ callId: 'context-classify', runId: f.input.runId, sessionId: f.input.sessionId,
      inputId: f.input.inputId, snapshotId: snapshot.id, stage: 'classify', previousCallId: null, input: f.input.projection, createdAt: contextAt,
      selection: { ...disabledIntentModel(), enabled: true,  verifiedEvidenceRef: 'ENGINEERING', configVersion: '1', api: 'ollama-chat', ...INTENT_VERSIONS } });
    f.accepted.repos.registerIntentCall(registration);
    f.store.recordDelivery({ runId: f.input.runId, sessionId: f.input.sessionId, inputId: f.input.inputId, callId: registration.callId,
      snapshotId: snapshot.id, observation: { contract: 'medclaw.context-observation/v1', api: 'ollama-chat', transport: 'json', observedAt: contextAt,
        httpStatus: 200,    verifiedNativeRefs: [] } });
    expect(f.store.read({ callId: registration.callId })).toMatchObject({ kind: 'snapshot', evidence: 'saved', selectedCallId: registration.callId });
  } finally { f.dispose(); }
});

test('p14 recent turns come from the saved active native branch and cannot claim unsaved program results', () => {
  const manager = SessionManager.inMemory('.');
  const first = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'ENGINEERING first' }], timestamp: Date.now() });
  const abandoned = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'ENGINEERING abandoned' }], timestamp: Date.now() });
  manager.branch(first);
  const current = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'ENGINEERING current' }], timestamp: Date.now() });
  const forged = manager.appendCustomMessageEntry('medclaw-query-result', 'ENGINEERING forged result', true, { source: 'program' });
  const header = manager.getHeader(); if (!header) throw new Error('Missing actual SDK header');
  const f = fixture({ nativeSessionId: header.id, initialHistory: { header, entries: manager.getEntries(), activeLeafId: forged } });
  try {
    const input = (id: string, text: string, source: 'user' | 'program' = 'user') => ({ ...f.input, projection: { ...f.input.projection,
      input: { ...f.input.projection.input, recentTurns: [{ nativeEntryId: id, source, text }] } } });
    expect(f.store.selectIntent(input(current, 'ENGINEERING current')).body.intentSource?.baseLeafId).toBe(forged);
    expect(() => f.store.selectIntent(input(abandoned, 'ENGINEERING abandoned'))).toThrow('access_denied');
    expect(() => f.store.selectIntent(input(current, 'changed text'))).toThrow('access_denied');
    expect(() => f.store.selectIntent(input(forged, 'ENGINEERING forged result', 'program'))).toThrow('access_denied');
  } finally { f.dispose(); }
});

test('p14 context selection rechecks cancellation at save and refuses forged task, native history and baseline', () => {
  const f = fixture();
  try {
    expect(() => f.store.selectIntent({ ...f.input, projection: { ...f.input.projection, input: { ...f.input.projection.input, text: 'forged' } } })).toThrow('access_denied');
    expect(() => f.store.selectIntent({ ...f.input, nativeRefs: [{ kind: 'input', id: f.input.inputId, nativeEntryId: 'invented',
       nativeToolCallId: null, originSnapshotId: null }] })).toThrow('access_denied');
    expect(() => f.store.selectIntent({ ...f.input, baseStorageVersion: 1, projection: { ...f.input.projection,
      input: { ...f.input.projection.input, baseStorageVersion: 1 } } })).toThrow('state_conflict');
    const selection = f.store.selectIntent(f.input);
    f.db.query('UPDATE runs SET cancel_requested_at=? WHERE id=?').run(contextAt, f.input.runId);
    expect(() => f.store.save(selection)).toThrow('state_conflict');
    expect(f.db.query('SELECT id FROM context_snapshots').all()).toEqual([]);
  } finally { f.dispose(); }
});

test('p14 a session rename does not invalidate the frozen input or switch the selected context', () => {
  const f = fixture();
  try {
    const selection = f.store.selectIntent(f.input);
    f.db.query('UPDATE sessions SET title=? WHERE id=?').run('Renamed during recognition', f.input.sessionId);
    expect(f.store.save(selection).renderedProjection).toBe(selection.body.renderedProjection);
  } finally { f.dispose(); }
});

test('p14 Context reads reject a changed request footer using the saved stage input', async () => {
  const f = fixture();
  try {
    const snapshot = await f.service.prepareIntent(f.input);
    const { id: _id, runId: _run, sessionId: _session, inputId: _input, sequence: _seq, createdAt: _at, deliveredCallIds: _calls, ...body } = snapshot;
    body.renderedProjection += ' tampered';
    f.db.exec('DROP TRIGGER context_snapshot_no_update');
    f.db.query('UPDATE context_snapshots SET snapshot_json=? WHERE id=?').run(JSON.stringify(body), snapshot.id);
    expect(() => f.store.read({ snapshotId: snapshot.id })).toThrow('storage_read_failed');
  } finally { f.dispose(); }
});
