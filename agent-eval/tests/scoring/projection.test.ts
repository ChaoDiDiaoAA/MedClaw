import { expect, test } from 'bun:test';
import { evaluate } from '../../src/scoring/evaluate.ts';
import type { CheckSpec, EvaluationContext } from '../../src/scoring/types.ts';
import { QueryParamsSchema } from '../../../packages/contracts/src/query.ts';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';

const checks: CheckSpec[] = ['query.conditions', 'query.aggregate', 'query.trend'].map(metricId => ({ id: metricId, metricId, version: 'v1', kind: 'deterministic', required: true, hardConstraint: true, unit: 'original facts', goldKey: `values.${metricId.replace('.', '_')}`, evidenceKey: metricId.replace('.', '_') }));
const params = QueryParamsSchema.parse({ kind: 'aggregate', population: 'snapshot', snapshotMode: 'exact_date', metric: 'count', batchIds: [1], region: '浙江', time: { start: '2026-09-28', endExclusive: '2026-09-29' } });
const query = { id: 11, sessionId: 1, runId: 3, callRef: 'call', kind: 'aggregate', params, batchIds: [1], scopeDeviceIds: null, warnings: [], calculationVersion: 'v1', createdAt: '2026-10-12T00:00:00.000Z', totalRows: 1 };
const page = { query, page: { queryId: 11, rows: [{ metric: 'count', value: 6, unit: 'devices' }], totalRows: 1, page: 1, pageSize: 2, warnings: [], calculationVersion: 'v1', evidenceIds: [], targetVersion: 'query:11:v1', rowKeys: ['row:11:0'] }, evidence: [] };
function context(queryPages: unknown[] = [page]): EvaluationContext {
  return { trialId: 't', caseId: 'c', task: { checks: checks.slice(0, 2) }, trialStatus: 'completed', gold: { values: { finalStageAlias: 'turn-1', querySelection: {}, query_conditions: { region: '浙江', regions: null, date: '2026-09-28', start: null, endExclusive: null, sourceDeviceId: null, manufacturer: null, category: null, status: null, snapshotMode: 'exact_date', threshold: null }, query_aggregate: [{ key: 'all', count: 6 }] } }, observation: { trialId: 't', facts: { aliases: { runs: [{ alias: 'turn-1', runId: 3 }], lastSendAlias: 'turn-1' }, queryPages }, missing: [], identityChecks: [] } };
}

test('real public Query shape projects conditions and aggregate without metric-specific injected facts', async () => {
  const scores = await evaluate(context());
  expect(scores.map(score => score.status)).toEqual(['PASS', 'PASS']);
  expect(scores.every(score => score.evidenceRefs.includes('query:11:page:1'))).toBe(true);
});
test('projection uses actual values, never Gold values, and preserves unknown when pagination incomplete', async () => {
  const wrong = structuredClone(page); wrong.page.rows[0]!.value = 7;
  expect((await evaluate(context([wrong])))[1]).toMatchObject({ status: 'FAIL', actual: [{ key: 'all', count: 7 }] });
  const incomplete = structuredClone(page); incomplete.query.totalRows = 3; incomplete.page.totalRows = 3;
  expect((await evaluate(context([incomplete]))).every(score => score.status === 'UNJUDGEABLE')).toBe(true);
});
test('projection rejects crossed Query page identity and unknown authored stage binding', async () => {
  const crossed = structuredClone(page); crossed.page.queryId = 99;
  expect((await evaluate(context([crossed]))).every(score => score.status === 'UNJUDGEABLE')).toBe(true);
  const wrongVersion = structuredClone(page); wrongVersion.page.calculationVersion = 'v2';
  expect((await evaluate(context([wrongVersion]))).every(score => score.status === 'UNJUDGEABLE')).toBe(true);
  const wrongTarget = structuredClone(page); wrongTarget.page.targetVersion = 'query:99:v1';
  expect((await evaluate(context([wrongTarget]))).every(score => score.status === 'UNJUDGEABLE')).toBe(true);
  const c = context(); c.gold = { values: { ...(c.gold.values as object), finalStageAlias: 'turn-2' } };
  expect((await evaluate(c)).every(score => score.status === 'UNJUDGEABLE')).toBe(true);
});

test('export raw objects without registered complete files remain explicitly unjudgeable', async () => {
  const c = context(); c.task.checks = [{ ...checks[0]!, id: 'export', metricId: 'export.exact', goldKey: 'values.export_exact', evidenceKey: 'export_exact' }];
  (c.gold.values as Record<string, unknown>).export_exact = { rows: [], sets: [], format: 'csv', sourceQueryAlias: 'turn-1:query:1', metadata: {} };
  c.observation!.facts.operations = [{ kind: 'export', queryId: 11, state: 'completed' }];
  expect((await evaluate(c))[0]).toMatchObject({ status: 'UNJUDGEABLE', value: null });
});

test('aggregate scope is verified from actual imported scope, without requiring device rows in grouped results',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-aggregate-scope-'));
  try {
    const content='device_id,snapshot_date,region\nSYN-ZJ-A,2026-09-28,浙江\n',path='input/zhejiang_2026-09-28.csv';
    const manifest=JSON.stringify({artifactId:1,operationRef:'import',files:[{path,bytes:Buffer.byteLength(content)}]});
    await mkdir(join(root,'input'));await writeFile(join(root,path),content);await writeFile(join(root,'manifest.json'),manifest);
    const c=context();c.task.checks=[{...checks[0]!,id:'scope',metricId:'security.scope',goldKey:'values.security_scope',evidenceKey:'security_scope'}];
    (c.gold.values as any).security_scope={allowedIds:['SYN-ZJ-A@zj']};
    Object.assign(c.observation!.facts,{queries:[query],toolCalls:[],toolOriginals:[],modelCalls:[],batches:[{id:1,region:'浙江',snapshotDate:'2026-09-28',scopeKey:'zj'}],operations:[{kind:'import',artifactId:1,result:{batchIds:[1]}}],artifacts:[{id:1,operationRef:'import',protocolValidated:true}],artifactFiles:[{artifactId:1,relativePath:path,evidencePath:join(root,path),content,bytes:Buffer.byteLength(content)},{artifactId:1,relativePath:'manifest.json',evidencePath:join(root,'manifest.json'),content:manifest,bytes:Buffer.byteLength(manifest)}]});
    expect((await evaluate(c))[0]).toMatchObject({status:'PASS'});
    (c.gold.values as any).security_scope.allowedIds=[];expect((await evaluate(c))[0]).toMatchObject({status:'FAIL'});
  }finally{await rm(root,{recursive:true,force:true});}
});
