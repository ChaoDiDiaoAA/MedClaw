import { AppErrorSchema, safeError, type AppError, type AppErrorCode } from "@medclaw/contracts/error";
import { z } from 'zod';
import type { ToolCallIdentity, ToolCallStore, ToolExecutionContext, ToolResult, ToolSdkDelivery } from "@medclaw/contracts/tool";
import { isDeepStrictEqual } from 'node:util';
import type { ToolControlObservation } from '@medclaw/contracts/model';
import type { ResourceReadFact } from '@medclaw/contracts/resources';

export class ToolRecorder {
  private readonly blockedRuns = new Map<number, AppError>();
  private readonly contexts = new Map<number, ToolExecutionContext>();
  private readonly pending = new Map<number, Map<string, () => void>>();
  constructor(private readonly store: ToolCallStore, private readonly onFatal?: (error: AppError, context: ToolExecutionContext) => void) {}
  blocked(context: ToolExecutionContext): AppError | undefined { return this.blockedRuns.get(context.runId); }
  persistencePending(runId: number): boolean { return (this.pending.get(runId)?.size ?? 0) > 0; }
  retryPersistence(runId: number): void {
    const writes = this.pending.get(runId);
    if (!writes) return;
    for (const [key, save] of writes) { save(); writes.delete(key); }
    this.pending.delete(runId);
  }
  release(runId: number): void {
    this.blockedRuns.delete(runId); this.pending.delete(runId);
    for (const [id, context] of this.contexts) if (context.runId === runId) this.contexts.delete(id);
  }
  private defer(context: ToolExecutionContext, key: string, save: () => void): AppError {
    let writes = this.pending.get(context.runId);
    if (!writes) this.pending.set(context.runId, writes = new Map());
    writes.set(key, save); return this.failPersistence(context);
  }
  private saveResult(id: number, result: ToolResult<unknown>, context: ToolExecutionContext, control?: ToolControlObservation): void {
    const saved = this.store.readCall(context);
    if (!saved || saved.id !== id) throw new Error('storage_read_failed');
    if (['succeeded', 'failed', 'cancelled'].includes(saved.status)) {
      if (saved.status !== result.status || !isDeepStrictEqual(saved.data, result.data ?? null)
        || result.status !== 'succeeded' && saved.error?.code !== result.error.code) throw new Error('state_conflict');
      if (control) this.store.mergeControl?.(context, control);
      return;
    }
    this.store.transition(id, saved.status, result.status, result, control);
  }
  failPersistence(context: ToolExecutionContext): AppError {
    const error = safeError("storage_write_failed", undefined, { runId: context.runId, sessionId: context.sessionId });
    if (!this.blockedRuns.has(context.runId)) {
      this.blockedRuns.set(context.runId, error);
      try { this.onFatal?.(error, context); } catch { /* The persistence fault remains authoritative. */ }
    }
    return error;
  }
  private checked<T>(action: () => T, fallback: AppErrorCode, context?: ToolExecutionContext): T {
    try { return action(); }
    catch (native) {
      const known = AppErrorSchema.safeParse(native);
      const candidate = safeError(known.success ? known.data.code : native instanceof z.ZodError ? 'invalid_argument' : native instanceof Error ? native.message : fallback);
      const error = candidate.code === "internal_error" ? safeError(fallback) : candidate;
      if (context && error.category === "storage" && fallback === "storage_write_failed") throw this.failPersistence(context);
      throw error;
    }
  }
  request(tool: ToolCallIdentity, input: unknown, context: ToolExecutionContext) {
    if (this.blocked(context)) throw this.blocked(context);
    const requestedAt = new Date().toISOString();
    try {
      const record = this.checked(() => this.store.request(tool, input, context), 'storage_write_failed', context);
      this.contexts.set(record.id, context); return record;
    } catch (error) {
      if (this.blocked(context)) this.defer(context, `request:${context.nativeToolCallId}`, () => {
        const saved = this.store.readCall(context);
        if (saved && ['requested', 'running'].includes(saved.status)) this.saveResult(saved.id, { status: 'failed', error: this.blocked(context)! }, context);
        else if (!saved) {
          if (!this.store.recordFailedRequest) throw new Error('storage_write_failed');
          this.store.recordFailedRequest(tool, input, context, this.blocked(context)!, requestedAt);
        }
      });
      throw error;
    }
  }
  start(id: number) {
    const context = this.contexts.get(id);
    try { return this.checked(() => this.store.transition(id, 'requested', 'running'), 'storage_write_failed', context); }
    catch (error) {
      if (context && this.blocked(context)) this.defer(context, `start:${id}`, () => this.saveResult(id, { status: 'failed', error: this.blocked(context)! }, context));
      throw error;
    }
  }
  finish(id: number, result: ToolResult<unknown>, from: "requested" | "running" = "running", control?: ToolControlObservation) {
    const context = this.contexts.get(id);
    try { return this.checked(() => this.store.transition(id, from, result.status, result, control), 'storage_write_failed', context); }
    catch (error) {
      if (context && this.blocked(context)) this.defer(context, `result:${id}`, () => this.saveResult(id, result, context, control));
      throw error;
    }
  }
  read(context: ToolExecutionContext) { return this.checked(() => this.store.readCall(context), "storage_read_failed"); }
  readToolObservations(input: { cutoffAt: string; maxToolCallId?: number; limit: number; windowDays: number }) {
    return this.store.readToolObservations?.(input) ?? { maxToolCallId: null, observations: [] };
  }
  mergeControl(context: ToolExecutionContext, control: Partial<ToolControlObservation>) {
    try { return this.checked(() => this.store.mergeControl?.(context, control), 'storage_write_failed', context); }
    catch (error) {
      if (this.blocked(context)) this.defer(context, `control:${context.nativeToolCallId}`, () => this.store.mergeControl?.(context, control));
      throw error;
    }
  }
  recordDelivery(context: ToolExecutionContext, nativeEntryId: string, message?: ToolSdkDelivery) {
    try { return this.checked(() => this.store.recordDelivery(context, nativeEntryId, message), 'storage_write_failed', context); }
    catch (error) {
      if (this.blocked(context)) this.defer(context, `delivery:${context.nativeToolCallId}`, () => this.store.recordDelivery(context, nativeEntryId, message));
      throw error;
    }
  }
  recordConsumption(context: ToolExecutionContext, nextCallId: string, evidence?: 'provider_input_verified') {
    const save = () => this.store.recordConsumption?.(context, nextCallId, evidence);
    // A block stops new execution, but every already occurred delivery still needs its original save closure.
    if (this.blocked(context)) throw this.defer(context, `consumed:${context.nativeToolCallId}`, save);
    try { return this.checked(save, 'storage_write_failed', context); }
    catch (error) {
      if (this.blocked(context)) this.defer(context, `consumed:${context.nativeToolCallId}`, save);
      throw error;
    }
  }
  recordResourceRead(context: ToolExecutionContext, fact: ResourceReadFact) {
    const save = () => { if (!this.store.recordResourceRead) throw new Error('storage_write_failed'); this.store.recordResourceRead(context, fact); };
    if (this.blocked(context)) throw this.defer(context, `resource-read:${context.nativeToolCallId}`, save);
    try { return this.checked(save, 'storage_write_failed', context); }
    catch (error) { if (this.blocked(context)) this.defer(context, `resource-read:${context.nativeToolCallId}`, save); throw error; }
  }
}
