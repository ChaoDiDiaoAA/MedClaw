import type { Database } from 'bun:sqlite';
import { canonicalRequest } from '../../contracts/src/run';
import { OpaqueIdSchema, PositiveIdSchema, safeError, serviceResult } from '../../contracts/src/error';
import { RevisionSchema } from '../../contracts/src/workspace';
import { NATIVE_HISTORY_FORMAT, type MemoryStore, type NativeHistorySnapshot, type NativeHistoryCommit, type InitialNativeHistory } from '../../contracts/src/session';
import type { EventWriter, WriteTransactions } from '../../contracts/src/event';
import { SqliteWriteTransactions } from './write-transactions';
import { SqliteEventStore } from './event-store';
import { RegisteredEventPayloadSchema } from '../../contracts/src/event';
import { readFrozenChild } from './child-identity';

type SessionRow={id:number;native_session_id:string;kind:string;status:string;native_header_json:string|null;history_format_version:string|null;current_leaf_id:string|null;storage_version:number};
type EntryRow={session_id:number;native_entry_id:string;parent_entry_id:string|null;sequence:number;entry_type:string;entry_json:string;run_id:number|null};
type EntryIdentity={id:string;parentId:string|null;type:string};
function invalid():never {throw safeError('session_history_invalid');}
function decode(text:string):unknown {try{return JSON.parse(text);}catch{return invalid();}}
function protect<T>(action:()=>T,fallback:'storage_read_failed'|'storage_write_failed'):T {
  try{return action();}catch(error){if(error instanceof Error&&error.name==='SQLiteError')throw safeError(fallback);throw error;}
}

/** SQLite owns the raw history; the injected runtime boundary validates locked SDK grammar. */
export class SqliteMemoryStore implements MemoryStore {
  private readonly events:EventWriter;
  constructor(private readonly db:Database,private readonly validate:(snapshot:NativeHistorySnapshot)=>NativeHistorySnapshot,
    events?:EventWriter,private readonly transactions:WriteTransactions=SqliteWriteTransactions.forDatabase(db),private readonly beforeCommit?:()=>void) {
    this.events=events??new SqliteEventStore(db);
  }
  private session(sessionId:number):SessionRow {
    PositiveIdSchema.parse(sessionId);
    const row=this.db.query<SessionRow,[number]>('SELECT * FROM sessions WHERE id=?').get(sessionId);
    if(!row)throw safeError('input_invalid',undefined,{reason:'session_not_found'});
    if(row.kind==='child') {
      const owner=this.db.query<{id:number},[number]>("SELECT id FROM runs WHERE session_id=? AND kind='child'").get(row.id);
      if(!owner||readFrozenChild(this.db,owner.id).childSessionId!==row.id)throw safeError('access_denied');
    } else if(row.kind!=='user')throw safeError('access_denied');return row;
  }
  private rows(sessionId:number):EntryRow[] {return this.db.query<EntryRow,[number]>('SELECT * FROM memories WHERE session_id=? ORDER BY sequence').all(sessionId);}
  private read(session:SessionRow):NativeHistorySnapshot {
    if(session.native_header_json===null||session.history_format_version!==NATIVE_HISTORY_FORMAT||session.storage_version<1) invalid();
    const rows=this.rows(session.id),entries=rows.map((row,i)=>{
      const value=decode(row.entry_json) as EntryIdentity;
      if(!value||row.sequence!==i+1||value.id!==row.native_entry_id||value.parentId!==row.parent_entry_id||value.type!==row.entry_type)invalid();
      if(row.run_id!==null&&!this.db.query("SELECT id FROM runs WHERE id=? AND session_id=? AND kind=?").get(row.run_id,session.id,session.kind==='child'?'child':'agent'))invalid();
      if(session.kind==='child'&&row.run_id===null)invalid();
      return value;
    });
    return this.validate({sessionId:session.id,nativeSessionId:session.native_session_id,header:decode(session.native_header_json),entries,activeLeafId:session.current_leaf_id,storageVersion:session.storage_version});
  }
  load(sessionId:number) {
    return serviceResult(()=>protect(()=>this.db.transaction(()=>this.read(this.session(sessionId))).deferred(),'storage_read_failed'),'storage_read_failed',{sessionId});
  }
  /** Internal shared-snapshot read for checkpoint validation; no extra public MemoryStore responsibility. */
  loadInTransaction(sessionId:number):NativeHistorySnapshot {
    if(!this.db.inTransaction)throw safeError('state_conflict');
    return protect(()=>this.read(this.session(sessionId)),'storage_read_failed');
  }
  listEntries(sessionId:number,afterSequence:number,limit:number) {
    return serviceResult(()=>protect(()=>{
      RevisionSchema.parse(afterSequence);PositiveIdSchema.max(100).parse(limit);
      return this.db.transaction(()=>this.read(this.session(sessionId)).entries.slice(afterSequence,afterSequence+limit)).deferred();
    },'storage_read_failed'),'storage_read_failed',{sessionId});
  }
  commit(change:NativeHistoryCommit) {
    return serviceResult(()=>protect(()=>this.transactions.immediate(()=>{
      const result=this.commitInTransaction(change);this.beforeCommit?.();return result;
    }),'storage_write_failed'),'storage_write_failed',{sessionId:change.sessionId,...(change.runId!==null?{runId:change.runId}:{})});
  }
  /** Initial SDK model/thinking entries belong to the same version-1 child registration. */
  initializeChildInTransaction(sessionId:number,runId:number,history:InitialNativeHistory):void {
    this.transactions.assertActive();
    const session=this.session(sessionId);
    if(session.kind!=='child'||session.storage_version!==1||session.current_leaf_id!==null||this.rows(sessionId).length
      ||readFrozenChild(this.db,runId).childSessionId!==sessionId)throw safeError('state_conflict');
    const initial=this.validate({sessionId,nativeSessionId:session.native_session_id,header:history.header,entries:history.entries,activeLeafId:history.activeLeafId,storageVersion:1});
    if(canonicalRequest(initial.header)!==canonicalRequest(decode(session.native_header_json!))
      ||initial.entries.some(value=>!['model_change','thinking_level_change'].includes((value as EntryIdentity).type)))invalid();
    for(const [index,value] of initial.entries.entries()) {
      const entry=value as EntryIdentity;
      this.db.query('INSERT INTO memories(session_id,native_entry_id,parent_entry_id,sequence,entry_type,entry_json,run_id,recorded_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(sessionId,entry.id,entry.parentId,index+1,entry.type,canonicalRequest(value),runId,new Date().toISOString());
    }
    this.db.query('UPDATE sessions SET current_leaf_id=? WHERE id=?').run(initial.activeLeafId,sessionId);
  }
  commitInTransaction(change:NativeHistoryCommit):{storageVersion:number} {
    this.transactions.assertActive();
    return protect(()=>{
      const session=this.session(change.sessionId);
      if(session.status!=='active')throw safeError('state_conflict',undefined,{reason:'session_deleted'});
      RevisionSchema.parse(change.expectedStorageVersion);
      if(session.storage_version!==change.expectedStorageVersion)throw safeError('state_conflict',undefined,{reason:'history_version_mismatch'});
      if(change.runId!==null) {
        PositiveIdSchema.parse(change.runId);
        if(!this.db.query("SELECT id FROM runs WHERE id=? AND session_id=? AND kind=?").get(change.runId,session.id,session.kind==='child'?'child':'agent'))throw safeError('access_denied');
      } else if(session.kind==='child')throw safeError('access_denied');
      const old=this.read(session), oldById=new Map(old.entries.map(value=>[(value as EntryIdentity).id,value]));
      if(!Array.isArray(change.newEntries))invalid();
      const incoming=new Map<string,unknown>();
      for(const value of change.newEntries) {
        const id=(value as EntryIdentity|null)?.id;
        if(!OpaqueIdSchema.safeParse(id).success||incoming.has(id!))invalid();incoming.set(id!,value);
      }
      // Validate replacements too, before deciding whether an ID is an idempotent duplicate.
      const proposed=this.validate({...old,header:change.header,entries:[...oldById].map(([id,value])=>incoming.get(id)??value).concat([...incoming].filter(([id])=>!oldById.has(id)).map(([,value])=>value)),activeLeafId:change.activeLeafId});
      if(canonicalRequest(proposed.header)!==canonicalRequest(old.header))invalid();
      const proposedById=new Map(proposed.entries.map(value=>[(value as EntryIdentity).id,value]));
      for(const [id,value]of oldById)if(canonicalRequest(value)!==canonicalRequest(proposedById.get(id)))invalid();
      const added=proposed.entries.filter(value=>!oldById.has((value as EntryIdentity).id));
      if(!added.length&&old.activeLeafId===proposed.activeLeafId)return {storageVersion:session.storage_version};
      if(session.storage_version===Number.MAX_SAFE_INTEGER)throw safeError('state_conflict',undefined,{reason:'history_version_mismatch'});
      const at=new Date().toISOString();
      for(const [i,value]of added.entries()) {
        const entry=value as EntryIdentity;
        this.db.query('INSERT INTO memories(session_id,native_entry_id,parent_entry_id,sequence,entry_type,entry_json,run_id,recorded_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(session.id,entry.id,entry.parentId,old.entries.length+i+1,entry.type,canonicalRequest(value),change.runId,at);
      }
      const storageVersion=session.storage_version+1;
      if(this.db.query('UPDATE sessions SET current_leaf_id=?,storage_version=?,updated_at=? WHERE id=? AND storage_version=?').run(proposed.activeLeafId,storageVersion,at,session.id,session.storage_version).changes!==1)throw safeError('state_conflict',undefined,{reason:'history_version_mismatch'});
      if(change.runId!==null)this.events.appendInTransaction({runId:change.runId,sessionId:session.id,type:'history_saved',source:'pi',sourceConnection:null,sourceSequence:null,toolCallId:null,
        payload:{contract:'medclaw.event/v1',storageVersion,nativeLeafId:proposed.activeLeafId},occurredAt:at,receivedAt:at});
      return {storageVersion};
    },'storage_write_failed');
  }
  /** Original commit proof, including after a later position change; never weakens commit's CAS. */
  confirmCommitted(change:NativeHistoryCommit):{storageVersion:number}|null {
    return protect(()=>{
      const session=this.session(change.sessionId),snapshot=this.read(session);
      if(canonicalRequest(snapshot.header)!==canonicalRequest(change.header)||session.storage_version<change.expectedStorageVersion)return null;
      for(const value of change.newEntries) {
        const row=this.db.query<EntryRow,[number,string]>('SELECT * FROM memories WHERE session_id=? AND native_entry_id=?').get(session.id,(value as EntryIdentity).id);
        if(!row||canonicalRequest(decode(row.entry_json))!==canonicalRequest(value)||row.run_id!==change.runId)return null;
      }
      const version=change.expectedStorageVersion+1;
      if(change.runId!==null) {
        const events=this.db.query<{payload_json:string},[number,number,number,number,string|null]>(`SELECT payload_json FROM runtime_events WHERE run_id=? AND session_id=? AND source='pi' AND type='history_saved'
          AND json_extract(payload_json,'$.storageVersion') IN (?,?) AND json_extract(payload_json,'$.nativeLeafId') IS ? ORDER BY id DESC`).all(change.runId,session.id,version,change.expectedStorageVersion,change.activeLeafId);
        for(const event of events) {
          const parsed=RegisteredEventPayloadSchema.safeParse({type:'history_saved',payload:decode(event.payload_json)});
          if(parsed.success&&parsed.data.type==='history_saved'&&session.storage_version>=parsed.data.payload.storageVersion
            &&(parsed.data.payload.storageVersion===version||!change.newEntries.length))return {storageVersion:parsed.data.payload.storageVersion};
        }
      } else if(session.storage_version===version&&snapshot.activeLeafId===change.activeLeafId)return {storageVersion:version};
      if(!change.newEntries.length&&session.storage_version===change.expectedStorageVersion&&snapshot.activeLeafId===change.activeLeafId)return {storageVersion:session.storage_version};
      return null;
    },'storage_read_failed');
  }
}
