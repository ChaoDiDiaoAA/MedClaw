import type { Configuration } from 'electron-builder';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url)), root = resolve(directory, '../..');
export default {
  appId: 'dev.medclaw.desktop', productName: 'MedClaw', electronVersion: '44.5.1',
  directories: { app: resolve(root, '.build/package-app'), output: resolve(root, '.build/installers'), buildResources: directory },
  electronDist: resolve(dirname(createRequire(import.meta.url).resolve('electron/package.json')), 'dist'),
  asar: true, npmRebuild: false, publish: null,
  files: ['main/**', 'preload/**', 'renderer/**', 'package.json'],
  extraResources: [{ from: resolve(root, '.build/package-resources/medclaw'), to: 'medclaw', filter: ['**/*'] }],
  win: { target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: false,
    artifactName: 'MedClaw-${version}-win-x64.${ext}' },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
    runAfterFinish: false, deleteAppDataOnUninstall: false, differentialPackage: false, packElevateHelper: false,
    include: resolve(directory, 'installer.nsh') },
} satisfies Configuration;
