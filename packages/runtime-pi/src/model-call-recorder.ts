import { performance } from "node:perf_hooks";
import type { ProviderRunStore, FinalCallFact, ModelCallRecorderPort, ProviderOutcome } from "../../contracts/src/run.ts";

/** One logical SDK request, not an invented list of HTTP retries. */
export class ModelCallRecorder implements ModelCallRecorderPort {
  readonly callId = crypto.randomUUID();
  private readonly started = performance.now();
  constructor(repositories: Pick<ProviderRunStore, "startCall">, runId: number, kind: "main" | "diagnostic", time: string) {
    repositories.startCall(runId, this.callId, kind, time);
  }
  finish(outcome: ProviderOutcome, endedAt: string): FinalCallFact {
    return { callId: this.callId, state: outcome.callState, responseModel: outcome.responseModel, sdkStopReason: outcome.sdkStopReason === "pending" ? null : outcome.sdkStopReason, endedAt, durationMs: Math.max(0, Math.round(performance.now() - this.started)), inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, cost: outcome.usage.cost, costCurrency: outcome.usage.costCurrency === "USD" ? "USD" : null, usageSource: outcome.usage.source, unavailableReason: outcome.usage.unavailableReason, error: outcome.error };
  }
}
