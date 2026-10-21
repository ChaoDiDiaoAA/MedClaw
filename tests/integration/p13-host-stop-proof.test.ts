import { expect, test } from 'bun:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { fixture } from '../fixtures/p1-host';

test('p13 restart after raw process close waits for the owned process-tree proof', async () => {
  const { root, entry } = await fixture();
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath });
  const refresh = host.refreshStopProof.bind(host);
  let release!: () => void;
  const proofGate = new Promise<void>(done => { release = done; });
  let proofPending = false;
  try {
    expect(await host.start()).toMatchObject({ state: 'ready' });
    const old = host.read().instanceId!;
    host.refreshStopProof = async () => { proofPending = true; await proofGate; await refresh(); };
    const child = Reflect.get(host, 'child') as ChildProcessWithoutNullStreams;
    const closed = new Promise<void>(done => child.once('close', () => done()));
    expect(child.kill('SIGKILL')).toBe(true);
    await closed;
    expect(proofPending).toBe(true);
    const restarting = host.restart(old);
    expect(await Promise.race([restarting.then(() => true), Bun.sleep(30).then(() => false)])).toBe(false);
    release();
    expect(await restarting).toMatchObject({ state: 'ready', error: null });
    expect(host.read().instanceId).not.toBe(old);
  } finally {
    release(); host.refreshStopProof = refresh;
    await refresh();
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    await refresh();
    expect(host.read().canStart).toBe(true);
    if (realpathSync(root) !== root || !root.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('ENGINEERING Host fixture cleanup root changed');
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
