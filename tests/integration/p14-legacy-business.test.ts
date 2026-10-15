import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_MATERIAL_PREFIX, PrepareIntentContextInputSchema, renderIntentContext } from '../../packages/contracts/src/context';
import { IntentStageInputSchema } from '../../packages/contracts/src/intent';
import { canonicalRequest } from '../../packages/contracts/src/run';
import { SqliteContextStore } from '../../packages/storage/src/context-store';
import { openDatabase } from '../../packages/storage/src/database';
import { acceptContextInput, contextFixture } from '../fixtures/p8-context';
import { intentInput } from '../fixtures/p14-intent';

test('p14 delivery updates preserve the original legacy input fields and their JSON order', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-legacy-input-')), db = openDatabase(join(root, 'app.sqlite'));
  try {
    const f = acceptContextInput(db, { consume: false }), row = db.query<{ content_json: string }, [number]>('SELECT content_json FROM session_inputs WHERE id=?').get(f.input.inputId)!;
    const { model, ...rest } = JSON.parse(row.content_json);
    const legacy = { model: { ...model, endpointRef: 'retired endpoint metadata' }, ...rest,
      resourceInputPlan: { kind: 'plain', resourceRef: null, dispatchText: f.content.text } };
    const trigger = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_schema WHERE name='session_inputs_identity_immutable'").get()!.sql;
    db.exec('DROP TRIGGER session_inputs_identity_immutable');
    db.query('UPDATE session_inputs SET content_json=? WHERE id=?').run(JSON.stringify(legacy, null, 2), f.input.inputId);
    db.exec(trigger);
    f.repos.beginInputDelivery(f.input.inputId, 'host', f.input.createdAt);
    f.repos.recordInputConsumption(f.input.inputId, { runId: f.input.runId, sessionId: f.input.sessionId,
      nativeEntryId: f.input.nativeEntryId, at: f.input.createdAt, nativeInput: { text: f.content.text } });
    const saved = JSON.parse(db.query<{ content_json: string }, [number]>('SELECT content_json FROM session_inputs WHERE id=?').get(f.input.inputId)!.content_json);
    expect(saved.model).toEqual(legacy.model);
    expect(saved.originalSubmitInput).toEqual(legacy.originalSubmitInput);
    expect(Object.keys(saved)[0]).toBe('model');
    expect(saved.nativeInput).toEqual({ text: f.content.text });
    expect(f.repos.readInput({ inputId: f.input.inputId })).toMatchObject({ status: 'consumed', text: f.content.text });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('p14 legacy Context reads preserve business values and the original stored projection', () => {
  const f = contextFixture();
  try {
    const store = new SqliteContextStore(f.db), snapshot = store.save(store.select(f.input));
    const row = f.db.query<{ snapshot_json: string }, [number]>('SELECT snapshot_json FROM context_snapshots WHERE id=?').get(snapshot.id)!;
    const body = JSON.parse(row.snapshot_json), projection = JSON.parse(body.renderedProjection.slice(CONTEXT_MATERIAL_PREFIX.length));
    const value = { hash: 'literal clinical field', nested: { sha256: 'literal report field' } };
    projection.materials.push({ ref: { kind: 'input', id: String(f.input.inputId), version: 'medclaw.session-input/v1', hash: 'retired metadata' },
      source: 'user_requirement', provenance: null, fieldOrigins: {}, value });
    body.renderedProjection = CONTEXT_MATERIAL_PREFIX + canonicalRequest(projection);
    body.projectionHash = 'retired metadata'; body.feedbackHash = 'retired metadata';
    body.nativeRefs[0].contentHash = 'retired metadata'; body.selectedRefs[0].hash = 'retired metadata';
    const original = JSON.stringify(body);
    f.db.exec('DROP TRIGGER context_snapshot_no_update');
    f.db.query('UPDATE context_snapshots SET snapshot_json=? WHERE id=?').run(original, snapshot.id);
    const read = store.read({ snapshotId: snapshot.id });
    expect(read.kind).toBe('snapshot'); if (read.kind !== 'snapshot') throw new Error('Missing snapshot');
    expect(read.snapshot).not.toHaveProperty('projectionHash');
    expect(read.snapshot.nativeRefs[0]).not.toHaveProperty('contentHash');
    expect(read.snapshot.renderedProjection).toBe(body.renderedProjection);
    expect(JSON.parse(read.snapshot.renderedProjection.slice(CONTEXT_MATERIAL_PREFIX.length)).materials[0].value).toEqual(value);
    expect(f.db.query<{ snapshot_json: string }, [number]>('SELECT snapshot_json FROM context_snapshots WHERE id=?').get(snapshot.id)?.snapshot_json).toBe(original);
    body.unexpectedMetadata = true;
    f.db.query('UPDATE context_snapshots SET snapshot_json=? WHERE id=?').run(JSON.stringify(body), snapshot.id);
    expect(() => store.read({ snapshotId: snapshot.id })).toThrow('storage_read_failed');
  } finally { f.dispose(); }
});

for (const policyVersion of ['medclaw.intent-policy/v2', 'medclaw.intent-policy/v5'] as const) {
  test(`p14 legacy ${policyVersion} Intent text is verified from its saved stage without rewriting it`, () => {
    const f = contextFixture();
    try {
      const accepted = f, session = accepted.repos.readSession(accepted.input.sessionId)!;
      const stage = IntentStageInputSchema.parse({ input: { ...intentInput(), runId: accepted.input.runId, inputId: accepted.input.inputId,
        sessionId: accepted.input.sessionId, text: accepted.request.text, referenceDate: accepted.request.referenceDate,
        scope: accepted.input.scope, baseLeafId: session.leafId, baseStorageVersion: session.storageVersion,
        versions: { ...intentInput().versions, policyVersion } }, stage: 'classify', review: null });
      const { nativeEntryId: _nativeEntryId, runtimeFeedback: _runtimeFeedback, ...owner } = accepted.input;
      const store = new SqliteContextStore(f.db), snapshot = store.save(store.selectIntent(PrepareIntentContextInputSchema.parse({ ...owner,
        projection: stage, baseLeafId: session.leafId, baseStorageVersion: session.storageVersion })));
      const body = JSON.parse(f.db.query<{ snapshot_json: string }, [number]>('SELECT snapshot_json FROM context_snapshots WHERE id=?').get(snapshot.id)!.snapshot_json);
      const oldStage = { ...stage, input: { ...stage.input, scopeBatchHashes: ['retired metadata'] } };
      body.renderedProjection = renderIntentContext(oldStage);
      if (policyVersion === 'medclaw.intent-policy/v5') body.intentSource.stageInput = oldStage;
      body.projectionHash = 'retired metadata'; body.feedbackHash = 'retired metadata';
      const original = JSON.stringify(body);
      f.db.exec('DROP TRIGGER context_snapshot_no_update');
    f.db.query('UPDATE context_snapshots SET snapshot_json=? WHERE id=?').run(original, snapshot.id);
      const read = store.read({ snapshotId: snapshot.id });
      expect(read.kind).toBe('snapshot'); if (read.kind !== 'snapshot') throw new Error('Missing snapshot');
      expect(read.snapshot.renderedProjection).toBe(body.renderedProjection);
      if (policyVersion === 'medclaw.intent-policy/v5') expect(read.snapshot.intentSource?.stageInput).toEqual(stage);
      expect(f.db.query<{ snapshot_json: string }, [number]>('SELECT snapshot_json FROM context_snapshots WHERE id=?').get(snapshot.id)?.snapshot_json).toBe(original);
      body.renderedProjection += ' changed';
      f.db.query('UPDATE context_snapshots SET snapshot_json=? WHERE id=?').run(JSON.stringify(body), snapshot.id);
      expect(() => store.read({ snapshotId: snapshot.id })).toThrow('storage_read_failed');
    } finally { f.dispose(); }
  });
}
