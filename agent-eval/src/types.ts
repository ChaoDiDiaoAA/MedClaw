import { z } from 'zod';
import type { EvaluationScore, JudgeResult } from './scoring/types.ts';
import type { DatasetSnapshot,CompiledDataset } from './datasets.ts';
import type {QualityMetricDefinition,QualityMetricCatalogVersion} from './scoring/registry.ts';
import type {ReportAnalysis} from './reports/analysis.ts';
import { ANSWER_QUALITY_RUBRIC } from './scoring/judges/answer-quality.ts';
import { CustomBaseUrlSchema,CustomProviderDefinitionSchema } from '../../packages/contracts/src/model.ts';

export const JudgeConfigurationSchema=z.strictObject({
  baseUrl:z.url().refine(value=>{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash&&(url.protocol==='https:'||['127.0.0.1','localhost','[::1]'].includes(url.hostname));}).transform(value=>new URL(value).href),
  model:z.string().trim().min(1),timeoutMs:z.number().int().positive().max(30000).default(30000),
  nativeModel:z.strictObject({catalogRef:z.string().min(1),api:z.string().min(1),contextWindow:z.number().int().positive(),maxTokens:z.number().int().positive(),sdkVersion:z.literal('0.87.1')}).optional(),
  // Historical archives retain this field; new runtime configurations omit it.
  outputLimit:z.literal(256).optional(),temperature:z.literal(.8).default(.8),
  systemRubric:z.literal(ANSWER_QUALITY_RUBRIC).default(ANSWER_QUALITY_RUBRIC),
});
export type JudgeConfiguration=z.infer<typeof JudgeConfigurationSchema>;

export const ExecutionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/).refine(value=>!/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value),'Reserved filesystem identity');
export const ResolvedRunConfigSchema = z.strictObject({
  version:z.literal(1), environment:z.string().regex(/^(?!langfuse)[a-z0-9][a-z0-9_-]{0,99}$/),
  model:z.strictObject({provider:z.string().min(1),model:z.string().min(1),maxTokens:z.number().int().positive(),definition:CustomProviderDefinitionSchema.optional()})
    .refine(value=>!value.definition||value.definition.providerId===value.provider&&value.definition.models.length===1&&value.definition.models[0]!.id===value.model&&value.definition.models[0]!.maxTokens===value.maxTokens,'Resolved native model configuration is inconsistent'),
  intent:z.strictObject({baseUrl:z.url(),model:z.literal('qwen3.5:0.8b')}),
  judge:JudgeConfigurationSchema.optional(),
  policy:z.record(z.string(),z.unknown()),
  retention:z.enum(['preserve_all','preserve_on_failure']),
  comparison:z.strictObject({baselineExecutionId:ExecutionIdSchema,factors:z.array(z.enum(['model.provider','model.model','model.maxTokens','policy','source'])).min(1).refine(x=>new Set(x).size===x.length)}).optional(),
});
export type ResolvedRunConfig = z.infer<typeof ResolvedRunConfigSchema>;
export const RunConfigSchema = ResolvedRunConfigSchema.omit({judge:true,model:true}).extend({
  model:z.strictObject({url:CustomBaseUrlSchema,key:z.string().refine(value=>!!value.trim(),'Agent API key is required'),model:z.string().trim().min(1)}),
});
export interface AgentModelCredential {providerId:string;key:string}
export type TrialStatus = 'planned'|'preparing'|'running'|'completed'|'failed'|'cancelled'|'infra_error'|'not_run';
export interface TrialPlan {trialId:string;caseId:string;repetition:number}
export interface VerifiedObservation {
  executionId:string;trialId:string;instanceId:string;observedFrom:string;observedUntil:string;
  identityChecks:{id:string;passed:boolean;reason:string}[];facts:Record<string,unknown>;missing:{key:string;reason:string}[];
}
export interface TrialResult extends TrialPlan {
  status:TrialStatus;instanceId:string|null;startedAt:string|null;endedAt:string|null;reason:string|null;
  stopped:boolean|null;closed:boolean|null;observation:VerifiedObservation|null;
}
export type ArchivedTrial = Omit<TrialResult,'observation'> & {observationRef:string|null};
export interface EvidenceFile {path:string;bytes:number;sensitivity:'private'|'approved-summary'}
export interface ExecutionSnapshot {
  contract:'medclaw-execution-snapshot/v1';executionId:string;dataset:DatasetSnapshot;
  config:ResolvedRunConfig;criteria:unknown;source:Record<string,unknown>;
  compiled:CompiledDataset;
  plan?:TrialPlan[];preparationTurns?:Record<string,number>;
  qualityMetricCatalog?:QualityMetricDefinition[];
  qualityMetricCatalogVersion?:QualityMetricCatalogVersion;
}
export interface EvaluationReport {
  contract:'medclaw-evaluation-report/v1';executionId:string;snapshotRef:'snapshot.json';
  dataset:{id:string;version:1};
  cases:{id:string;version:1;name:string;category:string;evalType:'capability'|'regression';tags:string[]}[];
  modules:Record<string,string[]>;
  plan:TrialPlan[];trials:ArchivedTrial[];scores:EvaluationScore[];
  judgeCalls:{trialId:string;result:JudgeResult}[];evidenceManifest:EvidenceFile[];
  totals:{planned:number;pass:number;fail:number;unjudgeable:number;error:number;notRun:number};
  aggregation:unknown;createdAt:string;
  analysis?:ReportAnalysis;
  reviewCandidates:{trialId:string;caseId:string;reasons:string[];checkIds:string[];evidenceRefs:string[]}[];
  /** Hydrated from snapshot.json, non-enumerable when read or written. */
  snapshot:ExecutionSnapshot;config:ResolvedRunConfig;
}
