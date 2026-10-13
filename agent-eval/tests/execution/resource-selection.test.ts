import { afterAll, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MainSettings } from '../../../apps/desktop/src/main/settings';
import { ResourceTextSchema } from '../../../packages/contracts/src/resources';
import { ActionExecutor } from '../../src/adapters/actions';
import { verifyPublishedConfiguration } from '../../src/adapters/configuration';
import { unwrap } from '../../src/adapters/product';
import { loadFixtureFiles, loadProductResources } from '../../src/dataset-fixtures';
import { prepareInstance } from '../../src/execution/instance';
import type { ResolvedRunConfig } from '../../src/types';

const paths: string[] = [], digest = `sha256:${'a'.repeat(64)}`;
const metadata = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname; paths.push(path);
  if (path === '/api/version') return Response.json({ version: 'ENGINEERING metadata only' });
  if (path === '/api/tags') return Response.json({ models: [{ name: 'qwen3.5:0.8b', digest }] });
  if (path === '/api/show') return Response.json({ details: { family: 'ENGINEERING', parameter_size: 'fixture', quantization_level: 'fixture' } });
  return new Response('ENGINEERING inference prohibited', { status: 403 });
} });
afterAll(() => { metadata.stop(true); expect(paths.every(path => ['/api/version', '/api/tags', '/api/show'].includes(path))).toBe(true); });
const config: ResolvedRunConfig = { version: 1, environment: 'test', model: { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 16384 },
  intent: { baseUrl: `http://127.0.0.1:${metadata.port}`, model: 'qwen3.5:0.8b' }, policy: {}, retention: 'preserve_all' };
const action = { action: 'select_resources' as const, sessionAlias: 'A', skills: [{ id: 'query', version: 'v1' as const }] };

async function expectFailure(operation: Promise<unknown>, message: string) {
  // Bun's rejection matcher can stall child-process I/O on Windows; await before asserting.
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure instanceof Error ? failure.message : null).toContain(message);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-resource-selection-'));
  const captured = await loadProductResources(await loadFixtureFiles());
  const product = await prepareInstance({ trialRoot: root, config });
  const executor = new ActionExecutor(product, config, root, root, captured);
  await executor.execute({ action: 'new_session', alias: 'A' });
  const sessionId = executor.aliases.sessions.get('A')!.id;
  const list = () => product.request('resources.list', { source: 'selection', sessionId }).then(unwrap);
  return { root, captured, product, executor, sessionId, list, async dispose() {
    expect(await product.stop()).toMatchObject({ stopped: true, closed: true, processExited: true });
    await rm(root, { recursive: true, force: true });
  } };
}

test('select_resources publishes actual Session Skill refs and verifies every captured product file without an Agent run', async () => {
  const f = await fixture();
  try {
    const before = await f.list(); expect(before.selection.skills).toEqual([]);
    const receipt = await f.executor.execute(action);
    const after = await f.list(); expect(receipt).toMatchObject({ sessionId: f.sessionId, configVersion: after.configVersion });
    expect(after.selection.skills).toHaveLength(1);
    expect(after.selection.skills[0]).toMatchObject({ kind: 'skill', id: 'query', version: 'v1' });
    expect(after.items.find(item => item.ref.kind === 'skill' && item.ref.id === 'query')).toMatchObject({ enabled: true, availability: 'ready' });
    const selected = new MainSettings(f.product.paths.settingsPath).read().resources?.bySession[String(f.sessionId)];
    expect(selected).toEqual(after.selection);
    const reads = f.product.traces.filter(row => row.kind === 'request' && row.method === 'resources.read');
    expect(reads.map(row => (row.payload as { file: string }).file).sort()).toEqual(['SKILL.md', 'references/facts-and-assumptions.md']);
    const publicEvidence = await readFile(join(f.root, 'events.jsonl'), 'utf8');
    expect(publicEvidence).not.toContain('"treeHash"'); expect(publicEvidence).not.toContain('"sha256"');
    expect(unwrap(await f.product.request('run.read', { recent: true }))).toMatchObject({ kind: 'recent', runs: [] });
    expect(f.product.traces.some(row => row.kind === 'request' && ['session.submit', 'model.request', 'session.compact'].includes(row.method as string))).toBe(false);
    expect(await verifyPublishedConfiguration(f.product, config)).toMatchObject({ expectedConfigVersion: after.configVersion });
  } finally { await f.dispose(); }
}, 30000);

test('captured content mismatch rejects the selection and restores the previous real Session selection', async () => {
  const f = await fixture();
  try {
    const before = await f.list(), changed = structuredClone(f.captured);
    changed[0]!.files[0]!.content += '\nChanged captured content\n'; changed[0]!.files[0]!.bytes = Buffer.byteLength(changed[0]!.files[0]!.content);
    const executor = new ActionExecutor(f.product, config, f.root, f.root, changed);
    executor.aliases.sessions.set('A', f.executor.aliases.sessions.get('A')!);
    await expectFailure(executor.execute(action), 'captured_resource_content_changed');
    const after = await f.list(); expect(after.selection).toEqual(before.selection);
    expect(BigInt(after.configVersion)).toBe(BigInt(before.configVersion) + 2n);
    expect(new MainSettings(f.product.paths.settingsPath).read().resources?.bySession[String(f.sessionId)]).toEqual(before.selection);
    expect(f.product.traces.some(row => row.kind === 'request' && row.method === 'session.submit')).toBe(false);
    await f.executor.execute(action); expect((await f.list()).selection.skills[0]).toMatchObject({ id: 'query' });
  } finally { await f.dispose(); }
}, 30000);

test('missing captures and changed file inventories fail before selection is published', async () => {
  const f = await fixture();
  try {
    const before = await f.list();
    for (const captured of [[], f.captured.map(resource => ({ ...resource, files: resource.files.slice(0, 1) }))]) {
      const executor = new ActionExecutor(f.product, config, f.root, f.root, captured);
      executor.aliases.sessions.set('A', f.executor.aliases.sessions.get('A')!);
      await expectFailure(executor.execute(action), 'captured_resource');
      expect(await f.list()).toMatchObject({ configVersion: before.configVersion, selection: before.selection });
    }
  } finally { await f.dispose(); }
}, 30000);

test('resource publication rejects stale versions and aborts failed Host preparation before accepting the next change', async () => {
  const f = await fixture();
  try {
    const before = await f.list(), skill = before.items.find(item => item.ref.kind === 'skill' && item.ref.id === 'query')!.ref;
    const selection = { prompt: null, skills: [skill] };
    const rejected = await f.product.request('resources.select', { sessionId: 999, expectedConfigVersion: before.configVersion, selection });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'input_invalid', reason: 'session_not_found' } });
    expect((await f.list()).configVersion).toBe(before.configVersion);
    expect(f.product.traces.some(row => row.kind === 'request' && row.method === 'settings.abort')).toBe(true);
    const selected = unwrap(await f.product.request('resources.select', { sessionId: f.sessionId, expectedConfigVersion: before.configVersion, selection }));
    expect(selected.selection).toEqual(selection);
    expect(await f.product.request('resources.select', { sessionId: f.sessionId, expectedConfigVersion: before.configVersion, selection: before.selection }))
      .toMatchObject({ ok: false, error: { code: 'config_conflict' } });
    expect(await f.list()).toMatchObject({ configVersion: selected.configVersion, selection });
    const restored = unwrap(await f.product.request('resources.select', { sessionId: f.sessionId, expectedConfigVersion: selected.configVersion, selection: before.selection }));
    expect((await f.list()).selection).toEqual(restored.selection);
  } finally { await f.dispose(); }
}, 30000);

test('resource rollback reports a concurrent configuration conflict without overwriting the later selection', async () => {
  const f = await fixture(), request = f.product.request.bind(f.product);
  let interleaved = false;
  const before = await f.list(), prompt = before.items.find(item => item.ref.kind === 'prompt' && item.ref.id === 'query')!.ref;
  const laterSelection = { prompt, skills: [] };
  const calls = spyOn(f.product, 'request').mockImplementation(async (...args: Parameters<typeof request>) => {
    const [method] = args, result = await request(...args);
    if (method === 'resources.read' && result.ok && !interleaved) {
      interleaved = true;
      const content = ResourceTextSchema.parse(result.data);
      unwrap(await request('resources.select', { sessionId: f.sessionId, expectedConfigVersion: content.configVersion, selection: laterSelection }));
    }
    return result;
  });
  try {
    const changed = structuredClone(f.captured); changed[0]!.files[0]!.content += 'changed';
    const executor = new ActionExecutor(f.product, config, f.root, f.root, changed);
    executor.aliases.sessions.set('A', f.executor.aliases.sessions.get('A')!);
    await expectFailure(executor.execute(action), 'resource_selection_rollback_failed:config_conflict');
    expect((await f.list()).selection).toEqual(laterSelection);
    expect(new MainSettings(f.product.paths.settingsPath).read().resources?.bySession[String(f.sessionId)]).toEqual(laterSelection);
    expect(f.product.traces.some(row => row.kind === 'request' && row.method === 'session.submit')).toBe(false);
  } finally { calls.mockRestore(); await f.dispose(); }
}, 30000);
