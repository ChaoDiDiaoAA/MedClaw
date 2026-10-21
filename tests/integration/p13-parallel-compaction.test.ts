import { expect, test } from 'bun:test';
import { agentRuntimeFixture } from '../fixtures/agent-runtime';
import { DEFAULT_AGENT_POLICY, normalizeRuntimeConfiguration } from '../../packages/contracts/src/runtime-config';

test('P13 two real child compactions share the exact root budget and retain independent summary usage', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const summaryRequests: { marker: string; index: number; inputTokens: number }[] = [];
  const childTurns = new Map<string, number>(), requestUsage = new Map<number, {prompt_tokens:number;completion_tokens:number;total_tokens:number}>();
  let parents = 0;
  const f = await agentRuntimeFixture(async (index, payload) => {
    const tools = payload.tools as {function:{name:string}}[] | undefined, messages = JSON.stringify(payload.messages);
    const setUsage = (input: number) => requestUsage.set(index, {prompt_tokens:input,completion_tokens:2,total_tokens:input+2});
    if (messages.includes('<subagent_roles>')) {
      setUsage(10); parents++;
      if (parents === 1) return {role:'assistant',tool_calls:['A','B'].map((marker, toolIndex) => ({index:toolIndex,id:'parallel-compact-'+marker,type:'function',
        function:{name:'Agent',arguments:JSON.stringify({prompt:`COMPACT_CHILD_${marker}\n`+'ENGINEERING child context '.repeat(100),description:'Review '+marker,subagent_type:'medclaw-audit'})}}))};
      return {role:'assistant',content:'ENGINEERING parent reconciled both independently compacted child results.'};
    }
    const marker = messages.includes('COMPACT_CHILD_A') ? 'A' : messages.includes('COMPACT_CHILD_B') ? 'B' : 'missing';
    expect(marker).not.toBe('missing');
    if (!tools?.length) {
      const inputTokens = 101 + summaryRequests.length;
      setUsage(inputTokens); summaryRequests.push({marker,index,inputTokens});
      await barrier;
      return {role:'assistant',content:`ENGINEERING independent summary for child ${marker}.`};
    }
    const turn = (childTurns.get(marker) ?? 0) + 1; childTurns.set(marker, turn);
    setUsage(turn === 2 ? 32600 : 10);
    if (turn === 1) return {role:'assistant',tool_calls:[{index:0,id:'parallel-compact-read-'+marker,type:'function',function:{name:'read_data_scope',arguments:'{}'}}]};
    return {role:'assistant',content:`ENGINEERING child ${marker} reply `.repeat(100)};
  }, false, index => {
    const usage = requestUsage.get(index); if (!usage) throw new Error('Missing actual request usage'); return usage;
  }, undefined, true);
  const describe = f.agent.describe.bind(f.agent);
  f.agent.describe = resolved => ({...describe(resolved),compaction:{contract:'medclaw.compaction/v1',enabled:true,reserveTokens:256,keepRecentTokens:128}});
  try {
    const configuration = normalizeRuntimeConfiguration({requestPolicy:f.app.config.requestPolicy}); configuration.runBudget.maxModelCalls = 8;
    f.app.config.runtimeConfiguration = configuration; f.app.config.agentPolicy = {...DEFAULT_AGENT_POLICY,maxModelCalls:8};
    const accepted = await f.app.runs.submitAgent(f.request('ENGINEERING independently review two long tasks'),{instanceId:'host',operationRef:'parallel-compaction-parent'});
    expect(accepted.ok).toBe(true);
    for(let i=0;i<1000&&summaryRequests.length<2&&f.app.runs.busy;i++)await Bun.sleep(5);
    expect(summaryRequests).toHaveLength(2);
    expect(new Set(summaryRequests.map(summary=>summary.marker))).toEqual(new Set(['A','B']));
    expect(f.db.query("SELECT id FROM model_calls WHERE kind='compaction' AND state='started'").all()).toHaveLength(2);
    expect(f.requests).toHaveLength(7);
    release(); await f.settle();
    expect(parents).toBe(2); expect([...childTurns.values()]).toEqual([2,2]); expect(f.requests).toHaveLength(8);
    const children = f.db.query<{id:number;session_id:number;status:string;input_text:string},[]>("SELECT id,session_id,status,input_text FROM runs WHERE kind='child' ORDER BY id").all();
    expect(children).toHaveLength(2); expect(children.map(child=>child.status)).toEqual(['completed','completed']);
    const compactions = f.db.query<{run_id:number;session_id:number;input_id:number|null;state:string;input_tokens:number;output_tokens:number;model_json:string},[]>("SELECT run_id,session_id,input_id,state,input_tokens,output_tokens,model_json FROM model_calls WHERE kind='compaction' ORDER BY input_tokens").all();
    expect(compactions.map(call=>call.input_tokens)).toEqual([101,102]);
    expect(compactions.map(call=>call.output_tokens)).toEqual([2,2]);
    for(const child of children) {
      const marker = /COMPACT_CHILD_([AB])/.exec(child.input_text)?.[1], request = summaryRequests.find(summary=>summary.marker===marker);
      expect(request).toBeDefined();
      const calls = compactions.filter(call=>call.run_id===child.id);
      expect(calls).toEqual([expect.objectContaining({session_id:child.session_id,input_id:null,state:'completed',input_tokens:request!.inputTokens})]);
      expect(f.db.query("SELECT native_entry_id,json_extract(entry_json,'$.summary') summary FROM memories WHERE session_id=? AND entry_type='compaction'").all(child.session_id))
        .toEqual([{native_entry_id:JSON.parse(calls[0]!.model_json).compaction.nativeEntryId,summary:expect.stringContaining(`ENGINEERING independent summary for child ${marker}.`)}]);
      expect(f.db.query("SELECT id FROM model_calls WHERE run_id=? AND state='completed'").all(child.id)).toHaveLength(3);
      expect(f.db.query("SELECT id FROM runtime_events WHERE run_id=? AND type='compaction_completed'").all(child.id)).toHaveLength(1);
    }
    expect(f.db.query("SELECT id FROM model_calls WHERE state='completed'").all()).toHaveLength(8);
    expect(f.db.query("SELECT id FROM model_calls WHERE state<>'completed'").all()).toHaveLength(0);
    expect(f.repos.read({runId:1})).toMatchObject({kind:'one',run:{status:'completed',groupUsage:{parent:{modelCalls:2,toolCalls:2,inputTokens:20,outputTokens:4},children:{modelCalls:6,toolCalls:2,inputTokens:65423,outputTokens:12}}}});
    expect(f.errors).toEqual([]);
  } finally {release();await f.close();}
},30_000);
