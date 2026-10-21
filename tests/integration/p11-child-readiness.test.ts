import { expect, test } from 'bun:test';
import { FrozenChildConfigSchema } from '../../packages/contracts/src/subagent';
import { legacyChildConfig } from '../../packages/storage/src/legacy-business-fields';
import { agentRuntimeFixture } from '../fixtures/agent-runtime';
import { p13AgentInput } from '../fixtures/p13-subagent';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

test('p11 Skill requirements preserve original read-only child delegation and saved identities', async () => {
  const f = await agentRuntimeFixture(index => index === 1
    ? { role: 'assistant', tool_calls: [{ index: 0, id: 'readiness-Agent', type: 'function', function: { name: 'Agent', arguments: JSON.stringify(p13AgentInput) } }] }
    : { role: 'assistant', content: index === 2 ? 'ENGINEERING_CHILD_READINESS' : 'ENGINEERING_PARENT_READINESS' });
  try {
    const accepted = await f.app.runs.submitAgent(f.request('ENGINEERING inspect via the existing read-only child'), { instanceId: 'host', operationRef: 'p11-child-readiness' });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('No parent Run');
    await f.settle();
    expect(f.repos.read({ runId: accepted.data.runId! })).toMatchObject({ kind: 'one', run: { status: 'completed' } });
    const child = f.db.query<{ id: number; session_id: number; config_json: string; child_result_json: string }, []>("SELECT id,session_id,config_json,child_result_json FROM runs WHERE kind='child'").get();
    expect(child).not.toBeNull();
    const frozen = FrozenChildConfigSchema.parse(legacyChildConfig(JSON.parse(child!.config_json).subagent));
    expect(frozen.resources?.skillRequirements).toEqual(f.repos.readRunResources(accepted.data.runId!)?.skillRequirements);
    expect(frozen.resources?.skillRequirements).toMatchObject([{ resourceRef: f.skill, requiredTools: ['check_data_coverage', 'read', 'read_data_scope'] }]);
    expect(frozen.scope.readOnly).toBe(true);
    expect(frozen.toolNames).not.toContain('Agent');
    for (const tool of ['edit', 'write', 'bash', 'powershell']) expect(frozen.toolNames).not.toContain(tool);
    expect(frozen.parentRunId).toBe(accepted.data.runId!);
    expect(frozen.childSessionId).toBe(child!.session_id);
    expect(JSON.parse(child!.child_result_json)).toMatchObject({ outcome: 'completed', text: 'ENGINEERING_CHILD_READINESS' });
    expect(f.requests).toHaveLength(3);
    expect(JSON.stringify(f.requests[2]!.messages)).toContain('ENGINEERING_CHILD_READINESS');
    expect(f.db.query('SELECT id FROM session_inputs WHERE session_id=?').all(child!.session_id)).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 20000);

test('p11 a child with narrower Tools receives diagnostics without indexing an unready parent Skill',async()=>{
  const f=await agentRuntimeFixture(index=>index===1?{role:'assistant',tool_calls:[{index:0,id:'readiness-narrow-Agent',type:'function',function:{name:'Agent',arguments:JSON.stringify(p13AgentInput)}}]}:{role:'assistant',content:'ENGINEERING narrowed scope response'});
  try{
    const path=join(f.author,'catalog.json'),catalog=JSON.parse(readFileSync(path,'utf8'));
    catalog.definitions.find((item:{kind:string;id:string})=>item.kind==='skill'&&item.id==='query').requiredTools.push('bash');
    writeFileSync(path,JSON.stringify(catalog));
    const accepted=await f.app.runs.submitAgent(f.request('inspect using original read-only delegation'),{instanceId:'host',operationRef:'narrow-skill'});
    expect(accepted.ok).toBe(true);await f.settle();expect(f.requests).toHaveLength(3);
    const system=(index:number)=>(f.requests[index]!.messages as {role:string;content:string}[]).find(m=>m.role==='system')!.content;
    expect(system(0)).toContain('<available_skills>');expect(system(0)).toContain('query@v1: ready (4/4 capabilities)');
    expect(system(1)).toContain('query@v1: partial (3/4 capabilities)');expect(system(1)).not.toContain('<available_skills>');
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
},20000);
