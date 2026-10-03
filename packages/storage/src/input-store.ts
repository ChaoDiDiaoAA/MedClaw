import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema, safeError } from '../../contracts/src/error';
import { InputContentSchema, SessionInputSchema, ReadInputRequestSchema, ListInputsRequestSchema, SessionInputPageSchema, MAX_INPUT_PAGE_BYTES,
 type InputContent, type SessionInput, type SessionInputPage, type ReadInputRequest, type ListInputsRequest, type InputStore, type InputCancelProof, type InputSettlementProof } from '../../contracts/src/session';
import { canonicalRequest, safePreview } from '../../contracts/src/run';
import type { EventWriter, RegisteredEventPayload } from '../../contracts/src/event';
export type InputRow={id:number;session_id:number;client_sequence:number;operation_ref:string;mode:SessionInput['mode'];status:SessionInput['status'];processing_status:SessionInput['processingStatus'];content_json:string;target_run_id:number|null;run_id:number|null;native_entry_id:string|null;created_at:string;updated_at:string;delivered_at:string|null;processed_at:string|null;error_json:string|null};
function fail(code:string):never {throw new Error(code);}
function check<T>(schema:z.ZodType<T>,value:unknown,code='invalid_argument'):T {const r=schema.safeParse(value);return r.success?r.data:fail(code);}
function readJson(text:string):unknown {try{return JSON.parse(text);}catch{return fail('storage_read_failed');}}
/** Synchronous primitives on the Repositories connection; callers own acceptance/finalization transactions. */
export class SqliteInputStore {
 constructor(private readonly db:Database,private readonly events?:EventWriter){}
 private event(row:InputRow,fact:RegisteredEventPayload,at:string):void {
  if(!this.events)return;const runId=row.run_id??row.target_run_id;if(runId===null)fail('storage_write_failed');
  this.events.appendInTransaction({...fact,runId,sessionId:row.session_id,source:'application',sourceConnection:null,sourceSequence:null,toolCallId:null,occurredAt:at,receivedAt:at});
 }
 private fields(row:InputRow){return {contract:'medclaw.event/v1' as const,inputId:row.id,targetRunId:row.target_run_id,runId:row.run_id,status:row.status,processingStatus:row.processing_status,errorCode:row.error_json===null?null:check(AppErrorSchema,readJson(row.error_json),'storage_read_failed').code};}
 accepted(inputId:number,at:string):void {
  const row=this.required(inputId);if(row.status!=='queued'||row.processing_status!=='pending'||row.run_id!==null||row.error_json!==null)fail('state_conflict');
  const payload={...this.fields(row),runId:null,status:'queued' as const,processingStatus:'pending' as const,errorCode:null};
  this.event(row,{type:'input_accepted',payload},at);if(row.mode!=='send')this.event(row,{type:'input_queued',payload},at);
 }
 row(inputId:number):InputRow|null {check(PositiveIdSchema,inputId);return this.db.query<InputRow,[number]>('SELECT * FROM session_inputs WHERE id=?').get(inputId);}
 required(inputId:number):InputRow {return this.row(inputId)??fail('input_not_found');}
 content(row:InputRow):InputContent {const content=check(InputContentSchema,readJson(row.content_json),'storage_read_failed'); if(content.originalSubmitInput.sessionId!==row.session_id||content.originalSubmitInput.clientSequence!==row.client_sequence||content.originalSubmitInput.mode!==row.mode)fail('storage_read_failed');return content;}
 projection(row:InputRow):SessionInput {
  const c=this.content(row),p=safePreview(c.text,8192);
  return check(SessionInputSchema,{id:row.id,sessionId:row.session_id,clientSequence:row.client_sequence,mode:row.mode,text:p.text,textInfo:{totalChars:c.text.length,truncated:p.truncated},workspaceContext:c.workspaceContext,status:row.status,processingStatus:row.processing_status,targetRunId:row.target_run_id,runId:row.run_id,nativeEntryId:row.native_entry_id,createdAt:row.created_at,updatedAt:row.updated_at,deliveredAt:row.delivered_at,processedAt:row.processed_at,error:row.error_json===null?null:check(AppErrorSchema,readJson(row.error_json),'storage_read_failed')},'storage_read_failed');
 }
 result(row:InputRow) {this.content(row);return {sessionId:row.session_id,clientSequence:row.client_sequence,inputId:row.id,runId:row.mode==='send'?row.target_run_id:row.run_id};}
 operation(op:string):InputRow|null{return this.db.query<InputRow,[string]>('SELECT * FROM session_inputs WHERE operation_ref=?').get(op);}
 sequence(sessionId:number,seq:number):InputRow|null{return this.db.query<InputRow,[number,number]>('SELECT * FROM session_inputs WHERE session_id=? AND client_sequence=?').get(sessionId,seq);}
 private cas(row:InputRow,status:InputRow['status'],processing:InputRow['processing_status'],at:string,error:string|null,runId=row.run_id,entry=row.native_entry_id) {
  check(TimestampSchema,at);
  const changed=this.db.query(`UPDATE session_inputs SET status=?,processing_status=?,processed_at=?,updated_at=?,error_json=?,run_id=?,native_entry_id=? WHERE id=? AND status=? AND processing_status=? AND run_id IS ? AND native_entry_id IS ?`).run(status,processing,processing==='pending'?null:row.processed_at??at,at,error,runId,entry,row.id,row.status,row.processing_status,row.run_id,row.native_entry_id);
  if(changed.changes!==1)fail('state_conflict');
  const next=this.required(row.id),payload=this.fields(next);
  if(status==='consumed'&&row.status!=='consumed')this.event(next,{type:'input_delivered',payload:{...payload,phase:'native_consumed'}},at);
  else if(processing==='completed')this.event(next,{type:'input_processed',payload:{...payload,processingStatus:'completed'}},at);
  else if(processing==='cancelled')this.event(next,{type:'input_cancelled',payload:{...payload,processingStatus:'cancelled'}},at);
  else if(status==='failed'||status==='delivery_unknown'||processing==='failed')this.event(next,{type:'input_failed',payload:{...payload,processingStatus:processing==='failed'?'failed':'pending'}},at);
 }
 beginInputDelivery(inputId:number,instanceId:string,at:string):void {
  check(OpaqueIdSchema,instanceId);check(TimestampSchema,at);const row=this.required(inputId),c=this.content(row);
  if(c.deliveryAttempt){if(c.deliveryAttempt.instanceId===instanceId&&c.deliveryAttempt.startedAt===at)return;fail('state_conflict');}
  if(row.status!=='queued'||row.processing_status!=='pending')fail('state_conflict');
  c.deliveryAttempt={instanceId,startedAt:at};const saved=this.db.query('UPDATE session_inputs SET content_json=?,updated_at=? WHERE id=? AND content_json=?').run(canonicalRequest(c),at,inputId,row.content_json);if(saved.changes!==1)fail('state_conflict');
 }
 recordInputDelivery(inputId:number,at:string):void {
  check(TimestampSchema,at);const row=this.required(inputId);if(!this.content(row).deliveryAttempt)fail('state_conflict');
  if(row.delivered_at!==null){if(row.delivered_at===at)return;fail('state_conflict');}
  if(row.status==='cancelled'||row.status==='failed')fail('native_state_invalid');
  this.db.query('UPDATE session_inputs SET delivered_at=?,updated_at=? WHERE id=? AND delivered_at IS NULL').run(at,at,inputId);
  this.event(this.required(inputId),{type:'input_delivered',payload:{...this.fields(this.required(inputId)),phase:'sdk_received'}},at);
 }
 recordInputConsumption(inputId:number,fact:Parameters<InputStore['recordInputConsumption']>[1]):void {
  check(PositiveIdSchema,fact.sessionId);check(PositiveIdSchema,fact.runId);check(OpaqueIdSchema,fact.nativeEntryId);check(TimestampSchema,fact.at);
  const row=this.required(inputId);this.content(row);
  if(row.session_id!==fact.sessionId||row.target_run_id!==fact.runId)fail('state_conflict');
  if(row.status==='consumed'){if(row.run_id===fact.runId&&row.native_entry_id===fact.nativeEntryId)return;fail('state_conflict');}
  if(row.status==='cancelled'||row.status==='failed')fail('native_state_invalid');
  const run=this.db.query<{session_id:number;kind:string},[number]>('SELECT session_id,kind FROM runs WHERE id=?').get(fact.runId);
  if(!run||run.kind!=='agent'||run.session_id!==row.session_id||!this.content(row).deliveryAttempt)fail('state_conflict');
  if(this.db.query('SELECT id FROM session_inputs WHERE session_id=? AND native_entry_id=? AND id<>?').get(row.session_id,fact.nativeEntryId,row.id))fail('native_state_invalid');
  this.cas(row,'consumed',row.processing_status,fact.at,row.error_json,fact.runId,fact.nativeEntryId);
 }
 recordInputFailure(inputId:number,fact:Parameters<InputStore['recordInputFailure']>[1]):void {
  check(AppErrorSchema,fact.error);check(TimestampSchema,fact.at);const row=this.required(inputId);this.content(row);
  const proof=check(z.union([z.strictObject({kind:z.literal('not_consumed'),reason:z.enum(['hook_handled','dispatch_rejected','start_failed'])}),z.strictObject({kind:z.literal('delivery_unknown'),reason:z.enum(['append_failed','delivery_unconfirmed','remove_unconfirmed'])})]),fact.proof);
  if(row.session_id!==fact.sessionId||row.target_run_id!==fact.targetRunId||row.status==='consumed')fail('state_conflict');
  const status=proof.kind==='not_consumed'?'failed':'delivery_unknown',processing=proof.kind==='not_consumed'?'failed':'pending';
  const error=canonicalRequest(fact.error);
  if(row.status===status&&row.processing_status===processing&&row.error_json===error)return;
  if(row.processing_status!=='pending'||row.status==='cancelled'||row.status==='failed')fail('state_conflict');
  this.cas(row,status,processing,fact.at,error);
 }
 recordInputCancellation(proof:InputCancelProof,at:string):SessionInput {
  check(TimestampSchema,at);const row=this.required(proof.inputId);this.content(row);
  if(proof.kind==='unknown'){if(row.target_run_id===null)fail('state_conflict');this.recordInputFailure(row.id,{sessionId:row.session_id,targetRunId:row.target_run_id,at,error:proof.error,proof:{kind:'delivery_unknown',reason:'remove_unconfirmed'}});return this.projection(this.required(row.id));}
  check(PositiveIdSchema,proof.runId);if(row.target_run_id!==proof.runId)fail('state_conflict');
  if(proof.kind==='consumed'){if(row.status!=='consumed'||row.run_id!==proof.runId||row.native_entry_id!==proof.nativeEntryId)fail('native_state_invalid');return this.projection(row);}
  check(TimestampSchema,proof.at);if(proof.at!==at)fail('state_conflict');
  if(row.status==='consumed')return this.projection(row);
  if(row.status==='cancelled')return this.projection(row);
  if(row.processing_status!=='pending')fail('state_conflict');
  this.cas(row,'cancelled','cancelled',at,null);return this.projection(this.required(row.id));
 }
 readInput(input:ReadInputRequest):SessionInput|null {const r=check(ReadInputRequestSchema,input,'input_invalid');const row='inputId'in r?this.row(r.inputId):this.sequence(r.sessionId,r.clientSequence);return row?this.projection(row):null;}
 listInputs(input:ListInputsRequest):SessionInputPage {
  const r=check(ListInputsRequestSchema,input,'input_invalid');
  if(r.afterClientSequence!==null&&!this.sequence(r.sessionId,r.afterClientSequence))throw safeError('input_invalid',undefined,{reason:'input_cursor_invalid'});
  const rows=this.db.query<InputRow,[number,number,number]>('SELECT * FROM session_inputs WHERE session_id=? AND client_sequence>? ORDER BY client_sequence LIMIT ?').all(r.sessionId,r.afterClientSequence??0,r.limit+1);
  const items:SessionInput[]=[];let more=false;
  for(const row of rows){if(items.length===r.limit){more=true;break;}const item=this.projection(row);const next={sessionId:r.sessionId,items:[...items,item],hasMore:true,nextClientSequence:item.clientSequence};if(new TextEncoder().encode(JSON.stringify(next)).byteLength>MAX_INPUT_PAGE_BYTES){if(!items.length)fail('frame_too_large');more=true;break;}items.push(item);}
  return check(SessionInputPageSchema,{sessionId:r.sessionId,items,hasMore:more,nextClientSequence:more?items.at(-1)!.clientSequence:null},'storage_read_failed');
 }
 private runIdentity(runId: number): { session_id: number | null; input_id: number | null } {
  check(PositiveIdSchema, runId);
  return this.db.query<{ session_id: number | null; input_id: number | null }, [number]>(
   'SELECT session_id,input_id FROM runs WHERE id=?').get(runId) ?? fail('run_not_found');
 }
 /** Internal scans page by immutable ID; accepted input count is not a business limit. */
 *rowsForRun(runId: number): Generator<InputRow> {
  const run = this.runIdentity(runId);
  const page = this.db.query<InputRow, [number, number, number, number | null]>(
   'SELECT * FROM session_inputs WHERE id>? AND (target_run_id=? OR run_id=? OR id=?) ORDER BY id LIMIT 100');
  let afterId = 0;
  for (;;) {
   const rows = page.all(afterId, runId, runId, run.input_id);
   for (const row of rows) {
    if (row.session_id !== run.session_id || row.target_run_id !== runId) fail('storage_read_failed');
    yield row;
   }
   if (rows.length < 100) return;
   afterId = rows.at(-1)!.id;
  }
 }
 hasInputsForRun(runId: number): boolean {
  for (const _row of this.rowsForRun(runId)) return true;
  return false;
 }
 hasPendingInputsForRun(runId: number): boolean {
  for (const row of this.rowsForRun(runId)) if (row.processing_status === 'pending') return true;
  return false;
 }
 inputsForRun(runId: number): SessionInput[] {
  // This internal port explicitly returns an array; public IPC uses read/list bounded DTOs.
  return Array.from(this.rowsForRun(runId), row => this.projection(row));
 }
 settleRunInputs(runId: number, status: 'completed' | 'failed' | 'cancelled', at: string, proof: InputSettlementProof): void {
  check(TimestampSchema, at);
  if (!['completed', 'failed', 'cancelled'].includes(status) || proof.runId !== runId || !proof.admissionClosed
   || !proof.preflightSettled || !proof.nativeIdle || !proof.nativeQueuesEmpty || proof.pendingPersistence) fail('state_conflict');
  const run = this.runIdentity(runId);
  const unknown = new Set(proof.unconfirmedInputIds);
  if (status === 'completed' && unknown.size) fail('state_conflict');
  const belongsToRoot = (inputId: number) => {
   const row = this.required(inputId);
   if (row.session_id !== run.session_id || row.target_run_id !== runId) fail('state_conflict');
  };
  for (const inputId of unknown) belongsToRoot(inputId);
  const removals = new Map<number, Extract<InputCancelProof, { kind: 'removed' }>>();
  for (const removal of proof.removals) {
   if (removal.runId !== runId) fail('state_conflict');
   belongsToRoot(removal.inputId);
   const prior = removals.get(removal.inputId);
   if (prior && canonicalRequest(prior) !== canonicalRequest(removal)) fail('state_conflict');
   removals.set(removal.inputId, removal);
  }
  for (const row of this.rowsForRun(runId)) {
   const content = this.content(row);
   if (row.processing_status !== 'pending') continue;
   if (row.status === 'consumed') this.cas(row, 'consumed', status, at, row.error_json);
   else {
    const removal = removals.get(row.id);
    if (removal) this.recordInputCancellation(removal, removal.at);
    else if (row.status === 'queued' && content.deliveryAttempt === null && !unknown.has(row.id)) this.cas(row, 'cancelled', 'cancelled', at, row.error_json);
    else if (status === 'completed') fail('state_conflict');
    else this.cas(row, 'delivery_unknown', status, at, row.error_json ?? canonicalRequest(safeError('input_delivery_unknown', undefined, { runId })));
   }
  }
  if (this.hasPendingInputsForRun(runId)) fail('state_conflict');
 }
 verifyPriorInputFacts(runId: number, previousProcessExited: boolean, at: string) {
  check(TimestampSchema, at);
  let hasInputs = false;
  for (const row of this.rowsForRun(runId)) {
   hasInputs = true;
   if (!previousProcessExited) continue;
   const content = this.content(row);
   if (row.processing_status !== 'pending') continue;
   const error = canonicalRequest(safeError('runtime_interrupted', undefined, { runId }));
   if (row.status === 'consumed') this.cas(row, 'consumed', 'failed', at, error);
   else if (row.status !== 'delivery_unknown' && content.deliveryAttempt === null) this.cas(row, 'cancelled', 'cancelled', at, error);
   else this.cas(row, 'delivery_unknown', 'failed', at, error);
  }
  const pending = this.hasPendingInputsForRun(runId);
  return { inputsSettled: !pending && (previousProcessExited || !hasInputs), requiredPersistenceComplete: !pending,
   unconfirmedItems: pending ? ['input_persistence'] : !previousProcessExited && hasInputs ? ['input_source'] : [] };
 }
}
