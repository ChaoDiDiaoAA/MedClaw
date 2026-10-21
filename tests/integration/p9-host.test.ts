import { expect,test } from 'bun:test';
import { type Result } from '../../packages/contracts/src/error';
import { SessionDetailSchema,SessionCheckpointPageSchema,SessionCheckpointReceiptSchema } from '../../packages/contracts/src/session';
import { SessionMessagePageSchema } from '../../packages/contracts/src/messages';
import { ReadRunResultSchema } from '../../packages/contracts/src/run';
import { EventPageSchema } from '../../packages/contracts/src/event';
import { sessionHostFixture as fixture } from '../fixtures/p9-host';

function unwrap<T>(result:Result<T>):T {if(!result.ok)throw result.error;return result.data;}
async function until(check:()=>Promise<boolean>) {const end=Date.now()+10000;while(!await check()){if(Date.now()>end)throw new Error('ENGINEERING Host condition timeout');await Bun.sleep(10);}}

for(const barrier of ['final-before','final-after','checkpoint-after'] as const)test(`p9 real Host kill at ${barrier} proves committed facts and never replays execution`,async()=>{
  const f=await fixture(barrier);try{
    const a=await f.create('barrier-session'),first=await f.send(a.session.id,'ENGINEERING first completed turn','barrier-first');await f.idle();
    const oldHistory=f.sql('SELECT * FROM memories ORDER BY id'),oldAnswers=f.sql('SELECT * FROM answers ORDER BY id');
    f.arm();let pending:Promise<unknown>;
    if(barrier==='checkpoint-after'){
      const detail=SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:a.session.id}))),points=SessionCheckpointPageSchema.parse(unwrap(await f.host.request('session.checkpoints.read',{sessionId:a.session.id})));
      pending=f.host.request('session.restoreCheckpoint',{sessionId:a.session.id,targetLeafId:points.items[0]!.nativeLeafId,expectedStorageVersion:detail.session.storageVersion,expectedWorkspaceRevision:(await f.workspace()).revision},'barrier-position');
    }else pending=f.send(a.session.id,'ENGINEERING final barrier turn','barrier-second');
    await until(async()=>f.reached());const committed=f.sql('SELECT * FROM memories ORDER BY id'),answers=f.sql('SELECT * FROM answers ORDER BY id'),position=f.sql('SELECT current_leaf_id,storage_version FROM sessions');
    expect(answers).toHaveLength(barrier==='final-after'?2:1);if(barrier==='checkpoint-after'){expect(committed).toEqual(oldHistory);expect(answers).toEqual(oldAnswers);}else expect(committed.length).toBeGreaterThan(oldHistory.length);
    const instance=await f.kill();await pending;
    const network=f.requests.length;expect(await f.host.restart(instance)).toMatchObject({state:'ready'});await f.idle();
    expect(f.requests).toHaveLength(network);expect(f.sql('SELECT * FROM memories ORDER BY id')).toEqual(committed);expect(f.sql('SELECT * FROM answers ORDER BY id')).toEqual(answers);expect(f.sql('SELECT current_leaf_id,storage_version FROM sessions')).toEqual(position);
    if(barrier==='checkpoint-after')expect(await f.host.request('evidence.readOperation',{kind:'session_checkpoint',operationRef:'barrier-position'})).toMatchObject({ok:true,data:{operationRef:'barrier-position',sessionId:a.session.id}});
    else {const recent=ReadRunResultSchema.parse(unwrap(await f.host.request('run.read',{recent:true})));expect(recent.kind).toBe('recent');if(recent.kind==='recent')expect(recent.runs[0]?.status).toBe(barrier==='final-after'?'completed':'failed');}
    const fresh=await f.send(a.session.id,'ENGINEERING explicit after barrier','barrier-new');expect(fresh.runId).not.toBe(first.runId);await f.idle();expect(f.requests).toHaveLength(network+1);
  }finally{await f.close();}
},40000);

test('p9 real Host restores same-model A/B after restart; checkpoint receipt, full history and branch continuation use public methods',async()=>{
  const f=await fixture();try {
    const a=await f.create('create-A'),b=await f.create('create-B');await f.select(a.session.id);const first=await f.send(a.session.id,'ENGINEERING A original','send-A');await f.idle();
    const points=SessionCheckpointPageSchema.parse(unwrap(await f.host.request('session.checkpoints.read',{sessionId:a.session.id})));expect(points.items).toHaveLength(1);
    await f.send(a.session.id,'ENGINEERING A correction','send-A2');await f.idle();await f.select(b.session.id);await f.send(b.session.id,'ENGINEERING B independent','send-B');await f.idle();
    const old=f.host.read().instanceId!;expect(await f.host.restart(old)).toMatchObject({state:'ready',schemaVersion:17});
    const before=f.sql('SELECT * FROM memories ORDER BY id'),requests=f.requests.length,detail=SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:a.session.id})));
    expect(detail).toMatchObject({runtime:{availability:'unloaded'},history:{available:true}});expect(detail.history.messages).toHaveLength(4);
    expect(SessionMessagePageSchema.parse(unwrap(await f.host.request('session.messages.read',{sessionId:a.session.id}))).items.filter(item=>item.displayRole==='user')).toHaveLength(2);
    expect(f.requests).toHaveLength(requests);expect(f.sql('SELECT * FROM memories ORDER BY id')).toEqual(before);
    await f.select(a.session.id);await f.send(a.session.id,'ENGINEERING A restarted follow up','send-A3');await f.idle();expect(JSON.stringify(f.requests[3])).toContain('ENGINEERING A correction');expect(JSON.stringify(f.requests[3])).not.toContain('ENGINEERING B independent');
    const current=SessionDetailSchema.parse(unwrap(await f.host.request('session.read',{sessionId:a.session.id}))),w=await f.workspace(),input={sessionId:a.session.id,targetLeafId:points.items[0]!.nativeLeafId,expectedStorageVersion:current.session.storageVersion,expectedWorkspaceRevision:w.revision};
    const receipt=SessionCheckpointReceiptSchema.parse(unwrap(await f.host.request('session.restoreCheckpoint',input,'resume-A')));expect(receipt.storageVersion).toBe(input.expectedStorageVersion+1);
    await f.select(b.session.id);const later=await f.workspace();expect(await f.host.request('evidence.readOperation',{kind:'session_checkpoint',operationRef:'resume-A'})).toEqual({ok:true,data:receipt});
    expect(await f.host.request('session.restoreCheckpoint',input,'resume-A')).toEqual({ok:true,data:receipt});expect(await f.workspace()).toEqual(later);
    expect(await f.host.request('evidence.readOperation',{kind:'session_checkpoint',operationRef:'never-committed'})).toEqual({ok:true,data:null});
    await f.select(a.session.id);const branch=await f.send(a.session.id,'ENGINEERING branch after first','branch-A');await f.idle();expect(branch.runId).not.toBe(first.runId);
    expect(JSON.stringify(f.requests[4])).toContain('ENGINEERING A original');expect(JSON.stringify(f.requests[4])).not.toContain('ENGINEERING A correction');expect(f.sql('SELECT id FROM answers')).toHaveLength(5);
    const events=EventPageSchema.parse(unwrap(await f.host.request('event.read',{runId:first.runId,afterSequence:0,limit:100})));expect(events.events.some(event=>event.type==='history_saved')).toBe(true);
  }finally{await f.close();}
},40000);

test('p9 real Host strong kill keeps only committed prefix; restart never resumes the old Run or turns stream text into Answer',async()=>{
  const f=await fixture();try {
    const a=await f.create('create-kill');await f.send(a.session.id,'ENGINEERING durable prefix','durable');await f.idle();f.hold(true);
    const accepted=await f.send(a.session.id,'ENGINEERING interrupted request','interrupted');await until(async()=>f.requests.length===2);
    const original=f.sql('SELECT * FROM memories ORDER BY id'),instance=await f.kill();
    f.hold(false);expect(await f.host.restart(instance)).toMatchObject({state:'ready'});
    expect(f.sql('SELECT * FROM memories ORDER BY id')).toEqual(original);expect(f.sql('SELECT id FROM answers')).toHaveLength(1);expect(f.requests).toHaveLength(2);
    expect(ReadRunResultSchema.parse(unwrap(await f.host.request('run.read',{runId:accepted.runId})))).toMatchObject({kind:'one',run:{status:'failed',error:{code:'runtime_interrupted'}}});
    const page=SessionMessagePageSchema.parse(unwrap(await f.host.request('session.messages.read',{sessionId:a.session.id})));expect(JSON.stringify(page)).not.toContain('ENGINEERING temporary');
    const next=await f.send(a.session.id,'ENGINEERING explicit new Run','after-kill');await f.idle();expect(next.runId).not.toBe(accepted.runId);expect(f.requests).toHaveLength(3);expect(f.sql('SELECT id FROM answers')).toHaveLength(2);
  }finally{await f.close();}
},40000);
