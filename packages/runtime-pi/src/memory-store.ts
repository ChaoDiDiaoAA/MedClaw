import { z } from 'zod';
import { SessionManager, type SessionEntry, type SessionHeader } from '@earendil-works/pi-coding-agent';
import { AppErrorSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema, safeError, type AppError } from '../../contracts/src/error';
import { RevisionSchema } from '../../contracts/src/workspace';
import { canonicalRequest } from '../../contracts/src/run';
import type { NativeHistorySnapshot, NativeHistoryCommit } from '../../contracts/src/session';
import type { NativeHistoryContext } from '../../contracts/src/context';
import type { ReadSessionMessagesInput, SessionMessagePage } from '../../contracts/src/messages';
import { projectSessionMessages } from './messages';
export { NATIVE_HISTORY_FORMAT } from '../../contracts/src/session';
export type PiHistorySnapshot = Omit<NativeHistorySnapshot,'header'|'entries'> & {header:SessionHeader;entries:SessionEntry[]};
export type PiHistoryCommit = Omit<NativeHistoryCommit,'header'|'newEntries'> & {header:SessionHeader;newEntries:SessionEntry[]};
function invalid():never {throw safeError('session_history_invalid');}
const text = z.string(), name = text.min(1), number = z.number().finite().nonnegative();
const textBlock = z.object({type:z.literal('text'),text,textSignature:text.optional()}).passthrough();
const imageBlock = z.object({type:z.literal('image'),data:text,mimeType:name}).passthrough();
const thinkingBlock = z.object({type:z.literal('thinking'),thinking:text,thinkingSignature:text.optional(),redacted:z.boolean().optional()}).passthrough();
const toolBlock = z.object({type:z.literal('toolCall'),id:name.max(256),name,arguments:z.record(text,z.unknown()),thoughtSignature:text.optional(),namespace:text.optional()}).passthrough();
const userContent = z.union([text,z.array(z.union([textBlock,imageBlock]))]);
const assistantContent = z.array(z.union([textBlock,thinkingBlock,toolBlock]));
const resultContent = z.array(z.union([textBlock,imageBlock]));
const usage = z.object({input:number,output:number,cacheRead:number,cacheWrite:number,totalTokens:number,cacheWrite1h:number.optional(),reasoning:number.optional(),
  cost:z.object({input:number,output:number,cacheRead:number,cacheWrite:number,total:number}).passthrough()}).passthrough();
const messageTime={timestamp:number};
const message = z.discriminatedUnion('role',[
  z.object({role:z.literal('user'),content:userContent,...messageTime}).passthrough(),
  z.object({role:z.literal('assistant'),content:assistantContent,api:name,provider:name,model:name,usage,stopReason:z.enum(['pending','stop','length','toolUse','error','aborted','deferred']),...messageTime,
    responseModel:text.optional(),responseId:text.optional(),errorMessage:text.optional(),rawStopReason:text.optional(),endTurn:z.boolean().optional(),providerThinkingLevel:text.optional()}).passthrough(),
  z.object({role:z.literal('toolResult'),toolCallId:name.max(256),toolName:name,content:resultContent,isError:z.boolean(),...messageTime}).passthrough(),
  z.object({role:z.literal('system'),content:z.union([text,z.array(textBlock)]),sections:z.record(text,text.nullable()).optional(),toolsAdded:z.array(z.object({name,description:text,parameters:z.unknown()}).passthrough()).optional(),toolsRemoved:z.array(z.unknown()).optional(),...messageTime}).passthrough(),
  z.object({role:z.literal('custom'),customType:name,content:userContent,display:z.boolean(),...messageTime}).passthrough(),
  z.object({role:z.literal('bashExecution'),command:text,output:text,exitCode:z.number().int().optional(),cancelled:z.boolean(),truncated:z.boolean(),fullOutputPath:text.optional(),excludeFromContext:z.boolean().optional(),...messageTime}).passthrough(),
]);
const base={id:OpaqueIdSchema,parentId:OpaqueIdSchema.nullable(),timestamp:TimestampSchema};
const entry = z.discriminatedUnion('type',[
  z.object({...base,type:z.literal('message'),message}).passthrough(),
  z.object({...base,type:z.literal('thinking_level_change'),thinkingLevel:name}).passthrough(),
  z.object({...base,type:z.literal('model_change'),provider:name,modelId:name}).passthrough(),
  z.object({...base,type:z.literal('usage'),kind:name,provider:name,model:name,usage,note:text.optional()}).passthrough(),
  z.object({...base,type:z.literal('compaction'),summary:text,firstKeptEntryId:OpaqueIdSchema,tokensBefore:number,usage:usage.optional(),fromHook:z.boolean().optional()}).passthrough(),
  z.object({...base,type:z.literal('branch_summary'),fromId:OpaqueIdSchema,summary:text,usage:usage.optional(),fromHook:z.boolean().optional()}).passthrough(),
  z.object({...base,type:z.literal('custom'),customType:name}).passthrough(),
  z.object({...base,type:z.literal('custom_message'),customType:name,content:userContent,display:z.boolean()}).passthrough(),
  z.object({...base,type:z.literal('context_edit'),targetId:OpaqueIdSchema,replacement:z.object({content:z.union([userContent,assistantContent,resultContent])}).passthrough().nullable()}).passthrough(),
  z.object({...base,type:z.literal('label'),targetId:OpaqueIdSchema,label:text.optional()}).passthrough(),
  z.object({...base,type:z.literal('session_info'),name:text.optional()}).passthrough(),
]);
const header = z.object({type:z.literal('session'),version:z.literal(3),id:OpaqueIdSchema,timestamp:TimestampSchema,cwd:text,parentSession:text.optional()}).passthrough();

/** JSON optional object fields are omitted; arrays, cycles and non-finite values never silently change. */
export function nativeHistoryJSON(value:unknown):string {
  const visiting=new Set<object>();
  const visit=(item:unknown):void => {
    if(item===null||typeof item==='string'||typeof item==='boolean') return;
    if(typeof item==='number') {if(!Number.isFinite(item)) invalid();return;}
    if(typeof item!=='object'||visiting.has(item)) invalid();
    const proto=Object.getPrototypeOf(item); if(!Array.isArray(item)&&proto!==Object.prototype&&proto!==null) invalid();
    if(Object.getOwnPropertySymbols(item).length) invalid(); visiting.add(item);
    if(Array.isArray(item)) {for(let i=0;i<item.length;i++){if(!(i in item)) invalid();visit(item[i]);}}
    else for(const field of Object.values(item)) if(field!==undefined) visit(field);
    visiting.delete(item);
  };
  try {visit(value);return canonicalRequest(value);} catch {return invalid();}
}

/** Validates raw grammar and references, never constructs its own model context. */
export function validateNativeHistory(raw:NativeHistorySnapshot):PiHistorySnapshot {
  try {
    const value=JSON.parse(nativeHistoryJSON(raw)) as NativeHistorySnapshot;
    PositiveIdSchema.parse(value.sessionId); OpaqueIdSchema.parse(value.nativeSessionId); RevisionSchema.parse(value.storageVersion);
    const h=header.parse(value.header); if(h.id!==value.nativeSessionId) invalid();
    if(!Array.isArray(value.entries)) invalid();
    const entries=value.entries.map(item=>entry.parse(item) as SessionEntry), byId=new Map<string,SessionEntry>();
    // ponytail: O(history * depth) reference checks; add ancestor indexing only after measuring long sessions.
    const ancestor=(parent:string|null,target:string) => {while(parent!==null){if(parent===target)return true;parent=byId.get(parent)!.parentId;}return false;};
    for(const item of entries) {
      if(byId.has(item.id)||item.parentId!==null&&!byId.has(item.parentId)) invalid();
      if(item.type==='compaction'&&item.firstKeptEntryId!==item.id&&!ancestor(item.parentId,item.firstKeptEntryId)) invalid();
      if(item.type==='branch_summary'&&item.fromId!=='root'&&!byId.has(item.fromId)) invalid();
      if(item.type==='label'&&!byId.has(item.targetId)) invalid();
      if(item.type==='context_edit') {
        const target=byId.get(item.targetId); if(!target||!ancestor(item.parentId,item.targetId)) invalid();
        if(target.type!=='custom_message'&&(target.type!=='message'||!['user','assistant','toolResult'].includes(target.message.role))) invalid();
        if(item.replacement!==null) {
          const content=target.type==='message'&&target.message.role==='assistant'?assistantContent:target.type==='message'&&target.message.role==='toolResult'?resultContent:userContent;
          content.parse(item.replacement.content);
        }
      }
      byId.set(item.id,item);
    }
    if(value.activeLeafId!==null&&(!OpaqueIdSchema.safeParse(value.activeLeafId).success||!byId.has(value.activeLeafId))) invalid();
    return {...value,header:h,entries};
  } catch {return invalid();}
}

export function restoreNativeManager(raw:NativeHistorySnapshot,cwd:string):SessionManager {
  const snapshot=validateNativeHistory(raw);
  const manager=SessionManager.inMemory(cwd,undefined,[structuredClone(snapshot.header),...structuredClone(snapshot.entries)]);
  if(snapshot.activeLeafId===null) manager.resetLeaf(); else manager.branch(snapshot.activeLeafId);
  if(manager.getSessionId()!==snapshot.nativeSessionId||manager.getLeafId()!==snapshot.activeLeafId
    ||nativeHistoryJSON(manager.getHeader())!==nativeHistoryJSON(snapshot.header)||nativeHistoryJSON(manager.getEntries())!==nativeHistoryJSON(snapshot.entries)) invalid();
  return manager;
}

export function projectSavedMessages(snapshot:NativeHistorySnapshot,input:ReadSessionMessagesInput,cwd:string):SessionMessagePage {
  if(input.sessionId!==snapshot.sessionId)throw safeError('access_denied');
  const manager=restoreNativeManager(snapshot,cwd);
  return {...projectSessionMessages(manager,input,new Map()),source:'sqlite_history'};
}

const mutations=['appendMessage','appendThinkingLevelChange','appendModelChange','appendUsage','appendCompaction','appendCustomEntry','appendSessionInfo','appendCustomMessageEntry','appendContextEdit','appendLabelChange','branchWithSummary','branch','resetLeaf'] as const;
type MemoryOptions={snapshot:NativeHistorySnapshot;getRunId:()=>number|null;commitSync:(change:PiHistoryCommit)=>{storageVersion:number};onFailure:(error:AppError)=>void};
const isCandidate=(entry:SessionEntry)=>entry.type==='message'&&entry.message.role==='assistant'&&!entry.message.content.some(part=>part.type==='toolCall');

/** Public-method observation preserves original arguments, return values and outer InputAdapter identity. */
export class PiMemoryAdapter {
  private saved:PiHistorySnapshot;
  private observed:PiHistorySnapshot;
  private heldFrom:number|null=null;
  private pending:PiHistoryCommit|null=null;
  private final:{runId:number;snapshot:PiHistorySnapshot}|null=null;
  private releasedRunId:number|null=null;
  private readonly wrappers=new Map<typeof mutations[number],{original:Function;wrapped:Function}>();
  private depth=0;
  private disposed=false;
  private reported=false;
  private lastAcknowledgement:{identity:string;storageVersion:number}|null=null;
  private compaction:string|null=null;
  get compactionOperationRef():string|null{return this.compaction;}
  constructor(private readonly manager:SessionManager,private readonly options:MemoryOptions) {
    this.saved=validateNativeHistory(options.snapshot);this.observed=this.snapshot();
    if(nativeHistoryJSON(this.saved)!==nativeHistoryJSON(this.observed))invalid();
    for(const method of mutations) {
      const original=manager[method];
      const wrapped=(...args:unknown[])=>{
        if(this.disposed||this.final)throw safeError('state_conflict');
        // SDK may still append its aborted final assistant while unwinding. It cannot consume another input.
        const message=method==='appendMessage'?args[0] as {role?:string;content?:{type:string}[]}|undefined:undefined;
        if(this.pending&&!(message?.role==='assistant'&&Array.isArray(message.content)&&!message.content.some(part=>part.type==='toolCall')))throw safeError('storage_write_failed');
        const before=this.manager.getEntries().length,leaf=this.manager.getLeafId();let succeeded=false;
        this.depth++;
        try {const result=Reflect.apply(original,this.manager,args);succeeded=true;return result;}
        finally {
          this.depth--;
          if(this.depth===0) {
            try {
              this.observe();
              if(!succeeded&&(before!==this.manager.getEntries().length||leaf!==this.manager.getLeafId()))invalid();
            }catch(error){this.failure(error);throw error;}
          }
        }
      };
      this.wrappers.set(method,{original,wrapped});Reflect.set(manager,method,wrapped);
    }
  }
  private snapshot():PiHistorySnapshot {
    return validateNativeHistory({...this.saved,header:this.manager.getHeader(),entries:this.manager.getEntries(),activeLeafId:this.manager.getLeafId()});
  }
  private failure(native:unknown):void {
    if(this.reported)return;this.reported=true;
    const parsed=AppErrorSchema.safeParse(native),error=parsed.success?parsed.data:safeError(native instanceof Error?native.message:'session_history_invalid');
    try {this.options.onFailure(error);}catch{/* Isolation reporting cannot erase the original persistence failure. */}
  }
  private observe():void {
    const current=this.snapshot(),from=this.observed.entries.length;
    // ponytail: Full append-only comparison is O(history); add indexed comparison only after measuring a bottleneck.
    if(current.entries.length<from||nativeHistoryJSON(current.header)!==nativeHistoryJSON(this.observed.header)
      ||nativeHistoryJSON(current.entries.slice(0,from))!==nativeHistoryJSON(this.observed.entries))invalid();
    this.observed=current;
    if(this.pending||this.compaction)return;
    for(let i=from;i<current.entries.length;i++) {
      const entry=current.entries[i]!;
      if(this.heldFrom!==null&&entry.type==='message'&&['user','toolResult','assistant'].includes(entry.message.role)) {
        this.persist(current.entries.slice(0,i),entry.parentId);this.heldFrom=null;
      }
      if(this.options.getRunId()!==null&&isCandidate(entry))this.heldFrom=i;
    }
    if(this.heldFrom===null)this.persist(current.entries,current.activeLeafId);
    else this.persist(current.entries.slice(0,this.heldFrom),current.entries[this.heldFrom]!.parentId);
  }
  private change(entries:SessionEntry[],leaf:string|null,runId=this.options.getRunId()):PiHistoryCommit {
    return {sessionId:this.saved.sessionId,runId,expectedStorageVersion:this.saved.storageVersion,header:structuredClone(this.saved.header),
      newEntries:structuredClone(entries.slice(this.saved.entries.length)),activeLeafId:leaf};
  }
  private persist(entries:SessionEntry[],leaf:string|null):void {
    if(entries.length===this.saved.entries.length&&leaf===this.saved.activeLeafId)return;
    const change=this.change(entries,leaf);
    try {const result=this.options.commitSync(structuredClone(change));this.acknowledgeSaved(change,result.storageVersion);}
    catch(error){this.pending??=change;this.failure(error);throw error;}
  }
  flushBeforeRequest():void {
    if(this.pending||this.compaction)throw safeError('storage_write_failed');
    this.persist(this.observed.entries,this.observed.activeLeafId);this.heldFrom=null;
  }
  beginCompaction(operationRef:string):void {
    OpaqueIdSchema.parse(operationRef);
    if(this.pending||this.final)throw safeError('storage_write_failed');
    if(this.compaction&&this.compaction!==operationRef)throw safeError('state_conflict');
    this.compaction=operationRef;
  }
  readCompactionCommit(operationRef:string):PiHistoryCommit {
    if(this.compaction!==operationRef||this.pending)throw safeError('storage_write_failed');
    return this.change(this.observed.entries,this.observed.activeLeafId);
  }
  acknowledgeCompaction(change:PiHistoryCommit,storageVersion:number):void {
    if(!this.compaction)throw safeError('state_conflict');
    this.acknowledgeSaved(change,storageVersion);
    this.compaction=null;
  }
  readSavedContext():NativeHistoryContext {
    const branch=restoreNativeManager(this.saved,this.manager.getHeader()!.cwd).getBranch();
    return {contract:'medclaw.native-history-context/v1',leafId:this.saved.activeLeafId,storageVersion:this.saved.storageVersion,
      compactionEntryIds:branch.filter(entry=>entry.type==='compaction').map(entry=>entry.id)};
  }
  isSavedInputOnBranch(nativeEntryId:string,text:string):boolean {
    const branch=restoreNativeManager(this.saved,this.manager.getHeader()!.cwd).getBranch();
    const entry=branch.find(entry=>entry.id===nativeEntryId);
    if(entry?.type!=='message'||entry.message.role!=='user')return false;
    const content=entry.message.content,original=typeof content==='string'?content:content.filter(part=>part.type==='text').map(part=>part.text).join('');
    return original===text&&!branch.some(entry=>entry.type==='context_edit'&&entry.targetId===nativeEntryId);
  }
  isSavedSummarizedInput(nativeEntryId:string):boolean {
    const manager=restoreNativeManager(this.saved,this.manager.getHeader()!.cwd),branch=manager.getBranch();
    const input=branch.findIndex(entry=>entry.id===nativeEntryId);
    if(input<0||branch.some(entry=>entry.type==='context_edit'&&entry.targetId===nativeEntryId))return false;
    const latest=branch.findLastIndex(entry=>entry.type==='compaction');
    if(latest<0)return false;
    const compaction=branch[latest]!;
    return compaction.type==='compaction'&&input<branch.findIndex(entry=>entry.id===compaction.firstKeptEntryId);
  }
  freezeFinal(runId:number):PiHistoryCommit {
    PositiveIdSchema.parse(runId);
    if(this.final&&this.final.runId!==runId)throw safeError('state_conflict');
    if(this.options.getRunId()!==null&&this.options.getRunId()!==runId)throw safeError('state_conflict');
    this.final??={runId,snapshot:structuredClone(this.observed)};
    return this.change(this.final.snapshot.entries,this.final.snapshot.activeLeafId,runId);
  }
  releaseFinal(runId:number):void {
    if(!this.final&&this.releasedRunId===runId)return;
    if(!this.final||this.final.runId!==runId)throw safeError('state_conflict');
    if(this.pending||this.saved.activeLeafId!==this.final.snapshot.activeLeafId||nativeHistoryJSON(this.saved.entries)!==nativeHistoryJSON(this.final.snapshot.entries))throw safeError('storage_write_failed');
    this.final=null;this.releasedRunId=runId;
  }
  acknowledgeSaved(change:PiHistoryCommit,storageVersion:number):void {
    const identity=nativeHistoryJSON(change);
    if(this.lastAcknowledgement?.identity===identity&&this.lastAcknowledgement.storageVersion===storageVersion)return;
    if(change.sessionId!==this.saved.sessionId||change.expectedStorageVersion!==this.saved.storageVersion||nativeHistoryJSON(change.header)!==nativeHistoryJSON(this.saved.header))invalid();
    const next=validateNativeHistory({...this.saved,entries:[...this.saved.entries,...change.newEntries],activeLeafId:change.activeLeafId,storageVersion});
    if(storageVersion!==this.saved.storageVersion+(change.newEntries.length||change.activeLeafId!==this.saved.activeLeafId?1:0)
      ||nativeHistoryJSON(next.entries)!==nativeHistoryJSON(this.observed.entries.slice(0,next.entries.length)))invalid();
    this.saved=next;this.lastAcknowledgement={identity,storageVersion};
    if(this.compaction&&nativeHistoryJSON(next.entries)===nativeHistoryJSON(this.observed.entries)&&next.activeLeafId===this.observed.activeLeafId)this.compaction=null;
    if(this.heldFrom!==null&&this.heldFrom<next.entries.length)this.heldFrom=null;
  }
  persistencePending(runId:number):boolean {return this.pending?.runId===runId;}
  retryPersistence(runId:number):void {
    const change=this.pending;if(!change||change.runId!==runId)return;
    try {const result=this.options.commitSync(structuredClone(change));this.acknowledgeSaved(change,result.storageVersion);this.pending=null;}
    catch(error){this.failure(error);throw error;}
  }
  dispose():void {
    if(this.disposed)return;
    if(this.pending||this.heldFrom!==null||this.final||this.compaction)throw safeError('storage_write_failed');
    for(const [method,{wrapped}]of this.wrappers)if(this.manager[method]!==wrapped)throw safeError('state_conflict');
    for(const [method,{original}]of this.wrappers)Reflect.set(this.manager,method,original);
    this.disposed=true;
  }
  discardUncommittedForRestore(proof:import('../../contracts/src/session').RestoreDiscardProof):void {
    if(proof.sessionId!==this.saved.sessionId||proof.operationRef!==this.compaction||proof.nativeIdle!==true||proof.nativeQueuesEmpty!==true||proof.observersSettled!==true||proof.requiredCallFactsSaved!==true
      ||this.pending||this.final||this.options.getRunId()!==null||nativeHistoryJSON(validateNativeHistory(proof.persistentSnapshot))!==nativeHistoryJSON(this.saved))throw safeError('storage_write_failed');
    this.compaction=null;this.heldFrom=null;this.dispose();
  }
}
