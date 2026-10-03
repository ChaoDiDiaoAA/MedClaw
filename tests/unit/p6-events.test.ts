import { expect, test } from 'bun:test';
import { PublicMethodSchema, parsePublicPayload, isReadOnlyMethod } from '../../packages/contracts/src/protocol';
import { discoverTests } from '../run';

test('event reading is a public normalized observation', () => {
  expect(PublicMethodSchema.safeParse('event.read').success).toBe(true);
  expect(parsePublicPayload('event.read', { runId: 1 })).toEqual({ runId: 1, afterSequence: 0, throughSequence: null, limit: 50 });
});
test('event subscriptions are read-only and close accepts only its handle', () => {
  expect(isReadOnlyMethod('event.subscribe')).toBe(true);
  expect(parsePublicPayload('event.subscribe', { action: 'close', subscriptionId: 's1' })).toEqual({ action: 'close', subscriptionId: 's1' });
});
test('P6 discovery reaches actual test files', () => {
  expect(discoverTests('unit', 'P6').some(path => path.endsWith('p6-events.test.ts'))).toBe(true);
});

import * as events from '../../packages/contracts/src/event';
import { AppErrorSchema, safeError, serviceResult } from '../../packages/contracts/src/error';

test('safe event range errors retain recovery bounds without native detail', () => {
  const eventRange = { runId: 1, firstSequence: 1, lastSequence: 4, resumeAfterSequence: 2 };
  expect(safeError('event_gap', new Error('secret SQL'), { eventRange } as never)).toMatchObject({ code: 'event_gap', eventRange });
  expect(AppErrorSchema.safeParse({ ...safeError('internal_error'), eventRange }).success).toBe(false);
});
test('persistent event schemas reject future types and mismatched input targets', () => {
  const draft = { type: 'input_queued', payload: { contract: 'medclaw.event/v1', inputId: 1, targetRunId: 7, runId: null, status: 'queued', processingStatus: 'pending', errorCode: null }, runId: 7, sessionId: 2, source: 'application', sourceConnection: null, sourceSequence: null, toolCallId: null, occurredAt: '2026-10-03T00:00:00Z', receivedAt: '2026-10-03T00:00:00Z' };
  expect(events.RegisteredEventDraftSchema.safeParse(draft).success).toBe(true);
  expect(events.RegisteredEventDraftSchema.safeParse({ ...draft, runId: 8 }).success).toBe(false);
  expect(events.RegisteredEventDraftSchema.safeParse({ ...draft, type: 'history_saved' }).success).toBe(false);
  expect(events.RegisteredEventDraftSchema.safeParse({ ...draft, payload: { ...draft.payload, text: 'private' } }).success).toBe(false);
});
test('tool stream payload never exposes progress content', () => {
  const snapshot = { type: 'tool.snapshot', streamConnection: 'c1', runId: 1, sessionId: 1, revision: 1, nativeToolCallId: 't1', toolCallId: null, phase: 'progress', text: null, totalChars: null, truncated: false };
  expect(events.StreamSnapshotSchema.safeParse(snapshot).success).toBe(true);
  for (const unsafe of [{ text: 'secret' }, { totalChars: 0 }, { truncated: true }, { partialResult: 'secret' }]) expect(events.StreamSnapshotSchema.safeParse({ ...snapshot, ...unsafe }).success).toBe(false);
});
test('event cursor validates safe integers while preserving negative service errors', () => {
  expect(events.ReadEventsInputSchema.parse({ runId: 1, afterSequence: -1 }).afterSequence).toBe(-1);
  for (const bad of [{ limit: 101 }, { limit: 0 }, { afterSequence: 0.5 }, { afterSequence: Number.MAX_SAFE_INTEGER + 1 }]) expect(events.ReadEventsInputSchema.safeParse({ runId: 1, ...bad }).success).toBe(false);
  expect(events.EventSubscribeInputSchema.safeParse({ action: 'close', subscriptionId: 's1', runId: 1 }).success).toBe(false);
});
test('native tool identity uses existing tool contract rather than opaque product identity', () => {
  expect(events.ToolStreamSnapshotSchema.safeParse({ type: 'tool.snapshot', streamConnection: 'c1', runId: 1, sessionId: 1, revision: 1, nativeToolCallId: 'call/id', toolCallId: null, phase: 'attempt', text: null, totalChars: null, truncated: false }).success).toBe(true);
});
test('input terminal events preserve consumed delivery independently of processing failure', () => {
  const payload = { contract: 'medclaw.event/v1', inputId: 1, targetRunId: 7, runId: 7, status: 'consumed', processingStatus: 'failed', errorCode: 'provider_request_failed' };
  expect(events.RegisteredEventPayloadSchema.safeParse({ type: 'input_failed', payload }).success).toBe(true);
  expect(events.RegisteredEventPayloadSchema.safeParse({ type: 'input_cancelled', payload: { ...payload, processingStatus: 'cancelled' } }).success).toBe(true);
});
test('event projections validate in renderer without Node globals', () => {
  const original = globalThis.Buffer;
  try {
    globalThis.Buffer = undefined as never;
    expect(events.EventPageSchema.safeParse({ runId: 1, events: [], nextSequence: 0, hasMore: false, range: { firstSequence: null, lastSequence: 0 } }).success).toBe(true);
  } finally { globalThis.Buffer = original; }
});
test('native source sequence zero is a valid paired source identity', () => {
  expect(events.RegisteredEventDraftSchema.safeParse({ type: 'run_started', payload: { contract: 'medclaw.event/v1', sessionId: 1, kind: 'agent', configVersion: '1' }, runId: 1, sessionId: 1, source: 'pi', sourceConnection: 'c1', sourceSequence: 0, toolCallId: null, occurredAt: '2026-10-03T00:00:00Z', receivedAt: '2026-10-03T00:00:00Z' }).success).toBe(true);
});

test('service error conversion preserves validated object identities and event range', async () => {
  const original = safeError('event_gap', undefined, { operationRef:'op1', runId:1, sessionId:2, toolCallId:3, eventRange:{runId:1,firstSequence:1,lastSequence:7,resumeAfterSequence:6} });
  expect(await serviceResult(() => { throw original; }, 'internal_error')).toEqual({ok:false,error:original});
});

test('input failure rejects a completed processing fact while retaining unconfirmed delivery', () => {
  const payload = { contract:'medclaw.event/v1', inputId:1,targetRunId:7,runId:7,status:'consumed',processingStatus:'completed',errorCode:'provider_request_failed' };
  expect(events.RegisteredEventPayloadSchema.safeParse({type:'input_failed',payload}).success).toBe(false);
  expect(events.RegisteredEventPayloadSchema.safeParse({type:'input_failed',payload:{...payload,runId:null,status:'delivery_unknown',processingStatus:'pending',errorCode:'input_delivery_unknown'}}).success).toBe(true);
});
