import { performance } from "node:perf_hooks";
import type { ProviderRunStore, FinalCallFact, ModelCallRecorderPort, ProviderOutcome } from "../../contracts/src/run.ts";
import type { StartCallContext } from '../../contracts/src/context';
import type { CompactionCallOwner, SessionStore } from '../../contracts/src/session';

/** One logical SDK request, not an invented list of HTTP retries. */
export class ModelCallRecorder implements ModelCallRecorderPort {
  readonly callId = crypto.randomUUID();
  private readonly started = performance.now();
  private capture?: (callId:string,payload:unknown,at:string)=>void;
  constructor(repositories: Pick<ProviderRunStore, "startCall">, runId: number, kind: "main" | "diagnostic", time: string, context?: StartCallContext);
  constructor(repositories: Pick<SessionStore, 'startCompactionCall'>, owner: CompactionCallOwner, time: string);
  constructor(...args: [Pick<ProviderRunStore, 'startCall'>, number, 'main' | 'diagnostic', string, StartCallContext?] | [Pick<SessionStore, 'startCompactionCall'>, CompactionCallOwner, string]) {
    const store=args[0] as typeof args[0] & {recordProviderRequest?:(callId:string,payload:unknown,at:string)=>void};
    if(store.recordProviderRequest)this.capture=store.recordProviderRequest.bind(store);
    if (typeof args[1] === 'number') {
      const [repositories, runId, kind, time, context] = args as [Pick<ProviderRunStore, 'startCall'>, number, 'main' | 'diagnostic', string, StartCallContext?];
      repositories.startCall(runId, this.callId, kind, time, context);
    } else {
      const [repositories, owner, time] = args as [Pick<SessionStore, 'startCompactionCall'>, CompactionCallOwner, string];
      repositories.startCompactionCall({ owner, callId: this.callId, startedAt: time });
    }
  }
  recordPayload(payload:unknown,observedAt:string):void {this.capture?.(this.callId,payload,observedAt);}
  static forCompaction(repositories: Pick<SessionStore, 'startCompactionCall'>, owner: CompactionCallOwner, time: string): ModelCallRecorder {
    return new ModelCallRecorder(repositories, owner, time);
  }
  finish(outcome: ProviderOutcome, endedAt: string): FinalCallFact {
    return { callId: this.callId, state: outcome.callState, responseModel: outcome.responseModel, sdkStopReason: outcome.sdkStopReason === "pending" ? null : outcome.sdkStopReason, endedAt, durationMs: Math.max(0, Math.round(performance.now() - this.started)), inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, cost: outcome.usage.cost, costCurrency: outcome.usage.costCurrency === "USD" ? "USD" : null, usageSource: outcome.usage.source, unavailableReason: outcome.usage.unavailableReason, error: outcome.error };
  }
}
