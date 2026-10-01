import { z } from "zod";
import { PositiveIdSchema } from "./error";

export const RevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const WorkspaceViewSchema = z.strictObject({
  revision: RevisionSchema, sessionId: PositiveIdSchema.nullable(), materialVersion: z.null(),
  batchRefs: z.tuple([]), deviceIds: z.tuple([]), queryId: z.null(), activeView: z.literal("data"), selection: z.null(),
});
export type WorkspaceView = z.infer<typeof WorkspaceViewSchema>;
