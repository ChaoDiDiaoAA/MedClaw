import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { SessionManager, CURRENT_SESSION_VERSION, createAgentSession, DefaultResourceLoader, SettingsManager, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { publicMethodSchemas, publicOutputSchema, isReadOnlyMethod, HOST_PROTOCOL_VERSION, DATABASE_SCHEMA_VERSION } from '../../packages/contracts/src/protocol';
import { RegisteredEventDraftSchema } from '../../packages/contracts/src/event';
import { safeError } from '../../packages/contracts/src/error';
import { discoverTests } from '../run';
import { memoryNativeFixture, memoryAt, memoryAssistant } from '../fixtures/p9-memory';

test('p9 operation read output must match the requested kind, including a nullable original receipt',()=>{
  const receipt={operationRef:'ENGINEERING-resume',sessionId:1,targetLeafId:'ENGINEERING-leaf',storageVersion:2,workspaceRevision:2,committedAt:memoryAt};
  expect(publicOutputSchema('evidence.readOperation',{kind:'session_checkpoint',operationRef:receipt.operationRef}).parse(receipt)).toEqual(receipt);
  expect(publicOutputSchema('evidence.readOperation',{kind:'session_checkpoint',operationRef:receipt.operationRef}).parse(null)).toBeNull();
  expect(()=>publicOutputSchema('evidence.readOperation',{kind:'import',operationRef:receipt.operationRef}).parse(receipt)).toThrow();
  expect(()=>publicOutputSchema('evidence.readOperation',{kind:'export',operationRef:receipt.operationRef})).toThrow();
});

test('p9 raw history preserves SDK provider tool IDs containing a pipe',async()=>{
  const {validateNativeHistory}=await import('../../packages/runtime-pi/src/memory-store'),manager=SessionManager.inMemory(process.cwd());
  manager.appendMessage({...memoryAssistant(),content:[{type:'toolCall',id:'ENGINEERING-call|item',name:'read_query',arguments:{queryId:1}}],stopReason:'toolUse'});
  manager.appendMessage({role:'toolResult',toolCallId:'ENGINEERING-call|item',toolName:'read_query',content:[{type:'text',text:'ENGINEERING'}],isError:false,timestamp:2});
  const snapshot={sessionId:1,nativeSessionId:manager.getSessionId(),header:manager.getHeader(),entries:manager.getEntries(),activeLeafId:manager.getLeafId(),storageVersion:1};
  expect(validateNativeHistory(snapshot).entries).toEqual(snapshot.entries);
});

async function adapterFixture() {
  const {PiMemoryAdapter,validateNativeHistory}=await import('../../packages/runtime-pi/src/memory-store');
  const manager=SessionManager.inMemory(process.cwd());let runId:number|null=null,failed=false;
  let saved={sessionId:1,nativeSessionId:manager.getSessionId(),header:manager.getHeader()!,entries:[] as unknown[],activeLeafId:null as string|null,storageVersion:1};
  const commits:unknown[]=[];const failures:unknown[]=[];
  const commit=(change:import('../../packages/runtime-pi/src/memory-store').PiHistoryCommit)=>{
    if(failed)throw new Error('storage_write_failed');expect(change.expectedStorageVersion).toBe(saved.storageVersion);
    const next=validateNativeHistory({...saved,entries:[...saved.entries,...change.newEntries],activeLeafId:change.activeLeafId});
    saved={...next,storageVersion:saved.storageVersion+1};commits.push(structuredClone(change));return {storageVersion:saved.storageVersion};
  };
  const adapter=new PiMemoryAdapter(manager,{snapshot:saved,getRunId:()=>runId,commitSync:commit,onFailure:e=>failures.push(e)});
  return {manager,adapter,commits,failures,commit,saved:()=>saved,run:(value:number|null)=>{runId=value;},fail:(value:boolean)=>{failed=value;}};
}

test('p9 memory adapter observes all thirteen public mutations, nested changes and precise positions',async()=>{
  const f=await adapterFixture();try{
    f.manager.appendModelChange('openai','ENGINEERING'); f.manager.appendThinkingLevelChange('low');
    const user=f.manager.appendMessage({role:'user',content:'ENGINEERING',timestamp:1}); f.manager.appendMessage(memoryAssistant());
    f.manager.appendUsage('probe','openai','ENGINEERING',memoryAssistant().usage);
    f.manager.appendCustomEntry('probe',{retained:true});f.manager.appendCustomMessageEntry('probe','ENGINEERING',false,{retained:true});
    f.manager.appendContextEdit(user,{content:'ENGINEERING corrected'});f.manager.appendLabelChange(user,undefined);f.manager.appendSessionInfo('ENGINEERING');
    f.manager.appendCompaction('ENGINEERING',user,0);f.manager.branchWithSummary(user,'ENGINEERING'); f.manager.branch(user); f.manager.resetLeaf();
    expect(new Set(f.manager.getEntries().map(e=>e.type)).size).toBe(11);expect(f.saved().entries).toEqual(f.manager.getEntries());expect(f.saved().activeLeafId).toBeNull();
    expect(f.failures).toEqual([]);expect(f.commits.length).toBe(14);
    const count=f.commits.length;f.manager.resetLeaf();expect(f.commits.length).toBe(count);
  }finally{f.adapter.dispose();}
});

test('p9 candidate final assistant and following metadata stay out of ordinary commits until atomic acknowledgement',async()=>{
  const f=await adapterFixture();try{
    f.run(10);f.manager.appendMessage({role:'user',content:'ENGINEERING',timestamp:1});const prefix=f.saved().entries.length;
    const answer=f.manager.appendMessage(memoryAssistant());f.manager.appendUsage('answer','openai','ENGINEERING',memoryAssistant().usage);
    expect(f.saved().entries).toHaveLength(prefix);expect(f.adapter.persistencePending(10)).toBe(false);
    f.adapter.retryPersistence(10);expect(f.saved().entries).toHaveLength(prefix);
    const tail=f.adapter.freezeFinal(10);expect(tail.newEntries).toHaveLength(2);expect(tail.newEntries[0]!.id).toBe(answer);expect(tail.activeLeafId).toBe(f.manager.getLeafId());
    const result=f.commit(tail);f.adapter.acknowledgeSaved(tail,result.storageVersion);expect(f.adapter.freezeFinal(10).newEntries).toEqual([]);f.adapter.releaseFinal(10);
  }finally{f.adapter.dispose();}
});

test('p9 a follow-up or next model request saves the former final candidate before proceeding',async()=>{
  const f=await adapterFixture();try{
    f.run(10);f.manager.appendMessage({role:'user',content:'ENGINEERING',timestamp:1});f.manager.appendMessage(memoryAssistant('ENGINEERING first'));
    expect(f.saved().entries).toHaveLength(1);f.manager.appendMessage({role:'user',content:'ENGINEERING follow-up',timestamp:3});expect(f.saved().entries).toHaveLength(3);
    f.manager.appendMessage(memoryAssistant('ENGINEERING second'));expect(f.saved().entries).toHaveLength(3);
    f.adapter.flushBeforeRequest();expect(f.saved().entries).toHaveLength(4);
    f.manager.appendMessage({...memoryAssistant(),stopReason:'toolUse',content:[{type:'toolCall',id:'tool-1',name:'read',arguments:{path:'ENGINEERING'}}]});
    f.manager.appendMessage({role:'toolResult',toolCallId:'tool-1',toolName:'read',content:[{type:'text',text:'ENGINEERING'}],isError:false,timestamp:4});
    expect(f.saved().entries).toHaveLength(6);
  }finally{f.adapter.dispose();}
});

test('p9 failed ordinary persistence retains the original fact, rejects more input and can only retry saving',async()=>{
  const f=await adapterFixture();try{
    f.run(10);f.fail(true);expect(()=>f.manager.appendMessage({role:'user',content:'ENGINEERING',timestamp:1})).toThrow();
    expect(f.manager.getEntries()).toHaveLength(1);expect(f.saved().entries).toHaveLength(0);expect(f.adapter.persistencePending(10)).toBe(true);
    expect(()=>f.adapter.flushBeforeRequest()).toThrow();expect(()=>f.manager.appendMessage({role:'user',content:'no implicit continuation',timestamp:2})).toThrow();expect(f.manager.getEntries()).toHaveLength(1);
    f.fail(false);f.adapter.retryPersistence(10);expect(f.saved().entries).toHaveLength(1);expect(f.adapter.persistencePending(10)).toBe(false);expect(f.failures).toHaveLength(1);
  }finally{f.adapter.dispose();}
});

test('p9 stopped final history stays frozen while explicit prefix repair rebases only the saved cursor',async()=>{
  const f=await adapterFixture();try{
    f.run(10);f.fail(true);expect(()=>f.manager.appendMessage({role:'user',content:'ENGINEERING',timestamp:1})).toThrow();
    const answer=f.manager.appendMessage({...memoryAssistant('ENGINEERING aborted'),stopReason:'aborted'}),original=structuredClone(f.manager.getEntries());
    const frozen=f.adapter.freezeFinal(10);expect(frozen.newEntries).toEqual(original);expect(frozen.activeLeafId).toBe(answer);
    expect(()=>f.manager.appendSessionInfo('no new mutation after stop')).toThrow();expect(()=>f.adapter.releaseFinal(10)).toThrow();
    f.fail(false);f.adapter.retryPersistence(10);expect(f.saved().entries).toEqual(original.slice(0,1));
    const tail=f.adapter.freezeFinal(10);expect(tail.expectedStorageVersion).toBe(frozen.expectedStorageVersion+1);expect(tail.newEntries).toEqual(original.slice(1));expect(tail.activeLeafId).toBe(answer);
    expect(f.manager.getEntries()).toEqual(original);expect(()=>f.adapter.freezeFinal(11)).toThrow();
    const result=f.commit(tail);f.adapter.acknowledgeSaved(tail,result.storageVersion);f.adapter.releaseFinal(10);
    f.run(null);f.manager.appendSessionInfo('ENGINEERING next operation');expect(f.saved().entries).toHaveLength(3);
  }finally{f.adapter.dispose();}
});

test('p9 native validator rejects damaged types, references and non-JSON without interpreting the context', async () => {
  const {validateNativeHistory, restoreNativeManager} = await import('../../packages/runtime-pi/src/memory-store');
  const f=memoryNativeFixture(), snapshot={sessionId:1,nativeSessionId:f.header.id,header:f.header,entries:f.entries,activeLeafId:f.activeLeafId,storageVersion:1};
  expect(restoreNativeManager(snapshot,process.cwd()).buildSessionContext()).toEqual(f.manager.buildSessionContext());
  expect(validateNativeHistory(snapshot)).toEqual(snapshot);
  for (const damage of ['parent','leaf','header','type','timestamp','context_target','label_target','compaction_target','summary_target','non_json','content'] as const) {
    const bad=structuredClone(snapshot);
    if(damage==='parent') bad.entries[0]!.parentId='foreign';
    else if(damage==='leaf') bad.activeLeafId='missing';
    else if(damage==='header') bad.header.id='foreign-native-session';
    else if(damage==='type') Reflect.set(bad.entries[0]!,'type','future');
    else if(damage==='timestamp') bad.entries[0]!.timestamp='no';
    else if(damage==='non_json') Reflect.set(bad.entries[0]!,'details',{invalid:NaN});
    else if(damage==='content') Reflect.set(bad.entries.find(e=>e.type==='message')!,'message',{role:'user',content:[{type:'thinking',thinking:'not user content'}],timestamp:1});
    else {const type=damage==='context_target'?'context_edit':damage==='label_target'?'label':damage==='compaction_target'?'compaction':'branch_summary';const entry=bad.entries.find(e=>e.type===type)!;Reflect.set(entry,type==='compaction'?'firstKeptEntryId':type==='branch_summary'?'fromId':'targetId','foreign');}
    expect(()=>validateNativeHistory(bad)).toThrow();
  }
  const roots=SessionManager.inMemory(process.cwd()); roots.appendCustomEntry('first'); roots.resetLeaf(); roots.appendSessionInfo('second'); roots.appendLabelChange(roots.getEntries()[0]!.id,undefined);
  roots.resetLeaf(); expect(restoreNativeManager({sessionId:1,nativeSessionId:roots.getSessionId(),header:roots.getHeader(),entries:roots.getEntries(),activeLeafId:null,storageVersion:1},process.cwd()).getEntries()).toEqual(roots.getEntries());
});

test('p9 saved-message projection follows the explicit persisted leaf and a legal empty position without binding or writing',async()=>{
  const {projectSavedMessages}=await import('../../packages/runtime-pi/src/memory-store'),f=memoryNativeFixture();
  const snapshot={sessionId:1,nativeSessionId:f.header.id,header:f.header,entries:f.entries,activeLeafId:f.activeLeafId,storageVersion:2};
  const before=structuredClone(snapshot),page=projectSavedMessages(snapshot,{sessionId:1,leafId:null,afterEntryId:null,limit:50},process.cwd());
  expect(page).toMatchObject({sessionId:1,leafId:f.activeLeafId,source:'sqlite_history',hasMore:false});
  expect(page.items.filter(item=>['user','assistant'].includes(item.displayRole)).map(item=>item.nativeEntryId)).toEqual([f.userId,f.answerId]);expect(snapshot).toEqual(before);
  expect(projectSavedMessages({...snapshot,activeLeafId:null},{sessionId:1,leafId:null,afterEntryId:null,limit:50},process.cwd())).toMatchObject({items:[],leafId:null,source:'sqlite_history',hasMore:false,nextEntryId:null});
  const other=projectSavedMessages(snapshot,{sessionId:1,leafId:f.entries.at(-1)!.id,afterEntryId:null,limit:2},process.cwd());expect(other.leafId).toBe(f.entries.at(-1)!.id);expect(other.hasMore).toBe(true);expect(snapshot).toEqual(before);
});

test('p9 strict checkpoint routes separate browsing, position changes and current-position rebuilding', () => {
  const read = Reflect.get(publicMethodSchemas, 'session.checkpoints.read'); expect(read).toBeDefined();
  expect(read.input.parse({ sessionId: 1 })).toEqual({ sessionId: 1, afterAnswerId: null, limit: 50 });
  for (const input of [{ sessionId: 0 }, { sessionId: 1, limit: 101 }, { sessionId: 1, afterAnswerId: 0 }, { sessionId: 1, operationRef: 'no-payload-identity' }]) expect(read.input.safeParse(input).success).toBe(false);
  const move = Reflect.get(publicMethodSchemas, 'session.restoreCheckpoint'); expect(move).toBeDefined();
  const valid = { sessionId: 1, targetLeafId: 'leaf-1', expectedStorageVersion: 8, expectedWorkspaceRevision: 12 };
  expect(move.input.safeParse(valid).success).toBe(true);
  expect(move.input.safeParse({ ...valid, expectedStorageVersion: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  expect(move.input.safeParse({ ...valid, expectedWorkspaceRevision: undefined }).success).toBe(false);
  const restore = Reflect.get(publicMethodSchemas, 'session.restore'); expect(restore).toBeDefined();
  expect(restore.input.safeParse({ sessionId: 1, expectedLeafId: null }).success).toBe(true);
  expect(restore.input.safeParse({ sessionId: 1, targetLeafId: 'other' }).success).toBe(false);
  expect(isReadOnlyMethod('session.checkpoints.read')).toBe(true); expect(isReadOnlyMethod('session.restoreCheckpoint')).toBe(false); expect(isReadOnlyMethod('session.restore')).toBe(false);
});

test('p9 checkpoint receipt operation reads are strict and remain read only', () => {
  const route = publicMethodSchemas['evidence.readOperation'];
  expect(route.input.safeParse({ kind: 'session_checkpoint', operationRef: 'restore-1' }).success).toBe(true);
  expect(route.input.safeParse({ kind: 'import', operationRef: 'import-1' }).success).toBe(true);
  expect(route.input.safeParse({ kind: 'export', operationRef: 'future' }).success).toBe(false);
  expect(route.input.safeParse({ kind: 'session_checkpoint', operationRef: 'restore-1', targetLeafId: 'no-write' }).success).toBe(false);
  expect(isReadOnlyMethod('evidence.readOperation')).toBe(true);
});

test('p9 persisted history event records its original version and leaf, never preview text', () => {
  const draft = { runId: 1, sessionId: 2, source: 'pi', sourceConnection: null, sourceSequence: null, toolCallId: null, occurredAt: memoryAt, receivedAt: memoryAt,
    type: 'history_saved', payload: { contract: 'medclaw.event/v1', storageVersion: 8, nativeLeafId: 'entry-1' } };
  expect(RegisteredEventDraftSchema.safeParse(draft).success).toBe(true);
  expect(RegisteredEventDraftSchema.safeParse({ ...draft, payload: { ...draft.payload, nativeLeafId: null } }).success).toBe(true);
  expect(RegisteredEventDraftSchema.safeParse({ ...draft, payload: { ...draft.payload, storageVersion: 0 } }).success).toBe(false);
  expect(RegisteredEventDraftSchema.safeParse({ ...draft, payload: { ...draft.payload, text: 'temporary' } }).success).toBe(false);
});

test('p9 safe errors and actual runner registration expose this stage', () => {
  expect(safeError('answer_evidence_invalid')).toMatchObject({ code: 'answer_evidence_invalid', category: 'runtime', retryable: false });
  for (const reason of ['checkpoint_invalid', 'history_version_mismatch', 'session_restore_failed'] as const) expect(safeError('state_conflict', undefined, { reason })).toMatchObject({ reason });
  expect(HOST_PROTOCOL_VERSION).toBe('medclaw.host/p9-v1'); expect(DATABASE_SCHEMA_VERSION).toBe(9);
  expect(discoverTests('unit', 'P9')).toContain(join(import.meta.dir, 'p9-memory.test.ts'));
});

test('p9 public SDK complete history preserves eleven entry types, native identity and a non-last leaf', () => {
  const f = memoryNativeFixture(), restored = SessionManager.inMemory(process.cwd(), undefined, [structuredClone(f.header), ...structuredClone(f.entries)]);
  expect(new Set(f.entries.map(entry => entry.type)).size).toBe(11); expect(f.header.version).toBe(CURRENT_SESSION_VERSION);
  expect(restored.getLeafId()).not.toBe(f.activeLeafId); restored.branch(f.activeLeafId);
  expect(restored.getHeader()).toEqual(f.header); expect(restored.getEntries()).toEqual(f.entries); expect(restored.getSessionId()).toBe(f.manager.getSessionId());
  expect(restored.buildSessionContext()).toEqual(f.manager.buildSessionContext()); expect(restored.isPersisted()).toBe(false);
  restored.resetLeaf(); expect(restored.getLeafId()).toBe(null); expect(restored.getEntries()).toEqual(f.entries);
  const edge = SessionManager.inMemory(process.cwd()), compact = edge.appendCompaction('ENGINEERING', null, 0);
  expect(edge.getEntry(compact)).toMatchObject({ firstKeptEntryId: compact });
  const root = SessionManager.inMemory(process.cwd()), summary = root.branchWithSummary(null, 'ENGINEERING'); expect(root.getEntry(summary)).toMatchObject({ fromId: 'root', parentId: null });
});

test('p9 AgentSession assembly makes no request; actual input composition restores the exact memory wrapper', async () => {
  const f = memoryNativeFixture(), manager = SessionManager.inMemory(process.cwd(), undefined, [structuredClone(f.header), ...structuredClone(f.entries)]); manager.branch(f.activeLeafId);
  const {PiMemoryAdapter,validateNativeHistory}=await import('../../packages/runtime-pi/src/memory-store');let runId:number|null=null;
  let saved={sessionId:1,nativeSessionId:f.header.id,header:f.header,entries:f.entries,activeLeafId:f.activeLeafId as string|null,storageVersion:1};let saves=0;
  const commit=(change:import('../../packages/runtime-pi/src/memory-store').PiHistoryCommit)=>{const next=validateNativeHistory({...saved,entries:[...saved.entries,...change.newEntries],activeLeafId:change.activeLeafId});saved={...next,storageVersion:saved.storageVersion+1};saves++;return {storageVersion:saved.storageVersion};};
  const memory=new PiMemoryAdapter(manager,{snapshot:saved,getRunId:()=>runId,commitSync:commit,onFailure:e=>{throw e;}});
  const credentials = { read: async (provider: string) => provider === 'openai' ? { type: 'api_key' as const, key: 'ENGINEERING-NONSECRET' } : undefined, list: async () => [], modify: async () => undefined, delete: async () => {} };
  const modelsStore = { read: async () => undefined, write: async () => {}, delete: async () => {} };
  const native = await ModelRuntime.create({ credentials, modelsStore, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', defaultTools: [], packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false, enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.cwd(), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [], systemPrompt: 'ENGINEERING' }); await loader.reload();
  const model = { id: 'probe-model', name: 'ENGINEERING', provider: 'openai', api: 'openai-completions' as const, baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 100 };
  const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: process.cwd(), modelRuntime: native, model, sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: 'all', tools: [], customTools: [] });
  try {
    expect(saves).toBe(0);
    expect(manager.getEntries()).toEqual(f.entries); expect(manager.getHeader()).toEqual(f.header); expect(manager.getLeafId()).toBe(f.activeLeafId);
    expect(session.agent.state.messages).toEqual(manager.buildSessionContext().messages); expect(session.isIdle).toBe(true);
    const count = manager.getEntries().length; await session.setModel(model, { persist: false }); expect(manager.getEntries().length).toBe(count + 1); expect(manager.getEntries().at(-1)?.type).toBe('model_change');
    session.setThinkingLevel('off', { persist: false }); expect(manager.getEntries().length).toBe(count + 1);
    await session.setModel({...model,reasoning:true},{persist:false});const beforeThinking=manager.getEntries().length;
    session.setThinkingLevel('low',{persist:false});expect(manager.getEntries().length).toBe(beforeThinking+1);expect(manager.getEntries().at(-1)).toMatchObject({type:'thinking_level_change',thinkingLevel:'low'});
    await session.waitForIdle();
    const {PiInputAdapter}=await import('../../packages/runtime-pi/src/input-adapter'); const originalMemoryAppend=manager.appendMessage;
    const consumed:{nativeEntryId:string}[]=[];const failures:unknown[]=[];let requests=0;
    session.agent.streamFunction=()=>{requests++;const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'stop',message:memoryAssistant('ENGINEERING new turn')});return stream;};
    runId=10;
    const input=new PiInputAdapter(session,manager,{runId:10,sessionId:1,delivered:()=>{},consumed:(_input,fact)=>consumed.push(fact),failed:(_input,fact)=>failures.push(fact),fatal:e=>failures.push(e),admissionClosed:()=>{}});
    try {
      await input.deliver({inputId:1,sessionId:1,targetRunId:10,mode:'send',text:'ENGINEERING next question',stopEpoch:0});
      const proof=await input.close(10,'completed');expect(proof.nativeIdle).toBe(true);expect(proof.unconfirmedInputIds).toEqual([]);expect(consumed).toHaveLength(1);expect(failures).toEqual([]);expect(requests).toBe(1);
      expect(manager.getEntry(consumed[0]!.nativeEntryId)).toMatchObject({type:'message',message:{role:'user'}});
      expect(saved.entries.at(-1)).toMatchObject({id:consumed[0]!.nativeEntryId});
      const final=memory.freezeFinal(10);memory.acknowledgeSaved(final,commit(final).storageVersion);memory.releaseFinal(10);
    }finally{input.dispose();}
    expect(manager.appendMessage).toBe(originalMemoryAppend);
  } finally { memory.dispose();session.dispose(); }
});
