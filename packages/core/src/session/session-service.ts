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
import { ReadSessionCheckpointsInputSchema, RestoreSessionCheckpointInputSchema, RestoreSessionInputSchema,
  type ReadSessionCheckpointsInput,type RestoreSessionCheckpointInput,type RestoreSessionInput,type SessionCheckpointReceipt } from '../../../contracts/src/session';
import type { WriteTransactions } from '../../../contracts/src/event';
import type { CompactSessionInput,ReadCompactionInput,CompactionOperationView,CancelCompactionResult } from '../../../contracts/src/session';

export class SessionService {
  constructor(private readonly instanceId: string, private readonly store: SessionStore, private readonly native: NativeSessionBindings,
    private readonly submitAgent: (input: SubmitInput, context: CommandContext) => Promise<Result<SubmitResult>>,
    private readonly active: () => RunHandle | null,
    private readonly inputControl: (sessionId: number) => InputControl | null = () => null,
    private readonly cancelAgentInput?: (inputId: number, context: CommandContext) => Promise<Result<SessionInput>>,
    private readonly runtime?: { assertOperationAvailable(operationRef: string): void; withSessionDeletion<T>(sessionId: number, write: () => T): T;
      compactSession?:(input:CompactSessionInput,context:CommandContext)=>Promise<CompactionOperationView>;
      readCompaction?:(input:ReadCompactionInput)=>CompactionOperationView|null;
      readLatestCompaction?:(sessionId:number)=>CompactionOperationView|null;
      cancelCompaction?:(input:ReadCompactionInput,context:CommandContext)=>CancelCompactionResult;
      withSessionRestore?<T>(operationRef:string,sessionId:number,expectedLeafId:string|null,action:()=>T|Promise<T>):Promise<T>;
      assertNoHistoryMutation?():void;withHistoryMutation?<T>(operationRef:string,sessionId:number,action:()=>T|Promise<T>):Promise<T> },private readonly transactions?:WriteTransactions) {}

  compact(input:CompactSessionInput,context:CommandContext):Promise<Result<CompactionOperationView>> {
    return serviceResult(()=>{this.validateContext(context);if(!this.runtime?.compactSession)throw safeError('state_conflict');return this.runtime.compactSession(input,context);},'storage_write_failed',{sessionId:input.sessionId,operationRef:context.operationRef});
  }
  readCompaction(input:ReadCompactionInput):Promise<Result<CompactionOperationView|null>> {
    return serviceResult(()=>{if(!this.runtime?.readCompaction)throw safeError('state_conflict');return this.runtime.readCompaction(input);},'storage_read_failed',{sessionId:input.sessionId,operationRef:input.operationRef});
  }
  cancelCompaction(input:ReadCompactionInput,context:CommandContext):Promise<Result<CancelCompactionResult>> {
    return serviceResult(()=>{this.validateContext(context);if(!this.runtime?.cancelCompaction)throw safeError('state_conflict');return this.runtime.cancelCompaction(input,context);},'storage_write_failed',{sessionId:input.sessionId,operationRef:input.operationRef});
  }

  create(input: NewSessionInput, context: CommandContext): Promise<Result<NewSessionResult>> {
    return serviceResult(() => {
      this.validateContext(context);
      const request = NewSessionInputSchema.parse(input), original = this.store.findOperation(context.operationRef);
      if (original) {
        if (original.method !== "session.create" || canonicalRequest(original.originalRequest) !== canonicalRequest(request)) throw new Error("state_conflict");
        return original.result;
      }
      this.runtime?.assertNoHistoryMutation?.();
      const allocated = this.native.allocate(); let committed = false;
      try {
        const result = this.store.createSession(request, context.operationRef, allocated.nativeSessionId, new Date().toISOString(),allocated.history);
        committed = true; allocated.bind(result.session.id); return result;
      } catch (error) {
        if (!committed) allocated.discard();
        if (committed) throw new Error("operation_result_unknown");
        throw error;
      }
    }, "storage_write_failed", { operationRef: context.operationRef });
  }

  select(input: SelectSessionInput) { return serviceResult(() => {this.runtime?.assertNoHistoryMutation?.();return this.store.selectSession(input, new Date().toISOString());}, "storage_write_failed", { sessionId: input.sessionId }); }
  readCheckpoints(input:ReadSessionCheckpointsInput) {return serviceResult(()=>this.store.readCheckpoints(ReadSessionCheckpointsInputSchema.parse(input)),'storage_read_failed',{sessionId:input.sessionId});}
  restoreCheckpoint(input:RestoreSessionCheckpointInput,context:CommandContext):Promise<Result<SessionCheckpointReceipt>> {
    return serviceResult(async()=>{
      this.validateContext(context);const request=RestoreSessionCheckpointInputSchema.parse(input);this.requireUserSession(request.sessionId);
      const prior=this.store.findOperation(context.operationRef);if(prior){if(prior.method!=='session.restoreCheckpoint'||canonicalRequest(prior.originalRequest)!==canonicalRequest(request))throw safeError('state_conflict');return prior.result;}
      if(!this.runtime?.withHistoryMutation||!this.transactions)throw safeError('state_conflict',undefined,{reason:'runtime_busy'});
      return this.runtime.withHistoryMutation(context.operationRef,request.sessionId,async()=>{
        let receipt:SessionCheckpointReceipt;
        try{receipt=this.transactions!.immediate(()=>this.store.restoreCheckpointInTransaction(request,context.operationRef,new Date().toISOString()));}
        catch(error){const saved=this.store.readCheckpointOperation(context.operationRef);if(!saved||canonicalRequest(saved.request)!==canonicalRequest(request))throw error;receipt=saved.receipt;}
        await this.rebuild(request.sessionId);return receipt;
      });
    },'storage_write_failed',{operationRef:context.operationRef,sessionId:input.sessionId});
  }
  restore(input:RestoreSessionInput,context:CommandContext) {
    return serviceResult(async()=>{
      this.validateContext(context);const request=RestoreSessionInputSchema.parse(input);this.requireUserSession(request.sessionId);
      if(this.store.findOperation(context.operationRef))throw safeError('state_conflict');
      if(!this.runtime?.withHistoryMutation)throw safeError('state_conflict',undefined,{reason:'runtime_busy'});
      const action=async()=>{
        if(this.store.readSession(request.sessionId)!.leafId!==request.expectedLeafId)throw safeError('state_conflict',undefined,{reason:'history_version_mismatch'});
        await this.rebuild(request.sessionId);const detail=await this.read(request.sessionId);if(!detail.ok)throw detail.error;return detail.data;
      };
      return this.runtime.withSessionRestore?this.runtime.withSessionRestore(context.operationRef,request.sessionId,request.expectedLeafId,action):this.runtime.withHistoryMutation(context.operationRef,request.sessionId,action);
    },'storage_read_failed',{operationRef:context.operationRef,sessionId:input.sessionId});
  }
  private requireUserSession(sessionId:number) {const session=this.store.readSession(sessionId);if(!session)throw safeError('session_not_found');if(session.kind!=='user')throw safeError('access_denied');}
  private async rebuild(sessionId:number):Promise<void> {
    try{await this.native.restore(sessionId);}
    catch(error){if(AppErrorSchema.safeParse(error).success&&(error as {code:string}).code==='stop_unconfirmed')throw error;throw safeError('resource_unavailable',undefined,{reason:'session_restore_failed'});}
  }
  rename(input: RenameSessionInput, context: CommandContext): Promise<Result<SessionManagementReceipt>> {
    return serviceResult(() => {
      this.validateContext(context);
      const request = RenameSessionInputSchema.parse(input), original = this.findManagementOperation(context.operationRef);
      if (original) {
        if (original.method !== 'session.rename' || canonicalRequest(original.originalRequest) !== canonicalRequest(request)) throw new Error('state_conflict');
        return original.result;
      }
      if (!this.runtime) throw safeError('state_conflict', undefined, { reason: 'runtime_busy' });
      this.runtime.assertNoHistoryMutation?.();
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
    return serviceResult(async () => {
      const session = this.store.readSession(sessionId);
      if (!session) throw new Error("session_not_found");
      const preview=session.storageVersion===0 ? {available:false,reason:'history_not_recorded' as const,leafId:session.leafId,storageVersion:0,messages:[],truncated:false} : await this.native.read(sessionId);
      const { leafId,storageVersion, ...history } = preview, active = this.active();
      const runtime=session.storageVersion===0 ? {availability:'blocked' as const,error:safeError('session_history_invalid')} : this.native.readAvailability(sessionId);
      return SessionDetailSchema.parse({ session: { ...session, leafId,storageVersion, inputControl: this.inputControl(sessionId) }, history,runtime,
        compactionOperation:this.runtime?.readLatestCompaction?.(sessionId)??null,
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
    return serviceResult(async () => {
      const parsed = ReadSessionMessagesInputSchema.safeParse(input);
      if (!parsed.success) throw safeError("input_invalid");
      const session = this.store.readSession(parsed.data.sessionId);
      if (!session) throw new Error("session_not_found");
      const native = await this.native.readMessages(parsed.data);
      if (native.sessionId !== session.id || native.nativeSessionId !== session.nativeSessionId || !SessionMessagePageSchema.safeParse(native).success) throw safeError("session_history_invalid");
      const links = this.store.readMessageLinks(session.id, native.items.map(item => item.nativeEntryId));
      const inputLinks = this.store.readMessageInputLinks(session.id, native.items.map(item => item.nativeEntryId));
      const items = native.items.map(item => {
        const inputLink = inputLinks.get(item.nativeEntryId);
        const link = links.get(item.nativeEntryId);
        if (inputLink) {
          if (item.displayRole !== 'user' || item.runId !== null && item.runId !== inputLink.runId
            || item.inputId !== null && item.inputId !== inputLink.inputId
            || link && (link.toolCallRef!==null || link.runId!==inputLink.runId)) throw safeError('session_history_invalid');
          return { ...item, inputId: inputLink.inputId, runId: inputLink.runId, references:[...new Set([...item.references,...(link?.references??[])])].slice(0,16) };
        }
        if (!link) return item;
        if ((link.toolCallRef===null ? item.displayRole!=='user' && item.displayRole!=='assistant' : item.displayRole!=="tool_result" || item.toolCallRef!==link.toolCallRef)
          || item.runId !== null && item.runId !== link.runId) throw safeError("session_history_invalid");
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
