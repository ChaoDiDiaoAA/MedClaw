import { z } from 'zod';
import { OpaqueIdSchema, PositiveIdSchema, TimestampSchema } from './error';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const QueryInventoryOriginalSchema=z.strictObject({
  instanceId:OpaqueIdSchema,runId:PositiveIdSchema,sessionId:PositiveIdSchema,
  queryIds:z.array(PositiveIdSchema).refine(ids=>new Set(ids).size===ids.length,'Duplicate Query identity'),
});
export const ProviderRequestOriginalSchema=z.strictObject({
  instanceId:OpaqueIdSchema,sessionId:PositiveIdSchema.nullable(),runId:PositiveIdSchema.nullable(),callId:OpaqueIdSchema,
  observedAt:TimestampSchema,boundary:z.literal('sdk_onPayload'),sequence:PositiveIdSchema,
  body:z.string(),sha256:hash,bytes:z.number().int().nonnegative(),
});
export const ControllerEvidenceSelectorSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('request'),sessionId:PositiveIdSchema.nullable(),runId:PositiveIdSchema.nullable(),callId:OpaqueIdSchema}),
  z.strictObject({kind:z.literal('history'),sessionId:PositiveIdSchema,runId:PositiveIdSchema}),
  z.strictObject({kind:z.literal('run'),sessionId:PositiveIdSchema,runId:PositiveIdSchema}),
  z.strictObject({kind:z.literal('queries'),sessionId:PositiveIdSchema,runId:PositiveIdSchema}),
  z.strictObject({kind:z.literal('tool'),sessionId:PositiveIdSchema,runId:PositiveIdSchema,toolCallId:PositiveIdSchema}),
]);
export const ControllerEvidenceInputSchema=z.strictObject({expectedInstanceId:OpaqueIdSchema,ownerInstanceId:OpaqueIdSchema,selector:ControllerEvidenceSelectorSchema,
  offset:z.number().int().nonnegative(),limit:z.number().int().min(1).max(65536)});
export const ControllerEvidenceOutputSchema=z.strictObject({instanceId:OpaqueIdSchema,ownerInstanceId:OpaqueIdSchema,selector:ControllerEvidenceSelectorSchema,
  sha256:hash,bytes:z.number().int().nonnegative(),offset:z.number().int().nonnegative(),nextOffset:z.number().int().nonnegative().nullable(),
  encoding:z.literal('base64'),data:z.string().max(90000)});
export type ControllerEvidenceInput=z.infer<typeof ControllerEvidenceInputSchema>;
