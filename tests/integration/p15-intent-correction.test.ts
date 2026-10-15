import { expect, test } from 'bun:test';
import { agentRuntimeFixture } from '../fixtures/agent-runtime';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';
import { disabledIntentModel, productIntent, resolvedIntent, readIntentStageMessage } from '../fixtures/p14-intent';
import { OllamaIntentClient } from '../../packages/intent-ollama/src/index';
import { CLASSIFY_PROMPT } from '../../packages/core/src/intent/prompts/classify';
import { VERIFY_PROMPT } from '../../packages/core/src/intent/prompts/verify';
import { IntentModelConfigurationSchema } from '../../packages/contracts/src/model';
import { projectRuntimePolicies } from '../../packages/contracts/src/runtime-config';
import type { IntentStageInput } from '../../packages/contracts/src/intent';

async function correctionFixture(mode: 'corrected' | 'still_wrong' | 'cancel' | 'cancel_verify' | 'budget' | 'http' | 'save_failure') {
  const requests: ReturnType<typeof readIntentStageMessage>[] = [];
  let f: Awaited<ReturnType<typeof agentRuntimeFixture>>;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/version') return Response.json({ version: 'ENGINEERING' });
    if (path === '/api/tags') return Response.json({ models: [{ name: 'qwen3.5:0.8b' }] });
    if (path === '/api/show') return Response.json({ details: { family: 'qwen35', parameter_size: '752.39M', quantization_level: 'Q8_0' } });
    if (path !== '/api/chat') return new Response('Unexpected endpoint', { status: 404 });
    const body = await request.json() as { messages: { content: string }[] };
    const stage = readIntentStageMessage(body.messages[1]!.content); requests.push(stage);
    if (mode === 'http') return new Response('ENGINEERING transport failure', { status: 503 });
    if (mode === 'cancel' || mode === 'cancel_verify' && stage.stage === 'verify') f.app.runs.cancelNow(stage.input.runId);
    const item = productIntent();
    return Response.json({ model: 'qwen3.5:0.8b', done: true, done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ ...resolvedIntent(),
      intents: [{ ...item, slots: { ...item.slots, region: '浙江', time: { start: '2026-10-04', endExclusive: '2026-10-05' },
        status: stage.stage === 'verify' && mode === 'corrected' ? 'active' : null } }] }) }, prompt_eval_count: 50, eval_count: 70 });
  } });
  f = await agentRuntimeFixture(undefined, false, undefined, { client: new OllamaIntentClient({ classify: CLASSIFY_PROMPT, verify: VERIFY_PROMPT }),
    configuration: IntentModelConfigurationSchema.parse({ ...disabledIntentModel(), enabled: true, baseUrl: `http://127.0.0.1:${server.port}`,
      verifiedEvidenceRef: 'ENGINEERING', timeoutMs: 60000 }) });
  seedWorkspaceQueries(f.db, f.repos);
  f.db.query('UPDATE runs SET cleanup_json=? WHERE id=10').run(JSON.stringify({ contract: 'medclaw.run-cleanup/v1', executionStarted: false, stopConfirmed: true,
    requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: true, unconfirmedItems: [], secondaryErrors: [], verifiedAt: '2026-10-04T00:00:00.000Z' }));
  const finish = f.repos.finishIntentCall.bind(f.repos);
  if (mode === 'save_failure') f.repos.finishIntentCall = () => { throw new Error('storage_write_failed'); };
  if (mode === 'budget') {
    f.app.config.runtimeConfiguration!.runBudget.maxModelCalls = 1;
    Object.assign(f.app.config, projectRuntimePolicies(f.app.config.runtimeConfiguration!));
  }
  return { ...f, mainRequests: f.requests, requests, finish, request: { ...f.request('列出浙江2026-10-04在售的医疗器械'), routing: { mode: 'intent' as const, originRunId: null } },
    async settled() { for (let i = 0; i < 1000 && f.app.runs.busy && !f.app.runs.persistencePending; i++) await Bun.sleep(2); },
    async close() { try { await f.close(); } finally { server.stop(true); } } };
}

for (const mode of ['corrected', 'still_wrong', 'cancel', 'cancel_verify', 'budget', 'http', 'save_failure'] as const) {
  test(`p15 semantic correction ${mode} preserves facts and cannot exceed two calls or bypass the query gate`, async () => {
    const f = await correctionFixture(mode);
    try {
      const accepted = await f.app.runs.submitAgent(f.request, { instanceId: 'host', operationRef: `correction-${mode}` });
      if (!accepted.ok) throw accepted.error;
      await f.settled();
      const runId = accepted.data.runId!, facts = f.repos.readIntent({ runId });
      expect(f.requests.length).toBe(mode === 'corrected' || mode === 'still_wrong' || mode === 'cancel_verify' ? 2 : 1);
      expect(f.requests[0]!.stage).toBe('classify');
      expect(f.requests[0]!.input.grounding?.facts).toContainEqual(expect.objectContaining({kind:'status',operation:'set',value:'active',quote:'在售'}));
      if (f.requests.length === 2) {
        expect(f.requests[1]!.input).toEqual(f.requests[0]!.input);
        expect(f.requests[1]!.review).toMatchObject({ mode: 'semantic_correction', candidates: [], prediction: { intents: [{ slots: { status: null } }] } });
        expect(facts!.calls[1]!.previousCallId).toBe(facts!.calls[0]!.callId);
        const context = f.contexts.read({ callId: facts!.calls[1]!.callId });
        if (context.kind !== 'snapshot' || !context.snapshot.intentSource?.stageInput) throw new Error('Missing full audit stage');
        expect(context.snapshot.intentSource.stageInput.review).toMatchObject({ previousCallId: facts!.calls[0]!.callId,
          rawPreview: facts!.calls[0]!.rawOutput!.text, prediction: facts!.calls[0]!.prediction });
        expect(context.snapshot.renderedProjection).not.toContain('rawPreview');
        expect(facts!.calls[0]!.prediction!.intents[0]!.slots.status).toBeNull();
      }
      const queries = f.db.query('SELECT id FROM queries WHERE run_id=?').all(runId);
      expect(queries).toHaveLength(mode === 'corrected' ? 1 : 0);
      expect(f.mainRequests).toHaveLength(0);
      if (mode === 'corrected') {
        expect(facts!.decision).toMatchObject({ matchedBy: 'paper_enhanced', adoptedSlots: { status: 'active' } });
        expect(facts!.execution.runStatus).toBe('completed');
      }
      if (mode === 'still_wrong') expect(facts).toMatchObject({ decision: null, execution: { runStatus: 'failed' } });
    } finally {
      f.repos.finishIntentCall = f.finish;
      const active = f.app.runs.activeHandle;
      if (active && f.app.runs.persistencePending) {
        expect((await f.app.runs.retrySave(active.runId)).ok).toBe(true); await f.settled();
        expect(f.requests).toHaveLength(1);
        expect(f.db.query('SELECT id FROM queries WHERE run_id=?').all(active.runId)).toHaveLength(0);
      }
      await f.close();
    }
  });
}
