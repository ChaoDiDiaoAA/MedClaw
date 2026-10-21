import { z } from 'zod';
import { AppErrorSchema, ConfigVersionSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema } from './error';

export const RESOURCE_LIMITS = Object.freeze({ catalog: 128, skills: 32, files: 32, fileBytes: 64 * 1024,
  versionBytes: 1024 * 1024, replyBytes: 1024 * 1024, runBytes: 2 * 1024 * 1024, nativeBytes: 2 * 1024 * 1024,
  inputAcceptBytes: 1024 * 1024, nativeReceiptBytes: 2 * 1024 * 1024, inputSavedBytes: 3 * 1024 * 1024 });
export const ResourceIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const ResourceVersionSchema = z.string().max(32).regex(/^v[1-9][0-9]*$/);
export const ResourceFileSchema = z.string().min(1).max(256).refine(file =>
  !/[\\:*?"<>|\u0000-\u001f\u007f]/.test(file) && file.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Expected a canonical relative resource file');
export const ResourceRefSchema = z.strictObject({ kind: z.enum(['prompt', 'skill']), id: ResourceIdSchema, version: ResourceVersionSchema });
export type ResourceRef = z.infer<typeof ResourceRefSchema>;
export type ResourceKind = ResourceRef['kind'];
export const resourceRefKey = (ref: ResourceRef): string => `${ref.kind}:${ref.id}@${ref.version}`;
const names = z.array(z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)).max(32).refine(a => new Set(a).size === a.length, 'Duplicate dependency');
export const SkillReadinessSchema = z.strictObject({
  state: z.enum(['ready','partial','unavailable','no_requirements','unknown']), basis: z.enum(['configuration','run_scope']),
  requiredTools: names.nullable(), matchedCount: z.number().int().min(0).max(32).nullable(), totalCount: z.number().int().min(0).max(32).nullable(),
  missingTools: z.array(z.strictObject({name:z.string().min(1).max(64),reason:z.literal('tool_not_available')})).max(32),
}).refine(r => {
  if(r.totalCount !== (r.requiredTools?.length ?? null))return false;
  if(r.state==='unknown')return r.matchedCount===null&&r.missingTools.length===0;
  if(r.requiredTools===null||r.matchedCount===null||r.totalCount===null||r.matchedCount>r.totalCount)return false;
  const missing=r.missingTools.map(t=>t.name);
  if(new Set(missing).size!==missing.length||missing.some(name=>!r.requiredTools!.includes(name))||missing.length!==r.totalCount-r.matchedCount)return false;
  if(r.totalCount===0)return r.state==='no_requirements';
  if(r.matchedCount===r.totalCount)return r.state==='ready';
  if(r.matchedCount===0)return r.state==='unavailable';
  return r.state==='partial';
},'Readiness counts must describe the declared Tool matches');
export type SkillReadiness = z.infer<typeof SkillReadinessSchema>;
export function getSkillReadiness(requiredTools: readonly string[] | null, availableTools: readonly string[] | null, basis: SkillReadiness['basis']): SkillReadiness {
  const required=names.nullable().parse(requiredTools), common={basis,requiredTools:required,totalCount:required?.length??null};
  if(required===null||availableTools===null&&required.length>0)return {...common,state:'unknown',matchedCount:null,missingTools:[]};
  const available=new Set(availableTools??[]), missingTools=required.filter(name=>!available.has(name)).map(name=>({name,reason:'tool_not_available' as const}));
  const matchedCount=required.length-missingTools.length;
  let state:SkillReadiness['state']='partial';
  if(required.length===0)state='no_requirements';
  else if(missingTools.length===0)state='ready';
  else if(matchedCount===0)state='unavailable';
  return {...common,state,matchedCount,missingTools};
}
export function resourceCommand(text: string, promptNames: readonly string[]): {kind:'skill'|'prompt';id:string} | null {
  const command=text.startsWith('/')?text.slice(1).split(/\s/,1)[0]!:'';
  if(command.startsWith('skill:'))return {kind:'skill',id:command.slice(6)};
  return command&&promptNames.includes(command)?{kind:'prompt',id:command}:null;
}
const keywords = z.array(z.string().min(1).max(64)).max(32).refine(a => new Set(a).size === a.length, 'Duplicate keyword');
export const ResourceDefinitionSchema = ResourceRefSchema.extend({ entry: ResourceFileSchema, files: z.array(ResourceFileSchema).min(1).max(RESOURCE_LIMITS.files),
  keywords, requiredTools: names, requiredExtensions: names }).refine(d =>
    d.entry === (d.kind === 'prompt' ? `prompts/${d.id}/${d.version}/${d.id}.md` : `skills/${d.id}/${d.version}/SKILL.md`)
    && new Set(d.files).size === d.files.length && d.files.includes(d.kind === 'prompt' ? `${d.id}.md` : 'SKILL.md'), 'Resource entry and file set mismatch');
export const ResourceCatalogueSchema = z.strictObject({ contract: z.literal('medclaw.resource-catalog/v1'), sdkVersion: z.literal('0.87.1'), definitions: z.array(ResourceDefinitionSchema).max(RESOURCE_LIMITS.catalog) });
export type ResourceDefinition = z.infer<typeof ResourceDefinitionSchema>;
export type ResourceCatalogue = z.infer<typeof ResourceCatalogueSchema>;
export const ResourceSelectionSchema = z.strictObject({ prompt: ResourceRefSchema.refine(r => r.kind === 'prompt').nullable(),
  skills: z.array(ResourceRefSchema.refine(r => r.kind === 'skill')).max(RESOURCE_LIMITS.skills).refine(a => new Set(a.map(r => r.id)).size === a.length, 'Only one version per Skill') });
export const ResourceSettingsSchema = z.strictObject({ bySession: z.record(z.string().max(16).regex(/^[1-9][0-9]*$/).refine(id => Number.isSafeInteger(Number(id))), ResourceSelectionSchema) });
export type ResourceSelection = z.infer<typeof ResourceSelectionSchema>;
export type ResourceSettings = z.infer<typeof ResourceSettingsSchema>;
export const ResourceDiagnosticReasonSchema = z.enum(['resource_catalog_invalid', 'resource_missing', 'resource_conflict', 'resource_invalid', 'resource_dependency_missing',
  'resource_changed', 'resource_too_large', 'resource_path_invalid', 'resource_snapshot_invalid', 'resource_expansion_failed', 'sdk_warning', 'not_recorded']);
export const ResourceDiagnosticSchema = z.strictObject({ resourceRef: ResourceRefSchema.nullable(), reason: ResourceDiagnosticReasonSchema, file: ResourceFileSchema.nullable(),
  message: z.string().min(1).max(1000) });
export type ResourceDiagnostic = z.infer<typeof ResourceDiagnosticSchema>;
export type ResourceDiagnosticReason = ResourceDiagnostic['reason'];
const fileMetadata = z.strictObject({ file: ResourceFileSchema, bytes: z.number().int().nonnegative().max(RESOURCE_LIMITS.fileBytes) });
export const ResourceItemSchema = z.strictObject({ ref: ResourceRefSchema, name: ResourceIdSchema.nullable(), description: z.string().max(1024).nullable(), keywords,
  enabled: z.boolean(), availability: z.enum(['ready', 'missing', 'conflict', 'invalid', 'dependency_missing', 'content_changed']), disableModelInvocation: z.boolean().nullable(),
  files: z.array(fileMetadata).max(RESOURCE_LIMITS.files), requiredTools: names.nullable(), requiredExtensions: names.nullable(), diagnostics: z.array(ResourceDiagnosticSchema).max(256), readiness: SkillReadinessSchema.optional() });
export type ResourceItem = z.infer<typeof ResourceItemSchema>;
const sourceSelection = z.strictObject({ source: z.literal('selection'), sessionId: PositiveIdSchema });
const sourceRun = z.strictObject({ source: z.literal('run'), runId: PositiveIdSchema });
export const ResourceSourceInputSchema = z.discriminatedUnion('source', [sourceSelection, sourceRun]);
export type ResourceSourceInput = z.infer<typeof ResourceSourceInputSchema>;
const pageFields = { evidencePage: PositiveIdSchema.optional(), evidencePageSize: PositiveIdSchema.max(100).optional() };
export const ResourceListInputSchema = z.discriminatedUnion('source', [sourceSelection.extend(pageFields), sourceRun.extend(pageFields)])
  .refine(input => Number.isSafeInteger((input.evidencePage ?? 1) * (input.evidencePageSize ?? 50)), 'Page offset exceeds safe integer');
export const ResourceReadInputSchema = z.discriminatedUnion('source', [sourceSelection.extend({ resourceRef: ResourceRefSchema, file: ResourceFileSchema }), sourceRun.extend({ resourceRef: ResourceRefSchema, file: ResourceFileSchema })]);
export const ResourceSelectInputSchema = z.strictObject({ sessionId: PositiveIdSchema, expectedConfigVersion: ConfigVersionSchema, selection: ResourceSelectionSchema });
export type ResourceListInput = z.infer<typeof ResourceListInputSchema>;
export type ResourceReadInput = z.infer<typeof ResourceReadInputSchema>;
export type ResourceSelectInput = z.infer<typeof ResourceSelectInputSchema>;
const evidenceIdentity = { resourceRef: ResourceRefSchema, originRunId: PositiveIdSchema, file: ResourceFileSchema.nullable(),
  inputId: PositiveIdSchema.nullable(), nativeEntryId: OpaqueIdSchema.nullable(), toolCallId: PositiveIdSchema.nullable(),
  coverage: z.enum(['index', 'complete', 'partial', 'unknown']) };
export const ResourceEvidenceSchema = z.strictObject({ ...evidenceIdentity, kind: z.enum(['sdk_expansion', 'native_read', 'provider_delivery']), modelCallId: OpaqueIdSchema.nullable(),
  observedAt: TimestampSchema }).refine(f =>
    f.kind === 'provider_delivery' ? f.modelCallId !== null : f.modelCallId === null, 'Delivery evidence requires the original call');
export type ResourceEvidence = z.infer<typeof ResourceEvidenceSchema>;
const listFields = { configVersion: ConfigVersionSchema, selection: ResourceSelectionSchema, items: z.array(ResourceItemSchema).max(RESOURCE_LIMITS.catalog + RESOURCE_LIMITS.skills + 1),
  diagnostics: z.array(ResourceDiagnosticSchema).max(1000), catalogError: AppErrorSchema.nullable(), evidence: z.array(ResourceEvidenceSchema).max(100),
  evidenceInfo: z.strictObject({ totalRows: z.number().int().nonnegative().safe(), page: PositiveIdSchema, pageSize: PositiveIdSchema.max(100), hasMore: z.boolean() }) };
export const ResourceListSchema = z.discriminatedUnion('source', [sourceSelection.extend(listFields), sourceRun.extend({ ...listFields, sessionId: PositiveIdSchema })])
  .refine(r => new TextEncoder().encode(JSON.stringify(r)).byteLength <= RESOURCE_LIMITS.replyBytes, 'Resource reply exceeds JSON budget');
export type ResourceList = z.infer<typeof ResourceListSchema>;
const textFields = { configVersion: ConfigVersionSchema, resourceRef: ResourceRefSchema, ...fileMetadata.shape, content: z.string().refine(t => t.isWellFormed()) };
export const ResourceTextSchema = z.discriminatedUnion('source', [sourceSelection.extend(textFields), sourceRun.extend({ ...textFields, sessionId: PositiveIdSchema })])
  .refine(r => new TextEncoder().encode(r.content).byteLength === r.bytes, 'Resource byte count mismatch');
export type ResourceText = z.infer<typeof ResourceTextSchema>;
export const ResourceSelectionReceiptSchema = z.strictObject({ sessionId: PositiveIdSchema, configVersion: ConfigVersionSchema, selection: ResourceSelectionSchema });
export type ResourceSelectionReceipt = z.infer<typeof ResourceSelectionReceiptSchema>;
export const ResourceFileSnapshotSchema = fileMetadata.extend({ content: z.string().refine(t => t.isWellFormed()) })
  .refine(f => new TextEncoder().encode(f.content).byteLength === f.bytes, 'Resource byte count mismatch');
export const ResourceSnapshotSchema = z.strictObject({ ref: ResourceRefSchema, name: ResourceIdSchema, description: z.string().max(1024), keywords, disableModelInvocation: z.boolean(),
  entry: ResourceFileSchema, requiredTools: names, requiredExtensions: names, files: z.array(ResourceFileSnapshotSchema).min(1).max(RESOURCE_LIMITS.files) })
  .refine(s => s.name === s.ref.id && s.entry === (s.ref.kind === 'prompt' ? `prompts/${s.ref.id}/${s.ref.version}/${s.ref.id}.md` : `skills/${s.ref.id}/${s.ref.version}/SKILL.md`)
    && new Set(s.files.map(f => f.file)).size === s.files.length && s.files.some(f => f.file === s.entry.split('/').at(-1))
    && s.files.reduce((sum, f) => sum + f.bytes, 0) <= RESOURCE_LIMITS.versionBytes, 'Snapshot identity or capacity mismatch');
export type ResourceFileSnapshot = z.infer<typeof ResourceFileSnapshotSchema>;
export type ResourceSnapshot = z.infer<typeof ResourceSnapshotSchema>;
const sameRef = (a: ResourceRef, b: ResourceRef) => a.kind === b.kind && a.id === b.id && a.version === b.version;
export const FrozenRunResourcesSchema = z.strictObject({ contract: z.literal('medclaw.run-resources/v1'), sdkVersion: z.literal('0.87.1'), sessionId: PositiveIdSchema,
  configVersion: ConfigVersionSchema, selection: ResourceSelectionSchema, available: z.array(ResourceSnapshotSchema).max(RESOURCE_LIMITS.skills + 1),
  knownPromptNames: z.array(ResourceIdSchema).max(RESOURCE_LIMITS.catalog), omitted: z.array(ResourceDiagnosticSchema).max(1000),
  skillRequirements: z.array(z.strictObject({resourceRef:ResourceRefSchema.refine(r=>r.kind==='skill'),requiredTools:names.nullable(),disableModelInvocation:z.boolean().nullable().optional()})).max(RESOURCE_LIMITS.skills).optional() })
  .refine(f => new Set(f.available.map(s => `${s.ref.kind}:${s.ref.id}`)).size === f.available.length
    && f.available.every(s => [f.selection.prompt, ...f.selection.skills].some(ref => ref !== null && sameRef(ref, s.ref)))
    && f.available.reduce((sum, s) => sum + s.files.reduce((n, file) => n + file.bytes, 0), 0) <= RESOURCE_LIMITS.runBytes
    && new TextEncoder().encode(JSON.stringify(f)).byteLength <= RESOURCE_LIMITS.runBytes
    && (f.skillRequirements===undefined || f.skillRequirements.length===f.selection.skills.length
      && new Set(f.skillRequirements.map(s=>resourceRefKey(s.resourceRef))).size===f.skillRequirements.length
      && f.skillRequirements.every(s=>f.selection.skills.some(ref=>sameRef(s.resourceRef,ref))
        && f.available.filter(a=>sameRef(a.ref,s.resourceRef)).every(a=>JSON.stringify(a.requiredTools)===JSON.stringify(s.requiredTools)))), 'Frozen selection or capacity mismatch');
export type FrozenRunResources = z.infer<typeof FrozenRunResourcesSchema>;
export const SubagentTemplateNameSchema = z.enum(['medclaw-evidence-review', 'parallel-medclaw-review']);
export type SubagentTemplateName = z.infer<typeof SubagentTemplateNameSchema>;
const delegationText = z.string().min(1).refine(t => t.isWellFormed() && new TextEncoder().encode(t).byteLength <= RESOURCE_LIMITS.nativeBytes);
const delegationRole = ResourceIdSchema;
export const SubagentTemplateSourceSchema = z.strictObject({ templateName: SubagentTemplateNameSchema, file: ResourceFileSchema,
  content: z.string().min(1).refine(t => t.isWellFormed() && new TextEncoder().encode(t).byteLength <= RESOURCE_LIMITS.fileBytes) });
export type SubagentTemplateSource = z.infer<typeof SubagentTemplateSourceSchema>;
export const SubagentCommandSourceSchema = z.strictObject({ name: z.literal('subagent'), roleId: delegationRole, task: delegationText });
export const ResourceInputPlanSchema = z.union([
  z.strictObject({ kind: z.enum(['plain', 'prompt', 'skill']), resourceRef: ResourceRefSchema.nullable(),
    dispatchText: z.string().refine(t => t.isWellFormed()) }).refine(p => p.kind === 'plain' ? p.resourceRef === null : p.resourceRef?.kind === p.kind, 'Input plan resource mismatch'),
  z.strictObject({ kind: z.literal('subagent_template'), resourceRef: z.null(), dispatchText: delegationText, source: SubagentTemplateSourceSchema }),
  z.strictObject({ kind: z.literal('subagent_command'), resourceRef: z.null(), dispatchText: delegationText, source: SubagentCommandSourceSchema }),
]);
export const SubagentInputReceiptSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('template'), templateName: SubagentTemplateNameSchema, expandedText: delegationText }),
  z.strictObject({ kind: z.literal('command'), name: z.literal('subagent'), roleId: delegationRole, task: delegationText,
    operationRef: OpaqueIdSchema, inputId: PositiveIdSchema,
    owner: z.strictObject({ instanceId: OpaqueIdSchema, sessionId: PositiveIdSchema, runId: PositiveIdSchema, assemblyId: OpaqueIdSchema }), dispatchText: delegationText }),
]);
export const NativeInputReceiptSchema = z.strictObject({ text: z.string().refine(t => t.isWellFormed() && new TextEncoder().encode(t).byteLength <= RESOURCE_LIMITS.nativeBytes),
  subagentReceipt: SubagentInputReceiptSchema.optional() })
  .refine(r => !r.subagentReceipt || r.text === (r.subagentReceipt.kind === 'template' ? r.subagentReceipt.expandedText : r.subagentReceipt.dispatchText), 'Delegation receipt must match the consumed input')
  .refine(r => new TextEncoder().encode(JSON.stringify(r)).byteLength <= RESOURCE_LIMITS.nativeReceiptBytes, 'Native receipt exceeds JSON budget');
export type ResourceInputPlan = z.infer<typeof ResourceInputPlanSchema>;
export type NativeInputReceipt = z.infer<typeof NativeInputReceiptSchema>;
export type SubagentInputReceipt = z.infer<typeof SubagentInputReceiptSchema>;
export const InputCommandsListInputSchema = z.strictObject({ sessionId: PositiveIdSchema });
export const InputCommandsListSchema = z.strictObject({ items: z.array(z.strictObject({
  group: z.enum(['skills', 'subagents', 'prompt_templates', 'extension_commands']), id: z.string().min(1).max(128),
  command: z.string().min(1).max(256), description: z.string().max(1024), available: z.boolean(), reasons: z.array(z.string().max(256)).max(64),
  registered: z.boolean(), owner: z.strictObject({ instanceId: OpaqueIdSchema, sessionId: PositiveIdSchema, runId: PositiveIdSchema, assemblyId: OpaqueIdSchema }).nullable(),
}).refine(item => item.registered === (item.owner !== null), 'Only live command registrations have an owner')).max(512) })
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= RESOURCE_LIMITS.replyBytes, 'Command directory exceeds reply capacity');
export type InputCommandsListInput = z.infer<typeof InputCommandsListInputSchema>;
export type InputCommandsList = z.infer<typeof InputCommandsListSchema>;
export const ResourceReadFactSchema = z.strictObject({ resourceRef: ResourceRefSchema, file: ResourceFileSchema,
  coverage: z.enum(['complete', 'partial', 'unknown']), observedAt: TimestampSchema });
export type ResourceReadFact = z.infer<typeof ResourceReadFactSchema>;
export const ResourceDeliveryRefSchema = z.strictObject({ ...evidenceIdentity, kind: z.enum(['prompt_expansion', 'skill_expansion', 'skill_index', 'native_read']) })
  .refine(f => f.kind === 'skill_index' ? f.resourceRef.kind === 'skill' && f.file === null && f.inputId === null && f.nativeEntryId === null && f.toolCallId === null && f.coverage === 'index'
    : f.kind === 'native_read' ? f.file !== null && f.toolCallId !== null && f.nativeEntryId !== null && f.inputId === null && f.coverage !== 'index'
    : f.resourceRef.kind === (f.kind === 'prompt_expansion' ? 'prompt' : 'skill') && f.file !== null && f.inputId !== null && f.nativeEntryId !== null && f.toolCallId === null && f.coverage === 'complete', 'Resource delivery identity mismatch');
const readinessText=z.string().min(1).refine(t=>t.isWellFormed()&&new TextEncoder().encode(t).byteLength<=RESOURCE_LIMITS.replyBytes);
export const ResourcePayloadObservationSchema = z.strictObject({ verified: z.array(ResourceDeliveryRefSchema).max(1000),readiness:readinessText.optional() });
export const CallResourceContextSchema = z.strictObject({ expected: z.array(ResourceDeliveryRefSchema).max(1000), payload: ResourcePayloadObservationSchema.nullable(),readiness:readinessText.optional() })
  .refine(c => c.payload === null || JSON.stringify(c.expected) === JSON.stringify(c.payload.verified)&&c.readiness===c.payload.readiness, 'Resource payload must verify every expected identity and readiness in order');
export type ResourceDeliveryRef = z.infer<typeof ResourceDeliveryRefSchema>;
export type ResourcePayloadObservation = z.infer<typeof ResourcePayloadObservationSchema>;
export type CallResourceContext = z.infer<typeof CallResourceContextSchema>;
export type ResourceSource = { discover(): Promise<{ items: ResourceItem[]; diagnostics: ResourceDiagnostic[] }>; capture(refs: ResourceRef[]): Promise<ResourceSnapshot[]>;
  captureSubagentTemplate?(name: SubagentTemplateName): Promise<SubagentTemplateSource> };
