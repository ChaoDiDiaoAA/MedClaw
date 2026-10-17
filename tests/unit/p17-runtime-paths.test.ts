import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_PROTOCOL_VERSION } from '../../packages/contracts/src/protocol';

async function resolver() {
  const module = await import('../../apps/desktop/src/main/runtime-paths').catch(() => null);
  expect(module?.resolveRuntimePaths).toBeFunction();
  return module!.resolveRuntimePaths;
}
function installation(root: string) {
  const appPath = join(root, 'resources/app.asar');
  const installRoot = join(root, 'resources/medclaw');
  for (const file of ['preload/index.cjs', 'renderer/index.html']) {
    const target = join(appPath, file); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, 'fixture');
  }
  const manifest = { contract: 'medclaw.install/v1', appVersion: '0.1.0', platform: 'win32', arch: 'x64',
    sdkVersion: '0.87.1', bunVersion: '1.4.0', electronVersion: '44.5.1', protocolVersion: HOST_PROTOCOL_VERSION, schemaVersion: 16,
    hostEntry: 'runtime/apps/host/src/main.ts', maintenanceEntry: 'runtime/apps/host/src/maintenance.ts', resourceRoot: 'runtime/resources',
    resources: [], plugins: [], binaries: [{ name: 'bun', version: '1.4.0', source: 'oven-sh/bun', path: 'bin/bun.exe' }] };
  for (const file of [manifest.hostEntry, manifest.maintenanceEntry, 'bin/bun.exe']) {
    const target = join(installRoot, file); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, 'fixture');
  }
  mkdirSync(join(installRoot, manifest.resourceRoot), { recursive: true });
  writeFileSync(join(installRoot, 'install.json'), JSON.stringify(manifest));
  return { appPath, installRoot, manifest };
}
test('packaged paths ignore engineering overrides and keep read-only resources outside writable user data', async () => {
  const resolvePaths = await resolver(), root = mkdtempSync(join(tmpdir(), 'MedClaw 中文 空格-'));
  try {
    const { appPath, installRoot } = installation(root), defaultUserData = join(root, '用户 数据');
    const paths = resolvePaths({ isPackaged: true, resourcesPath: join(root, 'resources'), appPath, defaultUserData,
      engineeringOverrides: { dataRoot: join(root, 'evil'), hostEntry: join(root, 'evil.ts'), bunExecutable: join(root, 'evil.exe') } });
    expect(paths.dataRoot).toBe(defaultUserData);
    expect(paths.hostEntry).toBe(join(installRoot, 'runtime/apps/host/src/main.ts'));
    expect(paths.bunExecutable).toBe(join(installRoot, 'bin/bun.exe'));
    expect(paths.preloadEntry).toBe(join(appPath, 'preload/index.cjs'));
    expect(paths.rendererEntry).toBe(join(appPath, 'renderer/index.html'));
    expect(paths.evaluationPaths).toEqual({ sourceRoot: join(installRoot, 'runtime'), configsRoot: join(defaultUserData, 'evaluation/configs'),
      runsRoot: join(defaultUserData, 'evaluation/runs'), datasetsRoot: join(defaultUserData, 'evaluation/datasets'), installManifestPath: join(installRoot, 'install.json') });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a missing or escaping installation resource fails without falling back to source or cwd', async () => {
  const resolvePaths = await resolver(), root = mkdtempSync(join(tmpdir(), 'medclaw-install-'));
  try {
    const { appPath, installRoot, manifest } = installation(root), input = { isPackaged: true, resourcesPath: join(root, 'resources'), appPath, defaultUserData: join(root, 'data') };
    rmSync(join(installRoot, 'bin/bun.exe'));
    expect(() => resolvePaths(input)).toThrow('host_dependency_unavailable');
    writeFileSync(join(installRoot, 'bin/bun.exe'), 'fixture');
    writeFileSync(join(installRoot, 'install.json'), JSON.stringify({ ...manifest, hostEntry: '../outside.ts' }));
    expect(() => resolvePaths(input)).toThrow('host_protocol_mismatch');
    writeFileSync(join(installRoot, 'install.json'), JSON.stringify({ ...manifest, sdkVersion: '0.87.2' }));
    expect(() => resolvePaths(input)).toThrow('host_protocol_mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('invalid persisted data-root selection is preserved and blocks initialization', async () => {
  const resolvePaths = await resolver(), root = mkdtempSync(join(tmpdir(), 'medclaw-launch-'));
  try {
    const { appPath } = installation(root), defaultUserData = join(root, 'data'); mkdirSync(defaultUserData);
    const launchPath = join(defaultUserData, 'launch.json'); writeFileSync(launchPath, '{bad');
    expect(() => resolvePaths({ isPackaged: true, resourcesPath: join(root, 'resources'), appPath, defaultUserData })).toThrow('restore_failed');
    expect(Bun.file(launchPath).size).toBe(4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a persisted root selection consumes the exact restore record written by maintenance', async () => {
  const resolvePaths = await resolver(), root = mkdtempSync(join(tmpdir(), 'medclaw-restored-launch-'));
  try {
    const { appPath, manifest } = installation(root), defaultUserData = join(root, 'data'), targetRoot = join(root, 'restored');
    mkdirSync(defaultUserData); mkdirSync(join(targetRoot, 'data'), { recursive: true });
    const operationRef = 'original-restore';
    writeFileSync(join(targetRoot, 'data/restore-receipt.json'), JSON.stringify({ request: { kind: 'restore', sourceBackup: join(root, 'backup'), targetRoot }, sourceOperationRef: 'original-backup', installation: manifest,
      receipt: { operationRef, kind: 'restore', state: 'completed', appVersion: '0.1.0', sdkVersion: '0.87.1', schemaVersion: 16, restoredAt: '2026-10-17T00:00:00.000Z', configVersion: '2' } }));
    writeFileSync(join(defaultUserData, 'launch.json'), JSON.stringify({ contract: 'medclaw.launch/v1', activeDataRoot: targetRoot, restoreOperationRef: operationRef }));
    const input = { isPackaged: true, resourcesPath: join(root, 'resources'), appPath, defaultUserData };
    expect(resolvePaths(input).dataRoot).toBe(targetRoot);
    writeFileSync(join(defaultUserData, 'launch.json'), JSON.stringify({ contract: 'medclaw.launch/v1', activeDataRoot: targetRoot, restoreOperationRef: 'another-operation' }));
    expect(() => resolvePaths(input)).toThrow('restore_failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('trusted desktop shell resolution does not select or initialize a business root after a launch error', async () => {
  const module = await import('../../apps/desktop/src/main/runtime-paths'), root = mkdtempSync(join(tmpdir(), 'medclaw-p17-shell-'));
  try {
    expect(module.resolveDesktopShellPaths).toBeFunction();
    const { appPath } = installation(root), defaultUserData = join(root, 'original'); mkdirSync(defaultUserData);
    writeFileSync(join(defaultUserData, 'launch.json'), '{bad');
    expect(() => module.resolveRuntimePaths({ isPackaged: true, resourcesPath: join(root, 'resources'), appPath, defaultUserData })).toThrow('restore_failed');
    expect(module.resolveDesktopShellPaths({ isPackaged: true, appPath })).toEqual({ preloadEntry: join(appPath, 'preload/index.cjs'), rendererEntry: join(appPath, 'renderer/index.html') });
    expect(Bun.file(join(defaultUserData, 'launch.json')).size).toBe(4);
    expect(await Bun.file(join(defaultUserData, 'data/app.sqlite')).exists()).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
