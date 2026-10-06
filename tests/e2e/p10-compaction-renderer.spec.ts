import {expect,test as base,_electron as electron,type ElectronApplication,type Page} from '@playwright/test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';

// Controlled notice ordering complements the real Main/Host/SQLite/SDK desktop test.
let server:ReturnType<typeof createServer>,url:string,app:ElectronApplication;
const test=base.extend<{page:Page}>({page:async({},use)=>use(await app.firstWindow())});
test.beforeAll(async()=>{
  const directory=resolve('.build/p10-renderer');mkdirSync(directory,{recursive:true});const require=createRequire(resolve('apps/desktop/package.json')),entry=join(directory,'fixture.ts'),bundle=join(directory,'fixture.js');
  writeFileSync(entry,`import React from ${JSON.stringify(require.resolve('react'))};import{createRoot}from ${JSON.stringify(require.resolve('react-dom/client'))};import{SessionCompaction}from ${JSON.stringify(resolve('apps/desktop/src/renderer/chat.tsx'))};
    const root=createRoot(document.getElementById('root'));globalThis.__pending=[];globalThis.__verified=[];globalThis.__listeners=[];
    window.medclaw={subscribe:listener=>{globalThis.__listeners.push(listener);return()=>{};},request:(method,input,operationRef)=>new Promise((resolve,reject)=>globalThis.__pending.push({method,input,operationRef,resolve,reject,done:false}))};
    globalThis.__render=(sessionId=1,instanceId='HostA',blocked=null,accepting=true)=>root.render(React.createElement(SessionCompaction,{host:{state:'ready',instanceId},session:{session:{id:sessionId,leafId:'saved-'+sessionId,storageVersion:7},runtime:{availability:'ready'}},model:{provider:'ENGINEERING',modelId:'fixture',expectedConfigVersion:'1'},visible:true,blockedReason:blocked,control:{acceptingNewRuns:accepting},
      onRestoreSession:input=>window.medclaw.request('session.restore',input),onHistoryVerified:async(sessionId,operationRef)=>{globalThis.__verified.push({sessionId,operationRef});}}));globalThis.__render();`);
  execFileSync('bun',['build',entry,'--target=browser',`--outfile=${bundle}`],{cwd:resolve('.'),stdio:'pipe'});
  server=createServer((request,response)=>{response.setHeader('content-type',request.url==='/fixture.js'?'text/javascript':'text/html');response.end(request.url==='/fixture.js'?readFileSync(bundle):'<main id="root"></main><script type="module" src="/fixture.js"></script>');});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const main=join(directory,'browser.cjs');writeFileSync(main,`const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});win.loadURL(${JSON.stringify(url)});});`);
  const env=Object.fromEntries(Object.entries(process.env).filter((value):value is [string,string]=>value[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({executablePath:require('electron'),args:[main],env});
});
test.afterAll(async()=>{await app?.close();if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}});
const requests=(page:Page,method:string)=>page.evaluate(method=>Reflect.get(globalThis,'__pending').filter((item:{method:string})=>item.method===method).map(({input,operationRef,done}:{input:unknown;operationRef:string;done:boolean})=>({input,operationRef,done})),method);
async function reply(page:Page,method:string,value:unknown){await expect.poll(async()=>(await requests(page,method)).filter((item:{done:boolean})=>!item.done).length).toBeGreaterThan(0);await page.evaluate(({method,value})=>{const item=Reflect.get(globalThis,'__pending').find((item:{method:string;done:boolean})=>item.method===method&&!item.done);item.done=true;item.resolve(value);},{method,value});}
const view=(operationRef:string,status='running',receipt=false)=>({contract:'medclaw.compaction/v1',operationRef,sessionId:1,status,phase:receipt?'finished':'summarizing',revision:2,nativeGenerated:receipt?true:null,nativeSaved:receipt,canContinue:receipt,receipt:receipt?{tokensBefore:1000,estimatedTokensAfter:100,storageVersion:8}:null,error:null,calls:[]});
async function notice(page:Page,value:unknown){await page.evaluate(value=>{for(const listener of Reflect.get(globalThis,'__listeners'))listener(value);},value);}

test('p10 progress reads only the original operation, rejects stale owners and revisions, and cannot overwrite a terminal receipt',async({page})=>{
  await page.goto(url);await page.clock.install();await page.clock.pauseAt(new Date());await page.getByRole('button',{name:'Compact context',exact:true}).click();
  const command=(await requests(page,'session.compact'))[0]!;expect(command.input).toMatchObject({sessionId:1,expectedStorageVersion:7});
  await reply(page,'session.compact',{ok:true,data:view(command.operationRef)});await reply(page,'session.compaction.read',{ok:true,data:view(command.operationRef)});
  const progress={type:'compaction.progress',instanceId:'HostA',sessionId:1,operationRef:command.operationRef,runId:null,revision:2,phase:'saving'};
  const count=(await requests(page,'session.compaction.read')).length;await notice(page,progress);await expect.poll(async()=>(await requests(page,'session.compaction.read')).length).toBe(count+1);
  for(const invalid of [{...progress,revision:1},{...progress},{...progress,instanceId:'OldHost',revision:3},{...progress,sessionId:2,revision:4},{...progress,runId:22,revision:5}])await notice(page,invalid);
  expect(await requests(page,'session.compaction.read')).toHaveLength(count+1);
  await reply(page,'session.compaction.read',{ok:true,data:view(command.operationRef,'completed',true)});await expect(page.getByTestId('session-compaction')).toContainText('Compaction · completed');
  await notice(page,{...progress,revision:6,phase:'summarizing'});expect(await requests(page,'session.compaction.read')).toHaveLength(count+1);await expect(page.getByTestId('session-compaction')).toContainText('Can continueYes');
  await page.evaluate(()=>Reflect.get(globalThis,'__render')(2));await expect(page.getByTestId('session-compaction')).not.toContainText(command.operationRef);await notice(page,{...progress,revision:7});expect(await requests(page,'session.compact')).toHaveLength(1);
});

test('p10 lost acceptance keeps its identity until a new Host confirms absence, and late original reads do not replace another Session',async({page})=>{
  await page.goto(url);await page.clock.install();await page.clock.pauseAt(new Date());await page.getByRole('button',{name:'Compact context',exact:true}).click();const command=(await requests(page,'session.compact'))[0]!;
  await reply(page,'session.compact',{ok:false,error:{code:'operation_result_unknown'}});await expect(page.getByRole('button',{name:'Compact context',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Read original compaction',exact:true}).click();await page.evaluate(()=>Reflect.get(globalThis,'__render')(2));await reply(page,'session.compaction.read',{ok:true,data:view(command.operationRef,'completed',true)});await expect(page.getByTestId('session-compaction')).not.toContainText('completed');
  await page.evaluate(()=>Reflect.get(globalThis,'__render')(1,'HostB'));await reply(page,'session.compaction.read',{ok:true,data:null});await expect(page.getByRole('button',{name:'Compact context',exact:true})).toBeEnabled();
  expect(await requests(page,'session.compact')).toHaveLength(1);await expect(page.getByTestId('session-compaction')).toContainText('not recorded in this Host');
  await page.evaluate(()=>Reflect.get(globalThis,'__render')(1,'HostB','ENGINEERING blocked'));await expect(page.getByRole('button',{name:'Compact context',exact:true})).toBeDisabled();await expect(page.getByTestId('session-compaction')).toContainText('ENGINEERING blocked');
});

test('p10 a saved receipt with an acknowledgement gap still exposes original explicit restore',async({page})=>{
  await page.goto(url);await page.clock.install();await page.clock.pauseAt(new Date());await page.getByRole('button',{name:'Compact context',exact:true}).click();
  const command=(await requests(page,'session.compact'))[0]!,blocked={...view(command.operationRef,'completed',true),phase:'blocked',canContinue:false,error:{code:'storage_write_failed'}};
  await reply(page,'session.compact',{ok:true,data:blocked});await reply(page,'session.compaction.read',{ok:true,data:blocked});
  await page.evaluate(()=>Reflect.get(globalThis,'__render')(1,'HostA','ENGINEERING saved gap',false));
  await expect(page.getByRole('button',{name:'Restore compaction session',exact:true})).toBeVisible();await page.getByRole('button',{name:'Restore compaction session',exact:true}).click();
  await expect.poll(async()=>(await requests(page,'session.restore')).length).toBe(1);expect((await requests(page,'session.restore'))[0]!.input).toEqual({sessionId:1,expectedLeafId:'saved-1'});
  expect(await requests(page,'session.compact')).toHaveLength(1);
});
