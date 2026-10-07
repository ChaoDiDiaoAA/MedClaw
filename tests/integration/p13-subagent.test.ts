import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { openDatabase, SCHEMA_VERSION } from '../../packages/storage/src/database';
import { acceptContextInput, contextAt } from '../fixtures/p8-context';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteContextStore } from '../../packages/storage/src/context-store';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { FrozenChildConfigSchema } from '../../packages/contracts/src/subagent';
import { normalizeRuntimeConfiguration, DEFAULT_AGENT_POLICY } from '../../packages/contracts/src/runtime-config';
import { normalizeToolConfiguration } from '../../packages/contracts/src/tool-config';
import { memoryNativeFixture, sqliteHistory } from '../fixtures/p9-memory';
import { join } from 'node:path';
import { loadP13Managed, p13AgentInput, withP13Plugin } from '../fixtures/p13-subagent';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { QueryService } from '../../packages/core/src/data/query-service';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { SqliteCatalogStore } from '../../packages/storage/src/catalog-store';

function frozenFixture(f: ReturnType<typeof acceptContextInput>, origin: { id: number; nativeToolCallId: string }, snapshotId: number,
  native: ReturnType<typeof memoryNativeFixture>, childRunId: number, childSessionId: number, pluginAgentId = 'plugin-child') {
  return FrozenChildConfigSchema.parse({
    contract: 'medclaw.subagent/v1', instanceId: 'host', parentRunId: f.input.runId, parentSessionId: f.input.sessionId,
    originToolCallId: origin.id, originNativeToolCallId: origin.nativeToolCallId, pluginAgentId, nativeSessionId: native.header.id, childRunId, childSessionId,
    originSnapshotId: snapshotId, parentInputId: f.input.inputId, promptHash: createHash('sha256').update(p13AgentInput.prompt).digest('hex'), pluginVersion: '0.19.0', pluginGitHead: '4f572eaa04c09d3dbc16e4a5f13a16b295e84e14', pluginIntegrity: 'sha512-fixture', patchHash: 'b'.repeat(64),
    toolNames: f.input.scope.allowedToolNames, depth: 1, foreground: true, scope: { ...f.input.scope, readOnly: true }, model: f.run.model, policy: f.run.policy, agentPolicy: DEFAULT_AGENT_POLICY,
    runtimeConfiguration: normalizeRuntimeConfiguration(), toolConfiguration: normalizeToolConfiguration(),
  });
}

test('p13 child Query access uses only frozen parent references or its own committed facts and preserves Workspace', () => {
  const root=mkdtempSync(join(tmpdir(),'medclaw-p13-query-')),db=openDatabase(join(root,'app.sqlite'));
  try {
    const prior=seedWorkspaceQueries(db);
    db.exec("UPDATE batches SET metadata_json=json_set(metadata_json,'$.referenceDate','2026-10-04','$.timezone','Asia/Shanghai')");
    prior.repos.updateWorkspace({queryId:prior.current.id},prior.repos.readWorkspace().revision,contextAt);
    const f=acceptContextInput(db,{toolNames:['read_query','query_current_devices']}),history=sqliteHistory(db),repos=new Repositories(db,undefined,undefined,undefined,history.store);
    const contexts=new SqliteContextStore(db),snapshot=contexts.save(contexts.select(f.input));
    f.repos.startCall(f.input.runId,'query-parent','main',contextAt,{inputId:f.input.inputId,snapshotId:snapshot.id});
    const tools=new SqliteToolStore(db),signal=new AbortController().signal;
    const origin=tools.request({name:'Agent',version:'fixture',effect:'READ',executionMode:'sequential'},p13AgentInput,
      {runId:f.input.runId,sessionId:f.input.sessionId,nativeToolCallId:'query-delegation',scope:f.input.scope,referenceDate:f.request.referenceDate,timezone:f.request.timezone,signal,
        modelCallId:'query-parent',contextSnapshotId:snapshot.id,workspaceContext:f.input.workspaceContext,workspaceInputId:f.input.inputId,basedOnQueryId:prior.current.id,workspaceRevision:f.input.workspaceContext.revision});
    const native=memoryNativeFixture(root),{childRunId:_run,childSessionId:_session,...frozen}=frozenFixture(f,origin,snapshot.id,native,f.input.runId+1,f.input.sessionId+1);
    const identity=repos.registerChild({parentRunId:f.input.runId,originToolCallId:origin.id,pluginAgentId:frozen.pluginAgentId,nativeSessionId:native.header.id,prompt:p13AgentInput.prompt,
      initialHistory:{header:native.header,entries:[],activeLeafId:null},frozen,createdAt:contextAt});
    const promptEntry={id:'delegated-query-prompt',type:'message',parentId:null,timestamp:contextAt,message:{role:'user',content:p13AgentInput.prompt,timestamp:Date.parse(contextAt)}};
    history.commitSync({sessionId:identity.childSessionId,runId:identity.childRunId,expectedStorageVersion:1,header:native.header,newEntries:[promptEntry],activeLeafId:promptEntry.id});
    const delegationSource={parentRunId:f.input.runId,originToolCallId:origin.id,parentSnapshotId:snapshot.id,parentInputId:f.input.inputId,promptHash:frozen.promptHash,nativeEntryId:promptEntry.id};
    const childSnapshot=contexts.save(contexts.selectChild({runId:identity.childRunId,sessionId:identity.childSessionId,inputId:null,delegationSource,scope:frozen.scope,runtimeFeedback:'ENGINEERING',nativeRefs:[],createdAt:contextAt}));
    repos.startCall(identity.childRunId,'query-child','main',contextAt,{inputId:null,snapshotId:childSnapshot.id,delegationSource});
    const context={runId:identity.childRunId,sessionId:identity.childSessionId,nativeToolCallId:'child-query',scope:frozen.scope,referenceDate:f.request.referenceDate,timezone:f.request.timezone,signal,
      modelCallId:'query-child',contextSnapshotId:childSnapshot.id,workspaceContext:null,workspaceInputId:null,basedOnQueryId:null,delegationSource};
    const queries=new QueryService(new CatalogService(new SqliteCatalogStore(db)),tools),workspace=repos.readWorkspace();
    expect(queries.read(prior.current.id,context)).toMatchObject({id:prior.current.id,sessionId:f.input.sessionId});
    expect(() => queries.read(prior.secondQueryId,context)).toThrow('access_denied');
    const childQuery=queries.current({batchIds:[1],time:{start:'2026-10-04',endExclusive:'2026-10-05'},snapshotMode:'exact_date',sort:'asc',page:1,pageSize:20},context);
    expect(queries.read(childQuery.queryId,context)).toMatchObject({runId:identity.childRunId,sessionId:identity.childSessionId,inputId:null});
    expect(db.query('SELECT input_id FROM queries WHERE id=?').get(childQuery.queryId)).toEqual({input_id:null});
    expect(repos.readWorkspace()).toEqual(workspace);
    expect(() => queries.read(prior.current.id,{...context,scope:{...context.scope,deviceIds:[1]}})).toThrow('access_denied');
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test('p13 schema11 migration preserves original data and rejects partial upgrade at each commit boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p13-migration-')), path = join(root, 'app.sqlite');
  let db = new Database(path, { strict: true });
  try {
    const directory = new URL('../../packages/storage/src/migrations/', import.meta.url);
    db.exec('PRAGMA foreign_keys=OFF');
    for (const [index, name] of readdirSync(directory).filter(n => /^0(?:0[1-9]|1[01])_/.test(n)).sort().entries()) {
      db.exec('PRAGMA foreign_keys=OFF');
      const sql = readFileSync(new URL(name, directory)); db.exec(sql.toString());
      db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(index + 1, createHash('sha256').update(sql).digest('hex'), contextAt);
    }
    db.exec('PRAGMA foreign_keys=ON');
    const native = memoryNativeFixture(root), initialHistory = { header: native.header, entries: [], activeLeafId: null };
    const f = acceptContextInput(db, { nativeSessionId: native.header.id, initialHistory });
    sqliteHistory(db).commitSync({ sessionId: f.input.sessionId, runId: null, expectedStorageVersion: 1, header: native.header, newEntries: native.entries, activeLeafId: native.activeLeafId });
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    const before = new Map(tables.map(name => [name, db.query<Record<string, unknown>, []>(`SELECT * FROM ${name} ORDER BY id`).all()]));
    const schema = db.query('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
    db.close();
    for (const failAt of ['p13_copy', 'p13_rename', 'p13_marker']) {
      expect(() => { const opened = openDatabase(path, phase => { if (phase === failAt) throw new Error('ENGINEERING migration failure'); }); opened.close(); }).toThrow('storage_migration_failed');
      db = new Database(path, { strict: true });
      expect(db.query('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()).toEqual(schema);
      for (const name of tables) expect(db.query(`SELECT * FROM ${name} ORDER BY id`).all()).toEqual(before.get(name)!);
      db.close();
    }
    db = openDatabase(path);
    expect(SCHEMA_VERSION).toBe(12);
    expect(db.query('SELECT version FROM schema_migrations').all()).toHaveLength(12);
    for (const name of tables.filter(n => n !== 'schema_migrations')) {
      const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM ${name} ORDER BY id`).all();
      expect(rows.map((row, i) => Object.fromEntries(Object.keys(before.get(name)![i]!).map(key => [key, row[key]])))).toEqual(before.get(name)!);
    }
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(new Repositories(db).readInput({ inputId: f.input.inputId })).toMatchObject({ status: 'consumed' });
    expect(() => db.query('UPDATE sessions SET creation_result_json=NULL WHERE id=?').run(f.input.sessionId)).toThrow();
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('p13 child DDL binds an original parent Agent call, freezes identity and isolates user reads and root occupation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p13-identity-')), path = join(root, 'app.sqlite'), db = openDatabase(path);
  try {
    const f = acceptContextInput(db, { toolNames: ['read'] });
    const contexts = new SqliteContextStore(db), snapshot = contexts.save(contexts.select(f.input));
    f.repos.startCall(f.input.runId, 'parent-call', 'main', contextAt, { inputId: f.input.inputId, snapshotId: snapshot.id });
    const tools = new SqliteToolStore(db), controller = new AbortController();
    const context = { runId: f.input.runId, sessionId: f.input.sessionId, scope: f.input.scope, referenceDate: f.request.referenceDate, timezone: f.request.timezone, workspaceContext: f.input.workspaceContext, nativeToolCallId: 'parent-Agent', modelCallId: 'parent-call', contextSnapshotId: snapshot.id, signal: controller.signal, workspaceInputId: f.input.inputId, basedOnQueryId: null, workspaceRevision: f.input.workspaceContext.revision };
    const origin = tools.request({ name: 'Agent', version: 'fixture', effect: 'READ', executionMode: 'sequential' }, p13AgentInput, context);
    const native = memoryNativeFixture(root);
    const created = db.query("INSERT INTO sessions(native_session_id,kind,creation_operation_ref,creation_request_json,creation_result_json,title,storage_version,native_header_json,history_format_version,created_at,updated_at) VALUES(?,'child',?,?,NULL,'ENGINEERING child',1,?,'pi-session/3;pi-sdk/0.87.1',?,?)")
      .run(native.header.id, `internal-child:${origin.id}`, JSON.stringify({ contract: 'medclaw.child-creation/v1', parentRunId: f.input.runId, originToolCallId: origin.id, pluginAgentId: 'plugin-child' }), JSON.stringify(native.header), contextAt, contextAt);
    const childSessionId = Number(created.lastInsertRowid), childRunId = f.input.runId + 1;
    const frozen = frozenFixture(f, origin, snapshot.id, native, childRunId, childSessionId);
    expect(() => FrozenChildConfigSchema.parse({ ...frozen, scope: { ...frozen.scope, allowedToolNames: ['read', 'Agent'] } })).toThrow();
    const insert = (changes: Partial<typeof frozen> = {}) => {
      const current = { ...frozen, ...changes };
      return db.query("INSERT INTO runs(id,session_id,kind,parent_run_id,origin_tool_call_id,instance_id,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at) VALUES(?,?,'child',?,?,?,'created','answer',?,?,?,NULL,?,?,?)")
        .run(current.childRunId, current.childSessionId, current.parentRunId, current.originToolCallId, current.instanceId, p13AgentInput.prompt, JSON.stringify({ selection: current.model, policy: current.policy, subagent: current }), JSON.stringify(current.scope), f.run.referenceDate, f.run.timezone, contextAt);
    };
    for (const changes of [{ parentSessionId: 999 }, { originNativeToolCallId: 'another-native-call' }, { originSnapshotId: 999 }, { parentRunId: 999 }, { childSessionId: f.input.sessionId }, { instanceId: 'another-host' }, { pluginAgentId: 'another-plugin-id' }, { originToolCallId: 999 }, { nativeSessionId: 'another-native-id' }]) expect(() => insert(changes)).toThrow();
    insert();
    const history = sqliteHistory(db);
    const loaded = await history.store.load(childSessionId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw loaded.error;
    expect(loaded.data).toMatchObject({ sessionId: childSessionId, nativeSessionId: native.header.id, entries: [], storageVersion: 1 });
    expect(() => history.commitSync({ sessionId: childSessionId, runId: f.input.runId, expectedStorageVersion: 1, header: native.header, newEntries: native.entries, activeLeafId: native.activeLeafId })).toThrow();
    const saved = history.commitSync({ sessionId: childSessionId, runId: childRunId, expectedStorageVersion: 1, header: native.header, newEntries: native.entries, activeLeafId: native.activeLeafId });
    expect(saved.storageVersion).toBe(2);
    expect(await history.store.load(childSessionId)).toMatchObject({ ok: true, data: { entries: JSON.parse(JSON.stringify(native.entries)), activeLeafId: native.activeLeafId, storageVersion: 2 } });
    expect(() => history.commitSync({ sessionId: childSessionId, runId: null, expectedStorageVersion: 2, header: native.header, newEntries: [], activeLeafId: null })).toThrow();
    expect(() => db.query("INSERT INTO runs(session_id,input_id,kind,instance_id,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at) SELECT session_id,input_id,kind,instance_id,'created',goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at FROM runs WHERE id=?").run(f.input.runId)).toThrow();
    expect(f.repos.readChildIdentity(childRunId)).toMatchObject({ childRunId, childSessionId, parentRunId: f.input.runId, originToolCallId: origin.id });
    expect(f.repos.active()).toMatchObject({ runId: f.input.runId, kind: 'agent' });
    expect(f.repos.listSessions({}).sessions.map(s => s.id)).toEqual([f.input.sessionId]);
    expect(f.repos.readSession(childSessionId)).toBeNull();
    const recent = f.repos.read({ recent: true });
    expect(recent.kind === 'recent' && recent.runs.map(r => r.id)).toEqual([f.input.runId]);
    const children = f.repos.read({ recent: true, parentRunId: f.input.runId });
    expect(children.kind === 'recent' && children.runs).toMatchObject([{ id: childRunId, kind: 'child', parentRunId: f.input.runId, childResult: null, inputId: null, answerRef: null }]);
    expect(() => f.repos.selectSession({ sessionId: childSessionId, expectedWorkspaceRevision: f.repos.readWorkspace().revision }, contextAt)).toThrow('session_not_found');
    expect(() => insert({ childRunId: childRunId + 1 })).toThrow();
    for (const sql of ["UPDATE runs SET parent_run_id=999", "UPDATE runs SET origin_tool_call_id=999", "UPDATE runs SET instance_id='changed'", "UPDATE runs SET config_json=json_set(config_json,'$.subagent.pluginAgentId','changed')", "UPDATE runs SET status='completed'"]) expect(() => db.query(sql + ' WHERE id=?').run(childRunId)).toThrow();
    expect(() => db.query("UPDATE sessions SET native_session_id='changed' WHERE id=?").run(childSessionId)).toThrow();
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.query('SELECT id FROM answers').all()).toEqual([]);
    const nextContext = { ...context, nativeToolCallId: 'parent-Agent-2' };
    const nextOrigin = tools.request({ name: 'Agent', version: 'fixture', effect: 'READ', executionMode: 'sequential' }, p13AgentInput, nextContext);
    const nextNative = memoryNativeFixture(root);
    const nextSession = Number(db.query("INSERT INTO sessions(native_session_id,kind,creation_operation_ref,creation_request_json,creation_result_json,title,storage_version,native_header_json,history_format_version,created_at,updated_at) VALUES(?,'child',?,?,NULL,'ENGINEERING second child',1,?,'pi-session/3;pi-sdk/0.87.1',?,?)")
      .run(nextNative.header.id, `internal-child:${nextOrigin.id}`, JSON.stringify({ contract: 'medclaw.child-creation/v1', parentRunId: f.input.runId, originToolCallId: nextOrigin.id, pluginAgentId: 'plugin-child-2' }), JSON.stringify(nextNative.header), contextAt, contextAt).lastInsertRowid);
    const next = { childRunId: childRunId + 1, childSessionId: nextSession, nativeSessionId: nextNative.header.id, originToolCallId: nextOrigin.id, originNativeToolCallId: nextOrigin.nativeToolCallId, pluginAgentId: 'plugin-child-2' };
    expect(() => insert(next)).toThrow('UNIQUE constraint failed');
    db.query("UPDATE runs SET status='failed' WHERE id=?").run(childRunId);
    const wrongOrigin = tools.request({ name: 'read', version: 'fixture', effect: 'READ', executionMode: 'sequential' }, { path: 'fixture' }, { ...context, nativeToolCallId: 'parent-read' });
    const wrongNative = memoryNativeFixture(root);
    const wrongSession = Number(db.query("INSERT INTO sessions(native_session_id,kind,creation_operation_ref,creation_request_json,creation_result_json,title,storage_version,native_header_json,history_format_version,created_at,updated_at) VALUES(?,'child',?,?,NULL,'ENGINEERING invalid origin',1,?,'pi-session/3;pi-sdk/0.87.1',?,?)")
      .run(wrongNative.header.id, `internal-child:${wrongOrigin.id}`, JSON.stringify({ contract: 'medclaw.child-creation/v1', parentRunId: f.input.runId, originToolCallId: wrongOrigin.id, pluginAgentId: 'invalid-plugin' }), JSON.stringify(wrongNative.header), contextAt, contextAt).lastInsertRowid);
    expect(() => insert({ childRunId: childRunId + 1, childSessionId: wrongSession, originToolCallId: wrongOrigin.id, originNativeToolCallId: wrongOrigin.nativeToolCallId, pluginAgentId: 'invalid-plugin', nativeSessionId: wrongNative.header.id })).toThrow('child_owner_mismatch');
    insert(next);
    expect(f.repos.active()).toMatchObject({ runId: f.input.runId, kind: 'agent' });
    const updated = f.repos.read({ recent: true, parentRunId: f.input.runId });
    expect(updated.kind === 'recent' && updated.runs.map(r => r.id)).toEqual([next.childRunId, childRunId]);
    db.query("UPDATE runs SET status='failed' WHERE id=?").run(next.childRunId);
    const thirdOrigin = tools.request({ name: 'Agent', version: 'fixture', effect: 'READ', executionMode: 'sequential' }, p13AgentInput, { ...context, nativeToolCallId: 'parent-Agent-3' });
    const thirdNative = memoryNativeFixture(root);
    const initialEntries = thirdNative.entries.slice(0, 2), initialLeaf = initialEntries.at(-1)!.id;
    const { childRunId: _run, childSessionId: _session, ...configuration } = frozen;
    const registration = { parentRunId: f.input.runId, originToolCallId: thirdOrigin.id, pluginAgentId: 'plugin-child-3', nativeSessionId: thirdNative.header.id,
      prompt: p13AgentInput.prompt, initialHistory: { header: thirdNative.header, entries: initialEntries, activeLeafId: initialLeaf }, createdAt: contextAt,
      frozen: { ...configuration, pluginAgentId: 'plugin-child-3', nativeSessionId: thirdNative.header.id, originToolCallId: thirdOrigin.id, originNativeToolCallId: thirdOrigin.nativeToolCallId,
        promptHash: createHash('sha256').update(p13AgentInput.prompt).digest('hex') } };
    const counts = () => ['sessions', 'runs', 'memories', 'runtime_events'].map(table => db.query(`SELECT COUNT(*) n FROM ${table}`).get());
    const beforeRegistration = counts();
    const childRepos = new Repositories(db, undefined, undefined, undefined, history.store);
    expect(() => childRepos.registerChild({ ...registration, frozen: { ...registration.frozen, parentInputId: null } })).toThrow('access_denied');
    const failingRepos = new Repositories(db, () => { throw new Error('ENGINEERING registration failure'); }, undefined, undefined, history.store);
    expect(() => failingRepos.registerChild(registration)).toThrow('ENGINEERING registration failure');
    expect(counts()).toEqual(beforeRegistration);
    const identity = childRepos.registerChild(registration);
    expect(identity).toMatchObject({ parentRunId: f.input.runId, originToolCallId: thirdOrigin.id, pluginAgentId: 'plugin-child-3', nativeSessionId: thirdNative.header.id });
    expect(identity.childRunId).not.toBe(next.childRunId);
    expect(await history.store.load(identity.childSessionId)).toMatchObject({ ok: true, data: { entries: initialEntries, activeLeafId: initialLeaf, storageVersion: 1 } });
    expect(() => childRepos.registerChild(registration)).toThrow('state_conflict');
    expect(db.query('SELECT id FROM session_inputs WHERE session_id=?').all(identity.childSessionId)).toEqual([]);
    expect(db.query('SELECT id FROM answers').all()).toEqual([]);
    expect(db.query('SELECT type,sequence FROM runtime_events WHERE run_id=? ORDER BY sequence').all(identity.childRunId)).toEqual([{ type: 'run_created', sequence: 1 }]);
    const delegationSource = { parentRunId: f.input.runId, originToolCallId: thirdOrigin.id, parentSnapshotId: snapshot.id, parentInputId: f.input.inputId,
      promptHash: registration.frozen.promptHash, nativeEntryId: 'child-prompt' };
    const promptEntry = { id: delegationSource.nativeEntryId, type: 'message', parentId: initialLeaf, timestamp: contextAt,
      message: { role: 'user', content: p13AgentInput.prompt, timestamp: Date.parse(contextAt) } };
    history.commitSync({ sessionId: identity.childSessionId, runId: identity.childRunId, expectedStorageVersion: 1, header: thirdNative.header, newEntries: [promptEntry], activeLeafId: promptEntry.id });
    const childInput = { runId: identity.childRunId, sessionId: identity.childSessionId, inputId: null, delegationSource, scope: registration.frozen.scope,
      runtimeFeedback: 'ENGINEERING child budget', nativeRefs: [], createdAt: contextAt };
    expect(() => contexts.selectChild({ ...childInput, delegationSource: { ...delegationSource, parentSnapshotId: snapshot.id + 1 } })).toThrow('access_denied');
    const childSnapshot = contexts.save(contexts.selectChild(childInput));
    expect(childSnapshot).toMatchObject({ runId: identity.childRunId, sessionId: identity.childSessionId, inputId: null, workspaceContext: null, delegationSource });
    expect(childSnapshot.selectedRefs.some(ref => ref.kind === 'input')).toBe(false);
    childRepos.startCall(identity.childRunId, 'child-model-1', 'main', contextAt, { inputId: null, snapshotId: childSnapshot.id, delegationSource });
    childRepos.startCall(identity.childRunId, 'child-model-2', 'main', contextAt, { inputId: null, snapshotId: childSnapshot.id, delegationSource });
    expect(db.query('SELECT session_id,input_id FROM model_calls WHERE run_id=?').all(identity.childRunId)).toEqual([
      { session_id: identity.childSessionId, input_id: null }, { session_id: identity.childSessionId, input_id: null }]);
    const childDelivery = contexts.recordDelivery({ runId: identity.childRunId, sessionId: identity.childSessionId, callId: 'child-model-1', inputId: null, snapshotId: childSnapshot.id, delegationSource,
      observation: { contract: 'medclaw.context-observation/v1', api: 'openai-completions', transport: 'sse', httpStatus: 200, observedAt: contextAt,
        projectionHash: childSnapshot.projectionHash, feedbackHash: childSnapshot.feedbackHash, verifiedNativeRefs: [] } });
    expect(contexts.read({ callId: 'child-model-1' })).toMatchObject({ kind: 'snapshot', snapshot: { inputId: null, delegationSource }, evidence: 'saved', deliveries: [childDelivery] });
    const childContext = { runId: identity.childRunId, sessionId: identity.childSessionId, nativeToolCallId: 'parent-Agent', scope: registration.frozen.scope,
      referenceDate: f.request.referenceDate, timezone: f.request.timezone, signal: controller.signal, contextSnapshotId: childSnapshot.id, modelCallId: 'child-model-1',
      workspaceContext: null, workspaceInputId: null, basedOnQueryId: null, delegationSource };
    const childTool = tools.request({ name: 'read', version: 'fixture', effect: 'READ', executionMode: 'sequential' }, { path: 'fixture' }, childContext);
    expect(childTool).toMatchObject({ runId: identity.childRunId, sessionId: identity.childSessionId, nativeToolCallId: 'parent-Agent', contextSnapshotId: childSnapshot.id });
    expect(() => tools.assertContext({ ...childContext, scope: { ...childContext.scope, batchIds: [999] } })).toThrow('access_denied');
    expect(() => tools.assertContext({ ...childContext, delegationSource: { ...delegationSource, originToolCallId: nextOrigin.id } })).toThrow('access_denied');
    expect(() => tools.assertContext({ ...childContext, workspaceContext: f.input.workspaceContext })).toThrow();
    expect(childRepos.verifyPriorContextFacts(identity.childRunId)).toMatchObject({ requiredPersistenceComplete: false, unconfirmedItems: expect.arrayContaining(['context_observation_unknown']) });
    const compactionOwner = { source: 'auto' as const, reason: 'threshold' as const, runId: identity.childRunId, sessionId: identity.childSessionId,
      operationRef: 'child-compaction', ordinal: 1, model: frozen.model, baseStorageVersion: 2, baseLeafId: promptEntry.id };
    childRepos.startCompactionCall({ owner: compactionOwner, callId: 'child-compaction-model', startedAt: contextAt });
    expect(db.query('SELECT session_id,input_id,kind FROM model_calls WHERE call_id=?').get('child-compaction-model')).toEqual({ session_id: identity.childSessionId, input_id: null, kind: 'compaction' });
    expect(() => childRepos.startCompactionCall({ owner: { ...compactionOwner, source: 'manual', reason: 'manual', runId: null }, callId: 'child-manual-compaction', startedAt: contextAt })).toThrow();
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('p13 exact plugin exposes an awaited managed factory without running its ambient default', async () => {
  expect(typeof await loadP13Managed()).toBe('function');
  await withP13Plugin(async (parent, trace) => {
    expect(parent.getActiveToolNames()).toEqual(['Agent']);
    expect(parent.getAllTools().map(tool => tool.name)).toEqual(['Agent']);
    await parent.prompt('ENGINEERING no delegation');
    expect(trace.parentRequests).toBe(1);
    expect(trace.ids).toEqual([]);
    expect(trace.children).toEqual([]);
    expect(trace.childRequests).toBe(0);
    expect(existsSync(join(trace.root, 'agent'))).toBe(false);
  }, { delegate: false });
});

test('p13 real parent Agent call awaits binding before child SDK request and returns original reply', async () => {
  const entered = Promise.withResolvers<void>(), bound = Promise.withResolvers<void>();
  await withP13Plugin(async (parent, trace) => {
    const execution = parent.prompt('ENGINEERING delegate');
    try {
      await entered.promise;
      expect(trace.children).toHaveLength(1);
      expect(trace.childRequests).toBe(0);
      expect(trace.children[0]!.sessionManager.getSessionId()).not.toBe(parent.sessionManager.getSessionId());
    } finally { bound.resolve(); }
    await execution;
    const record = await trace.extension.control.waitForSettled(trace.ids[0]!);
    expect(record.status).toBe('completed');
    expect(record.session).toBe(trace.children[0]);
    expect(record.result).toBe('ENGINEERING_CHILD_RESULT');
    expect(trace.childRequests).toBe(1);
    expect(trace.parentRequests).toBe(2);
    const reply = parent.messages.find(message => message.role === 'toolResult');
    expect(reply).toMatchObject({ role: 'toolResult', toolCallId: 'parent_1', toolName: 'Agent', isError: false });
    expect(JSON.stringify(reply)).toContain('ENGINEERING_CHILD_RESULT');
    expect(record.session!.sessionManager.getSessionFile()).toBeUndefined();
    await trace.extension.control.release(record.id);
  }, { beforeReturn: async () => { entered.resolve(); await bound.promise; } });
});

test('p13 next real delegation is refused until child release and then creates fresh plugin and SDK identities', async () => {
  await withP13Plugin(async (parent, trace) => {
    await parent.prompt('ENGINEERING first delegation');
    const firstId = trace.ids[0]!, first = await trace.extension.control.waitForSettled(firstId);
    await parent.prompt('ENGINEERING cannot reuse an unreleased child');
    expect(trace.children).toHaveLength(1);
    const rejected = parent.messages.filter(message => message.role === 'toolResult').at(-1);
    expect(rejected).toMatchObject({ isError: true });
    await trace.extension.control.release(firstId);
    await parent.prompt('ENGINEERING fresh delegation');
    expect(trace.children).toHaveLength(2);
    const second = await trace.extension.control.waitForSettled(trace.ids[1]!);
    expect(second.id).not.toBe(first.id);
    expect(second.session!.sessionManager.getSessionId()).not.toBe(first.session!.sessionManager.getSessionId());
    expect(trace.childRequests).toBe(2);
    await trace.extension.control.release(second.id);
  });
});

test('p13 cancellation does not treat plugin stopped as settled while the real factory is still pending', async () => {
  const entered = Promise.withResolvers<void>(), bound = Promise.withResolvers<void>();
  await withP13Plugin(async (parent, trace) => {
    const execution = parent.prompt('ENGINEERING cancellation');
    let settled = false;
    try {
      await entered.promise;
      trace.extension.control.cancel(trace.ids[0]!);
      const proof = trace.extension.control.waitForSettled(trace.ids[0]!).then(record => { settled = true; return record; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(trace.childRequests).toBe(0);
      bound.resolve();
      expect((await proof).status).toBe('stopped');
      await execution;
      expect(trace.childRequests).toBe(0);
      await trace.extension.control.release(trace.ids[0]!);
    } finally { bound.resolve(); await execution; }
  }, { beforeReturn: async () => { entered.resolve(); await bound.promise; } });
});

test('p13 child shutdown must finish before release allows a second real Agent call', async () => {
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  await withP13Plugin(async (parent, trace) => {
    await parent.prompt('ENGINEERING first');
    const release = trace.extension.control.release(trace.ids[0]!);
    try {
      await entered.promise;
      await parent.prompt('ENGINEERING release still pending');
      expect(trace.children).toHaveLength(1);
      expect(parent.messages.filter(message => message.role === 'toolResult').at(-1)).toMatchObject({ isError: true });
    } finally { released.resolve(); await release; }
    await parent.prompt('ENGINEERING release confirmed');
    expect(trace.children).toHaveLength(2);
    await trace.extension.control.release(trace.ids[1]!);
  }, { childFactory: pi => { pi.on('session_shutdown', async () => { entered.resolve(); await released.promise; }); } });
});

test('p13 raw Agent input cannot enable background, model, cwd, recursion or user tool configuration', async () => {
  const overrides: Record<string, string | boolean | string[]>[] = [{ run_in_background: true }, { model: 'untrusted' }, { cwd: 'untrusted' }, { schedule: 'later' }, { subagent_type: 'Explore' }, { sub_tools: ['write'] }];
  for (const override of overrides) {
    await withP13Plugin(async (parent, trace) => {
      await parent.prompt('ENGINEERING reject override');
      expect(trace.children).toEqual([]);
      expect(trace.childRequests).toBe(0);
      expect(parent.messages.find(message => message.role === 'toolResult')).toMatchObject({ isError: true });
    }, { arguments: { ...p13AgentInput, ...override } });
  }
});

test('p13 a terminal child awaiting product save is not evicted by the upstream timed cleanup', async () => {
  const set = globalThis.setInterval, clear = globalThis.clearInterval;
  const timers = new Map<ReturnType<typeof setInterval>, () => void>();
  globalThis.setInterval = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const timer = set(callback, delay, ...args);
    if (delay === 60000) timers.set(timer, () => callback(...args));
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => { timers.delete(timer); clear(timer); }) as typeof clearInterval;
  try {
    await withP13Plugin(async (parent, trace) => {
      await parent.prompt('ENGINEERING retained pending save');
      const first = await trace.extension.control.waitForSettled(trace.ids[0]!);
      first.completedAt = Date.now() - 11 * 60 * 1000;
      for (const callback of [...timers.values()]) callback();
      expect((await trace.extension.control.waitForSettled(first.id)).session).toBe(first.session);
      await trace.extension.control.release(first.id);
    });
  } finally { globalThis.setInterval = set; globalThis.clearInterval = clear; }
});
