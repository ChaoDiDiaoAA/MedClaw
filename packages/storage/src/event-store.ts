import type { Database } from 'bun:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { RegisteredEventDraftSchema, StoredRunEventSchema, EVENT_LIMITS, type EventStore, type RegisteredEventDraft, type StoredRunEvent, type EventRange } from '../../contracts/src/event';
import { safeError } from '../../contracts/src/error';
import { SqliteWriteTransactions } from './write-transactions';
type Row={id:number;run_id:number;session_id:number;sequence:number;type:string;source:string;source_connection:string|null;source_sequence:number|null;tool_call_id:number|null;payload_json:string;occurred_at:string;received_at:string};
function fail(code:'storage_write_failed'|'storage_read_failed'|'state_conflict'):never{throw Object.assign(new Error(code),{appError:safeError(code)});}
export class SqliteEventStore implements EventStore {
 constructor(private readonly db:Database,private readonly transactions=SqliteWriteTransactions.forDatabase(db)){}
 private project(row:Row):StoredRunEvent {try{return StoredRunEventSchema.parse({eventId:row.id,runId:row.run_id,sessionId:row.session_id,sequence:row.sequence,type:row.type,source:row.source,sourceConnection:row.source_connection,sourceSequence:row.source_sequence,toolCallId:row.tool_call_id,payload:JSON.parse(row.payload_json),occurredAt:row.occurred_at,receivedAt:row.received_at});}catch{fail('storage_read_failed');}}
 private owner(draft:RegisteredEventDraft,code:'storage_write_failed'|'storage_read_failed') {
  const identity=this.readRunIdentity(draft.runId);if(!identity||identity.sessionId!==draft.sessionId)fail(code);
  const owned=(table:string,id:number)=>!!this.db.query(`SELECT id FROM ${table} WHERE id=? AND run_id=? AND session_id=?`).get(id,draft.runId,draft.sessionId);
  if(draft.toolCallId!==null&&!owned('tool_calls',draft.toolCallId))fail(code);
  const p=draft.payload;
  if(draft.type==='history_saved') {
   const history=this.db.query<{storage_version:number;current_leaf_id:string|null;native_header_json:string|null},[number]>('SELECT storage_version,current_leaf_id,native_header_json FROM sessions WHERE id=?').get(draft.sessionId);
   if(!history?.native_header_json||draft.payload.storageVersion>history.storage_version)fail(code);
   if(draft.payload.nativeLeafId!==null&&!this.db.query('SELECT id FROM memories WHERE session_id=? AND native_entry_id=?').get(draft.sessionId,draft.payload.nativeLeafId))fail(code);
   // Writes prove the committing position. Later reads prove the original event, not the current branch.
   if(code==='storage_write_failed'&&(draft.payload.storageVersion!==history.storage_version||draft.payload.nativeLeafId!==history.current_leaf_id))fail(code);
  }
  if(draft.type==='context_delivered'&&!this.db.query(`SELECT d.id FROM context_deliveries d JOIN model_calls c ON c.id=d.model_call_id WHERE d.snapshot_id=? AND c.call_id=? AND d.run_id=? AND d.session_id=?`).get(draft.payload.snapshotId,draft.payload.callId,draft.runId,draft.sessionId))fail(code);
  if('inputId' in p){const row=this.db.query<{run_id:number|null;target_run_id:number|null},[number,number]>('SELECT run_id,target_run_id FROM session_inputs WHERE id=? AND session_id=?').get(p.inputId,draft.sessionId);if(!row||(row.run_id??row.target_run_id)!==draft.runId||p.runId!==null&&row.run_id!==p.runId||p.targetRunId!==null&&row.target_run_id!==p.targetRunId)fail(code);}
  if('answerId' in p&&p.answerId!==null&&!owned('answers',p.answerId))fail(code);
  if('queryId' in p&&!owned('queries',p.queryId))fail(code);
  if('queryIds' in p&&p.queryIds.some(id=>!owned('queries',id)))fail(code);
  if('batchIds' in p&&p.batchIds.some(id=>!this.db.query('SELECT id FROM batches WHERE id=?').get(id)))fail(code);
  if('nativeToolCallId' in p){const row=this.db.query<{native_tool_call_id:string},[number]>('SELECT native_tool_call_id FROM tool_calls WHERE id=?').get(p.callId);if(row?.native_tool_call_id!==p.nativeToolCallId)fail(code);}
 }
 appendInTransaction(input:RegisteredEventDraft):StoredRunEvent {
  this.transactions.assertActive();const parsed=RegisteredEventDraftSchema.safeParse(input);if(!parsed.success)fail('storage_write_failed');const draft=parsed.data;this.owner(draft,'storage_write_failed');
  if(draft.sourceConnection!==null){const old=this.db.query<Row,[string,number]>('SELECT * FROM runtime_events WHERE source_connection=? AND source_sequence=?').get(draft.sourceConnection,draft.sourceSequence!);if(old){const event=this.project(old);const {eventId:_id,sequence:_seq,receivedAt:_received,...fact}=event;const {receivedAt:_newReceived,...incoming}=draft;if(!isDeepStrictEqual(fact,incoming))fail('state_conflict');return event;}}
  const sequence=this.range(draft.runId).lastSequence+1;if(!Number.isSafeInteger(sequence))fail('storage_write_failed');
  try{const row=this.db.query('INSERT INTO runtime_events(run_id,session_id,sequence,type,source,source_connection,source_sequence,tool_call_id,payload_json,occurred_at,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(draft.runId,draft.sessionId,sequence,draft.type,draft.source,draft.sourceConnection,draft.sourceSequence,draft.toolCallId,JSON.stringify(draft.payload),draft.occurredAt,draft.receivedAt);return StoredRunEventSchema.parse({...draft,eventId:Number(row.lastInsertRowid),sequence});}catch{fail('storage_write_failed');}
 }
 readRunIdentity(runId:number) {return this.db.query<{runId:number;sessionId:number|null},[number]>('SELECT id runId,session_id sessionId FROM runs WHERE id=?').get(runId);}
 range(runId:number):EventRange {return this.db.query<EventRange,[number]>('SELECT MIN(sequence) firstSequence,COALESCE(MAX(sequence),0) lastSequence FROM runtime_events WHERE run_id=?').get(runId)!;}
 readWindow(input:{runId:number;afterSequence:number;throughSequence:number;limit:number}):StoredRunEvent[]{
  return this.db.transaction(()=>{
   const {runId,afterSequence,throughSequence,limit}=input;
   const count=this.db.query<{n:number},[number,number,number]>('SELECT COUNT(*) n FROM runtime_events WHERE run_id=? AND sequence>? AND sequence<=?').get(runId,afterSequence,throughSequence)!.n;
   if(count!==throughSequence-afterSequence){const range=this.range(runId);let previous=afterSequence;let resumeAfterSequence:number|null=null;for(const row of this.db.query<{sequence:number},[number,number,number]>('SELECT sequence FROM runtime_events WHERE run_id=? AND sequence>? AND sequence<=? ORDER BY sequence').all(runId,afterSequence,throughSequence)){if(row.sequence!==previous+1){resumeAfterSequence=row.sequence-1;break;}previous=row.sequence;}if(resumeAfterSequence===null){const later=this.db.query<{sequence:number},[number,number]>('SELECT sequence FROM runtime_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT 1').get(runId,previous);resumeAfterSequence=later?later.sequence-1:null;}throw Object.assign(new Error('event_gap'),{appError:safeError('event_gap',undefined,{eventRange:{runId,...range,resumeAfterSequence}})});}
   const rows=this.db.query<Row,[number,number,number,number]>('SELECT * FROM runtime_events WHERE run_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(runId,afterSequence,throughSequence,limit);const events:StoredRunEvent[]=[];
   for(const row of rows){const event=this.project(row);this.owner(event,'storage_read_failed');events.push(event);if(Buffer.byteLength(JSON.stringify(events),'utf8')>EVENT_LIMITS.pageBytes-2048){events.pop();break;}}
   return events;
  }).deferred();
 }
}
