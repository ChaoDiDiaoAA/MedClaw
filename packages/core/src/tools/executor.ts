import { safeError, serviceResult } from "@medclaw/contracts/error";
import { ToolContextIdentitySchema, type ToolCallRecord, type ToolExecutionContext, type ToolResult } from "@medclaw/contracts/tool";
import { ToolRecorder } from "./recorder";
import { ToolRegistry } from "./registry";
import type { RunControl } from '../runtime/run-control';

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry, private readonly recorder: ToolRecorder) {}
  private failure(code: string, context: ToolExecutionContext): ToolResult<unknown> {
    return { status: "failed", error: safeError(code, undefined, { runId: context.runId, sessionId: context.sessionId }) };
  }
  private savedResult(record: ToolCallRecord): ToolResult<unknown> {
    return record.status === "succeeded" ? { status: "succeeded", data: record.data }
      : { status: record.status === "cancelled" ? "cancelled" : "failed", error: record.error ?? safeError("operation_result_unknown"), ...(record.data === null ? {} : { data: record.data }) };
  }
  async execute(name: string, rawInput: unknown, context: ToolExecutionContext, control?: RunControl): Promise<ToolResult<unknown>> {
    if (!ToolContextIdentitySchema.safeParse(context).success || !(context.signal instanceof AbortSignal)) return this.failure("invalid_argument", context);
    const blocked = this.recorder.blocked(context);
    if (blocked) return { status: "failed", error: blocked };
    const tool = this.registry.get(name);
    if (!tool) return this.failure("tool_not_found", context);
    const input = tool.inputSchema.safeParse(rawInput);
    control?.updateObservation(context.nativeToolCallId, {
      inputValidation: input.success ? 'passed' : 'failed',
      validationIssues: input.success ? [] : input.error.issues.flatMap(issue => {
        const paths = issue.code === 'unrecognized_keys' ? issue.keys.map(key => [...issue.path, key]) : [issue.path];
        return paths.map(path => ({ code: 'tool_input_invalid', stage: 'input', fieldPath: path.length <= 32 && path.every(part => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(String(part))) ? path.map(String) : [] }));
      }).slice(0, 100),
    });
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
        let lease: ReturnType<RunControl['beginToolExecution']> | undefined;
        let leaseError: ToolResult<unknown> | null = null;
        try { lease = control?.beginToolExecution(context.nativeToolCallId, name, tool.version, input.data, context.signal); }
        catch (error) {
          const blocked = await serviceResult(() => { throw error; }, 'internal_error');
          if (!blocked.ok) leaseError = { status: 'failed', error: blocked.error };
        }
        if (leaseError) result = leaseError;
        else {
        const executionContext = lease ? { ...context, signal: lease.signal, checkActive: lease.checkActive } : context;
        this.recorder.start(record.id); from = "running";
        const executed = await serviceResult(() => { executionContext.checkActive?.(); return tool.execute(input.data, executionContext); }, "internal_error", { runId: context.runId, sessionId: context.sessionId, toolCallId: record.id });
        if (!executed.ok) {
          if (executed.error.code === 'tool_output_inconsistent') control?.updateObservation(context.nativeToolCallId,
            { businessValidation: { pre: 'passed', post: 'failed' } });
          else if (['access_denied', 'data_coverage_missing', 'invalid_argument', 'query_not_found', 'evidence_not_found', 'device_not_found', 'batch_not_found'].includes(executed.error.code))
            control?.updateObservation(context.nativeToolCallId, { businessValidation: { pre: 'failed', post: 'not_reached' } });
          result = executed.error.code === "storage_write_failed" ? { status: "failed", error: this.recorder.failPersistence(context) }
            : executionContext.signal.aborted && executed.error.code !== 'tool_timeout' ? { status: "cancelled", error: safeError("tool_cancelled") } : { status: "failed", error: executed.error };
        }
        else {
          const output = tool.outputSchema.safeParse(executed.data);
          control?.updateObservation(context.nativeToolCallId, { outputValidation: output.success ? 'passed' : 'failed',
            businessValidation: { pre: 'passed', post: output.success ? 'passed' : 'not_reached' } });
          const active = await serviceResult(() => executionContext.checkActive?.(), 'internal_error');
          result = !output.success ? this.failure("tool_output_invalid", context)
            : !active.ok ? { status: active.error.code === 'tool_cancelled' ? 'cancelled' : 'failed', error: active.error, data: output.data }
              : executionContext.signal.aborted ? { status: 'cancelled', error: safeError('tool_cancelled'), data: output.data }
              : { status: "succeeded", data: output.data };
        }
        }
      }
      if (result.status !== 'succeeded') {
        const queryId = result.data && typeof result.data === 'object' && 'queryId' in result.data && typeof result.data.queryId === 'number' ? result.data.queryId : null;
        control?.noteFailure(context.nativeToolCallId, { code: result.error.code,
          stage: result.error.code === 'tool_output_inconsistent' ? 'business_post' : result.error.code === 'tool_output_invalid' ? 'output' : from === 'requested' ? 'admission' : 'execution', recordId: record.id, queryId });
      }
      const observation = control?.finishToolExecution(context.nativeToolCallId, result);
      this.recorder.finish(record.id, result, from, observation);
      return result;
    } catch {
      if (from === 'requested') control?.releaseToolExecution(context.nativeToolCallId);
      const error = this.recorder.failPersistence(context);
      return { status: "failed", error };
    }
  }
}
