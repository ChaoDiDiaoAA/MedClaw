import {expect,test,_electron as electron} from '@playwright/test';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';

test('p11 resource menu handles keyboard and IME with draft-only selected native commands',async()=>{
  const directory=resolve('.build/p11-resource-input'),require=createRequire(resolve('apps/desktop/package.json'));mkdirSync(directory,{recursive:true});
  const entry=join(directory,'fixture.ts'),bundle=join(directory,'fixture.js');
  writeFileSync(entry,`import React,{useState}from ${JSON.stringify(require.resolve('react'))};import{createRoot}from ${JSON.stringify(require.resolve('react-dom/client'))};import{ResourceInput}from ${JSON.stringify(resolve('apps/desktop/src/renderer/resource-input.tsx'))};
    globalThis.calls=[];globalThis.sends=0;globalThis.owner=1;globalThis.pending=[];
    window.medclaw={request:(method,input)=>{globalThis.calls.push(method);return new Promise(resolve=>globalThis.pending.push({input,resolve}));}};
    function Fixture(){const[value,onChange]=useState(''),[session,setSession]=useState(1);globalThis.switchSession=()=>setSession(2);return React.createElement(ResourceInput,{host:{state:'ready',instanceId:'A'},source:{source:'selection',sessionId:session},configVersion:'1',visible:true,value,disabled:false,onChange,canSend:true,onSend:()=>globalThis.sends++});}
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));`);
  execFileSync('bun',['build',entry,'--target=browser',`--outfile=${bundle}`],{stdio:'pipe'});
  const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/fixture.js'?'text/javascript':'text/html');res.end(req.url==='/fixture.js'?readFileSync(bundle):'<main id="root"></main><script type="module" src="/fixture.js"></script>');});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const main=join(directory,'main.cjs');writeFileSync(main,`const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}}).loadURL('http://127.0.0.1:${(server.address() as {port:number}).port}'));`);
  const env=Object.fromEntries(Object.entries(process.env).filter((e):e is[string,string]=>e[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
  try{
    app=await electron.launch({executablePath:require('electron'),args:[main],env});const page=await app.firstWindow(),input=page.getByLabel('Message text',{exact:true});
    await input.fill('/');await expect.poll(()=>page.evaluate(()=>Reflect.get(globalThis,'pending').length)).toBe(1);
    await page.evaluate(()=>{const pending=Reflect.get(globalThis,'pending')[0];pending.resolve({ok:true,data:{source:'selection',sessionId:1,items:[
      {ref:{kind:'skill',id:'device-detail-review',version:'v1'},name:'Device detail review',enabled:true,availability:'ready'},
      {ref:{kind:'skill',id:'disabled',version:'v1'},enabled:false,availability:'ready'},
      {ref:{kind:'prompt',id:'query',version:'v1'},enabled:true,availability:'ready'}]}});});
    await expect(page.getByRole('group',{name:'Skills',exact:true})).toBeVisible();await expect(page.getByRole('group',{name:'Prompt Templates',exact:true})).toBeVisible();
    await expect(page.getByRole('option')).toHaveCount(2);await input.dispatchEvent('keydown',{key:'ArrowUp'});await expect(input).toHaveAttribute('aria-activedescendant','resource-command-1');await input.dispatchEvent('keydown',{key:'ArrowDown'});await input.dispatchEvent('keydown',{key:'Enter'});await expect(input).toHaveValue('/skill:device-detail-review ');
    expect(await page.evaluate(()=>Reflect.get(globalThis,'sends'))).toBe(0);
    await input.fill('/query');await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:true});await expect(input).toHaveValue('/query');
    await input.dispatchEvent('keydown',{key:'Escape'});await input.dispatchEvent('keydown',{key:'Enter'});expect(await page.evaluate(()=>Reflect.get(globalThis,'sends'))).toBe(1);
    await input.fill('/unknown');await expect(page.getByRole('option')).toHaveCount(0);
    expect(await page.evaluate(()=>Reflect.get(globalThis,'calls'))).toEqual(['resources.list']);
    await page.evaluate(()=>Reflect.get(globalThis,'switchSession')());await input.fill('/');await expect.poll(()=>page.evaluate(()=>Reflect.get(globalThis,'pending').length)).toBe(2);await expect(page.getByRole('option')).toHaveCount(0);
  }finally{await app?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});
