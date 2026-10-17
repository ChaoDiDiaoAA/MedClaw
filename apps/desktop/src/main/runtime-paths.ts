import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { InstallManifestSchema, LaunchSelectionSchema, RestoreRecordSchema, type InstallManifest } from '@medclaw/contracts/maintenance';
import type { EvaluationPaths } from '@medclaw/contracts/evaluation';

export interface LaunchPaths {
  preloadEntry: string; rendererEntry: string; bunExecutable: string; hostEntry: string; maintenanceEntry: string;
  runtimeRoot: string; resourceRoot: string; installManifestPath: string; dataRoot: string; evaluationPaths: EvaluationPaths;
}
export interface RuntimePathInput {
  isPackaged: boolean; resourcesPath: string; appPath: string; defaultUserData: string;
  engineeringOverrides?: { dataRoot?: string; hostEntry?: string; bunExecutable?: string; sourceRoot?: string; configsRoot?: string; runsRoot?: string };
}
function inside(root: string, target: string) {
  const path = relative(root, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
}
export function readInstallManifest(path: string): InstallManifest {
  try {
    if (statSync(path).size > 1024 * 1024) throw new Error();
    return InstallManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch { throw new Error('host_protocol_mismatch'); }
}
function installedPath(root: string, path: string, directory = false): string {
  try {
    const target = realpathSync(join(root, path));
    if (!inside(root, target) || (directory ? !statSync(target).isDirectory() : !statSync(target).isFile())) throw new Error();
    return target;
  } catch { throw new Error('host_dependency_unavailable'); }
}
export function resolveDesktopShellPaths(input: Pick<RuntimePathInput, 'isPackaged' | 'appPath'>): { preloadEntry: string; rendererEntry: string } {
  if (!isAbsolute(input.appPath)) throw new Error('invalid_argument');
  try {
    const root = realpathSync(input.isPackaged ? input.appPath : dirname(input.appPath));
    return { preloadEntry: installedPath(root, 'preload/index.cjs'), rendererEntry: installedPath(root, 'renderer/index.html') };
  } catch { throw new Error('host_dependency_unavailable'); }
}
export function selectedDataRoot(defaultRoot: string): string {
  const selectionPath = join(defaultRoot, 'launch.json');
  let selection: ReturnType<typeof LaunchSelectionSchema.parse>;
  try {
    if (statSync(selectionPath).size > 65536) throw new Error();
    selection = LaunchSelectionSchema.parse(JSON.parse(readFileSync(selectionPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultRoot;
    throw new Error('restore_failed');
  }
  try {
    const target = realpathSync(selection.activeDataRoot);
    const recordPath = join(target, 'data/restore-receipt.json');
    if (statSync(recordPath).size > 1048576) throw new Error();
    const saved = RestoreRecordSchema.parse(JSON.parse(readFileSync(recordPath, 'utf8')));
    if (saved.receipt.operationRef !== selection.restoreOperationRef || saved.request.targetRoot !== target) throw new Error();
    return target;
  } catch { throw new Error('restore_failed'); }
}
export function resolveRuntimePaths(input: RuntimePathInput): LaunchPaths {
  for (const path of [input.appPath, input.defaultUserData, ...(input.isPackaged ? [input.resourcesPath] : [])]) if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('invalid_argument');
  const shell = resolveDesktopShellPaths(input);
  const overrides = input.isPackaged ? {} : input.engineeringOverrides ?? {};
  const defaultRoot = resolve(overrides.dataRoot ?? input.defaultUserData);
  mkdirSync(defaultRoot, { recursive: true });
  const dataRoot = selectedDataRoot(realpathSync(defaultRoot));
  if (input.isPackaged) {
    const installRoot = installedPath(input.resourcesPath, 'medclaw', true);
    if (inside(installRoot, dataRoot) || inside(input.appPath, dataRoot)) throw new Error('access_denied');
    const installManifestPath = join(installRoot, 'install.json'), manifest = readInstallManifest(installManifestPath);
    const runtimeRoot = installedPath(installRoot, 'runtime', true);
    const hostEntry = installedPath(installRoot, manifest.hostEntry), maintenanceEntry = installedPath(installRoot, manifest.maintenanceEntry);
    const bunExecutable = installedPath(installRoot, manifest.binaries.find(value => value.name === 'bun')!.path);
    const resourceRoot = installedPath(installRoot, manifest.resourceRoot, true);
    return { ...shell, bunExecutable, hostEntry, maintenanceEntry, runtimeRoot, resourceRoot, installManifestPath, dataRoot,
      evaluationPaths: { sourceRoot: runtimeRoot, configsRoot: join(dataRoot, 'evaluation/configs'), runsRoot: join(dataRoot, 'evaluation/runs'), datasetsRoot: join(dataRoot, 'evaluation/datasets'), installManifestPath } };
  }
  const runtimeRoot = realpathSync(overrides.sourceRoot ?? resolve(input.appPath, '../../..'));
  const hostEntry = resolve(overrides.hostEntry ?? join(runtimeRoot, 'apps/host/src/main.ts'));
  const bunExecutable = overrides.bunExecutable;
  if (!bunExecutable || !isAbsolute(bunExecutable) || !isAbsolute(hostEntry)) throw new Error('invalid_argument');
  return { ...shell,
    bunExecutable: installedPath(dirname(bunExecutable), basename(bunExecutable)), hostEntry: installedPath(dirname(hostEntry), basename(hostEntry)), maintenanceEntry: join(runtimeRoot, 'apps/host/src/maintenance.ts'),
    runtimeRoot, resourceRoot: join(runtimeRoot, 'resources'), installManifestPath: join(runtimeRoot, '.build/package-resources/medclaw/install.json'), dataRoot,
    evaluationPaths: { sourceRoot: runtimeRoot, configsRoot: overrides.configsRoot ?? join(runtimeRoot, 'agent-eval/configs'), runsRoot: overrides.runsRoot ?? join(runtimeRoot, 'agent-eval/runs') } };
}
