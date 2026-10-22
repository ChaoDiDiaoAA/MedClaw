import {expect,test,type Page} from '@playwright/test';
import {mkdtempSync,rmSync,existsSync,cpSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createStartupPackage,launchActualDev,readStartupFacts,bunExecutable} from '../fixtures/desktop-dev';

async function configure(page:Page,baseUrl:string) {
  const result=await page.evaluate(async baseUrl=>{
    const models=await window.medclaw.request('model.read',{});if(!models.ok)throw new Error(models.error.code);
    const token=await window.medclaw.secretInput({providerId:'p12-fixture',purpose:'custom_api_key',value:'ENGINEERING-LOCAL'});if(!token.ok)throw new Error(token.error.code);
    const saved=await window.medclaw.request('model.custom.save',{expectedConfigVersion:models.data.configVersion,credentialInput:token.data.token,definition:{providerId:'p12-fixture',name:'ENGINEERING',api:'openai-completions',baseUrl,models:[{id:'fixture',name:'ENGINEERING',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,outputLimitConfirmed:true,pricingKnown:false,cost:null}]}});if(!saved.ok)throw new Error(saved.error.code);
    return window.medclaw.request('model.configure',{provider:'p12-fixture',modelId:'fixture',expectedConfigVersion:saved.data.configVersion});
  },baseUrl);expect(result.ok).toBe(true);
}
async function recent(page:Page) {return page.evaluate(async()=>{const result=await window.medclaw.request('run.read',{recent:true});return result.ok&&result.data.kind==='recent'?result.data.runs[0]:null;});}
async function send(page:Page,text:string) {
  await page.getByRole('button',{name:'Chat',exact:true}).click();await page.getByLabel('Message text',{exact:true}).fill(text);
  const lookup=page.getByRole('button',{name:'Read original submission',exact:true});
  const fresh=page.getByRole('button',{name:'Start a new attempt',exact:true});
  await expect.poll(async()=>{
    for(const recovery of [fresh,lookup]) {
      const ready=await recovery.evaluateAll(buttons=>buttons.some(button=>{
        const {width,height}=button.getBoundingClientRect();
        return width>0&&height>0&&getComputedStyle(button).visibility==='visible'&&button.matches(':enabled');
      }));
      if(!ready)continue;
      try{await recovery.click({timeout:1000});}
      catch(error){if(await recovery.count()!==0)throw error;}
      break;
    }
    return page.getByRole('button',{name:'Send',exact:true}).evaluateAll(buttons=>buttons.some(button=>button.matches(':enabled')));
  },{timeout:15000}).toBe(true);
  await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Send',exact:true}).click();
}
async function select(page:Page) {
  await page.getByRole('button',{name:'Extensions',exact:true}).click();
  // Fault injection changes author files; reread the validated directory before configuring.
  await page.getByRole('button',{name:'Refresh extensions',exact:true}).click({timeout:15000});
  const configure=page.getByRole('button',{name:'Configure extension',exact:true});
  await expect(configure).toBeVisible({timeout:15000});await expect(configure).toBeEnabled({timeout:15000});
  if(await configure.getAttribute('aria-expanded')!=='true')await configure.click();await expect(page.getByLabel('Enable tool-audit')).toBeEnabled();
  await page.getByLabel('Enable tool-audit').uncheck();await page.getByLabel('Enable tool-audit').check();await page.getByRole('button',{name:'Save extension selection',exact:true}).click();
  await expect(page.getByTestId('extensions-panel')).toContainText('Saved for the next assembly.');
}

test('p12 actual Electron selects, changes final page arguments, invokes original command, isolates A/B and stops before restart',async({},info)=>{
  test.setTimeout(180000);const root=mkdtempSync(join(tmpdir(),'medclaw-p12-desktop-')),dataRoot=join(root,'isolated data'),source=join(root,'ENGINEERING source');createStartupPackage(source);
  const received:Record<string,any>[]=[];let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  const provider=createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;const payload=JSON.parse(raw);received.push(payload);const step=received.length;
    const query=()=>JSON.parse(payload.messages.findLast((m:Record<string,any>)=>m.role==='tool'&&m.tool_call_id==='p12-desktop-3').content).queryId;
    const time={start:'2026-01-01',endExclusive:'2026-01-02'},name=['read_data_scope','check_data_coverage','query_current_devices','read_query_page','extension_runtime_status'][step-1];
    if(step===6)await pending;
    const args=step===1||step===5?{}:step===2?{time}:step===3?{batchIds:[1],time}:{queryId:query(),page:1,pageSize:100};
    const delta=name?{role:'assistant',tool_calls:[{index:0,id:`p12-desktop-${step}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:'ENGINEERING'};
    response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta,finish_reason:name?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));let desktop:Awaited<ReturnType<typeof launchActualDev>>|undefined;
  try {
    desktop=await launchActualDev(root,dataRoot,source);const page=desktop.page;await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});
    await configure(page,`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`);await page.getByRole('button',{name:'New Session',exact:true}).click();
    await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Choose snapshot directory',exact:true}).click();
    await expect(page.getByRole('button',{name:'Confirm import',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Confirm import',exact:true}).click();
    await expect(page.getByLabel('Select batch 1',{exact:true})).toBeVisible();await page.getByLabel('Select batch 1',{exact:true}).check();await page.getByRole('button',{name:'Apply 1 selected batches',exact:true}).click();
    await select(page);expect(received).toHaveLength(0);await send(page,'ENGINEERING read a saved page and inspect tool audit');await expect.poll(()=>received.length,{timeout:30000}).toBe(6);
    const original=await recent(page);if(!original)throw new Error('No Run');
    const tools=await page.evaluate(runId=>window.medclaw.request('tool.read',{runId}),original.id);if(!tools.ok)throw new Error(tools.error.code);
    expect(tools.data.items.find(tool=>tool.name==='read_query_page')).toMatchObject({status:'succeeded',control:{hookInput:{changed:true}}});
    const savedArgs=JSON.parse(execFileSync(bunExecutable,['-e',`import {Database} from 'bun:sqlite';const db=new Database(${JSON.stringify(join(dataRoot,'data/app.sqlite'))},{readonly:true});console.log(db.query("SELECT args_json FROM tool_calls WHERE run_id=? AND tool_name='read_query_page'").get(${original.id}).args_json);db.close();`],{cwd:resolve('.'),encoding:'utf8'}));expect(savedArgs.pageSize).toBe(20);
    expect(received[4]!.messages.findLast((m:any)=>m.role==='tool').content).toContain('"pageSize":20');
    await page.getByRole('button',{name:'Extensions',exact:true}).click();await expect(page.getByRole('button',{name:'Read extension status',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Read extension status',exact:true}).click();await expect(page.getByTestId('extension-command')).toContainText('"seenToolCalls": 5');expect(received).toHaveLength(6);
    await page.getByRole('button',{name:'Chat',exact:true}).click();await page.getByRole('button',{name:'New Session',exact:true}).click();await page.getByRole('button',{name:'Extensions',exact:true}).click();await expect(page.getByTestId('extensions-panel')).toContainText('Session 2');await expect(page.getByTestId('extensions-panel')).toContainText('No assembly evidence');
    await page.getByRole('button',{name:'Chat',exact:true}).click();await page.locator('[data-session-id="1"]').getByRole('button').first().click();await page.getByRole('button',{name:'Extensions',exact:true}).click();await expect(page.getByTestId('extensions-panel')).toContainText('Session 1');await expect(page.getByRole('button',{name:'Read extension status',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Stop active Run',exact:true}).click();await expect.poll(async()=>{const read=await page.evaluate(runId=>window.medclaw.request('extensions.read',{source:'run',runId}),original.id);return read.ok&&read.data.source==='run'&&read.data.assembly?.resourcesReleased;},{timeout:30000}).toBe(true);
    const proof=await page.evaluate(runId=>window.medclaw.request('extensions.read',{source:'run',runId}),original.id);expect(proof).toMatchObject({ok:true,data:{assembly:{state:'disposed',runId:original.id,sessionId:1},cleanup:{resourcesReleased:true}}});
    await page.getByRole('button',{name:'Refresh extensions',exact:true}).click();await expect(page.getByTestId('extensions-panel')).toContainText('Recorded disposed');await page.screenshot({path:info.outputPath('p12-original-release.png'),fullPage:true});
    await page.getByLabel('Enable tool-audit').uncheck();await page.getByRole('button',{name:'Save extension selection',exact:true}).click();await expect(page.getByTestId('extensions-panel')).toContainText('Selection: Disabled');
    const host=await page.evaluate(()=>window.medclaw.request('host.read',{}));await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Runtime',exact:true}).click();await page.getByRole('button',{name:'Restart Host',exact:true}).click();
    await expect.poll(async()=>{const now=await page.evaluate(()=>window.medclaw.request('host.read',{}));return now.ok&&host.ok&&now.data.state==='ready'&&now.data.instanceId!==host.data.instanceId;},{timeout:30000}).toBe(true);
    expect(await page.evaluate(runId=>window.medclaw.request('extensions.read',{source:'run',runId}),original.id)).toEqual(proof);expect(received).toHaveLength(6);
    await info.attach('p12-engineering-evidence',{body:JSON.stringify({externalProvider:'NOT_RUN',originalRun:original.id,requests:received.length,proof,tools:tools.data.items,sqlite:readStartupFacts(dataRoot)}),contentType:'application/json'});
  }finally{release();await desktop?.close();provider.closeAllConnections();await new Promise<void>(done=>provider.close(()=>done()));if(!desktop||existsSync(join(root,'dev-exit-confirmed')))rmSync(root,{recursive:true,force:true});}
});

test('p12 actual desktop exposes trusted engineering load, Hook and cleanup faults without treating them as compatibility successes',async({},info)=>{
  test.setTimeout(180000);const root=mkdtempSync(join(tmpdir(),'medclaw-p12-fault-desktop-')),dataRoot=join(root,'isolated data'),author=join(root,'author');cpSync(resolve('resources/extensions'),author,{recursive:true});
  const entry=join(author,'tool-audit/v1/index.ts'),baseline=readFileSync(entry,'utf8'),hold=join(root,'close-hold'),hostEntry=join(root,'controlled-host.ts');
  // Only this isolated test Host gets an alternate trusted author root. Product selection still accepts no paths.
  writeFileSync(hostEntry,`import {PiAgentRuntime} from ${JSON.stringify(resolve('packages/runtime-pi/src/agent-runtime.ts'))};import {existsSync} from 'node:fs';
    for(const name of ['readExtensionDescriptor','freezeExtensions']){const original=PiAgentRuntime.prototype[name];PiAgentRuntime.prototype[name]=function(...args){this.extensionRoot=${JSON.stringify(author)};return original.apply(this,args);};}
    globalThis.p12Close=()=>new Promise(resolve=>{if(!existsSync(${JSON.stringify(hold)})){resolve();return;}const timer=setInterval(()=>{if(!existsSync(${JSON.stringify(hold)})){clearInterval(timer);resolve();}},20);});
    await import(${JSON.stringify(resolve('apps/host/src/main.ts'))});`);
  let mode='factory',scriptStep=0;const received:Record<string,any>[]=[],proofs:unknown[]=[];
  const provider=createServer(async(request,response)=>{
    let body='';for await(const chunk of request)body+=chunk;received.push(JSON.parse(body));const call=++scriptStep===1;
    const name=mode==='schema'?'read_query_page':'extension_runtime_status',args=mode==='schema'?{queryId:1,page:1,pageSize:100}:{};
    const delta=call?{role:'assistant',tool_calls:[{index:0,id:'p12-fault-'+received.length,type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:'ENGINEERING'};
    response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta,finish_reason:call?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
  });await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));let desktop:Awaited<ReturnType<typeof launchActualDev>>|undefined,passed=false;
  try {
    desktop=await launchActualDev(root,dataRoot,undefined,undefined,hostEntry);const page=desktop.page;
    await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});await configure(page,`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`);await page.getByRole('button',{name:'New Session',exact:true}).click();
    for(mode of ['factory','critical','observation','schema','cleanup','close_throw']) {
      const code=mode==='factory'?baseline.replace('const factory: ExtensionFactory = pi => {',"const factory: ExtensionFactory = pi => {throw new Error('ENGINEERING factory');"):
        mode==='critical'?baseline.replace('seenToolCalls++;',"seenToolCalls++;throw new Error('ENGINEERING critical');"):
        mode==='observation'?baseline.replace("pi.on('tool_result', () => {})","pi.on('tool_result', () => {throw new Error('ENGINEERING observation');})"):
        mode==='schema'?baseline.replace('Math.min(event.input.pageSize, 20)','-1'):
        mode==='close_throw'?baseline.replace('Promise.resolve().then(() => { closed = true;',"Promise.resolve().then(() => {throw new Error('ENGINEERING close');closed = true;"):
        baseline.replace('Promise.resolve().then(() => { closed = true;','Promise.resolve().then(async () => {await (globalThis as any).p12Close();closed = true;');
      writeFileSync(entry,code);if(mode==='cleanup')writeFileSync(hold,'hold');
      await select(page);scriptStep=0;const before=received.length,prior=await recent(page);await send(page,'ENGINEERING '+mode);
      await expect.poll(async()=>{const run=await recent(page);return run&&run.id!==prior?.id?run.status:null;},{timeout:30000}).toBe(mode==='factory'||mode==='critical'?'failed':'completed');
      const run=await recent(page);if(!run)throw new Error('No fault Run');await page.getByRole('button',{name:'Extensions',exact:true}).click();await page.getByRole('button',{name:'Refresh extensions',exact:true}).click();
      const proof=await page.evaluate(runId=>window.medclaw.request('extensions.read',{source:'run',runId}),run.id);proofs.push({mode,proof});if(!proof.ok||proof.data.source!=='run'||!proof.data.assembly)throw new Error('No fault evidence');
      if(mode==='factory'){expect(received.length-before).toBe(0);expect(proof.data.assembly.loadedAt).toBeNull();}
      if(mode==='critical'){expect(received.length-before).toBe(1);expect(proof.data.assembly.diagnostics.some(error=>error.code==='extension_hook_failed')).toBe(true);}
      if(mode==='observation'){expect(proof.data.assembly.diagnostics.some(error=>error.code==='extension_hook_failed')).toBe(true);const tools=await page.evaluate(runId=>window.medclaw.request('tool.read',{runId}),run.id);expect(tools).toMatchObject({ok:true,data:{items:[expect.objectContaining({status:'succeeded'})]}});}
      if(mode==='schema'){const tools=await page.evaluate(runId=>window.medclaw.request('tool.read',{runId}),run.id);if(!tools.ok)throw new Error(tools.error.code);expect(tools.data.items[0]?.error?.code).toBe('tool_input_invalid');}
      if(mode==='cleanup') {
        expect(proof.data.assembly.resourcesReleased).toBe(false);await expect(page.getByTestId('extensions-panel')).toContainText('extension_cleanup_failed');await expect(page.getByRole('button',{name:'Save extension selection',exact:true})).toBeDisabled();
        await test.step('Capture the unconfirmed extension cleanup state',async()=>{
          await page.screenshot({path:info.outputPath('p12-cleanup-unconfirmed.png'),fullPage:true,timeout:15000});
        });rmSync(hold);
        await expect.poll(async()=>{const p=await page.evaluate(runId=>window.medclaw.request('extensions.read',{source:'run',runId}),run.id);return p.ok&&p.data.source==='run'&&p.data.assembly?.resourcesReleased;},{timeout:10000}).toBe(true);
        expect(await page.evaluate(runId=>window.medclaw.request('run.retrySave',{runId}),run.id)).toMatchObject({ok:true,data:{status:'completed',cleanup:{resourcesReleased:true}}});
      }
      if(mode==='close_throw') {
        expect(proof.data.assembly.resourcesReleased).toBe(false);const old=await page.evaluate(()=>window.medclaw.request('host.read',{}));
        await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Runtime',exact:true}).click();await page.getByRole('button',{name:'Restart Host',exact:true}).click();
        await expect.poll(async()=>{const h=await page.evaluate(()=>window.medclaw.request('host.read',{}));return h.ok&&old.ok&&h.data.state==='ready'&&h.data.instanceId!==old.data.instanceId;},{timeout:30000}).toBe(true);
        expect(await page.evaluate(runId=>window.medclaw.request('extensions.read',{source:'run',runId}),run.id)).toMatchObject({ok:true,data:{assembly:{assemblyId:proof.data.assembly.assemblyId,state:'disposed',resourcesReleased:true},cleanup:{resourcesReleased:true}}});
        expect((await recent(page))?.status).toBe('completed');
      }
    }
    await page.getByRole('button',{name:'Extensions',exact:true}).click();
    const configureBeforeRemoval=page.getByRole('button',{name:'Configure extension',exact:true});
    if(await configureBeforeRemoval.getAttribute('aria-expanded')==='true')await configureBeforeRemoval.click();
    await expect(configureBeforeRemoval).toHaveAttribute('aria-expanded','false');
    rmSync(entry);
    await page.getByRole('button',{name:'Extensions',exact:true}).click();await page.getByRole('button',{name:'Refresh extensions',exact:true}).click();
    const configureButton=page.getByRole('button',{name:'Configure extension',exact:true});if(await configureButton.getAttribute('aria-expanded')!=='true')await configureButton.click();const enabled=page.getByRole('switch',{name:'Enable tool-audit',exact:true});await expect(enabled).toBeChecked();await expect(enabled).toBeEnabled();await enabled.uncheck();
    await page.getByRole('button',{name:'Save extension selection',exact:true}).click();await expect(page.getByTestId('extensions-panel')).toContainText('Selection: Disabled');await expect(enabled).toBeDisabled();
    expect(await page.evaluate(()=>window.medclaw.request('extensions.read',{source:'selection',sessionId:1}))).toMatchObject({ok:true,data:{selection:{extension:null},available:null}});
    await info.attach('p12-desktop-fault-evidence',{body:JSON.stringify({kind:'ENGINEERING_FIXTURES',thirdPartyCompatibility:'NOT_RUN',proofs,unavailableSelectionDisabled:true}),contentType:'application/json'});
    passed=true;
  } finally {if(!passed)console.log('P12_FAULT_ROOT_RETAINED '+root);rmSync(hold,{force:true});await desktop?.close();provider.closeAllConnections();await new Promise<void>(done=>provider.close(()=>done()));if(passed&&existsSync(join(root,'dev-exit-confirmed')))rmSync(root,{recursive:true,force:true});}
});
