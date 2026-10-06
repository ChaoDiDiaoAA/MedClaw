import { estimateTokens,type AgentSession,type AgentSessionEvent,type SessionManager,type CompactionResult } from '@earendil-works/pi-coding-agent';
import { performance } from 'node:perf_hooks';
import { AppErrorSchema, safeError, type AppError } from '../../contracts/src/error';
import type { AgentRuntimePort, FinalCallFact, ProviderOutcome } from '../../contracts/src/run';
import type { AutoCompactionCallbacks, CompactionCallbacks, CompactionExecutionInput, CompactionSaveFact, NativeCompactionObservation } from '../../contracts/src/session';
import type { RunControl } from '../../core/src/runtime/run-control';
import { outcomeOf, type ResolvedModel } from './model-runtime';
import { PiMemoryAdapter } from './memory-store';

type Stream = AgentSession['agent']['streamFunction'];
type Source = {kind:'manual';input:CompactionExecutionInput<ResolvedModel>;callbacks:CompactionCallbacks}
  | {kind:'auto';input:Parameters<AgentRuntimePort<ResolvedModel>['execute']>[0];callbacks:AutoCompactionCallbacks;control:RunControl;facts:(FinalCallFact|null)[]};
type Frame = {operationRef:string;reason:'manual'|'threshold'|'overflow';from:number;callIds:string[];ended:boolean;saved:boolean;
  error:AppError|null;result:CompactionResult|null;saveFact:CompactionSaveFact|null;nativeEntryId:string|null};
const now=()=>new Date().toISOString();
const failure=(error:unknown):AppError=>{
  const parsed=AppErrorSchema.safeParse(error);
  if(parsed.success)return parsed.data;
  return safeError(error instanceof Error&&['agent_call_limit','run_timeout','storage_write_failed'].includes(error.message)?error.message:'compaction_failed',undefined,{reason:'compaction_model_failed'});
};

/** Pi owns the cut, summaries and continuation; this observer owns actual calls and save barriers. */
export class CompactionAdapter {
  private frame:Frame|null=null;
  private readonly frames:Frame[]=[];
  private readonly observers:Promise<void>[]=[];
  private admitted=0;
  constructor(private readonly session:AgentSession,private readonly manager:SessionManager,private readonly memory:PiMemoryAdapter,
    private readonly source:Source,private readonly original:Stream) {}
  get isSummarizing():boolean{return this.frame!==null&&!this.frame.ended;}
  get operationRef():string|null{return this.source.kind==='manual'?this.source.input.operationRef:this.frame?.operationRef??null;}
  private checkActive():void {
    this.source.input.signal.throwIfAborted();
    if(performance.now()>=this.source.input.deadlineAt)throw new Error('run_timeout');
  }
  onNativeEvent(event:AgentSessionEvent):void {
    if(event.type==='compaction_start') {
      if(this.isSummarizing)throw safeError('state_conflict');
      if((event.reason==='manual')!==(this.source.kind==='manual'))throw safeError('state_conflict');
      if(this.source.kind==='auto')this.checkActive();
      const operationRef=this.source.kind==='manual'?this.source.input.operationRef:this.source.callbacks.begin(event.reason as 'threshold'|'overflow',now());
      this.memory.beginCompaction(operationRef);
      this.frame={operationRef,reason:event.reason,from:this.manager.getEntries().length,callIds:[],ended:false,saved:false,error:null,result:null,saveFact:null,nativeEntryId:null};
      this.frames.push(this.frame);
      if(this.source.input.signal.aborted||performance.now()>=this.source.input.deadlineAt) {
        if(!this.source.input.signal.aborted)this.frame.error=safeError('run_timeout');
        this.session.abortCompaction();this.progress('stopping');return;
      }
      this.progress('summarizing');
    } else if(event.type==='compaction_end') {
      const frame=this.frame;
      // SDK's second overflow can report exhaustion without starting another compaction.
      if(!frame)throw safeError('state_conflict');
      if(frame.ended) {
        if(event.result&&frame.result&&JSON.stringify(event.result)===JSON.stringify(frame.result))return;
        if(event.reason==='overflow'&&!event.result&&frame.saved) {
          frame.error=safeError('compaction_failed',undefined,{reason:'compaction_capacity'});
          if(this.source.kind==='auto')this.source.callbacks.failed(frame.operationRef,frame.error,now());
          return;
        }
        throw safeError('state_conflict');
      }
      if(event.reason!==frame.reason)throw safeError('state_conflict');
      frame.ended=true;
      if(event.result&&!event.aborted&&!frame.error) {
        const entries=this.manager.getEntries().slice(frame.from).filter(entry=>entry.type==='compaction');
        const entry=entries.length===1?entries[0]:undefined;
        if(!entry||entry.type!=='compaction'||entry.firstKeptEntryId!==event.result.firstKeptEntryId||entry.summary!==event.result.summary||entry.tokensBefore!==event.result.tokensBefore
          ||!this.manager.getBranch().some(item=>item===entry)||!frame.callIds.length)frame.error=safeError('compaction_failed',undefined,{reason:'compaction_native_result_invalid'});
        else {
          frame.result=event.result;frame.nativeEntryId=entry.id;
          if(this.source.kind==='auto')frame.saveFact={operationRef:frame.operationRef,sessionId:this.source.input.sessionId,runId:this.source.input.runId,reason:frame.reason as 'threshold'|'overflow',
            nativeEntryId:entry.id,firstKeptEntryId:entry.firstKeptEntryId,tokensBefore:entry.tokensBefore,estimatedTokensAfter:event.result.estimatedTokensAfter??null,
            baseStorageVersion:this.memory.readSavedContext().storageVersion,callIds:[...frame.callIds]};
        }
      } else frame.error??=event.aborted?safeError('tool_cancelled'):safeError('compaction_failed',undefined,{reason:'compaction_model_failed'});
      if(this.source.kind==='auto') {
        const reserve=this.source.input.agentOptions.compaction?.reserveTokens??this.session.settingsManager.getCompactionSettings(this.source.input.resolved.model).reserveTokens;
        if(!event.willRetry&&frame.result?.estimatedTokensAfter!=null&&frame.result.estimatedTokensAfter>=this.source.input.resolved.model.contextWindow-reserve)frame.error=safeError('compaction_failed',undefined,{reason:'compaction_capacity'});
        if(frame.error)this.source.callbacks.failed(frame.operationRef,frame.error,now(),frame.saveFact!==null);
      }
      this.progress(frame.error?'blocked':'saving');
    }
  }
  private progress(phase:Parameters<CompactionCallbacks['progress']>[0]):void {
    if(this.source.kind==='manual')this.source.callbacks.progress(phase);
    else if(this.frame)this.source.callbacks.progress(this.frame.operationRef,phase);
  }
  async streamSummary(...args:Parameters<Stream>):Promise<Awaited<ReturnType<Stream>>> {
    const [model,context,options]=args,frame=this.frame;
    if(!frame||frame.ended)throw safeError('state_conflict');
    let recorder;
    try {
      this.checkActive();options?.signal?.throwIfAborted();
      if(model.provider!==this.source.input.resolved.model.provider||model.id!==this.source.input.resolved.model.id)throw safeError('state_conflict');
      const reserve=this.source.kind==='manual'?this.source.input.frozen.settings.reserveTokens:this.source.input.agentOptions.compaction?.reserveTokens??this.session.settingsManager.getCompactionSettings(model).reserveTokens;
      if(model.contextWindow<=reserve)throw safeError('compaction_failed',undefined,{reason:'compaction_capacity'});
      if(this.source.kind==='auto')this.source.control.admitCompactionCall();
      else if(this.admitted>=this.source.input.frozen.budget.maxModelCalls)throw new Error('agent_call_limit');
      this.admitted++;
      recorder=this.source.kind==='manual'?this.source.callbacks.startCall(now(),frame.callIds.length+1):this.source.callbacks.startCall(frame.operationRef,now(),frame.callIds.length+1);
      if(!recorder.callId)throw safeError('state_conflict');frame.callIds.push(recorder.callId);
    } catch(error){frame.error=failure(error);throw error;}
    const index=this.source.kind==='auto'?this.source.facts.push(null)-1:null;
    const finish=(outcome:ProviderOutcome)=>{
      const fact=recorder.finish(outcome,now());
      if(this.source.kind==='auto'){this.source.facts[index!]=fact;this.source.callbacks.finishCall(frame.operationRef,fact);}
      else this.source.callbacks.finishCall(fact);
    };
    let stream:Awaited<ReturnType<Stream>>;
    try {
      stream=await this.original(model,{...context,messages:context.messages.map(message=>message.role==='system'?{...message,toolsAdded:[],toolsRemoved:[]}:message)},{...options,
        signal:AbortSignal.any([this.source.input.signal,...(options?.signal?[options.signal]:[])]),maxRetries:0,
        timeoutMs:Math.max(1,Math.ceil(this.source.input.deadlineAt-performance.now()))});
    } catch(error) {
      frame.error=failure(error);
      finish({sdkStopReason:'pending',text:'',responseModel:null,callState:'failed',usage:{inputTokens:null,outputTokens:null,cost:null,costCurrency:null,source:null,unavailableReason:'call_not_observed'},error:frame.error});
      throw error;
    }
    const observed=stream.result().then(message=>{
      const outcome=outcomeOf(message,this.source.input.resolved.pricingKnown);
      finish(outcome);
      if(message.stopReason==='toolUse'||message.stopReason==='deferred'||message.content.some(part=>part.type==='toolCall')) {
        frame.error=safeError('compaction_failed',undefined,{reason:'compaction_native_result_invalid'});this.session.abortCompaction();
      }
    }).catch(error=>{frame.error=failure(error);this.session.abortCompaction();throw error;});
    this.observers.push(observed);
    void observed.catch(()=>{}); // The owner awaits the original rejection during settle().
    return stream;
  }
  beforeMainRequest():void {
    const frame=this.frame;
    if(!frame)return;
    if(!frame.ended||frame.error)throw frame.error??safeError('state_conflict');
    if(this.source.kind!=='auto'||!frame.saveFact)throw safeError('state_conflict');
    this.checkActive();
    if(!frame.saved) {
      const change=this.memory.readCompactionCommit(frame.operationRef),version=this.source.callbacks.save(change,frame.saveFact);
      this.memory.acknowledgeCompaction(change,version);frame.saved=true;
    }
    const reserve=this.source.input.agentOptions.compaction?.reserveTokens??this.session.settingsManager.getCompactionSettings(this.source.input.resolved.model).reserveTokens;
    if(frame.result?.estimatedTokensAfter!=null&&frame.result.estimatedTokensAfter>=this.source.input.resolved.model.contextWindow-reserve) {
      frame.error=safeError('compaction_failed',undefined,{reason:'compaction_capacity'});this.source.callbacks.failed(frame.operationRef,frame.error,now());throw frame.error;
    }
  }
  async settle():Promise<void>{await Promise.all(this.observers);}
  checkRequestCapacity(messages:Parameters<Stream>[1]['messages']):void {
    if(this.source.kind!=='auto'||!this.frame?.result)return;
    const reserve=this.source.input.agentOptions.compaction?.reserveTokens??this.session.settingsManager.getCompactionSettings(this.source.input.resolved.model).reserveTokens;
    // SDK character estimates include the actual P8 projection, feedback and tool definitions here.
    if(messages.reduce((total,message)=>total+estimateTokens(message),0)>=this.source.input.resolved.model.contextWindow-Math.max(reserve,this.source.input.resolved.selection.maxOutputTokens))throw safeError('compaction_failed',undefined,{reason:'compaction_capacity'});
  }
  readSaveFacts():CompactionSaveFact[]{return this.frames.flatMap(frame=>frame.saveFact?[structuredClone(frame.saveFact)]:[]);}
  async runManual():Promise<NativeCompactionObservation> {
    if(this.source.kind!=='manual')throw safeError('state_conflict');
    let noOpReason:NativeCompactionObservation['result']['noOpReason']=null,error:AppError|null=null;
    try {this.checkActive();await this.session.compact();}
    catch(native) {
      const message=native instanceof Error?native.message:'';
      if(!this.frame?.callIds.length&&message==='Already compacted')noOpReason='already_compacted';
      else if(!this.frame?.callIds.length&&message==='Nothing to compact (session too small)')noOpReason='nothing_to_compact';
      else if(!this.source.input.signal.aborted)error=this.frame?.error??failure(native);
    }
    await this.session.waitForIdle();await this.settle();
    if(!this.session.isIdle||this.session.agent.hasQueuedMessages())throw safeError('stop_unconfirmed');
    const frame=this.frame,result=frame?.result;
    return {nativeGenerated:result!==null&&result!==undefined,nativeIdle:true,change:result?this.memory.readCompactionCommit(this.source.input.operationRef):null,
      result:{nativeEntryId:frame?.nativeEntryId??null,firstKeptEntryId:result?.firstKeptEntryId??null,tokensBefore:result?.tokensBefore??null,estimatedTokensAfter:result?.estimatedTokensAfter??null,
        callIds:frame?[...frame.callIds]:[],noOpReason,error:noOpReason?null:error??frame?.error??null}};
  }
}
