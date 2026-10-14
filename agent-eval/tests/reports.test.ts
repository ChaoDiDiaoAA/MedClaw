import {test,expect} from 'bun:test';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reportFixture,saveReportFixture} from './report-fixture.ts';
import {readReport} from '../src/reports/write.ts';
import {compareReports} from '../src/reports/compare.ts';
test('v1 archives read independently, bind metadata and recompute every planned check',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-report-'));
  try {
    const saved=await saveReportFixture(root),path=join(root,'report.json'),original=await readFile(path,'utf8');
    expect((await readReport(root)).snapshot).toEqual(saved.snapshot);
    expect(JSON.parse(original).snapshot).toBeUndefined();
    for(const change of [(r:any)=>{r.modules.task=[];},(r:any)=>{r.cases[0].name='changed';},(r:any)=>{r.scores.pop();},(r:any)=>{r.scores[0].caseId='foreign';},(r:any)=>{r.aggregation.totals.notRun=900;}]) {
      const raw=JSON.parse(original);change(raw);await writeFile(path,JSON.stringify(raw));
      await expect(readReport(root)).rejects.toThrow();
    }
    await writeFile(path,original);
    await expect(saveReportFixture(root)).rejects.toThrow();
  } finally {await rm(root,{recursive:true,force:true});}
});
test('comparison checks actual v1 contents and declared configuration factors',()=>{
  const a=reportFixture(),b=reportFixture();b.executionId='candidate';
  expect(compareReports(a,b).matchedTrials).toBe(1);
  b.snapshot.dataset.cases[0]!.expected.expectedAnswerHint='Changed answer requirement';
  expect(()=>compareReports(a,b)).toThrow('incompatible');
  const c=reportFixture();c.config.model.model='other';
  expect(()=>compareReports(a,c)).toThrow('incompatible');
  c.config.comparison={baselineExecutionId:a.executionId,factors:['model.model']};
  expect(compareReports(a,c).declaredFactors).toEqual(['model.model']);
});
test('source comparison uses the automatically archived inventory without ignoring data or policy',()=>{
  const baseline=reportFixture(),candidate=reportFixture();candidate.executionId='source-candidate';
  candidate.snapshot.source={sdk:'0.87.1',files:{'actual.ts':'changed source'}};
  expect(()=>compareReports(baseline,candidate)).toThrow('incompatible');
  candidate.config.comparison={baselineExecutionId:baseline.executionId,factors:['source']};
  expect(compareReports(baseline,candidate).declaredFactors).toEqual(['source']);
  candidate.config.policy={timeoutMs:1};
  expect(()=>compareReports(baseline,candidate)).toThrow('incompatible');
});
test('archive requires its compiled checks and preserves recorded expectations',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-recorded-checks-'));
  try{
    const report=reportFixture(),caseId=report.plan[0]!.caseId;
    report.snapshot.compiled[caseId]!.values.query_numeric=[{id:'archived-reference',value:123,unit:'CNY cents'}];
    const score=report.scores.find(score=>score.metricId==='query.numeric');if(score)score.expected=report.snapshot.compiled[caseId]!.values.query_numeric;
    await saveReportFixture(root,report);
    expect((await readReport(root)).snapshot.compiled[caseId]!.values.query_numeric).toEqual([{id:'archived-reference',value:123,unit:'CNY cents'}]);
    const path=join(root,'snapshot.json'),snapshot=JSON.parse(await readFile(path,'utf8'));delete snapshot.compiled;
    await writeFile(path,JSON.stringify(snapshot));await expect(readReport(root)).rejects.toThrow('archived_compiled_checks_missing');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('archive aggregation uses its recorded dimension assignments',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-recorded-dimensions-'));
  try{
    const report=reportFixture(),criteria=report.snapshot.criteria as {id:string;dimension:string}[];
    criteria.find(criterion=>criterion.id==='query.numeric')!.dimension='process';
    const {aggregate}=await import('../src/scoring/aggregate.ts');
    report.aggregation=aggregate(report.plan,report.trials,report.scores,report.cases,criteria);
    await saveReportFixture(root,report);
    expect(((await readReport(root)).aggregation as any).dimensions.process.some((metric:any)=>metric.metricId==='query.numeric')).toBe(true);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('observation identities and archived trial state are checked on read',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-owner-')),report=reportFixture(),trial=report.trials[0]!;
  trial.status='infra_error';trial.instanceId='host';trial.startedAt=report.createdAt;trial.endedAt=report.createdAt;
  trial.observationRef='evidence/'+trial.trialId+'/observation.json';
  const {aggregate}=await import('../src/scoring/aggregate.ts');report.aggregation=aggregate(report.plan,report.trials,report.scores,report.cases);report.totals=(report.aggregation as any).totals;
  try {
    await saveReportFixture(root,report);
    const path=join(root,trial.observationRef),body=JSON.parse(await readFile(path,'utf8'));body.instanceId='else';
    await writeFile(path,JSON.stringify(body,null,2)+'\n');
    await expect(readReport(root)).rejects.toThrow('observation_identity');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('an archive cannot discard the whole event journal and its manifest entry',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-journal-'));
  try {
    await saveReportFixture(root);
    const path=join(root,'report.json'),raw=JSON.parse(await readFile(path,'utf8'));
    raw.evidenceManifest=raw.evidenceManifest.filter((file:any)=>!file.path.endsWith('/events.jsonl'));
    await writeFile(path,JSON.stringify(raw));
    await expect(readReport(root)).rejects.toThrow('event_journal_reference_missing');
  } finally {await rm(root,{recursive:true,force:true});}
});
test('actual Judge journal and metadata must agree with the recorded public configuration',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-judge-binding-')),report=reportFixture(),trial=report.trials[0]!;
  const {JudgeConfigurationSchema}=await import('../src/types.ts');
  report.config.judge=JudgeConfigurationSchema.parse({baseUrl:'https://judge.example.invalid/v1',model:'judge-a'});
  trial.status='completed';trial.startedAt=report.createdAt;trial.endedAt=report.createdAt;trial.instanceId='controlled-host';trial.observationRef='evidence/'+trial.trialId+'/observation.json';
  const {aggregate}=await import('../src/scoring/aggregate.ts');report.aggregation=aggregate(report.plan,report.trials,report.scores,report.cases);report.totals=(report.aggregation as any).totals;
  try {
    await saveReportFixture(root,report);
    const path=join(root,'report.json'),raw=JSON.parse(await readFile(path,'utf8')),journalPath='evidence/'+trial.trialId+'/events.jsonl';
    const result={status:'error',results:[],error:'Controlled transport failure',metadata:{baseUrl:report.config.judge.baseUrl,model:'judge-a',timeoutMs:30000,temperature:.8,startedAt:report.createdAt,endedAt:report.createdAt,durationMs:0,httpStatus:503,requestId:null,usage:{promptTokens:null,completionTokens:null}}};
    const persist=async()=>{
      const text=[{kind:'judge.request',at:report.createdAt,value:{trialId:trial.trialId,checks:[{checkId:raw.scores.find((score:any)=>score.method==='llm-judge').checkId,rubric:'Controlled archived request',evidenceRefs:['controlled-source']}]}},{kind:'judge.result',at:report.createdAt,value:result}].map(event=>JSON.stringify(event)).join('\n')+'\n';
      await writeFile(join(root,journalPath),text);raw.evidenceManifest.find((file:any)=>file.path===journalPath).bytes=Buffer.byteLength(text);
      raw.judgeCalls=[{trialId:trial.trialId,result}];await writeFile(path,JSON.stringify(raw));
    };
    await persist();expect((await readReport(root)).judgeCalls).toHaveLength(1);
    const nativeModel={catalogRef:'deepseek/deepseek-flash',api:'anthropic-messages',contextWindow:1000000,maxTokens:384000,sdkVersion:'0.87.1' as const};
    report.config.judge.nativeModel=nativeModel;await writeFile(join(root,'snapshot.json'),JSON.stringify(report.snapshot));
    await expect(readReport(root)).rejects.toThrow('judge_configuration_mismatch');
    Object.assign(result.metadata,{nativeModel});await persist();
    expect((await readReport(root)).judgeCalls[0]!.result.metadata.nativeModel).toEqual(nativeModel);
    delete report.config.judge.nativeModel;Reflect.deleteProperty(result.metadata,'nativeModel');
    await writeFile(join(root,'snapshot.json'),JSON.stringify(report.snapshot));await persist();
    report.config.judge.outputLimit=256;
    await writeFile(join(root,'snapshot.json'),JSON.stringify(report.snapshot));
    Object.assign(result.metadata,{outputLimit:256});await persist();
    expect((await readReport(root)).config.judge?.outputLimit).toBe(256);
    Reflect.deleteProperty(result.metadata,'outputLimit');await persist();
    await expect(readReport(root)).rejects.toThrow('judge_configuration_mismatch');
    Object.assign(result.metadata,{outputLimit:256});
    result.metadata.model='judge-b';await persist();await expect(readReport(root)).rejects.toThrow('judge_configuration_mismatch');
    result.metadata.model='judge-a';await persist();await writeFile(join(root,journalPath),'{}\n');raw.evidenceManifest.find((file:any)=>file.path===journalPath).bytes=3;await writeFile(path,JSON.stringify(raw));
    await expect(readReport(root)).rejects.toThrow('event_journal_record_invalid');
  }finally{await rm(root,{recursive:true,force:true});}
});
