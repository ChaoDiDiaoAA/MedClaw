import { mkdir, writeFile, realpath, readFile, lstat, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { MainSettings, atomicWriteJson } from '../../../apps/desktop/src/main/settings.ts';
import { DEFAULT_INTENT_MODEL, IntentModelConfigurationSchema, PublishedSettingsSchema, RequestPolicySchema } from '../../../packages/contracts/src/model.ts';
import { mergeRuntimeConfigurationPolicies } from '../../../packages/contracts/src/runtime-config.ts';
import { ProductAdapter, unwrap, type ProductOptions, type ShutdownProof } from '../adapters/product.ts';
import { readInstallManifest } from '../../../apps/desktop/src/main/runtime-paths.ts';
import { verifyPublishedConfiguration } from '../adapters/configuration.ts';
import type { AgentModelCredential,ResolvedRunConfig, VerifiedObservation } from '../types.ts';
import { isDeepStrictEqual } from 'node:util';
import { within } from '../adapters/files.ts';
import {OllamaIntentClient} from '../../../packages/intent-ollama/src/index.ts';

export async function prepareInstance(options: { trialRoot: string; workRoot?:string; config: ResolvedRunConfig; modelCredential?:AgentModelCredential; installManifestPath?:string; hostEntry?: string; bunExecutable?: string; controlledToolFault?: 'query-timeout-once'; owner?: { executionId: string; trialId: string; caseId: string } }) {
  if(options.modelCredential&&(options.modelCredential.providerId!==options.config.model.provider||!options.modelCredential.key.trim()))throw new Error('agent_credential_provider_mismatch');
  let runtimePaths: Pick<ProductOptions, 'hostEntry' | 'bunExecutable' | 'resourceRoot' | 'maintenanceEntry' | 'installManifestPath'> = { hostEntry: options.hostEntry, bunExecutable: options.bunExecutable };
  if (options.installManifestPath !== undefined) {
    try {
      if (!isAbsolute(options.installManifestPath)) throw new Error('host_protocol_mismatch');
      const installManifestPath = await realpath(options.installManifestPath), installRoot = dirname(installManifestPath), manifest = readInstallManifest(installManifestPath);
      const binary = manifest.binaries.find(value => value.name === 'bun'); if (!binary) throw new Error('host_protocol_mismatch');
      const hostEntry = await realpath(join(installRoot, manifest.hostEntry)), maintenanceEntry = await realpath(join(installRoot, manifest.maintenanceEntry));
      const resourceRoot = await realpath(join(installRoot, manifest.resourceRoot)), bunExecutable = await realpath(join(installRoot, binary.path));
      for (const [path, directory] of [[hostEntry, false], [maintenanceEntry, false], [bunExecutable, false], [resourceRoot, true]] as const) {
        within(installRoot, path); const info = await lstat(path);
        if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('host_protocol_mismatch');
      }
      if (await realpath(resolve(dirname(hostEntry), '../../..')) !== await realpath(resolve(import.meta.dir, '../../..'))) throw new Error('host_protocol_mismatch');
      runtimePaths = { hostEntry, bunExecutable, resourceRoot, maintenanceEntry, installManifestPath };
    } catch (error) { throw new Error(error instanceof Error && error.message === 'path_outside_owned_root' ? 'access_denied' : 'host_protocol_mismatch'); }
  }
  const trialRoot = resolve(options.trialRoot), dataRoot = join(resolve(options.workRoot??trialRoot), 'product');
  await mkdir(trialRoot, { recursive: true }); await mkdir(dataRoot); await mkdir(join(dataRoot, 'data'));
  const settingsPath = join(dataRoot, 'data', 'settings.json'), initial = new MainSettings(settingsPath).read();
  const candidate = IntentModelConfigurationSchema.parse({ ...DEFAULT_INTENT_MODEL, baseUrl: options.config.intent.baseUrl,
    modelTag: options.config.intent.model });
  const inspection=await new OllamaIntentClient({classify:'Configuration inspection only',verify:'Configuration inspection only'}).inspect(candidate);
  if(!inspection.available)throw new Error('intent_model_unavailable:'+inspection.error?.code);
  const intentModel=IntentModelConfigurationSchema.parse({...candidate,enabled:true,verifiedEvidenceRef:`eval:${options.owner?.executionId??'controlled-fixture'}/${options.owner?.trialId??'engineering'}/events.jsonl`});
  const settings = PublishedSettingsSchema.parse({ ...initial, model: { provider: options.config.model.provider, modelId: options.config.model.model },
    customProviders:options.config.model.definition?[{definition:options.config.model.definition,credentialRef:options.modelCredential?'eval-model-key':null}]:[],
    credentialRefs:options.modelCredential?{[options.modelCredential.providerId]:'eval-model-key'}:{},
    intentModel, ...mergeRuntimeConfigurationPolicies(initial, { requestPolicy: RequestPolicySchema.parse({ ...initial.requestPolicy, ...options.config.policy }) }) });
  atomicWriteJson(settingsPath, settings);
  await writeFile(join(trialRoot, 'isolation.json'), JSON.stringify({ mode: 'local', ownRoot: await realpath(dataRoot), otherTrialRoots: [], childEnvironment: 'minimal', observedAt: new Date().toISOString() }, null, 2));
  const adapter = new ProductAdapter({ dataRoot, tracePath: join(trialRoot, 'events.jsonl'), ...runtimePaths,
    controlledToolFault: options.controlledToolFault, modelCredential:options.modelCredential, owner: options.owner ?? { executionId: 'controlled-fixture', trialId: 'engineering', caseId: 'engineering' } });
  try {
    await adapter.start();
    const control = unwrap(await adapter.request('run.control.read', {}));
    if (control.instanceId !== adapter.instanceId) throw new Error('host_protocol_mismatch');
    await verifyPublishedConfiguration(adapter, options.config);
    return adapter;
  } catch (error) {
    const proof = await adapter.stop(); await writeFile(join(trialRoot, 'startup-shutdown.json'), JSON.stringify(proof));
    throw Object.assign(error instanceof Error ? error : new Error('host_start_failed'), { shutdownProof: proof, instanceId: adapter.instanceId });
  }
}

interface CleanupOptions { trialRoot: string; workRoot?:string; executionId: string; trialId: string; instanceId: string; proof: ShutdownProof; observation: VerifiedObservation }
export async function cleanupInstance(options: CleanupOptions) {
  const receipt = { contract: 'medclaw-eval-cleanup/v1', executionId: options.executionId, trialId: options.trialId, instanceId: options.instanceId, observedAt: new Date().toISOString() };
  try {
    const result = await removeOwnedInstance(options);
    await writeFile(join(options.trialRoot, 'cleanup.json'), JSON.stringify({ ...receipt, status: 'removed', reason: null, ...result }, null, 2)); return result;
  } catch (error) {
    await writeFile(join(options.trialRoot, 'cleanup.json'), JSON.stringify({ ...receipt, status: 'preserved', reason: error instanceof Error ? error.message : 'cleanup_unconfirmed' }, null, 2)).catch(() => {});
    throw error;
  }
}
async function removeOwnedInstance(options: CleanupOptions) {
  if (options.proof.stopped !== true || options.proof.closed !== true || !options.proof.processExited
    || options.proof.processTreeStopped !== true || options.proof.requiredPersistenceComplete !== true) throw new Error('cleanup_stop_unconfirmed');
  const trialRoot = await realpath(options.trialRoot), marker = JSON.parse(await readFile(join(trialRoot, 'ownership.json'), 'utf8'));
  const target = join(resolve(options.workRoot??trialRoot), 'product');
  if (marker.contract !== 'medclaw-eval-instance/v1' || marker.executionId !== options.executionId || marker.trialId !== options.trialId
    || !Array.isArray(marker.instanceIds) || !marker.instanceIds.includes(options.instanceId) || marker.dataRoot !== target
    || (await lstat(target)).isSymbolicLink() || await realpath(target) !== target) throw new Error('cleanup_ownership_unconfirmed');
  if (!Number.isSafeInteger(marker.hostPid) || marker.hostPid <= 0) throw new Error('cleanup_stop_unconfirmed');
  try { process.kill(marker.hostPid, 0); throw new Error('cleanup_process_still_alive'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  const saved = JSON.parse(await readFile(join(trialRoot, 'observation.json'), 'utf8')) as VerifiedObservation;
  if (saved.executionId !== options.executionId || saved.trialId !== options.trialId || saved.instanceId !== options.instanceId
    || !isDeepStrictEqual(saved,options.observation) || saved.identityChecks.some(check => !check.passed) || saved.missing.length) throw new Error('cleanup_evidence_unconfirmed');
  for (const item of (saved.facts.artifactFiles ?? []) as { evidencePath: string; bytes: number; content: string }[]) {
    const path=resolve(trialRoot,item.evidencePath);within(join(trialRoot, 'artifacts'),path);
    if (await realpath(path) !== path) throw new Error('cleanup_evidence_unconfirmed');
    const bytes = await readFile(path);
    if (bytes.length !== item.bytes || !bytes.equals(Buffer.from(item.content))) throw new Error('cleanup_evidence_unconfirmed');
  }
  // Only this marker's real product root is removed; retained evidence stays beside it.
  await rm(target, { recursive: true });
  return { removed: target, retainedEvidence: join(trialRoot, 'observation.json') };
}
