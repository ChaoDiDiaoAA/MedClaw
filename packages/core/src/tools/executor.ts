import { safeError, serviceResult } from "@medclaw/contracts/error";
import { ToolContextIdentitySchema, type ToolCallRecord, type ToolExecutionContext, type ToolResult } from "@medclaw/contracts/tool";
import { ToolRecorder } from "./recorder";
import { ToolRegistry } from "./registry";

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry, private readonly recorder: ToolRecorder) {}
  private failure(code: string, context: ToolExecutionContext): ToolResult<unknown> {
    return { status: "failed", error: safeError(code, undefined, { runId: context.runId, sessionId: context.sessionId }) };
  }
  private savedResult(record: ToolCallRecord): ToolResult<unknown> {
    return record.status === "succeeded" ? { status: "succeeded", data: record.data }
      : { status: record.status === "cancelled" ? "cancelled" : "failed", error: record.error ?? safeError("operation_result_unknown"), ...(record.data === null ? {} : { data: record.data }) };
  }
  async execute(name: string, rawInput: unknown, context: ToolExecutionContext): Promise<ToolResult<unknown>> {
    if (!ToolContextIdentitySchema.safeParse(context).success || !(context.signal instanceof AbortSignal)) return this.failure("invalid_argument", context);
    const blocked = this.recorder.blocked(context);
    if (blocked) return { status: "failed", error: blocked };
    const tool = this.registry.get(name);
    if (!tool) return this.failure("tool_not_found", context);
    const input = tool.inputSchema.safeParse(rawInput);
    let record: ToolCallRecord;
    try { record = this.recorder.request(tool, input.success ? input.data : rawInput, context); }
    catch (native) {
      const requested = await serviceResult(() => { throw native; }, "storage_write_failed");
      return { status: "failed", error: requested.ok ? safeError("internal_error") : requested.error };
    }
    if (["succeeded", "failed", "cancelled"].includes(record.status)) return this.savedResult(record);
    if (record.status === "running") return this.failure("operation_result_unknown", context);
    let result: ToolResult<unknown>, from: "requested" | "running" = "requested";
    try {
      if (!context.scope.allowedToolNames.includes(name) || context.scope.readOnly && tool.effect === "LOCAL_WRITE") result = this.failure("access_denied", context);
      else if (context.signal.aborted) result = { status: "cancelled", error: safeError("tool_cancelled") };
      else if (!input.success) result = this.failure("tool_input_invalid", context);
      else {
        this.recorder.start(record.id); from = "running";
        const executed = await serviceResult(() => tool.execute(input.data, context), "internal_error", { runId: context.runId, sessionId: context.sessionId, toolCallId: record.id });
        if (!executed.ok) result = executed.error.code === "storage_write_failed" ? { status: "failed", error: this.recorder.failPersistence(context) }
          : context.signal.aborted ? { status: "cancelled", error: safeError("tool_cancelled") } : { status: "failed", error: executed.error };
        else {
          const output = tool.outputSchema.safeParse(executed.data);
          result = !output.success ? this.failure("tool_output_invalid", context)
            : context.signal.aborted ? { status: "cancelled", error: safeError("tool_cancelled"), data: output.data }
              : { status: "succeeded", data: output.data };
        }
      }
      this.recorder.finish(record.id, result, from);
      return result;
    } catch {
      const error = this.recorder.failPersistence(context);
      return { status: "failed", error };
    }
  }
}
