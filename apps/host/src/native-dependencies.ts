import { copyFile, lstat, mkdir, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { InstallManifestSchema, NativeDependencySchema, type NativeDependency } from '@medclaw/contracts/maintenance';
import { AppErrorSchema, safeError } from '@medclaw/contracts/error';
import type { HostHello } from '@medclaw/contracts/protocol';

const execute = promisify(execFile);
function contained(root: string, target: string) {
  const path = relative(root, target);
  if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) throw new Error('access_denied');
  return target;
}
export async function prepareNativeDependencies(config: HostHello): Promise<NativeDependency[]> {
  let manifest: ReturnType<typeof InstallManifestSchema.parse>;
  try { manifest = InstallManifestSchema.parse(JSON.parse(await readFile(config.installManifestPath, 'utf8'))); }
  catch { throw new Error('host_protocol_mismatch'); }
  const installRoot = await realpath(dirname(config.installManifestPath)), directory = join(config.paths.dataRoot, 'runtime/sdk/bin');
  try { await mkdir(directory, { recursive: true }); }
  catch { throw safeError('storage_write_failed'); }
  contained(config.paths.dataRoot, await realpath(directory));
  const sdkRoot = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const { getToolPath } = await import(pathToFileURL(join(sdkRoot, 'utils/tools-manager.js')).href);
  const { getShellConfig, getPowerShellConfig } = await import(pathToFileURL(join(sdkRoot, 'utils/shell.js')).href);
  const observations: NativeDependency[] = [];
  for (const name of ['rg', 'fd', 'bash', 'powershell'] as const) {
    try {
      let path: string, expectedVersion: string | undefined, args = ['--version'];
      if (name === 'rg' || name === 'fd') {
        const binary = manifest.binaries.find(binary => binary.name === name);
        if (!binary) throw new Error();
        const source = contained(installRoot, await realpath(join(installRoot, binary.path))), target = join(directory, name + '.exe');
        const bytes = await readFile(source); let current: Buffer | null = null;
        try {
          try { const info = await lstat(target); if (info.isSymbolicLink() || !info.isFile()) throw safeError('access_denied'); current = await readFile(target); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (!current?.equals(bytes)) {
          const temporary = target + '.' + randomUUID() + '.tmp';
          try {
            await copyFile(source, temporary);
            if (!(await readFile(temporary)).equals(bytes)) throw new Error('storage_write_failed');
            await rename(temporary, target);
          } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
          }
        } catch (error) { throw AppErrorSchema.safeParse(error).success ? error : safeError('storage_write_failed'); }
        path = await realpath(getToolPath(name));
        if (path !== await realpath(target)) throw new Error();
        expectedVersion = binary.version;
      } else if (name === 'powershell') {
        const selected = getPowerShellConfig();
        // Windows App Execution Aliases can execute while refusing realpath; use the SDK's path and probe it directly.
        path = selected.shell;
        if (!isAbsolute(path)) throw new Error();
        args = [...selected.args, '$PSVersionTable.PSVersion.ToString()'];
      } else path = await realpath(getShellConfig().shell);
      const { stdout } = await execute(path, args, { windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' });
      const first = stdout.trim().split(/\r?\n/)[0]!;
      const version = name === 'rg' || name === 'fd' ? /^(?:ripgrep|fd) (\d+\.\d+\.\d+)/.exec(first)?.[1] : first;
      if (!version || expectedVersion && expectedVersion !== version) throw new Error();
      observations.push(NativeDependencySchema.parse({ name, path, version, source: name === 'rg' || name === 'fd' ? 'installed_bundle' : 'sdk_standard_discovery' }));
    } catch (error) {
      if (AppErrorSchema.safeParse(error).success) throw error;
      throw safeError('host_dependency_unavailable', undefined, { reason: ('dependency_' + name + '_unavailable') as 'dependency_rg_unavailable' | 'dependency_fd_unavailable' | 'dependency_bash_unavailable' | 'dependency_powershell_unavailable' });
    }
  }
  return observations;
}
