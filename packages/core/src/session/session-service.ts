import { canonicalRequest } from "../../../contracts/src/run";
import type { RunHandle } from "../../../contracts/src/run";
import { NewSessionInputSchema, SessionDetailSchema, SubmitInputSchema, ReadInputRequestSchema, ListInputsRequestSchema, ReadSubmissionRequestSchema,
  RenameSessionInputSchema, DeleteSessionInputSchema, ReadManagementOperationInputSchema } from "../../../contracts/src/session";
import type { NativeSessionBindings, NewSessionInput, NewSessionResult, SelectSessionInput, SessionStore, SubmitInput, SubmitResult, ReadSubmissionRequest,
  ReadInputRequest, ListInputsRequest, SessionInput, SessionInputPage, InputControl, RenameSessionInput, DeleteSessionInput,
  ReadManagementOperationInput, SessionManagementReceipt } from "../../../contracts/src/session";
import type { CommandContext } from "../../../contracts/src/protocol";
import { AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, safeError, serviceResult, type Result } from "../../../contracts/src/error";
import { ReadSessionMessagesInputSchema, SessionMessagePageSchema, type ReadSessionMessagesInput, type SessionMessagePage } from "../../../contracts/src/messages";

export class SessionService {
  constructor(private readonly instanceId: string, private readonly store: SessionStore, private readonly native: NativeSessionBindings,
    private readonly submitAgent: (input: SubmitInput, context: CommandContext) => Promise<Result<SubmitResult>>,
    private readonly active: () => RunHandle | null,
    private readonly inputControl: (sessionId: number) => InputControl | null = () => null,
    private readonly cancelAgentInput?: (inputId: number, context: CommandContext) => Promise<Result<SessionInput>>,
    private readonly runtime?: { assertOperationAvailable(operationRef: string): void; withSessionDeletion<T>(sessionId: number, write: () => T): T }) {}

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
  rename(input: RenameSessionInput, context: CommandContext): Promise<Result<SessionManagementReceipt>> {
    return serviceResult(() => {
      this.validateContext(context);
      const request = RenameSessionInputSchema.parse(input), original = this.findManagementOperation(context.operationRef);
      if (original) {
        if (original.method !== 'session.rename' || canonicalRequest(original.originalRequest) !== canonicalRequest(request)) throw new Error('state_conflict');
        return original.result;
      }
      if (!this.runtime) throw safeError('state_conflict', undefined, { reason: 'runtime_busy' });
      this.runtime.assertOperationAvailable(context.operationRef);
      return this.store.renameSession(request, context.operationRef, new Date().toISOString());
    }, 'storage_write_failed', { operationRef: context.operationRef, sessionId: input.sessionId });
  }
  delete(input: DeleteSessionInput, context: CommandContext): Promise<Result<SessionManagementReceipt>> {
    return serviceResult(() => {
      this.validateContext(context);
      const request = DeleteSessionInputSchema.parse(input), original = this.findManagementOperation(context.operationRef);
      if (original) {
        if (original.method !== 'session.delete' || canonicalRequest(original.originalRequest) !== canonicalRequest(request)) throw new Error('state_conflict');
        return original.result;
      }
      if (!this.runtime) throw safeError('state_conflict', undefined, { reason: 'runtime_busy' });
      this.runtime.assertOperationAvailable(context.operationRef);
      this.requireActiveSession(request.sessionId);
      return this.runtime.withSessionDeletion(request.sessionId, () => this.store.deleteSession(request, context.operationRef, new Date().toISOString()));
    }, 'storage_write_failed', { operationRef: context.operationRef, sessionId: input.sessionId });
  }
  readManagementOperation(input: ReadManagementOperationInput): Promise<Result<SessionManagementReceipt | null>> {
    return serviceResult(() => this.store.readManagementOperation(ReadManagementOperationInputSchema.parse(input)), 'storage_read_failed');
  }
  list(input: { beforeSessionId?: number; limit?: number }) { return serviceResult(() => {
    const page = this.store.listSessions(input);
    return { ...page, sessions: page.sessions.map(session => ({ ...session, inputControl: this.inputControl(session.id) })) };
  }, "storage_read_failed"); }
  read(sessionId: number) {
    return serviceResult(() => {
      const session = this.store.readSession(sessionId);
      if (!session) throw new Error("session_not_found");
      const { leafId, ...history } = this.native.read(sessionId), active = this.active();
      return SessionDetailSchema.parse({ session: { ...session, leafId, inputControl: this.inputControl(sessionId) }, history,
        runningRunId: active?.kind === "agent" && active.sessionId === sessionId ? active.runId : null });
    }, "storage_read_failed", { sessionId });
  }
  async submit(input: SubmitInput, context: CommandContext): Promise<Result<SubmitResult>> {
    const existing = await serviceResult(() => {
      this.validateContext(context);
      const request = SubmitInputSchema.parse(input), operation = this.store.findOperation(context.operationRef), sequence = this.store.findSubmission({ sessionId: request.sessionId, clientSequence: request.clientSequence });
      if (operation || sequence) {
        if (!operation || operation.method !== "session.submit" || !sequence || !sameSubmission(operation.result, sequence)
          || canonicalRequest(operation.originalRequest) !== canonicalRequest(request)) throw new Error("state_conflict");
        return sequence;
      }
      this.requireActiveSession(request.sessionId);
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
      const inputLinks = this.store.readMessageInputLinks(session.id, native.items.map(item => item.nativeEntryId));
      const items = native.items.map(item => {
        const inputLink = inputLinks.get(item.nativeEntryId);
        if (inputLink) {
          if (item.displayRole !== 'user' || item.runId !== null && item.runId !== inputLink.runId
            || item.inputId !== null && item.inputId !== inputLink.inputId) throw safeError('session_history_invalid');
          return { ...item, inputId: inputLink.inputId, runId: inputLink.runId };
        }
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
    const request = ReadSubmissionRequestSchema.parse(input);
    if (!this.store.readSession(request.sessionId)) throw new Error("session_not_found");
    return this.store.findSubmission(request);
  }, "storage_read_failed", { sessionId: input.sessionId }); }
  readInput(input: ReadInputRequest): Promise<Result<SessionInput | null>> {
    return serviceResult(() => {
      const request = ReadInputRequestSchema.parse(input);
      if ('sessionId' in request && !this.store.readSession(request.sessionId)) throw new Error('session_not_found');
      return this.store.readInput(request);
    }, 'storage_read_failed');
  }
  listInputs(input: ListInputsRequest): Promise<Result<SessionInputPage>> {
    return serviceResult(() => {
      const request = ListInputsRequestSchema.parse(input);
      if (!this.store.readSession(request.sessionId)) throw new Error('session_not_found');
      return this.store.listInputs(request);
    }, 'storage_read_failed', { sessionId: input.sessionId });
  }
  async cancelInput(inputId: number, context: CommandContext): Promise<Result<SessionInput>> {
    const found = await serviceResult(() => {
      this.validateContext(context);
      const id = PositiveIdSchema.parse(inputId), input = this.store.readInput({ inputId: id });
      if (!input) throw new Error('input_not_found');
      if (!this.store.readSession(input.sessionId)) throw new Error('session_not_found');
      return input;
    }, 'storage_read_failed', { operationRef: context.operationRef });
    if (!found.ok) return found;
    if (found.data.status === 'consumed' || found.data.processingStatus !== 'pending') return found;
    if (!this.cancelAgentInput) return { ok: false, error: safeError('input_cancel_unconfirmed') };
    return this.cancelAgentInput(inputId, context);
  }
  private validateContext(context: CommandContext) {
    if (context.instanceId !== this.instanceId) throw new Error("host_protocol_mismatch");
    OpaqueIdSchema.parse(context.operationRef);
  }
  private requireActiveSession(sessionId: number) {
    const session = this.store.readSession(sessionId);
    if (!session) throw new Error('session_not_found');
    if (session.status === 'deleted') throw safeError('state_conflict', undefined, { reason: 'session_deleted' });
  }
  private findManagementOperation(operationRef: string) {
    try { return this.store.findOperation(operationRef); }
    catch (error) {
      if (AppErrorSchema.safeParse(error).success || error instanceof Error && safeError(error.message).code !== 'internal_error') throw error;
      throw safeError('storage_read_failed');
    }
  }
}

/** Queue submissions can both have a null Run; their input identities must still agree. */
export function sameSubmission(left: SubmitResult, right: SubmitResult): boolean {
  return left.sessionId === right.sessionId && left.clientSequence === right.clientSequence
    && (left.inputId === null && right.inputId === null
      ? left.runId !== null && left.runId === right.runId
      : left.inputId !== null && left.inputId === right.inputId);
}
