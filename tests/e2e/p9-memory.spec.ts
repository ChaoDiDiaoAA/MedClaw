import {expect,test} from '@playwright/test';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createStartupPackage,launchActualDev,bunExecutable} from '../fixtures/desktop-dev';

test('p9 actual desktop preserves A/B history and drafts, checks original restore, and repairs a committed position before a new branch Run',async({},testInfo)=>{
  test.setTimeout(150000);
  const root=mkdtempSync(join(tmpdir(),'medclaw-p9-desktop-')),dataRoot=join(root,'isolated data'),source=join(root,'ENGINEERING source');createStartupPackage(source);
  const failRestore=join(root,'fail-restore'),failRead=join(root,'fail-history-read'),dropReply=join(root,'drop-reply'),entry=join(root,'controlled-host.ts');
  // Only isolated fault barriers wrap public loading/reading and the real Host reply transport.
  writeFileSync(entry,`import {DefaultResourceLoader} from ${JSON.stringify(resolve('node_modules/@earendil-works/pi-coding-agent/dist/index.js'))};
    import {PiAgentRuntime} from ${JSON.stringify(resolve('packages/runtime-pi/src/agent-runtime.ts'))};
    const readMessages=PiAgentRuntime.prototype.readMessages;PiAgentRuntime.prototype.readMessages=async function(input){if(existsSync(${JSON.stringify(failRead)}))throw new Error('storage_read_failed');return readMessages.call(this,input);};
    import {existsSync,unlinkSync} from 'node:fs';const reload=DefaultResourceLoader.prototype.reload;
    DefaultResourceLoader.prototype.reload=async function(){if(this.agentDir===${JSON.stringify(join(dataRoot,'runtime','pi'))}&&existsSync(${JSON.stringify(failRestore)})){unlinkSync(${JSON.stringify(failRestore)});throw new Error('ENGINEERING resource loading failure');}return reload.call(this);};
    const write=process.stdout.write.bind(process.stdout);process.stdout.write=function(chunk,...args){try{const frame=JSON.parse(String(chunk));if(existsSync(${JSON.stringify(dropReply)})&&frame.kind==='reply'&&frame.result?.ok&&frame.result.data?.targetLeafId){unlinkSync(${JSON.stringify(dropReply)});for(const callback of args)if(typeof callback==='function')queueMicrotask(()=>callback());return true;}}catch{}return write(chunk,...args);};
    await import(${JSON.stringify(resolve('apps/host/src/main.ts'))});`);
  const received:Record<string,unknown>[]=[];
  const provider=createServer(async(request,response)=>{
    let body='';for await(const chunk of request)body+=chunk;received.push(JSON.parse(body));
    const delta=received.length===1?{role:'assistant',tool_calls:[{index:0,id:'ENGINEERING-query',type:'function',function:{name:'query_current_devices',arguments:JSON.stringify({batchIds:[1],time:{start:'2026-01-01',endExclusive:'2026-01-02'}})}}]}:{role:'assistant',content:'ENGINEERING saved answer'};
    response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta,finish_reason:'tool_calls' in delta?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));
  let desktop:Awaited<ReturnType<typeof launchActualDev>>|undefined;
  const sql=(query:string,write=false)=>JSON.parse(execFileSync(bunExecutable,['-e',`import{Database}from'bun:sqlite';const db=new Database(${JSON.stringify(join(dataRoot,'data/app.sqlite'))},${write?'{create:true,strict:true}':'{readonly:true}'});${write?`db.exec('PRAGMA foreign_keys=ON');db.exec(${JSON.stringify(query)});console.log('null');`:`console.log(JSON.stringify(db.query(${JSON.stringify(query)}).all()));`}db.close();`],{cwd:resolve('.'),encoding:'utf8'}));
  try{
    desktop=await launchActualDev(root,dataRoot,source,undefined,entry);let page=desktop.page;
    await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});
    const configured=await page.evaluate(async baseUrl=>{
      const models=await window.medclaw.request('model.read',{});if(!models.ok)throw new Error(models.error.code);
      const token=await window.medclaw.secretInput({providerId:'p9-fixture',purpose:'custom_api_key',value:'ENGINEERING-LOCAL'});if(!token.ok)throw new Error(token.error.code);
      const saved=await window.medclaw.request('model.custom.save',{expectedConfigVersion:models.data.configVersion,credentialInput:token.data.token,definition:{providerId:'p9-fixture',name:'ENGINEERING',api:'openai-completions',baseUrl,models:[{id:'fixture',name:'ENGINEERING',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,outputLimitConfirmed:true,pricingKnown:false,cost:null}]}});if(!saved.ok)throw new Error(saved.error.code);
      return window.medclaw.request('model.configure',{provider:'p9-fixture',modelId:'fixture',expectedConfigVersion:saved.data.configVersion});
    },`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`);expect(configured.ok).toBe(true);
    await page.getByRole('button',{name:'New Session',exact:true}).click();
    await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Choose snapshot directory',exact:true}).click();
    await expect(page.getByRole('button',{name:'Confirm import',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Confirm import',exact:true}).click();
    await expect(page.getByLabel('Select batch 1',{exact:true})).toBeVisible();await page.getByLabel('Select batch 1',{exact:true}).check();await page.getByRole('button',{name:'Apply 1 selected batches',exact:true}).click();
    await page.getByRole('button',{name:'Chat',exact:true}).click();
    const idle=async()=>{await expect.poll(async()=>{const r=await page.evaluate(()=>window.medclaw.request('run.control.read',{}));return r.ok&&r.data.acceptingNewRuns;}).toBe(true);};
    const chat=async()=>{await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Chat',exact:true}).click();};
    const runtime=async()=>{await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('navigation',{name:'Settings tasks'}).getByRole('button',{name:'Runtime',exact:true}).click();};
    const send=async(text:string)=>{await chat();await page.getByLabel('Message text',{exact:true}).fill(text);await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Send',exact:true}).click();await expect.poll(()=>received.some(r=>JSON.stringify(r.messages).includes(text))).toBe(true);await idle();};
    await send('ENGINEERING A original');await send('ENGINEERING A correction Shanghai');
    await page.getByRole('button',{name:'New Session',exact:true}).click();await expect(page.getByTestId('current-session')).toContainText('Session 2');await send('ENGINEERING B independent');
    await page.locator('[data-session-id="1"] > button').first().click();await expect(page.getByTestId('current-session')).toContainText('Session 1');
    await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Runtime',exact:true}).click();await page.getByRole('button',{name:'Restart Host',exact:true}).click();await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});
    await page.getByRole('button',{name:'Chat',exact:true}).click();await send('ENGINEERING A after restart');
    expect(JSON.stringify(received.at(-1)!.messages)).toContain('ENGINEERING A correction Shanghai');expect(JSON.stringify(received.at(-1)!.messages)).not.toContain('ENGINEERING B independent');
    await page.getByLabel('Message text',{exact:true}).fill('ENGINEERING retained draft');await runtime();
    let panel=page.getByTestId('session-checkpoints'),resume=panel.getByRole('button',{name:'Resume from here · Run 1',exact:true});if(!await resume.isVisible())await panel.getByText('Browse saved turns',{exact:true}).click();await expect(resume).toBeEnabled();
    await resume.click();let dialog=page.getByRole('dialog',{name:'Resume from this saved turn?'});
    await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(resume).toBeFocused();
    const before=sql('SELECT current_leaf_id,storage_version FROM sessions WHERE id=1'),query=sql('SELECT * FROM queries'),answers=sql('SELECT * FROM answers');
    sql("CREATE TRIGGER p9_checkpoint_fault BEFORE INSERT ON business_events WHEN NEW.type='session_checkpoint_restored' BEGIN SELECT RAISE(ABORT,'ENGINEERING transaction failure'); END;",true);
    await resume.click();await dialog.getByRole('button',{name:'Resume from here',exact:true}).click();await expect(panel).toContainText('Run facts have not been confirmed saved.');await idle();
    expect(sql('SELECT current_leaf_id,storage_version FROM sessions WHERE id=1')).toEqual(before);await chat();await expect(page.getByLabel('Message text',{exact:true})).toHaveValue('ENGINEERING retained draft');sql('DROP TRIGGER p9_checkpoint_fault',true);
    writeFileSync(failRestore,'ENGINEERING');await runtime();await resume.click();await dialog.getByRole('button',{name:'Resume from here',exact:true}).click();
    await expect.poll(()=>existsSync(failRestore)).toBe(false);
    await expect(panel).toContainText('History position saved. This session cannot continue yet.');await chat();await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
    const moved=sql('SELECT current_leaf_id,storage_version FROM sessions WHERE id=1');expect(moved).not.toEqual(before);expect(sql('SELECT * FROM queries')).toEqual(query);expect(sql('SELECT * FROM answers')).toEqual(answers);
    await runtime();await panel.getByRole('button',{name:'Read original restore',exact:true}).click();await expect(panel).toContainText('Original restore saved');
    await panel.getByRole('button',{name:'Restore session',exact:true}).click();await chat();await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();expect(sql('SELECT current_leaf_id,storage_version FROM sessions WHERE id=1')).toEqual(moved);
    await expect(page.getByLabel('Message text',{exact:true})).toHaveValue('ENGINEERING retained draft');const count=received.length;
    const restoredTranscript=async()=>{const native=page.getByTestId('chat-native-messages');await expect(native).toContainText('ENGINEERING A original');await expect(native).not.toContainText('ENGINEERING A correction Shanghai');await expect(native).not.toContainText('ENGINEERING A after restart');await expect(page.getByTestId('temporary-run-area')).toHaveCount(0);await expect(page.getByTestId('saved-final-area')).toHaveCount(0);};
    await restoredTranscript();
    await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Runtime',exact:true}).click();await page.getByRole('button',{name:'Restart Host',exact:true}).click();await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});await page.getByRole('button',{name:'Chat',exact:true}).click();await restoredTranscript();expect(received).toHaveLength(count);
    writeFileSync(failRead,'ENGINEERING');await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Models',exact:true}).click();await chat();await expect(page.getByTestId('chat-native-messages')).toContainText('Message history read failed.');await restoredTranscript();expect(received).toHaveLength(count);rmSync(failRead);
    await desktop.close();desktop=await launchActualDev(join(root,'restart'),dataRoot,source,undefined,entry);page=desktop.page;panel=page.getByTestId('session-checkpoints');resume=panel.getByRole('button',{name:'Resume from here · Run 1',exact:true});dialog=page.getByRole('dialog',{name:'Resume from this saved turn?'});await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});await runtime();if(!await resume.isVisible())await panel.getByText('Browse saved turns',{exact:true}).click();await chat();await restoredTranscript();expect(received).toHaveLength(count);
    await send('ENGINEERING branch question');expect(received).toHaveLength(count+1);
    const payload=JSON.stringify(received.at(-1)!.messages);expect(payload).toContain('ENGINEERING A original');expect(payload).not.toContain('ENGINEERING A correction Shanghai');expect(payload).not.toContain('ENGINEERING A after restart');
    writeFileSync(dropReply,'ENGINEERING');await runtime();await expect(resume).toBeEnabled();await resume.click();await dialog.getByRole('button',{name:'Resume from here',exact:true}).click();
    await expect(panel).toContainText('Restore result unconfirmed.',{timeout:15000});const committed=sql('SELECT * FROM business_events WHERE type=\'session_checkpoint_restored\'');
    await panel.getByRole('button',{name:'Read original restore',exact:true}).click();await expect(panel).toContainText('Original restore saved');expect(sql('SELECT * FROM business_events WHERE type=\'session_checkpoint_restored\'')).toEqual(committed);expect(received).toHaveLength(count+1);
    await chat();await page.locator('[data-session-id="2"] > button').first().click();await page.getByLabel('Message text',{exact:true}).fill('ENGINEERING B draft');await page.locator('[data-session-id="1"] > button').first().click();
    await runtime();await page.setViewportSize({width:900,height:900});await page.evaluate(()=>{document.body.style.zoom='2';});await expect(panel.getByRole('button',{name:'Refresh saved turns'})).toBeVisible();await page.screenshot({path:testInfo.outputPath('p9-memory.png'),fullPage:true});
  }finally{
    try{await desktop?.close();}finally{provider.closeAllConnections();await new Promise<void>(done=>provider.close(()=>done()));rmSync(root,{recursive:true,force:true});}
  }
});
