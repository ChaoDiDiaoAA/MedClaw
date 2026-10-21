import { expect, test } from 'bun:test';
import { agentRuntimeFixture } from '../fixtures/agent-runtime';

test('P13 an active Run keeps its role body while the next Run in the same Session uses the saved revision', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let parents = 0;
  const childPayloads: Record<string, unknown>[] = [];
  const f = await agentRuntimeFixture(async (_index, payload) => {
    const tools = payload.tools as { function: { name: string } }[] | undefined;
    if (tools?.some(tool => tool.function.name === 'Agent')) {
      parents++;
      if (parents === 1) await barrier;
      if (parents % 2 === 1) return { role: 'assistant', tool_calls: [{ index: 0, id: 'role-revision-origin-' + parents,
        type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ prompt: 'Analyze only this supplied task material.', description: 'Independent role revision review', subagent_type: 'general-analyst' }) } }] };
      return { role: 'assistant', content: 'ENGINEERING parent checked the independent analysis.' };
    }
    childPayloads.push(payload);
    expect(tools ?? []).toEqual([]);
    return { role: 'assistant', content: 'ENGINEERING child completed supplied-material analysis.' };
  }, false, undefined, undefined, true);
  try {
    const service = f.app.resources!;
    const original = await service.readSubagent({ source: 'selection', sessionId: 1, roleId: 'general-analyst' });
    const oldBody = original.content + '\nENGINEERING_ROLE_OLD_REVISION\n';
    const newBody = original.content + '\nENGINEERING_ROLE_NEW_REVISION\n';
    await service.saveSubagent({ sessionId: 1, roleId: 'general-analyst', content: oldBody, expectedContent: original.content });
    const first = await f.app.runs.submitAgent(f.request('ENGINEERING first task'), { instanceId: 'host', operationRef: 'role-revision-first' });
    expect(first.ok).toBe(true); if (!first.ok || !first.data.runId) throw new Error('Missing first Run');
    for (let i = 0; i < 500 && parents < 1; i++) await Bun.sleep(2);
    expect(parents).toBe(1); expect(childPayloads).toHaveLength(0);
    await service.saveSubagent({ sessionId: 1, roleId: 'general-analyst', content: newBody, expectedContent: oldBody });
    expect(f.requests).toHaveLength(1);
    expect(await service.readSubagent({ source: 'run', runId: first.data.runId, roleId: 'general-analyst' })).toMatchObject({ content: oldBody });
    release(); await f.settle();
    expect(childPayloads).toHaveLength(1);
    expect(JSON.stringify(childPayloads[0]!.messages)).toContain('ENGINEERING_ROLE_OLD_REVISION');
    expect(JSON.stringify(childPayloads[0]!.messages)).not.toContain('ENGINEERING_ROLE_NEW_REVISION');
    const second = await f.app.runs.submitAgent(f.request('ENGINEERING second task in the original Session'), { instanceId: 'host', operationRef: 'role-revision-second' });
    expect(second.ok).toBe(true); if (!second.ok || !second.data.runId) throw new Error('Missing second Run');
    await f.settle();
    expect(childPayloads).toHaveLength(2);
    expect(JSON.stringify(childPayloads[1]!.messages)).toContain('ENGINEERING_ROLE_NEW_REVISION');
    expect(JSON.stringify(childPayloads[1]!.messages)).not.toContain('ENGINEERING_ROLE_OLD_REVISION');
    expect(await service.readSubagent({ source: 'run', runId: second.data.runId, roleId: 'general-analyst' })).toMatchObject({ content: newBody });
    expect(f.repos.read({ runId: first.data.runId })).toMatchObject({ kind: 'one', run: { status: 'completed', sessionId: 1 } });
    expect(f.repos.read({ runId: second.data.runId })).toMatchObject({ kind: 'one', run: { status: 'completed', sessionId: 1 } });
    const children = f.db.query<{ parent_run_id: number; config_json: string }, []>("SELECT parent_run_id,config_json FROM runs WHERE kind='child' ORDER BY id").all();
    expect(children.map(row => [row.parent_run_id, JSON.parse(row.config_json).subagent.role.content])).toEqual([[first.data.runId, oldBody], [second.data.runId, newBody]]);
    expect(f.requests).toHaveLength(6);
  } finally { release(); await f.close(); }
}, 20_000);
