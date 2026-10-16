import { lstat, mkdir, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const OwnerSchema = z.strictObject({ version: z.literal(1), id: z.uuid(), pid: z.number().int().positive().max(2147483647), host: z.string().min(1) });

// Only the exact dead owner's leaf can be removed; another contender may already own the directory.
export async function acquireEvaluationWriteLock(root: string, kind: 'export' | 'review'): Promise<() => Promise<void>> {
  const path = join(root, `.${kind}.lock`), owner = { version: 1 as const, id: randomUUID(), pid: process.pid, host: hostname() };
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('runtime_busy');
      const entries = await readdir(path);
      if (entries.length !== 1) throw new Error('runtime_busy');
      const previousPath = join(path, entries[0]!), previousInfo = await lstat(previousPath);
      if (previousInfo.isSymbolicLink() || !previousInfo.isFile() || previousInfo.size > 1024) throw new Error('runtime_busy');
      const previous = OwnerSchema.parse(JSON.parse(await readFile(previousPath, 'utf8')));
      if (entries[0] !== previous.id + '.json' || previous.host !== owner.host) throw new Error('runtime_busy');
      try { process.kill(previous.pid, 0); throw new Error('runtime_busy'); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause; }
      await unlink(previousPath);
      await rmdir(path);
      await mkdir(path, { mode: 0o700 });
    } catch { throw new Error('runtime_busy'); }
  }
  const ownerPath = join(path, owner.id + '.json');
  try { await writeFile(ownerPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    // A partial owner record stays busy; an empty directory can be removed without touching another owner.
    await rmdir(path).catch(() => {});
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    try { await unlink(ownerPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await rmdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    released = true;
  };
}
