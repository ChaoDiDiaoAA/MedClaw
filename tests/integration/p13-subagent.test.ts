import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { openDatabase, SCHEMA_VERSION } from '../../packages/storage/src/database';
import { acceptContextInput, contextAt } from '../fixtures/p8-context';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteContextStore } from '../../packages/storage/src/context-store';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { FrozenChildConfigSchema } from '../../packages/contracts/src/subagent';
import { normalizeRuntimeConfiguration, DEFAULT_AGENT_POLICY,projectRuntimePolicies } from '../../packages/contracts/src/runtime-config';
import { normalizeToolConfiguration } from '../../packages/contracts/src/tool-config';
import { memoryNativeFixture, sqliteHistory } from '../fixtures/p9-memory';
import { join } from 'node:path';
import { loadP13Managed, p13AgentInput, withP13Plugin } from '../fixtures/p13-subagent';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { QueryService } from '../../packages/core/src/data/query-service';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { SqliteCatalogStore } from '../../packages/storage/src/catalog-store';
import { createPiNativeTools } from '../../packages/runtime-pi/src/pi-tool-adapter';
import { ToolRecorder } from '../../packages/core/src/tools/recorder';
import { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ContextService } from '../../packages/core/src/context/context-service';
import { RunControl } from '../../packages/core/src/runtime/run-control';
import { ToolRegistry } from '../../packages/core/src/tools/registry';
import { ToolExecutor } from '../../packages/core/src/tools/executor';
import { createReadDataScopeTool } from '../../packages/core/src/tools/business-tools/read-data-scope';
import { ModelCallRecorder } from '../../packages/runtime-pi/src/model-call-recorder';
import { performance } from 'node:perf_hooks';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { RuntimeService } from '../../packages/core/src/runtime/runtime-service';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { agentRuntimeFixture } from '../fixtures/agent-runtime';
import { canReadRelatedQuery } from '../../packages/storage/src/child-identity';
import { SessionService } from '../../packages/core/src/session/session-service';
import { SubmitInputSchema } from '../../packages/contracts/src/session';
import { canonicalRequest } from '../../packages/contracts/src/run';
import {encodeHostFrame,HOST_PROTOCOL_VERSION,MAX_FRAME_BYTES} from '../../packages/contracts/src/protocol';
import {Application} from '../../packages/core/src/application';
import {safeError} from '../../packages/contracts/src/error';

const retiredBusinessColumns=new Set(["preview_request_hash", "commit_request_hash", "fingerprint", "source_lock_hash", "content_hash", "cohort_hash", "params_hash", "result_hash", "scope_batch_hashes_json", "request_hash", "published_hash", "sha256"]);
const retainedFields=(row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).filter(([key])=>!retiredBusinessColumns.has(key)));

test('p13 child recent pages omit full results and a maximum 50-item page fits the Host frame',async()=>{
  const text='中'.repeat(32768),f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'large-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:index===2?text:'ENGINEERING parent answer'});
  try{
    const accepted=await f.app.runs.submitAgent(f.request('ENGINEERING large child result'),{instanceId:'host',operationRef:'p13-large-child-page'});expect(accepted.ok).toBe(true);await f.settle();
    const recent=f.repos.read({recent:true,parentRunId:1,limit:50});if(recent.kind!=='recent'||recent.runs[0]?.kind!=='child')throw new Error('No child summary');
    expect(recent.runs[0]).not.toHaveProperty('childResult');expect(f.repos.read({runId:recent.runs[0].id})).toMatchObject({kind:'one',run:{childResult:{text}}});
    const page={...recent,runs:Array.from({length:50},(_,index)=>({...recent.runs[0]!,id:index+2,inputText:'中'.repeat(2048)}))};
    const frame=encodeHostFrame({protocolVersion:HOST_PROTOCOL_VERSION,kind:'reply',instanceId:'host',requestId:'maximum-child-page',result:{ok:true,data:page}});
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThan(MAX_FRAME_BYTES);expect(f.requests).toHaveLength(3);
  }finally{await f.close();}
},20000);

for (const audit of [false,true])for (const delegate of [false,true]) test('p13 original product Agent registration '+(audit?'with P12 audit ':'')+(delegate?'delegates through the plugin and returns committed child result':'starts no child without a real tool call'),async()=>{
  const f=await agentRuntimeFixture(index=>index===1&&delegate
    ?{role:'assistant',tool_calls:[{index:0,id:'parent-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}
    :index===2&&delegate?{role:'assistant',tool_calls:[{index:0,id:'child-business',type:'function',function:{name:'read_data_scope',arguments:'{}'}}]}
    :{role:'assistant',content:index===3?'ENGINEERING_CHILD_ORIGINAL':'ENGINEERING_PARENT_RESULT'},audit);
  try {
    const toolViews:{all:string[];active:string[]}[]=[];
    const open=Reflect.get(f.agent,'openManagedChild').bind(f.agent);
    Reflect.set(f.agent,'openManagedChild',async(...args:unknown[])=>{const session:AgentSession=await open(...args);toolViews.push({all:session.getAllTools().map(tool=>tool.name),active:session.getActiveToolNames()});return session;});
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING verify with independent context'),{instanceId:'host',operationRef:'p13-original'});
    expect(result.ok).toBe(true);if(!result.ok||!result.data.runId)throw new Error('No Run');
    await f.settle();expect(f.errors).toEqual([]);
    const names=(f.requests[0]!.tools as {function:{name:string}}[]).map(tool=>tool.function.name);
    expect(names).toContain('Agent');
    expect(f.repos.read({runId:result.data.runId})).toMatchObject({kind:'one',run:{status:'completed'}});
    const children=f.db.query<{id:number;session_id:number;child_result_json:string;cleanup_json:string},[]>("SELECT id,session_id,child_result_json,cleanup_json FROM runs WHERE kind='child'").all();
    expect(children).toHaveLength(delegate?1:0);
    expect(f.requests).toHaveLength(delegate?4:1);
    if(!delegate){expect(f.db.query("SELECT id FROM sessions WHERE kind='child'").all()).toEqual([]);expect(toolViews).toEqual([]);return;}
    const child=children[0]!,saved=JSON.parse(child.child_result_json);
    expect(saved).toMatchObject({outcome:'completed',text:'ENGINEERING_CHILD_ORIGINAL',parentRunId:result.data.runId,childRunId:child.id,childSessionId:child.session_id});
    expect(JSON.parse(child.cleanup_json)).toMatchObject({stopConfirmed:true,requiredPersistenceComplete:true,resourcesReleased:true});
    const childNames=(f.requests[1]!.tools as {function:{name:string}}[]).map(tool=>tool.function.name);
    expect(childNames).toContain('read_data_scope');expect(childNames).toContain('read');
    expect(toolViews[0]!.all.sort()).toEqual([...childNames].sort());expect(toolViews[0]!.active.sort()).toEqual([...childNames].sort());
    for(const forbidden of ['Agent','extension_runtime_status','edit','write','bash','powershell'])expect(childNames).not.toContain(forbidden);
    const origin=f.db.query<{status:string;sdk_returned:number;result_json:string},[number,string]>("SELECT status,json_extract(delivery_json,'$.sdkReturned') AS sdk_returned,result_json FROM tool_calls WHERE run_id=? AND native_tool_call_id=?").get(result.data.runId,'parent-Agent')!;
    expect(origin).toMatchObject({status:'succeeded',sdk_returned:1});expect(JSON.parse(origin.result_json)).toEqual(saved.originalReply);
    expect(JSON.stringify(f.requests[3]!.messages)).toContain('ENGINEERING_CHILD_ORIGINAL');
    expect(f.db.query('SELECT run_id,session_id FROM tool_calls WHERE native_tool_call_id=?').get('child-business')).toEqual({run_id:child.id,session_id:child.session_id});
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(child.id)).toEqual([]);
    expect(f.db.query('SELECT id FROM session_inputs WHERE session_id=?').all(child.session_id)).toEqual([]);
  }finally{await f.close();}
},20000);

test('p13 two original delegations create distinct child identities only after prior stop save and release',async()=>{
  let firstReleased=false;
  const f=await agentRuntimeFixture(index=>{
    if(index===3){
      const first=f.db.query<{status:string;child_result_json:string;cleanup_json:string},[]>("SELECT status,child_result_json,cleanup_json FROM runs WHERE kind='child'").get()!;
      expect(first.status).toBe('completed');expect(first.child_result_json).not.toBeNull();
      expect(JSON.parse(first.cleanup_json)).toMatchObject({stopConfirmed:true,requiredPersistenceComplete:true,resourcesReleased:true});firstReleased=true;
    }
    return index===1||index===3?{role:'assistant',tool_calls:[{index:0,id:'delegate-'+index,type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:
      {role:'assistant',content:'ENGINEERING result '+index};
  },true);
  try {
    const submitted=await f.app.runs.submitAgent(f.request('ENGINEERING two foreground verifications'),{instanceId:'host',operationRef:'p13-twice'});
    expect(submitted.ok).toBe(true);await f.settle();expect(f.errors).toEqual([]);expect(firstReleased).toBe(true);expect(f.requests).toHaveLength(5);
    const rows=f.db.query<{id:number;session_id:number;origin_tool_call_id:number;config_json:string},[]>("SELECT id,session_id,origin_tool_call_id,config_json FROM runs WHERE kind='child' ORDER BY id").all();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);expect(rows[0]!.session_id).not.toBe(rows[1]!.session_id);expect(rows[0]!.origin_tool_call_id).not.toBe(rows[1]!.origin_tool_call_id);
    for(const key of ['pluginAgentId','nativeSessionId'])expect(JSON.parse(rows[0]!.config_json).subagent[key]).not.toBe(JSON.parse(rows[1]!.config_json).subagent[key]);
  }finally{await f.close();}
},20000);

test('p13 repeated real child SDK tool-end and equal parent child native IDs retain one call per owner',async()=>{
  const f=await agentRuntimeFixture(index=>index===1||index===2?{role:'assistant',tool_calls:[{index:0,id:'same-native-call',type:'function',function:{name:index===1?'Agent':'read_data_scope',arguments:JSON.stringify(index===1?p13AgentInput:{})}}]}:{role:'assistant',content:'ENGINEERING original result'});
  const open=Reflect.get(f.agent,'openManagedChild').bind(f.agent);let duplicate=false,unsubscribe:()=>void=()=>{};
  Reflect.set(f.agent,'openManagedChild',async(...args:unknown[])=>{const session:AgentSession=await open(...args);unsubscribe=session.subscribe(event=>{if(event.type==='tool_execution_end'&&!duplicate){duplicate=true;Reflect.get(session,'_emit').call(session,event);}});return session;});
  try{
    expect(await f.app.runs.submitAgent(f.request('ENGINEERING duplicate event'),{instanceId:'host',operationRef:'p13-duplicate-native'})).toMatchObject({ok:true});await f.settle();expect(duplicate).toBe(true);expect(f.errors).toEqual([]);expect(f.requests).toHaveLength(4);
    const child=f.db.query<{id:number;session_id:number},[]>("SELECT id,session_id FROM runs WHERE kind='child'").get()!;
    expect(f.db.query('SELECT run_id,session_id,status FROM tool_calls WHERE native_tool_call_id=? ORDER BY id').all('same-native-call')).toEqual([{run_id:1,session_id:1,status:'succeeded'},{run_id:child.id,session_id:child.session_id,status:'succeeded'}]);
    for(const runId of [1,child.id])expect(f.db.query("SELECT id FROM runtime_events WHERE run_id=? AND type='tool_finished'").all(runId)).toHaveLength(1);
    expect(f.repos.read({runId:1})).toMatchObject({kind:'one',run:{cleanup:{resourcesReleased:true},groupUsage:{parent:{modelCalls:2,toolCalls:1},children:{modelCalls:2,toolCalls:1}}}});
    expect(Reflect.get(f.agent,'sessions').has(child.session_id)).toBe(false);
  }finally{unsubscribe();await f.close();}
},20000);

test('p13 cancellation after committed child preserves Agent execution success without another child loop',async()=>{
  let entered!:()=>void,resume!:()=>void;
  const released=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'cancel-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:'ENGINEERING committed before cancel'});
  try {
    const release=Reflect.get(f.agent,'releaseManagedChild').bind(f.agent);
    Reflect.set(f.agent,'releaseManagedChild',async(...args:unknown[])=>{await release(...args);entered();await gate;});
    const accepted=await f.app.runs.submitAgent(f.request('ENGINEERING postcommit cancellation'),{instanceId:'host',operationRef:'p13-cancel-after-child'});
    if(!accepted.ok||!accepted.data.runId)throw new Error('No Run');
    await released;const cancelling=f.app.runs.cancel(accepted.data.runId);resume();await cancelling;await f.settle();
    expect(f.requests).toHaveLength(2);
    expect(f.db.query("SELECT status,json_extract(child_result_json,'$.outcome') AS outcome FROM runs WHERE kind='child'").get()).toEqual({status:'completed',outcome:'completed'});
    expect(f.db.query("SELECT status,error_json FROM tool_calls WHERE tool_name='Agent'").get()).toEqual({status:'succeeded',error_json:null});
  }finally{resume();await f.close();}
},20000);

test('p13 SDK delivery failure retains committed child and original Agent execution result',async()=>{
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'delivery-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:'ENGINEERING delivery '+index});
  try {
    const prepare=Reflect.get(f.agent,'prepare').bind(f.agent);
    Reflect.set(f.agent,'prepare',async(...args:unknown[])=>{
      await prepare(...args);const session=(args[0] as {session:AgentSession}).session,after=session.agent.afterToolCall;
      session.agent.afterToolCall=async(context,signal)=>context.toolCall.name==='Agent'?{content:[{type:'image',data:'ENGINEERING invalid image'} as never],isError:true}:after?.(context,signal);
    });
    const submitted=await f.app.runs.submitAgent(f.request('ENGINEERING delivery failure'),{instanceId:'host',operationRef:'p13-delivery-failure'});
    expect(submitted.ok).toBe(true);await f.settle();
    expect(f.requests).toHaveLength(3);
    expect(f.db.query("SELECT status,json_extract(child_result_json,'$.outcome') AS outcome FROM runs WHERE kind='child'").get()).toEqual({status:'completed',outcome:'completed'});
    const call=f.db.query<{status:string;delivery_json:string},[]>("SELECT status,delivery_json FROM tool_calls WHERE tool_name='Agent'").get()!;
    expect(call.status).toBe('succeeded');expect(JSON.parse(call.delivery_json)).toMatchObject({sdkReturned:true,error:{code:'tool_delivery_failed'},message:{isError:true},control:{failureClass:'tool_delivery_failed'}});
    expect(JSON.stringify(f.requests[2]!.messages)).toContain('tool_delivery_failed');
    expect(f.db.query("SELECT id FROM runs WHERE kind='child'").all()).toHaveLength(1);
  }finally{await f.close();}
},20000);

test('p13 single allowed child turn can finish without a queued limit reminder or extra execution',async()=>{
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'one-turn-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:'ENGINEERING final '+index});
  try {
    const configuration=normalizeRuntimeConfiguration({requestPolicy:f.app.config.requestPolicy});configuration.runBudget.maxModelCalls=3;
    f.app.config.runtimeConfiguration=configuration;
    f.app.config.agentPolicy={...DEFAULT_AGENT_POLICY,maxModelCalls:3};
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING one child turn'),{instanceId:'host',operationRef:'p13-one-turn'});
    expect(result.ok).toBe(true);await f.settle();expect(f.requests).toHaveLength(3);
    expect(f.db.query("SELECT status,json_extract(child_result_json,'$.outcome') AS outcome FROM runs WHERE kind='child'").get()).toEqual({status:'completed',outcome:'completed'});
    expect(f.db.query("SELECT status FROM tool_calls WHERE tool_name='Agent'").get()).toEqual({status:'succeeded'});
  }finally{await f.close();}
},20000);

test('p13 real child business Query and history retain child ownership without changing parent QueryContext',async()=>{
  const f=await agentRuntimeFixture(index=>{
    const tool=index===1?'Agent':index===2?'read_data_scope':index===3?'query_current_devices':null;
    const args=tool==='Agent'?p13AgentInput:tool==='query_current_devices'?{batchIds:[1],time:{start:'2026-10-04',endExclusive:'2026-10-05'},snapshotMode:'exact_date'}:{};
    return tool?{role:'assistant',tool_calls:[{index:0,id:'owned-'+index,type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:'ENGINEERING only saved facts '+index};
  });
  try {
    seedWorkspaceQueries(f.db,f.repos);const workspace=f.repos.readWorkspace();
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING read-only query'),{instanceId:'host',operationRef:'p13-query-owned'});
    expect(result.ok).toBe(true);await f.settle();expect(f.errors).toEqual([]);expect(f.requests).toHaveLength(5);
    const child=f.db.query<{id:number;session_id:number;child_result_json:string},[]>("SELECT id,session_id,child_result_json FROM runs WHERE kind='child'").get()!;
    const query=f.db.query<{id:number;run_id:number;session_id:number;input_id:null},[number]>('SELECT id,run_id,session_id,input_id FROM queries WHERE run_id=?').get(child.id)!;
    expect(query).toMatchObject({run_id:child.id,session_id:child.session_id,input_id:null});
    expect(JSON.parse(child.child_result_json)).toMatchObject({outcome:'completed',queryRefs:[{queryId:query.id}]});
    expect(f.db.query('SELECT run_id,session_id FROM tool_calls WHERE native_tool_call_id=?').get('owned-3')).toEqual({run_id:child.id,session_id:child.session_id});
    expect(f.db.query("SELECT id FROM memories WHERE run_id=? AND entry_type='message'").all(child.id).length).toBeGreaterThan(0);
    const publicContext={runId:child.id,sessionId:child.session_id,inputId:null,source:'user_form' as const,callRef:'read-child',scope:JSON.parse(f.db.query<{scope_json:string},[number]>('SELECT scope_json FROM runs WHERE id=?').get(child.id)!.scope_json),referenceDate:f.request('read').referenceDate,timezone:'Asia/Shanghai',signal:new AbortController().signal};
    const publicQueries=new QueryService(new CatalogService(new SqliteCatalogStore(f.db)),f.toolStore);
    expect(publicQueries.read(query.id,publicContext)).toMatchObject({id:query.id,runId:child.id});
    expect(()=>f.toolStore.assertContext(publicContext)).toThrow('access_denied');
    expect(()=>publicQueries.read(query.id,{...publicContext,inputId:1})).toThrow('access_denied');
    expect(f.repos.readWorkspace()).toEqual(workspace);
  }finally{await f.close();}
},20000);

for(const mode of ['summary','read','unverified-read'] as const)test('p13 parent discovers committed child Query but Answer requires an explicit consumed read '+mode,async()=>{
  const explicitRead=mode!=='summary',verified=mode==='read';
  let childQueryId=0;
  const f=await agentRuntimeFixture(index=>{
    const tool=index===1?'Agent':index===2?'read_data_scope':index===3?'query_current_devices':index===5&&explicitRead?'read_query':null;
    if(index===5)childQueryId=f.db.query<{id:number},[]>("SELECT q.id FROM queries q JOIN runs r ON r.id=q.run_id WHERE r.kind='child'").get()!.id;
    const args=tool==='Agent'?p13AgentInput:tool==='query_current_devices'?{batchIds:[1],time:{start:'2026-10-04',endExclusive:'2026-10-05'},snapshotMode:'exact_date'}:tool==='read_query'?{queryId:childQueryId}:{};
    return tool?{role:'assistant',tool_calls:[{index:0,id:index===5&&mode==='unverified-read'?'qref-'+index+'x'.repeat(41):'qref-'+index,type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:'ENGINEERING check child evidence '+index};
  });
  try{
    seedWorkspaceQueries(f.db,f.repos);const workspace=f.repos.readWorkspace();
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING verify child query references'),{instanceId:'host',operationRef:'p13-query-read-'+mode});
    if(!result.ok||!result.data.runId)throw new Error('No Run');
    await f.settle();expect(f.errors).toEqual([]);expect(f.requests).toHaveLength(explicitRead?6:5);
    expect(JSON.stringify(f.requests[4]!.messages)).toContain('child-result/v1');
    const snapshot=f.db.query<{snapshot_json:string},[number]>('SELECT snapshot_json FROM context_snapshots WHERE run_id=? ORDER BY sequence DESC LIMIT 1').get(result.data.runId)!;
    const projection=JSON.parse(JSON.parse(snapshot.snapshot_json).renderedProjection.split('\n').slice(1).join('\n'));
    const manifest=projection.materials.find((material:{ref:{version:string}})=>material.ref.version==='child-result/v1');
    expect(manifest).toMatchObject({source:'program_query_fact',value:{queryRefs:[{queryId:childQueryId}]}});
    const answer=f.db.query<{query_ids_json:string},[number]>('SELECT query_ids_json FROM answers WHERE run_id=?').get(result.data.runId)!;
    expect(answer).toBeDefined();expect(JSON.parse(answer.query_ids_json).includes(childQueryId)).toBe(verified);
    if(explicitRead){
      const read=f.db.query<{status:string;delivery_json:string},[number]>("SELECT status,delivery_json FROM tool_calls WHERE run_id=? AND tool_name='read_query'").get(result.data.runId)!;
      expect(read.status).toBe('succeeded');expect(JSON.parse(read.delivery_json).sdkReturned).toBe(true);
      expect(JSON.parse(read.delivery_json).consumptionEvidence==='provider_input_verified').toBe(verified);
    }
    const query=f.toolStore.readQuery(childQueryId)!;
    expect(canReadRelatedQuery(f.db,result.data.runId,1,query)).toBe(true);
    expect(canReadRelatedQuery(f.db,10,1,query)).toBe(false);
    expect(canReadRelatedQuery(f.db,result.data.runId,query.sessionId,query)).toBe(false);
    expect(canReadRelatedQuery(f.db,result.data.runId,1,{...query,id:query.id+999})).toBe(false);
    for(const sql of [
      "UPDATE tool_calls SET delivery_json=json_set(delivery_json,'$.sdkReturned',json('false')) WHERE tool_name='Agent'",
      "UPDATE tool_calls SET delivery_json=json_set(delivery_json,'$.message.isError',json('true')) WHERE tool_name='Agent'",
      "DELETE FROM memories WHERE native_entry_id=(SELECT json_extract(delivery_json,'$.nativeEntryId') FROM tool_calls WHERE tool_name='Agent')",
      "UPDATE runs SET cleanup_json=json_set(cleanup_json,'$.resourcesReleased',json('false')) WHERE kind='child'",
    ]){
      const rollback=new Error('ENGINEERING roll back grant fault');
      expect(()=>f.db.transaction(()=>{
        f.db.exec(sql);
        if(sql.startsWith('DELETE')){let error:unknown;try{canReadRelatedQuery(f.db,result.data.runId!,1,query);}catch(caught){error=caught;}expect(error).toMatchObject({code:'storage_read_failed'});}
        else expect(canReadRelatedQuery(f.db,result.data.runId!,1,query)).toBe(false);
        throw rollback;
      })()).toThrow(rollback);
    }
    expect(f.repos.readWorkspace()).toEqual(workspace);
  }finally{await f.close();}
},20000);

test('p13 browsing B and rejected B Send or Steer keep the real child on original A and independent event sequences',async()=>{
  let entered!:()=>void,resume!:()=>void;
  const childRequest=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
  const f=await agentRuntimeFixture(async index=>{
    if(index===1)return {role:'assistant',tool_calls:[{index:0,id:'A-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]};
    if(index===2){entered();await gate;}
    return {role:'assistant',content:'ENGINEERING original A result '+index};
  });
  const sessions=new SessionService('host',f.repos,f.agent,(input,context)=>f.app.runs.submitAgent(input,context),()=>f.app.runs.activeHandle,id=>f.app.runs.readInputControl(id),undefined,f.app.runs);
  try{
    const created=await sessions.create({expectedWorkspaceRevision:f.repos.readWorkspace().revision},{instanceId:'host',operationRef:'p13-create-B'});
    if(!created.ok)throw new Error('No B');const B=created.data.session.id;
    expect(await sessions.select({sessionId:1,expectedWorkspaceRevision:f.repos.readWorkspace().revision})).toMatchObject({ok:true});
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING A frozen ownership'),{instanceId:'host',operationRef:'p13-AB'});
    if(!result.ok||!result.data.runId)throw new Error('No Run');
    await childRequest;
    const child=f.db.query<{id:number;session_id:number;config_json:string},[]>("SELECT id,session_id,config_json FROM runs WHERE kind='child'").get()!,frozen=JSON.parse(child.config_json).subagent;
    expect(await sessions.select({sessionId:B,expectedWorkspaceRevision:f.repos.readWorkspace().revision})).toMatchObject({ok:true});
    const changed=normalizeRuntimeConfiguration(f.app.config);changed.runBudget.maxModelCalls=2;
    const settings=PublishedSettingsSchema.parse({...f.app.config,configVersion:'2',runtimeConfiguration:changed,...projectRuntimePolicies(changed)});
    expect(await f.app.prepareConfig('p13-B-settings',settings)).toMatchObject({prepared:true});f.app.commitConfig('p13-B-settings','2');
    for(const mode of ['send','steer'] as const)expect(await sessions.submit(SubmitInputSchema.parse({...f.request('ENGINEERING B '+mode),sessionId:B,clientSequence:1,mode,...(mode==='steer'?{targetRunId:result.data.runId}:{})}),{instanceId:'host',operationRef:'p13-B-'+mode})).toMatchObject({ok:false});
    expect((await sessions.list({}))).toMatchObject({ok:true,data:{sessions:expect.arrayContaining([expect.objectContaining({id:1}),expect.objectContaining({id:B})])}});
    expect(f.repos.listSessions({}).sessions.map(session=>session.id)).not.toContain(child.session_id);
    resume();await f.settle();expect(f.requests).toHaveLength(3);
    expect(JSON.parse(f.db.query<{config_json:string},[number]>('SELECT config_json FROM runs WHERE id=?').get(child.id)!.config_json).subagent).toEqual(frozen);
    expect(frozen).toMatchObject({parentRunId:result.data.runId,parentSessionId:1});expect(f.repos.readWorkspace().sessionId).toBe(B);
    for(const id of [result.data.runId,child.id]){
      const events=f.db.query<{sequence:number},[number]>('SELECT sequence FROM runtime_events WHERE run_id=? ORDER BY sequence').all(id);
      expect(events.length).toBeGreaterThan(0);expect(events.map(event=>event.sequence)).toEqual(events.map((_,index)=>index+1));
    }
    expect(f.db.query('SELECT id FROM session_inputs WHERE session_id=?').all(B)).toEqual([]);
  }finally{resume();await f.close();}
},20000);

test('p13 real child automatic compaction saves its own native summary and counts the actual request once',async()=>{
  const prompt={...p13AgentInput,prompt:'ENGINEERING child context '.repeat(100)};
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'compact-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(prompt)}}]}:
    index===2?{role:'assistant',tool_calls:[{index:0,id:'compact-read',type:'function',function:{name:'read_data_scope',arguments:'{}'}}]}:
    {role:'assistant',content:index===3?'ENGINEERING child reply '.repeat(100):index===4?'ENGINEERING child summary':'ENGINEERING parent answer'},false,
    index=>({prompt_tokens:index===3?32600:10,completion_tokens:2,total_tokens:index===3?32602:12}));
  const describe=f.agent.describe.bind(f.agent);f.agent.describe=resolved=>({...describe(resolved),compaction:{contract:'medclaw.compaction/v1',enabled:true,reserveTokens:256,keepRecentTokens:128}});
  try{
    const accepted=await f.app.runs.submitAgent(f.request('ENGINEERING child compaction'),{instanceId:'host',operationRef:'p13-actual-compaction'});expect(accepted.ok).toBe(true);await f.settle();expect(f.errors).toEqual([]);
    const child=f.db.query<{id:number;session_id:number;status:string;child_result_json:string},[]>("SELECT id,session_id,status,child_result_json FROM runs WHERE kind='child'").get()!;
    expect(child.status).toBe('completed');expect(f.requests).toHaveLength(5);expect(JSON.stringify(f.requests[3])).not.toContain('MedClaw trusted runtime feedback');
    expect(f.db.query('SELECT entry_type FROM memories WHERE session_id=? AND entry_type=?').all(child.session_id,'compaction')).toEqual([{entry_type:'compaction'}]);
    expect(f.db.query("SELECT run_id,session_id,input_id,kind,state FROM model_calls WHERE kind='compaction'").all()).toEqual([{run_id:child.id,session_id:child.session_id,input_id:null,kind:'compaction',state:'completed'}]);
    const compact=f.db.query<{version:number;entry:string},[]>("SELECT json_extract(model_json,'$.compaction.savedStorageVersion') version,json_extract(model_json,'$.compaction.nativeEntryId') entry FROM model_calls WHERE kind='compaction'").get()!;expect(compact.version).toBeGreaterThan(0);expect(f.db.query('SELECT native_entry_id FROM memories WHERE session_id=? AND entry_type=?').get(child.session_id,'compaction')).toEqual({native_entry_id:compact.entry});
    expect(f.repos.read({runId:1})).toMatchObject({kind:'one',run:{groupUsage:{parent:{modelCalls:2,inputTokens:20,outputTokens:4},children:{modelCalls:3,inputTokens:32620,outputTokens:6}}}});
    expect(f.db.query("SELECT run_id,session_id FROM runtime_events WHERE type='compaction_completed'").all()).toEqual([{run_id:child.id,session_id:child.session_id}]);expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(child.id)).toEqual([]);
  }finally{await f.close();}
},30000);

test('p13 child failed compaction retries its original owner marker before final save without another model request',async()=>{
  const prompt={...p13AgentInput,prompt:'ENGINEERING child context '.repeat(100)};
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'failed-compact-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(prompt)}}]}:
    index===2?{role:'assistant',tool_calls:[{index:0,id:'failed-compact-read',type:'function',function:{name:'read_data_scope',arguments:'{}'}}]}:
    index===4?Response.json({error:{message:'ENGINEERING summary provider failure'}},{status:500}):{role:'assistant',content:'ENGINEERING child reply '.repeat(100)},false,
    index=>({prompt_tokens:index===3?32600:10,completion_tokens:2,total_tokens:index===3?32602:12}));
  const describe=f.agent.describe.bind(f.agent);f.agent.describe=resolved=>({...describe(resolved),compaction:{contract:'medclaw.compaction/v1',enabled:true,reserveTokens:256,keepRecentTokens:128}});
  const finish=f.repos.finishAutoCompaction.bind(f.repos);let writes=0;
  f.repos.finishAutoCompaction=(...args)=>{if(++writes===1)throw new Error('ENGINEERING once storage failure');return finish(...args);};
  try{
    const accepted=await f.app.runs.submitAgent(f.request('ENGINEERING child failed compaction'),{instanceId:'host',operationRef:'p13-failed-compaction'});if(!accepted.ok||!accepted.data.runId)throw new Error('No Run');
    await Reflect.get(f.app.runs,'execution').task;expect(f.app.runs.busy).toBe(true);expect(f.requests).toHaveLength(4);
    expect(await f.app.runs.retrySave(accepted.data.runId)).toMatchObject({ok:true,data:{status:'failed',cleanup:{requiredPersistenceComplete:true,resourcesReleased:true}}});
    expect(f.app.runs.busy).toBe(false);expect(writes).toBe(2);expect(f.requests).toHaveLength(4);
    const child=f.db.query<{id:number;status:string;child_result_json:string},[]>("SELECT id,status,child_result_json FROM runs WHERE kind='child'").get()!;
    expect(child.child_result_json).not.toBeNull();expect(['failed','cancelled']).toContain(child.status);
    expect(f.db.query("SELECT run_id,json_extract(model_json,'$.compaction.operationEndedAt') ended,json_extract(model_json,'$.compaction.operationError.code') code FROM model_calls WHERE kind='compaction'").get()).toMatchObject({run_id:child.id,ended:expect.any(String),code:expect.any(String)});
  }finally{f.repos.finishAutoCompaction=finish;if(f.app.runs.activeHandle)await f.app.runs.retrySave(f.app.runs.activeHandle.runId);await f.close();}
},30000);

test('p13 original plugin failure after the actual child prompt cannot turn a completed SDK call into child success',async()=>{
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'plugin-error-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:'ENGINEERING SDK terminal output'});
  const open=Reflect.get(f.agent,'openManagedChild').bind(f.agent);
  Reflect.set(f.agent,'openManagedChild',async(...args:unknown[])=>{const session:AgentSession=await open(...args),prompt=session.prompt.bind(session);session.prompt=async(...input)=>{await prompt(...input);throw new Error('ENGINEERING plugin post-prompt failure');};return session;});
  try{
    const accepted=await f.app.runs.submitAgent(f.request('ENGINEERING original plugin failure'),{instanceId:'host',operationRef:'p13-plugin-failure'});expect(accepted.ok).toBe(true);await f.settle();
    const child=f.db.query<{id:number;status:string;child_result_json:string},[]>("SELECT id,status,child_result_json FROM runs WHERE kind='child'").get()!;
    expect(child.status).toBe('failed');expect(JSON.parse(child.child_result_json)).toMatchObject({outcome:'failed',gaps:expect.arrayContaining(['internal_error'])});
    expect(f.db.query("SELECT state FROM model_calls WHERE run_id=? AND kind='main'").get(child.id)).toEqual({state:'completed'});
    expect(f.db.query("SELECT status FROM tool_calls WHERE native_tool_call_id='plugin-error-Agent'").get()).toEqual({status:'failed'});expect(f.requests).toHaveLength(3);
  }finally{await f.close();}
},20000);

for(const reason of ['stop','length'] as const)test('p13 actual '+reason+' without a nonblank child result saves failure without adopting previous output',async()=>{
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'empty-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:
    index===2?new Response(`data: ${JSON.stringify({id:'empty-child',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:' '},finish_reason:reason}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}}):{role:'assistant',content:'ENGINEERING parent result'});
  try{
    const accepted=await f.app.runs.submitAgent(f.request('ENGINEERING empty child result'),{instanceId:'host',operationRef:'p13-empty-'+reason});expect(accepted.ok).toBe(true);await f.settle();
    const child=f.db.query<{id:number;status:string;child_result_json:string},[]>("SELECT id,status,child_result_json FROM runs WHERE kind='child'").get()!;
    expect(child.status).toBe('failed');expect(JSON.parse(child.child_result_json)).toMatchObject({outcome:'failed',gaps:expect.arrayContaining(['internal_error'])});
    expect(f.db.query("SELECT json_extract(model_json,'$.sdkStopReason') reason FROM model_calls WHERE run_id=? AND kind='main'").get(child.id)).toEqual({reason});
    expect(f.requests).toHaveLength(3);
  }finally{await f.close();}
},20000);

test('p13 actual length with child text preserves the useful result and its truncation evidence',async()=>{
  const text='ENGINEERING partial child result';
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'length-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:
    index===2?new Response(`data: ${JSON.stringify({id:'length-child',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:'length'}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}}):{role:'assistant',content:'ENGINEERING parent result'});
  try{
    const accepted=await f.app.runs.submitAgent(f.request('ENGINEERING truncated child result'),{instanceId:'host',operationRef:'p13-length-result'});expect(accepted.ok).toBe(true);await f.settle();
    const child=f.db.query<{status:string;child_result_json:string},[]>("SELECT status,child_result_json FROM runs WHERE kind='child'").get()!;
    expect(child.status).toBe('completed');expect(JSON.parse(child.child_result_json)).toMatchObject({outcome:'completed',text,truncated:true,gaps:expect.arrayContaining(['sdk_output_length'])});expect(f.requests).toHaveLength(3);
  }finally{await f.close();}
},20000);

test('p13 child history verification rejects damaged saved prefixes rather than treating child as pre-history',async()=>{
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'history-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:'ENGINEERING saved prefix'});
  try{
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING child history proof'),{instanceId:'host',operationRef:'p13-child-history-proof'});
    expect(result.ok).toBe(true);await f.settle();
    const child=f.db.query<{id:number;session_id:number},[]>("SELECT id,session_id FROM runs WHERE kind='child'").get()!;
    expect(f.repos.verifyPriorHistoryFacts(child.id)).toEqual({requiredPersistenceComplete:true,unconfirmedItems:[]});
    const rollback=new Error('ENGINEERING restore saved history');
    expect(()=>f.db.transaction(()=>{f.db.query('DELETE FROM memories WHERE session_id=?').run(child.session_id);
      expect(f.repos.verifyPriorHistoryFacts(child.id)).toEqual({requiredPersistenceComplete:false,unconfirmedItems:['history_persistence']});throw rollback;
    })()).toThrow(rollback);
  }finally{await f.close();}
},20000);

test('p13 parent cancellation records child cancellation and waits for its real SDK idle before releasing root',async()=>{
  let entered!:()=>void,resume!:()=>void;
  const childRequest=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
  const f=await agentRuntimeFixture(async index=>{
    if(index===1)return {role:'assistant',tool_calls:[{index:0,id:'stop-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]};
    entered();await gate;return {role:'assistant',content:'ENGINEERING cancelled child response'};
  });
  try{
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING cancel owned child'),{instanceId:'host',operationRef:'p13-child-cancel'});
    if(!result.ok||!result.data.runId)throw new Error('No Run');
    await childRequest;const task=Reflect.get(f.app.runs,'execution').task;
    await f.app.runs.cancel(result.data.runId);resume();await task;
    expect(f.requests).toHaveLength(2);expect(f.app.runs.busy).toBe(false);
    const child=f.db.query<{id:number;status:string;cancel_requested_at:string;cleanup_json:string},[]>("SELECT * FROM runs WHERE kind='child'").get()!;
    expect(child.status).toBe('cancelled');expect(child.cancel_requested_at).not.toBeNull();
    expect(JSON.parse(child.cleanup_json)).toMatchObject({stopConfirmed:true,requiredPersistenceComplete:true,resourcesReleased:true});
    expect(f.db.query('SELECT type FROM runtime_events WHERE run_id=? AND type=?').all(child.id,'run_cancel_requested')).toHaveLength(1);
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(child.id)).toEqual([]);
  }finally{resume();if(f.app.runs.activeHandle)await f.app.runs.retrySave(f.app.runs.activeHandle.runId);await f.close();}
},20000);

test('p13 unconfirmed child SDK idle keeps stop and root admission pending until the original wait settles',async()=>{
  let entered!:()=>void,resumeResponse!:()=>void,resumeIdle!:()=>void;
  const requested=new Promise<void>(resolve=>{entered=resolve;}),responseGate=new Promise<void>(resolve=>{resumeResponse=resolve;}),idleGate=new Promise<void>(resolve=>{resumeIdle=resolve;});
  const f=await agentRuntimeFixture(async index=>{if(index===1)return {role:'assistant',tool_calls:[{index:0,id:'idle-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]};entered();await responseGate;return {role:'assistant',content:'ENGINEERING aborted original child'};});
  try{
    const open=Reflect.get(f.agent,'openManagedChild').bind(f.agent);
    Reflect.set(f.agent,'openManagedChild',async(...args:unknown[])=>{const session:AgentSession=await open(...args),idle=session.waitForIdle.bind(session);session.waitForIdle=async()=>{await idle();await idleGate;};return session;});
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING wait for exact child idle'),{instanceId:'host',operationRef:'p13-idle-gap'});if(!result.ok||!result.data.runId)throw new Error('No Run');
    await requested;expect(await f.app.runs.cancel(result.data.runId)).toMatchObject({ok:true,data:{stopped:false}});expect(f.app.runs.stopPending).toBe(true);expect(f.app.runs.busy).toBe(true);
    expect(f.db.query("SELECT child_result_json FROM runs WHERE kind='child'").get()).toEqual({child_result_json:null});
    expect(await f.app.runs.submitAgent(f.request('ENGINEERING cannot start new root'),{instanceId:'host',operationRef:'p13-idle-denied'})).toMatchObject({ok:false});
    expect(await f.app.runs.retrySave(result.data.runId)).toMatchObject({ok:false,error:{code:'stop_unconfirmed'}});expect(f.requests).toHaveLength(2);
    resumeResponse();resumeIdle();await f.settle();expect(f.requests).toHaveLength(2);expect(f.app.runs.stopPending).toBe(false);
  }finally{resumeResponse();resumeIdle();await f.close();}
},20000);

test('p13 child cancellation committed before final wins without replaying the original child execution',async()=>{
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'race-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:'ENGINEERING original child finished'});
  const finalize=f.repos.finalizeChild.bind(f.repos);let injected=false;
  try{
    f.repos.finalizeChild=(id,fact)=>{if(!injected){injected=true;f.repos.requestCancel(id,new Date().toISOString());}return finalize(id,fact);};
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING cancellation transaction race'),{instanceId:'host',operationRef:'p13-cancel-commit'});
    if(!result.ok||!result.data.runId)throw new Error('No Run');
    await Reflect.get(f.app.runs,'execution').task;
    if(f.app.runs.busy)expect(await f.app.runs.retrySave(result.data.runId)).toMatchObject({ok:true});
    expect(f.app.runs.busy).toBe(false);
    expect(f.db.query("SELECT status,json_extract(child_result_json,'$.outcome') AS outcome FROM runs WHERE kind='child'").get()).toEqual({status:'cancelled',outcome:'cancelled'});
    expect(f.requests).toHaveLength(2);
  }finally{f.repos.finalizeChild=finalize;if(f.app.runs.activeHandle)await f.app.runs.retrySave(f.app.runs.activeHandle.runId);await f.close();}
},20000);

for(const read of ['none','read_query','read_query_evidence','list_query_evidence'] as const)test('p13 frozen parent Query references follow the actual child read '+read,async()=>{
  let parentQueryId=0,evidenceId=0;
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'frozen-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:
    index===2&&read!=='none'?{role:'assistant',tool_calls:[{index:0,id:'frozen-read',type:'function',function:{name:read,arguments:JSON.stringify(read==='read_query_evidence'?{evidenceId}:{queryId:parentQueryId})}}]}:{role:'assistant',content:'ENGINEERING verified original parent Query'});
  try{
    const seeded=seedWorkspaceQueries(f.db,f.repos);parentQueryId=seeded.current.id;evidenceId=seeded.evidenceId;
    f.repos.updateWorkspace({queryId:parentQueryId},f.repos.readWorkspace().revision,new Date().toISOString());const workspace=f.repos.readWorkspace();
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING frozen parent Query verification'),{instanceId:'host',operationRef:'p13-frozen-read'});
    expect(result.ok).toBe(true);await f.settle();expect(f.requests).toHaveLength(read==='none'?3:4);
    const child=f.db.query<{id:number;child_result_json:string},[]>("SELECT id,child_result_json FROM runs WHERE kind='child'").get()!;
    expect(JSON.parse(child.child_result_json).queryRefs).toEqual(read==='none'?[]:[{queryId:parentQueryId}]);
    expect(JSON.parse(child.child_result_json).evidenceIds).toEqual(['read_query_evidence','list_query_evidence'].includes(read)?[evidenceId]:[]);
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(child.id)).toEqual([]);
    expect(f.db.query('SELECT session_id,run_id FROM queries WHERE id=?').get(parentQueryId)).toEqual({session_id:1,run_id:10});
    expect(f.repos.readWorkspace()).toEqual(workspace);
  }finally{await f.close();}
},20000);

for(const denied of ['Agent','bash','extension_runtime_status','unfrozen_query','outside_batch'] as const)test('p13 actual child rejects '+denied+' and retains the observed gap',async()=>{
  let otherQueryId=0;
  const tool=denied==='unfrozen_query'?'read_query':denied==='outside_batch'?'query_current_devices':denied;
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'deny-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:
    index===2?{role:'assistant',tool_calls:[{index:0,id:'denied-child',type:'function',function:{name:tool,arguments:JSON.stringify(denied==='unfrozen_query'?{queryId:otherQueryId}:denied==='outside_batch'?{batchIds:[999],time:{start:'2026-10-04',endExclusive:'2026-10-05'}}:{})}}]}:
    {role:'assistant',content:'ENGINEERING stopped verification; no claim of completeness'},true);
  try{
    const seeded=seedWorkspaceQueries(f.db,f.repos);otherQueryId=seeded.secondQueryId;
    f.repos.updateWorkspace({queryId:seeded.current.id},f.repos.readWorkspace().revision,new Date().toISOString());
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING deny child capability expansion'),{instanceId:'host',operationRef:'p13-denied-'+denied});
    expect(result.ok).toBe(true);await f.settle();expect(f.requests).toHaveLength(4);
    const children=f.db.query<{id:number;child_result_json:string},[]>("SELECT id,child_result_json FROM runs WHERE kind='child'").all();expect(children).toHaveLength(1);
    expect(JSON.parse(children[0]!.child_result_json).queryRefs).toEqual([]);
    expect(JSON.parse(children[0]!.child_result_json).gaps).toContain('tool_result_error:denied-child');
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(children[0]!.id)).toEqual([]);
    const message=(f.requests[2]!.messages as {role:string;tool_call_id?:string}[]).find(value=>value.role==='tool'&&value.tool_call_id==='denied-child');expect(message).toBeDefined();
    if(['unfrozen_query','outside_batch'].includes(denied))expect(f.db.query('SELECT status,json_extract(error_json,\'$.code\') AS code FROM tool_calls WHERE run_id=? AND native_tool_call_id=?').get(children[0]!.id,'denied-child')).toEqual({status:'failed',code:'access_denied'});
    for(const name of ['Agent','bash','extension_runtime_status'])expect((f.requests[1]!.tools as {function:{name:string}}[]).map(value=>value.function.name)).not.toContain(name);
  }finally{await f.close();}
},20000);

test('p13 oversized child result rejects the whole final transaction without replacing its original reply',async()=>{
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'size-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:'ENGINEERING bounded child'});
  const finalize=f.repos.finalizeChild.bind(f.repos);let checked=false;
  try{
    f.repos.finalizeChild=(id,fact)=>{
      const originalReply={...fact.childResult.originalReply,content:[{type:'text' as const,text:'x'.repeat(300000)}]},before=f.db.query('SELECT * FROM memories WHERE run_id=?').all(id);
      expect(()=>finalize(id,{...fact,childResult:{...fact.childResult,originalReply}})).toThrow('tool_result_too_large');
      expect(f.db.query('SELECT * FROM memories WHERE run_id=?').all(id)).toEqual(before);
      expect(f.db.query('SELECT child_result_json,status FROM runs WHERE id=?').get(id)).toEqual({child_result_json:null,status:'running'});checked=true;
      return finalize(id,fact);
    };
    expect(await f.app.runs.submitAgent(f.request('ENGINEERING reject oversized storage envelope'),{instanceId:'host',operationRef:'p13-size'})).toMatchObject({ok:true});
    await f.settle();expect(checked).toBe(true);expect(f.requests).toHaveLength(3);
  }finally{f.repos.finalizeChild=finalize;await f.close();}
},20000);

test('p13 committed child survives parent Agent execution-row save failure and retry records original facts only',async()=>{
  let reject=true;
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'row-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:'ENGINEERING committed before parent save'});
  const transition=f.toolStore.transition.bind(f.toolStore);
  try{
    f.toolStore.transition=(...args)=>{if(reject&&args[2]==='succeeded'&&f.db.query<{tool_name:string},[number]>('SELECT tool_name FROM tool_calls WHERE id=?').get(args[0])?.tool_name==='Agent')throw new Error('ENGINEERING parent ToolCall save fault');return transition(...args);};
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING parent original ToolCall save'),{instanceId:'host',operationRef:'p13-parent-save-gap'});
    if(!result.ok||!result.data.runId)throw new Error('No Run');
    await Reflect.get(f.app.runs,'execution').task;
    expect(f.app.runs.busy).toBe(true);expect(f.requests).toHaveLength(2);
    const saved=f.db.query<{child_result_json:string},[]>("SELECT child_result_json FROM runs WHERE kind='child'").get()!.child_result_json;
    expect(JSON.parse(saved).outcome).toBe('completed');
    expect(await f.app.runs.retrySave(result.data.runId)).toMatchObject({ok:false});
    reject=false;
    expect(await f.app.runs.retrySave(result.data.runId)).toMatchObject({ok:true,data:{status:'failed'}});
    expect(f.app.runs.busy).toBe(false);expect(f.requests).toHaveLength(2);
    expect(f.db.query("SELECT child_result_json FROM runs WHERE kind='child'").get()).toEqual({child_result_json:saved});
    const origin=f.db.query<{status:string;result_json:string;delivery_json:string},[]>("SELECT status,result_json,delivery_json FROM tool_calls WHERE tool_name='Agent'").get()!;
    expect(origin.status).toBe('succeeded');expect(JSON.parse(origin.result_json)).toEqual(JSON.parse(saved).originalReply);
    expect(JSON.parse(origin.delivery_json)).toMatchObject({sdkReturned:true,message:{isError:true},error:{code:'tool_delivery_failed'}});
  }finally{reject=false;f.toolStore.transition=transition;if(f.app.runs.activeHandle)await f.app.runs.retrySave(f.app.runs.activeHandle.runId);await f.close();}
},20000);

test('p13 child ToolCall persistence failure immediately closes the original root admission',async()=>{
  let reject=true;
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'save-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:
    index===2?{role:'assistant',tool_calls:[{index:0,id:'save-child-tool',type:'function',function:{name:'read_data_scope',arguments:'{}'}}]}:{role:'assistant',content:'ENGINEERING must not continue across save failure'});
  const transition=f.toolStore.transition.bind(f.toolStore);
  try{
    f.toolStore.transition=(...args)=>{if(reject&&args[2]==='succeeded'&&f.db.query<{native_tool_call_id:string},[number]>('SELECT native_tool_call_id FROM tool_calls WHERE id=?').get(args[0])?.native_tool_call_id==='save-child-tool')throw new Error('ENGINEERING child ToolCall save fault');return transition(...args);};
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING child tool save gate'),{instanceId:'host',operationRef:'p13-child-tool-save'});if(!result.ok||!result.data.runId)throw new Error('No Run');
    await Reflect.get(f.app.runs,'execution').task;expect(f.requests).toHaveLength(2);expect(f.app.runs.busy).toBe(true);
    expect(await f.app.runs.retrySave(result.data.runId)).toMatchObject({ok:false});reject=false;
    expect(await f.app.runs.retrySave(result.data.runId)).toMatchObject({ok:true});expect(f.app.runs.busy).toBe(false);expect(f.requests).toHaveLength(2);
    expect(f.db.query("SELECT status,json_extract(result_json,'$.scope.readOnly') AS read_only FROM tool_calls WHERE native_tool_call_id='save-child-tool'").get()).toEqual({status:'succeeded',read_only:1});
  }finally{reject=false;f.toolStore.transition=transition;if(f.app.runs.activeHandle)await f.app.runs.retrySave(f.app.runs.activeHandle.runId);await f.close();}
},20000);

test('p13 parent manager teardown failure holds root after the child is already released',async()=>{
  let reject=true;
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'teardown-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:'ENGINEERING teardown '+index});
  const prepare=Reflect.get(f.agent,'prepare').bind(f.agent);
  try{
    Reflect.set(f.agent,'prepare',async(...args:unknown[])=>{await prepare(...args);const subagent=Reflect.get(args[0] as object,'execution').subagent,close=subagent.close;subagent.close=async()=>{if(reject)throw new Error('ENGINEERING manager teardown fault');await close();};});
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING manager cleanup'),{instanceId:'host',operationRef:'p13-manager-cleanup'});
    if(!result.ok||!result.data.runId)throw new Error('No Run');
    await Reflect.get(f.app.runs,'execution').task;
    expect(f.app.runs.busy).toBe(true);expect(f.requests).toHaveLength(3);
    expect(await f.app.runs.retrySave(result.data.runId)).toMatchObject({ok:false});
    reject=false;
    expect(await f.app.runs.retrySave(result.data.runId)).toMatchObject({ok:true,data:{cleanup:{resourcesReleased:true}}});
    expect(f.app.runs.busy).toBe(false);expect(f.requests).toHaveLength(3);
  }finally{reject=false;if(f.app.runs.activeHandle)await f.app.runs.retrySave(f.app.runs.activeHandle.runId);Reflect.set(f.agent,'prepare',prepare);await f.close();}
},20000);

test('p13 cold recovery retains an observed child final whose precommit read failed after the parent tool settled',async()=>{
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'cold-read-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:'ENGINEERING child final before read failure'});
  let settled=false,failures=0;const settle=Reflect.get(f.agent,'settleManagedChild').bind(f.agent),read=f.repos.read.bind(f.repos);
  Reflect.set(f.agent,'settleManagedChild',async(...args:unknown[])=>{const result=await settle(...args);settled=!!result;return result;});
  f.repos.read=input=>{if(settled&&'runId' in input&&input.runId===2&&failures++===0)throw safeError('storage_read_failed');return read(input);};
  try{
    const accepted=await f.app.runs.submitAgent(f.request('ENGINEERING retain lost child final'),{instanceId:'host',operationRef:'p13-cold-precommit-read'});if(!accepted.ok||!accepted.data.runId)throw new Error('No Run');
    await Reflect.get(f.app.runs,'execution').task;expect(settled).toBe(true);expect(f.requests).toHaveLength(2);
    const cold=new Application('cold',f.app.config,f.runtime,f.repos,async(_context,action)=>action(),()=>{throw new Error('No recovery model call');},()=>{});
    cold.runs.recoverInterrupted(true);expect(cold.persistencePending).toBe(true);expect(cold.busy).toBe(true);
    expect(await cold.runs.retrySave(accepted.data.runId)).toMatchObject({ok:false,error:{code:'run_save_unavailable'}});
    expect(f.db.query("SELECT child_result_json FROM runs WHERE kind='child'").get()).toEqual({child_result_json:null});expect(f.requests).toHaveLength(2);
  }finally{f.repos.read=read;await expect(f.close()).rejects.toThrow('storage_write_failed');}
},20000);

for(const boundary of ['final','release'] as const)test('p13 child '+boundary+' save gap holds the root and retries only original persistence',async()=>{
  let reject=true;
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'gap-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:'ENGINEERING save gap'});
  const finalize=f.repos.finalizeChild.bind(f.repos),cleanup=f.repos.saveRunCleanup.bind(f.repos);
  try{
    if(boundary==='final')f.repos.finalizeChild=(...args)=>{if(reject)throw new Error('ENGINEERING child final fault');return finalize(...args);};
    else f.repos.saveRunCleanup=(id,fact)=>{if(reject&&fact.resourcesReleased&&f.db.query<{kind:string},[number]>('SELECT kind FROM runs WHERE id=?').get(id)?.kind==='child')throw new Error('ENGINEERING child release fault');return cleanup(id,fact);};
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING original child persistence'),{instanceId:'host',operationRef:'p13-gap-'+boundary});
    if(!result.ok||!result.data.runId)throw new Error('No Run');
    await Reflect.get(f.app.runs,'execution').task;
    expect(f.app.runs.busy).toBe(true);expect(f.requests).toHaveLength(2);
    expect(await f.app.runs.retrySave(result.data.runId)).toMatchObject({ok:false});
    expect(await f.app.runs.submitAgent(f.request('ENGINEERING blocked next root'),{instanceId:'host',operationRef:'p13-blocked-'+boundary})).toMatchObject({ok:false});
    reject=false;
    expect(await f.app.runs.retrySave(result.data.runId)).toMatchObject({ok:true,data:{status:'failed',cleanup:{stopConfirmed:true,requiredPersistenceComplete:true,resourcesReleased:true}}});
    expect(f.app.runs.busy).toBe(false);expect(f.requests).toHaveLength(2);
    expect(f.db.query("SELECT status,json_extract(child_result_json,'$.outcome') AS outcome,json_extract(cleanup_json,'$.resourcesReleased') AS released FROM runs WHERE kind='child'").get()).toEqual({status:'completed',outcome:'completed',released:1});
    expect(f.db.query("SELECT id FROM runs WHERE kind='child'").all()).toHaveLength(1);
  }finally{reject=false;f.repos.finalizeChild=finalize;f.repos.saveRunCleanup=cleanup;if(f.app.runs.activeHandle)await f.app.runs.retrySave(f.app.runs.activeHandle.runId);await f.close();}
},20000);

for(const committed of [false,true])test('p13 unknown child registration reconciles exact saved identity before storage-only cleanup '+committed,async()=>{
  let unreadable=true;
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'unknown-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:'ENGINEERING unknown registration'});
  const register=f.repos.registerChild.bind(f.repos),find=f.repos.findChild.bind(f.repos);
  try{
    f.repos.registerChild=input=>{if(committed)register(input);throw new Error('ENGINEERING registration return unknown');};
    f.repos.findChild=(...args)=>{if(unreadable)throw new Error('ENGINEERING read unavailable');return find(...args);};
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING reconcile child identity'),{instanceId:'host',operationRef:'p13-registration-unknown-'+committed});
    if(!result.ok||!result.data.runId)throw new Error('No Run');
    await Reflect.get(f.app.runs,'execution').task;
    expect(f.app.runs.busy).toBe(true);expect(f.requests).toHaveLength(1);
    expect(await f.app.runs.retrySave(result.data.runId)).toMatchObject({ok:false});
    unreadable=false;
    expect(await f.app.runs.retrySave(result.data.runId)).toMatchObject({ok:true,data:{status:'failed',cleanup:{resourcesReleased:true,requiredPersistenceComplete:true}}});
    expect(f.app.runs.busy).toBe(false);expect(f.requests).toHaveLength(1);
    const children=f.db.query<{status:string;child_result_json:string},[]>("SELECT status,child_result_json FROM runs WHERE kind='child'").all();
    expect(children).toHaveLength(committed?1:0);
    if(committed){expect(children[0]!.status).toBe('failed');expect(JSON.parse(children[0]!.child_result_json)).toMatchObject({outcome:'failed',queryRefs:[]});}
  }finally{unreadable=false;f.repos.registerChild=register;f.repos.findChild=find;if(f.app.runs.activeHandle)await f.app.runs.retrySave(f.app.runs.activeHandle.runId);await f.close();}
},20000);

test('p13 known child registration rollback releases the real plugin manager without inventing a child',async()=>{
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'rollback-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:'ENGINEERING acknowledged binding failure'});
  const register=f.repos.registerChild.bind(f.repos);
  try{
    f.repos.registerChild=()=>{throw new Error('ENGINEERING known registration rollback');};
    const result=await f.app.runs.submitAgent(f.request('ENGINEERING binding rollback'),{instanceId:'host',operationRef:'p13-binding-rollback'});
    if(!result.ok||!result.data.runId)throw new Error('No Run');
    await Reflect.get(f.app.runs,'execution').task;
    expect(f.app.runs.busy).toBe(false);expect(f.requests).toHaveLength(1);
    expect(f.db.query("SELECT id FROM runs WHERE kind='child'").all()).toEqual([]);
    expect(f.db.query("SELECT status FROM tool_calls WHERE tool_name='Agent'").get()).toEqual({status:'failed'});
  }finally{f.repos.registerChild=register;await f.close();}
},20000);

test('p13 product child factory binds SQLite identity, explicit SDK and business tools before the first real HTTP request', async () => {
  const root=mkdtempSync(join(tmpdir(),'medclaw-p13-factory-')),db=openDatabase(join(root,'app.sqlite')),history=sqliteHistory(db);
  const repos=new Repositories(db,undefined,undefined,undefined,history.store),contexts=new SqliteContextStore(db),tools=new SqliteToolStore(db);
  const controller=new AbortController(),errors:unknown[]=[],requests:unknown[]=[];let owned=new Map<string,unknown>();
  let child:AgentSession|undefined,childId:number|undefined;const nativePath=join(root,'sdk-read.txt');writeFileSync(nativePath,'ENGINEERING native read');
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const payload=await request.json();requests.push(payload);
    const row=db.query<{id:number;session_id:number;scope_json:string},[]>("SELECT id,session_id,scope_json FROM runs WHERE kind='child'").get()!;
    expect(row).toBeDefined();expect(owned.size).toBe(1);expect(row.id).not.toBe(1);childId=row.id;
    expect(db.query('SELECT run_id,input_id FROM model_calls WHERE run_id=?').get(row.id)).toEqual({run_id:row.id,input_id:null});
    expect(db.query('SELECT run_id,input_id FROM context_snapshots WHERE run_id=?').get(row.id)).toEqual({run_id:row.id,input_id:null});
    expect(db.query('SELECT id FROM session_inputs WHERE session_id=?').all(row.session_id)).toEqual([]);
    const delta=requests.length===1?{role:'assistant',tool_calls:[{index:0,id:'child-business',type:'function',function:{name:'read_data_scope',arguments:'{}'}}]}:requests.length===2?{role:'assistant',tool_calls:[{index:0,id:'child-native-read',type:'function',function:{name:'read',arguments:JSON.stringify({path:nativePath})}}]}:{role:'assistant',content:'ENGINEERING verified child'};
    return new Response(`data: ${JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta,finish_reason:'tool_calls' in delta?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  }});
  try {
    const credentials=new InMemoryCredentialStore();await credentials.modify('p13-fixture',async()=>({type:'api_key',key:'fixture'}));
    const runtime=await PiModelRuntime.create({credentials,modelsStore:new InMemoryModelsStore()});
    await runtime.installCustom([{providerId:'p13-fixture',name:'Fixture',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.port}/v1`,models:[{id:'fixture',name:'Fixture',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,outputLimitConfirmed:true,pricingKnown:false,cost:null}]}]);
    const resolved=await runtime.resolve({provider:'p13-fixture',modelId:'fixture',expectedConfigVersion:'1'},'1',null,{timeoutMs:15000,maxRetries:0,maxRetryDelayMs:2000});
    const f=acceptContextInput(db,{repositories:repos,model:resolved.selection,toolNames:['Agent','read','read_data_scope']});
    db.query("UPDATE runs SET config_json=json_set(config_json,'$.policy',json(?)) WHERE id=?").run(JSON.stringify(resolved.policy),f.input.runId);
    const snapshot=contexts.save(contexts.select(f.input));
    repos.startCall(f.input.runId,'parent-fixture','main',contextAt,{inputId:f.input.inputId,snapshotId:snapshot.id});
    const context={runId:f.input.runId,sessionId:f.input.sessionId,nativeToolCallId:'original-Agent',scope:f.input.scope,referenceDate:f.request.referenceDate,timezone:f.request.timezone,signal:controller.signal,
      modelCallId:'parent-fixture',contextSnapshotId:snapshot.id,workspaceContext:f.input.workspaceContext,workspaceInputId:f.input.inputId,basedOnQueryId:null,workspaceRevision:f.input.workspaceContext.revision};
    tools.request({name:'Agent',version:'fixture',effect:'READ',executionMode:'sequential'},p13AgentInput,context);
    const catalog=new CatalogService(new SqliteCatalogStore(db)),registry=new ToolRegistry([createReadDataScopeTool({catalog})]),recorder=new ToolRecorder(tools,error=>errors.push(error));
    const agent=new PiAgentRuntime(runtime,root,history,{registry,recorder,executor:new ToolExecutor(registry,recorder)},new ContextService(contexts,{inspectManagedImport:async()=>({status:'valid'})}));
    const input={runId:f.input.runId,sessionId:f.input.sessionId,inputId:f.input.inputId,text:f.request.text,resolved,agentOptions:agent.describe(resolved),instanceId:'host',scope:f.input.scope,referenceDate:f.request.referenceDate,timezone:f.request.timezone,signal:controller.signal,deadlineAt:performance.now()+15000};
    const control=new RunControl({...input,totalTimeoutMs:15000});
    const settings=PublishedSettingsSchema.parse({schemaVersion:'medclaw.settings/p1-v1',configVersion:'1',model:null,customProviders:[],credentialRefs:{},requestPolicy:resolved.policy,previous:null,rollbackFromVersion:null});
    const core=new RuntimeService('host',()=>settings,runtime,repos,(_context,action)=>action(),(runId,kind,at,context)=>new ModelCallRecorder(repos,runId,kind,at,context),()=>{},()=>{},agent,()=>false);
    // Component probe: the parent original call/snapshot is a persisted engineering fixture; no claim of the complete parent plugin loop.
    const rootExecution=Reflect.get(core,'begin').call(core,{runId:f.input.runId,sessionId:f.input.sessionId,kind:'agent'},'factory-probe');
    const callbacks=Reflect.get(core,'childCallbacks').call(core,rootExecution);owned=rootExecution.children;
    const parent={input,control,callbacks:{fatal:(error:unknown)=>errors.push(error),subagents:callbacks},children:new Map()};
    const open=Reflect.get(agent,'openManagedChild');expect(typeof open).toBe('function');
    db.exec("CREATE TEMP TRIGGER fail_child_registration BEFORE INSERT ON runs WHEN NEW.kind='child' BEGIN SELECT RAISE(ABORT,'ENGINEERING registration failure'); END;");
    await expect(open.call(agent,parent,context,{pluginAgentId:'failed-factory-fixture',prompt:p13AgentInput.prompt,signal:controller.signal})).rejects.toMatchObject({code:'storage_write_failed'});
    expect(requests).toHaveLength(0);expect(owned.size).toBe(0);expect(parent.children.size).toBe(0);
    expect(db.query("SELECT id FROM runs WHERE kind='child'").all()).toEqual([]);expect(db.query("SELECT id FROM sessions WHERE kind='child'").all()).toEqual([]);
    db.exec('DROP TRIGGER fail_child_registration');
    // Lost return after COMMIT: reconcile by exact original identity and frozen initial history, never by recency.
    const register=repos.registerChild.bind(repos);let lost=true;
    repos.registerChild=request=>{const identity=register(request);if(lost){lost=false;throw new Error('ENGINEERING lost registration return');}return identity;};
    const pending=open.call(agent,parent,context,{pluginAgentId:'real-factory-fixture',prompt:p13AgentInput.prompt,signal:controller.signal});
    expect(requests).toHaveLength(0);child=await pending;
    expect(child!.getAllTools().map(t=>t.name).sort()).toEqual(['read','read_data_scope']);
    expect(child!.getActiveToolNames().sort()).toEqual(['read','read_data_scope']);
    const workspace=repos.readWorkspace();await child!.prompt(p13AgentInput.prompt,{expandPromptTemplates:false});
    const observed=await Reflect.get(agent,'settleManagedChild').call(agent,parent,'real-factory-fixture');
    expect(errors).toEqual([]);expect(requests).toHaveLength(3);expect(observed.identity.childRunId).toBe(childId);expect(observed.calls).toHaveLength(3);
    rootExecution.stopped=true;
    expect(Reflect.get(core,'cleanup').call(core,rootExecution,true)).toMatchObject({stopConfirmed:false,requiredPersistenceComplete:false,resourcesReleased:false,unconfirmedItems:expect.arrayContaining(['child_cleanup'])});
    expect(core.activeHandle?.runId).toBe(f.input.runId);
    expect(db.query('SELECT t.run_id,t.session_id,s.input_id FROM tool_calls t JOIN context_snapshots s ON s.id=t.context_snapshot_id WHERE t.native_tool_call_id=?').get('child-business')).toEqual({run_id:childId,session_id:observed.identity.childSessionId,input_id:null});
    expect(db.query('SELECT run_id,session_id,tool_version FROM tool_calls WHERE native_tool_call_id=?').get('child-native-read')).toEqual({run_id:childId,session_id:observed.identity.childSessionId,tool_version:'0.87.1'});
    expect(repos.readWorkspace()).toEqual(workspace);expect(observed.history.sessionId).toBe(observed.identity.childSessionId);
    const reply={content:[{type:'text' as const,text:'ENGINEERING factory result'}],details:{fixture:true}};
    const state=()=>[['sessions','id',observed.identity.childSessionId],['runs','id',childId],['model_calls','run_id',childId],['memories','session_id',observed.identity.childSessionId],['runtime_events','run_id',childId]]
      .map(([table,column,value])=>db.query(`SELECT * FROM ${table} WHERE ${column}=? ORDER BY id`).all(value as number));
    const prefix=state();
    for(const [table,operation,condition]of [['memories','INSERT',`NEW.run_id=${childId}`],['sessions','UPDATE',`NEW.id=${observed.identity.childSessionId}`],['model_calls','UPDATE',`NEW.run_id=${childId}`],['runs','UPDATE',`NEW.id=${childId}`],['runtime_events','INSERT',`NEW.run_id=${childId} AND NEW.type='run_completed'`]]) {
      db.exec(`CREATE TEMP TRIGGER fail_child_final BEFORE ${operation} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'ENGINEERING final failure'); END;`);
      expect(()=>callbacks.finish(observed.identity,observed,reply)).toThrow();expect(state()).toEqual(prefix);
      expect(core.activeHandle?.runId).toBe(f.input.runId);expect(owned.size).toBe(1);expect(requests).toHaveLength(3);
      db.exec('DROP TRIGGER fail_child_final');
    }
    const finalize=repos.finalizeChild.bind(repos);let lostFinal=true;
    repos.finalizeChild=(runId,fact)=>{const result=finalize(runId,fact);if(lostFinal){lostFinal=false;throw new Error('ENGINEERING lost final return');}return result;};
    const committed=callbacks.finish(observed.identity,observed,reply);
    expect(callbacks.finish(observed.identity,observed,reply)).toEqual(committed);expect(requests).toHaveLength(3);
    expect(db.query("SELECT id FROM runtime_events WHERE run_id=? AND type='run_completed'").all(childId!)).toHaveLength(1);
    expect(repos.read({runId:childId!})).toMatchObject({kind:'one',run:{status:'completed',answerRef:null,childResult:{storageVersion:committed.result.storageVersion}}});
    expect(db.query('SELECT id FROM answers WHERE run_id=?').all(childId!)).toEqual([]);
    agent.acknowledgeHistorySaved(observed.history,committed.result.storageVersion);
    let lateError:unknown;
    try{history.commitSync({...observed.history,expectedStorageVersion:committed.result.storageVersion,newEntries:[{id:'late',type:'label',parentId:observed.history.activeLeafId,timestamp:new Date().toISOString(),targetId:observed.history.activeLeafId,label:'ENGINEERING late'}],activeLeafId:'late'});}catch(error){lateError=error;}
    expect(lateError).toMatchObject({code:'state_conflict'});
    await Reflect.get(agent,'releaseManagedChild').call(agent,parent,'real-factory-fixture');expect(owned.size).toBe(0);
    control.dispose();
  } finally {await child?.abort();await child?.waitForIdle();child?.dispose();server.stop(true);db.close();rmSync(root,{recursive:true,force:true});}
},20000);

function frozenFixture(f: ReturnType<typeof acceptContextInput>, origin: { id: number; nativeToolCallId: string }, snapshotId: number,
  native: ReturnType<typeof memoryNativeFixture>, childRunId: number, childSessionId: number, pluginAgentId = 'plugin-child') {
  return FrozenChildConfigSchema.parse({
    contract: 'medclaw.subagent/v1', instanceId: 'host', parentRunId: f.input.runId, parentSessionId: f.input.sessionId,
    originToolCallId: origin.id, originNativeToolCallId: origin.nativeToolCallId, pluginAgentId, nativeSessionId: native.header.id, childRunId, childSessionId,
    originSnapshotId: snapshotId, parentInputId: f.input.inputId,  pluginVersion: '0.19.0', pluginGitHead: '4f572eaa04c09d3dbc16e4a5f13a16b295e84e14', pluginIntegrity: 'sha512-fixture', patchHash: 'b'.repeat(64),
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
    const delegationSource={parentRunId:f.input.runId,originToolCallId:origin.id,parentSnapshotId:snapshot.id,parentInputId:f.input.inputId,nativeEntryId:promptEntry.id};
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
    expect(SCHEMA_VERSION).toBe(16);
    expect(db.query('SELECT version FROM schema_migrations').all()).toHaveLength(16);
    for (const name of tables.filter(n => n !== 'schema_migrations')) {
      const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM ${name} ORDER BY id`).all();
      expect(rows.map((row, i) => Object.fromEntries(Object.keys(retainedFields(before.get(name)![i]!)).map(key => [key, row[key]])))).toEqual(before.get(name)!.map(retainedFields));
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
    expect(children.kind === 'recent' && children.runs).toMatchObject([{ id: childRunId, kind: 'child', parentRunId: f.input.runId, inputId: null, answerRef: null }]);
    if(children.kind==='recent')expect(children.runs[0]).not.toHaveProperty('childResult');
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
      frozen: { ...configuration, pluginAgentId: 'plugin-child-3', nativeSessionId: thirdNative.header.id, originToolCallId: thirdOrigin.id, originNativeToolCallId: thirdOrigin.nativeToolCallId} };
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
       nativeEntryId: 'child-prompt' };
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
          verifiedNativeRefs: [] } });
    expect(contexts.read({ callId: 'child-model-1' })).toMatchObject({ kind: 'snapshot', snapshot: { inputId: null, delegationSource }, evidence: 'saved', deliveries: [childDelivery] });
    const childContext = { runId: identity.childRunId, sessionId: identity.childSessionId, nativeToolCallId: 'parent-Agent', scope: registration.frozen.scope,
      referenceDate: f.request.referenceDate, timezone: f.request.timezone, signal: controller.signal, contextSnapshotId: childSnapshot.id, modelCallId: 'child-model-1',
      workspaceContext: null, workspaceInputId: null, basedOnQueryId: null, delegationSource };
    const childTool = tools.request({ name: 'read', version: 'fixture', effect: 'READ', executionMode: 'sequential' }, { path: 'fixture' }, childContext);
    expect(childTool).toMatchObject({ runId: identity.childRunId, sessionId: identity.childSessionId, nativeToolCallId: 'parent-Agent', contextSnapshotId: childSnapshot.id });
    expect(() => tools.assertContext({ ...childContext, scope: { ...childContext.scope, batchIds: [999] } })).toThrow('access_denied');
    expect(() => tools.assertContext({ ...childContext, delegationSource: { ...delegationSource, originToolCallId: nextOrigin.id } })).toThrow('access_denied');
    expect(() => tools.assertContext({ ...childContext, workspaceContext: f.input.workspaceContext })).toThrow();
    const nativeDefinitions=createPiNativeTools(root,new ToolRecorder(tools),()=>childContext,{},undefined,undefined,['read']);
    expect(nativeDefinitions.definitions.map(tool=>tool.name)).toEqual(['read']);
    expect(() => createPiNativeTools(root,new ToolRecorder(tools),()=>childContext,{},undefined,undefined,['read','read'])).toThrow();
    expect(() => createPiNativeTools(root,new ToolRecorder(tools),()=>childContext,{},undefined,undefined,['Agent'])).toThrow();
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
