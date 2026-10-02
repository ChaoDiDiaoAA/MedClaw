import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { validateToolArguments, type ToolResultMessage } from "@earendil-works/pi-ai";
import { createReadToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, createEditToolDefinition,
  createWriteToolDefinition, createBashToolDefinition, createPowerShellToolDefinition, defineTool, VERSION,
  type AgentSession, type AgentToolResult, type ToolDefinition as PiToolDefinition, type ToolsOptions } from "@earendil-works/pi-coding-agent";
import { AppErrorSchema, safeError } from "../../contracts/src/error";
import { ToolSdkDeliverySchema, type AnyToolDefinition, type ToolCallIdentity, type ToolCallRecord, type ToolExecutionContext, type ToolResult } from "../../contracts/src/tool";
import type { ToolRegistry } from "../../core/src/tools/registry";
import type { ToolExecutor } from "../../core/src/tools/executor";
import type { ToolRecorder } from "../../core/src/tools/recorder";
import type { RunControl } from '../../core/src/runtime/run-control';
import type { ToolControlObservation } from '../../contracts/src/model';

export type ToolContextFactory = (nativeToolCallId: string, signal?: AbortSignal) => ToolExecutionContext;

const FailedReturnSchema = z.strictObject({ status: z.enum(["failed", "cancelled"]), error: AppErrorSchema, data: z.unknown().optional() });
function inputIssues(schema: z.ZodType, input: unknown): ToolControlObservation['validationIssues'] {
  const parsed = schema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.flatMap(issue => (issue.code === 'unrecognized_keys' ? issue.keys.map(key => [...issue.path, key]) : [issue.path])
    .map(path => ({ code: 'tool_input_invalid', stage: 'input', fieldPath: path.length <= 32 && path.every(part => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(String(part))) ? path.map(String) : [] }))).slice(0, 100);
}
function sanitizeSdkRefusal(control: RunControl | undefined, id: string, result: AgentToolResult<unknown>, schema: z.ZodType | undefined, input: unknown): void {
  if (!control || control.observation(id).failureClass !== null) return;
  const issues = schema ? inputIssues(schema, input) : [];
  const code = schema ? 'tool_input_invalid' : 'tool_not_found';
  control.updateObservation(id, { inputValidation: schema ? 'failed' : 'not_reached', validationIssues: issues });
  control.noteFailure(id, { code, stage: 'sdk' });
  // Pi awaits this observer before creating its history message from the same result object.
  result.content = [{ type: 'text', text: JSON.stringify({ status: 'failed', error: safeError(code), validationIssues: issues }) }];
  result.details = {};
}
function normalizedInput(tool: AnyToolDefinition, input: unknown): unknown {
  const args = z.record(z.string(), z.json()).safeParse(input);
  if (!args.success) return input;
  try {
    const sdkInput: unknown = validateToolArguments({ name: tool.name, description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema, { target: "draft-7", io: "input" }) },
    { type: "toolCall", id: "delivery-validation", name: tool.name, arguments: args.data });
    const parsed = tool.inputSchema.safeParse(sdkInput);
    return parsed.success ? parsed.data : sdkInput;
  } catch { return input; }
}
function matchesRecordedResult(record: ToolCallRecord, message: ToolResultMessage): boolean {
  if (record.name !== message.toolName || message.content.length !== 1 || message.content[0]?.type !== "text") return false;
  let payload: unknown;
  try { payload = JSON.parse(message.content[0].text); } catch { return false; }
  if (record.status === "succeeded") return !message.isError && isDeepStrictEqual(record.data, payload);
  const failed = FailedReturnSchema.safeParse(payload);
  return message.isError && failed.success && failed.data.status === record.status && failed.data.error.code === record.error?.code
    && isDeepStrictEqual(failed.data.data ?? null, record.data);
}

export function createPiToolDefinitions(
  registry: Pick<ToolRegistry, "definitions">,
  executor: Pick<ToolExecutor, "execute">,
  getContext: ToolContextFactory,
  getControl?: () => RunControl | undefined,
): PiToolDefinition[] {
  return registry.definitions.map(tool => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: z.toJSONSchema(tool.inputSchema, { target: "draft-7", io: "input" }),
    executionMode: tool.executionMode,
    async execute(nativeToolCallId, input, signal) {
      const result = await executor.execute(tool.name, input, getContext(nativeToolCallId, signal), getControl?.());
      if (result.status !== "succeeded") throw new Error(JSON.stringify(result));
      return { content: [{ type: "text", text: JSON.stringify(result.data) }], details: result.data };
    },
  }));
}

/** Bind this factory to the original Run/Session, never the current Workspace selection. */
export function observePiToolDelivery(
  session: AgentSession,
  registry: Pick<ToolRegistry, "get">,
  recorder: Pick<ToolRecorder, "blocked" | "request" | "read" | "finish" | "recordDelivery" | "failPersistence">,
  getContext: ToolContextFactory,
  getControl?: () => RunControl | undefined,
): () => void {
  const attempts = new Map<string, unknown>();
  const sdkRejections = new Map<string, { recordId: number; content: ToolResultMessage["content"]; details: unknown }>();
  const finalized = new Map<string, { content: unknown; details: unknown; isError: boolean }>();
  // Agent subscriptions are awaited; AgentSession subscriptions are preview notifications only.
  const unsubscribe = session.agent.subscribe(async (event, signal) => {
    if (event.type === "agent_end") { attempts.clear(); sdkRejections.clear(); finalized.clear(); }
    if (event.type === "tool_execution_start" && registry.get(event.toolName)) {
      // Keep raw arguments for SDK rejection only; Executor records successfully parsed arguments.
      attempts.set(event.toolCallId, structuredClone(event.args));
    }
    if (event.type === "tool_execution_end") {
      const tool = registry.get(event.toolName);
      if (!tool) return;
      const context = getContext(event.toolCallId, signal);
      try {
        if (!recorder.read(context)) {
          if (!event.isError || !attempts.has(event.toolCallId)) throw safeError("storage_write_failed");
          sanitizeSdkRefusal(getControl?.(), event.toolCallId, event.result, tool.inputSchema, attempts.get(event.toolCallId));
          const call = recorder.request(tool, normalizedInput(tool, attempts.get(event.toolCallId)), context);
          const control = getControl?.(), observed = control?.observation(event.toolCallId), reason = observed?.failureClass;
          control?.noteFailure(event.toolCallId, { code: context.signal.aborted ? 'tool_cancelled' : reason ?? 'tool_input_invalid',
            stage: observed?.failureStage ?? 'sdk', recordId: call.id });
          recorder.finish(call.id, { status: context.signal.aborted ? "cancelled" : "failed",
            error: safeError(context.signal.aborted ? "tool_cancelled" : reason ?? "tool_input_invalid") }, "requested", getControl?.()?.observation(event.toolCallId));
          // SDK validation errors have SDK text, not the adapter's serialized ToolResult.
          sdkRejections.set(event.toolCallId, { recordId: call.id, content: structuredClone(event.result.content), details: structuredClone(event.result.details) });
        }
        finalized.set(event.toolCallId, { content: structuredClone(event.result.content), details: structuredClone(event.result.details), isError: event.isError });
      } catch { throw recorder.failPersistence(context); }
    }
    if (event.type !== "message_end" || event.message.role !== "toolResult" || !registry.get(event.message.toolName)) return;
    const context = getContext(event.message.toolCallId, signal);
    try {
      // Pi 0.87.1's earlier AgentSession listener has already appended this exact object.
      const entry = session.sessionManager.getEntries().findLast(entry => entry.type === "message" && entry.message === event.message);
      if (recorder.blocked(context) && entry) {
        recorder.recordDelivery(context, entry.id, ToolSdkDeliverySchema.parse(wireValue(event.message)));
        return;
      }
      const record = recorder.read(context), rejected = sdkRejections.get(event.message.toolCallId);
      const tool = registry.get(event.message.toolName)!;
      if (!record || !attempts.has(event.message.toolCallId)
        || !isDeepStrictEqual(record.input, normalizedInput(tool, attempts.get(event.message.toolCallId)))) throw safeError("storage_write_failed");
      const isSdkRejection = record && rejected?.recordId === record.id && record.name === event.message.toolName && event.message.isError
        && isDeepStrictEqual(rejected.content, event.message.content) && isDeepStrictEqual(rejected.details, event.message.details);
      const final = finalized.get(event.message.toolCallId);
      const isPostprocessed = record.control && ['passed', 'failed'].includes(record.control.postflightStatus) && final
        && final.isError === event.message.isError && isDeepStrictEqual(final.content, event.message.content) && isDeepStrictEqual(final.details, event.message.details);
      if (!entry || !record || !isSdkRejection && !isPostprocessed && !matchesRecordedResult(record, event.message)) throw safeError("storage_write_failed");
      // A verified replay adds a native history entry; preserve the first saved receipt.
      if (!record.sdkReturned) recorder.recordDelivery(context, entry.id, ToolSdkDeliverySchema.parse(wireValue(event.message)));
    } catch { throw recorder.failPersistence(context); }
    finally { attempts.delete(event.message.toolCallId); sdkRejections.delete(event.message.toolCallId); finalized.delete(event.message.toolCallId); }
  });
  return () => { unsubscribe(); attempts.clear(); sdkRejections.clear(); finalized.clear(); };
}

/** Install SDK hooks once; each subscription is bound to the currently accepted Run. */
export function createPiRunControlBinding(session: AgentSession, registry: Pick<ToolRegistry, 'get'>, recorder: ToolRecorder,
  getContext: ToolContextFactory, getControl: () => RunControl | undefined): () => () => void {
  const before = session.agent.beforeToolCall;
  const after = session.agent.afterToolCall;
  const save = (id: string, signal?: AbortSignal) => {
    const control = getControl();
    if (!control) return;
    const context = getContext(id, signal);
    if (recorder.read(context)) recorder.mergeControl(context, control.observation(id));
  };
  session.agent.beforeToolCall = async (context, signal) => {
    const control = getControl(), id = context.toolCall.id;
    if (!control) return before?.(context, signal);
    const business = registry.get(context.toolCall.name);
    const prepared = business?.inputSchema.safeParse(context.args);
    const rejected = control.admitToolCall(id, context.toolCall.name, prepared?.success ? prepared.data : context.args);
    if (recorder.read(getContext(id, signal))?.sdkReturned) return rejected ? { block: true, reason: JSON.stringify(rejected) } : undefined;
    control.updateObservation(id, { inputValidation: 'passed', preflightStatus: rejected ? 'blocked' : 'passed' });
    if (rejected) {
      control.noteFailure(id, { code: rejected.code, stage: 'admission' });
      return { block: true, reason: JSON.stringify(rejected) };
    }
    try {
      const result = await before?.(context, signal);
      if (result?.block) {
        control.updateObservation(id, { preflightStatus: 'blocked', admission: { status: 'blocked', reason: 'access_denied' } });
        control.noteFailure(id, { code: 'access_denied', stage: 'before_hook' });
      }
      return result;
    } catch {
      control.updateObservation(id, { preflightStatus: 'failed', hookFailure: { stage: 'beforeToolCall', code: 'internal_error' } });
      control.noteFailure(id, { code: 'internal_error', stage: 'before_hook' });
      throw new Error(JSON.stringify(safeError('internal_error')));
    }
  };
  session.agent.afterToolCall = async (context, signal) => {
    const control = getControl(), id = context.toolCall.id;
    if (!control) return after?.(context, signal);
    const delivered = recorder.read(getContext(id, signal));
    if (delivered?.sdkReturned && delivered.sdkDelivery) {
      const restored = nativeResult.parse({ content: structuredClone(delivered.sdkDelivery.content), details: structuredClone(delivered.sdkDelivery.details),
        usage: delivered.sdkDelivery.usage });
      return { ...restored, isError: delivered.sdkDelivery.isError };
    }
    try {
      const override = await after?.(context, signal);
      const final = { ...context.result, content: override?.content ?? context.result.content,
        details: override?.details ?? context.result.details, usage: override?.usage ?? context.result.usage,
        terminate: override?.terminate ?? context.result.terminate };
      const isError = override?.isError ?? context.isError;
      const content = z.array(z.union([
        z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
        z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string().min(1) }).passthrough(),
      ])).safeParse(final.content);
      if (!content.success || context.isError && !isError) throw new Error('tool_postprocess_failed');
      wireValue(final);
      control.updateObservation(id, { postflightStatus: 'passed' });
      save(id, signal);
      return override;
    } catch {
      control.updateObservation(id, { postflightStatus: 'failed', hookFailure: { stage: 'afterToolCall', code: 'tool_postprocess_failed' } });
      const record = recorder.read(getContext(id, signal));
      const queryId = record?.data && typeof record.data === 'object' && 'queryId' in record.data && typeof record.data.queryId === 'number' ? record.data.queryId : null;
      control.noteFailure(id, { code: 'tool_postprocess_failed', stage: 'after_hook', recordId: record?.id, queryId });
      save(id, signal);
      throw new Error(JSON.stringify(safeError('tool_postprocess_failed')));
    }
  };
  return () => session.agent.subscribe(async (event, signal) => {
    const control = getControl();
    if (!control) return;
    if (event.type === 'tool_execution_start') control.observeToolAttempt(event.toolCallId, event.toolName, event.args);
    if (event.type === 'tool_execution_end') {
      const context = getContext(event.toolCallId, signal), record = recorder.read(context);
      if (event.isError && control.observation(event.toolCallId).failureClass === null) {
        const known = registry.get(event.toolName) || ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'powershell'].includes(event.toolName);
        if (!known) sanitizeSdkRefusal(control, event.toolCallId, event.result, undefined, undefined);
        else {
          const queryId = record?.status === 'succeeded' && record.data && typeof record.data === 'object'
            && 'queryId' in record.data && typeof record.data.queryId === 'number' ? record.data.queryId : null;
          control.noteFailure(event.toolCallId, { code: record?.error?.code ?? (record?.status === 'succeeded' ? 'tool_postprocess_failed' : 'tool_input_invalid'),
            stage: record?.error ? 'execution' : record?.status === 'succeeded' ? 'sdk_delivery' : 'sdk', recordId: record?.id, queryId });
        }
      }
      if (record) save(event.toolCallId, signal);
    }
    if (event.type === 'message_end' && event.message.role === 'toolResult') {
      const context = getContext(event.message.toolCallId, signal), record = recorder.read(context);
      if (!record) {
        const entry = session.sessionManager.getEntries().findLast(entry => entry.type === 'message' && entry.message === event.message);
        if (entry && !registry.get(event.message.toolName)) control.acknowledgeDelivery(event.message.toolCallId, event.message.isError);
      } else if (record.sdkReturned) { control.acknowledgeDelivery(event.message.toolCallId, event.message.isError); save(event.message.toolCallId, signal); }
    }
  });
}

type NativeRecorder = Pick<ToolRecorder, "blocked" | "request" | "start" | "finish" | "read" | "recordDelivery" | "failPersistence">;
const nativeResult = z.custom<AgentToolResult<unknown>>(value => {
  const candidate = z.object({ content: z.array(z.union([
    z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
    z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string().min(1) }).passthrough(),
  ])) }).passthrough().safeParse(value);
  return candidate.success;
});
const nativeFailure = z.object({ nativeError: z.string() });
const finished = (record: ToolCallRecord) => ["succeeded", "failed", "cancelled"].includes(record.status);
function wireValue(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }
function preparedNativeInput(tool: PiToolDefinition, raw: unknown): { input: unknown; valid: boolean } {
  try {
    const prepared: unknown = tool.prepareArguments ? tool.prepareArguments(structuredClone(raw)) : structuredClone(raw);
    const args = z.record(z.string(), z.json()).parse(prepared);
    return { input: validateToolArguments(tool, { type: "toolCall", id: "recording", name: tool.name, arguments: args }), valid: true };
  } catch { return { input: raw, valid: false }; }
}

/** Retain Pi's executable definitions. Recording wraps execution, not its schemas or Operations. */
export function createPiNativeTools(
  workdir: string | (() => string),
  recorder: NativeRecorder,
  getContext: ToolContextFactory,
  options: ToolsOptions = {},
  getControl?: () => RunControl | undefined,
): { definitions: PiToolDefinition[]; bind(session: AgentSession): () => void } {
  const getWorkdir = typeof workdir === "string" ? () => workdir : workdir;
  // A session may register tools before its first Run exists. Actual I/O always uses the trusted ctx.cwd below.
  const cwd = typeof workdir === "string" ? workdir : process.cwd();
  const originals: PiToolDefinition[] = [
    defineTool(createReadToolDefinition(cwd, options.read)), defineTool(createGrepToolDefinition(cwd, options.grep)), defineTool(createFindToolDefinition(cwd, options.find)),
    defineTool(createLsToolDefinition(cwd, options.ls)), defineTool(createEditToolDefinition(cwd, options.edit)), defineTool(createWriteToolDefinition(cwd, options.write)),
    defineTool(createBashToolDefinition(cwd, options.bash)), defineTool(createPowerShellToolDefinition(cwd, options.powershell)),
  ];
  const byName = new Map(originals.map(tool => [tool.name, tool]));
  let session: AgentSession | undefined;
  const identity = (tool: PiToolDefinition): ToolCallIdentity => ({ name: tool.name, version: VERSION,
    effect: ["read", "grep", "find", "ls"].includes(tool.name) ? "READ" : "LOCAL_WRITE",
    executionMode: tool.executionMode ?? session?.agent.toolExecution ?? "parallel" });
  const fatal = (context: ToolExecutionContext): Error => new Error(JSON.stringify(recorder.failPersistence(context)));
  const save = (id: number, result: ToolResult<unknown>, context: ToolExecutionContext, from: "requested" | "running") => {
    try { recorder.finish(id, result, from, getControl?.()?.finishToolExecution(context.nativeToolCallId, result)); } catch { throw fatal(context); }
  };
  const definitions = originals.map(tool => ({
    ...tool,
    async execute(nativeToolCallId, input, signal, onUpdate, sdkContext) {
      let context = getContext(nativeToolCallId, signal);
      const metadata = identity(tool), control = getControl?.();
      const blocked = recorder.blocked(context); if (blocked) throw new Error(JSON.stringify(blocked));
      let record: ToolCallRecord;
      try { record = recorder.request(metadata, input, context); }
      catch (error) {
        const parsed = AppErrorSchema.safeParse(error);
        if (parsed.success && parsed.data.code !== "storage_write_failed") throw new Error(JSON.stringify(parsed.data));
        throw fatal(context);
      }
      if (finished(record)) {
        const failure = nativeFailure.safeParse(record.data);
        if (failure.success) throw new Error(failure.data.nativeError);
        const cached = nativeResult.safeParse(record.data);
        if (!cached.success) throw fatal(context);
        return structuredClone(cached.data);
      }
      if (record.status === "running") throw new Error(JSON.stringify(safeError("operation_result_unknown")));
      if (!context.scope.allowedToolNames.includes(tool.name) || context.scope.readOnly && metadata.effect === "LOCAL_WRITE" || context.signal.aborted) {
        const error = safeError(context.signal.aborted ? "tool_cancelled" : "access_denied");
        const message = JSON.stringify(error);
        const failure = { status: context.signal.aborted ? 'cancelled' as const : 'failed' as const, error, data: { nativeError: message } };
        recorder.finish(record.id, failure, 'requested', control?.finishToolExecution(nativeToolCallId, failure, {
          admission: { status: 'blocked', reason: error.code }, inputValidation: 'passed', businessValidation: { pre: 'not_applicable', post: 'not_applicable' } }));
        throw new Error(message);
      }
      if (control) {
        try {
          const lease = control.beginToolExecution(nativeToolCallId, tool.name, VERSION, input, context.signal);
          context = { ...context, signal: lease.signal, checkActive: lease.checkActive };
          context.checkActive?.();
        } catch (error) {
          const code = error instanceof Error ? error.message : 'internal_error';
          const result = { status: 'failed' as const, error: safeError(code), data: { nativeError: JSON.stringify(safeError(code)) } };
          recorder.finish(record.id, result, 'requested', control.finishToolExecution(nativeToolCallId, result));
          throw new Error(result.data.nativeError);
        }
      }
      try { recorder.start(record.id); } catch { control?.releaseToolExecution(nativeToolCallId); throw fatal(context); }
      let result: AgentToolResult<unknown>;
      try {
        // All eight defaults use ctx.cwd; preserve model/session metadata and bind the original Run directory.
        result = await tool.execute(nativeToolCallId, input, context.signal, onUpdate, { ...sdkContext, cwd: getWorkdir() });
      } catch (error) {
        const nativeError = error instanceof Error ? error.message : String(error);
        const timedOut = control?.observation(nativeToolCallId).timeoutRequestedAt !== null && control?.observation(nativeToolCallId).timeoutRequestedAt !== undefined;
        const failed = { status: context.signal.aborted && !timedOut ? 'cancelled' as const : 'failed' as const,
          error: safeError(timedOut ? 'tool_timeout' : context.signal.aborted ? 'tool_cancelled' : 'internal_error'), data: { nativeError } };
        const observation = control?.finishToolExecution(nativeToolCallId, failed, { outputValidation: 'not_reached', businessValidation: { pre: 'not_applicable', post: 'not_applicable' } });
        try { recorder.finish(record.id, failed, 'running', observation); } catch { throw fatal(context); }
        throw error;
      }
      let saved: unknown;
      try { saved = wireValue(result); if (!nativeResult.safeParse(saved).success) throw new Error('tool_output_invalid'); } catch {
        const error = safeError('tool_output_invalid');
        const failure = { status: 'failed' as const, error, data: { nativeError: JSON.stringify(error) } };
        recorder.finish(record.id, failure, 'running', control?.finishToolExecution(nativeToolCallId, failure, { outputValidation: 'failed' }));
        throw new Error(JSON.stringify(failure.error));
      }
      let code: string | null = null;
      try { context.checkActive?.(); } catch (error) { code = error instanceof Error ? error.message : 'internal_error'; }
      const final: ToolResult<unknown> = code || context.signal.aborted ? { status: code === 'tool_timeout' ? 'failed' : 'cancelled',
        error: safeError(code ?? 'tool_cancelled'), data: saved } : { status: 'succeeded', data: saved };
      const observation = control?.finishToolExecution(nativeToolCallId, final, { outputValidation: nativeResult.safeParse(saved).success ? 'passed' : 'failed',
        businessValidation: { pre: 'not_applicable', post: 'not_applicable' } });
      try { recorder.finish(record.id, final, 'running', observation); } catch { throw fatal(context); }
      if (final.status !== 'succeeded') throw new Error(JSON.stringify(final.error));
      return result;
    },
  } satisfies PiToolDefinition));
  return { definitions, bind(boundSession) {
    session = boundSession;
    const attempts = new Map<string, unknown>();
    const unsubscribe = boundSession.agent.subscribe(async (event, signal) => {
      if (event.type === "agent_end") attempts.clear();
      if (event.type === "tool_execution_start" && byName.has(event.toolName)) attempts.set(event.toolCallId, structuredClone(event.args));
      if (event.type === "tool_execution_end") {
        const tool = byName.get(event.toolName); if (!tool) return;
        const context = getContext(event.toolCallId, signal);
        try {
          const existing = recorder.read(context);
          if (existing && !finished(existing)) throw fatal(context);
          if (!existing) {
            if (!event.isError || !attempts.has(event.toolCallId)) throw fatal(context);
            const prepared = preparedNativeInput(tool, attempts.get(event.toolCallId));
            if (!prepared.valid) {
              let schema: z.ZodType | undefined;
              try { schema = z.fromJSONSchema(z.record(z.string(), z.json()).parse(wireValue(tool.parameters))); } catch { /* Unsupported SDK schemas retain an honest unknown field diagnosis. */ }
              if (schema) sanitizeSdkRefusal(getControl?.(), event.toolCallId, event.result, schema, prepared.input);
            }
            const record = recorder.request(identity(tool), prepared.input, context);
            const text = event.result.content.find((item: ToolResultMessage["content"][number]) => item.type === "text")?.text ?? "Tool execution was refused";
            const control = getControl?.(), observed = control?.observation(event.toolCallId), reason = observed?.failureClass;
            control?.noteFailure(event.toolCallId, { code: context.signal.aborted ? 'tool_cancelled' : reason ?? (prepared.valid ? 'access_denied' : 'tool_input_invalid'),
              stage: observed?.failureStage ?? 'sdk', recordId: record.id });
            save(record.id, { status: context.signal.aborted ? "cancelled" : "failed",
              error: safeError(context.signal.aborted ? "tool_cancelled" : reason ?? (prepared.valid ? "access_denied" : "tool_input_invalid")), data: { nativeError: text } }, context, "requested");
          }
        } catch { throw fatal(context); }
      }
      if (event.type !== "message_end" || event.message.role !== "toolResult" || !byName.has(event.message.toolName)) return;
      const context = getContext(event.message.toolCallId, signal);
      try {
        const record = recorder.read(context), tool = byName.get(event.message.toolName)!;
        const entry = boundSession.sessionManager.getEntries().findLast(entry => entry.type === "message" && entry.message === event.message);
        if (recorder.blocked(context) && entry) {
          recorder.recordDelivery(context, entry.id, ToolSdkDeliverySchema.parse(wireValue(event.message)));
          return;
        }
        if (!record || !finished(record) || record.name !== tool.name || !entry || !attempts.has(event.message.toolCallId)
          || !isDeepStrictEqual(record.input, preparedNativeInput(tool, attempts.get(event.message.toolCallId)).input)) throw fatal(context);
        if (!record.sdkReturned) recorder.recordDelivery(context, entry.id, ToolSdkDeliverySchema.parse(wireValue(event.message)));
      } catch { throw fatal(context); }
      finally { attempts.delete(event.message.toolCallId); }
    });
    return () => { unsubscribe(); attempts.clear(); };
  } };
}
