import { canonicalRequest } from "../../../contracts/src/run";
import type { RunHandle } from "../../../contracts/src/run";
import { NewSessionInputSchema, SessionDetailSchema, SubmitInputSchema } from "../../../contracts/src/session";
import type { NativeSessionBindings, NewSessionInput, NewSessionResult, SelectSessionInput, SessionStore, SubmitInput, SubmitResult, ReadSubmissionRequest } from "../../../contracts/src/session";
import type { CommandContext } from "../../../contracts/src/protocol";
import { OpaqueIdSchema, safeError, serviceResult, type Result } from "../../../contracts/src/error";
import { ReadSessionMessagesInputSchema, SessionMessagePageSchema, type ReadSessionMessagesInput, type SessionMessagePage } from "../../../contracts/src/messages";

export class SessionService {
  constructor(private readonly instanceId: string, private readonly store: SessionStore, private readonly native: NativeSessionBindings,
    private readonly submitAgent: (input: SubmitInput, context: CommandContext) => Promise<Result<SubmitResult>>,
    private readonly active: () => RunHandle | null) {}

  create(input: NewSessionInput, context: CommandContext): Promise<Result<NewSessionResult>> {
    return serviceResult(() => {
      this.validateContext(context);
      const request = NewSessionInputSchema.parse(input), original = this.store.findOperation(context.operationRef);
      if (original) {
        if (original.method !== "session.create" || canonicalRequest(original.originalRequest) !== canonicalRequest(request)) throw new Error("state_conflict");
        return original.result;
      }
      const allocated = this.native.allocate(); let committed = false;
      try {
        const result = this.store.createSession(request, context.operationRef, allocated.nativeSessionId, new Date().toISOString());
        committed = true; allocated.bind(result.session.id); return result;
      } catch (error) {
        if (!committed) allocated.discard();
        if (committed) throw new Error("operation_result_unknown");
        throw error;
      }
    }, "storage_write_failed", { operationRef: context.operationRef });
  }

  select(input: SelectSessionInput) { return serviceResult(() => this.store.selectSession(input, new Date().toISOString()), "storage_write_failed", { sessionId: input.sessionId }); }
  list(input: { beforeSessionId?: number; limit?: number }) { return serviceResult(() => this.store.listSessions(input), "storage_read_failed"); }
  read(sessionId: number) {
    return serviceResult(() => {
      const session = this.store.readSession(sessionId);
      if (!session) throw new Error("session_not_found");
      const { leafId, ...history } = this.native.read(sessionId), active = this.active();
      return SessionDetailSchema.parse({ session: { ...session, leafId }, history,
        runningRunId: active?.kind === "agent" && active.sessionId === sessionId ? active.runId : null });
    }, "storage_read_failed", { sessionId });
  }
  async submit(input: SubmitInput, context: CommandContext): Promise<Result<SubmitResult>> {
    const existing = await serviceResult(() => {
      this.validateContext(context);
      const request = SubmitInputSchema.parse(input), operation = this.store.findOperation(context.operationRef), sequence = this.store.findSubmission({ sessionId: request.sessionId, clientSequence: request.clientSequence });
      if (operation || sequence) {
        if (!operation || operation.method !== "session.submit" || !sequence || operation.result.runId !== sequence.runId
          || canonicalRequest(operation.originalRequest) !== canonicalRequest(request)) throw new Error("state_conflict");
        return sequence;
      }
      return null;
    }, "storage_read_failed", { operationRef: context.operationRef, sessionId: input.sessionId });
    if (!existing.ok) return existing;
    return existing.data ? { ok: true, data: existing.data } : this.submitAgent(input, context);
  }
  readMessages(input: ReadSessionMessagesInput): Promise<Result<SessionMessagePage>> {
    return serviceResult(() => {
      const parsed = ReadSessionMessagesInputSchema.safeParse(input);
      if (!parsed.success) throw safeError("input_invalid");
      const session = this.store.readSession(parsed.data.sessionId);
      if (!session) throw new Error("session_not_found");
      const native = this.native.readMessages(parsed.data);
      if (native.sessionId !== session.id || native.nativeSessionId !== session.nativeSessionId || !SessionMessagePageSchema.safeParse(native).success) throw safeError("session_history_invalid");
      const links = this.store.readMessageLinks(session.id, native.items.map(item => item.nativeEntryId));
      const items = native.items.map(item => {
        const link = links.get(item.nativeEntryId);
        if (!link) return item;
        if (item.displayRole !== "tool_result" || item.toolCallRef !== link.toolCallRef || item.runId !== null && item.runId !== link.runId) throw safeError("session_history_invalid");
        return { ...item, runId: link.runId, references: [...new Set([...item.references, ...link.references])].slice(0, 16) };
      });
      const result = SessionMessagePageSchema.safeParse({ ...native, items });
      if (!result.success) throw safeError("session_history_invalid");
      return result.data;
    }, "storage_read_failed", { sessionId: input.sessionId });
  }
  readSubmission(input: ReadSubmissionRequest) { return serviceResult(() => {
    if (!this.store.readSession(input.sessionId)) throw new Error("session_not_found");
    return this.store.findSubmission(input);
  }, "storage_read_failed", { sessionId: input.sessionId }); }
  private validateContext(context: CommandContext) {
    if (context.instanceId !== this.instanceId) throw new Error("host_protocol_mismatch");
    OpaqueIdSchema.parse(context.operationRef);
  }
}
