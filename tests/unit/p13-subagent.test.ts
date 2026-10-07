import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStage } from '../run';
import { publicMethodSchemas, PublicHostRequestSchema, HOST_PROTOCOL_VERSION } from '../../packages/contracts/src/protocol';
import { safeError } from '../../packages/contracts/src/error';
import { ModelCallContextSchema, RegisterContextDeliveryInputSchema } from '../../packages/contracts/src/context';
import { ChildResultSchema, ChildResultViewSchema, BoundChildIdentitySchema } from '../../packages/contracts/src/subagent';

test('p13 runner rejects empty execution, required skips and discovery errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p13-runner-'));
  const directory = join(root, 'tests', 'unit');
  mkdirSync(directory, { recursive: true });
  try {
    expect(await runStage('unit', 'P13', { root })).toMatchObject({ executed: 0, exitCode: 1 });
    const file = join(directory, 'p13-probe.test.ts');
    writeFileSync(file, "import { test } from 'bun:test'; test.skip('required', () => {});");
    expect(await runStage('unit', 'P13', { root })).toMatchObject({ executed: 0, skip: 1, exitCode: 1 });
    writeFileSync(file, "import { test } from 'bun:test'; test('executed', () => {}); test.skip('required', () => {});");
    expect(await runStage('unit', 'P13', { root })).toMatchObject({ executed: 1, skip: 1, exitCode: 1 });
    writeFileSync(file, "throw new Error('ENGINEERING discovery failure');");
    expect((await runStage('unit', 'P13', { root })).exitCode).toBe(1);
    writeFileSync(file, "import { test } from 'bun:test'; test('executed', () => {});");
    expect(await runStage('unit', 'P13', { root })).toMatchObject({ discovered: 1, executed: 1, pass: 1, skip: 0, exitCode: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('p13 public child reads bind the child owner and reject mixed user or parent selection identities', () => {
  const history = publicMethodSchemas['session.messages.read'].input;
  expect(history.safeParse({ childRunId: 9 }).success).toBe(true);
  expect(history.safeParse({ childRunId: 9, sessionId: 1 }).success).toBe(false);
  expect(history.safeParse({ sessionId: 1 }).success).toBe(true);
  expect(history.safeParse({ childRunId: 0 }).success).toBe(false);
  const runs = publicMethodSchemas['run.read'].input;
  expect(runs.safeParse({ recent: true, parentRunId: 3 }).success).toBe(true);
  expect(runs.safeParse({ recent: true, parentRunId: 3, sessionId: 1 }).success).toBe(false);
  expect(runs.safeParse({ recent: true, parentRunId: 3, kind: 'agent' }).success).toBe(false);
  const frame = { protocolVersion: HOST_PROTOCOL_VERSION, kind: 'request', requestId: 'read_child', instanceId: 'host', operationRef: 'read', method: 'run.read', payload: { recent: true, parentRunId: 3 } };
  expect(PublicHostRequestSchema.safeParse(frame).success).toBe(true);
  expect(PublicHostRequestSchema.safeParse({ ...frame, protocolVersion: 'medclaw.host/p12-v1' }).success).toBe(false);
});

test('p13 committed execution delivery failure stays safe and cannot trigger automatic execution retry', () => {
  const error = safeError('tool_delivery_failed', new Error('ENGINEERING private payload'), { runId: 3, sessionId: 1 });
  expect(error).toMatchObject({ code: 'tool_delivery_failed', category: 'tool', retryable: false, runId: 3, sessionId: 1 });
  expect(error.message).not.toContain('private payload');
  for (const reason of ['subagent_binding_failed', 'subagent_limit', 'subagent_execution_failed'] as const) {
    expect(safeError(reason === 'subagent_limit' ? 'state_conflict' : 'internal_error', undefined, { runId: 3, reason })).toHaveProperty('reason', reason);
  }
});

test('p13 model context keeps positive user input distinct from null delegated input', () => {
  const base = { contract: 'medclaw.context-call/v1', snapshotId: 4, observation: null, responseStatus: null, payloadVerified: null };
  const source = { parentRunId: 1, originToolCallId: 2, parentSnapshotId: 3, parentInputId: 4, promptHash: 'a'.repeat(64), nativeEntryId: 'child-prompt' };
  expect(ModelCallContextSchema.safeParse({ ...base, inputId: 4 }).success).toBe(true);
  expect(ModelCallContextSchema.safeParse({ ...base, inputId: null, delegationSource: source }).success).toBe(true);
  expect(ModelCallContextSchema.safeParse({ ...base, inputId: null }).success).toBe(false);
  expect(ModelCallContextSchema.safeParse({ ...base, inputId: 4, delegationSource: source }).success).toBe(false);
  expect(ModelCallContextSchema.safeParse({ ...base, inputId: 0 }).success).toBe(false);
  // Source identity cannot replace the child owner at an HTTP delivery boundary.
  expect(RegisterContextDeliveryInputSchema.safeParse({ runId: 9, sessionId: 10, inputId: null, delegationSource: source, callId: 'call', snapshotId: 11, observation: {} }).success).toBe(false);
});

test('p13 committed child JSON retains original reply only internally and rejects forged user identity or executable values', () => {
  const identity = { instanceId: 'host', parentRunId: 1, parentSessionId: 2, originToolCallId: 3, originNativeToolCallId: 'original-call', pluginAgentId: 'plugin-child', nativeSessionId: 'native-child', childRunId: 4, childSessionId: 5 };
  expect(BoundChildIdentitySchema.safeParse(identity).success).toBe(true);
  expect(BoundChildIdentitySchema.safeParse({ ...identity, childSessionId: 2 }).success).toBe(false);
  const result = { contract: 'medclaw.child-result/v1', childRunId: 4, childSessionId: 5, parentRunId: 1, originToolCallId: 3, pluginAgentId: 'plugin-child', nativeSessionId: 'native-child', outcome: 'failed', text: '', queryRefs: [], evidenceIds: [], gaps: ['ENGINEERING failed'], truncated: false, originalReply: { content: [{ type: 'text', text: 'original reply' }], details: {} }, originalReplyHash: 'a'.repeat(64), finalLeafId: null, storageVersion: 1, committedAt: '2026-10-07T00:00:00.000Z' };
  expect(ChildResultSchema.safeParse(result).success).toBe(true);
  const { originalReply, ...view } = result;
  expect(ChildResultViewSchema.safeParse(view).success).toBe(true);
  expect(ChildResultViewSchema.safeParse(result).success).toBe(false);
  expect(ChildResultSchema.safeParse({ ...result, inputId: 1 }).success).toBe(false);
  expect(ChildResultSchema.safeParse({ ...result, originalReply: { ...originalReply, details: { action: () => {} } } }).success).toBe(false);
  expect(ChildResultSchema.safeParse({ ...result, queryRefs: [{ queryId: 1, resultHash: 'b'.repeat(64) }, { queryId: 1, resultHash: 'b'.repeat(64) }] }).success).toBe(false);
});
