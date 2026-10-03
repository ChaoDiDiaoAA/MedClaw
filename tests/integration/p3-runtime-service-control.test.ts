import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { ModelCallRecorder } from '../../packages/runtime-pi/src/model-call-recorder';
import { RuntimeService } from '../../packages/core/src/runtime/runtime-service';
import { PublishedSettingsSchema, type BudgetSummary, type MeasurementContext, type ModelRuntimePort, type ResolvedProviderSelection, type ToolProfileSnapshot } from '../../packages/contracts/src/model';
import type { AgentRuntimePort, ProviderOutcome, RuntimeBudgetView } from '../../packages/contracts/src/run';
import { SubmitInputSchema, type NativeSessionBindings } from '../../packages/contracts/src/session';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
const unsupported = async (): Promise<never> => { throw new Error('Unexpected fixture operation'); };
async function fixture(timeoutMs = 120000) {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-runtime-service-control-'));
  const db = openDatabase(join(root, 'app.sqlite'));
  const repo = new Repositories(db);
  const session = repo.createSession({ expectedWorkspaceRevision: 0 }, 'create', 'native', new Date().toISOString()).session;
  const settings = PublishedSettingsSchema.parse({
    schemaVersion: 'medclaw.settings/p1-v1',
    configVersion: '1',
    model: null,
    customProviders: [],
    credentialRefs: {},
    requestPolicy: { timeoutMs, maxRetries: 0, maxRetryDelayMs: 2000 },
    agentPolicy: { version: 'medclaw.agent-policy/v1', maxToolCalls: 200, maxModelCalls: 60, singleToolTimeoutMs: 50000, maxRecoveryAttempts: 4 },
    previous: null,
    rollbackFromVersion: null,
  });
  const modelRuntime: ModelRuntimePort<ResolvedProviderSelection> = {
    directory: unsupported,
    refresh: unsupported,
    installCustom: unsupported,
    supportsAuth: () => false,
    login: unsupported,
    authStatus: unsupported,
    resolve: async (_choice, configVersion, _credential, policy) => ({
      selection: { provider: 'fixture', modelId: 'fixture', endpointRef: null, api: 'openai-completions', configVersion, credentialRef: null,
        maxOutputTokens: 1024, capabilitySource: 'pi_catalog', sdkVersion: '0.87.1' },
      policy: structuredClone(policy),
    }),
    execute: unsupported,
  };
  const measurementContext: MeasurementContext = {
    version: 'medclaw.tool-measurement/v1',
    sdkVersion: '0.87.1',
    environmentKey: 'fixture-environment',
    cutoffAt: new Date().toISOString(),
    maxToolCallId: null,
  };
  const toolProfileSnapshot: ToolProfileSnapshot = {
    version: 'medclaw.tool-profile/v1',
    cutoffAt: measurementContext.cutoffAt,
    maxToolCallId: null,
    windowDays: 30,
    observationLimit: 2000,
    perGroupLimit: 50,
    minimumCompleteSamples: 20,
    available: true,
    profiles: [],
  };
  const budgetSummary: BudgetSummary = {
    version: 'medclaw.budget-summary/v1',
    toolCalls: 3,
    modelCalls: 1,
    toolAdmissionsRejected: 0,
    modelAdmissionsRejected: 0,
    convergenceRequested: false,
    recoveryAttempts: 0,
    stopReason: null,
    unresolvedItems: [],
  };
  let captured: Parameters<AgentRuntimePort<ResolvedProviderSelection>['execute']>[0] | null = null;
  let profilesRead = 0;
  let complete!: () => void;
  const waitForStop = new Promise<void>(resolve => { complete = resolve; });
  let started!: () => void;
  const waitForStart = new Promise<void>(resolve => { started = resolve; });
  const agent: AgentRuntimePort<ResolvedProviderSelection> & NativeSessionBindings = {
    toolNames: ['read_data_scope'],
    allocate: () => ({ nativeSessionId: 'unused', bind: () => {}, discard: () => {} }),
    read: () => ({ available: true, reason: null, leafId: null, messages: [], truncated: false }),
    readMessages: () => { throw new Error('Unexpected fixture message read'); },
    describe: () => ({ requestedThinkingLevel: 'off', effectiveThinkingLevel: 'off' }),
    captureToolProfiles: scope => {
      expect(scope.allowedToolNames).toEqual(['read_data_scope']);
      profilesRead++;
      return { measurementContext, toolProfileSnapshot };
    },
    readBudget: (runId): RuntimeBudgetView => ({
      runId,
      toolCalls: { limit: 200, used: 3, remaining: 197 },
      modelCalls: { limit: 60, used: 1, remaining: 59 },
      remainingTimeMs: timeoutMs - 10,
      recovery: { episodeId: null, used: 0, remaining: 4, unresolvedItems: [] },
    }),
    execute: async (input, callbacks) => {
      captured = input;
      const recorder = callbacks.startCall(new Date().toISOString());
      started();
      await waitForStop;
      const outcome: ProviderOutcome = {
        sdkStopReason: input.signal.aborted ? 'aborted' : 'stop',
        text: 'Fixture response',
        responseModel: 'fixture',
        callState: input.signal.aborted ? 'cancelled' : 'completed',
        usage: { inputTokens: null, outputTokens: null, cost: null, costCurrency: null, source: null, unavailableReason: 'fixture' },
        error: null,
      };
      callbacks.nativeTerminal(outcome);
      return { nativeIdle: true, lastOutcome: outcome, calls: [recorder.finish(outcome, new Date().toISOString())], budgetSummary };
    },
  };
  const service = new RuntimeService('instance', () => settings, modelRuntime, repo, (_context, action) => action(),
    (runId, kind, time) => new ModelCallRecorder(repo, runId, kind, time), () => {}, () => {}, agent, () => false);
  closes.push(async () => {
    complete();
    await service.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const workspace = repo.readWorkspace();
  const request = SubmitInputSchema.parse({
    sessionId: session.id,
    clientSequence: 1,
    text: 'Read data',
    mode: 'send',
    expectedRevision: workspace.revision,
    expectedBatchIds: [],
    expectedQueryId: null,
    model: { provider: 'fixture', modelId: 'fixture', expectedConfigVersion: '1' },
    referenceDate: '2026-10-02',
    timezone: 'Asia/Shanghai',
  });
  return { repo, service, settings, request, agent, complete, waitForStart, measurementContext, toolProfileSnapshot, budgetSummary,
    captured: () => captured, profilesRead: () => profilesRead };
}

test('P3 RuntimeService freezes configured policy and profiles once and projects the live budget', async () => {
  const c = await fixture();
  const accepted = await c.service.submitAgent(c.request, { instanceId: 'instance', operationRef: 'submit' });
  if (!accepted.ok) throw accepted.error;
  await c.waitForStart;
  const runId = accepted.data.runId;
  expect(c.profilesRead()).toBe(1);
  expect(c.captured()).toMatchObject({ toolConfiguration: c.settings.toolConfiguration, agentPolicy: c.settings.agentPolicy, measurementContext: c.measurementContext, toolProfileSnapshot: c.toolProfileSnapshot });
  expect(c.repo.read({ runId })).toMatchObject({ kind: 'one', run: { control: { agentPolicy: c.settings.agentPolicy, measurementContext: c.measurementContext, toolProfileSnapshot: c.toolProfileSnapshot } } });
  expect(await c.service.readControl()).toMatchObject({ ok: true, data: { budget: { runId, toolCalls: { limit: 200, used: 3 } } } });
  c.settings.agentPolicy.maxToolCalls = 999;
  c.settings.runtimeConfiguration.runBudget.maxToolCalls = 999;
  c.settings.toolConfiguration.maxResultBytes = 1024;
  c.toolProfileSnapshot.available = false;
  expect(c.captured()?.agentPolicy?.maxToolCalls).toBe(200);
  expect(c.captured()?.runtimeConfiguration?.runBudget.maxToolCalls).toBe(200);
  expect(c.service.bindQueryContext('query-form', c.repo.readWorkspace().revision)).not.toHaveProperty('toolConfiguration');
  expect(c.captured()?.toolProfileSnapshot?.available).toBe(true);
  expect(await c.service.submitAgent(c.request, { instanceId: 'instance', operationRef: 'submit' })).toEqual(accepted);
  expect(c.profilesRead()).toBe(1);
  c.complete();
  await c.service.shutdown();
  expect(c.repo.read({ runId })).toMatchObject({ kind: 'one', run: { cleanup: { budgetSummary: c.budgetSummary } } });
  expect(await c.service.readControl()).toMatchObject({ ok: true, data: { budget: null } });
});

test('P3 statistics read failure does not block Run admission or fabricate a profile', async () => {
  const c = await fixture();
  expect(await c.service.readControl()).toMatchObject({ ok: true, data: { budget: null } });
  c.agent.captureToolProfiles = () => { throw new Error('Fixture statistics read failed'); };
  const accepted = await c.service.submitAgent(c.request, { instanceId: 'instance', operationRef: 'submit' });
  if (!accepted.ok) throw accepted.error;
  await c.waitForStart;
  expect(c.captured()?.agentPolicy).toEqual(c.settings.agentPolicy);
  expect(c.captured()?.measurementContext).toBeUndefined();
  expect(c.captured()?.toolProfileSnapshot).toBeUndefined();
  expect(c.repo.read({ runId: accepted.data.runId })).toMatchObject({ kind: 'one', run: { control: {
    agentPolicy: c.settings.agentPolicy, measurementContext: null, toolProfileSnapshot: null,
  } } });
  c.complete();
});

test('P3 manual Query context has a trusted synchronous deadline check', async () => {
  const c = await fixture();
  const accepted = await c.service.submitAgent(c.request, { instanceId: 'instance', operationRef: 'submit' });
  if (!accepted.ok) throw accepted.error;
  await c.waitForStart;
  const context = c.service.bindQueryContext('query-form', c.repo.readWorkspace().revision);
  expect(context.checkActive).toBeFunction();
  const monotonic = spyOn(performance, 'now').mockReturnValue(c.captured()!.deadlineAt + 1);
  try {
    let failure: unknown;
    try { context.checkActive?.(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'run_timeout' });
    expect(context.signal.aborted).toBe(true);
  } finally { monotonic.mockRestore(); c.complete(); }
});

test('P3 large total deadlines use bounded timer chunks without an immediate deadline abort', async () => {
  const c = await fixture(2147483648 + 1000);
  const timeout = spyOn(globalThis, 'setTimeout');
  try {
    const accepted = await c.service.submitAgent(c.request, { instanceId: 'instance', operationRef: 'submit' });
    if (!accepted.ok) throw accepted.error;
    await c.waitForStart;
    expect(timeout.mock.calls[0]?.[1]).toBeLessThanOrEqual(2147483647);
    expect(c.captured()?.signal.aborted).toBe(false);
  } finally { timeout.mockRestore(); c.complete(); }
});
