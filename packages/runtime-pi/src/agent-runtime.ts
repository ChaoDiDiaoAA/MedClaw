import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { performance } from "node:perf_hooks";
import { isAbsolute, join } from "node:path";
import { safeError } from "../../contracts/src/error";
import { safePreview, type AgentExecutionObservation, type AgentRuntimePort, type FinalCallFact, type ProviderOutcome } from "../../contracts/src/run";
import type { NativeSessionBindings, NativeSessionPreview } from "../../contracts/src/session";
import { outcomeOf, textOf, type PiModelRuntime, type ResolvedModel } from "./model-runtime";

type ExecutionInput = Parameters<AgentRuntimePort<ResolvedModel>["execute"]>[0];
type Callbacks = Parameters<AgentRuntimePort<ResolvedModel>["execute"]>[1];
type Binding = { manager: SessionManager; session?: AgentSession; available: boolean; execution?: { input: ExecutionInput; callbacks: Callbacks;
  observers: Promise<void>[]; facts: (FinalCallFact | null)[]; lastOutcome: ProviderOutcome | null; unsupported: boolean;
  registrationFailed: boolean; abort: () => void } };
const unavailable = (reason: "host_restart" | "native_state_invalid"): NativeSessionPreview => ({ available: false, reason, leafId: null, messages: [], truncated: false });
const unobservedFailure = (code: string): ProviderOutcome => ({ sdkStopReason: "pending", text: "", responseModel: null, callState: "failed",
  usage: { inputTokens: null, outputTokens: null, cost: null, costCurrency: null, source: null, unavailableReason: "call_not_observed" }, error: safeError(code) });

export class PiAgentRuntime implements AgentRuntimePort<ResolvedModel>, NativeSessionBindings {
  private readonly sessions = new Map<number, Binding>();
  constructor(private readonly runtime: PiModelRuntime, private readonly dataRoot: string) {
    if (!isAbsolute(dataRoot)) throw new Error("invalid_argument");
  }
  describe(resolved: ResolvedModel) { return { requestedThinkingLevel: "off" as const, effectiveThinkingLevel: clampThinkingLevel(resolved.model, "off") }; }
  allocate() {
    const binding: Binding = { manager: SessionManager.inMemory(this.dataRoot), available: true }; let published = false, discarded = false;
    return { nativeSessionId: binding.manager.getSessionId(), bind: (sessionId: number) => {
      if (discarded || published || this.sessions.has(sessionId)) throw new Error("state_conflict");
      this.sessions.set(sessionId, binding); published = true;
    }, discard: () => { if (!published) discarded = true; } };
  }
  read(sessionId: number): NativeSessionPreview {
    const binding = this.sessions.get(sessionId);
    if (!binding) return unavailable("host_restart");
    if (!binding.available) return unavailable("native_state_invalid");
    const messages = binding.manager.getBranch().flatMap(entry => {
      if (entry.type !== "message" || entry.message.role !== "user" && entry.message.role !== "assistant") return [];
      const text = typeof entry.message.content === "string" ? entry.message.content : entry.message.content.filter(part => part.type === "text").map(part => part.text).join("");
      return [{ nativeEntryId: entry.id, role: entry.message.role, ...safePreview(text, 8192), totalChars: text.length }];
    });
    return { available: true, reason: null, leafId: binding.manager.getLeafId(), messages: messages.slice(-32), truncated: messages.length > 32 };
  }

  private async prepare(binding: Binding, resolved: ResolvedModel) {
    if (!binding.session) {
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
        defaultTools: [], packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false, enableInstallTelemetry: false });
      const resourceLoader = new DefaultResourceLoader({ cwd: this.dataRoot, agentDir: join(this.dataRoot, "runtime", "pi"), settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [], additionalSkillPaths: [], additionalPromptTemplatePaths: [], additionalThemePaths: [], extensionFactories: [],
        systemPrompt: "你是 MedClaw 医疗器械数据助手。当前阶段仅进行对话，没有工具和业务数据访问能力。", appendSystemPrompt: [] });
      await resourceLoader.reload(); binding.execution?.input.signal.throwIfAborted();
      const { session } = await createAgentSession({ cwd: this.dataRoot, agentDir: join(this.dataRoot, "runtime", "pi"), modelRuntime: this.runtime.native,
        model: resolved.model, thinkingLevel: "off", noTools: "all", tools: [], customTools: [], resourceLoader, sessionManager: binding.manager, settingsManager });
      binding.session = session;
      const original = session.agent.streamFunction;
      session.agent.streamFunction = async (model, context, options) => {
        const execution = binding.execution;
        if (!execution) throw new Error("state_conflict");
        const { input, callbacks } = execution;
        input.signal.throwIfAborted(); options?.signal?.throwIfAborted();
        if (execution.unsupported) throw new Error("agent_response_unsupported");
        if (performance.now() >= input.deadlineAt) throw new Error("run_timeout");
        let recorder;
        try { recorder = callbacks.startCall(new Date().toISOString()); }
        catch (error) { execution.registrationFailed = true; throw error; }
        const index = execution.facts.push(null) - 1;
        let stream;
        try {
          stream = await original(model, context, { ...options, maxTokens: input.resolved.selection.maxOutputTokens,
            maxRetries: input.resolved.policy.maxRetries, maxRetryDelayMs: input.resolved.policy.maxRetryDelayMs,
            timeoutMs: Math.max(1, Math.ceil(input.deadlineAt - performance.now())) });
        } catch {
          const outcome = unobservedFailure("provider_request_failed"); execution.lastOutcome = outcome;
          execution.facts[index] = recorder.finish(outcome, new Date().toISOString());
          throw new Error("provider_request_failed");
        }
        // Observe result() without consuming a second iterator; Pi owns the stream.
        const observed = stream.result().then(message => {
          const outcome = outcomeOf(message, input.resolved.pricingKnown);
          execution.lastOutcome = outcome;
          execution.facts[index] = recorder.finish(outcome, new Date().toISOString());
          if (message.stopReason === "toolUse" || message.stopReason === "deferred" || message.content.some(part => part.type === "toolCall")) {
            execution.unsupported = true; binding.available = false; execution.abort();
          }
        });
        execution.observers.push(observed);
        return stream;
      };
    }
    binding.execution?.input.signal.throwIfAborted();
    await binding.session.setModel(resolved.model, { persist: false });
    binding.execution?.input.signal.throwIfAborted();
    binding.session.setThinkingLevel("off", { persist: false });
  }

  async execute(input: ExecutionInput, callbacks: Callbacks): Promise<AgentExecutionObservation> {
    const binding = this.sessions.get(input.sessionId);
    if (!binding || !binding.available) throw new Error("session_history_invalid");
    if (binding.execution) throw new Error("state_conflict");
    let abortTask: Promise<void> | null = null, unsubscribe: (() => void) | undefined, terminalEmitted = false, prepared = false;
    const abort = () => { if (binding.session && !abortTask) abortTask = binding.session.abort(); };
    const execution: NonNullable<Binding["execution"]> = { input, callbacks, observers: [], facts: [], lastOutcome: null, unsupported: false, registrationFailed: false, abort };
    binding.execution = execution; input.signal.addEventListener("abort", abort, { once: true });
    const terminal = () => {
      if (execution.registrationFailed) execution.lastOutcome = unobservedFailure("storage_write_failed");
      if (execution.unsupported && execution.lastOutcome) execution.lastOutcome = { ...execution.lastOutcome, error: safeError("agent_response_unsupported") };
      if (!terminalEmitted && execution.lastOutcome) { terminalEmitted = true; callbacks.nativeTerminal(execution.lastOutcome); }
    };
    try {
      input.signal.throwIfAborted();
      await this.prepare(binding, input.resolved); prepared = true; input.signal.throwIfAborted();
      if (performance.now() >= input.deadlineAt) throw new Error("run_timeout");
      const session = binding.session!;
      unsubscribe = session.subscribe(event => {
        if (event.type === "message_update" && event.message.role === "assistant") {
          try { callbacks.preview(textOf(event.message)); } catch { /* Optional preview does not change the execution. */ }
        }
        if (event.type === "agent_settled") terminal();
      });
      await session.prompt(input.text, { expandPromptTemplates: false });
    } catch {
      if (!prepared && !input.signal.aborted) binding.available = false;
      if (!input.signal.aborted && !execution.lastOutcome) {
        execution.lastOutcome = unobservedFailure(execution.registrationFailed ? "storage_write_failed" : performance.now() >= input.deadlineAt ? "run_timeout" : "provider_request_failed");
      }
      abort();
    } finally {
      try {
        await binding.session?.waitForIdle(); await abortTask; await Promise.all(execution.observers);
        if (binding.session && !binding.session.isIdle) throw new Error("stop_unconfirmed");
        terminal();
      } finally { unsubscribe?.(); input.signal.removeEventListener("abort", abort); binding.execution = undefined; }
    }
    return { nativeIdle: true, lastOutcome: execution.lastOutcome, calls: execution.facts.flatMap(fact => fact ? [fact] : []) };
  }
}
