import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { DEFAULT_AGENT_POLICY, type MeasurementContext, type ToolProfileSnapshot } from '../../packages/contracts/src/model';
import { RunCleanupRecordSchema, RuntimeBudgetViewSchema } from '../../packages/contracts/src/run';
import { SubmitInputSchema } from '../../packages/contracts/src/session';
import { ToolContextIdentitySchema } from '../../packages/contracts/src/tool';
import { RunControl } from '../../packages/core/src/runtime/run-control';

const roots: string[] = [];
const handles: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const now = '2026-10-02T00:00:00.000Z';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-control-storage-'));
  roots.push(root);
  const db = openDatabase(join(root, 'app.sqlite'));
  handles.push(db);
  const repo = new Repositories(db);
  const session = repo.createSession({ expectedWorkspaceRevision: 0 }, 'create', 'native', now).session;
  const workspace = repo.readWorkspace();
  const submission = SubmitInputSchema.parse({
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
  const input = {
    sessionId: session.id,
    inputId: null,
    text: submission.text,
    model: { provider: 'fixture', modelId: 'fixture', endpointRef: null, api: 'openai-completions', configVersion: '1', credentialRef: null,
      maxOutputTokens: 1024, capabilitySource: 'pi_catalog' as const, sdkVersion: '0.87.1' as const },
    policy: { timeoutMs: 120000, maxRetries: 0 as const, maxRetryDelayMs: 2000 },
    goal: 'answer' as const,
    workspace,
    scope: repo.freezeAgentScope(workspace, ['read_data_scope']),
    referenceDate: submission.referenceDate,
    timezone: submission.timezone,
    timeoutMs: 120000,
    agentOptions: { requestedThinkingLevel: 'off' as const, effectiveThinkingLevel: 'off' as const },
    submission: { operationRef: 'submit', originalSubmitInput: submission },
    instanceId: 'instance',
    createdAt: now,
  };
  return { repo, db, input };
}
const measurement: MeasurementContext = {
  version: 'medclaw.tool-measurement/v1',
  sdkVersion: '0.87.1',
  environmentKey: 'fixture',
  cutoffAt: now,
  maxToolCallId: null,
};
const profile: ToolProfileSnapshot = {
  version: 'medclaw.tool-profile/v1',
  cutoffAt: now,
  maxToolCallId: null,
  windowDays: 30,
  observationLimit: 2000,
  perGroupLimit: 50,
  minimumCompleteSamples: 20,
  available: true,
  profiles: [],
};

test('P3 Run saves policy and profile once, replays original submission, and does not backfill legacy JSON', () => {
  const { repo, db, input } = fixture();
  const agentPolicy = { ...DEFAULT_AGENT_POLICY, maxToolCalls: 200 };
  const { runId } = repo.registerAgent({ ...input, agentPolicy, measurementContext: measurement, toolProfileSnapshot: profile });
  const result = repo.read({ runId });
  expect(result.kind === 'one' && result.run?.kind === 'agent' ? result.run.control : null).toEqual({ agentPolicy, measurementContext: measurement, toolProfileSnapshot: profile });
  expect(repo.registerAgent({ ...input, agentPolicy: { ...agentPolicy, maxToolCalls: 10 } }).runId).toBe(runId);
  const saved = db.query<{ config_json: string }, [number]>('SELECT config_json FROM runs WHERE id=?').get(runId)!;
  const config = JSON.parse(saved.config_json);
  delete config.agentPolicy;
  delete config.measurementContext;
  delete config.toolProfileSnapshot;
  db.query('UPDATE runs SET config_json=? WHERE id=?').run(JSON.stringify(config), runId);
  const legacy = repo.read({ runId });
  expect(legacy.kind === 'one' && legacy.run?.kind === 'agent' ? legacy.run.control : 'wrong').toBeNull();
  expect(db.query<{ config_json: string }, [number]>('SELECT config_json FROM runs WHERE id=?').get(runId)!.config_json).toBe(JSON.stringify(config));
});

test('P3 cleanup merge and recent Run projection preserve an existing budget summary', () => {
  const { repo, input } = fixture();
  const { runId } = repo.registerAgent({ ...input, agentPolicy: DEFAULT_AGENT_POLICY, measurementContext: measurement, toolProfileSnapshot: profile });
  const budgetSummary = {
    version: 'medclaw.budget-summary/v1' as const,
    toolCalls: 2,
    modelCalls: 1,
    toolAdmissionsRejected: 0,
    modelAdmissionsRejected: 0,
    convergenceRequested: false,
    recoveryAttempts: 0,
    stopReason: null,
    unresolvedItems: [],
  };
  const cleanup = RunCleanupRecordSchema.parse({
    contract: 'medclaw.run-cleanup/v1',
    executionStarted: true,
    stopConfirmed: true,
    requiredPersistenceComplete: true,
    inputsSettled: true,
    resourcesReleased: true,
    unconfirmedItems: [],
    secondaryErrors: [],
    verifiedAt: now,
    budgetSummary,
  });
  repo.saveRunCleanup(runId, cleanup);
  const { budgetSummary: _budget, ...withoutBudget } = cleanup;
  repo.saveRunCleanup(runId, withoutBudget);
  const result = repo.read({ runId });
  expect(result.kind === 'one' ? result.run?.cleanup?.budgetSummary : null).toEqual(budgetSummary);
  const recent = repo.read({ recent: true });
  expect(recent.kind === 'recent' ? recent.runs[0]?.cleanupSummary?.budgetSummary : null).toEqual(budgetSummary);
});

test('P3 unresolved native call identities retain their full contract through active reads and cleanup storage', () => {
  const { repo, input } = fixture();
  const { runId } = repo.registerAgent({ ...input, agentPolicy: DEFAULT_AGENT_POLICY });
  const control = new RunControl({ runId, policy: DEFAULT_AGENT_POLICY, scope: input.scope, signal: new AbortController().signal,
    deadlineAt: performance.now() + 120000, totalTimeoutMs: 120000 });
  const ids = ['Call_A', 'call/1', 'X'.repeat(256)];
  for (const nativeToolCallId of ids) {
    expect(ToolContextIdentitySchema.safeParse({ runId, sessionId: input.sessionId, nativeToolCallId, scope: input.scope,
      referenceDate: input.referenceDate, timezone: input.timezone }).success).toBe(true);
    control.observeToolAttempt(nativeToolCallId, 'read_data_scope', {});
    control.noteFailure(nativeToolCallId, { code: 'tool_input_invalid', stage: 'sdk' });
  }
  expect(RuntimeBudgetViewSchema.parse(control.readBudget()).recovery.unresolvedItems).toEqual(ids);
  const cleanup = RunCleanupRecordSchema.parse({ contract: 'medclaw.run-cleanup/v1', executionStarted: true, stopConfirmed: true,
    requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: true, unconfirmedItems: [], secondaryErrors: [],
    verifiedAt: now, budgetSummary: control.summary() });
  repo.saveRunCleanup(runId, cleanup);
  const saved = repo.read({ runId });
  expect(saved.kind === 'one' ? saved.run?.cleanup?.budgetSummary?.unresolvedItems : null).toEqual(ids);
  const recent = repo.read({ recent: true });
  expect(recent.kind === 'recent' ? recent.runs[0]?.cleanupSummary?.budgetSummary?.unresolvedItems : null).toEqual(ids);
  expect(RuntimeBudgetViewSchema.safeParse({ ...control.readBudget(), recovery: { ...control.readBudget().recovery,
    unresolvedItems: ['x'.repeat(257)] } }).success).toBe(false);
  expect(RunCleanupRecordSchema.safeParse({ ...cleanup, budgetSummary: { ...control.summary(), unresolvedItems: [''] } }).success).toBe(false);
});
