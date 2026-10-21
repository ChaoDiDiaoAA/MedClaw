import { safeError } from '../../packages/contracts/src/error';
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { agentRuntimeFixture } from '../fixtures/agent-runtime';
import { disabledIntentModel, emptyIntentSlots, readIntentStageMessage } from '../fixtures/p14-intent';
import { IntentModelConfigurationSchema } from '../../packages/contracts/src/model';
import { OllamaIntentClient } from '../../packages/intent-ollama/src/index';
import { CLASSIFY_PROMPT } from '../../packages/core/src/intent/prompts/classify';
import { VERIFY_PROMPT } from '../../packages/core/src/intent/prompts/verify';

const migrations = ['001_p1.sql','002_p2.sql','003_p3.sql','004_p5.sql','005_p6.sql','006_session_lifecycle.sql','007_batch_deletion.sql',
  '008_p8.sql','009_p9.sql','010_p10.sql','011_p11.sql','012_p13.sql','013_p14.sql','014_p15.sql'];
function schema14() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p15-plan-migration-')), path = join(root, 'app.sqlite'), db = new Database(path, { strict: true });
  const at = '2026-10-11T01:00:00.000Z';
  for (const [index, name] of migrations.entries()) {
    db.exec('PRAGMA foreign_keys=OFF'); const sql = readFileSync(new URL(`../../packages/storage/src/migrations/${name}`, import.meta.url)); db.exec(sql.toString());
    db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(index + 1, createHash('sha256').update(sql).digest('hex'), at);
  }
  db.exec('PRAGMA foreign_keys=ON'); seedWorkspaceQueries(db);
  db.transaction(() => {
    db.query("INSERT INTO session_inputs(id,session_id,client_sequence,operation_ref,mode,status,content_json,created_at,updated_at) VALUES(201,1,2,'plan-legacy','send','queued','{}',?,?)").run(at,at);
    db.query(`INSERT INTO runs(id,session_id,input_id,kind,instance_id,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at)
      VALUES(11,1,201,'agent','host','running','answer','legacy','{"agent":{"nativeSessionId":"native-a"}}','{}','{}','2026-10-10','Asia/Shanghai',?)`).run(at);
    db.query('UPDATE session_inputs SET target_run_id=11 WHERE id=201').run();
    db.query(`INSERT INTO route_decisions(run_id,session_id,input_id,route,decision_source,adopted_intents_json,missing_slots_json,issues_json,schema_version,policy_version,created_at)
      VALUES(11,1,201,'agent','explicit_agent_fallback','[]','[]','[]','medclaw.intent/v2','medclaw.intent-policy/v3',?)`).run(at);
  }).immediate();
  const tables = db.query<{name:string},[]>('SELECT name FROM sqlite_schema WHERE type=\'table\' AND name NOT LIKE \'sqlite_%\' AND name<>\'schema_migrations\' ORDER BY name').all().map(r=>r.name);
  const rows = tables.map(name=>db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all()); db.close();
  return { root,path,tables,rows };
}
for (const phase of [null,'p15_plan_copy','p15_plan_rename','p15_plan_marker']) test(`p15 plan migration preserves schema14 facts and rolls back ${phase ?? 'without fault'}`, () => {
  const f = schema14();
  try {
    if (phase) {
      let reached = false;
      expect(()=>{const db=openDatabase(f.path,step=>{if(step===phase){reached=true;throw new Error('migration fault');}});db.close();}).toThrow('storage_migration_failed');
      expect(reached).toBe(true);
      const raw=new Database(f.path,{strict:true});expect(raw.query('SELECT MAX(version) AS n FROM schema_migrations').get()).toEqual({n:14});raw.close();
    }
    const db=openDatabase(f.path);
    try {
      expect(db.query('SELECT MAX(version) AS n FROM schema_migrations').get()).toEqual({n:17});
      for(const [i,name] of f.tables.entries()) {
        const actual=db.query<Record<string,unknown>,[]>(`SELECT * FROM ${name} ORDER BY id`).all();
        const retired=['preview_request_hash','commit_request_hash','fingerprint','source_lock_hash','content_hash','cohort_hash','params_hash','result_hash','scope_batch_hashes_json','sha256','metadata_sha256','request_hash','published_hash'];
        const expected=f.rows[i]!.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!retired.includes(key))));
        expect(actual.map((row,n)=>Object.fromEntries(Object.keys(expected[n]!).map(key=>[key,row[key]])))).toEqual(expected);
      }
      expect(db.query('SELECT execution_plan_json FROM route_decisions').get()).toEqual({execution_plan_json:null});
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(()=>db.query("UPDATE route_decisions SET execution_plan_json='{}'").run()).toThrow('route_decision_immutable');
    } finally {db.close();}
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

for (const scenario of ['compare','trend','freshness','multi','replay','second_failure','cancel','answer_content','missing_part','rollback','lost_return'] as const) test(`p15 ${scenario} executes the frozen product plan with zero main calls and an authoritative Answer`, async () => {
  const mode=['compare','trend','freshness','multi'].includes(scenario)?scenario:'compare';
  let intentCalls=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/api/version')return Response.json({version:'ENGINEERING'});
    if(path==='/api/tags')return Response.json({models:[{name:'qwen3.5:0.8b'}]});
    if(path==='/api/show')return Response.json({details:{family:'qwen35',parameter_size:'752.39M',quantization_level:'Q8_0'}});
    if(path!=='/api/chat')return new Response('',{status:404});
    const body=await request.json() as {messages:{content:string}[]};readIntentStageMessage(body.messages[1]!.content);intentCalls++;
    const compare={id:'s1',l0:'STATISTICAL_ANALYSIS',l1:'COMPARATIVE_ANALYSIS',l2:'PERIOD_COMPARE',slots:{...emptyIntentSlots(),region:'浙江',metric:'count'},
      parameters:{periods:[{start:'2026-10-04',endExclusive:'2026-10-05'},{start:'2026-10-05',endExclusive:'2026-10-06'}]},dependsOn:[],resultRef:null};
    const trend={id:'s1',l0:'CHANGE_MONITOR',l1:'PRICE_MONITOR',l2:'PRICE_TREND',slots:{...emptyIntentSlots(),region:'浙江',time:{start:'2026-10-04',endExclusive:'2026-10-06'},metric:'sum_price',groupBy:'date'},parameters:{},dependsOn:[],resultRef:null};
    const freshness={id:'s1',l0:'DATA_OPERATIONS',l1:'DATA_QUALITY',l2:'FRESHNESS',slots:{...emptyIntentSlots(),region:'浙江'},parameters:{basis:'snapshot_date'},dependsOn:[],resultRef:null};
    const intents=mode==='compare'?[compare]:mode==='trend'?[trend]:mode==='freshness'?[freshness]:[compare,{...trend,id:'s2',dependsOn:['s1']}];
    return Response.json({model:'qwen3.5:0.8b',done:true,done_reason:'stop',message:{role:'assistant',content:JSON.stringify({contract:'medclaw.intent/v2',status:'RESOLVED',intents,candidateIntents:[],clarification:null})}});
  }});
  const f=await agentRuntimeFixture(undefined,false,undefined,{client:new OllamaIntentClient({classify:CLASSIFY_PROMPT,verify:VERIFY_PROMPT}),configuration:IntentModelConfigurationSchema.parse({
    ...disabledIntentModel(),enabled:true,baseUrl:`http://127.0.0.1:${server.port}`,verifiedEvidenceRef:'ENGINEERING'})});
  try {
    seedWorkspaceQueries(f.db,f.repos);
    f.db.query('UPDATE runs SET cleanup_json=? WHERE id=10').run(JSON.stringify({contract:'medclaw.run-cleanup/v1',executionStarted:false,stopConfirmed:true,requiredPersistenceComplete:true,inputsSettled:true,resourcesReleased:true,unconfirmedItems:[],secondaryErrors:[],verifiedAt:'2026-10-04T00:00:00.000Z'}));
    const batch=f.db.query<Record<string,unknown>,[]>('SELECT * FROM batches WHERE id=1').get()!;
    Object.assign(batch,{id:2,snapshot_date:'2026-10-05',is_baseline:0,previous_batch_id:1});
    const insert=(table:string,row:Record<string,unknown>)=>f.db.query(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row) as (string|number|null)[]);
    insert('batches',batch);
    for(const row of f.db.query<Record<string,unknown>,[]>('SELECT * FROM snapshots WHERE batch_id=1').all())insert('snapshots',{...row,id:Number(row.id)+3,batch_id:2,price_cents:200});
    f.repos.updateWorkspace({batchIds:[1,2]},f.repos.readWorkspace().revision,'2026-10-11T01:00:00.000Z');
    const execute=f.queries.execute.bind(f.queries),finalize=f.repos.finalizeAgent.bind(f.repos);let executions=0,corrupt=true;
    f.queries.execute=async(params,context)=>{
      executions++;
      if(scenario==='second_failure'&&executions===2)return {ok:false,error:safeError('data_coverage_missing')};
      const result=await execute(params,context);
      if(executions===1&&result.ok){
        if(scenario==='replay'){
          expect(await execute(params,context)).toEqual(result);
          expect(await execute({...params,time:{start:'2026-10-05',endExclusive:'2026-10-06'}},context)).toMatchObject({ok:false,error:{code:'access_denied'}});
          expect(await execute(params,{...context,sessionId:999})).toMatchObject({ok:false,error:{code:'access_denied'}});
        }
        if(scenario==='cancel')f.app.runs.cancelNow(context.runId);

      }
      return result;
    };
    f.repos.finalizeAgent=(runId,fact)=>{
      if(scenario==='lost_return'){finalize(runId,fact);throw new Error('COMMITTED_RECEIPT_LOST');}
      if(corrupt&&(scenario==='missing_part'||scenario==='answer_content')){
        const changed=structuredClone(fact);
        const entry=changed.history!.newEntries.find(value=>(value as {customType?:string}).customType==='medclaw-intent-execution') as {data:{stepResults:{queryRefs:unknown[]}[]}};
        if(scenario==='missing_part')entry.data.stepResults[0]!.queryRefs.pop();
        else {
          const result=changed.history!.newEntries.find(value=>(value as {customType?:string}).customType==='medclaw-query-result') as {content:string};
          result.content+='\nForged numerical answer: 999 devices.';
        }
        changed.productTurn!.history=changed.history!;
        return finalize(runId,changed);
      }
      return finalize(runId,fact);
    };
    if(scenario==='rollback')f.db.exec("CREATE TRIGGER plan_final_rollback BEFORE INSERT ON answers BEGIN SELECT RAISE(ABORT,'ENGINEERING_FINAL_ROLLBACK'); END;");
    const text=mode==='compare'?'比较浙江2026-10-04和2026-10-05的快照记录总数，不限状态':mode==='trend'?'浙江2026-10-04至2026-10-05价格总额趋势，不限状态':mode==='freshness'?'查看浙江快照新鲜度':'查看浙江两日比较及价格趋势';
    const accepted=await f.app.runs.submitAgent({...f.request(text),mode:'send',routing:{mode:'intent',originRunId:null}},{instanceId:'host',operationRef:`plan-${mode}`});if(!accepted.ok)throw accepted.error;
    const runId=accepted.data.runId!;
    if(['answer_content','missing_part','rollback'].includes(scenario)){
      for(let i=0;i<1000&&!f.app.runs.persistencePending;i++)await Bun.sleep(2);
      expect(f.app.runs.persistencePending).toBe(true);
      expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(runId)).toHaveLength(0);
      const before=f.db.query('SELECT id,params_json,result_json FROM queries WHERE run_id=?').all(runId);expect(before).toHaveLength(2);
      corrupt=false;if(scenario==='rollback')f.db.exec('DROP TRIGGER plan_final_rollback');
      expect(await f.app.runs.retrySave(runId)).toMatchObject({ok:true});
      expect(f.db.query('SELECT id,params_json,result_json FROM queries WHERE run_id=?').all(runId)).toEqual(before);
    }
    await f.settle();const facts=f.repos.readIntent({runId});
    if(scenario==='second_failure'||scenario==='cancel'){
      expect(facts?.execution.runStatus).toBe(scenario==='cancel'?'cancelled':'failed');
      expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(runId)).toHaveLength(1);
      expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(runId)).toHaveLength(0);
      expect(intentCalls).toBe(1);expect(f.requests).toHaveLength(0);return;
    }
    expect(intentCalls).toBe(1);expect(f.requests).toHaveLength(0);expect(facts?.execution.runStatus).toBe('completed');
    expect(facts?.decision?.route).toBe('simple');
    const queries=f.db.query<{id:number;params_json:string;call_ref:string},[number]>('SELECT id,params_json,call_ref FROM queries WHERE run_id=? ORDER BY id').all(runId);
    expect(queries).toHaveLength(mode==='compare'?2:mode==='multi'?3:mode==='trend'?1:0);
    const answer=f.db.query<{text:string;query_ids_json:string},[number]>('SELECT text,query_ids_json FROM answers WHERE run_id=?').get(runId)!;
    expect(answer).not.toBeNull();expect(JSON.parse(answer.query_ids_json)).toEqual(queries.map(q=>q.id));expect(answer.text).toContain('2026-10-04');expect(answer.text).toContain('2026-10-05');
    if(mode==='compare'||mode==='multi'){expect(answer.text).toContain('Difference (part 1 - part 0): 0');expect(answer.text).toContain('equal counts do not establish equal device sets');}
    if(mode==='trend'||mode==='multi'){expect(answer.text).toContain('300');expect(answer.text).toContain('600');expect(answer.text).toContain('CNY');}
    expect(queries.every(q=>q.call_ref.endsWith(':0')||q.call_ref.endsWith(':1'))).toBe(true);
  } finally {try{await f.close();}finally{server.stop(true);}}
});
