import {expect,test as base,_electron as electron,type ElectronApplication,type Page} from '@playwright/test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';

let server:ReturnType<typeof createServer>,url:string,app:ElectronApplication;
const test=base.extend<{page:Page}>({page:async({},use)=>use(await app.firstWindow())});
test.beforeAll(async()=>{
  const directory=resolve('.build/p11-renderer');mkdirSync(directory,{recursive:true});const require=createRequire(resolve('apps/desktop/package.json')),entry=join(directory,'fixture.ts'),bundle=join(directory,'fixture.js');
  writeFileSync(entry,`import React from ${JSON.stringify(require.resolve('react'))};import{createRoot}from ${JSON.stringify(require.resolve('react-dom/client'))};import{ResourcePanel}from ${JSON.stringify(resolve('apps/desktop/src/renderer/resource-panel.tsx'))};import{Sidebar}from ${JSON.stringify(resolve('apps/desktop/src/renderer/sidebar.tsx'))};
    const root=createRoot(document.getElementById('root'));globalThis.__pending=[];globalThis.__published=0;
    window.medclaw={request:(method,input)=>new Promise((resolve,reject)=>globalThis.__pending.push({method,input,resolve,reject,done:false}))};
    globalThis.__render=(source={source:'selection',sessionId:1},instanceId='HostA',kind='skill')=>root.render(React.createElement(React.Fragment,null,React.createElement(Sidebar,{page:'skills',onPage:()=>{},onCollapse:()=>{},host:{state:'ready'},collapsed:false}),React.createElement(ResourcePanel,{host:{state:'ready',instanceId},source,kind,activeRunId:99,onPublished:()=>globalThis.__published++})));globalThis.__render();`);
  execFileSync('bun',['build',entry,'--target=browser',`--outfile=${bundle}`],{cwd:resolve('.'),stdio:'pipe'});
  server=createServer((request,response)=>{response.setHeader('content-type',request.url==='/fixture.js'?'text/javascript':'text/html');response.end(request.url==='/fixture.js'?readFileSync(bundle):'<main id="root"></main><script type="module" src="/fixture.js"></script>');});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const main=join(directory,'browser.cjs');writeFileSync(main,`const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});win.loadURL(${JSON.stringify(url)});});`);
  const env=Object.fromEntries(Object.entries(process.env).filter((value):value is [string,string]=>value[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({executablePath:require('electron'),args:[main],env});
});
test.afterAll(async()=>{await app?.close();if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}});
const requests=(page:Page,method:string)=>page.evaluate(method=>Reflect.get(globalThis,'__pending').filter((item:{method:string})=>item.method===method).map(({input,done}:{input:unknown;done:boolean})=>({input,done})),method);
async function reply(page:Page,method:string,value:unknown){await expect.poll(async()=>(await requests(page,method)).filter((item:{done:boolean})=>!item.done).length).toBeGreaterThan(0);await page.evaluate(({method,value})=>{const item=Reflect.get(globalThis,'__pending').find((item:{method:string;done:boolean})=>item.method===method&&!item.done);item.done=true;item.resolve(value);},{method,value});}
const ref=(version='v1',kind='skill')=>({kind,id:'query',version,treeHash:'a'.repeat(64)});
function list(sessionId=1,version='1',selected=false){return {source:'selection',sessionId,configVersion:version,selection:{prompt:null,skills:selected?[ref()]:[]},items:['v1','v2'].map(v=>({ref:ref(v),name:'query',description:'ENGINEERING query resources',keywords:['data'],enabled:selected&&v==='v1',availability:'ready',disableModelInvocation:v==='v2',files:[{file:'SKILL.md',bytes:10,sha256:'b'.repeat(64)}],requiredTools:['read_data_scope'],requiredExtensions:[],diagnostics:[]})),diagnostics:[],catalogError:null,evidence:[],evidenceInfo:{page:1,pageSize:50,totalRows:0,hasMore:false}};}

test('p11 English resource entrances, versions and confirmed publication stay distinct from availability and use',async({page})=>{
  await page.goto(url);await reply(page,'resources.list',{ok:true,data:list()});
  await expect(page.getByRole('button',{name:'Prompt',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Skills',exact:true})).toBeVisible();
  await expect(page.getByText('Applies to the next run', {exact:true})).toBeVisible();await page.getByRole('button',{name:'Enable query',exact:true}).click();
  expect((await requests(page,'resources.select'))[0]!.input).toMatchObject({sessionId:1,expectedConfigVersion:'1',selection:{skills:[ref()]}});
  await reply(page,'resources.select',{ok:true,data:{sessionId:1,configVersion:'2',selection:{prompt:null,skills:[ref()]}}});await reply(page,'resources.list',{ok:true,data:list(1,'2',true)});
  await expect(page.getByText('Published configuration 2',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Disable query',exact:true})).toBeVisible();
  await page.getByLabel('query version').selectOption(JSON.stringify(ref('v2')));await reply(page,'resources.select',{ok:false,error:{code:'config_version_conflict'}});
  await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByRole('button',{name:'Disable query',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Refresh resources',exact:true}).click();const broken={...list(1,'3',true),catalogError:{code:'resource_unavailable'},items:[{...list(1,'3',true).items[0]!,name:null,description:null,requiredTools:null,requiredExtensions:null,availability:'invalid',files:[],disableModelInvocation:null}]};await reply(page,'resources.list',{ok:true,data:broken});
  await expect(page.getByText('Required tools: Unknown · Required extensions: Unknown',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Clear selection',exact:true}).click();await reply(page,'resources.select',{ok:false,error:{code:'operation_result_unknown'}});
  await expect(page.getByRole('alert').filter({hasText:'Refresh'})).toBeVisible();expect(await page.evaluate(()=>Reflect.get(globalThis,'__published'))).toBe(1);
});

test('p11 delayed source, Host and file replies cannot replace the current selection or body; no implicit Session',async({page})=>{
  await page.goto(url);await expect.poll(async()=>(await requests(page,'resources.list')).length).toBe(1);await page.evaluate(()=>Reflect.get(globalThis,'__render')({source:'selection',sessionId:2}));
  await reply(page,'resources.list',{ok:true,data:list(1,'old',true)});await reply(page,'resources.list',{ok:true,data:list(2,'2',true)});
  await expect(page.getByTestId('resource-panel')).toContainText('Session 2');await expect(page.getByTestId('resource-panel')).not.toContainText('old');
  await page.getByRole('button',{name:'Read query SKILL.md',exact:true}).click();await page.evaluate(()=>Reflect.get(globalThis,'__render')({source:'selection',sessionId:2},'HostB'));
  await reply(page,'resources.read',{ok:true,data:{source:'selection',sessionId:2,configVersion:'2',resourceRef:ref(),file:'SKILL.md',content:'OLD HOST CONTENT',bytes:16,sha256:'b'.repeat(64)}});
  await reply(page,'resources.list',{ok:true,data:list(2,'3',true)});await expect(page.getByTestId('resource-panel')).not.toContainText('OLD HOST CONTENT');
  const count=(await requests(page,'resources.list')).length;await page.evaluate(()=>Reflect.get(globalThis,'__render')(null));await expect(page.getByTestId('resource-panel')).toContainText('Select a Session');
  expect(await requests(page,'resources.list')).toHaveLength(count);expect(await requests(page,'session.create')).toHaveLength(0);
});

test('p11 Run resources page reads historical origin bytes, pages proof and never publishes a selection',async({page})=>{
  await page.goto(url);await reply(page,'resources.list',{ok:true,data:list()});await page.evaluate(()=>Reflect.get(globalThis,'__render')({source:'run',runId:8},'HostA',undefined));
  const frozen={...list(1,'2',true),source:'run',runId:8,evidence:[{resourceRef:ref(),originRunId:7,file:'SKILL.md',kind:'provider_delivery',inputId:null,nativeEntryId:'native',toolCallId:4,modelCallId:'call',payloadHash:'c'.repeat(64),contentHash:'b'.repeat(64),coverage:'partial',observedAt:'2026-10-06T00:00:00Z'}],evidenceInfo:{page:1,pageSize:50,totalRows:51,hasMore:true}};
  await reply(page,'resources.list',{ok:true,data:frozen});await expect(page.getByText('Historical content from run 7',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Read historical query SKILL.md',exact:true}).click();expect((await requests(page,'resources.read'))[0]!.input).toMatchObject({source:'run',runId:7});
  await reply(page,'resources.read',{ok:true,data:{source:'run',runId:7,sessionId:1,configVersion:'1',resourceRef:ref(),file:'SKILL.md',content:'<script>ENGINEERING old v1</script>',bytes:36,sha256:'b'.repeat(64)}});
  await expect(page.getByTestId('resource-body')).toContainText('<script>ENGINEERING old v1</script>');expect(await page.locator('[data-testid=resource-body] script').count()).toBe(0);
  await page.getByRole('button',{name:'Next evidence page',exact:true}).click();expect((await requests(page,'resources.list')).at(-1)!.input).toMatchObject({source:'run',runId:8,evidencePage:2});
  await reply(page,'resources.list',{ok:true,data:{...frozen,evidence:[],evidenceInfo:{page:2,pageSize:50,totalRows:51,hasMore:false}}});
  expect(await requests(page,'resources.select')).toHaveLength(0);await expect(page.getByTestId('resource-panel')).toContainText('Following instructions has not been evaluated');
});
