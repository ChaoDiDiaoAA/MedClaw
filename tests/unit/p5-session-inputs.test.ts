import { expect, test } from 'bun:test';
import * as contracts from '../../packages/contracts/src/session';
import { HOST_PROTOCOL_VERSION, DATABASE_SCHEMA_VERSION, isReadOnlyMethod, publicMethodSchemas, HostHelloSchema, HostReadySchema, HostRequestSchema, HostReplySchema } from '../../packages/contracts/src/protocol';
import { safeError } from '../../packages/contracts/src/error';
import { SessionMessageViewSchema } from '../../packages/contracts/src/messages';
import { ModelCallViewSchema, safePreview } from '../../packages/contracts/src/run';
import { discoverTests, runStage } from '../run';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const submit = { clientSequence: 1, sessionId: 1, text: 'hello', mode: 'send', expectedRevision: 0, expectedBatchIds: [], expectedQueryId: null, model: { provider: 'fixture', modelId: 'fixture', expectedConfigVersion: '0' }, referenceDate: '2026-10-03', timezone: 'Asia/Shanghai' };
const input = { id: 1, sessionId: 1, clientSequence: 1, mode: 'send', text: 'hello', textInfo: { totalChars: 5, truncated: false }, workspaceContext: null, status: 'queued', processingStatus: 'pending', targetRunId: 1, runId: null, nativeEntryId: null, deliveredAt: null, processedAt: null, createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', error: null };
test('P5 strict submission identity and mode union', () => {
 expect(contracts.SubmitInputSchema.safeParse(submit).success).toBe(true);
 for (const mode of ['steer', 'follow_up']) { expect(contracts.SubmitInputSchema.safeParse({ ...submit, mode }).success).toBe(false); expect(contracts.SubmitInputSchema.safeParse({ ...submit, mode, targetRunId: 1 }).success).toBe(true); }
 expect(contracts.SubmitInputSchema.safeParse({ ...submit, targetRunId: 1 }).success).toBe(false);
 for (const clientSequence of [0, -1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) expect(contracts.SubmitInputSchema.safeParse({ ...submit, clientSequence }).success).toBe(false);
 expect(contracts.SubmitResultSchema.safeParse({ sessionId: 1, clientSequence: 1, inputId: 1, runId: null }).success).toBe(true);
 expect(contracts.SubmitResultSchema.safeParse({ sessionId: 1, clientSequence: 1, inputId: null, runId: null }).success).toBe(false);
});
test('P5 input selectors and list defaults', () => {
 expect(contracts.ReadInputRequestSchema).toBeDefined();
 for (const value of [{}, { inputId: 1, sessionId: 1, clientSequence: 1 }, { inputId: 0 }, { sessionId: 1 }]) expect(contracts.ReadInputRequestSchema.safeParse(value).success).toBe(false);
 expect(contracts.ListInputsRequestSchema.parse({ sessionId: 1 })).toEqual({ sessionId: 1, afterClientSequence: null, limit: 50 });
 for (const value of [{ inputId: Number.MAX_SAFE_INTEGER + 1 }, { sessionId: -1, clientSequence: 1 }]) expect(contracts.ReadInputRequestSchema.safeParse(value).success).toBe(false);
 for (const limit of [0, 101]) expect(contracts.ListInputsRequestSchema.safeParse({ sessionId: 1, limit }).success).toBe(false);
});
test('P5 delivery and processing combinations require consumption evidence', () => {
 expect(contracts.SessionInputSchema).toBeDefined();
 for (const status of ['queued', 'consumed', 'failed', 'cancelled', 'delivery_unknown']) for (const processingStatus of ['pending', 'completed', 'failed', 'cancelled']) {
  const allowed = new Set(['queued/pending', 'consumed/pending', 'consumed/completed', 'consumed/failed', 'consumed/cancelled', 'failed/failed', 'cancelled/cancelled', 'delivery_unknown/pending', 'delivery_unknown/failed', 'delivery_unknown/cancelled']);
  const valid = allowed.has(`${status}/${processingStatus}`);
  const value = { ...input, status, processingStatus, processedAt: processingStatus === 'pending' ? null : input.updatedAt, runId: status === 'consumed' ? 1 : null, nativeEntryId: status === 'consumed' ? 'entry-1' : null };
  expect(contracts.SessionInputSchema.safeParse(value).success).toBe(valid);
 }
 expect(contracts.SessionInputSchema.safeParse({ ...input, status: 'consumed' }).success).toBe(false);
 expect(contracts.SessionInputSchema.safeParse({ ...input, status: 'failed', processingStatus: 'failed' }).success).toBe(false);
});
test('P5 safe UTF16 preview and UTF8 page budget', () => {
 expect(safePreview('a'.repeat(8191) + '😀', 8192).text.length).toBe(8191);
 expect(contracts.SessionInputSchema).toBeDefined();
 expect(contracts.SessionInputSchema.safeParse({ ...input, text: 'x'.repeat(8193) }).success).toBe(false);
 const item = { ...input, text: '\u0000'.repeat(8192), textInfo: { totalChars: 8192, truncated: false } };
 expect(contracts.SessionInputPageSchema.safeParse({ sessionId: 1, items: Array.from({ length: 100 }, (_, index) => ({ ...item, id: index + 1, clientSequence: index + 1 })), nextClientSequence: null, hasMore: false }).success).toBe(false);
});
test('P5 protocol constants and explicit read classification', () => {
 expect(HOST_PROTOCOL_VERSION).toBe('medclaw.host/p7-v1'); expect(DATABASE_SCHEMA_VERSION).toBe(5);
 for (const method of ['session.readInput', 'session.listInputs']) expect(isReadOnlyMethod(method)).toBe(true);
 expect(isReadOnlyMethod('session.cancelInput')).toBe(false);
 expect(publicMethodSchemas['session.cancelInput']).toBeDefined();
});
test('P5 runner discovers stage and rejects zero execution', async () => {
 const root = mkdtempSync(join(tmpdir(), 'medclaw-p5-contracts-'));
 try {
  expect(() => discoverTests('unit', 'UNKNOWN', root)).toThrow('Unknown test stage');
  expect((await runStage('unit', 'P5', { root })).exitCode).toBe(1);
  mkdirSync(join(root, 'tests', 'unit'), { recursive: true });
  writeFileSync(join(root, 'tests', 'unit', 'p5-empty.test.ts'), 'export {};');
  const empty = await runStage('unit', 'P5', { root }); expect(empty.executed).toBe(0); expect(empty.exitCode).toBe(1);
  writeFileSync(join(root, 'tests', 'unit', 'p5-empty.test.ts'), "import { test, expect } from 'bun:test'; test('fixture', () => expect(1).toBe(1));");
  const result = await runStage('unit', 'P5', { root }); expect(result.discoveredFiles).toBe(1); expect(result.executed).toBe(1); expect(result.pass).toBe(1); expect(result.exitCode).toBe(0);
 } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);



test('P5 handshake requires exact protocol, schema and pinned SDK', () => {
 const ready = { protocolVersion: HOST_PROTOCOL_VERSION, instanceId: 'host-1', sdkVersion: '0.87.1', schemaVersion: DATABASE_SCHEMA_VERSION, configVersion: '0', dataRoot: 'C:/fixture' };
 const hello = { protocolVersion: HOST_PROTOCOL_VERSION, instanceId: 'host-1', startupToken: 'token-1', sdkVersion: '0.87.1', expectedSchemaVersion: DATABASE_SCHEMA_VERSION,
 paths: { dataRoot: 'C:/fixture', databasePath: 'C:/fixture/db', settingsPath: 'C:/fixture/settings', cachePath: 'C:/fixture/cache', lockPath: 'C:/fixture/lock' } };
 expect(HostReadySchema.safeParse(ready).success).toBe(true); expect(HostHelloSchema.safeParse(hello).success).toBe(true);
 for (const protocolVersion of ['medclaw.host/p6-v1', 'medclaw.host/p5-v1', 'medclaw.host/p4-v1', 'medclaw.host/p3-v1']) { expect(HostReadySchema.safeParse({ ...ready, protocolVersion }).success).toBe(false); expect(HostHelloSchema.safeParse({ ...hello, protocolVersion }).success).toBe(false); }
 expect(HostReadySchema.safeParse({ ...ready, schemaVersion: 3 }).success).toBe(false);
 expect(HostHelloSchema.safeParse({ ...hello, sdkVersion: '0.87.2' }).success).toBe(false);
});
test('P5 input methods participate in request and reply frames', () => {
 for (const [method, payload, data] of [['session.readInput', { inputId: 1 }, null], ['session.listInputs', { sessionId: 1 }, { sessionId: 1, items: [], nextClientSequence: null, hasMore: false }], ['session.cancelInput', { inputId: 1 }, input]] as const) {
 const base = { protocolVersion: HOST_PROTOCOL_VERSION, instanceId: 'host-1', requestId: 'request-1', operationRef: 'operation-1', method };
 expect(HostRequestSchema.safeParse({ ...base, kind: 'request', payload }).success).toBe(true);
 expect(HostReplySchema.safeParse({ protocolVersion: HOST_PROTOCOL_VERSION, instanceId: 'host-1', requestId: 'request-1', kind: 'reply', result: { ok: true, data } }).success).toBe(true);
 }
});
test('P5 public errors keep fixed safe text and direct message input identities', () => {
 for (const code of ['input_not_found', 'input_delivery_unknown', 'input_cancel_unconfirmed', 'input_hook_handled']) {
  const error = safeError(code, new Error('SECRET'), { sessionId: 1 }); expect(error.code).toBe(code); expect(error.retryable).toBe(false); expect(JSON.stringify(error)).not.toContain('SECRET');
 }
 const message = { nativeEntryId: 'entry-1', parentEntryId: null, entryType: 'message', displayRole: 'user', text: 'hello', references: [], inputId: 1, runId: 1, toolCallRef: null, textInfo: { totalChars: 5, truncated: false, redacted: false } };
 expect(SessionMessageViewSchema.safeParse(message).success).toBe(true);
 expect(SessionMessageViewSchema.safeParse({ ...message, displayRole: 'assistant' }).success).toBe(false);
});

// Public call projections must carry the root Input, including legacy null.
test('P5 model call exposes positive root input identity with legacy null', () => {
 expect(ModelCallViewSchema.shape.inputId).toBeDefined();
 expect(ModelCallViewSchema.shape.inputId.safeParse(1).success).toBe(true);
 expect(ModelCallViewSchema.shape.inputId.safeParse(null).success).toBe(true);
 expect(ModelCallViewSchema.shape.inputId.safeParse(0).success).toBe(false);
});
