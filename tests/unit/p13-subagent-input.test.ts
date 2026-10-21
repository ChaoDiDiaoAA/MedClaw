import { expect, test } from 'bun:test';
import { agentRuntimeFixture } from '../fixtures/agent-runtime';
import { createResourceSource } from '../../packages/runtime-pi/src/resource-loader';
import { join } from 'node:path';

test('p13 explicit delegation plans preserve original source and bypass business prompt wrapping', async () => {
  const f = await agentRuntimeFixture(undefined, false, undefined, undefined, true);
  try {
    const resources = f.app.resources!, scope = { batchIds: [], deviceIds: null, artifactIds: [], readOnly: false, allowedToolNames: [...f.agent.toolNames!], allowedResourceRefs: [] };
    const frozen = await resources.freeze(1, f.app.config, scope), roles = await resources.freezeSubagents(1, scope);
    const command = await resources.prepareInput(frozen, f.request('/subagent general-analyst Compare the supplied evidence.'), roles);
    expect(command).toMatchObject({kind:'subagent_command',resourceRef:null,source:{name:'subagent',roleId:'general-analyst',task:'Compare the supplied evidence.'}});
    const template = await resources.prepareInput(frozen, f.request('/parallel-medclaw-review Compare facts'), roles);
    expect(template).toMatchObject({kind:'subagent_template',resourceRef:null,source:{templateName:'parallel-medclaw-review',file:'subagent-prompts/parallel-medclaw-review.md'}});
    expect(template.dispatchText).toBe('/parallel-medclaw-review Compare facts');
    await expect(resources.prepareInput(frozen, f.request('/subagent missing-role task'), roles)).rejects.toMatchObject({code:'resource_unavailable'});
    await expect(resources.prepareInput(frozen, {...f.request('/subagent general-analyst task'),mode:'steer',targetRunId:1}, roles)).rejects.toMatchObject({code:'state_conflict'});
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});

test('p13 input command directory is a zero execution catalog, separate from business prompt versions', async () => {
  const f = await agentRuntimeFixture(undefined, true, undefined, undefined, true);
  try {
    const directory = await f.app.listInputCommands({sessionId:1});
    expect(new Set(directory.items.map(item => item.group))).toEqual(new Set(['skills','subagents','prompt_templates','extension_commands']));
    expect(directory.items.find(item => item.command === '/subagent')).toMatchObject({registered:false,owner:null});
    expect(directory.items.find(item => item.id === 'general-analyst')).toMatchObject({available:true});
    expect(directory.items.find(item => item.command === '/query')).toMatchObject({group:'prompt_templates',available:true});
    expect((await f.source.discover()).items.some(item=>item.ref.id==='parallel-medclaw-review')).toBe(false);
    expect(f.requests).toHaveLength(0);
    expect(f.db.query('SELECT count(*) AS n FROM runs').get()).toEqual({n:0});
    const source = createResourceSource(join(f.author));
    expect((await source.captureSubagentTemplate!('medclaw-evidence-review')).content).toContain('$ARGUMENTS');
  } finally { await f.close(); }
});
