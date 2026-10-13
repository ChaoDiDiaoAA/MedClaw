import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {createRequire} from 'node:module';
import {discoverTests,runStage} from '../run.ts';

test('desktop discovery keeps P1 separate from P10-P15 and all UI files unique',()=>{
  const root=mkdtempSync(join(tmpdir(),'mc-discovery-'));
  try {
    mkdirSync(join(root,'tests/e2e'),{recursive:true});
    for(const name of ['p1.spec.ts','p1-actions.spec.ts','p10.spec.ts','p15.spec.ts'])writeFileSync(join(root,'tests/e2e',name),'');
    expect(discoverTests('desktop','P1',root).map(file=>basename(file))).toEqual(['p1-actions.spec.ts','p1.spec.ts']);
    expect(discoverTests('desktop','P10',root).map(file=>basename(file))).toEqual(['p10.spec.ts']);
    const all=discoverTests('desktop','all',root);
    expect(all).toHaveLength(4);expect(new Set(all).size).toBe(4);
    expect(()=>discoverTests('unit','all',root)).toThrow();
  } finally {rmSync(root,{recursive:true,force:true});}
});

// Cold Bun process startup on Windows can exceed the default unit-test timeout.
test('E2E check defaults to all files without executing the suite',()=>{
  const child=Bun.spawnSync([process.execPath,'--no-env-file',resolve(import.meta.dir,'../run.ts'),'e2e','--','--check'],{cwd:tmpdir()});
  expect(child.exitCode).toBe(0);
  const result=JSON.parse(child.stdout.toString());
  expect(result).toMatchObject({category:'e2e',stage:'all',runner:'bun',check:true,ready:true});
  expect(result.discoveredFiles).toBe(discoverTests('e2e','all').length);
  expect(result.files).toHaveLength(result.discoveredFiles);
  expect(new Set(result.files).size).toBe(result.discoveredFiles);
},30000);

test('desktop execution retains failures, zero execution and required-stage skips',async()=>{
  const root=mkdtempSync(join(tmpdir(),'mc-e2e-runner-'));
  const playwright=createRequire(import.meta.url).resolve('@playwright/test').replaceAll('\\','/');
  try {
    mkdirSync(join(root,'tests/e2e'),{recursive:true});
    const spec=join(root,'tests/e2e/p1.spec.ts');
    const header=`import {test,expect} from ${JSON.stringify(playwright)};`;
    writeFileSync(spec,header+'test("controlled pass",()=>expect(1).toBe(1));');
    expect(await runStage('desktop','all',{root})).toMatchObject({discoveredFiles:1,executed:1,pass:1,fail:0,exitCode:0});
    writeFileSync(join(root,'tests/e2e/p2.spec.ts'),header);
    expect((await runStage('desktop','all',{root})).exitCode).not.toBe(0);
    writeFileSync(join(root,'tests/e2e/p2.spec.ts'),header+'test.skip("unexecuted original coverage",()=>{});');
    expect((await runStage('desktop','all',{root})).exitCode).not.toBe(0);
    writeFileSync(join(root,'tests/e2e/p12.spec.ts'),header);
    const missing=await runStage('desktop','all',{root});expect(missing.executed).toBe(1);expect(missing.exitCode).not.toBe(0);
    writeFileSync(join(root,'tests/e2e/p12.spec.ts'),header+'test.skip("required missing",()=>{});');
    const required=await runStage('desktop','all',{root});expect(required.skip).toBe(2);expect(required.exitCode).not.toBe(0);
    writeFileSync(spec,header+'test("controlled failure",()=>expect(1).toBe(2));');
    expect((await runStage('desktop','all',{root})).fail).toBe(1);
    writeFileSync(spec,header+'test.skip("all skipped",()=>{});');
    const empty=await runStage('desktop','all',{root});expect(empty.executed).toBe(0);expect(empty.exitCode).not.toBe(0);
  } finally {rmSync(root,{recursive:true,force:true});}
},30000);

test('terminal E2E discovers Host and product workflows without desktop specs or unrelated integration tests',()=>{
  const root=mkdtempSync(join(tmpdir(),'mc-terminal-discovery-'));
  try {
    mkdirSync(join(root,'tests/integration'),{recursive:true});mkdirSync(join(root,'tests/e2e'),{recursive:true});
    for(const name of ['p1-host.test.ts','p1-host-actions.test.ts','p10-host.test.ts','p4-messages.test.ts','p15-query-product.test.ts','p15-export.test.ts','p3-storage.test.ts'])writeFileSync(join(root,'tests/integration',name),'');
    writeFileSync(join(root,'tests/e2e/p1.spec.ts'),'');
    expect(discoverTests('e2e','P1',root).map(file=>basename(file))).toEqual(['p1-host-actions.test.ts','p1-host.test.ts']);
    expect(discoverTests('e2e','all',root).map(file=>basename(file))).toEqual(['p1-host-actions.test.ts','p1-host.test.ts','p10-host.test.ts','p15-export.test.ts','p15-query-product.test.ts','p4-messages.test.ts']);
    expect(discoverTests('desktop','all',root).map(file=>basename(file))).toEqual(['p1.spec.ts']);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('terminal E2E executes Bun and rejects skipped, empty and unloadable selected files',async()=>{
  const root=mkdtempSync(join(tmpdir(),'mc-terminal-runner-'));
  try {
    mkdirSync(join(root,'tests/integration'),{recursive:true});
    const first=join(root,'tests/integration/p2-host.test.ts'),second=join(root,'tests/integration/p3-host.test.ts');
    const pass='import {test,expect} from "bun:test";test("terminal process",()=>{expect(Bun.version).toBeTruthy();expect(process.versions.electron).toBeUndefined();});';
    writeFileSync(first,pass);
    expect(await runStage('e2e','all',{root})).toMatchObject({category:'e2e',discoveredFiles:1,executed:1,pass:1,fail:0,skip:0,exitCode:0});
    expect(Bun.file(join(root,'test-results/e2e-results.xml')).size).toBeGreaterThan(0);
    expect(await Bun.file(join(root,'test-results/e2e-results.json')).json()).toMatchObject({category:'e2e',pass:1,exitCode:0});
    writeFileSync(second,'import {test} from "bun:test";test.skip("missing coverage",()=>{});');
    const skipped=await runStage('e2e','all',{root});expect(skipped.skip).toBe(1);expect(skipped.exitCode).not.toBe(0);
    writeFileSync(second,'export {};');
    const empty=await runStage('e2e','all',{root});expect(empty.pass).toBe(1);expect(empty.exitCode).not.toBe(0);
    writeFileSync(second,'import "./missing-module.ts";');
    expect(await runStage('e2e','all',{root})).toMatchObject({fail:1,exitCode:1});
  }finally{rmSync(root,{recursive:true,force:true});}
},20000);
