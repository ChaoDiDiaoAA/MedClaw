import { createHash, randomUUID } from 'node:crypto';
import { AppErrorSchema, safeError } from '../../../contracts/src/error';
import { IntentInputProjectionSchema, IntentStageInputSchema, IntentValidationSchema, INTENT_STAGE_INPUT_BYTES, type IntentInputProjection,
  type IntentModelClient, type IntentStore, type IntentCallCompletion, type IntentHttpObservation,
  type IntentStageInput, type ReadIntentInput, type IntentValidation } from '../../../contracts/src/intent';
import { FrozenIntentAdmissionSchema, type FrozenIntentAdmission } from '../../../contracts/src/intent';
import { IntentModelConfigurationSchema, IntentModelSelectionSchema, type IntentModelSelection, type IntentModelConfiguration } from '../../../contracts/src/model';
import { WorkspaceContextSchema, type WorkspaceContext } from '../../../contracts/src/workspace';
import type { EventWriter, WriteTransactions } from '../../../contracts/src/event';
import type { QueryExecutionContext } from '../../../contracts/src/query';
import { ContextService } from '../context/context-service';
import { RunControl } from '../runtime/run-control';
import { evaluateIntentRules } from './rules';
import { IntentValidator } from './validate';
import { decideIntentRoute, type IntentDecisionSource } from './route-policy';
import { INTENT_CAPABILITIES } from './taxonomy';

export type IntentExecution = { signal: AbortSignal; checkActive: () => void; control: RunControl;
  workspaceContext: WorkspaceContext; expectedCancelEpoch: number; admission?: FrozenIntentAdmission; inheritedSnapshotMode?:'exact_date'|'as_of'|null };
const now = () => new Date().toISOString();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function stageInput(value: IntentStageInput): IntentStageInput {
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>INTENT_STAGE_INPUT_BYTES)throw safeError('intent_input_too_large');
  return IntentStageInputSchema.parse(value);
}
function notRun(truncated: boolean): IntentValidation {
  return IntentValidationSchema.parse({ contract: 'medclaw.intent-validation/v2', state: 'not_run', finalStatus: null,
    adoptedIntents: [], missingSlots: [], issues: [], resolvedDeviceIds: [], reviewRequired: false, rawOutputTruncated: truncated, checkedAt: null });
}

/** The existing root Runtime owns execution and cancellation; this service commits recognition facts only. */
export class IntentService {
  private readonly pendingSaves = new Map<number, () => void>();
  private readonly recognizing = new Set<number>();
  constructor(private readonly store: IntentStore, private readonly contexts: ContextService,
    private readonly client: IntentModelClient, private readonly validator: IntentValidator,
    private readonly events: EventWriter, private readonly transactions: WriteTransactions) {}
  read(input: ReadIntentInput) { return this.store.readIntent(input); }
  inspectModel(configuration:IntentModelConfiguration,signal:AbortSignal) {return this.client.inspect(configuration,signal);}
  readFreshness(item:import('../../../contracts/src/intent').IntentItem,context:import('../../../contracts/src/query').QueryContext) {return this.validator.readFreshness(item,context);}
  freeze(selection: IntentModelSelection, baseLeafId: string | null, baseStorageVersion: number): FrozenIntentAdmission {
    const frozen = FrozenIntentAdmissionSchema.parse({ contract: 'medclaw.intent-admission/v1', selection, baseLeafId, baseStorageVersion, prompts: this.client.prompts });
    for(const prompt of Object.values(frozen.prompts))if(hash(prompt.text)!==prompt.hash)throw safeError('state_conflict');
    return frozen;
  }
  prepareInput(runId: number) {
    return this.store.prepareIntentInput({ runId, enabledL2: Object.entries(INTENT_CAPABILITIES)
      .filter(([, capability]) => capability.state === 'conditional').map(([l2]) => l2 as keyof typeof INTENT_CAPABILITIES) });
  }
  hasPendingSave(runId: number) { return this.pendingSaves.has(runId); }
  flush(runId: number): void {
    const save = this.pendingSaves.get(runId);
    if (save) { save(); this.pendingSaves.delete(runId); }
  }
  async recognize(raw: IntentInputProjection, rawSelection: IntentModelSelection, execution: IntentExecution) {
    const input = IntentInputProjectionSchema.parse(raw), selection = IntentModelSelectionSchema.parse(rawSelection),
      workspaceContext = WorkspaceContextSchema.parse(execution.workspaceContext);
    const active = () => {
      execution.checkActive(); if (execution.signal.aborted) throw safeError('tool_cancelled'); execution.control.checkActive();
      if(execution.admission && (JSON.stringify(this.freeze(selection,input.baseLeafId,input.baseStorageVersion))!==JSON.stringify(execution.admission)))throw safeError('state_conflict');
    };
    if (this.recognizing.has(input.runId) || this.pendingSaves.has(input.runId)) throw safeError('state_conflict');
    this.recognizing.add(input.runId);
    try {
      active();
      const prior = this.store.readIntent({ runId: input.runId });
      if (prior?.calls.length || prior?.ruleEvaluation || prior?.decision) throw safeError('state_conflict');
      const context: QueryExecutionContext = { runId: input.runId, sessionId: input.sessionId, inputId: input.inputId, source: 'intent',
        callRef: `intent-validation:${input.runId}`, scope: input.scope, referenceDate: input.referenceDate, timezone: input.timezone,
        signal: execution.signal, checkActive: active };
      const rule = evaluateIntentRules(input, now());
      this.transactions.immediate(() => {
        active();
        this.events.appendInTransaction({ type: 'intent_rule_evaluated', runId: input.runId, sessionId: input.sessionId,
          source: 'application', sourceConnection: `intent-rule:${input.runId}`, sourceSequence: 1, toolCallId: null,
          occurredAt: rule.evaluation.checkedAt, receivedAt: rule.evaluation.checkedAt,
          payload: { contract: 'medclaw.event/v1', runId: input.runId, inputId: input.inputId, ruleEvaluation: rule.evaluation } });
      });
      active();
      const callIds: string[] = [];
      const route = (result: Parameters<typeof decideIntentRoute>[0], validation: IntentValidation, source: IntentDecisionSource) => {
        active();
        const decision = decideIntentRoute(result, validation, input, source,execution.inheritedSnapshotMode??null);
        const { decisionId } = this.store.commitRoute({ runId: input.runId, sessionId: input.sessionId, inputId: input.inputId,
          decision, expectedCancelEpoch: execution.expectedCancelEpoch, createdAt: now() });
        active();
        return { callIds, ruleEvaluation: rule.evaluation, decision, decisionId };
      };
      if (rule.result) return route(rule.result, this.validator.validateQueryParams(rule.result, context, input, now(),execution.inheritedSnapshotMode??null), { rule: rule.evaluation });
      if (!selection.enabled || selection.configVersion !== input.versions.configVersion) throw safeError('intent_model_unavailable');
      const modelInput=this.validator.groundInput(input,context);
      const stage = async (projection: IntentStageInput) => {
        active(); execution.control.previewModelCall();
        const configuration = IntentModelConfigurationSchema.parse(Object.fromEntries(Object.keys(IntentModelConfigurationSchema.shape).map(key => [key, selection[key as keyof IntentModelSelection]])));
        const remaining = execution.control.readBudget().remainingTimeMs;
        if (remaining === null) throw safeError('state_conflict');
        const signal = AbortSignal.any([execution.signal, AbortSignal.timeout(Math.max(1, Math.ceil(remaining)))]);
        const inspection = await this.client.inspect(configuration, signal);
        active();
        if (!inspection.available) throw inspection.error ?? safeError('intent_model_unavailable');
        if (inspection.actualDigest !== selection.modelDigest) throw safeError('intent_model_identity_mismatch');
        const snapshot = await this.contexts.prepareIntent({ runId: input.runId, sessionId: input.sessionId, inputId: input.inputId,
          baseLeafId: input.baseLeafId, baseStorageVersion: input.baseStorageVersion, workspaceContext, scope: input.scope,
          nativeRefs: [], projection, createdAt: now() });
        active();
        const preview = execution.control.previewModelCall(), callId = randomUUID();
        this.store.registerIntentCall({ callId, runId: input.runId, sessionId: input.sessionId, inputId: input.inputId,
          snapshotId: snapshot.id, selection, input: projection, stage: projection.stage, previousCallId: projection.review?.previousCallId ?? null, createdAt: now() });
        execution.control.admitModelCall(preview);
        callIds.push(callId);
        const delivery = (observation: IntentHttpObservation) => this.contexts.recordDelivery({ runId: input.runId, sessionId: input.sessionId,
          inputId: input.inputId, callId, snapshotId: snapshot.id, observation });
        const outcome = await this.client.recognizeIntent(projection, selection, signal, async observation => { delivery(observation); });
        let checked = { prediction: null as IntentCallCompletion['parsed'], validation: notRun(outcome.rawOutputTruncated), candidates: [] as ReturnType<IntentValidator['checkPrediction']>['candidates'] };
        let interrupted: unknown = null;
        try {
          active();
          if (outcome.transportState === 'completed' && !outcome.error && outcome.rawOutput !== null) {
            checked = this.validator.checkPrediction(outcome.rawOutput, context, projection, now(), outcome.rawOutputTruncated,execution.inheritedSnapshotMode??null);
            if (checked.validation.state === 'invalid' && !checked.validation.reviewRequired) outcome.error = safeError('intent_output_invalid');
          }
        } catch (error) { interrupted = error; checked = { ...checked, validation: notRun(outcome.rawOutputTruncated) }; }
        const completion: IntentCallCompletion = { callId, runId: input.runId, sessionId: input.sessionId, inputId: input.inputId,
          stage: projection.stage, state: outcome.transportState === 'cancelled' ? 'cancelled' : outcome.transportState === 'failed'
            || outcome.error?.code === 'intent_output_invalid' && checked.prediction === null && !checked.validation.reviewRequired ? 'failed' : 'completed',
          outcome, parsed: checked.prediction, validation: checked.validation };
        const save = () => {
          // A delivery/B2 retry writes these same acquired facts; it cannot call the model or commit a route.
          if (outcome.observation) delivery(outcome.observation);
          this.store.finishIntentCall(completion);
        };
        try { save(); } catch (error) { this.pendingSaves.set(input.runId, save); throw error; }
        if (interrupted) throw interrupted;
        active();
        if (outcome.error) throw outcome.error;
        if (completion.state !== 'completed') throw safeError('intent_model_unavailable');
        return { ...checked, callId, outcome };
      };
      const first = await stage(stageInput({ input:modelInput, stage: 'classify', review: null }));
      active();
      const adopted = first.validation.reviewRequired ? await stage(stageInput({ input:modelInput, stage: 'verify', review: {
        previousCallId: first.callId, prediction: first.prediction, rawHash: hash(first.outcome.rawOutput ?? ''),
        rawPreview: (first.outcome.rawOutput ?? '').slice(0, 4096), issues: first.validation.issues, candidates: first.candidates,
        mode: first.candidates.length ? 'candidate_selection' : 'semantic_correction' } })) : first;
      active();
      if (!adopted.prediction) throw safeError('intent_output_invalid');
      return route(adopted.prediction, adopted.validation, { stage: adopted === first ? 'classify' : 'verify', callId: adopted.callId });
    } catch (error) {
      const known = AppErrorSchema.safeParse(error);
      throw known.success ? known.data : safeError(error instanceof Error ? error.message : 'internal_error');
    } finally { this.recognizing.delete(input.runId); }
  }
}
