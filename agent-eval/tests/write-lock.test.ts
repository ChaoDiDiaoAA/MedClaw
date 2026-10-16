import { expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireEvaluationWriteLock } from '../src/reports/write-lock.ts';

test('write lock excludes a live writer and removes only its own owner on release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mc-write-lock-'));
  try {
    const release = await acquireEvaluationWriteLock(root, 'export');
    await expect(acquireEvaluationWriteLock(root, 'export')).rejects.toThrow('runtime_busy');
    const path = join(root, '.export.lock'), names = await readdir(path);
    expect(names).toHaveLength(1);
    expect(JSON.parse(await readFile(join(path, names[0]!), 'utf8'))).toMatchObject({ pid: process.pid, host: hostname(), version: 1 });
    await release(); await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    const next = await acquireEvaluationWriteLock(root, 'export');
    await release(); await expect(acquireEvaluationWriteLock(root, 'export')).rejects.toThrow('runtime_busy');
    await next();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('actual dead writer can be reclaimed by exactly one concurrent contender', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mc-write-lock-'));
  const script = `import {acquireEvaluationWriteLock} from ${JSON.stringify(new URL('../src/reports/write-lock.ts', import.meta.url).href)};
    await acquireEvaluationWriteLock(${JSON.stringify(root)},'review');console.log('locked');
    for await(const _ of Bun.stdin.stream())break;process.exit(88);`;
  const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', script], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked'); reader.releaseLock();
    await expect(acquireEvaluationWriteLock(root, 'review')).rejects.toThrow('runtime_busy');
    child.stdin.write('exit'); child.stdin.end(); expect(await child.exited).toBe(88);
    const contenders = await Promise.allSettled(Array.from({ length: 8 }, () => acquireEvaluationWriteLock(root, 'review')));
    const winners = contenders.filter(item => item.status === 'fulfilled'); expect(winners).toHaveLength(1);
    await expect(acquireEvaluationWriteLock(root, 'review')).rejects.toThrow('runtime_busy');
    for (const item of contenders) if (item.status === 'fulfilled') await item.value();
    await expect(lstat(join(root, '.review.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    child.stdin.end(); await child.exited; await rm(root, { recursive: true, force: true });
  }
});

for (const kind of ['legacy-file', 'empty-directory', 'partial-owner', 'foreign-host', 'wrong-filename'] as const) {
  test('write lock preserves unproven ownership: ' + kind, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mc-write-lock-')), path = join(root, '.export.lock');
    try {
      const id = crypto.randomUUID(), owner = { version: 1, id, pid: process.pid, host: kind === 'foreign-host' ? hostname() + '-other' : hostname() };
      if (kind === 'legacy-file') await writeFile(path, '');
      else {
        await mkdir(path);
        if (kind !== 'empty-directory') await writeFile(join(path, kind === 'wrong-filename' ? 'other.json' : id + '.json'), kind === 'partial-owner' ? '{' : JSON.stringify(owner));
      }
      const before = (await lstat(path)).isFile() ? await readFile(path, 'utf8') : await readdir(path);
      await expect(acquireEvaluationWriteLock(root, 'export')).rejects.toThrow('runtime_busy');
      expect((await lstat(path)).isFile() ? await readFile(path, 'utf8') : await readdir(path)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
