import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { performance } from "node:perf_hooks";
import { isAbsolute, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createHash, randomUUID } from 'node:crypto';
import { release } from 'node:os';
import type { ToolConfiguration } from '../../contracts/src/tool-config';
import type { RunScope } from '../../contracts/src/run';
import { SDK_VERSION, type MeasurementContext } from '../../contracts/src/model';
import { RunControl } from '../../core/src/runtime/run-control';
import { buildToolProfiles, TOOL_PROFILE_RULES } from '../../core/src/tools/tool-profile';
import { safeError } from "../../contracts/src/error";
import { type AgentExecutionObservation, type AgentRuntimePort, type FinalCallFact, type ProviderOutcome } from "../../contracts/src/run";
import type { NativeSessionBindings, NativeSessionPreview, InputAdapterPort, InputSettlementProof } from "../../contracts/src/session";
import { PiInputAdapter } from './input-adapter';
import { outcomeOf, type PiModelRuntime, type ResolvedModel } from "./model-runtime";
import { createPiNativeTools, createPiToolDefinitions, observePiToolDelivery, createPiRunControlBinding } from "./pi-tool-adapter";
import type { ToolRegistry } from "../../core/src/tools/registry";
import type { ToolExecutor } from "../../core/src/tools/executor";
import type { ToolRecorder } from "../../core/src/tools/recorder";
import type { ToolExecutionContext, ToolSdkDelivery } from "../../contracts/src/tool";
import type { ReadSessionMessagesInput, SessionMessagePage } from "@medclaw/contracts/messages";
import { matchProviderToolReceipts, sameToolReceipt, projectMessageText, projectSessionMessages } from "./messages";
import { EventAdapter } from './event-adapter';

type ExecutionInput = Parameters<AgentRuntimePort<ResolvedModel>["execute"]>[0];
type Callbacks = Parameters<AgentRuntimePort<ResolvedModel>["execute"]>[1];
type RunTools = { registry: ToolRegistry; executor: ToolExecutor };
type Binding = { manager: SessionManager; nativeSessionId: string; entryRuns: Map<string, number>; session?: AgentSession; toolSignature?: string; lastRunId?: number; bindTools?: () => () => void; available: boolean; execution?: { input: ExecutionInput; callbacks: Callbacks; toolCalls: Set<string>;
  observers: Promise<void>[]; facts: (FinalCallFact | null)[]; lastOutcome: ProviderOutcome | null; unsupported: boolean;
  registrationFailed: boolean; currentModelCallId: string | null; abort: () => void; control: RunControl; tools?: RunTools } };
const unavailable = (reason: "host_restart" | "native_state_invalid"): NativeSessionPreview => ({ available: false, reason, leafId: null, messages: [], truncated: false });
const unobservedFailure = (code: string): ProviderOutcome => ({ sdkStopReason: "pending", text: "", responseModel: null, callState: "failed",
  usage: { inputTokens: null, outputTokens: null, cost: null, costCurrency: null, source: null, unavailableReason: "call_not_observed" }, error: safeError(code) });

export class PiAgentRuntime implements AgentRuntimePort<ResolvedModel>, NativeSessionBindings {
  private readonly eventAdapter = new EventAdapter();
  readSnapshots(runId: number) { return this.eventAdapter.readSnapshots(runId); }
  private readonly sessions = new Map<number, Binding>();
  private readonly controls = new Map<number, RunControl>();
  private readonly inputs = new Map<number, PiInputAdapter>();
  private readonly inputStartFailures = new Map<number, { save: () => void; pending: boolean; proof: InputSettlementProof }>();
  readonly inputAdapter: InputAdapterPort = {
    deliver: input => { const adapter = this.inputs.get(input.targetRunId); if (!adapter) return Promise.reject(safeError('input_invalid')); return adapter.deliver(input); },
    cancel: inputId => { const adapter = [...this.inputs.values()].find(adapter => adapter.hasInput(inputId)); return adapter ? adapter.cancel(inputId) : Promise.resolve({ kind: 'unknown', inputId, error: safeError('input_delivery_unknown') }); },
    close: (runId, outcome) => { const adapter = this.inputs.get(runId); if (!adapter) { const failed = this.inputStartFailures.get(runId); return failed ? Promise.resolve({ ...failed.proof, pendingPersistence: failed.pending }) : Promise.reject(safeError('input_invalid')); } return adapter.close(runId, outcome); },
    persistencePending: runId => this.inputPersistencePending(runId), retryPersistence: runId => this.retryInputPersistence(runId),
  };
  readInputControl(runId: number) { return this.inputs.get(runId)?.readControl() ?? null; }
  inputPersistencePending(runId: number) { return (this.inputs.get(runId)?.persistencePending(runId) ?? false) || (this.inputStartFailures.get(runId)?.pending ?? false); }
  retryInputPersistence(runId: number) { this.inputs.get(runId)?.retryPersistence(runId); const failed = this.inputStartFailures.get(runId); if (failed?.pending) { try { failed.save(); failed.pending = false; } catch { /* Retain exact failure fact for the next save attempt. */ } } }
  releaseInputFacts(runId: number) { const adapter = this.inputs.get(runId); if (this.inputPersistencePending(runId)) throw safeError('storage_write_failed'); adapter?.dispose(); this.inputs.delete(runId); this.inputStartFailures.delete(runId); }
  readonly toolNames?: readonly string[];
  constructor(private readonly runtime: PiModelRuntime, private readonly dataRoot: string,
    private readonly tools?: RunTools & { recorder: ToolRecorder; configure?: (configuration: ToolConfiguration) => RunTools }) {
    if (!isAbsolute(dataRoot)) throw new Error("invalid_argument");
    if (tools) this.toolNames = Object.freeze([...tools.registry.definitions.map(tool => tool.name), "read", "grep", "find", "ls", "edit", "write", "bash", "powershell"]);
  }
  describe(resolved: ResolvedModel) { return { requestedThinkingLevel: "off" as const, effectiveThinkingLevel: clampThinkingLevel(resolved.model, "off") }; }
  toolPersistencePending(runId: number) { return this.tools?.recorder.persistencePending(runId) ?? false; }
  retryToolPersistence(runId: number) { this.tools?.recorder.retryPersistence(runId); }
  releaseToolFacts(runId: number) { this.tools?.recorder.release(runId); this.controls.get(runId)?.dispose(); this.controls.delete(runId); }
  readBudget(runId: number) { return this.controls.get(runId)?.readBudget() ?? null; }
  captureToolProfiles(_scope?: RunScope) {
    const cutoffAt = new Date().toISOString();
    let records = null;
    try { records = this.tools?.recorder.readToolObservations({ cutoffAt, limit: TOOL_PROFILE_RULES.observationLimit, windowDays: TOOL_PROFILE_RULES.windowDays }) ?? null; } catch { /* Profile failure falls back to frozen configuration. */ }
    const measurementContext: MeasurementContext = { version: 'medclaw.tool-measurement/v1', sdkVersion: SDK_VERSION,
      environmentKey: createHash('sha256').update(JSON.stringify([process.platform, process.arch, release(), process.versions.node, process.versions.bun ?? null])).digest('hex'),
      cutoffAt, maxToolCallId: records?.maxToolCallId ?? null };
    return { measurementContext, toolProfileSnapshot: buildToolProfiles(records, measurementContext) };
  }
  allocate() {
    const manager = SessionManager.inMemory(this.dataRoot);
    const binding: Binding = { manager, nativeSessionId: manager.getSessionId(), entryRuns: new Map(), available: true }; let published = false, discarded = false;
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
      const preview = projectMessageText(entry.message);
      return [{ nativeEntryId: entry.id, role: entry.message.role, text: preview.text ?? "", truncated: preview.truncated, totalChars: preview.totalChars ?? 0 }];
    });
    return { available: true, reason: null, leafId: binding.manager.getLeafId(), messages: messages.slice(-32), truncated: messages.length > 32 };
  }
  readMessages(input: ReadSessionMessagesInput): SessionMessagePage {
    const binding = this.sessions.get(input.sessionId);
    if (!binding) throw safeError("resource_unavailable");
    if (!binding.available || binding.manager.getSessionId() !== binding.nativeSessionId) throw safeError("session_history_invalid");
    return projectSessionMessages(binding.manager, input, binding.entryRuns);
  }

  private async prepare(binding: Binding, resolved: ResolvedModel) {
    const workdir = () => {
      if (!binding.execution) throw new Error("state_conflict");
      return join(this.dataRoot, "runtime", String(binding.execution.input.runId), "work", "scratch");
    };
    const getContext = (nativeToolCallId: string, sdkSignal?: AbortSignal): ToolExecutionContext => {
      const input = binding.execution?.input;
      if (!input?.scope || !input.referenceDate || !input.timezone) throw new Error("state_conflict");
      return { runId: input.runId, sessionId: input.sessionId, nativeToolCallId, scope: input.scope,
        referenceDate: input.referenceDate, timezone: input.timezone, signal: sdkSignal ? AbortSignal.any([input.signal, sdkSignal]) : input.signal,
        checkActive: binding.execution!.control.checkActive, toolConfiguration: binding.execution!.control.configuration };
    };
    const getControl = () => binding.execution?.control;
    const native = this.tools ? createPiNativeTools(workdir, this.tools.recorder, getContext, {}, getControl) : null;
    const registry = { get: (name: string) => binding.execution!.tools!.registry.get(name) };
    const executor = { execute: (...args: Parameters<ToolExecutor['execute']>) => binding.execution!.tools!.executor.execute(...args) };
    const definitions = this.tools ? [...createPiToolDefinitions(binding.execution!.tools!.registry, executor, getContext, getControl), ...native!.definitions] : [];
    const signature = JSON.stringify({ tools: definitions.map(({ name, description, parameters, executionMode }) => ({ name, description, parameters, executionMode })) });
    if (!binding.session || binding.toolSignature !== signature) {
      if (binding.session && (!binding.session.isIdle || binding.lastRunId !== undefined && this.tools?.recorder.persistencePending(binding.lastRunId))) throw new Error('state_conflict');
      let candidate: AgentSession | undefined;
      try {
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
          defaultTools: [], packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false, enableInstallTelemetry: false });
        const resourceLoader = new DefaultResourceLoader({ cwd: this.dataRoot, agentDir: join(this.dataRoot, "runtime", "pi"), settingsManager,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          additionalExtensionPaths: [], additionalSkillPaths: [], additionalPromptTemplatePaths: [], additionalThemePaths: [], extensionFactories: [],
          systemPrompt: this.tools ? `You are MedClaw, a medical device data assistant. Read the frozen data scope before querying in each run. Use business tools for data calculations and retain query and evidence identities in your answer. Native tools use the current run's work directory. Never invent missing data or import results.
Explicit user dates take precedence over the default frozen referenceDate. Resolve "today", "now", and "current" against the frozen referenceDate and timezone, and explicitly state that anchor. Never silently substitute the system clock. If the user expressly means actual calendar today, distinguish that request from the frozen default; disclose uncertainty if trusted context does not establish its date.
Use the returned interpretation to report requestedDate and requestedTime, actual dataDates, referenceDate and timezone, snapshotMode, basis, status, quantity and unit, and isStale. State unknown values as unknown. If data is stale for the requested date, report the latest known data dates and quantities and say the target-date quantity is unknown. Never describe stale observations as the actual quantity on that target date.
State whether the basis counts snapshot records, device identifiers deduplicated by data scope, or change events. These counts are not physical units or inventory. Without a reliable stock quantity field, stock quantity is unknown; a pricing unit does not provide stock quantity. When status is omitted, include all statuses and say so; do not silently restrict results to active devices.
as_of (latest snapshot) selects the latest allowed batch per data scope before the exclusive cutoff; it is not cumulative history. Never sum counts across dates or batches and call them distinct devices. Compare device sets or claim changes only when evidence supports them: equal counts do not prove the same scoped set of identifiers.`
            : "你是 MedClaw 医疗器械数据助手。当前阶段仅进行对话，没有工具和业务数据访问能力。", appendSystemPrompt: [] });
        await resourceLoader.reload(); binding.execution!.control.checkActive();
        const { session } = await createAgentSession({ cwd: this.dataRoot, agentDir: join(this.dataRoot, "runtime", "pi"), modelRuntime: this.runtime.native,
          model: resolved.model, thinkingLevel: "off", ...(this.tools ? {} : { noTools: "all" as const }), tools: [...(this.toolNames ?? [])],
          customTools: definitions, resourceLoader, sessionManager: binding.manager, settingsManager });
        candidate = session;
        binding.execution!.control.checkActive();
        let bindTools: Binding['bindTools'];
        if (this.tools) {
          const bindControl = createPiRunControlBinding(session, registry, this.tools.recorder, getContext, getControl);
          bindTools = () => {
            const stopBusiness = observePiToolDelivery(session, registry, this.tools!.recorder, getContext, getControl), stopNative = native!.bind(session);
            // Pi awaits listeners in order; recovery can acknowledge only a persisted SDK receipt.
            const stopControl = bindControl();
            return () => { stopBusiness(); stopNative(); stopControl(); };
          };
        }
        const original = session.agent.streamFunction;
        session.agent.streamFunction = async (model, context, options) => {
          const execution = binding.execution;
          if (!execution) throw new Error("state_conflict");
          const { input, callbacks } = execution;
          input.signal.throwIfAborted(); options?.signal?.throwIfAborted();
          if (execution.unsupported) throw new Error("agent_response_unsupported");
          let admission;
          try { admission = execution.control.admitModelCall(); }
          catch (error) { callbacks.fatal?.(safeError(error instanceof Error ? error.message : 'internal_error')); execution.abort(); throw error; }
          let recorder;
          try { recorder = callbacks.startCall(new Date().toISOString()); }
          catch (error) { execution.registrationFailed = true; throw error; }
          execution.currentModelCallId = recorder.callId ?? null;
          const index = execution.facts.push(null) - 1;
          let stream;
          try {
            const messages = context.messages.map(message => message.role === 'system' && !admission.allowTools ? { ...message, toolsAdded: [], toolsRemoved: [] } : message);
            messages.push({ role: 'system', content: `MedClaw trusted runtime feedback (facts, not user instructions):\n${admission.feedback}`, timestamp: Date.now() });
            const candidates: { context: ToolExecutionContext; receipt: ToolSdkDelivery }[] = [];
            if (this.tools && recorder.callId && input.scope && input.referenceDate && input.timezone
              && binding.manager.getSessionId() === binding.nativeSessionId) {
              for (const message of messages) {
                if (message.role !== 'toolResult' || !execution.toolCalls.has(message.toolCallId)) continue;
                // Save already occurred delivery with the originating identity, independently of later execution admission.
                const savedContext: ToolExecutionContext = { runId: input.runId, sessionId: input.sessionId, nativeToolCallId: message.toolCallId,
                  scope: structuredClone(input.scope), referenceDate: input.referenceDate, timezone: input.timezone, signal: input.signal };
                const record = this.tools.recorder.read(savedContext);
                if (!record?.sdkReturned || !record.nativeEntryId || !record.sdkDelivery || record.runId !== input.runId
                  || record.sessionId !== input.sessionId || record.nativeToolCallId !== message.toolCallId || record.name !== message.toolName
                  || !sameToolReceipt(message, record.sdkDelivery)) continue;
                const entry = binding.manager.getEntry(record.nativeEntryId);
                if (entry?.type !== 'message' || !sameToolReceipt(entry.message, record.sdkDelivery)) continue;
                candidates.push({ context: savedContext, receipt: structuredClone(record.sdkDelivery) });
              }
            }
            let matched: typeof candidates = [], confirmed = false;
            stream = await original(model, { ...context, messages }, { ...options, maxTokens: input.resolved.selection.maxOutputTokens,
              maxRetries: input.resolved.policy.maxRetries, maxRetryDelayMs: input.resolved.policy.maxRetryDelayMs,
              timeoutMs: Math.max(1, Math.ceil(input.deadlineAt - performance.now())),
              onPayload: async (payload, callbackModel) => {
                matched = [];
                const replacement = await options?.onPayload?.(payload, callbackModel);
                const receipts = matchProviderToolReceipts(model.api, replacement === undefined ? payload : replacement, candidates.map(candidate => candidate.receipt));
                matched = candidates.filter(candidate => receipts.includes(candidate.receipt));
                return replacement;
              },
              onResponse: async (response, callbackModel) => {
                await options?.onResponse?.(response, callbackModel);
                if (confirmed || response.status < 200 || response.status >= 300) return;
                confirmed = true;
                let saveFailed = false, firstSaveError: unknown;
                for (const candidate of matched) {
                  try {
                    this.tools!.recorder.recordConsumption(candidate.context, recorder.callId!, 'provider_input_verified');
                  } catch (error) {
                    if (!saveFailed) { saveFailed = true; firstSaveError = error; }
                  }
                }
                // Preserve every exact fact from this response before the first failure stops SDK continuation.
                if (saveFailed) { callbacks.fatal?.(safeError('storage_write_failed')); execution.abort(); throw firstSaveError; }
              } });
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
            for (const part of message.content) if (part.type === "toolCall") execution.toolCalls.add(part.id);
            if (message.stopReason === "deferred" || !this.tools && (message.stopReason === "toolUse" || message.content.some(part => part.type === "toolCall"))) {
              execution.unsupported = true; binding.available = false; execution.abort();
            }
          });
          execution.observers.push(observed);
          return stream;
        };
        await session.setModel(resolved.model, { persist: false });
        binding.execution!.control.checkActive();
        session.setThinkingLevel("off", { persist: false });
        binding.session?.dispose();
        binding.session = session;
        binding.bindTools = bindTools;
        binding.toolSignature = signature;
        candidate = undefined;
      } catch (error) { candidate?.dispose(); throw error; }
    } else {
      binding.execution!.control.checkActive();
      await binding.session.setModel(resolved.model, { persist: false });
      binding.execution!.control.checkActive();
      binding.session.setThinkingLevel("off", { persist: false });
    }
  }

  async execute(input: ExecutionInput, callbacks: Callbacks): Promise<AgentExecutionObservation> {
    const binding = this.sessions.get(input.sessionId);
    if (!binding || !binding.available) throw new Error("session_history_invalid");
    if (binding.execution) throw new Error("state_conflict");
    let abortTask: Promise<void> | null = null, unsubscribe: (() => void) | undefined, unsubscribeTools: (() => void) | undefined, unsubscribeMessages: (() => void) | undefined, terminalEmitted = false;
    const abort = () => { this.inputs.get(input.runId)?.stop(); if (binding.session && !abortTask) abortTask = binding.session.abort(); };
    const control = new RunControl({ runId: input.runId, toolConfiguration: input.toolConfiguration, runtimeConfiguration: input.runtimeConfiguration, policy: input.agentPolicy,
      scope: input.scope ?? { batchIds: [], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true },
      signal: input.signal, deadlineAt: input.deadlineAt, totalTimeoutMs: input.resolved.policy.timeoutMs,
      measurementContext: input.measurementContext, toolProfileSnapshot: input.toolProfileSnapshot });
    this.controls.set(input.runId, control);
    const execution: NonNullable<Binding["execution"]> = { input, callbacks, observers: [], facts: [], toolCalls: new Set(), lastOutcome: null, unsupported: false, registrationFailed: false, currentModelCallId: null, abort, control, tools: this.tools?.configure?.(control.configuration) ?? this.tools };
    binding.execution = execution; input.signal.addEventListener("abort", abort, { once: true });
    const terminal = () => {
      if (execution.registrationFailed) execution.lastOutcome = unobservedFailure("storage_write_failed");
      if (execution.unsupported && execution.lastOutcome) execution.lastOutcome = { ...execution.lastOutcome, error: safeError("agent_response_unsupported") };
      if (!terminalEmitted && execution.lastOutcome) { terminalEmitted = true; callbacks.nativeTerminal(execution.lastOutcome); }
    };
    let inputSettlement: InputSettlementProof | undefined;
    try {
      input.signal.throwIfAborted();
      if (this.tools) await Promise.all([mkdir(join(this.dataRoot, "runtime", String(input.runId), "work", "materials"), { recursive: true }),
        mkdir(join(this.dataRoot, "runtime", String(input.runId), "work", "scratch"), { recursive: true })]);
      await this.prepare(binding, input.resolved); input.signal.throwIfAborted();
      if (performance.now() >= input.deadlineAt) throw new Error("run_timeout");
      const session = binding.session!;
      const originalRunId = input.runId, manager = binding.manager;
      unsubscribeMessages = session.agent.subscribe(event => {
        if (event.type !== "message_end" || event.message.role !== "user" && event.message.role !== "assistant") return;
        // Pi's earlier awaited AgentSession listener has appended this exact event object.
        const entry = manager.getEntries().findLast(entry => entry.type === "message" && entry.message === event.message);
        if (entry) binding.entryRuns.set(entry.id, originalRunId);
      });
      if (input.inputId != null) {
        const store = callbacks.inputStore;
        if (!store) throw safeError('state_conflict');
        const adapter = new PiInputAdapter(session, manager, { runId: input.runId, sessionId: input.sessionId,
          delivered: (binding, at) => store.recordInputDelivery(binding.inputId, at),
          consumed: (binding, fact) => { store.recordInputConsumption(binding.inputId, fact); },
          failed: (binding, fact) => store.recordInputFailure(binding.inputId, fact),
          cancelled: (proof, at) => { store.recordInputCancellation(proof, at); },
          nativeStateInvalid: () => { binding.available = false; },
          fatal: error => { callbacks.fatal?.(error); abort(); }, admissionClosed: () => callbacks.admissionClosed?.() });
        this.inputs.set(input.runId, adapter);
      }
      unsubscribeTools = binding.bindTools?.();
      unsubscribe = this.eventAdapter.attach({ session, manager, runId: originalRunId, sessionId: input.sessionId, streamConnection: randomUUID(),
        readCurrentModelCallId: () => execution.currentModelCallId,
        readToolIdentity: nativeToolCallId => {
          if (!this.tools || !input.scope || !input.referenceDate || !input.timezone) return null;
          const record = this.tools.recorder.read({ runId: originalRunId, sessionId: input.sessionId, nativeToolCallId,
            scope: input.scope, referenceDate: input.referenceDate, timezone: input.timezone, signal: input.signal });
          return record?.runId === originalRunId && record.sessionId === input.sessionId && record.nativeToolCallId === nativeToolCallId ? { toolCallId: record.id } : null;
        }, emit: snapshot => callbacks.stream?.(snapshot),
      });
      if (input.inputId != null) {
        await this.inputs.get(input.runId)!.deliver({ inputId: input.inputId, sessionId: input.sessionId, targetRunId: input.runId, mode: 'send', text: input.text, stopEpoch: 0 });
        inputSettlement = await this.inputs.get(input.runId)!.waitForCompletion(input.signal.aborted ? 'cancelled' : 'completed');
      } else await session.prompt(input.text, { expandPromptTemplates: false });
    } catch {
      if (!input.signal.aborted && !execution.lastOutcome) {
        execution.lastOutcome = unobservedFailure(execution.registrationFailed ? "storage_write_failed" : performance.now() >= input.deadlineAt ? "run_timeout" : "provider_request_failed");
      }
      abort();
    } finally {
      try {
        await binding.session?.waitForIdle(); await abortTask; await Promise.all(execution.observers);
        if (binding.session && !binding.session.isIdle) throw new Error("stop_unconfirmed");
        if (this.inputs.has(input.runId)) inputSettlement = await this.inputs.get(input.runId)!.close(input.runId, input.signal.aborted ? 'cancelled' : execution.lastOutcome?.error ? 'failed' : 'completed');
        else if (input.inputId != null) {
          // Preparation never invoked the SDK prompt; this root has no native input source.
          callbacks.admissionClosed?.();
          const at = new Date().toISOString(), inputId = input.inputId;
          const fact = { sessionId: input.sessionId, targetRunId: input.runId, at, error: safeError('provider_request_failed'), proof: { kind: 'not_consumed' as const, reason: 'start_failed' as const } };
          const proof: InputSettlementProof = { runId: input.runId, admissionClosed: true, preflightSettled: true, nativeIdle: true, nativeQueuesEmpty: !binding.session?.agent.hasQueuedMessages(), pendingPersistence: false, removals: [], unconfirmedInputIds: [] };
          const failed = { save: () => { if (!callbacks.inputStore) throw safeError('state_conflict'); callbacks.inputStore.recordInputFailure(inputId, fact); }, pending: false, proof };
          try { failed.save(); } catch { failed.pending = true; callbacks.fatal?.(safeError('storage_write_failed')); }
          this.inputStartFailures.set(input.runId, failed); inputSettlement = { ...proof, pendingPersistence: failed.pending };
        }
        terminal();
      } finally { unsubscribe?.(); unsubscribeTools?.(); unsubscribeMessages?.(); input.signal.removeEventListener("abort", abort); binding.lastRunId = input.runId; binding.execution = undefined; }
    }
    return { nativeIdle: true, lastOutcome: execution.lastOutcome, calls: execution.facts.flatMap(fact => fact ? [fact] : []), budgetSummary: control.summary(), ...(inputSettlement ? { inputSettlement } : {}) };
  }
}
