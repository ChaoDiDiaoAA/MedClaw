import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { PiModelRuntime } from "../../packages/runtime-pi/src/model-runtime";
import { PiAgentRuntime } from "../../packages/runtime-pi/src/agent-runtime";
import { ModelCallRecorder } from "../../packages/runtime-pi/src/model-call-recorder";
import { openDatabase } from "../../packages/storage/src/database";
import { Repositories } from "../../packages/storage/src/repositories";
import type { SubmitInput } from "../../packages/contracts/src/session";
import { ReadSessionMessagesInputSchema } from "../../packages/contracts/src/messages";
import { providerFixture } from "../fixtures/p1-provider";
import { SessionService } from "../../packages/core/src/session/session-service";
import { safeError } from "../../packages/contracts/src/error";
import { MAX_MESSAGE_PAGE_BYTES, SessionMessagePageSchema } from "../../packages/contracts/src/messages";
import type { ToolCallRecord } from "../../packages/contracts/src/tool";
import { CurrentQuerySchema } from "../../packages/contracts/src/query";
import { canonicalRequest } from "../../packages/contracts/src/run";
import { createHash } from "node:crypto";
import { createToolControlObservation } from "../../packages/contracts/src/model";
import * as PiSdk from "@earendil-works/pi-coding-agent";
import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { SqliteToolStore } from "../../packages/storage/src/tool-store";
import { ToolRegistry } from "../../packages/core/src/tools/registry";
import { ToolRecorder } from "../../packages/core/src/tools/recorder";
import { ToolExecutor } from "../../packages/core/src/tools/executor";
import { RunScopeSchema } from "../../packages/contracts/src/run";
import { projectToolCall } from "../../packages/runtime-pi/src/messages";
import type { ToolExecutionContext } from "../../packages/contracts/src/tool";
import { CatalogService } from "../../packages/core/src/data/catalog-service";
import { QueryService } from "../../packages/core/src/data/query-service";
import { EvidenceReader } from "../../packages/core/src/evidence/evidence-reader";
import { createBusinessTools } from "../../packages/core/src/tools/tools";
import { SqliteCatalogStore } from "../../packages/storage/src/catalog-store";

type DeliveryFixtureOptions = {
  status?: number; retry?: boolean; toolId?: string;
  tools?: { id: string; name: string; arguments: Record<string, unknown> }[];
  hooks?: (session: PiSdk.AgentSession, abort: AbortController, readRecord: () => ToolCallRecord | null) => void;
  prepare?: "headers" | "auth" | "missing-auth" | "no-callbacks";
  beforeResponse?: (abort: AbortController) => void;
  turnTools?: { id: string; name: string; arguments: Record<string, unknown> }[][];
  repeatPayload?: boolean;
  toolTimeoutMs?: number;
  api?: "openai-completions" | "openai-responses";
  query?: boolean;
};
// The factory spy changes only public Agent hooks; dispatch, native receipt observation and SQL are real.
async function deliveryFixture(config: DeliveryFixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "medclaw-p4-delivery-")), db = openDatabase(join(root, "proof.sqlite"));
  const repo = new Repositories(db), store = new SqliteToolStore(db), requests: Record<string, unknown>[] = [], abort = new AbortController();
  const tools = config.tools ?? [{ id: config.toolId ?? "scope-call", name: "read_data_scope", arguments: {} }];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>; requests.push(body);
    if (requests.length > 1) {
      config.beforeResponse?.(abort);
      if (config.status || config.retry && requests.length === 2) return new Response("fixture rejection", { status: config.status ?? 503, headers: { "retry-after": "0" } });
    }
    const emitted = config.turnTools?.[requests.length - 1] ?? (requests.length === 1 ? tools : []), first = emitted.length > 0;
    if (config.api === "openai-responses") {
      const output = first ? emitted.map(tool => ({ type: "function_call", id: "fc1", call_id: tool.id, name: tool.name, arguments: JSON.stringify(tool.arguments) }))
        : [{ type: "message", id: "msg1", role: "assistant", content: [{ type: "output_text", text: "Actual delivery fixture complete." }] }];
      const events = output.flatMap((item, output_index) => [{ type: "response.output_item.added", output_index, item }, { type: "response.output_item.done", output_index, item }]);
      events.push({ type: "response.completed", response: { id: "fixture", status: "completed", output } } as unknown as typeof events[number]);
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    const delta = first ? { role: "assistant", tool_calls: emitted.map((tool, index) => ({ index, id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } })) }
      : { role: "assistant", content: "Actual delivery fixture complete." };
    return new Response(`data: ${JSON.stringify({ id: "fixture", model: "fixture", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  closes.push(async () => { server.stop(true); db.close(); await rm(root, { recursive: true, force: true }); });
  if (config.query) {
    const now = new Date().toISOString();
    db.query("INSERT INTO imports(id,operation_ref,instance_id,state,preview_request_hash,preview_request_json,created_at,updated_at) VALUES(1,'import','fixture','imported','hash','{}',?,?)").run(now, now);
    db.query("UPDATE catalog_state SET revision=1,updated_at=?").run(now);
    db.query(`INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,
      expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at)
      VALUES(1,1,'scope','2026-10-01','浙江','fixture/v1','bundle','lock','content','full','cohort',1,1,'[]','{}',1,NULL,1,?)`).run(now);
    db.query("UPDATE batches SET metadata_json=? WHERE id=1").run(JSON.stringify({ referenceDate: "2026-10-01", timezone: "Asia/Shanghai" }));
    const sources = JSON.stringify([{ sourceId: "fixture", file: "saved-source.csv", recordId: "device-1", row: 1, sha256: "a".repeat(64) }]);
    db.query("INSERT INTO devices(id,source_device_id,source_bundle_id,source_submission_id,source_refs_json,created_at) VALUES(1,'device-1','bundle','submission',?,?)").run(sources, now);
    db.query(`INSERT INTO snapshots(id,batch_id,device_id,device_name,category,region,price_cents,currency,unit,status,manufacturer,distributor,source_row_ref,source_refs_json,field_origins_json)
      VALUES(1,1,1,'Fixture device','Fixture','浙江',100,'CNY','件','active','Fixture manufacturer','Fixture distributor','1:1',?,'{}')`).run(sources);
  }
  const catalog = new CatalogService(new SqliteCatalogStore(db)), queries = new QueryService(catalog, store);
  const registry = new ToolRegistry(config.query ? createBusinessTools({ catalog, queries, evidence: new EvidenceReader(catalog, queries, store) }) : [{ name: "read_data_scope", version: "1.0.0", label: "Read scope", description: "Read the accepted scope.",
    inputSchema: RunScopeSchema.pick({}), outputSchema: RunScopeSchema.pick({ batchIds: true }), effect: "READ", executionMode: "parallel",
    execute: async (_input, context) => ({ batchIds: context.scope.batchIds }) }]);
  const recorder = new ToolRecorder(store), credentials = new InMemoryCredentialStore();
  await credentials.modify("p4-delivery", async () => ({ type: "api_key", key: "fixture-only" }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  await runtime.installCustom([{ providerId: "p4-delivery", name: "Delivery fixture", api: config.api ?? "openai-completions", baseUrl: `http://127.0.0.1:${server.port}/v1`,
    models: [{ id: "fixture", name: "Fixture", input: ["text", "image"], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] }]);
  const agent = new PiAgentRuntime(runtime, root, { registry, recorder, executor: new ToolExecutor(registry, recorder) });
  const manager = SessionManager.inMemory(root), allocation = spyOn(SessionManager, "inMemory").mockReturnValueOnce(manager);
  let native: ReturnType<typeof agent.allocate>;
  try { native = agent.allocate(); } finally { allocation.mockRestore(); }
  const session = repo.createSession({ expectedWorkspaceRevision: 0 }, "create", native.nativeSessionId, new Date().toISOString()).session; native.bind(session.id);
  if (config.query) repo.updateWorkspace({ batchIds: [1] }, repo.readWorkspace().revision, new Date().toISOString());
  const workspace = repo.readWorkspace(), scope = repo.freezeAgentScope(workspace, agent.toolNames ?? []);
  const policy = { timeoutMs: 10000, maxRetries: config.retry ? 1 as const : 0 as const, maxRetryDelayMs: 2000 };
  const model = { provider: "p4-delivery", modelId: "fixture", expectedConfigVersion: "1" };
  const resolved = await runtime.resolve(model, "1", null, policy), agentOptions = agent.describe(resolved);
  const input: SubmitInput = { sessionId: session.id, clientSequence: 1, text: "Exercise actual delivery", mode: "send", expectedRevision: workspace.revision,
    expectedBatchIds: scope.batchIds, expectedQueryId: null, model, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" };
  const agentPolicy = { version: "medclaw.agent-policy/v1" as const, maxToolCalls: 24, maxModelCalls: (config.turnTools?.length ?? 1) + 1, singleToolTimeoutMs: config.toolTimeoutMs ?? 30000, maxRecoveryAttempts: 2 };
  const { runId } = repo.registerAgent({ sessionId: session.id, inputId: null, text: input.text, model: resolved.selection, policy, goal: "answer", workspace, scope,
    referenceDate: input.referenceDate, timezone: input.timezone, timeoutMs: policy.timeoutMs, agentOptions, agentPolicy,
    submission: { operationRef: "send", originalSubmitInput: input }, instanceId: "p4-fixture", createdAt: new Date().toISOString() });
  const context = (nativeToolCallId = config.api === "openai-responses" ? `${tools[0]!.id}|fc1` : tools[0]!.id): ToolExecutionContext => ({ runId, sessionId: session.id, nativeToolCallId, scope,
    referenceDate: input.referenceDate, timezone: input.timezone, signal: abort.signal, checkActive: () => abort.signal.throwIfAborted() });
  const originalCreate = PiSdk.createAgentSession;
  let actualSession: PiSdk.AgentSession | undefined;
  const factory = spyOn(PiSdk, "createAgentSession").mockImplementation(async options => {
    const result = await originalCreate(options); actualSession = result.session; config.hooks?.(result.session, abort, () => store.readCall(context())); return result;
  });
  const streamSimple = runtime.native.streamSimple.bind(runtime.native);
  let streams = 0;
  runtime.native.streamSimple = (model, context, options) => {
    streams++;
    let next: ModelsSimpleStreamOptions | undefined = options;
    if (streams === 2 && config.prepare === "headers") next = { ...options, transformHeaders: async () => { throw new Error("fixture preparation failure"); } };
    if (streams === 2 && config.prepare === "no-callbacks") next = { ...options, onPayload: undefined, onResponse: undefined };
    if (streams === 2 && config.repeatPayload) next = { ...options, onPayload: async (payload, callbackModel) => {
      await options?.onPayload?.(payload, callbackModel);
      const changed = structuredClone(payload) as { messages: { role: string; content: string }[] };
      changed.messages.find(message => message.role === "tool")!.content = "changed by second callback";
      await options?.onPayload?.(changed, callbackModel); return changed;
    } };
    return streamSimple(model, context, next);
  };
  const originalAuth = runtime.native.getAuth.bind(runtime.native);
  runtime.native.getAuth = async (...args) => {
    if (streams === 2 && config.prepare === "auth") throw new Error("fixture auth failure");
    if (streams === 2 && config.prepare === "missing-auth") return undefined;
    return typeof args[0] === "string" ? originalAuth(args[0], args[1]) : originalAuth(args[0], args[1]);
  };
  let observed: Awaited<ReturnType<typeof agent.execute>>;
  try { observed = await agent.execute({ runId, sessionId: session.id, text: input.text, resolved, agentOptions, scope,
    referenceDate: input.referenceDate, timezone: input.timezone, agentPolicy, signal: abort.signal, deadlineAt: performance.now() + policy.timeoutMs }, {
    startCall: time => new ModelCallRecorder(repo, runId, "main", time), preview: () => {}, nativeTerminal: () => {},
  }); } finally { factory.mockRestore(); actualSession?.dispose(); }
  const record = () => store.readCall(context())!;
  const receiptJson = () => db.query<{ delivery_json: string }, []>("SELECT delivery_json FROM tool_calls ORDER BY id LIMIT 1").get()!.delivery_json;
  return { root, db, repo, store, recorder, agent, manager, requests, observed, streams, context, record, receiptJson, abort };
}

test.each(["headers", "auth", "missing-auth", "no-callbacks", "401", "cancel-before-response"] as const)(
  "lazy stream creation never acknowledges tool consumption before an actual successful request: %s", async mode => {
    const c = await deliveryFixture({ ...(mode === "401" ? { status: 401 } : mode === "cancel-before-response" ? { beforeResponse: abort => abort.abort() } : { prepare: mode }) });
    expect(c.streams).toBe(2); expect(c.observed.calls).toHaveLength(2);
    expect(c.record()).toMatchObject({ status: "succeeded", sdkReturned: true, sdkDelivery: { toolCallId: "scope-call" } });
    expect(c.record().nativeEntryId).toBeTruthy();
    expect(c.record().nextModelCallId).toBeUndefined(); expect(c.record().consumedAt).toBeUndefined(); expect(c.record().consumptionEvidence).toBeUndefined();
    expect(c.requests).toHaveLength(["headers", "auth", "missing-auth"].includes(mode) ? 1 : 2);
    if (mode === "no-callbacks") expect(c.observed.lastOutcome?.error).toBeNull();
  });

test("text-only completions receipts require an exact final payload and the same successful response", async () => {
  const c = await deliveryFixture();
  expect(c.requests).toHaveLength(2);
  expect(c.requests[1]!.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "scope-call" })] }),
    { role: "tool", tool_call_id: "scope-call", content: '{"batchIds":[]}' },
  ]));
  expect(c.record()).toMatchObject({ nextModelCallId: c.observed.calls[1]!.callId, consumptionEvidence: "provider_input_verified",
    sdkDelivery: { role: "toolResult", toolCallId: "scope-call", toolName: "read_data_scope", isError: false, content: [{ type: "text", text: '{"batchIds":[]}' }] } });
  expect(JSON.parse(c.receiptJson())).toMatchObject({ nextModelCallId: c.observed.calls[1]!.callId, consumptionEvidence: "provider_input_verified" });
  expect(c.record().consumedAt).toBeTruthy(); expect(projectToolCall(c.record()).consumptionEvidence).toBe("provider_input_verified");
  expect(c.manager.getEntry(c.record().nativeEntryId!)?.type).toBe("message");
  console.info("T05 actual HTTP/SQL proof", JSON.stringify({ toolCallId: c.record().nativeToolCallId, nativeEntryId: c.record().nativeEntryId,
    logicalCallId: c.observed.calls[1]!.callId, savedNextCallId: c.record().nextModelCallId, consumptionEvidence: c.record().consumptionEvidence,
    wireTool: (c.requests[1]!.messages as { role: string }[]).find(message => message.role === "tool"), receipt: c.record().sdkDelivery }));
});

test.each(["remove", "content", "id", "assistant", "duplicate-tool", "duplicate-assistant", "null", "throw-payload", "throw-response"] as const)(
  "payload replacement, mismatched content and unsupported conversion remain unknown: %s", async mode => {
    let payloadCalls = 0, responseCalls = 0;
    const c = await deliveryFixture({ hooks(session) {
      session.agent.onPayload = async (payload, model) => {
        expect(model.api).toBe("openai-completions"); payloadCalls++;
        if (payloadCalls === 1) return undefined;
        await Promise.resolve();
        if (mode === "null") return null;
        if (mode === "throw-payload") throw new Error("fixture payload hook failure");
        const changed = structuredClone(payload) as { messages: { role: string; tool_call_id?: string; content?: string; tool_calls?: unknown[] }[] };
        const tool = changed.messages.find(message => message.role === "tool")!, assistant = changed.messages.find(message => message.tool_calls)!;
        if (mode === "remove") changed.messages = changed.messages.filter(message => message.role !== "tool");
        if (mode === "content") tool.content = "contains the original: " + tool.content;
        if (mode === "id") tool.tool_call_id = "different-id";
        if (mode === "assistant") delete assistant.tool_calls;
        if (mode === "duplicate-tool") changed.messages.push({ ...tool, content: "contradictory result" });
        if (mode === "duplicate-assistant") changed.messages.push({ ...assistant });
        return changed;
      };
      session.agent.onResponse = async (response, model) => {
        responseCalls++; expect(response.status).toBe(200); expect(model.api).toBe("openai-completions");
        await Promise.resolve(); if (responseCalls === 2 && mode === "throw-response") throw new Error("fixture response hook failure");
      };
    } });
    expect(payloadCalls).toBe(2);
    expect(c.requests).toHaveLength(["null", "throw-payload"].includes(mode) ? 1 : 2);
    expect(responseCalls).toBe(c.requests.length);
    expect(c.record().consumptionEvidence).toBeUndefined(); expect(c.record().nextModelCallId).toBeUndefined();
    if (mode === "content") expect(c.requests[1]!.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'contains the original: {"batchIds":[]}' })]));
    if (mode === "remove") expect((c.requests[1]!.messages as { role: string }[]).some(message => message.role === "tool")).toBe(false);
  });

test.each(["replacement", "async-undefined-mutation", "cancel-after-response", "absent-original"] as const)(
  "composed callbacks preserve exact returns and await completion before saving proof: %s", async mode => {
    let payloadCalls = 0, responseCalls = 0;
    const c = await deliveryFixture({ hooks(session, abort, readRecord) {
      session.agent.afterToolCall = async () => ({ content: [{ type: "text", text: "合法😀" }, { type: "text", text: "second line" }] });
      session.agent.onPayload = async payload => {
        payloadCalls++; await Promise.resolve();
        if (mode === "replacement") return structuredClone(payload);
        (payload as Record<string, unknown>).temperature = 0.25; return undefined;
      };
      session.agent.onResponse = async () => {
        responseCalls++;
        if (responseCalls === 2) expect(readRecord()?.nextModelCallId).toBeUndefined();
        await Promise.resolve();
        if (responseCalls === 2) {
          // The original hook completes before the evidence writer runs.
          const receipt = session.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "toolResult");
          expect(receipt).toBeDefined();
          if (mode === "cancel-after-response") abort.abort();
        }
      };
      if (mode === "absent-original") { session.agent.onPayload = undefined; session.agent.onResponse = undefined; }
    } });
    expect(payloadCalls).toBe(mode === "absent-original" ? 0 : 2); expect(responseCalls).toBe(mode === "absent-original" ? 0 : 2);
    expect(c.requests[1]!.messages).toEqual(expect.arrayContaining([{ role: "tool", tool_call_id: "scope-call", content: "合法😀\nsecond line" }]));
    if (mode === "async-undefined-mutation" || mode === "cancel-after-response") expect(c.requests[1]!.temperature).toBe(0.25);
    expect(c.record()).toMatchObject({ status: "succeeded", nextModelCallId: c.observed.calls[1]!.callId, consumptionEvidence: "provider_input_verified" });
    if (mode === "cancel-after-response") expect(c.abort.signal.aborted).toBe(true);
  });

test.each(["image", "empty", "unicode", "pipe", "long"] as const)(
  "unsupported receipt conversion executes normally but stays unknown: %s", async mode => {
    const c = await deliveryFixture({ toolId: mode === "pipe" ? "original|item" : mode === "long" ? "x".repeat(41) : "scope-call", hooks(session) {
      if (mode === "image") session.agent.afterToolCall = async () => ({ content: [{ type: "text", text: "visible" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] });
      if (mode === "empty") session.agent.afterToolCall = async () => ({ content: [] });
      if (mode === "unicode") session.agent.afterToolCall = async () => ({ content: [{ type: "text", text: "illegal\ud800" }] });
    } });
    expect(c.requests).toHaveLength(2); expect(c.observed.lastOutcome?.error).toBeNull();
    expect(c.record().sdkReturned).toBe(true); expect(c.record().consumptionEvidence).toBeUndefined(); expect(c.record().nextModelCallId).toBeUndefined();
    if (mode === "unicode") expect(JSON.stringify(c.requests[1]!.messages)).not.toContain("\\ud800");
  });

test.each(["name", "isError", "content", "native-entry", "native-session"] as const)(
  "context candidates must equal the saved receipt and the original native Session: %s", async mode => {
    const c = await deliveryFixture({ hooks(session) {
      if (["name", "isError", "content"].includes(mode)) {
        const convert = session.agent.convertToLlm;
        session.agent.convertToLlm = async messages => (await convert(messages)).map(message => {
          if (message.role !== "toolResult") return message;
          return { ...message, ...(mode === "name" ? { toolName: "write" } : mode === "isError" ? { isError: !message.isError }
            : { content: [{ type: "text" as const, text: "changed context" }] }) };
        });
      }
      if (mode === "native-entry") {
        const getEntry = session.sessionManager.getEntry.bind(session.sessionManager);
        session.sessionManager.getEntry = id => {
          const entry = getEntry(id);
          if (entry?.type !== "message" || entry.message.role !== "toolResult") return entry;
          return { ...entry, message: { ...entry.message, toolCallId: "wrong-native-entry" } };
        };
      }
      if (mode === "native-session") session.agent.subscribe(event => {
        if (event.type === "message_end" && event.message.role === "toolResult") session.sessionManager.getSessionId = () => "different-session";
      });
    } });
    expect(c.requests).toHaveLength(2); expect(c.record().sdkReturned).toBe(true);
    expect(c.record().consumptionEvidence).toBeUndefined(); expect(c.record().nextModelCallId).toBeUndefined();
    if (mode === "name" || mode === "isError") expect(c.requests[1]!.messages).toEqual(expect.arrayContaining([{ role: "tool", tool_call_id: "scope-call", content: '{"batchIds":[]}' }]));
  });

test("HTTP retries reuse one exact payload and one logical call; repeated payload callbacks recompute proof", async () => {
  const c = await deliveryFixture({ retry: true });
  expect(c.requests).toHaveLength(3); expect(c.requests[1]).toEqual(c.requests[2]); expect(c.observed.calls).toHaveLength(2);
  expect(c.record()).toMatchObject({ nextModelCallId: c.observed.calls[1]!.callId, consumptionEvidence: "provider_input_verified" });
  const repeated = await deliveryFixture({ repeatPayload: true });
  expect(repeated.requests).toHaveLength(2); expect(repeated.record().nextModelCallId).toBeUndefined();
  expect(repeated.requests[1]!.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool", content: "changed by second callback" })]));
});

test("a later logical request cannot borrow the prior call proof or overwrite its first receipt", async () => {
  let payloadCalls = 0;
  const c = await deliveryFixture({ turnTools: [[{ id: "scope-call", name: "read_data_scope", arguments: {} }], [{ id: "scope-later", name: "read_data_scope", arguments: {} }]], hooks(session) {
    session.agent.onPayload = payload => {
      if (++payloadCalls !== 3) return undefined;
      const changed = structuredClone(payload) as { messages: { role: string }[] };
      changed.messages = changed.messages.filter(message => message.role !== "tool"); return changed;
    };
  } });
  expect(c.requests).toHaveLength(3); expect(c.observed.calls).toHaveLength(3);
  const first = c.record(), json = c.receiptJson();
  expect(first.nextModelCallId).toBe(c.observed.calls[1]!.callId);
  expect(c.store.readCall(c.context("scope-later"))?.nextModelCallId).toBeUndefined();
  c.store.recordConsumption(c.context(), c.observed.calls[2]!.callId, "provider_input_verified");
  expect(c.receiptJson()).toBe(json); expect(c.record().nativeEntryId).toBe(first.nativeEntryId);
});

test("successful request confirmation does not turn an actual after-hook error receipt into business success", async () => {
  const c = await deliveryFixture({ hooks(session) { session.agent.afterToolCall = async () => { throw new Error("actual after-hook failure"); }; } });
  expect(c.requests).toHaveLength(2);
  expect(c.record()).toMatchObject({ status: "succeeded", data: { batchIds: [] }, sdkDelivery: { isError: true },
    consumptionEvidence: "provider_input_verified", control: { postflightStatus: "failed", recoveryAction: null } });
  expect(JSON.stringify(c.requests[1]!.messages)).toContain("tool_postprocess_failed");
  expect(c.observed.budgetSummary?.unresolvedItems).toContain("scope-call");
});

test("a committed Query and its evidence survive the verified delivery of an actual after-hook error", async () => {
  const c = await deliveryFixture({ query: true, tools: [{ id: "query-original", name: "query_current_devices", arguments: { batchIds: [1] } }], hooks(session) {
    session.agent.afterToolCall = async () => { throw new Error("actual committed Query after failure"); };
  } });
  expect(c.requests).toHaveLength(2);
  expect(c.db.query("SELECT COUNT(*) n FROM queries").get()).toEqual({ n: 1 });
  expect(c.db.query("SELECT COUNT(*) n FROM query_evidence").get()).toEqual({ n: 1 });
  expect(c.record()).toMatchObject({ status: "succeeded", data: { queryId: 1, totalRows: 1 }, sdkDelivery: { isError: true },
    consumptionEvidence: "provider_input_verified", nextModelCallId: c.observed.calls[1]!.callId,
    control: { postflightStatus: "failed", recoveryAction: null } });
  expect(JSON.stringify(c.requests[1]!.messages)).toContain("tool_postprocess_failed");
  expect(c.observed.budgetSummary?.unresolvedItems).toContain("query-original");
  expect(c.db.query("SELECT COUNT(*) n FROM answers").get()).toEqual({ n: 0 });
});

test("another actual SDK API receives its result but has no completions evidence", async () => {
  const c = await deliveryFixture({ api: "openai-responses" });
  expect(c.requests).toHaveLength(2); expect(c.observed.lastOutcome?.error).toBeNull();
  expect(c.requests[1]!.input).toEqual(expect.arrayContaining([expect.objectContaining({ type: "function_call_output", call_id: "scope-call", output: '{"batchIds":[]}' })]));
  expect(c.record().sdkReturned).toBe(true); expect(c.record().nextModelCallId).toBeUndefined(); expect(c.record().consumptionEvidence).toBeUndefined();
});

test("legacy consumed timestamps without a verification tag remain unknown on read and cannot be upgraded", async () => {
  const c = await deliveryFixture({ prepare: "no-callbacks" });
  c.store.recordConsumption(c.context(), c.observed.calls[1]!.callId);
  const json = c.receiptJson();
  expect(c.record().nextModelCallId).toBe(c.observed.calls[1]!.callId); expect(c.record().consumedAt).toBeTruthy();
  expect(c.record().consumptionEvidence).toBeUndefined(); expect(projectToolCall(c.record()).consumptionEvidence).toBeUndefined();
  c.store.recordConsumption(c.context(), c.observed.calls[1]!.callId, "provider_input_verified"); expect(c.receiptJson()).toBe(json);
  c.db.query("UPDATE tool_calls SET delivery_json=? WHERE id=1").run(JSON.stringify({ ...JSON.parse(json), consumptionEvidence: "invalid" }));
  expect(() => c.record()).toThrow("storage_read_failed");
});

test("consumption store rejects missing delivery, nonexistent calls and cross-Run or Session evidence", async () => {
  const c = await deliveryFixture({ prepare: "no-callbacks" }), json = c.receiptJson();
  expect(() => c.store.recordConsumption(c.context(), "nonexistent", "provider_input_verified")).toThrow("state_conflict");
  expect(() => c.store.recordConsumption({ ...c.context(), runId: 999 }, c.observed.calls[1]!.callId, "provider_input_verified")).toThrow("access_denied");
  expect(() => c.store.recordConsumption({ ...c.context(), sessionId: 999 }, c.observed.calls[1]!.callId, "provider_input_verified")).toThrow("access_denied");
  expect(() => c.store.recordConsumption(c.context(), c.observed.calls[0]!.callId, "provider_input_verified")).toThrow("state_conflict");
  expect(() => Reflect.apply(c.store.recordConsumption, c.store, [c.context(), c.observed.calls[1]!.callId, "invalid"])).toThrow("invalid_argument");
  c.db.query("UPDATE tool_calls SET delivery_json=? WHERE id=1").run(JSON.stringify({ ...JSON.parse(json), sdkReturned: false }));
  expect(() => c.store.recordConsumption(c.context(), c.observed.calls[1]!.callId, "provider_input_verified")).toThrow("state_conflict");
  expect(JSON.parse(c.receiptJson()).consumptionEvidence).toBeUndefined();
});

test("actual product native write, bash and powershell receipts are checked against their subsequent HTTP input", async () => {
  const c = await deliveryFixture({ toolTimeoutMs: 2000, tools: [
    { id: "write-proof", name: "write", arguments: { path: "actual-write.txt", content: "actual write effect" } },
    { id: "bash-proof", name: "bash", arguments: { command: "printf 'actual bash output'" } },
    { id: "powershell-proof", name: "powershell", arguments: { command: "Write-Output 'actual powershell output'" } },
  ] });
  expect(c.requests).toHaveLength(2); expect(c.observed.calls).toHaveLength(2);
  expect(await readFile(join(c.root, "runtime", String(c.context().runId), "work", "scratch", "actual-write.txt"), "utf8")).toBe("actual write effect");
  for (const id of ["write-proof", "bash-proof", "powershell-proof"]) {
    const record = c.store.readCall(c.context(id))!;
    expect(record.sdkReturned).toBe(true); expect(record.consumptionEvidence).toBe("provider_input_verified");
    expect(record.nextModelCallId).toBe(c.observed.calls[1]!.callId);
    const text = record.sdkDelivery!.content.map(part => (part as { text: string }).text).join("\n");
    expect(c.requests[1]!.messages).toEqual(expect.arrayContaining([{ role: "tool", tool_call_id: id, content: text }]));
  }
  expect(c.store.readCall(c.context("powershell-proof"))?.status).toBe("succeeded");
  console.info("T05 product-default native shell facts", JSON.stringify(["bash-proof", "powershell-proof"].map(id => {
    const record = c.store.readCall(c.context(id))!; return { name: record.name, status: record.status, isError: record.sdkDelivery?.isError, text: record.sdkDelivery?.content };
  })));
  expect(c.db.query("SELECT COUNT(*) n FROM queries").get()).toEqual({ n: 0 });
}, 15000);

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
async function fixture(mode: Parameters<typeof providerFixture>[0] = "success") {
  const root = await mkdtemp(join(tmpdir(), "medclaw-p4-native-")), provider = providerFixture(mode);
  const db = openDatabase(join(root, "fixture.sqlite")), repo = new Repositories(db), credentials = new InMemoryCredentialStore();
  closes.push(async () => { db.close(); provider.close(); await rm(root, { recursive: true, force: true }); });
  await credentials.modify("p4-fixture", async () => ({ type: "api_key", key: "fixture-only" }));
  const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
  await runtime.installCustom([{ providerId: "p4-fixture", name: "Fixture", api: "openai-completions", baseUrl: provider.url,
    models: [{ id: "fixture", name: "Fixture", input: ["text"], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] }]);
  const adapter = new PiAgentRuntime(runtime, root);
  function create() {
    // Allocate an actual public manager through the existing SDK factory boundary.
    const manager = SessionManager.inMemory(root), factory = spyOn(SessionManager, "inMemory").mockReturnValueOnce(manager);
    let native: ReturnType<PiAgentRuntime["allocate"]>;
    try { native = adapter.allocate(); } finally { factory.mockRestore(); }
    const { session } = repo.createSession({ expectedWorkspaceRevision: repo.readWorkspace().revision }, crypto.randomUUID(), native.nativeSessionId, new Date().toISOString());
    native.bind(session.id); return { ...session, manager };
  }
  async function run(sessionId: number, text: string) {
    const workspace = repo.selectSession({ sessionId, expectedWorkspaceRevision: repo.readWorkspace().revision }, new Date().toISOString());
    const policy = { timeoutMs: 10000, maxRetries: 0 as const, maxRetryDelayMs: 2000 }, model = { provider: "p4-fixture", modelId: "fixture", expectedConfigVersion: "1" };
    const resolved = await runtime.resolve(model, "1", null, policy), agentOptions = adapter.describe(resolved);
    const input: SubmitInput = { sessionId, clientSequence: repo.readSession(sessionId)!.nextSubmissionSequence, text, mode: "send", expectedRevision: workspace.revision,
      expectedBatchIds: [], expectedQueryId: null, model, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" };
    const { runId } = repo.registerAgent({ sessionId, inputId: null, text, model: resolved.selection, policy, goal: "answer", workspace,
      scope: { batchIds: [], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true },
      referenceDate: input.referenceDate, timezone: input.timezone, timeoutMs: policy.timeoutMs, agentOptions,
      submission: { operationRef: crypto.randomUUID(), originalSubmitInput: input }, instanceId: "p4-host", createdAt: new Date().toISOString() });
    const observed = await adapter.execute({ runId, sessionId, text, resolved, agentOptions, signal: new AbortController().signal, deadlineAt: performance.now() + policy.timeoutMs }, {
      startCall: time => new ModelCallRecorder(repo, runId, "main", time), preview: () => {}, nativeTerminal: () => {},
    });
    const endedAt = new Date().toISOString();
    repo.finalizeAgent(runId, { status: observed.lastOutcome?.error ? "failed" : "completed", outputText: observed.lastOutcome?.text ?? null,
      stoppedAt: endedAt, endedAt, error: observed.lastOutcome?.error ?? null, calls: observed.calls,
      cleanup: { contract: "medclaw.run-cleanup/v1", executionStarted: observed.calls.length > 0, stopConfirmed: true,
        requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: true, unconfirmedItems: [], secondaryErrors: [], verifiedAt: endedAt } });
    return runId;
  }
  return { adapter, runtime, provider, repo, db, create, run, root };
}
const read = (sessionId: number, patch = {}) => ReadSessionMessagesInputSchema.parse({ sessionId, ...patch });

test("actual SDK entry objects bind the original Run and preserve same-text identities across Runs", async () => {
  const c = await fixture(), a = c.create(), b = c.create();
  expect("readMessages" in c.adapter).toBe(true);
  const unknown = a.manager.appendMessage({ role: "user", content: "same input", timestamp: 1 });
  const firstRun = await c.run(a.id, "same input"), first = c.adapter.readMessages(read(a.id));
  const secondRun = await c.run(a.id, "same input");
  const before = { leaf: a.manager.getLeafId(), entries: structuredClone(a.manager.getEntries()), workspace: c.repo.readWorkspace(), requests: c.provider.requests.length,
    runs: c.db.query("SELECT COUNT(*) AS count FROM runs").get(), calls: c.db.query("SELECT COUNT(*) AS count FROM model_calls").get() };
  const all = c.adapter.readMessages(read(a.id)), users = all.items.filter(item => item.displayRole === "user"), answers = all.items.filter(item => item.displayRole === "assistant");
  expect(users.map(item => item.runId)).toEqual([null, firstRun, secondRun]);
  expect(users.map(item => item.inputId)).toEqual([null, null, null]);
  expect(new Set(users.map(item => item.nativeEntryId)).size).toBe(3); expect(users[0]?.nativeEntryId).toBe(unknown);
  expect(answers.map(item => item.runId)).toEqual([firstRun, secondRun]);
  expect(answers.map(item => item.text)).toEqual(["你好😀 OK", "你好😀 OK"]);
  expect(new Set(answers.map(item => item.nativeEntryId)).size).toBe(2);
  expect(c.adapter.readMessages(read(b.id))).toMatchObject({ items: [], leafId: null, hasMore: false });
  expect(c.adapter.readMessages(read(a.id, { leafId: first.leafId })).items.filter(item => item.displayRole === "assistant").map(item => item.runId)).toEqual([firstRun]);
  expect(a.manager.getLeafId()).toBe(before.leaf); expect(a.manager.getEntries()).toEqual(before.entries); expect(c.repo.readWorkspace()).toEqual(before.workspace);
  expect(c.provider.requests).toHaveLength(before.requests);
  expect(c.db.query("SELECT COUNT(*) AS count FROM runs").get()).toEqual(before.runs); expect(c.db.query("SELECT COUNT(*) AS count FROM model_calls").get()).toEqual(before.calls);
  a.manager.appendMessage({ role: "user", content: [{ type: "text", text: "visible legacy text", textSignature: "HIDDEN-LEGACY-SIGNATURE" },
    { type: "image", data: "HIDDEN-LEGACY-IMAGE", mimeType: "image/png" }], timestamp: 1 });
  const legacy = c.adapter.read(a.id);
  expect(JSON.stringify(legacy)).not.toContain("HIDDEN-LEGACY");
  expect(legacy.messages.at(-1)).toMatchObject({ text: "visible legacy text", totalChars: 19, truncated: false });
});

test("bounded native text pages preserve full history in the next actual Provider request", async () => {
  const c = await fixture(), a = c.create(); expect("readMessages" in c.adapter).toBe(true);
  const text = "x".repeat(8191) + "😀" + "器械".repeat(1000); await c.run(a.id, text);
  const before = structuredClone(a.manager.getEntries()), page = c.adapter.readMessages(read(a.id, { limit: 1 }));
  const fixedLeaf = page.leafId;
  let cursor = page.nextEntryId, more = page.hasMore, items = [...page.items];
  while (more) { const next = c.adapter.readMessages(read(a.id, { leafId: fixedLeaf, afterEntryId: cursor, limit: 1 })); items.push(...next.items); cursor = next.nextEntryId; more = next.hasMore; }
  expect(items.find(item => item.displayRole === "user")).toMatchObject({ text: "x".repeat(8191), textInfo: { totalChars: text.length, truncated: true, redacted: false } });
  expect(a.manager.getEntries()).toEqual(before); expect(c.provider.requests).toHaveLength(1);
  await c.run(a.id, "follow up");
  expect(JSON.stringify(c.provider.requests[1]?.body.messages)).toContain(text);
  const old = c.adapter.readMessages(read(a.id, { leafId: fixedLeaf }));
  expect(old.items.filter(item => item.displayRole === "user").map(item => item.text)).toEqual(["x".repeat(8191)]);
  expect(c.adapter.read(a.id).messages.filter(item => item.role === "user").map(item => item.text)).toEqual(["x".repeat(8191), "follow up"]);
});

test("native binding absence, identity conflict and unsupported execution stay honest", async () => {
  const c = await fixture("tool"), a = c.create(); expect("readMessages" in c.adapter).toBe(true);
  const restarted = new PiAgentRuntime(c.runtime, c.root);
  expect(() => restarted.readMessages(read(a.id))).toThrow(expect.objectContaining({ code: "resource_unavailable" }));
  const changed = spyOn(a.manager, "getSessionId").mockReturnValue("different-native");
  try { expect(() => c.adapter.readMessages(read(a.id))).toThrow(expect.objectContaining({ code: "session_history_invalid" })); }
  finally { changed.mockRestore(); }
  await c.run(a.id, "unsupported tool");
  expect(() => c.adapter.readMessages(read(a.id))).toThrow(expect.objectContaining({ code: "session_history_invalid" }));
  expect(c.provider.requests).toHaveLength(1);
});

test("message read failure does not return an empty successful page", async () => {
  const c = await fixture(), a = c.create();
  const service = new SessionService("p4-host", c.repo, c.adapter, async () => ({ ok: false, error: safeError("runtime_busy") }), () => null);
  expect("readMessages" in service).toBe(true);
  expect(await service.readMessages(read(999))).toMatchObject({ ok: false, error: { code: "input_invalid", reason: "session_not_found" } });
  expect(await service.readMessages(read(a.id))).toMatchObject({ ok: true, data: { items: [], nativeSessionId: a.nativeSessionId } });
  const restarted = new SessionService("p4-host", c.repo, new PiAgentRuntime(c.runtime, c.root), async () => ({ ok: false, error: safeError("runtime_busy") }), () => null);
  expect(await restarted.readMessages(read(a.id))).toMatchObject({ ok: false, error: { code: "resource_unavailable" } });
  const identity = spyOn(a.manager, "getSessionId").mockReturnValue("wrong-native");
  try { expect(await service.readMessages(read(a.id))).toMatchObject({ ok: false, error: { code: "session_history_invalid" } }); }
  finally { identity.mockRestore(); }
  c.db.exec("DROP TABLE tool_calls");
  a.manager.appendMessage({ role: "user", content: "existing", timestamp: 1 });
  expect(await service.readMessages(read(a.id))).toMatchObject({ ok: false, error: { code: "storage_read_failed" } });
  expect(c.provider.requests).toHaveLength(0);
});

test("submission lookup validates the target before distinguishing an unaccepted sequence", async () => {
  const c = await fixture(), a = c.create(), b = c.create();
  const service = new SessionService("p4-host", c.repo, c.adapter, async () => ({ ok: false, error: safeError("runtime_busy") }), () => null);
  expect(await service.readSubmission({ sessionId: 999, clientSequence: 1 })).toMatchObject({ ok: false, error: { code: "input_invalid", reason: "session_not_found" } });
  expect(await service.readSubmission({ sessionId: a.id, clientSequence: 1 })).toEqual({ ok: true, data: null });
  const runId = await c.run(a.id, "original"); c.repo.selectSession({ sessionId: b.id, expectedWorkspaceRevision: c.repo.readWorkspace().revision }, new Date().toISOString());
  expect(await service.readSubmission({ sessionId: a.id, clientSequence: 1 })).toEqual({ ok: true, data: { sessionId: a.id, clientSequence: 1, inputId: null, runId } });
  expect(c.provider.requests).toHaveLength(1);
});

test("message links use the saved delivery entry and cannot borrow another session query", async () => {
  const c = await fixture(), a = c.create(), b = c.create(), runId = await c.run(a.id, "same"), laterRun = await c.run(a.id, "same"), otherRun = await c.run(b.id, "same");
  const nativeToolCallId = "native:call:identity", message = { role: "toolResult" as const, toolCallId: nativeToolCallId, toolName: "query_current_devices", content: [{ type: "text" as const, text: '{"queryId":99}' }], isError: false, timestamp: 1 };
  const nativeEntryId = a.manager.appendMessage(message), forged = a.manager.appendMessage({ ...message, toolCallId: "forged" });
  const delivery = { contract: "medclaw.tool-delivery/v1", resultRecorded: true, sdkReturned: true, nativeEntryId, deliveredAt: "2026-10-01T00:00:00.000Z", nextModelCallId: null, consumedAt: null, error: null, message };
  const insert = c.db.query("INSERT INTO tool_calls(session_id,run_id,native_tool_call_id,tool_name,tool_version,effect,execution_mode,args_json,status,result_json,delivery_json,requested_at,ended_at) VALUES(?,?,?,'query_current_devices','1','READ','sequential','{}','succeeded','{}',?,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:01.000Z')");
  insert.run(a.id, runId, nativeToolCallId, JSON.stringify(delivery));
  insert.run(b.id, otherRun, nativeToolCallId, JSON.stringify({ ...delivery, nativeEntryId: forged }));
  const params = CurrentQuerySchema.parse({ batchIds: [1] }), hash = createHash("sha256").update(canonicalRequest(params)).digest("hex");
  const savedResult = { scopeDeviceIds: null, rows: [], snapshotIds: [], eventIds: [], warnings: [], calculationVersion: "v1" };
  const query = c.db.query("INSERT INTO queries(session_id,run_id,call_ref,kind,params_hash,params_json,batch_ids_json,result_json,result_hash,created_at) VALUES(?,?,?,'current',?,?,'[1]',?,'result','2026-10-01T00:00:00.000Z')");
  query.run(a.id, runId, `${runId}:${nativeToolCallId}`, hash, JSON.stringify(params), JSON.stringify(savedResult));
  query.run(b.id, otherRun, `${otherRun}:${nativeToolCallId}`, hash, JSON.stringify(params), JSON.stringify(savedResult));
  query.run(a.id, laterRun, `${laterRun}:${nativeToolCallId}`, hash, JSON.stringify(params), JSON.stringify(savedResult));
  c.db.query("INSERT INTO query_evidence(query_id,batch_ids_json,snapshot_ids_json,event_ids_json,source_row_refs_json,filters_json,calculation_version,material_version,source_bundle_id,source_lock_hash,result_hash) VALUES(1,'[1]','[]','[]','[]',?,'v1','','bundle','lock','result')").run(JSON.stringify(params));
  expect("readMessageLinks" in c.repo).toBe(true);
  expect(c.repo.readMessageLinks(a.id, [])).toEqual(new Map());
  expect(c.repo.readMessageLinks(a.id, [forged])).toEqual(new Map());
  expect(c.repo.readMessageLinks(a.id, [nativeEntryId]).get(nativeEntryId)).toEqual({ runId, toolCallRef: nativeToolCallId, references: [`run:${runId}`, "tool:1", "query:1", "evidence:1"] });
  const service = new SessionService("p4-host", c.repo, c.adapter, async () => ({ ok: false, error: safeError("runtime_busy") }), () => null);
  const before = { workspace: c.repo.readWorkspace(), leaf: a.manager.getLeafId(), tools: c.db.query("SELECT * FROM tool_calls").all(), runs: c.db.query("SELECT * FROM runs").all() };
  const result = await service.readMessages(read(a.id)); expect(result.ok).toBe(true);
  if (result.ok) { expect(result.data.items.find(item => item.nativeEntryId === nativeEntryId)).toMatchObject({ runId, references: [`run:${runId}`, "tool:1", "query:1", "evidence:1"] }); expect(result.data.items.find(item => item.nativeEntryId === forged)).toMatchObject({ runId: null, references: [] }); }
  expect(c.repo.readWorkspace()).toEqual(before.workspace); expect(a.manager.getLeafId()).toBe(before.leaf); expect(c.db.query("SELECT * FROM tool_calls").all()).toEqual(before.tools); expect(c.db.query("SELECT * FROM runs").all()).toEqual(before.runs); expect(c.provider.requests).toHaveLength(3);
  c.db.query("UPDATE tool_calls SET delivery_json=? WHERE id=1").run(JSON.stringify({ ...delivery, nativeEntryId: forged }));
  expect(await service.readMessages(read(a.id))).toMatchObject({ ok: false, error: { code: "session_history_invalid" } });
  c.db.query("UPDATE tool_calls SET delivery_json=NULL WHERE id=1").run(); expect(c.repo.readMessageLinks(a.id, [nativeEntryId])).toEqual(new Map());
  for (const invalid of ['[]', '{"sdkReturned":"true","nativeEntryId":1}', 'broken', JSON.stringify({ ...delivery, message: { ...message, toolCallId: "wrong-call" } }), JSON.stringify({ ...delivery, control: {} }), JSON.stringify({ ...delivery, consumptionEvidence: "unverified" })]) {
    c.db.exec("PRAGMA ignore_check_constraints=ON"); c.db.query("UPDATE tool_calls SET delivery_json=? WHERE id=1").run(invalid);
    expect(await service.readMessages(read(a.id))).toMatchObject({ ok: false, error: { code: "storage_read_failed" } });
  }
  expect(c.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("accepted submission reads reject corrupt original request and config JSON as read failures", async () => {
  const c = await fixture(), a = c.create(), runId = await c.run(a.id, "accepted");
  const service = new SessionService("p4-host", c.repo, c.adapter, async () => ({ ok: false, error: safeError("runtime_busy") }), () => null);
  const original = c.db.query<{ config_json: string; submission_request_json: string }, [number]>("SELECT config_json,submission_request_json FROM runs WHERE id=?").get(runId)!;
  c.db.exec("PRAGMA ignore_check_constraints=ON");
  for (const field of ["config_json", "submission_request_json"] as const) {
    c.db.query(`UPDATE runs SET ${field}=? WHERE id=?`).run("corrupt-json", runId);
    expect(await service.readSubmission({ sessionId: a.id, clientSequence: 1 })).toMatchObject({ ok: false, error: { code: "storage_read_failed" } });
    expect(c.db.query(`SELECT ${field} FROM runs WHERE id=?`).get(runId)).toEqual({ [field]: "corrupt-json" });
    c.db.query(`UPDATE runs SET ${field}=? WHERE id=?`).run(original[field], runId);
  }
  expect(c.provider.requests).toHaveLength(1);
});

for (const source of ["user_form", "intent"] as const) test(`message links exclude ${source} queries sharing the native receipt Session Run and call reference`, async () => {
  const c = await fixture(), a = c.create(), runId = await c.run(a.id, "manual query collision");
  const nativeToolCallId = "manual-collision", message = { role: "toolResult" as const, toolCallId: nativeToolCallId, toolName: "bash", content: [{ type: "text" as const, text: '{"queryId":1}' }], isError: false, timestamp: 1 };
  const nativeEntryId = a.manager.appendMessage(message), delivery = { contract: "medclaw.tool-delivery/v1", resultRecorded: true, sdkReturned: true, nativeEntryId, deliveredAt: "2026-10-01T00:00:00.000Z", nextModelCallId: null, consumedAt: null, error: null, message };
  c.db.query("INSERT INTO tool_calls(session_id,run_id,native_tool_call_id,tool_name,tool_version,effect,execution_mode,args_json,status,result_json,delivery_json,requested_at,ended_at) VALUES(?, ?, ?, 'bash','1','READ','sequential','{}','succeeded','{}',?,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:01.000Z')").run(a.id, runId, nativeToolCallId, JSON.stringify(delivery));
  const params = CurrentQuerySchema.parse({ batchIds: [1] }), hash = createHash("sha256").update(canonicalRequest(params)).digest("hex"), result = { source, scopeDeviceIds: null, rows: [], snapshotIds: [], eventIds: [], warnings: [], calculationVersion: "v1" };
  c.db.query("INSERT INTO queries(session_id,run_id,call_ref,source,kind,params_hash,params_json,batch_ids_json,result_json,result_hash,created_at) VALUES(?,?,?,?,'current',?,?,'[1]',?,'result','2026-10-01T00:00:00.000Z')").run(a.id, runId, `${runId}:${nativeToolCallId}`, source, hash, JSON.stringify(params), JSON.stringify(result));
  c.db.query("INSERT INTO query_evidence(query_id,batch_ids_json,snapshot_ids_json,event_ids_json,source_row_refs_json,filters_json,calculation_version,material_version,source_bundle_id,source_lock_hash,result_hash) VALUES(1,'[1]','[]','[]','[]',?,'v1','','bundle','lock','result')").run(JSON.stringify(params));
  const before = { queries: c.db.query("SELECT * FROM queries").all(), evidence: c.db.query("SELECT * FROM query_evidence").all(), tools: c.db.query("SELECT * FROM tool_calls").all(), workspace: c.repo.readWorkspace(), leaf: a.manager.getLeafId() };
  expect(c.repo.readMessageLinks(a.id, [nativeEntryId]).get(nativeEntryId)).toEqual({ runId, toolCallRef: nativeToolCallId, references: [`run:${runId}`, "tool:1"] });
  const service = new SessionService("p4-host", c.repo, c.adapter, async () => ({ ok: false, error: safeError("runtime_busy") }), () => null), page = await service.readMessages(read(a.id));
  expect(page.ok).toBe(true); if (page.ok) expect(page.data.items.find(item => item.nativeEntryId === nativeEntryId)).toMatchObject({ runId, references: [`run:${runId}`, "tool:1"] });
  expect({ queries: c.db.query("SELECT * FROM queries").all(), evidence: c.db.query("SELECT * FROM query_evidence").all(), tools: c.db.query("SELECT * FROM tool_calls").all(), workspace: c.repo.readWorkspace(), leaf: a.manager.getLeafId() }).toEqual(before);
  expect(c.provider.requests).toHaveLength(1);
});

for (const decodedSource of ["user_form", "intent"] as const) test(`message links reject saved agent_tool source with contradictory decoded ${decodedSource} source`, async () => {
  const c = await fixture(), a = c.create(), runId = await c.run(a.id, "inconsistent source");
  const message = { role: "toolResult" as const, toolCallId: "inconsistent-source", toolName: "query_current_devices", content: [{ type: "text" as const, text: "omitted" }], isError: false, timestamp: 1 }, nativeEntryId = a.manager.appendMessage(message);
  const delivery = { contract: "medclaw.tool-delivery/v1", resultRecorded: true, sdkReturned: true, nativeEntryId, deliveredAt: "2026-10-01T00:00:00.000Z", nextModelCallId: null, consumedAt: null, error: null, message };
  c.db.query("INSERT INTO tool_calls(session_id,run_id,native_tool_call_id,tool_name,tool_version,effect,execution_mode,args_json,status,result_json,delivery_json,requested_at,ended_at) VALUES(?,?,'inconsistent-source','query_current_devices','1','READ','sequential','{}','succeeded','{}',?,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:01.000Z')").run(a.id, runId, JSON.stringify(delivery));
  const params = CurrentQuerySchema.parse({ batchIds: [1] }), hash = createHash("sha256").update(canonicalRequest(params)).digest("hex");
  c.db.query("INSERT INTO queries(session_id,run_id,call_ref,source,kind,params_hash,params_json,batch_ids_json,result_json,result_hash,created_at) VALUES(?,?,?,'agent_tool','current',?,?,'[1]',?,'result','2026-10-01T00:00:00.000Z')").run(a.id, runId, `${runId}:inconsistent-source`, hash, JSON.stringify(params), JSON.stringify({ source: decodedSource, scopeDeviceIds: null, rows: [], snapshotIds: [], eventIds: [], warnings: [], calculationVersion: "v1" }));
  const service = new SessionService("p4-host", c.repo, c.adapter, async () => ({ ok: false, error: safeError("runtime_busy") }), () => null);
  expect(await service.readMessages(read(a.id))).toMatchObject({ ok: false, error: { code: "storage_read_failed" } });
  expect(c.provider.requests).toHaveLength(1);
});

test("final enriched escaped-text pages retain the UTF8 budget and exclusive cursor", async () => {
  const c = await fixture(), a = c.create();
  const runId = await c.run(a.id, "budget"), message = { role: "toolResult" as const, toolCallId: "budget-call", toolName: "query_current_devices", content: [{ type: "text" as const, text: "omitted" }], isError: false, timestamp: 1 };
  const nativeEntryId = a.manager.appendMessage(message), delivery = { contract: "medclaw.tool-delivery/v1", resultRecorded: true, sdkReturned: true, nativeEntryId, deliveredAt: "2026-10-01T00:00:00.000Z", nextModelCallId: null, consumedAt: null, error: null, message };
  c.db.query("INSERT INTO tool_calls(session_id,run_id,native_tool_call_id,tool_name,tool_version,effect,execution_mode,args_json,status,result_json,delivery_json,requested_at,ended_at) VALUES(?,?,'budget-call','query_current_devices','1','READ','sequential','{}','succeeded','{}',?,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:01.000Z')").run(a.id, runId, JSON.stringify(delivery));
  const params = CurrentQuerySchema.parse({ batchIds: [1] }), hash = createHash("sha256").update(canonicalRequest(params)).digest("hex");
  c.db.query("INSERT INTO queries(session_id,run_id,call_ref,kind,params_hash,params_json,batch_ids_json,result_json,result_hash,created_at) VALUES(?,?,?,'current',?,?,'[1]',?,'result','2026-10-01T00:00:00.000Z')").run(a.id, runId, `${runId}:budget-call`, hash, JSON.stringify(params), JSON.stringify({ scopeDeviceIds: null, rows: [], snapshotIds: [], eventIds: [], warnings: [], calculationVersion: "v1" }));
  for (let i = 0; i < 14; i++) c.db.query("INSERT INTO query_evidence(query_id,batch_ids_json,snapshot_ids_json,event_ids_json,source_row_refs_json,filters_json,calculation_version,material_version,source_bundle_id,source_lock_hash,result_hash) VALUES(1,'[1]','[]','[]','[]',?,'v1','','bundle','lock','result')").run(JSON.stringify(params));
  for (let i = 0; i < 100; i++) a.manager.appendMessage({ role: "user", content: "\u0001".repeat(8192), timestamp: i });
  const service = new SessionService("p4-host", c.repo, c.adapter, async () => ({ ok: false, error: safeError("runtime_busy") }), () => null);
  expect("readMessages" in service).toBe(true);
  const first = await service.readMessages(read(a.id, { limit: 100 })); expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.data.items.find(item => item.nativeEntryId === nativeEntryId)?.references).toEqual([`run:${runId}`, "tool:1", "query:1", ...Array.from({ length: 13 }, (_, i) => `evidence:${i + 1}`)]);
  expect(SessionMessagePageSchema.safeParse(first.data).success).toBe(true); expect(new TextEncoder().encode(JSON.stringify(first.data)).byteLength).toBeLessThanOrEqual(MAX_MESSAGE_PAGE_BYTES);
  expect(first.data.hasMore).toBe(true); const second = await service.readMessages(read(a.id, { leafId: first.data.leafId, afterEntryId: first.data.nextEntryId, limit: 100 }));
  expect(second.ok).toBe(true); if (second.ok) {
    const items = [...first.data.items, ...second.data.items];
    expect(items.filter(item => item.displayRole === "user")).toHaveLength(101);
    expect(items.filter(item => item.displayRole === "assistant")).toHaveLength(1);
    expect(items.filter(item => item.displayRole === "tool_result")).toHaveLength(1);
    expect(new Set(items.map(item => item.nativeEntryId)).size).toBe(items.length);
    expect(second.data.hasMore).toBe(false);
  }
});

test("tool projection omits arbitrary payloads and uses only recorded native truncation facts", async () => {
  const module = await import("../../packages/runtime-pi/src/messages"); expect("projectToolCall" in module).toBe(true);
  const record: ToolCallRecord = { id: 1, sessionId: 1, runId: 1, nativeToolCallId: "call", name: "read", version: "1", executionMode: "sequential", input: { path: "SECRET-PATH" }, status: "succeeded", data: { details: { truncation: { truncated: true, content: "SECRET-CONTENT" }, fullOutputPath: "SECRET-PATH" } }, error: null, sdkReturned: true, nativeEntryId: "entry", consumptionEvidence: "provider_input_verified", sdkDelivery: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "SECRET-SDK" }], isError: false, timestamp: 1 } };
  const before = structuredClone(record);
  for (const [name, details, wanted, limit] of [
    ["read", { truncation: { truncated: true } }, true, false], ["bash", { truncation: { truncated: false } }, false, false],
    ["grep", { linesTruncated: true, truncation: { truncated: false } }, true, false], ["grep", { matchLimitReached: 10 }, null, true],
    ["find", { resultLimitReached: 10 }, null, true], ["ls", { entryLimitReached: 10 }, null, true], ["read", { matchLimitReached: 10 }, null, false],
    ["grep", { matchLimitReached: -1 }, null, false], ["read", { nativeError: "exit 3 SECRET" }, null, false], ["query_current_devices", { truncation: { truncated: true } }, null, false],
  ] as const) {
    const view = module.projectToolCall({ ...record, name, data: { details } });
    expect(view.nativeOutputTruncated).toBe(wanted); expect(view.truncated).toBe(false); expect(view.resultPreview.includes("SDK result limit reached")).toBe(limit);
    expect(JSON.stringify(view)).not.toContain("SECRET"); expect(view.consumptionEvidence).toBe("provider_input_verified");
    if (name !== "query_current_devices") { expect(view.inputPreview).toBe("Native tool arguments omitted"); expect(view.resultPreview.startsWith("Native tool output omitted; read saved execution facts")).toBe(true); }
  }
  expect(record).toEqual(before);
  const control = { ...createToolControlObservation(), environmentKey: "SECRET-ENV", workloadBucket: "SECRET-WORKLOAD", timeoutRequestedAt: "2026-10-01T00:00:00.000Z", stopLagMs: 25 };
  const stopped = module.projectToolCall({ ...record, stoppedAt: "2026-10-01T00:00:01.000Z", control, error: { ...safeError("tool_timeout"), message: "SECRET-ERROR" } });
  expect(stopped).toMatchObject({ stoppedAt: "2026-10-01T00:00:01.000Z", nativeOutputTruncated: true, control: { timeoutRequestedAt: "2026-10-01T00:00:00.000Z", stopLagMs: 25, environmentKey: null, workloadBucket: null }, error: { code: "tool_timeout" } });
  expect(JSON.stringify(stopped)).not.toContain("SECRET");
});
