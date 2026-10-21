import { beforeAll, expect, test } from 'bun:test';
import { cp, copyFile, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageRuntimeSources } from '../../apps/desktop/build';
import { loadDataset, loadSnapshot } from '../../agent-eval/src/datasets';
import { recordFeedback } from '../../agent-eval/src/review/store';
import { reportFixture, saveReportFixture, datasetFixture, runConfigFixture } from '../../agent-eval/tests/report-fixture';

const sourceRoot = resolve(import.meta.dir, '../..'), installRoot = join(sourceRoot, '.build/package-resources/medclaw'), runtime = join(installRoot, 'runtime');
beforeAll(async () => {
  expect((await lstat(join(installRoot, 'install.json'))).isFile()).toBe(true);
  await stageRuntimeSources(sourceRoot, runtime);
});
async function installed(root: string, body: string) {
  const paths = { sourceRoot: runtime, configsRoot: join(root, 'configs'), runsRoot: join(root, 'runs'), datasetsRoot: join(root, 'datasets'), installManifestPath: join(installRoot, 'install.json') };
  const script = 'const nativeFetch=globalThis.fetch;let unexpectedNetworkRequests=0;globalThis.fetch=async()=>{unexpectedNetworkRequests++;throw new Error("Network calls are disabled in installed evaluation engineering tests");};'
    + 'const {EvaluationService}=await import(' + JSON.stringify(pathToFileURL(join(runtime, 'agent-eval/src/desktop/service.ts')).href) + ');'
    + 'const service=new EvaluationService(' + JSON.stringify(paths) + ');await service.initializeRuntime();' + body;
  const child = Bun.spawn([join(installRoot, 'bin/bun.exe'), '--no-env-file', '-e', script], { cwd: runtime, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(error);
  return JSON.parse(output);
}
test('a runtime without default Gold can read existing report and feedback without changing them or requesting external services', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p17-eval-install-'));
  try {
    await expect(lstat(join(runtime, 'agent-eval/src/datasets'))).rejects.toMatchObject({ code: 'ENOENT' });
    const report = reportFixture(), archive = join(root, 'runs/business', report.executionId), trial = report.plan[0]!;
    await saveReportFixture(archive, report);
    const feedback = { contract: 'medclaw-human-feedback/v1', source: 'local', sourceId: 'p17-existing-feedback', reviewer: 'ENGINEERING reviewer',
      reviewedAt: '2026-10-17T00:00:00.000Z', executionId: report.executionId, caseId: trial.caseId, trialId: trial.trialId,
      status: 'UNJUDGEABLE', comment: 'ENGINEERING archived feedback; no quality claim', evidenceRefs: [] };
    const receipt = await recordFeedback(archive, feedback), files = ['report.json', 'snapshot.json', 'review.json'];
    const originals = await Promise.all(files.map(file => readFile(join(archive, file), 'utf8')));
    const value = await installed(root, 'console.log(JSON.stringify({reports:await service.listReports({page:1,pageSize:10}),feedback:await service.readReportSection('
      + JSON.stringify({ executionId: report.executionId, section: 'feedback', page: 1, pageSize: 10 })
      + '),check:await service.preflight({datasetId:"medclaw-agent-v1",selection:"smoke",trials:1}),unexpectedNetworkRequests}));');
    expect(value.reports).toMatchObject({ total: 1, items: [{ executionId: report.executionId, archiveState: 'complete' }] });
    expect(value.feedback).toMatchObject({ section: 'feedback', executionId: report.executionId, archiveState: 'complete', total: 1,
      items: [{ id: receipt.id, source: feedback.source, sourceId: feedback.sourceId, reviewer: feedback.reviewer, reviewedAt: feedback.reviewedAt,
        caseId: trial.caseId, trialId: trial.trialId, status: feedback.status, comment: feedback.comment, evidenceRefs: [], conflict: false }] });
    expect(value.check).toMatchObject({ cases: 0, plannedTrials: 0, readiness: 'materials_unavailable', blockers: [{ code: 'evaluation_dataset_missing' }] });
    expect(value.unexpectedNetworkRequests).toBe(0);
    expect(await Promise.all(files.map(file => readFile(join(archive, file), 'utf8')))).toEqual(originals);
    expect(await readdir(root)).toEqual(['runs']); expect(await readdir(join(root, 'runs/business'))).toEqual([report.executionId]);
  } finally {
    const target = await realpath(root), part = relative(await realpath(tmpdir()), target);
    if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('ENGINEERING feedback fixture cleanup escaped its temporary root');
    await rm(target, { recursive: true, force: true });
  }
}, 30000);
test('installed Trial preparation uses its explicit bundle and isolated SDK root without starting inference', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'medclaw-p17-installed-trial-')));
  let stopped = false, proof: unknown;
  try {
    await mkdir(join(root, 'work'));
    const value = await installed(root, 'const intentPaths=[];'
      + 'const metadata=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){const name=new URL(request.url).pathname;intentPaths.push(name);'
      + 'if(name==="/api/version")return Response.json({version:"ENGINEERING metadata only"});'
      + 'if(name==="/api/tags")return Response.json({models:[{name:"qwen3.5:0.8b"}]});'
      + 'if(name==="/api/show")return Response.json({details:{family:"ENGINEERING",parameter_size:"fixture",quantization_level:"fixture"}});'
      + 'return new Response("ENGINEERING inference prohibited",{status:403});}});'
      + 'globalThis.fetch=async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));'
      + 'if(url.origin===metadata.url.origin&&["/api/version","/api/tags","/api/show"].includes(url.pathname))return nativeFetch(input,init);'
      + 'unexpectedNetworkRequests++;throw new Error("ENGINEERING external request prohibited");};'
      + 'const {prepareInstance}=await import(' + JSON.stringify(pathToFileURL(join(runtime, 'agent-eval/src/execution/instance.ts')).href) + ');'
      + 'const config=' + JSON.stringify(reportFixture().config) + ';config.model={provider:"openai",model:"gpt-4o-mini",maxTokens:16384};'
      + 'config.intent={baseUrl:metadata.url.href,model:"qwen3.5:0.8b"};let adapter,error=null,proof=null,control=null,diagnostics=null,runtimePaths=null,counts=null;'
      + 'try{adapter=await prepareInstance({trialRoot:' + JSON.stringify(join(root, 'trial')) + ',workRoot:' + JSON.stringify(join(root, 'work'))
      + ',config,installManifestPath:' + JSON.stringify(join(installRoot, 'install.json')) + ',owner:{executionId:"engineering-installed",trialId:"startup",caseId:"startup"}});'
      + 'const unwrap=value=>{if(!value.ok)throw new Error(value.error.code);return value.data;};control=unwrap(await adapter.request("run.control.read",{}));'
      + 'diagnostics=unwrap(await adapter.request("diagnostics.read",{categories:["versions"]}));'
      + 'runtimePaths={hostEntry:adapter.options.hostEntry,bunExecutable:adapter.options.bunExecutable,resourceRoot:adapter.options.resourceRoot,maintenanceEntry:adapter.options.maintenanceEntry,installManifestPath:adapter.options.installManifestPath};'
      + '}catch(failure){error=failure.message;proof=failure.shutdownProof??null;}'
      + 'finally{if(adapter)proof=await adapter.stop(5000);metadata.stop(true);}'
      + 'if(adapter&&proof?.stopped===true&&proof.closed===true&&proof.processExited===true&&proof.processTreeStopped===true&&proof.requiredPersistenceComplete===true){'
      + 'const {Database}=await import("bun:sqlite"),db=new Database(adapter.paths.databasePath,{readonly:true});'
      + 'try{counts={runs:db.query("SELECT count(*) AS n FROM runs").get().n,calls:db.query("SELECT count(*) AS n FROM model_calls").get().n};}finally{db.close();}}'
      + 'console.log(JSON.stringify({error,proof,runtimePaths,control,diagnostics,counts,intentPaths,unexpectedNetworkRequests}));');
    proof = value.proof; stopped = value.proof?.stopped === true && value.proof.closed === true && value.proof.processExited === true
      && value.proof.processTreeStopped === true && value.proof.requiredPersistenceComplete === true;
    expect(value.error).toBeNull(); expect(stopped).toBe(true);
    expect(value.runtimePaths).toEqual({ hostEntry: join(runtime, 'apps/host/src/main.ts'), bunExecutable: join(installRoot, 'bin/bun.exe'),
      resourceRoot: join(runtime, 'resources'), maintenanceEntry: join(runtime, 'apps/host/src/maintenance.ts'), installManifestPath: join(installRoot, 'install.json') });
    expect(value.counts).toEqual({ runs: 0, calls: 0 }); expect(value.unexpectedNetworkRequests).toBe(0);
    expect(value.intentPaths.length).toBeGreaterThan(0);
    expect(value.intentPaths.every((path: string) => ['/api/version', '/api/tags', '/api/show'].includes(path))).toBe(true);
    expect(value.diagnostics.dependencies).toContainEqual(expect.objectContaining({ name: 'rg', path: join(root, 'work/product/runtime/sdk/bin/rg.exe'), source: 'installed_bundle' }));
    expect(value.diagnostics.dependencies).toContainEqual(expect.objectContaining({ name: 'fd', path: join(root, 'work/product/runtime/sdk/bin/fd.exe'), source: 'installed_bundle' }));
  } finally {
    if (stopped) {
      const target = await realpath(root), part = relative(await realpath(tmpdir()), target);
      if (target !== root || !part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('ENGINEERING installed Trial cleanup root changed');
      await rm(target, { recursive: true, force: true });
    } else console.error('P17_INSTALLED_TRIAL_FIXTURE_RETAINED ' + JSON.stringify({ root, proof }));
  }
}, 60000);

test('installed engineering Trial executes resource selection and saves all five shutdown facts with isolated public inputs', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'MedClaw 安装Trial-'))), evaluationRoot = join(root, 'evaluation');
  const datasetRoot = join(evaluationRoot, 'datasets/engineering'), trialRoot = join(evaluationRoot, 'runs/business/engineering/evidence/resources');
  const dailySdk = join(root, 'daily-sdk'), privateGold = 'ENGINEERING P17 PRIVATE GOLD MUST NOT ENTER PUBLIC INPUTS';
  const publicText = 'ENGINEERING public input only\n', snapshot = datasetFixture(), task = loadSnapshot(snapshot).cases[0]!;
  task.id = 'p17-installed-resource-lifecycle'; task.name = 'ENGINEERING installed resource lifecycle, no model or quality claim';
  task.materialRefs = ['materials/engineering.txt'];
  task.input.materials = { 'materials/engineering.txt': { kind: 'file', files: [{ path: 'engineering.txt', content: publicText, bytes: Buffer.byteLength(publicText) }] } };
  task.setup = [{ action: 'new_session', alias: 'A' }];
  task.steps = [{ id: 'select-query-skill', trigger: 'ready', timeoutMs: 10000,
    action: { action: 'select_resources', sessionAlias: 'A', skills: [{ id: 'query', version: 'v1' }] } },
  { id: 'read-control', trigger: 'ready', timeoutMs: 10000, action: { action: 'read_control' } }];
  let workRoot: string | undefined, passed = false;
  try {
    await mkdir(datasetRoot, { recursive: true }); await mkdir(join(dailySdk, 'bin'), { recursive: true });
    await writeFile(join(datasetRoot, 'snapshot.json'), JSON.stringify(snapshot));
    await writeFile(join(datasetRoot, 'case.json'), JSON.stringify(task));
    await writeFile(join(datasetRoot, 'gold.json'), JSON.stringify({ gold: snapshot.gold, canary: privateGold }));
    await writeFile(join(datasetRoot, '.controlled-fixture.json'), JSON.stringify({ contract: 'medclaw-controlled-fixture/v1', synthetic: true, containsSecrets: false }));
    for (const name of ['rg.exe', 'fd.exe']) await writeFile(join(dailySdk, 'bin', name), 'ENGINEERING daily SDK must remain unused');
    const value = await installed(evaluationRoot, 'process.env.PI_CODING_AGENT_DIR=' + JSON.stringify(dailySdk) + ';const intentPaths=[];'
      + 'const metadata=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){const name=new URL(request.url).pathname;intentPaths.push(name);'
      + 'if(name==="/api/version")return Response.json({version:"ENGINEERING metadata only"});'
      + 'if(name==="/api/tags")return Response.json({models:[{name:"qwen3.5:0.8b"}]});'
      + 'if(name==="/api/show")return Response.json({details:{family:"ENGINEERING"}});return new Response("ENGINEERING inference prohibited",{status:403});}});'
      + 'globalThis.fetch=async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));'
      + 'if(url.origin===metadata.url.origin&&["/api/version","/api/tags","/api/show"].includes(url.pathname))return nativeFetch(input,init);'
      + 'unexpectedNetworkRequests++;throw new Error("ENGINEERING external request prohibited");};'
      + 'const{runTrial}=await import(' + JSON.stringify(pathToFileURL(join(runtime, 'agent-eval/src/execution/trial.ts')).href) + ');'
      + 'const{loadProductResources}=await import(' + JSON.stringify(pathToFileURL(join(runtime, 'agent-eval/src/dataset-fixtures.ts')).href) + ');'
      + 'const fixture=await Bun.file(' + JSON.stringify(join(datasetRoot, 'snapshot.json')) + ').json(),task=await Bun.file(' + JSON.stringify(join(datasetRoot, 'case.json')) + ').json();'
      + 'const config=' + JSON.stringify(reportFixture().config) + ';config.model={provider:"openai",model:"gpt-4o-mini",maxTokens:16384};config.intent.baseUrl=metadata.url.href;'
      + 'let result;try{result=await runTrial({executionId:"engineering-installed",trialId:"resources",caseId:task.id'
      + ',repetition:1,case:task,datasetRoot:' + JSON.stringify(datasetRoot) + ',fixtureFiles:fixture.fixtures'
      + ',productResources:await loadProductResources(fixture.fixtures),config,trialRoot:' + JSON.stringify(trialRoot)
      + ',controlledFixture:true,installManifestPath:' + JSON.stringify(join(installRoot, 'install.json')) + '});}finally{metadata.stop(true);}'
      + 'console.log(JSON.stringify({result,paths:service.paths,intentPaths,unexpectedNetworkRequests}));');
    const saved = JSON.parse(await readFile(join(trialRoot, 'trial.json'), 'utf8'));
    workRoot = saved.lifecycle.workRoot;
    if (!workRoot) throw new Error('ENGINEERING Trial work root missing');
    expect(value.result).toMatchObject({ status: 'completed', reason: null, stopped: true, closed: true, startedAt: expect.any(String), endedAt: expect.any(String) });
    expect(saved.lifecycle.shutdown).toEqual({ stopped: true, closed: true, processExited: true, processTreeStopped: true, requiredPersistenceComplete: true, residuals: [] });
    expect(saved.lifecycle.cleanup).toMatchObject({ status: 'preserved', reason: 'retention_policy', productRoot: join(workRoot, 'product') });
    expect(saved.lifecycle.ownership).toMatchObject({ executionId: 'engineering-installed', trialId: 'resources', caseId: task.id, dataRoot: join(workRoot, 'product'), instanceIds: [value.result.instanceId] });
    expect(value.paths).toEqual({ sourceRoot: runtime, configsRoot: join(evaluationRoot, 'configs'), runsRoot: join(evaluationRoot, 'runs'), datasetsRoot: join(evaluationRoot, 'datasets'), installManifestPath: join(installRoot, 'install.json') });
    expect(value.unexpectedNetworkRequests).toBe(0); expect(value.intentPaths.length).toBeGreaterThan(0);
    expect(value.intentPaths.every((path: string) => ['/api/version', '/api/tags', '/api/show'].includes(path))).toBe(true);
    expect(await readdir(join(workRoot, 'inputs'))).toEqual(['materials']);
    expect(await readdir(join(workRoot, 'inputs/materials'))).toEqual(['engineering.txt']);
    expect(await readFile(join(workRoot, 'inputs/materials/engineering.txt'), 'utf8')).toBe(publicText);
    const events = (await readFile(join(trialRoot, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(events.find(row => row.kind === 'ready')).toMatchObject({ instanceId: value.result.instanceId,
      ready: { instanceId: value.result.instanceId, dataRoot: join(workRoot, 'product'), sdkVersion: '0.87.1', schemaVersion: 17 } });
    expect(events.filter(row => row.kind === 'request' && row.method === 'resources.read').map(row => row.payload.file).sort()).toEqual(['SKILL.md', 'references/facts-and-assumptions.md']);
    const resourceReads = events.filter(row => row.kind === 'reply' && row.method === 'resources.read' && row.result.ok);
    expect(resourceReads).toHaveLength(2);
    for (const row of resourceReads) expect(row.result.data.content).toBe(await readFile(join(runtime, 'resources/skills/query/v1', row.result.data.file), 'utf8'));
    expect(events.some(row => row.kind === 'request' && ['session.submit', 'model.request', 'session.compact'].includes(row.method))).toBe(false);
    expect(await readFile(join(trialRoot, 'events.jsonl'), 'utf8')).not.toContain(privateGold);
    expect(await readFile(join(trialRoot, 'observation.json'), 'utf8')).not.toContain(privateGold);
    expect(value.result.observation).toMatchObject({ missing: [], facts: { runs: [], modelCalls: [], sessions: [expect.any(Object)] } });
    const { Database } = await import('bun:sqlite'), db = new Database(join(workRoot, 'product/data/app.sqlite'), { readonly: true });
    try { expect(db.query('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 }); expect(db.query('SELECT count(*) AS n FROM model_calls').get()).toEqual({ n: 0 }); }
    finally { db.close(); }
    const settings = JSON.parse(await readFile(join(workRoot, 'product/data/settings.json'), 'utf8'));
    expect(settings.resources.bySession['1'].skills).toEqual([expect.objectContaining({ id: 'query', version: 'v1' })]);
    for (const name of ['rg.exe', 'fd.exe']) {
      expect(await readFile(join(dailySdk, 'bin', name), 'utf8')).toBe('ENGINEERING daily SDK must remain unused');
      expect(Buffer.from(await readFile(join(workRoot, 'product/runtime/sdk/bin', name))).equals(Buffer.from(await readFile(join(installRoot, 'bin', name))))).toBe(true);
    }
    passed = true;
  } finally {
    if (passed && workRoot) {
      for (const target of [workRoot, root]) {
        const canonical = await realpath(target), part = relative(await realpath(tmpdir()), canonical);
        if (canonical !== target || !part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('ENGINEERING completed Trial cleanup escaped its temporary root');
        await rm(canonical, { recursive: true, force: true });
      }
    } else console.error('P17_RESOURCE_TRIAL_ROOT_RETAINED ' + JSON.stringify({ root, workRoot }));
  }
}, 90000);

for (const kind of ['missing', 'relative', 'wrong-source', 'outside-root'] as const) test(`installed Trial rejects ${kind} installation before metadata requests or business writes`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'medclaw-p17-invalid-trial-'))), bundle = join(root, 'bundle'), links: string[] = [];
  let safeToRemove = false;
  try {
    const manifest = JSON.parse(await readFile(join(installRoot, 'install.json'), 'utf8'));
    const manifestPath = kind === 'relative' ? relative(runtime, join(installRoot, 'install.json')) : join(bundle, 'install.json');
    if (kind !== 'missing' && kind !== 'relative') {
      await mkdir(bundle);
      if (kind === 'outside-root') {
        for (const name of ['runtime', 'bin']) { const link = join(bundle, name); await symlink(join(installRoot, name), link, 'dir'); links.push(link); }
      } else {
        for (const name of [manifest.hostEntry, manifest.maintenanceEntry, manifest.binaries.find((binary: { name: string }) => binary.name === 'bun').path]) {
          const file = join(bundle, name); await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'ENGINEERING invalid runtime; never execute');
        }
        await mkdir(join(bundle, manifest.resourceRoot), { recursive: true });
      }
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
    const value = await installed(root, 'const {prepareInstance}=await import(' + JSON.stringify(pathToFileURL(join(runtime, 'agent-eval/src/execution/instance.ts')).href) + ');let error=null;'
      + 'try{await prepareInstance({trialRoot:' + JSON.stringify(join(root, 'trial')) + ',workRoot:' + JSON.stringify(join(root, 'work'))
      + ',config:' + JSON.stringify(reportFixture().config) + ',installManifestPath:' + JSON.stringify(manifestPath) + '});}catch(failure){error=failure.message;}'
      + 'console.log(JSON.stringify({error,unexpectedNetworkRequests}));');
    expect(value).toEqual({ error: kind === 'outside-root' ? 'access_denied' : 'host_protocol_mismatch', unexpectedNetworkRequests: 0 });
    await expect(lstat(join(root, 'trial'))).rejects.toMatchObject({ code: 'ENOENT' }); await expect(lstat(join(root, 'work'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual(kind === 'missing' || kind === 'relative' ? [] : ['bundle']); safeToRemove = true;
  } finally {
    if (safeToRemove) {
      for (const link of links) { if (!(await lstat(link)).isSymbolicLink()) throw new Error('ENGINEERING invalid Trial alias changed'); await unlink(link); }
      const target = await realpath(root), part = relative(await realpath(tmpdir()), target);
      if (target !== root || !part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('ENGINEERING invalid Trial cleanup root changed');
      await rm(target, { recursive: true, force: true });
    } else console.error('P17_INVALID_TRIAL_FIXTURE_RETAINED ' + JSON.stringify({ root }));
  }
}, 30000);

test('installed preflight reads its registered external snapshot and rejects a different dataset identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p17-eval-material-'));
  try {
    const path = join(root, 'datasets/medclaw-agent-v1/snapshot.json'); await mkdir(join(path, '..'), { recursive: true });
    const dataset = await loadDataset('medclaw-agent-v1'); await writeFile(path, JSON.stringify(dataset.snapshot));
    const check = await installed(root, 'console.log(JSON.stringify(await service.preflight({datasetId:"medclaw-agent-v1",selection:"smoke",trials:1})));');
    expect(check).toMatchObject({ datasetId: 'medclaw-agent-v1', cases: 10, plannedTrials: 10 });
    expect(check.blockers).toContainEqual(expect.objectContaining({ code: 'evaluation_config_unavailable' }));
    await writeFile(path, JSON.stringify(datasetFixture()));
    const invalid = await installed(root, 'console.log(JSON.stringify(await service.preflight({datasetId:"medclaw-agent-v1",selection:"smoke",trials:1})));');
    expect(invalid).toMatchObject({ cases: 0, plannedTrials: 0, blockers: [{ code: 'evaluation_dataset_invalid' }] });
    expect(JSON.parse(await readFile(path, 'utf8')).info.id).toBe('controlled-fixture');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 45000);

async function configuredMaterials(root: string) {
  const snapshot = join(root, 'datasets/medclaw-agent-v1/snapshot.json');
  await mkdir(join(snapshot, '..'), { recursive: true }); await mkdir(join(root, 'configs'));
  const dataset = await loadDataset('medclaw-agent-v1');
  await writeFile(snapshot, JSON.stringify(dataset.snapshot));
  await writeFile(join(root, 'configs/agent.json'), JSON.stringify(runConfigFixture()));
  await writeFile(join(root, 'configs/environment'), 'MEDCLAW_JUDGE_BASE_URL=https://judge.example.invalid/v1\nMEDCLAW_JUDGE_MODEL=openai/gpt-4o-mini\nMEDCLAW_JUDGE_API_KEY=controlled-judge-key\n');
  return { snapshot, dataset };
}

test('installed Worker passes its external snapshot to the real Runner while cancellation starts no Trial or network request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p17-eval-worker-')); let stopped = false;
  try {
    const { dataset } = await configuredMaterials(root), operationRef = crypto.randomUUID();
    const value = await installed(root, 'const{EvaluationWorker}=await import('+JSON.stringify(pathToFileURL(join(runtime, 'agent-eval/src/desktop/controller.ts')).href)+');'
      + 'const options={datasetId:"medclaw-agent-v1",selection:"smoke",trials:1},check=await service.preflight(options);'
      + 'if(check.blockers.length)throw new Error(JSON.stringify(check.blockers));'
      + 'const worker=new EvaluationWorker(service,'+JSON.stringify(crypto.randomUUID())+',()=>{}),receipt=await worker.request("eval.start",{...options,preflightId:check.preflightId},'+JSON.stringify(operationRef)+');'
      + 'await worker.request("eval.cancel",{executionId:receipt.executionId},'+JSON.stringify(crypto.randomUUID())+');'
      + 'const proof=await worker.shutdown();console.log(JSON.stringify({receipt,proof,unexpectedNetworkRequests}));');
    stopped = value.proof.stopConfirmed === true && value.proof.saveConfirmed === true;
    expect(value).toMatchObject({ receipt: { operationRef, executionId: 'desktop-'+operationRef }, unexpectedNetworkRequests: 0,
      proof: { stopConfirmed: true, saveConfirmed: true } });
    const archive = join(root, 'runs/business', value.receipt.executionId), snapshot = JSON.parse(await readFile(join(archive, 'snapshot.json'), 'utf8'));
    const report = JSON.parse(await readFile(join(archive, 'report.json'), 'utf8'));
    expect(snapshot.desktopRequest).toEqual({ operationRef, datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1 });
    expect(snapshot.dataset).toEqual(dataset.snapshot);
    expect(report.plan).toHaveLength(10); expect(report.trials).toHaveLength(10); expect(report.judgeCalls).toEqual([]);
    expect(report.trials.every((trial: { status: string; startedAt: string | null }) => trial.status === 'not_run' && trial.startedAt === null)).toBe(true);
  } finally { if (stopped) await rm(root, { recursive: true, force: true }); }
}, 60000);

test('installed preparation rejects materials changed after Check without creating an execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p17-eval-changed-material-'));
  try {
    const { snapshot } = await configuredMaterials(root);
    const value = await installed(root, 'const options={datasetId:"medclaw-agent-v1",selection:"smoke",trials:1},check=await service.preflight(options);'
      + 'if(check.blockers.length)throw new Error(JSON.stringify(check.blockers));'
      + 'await Bun.write('+JSON.stringify(snapshot)+',"{changed-after-check");let error=null;'
      + 'try{await service.prepareRun({...options,preflightId:check.preflightId});}catch(failure){error=failure.message;}'
      + 'console.log(JSON.stringify({error,unexpectedNetworkRequests}));');
    expect(value).toEqual({ error: 'evaluation_dataset_invalid', unexpectedNetworkRequests: 0 });
    expect(await readFile(snapshot, 'utf8')).toBe('{changed-after-check');
    expect(await Bun.file(join(root, 'runs/business/.active-execution.json')).exists()).toBe(false);
    expect(await readdir(join(root, 'runs/business')).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 45000);

for (const kind of ['source', 'manifest'] as const) test(`installed workspace ${kind} copies invalidate Check and require module restart without starting a Trial`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p17-eval-source-copy-')), alias = join(runtime, 'node_modules/@medclaw/core');
  expect((await lstat(alias)).isSymbolicLink()).toBe(true);
  const originalLink = await readlink(alias), canonical = await realpath(join(runtime, 'packages/core'));
  expect(await realpath(alias)).toBe(canonical);
  let removed = false, materialized = false;
  try {
    await configuredMaterials(root);
    await unlink(alias); removed = true; await mkdir(alias); materialized = true;
    await cp(join(canonical, 'src'), join(alias, 'src'), { recursive: true }); await copyFile(join(canonical, 'package.json'), join(alias, 'package.json'));
    const target = join(alias, kind === 'source' ? 'src/application.ts' : 'package.json');
    const change = kind === 'source' ? 'original+"\\n// ENGINEERING changed installed source after Check\\n"'
      : 'JSON.stringify({...JSON.parse(original),description:"ENGINEERING changed installed manifest after Check"})';
    const value = await installed(root, 'const fs=await import("node:fs/promises"),options={datasetId:"medclaw-agent-v1",selection:"smoke",trials:1},check=await service.preflight(options);'
      + 'if(check.blockers.length)throw new Error(JSON.stringify(check.blockers));const target='+JSON.stringify(target)+',original=await fs.readFile(target,"utf8");'
      + 'let changed=null,restored=null;try{await fs.writeFile(target,'+change+');try{await service.prepareRun({...options,preflightId:check.preflightId});}catch(failure){changed=failure.message;}}finally{await fs.writeFile(target,original);}'
      + 'try{await service.prepareRun({...options,preflightId:check.preflightId});}catch(failure){restored=failure.message;}'
      + 'console.log(JSON.stringify({changed,restored,unexpectedNetworkRequests}));');
    expect(value).toEqual({ changed: 'evaluation_runtime_changed', restored: 'evaluation_runtime_changed', unexpectedNetworkRequests: 0 });
    expect(await readdir(join(root, 'runs/business')).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).toEqual([]);
    expect(await readFile(target, 'utf8')).toBe(await readFile(join(canonical, kind === 'source' ? 'src/application.ts' : 'package.json'), 'utf8'));
  } finally {
    if (materialized) { if (await realpath(alias) !== resolve(alias)) throw new Error('ENGINEERING alias cleanup escaped its installed directory'); await rm(alias, { recursive: true, force: true }); }
    if (removed) await symlink(originalLink, alias, 'dir');
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
