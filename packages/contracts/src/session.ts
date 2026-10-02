import { z } from "zod";
import { OpaqueIdSchema, PositiveIdSchema } from "./error";
import { ModelChoiceSchema, ReferenceDateSchema, TimezoneSchema } from "./model";
import { RevisionSchema, WorkspaceViewSchema } from "./workspace";
import type { WorkspaceView, WorkspaceChange } from "./workspace";
import type { StoredOperation, RunHandle } from "./run";

export const NewSessionInputSchema = z.strictObject({ selectOnCreate: z.literal(true).default(true), expectedWorkspaceRevision: RevisionSchema });
export const SelectSessionInputSchema = z.strictObject({ sessionId: PositiveIdSchema, expectedWorkspaceRevision: RevisionSchema });
export const SessionViewSchema = z.strictObject({
  id: PositiveIdSchema, title: z.string().max(256), nativeSessionId: OpaqueIdSchema, kind: z.literal("user"), status: z.literal("active"),
  storageVersion: z.literal(0), leafId: OpaqueIdSchema.nullable(), nextSubmissionSequence: PositiveIdSchema,
});
export const NewSessionResultSchema = z.strictObject({ session: SessionViewSchema, workspace: WorkspaceViewSchema });
export const ListSessionsRequestSchema = z.strictObject({ beforeSessionId: PositiveIdSchema.optional(), limit: z.number().int().min(1).max(50).default(20) });
export const SessionPageSchema = z.strictObject({ sessions: z.array(SessionViewSchema).max(50), nextBeforeSessionId: PositiveIdSchema.nullable() });
export const BasicMessagePreviewSchema = z.strictObject({
  nativeEntryId: OpaqueIdSchema, role: z.enum(["user", "assistant"]), text: z.string().max(8192),
  totalChars: RevisionSchema, truncated: z.boolean(),
});
export const SessionDetailSchema = z.strictObject({
  session: SessionViewSchema, runningRunId: PositiveIdSchema.nullable(),
  history: z.strictObject({ available: z.boolean(), reason: z.enum(["host_restart", "native_state_invalid"]).nullable(),
    messages: z.array(BasicMessagePreviewSchema).max(32), truncated: z.boolean() }),
});
export const SubmitInputSchema = z.strictObject({
  clientSequence: PositiveIdSchema, sessionId: PositiveIdSchema, text: z.string().refine(text => text.trim().length > 0, "Text must not be blank"),
  mode: z.literal("send"), expectedRevision: RevisionSchema,
  expectedBatchIds: z.array(PositiveIdSchema).max(10000).refine(ids => new Set(ids).size === ids.length, 'Duplicate batches'),
  expectedQueryId: PositiveIdSchema.nullable(),
  model: ModelChoiceSchema, referenceDate: ReferenceDateSchema, timezone: TimezoneSchema,
});
export const SubmitResultSchema = z.strictObject({ sessionId: PositiveIdSchema, clientSequence: PositiveIdSchema, inputId: z.null(), runId: PositiveIdSchema });
export const ReadSubmissionRequestSchema = z.strictObject({ sessionId: PositiveIdSchema, clientSequence: PositiveIdSchema });
export type NewSessionInput = z.input<typeof NewSessionInputSchema>;
export type SelectSessionInput = z.infer<typeof SelectSessionInputSchema>;
export type SessionView = z.infer<typeof SessionViewSchema>;
export type NewSessionResult = z.infer<typeof NewSessionResultSchema>;
export type SessionPage = z.infer<typeof SessionPageSchema>;
export type SessionDetail = z.infer<typeof SessionDetailSchema>;
export type BasicMessagePreview = z.infer<typeof BasicMessagePreviewSchema>;
export type SubmitInput = z.infer<typeof SubmitInputSchema>;
export type SubmitResult = z.infer<typeof SubmitResultSchema>;
export type ReadSubmissionRequest = z.infer<typeof ReadSubmissionRequestSchema>;
export type NativeSessionPreview = SessionDetail["history"] & { leafId: string | null };
export type NativeSessionBindings = {
  allocate: () => { nativeSessionId: string; bind: (sessionId: number) => void; discard: () => void };
  read: (sessionId: number) => NativeSessionPreview;
};
/** Product persistence port; native SDK objects stay in the Host's adapter. */
export interface SessionStore {
  createSession(input: NewSessionInput, operationRef: string, nativeSessionId: string, time: string): NewSessionResult;
  selectSession(input: SelectSessionInput, time: string): WorkspaceView;
  readSession(sessionId: number): SessionView | null;
  listSessions(input: { beforeSessionId?: number; limit?: number }): SessionPage;
  readWorkspace(): WorkspaceView;
  updateWorkspace(change: WorkspaceChange, expectedRevision: number, time: string): WorkspaceView;
  findOperation(operationRef: string): StoredOperation | null;
  findSubmission(input: ReadSubmissionRequest): SubmitResult | null;
  active(): RunHandle | null;
}
