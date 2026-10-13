import {test,expect,spyOn} from 'bun:test';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {HostController} from '../../apps/desktop/src/main/host-controller';
import {safeError} from '../../packages/contracts/src/error';
import type {HostView} from '../../packages/contracts/src/model';
import * as fixtures from '../fixtures/p1-host';

test('controlled second-start rejection retains the failed assertion and safe actual exit evidence',async()=>{
  expect(typeof fixtures.createHostDiagnostics).toBe('function');
  const {root,entry}=await fixtures.fixture('reject-restart');
  const trace=fixtures.createHostDiagnostics();
  const host=new HostController({dataRoot:root,hostEntry:entry,bunExecutable:process.execPath,
    onStarting:instance=>trace.starting(instance,(host as unknown as {child:ChildProcessWithoutNullStreams}).child),
    onExit:trace.onExit,onNotice:trace.onNotice,onError:trace.onError});
  const output=spyOn(console,'error').mockImplementation(()=>{});
  try {
    trace.phase='first-start';expect(await host.start()).toMatchObject({state:'ready',error:null});
    trace.phase='stop';expect((await host.stop(host.read().instanceId!)).state).toBe('stopped');
    trace.phase='second-start';const failed=await host.start();
    expect(failed).toMatchObject({state:'failed',error:{code:'host_interrupted'}});
    expect(()=>expect(failed).toMatchObject({state:'ready',error:null})).toThrow();
    trace.onNotice({type:'provider.preview',runId:1,text:'CANARY-PRIVATE-PREVIEW',truncated:false});
    trace.onError({...safeError('host_interrupted'),message:'CANARY-ERROR-MESSAGE'});
    expect(await fixtures.finishHostFixture(host,root,entry,trace,true)).toBe(true);
    const line=String(output.mock.calls.at(-1)![0]);
    const diagnostic=JSON.parse(line.slice('HOST_TEST_DIAGNOSTIC '.length));
    expect(diagnostic).toMatchObject({phase:'second-start',error:{code:'host_interrupted'},entryExists:true,cleanupConfirmed:true});
    expect(diagnostic.exits.some((item:{code:number|null})=>item.code===43)).toBe(true);
    expect(line).not.toContain('CANARY');expect(line).not.toContain('startupToken');
    expect(existsSync(root)).toBe(false);
  } finally {
    output.mockRestore();
    if(existsSync(root))await fixtures.finishHostFixture(host,root,entry,trace,true);
  }
},30000);

test('Host fixture retains its directory when stopping remains unconfirmed',async()=>{
  expect(typeof fixtures.finishHostFixture).toBe('function');
  const root=mkdtempSync(join(tmpdir(),'mc-host-unknown-')),entry=join(root,'entry.ts');writeFileSync(entry,'preserve');
  const view:HostView={instanceId:'unconfirmed',state:'stopping',canStart:false,sdkVersion:null,schemaVersion:null,error:safeError('host_stop_unconfirmed')};
  const host={read:()=>view,stop:async()=>view};
  const output=spyOn(console,'error').mockImplementation(()=>{});
  try {
    const trace=fixtures.createHostDiagnostics();trace.phase='stop';
    expect(await fixtures.finishHostFixture(host,root,entry,trace,true)).toBe(false);
    expect(existsSync(entry)).toBe(true);
    expect(String(output.mock.calls.at(-1)![0])).toContain('"cleanupConfirmed":false');
    expect(String(output.mock.calls.at(-1)![0])).toContain('fixtureDirectory');
    await expect(fixtures.finishHostFixture(host,root,entry,trace,false)).rejects.toThrow('fixture_stop_unconfirmed');
  } finally {output.mockRestore();rmSync(root,{recursive:true,force:true});}
});

test('confirmed Host fixture cleanup removes only its own directory',async()=>{
  expect(typeof fixtures.finishHostFixture).toBe('function');
  const root=mkdtempSync(join(tmpdir(),'mc-host-owned-')),other=mkdtempSync(join(tmpdir(),'mc-host-unrelated-'));
  const view:HostView={instanceId:null,state:'stopped',canStart:true,sdkVersion:null,schemaVersion:null,error:null};
  try {
    expect(await fixtures.finishHostFixture({read:()=>view,stop:async()=>view},root,join(root,'entry.ts'),fixtures.createHostDiagnostics(),false)).toBe(true);
    expect(existsSync(root)).toBe(false);expect(existsSync(other)).toBe(true);
  } finally {rmSync(root,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});}
});
