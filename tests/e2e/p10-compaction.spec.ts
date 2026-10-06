import {expect,test} from '@playwright/test';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createStartupPackage,launchActualDev,bunExecutable} from '../fixtures/desktop-dev';

test('p10 actual desktop saves native compaction, preserves drafts, cancels and restores, and reads original facts after restart',async({},testInfo)=>{
  test.setTimeout(180000);
  const root=mkdtempSync(join(tmpdir(),'medclaw-p10-desktop-')),dataRoot=join(root,'isolated data'),source=join(root,'ENGINEERING source');createStartupPackage(source);
  const hold=join(root,'hold-summary'),auto=join(root,'automatic'),dropNotice=join(root,'drop-notice'),entry=join(root,'controlled-host.ts');
  // Engineering window settings exercise the genuine public SDK path; production keeps SDK defaults.
  writeFileSync(entry,`import {PiAgentRuntime} from ${JSON.stringify(resolve('packages/runtime-pi/src/agent-runtime.ts'))};
    import {existsSync} from 'node:fs';const describe=PiAgentRuntime.prototype.describe;PiAgentRuntime.prototype.describe=function(model){return {...describe.call(this,model),compaction:{contract:'medclaw.compaction/v1',enabled:existsSync(${JSON.stringify(auto)}),reserveTokens:256,keepRecentTokens:128}};};
    const write=process.stdout.write.bind(process.stdout);process.stdout.write=function(chunk,...args){try{const frame=JSON.parse(String(chunk));if(existsSync(${JSON.stringify(dropNotice)})&&frame.kind==='notice'&&frame.notice?.type==='compaction.progress'){for(const callback of args)if(typeof callback==='function')queueMicrotask(()=>callback());return true;}}catch{}return write(chunk,...args);};
    await import(${JSON.stringify(resolve('apps/host/src/main.ts'))});`);
  const received:Record<string,unknown>[]=[];let summaryWaiting=false,releaseSummary=()=>{};
  const provider=createServer(async(request,response)=>{
    let body='';for await(const chunk of request)body+=chunk;const value=JSON.parse(body);received.push(value);
    const main=body.includes('MedClaw trusted runtime feedback');
    if(!main&&existsSync(hold)){summaryWaiting=true;await new Promise<void>(done=>{releaseSummary=done;});}
    const content=main?'ENGINEERING answer '+ 'a'.repeat(500):'ENGINEERING native summary Shanghai approved';
    const tokens=main&&existsSync(auto)?32600:10;
    if(!response.destroyed){response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:tokens,completion_tokens:2,total_tokens:tokens+2}})}\n\ndata: [DONE]\n\n`);}
  });
  await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));
  const sql=(query:string,write=false)=>JSON.parse(execFileSync(bunExecutable,['-e',`import{Database}from'bun:sqlite';const db=new Database(${JSON.stringify(join(dataRoot,'data/app.sqlite'))},${write?'{create:true,strict:true}':'{readonly:true}'});${write?`db.exec('PRAGMA foreign_keys=ON');db.exec(${JSON.stringify(query)});console.log('null');`:`console.log(JSON.stringify(db.query(${JSON.stringify(query)}).all()));`}db.close();`],{cwd:resolve('.'),encoding:'utf8'}));
  let desktop:Awaited<ReturnType<typeof launchActualDev>>|undefined;
  try {
    desktop=await launchActualDev(root,dataRoot,source,undefined,entry);let page=desktop.page;
    await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});
    expect((await page.evaluate(async baseUrl=>{
      const models=await window.medclaw.request('model.read',{});if(!models.ok)throw new Error(models.error.code);
      const token=await window.medclaw.secretInput({providerId:'p10-fixture',purpose:'custom_api_key',value:'ENGINEERING-LOCAL'});if(!token.ok)throw new Error(token.error.code);
      const saved=await window.medclaw.request('model.custom.save',{expectedConfigVersion:models.data.configVersion,credentialInput:token.data.token,definition:{providerId:'p10-fixture',name:'ENGINEERING',api:'openai-completions',baseUrl,models:[{id:'fixture',name:'ENGINEERING',input:['text'],reasoning:false,contextWindow:32768,maxTokens:128,outputLimitConfirmed:true,pricingKnown:false,cost:null}]}});if(!saved.ok)throw new Error(saved.error.code);
      return window.medclaw.request('model.configure',{provider:'p10-fixture',modelId:'fixture',expectedConfigVersion:saved.data.configVersion});
    },`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`)).ok).toBe(true);
    await page.getByRole('button',{name:'New Session',exact:true}).click();
    await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Choose snapshot directory',exact:true}).click();
    await expect(page.getByRole('button',{name:'Confirm import',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Confirm import',exact:true}).click();
    await expect(page.getByLabel('Select batch 1',{exact:true})).toBeVisible();await page.getByLabel('Select batch 1',{exact:true}).check();await page.getByRole('button',{name:'Apply 1 selected batches',exact:true}).click();
    await page.getByRole('button',{name:'Chat',exact:true}).click();
    let panel=page.getByTestId('session-compaction');
    const idle=async()=>{await expect.poll(async()=>{const r=await page.evaluate(()=>window.medclaw.request('run.control.read',{}));return r.ok&&r.data.acceptingNewRuns;},{timeout:15000}).toBe(true);};
    const send=async(text:string)=>{await page.getByLabel('Message text',{exact:true}).fill(text);await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Send',exact:true}).click();await expect.poll(()=>received.some(r=>JSON.stringify(r.messages).includes(text))).toBe(true);await idle();};
    const compact=async()=>{await expect(panel.getByRole('button',{name:'Compact context',exact:true})).toBeEnabled();await panel.getByRole('button',{name:'Compact context',exact:true}).click();};
    await page.getByLabel('Message text',{exact:true}).fill('ENGINEERING retained draft');
    const empty=sql('SELECT storage_version FROM sessions WHERE id=1');await compact();await expect(panel).toContainText('Compaction · no_op');await idle();
    expect(received).toHaveLength(0);expect(sql('SELECT storage_version FROM sessions WHERE id=1')).toEqual(empty);
    for(let i=0;i<3;i++)await send('ENGINEERING original '+i+' '+ 'x'.repeat(500));
    await page.getByLabel('Message text',{exact:true}).fill('ENGINEERING retained draft');
    const before=sql('SELECT id FROM runs'),answers=sql('SELECT id FROM answers'),inputs=sql('SELECT id FROM session_inputs');
    writeFileSync(dropNotice,'ENGINEERING lost progress');await compact();await expect(panel).toContainText('Compaction · completed',{timeout:15000});await idle();rmSync(dropNotice);
    await expect(panel.locator('dl')).toContainText('Native generatedYesNative savedYesCan continueYes');
    await expect(page.getByTestId('chat-native-messages')).toContainText('ENGINEERING native summary Shanghai');
    await expect(page.getByLabel('Message text',{exact:true})).toHaveValue('ENGINEERING retained draft');
    expect(sql('SELECT id FROM runs')).toEqual(before);expect(sql('SELECT id FROM answers')).toEqual(answers);expect(sql('SELECT id FROM session_inputs')).toEqual(inputs);
    const calls=sql("SELECT run_id,input_id,state,json_extract(model_json,'$.compaction.nativeEntryId') native_id FROM model_calls WHERE kind='compaction'");expect(calls.length).toBeGreaterThan(0);for(const call of calls)expect(call).toMatchObject({run_id:null,input_id:null,state:'completed',native_id:expect.any(String)});
    const latest=await page.evaluate(()=>window.medclaw.request('session.read',{sessionId:1}));expect(latest).toMatchObject({ok:true,data:{compactionOperation:{status:'completed',nativeSaved:true,calls:expect.any(Array)}}});
    await send('ENGINEERING after compaction '+ 'z'.repeat(500));
    writeFileSync(hold,'ENGINEERING pending summary');await compact();await expect.poll(()=>summaryWaiting).toBe(true);await expect(panel.getByRole('button',{name:'Cancel compaction',exact:true})).toBeEnabled();await panel.getByRole('button',{name:'Cancel compaction',exact:true}).click();
    releaseSummary();rmSync(hold);await expect(panel).toContainText('Compaction · cancelled',{timeout:15000});await expect(panel.getByRole('button',{name:'Restore compaction session',exact:true})).toBeEnabled();await panel.getByRole('button',{name:'Restore compaction session',exact:true}).click();await idle();
    const savedPosition=sql('SELECT current_leaf_id,storage_version FROM sessions WHERE id=1');
    sql("CREATE TRIGGER p10_receipt_fault BEFORE INSERT ON business_events WHEN NEW.type='session_compaction_finished' BEGIN SELECT RAISE(ABORT,'ENGINEERING save failure'); END;",true);
    await compact();await expect(panel).toContainText('Compaction · unconfirmed · blocked',{timeout:15000});await expect(panel.locator('dl')).toContainText('Native generatedYesNative savedNoCan continueNo');expect(sql('SELECT current_leaf_id,storage_version FROM sessions WHERE id=1')).toEqual(savedPosition);
    const failureCount=received.length;sql('DROP TRIGGER p10_receipt_fault',true);await panel.getByRole('button',{name:'Restore compaction session',exact:true}).click();await idle();await expect(panel).toContainText('Compaction · failed');expect(received).toHaveLength(failureCount);expect(sql('SELECT current_leaf_id,storage_version FROM sessions WHERE id=1')).toEqual(savedPosition);
    const count=received.length;await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Restart Host',exact:true}).click();await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});await page.getByRole('button',{name:'Chat',exact:true}).click();
    await expect(panel).toContainText('Compaction · failed');expect(received).toHaveLength(count);
    writeFileSync(auto,'ENGINEERING auto threshold');await send('ENGINEERING automatic '+ 'w'.repeat(500));
    expect(sql("SELECT id FROM runtime_events WHERE type='compaction_completed'")).toHaveLength(1);
    const autoCalls=sql("SELECT run_id,input_id,json_extract(model_json,'$.compaction.nativeEntryId') native_id FROM model_calls WHERE kind='compaction' AND run_id IS NOT NULL");expect(autoCalls.length).toBeGreaterThan(0);for(const call of autoCalls)expect(call).toMatchObject({run_id:expect.any(Number),input_id:null,native_id:expect.any(String)});
    // Full window restart discovers the original manual operation through session.read.
    const committed=sql("SELECT * FROM business_events WHERE type='session_compaction_finished'"),requestCount=received.length;
    await desktop.close();desktop=await launchActualDev(join(root,'restart'),dataRoot,source,undefined,entry);page=desktop.page;panel=page.getByTestId('session-compaction');await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});
    await expect(panel).toContainText('Compaction · failed');await panel.getByRole('button',{name:'Read original compaction',exact:true}).click();expect(sql("SELECT * FROM business_events WHERE type='session_compaction_finished'")).toEqual(committed);expect(received).toHaveLength(requestCount);
    await page.screenshot({path:testInfo.outputPath('p10-compaction.png'),fullPage:true});
  } finally {
    releaseSummary();try{await desktop?.close();}finally{provider.closeAllConnections();await new Promise<void>(done=>provider.close(()=>done()));rmSync(root,{recursive:true,force:true});}
  }
});
