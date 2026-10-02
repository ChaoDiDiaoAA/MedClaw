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

export type ToolContextFactory = (nativeToolCallId: string, signal?: AbortSignal) => ToolExecutionContext;

const FailedReturnSchema = z.strictObject({ status: z.enum(["failed", "cancelled"]), error: AppErrorSchema, data: z.unknown().optional() });
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
): PiToolDefinition[] {
  return registry.definitions.map(tool => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: z.toJSONSchema(tool.inputSchema, { target: "draft-7", io: "input" }),
    executionMode: tool.executionMode,
    async execute(nativeToolCallId, input, signal) {
      const result = await executor.execute(tool.name, input, getContext(nativeToolCallId, signal));
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
): () => void {
  const attempts = new Map<string, unknown>();
  const sdkRejections = new Map<string, { recordId: number; content: ToolResultMessage["content"]; details: unknown }>();
  // Agent subscriptions are awaited; AgentSession subscriptions are preview notifications only.
  const unsubscribe = session.agent.subscribe(async (event, signal) => {
    if (event.type === "agent_end") { attempts.clear(); sdkRejections.clear(); }
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
          const call = recorder.request(tool, attempts.get(event.toolCallId), context);
          recorder.finish(call.id, { status: context.signal.aborted ? "cancelled" : "failed",
            error: safeError(context.signal.aborted ? "tool_cancelled" : "tool_input_invalid") }, "requested");
          // SDK validation errors have SDK text, not the adapter's serialized ToolResult.
          sdkRejections.set(event.toolCallId, { recordId: call.id, content: structuredClone(event.result.content), details: structuredClone(event.result.details) });
        }
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
      if (!entry || !record || !isSdkRejection && !matchesRecordedResult(record, event.message)) throw safeError("storage_write_failed");
      // A verified replay adds a native history entry; preserve the first saved receipt.
      if (!record.sdkReturned) recorder.recordDelivery(context, entry.id, ToolSdkDeliverySchema.parse(wireValue(event.message)));
    } catch { throw recorder.failPersistence(context); }
    finally { attempts.delete(event.message.toolCallId); sdkRejections.delete(event.message.toolCallId); }
  });
  return () => { unsubscribe(); attempts.clear(); sdkRejections.clear(); };
}

type NativeRecorder = Pick<ToolRecorder, "blocked" | "request" | "start" | "finish" | "read" | "recordDelivery" | "failPersistence">;
const nativeResult = z.custom<AgentToolResult<unknown>>(value => {
  const candidate = z.object({ content: z.array(z.object({ type: z.enum(["text", "image"]) }).passthrough()) }).safeParse(value);
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
    try { recorder.finish(id, result, from); } catch { throw fatal(context); }
  };
  const definitions = originals.map(tool => ({
    ...tool,
    async execute(nativeToolCallId, input, signal, onUpdate, sdkContext) {
      const context = getContext(nativeToolCallId, signal), metadata = identity(tool);
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
        save(record.id, { status: context.signal.aborted ? "cancelled" : "failed", error, data: { nativeError: message } }, context, "requested");
        throw new Error(message);
      }
      try { recorder.start(record.id); } catch { throw fatal(context); }
      let result: AgentToolResult<unknown>;
      try {
        // All eight defaults use ctx.cwd; preserve model/session metadata and bind the original Run directory.
        result = await tool.execute(nativeToolCallId, input, context.signal, onUpdate, { ...sdkContext, cwd: getWorkdir() });
      } catch (error) {
        const nativeError = error instanceof Error ? error.message : String(error);
        save(record.id, { status: context.signal.aborted ? "cancelled" : "failed",
          error: safeError(context.signal.aborted ? "tool_cancelled" : "internal_error"), data: { nativeError } }, context, "running");
        throw error;
      }
      let saved: unknown;
      try { saved = wireValue(result); } catch { throw fatal(context); }
      save(record.id, context.signal.aborted ? { status: "cancelled", error: safeError("tool_cancelled"), data: saved }
        : { status: "succeeded", data: saved }, context, "running");
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
            const record = recorder.request(identity(tool), prepared.input, context);
            const text = event.result.content.find((item: ToolResultMessage["content"][number]) => item.type === "text")?.text ?? "Tool execution was refused";
            save(record.id, { status: context.signal.aborted ? "cancelled" : "failed",
              error: safeError(context.signal.aborted ? "tool_cancelled" : prepared.valid ? "access_denied" : "tool_input_invalid"), data: { nativeError: text } }, context, "requested");
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
