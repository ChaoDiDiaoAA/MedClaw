import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { EvaluationController } from '../../apps/desktop/src/main/evaluation-controller';
import { readReport } from '../../agent-eval/src/reports/write';
import type { EvaluationControlView } from '../../packages/contracts/src/evaluation';
import type { HostView } from '../../packages/contracts/src/model';
import { evaluationReply } from '../fixtures/p16-model-response';
import { reportFixture, saveReportFixture } from '../../agent-eval/tests/report-fixture';
import { aggregate } from '../../agent-eval/src/scoring/aggregate';
import { recordFeedback } from '../../agent-eval/src/review/store';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { MainSettings, atomicWriteJson } from '../../apps/desktop/src/main/settings';
import { PublishedSettingsSchema, ModelDirectoryViewSchema } from '../../packages/contracts/src/model';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { memoryAssistant, memoryAt, sqliteHistory } from '../fixtures/p9-memory';
import { publicMethodSchemas } from '../../packages/contracts/src/protocol';

test('p16 actual production compaction reserves admission before await and blocks evaluation with no active Run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-p16-admission-')), entry = join(root, 'production.ts'), sourceRoot = resolve(import.meta.dir, '../..');
  await writeFile(entry, `import {PiAgentRuntime} from ${JSON.stringify(join(sourceRoot, 'packages/runtime-pi/src/agent-runtime.ts'))};
    const describe=PiAgentRuntime.prototype.describe;PiAgentRuntime.prototype.describe=function(model){return {...describe.call(this,model),compaction:{contract:'medclaw.compaction/v1',enabled:false,reserveTokens:256,keepRecentTokens:128}};};
    await import(${JSON.stringify(join(sourceRoot, 'apps/host/src/main.ts'))});`);
  let release!: () => void, entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() { calls++; entered(); await gate;
    return new Response(`data: ${JSON.stringify({ id: 'ENGINEERING', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'ENGINEERING native summary' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }); } });
  const host = new HostController({ dataRoot: join(root, 'production'), hostEntry: entry, bunExecutable: process.execPath, onError: error => console.log('ENGINEERING production diagnostic: ' + error.code), onCredentialRequest: async frame =>
    frame.method === 'export.destination.settlePrevious' ? { ok: true, data: { stopped: true } } : frame.method === 'credential.list' ? { ok: true, data: [{ providerId: 'p16-fixture', type: 'api_key' }] } : frame.method === 'credential.read' ? { ok: true, data: frame.payload.providerId === 'p16-fixture' ? { type: 'api_key', key: 'ENGINEERING' } : null } : { ok: true, data: null } });
  const initial = new MainSettings(host.paths.settingsPath).read();
  atomicWriteJson(host.paths.settingsPath, PublishedSettingsSchema.parse({ ...initial, model: { provider: 'p16-fixture', modelId: 'fixture' }, customProviders: [{ credentialRef: null, definition: { providerId: 'p16-fixture', name: 'ENGINEERING', api: 'openai-completions', baseUrl: server.url.href + 'v1', models: [{ id: 'fixture', name: 'ENGINEERING', input: ['text'], reasoning: false, contextWindow: 4096, maxTokens: 128, outputLimitConfirmed: true, pricingKnown: false, cost: null }] } }] }));
  const db = openDatabase(host.paths.databasePath), history = sqliteHistory(db), repo = new Repositories(db, undefined, undefined, undefined, history.store), manager = SessionManager.inMemory(root);
  manager.appendModelChange('p16-fixture', 'fixture'); manager.appendThinkingLevelChange('off');
  for (let i = 0; i < 6; i++) { manager.appendMessage({ role: 'user', content: 'ENGINEERING ' + 'x'.repeat(160), timestamp: i * 2 + 1 }); manager.appendMessage({ ...memoryAssistant('y'.repeat(160), 'fixture'), provider: 'p16-fixture', timestamp: i * 2 + 2 }); }
  repo.createSession({ expectedWorkspaceRevision: 0 }, 'create', manager.getSessionId(), memoryAt, { header: manager.getHeader(), entries: [], activeLeafId: null });
  history.commitSync({ sessionId: 1, runId: null, expectedStorageVersion: 1, header: manager.getHeader(), newEntries: manager.getEntries(), activeLeafId: manager.getLeafId() }); db.close();
  const evaluator = new EvaluationController({ paths: { sourceRoot, configsRoot: join(root, 'evaluation-configs'), runsRoot: join(root, 'evaluation-runs') }, workerEntry: join(sourceRoot, 'agent-eval/src/desktop/controller.ts'), bunExecutable: process.execPath, production: host });
  let succeeded = false;
  try {
    expect(await host.start()).toMatchObject({ state: 'ready' }); await evaluator.initialize();
    const models = await host.request('model.read', {}); if (!models.ok) throw new Error(models.error.code);
    const payload = { sessionId: 1, expectedStorageVersion: 2, model: { provider: 'p16-fixture', modelId: 'fixture', expectedConfigVersion: ModelDirectoryViewSchema.parse(models.data).configVersion } };
    const compact = evaluator.withProductionAdmission('session.compact', payload, 'p16-manual-compact', () => host.request('session.compact', payload, 'p16-manual-compact'));
    await expect(evaluator.dispatch('eval.start', { datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1, preflightId: crypto.randomUUID() }, crypto.randomUUID())).rejects.toMatchObject({ code: 'runtime_busy' });
    expect(await compact).toMatchObject({ ok: true }); await requested;
    expect(await host.request('run.control.read', {})).toMatchObject({ ok: true, data: { activeRootRun: null, acceptingNewRuns: false } });
    let refusal: unknown;
    try { await evaluator.dispatch('eval.start', { datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1, preflightId: crypto.randomUUID() }, crypto.randomUUID()); }
    catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: 'runtime_busy' });
    expect(evaluator.read().operationRef).toBeNull(); expect(calls).toBe(1);
    expect(await host.request('session.compaction.cancel', { sessionId: 1, operationRef: 'p16-manual-compact' })).toMatchObject({ ok: true }); release();
    const deadline = Date.now() + 10000;
    while (true) { const value = await host.request('session.compaction.read', { sessionId: 1, operationRef: 'p16-manual-compact' }); const receipt = value.ok ? publicMethodSchemas['session.compaction.read'].output.parse(value.data) : null; if (receipt?.status === 'cancelled') break; if (Date.now() > deadline) throw new Error('Production compaction did not stop'); await Bun.sleep(20); }
    const original = await host.request('session.read', { sessionId: 1 }); if (!original.ok) throw new Error(original.error.code);
    const session = publicMethodSchemas['session.read'].output.parse(original.data); if (!session) throw new Error('Original production session is missing');
    expect(await host.request('session.restore', { sessionId: 1, expectedLeafId: session.session.leafId }, 'p16-restore')).toMatchObject({ ok: true });
    expect(await host.request('run.control.read', {})).toMatchObject({ ok: true, data: { acceptingNewRuns: true } });
    expect((await evaluator.shutdown()).controllerExited).toBe(true);
    succeeded = true;
  } finally { release(); await evaluator.shutdown(); if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!); server.stop(true); if (succeeded && host.read().canStart) await rm(root, { recursive: true, force: true }); else console.log('ENGINEERING admission retained: ' + root); }
}, 40000);

test('p16 terminal runs the original Smoke plan through Bun, isolated Host, SDK and SQLite into a readable archive', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'medclaw-p16-terminal-')), sourceRoot = resolve(import.meta.dir, '../..');
  const paths = { sourceRoot, configsRoot: join(temporary, 'configs'), runsRoot: join(temporary, 'runs') };
  const requests: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const url = new URL(request.url); requests.push(url.pathname);
    const body = request.method === 'GET' ? null : await request.json(), reply = evaluationReply(url.pathname, body);
    return 'json' in reply ? Response.json(reply.json) : new Response(reply.stream, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const production: HostView = { instanceId: null, state: 'stopped', canStart: true, sdkVersion: null, schemaVersion: null, error: null };
  let finish!: (view: EvaluationControlView) => void;
  const finished = new Promise<EvaluationControlView>(resolve => { finish = resolve; });
  const controller = new EvaluationController({ paths, workerEntry: join(sourceRoot, 'agent-eval/src/desktop/controller.ts'), bunExecutable: process.execPath,
    production: { read: () => production, request: async () => { throw new Error('Production execution is forbidden in this isolated terminal test'); } },
    notify: notice => { if (notice.type === 'eval.status' && ['settled', 'unknown'].includes(notice.control.state)) finish(notice.control); } });
  const operationRef = 'dc66acf1-0b54-48c4-a344-27cae405a110', executionId = 'desktop-' + operationRef;
  let copied = false;
  try {
    await mkdir(paths.configsRoot, { recursive: true });
    await writeFile(join(paths.configsRoot, 'agent.json'), JSON.stringify({ version: 1, environment: 'test', model: { url: new URL('/agent/v1', server.url).href, key: 'controlled-agent-key', model: 'openai/gpt-4o-mini' },
      intent: { baseUrl: server.url.href, model: 'qwen3.5:0.8b' }, policy: {}, retention: 'preserve_all' }));
    await writeFile(join(paths.configsRoot, 'environment'), `MEDCLAW_JUDGE_BASE_URL=${new URL('/judge/v1', server.url).href}\nMEDCLAW_JUDGE_MODEL=openai/gpt-4o-mini\nMEDCLAW_JUDGE_API_KEY=controlled-judge-key\n`);
    const preflight = await controller.dispatch('eval.preflight', { datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1 }, crypto.randomUUID());
    expect(preflight).toMatchObject({ cases: 10, plannedTrials: 10, blockers: [] }); expect(requests).toEqual([]);
    const options = { datasetId: preflight.datasetId, selection: preflight.selection, trials: preflight.trials, preflightId: preflight.preflightId };
    expect(await controller.dispatch('eval.start', options, operationRef)).toMatchObject({ executionId, accepted: true });
    const final = await finished;
    expect(final).toMatchObject({ state: 'settled', executionId, stopConfirmed: true, saveConfirmed: true, progressCounts: { planned: 10, saved: 10 } });
    const root = join(paths.runsRoot, 'business', executionId), report = await readReport(root);
    expect(report.plan).toHaveLength(10); expect(report.trials).toHaveLength(10);
    expect(report.snapshot.desktopRequest).toMatchObject({ operationRef, datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1 });
    expect(report.snapshot.qualityMetricCatalogVersion).toBe('v2');
    expect(requests.some(path => path.startsWith('/agent/'))).toBe(true);
    expect(report.trials.some(trial => trial.status === 'completed')).toBe(true);
    const observation = JSON.parse(await readFile(join(root, report.trials[0]!.observationRef!), 'utf8'));
    expect(observation.facts.modelCalls.some((call: { state: string }) => call.state === 'completed')).toBe(true);
    expect(observation.facts.toolCalls.some((call: { name: string }) => call.name === 'read_data_scope')).toBe(true);
    expect(new Set(report.judgeCalls.map(call => call.trialId)).size).toBe(report.judgeCalls.length);
    expect(report.judgeCalls.length).toBeLessThanOrEqual(report.trials.filter(trial => trial.status === 'completed').length);
    for (const trial of report.trials.filter(trial => trial.startedAt)) {
      const original = JSON.parse(await readFile(join(root, 'evidence', trial.trialId, 'trial.json'), 'utf8'));
      expect(original.lifecycle.shutdown).toMatchObject({ stopped: true, closed: true, processExited: true, residuals: [] });
    }
    expect(await controller.dispatch('eval.start', options, operationRef)).toMatchObject({ executionId, accepted: true });
    expect((await controller.dispatch('eval.report.list', {}, crypto.randomUUID())).items.map(item => item.executionId)).toEqual([executionId]);
    const evidence = join(sourceRoot, 'test-results', 'p16-terminal', crypto.randomUUID());
    await cp(root, evidence, { recursive: true, errorOnExist: true, force: false });
    await writeFile(join(evidence, 'engineering-requests.json'), JSON.stringify({ context: 'Loopback engineering services; no real quality claim', requests })); copied = true;
    console.log('ENGINEERING original Smoke archive: ' + evidence);
  } finally {
    const proof = await controller.shutdown(); server.stop(true);
    expect(proof).toMatchObject({ stopConfirmed: true, saveConfirmed: true, controllerExited: true });
    const target = resolve(temporary);
    if (copied && proof.stopConfirmed === true && proof.saveConfirmed === true && proof.controllerExited && target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('medclaw-p16-terminal-')) await rm(target, { recursive: true, force: true });
  }
}, 120000);

for (const method of ['eval.resend', 'eval.review.sync'] as const) for (const window of ['before_http', 'after_response', 'after_checkpoint'] as const) {
  test('p16 platform process ' + method + ' ' + window + ' preserves durable receipts and explicitly resumes with original IDs', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'medclaw-p16-platform-exit-')), sourceRoot = resolve(import.meta.dir, '../..');
    const paths = { sourceRoot, configsRoot: join(temporary, 'configs'), runsRoot: join(temporary, 'runs') };
    const report = reportFixture(), trial = report.trials[0]!, root = join(paths.runsRoot, 'business', report.executionId);
    Object.assign(trial, { status: 'completed', instanceId: 'controlled-host', startedAt: report.createdAt, endedAt: report.createdAt,
      stopped: true, closed: true, observationRef: 'evidence/' + trial.trialId + '/observation.json' });
    const aggregation = aggregate(report.plan, report.trials, report.scores, report.cases); report.aggregation = aggregation; report.totals = aggregation.totals;
    await saveReportFixture(root, report, { [trial.trialId]: { executionId: report.executionId, trialId: trial.trialId, instanceId: trial.instanceId,
      observedFrom: report.createdAt, observedUntil: report.createdAt, identityChecks: [], missing: [], facts: { modelCalls: [{ id: 1, runId: 2, startedAt: report.createdAt, endedAt: report.createdAt }] } } });
    if (method === 'eval.review.sync') for (let index = 0; index < 2; index++) await recordFeedback(root, { contract: 'medclaw-human-feedback/v1', executionId: report.executionId,
      caseId: trial.caseId, trialId: trial.trialId, source: 'local', sourceId: 'engineering-review-' + index, reviewer: 'Engineering reviewer', reviewedAt: report.createdAt,
      status: 'UNJUDGEABLE', comment: 'Engineering feedback; no real quality claim', evidenceRefs: [] });
    const originalReport = await readFile(join(root, 'report.json')), originalSnapshot = await readFile(join(root, 'snapshot.json'));
    const requests: { path: string; body: any }[] = [], fault = join(temporary, 'process-fault.json'), forbidden = join(temporary, 'model-or-scoring-called');
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const path = new URL(request.url).pathname, body = await request.json() as any;
      requests.push({ path, body });
      if (!path.startsWith('/api/public/')) throw new Error('Only loopback platform requests are permitted');
      return Response.json(path === '/api/public/scores' ? { id: body.id } : {});
    } });
    await mkdir(paths.configsRoot, { recursive: true });
    await writeFile(join(paths.configsRoot, 'environment'), `LANGFUSE_BASE_URL=${server.url.href}\nLANGFUSE_PUBLIC_KEY=controlled-public\nLANGFUSE_SECRET_KEY=controlled-private\nMEDCLAW_LANGFUSE_SERVER_VERSION=controlled\n`);
    const entry = join(temporary, 'platform-worker.ts');
    await writeFile(entry, `import {spyOn} from 'bun:test';import {writeFileSync,existsSync} from 'node:fs';
      import * as files from ${JSON.stringify(join(sourceRoot, 'agent-eval/src/reports/write.ts').replaceAll('\\', '/'))};
      import * as runner from ${JSON.stringify(join(sourceRoot, 'agent-eval/src/execution/runner.ts').replaceAll('\\', '/'))};
      import * as scoring from ${JSON.stringify(join(sourceRoot, 'agent-eval/src/scoring/evaluate.ts').replaceAll('\\', '/'))};
      import {runEvaluationControlProcess} from ${JSON.stringify(join(sourceRoot, 'agent-eval/src/desktop/controller.ts').replaceAll('\\', '/'))};
      for(const [module,name] of [[runner,'runExperiment'],[scoring,'evaluate']])spyOn(module,name).mockImplementation(()=>{writeFileSync(${JSON.stringify(forbidden)},name);throw new Error('Models and rescoring are forbidden');});
      const original=files.replaceJson;spyOn(files,'replaceJson').mockImplementation(async(path,value)=>{
        const receipts=value?.contract==='medclaw-export-state/v1'?value.state.receipts:value?.contract==='medclaw-review/v1'?value.receipts.findLast(item=>item.kind==='sync')?.receipts:[];
        const first=receipts?.[0],state=${JSON.stringify(window)}==='before_http'?'unknown':'accepted';
        if(!existsSync(${JSON.stringify(fault)})&&receipts?.length===1&&first.state===state){
          if(${JSON.stringify(window)}!=='after_response')await original(path,value);
          writeFileSync(${JSON.stringify(fault)},JSON.stringify({pid:process.pid,window:${JSON.stringify(window)},eventId:first.eventId??first.id}));process.exit(88);
        }
        return original(path,value);
      });await runEvaluationControlProcess();`);
    const production: HostView = { instanceId: null, state: 'stopped', canStart: true, sdkVersion: null, schemaVersion: null, error: null };
    let crashed!: () => void, finished!: () => void;
    const exited = new Promise<void>(resolve => { crashed = resolve; }), done = new Promise<void>(resolve => { finished = resolve; });
    const controller = (notify: (view: EvaluationControlView) => void) => new EvaluationController({ paths, workerEntry: entry, bunExecutable: process.execPath,
      production: { read: () => production, request: async () => { throw new Error('Production execution is forbidden'); } },
      notify: notice => { if (notice.type === 'eval.status') notify(notice.control); } });
    const first = controller(view => { if (view.state === 'unknown' && view.controllerExited) crashed(); });
    let reopened: EvaluationController | null = null, succeeded = false;
    try {
      let acceptance: unknown;
      try { acceptance = await first.dispatch(method, { executionId: report.executionId }, crypto.randomUUID()); }
      catch (error) { expect((error as { code: string }).code).toBe('host_interrupted'); }
      if (acceptance) expect(acceptance).toMatchObject({ accepted: true, executionId: report.executionId });
      await exited;
      expect(first.read()).toMatchObject({ state: 'unknown', controllerExited: true });
      expect((await first.shutdown()).controllerExited).toBe(true);
      expect(await Bun.file(fault).exists()).toBe(true); expect(await Bun.file(forbidden).exists()).toBe(false);
      const previousRequests = requests.length;
      expect(previousRequests).toBe(window === 'before_http' ? 0 : 1);
      reopened = controller(view => { if (view.state === 'settled' || view.state === 'unknown') finished(); });
      const kind = method === 'eval.resend' ? 'resend' : 'review_sync';
      const before = await reopened.dispatch('eval.status', { executionId: report.executionId, platform: kind }, crypto.randomUUID());
      if (!before.result || before.result.kind === 'run') throw new Error('Missing original platform state');
      const planned = before.result.platform.receipts.total + before.result.platform.remaining;
      expect(planned).toBeGreaterThan(1);
      expect(before.result.platform).toMatchObject({ accepted: window === 'after_checkpoint' ? 1 : 0, unknown: window === 'after_checkpoint' ? 0 : 1, remaining: planned - 1 });
      expect(requests).toHaveLength(previousRequests);
      const identities = JSON.parse(await readFile(join(root, 'export.json'), 'utf8')).envelope.identities;
      await reopened.dispatch(method, { executionId: report.executionId }, crypto.randomUUID()); await done;
      const after = await reopened.dispatch('eval.status', {}, crypto.randomUUID());
      if (!after.result || after.result.kind === 'run') throw new Error('Missing resumed platform state');
      expect(after.result.platform).toMatchObject({ state: 'complete', accepted: planned, unknown: 0, remaining: 0 });
      expect(requests).toHaveLength(previousRequests + planned - (window === 'after_checkpoint' ? 1 : 0));
      expect(JSON.parse(await readFile(join(root, 'export.json'), 'utf8')).envelope.identities).toEqual(identities);
      expect((await readFile(join(root, 'report.json'))).equals(originalReport)).toBe(true);
      expect((await readFile(join(root, 'snapshot.json'))).equals(originalSnapshot)).toBe(true);
      expect(await Bun.file(forbidden).exists()).toBe(false);
      const evidence = join(sourceRoot, 'test-results', 'p16-platform-process', crypto.randomUUID());
      await cp(root, evidence, { recursive: true, errorOnExist: true, force: false });
      await writeFile(join(evidence, 'engineering-process-fault.json'), await readFile(fault));
      await writeFile(join(evidence, 'engineering-platform-requests.json'), JSON.stringify(requests));
      console.log('ENGINEERING platform process archive: ' + evidence); succeeded = true;
    } finally {
      await first.shutdown(); const proof = await reopened?.shutdown(); server.stop(true);
      const target = resolve(temporary);
      if (succeeded && proof?.controllerExited && proof.stopConfirmed === true && proof.saveConfirmed === true && target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('medclaw-p16-platform-exit-')) await rm(target, { recursive: true, force: true });
      else console.log('ENGINEERING failed platform process root retained: ' + target);
    }
  }, 60000);
}
