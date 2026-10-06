import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { safeError, serviceResult, type AppError } from "@medclaw/contracts/error";
import { ToolContextIdentitySchema, type ToolCallIdentity, type ToolCallRecord, type ToolExecutionContext, type ToolResult } from "@medclaw/contracts/tool";
import { TOOL_CONFIG } from '@medclaw/contracts/tool-config';
import { ToolRecorder } from "./recorder";
import { ToolRegistry } from "./registry";
import type { RunControl } from '../runtime/run-control';

type DeliveryResult = {
  result: { content: { type: string; text?: string; [key: string]: unknown }[]; details?: unknown; usage?: unknown; [key: string]: unknown };
  isError: boolean;
};

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry, private readonly recorder: ToolRecorder,
    private readonly options: { findCommittedQuery?: (context: ToolExecutionContext) => { id: number; runId: number; sessionId: number; kind: 'current' | 'changes'; callRef: string } | null } = {}) {}

  static beforeToolUse(phase: 'hook_preflight' | 'sdk_admission' | 'execution', name: string, input: unknown, context: ToolExecutionContext,
    recorder: Pick<ToolRecorder, 'blocked'>, control?: RunControl, tool?: ToolCallIdentity): ToolExecutionContext {
    if (!ToolContextIdentitySchema.safeParse(context).success || !(context.signal instanceof AbortSignal)) throw safeError('invalid_argument');
    const blocked = recorder.blocked(context);
    if (blocked) throw blocked;
    if (!tool) throw safeError('tool_not_found');
    if (!context.scope.allowedToolNames.includes(name) || context.scope.readOnly && tool.effect === 'LOCAL_WRITE') {
      control?.updateObservation(context.nativeToolCallId, { admission: { status: 'blocked', reason: 'access_denied' } });
      throw safeError('access_denied');
    }
    if (context.signal.aborted) {
      control?.updateObservation(context.nativeToolCallId, { admission: { status: 'blocked', reason: 'tool_cancelled' } });
      throw safeError('tool_cancelled');
    }
    const configured = control ? { ...context, toolConfiguration: control.configuration } : context;
    if (phase === 'hook_preflight') { control?.checkActive(); return configured; }
    if (phase === 'execution') {
      const lease = control?.beginToolExecution(context.nativeToolCallId, name, tool.version, input, context.signal);
      const executionContext = lease ? { ...configured, signal: lease.signal, checkActive: lease.checkActive } : configured;
      executionContext.checkActive?.();
      return executionContext;
    }
    const error = control?.admitToolCall(context.nativeToolCallId, name, input);
    if (error) throw error;
    return configured;
  }

  static afterToolUse(phase: 'execution_settlement', result: ToolResult<unknown>, context: ToolExecutionContext, control?: RunControl,
    options?: { outputSchema?: z.ZodType; native?: boolean }): ToolResult<unknown>;
  static afterToolUse(phase: 'sdk_delivery', result: unknown, context: ToolExecutionContext, control?: RunControl,
    options?: { isError?: boolean; wasError?: boolean; maxResultBytes?: number; record?: ToolCallRecord | null }): DeliveryResult;
  static afterToolUse(phase: 'execution_settlement' | 'sdk_delivery', result: unknown, context: ToolExecutionContext, control?: RunControl,
    options: { outputSchema?: z.ZodType; native?: boolean; isError?: boolean; wasError?: boolean; maxResultBytes?: number; record?: ToolCallRecord | null } = {}): ToolResult<unknown> | DeliveryResult {
    const id = context.nativeToolCallId;
    if (phase === 'execution_settlement') {
      const executed = result as ToolResult<unknown>;
      if (executed.status !== 'succeeded') return executed;
      let output: ReturnType<z.ZodType['safeParse']> | undefined;
      try { output = options.outputSchema?.safeParse(executed.data); }
      catch { control?.updateObservation(id, { outputValidation: 'failed' }); return { status: 'failed', error: safeError('tool_output_invalid') }; }
      let valid = output?.success ?? true;
      try {
        const data = output?.success ? output.data : executed.data;
        const encoded = JSON.stringify(data);
        if (encoded === undefined || !options.native && !isDeepStrictEqual(data, JSON.parse(encoded))) valid = false;
      } catch { valid = false; }
      control?.updateObservation(id, { outputValidation: valid ? 'passed' : 'failed',
        businessValidation: options.native ? { pre: 'not_applicable', post: 'not_applicable' } : { pre: 'passed', post: valid ? 'passed' : 'not_reached' } });
      if (!valid) return { status: 'failed', error: safeError('tool_output_invalid') };
      const data = output?.success ? output.data : executed.data;
      try { context.checkActive?.(); } catch (native) {
        const known = native instanceof Error ? native.message : (native as AppError)?.code;
        const error = safeError(known ?? 'internal_error');
        return { status: error.code === 'tool_cancelled' ? 'cancelled' : 'failed', error, data };
      }
      return context.signal.aborted ? { status: 'cancelled', error: safeError('tool_cancelled'), data } : { status: 'succeeded', data };
    }
    const schema = z.object({ content: z.array(z.union([
      z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
      z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string().min(1) }).passthrough(),
    ])) }).passthrough();
    const parsed = schema.safeParse(result);
    let valid = parsed.success && !(options.wasError && !options.isError);
    try { JSON.parse(JSON.stringify(result)); } catch { valid = false; }
    const record = options.record;
    const queryId = record?.data && typeof record.data === 'object' && 'queryId' in record.data && typeof record.data.queryId === 'number' ? record.data.queryId : null;
    if (!valid) {
      control?.updateObservation(id, { postflightStatus: 'failed', hookFailure: { stage: 'afterToolCall', code: 'tool_postprocess_failed' } });
      control?.noteFailure(id, { code: 'tool_postprocess_failed', stage: 'after_hook', recordId: record?.id, queryId });
      return { result: { content: [{ type: 'text', text: JSON.stringify({ status: 'failed', error: safeError('tool_postprocess_failed') }) }] }, isError: true };
    }
    const final = parsed.data!;
    const bytes = final.content.reduce((total, item) => total + (item.type === 'text' ? Buffer.byteLength(item.text, 'utf8') : 0), 0);
    const limit = options.maxResultBytes ?? control?.configuration.maxResultBytes ?? context.toolConfiguration?.maxResultBytes ?? TOOL_CONFIG.maxResultBytes;
    if (bytes <= limit) return { result: result as typeof final, isError: options.isError ?? false };
    control?.noteFailure(id, { code: 'tool_result_too_large', stage: 'sdk_delivery', recordId: record?.id, queryId });
    return { result: { ...final, content: [{ type: 'text', text: JSON.stringify({ status: 'failed', error: safeError('tool_result_too_large') }) },
      ...final.content.filter(item => item.type !== 'text')] }, isError: true };
  }
  private failure(code: string, context: ToolExecutionContext): ToolResult<unknown> {
    return { status: "failed", error: safeError(code, undefined, { runId: context.runId, sessionId: context.sessionId }) };
  }
  private savedResult(record: ToolCallRecord): ToolResult<unknown> {
    return record.status === "succeeded" ? { status: "succeeded", data: record.data }
      : { status: record.status === "cancelled" ? "cancelled" : "failed", error: record.error ?? safeError("operation_result_unknown"), ...(record.data === null ? {} : { data: record.data }) };
  }
  async execute(name: string, rawInput: unknown, context: ToolExecutionContext, control?: RunControl): Promise<ToolResult<unknown>> {
    if (control) context = { ...context, toolConfiguration: control.configuration };
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
        let leaseError: ToolResult<unknown> | null = null;
        let preparedContext = context;
        try { preparedContext = ToolExecutor.beforeToolUse('execution', name, input.data, context, this.recorder, control, tool); }
        catch (error) {
          const blocked = await serviceResult(() => { throw error; }, 'internal_error');
          if (!blocked.ok) leaseError = { status: 'failed', error: blocked.error };
        }
        if (leaseError) result = leaseError;
        else {
        const executionContext = preparedContext;
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
          const settled = await serviceResult(() => ToolExecutor.afterToolUse('execution_settlement', { status: 'succeeded', data: executed.data },
            executionContext, control, { outputSchema: tool.outputSchema }), 'tool_output_invalid');
          result = settled.ok ? settled.data : { status: 'failed', error: settled.error };
        }
        }
      }
      if (result.status !== 'succeeded') {
        let queryId = result.data && typeof result.data === 'object' && 'queryId' in result.data && typeof result.data.queryId === 'number' ? result.data.queryId : null;
        let queryCommitUnknown = false;
        if (['query_current_devices', 'query_device_changes'].includes(name) && this.options.findCommittedQuery) {
          const committed = await serviceResult(() => this.options.findCommittedQuery!(context), 'storage_read_failed');
          const fact = committed.ok ? committed.data : null;
          queryId = fact && fact.runId === context.runId && fact.sessionId === context.sessionId && fact.callRef === `${context.runId}:${context.nativeToolCallId}`
            && fact.kind === (name === 'query_current_devices' ? 'current' : 'changes') && Number.isSafeInteger(fact.id) && fact.id > 0 ? fact.id : null;
          queryCommitUnknown = !committed.ok || fact !== null && queryId === null;
        }
        control?.noteFailure(context.nativeToolCallId, { code: result.error.code,
          stage: result.error.code === 'tool_output_inconsistent' ? 'business_post' : result.error.code === 'tool_output_invalid' ? 'output' : from === 'requested' ? 'admission' : 'execution', recordId: record.id, queryId, queryCommitUnknown });
      }
      const observation = control?.finishToolExecution(context.nativeToolCallId, result);
      this.recorder.finish(record.id, result, from, observation);
      return result;
    } catch (native) {
      if (from === 'requested') control?.releaseToolExecution(context.nativeToolCallId);
      const converted = await serviceResult(() => { throw native; }, 'internal_error');
      const error = this.recorder.blocked(context) ?? (converted.ok ? safeError('internal_error') : converted.error);
      return { status: "failed", error };
    }
  }
}
