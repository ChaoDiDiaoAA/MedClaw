import { appendFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EvaluationFrameDecoder } from '../../packages/contracts/src/evaluation-transport';
import type { EvaluationControlView } from '../../packages/contracts/src/evaluation';

const decoder = new EvaluationFrameDecoder();
let view: EvaluationControlView, mode = '', root = '', shutdownReceived = false, originalRunRef = '';
const send = (value: unknown) => new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve()));
const identity = () => ({ protocolVersion: 'medclaw.evaluation-control/v1', controllerInstanceId: view.controllerInstanceId });
const status = async () => { view.sequence++; await send({ ...identity(), kind: 'notice', notice: { type: 'eval.status', controllerInstanceId: view.controllerInstanceId, executionId: view.executionId, sequence: view.sequence, control: view } }); };
controlLoop: for await (const chunk of process.stdin) for (const frame of decoder.push(chunk)) {
  if (frame.kind === 'hello') {
    root = frame.paths.runsRoot; mode = basename(frame.paths.configsRoot);
    if (['MEDCLAW_JUDGE_API_KEY', 'LANGFUSE_SECRET_KEY', 'OPENAI_API_KEY'].some(key => process.env[key])) process.exit(42);
    view = { controllerInstanceId: frame.controllerInstanceId, operationKind: null, operationRef: null, executionId: null, state: 'idle', sequence: 0,
      currentTrial: null, progress: null, progressCounts: { planned: 0, saved: 0, pass: 0, fail: 0, unjudgeable: 0, error: 0, notRun: 0 },
      stopConfirmed: true, saveConfirmed: true, controllerExited: false, blockReasons: [], result: null, error: null };
    await send({ ...identity(), kind: 'ready', ...(mode === 'wrong-controller' ? { controllerInstanceId: '00000000-0000-4000-8000-000000000001' } : {}) });
    continue;
  }
  if (frame.kind === 'shutdown' && !('proof' in frame)) {
    shutdownReceived = true;
    if (mode === 'save-unknown' && !existsSync(join(root, 'allow-save'))) view = { ...view!, state: 'unknown', stopConfirmed: true, saveConfirmed: false,
      blockReasons: [{ code: 'save_unconfirmed', message: 'Controlled save is still unconfirmed.', trialId: null }] };
    else if (mode !== 'stop-unknown' || existsSync(join(root, 'allow-stop'))) view = { ...view!, state: view!.operationRef ? 'settled' : 'idle', stopConfirmed: true, saveConfirmed: true, blockReasons: [] };
    await send({ ...frame, proof: { stopConfirmed: view!.stopConfirmed, saveConfirmed: view!.saveConfirmed, controllerExited: false, executionId: view!.executionId, gaps: view!.blockReasons } });
    if (mode === 'ack-without-exit') {
      const timer = setInterval(() => { if (existsSync(join(root, 'allow-exit'))) process.exit(0); }, 10);
      timer.unref();
    } else if (view!.stopConfirmed === true && view!.saveConfirmed === true) { process.stdin.destroy(); break controlLoop; }
    continue;
  }
  if (frame.kind !== 'request') throw new Error('Unexpected test frame');
  const { method, operationRef, payload } = frame.request;
  appendFileSync(join(root, 'worker-requests.jsonl'), JSON.stringify({ method, operationRef }) + '\n');
  if (method === 'eval.status') {
    const requested = payload as { operationRef?: string; executionId?: string };
    if (requested.operationRef === view!.operationRef && requested.executionId && requested.executionId !== view!.executionId) {
      await send({ ...identity(), kind: 'reply', requestId: frame.requestId, operationRef, method,
        result: { ok: false, error: { code: 'state_conflict', category: 'runtime', retryable: false, message: 'Controlled identity conflict' } } }); continue;
    }
  }
  let data: unknown;
  switch (method) {
    case 'eval.status': {
      const requested = payload as { operationRef?: string; executionId?: string };
      if (mode === 'late-status-reply' && view!.operationKind === 'run' && requested.operationRef === view!.operationRef) {
        data = structuredClone(view!); view = { ...view!, state: 'settled', stopConfirmed: true, saveConfirmed: true }; await status(); break;
      }
      data = (!requested.operationRef || requested.operationRef === view!.operationRef) && (!requested.executionId || requested.executionId === view!.executionId) ? view!
        : { ...view!, operationKind: null, operationRef: requested.operationRef ?? null, executionId: requested.executionId ?? null,
          state: 'unknown', stopConfirmed: null, saveConfirmed: null, result: null, currentTrial: null, progress: null }; break;
    }
    case 'eval.preflight': {
      const p = payload as { datasetId: string; selection: string; trials?: number };
      data = { preflightId: view!.controllerInstanceId, datasetId: p.datasetId, selection: p.selection, trials: p.trials ?? 1,
        cases: 1, plannedTrials: 1, judgeRequestLimit: 0, readiness: 'reviewed', config: null, platformConfigured: false, blockers: [] }; break;
    }
    case 'eval.start': {
      originalRunRef = operationRef;
      view = { ...view!, operationKind: 'run', operationRef, executionId: 'desktop-' + operationRef, state: 'running', stopConfirmed: null, saveConfirmed: null };
      await status(); data = { operationRef, executionId: view.executionId, accepted: true }; break;
    }
    case 'eval.resend': {
      view = { ...view!, operationKind: 'resend', operationRef, executionId: (payload as { executionId: string }).executionId,
        state: 'running', stopConfirmed: null, saveConfirmed: null };
      await status(); data = { operationRef, executionId: view.executionId, operationKind: mode === 'wrong-platform-kind' ? 'review_sync' : 'resend', accepted: true }; break;
    }
    case 'eval.cancel': {
      if ((payload as { executionId: string }).executionId !== view!.executionId) {
        data = { cancelRequested: false, control: { ...view!, operationKind: null, operationRef: null, executionId: (payload as { executionId: string }).executionId,
          state: 'unknown', stopConfirmed: null, saveConfirmed: null, currentTrial: null, progress: null, result: null } }; break;
      }
      view = { ...view!, state: mode === 'stop-unknown' ? 'unknown' : 'settled', stopConfirmed: mode === 'stop-unknown' ? null : true, saveConfirmed: true };
      await status(); data = { cancelRequested: true, control: view }; break;
    }
    case 'eval.report.list': {
      if (mode === 'late-run-status' && view!.operationKind === 'resend') {
        view!.sequence++;
        const late = { ...view!, operationKind: 'run', operationRef: originalRunRef, state: 'settled', stopConfirmed: true, saveConfirmed: true };
        await send({ ...identity(), kind: 'notice', notice: { type: 'eval.status', controllerInstanceId: view!.controllerInstanceId, executionId: view!.executionId, sequence: view!.sequence, control: late } });
        view!.sequence++;
        await send({ ...identity(), kind: 'notice', notice: { type: 'eval.progress', controllerInstanceId: view!.controllerInstanceId, executionId: view!.executionId, sequence: view!.sequence,
          progress: { trialId: 'old-trial', caseId: 'old-case', repetition: 1, index: 1, total: 1, kind: 'saved', phase: 'save', elapsedMs: 0 } } });
      }
      data = { page: 1, pageSize: 50, total: 0, items: [] }; break;
    }
    default: throw new Error('Unexpected test method');
  }
  const reply = { ...identity(), kind: 'reply', requestId: frame.requestId, operationRef, method, result: { ok: true, data } };
  if (mode === 'wrong-start-result' && method === 'eval.start') {
    await send({ ...reply, result: { ok: true, data: { operationRef, executionId: 'foreign-execution', accepted: true } } }); continue;
  }
  if (mode === 'wrong-status-result' && method === 'eval.status' && (payload as { executionId?: string }).executionId) {
    await send({ ...reply, result: { ok: true, data: { ...view!, controllerInstanceId: '00000000-0000-4000-8000-000000000001' } } }); continue;
  }
  if (mode === 'wrong-cancel-result' && method === 'eval.cancel') {
    await send({ ...reply, result: { ok: true, data: { cancelRequested: true, control: { ...view!, controllerInstanceId: '00000000-0000-4000-8000-000000000001' } } } }); continue;
  }
  if (mode === 'unsafe-error' && method === 'eval.preflight') {
    await send({ ...reply, result: { ok: false, error: { code: 'invalid_argument', category: 'input', retryable: false, message: 'synthetic-private-provider-body' } } }); continue;
  }
  if (mode === 'wrong-operation' && method === 'eval.preflight') {
    await send({ ...reply, operationRef: '00000000-0000-4000-8000-000000000001' }); continue;
  }
  if (mode === 'wrong-method' && method === 'eval.preflight') {
    await send({ ...reply, method: 'eval.report.list', result: { ok: true, data: { page: 1, pageSize: 50, total: 0, items: [] } } }); continue;
  }
  await send(reply);
  if (mode === 'exit-running' && method === 'eval.start') {
    const timer = setInterval(() => { if (existsSync(join(root, 'allow-exit'))) process.exit(23); }, 10);
    timer.unref();
  }
}
if (!shutdownReceived) process.exitCode = 1;
