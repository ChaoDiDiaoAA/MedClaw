import { EVENT_LIMITS, type EventPage, type OpenEventSubscriptionResult, type StreamSnapshot, type StoredRunEvent } from '../../../../packages/contracts/src/event';
import type { DesktopBridge } from './App';
import { errorMessage, type AppError } from '../../../../packages/contracts/src/error';
import { useEffect, useRef, useState } from 'react';
import type { HostView } from '../../../../packages/contracts/src/model';
import type { RunView } from '../../../../packages/contracts/src/run';

export type ReadingAnchor = { key: string; nativeEntryId: string | null; neighbors: string[] };
export function resolveReadingAnchor(anchor: ReadingAnchor, available: string[], aliases: Record<string, string>): { key: string | null; contentUpdated: boolean } {
  if (available.includes(anchor.key)) return { key: anchor.key, contentUpdated: false };
  const mapped = anchor.nativeEntryId ? 'native:' + anchor.nativeEntryId : aliases[anchor.key];
  if (mapped && available.includes(mapped)) return { key: mapped, contentUpdated: false };
  const neighbor = anchor.neighbors.map(key => available.includes(key) ? key : aliases[key]).find(key => key !== undefined && available.includes(key));
  return { key: neighbor ?? available[0] ?? null, contentUpdated: true };
}
export function shouldRecordScroll(prior: { following: boolean } | undefined, scrollHeight: number, clientHeight: number, userInitiated = true): boolean {
  return userInitiated && (prior?.following !== false || scrollHeight > clientHeight);
}

export function finalDisplaySource(run: { status: RunView['status']; cleanup: { requiredPersistenceComplete: boolean | null } | null }, coverage: { available: boolean; runCovered: boolean; unavailable: boolean }): 'native' | 'saved' | 'unavailable' | null {
  if (!['completed', 'failed', 'cancelled'].includes(run.status)) return null;
  if (run.cleanup?.requiredPersistenceComplete !== true) return coverage.unavailable ? 'unavailable' : null;
  if (coverage.available && coverage.runCovered) return 'native';
  return coverage.unavailable ? 'saved' : null;
}

export class RunEventSubscription {
  readonly subscriptionId = crypto.randomUUID();
  readonly originalOpen;
  private stopped = false;
  private started = false;
  private initialized = false;
  private busy: Promise<void> | null = null;
  private unlisten: (() => void) | null = null;
  private hinted = 0;
  private terminalNotified = false;
  private resumeAfter: number | null = null;
  constructor(readonly projection: RunEventProjection, readonly instanceId: string, private readonly bridge: Pick<DesktopBridge, 'request' | 'subscribe'>, private readonly changed: () => void, private readonly terminal: () => void) {
    this.originalOpen = { action: 'open' as const, subscriptionId: this.subscriptionId, runId: projection.state.runId, afterSequence: projection.state.cursor, limit: 50 };
  }
  private publish() { if (!this.stopped) this.changed(); }
  private failed(error: AppError) {
    this.projection.readFailed(errorMessage(error));
    if (error.code === 'event_gap' && error.eventRange?.runId === this.projection.state.runId) this.projection.state.gap = error.eventRange;
    this.projection.state.phase = 'error'; this.publish();
  }
  async start(): Promise<void> {
    if (this.started || this.stopped) return; this.started = true;
    this.projection.state.phase = 'opening'; this.publish();
    this.unlisten = this.bridge.subscribe(notice => {
      if (this.stopped || notice.instanceId !== this.instanceId) return;
      if (notice.type === 'event.available' && notice.subscriptionId === this.subscriptionId && notice.runId === this.projection.state.runId && notice.sessionId === this.projection.state.sessionId) {
        this.hinted = Math.max(this.hinted, notice.highWatermark);
        if (this.initialized) void this.refresh();
      } else if (notice.type === 'event.stream' && notice.subscriptionId === this.subscriptionId) {
        this.projection.applySnapshot(notice.snapshot); this.publish();
      }
    });
    const work = this.initialize(); this.busy = work;
    try { await work; } finally { if (this.busy === work) this.busy = null; }
  }
  private async initialize(): Promise<void> {
    try {
      const ack = await this.bridge.request('event.subscribe', this.originalOpen);
      if (this.stopped) { await this.close(); return; }
      if (!ack.ok) { this.failed(ack.error); return; }
      if (ack.data.action !== 'open' || ack.data.subscriptionId !== this.subscriptionId || ack.data.runId !== this.projection.state.runId || ack.data.sessionId !== this.projection.state.sessionId) { this.projection.readFailed('Event subscription reply did not match the original Run.'); this.publish(); return; }
      this.projection.applySnapshots(ack.data); this.projection.state.phase = 'replaying'; this.publish();
      await this.read(ack.data.highWatermark);
      if (this.stopped) return;
      await this.read(null);
      this.initialized = true;
    } catch { if (!this.stopped) { this.projection.readFailed('Event display disconnected. Read the original Run again.'); this.projection.state.phase = 'disconnected'; this.publish(); } }
  }
  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.busy) return this.busy;
    const work = (async () => {
      if (!this.initialized) { await this.initialize(); return; }
      try {
        const ack = await this.bridge.request('event.subscribe', this.originalOpen);
        if (this.stopped) return;
        if (ack.ok && ack.data.action === 'open' && ack.data.subscriptionId === this.subscriptionId && ack.data.runId === this.projection.state.runId && ack.data.sessionId === this.projection.state.sessionId) this.projection.applySnapshots(ack.data);
        else if (!ack.ok) this.failed(ack.error);
        await this.read(null);
      } catch { if (!this.stopped) { this.projection.readFailed('Event display disconnected. Showing the last verified Timeline.'); this.projection.state.phase = 'disconnected'; this.publish(); } }
    })();
    this.busy = work; try { await work; } finally { if (this.busy === work) this.busy = null; }
  }
  private async read(through: number | null): Promise<void> {
    let bound = through;
    do {
      const after = this.resumeAfter ?? this.projection.state.cursor;
      if (bound !== null && after === bound) break;
      const result = await this.bridge.request('event.read', { runId: this.projection.state.runId, afterSequence: after, throughSequence: bound, limit: 50 });
      if (this.stopped) return;
      if (!result.ok) { this.failed(result.error); return; }
      if (!this.projection.applyPage(result.data, this.resumeAfter)) { this.projection.readFailed('Event page was not contiguous with this Run cursor. Read the original Run again.'); this.projection.state.phase = 'error'; this.publish(); return; }
      this.resumeAfter = null; bound ??= result.data.range.lastSequence;
      this.publish();
      if (this.projection.state.terminal && !this.terminalNotified) { this.terminalNotified = true; try { this.terminal(); } catch { /* Display observers cannot change committed facts. */ } }
      if (!result.data.hasMore) break;
    } while (!this.stopped);
    if (!this.stopped) { this.projection.state.phase = 'live'; this.publish(); }
    // A higher hint arriving during a fixed read is recovered by the next read/1 s poll.
    this.hinted = Math.max(this.hinted, this.projection.state.cursor);
  }
  async resumeGap(): Promise<void> {
    if (this.busy) await this.busy;
    const resume = this.projection.state.gap?.resumeAfterSequence;
    if (resume == null || this.stopped) return;
    this.resumeAfter = resume; const work = this.read(null); this.busy = work;
    try { await work; } finally { if (this.busy === work) this.busy = null; }
  }
  private async close(): Promise<void> { try { await this.bridge.request('event.subscribe', { action: 'close', subscriptionId: this.subscriptionId }); } catch { /* The captured Host instance owns cleanup after disconnect. */ } }
  async stop(): Promise<void> { this.stopped = true; this.unlisten?.(); this.unlisten = null; await this.close(); }
}

export interface RunEventProjectionState {
  runId: number; sessionId: number; cursor: number; events: StoredRunEvent[]; snapshots: StreamSnapshot[];
  prefixUnrecorded: boolean; terminal: boolean; finalSource: 'temporary' | 'native' | 'saved' | 'unavailable';
  error: string | null; snapshotsIncomplete: boolean;
  phase: 'idle' | 'opening' | 'replaying' | 'live' | 'disconnected' | 'error';
  gap: NonNullable<AppError['eventRange']> | null;
  nativeEntries: Record<string, string>;
}

export class RunEventProjection {
  readonly state: RunEventProjectionState;
  private connection: string | null = null;
  private authorityInstance: string | null = null;
  bindInstance(instanceId: string): void {
    if (this.authorityInstance !== null && this.authorityInstance !== instanceId && this.state.finalSource === 'native') this.state.finalSource = 'saved';
    this.authorityInstance = instanceId;
  }
  constructor(runId: number, sessionId: number) { this.state = { runId, sessionId, cursor: 0, events: [], snapshots: [], prefixUnrecorded: false, terminal: false, finalSource: 'temporary', error: null, snapshotsIncomplete: false, phase: 'idle', gap: null, nativeEntries: {} }; }
  applyPage(page: EventPage, explicitResume: number | null = null): boolean {
    if (page.runId !== this.state.runId || page.events.some(event => event.runId !== this.state.runId || event.sessionId !== this.state.sessionId)) return false;
    const fresh = page.events.filter(event => event.sequence > this.state.cursor);
    if (fresh.some((event, index) => event.sequence !== (explicitResume ?? this.state.cursor) + index + 1) || page.nextSequence !== (fresh.at(-1)?.sequence ?? this.state.cursor)) return false;
    if (!this.state.events.length && fresh[0]?.sequence === 1 && fresh[0].type !== 'run_created') this.state.prefixUnrecorded = true;
    this.state.events.push(...structuredClone(fresh)); this.state.cursor = page.nextSequence; this.state.error = null;
    this.state.terminal ||= fresh.some(event => ['run_completed', 'run_failed', 'run_cancelled'].includes(event.type));
    return true;
  }
  applySnapshots(ack: Pick<OpenEventSubscriptionResult, 'runId' | 'sessionId' | 'streamConnection' | 'snapshots' | 'snapshotsIncomplete'>): void {
    if (ack.runId !== this.state.runId || ack.sessionId !== this.state.sessionId) return;
    if (this.connection !== ack.streamConnection) { this.state.snapshots = []; this.connection = ack.streamConnection; }
    this.state.snapshotsIncomplete ||= ack.snapshotsIncomplete;
    ack.snapshots.forEach(snapshot => this.applySnapshot(snapshot));
  }
  applySnapshot(snapshot: StreamSnapshot): void {
    if (snapshot.runId !== this.state.runId || snapshot.sessionId !== this.state.sessionId) return;
    if (this.connection !== null && snapshot.streamConnection !== this.connection) return;
    this.connection ??= snapshot.streamConnection;
    const identity = (value: StreamSnapshot) => value.type === 'message.snapshot' ? 'message:' + value.messageId : 'tool:' + value.nativeToolCallId;
    const at = this.state.snapshots.findIndex(value => identity(value) === identity(snapshot));
    const prior = this.state.snapshots[at];
    if (prior && snapshot.revision <= prior.revision) return;
    if (this.state.terminal || this.state.finalSource !== 'temporary') {
      if (snapshot.type === 'message.snapshot' && snapshot.phase === 'ended' && prior?.type === 'message.snapshot') {
        this.state.snapshots[at] = { ...prior, revision: snapshot.revision, phase: 'ended', nativeEntryId: snapshot.nativeEntryId ?? prior.nativeEntryId };
        this.rememberEntry(snapshot);
      }
      return;
    }
    const copy = structuredClone(snapshot);
    if (copy.type === 'message.snapshot') this.rememberEntry(copy);
    if (at < 0) this.state.snapshots.push(copy); else this.state.snapshots[at] = copy;
    while (this.state.snapshots.length > EVENT_LIMITS.maxSnapshots || new TextEncoder().encode(JSON.stringify(this.state.snapshots)).byteLength > EVENT_LIMITS.pageBytes) {
      this.state.snapshots.shift(); this.state.snapshotsIncomplete = true;
    }
    this.state.snapshots.sort((a, b) => a.type === 'message.snapshot' && b.type === 'message.snapshot' ? a.ordinal - b.ordinal : a.type === b.type ? 0 : a.type === 'message.snapshot' ? -1 : 1);
  }
  private rememberEntry(snapshot: Extract<StreamSnapshot, { type: 'message.snapshot' }>): void {
    if (snapshot.phase !== 'ended' || snapshot.nativeEntryId === null) return;
    this.state.nativeEntries['message:' + snapshot.streamConnection + '/' + snapshot.messageId] = 'native:' + snapshot.nativeEntryId;
    const keys = Object.keys(this.state.nativeEntries);
    if (keys.length > EVENT_LIMITS.maxSnapshots) delete this.state.nativeEntries[keys[0]!];
  }
  replaceAuthoritative(source: 'native' | 'saved' | 'unavailable'): void {
    this.state.finalSource = source;
  }
  readFailed(message: string): void { this.state.error = message; }
}

/** One display subscription belongs to one App view. Runtime collection is independent. */
export function useRunEvents(host: HostView, run: RunView | null, enabled: boolean, onTerminal: (runId: number, sessionId: number) => void) {
  const cache = useRef(new Map<number, RunEventProjection>()), controller = useRef<RunEventSubscription | null>(null);
  const terminal = useRef(onTerminal); terminal.current = onTerminal;
  const [, render] = useState(0), [visible, setVisible] = useState(() => !document.hidden);
  const agent = run?.kind === 'agent' ? run : null;
  let projection = agent ? cache.current.get(agent.id) : null;
  if (agent && !projection) {
    projection = new RunEventProjection(agent.id, agent.sessionId); cache.current.set(agent.id, projection);
    if (cache.current.size > 50) cache.current.delete(cache.current.keys().next().value!);
  }
  const current = projection;
  useEffect(() => { const update = () => setVisible(!document.hidden); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update); }, []);
  useEffect(() => {
    if (!current) return;
    if (host.state !== 'ready' || !host.instanceId) { current.state.phase = 'disconnected'; render(value => value + 1); return; }
    if (!enabled || !visible) return;
    current.bindInstance(host.instanceId);
    const next = new RunEventSubscription(current, host.instanceId, window.medclaw, () => render(value => value + 1), () => terminal.current(current.state.runId, current.state.sessionId));
    controller.current = next; void next.start();
    const timer = setInterval(() => void next.refresh(), 1000);
    return () => { clearInterval(timer); if (controller.current === next) controller.current = null; void next.stop(); };
  }, [current, host.instanceId, host.state, enabled, visible]);
  return {
    state: current?.state ?? null,
    resumeGap: () => { const active = controller.current; if (active && active.projection === current) void active.resumeGap(); },
    setFinalSource: (source: 'native' | 'saved' | 'unavailable') => {
      if (current && current.state.finalSource !== source) { current.replaceAuthoritative(source); render(value => value + 1); }
    },
  };
}
