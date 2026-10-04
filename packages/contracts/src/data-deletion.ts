import {z} from 'zod';
import {AppErrorSchema,OpaqueIdSchema,PositiveIdSchema,TimestampSchema} from './error';
import {RevisionSchema,WorkspaceViewSchema} from './workspace';

const ids=z.array(PositiveIdSchema).min(1).max(10000).refine(values=>new Set(values).size===values.length,'Duplicate batch identity');
export const DataDeleteTargetSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('batches'),batchIds:ids}),z.strictObject({kind:z.literal('all')}),
]);
const revisionFields={expectedCatalogRevision:RevisionSchema,expectedWorkspaceRevision:RevisionSchema};
export const DataDeletePreviewRequestSchema=z.strictObject({operationRef:OpaqueIdSchema,target:DataDeleteTargetSchema,...revisionFields});
export const DataDeleteCommitRequestSchema=z.strictObject({operationRef:OpaqueIdSchema,previewHash:z.string().regex(/^[a-f0-9]{64}$/),...revisionFields});
export const DataDeleteReferenceSchema=z.strictObject({operationRef:OpaqueIdSchema});
const count=z.number().int().nonnegative();
export const DataDeleteFileSchema=z.strictObject({artifactId:PositiveIdSchema,path:z.string().min(1)});
export const DataDeletePreviewSchema=z.strictObject({operationRef:OpaqueIdSchema,previewHash:z.string().regex(/^[a-f0-9]{64}$/),
 catalogRevision:RevisionSchema,workspaceRevision:RevisionSchema,batches:z.array(z.strictObject({id:PositiveIdSchema,snapshotDate:z.string()})),
 snapshotCount:count,changeCount:count,deviceCount:count,queryCount:count,workspaceWillChange:z.boolean(),files:z.array(DataDeleteFileSchema)});
export const DataDeleteReceiptSchema=z.strictObject({operationRef:OpaqueIdSchema,batchIds:z.array(PositiveIdSchema),snapshotCount:count,changeCount:count,deviceCount:count,
 catalogRevision:RevisionSchema,workspace:WorkspaceViewSchema,committedAt:TimestampSchema});
export const DataDeleteCleanupSchema=z.strictObject({state:z.enum(['pending','complete','failed']),remainingCount:count,error:AppErrorSchema.nullable()});
export const DataDeleteOperationSchema=z.strictObject({operationRef:OpaqueIdSchema,state:z.enum(['ready','committed']),preview:DataDeletePreviewSchema,
 receipt:DataDeleteReceiptSchema.nullable(),cleanup:DataDeleteCleanupSchema,updatedAt:TimestampSchema})
 .refine(value=>(value.state==='committed')===(value.receipt!==null),'Receipt must prove committed deletion');
export type DataDeletePreviewRequest=z.infer<typeof DataDeletePreviewRequestSchema>;
export type DataDeleteCommitRequest=z.infer<typeof DataDeleteCommitRequestSchema>;
export type DataDeletePreview=z.infer<typeof DataDeletePreviewSchema>;
export type DataDeleteReceipt=z.infer<typeof DataDeleteReceiptSchema>;
export type DataDeleteOperation=z.infer<typeof DataDeleteOperationSchema>;
export type DataDeleteTarget=z.infer<typeof DataDeleteTargetSchema>;
export type DataDeleteFile=z.infer<typeof DataDeleteFileSchema>;
