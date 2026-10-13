import type { EvaluationReport } from '../types.ts';
import { randomUUID } from 'node:crypto';
import type { VerifiedObservation } from '../types.ts';
import { scorerPolicy } from '../scoring/registry.ts';

export interface ExportEvent { id: string; objectId: string; kind: 'span' | 'score'; payload: Record<string, unknown> }
export interface ExportEnvelope {
  contract: 'medclaw-observability-export/v1'; exportPolicyVersion: 'v1';
  transport: 'otel-http-json/v1'; executionId: string; events: ExportEvent[]; identities:Record<string,string>;
}
export function assertSafeExport(value: unknown): void {
  if (typeof value === 'string' && /(?:Bearer\s+\S+|(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|[?&](?:key|token|secret)=)/i.test(value)) throw new Error('sensitive_export_rejected');
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:authorization|apiKey|api_key|secret|secretKey|password|env|environmentVariables|gold|futureSteps|stdout|stderr)$/i.test(key)) throw new Error('sensitive_export_rejected');
    assertSafeExport(item);
  }
}
const nano = (time: string) => (BigInt(Date.parse(time)) * 1_000_000n).toString();
const attributes = (values: Record<string, unknown>) => Object.entries(values).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => ({ key, value: typeof value === 'number' ? { doubleValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } }));

export function mapReport(report: EvaluationReport, observations:Record<string,VerifiedObservation>={}, identities:Record<string,string>={}): ExportEnvelope {
  const idFor=(kind:string, parts:unknown[], length=36)=>{const key=JSON.stringify([kind,parts]);const id=identities[key]??=(length===36?randomUUID():randomUUID().replaceAll('-','').slice(0,length));if(!(length===36?/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/:new RegExp('^[a-f0-9]{'+length+'}$')).test(id))throw new Error('export_identity_invalid');return id;};
  const events: ExportEvent[] = [];
  const push = (kind: ExportEvent['kind'], objectId: string, payload: Record<string, unknown>) => {
    assertSafeExport(payload);
    events.push({ id: idFor('medclaw-export-event/v1', [kind, objectId, 1]), kind, objectId, payload });
  };
  for (const trial of report.trials) {
    if (!trial.startedAt) continue;
    const observation = observations[trial.trialId] ?? { observedFrom: trial.startedAt, observedUntil: trial.endedAt ?? trial.startedAt, facts: {} as Record<string, unknown>, missing: [{ key: 'observation', reason: 'Started trial has no verified observation; startup/shutdown proof remains local' }] };
    const traceId = idFor('medclaw-trace/v1', [report.executionId, trial.trialId], 32);
    const spanId = (kind: string, id: string | number) => idFor('medclaw-observation/v1', [traceId, trial.instanceId ?? 'instance_unobserved', kind, id], 16);
    const rootId = spanId('trial', trial.trialId);
    const task = report.cases.find(task => task.id === trial.caseId)!;
    const common = {
      'langfuse.session.id': report.executionId, 'langfuse.environment': report.config.environment,
      'langfuse.trace.name': task.name, 'langfuse.trace.metadata.executionId': report.executionId,
      'langfuse.trace.metadata.trialId': trial.trialId, 'langfuse.trace.metadata.caseId': trial.caseId,
      'medclaw.instanceId': trial.instanceId, 'medclaw.repetition': trial.repetition,
      'medclaw.datasetId': report.dataset.id, 'medclaw.datasetVersion': report.dataset.version,
      'medclaw.caseVersion': task.version, 'medclaw.category': task.category, 'medclaw.tags': task.tags,
    };
    const span = (id: string, name: string, parent: string | null, start: string, end: string, meta: Record<string, unknown>) => push('span', id, {
      resourceSpans: [{ resource: { attributes: attributes({ 'service.name': 'medclaw-evaluation' }) }, scopeSpans: [{ scope: { name: 'medclaw-evaluation', version: 'v1' }, spans: [{ traceId, spanId: id, ...(parent ? { parentSpanId: parent } : {}), name, kind: 1, startTimeUnixNano: nano(start), endTimeUnixNano: nano(end), attributes: attributes({ ...common, ...meta }) }] }] }],
    });
    span(rootId, `trial/${trial.caseId}`, null, trial.startedAt, trial.endedAt ?? observation.observedUntil, {
      'medclaw.executionStatus': trial.status, 'medclaw.stopped': trial.stopped,
      'medclaw.closed': trial.closed, 'medclaw.evidenceGaps': observation.missing.map(gap => gap.key),
      'medclaw.unmeasured': report.scores.filter(score => score.trialId === trial.trialId && score.value === null).map(score => ({ metricId: score.metricId, checkId: score.checkId, status: score.status })),
    });
    const kinds: Record<string, string> = { runs: 'run', modelCalls: 'model_call', toolCalls: 'tool_call', queries: 'query', evidence: 'evidence', answers: 'answer', artifacts: 'artifact', operations: 'operation' };
    for (const [key, kind] of Object.entries(kinds)) {
      const facts = observation.facts[key];
      if (!Array.isArray(facts)) continue;
      for (const fact of facts) {
        if (!fact || typeof fact !== 'object') continue;
        const id = kind === 'model_call' ? fact.callId ?? fact.id : fact.id ?? fact.operationRef;
        if (typeof id !== 'string' && typeof id !== 'number') continue;
        const start = typeof fact.startedAt === 'string' ? fact.startedAt : observation.observedFrom;
        const end = typeof fact.endedAt === 'string' ? fact.endedAt : start;
        const parentRunId = kind === 'run' ? fact.parentRunId : fact.runId;
        span(spanId(kind, id), `${kind}/${id}`, typeof parentRunId === 'number' ? spanId('run', parentRunId) : rootId, start, end, {
          'langfuse.observation.type': kind === 'model_call' ? 'generation' : 'span',
          'medclaw.objectKind': kind, 'medclaw.objectId': id, 'medclaw.runId': fact.runId,
          'medclaw.sessionId': fact.sessionId, 'medclaw.parentRunId': fact.parentRunId,
          'medclaw.stage': fact.stage, 'medclaw.status': fact.status ?? fact.state,
          'medclaw.timeSource': fact.startedAt ? 'product' : 'observation_only_execution_time_unknown',
          ...(kind === 'model_call' ? {
            'langfuse.observation.model.name': fact.model?.modelId ?? fact.model?.modelTag ?? fact.model?.model,
            'langfuse.observation.usage_details': { ...(typeof fact.inputTokens === 'number' ? { input: fact.inputTokens } : {}), ...(typeof fact.outputTokens === 'number' ? { output: fact.outputTokens } : {}) },
            ...(typeof fact.cost === 'number' && fact.costCurrency === 'USD' ? { 'langfuse.observation.cost_details': { total: fact.cost } } : {}),
            'medclaw.usageSource': fact.usageSource, 'medclaw.usageUnavailableReason': fact.unavailableReason,
            'medclaw.costCurrency': fact.costCurrency, 'medclaw.attemptCountUnknown': fact.attemptCountUnknown,
          } : {}),
        });
      }
    }
    for (const call of report.judgeCalls.filter(call => call.trialId === trial.trialId)) {
      const metadata = call.result.metadata;
      span(spanId('judge', trial.trialId), 'judge/answer-quality', rootId, metadata.startedAt, metadata.endedAt, {
        'langfuse.observation.type': 'generation', 'langfuse.observation.model.name': metadata.model,
        'langfuse.observation.usage_details': { ...(metadata.usage.promptTokens !== null ? { input: metadata.usage.promptTokens } : {}), ...(metadata.usage.completionTokens !== null ? { output: metadata.usage.completionTokens } : {}) },
        'medclaw.status': call.result.status, 'medclaw.httpStatus': metadata.httpStatus,
        'medclaw.requestId': metadata.requestId,
        ...metadata.outputLimit!==undefined?{'medclaw.outputLimit':metadata.outputLimit}:{},
        'medclaw.temperature': metadata.temperature, 'medclaw.usageSource': 'independent_judge_response', 'medclaw.costSource': 'unknown',
      });
    }
    for (const score of report.scores.filter(score => score.trialId === trial.trialId && score.value !== null)) {
      const scope = score.scope ?? { kind: 'trial', ref: trial.trialId };
      const id = idFor('medclaw-score/v1', [traceId, 1, score.metricId, score.version, score.method, score.checkId, scope.kind, scope.ref]);
      const scoringId = spanId('scoring', id);
      span(scoringId, `scoring/${score.metricId}`, rootId, observation.observedUntil, observation.observedUntil, {
        'medclaw.metricId': score.metricId, 'medclaw.scorerVersion': score.version, 'medclaw.checkId': score.checkId,
        'medclaw.scope': scope, 'medclaw.method': score.method, 'medclaw.status': score.status,
        'medclaw.timeSource': 'per_check_execution_time_unknown', 'medclaw.judgeObservationId': score.method === 'llm-judge' && report.judgeCalls.some(call => call.trialId === trial.trialId) ? spanId('judge', trial.trialId) : null,
      });
      if (score.value === null) continue;
      push('score', id, { id, traceId, observationId: scoringId, name: score.metricId, value: score.value, dataType: 'NUMERIC', environment: report.config.environment,
        metadata: { dimension:scorerPolicy(score.metricId).dimension, scorerVersion: score.version, method: score.method, checkId: score.checkId, scope, status: score.status, unit: score.unit, numerator: score.numerator, denominator: score.denominator, executionId: report.executionId } });
    }
  }
  if (new Set(events.map(event => event.id)).size !== events.length) throw new Error('export_duplicate_identity');
  return { contract: 'medclaw-observability-export/v1', exportPolicyVersion: 'v1', transport: 'otel-http-json/v1', executionId: report.executionId, events, identities };
}
