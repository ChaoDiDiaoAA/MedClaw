import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import { StreamSnapshotSchema, type MessageStreamSnapshot, type StreamSnapshot, type StreamSnapshotReader, type ToolStreamSnapshot } from '../../contracts/src/event';
import { safePreview } from '../../contracts/src/run';

type Attachment = {
  session: AgentSession; manager: SessionManager; runId: number; sessionId: number; streamConnection: string;
  readToolIdentity: (nativeToolCallId: string) => { toolCallId: number } | null;
  readCurrentModelCallId: () => string | null;
  emit: (snapshot: StreamSnapshot) => void;
};
type Cache = { streamConnection: string; snapshots: Map<string, StreamSnapshot>; incomplete: boolean };

/** A run-owned observer. It copies public text synchronously and never controls execution. */
export class EventAdapter implements StreamSnapshotReader {
  private readonly runs = new Map<number, Cache>();
  readSnapshots(runId: number) {
    const cache = this.runs.get(runId);
    return cache ? { streamConnection: cache.streamConnection, snapshots: structuredClone([...cache.snapshots.values()]), incomplete: cache.incomplete }
      : { streamConnection: null, snapshots: [], incomplete: false };
  }
  attach(input: Attachment): () => void {
    if (this.runs.has(input.runId)) throw new Error('state_conflict');
    const cache: Cache = { streamConnection: input.streamConnection, snapshots: new Map(), incomplete: false };
    this.runs.set(input.runId, cache);
    let ordinal = 0, current: MessageStreamSnapshot | null = null, disposed = false;
    const publish = (snapshot: StreamSnapshot) => {
      const safe = StreamSnapshotSchema.parse(snapshot);
      const key = safe.type === 'message.snapshot' ? `message:${safe.messageId}` : `tool:${safe.nativeToolCallId}`;
      cache.snapshots.set(key, safe);
      while (cache.snapshots.size > 32 || Buffer.byteLength(JSON.stringify([...cache.snapshots.values()]), 'utf8') > 3 * 1024 * 1024) {
        cache.snapshots.delete(cache.snapshots.keys().next().value!); cache.incomplete = true;
      }
      try { input.emit(structuredClone(safe)); } catch { /* Display failure cannot escape into Pi's loop. */ }
    };
    const copyText = (message: { content: unknown }) => {
      const blocks: MessageStreamSnapshot['blocks'] = []; let totalChars = 0, remaining = 32768, truncated = false;
      if (!Array.isArray(message.content)) throw new Error('agent_response_unsupported');
      message.content.forEach((part: unknown, contentIndex: number) => {
        if (!part || typeof part !== 'object') return;
        const block = part as { type?: unknown; text?: unknown };
        if (block.type !== 'text' || typeof block.text !== 'string') return;
        totalChars += block.text.length;
        // Once a block is truncated, later blocks cannot skip ahead into the retained prefix.
        const preview = safePreview(block.text, truncated ? 0 : remaining);
        if (preview.text.length) blocks.push({ contentIndex, text: preview.text });
        remaining -= preview.text.length; truncated ||= preview.truncated;
      });
      return { blocks, totalChars, truncated };
    };
    const stopAgent = input.session.agent.subscribe(event => {
      try {
        if (disposed) return;
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          if (current && current.phase === 'streaming') { current = { ...current, revision: current.revision + 1, phase: 'incomplete' }; publish(current); }
          current = { type: 'message.snapshot', streamConnection: input.streamConnection, runId: input.runId, sessionId: input.sessionId,
            messageId: `${input.runId}.${++ordinal}`, ordinal, revision: 1, phase: 'streaming', modelCallId: input.readCurrentModelCallId(), nativeEntryId: null, ...copyText(event.message) };
          publish(current);
        } else if (event.type === 'message_update' && event.message.role === 'assistant' && current?.phase === 'streaming') {
          current = { ...current, revision: current.revision + 1, ...copyText(event.message) }; publish(current);
        } else if (event.type === 'message_end' && event.message.role === 'assistant' && current) {
          const entry = input.manager.getEntries().findLast(entry => entry.type === 'message' && entry.message === event.message);
          // The earlier AgentSession listener has appended the exact object by this point.
          current = { ...current, revision: current.revision + 1, phase: 'ended', nativeEntryId: entry?.id ?? null,
            ...(current.phase === 'streaming' ? copyText(event.message) : {}) }; publish(current);
        } else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
          const old = cache.snapshots.get(`tool:${event.toolCallId}`) as ToolStreamSnapshot | undefined;
          const identity = input.readToolIdentity(event.toolCallId);
          publish({ type: 'tool.snapshot', streamConnection: input.streamConnection, runId: input.runId, sessionId: input.sessionId,
            nativeToolCallId: event.toolCallId, toolCallId: identity?.toolCallId ?? null, revision: (old?.revision ?? 0) + 1,
            phase: event.type === 'tool_execution_start' ? 'attempt' : event.type === 'tool_execution_update' ? 'progress' : 'ended', text: null, totalChars: null, truncated: false });
        }
      } catch { cache.incomplete = true; /* Ordinary observation errors never reject an SDK listener. */ }
    });
    return () => { if (disposed) return; disposed = true; stopAgent(); if (this.runs.get(input.runId) === cache) this.runs.delete(input.runId); };
  }
}
