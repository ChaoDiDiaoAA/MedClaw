import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { openDatabase } from '../../packages/storage/src/database';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MainSettings } from '../../apps/desktop/src/main/settings';
import { WorkspaceViewSchema } from '../../packages/contracts/src/workspace';
import { safeError, type Result } from '../../packages/contracts/src/error';
import { QueryViewSchema, EvidenceViewSchema } from '../../packages/contracts/src/query';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';

function unwrap<T>(result: Result<T>):T { if(!result.ok) throw Error(result.error.code); return result.data; }
async function fixture(held = false, savedQueries = false) {
  const root=mkdtempSync(join(tmpdir(),'medclaw-p7-host-')), calls=join(root,'restore-calls.jsonl'), release=join(root,'release'), entered=join(root,'entered');
  const entry=join(root,'host.ts');
  writeFileSync(entry, `import {existsSync,writeFileSync,appendFileSync} from 'node:fs';import {WorkspaceService} from ${JSON.stringify(resolve('packages/core/src/workspace/workspace-service.ts'))};
const original=WorkspaceService.prototype.restore;WorkspaceService.prototype.restore=async function(){appendFileSync(${JSON.stringify(calls)},'restore\\n');writeFileSync(${JSON.stringify(entered)},'entered');${held ? `while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(20);` : ''}return original.call(this);};await import(${JSON.stringify(resolve('apps/host/src/main.ts'))});`);
  const host=new HostController({dataRoot:root,hostEntry:entry,bunExecutable:process.execPath,onCredentialRequest:async frame=>frame.method==='credential.list'?{ok:true,data:[]} : frame.method==='credential.read'?{ok:true,data:null}:{ok:false,error:safeError('access_denied')}});
  new MainSettings(host.paths.settingsPath).read();
  const db=openDatabase(host.paths.databasePath), saved=savedQueries?seedWorkspaceQueries(db):null;
  if(!savedQueries)db.run('UPDATE workspace SET selection_json=? WHERE id=1',[JSON.stringify({formatVersion:1,kind:'device',targetId:'999',targetVersion:'a'.repeat(64),rowKey:'snapshot:999',field:null})]);db.close();
  expect(await host.start()).toMatchObject({state:'ready',schemaVersion:13,sdkVersion:'0.87.1'});
  const read=async()=>WorkspaceViewSchema.parse(unwrap(await host.request('workspace.read',{})));
  const sql=(query:string)=>{const db=new Database(host.paths.databasePath,{readonly:true});try{return db.query(query).all();}finally{db.close();}};
  const count=()=>existsSync(calls)?readFileSync(calls,'utf8').trim().split('\n').length:0;
  const close=async()=>{writeFileSync(release,'released');if(host.read().instanceId&&!host.read().canStart)await host.stop(host.read().instanceId!);const inside=relative(tmpdir(),root);if(inside&&!inside.startsWith('..')&&!inside.includes(':'))rmSync(root,{recursive:true,force:true});};
  return {host,read,sql,count,close,entered,release,saved};
}

// Break caught: deriving sidecars from the current page or its row positions
// changes identity when pageSize changes, despite the saved Query being immutable.
test('A03 real Host Query pages keep saved snapshot identities across page sizes without writes', async () => {
  const f=await fixture(false,true);try {
    const queryId=f.saved!.current.id, before={workspace:f.sql('SELECT * FROM workspace'),queries:f.sql('SELECT * FROM queries'),runs:f.sql('SELECT * FROM runs')};
    const read=async(page:number,pageSize:number)=>QueryViewSchema.parse(unwrap(await f.host.request('query.read',{queryId,page,pageSize})));
    const one=await read(1,1),two=await read(2,1),three=await read(3,1),wide=await read(1,2),tail=await read(2,2);
    expect(one.page.rowKeys).toEqual(['snapshot:1']);expect(two.page.rowKeys).toEqual(['snapshot:2']);expect(three.page.rowKeys).toEqual(['snapshot:3']);
    expect(wide.page.rowKeys).toEqual(['snapshot:1','snapshot:2']);expect(tail.page.rowKeys).toEqual(['snapshot:3']);
    expect(wide.page.rows).toEqual([...one.page.rows,...two.page.rows]);expect(tail.page.rows).toEqual(three.page.rows);
    for(const view of [one,two,three,wide,tail])expect(view.page.targetVersion).toBe(f.saved!.current.resultHash);
    expect({workspace:f.sql('SELECT * FROM workspace'),queries:f.sql('SELECT * FROM queries'),runs:f.sql('SELECT * FROM runs')}).toEqual(before);
    expect(f.sql('SELECT count(*) AS n FROM model_calls')).toEqual([{n:0}]);expect(f.sql('SELECT count(*) AS n FROM session_inputs')).toEqual([{n:0}]);
  } finally {await f.close();}
},30000);

// Break caught: page-local duplicate detection incorrectly grants identities
// to equal legacy aggregate rows that are separated by a page boundary.
test('A03 real Host marks duplicate saved aggregate rows null even when split across pages', async () => {
  const f=await fixture(false,true);try {
    const queryId=f.saved!.duplicate.id,before=f.sql('SELECT * FROM queries');
    const read=async(page:number,pageSize:number)=>QueryViewSchema.parse(unwrap(await f.host.request('query.read',{queryId,page,pageSize})));
    const first=await read(1,1),second=await read(2,1),unique=await read(3,1),together=await read(1,2),tail=await read(2,2);
    expect(first.page.rowKeys).toEqual([null]);expect(second.page.rowKeys).toEqual([null]);expect(together.page.rowKeys).toEqual([null,null]);
    const stable='row:1578a93f1a1904e940d9c08b36fe6bab4ab94407cf8517a9c2c50a0ce72075bf';
    expect(unique.page.rowKeys).toEqual([stable]);expect(tail.page.rowKeys).toEqual([stable]);expect(unique.page.rows).toEqual([{region:'浙江',value:7}]);
    expect(first.page.rows).toEqual(second.page.rows);expect(f.sql('SELECT * FROM queries')).toEqual(before);
  } finally {await f.close();}
},30000);

// Break caught: details require the viewing Session, or Evidence IDs are
// accepted for a different Query without checking the original relationship.
test('A04 real Host reads original Query Evidence across Sessions and rejects mismatched Query Evidence without writes', async () => {
  const f=await fixture(false,true);try {
    unwrap(await f.host.request('session.create',{expectedWorkspaceRevision:(await f.read()).revision},'view-b'));
    const before={workspace:f.sql('SELECT * FROM workspace'),queries:f.sql('SELECT * FROM queries'),evidence:f.sql('SELECT * FROM query_evidence'),runs:f.sql('SELECT * FROM runs')};
    const query=QueryViewSchema.parse(unwrap(await f.host.request('query.read',{queryId:f.saved!.current.id})));
    expect(query.query.sessionId).toBe(1);
    const evidence=EvidenceViewSchema.parse(unwrap(await f.host.request('evidence.read',{queryId:f.saved!.current.id,evidenceId:f.saved!.evidenceId})));
    expect(evidence.evidence.queryId).toBe(f.saved!.current.id);expect(evidence.rowKeys).toEqual(['snapshot:1','snapshot:2','snapshot:3']);
    const denied=await f.host.request('evidence.read',{queryId:f.saved!.current.id,evidenceId:f.saved!.secondEvidenceId});
    expect(denied).toMatchObject({ok:false,error:{code:'access_denied'}});
    expect(await f.host.request('query.list',{sessionId:1})).toMatchObject({ok:false,error:{code:'access_denied'}});
    expect(await f.host.request('workspace.update',{expectedRevision:(await f.read()).revision,change:{queryId:f.saved!.current.id}})).toMatchObject({ok:false,error:{code:'access_denied'}});
    expect({workspace:f.sql('SELECT * FROM workspace'),queries:f.sql('SELECT * FROM queries'),evidence:f.sql('SELECT * FROM query_evidence'),runs:f.sql('SELECT * FROM runs')}).toEqual(before);
    expect(f.sql('SELECT count(*) AS n FROM model_calls')).toEqual([{n:0}]);expect(f.sql('SELECT count(*) AS n FROM session_inputs')).toEqual([{n:0}]);
  } finally {await f.close();}
},30000);

test('A10 real restore commit with dropped reply reports unknown and read does not resend',async()=>{
  const f=await fixture();try{
    const before=await f.read(), seam=f.host as unknown as {settle(id:string,result:Result<unknown>):void},settle=seam.settle.bind(seam);
    seam.settle=(id,result)=>{if(id!=='lost-restore'||!result.ok)settle(id,result);};
    const reply=await f.host.request('workspace.restore',{},'restore-original','lost-restore');
    expect(reply).toMatchObject({ok:false,error:{code:'operation_result_unknown',operationRef:'restore-original'}});
    const current=await f.read();expect(current.revision).toBe(before.revision+1);expect(current.selection).toBeNull();expect(f.count()).toBe(1);
    expect(f.sql('SELECT count(*) AS count FROM runs')).toEqual([{count:0}]);expect(f.sql('SELECT count(*) AS count FROM model_calls')).toEqual([{count:0}]);
    seam.settle=settle;
  }finally{await f.close();}
},20000);

test('A10 timed out restore may still execute later in the same Host without a replay',async()=>{
  const f=await fixture(true);try{
    const before=await f.read(),reply=await f.host.request('workspace.restore',{},'slow-restore');
    expect(existsSync(f.entered)).toBe(true);expect(reply).toMatchObject({ok:false,error:{code:'operation_result_unknown'}});
    expect(await f.read()).toEqual(before);writeFileSync(f.release,'released');
    const deadline=Date.now()+3000;while((await f.read()).revision===before.revision&&Date.now()<deadline)await Bun.sleep(20);
    expect((await f.read()).revision).toBe(before.revision+1);expect(f.count()).toBe(1);
    expect(f.sql('SELECT count(*) AS count FROM session_inputs')).toEqual([{count:0}]);
  }finally{await f.close();}
},20000);

test('A10 interrupted restore is a write whose result is unknown',async()=>{
  const f=await fixture(true);try{
    const task=f.host.request('workspace.restore',{},'interrupted-restore');
    const deadline=Date.now()+3000;while(!existsSync(f.entered)&&Date.now()<deadline)await Bun.sleep(20);
    const child=(f.host as unknown as {child:{kill():boolean}}).child;expect(child.kill()).toBe(true);
    expect(await task).toMatchObject({ok:false,error:{code:'operation_result_unknown',operationRef:'interrupted-restore'}});expect(f.count()).toBe(1);
  }finally{await f.close();}
},20000);
