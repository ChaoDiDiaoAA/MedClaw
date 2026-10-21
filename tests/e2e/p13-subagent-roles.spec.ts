import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createStartupPackage, launchActualDev, readStartupFacts } from '../fixtures/desktop-dev';

test('p13 actual desktop manages role overrides and four command groups without executing a task', async () => {
  test.setTimeout(120000);
  const root = mkdtempSync(join(tmpdir(), 'medclaw-role-desktop-')), dataRoot = join(root, 'isolated data'), source = join(root, 'ENGINEERING source');
  createStartupPackage(source);
  const observer=join(root,'role-save-observer.cjs'),lostReply=join(root,'lose-agent-save-reply');
  writeFileSync(observer,`module.exports=({ipcMain})=>{const fs=require('fs'),handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,listener)=>handle(channel,async(event,envelope)=>{const result=await listener(event,envelope);if(channel==='medclaw:request'&&envelope?.method==='subagents.save'&&result.ok&&fs.existsSync(${JSON.stringify(lostReply)})){fs.unlinkSync(${JSON.stringify(lostReply)});throw new Error('ENGINEERING lost committed agent save reply');}return result;});};`);
  const desktop = await launchActualDev(root, dataRoot, source,undefined,undefined,observer);
  try {
    const page = desktop.page;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'New Session', exact: true }).click();
    await page.getByRole('button', { name: 'Extensions', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Manage agents', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit agent general-analyst', exact: true }).click();
    const editor = page.getByLabel('Agent content', { exact: true });
    const original = await editor.inputValue();
    await expect(page.getByLabel('Agent ID', { exact: true })).toBeDisabled();
    const changed = original + '\nENGINEERING user role override.\n';
    await editor.fill(changed);
    await page.getByRole('button', { name: 'Save agent', exact: true }).click();
    await expect(page.getByText('Agent saved for subsequent Runs.', { exact: true })).toBeVisible();
    expect(readFileSync(join(dataRoot, 'subagents/general-analyst.md'), 'utf8')).toBe(changed);
    const unknownContent=changed+'\nENGINEERING saved with a lost reply.\n';
    await editor.fill(unknownContent);
    writeFileSync(lostReply,'lose one committed reply');
    await page.getByRole('button', { name: 'Save agent', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Draft retained.');
    await expect(page.getByRole('button', { name: 'Verify agent save', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Save agent', exact: true })).toBeDisabled();
    await expect(editor).toHaveValue(unknownContent);
    expect(readFileSync(join(dataRoot, 'subagents/general-analyst.md'), 'utf8')).toBe(unknownContent);
    await page.getByRole('button', { name: 'Verify agent save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save agent', exact: true })).toBeEnabled();
    const conflictDraft=unknownContent+'\nENGINEERING conflicting draft.\n',externalContent=unknownContent+'\nENGINEERING other editor.\n';
    await editor.fill(conflictDraft);
    const external=await page.evaluate(async ({expectedContent,content})=>window.medclaw.request('subagents.save',{sessionId:1,roleId:'general-analyst',expectedContent,content}),{expectedContent:unknownContent,content:externalContent});
    expect(external.ok).toBe(true);
    await page.getByRole('button', { name: 'Save agent', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Draft retained.');
    await expect(editor).toHaveValue(conflictDraft);
    expect(readFileSync(join(dataRoot, 'subagents/general-analyst.md'), 'utf8')).toBe(externalContent);
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const input = page.getByLabel('Message text', { exact: true });
    await input.fill('/');
    for (const group of ['Skills', 'Subagents', 'Prompt Templates', 'Extension Commands']) await expect(page.getByRole('group', { name: group, exact: true })).toBeVisible();
    await page.getByRole('option', { name: '/subagent general-analyst', exact: false }).click();
    await expect(input).toHaveValue('/subagent general-analyst ');
    await page.getByRole('button', { name: 'Extensions', exact: true }).click();
    await expect(page.getByLabel('Agent content', { exact: true })).toHaveValue(conflictDraft);
    const facts = readStartupFacts(dataRoot);
    expect(facts.runs).toBe(0);
    expect(facts.calls).toBe(0);
    const result = await page.evaluate(() => window.medclaw.request('session.listInputs', { sessionId: 1 }));
    expect(result).toMatchObject({ ok: true, data: { items: [] } });
  } finally { await desktop.close(); rmSync(root, { recursive: true, force: true }); }
});

test('p13 actual desktop stops one of four child cards, preserves original roles and keeps A results out of B',async()=>{
  test.setTimeout(120000);
  const root=mkdtempSync(join(tmpdir(),'medclaw-parallel-desktop-')),dataRoot=join(root,'isolated data'),observer=join(root,'hold-child-read.cjs'),hold=join(root,'hold-child'),entered=join(root,'entered-child'),released=join(root,'released-child');
  writeFileSync(observer,`module.exports=({ipcMain})=>{const fs=require('fs'),handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,listener)=>handle(channel,async(event,envelope)=>{const result=await listener(event,envelope);if(channel==='medclaw:request'&&envelope?.method==='run.read'&&fs.existsSync(${JSON.stringify(hold)})&&String(envelope.payload.runId)===fs.readFileSync(${JSON.stringify(hold)},'utf8')){fs.writeFileSync(${JSON.stringify(entered)},'held');await new Promise(resolve=>{const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(hold)})){clearInterval(timer);resolve();}},10);timer.unref();});fs.writeFileSync(${JSON.stringify(released)},'released');}return result;});};`);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let parents=0,children=0;const disconnected=new Set<number>();
  const provider=createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;const payload=JSON.parse(raw);
    const parent=payload.tools?.some((tool:{function:{name:string}})=>tool.function.name==='Agent');
    let delta:object;
    if(parent){parents++;delta=parents===1?{role:'assistant',tool_calls:Array.from({length:4},(_,index)=>({index,id:'desktop-owned-'+index,type:'function',function:{name:'Agent',arguments:JSON.stringify({description:'Independent review '+index,prompt:'ENGINEERING supplied material '+index,subagent_type:'general-analyst',run_in_background:false})}}))}:{role:'assistant',content:'ENGINEERING parent retained three analyses and the cancellation.'};}
    else{const ordinal=++children;expect(payload.tools??[]).toEqual([]);response.once('close',()=>{if(!response.writableEnded)disconnected.add(ordinal);});await gate;delta={role:'assistant',content:'ENGINEERING independent child analysis '+ordinal};}
    response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta,finish_reason:parent&&parents===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  let desktop:Awaited<ReturnType<typeof launchActualDev>>|undefined;
  try{
    desktop=await launchActualDev(root,dataRoot,undefined,undefined,undefined,observer);const page=desktop.page;await page.setViewportSize({width:1600,height:1000});
    await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});
    const configured=await page.evaluate(async baseUrl=>{
      const models=await window.medclaw.request('model.read',{});if(!models.ok)throw Error(models.error.code);
      const token=await window.medclaw.secretInput({providerId:'parallel-desktop',purpose:'custom_api_key',value:'ENGINEERING-LOCAL'});if(!token.ok)throw Error(token.error.code);
      const saved=await window.medclaw.request('model.custom.save',{expectedConfigVersion:models.data.configVersion,credentialInput:token.data.token,definition:{providerId:'parallel-desktop',name:'ENGINEERING',api:'openai-completions',baseUrl,models:[{id:'fixture',name:'ENGINEERING',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,outputLimitConfirmed:true,pricingKnown:false,cost:null}]}});if(!saved.ok)throw Error(saved.error.code);
      return window.medclaw.request('model.configure',{provider:'parallel-desktop',modelId:'fixture',expectedConfigVersion:saved.data.configVersion});
    },`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`);
    expect(configured.ok).toBe(true);
    await page.getByRole('button',{name:'New Session',exact:true}).click();
    await page.getByLabel('Message routing',{exact:true}).selectOption('main_agent');
    await page.getByLabel('Message text',{exact:true}).fill('ENGINEERING review four independent supplied materials.');
    await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Send',exact:true}).click();
    await expect.poll(()=>children,{timeout:30000}).toBe(4);
    const cards=page.getByTestId('chat-subagent-card');await expect(cards).toHaveCount(4);await expect(cards.first()).toContainText('general-analyst');
    const original=await page.evaluate(()=>window.medclaw.request('run.read',{recent:true}));if(!original.ok||original.data.kind!=='recent'||original.data.runs[0]?.kind!=='agent')throw Error('Missing original root');const parent=original.data.runs[0];
    const childRead=await page.evaluate(parentRunId=>window.medclaw.request('run.read',{recent:true,parentRunId}),parent.id);if(!childRead.ok||childRead.data.kind!=='recent')throw Error('Missing children');const ids=childRead.data.runs.map(child=>child.id);
    const stoppedId=Number(await cards.first().getAttribute('data-child-run-id'));await cards.first().getByRole('button',{name:`Stop Subagent Run ${stoppedId}`,exact:true}).click();
    await expect.poll(async()=>{const result=await page.evaluate(runId=>window.medclaw.request('run.read',{runId}),stoppedId);return result.ok&&result.data.kind==='one'&&result.data.run?.status;}).toBe('cancelled');
    await expect.poll(()=>disconnected.size).toBe(1);
    for(const runId of [parent.id,...ids.filter(id=>id!==stoppedId)])expect(await page.evaluate(runId=>window.medclaw.request('run.read',{runId}),runId)).toMatchObject({ok:true,data:{run:{status:'running',cancelRequestedAt:null}}});
    const role=await page.evaluate(sessionId=>window.medclaw.request('subagents.read',{source:'selection',sessionId,roleId:'general-analyst'}),parent.sessionId);if(!role.ok)throw Error('Missing original role');
    const laterContent=role.data.content.replace(role.data.description,'ENGINEERING later role description');expect(await page.evaluate(({sessionId,content,expectedContent})=>window.medclaw.request('subagents.save',{sessionId,roleId:'general-analyst',content,expectedContent}),{sessionId:parent.sessionId,content:laterContent,expectedContent:role.data.content})).toMatchObject({ok:true});
    await page.getByRole('button',{name:'New Session',exact:true}).click();await expect(cards).toHaveCount(0);
    release();await expect.poll(async()=>{const result=await page.evaluate(runId=>window.medclaw.request('run.read',{runId}),parent.id);return result.ok&&result.data.kind==='one'&&result.data.run?.status;},{timeout:30000}).toBe('completed');
    await expect(cards).toHaveCount(0);expect(parents).toBe(2);expect(children).toBe(4);expect(await page.locator('[data-session-id]').count()).toBe(2);
    await page.locator(`[data-session-id="${parent.sessionId}"]`).getByRole('button').first().click();await expect(cards).toHaveCount(4);
    writeFileSync(hold,String(stoppedId));await cards.getByRole('button',{name:`View Subagent Run ${stoppedId}`,exact:true}).click();await expect.poll(()=>existsSync(entered)).toBe(true);
    const newerId=ids.find(id=>id!==stoppedId)!;await cards.getByRole('button',{name:`View Subagent Run ${newerId}`,exact:true}).click();await expect(page.getByTestId('subagent-details')).toContainText(`Subagent · Run ${newerId}`);
    rmSync(hold,{force:true});await expect.poll(()=>existsSync(released)).toBe(true);expect(await page.evaluate(()=>window.medclaw.request('workspace.read',{}))).toMatchObject({ok:true});await expect(page.getByTestId('subagent-details')).toContainText(`Subagent · Run ${newerId}`);
    await page.getByRole('button',{name:`View parent Run ${parent.id}`,exact:true}).click();await expect(cards).toHaveCount(4);
    await cards.first().getByRole('button',{name:`View Subagent Run ${stoppedId}`,exact:true}).click();await expect(page.getByTestId('subagent-details')).toContainText(role.data.description);await expect(page.getByTestId('subagent-details')).not.toContainText('ENGINEERING later role description');
    for(const runId of ids.filter(id=>id!==stoppedId))expect(await page.evaluate(runId=>window.medclaw.request('run.read',{runId}),runId)).toMatchObject({ok:true,data:{run:{status:'completed',role:{roleId:'general-analyst',description:role.data.description}}}});
  }finally{rmSync(hold,{force:true});release();try{await desktop?.close();}finally{provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}}
});

test('p13 completing A role save while viewing B releases management without replacing either draft',async()=>{
  test.setTimeout(120000);
  const root=mkdtempSync(join(tmpdir(),'medclaw-role-save-switch-')),dataRoot=join(root,'isolated data'),observer=join(root,'hold-role-save.cjs'),hold=join(root,'hold'),entered=join(root,'entered'),released=join(root,'released');
  writeFileSync(observer,`module.exports=({ipcMain})=>{const fs=require('fs'),handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,listener)=>handle(channel,async(event,envelope)=>{const result=await listener(event,envelope);if(channel==='medclaw:request'&&envelope?.method==='subagents.save'&&result.ok&&fs.existsSync(${JSON.stringify(hold)})){fs.writeFileSync(${JSON.stringify(entered)},'committed');await new Promise(resolve=>{const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(hold)})){clearInterval(timer);resolve();}},10);timer.unref();});fs.writeFileSync(${JSON.stringify(released)},'released');}return result;});};`);
  const desktop=await launchActualDev(root,dataRoot,undefined,undefined,undefined,observer);
  try{
    const page=desktop.page;await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});
    await page.getByRole('button',{name:'New Session',exact:true}).click();await page.getByRole('button',{name:'Extensions',exact:true}).click();await page.getByRole('button',{name:'Edit agent general-analyst',exact:true}).click();
    const editor=page.getByLabel('Agent content',{exact:true}),aContent=(await editor.inputValue())+'\nENGINEERING A retained draft.\n';await editor.fill(aContent);writeFileSync(hold,'hold committed save reply');await page.getByRole('button',{name:'Save agent',exact:true}).click();
    await expect.poll(()=>existsSync(entered)).toBe(true);expect(readFileSync(join(dataRoot,'subagents/general-analyst.md'),'utf8')).toBe(aContent);
    await page.getByRole('button',{name:'New Session',exact:true}).click();await page.getByRole('button',{name:'Extensions',exact:true}).click();const newAgent=page.getByRole('button',{name:'New agent',exact:true});await expect(newAgent).toBeDisabled();
    rmSync(hold,{force:true});await expect.poll(()=>existsSync(released)).toBe(true);await expect(newAgent).toBeEnabled();await newAgent.click();
    const bContent=(await editor.inputValue())+'\nENGINEERING B unsaved draft.\n';await editor.fill(bContent);
    await page.locator('[data-session-id="1"]').getByRole('button').first().click();await page.getByRole('button',{name:'Extensions',exact:true}).click();await expect(editor).toHaveValue(aContent);
    await page.locator('[data-session-id="2"]').getByRole('button').first().click();await page.getByRole('button',{name:'Extensions',exact:true}).click();await expect(editor).toHaveValue(bContent);
    expect(readStartupFacts(dataRoot)).toMatchObject({runs:0,calls:0});
  }finally{rmSync(hold,{force:true});await desktop.close();rmSync(root,{recursive:true,force:true});}
});
