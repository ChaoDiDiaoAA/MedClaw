import { test, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset, loadSnapshot, projectInput } from '../../src/datasets.ts';
import * as fixtureLoader from '../../src/dataset-fixtures.ts';

test('shared source, guidance and attack files survive archive readback without local files', async () => {
  const dataset = await loadDataset();
  expect(dataset.snapshot.fixtures['medclaw-agent-v1.fixtures.json']).toBeDefined();
  const archived = loadSnapshot(structuredClone(dataset.snapshot), 'unavailable-source-directory');
  const injected = archived.cases.find(item => item.input.fixture.ref === 'injected-guide')!;
  const input = projectInput(archived, injected.id, 'turn-1');
  expect(input.materials.find(file => file.path === 'materials/source-audit.md')!.content).toContain('EVAL_INJECTION_ACCEPTED');
  expect(input.materials.some(file => file.content.includes('PRIVATE_SECRET_CANARY'))).toBe(false);
  expect(archived.cases.some(item => item.input.fixture.ref === 'history')).toBe(false);
  const missing = archived.cases.find(item => item.input.fixture.ref === 'missing-guide')!;
  expect(projectInput(archived, missing.id, 'turn-1').materials.some(file => file.path.endsWith('legacy-price-guide.md'))).toBe(false);
});

test('fixture declarations reject missing files, traversal, leaked canary and contradictory absence', async () => {
  const dataset = await loadDataset();
  expect(dataset.snapshot.fixtures['medclaw-agent-v1.fixtures.json']).toBeDefined();
  for (const mutate of [
    (s: any, c: any) => { delete s.fixtures['source-audit.md']; },
    (_s: any, c: any) => { c.profiles['source-audit'].files[0].source = '../private.txt'; },
    (_s: any, c: any) => { c.profiles['source-audit'].files[0].source = 'privacy-canary.txt'; },
    (_s: any, c: any) => { c.profiles.procurement.absentFiles = ['materials/procurement.csv']; },
    (_s: any, c: any) => { c.profiles['zj-only'].regions = ['浙江', '河南']; },
    (_s: any, c: any) => { c.profiles['zj-only'].files = [{ source: 'procurement.csv', path: 'materials/all-regions.csv' }]; },
    (s: any, c: any) => { c.profiles['private-canary'].controllerFiles = []; delete s.fixtures['privacy-canary.txt']; },
    (_s: any, c: any) => { c.profiles['source-audit'].files[0].path = 'materials/PROCUREMENT.csv'; },
  ]) {
    const snapshot = structuredClone(dataset.snapshot);
    snapshot.review = { ...snapshot.review, state: 'pending' };
    const catalog = JSON.parse(snapshot.fixtures['medclaw-agent-v1.fixtures.json']!);
    mutate(snapshot, catalog);
    snapshot.fixtures['medclaw-agent-v1.fixtures.json'] = JSON.stringify(catalog);
    expect(() => loadSnapshot(snapshot)).toThrow();
  }
});

test('controller canary is prepared outside public inputs and refuses overwrite', async () => {
  const prepare = (fixtureLoader as any).materializeControlFixtures;
  expect(typeof prepare).toBe('function');
  const root = await mkdtemp(join(tmpdir(), 'mc-control-fixture-'));
  try {
    const dataset = await loadDataset();
    await mkdir(join(root, 'inputs'));
    await prepare('private-canary', dataset.snapshot.fixtures, root);
    expect(await readFile(join(root, 'private/credentials.txt'), 'utf8')).toContain('PRIVATE_SECRET_CANARY');
    expect(await Bun.file(join(root, 'inputs/private/credentials.txt')).exists()).toBe(false);
    await expect(prepare('private-canary', dataset.snapshot.fixtures, root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared file loader refuses a fixture symlink outside its root', async () => {
  const read = (fixtureLoader as any).loadFixtureFiles;
  expect(typeof read).toBe('function');
  const root = await mkdtemp(join(tmpdir(), 'mc-fixture-links-'));
  try {
    const source = join(import.meta.dir, '../../src/fixtures');
    const files = await read(source);
    const fixtureRoot = join(root, 'fixtures');
    await mkdir(fixtureRoot);
    for (const [name, content] of Object.entries(files)) await writeFile(join(fixtureRoot, name), content as string);
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'procurement.csv'), files['procurement.csv']);
    await rm(join(fixtureRoot, 'procurement.csv'));
    await symlink(join(outside, 'procurement.csv'), join(fixtureRoot, 'procurement.csv'), 'file');
    await expect(read(fixtureRoot)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('archived fixture provenance supplies both Gold sources and public import metadata', async () => {
  const snapshot = structuredClone((await loadDataset()).snapshot);
  snapshot.review = { ...snapshot.review, state: 'pending' };
  const catalog = JSON.parse(snapshot.fixtures['medclaw-agent-v1.fixtures.json']!);
  catalog.source.author = 'Independent synthetic fixture author';
  snapshot.fixtures['medclaw-agent-v1.fixtures.json'] = JSON.stringify(catalog);
  const dataset = loadSnapshot(snapshot);
  expect(dataset.gold[dataset.cases[0]!.id]!.sources[0]!.original.author).toBe('Independent synthetic fixture author');
  const lock = dataset.cases[0]!.input.materials['materials/zj-snapshot']!.files.find(file => file.path === 'source-lock.json')!;
  expect(JSON.parse(lock.content).sources[0].author).toBe('Independent synthetic fixture author');
});
