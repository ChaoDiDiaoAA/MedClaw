import { expect, test } from 'bun:test';
import { SubmitInputSchema } from '../../packages/contracts/src/session';
import { WorkspaceViewSchema } from '../../packages/contracts/src/workspace';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { Repositories } from '../../packages/storage/src/repositories';

test('P3 submission carries selected batch identities without accepting a renderer-signed Scope', () => {
  const input = {
    clientSequence: 1,
    sessionId: 1,
    text: 'Count devices on the selected date',
    mode: 'send',
    expectedRevision: 1,
    expectedBatchIds: [1, 2],
    expectedQueryId: null,
    model: { provider: 'test', modelId: 'text', expectedConfigVersion: '1' },
    referenceDate: '2026-01-01',
    timezone: 'Asia/Shanghai',
  };
  expect(SubmitInputSchema.safeParse(input).success).toBe(true);
  expect(SubmitInputSchema.safeParse({ ...input, expectedBatchIds: [1, 1] }).success).toBe(false);
  expect(SubmitInputSchema.safeParse({ ...input, scope: { batchIds: [99], allowedToolNames: ['write'] } }).success).toBe(false);
  expect(SubmitInputSchema.safeParse({ ...input, nativeToolCallId: 'forged' }).success).toBe(false);
});

test('workspace selection uses trusted batch identities and compare-and-swap while an accepted Scope stays frozen', () => {
  const db = new Database(':memory:');
  try {
    db.exec(readFileSync(new URL('../../packages/storage/src/migrations/001_p1.sql', import.meta.url), 'utf8'));
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec(readFileSync(new URL('../../packages/storage/src/migrations/002_p2.sql', import.meta.url), 'utf8'));
    db.exec(`ALTER TABLE workspace ADD COLUMN material_version TEXT;
      ALTER TABLE workspace ADD COLUMN batch_refs_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE workspace ADD COLUMN device_ids_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE workspace ADD COLUMN active_query_id INTEGER;
      ALTER TABLE workspace ADD COLUMN active_view TEXT NOT NULL DEFAULT 'data';
      ALTER TABLE workspace ADD COLUMN selection_json TEXT;
      CREATE TABLE imports(id INTEGER PRIMARY KEY, artifact_id INTEGER);
      CREATE TABLE batches(id INTEGER PRIMARY KEY, import_id INTEGER, content_hash TEXT, snapshot_date TEXT, scope_key TEXT, material_version TEXT);
      CREATE TABLE snapshots(id INTEGER PRIMARY KEY, batch_id INTEGER, device_id INTEGER);
      CREATE TABLE queries(id INTEGER PRIMARY KEY,session_id INTEGER,batch_ids_json TEXT,result_json TEXT);
      INSERT INTO imports VALUES(1,5);
      INSERT INTO batches VALUES(1,1,'hash-1','2026-01-01','scope','v1'),(2,1,'hash-2','2026-01-02','scope','v1');
      INSERT INTO snapshots VALUES(1,1,11),(2,2,11);`);
    const repo = new Repositories(db);
    const initial = repo.readWorkspace();
    const selected = repo.updateWorkspace({ batchIds: [1, 2], deviceIds: [11] }, initial.revision, '2026-10-02T00:00:00.000Z');
    expect(selected.batchRefs.map(batch => batch.contentHash)).toEqual(['hash-1', 'hash-2']);
    const frozen = repo.freezeAgentScope(selected, ['read_data_scope', 'write']);
    expect(frozen).toMatchObject({ batchIds: [1, 2], deviceIds: [11], artifactIds: [5], allowedToolNames: ['read_data_scope', 'write'], readOnly: false });
    expect(() => repo.updateWorkspace({ batchIds: [2] }, initial.revision, '2026-10-02T00:00:01.000Z')).toThrow('workspace_revision_mismatch');
    expect(() => repo.updateWorkspace({ deviceIds: [99] }, selected.revision, '2026-10-02T00:00:01.000Z')).toThrow('access_denied');
    const narrowed = repo.updateWorkspace({ batchIds: [2], deviceIds: [] }, selected.revision, '2026-10-02T00:00:01.000Z');
    expect(narrowed.batchRefs.map(batch => batch.id)).toEqual([2]);
    expect(frozen.batchIds).toEqual([1, 2]);
    expect(() => repo.freezeAgentScope({ ...selected, batchRefs: selected.batchRefs.map(batch => ({ ...batch, contentHash: 'forged' })) }, ['read_data_scope'])).toThrow('access_denied');
  } finally { db.close(); }
});

test('P3 workspace keeps content identities while rejecting invented batch and entity identifiers', () => {
  const workspace = {
    revision: 1,
    sessionId: 1,
    materialVersion: 'material/v1',
    batchRefs: [{ id: 1, contentHash: 'hash', snapshotDate: '2026-01-01', scopeKey: 'scope' }],
    deviceIds: [],
    queryId: null,
    activeView: 'data',
    selection: null,
  };
  expect(WorkspaceViewSchema.safeParse(workspace).success).toBe(true);
  expect(WorkspaceViewSchema.safeParse({ ...workspace, deviceIds: [-1] }).success).toBe(false);
  expect(WorkspaceViewSchema.safeParse({ ...workspace, batchRefs: [...workspace.batchRefs, ...workspace.batchRefs] }).success).toBe(false);
});
