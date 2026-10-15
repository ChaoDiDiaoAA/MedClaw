import {expect,test} from 'bun:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadDataset} from '../../src/datasets.ts';
import {runTrial} from '../../src/execution/trial.ts';
import {resolveRunConfig} from '../../src/scoring/judges/client.ts';
import {within} from '../../src/adapters/files.ts';

test('provider failure stops dependent preparation and compaction while preserving stopped evidence',async()=>{
  let calls=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/api/version')return Response.json({version:'ENGINEERING'});
    if(path==='/api/tags')return Response.json({models:[{name:'qwen3.5:0.8b'}]});
    if(path==='/api/show')return Response.json({details:{family:'ENGINEERING',parameter_size:'fixture',quantization_level:'fixture'}});
    calls++;return Response.json({error:{message:'Insufficient Balance'}},{status:402});
  }});
  const root=await mkdtemp(join(tmpdir(),'mc-provider-stop-'));let workRoot:string|undefined;
  try {
    const dataset=await loadDataset(),task=dataset.cases.find(item=>item.id==='mc-v1-compaction-retain-entity')!;
    const {config,modelCredential}=await resolveRunConfig({version:1,environment:'test',model:{url:server.url.href+'v1',key:'ENGINEERING-LOCAL-KEY',model:'openrouter/openai/gpt-4o-mini'},intent:{baseUrl:server.url.href,model:'qwen3.5:0.8b'},policy:{},retention:'preserve_all'},{},'off',false);
    const result=await runTrial({executionId:'engineering',trialId:'provider-stopped',caseId:task.id,repetition:1,case:task,datasetRoot:dataset.root,fixtureFiles:dataset.snapshot.fixtures,config,modelCredential,trialRoot:root});
    workRoot=JSON.parse(await readFile(join(root,'trial.json'),'utf8')).lifecycle.workRoot;
    expect({status:result.status,reason:result.reason,stopped:result.stopped,closed:result.closed}).toEqual({status:'infra_error',reason:'provider_request_failed',stopped:true,closed:true});
    expect(calls).toBe(1);
    expect((result.observation!.facts.operations as any[]).some(item=>item.kind==='compaction')).toBe(false);
  } finally {
    server.stop(true);if(workRoot){within(tmpdir(),workRoot);await rm(workRoot,{recursive:true,force:true});}await rm(root,{recursive:true,force:true});
  }
},60000);

test('real SDK keeps short-history no_op distinct from persisted default compaction and subsequent delivery',async()=>{
  const requests:any[]=[],summary='ENGINEERING_COMPACTION_SUMMARY: original synthetic Zhejiang A verification remains query-only; retain its entity and source.';
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/api/version')return Response.json({version:'ENGINEERING'});
    if(path==='/api/tags')return Response.json({models:[{name:'qwen3.5:0.8b'}]});
    if(path==='/api/show')return Response.json({details:{family:'ENGINEERING',parameter_size:'fixture',quantization_level:'fixture'}});
    if(!path.endsWith('/chat/completions'))throw new Error('unexpected_local_route');
    const body=await request.json() as any;requests.push(body);
    const content=body.tools?.length?'ENGINEERING acknowledgement of the current synthetic handoff.':summary;
    return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:Math.ceil(JSON.stringify(body.messages).length/4),completion_tokens:30}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  const root=await mkdtemp(join(tmpdir(),'mc-default-compaction-'));
  try {
    const dataset=await loadDataset(),source=dataset.cases.find(item=>item.id==='mc-v1-compaction-retain-entity')!;
    const {config,modelCredential}=await resolveRunConfig({version:1,environment:'test',model:{url:server.url.href+'v1',key:'ENGINEERING-LOCAL-KEY',model:'openrouter/openai/gpt-4o-mini'},intent:{baseUrl:server.url.href,model:'qwen3.5:0.8b'},policy:{},retention:'preserve_all'},{},'off',false);
    for(const short of [true,false]) {
      const task=structuredClone(source),trialId=short?'short-history':'long-history',trialRoot=join(root,trialId);
      if(short){task.steps=task.steps.filter(step=>!step.id.startsWith('prepare-'));task.steps.find(step=>step.action.action==='compact')!.targetAlias='turn-1';}
      const start=requests.length;
      const result=await runTrial({executionId:'engineering',trialId,caseId:task.id,repetition:1,case:task,datasetRoot:dataset.root,fixtureFiles:dataset.snapshot.fixtures,config,modelCredential,trialRoot});
      const state=JSON.parse(await readFile(join(trialRoot,'trial.json'),'utf8'));
      try {
        expect({status:result.status,reason:result.reason,stopped:result.stopped,closed:result.closed}).toEqual({status:'completed',reason:null,stopped:true,closed:true});
        const operations=result.observation!.facts.operations as any[],operation=operations.find(item=>item.kind==='compaction');
        expect(operation).toMatchObject({status:short?'no_op':'completed',nativeSaved:!short});
        const entries=(result.observation!.facts.nativeHistory as any[]).flatMap(item=>item.original.entries).filter(entry=>entry.type==='compaction');
        expect(entries).toHaveLength(short?0:1);
        if(!short){
          expect(entries[0].summary).toContain(summary);expect(requests.slice(start).some(body=>body.tools?.length&&JSON.stringify(body.messages).includes(summary))).toBe(true);
          const facts=result.observation!.facts as any,sourceInput=facts.inputs.find((input:any)=>input.id===facts.aliases.inputs.find((binding:any)=>binding.alias==='turn-1').inputId);
          const history=facts.nativeHistory[0].original.entries;
          expect(history.findIndex((entry:any)=>entry.id===sourceInput.nativeEntryId)).toBeLessThan(history.findIndex((entry:any)=>entry.id===entries[0].firstKeptEntryId));
        }
      }finally{if(state.lifecycle.workRoot&&result.stopped&&result.closed){within(tmpdir(),state.lifecycle.workRoot);await rm(state.lifecycle.workRoot,{recursive:true,force:true});}}
    }
  }finally{server.stop(true);await rm(root,{recursive:true,force:true});}
},60000);
