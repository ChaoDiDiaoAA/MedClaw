import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MainSettings } from '../../apps/desktop/src/main/settings';
import { BUSINESS_RULES } from '../../packages/contracts/src/query';
import { TOOL_READ_RULES } from '../../packages/contracts/src/tool';
import { RUN_CONTROL_RULES } from '../../packages/core/src/runtime/run-control';
import { TOOL_PROFILE_RULES } from '../../packages/core/src/tools/tool-profile';

test('Settings publishes eight mutable parameters, rejects conflicting aliases and restores its own previous snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p3-settings-config-'));
  try {
    const prepared: string[] = [];
    const settings = new MainSettings(join(root, 'settings.json'), { async prepare(_token, candidate) { prepared.push(candidate.configVersion); }, async commit() {}, async abort() {} });
    const initial = settings.read();
    const next = structuredClone(initial.runtimeConfiguration);
    next.runBudget.maxToolCalls = 10;
    next.runBudget.timeoutMs = 9000;
    next.llm.maxRetryDelayMs = 4000;
    const toolConfiguration = { maxResultBytes: 1024 };
    const published = await settings.publish('1', { runtimeConfiguration: next, toolConfiguration }, { kind: 'policy' });
    expect(published.runtimeConfiguration).toEqual(next);
    expect(published.toolConfiguration).toEqual(toolConfiguration);
    expect(published.agentPolicy.maxToolCalls).toBe(10);
    expect(published.requestPolicy.timeoutMs).toBe(9000);
    expect(published.previous?.toolConfiguration).toEqual(initial.toolConfiguration);
    await expect(settings.publish('2', { runtimeConfiguration: next, agentPolicy: initial.agentPolicy }, { kind: 'policy' })).rejects.toThrow('invalid_argument');
    await expect(settings.publish('1', { runtimeConfiguration: next }, { kind: 'policy' })).rejects.toThrow('config_conflict');
    expect(settings.read().configVersion).toBe('2');
    const legacyUpdate = await settings.publish('2', { agentPolicy: { ...published.agentPolicy, maxToolCalls: 13 } }, { kind: 'policy' });
    expect(legacyUpdate.runtimeConfiguration).toEqual({ ...next, runBudget: { ...next.runBudget, maxToolCalls: 13 } });
    expect(legacyUpdate.toolConfiguration).toEqual(toolConfiguration);
    const restored = await settings.publish('3', {}, { kind: 'rollback', targetConfigVersion: '2' });
    expect(restored.runtimeConfiguration).toEqual(next);
    expect(restored.toolConfiguration).toEqual(toolConfiguration);
    expect(restored.agentPolicy.maxToolCalls).toBe(10);
    expect(prepared).toEqual(['2', '3', '4']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('old six-group Settings stays raw on read and publishes or rolls back only the eight supported parameters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p3-legacy-settings-'));
  try {
    const path = join(root, 'settings.json');
    const settings = new MainSettings(path, { async prepare() {}, async commit() {}, async abort() {} });
    const { previous: _previous, rollbackFromVersion: _rollback, runtimeConfiguration: _runtime, toolConfiguration: _tool, ...initial } = settings.read();
    const previous = { ...initial, configVersion: '0', requestPolicy: { ...initial.requestPolicy, timeoutMs: 3000 }, agentPolicy: { ...initial.agentPolicy, maxToolCalls: 2 } };
    const current = { ...initial, requestPolicy: { ...initial.requestPolicy, timeoutMs: 9000 }, agentPolicy: { ...initial.agentPolicy, maxToolCalls: 7 } };
    const oldTools = (value: typeof current, maxResultBytes: number) => ({
      runtime: { maxCalls: value.agentPolicy.maxToolCalls, maxModelCalls: value.agentPolicy.maxModelCalls, maxTimeoutMs: value.requestPolicy.timeoutMs, singleToolTimeoutMs: value.agentPolicy.singleToolTimeoutMs, maxRecoveryAttempts: value.agentPolicy.maxRecoveryAttempts, maxResultBytes },
      scheduling: { ...RUN_CONTROL_RULES, timeoutMultiplier: 9 },
      statistics: { ...TOOL_PROFILE_RULES, percentile: 0.5 },
      native: { read: { offset: 7, limit: 2 }, grep: { limit: 2, context: 20, ignoreCase: true, literal: true }, find: { limit: 2 }, ls: { limit: 2 }, bash: { timeout: 2 }, powershell: { timeout: 2 } },
      business: { ...BUSINESS_RULES, defaultPageSize: 2, maxPageSize: 2, evidencePageSize: 2, querySort: 'desc' },
      presentation: { ...TOOL_READ_RULES, defaultPageSize: 2 },
    });
    const raw = JSON.stringify({ ...current, toolConfiguration: oldTools(current, 4096), previous: { ...previous, toolConfiguration: oldTools(previous, 2048) }, rollbackFromVersion: null });
    writeFileSync(path, raw);
    const decoded = settings.read();
    expect(readFileSync(path, 'utf8')).toBe(raw);
    expect(decoded.runtimeConfiguration.runBudget).toMatchObject({ maxToolCalls: 7, timeoutMs: 9000 });
    expect(decoded.previous?.runtimeConfiguration.runBudget).toMatchObject({ maxToolCalls: 2, timeoutMs: 3000 });
    expect(decoded.toolConfiguration).toEqual({ maxResultBytes: 4096 });
    expect(decoded.previous?.toolConfiguration).toEqual({ maxResultBytes: 2048 });
    const next = { ...decoded.runtimeConfiguration, runBudget: { ...decoded.runtimeConfiguration.runBudget, maxToolCalls: 10, timeoutMs: 12000 } };
    const published = await settings.publish('1', { runtimeConfiguration: next, toolConfiguration: { maxResultBytes: 8192 } }, { kind: 'policy' });
    expect(published.previous?.runtimeConfiguration).toEqual(decoded.runtimeConfiguration);
    expect(JSON.parse(readFileSync(path, 'utf8')).toolConfiguration).toEqual({ maxResultBytes: 8192 });
    const restored = await settings.publish('2', {}, { kind: 'rollback', targetConfigVersion: '1' });
    expect(restored.runtimeConfiguration).toEqual(decoded.runtimeConfiguration);
    expect(restored.toolConfiguration).toEqual({ maxResultBytes: 4096 });
    expect(restored.toolConfiguration).not.toHaveProperty('native');
    expect(restored.toolConfiguration).not.toHaveProperty('business');
    expect(restored.toolConfiguration).not.toHaveProperty('statistics');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
