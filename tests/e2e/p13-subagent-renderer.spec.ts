import {expect,test as base,_electron as electron,type ElectronApplication,type Page} from '@playwright/test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';

// Controlled display replies prove ownership; the other P13 spec uses the actual Host and plugin.
let server:ReturnType<typeof createServer>,url:string,app:ElectronApplication;
const test=base.extend<{page:Page}>({page:async({},use)=>use(await app.firstWindow())});
test.beforeAll(async()=>{
  const directory=resolve('.build/p13-renderer');mkdirSync(directory,{recursive:true});const require=createRequire(resolve('apps/desktop/package.json')),entry=join(directory,'fixture.ts'),bundle=join(directory,'fixture.js');
  writeFileSync(entry,`import React from ${JSON.stringify(require.resolve('react'))};import{createRoot}from ${JSON.stringify(require.resolve('react-dom/client'))};import{RunDetails}from ${JSON.stringify(resolve('apps/desktop/src/renderer/run-details.tsx'))};
    const root=createRoot(document.getElementById('root'));globalThis.__pending=[];
    window.medclaw={request:(method,input)=>new Promise((resolve,reject)=>globalThis.__pending.push({method,input,resolve,reject,done:false}))};
    globalThis.__render=(run,instanceId='HostA',viewSessionId=1)=>root.render(React.createElement(RunDetails,{run,host:{state:'ready',instanceId},viewSessionId,tab:'runtime',active:{runId:1},control:null,events:null,onResumeGap:()=>{},onTab:()=>{},onClose:()=>{},onError:()=>{},onRun:value=>globalThis.__render(value,instanceId,viewSessionId),onRetrySaved:()=>{}}));`);
  execFileSync('bun',['build',entry,'--target=browser',`--outfile=${bundle}`],{cwd:resolve('.'),stdio:'pipe'});
  server=createServer((request,response)=>{response.setHeader('content-type',request.url==='/fixture.js'?'text/javascript':'text/html');response.end(request.url==='/fixture.js'?readFileSync(bundle):'<main id="root"></main><script type="module" src="/fixture.js"></script>');});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const main=join(directory,'browser.cjs');writeFileSync(main,`const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1440,webPreferences:{backgroundThrottling:false}});win.loadURL(${JSON.stringify(url)});});`);
  const env=Object.fromEntries(Object.entries(process.env).filter((value):value is [string,string]=>value[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({executablePath:require('electron'),args:[main],env});
});
test.afterAll(async()=>{await app?.close();if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}});
const requests=(page:Page,method:string)=>page.evaluate(method=>Reflect.get(globalThis,'__pending').filter((item:{method:string})=>item.method===method).map(({input,done}:{input:unknown;done:boolean})=>({input,done})),method);
async function reply(page:Page,method:string,data:unknown,index=0){await expect.poll(async()=>(await requests(page,method)).length).toBeGreaterThan(index);await page.evaluate(({method,data,index})=>{const item=Reflect.get(globalThis,'__pending').filter((item:{method:string})=>item.method===method)[index];item.done=true;item.resolve({ok:true,data});},{method,data,index});}
function child(id=2,proof=false){return {id,kind:'child',sessionId:id+10,parentRunId:1,originToolCallId:5,pluginAgentId:'plugin-'+id,nativeSessionId:'native-'+id,originSnapshotId:8,parentInputId:6,status:'completed',inputText:'ENGINEERING delegated '+id,output:{offset:0,text:'ENGINEERING output '+id,totalChars:20,nextOffset:null},model:{provider:'fixture',modelId:'fixture',api:'openai-completions'},policy:{timeoutMs:60000,maxRetries:0,maxRetryDelayMs:0},referenceDate:'2026-10-07',timezone:'Asia/Shanghai',createdAt:'2026-10-07',operationRef:'child',instanceId:'HostA',persistence:'committed',calls:[],cleanup:{stopConfirmed:true,resourcesReleased:true},childResult:{text:'ENGINEERING child result '+id,storageVersion:3,finalLeafId:'leaf-'+id,queryRefs:[],evidenceIds:[],gaps:[],truncated:false},delivery:{sdkReturned:true,sdkResultIsError:!proof,nativeEntryId:proof?'receipt':null,nextModelCallId:proof?'parent-next':null,consumedAt:proof?'2026-10-07':null,consumptionEvidence:proof?'provider_input_verified':null,error:null}};}
function history(id:number,text:string){return {sessionId:id+10,nativeSessionId:'native-'+id,leafId:'leaf-'+id,source:'sqlite_history',items:[{nativeEntryId:'prompt-'+id,displayRole:'user',text,references:[],runId:id,textInfo:{truncated:false,redacted:false}}],hasMore:false,nextEntryId:null};}
test('p13 child facts distinguish stopped, committed, error receipt and verified consumption without user writes',async({page})=>{
  await page.goto(url);await page.evaluate(run=>Reflect.get(globalThis,'__render')(run),child());
  await expect(page.getByTestId('subagent-details')).toContainText('Child execution stopped');await expect(page.getByTestId('subagent-details')).toContainText('Version 3');
  await expect(page.getByTestId('subagent-details')).toContainText('Error receipt saved');await expect(page.getByTestId('subagent-details')).not.toContainText('Verified in');
  expect((await requests(page,'query.list'))[0]!.input).toEqual({childRunId:2});expect((await requests(page,'session.messages.read'))[0]!.input).toMatchObject({childRunId:2});
  await reply(page,'session.messages.read',history(2,'ENGINEERING original delegated history'));
  await expect(page.getByTestId('run-native-messages')).toContainText('Parent delegation');
  await page.evaluate(run=>Reflect.get(globalThis,'__render')(run),child(2,true));await expect(page.getByTestId('subagent-details')).toContainText('Verified in parent-next');
  await page.getByRole('button',{name:'Stop parent Run 1',exact:true}).click();expect((await requests(page,'run.cancel'))[0]!.input).toEqual({runId:1});
  for(const method of ['session.select','session.submit','session.compact','session.rename','session.delete'])expect(await requests(page,method)).toHaveLength(0);
});
test('p13 delayed child history and tool replies cannot replace a newer child or Host view',async({page})=>{
  await page.goto(url);await page.evaluate(run=>Reflect.get(globalThis,'__render')(run),child());await expect.poll(async()=>(await requests(page,'tool.read')).length).toBe(1);
  await page.evaluate(run=>Reflect.get(globalThis,'__render')(run,'HostB',9),child(3));
  await reply(page,'session.messages.read',history(2,'OLD CHILD BODY'));await reply(page,'session.messages.read',history(3,'CURRENT CHILD BODY'),1);
  await reply(page,'tool.read',{runId:2,scope:{batchIds:[91],allowedToolNames:[],artifactIds:[]},items:[],totalRows:0,page:1,pageSize:20});await reply(page,'query.list',{items:[]});
  await reply(page,'tool.read',{runId:3,scope:{batchIds:[],allowedToolNames:['read'],artifactIds:[]},items:[],totalRows:0,page:1,pageSize:20},1);await reply(page,'query.list',{items:[]},1);
  await expect(page.getByTestId('run-native-messages')).toContainText('CURRENT CHILD BODY');await expect(page.getByTestId('run-native-messages')).not.toContainText('OLD CHILD BODY');await expect(page.getByTestId('subagent-details')).toContainText('Subagent · Run 3');
  await expect(page.getByText('Tools',{exact:true})).toHaveCount(1);expect(await requests(page,'run.cancel')).toHaveLength(0);
});
