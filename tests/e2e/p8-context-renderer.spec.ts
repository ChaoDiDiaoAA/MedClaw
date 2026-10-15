import { expect, test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createStartupPackage, launchActualDev, readStartupFacts } from '../fixtures/desktop-dev';

// Focused real-browser renderer checks use controlled IPC replies. The dev test below
// independently proves the ordinary Electron/Host/SDK path and network count.
let rendererServer:ReturnType<typeof createServer>, rendererUrl:string, rendererApp:ElectronApplication;
const test=base.extend<{page:Page}>({page:async({},use)=>{await use(await rendererApp.firstWindow());}});
test.beforeAll(async()=>{
  const directory=resolve('.build/p8-context/renderer');mkdirSync(directory,{recursive:true});
  const entry=join(directory,'context-fixture.ts'), bundle=join(directory,'context-fixture.js'), require=createRequire(resolve('apps/desktop/package.json'));
  writeFileSync(entry,`import React from ${JSON.stringify(require.resolve('react'))};import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};import {ContextDetails} from ${JSON.stringify(resolve('apps/desktop/src/renderer/context-panel.tsx'))};
    const root=createRoot(document.getElementById('root'));globalThis.__contextPending=[];
    window.medclaw={request:async(method,input)=>new Promise(resolve=>globalThis.__contextPending.push({method,input,resolve}))};
    globalThis.__contextRender=(callId='call-a',runId=1,sessionId=1)=>root.render(React.createElement(ContextDetails,{host:{state:'ready',instanceId:'ui-fixture'},callId,runId,sessionId}));
    globalThis.__contextRender();`);
  execFileSync('bun',['build',entry,'--target=browser',`--outfile=${bundle}`],{cwd:resolve('.'),stdio:'pipe'});
  const html='<link rel="stylesheet" href="/styles.css"><main id="root"></main><script type="module" src="/fixture.js"></script>';
  rendererServer=createServer((request,response)=>{response.setHeader('content-type',request.url==='/fixture.js'?'text/javascript':request.url==='/styles.css'?'text/css':'text/html');response.end(request.url==='/fixture.js'?readFileSync(bundle):request.url==='/styles.css'?readFileSync(resolve('apps/desktop/src/renderer/styles.css')):html);});
  await new Promise<void>(resolve=>rendererServer.listen(0,'127.0.0.1',resolve));rendererUrl=`http://127.0.0.1:${(rendererServer.address() as {port:number}).port}`;
  const main=join(directory,'context-browser.cjs');writeFileSync(main,`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});win.loadURL(${JSON.stringify(rendererUrl)});});`);
  const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;
  rendererApp=await electron.launch({executablePath:require('electron'),args:[main],env});
});
test.afterAll(async()=>{await rendererApp?.close();if(rendererServer){rendererServer.closeAllConnections();await new Promise<void>(resolve=>rendererServer.close(()=>resolve()));}});
const uiSnapshot={contract:'medclaw.context/v1',id:1,runId:1,sessionId:1,inputId:1,sequence:1,createdAt:'2026-10-05T00:00:00.000Z',deliveredCallIds:[],workspaceContext:null,selectedRefs:[],renderedProjection:'<script>data, not instructions</script>',runtimeFeedback:'{}',resourceVersions:{},nativeRefs:[],omitted:[],projectionLimitBytes:262144};
for(const [name,reply,text] of [
  ['empty',{ok:true,data:{kind:'snapshot',snapshot:uiSnapshot,deliveries:[],selectedCallId:'call-a',evidence:'unconfirmed'}},'No material references were selected.'],
  ['gap',{ok:true,data:{kind:'snapshot',snapshot:uiSnapshot,deliveries:[],selectedCallId:'call-a',evidence:'persistence_gap'}},'Delivery evidence has not been confirmed saved. Retry saving the original Run.'],
  ['legacy',{ok:true,data:{kind:'not_recorded',runId:1,sessionId:1,callId:'call-a',reason:'pre_p8'}},'Context was not recorded for this pre-P8 call.'],
  ['provider',{ok:true,data:{kind:'not_recorded',runId:1,sessionId:1,callId:'call-a',reason:'not_applicable'}},'Context snapshots do not apply to this Provider, diagnostic or compaction call.'],
  ['wrong owner',{ok:true,data:{kind:'snapshot',snapshot:{...uiSnapshot,runId:2},deliveries:[],selectedCallId:'call-a',evidence:'unconfirmed'}},'Context ownership could not be verified. Read the original call again.'],
] as const) test(`p8 ContextDetails ${name} is explicit and read only`,async({page})=>{
  await page.goto(rendererUrl);await page.getByRole('button',{name:'View context for call call-a'}).click();
  await page.evaluate(reply=>Reflect.get(globalThis,'__contextPending')[0].resolve(reply),reply);await expect(page.getByText(text,{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>Reflect.get(globalThis,'__contextPending').map((request:{method:string})=>request.method))).toEqual(['context.read']);
  if(name==='empty'){await page.getByText('Rendered materials and sources',{exact:true}).click();await expect(page.locator('pre').first()).toHaveText(uiSnapshot.renderedProjection);expect(await page.locator('#root script').count()).toBe(0);}
});
test('p8 ContextDetails discards a late reply after navigating to another original call',async({page})=>{
  await page.goto(rendererUrl);await page.getByRole('button',{name:'View context for call call-a'}).click();
  await page.evaluate(()=>Reflect.get(globalThis,'__contextRender')('call-b',2,2));
  await page.getByRole('button',{name:'View context for call call-b'}).click();
  await page.evaluate(snapshot=>{const pending=Reflect.get(globalThis,'__contextPending');pending[1].resolve({ok:true,data:{kind:'snapshot',snapshot:{...snapshot,id:2,runId:2,sessionId:2},deliveries:[],selectedCallId:'call-b',evidence:'unconfirmed'}});pending[0].resolve({ok:true,data:{kind:'snapshot',snapshot,deliveries:[],selectedCallId:'call-a',evidence:'unconfirmed'}});},uiSnapshot);
  await expect(page.getByTestId('context-details')).toContainText('Snapshot 2 · Run 2 · Session 2');await expect(page.getByTestId('context-details')).not.toContainText('Snapshot 1 · Run 1');
});
test('p8 ContextDetails read rejection stays an error and can be read again',async({page})=>{
  await page.goto(rendererUrl);const button=page.getByRole('button',{name:'View context for call call-a'});await button.click();
  await page.evaluate(()=>Reflect.get(globalThis,'__contextPending')[0].resolve({ok:false,error:{code:'storage_read_failed'}}));
  await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByText('No material references were selected.',{exact:true})).toHaveCount(0);
  await button.focus();await button.press('Enter');await page.evaluate(snapshot=>Reflect.get(globalThis,'__contextPending')[1].resolve({ok:true,data:{kind:'snapshot',snapshot,deliveries:[],selectedCallId:'call-a',evidence:'unconfirmed'}}),uiSnapshot);await expect(page.getByText('Selected materials',{exact:true})).toBeVisible();
});
