import { SessionManager, type SessionEntry, type SessionHeader } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { Database } from 'bun:sqlite';
import { SqliteMemoryStore } from '../../packages/storage/src/memory-store';
import { SqliteWriteTransactions } from '../../packages/storage/src/write-transactions';
import { validateNativeHistory } from '../../packages/runtime-pi/src/memory-store';
import type { MemoryStore, NativeHistorySnapshot, NativeHistoryCommit } from '../../packages/contracts/src/session';
import type { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import type { AgentExecutionObservation } from '../../packages/contracts/src/run';
import { safeError } from '../../packages/contracts/src/error';

/** Same real SQLite boundary as Host; existing suites use it when constructing the P9 adapter. */
export function sqliteHistory(db:Database) {
  const store=new SqliteMemoryStore(db,validateNativeHistory),transactions=SqliteWriteTransactions.forDatabase(db);
  return {store,commitSync:(change:Parameters<SqliteMemoryStore['commitInTransaction']>[0])=>{
    try{return transactions.immediate(()=>store.commitInTransaction(change));}
    catch(error){try{const proof=store.confirmCommitted(change);if(proof)return proof;}catch{}throw error;}
  }};
}

/** Native-only SDK suites use a controlled port, not SQLite/P9 transaction evidence. */
export function nativeHistoryFixture() {
  const snapshots=new Map<number,NativeHistorySnapshot>();
  const commitSync=(change:NativeHistoryCommit)=>{
    const old=snapshots.get(change.sessionId);if(!old||old.storageVersion!==change.expectedStorageVersion)throw safeError('state_conflict');
    if(!change.newEntries.length&&old.activeLeafId===change.activeLeafId)return {storageVersion:old.storageVersion};
    const next=validateNativeHistory({...old,entries:[...old.entries,...change.newEntries],activeLeafId:change.activeLeafId,storageVersion:old.storageVersion+1});snapshots.set(change.sessionId,next);return {storageVersion:next.storageVersion};
  };
  const store:MemoryStore={load:async id=>{const value=snapshots.get(id);return value?{ok:true,data:structuredClone(value)}:{ok:false,error:safeError('session_history_invalid')};},commit:async change=>({ok:true,data:commitSync(change)}),listEntries:async(id,after,limit)=>({ok:true,data:structuredClone(snapshots.get(id)!.entries.slice(after,after+limit))})};
  return {history:{store,commitSync},bind(agent:PiAgentRuntime,sessionId:number){const allocated=agent.allocate();snapshots.set(sessionId,{...allocated.history,sessionId,nativeSessionId:allocated.nativeSessionId,storageVersion:1});allocated.bind(sessionId);return allocated;},
    saveFinal(agent:PiAgentRuntime,observed:AgentExecutionObservation){if(!observed.history)throw new Error('Missing frozen SDK history');const result=commitSync(observed.history);agent.acknowledgeHistorySaved(observed.history,result.storageVersion);agent.releaseHistoryFacts(observed.history.runId!);}};
}

export const memoryAt = '2026-10-05T00:00:00.000Z';
export function memoryAssistant(text = 'ENGINEERING: remembered A', model = 'probe-model'): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'openai', model,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 2 };
}
/** ENGINEERING native data generated through public SDK methods; no JSONL or requests. */
export function memoryNativeFixture(cwd = process.cwd()) {
  const manager = SessionManager.inMemory(cwd);
  manager.appendModelChange('openai', 'probe-model'); manager.appendThinkingLevelChange('off');
  const userId = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'ENGINEERING: remember A' }], timestamp: 1 });
  const answerId = manager.appendMessage(memoryAssistant());
  manager.appendUsage('probe', 'openai', 'probe-model', memoryAssistant().usage);
  manager.appendCustomEntry('p9.probe', { a: 1 }); manager.appendCustomMessageEntry('p9.message', 'ENGINEERING', false);
  manager.appendContextEdit(userId, { content: [{ type: 'text', text: 'ENGINEERING: corrected A' }] });
  manager.appendLabelChange(userId, 'bookmark'); manager.appendSessionInfo('ENGINEERING');
  manager.appendCompaction('ENGINEERING: summary', userId, 10); manager.branchWithSummary(userId, 'ENGINEERING: branch');
  manager.branch(answerId);
  return { manager, userId, answerId, header: structuredClone(manager.getHeader()!) as SessionHeader,
    entries: structuredClone(manager.getEntries()) as SessionEntry[], activeLeafId: manager.getLeafId()! };
}
