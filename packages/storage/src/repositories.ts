import type { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, safeError, type AppError } from "../../contracts/src/error";
import { NewSessionInputSchema, NewSessionResultSchema, SelectSessionInputSchema, SessionViewSchema, ListSessionsRequestSchema, SubmitInputSchema, ReadSubmissionRequestSchema,
  type NewSessionInput, type NewSessionResult, type SelectSessionInput, type SessionView, type SessionPage, type ReadSubmissionRequest, type SubmitResult } from "../../contracts/src/session";
import { WorkspaceViewSchema, type WorkspaceView } from "../../contracts/src/workspace";
import {
  DiagnoseRequestSchema, ModelSelectionSchema, ProviderRequestSchema, RequestPolicySchema,
  type ProviderAccepted, type ProviderRequest,
} from "../../contracts/src/model";
import {
  ModelCallViewSchema, ReadRunRequestSchema, RunViewSchema, RecentRunViewSchema, RunCleanupRecordSchema, P2AgentOptionsSchema, canonicalRequest, sliceOutput, sliceText, safePreview,
  type ModelCallView, type ReadRunResult, type RunView, type RegisterProviderInput,
  type ProviderOperation, type FinalProviderFact, type ProviderRunStore, type RegisterAgentInput, type FinalAgentFact, type StoredOperation, type RunCleanupRecord,
} from "../../contracts/src/run";
export type { RegisterProviderInput, ProviderOperation, FinalCallFact, FinalProviderFact } from "../../contracts/src/run";
const usageSchema = z.object({
  source: z.string().max(100).nullable().optional(),
  unavailableReason: z.string().max(200).nullable().optional(),
  cacheRead: z.number().int().nonnegative().safe().nullable().optional(),
  cacheWrite: z.number().int().nonnegative().safe().nullable().optional(),
  cacheWrite1h: z.number().int().nonnegative().safe().nullable().optional(),
  reasoning: z.number().int().nonnegative().safe().nullable().optional(),
  totalTokens: z.number().int().nonnegative().safe().nullable().optional(),
  costSource: z.string().max(100).nullable().optional(),
}).strict();
const cleanupSchema = z.object({
  oldProcessExited: z.boolean().optional(), observationGap: z.boolean().optional(),
  previousInstanceId: z.string().max(512).optional(), errors: z.array(AppErrorSchema).max(10).optional(),
}).strict();

const providerConfigSchema = z.object({
  providerRequest: z.discriminatedUnion("method", [
    z.object({ operationRef: z.string().min(1).max(512), method: z.literal("model.request"), originalRequest: ProviderRequestSchema }).strict(),
    z.object({ operationRef: z.string().min(1).max(512), method: z.literal("model.diagnose"), originalRequest: DiagnoseRequestSchema }).strict(),
  ]),
  selection: ModelSelectionSchema, policy: RequestPolicySchema,
}).strict();
const agentConfigSchema = z.strictObject({ selection: ModelSelectionSchema, policy: RequestPolicySchema,
  referenceDate: z.string(), timezone: z.string(), agent: P2AgentOptionsSchema.extend({ stage: z.literal("P2"), nativeSessionId: OpaqueIdSchema,
    tools: z.tuple([]), autoCompaction: z.literal(false), autoRetry: z.literal(false), cacheWarming: z.literal("off") }) });
const commonConfigSchema = z.object({ selection: ModelSelectionSchema, policy: RequestPolicySchema });
const scope = { batchIds: [], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true };
type RunRow = {
  kind: "provider" | "agent"; session_id: number | null; submission_operation_ref: string | null;
  submission_client_sequence: number | null; submission_request_json: string | null;
  id: number; instance_id: string; status: RunView["status"]; goal: "answer" | "verify";
  input_text: string; output_text: string | null; config_json: string; prior_run_id: number | null;
  reference_date: string; timezone: string; created_at: string; started_at: string | null;
  cancel_requested_at: string | null; stopped_at: string | null; ended_at: string | null;
  error_json: string | null; cleanup_json: string | null; usage_json: string | null;
};
type CallRow = {
  id: number; call_id: string; kind: "main" | "diagnostic"; model_json: string;
  granularity: string; attempt: number; attempt_count_unknown: number;
  state: ModelCallView["state"]; started_at: string; ended_at: string | null; duration_ms: number | null;
  input_tokens: number | null; output_tokens: number | null; cost: number | null;
  cost_currency: string | null; usage_source: string | null; unavailable_reason: string | null; error_json: string | null;
};
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function checked<T>(schema: z.ZodType<T>, value: unknown, code = "invalid_argument"): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : fail(code);
}
function json(value: unknown): string | null { return value == null ? null : JSON.stringify(value); }
function decoded(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return fail("storage_write_failed"); }
}
function id(value: number) { if (!Number.isSafeInteger(value) || value <= 0) fail("invalid_argument"); }
function timestamp(value: string | null) {
  if (value !== null && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) fail("invalid_argument");
}

export class Repositories implements ProviderRunStore {
  constructor(private readonly db: Database, private readonly beforeCommit?: () => void) {}

  private row(runId: number): RunRow | null {
    return this.db.query<RunRow, [number]>("SELECT * FROM runs WHERE id=?").get(runId);
  }
  private config(row: RunRow) { return checked(commonConfigSchema, decoded(row.config_json), "storage_read_failed"); }
  private providerConfig(row: RunRow) { return checked(providerConfigSchema, decoded(row.config_json), "storage_read_failed"); }
  private calls(runId: number): ModelCallView[] {
    return this.db.query<CallRow, [number]>("SELECT * FROM model_calls WHERE run_id=? ORDER BY id").all(runId).map((row) => {
      const model = checked(z.object({
        selection: ModelSelectionSchema, responseModel: z.string().nullable(),
        sdkStopReason: z.enum(["stop", "length", "toolUse", "error", "aborted", "deferred"]).nullable(),
      }).strict(), decoded(row.model_json), "storage_write_failed");
      return checked(ModelCallViewSchema, {
        id: row.id, callId: row.call_id, kind: row.kind, state: row.state,
        granularity: row.granularity, attempt: row.attempt, attemptCountUnknown: row.attempt_count_unknown === 1,
        model: model.selection, responseModel: model.responseModel, sdkStopReason: model.sdkStopReason,
        startedAt: row.started_at, endedAt: row.ended_at, durationMs: row.duration_ms,
        inputTokens: row.input_tokens, outputTokens: row.output_tokens, cost: row.cost, costCurrency: row.cost_currency,
        usageSource: row.usage_source, unavailableReason: row.unavailable_reason, error: decoded(row.error_json),
      }, "storage_write_failed");
    });
  }
  private view(row: RunRow, offset = 0, limit = 16_384, inputOffset = 0, inputLimit = 65536, callOffset = 0, callLimit = 20): RunView {
    const config = this.config(row);
    const text = row.output_text ?? "";
    let output: RunView["output"];
    try { output = sliceOutput(text, offset, limit); } catch { return fail("invalid_argument"); }
    let inputPage: RunView["inputPage"];
    try { inputPage = sliceText(row.input_text, inputOffset, inputLimit, 65536); } catch { return fail("invalid_argument"); }
    const cleanup = RunCleanupRecordSchema.safeParse(decoded(row.cleanup_json));
    const calls = this.calls(row.id);
    if (callOffset > calls.length) fail("invalid_argument");
    const agent = row.kind === "agent" ? checked(agentConfigSchema, decoded(row.config_json), "storage_read_failed") : null;
    return checked(RunViewSchema, {
      id: row.id, kind: row.kind, status: row.status, operationRef: row.kind === "provider" ? this.providerConfig(row).providerRequest.operationRef : row.submission_operation_ref,
      instanceId: row.instance_id, sessionId: row.session_id, inputId: null, goal: row.goal, inputText: inputPage.text, inputPage,
      model: config.selection, policy: config.policy, priorRunId: row.prior_run_id,
      referenceDate: row.reference_date, timezone: row.timezone, createdAt: row.created_at,
      startedAt: row.started_at, cancelRequestedAt: row.cancel_requested_at, stoppedAt: row.stopped_at,
      endedAt: row.ended_at, error: decoded(row.error_json), cleanup: cleanup.success ? cleanup.data : null, answerRef: null,
      output,
      calls: row.kind === "provider" ? calls : calls.slice(callOffset, callOffset + callLimit), persistence: "committed",
      ...(agent ? { clientSequence: row.submission_client_sequence, nativeSessionId: agent.agent.nativeSessionId,
        nextCallOffset: callOffset + callLimit < calls.length ? callOffset + callLimit : null } : {}),
    }, "storage_read_failed");
  }

  findProviderOperation(operationRef: string): ProviderOperation | null {
    const row = this.db.query<RunRow, [string]>(
      "SELECT * FROM runs WHERE kind='provider' AND json_extract(config_json,'$.providerRequest.operationRef')=?",
    ).get(operationRef);
    if (!row) return null;
    const request = this.providerConfig(row).providerRequest;
    return { runId: row.id, operationRef: request.operationRef, method: request.method, originalRequest: request.originalRequest, run: this.view(row) };
  }

  findOperation(operationRef: string): StoredOperation | null {
    checked(OpaqueIdSchema, operationRef);
    const created = this.db.query<{ creation_request_json: string; creation_result_json: string }, [string]>(
      "SELECT creation_request_json,creation_result_json FROM sessions WHERE creation_operation_ref=?").get(operationRef);
    if (created) return { method: "session.create", operationRef,
      originalRequest: checked(NewSessionInputSchema, decoded(created.creation_request_json), "storage_read_failed"),
      result: checked(NewSessionResultSchema, decoded(created.creation_result_json), "storage_read_failed") };
    const submitted = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE submission_operation_ref=?").get(operationRef);
    if (submitted) return { method: "session.submit", operationRef,
      originalRequest: checked(SubmitInputSchema, decoded(submitted.submission_request_json), "storage_read_failed"), result: this.submissionResult(submitted) };
    return this.findProviderOperation(operationRef);
  }

  readWorkspace(): WorkspaceView {
    const row = this.db.query<{ active_session_id: number | null; revision: number }, []>("SELECT active_session_id,revision FROM workspace WHERE id=1").get();
    if (!row) fail("storage_read_failed");
    return checked(WorkspaceViewSchema, { revision: row.revision, sessionId: row.active_session_id, materialVersion: null,
      batchRefs: [], deviceIds: [], queryId: null, activeView: "data", selection: null }, "storage_read_failed");
  }

  readSession(sessionId: number): SessionView | null {
    id(sessionId);
    const row = this.db.query<{ id: number; native_session_id: string; title: string; kind: string; status: string; storage_version: number }, [number]>("SELECT * FROM sessions WHERE id=?").get(sessionId);
    if (!row) return null;
    const sequence = this.db.query<{ n: number | null }, [number]>("SELECT MAX(submission_client_sequence) AS n FROM runs WHERE session_id=?").get(sessionId)?.n ?? 0;
    return checked(SessionViewSchema, { id: row.id, title: row.title, nativeSessionId: row.native_session_id, kind: row.kind, status: row.status,
      storageVersion: row.storage_version, leafId: null, nextSubmissionSequence: sequence + 1 }, "storage_read_failed");
  }

  listSessions(input: { beforeSessionId?: number; limit?: number }): SessionPage {
    const request = checked(ListSessionsRequestSchema, input);
    const rows = this.db.query<{ id: number }, [number, number]>("SELECT id FROM sessions WHERE id<? ORDER BY id DESC LIMIT ?")
      .all(request.beforeSessionId ?? Number.MAX_SAFE_INTEGER, request.limit + 1), page = rows.slice(0, request.limit);
    return { sessions: page.map(row => this.readSession(row.id)!), nextBeforeSessionId: rows.length > request.limit ? page.at(-1)!.id : null };
  }

  createSession(input: NewSessionInput, operationRef: string, nativeSessionId: string, time: string): NewSessionResult {
    const request = checked(NewSessionInputSchema, input); checked(OpaqueIdSchema, operationRef); checked(OpaqueIdSchema, nativeSessionId); timestamp(time);
    return this.db.transaction(() => {
      const existing = this.findOperation(operationRef);
      if (existing) {
        if (existing.method !== "session.create" || canonicalRequest(existing.originalRequest) !== canonicalRequest(request)) fail("state_conflict");
        return existing.result;
      }
      const workspace = this.readWorkspace();
      if (workspace.revision !== request.expectedWorkspaceRevision) fail("workspace_revision_mismatch");
      const sessionId = (this.db.query<{ n: number | null }, []>("SELECT MAX(id) AS n FROM sessions").get()?.n ?? 0) + 1;
      checked(PositiveIdSchema, sessionId);
      const result = checked(NewSessionResultSchema, { session: { id: sessionId, title: `新会话 ${sessionId}`, nativeSessionId,
        kind: "user", status: "active", storageVersion: 0, leafId: null, nextSubmissionSequence: 1 },
        workspace: { ...workspace, sessionId, revision: workspace.revision + 1 } });
      this.db.query(`INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(sessionId, nativeSessionId, operationRef, canonicalRequest(request), JSON.stringify(result), result.session.title, time, time);
      this.db.query("UPDATE workspace SET active_session_id=?,revision=?,updated_at=? WHERE id=1 AND revision=?")
        .run(sessionId, result.workspace.revision, time, workspace.revision);
      this.beforeCommit?.();
      return result;
    }).immediate();
  }

  selectSession(input: SelectSessionInput, time: string): WorkspaceView {
    const request = checked(SelectSessionInputSchema, input); timestamp(time);
    return this.db.transaction(() => {
      const workspace = this.readWorkspace();
      if (workspace.revision !== request.expectedWorkspaceRevision) fail("workspace_revision_mismatch");
      if (!this.readSession(request.sessionId)) fail("session_not_found");
      if (workspace.sessionId === request.sessionId) return workspace;
      const selected = checked(WorkspaceViewSchema, { ...workspace, sessionId: request.sessionId, revision: workspace.revision + 1 });
      this.db.query("UPDATE workspace SET active_session_id=?,revision=?,updated_at=? WHERE id=1 AND revision=?")
        .run(request.sessionId, selected.revision, time, workspace.revision);
      this.beforeCommit?.();
      return selected;
    }).immediate();
  }

  private submissionResult(row: RunRow): SubmitResult {
    if (row.kind !== "agent" || row.session_id === null || row.submission_client_sequence === null) fail("storage_read_failed");
    return { sessionId: row.session_id, clientSequence: row.submission_client_sequence, inputId: null, runId: row.id };
  }

  findSubmission(input: ReadSubmissionRequest): SubmitResult | null {
    const request = checked(ReadSubmissionRequestSchema, input);
    const row = this.db.query<RunRow, [number, number]>("SELECT * FROM runs WHERE session_id=? AND submission_client_sequence=?").get(request.sessionId, request.clientSequence);
    return row ? this.submissionResult(row) : null;
  }

  registerAgent(input: RegisterAgentInput): SubmitResult {
    const request = checked(SubmitInputSchema, input.submission.originalSubmitInput), operationRef = checked(OpaqueIdSchema, input.submission.operationRef); timestamp(input.createdAt);
    return this.db.transaction(() => {
      const operation = this.findOperation(operationRef), sequence = this.findSubmission({ sessionId: request.sessionId, clientSequence: request.clientSequence });
      if (operation || sequence) {
        if (!operation || operation.method !== "session.submit" || !sequence || operation.result.runId !== sequence.runId
          || canonicalRequest(operation.originalRequest) !== canonicalRequest(request)) fail("state_conflict");
        return sequence;
      }
      const session = this.readSession(request.sessionId);
      if (!session) fail("session_not_found");
      if (request.clientSequence < session.nextSubmissionSequence || request.clientSequence === Number.MAX_SAFE_INTEGER) fail("state_conflict");
      const workspace = this.readWorkspace();
      if (workspace.sessionId !== session.id || workspace.revision !== request.expectedRevision || !isDeepStrictEqual(workspace, input.workspace)) fail("workspace_revision_mismatch");
      if (this.active()) fail("runtime_busy");
      if (input.sessionId !== session.id || input.inputId !== null || input.goal !== "answer" || input.text !== request.text
        || input.referenceDate !== request.referenceDate || input.timezone !== request.timezone || input.timeoutMs !== input.policy.timeoutMs
        || !isDeepStrictEqual(scope, input.scope) || input.model.provider !== request.model.provider
        || input.model.modelId !== request.model.modelId || input.model.configVersion !== request.model.expectedConfigVersion) fail("invalid_argument");
      checked(OpaqueIdSchema, input.instanceId);
      const config = checked(agentConfigSchema, { selection: input.model, policy: input.policy, referenceDate: request.referenceDate,
        timezone: request.timezone, agent: { ...input.agentOptions, stage: "P2", nativeSessionId: session.nativeSessionId, tools: [],
          autoCompaction: false, autoRetry: false, cacheWarming: "off" } });
      const result = this.db.query(`INSERT INTO runs(session_id,input_id,kind,instance_id,submission_operation_ref,submission_client_sequence,
        submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at)
        VALUES(?,NULL,'agent',?,?,?,?,'created','answer',?,?,?,?,?,?,?)`)
        .run(session.id, input.instanceId, operationRef, request.clientSequence, canonicalRequest(request), request.text, JSON.stringify(config),
          JSON.stringify(scope), JSON.stringify(workspace), request.referenceDate, request.timezone, input.createdAt);
      this.beforeCommit?.();
      return { sessionId: session.id, clientSequence: request.clientSequence, inputId: null, runId: Number(result.lastInsertRowid) };
    }).immediate();
  }

  registerProvider(input: RegisterProviderInput): ProviderAccepted {
    const originalRequest = input.method === "model.request" ? checked(ProviderRequestSchema, input.originalRequest) : checked(DiagnoseRequestSchema, input.originalRequest);
    if (!input.operationRef || input.operationRef.length > 512) fail("invalid_argument");
    return this.db.transaction(() => {
      const operation = this.findOperation(input.operationRef);
      if (operation && operation.method !== input.method) fail("state_conflict");
      const existing = this.findProviderOperation(input.operationRef);
      if (existing) {
        if (existing.method !== input.method || !isDeepStrictEqual(
          decoded(JSON.stringify(existing.originalRequest)), decoded(JSON.stringify(originalRequest)),
        )) fail("state_conflict");
        return { runId: existing.runId, operationRef: input.operationRef, reused: true };
      }
      if (this.active()) fail("runtime_busy");
      timestamp(input.createdAt);
      if (!input.instanceId || input.instanceId.length > 512 || input.referenceDate !== originalRequest.referenceDate ||
          input.timezone !== originalRequest.timezone || input.priorRunId !== originalRequest.priorRunId ||
          input.goal !== (input.method === "model.request" ? "answer" : "verify") ||
          input.inputText !== (input.method === "model.request" ? (originalRequest as ProviderRequest).text : "请仅回复 OK。")) fail("invalid_argument");
      if (input.priorRunId !== undefined) { id(input.priorRunId); if (!this.row(input.priorRunId)) fail("invalid_argument"); }
      const config = checked(providerConfigSchema, { providerRequest: { operationRef: input.operationRef, method: input.method, originalRequest }, selection: input.selection, policy: input.policy });
      const result = this.db.query(`INSERT INTO runs(
        session_id,input_id,kind,prior_run_id,instance_id,status,goal,input_text,output_text,config_json,
        scope_json,workspace_json,reference_date,timezone,error_json,created_at,started_at,
        cancel_requested_at,stopped_at,ended_at,cleanup_json,usage_json
      ) VALUES(NULL,NULL,'provider',?,?,'created',?,?,NULL,?,?,NULL,?,?,NULL,?,NULL,NULL,NULL,NULL,NULL,NULL)`)
        .run(input.priorRunId ?? null, input.instanceId, input.goal, input.inputText, JSON.stringify(config), JSON.stringify(scope), input.referenceDate, input.timezone, input.createdAt);
      this.beforeCommit?.();
      return { runId: Number(result.lastInsertRowid), operationRef: input.operationRef, reused: false };
    }).immediate();
  }

  startCall(runId: number, callId: string, kind: "main" | "diagnostic", time: string): void {
    id(runId); timestamp(time);
    if (!callId || callId.length > 512) fail("invalid_argument");
    this.db.transaction(() => {
      const row = this.row(runId);
      if (!row || row.status !== "created" && !(row.kind === "agent" && row.status === "running")) fail("state_conflict");
      if (row.kind === "provider" && this.calls(runId).length) fail("state_conflict");
      if (kind !== (row.goal === "verify" ? "diagnostic" : "main")) fail("invalid_argument");
      if (row.status === "created") {
        const changed = this.db.query("UPDATE runs SET status='running',started_at=? WHERE id=? AND status='created'").run(time, runId);
        if (changed.changes !== 1) fail("state_conflict");
      }
      this.db.query(`INSERT INTO model_calls(call_id,run_id,session_id,input_id,kind,attempt,granularity,
        attempt_count_unknown,model_json,state,started_at,ended_at,duration_ms,input_tokens,output_tokens,
        cost,cost_currency,usage_source,unavailable_reason,error_json)
        VALUES(?,?,?,NULL,?,1,'logical_request',1,?,'started',?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`)
        .run(callId, runId, row.session_id, kind, JSON.stringify({ selection: this.config(row).selection, responseModel: null, sdkStopReason: null }), time);
      this.beforeCommit?.();
    }).immediate();
  }

  requestCancel(runId: number, time: string): boolean {
    id(runId); timestamp(time);
    return this.db.transaction(() => {
      if (!this.row(runId)) fail("state_conflict");
      const result = this.db.query(`UPDATE runs SET cancel_requested_at=COALESCE(cancel_requested_at,?)
        WHERE id=? AND status IN ('created','running')`).run(time, runId);
      if (result.changes) this.beforeCommit?.();
      return result.changes > 0;
    }).immediate();
  }

  finalizeProvider(runId: number, fact: FinalProviderFact): RunView {
    return this.finalize(runId, fact, fact.call ? [fact.call] : [], "provider");
  }
  finalizeAgent(runId: number, fact: FinalAgentFact): RunView {
    return this.finalize(runId, fact, fact.calls, "agent");
  }
  private validateCleanup(previous: unknown, input: RunCleanupRecord): RunCleanupRecord {
    const next = checked(RunCleanupRecordSchema, input), old = RunCleanupRecordSchema.safeParse(previous);
    if (old.success) {
      for (const key of ["executionStarted", "stopConfirmed", "requiredPersistenceComplete", "inputsSettled", "resourcesReleased"] as const) {
        if (old.data[key] === true && next[key] !== true || key === "executionStarted" && old.data[key] === false && next[key] !== false) fail("state_conflict");
      }
      if (old.data.verifiedAt && (!next.verifiedAt || Date.parse(next.verifiedAt) < Date.parse(old.data.verifiedAt))) fail("state_conflict");
      if (old.data.secondaryErrors.some(error => !next.secondaryErrors.some(item => isDeepStrictEqual(item, error)))) fail("state_conflict");
    }
    return next;
  }
  private finalize(runId: number, fact: FinalProviderFact, finalCalls: import("../../contracts/src/run").FinalCallFact[], kind: "provider" | "agent"): RunView {
    id(runId); timestamp(fact.endedAt); timestamp(fact.stoppedAt); timestamp(fact.cancelRequestedAt ?? null);
    if (!["completed", "failed", "cancelled"].includes(fact.status)) fail("invalid_argument");
    checked(z.string().nullable(), fact.outputText);
    const error = fact.error === null ? null : checked(AppErrorSchema, fact.error);
    const cleanup = fact.cleanup == null ? null : checked(z.union([cleanupSchema, RunCleanupRecordSchema]), fact.cleanup);
    const usage = fact.usage == null ? null : checked(usageSchema, fact.usage);
    return this.db.transaction(() => {
      const row = this.row(runId);
      if (!row || row.kind !== kind) fail("state_conflict");
      const calls = this.calls(runId);
      if (calls.length !== finalCalls.length || new Set(finalCalls.map(call => call.callId)).size !== finalCalls.length) fail("state_conflict");
      const cancelRequestedAt = fact.cancelRequestedAt ?? row.cancel_requested_at;
      if (fact.cancelRequestedAt && row.cancel_requested_at && fact.cancelRequestedAt !== row.cancel_requested_at) fail("state_conflict");
      if (fact.status === "cancelled" && !cancelRequestedAt || fact.status === "completed" && !calls.length) fail("invalid_argument");
      const terminal = row.status !== "created" && row.status !== "running";
      if (terminal && (row.status !== fact.status || row.output_text !== null && row.output_text !== fact.outputText
        || row.stopped_at !== null && row.stopped_at !== fact.stoppedAt || !isDeepStrictEqual(decoded(row.error_json), error)
        || row.usage_json !== null && !isDeepStrictEqual(decoded(row.usage_json), usage))) fail("state_conflict");
      if (cleanup && "contract" in cleanup) this.validateCleanup(decoded(row.cleanup_json), cleanup);
      else if (terminal && !isDeepStrictEqual(decoded(row.cleanup_json), cleanup)) fail("state_conflict");
      for (const original of calls) {
        const incoming = finalCalls.find(call => call.callId === original.callId);
        if (!incoming) fail("state_conflict");
        const finalCall = checked(ModelCallViewSchema, { ...original, ...incoming });
        if (finalCall.state === "started") fail("invalid_argument");
        if (original.state !== "started") {
          if (!isDeepStrictEqual(original, finalCall)) fail("state_conflict");
          continue;
        }
        const result = this.db.query(`UPDATE model_calls SET state=?,model_json=?,ended_at=?,duration_ms=?,input_tokens=?,
          output_tokens=?,cost=?,cost_currency=?,usage_source=?,unavailable_reason=?,error_json=? WHERE run_id=? AND call_id=? AND state='started'`)
          .run(finalCall.state, JSON.stringify({ selection: original.model, responseModel: finalCall.responseModel, sdkStopReason: finalCall.sdkStopReason }),
            finalCall.endedAt, finalCall.durationMs, finalCall.inputTokens, finalCall.outputTokens, finalCall.cost, finalCall.costCurrency,
            finalCall.usageSource, finalCall.unavailableReason, json(finalCall.error), runId, finalCall.callId);
        if (result.changes !== 1) fail("state_conflict");
      }
      this.db.query(`UPDATE runs SET status=?,output_text=?,stopped_at=COALESCE(stopped_at,?),ended_at=COALESCE(ended_at,?),cancel_requested_at=?,
        error_json=?,cleanup_json=?,usage_json=? WHERE id=?`)
        .run(terminal ? row.status : fact.status, row.output_text ?? fact.outputText, fact.stoppedAt, fact.endedAt, cancelRequestedAt,
          terminal ? row.error_json : json(error), json(cleanup), row.usage_json ?? json(usage), runId);
      const run = this.view(this.row(runId)!);
      this.beforeCommit?.();
      return run;
    }).immediate();
  }

  /** Read-only proof after a COMMIT whose return was lost; compare full facts, not paged previews. */
  isFinalSaved(runId: number, fact: FinalProviderFact | FinalAgentFact): boolean {
    id(runId);
    const row = this.row(runId);
    if (!row || row.kind !== ("calls" in fact ? "agent" : "provider") || row.status !== fact.status
      || row.output_text !== fact.outputText || row.stopped_at !== fact.stoppedAt || row.ended_at !== fact.endedAt
      || row.cancel_requested_at !== (fact.cancelRequestedAt ?? null) || !isDeepStrictEqual(decoded(row.error_json), fact.error)
      || !isDeepStrictEqual(decoded(row.usage_json), fact.usage ?? null) || !isDeepStrictEqual(decoded(row.cleanup_json), fact.cleanup ?? null)) return false;
    const saved = this.calls(runId), expected = "calls" in fact ? fact.calls : fact.call ? [fact.call] : [];
    return saved.length === expected.length && expected.every(call => {
      const original = saved.find(item => item.callId === call.callId);
      return original !== undefined && Object.entries(call).every(([key, value]) => isDeepStrictEqual(original[key as keyof ModelCallView], value));
    });
  }

  checkpointFailure(runId: number, error: AppError, cleanup: RunCleanupRecord, time: string): void {
    id(runId); timestamp(time); checked(AppErrorSchema, error);
    this.db.transaction(() => {
      const row = this.row(runId);
      if (!row) fail("run_not_found");
      const terminal = row.status !== "created" && row.status !== "running";
      if (terminal && (row.status !== "failed" || !isDeepStrictEqual(decoded(row.error_json), error))) fail("state_conflict");
      this.validateCleanup(decoded(row.cleanup_json), cleanup);
      this.db.query("UPDATE runs SET status='failed',error_json=?,ended_at=COALESCE(ended_at,?),cleanup_json=? WHERE id=?")
        .run(json(error), time, json(cleanup), runId);
      this.beforeCommit?.();
    }).immediate();
  }

  saveRunCleanup(runId: number, cleanup: RunCleanupRecord): void {
    id(runId);
    this.db.transaction(() => {
      const row = this.row(runId);
      if (!row) fail("run_not_found");
      const checkedCleanup = this.validateCleanup(decoded(row.cleanup_json), cleanup);
      this.db.query("UPDATE runs SET cleanup_json=? WHERE id=?").run(json(checkedCleanup), runId);
      this.beforeCommit?.();
    }).immediate();
  }

  recoveryCandidates(instanceId: string): RunView[] {
    checked(OpaqueIdSchema, instanceId);
    return this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE instance_id<>? ORDER BY id").all(instanceId).flatMap(row => {
      const cleanup = RunCleanupRecordSchema.safeParse(decoded(row.cleanup_json));
      const released = cleanup.success && (cleanup.data.executionStarted === false || cleanup.data.stopConfirmed === true)
        && cleanup.data.requiredPersistenceComplete === true && cleanup.data.inputsSettled === true
        && cleanup.data.resourcesReleased === true && cleanup.data.unconfirmedItems.length === 0;
      return row.status === "created" || row.status === "running" || !released ? [this.view(row)] : [];
    });
  }

  read(request: z.input<typeof ReadRunRequestSchema>): ReadRunResult {
    const input = checked(ReadRunRequestSchema, request);
    if ("recent" in input) {
      const rows = this.db.query<RunRow, [number, number | null, number | null, string | null, string | null, number]>(
        "SELECT * FROM runs WHERE id<? AND (? IS NULL OR session_id=?) AND (? IS NULL OR kind=?) ORDER BY id DESC LIMIT ?",
      ).all(input.beforeRunId ?? Number.MAX_SAFE_INTEGER, input.sessionId ?? null, input.sessionId ?? null, input.kind ?? null, input.kind ?? null, input.limit + 1);
      const page = rows.slice(0, input.limit);
      return { kind: "recent", runs: page.map((row) => {
        const { output, calls, inputPage, cleanup, ...summary } = this.view(row);
        const cleanupSummary = cleanup ? { executionStarted: cleanup.executionStarted, stopConfirmed: cleanup.stopConfirmed,
          requiredPersistenceComplete: cleanup.requiredPersistenceComplete, inputsSettled: cleanup.inputsSettled,
          resourcesReleased: cleanup.resourcesReleased, unconfirmedCount: cleanup.unconfirmedItems.length,
          secondaryErrorCount: cleanup.secondaryErrors.length, verifiedAt: cleanup.verifiedAt } : null;
        if ("nextCallOffset" in summary) { const { nextCallOffset, ...agentSummary } = summary; return checked(RecentRunViewSchema, { ...agentSummary, inputText: safePreview(row.input_text, 2048).text, cleanupSummary }); }
        return checked(RecentRunViewSchema, { ...summary, inputText: safePreview(row.input_text, 2048).text, cleanupSummary });
      }),
        nextBeforeRunId: rows.length > input.limit ? page.at(-1)!.id : null };
    }
    const row = "runId" in input ? this.row(input.runId) : this.db.query<RunRow, [string, string]>(
      "SELECT * FROM runs WHERE submission_operation_ref=? OR (kind='provider' AND json_extract(config_json,'$.providerRequest.operationRef')=?)",
    ).get(input.operationRef, input.operationRef);
    return { kind: "one", run: row ? this.view(row, input.outputOffset, input.outputLimit, input.inputOffset, input.inputLimit, input.callOffset, input.callLimit) : null };
  }

  active(): { runId: number; kind: "provider" | "agent"; sessionId: number | null } | null {
    const row = this.db.query<{ id: number; kind: "provider" | "agent"; session_id: number | null }, []>("SELECT id,kind,session_id FROM runs WHERE status IN ('created','running')").get();
    return row ? { runId: row.id, kind: row.kind, sessionId: row.session_id } : null;
  }

  // Called only after the Host has confirmed the old owning process exited.
  recoverInterrupted(instanceId: string, time: string): number {
    timestamp(time);
    if (!instanceId) fail("invalid_argument");
    return this.db.transaction(() => {
      const rows = this.db.query<RunRow, [string]>(
        "SELECT * FROM runs WHERE instance_id<>? AND status IN ('created','running')",
      ).all(instanceId);
      for (const row of rows) {
        const error = safeError(row.kind === "provider" ? "host_interrupted" : "runtime_interrupted", undefined, { runId: row.id,
          operationRef: row.kind === "provider" ? this.providerConfig(row).providerRequest.operationRef : row.submission_operation_ref ?? undefined });
        if (row.kind === "provider") this.db.query("UPDATE model_calls SET state='failed',error_json=?,unavailable_reason='host_interrupted' WHERE run_id=? AND state='started'")
          .run(JSON.stringify(error), row.id);
        this.db.query(`UPDATE runs SET status='failed',ended_at=?,error_json=?,cleanup_json=?
          WHERE id=? AND status IN ('created','running')`)
          .run(time, JSON.stringify(error), JSON.stringify({ previousInstanceId: row.instance_id, oldProcessExited: true, observationGap: true }), row.id);
      }
      if (rows.length) this.beforeCommit?.();
      return rows.length;
    }).immediate();
  }
}
