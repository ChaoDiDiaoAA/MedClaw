import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { validateToolArguments, type ToolResultMessage } from "@earendil-works/pi-ai";
import { createReadToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, createEditToolDefinition,
  createWriteToolDefinition, createBashToolDefinition, createPowerShellToolDefinition, defineTool, VERSION,
  type AgentSession, type AgentToolResult, type ToolDefinition as PiToolDefinition, type ToolsOptions } from "@earendil-works/pi-coding-agent";
import { AppErrorSchema, safeError } from "../../contracts/src/error";
import { ToolSdkDeliverySchema, type AnyToolDefinition, type ToolCallIdentity, type ToolCallRecord, type ToolExecutionContext, type ToolResult } from "../../contracts/src/tool";
import type { ToolRegistry } from "../../core/src/tools/registry";
import { ToolExecutor } from "../../core/src/tools/executor";
import type { ToolRecorder } from "../../core/src/tools/recorder";
import type { RunControl } from '../../core/src/runtime/run-control';
import type { ToolControlObservation } from '../../contracts/src/model';
import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalRequest } from '../../contracts/src/run';
import type { FrozenRunResources } from '../../contracts/src/resources';
import { verifyRunResourceFiles } from './resource-loader';
import { contextMessageText } from './messages';

// Pi 0.87.1 path aliases, used only for attribution; its public tool still performs the actual read.
async function canonicalReadPath(input: string, cwd: string): Promise<string | null> {
  let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g,' ').replace(/^@/,'');
  if (process.platform === 'win32' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
    if (drive) path = `${drive[1]!.toUpperCase()}:\\${drive[2]?.replaceAll('/','\\') ?? ''}`;
  }
  if (path === '~') path = homedir();
  else if (path.startsWith('~/') || process.platform === 'win32' && path.startsWith('~\\')) path = resolve(homedir(),path.slice(2));
  try {
    if (path.startsWith('file://')) path = fileURLToPath(path);
    path = resolve(cwd,path);
    for (const candidate of [path,path.replace(/ (AM|PM)\./gi,'\u202F$1.'),path.normalize('NFD'),path.replace(/'/g,'\u2019'),path.normalize('NFD').replace(/'/g,'\u2019')]) {
      try { return await realpath(candidate); } catch {}
    }
  } catch {}
  return null;
}

export type ToolContextFactory = (nativeToolCallId: string, signal?: AbortSignal) => ToolExecutionContext;

/** One factory belongs to one execution; retain it until required saves and listeners settle. */
export function createFrozenToolContextFactory(readContext: ToolContextFactory,
  cache = new Map<string, ToolExecutionContext>()): ToolContextFactory {
  return (nativeToolCallId, signal) => {
    const prior = cache.get(nativeToolCallId);
    // Identity stays frozen; SDK cancellation may arrive after an observer's first lookup.
    if (prior) return signal && signal !== prior.signal ? { ...prior, signal: AbortSignal.any([prior.signal, signal]) } : prior;
    const context = readContext(nativeToolCallId, signal);
    const frozen = { ...context, scope: structuredClone(context.scope),
      ...(context.workspaceContext === undefined ? {} : { workspaceContext: structuredClone(context.workspaceContext) }),
      ...(context.toolConfiguration === undefined ? {} : { toolConfiguration: structuredClone(context.toolConfiguration) }) };
    cache.set(nativeToolCallId, frozen);
    return frozen;
  };
}

const FailedReturnSchema = z.strictObject({ status: z.enum(["failed", "cancelled"]), error: AppErrorSchema, data: z.unknown().optional() });
function inputIssues(schema: z.ZodType, input: unknown): ToolControlObservation['validationIssues'] {
  const parsed = schema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.flatMap(issue => (issue.code === 'unrecognized_keys' ? issue.keys.map(key => [...issue.path, key]) : [issue.path])
    .map(path => ({ code: 'tool_input_invalid', stage: 'input', fieldPath: path.length <= 32 && path.every(part => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(String(part))) ? path.map(String) : [] }))).slice(0, 100);
}
function sanitizeSdkRefusal(control: RunControl | undefined, id: string, result: AgentToolResult<unknown>, schema: z.ZodType | undefined, input: unknown): void {
  if (!control) return;
  const existing = control.observation(id);
  if (existing.failureClass !== null && (existing.failureStage !== 'sdk' || !['tool_input_invalid', 'tool_not_found'].includes(existing.failureClass))) return;
  const issues = schema ? inputIssues(schema, input) : [];
  const code = schema ? 'tool_input_invalid' : 'tool_not_found';
  control.updateObservation(id, { inputValidation: schema ? 'failed' : 'not_reached', validationIssues: issues });
  control.noteFailure(id, { code, stage: 'sdk' });
  // Pi awaits this observer before creating its history message from the same result object.
  result.content = [{ type: 'text', text: JSON.stringify({ status: 'failed', error: safeError(code), validationIssues: issues }) }];
  result.details = {};
}
function checkDelivery(result: AgentToolResult<unknown>, isError: boolean, context: ToolExecutionContext, control?: RunControl, record?: ToolCallRecord | null) {
  const checked = ToolExecutor.afterToolUse('sdk_delivery', result, context, control, { isError, record });
  return { result: checked.result as AgentToolResult<unknown>, isError: checked.isError };
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
          const checked = checkDelivery(event.result, event.isError, context, getControl?.(), recorder.read(context));
          Object.assign(event.result, checked.result); event.isError = checked.isError;
          // Normalize before the snapshots Pi will compare with its actual history receipt.
          sdkRejections.set(event.toolCallId, { recordId: call.id, content: structuredClone(event.result.content), details: structuredClone(event.result.details) });
        }
        const checked = checkDelivery(event.result, event.isError, context, getControl?.(), recorder.read(context));
        Object.assign(event.result, checked.result); event.isError = checked.isError;
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
    const executionContext = getContext(id, signal);
    const nativeName = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'powershell'].includes(context.toolCall.name);
    const tool = business ?? (nativeName ? { name: context.toolCall.name, version: VERSION,
      effect: ['read', 'grep', 'find', 'ls'].includes(context.toolCall.name) ? 'READ' as const : 'LOCAL_WRITE' as const,
      executionMode: 'parallel' as const } : undefined);
    let rejected: ReturnType<typeof safeError> | null = null;
    try { ToolExecutor.beforeToolUse('sdk_admission', context.toolCall.name, prepared?.success ? prepared.data : context.args,
      executionContext, recorder, control, tool); }
    catch (native) { const parsed = AppErrorSchema.safeParse(native); rejected = parsed.success ? parsed.data : safeError(native instanceof Error ? native.message : 'internal_error'); }
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
    let checked: ReturnType<typeof checkDelivery>;
    try {
      const override = await after?.(context, signal);
      const final = { ...context.result, content: override?.content ?? context.result.content,
        details: override?.details ?? context.result.details, usage: override?.usage ?? context.result.usage,
        terminate: override?.terminate ?? context.result.terminate };
      const isError = override?.isError ?? context.isError;
      const validated = ToolExecutor.afterToolUse('sdk_delivery', final, getContext(id, signal), control,
        { isError, wasError: context.isError, record: delivered });
      checked = { result: validated.result as AgentToolResult<unknown>, isError: validated.isError };
      if (control.observation(id).postflightStatus !== 'failed') control.updateObservation(id, { postflightStatus: 'passed' });
    } catch {
      control.updateObservation(id, { postflightStatus: 'failed', hookFailure: { stage: 'afterToolCall', code: 'tool_postprocess_failed' } });
      const record = recorder.read(getContext(id, signal));
      const queryId = record?.data && typeof record.data === 'object' && 'queryId' in record.data && typeof record.data.queryId === 'number' ? record.data.queryId : null;
      control.noteFailure(id, { code: 'tool_postprocess_failed', stage: 'after_hook', recordId: record?.id, queryId });
      checked = { result: { content: [{ type: 'text', text: JSON.stringify(safeError('tool_postprocess_failed')) }], details: {} }, isError: true };
    }
    save(id, signal);
    return { ...checked.result, isError: checked.isError };
  };
  return () => session.agent.subscribe(async (event, signal) => {
    const control = getControl();
    if (!control) return;
    if (event.type === 'tool_execution_start') control.observeToolAttempt(event.toolCallId, event.toolName, event.args);
    if (event.type === 'tool_execution_end') {
      const context = getContext(event.toolCallId, signal), record = recorder.read(context);
      if (event.isError && control.observation(event.toolCallId).failureClass === null) {
        const known = registry.get(event.toolName) || ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'powershell'].includes(event.toolName);
        if (!known) {
          sanitizeSdkRefusal(control, event.toolCallId, event.result, undefined, undefined);
          const checked = checkDelivery(event.result, event.isError, context, control);
          Object.assign(event.result, checked.result); event.isError = checked.isError;
        }
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

type NativeRecorder = Pick<ToolRecorder, "blocked" | "request" | "start" | "finish" | "read" | "recordDelivery" | "recordResourceRead" | "failPersistence">;
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
  getResources?: () => FrozenRunResources | undefined,
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
  const fatal = (context: ToolExecutionContext, native?: unknown): Error => {
    const known = AppErrorSchema.safeParse(native);
    const error = known.success && known.data.category !== 'storage' ? known.data
      : native instanceof z.ZodError ? safeError('invalid_argument') : recorder.failPersistence(context);
    return new Error(JSON.stringify(error));
  };
  const save = (id: number, result: ToolResult<unknown>, context: ToolExecutionContext, from: "requested" | "running") => {
    try { recorder.finish(id, result, from, getControl?.()?.finishToolExecution(context.nativeToolCallId, result)); } catch (native) { throw fatal(context, native); }
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
      try { context = ToolExecutor.beforeToolUse('execution', tool.name, input, context, recorder, control, metadata); }
      catch (native) {
        const parsed = AppErrorSchema.safeParse(native);
        const error = parsed.success ? parsed.data : safeError(native instanceof Error ? native.message : 'internal_error');
        const failure = { status: error.code === 'tool_cancelled' ? 'cancelled' as const : 'failed' as const, error, data: { nativeError: JSON.stringify(error) } };
        save(record.id, failure, context, 'requested');
        throw new Error(failure.data.nativeError);
      }
      try { recorder.start(record.id); } catch (native) { control?.releaseToolExecution(nativeToolCallId); throw fatal(context, native); }
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
        try { recorder.finish(record.id, failed, 'running', observation); } catch (native) { throw fatal(context, native); }
        throw error;
      }
      let saved: unknown;
      try { saved = wireValue(result); if (!nativeResult.safeParse(saved).success) throw new Error('tool_output_invalid'); } catch {
        const error = safeError('tool_output_invalid');
        const failure = { status: 'failed' as const, error, data: { nativeError: JSON.stringify(error) } };
        recorder.finish(record.id, failure, 'running', control?.finishToolExecution(nativeToolCallId, failure, { outputValidation: 'failed' }));
        throw new Error(JSON.stringify(failure.error));
      }
      const final = ToolExecutor.afterToolUse('execution_settlement', { status: 'succeeded', data: saved }, context, control, { outputSchema: nativeResult, native: true });
      const observation = control?.finishToolExecution(nativeToolCallId, final, { outputValidation: nativeResult.safeParse(saved).success ? 'passed' : 'failed',
        businessValidation: { pre: 'not_applicable', post: 'not_applicable' } });
      try { recorder.finish(record.id, final, 'running', observation); } catch (native) { throw fatal(context, native); }
      if (final.status !== 'succeeded') throw new Error(JSON.stringify(final.error));
      return result;
    },
  } satisfies PiToolDefinition));
  return { definitions, bind(boundSession) {
    session = boundSession;
    const attempts = new Map<string, unknown>();
    const saveRead = async (context: ToolExecutionContext, message: ToolResultMessage) => {
      const frozen = getResources?.(), input = attempts.get(message.toolCallId);
      if (!frozen || message.toolName !== 'read' || message.isError || !input || typeof input !== 'object' || !('path' in input) || typeof input.path !== 'string') return;
      const requested = await canonicalReadPath(input.path,getWorkdir());
      if (requested === null) return;
      for (const snapshot of frozen.available) for (const file of snapshot.files) {
        const path = resolve(getWorkdir(), 'resources', snapshot.ref.kind === 'skill' ? 'skills' : 'prompts', snapshot.ref.id, snapshot.ref.version, file.file);
        if (requested !== await realpath(path).catch(() => null)) continue;
        await verifyRunResourceFiles(getWorkdir(), frozen);
        const args = input as {offset?:number;limit?:number}, lines = file.content.split('\n'), start = Math.max(0, (args.offset ?? 1) - 1);
        const selected = lines.slice(start, args.limit === undefined ? undefined : start + args.limit), text = contextMessageText(message.content);
        const truncation = message.details && typeof message.details === 'object' && 'truncation' in message.details ? message.details.truncation as {outputLines?:number} : null;
        const provedLines = truncation?.outputLines ?? selected.length, prefix = selected.slice(0, provedLines).join('\n');
        const coverage = start === 0 && selected.length === lines.length && text === file.content ? 'complete'
          : prefix.length > 0 && (text === prefix || text?.startsWith(prefix + '\n\n[')) ? 'partial' : 'unknown';
        recorder.recordResourceRead(context, {resourceRef:snapshot.ref,file:file.file,fileHash:file.sha256,
          returnedContentHash:createHash('sha256').update(canonicalRequest(message.content)).digest('hex'),coverage,observedAt:new Date().toISOString()});
      }
    };
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
          const checked = checkDelivery(event.result, event.isError, context, getControl?.(), recorder.read(context));
          Object.assign(event.result, checked.result); event.isError = checked.isError;
        } catch (native) { throw fatal(context, native); }
      }
      if (event.type !== "message_end" || event.message.role !== "toolResult" || !byName.has(event.message.toolName)) return;
      const context = getContext(event.message.toolCallId, signal);
      try {
        const record = recorder.read(context), tool = byName.get(event.message.toolName)!;
        const entry = boundSession.sessionManager.getEntries().findLast(entry => entry.type === "message" && entry.message === event.message);
        if (recorder.blocked(context) && entry) {
          recorder.recordDelivery(context, entry.id, ToolSdkDeliverySchema.parse(wireValue(event.message)));
          await saveRead(context, event.message);
          return;
        }
        if (!record || !finished(record) || record.name !== tool.name || !entry || !attempts.has(event.message.toolCallId)
          || !isDeepStrictEqual(record.input, preparedNativeInput(tool, attempts.get(event.message.toolCallId)).input)) throw fatal(context);
        if (!record.sdkReturned) recorder.recordDelivery(context, entry.id, ToolSdkDeliverySchema.parse(wireValue(event.message)));
        await saveRead(context, event.message);
      } catch (native) { throw fatal(context, native); }
      finally { attempts.delete(event.message.toolCallId); }
    });
    return () => { unsubscribe(); attempts.clear(); };
  } };
}
