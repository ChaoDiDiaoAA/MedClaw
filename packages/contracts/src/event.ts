import { z } from 'zod';
import { PositiveIdSchema, OpaqueIdSchema, TimestampSchema, AppErrorSchema } from './error';
import { ConfigVersionSchema } from './model';
import { ToolCallRecordSchema } from './tool';
import { InputStatusSchema, InputProcessingStatusSchema } from './session';

export const EVENT_LIMITS = { defaultLimit: 50, maxLimit: 100, payloadBytes: 65536, pageBytes: 3 * 1024 * 1024, maxSubscriptions: 16, maxPendingNotices: 256, maxSnapshots: 32, maxTextChars: 32768 } as const;
export const EventIntegerSchema = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const nonnegative = EventIntegerSchema.nonnegative();
const errorCode = AppErrorSchema.shape.code;
const ids = z.array(PositiveIdSchema).refine(values => new Set(values).size === values.length, 'IDs must be unique');
const contract = { contract: z.literal('medclaw.event/v1') };
const input = { inputId: PositiveIdSchema, targetRunId: PositiveIdSchema.nullable(), runId: PositiveIdSchema.nullable(), status: InputStatusSchema, processingStatus: InputProcessingStatusSchema, errorCode: errorCode.nullable() };
const terminal = { answerId: PositiveIdSchema.nullable(), errorCode: errorCode.nullable(), stopConfirmed: z.boolean().nullable() };
const tool = { callId: PositiveIdSchema, nativeToolCallId: ToolCallRecordSchema.shape.nativeToolCallId, status: z.enum(['requested', 'running', 'succeeded', 'failed', 'cancelled']), queryIds: ids, errorCode: errorCode.nullable() };
const variant = <T extends string, S extends z.ZodRawShape>(type: T, fields: S) => z.strictObject({ type: z.literal(type), payload: z.strictObject({ ...contract, ...fields }) });
export const RegisteredEventPayloadSchema = z.discriminatedUnion('type', [
  variant('run_created', { sessionId: PositiveIdSchema, kind: z.literal('agent'), configVersion: ConfigVersionSchema }),
  variant('run_started', { sessionId: PositiveIdSchema, kind: z.literal('agent'), configVersion: ConfigVersionSchema }),
  variant('run_cancel_requested', { reason: errorCode }),
  variant('run_completed', { ...terminal, errorCode: z.null() }),
  variant('run_failed', { ...terminal, errorCode }),
  variant('run_cancelled', terminal),
  variant('input_accepted', { ...input, runId: z.null(), status: z.literal('queued'), processingStatus: z.literal('pending'), errorCode: z.null() }),
  variant('input_queued', { ...input, runId: z.null(), status: z.literal('queued'), processingStatus: z.literal('pending'), errorCode: z.null() }),
  variant('input_delivered', { ...input, phase: z.enum(['sdk_received', 'native_consumed']) }),
  variant('input_processed', { ...input, processingStatus: z.literal('completed') }),
  variant('input_cancelled', { ...input, processingStatus: z.literal('cancelled') }),
  variant('input_failed', { ...input, processingStatus: z.enum(['pending', 'failed']) }),
  variant('tool_requested', { ...tool, status: z.literal('requested') }),
  variant('tool_started', { ...tool, status: z.literal('running') }),
  variant('tool_finished', { ...tool, status: z.enum(['succeeded', 'failed', 'cancelled']) }),
  variant('query_completed', { queryId: PositiveIdSchema, resultHash: z.string().regex(/^[a-f0-9]{64}$/), batchIds: ids }),
]);
export const EventSourceSchema = z.enum(['application', 'pi', 'intent', 'tool', 'host']);
const envelope = { runId: PositiveIdSchema, sessionId: PositiveIdSchema, source: EventSourceSchema, sourceConnection: OpaqueIdSchema.nullable(), sourceSequence: nonnegative.nullable(), toolCallId: PositiveIdSchema.nullable(), occurredAt: TimestampSchema, receivedAt: TimestampSchema };
function validEvent(event: RegisteredEventDraft, ctx: z.RefinementCtx) {
  if ((event.sourceConnection === null) !== (event.sourceSequence === null)) ctx.addIssue({ code: 'custom', message: 'Source identity must be paired' });
  if (new TextEncoder().encode(JSON.stringify(event.payload)).byteLength > EVENT_LIMITS.payloadBytes) ctx.addIssue({ code: 'custom', message: 'Event payload exceeds byte budget' });
  if ('sessionId' in event.payload && event.payload.sessionId !== event.sessionId) ctx.addIssue({ code: 'custom', message: 'Session identity mismatch' });
  if ('inputId' in event.payload && (event.payload.runId ?? event.payload.targetRunId) !== event.runId) ctx.addIssue({ code: 'custom', message: 'Input run identity mismatch' });
  if ('callId' in event.payload && event.payload.callId !== event.toolCallId) ctx.addIssue({ code: 'custom', message: 'Tool identity mismatch' });
}
const drafts = RegisteredEventPayloadSchema.options.map(option => option.extend(envelope));
export const RegisteredEventDraftSchema = z.union(drafts).superRefine(validEvent);
export const StoredRunEventSchema = z.union(drafts.map(option => option.extend({ eventId: PositiveIdSchema, sequence: PositiveIdSchema }))).superRefine(validEvent);
export type RegisteredEventPayload = z.infer<typeof RegisteredEventPayloadSchema>;
export type RegisteredEventDraft = RegisteredEventPayload & z.infer<z.ZodObject<typeof envelope>>;
export type StoredRunEvent = z.infer<typeof StoredRunEventSchema>;
type WithoutStoredIdentity<T> = T extends StoredRunEvent ? Omit<T, 'eventId' | 'sessionId' | 'receivedAt'> : never;
export type RunEvent = WithoutStoredIdentity<StoredRunEvent>;
export type EventSource = z.infer<typeof EventSourceSchema>;
export const EventRangeSchema = z.strictObject({ firstSequence: PositiveIdSchema.nullable(), lastSequence: nonnegative }).refine(value => value.firstSequence === null ? value.lastSequence === 0 : value.firstSequence <= value.lastSequence);
export type EventRange = z.infer<typeof EventRangeSchema>;
export const EventCursorSchema = z.strictObject({ runId: PositiveIdSchema, afterSequence: EventIntegerSchema.default(0) });
export const ReadEventsInputSchema = EventCursorSchema.extend({ limit: PositiveIdSchema.max(100).default(50), throughSequence: EventIntegerSchema.nullable().default(null) });
export type EventCursor = z.infer<typeof EventCursorSchema>;
export type ReadEventsInput = z.infer<typeof ReadEventsInputSchema>;
export const EventPageSchema = z.strictObject({ runId: PositiveIdSchema, events: z.array(StoredRunEventSchema).max(100), nextSequence: nonnegative, hasMore: z.boolean(), range: EventRangeSchema }).superRefine((page, ctx) => {
  if (page.events.some((event, i) => event.runId !== page.runId || i > 0 && event.sequence !== page.events[i - 1]!.sequence + 1) || page.events.length > 0 && page.events.at(-1)!.sequence !== page.nextSequence || page.nextSequence > page.range.lastSequence || new TextEncoder().encode(JSON.stringify(page)).byteLength > EVENT_LIMITS.pageBytes) ctx.addIssue({ code: 'custom', message: 'Invalid event page' });
});
export type EventPage = z.infer<typeof EventPageSchema>;
const streamIdentity = { streamConnection: OpaqueIdSchema, runId: PositiveIdSchema, sessionId: PositiveIdSchema, revision: PositiveIdSchema };
export const MessageStreamSnapshotSchema = z.strictObject({ type: z.literal('message.snapshot'), ...streamIdentity, messageId: OpaqueIdSchema, ordinal: PositiveIdSchema, phase: z.enum(['streaming', 'ended', 'incomplete']), modelCallId: OpaqueIdSchema.nullable(), nativeEntryId: OpaqueIdSchema.nullable(), blocks: z.array(z.strictObject({ contentIndex: nonnegative, text: z.string().max(32768) })), totalChars: nonnegative, truncated: z.boolean() }).superRefine((snapshot, ctx) => {
  const count = snapshot.blocks.reduce((sum, block) => sum + block.text.length, 0);
  if (count > 32768 || snapshot.totalChars < count || !snapshot.truncated && snapshot.totalChars !== count || new Set(snapshot.blocks.map(block => block.contentIndex)).size !== snapshot.blocks.length) ctx.addIssue({ code: 'custom', message: 'Invalid stream text bounds' });
});
export const ToolStreamSnapshotSchema = z.strictObject({ type: z.literal('tool.snapshot'), ...streamIdentity, nativeToolCallId: ToolCallRecordSchema.shape.nativeToolCallId, toolCallId: PositiveIdSchema.nullable(), phase: z.enum(['attempt', 'progress', 'ended']), text: z.null(), totalChars: z.null(), truncated: z.literal(false) });
export const StreamSnapshotSchema = z.discriminatedUnion('type', [MessageStreamSnapshotSchema, ToolStreamSnapshotSchema]);
export type MessageStreamSnapshot = z.infer<typeof MessageStreamSnapshotSchema>;
export type ToolStreamSnapshot = z.infer<typeof ToolStreamSnapshotSchema>;
export type StreamSnapshot = z.infer<typeof StreamSnapshotSchema>;
export const OpenEventSubscriptionInputSchema = EventCursorSchema.extend({ action: z.literal('open'), subscriptionId: OpaqueIdSchema, limit: PositiveIdSchema.max(100).default(50) });
export const CloseEventSubscriptionInputSchema = z.strictObject({ action: z.literal('close'), subscriptionId: OpaqueIdSchema });
export const EventSubscribeInputSchema = z.discriminatedUnion('action', [OpenEventSubscriptionInputSchema, CloseEventSubscriptionInputSchema]);
export const OpenEventSubscriptionResultSchema = z.strictObject({ action: z.literal('open'), subscriptionId: OpaqueIdSchema, runId: PositiveIdSchema, sessionId: PositiveIdSchema, highWatermark: nonnegative, range: EventRangeSchema, streamConnection: OpaqueIdSchema.nullable(), snapshots: z.array(StreamSnapshotSchema).max(32), snapshotsIncomplete: z.boolean() }).refine(value => value.highWatermark === value.range.lastSequence && value.snapshots.every(snapshot => snapshot.runId === value.runId && snapshot.sessionId === value.sessionId && snapshot.streamConnection === value.streamConnection) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= EVENT_LIMITS.pageBytes);
export const CloseEventSubscriptionResultSchema = z.strictObject({ action: z.literal('close'), subscriptionId: OpaqueIdSchema, closed: z.literal(true) });
export const EventSubscribeResultSchema = z.discriminatedUnion('action', [OpenEventSubscriptionResultSchema, CloseEventSubscriptionResultSchema]);
export type OpenEventSubscriptionInput = z.infer<typeof OpenEventSubscriptionInputSchema>;
export type CloseEventSubscriptionInput = z.infer<typeof CloseEventSubscriptionInputSchema>;
export type EventSubscribeInput = z.infer<typeof EventSubscribeInputSchema>;
export type OpenEventSubscriptionResult = z.infer<typeof OpenEventSubscriptionResultSchema>;
export type CloseEventSubscriptionResult = z.infer<typeof CloseEventSubscriptionResultSchema>;
export type EventSubscribeResult = z.infer<typeof EventSubscribeResultSchema>;
export const EventAvailableNoticeSchema = z.strictObject({ type: z.literal('event.available'), subscriptionId: OpaqueIdSchema, runId: PositiveIdSchema, sessionId: PositiveIdSchema, highWatermark: nonnegative, resyncRequired: z.boolean() });
export const EventStreamNoticeSchema = z.strictObject({ type: z.literal('event.stream'), subscriptionId: OpaqueIdSchema, snapshot: StreamSnapshotSchema });
export type EventAvailableNotice = z.infer<typeof EventAvailableNoticeSchema>;
export type EventStreamNotice = z.infer<typeof EventStreamNoticeSchema>;
export interface EventWriter { appendInTransaction(draft: RegisteredEventDraft): StoredRunEvent }
export interface WriteTransactions { immediate<T>(action: () => T): T; afterCommit(action: () => void, key?: string): void; assertActive(): void }
export interface EventStore extends EventWriter { readRunIdentity(runId: number): { runId: number; sessionId: number | null } | null; range(runId: number): EventRange; readWindow(input: { runId: number; afterSequence: number; throughSequence: number; limit: number }): StoredRunEvent[] }
export interface StreamSnapshotReader { readSnapshots(runId: number): { streamConnection: string | null; snapshots: StreamSnapshot[]; incomplete: boolean } }
