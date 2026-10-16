import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, unlinkSync, rmdirSync, renameSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { launchActualDev } from './desktop-dev';
import { execFileSync } from 'node:child_process';
import { evaluationReply } from './p16-model-response';

export async function launchEvaluationDesktop(options: { configured?: boolean; productionCompaction?: boolean; holdAgent?: boolean; holdJudge?: boolean; holdCollect?: boolean; holdSave?: boolean; holdPreflight?: boolean; reports?: boolean; largeReports?: boolean; holdReport?: string; holdReply?: 'eval.compare' | 'eval.evidence.read'; platform?: boolean; holdPlatform?: boolean; holdFeedback?: boolean; feedbackHistory?: number; feedbackConflict?: boolean; fault?: 'after_trial_save' | 'scoring_save' | 'worker_exit'; sourceChange?: boolean } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'medclaw-p16-ui-')), dataRoot = join(temporary, 'production');
  const requests: { kind: 'agent' | 'judge' | 'intent' | 'platform'; body: unknown }[] = [];
  const originals = new Map<string, Buffer>();
  let releaseAgent!: () => void;
  const agentGate = new Promise<void>(resolve => { releaseAgent = resolve; });
  if (!options.holdAgent) releaseAgent();
  let releaseJudge!: () => void;
  const judgeGate = new Promise<void>(resolve => { releaseJudge = resolve; }); if (!options.holdJudge) releaseJudge();
  let releasePlatform!: () => void;
  const platformGate = new Promise<void>(resolve => { releasePlatform = resolve; }); if (!options.holdPlatform) releasePlatform();
  const server = options.configured || options.platform ? createServer(async (request, response) => {
    const kind = request.url?.startsWith('/api/public/') ? 'platform' : request.url?.startsWith('/judge/') ? 'judge' : request.url?.startsWith('/api/') ? 'intent' : 'agent';
    let text = ''; for await (const chunk of request) text += chunk;
    let body: unknown; try { body = text ? JSON.parse(text) : null; } catch { response.writeHead(400).end(); return; }
    requests.push({ kind, body });
    if (kind === 'platform') { await platformGate; if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(request.url === '/api/public/scores' && body && typeof body === 'object' && 'id' in body ? { id: body.id } : {})); return; }
    if (kind === 'agent') await agentGate;
    if (kind === 'judge') await judgeGate;
    if (response.destroyed) return;
    const reply = evaluationReply(request.url!, body);
    response.writeHead(200, { 'content-type': 'json' in reply ? 'application/json' : 'text/event-stream' });
    response.end('json' in reply ? JSON.stringify(reply.json) : reply.stream);
  }) : null;
  const preflightRelease = join(temporary, 'release-preflight'), preflightEntered = join(temporary, 'preflight-entered');
  const reportRelease = join(temporary, 'release-report'), reportEntered = join(temporary, 'report-entered');
  const feedbackRelease = join(temporary, 'release-feedback'), feedbackEntered = join(temporary, 'feedback-entered');
  const faultWindow = join(temporary, 'fault-window.json'), crashRequest = join(temporary, 'crash-main'), quitObserved = join(temporary, 'quit-observed');
  const sourceChange = join(temporary, 'controlled-source-change');
  const collectEntered = join(temporary, 'collect-entered'), collectRelease = join(temporary, 'release-collect');
  const saveEntered = join(temporary, 'save-entered'), saveRelease = join(temporary, 'release-save');
  const stopServer = async () => { if (server?.listening) await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); };
  const cleanup = () => {
    const target = resolve(temporary);
    if (existsSync(join(target, 'dev-exit-confirmed')) && target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('medclaw-p16-ui-')) rmSync(target, { recursive: true, force: true });
  };
  try {
    if (options.reports) {
      execFileSync('bun', ['--no-env-file', '-e', `
        import {reportFixture,saveReportFixture} from './agent-eval/tests/report-fixture.ts';
        import {qualityMetricCatalog} from './agent-eval/src/scoring/registry.ts';
        import {aggregate} from './agent-eval/src/scoring/aggregate.ts';
        import {recordFeedback} from './agent-eval/src/review/store.ts';
        import {join} from 'node:path'; import {unlink,writeFile} from 'node:fs/promises';
        for(const id of ['legacy-report','current-report','compatible-report','partial-report','corrupt-report',...(${options.largeReports === true} ? ['paged-report','oversized-item-report'] : [])]) {
          const report=reportFixture(); report.executionId=id;report.snapshot.executionId=id;
          if(id!=='legacy-report'){report.snapshot.qualityMetricCatalogVersion='v2';report.snapshot.qualityMetricCatalog=qualityMetricCatalog('v2');}
          report.snapshot.plan=[...report.plan];
          if(id==='paged-report'){
            const first=report.trials[0],scores=[...report.scores];
            for(let repetition=2;repetition<=3;repetition++){
              const trialId=first.caseId+'-r'+repetition;report.plan.push({caseId:first.caseId,trialId,repetition});
              report.trials.push({...first,trialId,repetition});report.scores.push(...scores.map(score=>({...score,trialId,scope:{...score.scope,ref:trialId}})));
            }
            report.snapshot.plan=[...report.plan];for(const score of report.scores)score.actual='界'.repeat(30000);
          }
          if(id==='oversized-item-report')report.scores[0].missing=Array(1200).fill('x'.repeat(4000));
          const observations={};
          if(id==='current-report'){
            const trial=report.trials[0];Object.assign(trial,{status:'infra_error',instanceId:'engineering-report-host',startedAt:report.createdAt,endedAt:report.createdAt,stopped:true,closed:true,observationRef:'evidence/'+trial.trialId+'/observation.json'});
            report.scores[0].evidenceRefs=['query:42:page:1'];
            observations[trial.trialId]={executionId:id,trialId:trial.trialId,instanceId:trial.instanceId,observedFrom:report.createdAt,observedUntil:report.createdAt,identityChecks:[],missing:[],facts:{queryPages:[{query:{id:42,batchIds:[]},page:{page:1,rows:[{sourceId:'synthetic-source',value:'selected-original-evidence'}]}}],providerRequests:[{key:'never-show-provider-key'}]}};
          }
          const aggregation=aggregate(report.plan,report.trials,report.scores,report.cases,report.snapshot.criteria);report.aggregation=aggregation;report.totals=aggregation.totals;
          const root=join(Bun.argv.at(-1),'evaluation-runs','business',id);
          await saveReportFixture(root,report,observations);
          if(id==='partial-report'){
            report.snapshot.plan.push({...report.plan[0],trialId:report.plan[0].caseId+'-r2',repetition:2});
            await writeFile(join(root,'snapshot.json'),JSON.stringify(report.snapshot));await unlink(join(root,'report.json'));
          }
          if(id==='corrupt-report')await writeFile(join(root,'report.json'),'{');
          if(id==='current-report')for(let index=0;index<${options.feedbackHistory ?? 0};index++)await recordFeedback(root,{contract:'medclaw-human-feedback/v1',executionId:id,caseId:report.plan[0].caseId,trialId:report.plan[0].trialId,source:'local',sourceId:'engineering-feedback-'+index,reviewer:'Engineering reviewer',status:'UNJUDGEABLE',comment:'Original engineering review '+index,reviewedAt:report.createdAt,evidenceRefs:[]});
          if(id==='current-report'&&${options.feedbackConflict === true})try{await recordFeedback(root,{contract:'medclaw-human-feedback/v1',executionId:id,caseId:report.plan[0].caseId,trialId:report.plan[0].trialId,source:'local',sourceId:'engineering-feedback-0',reviewer:'Engineering reviewer',status:'FAIL',comment:'Preserved conflicting engineering review',reviewedAt:report.createdAt,evidenceRefs:[]});throw new Error('Expected source conflict');}catch(error){if(error.message!=='feedback_conflict_preserved')throw error;}
        }
      `, temporary], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', stdio: 'pipe' });
    }
    if (server) {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing controlled service address');
      const baseUrl = 'http://127.0.0.1:' + address.port, configs = join(temporary, 'evaluation-configs');
      mkdirSync(configs, { recursive: true });
      if (options.configured) writeFileSync(join(configs, 'agent.json'), JSON.stringify({ version: 1, environment: 'test', model: { url: baseUrl + '/agent/v1', key: 'controlled-agent-key', model: 'openai/gpt-4o-mini' },
        intent: { baseUrl, model: 'qwen3.5:0.8b' }, policy: {}, retention: 'preserve_all' }));
      writeFileSync(join(configs, 'environment'), `MEDCLAW_JUDGE_BASE_URL=${baseUrl}/judge/v1\nMEDCLAW_JUDGE_MODEL=openai/gpt-4o-mini\nMEDCLAW_JUDGE_API_KEY=controlled-judge-key\n` + (options.platform ? `LANGFUSE_BASE_URL=${baseUrl}\nLANGFUSE_PUBLIC_KEY=controlled-public\nLANGFUSE_SECRET_KEY=controlled-private\nMEDCLAW_LANGFUSE_SERVER_VERSION=controlled\n` : ''));
    }
    let observer: string | undefined;
    let faultSetup = '';
    if (options.fault || options.sourceChange || options.holdCollect || options.holdSave) {
      const preload = join(temporary, 'evaluation-fault.ts'), workerEntry = resolve(import.meta.dirname, '../../agent-eval/src/desktop/controller.ts');
      writeFileSync(preload, `import {spyOn} from 'bun:test';import * as runner from ${JSON.stringify(resolve(import.meta.dirname, '../../agent-eval/src/execution/runner.ts').replaceAll('\\', '/'))};
        import * as doctor from ${JSON.stringify(resolve(import.meta.dirname, '../../agent-eval/src/doctor.ts').replaceAll('\\', '/'))};
        import {existsSync} from 'node:fs';const originalSource=doctor.sourceInventory;
        if(${options.sourceChange === true})spyOn(doctor,'sourceInventory').mockImplementation(async()=>{const source=await originalSource();return existsSync(${JSON.stringify(sourceChange)})?{...source,sdk:'ENGINEERING changed runtime descriptor'}:source;});
        import * as observe from ${JSON.stringify(resolve(import.meta.dirname, '../../agent-eval/src/execution/observe.ts').replaceAll('\\', '/'))};const originalCollect=observe.collectObservation;let collecting=false;
        if(${options.holdCollect === true})spyOn(observe,'collectObservation').mockImplementation(async input=>{if(!collecting){collecting=true;writeFileSync(${JSON.stringify(collectEntered)},JSON.stringify({executionId:input.executionId,trialId:input.trialId}));
          await new Promise(resolve=>{const timer=setInterval(()=>{if(existsSync(${JSON.stringify(collectRelease)})){clearInterval(timer);resolve();}},20);timer.unref();});}return originalCollect(input);});
        import * as promises from 'node:fs/promises';const originalAppend=promises.appendFile;let saving=false;
        if(${options.holdSave === true})spyOn(promises,'appendFile').mockImplementation(async(...args)=>{if(!saving&&typeof args[1]==='string'&&args[1].includes('"kind":"scoring.completed"')){saving=true;writeFileSync(${JSON.stringify(saveEntered)},'necessary scoring save has not completed');
          await new Promise(resolve=>{const timer=setInterval(()=>{if(existsSync(${JSON.stringify(saveRelease)})){clearInterval(timer);resolve();}},20);timer.unref();});}return originalAppend(...args);});
        import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';import {join} from 'node:path';const original=runner.runExperiment;
        if(${options.fault !== undefined})spyOn(runner,'runExperiment').mockImplementation(options=>original({...options,onEvent(event){options.onEvent?.(event);
          if(event.index!==1||(${JSON.stringify(options.fault)}==='scoring_save'?event.kind!=='phase'||event.phase!=='save':event.kind!=='saved'))return;
          const directory=join(options.runsRoot,options.executionId,'evidence',event.trialId),trial=JSON.parse(readFileSync(join(directory,'trial.json'),'utf8'));
          const proof=trial.lifecycle?.shutdown;if(!proof?.stopped||!proof.closed||!proof.processExited||proof.residuals.length)throw new Error('Fault window has an active Trial');
          if(${JSON.stringify(options.fault)}==='scoring_save'){renameSync(join(directory,'events.jsonl'),join(directory,'events.before-save.jsonl'));mkdirSync(join(directory,'events.jsonl'));}
          writeFileSync(${JSON.stringify(faultWindow)},JSON.stringify({pid:process.pid,executionId:options.executionId,trialId:event.trialId,mode:${JSON.stringify(options.fault)}}));
          if(${JSON.stringify(options.fault)}==='worker_exit')process.exit(88);
          if(${JSON.stringify(options.fault)}==='after_trial_save')throw new Error('Controlled failure after the first durable Trial');
        }}));`);
      faultSetup = `const cp=require('node:child_process'),spawn=cp.spawn;cp.spawn=function(command,args,options){
        const evaluation=Array.isArray(args)&&args.includes(${JSON.stringify(workerEntry)}),host=Array.isArray(args)&&args.includes(${JSON.stringify(resolve(import.meta.dirname, '../../apps/host/src/main.ts'))});
        const child=spawn.call(this,command,evaluation?['--preload',${JSON.stringify(preload)},...args]:args,options);
        if(evaluation||host)fs.appendFileSync(${JSON.stringify(join(temporary, 'spawned-processes.jsonl'))},JSON.stringify({pid:child.pid,kind:evaluation?'evaluation':'production'})+'\\n');return child;};
        app.on('before-quit',()=>fs.writeFileSync(${JSON.stringify(quitObserved)},'observed'));
        const crash=setInterval(()=>{if(fs.existsSync(${JSON.stringify(crashRequest)}))process.exit(77);},20);crash.unref();`;
    }
    if (options.holdPreflight || options.holdReport || options.holdReply || options.holdFeedback || options.fault || options.sourceChange || options.holdCollect || options.holdSave) {
      observer = join(temporary, 'hold-preflight.cjs');
      writeFileSync(observer, `module.exports=({ipcMain,app})=>{const fs=require('fs'),original=ipcMain.handle;let held=false,reportHeld=false,feedbackHeld=false;${faultSetup}
        ipcMain.handle=function(channel,handler){return original.call(this,channel,async(...args)=>{const result=await handler(...args);
          if(${options.holdPreflight === true}&&channel==='medclaw:request'&&args[1]?.method==='eval.preflight'&&!held){held=true;fs.writeFileSync(${JSON.stringify(preflightEntered)},'entered');
            await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(preflightRelease)})){clearInterval(timer);resolve();}},20);timer.unref();});}
          if(channel==='medclaw:request'&&((args[1]?.method==='eval.report.read'&&args[1]?.payload?.executionId===${JSON.stringify(options.holdReport ?? '')})||args[1]?.method===${JSON.stringify(options.holdReply ?? '')})&&!reportHeld){reportHeld=true;fs.writeFileSync(${JSON.stringify(reportEntered)},'entered');
            await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(reportRelease)})){clearInterval(timer);resolve();}},20);timer.unref();});}
          if(${options.holdFeedback === true}&&channel==='medclaw:request'&&args[1]?.method==='eval.review.record'&&!feedbackHeld){feedbackHeld=true;fs.writeFileSync(${JSON.stringify(feedbackEntered)},'entered');
            await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(feedbackRelease)})){clearInterval(timer);resolve();}},20);timer.unref();});}
          return result;});};};`);
    }
    const archiveRoot = join(temporary, 'evaluation-runs');
    if (options.reports) for (const entry of readdirSync(archiveRoot, { recursive: true, withFileTypes: true })) if (entry.isFile()) { const path = join(entry.parentPath, entry.name); if (!['review.json', 'export.json'].includes(entry.name)) originals.set(path, readFileSync(path)); }
    const productionEntry = options.productionCompaction ? join(temporary, 'production-compaction.ts') : undefined;
    if (productionEntry) writeFileSync(productionEntry, `import {PiAgentRuntime} from ${JSON.stringify(resolve(import.meta.dirname, '../../packages/runtime-pi/src/agent-runtime.ts'))};
      const describe=PiAgentRuntime.prototype.describe;PiAgentRuntime.prototype.describe=function(model){return {...describe.call(this,model),compaction:{contract:'medclaw.compaction/v1',enabled:false,reserveTokens:256,keepRecentTokens:128}};};
      await import(${JSON.stringify(resolve(import.meta.dirname, '../../apps/host/src/main.ts'))});`);
    let desktop = await launchActualDev(temporary, dataRoot, undefined, undefined, productionEntry, observer), crashed = false;
    return { get page() { return desktop.page; }, get browser() { return desktop.browser; }, get child() { return desktop.child; },
      temporary, dataRoot, runsRoot: join(temporary, 'evaluation-runs'), requests, releaseAgent, releaseJudge, originals, releasePlatform, faultWindow, quitObserved,
      preflightEntered, releasePreflight() { writeFileSync(preflightRelease, 'release'); },
      reportEntered, releaseReport() { writeFileSync(reportRelease, 'release'); },
      feedbackEntered, releaseFeedback() { writeFileSync(feedbackRelease, 'release'); },
      sourceChange,
      collectEntered, releaseCollect() { writeFileSync(collectRelease, 'release'); },
      saveEntered, releaseSave() { writeFileSync(saveRelease, 'release'); },
      requestQuit() { writeFileSync(join(temporary, 'request-dev-quit'), 'quit'); },
      restoreScoringFile() {
        const fault = JSON.parse(readFileSync(faultWindow, 'utf8')); if (fault.mode !== 'scoring_save' || !/^desktop-[0-9a-f-]{36}$/.test(fault.executionId) || !/^[a-zA-Z0-9_-]+$/.test(fault.trialId)) throw new Error('Wrong owned scoring fault');
        const directory = join(temporary, 'evaluation-runs/business', fault.executionId, 'evidence', fault.trialId);
        rmdirSync(join(directory, 'events.jsonl')); renameSync(join(directory, 'events.before-save.jsonl'), join(directory, 'events.jsonl'));
      },
      async crashMain() {
        if (!options.fault || desktop.child.exitCode !== null) throw new Error('No live owned fault application');
        const fault = JSON.parse(readFileSync(faultWindow, 'utf8')); if (!/^desktop-[0-9a-f-]{36}$/.test(fault.executionId) || !/^[a-zA-Z0-9_-]+$/.test(fault.trialId)) throw new Error('Wrong owned fault identity');
        const evidence = join(temporary, 'evaluation-runs/business', fault.executionId, 'evidence');
        const original = JSON.parse(readFileSync(join(evidence, fault.trialId, 'trial.json'), 'utf8')), proof = original.lifecycle?.shutdown;
        if (readdirSync(evidence, { withFileTypes: true }).filter(item => item.isDirectory()).length !== 1 || !proof?.stopped || !proof.closed || !proof.processExited || proof.residuals.length) throw new Error('Cannot crash with unconfirmed Trial processes');
        writeFileSync(crashRequest, 'crash');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([new Promise<void>(resolve => desktop.child.once('exit', () => resolve())), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned abnormal exit unconfirmed')), 15000); })]); }
        finally { clearTimeout(timer); }
        if (desktop.child.exitCode !== 77) throw new Error('Unexpected owned abnormal exit'); crashed = true;
        await desktop.browser.close();
      },
      async relaunch() {
        if (!crashed || desktop.child.exitCode === null) throw new Error('Original fault application is not terminal');
        for (const path of [crashRequest, join(temporary, 'request-dev-quit'), quitObserved]) if (existsSync(path)) unlinkSync(path);
        desktop = await launchActualDev(temporary, dataRoot, undefined, undefined, productionEntry, observer); crashed = false; return desktop.page;
      },
      async close() { releaseAgent(); releaseJudge(); releasePlatform(); writeFileSync(collectRelease, 'release'); writeFileSync(saveRelease, 'release'); writeFileSync(preflightRelease, 'release'); writeFileSync(reportRelease, 'release'); writeFileSync(feedbackRelease, 'release'); try { if (!crashed) { await desktop.close(); cleanup(); } } finally { await stopServer(); } } };
  } catch (error) { releaseAgent(); releaseJudge(); releasePlatform(); writeFileSync(collectRelease, 'release'); writeFileSync(saveRelease, 'release'); writeFileSync(preflightRelease, 'release'); writeFileSync(reportRelease, 'release'); writeFileSync(feedbackRelease, 'release'); await stopServer(); cleanup(); throw error; }
}
