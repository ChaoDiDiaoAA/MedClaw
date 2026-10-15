import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../packages/storage/src/database';
import { SqliteWriteTransactions } from '../../packages/storage/src/write-transactions';
import { SqliteEventStore } from '../../packages/storage/src/event-store';
import { EventService } from '../../packages/core/src/events/event-service';
import type { EventAvailableNotice, RegisteredEventDraft, StreamSnapshotReader, EventStore, EventPage } from '../../packages/contracts/src/event';
const at='2026-10-03T00:00:00.000Z';
function fixture(action:(f:ReturnType<typeof setup>)=>void|Promise<void>) {
 const f=setup(); return Promise.resolve().then(()=>action(f)).finally(()=>{f.service.closeAll?.();f.db.close();rmSync(f.root,{recursive:true,force:true});});
}
function setup() {
 const root=mkdtempSync(join(tmpdir(),'p6-service-')),db=openDatabase(join(root,'app.sqlite'));
 db.query("INSERT INTO sessions(id,native_session_id,creation_operation_ref,creation_request_json,creation_result_json,title,created_at,updated_at) VALUES(1,'native','create','{}','{}','医疗器械',?,?)").run(at,at);
 db.query("INSERT INTO runs(id,session_id,kind,instance_id,status,goal,input_text,config_json,scope_json,workspace_json,submission_operation_ref,submission_client_sequence,submission_request_json,reference_date,timezone,created_at) VALUES(1,1,'agent','host','running','answer','价格下降超过5%的器械',json_object('agent',json_object('nativeSessionId','native')),'{}','{}','legacy',1,json_object('sessionId',1,'clientSequence',1),'2026-10-03','Asia/Shanghai',?)").run(at);
 const tx=SqliteWriteTransactions.forDatabase(db),store=new SqliteEventStore(db,tx),notices:EventAvailableNotice[]=[],reader:StreamSnapshotReader={readSnapshots:()=>({streamConnection:null,snapshots:[],incomplete:false})};
 const service=new EventService(store,tx,()=>at,n=>notices.push(n),reader);
 const draft:RegisteredEventDraft={type:'run_started',payload:{contract:'medclaw.event/v1',sessionId:1,kind:'agent',configVersion:'1'},runId:1,sessionId:1,source:'application',sourceConnection:null,sourceSequence:null,toolCallId:null,occurredAt:at,receivedAt:at};
 const append=()=>tx.immediate(()=>service.appendInTransaction(draft));
 const open=(subscriptionId='sid',afterSequence=0)=>service.subscribe?.({action:'open',subscriptionId,runId:1,afterSequence,limit:50});
 const read=(afterSequence=0,throughSequence:number|null=null,limit=50)=>service.read?.({runId:1,afterSequence,throughSequence,limit});
 return {root,db,tx,store,notices,reader,service,append,open,read,draft};
}
function page(value:ReturnType<EventService['read']>):EventPage {expect(value.ok).toBe(true);if(!value.ok)throw new Error(value.error.code);return value.data;}
test('open captures an empty real range and close is idempotent',()=>fixture(f=>{
 expect(f.open()).toMatchObject({action:'open',highWatermark:0,range:{firstSequence:null,lastSequence:0},snapshots:[]});
 expect(f.service.close('sid')).toEqual({action:'close',subscriptionId:'sid',closed:true});expect(f.service.close('sid').closed).toBe(true);
}));
test('read_through_fixed_h_never_absorbs_later_commits_and_lost_hints_are_readable',()=>fixture(f=>{
 f.append();const opened=f.open()!;f.append();f.append();
 expect(page(f.read(0,opened.highWatermark)).events.map(e=>e.sequence)).toEqual([1]);
 expect(page(f.read(1)).events.map(e=>e.sequence)).toEqual([2,3]);expect(page(f.read(3)).events).toEqual([]);
}));
test('open_buffers_before_capturing_high_watermark_and_commit_during_replay_is_found',()=>fixture(async f=>{
 let once=true;
 const intercepted:EventStore={appendInTransaction:d=>f.store.appendInTransaction(d),readRunIdentity:r=>f.store.readRunIdentity(r),readWindow:i=>f.store.readWindow(i),range:r=>{if(once){once=false;f.tx.immediate(()=>{f.store.appendInTransaction(f.draft);});service.notifyCommitted(r);}return f.store.range(r);}};
 const service=new EventService(intercepted,f.tx,()=>at,n=>f.notices.push(n),f.reader);
 const opened=service.subscribe({action:'open',subscriptionId:'barrier',runId:1,afterSequence:0,limit:50});
 f.append();service.notifyCommitted(1);await Promise.resolve();expect(opened.highWatermark).toBe(1);
 expect(f.notices.at(-1)).toMatchObject({subscriptionId:'barrier',highWatermark:2});
 expect(page(service.read({runId:1,afterSequence:0,throughSequence:1,limit:50})).nextSequence).toBe(1);
 expect(page(service.read({runId:1,afterSequence:1,throughSequence:null,limit:50})).nextSequence).toBe(2);service.closeAll();
}));
test('same_open_keeps_initial_h_refreshes_snapshots_and_changed_params_reject',()=>fixture(f=>{
 f.append();const initial=f.open()!;f.append();f.reader.readSnapshots=()=>({streamConnection:'c',snapshots:[],incomplete:true});
 expect(f.open()).toMatchObject({highWatermark:initial.highWatermark,streamConnection:'c',snapshotsIncomplete:true});
 expect(()=>f.open('sid',1)).toThrow('state_conflict');
}));
test('failed_new_open_releases_quota_but_failed_refresh_keeps_existing_handle',()=>fixture(f=>{
 const readSnapshots=f.reader.readSnapshots;
 f.reader.readSnapshots=()=>{throw new Error('unsafe body');};for(let i=0;i<20;i++)expect(()=>f.open('bad'+i)).toThrow();
 f.reader.readSnapshots=readSnapshots;for(let i=0;i<16;i++)f.open('good'+i);
 expect(()=>f.open('overflow')).toThrow('event_subscription_limit');
 f.reader.readSnapshots=()=>{throw new Error('refresh failure');};expect(()=>f.open('good0')).toThrow();
 f.reader.readSnapshots=readSnapshots;expect(f.open('good0')).toBeDefined();expect(()=>f.open('overflow')).toThrow('event_subscription_limit');
 f.service.close('good0');expect(f.open('overflow')).toBeDefined();
}));
test('slow_consumer_coalesces_256_hints_and_flags_resync_without_changing_facts',()=>fixture(async f=>{
 f.open();for(let i=0;i<300;i++)f.append();expect(f.notices).toHaveLength(0);
 await Promise.resolve();expect(f.notices).toHaveLength(1);expect(f.notices[0]).toMatchObject({highWatermark:300,resyncRequired:true});
 let cursor=0;while(cursor<300)cursor=page(f.read(cursor)).nextSequence;expect(cursor).toBe(300);
}));
test('sink_and_diagnostic_failures_do_not_reverse_commits_or_kill_subscription',()=>fixture(async f=>{
 const service=new EventService(f.store,f.tx,()=>at,()=>{throw new Error('display');},f.reader,()=>{throw new Error('diagnostic');});
 service.subscribe({action:'open',subscriptionId:'thrower',runId:1,afterSequence:0,limit:50});
 f.tx.immediate(()=>service.appendInTransaction(f.draft));await Promise.resolve();expect(page(service.read({runId:1,afterSequence:0,throughSequence:null,limit:50})).nextSequence).toBe(1);service.closeAll();
}));
test('cursor_and_gap_errors_include_safe_range_and_resume_skips_only_explicit_gap',()=>fixture(f=>{
 for(let i=0;i<7;i++)f.append();
 for(const [afterSequence,throughSequence] of [[-1,null],[8,null],[0,-1],[5,4],[0,8]] as const){expect(f.read(afterSequence,throughSequence)).toMatchObject({ok:false,error:{code:'event_cursor_invalid',eventRange:{runId:1,firstSequence:1,lastSequence:7}}});}
 f.db.exec('DELETE FROM runtime_events WHERE sequence BETWEEN 2 AND 6');
 expect(f.read()).toMatchObject({ok:false,error:{code:'event_gap',eventRange:{resumeAfterSequence:6}}});
 expect(page(f.read(6)).events.map(e=>e.sequence)).toEqual([7]);
 expect(f.service.read({runId:999,afterSequence:0,throughSequence:null,limit:50})).toMatchObject({ok:false,error:{code:'run_not_found'}});
}));
test('open_and_read_payload_budgets_reject_invalid_snapshot_without_leaking_handle',()=>fixture(f=>{
 f.reader.readSnapshots=()=>({streamConnection:'c',snapshots:Array.from({length:33},(_,i)=>({type:'tool.snapshot',streamConnection:'c',runId:1,sessionId:1,revision:1,nativeToolCallId:'t'+i,toolCallId:null,phase:'attempt',text:null,totalChars:null,truncated:false})),incomplete:false});
 expect(()=>f.open()).toThrow();f.reader.readSnapshots=()=>({streamConnection:null,snapshots:[],incomplete:false});expect(f.open()).toBeDefined();
}));

test('open_reply_trims_oldest_snapshot_copies_when_envelope_pushes_valid_cache_over_budget',()=>fixture(f=>{
 const snapshots=Array.from({length:16},(_,i)=>({type:'message.snapshot' as const,streamConnection:'c',runId:1,sessionId:1,revision:1,messageId:'message-'+i,ordinal:i+1,phase:'ended' as const,modelCallId:null,nativeEntryId:null,blocks:[{contentIndex:0,text:'\u0000'.repeat(32768)}],totalChars:32768,truncated:false}));
 const bytes=()=>new TextEncoder().encode(JSON.stringify(snapshots)).byteLength;
 while(bytes()>3*1024*1024){snapshots[15]!.blocks[0]!.text=snapshots[15]!.blocks[0]!.text.slice(0,-1);snapshots[15]!.totalChars--;}
 expect(bytes()).toBeGreaterThan(3*1024*1024-6);const cached=structuredClone(snapshots);
 f.reader.readSnapshots=()=>({streamConnection:'c',snapshots,incomplete:false});
 const opened=f.open()!;expect(opened.snapshots).toHaveLength(15);expect(opened.snapshotsIncomplete).toBe(true);expect(new TextEncoder().encode(JSON.stringify(opened)).byteLength).toBeLessThanOrEqual(3*1024*1024);expect(snapshots).toEqual(cached);
 expect((opened.snapshots[0] as {messageId:string}).messageId).toBe('message-1');
}));

test('fixed_h_trailing_gap_returns_resume_for_later_real_segment_beyond_h',()=>fixture(f=>{
 for(let i=0;i<7;i++)f.append();f.db.exec('DELETE FROM runtime_events WHERE sequence BETWEEN 2 AND 5');
 expect(f.read(0,5)).toMatchObject({ok:false,error:{code:'event_gap',eventRange:{runId:1,lastSequence:7,resumeAfterSequence:5}}});
 expect(page(f.read(5)).events.map(e=>e.sequence)).toEqual([6,7]);
}));

test('every_new_open_initialization_failure_releases_its_slot',()=>fixture(f=>{
 for(const stage of ['identity','range','snapshot','ack']){
  let fail=true;
  const store:EventStore={appendInTransaction:d=>f.store.appendInTransaction(d),readRunIdentity:r=>{if(fail&&stage==='identity')throw Error('injected');return f.store.readRunIdentity(r);},range:r=>{if(fail&&stage==='range')throw Error('injected');return f.store.range(r);},readWindow:i=>f.store.readWindow(i)};
  const reader:StreamSnapshotReader={readSnapshots:()=>{if(fail&&stage==='snapshot')throw Error('injected');return {streamConnection:fail&&stage==='ack'?'unsafe identity /':null,snapshots:[],incomplete:false};}};
  const service=new EventService(store,f.tx,()=>at,()=>{},reader);
  const open=(id:string)=>service.subscribe({action:'open',subscriptionId:id,runId:1,afterSequence:0,limit:50});
  for(let i=0;i<20;i++)expect(()=>open('bad-'+stage+i)).toThrow();fail=false;
  for(let i=0;i<16;i++)expect(open('good-'+stage+i).highWatermark).toBe(0);
  expect(()=>open('full-'+stage)).toThrow('event_subscription_limit');service.closeAll();
 }
}));

test('event_pages_shrink_by_whole_facts_and_payload_overflow_never_allocates_sequence',()=>fixture(f=>{
 const queryIds=Array.from({length:12000},(_,i)=>i+1);
 f.tx.immediate(()=>{
  const insert=f.db.query("INSERT INTO queries(id,session_id,run_id,call_ref,kind,params_json,batch_ids_json,result_json,created_at) VALUES(?,1,1,?,'current','{}','[]','{}',?)");for(const id of queryIds)insert.run(id,'q'+id,at);
  const tool=f.db.query("INSERT INTO tool_calls(id,session_id,run_id,native_tool_call_id,tool_name,tool_version,effect,execution_mode,args_json,status,result_json,requested_at,ended_at) VALUES(?,1,1,?,'current','v','READ','sequential','{}','succeeded','{}',?,?)");
  for(let id=1;id<=70;id++){tool.run(id,'tool'+id,at,at);f.service.appendInTransaction({...f.draft,type:'tool_finished',source:'tool',toolCallId:id,payload:{contract:'medclaw.event/v1',callId:id,nativeToolCallId:'tool'+id,status:'succeeded',queryIds,errorCode:null}});}
 });
 const first=page(f.read(0,70,100));expect(first.events.length).toBeLessThan(70);expect(first.hasMore).toBe(true);expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThanOrEqual(3*1024*1024);
 expect(first.events.every(e=>'queryIds'in e.payload&&JSON.stringify(e.payload.queryIds)===JSON.stringify(queryIds))).toBe(true);
 expect(page(f.read(first.nextSequence,70,100))).toMatchObject({nextSequence:70,hasMore:false});
 expect(()=>f.tx.immediate(()=>f.service.appendInTransaction({...f.draft,type:'tool_finished',source:'tool',toolCallId:1,payload:{contract:'medclaw.event/v1',callId:1,nativeToolCallId:'tool1',status:'succeeded',queryIds:Array.from({length:13000},(_,i)=>i+1),errorCode:null}}))).toThrow('storage_write_failed');expect(f.store.range(1).lastSequence).toBe(70);
}),30000);
