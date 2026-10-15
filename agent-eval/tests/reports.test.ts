import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,rm,readFile,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reportFixture,saveReportFixture,datasetFixture} from './report-fixture.ts';
import {readReport} from '../src/reports/write.ts';
import {compareReports} from '../src/reports/compare.ts';

test('actual semantic boundary FAIL saves and reads without inventing a Judge call; forged constraints are rejected',async()=>{
  const {cases}=await import('../src/datasets/medclaw-agent-v1.ts'),{goldDefinitions}=await import('../src/datasets/medclaw-agent-v1.gold.ts');
  const {loadSnapshot,snapshotCompiled}=await import('../src/datasets.ts'),{scoringCriteria,registry}=await import('../src/scoring/registry.ts');
  const {evaluate}=await import('../src/scoring/evaluate.ts'),{aggregate}=await import('../src/scoring/aggregate.ts'),{reviewCandidates}=await import('../src/review/candidates.ts');
  const {QueryParamsSchema}=await import('../../packages/contracts/src/query.ts');
  const item=cases.find(item=>item.id==='mc-v1-task-empty-result')!,definition=datasetFixture();
  definition.cases=[structuredClone(item)];definition.smokeIds=[item.id];definition.gold={[item.id]:structuredClone(goldDefinitions[item.id]!)};
  definition.review.cases={[item.id]:Object.values(definition.review.cases)[0]!};
  const dataset=loadSnapshot(definition),task=dataset.cases[0]!,report=reportFixture(),trialId=item.id+'-r1',root=await mkdtemp(join(tmpdir(),'mc-boundary-archive-'));
  const params=QueryParamsSchema.parse({kind:'current',population:'snapshot',snapshotMode:'exact_date',batchIds:[1],region:'浙江',time:{start:'2026-10-02',endExclusive:'2026-10-03'}});
  const query={id:11,sessionId:1,runId:1,callRef:'one',kind:'current',params,batchIds:[1],scopeDeviceIds:null,warnings:[],calculationVersion:'v1',createdAt:report.createdAt,totalRows:1};
  const trial={...report.trials[0]!,trialId,caseId:item.id,status:'completed' as const,instanceId:'host',startedAt:report.createdAt,endedAt:report.createdAt,stopped:true,closed:true,observationRef:'evidence/'+trialId+'/observation.json'};
  const observation={executionId:report.executionId,trialId,instanceId:'host',identityChecks:[],missing:[],facts:{aliases:{runs:[{alias:'turn-1',runId:1}],lastSendAlias:'turn-1'},answers:[{id:1,runId:1,sessionId:1,inputId:1,kind:'result',text:'No results.',queryIds:[11],missingSlots:[],nativeLeafId:'answer',createdAt:report.createdAt,resultSource:'agent'}],queryPages:[{query,page:{queryId:11,rows:[{value:1}],totalRows:1,page:1,pageSize:20,warnings:[],calculationVersion:'v1',evidenceIds:[],targetVersion:'query:11:v1',rowKeys:[null]},evidence:[]}],evidencePages:[]}};
  const criterion=task.expected.checks.find(check=>check.metricId==='answer.empty')!;
  const [failed]=await evaluate({trialId,caseId:item.id,trialStatus:'completed',task:{checks:[criterion]},gold:dataset.gold[item.id]!,observation});
  expect(failed).toMatchObject({status:'FAIL',value:0});
  report.snapshot.dataset=dataset.snapshot;report.snapshot.compiled=snapshotCompiled(dataset);report.snapshot.criteria=scoringCriteria(task.expected.checks.map(check=>check.metricId));
  report.cases=[{id:task.id,version:1,name:task.name,category:task.category,evalType:task.evalType,tags:task.tags}];report.modules=dataset.modules;
  report.plan=[{trialId,caseId:item.id,repetition:1}];report.trials=[trial];
  report.scores=task.expected.checks.map(check=>({...report.scores[0]!,trialId,caseId:item.id,checkId:check.id,metricId:check.metricId,name:registry.get(check.metricId).name,method:check.kind,unit:check.unit,required:check.required,hardConstraint:check.hardConstraint,scope:check.scope?.kind==='run'?{kind:'run',ref:check.scope.ref}:{kind:'trial',ref:trialId},expected:dataset.gold[item.id]!.values[check.evidenceKey]}));
  report.scores[task.expected.checks.indexOf(criterion)]=failed!;
  const aggregation=aggregate(report.plan,report.trials,report.scores,report.cases,scoringCriteria(task.expected.checks.map(check=>check.metricId)));report.aggregation=aggregation;report.totals=aggregation.totals;
  report.reviewCandidates=reviewCandidates(dataset.snapshot.info.reviewPolicy,[{trialId,caseId:item.id,risks:task.risks,scores:report.scores}]);
  try{
    await saveReportFixture(root,report,{[trialId]:observation});
    expect((await readReport(root)).judgeCalls).toHaveLength(0);
    const path=join(root,'report.json'),raw=JSON.parse(await readFile(path,'utf8'));
    delete raw.scores.find((score:any)=>score.metricId==='answer.empty').details;await writeFile(path,JSON.stringify(raw));
    await expect(readReport(root)).rejects.toThrow('judge_score_binding_missing');
    raw.scores.find((score:any)=>score.metricId==='answer.empty').details=failed!.details;await writeFile(path,JSON.stringify(raw));
    observation.facts.answers[0]!.queryIds=[];observation.facts.queryPages=[];await writeFile(join(root,trial.observationRef!),JSON.stringify(observation));
    raw.evidenceManifest.find((file:any)=>file.path===trial.observationRef).bytes=Buffer.byteLength(JSON.stringify(observation));await writeFile(path,JSON.stringify(raw));
    await expect(readReport(root)).rejects.toThrow('semantic_constraint_binding_mismatch');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('execution lookup searches business and research, rejects duplicate IDs and never accepts traversal or linked archives',async()=>{
  const {executionReportPath}=await import('../src/reports/write.ts');
  const root=await mkdtemp(join(tmpdir(),'mc-domain-reports-'));
  try {
    const business=join(root,'business','sample'),research=join(root,'research','sample');
    await mkdir(business,{recursive:true});await writeFile(join(business,'report.json'),'{}');
    expect(await executionReportPath(root,'sample')).toBe(join(business,'report.json'));
    await mkdir(research,{recursive:true});await writeFile(join(research,'report.json'),'{}');
    await expect(executionReportPath(root,'sample')).rejects.toThrow('execution_id_ambiguous');
    await rm(business,{recursive:true});
    expect(await executionReportPath(root,'sample')).toBe(join(research,'report.json'));
    await rm(join(research,'report.json'));
    const calibration=join(root,'calibration','sample');await mkdir(calibration,{recursive:true});await writeFile(join(calibration,'report.json'),'{}');
    await expect(executionReportPath(root,'sample')).rejects.toThrow('execution_report_not_found');
    await expect(executionReportPath(root,'missing')).rejects.toThrow('execution_report_not_found');
    await expect(executionReportPath(root,'../sample')).rejects.toThrow();
    await symlink(research,join(root,'business','linked'),'junction');
    await expect(executionReportPath(root,'linked')).rejects.toThrow('linked_execution_archive');
  } finally {await rm(root,{recursive:true,force:true});}
});
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
test('saved analysis is checked against the archive and the frozen catalog against its criteria',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-analysis-')),report=reportFixture();
  const {qualityMetricCatalog}=await import('../src/scoring/registry.ts');
  report.snapshot.qualityMetricCatalog=qualityMetricCatalog('v1');
  try {
    await saveReportFixture(root,report);
    const path=join(root,'report.json'),raw=JSON.parse(await readFile(path,'utf8'));
    expect(raw.analysis.qualityMetrics).toHaveLength(39);
    raw.analysis.cases[0].confirmedPassRate=1;await writeFile(path,JSON.stringify(raw));
    await expect(readReport(root)).rejects.toThrow('report_analysis_mismatch');
    raw.analysis=report.analysis;await writeFile(path,JSON.stringify(raw));
    delete raw.analysis;await writeFile(path,JSON.stringify(raw));
    expect((await readReport(root)).analysis).toBeUndefined();
    report.snapshot.qualityMetricCatalog.find(row=>row.id===report.scores[0]!.metricId)!.formula='A conflicting formula';
    await writeFile(join(root,'snapshot.json'),JSON.stringify(report.snapshot));
    await expect(readReport(root)).rejects.toThrow('quality_metric_catalog_criteria_mismatch');
  } finally {await rm(root,{recursive:true,force:true});}
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
