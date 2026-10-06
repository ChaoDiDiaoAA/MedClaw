import {expect,test} from '@playwright/test';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createStartupPackage,launchActualDev,readStartupFacts} from '../fixtures/desktop-dev';

test('p11 actual desktop discovers selects reads queries and restores original resource evidence after Host restart',async({},testInfo)=>{
  test.setTimeout(180000);
  const root=mkdtempSync(join(tmpdir(),'medclaw-p11-desktop-')),dataRoot=join(root,'isolated data'),source=join(root,'ENGINEERING synthetic source');createStartupPackage(source);
  const received:Record<string,any>[]=[],businessNames:string[]=[];
  const provider=createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;const payload=JSON.parse(raw);received.push(payload);const step=received.length;
    const result=(name:string)=>{const message=payload.messages.findLast((m:Record<string,any>)=>m.role==='tool'&&payload.messages.some((a:Record<string,any>)=>a.role==='assistant'&&a.tool_calls?.some((c:Record<string,any>)=>c.id===m.tool_call_id&&c.function.name===name)));if(!message)throw new Error('No actual '+name+' receipt');return JSON.parse(message.content);};
    let delta:Record<string,unknown>;
    if(step<8){
      const location=/<location>(.*?)<\/location>/.exec(payload.messages.find((m:Record<string,any>)=>m.role==='system').content)![1]!;
      const name=step<3?'read':step===3?'read_data_scope':step===4?'check_data_coverage':step===5?'query_current_devices':step===6?'list_query_evidence':'read_query_evidence';
      const time={start:'2026-01-01',endExclusive:'2026-01-02'},args=step===1?{path:location}:step===2?{path:location.replace('SKILL.md','references/facts-and-assumptions.md')}:step===3?{}:step===4?{time}:step===5?{batchIds:[1],time}:step===6?{queryId:result('query_current_devices').queryId}:{evidenceId:result('list_query_evidence').items[0].id};
      businessNames.push(name);delta={role:'assistant',tool_calls:[{index:0,id:`p11-desktop-${step}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]};
    }else if(step===8){const query=result('query_current_devices'),evidence=result('read_query_evidence');
      delta={role:'assistant',content:`Facts: Query ${query.queryId}, ${query.totalRows} snapshot record(s), price ${query.rows[0].priceCents} cents. Evidence ${evidence.id}, hash ${evidence.resultHash}. Assumptions: ENGINEERING synthetic date 2026-01-01. Missing evidence: physical stock quantity is unknown.`};
    }else delta={role:'assistant',content:'ENGINEERING next run plain response; no new calculation.'};
    response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta,finish_reason:'tool_calls' in delta?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));let desktop:Awaited<ReturnType<typeof launchActualDev>>|undefined;
  try {
    desktop=await launchActualDev(root,dataRoot,source);const page=desktop.page;
    await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});
    expect((await page.evaluate(async baseUrl=>{
      const models=await window.medclaw.request('model.read',{});if(!models.ok)throw new Error(models.error.code);
      const token=await window.medclaw.secretInput({providerId:'p11-fixture',purpose:'custom_api_key',value:'ENGINEERING-LOCAL'});if(!token.ok)throw new Error(token.error.code);
      const saved=await window.medclaw.request('model.custom.save',{expectedConfigVersion:models.data.configVersion,credentialInput:token.data.token,definition:{providerId:'p11-fixture',name:'ENGINEERING',api:'openai-completions',baseUrl,models:[{id:'fixture',name:'ENGINEERING',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,outputLimitConfirmed:true,pricingKnown:false,cost:null}]}});if(!saved.ok)throw new Error(saved.error.code);
      return window.medclaw.request('model.configure',{provider:'p11-fixture',modelId:'fixture',expectedConfigVersion:saved.data.configVersion});
    },`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`)).ok).toBe(true);
    await page.getByRole('button',{name:'New Session',exact:true}).click();
    await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Choose snapshot directory',exact:true}).click();
    await expect(page.getByRole('button',{name:'Confirm import',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Confirm import',exact:true}).click();
    await expect(page.getByLabel('Select batch 1',{exact:true})).toBeVisible();await page.getByLabel('Select batch 1',{exact:true}).check();await page.getByRole('button',{name:'Apply 1 selected batches',exact:true}).click();
    for(const entrance of ['Prompt','Skills']){await page.getByRole('button',{name:entrance,exact:true}).click();await expect(page.getByRole('button',{name:'Enable query',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Enable query',exact:true}).click();await expect(page.getByRole('button',{name:'Disable query',exact:true})).toBeEnabled();}
    await page.getByRole('button',{name:'Read query SKILL.md',exact:true}).click();await expect(page.getByTestId('resource-body')).toContainText('Query MedClaw data');expect(readStartupFacts(dataRoot).calls).toBe(0);expect(received).toHaveLength(0);
    await page.getByRole('button',{name:'Chat',exact:true}).click();await page.getByLabel('Message text',{exact:true}).fill('ENGINEERING query the selected snapshot and distinguish stock quantity from snapshot counts.');
    await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Send',exact:true}).click();
    const recent=()=>page.evaluate(async()=>{const result=await window.medclaw.request('run.read',{recent:true});return result.ok&&result.data.kind==='recent'?result.data.runs[0]:null;});
    await expect.poll(async()=>(await recent())?.status,{timeout:30000}).toBe('completed');expect(received).toHaveLength(8);
    expect(businessNames).toEqual(['read','read','read_data_scope','check_data_coverage','query_current_devices','list_query_evidence','read_query_evidence']);
    const original=await recent();if(!original)throw new Error('No original Run');
    const read=await page.evaluate(runId=>window.medclaw.request('run.read',{runId}),original.id);expect(read).toMatchObject({ok:true,data:{kind:'one',run:{status:'completed',output:{text:expect.stringContaining('1 snapshot record(s), price 100 cents')}}}});
    if(!read.ok||read.data.kind!=='one'||!read.data.run)throw new Error('No read');expect(read.data.run.output.text).toContain('physical stock quantity is unknown');
    const proof=await page.evaluate(runId=>window.medclaw.request('resources.list',{source:'run',runId,evidencePageSize:100}),original.id);if(!proof.ok)throw new Error(proof.error.code);
    expect(proof.data.evidence.filter(e=>e.kind==='native_read').map(e=>e.file).sort()).toEqual(['SKILL.md','references/facts-and-assumptions.md']);
    expect(proof.data.evidence.some(e=>e.kind==='sdk_expansion'&&e.resourceRef.kind==='prompt')).toBe(true);expect(proof.data.evidence.filter(e=>e.kind==='provider_delivery'&&e.coverage==='index')).toHaveLength(8);
    for(const fact of proof.data.evidence.filter(e=>e.kind==='native_read'))expect(proof.data.evidence.some(e=>e.kind==='provider_delivery'&&e.toolCallId===fact.toolCallId)).toBe(true);
    const query=await page.evaluate(async()=>{const result=await window.medclaw.request('query.list',{sessionId:1});if(!result.ok||!result.data.items[0])throw new Error('No saved Query');return window.medclaw.request('query.read',{queryId:result.data.items[0].id});});expect(query).toMatchObject({ok:true,data:{query:{runId:original.id},page:{totalRows:1}}});
    await page.getByRole('button',{name:'View run details',exact:true}).click();await page.getByRole('tab',{name:'Conditions',exact:true}).click();const panel=page.getByTestId('resource-panel');
    await expect(panel).toContainText('Resources for this run');await expect(panel).toContainText('Delivered');await expect(panel).toContainText('Following instructions has not been evaluated');await page.screenshot({path:testInfo.outputPath('p11-resource-proof.png'),fullPage:true});
    await page.getByRole('button',{name:'Close run details',exact:true}).click();
    await page.getByRole('button',{name:'Skills',exact:true}).click();await page.getByRole('button',{name:'Disable query',exact:true}).click();await expect(page.getByRole('button',{name:'Enable query',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Prompt',exact:true}).click();await page.getByRole('button',{name:'Clear selection',exact:true}).click();await expect(page.getByRole('button',{name:'Enable query',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Chat',exact:true}).click();await page.getByLabel('Message text',{exact:true}).fill('ENGINEERING next plain run');await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Send',exact:true}).click();await expect.poll(()=>received.length).toBe(9);await expect.poll(async()=>(await recent())?.status).toBe('completed');
    const next=await recent();if(!next)throw new Error('No next Run');const nextProof=await page.evaluate(runId=>window.medclaw.request('resources.list',{source:'run',runId,evidencePageSize:100}),next.id);expect(nextProof).toMatchObject({ok:true,data:{selection:{prompt:null,skills:[]},items:[]}});
    if(!nextProof.ok)throw new Error(nextProof.error.code);expect(nextProof.data.evidence.some(e=>e.kind==='provider_delivery'&&e.originRunId===original.id&&e.toolCallId!==null)).toBe(true);expect(nextProof.data.evidence.some(e=>e.kind==='provider_delivery'&&e.coverage==='index')).toBe(false);
    const oldHost=await page.evaluate(()=>window.medclaw.request('host.read',{}));await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Restart Host',exact:true}).click();
    await expect.poll(async()=>{const h=await page.evaluate(()=>window.medclaw.request('host.read',{}));return h.ok&&h.data.state==='ready'&&oldHost.ok&&h.data.instanceId!==oldHost.data.instanceId;},{timeout:30000}).toBe(true);
    const skill=proof.data.items.find(i=>i.ref.kind==='skill')!.ref;const oldBody=await page.evaluate(({runId,resourceRef})=>window.medclaw.request('resources.read',{source:'run',runId,resourceRef,file:'SKILL.md'}),{runId:original.id,resourceRef:skill});expect(oldBody).toMatchObject({ok:true,data:{source:'run',runId:original.id,resourceRef:skill,content:expect.stringContaining('Query MedClaw data')}});
    const restored=await page.evaluate(runId=>window.medclaw.request('resources.list',{source:'run',runId,evidencePageSize:100}),original.id);expect(restored).toEqual(proof);expect(received).toHaveLength(9);
    await testInfo.attach('p11-engineering-pipeline',{body:JSON.stringify({status:'ENGINEERING_PASS',formalQuality:'QUALITY_NOT_RUN',externalProvider:'NOT_RUN',requests:received.length,originalRun:original.id,nextRun:next.id,resourceFacts:proof.data.evidence,desktopFacts:readStartupFacts(dataRoot)}),contentType:'application/json'});
  }finally{await desktop?.close();provider.closeAllConnections();await new Promise<void>(done=>provider.close(()=>done()));if(!desktop||existsSync(join(root,'dev-exit-confirmed')))rmSync(root,{recursive:true,force:true});}
});
