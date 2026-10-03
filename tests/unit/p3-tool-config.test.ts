import { describe, expect, test } from 'bun:test';
import { DEFAULT_AGENT_POLICY, DEFAULT_REQUEST_POLICY, PublishedSettingsSchema, SettingsSnapshotSchema, ToolProfileSchema } from '../../packages/contracts/src/model';
import { createPublicMethodSchemas, publicMethodSchemas } from '../../packages/contracts/src/protocol';
import { TOOL_CONFIG, StoredToolConfigurationSchema, ToolConfigurationSchema, normalizeToolConfiguration } from '../../packages/contracts/src/tool-config';
import { RUNTIME_CONFIG, RuntimeConfigurationSchema, mergeRuntimeConfigurationPolicies, normalizeRuntimeConfiguration } from '../../packages/contracts/src/runtime-config';

const legacy = {
  schemaVersion: 'medclaw.settings/p1-v1',
  configVersion: '1',
  model: null,
  customProviders: [],
  credentialRefs: {},
  requestPolicy: { ...DEFAULT_REQUEST_POLICY, timeoutMs: 8000 },
  agentPolicy: { ...DEFAULT_AGENT_POLICY, maxToolCalls: 7, maxRecoveryAttempts: 0 },
};
const oldToolConfiguration = {
  runtime: { maxCalls: 7, maxModelCalls: 12, maxTimeoutMs: 8000, singleToolTimeoutMs: 30000, maxResultBytes: 4096, maxRecoveryAttempts: 0 },
  scheduling: { callConvergenceRatio: 0.75, remainingTimeConvergenceRatio: 0.25, answerReserveMaxMs: 10000, answerReserveRatio: 0.1, readTimeoutFloorMs: 1000, workTimeoutFloorMs: 5000, timeoutMultiplier: 2 },
  statistics: { windowDays: 30, observationLimit: 2000, perGroupLimit: 50, minimumCompleteSamples: 20, percentile: 0.95, timeoutRateFallback: 0.2, batchCountBounds: [1, 31], timeSpanDaysBounds: [1, 31], pageSizeBounds: [100, 500], nativeInputBytesBounds: [4096, 65536] },
  native: { read: { offset: 1, limit: null }, grep: { limit: 100, context: 0, ignoreCase: false, literal: false }, find: { limit: 1000 }, ls: { limit: 500 }, bash: { timeout: null }, powershell: { timeout: null } },
  business: { defaultPage: 1, defaultPageSize: 50, maxPage: 100000, maxPageSize: 500, maxSavedRows: 100000, maxTimeSpanDays: 366, maxBatchIds: 10000, maxDeviceIds: 10000, maxRegionLength: 256, maxFilterTextLength: 512, maxDeviceSearchLength: 512, querySnapshotMode: 'exact_date', querySort: 'asc', coverageSnapshotMode: 'exact_date', coverageRequirePredecessor: false, resolveMatchBy: 'name', maxTopN: 100, evidenceSummaryLimit: 500, evidencePageSize: 100 },
  presentation: { defaultPage: 1, defaultPageSize: 20, maxPageSize: 50, inputPreviewChars: 8192, resultPreviewChars: 16384 },
};

describe('P3 minimal runtime and tool configuration', () => {
  test('normalizes current and previous legacy policies independently', () => {
    const result = PublishedSettingsSchema.parse({ ...legacy, previous: { ...legacy, requestPolicy: { ...legacy.requestPolicy, timeoutMs: 3000 }, agentPolicy: { ...legacy.agentPolicy, maxToolCalls: 2 } }, rollbackFromVersion: null });
    expect(result).toHaveProperty('runtimeConfiguration.runBudget.maxToolCalls', 7);
    expect(result).toHaveProperty('runtimeConfiguration.runBudget.timeoutMs', 8000);
    expect(result.previous).toHaveProperty('runtimeConfiguration.runBudget.maxToolCalls', 2);
    expect(result.previous).toHaveProperty('runtimeConfiguration.runBudget.timeoutMs', 3000);
    expect(result.toolConfiguration).toEqual(TOOL_CONFIG);
  });

  test('rejects explicit alias conflicts while projecting omitted aliases', () => {
    const configuration = structuredClone(RUNTIME_CONFIG);
    configuration.runBudget.maxToolCalls = 9;
    const { agentPolicy: _agentPolicy, requestPolicy: _requestPolicy, ...withoutPolicies } = legacy;
    expect(SettingsSnapshotSchema.parse({ ...withoutPolicies, runtimeConfiguration: configuration })).toHaveProperty('agentPolicy.maxToolCalls', 9);
    expect(SettingsSnapshotSchema.safeParse({ ...legacy, runtimeConfiguration: configuration }).success).toBe(false);
    expect(() => normalizeRuntimeConfiguration({ toolConfiguration: oldToolConfiguration, agentPolicy: DEFAULT_AGENT_POLICY })).toThrow();
  });

  test('exposes only five Run budget fields, two LLM fields and the result limit', () => {
    expect(Object.keys(RUNTIME_CONFIG.runBudget)).toHaveLength(5);
    expect(Object.keys(RUNTIME_CONFIG.llm)).toHaveLength(2);
    expect(Object.keys(TOOL_CONFIG)).toEqual(['maxResultBytes']);
    expect(RuntimeConfigurationSchema.parse(RUNTIME_CONFIG)).toEqual(RUNTIME_CONFIG);
    expect(ToolConfigurationSchema.parse(TOOL_CONFIG)).toEqual(TOOL_CONFIG);
    expect(RuntimeConfigurationSchema.safeParse({ ...RUNTIME_CONFIG, scheduling: {} }).success).toBe(false);
    expect(ToolConfigurationSchema.safeParse(oldToolConfiguration).success).toBe(false);
    expect(ToolConfigurationSchema.safeParse({ maxResultBytes: 1023 }).success).toBe(false);
    expect(RuntimeConfigurationSchema.safeParse({ ...RUNTIME_CONFIG, runBudget: { ...RUNTIME_CONFIG.runBudget, maxToolCalls: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false);
    expect(RuntimeConfigurationSchema.safeParse({ ...RUNTIME_CONFIG, llm: { maxRetries: 2, maxRetryDelayMs: 2000 } }).success).toBe(false);
    expect(RuntimeConfigurationSchema.safeParse({ ...RUNTIME_CONFIG, llm: { maxRetries: 1, maxRetryDelayMs: 5001 } }).success).toBe(false);
  });

  test('decodes an old full configuration without making removed options active', () => {
    const settings = SettingsSnapshotSchema.parse({ ...legacy, toolConfiguration: oldToolConfiguration });
    expect(settings.toolConfiguration).toEqual({ maxResultBytes: 4096 });
    expect(settings.runtimeConfiguration.runBudget).toEqual({ maxToolCalls: 7, maxModelCalls: 12, timeoutMs: 8000, singleToolTimeoutMs: 30000, maxRecoveryAttempts: 0 });
    expect(JSON.stringify(StoredToolConfigurationSchema.parse(oldToolConfiguration))).toBe(JSON.stringify(oldToolConfiguration));
    expect(normalizeToolConfiguration({ toolConfiguration: oldToolConfiguration })).toEqual({ maxResultBytes: 4096 });
    expect(oldToolConfiguration.native.grep.limit).toBe(100);
  });

  test('uses fixed tool record paging and rejects unsafe offsets before SQLite', () => {
    const input = createPublicMethodSchemas()['tool.read'].input;
    expect(input.parse({ runId: 1 })).toEqual({ runId: 1, page: 1, pageSize: 20 });
    expect(input.safeParse({ runId: 1, pageSize: 51 }).success).toBe(false);
    expect(input.safeParse({ runId: 1, page: Number.MAX_SAFE_INTEGER, pageSize: 2 }).success).toBe(false);
  });

  test('updates aliases against the frozen current runtime without modifying it', () => {
    const current = SettingsSnapshotSchema.parse(legacy);
    const merged = mergeRuntimeConfigurationPolicies(current, { agentPolicy: { ...current.agentPolicy, maxToolCalls: 11 } });
    expect(merged.runtimeConfiguration.runBudget.maxToolCalls).toBe(11);
    expect(merged.runtimeConfiguration.runBudget.timeoutMs).toBe(8000);
    expect(current.runtimeConfiguration.runBudget.maxToolCalls).toBe(7);
    expect(() => mergeRuntimeConfigurationPolicies(current, { runtimeConfiguration: RUNTIME_CONFIG, agentPolicy: current.agentPolicy })).toThrow();
  });

  test('accepts full configuration updates without injecting omitted policy aliases', () => {
    const parsed = publicMethodSchemas['model.policy.update'].input.parse({ expectedConfigVersion: '1', runtimeConfiguration: RUNTIME_CONFIG, toolConfiguration: TOOL_CONFIG });
    expect(parsed).toHaveProperty('runtimeConfiguration', RUNTIME_CONFIG);
    expect(parsed).not.toHaveProperty('policy');
    expect(parsed).not.toHaveProperty('agentPolicy');
    expect(publicMethodSchemas['model.policy.update'].input.safeParse({ expectedConfigVersion: '1' }).success).toBe(false);
  });

  test('reports actual old quantiles without relabeling them P95', () => {
    const profile = { name: 'read', version: '1', sdkVersion: '1', measurementVersion: '1', environmentKey: 'test', workloadBucket: 'small', sampleCount: 20, completeSamples: 20, p95Ms: 400, timeoutRate: 0, reliability: {} };
    expect(ToolProfileSchema.parse(profile).p95Ms).toBe(400);
    expect(ToolProfileSchema.parse({ ...profile, p95Ms: null, percentile: 0.9, latencyQuantileMs: 300 })).toHaveProperty('latencyQuantileMs', 300);
    expect(ToolProfileSchema.safeParse({ ...profile, percentile: 0.9, latencyQuantileMs: 300 }).success).toBe(false);
  });
});
