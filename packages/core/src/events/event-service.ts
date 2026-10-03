import { RegisteredEventDraftSchema, ReadEventsInputSchema, OpenEventSubscriptionInputSchema, OpenEventSubscriptionResultSchema,
 EventPageSchema, CloseEventSubscriptionInputSchema, StreamSnapshotSchema, EVENT_LIMITS,
 type EventWriter, type EventStore, type WriteTransactions, type RegisteredEventDraft, type StoredRunEvent,
 type EventAvailableNotice, type EventStreamNotice, type StreamSnapshotReader, type StreamSnapshot, type ReadEventsInput,
 type EventPage, type OpenEventSubscriptionInput, type OpenEventSubscriptionResult, type CloseEventSubscriptionResult, type EventRange } from '../../../contracts/src/event';
import { AppErrorSchema, safeError, type AppError, type AppErrorCode, type Result } from '../../../contracts/src/error';

type Subscription = { input:OpenEventSubscriptionInput; sessionId:number|null; initialRange:EventRange|null; ready:boolean; pending:number; pendingHigh:number; resync:boolean; scheduled:boolean };
function failure(code:AppErrorCode,runId?:number,range?:EventRange):never {
 throw Object.assign(new Error(code),{appError:safeError(code,undefined,{runId,...(range?{eventRange:{runId:runId!,...range,resumeAfterSequence:null}}:{})})});
}
function asError(native:unknown,fallback:AppErrorCode,runId?:number):AppError {
 const direct=AppErrorSchema.safeParse(native),wrapped=AppErrorSchema.safeParse(native && typeof native==='object' && 'appError' in native ? native.appError : undefined);
 const known=direct.success?direct.data:wrapped.success?wrapped.data:null;
 if(known)return safeError(known.code,undefined,{runId:known.runId??runId,sessionId:known.sessionId,toolCallId:known.toolCallId,operationRef:known.operationRef,reason:known.reason,eventRange:known.eventRange});
 return safeError(fallback,undefined,{runId});
}
/** Observations never schedule execution. Durable facts are appended in the caller's transaction. */
export class EventService implements EventWriter {
 private readonly subscriptions=new Map<string,Subscription>();
 constructor(protected readonly store:EventStore,protected readonly transactions:WriteTransactions,protected readonly clock:()=>string,
  protected readonly sink:(notice:EventAvailableNotice)=>void,protected readonly snapshots:StreamSnapshotReader,
  protected readonly reportDiagnostic?:(error:AppError)=>void,protected readonly streamSink?:(notice:EventStreamNotice)=>void){}
 appendInTransaction(draft:RegisteredEventDraft):StoredRunEvent {
  this.transactions.assertActive();const parsed=RegisteredEventDraftSchema.safeParse(draft);
  if(!parsed.success)failure('storage_write_failed');const event=this.store.appendInTransaction(parsed.data);
  this.transactions.afterCommit(()=>{try{this.notifyCommitted(event.runId);}catch{this.diagnostic(safeError('internal_error',undefined,{runId:event.runId}));}},'event.run:'+event.runId);
  return event;
 }
 private diagnostic(error:AppError):void {try{this.reportDiagnostic?.(error);}catch{/* Diagnostics cannot reverse a commit. */}}
 private identity(runId:number):number {
  const run=this.store.readRunIdentity(runId);if(!run)failure('run_not_found',runId);
  if(run.sessionId===null)failure('resource_unavailable',runId);return run.sessionId;
 }
 private validateCursor(runId:number,cursor:number,upper:number,range:EventRange):void {
  if(cursor<0||cursor>range.lastSequence||upper<cursor||upper>range.lastSequence)failure('event_cursor_invalid',runId,range);
 }
 read(input:ReadEventsInput):Result<EventPage> {
  const parsed=ReadEventsInputSchema.safeParse(input);if(!parsed.success)return {ok:false,error:safeError('invalid_argument')};const request=parsed.data;
  try {
   this.identity(request.runId);const range=this.store.range(request.runId),upper=request.throughSequence??range.lastSequence;
   this.validateCursor(request.runId,request.afterSequence,upper,range);
   const events=this.store.readWindow({...request,throughSequence:upper});const nextSequence=events.at(-1)?.sequence??request.afterSequence;
   if(nextSequence===request.afterSequence&&nextSequence<upper)failure('frame_too_large',request.runId);
   return {ok:true,data:EventPageSchema.parse({runId:request.runId,events,nextSequence,hasMore:nextSequence<upper,range})};
  }catch(native){return {ok:false,error:asError(native,'storage_read_failed',request.runId)};}
 }
 subscribe(input:OpenEventSubscriptionInput):OpenEventSubscriptionResult {
  const parsed=OpenEventSubscriptionInputSchema.safeParse(input);if(!parsed.success)failure('event_subscription_invalid');const request=parsed.data;
  const previous=this.subscriptions.get(request.subscriptionId);
  if(previous&&(previous.input.runId!==request.runId||previous.input.afterSequence!==request.afterSequence||previous.input.limit!==request.limit))failure('state_conflict',request.runId);
  if(!previous&&this.subscriptions.size>=EVENT_LIMITS.maxSubscriptions)failure('event_subscription_limit',request.runId);
  const subscription=previous??{input:request,sessionId:null,initialRange:null,ready:false,pending:0,pendingHigh:0,resync:false,scheduled:false};
  // The bounded hint slot exists before H is read, including the initialization window.
  if(!previous)this.subscriptions.set(request.subscriptionId,subscription);
  try {
   const sessionId=this.identity(request.runId);
   if(!previous){const range=this.store.range(request.runId);this.validateCursor(request.runId,request.afterSequence,range.lastSequence,range);subscription.sessionId=sessionId;subscription.initialRange=range;}
   const live=this.snapshots.readSnapshots(request.runId),range=subscription.initialRange!;
   if(live.snapshots.length>EVENT_LIMITS.maxSnapshots)failure('resource_unavailable',request.runId);
   const reply={action:'open' as const,subscriptionId:request.subscriptionId,runId:request.runId,sessionId,
    highWatermark:range.lastSequence,range,streamConnection:live.streamConnection,
    snapshots:live.snapshots.map(snapshot=>StreamSnapshotSchema.parse(structuredClone(snapshot))),snapshotsIncomplete:live.incomplete};
   // The transport envelope has its own budget. Trim copies; never evict Runtime's cache here.
   while(reply.snapshots.length&&new TextEncoder().encode(JSON.stringify(reply)).byteLength>EVENT_LIMITS.pageBytes){reply.snapshots.shift();reply.snapshotsIncomplete=true;}
   const result=OpenEventSubscriptionResultSchema.parse(reply);
   subscription.ready=true;if(subscription.pending)this.schedule(request.subscriptionId,subscription);return result;
  }catch(native){if(!previous&&this.subscriptions.get(request.subscriptionId)===subscription)this.subscriptions.delete(request.subscriptionId);
   const error=asError(native,'resource_unavailable',request.runId);throw Object.assign(new Error(error.code),{appError:error});}
 }
 close(subscriptionId:string):CloseEventSubscriptionResult {
  if(!CloseEventSubscriptionInputSchema.safeParse({action:'close',subscriptionId}).success)failure('event_subscription_invalid');
  this.subscriptions.delete(subscriptionId);return {action:'close',subscriptionId,closed:true};
 }
 closeAll():void {this.subscriptions.clear();}
 notifyCommitted(runId:number):void {
  const range=this.store.range(runId);
  for(const [id,subscription] of this.subscriptions){if(subscription.input.runId!==runId)continue;
   subscription.pending=Math.min(EVENT_LIMITS.maxPendingNotices+1,subscription.pending+1);subscription.pendingHigh=Math.max(subscription.pendingHigh,range.lastSequence);
   if(subscription.pending>EVENT_LIMITS.maxPendingNotices)subscription.resync=true;if(subscription.ready)this.schedule(id,subscription);
  }
 }
 private schedule(id:string,subscription:Subscription):void {
  if(subscription.scheduled)return;subscription.scheduled=true;
  queueMicrotask(()=>{
   subscription.scheduled=false;if(this.subscriptions.get(id)!==subscription||!subscription.ready||!subscription.pending)return;
   const notice:EventAvailableNotice={type:'event.available',subscriptionId:id,runId:subscription.input.runId,sessionId:subscription.sessionId!,highWatermark:subscription.pendingHigh,resyncRequired:subscription.resync};
   subscription.pending=0;subscription.resync=false;
   try{this.sink(notice);}catch{this.diagnostic(safeError('preview_delivery_failed',undefined,{runId:notice.runId,sessionId:notice.sessionId}));}
  });
 }
 /** Trusted Runtime-only ingress. A copied observation is never a durable cursor. */
 notifyStream(input:StreamSnapshot):void {
  const parsed=StreamSnapshotSchema.safeParse(input);if(!parsed.success){this.diagnostic(safeError('internal_error'));return;}const snapshot=parsed.data;
  for(const [id,subscription] of this.subscriptions){if(subscription.ready&&subscription.input.runId===snapshot.runId&&subscription.sessionId===snapshot.sessionId){
   try{this.streamSink?.({type:'event.stream',subscriptionId:id,snapshot:structuredClone(snapshot)});}catch{this.diagnostic(safeError('preview_delivery_failed',undefined,{runId:snapshot.runId,sessionId:snapshot.sessionId}));}
  }}
 }
}
