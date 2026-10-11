import { readIntentStageMessage } from '../fixtures/p14-intent';
import {expect,test,_electron as electron} from '@playwright/test';
import {existsSync,mkdirSync,mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {createServer} from 'node:http';
import {launchActualDev,createStartupPackage} from '../fixtures/desktop-dev';
import {DEFAULT_INTENT_MODEL} from '../../packages/contracts/src/model';
import {productIntent,resolvedIntent} from '../fixtures/p14-intent';
import {IntentReadResultSchema,INTENT_VERSIONS,type IntentReadResult,type IntentStageInput} from '../../packages/contracts/src/intent';

test('p14 renderer rejects late Run, Host and same-owner intent reads without inference',async()=>{
  test.setTimeout(60000);
  const directory=resolve('.build/p14-intent-renderer'),require=createRequire(resolve('apps/desktop/package.json'));mkdirSync(directory,{recursive:true});
  const entry=join(directory,'fixture.ts'),bundle=join(directory,'fixture.js');
  writeFileSync(entry,`import React from ${JSON.stringify(require.resolve('react'))};import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};import {IntentPanel} from ${JSON.stringify(resolve('apps/desktop/src/renderer/intent-panel.tsx'))};
    const root=createRoot(document.getElementById('root'));globalThis.intentPending=[];
    window.medclaw={request:(method,payload)=>new Promise(resolve=>globalThis.intentPending.push({method,payload,resolve}))};
    globalThis.renderIntent=(runId,sessionId,instanceId,refreshToken)=>root.render(React.createElement(IntentPanel,{host:{state:'ready',instanceId},runId,sessionId,inputId:runId,refreshToken}));
    globalThis.renderIntent(1,1,'HostA','0');`);
  execFileSync('bun',['build',entry,'--target=browser',`--outfile=${bundle}`],{cwd:resolve('.'),stdio:'pipe'});
  const server=createServer((request,response)=>{response.setHeader('content-type',request.url==='/fixture.js'?'text/javascript':'text/html');response.end(request.url==='/fixture.js'?readFileSync(bundle):'<main id="root"></main><script type="module" src="/fixture.js"></script>');});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const main=join(directory,'browser.cjs');writeFileSync(main,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory,'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});win.loadURL(${JSON.stringify(url)});});`);
  const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
  type Fixture=typeof window&{renderIntent:(runId:number,sessionId:number,instanceId:string,refreshToken:string)=>void;intentPending:{method:string;payload:{runId:number};resolve:(value:{ok:true;data:IntentReadResult|null})=>void}[]};
  const facts=(runId:number,sessionId:number,reasonCode:string)=>IntentReadResultSchema.parse({contract:'medclaw.intent-read/v2',runId,sessionId,inputId:runId,
    ruleEvaluation:{ruleVersion:INTENT_VERSIONS.ruleVersion,ruleId:null,inputHash:'a'.repeat(64),outcome:'miss',reasonCode,checkedAt:'2026-10-10T00:00:00.000Z'},calls:[],decision:null,
    execution:{runStatus:'running',queryIds:[],stepResults:[],answerId:null,finalHistorySaved:false,requiredPersistenceComplete:null},effectiveContext:null});
  try{
    app=await electron.launch({executablePath:require('electron'),args:[main],env});const page=await app.firstWindow(),panel=page.getByRole('region',{name:'Intent recognition',exact:true});
    await page.waitForFunction(()=>Array.isArray((window as Fixture).intentPending));
    const count=()=>page.evaluate(()=>(window as Fixture).intentPending.length);
    const render=(instance='HostA',token='0')=>page.evaluate(({instance,token})=>(window as Fixture).renderIntent(2,2,instance,token),{instance,token});
    const reply=(index:number,data:IntentReadResult|null)=>page.evaluate(({index,data})=>(window as Fixture).intentPending[index]!.resolve({ok:true,data}),{index,data});
    await expect.poll(count).toBe(1);await render();await expect.poll(count).toBe(2);
    await reply(1,facts(2,2,'OWNED_SECOND_RUN'));await expect(panel).toContainText('OWNED_SECOND_RUN');
    await reply(0,facts(1,1,'LATE_FIRST_RUN'));await expect(panel).toContainText('OWNED_SECOND_RUN');await expect(panel).not.toContainText('LATE_FIRST_RUN');
    await render('HostA','1');await expect.poll(count).toBe(3);await render('HostA','2');await expect.poll(count).toBe(4);
    await reply(3,facts(2,2,'NEWER_SAME_OWNER'));await expect(panel).toContainText('NEWER_SAME_OWNER');
    await reply(2,facts(2,2,'OLDER_SAME_OWNER'));await expect(panel).toContainText('NEWER_SAME_OWNER');await expect(panel).not.toContainText('OLDER_SAME_OWNER');
    await render('HostB','0');await expect.poll(count).toBe(5);await expect(panel).not.toContainText('NEWER_SAME_OWNER');
    await reply(4,facts(1,1,'WRONG_OWNER'));await expect(panel.getByRole('alert')).toContainText('Intent facts are unconfirmed');await expect(panel).not.toContainText('WRONG_OWNER');
    await panel.getByRole('button',{name:'Refresh intent facts',exact:true}).click();await expect.poll(count).toBe(6);await reply(5,null);await expect(panel).toHaveCount(0);
    expect(await page.evaluate(()=>(window as Fixture).intentPending.map(value=>value.method))).toEqual(Array(6).fill('intent.read'));
  }finally{await app?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});

test('p14 actual detail tab changes publish in order without stale configuration failures',async()=>{
  test.setTimeout(90000);const root=mkdtempSync(join(tmpdir(),'medclaw-p14-ui-'));
  let desktop:Awaited<ReturnType<typeof launchActualDev>>|undefined;
  try{
    desktop=await launchActualDev(root,join(root,'data'));const page=desktop.page;
    await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});
    await page.getByRole('button',{name:'View run details',exact:true}).click();await expect(page.getByRole('tab',{name:'Conditions',exact:true})).toBeVisible();
    await page.evaluate(()=>{
      const observed=window as typeof window&{p14UiChanges:string[]};observed.p14UiChanges=[];
      window.medclaw.subscribe(notice=>{if(notice.type==='config.changed')observed.p14UiChanges.push(notice.configVersion);});
      document.getElementById('runtime-tab')!.click();document.getElementById('conditions-tab')!.click();document.getElementById('runtime-tab')!.click();
    });
    await expect.poll(()=>page.evaluate(()=>(window as typeof window&{p14UiChanges:string[]}).p14UiChanges.length)).toBe(3);
    await expect(page.getByRole('tab',{name:'Run details',exact:true})).toHaveAttribute('aria-selected','true');
    await expect(page.getByRole('alert').filter({hasText:'configuration version has changed'})).toHaveCount(0);
    const saved=await page.evaluate(()=>window.medclaw.request('settings.ui.read',{}));expect(saved).toMatchObject({ok:true,data:{ui:{detailOpen:true,detailTab:'runtime'}}});
  }finally{await desktop?.close();const inside=relative(tmpdir(),root);if((!desktop||existsSync(join(root,'dev-exit-confirmed')))&&inside&&!inside.startsWith('..')&&!inside.includes(':'))rmSync(root,{recursive:true,force:true});}
});

test('p14 actual Models verifies and independently publishes the stock local intent model without inference',async()=>{
  test.setTimeout(180000);
  const root=mkdtempSync(join(tmpdir(),'medclaw-p14-desktop-')),dataRoot=join(root,'data'),paths:string[]=[];
  let digest='a'.repeat(64),offline=false;
  const server=createServer((request,response)=>{
    paths.push(request.url!);response.setHeader('content-type','application/json');
    if(offline){response.writeHead(503);response.end('{}');return;}
    response.end(JSON.stringify(request.url==='/api/version'?{version:'ENGINEERING'}:request.url==='/api/tags'?{models:[{name:'qwen3.5:0.8b',digest}]}:
      request.url==='/api/show'?{details:{family:'qwen35',parameter_size:'752.39M',quantization_level:'Q8_0'}}:{}));
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));let desktop:Awaited<ReturnType<typeof launchActualDev>>|undefined;
  try{
    desktop=await launchActualDev(root,dataRoot);const page=desktop.page;
    await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});
    const before=await page.evaluate(()=>window.medclaw.request('model.read',{}));expect(before.ok).toBe(true);
    await page.getByRole('button',{name:'Models',exact:true}).click();
    const panel=page.getByRole('region',{name:'Intent model',exact:true});await expect(panel).toBeVisible();
    await panel.getByLabel('Ollama URL',{exact:true}).fill(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
    await panel.getByRole('button',{name:'Verify local model',exact:true}).click();
    await expect(panel.getByText('sha256:'+digest,{exact:true}).first()).toBeVisible();
    await panel.getByLabel('Verification record',{exact:true}).fill('ENGINEERING controlled local protocol reference; not model quality evidence');
    await panel.getByLabel('Enable intent routing',{exact:true}).check();
    await panel.getByRole('button',{name:'Apply configuration',exact:true}).click();
    await expect.poll(async()=>{const result=await page.evaluate(()=>window.medclaw.request('model.config.read',{}));return result.ok&&result.data.intentModel?.enabled;}).toBe(true);
    const saved=await page.evaluate(()=>window.medclaw.request('model.config.read',{}));expect(saved.ok).toBe(true);
    if(!saved.ok||!before.ok)throw new Error('ENGINEERING config unavailable');
    const after=await page.evaluate(()=>window.medclaw.request('model.read',{}));expect(after.ok).toBe(true);if(!after.ok)throw new Error('ENGINEERING model directory unavailable');
    expect(after.data.selection).toEqual(before.data.selection);expect(saved.data.intentModel).toMatchObject({modelTag:'qwen3.5:0.8b',modelDigest:'sha256:'+digest,timeoutMs:15000});
    const artifacts=join('.build','p14-desktop-artifacts');mkdirSync(artifacts,{recursive:true});await panel.screenshot({path:join(artifacts,'intent-model.png')});
    await page.setViewportSize({width:760,height:900});
    expect(await panel.evaluate(element=>element.scrollWidth>element.clientWidth)).toBe(false);
    await panel.screenshot({path:join(artifacts,'intent-model-narrow.png')});
    digest='b'.repeat(64);await panel.getByLabel('Intent timeout (ms)',{exact:true}).fill('16000');
    await panel.getByRole('button',{name:'Apply configuration',exact:true}).click();await expect(panel.getByRole('alert')).toContainText('no longer matches the verified model identity');
    const rejected=await page.evaluate(()=>window.medclaw.request('model.config.read',{}));expect(rejected).toEqual(saved);
    offline=true;await panel.getByLabel('Enable intent routing',{exact:true}).uncheck();await panel.getByRole('button',{name:'Apply configuration',exact:true}).click();
    await expect.poll(async()=>{const result=await page.evaluate(()=>window.medclaw.request('model.config.read',{}));return result.ok&&result.data.intentModel?.enabled;}).toBe(false);
    offline=false;digest='a'.repeat(64);await panel.getByRole('button',{name:'Verify local model',exact:true}).click();
    await expect(panel.getByText('Actual identity:',{exact:false})).toBeVisible();
    const restarted=await page.evaluate(async()=>{
      const host=await window.medclaw.request('host.read',{});if(!host.ok||!host.data.instanceId)throw new Error('ENGINEERING Host unavailable');
      return window.medclaw.request('host.restart',{expectedInstanceId:host.data.instanceId});
    });expect(restarted).toMatchObject({ok:true,data:{state:'ready'}});
    await expect(panel.getByText('Actual identity:',{exact:false})).toHaveCount(0);
    const runs=await page.evaluate(()=>window.medclaw.request('run.read',{recent:true}));expect(runs).toMatchObject({ok:true,data:{kind:'recent',runs:[]}});
    expect(paths).not.toContain('/api/chat');expect(paths).not.toContain('/api/generate');
  }finally{
    await desktop?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
    const inside=relative(tmpdir(),root);if((!desktop||existsSync(join(root,'dev-exit-confirmed')))&&inside&&!inside.startsWith('..')&&!inside.includes(':'))rmSync(root,{recursive:true,force:true});
  }
});

test('p14 actual Chat freezes explicit routing, defaults only new drafts and saves real program history',async()=>{
  test.setTimeout(180000);
  const root=mkdtempSync(join(tmpdir(),'medclaw-p14-chat-')),dataRoot=join(root,'data'),source=join(root,'source');createStartupPackage(source);
  const replayControl=join(root,'replay-control.json'),replayPages=join(root,'replay-pages.json'),replayObserver=join(root,'replay-observer.cjs');
  writeFileSync(replayControl,JSON.stringify({sourceId:null,hold:false,loseSubmitText:null}));writeFileSync(replayPages,'[]');
  writeFileSync(replayObserver,`const {ipcMain}=require('electron'),fs=require('fs'),handle=ipcMain.handle.bind(ipcMain),pages=[];let lost=false;
    const control=()=>JSON.parse(fs.readFileSync(${JSON.stringify(replayControl)},'utf8'));
    ipcMain.handle=(channel,listener)=>handle(channel,async(event,envelope)=>{
      const result=await listener(event,envelope);if(channel!=='medclaw:request')return result;const input=envelope.payload,c=control();
      if(envelope.method==='run.read'&&input.runId===c.sourceId&&input.inputLimit===65536){
        pages.push(input.inputOffset);fs.writeFileSync(${JSON.stringify(replayPages)},JSON.stringify(pages));
        if(c.hold)await new Promise(resolve=>{const timer=setInterval(()=>{if(!control().hold){clearInterval(timer);resolve();}},5);timer.unref();});
      }
      if(!lost&&envelope.method==='session.submit'&&input.text===c.loseSubmitText&&result.ok){lost=true;throw new Error('ENGINEERING lost acceptance reply');}
      return result;
    });`);
  const intentRequests:unknown[]=[],mainRequests:unknown[]=[];let failIntent=false,review=false,outcome:'resolved'|'missing'|'ood'|'unsupported'|'ambiguous'|'multi'='resolved';
  let holdIntentStage:'classify'|'verify'|null=null;
  const blockedIntents:{stage:'classify'|'verify';runId:number;release:()=>void}[]=[];
  type MainWire={messages:{role:string;content:unknown}[];tools?:{function:{name:string}}[]};
  const server=createServer(async(request,response)=>{
    response.setHeader('content-type','application/json');
    if(request.url==='/api/version'){response.end(JSON.stringify({version:'ENGINEERING'}));return;}
    if(request.url==='/api/tags'){response.end(JSON.stringify({models:[{name:'qwen3.5:0.8b',digest:'a'.repeat(64)}]}));return;}
    if(request.url==='/api/show'){response.end(JSON.stringify({details:{family:'qwen35'}}));return;}
    let body='';for await(const part of request)body+=part.toString();
    if(request.url==='/api/chat'){
      const received=JSON.parse(body) as {messages:{content:string}[]};intentRequests.push(received);if(failIntent){response.writeHead(503);response.end(JSON.stringify({error:'ENGINEERING unavailable'}));return;}const item=productIntent();
      const stage=readIntentStageMessage(received.messages[1]!.content) as IntentStageInput;
      if(stage.stage===holdIntentStage)await new Promise<void>(release=>blockedIntents.push({stage:stage.stage,runId:stage.input.runId,release}));
      const result=outcome==='ood'||outcome==='unsupported'?{...resolvedIntent(),status:outcome==='ood'?'OUT_OF_SCOPE':'UNSUPPORTED_DATA',intents:[]}:
        outcome==='ambiguous'?{...resolvedIntent(),status:'AMBIGUOUS',intents:[],candidateIntents:stage.stage==='verify'?stage.review!.candidates:[{reasonCode:'suspected_ood',intents:[{...item,slots:{...item.slots,region:'浙江',time:{start:'2026-01-01',endExclusive:'2026-01-02'}}}]}],clarification:{question:'Confirm the requested task.',intentIds:['s1'],missingSlots:[],options:['Search products','Clarify the task']}}:
        outcome==='missing'?{...resolvedIntent(),status:'NEED_PARAMETERS',intents:[{...item,l0:'CHANGE_MONITOR',l1:'RECORD_CHANGE',l2:'NEW_RECORDS',slots:{...item.slots,time:null,changeKind:'added'}}],clarification:{question:'Select the date.',intentIds:['s1'],missingSlots:['s1.time'],options:[]}}:
        outcome==='multi'?{...resolvedIntent(),intents:['active','delisted'].map((status,index)=>({...item,id:`s${index+1}`,dependsOn:index?['s1']:[],slots:{...item.slots,status,region:'浙江',time:{start:'2026-01-01',endExclusive:'2026-01-02'}}}))}:
        {...resolvedIntent(),intents:stage.stage==='verify'?stage.review!.candidates[0]!.intents:[{...item,...(review?{l0:'DATA_OPERATIONS'}:{}),slots:{...item.slots,region:'浙江',time:{start:'2026-01-01',endExclusive:'2026-01-02'}}}]};
      response.end(JSON.stringify({model:'qwen3.5:0.8b',done:true,done_reason:'stop',message:{role:'assistant',content:JSON.stringify(result)},prompt_eval_count:11,eval_count:7}));return;
    }
    const wire=JSON.parse(body) as MainWire;mainRequests.push(wire);response.setHeader('content-type','text/event-stream');
    const delta={role:'assistant',content:'ENGINEERING explicit main answer'};
    response.end(`data: ${JSON.stringify({id:'ENGINEERING',model:'fixture',choices:[{index:0,delta,finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));let desktop:Awaited<ReturnType<typeof launchActualDev>>|undefined;
  try{
    desktop=await launchActualDev(root,dataRoot,source,undefined,undefined,replayObserver);const page=desktop.page,url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    await expect(page.getByText('Host ready',{exact:true}).first()).toBeVisible({timeout:30000});
    const configured=await page.evaluate(async baseUrl=>{
      const directory=await window.medclaw.request('model.read',{});if(!directory.ok)throw new Error(directory.error.code);
      const secret=await window.medclaw.secretInput({providerId:'p14-fixture',purpose:'custom_api_key',value:'ENGINEERING'});if(!secret.ok)throw new Error(secret.error.code);
      const saved=await window.medclaw.request('model.custom.save',{expectedConfigVersion:directory.data.configVersion,credentialInput:secret.data.token,
        definition:{providerId:'p14-fixture',name:'ENGINEERING Chat',api:'openai-completions',baseUrl:baseUrl+'/v1',models:[{id:'fixture',name:'ENGINEERING Chat',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,outputLimitConfirmed:true,pricingKnown:false,cost:null}]}});
      if(!saved.ok)throw new Error(saved.error.code);return window.medclaw.request('model.configure',{provider:'p14-fixture',modelId:'fixture',expectedConfigVersion:saved.data.configVersion});
    },url);expect(configured.ok).toBe(true);
    await page.getByRole('button',{name:'Models',exact:true}).click();await page.getByRole('button',{name:'Reload published directory',exact:true}).click();
    await page.getByRole('button',{name:'New Session',exact:true}).click();
    const routing=page.getByLabel('Message routing',{exact:true});await expect(routing).toHaveValue('main_agent');
    const enabled=await page.evaluate(async({url,model})=>{
      const config=await window.medclaw.request('model.config.read',{});if(!config.ok)throw new Error(config.error.code);
      return window.medclaw.request('model.intent.configure',{expectedConfigVersion:config.data.configVersion,intentModel:{...model,enabled:true,baseUrl:url,modelDigest:'sha256:'+'a'.repeat(64),verifiedEvidenceRef:'ENGINEERING controlled protocol reference'}});
    },{url,model:DEFAULT_INTENT_MODEL});expect(enabled.ok).toBe(true);
    await page.getByRole('button',{name:'Models',exact:true}).click();await page.getByRole('button',{name:'Reload published directory',exact:true}).click();
    await expect(page.getByLabel('Enable intent routing',{exact:true})).toBeChecked();await page.getByRole('button',{name:'Chat',exact:true}).click();
    await expect(routing).toHaveValue('main_agent');await page.getByRole('button',{name:'New Session',exact:true}).click();await expect(routing).toHaveValue('intent');
    await page.getByRole('button',{name:'Data Workspace',exact:true}).click();await page.getByRole('button',{name:'Choose snapshot directory',exact:true}).click();
    await expect(page.getByRole('button',{name:'Confirm import',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Confirm import',exact:true}).click();
    await page.getByLabel('Select batch 1',{exact:true}).check();await page.getByRole('button',{name:'Apply 1 selected batches',exact:true}).click();
    await page.getByRole('button',{name:'Chat',exact:true}).click();
    const message=page.getByLabel('Message text',{exact:true}),send=page.getByRole('button',{name:'Send',exact:true});
    const recent=()=>page.evaluate(async()=>{const result=await window.medclaw.request('run.read',{recent:true});return result.ok&&result.data.kind==='recent'?result.data.runs[0]:null;});
    await message.fill('查询2026-01-01在浙江的全部医疗器械。');await expect(send).toBeEnabled();await send.click();
    await expect.poll(async()=>(await recent())?.status,{timeout:30000}).toBe('completed');
    const first=(await recent())!;const rule=await page.evaluate(runId=>window.medclaw.request('intent.read',{runId}),first.id);
    expect(rule).toMatchObject({ok:true,data:{calls:[],decision:{route:'simple'},execution:{runStatus:'completed'}}});expect(intentRequests).toHaveLength(0);expect(mainRequests).toHaveLength(0);
    await expect(page.getByTestId('chat-native-messages')).toContainText('Part 0: Query #1');
    await expect(page.getByTestId('chat-native-messages')).toContainText('Complete result rows: 1.');
    const conditions=page.getByRole('region',{name:'Current query conditions',exact:true});
    await expect(conditions).toContainText('浙江');await expect(conditions).toContainText(`Run ${first.id}`);
    await expect(conditions).toContainText('2026-01-01 ≤ date < 2026-01-02');
    await page.getByRole('button',{name:'View run details',exact:true}).click();await page.getByRole('tab',{name:'Conditions',exact:true}).click();
    const intentPanel=page.getByRole('region',{name:'Intent recognition',exact:true});
    for(const heading of ['Rule','Classification','Review','Adopted','Execution'])await expect(intentPanel.getByRole('heading',{name:heading,exact:true})).toBeVisible();
    await expect(intentPanel).toContainText('Intent calls: 0');await expect(intentPanel).toContainText('deterministic_rule');
    await expect(intentPanel).toContainText('Final history saved: Yes');await expect(intentPanel).toContainText('Query #1');
    expect(intentRequests).toHaveLength(0);expect(mainRequests).toHaveLength(0);
    await page.getByRole('button',{name:'Close run details',exact:true}).click();
    await message.fill('列出浙江2026-01-01的器械清单');await expect(send).toBeEnabled();await send.click();
    await expect.poll(async()=>{const run=await recent();return run&&run.id!==first.id&&run.status==='completed';},{timeout:30000}).toBe(true);
    expect(intentRequests).toHaveLength(1);expect(mainRequests).toHaveLength(0);
    await page.getByRole('button',{name:'View run details',exact:true}).click();await page.getByRole('tab',{name:'Conditions',exact:true}).click();
    await expect(intentPanel).toContainText('Intent calls: 1');await expect(intentPanel).toContainText('qwen_prompt');
    await expect(intentPanel).toContainText('Program validation: valid');await expect(intentPanel).toContainText('PRODUCT_SEARCH');
    await page.getByRole('button',{name:'Close run details',exact:true}).click();
    const classified=(await recent())!;review=true;await message.fill('请列出浙江2026-01-01的器械清单');await send.click();
    await expect.poll(async()=>{const run=await recent();return run&&run.id!==classified.id&&run.status==='completed';},{timeout:30000}).toBe(true);
    expect(intentRequests).toHaveLength(3);expect(mainRequests).toHaveLength(0);
    await page.getByRole('button',{name:'View run details',exact:true}).click();await page.getByRole('tab',{name:'Conditions',exact:true}).click();
    await expect(intentPanel).toContainText('Intent calls: 2');await expect(intentPanel).toContainText('paper_enhanced');
    const classification=intentPanel.getByRole('heading',{name:'Classification',exact:true}).locator('..');
    await expect(classification).toContainText('DATA_OPERATIONS');await expect(classification).toContainText('Program validation: invalid');
    const verification=intentPanel.getByRole('heading',{name:'Review',exact:true}).locator('..');
    await expect(verification).toContainText('BASIC_INFO');await expect(verification).toContainText('Program validation: valid');
    await page.setViewportSize({width:760,height:920});
    await expect(intentPanel).toBeVisible();expect(await intentPanel.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    const artifacts=join(process.cwd(),'.build','p14-desktop-artifacts');mkdirSync(artifacts,{recursive:true});await page.screenshot({path:join(artifacts,'intent-recognition-narrow.png'),fullPage:true});
    await page.getByRole('button',{name:'Close run details',exact:true}).click();await page.setViewportSize({width:1440,height:1000});review=false;
    await routing.selectOption('main_agent');await message.fill('ENGINEERING explicit main message');await send.click();
    await expect.poll(()=>mainRequests.length,{timeout:30000}).toBe(1);expect(intentRequests).toHaveLength(3);
    await expect(page.getByTestId('chat-native-messages')).toContainText('ENGINEERING explicit main answer');
    const previous=(await recent())!;failIntent=true;await routing.selectOption('intent');const failedText='列出浙江2026-01-01的器械清单';
    await message.fill(failedText);await send.click();
    await expect.poll(async()=>{const run=await recent();return run&&run.id!==previous.id&&run.status==='failed';},{timeout:30000}).toBe(true);
    await expect(message).toHaveValue(failedText);expect(intentRequests).toHaveLength(4);expect(mainRequests).toHaveLength(1);
    await page.getByRole('button',{name:'View run details',exact:true}).click();await page.getByRole('tab',{name:'Conditions',exact:true}).click();
    await expect(intentPanel).toContainText('failed');await expect(intentPanel).toContainText('No adopted decision');
    await expect(intentPanel).toContainText('Final history saved: No');expect(mainRequests).toHaveLength(1);
    const failed=(await recent())!;
    await expect(intentPanel.getByRole('button',{name:'Retry recognition',exact:true})).toBeVisible();
    await message.fill('Keep this newer draft.');
    await intentPanel.getByRole('button',{name:'Retry recognition',exact:true}).click();
    await expect(page.getByRole('alert').filter({hasText:'Keep or clear the current draft'})).toBeVisible();
    await expect(message).toHaveValue('Keep this newer draft.');expect((await recent())!.id).toBe(failed.id);expect(intentRequests).toHaveLength(4);
    await message.fill('');await intentPanel.getByRole('button',{name:'Retry recognition',exact:true}).click();
    await expect.poll(async()=>{const run=await recent();return run&&run.id!==failed.id&&run.status==='failed';},{timeout:30000}).toBe(true);
    const retried=(await recent())!;expect(intentRequests).toHaveLength(5);expect(mainRequests).toHaveLength(1);await expect(message).toHaveValue(failedText);
    await expect(intentPanel.getByRole('button',{name:'Review query conditions',exact:true})).toBeEnabled();
    await intentPanel.getByRole('button',{name:'Review query conditions',exact:true}).click();
    await expect(page.getByRole('alert').filter({hasText:'Review and confirm query conditions'})).toBeVisible();
    expect((await recent())!.id).toBe(retried.id);expect(intentRequests).toHaveLength(5);expect(mainRequests).toHaveLength(1);
    await page.getByRole('button',{name:'Close run details',exact:true}).click();failIntent=false;
    for(const scenario of [
      {mode:'missing' as const,calls:1,text:'列出浙江新增的器械记录',status:'NEED_PARAMETERS',explanation:'Provide the missing parameters to resolve this task.'},
      {mode:'ood' as const,calls:1,text:'写一首诗',status:'OUT_OF_SCOPE',explanation:'This request is outside the registered medical-device tasks.'},
      {mode:'unsupported' as const,calls:1,text:'分析为什么价格发生变化',status:'UNSUPPORTED_DATA',explanation:'The current data or tools do not support this task.'},
      {mode:'ambiguous' as const,calls:2,text:'请查询医疗器械相关信息',status:'AMBIGUOUS',explanation:'Clarify the intended task using the recorded question and options.'},
    ]){
      outcome=scenario.mode;await page.getByRole('button',{name:'New Session',exact:true}).click();await expect(routing).toHaveValue('intent');
      const prior=(await recent())!.id,count=intentRequests.length;await message.fill(scenario.text);await send.click();
      await expect.poll(async()=>{const run=await recent();return run&&run.id!==prior&&run.status==='completed';},{timeout:30000}).toBe(true);
      expect(intentRequests).toHaveLength(count+scenario.calls);expect(mainRequests).toHaveLength(1);
      const currentConditions=page.getByRole('region',{name:'Current query conditions',exact:true});
      if(scenario.mode==='missing'){
        await expect(currentConditions).toHaveCount(1);
        await expect(currentConditions).toContainText(`Pending task: ${scenario.text}`);
        await expect(currentConditions).toContainText('Missing: s1.time');
        await expect(currentConditions.getByRole('button',{name:/Query #/})).toHaveCount(0);
      }else await expect(currentConditions).toHaveCount(0);
      await page.getByRole('button',{name:'View run details',exact:true}).click();await page.getByRole('tab',{name:'Conditions',exact:true}).click();
      await expect(intentPanel).toContainText(scenario.status);await expect(intentPanel).toContainText(scenario.explanation);
      await expect(intentPanel).toContainText(`Intent calls: ${scenario.calls}`);await expect(intentPanel).toContainText('Saved queries: None');
      if(scenario.mode==='missing'){await expect(intentPanel).toContainText('Select the date.');await expect(intentPanel).toContainText('s1.time');}
      if(scenario.mode==='ambiguous'){
        const verified=intentPanel.getByRole('heading',{name:'Review',exact:true}).locator('..');
        await verified.getByText('Candidate 1 · suspected_ood',{exact:true}).click();await expect(verified).toContainText('PRODUCT_SEARCH');
        await expect(verified).toContainText('Confirm the requested task.');await expect(verified).toContainText('Search products; Clarify the task');
      }
      await page.getByRole('button',{name:'Close run details',exact:true}).click();
    }
    outcome='resolved';await page.getByRole('button',{name:'New Session',exact:true}).click();
    const longTask='ENGINEERING original task. '.repeat(3000),prior=(await recent())!.id,beforeIntent=intentRequests.length;
    await message.fill(longTask);await send.click();
    await expect.poll(async()=>{const run=await recent();return run&&run.id!==prior&&run.status==='failed';},{timeout:30000}).toBe(true);
    const longSource=(await recent())!;expect(intentRequests).toHaveLength(beforeIntent);
    const preview=await page.evaluate(inputId=>window.medclaw.request('session.readInput',{inputId}),longSource.inputId!);
    expect(preview).toMatchObject({ok:true,data:{textInfo:{truncated:true,totalChars:longTask.length}}});
    await page.getByRole('button',{name:'View run details',exact:true}).click();await page.getByRole('tab',{name:'Conditions',exact:true}).click();
    await expect(intentPanel.getByRole('button',{name:'Retry recognition',exact:true})).toBeEnabled();
    writeFileSync(replayControl,JSON.stringify({sourceId:longSource.id,hold:true,loseSubmitText:null}));
    await intentPanel.getByRole('button',{name:'Retry recognition',exact:true}).click();
    await expect.poll(()=>JSON.parse(readFileSync(replayPages,'utf8')).length).toBeGreaterThanOrEqual(1);
    await message.fill('A draft edited while the original task is being read.');
    writeFileSync(replayControl,JSON.stringify({sourceId:longSource.id,hold:false,loseSubmitText:null}));
    await expect(intentPanel.getByRole('button',{name:'Retry recognition',exact:true})).toBeEnabled();await expect(send).toBeDisabled();
    await expect(page.getByRole('button',{name:'Read original submission',exact:true})).toBeVisible();expect((await recent())!.id).toBe(longSource.id);
    await expect(message).toHaveValue('A draft edited while the original task is being read.');
    await message.fill('');
    await intentPanel.getByRole('button',{name:'Retry recognition',exact:true}).click();
    await expect.poll(async()=>{const run=await recent();return run&&run.id!==longSource.id&&run.status==='failed';},{timeout:30000}).toBe(true);
    const longRetry=(await recent())!;
    const observedPages:number[]=JSON.parse(readFileSync(replayPages,'utf8'));
    expect(observedPages).toContain(0);expect(observedPages.filter(offset=>offset===65536)).toEqual([65536]);
    expect(observedPages.every(offset=>offset===0||offset===65536)).toBe(true);
    const tail=await page.evaluate(runId=>window.medclaw.request('run.read',{runId,inputOffset:65536,inputLimit:65536}),longRetry.id);
    expect(tail).toMatchObject({ok:true,data:{kind:'one',run:{inputPage:{text:longTask.slice(65536),totalChars:longTask.length,nextOffset:null}}}});
    expect(intentRequests).toHaveLength(beforeIntent);expect(mainRequests).toHaveLength(1);
    await page.getByRole('button',{name:'Close run details',exact:true}).click();
    await page.getByRole('button',{name:'New Session',exact:true}).click();failIntent=true;
    const unknownText='ENGINEERING lost acceptance reply',unknownPrior=(await recent())!.id;
    writeFileSync(replayControl,JSON.stringify({sourceId:longSource.id,hold:false,loseSubmitText:unknownText}));
    await message.fill(unknownText);await send.click();
    await expect.poll(async()=>{const run=await recent();return run&&run.id!==unknownPrior&&run.status==='failed';},{timeout:30000}).toBe(true);
    const unknownRun=(await recent())!.id;
    await page.getByRole('button',{name:'View run details',exact:true}).click();await page.getByRole('tab',{name:'Conditions',exact:true}).click();
    await expect(intentPanel.getByRole('button',{name:'Retry recognition',exact:true})).toBeDisabled();
    await expect(intentPanel.getByRole('button',{name:'Review query conditions',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Read original submission',exact:true}).click();
    await expect(intentPanel.getByRole('button',{name:'Retry recognition',exact:true})).toBeEnabled();
    expect((await recent())!.id).toBe(unknownRun);expect(intentRequests).toHaveLength(beforeIntent+1);expect(mainRequests).toHaveLength(1);
    await page.getByRole('button',{name:'Close run details',exact:true}).click();failIntent=false;outcome='resolved';
    await page.getByRole('button',{name:'New Session',exact:true}).click();
    await expect(page.getByRole('button',{name:'New Session',exact:true})).toBeEnabled();
    await message.fill('查询2026-01-01在浙江的全部医疗器械。');await send.click();
    await expect.poll(async()=>{const run=await recent();return run&&run.id!==unknownRun&&run.status==='completed';},{timeout:30000}).toBe(true);
    const originalConditionRun=(await recent())!,a=originalConditionRun.sessionId!;
    const originalCondition=await page.evaluate(sessionId=>window.medclaw.request('session.read',{sessionId}),a);
    if(!originalCondition.ok||!originalCondition.data?.currentQueryContext)throw new Error('Missing actual original query condition');
    await page.getByRole('button',{name:'New Session',exact:true}).click();
    await expect(page.getByRole('button',{name:'New Session',exact:true})).toBeEnabled();
    const otherWorkspace=await page.evaluate(()=>window.medclaw.request('workspace.read',{}));
    if(!otherWorkspace.ok||!otherWorkspace.data.sessionId)throw new Error('Missing other Session');const b=otherWorkspace.data.sessionId;
    const selectSession=async(sessionId:number)=>{
      const selected=page.locator(`.session-row[data-session-id="${sessionId}"] button[aria-pressed]`);await selected.click();
      await expect.poll(async()=>{const result=await page.evaluate(()=>window.medclaw.request('workspace.read',{}));return result.ok?result.data.sessionId:null;}).toBe(sessionId);
      await expect(selected).toHaveAttribute('aria-pressed','true');await expect(routing).toBeEnabled();
    };
    for(const stage of ['classify','verify'] as const){
      await selectSession(a);review=stage==='verify';holdIntentStage=stage;const before=intentRequests.length;
      await message.fill('列出浙江2026-01-01的器械清单');await expect(send).toBeEnabled();await send.click();
      await expect.poll(()=>blockedIntents.filter(item=>item.stage===stage).length,{timeout:30000}).toBe(1);
      const blocked=blockedIntents.find(item=>item.stage===stage)!;
      await expect(send).toBeDisabled();await expect(page.getByRole('button',{name:'Stop generating',exact:true})).toBeEnabled();
      const actions=page.getByRole('button',{name:'Message actions',exact:true});
      if(await actions.count()){
        await actions.click();await expect(page.getByRole('menuitem',{name:'Steer',exact:true})).toBeDisabled();
        await expect(page.getByRole('menuitem',{name:'Follow Up',exact:true})).toBeDisabled();await page.keyboard.press('Escape');
      }
      const inputsBefore=await page.evaluate(sessionId=>window.medclaw.request('session.listInputs',{sessionId,limit:100}),a);
      for(const mode of ['steer','follow_up'] as const){
        const rejected=await page.evaluate(async({sessionId,runId,mode})=>{
          const workspace=await window.medclaw.request('workspace.read',{}),session=await window.medclaw.request('session.read',{sessionId}),saved=await window.medclaw.request('run.read',{runId});
          if(!workspace.ok||!session.ok||!session.data||!saved.ok||saved.data.kind!=='one'||!saved.data.run)throw new Error('Missing original Run');
          const run=saved.data.run;
          return window.medclaw.request('session.submit',{sessionId,clientSequence:session.data.session.nextSubmissionSequence,mode,targetRunId:runId,text:'ENGINEERING forbidden queue during intent',
            expectedRevision:workspace.data.revision,expectedBatchIds:workspace.data.batchRefs.map(batch=>batch.id),expectedQueryId:workspace.data.queryId,
            model:{provider:run.model.provider,modelId:run.model.modelId,expectedConfigVersion:run.model.configVersion},referenceDate:run.referenceDate,timezone:run.timezone},crypto.randomUUID());
        },{sessionId:a,runId:blocked.runId,mode});
        expect(rejected).toMatchObject({ok:false,error:{code:'state_conflict'}});
      }
      expect(await page.evaluate(sessionId=>window.medclaw.request('session.listInputs',{sessionId,limit:100}),a)).toEqual(inputsBefore);
      await message.fill(`A ${stage} draft remains.`);await selectSession(b);await message.fill(`B ${stage} draft remains.`);
      await expect(send).toBeDisabled();await expect(page.getByRole('button',{name:'Message actions',exact:true})).toHaveCount(0);
      await expect(page.getByRole('region',{name:'Current query conditions',exact:true})).toHaveCount(0);
      await expect(page.getByTestId('stop-target')).toContainText(`Run ${blocked.runId}`);
      await page.getByRole('button',{name:'Stop generating',exact:true}).click();holdIntentStage=null;blocked.release();
      await expect.poll(async()=>{const gate=await page.evaluate(()=>window.medclaw.request('run.control.read',{}));return gate.ok&&gate.data.acceptingNewRuns&&gate.data.activeRootRun===null;},{timeout:30000}).toBe(true);
      const stopped=await page.evaluate(runId=>window.medclaw.request('intent.read',{runId}),blocked.runId);
      expect(stopped).toMatchObject({ok:true,data:{decision:null,execution:{runStatus:'cancelled',queryIds:[],answerId:null,requiredPersistenceComplete:true}}});
      if(!stopped.ok||!stopped.data)throw new Error('Missing stopped intent facts');
      expect(stopped.data.calls.map(call=>[call.stage,call.state])).toEqual(stage==='classify'?[['classify','cancelled']]:[['classify','completed'],['verify','cancelled']]);
      expect(intentRequests).toHaveLength(before+(stage==='classify'?1:2));expect(mainRequests).toHaveLength(1);
      await expect(message).toHaveValue(`B ${stage} draft remains.`);
      const afterCondition=await page.evaluate(sessionId=>window.medclaw.request('session.read',{sessionId}),a);
      expect(afterCondition).toMatchObject({ok:true,data:{currentQueryContext:originalCondition.data.currentQueryContext}});
      await selectSession(a);await expect(message).toHaveValue(`A ${stage} draft remains.`);
      await expect(page.getByRole('region',{name:'Current query conditions',exact:true})).toContainText(`Run ${originalConditionRun.id}`);
    }
    review=false;outcome='multi';const beforeMulti=intentRequests.length,priorMulti=(await recent())!.id;
    await message.fill('先查询浙江在售器械，再查询退市器械，分别保留结果。');await expect(send).toBeEnabled();await send.click();
    await expect.poll(async()=>{const run=await recent();return run&&run.id!==priorMulti&&run.status==='completed';},{timeout:30000}).toBe(true);
    const multi=(await recent())!,finalMulti=await page.evaluate(runId=>window.medclaw.request('intent.read',{runId}),multi.id);
    expect(finalMulti).toMatchObject({ok:true,data:{decision:{route:'simple',queryParams:null,contextIntentId:null,executionPlan:{contract:'medclaw.intent-query-plan/v1',steps:[{stepId:'s1',dependsOn:[]},{stepId:'s2',dependsOn:['s1']}]}},
      execution:{stepResults:[{stepId:'s1',queryRefs:[{queryId:expect.any(Number)}]},{stepId:'s2',queryRefs:[{queryId:expect.any(Number)}]}],finalHistorySaved:true,requiredPersistenceComplete:true}}});
    if(!finalMulti.ok||!finalMulti.data)throw new Error('Missing program plan facts');
    expect(finalMulti.data.execution.queryIds).toHaveLength(2);
    for(const [index,queryId] of finalMulti.data.execution.queryIds.entries()){
      expect(await page.evaluate(queryId=>window.medclaw.request('query.read',{queryId}),queryId))
        .toMatchObject({ok:true,data:{query:{runId:multi.id,sessionId:a,params:{status:index?'delisted':'active'}}}});
    }
    expect(intentRequests).toHaveLength(beforeMulti+1);expect(mainRequests).toHaveLength(1);
    await expect(page.getByTestId('chat-native-messages')).toContainText('Step s2');
    expect(await page.evaluate(sessionId=>window.medclaw.request('session.read',{sessionId}),a))
      .toMatchObject({ok:true,data:{currentQueryContext:originalCondition.data.currentQueryContext}});
  }finally{
    for(const blocked of blockedIntents)blocked.release();
    writeFileSync(replayControl,JSON.stringify({sourceId:null,hold:false,loseSubmitText:null}));
    await desktop?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
    const inside=relative(tmpdir(),root);if((!desktop||existsSync(join(root,'dev-exit-confirmed')))&&inside&&!inside.startsWith('..')&&!inside.includes(':'))rmSync(root,{recursive:true,force:true});
  }
});
