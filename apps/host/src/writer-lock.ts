import { dlopen, ptr } from 'bun:ffi';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { TimestampSchema } from '@medclaw/contracts/error';
import { WriterLockRecordSchema, type WriterLockRecord, type HostJobDomain, type ProcessTreeProof } from '@medclaw/contracts/maintenance';
import { inspectStoppedJob, type HostOwner } from './windows-job';

export interface WriterLease { previous: WriterLockRecord | null; processTreeProof: ProcessTreeProof | null; release(): void; retainUntilParentExit(): void }
function loadKernel() {
  const windows = process.env.SystemRoot;
  if (process.platform !== 'win32' || process.arch !== 'x64' || !windows || !isAbsolute(windows)) throw new Error('host_process_tracking_unavailable');
  return dlopen(join(windows, 'System32/kernel32.dll'), {
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    GetFileSizeEx: { args: ['u64', 'ptr'], returns: 'bool' },
    ReadFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    WriteFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    SetFilePointerEx: { args: ['u64', 'i64', 'ptr', 'u32'], returns: 'bool' },
    SetEndOfFile: { args: ['u64'], returns: 'bool' }, FlushFileBuffers: { args: ['u64'], returns: 'bool' },
    GetLastError: { args: [], returns: 'u32' }, CloseHandle: { args: ['u64'], returns: 'bool' },
    GetCurrentProcess: { args: [], returns: 'u64' }, OpenProcess: { args: ['u32', 'bool', 'u32'], returns: 'u64' },
    DuplicateHandle: { args: ['u64', 'u64', 'u64', 'ptr', 'u32', 'bool', 'u32'], returns: 'bool' },
  }).symbols;
}
let kernel: ReturnType<typeof loadKernel> | undefined;
function exclusiveFile(path: string, create: boolean) {
  if (!isAbsolute(path)) throw new Error('access_denied');
  const native = kernel ??= loadKernel(), encoded = Buffer.from(path + '\0', 'utf16le');
  let handle = native.CreateFileW(ptr(encoded), 0xc0000000, 1, null, create ? 1 : 3, 0x80, 0);
  let fresh = create;
  if (BigInt(handle) === 0xffffffffffffffffn && create && native.GetLastError() === 80) {
    handle = native.CreateFileW(ptr(encoded), 0xc0000000, 1, null, 3, 0x80, 0); fresh = false;
  }
  if (BigInt(handle) === 0xffffffffffffffffn) throw new Error('host_stop_unconfirmed');
  let closed = false;
  const seek = () => { if (closed || !native.SetFilePointerEx(handle, 0, null, 0)) throw new Error('host_stop_unconfirmed'); };
  return {
    fresh,
    read(): WriterLockRecord {
      seek(); const size = Buffer.alloc(8), count = Buffer.alloc(4);
      if (!native.GetFileSizeEx(handle, ptr(size)) || size.readBigUInt64LE() === 0n || size.readBigUInt64LE() > 65536n) throw new Error('host_stop_unconfirmed');
      const bytes = Buffer.alloc(Number(size.readBigUInt64LE()));
      if (!native.ReadFile(handle, ptr(bytes), bytes.length, ptr(count), null) || count.readUInt32LE() !== bytes.length) throw new Error('host_stop_unconfirmed');
      try { return WriterLockRecordSchema.parse(JSON.parse(bytes.toString('utf8'))); } catch { throw new Error('host_stop_unconfirmed'); }
    },
    write(record: WriterLockRecord) {
      const bytes = Buffer.from(JSON.stringify(WriterLockRecordSchema.parse(record))), count = Buffer.alloc(4); seek();
      if (!native.WriteFile(handle, ptr(bytes), bytes.length, ptr(count), null) || count.readUInt32LE() !== bytes.length
        || !native.SetEndOfFile(handle) || !native.FlushFileBuffers(handle)) throw new Error('storage_write_failed');
    },
    retainUntilParentExit() {
      if (closed || !Number.isSafeInteger(process.ppid) || process.ppid <= 0) throw new Error('host_stop_unconfirmed');
      const parent = native.OpenProcess(0x40, false, process.ppid);
      if (!parent) throw new Error('host_stop_unconfirmed');
      try {
        const copied = Buffer.alloc(8);
        // The installer owns this duplicate until it exits, even if this checker crashes afterwards.
        if (!native.DuplicateHandle(native.GetCurrentProcess(), handle, parent, ptr(copied), 0, false, 2)) throw new Error('host_stop_unconfirmed');
      } finally { native.CloseHandle(parent); }
    },
    release() { if (!closed) { closed = true; if (!native.CloseHandle(handle)) throw new Error('host_stop_unconfirmed'); } },
  };
}
function assertDead(record: WriterLockRecord) {
  try { process.kill(record.pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
  }
  throw new Error('host_stop_unconfirmed');
}
function assertOwner(record: WriterLockRecord, owner: HostOwner) {
  if (record.instanceId !== owner.instanceId || record.startupToken !== owner.startupToken) throw new Error('host_stop_unconfirmed');
}
function bootMarker(): string {
  const windows = process.env.SystemRoot;
  if (!windows || !isAbsolute(windows)) throw new Error('host_stop_unconfirmed');
  const result = spawnSync(join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::Out.Write((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'))"], { windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw new Error('host_stop_unconfirmed');
  try { return TimestampSchema.parse(result.stdout.trim()); } catch { throw new Error('host_stop_unconfirmed'); }
}
function stopped(record: WriterLockRecord): ProcessTreeProof | null {
  if (record.processDomain) return inspectStoppedJob(record, record.processDomain);
  if (record.recoveryBootMarker && record.recoveryBootMarker !== bootMarker())
    return { instanceId: record.instanceId, basis: 'system_restarted', observedAt: new Date().toISOString() };
  assertDead(record);
  return null;
}
export function inspectWriterLock(lockPath: string, owner: HostOwner) {
  const file = exclusiveFile(lockPath, false);
  try {
    const record = file.read(); assertOwner(record, owner); const proof = stopped(record);
    return { stopped: proof !== null, processTreeProof: proof, canPrepareRecovery: !record.processDomain && proof === null };
  } finally { file.release(); }
}
export function prepareRestartRecovery(lockPath: string, owner: HostOwner) {
  const file = exclusiveFile(lockPath, false);
  try {
    const record = file.read(); assertOwner(record, owner); assertDead(record);
    if (record.processDomain) throw new Error('state_conflict');
    if (!record.recoveryBootMarker) file.write({ ...record, recoveryBootMarker: bootMarker() });
  } finally { file.release(); }
}
function acquire(input: { lockPath: string; owner: HostOwner; processDomain: HostJobDomain }, replacePrevious: boolean): WriterLease {
  const file = exclusiveFile(input.lockPath, true);
  try {
    const previous = file.fresh ? null : file.read(), proof = previous ? stopped(previous) : null;
    if (previous && !proof) throw new Error('host_stop_unconfirmed');
    if (!previous || replacePrevious) file.write({ pid: process.pid, instanceId: input.owner.instanceId, startupToken: input.owner.startupToken, processDomain: input.processDomain });
    // Replacing stale metadata under the same exclusive handle avoids an unlink/recreate race.
    return { previous, processTreeProof: proof, release: () => file.release(), retainUntilParentExit: () => file.retainUntilParentExit() };
  } catch (error) { file.release(); throw error; }
}
export async function acquireWriterLock(input: { lockPath: string; owner: HostOwner; processDomain: HostJobDomain }): Promise<WriterLease> { return acquire(input, true); }
/** Read-only maintenance keeps the old identity available for later Run recovery. */
export async function acquireStoppedWriterLease(input: { lockPath: string; owner: HostOwner; processDomain: HostJobDomain }): Promise<WriterLease> { return acquire(input, false); }
