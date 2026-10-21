import { readIntentStageMessage } from '../fixtures/p14-intent';
import { expect, test } from 'bun:test';
import { RunControl } from '../../packages/core/src/runtime/run-control';
import { RUNTIME_CONFIG } from '../../packages/contracts/src/runtime-config';
import { agentRuntimeFixture } from '../fixtures/agent-runtime';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { OllamaIntentClient } from '../../packages/intent-ollama/src/index';
import { disabledIntentModel, resolvedIntent, productIntent } from '../fixtures/p14-intent';
import { CLASSIFY_PROMPT } from '../../packages/core/src/intent/prompts/classify';
import { VERIFY_PROMPT } from '../../packages/core/src/intent/prompts/verify';
import { INTENT_TAXONOMY, IntentResultSchema, type IntentResult, type IntentStageInput, type IntentItem } from '../../packages/contracts/src/intent';
import { IntentModelConfigurationSchema } from '../../packages/contracts/src/model';
import { safeError } from '../../packages/contracts/src/error';
import { SessionService } from '../../packages/core/src/session/session-service';
import { SqliteWriteTransactions } from '../../packages/storage/src/write-transactions';
import { CONTEXT_MATERIAL_PREFIX } from '../../packages/contracts/src/context';
import { contextMessageText } from '../../packages/runtime-pi/src/messages';

for (const limit of [2, 3]) {
  test(`p14 Pi execution retains the root control after two engineering intent admissions with limit ${limit}`, async () => {
    const f = await agentRuntimeFixture();
    const execute = f.agent.execute.bind(f.agent); let control: RunControl | undefined;
    f.agent.execute = async (input, callbacks) => {
      control = new RunControl({ runId: input.runId, scope: input.scope!, signal: input.signal, deadlineAt: input.deadlineAt,
        runtimeConfiguration: { ...RUNTIME_CONFIG, runBudget: { ...RUNTIME_CONFIG.runBudget, maxModelCalls: limit } } });
      // Engineering budget admissions isolate control handoff; these are not actual Ollama calls or quality evidence.
      control.admitModelCall(); control.admitModelCall();
      return execute({ ...input, runControl: control }, callbacks);
    };
    try {
      const accepted = await f.app.runs.submitAgent(f.request('ENGINEERING shared root budget'), { instanceId: 'host', operationRef: `shared-root-${limit}` });
      expect(accepted.ok).toBe(true); if (!accepted.ok) throw accepted.error;
      await f.settle();
      expect(f.requests).toHaveLength(limit === 2 ? 0 : 1);
      const result = f.repos.read({ runId: accepted.data.runId! });
      expect(result.kind).toBe('one'); if (result.kind !== 'one' || !result.run) throw new Error('Missing actual root');
      expect(result.run.status).toBe(limit === 2 ? 'failed' : 'completed');
      expect(result.run.cleanup?.budgetSummary?.modelCalls).toBe(limit);
      expect(control!.summary().modelCalls).toBe(limit);
    } finally { await f.close(); }
  });
}

async function routedFixture(mode: 'rule' | 'classify' | 'verify' | 'http' | 'json' | 'ood' | 'unsupported' | 'missing' | 'stop_classify' | 'multi',options?:{prediction?:IntentResult;intents?:IntentItem[];respond?:Parameters<typeof agentRuntimeFixture>[0];allowMain?:boolean;subagents?:boolean}) {
  let chats = 0;const intentRequests:IntentStageInput[]=[];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/version') return Response.json({ version: 'ENGINEERING' });
    if (path === '/api/tags') return Response.json({ models: [{ name: 'qwen3.5:0.8b', digest: 'a'.repeat(64) }] });
    if (path === '/api/show') return Response.json({ details: { family: 'qwen35', parameter_size: '752.39M', quantization_level: 'Q8_0' } });
    if (path !== '/api/chat') return new Response('Unexpected engineering endpoint', { status: 404 });
    chats++;
    if(mode==='http')return new Response('ENGINEERING failure',{status:503});
    const body = await request.json() as { messages: { content: string }[] }, stage = readIntentStageMessage(body.messages[1]!.content) as IntentStageInput;
    intentRequests.push(stage);
    let result:unknown = { ...resolvedIntent(), intents: stage.stage === 'verify' ? stage.review!.candidates[0]!.intents : [{ ...productIntent(),
      ...(mode === 'verify' ? { l0: 'DATA_OPERATIONS' } : {}), slots: { ...productIntent().slots, region: '浙江', time: { start: '2026-10-04', endExclusive: '2026-10-05' } } }] };
    if(mode==='ood'||mode==='unsupported')result={contract:'medclaw.intent/v2',status:mode==='ood'?'OUT_OF_SCOPE':'UNSUPPORTED_DATA',intents:[],candidateIntents:[],clarification:null};
    if(mode==='missing')result={...resolvedIntent(),status:'NEED_PARAMETERS',intents:[{...productIntent(),l0:'CHANGE_MONITOR',l1:'RECORD_CHANGE',l2:'NEW_RECORDS',slots:{...productIntent().slots,time:null,changeKind:'added'}}],
      clarification:{question:'Select the date.',intentIds:['s1'],missingSlots:['s1.time'],options:[]}};
    if(mode==='multi')result={...resolvedIntent(),intents:['active','delisted'].map((status,index)=>({...productIntent(),id:`s${index+1}`,
      slots:{...productIntent().slots,region:'浙江',time:{start:'2026-10-04',endExclusive:'2026-10-05'},status}}))};
    if(options?.intents)result={...resolvedIntent(),intents:options.intents};
    if(options?.prediction)result=options.prediction;
    if(mode==='stop_classify')f.app.runs.cancelNow(stage.input.runId);
    return Response.json({ model: 'qwen3.5:0.8b', done: true, done_reason: 'stop', message: { role: 'assistant', content: mode==='json'?'broken JSON':JSON.stringify(result) }, prompt_eval_count: 44, eval_count: 35 });
  } });
  const f = await agentRuntimeFixture(options?.respond??(mode==='multi'?(index=>index===1?{role:'assistant',tool_calls:['s1','s2'].map((stepId,index)=>({index,id:`intent-step-${stepId}`,type:'function',
    function:{name:'query_intent_step',arguments:JSON.stringify({stepId,part:0})}}))}:{role:'assistant',content:'ENGINEERING completed both validated steps.'}):undefined), false, undefined, { client: new OllamaIntentClient({ classify: CLASSIFY_PROMPT, verify: VERIFY_PROMPT }),
    configuration: IntentModelConfigurationSchema.parse({ ...disabledIntentModel(), enabled: true, baseUrl: `http://127.0.0.1:${server.port}`,  verifiedEvidenceRef: 'ENGINEERING' }) },options?.subagents);
  // Exercise the retained v3 Agent path; P15 tests independently exercise new v4 program execution.
  const freeze=f.intentService!.freeze.bind(f.intentService);
  f.intentService!.freeze=(selection,...args)=>freeze({...selection,policyVersion:'medclaw.intent-policy/v3'},...args);
  seedWorkspaceQueries(f.db, f.repos);
  // The seed performs synchronous queries without a native execution; history mutation requires its closed facts too.
  f.db.query('UPDATE runs SET cleanup_json=? WHERE id=10').run(JSON.stringify({contract:'medclaw.run-cleanup/v1',executionStarted:false,stopConfirmed:true,
    requiredPersistenceComplete:true,inputsSettled:true,resourcesReleased:true,unconfirmedItems:[],secondaryErrors:[],verifiedAt:'2026-10-04T00:00:00.000Z'}));
  const resolve = f.runtime.resolve.bind(f.runtime), authentications: boolean[] = [];
  f.runtime.resolve = async (...args) => {
    authentications.push(args[4] !== false);
    if (args[4] !== false&&mode!=='multi'&&!options?.allowMain) throw new Error('ENGINEERING_MAIN_AUTH_MUST_NOT_RUN');
    return resolve(...args);
  };
  const text=mode==='missing'?'列出浙江新增的器械记录':mode==='unsupported'?'分析为什么价格发生变化':mode==='ood'?'写一首诗':mode === 'rule' ? '查询2026-10-04在浙江的全部医疗器械。' : '列出浙江2026-10-04的器械清单';
  const request = { ...f.request(text),
    routing: { mode: 'intent' as const, originRunId: null } };
  return { ...f, request, authentications, intentRequests, chats: () => chats,
    async settle(){for(let i=0;i<1000&&f.app.runs.busy&&!f.app.runs.persistencePending;i++)await Bun.sleep(2);expect(f.app.runs.busy).toBe(false);},
    async close() { try { await f.close(); } finally { server.stop(true); } } };
}

function sessionsFor(f:Awaited<ReturnType<typeof routedFixture>>) {
  return new SessionService('host',f.repos,f.agent,(input,context)=>f.app.runs.submitAgent(input,context),()=>f.app.runs.activeHandle,
    sessionId=>f.app.runs.readInputControl(sessionId),(inputId,context)=>f.app.runs.cancelInput(inputId,context),f.app.runs,SqliteWriteTransactions.forDatabase(f.db));
}

test('p13 P14 agent route may delegate read-only analysis while validated queries and final Answer remain on the parent',async()=>{
  const f=await routedFixture('multi',{subagents:true,respond:index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'intent-helper',type:'function',
    function:{name:'Agent',arguments:JSON.stringify({prompt:'Independently check the supplied comparison reasoning.',description:'Check reasoning',subagent_type:'general-analyst'})}}]}:
    index===2?{role:'assistant',content:'ENGINEERING independent analysis; verify against the actual queries.'}:
    index===3?{role:'assistant',tool_calls:['s1','s2'].map((stepId,index)=>({index,id:'parent-step-'+stepId,type:'function',function:{name:'query_intent_step',arguments:JSON.stringify({stepId,part:0})}}))}:
    {role:'assistant',content:'ENGINEERING parent verified the two results and adopted its answer.'}});
  try{
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'intent-with-helper'});if(!accepted.ok)throw accepted.error;
    await f.settle();const root=accepted.data.runId!;
    expect(f.repos.read({runId:root})).toMatchObject({kind:'one',run:{status:'completed'}});
    const child=f.db.query<{id:number;status:string},[number]>("SELECT id,status FROM runs WHERE parent_run_id=?").get(root);
    expect(child).toMatchObject({status:'completed'});
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(root)).toHaveLength(2);
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(child!.id)).toHaveLength(0);
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(child!.id)).toHaveLength(0);
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(root)).toHaveLength(1);
    expect(f.repos.readIntent({runId:root})?.execution).toMatchObject({finalHistorySaved:true,stepResults:[{stepId:'s1'},{stepId:'s2'}]});
    const childTools=f.requests[1]!.tools as unknown[]|undefined;expect(childTools??[]).toEqual([]);
    expect(f.requests).toHaveLength(4);
  }finally{await f.close();}
},20_000);
function nextRequest(f:Awaited<ReturnType<typeof routedFixture>>,text=f.request.text) {
  const workspace=f.repos.readWorkspace();
  return {...f.request,text,clientSequence:f.repos.readSession(1)!.nextSubmissionSequence,expectedRevision:workspace.revision,
    expectedBatchIds:workspace.batchRefs.map(batch=>batch.id),expectedQueryId:workspace.queryId};
}

for(const mode of ['intent','explicit_agent_fallback'] as const)for(const change of ['unknown_origin','text','date','timezone','workspace'] as const){
  test(`p14 ${mode} rejects ${change} before creating a new root or authenticating the main model`,async()=>{
    const f=await routedFixture('http',{allowMain:true});
    try{
      const original=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:`origin-${mode}-${change}`});
      expect(original.ok).toBe(true);if(!original.ok)throw original.error;await f.settle();
      if(change==='workspace')f.repos.updateWorkspace({batchIds:[]},f.repos.readWorkspace().revision,new Date().toISOString());
      const request={...nextRequest(f),mode:'send' as const,routing:{mode,originRunId:change==='unknown_origin'?999999:original.data.runId!},
        ...(change==='text'?{text:'A different task'}:{}),...(change==='date'?{referenceDate:'2026-10-05'}:{}),...(change==='timezone'?{timezone:'UTC'}:{})};
      const before=f.db.query('SELECT (SELECT COUNT(*) FROM runs) runs,(SELECT COUNT(*) FROM session_inputs) inputs').get(),auth=f.authentications.length;
      const rejected=await f.app.runs.submitAgent(request,{instanceId:'host',operationRef:`changed-${mode}-${change}`});
      expect(rejected).toMatchObject({ok:false,error:{code:'state_conflict'}});
      expect(f.db.query('SELECT (SELECT COUNT(*) FROM runs) runs,(SELECT COUNT(*) FROM session_inputs) inputs').get()).toEqual(before);
      expect(f.authentications).toHaveLength(auth);expect(f.chats()).toBe(1);expect(f.requests).toHaveLength(0);
    }finally{await f.close();}
  });
}

test('p14 explicit retry creates a new root and calls recognition again with the original full task',async()=>{
  const f=await routedFixture('http');
  try{
    const original=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'original-retry'});
    expect(original.ok).toBe(true);if(!original.ok)throw original.error;await f.settle();
    const request={...nextRequest(f),mode:'send' as const,routing:{mode:'intent' as const,originRunId:original.data.runId!}};
    const retried=await f.app.runs.submitAgent(request,{instanceId:'host',operationRef:'new-recognition'});
    if(!retried.ok)throw new Error(JSON.stringify(retried.error));expect(retried.ok).toBe(true);await f.settle();
    expect(retried.data.runId).not.toBe(original.data.runId);expect(retried.data.inputId).not.toBe(original.data.inputId);expect(f.chats()).toBe(2);expect(f.requests).toHaveLength(0);
    expect(f.content(retried.data.inputId!)).toMatchObject({text:f.request.text,originalSubmitInput:{routing:{mode:'intent',originRunId:original.data.runId}}});
    const again=await f.app.runs.submitAgent(request,{instanceId:'host',operationRef:'new-recognition'});expect(again).toEqual(retried);expect(f.chats()).toBe(2);
  }finally{await f.close();}
});

test('p15 unplanned main fallback requires confirmed conditions without admitting a new Run',async()=>{
  const f=await routedFixture('http',{allowMain:true});
  try{
    const original=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'original-fallback'});if(!original.ok)throw original.error;await f.settle();
    const before=f.db.query('SELECT (SELECT COUNT(*) FROM runs) runs,(SELECT COUNT(*) FROM session_inputs) inputs,(SELECT COUNT(*) FROM runtime_events) events').get();
    const request={...nextRequest(f),mode:'send' as const,routing:{mode:'explicit_agent_fallback' as const,originRunId:original.data.runId!}};
    for(let n=0;n<2;n++)expect(await f.app.runs.submitAgent(request,{instanceId:'host',operationRef:'unplanned-fallback'})).toMatchObject({ok:false,error:{code:'intent_confirmation_required'}});
    expect(f.db.query('SELECT (SELECT COUNT(*) FROM runs) runs,(SELECT COUNT(*) FROM session_inputs) inputs,(SELECT COUNT(*) FROM runtime_events) events').get()).toEqual(before);
    expect(f.chats()).toBe(1);expect(f.requests).toHaveLength(0);
  }finally{await f.close();}
});

for(const mode of ['intent','explicit_agent_fallback'] as const)for(const source of ['foreign_session','ordinary_agent','unreleased'] as const){
  test(`p14 ${mode} rejects an ${source} origin before admission`,async()=>{
    const f=await routedFixture('http',{allowMain:true});
    try{
      const {routing:_routing,...plain}=f.request;
      const original=await f.app.runs.submitAgent(source==='ordinary_agent'?plain:f.request,{instanceId:'host',operationRef:`source-${mode}-${source}`});
      if(!original.ok)throw original.error;await f.settle();
      let request={...nextRequest(f),mode:'send' as const,routing:{mode,originRunId:original.data.runId!}};
      if(source==='ordinary_agent')expect(f.repos.readIntent({runId:original.data.runId!})).toBeNull();
      if(source==='foreign_session'){
        const created=await sessionsFor(f).create({selectOnCreate:true,expectedWorkspaceRevision:f.repos.readWorkspace().revision},{instanceId:'host',operationRef:`foreign-${mode}`});
        if(!created.ok)throw created.error;
        request={...request,sessionId:created.data.session.id,clientSequence:created.data.session.nextSubmissionSequence,expectedRevision:f.repos.readWorkspace().revision};
      }
      if(source==='unreleased')f.db.query("UPDATE runs SET cleanup_json=json_set(cleanup_json,'$.resourcesReleased',json('false')) WHERE id=?").run(original.data.runId!);
      const before=f.db.query('SELECT (SELECT COUNT(*) FROM runs) runs,(SELECT COUNT(*) FROM session_inputs) inputs').get(),auth=f.authentications.length,chats=f.chats(),main=f.requests.length;
      expect(await f.app.runs.submitAgent(request,{instanceId:'host',operationRef:`rejected-${mode}-${source}`})).toMatchObject({ok:false,error:{code:'state_conflict'}});
      expect(f.db.query('SELECT (SELECT COUNT(*) FROM runs) runs,(SELECT COUNT(*) FROM session_inputs) inputs').get()).toEqual(before);
      expect(f.authentications).toHaveLength(auth);expect(f.chats()).toBe(chats);expect(f.requests).toHaveLength(main);
    }finally{await f.close();}
  });
}

test('p14 an executable completed origin cannot be relabelled as an explicit fallback',async()=>{
  const f=await routedFixture('rule',{allowMain:true});
  try{
    const original=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'completed-origin'});if(!original.ok)throw original.error;await f.settle();
    const request={...nextRequest(f),mode:'send' as const,routing:{mode:'explicit_agent_fallback' as const,originRunId:original.data.runId!}};
    expect(await f.app.runs.submitAgent(request,{instanceId:'host',operationRef:'false-fallback'})).toMatchObject({ok:false,error:{code:'state_conflict'}});
    expect(f.requests).toHaveLength(0);expect(f.chats()).toBe(0);
  }finally{await f.close();}
});

test('p14 origin release is rechecked inside admission after asynchronous model resolution',async()=>{
  const f=await routedFixture('http',{allowMain:true});
  try{
    const original=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'origin-race-source'});if(!original.ok)throw original.error;await f.settle();
    const resolve=f.runtime.resolve.bind(f.runtime);
    f.runtime.resolve=async(...args)=>{
      const selected=await resolve(...args);
      f.db.query("UPDATE runs SET cleanup_json=json_set(cleanup_json,'$.resourcesReleased',json('false')) WHERE id=?").run(original.data.runId!);
      return selected;
    };
    const before=f.db.query('SELECT (SELECT COUNT(*) FROM runs) runs,(SELECT COUNT(*) FROM session_inputs) inputs').get();
    const request={...nextRequest(f),mode:'send' as const,routing:{mode:'intent' as const,originRunId:original.data.runId!}};
    expect(await f.app.runs.submitAgent(request,{instanceId:'host',operationRef:'origin-race-new'})).toMatchObject({ok:false,error:{code:'state_conflict'}});
    expect(f.db.query('SELECT (SELECT COUNT(*) FROM runs) runs,(SELECT COUNT(*) FROM session_inputs) inputs').get()).toEqual(before);
    expect(f.requests).toHaveLength(0);expect(f.chats()).toBe(1);
  }finally{await f.close();}
});

test('p14 retry accepts a returned original workspace with a newer revision and retains its full task',async()=>{
  const f=await routedFixture('http'),sessions=sessionsFor(f);
  try{
    const original=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'returned-origin'});if(!original.ok)throw original.error;await f.settle();
    const before=f.repos.readWorkspace();
    const other=await sessions.create({selectOnCreate:true,expectedWorkspaceRevision:before.revision},{instanceId:'host',operationRef:'temporary-session'});if(!other.ok)throw other.error;
    const returned=await sessions.select({sessionId:1,expectedWorkspaceRevision:f.repos.readWorkspace().revision});if(!returned.ok)throw returned.error;
    expect(returned.data.revision).toBeGreaterThan(before.revision);
    const retried=await f.app.runs.submitAgent({...nextRequest(f),mode:'send',routing:{mode:'intent',originRunId:original.data.runId!}},{instanceId:'host',operationRef:'returned-retry'});
    if(!retried.ok)throw retried.error;await f.settle();
    expect(f.content(retried.data.inputId!).text).toBe(f.request.text);expect(f.chats()).toBe(2);
  }finally{await f.close();}
});

test('p14 committed program turns are verified checkpoints and SessionDetail exposes the actual current condition',async()=>{
  const f=await routedFixture('rule'),sessions=sessionsFor(f);
  try{
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'program-checkpoint'});if(!accepted.ok)throw accepted.error;await f.settle();
    const condition=f.repos.readIntent({runId:accepted.data.runId!})!.effectiveContext!;
    const changes=f.db.query('SELECT total_changes() n').get(),points=f.repos.readCheckpoints({sessionId:1});
    expect(points.items).toHaveLength(1);expect(points.items[0]).toMatchObject({runId:accepted.data.runId!,nativeLeafId:condition.nativeLeafId,isCurrentBranch:true});
    expect(points.items[0]!.conditionSummary).toContain('浙江');
    expect(f.db.query('SELECT total_changes() n').get()).toEqual(changes);
    expect(await sessions.read(1)).toMatchObject({ok:true,data:{currentQueryContext:condition}});
    expect(f.chats()).toBe(0);expect(f.requests).toHaveLength(0);
  }finally{await f.close();}
});

test('p14 B6 restores the original condition and the next actual intent request uses that branch only',async()=>{
  const f=await routedFixture('rule'),sessions=sessionsFor(f);
  try{
    const first=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'b6-first'});if(!first.ok)throw first.error;await f.settle();
    const original=f.repos.readIntent({runId:first.data.runId!})!.effectiveContext!;
    const second=await f.app.runs.submitAgent(nextRequest(f),{instanceId:'host',operationRef:'b6-second'});if(!second.ok)throw second.error;await f.settle();
    const later=f.repos.readIntent({runId:second.data.runId!})!.effectiveContext!;
    const workspace=f.repos.readWorkspace();f.repos.updateWorkspace({queryId:later.queryIds[0]!},workspace.revision,new Date().toISOString());
    const snapshot=f.repos.readHistorySnapshot(1),queries=f.db.query('SELECT * FROM queries ORDER BY id').all();
    const request={sessionId:1,targetLeafId:original.nativeLeafId,expectedStorageVersion:snapshot.storageVersion,expectedWorkspaceRevision:f.repos.readWorkspace().revision};
    const restored=await sessions.restoreCheckpoint(request,{instanceId:'host',operationRef:'b6-restore-first'});expect(restored).toMatchObject({ok:true});if(!restored.ok)throw restored.error;
    const context=f.repos.readIntent({runId:second.data.runId!})!.effectiveContext!;
    expect(context).toEqual({...original,version:later.version+1,nativeLeafId:request.targetLeafId});
    expect(await sessions.read(1)).toMatchObject({ok:true,data:{currentQueryContext:context}});
    expect(f.repos.readWorkspace()).toMatchObject({queryId:null,selection:null,revision:request.expectedWorkspaceRevision+1});
    expect(f.repos.readHistorySnapshot(1).entries).toEqual(snapshot.entries);expect(f.db.query('SELECT * FROM queries ORDER BY id').all()).toEqual(queries);
    f.repos.updateWorkspace({batchIds:[1]},f.repos.readWorkspace().revision,new Date().toISOString());const current=f.repos.readWorkspace();
    expect(await sessions.restoreCheckpoint(request,{instanceId:'host',operationRef:'b6-restore-first'})).toEqual(restored);
    expect(f.repos.readWorkspace()).toEqual(current);expect(f.repos.readIntent({runId:first.data.runId!})!.effectiveContext!.version).toBe(context.version);
    const third=await f.app.runs.submitAgent(nextRequest(f,'列出相同条件的器械清单'),{instanceId:'host',operationRef:'b6-third'});if(!third.ok)throw third.error;await f.settle();
    expect(f.intentRequests).toHaveLength(1);expect(f.intentRequests[0]!.input.previousQueryContext).toEqual(context);
    const abandoned=new Set(f.db.query<{native_entry_id:string},[number]>('SELECT native_entry_id FROM memories WHERE run_id=?').all(second.data.runId!).map(row=>row.native_entry_id));
    expect(f.intentRequests[0]!.input.recentTurns.every(turn=>!abandoned.has(turn.nativeEntryId))).toBe(true);
    expect(f.repos.readIntent({runId:third.data.runId!})?.execution.runStatus).toBe('completed');expect(f.requests).toHaveLength(0);expect(f.chats()).toBe(1);
  }finally{await f.close();}
});

for(const inherited of [false,true])test(`p14 B6 restores an explicit Agent checkpoint with ${inherited?'an ancestor condition':'no condition'} without replay`,async()=>{
  const f=await routedFixture('rule',{allowMain:true}),sessions=sessionsFor(f);
  try{
    if(inherited){const first=await f.app.runs.submitAgent(nextRequest(f),{instanceId:'host',operationRef:'ancestor-condition'});if(!first.ok)throw first.error;await f.settle();}
    const prior=f.repos.readQueryContext(1),{routing:_routing,...plain}=nextRequest(f,'Explain the currently selected data.');
    const target=await f.app.runs.submitAgent(plain,{instanceId:'host',operationRef:'explicit-checkpoint'});if(!target.ok)throw target.error;await f.settle();
    const point=f.repos.readCheckpoints({sessionId:1}).items.find(item=>item.runId===target.data.runId)!;expect(point).toBeDefined();
    expect(point.conditionSummary===null).toBe(!inherited);
    const newer=await f.app.runs.submitAgent(nextRequest(f),{instanceId:'host',operationRef:'newer-condition'});if(!newer.ok)throw newer.error;await f.settle();
    const later=f.repos.readQueryContext(1)!,snapshot=f.repos.readHistorySnapshot(1);
    const request={sessionId:1,targetLeafId:point.nativeLeafId,expectedStorageVersion:snapshot.storageVersion,expectedWorkspaceRevision:f.repos.readWorkspace().revision};
    const restored=await sessions.restoreCheckpoint(request,{instanceId:'host',operationRef:'restore-explicit-checkpoint'});expect(restored).toMatchObject({ok:true});if(!restored.ok)throw restored.error;
    const expected=prior?{...prior,nativeLeafId:point.nativeLeafId,version:later.version+1}:null;
    expect(f.repos.readQueryContext(1)).toEqual(expected);expect(f.repos.readHistorySnapshot(1).entries).toEqual(snapshot.entries);
    expect(f.requests).toHaveLength(1);expect(f.chats()).toBe(0);
    f.repos.updateWorkspace({batchIds:[1]},f.repos.readWorkspace().revision,new Date().toISOString());
    const {routing:_afterRouting,...afterRestore}=nextRequest(f,'Explain the restored query conditions.');
    const agent=await f.app.runs.submitAgent(afterRestore,{instanceId:'host',operationRef:'agent-after-restored-explicit'});if(!agent.ok)throw agent.error;await f.settle();
    const payload=f.requests[1] as {messages:{role:string;content:unknown}[]};
    const projection=payload.messages.filter(message=>message.role==='user').map(message=>contextMessageText(message.content)).find(text=>text?.startsWith(CONTEXT_MATERIAL_PREFIX))!;
    expect(JSON.parse(projection.slice(CONTEXT_MATERIAL_PREFIX.length)).adoptedQueryContext).toEqual(expected);
    const next=await f.app.runs.submitAgent(nextRequest(f,'列出相同条件的器械清单'),{instanceId:'host',operationRef:'after-restored-explicit'});expect(next).toMatchObject({ok:true});if(!next.ok)throw next.error;await f.settle();
    expect(f.intentRequests).toHaveLength(1);expect(f.intentRequests[0]!.input.previousQueryContext).toEqual(expected);
    expect(f.repos.readIntent({runId:next.data.runId!})!.execution.runStatus).toBe('completed');expect(f.requests).toHaveLength(2);
  }finally{await f.close();}
});

for(const boundary of ['condition','workspace','receipt'] as const)test(`p14 B6 ${boundary} failure rolls back the leaf, condition, Workspace and receipt together`,async()=>{
  const f=await routedFixture('rule'),sessions=sessionsFor(f);
  try{
    const first=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'b6-atomic-first'});if(!first.ok)throw first.error;await f.settle();
    const target=f.repos.readQueryContext(1)!.nativeLeafId;
    const second=await f.app.runs.submitAgent(nextRequest(f),{instanceId:'host',operationRef:'b6-atomic-second'});if(!second.ok)throw second.error;await f.settle();
    const before={session:f.repos.readSession(1),context:f.db.query('SELECT * FROM query_contexts').all(),workspace:f.repos.readWorkspace(),history:f.repos.readHistorySnapshot(1)};
    const request={sessionId:1,targetLeafId:target,expectedStorageVersion:before.history.storageVersion,expectedWorkspaceRevision:before.workspace.revision};
    const clause=boundary==='condition'?'BEFORE UPDATE ON query_contexts':boundary==='workspace'?'BEFORE UPDATE ON workspace':"BEFORE INSERT ON business_events WHEN NEW.type='session_checkpoint_restored'";
    f.db.exec(`CREATE TRIGGER b6_atomic_fault ${clause} BEGIN SELECT RAISE(ABORT,'ENGINEERING_B6_FAULT'); END;`);
    expect(await sessions.restoreCheckpoint(request,{instanceId:'host',operationRef:'b6-atomic-restore'})).toMatchObject({ok:false,error:{code:'storage_write_failed'}});
    expect({session:f.repos.readSession(1),context:f.db.query('SELECT * FROM query_contexts').all(),workspace:f.repos.readWorkspace(),history:f.repos.readHistorySnapshot(1)}).toEqual(before);
    expect(f.repos.readCheckpointOperation('b6-atomic-restore')).toBeNull();expect(f.app.runs.busy).toBe(false);
    f.db.exec('DROP TRIGGER b6_atomic_fault');
    expect(await sessions.restoreCheckpoint(request,{instanceId:'host',operationRef:'b6-atomic-restore'})).toMatchObject({ok:true});
    expect(f.repos.readQueryContext(1)!.nativeLeafId).toBe(target);expect(f.chats()).toBe(0);expect(f.requests).toHaveLength(0);
  }finally{await f.close();}
});

test('p14 adopted conditions are delivered in the next actual main provider projection',async()=>{
  const f=await routedFixture('rule',{allowMain:true});
  try{
    const first=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'provider-condition'});if(!first.ok)throw first.error;await f.settle();
    const context=f.repos.readQueryContext(1)!;
    const {routing:_routing,...plain}=nextRequest(f,'Explain the previously adopted query conditions.');
    const second=await f.app.runs.submitAgent(plain,{instanceId:'host',operationRef:'provider-condition-next'});if(!second.ok)throw second.error;await f.settle();
    expect(f.requests).toHaveLength(1);
    const payload=f.requests[0] as {messages:{role:string;content:unknown}[]};
    const projection=payload.messages.filter(message=>message.role==='user').map(message=>contextMessageText(message.content)).find(text=>text?.startsWith(CONTEXT_MATERIAL_PREFIX))!;
    expect(JSON.parse(projection.slice(CONTEXT_MATERIAL_PREFIX.length)).adoptedQueryContext).toEqual(context);
    const calls=f.db.query<{call_id:string},[number]>('SELECT call_id FROM model_calls WHERE run_id=?').all(second.data.runId!);expect(calls).toHaveLength(1);
    const saved=f.contexts.read({callId:calls[0]!.call_id});expect(saved.kind).toBe('snapshot');if(saved.kind!=='snapshot')throw new Error('Missing provider context');
    expect(saved.snapshot.deliveredCallIds).toEqual([calls[0]!.call_id]);expect(saved.snapshot.renderedProjection).toBe(projection);
    expect(f.chats()).toBe(0);
  }finally{await f.close();}
});

test('p14 main provider projection omits an adopted condition outside the newly accepted batch scope',async()=>{
  const f=await routedFixture('rule',{allowMain:true});
  try{
    const first=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'scope-condition'});if(!first.ok)throw first.error;await f.settle();
    const condition=f.repos.readQueryContext(1)!;f.repos.updateWorkspace({batchIds:[]},f.repos.readWorkspace().revision,new Date().toISOString());
    const {routing:_routing,...plain}=nextRequest(f,'Explain the current data scope.');
    const next=await f.app.runs.submitAgent(plain,{instanceId:'host',operationRef:'scope-condition-next'});if(!next.ok)throw next.error;await f.settle();
    expect(f.requests).toHaveLength(1);
    const payload=f.requests[0] as {messages:{role:string;content:unknown}[]};
    const projection=payload.messages.filter(message=>message.role==='user').map(message=>contextMessageText(message.content)).find(text=>text?.startsWith(CONTEXT_MATERIAL_PREFIX))!;
    expect(JSON.parse(projection.slice(CONTEXT_MATERIAL_PREFIX.length)).adoptedQueryContext).toBeNull();
    expect(f.repos.readQueryContext(1)).toEqual(condition);expect(f.chats()).toBe(0);
  }finally{await f.close();}
});

test('p14 B6 committed receipt loss is read back without repeating condition adoption or native restoration',async()=>{
  const f=await routedFixture('rule'),sessions=sessionsFor(f),tx=SqliteWriteTransactions.forDatabase(f.db),immediate=tx.immediate.bind(tx);
  try{
    const first=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'b6-lost-first'});if(!first.ok)throw first.error;await f.settle();
    const condition=f.repos.readQueryContext(1)!,before=f.repos.readHistorySnapshot(1);
    const request={sessionId:1,targetLeafId:condition.nativeLeafId,expectedStorageVersion:before.storageVersion,expectedWorkspaceRevision:f.repos.readWorkspace().revision};
    let lost=false,restores=0;const restore=f.agent.restore.bind(f.agent);f.agent.restore=async id=>{restores++;return restore(id);};
    tx.immediate=<T>(action:()=>T):T=>{const result=immediate(action);if(!lost){lost=true;throw new Error('ENGINEERING_COMMITTED_RECEIPT_LOST');}return result;};
    const result=await sessions.restoreCheckpoint(request,{instanceId:'host',operationRef:'b6-lost-restore'});expect(result).toMatchObject({ok:true});
    tx.immediate=immediate;
    const context=f.repos.readQueryContext(1)!;expect(context.version).toBe(condition.version+1);expect(restores).toBe(1);
    expect(await sessions.restoreCheckpoint(request,{instanceId:'host',operationRef:'b6-lost-restore'})).toEqual(result);
    expect(restores).toBe(1);expect(f.repos.readQueryContext(1)).toEqual(context);expect(f.repos.readHistorySnapshot(1).entries).toEqual(before.entries);
    expect(f.chats()).toBe(0);expect(f.requests).toHaveLength(0);
  }finally{tx.immediate=immediate;await f.close();}
});

test('p14 B6 committed position survives a native rebuild read failure and requires explicit restore before continuation',async()=>{
  const f=await routedFixture('rule'),sessions=sessionsFor(f),load=f.history.store.load.bind(f.history.store);
  try{
    const first=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'b6-rebuild-first'});if(!first.ok)throw first.error;await f.settle();
    const condition=f.repos.readQueryContext(1)!,before=f.repos.readHistorySnapshot(1);
    const request={sessionId:1,targetLeafId:condition.nativeLeafId,expectedStorageVersion:before.storageVersion,expectedWorkspaceRevision:f.repos.readWorkspace().revision};
    f.history.store.load=async()=>({ok:false,error:safeError('storage_read_failed')});
    expect(await sessions.restoreCheckpoint(request,{instanceId:'host',operationRef:'b6-rebuild-restore'})).toMatchObject({ok:false,error:{code:'resource_unavailable',reason:'session_restore_failed'}});
    f.history.store.load=load;
    expect(f.repos.readCheckpointOperation('b6-rebuild-restore')?.receipt.storageVersion).toBe(before.storageVersion+1);
    expect(f.repos.readQueryContext(1)!.version).toBe(condition.version+1);expect(f.agent.readAvailability(1).availability).toBe('blocked');
    expect(await f.app.runs.submitAgent(nextRequest(f),{instanceId:'host',operationRef:'b6-blocked-send'})).toMatchObject({ok:false});
    expect(await sessions.restore({sessionId:1,expectedLeafId:condition.nativeLeafId},{instanceId:'host',operationRef:'b6-explicit-rebuild'})).toMatchObject({ok:true});
    expect(f.agent.readAvailability(1).availability).toBe('ready');expect(f.repos.readQueryContext(1)!.version).toBe(condition.version+1);
    expect(f.repos.readHistorySnapshot(1).entries).toEqual(before.entries);expect(f.chats()).toBe(0);expect(f.requests).toHaveLength(0);
  }finally{f.history.store.load=load;await f.close();}
});

for(const mode of ['http','json','stop_classify'] as const) {
  test(`p14 actual root ${mode} settles the accepted program input without a native turn or semantic retry`,async()=>{
    const f=await routedFixture(mode);
    try {
      const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:`root-failure-${mode}`});
      expect(accepted.ok).toBe(true);if(!accepted.ok)throw accepted.error;
      await f.settle();const read=f.repos.read({runId:accepted.data.runId!});
      expect(read.kind).toBe('one');if(read.kind!=='one'||!read.run)throw new Error('Missing actual root');
      const status=mode==='stop_classify'?'cancelled':'failed';
      expect(read.run.status).toBe(status);expect(read.run.cleanup).toMatchObject({stopConfirmed:true,inputsSettled:true,requiredPersistenceComplete:true});
      expect(f.repos.readInput({inputId:accepted.data.inputId!})).toMatchObject({status,processingStatus:status});
      expect(f.chats()).toBe(1);expect(f.requests).toHaveLength(0);
      expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(read.run.id)).toHaveLength(0);
      expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(read.run.id)).toHaveLength(0);
      expect(f.db.query('SELECT id FROM memories WHERE run_id=?').all(read.run.id)).toHaveLength(0);
    }finally{await f.close();}
  });
}

for(const [mode,kind] of [['ood','out_of_scope'],['unsupported','insufficient_evidence'],['missing','clarification']] as const) {
  test(`p14 actual root ${mode} commits a program ${kind} without a business Query or main model`,async()=>{
    const f=await routedFixture(mode);
    try {
      const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:`root-semantic-${mode}`});
      expect(accepted.ok).toBe(true);if(!accepted.ok)throw accepted.error;
      await f.settle();const read=f.repos.read({runId:accepted.data.runId!});
      expect(read.kind).toBe('one');if(read.kind!=='one'||!read.run)throw new Error('Missing actual root');
      expect(read.run.status).toBe('completed');expect(f.chats()).toBe(1);expect(f.requests).toHaveLength(0);
      expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(read.run.id)).toHaveLength(0);
      expect(f.db.query('SELECT kind FROM answers WHERE run_id=?').get(read.run.id)).toEqual({kind});
      expect(f.repos.readInput({inputId:accepted.data.inputId!})).toMatchObject({status:'consumed',processingStatus:'completed'});
    }finally{await f.close();}
  });
}

for (const phase of ['auth_failure', 'stop_auth'] as const) test(`p14 saved agent route survives ${phase} without starting the business Agent`, async () => {
  const f = await routedFixture('multi', { allowMain: true });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const prior = await f.app.runs.submitAgent({ ...f.request, text: '查询2026-10-04在浙江的全部医疗器械。' }, { instanceId: 'host', operationRef: `before-${phase}` });
    if (!prior.ok) throw prior.error; await f.settle();
    const conditions = f.db.query('SELECT * FROM query_contexts').all(); expect(conditions).toHaveLength(1);
    const resolve = f.runtime.resolve.bind(f.runtime), execute = f.agent.execute.bind(f.agent); let entered = false, executions = 0;
    f.agent.execute = async (...args) => { executions++; return execute(...args); };
    f.runtime.resolve = async (...args) => {
      if (args[4] !== false) {
        entered = true;
        if (phase === 'auth_failure') throw safeError('model_auth_missing');
        await held;
      }
      return resolve(...args);
    };
    const accepted = await f.app.runs.submitAgent(nextRequest(f), { instanceId: 'host', operationRef: phase });
    if (!accepted.ok) throw accepted.error;
    for (let index = 0; index < 1000 && !entered; index++) await Bun.sleep(2);
    expect(entered).toBe(true);
    expect(f.repos.readIntent({ runId: accepted.data.runId! })?.decision?.route).toBe('agent');
    if (phase === 'stop_auth') { expect(f.app.runs.cancelNow(accepted.data.runId!).cancelRequested).toBe(true); expect(f.app.runs.busy).toBe(true); release(); }
    await f.settle();
    const read = f.repos.read({ runId: accepted.data.runId! }); if (read.kind !== 'one' || !read.run) throw new Error('Missing root');
    expect(read.run.status).toBe(phase === 'auth_failure' ? 'failed' : 'cancelled');
    if (phase === 'auth_failure') expect(read.run.error?.code).toBe('model_auth_missing');
    expect(read.run.cleanup).toMatchObject({ stopConfirmed: true, requiredPersistenceComplete: true });
    expect(executions).toBe(0); expect(f.requests).toHaveLength(0); expect(f.chats()).toBe(1);
    expect(f.db.query('SELECT id FROM route_decisions WHERE run_id=?').all(read.run.id)).toHaveLength(1);
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(read.run.id)).toHaveLength(0);
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(read.run.id)).toHaveLength(0);
    expect(f.db.query('SELECT * FROM query_contexts').all()).toEqual(conditions);
    expect(f.db.query("SELECT type FROM runtime_events WHERE run_id=? AND type IN ('run_failed','run_cancelled')").all(read.run.id))
      .toEqual([{ type: phase === 'auth_failure' ? 'run_failed' : 'run_cancelled' }]);
  } finally { release(); await f.close(); }
});

for (const [mode, calls] of [['rule', 0], ['classify', 1], ['verify', 2]] as const) {
  test(`p14 actual root ${mode} freezes recognition and commits a simple Query/program turn with ${calls} intent calls and no main authentication`, async () => {
    const f = await routedFixture(mode);
    try {
      const command = { instanceId: 'host', operationRef: `root-intent-${mode}` };
      const accepted = await f.app.runs.submitAgent(f.request, command);
      expect(accepted.ok).toBe(true); if (!accepted.ok) throw accepted.error;
      await f.settle();
      const read = f.repos.read({ runId: accepted.data.runId! });
      expect(read.kind).toBe('one'); if (read.kind !== 'one' || !read.run) throw new Error('Missing actual root');
      expect(read.run.status).toBe('completed'); expect(read.run.calls).toHaveLength(calls);
      expect(f.db.query("SELECT id FROM runtime_events WHERE run_id=? AND type='run_started'").all(read.run.id)).toHaveLength(1);
      expect(read.run.calls.every(call => call.kind === 'intent')).toBe(true);
      expect(read.run.cleanup?.budgetSummary?.modelCalls).toBe(calls);
      expect(f.chats()).toBe(calls); expect(f.requests).toHaveLength(0); expect(f.authentications).toEqual([false]);
      const content = f.content(accepted.data.inputId!);
      expect(content.intentAdmission?.selection.modelTag).toBe('qwen3.5:0.8b');
      expect(content.intentAdmission?.prompts.classify).toMatchObject({text:CLASSIFY_PROMPT,version:content.intentAdmission!.selection.classifyPromptVersion});
      expect(content.intentAdmission?.prompts.verify.text).toBe(VERIFY_PROMPT);
      expect(f.repos.readInput({ inputId: accepted.data.inputId! })).toMatchObject({ status: 'consumed', processingStatus: 'completed' });
      expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(read.run.id)).toHaveLength(1);
      const history = await f.history.store.load(1); expect(history.ok).toBe(true); if (!history.ok) throw history.error;
      expect(history.data.entries).toHaveLength(4);
      expect(await f.app.runs.submitAgent(f.request, command)).toEqual(accepted); expect(f.chats()).toBe(calls);
    } finally { await f.close(); }
  });
}

test('p14 actual root B2 retry saves acquired classification only and closes the failed input',async()=>{
  const f=await routedFixture('classify');
  try {
    f.db.query("CREATE TRIGGER engineering_b2 BEFORE UPDATE ON model_calls WHEN OLD.kind='intent' AND NEW.state!='started' BEGIN SELECT RAISE(ABORT,'ENGINEERING'); END").run();
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'root-b2-retry'});
    expect(accepted.ok).toBe(true);if(!accepted.ok)throw accepted.error;
    for(let i=0;i<1000&&!f.app.runs.persistencePending;i++)await Bun.sleep(2);
    expect(f.app.runs.persistencePending).toBe(true);expect(f.chats()).toBe(1);
    f.db.query('DROP TRIGGER engineering_b2').run();
    const retried=await f.app.runs.retrySave(accepted.data.runId!);expect(retried.ok).toBe(true);
    await f.settle();expect(f.chats()).toBe(1);expect(f.requests).toHaveLength(0);
    expect(f.repos.readInput({inputId:accepted.data.inputId!})).toMatchObject({status:'failed',processingStatus:'failed'});
    const intent=f.repos.readIntent({runId:accepted.data.runId!});expect(intent?.calls[0]?.state).toBe('completed');expect(intent?.decision).toBeNull();
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(0);
  }finally{await f.close();}
});

for(const stop of [false,true])test(`p14 actual root B5 retry ${stop?'honors Stop':'preserves the product turn'} without infer/query/append replay`,async()=>{
  const f=await routedFixture('classify');let appends=0,fail=true;
  const append=f.agent.appendProductTurn.bind(f.agent),finalize=f.repos.finalizeAgent.bind(f.repos);
  f.agent.appendProductTurn=async input=>{appends++;return append(input);};
  f.repos.finalizeAgent=(...args)=>{if(fail)throw new Error('ENGINEERING B5');return finalize(...args);};
  try {
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:`root-b5-retry-${stop}`});
    expect(accepted.ok).toBe(true);if(!accepted.ok)throw accepted.error;
    for(let i=0;i<1000&&!f.app.runs.persistencePending;i++)await Bun.sleep(2);
    expect(f.app.runs.persistencePending).toBe(true);expect(appends).toBe(1);
    const queries=f.db.query('SELECT id FROM queries WHERE run_id=?').all(accepted.data.runId!);expect(queries).toHaveLength(1);
    expect(f.db.query('SELECT id FROM memories WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(0);
    if(stop){const cancelled=await f.app.runs.cancel(accepted.data.runId!);expect(cancelled.ok&&cancelled.data.cancelRequested).toBe(true);}
    fail=false;const retried=await f.app.runs.retrySave(accepted.data.runId!);expect(retried.ok).toBe(true);
    await f.settle();expect(f.chats()).toBe(1);expect(appends).toBe(1);expect(f.requests).toHaveLength(0);
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(accepted.data.runId!)).toEqual(queries);
    expect(f.repos.readInput({inputId:accepted.data.inputId!})).toMatchObject(stop?{status:'cancelled',processingStatus:'cancelled'}:{status:'consumed',processingStatus:'completed'});
    expect(f.db.query('SELECT id FROM memories WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(stop?0:4);
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(stop?0:1);
  }finally{fail=false;const active=f.app.runs.activeHandle;if(active&&f.app.runs.persistencePending)await f.app.runs.retrySave(active.runId);await f.close();}
});

test('p14 actual root Stop after Query discards the staged program turn and preserves B4',async()=>{
  const f=await routedFixture('rule'),append=f.agent.appendProductTurn.bind(f.agent);
  f.agent.appendProductTurn=async input=>{const fact=await append(input);f.app.runs.cancelNow(input.runId);return fact;};
  try {
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'root-stop-after-query'});
    expect(accepted.ok).toBe(true);if(!accepted.ok)throw accepted.error;
    await f.settle();expect(f.chats()).toBe(0);expect(f.requests).toHaveLength(0);
    expect(f.repos.readInput({inputId:accepted.data.inputId!})).toMatchObject({status:'cancelled',processingStatus:'cancelled'});
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(1);
    expect(f.db.query('SELECT id FROM memories WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(0);
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(0);
  }finally{await f.close();}
});

for(const mode of ['steer','follow_up'] as const)test(`p14 ${mode} consumes its actual Input before bound task queries and final history proof`,async()=>{
  let entered=false,release=()=>{};
  const f=await routedFixture('multi',{respond:async(index)=>{
    if(index===1){entered=true;await new Promise<void>(done=>release=done);return {role:'assistant',content:'ENGINEERING first native turn.'};}
    return index===2?{role:'assistant',tool_calls:['s1','s2'].map((stepId,index)=>({index,id:`queued-intent-${stepId}`,type:'function',
      function:{name:'query_intent_step',arguments:JSON.stringify({stepId,part:0})}}))}:{role:'assistant',content:'ENGINEERING saved queued task results.'};
  }});
  try{
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:`queued-task-root-${mode}`});if(!accepted.ok)throw accepted.error;
    for(let index=0;!entered&&index<1000;index++)await Bun.sleep(2);expect(entered).toBe(true);
    const {routing:_routing,...original}=f.request;
    const queued=await f.app.runs.submitAgent({...original,mode,targetRunId:accepted.data.runId!,text:`ENGINEERING queued ${mode}`,
      clientSequence:f.repos.readSession(1)!.nextSubmissionSequence},{instanceId:'host',operationRef:`queued-task-${mode}`});
    if(!queued.ok)throw queued.error;expect(queued.data.runId).toBeNull();release();await f.settle();
    expect(f.requests).toHaveLength(3);expect(JSON.stringify(f.requests[1]!.messages)).toContain(`ENGINEERING queued ${mode}`);expect(f.chats()).toBe(1);
    const input=f.repos.readInput({inputId:queued.data.inputId!});
    expect(input).toMatchObject({status:'consumed',processingStatus:'completed',targetRunId:accepted.data.runId,runId:accepted.data.runId,nativeEntryId:expect.any(String)});
    const facts=f.repos.readIntent({runId:accepted.data.runId!});
    expect(facts?.execution).toMatchObject({runStatus:'completed',finalHistorySaved:true,requiredPersistenceComplete:true});expect(facts?.execution.queryIds).toHaveLength(2);
    expect(facts?.execution.stepResults.map(step=>step.stepId)).toEqual(['s1','s2']);
    expect(f.db.query('SELECT DISTINCT input_id FROM queries WHERE run_id=?').all(accepted.data.runId!)).toEqual([{input_id:accepted.data.inputId}]);
    expect(f.db.query("SELECT DISTINCT s.input_id FROM tool_calls t JOIN context_snapshots s ON s.id=t.context_snapshot_id WHERE t.run_id=? AND t.tool_name='query_intent_step'").all(accepted.data.runId!)).toEqual([{input_id:queued.data.inputId}]);
  }finally{release();await f.close();}
});

test('p14 actual multi-intent root uses one Agent, bound step queries and a native execution proof before final freeze',async()=>{
  const f=await routedFixture('multi');
  try {
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'root-multi-agent'});
    if(!accepted.ok)throw accepted.error;expect(accepted.ok).toBe(true);
    await f.settle();const read=f.repos.read({runId:accepted.data.runId!});
    expect(read.kind).toBe('one');if(read.kind!=='one'||!read.run)throw new Error('Missing root');
    expect(read.run.status).toBe('completed');expect(f.authentications).toEqual([false,true]);expect(f.chats()).toBe(1);
    expect(f.requests).toHaveLength(2);expect(read.run.cleanup?.budgetSummary?.modelCalls).toBe(3);
    expect(JSON.stringify(f.requests[0]!.messages)).toContain('medclaw.intent-task/v1');
    const tools=f.requests[0]!.tools as {function:{name:string}}[];
    expect(tools.some(tool=>tool.function.name==='query_intent_step')).toBe(true);expect(tools.some(tool=>tool.function.name==='Agent')).toBe(true);
    expect(f.db.query('SELECT id FROM runs WHERE parent_run_id=?').all(read.run.id)).toHaveLength(0);
    const queries=f.db.query<{id:number},[number]>('SELECT id FROM queries WHERE run_id=? ORDER BY id').all(read.run.id);
    expect(queries).toHaveLength(2);
    const saved=f.db.query<{entry_json:string},[number]>("SELECT entry_json FROM memories WHERE run_id=? AND json_extract(entry_json,'$.customType')='medclaw-intent-execution'").get(read.run.id);
    expect(saved).not.toBeNull();const execution=JSON.parse(saved!.entry_json).data;
    expect(execution.taskIntents.map((item:{id:string})=>item.id)).toEqual(['s1','s2']);
    expect(execution.stepResults).toEqual(queries.map((query,index)=>({stepId:`s${index+1}`,queryRefs:[{queryId:query.id}]})));
    const detail=f.repos.readIntent({runId:read.run.id});
    expect(detail?.execution).toMatchObject({stepResults:execution.stepResults,finalHistorySaved:true});expect(detail?.effectiveContext).toBeNull();
    expect(f.db.query('SELECT query_ids_json FROM answers WHERE run_id=?').get(read.run.id)).toEqual({query_ids_json:JSON.stringify(queries.map(query=>query.id))});
  }finally{await f.close();}
});

for(const mode of ['rule','multi'] as const)test(`p14 ${mode} lost B5 return is verified from committed facts without replay`,async()=>{
  const f=await routedFixture(mode),finalize=f.repos.finalizeAgent.bind(f.repos),append=f.agent.appendProductTurn.bind(f.agent);let commits=0,appends=0;
  f.repos.finalizeAgent=(...args)=>{finalize(...args);commits++;throw new Error('ENGINEERING COMMIT return lost');};
  f.agent.appendProductTurn=async input=>{appends++;return append(input);};
  try{
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:`root-b5-return-lost-${mode}`});if(!accepted.ok)throw accepted.error;
    await f.settle();const read=f.repos.readIntent({runId:accepted.data.runId!});
    expect(read?.execution).toMatchObject({runStatus:'completed',finalHistorySaved:true,requiredPersistenceComplete:true});
    expect(read?.execution.queryIds).toHaveLength(mode==='rule'?1:2);expect(commits).toBe(1);expect(appends).toBe(1);
    expect(f.requests).toHaveLength(mode==='rule'?0:2);expect(f.chats()).toBe(mode==='rule'?0:1);expect(f.app.runs.persistencePending).toBe(false);
  }finally{f.repos.finalizeAgent=finalize;await f.close();}
});

test('p14 intent read rechecks actual SDK step receipts rather than trusting the saved execution custom',async()=>{
  const f=await routedFixture('multi');
  try{
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'root-read-sdk-proof'});if(!accepted.ok)throw accepted.error;
    await f.settle();expect(f.repos.readIntent({runId:accepted.data.runId!})?.execution.stepResults).toHaveLength(2);
    expect(()=>f.db.query("UPDATE tool_calls SET args_json=json_set(args_json,'$.stepId','unknown') WHERE run_id=? AND tool_name='query_intent_step'").run(accepted.data.runId!)).toThrow('tool_identity_immutable');
    f.db.query("UPDATE tool_calls SET delivery_json=json_set(delivery_json,'$.sdkReturned',json('false')) WHERE run_id=? AND tool_name='query_intent_step'").run(accepted.data.runId!);
    expect(()=>f.repos.readIntent({runId:accepted.data.runId!})).toThrow('storage_read_failed');
    expect(f.requests).toHaveLength(2);expect(f.chats()).toBe(1);
  }finally{await f.close();}
});

for(const tamper of ['swap_steps','missing_turn'] as const)test(`p14 multi-intent B5 rejects ${tamper} and retries only the original acquired facts`,async()=>{
  const f=await routedFixture('multi'),finalize=f.repos.finalizeAgent.bind(f.repos);let corrupt=true,appends=0;
  const append=f.agent.appendProductTurn.bind(f.agent);f.agent.appendProductTurn=async input=>{appends++;return append(input);};
  f.repos.finalizeAgent=(runId,fact)=>{
    if(!corrupt)return finalize(runId,fact);
    const changed=structuredClone(fact);
    if(tamper==='missing_turn')delete changed.productTurn;
    else {
      const entry=changed.history!.newEntries.find(value=>(value as {customType?:string}).customType==='medclaw-intent-execution') as {data:{stepResults:{queryRefs:unknown[]}[]}};
      entry.data.stepResults[0]!.queryRefs=entry.data.stepResults[1]!.queryRefs;
      changed.productTurn!.history=changed.history!;
    }
    return finalize(runId,changed);
  };
  try{
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:`root-multi-tamper-${tamper}`});if(!accepted.ok)throw accepted.error;
    for(let i=0;i<1000&&!f.app.runs.persistencePending;i++)await Bun.sleep(2);
    expect(f.app.runs.persistencePending).toBe(true);
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(0);
    const queries=f.db.query('SELECT id FROM queries WHERE run_id=?').all(accepted.data.runId!);expect(queries).toHaveLength(2);
    corrupt=false;expect((await f.app.runs.retrySave(accepted.data.runId!)).ok).toBe(true);await f.settle();
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(1);
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(accepted.data.runId!)).toEqual(queries);
    expect(f.chats()).toBe(1);expect(f.requests).toHaveLength(2);expect(appends).toBe(1);
  }finally{corrupt=false;const active=f.app.runs.activeHandle;if(active&&f.app.runs.persistencePending)await f.app.runs.retrySave(active.runId);await f.close();}
});

test('p14 freshness Agent step uses actual batch metadata and saves an execution proof with no invented Query',async()=>{
  const {definition:_definition,...path}=INTENT_TAXONOMY.FRESHNESS;
  const item:IntentItem={...productIntent(),...path,l2:'FRESHNESS',parameters:{basis:'snapshot_date'},slots:{...productIntent().slots,region:'浙江'}};
  const f=await routedFixture('multi',{intents:[item],respond:index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'freshness-step',type:'function',
    function:{name:'query_intent_step',arguments:JSON.stringify({stepId:'s1',part:0})}}]}:{role:'assistant',content:'ENGINEERING snapshot date 2026-10-04; capture time is unknown.'}});
  try{
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'root-freshness'});if(!accepted.ok)throw accepted.error;
    await f.settle();const read=f.repos.read({runId:accepted.data.runId!});if(read.kind!=='one'||!read.run)throw new Error('Missing root');
    expect(read.run.status).toBe('completed');expect(f.requests).toHaveLength(2);
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(read.run.id)).toHaveLength(0);
    const record=f.db.query<{entry_json:string},[number]>("SELECT entry_json FROM memories WHERE run_id=? AND json_extract(entry_json,'$.customType')='medclaw-intent-execution'").get(read.run.id);
    expect(record).not.toBeNull();expect(JSON.parse(record!.entry_json).data.stepResults).toEqual([{stepId:'s1',queryRefs:[]}]);
    expect(f.repos.readIntent({runId:read.run.id})?.execution).toMatchObject({stepResults:[{stepId:'s1',queryRefs:[]}],finalHistorySaved:true});
    const tools=f.db.query<{result_json:string},[number]>("SELECT result_json FROM tool_calls WHERE run_id=? AND tool_name='query_intent_step' AND status='succeeded'").all(read.run.id);
    expect(tools).toHaveLength(1);expect(JSON.parse(tools[0]!.result_json)).toMatchObject({basis:'snapshot_date',batches:[{id:1,snapshotDate:'2026-10-04'}]});
  }finally{await f.close();}
});

test('p14 company comparison executes two real aggregate parts and adopts only that task condition',async()=>{
  const {definition:_definition,...path}=INTENT_TAXONOMY.COMPANY_COMPARE;
  const item:IntentItem={...productIntent(),...path,l2:'COMPANY_COMPARE',parameters:{manufacturers:['甲厂家','乙厂家']},
    slots:{...productIntent().slots,region:'浙江',time:{start:'2026-10-04',endExclusive:'2026-10-05'},metric:'count'}};
  const f=await routedFixture('multi',{intents:[item],respond:index=>index===1?{role:'assistant',tool_calls:[0,1].map(part=>({index:part,id:`company-${part}`,type:'function',
    function:{name:'query_intent_step',arguments:JSON.stringify({stepId:'s1',part})}}))}:{role:'assistant',content:'ENGINEERING compared two saved aggregate parts.'}});
  f.db.query("UPDATE snapshots SET manufacturer=CASE WHEN device_id=1 THEN '甲厂家' ELSE '乙厂家' END").run();
  try{
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'root-company-compare'});if(!accepted.ok)throw accepted.error;
    await f.settle();const read=f.repos.read({runId:accepted.data.runId!});if(read.kind!=='one'||!read.run)throw new Error('Missing root');
    expect(read.run.status).toBe('completed');
    const queries=f.db.query<{id:number;kind:string;params_json:string},[number]>('SELECT id,kind,params_json FROM queries WHERE run_id=? ORDER BY id').all(read.run.id);
    expect(queries.map(query=>[query.kind,JSON.parse(query.params_json).manufacturer])).toEqual([['aggregate','甲厂家'],['aggregate','乙厂家']]);
    const context=f.repos.readIntent({runId:read.run.id})!.effectiveContext!;
    if('contract' in context)throw new Error('Expected the automatic comparison context');
    expect(context.queryIds).toEqual(queries.map(query=>query.id));expect(context.contextIntentId).toBe('s1');expect(context.adoptedSlots.manufacturer).toBeNull();
    expect(f.chats()).toBe(1);expect(f.requests).toHaveLength(2);
  }finally{await f.close();}
});

for(const failure of ['incomplete','unknown_step','override'] as const)test(`p14 Agent ${failure} cannot commit a successful Answer or invented step proof`,async()=>{
  const args=failure==='unknown_step'?{stepId:'not-a-task',part:0}:failure==='override'?{stepId:'s1',part:0,region:'outside-scope'}:{stepId:'s1',part:0};
  const f=await routedFixture('multi',{respond:index=>index===1?{role:'assistant',tool_calls:[{index:0,id:`invalid-${failure}`,type:'function',
    function:{name:'query_intent_step',arguments:JSON.stringify(args)}}]}:{role:'assistant',content:'ENGINEERING claims all tasks finished.'}});
  try{
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:`root-agent-${failure}`});if(!accepted.ok)throw accepted.error;
    await f.settle();const read=f.repos.read({runId:accepted.data.runId!});if(read.kind!=='one'||!read.run)throw new Error('Missing root');
    expect(read.run.status).toBe('failed');expect(read.run.error?.code).toBe('answer_evidence_invalid');
    expect(read.run.cleanup?.stopConfirmed).toBe(true);
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(read.run.id)).toHaveLength(failure==='incomplete'?1:0);
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(read.run.id)).toHaveLength(0);
    expect(f.db.query("SELECT id FROM memories WHERE run_id=? AND json_extract(entry_json,'$.customType')='medclaw-intent-execution'").all(read.run.id)).toHaveLength(0);
    expect(f.repos.readInput({inputId:accepted.data.inputId!})).toMatchObject({status:'consumed',processingStatus:'failed'});
  }finally{await f.close();}
});

test('p14 cancelled Agent holds admission across a native snapshot read fault and retries acquired facts only',async()=>{
  const f=await routedFixture('multi'),finalize=f.repos.finalizeAgent.bind(f.repos),load=f.history.store.load.bind(f.history.store),append=f.agent.appendProductTurn.bind(f.agent);
  let holdFinal=true,failRead=false,appends=0;
  f.repos.finalizeAgent=(...args)=>{if(holdFinal)throw new Error('ENGINEERING pending B5');return finalize(...args);};
  f.history.store.load=async(...args)=>failRead?{ok:false,error:safeError('storage_read_failed')}:load(...args);
  f.agent.appendProductTurn=async input=>{appends++;return append(input);};
  try{
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'root-cancel-read-fault'});if(!accepted.ok)throw accepted.error;
    for(let i=0;i<1000&&!f.app.runs.persistencePending;i++)await Bun.sleep(2);expect(f.app.runs.persistencePending).toBe(true);
    holdFinal=false;failRead=true;const cancelled=await f.app.runs.cancel(accepted.data.runId!);
    expect(cancelled).toMatchObject({ok:true,data:{cancelRequested:true,persistencePending:true}});
    expect(f.agent.hasPendingHistoryPersistence(accepted.data.runId!)).toBe(true);
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(0);
    expect(f.db.query('SELECT id FROM query_contexts').all()).toHaveLength(0);
    expect((await f.app.runs.submitAgent({...f.request,clientSequence:f.request.clientSequence+1},{instanceId:'host',operationRef:'root-must-stay-held'})).ok).toBe(false);
    failRead=false;expect((await f.app.runs.retrySave(accepted.data.runId!)).ok).toBe(true);await f.settle();
    expect(f.repos.readIntent({runId:accepted.data.runId!})?.execution).toMatchObject({runStatus:'cancelled',stepResults:[],finalHistorySaved:true,answerId:null});
    expect(f.agent.hasPendingHistoryPersistence(accepted.data.runId!)).toBe(false);expect(appends).toBe(1);expect(f.chats()).toBe(1);expect(f.requests).toHaveLength(2);
  }finally{holdFinal=false;failRead=false;const active=f.app.runs.activeHandle;if(active&&f.app.runs.persistencePending)await f.app.runs.retrySave(active.runId);await f.close();}
});

for(const phase of ['append','pending_b5'] as const)test(`p14 Stop after Agent product ${phase} cancels before B5 and retains real SDK history and Queries`,async()=>{
  const f=await routedFixture('multi'),append=f.agent.appendProductTurn.bind(f.agent),finalize=f.repos.finalizeAgent.bind(f.repos);let stopped=false,fail=phase==='pending_b5',appends=0;
  f.agent.appendProductTurn=async input=>{appends++;const turn=await append(input);if(input.mode==='agent_task'&&phase==='append')stopped=f.app.runs.cancelNow(input.runId).cancelRequested;return turn;};
  f.repos.finalizeAgent=(...args)=>{if(fail)throw new Error('ENGINEERING pending B5');return finalize(...args);};
  try{
    const accepted=await f.app.runs.submitAgent(f.request,{instanceId:'host',operationRef:'root-agent-stop-after-append'});if(!accepted.ok)throw accepted.error;
    if(phase==='pending_b5'){
      for(let i=0;i<1000&&!f.app.runs.persistencePending;i++)await Bun.sleep(2);
      expect(f.app.runs.persistencePending).toBe(true);fail=false;
      const result=await f.app.runs.cancel(accepted.data.runId!);stopped=result.ok&&result.data.cancelRequested;
      if(f.app.runs.persistencePending)expect((await f.app.runs.retrySave(accepted.data.runId!)).ok).toBe(true);
    }
    await f.settle();const read=f.repos.read({runId:accepted.data.runId!});if(read.kind!=='one'||!read.run)throw new Error('Missing root');
    expect(stopped).toBe(true);expect(read.run.status).toBe('cancelled');expect(read.run.cleanup?.stopConfirmed).toBe(true);
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(read.run.id)).toHaveLength(2);
    expect(f.db.query('SELECT id FROM answers WHERE run_id=?').all(read.run.id)).toHaveLength(0);
    const history=f.repos.readHistorySnapshot(read.run.sessionId!);
    const leaf=history.entries.find(value=>(value as {id?:string}).id===history.activeLeafId) as {type:string;message?:{role:string}};
    expect(leaf.type).toBe('message');expect(leaf.message?.role).toBe('assistant');
    expect(f.repos.readInput({inputId:accepted.data.inputId!})).toMatchObject({status:'consumed',processingStatus:'cancelled'});
    expect(f.repos.readIntent({runId:read.run.id})?.execution).toMatchObject({queryIds:expect.any(Array),stepResults:[],answerId:null,finalHistorySaved:true});
    expect(appends).toBe(1);expect(f.requests).toHaveLength(2);expect(f.chats()).toBe(1);
  }finally{fail=false;const active=f.app.runs.activeHandle;if(active&&f.app.runs.persistencePending)await f.app.runs.retrySave(active.runId);await f.close();}
});


test('p14 saved missing parameters retain the complete original task until resolution and checkpoint restore', async () => {
  const options: { prediction?: IntentResult } = {}, f = await routedFixture('missing', options);
  try {
    const text = '浙江新增器械的范围说明。' + 'scope context '.repeat(350) + '请确认所需日期。';
    const first = await f.app.runs.submitAgent({ ...f.request, text }, { instanceId: 'host', operationRef: 'pending-full-task' });
    expect(first.ok).toBe(true); if (!first.ok) throw first.error;
    await f.settle();
    const pending = f.repos.readQueryContext(1);
    expect(pending).toMatchObject({ sourceRunId: first.data.runId, contextIntentId: 's1',
      adoptedSlots: { time: null, changeKind: 'added' }, queryIds: [], pendingClarification: { taskText: text, missingSlots: ['s1.time'] } });
    const point = f.repos.readCheckpoints({ sessionId: 1 }).items.find(value => value.runId === first.data.runId)!;
    expect(point).toBeDefined();
    const repeated = await f.app.runs.submitAgent(nextRequest(f, '还需要确认日期'), { instanceId: 'host', operationRef: 'pending-again' });
    expect(repeated.ok).toBe(true); if (!repeated.ok) throw repeated.error; await f.settle();
    expect(f.repos.readQueryContext(1)?.pendingClarification).toEqual(pending!.pendingClarification);
    options.prediction = IntentResultSchema.parse({ ...resolvedIntent(), intents: [{ ...productIntent(),
      slots: { ...productIntent().slots, region: '浙江', time: { start: '2026-10-04', endExclusive: '2026-10-05' } } }] });
    const second = await f.app.runs.submitAgent(nextRequest(f, '2026-10-04'), { instanceId: 'host', operationRef: 'pending-resolution' });
    expect(second.ok).toBe(true); if (!second.ok) throw second.error; await f.settle();
    expect(f.intentRequests.at(-1)!.input.pendingClarification).toEqual(pending!.pendingClarification);
    expect(f.repos.readQueryContext(1)).toMatchObject({ sourceRunId: second.data.runId, pendingClarification: null });
    const session = f.repos.readSession(1)!, workspace = f.repos.readWorkspace();
    const restored = await sessionsFor(f).restoreCheckpoint({ sessionId: 1, targetLeafId: point.nativeLeafId,
      expectedStorageVersion: session.storageVersion, expectedWorkspaceRevision: workspace.revision },
      { instanceId: 'host', operationRef: 'restore-pending' });
    expect(restored.ok).toBe(true);
    expect(f.repos.readQueryContext(1)?.pendingClarification).toEqual(pending!.pendingClarification);
    expect(f.chats()).toBe(3); expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});

test('p14 ambiguous purpose preserves prior conditions and delivers its full pending task on the next HTTP', async () => {
  const candidate = productIntent(), options = { prediction: IntentResultSchema.parse({ ...resolvedIntent(), status: 'AMBIGUOUS', intents: [],
    candidateIntents: [{ reasonCode: 'confusable_pair', intents: [candidate] }],
    clarification: { question: 'Which task?', intentIds: ['s1'], missingSlots: [], options: ['List', 'Details'] } }) };
  const f = await routedFixture('classify', options);
  try {
    const prior = await f.app.runs.submitAgent({ ...f.request, text: '查询2026-10-04在浙江的全部医疗器械。' },
      { instanceId: 'host', operationRef: 'ambiguous-prior-condition' });
    expect(prior.ok).toBe(true); if (!prior.ok) throw prior.error; await f.settle();
    const priorContext = f.repos.readQueryContext(1); expect(priorContext).not.toBeNull();
    const text = '器械范围尚未确定。' + 'device context '.repeat(350) + '请先澄清。';
    const first = await f.app.runs.submitAgent(nextRequest(f, text), { instanceId: 'host', operationRef: 'ambiguous-full-task' });
    expect(first.ok).toBe(true); if (!first.ok) throw first.error; await f.settle();
    expect(f.repos.readQueryContext(1)).toEqual(priorContext);
    options.prediction = IntentResultSchema.parse({ ...resolvedIntent(), status: 'OUT_OF_SCOPE', intents: [] });
    for (const index of [1, 2]) {
      const unrelated = await f.app.runs.submitAgent(nextRequest(f, '写一首诗'), { instanceId: 'host', operationRef: `unrelated-after-pending-${index}` });
      expect(unrelated.ok).toBe(true); if (!unrelated.ok) throw unrelated.error; await f.settle();
      expect(f.repos.readQueryContext(1)).toEqual(priorContext);
    }
    options.prediction = IntentResultSchema.parse(resolvedIntent());
    const second = await f.app.runs.submitAgent(nextRequest(f, '列出清单'), { instanceId: 'host', operationRef: 'ambiguous-response' });
    expect(second.ok).toBe(true); if (!second.ok) throw second.error; await f.settle();
    expect(f.repos.read({runId:second.data.runId!})).toMatchObject({kind:'one',run:{status:'completed',error:null}});
    expect(f.intentRequests.at(-1)!.input.pendingClarification).toEqual({ taskText: text, missingSlots: [] });
    expect(f.intentRequests.at(-1)!.input.recentTurns).toHaveLength(4);
    expect(f.chats()).toBe(4); expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});


for (const multiple of [false, true]) test(`p14 a completed ${multiple ? 'multi-intent' : 'freshness'} Agent clears the original clarification before the next classification`, async () => {
  const { definition: _definition, ...path } = INTENT_TAXONOMY.FRESHNESS;
  const item: IntentItem = { ...productIntent(), ...path, l2: 'FRESHNESS', parameters: { basis: null } };
  const options = { prediction: IntentResultSchema.parse({ ...resolvedIntent(), status: 'NEED_PARAMETERS', intents: [item],
    clarification: { question: 'Which date basis?', intentIds: ['s1'], missingSlots: ['s1.basis'], options: [] } }),
    allowMain: true, respond: (index: number) => index === 1 ? { role: 'assistant', tool_calls: (multiple ? ['s1', 's2'] : ['s1']).map((stepId, index) => ({ index, id: `resolved-${stepId}`, type: 'function',
      function: { name: 'query_intent_step', arguments: JSON.stringify({ stepId, part: 0 }) } })) }
      : { role: 'assistant', content: 'ENGINEERING resolved snapshot date 2026-10-04.' } };
  const f = await routedFixture('classify', options);
  try {
    const original = '检查数据新鲜度，请先确认使用什么日期。';
    const first = await f.app.runs.submitAgent({ ...f.request, text: original }, { instanceId: 'host', operationRef: 'freshness-pending' });
    expect(first.ok).toBe(true); if (!first.ok) throw first.error; await f.settle();
    expect(f.repos.readQueryContext(1)?.pendingClarification).toEqual({ taskText: original, missingSlots: ['s1.basis'] });
    options.prediction = IntentResultSchema.parse({ ...resolvedIntent(), intents: [{ ...item, parameters: { basis: 'snapshot_date' } },
      ...(multiple ? [{ ...productIntent(), id: 's2' }] : [])] });
    const resolved = await f.app.runs.submitAgent(nextRequest(f, '按快照日期'), { instanceId: 'host', operationRef: 'freshness-resolved' });
    expect(resolved.ok).toBe(true); if (!resolved.ok) throw resolved.error; await f.settle();
    expect(f.repos.readIntent({ runId: resolved.data.runId! })).toMatchObject({ decision: { route: 'agent' },
      execution: { runStatus: 'completed', finalHistorySaved: true } });
    expect(f.intentRequests.at(-1)!.input.pendingClarification?.taskText).toBe(original);
    expect(f.repos.readQueryContext(1)).toMatchObject(multiple ? { sourceRunId: first.data.runId,
      pendingClarification: { taskText: original } } : { sourceRunId: resolved.data.runId, pendingClarification: null });
    options.prediction = IntentResultSchema.parse(resolvedIntent());
    const next = await f.app.runs.submitAgent(nextRequest(f, '再列出器械'), { instanceId: 'host', operationRef: 'after-freshness-resolution' });
    expect(next.ok).toBe(true); if (!next.ok) throw next.error; await f.settle();
    expect(f.intentRequests.at(-1)!.input.pendingClarification).toBeNull();
    expect(f.chats()).toBe(3); expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
});

test('p14 oversized intent projection fails before HTTP with its registered input error', async () => {
  const f = await routedFixture('classify');
  try {
    const accepted = await f.app.runs.submitAgent({ ...f.request, text: '医疗器械' + 'context '.repeat(4000) },
      { instanceId: 'host', operationRef: 'oversized-frozen-task' });
    expect(accepted.ok).toBe(true); if (!accepted.ok) throw accepted.error; await f.settle();
    const read = f.repos.read({ runId: accepted.data.runId! });
    expect(read.kind === 'one' && read.run?.error?.code).toBe('intent_input_too_large');
    expect(f.chats()).toBe(0); expect(f.requests).toHaveLength(0);
    expect(f.repos.readQueryContext(1)).toBeNull();
  } finally { await f.close(); }
});


test('p14 known unsupported data retains its determined task without Query execution and rejects a forged pending task', async () => {
  const { definition: _definition, ...path } = INTENT_TAXONOMY.CERT_EXPIRY_WARNING;
  const f = await routedFixture('classify', { intents: [{ ...productIntent(), ...path, l2: 'CERT_EXPIRY_WARNING', parameters: { withinDays: 30 } }] });
  try {
    const accepted = await f.app.runs.submitAgent({ ...f.request, text: '请检查30天内到期的医疗器械注册证' },
      { instanceId: 'host', operationRef: 'unsupported-pending-task' });
    expect(accepted.ok).toBe(true); if (!accepted.ok) throw accepted.error; await f.settle();
    const context = f.repos.readQueryContext(1);
    expect(context).toMatchObject({ sourceRunId: accepted.data.runId, taskIntents: [{ l2: 'CERT_EXPIRY_WARNING' }], queryIds: [],
      pendingClarification: { taskText: '请检查30天内到期的医疗器械注册证' } });
    expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(accepted.data.runId!)).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
    const entry = f.db.query<{entry_json:string},[number,string]>('SELECT entry_json FROM memories WHERE session_id=? AND native_entry_id=?').get(1,context!.nativeLeafId)!;
    const native = JSON.parse(entry.entry_json); native.data.pendingClarification.taskText = 'forged original task';
    f.db.query('UPDATE memories SET entry_json=? WHERE session_id=? AND native_entry_id=?').run(JSON.stringify(native),1,context!.nativeLeafId);
    f.db.query('UPDATE query_contexts SET pending_clarification_json=? WHERE session_id=1').run(JSON.stringify(native.data.pendingClarification));
    expect(() => f.repos.readQueryContext(1)).toThrow('storage_read_failed');
  } finally { await f.close(); }
});
