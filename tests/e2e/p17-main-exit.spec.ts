import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { MainSettings, atomicWriteJson } from '../../apps/desktop/src/main/settings';
import { bunExecutable, launchActualDev, readStartupFacts } from '../fixtures/desktop-dev';
import { EvaluationControlViewSchema } from '../../packages/contracts/src/evaluation';
import { HostViewSchema } from '../../packages/contracts/src/model';
import { ExportCopyReceiptSchema, type StoredExport } from '../../packages/contracts/src/export';

type MissingProof = 'stopConfirmed' | 'saveConfirmed' | 'controllerExited';

async function evaluationExitFixture(field: MissingProof) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'MedClaw 退出证明-'))), dataRoot = join(root, '用户 数据'), configs = join(root, 'evaluation-configs');
  const observer = join(root, 'main-observer.cjs'), worker = join(root, 'evaluation-worker.ts');
  const workerReady = join(root, 'worker-ready.json'), preparation = join(root, 'preparation.json'), release = join(root, 'release-preparation');
  const fault = join(root, 'missing-proof'), stopRequested = join(root, 'stop-requested.json'), network = join(root, 'network-attempts');
  const quit = join(root, 'quit-command'), quitSeen = join(root, 'quit-observed.json'), exitSeen = join(root, 'main-exit.json');
  const hostNotice = join(root, 'host-notice.json'), evaluationNotice = join(root, 'evaluation-notice.json'), workerExitWait = join(root, 'worker-exit-wait');
  const originalWorker = resolve('agent-eval/src/desktop/controller.ts'), service = resolve('agent-eval/src/desktop/service.ts');
  const configuration = execFileSync(bunExecutable, ['--no-env-file', '-e', 'import{runConfigFixture}from' + JSON.stringify(resolve('agent-eval/tests/report-fixture.ts')) + ';console.log(JSON.stringify(runConfigFixture()));'], { encoding: 'utf8', windowsHide: true });
  mkdirSync(configs); writeFileSync(join(configs, 'agent.json'), configuration);
  writeFileSync(join(configs, 'environment'), 'MEDCLAW_JUDGE_BASE_URL=https://judge.example.invalid/v1\nMEDCLAW_JUDGE_MODEL=openai/gpt-4o-mini\nMEDCLAW_JUDGE_API_KEY=ENGINEERING-only\n');
  writeFileSync(fault, 'armed');
  writeFileSync(worker, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    import {EvaluationWorker,runEvaluationControlProcess} from ${JSON.stringify(originalWorker)};
    import {EvaluationService} from ${JSON.stringify(service)};
    let requests=0;globalThis.fetch=async()=>{writeFileSync(${JSON.stringify(network)},String(++requests));throw new Error('ENGINEERING inference and platform network prohibited');};
    writeFileSync(${JSON.stringify(workerReady)},JSON.stringify({pid:process.pid}));
    const prepare=EvaluationService.prototype.prepareRun;
    EvaluationService.prototype.prepareRun=async function(...args){const value=await prepare.apply(this,args);
      writeFileSync(${JSON.stringify(preparation)},JSON.stringify({pid:process.pid,preflightId:args[0].preflightId}));
      const deadline=Date.now()+45000;while(!existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)throw new Error('ENGINEERING preparation gate expired');await Bun.sleep(10);}return value;};
    const shutdown=EvaluationWorker.prototype.shutdown;
    EvaluationWorker.prototype.shutdown=async function(...args){const pending=shutdown.apply(this,args);
      writeFileSync(${JSON.stringify(stopRequested)},JSON.stringify({pid:process.pid,controllerInstanceId:this.controllerInstanceId,cancelRequested:this.current?.abort.signal.aborted===true}));
      const proof=await pending;
      if(${JSON.stringify(field)}!=='controllerExited'&&readFileSync(${JSON.stringify(fault)},'utf8')==='armed')return{...proof,[${JSON.stringify(field)}]:null,
        gaps:[{code:'engineering_proof_unconfirmed',message:'ENGINEERING shutdown proof withheld.',trialId:null}]};return proof;};
    const request=EvaluationWorker.prototype.request;
    EvaluationWorker.prototype.request=async function(method,...args){const value=await request.call(this,method,...args);
      if(method==='eval.status'&&value.executionId&&${JSON.stringify(field)}!=='controllerExited'&&existsSync(${JSON.stringify(stopRequested)})&&readFileSync(${JSON.stringify(fault)},'utf8')==='armed')
        return{...value,state:'unknown',[${JSON.stringify(field)}]:null,blockReasons:[{code:'engineering_proof_unconfirmed',message:'ENGINEERING shutdown proof withheld.',trialId:null}]};return value;};
    await runEvaluationControlProcess();
    if(${JSON.stringify(field)}==='controllerExited'&&readFileSync(${JSON.stringify(fault)},'utf8')==='armed'){
      writeFileSync(${JSON.stringify(workerExitWait)},'ENGINEERING original controller still alive');
      const deadline=Date.now()+60000;while(readFileSync(${JSON.stringify(fault)},'utf8')==='armed'){if(Date.now()>deadline)throw new Error('ENGINEERING controller exit gate expired');await Bun.sleep(10);}
    }`);
  writeFileSync(observer, `module.exports=({app})=>{
    const fs=require('fs'), cp=require('node:child_process'), spawn=cp.spawn;let last='',count=0;
    const record=(path,value)=>{fs.writeFileSync(path+'.next',JSON.stringify(value));fs.renameSync(path+'.next',path);};
    cp.spawn=function(command,args,options){const selected=Array.isArray(args)&&args[1]===${JSON.stringify(originalWorker)}?[args[0],${JSON.stringify(worker)},...args.slice(2)]:args;
      return spawn.call(this,command,selected,options);};
    const timer=setInterval(()=>{const command=fs.existsSync(${JSON.stringify(quit)})?fs.readFileSync(${JSON.stringify(quit)},'utf8'):'';
      if(command&&command!==last){last=command;app.quit();}},10);timer.unref();
    app.on('before-quit',()=>fs.writeFileSync(${JSON.stringify(quitSeen)},JSON.stringify({count:++count,command:last,pid:process.pid})));
    app.on('browser-window-created',(_,window)=>{const send=window.webContents.send.bind(window.webContents);window.webContents.send=(channel,...args)=>{
      const notice=args[0];if(channel==='medclaw:notice'&&notice?.type==='host.status')record(${JSON.stringify(hostNotice)},notice.host);
      if(channel==='medclaw:notice'&&notice?.type==='eval.status')record(${JSON.stringify(evaluationNotice)},notice.control);return send(channel,...args);};});
    const exit=app.exit.bind(app);app.exit=code=>{fs.writeFileSync(${JSON.stringify(exitSeen)},JSON.stringify({code:code??0,pid:process.pid}));return exit(code);};
  };`);
  const desktop = await launchActualDev(root, dataRoot, undefined, undefined, undefined, observer);
  const resolveFault = () => { writeFileSync(release, 'ENGINEERING explicit preparation release'); writeFileSync(fault, 'resolved'); };
  const requestQuit = () => { const id = crypto.randomUUID(); writeFileSync(quit, id); return id; };
  return { ...desktop, root, dataRoot, preparation, stopRequested, workerReady, workerExitWait,
    release: () => writeFileSync(release, 'ENGINEERING explicit release after cancellation'), resolveFault,
    requestQuit,
    quitSeen: () => existsSync(quitSeen) ? JSON.parse(readFileSync(quitSeen, 'utf8')) as { count: number; command: string; pid: number } : null,
    exitSeen: () => existsSync(exitSeen) ? JSON.parse(readFileSync(exitSeen, 'utf8')) as { code: number; pid: number } : null,
    evaluation: () => existsSync(evaluationNotice) ? EvaluationControlViewSchema.parse(JSON.parse(readFileSync(evaluationNotice, 'utf8'))) : null,
    host: () => existsSync(hostNotice) ? HostViewSchema.parse(JSON.parse(readFileSync(hostNotice, 'utf8'))) : null,
    networkRequests: () => existsSync(network) ? Number(readFileSync(network, 'utf8')) : 0,
    async dispose() {
      if (desktop.child.exitCode === null) {
        requestQuit(); const deadline = Date.now() + 10000;
        while (!existsSync(stopRequested) && desktop.child.exitCode === null) {
          if (Date.now() > deadline) throw new Error('ENGINEERING cancellation not observed; Main root retained: ' + root);
          await new Promise(done => setTimeout(done, 10));
        }
      }
      resolveFault(); await desktop.close();
      const target = realpathSync(root), part = relative(realpathSync(tmpdir()), target);
      if (!existsSync(join(root, 'dev-exit-confirmed')) || target !== root || !part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('ENGINEERING Main exit root retained: ' + root);
      console.log('P17_MAIN_EVALUATION_ROOT_RETAINED ' + root);
    },
  };
}

for (const field of ['stopConfirmed', 'saveConfirmed', 'controllerExited'] satisfies MissingProof[]) test('P17 actual Main retains its window when evaluation ' + field + ' is unconfirmed and retries only explicitly', async ({}) => {
  test.setTimeout(120000); const desktop = await evaluationExitFixture(field);
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await expect.poll(() => existsSync(desktop.workerReady)).toBe(true);
    const beforeHost = await page.evaluate(() => window.medclaw.request('host.read', {})); if (!beforeHost.ok || !beforeHost.data.instanceId) throw new Error('ENGINEERING no original Host');
    const operationRef = crypto.randomUUID(), options = { datasetId: 'medclaw-agent-v1', selection: 'smoke' as const, trials: 1 };
    const check = await page.evaluate(input => window.medclaw.request('eval.preflight', input), options);
    expect(check).toMatchObject({ ok: true, data: { cases: 10, plannedTrials: 10, blockers: [] } }); if (!check.ok) throw new Error('ENGINEERING preflight missing');
    const accepted = await page.evaluate(input => window.medclaw.request('eval.start', input.payload, input.operationRef), { payload: { ...options, preflightId: check.data.preflightId }, operationRef });
    expect(accepted).toMatchObject({ ok: true, data: { operationRef, executionId: 'desktop-' + operationRef } });
    await expect.poll(() => existsSync(desktop.preparation)).toBe(true);
    const firstQuit = desktop.requestQuit(); await expect.poll(() => desktop.quitSeen()?.command).toBe(firstQuit);
    await expect.poll(() => existsSync(desktop.stopRequested)).toBe(true);
    const stopping = JSON.parse(readFileSync(desktop.stopRequested, 'utf8')), worker = JSON.parse(readFileSync(desktop.workerReady, 'utf8'));
    expect(stopping).toMatchObject({ pid: worker.pid, cancelRequested: true });
    expect(desktop.exitSeen()).toBeNull(); expect(desktop.child.exitCode).toBeNull(); expect(page.isClosed()).toBe(false);
    expect(await page.evaluate(() => window.medclaw.request('host.read', {}))).toEqual(beforeHost);
    desktop.release();
    if (field === 'controllerExited') await expect.poll(() => existsSync(desktop.workerExitWait)).toBe(true);
    else await expect.poll(() => desktop.evaluation()?.state, { timeout: 40000 }).toBe('unknown');
    const control = desktop.evaluation(); expect(control).toMatchObject({ operationRef, executionId: 'desktop-' + operationRef, controllerExited: false });
    if (field === 'controllerExited') { expect(control).toMatchObject({ stopConfirmed: true, saveConfirmed: true }); expect(existsSync(desktop.workerExitWait)).toBe(true); }
    else expect(control?.[field]).toBeNull();
    expect(desktop.exitSeen()).toBeNull(); expect(desktop.child.exitCode).toBeNull(); expect(desktop.quitSeen()?.count).toBe(1);
    expect(await page.evaluate(() => window.medclaw.request('host.read', {}))).toEqual(beforeHost);
    await expect.poll(async () => {
      const diagnostics = await page.evaluate(() => window.medclaw.request('diagnostics.read', { categories: ['errors'] }));
      return diagnostics.ok && diagnostics.data.entries.some(entry => entry.error?.code === 'host_stop_unconfirmed');
    }, { timeout: 40000 }).toBe(true);
    expect(await page.evaluate(instanceId => window.medclaw.request('host.restart', { expectedInstanceId: instanceId }), beforeHost.data.instanceId))
      .toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    const archive = join(desktop.root, 'evaluation-runs/business/desktop-' + operationRef), reportBytes = readFileSync(join(archive, 'report.json'), 'utf8'), report = JSON.parse(reportBytes);
    expect(report.trials).toHaveLength(10); expect(report.trials.every((trial: { status: string; startedAt: string | null }) => trial.status === 'not_run' && trial.startedAt === null)).toBe(true);
    expect(report.judgeCalls).toEqual([]); expect(desktop.networkRequests()).toBe(0);
    await page.getByRole('button', { name: 'Evaluation', exact: true }).click();
    if (field !== 'controllerExited') {
      const observed = await page.evaluate(input => window.medclaw.request('eval.status', input), { operationRef, executionId: 'desktop-' + operationRef });
      expect(observed).toMatchObject({ ok: true, data: { state: 'unknown', [field]: null } });
      expect(await page.evaluate(instanceId => window.medclaw.request('host.restart', { expectedInstanceId: instanceId }), beforeHost.data.instanceId))
        .toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    }
    desktop.resolveFault();
    if (field === 'controllerExited') await expect.poll(() => desktop.evaluation()?.controllerExited).toBe(true);
    expect(desktop.exitSeen()).toBeNull(); expect(desktop.quitSeen()?.count).toBe(1);
    desktop.requestQuit(); await expect.poll(() => desktop.child.exitCode, { timeout: 15000 }).toBe(0);
    expect(desktop.exitSeen()?.code).toBe(0); expect(desktop.host()).toMatchObject({ instanceId: beforeHost.data.instanceId, state: 'stopped', canStart: true,
      shutdown: { executionStopped: true, requiredPersistenceComplete: true, databaseClosed: true, processExited: true, processTreeStopped: true } });
    expect(desktop.evaluation()).toMatchObject({ stopConfirmed: true, saveConfirmed: true, controllerExited: true });
    expect(readFileSync(join(archive, 'report.json'), 'utf8')).toBe(reportBytes); expect(desktop.networkRequests()).toBe(0); expect(readStartupFacts(desktop.dataRoot)).toMatchObject({ runs: 0, calls: 0 });
  } finally { await desktop.dispose(); }
});

for (const phase of ['before publication', 'after publication'] as const) for (const timedOut of [false, true]) test('P17 actual Main waits for destination copy ' + phase + ' and preserves its original outcome' + (timedOut ? ' after Host timeout' : ''), async ({}) => {
  test.setTimeout(90000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'MedClaw 复制退出-'))), dataRoot = join(root, '用户 数据'), destination = join(root, '交付 目录');
  const target = join(destination, '原查询.json'), observer = join(root, 'main-observer.cjs'), entered = join(root, 'copy-entered.json'), release = join(root, 'release-copy');
  const settling = join(root, 'settle-copy.json'), hostNotice = join(root, 'host-notice.json'), exitSeen = join(root, 'main-exit.json');
  console.log('P17_MAIN_COPY_ROOT ' + root);
  mkdirSync(join(dataRoot, 'data'), { recursive: true }); mkdirSync(destination);
  const queryId = Number(execFileSync(bunExecutable, ['--no-env-file', '-e', `
    import{openDatabase}from${JSON.stringify(resolve('packages/storage/src/database.ts'))};
    import{Repositories}from${JSON.stringify(resolve('packages/storage/src/repositories.ts'))};
    import{SqliteMemoryStore}from${JSON.stringify(resolve('packages/storage/src/memory-store.ts'))};
    import{validateNativeHistory}from${JSON.stringify(resolve('packages/runtime-pi/src/memory-store.ts'))};
    import{memoryNativeFixture}from${JSON.stringify(resolve('tests/fixtures/p9-memory.ts'))};
    import{seedWorkspaceQueries}from${JSON.stringify(resolve('tests/fixtures/p7-workspace.ts'))};
    const db=openDatabase(${JSON.stringify(join(dataRoot, 'data/app.sqlite'))});
    if(db.query("SELECT name FROM pragma_table_info('queries') WHERE name='params_hash'").get())throw new Error('ENGINEERING current schema required');
    const repo=new Repositories(db),memory=new SqliteMemoryStore(db,validateNativeHistory),native=memoryNativeFixture();
    const session=repo.createSession({expectedWorkspaceRevision:0},'create',native.header.id,'2026-10-17T00:00:00.000Z',{header:native.header,entries:[],activeLeafId:null}).session;
    const saved=await memory.commit({sessionId:session.id,runId:null,expectedStorageVersion:1,header:native.header,newEntries:native.entries,activeLeafId:native.activeLeafId});if(!saved.ok)throw saved.error;
    const query=seedWorkspaceQueries(db,repo).current;
    db.query('UPDATE runs SET cleanup_json=? WHERE id=?').run(JSON.stringify({contract:'medclaw.run-cleanup/v1',executionStarted:false,stopConfirmed:true,requiredPersistenceComplete:true,
      inputsSettled:true,resourcesReleased:true,unconfirmedItems:[],secondaryErrors:[],verifiedAt:'2026-10-17T00:00:00.000Z'}),query.runId);
    process.stdout.write(String(query.id));db.close();`], { encoding: 'utf8', windowsHide: true }));
  expect(Number.isSafeInteger(queryId) && queryId > 0).toBe(true);
  const operationRef = crypto.randomUUID(), published = phase === 'after publication';
  // Pause only this copy's original I/O; publication, verification, protocol and shutdown remain real.
  writeFileSync(observer, `module.exports=({app,dialog})=>{
    const fs=require('fs'),files=require('node:fs/promises'),paths=require('path'),cp=require('child_process'),spawn=cp.spawn,open=files.open;
    const pause=async path=>{fs.writeFileSync(${JSON.stringify(entered)},JSON.stringify({path,pid:process.pid}));
      const deadline=Date.now()+60000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)throw new Error('ENGINEERING copy I/O gate expired');await new Promise(done=>setTimeout(done,10));}};
    files.open=async function(...args){const path=String(args[0]);
      if(${published}&&path===${JSON.stringify(target)}&&args[1]==='r'&&!fs.existsSync(${JSON.stringify(entered)}))await pause(path);
      const file=await Reflect.apply(open,this,args);
      if(!${published}&&args[1]==='wx'&&paths.dirname(path)===${JSON.stringify(destination)}&&paths.basename(path).endsWith('.tmp')){
        const sync=file.sync.bind(file);file.sync=async()=>{await pause(path);return sync();};}return file;};
    cp.spawn=function(...args){const child=Reflect.apply(spawn,this,args);
      if(args[0]===${JSON.stringify(bunExecutable)}&&args[1]?.includes(${JSON.stringify(resolve('apps/host/src/main.ts'))})){
        let buffer='';child.stdout.on('data',chunk=>{buffer+=chunk.toString();let end;while((end=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
          try{const frame=JSON.parse(line);if(frame.kind==='private'&&frame.method==='export.destination.settlePrevious'&&fs.existsSync(${JSON.stringify(entered)}))
            fs.writeFileSync(${JSON.stringify(settling)},JSON.stringify({instanceId:frame.instanceId,requestId:frame.requestId,pid:child.pid}));}catch{}}});}return child;};
    dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(target)}});
    app.on('browser-window-created',(_,window)=>{const send=window.webContents.send.bind(window.webContents);window.webContents.send=(channel,...args)=>{
      if(channel==='medclaw:notice'&&args[0]?.type==='host.status')fs.writeFileSync(${JSON.stringify(hostNotice)},JSON.stringify(args[0].host));return send(channel,...args);};});
    const exit=app.exit.bind(app);app.exit=code=>{fs.writeFileSync(${JSON.stringify(exitSeen)},JSON.stringify({code:code??0,pid:process.pid}));return exit(code);};};`);
  const original = () => JSON.parse(execFileSync(bunExecutable, ['--no-env-file', '-e', `import{Database}from'bun:sqlite';
    import{SqliteExportStore}from${JSON.stringify(resolve('packages/storage/src/export-store.ts'))};
    const db=new Database(${JSON.stringify(join(dataRoot, 'data/app.sqlite'))},{readonly:true});
    console.log(JSON.stringify({operation:new SqliteExportStore(db).find(${JSON.stringify(operationRef)}),runs:db.query('SELECT * FROM runs ORDER BY id').all(),
      queries:db.query('SELECT * FROM queries ORDER BY id').all(),evidence:db.query('SELECT * FROM query_evidence ORDER BY id').all(),
      memories:db.query('SELECT * FROM memories ORDER BY id').all(),calls:db.query('SELECT count(*) n FROM model_calls').get().n,exports:db.query('SELECT count(*) n FROM exports').get().n}));db.close();`],
    { encoding: 'utf8', windowsHide: true })) as { operation: StoredExport | null; runs: unknown[]; queries: unknown[]; evidence: unknown[]; memories: unknown[]; calls: number; exports: number };
  let desktop: Awaited<ReturnType<typeof launchActualDev>> | undefined, failed = false, stopped = false, expectedExitCode = 0;
  try {
    const running = await launchActualDev(root, dataRoot, undefined, undefined, undefined, observer); desktop = running;
    const { page } = running; await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const oldHost = await page.evaluate(() => window.medclaw.request('host.read', {}));
    if (!oldHost.ok || !oldHost.data.instanceId) throw new Error('ENGINEERING Host unavailable');
    const before = original(); expect(before.operation).toBeNull(); expect(before.calls).toBe(0);
    const accepted = await page.evaluate(async source => {
      const selected = await window.medclaw.chooseExportDestination(source); if (!selected.ok || !selected.data) throw new Error('ENGINEERING destination unavailable');
      return window.medclaw.request('export.create', { ...source, destinationToken: selected.data.destinationToken }, source.operationRef);
    }, { operationRef, queryId, answerId: null, format: 'json' as const });
    expect(accepted.ok).toBe(true);
    await expect.poll(() => existsSync(entered)).toBe(true);
    const copying = original().operation; expect(copying).toMatchObject({ operationRef, queryId, state: 'copying', copyState: 'copying', copyReceipt: null });
    if (!copying?.artifact) throw new Error('ENGINEERING managed Artifact missing');
    const managedPath = join(dataRoot, copying.artifact.relativePath, 'result.json'), managed = readFileSync(managedPath);
    const proofPath = join(dataRoot, 'runtime/export-copies', copying.id + '.json');
    expect(existsSync(proofPath)).toBe(false); expect(existsSync(target)).toBe(published);
    if (published) expect(readFileSync(target)).toEqual(managed);
    writeFileSync(join(root, 'request-dev-quit'), 'ENGINEERING actual Main quit');
    expectedExitCode = timedOut ? 1 : 0;
    await expect.poll(() => existsSync(settling)).toBe(true);
    expect(JSON.parse(readFileSync(settling, 'utf8')).instanceId).toBe(oldHost.data.instanceId);
    expect(HostViewSchema.parse(JSON.parse(readFileSync(hostNotice, 'utf8'))).state).toBe('stopping');
    const blocked = await page.evaluate(async () => {
      const ui = await window.medclaw.request('settings.ui.read', {}); if (!ui.ok) throw new Error(ui.error.code);
      return window.medclaw.request('settings.ui.update', { expectedConfigVersion: ui.data.configVersion, patch: { navCollapsed: !ui.data.ui.navCollapsed } });
    });
    expect(blocked).toMatchObject({ ok: false, error: { code: 'maintenance_busy' } });
    expect(running.child.exitCode).toBeNull(); expect(existsSync(exitSeen)).toBe(false); expect(page.isClosed()).toBe(false);
    expect(original().operation).toEqual(copying); expect(existsSync(proofPath)).toBe(false);
    if (timedOut) {
      await expect.poll(() => HostViewSchema.parse(JSON.parse(readFileSync(hostNotice, 'utf8'))), { timeout: 30000 }).toMatchObject({
        instanceId: oldHost.data.instanceId, state: 'failed', canStart: true,
        shutdown: { executionStopped: null, requiredPersistenceComplete: null, databaseClosed: null, processExited: true, processTreeStopped: true, error: { code: 'operation_result_unknown' } } });
      expect(running.child.exitCode).toBeNull(); expect(existsSync(exitSeen)).toBe(false); expect(page.isClosed()).toBe(false);
      expect(await page.evaluate(expectedInstanceId => window.medclaw.request('host.restart', { expectedInstanceId }), oldHost.data.instanceId))
        .toMatchObject({ ok: false, error: { code: 'maintenance_busy' } });
      expect(original().operation).toEqual(copying); expect(existsSync(proofPath)).toBe(false);
    }
    writeFileSync(release, 'ENGINEERING resume original I/O');
    await expect.poll(() => running.child.exitCode, { timeout: 30000 }).toBe(expectedExitCode);
    expect(JSON.parse(readFileSync(exitSeen, 'utf8')).code).toBe(expectedExitCode);
    if (!timedOut) expect(HostViewSchema.parse(JSON.parse(readFileSync(hostNotice, 'utf8')))).toMatchObject({ instanceId: oldHost.data.instanceId, state: 'stopped', canStart: true,
      shutdown: { executionStopped: true, requiredPersistenceComplete: true, databaseClosed: true, processExited: true, processTreeStopped: true, error: null } });
    await running.close(expectedExitCode); desktop = undefined; stopped = true;
    const after = original(); expect(after.runs).toEqual(before.runs); expect(after.queries).toEqual(before.queries);
    expect(after.evidence).toEqual(before.evidence); expect(after.memories).toEqual(before.memories); expect(after.calls).toBe(0);
    expect(readFileSync(managedPath)).toEqual(managed);
    expect(after.exports).toBe(1);
    if (timedOut) expect(after.operation).toEqual(copying);
    else expect(after.operation).toMatchObject({ operationRef, queryId, state: published ? 'completed' : 'cancelled', copyState: published ? 'verified' : 'unknown', error: null });
    if (published) {
      expect(readFileSync(target)).toEqual(managed); expect(readdirSync(destination)).toEqual(['原查询.json']);
      const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
      const receipt = ExportCopyReceiptSchema.parse(proof.receipt);
      if (timedOut) expect(after.operation!.copyReceipt).toBeNull(); else expect(receipt).toEqual(after.operation!.copyReceipt);
      expect(proof.receipt).toMatchObject({ operationRef, exportId: copying.id, artifactId: copying.artifact.id, files: [{ name: 'result.json', bytes: managed.length }] });
    } else { expect(readdirSync(destination)).toEqual([]); expect(existsSync(proofPath)).toBe(false); expect(after.operation!.copyReceipt).toBeNull(); }
    if (timedOut) {
      const external = readdirSync(destination), proof = published ? readFileSync(proofPath) : null;
      const reopened = await launchActualDev(join(root, '重开'), dataRoot); desktop = reopened; stopped = false; expectedExitCode = 0;
      await expect(reopened.page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
      const currentHost = await reopened.page.evaluate(() => window.medclaw.request('host.read', {}));
      if (!currentHost.ok || !currentHost.data.instanceId) throw new Error('ENGINEERING reopened Host unavailable');
      expect(currentHost.data.instanceId).not.toBe(oldHost.data.instanceId);
      expect(await reopened.page.evaluate(operationRef => window.medclaw.request('export.read', { operationRef }), operationRef))
        .toMatchObject({ ok: true, data: { operationRef, queryId, state: 'interrupted', copyState: 'unknown', error: { code: 'host_interrupted' } } });
      const recovered = original(); expect(recovered.exports).toBe(1); expect(recovered.calls).toBe(0); expect(recovered.operation!.copyReceipt).toBeNull();
      expect(recovered.runs).toEqual(before.runs); expect(recovered.queries).toEqual(before.queries); expect(recovered.evidence).toEqual(before.evidence); expect(recovered.memories).toEqual(before.memories);
      expect(readFileSync(managedPath)).toEqual(managed); expect(readdirSync(destination)).toEqual(external);
      if (published) { expect(readFileSync(target)).toEqual(managed); expect(readFileSync(proofPath)).toEqual(proof); }
      else expect(existsSync(proofPath)).toBe(false);
      await reopened.close(); desktop = undefined; stopped = true;
    }
  } catch (error) { failed = true; throw error; }
  finally {
    writeFileSync(release, 'ENGINEERING cleanup releases only owned I/O');
    try { if (desktop) { await desktop.close(expectedExitCode); stopped = true; } }
    catch (error) { console.log('P17_MAIN_COPY_CLEANUP_UNCONFIRMED ' + root); if (!failed) { failed = true; throw error; } }
    finally {
      const resolved = resolve(root), temporary = realpathSync(tmpdir()), within = relative(temporary, resolved);
      if (!timedOut && !failed && stopped && existsSync(join(root, 'dev-exit-confirmed')) && within && within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within)) rmSync(resolved, { recursive: true, force: true });
      else console.log('P17_MAIN_COPY_ROOT_RETAINED ' + root);
    }
  }
});

for (const kind of ['create', 'restore'] as const) test('P17 actual Main retains its window while the original backup ' + kind + ' worker stop is unconfirmed', async ({}) => {
  test.setTimeout(120000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'MedClaw 维护拒退-'))), dataRoot = join(root, '用户 数据'), destination = join(root, '备份'), restoreParent = join(root, '恢复');
  mkdirSync(destination); mkdirSync(restoreParent);
  const operationRef = crypto.randomUUID(), seedRef = crypto.randomUUID(), seedRoot = join(destination, 'MedClaw-backup-' + seedRef), action = 'backup.' + kind;
  const observer = join(root, 'main-observer.cjs'), maintenanceEntry = resolve('apps/host/src/maintenance.ts');
  const capturePath = join(root, 'worker-captured.json'), endPath = join(root, 'worker-end-refused.json'), killPath = join(root, 'worker-kill-refused.json'), closedPath = join(root, 'worker-closed.json');
  const releasePath = join(root, 'release-worker'), probePath = join(root, 'probe-command'), probeSeen = join(root, 'probe-observed.json');
  const quitPath = join(root, 'quit-command'), quitSeen = join(root, 'quit-observed.json'), exitSeen = join(root, 'main-exit.json'), hostNotice = join(root, 'host-notice.json');
  writeFileSync(observer, `module.exports=({app,dialog})=>{
    const fs=require('fs'),cp=require('node:child_process'),spawn=cp.spawn;let captured=null,lastQuit='',lastProbe='',quitCount=0,held=0,released=false;
    dialog.showOpenDialog=async(_,options)=>{const title=options?.title;
      let path=null;if(title==='Choose a backup destination directory')path=${JSON.stringify(destination)};
      else if(title==='Choose a completed MedClaw backup'||title==='Choose a backup or restored data directory')path=${JSON.stringify(seedRoot)};
      else if(title==='Choose the parent directory for a new restored data folder')path=${JSON.stringify(restoreParent)};
      return{canceled:path===null,filePaths:path?[path]:[]};};
    cp.spawn=function(file,args,options){const child=spawn.call(this,file,args,options);
      if(file!==${JSON.stringify(bunExecutable)}||!Array.isArray(args)||args[0]!=='--no-env-file'||args[1]!==${JSON.stringify(maintenanceEntry)}||!options?.env?.MEDCLAW_MAINTENANCE_INSTANCE)return child;
      const write=child.stdin.write.bind(child.stdin),end=child.stdin.end.bind(child.stdin),kill=child.kill.bind(child);
      child.stdin.write=function(chunk,...rest){let request;try{request=JSON.parse(String(chunk));}catch{return write(chunk,...rest);}
        if(request.protocolVersion!=='medclaw.maintenance/v1'||request.workerInstanceId!==options.env.MEDCLAW_MAINTENANCE_INSTANCE||request.operationRef!==${JSON.stringify(operationRef)}
          ||request.input?.action!==${JSON.stringify(action)}||request.input.sourceRoot!==${JSON.stringify(dataRoot)})return write(chunk,...rest);
        captured={child,end,kill,instanceId:request.workerInstanceId};
        fs.writeFileSync(${JSON.stringify(capturePath)},JSON.stringify({pid:child.pid,instanceId:request.workerInstanceId,requestId:request.requestId,operationRef:request.operationRef,action:request.input.action,held:++held,delivered:false}));
        child.stdin.end=function(){fs.writeFileSync(${JSON.stringify(endPath)},JSON.stringify({pid:child.pid,instanceId:request.workerInstanceId}));return child.stdin;};
        child.kill=function(){fs.writeFileSync(${JSON.stringify(killPath)},JSON.stringify({pid:child.pid,instanceId:request.workerInstanceId,refused:true}));return false;};
        child.once('close',(code,signal)=>fs.writeFileSync(${JSON.stringify(closedPath)},JSON.stringify({pid:child.pid,instanceId:request.workerInstanceId,code,signal})));
        return true;};return child;};
    const read=path=>fs.existsSync(path)?fs.readFileSync(path,'utf8'):'';
    const timer=setInterval(()=>{const probe=read(${JSON.stringify(probePath)});if(probe&&probe!==lastProbe){lastProbe=probe;let alive=false;
        if(captured&&captured.child.exitCode===null&&captured.child.signalCode===null){try{process.kill(captured.child.pid,0);alive=true;}catch{}}
        fs.writeFileSync(${JSON.stringify(probeSeen)},JSON.stringify({nonce:probe,pid:captured?.child.pid,instanceId:captured?.instanceId,alive}));}
      if(captured&&!released&&fs.existsSync(${JSON.stringify(releasePath)})){released=true;captured.child.stdin.end=captured.end;captured.child.kill=captured.kill;captured.end();}
      const command=read(${JSON.stringify(quitPath)});if(command&&command!==lastQuit){lastQuit=command;app.quit();}},10);timer.unref();
    app.on('before-quit',()=>fs.writeFileSync(${JSON.stringify(quitSeen)},JSON.stringify({count:++quitCount,command:lastQuit,pid:process.pid})));
    app.on('browser-window-created',(_,window)=>{const send=window.webContents.send.bind(window.webContents);window.webContents.send=(channel,...args)=>{
      if(channel==='medclaw:notice'&&args[0]?.type==='host.status')fs.writeFileSync(${JSON.stringify(hostNotice)},JSON.stringify(args[0].host));return send(channel,...args);};});
    const exit=app.exit.bind(app);app.exit=code=>{fs.writeFileSync(${JSON.stringify(exitSeen)},JSON.stringify({code:code??0,pid:process.pid}));return exit(code);};
  };`);
  const observed = (path: string): Record<string, unknown> | null => { try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return null; } };
  const requestQuit = () => { const nonce = crypto.randomUUID(); writeFileSync(quitPath, nonce); return nonce; };
  let desktop: Awaited<ReturnType<typeof launchActualDev>> | undefined, pending: Promise<unknown> | undefined, failed = false;
  try {
    const running = await launchActualDev(root, dataRoot, undefined, undefined, undefined, observer); desktop = running;
    const { page } = running;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const beforeHost = await page.evaluate(() => window.medclaw.request('host.read', {})), ui = await page.evaluate(() => window.medclaw.request('settings.ui.read', {}));
    if (!beforeHost.ok || !beforeHost.data.instanceId || !ui.ok) throw new Error('ENGINEERING original Main state unavailable');
    const settings = readFileSync(join(dataRoot, 'data/settings.json'), 'utf8'), before = readStartupFacts(dataRoot);
    let seedReceipt: unknown;
    if (kind === 'restore') {
      const seed = await page.evaluate(operationRef => window.medclaw.request('backup.select', { purpose: 'create' }, operationRef), seedRef);
      if (!seed.ok || !seed.data?.destinationToken) throw new Error('ENGINEERING seed backup authorization unavailable');
      const saved = await page.evaluate(input => window.medclaw.request('backup.create', input.payload, input.operationRef), { payload: { destinationToken: seed.data.destinationToken }, operationRef: seedRef });
      expect(saved).toMatchObject({ ok: true, data: { operationRef: seedRef, kind: 'create' } }); if (!saved.ok) throw new Error('ENGINEERING seed backup unavailable'); seedReceipt = saved.data;
    }
    const selection = await page.evaluate(input => window.medclaw.request('backup.select', input.payload, input.operationRef), { payload: { purpose: kind }, operationRef });
    if (!selection.ok || !selection.data) throw new Error('ENGINEERING original maintenance authorization unavailable');
    if (kind === 'create') {
      if (!selection.data.destinationToken) throw new Error('ENGINEERING backup destination token missing');
      pending = page.evaluate(input => window.medclaw.request('backup.create', input.payload, input.operationRef), { payload: { destinationToken: selection.data.destinationToken }, operationRef });
    } else {
      if (!selection.data.sourceToken || !selection.data.targetRootToken) throw new Error('ENGINEERING restore tokens missing');
      pending = page.evaluate(input => window.medclaw.request('backup.restore', input.payload, input.operationRef), { payload: { sourceToken: selection.data.sourceToken, targetRootToken: selection.data.targetRootToken }, operationRef });
    }
    void pending.catch(() => {});
    await expect.poll(() => observed(capturePath)).not.toBeNull(); const captured = observed(capturePath)!;
    expect(captured).toMatchObject({ pid: expect.any(Number), instanceId: expect.any(String), requestId: expect.any(String), operationRef, action, held: 1, delivered: false });
    expect(await page.evaluate(() => window.medclaw.request('host.read', {}))).toMatchObject({ ok: true, data: { instanceId: beforeHost.data.instanceId, state: 'stopped', canStart: true } });
    const firstQuit = requestQuit(); await expect.poll(() => observed(quitSeen)?.command).toBe(firstQuit);
    await expect.poll(() => observed(endPath)).toMatchObject({ pid: captured.pid, instanceId: captured.instanceId });
    await expect.poll(() => observed(killPath), { timeout: 15000 }).toMatchObject({ pid: captured.pid, instanceId: captured.instanceId, refused: true });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'host_stop_unconfirmed', operationRef } });
    const probe = crypto.randomUUID(); writeFileSync(probePath, probe); await expect.poll(() => observed(probeSeen)?.nonce).toBe(probe);
    expect(observed(probeSeen)).toMatchObject({ pid: captured.pid, instanceId: captured.instanceId, alive: true }); expect(observed(closedPath)).toBeNull();
    expect(observed(exitSeen)).toBeNull(); expect(running.child.exitCode).toBeNull(); expect(page.isClosed()).toBe(false); expect(observed(quitSeen)?.count).toBe(1);
    const errors = await page.evaluate(() => window.medclaw.request('diagnostics.read', { categories: ['errors'] }));
    expect(errors.ok && errors.data.entries.some(entry => entry.error?.code === 'host_stop_unconfirmed')).toBe(true);
    expect(await page.evaluate(input => window.medclaw.request('settings.ui.update', input), { expectedConfigVersion: ui.data.configVersion, patch: { navCollapsed: !ui.data.ui.navCollapsed } }))
      .toMatchObject({ ok: false, error: { code: 'maintenance_busy' } });
    expect(await page.evaluate(instanceId => window.medclaw.request('host.restart', { expectedInstanceId: instanceId }), beforeHost.data.instanceId))
      .toMatchObject({ ok: false, error: { code: 'maintenance_busy' } });
    if (kind === 'restore') {
      const original = await page.evaluate(() => window.medclaw.request('backup.select', { purpose: 'read' }));
      if (!original.ok || !original.data?.resultToken || original.data.originalOperationRef !== seedRef) throw new Error('ENGINEERING original backup read authorization unavailable');
      expect(await page.evaluate(input => window.medclaw.request('backup.read', input.payload, input.operationRef), { payload: { resultToken: original.data.resultToken, kind: 'create' as const }, operationRef: seedRef }))
        .toEqual({ ok: true, data: seedReceipt });
      expect(await page.evaluate(instanceId => window.medclaw.request('host.restart', { expectedInstanceId: instanceId }), beforeHost.data.instanceId))
        .toMatchObject({ ok: false, error: { code: 'maintenance_busy' } });
    }
    expect(readFileSync(join(dataRoot, 'data/settings.json'), 'utf8')).toBe(settings);
    expect(readStartupFacts(dataRoot)).toMatchObject({ workspace: before.workspace, sessions: before.sessions, runs: 0, calls: 0 });
    expect(readdirSync(destination)).toEqual(kind === 'restore' ? ['MedClaw-backup-' + seedRef] : []); expect(readdirSync(restoreParent)).toEqual([]);
    expect(existsSync(join(dataRoot, 'launch.json'))).toBe(false);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    writeFileSync(releasePath, 'ENGINEERING restore original child stdin end after explicit resolution');
    await expect.poll(() => observed(closedPath)).toMatchObject({ pid: captured.pid, instanceId: captured.instanceId, code: 1, signal: null });
    expect(observed(exitSeen)).toBeNull(); expect(observed(quitSeen)?.count).toBe(1); expect(running.child.exitCode).toBeNull();
    requestQuit(); await expect.poll(() => running.child.exitCode, { timeout: 15000 }).toBe(0);
    expect(observed(exitSeen)?.code).toBe(0);
    expect(HostViewSchema.parse(observed(hostNotice))).toMatchObject({ instanceId: beforeHost.data.instanceId, state: 'stopped', canStart: true,
      shutdown: { executionStopped: true, requiredPersistenceComplete: true, databaseClosed: true, processExited: true, processTreeStopped: true } });
    expect(observed(capturePath)?.held).toBe(1); expect(readdirSync(restoreParent)).toEqual([]);
    await running.close(); desktop = undefined; expect(existsSync(join(root, 'dev-exit-confirmed'))).toBe(true);
  } catch (error) { failed = true; throw error; }
  finally {
    writeFileSync(releasePath, 'ENGINEERING restore original child stdin end for cleanup');
    try { if (desktop) { requestQuit(); await desktop.close(); } }
    catch (error) { if (!failed) throw error; console.log('P17_MAIN_MAINTENANCE_CLEANUP_UNCONFIRMED'); }
    finally { console.log('P17_MAIN_MAINTENANCE_UNKNOWN_ROOT_RETAINED ' + root); }
  }
});

test('P17 actual Main exits with failure after SDK cancellation cannot save its final facts and retains the original root', async ({}) => {
  test.setTimeout(120000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'MedClaw 保存失败-'))), dataRoot = join(root, '用户 数据');
  const observer = join(root, 'main-observer.cjs'), hostEntry = join(root, 'host-entry.ts'), fault = join(root, 'fail-final-save');
  const failedSave = join(root, 'failed-save.json'), hostNotice = join(root, 'host-notice.json'), exitSeen = join(root, 'main-exit.json');
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const settingsPath = join(dataRoot, 'data/settings.json'), settings = new MainSettings(settingsPath).read();
  if (settings.intentModel?.enabled) writeFileSync(settingsPath, JSON.stringify({ ...settings, intentModel: { ...settings.intentModel, enabled: false } }));
  writeFileSync(hostEntry, `import{existsSync,writeFileSync}from'node:fs';
    import{Repositories}from${JSON.stringify(resolve('packages/storage/src/repositories.ts'))};
    import{safeError}from${JSON.stringify(resolve('packages/contracts/src/error.ts'))};
    const finalize=Repositories.prototype.finalizeAgent;
    Repositories.prototype.finalizeAgent=function(runId,...args){if(existsSync(${JSON.stringify(fault)})){
      writeFileSync(${JSON.stringify(failedSave)},JSON.stringify({runId,pid:process.pid}));throw safeError('storage_write_failed');}return finalize.call(this,runId,...args);};
    await import(${JSON.stringify(resolve('apps/host/src/main.ts'))});`);
  writeFileSync(observer, `module.exports=({app})=>{const fs=require('fs');
    app.on('browser-window-created',(_,window)=>{const send=window.webContents.send.bind(window.webContents);window.webContents.send=(channel,...args)=>{
      if(channel==='medclaw:notice'&&args[0]?.type==='host.status')fs.writeFileSync(${JSON.stringify(hostNotice)},JSON.stringify(args[0].host));return send(channel,...args);};});
    const exit=app.exit.bind(app);app.exit=code=>{fs.writeFileSync(${JSON.stringify(exitSeen)},JSON.stringify({code:code??0,pid:process.pid}));return exit(code);};};`);
  const requests: unknown[] = [], streams = new Set<ServerResponse>(); let hold = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) { response.writeHead(404); response.end(); return; }
      let body = ''; for await (const chunk of request) body += chunk; requests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ id: 'p17-save-' + requests.length, model: 'fixture', choices: [{ index: 0,
        delta: { role: 'assistant', content: hold ? 'ENGINEERING transient' : 'ENGINEERING saved answer' }, finish_reason: null }] }) + '\n\n');
      if (hold) { streams.add(response); response.once('close', () => streams.delete(response)); }
      else response.end('data: ' + JSON.stringify({ id: 'p17-save-' + requests.length, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } catch { response.destroy(); }
  });
  const saved = () => JSON.parse(execFileSync(bunExecutable, ['--no-env-file', '-e', `import{Database}from'bun:sqlite';
    const db=new Database(${JSON.stringify(join(dataRoot, 'data/app.sqlite'))},{readonly:true});
    console.log(JSON.stringify({runs:db.query('SELECT id,status FROM runs ORDER BY id').all(),memories:db.query('SELECT * FROM memories ORDER BY id').all(),
      answers:db.query('SELECT * FROM answers ORDER BY id').all()}));db.close();`], { encoding: 'utf8', windowsHide: true })) as { runs: { id: number; status: string }[]; memories: unknown[]; answers: unknown[] };
  let desktop: Awaited<ReturnType<typeof launchActualDev>> | undefined, failed = false;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const running = await launchActualDev(root, dataRoot, undefined, undefined, hostEntry, observer); desktop = running;
    const { page } = running;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const oldHost = await page.evaluate(() => window.medclaw.request('host.read', {}));
    if (!oldHost.ok || !oldHost.data.instanceId) throw new Error('ENGINEERING original Host unavailable');
    const configured = await page.evaluate(async baseUrl => {
      const directory = await window.medclaw.request('model.read', {}); if (!directory.ok) throw new Error(directory.error.code);
      const token = await window.medclaw.secretInput({ providerId: 'p17-save-fixture', purpose: 'custom_api_key', value: 'LOCAL-FIXTURE-ONLY' }); if (!token.ok) throw new Error(token.error.code);
      const value = await window.medclaw.request('model.custom.save', { expectedConfigVersion: directory.data.configVersion, credentialInput: token.data.token,
        definition: { providerId: 'p17-save-fixture', name: 'P17 save fixture', api: 'openai-completions', baseUrl,
          models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] } });
      if (!value.ok) throw new Error(value.error.code);
      return window.medclaw.request('model.configure', { provider: 'p17-save-fixture', modelId: 'fixture', expectedConfigVersion: value.data.configVersion });
    }, 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1');
    expect(configured.ok).toBe(true); expect(requests).toHaveLength(0);
    await page.getByRole('button', { name: 'New Session', exact: true }).click();
    const submit = (text: string) => page.evaluate(async input => {
      const w = await window.medclaw.request('workspace.read', {}), model = await window.medclaw.request('model.read', {});
      if (!w.ok || !w.data.sessionId || !model.ok) throw new Error('ENGINEERING submission source unavailable');
      const d = await window.medclaw.request('session.read', { sessionId: w.data.sessionId }); if (!d.ok || !d.data) throw new Error('ENGINEERING Session unavailable');
      return window.medclaw.request('session.submit', { sessionId: w.data.sessionId, clientSequence: d.data.session.nextSubmissionSequence,
        text: input.text, mode: 'send', expectedRevision: w.data.revision, expectedBatchIds: [], expectedQueryId: null,
        model: { provider: 'p17-save-fixture', modelId: 'fixture', expectedConfigVersion: model.data.configVersion }, referenceDate: '2026-10-17', timezone: 'Asia/Shanghai' }, input.operationRef);
    }, { text, operationRef: crypto.randomUUID() });
    const first = await submit('ENGINEERING original saved turn');
    expect(first).toMatchObject({ ok: true }); if (!first.ok || first.data.runId === null) throw new Error('ENGINEERING first Run missing');
    await expect.poll(() => page.evaluate(async () => { const value = await window.medclaw.request('run.control.read', {}); return value.ok && value.data.acceptingNewRuns; })).toBe(true);
    const committed = saved(); expect(committed.runs).toEqual([{ id: first.data.runId, status: 'completed' }]); expect(committed.memories.length).toBeGreaterThan(0); expect(committed.answers).toHaveLength(1);
    hold = true; const second = await submit('ENGINEERING interrupted final save');
    expect(second).toMatchObject({ ok: true }); if (!second.ok || second.data.runId === null) throw new Error('ENGINEERING active Run missing');
    await expect.poll(() => requests.length).toBe(2); await expect.poll(() => streams.size).toBe(1);
    const before = saved(); expect(before.memories).toEqual(expect.arrayContaining(committed.memories)); expect(before.memories.length).toBeGreaterThan(committed.memories.length);
    expect(before.answers).toEqual(committed.answers);
    expect(before.runs).toEqual([{ id: first.data.runId, status: 'completed' }, { id: second.data.runId, status: 'running' }]);
    writeFileSync(fault, 'ENGINEERING reject final transaction before any write');
    writeFileSync(join(root, 'request-dev-quit'), 'ENGINEERING actual Main quit');
    await expect.poll(() => existsSync(failedSave)).toBe(true);
    expect(JSON.parse(readFileSync(failedSave, 'utf8')).runId).toBe(second.data.runId);
    await expect.poll(() => streams.size).toBe(0);
    await expect.poll(() => running.child.exitCode, { timeout: 30000 }).toBe(1);
    expect(JSON.parse(readFileSync(exitSeen, 'utf8')).code).toBe(1);
    const stopped = HostViewSchema.parse(JSON.parse(readFileSync(hostNotice, 'utf8')));
    expect(stopped).toMatchObject({ instanceId: oldHost.data.instanceId, state: 'failed', canStart: true,
      shutdown: { executionStopped: null, requiredPersistenceComplete: null, databaseClosed: null, processExited: true, processTreeStopped: true, error: { code: 'storage_write_failed' } } });
    expect(saved()).toEqual(before); expect(requests).toHaveLength(2);
    await running.close(1); desktop = undefined;
    expect(existsSync(join(root, 'dev-exit-confirmed'))).toBe(true);
  } catch (error) { failed = true; throw error; }
  finally {
    try {
      if (desktop) {
        let code = existsSync(fault) ? 1 : 0;
        if (existsSync(exitSeen)) code = JSON.parse(readFileSync(exitSeen, 'utf8')).code;
        await desktop.close(code);
      }
    }
    catch (error) { if (!failed) throw error; console.log('P17_MAIN_SAVE_FAILURE_CLEANUP_UNCONFIRMED'); }
    finally {
      for (const response of streams) response.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      // Unknown required persistence keeps the sole original data, including its nonterminal Run.
      console.log('P17_MAIN_SAVE_FAILURE_ROOT_RETAINED ' + root);
    }
  }
});

type TrialProofField = 'stopped' | 'closed' | 'processExited' | 'processTreeStopped' | 'requiredPersistenceComplete';

async function unknownTrialFixture(field: TrialProofField) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'MedClaw Trial未知-'))), dataRoot = join(root, '用户 数据');
  const operationRef = crypto.randomUUID(), executionId = 'desktop-' + operationRef, runsRoot = join(root, 'evaluation-runs/business');
  console.log('P17_TRIAL_UNKNOWN_ROOT_RETAINED ' + root);
  const runner = join(root, 'prepare-runner.ts'), packetPath = join(root, 'prepared.json'), physicalPath = join(root, 'physical-stop.json');
  const observer = join(root, 'unknown-observer.cjs'), worker = join(root, 'unknown-worker.ts'), command = join(root, 'main-command.json');
  const hostNotice = join(root, 'host-notice.json'), evaluationNotice = join(root, 'evaluation-notice.json'), quitSeen = join(root, 'quit-seen.json');
  const exitSeen = join(root, 'exit-seen.json'), workerSeen = join(root, 'worker-seen.json'), workerClosed = join(root, 'worker-closed.json');
  const forced = join(root, 'forced-exit.json'), forceError = join(root, 'force-error'), network = join(root, 'worker-network');
  const originalWorker = resolve('agent-eval/src/desktop/controller.ts');
  writeFileSync(runner, `import{mkdirSync,writeFileSync,readFileSync}from'node:fs';import{join}from'node:path';import{Database}from'bun:sqlite';
    import{loadDataset}from${JSON.stringify(resolve('agent-eval/src/datasets.ts'))};
    import{runExperiment}from${JSON.stringify(resolve('agent-eval/src/execution/runner.ts'))};
    import{ProductAdapter}from${JSON.stringify(resolve('agent-eval/src/adapters/product.ts'))};
    const root=${JSON.stringify(root)},executionId=${JSON.stringify(executionId)},field=${JSON.stringify(field)},physical=[];
    const dataset=await loadDataset('medclaw-agent-v1'),first=dataset.cases.find(value=>value.id===dataset.manifest.smoke[0]);
    if(dataset.manifest.readiness!=='reviewed'||!first||first.setup.some(action=>!['import','new_session','select_workspace','select_resources','read_control'].includes(action.action)))throw new Error('ENGINEERING non-generating preparation no longer valid');
    const abort=new AbortController(),phases=[],paths=[],nativeFetch=globalThis.fetch;
    const metadata=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){const path=new URL(request.url).pathname;paths.push(path);
      if(path==='/api/version')return Response.json({version:'ENGINEERING metadata only'});
      if(path==='/api/tags')return Response.json({models:[{name:'qwen3.5:0.8b'}]});
      if(path==='/api/show')return Response.json({details:{family:'ENGINEERING'}});
      return new Response('ENGINEERING inference prohibited',{status:403});}});
    globalThis.fetch=async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));
      if(url.origin===metadata.url.origin&&['/api/version','/api/tags','/api/show'].includes(url.pathname))return nativeFetch(input,init);
      throw new Error('ENGINEERING external requests prohibited');};
    const original=ProductAdapter.prototype.stop;
    ProductAdapter.prototype.stop=async function(...args){const proof=await original.apply(this,args);
      if(this.options.owner?.executionId!==executionId)return proof;
      if(!['stopped','closed','processExited','processTreeStopped','requiredPersistenceComplete'].every(key=>proof[key]===true)||proof.residuals.length)throw new Error('ENGINEERING physical stop itself unconfirmed');
      physical.push({instanceId:this.instanceId,dataRoot:this.paths.dataRoot,proof});writeFileSync(${JSON.stringify(physicalPath)},JSON.stringify(physical));
      return{...proof,[field]:field==='processExited'?false:null,residuals:['ENGINEERING original proof withheld: '+field]};};
    let report;try{report=await runExperiment({datasetRoot:'medclaw-agent-v1',runsRoot:${JSON.stringify(runsRoot)},executionId,selection:'smoke',trials:1,
      desktopRequest:{operationRef:${JSON.stringify(operationRef)},datasetId:'medclaw-agent-v1',selection:'smoke',trials:1},
      config:{version:1,environment:'test',model:{provider:'openai',model:'gpt-4o-mini',maxTokens:16384},
        intent:{baseUrl:metadata.url.href,model:'qwen3.5:0.8b'},policy:{},retention:'preserve_all'},judgeMode:'off',signal:abort.signal,
      onEvent:event=>{phases.push({kind:event.kind,phase:event.phase,trialId:event.trialId});if(event.kind==='phase'&&event.phase==='execute')abort.abort();}});
    }finally{ProductAdapter.prototype.stop=original;metadata.stop(true);}
    if(physical.length!==1)throw new Error('ENGINEERING actual Trial never reached its stop boundary');
    const trial=report.trials[0],directory=join(${JSON.stringify(runsRoot)},executionId,'evidence',trial.trialId);
    const saved=JSON.parse(readFileSync(join(directory,'trial.json'),'utf8')),db=new Database(join(saved.lifecycle.workRoot,'product/data/app.sqlite'),{readonly:true});
    let counts;try{counts={runs:db.query('SELECT count(*) AS n FROM runs').get().n,calls:db.query('SELECT count(*) AS n FROM model_calls').get().n};}finally{db.close();}
    writeFileSync(${JSON.stringify(packetPath)},JSON.stringify({trialId:trial.trialId,workRoot:saved.lifecycle.workRoot,counts,phases,paths,
      datasetUnchanged:JSON.stringify(report.snapshot.dataset)===JSON.stringify(dataset.snapshot),judgeCalls:report.judgeCalls.length}));
  `);
  try { execFileSync(bunExecutable, ['--no-env-file', runner], { encoding: 'utf8', windowsHide: true, timeout: 90000 }); }
  catch (error) { console.error('P17_TRIAL_UNKNOWN_ROOT_RETAINED ' + root); throw error; }
  const packet = JSON.parse(readFileSync(packetPath, 'utf8')), archive = join(runsRoot, executionId), trialPath = join(archive, 'evidence', packet.trialId, 'trial.json');
  writeFileSync(worker, `import{writeFileSync}from'node:fs';import{runEvaluationControlProcess}from${JSON.stringify(originalWorker)};
    let calls=0;globalThis.fetch=async()=>{writeFileSync(${JSON.stringify(network)},String(++calls));throw new Error('ENGINEERING evaluator network prohibited');};
    await runEvaluationControlProcess();`);
  writeFileSync(observer, `module.exports=({app})=>{
    const fs=require('fs'),cp=require('node:child_process'),spawn=cp.spawn;let child=null,closed=false,last='',count=0;
    const record=(path,value)=>{fs.writeFileSync(path+'.next',JSON.stringify(value));fs.renameSync(path+'.next',path);};
    cp.spawn=function(program,args,options){const selected=Array.isArray(args)&&args[1]===${JSON.stringify(originalWorker)}?[args[0],${JSON.stringify(worker)},...args.slice(2)]:args;
      const result=spawn.call(this,program,selected,options);
      if(selected!==args){child=result;closed=false;fs.writeFileSync(${JSON.stringify(workerSeen)},JSON.stringify({pid:result.pid,originalEntry:args[1],selectedEntry:selected[1]}));
        result.once('close',(code,signal)=>{closed=true;fs.writeFileSync(${JSON.stringify(workerClosed)},JSON.stringify({pid:result.pid,code,signal}));});}return result;};
    app.on('browser-window-created',(_,window)=>{const send=window.webContents.send.bind(window.webContents);window.webContents.send=(channel,...args)=>{
      const notice=args[0];if(channel==='medclaw:notice'&&notice?.type==='host.status')record(${JSON.stringify(hostNotice)},notice.host);
      if(channel==='medclaw:notice'&&notice?.type==='eval.status')record(${JSON.stringify(evaluationNotice)},notice.control);return send(channel,...args);};});
    app.on('before-quit',()=>fs.writeFileSync(${JSON.stringify(quitSeen)},JSON.stringify({pid:process.pid,count:++count})));
    const exit=app.exit.bind(app);app.exit=code=>{fs.writeFileSync(${JSON.stringify(exitSeen)},JSON.stringify({pid:process.pid,code:code??0}));return exit(code);};
    const timer=setInterval(async()=>{if(!fs.existsSync(${JSON.stringify(command)}))return;let input;try{input=JSON.parse(fs.readFileSync(${JSON.stringify(command)},'utf8'));}catch{return;}
      if(input.id===last)return;last=input.id;if(input.command==='quit'){app.quit();return;}
      if(input.command!=='force-test-exit')return;
      try{const host=JSON.parse(fs.readFileSync(${JSON.stringify(hostNotice)},'utf8')),proof=host.shutdown;
        if(host.state!=='stopped'||!proof||!['executionStopped','requiredPersistenceComplete','databaseClosed','processExited','processTreeStopped'].every(key=>proof[key]===true))throw new Error('ENGINEERING ordinary Host stop unknown');
        if(!child)throw new Error('ENGINEERING owned evaluator missing');
        if(!closed){const done=new Promise(resolve=>child.once('close',resolve));if(child.exitCode===null&&child.signalCode===null&&!child.kill())throw new Error('ENGINEERING owned evaluator kill refused');await done;}
        fs.writeFileSync(${JSON.stringify(forced)},JSON.stringify({mainPid:process.pid,evaluatorPid:child.pid,ordinaryHost:proof,reason:'ENGINEERING abnormal cleanup, original unknown archive retained'}));app.exit(1);
      }catch{fs.writeFileSync(${JSON.stringify(forceError)},'ENGINEERING abnormal cleanup unconfirmed');}
    },20);timer.unref();
  };`);
  const desktop = await launchActualDev(root, dataRoot, undefined, undefined, undefined, observer);
  const signal = (value: 'quit' | 'force-test-exit') => atomicWriteJson(command, { id: crypto.randomUUID(), command: value });
  return { ...desktop, root, dataRoot, operationRef, executionId, packet, archive, trialPath, physicalPath, forced, forceError, network, workerSeen, workerClosed, exitSeen, quitSeen, signal,
    host: () => existsSync(hostNotice) ? HostViewSchema.parse(JSON.parse(readFileSync(hostNotice, 'utf8'))) : null,
    evaluation: () => existsSync(evaluationNotice) ? EvaluationControlViewSchema.parse(JSON.parse(readFileSync(evaluationNotice, 'utf8'))) : null };
}

for (const field of ['stopped', 'closed', 'processExited', 'processTreeStopped', 'requiredPersistenceComplete'] satisfies TrialProofField[]) {
  test('P17 actual Runner and Main preserve a Trial with unknown ' + field + ' without replay or clean exit', async ({}) => {
    test.setTimeout(180000);
    let fixture: Awaited<ReturnType<typeof unknownTrialFixture>> | undefined, failed = false;
    try {
      const f = await unknownTrialFixture(field); fixture = f;
      const report = JSON.parse(readFileSync(join(f.archive, 'report.json'), 'utf8')), trial = JSON.parse(readFileSync(f.trialPath, 'utf8'));
      const lockPath = join(f.root, 'evaluation-runs/business/.active-execution.json');
      const files = [join(f.archive, 'report.json'), join(f.archive, 'snapshot.json'), f.trialPath, lockPath, f.physicalPath];
      const originals = files.map(path => readFileSync(path));
      expect(f.packet).toMatchObject({ datasetUnchanged: true, judgeCalls: 0, counts: { runs: 0, calls: 0 } });
      expect(f.packet.phases.filter((row: { kind: string; phase: string }) => row.kind === 'phase' && row.phase === 'execute')).toHaveLength(1);
      expect(f.packet.paths.length).toBeGreaterThan(0); expect(f.packet.paths.every((path: string) => ['/api/version', '/api/tags', '/api/show'].includes(path))).toBe(true);
      expect(report.plan).toHaveLength(10); expect(report.trials.filter((value: { startedAt: string | null }) => value.startedAt !== null)).toHaveLength(1);
      expect(report.trials[0]).toMatchObject({ status: 'infra_error', reason: 'host_stop_unconfirmed' });
      expect(report.trials.slice(1).every((value: { status: string; reason: string }) => value.status === 'not_run' && value.reason === 'previous_trial_stop_or_save_unconfirmed')).toBe(true);
      expect(trial.lifecycle.shutdown[field]).toBe(field === 'processExited' ? false : null);
      expect(trial.lifecycle.cleanup).toMatchObject({ status: 'preserved', reason: 'host_stop_unconfirmed' });
      expect(JSON.parse(readFileSync(f.physicalPath, 'utf8'))).toEqual([{ instanceId: report.trials[0].instanceId, dataRoot: join(f.packet.workRoot, 'product'),
        proof: { stopped: true, closed: true, processExited: true, processTreeStopped: true, requiredPersistenceComplete: true, residuals: [] } }]);
      expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ executionId: f.executionId, state: 'stop_or_save_unconfirmed' });
      expect(existsSync(join(f.packet.workRoot, 'product/data/app.sqlite'))).toBe(true);
      await expect(f.page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
      await expect.poll(() => f.evaluation()?.state).toBe('unknown');
      const original = await f.page.evaluate(async input => {
        const receipt = await window.medclaw.request('eval.start', { datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1, preflightId: input.operationRef }, input.operationRef);
        const status = await window.medclaw.request('eval.status', { executionId: input.executionId, operationRef: input.operationRef });
        const history = await window.medclaw.request('eval.report.read', { executionId: input.executionId, section: 'summary', page: 1, pageSize: 10 });
        return { receipt, status, history };
      }, { operationRef: f.operationRef, executionId: f.executionId });
      expect(original).toMatchObject({ receipt: { ok: true, data: { operationRef: f.operationRef, executionId: f.executionId, accepted: true } },
        status: { ok: true, data: { state: 'unknown', stopConfirmed: null, saveConfirmed: true } }, history: { ok: true, data: { executionId: f.executionId, archiveState: 'complete' } } });
      const instanceId = f.host()?.instanceId; if (!instanceId) throw new Error('ENGINEERING ordinary Host identity missing');
      expect(await f.page.evaluate(id => window.medclaw.request('host.restart', { expectedInstanceId: id }), instanceId)).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
      expect(await f.page.evaluate(() => window.medclaw.request('eval.start', { datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1, preflightId: crypto.randomUUID() }, crypto.randomUUID()))).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
      const priorShutdownSequence = f.evaluation()?.sequence ?? 0;
      f.signal('quit'); await expect.poll(() => existsSync(f.quitSeen)).toBe(true);
      await expect.poll(() => f.evaluation()?.sequence ?? 0).toBeGreaterThan(priorShutdownSequence);
      await expect.poll(() => f.evaluation()?.blockReasons.some(reason => reason.code === 'evaluation_shutdown_unconfirmed' || reason.code === 'stop_or_save_unconfirmed')).toBe(true);
      expect(f.child.exitCode).toBeNull(); expect(existsSync(f.exitSeen)).toBe(false);
      await expect(f.page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
      expect(files.map(path => readFileSync(path))).toEqual(originals); expect(existsSync(f.network)).toBe(false);
      expect(readStartupFacts(f.dataRoot)).toMatchObject({ runs: 0, calls: 0 });
      expect(await f.page.evaluate(id => window.medclaw.request('host.stop', { expectedInstanceId: id }), instanceId)).toMatchObject({ ok: true, data: { state: 'stopped',
        shutdown: { executionStopped: true, requiredPersistenceComplete: true, databaseClosed: true, processExited: true, processTreeStopped: true } } });
      f.signal('force-test-exit'); await expect.poll(() => existsSync(f.forced)).toBe(true);
      await f.close(1); fixture = undefined;
      expect(JSON.parse(readFileSync(f.exitSeen, 'utf8')).code).toBe(1); expect(existsSync(f.workerClosed)).toBe(true);
      expect(files.map(path => readFileSync(path))).toEqual(originals);
    } catch (error) { failed = true; throw error; }
    finally {
      if (fixture && fixture.child.exitCode === null) {
        const f = fixture;
        try {
          const view = await f.page.evaluate(() => window.medclaw.request('host.read', {}));
          if (view.ok && view.data.instanceId && !view.data.canStart) await f.page.evaluate(id => window.medclaw.request('host.stop', { expectedInstanceId: id }), view.data.instanceId);
          f.signal('force-test-exit'); await expect.poll(() => existsSync(f.forced)).toBe(true); await f.close(1);
        } catch (error) { console.error('P17_TRIAL_UNKNOWN_CLEANUP_UNCONFIRMED ' + f.root); if (!failed) throw error; }
      }
      if (fixture) console.log('P17_TRIAL_UNKNOWN_ROOT_RETAINED ' + fixture.root);
    }
  });
}

test('P17 actual Main saves the interrupted Session before releasing every binding and reopens without replay', async ({}, info) => {
  test.setTimeout(150000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'MedClaw 全会话退出-'))), dataRoot = join(root, '用户 数据');
  const observer = join(root, 'main-observer.cjs'), hostEntry = join(root, 'host-observer.ts'), auditPath = join(root, 'shutdown.jsonl');
  const hostNotice = join(root, 'host-notice.json'), exitSeen = join(root, 'main-exit.json'), targetRun = join(root, 'pause-run');
  const paused = join(root, 'final-save-paused'), release = join(root, 'release-final-save'), quit = join(root, 'request-dev-quit');
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const settingsPath = join(dataRoot, 'data/settings.json'), settings = new MainSettings(settingsPath).read();
  if (settings.intentModel?.enabled) writeFileSync(settingsPath, JSON.stringify({ ...settings, intentModel: { ...settings.intentModel, enabled: false } }));
  writeFileSync(hostEntry, `import{existsSync,readFileSync,writeFileSync,appendFileSync}from'node:fs';
    import{Repositories}from${JSON.stringify(resolve('packages/storage/src/repositories.ts'))};
    import{PiAgentRuntime}from${JSON.stringify(resolve('packages/runtime-pi/src/agent-runtime.ts'))};
    import{Application}from${JSON.stringify(resolve('packages/core/src/application.ts'))};
    let sequence=0;const record=(event,data={})=>appendFileSync(${JSON.stringify(auditPath)},JSON.stringify({event,sequence:++sequence,pid:process.pid,instanceId:process.env.MEDCLAW_INSTANCE_ID,...data})+'\\n');
    const finalize=Repositories.prototype.finalizeAgent;
    Repositories.prototype.finalizeAgent=function(runId,...args){
      if(existsSync(${JSON.stringify(quit)})&&existsSync(${JSON.stringify(targetRun)})&&Number(readFileSync(${JSON.stringify(targetRun)},'utf8'))===runId&&!existsSync(${JSON.stringify(release)})){
        record('final_save_paused',{runId});writeFileSync(${JSON.stringify(paused)},String(runId));
        while(!existsSync(${JSON.stringify(release)}))Bun.sleepSync(10);
      }
      const result=finalize.call(this,runId,...args);record('final_saved',{runId,status:result.status,cleanup:result.cleanup});return result;
    };
    const dispose=PiAgentRuntime.prototype.disposeIdleSessions;
    PiAgentRuntime.prototype.disposeIdleSessions=async function(...args){
      const sessionIds=[...this.sessions.keys()],sessions=await Promise.all(sessionIds.map(async id=>({id,availability:this.readAvailability(id),saved:await this.history.store.load(id)})));
      record('dispose_before',{sessionIds,sessions});const result=await dispose.apply(this,args);
      record('dispose_after',{sessionIds,retained:[...this.sessions.keys()],availability:sessionIds.map(id=>this.readAvailability(id))});return result;
    };
    const shutdown=Application.prototype.shutdown;
    Application.prototype.shutdown=async function(...args){record('application_shutdown');const result=await shutdown.apply(this,args);record('application_stopped',result);return result;};
    await import(${JSON.stringify(resolve('apps/host/src/main.ts'))});`);
  writeFileSync(observer, `module.exports=({app})=>{const fs=require('fs');
    app.on('browser-window-created',(_,window)=>{const send=window.webContents.send.bind(window.webContents);window.webContents.send=(channel,...args)=>{
      if(channel==='medclaw:notice'&&args[0]?.type==='host.status')fs.writeFileSync(${JSON.stringify(hostNotice)},JSON.stringify(args[0].host));return send(channel,...args);};});
    const exit=app.exit.bind(app);app.exit=code=>{fs.writeFileSync(${JSON.stringify(exitSeen)},JSON.stringify({pid:process.pid,code:code??0}));return exit(code);};};`);
  const requests: { messages: unknown[] }[] = [], streams = new Set<ServerResponse>(); let hold = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) { response.writeHead(403); response.end(); return; }
      let body = ''; for await (const chunk of request) body += chunk; requests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ id: 'p17-all-' + requests.length, model: 'fixture', choices: [{ index: 0,
        delta: { role: 'assistant', content: hold ? 'ENGINEERING transient A' : 'ENGINEERING saved ' + requests.length }, finish_reason: null }] }) + '\n\n');
      if (hold) { streams.add(response); response.once('close', () => streams.delete(response)); }
      else response.end('data: ' + JSON.stringify({ id: 'p17-all-' + requests.length, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } catch { response.destroy(); }
  });
  const saved = () => JSON.parse(execFileSync(bunExecutable, ['--no-env-file', '-e', `import{Database}from'bun:sqlite';
    const db=new Database(${JSON.stringify(join(dataRoot, 'data/app.sqlite'))},{readonly:true});
    console.log(JSON.stringify({runs:db.query('SELECT * FROM runs ORDER BY id').all(),calls:db.query('SELECT * FROM model_calls ORDER BY id').all(),
      memories:db.query('SELECT * FROM memories ORDER BY id').all(),answers:db.query('SELECT * FROM answers ORDER BY id').all(),
      sessions:db.query('SELECT * FROM sessions ORDER BY id').all(),inputs:db.query('SELECT * FROM session_inputs ORDER BY id').all(),workspace:db.query('SELECT * FROM workspace').get()}));db.close();`],
    { encoding: 'utf8', windowsHide: true })) as { runs: { id: number; session_id: number; status: string; error_json: string | null; cleanup_json: string | null }[];
      calls: { run_id: number; state: string; error_json: string | null }[]; memories: { session_id: number }[]; answers: { session_id: number }[];
      sessions: { id: number }[]; inputs: { id: number; session_id: number; run_id: number; status: string; processing_status: string; processed_at: string | null; updated_at: string }[]; workspace: { active_session_id: number | null } };
  let desktop: Awaited<ReturnType<typeof launchActualDev>> | undefined, failure: unknown;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const running = await launchActualDev(root, dataRoot, undefined, undefined, hostEntry, observer); desktop = running; const page = running.page;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const initial = await page.evaluate(() => window.medclaw.request('host.read', {})); if (!initial.ok || !initial.data.instanceId) throw new Error('ENGINEERING original Host unavailable');
    expect(await page.evaluate(async baseUrl => {
      const models = await window.medclaw.request('model.read', {}); if (!models.ok) throw new Error(models.error.code);
      const token = await window.medclaw.secretInput({ providerId: 'p17-all-fixture', purpose: 'custom_api_key', value: 'LOCAL-FIXTURE-ONLY' }); if (!token.ok) throw new Error(token.error.code);
      const custom = await window.medclaw.request('model.custom.save', { expectedConfigVersion: models.data.configVersion, credentialInput: token.data.token,
        definition: { providerId: 'p17-all-fixture', name: 'P17 all bindings', api: 'openai-completions', baseUrl,
          models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] } });
      if (!custom.ok) throw new Error(custom.error.code); return window.medclaw.request('model.configure', { provider: 'p17-all-fixture', modelId: 'fixture', expectedConfigVersion: custom.data.configVersion });
    }, 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1')).toMatchObject({ ok: true });
    const create = () => page.evaluate(async () => { const w = await window.medclaw.request('workspace.read', {}); if (!w.ok) throw new Error(w.error.code); return window.medclaw.request('session.create', { expectedWorkspaceRevision: w.data.revision }, crypto.randomUUID()); });
    const select = (sessionId: number) => page.evaluate(async id => { const w = await window.medclaw.request('workspace.read', {}); if (!w.ok) throw new Error(w.error.code); return window.medclaw.request('session.select', { sessionId: id, expectedWorkspaceRevision: w.data.revision }); }, sessionId);
    const input = (text: string) => page.evaluate(async value => {
      const w = await window.medclaw.request('workspace.read', {}), m = await window.medclaw.request('model.read', {});
      if (!w.ok || !w.data.sessionId || !m.ok) throw new Error('ENGINEERING submission source unavailable');
      const d = await window.medclaw.request('session.read', { sessionId: w.data.sessionId }); if (!d.ok || !d.data) throw new Error('ENGINEERING Session missing');
      return { sessionId: w.data.sessionId, clientSequence: d.data.session.nextSubmissionSequence, text: value, mode: 'send' as const,
        expectedRevision: w.data.revision, expectedBatchIds: [], expectedQueryId: null,
        model: { provider: 'p17-all-fixture', modelId: 'fixture', expectedConfigVersion: m.data.configVersion }, referenceDate: '2026-10-17', timezone: 'Asia/Shanghai' };
    }, text);
    const submit = async (text: string) => page.evaluate(value => window.medclaw.request('session.submit', value, crypto.randomUUID()), await input(text));
    const idle = () => expect.poll(() => page.evaluate(async () => { const r = await window.medclaw.request('run.control.read', {}); return r.ok && r.data.acceptingNewRuns; })).toBe(true);
    const a = await create(); if (!a.ok) throw new Error('ENGINEERING Session A missing');
    const first = await submit('ENGINEERING A saved'); if (!first.ok || first.data.runId === null) throw new Error('ENGINEERING first Run missing'); await idle();
    const b = await create(); if (!b.ok) throw new Error('ENGINEERING Session B missing');
    const second = await submit('ENGINEERING B saved'); if (!second.ok || second.data.runId === null) throw new Error('ENGINEERING second Run missing'); await idle();
    const bSaved = saved(); expect(bSaved.answers).toHaveLength(2); expect(requests).toHaveLength(2);
    expect(await select(a.data.session.id)).toMatchObject({ ok: true }); hold = true;
    const third = await submit('ENGINEERING A interrupted by ordinary quit'); if (!third.ok || third.data.runId === null) throw new Error('ENGINEERING active Run missing');
    await expect.poll(() => streams.size).toBe(1); expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]!.messages)).toContain('ENGINEERING A saved'); expect(JSON.stringify(requests[2]!.messages)).not.toContain('ENGINEERING B saved');
    expect(await select(b.data.session.id)).toMatchObject({ ok: true });
    const declined = await input('ENGINEERING must not be admitted during shutdown'), before = saved();
    expect(before.workspace.active_session_id).toBe(b.data.session.id); expect(before.inputs).toHaveLength(3);
    writeFileSync(targetRun, String(third.data.runId)); writeFileSync(quit, 'ENGINEERING ordinary Main quit');
    await expect.poll(() => existsSync(paused)).toBe(true); await expect.poll(() => streams.size).toBe(0);
    expect(existsSync(exitSeen)).toBe(false); expect(running.child.exitCode).toBeNull();
    expect(await page.evaluate(value => window.medclaw.request('session.submit', value, crypto.randomUUID()), declined)).toMatchObject({ ok: false, error: { code: 'maintenance_busy' } });
    const pending = saved(); expect(pending.inputs).toEqual(before.inputs); expect(pending.answers).toEqual(bSaved.answers);
    expect(pending.runs.find(row => row.id === third.data.runId)?.status).toBe('running');
    writeFileSync(release, 'ENGINEERING permit the original final transaction');
    await expect.poll(() => running.child.exitCode, { timeout: 15000 }).toBe(0); expect(JSON.parse(readFileSync(exitSeen, 'utf8')).code).toBe(0);
    const stopped = HostViewSchema.parse(JSON.parse(readFileSync(hostNotice, 'utf8')));
    expect(stopped).toMatchObject({ instanceId: initial.data.instanceId, state: 'stopped', canStart: true,
      shutdown: { executionStopped: true, requiredPersistenceComplete: true, databaseClosed: true, processExited: true, processTreeStopped: true } });
    const final = saved(), interrupted = final.runs.find(row => row.id === third.data.runId)!;
    expect(interrupted.status).toBe('failed'); expect(JSON.parse(interrupted.error_json!)).toMatchObject({ code: 'host_interrupted' });
    expect(JSON.parse(interrupted.cleanup_json!)).toMatchObject({ stopConfirmed: true, requiredPersistenceComplete: true, resourcesReleased: true });
    expect(final.runs.filter(row => row.id !== third.data.runId)).toEqual(bSaved.runs);
    expect(final.memories).toEqual(expect.arrayContaining(before.memories)); expect(final.answers).toEqual(bSaved.answers);
    const finalInput = final.inputs.find(row => row.run_id === third.data.runId)!;
    expect(finalInput).toMatchObject({ status: 'consumed', processing_status: 'failed', processed_at: expect.any(String) });
    expect(final.inputs).toEqual(before.inputs.map(row => row.id === finalInput.id ? { ...row, processing_status: 'failed', processed_at: finalInput.processed_at, updated_at: finalInput.updated_at } : row));
    expect(final.memories.filter(row => row.session_id === b.data.session.id)).toEqual(bSaved.memories.filter(row => row.session_id === b.data.session.id));
    expect(final.sessions.find(row => row.id === b.data.session.id)).toEqual(before.sessions.find(row => row.id === b.data.session.id));
    expect(final.calls.find(row => row.run_id === third.data.runId)).toMatchObject({ state: 'cancelled' });
    const observed = readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; instanceId: string; runId?: number; retained?: number[] });
    const original = observed.filter(row => row.instanceId === initial.data.instanceId), savedAt = original.findIndex(row => row.event === 'final_saved' && row.runId === third.data.runId);
    const disposingAt = original.findIndex(row => row.event === 'dispose_before'), disposedAt = original.findIndex(row => row.event === 'dispose_after');
    expect(savedAt).toBeGreaterThan(-1); expect(disposingAt).toBeGreaterThan(savedAt); expect(disposedAt).toBeGreaterThan(disposingAt);
    expect(original[disposingAt]).toMatchObject({ sessionIds: [a.data.session.id, b.data.session.id], sessions: [{ availability: { availability: 'ready' }, saved: { ok: true } }, { availability: { availability: 'ready' }, saved: { ok: true } }] });
    expect(original[disposedAt]).toMatchObject({ retained: [], availability: [{ availability: 'unloaded' }, { availability: 'unloaded' }] });
    await info.attach('p17-main-all-bindings-shutdown.json', { body: JSON.stringify({ stopped, observations: original, runs: final.runs, calls: final.calls }), contentType: 'application/json' });
    await running.close(); desktop = undefined; expect(requests).toHaveLength(3);
    const reopened = await launchActualDev(join(root, 'reopened'), dataRoot, undefined, undefined, hostEntry, observer); desktop = reopened;
    await expect(reopened.page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    expect(saved()).toEqual(final); expect(requests).toHaveLength(3);
    const reading = await reopened.page.evaluate(async ids => ({ workspace: await window.medclaw.request('workspace.read', {}),
      a: await window.medclaw.request('session.read', { sessionId: ids[0]! }), b: await window.medclaw.request('session.read', { sessionId: ids[1]! }),
      control: await window.medclaw.request('run.control.read', {}) }), [a.data.session.id, b.data.session.id]);
    expect(reading).toMatchObject({ workspace: { ok: true, data: { sessionId: b.data.session.id } }, a: { ok: true, data: { runtime: { availability: 'unloaded' } } },
      b: { ok: true, data: { runtime: { availability: 'unloaded' } } }, control: { ok: true, data: { acceptingNewRuns: true } } });
    expect(requests).toHaveLength(3); await reopened.close(); desktop = undefined;
  } catch (error) { failure = error; throw error; }
  finally {
    writeFileSync(release, 'ENGINEERING release the original transaction for cleanup');
    try { if (desktop) await desktop.close(); } catch (error) { if (!failure) throw error; console.error('P17_ALL_BINDINGS_CLEANUP_UNCONFIRMED'); }
    finally { for (const response of streams) response.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); console.log('P17_ALL_BINDINGS_ROOT_RETAINED ' + root); }
  }
});
