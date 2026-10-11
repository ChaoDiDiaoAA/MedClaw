import { expect, test, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, SCHEMA_VERSION } from '../../packages/storage/src/database';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { memoryAt, memoryNativeFixture } from '../fixtures/p9-memory';

async function memoryStoreFixture() {
  const root=mkdtempSync(join(tmpdir(),'medclaw-p9-store-')),db=openDatabase(join(root,'app.sqlite')),native=memoryNativeFixture();
  const {Repositories}=await import('../../packages/storage/src/repositories'); const repos=new Repositories(db);
  repos.createSession({expectedWorkspaceRevision:0},'create-memory',native.header.id,memoryAt);
  db.query('UPDATE sessions SET native_header_json=?,history_format_version=?,storage_version=1 WHERE id=1').run(JSON.stringify(native.header),'pi-session/3;pi-sdk/0.87.1');
  const {SqliteMemoryStore}=await import('../../packages/storage/src/memory-store'); const {validateNativeHistory}=await import('../../packages/runtime-pi/src/memory-store');
  const store=new SqliteMemoryStore(db,validateNativeHistory);
  const change={sessionId:1,runId:null,expectedStorageVersion:1,header:native.header,newEntries:native.entries,activeLeafId:native.activeLeafId};
  return {root,db,native,store,change,dispose(){db.close();rmSync(root,{recursive:true,force:true});}};
}

test('p9 MemoryStore commits all entries and exact leaf, idempotent retransmission preserves original rows and version',async()=>{
  const f=await memoryStoreFixture();try{
    expect(await f.store.commit(f.change)).toEqual({ok:true,data:{storageVersion:2}});
    const before=f.db.query('SELECT * FROM memories ORDER BY sequence').all();
    expect(await f.store.commit({...f.change,expectedStorageVersion:2})).toEqual({ok:true,data:{storageVersion:2}});
    expect(f.db.query('SELECT * FROM memories ORDER BY sequence').all()).toEqual(before);
    expect(await f.store.load(1)).toEqual({ok:true,data:{sessionId:1,nativeSessionId:f.native.header.id,header:f.native.header,entries:f.native.entries,activeLeafId:f.native.activeLeafId,storageVersion:2}});
    expect(await f.store.listEntries(1,2,2)).toEqual({ok:true,data:f.native.entries.slice(2,4)});
    expect(await f.store.listEntries(1,0,101)).toMatchObject({ok:false,error:{code:'invalid_argument'}});
    expect(await f.store.commit(f.change)).toMatchObject({ok:false,error:{code:'state_conflict',reason:'history_version_mismatch'}});
    expect(await f.store.commit({...f.change,expectedStorageVersion:2,activeLeafId:null,newEntries:[]})).toEqual({ok:true,data:{storageVersion:3}});
    expect((await f.store.load(1))).toMatchObject({ok:true,data:{activeLeafId:null,storageVersion:3,entries:JSON.parse(JSON.stringify(f.native.entries))}});
  }finally{f.dispose();}
});

test('p9 MemoryStore rejects same identity changed content, corrupt chains and deleted-session writes without any partial history',async()=>{
  const f=await memoryStoreFixture();try{
    expect(await f.store.commit(f.change)).toMatchObject({ok:true});const before=f.db.query('SELECT * FROM memories').all();
    const conflicting=structuredClone(f.native.entries[0]!);Reflect.set(conflicting,'provider','foreign');
    for(const change of [
      {...f.change,expectedStorageVersion:2,newEntries:[conflicting]},
      {...f.change,expectedStorageVersion:2,newEntries:[{...f.native.entries[0]!,id:'new',parentId:'foreign'}]},
      {...f.change,expectedStorageVersion:2,newEntries:[],activeLeafId:'missing'},
      {...f.change,expectedStorageVersion:2,runId:999},
    ]) expect(await f.store.commit(change)).toMatchObject({ok:false});
    expect(f.db.query('SELECT * FROM memories').all()).toEqual(before);expect(f.db.query('SELECT storage_version FROM sessions').get()).toEqual({storage_version:2});
    f.db.query("UPDATE sessions SET status='deleted',deleted_at=?").run(memoryAt);
    expect(await f.store.load(1)).toMatchObject({ok:true}); expect(await f.store.commit({...f.change,expectedStorageVersion:2})).toMatchObject({ok:false,error:{code:'state_conflict',reason:'session_deleted'}});
  }finally{f.dispose();}
});

test('p9 MemoryStore shares the outer transaction: history, version and events all roll back on failure',async()=>{
  const f=await memoryStoreFixture();try{
    const {SqliteWriteTransactions}=await import('../../packages/storage/src/write-transactions'); const tx=SqliteWriteTransactions.forDatabase(f.db);
    expect(()=>f.store.commitInTransaction(f.change)).toThrow();
    expect(()=>tx.immediate(()=>{f.store.commitInTransaction(f.change);throw new Error('ENGINEERING rollback');})).toThrow('ENGINEERING rollback');
    expect(f.db.query('SELECT * FROM memories').all()).toEqual([]);expect(f.db.query('SELECT storage_version FROM sessions').get()).toEqual({storage_version:1});
    expect(await f.store.commit(f.change)).toMatchObject({ok:true});
    f.db.query('DELETE FROM memories WHERE native_entry_id=?').run(f.native.entries.at(-2)!.id);
    expect(await f.store.load(1)).toMatchObject({ok:false,error:{code:'session_history_invalid'}});
  }finally{f.dispose();}
});

test('p9 new Session saves its authentic header and version1 in the creation/Workspace receipt transaction',async()=>{
  const root=mkdtempSync(join(tmpdir(),'medclaw-p9-create-')),db=openDatabase(join(root,'app.sqlite'));
  try {
    const {Repositories}=await import('../../packages/storage/src/repositories'),native=memoryNativeFixture(),initial={header:native.header,entries:[],activeLeafId:null};
    const repos=new Repositories(db),created=repos.createSession({expectedWorkspaceRevision:0},'create',native.header.id,memoryAt,initial);
    expect(created.session).toMatchObject({storageVersion:1,leafId:null,nativeSessionId:native.header.id});
    expect(JSON.parse(String(db.query<{native_header_json:string},[]>('SELECT native_header_json FROM sessions').get()!.native_header_json))).toEqual(native.header);
    expect(repos.createSession({expectedWorkspaceRevision:0},'create','ignored-native',memoryAt,initial)).toEqual(created);
    repos.updateWorkspace({activeView:'changes'},created.workspace.revision,memoryAt);
    expect(repos.findOperation('create')).toMatchObject({result:created});
    const fault=new Repositories(db,()=>{throw new Error('ENGINEERING creation rollback');});
    const second=memoryNativeFixture();const workspace=repos.readWorkspace();
    expect(()=>fault.createSession({expectedWorkspaceRevision:workspace.revision},'failed-create',second.header.id,memoryAt,{header:second.header,entries:[],activeLeafId:null})).toThrow('ENGINEERING creation rollback');
    expect(db.query('SELECT id FROM sessions').all()).toHaveLength(1);expect(repos.readWorkspace()).toEqual(workspace);expect(repos.findOperation('failed-create')).toBeNull();
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('p9 history events preserve original versions through later branches; publication loss cannot erase committed facts',async()=>{
  const f=await memoryStoreFixture();try{
    const {acceptContextInput}=await import('../fixtures/p8-context');const {input}=acceptContextInput(f.db);
    const {SqliteEventStore}=await import('../../packages/storage/src/event-store'),events=new SqliteEventStore(f.db);
    const change={...f.change,runId:input.runId};expect(await f.store.commit(change)).toEqual({ok:true,data:{storageVersion:2}});
    expect(await f.store.commit({...change,expectedStorageVersion:2,newEntries:[],activeLeafId:null})).toEqual({ok:true,data:{storageVersion:3}});
    const range=events.range(input.runId),saved=events.readWindow({runId:input.runId,afterSequence:0,throughSequence:range.lastSequence,limit:100}).filter(e=>e.type==='history_saved');
    expect(saved.map(e=>e.payload)).toEqual([{contract:'medclaw.event/v1',storageVersion:2,nativeLeafId:f.native.activeLeafId},{contract:'medclaw.event/v1',storageVersion:3,nativeLeafId:null}]);
    expect(f.db.query('SELECT DISTINCT run_id FROM memories').all()).toEqual([{run_id:input.runId}]);
    const {SqliteWriteTransactions}=await import('../../packages/storage/src/write-transactions'),tx=SqliteWriteTransactions.forDatabase(f.db);
    tx.immediate(()=>{f.store.commitInTransaction({...change,expectedStorageVersion:3,newEntries:[],activeLeafId:f.native.answerId});tx.afterCommit(()=>{throw new Error('ENGINEERING lost notification');});});
    expect(await f.store.load(1)).toMatchObject({ok:true,data:{storageVersion:4,activeLeafId:f.native.answerId}});
    expect(events.readWindow({runId:input.runId,afterSequence:range.lastSequence,throughSequence:events.range(input.runId).lastSequence,limit:100})).toHaveLength(1);
    expect(()=>tx.immediate(()=>events.appendInTransaction({runId:input.runId,sessionId:1,type:'history_saved',source:'pi',sourceConnection:null,sourceSequence:null,toolCallId:null,
      payload:{contract:'medclaw.event/v1',storageVersion:5,nativeLeafId:'not-committed'},occurredAt:memoryAt,receivedAt:memoryAt}))).toThrow();
  }finally{f.dispose();}
});

test('p9 saved message Run links come from SQLite after losing all native ownership maps, and reads have no writes',async()=>{
  const f=await memoryStoreFixture();try{
    const {acceptContextInput}=await import('../fixtures/p8-context');const {repos,input}=acceptContextInput(f.db);
    expect(await f.store.commit({...f.change,runId:input.runId})).toMatchObject({ok:true});
    const {projectSavedMessages}=await import('../../packages/runtime-pi/src/memory-store'),{SessionService}=await import('../../packages/core/src/session/session-service');
    const loaded=await f.store.load(1);if(!loaded.ok)throw loaded.error;
    const request={sessionId:1,leafId:null,afterEntryId:null,limit:50};
    const native={allocate:()=>{throw new Error('Must not allocate');},read:async()=>{throw new Error('Must not bind');},readMessages:async()=>projectSavedMessages(loaded.data,request,f.root),ensureLoaded:async()=>{throw new Error('Must not load');},restore:async()=>{throw new Error('Must not restore');},readAvailability:()=>({availability:'unloaded' as const,error:null})};
    const service=new SessionService('ENGINEERING',repos,native,async()=>{throw new Error('Must not execute');},()=>null);
    const before=f.db.query('SELECT total_changes() n').get(),page=await service.readMessages(request);expect(page.ok).toBe(true);
    if(page.ok)expect(page.data.items.filter(item=>['user','assistant'].includes(item.displayRole)).map(({nativeEntryId,runId,references})=>({nativeEntryId,runId,references})))
      .toEqual([f.native.userId,f.native.answerId].map(nativeEntryId=>({nativeEntryId,runId:input.runId,references:[`run:${input.runId}`]})));
    expect(f.db.query('SELECT total_changes() n').get()).toEqual(before);
  }finally{f.dispose();}
});

const legacyFiles = ['001_p1.sql','002_p2.sql','003_p3.sql','004_p5.sql','005_p6.sql','006_session_lifecycle.sql','007_batch_deletion.sql','008_p8.sql'];
function legacy() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p9-')), path = join(root, 'app.sqlite'), db = new Database(path, { strict: true });
  for (const [i, name] of legacyFiles.entries()) {
    db.exec('PRAGMA foreign_keys=OFF'); const sql = readFileSync(new URL(`../../packages/storage/src/migrations/${name}`, import.meta.url)); db.exec(sql.toString());
    db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(i + 1, createHash('sha256').update(sql).digest('hex'), memoryAt);
  }
  db.exec('PRAGMA foreign_keys=ON'); const { repos } = seedWorkspaceQueries(db);
  repos.createSession({expectedWorkspaceRevision:repos.readWorkspace().revision},'create-deleted','native-deleted',memoryAt);
  db.query("UPDATE sessions SET status='deleted',deleted_at=?,metadata_revision=7,metadata_json='{ \"titleOrigin\": \"user\", \"raw\": \"工程😀\" }' WHERE id=2").run(memoryAt);
  db.query(`INSERT INTO session_inputs(id,session_id,client_sequence,operation_ref,mode,status,content_json,target_run_id,run_id,created_at,delivered_at,processed_at,updated_at,processing_status,native_entry_id)
    VALUES(1,1,2,'input','send','consumed','{ "original": "工程😀" }',10,10,?,?,?,?,'completed','legacy-user')`).run(memoryAt,memoryAt,memoryAt,memoryAt);
  db.query(`INSERT INTO answers(run_id,session_id,kind,text,query_ids_json,missing_slots_json,created_at) VALUES(10,1,'result','工程旧回答😀','[ 1, 2 ]','[ ]',?)`).run(memoryAt);
  db.query(`INSERT INTO context_snapshots(run_id,session_id,input_id,sequence,snapshot_json,created_at) VALUES(10,1,1,1,'{ "contract": "medclaw.context/v1", "raw": "工程😀" }',?)`).run(memoryAt);
  const names = db.query<{name:string},[]>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const before = Object.fromEntries(names.map(name => [name, db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all()]));
  return { root, path, db, names, before };
}
function preserved(db: Database, f: ReturnType<typeof legacy>) {
  for (const name of f.names) {
    const expected = f.before[name]!;
    const after = db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all().slice(0, expected.length);
    expect(after.map((row,i) => Object.fromEntries(Object.keys(expected[i]!).map(key => [key,row[key]])))).toEqual(expected);
  }
}

test('p9 migration preserves schema8 active/deleted history, JSON bytes, receipts, inputs, query, answer, context and Workspace', () => {
  const f = legacy(); let db = f.db;
  try {
    db.close(); db = openDatabase(f.path); expect(SCHEMA_VERSION).toBe(15); preserved(db,f);
    expect(db.query('SELECT version FROM schema_migrations').all()).toHaveLength(15);
    expect(db.query('SELECT native_header_json,current_leaf_id,history_format_version,storage_version FROM sessions').all()).toEqual(Array(2).fill({native_header_json:null,current_leaf_id:null,history_format_version:null,storage_version:0}));
    expect(db.query('SELECT * FROM memories').all()).toEqual([]);
    expect(db.query('PRAGMA foreign_keys').get()).toEqual({foreign_keys:1}); expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
    for (const table of ['intent_calls','route_decisions','query_contexts']) expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
    for (const table of ['checkpoints','long_term_memories']) expect(db.query('SELECT name FROM sqlite_schema WHERE name=?').get(table)).toBeNull();
    db.close(); db = openDatabase(f.path); preserved(db,f);
  } finally { db.close(); rmSync(f.root,{recursive:true,force:true}); }
});

test('p9 migration failure at the last marker rolls back the schema8 tables and original bytes', () => {
  const f=legacy(); f.db.close();
  try {
    let unexpected:Database|undefined;
    try {expect(() => {unexpected=openDatabase(f.path,phase => {if(phase==='p9_memory_marker') throw new Error('ENGINEERING fault');});}).toThrow('storage_migration_failed');} finally {unexpected?.close();}
    const raw = new Database(f.path,{strict:true}); try { preserved(raw,f); expect(raw.query('SELECT version FROM schema_migrations').all()).toHaveLength(8); expect(raw.query("SELECT name FROM sqlite_schema WHERE name='memories'").get()).toBeNull(); } finally {raw.close();}
    const db = openDatabase(f.path); try {preserved(db,f); expect(db.query('PRAGMA foreign_keys').get()).toEqual({foreign_keys:1});} finally {db.close();}
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test('p9 actual SQLite COMMIT lock failure rolls back migration, restores FK and never returns ready', () => {
  const f = legacy(); f.db.close(); const reader = new Database(f.path); let writer: Database | null = null,restoredFK=false;
  const exec = Database.prototype.exec;
  const intercept = spyOn(Database.prototype,'exec').mockImplementation(function(this:Database,sql:string) {
    if(sql.includes('PRAGMA journal_mode=WAL')) { writer=this; return exec.call(this,'PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0;'); }
    const result=exec.call(this,sql);if(this===writer&&sql==='PRAGMA foreign_keys=ON')restoredFK=this.query<{foreign_keys:number},[]>('PRAGMA foreign_keys').get()?.foreign_keys===1;return result;
  });
  try {
    let reached=false;
    let unexpected:Database|undefined;
    try {expect(() => {unexpected=openDatabase(f.path,phase => {if(phase==='p9_memory_marker') { reached=true; reader.exec('BEGIN'); reader.query('SELECT * FROM sessions').all(); }});}).toThrow('storage_migration_failed');} finally {unexpected?.close();}
    expect(reached).toBe(true); expect(writer).not.toBeNull();expect(restoredFK).toBe(true);
    reader.exec('ROLLBACK'); preserved(reader,f); expect(reader.query('SELECT version FROM schema_migrations').all()).toHaveLength(8);
  } finally { intercept.mockRestore(); reader.close(); rmSync(f.root,{recursive:true,force:true}); }
});

test('p9 new schema enforces native identities, parent/leaf ownership, Run and Answer associations', () => {
  const root=mkdtempSync(join(tmpdir(),'medclaw-p9-fk-')), db=openDatabase(join(root,'app.sqlite'));
  try {
    expect(SCHEMA_VERSION).toBe(15); const native=memoryNativeFixture(); const header=JSON.stringify(native.header);
    db.query(`INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at,native_header_json,history_format_version,storage_version)
      VALUES(1,?,'create-a','{}','{}','ENGINEERING A',?, ?,?,'pi-session/3;pi-sdk/0.87.1',1)`).run(native.header.id,memoryAt,memoryAt,header);
    db.query(`INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at) VALUES(2,'b','create-b','{}','{}','ENGINEERING B',?,?)`).run(memoryAt,memoryAt);
    const entry={type:'session_info',id:'root-a',parentId:null,timestamp:memoryAt,name:'ENGINEERING'};
    const insert=(id:string,parent:string|null,seq=1,session=1,run:number|null=null) => db.query('INSERT INTO memories(session_id,native_entry_id,parent_entry_id,sequence,entry_type,entry_json,run_id,recorded_at) VALUES(?,?,?,?,?,?,?,?)').run(session,id,parent,seq,'session_info',JSON.stringify({...entry,id,parentId:parent}),run,memoryAt);
    insert('root-a',null); expect(() => insert('root-a',null,2)).toThrow(); expect(() => insert('other',null)).toThrow();
    expect(() => insert('child','missing',2)).toThrow(); expect(() => insert('foreign','root-a',1,2)).toThrow();
    expect(() => db.query('UPDATE sessions SET current_leaf_id=? WHERE id=?').run('root-a',2)).toThrow();
    expect(() => db.query('UPDATE sessions SET current_leaf_id=? WHERE id=1').run('missing')).toThrow();
    expect(() => insert('bad-run',null,2,1,999)).toThrow();
    for(const sessionId of [1,2]) db.query(`INSERT INTO runs(id,session_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at)
      VALUES(?,?,'agent','ENGINEERING',?,1,?,'failed','answer','ENGINEERING','{"agent":{"nativeSessionId":"ENGINEERING"}}','{}','{}','2026-10-05','Asia/Shanghai',?)`).run(sessionId,sessionId,`run-${sessionId}`,JSON.stringify({sessionId,clientSequence:1}),memoryAt);
    expect(()=>insert('foreign-run',null,2,1,2)).toThrow();
    for(const sessionId of [1,2]) db.query(`INSERT INTO session_inputs(id,session_id,client_sequence,operation_ref,mode,status,content_json,created_at,updated_at) VALUES(?,?,2,?,'send','queued','{}',?,?)`).run(sessionId,sessionId,`input-${sessionId}`,memoryAt,memoryAt);
    const answer=(run:number,session:number,input:number|null,leaf:string|null)=>db.query("INSERT INTO answers(run_id,session_id,input_id,kind,text,query_ids_json,native_leaf_id,created_at) VALUES(?,?,?,'result','ENGINEERING','[]',?,?)").run(run,session,input,leaf,memoryAt);
    expect(()=>answer(2,1,null,null)).toThrow();expect(()=>answer(1,1,2,'root-a')).toThrow();expect(()=>answer(2,2,2,'root-a')).toThrow();
    answer(1,1,1,'root-a');
    insert('reset-root',null,2); db.query('UPDATE sessions SET current_leaf_id=NULL WHERE id=1').run();
    expect(db.query('SELECT current_leaf_id FROM sessions WHERE id=1').get()).toEqual({current_leaf_id:null});
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});
