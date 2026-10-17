import { z } from 'zod';
import { AbsolutePathSchema, AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema, resultSchema } from './error';

export const ExecutionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
  .refine(value => !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value), 'Reserved filesystem identity');
export const EvaluationOperationRefSchema = z.uuid();
export const EvaluationPathsSchema = z.strictObject({ sourceRoot: AbsolutePathSchema, configsRoot: AbsolutePathSchema, runsRoot: AbsolutePathSchema, datasetsRoot: AbsolutePathSchema.optional(), installManifestPath: AbsolutePathSchema.optional() });
export const EvaluationRunOptionsSchema = z.strictObject({ datasetId: ExecutionIdSchema, selection: z.enum(['smoke', 'full']), trials: PositiveIdSchema.optional() });
export const DesktopEvaluationRequestSchema = EvaluationRunOptionsSchema.extend({ operationRef: EvaluationOperationRefSchema, trials: PositiveIdSchema });
export const EvaluationPaginationSchema = z.strictObject({ page: PositiveIdSchema.default(1), pageSize: PositiveIdSchema.max(100).default(50) })
  .refine(value => Number.isSafeInteger((value.page - 1) * value.pageSize), 'Page offset must be a safe integer');
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(4000);
const ref = z.string().min(1).max(512);
const nullableNumber = z.number().finite().nullable();
const pageFields = { page: PositiveIdSchema, pageSize: PositiveIdSchema.max(100), total: count };
export const evaluationPageSchema = <S extends z.ZodType>(item: S) => z.strictObject({ ...pageFields, items: z.array(item).max(100) });
export const EvaluationQualitySchema = z.enum(['PASS', 'FAIL', 'UNJUDGEABLE', 'ERROR', 'NOT_RUN']);
export const EvaluationArchiveStateSchema = z.enum(['complete', 'partial', 'unreadable']);
export const EvaluationDiagnosticSchema = z.strictObject({ code: z.string().min(1).max(128), message: text, trialId: ExecutionIdSchema.nullable() });
export const EvaluationValueSummarySchema = z.strictObject({
  type: z.enum(['primitive', 'array', 'object']), total: count, text: z.string().max(32768), truncated: z.boolean(), redacted: z.boolean(),
});
export const EvaluationTotalsSchema = z.strictObject({ planned: count, pass: count, fail: count, unjudgeable: count, error: count, notRun: count });
export const EvaluationReportSummarySchema = z.strictObject({
  executionId: ExecutionIdSchema, datasetId: ExecutionIdSchema.nullable(), archiveState: EvaluationArchiveStateSchema,
  createdAt: TimestampSchema.nullable(), startedAt: TimestampSchema.nullable(), planned: count, recorded: count,
  qualityMetricCatalogVersion: z.enum(['v1', 'v2']).nullable(), totals: EvaluationTotalsSchema.nullable(),
  aggregation: EvaluationValueSummarySchema.nullable(), analysis: EvaluationValueSummarySchema.nullable(), quality: EvaluationQualitySchema.nullable(),
  gaps: z.array(EvaluationDiagnosticSchema),
}).refine(value => value.archiveState === 'complete' || value.createdAt === null && value.totals === null && value.aggregation === null && value.analysis === null && value.quality === null,
  'Incomplete archives cannot claim final quality');
export const EvaluationCaseSchema = z.strictObject({ id: ExecutionIdSchema, name: text, category: text, evalType: z.enum(['capability', 'regression']), tags: z.array(text), planned: count, recorded: count, status: EvaluationQualitySchema.nullable(), analysis: EvaluationValueSummarySchema.nullable() });
export const EvaluationTrialSchema = z.strictObject({
  trialId: ExecutionIdSchema, caseId: ExecutionIdSchema, repetition: PositiveIdSchema,
  status: z.enum(['planned', 'preparing', 'running', 'completed', 'failed', 'cancelled', 'infra_error', 'not_run']),
  instanceId: OpaqueIdSchema.nullable(), startedAt: TimestampSchema.nullable(), endedAt: TimestampSchema.nullable(), reason: text.nullable(), stopped: z.boolean().nullable(), closed: z.boolean().nullable(),
});
export const EvaluationScoreSchema = z.strictObject({
  trialId: ExecutionIdSchema, caseId: ExecutionIdSchema, checkId: ref, metricId: ref, name: text, version: ref,
  scope: z.strictObject({ kind: z.enum(['trial', 'run', 'call', 'opportunity']), ref }), method: z.enum(['deterministic', 'llm-judge']),
  required: z.boolean(), hardConstraint: z.boolean(), applicable: z.boolean(), status: EvaluationQualitySchema,
  value: nullableNumber, numerator: nullableNumber, denominator: nullableNumber, unit: text, reason: text, missing: z.array(text), evidenceRefs: z.array(ref),
  actual: EvaluationValueSummarySchema, expected: EvaluationValueSummarySchema,
});
export const EvaluationFeedbackSchema = z.strictObject({
  id: OpaqueIdSchema, source: z.enum(['local', 'langfuse']), sourceId: ref, reviewer: z.string().min(1).max(200), reviewedAt: TimestampSchema,
  executionId: ExecutionIdSchema, caseId: ExecutionIdSchema, trialId: ExecutionIdSchema,
  status: z.enum(['PASS', 'FAIL', 'UNJUDGEABLE']), comment: z.string().min(1).max(4000), evidenceRefs: z.array(ref), conflict: z.boolean(),
});
export const EvaluationCoverageSchema = z.strictObject({ metricId: ref, version: ref, summary: EvaluationValueSummarySchema });
const sectionFields = { executionId: ExecutionIdSchema, archiveState: EvaluationArchiveStateSchema };
const sectionPage = <N extends string, S extends z.ZodType>(section: N, item: S) => evaluationPageSchema(item).extend({ ...sectionFields, section: z.literal(section) });
export const EvaluationReportSectionViewSchema = z.union([
  z.strictObject({ ...sectionFields, section: z.literal('summary'), summary: EvaluationReportSummarySchema }),
  sectionPage('cases', EvaluationCaseSchema), sectionPage('trials', EvaluationTrialSchema), sectionPage('scores', EvaluationScoreSchema),
  sectionPage('coverage', EvaluationCoverageSchema), sectionPage('feedback', EvaluationFeedbackSchema), sectionPage('diagnostics', EvaluationDiagnosticSchema),
]);
export const EvaluationExportReceiptSchema = z.strictObject({ eventId: ref, state: z.enum(['accepted', 'rejected', 'unknown']), receivedAt: TimestampSchema.nullable(), safeError: text.nullable() });
export const EvaluationExportViewSchema = z.strictObject({
  exportExists: z.boolean(), state: z.enum(['disabled', 'complete', 'error']), accepted: count, rejected: count, unknown: count, remaining: count,
  receipts: evaluationPageSchema(EvaluationExportReceiptSchema),
});
export const EvaluationOperationResultSchema = z.union([
  z.strictObject({ kind: z.literal('run'), report: EvaluationReportSummarySchema.nullable() }),
  z.strictObject({ kind: z.enum(['resend', 'review_sync']), platform: EvaluationExportViewSchema }),
]);
export const EvaluationProgressSchema = z.strictObject({
  trialId: ExecutionIdSchema, caseId: ExecutionIdSchema, repetition: PositiveIdSchema, index: PositiveIdSchema, total: PositiveIdSchema,
  trialsPerCase: PositiveIdSchema.optional(), kind: z.enum(['phase', 'heartbeat', 'execution', 'score', 'saved', 'case_summary']),
  phase: z.enum(['prepare_input', 'prepare_host', 'execute', 'collect', 'score', 'save']), elapsedMs: count, phaseElapsedMs: count.optional(),
  executionStatus: EvaluationTrialSchema.shape.status.optional(), status: EvaluationQualitySchema.optional(), reason: text.nullable().optional(),
  checks: z.array(z.strictObject({ metricId: ref, status: EvaluationQualitySchema })).optional(),
});
export const EvaluationControlViewSchema = z.strictObject({
  controllerInstanceId: EvaluationOperationRefSchema, operationKind: z.enum(['run', 'review_sync', 'resend']).nullable(),
  operationRef: EvaluationOperationRefSchema.nullable(), executionId: ExecutionIdSchema.nullable(),
  state: z.enum(['idle', 'starting', 'running', 'cancelling', 'settled', 'blocked', 'unknown']), sequence: count,
  currentTrial: EvaluationTrialSchema.nullable(), stopConfirmed: z.boolean().nullable(), saveConfirmed: z.boolean().nullable(), controllerExited: z.boolean().nullable(),
  progress: EvaluationProgressSchema.nullable(), progressCounts: EvaluationTotalsSchema.extend({ saved: count }),
  blockReasons: z.array(EvaluationDiagnosticSchema), result: EvaluationOperationResultSchema.nullable(), error: AppErrorSchema.nullable(),
});
export const EvaluationPreflightViewSchema = z.strictObject({
  preflightId: EvaluationOperationRefSchema, datasetId: ExecutionIdSchema, selection: z.enum(['smoke', 'full']), trials: PositiveIdSchema,
  cases: count, plannedTrials: count, judgeRequestLimit: count, readiness: text, config: EvaluationValueSummarySchema.nullable(),
  platformConfigured: z.boolean(), blockers: z.array(EvaluationDiagnosticSchema),
});
export const EvaluationStartReceiptSchema = z.strictObject({ operationRef: EvaluationOperationRefSchema, executionId: ExecutionIdSchema, accepted: z.literal(true) });
export const EvaluationPlatformReceiptSchema = EvaluationStartReceiptSchema.extend({ operationKind: z.enum(['review_sync', 'resend']) });
export const EvaluationShutdownProofSchema = z.strictObject({ stopConfirmed: z.boolean().nullable(), saveConfirmed: z.boolean().nullable(), controllerExited: z.boolean(), executionId: ExecutionIdSchema.nullable(), gaps: z.array(EvaluationDiagnosticSchema) });
const execution = z.strictObject({ executionId: ExecutionIdSchema });
const reportInput = EvaluationPaginationSchema.extend({ executionId: ExecutionIdSchema, section: z.enum(['summary', 'cases', 'trials', 'scores', 'coverage', 'feedback', 'diagnostics']), caseId: ExecutionIdSchema.optional(), trialId: ExecutionIdSchema.optional() });
export const evaluationMethodSchemas = {
  'eval.preflight': { input: EvaluationRunOptionsSchema, output: EvaluationPreflightViewSchema },
  'eval.start': { input: EvaluationRunOptionsSchema.extend({ preflightId: EvaluationOperationRefSchema }), output: EvaluationStartReceiptSchema },
  'eval.cancel': { input: execution, output: z.strictObject({ cancelRequested: z.boolean(), control: EvaluationControlViewSchema }) },
  'eval.status': { input: EvaluationPaginationSchema.extend({ executionId: ExecutionIdSchema.optional(), operationRef: EvaluationOperationRefSchema.optional(), platform: z.enum(['resend', 'review_sync']).optional() })
    .refine(value => !value.platform || !!value.executionId, 'Platform receipts require an execution identity'), output: EvaluationControlViewSchema },
  'eval.report.list': { input: EvaluationPaginationSchema, output: evaluationPageSchema(EvaluationReportSummarySchema) },
  'eval.report.read': { input: reportInput, output: EvaluationReportSectionViewSchema },
  'eval.evidence.read': { input: EvaluationPaginationSchema.extend({ executionId: ExecutionIdSchema, trialId: ExecutionIdSchema, evidenceRef: ref }), output: z.strictObject({ executionId: ExecutionIdSchema, trialId: ExecutionIdSchema, evidenceRef: ref, summary: EvaluationValueSummarySchema, gaps: z.array(EvaluationDiagnosticSchema) }) },
  'eval.compare': { input: z.strictObject({ baselineExecutionId: ExecutionIdSchema, candidateExecutionId: ExecutionIdSchema }), output: z.strictObject({ baselineExecutionId: ExecutionIdSchema, candidateExecutionId: ExecutionIdSchema, comparison: EvaluationValueSummarySchema }) },
  'eval.review.record': { input: z.strictObject({ executionId: ExecutionIdSchema, caseId: ExecutionIdSchema, trialId: ExecutionIdSchema, reviewer: z.string().trim().min(1).max(200), status: z.enum(['PASS', 'FAIL', 'UNJUDGEABLE']), comment: z.string().trim().min(1).max(4000), evidenceRefs: z.array(ref) }), output: z.strictObject({ state: z.enum(['recorded', 'duplicate']), id: OpaqueIdSchema }) },
  'eval.review.sync': { input: execution, output: EvaluationPlatformReceiptSchema },
  'eval.resend': { input: execution, output: EvaluationPlatformReceiptSchema },
} as const;
export type EvaluationMethod = keyof typeof evaluationMethodSchemas;
export type EvaluationPayload<M extends EvaluationMethod> = z.input<(typeof evaluationMethodSchemas)[M]['input']>;
export type EvaluationReturn<M extends EvaluationMethod> = z.output<(typeof evaluationMethodSchemas)[M]['output']>;
export const EvaluationMethodSchema = z.enum(Object.keys(evaluationMethodSchemas) as [EvaluationMethod, ...EvaluationMethod[]]);
export const EvaluationRequestSchema = z.strictObject({ operationRef: EvaluationOperationRefSchema, method: EvaluationMethodSchema, payload: z.unknown() })
  .superRefine((value, context) => { if (!evaluationMethodSchemas[value.method].input.safeParse(value.payload).success) context.addIssue({ code: 'custom', path: ['payload'], message: 'Invalid evaluation input' }); });
export function isEvaluationReadOnlyMethod(method: string): boolean {
  return ['eval.preflight', 'eval.status', 'eval.report.list', 'eval.report.read', 'eval.evidence.read', 'eval.compare'].includes(method);
}
const noticeIdentity = { controllerInstanceId: EvaluationOperationRefSchema, executionId: ExecutionIdSchema.nullable(), sequence: PositiveIdSchema };
export const EvaluationNoticeSchema = z.union([
  z.strictObject({ type: z.literal('eval.status'), ...noticeIdentity, control: EvaluationControlViewSchema }),
  z.strictObject({ type: z.literal('eval.progress'), ...noticeIdentity, progress: EvaluationProgressSchema }),
]);
const frameIdentity = { protocolVersion: z.literal('medclaw.evaluation-control/v1'), controllerInstanceId: EvaluationOperationRefSchema };
export const EvaluationControlFrameSchema = z.union([
  z.strictObject({ ...frameIdentity, kind: z.literal('hello'), paths: EvaluationPathsSchema }),
  z.strictObject({ ...frameIdentity, kind: z.literal('ready') }),
  z.strictObject({ ...frameIdentity, kind: z.literal('request'), requestId: OpaqueIdSchema, request: EvaluationRequestSchema }),
  z.strictObject({ ...frameIdentity, kind: z.literal('reply'), requestId: OpaqueIdSchema, operationRef: EvaluationOperationRefSchema, method: EvaluationMethodSchema, result: resultSchema(z.unknown()) }),
  z.strictObject({ ...frameIdentity, kind: z.literal('notice'), notice: EvaluationNoticeSchema }),
  z.strictObject({ ...frameIdentity, kind: z.literal('shutdown'), requestId: OpaqueIdSchema }),
  z.strictObject({ ...frameIdentity, kind: z.literal('shutdown'), requestId: OpaqueIdSchema, proof: EvaluationShutdownProofSchema }),
]);
export type EvaluationPaths = z.infer<typeof EvaluationPathsSchema>;
export type EvaluationRunOptions = z.infer<typeof EvaluationRunOptionsSchema>;
export type DesktopEvaluationRequest = z.infer<typeof DesktopEvaluationRequestSchema>;
export type EvaluationControlView = z.infer<typeof EvaluationControlViewSchema>;
export type EvaluationReportSummary = z.infer<typeof EvaluationReportSummarySchema>;
export type EvaluationValueSummary = z.infer<typeof EvaluationValueSummarySchema>;
export type EvaluationNotice = z.infer<typeof EvaluationNoticeSchema>;
export type EvaluationControlFrame = z.infer<typeof EvaluationControlFrameSchema>;
export type EvaluationDiagnostic = z.infer<typeof EvaluationDiagnosticSchema>;
export type EvaluationExportView = z.infer<typeof EvaluationExportViewSchema>;
