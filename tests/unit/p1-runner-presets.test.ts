import {test,expect,spyOn} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,renameSync} from 'node:fs';
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

test.each([
  {name:'pass',files:[['p1.spec.ts','pass']],expected:{discoveredFiles:1,executed:1,pass:1,fail:0,skip:0,exitCode:0}},
  {name:'empty file',files:[['p1.spec.ts','pass'],['p2.spec.ts','empty']],expected:{executed:1,pass:1,fail:0,exitCode:1}},
  {name:'skipped file',files:[['p1.spec.ts','pass'],['p2.spec.ts','skip']],expected:{executed:1,skip:1,exitCode:1}},
  {name:'required empty file',files:[['p1.spec.ts','pass'],['p2.spec.ts','skip'],['p12.spec.ts','empty']],expected:{executed:1,skip:1,exitCode:1}},
  {name:'required skips',files:[['p1.spec.ts','pass'],['p2.spec.ts','skip'],['p12.spec.ts','skip']],expected:{executed:1,skip:2,exitCode:1}},
  {name:'failure',files:[['p1.spec.ts','fail'],['p2.spec.ts','skip'],['p12.spec.ts','skip']],expected:{fail:1,skip:2,exitCode:1}},
  {name:'all skipped',files:[['p1.spec.ts','skip'],['p2.spec.ts','skip'],['p12.spec.ts','skip']],expected:{executed:0,skip:3,exitCode:1}},
] as const)('desktop execution retains $name',async scenario=>{
  const root=mkdtempSync(join(tmpdir(),'mc-e2e-runner-'));
  const playwright=createRequire(import.meta.url).resolve('@playwright/test').replaceAll('\\','/');
  try {
    mkdirSync(join(root,'tests/e2e'),{recursive:true});
    const header=`import {test,expect} from ${JSON.stringify(playwright)};`;
    const bodies={pass:'test("controlled pass",()=>expect(1).toBe(1));',fail:'test("controlled failure",()=>expect(1).toBe(2));',skip:'test.skip("required missing",()=>{});',empty:''};
    for(const [name,kind] of scenario.files)writeFileSync(join(root,'tests/e2e',name),header+bodies[kind]);
    const first=await runStage('desktop','all',{root});expect(first).toMatchObject(scenario.expected);
    if(scenario.name==='pass'){
      const report=join(first.reportDirectory!,'results.json'),original=readFileSync(report,'utf8');
      const next=await runStage('desktop','all',{root});expect(next).toMatchObject(scenario.expected);
      expect(next.reportDirectory).not.toBe(first.reportDirectory);
      expect(readFileSync(report,'utf8')).toBe(original);
      expect(existsSync(join(first.reportDirectory!,'stdout.log'))).toBe(true);
      expect(existsSync(join(first.reportDirectory!,'stderr.log'))).toBe(true);
    }
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

async function controlledReporter(root:string, options:{xml?:string;stderr?:string;stderrChunks?:string[];exitCode?:number}) {
  const spawn=Bun.spawn;
  const intercepted=spyOn(Bun,'spawn').mockImplementation((args,spawnOptions?)=>{
    if(!Array.isArray(args))return spawn(args);
    const outfile=args.find(arg=>arg.startsWith('--reporter-outfile='))!.slice('--reporter-outfile='.length);
    const code=`import {writeFileSync} from 'node:fs';
      ${options.xml===undefined?'':`writeFileSync(${JSON.stringify(outfile)},${JSON.stringify(options.xml)});`}
      process.stdout.write('controlled stdout\\n');for(const part of ${JSON.stringify(options.stderrChunks??[options.stderr??' 1 pass\n 0 fail\n'])}){process.stderr.write(part);await Bun.sleep(10);}process.exitCode=${options.exitCode??0};`;
    return spawn([process.execPath,'--no-env-file','--eval',code],spawnOptions as Parameters<typeof Bun.spawn>[1]);
  });
  try {return await runStage('e2e','all',{root});} finally {intercepted.mockRestore();}
}
function reporterFixture(){
  const root=mkdtempSync(join(tmpdir(),'mc-report-integrity-'));
  mkdirSync(join(root,'tests/integration'),{recursive:true});
  writeFileSync(join(root,'tests/integration/p2-host.test.ts'),'export {};');
  return root;
}
const onePassJUnit='<testsuites tests="1" failures="0" skipped="0"><testsuite><testcase name="controlled" file="p2-host.test.ts" /></testsuite></testsuites>';

test('terminal display highlights split plain and colored status prefixes while preserving raw evidence and counts',async()=>{
  const root=reporterFixture();
  const chunks=['(pa','ss) 中文 result\r\n(fa','il) rejected\n\x1b[32m✓ colored pass\x1b[0m\n\x1b[31m✗ colored fail\x1b[0m\nmessage (pass) stays\n 2 pass\n 2 fail'];
  const xml='<testsuites tests="4" failures="2" skipped="0"><testsuite><testcase file="p2-host.test.ts"/><testcase file="p2-host.test.ts"><failure/></testcase><testcase file="p2-host.test.ts"/><testcase file="p2-host.test.ts"><failure/></testcase></testsuite></testsuites>';
  const display:string[]=[];
  const output=spyOn(process.stderr,'write').mockImplementation(value=>{display.push(typeof value==='string'?value:Buffer.from(value).toString('utf8'));return true;});
  try {
    const result=await controlledReporter(root,{xml,stderrChunks:chunks,exitCode:1});
    expect(display.join('')).toBe('✅ 中文 result\r\n❌ rejected\n\x1b[32m✅ colored pass\x1b[0m\n\x1b[31m❌ colored fail\x1b[0m\nmessage (pass) stays\n 2 pass\n 2 fail');
    expect(await Bun.file(join(result.reportDirectory!,'stderr.log')).text()).toBe(chunks.join(''));
    expect(result).toMatchObject({pass:2,fail:2,executed:4,exitCode:1,countsSource:'stderr',reportComplete:true,reportErrors:[]});
  } finally {output.mockRestore();rmSync(root,{recursive:true,force:true});}
},30000);

test.each([false,true])('terminal report preserves known counts without JUnit (color=%s)',async color=>{
  const root=reporterFixture();
  try {
    const footer=' 199 pass\n 1 fail\n';
    const result=await controlledReporter(root,{stderr:color?'\x1b[32m 199 pass\x1b[0m\n\x1b[31m 1 fail\x1b[0m\n':footer});
    expect(result).toMatchObject({pass:199,fail:1,executed:200,countsSource:'stderr',reportComplete:false,exitCode:1});
    expect(result.reportErrors).toContain('junit_report_missing');
    expect(await Bun.file(join(result.reportDirectory!,'stderr.log')).text()).toContain(color?'\x1b[32m':footer);
    expect(await Bun.file(join(result.reportDirectory!,'stdout.log')).text()).toBe('controlled stdout\n');
    expect(await Bun.file(join(result.reportDirectory!,'result.json')).json()).toEqual(result);
  } finally {rmSync(root,{recursive:true,force:true});}
},30000);

test.each([
  ['truncated',onePassJUnit.replace('</testsuites>',''),'junit_report_invalid'],
  ['malformed','<invalid />','junit_report_invalid'],
  ['unclosed suite',onePassJUnit.replace('</testsuite>',''),'junit_report_invalid'],
  ['crossed elements','<testsuites tests="1" failures="0" skipped="0"><testsuite><testcase file="p2-host.test.ts"></testsuite></testcase></testsuites>','junit_report_invalid'],
  ['inconsistent',onePassJUnit,'test_counts_inconsistent'],
] as const)('terminal report rejects %s JUnit without losing final counts',async(kind,xml,code)=>{
  const root=reporterFixture();
  try {
    const result=await controlledReporter(root,{xml,stderr:kind==='inconsistent'?' 2 pass\n 0 fail\n':' 1 pass\n 0 fail\n'});
    expect(result.pass).toBe(kind==='inconsistent'?2:1);
    expect(result.exitCode).toBe(1);expect(result.reportComplete).toBe(false);expect(result.reportErrors).toContain(code);
  } finally {rmSync(root,{recursive:true,force:true});}
},30000);

test('terminal report keeps archives and removes stale XML on a later reporter failure',async()=>{
  const root=reporterFixture();
  try {
    const first=await controlledReporter(root,{xml:onePassJUnit});
    expect(first).toMatchObject({reportComplete:true,countsSource:'stderr',exitCode:0});
    expect(await Bun.file(join(root,'test-results/e2e-results.xml')).exists()).toBe(true);
    const second=await controlledReporter(root,{stderr:' 1 pass\n 0 fail\nJUnitReportFailed: controlled write failure\n'});
    expect(await Bun.file(join(root,'test-results/e2e-results.xml')).exists()).toBe(false);
    expect(second.reportDirectory).not.toBe(first.reportDirectory);
    expect(await Bun.file(join(first.reportDirectory!,'results.xml')).exists()).toBe(true);
    expect(second).toMatchObject({pass:1,fail:0,reportComplete:false,exitCode:1});
  } finally {rmSync(root,{recursive:true,force:true});}
},30000);

test('terminal report marks counts unavailable and fails before spawning when output is blocked',async()=>{
  const root=reporterFixture();
  try {
    writeFileSync(join(root,'test-results'),'user-owned obstruction');
    const spawn=spyOn(Bun,'spawn');
    try {
      const result=await runStage('e2e','all',{root});
      expect(spawn).not.toHaveBeenCalled();
      expect(result).toMatchObject({countsSource:'unavailable',reportComplete:false,exitCode:1});
      expect(result.reportErrors).toContain('report_setup_failed');
    } finally {spawn.mockRestore();}
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('terminal report distinguishes absent counts from confirmed zero and preserves archive on alias failure',async()=>{
  const root=reporterFixture();
  try {
    const unknown=await controlledReporter(root,{stderr:'Reporter failed before any usable counts.\n'});
    expect(unknown).toMatchObject({countsSource:'unavailable',reportComplete:false,exitCode:1});
    expect(unknown.reportErrors).toContain('test_counts_unavailable');
    rmSync(join(root,'test-results/e2e-results.json'));
    mkdirSync(join(root,'test-results/e2e-results.json'));
    const blocked=await controlledReporter(root,{xml:onePassJUnit});
    expect(blocked).toMatchObject({pass:1,countsSource:'stderr',reportComplete:false,exitCode:1});
    expect(blocked.reportErrors).toContain('report_write_failed');
    expect(await Bun.file(join(blocked.reportDirectory!,'result.json')).json()).toEqual(blocked);
  } finally {rmSync(root,{recursive:true,force:true});}
},30000);

test.each(['setup-failure','empty-discovery'])('terminal report invalidates previous success on early %s',async kind=>{
  const root=reporterFixture();
  try {
    expect((await controlledReporter(root,{xml:onePassJUnit})).exitCode).toBe(0);
    if(kind==='setup-failure'){
      renameSync(join(root,'test-results/.runs'),join(root,'test-results/.runs-saved'));
      writeFileSync(join(root,'test-results/.runs'),'owned test obstruction');
    }else rmSync(join(root,'tests/integration/p2-host.test.ts'));
    const result=await runStage('e2e','all',{root});
    expect(await Bun.file(join(root,'test-results/e2e-results.xml')).exists()).toBe(false);
    expect(await Bun.file(join(root,'test-results/e2e-results.json')).json()).toEqual(result);
    expect(result).toMatchObject({countsSource:'unavailable',reportComplete:false,exitCode:1});
  } finally {rmSync(root,{recursive:true,force:true});}
},30000);
