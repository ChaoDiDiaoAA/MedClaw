import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PositiveIdSchema } from "../../packages/contracts/src/error";
import { businessToolSchemas } from "../../packages/contracts/src/business-tools";
import { canonicalRequest } from "../../packages/contracts/src/run";
import type { AnyToolDefinition, ToolCallRecord, ToolCallStore, ToolDefinition, ToolExecutionContext, ToolResult } from "../../packages/contracts/src/tool";
import { ToolExecutor } from "../../packages/core/src/tools/executor";
import { ToolRecorder } from "../../packages/core/src/tools/recorder";
import { ToolRegistry } from "../../packages/core/src/tools/registry";

const root = join(import.meta.dir, "../../packages/core/src/tools");

test("P3 provides fifteen business tool factories using central contracts and one explicit assembly", async () => {
  expect(existsSync(join(root, "business-tools"))).toBe(true);
  const names = readdirSync(join(root, "business-tools")).filter(name => name.endsWith(".ts"));
  expect(names).toHaveLength(15);
  expect(Object.keys(businessToolSchemas)).toHaveLength(15);
  for (const name of names) {
    const module = await import(join(root, "business-tools", name));
    const factories = Object.keys(module).filter(key => /^create.*Tool$/.test(key));
    expect(factories).toHaveLength(1);
    expect(Object.keys(module)).toEqual(factories);
    const schemas = Object.entries(businessToolSchemas).find(([key]) => key === name.slice(0, -3).replaceAll("-", "_"))?.[1];
    expect(schemas?.input).toBeDefined();
    expect(schemas?.output).toBeDefined();
  }
  expect(existsSync(join(root, "tools.ts"))).toBe(true);
});

// This test double stores facts only; SQLite transition/identity constraints have integration coverage.
class Calls implements ToolCallStore {
  rows = new Map<string, ToolCallRecord>();
  failTerminalSave = false;
  assertContext() {}
  readCall(context: ToolExecutionContext) { return this.rows.get(context.nativeToolCallId) ?? null; }
  request(tool: AnyToolDefinition, input: unknown, context: ToolExecutionContext) {
    const prior = this.readCall(context);
    if (prior) {
      if (canonicalRequest(prior.input) !== canonicalRequest(input) || prior.name !== tool.name) throw new Error("state_conflict");
      return prior;
    }
    const record: ToolCallRecord = { id: this.rows.size + 1, runId: context.runId, sessionId: context.sessionId,
      nativeToolCallId: context.nativeToolCallId, name: tool.name, version: tool.version, executionMode: tool.executionMode,
      input, status: "requested", data: null, error: null, sdkReturned: false, nativeEntryId: null };
    this.rows.set(context.nativeToolCallId, record); return record;
  }
  transition(id: number, _from: ToolCallRecord["status"], to: ToolCallRecord["status"], result?: ToolResult<unknown>) {
    if (this.failTerminalSave && to !== "running") throw new Error("sensitive native disk body");
    const record = [...this.rows.values()].find(row => row.id === id)!;
    const updated = { ...record, status: to, data: result && "data" in result ? result.data : null,
      error: result && "error" in result ? result.error : null };
    this.rows.set(record.nativeToolCallId, updated); return updated;
  }
  recordDelivery(context: ToolExecutionContext, nativeEntryId: string) {
    const record = this.readCall(context)!; this.rows.set(context.nativeToolCallId, { ...record, sdkReturned: true, nativeEntryId });
  }
}
const context = (nativeToolCallId = "call_1", signal = new AbortController().signal): ToolExecutionContext => ({
  runId: 1, sessionId: 1, nativeToolCallId, signal, referenceDate: "2026-01-01", timezone: "Asia/Shanghai",
  scope: { batchIds: [1], deviceIds: null, allowedToolNames: ["test_read"], allowedResourceRefs: [], artifactIds: [], readOnly: true },
});
const definition = (execute: (input: { batchId: number }, context: ToolExecutionContext) => Promise<number>): ToolDefinition<{ batchId: number }, number> => ({
  name: "test_read", version: "1.0.0", label: "测试读取", description: "读取测试事实。", effect: "READ", executionMode: "parallel",
  inputSchema: businessToolSchemas.read_batch.input, outputSchema: PositiveIdSchema, execute,
});

test("P3 registry requires unique valid definitions and preserves declared execution mode", () => {
  const tool = definition(async input => input.batchId);
  expect(() => new ToolRegistry([tool, tool])).toThrow("invalid_argument");
  const registry = new ToolRegistry([tool]);
  expect(registry.get("test_read")?.executionMode).toBe("parallel");
  expect(Object.isFrozen(registry.definitions)).toBe(true);
});

test("P3 executor validates both boundaries and records registered invalid input without executing", async () => {
  const calls = new Calls(); let count = 0;
  const executor = new ToolExecutor(new ToolRegistry([definition(async () => { count++; return 0; })]), new ToolRecorder(calls));
  expect(await executor.execute("test_read", { batchId: "1" }, context())).toMatchObject({ status: "failed", error: { code: "tool_input_invalid" } });
  expect(count).toBe(0); expect(calls.readCall(context())?.status).toBe("failed");
  expect(await executor.execute("test_read", { batchId: 1 }, context("call_2"))).toMatchObject({ status: "failed", error: { code: "tool_output_invalid" } });
  expect(count).toBe(1); expect(calls.readCall(context("call_2"))?.status).toBe("failed");
  const denied = context("call_3"); denied.scope.allowedToolNames = [];
  expect(await executor.execute("test_read", { batchId: 1 }, denied)).toMatchObject({ error: { code: "access_denied" } });
  expect(count).toBe(1); expect(calls.readCall(denied)).toMatchObject({ status: "failed", error: { code: "access_denied" } });
});

test("P3 executor never repeats a running or saved call and rejects identity parameter changes", async () => {
  const calls = new Calls(); let count = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const executor = new ToolExecutor(new ToolRegistry([definition(async input => { count++; await gate; return input.batchId; })]), new ToolRecorder(calls));
  const first = executor.execute("test_read", { batchId: 1 }, context());
  expect(await executor.execute("test_read", { batchId: 1 }, context())).toMatchObject({ error: { code: "operation_result_unknown" } });
  expect(count).toBe(1); release();
  expect(await first).toEqual({ status: "succeeded", data: 1 });
  expect(await executor.execute("test_read", { batchId: 1 }, context())).toEqual({ status: "succeeded", data: 1 });
  expect(await executor.execute("test_read", { batchId: 2 }, context())).toMatchObject({ error: { code: "state_conflict" } });
  expect(count).toBe(1);
});

test("P3 cancellation preserves already returned data and does not run an already cancelled call", async () => {
  const calls = new Calls(), abort = new AbortController(); let count = 0;
  const executor = new ToolExecutor(new ToolRegistry([definition(async input => { count++; abort.abort(); return input.batchId; })]), new ToolRecorder(calls));
  abort.abort();
  expect(await executor.execute("test_read", { batchId: 1 }, context("before", abort.signal))).toMatchObject({ status: "cancelled" });
  expect(count).toBe(0);
  const after = new AbortController();
  const second = new ToolExecutor(new ToolRegistry([definition(async input => { after.abort(); return input.batchId; })]), new ToolRecorder(calls));
  expect(await second.execute("test_read", { batchId: 1 }, context("after", after.signal))).toMatchObject({ status: "cancelled", data: 1 });
  expect(calls.readCall(context("after"))?.data).toBe(1);
});

test("P3 required result-save failure blocks subsequent execution and signals a fatal gap", async () => {
  const calls = new Calls(); calls.failTerminalSave = true;
  let count = 0, fatal = 0;
  const recorder = new ToolRecorder(calls, () => { fatal++; });
  const executor = new ToolExecutor(new ToolRegistry([definition(async input => { count++; return input.batchId; })]), recorder);
  const result = await executor.execute("test_read", { batchId: 1 }, context());
  expect(result).toMatchObject({ status: "failed", error: { code: "storage_write_failed" } });
  expect(JSON.stringify(result)).not.toContain("sensitive");
  expect(await executor.execute("test_read", { batchId: 1 }, context("next"))).toMatchObject({ error: { code: "storage_write_failed" } });
  expect(count).toBe(1); expect(fatal).toBe(1);
});

test("P3 required Query/Evidence save failure also blocks the Run after recording the tool failure", async () => {
  const calls = new Calls(); let count = 0, fatal = 0;
  const recorder = new ToolRecorder(calls, () => { fatal++; });
  const executor = new ToolExecutor(new ToolRegistry([definition(async () => { count++; throw new Error("storage_write_failed"); })]), recorder);
  expect(await executor.execute("test_read", { batchId: 1 }, context())).toMatchObject({ error: { code: "storage_write_failed" } });
  expect(calls.readCall(context())?.status).toBe("failed");
  expect(await executor.execute("test_read", { batchId: 1 }, context("next"))).toMatchObject({ error: { code: "storage_write_failed" } });
  expect(count).toBe(1); expect(fatal).toBe(1);
});
