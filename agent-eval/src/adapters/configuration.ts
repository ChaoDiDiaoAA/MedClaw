import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_REQUEST_POLICY, RequestPolicySchema } from '../../../packages/contracts/src/model.ts';
import type { ResolvedRunConfig } from '../types.ts';
import { ProductAdapter, unwrap } from './product.ts';

export async function verifyPublishedConfiguration(product: ProductAdapter, config: ResolvedRunConfig) {
  const current = unwrap(await product.request('model.config.read', {}));
  const intent=current.intentModel;
  if(!intent?.enabled||intent.baseUrl!==config.intent.baseUrl||intent.modelTag!==config.intent.model)throw new Error('published_intent_configuration_mismatch');
  const directory = unwrap(await product.request('model.read', {}));
  const selection = directory.selection;
  // Product output limits come from the model catalog, not RequestPolicy; never silently override its identity.
  if (!selection || selection.provider !== config.model.provider || selection.modelId !== config.model.model
    || selection.maxOutputTokens !== config.model.maxTokens || selection.configVersion !== current.configVersion) throw new Error('published_model_configuration_mismatch');
  if(config.model.definition) {
    const actual=unwrap(await product.request('model.custom.read',{providerId:config.model.provider}));
    if(!isDeepStrictEqual(actual.definitions,[config.model.definition]))throw new Error('published_model_definition_mismatch');
  }
  if (!isDeepStrictEqual(current.policy, RequestPolicySchema.parse({ ...DEFAULT_REQUEST_POLICY, ...config.policy }))) throw new Error('published_policy_configuration_mismatch');
  const inspection = unwrap(await product.request('model.intent.inspect', { baseUrl: intent.baseUrl, modelTag: intent.modelTag }));
  if (!inspection.available) throw new Error(`published_intent_configuration_unavailable:${inspection.error?.code ?? 'unknown'}`);
  if (inspection.actualDigest !== intent.modelDigest) throw new Error('intent_model_identity_mismatch');
  product.record('published_configuration_verified', { selection, intent, policy: current.policy, inspection });
  return { provider: selection.provider, modelId: selection.modelId, expectedConfigVersion: current.configVersion };
}
