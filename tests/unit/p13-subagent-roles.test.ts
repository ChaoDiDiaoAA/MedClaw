import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSubagentRoleSource } from '../../packages/runtime-pi/src/resource-loader';

const role = (id: string, tools: string[] = [], body = 'Analyze only the supplied task materials.') =>
  `---\nname: ${id}\ndescription: Independent analysis\ntools: ${JSON.stringify(tools)}\n---\n${body}\n`;
async function fixture(action: (f: { builtin: string; user: string; source: ReturnType<typeof createSubagentRoleSource> }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-subagent-roles-'));
  const builtin = join(root, 'builtin'), user = join(root, 'user');
  await mkdir(builtin);
  try { await action({ builtin, user, source: createSubagentRoleSource(builtin, user) }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('p13 roles load actual builtin declarations and preserve explicit empty tools', async () => {
  const source = createSubagentRoleSource(join(import.meta.dir, '../../resources/subagents'), join(tmpdir(), 'medclaw-role-unused-user'));
  const audit = await source.read('medclaw-audit'), analyst = await source.read('general-analyst');
  expect(audit.declaredTools).toHaveLength(19);
  expect(new Set(audit.declaredTools).size).toBe(19);
  expect(audit.declaredTools).toContain('read_source_metadata');
  expect(analyst.declaredTools).toEqual([]);
  expect(analyst.source).toEqual({ kind: 'builtin', file: 'general-analyst.md' });
});

test('p13 user overlay wins and captured role content survives later edits', async () => fixture(async ({ builtin, source }) => {
  const original = role('audit', ['read']);
  await writeFile(join(builtin, 'audit.md'), original);
  const captured = await source.capture();
  const changed = role('audit', [], 'Use only supplied material.');
  const saved = await source.save({ roleId: 'audit', content: changed, expectedContent: original });
  expect(saved.source.kind).toBe('user');
  expect((await source.read('audit')).content).toBe(changed);
  expect(captured.roles[0]?.content).toBe(original);
  expect(await readFile(join(builtin, 'audit.md'), 'utf8')).toBe(original);
}));

test('p13 malformed user overlay blocks builtin and remains visible in diagnostics', async () => fixture(async ({ builtin, user, source }) => {
  await writeFile(join(builtin, 'audit.md'), role('audit', ['read']));
  await mkdir(user); await writeFile(join(user, 'audit.md'), '---\nname: audit\ntools: [broken\n---\ntext');
  const found = await source.discover();
  expect(found.items).toHaveLength(1);
  expect(found.items[0]).toMatchObject({ roleId: 'audit', source: { kind: 'user' }, availability: 'invalid' });
  expect((await source.capture()).roles).toEqual([]);
  await expect(source.read('audit')).rejects.toMatchObject({ code: 'resource_unavailable' });
}));

test('p13 saves require original content and concurrent saves cannot both replace it', async () => fixture(async ({ builtin, user, source }) => {
  const original = role('reviewer');
  await source.save({ roleId: 'reviewer', content: original, expectedContent: null });
  await expect(source.save({ roleId: 'reviewer', content: role('reviewer', [], 'stale'), expectedContent: null })).rejects.toMatchObject({ code: 'state_conflict' });
  const competing = createSubagentRoleSource(builtin, user);
  const results = await Promise.allSettled([
    source.save({ roleId: 'reviewer', content: role('reviewer', [], 'first'), expectedContent: original }),
    competing.save({ roleId: 'reviewer', content: role('reviewer', [], 'second'), expectedContent: original }),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  const winner = results.find(r => r.status === 'fulfilled');
  if (winner?.status !== 'fulfilled') throw new Error('missing successful save');
  expect((await source.read('reviewer')).content).toBe(winner.value.content);
}));

test('p13 roles reject unsafe IDs, renamed content, forbidden tools and extra execution settings', async () => fixture(async ({ source }) => {
  for (const [roleId, content] of [
    ['../escape', role('escape')], ['reviewer', role('renamed')], ['reviewer', role('reviewer', ['Agent'])],
    ['reviewer', role('reviewer', ['query_intent_step'])], ['reviewer', role('reviewer', ['bash'])],
    ['reviewer', role('reviewer').replace('description:', 'model: other\ndescription:')],
  ]) await expect(source.save({ roleId: roleId!, content: content!, expectedContent: null })).rejects.toMatchObject({ code: 'invalid_argument' });
  expect((await source.discover()).items).toEqual([]);
}));

test('p13 roles reject invalid UTF8 and oversized files without builtin fallback', async () => fixture(async ({ builtin, user, source }) => {
  await writeFile(join(builtin, 'audit.md'), role('audit'));
  await mkdir(user); await writeFile(join(user, 'audit.md'), Buffer.from([0xc3, 0x28]));
  await expect(source.read('audit')).rejects.toMatchObject({ reason: 'resource_invalid' });
  await writeFile(join(user, 'audit.md'), 'a'.repeat(64 * 1024 + 1));
  await expect(source.read('audit')).rejects.toMatchObject({ reason: 'resource_too_large' });
}));

test('p13 linked role files cannot escape managed roots', async () => fixture(async ({ builtin, source }) => {
  const target = join(builtin, 'outside.txt'); await writeFile(target, role('audit'));
  await symlink(target, join(builtin, 'audit.md'));
  await expect(source.read('audit')).rejects.toMatchObject({ reason: 'resource_path_invalid' });
}));

test('p13 unknown declarations are preserved for actual registry validation and failed edits preserve the file', async () => fixture(async ({ user, source }) => {
  const original = role('reviewer', ['not_registered']);
  await source.save({ roleId: 'reviewer', content: original, expectedContent: null });
  expect((await source.read('reviewer')).declaredTools).toEqual(['not_registered']);
  await expect(source.save({ roleId: 'reviewer', content: role('reviewer', ['write']), expectedContent: original })).rejects.toMatchObject({ code: 'invalid_argument' });
  expect(await readFile(join(user, 'reviewer.md'), 'utf8')).toBe(original);
}));

test('p13 role capacity rejects a new ID before writing and still permits an existing override', async () => fixture(async ({ builtin, user, source }) => {
  await Promise.all(Array.from({ length: 128 }, (_, index) => writeFile(join(builtin, `reviewer-${index}.md`), role(`reviewer-${index}`))));
  expect((await source.capture()).roles).toHaveLength(128);
  await expect(source.save({ roleId: 'reviewer-over-capacity', content: role('reviewer-over-capacity'), expectedContent: null })).rejects.toMatchObject({ code: 'resource_unavailable', reason: 'resource_too_large' });
  await expect(readFile(join(user, 'reviewer-over-capacity.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await source.discover()).items).toHaveLength(128);
  const original = await source.read('reviewer-0'), changed = role('reviewer-0', [], 'Updated existing role at capacity.');
  expect(await source.save({ roleId: 'reviewer-0', content: changed, expectedContent: original.content })).toMatchObject({ source: { kind: 'user' }, content: changed });
  expect((await source.capture()).roles).toHaveLength(128);
}));
