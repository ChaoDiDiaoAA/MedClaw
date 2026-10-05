import {expect,test as base,_electron as electron,type ElectronApplication,type Page} from '@playwright/test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';

// Controlled IPC tests prove renderer ownership; p9-memory.spec.ts proves the real Main/Host/SQLite path.
let server:ReturnType<typeof createServer>,url:string,app:ElectronApplication;
const test=base.extend<{page:Page}>({page:async({},use)=>use(await app.firstWindow())});
test.beforeAll(async()=>{
  const directory=resolve('.build/p9-memory/renderer');mkdirSync(directory,{recursive:true});const require=createRequire(resolve('apps/desktop/package.json')),entry=join(directory,'fixture.ts'),bundle=join(directory,'fixture.js');
  writeFileSync(entry,`import React from ${JSON.stringify(require.resolve('react'))};import{createRoot}from ${JSON.stringify(require.resolve('react-dom/client'))};import{SessionCheckpoints}from ${JSON.stringify(resolve('apps/desktop/src/renderer/chat.tsx'))};
    const root=createRoot(document.getElementById('root'));globalThis.__pending=[];globalThis.__verified=[];
    window.medclaw={request:(method,input,operationRef)=>new Promise((resolve,reject)=>globalThis.__pending.push({method,input,operationRef,resolve,reject}))};
    globalThis.__render=(sessionId=1,instanceId='HostA',version=1,availability='ready',revision=7)=>root.render(React.createElement(SessionCheckpoints,{host:{state:'ready',instanceId},session:{session:{id:sessionId,nativeSessionId:'native-'+sessionId,leafId:'current-'+sessionId,storageVersion:version},runtime:{availability}},workspace:{revision},visible:true,blocked:false,
      onResumeCheckpoint:(input,operationRef)=>window.medclaw.request('session.restoreCheckpoint',input,operationRef),onRestoreSession:input=>window.medclaw.request('session.restore',input),onHistoryVerified:async(sessionId,operationRef)=>{globalThis.__verified.push({sessionId,operationRef});}}));globalThis.__render();`);
  execFileSync('bun',['build',entry,'--target=browser',`--outfile=${bundle}`],{cwd:resolve('.'),stdio:'pipe'});
  server=createServer((request,response)=>{response.setHeader('content-type',request.url==='/fixture.js'?'text/javascript':request.url==='/styles.css'?'text/css':'text/html');response.end(request.url==='/fixture.js'?readFileSync(bundle):request.url==='/styles.css'?readFileSync(resolve('apps/desktop/src/renderer/styles.css')):'<link rel="stylesheet" href="/styles.css"><main id="root"></main><script type="module" src="/fixture.js"></script>');});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const main=join(directory,'browser.cjs');writeFileSync(main,`const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});win.loadURL(${JSON.stringify(url)});});`);
  const env=Object.fromEntries(Object.entries(process.env).filter((value):value is [string,string]=>value[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({executablePath:require('electron'),args:[main],env});
});
test.afterAll(async()=>{await app?.close();if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}});
const point=(id=1)=>({answerId:id,runId:id,nativeLeafId:'saved-'+id,committedAt:'2026-10-05T00:00:00.000Z',questionSummary:'ENGINEERING question '+id,answerSummary:'ENGINEERING answer '+id,conditionSummary:null,isCurrentBranch:true});
const savedPage=(sessionId=1,storageVersion=1)=>({sessionId,storageVersion,items:[point()],nextAnswerId:null,hasMore:false});
async function requests(page:Page,method:string){return page.evaluate(method=>Reflect.get(globalThis,'__pending').filter((value:{method:string})=>value.method===method).map(({input,operationRef}:{input:unknown;operationRef:string})=>({input,operationRef})),method);}
async function reply(page:Page,method:string,value:unknown,index=0){await expect.poll(async()=>(await requests(page,method)).length).toBeGreaterThan(index);await page.evaluate(({method,value,index})=>Reflect.get(globalThis,'__pending').filter((item:{method:string})=>item.method===method)[index].resolve(value),{method,value,index});}
async function start(page:Page){await page.goto(url);await reply(page,'session.checkpoints.read',{ok:true,data:savedPage()});await expect(page.getByRole('button',{name:'Resume from here · Run 1',exact:true})).toBeEnabled();}
async function resume(page:Page){await page.getByRole('button',{name:'Resume from here · Run 1',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Resume from here',exact:true}).click();await expect.poll(async()=>(await requests(page,'session.restoreCheckpoint')).length).toBe(1);}
async function unknown(page:Page){await resume(page);await reply(page,'session.restoreCheckpoint',{ok:false,error:{code:'operation_result_unknown',category:'runtime',message:'Unconfirmed',retryable:false}});await expect(page.getByTestId('session-checkpoints')).toContainText('Restore result unconfirmed.');}
const receipt=(operationRef:string)=>({operationRef,sessionId:1,targetLeafId:'saved-1',storageVersion:2,workspaceRevision:8,committedAt:'2026-10-05T00:00:00.000Z'});

test('p9 saved-turn pages discard prior Session, prior leaf version and older reads',async({page})=>{
  await page.goto(url);await page.evaluate(()=>Reflect.get(globalThis,'__render')(2));await reply(page,'session.checkpoints.read',{ok:true,data:{...savedPage(2),items:[point(2)]}},1);await reply(page,'session.checkpoints.read',{ok:true,data:savedPage(1)});
  await expect(page.getByTestId('session-checkpoints')).toContainText('ENGINEERING question 2');await expect(page.getByRole('button',{name:'Resume from here · Run 1'})).toHaveCount(0);
  await page.evaluate(()=>Reflect.get(globalThis,'__render')(2,'HostA',3));await reply(page,'session.checkpoints.read',{ok:true,data:{...savedPage(2,3),items:[point(3)]}},2);
  await expect(page.getByRole('button',{name:'Resume from here · Run 3'})).toBeVisible();await expect(page.getByRole('button',{name:'Resume from here · Run 1'})).toHaveCount(0);
});

test('p9 keyboard confirmation keeps focus and freezes both original versions; failed reads are not empty history',async({page})=>{
  await start(page);const button=page.getByRole('button',{name:'Resume from here · Run 1',exact:true});await button.focus();await page.keyboard.press('Enter');await expect(page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(button).toBeFocused();
  await resume(page);expect((await requests(page,'session.restoreCheckpoint'))[0]!.input).toEqual({sessionId:1,targetLeafId:'saved-1',expectedStorageVersion:1,expectedWorkspaceRevision:7});
  await reply(page,'session.restoreCheckpoint',{ok:false,error:{code:'storage_write_failed',category:'storage',message:'Save failed',retryable:false}});await expect(page.getByTestId('session-checkpoints')).toContainText('Run facts have not been confirmed saved.');
  await page.getByRole('button',{name:'Refresh saved turns'}).click();await reply(page,'session.checkpoints.read',{ok:false,error:{code:'storage_read_failed',category:'storage',message:'Read failed',retryable:false}},1);await expect(page.getByTestId('session-checkpoints')).toContainText('Saved turns could not be read.');await expect(button).toBeVisible();await expect(page.getByText('No completed saved turns.')).toHaveCount(0);
});

test('p9 unknown restore retains identity across failed lookup, confirmed null and wrong-owner reply',async({page})=>{
  await start(page);await unknown(page);const operation=(await requests(page,'session.restoreCheckpoint'))[0]!.operationRef;const lookup=page.getByRole('button',{name:'Read original restore'}),resumeButton=page.getByRole('button',{name:'Resume from here · Run 1',exact:true});
  await lookup.click();await reply(page,'evidence.readOperation',{ok:false,error:{code:'storage_read_failed',category:'storage',message:'Read failed',retryable:false}});await expect(page.getByTestId('session-checkpoints')).toContainText('Original restore could not be read.');await expect(resumeButton).toBeDisabled();
  await lookup.click();await reply(page,'evidence.readOperation',{ok:true,data:null},1);await expect(page.getByTestId('session-checkpoints')).toContainText('not recorded. Keep its identity');await expect(resumeButton).toBeDisabled();
  await lookup.click();await reply(page,'evidence.readOperation',{ok:true,data:{...receipt(operation),sessionId:2}},2);await expect(page.getByTestId('session-checkpoints')).toContainText('did not match its owner');await expect(resumeButton).toBeDisabled();
  await lookup.click();await reply(page,'evidence.readOperation',{ok:true,data:receipt(operation)},3);await expect(page.getByTestId('session-checkpoints')).toContainText('Original restore saved');await expect(resumeButton).toBeEnabled();
  expect(await requests(page,'session.restoreCheckpoint')).toHaveLength(1);expect(await page.evaluate(()=>Reflect.get(globalThis,'__verified'))).toEqual([{sessionId:1,operationRef:operation}]);
});

test('p9 late restore result and late original-read rejection cannot overwrite another Session or Host',async({page})=>{
  await start(page);await resume(page);await page.evaluate(()=>Reflect.get(globalThis,'__render')(2,'HostB',4));await reply(page,'session.checkpoints.read',{ok:true,data:{...savedPage(2,4),items:[point(4)]}},1);await reply(page,'session.restoreCheckpoint',{ok:false,error:{code:'operation_result_unknown',category:'runtime',message:'Unconfirmed',retryable:false}});
  await expect(page.getByTestId('session-checkpoints')).not.toContainText('Restore result unconfirmed');await expect(page.getByRole('button',{name:'Resume from here · Run 4'})).toBeEnabled();
  await page.evaluate(()=>Reflect.get(globalThis,'__render')(1,'HostB',4));await reply(page,'session.checkpoints.read',{ok:true,data:savedPage(1,4)},2);await page.getByRole('button',{name:'Read original restore'}).click();
  await page.evaluate(()=>Reflect.get(globalThis,'__render')(2,'HostB',4));await reply(page,'session.checkpoints.read',{ok:true,data:{...savedPage(2,4),items:[point(4)]}},3);await page.evaluate(()=>Reflect.get(globalThis,'__pending').find((item:{method:string})=>item.method==='evidence.readOperation').reject(new Error('ENGINEERING old read failure')));
  await expect(page.getByTestId('session-checkpoints')).not.toContainText('Original restore could not be read');await expect(page.getByRole('button',{name:'Resume from here · Run 4'})).toBeEnabled();
});

test('p9 new Host confirmed absence allows fresh review, and original Receipt never replaces the newer versions',async({page})=>{
  await start(page);await unknown(page);await page.evaluate(()=>Reflect.get(globalThis,'__render')(1,'HostB',20,'ready',30));await reply(page,'session.checkpoints.read',{ok:true,data:savedPage(1,20)},1);
  await page.getByRole('button',{name:'Read original restore'}).click();await reply(page,'evidence.readOperation',{ok:true,data:null});await expect(page.getByTestId('session-checkpoints')).toContainText('Review saved turns before a new action.');await expect(page.getByRole('button',{name:'Resume from here · Run 1',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Resume from here · Run 1',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Resume from here',exact:true}).click();await expect.poll(async()=>(await requests(page,'session.restoreCheckpoint')).length).toBe(2);
  expect((await requests(page,'session.restoreCheckpoint'))[1]!.input).toMatchObject({expectedStorageVersion:20,expectedWorkspaceRevision:30});expect((await requests(page,'session.restoreCheckpoint'))[1]!.operationRef).not.toBe((await requests(page,'session.restoreCheckpoint'))[0]!.operationRef);
});
