import { createHostJob } from './windows-job';
import { acquireUpgradeLeases } from './upgrade';

// This trusted bundled entry is invoked directly by NSIS, never through Renderer input.
try {
  const [root, mode, ...extra] = process.argv.slice(2);
  if (!root || !['--check', '--retain-parent'].includes(mode ?? '') || extra.length) throw new Error('invalid_argument');
  const owner = { instanceId: crypto.randomUUID(), startupToken: crypto.randomUUID() }, job = createHostJob(owner);
  const leases = await acquireUpgradeLeases(root, owner, job);
  try { if (mode === '--retain-parent') leases.retainUntilParentExit(); }
  finally { leases.release(); }
  console.log('ready');
} catch { process.stdout.write('stop-unconfirmed\n'); process.exitCode = 2; }
