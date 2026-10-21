import { expect, test } from 'bun:test';
import { agentRuntimeFixture } from '../fixtures/agent-runtime';
import { DEFAULT_AGENT_POLICY, normalizeRuntimeConfiguration } from '../../packages/contracts/src/runtime-config';

test('P13 a registered Agent and short role index do not start any child until the parent calls Agent',async()=>{
  const f=await agentRuntimeFixture((_index,payload)=>{
    expect((payload.tools as {function:{name:string}}[]).some(tool=>tool.function.name==='Agent')).toBe(true);
    const messages=JSON.stringify(payload.messages);expect(messages).toContain('<subagent_roles>');
    expect(messages).toContain('general-analyst');expect(messages).not.toContain('Analyze only the task materials supplied by the parent.');
    return {role:'assistant',content:'ENGINEERING the supplied material is sufficient without delegation.'};
  },false,undefined,undefined,true);
  try{
    expect((await f.app.runs.submitAgent(f.request('Answer from the supplied material.'),{instanceId:'host',operationRef:'registered-only-input'})).ok).toBe(true);
    await f.settle();expect(f.requests).toHaveLength(1);
    expect(f.db.query("SELECT id FROM sessions WHERE kind='child'").all()).toHaveLength(0);
    expect(f.db.query("SELECT id FROM runs WHERE kind='child'").all()).toHaveLength(0);
    expect(f.repos.read({runId:1})).toMatchObject({kind:'one',run:{status:'completed',groupUsage:{children:{modelCalls:0,toolCalls:0,inputTokens:0,outputTokens:0}}}});
  }finally{await f.close();}
});

test('P13 four real child requests retain separate original calls and a fifth returns busy without a child', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let children = 0, parents = 0, audits=0;
  const roles=['general-analyst','medclaw-audit','general-analyst','medclaw-audit'];
  const f = await agentRuntimeFixture(async (_index, payload) => {
    const tools = payload.tools as { function: { name: string } }[] | undefined;
    const serialized=JSON.stringify(payload.messages);
    if (serialized.includes('<subagent_roles>')) {
      expect(serialized).toContain('general-analyst');
      expect(serialized).toContain('medclaw-audit');
      parents++;
      if (parents === 1) return { role: 'assistant', tool_calls: Array.from({ length: 5 }, (_, index) => ({ index,
        id: 'parallel-original-' + index, type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ prompt: 'Same task material for independent analysis.',
          description: 'Independent review ' + index, subagent_type: roles[index]??'general-analyst', run_in_background: false }) } })) };
      return { role: 'assistant', content: 'ENGINEERING parent completed its review.' };
    }
    children++;
    if(serialized.includes('Verify the parent task using only')){audits++;expect(tools).toHaveLength(19);expect(tools!.some(tool=>tool.function.name==='read_data_scope')).toBe(true);
      expect(tools!.some(tool=>['Agent','query_intent_step','edit','write','bash','powershell'].includes(tool.function.name))).toBe(false);}
    else {expect(serialized).toContain('Analyze only the task materials supplied by the parent.');expect(tools ?? []).toEqual([]);}
    await barrier;
    return { role: 'assistant', content: 'ENGINEERING child analysis, no external access.' };
  }, false, () => ({prompt_tokens:10,completion_tokens:2,total_tokens:12}), undefined, true);
  const open=Reflect.get(f.agent,'openManagedChild').bind(f.agent);
  Reflect.set(f.agent,'openManagedChild',async(...args:Parameters<typeof open>)=>{
    const session=await open(...args),request=args[2];
    if(request&&typeof request==='object'&&'roleId' in request&&request.roleId==='general-analyst'){
      expect(session.getAllTools()).toEqual([]);expect(session.getActiveToolNames()).toEqual([]);
    }else{expect(session.getAllTools()).toHaveLength(19);expect(session.getActiveToolNames()).toContain('read_data_scope');}
    return session;
  });
  try {
    // Keep tools available on all four child requests; a separate case tests the final reserved slot.
    const configuration=normalizeRuntimeConfiguration({requestPolicy:f.app.config.requestPolicy});configuration.runBudget.maxModelCalls=7;
    f.app.config.runtimeConfiguration=configuration;
    f.app.config.agentPolicy={...DEFAULT_AGENT_POLICY,maxModelCalls:7};
    const accepted = await f.app.runs.submitAgent(f.request('ENGINEERING four independent reviews'), { instanceId: 'host', operationRef: 'parallel-parent-input' });
    expect(accepted.ok).toBe(true);
    for (let i = 0; i < 500 && children < 4 && f.app.runs.busy; i++) await Bun.sleep(5);
    expect(children).toBe(4);
    const owned = f.db.query<{ id: number; origin_tool_call_id: number; config_json: string }, []>("SELECT id,origin_tool_call_id,config_json FROM runs WHERE kind='child' ORDER BY id").all();
    expect(owned).toHaveLength(4);
    expect(new Set(owned.map(child => child.origin_tool_call_id)).size).toBe(4);
    for (const child of owned){const frozen=JSON.parse(child.config_json).subagent,index=Number(frozen.originNativeToolCallId.split('-').at(-1));
      expect(frozen.role.roleId).toBe(roles[index]);expect(frozen.toolNames).toEqual(frozen.role.declaredTools);
      expect(frozen.toolNames).toHaveLength(roles[index]==='general-analyst'?0:19);}
    release(); await f.settle();
    expect(children).toBe(4); expect(parents).toBe(2);expect(audits).toBe(2);
    expect(f.repos.read({ runId: 1 })).toMatchObject({ kind: 'one', run: { status: 'completed',groupUsage:{parent:{modelCalls:2,inputTokens:20,outputTokens:4},children:{modelCalls:4,inputTokens:40,outputTokens:8}} } });
    expect(f.db.query("SELECT id FROM runs WHERE kind='child' AND status='completed'").all()).toHaveLength(4);
    const fifth = f.db.query<{ error_json: string }, [string]>('SELECT error_json FROM tool_calls WHERE native_tool_call_id=?').get('parallel-original-4');
    expect(JSON.parse(fifth!.error_json)).toMatchObject({ code: 'runtime_busy' });
    expect(f.requests).toHaveLength(6);
  } finally { release(); await f.close(); }
}, 20_000);

test('P13 stopping one real child preserves its parent and siblings until their own work finishes', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let children = 0, parents = 0;
  const f = await agentRuntimeFixture(async (_index, payload) => {
    const tools = payload.tools as { function: { name: string } }[] | undefined;
    if (tools?.some(tool => tool.function.name === 'Agent')) {
      parents++;
      if (parents === 1) return { role: 'assistant', tool_calls: Array.from({length:3}, (_, index) => ({index,
        id:'partial-stop-'+index,type:'function',function:{name:'Agent',arguments:JSON.stringify({prompt:'Independent provided material.',description:'Review '+index,subagent_type:'general-analyst'})}})) };
      return {role:'assistant',content:'ENGINEERING parent retained the two successful reviews and cancellation.'};
    }
    children++; await barrier;
    return {role:'assistant',content:'ENGINEERING sibling completed.'};
  }, false, undefined, undefined, true);
  try {
    expect((await f.app.runs.submitAgent(f.request('ENGINEERING three reviews'), {instanceId:'host',operationRef:'partial-stop-input'})).ok).toBe(true);
    for(let i=0;i<500&&children<3&&f.app.runs.busy;i++)await Bun.sleep(5);
    expect(children).toBe(3);
    const ids=f.db.query<{id:number},[]>("SELECT id FROM runs WHERE kind='child' ORDER BY id").all().map(row=>row.id);
    expect(ids).toHaveLength(3);
    const stopped=await f.app.runs.cancel(ids[0]!);expect(stopped.ok).toBe(true);
    for(let i=0;i<500;i++) {const result=f.repos.read({runId:ids[0]!});if(result.kind==='one'&&result.run?.status==='cancelled')break;await Bun.sleep(5);}
    expect(f.repos.read({runId:ids[0]!})).toMatchObject({kind:'one',run:{status:'cancelled',cleanup:{stopConfirmed:true,requiredPersistenceComplete:true,resourcesReleased:true}}});
    expect(f.repos.read({runId:1})).toMatchObject({kind:'one',run:{status:'running',cancelRequestedAt:null}});
    for(const id of ids.slice(1))expect(f.repos.read({runId:id})).toMatchObject({kind:'one',run:{status:'running',cancelRequestedAt:null}});
    expect(parents).toBe(1);expect(f.app.runs.busy).toBe(true);
    release();await f.settle();
    expect(f.repos.read({runId:1})).toMatchObject({kind:'one',run:{status:'completed'}});
    for(const id of ids.slice(1))expect(f.repos.read({runId:id})).toMatchObject({kind:'one',run:{status:'completed'}});
    expect(f.requests).toHaveLength(5);
  } finally {release();await f.close();}
},20_000);

test('P13 a child final-save gap stops all siblings and keeps the root occupied until the original facts are saved',async()=>{
  let release!:()=>void,ready!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),allStarted=new Promise<void>(resolve=>{ready=resolve;});let children=0;
  const f=await agentRuntimeFixture(async(_index,payload)=>{
    if(JSON.stringify(payload.messages).includes('<subagent_roles>'))return {role:'assistant',tool_calls:Array.from({length:4},(_,index)=>({index,id:'save-all-'+index,type:'function',
      function:{name:'Agent',arguments:JSON.stringify({prompt:'save-gap-child-'+index,description:'Review '+index,subagent_type:'general-analyst'})}}))};
    children++;if(children===4)ready();
    if(JSON.stringify(payload.messages).includes('save-gap-child-0'))await allStarted;else await gate;
    return {role:'assistant',content:'ENGINEERING original child result.'};
  },false,undefined,undefined,true);
  const finalize=f.repos.finalizeChild.bind(f.repos);let reject=true,failedChild:number|undefined;
  f.repos.finalizeChild=(id,fact)=>{if(fact.status==='completed'){failedChild??=id;if(reject)throw new Error('ENGINEERING child final save unavailable');}return finalize(id,fact);};
  try{
    const accepted=await f.app.runs.submitAgent(f.request('ENGINEERING stop siblings on save gap'),{instanceId:'host',operationRef:'save-all-input'});
    if(!accepted.ok)throw accepted.error;await allStarted;
    const execution=Reflect.get(f.app.runs,'execution');await execution.task;
    expect(f.requests).toHaveLength(5);expect(f.app.runs.busy).toBe(true);expect(failedChild).toBeGreaterThan(1);
    expect(f.app.runs.readInputControl(1)?.acceptingInputs).toBe(false);
    const siblings=f.db.query<{id:number},[number]>("SELECT id FROM runs WHERE kind='child' AND id<>?").all(failedChild!);expect(siblings).toHaveLength(3);
    for(const {id} of siblings)expect(f.repos.read({runId:id})).toMatchObject({kind:'one',run:{status:'cancelled',cleanup:{stopConfirmed:true,requiredPersistenceComplete:true,resourcesReleased:true}}});
    expect((await f.app.runs.submitAgent(f.request('Must remain blocked.'),{instanceId:'host',operationRef:'save-all-blocked'})).ok).toBe(false);
    reject=false;expect((await f.app.runs.retrySave(accepted.data.runId!)).ok).toBe(true);await f.settle();
    expect(f.repos.read({runId:failedChild!})).toMatchObject({kind:'one',run:{status:'completed',childResult:{outcome:'completed'}}});
    expect(f.repos.read({runId:accepted.data.runId!})).toMatchObject({kind:'one',run:{status:'failed',cleanup:{requiredPersistenceComplete:true,resourcesReleased:true}}});
    expect(f.requests).toHaveLength(5);
  }finally{reject=false;release();f.repos.finalizeChild=finalize;if(f.app.runs.activeHandle)await f.app.runs.retrySave(f.app.runs.activeHandle.runId);await f.close();}
},20_000);

test('P13 sibling budget exhaustion rejects the next child request while preserving the last parent request',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let parents=0,children=0;
  const f=await agentRuntimeFixture(async(_index,payload)=>{
    if(JSON.stringify(payload.messages).includes('<subagent_roles>')){
      if(++parents===1)return {role:'assistant',tool_calls:Array.from({length:4},(_,index)=>({index,id:'budget-child-'+index,type:'function',
        function:{name:'Agent',arguments:JSON.stringify({prompt:'Independent material '+index,description:'Review '+index,subagent_type:'general-analyst'})}}))};
      return {role:'assistant',content:'ENGINEERING parent summarizes successful reviews and the budget failure.'};
    }
    children++;await gate;return {role:'assistant',content:'ENGINEERING completed within the shared budget.'};
  },false,undefined,undefined,true);
  try{
    const configuration=normalizeRuntimeConfiguration({requestPolicy:f.app.config.requestPolicy});configuration.runBudget.maxModelCalls=5;
    f.app.config.runtimeConfiguration=configuration;f.app.config.agentPolicy={...DEFAULT_AGENT_POLICY,maxModelCalls:5};
    expect((await f.app.runs.submitAgent(f.request('ENGINEERING bounded parallel review'),{instanceId:'host',operationRef:'budget-four-input'})).ok).toBe(true);
    for(let i=0;i<500&&children<3&&f.app.runs.busy;i++)await Bun.sleep(5);expect(children).toBe(3);
    release();await f.settle();expect(children).toBe(3);expect(parents).toBe(2);expect(f.requests).toHaveLength(5);
    expect(f.repos.read({runId:1})).toMatchObject({kind:'one',run:{status:'completed',groupUsage:{parent:{modelCalls:2},children:{modelCalls:3}}}});
    expect(f.db.query("SELECT id FROM runs WHERE kind='child' AND status='completed'").all()).toHaveLength(3);
    expect(f.db.query("SELECT id FROM runs WHERE kind='child' AND status='failed'").all()).toHaveLength(1);
  }finally{release();await f.close();}
},20_000);

test('P13 Root Stop cancels all four real child requests before releasing root ownership',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let children=0;
  const f=await agentRuntimeFixture(async (_index,payload)=>{
    const tools=payload.tools as {function:{name:string}}[]|undefined;
    if(tools?.some(tool=>tool.function.name==='Agent'))return {role:'assistant',tool_calls:Array.from({length:4},(_,index)=>({index,id:'root-stop-'+index,type:'function',
      function:{name:'Agent',arguments:JSON.stringify({prompt:'Independent provided material.',description:'Review '+index,subagent_type:'general-analyst'})}}))};
    children++;await gate;return {role:'assistant',content:'ENGINEERING response after cancellation.'};
  },false,undefined,undefined,true);
  try{
    expect((await f.app.runs.submitAgent(f.request('ENGINEERING root stop'),{instanceId:'host',operationRef:'root-stop-input'})).ok).toBe(true);
    for(let i=0;i<500&&children<4&&f.app.runs.busy;i++)await Bun.sleep(5);
    expect(children).toBe(4);
    await f.app.runs.cancel(1);await f.settle();
    expect(f.repos.read({runId:1})).toMatchObject({kind:'one',run:{status:'cancelled',cleanup:{stopConfirmed:true,requiredPersistenceComplete:true,resourcesReleased:true}}});
    const owned=f.db.query<{id:number},[]>("SELECT id FROM runs WHERE kind='child'").all();expect(owned).toHaveLength(4);
    for(const {id} of owned)expect(f.repos.read({runId:id})).toMatchObject({kind:'one',run:{status:'cancelled',childResult:{outcome:'cancelled'},cleanup:{stopConfirmed:true,requiredPersistenceComplete:true,resourcesReleased:true}}});
    expect(f.requests).toHaveLength(5);
  }finally{release();await f.close();}
},20_000);
