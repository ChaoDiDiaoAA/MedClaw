import type { JudgeConfiguration } from '../types.ts';
export type EvaluatorKind = 'deterministic' | 'llm-judge';
export type ScoreStatus = 'PASS' | 'FAIL' | 'UNJUDGEABLE' | 'ERROR' | 'NOT_RUN';
export interface CheckSpec {
  name?: string;
  id: string; metricId: string; version: string; required: boolean; hardConstraint: boolean;
  kind: EvaluatorKind; unit: string; goldKey: string; evidenceKey: string;
  threshold?: number; direction?: 'higher' | 'lower';
  scope?: { kind: string; ref: string };
  applicability?: string | { applicable: boolean; reason: string };
}
export interface EvaluationScore {
  trialId: string; caseId: string; metricId: string; name: string; version: string; method: EvaluatorKind;
  checkId: string; scope: { kind: 'trial' | 'run' | 'call' | 'opportunity'; ref: string };
  applicable: boolean; required: boolean; hardConstraint: boolean; status: ScoreStatus;
  value: number | null; unit: string; numerator: number | null; denominator: number | null;
  evidenceRefs: string[]; reason: string; missing: string[]; actual: unknown; expected: unknown;
  details?: unknown;
}
export interface ObservationLike {
  facts: Record<string, unknown>; missing: { key: string; reason: string }[];
  identityChecks: { id: string; passed: boolean; reason: string }[];
  trialId?: string; instanceId?: string;
}
export interface EvaluationContext {
  trialId: string; caseId: string; task: { checks: CheckSpec[] }; gold: Record<string, unknown>;
  observation: ObservationLike | null; trialStatus: string; judge?: Judge; signal?: AbortSignal;
  input?: unknown; result?: unknown;
  onJudgeRequest?: (request: JudgeRequest) => void | Promise<void>;
  onJudgeResult?: (result: JudgeResult) => void | Promise<void>;
}
export interface RuleResult {
  status: ScoreStatus; value: number | null; numerator: number | null; denominator: number | null;
  reason: string; applicable?: boolean; missing?: string[]; evidenceRefs?: string[]; details?: unknown;
}
export interface EvaluatorDefinition {
  id: string; name: string; version: string; kind: EvaluatorKind; behavior: boolean;
  layer: string; formula: string;
  appliesTo?: (expected: unknown, context: EvaluationContext) => {applicable:boolean;reason:string};
  evaluate(expected: unknown, actual: unknown, check: CheckSpec, context: EvaluationContext): RuleResult | Promise<RuleResult>;
}
export interface JudgeRequest {
  trialId: string; checks: { checkId: string; rubric: string; evidenceRefs: string[];counted?:CountedJudgeCriterion }[];
  answer: string; evidence: unknown;
}
export interface CountedJudgeCriterion {unit:'assertion'|'citation'|'completion-claim';denominator?:number}
export interface JudgeResult {
  status: 'completed' | 'error';
  results: { checkId: string; value: number | null; reason: string; evidenceRefs: string[];numerator?:number|null;denominator?:number|null }[];
  error: string | null; metadata: JudgeMetadata;
}
export interface JudgeMetadata {
  baseUrl:string;timeoutMs:number;model: string; startedAt: string; endedAt: string; durationMs: number;
  nativeModel?:JudgeConfiguration['nativeModel'];
  outputLimit?: 256; temperature: 0.8; httpStatus: number | null; requestId: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null };
}
export interface Judge { readonly configuration?:JudgeConfiguration;judge(request: JudgeRequest, signal?: AbortSignal): Promise<JudgeResult> }
export interface PlannedTrial { trialId: string; caseId: string; repetition: number }
export interface AggregateTrial extends PlannedTrial { status: string; startedAt?: string | null }
export interface TrialJudgement extends PlannedTrial {
  status: ScoreStatus; executionStatus: string; started: boolean; completed: boolean; gaps: string[];
}
export interface CaseSummary {
  caseId: string; planned: number; started: number; completed: number; first: TrialJudgement;
  repeats: TrialJudgement[]; allPass: boolean; status: ScoreStatus;
}
export interface MetricSummary {
  metricId: string; version: string; method: EvaluatorKind; unit: string;
  planned: number; applicable: number; pass: number; fail: number; unjudgeable: number;
  error: number; notRun: number; inapplicable: number; numerator: number | null;
  denominator: number | null; value: number | null; judgeablePassRate: number | null;
  judgeableCoverage: number | null; trialIds: string[]; details?: unknown;
}
export interface Aggregation {
  dimensions?:Record<string,unknown>;evalTypes?:Record<string,unknown>;
  trials: TrialJudgement[]; cases: CaseSummary[]; metrics: MetricSummary[];
  modules:Record<string,{declaredCases:string[];checks:number;applicable:number;judgeable:number;pass:number;fail:number;unjudgeable:number;error:number;notRun:number}>;
  business:MetricSummary[];runtimeGates:MetricSummary[];
  totals: { planned: number; pass: number; fail: number; unjudgeable: number; error: number; notRun: number };
}
