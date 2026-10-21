import {expect,test} from 'bun:test';
import {agentRuntimeFixture} from '../fixtures/agent-runtime';
import {contextMessageText} from '../../packages/runtime-pi/src/messages';

test('p11 first model request contains original Skill index and readiness but no Skill or reference body',async()=>{
  const f=await agentRuntimeFixture();
  try {
    const result=await f.app.runs.submitAgent(f.request('answer without reading unnecessary resources'),{instanceId:'host',operationRef:'progressive-index'});
    expect(result.ok).toBe(true);if(!result.ok||!result.data.runId)throw new Error('Run missing');
    await f.settle();
    expect(f.requests).toHaveLength(1);
    const messages=f.requests[0]!.messages as {role:string;content:unknown}[];
    const systems=messages.filter(m=>m.role==='system').map(m=>contextMessageText(m.content)??'').join('\n');
    expect(systems).toContain('<available_skills>');
    expect(systems).toContain('<skill_readiness>');
    expect(systems).toContain('query@v1: ready (3/3 capabilities)');
    expect(systems.split('<skill_readiness>')).toHaveLength(2);
    const all=messages.map(m=>contextMessageText(m.content)??'').join('\n');
    expect(all).not.toContain('# Query MedClaw data');
    expect(all).not.toContain('# Facts and assumptions');
    const call=f.db.query<{model_json:string},[]>('SELECT model_json FROM model_calls').get()!;
    const context=JSON.parse(call.model_json).context;
    expect(context.resources.readiness).toContain('query@v1: ready (3/3 capabilities)');
    expect(context.resources.payload.readiness).toBe(context.resources.readiness);
    expect(f.db.query('SELECT id FROM tool_calls').all()).toHaveLength(0);
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
},15000);

test('p11 a selected Skill missing a required Tool has a diagnostic without a callable SDK path',async()=>{
  const f=await agentRuntimeFixture();try{
    const discover=f.source.discover.bind(f.source);
    f.source.discover=async()=>{const result=await discover();return {...result,items:result.items.map(item=>item.ref.kind==='skill'&&item.ref.id==='query'?{...item,requiredTools:[...item.requiredTools!,'unavailable_tool']}:item)};};
    const accepted=await f.app.runs.submitAgent(f.request('answer the unrelated question'),{instanceId:'host',operationRef:'partial-skill'});
    expect(accepted.ok).toBe(true);if(!accepted.ok)throw new Error('No Run');await f.settle();
    expect(f.requests).toHaveLength(1);
    const systems=(f.requests[0]!.messages as {role:string;content:unknown}[]).filter(m=>m.role==='system').map(m=>contextMessageText(m.content)??'').join('\n');
    expect(systems).toContain('query@v1: partial (3/4 capabilities)');
    expect(systems).toContain('unavailable_tool');
    expect(systems).not.toContain('<available_skills>');expect(systems).not.toContain('<location>');
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
},15000);
