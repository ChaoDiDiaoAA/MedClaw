import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { openDatabase } from '../../packages/storage/src/database';
import { SqliteContextStore } from '../../packages/storage/src/context-store';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MainSettings } from '../../apps/desktop/src/main/settings';
import { acceptContextInput, contextAt } from '../fixtures/p8-context';
import { ContextReadResultSchema } from '../../packages/contracts/src/context';
import { safeError, type Result } from '../../packages/contracts/src/error';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

function unwrap<T>(result:Result<T>):T { if (!result.ok) throw new Error(result.error.code); return result.data; }
test('p8 real Host reads original Context across navigation without requests or fact writes', async () => {
  const root = mkdtempSync(join(tmpdir(),'medclaw-p8-host-'));
  const host = new HostController({dataRoot:root,hostEntry:resolve('apps/host/src/main.ts'),bunExecutable:process.execPath,onCredentialRequest:async frame => frame.method === 'credential.list' ? {ok:true,data:[]} : frame.method === 'credential.read' ? {ok:true,data:null} : {ok:false,error:safeError('access_denied')}});
  new MainSettings(host.paths.settingsPath).read();
  const db = openDatabase(host.paths.databasePath), f = acceptContextInput(db), contexts = new SqliteContextStore(db), snapshot = contexts.save(contexts.select(f.input));
  f.repos.startCall(f.input.runId,'host-call','main',contextAt,{snapshotId:snapshot.id,inputId:f.input.inputId});
  contexts.recordDelivery({runId:f.input.runId,sessionId:f.input.sessionId,inputId:f.input.inputId,callId:'host-call',snapshotId:snapshot.id,observation:{contract:'medclaw.context-observation/v1',api:'openai-completions',transport:'sse',httpStatus:200,observedAt:contextAt,projectionHash:snapshot.projectionHash,feedbackHash:snapshot.feedbackHash,verifiedNativeRefs:[]}}); db.close();
  const sql = (query:string) => {const read = new Database(host.paths.databasePath,{readonly:true});try{return read.query(query).all();}finally{read.close();}};
  try {
    expect(await host.start()).toMatchObject({state:'ready',schemaVersion:9});
    const workspace = unwrap(await host.request('workspace.read',{})) as {revision:number};
    unwrap(await host.request('session.create',{expectedWorkspaceRevision:workspace.revision},'browse-other'));
    const before = {runs:sql('SELECT * FROM runs'),calls:sql('SELECT * FROM model_calls'),snapshots:sql('SELECT * FROM context_snapshots'),deliveries:sql('SELECT * FROM context_deliveries'),events:sql('SELECT * FROM runtime_events')};
    const read = ContextReadResultSchema.parse(unwrap(await host.request('context.read',{callId:'host-call'})));
    expect(read).toMatchObject({kind:'snapshot',selectedCallId:'host-call',evidence:'saved',snapshot:{runId:f.input.runId,sessionId:f.input.sessionId}});
    expect(ContextReadResultSchema.parse(unwrap(await host.request('context.read',{snapshotId:snapshot.id})))).toMatchObject({kind:'snapshot',selectedCallId:null});
    expect(await host.request('context.read',{callId:'unknown'})).toMatchObject({ok:false,error:{code:'run_not_found'}});
    expect(await host.request('context.read',{snapshotId:9999})).toMatchObject({ok:false,error:{code:'resource_unavailable'}});
    expect({runs:sql('SELECT * FROM runs'),calls:sql('SELECT * FROM model_calls'),snapshots:sql('SELECT * FROM context_snapshots'),deliveries:sql('SELECT * FROM context_deliveries'),events:sql('SELECT * FROM runtime_events')}).toEqual(before);
  } finally {if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);rmSync(root,{recursive:true,force:true});}
},30000);

for(const saved of [false,true]) test(`p8 abrupt real Host restart preserves original Context evidence (saved=${saved})`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'medclaw-p8-restart-'));
  const host=new HostController({dataRoot:root,hostEntry:resolve('apps/host/src/main.ts'),bunExecutable:process.execPath,onCredentialRequest:async frame=>frame.method==='credential.list'?{ok:true,data:[]}:{ok:true,data:null}});
  new MainSettings(host.paths.settingsPath).read();
  const db=openDatabase(host.paths.databasePath),f=acceptContextInput(db),contexts=new SqliteContextStore(db),snapshot=contexts.save(contexts.select(f.input));
  f.repos.startCall(f.input.runId,'restart-host-call','main',contextAt,{snapshotId:snapshot.id,inputId:f.input.inputId});
  // Seed exact persisted restart states. Network observation itself is proved by the Runtime/desktop receiver tests.
  if(saved)contexts.recordDelivery({runId:f.input.runId,sessionId:f.input.sessionId,inputId:f.input.inputId,callId:'restart-host-call',snapshotId:snapshot.id,observation:{contract:'medclaw.context-observation/v1',api:'openai-completions',transport:'sse',httpStatus:200,observedAt:contextAt,projectionHash:snapshot.projectionHash,feedbackHash:snapshot.feedbackHash,verifiedNativeRefs:[]}});
  const factsBefore=db.query('SELECT * FROM model_calls').all();db.close();
  try{
    expect(await host.start()).toMatchObject({state:'ready'});
    const originalInstance=host.read().instanceId!,child=(host as unknown as {child:ChildProcessWithoutNullStreams}).child;
    const exited=new Promise<void>(resolve=>child.once('close',resolve));expect(child.kill('SIGKILL')).toBe(true);await exited;
    expect(await host.restart(originalInstance)).toMatchObject({state:'ready'});expect(host.read().instanceId).not.toBe(originalInstance);
    expect(await host.request('context.read',{callId:'restart-host-call'})).toMatchObject({ok:true,data:{kind:'snapshot',evidence:saved?'saved':'persistence_gap',snapshot:{runId:f.input.runId,inputId:f.input.inputId,sessionId:f.input.sessionId}}});
    const run=await host.request('run.read',{runId:f.input.runId});expect(run).toMatchObject({ok:true,data:{kind:'one',run:{status:'failed',cleanup:{stopConfirmed:true,requiredPersistenceComplete:saved}}}});
    if(!saved)expect(await host.request('run.retrySave',{runId:f.input.runId},'retry-original-gap')).toMatchObject({ok:false,error:{code:'run_save_unavailable'}});
    const read=new Database(host.paths.databasePath,{readonly:true});try{
      expect(read.query('SELECT * FROM model_calls').all()).toEqual(factsBefore);expect(read.query('SELECT * FROM context_snapshots').all()).toHaveLength(1);expect(read.query('SELECT * FROM context_deliveries').all()).toHaveLength(saved?1:0);
    }finally{read.close();}
  }finally{if(host.read().instanceId&&!host.read().canStart)await host.stop(host.read().instanceId!);rmSync(root,{recursive:true,force:true});}
},30000);
