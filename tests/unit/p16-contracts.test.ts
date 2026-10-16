import { expect, test } from 'bun:test';
import { ExecutionIdSchema as LegacyExecutionIdSchema } from '../../agent-eval/src/types';
import { safeError } from '../../packages/contracts/src/error';
import { HOST_PROTOCOL_VERSION, PublicHostRequestSchema, RuntimeNoticeSchema } from '../../packages/contracts/src/protocol';

const operationRef = 'b62b7f30-187a-43af-9b75-868e506c2bed';

test('evaluation contracts keep desktop methods outside the production Host', async () => {
  const { evaluationMethodSchemas, EvaluationRequestSchema, isEvaluationReadOnlyMethod } = await import('../../packages/contracts/src/evaluation');
  const { DesktopMethodSchema } = await import('../../packages/contracts/src/protocol');
  expect(Object.keys(evaluationMethodSchemas)).toHaveLength(11);
  for (const method of ['eval.preflight', 'eval.compare', 'eval.status', 'eval.report.read', 'eval.evidence.read']) {
    expect(DesktopMethodSchema.safeParse(method).success).toBe(true);
    expect(isEvaluationReadOnlyMethod(method)).toBe(true);
  }
  expect(isEvaluationReadOnlyMethod('eval.review.sync')).toBe(false);
  expect(EvaluationRequestSchema.safeParse({ method: 'eval.start', operationRef: 'old:opaque', payload: { preflightId: operationRef, datasetId: 'medclaw-agent-v1', selection: 'smoke' } }).success).toBe(false);
  expect(PublicHostRequestSchema.safeParse({ protocolVersion: HOST_PROTOCOL_VERSION, kind: 'request', requestId: 'r', instanceId: 'h', operationRef, method: 'eval.status', payload: {} }).success).toBe(false);
  expect(RuntimeNoticeSchema.safeParse({ type: 'eval.status', controllerInstanceId: operationRef, sequence: 1, executionId: null }).success).toBe(false);
});

test('evaluation inputs reject path injection and invalid or overflowing pagination', async () => {
  const { evaluationMethodSchemas } = await import('../../packages/contracts/src/evaluation');
  expect(evaluationMethodSchemas['eval.preflight'].input.parse({ datasetId: 'medclaw-agent-v1', selection: 'smoke' })).toEqual({ datasetId: 'medclaw-agent-v1', selection: 'smoke' });
  for (const payload of [
    { datasetId: '../private', selection: 'smoke' },
    { datasetId: 'medclaw-agent-v1', selection: 'smoke', configPath: 'C:/private' },
    { datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 0 },
  ]) expect(evaluationMethodSchemas['eval.preflight'].input.safeParse(payload).success).toBe(false);
  expect(evaluationMethodSchemas['eval.report.list'].input.parse({})).toEqual({ page: 1, pageSize: 50 });
  for (const payload of [{ page: 0 }, { pageSize: 101 }, { page: Number.MAX_SAFE_INTEGER, pageSize: 100 }]) {
    expect(evaluationMethodSchemas['eval.report.list'].input.safeParse(payload).success).toBe(false);
  }
  expect(evaluationMethodSchemas['eval.status'].input.parse({ operationRef, pageSize: 1 })).toMatchObject({ operationRef, page: 1, pageSize: 1 });
  expect(evaluationMethodSchemas['eval.status'].input.parse({ executionId: 'old-report', platform: 'resend' })).toMatchObject({ executionId: 'old-report', platform: 'resend' });
  for (const payload of [{ platform: 'resend' }, { executionId: 'old-report', platform: 'queue_management' }]) {
    expect(evaluationMethodSchemas['eval.status'].input.safeParse(payload).success).toBe(false);
  }
});

test('shared execution identities preserve existing CLI IDs and reserved-name rejection', async () => {
  const { ExecutionIdSchema, DesktopEvaluationRequestSchema } = await import('../../packages/contracts/src/evaluation');
  for (const [value, valid] of [['old-execution_1', true], ['x'.repeat(128), true], ['CON', false], ['../escape', false], ['id:old', false], ['x'.repeat(129), false]] as const) {
    expect(ExecutionIdSchema.safeParse(value).success).toBe(valid);
    expect(LegacyExecutionIdSchema.safeParse(value).success).toBe(valid);
  }
  expect(DesktopEvaluationRequestSchema.parse({ operationRef, datasetId: 'medclaw-agent-v1', selection: 'full', trials: 5 })).toMatchObject({ trials: 5 });
});

test('partial summaries cannot claim whole-execution quality or accept private source fields', async () => {
  const { EvaluationReportSummarySchema } = await import('../../packages/contracts/src/evaluation');
  const partial = { executionId: 'partial-1', datasetId: 'medclaw-agent-v1', archiveState: 'partial', createdAt: null, startedAt: null,
    planned: 10, recorded: 1, qualityMetricCatalogVersion: 'v2', totals: null, aggregation: null, analysis: null, quality: null, gaps: [] };
  expect(EvaluationReportSummarySchema.safeParse(partial).success).toBe(true);
  expect(EvaluationReportSummarySchema.safeParse({ ...partial, quality: 'PASS' }).success).toBe(false);
  expect(EvaluationReportSummarySchema.safeParse({ ...partial, snapshot: { key: 'private' } }).success).toBe(false);
});

test('evaluation safe errors retain actionable fixed messages without native secrets', () => {
  expect(safeError('report_page_too_large', new Error('secret'))).toMatchObject({ code: 'report_page_too_large', category: 'input', retryable: false });
  expect(safeError('evaluation_runtime_changed', new Error('secret'))).toMatchObject({ code: 'evaluation_runtime_changed', category: 'runtime', retryable: false });
  expect(JSON.stringify(safeError('evaluation_runtime_changed', new Error('secret')))).not.toContain('secret');
  for (const code of ['evaluation_platform_failed', 'feedback_conflict_preserved', 'review_no_local_feedback', 'langfuse_config_incomplete', 'export_no_started_trials']) {
    expect(safeError(code, new Error('synthetic-private-provider-body')).code).toBe(code);
    expect(JSON.stringify(safeError(code, new Error('synthetic-private-provider-body')))).not.toContain('synthetic-private-provider-body');
  }
});
