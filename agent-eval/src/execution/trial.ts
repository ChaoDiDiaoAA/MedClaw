import { readFile, mkdir, writeFile,mkdtemp,rm,realpath,lstat,open } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {within} from '../adapters/files.ts';
import { join, resolve } from 'node:path';
import type { EvalCase, EvalGold, ProductResource } from '../evaluation.ts';
import type { AgentModelCredential,ResolvedRunConfig, TrialResult } from '../types.ts';
import { ActionExecutor } from '../adapters/actions.ts';
import { ProductAdapter, unwrap, type ShutdownProof } from '../adapters/product.ts';
import { cleanupInstance, prepareInstance } from './instance.ts';
import { materializeInputs,preparePublicMaterials,type PublicMaterial } from '../datasets.ts';
import { materializeControlFixtures, parseFixtureCatalog } from '../dataset-fixtures.ts';
import { collectObservation } from './observe.ts';
import { projectPublicEvidence } from '../data-format.ts';
import type {TrialPhase} from './progress.ts';

export interface RunTrialOptions { executionId: string; trialId: string; caseId: string; repetition: number; case: EvalCase; datasetRoot: string; fixtureFiles?: Record<string,string>; productResources?: readonly ProductResource[]; config: ResolvedRunConfig; modelCredential?:AgentModelCredential; trialRoot: string; signal?: AbortSignal; controlledFixture?: boolean;onPhase?:(phase:TrialPhase)=>void }
export async function runTrial(options: RunTrialOptions): Promise<TrialResult> {
  const result: TrialResult = { trialId: options.trialId, caseId: options.caseId, repetition: options.repetition, status: 'preparing', instanceId: null, startedAt: null, endedAt: null, reason: null, stopped: null, closed: null, observation: null };
  const trialRoot = resolve(options.trialRoot); await mkdir(trialRoot, { recursive: true });
  const journal=await open(join(trialRoot,'events.jsonl'),'a',0o600);await journal.close();
  let product: ProductAdapter | undefined, executor: ActionExecutor | undefined;
  let cancellation: Promise<void> | undefined;
  let firstShutdown:ShutdownProof|undefined;
  let workRoot:string|undefined;
  let publicMaterials:PublicMaterial[]=[];
  const onAbort = () => {
    if (!product) return;
    const current = product;
    cancellation = (async () => {
      current.deadlineAt = null;
      const active = unwrap(await current.request('run.active', {}));
      if (active) current.record('cancellation', { result: await current.request('run.cancel', { runId: active.runId }) });
      for (const operation of executor?.aliases.operations.values() ?? []) {
        if (operation.kind === 'session_checkpoint') continue;
        const result = operation.kind === 'compaction' && operation.sessionId !== undefined
          ? await current.request('session.compaction.cancel', { sessionId: operation.sessionId, operationRef: operation.operationRef })
          : operation.kind === 'import' || operation.kind === 'export' ? await current.request(operation.kind === 'import' ? 'import.cancel' : 'export.cancel', { operationRef: operation.operationRef }) : null;
        current.record('operation_cancellation', { operationRef: operation.operationRef, kind: operation.kind, result });
      }
    })().catch(error => current.record('cancellation_unknown', { reason: error instanceof Error ? error.message : 'cancel_failed' }));
  };
  try {
    if (options.controlledFixture) {
      const provenance = JSON.parse(await readFile(join(options.datasetRoot, '.controlled-fixture.json'), 'utf8'));
      if (provenance.contract !== 'medclaw-controlled-fixture/v1' || provenance.synthetic !== true || provenance.containsSecrets !== false) throw new Error('controlled_fixture_provenance_invalid');
      const actions = [...options.case.setup, ...options.case.steps.map(step => step.action)];
      if (actions.some(action => action.action === 'send' || action.action === 'compact')) { result.status = 'not_run'; result.reason = 'controlled_fixture_model_execution_disabled'; return result; }
    }
    options.signal?.throwIfAborted();
    if (options.case.id !== options.caseId) throw new Error('case_identity_mismatch');
    result.startedAt = new Date().toISOString();
    options.onPhase?.('prepare_input');
    workRoot=await mkdtemp(join(tmpdir(),'medclaw-eval-work-'));
    const inputRoot = await materializeInputs(options.case, join(workRoot, 'inputs'));
    const profile = options.fixtureFiles ? parseFixtureCatalog(options.fixtureFiles).profiles[options.case.input.fixture.ref] : undefined;
    publicMaterials=await preparePublicMaterials(options.case,inputRoot,profile?.absentFiles);
    if(options.fixtureFiles) await materializeControlFixtures(options.case.input.fixture.ref, options.fixtureFiles, workRoot);
    else if(options.case.input.fixture.ref==='private-canary') throw new Error('controller_fixture_inputs_missing');
    options.onPhase?.('prepare_host');
    product = await prepareInstance({ trialRoot,workRoot, config: options.config, modelCredential:options.modelCredential, controlledToolFault: profile?.controlledToolFault,
      owner: { executionId: options.executionId, trialId: options.trialId, caseId: options.caseId } }); result.instanceId = product.instanceId; result.status = 'running';
    options.signal?.addEventListener('abort', onAbort, { once: true }); options.signal?.throwIfAborted();
    executor = new ActionExecutor(product, options.config, inputRoot, trialRoot, options.productResources,publicMaterials,()=>preparePublicMaterials(options.case,inputRoot,profile?.absentFiles));
    product.record('public_materials',{files:publicMaterials});
    for (const action of options.case.setup) { options.signal?.throwIfAborted(); await executor.execute(action); }
    options.onPhase?.('execute');
    for (const step of options.case.steps) {
      options.signal?.throwIfAborted(); product.record('step_started', { stepId: step.id, action: step.action.action, trigger: step.trigger });
      product.deadlineAt = Date.now() + step.timeoutMs;
      await executor.wait(step.trigger, step.targetAlias, step.timeoutMs, options.signal);
      let failure: unknown;
      try { await executor.execute(step.action); } catch (error) { failure = error; }
      if (step.expectedFailure) {
        const appError = failure && typeof failure === 'object' && 'appError' in failure ? failure.appError as { code?: string; reason?: string } : null;
        if (!appError || appError.code !== step.expectedFailure.code || step.expectedFailure.reason && appError.reason !== step.expectedFailure.reason) throw new Error('expected_failure_not_observed');
      } else if (failure) throw failure;
      product.record('step_completed', { stepId: step.id, expectedFailure: step.expectedFailure ?? null });
      product.deadlineAt = null;
    }
    result.status = 'completed';
  } catch (error) {
    const appError = error && typeof error === 'object' && 'appError' in error ? error.appError as { code?: string } : null;
    result.status = options.signal?.aborted ? 'cancelled' : appError && !['operation_result_unknown', 'host_interrupted', 'host_protocol_mismatch'].includes(appError.code ?? '') ? 'failed' : 'infra_error'; result.reason = error instanceof Error ? error.message : 'trial_failed';
    if (error && typeof error === 'object' && 'shutdownProof' in error) {
      const proof = error.shutdownProof as ShutdownProof; result.stopped = proof.stopped; result.closed = proof.closed;
      firstShutdown=proof;
      if ('instanceId' in error && typeof error.instanceId === 'string') result.instanceId = error.instanceId;
      if (proof.stopped !== true || proof.closed !== true || !proof.processExited || proof.residuals.length) result.reason = 'host_stop_unconfirmed';
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort); await cancellation;
    options.onPhase?.('collect');
    if (product) {
      product.deadlineAt = null;
      let cleanup: { status: 'removed' | 'preserved'; reason: string | null } = { status: 'preserved', reason: options.config.retention === 'preserve_all' ? 'retention_policy' : 'trial_or_evidence_incomplete' };
      if (executor) try { result.observation = await collectObservation({ executionId: options.executionId, trialId: options.trialId, product, aliases: executor.aliases, lastSendAlias: executor.lastSendAlias, trialRoot, observedFrom: result.startedAt! }); }
      catch (error) { result.status = 'infra_error'; result.reason = `observation_failed:${error instanceof Error ? error.message : 'unknown'}`; }
      const lastRunId=executor?.lastSendAlias?executor.aliases.runs.get(executor.lastSendAlias):undefined;
      const runs=result.observation?.facts.runs;
      const lastRun=Array.isArray(runs)&&lastRunId!==undefined?runs.find(run=>run.id===lastRunId):undefined;
      if(result.status==='completed'&&lastRun?.status==='failed') {
        result.status=['provider_request_failed','intent_timeout'].includes(lastRun.error?.code)?'infra_error':'failed';result.reason=lastRun.error?.code??'native_run_failed';
      }
      if (result.observation?.identityChecks.some(check => !check.passed)) { result.status = 'infra_error'; result.reason = 'evidence_identity_mismatch'; }
      try { const latest = await product.stop();const proof=firstShutdown??latest;firstShutdown??=latest; result.stopped = proof.stopped; result.closed = proof.closed;
        await writeFile(join(trialRoot, 'shutdown.json'), JSON.stringify(proof, null, 2));
        if(latest!==proof)await writeFile(join(trialRoot,'cleanup-shutdown.json'),JSON.stringify(latest,null,2));
        if (proof.stopped !== true || proof.closed !== true || !proof.processExited || proof.residuals.length) { result.status = 'infra_error'; result.reason = 'host_stop_unconfirmed'; }
        else if (options.config.retention === 'preserve_on_failure' && result.status === 'completed' && result.observation && result.observation.missing.length === 0) {
          try { await cleanupInstance({ trialRoot,workRoot, executionId: options.executionId, trialId: options.trialId, instanceId: product.instanceId, proof, observation: result.observation }); cleanup = { status: 'removed', reason: null }; }
          catch (error) { result.status = 'infra_error'; result.reason = `cleanup_preserved:${error instanceof Error ? error.message : 'unknown'}`; cleanup.reason = result.reason; }
        }
      } catch (error) {
        if(!firstShutdown&&error&&typeof error==='object'&&'shutdownProof' in error) {
          firstShutdown=error.shutdownProof as ShutdownProof;result.stopped=firstShutdown.stopped;result.closed=firstShutdown.closed;
          await writeFile(join(trialRoot,'shutdown.json'),JSON.stringify(firstShutdown,null,2));
        }
        result.status = 'infra_error'; result.reason = 'host_stop_unconfirmed';
      }
      if (result.stopped !== true || result.closed !== true || firstShutdown?.processExited !== true || firstShutdown.residuals.length) cleanup.reason = 'host_stop_unconfirmed';
      await writeFile(join(trialRoot, 'cleanup.json'), JSON.stringify({ contract: 'medclaw-eval-cleanup/v1', executionId: options.executionId, trialId: options.trialId,
        instanceId: product.instanceId, productRoot: product.paths.dataRoot, ...cleanup, observedAt: new Date().toISOString() }, null, 2));
      if(result.observation) {
        result.observation.facts.publicMaterials=publicMaterials;
        let isolation:unknown;try{isolation=JSON.parse(await readFile(join(trialRoot,'isolation.json'),'utf8'));}catch{}
        result.observation.facts.lifecycle={shutdown:firstShutdown??null,cleanup,isolation,productRoot:product.paths.dataRoot};
        result.observation=projectPublicEvidence(result.observation);
        Object.defineProperty(result.observation.facts,'evidenceRoot',{value:trialRoot,enumerable:false});
        await writeFile(join(trialRoot,'observation.json'),JSON.stringify(result.observation,null,2),{mode:0o600});
      }
    }
    result.endedAt = new Date().toISOString();
    const lifecycle:Record<string,unknown>={};
    if(workRoot)lifecycle.workRoot=workRoot;
    for(const name of ['isolation','ownership','shutdown','startup-shutdown','cleanup','cleanup-shutdown'])try{lifecycle[name]=JSON.parse(await readFile(join(trialRoot,name+'.json'),'utf8'));await import('node:fs/promises').then(fs=>fs.unlink(join(trialRoot,name+'.json')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const {observation,...state}=result;
    await writeFile(join(trialRoot, 'trial.json'), JSON.stringify(projectPublicEvidence({...state,observationRef:observation?'observation.json':null,lifecycle}), null, 2), { mode: 0o600 });
    if(workRoot&&options.config.retention==='preserve_on_failure'&&result.status==='completed'&&result.stopped===true&&result.closed===true&&result.observation?.missing.length===0) {
      within(tmpdir(),workRoot);if((await lstat(workRoot)).isSymbolicLink()||await realpath(workRoot)!==workRoot)throw new Error('work_root_ownership_changed');await rm(workRoot,{recursive:true});
    }
  }
  return result;
}
