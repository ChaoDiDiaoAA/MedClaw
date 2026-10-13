import {test,expect} from 'bun:test';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recordFeedback,listFeedback} from '../src/review/store.ts';
import {reportFixture,saveReportFixture} from './report-fixture.ts';
import {setupReview,enqueueReview,importReview,syncReview} from '../src/review/platform.ts';
import {reviewCandidates} from '../src/review/candidates.ts';
test('feedback binds actual trial identity, preserves conflicts and leaves report unchanged',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-review-'));
  try{
    const report=await saveReportFixture(root),trial=report.trials[0]!,path=join(root,'report.json'),before=await readFile(path,'utf8');
    const feedback={contract:'medclaw-human-feedback/v1' as const,source:'local' as const,sourceId:'review-1',reviewer:'controlled-reviewer',reviewedAt:report.createdAt,executionId:report.executionId,caseId:trial.caseId,trialId:trial.trialId,status:'FAIL' as const,comment:'受控夹具，不是真实人审。',evidenceRefs:[]};
    expect((await recordFeedback(path,feedback)).state).toBe('recorded');
    expect((await recordFeedback(path,feedback)).state).toBe('duplicate');
    await expect(recordFeedback(path,{...feedback,comment:'conflict'})).rejects.toThrow('conflict');
    await expect(recordFeedback(path,{...feedback,sourceId:'bad',executionId:'other'})).rejects.toThrow('identity');
    expect(await listFeedback(path)).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root,'review.json'),'utf8')).conflicts).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root,'review.json'),'utf8')).queues.reviewCandidates[0].reasons).toContain('disputed');
    expect(await readFile(path,'utf8')).toBe(before);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('local platform service reuses persisted trace IDs and requires actual annotation provenance',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-review-http-')),report=reportFixture(),trial=report.trials[0]!;
  trial.startedAt=report.createdAt;trial.endedAt=report.createdAt;trial.instanceId='host';trial.status='infra_error';trial.observationRef='evidence/'+trial.trialId+'/observation.json';
  report.snapshot.dataset.cases[0]!.risks=['privacy'];
  report.reviewCandidates=reviewCandidates(report.snapshot.dataset.info.reviewPolicy,[{trialId:trial.trialId,caseId:trial.caseId,risks:['privacy'],scores:report.scores}]);
  const {aggregate}=await import('../src/scoring/aggregate.ts');report.aggregation=aggregate(report.plan,report.trials,report.scores,report.cases);report.totals=(report.aggregation as any).totals;
  let traceId='',posts=0,missingAuthor=false;const sentIds:string[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
    const url=new URL(request.url);
    if(request.method==='POST'){posts++;const body=await request.json() as any;if(url.pathname.endsWith('/items')){traceId=body.objectId;return Response.json({objectId:traceId});}if(body.id)sentIds.push(body.id);return Response.json({id:body.id??'queue-1'});}
    if(url.pathname.endsWith('/items'))return Response.json({data:traceId?[{objectId:traceId,objectType:'TRACE'}]:[],meta:{totalPages:1}});
    return Response.json({data:[{id:'annotation-1',source:'ANNOTATION',authorUserId:missingAuthor?null:'actual-fixture-reviewer',timestamp:report.createdAt,subject:{kind:'trace',id:traceId},value:'PASS',comment:'受控标注'}],meta:{}});
  }});
  try{
    await saveReportFixture(root,report);const path=join(root,'report.json'),config={baseUrl:server.url.href,publicKey:'public',secretKey:'private',serverVersion:'controlled',transport:'otel-http-json/v1' as const};
    await setupReview({name:'controlled',scoreConfigIds:['score']},config);
    await enqueueReview(path,'queue-1',config);await enqueueReview(path,'queue-1',config);expect(posts).toBe(2);
    expect(await Bun.file(join(root,'review.json')).exists()).toBe(false);
    await importReview(path,'queue-1',config);await importReview(path,'queue-1',config);expect(await listFeedback(path)).toHaveLength(1);
    missingAuthor=true;await expect(importReview(path,'queue-1',config)).rejects.toThrow('provenance');
    await recordFeedback(path,{...(await listFeedback(path))[0]!,source:'local',sourceId:'local-1'});
    await syncReview(path,config);await syncReview(path,config);expect(sentIds).toHaveLength(2);expect(sentIds[0]).toBe(sentIds[1]);
  }finally{server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('enqueue skips started trials without review reasons and creates no feedback record',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-review-empty-')),report=reportFixture(),trial=report.trials[0]!;
  trial.status='infra_error';trial.startedAt=report.createdAt;trial.endedAt=report.createdAt;trial.instanceId='host';trial.observationRef='evidence/'+trial.trialId+'/observation.json';
  const {aggregate}=await import('../src/scoring/aggregate.ts');report.aggregation=aggregate(report.plan,report.trials,report.scores,report.cases);report.totals=(report.aggregation as any).totals;
  let posts=0;const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>{if(request.method==='POST')posts++;return Response.json({data:[],meta:{totalPages:1}});}});
  try{
    await saveReportFixture(root,report);
    const result=await enqueueReview(root,'empty-queue',{baseUrl:server.url.href,publicKey:'controlled-public',secretKey:'controlled-private',serverVersion:'controlled',transport:'otel-http-json/v1'}) as {receipts:unknown[]};
    expect(result.receipts).toEqual([]);expect(posts).toBe(0);expect(await Bun.file(join(root,'review.json')).exists()).toBe(false);
  }finally{server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('a later real dispute appends its trace to the same review queue without resending existing items',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-review-append-')),report=reportFixture(),first=report.trials[0]!;
  first.status='infra_error';first.startedAt=report.createdAt;first.endedAt=report.createdAt;first.instanceId='host';first.observationRef='evidence/'+first.trialId+'/observation.json';
  const second={...first,trialId:first.caseId+'-r2',repetition:2,observationRef:'evidence/'+first.caseId+'-r2/observation.json'};
  report.plan.push({trialId:second.trialId,caseId:second.caseId,repetition:2});report.trials.push(second);
  report.scores.push(...report.scores.map(score=>({...score,trialId:second.trialId})));
  for(const [trialId,metricId] of [[first.trialId,'security.scope'],[second.trialId,'query.numeric']])Object.assign(report.scores.find(score=>score.trialId===trialId&&score.metricId===metricId)!,{status:'FAIL',value:0,numerator:0,denominator:1});
  const {aggregate}=await import('../src/scoring/aggregate.ts');report.aggregation=aggregate(report.plan,report.trials,report.scores,report.cases);report.totals=(report.aggregation as any).totals;
  report.reviewCandidates=reviewCandidates(report.snapshot.dataset.info.reviewPolicy,report.trials.map(trial=>({trialId:trial.trialId,caseId:trial.caseId,risks:['permission'],scores:report.scores.filter(score=>score.trialId===trial.trialId)})));
  const posted:string[]=[];const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{if(request.method==='POST'){const body=await request.json() as {objectId:string};posted.push(body.objectId);return Response.json(body);}return Response.json({data:posted.map(objectId=>({objectType:'TRACE',objectId})),meta:{totalPages:1}});}});
  const config={baseUrl:server.url.href,publicKey:'controlled-public',secretKey:'controlled-private',serverVersion:'controlled',transport:'otel-http-json/v1' as const};
  try{
    await saveReportFixture(root,report);await enqueueReview(root,'same-queue',config);expect(posted).toHaveLength(1);
    await recordFeedback(root,{contract:'medclaw-human-feedback/v1',source:'local',sourceId:'actual-dispute',reviewer:'controlled-reviewer',reviewedAt:report.createdAt,executionId:report.executionId,trialId:second.trialId,caseId:second.caseId,status:'PASS',comment:'Controlled actual feedback disagrees with the automatic failure.',evidenceRefs:[]});
    await enqueueReview(root,'same-queue',config);await enqueueReview(root,'same-queue',config);expect(posted).toHaveLength(2);expect(new Set(posted).size).toBe(2);
    const path=join(root,'review.json'),review=JSON.parse(await readFile(path,'utf8'));review.queues['same-queue'].traces[0].traceId='foreign';await writeFile(path,JSON.stringify(review));
    await expect(enqueueReview(root,'same-queue',config)).rejects.toThrow('review_queue_binding_conflict');
  }finally{server.stop(true);await rm(root,{recursive:true,force:true});}
});
