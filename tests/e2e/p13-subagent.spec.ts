import {expect,test,type Page} from '@playwright/test';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createStartupPackage,launchActualDev,readStartupFacts} from '../fixtures/desktop-dev';
import {p13AgentInput} from '../fixtures/p13-subagent';

test.use({actionTimeout:15000});

async function configure(page:Page,baseUrl:string){
  const result=await page.evaluate(async baseUrl=>{
    const models=await window.medclaw.request('model.read',{});if(!models.ok)throw new Error(models.error.code);
    const token=await window.medclaw.secretInput({providerId:'p13-fixture',purpose:'custom_api_key',value:'ENGINEERING-LOCAL'});if(!token.ok)throw new Error(token.error.code);
    const saved=await window.medclaw.request('model.custom.save',{expectedConfigVersion:models.data.configVersion,credentialInput:token.data.token,definition:{providerId:'p13-fixture',name:'ENGINEERING',api:'openai-completions',baseUrl,models:[{id:'fixture',name:'ENGINEERING',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,outputLimitConfirmed:true,pricingKnown:false,cost:null}]}});if(!saved.ok)throw new Error(saved.error.code);
    return window.medclaw.request('model.configure',{provider:'p13-fixture',modelId:'fixture',expectedConfigVersion:saved.data.configVersion});
  },baseUrl);expect(result.ok).toBe(true);
}
async function send(page:Page,text:string){await page.getByRole('button',{name:'Chat',exact:true}).click();await page.getByLabel('Message text',{exact:true}).fill(text);await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Send',exact:true}).click();}
async function fixture(hold:'child-final'|'child-stream'){
  const root=mkdtempSync(join(tmpdir(),'medclaw-p13-desktop-')),dataRoot=join(root,'isolated data'),source=join(root,'ENGINEERING source');createStartupPackage(source);
  const received:Record<string,any>[]=[];let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  const provider=createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;const payload=JSON.parse(raw);received.push(payload);const step=received.length;
    if(hold==='child-stream'&&step===2){response.writeHead(200,{'content-type':'text/event-stream'});response.write(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'ENGINEERING child active'},finish_reason:null}]})}\n\n`);return;}
    if(hold==='child-final'&&step===3)await pending;
    const name=step===1?'Agent':step===2?'query_current_devices':null;
    const args=step===1?p13AgentInput:{batchIds:[1],time:{start:'2026-01-01',endExclusive:'2026-01-02'}};
    const delta=name?{role:'assistant',tool_calls:[{index:0,id:`p13-desktop-${step}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:step===3?'ENGINEERING child audit result':'ENGINEERING parent answer'};
    response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta,finish_reason:name?'tool_calls':'stop'}],usage:{prompt_tokens:step*10,completion_tokens:step,total_tokens:step*11}})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));let desktop:Awaited<ReturnType<typeof launchActualDev>>|undefined;
  try{
    desktop=await launchActualDev(root,dataRoot,source);const page=desktop.page;await page.setViewportSize({width:1600,height:1000});await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});await configure(page,`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`);
    await page.getByRole('button',{name:'New Session',exact:true}).click();await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Choose snapshot directory',exact:true}).click();await expect(page.getByRole('button',{name:'Confirm import',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Confirm import',exact:true}).click();await expect(page.getByLabel('Select batch 1',{exact:true})).toBeVisible();await page.getByLabel('Select batch 1',{exact:true}).check();await page.getByRole('button',{name:'Apply 1 selected batches',exact:true}).click();
    return {page,received,release,dataRoot,close:async()=>{release();try{await desktop!.close();}finally{provider.closeAllConnections();await new Promise<void>(done=>provider.close(()=>done()));rmSync(root,{recursive:true,force:true});}}};
  }catch(error){release();await desktop?.close();provider.closeAllConnections();await new Promise<void>(done=>provider.close(()=>done()));rmSync(root,{recursive:true,force:true});throw error;}
}
async function runs(page:Page,parentRunId?:number){const result=await page.evaluate(parentRunId=>window.medclaw.request('run.read',{recent:true,...(parentRunId?{parentRunId}:{})}),parentRunId);if(!result.ok||result.data.kind!=='recent')throw new Error('No Run facts');return result.data.runs;}
async function openChild(page:Page,parentId:number,childId:number){
  await page.getByRole('button',{name:'View run details',exact:true}).click();await page.getByRole('tab',{name:'Run details',exact:true}).click();await page.getByRole('button',{name:'Refresh recent runs',exact:true}).click();await expect(page.getByRole('button',{name:`View Run ${parentId}`,exact:true})).toBeVisible();await page.getByRole('button',{name:`View Run ${parentId}`,exact:true}).click();const child=page.getByTestId('subagent-list').getByRole('button',{name:`View Subagent Run ${childId}`,exact:true});await expect(child).toBeVisible();await child.click();await expect(page.getByTestId('subagent-details')).toBeVisible();
}
test('p13 actual Electron reads child Query and independent history during A/B, verifies consumption and zero-child control',async({},info)=>{
  test.setTimeout(180000);const f=await fixture('child-final');try{
    await send(f.page,'ENGINEERING independent query audit');await expect.poll(()=>f.received.length,{timeout:30000}).toBe(3);const parent=(await runs(f.page))[0]!;await expect.poll(async()=>(await runs(f.page,parent.id)).length).toBe(1);const child=(await runs(f.page,parent.id))[0]!;if(child.kind!=='child')throw new Error('No child');
    const before=await f.page.evaluate(()=>window.medclaw.request('workspace.read',{}));expect(before).toMatchObject({ok:true,data:{queryId:null}});
    await f.page.getByRole('button',{name:'New Session',exact:true}).click();await f.page.getByRole('button',{name:'Chat',exact:true}).click();await openChild(f.page,parent.id,child.id);
    await expect(f.page.getByTestId('subagent-details')).toContainText('Child result committed');await expect(f.page.getByTestId('subagent-details')).not.toContainText('Verified in');
    await expect(f.page.getByTestId('run-native-messages')).toContainText('Parent delegation');await expect(f.page.getByTestId('chat-native-messages')).not.toContainText('ENGINEERING independent query audit');
    const queries=await f.page.evaluate(childRunId=>window.medclaw.request('query.list',{childRunId}),child.id);if(!queries.ok||!queries.data.items[0])throw new Error('No child Query '+JSON.stringify({queries,originalReceipt:f.received[2]?.messages.findLast((m:any)=>m.role==='tool')}));expect(queries.data.items[0]).toMatchObject({runId:child.id,sessionId:child.sessionId});
    const qid=queries.data.items[0].id,query=await f.page.evaluate(queryId=>window.medclaw.request('query.read',{queryId}),qid);expect(query).toMatchObject({ok:true,data:{query:{runId:child.id}}});
    if(!query.ok||!query.data.evidence[0])throw new Error('No child evidence');expect(await f.page.evaluate(({queryId,evidenceId})=>window.medclaw.request('evidence.read',{queryId,evidenceId}),{queryId:qid,evidenceId:query.data.evidence[0].id})).toMatchObject({ok:true});
    f.release();await expect.poll(async()=>{const result=await f.page.evaluate(runId=>window.medclaw.request('run.read',{runId}),child.id);return result.ok&&result.data.kind==='one'&&result.data.run?.kind==='child'&&result.data.run.delivery?.consumptionEvidence;},{timeout:30000}).toBe('provider_input_verified');
    await f.page.getByRole('button',{name:'Read this run again',exact:true}).click();await expect(f.page.getByTestId('subagent-details')).toContainText('Receipt saved');await expect(f.page.getByTestId('subagent-details')).toContainText('Verified in');await expect(f.page.getByTestId('subagent-details')).toContainText(`Query references: ${qid}`);
    expect(await f.page.locator('[data-session-id]').count()).toBe(2);expect(await f.page.locator(`[data-session-id="${child.sessionId}"]`).count()).toBe(0);expect(f.received[3]!.messages.findLast((message:any)=>message.role==='tool').content).toContain('ENGINEERING child audit result');
    await f.page.getByRole('button',{name:`View parent Run ${parent.id}`,exact:true}).click();await expect(f.page.getByTestId('run-group-usage')).toContainText('Parent: 2 model calls');await expect(f.page.getByTestId('run-group-usage')).toContainText('Children: 2 model calls');await expect(f.page.getByTestId('run-group-usage')).toContainText('Total: 4 model calls');await expect(f.page.getByTestId('tool-call-details')).toContainText('Agent');
    await f.page.getByRole('button',{name:'Close run details',exact:true}).click();await expect.poll(async()=>{const result=await f.page.evaluate(()=>window.medclaw.request('run.control.read',{}));return result.ok&&result.data.acceptingNewRuns;}).toBe(true);
    await send(f.page,'ENGINEERING simple question without delegation');await expect.poll(()=>f.received.length).toBe(5);await expect.poll(async()=>(await runs(f.page))[0]?.status).toBe('completed');const control=(await runs(f.page))[0]!;expect(await runs(f.page,control.id)).toEqual([]);expect(f.received[4]!.tools.some((tool:any)=>tool.function.name==='Agent')).toBe(true);
    const proof=await f.page.evaluate(runId=>window.medclaw.request('run.read',{runId}),control.id);expect(proof).toMatchObject({ok:true,data:{run:{groupUsage:{parent:{modelCalls:1,inputTokens:50},children:{modelCalls:0,toolCalls:0,inputTokens:0,outputTokens:0,cost:0}}}}});
    const evidence=JSON.stringify({formalQuality:'NOT_RUN',parentId:parent.id,childId:child.id,queries,control:proof,sqlite:readStartupFacts(f.dataRoot)});
    mkdirSync('.build/p13-evidence/implementation',{recursive:true});writeFileSync('.build/p13-evidence/implementation/t08-desktop-evidence.json',evidence);
    await info.attach('p13-engineering-evidence',{body:evidence,contentType:'application/json'});
  }finally{await f.close();}
});
test('p13 actual child page Stop addresses its original parent and confirms real child HTTP stop',async()=>{
  test.setTimeout(120000);const f=await fixture('child-stream');try{
    await send(f.page,'ENGINEERING cancel delegated audit');await expect.poll(()=>f.received.length,{timeout:30000}).toBe(2);const parent=(await runs(f.page))[0]!,child=(await runs(f.page,parent.id))[0]!;await openChild(f.page,parent.id,child.id);await f.page.getByRole('button',{name:`Stop parent Run ${parent.id}`,exact:true}).click();
    await expect.poll(async()=>{const result=await f.page.evaluate(runId=>window.medclaw.request('run.read',{runId}),child.id);return result.ok&&result.data.kind==='one'&&result.data.run?.cleanup?.resourcesReleased;},{timeout:30000}).toBe(true);await f.page.getByRole('button',{name:'Read this run again',exact:true}).click();await expect(f.page.getByTestId('subagent-details')).toContainText('Confirmed');expect(f.received).toHaveLength(2);
    expect(await f.page.evaluate(()=>window.medclaw.request('run.control.read',{}))).toMatchObject({ok:true,data:{acceptingNewRuns:true}});
    mkdirSync('.build/p13-evidence/implementation',{recursive:true});writeFileSync('.build/p13-evidence/implementation/t08-desktop-stop-evidence.json',JSON.stringify({formalQuality:'NOT_RUN',parentId:parent.id,childId:child.id,requests:f.received.length,sqlite:readStartupFacts(f.dataRoot)}));
  }finally{await f.close();}
});
