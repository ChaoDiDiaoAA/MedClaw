import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { AppErrorSchema, PositiveIdSchema, safeError, serviceResult, type AppError, type Result } from "../../../contracts/src/error";
import type { Command, CommandContext, RuntimeNotice } from "../../../contracts/src/protocol";
import { type BudgetSummary, type CredentialScope, type DiagnoseRequest, type ModelRuntimePort, type ProviderAccepted, type ProviderRequest, type PublishedSettings, type ResolvedProviderSelection } from "../../../contracts/src/model";
import { canonicalRequest, RuntimeControlViewSchema, safePreview, type AgentRuntimePort, type CancelRunResult, type FinalAgentFact,
  type FinalProviderFact, type ModelCallRecorderPort, type ModelCallStarter, type ProviderOutcome, type RuntimeRunStore, type RunCleanupRecord,
  type RunHandle, type RunView, type StartRunInput } from "../../../contracts/src/run";
import { SubmitInputSchema, type NativeSessionBindings, type SubmitInput, type SubmitResult, type InputControl, type SessionInput,
  type InputContent, type InputSettlementProof } from "../../../contracts/src/session";
import { sameSubmission } from '../session/session-service';
import type { QueryExecutionContext } from '../../../contracts/src/query';
import type { RunScope } from '../../../contracts/src/run';
import { normalizeToolConfiguration } from '../../../contracts/src/tool-config';
import { normalizeRuntimeConfiguration, projectRuntimePolicies } from '../../../contracts/src/runtime-config';
import type { StreamSnapshot, WriteTransactions } from '../../../contracts/src/event';
import { CompactSessionInputSchema, ReadCompactionInputSchema, CompactionOperationViewSchema, type AutoCompactionCallbacks, type CompactionCallOwner,
  type CompactSessionInput,type ReadCompactionInput,type CompactionOperationView,type CompactionPhase,type CompactionReceipt,type StoredCompactionOperation,type NativeCompactionObservation } from '../../../contracts/src/session';
import type { FinalCallFact } from '../../../contracts/src/run';
import { toWorkspaceContext } from '../../../contracts/src/workspace';
import type { ResourceService } from '../resources/resource-service';
import { RESOURCE_LIMITS, resourceRefKey } from '../../../contracts/src/resources';
import { ChildResultSchema, NativeAgentReplySchema, type BoundChildIdentity, type ChildRuntimeCallbacks, type FinalChildFact } from '../../../contracts/src/subagent';
import { createHash } from 'node:crypto';

type Execution = { handle: RunHandle; operationRef: string; abort: AbortController; nativeTerminal: boolean; cause: "user" | "deadline" | "shutdown" | null;
  cancelAt: string | null; stopped: boolean; executionStarted: boolean | null; fact: FinalProviderFact | FinalAgentFact | null;
  primaryError: AppError | null; failureAt: string | null; secondaryErrors: AppError[]; pendingSave: boolean; finalCommitted: boolean; sequence: number; task: Promise<void>;
  scope?: RunScope; referenceDate?: string; timezone?: string; toolGap: boolean; budgetSummary?: BudgetSummary;
  rootInputId: number | null; acceptingInputs: boolean; stopEpoch: number; inputSettlement?: InputSettlementProof;
  extensionReleaseBasis?: 'not_loaded';
  pendingInputFailures: Map<number, Parameters<RuntimeRunStore['recordInputFailure']>[1]>;
  agentFields?: Omit<StartRunInput<ResolvedProviderSelection>, 'inputId' | 'submission' | 'resolved'>;
  deadlineAt: number | null; deadlineTimer: ReturnType<typeof setTimeout> | null;compactionFailure?:boolean;
  pendingCompactionCalls?:Map<string,{owner:CompactionCallOwner;fact:FinalCallFact}>;pendingCompactionFailures?:Map<string,{error:AppError;at:string}>;
  children?:Map<string,{stop:()=>Promise<void>;stopped:boolean;identity?:BoundChildIdentity;unknown:boolean;pendingFinal?:FinalChildFact}> };
type Recovery = { run: RunView; cleanup: RunCleanupRecord; verified: boolean; at: string };
type ManualExecution={operation:StoredCompactionOperation;abort:AbortController;phase:CompactionPhase;revision:number;nativeIdle:boolean;
  observed:NativeCompactionObservation|null;error:AppError|null;pendingCalls:Map<string,{owner:CompactionCallOwner;fact:FinalCallFact}>;
  task:Promise<void>;deadlineAt:number;timer:ReturnType<typeof setTimeout>|null;released:boolean};
const now = () => new Date().toISOString();
function receiptBudget(content: InputContent, instanceId: string, startedAt: string) {
  return content.resourceInputPlan ? Math.min(RESOURCE_LIMITS.nativeReceiptBytes, RESOURCE_LIMITS.inputSavedBytes
    - new TextEncoder().encode(JSON.stringify({ ...content, deliveryAttempt: { instanceId, startedAt } })).byteLength
    - new TextEncoder().encode(',"nativeInput":').byteLength) : undefined;
}

/** The one owner of root admission and lifecycle, shared by Provider and Agent. */
export class RuntimeService<Resolved extends ResolvedProviderSelection> {
  private execution: Execution | null = null;
  private reservation: { operationRef: string; request: string; kind: "provider" | "agent"; sessionId: number | null } | null = null;
  private historyMutation:{operationRef:string;sessionId:number;request?:string;accepted?:Promise<CompactionOperationView>}|null=null;
  private manual:ManualExecution|null=null;
  private readonly recoveries = new Map<number, Recovery>();
  private readonly manualRecoveries=new Map<string,StoredCompactionOperation>();
  private recoveryError: AppError | null = null;
  private closing = false;
  constructor(readonly instanceId: string, private readonly settings: () => PublishedSettings, private readonly modelRuntime: ModelRuntimePort<Resolved>,
    private readonly store: RuntimeRunStore, private readonly credentials: CredentialScope, private readonly startCall: ModelCallStarter,
    private readonly notice: (notice: RuntimeNotice) => void, private readonly report: (error: AppError) => void,
    private readonly agent: (AgentRuntimePort<Resolved> & NativeSessionBindings) | undefined, private readonly modelControlBusy: () => boolean,
    private readonly stream?: (snapshot: StreamSnapshot) => void,private readonly transactions?:WriteTransactions,private readonly resources?:ResourceService) {}
  get activeHandle(): RunHandle | null { return this.execution?.handle ?? null; }
  get persistencePending() { return (this.execution?.pendingSave ?? this.recoveries.size > 0)||!!this.manual?.error||this.manualRecoveries.size>0; }
  get stopPending() { return !!this.execution?.cause && (!this.execution.stopped||[...this.execution.children?.values()??[]].some(child=>!child.stopped))||!!this.manual?.abort.signal.aborted&&!this.manual.nativeIdle; }
  /** A pending resolve owns its operation identity before any durable receipt exists. */
  assertOperationAvailable(operationRef: string): void {
    if (this.reservation?.operationRef === operationRef||this.historyMutation?.operationRef===operationRef||this.manual?.operation.operationRef===operationRef) throw safeError('state_conflict', undefined, { operationRef });
  }
  get historyMutationPending():boolean {return this.historyMutation!==null||this.manual!==null;}
  assertNoHistoryMutation():void {if(this.historyMutation||this.manual||this.manualRecoveries.size)throw safeError('state_conflict',undefined,{reason:'runtime_busy'});}
  async withHistoryMutation<T>(operationRef:string,sessionId:number,action:()=>T|Promise<T>):Promise<T> {
    this.assertOperationAvailable(operationRef);this.assertNoHistoryMutation();
    if(this.recoveryError)throw this.recoveryError;
    if(this.execution?.cause&&!this.execution.stopped)throw safeError('stop_unconfirmed');
    if(this.persistencePending)throw safeError('storage_write_failed');
    if(this.busy)throw safeError('state_conflict',undefined,{reason:'runtime_busy'});
    this.store.assertHistoryMutationAllowed(sessionId);
    this.historyMutation={operationRef,sessionId};
    try{return await action();}
    catch(error){if(AppErrorSchema.safeParse(error).success&&(error as AppError).code==='stop_unconfirmed')this.recoveryError=error as AppError;throw error;}
    finally{this.historyMutation=null;}
  }
  /** The check and the repository transaction run in one synchronous turn. */
  withSessionDeletion<T>(sessionId: number, write: () => T): T {
    this.assertNoHistoryMutation();
    PositiveIdSchema.parse(sessionId);
    if (this.closing) throw safeError('state_conflict', undefined, { reason: 'runtime_busy' });
    if (this.recoveryError) throw this.recoveryError;
    if (this.reservation?.sessionId === sessionId) throw safeError('state_conflict', undefined, { reason: 'runtime_busy' });
    const execution = this.execution;
    if (execution && (execution.handle.sessionId === sessionId || execution.handle.sessionId === null && (execution.cause || execution.pendingSave))) {
      const context = { runId: execution.handle.runId };
      if (execution.cause && !execution.stopped) throw safeError('stop_unconfirmed', undefined, context);
      if (execution.pendingSave || execution.toolGap || this.agent?.inputPersistencePending?.(execution.handle.runId) || this.agent?.hasPendingContextPersistence?.(execution.handle.runId)) throw safeError('storage_write_failed', undefined, context);
      throw safeError('state_conflict', undefined, { ...context, reason: 'runtime_busy' });
    }
    let active: RunHandle | null, gaps: RunView[];
    try { active = this.store.active(); gaps = this.store.recoveryCandidates(this.instanceId); }
    catch (error) { throw safeError('storage_read_failed', error); }
    if (active?.sessionId === sessionId) throw safeError('state_conflict', undefined, { runId: active.runId, reason: 'runtime_busy' });
    const blocked = (run: RunView) => run.sessionId === sessionId || run.sessionId === null;
    for (const gap of gaps) if (blocked(gap)) {
      const recovery = this.recoveries.get(gap.id);
      throw safeError(!recovery?.verified ? 'stop_unconfirmed' : recovery.cleanup.requiredPersistenceComplete !== true ? 'run_save_unavailable' : 'storage_write_failed', undefined, { runId: gap.id });
    }
    for (const recovery of this.recoveries.values()) if (blocked(recovery.run))
      throw safeError(!recovery.verified ? 'stop_unconfirmed' : recovery.cleanup.requiredPersistenceComplete !== true ? 'run_save_unavailable' : 'storage_write_failed', undefined, { runId: recovery.run.id });
    return write();
  }
  failToolPersistence(runId: number, error: AppError): void {
    const execution = this.execution;
    if (!execution || execution.handle.runId !== runId || execution.stopped) return;
    execution.toolGap = true;
    this.checkpoint(execution, error); execution.abort.abort();
  }
  bindQueryContext(operationRef: string, expectedRevision: number): QueryExecutionContext {
    const execution = this.execution, workspace = this.store.readWorkspace();
    if (workspace.revision !== expectedRevision) throw new Error('state_conflict');
    if (!execution || execution.handle.kind !== 'agent' || execution.handle.sessionId !== workspace.sessionId || !execution.scope
      || !execution.referenceDate || !execution.timezone || execution.primaryError || execution.abort.signal.aborted || execution.stopped || execution.nativeTerminal) throw new Error('state_conflict');
    if (!isDeepStrictEqual(workspace.batchRefs.map(batch => batch.id), execution.scope.batchIds)
      || !isDeepStrictEqual(workspace.deviceIds.length ? workspace.deviceIds : null, execution.scope.deviceIds)) throw new Error('state_conflict');
    return { runId: execution.handle.runId, inputId: execution.rootInputId, sessionId: execution.handle.sessionId!, source: 'user_form',
      callRef: `${execution.handle.runId}:${operationRef}`, scope: structuredClone(execution.scope), referenceDate: execution.referenceDate,
      timezone: execution.timezone, signal: execution.abort.signal, basedOnQueryId: workspace.queryId, workspaceRevision: expectedRevision,
      checkActive: () => this.checkActive(execution) };
  }
  get busy() { return this.closing || this.modelControlBusy() || this.historyMutation!==null || this.manual!==null || this.reservation !== null || this.execution !== null
    || this.recoveryError !== null || this.recoveries.size > 0 ||this.manualRecoveries.size>0|| this.store.active() !== null || this.store.recoveryCandidates(this.instanceId).length > 0; }
  readInputControl(sessionId: number): InputControl | null {
    const execution = this.execution;
    if (!execution || execution.handle.kind !== 'agent' || execution.handle.sessionId !== sessionId) return null;
    const native = this.agent?.readInputControl?.(execution.handle.runId), reasons: AppError[] = [...(native?.blockReasons ?? [])];
    if (!execution.acceptingInputs || execution.nativeTerminal || execution.stopped || execution.cause || this.closing || this.modelControlBusy()
      || !native?.acceptingInputs) reasons.push(safeError('state_conflict', undefined, { reason: 'runtime_busy' }));
    if (execution.primaryError) reasons.push(execution.primaryError);
    if (execution.pendingSave || this.agent?.inputPersistencePending?.(execution.handle.runId) || this.agent?.hasPendingContextPersistence?.(execution.handle.runId)||this.agent?.hasPendingHistoryPersistence?.(execution.handle.runId)) reasons.push(safeError('storage_write_failed'));
    return { runId: execution.handle.runId, acceptingInputs: reasons.length === 0, blockReasons: reasons.slice(0, 32) };
  }
  read(input: Parameters<RuntimeRunStore["read"]>[0]) { return serviceResult(() => this.store.read(input), "storage_read_failed"); }
  active() { return serviceResult(() => {
    this.store.active();
    return this.execution ? { ...this.execution.handle, persistencePending: this.execution.pendingSave, stopPending: this.stopPending } : null;
  }, "storage_read_failed"); }
  readControl() {
    return serviceResult(() => {
      if (this.recoveryError) throw this.recoveryError;
      const root = this.store.active(), gaps = this.store.recoveryCandidates(this.instanceId), reasons: AppError[] = [];
      if (this.closing || this.modelControlBusy() || this.historyMutation || this.manual || this.reservation || this.execution || root) reasons.push(safeError("state_conflict", undefined, { reason: "runtime_busy" }));
      if(this.manual?.error)reasons.push(this.manual.error);
      if(this.manualRecoveries.size)reasons.push(safeError('stop_unconfirmed'));
      if (this.execution?.cause && !this.execution.stopped) reasons.push(safeError("stop_unconfirmed", undefined, { runId: this.execution.handle.runId }));
      if (this.execution?.pendingSave) reasons.push(safeError("storage_write_failed", undefined, { runId: this.execution.handle.runId }));
      const recoveryCode = (recovery?: Recovery) => !recovery?.verified ? 'stop_unconfirmed' : recovery.cleanup.requiredPersistenceComplete === false ? 'run_save_unavailable' : 'storage_write_failed';
      for (const gap of gaps) reasons.push(safeError(recoveryCode(this.recoveries.get(gap.id)), undefined, { runId: gap.id }));
      for (const recovery of this.recoveries.values()) if (!gaps.some(gap => gap.id === recovery.run.id)) reasons.push(safeError(recoveryCode(recovery), undefined, { runId: recovery.run.id }));
      if (reasons.length > 32) throw new Error("frame_too_large");
      const budget = this.execution?.handle.kind === 'agent' ? this.agent?.readBudget?.(this.execution.handle.runId) ?? null : null;
      return RuntimeControlViewSchema.parse({ instanceId: this.instanceId, activeRootRun: this.activeHandle, acceptingNewRuns: reasons.length === 0, blockReasons: reasons, budget });
    }, "storage_read_failed");
  }
  async compactSession(raw:CompactSessionInput,context:CommandContext):Promise<CompactionOperationView> {
    if(context.instanceId!==this.instanceId)throw safeError('host_protocol_mismatch');
    const request=CompactSessionInputSchema.parse(raw),prior=this.store.findOperation(context.operationRef);
    if(prior){if(prior.method!=='session.compact'||canonicalRequest(prior.originalRequest)!==canonicalRequest(request))throw safeError('state_conflict');return this.compactionView(prior.result);}
    if(this.historyMutation?.operationRef===context.operationRef&&this.historyMutation.accepted) {
      if(this.historyMutation.request!==canonicalRequest(request))throw safeError('state_conflict');return this.historyMutation.accepted;
    }
    let accept!:(view:CompactionOperationView)=>void,reject!:(error:unknown)=>void,accepted=false,task:ManualExecution|null=null;
    const receipt=new Promise<CompactionOperationView>((resolve,fail)=>{accept=resolve;reject=fail;});
    const running=this.withHistoryMutation(context.operationRef,request.sessionId,async()=>{
      const session=this.store.readSession(request.sessionId);
      if(!session)throw safeError('session_not_found');if(session.kind!=='user')throw safeError('access_denied');
      if(session.status!=='active')throw safeError('state_conflict',undefined,{reason:'session_deleted'});
      if(!this.agent?.compact||!this.agent.acknowledgeCompactionSaved||!this.startCall.forCompaction||!this.transactions)throw safeError('state_conflict');
      await this.agent.ensureLoaded(request.sessionId);
      const config=this.settings(),resolved=await this.modelRuntime.resolve(request.model,config.configVersion,config.credentialRefs[request.model.provider]??null,config.requestPolicy,true);
      if(this.settings().configVersion!==config.configVersion||this.closing||this.modelControlBusy())throw safeError('config_conflict');
      const current=this.store.readSession(request.sessionId)!,settings=this.agent.describe(resolved).compaction;
      if(!settings||current.storageVersion!==request.expectedStorageVersion)throw safeError('state_conflict',undefined,{reason:'history_version_mismatch'});
      const budget=normalizeRuntimeConfiguration(config).runBudget,startedAt=now();
      const frozen={model:resolved.selection,baseStorageVersion:current.storageVersion,baseLeafId:current.leafId,settings:{enabled:settings.enabled,reserveTokens:settings.reserveTokens,keepRecentTokens:settings.keepRecentTokens},
        budget:{maxModelCalls:budget.maxModelCalls,timeoutMs:budget.timeoutMs},instanceId:this.instanceId,startedAt};
      let operation:StoredCompactionOperation;
      try{operation=this.store.acceptCompaction(request,context.operationRef,frozen);}
      catch(error){const saved=this.store.readCompactionOperation({sessionId:request.sessionId,operationRef:context.operationRef});if(!saved||canonicalRequest(saved.request)!==canonicalRequest(request)||canonicalRequest(saved.frozen)!==canonicalRequest(frozen))throw error;operation=saved;}
      task={operation,abort:new AbortController(),phase:'accepted',revision:1,nativeIdle:true,observed:null,error:null,pendingCalls:new Map(),task:Promise.resolve(),deadlineAt:performance.now()+frozen.budget.timeoutMs,timer:null,released:false};
      this.manual=task;accepted=true;accept(this.compactionView(operation));
      const currentTask=task;
      const timeout=()=>{if(currentTask.released)return;if(performance.now()<currentTask.deadlineAt){currentTask.timer=setTimeout(timeout,Math.min(2147483647,currentTask.deadlineAt-performance.now()));return;}
        currentTask.error??=safeError('run_timeout');currentTask.abort.abort();this.manualProgress(currentTask,'stopping');};
      task.timer=setTimeout(timeout,Math.min(2147483647,frozen.budget.timeoutMs));
      const owners=new Map<string,CompactionCallOwner>();
      let entered=false;
      try{task.observed=await this.credentials({purpose:'runtime',operationRef:context.operationRef,credentialRef:frozen.model.credentialRef},()=>{entered=true;currentTask.nativeIdle=false;return this.agent!.compact!({operationRef:context.operationRef,sessionId:request.sessionId,resolved,frozen,signal:currentTask.abort.signal,deadlineAt:currentTask.deadlineAt},{
        startCall:(time,ordinal)=>{if(currentTask.abort.signal.aborted)throw currentTask.error??safeError('tool_cancelled');const owner:CompactionCallOwner={operationRef:context.operationRef,sessionId:request.sessionId,runId:null,source:'manual',reason:'manual',model:frozen.model,baseStorageVersion:frozen.baseStorageVersion,baseLeafId:frozen.baseLeafId,ordinal};
          const recorder=this.startCall.forCompaction!(owner,time);if(!recorder.callId)throw safeError('state_conflict');owners.set(recorder.callId,owner);return recorder;},
        finishCall:fact=>{const owner=owners.get(fact.callId);if(!owner)throw safeError('state_conflict');try{this.store.finishCompactionCall(owner,fact);}catch{currentTask.pendingCalls.set(fact.callId,{owner,fact:structuredClone(fact)});currentTask.error??=safeError('storage_write_failed');currentTask.abort.abort();}},
        progress:phase=>this.manualProgress(currentTask,phase),
      });});}
      catch(error){if(entered)throw error;task.observed={nativeIdle:true,nativeGenerated:false,change:null,result:{nativeEntryId:null,firstKeptEntryId:null,tokensBefore:null,estimatedTokensAfter:null,callIds:[],noOpReason:null,error:safeError('credential_read_failed')}};}
      task.nativeIdle=task.observed.nativeIdle;
      await this.saveManualCompaction(task);
    });
    if(this.historyMutation?.operationRef===context.operationRef){this.historyMutation.request=canonicalRequest(request);this.historyMutation.accepted=receipt;}
    const settled=running.then(()=>{
      if(task?.released&&this.manual===task){this.manual=null;this.manualProgress(task,'finished');}
    }).catch(error=>{
      if(!accepted)reject(error);
      else if(task){if(task.nativeIdle&&task.timer)clearTimeout(task.timer);task.error??=task.nativeIdle?safeError('storage_write_failed'):safeError('stop_unconfirmed');this.manualProgress(task,'blocked');}
    });
    // withHistoryMutation awaits SDK completion; only its durable acceptance handshake is returned.
    void settled;await receipt;
    const currentTask=this.manual;if(currentTask?.operation.operationRef===context.operationRef)currentTask.task=settled;
    return this.compactionView(this.store.readCompactionOperation({sessionId:request.sessionId,operationRef:context.operationRef})!);
  }
  private manualProgress(task:ManualExecution,phase:CompactionPhase):void {
    task.phase=phase;task.revision++;
    try{this.notice({type:'compaction.progress',sessionId:task.operation.request.sessionId,operationRef:task.operation.operationRef,runId:null,revision:task.revision,phase});}catch{}
  }
  private compactionView(operation:StoredCompactionOperation):CompactionOperationView {
    const task=this.manual?.operation.operationRef===operation.operationRef?this.manual:null,receipt=operation.receipt;
    const canContinue=!!receipt?.continuationEligibleAtCommit&&!this.busy
      &&this.store.readSession(operation.request.sessionId)?.status==='active'&&this.agent?.readAvailability(operation.request.sessionId).availability==='ready';
    return CompactionOperationViewSchema.parse({contract:'medclaw.compaction/v1',operationRef:operation.operationRef,sessionId:operation.request.sessionId,
      calls:this.store.readCompactionCalls?.(operation.operationRef)??[],
      status:receipt?.status??(task&&!task.error?'running':'unconfirmed'),phase:task?.phase??(receipt?'finished':'blocked'),revision:task?.revision??1,
      nativeGenerated:receipt?.nativeGenerated??task?.observed?.nativeGenerated??null,nativeSaved:receipt?.nativeSaved??false,canContinue,
      receipt,error:task?.error??receipt?.error??(!task&&!receipt?safeError('runtime_interrupted'):null)});
  }
  readCompaction(raw:ReadCompactionInput):CompactionOperationView|null {
    const operation=this.store.readCompactionOperation(ReadCompactionInputSchema.parse(raw));return operation?this.compactionView(operation):null;
  }
  readLatestCompaction(sessionId:number):CompactionOperationView|null {const operation=this.store.latestCompactionOperation?.(sessionId);return operation?this.compactionView(operation):null;}
  cancelCompaction(raw:ReadCompactionInput,context:CommandContext) {
    if(context.instanceId!==this.instanceId)throw safeError('host_protocol_mismatch');
    const request=ReadCompactionInputSchema.parse(raw),operation=this.store.readCompactionOperation(request);if(!operation)throw safeError('resource_unavailable');
    if(operation.receipt)return {operation:this.compactionView(operation),disposition:'already_finished' as const};
    const requested=this.store.requestCompactionCancel(request,now()),task=this.manual;
    if(task?.operation.operationRef===request.operationRef){task.operation=this.store.readCompactionOperation(request)!;this.manualProgress(task,'stopping');task.abort.abort();if(!task.nativeIdle)this.agent?.abortCompaction?.(request.sessionId,request.operationRef);}
    return {operation:this.readCompaction(request)!,disposition:requested?'requested' as const:'already_requested' as const};
  }
  async withSessionRestore<T>(operationRef:string,sessionId:number,expectedLeafId:string|null,action:()=>T|Promise<T>):Promise<T> {
    const task=this.manual;
    if(task) {
      if(task.operation.request.sessionId!==sessionId||this.store.readSession(sessionId)?.leafId!==expectedLeafId)throw safeError('state_conflict');
      if(!task.nativeIdle||!task.observed)throw safeError('stop_unconfirmed');
      await task.task;
      for(const [callId,pending]of task.pendingCalls){this.store.finishCompactionCall(pending.owner,pending.fact);task.pendingCalls.delete(callId);}
      const receipt=this.store.readCompactionOperation({sessionId,operationRef:task.operation.operationRef})?.receipt;
      if(receipt?.nativeSaved)await this.saveManualCompaction(task);
      else {
        task.error??=safeError('storage_write_failed');await this.saveManualCompaction(task,true);
        if(!this.agent?.discardCompactionForRestore)throw safeError('state_conflict');
        await this.agent.discardCompactionForRestore({sessionId,operationRef:task.operation.operationRef,nativeIdle:true,nativeQueuesEmpty:true,observersSettled:true,requiredCallFactsSaved:true});
      }
      if(task.timer)clearTimeout(task.timer);task.released=true;if(this.manual===task)this.manual=null;
    }
    try{return await this.withHistoryMutation(operationRef,sessionId,action);}
    finally{if(task?.released&&this.manual!==task)this.manualProgress(task,'finished');}
  }
  private async saveManualCompaction(task:ManualExecution,forRestore=false):Promise<void> {
    if(!task.nativeIdle||!task.observed)throw safeError('stop_unconfirmed');
    if(task.pendingCalls.size)throw safeError('storage_write_failed');
    const operation=this.store.readCompactionOperation({sessionId:task.operation.request.sessionId,operationRef:task.operation.operationRef})!,observed=task.observed;
    if(operation.receipt) {
      const receipt=operation.receipt,change=receipt.nativeSaved?observed.change:null,version=this.store.confirmCompactionSaved?.(change,receipt);
      if(version==null)throw safeError('storage_write_failed');
      if(forRestore)return;
      await this.agent!.acknowledgeCompactionSaved!(receipt.sessionId,receipt.operationRef,change,version);task.operation=operation;task.released=true;if(task.timer)clearTimeout(task.timer);return;
    }
    const cancelled=operation.cancelRequestedAt!==null,save=observed.nativeGenerated&&!cancelled&&!forRestore,error=task.error??observed.result.error;
    const eligible=save&&!error||!!observed.result.noOpReason&&!cancelled&&!error;
    const receipt:CompactionReceipt={contract:'medclaw.compaction/v1',operationRef:operation.operationRef,sessionId:operation.request.sessionId,runId:null,reason:'manual',
      status:cancelled?'cancelled':error?'failed':observed.result.noOpReason?'no_op':'completed',nativeGenerated:observed.nativeGenerated,nativeSaved:save,
      nativeEntryId:observed.result.nativeEntryId,firstKeptEntryId:observed.result.firstKeptEntryId,tokensBefore:observed.result.tokensBefore,estimatedTokensAfter:observed.result.estimatedTokensAfter,
      baseStorageVersion:operation.frozen.baseStorageVersion,storageVersion:save?operation.frozen.baseStorageVersion+1:null,activeLeafId:save?observed.change!.activeLeafId:operation.frozen.baseLeafId,
      callIds:observed.result.callIds,continuationEligibleAtCommit:eligible,cancelRequestedAt:operation.cancelRequestedAt,stoppedAt:now(),finishedAt:now(),noOpReason:cancelled||error?null:observed.result.noOpReason,error:cancelled?null:error};
    const change=save?observed.change:null;this.manualProgress(task,'saving');
    let version:number;
    try{version=this.transactions!.immediate(()=>this.store.commitCompactionInTransaction(change,receipt));}
    catch(native){const proof=this.store.confirmCompactionSaved?.(change,receipt);if(proof==null)throw native;version=proof;}
    if(forRestore)return;
    await this.agent!.acknowledgeCompactionSaved!(receipt.sessionId,receipt.operationRef,change,version);
    task.operation=this.store.readCompactionOperation({sessionId:receipt.sessionId,operationRef:receipt.operationRef})!;
    task.released=true;if(task.timer)clearTimeout(task.timer);
  }
  private reserve(operationRef: string, original: unknown, kind: "provider" | "agent", sessionId: number | null) {
    if (this.reservation?.operationRef === operationRef && this.reservation.request === canonicalRequest(original)) throw new Error("operation_result_unknown");
    if (this.busy) {
      if (kind === "agent") throw safeError("state_conflict", undefined, { reason: "runtime_busy" });
      throw new Error("runtime_busy");
    }
    this.reservation = { operationRef, request: canonicalRequest(original), kind, sessionId };
  }
  private recheck(operationRef: string, configVersion: string) {
    if (this.reservation?.operationRef !== operationRef || this.execution || this.closing || this.modelControlBusy()
      || this.recoveries.size || this.store.active() || this.store.recoveryCandidates(this.instanceId).length) throw new Error("runtime_busy");
    if (this.settings().configVersion !== configVersion) throw new Error("config_conflict");
  }
  async submitAgent(input: SubmitInput, context: CommandContext) {
    return serviceResult(async () => {
      if (context.instanceId !== this.instanceId) throw new Error("host_protocol_mismatch");
      const request = SubmitInputSchema.parse(input), original = this.store.findOperation(context.operationRef), previous = this.store.findSubmission({ sessionId: request.sessionId, clientSequence: request.clientSequence });
      if (original || previous) {
        if (!original || original.method !== "session.submit" || !previous || !sameSubmission(original.result, previous)
          || canonicalRequest(original.originalRequest) !== canonicalRequest(request)) throw new Error("state_conflict");
        return previous;
      }
      const session = this.store.readSession(request.sessionId);
      if (!session) throw new Error('session_not_found');
      if (session.status === 'deleted') throw safeError('state_conflict', undefined, { reason: 'session_deleted' });
      const extension=request.mode==='send'?this.settings().extensions?.bySession[String(request.sessionId)]?.extension:this.execution?.agentFields?.extensions?.selection.extension;
      if(extension&&request.text.trimStart().split(/\s/,1)[0]==='/extension_status')throw safeError('extension_command_required');
      if (request.mode !== 'send') return this.submitQueuedInput(request, context);
      this.reserve(context.operationRef, request, "agent", request.sessionId);
      try {
        if (!this.agent) throw new Error("session_history_invalid");
        await this.agent.ensureLoaded(request.sessionId);
        const loadedSession=this.store.readSession(request.sessionId);
        if(!loadedSession||loadedSession.status!=='active')throw safeError('state_conflict',undefined,{reason:loadedSession?'session_deleted':'session_not_found'});
        const availability=this.agent.readAvailability(request.sessionId);if(availability.availability!=='ready')throw availability.error??safeError('session_history_invalid');
        const config = this.settings(), resolved = await this.modelRuntime.resolve(request.model, config.configVersion,
          config.credentialRefs[request.model.provider] ?? null, config.requestPolicy, true);
        this.recheck(context.operationRef, config.configVersion);
        const extensions = await this.agent.freezeExtensions?.(request.sessionId,config);
        this.recheck(context.operationRef, config.configVersion);
        const workspace = this.store.readWorkspace(), scope = this.store.freezeAgentScope(workspace,
          [...(this.agent.toolNames ?? []), ...(extensions?.source?.manifest.tools ?? [])]);
        const resources = await this.resources?.freeze(request.sessionId, config, scope), inputPlan = resources ? this.resources!.planInput(resources, request) : undefined;
        this.recheck(context.operationRef, config.configVersion);
        if (!isDeepStrictEqual(this.store.readWorkspace(), workspace)) throw safeError('state_conflict', undefined, { reason: 'workspace_revision_mismatch' });
        if (resources) scope.allowedResourceRefs = resources.available.map(snapshot => resourceRefKey(snapshot.ref));
        const toolConfiguration = normalizeToolConfiguration(config);
        const runtimeConfiguration = normalizeRuntimeConfiguration(config);
        const agentPolicy = projectRuntimePolicies(runtimeConfiguration).agentPolicy;
        let profiles: ReturnType<NonNullable<AgentRuntimePort<Resolved>['captureToolProfiles']>> | undefined;
        try { profiles = this.agent.captureToolProfiles?.(scope); } catch { /* Missing statistics use the frozen configured timeout. */ }
        const fields = { sessionId: request.sessionId, text: request.text, model: resolved.selection, policy: resolved.policy, goal: "answer" as const,
          workspace: toWorkspaceContext(workspace), scope, referenceDate: request.referenceDate, timezone: request.timezone, timeoutMs: resolved.policy.timeoutMs,
          agentPolicy, runtimeConfiguration, toolConfiguration, ...(profiles ? structuredClone(profiles) : {}),
          ...(resources ? { resources, inputPlan } : {}), ...(extensions?{extensions}:{}), agentOptions: this.agent.describe(resolved), ...(this.agent.contextContract ? {contextContract:this.agent.contextContract} : {}),...(this.agent.historyContract?{historyContract:this.agent.historyContract}:{}) };
        const createdAt = now(), content: InputContent = { contract: 'medclaw.session-input/v1', originalSubmitInput: request, text: request.text,
          workspaceContext: toWorkspaceContext(workspace), scope: structuredClone(scope), model: structuredClone(resolved.selection),
          referenceDate: request.referenceDate, timezone: request.timezone, deliveryAttempt: null, ...(inputPlan ? { resourceInputPlan: inputPlan } : {}) };
        const nativeReceiptLimitBytes = receiptBudget(content, this.instanceId, createdAt);
        const accepted = this.store.acceptInput({ operationRef: context.operationRef, originalSubmitInput: request, content, createdAt,
          execution: { mode: 'send', run: { ...fields, instanceId: this.instanceId, createdAt } } });
        if (accepted.inputId === null || accepted.runId === null) throw new Error('state_conflict');
        const execution = this.begin({ runId: accepted.runId, kind: 'agent', sessionId: request.sessionId }, context.operationRef);
        execution.rootInputId = accepted.inputId; execution.agentFields = fields;
        execution.scope = structuredClone(scope); execution.referenceDate = request.referenceDate; execution.timezone = request.timezone;
        execution.acceptingInputs = true; this.reservation = null;
        execution.task = this.runAgent(execution, { ...fields, nativeReceiptLimitBytes, inputId: accepted.inputId, submission: null, resolved });
        return accepted;
      } finally { if (this.reservation?.operationRef === context.operationRef) this.reservation = null; }
    }, "storage_write_failed", { operationRef: context.operationRef, sessionId: input.sessionId });
  }
  start(input: StartRunInput<Resolved>) {
    return serviceResult(async () => {
      if (!input.submission || input.inputId !== null) throw new Error('state_conflict');
      const op = input.submission.operationRef;
      if (!this.agent || this.reservation?.kind !== "agent" || this.reservation.operationRef !== op
        || this.reservation.request !== canonicalRequest(input.submission.originalSubmitInput)
        || !isDeepStrictEqual(input.model, input.resolved.selection) || !isDeepStrictEqual(input.policy, input.resolved.policy)) throw new Error("state_conflict");
      this.recheck(op, input.model.configVersion);
      await this.agent.ensureLoaded(input.sessionId);this.recheck(op,input.model.configVersion);
      const session=this.store.readSession(input.sessionId),availability=this.agent.readAvailability(input.sessionId);
      if(!session||session.status!=='active')throw safeError('state_conflict',undefined,{reason:session?'session_deleted':'session_not_found'});
      if(availability.availability!=='ready')throw availability.error??safeError('session_history_invalid');
      const { resolved, ...fields } = input;
      let accepted: SubmitResult;
      try { accepted = this.store.registerAgent({ ...fields, instanceId: this.instanceId, createdAt: now() }); }
      catch (error) {
        const saved = this.store.findOperation(op);
        if (saved?.method !== "session.submit" || canonicalRequest(saved.originalRequest) !== canonicalRequest(input.submission.originalSubmitInput)) throw error;
        accepted = saved.result;
      }
      if (accepted.runId === null) throw new Error('state_conflict');
      const execution = this.begin({ runId: accepted.runId, kind: "agent", sessionId: input.sessionId }, op);
      execution.scope = structuredClone(input.scope); execution.referenceDate = input.referenceDate; execution.timezone = input.timezone;
      this.reservation = null;
      execution.task = this.runAgent(execution, input);
      return execution.handle;
    }, "storage_write_failed", { operationRef: input.submission?.operationRef, sessionId: input.sessionId });
  }
  private async submitQueuedInput(request: Extract<SubmitInput, { mode: 'steer' | 'follow_up' }>, context: CommandContext): Promise<SubmitResult> {
    const execution = this.execution, control = this.readInputControl(request.sessionId);
    if (!execution || execution.handle.kind !== 'agent' || execution.handle.runId !== request.targetRunId
      || execution.handle.sessionId !== request.sessionId || !control?.acceptingInputs || !execution.agentFields || !this.agent?.inputAdapter)
      throw safeError('state_conflict', undefined, { reason: 'runtime_busy' });
    const fields = execution.agentFields, workspace = this.store.readWorkspace();
    if (workspace.sessionId !== request.sessionId || workspace.revision !== request.expectedRevision
      || !isDeepStrictEqual(workspace.batchRefs.map(batch => batch.id), request.expectedBatchIds) || workspace.queryId !== request.expectedQueryId)
      throw safeError('state_conflict', undefined, { reason: 'workspace_revision_mismatch' });
    if (request.model.provider !== fields.model.provider || request.model.modelId !== fields.model.modelId
      || request.model.expectedConfigVersion !== fields.model.configVersion || request.referenceDate !== fields.referenceDate || request.timezone !== fields.timezone
      || workspace.batchRefs.some(batch => !fields.scope.batchIds.includes(batch.id))
      || fields.scope.deviceIds !== null && (!workspace.deviceIds.length || workspace.deviceIds.some(id => !fields.scope.deviceIds!.includes(id))))
      throw new Error('state_conflict');
    if (fields.resources && !this.resources) throw safeError('state_conflict');
    const inputPlan = fields.resources ? this.resources!.planInput(fields.resources, request) : undefined;
    const content: InputContent = { contract: 'medclaw.session-input/v1', originalSubmitInput: request, text: request.text,
      workspaceContext: toWorkspaceContext(workspace), scope: structuredClone(fields.scope), model: structuredClone(fields.model),
      referenceDate: fields.referenceDate, timezone: fields.timezone, deliveryAttempt: null, ...(inputPlan ? { resourceInputPlan: inputPlan } : {}) };
    const createdAt = now(), nativeReceiptLimitBytes = receiptBudget(content, this.instanceId, createdAt);
    const accepted = this.store.acceptInput({ operationRef: context.operationRef, originalSubmitInput: request, content, createdAt,
      execution: { mode: request.mode, targetRunId: request.targetRunId } });
    if (accepted.inputId === null) throw new Error('state_conflict');
    // The database commit proves acceptance. Delivery failure remains queryable under this Input.
    let dispatched = false;
    try {
      this.store.beginInputDelivery(accepted.inputId, this.instanceId, now());
      dispatched = true;
      await this.agent.inputAdapter.deliver({ inputId: accepted.inputId, sessionId: request.sessionId, targetRunId: request.targetRunId,
        mode: request.mode, text: request.text, stopEpoch: execution.stopEpoch, workspaceContext: content.workspaceContext, inputPlan, nativeReceiptLimitBytes });
    } catch (native) {
      execution.acceptingInputs = false;
      const error = safeError(dispatched ? 'input_delivery_unknown' : 'storage_write_failed', native);
      const failure: Parameters<RuntimeRunStore['recordInputFailure']>[1] = {
        sessionId: request.sessionId, targetRunId: request.targetRunId, at: now(), error,
        proof: dispatched ? { kind: 'delivery_unknown', reason: 'delivery_unconfirmed' } : { kind: 'not_consumed', reason: 'dispatch_rejected' },
      };
      try {
        const saved = this.store.readInput({ inputId: accepted.inputId });
        if (saved?.status === 'queued') this.saveInputFailure(execution, accepted.inputId, failure);
      } catch { execution.pendingInputFailures.set(accepted.inputId, failure); this.persistenceFailure(execution); }
      this.checkpoint(execution, error); execution.abort.abort();
    }
    return accepted;
  }
  cancelInput(inputId: number, context: CommandContext): Promise<Result<SessionInput>> {
    return serviceResult(async () => {
      if (context.instanceId !== this.instanceId) throw new Error('host_protocol_mismatch');
      const input = this.store.readInput({ inputId });
      if (!input) throw new Error('input_not_found');
      if (input.status === 'consumed' || input.processingStatus !== 'pending') return input;
      const execution = this.execution;
      if (!execution || execution.handle.kind !== 'agent' || execution.handle.runId !== input.targetRunId
        || execution.handle.sessionId !== input.sessionId || !this.agent?.inputAdapter) throw new Error('input_cancel_unconfirmed');
      const proof = await this.agent.inputAdapter.cancel(inputId);
      try { return this.store.recordInputCancellation(proof, proof.kind === 'removed' ? proof.at : now()); }
      catch { this.persistenceFailure(execution); execution.acceptingInputs = false; execution.abort.abort(); throw new Error('storage_write_failed'); }
    }, 'storage_write_failed', { operationRef: context.operationRef });
  }
  async submitProvider(command: Command<ProviderRequest | DiagnoseRequest>, kind: "main" | "diagnostic" = "main"): Promise<ProviderAccepted> {
    const method = kind === "main" ? "model.request" : "model.diagnose", original = this.store.findOperation(command.operationRef);
    if (original) {
      if (original.method !== method || !("runId" in original) || canonicalRequest(original.originalRequest) !== canonicalRequest(command.payload)) throw new Error("state_conflict");
      return { runId: original.runId, operationRef: command.operationRef, reused: true };
    }
    this.reserve(command.operationRef, command.payload, "provider", null);
    try {
      const payload = command.payload, config = this.settings(), resolved = await this.modelRuntime.resolve(payload.model, config.configVersion,
        config.credentialRefs[payload.model.provider] ?? null, config.requestPolicy);
      this.recheck(command.operationRef, config.configVersion);
      const text = kind === "main" ? (payload as ProviderRequest).text : "请仅回复 OK。";
      const accepted = this.store.registerProvider({ operationRef: command.operationRef, method, originalRequest: payload, instanceId: this.instanceId,
        goal: kind === "main" ? "answer" : "verify", inputText: text, selection: resolved.selection, policy: resolved.policy,
        runtimeConfiguration: structuredClone(config.runtimeConfiguration),
        referenceDate: payload.referenceDate, timezone: payload.timezone, priorRunId: payload.priorRunId, createdAt: now() });
      const execution = this.begin({ runId: accepted.runId, kind: "provider", sessionId: null }, command.operationRef);
      this.reservation = null;
      execution.task = this.runProvider(execution, resolved, text, kind);
      return accepted;
    } finally { if (this.reservation?.operationRef === command.operationRef) this.reservation = null; }
  }
  private begin(handle: RunHandle, operationRef: string): Execution {
    const execution: Execution = { handle, operationRef, abort: new AbortController(), nativeTerminal: false, cause: null, cancelAt: null, stopped: false,
      executionStarted: null, fact: null, primaryError: null, failureAt: null, secondaryErrors: [], pendingSave: false, finalCommitted: false, sequence: 0, task: Promise.resolve(), toolGap: false,
      deadlineAt: null, deadlineTimer: null, rootInputId: null, acceptingInputs: false, stopEpoch: 0, pendingInputFailures: new Map() };
    this.execution = execution; return execution;
  }
  private cleanup(execution: Execution, complete: boolean): RunCleanupRecord {
    const proof = execution.inputSettlement;
    const savedCleanup=execution.fact?.cleanup;
    const extensions=this.agent?.readExtensionCleanup?.(execution.handle.runId)??(execution.finalCommitted&&savedCleanup&&'extensions' in savedCleanup?savedCleanup.extensions:undefined);
    const selected=execution.handle.kind==='agent'&&this.store.readRunExtensions?.(execution.handle.runId)?.selection.extension;
    const extensionReleaseBasis=selected&&!extensions?execution.extensionReleaseBasis:undefined;
    const childrenReleased=!execution.children?.size,stopConfirmed=execution.stopped&&[...execution.children?.values()??[]].every(child=>child.stopped);
    const resourcesReleased=execution.stopped&&childrenReleased&&(!selected||extensions?.resourcesReleased===true||extensionReleaseBasis==='not_loaded');
    for(const error of extensions?.diagnostics??[])if(error.code==='extension_cleanup_failed'&&!execution.secondaryErrors.some(prior=>isDeepStrictEqual(prior,error)))execution.secondaryErrors.push(error);
    const inputsSettled = execution.rootInputId === null || !!proof && proof.admissionClosed && proof.preflightSettled
      && proof.nativeIdle && proof.nativeQueuesEmpty && !proof.pendingPersistence;
    return { contract: "medclaw.run-cleanup/v1", executionStarted: execution.executionStarted, stopConfirmed,
      requiredPersistenceComplete: complete&&childrenReleased, inputsSettled, resourcesReleased,
      ...(extensions?{extensions}:{}),
      ...(extensionReleaseBasis?{extensionReleaseBasis}:{}),
      unconfirmedItems: [...(stopConfirmed ? [] : ['stop']),...(childrenReleased?[]:['child_cleanup']),...(resourcesReleased?[]:['resources']),...(extensions&&!extensions.resourcesReleased?['extension_cleanup']:[]), ...(complete&&childrenReleased ? [] : ['persistence']), ...(inputsSettled ? [] : ['inputs']), ...(execution.toolGap && !complete ? ['tool_persistence'] : []), ...(this.agent?.hasPendingContextPersistence?.(execution.handle.runId) ? ['context_persistence'] : []),...(this.agent?.hasPendingHistoryPersistence?.(execution.handle.runId)?['history_persistence']:[])], secondaryErrors: execution.secondaryErrors, verifiedAt: complete && stopConfirmed && inputsSettled && resourcesReleased ? now() : null,
      ...(execution.budgetSummary ? { budgetSummary: structuredClone(execution.budgetSummary) } : {}) };
  }
  private deadline(execution: Execution, timeout: number) {
    execution.deadlineAt = performance.now() + timeout;
    const tick = () => {
      execution.deadlineTimer = null;
      if (execution.stopped || execution.nativeTerminal || execution.cause) return;
      const remaining = execution.deadlineAt! - performance.now();
      if (remaining <= 0) { this.expire(execution); return; }
      execution.deadlineTimer = setTimeout(tick, Math.min(2147483647, Math.max(1, Math.ceil(remaining))));
      execution.deadlineTimer.unref?.();
    };
    tick();
  }
  private clearDeadline(execution: Execution) {
    if (execution.deadlineTimer !== null) clearTimeout(execution.deadlineTimer);
    execution.deadlineTimer = null;
  }
  private expire(execution: Execution) {
    if (!execution.cause) execution.cause = 'deadline';
    execution.acceptingInputs = false; execution.stopEpoch++;
    execution.abort.abort();
    this.checkpoint(execution, safeError('run_timeout'));
  }
  private checkActive(execution: Execution) {
    if (this.execution !== execution || execution.stopped || execution.nativeTerminal) throw safeError('state_conflict');
    if (execution.deadlineAt !== null && performance.now() >= execution.deadlineAt && !execution.cause) this.expire(execution);
    if (execution.primaryError) throw execution.primaryError;
    if (execution.abort.signal.aborted) throw safeError(execution.cause === 'deadline' ? 'run_timeout' : 'tool_cancelled');
    if (execution.pendingSave || this.agent?.toolPersistencePending?.(execution.handle.runId) || this.agent?.hasPendingContextPersistence?.(execution.handle.runId)) throw safeError('storage_write_failed');
  }
  private checkpoint(execution: Execution, error: AppError,persist=true) {
    execution.acceptingInputs = false;
    if (execution.primaryError && !isDeepStrictEqual(execution.primaryError,error) && !execution.secondaryErrors.some(item => isDeepStrictEqual(item,error))) execution.secondaryErrors.push(error);
    execution.primaryError ??= error; execution.failureAt ??= now();
    if(!persist){execution.compactionFailure=true;return;}
    try { this.store.checkpointFailure(execution.handle.runId, execution.primaryError, this.cleanup(execution, false), execution.failureAt); }
    catch { this.persistenceFailure(execution); }
  }
  private persistenceFailure(execution: Execution) {
    execution.pendingSave = true;
    const error = safeError("storage_write_failed", undefined, { runId: execution.handle.runId });
    if (!execution.secondaryErrors.some(item => isDeepStrictEqual(item, error))) execution.secondaryErrors.push(error);
  }
  private saveInputFailure(execution: Execution, inputId: number, fact: Parameters<RuntimeRunStore['recordInputFailure']>[1]) {
    execution.pendingInputFailures.set(inputId, fact);
    try { this.store.recordInputFailure(inputId, fact); execution.pendingInputFailures.delete(inputId); }
    catch { this.persistenceFailure(execution); }
  }
  private terminalError(execution: Execution, outcome: ProviderOutcome | null) {
    return execution.primaryError ?? (execution.cause === "user" ? null : execution.cause === "deadline" ? safeError("run_timeout")
      : execution.cause === "shutdown" ? safeError("host_interrupted") : outcome?.error ?? null);
  }
  private status(execution: Execution, outcome: ProviderOutcome | null) {
    return execution.primaryError ? "failed" : execution.cause === "user" ? "cancelled" : execution.cause || outcome?.error || outcome?.callState !== "completed" ? "failed" : "completed";
  }
  private preview(execution: Execution, text: string) {
    if (this.execution !== execution || execution.stopped || execution.nativeTerminal || execution.primaryError) return;
    const snapshot = safePreview(text);
    this.emit(execution.handle.kind === "agent" ? { type: "agent.preview", sessionId: execution.handle.sessionId!, runId: execution.handle.runId,
      noticeSequence: ++execution.sequence, ...snapshot } : { type: "provider.preview", runId: execution.handle.runId, ...snapshot });
  }
  private childCallbacks(execution:Execution):ChildRuntimeCallbacks {
    const owned=(execution.children??=new Map());
    return {
      own:(pluginAgentId,stop)=>{
        this.checkActive(execution);if(this.execution!==execution||execution.handle.kind!=='agent'||owned.size||owned.has(pluginAgentId))throw safeError('state_conflict',undefined,{reason:'subagent_limit'});
        const slot={stop:async()=>{await stop();slot.stopped=true;},stopped:false,identity:undefined as BoundChildIdentity|undefined,unknown:false,pendingFinal:undefined as FinalChildFact|undefined};owned.set(pluginAgentId,slot);
        return()=>{if(owned.get(pluginAgentId)!==slot)return;if(slot.unknown)throw safeError('storage_read_failed');
          if(slot.identity){const saved=this.store.read({runId:slot.identity.childRunId});if(saved.kind!=='one'||saved.run?.kind!=='child'||!saved.run.childResult||!saved.run.cleanup?.stopConfirmed||!saved.run.cleanup.requiredPersistenceComplete||!saved.run.cleanup.resourcesReleased)throw safeError('storage_write_failed');}
          owned.delete(pluginAgentId);};
      },
      register:input=>{
        this.checkActive(execution);const slot=owned.get(input.pluginAgentId);
        if(!slot||input.parentRunId!==execution.handle.runId||input.frozen.instanceId!==this.instanceId||input.frozen.parentSessionId!==execution.handle.sessionId)throw safeError('access_denied');
        try {const identity=this.store.registerChild!(input);slot.identity=identity;return identity;}
        catch(error) {
          try {
            if(!this.store.findChild)throw safeError('storage_read_failed');
            const saved=this.store.findChild(input.parentRunId,input.originToolCallId,input);
            if(saved){if(saved.pluginAgentId!==input.pluginAgentId||saved.nativeSessionId!==input.nativeSessionId)throw safeError('storage_read_failed');slot.identity=saved;return saved;}
          } catch {slot.unknown=true;}
          throw safeError('storage_write_failed',error);
        }
      },
      startCall:(runId,time,context)=>{
        const slot=[...owned.values()].find(slot=>slot.identity?.childRunId===runId);
        this.checkActive(execution);if(!slot||slot.unknown||slot.stopped)throw safeError('state_conflict');return this.startCall(runId,'main',time,context);
      },
      compaction:identity=>{
        const slot=owned.get(identity.pluginAgentId);if(!slot?.identity||slot.identity.childRunId!==identity.childRunId)throw safeError('access_denied');
        const root=this.store.read({runId:execution.handle.runId});if(root.kind!=='one'||root.run?.kind!=='agent'||!root.run.model)throw safeError('state_conflict');
        return this.autoCompaction(execution,identity.childRunId,identity.childSessionId,root.run.model);
      },
      stream:snapshot=>{
        const child=[...owned.values()].find(slot=>slot.identity?.childRunId===snapshot.runId);
        if(!child?.identity||child.identity.childSessionId!==snapshot.sessionId)return;
        try{this.stream?.(structuredClone(snapshot));}catch{this.report(safeError('preview_delivery_failed'));}
      },
      finish:(identity,observation,reply)=>{
        const slot=owned.get(identity.pluginAgentId);
        if(!slot?.identity||!isDeepStrictEqual(slot.identity,identity)||!isDeepStrictEqual(observation.identity,identity)||observation.nativeIdle!==true||!this.store.finalizeChild||!this.store.childResultReferences)throw safeError('state_conflict');
        slot.stopped=true;
        if(this.agent?.toolPersistencePending?.(identity.childRunId)||this.agent?.hasPendingContextPersistence?.(identity.childRunId)||this.agent?.hasPendingHistoryPersistence?.(identity.childRunId))throw safeError('storage_write_failed');
        const originalReply=NativeAgentReplySchema.parse(reply),outcome=observation.outcome;
        const status=observation.error===null&&outcome?.callState==='completed'&&['stop','length'].includes(outcome.sdkStopReason)?'completed':outcome?.callState==='cancelled'||observation.error?.code==='tool_cancelled'?'cancelled':'failed';
        const endedAt=slot.pendingFinal?.endedAt??now(),error=status==='completed'?null:observation.error??safeError(status==='cancelled'?'tool_cancelled':'internal_error',undefined,{reason:'subagent_execution_failed'});
        const base=this.store.readChildHistoryBase!(identity.childRunId);
        const childResult=ChildResultSchema.parse({contract:'medclaw.child-result/v1',childRunId:identity.childRunId,childSessionId:identity.childSessionId,parentRunId:identity.parentRunId,
          originToolCallId:identity.originToolCallId,pluginAgentId:identity.pluginAgentId,nativeSessionId:identity.nativeSessionId,outcome:status,text:outcome?.text??'',
          ...this.store.childResultReferences(identity.childRunId),gaps:error?[error.code]:[],truncated:false,originalReply,originalReplyHash:createHash('sha256').update(canonicalRequest(originalReply)).digest('hex'),
          finalLeafId:observation.history.activeLeafId,storageVersion:observation.history.expectedStorageVersion+(observation.history.newEntries.length||observation.history.activeLeafId!==base.leafId?1:0),committedAt:endedAt});
        const candidate:FinalChildFact={status,endedAt,outputText:childResult.text,error,calls:observation.calls,history:observation.history,compactions:observation.compactions,childResult,
          cleanup:{...observation.cleanup,stopConfirmed:true,requiredPersistenceComplete:true,inputsSettled:true,resourcesReleased:false,unconfirmedItems:['resources'],verifiedAt:null}};
        const fact=slot.pendingFinal??candidate;
        if(slot.pendingFinal&&(fact.childResult.originalReplyHash!==childResult.originalReplyHash||!isDeepStrictEqual(fact.calls,observation.calls)||!isDeepStrictEqual(fact.history,observation.history)))throw safeError('state_conflict');
        slot.pendingFinal??=structuredClone(fact);
        try{this.store.finalizeChild(identity.childRunId,fact);}
        catch(cause){let saved=false;try{saved=this.store.isChildFinalSaved?.(identity.childRunId,fact)??false;}catch{}
          if(!saved){const error=safeError('storage_write_failed',cause);this.checkpoint(execution,error,false);execution.abort.abort();throw error;}}
        return {identity,result:fact.childResult,persistence:'committed'};
      },
      released:identity=>{
        const slot=owned.get(identity.pluginAgentId),saved=this.store.read({runId:identity.childRunId});
        if(!slot?.identity||!isDeepStrictEqual(slot.identity,identity)||saved.kind!=='one'||saved.run?.kind!=='child'||saved.run.childResult===null
          ||!saved.run.cleanup?.stopConfirmed||!saved.run.cleanup.requiredPersistenceComplete)throw safeError('storage_write_failed');
        this.store.saveRunCleanup(identity.childRunId,{...saved.run.cleanup,resourcesReleased:true,unconfirmedItems:[],verifiedAt:saved.run.cleanup.verifiedAt??now()});slot.stopped=true;
      },
    };
  }
  private autoCompaction(execution:Execution,runId:number,sessionId:number,model:ResolvedProviderSelection['selection']):AutoCompactionCallbacks {
    const owners=new Map<string,Omit<CompactionCallOwner,'ordinal'>>(),callOwners=new Map<string,CompactionCallOwner>(),revisions=new Map<string,number>();
    const compaction:AutoCompactionCallbacks={
      begin:(reason,time)=>{
        this.checkActive(execution);const session=runId===execution.handle.runId?this.store.readSession(sessionId):this.store.readChildHistoryBase?.(runId);if(!session)throw safeError('session_not_found');
        const operationRef=crypto.randomUUID();owners.set(operationRef,{operationRef,sessionId:sessionId,runId:runId,source:'auto',reason,model:model,baseStorageVersion:session.storageVersion,baseLeafId:session.leafId});
        return operationRef;
      },
      startCall:(operationRef,time,ordinal)=>{
        this.checkActive(execution);const owner=owners.get(operationRef);if(!owner||!this.startCall.forCompaction)throw safeError('state_conflict');
        const bound={...owner,ordinal},recorder=this.startCall.forCompaction(bound,time);if(!recorder.callId)throw safeError('state_conflict');callOwners.set(recorder.callId,bound);return recorder;
      },
      finishCall:(_operationRef,fact)=>{const owner=callOwners.get(fact.callId);if(!owner)throw safeError('state_conflict');try{this.store.finishCompactionCall(owner,fact);}catch{(execution.pendingCompactionCalls??=new Map()).set(fact.callId,{owner,fact:structuredClone(fact)});this.checkpoint(execution,safeError('storage_write_failed'),false);execution.abort.abort();}},
      save:(change,fact)=>{
        if(!this.transactions)throw safeError('state_conflict');
        try{return this.transactions.immediate(()=>this.store.commitCompactionInTransaction(change,fact));}
        catch(error){try{const version=this.store.confirmCompactionSaved?.(change,fact);if(version!=null)return version;}catch{}this.checkpoint(execution,safeError('storage_write_failed'),false);execution.abort.abort();throw error;}
      },
      failed:(operationRef,error,time,nativeGenerated)=>{if(!nativeGenerated)try{this.store.finishAutoCompaction?.(operationRef,runId,error,time);}catch{(execution.pendingCompactionFailures??=new Map()).set(operationRef,{error,at:time});this.checkpoint(execution,safeError('storage_write_failed'),false);}
        if(execution.cause!=='user')this.checkpoint(execution,error,false);execution.abort.abort();},
      progress:(operationRef,phase)=>{const revision=(revisions.get(operationRef)??0)+1;revisions.set(operationRef,revision);try{this.notice({type:'compaction.progress',sessionId:sessionId,operationRef,runId:runId,revision,phase});}catch{}},
    };
    return compaction;
  }
  private async runAgent(execution: Execution, input: StartRunInput<Resolved>) {
    this.deadline(execution, input.timeoutMs);
    const deadlineAt = execution.deadlineAt!;
    let entered = false;
    const compaction=this.autoCompaction(execution,execution.handle.runId,input.sessionId,input.model);
    try {
      const observed = await this.credentials({ purpose: "runtime", operationRef: execution.operationRef, credentialRef: input.model.credentialRef }, () => {
        if (input.inputId !== null) this.store.beginInputDelivery(input.inputId, this.instanceId, now());
        entered = true;
        return this.agent!.execute({
        runId: execution.handle.runId, sessionId: input.sessionId, inputId: input.inputId, text: input.text, resolved: input.resolved, agentOptions: input.agentOptions,
        instanceId:this.instanceId,extensions:input.extensions,resources: input.resources, inputPlan: input.inputPlan, nativeReceiptLimitBytes: input.nativeReceiptLimitBytes,
        scope: input.scope, workspaceContext: toWorkspaceContext(input.workspace), referenceDate: input.referenceDate, timezone: input.timezone, signal: execution.abort.signal, deadlineAt,
        agentPolicy: input.agentPolicy, runtimeConfiguration: input.runtimeConfiguration, toolConfiguration: input.toolConfiguration, measurementContext: input.measurementContext, toolProfileSnapshot: input.toolProfileSnapshot }, {
        startCall: (time,context) => this.startCall(execution.handle.runId, "main", time,context), preview: text => this.preview(execution, text),
        stream: snapshot => { if (snapshot.runId !== execution.handle.runId || snapshot.sessionId !== execution.handle.sessionId) return;
          try { this.stream?.(structuredClone(snapshot)); } catch { try { this.report(safeError('preview_delivery_failed')); } catch {} } },
        inputStore: this.store, admissionClosed: () => { execution.acceptingInputs = false; },compaction,
        ...(this.store.registerChild?{subagents:this.childCallbacks(execution)}:{}),
        fatal: error => { this.checkpoint(execution, error,!execution.compactionFailure); execution.abort.abort(); },
        extensionProof: proof => {
          if(proof.runId!==execution.handle.runId||proof.sessionId!==execution.handle.sessionId||proof.instanceId!==this.instanceId)throw safeError('state_conflict');
          try{this.store.saveRunCleanup(proof.runId,this.cleanup(execution,false));}catch{throw safeError('storage_write_failed',undefined,{runId:proof.runId});}
        },
        nativeTerminal: outcome => { execution.nativeTerminal = true; if (outcome.error && !execution.cause) this.checkpoint(execution, outcome.error,!execution.compactionFailure); },
      }); });
      if (observed.budgetSummary) execution.budgetSummary = structuredClone(observed.budgetSummary);
      execution.acceptingInputs = false;
      execution.inputSettlement = observed.inputSettlement;
      if (execution.rootInputId !== null && (!observed.inputSettlement || observed.inputSettlement.unconfirmedInputIds.length)) {
        execution.primaryError ??= safeError('input_delivery_unknown'); execution.failureAt ??= now();
      }
      execution.stopped = observed.nativeIdle;
      execution.executionStarted = observed.calls.length === 0 ? false : observed.calls.some(call => call.sdkStopReason !== null) ? true : null;
      const outcome = observed.lastOutcome, endedAt = now();
      execution.fact = { status: this.status(execution, outcome), outputText: outcome?.text ?? null, stoppedAt: execution.executionStarted === false ? null : endedAt, endedAt: execution.failureAt ?? endedAt,
        cancelRequestedAt: execution.cancelAt, error: this.terminalError(execution, outcome), calls: observed.calls,
        usage: outcome?.usageDetails ?? (outcome ? { source: outcome.usage.source, unavailableReason: outcome.usage.unavailableReason } : null), cleanup: this.cleanup(execution, true),
        ...(observed.inputSettlement ? { inputSettlement: observed.inputSettlement } : {}),...(observed.history?{history:observed.history}:{}),...(observed.compactions?{compactions:observed.compactions}:{}) };
    } catch {
      if (entered) this.checkpoint(execution, safeError("stop_unconfirmed"));
      else {
        execution.stopped = true; execution.executionStarted = false;
        execution.extensionReleaseBasis='not_loaded';
        execution.acceptingInputs = false;
        if (execution.rootInputId !== null) {
          this.saveInputFailure(execution, execution.rootInputId, { sessionId: input.sessionId, targetRunId: execution.handle.runId,
            at: now(), error: safeError('provider_request_failed'), proof: { kind: 'not_consumed', reason: 'start_failed' } });
          execution.inputSettlement = { runId: execution.handle.runId, admissionClosed: true, preflightSettled: true, nativeIdle: true,
            nativeQueuesEmpty: true, pendingPersistence: execution.pendingSave, removals: [], unconfirmedInputIds: [] };
        }
        execution.fact = { status: execution.primaryError ? "failed" : execution.cause === "user" ? "cancelled" : "failed", outputText: null, stoppedAt: null,
          endedAt: execution.failureAt ?? now(), cancelRequestedAt: execution.cancelAt, calls: [], cleanup: this.cleanup(execution, true),
          error: execution.cause === "user" ? null : this.terminalError(execution, null) ?? safeError("credential_read_failed"),
          ...(execution.inputSettlement ? { inputSettlement: execution.inputSettlement } : {}) };
      }
    } finally { if (execution.stopped) this.clearDeadline(execution); }
    if (execution.fact) this.saveFinal(execution);
  }
  private async runProvider(execution: Execution, resolved: Resolved, text: string, kind: "main" | "diagnostic") {
    this.deadline(execution, resolved.policy.timeoutMs);
    let recorder: ModelCallRecorderPort | null = null;
    try {
      recorder = this.startCall(execution.handle.runId, kind, now());
      const outcome = await this.credentials({ purpose: "runtime", operationRef: execution.operationRef, credentialRef: resolved.selection.credentialRef },
        () => this.modelRuntime.execute(resolved, text, execution.abort.signal, value => this.preview(execution, value), () => { execution.nativeTerminal = true; }));
      execution.stopped = true; execution.executionStarted = outcome.sdkStopReason === "pending" ? null : true;
      const unsupported = outcome.sdkStopReason === "toolUse" || outcome.sdkStopReason === "deferred";
      const effective = unsupported ? { ...outcome, error: safeError("provider_response_unsupported") } : outcome, endedAt = now();
      execution.fact = { status: this.status(execution, effective), outputText: outcome.text, stoppedAt: endedAt, endedAt: execution.failureAt ?? endedAt, cancelRequestedAt: execution.cancelAt,
        error: this.terminalError(execution, effective), call: recorder.finish(outcome, endedAt),
        usage: outcome.usageDetails ?? { source: outcome.usage.source, unavailableReason: outcome.usage.unavailableReason }, cleanup: this.cleanup(execution, true) };
    } catch {
      execution.stopped = true; execution.executionStarted = recorder ? null : false;
      const endedAt = now(), error = this.terminalError(execution, null) ?? safeError(recorder ? "provider_request_failed" : "storage_write_failed");
      const failure: ProviderOutcome = { sdkStopReason: execution.abort.signal.aborted ? "aborted" : "error", text: "", responseModel: null,
        callState: execution.abort.signal.aborted ? "cancelled" : "failed", usage: { inputTokens: null, outputTokens: null, cost: null, costCurrency: null, source: null, unavailableReason: "request_failed_before_usage" }, error };
      execution.fact = { status: execution.primaryError ? "failed" : execution.cause === "user" ? "cancelled" : "failed", outputText: null, stoppedAt: recorder ? endedAt : null, endedAt: execution.failureAt ?? endedAt,
        cancelRequestedAt: execution.cancelAt, error, ...(recorder ? { call: recorder.finish(failure, endedAt) } : {}), cleanup: this.cleanup(execution, true) };
    } finally { if (execution.stopped) this.clearDeadline(execution); }
    this.saveFinal(execution);
  }
  private emit(notice: RuntimeNotice) { try { this.notice(notice); } catch { this.report(safeError("preview_delivery_failed")); } }
  private finalSaveFailure(execution:Execution) {
    this.persistenceFailure(execution);
    this.emit(execution.handle.kind==='agent'?{type:'agent.persistence_failed',sessionId:execution.handle.sessionId!,runId:execution.handle.runId,noticeSequence:++execution.sequence,error:safeError('storage_write_failed')}
      :{type:'provider.persistence_failed',runId:execution.handle.runId,error:safeError('storage_write_failed')});
  }
  private saveFinal(execution: Execution) {
    const fact = execution.fact;
    if (!fact || !execution.stopped) throw new Error("state_conflict");
    if (!execution.finalCommitted && execution.handle.kind === 'agent' && (this.agent?.toolPersistencePending?.(execution.handle.runId)
      || this.agent?.inputPersistencePending?.(execution.handle.runId) || this.agent?.hasPendingContextPersistence?.(execution.handle.runId) ||this.agent?.hasPendingHistoryPersistence?.(execution.handle.runId)||execution.pendingCompactionCalls?.size||execution.pendingCompactionFailures?.size|| execution.pendingInputFailures.size || execution.children?.size)) {
      fact.cleanup = this.cleanup(execution, false);this.finalSaveFailure(execution);
      return;
    }
    if(!execution.finalCommitted) {
      fact.cleanup = this.cleanup(execution, true);
      try {
        if('calls' in fact&&fact.history&&this.agent?.readFinalHistory)fact.history=this.agent.readFinalHistory(execution.handle.runId);
        if ("calls" in fact) this.store.finalizeAgent(execution.handle.runId, fact); else this.store.finalizeProvider(execution.handle.runId, fact);
        execution.finalCommitted = true;
      } catch {
        try { execution.finalCommitted = this.store.isFinalSaved(execution.handle.runId, fact); } catch { /* Unknown remains blocked. */ }
      }
    }
    if (execution.finalCommitted) {
      try {
        if(this.store.readRunExtensions?.(execution.handle.runId)?.selection.extension) {
          const cleanup=this.cleanup(execution,true), current=this.store.read({runId:execution.handle.runId});
          if(current.kind!=='one'||!current.run)throw safeError('storage_read_failed');
          if(current.run.cleanup?.verifiedAt&&cleanup.verifiedAt)cleanup.verifiedAt=current.run.cleanup.verifiedAt;
          if(!isDeepStrictEqual(current.run.cleanup,cleanup))this.store.saveRunCleanup(execution.handle.runId,cleanup);
          const saved=this.store.read({runId:execution.handle.runId});
          if(saved.kind!=='one'||!saved.run||!isDeepStrictEqual(saved.run.cleanup,cleanup))throw safeError('storage_read_failed');
          fact.cleanup=cleanup;
          if(!cleanup.resourcesReleased) {execution.pendingSave=true;this.clearDeadline(execution);return;}
        }
        if('calls' in fact&&fact.history) {
          const proof=this.store.confirmHistorySaved?.(fact.history);
          if(!proof)throw safeError('storage_read_failed');
          this.agent?.acknowledgeHistorySaved?.(fact.history,proof.storageVersion);
        }
        this.agent?.releaseToolFacts?.(execution.handle.runId);
        this.agent?.releaseInputFacts?.(execution.handle.runId);
        if('calls' in fact&&fact.history)this.agent?.releaseHistoryFacts?.(execution.handle.runId);
      } catch {
        this.finalSaveFailure(execution);return;
      }
      this.clearDeadline(execution);
      execution.pendingSave = false; if (this.execution === execution) this.execution = null;
      this.emit(execution.handle.kind === "agent" ? { type: "agent.settled", sessionId: execution.handle.sessionId!, runId: execution.handle.runId,
        noticeSequence: ++execution.sequence, status: fact.status } : { type: "provider.settled", runId: execution.handle.runId });
    } else {
      this.finalSaveFailure(execution);
    }
  }
  cancelNow(runId: number): CancelRunResult {
    const execution = this.execution;
    if (execution?.handle.runId === runId && !execution.stopped) {
      execution.acceptingInputs = false; execution.stopEpoch++;
      if (!execution.nativeTerminal && !execution.cause && !execution.primaryError) { execution.cause = "user"; execution.cancelAt = now(); }
      execution.abort.abort();
      if (execution.cancelAt) { try { this.store.requestCancel(runId, execution.cancelAt); } catch { this.persistenceFailure(execution); } }
    }
    const result = this.store.read({ runId });
    if (result.kind !== "one" || !result.run) throw new Error("run_not_found");
    return { runId, cancelRequested: !!(execution?.handle.runId === runId ? execution.cancelAt : result.run.cancelRequestedAt),
      stopped: execution?.handle.runId === runId ? execution.stopped : result.run.cleanup?.stopConfirmed === true || result.run.cleanup?.executionStarted === false || !!result.run.stoppedAt, committedStatus: result.run.status,
      persistencePending: execution?.handle.runId === runId ? execution.pendingSave : false };
  }
  cancel(runId: number) { return serviceResult(async () => {
    this.cancelNow(runId); const execution = this.execution;
    if (execution?.handle.runId === runId && !execution.stopped) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([execution.task, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
      finally { clearTimeout(timer); }
    }
    return this.cancelNow(runId);
  }, "storage_read_failed", { runId }); }
  retrySaveNow(runId: number) {
    const execution = this.execution, recovery = this.recoveries.get(runId);
    if (recovery) {
      if (!recovery.verified) throw new Error("stop_unconfirmed");
      const contextFacts = this.store.verifyPriorContextFacts?.(runId),historyFacts=this.store.verifyPriorHistoryFacts?.(runId),compactionFacts=this.store.verifyPriorCompactionFacts?.(runId);
      if (contextFacts||historyFacts||compactionFacts) {
        recovery.cleanup.unconfirmedItems = [...new Set([...recovery.cleanup.unconfirmedItems.filter(item => !(contextFacts&&item.startsWith('context_'))&&!(historyFacts&&item==='history_persistence')&&!(compactionFacts&&item.startsWith('compaction_'))),...contextFacts?.unconfirmedItems??[],...historyFacts?.unconfirmedItems??[],...compactionFacts?.unconfirmedItems??[]])];
        recovery.cleanup.requiredPersistenceComplete = (contextFacts?.requiredPersistenceComplete??true)&&(historyFacts?.requiredPersistenceComplete??true)&&(compactionFacts?.requiredPersistenceComplete??true) && !recovery.cleanup.unconfirmedItems.some(item => item.endsWith('_persistence') || item.endsWith('_unknown') || item === 'persistence'||item.endsWith('_unconfirmed'));
      }
      if (recovery.cleanup.requiredPersistenceComplete !== true) throw new Error('run_save_unavailable');
      this.saveRecovery(recovery);
      if (this.recoveries.has(runId)) throw new Error("storage_write_failed");
    } else {
      if (!execution || execution.handle.runId !== runId || !execution.pendingSave || !execution.stopped || !execution.fact) throw new Error("run_save_unavailable");
      if (!execution.finalCommitted && execution.handle.kind === 'agent') {
        for(const [callId,pending]of execution.pendingCompactionCalls??[]){this.store.finishCompactionCall(pending.owner,pending.fact);execution.pendingCompactionCalls!.delete(callId);}
        for(const [operationRef,pending]of execution.pendingCompactionFailures??[]){this.store.finishAutoCompaction?.(operationRef,runId,pending.error,pending.at);execution.pendingCompactionFailures!.delete(operationRef);}
        this.agent?.retryContextPersistence?.(runId); this.agent?.retryToolPersistence?.(runId); this.agent?.retryInputPersistence?.(runId);
        this.agent?.retryHistoryPersistence?.(runId);
        for (const [inputId, fact] of [...execution.pendingInputFailures]) {
          const current = this.store.readInput({ inputId });
          // Consumption/removal evidence supersedes a tentative unknown result; never overwrite it.
          if (current && (current.status === 'consumed' || current.status === 'cancelled')) execution.pendingInputFailures.delete(inputId);
          else this.saveInputFailure(execution, inputId, fact);
        }
        if (execution.inputSettlement) execution.inputSettlement.pendingPersistence = (this.agent?.inputPersistencePending?.(runId) ?? false) || execution.pendingInputFailures.size > 0;
        if ('calls' in execution.fact && execution.inputSettlement) execution.fact.inputSettlement = execution.inputSettlement;
      }
      this.saveFinal(execution); if (execution.pendingSave) throw new Error("storage_write_failed");
    }
    const result = this.store.read({ runId }); if (result.kind !== "one" || !result.run) throw new Error("run_not_found"); return result.run;
  }
  retrySave(runId: number) { return serviceResult(() => this.retrySaveNow(runId), "storage_write_failed", { runId }); }
  recoverInterrupted(previousProcessExited: boolean) {
    try {
      const candidates = this.store.recoveryCandidates(this.instanceId), at = now();
      this.manualRecoveries.clear();for(const operation of this.store.recoverManualCompactions?.(this.instanceId,previousProcessExited,at)??[])this.manualRecoveries.set(operation.operationRef,operation);
      for (const run of candidates) {
        const facts = this.store.verifyPriorToolFacts?.(run.id, previousProcessExited, at) ?? {
          stopConfirmed: previousProcessExited ? true : null, requiredPersistenceComplete: true,
          unconfirmedItems: previousProcessExited ? [] : ['stop', 'resources'],
        };
        const inputFacts = this.store.verifyPriorInputFacts?.(run.id, previousProcessExited, at)
          ?? { inputsSettled: run.kind !== 'agent' || run.inputId === null, requiredPersistenceComplete: run.kind !== 'agent' || run.inputId === null,
            unconfirmedItems: run.kind === 'agent' && run.inputId !== null ? ['inputs'] : [] };
        const contextFacts = this.store.verifyPriorContextFacts?.(run.id) ?? {requiredPersistenceComplete:true,unconfirmedItems:[]};
        const historyFacts = this.store.verifyPriorHistoryFacts?.(run.id) ?? {requiredPersistenceComplete:true,unconfirmedItems:[]};
        const compactionFacts=this.store.verifyPriorCompactionFacts?.(run.id,previousProcessExited,at)??{requiredPersistenceComplete:true,unconfirmedItems:[]};
        const extension=run.cleanup?.extensions;
        const releasedExtension=extension&&previousProcessExited?{...extension,state:'disposed' as const,disposedAt:extension.disposedAt??at,resourcesReleased:true}:extension;
        const extensionReleaseBasis=!extension&&this.store.readRunExtensions?.(run.id)?.selection.extension
          ?run.cleanup?.extensionReleaseBasis??(previousProcessExited?'owner_process_exited' as const:undefined):undefined;
        this.recoveries.set(run.id, { run, at, verified: facts.stopConfirmed === true,
          cleanup: { contract: "medclaw.run-cleanup/v1", executionStarted: run.cleanup?.executionStarted ?? null, stopConfirmed: facts.stopConfirmed,
            requiredPersistenceComplete: facts.requiredPersistenceComplete && inputFacts.requiredPersistenceComplete && contextFacts.requiredPersistenceComplete && historyFacts.requiredPersistenceComplete&&compactionFacts.requiredPersistenceComplete, inputsSettled: inputFacts.inputsSettled, resourcesReleased: facts.stopConfirmed===true&&(!this.store.readRunExtensions?.(run.id)?.selection.extension||releasedExtension?.resourcesReleased===true||!!extensionReleaseBasis),
            ...(releasedExtension?{extensions:releasedExtension}:{}),
            ...(extensionReleaseBasis?{extensionReleaseBasis}:{}),
            unconfirmedItems: [...new Set([...facts.unconfirmedItems, ...inputFacts.unconfirmedItems,...contextFacts.unconfirmedItems,...historyFacts.unconfirmedItems,...compactionFacts.unconfirmedItems])], secondaryErrors: run.cleanup?.secondaryErrors ?? [], verifiedAt: facts.stopConfirmed === true && inputFacts.inputsSettled && contextFacts.requiredPersistenceComplete && historyFacts.requiredPersistenceComplete&&compactionFacts.requiredPersistenceComplete ? at : run.cleanup?.verifiedAt ?? null,
            ...(run.cleanup?.budgetSummary !== undefined ? { budgetSummary: run.cleanup.budgetSummary } : {}) } });
      }
      for(const recovery of this.recoveries.values())if(!recovery.cleanup.resourcesReleased){
        recovery.cleanup.unconfirmedItems=[...new Set([...recovery.cleanup.unconfirmedItems,'resources','extension_cleanup'])];recovery.cleanup.verifiedAt=null;
      }
      if (previousProcessExited) for (const recovery of [...this.recoveries.values()]) this.saveRecovery(recovery);
      this.recoveryError = null;
    } catch { this.recoveryError = safeError("storage_read_failed"); }
  }
  private saveRecovery(recovery: Recovery) {
    try {
      if (recovery.run.status === "created" || recovery.run.status === "running") this.store.checkpointFailure(recovery.run.id,
        safeError(recovery.run.kind === "provider" ? "host_interrupted" : "runtime_interrupted", undefined, { runId: recovery.run.id }), recovery.cleanup, recovery.at);
      else this.store.saveRunCleanup(recovery.run.id, recovery.cleanup);
      if (recovery.cleanup.stopConfirmed === true && recovery.cleanup.requiredPersistenceComplete === true && recovery.cleanup.inputsSettled === true && recovery.cleanup.resourcesReleased===true) this.recoveries.delete(recovery.run.id);
    } catch { this.report(safeError("storage_write_failed", undefined, { runId: recovery.run.id })); }
  }
  async shutdown() {
    this.assertShutdownAvailable();
    this.closing = true; const execution = this.execution;
    const manual=this.manual;
    if(manual) {
      if(!manual.operation.receipt)this.cancelCompaction({sessionId:manual.operation.request.sessionId,operationRef:manual.operation.operationRef},{instanceId:this.instanceId,operationRef:crypto.randomUUID()});
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([manual.task,new Promise<void>(resolve=>{timer=setTimeout(resolve,1000);})]);}finally{clearTimeout(timer);}
      if(!manual.nativeIdle||!manual.observed)throw safeError('stop_unconfirmed');
      for(const [callId,pending]of manual.pendingCalls){this.store.finishCompactionCall(pending.owner,pending.fact);manual.pendingCalls.delete(callId);}
      // Closing needs durable facts and stop proof; no subsequent SDK request will use this binding.
      await this.saveManualCompaction(manual,true);if(manual.timer)clearTimeout(manual.timer);manual.released=true;if(this.manual===manual)this.manual=null;
    }
    if (execution) { execution.acceptingInputs = false; execution.stopEpoch++; }
    if (execution && !execution.nativeTerminal && !execution.cause) { execution.cause = "shutdown"; execution.abort.abort(); }
    if (execution) await execution.task;
    if (this.execution?.pendingSave || this.recoveries.size) throw new Error("storage_write_failed");
    if(this.manualRecoveries.size||this.recoveryError)throw safeError('stop_unconfirmed');
    if (this.execution && !this.execution.stopped) throw new Error("stop_unconfirmed");
    return { executionStopped: true };
  }
  assertShutdownAvailable():void {
    if(this.historyMutation&&this.historyMutation.operationRef!==this.manual?.operation.operationRef)throw safeError('state_conflict',undefined,{reason:'runtime_busy'});
  }
}
