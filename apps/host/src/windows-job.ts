import { dlopen, ptr } from 'bun:ffi';
import { isAbsolute, join } from 'node:path';
import { OpaqueIdSchema } from '@medclaw/contracts/error';
import { HostJobDomainSchema, type HostJobDomain, type ProcessTreeProof } from '@medclaw/contracts/maintenance';

function loadKernel() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('host_process_tracking_unavailable');
  const windows = process.env.SystemRoot;
  if (!windows || !isAbsolute(windows)) throw new Error('host_process_tracking_unavailable');
  return dlopen(join(windows, 'System32/kernel32.dll'), {
    CreateJobObjectW: { args: ['ptr', 'ptr'], returns: 'u64' },
    OpenJobObjectW: { args: ['u32', 'bool', 'ptr'], returns: 'u64' },
    SetInformationJobObject: { args: ['u64', 'u32', 'ptr', 'u32'], returns: 'bool' },
    AssignProcessToJobObject: { args: ['u64', 'u64'], returns: 'bool' },
    QueryInformationJobObject: { args: ['u64', 'u32', 'ptr', 'u32', 'ptr'], returns: 'bool' },
    GetCurrentProcess: { args: [], returns: 'u64' },
    GetLastError: { args: [], returns: 'u32' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
  }).symbols;
}
let kernel: ReturnType<typeof loadKernel> | undefined;
const api = () => kernel ??= loadKernel();
const wide = (value: string) => Buffer.from(value + '\0', 'utf16le');
const jobName = (owner: HostOwner) => {
  OpaqueIdSchema.parse(owner.instanceId); OpaqueIdSchema.parse(owner.startupToken);
  return 'Local\\MedClaw.' + owner.instanceId + '.' + owner.startupToken;
};
export interface HostOwner { instanceId: string; startupToken: string }
export interface HostJob { domain: HostJobDomain; readActiveProcesses(): number }
function active(handle: number | bigint) {
  const accounting = Buffer.alloc(48);
  if (!api().QueryInformationJobObject(handle, 1, ptr(accounting), accounting.length, null)) throw new Error('host_stop_unconfirmed');
  return accounting.readUInt32LE(40);
}
export function createHostJob(owner: HostOwner): HostJob {
  try {
    const name = jobName(owner), encoded = wide(name), native = api();
    const handle = native.CreateJobObjectW(null, ptr(encoded));
    if (!handle) throw new Error();
    if (native.GetLastError() === 183) { native.CloseHandle(handle); throw new Error(); }
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2000, 16); // x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION: KILL_ON_JOB_CLOSE, no breakaway.
    if (!native.SetInformationJobObject(handle, 9, ptr(limits), limits.length)
      || !native.AssignProcessToJobObject(handle, native.GetCurrentProcess())) { native.CloseHandle(handle); throw new Error(); }
    // The only handle stays in this Host until OS exit; explicitly closing it would also kill this process.
    return { domain: { contract: 'medclaw.host-job/v1', jobName: name, createdAt: new Date().toISOString() }, readActiveProcesses: () => active(handle) };
  } catch { throw new Error('host_process_tracking_unavailable'); }
}
export function inspectStoppedJob(owner: HostOwner, rawDomain: unknown): ProcessTreeProof | null {
  const domain = HostJobDomainSchema.parse(rawDomain);
  if (domain.jobName !== jobName(owner)) throw new Error('host_stop_unconfirmed');
  const native = api(), encoded = wide(domain.jobName), handle = native.OpenJobObjectW(4, false, ptr(encoded));
  let stopped: boolean;
  if (!handle) {
    if (native.GetLastError() !== 2) throw new Error('host_stop_unconfirmed');
    stopped = true;
  } else {
    try { stopped = active(handle) === 0; } finally { native.CloseHandle(handle); }
  }
  return stopped ? { instanceId: owner.instanceId, basis: 'windows_job_empty', observedAt: new Date().toISOString() } : null;
}
