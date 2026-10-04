import { expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { TOOL_CONFIG, type ToolConfiguration } from '../../packages/contracts/src/tool-config';
import type { PageInput } from '../../packages/contracts/src/query';
import type { ToolExecutionContext } from '../../packages/contracts/src/tool';
import { PositiveIdSchema } from '../../packages/contracts/src/error';
import { createBusinessToolSchemas } from '../../packages/contracts/src/business-tools';
import { RunScopeSchema } from '../../packages/contracts/src/run';
import { WorkspaceContextSchema } from '../../packages/contracts/src/workspace';
import { PiAgentRuntime } from '../../packages/runtime-pi/src/agent-runtime';
import { PiModelRuntime } from '../../packages/runtime-pi/src/model-runtime';
import { ToolRegistry } from '../../packages/core/src/tools/registry';
import { ToolExecutor } from '../../packages/core/src/tools/executor';
import { ToolRecorder } from '../../packages/core/src/tools/recorder';
import { initializeToolStorage, SqliteToolStore } from '../../packages/storage/src/tool-store';

test('Pi session freezes result limits and rebuilds only for actual tool Schema changes while preserving history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-session-config-')), db = new Database(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id INTEGER PRIMARY KEY);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,session_id INTEGER REFERENCES sessions(id),status TEXT,scope_json TEXT,workspace_json TEXT,reference_date TEXT,timezone TEXT,UNIQUE(id,session_id));
    INSERT INTO sessions VALUES(1);`);
  initializeToolStorage(db);
  const requests: Record<string, unknown>[] = [], observed: { ceiling: number; pageSize: number; contextCeiling: number }[] = [];
  const first: ToolConfiguration = structuredClone(TOOL_CONFIG);
  first.maxResultBytes = 1024;
  let schemaVersion = 1;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>);
    if (requests.length === 1) first.maxResultBytes = 9999;
    const call = requests.length % 2 === 1;
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: 'read_data_scope', arguments: '{}' } }] }
      : { role: 'assistant', content: 'Done' };
    return new Response(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  let agent: PiAgentRuntime | undefined;
  try {
    const credentials = new InMemoryCredentialStore(); await credentials.modify('session-config', async () => ({ type: 'api_key', key: 'fixture' }));
    const runtime = await PiModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore() });
    await runtime.installCustom([{ providerId: 'session-config', name: 'Fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`,
      models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] }]);
    const store = new SqliteToolStore(db), recorder = new ToolRecorder(store);
    const configure = (configuration: ToolConfiguration) => {
      const registry = new ToolRegistry([{ name: 'read_data_scope', version: '1.0.0', label: 'Read accepted settings', description: 'Read the accepted configuration for an engineering fixture.', effect: 'READ', executionMode: 'parallel',
        inputSchema: createBusinessToolSchemas().list_batches.input.describe(`Fixture schema ${schemaVersion}`), outputSchema: PositiveIdSchema,
        execute: async (input: PageInput, context: ToolExecutionContext) => { observed.push({ ceiling: configuration.maxResultBytes, pageSize: input.pageSize, contextCeiling: context.toolConfiguration!.maxResultBytes }); return configuration.maxResultBytes; } }]);
      return { registry, executor: new ToolExecutor(registry, recorder) };
    };
    agent = new PiAgentRuntime(runtime, root, { ...configure(TOOL_CONFIG), recorder, configure });
    const native = agent.allocate(); native.bind(1);
    const nativeSessionId = native.nativeSessionId;
    const scope = RunScopeSchema.parse({ batchIds: [], deviceIds: null, allowedToolNames: agent.toolNames, allowedResourceRefs: [], artifactIds: [], readOnly: true });
    const workspaceContext = WorkspaceContextSchema.parse({ revision: 1, sessionId: 1, materialVersion: null,
      batchRefs: [], deviceIds: [], queryId: null, activeView: 'data', selection: null });
    const resolved = await runtime.resolve({ provider: 'session-config', modelId: 'fixture', expectedConfigVersion: '1' }, '1', null, { timeoutMs: 10000, maxRetries: 0, maxRetryDelayMs: 2000 });
    let runId = 0;
    const execute = async (configuration: ToolConfiguration, controller = new AbortController()) => {
      db.query("INSERT INTO runs VALUES(?,1,'running',?,?,'2026-01-01','Asia/Shanghai')").run(++runId, JSON.stringify(scope), JSON.stringify(workspaceContext));
      return agent!.execute({ runId, sessionId: 1, text: `run-${runId}`, resolved, agentOptions: agent!.describe(resolved), scope, workspaceContext, referenceDate: '2026-01-01', timezone: 'Asia/Shanghai', toolConfiguration: configuration,
        signal: controller.signal, deadlineAt: performance.now() + 10000 }, { startCall: () => ({ finish: (outcome, endedAt) => ({ callId: `run-${runId}-call`, state: outcome.callState, responseModel: outcome.responseModel, sdkStopReason: outcome.sdkStopReason === 'pending' ? null : outcome.sdkStopReason, endedAt, durationMs: 1, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, cost: outcome.usage.cost, costCurrency: outcome.usage.costCurrency, usageSource: outcome.usage.source, unavailableReason: outcome.usage.unavailableReason, error: outcome.error }) }), preview: () => {}, nativeTerminal: () => {} });
    };
    const binding = () => (Reflect.get(agent!, 'sessions') as Map<number, { session: AgentSession; manager: { getSessionId(): string } }>).get(1)!;
    expect((await execute(first)).lastOutcome).toMatchObject({ text: 'Done', error: null });
    expect(observed[0]).toEqual({ ceiling: 1024, pageSize: 50, contextCeiling: 1024 });
    const initialSession = binding().session;
    const second = { ...TOOL_CONFIG, maxResultBytes: 2048 };
    expect((await execute(second)).lastOutcome?.error).toBeNull();
    expect(binding().session).toBe(initialSession);
    expect(observed[1]).toEqual({ ceiling: 2048, pageSize: 50, contextCeiling: 2048 });
    const third = { ...TOOL_CONFIG, maxResultBytes: 3072 }; schemaVersion = 2;
    expect((await execute(third)).lastOutcome?.error).toBeNull();
    expect(binding().session).not.toBe(initialSession);
    expect(binding().manager.getSessionId()).toBe(nativeSessionId);
    expect(observed[2]).toEqual({ ceiling: 3072, pageSize: 50, contextCeiling: 3072 });
    expect(JSON.stringify(requests[4]!.messages)).toContain('run-1');
    expect(JSON.stringify(requests[4]!.messages)).toContain('run-2');
    expect(agent.read(1).messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['run-1', 'run-2', 'run-3']);
    const thirdSession = binding().session, fourth = { ...TOOL_CONFIG, maxResultBytes: 4096 };
    expect((await execute(fourth)).lastOutcome?.error).toBeNull();
    expect(binding().session).toBe(thirdSession);
    const preserved = binding().session, cancel = new AbortController(), cancelled = structuredClone(fourth); schemaVersion = 3;
    const setModel = AgentSession.prototype.setModel;
    let candidateDisposal: ReturnType<typeof spyOn<AgentSession, 'dispose'>> | undefined;
    const replacement = spyOn(AgentSession.prototype, 'setModel').mockImplementationOnce(async function(this: AgentSession, ...args) {
      await setModel.apply(this, args); candidateDisposal = spyOn(this, 'dispose'); cancel.abort();
    });
    try { await execute(cancelled, cancel); } finally { replacement.mockRestore(); }
    expect(candidateDisposal).toHaveBeenCalledTimes(1);
    candidateDisposal?.mockRestore();
    expect(binding().session).toBe(preserved);
    expect(agent.read(1).available).toBe(true);
    schemaVersion = 2;
    expect((await execute(fourth)).lastOutcome?.error).toBeNull();
    expect(binding().session).toBe(preserved);
    expect(binding().manager.getSessionId()).toBe(nativeSessionId);
    expect(observed).toHaveLength(5);
    const captured = spyOn(recorder, 'readToolObservations');
    const profiles = agent.captureToolProfiles(scope);
    expect(captured.mock.calls[0]![0]).toMatchObject({ windowDays: 30, limit: 2000 });
    expect(profiles.toolProfileSnapshot).toMatchObject({ windowDays: 30, observationLimit: 2000 });
    captured.mockRestore();
  } finally {
    const sessions = agent && Reflect.get(agent, 'sessions') as Map<number, { session?: AgentSession }> | undefined;
    sessions?.get(1)?.session?.dispose();
    for (let runId = 1; runId <= 6; runId++) agent?.releaseToolFacts(runId);
    server.stop(true); db.close(); await rm(root, { recursive: true, force: true });
  }
}, 15000);
