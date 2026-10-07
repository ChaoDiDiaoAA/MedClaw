import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MainSettings, atomicWriteJson } from '../../apps/desktop/src/main/settings';
import { ExtensionsReadResultSchema } from '../../packages/contracts/src/protocol';
import { safeError, type Result } from '../../packages/contracts/src/error';

function unwrap<T>(result: Result<T>): T { if (!result.ok) throw result.error; return result.data; }
test('p12 actual Main publication and Host read prove configuration without creating a run or model call', async () => {
  const root = mkdtempSync(join(tmpdir(),'medclaw-p12-host-'));
  const host = new HostController({dataRoot:root,hostEntry:resolve('apps/host/src/main.ts'),bunExecutable:process.execPath,onStartupFailure:failure=>process.stderr.write(JSON.stringify(failure)+'\n'),onError:error=>process.stderr.write(JSON.stringify(error)+'\n'),
    onCredentialRequest:async frame => frame.method==='credential.list' ? {ok:true,data:[]} : frame.method==='credential.read' ? {ok:true,data:null} : {ok:false,error:safeError('access_denied')} });
  let failWrite = false, loseCommit = false; const commits: string[] = [];
  const settings = new MainSettings(host.paths.settingsPath, {
    prepare: async (token,candidate) => unwrap(await host.request('settings.prepare',{token,candidate})),
    commit: async (token,publishedVersion) => {commits.push(token); const result=unwrap(await host.request('settings.commit',{token,publishedVersion})); if(loseCommit){loseCommit=false;throw new Error('ENGINEERING lost commit reply');} return result;},
    abort: async token => unwrap(await host.request('settings.abort',{token})),
    readVersion: async () => (unwrap(await host.request('diagnostics.read',{categories:[]})) as {versions:{configVersion:string}}).versions.configVersion,
  }, (path,value)=>{if(failWrite)throw new Error('ENGINEERING failed write');atomicWriteJson(path,value);});
  settings.read();
  try {
    expect(await host.start()).toMatchObject({state:'ready',schemaVersion:12});
    const created=unwrap(await host.request('session.create',{expectedWorkspaceRevision:0},'create-a')) as {session:{id:number}};
    const sessionId=created.session.id;
    const read=ExtensionsReadResultSchema.parse(unwrap(await host.request('extensions.read',{source:'selection',sessionId})));
    expect(read).toMatchObject({source:'selection',sessionId,selection:{extension:null},live:null});
    const extensions={bySession:{[String(sessionId)]:{extension:null}}};
    failWrite=true; const writeError=await settings.publish('1',{extensions},{kind:'extensions'}).catch(error=>error); expect(writeError.message).toBe('config_write_failed'); expect(settings.read().configVersion).toBe('1');
    failWrite=false; loseCommit=true; const commitError=await settings.publish('1',{extensions},{kind:'extensions'}).catch(error=>error); expect(commitError.message).toBe('config_write_failed'); expect(settings.read().configVersion).toBe('2');
    await settings.synchronize(); expect(new Set(commits).size).toBe(1);
    expect(unwrap(await host.request('extensions.read',{source:'selection',sessionId}))).toMatchObject({configVersion:'2',selection:{extension:null},live:null});
    await expect(settings.publish('1',{extensions},{kind:'extensions'})).rejects.toThrow('config_conflict');
    const before=settings.read(); const missingSession=await settings.publish('2',{extensions:{bySession:{'999':{extension:null}}}},{kind:'extensions'}).catch(error=>error); expect(missingSession).toMatchObject({code:'input_invalid',reason:'session_not_found'}); expect(settings.read()).toEqual(before);
    expect(await host.request('extensions.select',{sessionId,expectedConfigVersion:'2',selection:{extension:null}},'host-cannot-write')).toMatchObject({ok:false,error:{code:'access_denied'}});
    expect(await host.request('extensions.command',{instanceId:host.read().instanceId!,sessionId,runId:1,assemblyId:'stale',command:'extension_status'})).toMatchObject({ok:false,error:{code:'state_conflict'}});
    if(read.source!=='selection'||!read.available)throw new Error('Shipped first-party descriptor missing');
    await settings.publish('2',{extensions:{bySession:{[String(sessionId)]:{extension:read.available.ref}}}},{kind:'extensions'});
    expect(unwrap(await host.request('extensions.read',{source:'selection',sessionId}))).toMatchObject({configVersion:'3',selection:{extension:read.available.ref},live:null});
    const changed=await settings.publish('3',{extensions:{bySession:{[String(sessionId)]:{extension:{...read.available.ref,treeHash:'a'.repeat(64)}}}}},{kind:'extensions'}).catch(error=>error);
    expect(changed).toMatchObject({code:'extension_unavailable'});expect(settings.read().configVersion).toBe('3');
    await settings.publish('3',{extensions},{kind:'extensions'});
    const db=new Database(host.paths.databasePath,{readonly:true});
    try {expect(db.query<{n:number},[]>('SELECT count(*) AS n FROM runs').get()?.n).toBe(0);expect(db.query<{n:number},[]>('SELECT count(*) AS n FROM model_calls').get()?.n).toBe(0);} finally {db.close();}
  } finally {failWrite=false;if(host.read().instanceId&&!host.read().canStart)await host.stop(host.read().instanceId!);rmSync(root,{recursive:true,force:true});}
},60000);
