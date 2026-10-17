import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { selectedDataRoot } from '../../desktop/src/main/runtime-paths';
import { acquireStoppedWriterLease, type WriterLease } from './writer-lock';
import type { HostOwner, HostJob } from './windows-job';

/** The caller keeps these leases throughout file replacement or uninstall. No database is opened. */
export async function acquireUpgradeLeases(sourceRoot: string, owner: HostOwner, job: HostJob) {
  if (!isAbsolute(sourceRoot)) throw new Error('access_denied');
  await mkdir(sourceRoot, { recursive: true });
  const root = await realpath(sourceRoot);
  if (root.toLowerCase() !== resolve(sourceRoot).toLowerCase()) throw new Error('access_denied');
  const selected = selectedDataRoot(root), roots = root.toLowerCase() === selected.toLowerCase() ? [root] : [root, selected];
  const leases: WriterLease[] = [];
  try {
    for (const path of roots) {
      const runtime = join(path, 'runtime'); await mkdir(runtime, { recursive: true });
      if ((await realpath(runtime)).toLowerCase() !== runtime.toLowerCase()) throw new Error('access_denied');
      leases.push(await acquireStoppedWriterLease({ lockPath: join(runtime, 'host.lock'), owner, processDomain: job.domain }));
    }
    if (selectedDataRoot(root) !== selected) throw new Error('state_conflict');
    return { checkedRoots: roots, release() { for (const lease of leases) lease.release(); },
      retainUntilParentExit() { for (const lease of leases) lease.retainUntilParentExit(); } };
  } catch (error) { for (const lease of leases) lease.release(); throw error; }
}
