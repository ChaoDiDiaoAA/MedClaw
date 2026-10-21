import {expect,test} from 'bun:test';
import {unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {ResourceService} from '../../packages/core/src/resources/resource-service';
import {agentRuntimeFixture} from '../fixtures/agent-runtime';

test('p11 readiness keeps Tool matches when disabled or invalid and freezes omitted declarations',async()=>{
  const f=await agentRuntimeFixture();
  try {
    let settings=structuredClone(f.app.config);
    settings.resources!.bySession['1']!.prompt=null;
    const available=['check_data_coverage','read','read_data_scope'];
    const service=new ResourceService(()=>settings,f.repos,f.source,()=>available);
    let item=(await service.list({source:'selection',sessionId:1})).items.find(i=>i.ref.kind==='skill'&&i.ref.id==='query')!;
    expect(item).toMatchObject({enabled:true,availability:'ready',readiness:{state:'ready',basis:'configuration',matchedCount:3,totalCount:3}});
    settings.resources!.bySession['1']!.skills=[];
    item=(await service.list({source:'selection',sessionId:1})).items.find(i=>i.ref.kind==='skill'&&i.ref.id==='query')!;
    expect(item).toMatchObject({enabled:false,readiness:{state:'ready',matchedCount:3,totalCount:3}});
    settings.resources!.bySession['1']!.skills=[f.skill];
    const scope=f.repos.freezeAgentScope(f.repos.readWorkspace(),['read']);
    const frozen=await service.freeze(1,settings,scope);
    expect(frozen).toMatchObject({available:[],skillRequirements:[{resourceRef:f.skill,requiredTools:['check_data_coverage','read','read_data_scope']}]});
    expect(frozen.omitted).toContainEqual(expect.objectContaining({resourceRef:f.skill,reason:'resource_dependency_missing'}));
    expect(()=>service.planInput(frozen,f.request('/skill:query audit'))).toThrow();
    expect(service.planInput(frozen,f.request('unrelated question'))).toMatchObject({kind:'plain'});
    unlinkSync(join(f.author,'skills/query/v1/SKILL.md'));
    item=(await service.list({source:'selection',sessionId:1})).items.find(i=>i.ref.kind==='skill'&&i.ref.id==='query')!;
    expect(item).toMatchObject({availability:'missing',readiness:{state:'ready',matchedCount:3,totalCount:3}});
    expect(f.requests).toHaveLength(0);
    expect(f.db.query('SELECT id FROM runs').all()).toHaveLength(0);
  } finally {await f.close();}
});

test('p11 historical readiness uses original Run scope after current configuration changes',async()=>{
  const f=await agentRuntimeFixture();
  try {
    const result=await f.app.runs.submitAgent(f.request('scope review'),{instanceId:'host',operationRef:'readiness-run'});
    expect(result.ok).toBe(true);if(!result.ok||!result.data.runId)throw new Error('Run missing');
    await f.settle();
    const settings=structuredClone(f.app.config), service=new ResourceService(()=>settings,f.repos,f.source,()=>[]);
    const configured=(await service.list({source:'selection',sessionId:1})).items.find(i=>i.ref.kind==='skill'&&i.ref.id==='query')!;
    expect(configured).toMatchObject({readiness:{state:'unavailable',matchedCount:0,totalCount:3}});
    const historical=(await service.list({source:'run',runId:result.data.runId})).items.find(i=>i.ref.kind==='skill'&&i.ref.id==='query')!;
    expect(historical).toMatchObject({readiness:{state:'ready',basis:'run_scope',matchedCount:3,totalCount:3}});
    expect(f.requests).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally {await f.close();}
},15000);
