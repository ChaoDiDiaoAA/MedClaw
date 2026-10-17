import { expect, test } from 'bun:test';
import { publicMethodSchemas, isReadOnlyMethod, HOST_PROTOCOL_VERSION, DATABASE_SCHEMA_VERSION, PublicHostRequestSchema } from '../../packages/contracts/src/protocol';
import { PublishedSettingsSchema, SETTINGS_SCHEMA_VERSION } from '../../packages/contracts/src/model';
import { InputContentSchema } from '../../packages/contracts/src/session';
import { contextModel } from '../fixtures/p8-context';
import { ModelCallContextSchema } from '../../packages/contracts/src/context';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalRequest } from '../../packages/contracts/src/run';
import { RESOURCE_LIMITS, type ResourceDefinition } from '../../packages/contracts/src/resources';

function authorFixture() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-author-')), definitions: ResourceDefinition[] = [];
  const add = (kind: 'prompt' | 'skill', id = 'query', version = 'v1', content = kind === 'skill' ? '---\nname: query\ndescription: ENGINEERING query\n---\nRead facts.\n' : '---\ndescription: ENGINEERING query\n---\nFacts $ARGUMENTS\n', support: Record<string, string> = {}) => {
    const entry = `${kind === 'skill' ? 'skills' : 'prompts'}/${id}/${version}/${kind === 'skill' ? 'SKILL.md' : id + '.md'}`;
    const texts = { [entry.split('/').at(-1)!]: content, ...support }, base = dirname(join(root, entry));
    for (const [path, text] of Object.entries(texts)) { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), text); }
    const metadata = { kind, id, version, entry, keywords: ['facts'], requiredTools: ['read'], requiredExtensions: [], files: Object.entries(texts).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text)})) };
    const definition = { ...metadata, files: metadata.files.map(f => f.path)};
    definitions.push(definition); return definition;
  };
  const save = () => writeFileSync(join(root, 'catalog.json'), JSON.stringify({ contract: 'medclaw.resource-catalog/v1', sdkVersion: '0.87.1', definitions }));
  return { root, definitions, add, save };
}
async function resourceLoader() {
  const module = await import('../../packages/runtime-pi/src/resource-loader').catch(() => null);
  expect(module?.createResourceSource).toBeFunction(); return module!;
}

test('p11 managed source captures current version content and rejects undeclared files', async () => {
  const f = authorFixture();
  try {
    const skill = f.add('skill', 'query', 'v1', undefined, { 'references/facts.md': '\ufefffacts\r\n' }), prompt = f.add('prompt'), older = f.add('skill', 'query', 'v2'); f.save();
    const { createResourceSource } = await resourceLoader(), source = createResourceSource(f.root), result = await source.discover();
    expect(result.items).toHaveLength(3); expect(result.items.every(item => item.availability === 'ready')).toBe(true);
    const snapshots = await source.capture([skill, prompt, older].map(({kind,id,version}) => ({kind,id,version})));
    expect(snapshots[0]?.files.find(file => file.file === 'references/facts.md')?.content).toBe('\ufefffacts\r\n');
    expect(snapshots.map(s => s.ref.version)).toEqual(['v1', 'v1', 'v2']);
    const updated = '---\nname: query\ndescription: ENGINEERING query\n---\nCurrent facts.\n';
    writeFileSync(join(f.root, skill.entry), updated);
    expect((await source.discover()).items[0]?.availability).toBe('ready');
    const current = await source.capture([{kind:skill.kind,id:skill.id,version:skill.version}]);
    expect(current[0]?.files.find(file => file.file === 'SKILL.md')?.content).toBe(updated);
    expect(snapshots[0]?.files.find(file => file.file === 'SKILL.md')?.content).toContain('Read facts.');
    writeFileSync(join(f.root, dirname(prompt.entry), 'undeclared.txt'), 'extra');
    await expect(source.capture([{kind:prompt.kind,id:prompt.id,version:prompt.version}])).rejects.toMatchObject({ reason: 'resource_changed' });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('p11 source isolates missing, malformed, conflicting, invalid UTF8 and oversized versions', async () => {
  const f = authorFixture();
  try {
    const missing = f.add('skill'), bad = f.add('skill', 'bad', 'v1', '---\nname: bad\n---\nNo description.'), oversize = f.add('prompt', 'huge', 'v1', 'X'.repeat(RESOURCE_LIMITS.fileBytes + 1)), encoding = f.add('prompt', 'encoding');
    const conflicted = f.add('prompt', 'conflict'); f.definitions.push(conflicted); f.save();
    unlinkSync(join(f.root, missing.entry)); writeFileSync(join(f.root, encoding.entry), Buffer.from([0xc3, 0x28]));
    const source = (await resourceLoader()).createResourceSource(f.root), { items } = await source.discover();
    expect(items.find(i => i.ref.id === 'query')?.availability).toBe('missing');
    expect(items.find(i => i.ref.id === 'bad')?.availability).toBe('invalid');
    expect(items.find(i => i.ref.id === 'huge')?.diagnostics).toContainEqual(expect.objectContaining({ reason: 'resource_too_large' }));
    expect(items.find(i => i.ref.id === 'encoding')?.availability).toBe('invalid');
    expect(items.filter(i => i.ref.id === 'conflict').every(i => i.availability === 'conflict')).toBe(true);
    for (const definition of [missing, bad, oversize, encoding, conflicted]) await expect(source.capture([{kind:definition.kind,id:definition.id,version:definition.version}])).rejects.toMatchObject({ code: 'resource_unavailable' });
    writeFileSync(join(f.root, 'catalog.json'), '{}'); await expect(source.discover()).rejects.toMatchObject({ reason: 'resource_catalog_invalid' });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('p11 product templates reject alternate SDK placeholders while ordinary dollars remain text', async () => {
  const f = authorFixture();
  try {
    f.add('prompt', 'valid', 'v1', 'USD $cost\n$ARGUMENTS');
    for (const [index, placeholder] of ['$1', '$@', '${1:-fallback}', '${@:1:2}', '${ARGUMENTS:-fallback}', '$ARGUMENTS'].entries()) f.add('prompt', 'bad-' + index, 'v1', '$ARGUMENTS ' + placeholder);
    f.save(); const { items } = await (await resourceLoader()).createResourceSource(f.root).discover();
    expect(items.find(i => i.ref.id === 'valid')?.availability).toBe('ready');
    expect(items.filter(i => i.ref.id.startsWith('bad-')).every(i => i.availability === 'invalid')).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('p11 managed versions reject junction escape and cannot treat directory links as author files', async () => {
  const f = authorFixture(), outside = mkdtempSync(join(tmpdir(), 'medclaw-p11-outside-'));
  try {
    const definition = f.add('skill'); f.save(); const version = dirname(join(f.root, definition.entry));
    writeFileSync(join(outside, 'SKILL.md'), 'OUTSIDE_PRIVATE_TEXT'); rmSync(version, { recursive: true }); symlinkSync(outside, version, process.platform === 'win32' ? 'junction' : 'dir');
    const source = (await resourceLoader()).createResourceSource(f.root);
    await expect(source.capture([{kind:definition.kind,id:definition.id,version:definition.version}])).rejects.toMatchObject({ reason: 'resource_path_invalid' });
    expect((await source.discover()).items[0]?.availability).toBe('invalid');
  } finally { rmSync(f.root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('p11 shipped query resources have actual SDK metadata and complete source contents', async () => {
  const source = (await resourceLoader()).createResourceSource(join(import.meta.dir, '../../resources'));
  const result = await source.discover();
  expect(result.items.map(i => [i.ref.kind, i.ref.id, i.ref.version, i.availability])).toEqual([['prompt', 'query', 'v1', 'ready'], ['skill', 'query', 'v1', 'ready']]);
  const snapshots = await source.capture(result.items.map(i => i.ref));
  expect(snapshots[1]?.files.map(f => f.file)).toEqual(['SKILL.md', 'references/facts-and-assumptions.md']);
  expect(snapshots[1]?.requiredTools).toEqual(['check_data_coverage', 'read', 'read_data_scope']);
  expect(snapshots[0]?.files[0]?.content).toContain('$ARGUMENTS');
});

test('p11 version and catalog byte budgets fail without truncating resource content', async () => {
  const f = authorFixture();
  try {
    f.add('skill', 'query', 'v1', undefined, Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`references/${i}.md`, 'x'.repeat(RESOURCE_LIMITS.fileBytes)])));
    f.save(); const source = (await resourceLoader()).createResourceSource(f.root);
    expect((await source.discover()).items[0]?.diagnostics).toContainEqual(expect.objectContaining({ reason: 'resource_too_large' }));
    writeFileSync(join(f.root, 'catalog.json'), ' '.repeat(RESOURCE_LIMITS.replyBytes + 1));
    await expect(source.discover()).rejects.toMatchObject({ reason: 'resource_catalog_invalid' });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

const ref = { kind: 'skill' as const, id: 'query', version: 'v1'};
test('p11 resource routes validate managed identity and distinguish reads from configuration mutation', () => {
  const list = Reflect.get(publicMethodSchemas, 'resources.list'), read = Reflect.get(publicMethodSchemas, 'resources.read'), select = Reflect.get(publicMethodSchemas, 'resources.select');
  expect(list).toBeDefined(); expect(read).toBeDefined(); expect(select).toBeDefined();
  expect(list.input.safeParse({ source: 'selection', sessionId: 1 }).success).toBe(true);
  expect(list.input.safeParse({ source: 'run', runId: 3, sessionId: 1 }).success).toBe(false);
  expect(list.input.safeParse({ source: 'run', runId: 3, evidencePage: Number.MAX_SAFE_INTEGER, evidencePageSize: 100 }).success).toBe(false);
  expect(read.input.safeParse({ source: 'run', runId: 3, resourceRef: ref, file: 'SKILL.md' }).success).toBe(true);
  for (const file of ['../SKILL.md', '/etc/passwd', 'C:/secret', '\\\\server\\secret', 'a:stream', 'a\\b', 'a//b', './a', 'a\u0000b', 'CON.txt', 'references/aux', 'a?.md', 'a".md']) {
    expect(read.input.safeParse({ source: 'run', runId: 3, resourceRef: ref, file }).success).toBe(false);
  }
  const choice = { sessionId: 1, expectedConfigVersion: '1', selection: { prompt: null, skills: [ref] } };
  expect(select.input.safeParse(choice).success).toBe(true);
  expect(select.input.safeParse({ ...choice, selection: { prompt: ref, skills: [] } }).success).toBe(false);
  expect(select.input.safeParse({ ...choice, selection: { prompt: null, skills: [ref, { ...ref, version: 'v2' }] } }).success).toBe(false);
  expect(isReadOnlyMethod('resources.list')).toBe(true); expect(isReadOnlyMethod('resources.read')).toBe(true); expect(isReadOnlyMethod('resources.select')).toBe(false);
  const frame = { protocolVersion: HOST_PROTOCOL_VERSION, kind: 'request', requestId: 'r', instanceId: 'host', operationRef: 'resource', method: 'resources.select', payload: choice };
  expect(PublicHostRequestSchema.safeParse(frame).success).toBe(true);
  expect(PublicHostRequestSchema.safeParse({ ...frame, protocolVersion: 'medclaw.host/p10-v1' }).success).toBe(false);
  expect(HOST_PROTOCOL_VERSION).toBe('medclaw.host/p17-v1'); expect(DATABASE_SCHEMA_VERSION).toBe(16);
});

test('p11 resource HTTP observations cannot certify a different or incomplete expected payload', () => {
  const fact = { resourceRef: ref, originRunId: 1, file: null, kind: 'skill_index', inputId: null, nativeEntryId: null, toolCallId: null,  coverage: 'index' };
  const payload = {  verified: [fact] };
  const observation = { contract: 'medclaw.context-observation/v1', api: 'openai-completions', transport: 'sse', observedAt: '2026-10-06T00:00:00.000Z', httpStatus: 200,
      verifiedNativeRefs: [], resources: payload };
  const call = { contract: 'medclaw.context-call/v1', snapshotId: 1, inputId: 1, observation, responseStatus: 200, payloadVerified: true, resources: { expected: [fact], payload } };
  expect(ModelCallContextSchema.safeParse(call).success).toBe(true);
  const overBudget = Array.from({length:1001},(_,i)=>({...fact,originRunId:i+1}));
  expect(ModelCallContextSchema.safeParse({...call,resources:{expected:overBudget,payload:null}}).success).toBe(false);
  expect(ModelCallContextSchema.safeParse({ ...call, resources: { expected: [fact], payload: { ...payload, verified: [] } }, observation: { ...observation, resources: { ...payload, verified: [] } } }).success).toBe(false);
  expect(ModelCallContextSchema.safeParse({ ...call, observation: { ...observation, resources: { ...payload,verified:[{...fact,originRunId:2}]} } }).success).toBe(false);
  expect(ModelCallContextSchema.safeParse({ ...call, responseStatus: 400 }).success).toBe(false);
});

test('p11 published settings retain per-session resources and reject malformed identities', () => {
  const base = { schemaVersion: SETTINGS_SCHEMA_VERSION, configVersion: '1', model: null, customProviders: [], credentialRefs: {}, previous: null, rollbackFromVersion: null };
  expect(PublishedSettingsSchema.parse(base).resources ?? { bySession: {} }).toEqual({ bySession: {} });
  const selected = { resources: { bySession: { '1': { prompt: null, skills: [ref] }, '2': { prompt: null, skills: [] } } } };
  expect(PublishedSettingsSchema.parse({ ...base, ...selected }).resources).toEqual(selected.resources);
  for (const key of ['0', '01', '-1', '9007199254740992']) expect(PublishedSettingsSchema.safeParse({ ...base, resources: { bySession: { [key]: { prompt: null, skills: [] } } } }).success).toBe(false);
});

test('p11 input content retains raw text separately from the native receipt text', () => {
  const request = { sessionId: 1, clientSequence: 1, text: 'raw', mode: 'send', expectedRevision: 1, expectedBatchIds: [], expectedQueryId: null,
    model: { provider: contextModel.provider, modelId: contextModel.modelId, expectedConfigVersion: '1' }, referenceDate: '2026-10-06', timezone: 'Asia/Shanghai' };
  const base = { contract: 'medclaw.session-input/v1', originalSubmitInput: request, text: 'raw', workspaceContext: { sessionId: 1, batchRefs: [], queryId: null, revision: 1, materialVersion: null, deviceIds: [], activeView: 'data', selection: null },
    scope: { batchIds: [], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: true }, model: contextModel, referenceDate: request.referenceDate, timezone: request.timezone, deliveryAttempt: null };
  expect(InputContentSchema.safeParse(base).success).toBe(true);
  const nativeInput = { text: 'expanded raw'};
  const content = { ...base, resourceInputPlan: { kind: 'plain', resourceRef: null, dispatchText: 'raw' }, nativeInput };
  expect(InputContentSchema.safeParse(content).success).toBe(true);
  expect(InputContentSchema.safeParse({ ...content, text: 'edited raw' }).success).toBe(false);
  expect(InputContentSchema.safeParse({ ...content, resourceInputPlan: { kind: 'skill', resourceRef: null, dispatchText: '/skill:query' } }).success).toBe(false);
  expect(InputContentSchema.safeParse({ ...content, nativeInput: { text: '\ud800'} }).success).toBe(false);
});
