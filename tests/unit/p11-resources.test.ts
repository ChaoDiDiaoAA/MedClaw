import { expect, test } from 'bun:test';
import { publicMethodSchemas, isReadOnlyMethod, HOST_PROTOCOL_VERSION, DATABASE_SCHEMA_VERSION, PublicHostRequestSchema } from '../../packages/contracts/src/protocol';
import { PublishedSettingsSchema, SETTINGS_SCHEMA_VERSION } from '../../packages/contracts/src/model';
import { InputContentSchema } from '../../packages/contracts/src/session';
import { createHash } from 'node:crypto';
import { contextModel } from '../fixtures/p8-context';
import { ModelCallContextSchema } from '../../packages/contracts/src/context';

const ref = { kind: 'skill' as const, id: 'query', version: 'v1', treeHash: 'a'.repeat(64) };
test('p11 resource routes validate managed identity and distinguish reads from configuration mutation', () => {
  const list = Reflect.get(publicMethodSchemas, 'resources.list'), read = Reflect.get(publicMethodSchemas, 'resources.read'), select = Reflect.get(publicMethodSchemas, 'resources.select');
  expect(list).toBeDefined(); expect(read).toBeDefined(); expect(select).toBeDefined();
  expect(list.input.safeParse({ source: 'selection', sessionId: 1 }).success).toBe(true);
  expect(list.input.safeParse({ source: 'run', runId: 3, sessionId: 1 }).success).toBe(false);
  expect(list.input.safeParse({ source: 'run', runId: 3, evidencePage: Number.MAX_SAFE_INTEGER, evidencePageSize: 100 }).success).toBe(false);
  expect(read.input.safeParse({ source: 'run', runId: 3, resourceRef: ref, file: 'SKILL.md' }).success).toBe(true);
  for (const file of ['../SKILL.md', '/etc/passwd', 'C:/secret', '\\\\server\\secret', 'a:stream', 'a\\b', 'a//b', './a', 'a\u0000b']) {
    expect(read.input.safeParse({ source: 'run', runId: 3, resourceRef: ref, file }).success).toBe(false);
  }
  const choice = { sessionId: 1, expectedConfigVersion: '1', selection: { prompt: null, skills: [ref] } };
  expect(select.input.safeParse(choice).success).toBe(true);
  expect(select.input.safeParse({ ...choice, selection: { prompt: ref, skills: [] } }).success).toBe(false);
  expect(select.input.safeParse({ ...choice, selection: { prompt: null, skills: [ref, { ...ref, version: 'v2' }] } }).success).toBe(false);
  expect(isReadOnlyMethod('resources.list')).toBe(true); expect(isReadOnlyMethod('resources.read')).toBe(true); expect(isReadOnlyMethod('resources.select')).toBe(false);
  const frame = { protocolVersion: 'medclaw.host/p11-v1', kind: 'request', requestId: 'r', instanceId: 'host', operationRef: 'resource', method: 'resources.select', payload: choice };
  expect(PublicHostRequestSchema.safeParse(frame).success).toBe(true);
  expect(PublicHostRequestSchema.safeParse({ ...frame, protocolVersion: 'medclaw.host/p10-v1' }).success).toBe(false);
  expect(HOST_PROTOCOL_VERSION).toBe('medclaw.host/p11-v1'); expect(DATABASE_SCHEMA_VERSION).toBe(11);
});

test('p11 resource HTTP observations cannot certify a different or incomplete expected payload', () => {
  const fact = { resourceRef: ref, originRunId: 1, file: null, kind: 'skill_index', inputId: null, nativeEntryId: null, toolCallId: null, contentHash: 'c'.repeat(64), coverage: 'index' };
  const payload = { payloadHash: 'd'.repeat(64), verified: [fact] };
  const observation = { contract: 'medclaw.context-observation/v1', api: 'openai-completions', transport: 'sse', observedAt: '2026-10-06T00:00:00.000Z', httpStatus: 200,
    projectionHash: 'e'.repeat(64), feedbackHash: 'f'.repeat(64), verifiedNativeRefs: [], resources: payload };
  const call = { contract: 'medclaw.context-call/v1', snapshotId: 1, inputId: 1, observation, responseStatus: 200, payloadVerified: true, resources: { expected: [fact], payload } };
  expect(ModelCallContextSchema.safeParse(call).success).toBe(true);
  expect(ModelCallContextSchema.safeParse({ ...call, resources: { expected: [fact], payload: { ...payload, verified: [] } }, observation: { ...observation, resources: { ...payload, verified: [] } } }).success).toBe(false);
  expect(ModelCallContextSchema.safeParse({ ...call, observation: { ...observation, resources: { ...payload, payloadHash: 'a'.repeat(64) } } }).success).toBe(false);
  expect(ModelCallContextSchema.safeParse({ ...call, responseStatus: 400 }).success).toBe(false);
});

test('p11 published settings retain per-session resources and reject malformed identities', () => {
  const base = { schemaVersion: SETTINGS_SCHEMA_VERSION, configVersion: '1', model: null, customProviders: [], credentialRefs: {}, previous: null, rollbackFromVersion: null };
  expect(PublishedSettingsSchema.parse(base).resources ?? { bySession: {} }).toEqual({ bySession: {} });
  const selected = { resources: { bySession: { '1': { prompt: null, skills: [ref] }, '2': { prompt: null, skills: [] } } } };
  expect(PublishedSettingsSchema.parse({ ...base, ...selected }).resources).toEqual(selected.resources);
  for (const key of ['0', '01', '-1', '9007199254740992']) expect(PublishedSettingsSchema.safeParse({ ...base, resources: { bySession: { [key]: { prompt: null, skills: [] } } } }).success).toBe(false);
});

test('p11 input content retains raw text separately from the hashed native receipt', () => {
  const request = { sessionId: 1, clientSequence: 1, text: 'raw', mode: 'send', expectedRevision: 1, expectedBatchIds: [], expectedQueryId: null,
    model: { provider: contextModel.provider, modelId: contextModel.modelId, expectedConfigVersion: '1' }, referenceDate: '2026-10-06', timezone: 'Asia/Shanghai' };
  const base = { contract: 'medclaw.session-input/v1', originalSubmitInput: request, text: 'raw', workspaceContext: { sessionId: 1, batchRefs: [], queryId: null, revision: 1, materialVersion: null, deviceIds: [], activeView: 'data', selection: null },
    scope: { batchIds: [], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true }, model: contextModel, referenceDate: request.referenceDate, timezone: request.timezone, deliveryAttempt: null };
  expect(InputContentSchema.safeParse(base).success).toBe(true);
  const nativeInput = { text: 'expanded raw', sha256: createHash('sha256').update('expanded raw').digest('hex') };
  const content = { ...base, resourceInputPlan: { kind: 'plain', resourceRef: null, dispatchText: 'raw' }, nativeInput };
  expect(InputContentSchema.safeParse(content).success).toBe(true);
  expect(InputContentSchema.safeParse({ ...content, text: 'edited raw' }).success).toBe(false);
  expect(InputContentSchema.safeParse({ ...content, resourceInputPlan: { kind: 'skill', resourceRef: null, dispatchText: '/skill:query' } }).success).toBe(false);
  expect(InputContentSchema.safeParse({ ...content, nativeInput: { text: '\ud800', sha256: createHash('sha256').update('\ud800').digest('hex') } }).success).toBe(false);
});
