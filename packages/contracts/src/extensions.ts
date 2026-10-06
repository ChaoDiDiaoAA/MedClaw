import { z } from 'zod';
import { AppErrorSchema, ConfigVersionSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema } from './error';
import { ResourceHashSchema, ResourceSettingsSchema } from './resources';

export const EXTENSION_LIMITS = Object.freeze({ manifestBytes: 8 * 1024, entryBytes: 64 * 1024, statusBytes: 8 * 1024, closeMs: 3000 });
export const ExtensionRefSchema = z.strictObject({ id: z.literal('tool-audit'), version: z.literal('v1'), treeHash: ResourceHashSchema });
export const ExtensionSelectionSchema = z.strictObject({ extension: ExtensionRefSchema.nullable() });
export const ExtensionSettingsSchema = z.strictObject({ bySession: z.record(ResourceSettingsSchema.shape.bySession.keyType, ExtensionSelectionSchema) });
export const ExtensionOwnerSchema = z.strictObject({ instanceId: OpaqueIdSchema, sessionId: PositiveIdSchema, runId: PositiveIdSchema, assemblyId: OpaqueIdSchema });
export const ExtensionManifestSchema = z.strictObject({
  contract: z.literal('medclaw.extension-manifest/v1'), id: z.literal('tool-audit'), version: z.literal('v1'), sdkVersion: z.literal('0.87.1'),
  entry: z.literal('index.ts'), files: z.tuple([z.literal('manifest.json'), z.literal('index.ts')]),
  hooks: z.strictObject({ critical: z.tuple([z.literal('session_start'), z.literal('tool_call')]),
    observation: z.tuple([z.literal('input'), z.literal('context'), z.literal('tool_result'), z.literal('agent_start'), z.literal('agent_end')]) }),
  tools: z.tuple([z.literal('extension_runtime_status')]), commands: z.tuple([z.literal('extension_status')]),
});
const count = z.number().int().nonnegative().safe();
export const ExtensionStatusSchema = ExtensionOwnerSchema.extend({ ref: ExtensionRefSchema, seenToolCalls: count, inputObservations: count, contextObservations: count })
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= EXTENSION_LIMITS.statusBytes);
export const ExtensionAssemblyStateSchema = z.enum(['loading', 'active', 'load_failed', 'disposed']);
export const ExtensionAssemblyProofSchema = ExtensionOwnerSchema.extend({
  contract: z.literal('medclaw.extension-assembly/v1'), ref: ExtensionRefSchema, state: ExtensionAssemblyStateSchema,
  loadedAt: TimestampSchema.nullable(), disposedAt: TimestampSchema.nullable(),
  callableTools: z.array(z.literal('extension_runtime_status')).max(1), callableCommands: z.array(z.literal('extension_status')).max(1),
  hookCounts: z.strictObject({ input: count, context: count, tool_call: count, tool_result: count }),
  resourcesReleased: z.boolean(), diagnostics: z.array(AppErrorSchema).max(8),
}).refine(proof => proof.resourcesReleased === (proof.state === 'disposed') && (proof.state === 'disposed') === (proof.disposedAt !== null)
  && (proof.state !== 'active' || proof.loadedAt !== null && proof.callableTools.length === 1 && proof.callableCommands.length === 1)
  && (proof.loadedAt === null || proof.disposedAt === null || Date.parse(proof.disposedAt) >= Date.parse(proof.loadedAt)), 'Assembly facts disagree');
export const ExtensionFileMetadataSchema = z.strictObject({ file: z.enum(['manifest.json', 'index.ts']), bytes: count.max(EXTENSION_LIMITS.entryBytes), sha256: ResourceHashSchema })
  .refine(file => file.bytes <= (file.file === 'manifest.json' ? EXTENSION_LIMITS.manifestBytes : EXTENSION_LIMITS.entryBytes));
export const ExtensionFileSnapshotSchema = ExtensionFileMetadataSchema.extend({ content: z.string().refine(text => text.isWellFormed()) })
  .refine(file => new TextEncoder().encode(file.content).byteLength === file.bytes, 'Extension byte count mismatch');
const sourceSchema = z.strictObject({ manifest: ExtensionManifestSchema, files: z.array(ExtensionFileSnapshotSchema).length(2)
  .refine(files => new Set(files.map(file => file.file)).size === 2, 'Extension requires its exact two files') });
const frozenFields = { contract: z.literal('medclaw.run-extensions/v1'), sdkVersion: z.literal('0.87.1'), sessionId: PositiveIdSchema,
  configVersion: ConfigVersionSchema, selection: ExtensionSelectionSchema };
export const FrozenRunExtensionsSchema = z.strictObject({ ...frozenFields, source: sourceSchema.nullable() })
  .refine(frozen => (frozen.selection.extension === null) === (frozen.source === null), 'Selection and source disagree');
export const FrozenExtensionSummarySchema = z.strictObject({ ...frozenFields, source: z.strictObject({ manifest: ExtensionManifestSchema,
  files: z.array(ExtensionFileMetadataSchema).length(2).refine(files => new Set(files.map(file => file.file)).size === 2) }).nullable() })
  .refine(frozen => (frozen.selection.extension === null) === (frozen.source === null));
export const ExtensionDescriptorSchema = z.strictObject({ ref: ExtensionRefSchema, source: z.literal('first_party'), sdkVersion: z.literal('0.87.1'), entry: z.literal('index.ts'),
  hooks: ExtensionManifestSchema.shape.hooks, tools: ExtensionManifestSchema.shape.tools, commands: ExtensionManifestSchema.shape.commands });
export const ExtensionsReadInputSchema = z.discriminatedUnion('source', [z.strictObject({ source: z.literal('selection'), sessionId: PositiveIdSchema }),
  z.strictObject({ source: z.literal('run'), runId: PositiveIdSchema })]);
export const ExtensionsSelectInputSchema = z.strictObject({ sessionId: PositiveIdSchema, expectedConfigVersion: ConfigVersionSchema, selection: ExtensionSelectionSchema });
export const ExtensionsSelectResultSchema = z.strictObject({ sessionId: PositiveIdSchema, configVersion: ConfigVersionSchema, selection: ExtensionSelectionSchema, effective: z.literal('next_assembly') });
export const ExtensionsCommandInputSchema = ExtensionOwnerSchema.extend({ command: z.literal('extension_status') });

export type ExtensionRef = z.infer<typeof ExtensionRefSchema>;
export type ExtensionSelection = z.infer<typeof ExtensionSelectionSchema>;
export type ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>;
export type ExtensionOwner = z.infer<typeof ExtensionOwnerSchema>;
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
export type ExtensionStatus = z.infer<typeof ExtensionStatusSchema>;
export type ExtensionAssemblyProof = z.infer<typeof ExtensionAssemblyProofSchema>;
export type ExtensionAssemblyState = z.infer<typeof ExtensionAssemblyStateSchema>;
export type FrozenRunExtensions = z.infer<typeof FrozenRunExtensionsSchema>;
export type FrozenExtensionSummary = z.infer<typeof FrozenExtensionSummarySchema>;
export type ExtensionFileSnapshot = z.infer<typeof ExtensionFileSnapshotSchema>;
export type ExtensionDescriptor = z.infer<typeof ExtensionDescriptorSchema>;
export type ExtensionsReadInput = z.infer<typeof ExtensionsReadInputSchema>;
export type ExtensionsSelectInput = z.infer<typeof ExtensionsSelectInputSchema>;
export type ExtensionsSelectResult = z.infer<typeof ExtensionsSelectResultSchema>;
export type ExtensionsCommandInput = z.infer<typeof ExtensionsCommandInputSchema>;
