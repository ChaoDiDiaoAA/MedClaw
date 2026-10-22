import {expect,spyOn,test} from 'bun:test';
import {readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ResourceService} from '../../packages/core/src/resources/resource-service';
import {ResourceCatalogueSchema} from '../../packages/contracts/src/resources';
import {agentRuntimeFixture} from '../fixtures/agent-runtime';

test('p11 catalog includes every authored Skill and real Tool matches without a Session or selection state',async()=>{
  const f=await agentRuntimeFixture(), settings=structuredClone(f.app.config);
  const readSession=spyOn(f.repos,'readSession').mockImplementation(()=>{throw new Error('Catalog must not read a Session');});
  try {
    const service=new ResourceService(()=>settings,f.repos,f.source,()=>['read']);
    const catalog=await service.readCatalog();
    const author=ResourceCatalogueSchema.parse(JSON.parse(readFileSync(join(f.author,'catalog.json'),'utf8')));
    expect(catalog.items.map(item=>item.ref)).toEqual(author.definitions.map(({kind,id,version})=>({kind,id,version})));
    expect(catalog.items.find(item=>item.ref.kind==='skill'&&item.ref.id==='query')).toMatchObject({
      availability:'dependency_missing',readiness:{state:'partial',basis:'configuration',matchedCount:1,totalCount:3,
        missingTools:[{name:'check_data_coverage',reason:'tool_not_available'},{name:'read_data_scope',reason:'tool_not_available'}]}});
    expect(catalog.items.every(item=>!Object.hasOwn(item,'enabled'))).toBe(true);
    expect(catalog).not.toHaveProperty('sessionId');expect(catalog).not.toHaveProperty('selection');
    expect(catalog.catalogError).toBeNull();expect(f.app.config).toEqual(settings);
    unlinkSync(join(f.author,'catalog.json'));
    expect(await service.readCatalog()).toMatchObject({items:[],catalogError:{reason:'resource_catalog_invalid'}});
    expect(f.requests).toHaveLength(0);expect(f.db.query('SELECT id FROM runs').all()).toHaveLength(0);
  } finally {readSession.mockRestore();await f.close();}
});

test('p12 extension catalog validates the first-party package without reading Session or assembly facts',async()=>{
  const f=await agentRuntimeFixture();
  const readSession=spyOn(f.repos,'readSession').mockImplementation(()=>{throw new Error('Catalog must not read a Session');});
  const readAssembly=spyOn(f.agent,'readExtensionCleanup').mockImplementation(()=>{throw new Error('Catalog must not read assembly facts');});
  try {
    const catalog=await f.app.readExtensionCatalog();
    expect(catalog).toMatchObject({available:{ref:{id:'tool-audit',version:'v1'},source:'first_party',sdkVersion:'0.87.1',
      tools:['extension_runtime_status'],commands:['extension_status']},diagnostics:[]});
    expect(catalog).not.toHaveProperty('selection');expect(catalog).not.toHaveProperty('live');expect(catalog).not.toHaveProperty('assembly');
    writeFileSync(join(f.author,'extensions/tool-audit/v1/manifest.json'),'{}');
    expect(await f.app.readExtensionCatalog()).toMatchObject({available:null,diagnostics:[{code:'extension_unavailable'}]});
    expect(f.requests).toHaveLength(0);expect(f.db.query('SELECT id FROM runs').all()).toHaveLength(0);
  } finally {readSession.mockRestore();readAssembly.mockRestore();await f.close();}
});

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
