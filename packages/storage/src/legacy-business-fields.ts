import { CONTEXT_MATERIAL_PREFIX, renderIntentContext } from '../../contracts/src/context';
import { IntentStageInputSchema, type IntentStageInput } from '../../contracts/src/intent';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const array = (value: unknown, convert: (item: unknown) => unknown): unknown => Array.isArray(value) ? value.map(convert) : value;
function fields(value: unknown, converters: Record<string, (item: unknown) => unknown>): unknown {
  const source = record(value); if (!source) return value;
  const result = { ...source };
  for (const [key, convert] of Object.entries(converters)) if (key in result) result[key] = convert(result[key]);
  return result;
}

/** Only named metadata paths are converted; saved text and business values stay intact. */
export function omitLegacyFields(value: unknown, names: readonly string[]): unknown {
  const source = record(value); if (!source) return value;
  const result = { ...source }; for (const name of names) delete result[name]; return result;
}
export const legacySourceRef = (value: unknown): unknown => omitLegacyFields(value, ['sha256']);
export const legacyFieldOrigins = (value: unknown): unknown => {
  const source = record(value); return source ? Object.fromEntries(Object.entries(source).map(([key, origin]) =>
    [key, fields(origin, { sourceRefs: refs => array(refs, legacySourceRef) })])) : value;
};
export const legacyResourceRef = (value: unknown): unknown => omitLegacyFields(value, ['treeHash']);
const resourceSelection = (value: unknown) => fields(value, { prompt: legacyResourceRef, skills: refs => array(refs, legacyResourceRef) });
const file = (value: unknown) => omitLegacyFields(value, ['sha256']);
const diagnostic = (value: unknown) => fields(value, { resourceRef: legacyResourceRef });
export const legacyRunResources = (value: unknown): unknown => fields(value, {
  selection: resourceSelection,
  available: items => array(items, item => fields(item, { ref: legacyResourceRef, files: files => array(files, file) })),
  omitted: items => array(items, diagnostic),
});
export const legacyRunExtensions = (value: unknown): unknown => fields(value, {
  selection: selection => fields(selection, { extension: legacyResourceRef }),
  source: source => fields(source, { files: files => array(files, file) }),
});
export const legacyRunScope = (value: unknown): unknown => fields(value, {
  allowedResourceRefs: refs => array(refs, ref => typeof ref === 'string' ? ref.replace(/#[a-f0-9]{64}$/, '') : ref),
});
const batchRef = (value: unknown) => omitLegacyFields(value, ['contentHash']);
const batch = (value: unknown) => omitLegacyFields(value, ['contentHash', 'cohortHash', 'sourceLockHash']);
export const legacyWorkspaceContext = (value: unknown): unknown => fields(value, {
  batchRefs: refs => array(refs, batchRef),
  selection: value => {
    const selection = record(value);
    return selection?.kind === 'query-row' && typeof selection.rowKey === 'string' && /^row:[a-f0-9]{64}$/.test(selection.rowKey) ? null : value;
  },
});
export const legacyModelSelection = (value: unknown): unknown => fields(omitLegacyFields(value, ['modelDigest']), { endpointRef: () => null });
const nativeRef = (value: unknown) => omitLegacyFields(value, ['contentHash']);
const delegation = (value: unknown) => omitLegacyFields(value, ['promptHash']);
const contextRef = (value: unknown) => omitLegacyFields(value, ['hash']);
const queryRef = (value: unknown) => omitLegacyFields(value, ['resultHash']);
export const legacyQueryContext = (value: unknown): unknown => omitLegacyFields(value, ['scopeBatchHashes']);
export const legacyIntentInput = (value: unknown): unknown => fields(omitLegacyFields(value, ['scopeBatchHashes']), {
  scope: legacyRunScope, previousQueryContext: legacyQueryContext,
  grounding: grounding => omitLegacyFields(grounding, ['textHash', 'pendingTaskHash']),
});
export const legacyIntentStage = (value: unknown): unknown => fields(value, {
  input: legacyIntentInput, review: review => omitLegacyFields(review, ['rawHash']),
});
export const legacyIntentAdmission = (value: unknown): unknown => fields(value, {
  selection: legacyModelSelection,
  prompts: prompts => fields(prompts, { classify: prompt => omitLegacyFields(prompt, ['hash']), verify: prompt => omitLegacyFields(prompt, ['hash']) }),
});
const intentSource = (value: unknown) => fields(value, { stageInput: legacyIntentStage });
const resourceEvidence = (value: unknown) => fields(omitLegacyFields(value, ['contentHash', 'payloadHash']), { resourceRef: legacyResourceRef });
const resourceRead = (value: unknown) => fields(omitLegacyFields(value, ['fileHash', 'returnedContentHash']), { resourceRef: legacyResourceRef });
const resourcePayload = (value: unknown) => fields(omitLegacyFields(value, ['payloadHash']), { verified: refs => array(refs, resourceEvidence) });
const resourceContext = (value: unknown) => fields(value, { expected: refs => array(refs, resourceEvidence), payload: resourcePayload });
export const legacyContextObservation = (value: unknown): unknown => fields(omitLegacyFields(value, ['payloadHash', 'projectionHash', 'feedbackHash']), {
  verifiedNativeRefs: refs => array(refs, nativeRef), resources: resourcePayload,
});
export const legacyModelCallContext = (value: unknown): unknown => fields(value, {
  delegationSource: delegation, intentSource, observation: legacyContextObservation, resources: resourceContext,
});
export const legacyContextBody = (value: unknown): unknown => fields(omitLegacyFields(value, ['projectionHash', 'feedbackHash']), {
  workspaceContext: legacyWorkspaceContext, selectedRefs: refs => array(refs, contextRef), nativeRefs: refs => array(refs, nativeRef),
  delegationSource: delegation, intentSource,
  resourceVersions: versions => {
    const source = record(versions); return source ? Object.fromEntries(Object.entries(source).map(([key, version]) =>
      [key, typeof version === 'string' ? version.replace(/#[a-f0-9]{64}$/, '') : version])) : versions;
  },
});
export const legacyContextProjection = (value: unknown): unknown => fields(value, {
  executionScope: legacyRunScope, materialScope: legacyRunScope, adoptedQueryContext: legacyQueryContext,
  materials: materials => array(materials, material => fields(material, { ref: contextRef, fieldOrigins: legacyFieldOrigins })),
});
export const legacyChildConfig = (value: unknown): unknown => fields(omitLegacyFields(value, ['promptHash']), {
  scope: legacyRunScope, model: legacyModelSelection, resources: legacyRunResources,
});
export const legacyChildResult = (value: unknown): unknown => fields(omitLegacyFields(value, ['originalReplyHash']), { queryRefs: refs => array(refs, queryRef) });
export const legacyIntentMetadata = (value: unknown): unknown => fields(value, { batches: batches => array(batches, batch) });
export const legacyIntentExecution = (value: unknown): unknown => fields(value, {
  stepResults: steps => array(steps, step => fields(step, { queryRefs: refs => array(refs, queryRef),
    metadata: legacyIntentMetadata })),
});
const sourceRecord = (value: unknown) => fields(value, { sourceRefs: refs => array(refs, legacySourceRef), fieldOrigins: legacyFieldOrigins });
export function legacyBusinessToolOutput(name: string, value: unknown): unknown {
  if (name === 'query_intent_step') return record(value)?.batches === undefined ? omitLegacyFields(value, ['resultHash']) : legacyIntentMetadata(value);
  if (['read_query', 'read_query_page', 'query_current_devices', 'query_device_changes'].includes(name)) return omitLegacyFields(value, ['resultHash']);
  if (name === 'read_query_evidence') return omitLegacyFields(value, ['resultHash', 'sourceLockHash']);
  if (name === 'list_query_evidence') return fields(value, { items: items => array(items, item => omitLegacyFields(item, ['resultHash', 'sourceLockHash'])) });
  if (name === 'read_source_metadata' || name === 'read_evidence_rows') return fields(value, { items: items => array(items, sourceRecord) });
  if (name === 'read_device') return sourceRecord(value);
  if (name === 'read_batch') return batch(value);
  if (name === 'list_batches') return fields(value, { items: items => array(items, batch) });
  if (name === 'read_data_scope') return fields(value, { scope: legacyRunScope });
  return value;
}
export const legacyInputContent = (value: unknown): unknown => fields(value, {
  workspaceContext: legacyWorkspaceContext, scope: legacyRunScope, model: legacyModelSelection,
  resourceInputPlan: plan => fields(plan, { resourceRef: legacyResourceRef }), nativeInput: file,
  intentAdmission: legacyIntentAdmission,
});
export const legacyRunConfig = (value: unknown): unknown => fields(value, {
  selection: legacyModelSelection, intentAdmission: legacyIntentAdmission, subagent: legacyChildConfig,
  agent: agent => fields(agent, { resources: legacyRunResources, extensions: legacyRunExtensions }),
});
export const legacyEventPayload = (value: unknown): unknown => {
  const payload=record(value),route=payload?.contract==='medclaw.event/v1'&&payload.decisionId!==undefined&&payload.route!==undefined;
  return fields(route?omitLegacyFields(value,['queryParamsHash']):value,{ruleEvaluation:rule=>omitLegacyFields(rule,['inputHash'])});
};
export const legacyToolDelivery = (value: unknown): unknown => fields(value, {
  control: control => {
    const source=record(control),hook=record(source?.hookInput);
    return hook&&hook.changed===undefined?omitLegacyFields(control,['hookInput']):fields(control, { hookInput: hook => omitLegacyFields(hook, ['beforeSha256', 'afterSha256']) });
  },
  resourceRead,
});

/** Verify the saved model text before converting its explicitly retired metadata. */
export function readLegacyIntentContext(rendered: string, frozenStage?: unknown): IntentStageInput {
  try {
    if (!rendered.startsWith(CONTEXT_MATERIAL_PREFIX)) throw new Error();
    let rawStage: unknown;
    if (record(record(record(frozenStage)?.input)?.versions)?.policyVersion === 'medclaw.intent-policy/v5') {
      rawStage = frozenStage;
    } else {
      const material = rendered.includes('\nFrozen IntentStageInput: ')
        ? rendered.split('\nFrozen IntentStageInput: ')[1]!
        : rendered.slice(CONTEXT_MATERIAL_PREFIX.length);
      rawStage = JSON.parse(material.split('\n', 1)[0]!);
    }
    if (renderIntentContext(rawStage as IntentStageInput) !== rendered) throw new Error();
    return IntentStageInputSchema.parse(legacyIntentStage(rawStage));
  } catch { throw new Error('storage_read_failed'); }
}
