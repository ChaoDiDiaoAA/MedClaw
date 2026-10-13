import type { EvaluatorDefinition } from './types.ts';
import { equal, ratio, record, unknown } from './rules.ts';
import m0 from './evaluators/operation.recovery.ts';
import m1 from './evaluators/export.delivery.ts';
import m2 from './evaluators/answer.commit.ts';
import m3 from './evaluators/config.rollback.ts';
import m4 from './evaluators/config.persistence.ts';
import m5 from './evaluators/host.recovery.ts';
import m6 from './evaluators/task.success.ts';
import m7 from './evaluators/execution.completed.ts';
import m8 from './evaluators/coverage.judgeable.ts';
import m9 from './evaluators/stability.all_pass.ts';
import m10 from './evaluators/efficiency.latency.ts';
import m11 from './evaluators/efficiency.calls.ts';
import m12 from './evaluators/efficiency.tokens.ts';
import m13 from './evaluators/efficiency.cost.ts';
import m14 from './evaluators/efficiency.correction.ts';
import m15 from './evaluators/efficiency.retries.ts';
import m16 from './evaluators/provider.identity.ts';
import m17 from './evaluators/provider.catalog.ts';
import m18 from './evaluators/provider.auth.ts';
import m19 from './evaluators/provider.output_limit.ts';
import m20 from './evaluators/provider.usage.ts';
import m21 from './evaluators/provider.error.ts';
import m22 from './evaluators/provider.cancel.ts';
import m23 from './evaluators/loop.native.ts';
import m24 from './evaluators/loop.termination.ts';
import m25 from './evaluators/loop.budget.ts';
import m26 from './evaluators/tool.selection.ts';
import m27 from './evaluators/tool.params.ts';
import m28 from './evaluators/tool.schema.ts';
import m29 from './evaluators/tool.scope.ts';
import m30 from './evaluators/tool.once.ts';
import m31 from './evaluators/tool.result.ts';
import m32 from './evaluators/tool.delivery.ts';
import m33 from './evaluators/tool.adoption.ts';
import m34 from './evaluators/messages.context.ts';
import m35 from './evaluators/messages.delivery.ts';
import m36 from './evaluators/messages.projection.ts';
import m37 from './evaluators/event.integrity.ts';
import m38 from './evaluators/event.replay.ts';
import m39 from './evaluators/session.isolation.ts';
import m40 from './evaluators/session.select.ts';
import m41 from './evaluators/session.delivery.ts';
import m42 from './evaluators/session.input_read.ts';
import m43 from './evaluators/session.steer.ts';
import m44 from './evaluators/session.followup.ts';
import m45 from './evaluators/session.model_switch.ts';
import m46 from './evaluators/workspace.submission_consistency.ts';
import m47 from './evaluators/workspace.restore.ts';
import m48 from './evaluators/context.delivery.ts';
import m49 from './evaluators/context.relevance.ts';
import m50 from './evaluators/context.correction.ts';
import m51 from './evaluators/memory.completeness.ts';
import m52 from './evaluators/memory.restore.ts';
import m53 from './evaluators/memory.branch.ts';
import m54 from './evaluators/compaction.native.ts';
import m55 from './evaluators/compaction.continue.ts';
import m56 from './evaluators/resource.discovery.ts';
import m57 from './evaluators/resource.read.ts';
import m58 from './evaluators/resource.follow.ts';
import m59 from './evaluators/extension.revalidate.ts';
import m60 from './evaluators/extension.lifecycle.ts';
import m61 from './evaluators/subagent.identity.ts';
import m62 from './evaluators/subagent.scope.ts';
import m63 from './evaluators/subagent.utility.ts';
import m64 from './evaluators/subagent.stop.ts';
import m65 from './evaluators/import.atomic.ts';
import m66 from './evaluators/import.idempotent.ts';
import m67 from './evaluators/import.order.ts';
import m68 from './evaluators/storage.commit.ts';
import m69 from './evaluators/storage.history_error.ts';
import m70 from './evaluators/config.runtime_consistency.ts';
import m71 from './evaluators/desktop.entry.ts';
import m72 from './evaluators/host.single_owner.ts';
import m73 from './evaluators/host.shutdown.ts';
import m74 from './evaluators/artifact.integrity.ts';
import m75 from './evaluators/records.boundary.ts';
import m76 from './evaluators/query.conditions.ts';
import m77 from './evaluators/query.set_precision.ts';
import m78 from './evaluators/query.set_recall.ts';
import m79 from './evaluators/query.set_exact.ts';
import m80 from './evaluators/query.numeric.ts';
import m81 from './evaluators/query.aggregate.ts';
import m82 from './evaluators/query.trend.ts';
import m83 from './evaluators/diff.exact.ts';
import m84 from './evaluators/evidence.coverage.ts';
import m85 from './evaluators/evidence.valid.ts';
import m86 from './evaluators/answer.faithful.ts';
import m87 from './evaluators/answer.reasoning.ts';
import m88 from './evaluators/answer.empty.ts';
import m89 from './evaluators/answer.clarify.ts';
import m90 from './evaluators/answer.refuse.ts';
import m91 from './evaluators/export.exact.ts';
import m92 from './evaluators/task.end_to_end.ts';
import m93 from './evaluators/intent.json.ts';
import m94 from './evaluators/intent.macro_f1.ts';
import m95 from './evaluators/intent.slots_exact.ts';
import m96 from './evaluators/intent.clarify_recall.ts';
import m97 from './evaluators/intent.refusal_recall.ts';
import m98 from './evaluators/intent.false_refusal.ts';
import m99 from './evaluators/intent.route_exact.ts';
import m100 from './evaluators/security.scope.ts';
import m101 from './evaluators/security.injection.ts';
import m102 from './evaluators/security.gold.ts';
import m103 from './evaluators/security.secret.ts';
import m104 from './evaluators/security.side_effect.ts';
import m105 from './evaluators/facility.schema.ts';
import m106 from './evaluators/facility.lineage.ts';
import m107 from './evaluators/facility.isolation.ts';
import m108 from './evaluators/facility.observation.ts';
import m109 from './evaluators/facility.cleanup.ts';
import m110 from './evaluators/facility.scorer.ts';
import m111 from './evaluators/facility.judge.ts';
import m112 from './evaluators/facility.export.ts';
import m113 from './evaluators/facility.resend.ts';
import m114 from './evaluators/task.verify_completion.ts';
import m115 from './evaluators/task.false_completion.ts';
import m116 from './evaluators/task.clarify_decision.ts';
import m117 from './evaluators/tool.redundancy.ts';
import m118 from './evaluators/skill.selection.ts';
import m119 from './evaluators/resource.progressive_read.ts';
import m120 from './evaluators/context.necessary_coverage.ts';
import m121 from './evaluators/context.current_use.ts';
import m122 from './evaluators/memory.history_use.ts';
import m123 from './evaluators/compaction.fact_retention.ts';
import m124 from './evaluators/subagent.delegation.ts';
import m125 from './evaluators/subagent.success.ts';
import m126 from './evaluators/subagent.identity_scope.ts';

export const metricLedger: readonly EvaluatorDefinition[] = Object.freeze([m0, m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12, m13, m14, m15, m16, m17, m18, m19, m20, m21, m22, m23, m24, m25, m26, m27, m28, m29, m30, m31, m32, m33, m34, m35, m36, m37, m38, m39, m40, m41, m42, m43, m44, m45, m46, m47, m48, m49, m50, m51, m52, m53, m54, m55, m56, m57, m58, m59, m60, m61, m62, m63, m64, m65, m66, m67, m68, m69, m70, m71, m72, m73, m74, m75, m76, m77, m78, m79, m80, m81, m82, m83, m84, m85, m86, m87, m88, m89, m90, m91, m92, m93, m94, m95, m96, m97, m98, m99, m100, m101, m102, m103, m104, m105, m106, m107, m108, m109, m110, m111, m112, m113, m114, m115, m116, m117, m118, m119, m120, m121, m122, m123, m124, m125, m126].map(x => Object.freeze(x)));
export class EvaluatorRegistry {
  private readonly entries = new Map<string, EvaluatorDefinition>();
  constructor(definitions: readonly EvaluatorDefinition[]) {
    for (const definition of definitions) {
      if (this.entries.has(definition.id)) throw new Error('Duplicate metric: ' + definition.id);
      this.entries.set(definition.id, definition);
    }
  }
  get(id: string): EvaluatorDefinition {
    const found = this.entries.get(id);
    if (!found) throw new Error('Unknown metric: ' + id);
    return found;
  }
  has(id: string, version: string): boolean { return this.entries.get(id)?.version === version; }
}
export const semanticMetrics = new Set(['task.clarify_decision','tool.adoption','context.current_use','memory.history_use','compaction.fact_retention','compaction.continue','subagent.success','subagent.utility','resource.follow']);
export const registry = new EvaluatorRegistry([...metricLedger.map(metric=>semanticMetrics.has(metric.id)?{...metric,kind:'llm-judge' as const}:metric),
  {id:'tool.failure_handling',name:'Bounded recovery from a recorded tool failure',version:'v1',kind:'deterministic',behavior:false,layer:'process',formula:'Actual expected failure, no failed-call side effects, and a justified fresh retry within the authored limit',evaluate:(g,a,c)=>{
    if(!record(g)||g.expectedFailureMode!=='tool_timeout'||!Number.isSafeInteger(g.maxRetries)||g.maxRetries<0)return {status:'ERROR',value:null,numerator:null,denominator:1,reason:'Invalid controlled failure criterion'};
    if(!record(a)||a.complete!==true||!Array.isArray(a.attempts)||!Array.isArray(a.queries))return unknown('Complete original tool failures and Query ownership required',1);
    const attempts=a.attempts,failures=attempts.filter((tool:any)=>tool.status==='failed'&&tool.error?.code===g.expectedFailureMode);
    if(failures.length!==1)return ratio(0,1,c,{expectedFailures:1,observedFailures:failures.length});
    const failed=failures[0],retries=attempts.filter((tool:any)=>tool.id>failed.id);
    if(failed.control?.failureStage!=='execution'||!Number.isFinite(failed.control?.executionElapsedMs)||!failed.stoppedAt||!failed.sdkDelivery||!failed.nextModelCallId||failed.consumptionEvidence!=='provider_input_verified')return unknown('Recorded execution, SDK error delivery and subsequent decision required',1);
    const valid=failed.sdkDelivery.isError===true&&a.queries.every((query:any)=>query.callRef!==`${failed.runId}:${failed.nativeToolCallId}`)&&retries.length>0&&retries.length<=g.maxRetries&&retries.every((tool:any)=>tool.nativeToolCallId!==failed.nativeToolCallId&&typeof tool.modelCallId==='string'&&tool.modelCallId!==failed.modelCallId)&&retries.at(-1)?.status==='succeeded';
    return ratio(Number(valid),1,c,{retries:retries.length,maxRetries:g.maxRetries,failureCallId:failed.id});
  }},
  {id:'query.facts',name:'数据日期、缺失与单位',version:'v1',kind:'deterministic',behavior:false,layer:'result',formula:'独立业务解释完全相同',evaluate:(g,a,c)=>record(g)&&record(a)?ratio(Number(equal(g,a)),1,c):unknown('Complete date, gap, missing-value and unit facts required')},
  {id:'query.coverage',name:'指定日期的数据覆盖',version:'v1',kind:'deterministic',behavior:false,layer:'result',formula:'完整目录与已登记导入原文核对日期覆盖',evaluate:(g,a,c)=>record(g)&&record(a)?ratio(Number(equal(g,a)),1,c):unknown('Verified complete source catalog required')},
  {id:'evidence.present',name:'有来源的实际依据',version:'v1',kind:'deterministic',behavior:false,layer:'result',formula:'合法空结果也可有充分依据',evaluate:(g,a,c)=>{
    if(!record(a)||a.complete!==true||!Array.isArray(a.refs))return unknown('Complete original source references required');
    if(!record(g)||!g.expectedSources?.length&&g.minSources===undefined&&!g.sourceKinds?.length)return ratio(Number(a.refs.length>0),1,c);
    if(!Array.isArray(a.sources)||!a.sources.every((source:unknown)=>record(source)&&typeof source.id==='string'&&typeof source.kind==='string'))return unknown('Verified independent source identities and kinds required',1);
    const sources=[...new Map(a.sources.map((source:any)=>[source.id,source])).values()] as {id:string;kind:string}[];
    return ratio(Number(a.refs.length>0&&(g.expectedSources??[]).every((id:string)=>sources.some(source=>source.id===id))&&sources.length>=(g.minSources??1)&&(g.sourceKinds??[]).every((kind:string)=>sources.some(source=>source.kind===kind))),1,c,{independentSources:sources.length});
  }},
]);
export const knownMetric = (id: string, version: string): boolean => registry.has(id, version);
export function scoringCriteria(ids:Iterable<string>) {
  return [...new Set(ids)].sort().map(id=>{const definition=registry.get(id);return {id,name:definition.name,version:definition.version,kind:definition.kind,formula:definition.formula,...scorerPolicy(id)};});
}

export function scorerPolicy(id:string) {
  registry.get(id);
  const dimension = id.startsWith('security.') || id==='subagent.identity_scope' ? 'safety' : /^(facility|host)\./.test(id) ? 'infrastructure' : /^(task.success|query\.|diff\.|answer\.|export\.|evidence\.)/.test(id) ? 'result' : 'process';
  return {dimension,hardConstraint:dimension==='safety'||dimension==='infrastructure',unit:id==='query.numeric'?'CNY cents':id==='efficiency.calls'?'tool calls':'opportunities',threshold:['task.false_completion','tool.redundancy'].includes(id)?0:1,direction:['task.false_completion','tool.redundancy'].includes(id)?'lower' as const:'higher' as const};
}
