import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const command = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.kind -eq 'file') { [System.IO.File]::Move($request.source, $request.target) }
  elseif ($request.kind -eq 'directory') { [System.IO.Directory]::Move($request.source, $request.target) }
  else { exit 1 }
  exit 0
} catch {
  if ($request -and ([System.IO.File]::Exists($request.target) -or [System.IO.Directory]::Exists($request.target))) { exit 17 }
  exit 1
}`;

const pinCommand = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class MedClawDirectoryPin {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
}
'@
$handles = @()
try {
  $request = [Console]::In.ReadLine() | ConvertFrom-Json
  foreach ($path in $request.paths) {
    $handle = [MedClawDirectoryPin]::CreateFile($path, 1, 3, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
    if ($handle.IsInvalid) { $handle.Dispose(); throw 'Directory pin failed' }
    $handles += $handle
  }
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally { foreach ($handle in $handles) { $handle.Dispose() } }
`;

/** Excluding FILE_SHARE_DELETE pins every ancestor until the path-based copy and move settle. */
export async function pinDirectory(path: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  if (process.platform !== 'win32' || !isAbsolute(path)) throw new Error('export_destination_invalid');
  signal?.throwIfAborted();
  const paths: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) { paths.unshift(current); if (dirname(current) === current) break; }
  return await new Promise((accept, reject) => {
    const child = spawn(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(pinCommand, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let ready = false, stopping = false, output = '';
    const stopped = new Promise<void>(resolve => child.once('close', () => resolve()));
    const finish = () => { child.stdin.end(); };
    const stop = (kill: boolean) => {
      if (ready || stopping) return;
      stopping = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (kill) child.kill(); else finish();
      void stopped.then(() => reject(new Error('export_destination_invalid')));
    };
    const timer = setTimeout(() => stop(true), 10000);
    const abort = () => stop(false);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('export_destination_invalid')); });
    child.once('close', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (!ready) reject(new Error('export_destination_invalid')); });
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (!ready && !stopping && output.includes('READY')) {
        ready = true; clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        accept(async () => { finish(); await stopped; });
      }
    });
    child.stdin.write(JSON.stringify({ paths }) + '\n', 'utf8');
    if (signal?.aborted) abort();
  });
}

/** .NET's two-argument moves reject even an existing empty directory; ordinary rename may replace it. */
export async function publishNoReplace(source: string, target: string, kind: 'file' | 'directory', signal?: AbortSignal): Promise<void> {
  if (!isAbsolute(source) || !isAbsolute(target) || dirname(resolve(source)).toLowerCase() !== dirname(resolve(target)).toLowerCase()
    || resolve(source).toLowerCase() === resolve(target).toLowerCase() || !['file', 'directory'].includes(kind)) throw new Error('invalid_argument');
  if (process.platform !== 'win32') throw new Error('publish_failed');
  signal?.throwIfAborted();
  await new Promise<void>((accept, reject) => {
    const executable = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', () => reject(new Error('publish_failed')));
    child.stdin.on('error', () => {}); // Process close is authoritative, including early exit before reading stdin.
    child.once('close', code => code === 0 ? accept() : reject(new Error(code === 17 ? 'destination_conflict' : 'publish_failed')));
    child.stdin.end(JSON.stringify({ source: resolve(source), target: resolve(target), kind }), 'utf8');
    // A move already started must settle; aborting the helper would hide whether publication happened.
  });
}
