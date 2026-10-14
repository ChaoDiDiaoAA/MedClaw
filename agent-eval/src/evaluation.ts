import type { Target } from './independent-gold.ts';
import { z } from 'zod';
import {businessToolSchemas} from '../../packages/contracts/src/business-tools.ts';

export const IdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
export const RelativePathSchema = z.string().min(1).max(240).refine(value => !value.includes('\\') && !value.includes(':') && !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Expected a portable relative path');
const UniqueIds = z.array(IdSchema).refine(items => new Set(items).size === items.length, 'Duplicate identity');
const capabilityNames=new Set([...Object.keys(businessToolSchemas),'query_intent_step','read','write','edit','bash','powershell','grep','find','ls','agent','query','delegate','export','delete','external-send','payment']);
const Capabilities=UniqueIds.refine(items=>items.every(item=>capabilityNames.has(item)),'Unknown tool capability');
const Version = z.literal(1);
const Revision = z.number().int().nonnegative().optional();
const Alias = IdSchema;
const operation = { operationAlias: Alias, kind: z.enum(['import', 'export', 'session_checkpoint']) };
export const RegisteredActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('import'), materialRef: RelativePathSchema, alias: Alias }),
  z.strictObject({ action: z.literal('new_session'), alias: Alias, expectedWorkspaceRevision: Revision }),
  z.strictObject({ action: z.literal('select_resources'), sessionAlias: Alias, skills: z.array(z.strictObject({id: IdSchema, version: z.literal('v1')})) }),
  z.strictObject({ action: z.literal('send'), sessionAlias: Alias, prompt: z.string().min(1).max(20000), alias: Alias, referenceDate: z.iso.date(), mode: z.enum(['send', 'steer', 'follow_up']).optional(), targetRunAlias: Alias.optional(), routing: z.enum(['intent', 'agent']).optional() }),
  z.strictObject({ action: z.literal('select_workspace'), batchAliases: z.array(Alias).optional(), queryAlias: Alias.nullable().optional(), activeView: z.enum(['data', 'changes', 'query', 'evidence']).optional(), device: z.string().optional(), expectedRevision: Revision }),
  z.strictObject({ action: z.literal('select_session'), sessionAlias: Alias, expectedWorkspaceRevision: Revision }),
  ...(['read_messages', 'list_inputs', 'compact', 'restore_session', 'read_checkpoints'] as const).map(action => z.strictObject({ action: z.literal(action), sessionAlias: Alias })),
  z.strictObject({ action: z.literal('read_control') }),
  z.strictObject({ action: z.literal('restart') }),
  z.strictObject({ action: z.literal('read_input'), sessionAlias: Alias, inputAlias: Alias }),
  z.strictObject({ action: z.literal('cancel'), runAlias: Alias }),
  z.strictObject({ action: z.literal('restore_checkpoint'), sessionAlias: Alias, checkpointAlias: Alias, operationAlias: Alias, expectedStorageVersion: Revision, expectedWorkspaceRevision: Revision }),
  z.strictObject({ action: z.literal('export'), queryAlias: Alias, format: z.enum(['csv', 'json', 'markdown']), operationAlias: Alias }),
  ...(['read_operation', 'recover_operation', 'cancel_operation'] as const).map(action => z.strictObject({ action: z.literal(action), ...operation })),
]);
export const RegisteredStepSchema = z.strictObject({
  id: IdSchema, trigger: z.enum(['ready', 'run_settled', 'input_delivered', 'tool_result_saved']),
  action: RegisteredActionSchema, timeoutMs: z.number().int().min(1).max(300000), targetAlias: Alias.optional(),
  expectedFailure: z.strictObject({ code: z.string().min(1), reason: z.string().min(1).optional() }).optional(),
});
export const CheckSpecSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
  id: IdSchema, metricId: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/), version: z.literal('v1'),
  required: z.boolean(), hardConstraint: z.boolean(), kind: z.enum(['deterministic', 'llm-judge']), unit: z.string().min(1),
  goldKey: z.string().min(1), evidenceKey: z.string().min(1), threshold: z.number().finite().optional(), direction: z.enum(['higher', 'lower']).optional(),
  scope: z.strictObject({ kind: z.string().min(1), ref: z.string().min(1) }).optional(), applicability: z.string().min(1).optional(),
});
export const Categories = ['task', 'tool', 'skill', 'resource', 'context', 'memory', 'compaction', 'subagent', 'intent', 'security', 'export'] as const;
export const EmbeddedFileSchema = z.strictObject({ path: RelativePathSchema, content: z.string(), bytes: z.number().int().nonnegative() });
const FixtureNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:csv|json|md|txt)$/);
const PublicFixturePathSchema = RelativePathSchema.refine(path => path.startsWith('materials/'), 'Public fixture must be under materials');
export const FixtureCatalogSchema = z.strictObject({
  version: Version,
  source: z.strictObject({ ref: z.literal('procurement.csv'), id: z.literal('synthetic-procurement-v1'), origin: z.literal('synthetic_authored'), author: z.string().min(1), license: z.string().min(1), obtainedAt: z.iso.datetime(), businessTime: z.string().min(1), processing: z.string().min(1) }),
  profiles: z.record(IdSchema, z.strictObject({
    regions: z.array(z.enum(['浙江', '河南'])).min(1).refine(items => new Set(items).size === items.length),
    files: z.array(z.strictObject({ source: FixtureNameSchema, path: PublicFixturePathSchema })),
    absentFiles: z.array(PublicFixturePathSchema).default([]),
    controllerFiles: z.array(z.strictObject({ source: z.literal('privacy-canary.txt'), path: z.literal('private/credentials.txt') })).default([]),
    resources: z.strictObject({skills:z.array(z.strictObject({id:IdSchema,version:z.literal('v1')})).min(1)}).optional(),
    controlledToolFault: z.literal('query-timeout-once').optional(),
    initialConversation:z.strictObject({source:FixtureNameSchema,afterTurnAlias:z.literal('turn-1')}).optional(),
  })),
});
export type FixtureCatalog = z.infer<typeof FixtureCatalogSchema>;
const MaterialSchema = z.strictObject({ kind: z.enum(['file', 'directory']), files: z.array(EmbeddedFileSchema).min(1), sourceContent: z.string().optional() });
export const CaseDatasetSchema = z.strictObject({ id: IdSchema, version: Version, referenceDate: z.iso.date(), timezone: z.literal('Asia/Shanghai'), scoringVersion: z.literal('v1'), smoke: z.boolean() });
export const EvalCaseSchema = z.strictObject({
  id: IdSchema, name: z.string().min(1), category: z.enum(Categories),
  difficulty: z.enum(['golden', 'difficult', 'long_tail', 'tool_failure', 'regression', 'adversarial']),
  evalType: z.enum(['capability', 'regression']),
  input: z.strictObject({ prompt: z.string().min(1).max(20000),
    workspaceContext: z.strictObject({ activeView: z.enum(['data','changes','query','evidence']).optional(), region: z.string().optional(), device: z.string().optional() }),
    fixture: z.strictObject({ ref: IdSchema }), turns: z.array(RegisteredStepSchema).optional() }),
  expected: z.strictObject({ requiredCapabilities: Capabilities.optional(), optionalCapabilities: Capabilities.optional(), forbiddenCapabilities: Capabilities.optional(),
    maxToolCalls: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), mustHaveEvidence: z.boolean(),
    expectedFailureMode: z.enum(['tool_timeout','resource_unavailable']).optional(),
    expectedAnswerHint: z.string().min(1), expectedFacts: z.record(z.string(), z.unknown()).optional(), goldRef: IdSchema.optional(),
    forbiddenConditions: z.array(z.string().min(1)).min(1) }),
  scorers: UniqueIds.min(1), risks: z.array(z.enum(['privacy','permission','funds','deletion','external-send','prompt-injection'])).refine(x=>new Set(x).size===x.length),
  tags: UniqueIds, source: z.enum(['hand-authored','real-trace','regression-bug','provider-fixture','historical-issue']), sourceRef: z.string().min(1).optional(),
}).superRefine((item, ctx) => {
  if (Boolean(item.expected.expectedFacts) === Boolean(item.expected.goldRef)) ctx.addIssue({code:'custom',message:'Define facts once: expectedFacts or goldRef'});
  if([...(item.expected.requiredCapabilities??[]),...(item.expected.optionalCapabilities??[])].some(id=>item.expected.forbiddenCapabilities?.includes(id)))ctx.addIssue({code:'custom',message:'Necessary or optional capabilities cannot also be forbidden'});
});
export type CaseDefinition = z.infer<typeof EvalCaseSchema>;
export type RegisteredAction = z.infer<typeof RegisteredActionSchema>;
export type RegisteredStep = z.infer<typeof RegisteredStepSchema>;
export type CheckSpec = z.infer<typeof CheckSpecSchema>;
/** Runtime-only compilation; the authoring and archive contracts store CaseDefinition. */
export type EvalCase = Omit<CaseDefinition,'input'|'expected'> & {
  version: 1; dataset: z.infer<typeof CaseDatasetSchema>; requires: string[]; materialRefs: string[]; lineageGroupIds: string[];
  input: CaseDefinition['input'] & { materials: Record<string,z.infer<typeof MaterialSchema>> };
  setup: RegisteredAction[]; steps: RegisteredStep[];
  expected: CaseDefinition['expected'] & { success: string[]; failure: string[]; checks: CheckSpec[] };
};
export const EmbeddedSourceSchema = z.strictObject({
  id: IdSchema, path: RelativePathSchema, content: z.string(), origin: z.enum(['synthetic_authored','public','licensed']), license: z.string().min(1),
  obtainedAt: z.iso.datetime(), businessTime: z.string().min(1), author: z.string().min(1), exposure: z.enum(['developer_visible','unexposed']), processing: z.string().min(1),
  group: z.strictObject({id:IdSchema,partition:z.enum(['developer_visible','blind_holdout']),parentGroupIds:UniqueIds,notes:z.string().min(1)}),
});
export const EvalGoldSchema = z.strictObject({schemaVersion:Version,caseId:IdSchema,version:Version,values:z.record(z.string(),z.unknown()),
  sources:z.array(z.strictObject({materialRef:RelativePathSchema,rowKeys:z.array(z.string()),fields:z.array(z.string()),method:z.string(),original:EmbeddedSourceSchema}))});
export type EvalGold = z.infer<typeof EvalGoldSchema>;
export const ReviewSchema = z.strictObject({schemaVersion:Version,caseId:IdSchema,caseVersion:Version,goldVersion:Version,state:z.enum(['pending','verified']),
  authoredBy:z.string().min(1),checkedBy:z.string().min(1).nullable(),checkedAt:z.iso.datetime().nullable(),method:z.string().min(1),unresolved:z.array(z.string()),
  authoring:z.strictObject({budget:z.strictObject({necessary:z.number().int().nonnegative(),verification:z.number().int().nonnegative(),recovery:z.number().int().nonnegative(),explanation:z.string().min(1)}),evidence:z.string().min(1),failures:z.array(z.strictObject({condition:z.string().min(1),scorers:UniqueIds.min(1)})).min(1),harness:UniqueIds.min(1)}).optional(),
}).superRefine((item,ctx)=>{if(item.state==='verified'&&(!item.checkedBy||!item.checkedAt||item.unresolved.length))ctx.addIssue({code:'custom',message:'Actual verification record required'});});
export const DatasetLineageSchema = z.strictObject({contract:z.literal('medclaw-eval-lineage/v1'),version:Version,
  groups:z.array(z.strictObject({id:IdSchema,sourceRefs:z.array(RelativePathSchema),caseIds:UniqueIds,partition:z.enum(['developer_visible','blind_holdout']),exposure:z.enum(['developer_visible','unexposed']),origin:z.enum(['synthetic_authored','public','licensed']),parentGroupIds:UniqueIds,notes:z.string()}))});
export type DatasetLineage = z.infer<typeof DatasetLineageSchema>;
export const DatasetManifestSchema = z.strictObject({contract:z.literal('medclaw-agent-dataset/v1'),id:IdSchema,version:Version,name:z.string(),description:z.string(),createdAt:z.iso.datetime(),readiness:z.enum(['draft','reviewed']),members:UniqueIds,smoke:UniqueIds,referenceDate:z.iso.date(),timezone:z.literal('Asia/Shanghai'),scoringVersion:z.literal('v1')});
export type DatasetManifest = z.infer<typeof DatasetManifestSchema>;
export const DataCheckResultsSchema = z.strictObject({contract:z.literal('medclaw-data-check-results/v1'),status:z.literal('passed'),checker:z.string(),checkedAt:z.iso.datetime(),assertions:z.number().int().positive(),cases:z.number().int().positive(),stages:z.number().int().positive(),sourceRows:z.number().int().positive(),methods:z.array(z.string()),inputs:z.record(z.string(),z.string()),qualityRuns:z.literal('NOT_RUN'),exposure:z.literal('developer_visible'),unresolvedDataChecks:z.array(z.string()).length(0)});

const Strings = z.array(z.string().min(1));
const Regions = z.array(z.enum(['浙江','河南'])).min(1);
const FactKeys = z.strictObject({factKeys:Strings.min(1)});
const SourceTurn = z.strictObject({sourceTurnAlias:Alias});
export const ScorerExpectationsSchema = z.strictObject({
  'task.clarify_decision':z.strictObject({allowedActions:Strings.min(1),forbiddenCalls:Strings}),
  'tool.params':z.strictObject({sourceTurnAlias:Alias.optional()}),
  'tool.adoption':FactKeys,
  'tool.redundancy':z.strictObject({allowedReasons:Strings}),
  'tool.failure_handling':z.strictObject({maxRetries:z.number().int().nonnegative().max(8)}),
  'skill.selection':z.strictObject({allowedSkillIds:z.array(IdSchema.nullable()).min(1)}),
  'resource.read':z.strictObject({requiredRefs:z.array(z.strictObject({kind:z.enum(['skill','prompt']),id:IdSchema,version:z.literal('v1'),file:RelativePathSchema})).min(1)}),
  'resource.progressive_read':z.strictObject({requiredRefs:Strings.min(1),allowedRefs:Strings.optional(),maxBytes:z.number().int().positive()}),
  'resource.follow':z.strictObject({requiredActions:Strings.min(1),forbiddenActions:Strings}),
  'context.correction':SourceTurn,
  'context.current_use':z.strictObject({sourceTurnAlias:Alias,factKeys:Strings.optional()}),
  'memory.history_use':z.strictObject({sessionAlias:Alias,sourceTurnAlias:Alias,factKeys:Strings.min(1)}),
  'compaction.fact_retention':z.strictObject({sourceTurnAlias:Alias,factKeys:Strings.min(1)}),
  'compaction.continue':FactKeys,
  'subagent.success':FactKeys,
  'subagent.utility':FactKeys,
  'subagent.identity_scope':z.strictObject({allowedTools:Strings.min(1),regions:Regions}),
  'subagent.stop':z.strictObject({requiredCleanup:z.literal(true)}),
  'subagent.delegation':z.strictObject({delegate:z.boolean()}),
  'intent.route_exact':z.strictObject({program:z.strictObject({allowedRoutes:Strings.min(1),status:z.string().min(1),queryKind:z.string().min(1)})}),
  'security.injection':z.strictObject({forbiddenMarkers:Strings,forbiddenActions:Strings}),
  'security.scope':z.strictObject({regions:Regions}),
  'security.side_effect':z.strictObject({authorized:z.array(z.strictObject({kind:z.enum(['export','delete','external-send','payment']),format:z.enum(['csv','json','markdown']).optional(),queryAlias:Alias.optional(),confirmationTurnAlias:Alias.optional()}).refine(value=>value.kind==='export'||Boolean(value.confirmationTurnAlias),'High-risk authorization requires an actual confirmation input')),requiresConfirmation:Strings.optional()}),
  'export.exact':z.strictObject({format:z.enum(['csv','json','markdown']),sourceQueryAlias:Alias,requiredColumns:Strings.optional()}),
}).partial();
export type ScorerExpectations = z.infer<typeof ScorerExpectationsSchema>;
const Rubric = z.strictObject({pass:z.string().min(1),partial:z.string().min(1),fail:z.string().min(1)});
const SemanticIds = ['tool.params','task.clarify_decision','tool.adoption','context.current_use','memory.history_use','compaction.fact_retention','compaction.continue','subagent.success','subagent.utility','resource.follow','answer.faithful','answer.reasoning'] as const;
export const SourceReferenceSchema=z.strictObject({kind:z.enum(['product-spec','historical-issue','real-trace','provider-fixture']),path:RelativePathSchema,section:z.string().min(1),rationale:z.string().min(1)});
export const ProductResourceSchema=z.strictObject({kind:z.enum(['skill','prompt']),id:IdSchema,version:z.literal('v1'),files:z.array(EmbeddedFileSchema).min(1)});
export type ProductResource=z.infer<typeof ProductResourceSchema>;
export const GoldDefinitionSchema=z.strictObject({
  target:z.custom<Target>(value=>value!==null&&typeof value==='object'&&typeof (value as Target).op==='string').optional(),
  facts:z.record(z.string(),z.any()).optional(),initial:z.strictObject({target:z.custom<Target>(value=>value!==null&&typeof value==='object'&&typeof (value as Target).op==='string'),facts:z.record(z.string(),z.any())}).optional(),
  cancel:z.boolean().optional(),
  scorerExpectations:ScorerExpectationsSchema.optional(),
  expectedSources:Strings.optional(),evidenceRequirements:z.strictObject({mustCite:z.boolean(),minSources:z.number().int().nonnegative().optional(),sourceKinds:z.array(z.enum(['synthetic_authored','product_resource'])).optional()}).optional(),
  rubric:z.strictObject(Object.fromEntries(SemanticIds.map(id=>[id,Rubric.optional()])) as {[K in typeof SemanticIds[number]]:z.ZodOptional<typeof Rubric>}).optional(),
});
export type GoldDefinition=z.infer<typeof GoldDefinitionSchema>;
