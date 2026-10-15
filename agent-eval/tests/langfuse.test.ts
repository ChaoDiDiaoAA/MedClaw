import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapReport, assertSafeExport } from '../src/langfuse/map.ts';
import { exportReport,platformConfig } from '../src/langfuse/export.ts';
import { reportFixture,saveReportFixture } from './report-fixture.ts';
import { writeReport } from '../src/reports/write.ts';
import { aggregate } from '../src/scoring/aggregate.ts';
import { evaluate } from '../src/scoring/evaluate.ts';
import type { JudgeResult, CheckSpec } from '../src/scoring/types.ts';

test('platform configuration rejects placeholder or floating server releases',()=>{
  const env={LANGFUSE_BASE_URL:'http://localhost:3000',LANGFUSE_PUBLIC_KEY:'controlled-public',LANGFUSE_SECRET_KEY:'controlled-private'};
  for(const release of ['', 'REPLACE_WITH_ACTUAL_SERVER_VERSION','latest'])expect(()=>platformConfig({...env,MEDCLAW_LANGFUSE_SERVER_VERSION:release})).toThrow();
  expect(platformConfig({...env,MEDCLAW_LANGFUSE_SERVER_VERSION:'3.120.0'}).serverVersion).toBe('3.120.0');
});

function startedReport() {
  const report = reportFixture(), trial = report.trials[0]!;
  trial.status = 'completed'; trial.instanceId = 'instance'; trial.startedAt = report.createdAt; trial.endedAt = report.createdAt;
  trial.stopped = true; trial.closed = true;
  trial.observationRef='evidence/'+trial.trialId+'/observation.json';
  const aggregation = aggregate(report.plan, report.trials, report.scores,report.cases); report.aggregation = aggregation; report.totals = aggregation.totals;
  return report;
}
function observations(report:ReturnType<typeof reportFixture>):Record<string,any> {const trial=report.trials[0]!;return {[trial.trialId]:{executionId:report.executionId,trialId:trial.trialId,instanceId:trial.instanceId,observedFrom:report.createdAt,observedUntil:report.createdAt,identityChecks:[],facts:{modelCalls:[{id:1,runId:2,startedAt:report.createdAt,endedAt:report.createdAt}],queries:[],rawSecret:'never-upload-this'},missing:[]}};}
test('stable IDs, no fake traces for NOT_RUN, white list excludes raw evidence', () => {
  expect(mapReport(reportFixture()).events).toHaveLength(0);
  const report=startedReport(),ids:Record<string,string>={};const a = mapReport(report,observations(report),ids), b = mapReport(report,observations(report),ids);
  expect(a).toEqual(b); expect(JSON.stringify(a)).not.toContain('never-upload-this');
  expect(a.events).toHaveLength(2);
  expect(() => assertSafeExport({ authorization: 'secret' })).toThrow('sensitive');
  expect(() => assertSafeExport({ text: 'Bearer canary-secret' })).toThrow('sensitive');
});
test('local does no network; partial and duplicate resend preserve envelope and report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-export-')); let calls = 0, reject = true;
  const server = Bun.serve({ port: 0, fetch: async request => {
    calls++; await request.json();
    return Response.json(reject && calls === 2 ? { partialSuccess: { rejectedSpans: 1, errorMessage: 'canary-secret' } } : {});
  } });
  try {
    const report=startedReport();await saveReportFixture(root,report,observations(report));
    const path = join(root, 'report.json'), before = await readFile(path, 'utf8');
    const config = { baseUrl: server.url.href, publicKey: 'public', secretKey: 'canary-secret', serverVersion: 'controlled', transport: 'otel-http-json/v1' as const };
    expect((await exportReport(path, 'local', config)).state).toBe('disabled'); expect(calls).toBe(0);
    expect((await exportReport(path, 'langfuse', config)).state).toBe('error');
    const envelope = JSON.parse(await readFile(join(root, 'export.json'), 'utf8')).envelope; reject = false;
    expect((await exportReport(path, 'langfuse', config)).state).toBe('complete');
    expect(JSON.parse(await readFile(join(root, 'export.json'), 'utf8')).envelope).toEqual(envelope);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await readFile(join(root, 'export.json'), 'utf8')).not.toContain('canary-secret');
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});
test('invalid OTLP receipt cannot mark delivery complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-export-receipt-'));
  const server = Bun.serve({ port: 0, fetch: () => Response.json([]) });
  try {
    const report=startedReport();await saveReportFixture(root,report,observations(report));
    const config = { baseUrl: server.url.href, publicKey: 'public', secretKey: 'private', serverVersion: 'controlled', transport: 'otel-http-json/v1' as const };
    expect((await exportReport(join(root, 'report.json'), 'langfuse', config)).state).toBe('error');
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});
test('multiple semantic scores reference one actual Judge generation', async () => {
  const report = startedReport(), trial = report.trials[0]!;
  const checks: CheckSpec[] = ['one', 'two'].map(id => ({ id, metricId: 'answer.faithful', version: 'v1', kind: 'llm-judge', required: true, hardConstraint: false, unit: 'criterion', goldKey: 'semantic', evidenceKey: 'semantic' }));
  const result: JudgeResult = { status: 'completed', results: checks.map(check => ({ checkId: check.id, value: 1, reason: 'supported', evidenceRefs: ['source'] })), error: null, metadata: { baseUrl:'http://127.0.0.1:1/',timeoutMs:30000,model: 'controlled-judge', startedAt: report.createdAt, endedAt: report.createdAt, durationMs: 0, temperature: .8, httpStatus: 200, requestId: 'controlled', usage: { promptTokens: null, completionTokens: null } } };
  const observation=observations(report)[trial.trialId]!;observation.facts.semantic = { answer: 'Synthetic answer', evidenceRefs: ['source'], evidence: { source: 'Synthetic source' } };
  report.scores = await evaluate({ trialId: trial.trialId, caseId: trial.caseId, task: { checks }, gold: { semantic: { rubric: 'Use only source' } }, observation, trialStatus: 'completed', judge: { judge: async () => result }, onJudgeResult: result => { report.judgeCalls.push({ trialId: trial.trialId, result }); } });
  result.metadata.nativeModel={catalogRef:'deepseek/deepseek-flash',api:'anthropic-messages',contextWindow:1000000,maxTokens:384000,sdkVersion:'0.87.1'};
  const envelope = mapReport(report,{[trial.trialId]:observation}), spans = envelope.events.filter(event => event.kind === 'span').map(event => (event.payload.resourceSpans as any)[0].scopeSpans[0].spans[0]);
  const judge = spans.filter(span => span.name === 'judge/answer-quality');
  expect(judge).toHaveLength(1); expect(spans.filter(span => span.name === 'scoring/answer.faithful')).toHaveLength(2);
  expect(JSON.parse(judge[0].attributes.find((attribute:any)=>attribute.key==='medclaw.nativeModel').value.stringValue)).toEqual(result.metadata.nativeModel);
  expect(envelope.events.filter(event => event.kind === 'score')).toHaveLength(2);
  for (const span of spans.filter(span => span.name === 'scoring/answer.faithful')) expect(span.attributes.find((attribute: any) => attribute.key === 'medclaw.judgeObservationId').value.stringValue).toBe(judge[0].spanId);
});
test('started infrastructure failure remains visible; unstarted report cannot claim platform completion', async () => {
  const report = reportFixture(), trial = report.trials[0]!;
  trial.status = 'infra_error'; trial.startedAt = report.createdAt; trial.endedAt = report.createdAt; trial.reason = 'host_start_failed';
  const envelope = mapReport(report); expect(envelope.events).toHaveLength(1);
  expect(JSON.stringify(envelope)).toContain('observation'); expect(JSON.stringify(envelope)).not.toContain('generation');
  const root = await mkdtemp(join(tmpdir(), 'medclaw-export-empty-'));
  try {
    await saveReportFixture(root);
    await expect(exportReport(join(root, 'report.json'), 'langfuse', { baseUrl: 'http://127.0.0.1:1', publicKey: 'public', secretKey: 'private', serverVersion: 'controlled', transport: 'otel-http-json/v1' })).rejects.toThrow('export_no_started_trials');
  } finally { await rm(root, { recursive: true, force: true }); }
});
