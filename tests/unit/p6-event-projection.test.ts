import { test, expect } from 'bun:test';
import { RunEventProjection, RunEventSubscription, finalDisplaySource, resolveReadingAnchor, shouldRecordScroll } from '../../apps/desktop/src/renderer/use-run-events';
import type { EventPage, MessageStreamSnapshot, StoredRunEvent } from '../../packages/contracts/src/event';
import type { DesktopBridge } from '../../apps/desktop/src/renderer/App';
import type { DesktopNotice } from '../../packages/contracts/src/protocol';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const time = '2026-10-03T00:00:00.000Z';
const event = (sequence: number, runId = 1): Extract<StoredRunEvent, { type: 'run_created' }> => ({ eventId: sequence + 10, sequence, runId, sessionId: 2, source: 'application', sourceConnection: null, sourceSequence: null, toolCallId: null, occurredAt: time, receivedAt: time, type: 'run_created', payload: { contract: 'medclaw.event/v1', sessionId: 2, kind: 'agent', configVersion: '1' } });
const page = (events: StoredRunEvent[], nextSequence = events.at(-1)?.sequence ?? 0): EventPage => ({ runId: 1, events, nextSequence, hasMore: false, range: { firstSequence: 1, lastSequence: Math.max(3, nextSequence) } });
const snapshot = (revision: number, text: string, phase: MessageStreamSnapshot['phase'] = 'streaming', messageId = 'm1'): MessageStreamSnapshot => ({ type: 'message.snapshot', runId: 1, sessionId: 2, streamConnection: 'connection1', messageId, ordinal: 1, revision, phase, modelCallId: 'call1', nativeEntryId: null, blocks: [{ contentIndex: 0, text }], totalChars: text.length, truncated: false });

// Advancing on a hint or an out-of-order page would omit a real committed event.
test('projection_deduplicates_and_never_advances_on_out_of_order_hint', () => {
  const view = new RunEventProjection(1, 2);
  expect(view.applyPage(page([event(2)], 2))).toBe(false);
  expect(view.state.cursor).toBe(0);
  expect(view.applyPage(page([event(1), event(2)], 2))).toBe(true);
  expect(view.applyPage(page([event(1), event(2)], 2))).toBe(true);
  expect(view.state.cursor).toBe(2);
  expect(view.state.events.map(value => value.eventId)).toEqual([11, 12]);
});
test('a_late_reply_cannot_update_b_projection', () => {
  const view = new RunEventProjection(3, 4);
  expect(view.applyPage(page([event(1)]))).toBe(false);
  view.applySnapshot(snapshot(1, 'A only'));
  expect(view.state.events).toEqual([]); expect(view.state.snapshots).toEqual([]);
});
test('lost_projection_forces_read_from_zero', () => {
  const view = new RunEventProjection(1, 2); view.applyPage(page([event(1)]));
  const reloaded = new RunEventProjection(1, 2);
  expect(view.state.cursor).toBe(1); expect(reloaded.state.cursor).toBe(0); expect(reloaded.state.events).toEqual([]);
});
test('late_ended_only_updates_known_message_entry_metadata', () => {
  const view = new RunEventProjection(1, 2); view.applySnapshot(snapshot(1, 'original'));
  view.replaceAuthoritative('native');
  view.applySnapshot({ ...snapshot(2, 'late mutation', 'ended'), nativeEntryId: 'entry1' });
  view.applySnapshot(snapshot(3, 'unexpected new bubble', 'ended', 'unknown'));
  expect(view.state.snapshots).toHaveLength(1);
  const known = view.state.snapshots[0] as MessageStreamSnapshot;
  expect(known.blocks[0]?.text).toBe('original'); expect(known.nativeEntryId).toBe('entry1');
});
test('authoritative_run_messages_replace_whole_temporary_area', () => {
  const view = new RunEventProjection(1, 2); view.applySnapshot(snapshot(1, 'draft'));
  view.replaceAuthoritative('native'); expect(view.state.finalSource).toBe('native');
  view.applySnapshot(snapshot(2, 'late temporary body')); expect(view.state.finalSource).toBe('native');
  expect((view.state.snapshots[0] as MessageStreamSnapshot).blocks[0]?.text).toBe('draft');
});
test('unavailable_native_history_uses_one_saved_final_area', () => {
  const view = new RunEventProjection(1, 2); view.applySnapshot(snapshot(1, 'draft'));
  view.replaceAuthoritative('saved'); expect(view.state.finalSource).toBe('saved');
});
test('old_run_first_non_created_event_keeps_prefix_unrecorded_marker', () => {
  const view = new RunEventProjection(1, 2);
  const started = { ...event(1), type: 'run_started' as const };
  expect(view.applyPage(page([started]))).toBe(true);
  view.applyPage(page([event(2)], 2)); expect(view.state.prefixUnrecorded).toBe(true);
});
test('read_failure_preserves_last_proven_timeline', () => {
  const view = new RunEventProjection(1, 2); view.applyPage(page([event(1)]));
  view.readFailed('offline'); expect(view.state.cursor).toBe(1); expect(view.state.events).toHaveLength(1); expect(view.state.error).toBe('offline');
});
test('snapshot_revisions_and_connection_are_independent_from_cursor', () => {
  const view = new RunEventProjection(1, 2); view.applySnapshot(snapshot(3, 'new')); view.applySnapshot(snapshot(1, 'old'));
  expect((view.state.snapshots[0] as MessageStreamSnapshot).blocks[0]?.text).toBe('new'); expect(view.state.cursor).toBe(0);
  view.applySnapshots({ runId: 1, sessionId: 2, streamConnection: 'connection2', snapshots: [], snapshotsIncomplete: true });
  expect(view.state.snapshots).toEqual([]); expect(view.state.snapshotsIncomplete).toBe(true);
});

function eventBridge() {
  const operations: { method: string; payload: any }[] = [];
  let listener: ((notice: DesktopNotice & { instanceId: string | null }) => void) | null = null;
  let opened = false;
  const bridge: Pick<DesktopBridge, 'request' | 'subscribe'> = {
    subscribe(value) { listener = value; return () => { listener = null; }; },
    request: (async (method: string, payload: any) => {
      operations.push({ method, payload: structuredClone(payload) });
      if (method === 'event.subscribe' && payload.action === 'close') return { ok: true, data: { action: 'close', subscriptionId: payload.subscriptionId, closed: true } };
      if (method === 'event.subscribe') {
        if (!opened) { opened = true; listener?.({ instanceId: 'instance1', type: 'event.available', subscriptionId: payload.subscriptionId, runId: 1, sessionId: 2, highWatermark: 3, resyncRequired: false }); }
        return { ok: true, data: { action: 'open', subscriptionId: payload.subscriptionId, runId: 1, sessionId: 2, highWatermark: 2, range: { firstSequence: 1, lastSequence: 2 }, streamConnection: 'connection1', snapshots: [snapshot(2, 'refreshed')], snapshotsIncomplete: false } };
      }
      if (method === 'event.read') {
        const upper = payload.throughSequence ?? 3;
        const events = [1, 2, 3].filter(sequence => sequence > payload.afterSequence && sequence <= upper).map(sequence => event(sequence));
        return { ok: true, data: { ...page(events, events.at(-1)?.sequence ?? payload.afterSequence), range: { firstSequence: 1, lastSequence: 3 } } };
      }
      throw new Error('Unexpected execution operation: ' + method);
    }) as DesktopBridge['request'],
  };
  return { bridge, operations, emit: (notice: DesktopNotice & { instanceId: string | null }) => listener?.(notice) };
}
test('snapshot_refresh_reuses_original_open_parameters_without_reentering_initial_replay', async () => {
  const fixture = eventBridge(), view = new RunEventProjection(1, 2);
  const controller = new RunEventSubscription(view, 'instance1', fixture.bridge, () => {}, () => {});
  await controller.start(); expect(view.state.cursor).toBe(3);
  await controller.refresh();
  const opens = fixture.operations.filter(operation => operation.method === 'event.subscribe' && operation.payload.action === 'open');
  expect(opens).toHaveLength(2); expect(opens[1]!.payload).toEqual(opens[0]!.payload); expect(opens[1]!.payload.afterSequence).toBe(0);
  expect(fixture.operations.filter(operation => operation.method === 'event.read').map(operation => operation.payload.throughSequence)).toEqual([2, null, null]);
  expect(view.state.cursor).toBe(3); expect((view.state.snapshots[0] as MessageStreamSnapshot).blocks[0]?.text).toBe('refreshed');
  await controller.stop();
});
test('terminal_event_refreshes_authoritative_run_and_control', async () => {
  const fixture = eventBridge(), view = new RunEventProjection(1, 2); let reads = 0;
  const request = fixture.bridge.request;
  fixture.bridge.request = (async (method: string, payload: any) => {
    const result: any = await request(method as any, payload);
    if (method === 'event.read') result.data.events = result.data.events.map((item: StoredRunEvent) => item.sequence === 3 ? { ...item, type: 'run_completed', payload: { contract: 'medclaw.event/v1', answerId: 9, errorCode: null, stopConfirmed: true } } : item);
    return result;
  }) as DesktopBridge['request'];
  const controller = new RunEventSubscription(view, 'instance1', fixture.bridge, () => {}, () => { reads++; });
  await controller.start(); await controller.refresh(); expect(view.state.terminal).toBe(true); expect(reads).toBe(1);
  await controller.stop();
});
test('stopped_view_closes_late_open_and_ignores_old_reply', async () => {
  const fixture = eventBridge(), view = new RunEventProjection(1, 2); const oldRequest = fixture.bridge.request;
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  fixture.bridge.request = (async (method: string, payload: any) => { if (method === 'event.subscribe' && payload.action === 'open') await blocked; return oldRequest(method as any, payload); }) as DesktopBridge['request'];
  const controller = new RunEventSubscription(view, 'instance1', fixture.bridge, () => {}, () => {});
  const opening = controller.start(); await controller.stop(); release(); await opening;
  expect(view.state.cursor).toBe(0); expect(fixture.operations.filter(operation => operation.method === 'event.subscribe' && operation.payload.action === 'close')).toHaveLength(2);
});
test('failed_initial_open_can_recover_display_with_original_parameters', async () => {
  const fixture = eventBridge(), view = new RunEventProjection(1, 2), original = fixture.bridge.request; let fail = true;
  fixture.bridge.request = (async (method: string, payload: any) => {
    if (method === 'event.subscribe' && payload.action === 'open' && fail) { fail = false; throw new Error('Injected lost open reply'); }
    return original(method as any, payload);
  }) as DesktopBridge['request'];
  const controller = new RunEventSubscription(view, 'instance1', fixture.bridge, () => {}, () => {});
  await controller.start(); expect(view.state.phase).toBe('disconnected'); expect(view.state.cursor).toBe(0);
  await controller.refresh(); expect(view.state.cursor).toBe(3); expect(view.state.phase).toBe('live');
  await controller.stop();
});
test('gap_recovery_is_explicit_and_keeps_old_rows_and_gap_marker', async () => {
  const fixture = eventBridge(), view = new RunEventProjection(1, 2), original = fixture.bridge.request;
  view.applyPage(page([event(1)]));
  fixture.bridge.request = (async (method: string, payload: any) => {
    if (method === 'event.read') {
      if (payload.afterSequence < 6) return { ok: false, error: { code: 'event_gap', category: 'persistence', message: 'Run event records are incomplete.', retryable: false, eventRange: { runId: 1, firstSequence: 1, lastSequence: 7, resumeAfterSequence: 6 } } };
      return { ok: true, data: { ...page([event(7)], 7), range: { firstSequence: 1, lastSequence: 7 } } };
    }
    return original(method as any, payload);
  }) as DesktopBridge['request'];
  const controller = new RunEventSubscription(view, 'instance1', fixture.bridge, () => {}, () => {});
  await controller.start(); expect(view.state.cursor).toBe(1); expect(view.state.gap?.resumeAfterSequence).toBe(6);
  await controller.resumeGap(); expect(view.state.cursor).toBe(7); expect(view.state.events.map(item => item.sequence)).toEqual([1, 7]); expect(view.state.gap?.resumeAfterSequence).toBe(6);
  await controller.stop();
});
test('poll_during_pending_open_does_not_create_concurrent_initialization', async () => {
  const fixture = eventBridge(), view = new RunEventProjection(1, 2), original = fixture.bridge.request;
  let release!: () => void, opens = 0; const barrier = new Promise<void>(resolve => { release = resolve; });
  fixture.bridge.request = (async (method: string, payload: any) => {
    if (method === 'event.subscribe' && payload.action === 'open') { opens++; await barrier; }
    return original(method as any, payload);
  }) as DesktopBridge['request'];
  const controller = new RunEventSubscription(view, 'instance1', fixture.bridge, () => {}, () => {});
  const initial = controller.start(), poll = controller.refresh(); release(); await Promise.all([initial, poll]);
  expect(opens).toBe(1); expect(view.state.cursor).toBe(3); await controller.stop();
});
test('native_coverage_and_required_save_are_both_needed_to_replace_temporary_body', () => {
  const coverage = { available: true, runCovered: true, unavailable: false };
  expect(finalDisplaySource({ status: 'completed', cleanup: { requiredPersistenceComplete: false } }, coverage)).toBe(null);
  expect(finalDisplaySource({ status: 'completed', cleanup: { requiredPersistenceComplete: true } }, { ...coverage, runCovered: false })).toBe(null);
  expect(finalDisplaySource({ status: 'completed', cleanup: { requiredPersistenceComplete: true } }, coverage)).toBe('native');
  expect(finalDisplaySource({ status: 'completed', cleanup: { requiredPersistenceComplete: true } }, { available: false, runCovered: false, unavailable: true })).toBe('saved');
  expect(finalDisplaySource({ status: 'failed', cleanup: { requiredPersistenceComplete: false } }, { available: false, runCovered: false, unavailable: true })).toBe('unavailable');
});
test('message_ordinal_orders_text_even_when_tool_progress_arrives_between_messages', () => {
  const view = new RunEventProjection(1, 2);
  view.applySnapshot({ ...snapshot(1, 'second', 'streaming', 'm2'), ordinal: 2 });
  view.applySnapshot({ type: 'tool.snapshot', runId: 1, sessionId: 2, streamConnection: 'connection1', revision: 1, nativeToolCallId: 'tool_1', toolCallId: null, phase: 'attempt', text: null, totalChars: null, truncated: false });
  view.applySnapshot(snapshot(1, 'first'));
  expect(view.state.snapshots.filter(value => value.type === 'message.snapshot').map(value => value.messageId)).toEqual(['m1', 'm2']);
});
test('native_final_authority_is_bound_to_its_host_instance_and_falls_back_to_saved_facts', () => {
  const view = new RunEventProjection(1, 2); view.bindInstance('instance1'); view.replaceAuthoritative('native');
  view.bindInstance('instance1'); expect(view.state.finalSource).toBe('native');
  view.bindInstance('instance2'); expect(view.state.finalSource).toBe('saved');
  view.replaceAuthoritative('native'); expect(view.state.finalSource).toBe('native');
});
test('new_view_without_a_native_page_reselects_saved_final_facts_in_the_same_host', () => {
  const view = new RunEventProjection(1, 2); view.bindInstance('instance1'); view.replaceAuthoritative('native');
  const next = finalDisplaySource({ status: 'completed', cleanup: { requiredPersistenceComplete: true } }, { available: false, runCovered: false, unavailable: true });
  expect(next).toBe('saved'); view.replaceAuthoritative(next!); expect(view.state.finalSource).toBe('saved');
  view.replaceAuthoritative('native'); expect(view.state.finalSource).toBe('native');
});
test('temporary_reading_anchor_maps_to_real_sdk_entry_after_whole_region_replacement', () => {
  const manager = SessionManager.inMemory(process.cwd());
  const nativeId = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'final original answer' }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
  const view = new RunEventProjection(1, 2); view.applySnapshot(snapshot(1, 'final original answer'));
  view.applySnapshot({ ...snapshot(2, 'final original answer', 'ended'), nativeEntryId: nativeId });
  view.replaceAuthoritative('native'); view.applySnapshots({ runId: 1, sessionId: 2, streamConnection: null, snapshots: [], snapshotsIncomplete: false });
  const available = manager.getEntries().map(entry => 'native:' + entry.id);
  expect(resolveReadingAnchor({ key: 'message:connection1/m1', nativeEntryId: null, neighbors: [] }, available, view.state.nativeEntries)).toEqual({ key: 'native:' + nativeId, contentUpdated: false });
});
test('missing_anchor_uses_proven_neighbor_and_marks_content_update', () => {
  expect(resolveReadingAnchor({ key: 'message:lost/m1', nativeEntryId: null, neighbors: ['native:original-before', 'native:original-after'] }, ['native:unrelated', 'native:original-after'], {})).toEqual({ key: 'native:original-after', contentUpdated: true });
});
test('collapsed_transition_does_not_overwrite_upscroll_intent_with_following', () => {
  expect(shouldRecordScroll({ following: false }, 350, 500)).toBe(false);
  expect(shouldRecordScroll({ following: false }, 2500, 500)).toBe(true);
  expect(shouldRecordScroll({ following: true }, 350, 500)).toBe(true);
});
test('layout_clamp_in_a_still_scrollable_transition_keeps_the_recorded_reading_intent', () => {
  expect(shouldRecordScroll({ following: false }, 900, 270, false)).toBe(false);
  expect(shouldRecordScroll({ following: false }, 900, 270, true)).toBe(true);
  expect(shouldRecordScroll({ following: true }, 900, 270, false)).toBe(false);
});
test('missing_temporary_anchor_resolves_known_native_neighbor_before_unrelated_history', () => {
  const manager = SessionManager.inMemory(process.cwd());
  const appendAssistant = (text: string) => manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
  const unrelatedId = appendAssistant('earlier unrelated history'), firstId = appendAssistant('original first'), thirdId = appendAssistant('original third');
  const view = new RunEventProjection(1, 2);
  view.applySnapshot({ ...snapshot(1, 'original first', 'ended', 'm1'), nativeEntryId: firstId });
  view.applySnapshot({ ...snapshot(1, 'original middle', 'streaming', 'm2'), ordinal: 2 });
  view.applySnapshot({ ...snapshot(1, 'original third', 'ended', 'm3'), ordinal: 3, nativeEntryId: thirdId });
  view.replaceAuthoritative('native');
  const available = manager.getEntries().map(entry => 'native:' + entry.id);
  expect(available[0]).toBe('native:' + unrelatedId);
  expect(resolveReadingAnchor({ key: 'message:connection1/m2', nativeEntryId: null, neighbors: ['message:connection1/m3', 'message:connection1/m1'] }, available, view.state.nativeEntries)).toEqual({ key: 'native:' + thirdId, contentUpdated: true });
});
