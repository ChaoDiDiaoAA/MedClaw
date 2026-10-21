import { expect, spyOn, test } from 'bun:test';
import { ExtensionRunner } from '@earendil-works/pi-coding-agent';
import { SubagentInputReceiptSchema } from '../../packages/contracts/src/resources';
import { agentRuntimeFixture } from '../fixtures/agent-runtime';
import { SubmitInputSchema } from '../../packages/contracts/src/session';

for (const entry of ['command', 'medclaw-evidence-review', 'parallel-medclaw-review'] as const) test(`p13 ${entry} uses the real SDK input path and original Agent call`, async () => {
  let parents = 0;
  const roles=entry==='command'?['general-analyst']:entry==='medclaw-evidence-review'?['medclaw-audit']:['medclaw-audit','general-analyst'];
  const f = await agentRuntimeFixture((_index, payload) => {
    const tools = payload.tools as {function:{name:string}}[] | undefined;
    if (tools?.some(tool=>tool.function.name==='Agent')) {
      parents++;
      if (parents === 1) return {role:'assistant',tool_calls:roles.map((role,index)=>({index,id:'entry-origin-'+role,type:'function',function:{name:'Agent',arguments:JSON.stringify({prompt:'Only analyze this supplied material.',description:'Independent check',subagent_type:role})}}))};
      return {role:'assistant',content:'ENGINEERING parent inspected the child result.'};
    }
    return {role:'assistant',content:'ENGINEERING child analyzed supplied material.'};
  }, false, undefined, undefined, true);
  try {
    const text = entry === 'command' ? '/subagent general-analyst Compare the supplied $ARGUMENTS literally.' : '/'+entry+' Compare the supplied $ARGUMENTS literally.';
    const request = SubmitInputSchema.parse({...f.request(text),routing:{mode:'intent',originRunId:null}});
    const accepted = await f.app.runs.submitAgent(request,{instanceId:'host',operationRef:`entry-${entry}`});
    expect(accepted.ok).toBe(true); if (!accepted.ok || !accepted.data.inputId || !accepted.data.runId) throw new Error('Input rejected');
    await f.settle();
    expect(f.requests).toHaveLength(roles.length+2);
    const content = f.content(accepted.data.inputId), native = content.nativeInput!;
    expect(content.resourceInputPlan?.dispatchText).toBe(text);
    expect(content.intentAdmission).toBeUndefined();
    expect(native.text).toContain('$ARGUMENTS');
    expect(native.subagentReceipt).toMatchObject(entry === 'command'
      ? {kind:'command',operationRef:'entry-command',inputId:accepted.data.inputId,roleId:'general-analyst',owner:{instanceId:'host',sessionId:1,runId:accepted.data.runId}}
      : {kind:'template',templateName:entry,expandedText:native.text});
    expect(JSON.stringify(f.requests[0]!.messages)).toContain('Compare the supplied $ARGUMENTS literally.');
    expect(f.repos.read({runId:accepted.data.runId})).toMatchObject({kind:'one',run:{status:'completed'}});
    expect(f.db.query("SELECT id FROM runs WHERE kind='child'").all()).toHaveLength(roles.length);
    expect(f.db.query("SELECT native_tool_call_id FROM tool_calls WHERE tool_name='Agent' ORDER BY native_tool_call_id").all()).toEqual(roles.slice().sort().map(role=>({native_tool_call_id:'entry-origin-'+role})));
  } finally {await f.close();}
},20_000);

test('p13 missing explicit roles and invalid commands reject before any model or Run',async()=>{
  const f=await agentRuntimeFixture(undefined,false,undefined,undefined,true);
  try {
    for(const text of ['/subagent missing-role task','/subagent general-analyst'])expect((await f.app.runs.submitAgent(f.request(text),{instanceId:'host',operationRef:text})).ok).toBe(false);
    expect(f.requests).toHaveLength(0);
    expect(f.db.query('SELECT id FROM runs').all()).toHaveLength(0);
  } finally {await f.close();}
});



test('p13 live command menu reports the actual assembly owner without executing a handler',async()=>{
  let release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const f=await agentRuntimeFixture(async()=>{await barrier;return {role:'assistant',content:'ENGINEERING no delegation necessary.'};},true,undefined,undefined,true);
  try {
    const accepted=await f.app.runs.submitAgent(f.request('Answer directly from supplied material.'),{instanceId:'host',operationRef:'directory-live'});
    expect(accepted.ok).toBe(true);
    for(let i=0;i<500&&f.requests.length<1;i++)await Bun.sleep(2);
    const before=f.requests.length, directory=await f.app.listInputCommands({sessionId:1});
    expect(directory.items.find(item=>item.command==='/subagent')).toMatchObject({registered:true,owner:{instanceId:'host',sessionId:1,runId:1}});
    expect(directory.items.find(item=>item.command==='/extension_status')).toMatchObject({registered:true,owner:{instanceId:'host',sessionId:1,runId:1}});
    expect(f.requests).toHaveLength(before);
    expect(f.db.query("SELECT id FROM runs WHERE kind='child'").all()).toHaveLength(0);
    expect(f.db.query('SELECT id FROM session_inputs').all()).toHaveLength(1);
    const rejected=await f.app.runs.submitAgent(f.request('/subagent general-analyst another task'),{instanceId:'host',operationRef:'directory-active-reject'});
    expect(rejected).toMatchObject({ok:false,error:{code:'state_conflict',reason:'runtime_busy'}});
    release();await f.settle();
    expect((await f.app.listInputCommands({sessionId:1})).items.find(item=>item.command==='/subagent')).toMatchObject({registered:false,owner:null});
  } finally {release();await f.close();}
},20_000);



for(const fault of ['missing-registration','wrong-owner','wrong-assembly'] as const)test(`p13 ${fault} rejects command before native history append or model request`,async()=>{
  const f=await agentRuntimeFixture(undefined,false,undefined,undefined,true);
  const originalGet=ExtensionRunner.prototype.getCommand;
  const originalParse=SubagentInputReceiptSchema.parse.bind(SubagentInputReceiptSchema);
  const changed=fault==='missing-registration'
    ? spyOn(ExtensionRunner.prototype,'getCommand').mockImplementation(function(this: ExtensionRunner,name){return name==='subagent'?undefined:originalGet.call(this,name);})
    : spyOn(SubagentInputReceiptSchema,'parse').mockImplementation(value=>{
      const receipt=originalParse(value);
      return receipt.kind==='command'?{...receipt,owner:{...receipt.owner,...(fault==='wrong-assembly'?{assemblyId:'another-assembly'}:{runId:receipt.owner.runId+100})}}:receipt;
    });
  try {
    const accepted=await f.app.runs.submitAgent(f.request('/subagent general-analyst provided task'),{instanceId:'host',operationRef:`fault-${fault}`});
    expect(accepted.ok).toBe(true);if(!accepted.ok||!accepted.data.inputId)throw new Error('No accepted input');
    await f.settle();
    expect(f.requests).toHaveLength(0);
    expect(f.content(accepted.data.inputId).nativeInput).toBeUndefined();
    expect(f.repos.readInput({inputId:accepted.data.inputId})).toMatchObject({status:'failed',nativeEntryId:null});
    expect(f.db.query("SELECT id FROM runs WHERE kind='child'").all()).toHaveLength(0);
  }finally{changed.mockRestore();await f.close();}
});

test('p13 lost first-consumption save retries the same delegation receipt without another dispatch',async()=>{
  const f=await agentRuntimeFixture(undefined,false,undefined,undefined,true);
  const original=f.repos.recordInputConsumption.bind(f.repos);
  let reject=true;
  const saved=spyOn(f.repos,'recordInputConsumption').mockImplementation((...args)=>{if(reject)throw new Error('ENGINEERING first consumption save failed');return original(...args);});
  try {
    const accepted=await f.app.runs.submitAgent(f.request('/subagent general-analyst provided task'),{instanceId:'host',operationRef:'receipt-save-failure'});
    expect(accepted.ok).toBe(true);if(!accepted.ok||!accepted.data.inputId||!accepted.data.runId)throw new Error('No accepted input');
    for(let i=0;i<1000&&!f.app.runs.persistencePending;i++)await Bun.sleep(2);
    expect(f.app.runs.persistencePending).toBe(true);
    expect(f.content(accepted.data.inputId).nativeInput).toBeUndefined();
    const before=f.requests.length;
    reject=false;
    let retry=await f.app.runs.retrySave(accepted.data.runId);
    for(let i=0;i<500&&!retry.ok;i++){await Bun.sleep(2);retry=await f.app.runs.retrySave(accepted.data.runId);}
    expect(retry.ok).toBe(true);
    await f.settle();
    expect(f.requests).toHaveLength(before);
    expect(f.content(accepted.data.inputId).nativeInput?.subagentReceipt).toMatchObject({kind:'command',operationRef:'receipt-save-failure',inputId:accepted.data.inputId});
    expect(f.repos.readInput({inputId:accepted.data.inputId})).toMatchObject({status:'consumed'});
  }finally{reject=false;saved.mockRestore();await f.close();}
},20_000);
