import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteCatalogStore } from '../../packages/storage/src/catalog-store';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { QueryService } from '../../packages/core/src/data/query-service';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { CurrentQuerySchema } from '../../packages/contracts/src/query';
import { DEFAULT_REQUEST_POLICY } from '../../packages/contracts/src/model';
import { toWorkspaceContext } from '../../packages/contracts/src/workspace';

const at = '2026-10-04T00:00:00.000Z', later = '2026-10-04T00:00:01.000Z';
const handles: Database[] = [], roots: string[] = [];
const hash1 = 'a'.repeat(64), hash2 = 'b'.repeat(64);
afterEach(() => { handles.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, {recursive:true, force:true})); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'p7-workspace-')); roots.push(root);
  const db = openDatabase(join(root, 'app.sqlite')); handles.push(db);
  const repos = new Repositories(db);
  repos.createSession({expectedWorkspaceRevision:0}, 'create-a', 'native-a', at);
  db.query(`INSERT INTO imports(id,operation_ref,instance_id,state,preview_request_hash,preview_request_json,created_at,updated_at)
    VALUES(1,'import','host','imported','hash','{}',?,?)`).run(at, at);
  for (const batch of [1, 2]) db.query(`INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,
    expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at)
    VALUES(?,1,'scope',?,'浙江','material/v1','bundle','lock',?,'full','cohort',2,2,'[]',?, ?,?,1,?)`)
    .run(batch, `2026-10-0${batch}`, batch === 1 ? hash1 : hash2, JSON.stringify({referenceDate:'2026-10-04',timezone:'Asia/Shanghai'}), batch === 1 ? 1 : 0, batch === 1 ? null : 1, at);
  for (const device of [1, 2]) {
    db.query(`INSERT INTO devices(id,source_device_id,source_bundle_id,source_submission_id,source_refs_json,created_at) VALUES(?,?,'bundle','submission','[]',?)`).run(device, `device-${device}`, at);
    for (const batch of [1, 2]) db.query(`INSERT INTO snapshots(id,batch_id,device_id,device_name,region,price_cents,currency,unit,status,source_row_ref,source_refs_json,field_origins_json)
      VALUES(?,?,?,'器械','浙江',100,'CNY','台','active',?,'[]','{}')`).run((batch-1)*2+device,batch,device,`${batch}:${device}`);
  }
  db.query(`INSERT INTO change_events(id,event_key,device_id,old_batch_id,new_batch_id,kind,field,old_value_json,new_value_json,delta_cents,ratio,calculation_version,created_at)
    VALUES(1,'change',1,1,2,'field_changed','price','100','80',-20,-0.2,'diff/v1',?)`).run(at);
  repos.updateWorkspace({batchIds:[1,2],deviceIds:[1]},1,at);
  const catalog = new SqliteCatalogStore(db), store = new SqliteToolStore(db);
  return {db,repos,catalog,store};
}
function savedQuery(f: ReturnType<typeof fixture>) {
  const scope=f.repos.freezeAgentScope(f.repos.readWorkspace(),[]);
  f.db.query(`INSERT INTO runs(id,session_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at)
    VALUES(10,1,'agent','host','query-submit',1,'{"sessionId":1,"clientSequence":1}','running','answer','query','{"agent":{"nativeSessionId":"native-a"}}',?,'{}','2026-10-04','Asia/Shanghai',?)`).run(JSON.stringify(scope),at);
  const queries=new QueryService(new CatalogService(f.catalog),f.store);
  const context={sessionId:1,runId:10,nativeToolCallId:'current',scope,referenceDate:'2026-10-04',timezone:'Asia/Shanghai',signal:new AbortController().signal};
  const page=queries.current(CurrentQuerySchema.parse({batchIds:[1,2],time:{start:'2026-10-02',endExclusive:'2026-10-03'}}),context);
  f.db.query("UPDATE runs SET status='completed',ended_at=? WHERE id=10").run(at);
  return {record:f.store.readQuery(page.queryId)!, evidenceId:page.evidenceIds[0]!};
}
const deviceSelection={formatVersion:1 as const,kind:'device' as const,targetId:'1',targetVersion:hash2,rowKey:'snapshot:3',field:'priceCents'};
function allWorkspace(f:ReturnType<typeof fixture>) {return f.db.query('SELECT * FROM workspace').get();}
function prepared(f: ReturnType<typeof fixture>, sequence = 1) {
  const workspace=f.repos.readWorkspace(),scope=f.repos.freezeAgentScope(workspace,[]);
  const model={provider:'p',modelId:'m',api:'openai-completions',endpointRef:null,credentialRef:null,configVersion:'1',maxOutputTokens:100,capabilitySource:'user_declared' as const,sdkVersion:'0.87.1' as const};
  const request={sessionId:workspace.sessionId!,clientSequence:sequence,text:'这一项',mode:'send' as const,expectedRevision:workspace.revision,expectedBatchIds:workspace.batchRefs.map(b=>b.id),expectedQueryId:workspace.queryId,model:{provider:'p',modelId:'m',expectedConfigVersion:'1'},referenceDate:'2026-10-04',timezone:'Asia/Shanghai'};
  return {operationRef:`send-${sequence}`,originalSubmitInput:request,createdAt:at,
    content:{contract:'medclaw.session-input/v1' as const,originalSubmitInput:request,text:request.text,workspaceContext:toWorkspaceContext(workspace),scope,model,referenceDate:request.referenceDate,timezone:request.timezone,deliveryAttempt:null},
    execution:{mode:'send' as const,run:{sessionId:workspace.sessionId!,goal:'answer' as const,text:request.text,model,policy:DEFAULT_REQUEST_POLICY,workspace,scope,referenceDate:request.referenceDate,timezone:request.timezone,timeoutMs:DEFAULT_REQUEST_POLICY.timeoutMs,agentOptions:{requestedThinkingLevel:'off' as const,effectiveThinkingLevel:'off' as const},instanceId:'host',createdAt:at}}};
}

test('same normalized scope preserves adopted Query and leaves every SQL column unchanged on no-op', () => {
  const f=fixture(),q=savedQuery(f);
  const adopted=f.repos.updateWorkspace({queryId:q.record.id,activeView:'query'},2,at),before=allWorkspace(f);
  const result=f.repos.updateWorkspace({batchIds:[2],deviceIds:[1]},adopted.revision,later);
  expect(result.queryId).toBe(q.record.id); expect(result.revision).toBe(adopted.revision); expect(allWorkspace(f)).toEqual(before);
});

test('explicit Query adoption takes its saved scope and contradictory declared scope rolls back', () => {
  const f=fixture(),q=savedQuery(f),original=f.db.query('SELECT * FROM queries').all();
  f.repos.updateWorkspace({batchIds:[1],deviceIds:[]},2,at);
  const adopted=f.repos.updateWorkspace({queryId:q.record.id},3,later);
  expect(adopted.batchRefs.map(b=>b.id)).toEqual([2]); expect(adopted.deviceIds).toEqual([1]);
  const before=allWorkspace(f);
  expect(()=>f.repos.updateWorkspace({queryId:q.record.id,batchIds:[1]},adopted.revision,later)).toThrow('invalid_argument');
  expect(allWorkspace(f)).toEqual(before); expect(f.db.query('SELECT * FROM queries').all()).toEqual(original);
});

test('device selection persists, omitted selection preserves compatibility, explicit null clears once', () => {
  const f=fixture();
  const selected=f.repos.updateWorkspace({selection:deviceSelection},2,at);
  expect(selected.selection).toEqual(deviceSelection);
  expect(f.repos.updateWorkspace({batchIds:[2]},selected.revision,later).selection).toEqual(deviceSelection);
  const current=f.repos.readWorkspace(),cleared=f.repos.updateWorkspace({selection:null},current.revision,later);
  expect(cleared.selection).toBeNull(); expect(cleared.revision).toBe(current.revision+1);
});

test('invalid version, row identity, own scalar field and explicit outside device reject without SQL changes', () => {
  const f=fixture(),before=allWorkspace(f);
  for (const selection of [
    {...deviceSelection,targetId:'01'}, {...deviceSelection,targetVersion:hash1}, {...deviceSelection,rowKey:'snapshot:4'},
    {...deviceSelection,field:'sourceRefs'}, {...deviceSelection,field:'price_cents'}, {...deviceSelection,field:'constructor'},
    {...deviceSelection,field:'__proto__'}, {...deviceSelection,field:'fieldOrigins.price'},
  ]) {expect(()=>f.repos.updateWorkspace({selection},2,later)).toThrow(); expect(allWorkspace(f)).toEqual(before);}
  expect(()=>f.repos.updateWorkspace({deviceIds:[99]},2,later)).toThrow('access_denied'); expect(allWorkspace(f)).toEqual(before);
});

test('omitted device filters old IDs against new batch scope while explicit invalid IDs reject', () => {
  const f=fixture(); f.db.query('DELETE FROM snapshots WHERE batch_id=1 AND device_id=1').run();
  const next=f.repos.updateWorkspace({batchIds:[1]},2,later); expect(next.deviceIds).toEqual([]);
  const before=allWorkspace(f); expect(()=>f.repos.updateWorkspace({deviceIds:[1]},next.revision,later)).toThrow('access_denied'); expect(allWorkspace(f)).toEqual(before);
});

test('Query row and Evidence use immutable result hash and reject rows outside their saved members', () => {
  const f=fixture(),q=savedQuery(f);
  const selection={formatVersion:1 as const,kind:'query-row' as const,targetId:String(q.record.id),targetVersion:q.record.resultHash,rowKey:'snapshot:3',field:'priceCents'};
  const next=f.repos.updateWorkspace({queryId:q.record.id,selection,activeView:'query'},2,at); expect(next.selection).toEqual(selection);
  const before=allWorkspace(f);
  expect(()=>f.repos.updateWorkspace({selection:{...selection,rowKey:'snapshot:4'}},next.revision,later)).toThrow(); expect(allWorkspace(f)).toEqual(before);
  const evidence={...selection,kind:'evidence' as const,targetId:String(q.evidenceId),rowKey:null,field:null};
  const whole=f.repos.updateWorkspace({selection:evidence,activeView:'evidence'},next.revision,later); expect(whole.selection).toEqual(evidence);
  expect(()=>f.repos.updateWorkspace({selection:{...evidence,field:'resultHash'}},whole.revision,later)).toThrow();
});

test('change selection requires both original batches and uses their saved hashes', async () => {
  const f=fixture(); const {describeDataSelection}=await import('../../packages/storage/src/workspace-selection');
  const change=f.catalog.readChanges([2],[1],null)[0]!,selection=describeDataSelection(change,f.catalog.readBatches([1,2]));
  expect(selection).toMatchObject({kind:'change',targetId:'1',rowKey:'change:1',field:null});
  const selected=f.repos.updateWorkspace({selection,activeView:'changes'},2,at); expect(selected.selection).toEqual(selection);
  const next=f.repos.updateWorkspace({batchIds:[2]},selected.revision,later); expect(next.selection).toBeNull();
  const before=allWorkspace(f); expect(()=>f.repos.updateWorkspace({selection},next.revision,later)).toThrow('access_denied'); expect(allWorkspace(f)).toEqual(before);
});

test('session switch keeps device/change, clears Query references, and old creation receipt never reselects', () => {
  const f=fixture(); f.repos.updateWorkspace({selection:deviceSelection,activeView:'changes'},2,at);
  const created=f.repos.createSession({expectedWorkspaceRevision:3},'create-b','native-b',later);
  expect(created.workspace.selection).toEqual(deviceSelection); expect(created.workspace.activeView).toBe('changes');
  const same=f.repos.selectSession({sessionId:2,expectedWorkspaceRevision:4},later); expect(same.revision).toBe(4);
  f.repos.selectSession({sessionId:1,expectedWorkspaceRevision:4},later); const q=savedQuery(f);
  f.repos.updateWorkspace({queryId:q.record.id,activeView:'query',selection:{formatVersion:1,kind:'query-row',targetId:String(q.record.id),targetVersion:q.record.resultHash,rowKey:'snapshot:3',field:null}},5,later);
  const switched=f.repos.selectSession({sessionId:2,expectedWorkspaceRevision:6},later);
  expect(switched).toMatchObject({queryId:null,selection:null,activeView:'data',deviceIds:[1]});
  expect(f.repos.createSession({expectedWorkspaceRevision:0},'create-a','ignored-native',later).session.id).toBe(1);
  expect(f.repos.readWorkspace()).toEqual(switched);
  expect(()=>f.repos.updateWorkspace({queryId:q.record.id},switched.revision,later)).toThrow('access_denied');
});

test('CAS checks no-op, revision overflow and a late commit failure preserve every workspace and Query byte', () => {
  const f=fixture(),q=savedQuery(f),before=allWorkspace(f),queries=f.db.query('SELECT * FROM queries').all();
  expect(()=>f.repos.updateWorkspace({},1,later)).toThrow('workspace_revision_mismatch');
  const failing=new Repositories(f.db,()=>{throw new Error('late fault');});
  expect(()=>failing.updateWorkspace({selection:deviceSelection},2,later)).toThrow('late fault'); expect(allWorkspace(f)).toEqual(before);
  expect(f.db.query('SELECT * FROM queries').all()).toEqual(queries); expect(q.record.resultHash).toHaveLength(64);
  f.db.query('UPDATE workspace SET revision=?').run(Number.MAX_SAFE_INTEGER);
  const overflow=allWorkspace(f); expect(()=>f.repos.updateWorkspace({activeView:'changes'},Number.MAX_SAFE_INTEGER,later)).toThrow('state_conflict'); expect(allWorkspace(f)).toEqual(overflow);
});

test('input and root Run freeze the confirmed selection; stale acceptance writes no input Run or model call', () => {
  const f=fixture(),workspace=f.repos.updateWorkspace({selection:deviceSelection},2,at),scope=f.repos.freezeAgentScope(workspace,[]);
  const model={provider:'p',modelId:'m',api:'openai-completions',endpointRef:null,credentialRef:null,configVersion:'1',maxOutputTokens:100,capabilitySource:'user_declared' as const,sdkVersion:'0.87.1' as const};
  const request={sessionId:1,clientSequence:1,text:'这一项',mode:'send' as const,expectedRevision:workspace.revision,expectedBatchIds:[1,2],expectedQueryId:null,model:{provider:'p',modelId:'m',expectedConfigVersion:'1'},referenceDate:'2026-10-04',timezone:'Asia/Shanghai'};
  const content={contract:'medclaw.session-input/v1' as const,originalSubmitInput:request,text:request.text,workspaceContext:toWorkspaceContext(workspace),scope,model,referenceDate:request.referenceDate,timezone:request.timezone,deliveryAttempt:null};
  const run={sessionId:1,goal:'answer' as const,text:request.text,model,policy:DEFAULT_REQUEST_POLICY,workspace,scope,referenceDate:request.referenceDate,timezone:request.timezone,timeoutMs:DEFAULT_REQUEST_POLICY.timeoutMs,agentOptions:{requestedThinkingLevel:'off' as const,effectiveThinkingLevel:'off' as const},instanceId:'host',createdAt:at};
  const plan={operationRef:'send',originalSubmitInput:request,content,createdAt:at,execution:{mode:'send' as const,run}};
  const accepted=f.repos.acceptInput(plan),savedInput=f.db.query('SELECT * FROM session_inputs').all(),savedRun=f.db.query('SELECT * FROM runs').all();
  f.repos.updateWorkspace({selection:null},workspace.revision,later);
  expect(f.repos.acceptInput(plan)).toEqual(accepted); expect(f.db.query('SELECT * FROM session_inputs').all()).toEqual(savedInput); expect(f.db.query('SELECT * FROM runs').all()).toEqual(savedRun);
  const request2={...request,clientSequence:2};
  expect(()=>f.repos.acceptInput({...plan,operationRef:'stale',originalSubmitInput:request2,content:{...content,originalSubmitInput:request2}})).toThrow('workspace_revision_mismatch');
  expect(f.db.query('SELECT * FROM session_inputs').all()).toEqual(savedInput); expect(f.db.query('SELECT * FROM runs').all()).toEqual(savedRun); expect(f.db.query('SELECT COUNT(*) AS n FROM model_calls').get()).toEqual({n:0});
  const json=f.db.query<{workspace_json:string;config_json:string},[]>('SELECT workspace_json,config_json FROM runs').get()!;
  expect(JSON.parse(json.workspace_json).selection).toEqual(deviceSelection); expect(JSON.parse(json.config_json)).not.toHaveProperty('workspace');
});

test('acceptance revalidates a saved selection against current SQLite facts before freezing', () => {
  const f=fixture(); f.repos.updateWorkspace({selection:deviceSelection},2,at); const plan=prepared(f);
  // The first batch still authorizes device 1, so this catches missing selection validation, rather than device-scope validation.
  f.db.query('DELETE FROM snapshots WHERE id=3').run(); const before=allWorkspace(f);
  expect(()=>f.repos.acceptInput(plan)).toThrow('access_denied'); expect(allWorkspace(f)).toEqual(before);
  expect(f.db.query('SELECT COUNT(*) AS n FROM session_inputs').get()).toEqual({n:0}); expect(f.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({n:0});
});

test('queued inputs require a scope derived from their confirmed workspace and stay frozen across browsing another Session', () => {
  const f=fixture(),plan=prepared(f),root=f.repos.acceptInput(plan);
  const request={...plan.originalSubmitInput,mode:'steer' as const,clientSequence:2,targetRunId:root.runId!};
  const queue={...plan,operationRef:'queue',originalSubmitInput:request,content:{...plan.content,originalSubmitInput:request},execution:{mode:'steer' as const,targetRunId:root.runId!}};
  expect(()=>f.repos.acceptInput({...queue,content:{...queue.content,scope:{...queue.content.scope,batchIds:[2]}}})).toThrow('access_denied');
  const accepted=f.repos.acceptInput(queue),before=f.db.query('SELECT * FROM session_inputs').all();
  f.repos.createSession({expectedWorkspaceRevision:2},'create-b','native-b',later);
  expect(f.repos.acceptInput(queue)).toEqual(accepted); expect(f.db.query('SELECT * FROM session_inputs').all()).toEqual(before);
  expect(f.repos.active()).toMatchObject({runId:root.runId,sessionId:1});
});

test('Query selection freezes original Query row field and BatchRef in Input and Run through a later scope change', () => {
  const f=fixture(),q=savedQuery(f);
  f.repos.updateWorkspace({queryId:q.record.id,selection:{formatVersion:1,kind:'query-row',targetId:String(q.record.id),targetVersion:q.record.resultHash,rowKey:'snapshot:3',field:'priceCents'}},2,at);
  const plan=prepared(f,2),accepted=f.repos.acceptInput(plan);
  const input=f.db.query<{content_json:string},[number]>('SELECT content_json FROM session_inputs WHERE id=?').get(accepted.inputId!)!.content_json;
  const run=f.db.query<{workspace_json:string;scope_json:string;config_json:string},[number]>('SELECT workspace_json,scope_json,config_json FROM runs WHERE id=?').get(accepted.runId!)!;
  expect(JSON.parse(input).workspaceContext).toMatchObject({queryId:q.record.id,selection:{rowKey:'snapshot:3',field:'priceCents',targetVersion:q.record.resultHash},batchRefs:[{id:2,contentHash:hash2}]});
  expect(JSON.parse(run.workspace_json)).toEqual(JSON.parse(input).workspaceContext);
  f.repos.updateWorkspace({batchIds:[1],selection:null},3,later);
  expect(f.db.query('SELECT content_json FROM session_inputs WHERE id=?').get(accepted.inputId!)).toEqual({content_json:input});
  expect(f.db.query('SELECT workspace_json,scope_json,config_json FROM runs WHERE id=?').get(accepted.runId!)).toEqual(run);
});

test('full saved Query identities are stable across slices and duplicate rows have no selectable key', async () => {
  const f=fixture(),q=savedQuery(f),{queryRowKeys,resolveQueryRow}=await import('../../packages/storage/src/workspace-selection');
  expect(queryRowKeys(q.record)).toEqual(['snapshot:3']);
  const changes={...q.record,kind:'changes' as const,rows:[{eventId:91,deltaCents:-20}],eventIds:[91]};
  expect(queryRowKeys(changes)).toEqual(['change:91']);
  const aggregate={...q.record,kind:'aggregate' as const,rows:[{value:7,region:'浙江'}]};
  const key='row:1578a93f1a1904e940d9c08b36fe6bab4ab94407cf8517a9c2c50a0ce72075bf';
  expect(queryRowKeys(aggregate)).toEqual([key]);
  expect(queryRowKeys({...aggregate,kind:'trend',rows:[{region:'浙江',value:7}]})).toEqual([key]);
  expect(resolveQueryRow(aggregate,key)).toEqual({value:7,region:'浙江'});
  const duplicate={...aggregate,rows:[{value:7,region:'浙江'},{region:'浙江',value:7}]};
  expect(queryRowKeys(duplicate)).toEqual([null,null]); expect(()=>resolveQueryRow(duplicate,key)).toThrow('access_denied');
  expect(queryRowKeys({...q.record,rows:[q.record.rows[0]!,q.record.rows[0]!]})).toEqual([null,null]);
});

test('legacy Run acceptance projects State and ignores response notices in in-process workspace wiring', () => {
  const f=fixture(),plan=prepared(f);
  const run={...plan.execution.run,inputId:null,workspace:{...plan.execution.run.workspace,notices:[{code:'reference_cleared' as const,kind:'query' as const,targetId:'7'}]},submission:{operationRef:'legacy-submit',originalSubmitInput:plan.originalSubmitInput}};
  const result=f.repos.registerAgent(run);
  const saved=f.db.query<{workspace_json:string},[number]>('SELECT workspace_json FROM runs WHERE id=?').get(result.runId)!;
  expect(JSON.parse(saved.workspace_json)).toEqual(plan.content.workspaceContext); expect(JSON.parse(saved.workspace_json)).not.toHaveProperty('notices');
});
