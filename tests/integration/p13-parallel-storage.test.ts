import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { openDatabase, SCHEMA_VERSION } from '../../packages/storage/src/database';
import { validateDatabaseSnapshot } from '../../packages/storage/src/schema-validation';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteContextStore } from '../../packages/storage/src/context-store';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { DEFAULT_AGENT_POLICY, normalizeRuntimeConfiguration } from '../../packages/contracts/src/runtime-config';
import { normalizeToolConfiguration } from '../../packages/contracts/src/tool-config';
import { safeError } from '../../packages/contracts/src/error';
import type { BoundChildIdentity, FrozenRunSubagents, RegisterChildInput } from '../../packages/contracts/src/subagent';
import { SUBAGENT_BUILD } from '../../packages/runtime-pi/src/subagent-adapter';
import { acceptContextInput, contextAt } from '../fixtures/p8-context';
import { sqliteHistory } from '../fixtures/p9-memory';

function fixture(subagents?: FrozenRunSubagents) {
  const directory = mkdtempSync(join(tmpdir(), 'medclaw-p13-parallel-storage-'));
  const path = join(directory, 'app.sqlite'), db = openDatabase(path), history = sqliteHistory(db);
  const repos = new Repositories(db, undefined, undefined, undefined, history.store);
  const acceptedSubagents=subagents?structuredClone(subagents):undefined;
  const accept=repos.acceptInput.bind(repos);
  repos.acceptInput=plan=>accept(acceptedSubagents&&plan.execution.mode==='send'
    ?{...plan,execution:{mode:'send',run:{...plan.execution.run,subagents:acceptedSubagents}}}:plan);
  const parent = acceptContextInput(db, { repositories: repos, toolNames: ['Agent', 'read'] });
  const contexts = new SqliteContextStore(db), snapshot = contexts.save(contexts.select(parent.input));
  repos.startCall(parent.input.runId, 'parallel-parent-call', 'main', contextAt, { inputId: parent.input.inputId, snapshotId: snapshot.id });
  const tools = new SqliteToolStore(db), signal = new AbortController().signal;
  const requests = new Map<number, RegisterChildInput>();
  function request(index: number): RegisterChildInput {
    const existing = requests.get(index); if (existing) return existing;
    const prompt = `ENGINEERING independent review ${index}`;
    const role=acceptedSubagents?.roles[0],toolNames=role?.declaredTools??['read'];
    const origin = tools.request({ name: 'Agent', version: 'fixture', effect: 'READ', executionMode: 'sequential' },
      { prompt, description: 'ENGINEERING storage boundary', subagent_type: role?.roleId??'medclaw-audit', run_in_background: false },
      { runId: parent.input.runId, sessionId: parent.input.sessionId, scope: parent.input.scope,
        referenceDate: parent.request.referenceDate, timezone: parent.request.timezone, workspaceContext: parent.input.workspaceContext,
        nativeToolCallId: `parallel-Agent-${index}`, modelCallId: 'parallel-parent-call', contextSnapshotId: snapshot.id, signal,
        workspaceInputId: parent.input.inputId, basedOnQueryId: null, workspaceRevision: parent.input.workspaceContext.revision });
    const header = structuredClone(SessionManager.inMemory(directory).getHeader()!);
    const frozen = { ...SUBAGENT_BUILD, contract: 'medclaw.subagent/v1' as const, instanceId: 'host',
      parentRunId: parent.input.runId, parentSessionId: parent.input.sessionId,
      originToolCallId: origin.id, originNativeToolCallId: origin.nativeToolCallId, pluginAgentId: `parallel-plugin-${index}`,
      nativeSessionId: header.id, originSnapshotId: snapshot.id, parentInputId: parent.input.inputId,
      ...(role?{role}:{}), toolNames, depth: 1 as const, foreground: true as const, scope: { ...parent.input.scope, allowedToolNames: toolNames, readOnly: true },
      model: parent.run.model, policy: parent.run.policy, agentPolicy: DEFAULT_AGENT_POLICY,
      runtimeConfiguration: normalizeRuntimeConfiguration(), toolConfiguration: normalizeToolConfiguration() };
    const input = { parentRunId: parent.input.runId, originToolCallId: origin.id, pluginAgentId: frozen.pluginAgentId,
      nativeSessionId: header.id, prompt, frozen, initialHistory: { header, entries: [], activeLeafId: null }, createdAt: contextAt };
    requests.set(index, input); return input;
  }
  function finish(identity: BoundChildIdentity) {
    const input = [...requests.values()].find(value => value.originToolCallId === identity.originToolCallId)!;
    const cleanup = { contract: 'medclaw.run-cleanup/v1' as const, executionStarted: false, stopConfirmed: true,
      requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: false,
      unconfirmedItems: ['resources'], secondaryErrors: [], verifiedAt: null };
    repos.finalizeChild(identity.childRunId, { status: 'failed', endedAt: contextAt, outputText: '', error: safeError('internal_error'),
      calls: [], history: { sessionId: identity.childSessionId, runId: identity.childRunId, expectedStorageVersion: 1,
        header: input.initialHistory.header, newEntries: [], activeLeafId: null }, cleanup, compactions: [],
      childResult: { contract: 'medclaw.child-result/v1', childRunId: identity.childRunId, childSessionId: identity.childSessionId,
        parentRunId: identity.parentRunId, originToolCallId: identity.originToolCallId, pluginAgentId: identity.pluginAgentId,
        nativeSessionId: identity.nativeSessionId, outcome: 'failed', text: '', queryRefs: [], evidenceIds: [], gaps: ['internal_error'],
        truncated: false, originalReply: { content: [{ type: 'text', text: 'ENGINEERING stopped without execution' }], details: {} },
        finalLeafId: null, storageVersion: 1, committedAt: contextAt } });
    return cleanup;
  }
  return { directory, path, db, repos, parent, request, finish,
    close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('p13 storage admits four original calls, rejects a fifth without partial identity, and waits for final release', () => {
  const f = fixture();
  try {
    const children = [1, 2, 3, 4].map(index => f.repos.registerChild(f.request(index)));
    expect(new Set(children.map(child => child.childRunId)).size).toBe(4);
    expect(new Set(children.map(child => child.childSessionId)).size).toBe(4);
    const fifth = f.request(5), counts = () => ['runs', 'sessions', 'memories', 'runtime_events'].map(table => f.db.query(`SELECT COUNT(*) n FROM ${table}`).get());
    const before = counts();
    expect(() => f.repos.registerChild(fifth)).toThrow('runtime_busy'); expect(counts()).toEqual(before);
    const cleanup = f.finish(children[0]!);
    expect(() => f.repos.registerChild(fifth)).toThrow('runtime_busy'); expect(counts()).not.toEqual(before);
    f.repos.saveRunCleanup(children[0]!.childRunId, { ...cleanup, resourcesReleased: true, unconfirmedItems: [], verifiedAt: contextAt });
    expect(f.repos.registerChild(fifth)).toMatchObject({ originToolCallId: fifth.originToolCallId, parentRunId: f.parent.input.runId });
    expect(() => f.repos.registerChild(fifth)).toThrow('state_conflict');
    expect(f.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { f.close(); }
});

for (const cleanup of [null, {}, { stopConfirmed: true, requiredPersistenceComplete: true, resourcesReleased: true }]) {
  test('p13 storage retains a terminal slot with missing final or invalid cleanup ' + JSON.stringify(cleanup), () => {
    const f = fixture();
    try {
      const children = [1, 2, 3, 4].map(index => f.repos.registerChild(f.request(index)));
      f.finish(children[0]!);
      f.db.query('UPDATE runs SET cleanup_json=? WHERE id=?').run(JSON.stringify(cleanup), children[0]!.childRunId);
      expect(() => f.repos.registerChild(f.request(5))).toThrow('runtime_busy');
    } finally { f.close(); }
  });
}

test('p13 storage keeps terminal children without a committed result and retains root, origin and ownership constraints', () => {
  const f = fixture();
  try {
    const children = [1, 2, 3, 4].map(index => f.repos.registerChild(f.request(index)));
    const cleanup = { contract: 'medclaw.run-cleanup/v1', executionStarted: false, stopConfirmed: true,
      requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: true,
      unconfirmedItems: [], secondaryErrors: [], verifiedAt: contextAt };
    f.db.query("UPDATE runs SET status='failed',cleanup_json=? WHERE id=?").run(JSON.stringify(cleanup), children[0]!.childRunId);
    expect(() => f.repos.registerChild(f.request(5))).toThrow('runtime_busy');
    expect(() => f.repos.registerChild(f.request(1))).toThrow('state_conflict');
    for (const sql of ['UPDATE runs SET parent_run_id=999', 'UPDATE runs SET origin_tool_call_id=999', "UPDATE runs SET instance_id='another-host'"])
      expect(() => f.db.query(sql+' WHERE id=?').run(children[0]!.childRunId)).toThrow(/child_(?:owner_mismatch|run_identity_immutable)/);
    expect(() => f.db.query('UPDATE sessions SET native_session_id=? WHERE id=?').run('another-native', children[0]!.childSessionId)).toThrow('child_session_identity_immutable');
    expect(() => f.db.query("INSERT INTO runs(session_id,input_id,kind,instance_id,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at) SELECT session_id,input_id,kind,instance_id,'created',goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at FROM runs WHERE id=?").run(f.parent.input.runId)).toThrow('UNIQUE constraint failed');
    expect(f.db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  } finally { f.close(); }
});

test('p13 role snapshots persist the accepted content and leave old records unrecorded', () => {
  const snapshot: FrozenRunSubagents = { roles: [{ roleId: 'general-analyst', description: 'Independent analysis',
    source: { kind: 'builtin', file: 'general-analyst.md' }, content: '---\nname: general-analyst\ndescription: Independent analysis\ntools: []\n---\nAnalyze supplied material.', declaredTools: [] }], diagnostics: [], indexText: 'general-analyst: Independent analysis' };
  const f=fixture(snapshot), legacy=fixture();
  try {
    expect(f.repos.readRunSubagents(f.parent.input.runId)).toEqual(snapshot);
    snapshot.roles[0]!.content='Changed after acceptance';
    const stored=f.repos.readRunSubagents(f.parent.input.runId)!;
    expect(stored.roles[0]!.content).toContain('Analyze supplied material.');
    stored.roles[0]!.content='Changed returned object';
    expect(f.repos.readRunSubagents(f.parent.input.runId)!.roles[0]!.content).toContain('Analyze supplied material.');
    expect(legacy.repos.readRunSubagents(legacy.parent.input.runId)).toBeNull();
    const child=f.repos.registerChild(f.request(1));
    expect(f.repos.readRunSubagents(child.childRunId)).toBeNull();
    expect(() => f.repos.readRunSubagents(999)).toThrow('run_not_found');
  } finally { f.close(); legacy.close(); }
});

test('p13 storage binds the child role and complete tool declaration to the accepted parent snapshot and original call', () => {
  const snapshot:FrozenRunSubagents={roles:[{roleId:'medclaw-audit',description:'Audit',source:{kind:'builtin',file:'medclaw-audit.md'},
    content:'ENGINEERING accepted audit',declaredTools:['read']},
    {roleId:'general-analyst',description:'Analyze',source:{kind:'builtin',file:'general-analyst.md'},content:'ENGINEERING accepted analyst',declaredTools:[]}],diagnostics:[],indexText:'ENGINEERING roles'};
  const f=fixture(snapshot);
  try {
    const input=f.request(1),role=input.frozen.role!;
    expect(()=>f.repos.registerChild({...input,frozen:{...input.frozen,role:undefined}})).toThrow('access_denied');
    expect(()=>f.repos.registerChild({...input,frozen:{...input.frozen,role:{...role,content:'Edited after parent acceptance'}}})).toThrow('access_denied');
    expect(()=>f.repos.registerChild({...input,frozen:{...input.frozen,toolNames:[],scope:{...input.frozen.scope,allowedToolNames:[]}}})).toThrow('access_denied');
    expect(()=>f.repos.registerChild({...input,frozen:{...input.frozen,role:snapshot.roles[1],toolNames:[],scope:{...input.frozen.scope,allowedToolNames:[]}}})).toThrow('access_denied');
    expect(f.db.query("SELECT id FROM runs WHERE kind='child'").all()).toEqual([]);
    expect(f.repos.registerChild(input)).toMatchObject({originToolCallId:input.originToolCallId});
  } finally {f.close();}
});

test('p13 parallel migration changes only the single-child index and rolls back without losing schema16 rows', () => {
  const f = fixture();
  let db: Database = f.db;
  try {
    f.repos.registerChild(f.request(1));
    // Reconstruct the immediately preceding schema using its unchanged migration markers.
    if (SCHEMA_VERSION === 17) {
      db.exec('CREATE UNIQUE INDEX runs_one_child ON runs((1)) WHERE kind=\'child\' AND status IN (\'created\',\'running\'); DELETE FROM schema_migrations WHERE version=17;');
    }
    validateDatabaseSnapshot(db, 16);
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    const before = tables.map(table => db.query(`SELECT * FROM ${table} ORDER BY id`).all());
    const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    db.close();
    expect(() => { const opened = openDatabase(f.path, phase => { if (phase === 'p13_parallel_marker') throw new Error('ENGINEERING migration failure'); }); opened.close(); }).toThrow('storage_migration_failed');
    db = new Database(f.path, { strict: true });
    expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).toEqual(schema);
    for (const [index, table] of tables.entries()) expect(db.query(`SELECT * FROM ${table} ORDER BY id`).all()).toEqual(before[index]);
    db.close(); db = openDatabase(f.path);
    expect(SCHEMA_VERSION).toBe(17); validateDatabaseSnapshot(db, 17);
    expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name<>'runs_one_child' ORDER BY type,name").all())
      .toEqual(schema.filter(row => (row as { name: string }).name !== 'runs_one_child'));
    for (const [index, table] of tables.entries()) if (table !== 'schema_migrations') expect(db.query(`SELECT * FROM ${table} ORDER BY id`).all()).toEqual(before[index]);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('p13 schema17 stores an explicit version marker and rejects a changed marker on reopen and snapshot reads', () => {
  const f=fixture();
  let db=f.db;
  try {
    const historical=db.query('SELECT * FROM schema_migrations WHERE version<=16 ORDER BY version').all();
    expect(db.query('SELECT checksum FROM schema_migrations WHERE version=17').get()).toEqual({checksum:'medclaw.schema/17'});
    db.close();db=openDatabase(f.path);
    expect(db.query('SELECT * FROM schema_migrations WHERE version<=16 ORDER BY version').all()).toEqual(historical);
    validateDatabaseSnapshot(db,17);
    db.query("UPDATE schema_migrations SET checksum='changed-marker' WHERE version=17").run();
    expect(()=>validateDatabaseSnapshot(db,17)).toThrow('storage_migration_failed');
    db.close();
    expect(()=>openDatabase(f.path)).toThrow('storage_migration_failed');
  } finally {db.close();rmSync(f.directory,{recursive:true,force:true});}
});
