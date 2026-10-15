import {expect,test} from 'bun:test';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadDataset,loadSnapshot,snapshotCompiled} from '../../src/datasets.ts';
import {scoringCriteria} from '../../src/scoring/registry.ts';
import {resolveRunConfig,JudgeClient} from '../../src/scoring/judges/client.ts';
import {runExperiment,planTrials} from '../../src/execution/runner.ts';
import {terminalProgress} from '../../src/terminal.ts';
import {readReport,writeJsonExclusive} from '../../src/reports/write.ts';
import {within} from '../../src/adapters/files.ts';

test('controlled Host, native public read, one Judge per Trial and durable staged output use the exact archive layout',async()=>{
  const seen:{path:string;body:any}[]=[],lines:string[]=[],order:string[]=[],savedJournals:string[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/api/version')return Response.json({version:'ENGINEERING'});
    if(path==='/api/tags')return Response.json({models:[{name:'qwen3.5:0.8b'}]});
    if(path==='/api/show')return Response.json({details:{family:'ENGINEERING',parameter_size:'fixture',quantization_level:'fixture'}});
    if(!path.endsWith('/chat/completions'))throw new Error('unexpected_local_route');
    const body=await request.json() as any;seen.push({path,body});
    let delta:any,finish_reason='stop';
    if(path.startsWith('/judge/')) {
      const content=body.messages.find((message:any)=>message.role==='user').content;
      const judged=JSON.parse(typeof content==='string'?content:content[0].text);
      delta={role:'assistant',content:JSON.stringify({results:judged.checks.map((check:any)=>({checkId:check.checkId,value:null,reason:'ENGINEERING: no real business query was performed.',evidenceRefs:check.evidenceRefs.slice(0,1)}))})};
    } else if(body.messages.some((message:any)=>message.role==='tool'))delta={role:'assistant',content:'ENGINEERING source-audit read acknowledged. No business query was performed; no quality claim.'};
    else {
      const message=body.messages.find((message:any)=>JSON.stringify(message.content).includes('Public attachments'));
      const text=typeof message.content==='string'?message.content:message.content.find((part:any)=>part.type==='text').text;
      const files=JSON.parse(text.slice(text.indexOf('\n[')+1)),file=files.find((file:any)=>file.ref==='materials/source-audit.md');
      expect(await readFile(file.path,'utf8')).toContain('Synthetic source audit');
      delta={role:'assistant',tool_calls:[{index:0,id:'controlled-read',type:'function',function:{name:'read',arguments:JSON.stringify({path:file.path})}}]};finish_reason='tool_calls';
    }
    return new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}],usage:{prompt_tokens:100,completion_tokens:50}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  const root=await mkdtemp(join(tmpdir(),'mc-terminal-flow-')),runsRoot=join(root,'runs'),executionId='controlled-terminal-flow';
  let stopped=false;
  try {
    const built=await loadDataset(),tasks=['mc-v1-resource-progressive-read','mc-v1-security-injection'].map(id=>structuredClone(built.snapshot.cases.find(item=>item.id===id)!));
    const snapshot=structuredClone(built.snapshot);snapshot.info.id='controlled-terminal-v1';snapshot.cases=tasks;snapshot.smokeIds=tasks.map(task=>task.id);snapshot.gold=Object.fromEntries(tasks.map(task=>[task.id,snapshot.gold[task.id]!]));snapshot.review.cases=Object.fromEntries(tasks.map(task=>[task.id,snapshot.review.cases[task.id]]));snapshot.review.state='pending';delete snapshot.review.verifiedData;
    // This fixture explicitly tests the Judge channel; production read-only cases need no semantic check.
    for(const task of tasks){
      task.scorers.push('answer.reasoning');snapshot.review.cases[task.id]!.authoring!.harness.push('answer.reasoning');
      (snapshot.gold[task.id]!.rubric??={})['answer.reasoning']={pass:'ENGINEERING: reasoning follows actual public material.',partial:'ENGINEERING: incomplete explanation.',fail:'ENGINEERING: unsupported reasoning. The loopback Judge returns unknown and makes no quality claim.'};
    }
    const draft=loadSnapshot(snapshot);
    snapshot.review.verifiedData={info:snapshot.info,smokeIds:snapshot.smokeIds,cases:snapshot.cases,gold:snapshot.gold,fixtures:snapshot.fixtures,sourceReferences:snapshot.sourceReferences,productResources:snapshot.productResources,authoring:Object.fromEntries(tasks.map(task=>[task.id,snapshot.review.cases[task.id].authoring])),compiled:snapshotCompiled(draft),criteria:scoringCriteria(draft.cases.flatMap(task=>task.expected.checks.map(check=>check.metricId)))};
    snapshot.review.state='verified';
    const datasetRoot=join(root,'dataset');await writeJsonExclusive(join(datasetRoot,'snapshot.json'),snapshot);
    const {config,modelCredential,judgeConfig}=await resolveRunConfig({version:1,environment:'test',model:{url:server.url.href+'v1',key:'ENGINEERING-AGENT',model:'openrouter/openai/gpt-4o-mini'},intent:{baseUrl:server.url.href,model:'qwen3.5:0.8b'},policy:{},retention:'preserve_all'},{MEDCLAW_JUDGE_BASE_URL:server.url.href+'judge/v1',MEDCLAW_JUDGE_MODEL:'openrouter/openai/gpt-4o-mini',MEDCLAW_JUDGE_API_KEY:'ENGINEERING-JUDGE'},'required',true);
    const judge=await JudgeClient.create(judgeConfig!,{plannedTrials:2,trialIds:planTrials(tasks.map(task=>task.id),1).map(item=>item.trialId)}),render=terminalProgress(line=>lines.push(line));
    const report=await runExperiment({datasetRoot,runsRoot,executionId,selection:'smoke',trials:1,config,modelCredential,judgeMode:'required',judge,onEvent:event=>{
      order.push(`${event.index}:${event.kind}:${event.phase}`);render(event);
      if(event.kind==='saved')savedJournals.push(event.trialId);
    }});
    stopped=report.trials.every(trial=>trial.stopped&&trial.closed);
    expect(stopped).toBe(true);expect(report.trials.every(trial=>trial.status==='completed')).toBe(true);
    expect(report.judgeCalls).toHaveLength(2);expect(seen.filter(item=>item.path.startsWith('/judge/'))).toHaveLength(2);
    expect(order.indexOf('1:saved:save')).toBeLessThan(order.indexOf('2:phase:prepare_input'));
    expect(lines.some(line=>line.includes('结果已保存'))).toBe(true);
    const archive=join(runsRoot,executionId);
    expect((await readdir(archive)).sort()).toEqual(['badcases.json','badcases.md','evidence','report.json','snapshot.json']);
    for(const trial of report.trials) {
      const directory=join(archive,'evidence',trial.trialId);
      expect((await readdir(directory)).sort()).toEqual(['artifacts','events.jsonl','observation.json','trial.json']);
      const events=(await readFile(join(directory,'events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
      expect(events.filter(event=>event.kind==='scoring.completed')).toHaveLength(1);expect(savedJournals).toContain(trial.trialId);
      expect(report.scores.find(score=>score.trialId===trial.trialId&&score.metricId==='resource.progressive_read')).toMatchObject({status:'PASS'});
      expect(report.scores.find(score=>score.trialId===trial.trialId&&score.metricId==='efficiency.calls')).toMatchObject({status:'PASS',actual:{calls:[{kind:'read'}]}});
    }
    expect((await readReport(join(archive,'report.json'))).totals).toEqual(report.totals);
    expect(report.scores.find(score=>score.metricId==='security.injection')).toMatchObject({status:'PASS',actual:{attackDelivered:true}});
    expect(report.totals.pass).toBe(0);
  }finally{
    server.stop(true);
    if(stopped)for(const id of savedJournals){const state=JSON.parse(await readFile(join(runsRoot,executionId,'evidence',id,'trial.json'),'utf8'));within(tmpdir(),state.lifecycle.workRoot);await rm(state.lifecycle.workRoot,{recursive:true,force:true});}
    if(stopped)await rm(root,{recursive:true,force:true});
  }
},60000);
