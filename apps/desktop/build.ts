import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile, symlink, unlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { InstallManifestSchema, InstallRelativePathSchema, type InstallManifest } from '../../packages/contracts/src/maintenance';
import { DATABASE_SCHEMA_VERSION, HOST_PROTOCOL_VERSION } from '../../packages/contracts/src/protocol';

export async function buildDesktop(root: string, output: string): Promise<void> {
  for (const part of ['main', 'preload', 'renderer']) {
    const html = part === 'renderer';
    const build = await Bun.build({ entrypoints: [join(root, 'apps/desktop/src', part, html ? 'index.html' : 'index.ts')],
      outdir: join(output, part), target: html ? 'browser' : 'node', format: html ? 'esm' : 'cjs',
      external: html ? [] : ['electron'], ...(html ? {} : { naming: 'index.cjs' }) });
    if (!build.success) throw new AggregateError(build.logs, 'Desktop ' + part + ' build failed');
  }
  await writeFile(join(output, 'package.json'), JSON.stringify({ name: 'medclaw-desktop', productName: 'MedClaw', version: '0.1.0', main: 'main/index.cjs', private: true }, null, 2) + '\n');
}
export async function stageRuntimeSources(source: string, target: string): Promise<string[]> {
  const root = await realpath(source); await mkdir(target, { recursive: true });
  const destination = await realpath(target), part = relative(root, destination);
  if (part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep) && !part.startsWith('.build' + sep)) throw new Error('build_target_invalid');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!Array.isArray(manifest.workspaces) || manifest.workspaces.some((path: unknown) => !InstallRelativePathSchema.safeParse(path).success)) throw new Error('build_workspace_invalid');
  const files: string[] = [];
  async function copy(path: string): Promise<void> {
    if (path.startsWith('agent-eval/src/datasets/') || path === 'agent-eval/src/datasets'
      || path.startsWith('agent-eval/src/fixtures/') || path === 'agent-eval/src/fixtures') return;
    const origin = join(root, path), info = await lstat(origin);
    if (info.isSymbolicLink()) throw new Error('build_source_link_rejected');
    if (info.isDirectory()) {
      await mkdir(join(destination, path), { recursive: true });
      for (const child of (await readdir(origin)).sort()) await copy(path + '/' + child);
    } else if (info.isFile()) {
      await mkdir(join(destination, path, '..'), { recursive: true }); await copyFile(origin, join(destination, path)); files.push(path);
    } else throw new Error('build_source_invalid');
  }
  for (const path of ['package.json', 'bun.lock', 'resources', 'patches']) await copy(path);
  for (const workspace of manifest.workspaces as string[]) {
    await copy(workspace + '/package.json');
    await copy(workspace === 'apps/desktop' ? workspace + '/src/main' : workspace + '/src');
  }
  return files.sort();
}

async function run(args: string[], cwd: string, env = process.env): Promise<string> {
  const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error('Build command failed: ' + error.slice(-4000));
  return output;
}
async function freshOutput(root: string, name: string) {
  const base = join(root, '.build'); await mkdir(base, { recursive: true });
  if (await realpath(base) !== base) throw new Error('build_target_invalid');
  const path = join(base, name);
  if (dirname(path) !== base) throw new Error('build_target_invalid');
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('build_target_invalid'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await rm(path, { recursive: true, force: true }); await mkdir(path); return path;
}
async function verifyRuntimeDependencies(runtime: string) {
  const packageJson = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
  for (const name of Object.keys(packageJson.overrides).filter(name => name.startsWith('@earendil-works/'))) {
    const installed = JSON.parse(await readFile(join(runtime, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.version !== '0.87.1') throw new Error('build_sdk_mismatch');
  }
  async function links(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const actual = await realpath(path), target = relative(runtime, actual);
      if (isAbsolute(target) || target === '..' || target.startsWith('..' + sep)) throw new Error('build_dependency_link_rejected');
      const directory = (await stat(actual)).isDirectory();
      await unlink(path); await symlink(relative(dirname(path), actual), path, directory ? 'dir' : 'file');
    } else if (info.isDirectory()) for (const name of await readdir(path)) await links(join(path, name));
  }
  await links(join(runtime, 'node_modules'));
  try { await lstat(join(runtime, 'node_modules/electron')); throw new Error('build_electron_runtime_forbidden'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const probe = 'import {installedSdkVersion} from ' + JSON.stringify(pathToFileURL(join(runtime, 'packages/runtime-pi/src/model-runtime.ts')).href)
    + ';console.log(await installedSdkVersion());';
  if ((await run([process.execPath, '--no-env-file', '-e', probe], runtime)).trim() !== '0.87.1') throw new Error('build_sdk_mismatch');
}
async function prepareBinaries(root: string, installRoot: string): Promise<InstallManifest['binaries']> {
  const bin = join(installRoot, 'bin'), licenses = join(installRoot, 'licenses'); await mkdir(bin); await mkdir(licenses);
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error('build_dependency_unavailable');
  async function license(uri: string, name: string) {
    await run([join(systemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), '-NoProfile', '-NonInteractive', '-Command',
      "& { param($uri,$target) $ErrorActionPreference='Stop'; Invoke-WebRequest -Uri $uri -OutFile $target -TimeoutSec 30 }", uri, join(licenses, name)], root);
  }
  await copyFile(process.execPath, join(bin, 'bun.exe'));
  const sdkDirectory = join(installRoot, 'runtime/node_modules/@earendil-works/pi-coding-agent/dist');
  await license('https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.0/LICENSE.md', 'bun.txt');
  const toolsModule = pathToFileURL(join(sdkDirectory, 'utils/tools-manager.js')).href;
  const preparationRoot = join(root, '.build/sdk-prepare'); await mkdir(preparationRoot, { recursive: true });
  const source = 'const {ensureTool}=await import(' + JSON.stringify(toolsModule) + ');const paths={};for(const name of ["rg","fd"]){const path=await ensureTool(name);if(!path)throw new Error("build_dependency_unavailable");paths[name]=path;}console.log(JSON.stringify(paths));';
  const toolEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path'));
  const paths = JSON.parse(await run([process.execPath, '--no-env-file', '-e', source], root,
    { ...toolEnvironment, PATH: [join(systemRoot, 'System32'), join(systemRoot, 'System32/WindowsPowerShell/v1.0')].join(';'), PI_CODING_AGENT_DIR: preparationRoot }));
  const binaries: InstallManifest['binaries'] = [{ name: 'bun', version: '1.4.0', source: 'https://github.com/oven-sh/bun/releases/tag/bun-v1.4.0', path: 'bin/bun.exe' }];
  for (const name of ['rg', 'fd'] as const) {
    const executable = await realpath(paths[name]);
    if (dirname(executable) !== join(preparationRoot, 'bin')) throw new Error('build_dependency_unavailable');
    const output = await run([executable, '--version'], root), version = /^(?:ripgrep|fd) (\d+\.\d+\.\d+)/.exec(output)?.[1];
    if (!version) throw new Error('build_dependency_unavailable');
    const bytes = await readFile(executable), pe = bytes.readUInt32LE(0x3c);
    if (bytes.toString('ascii', 0, 2) !== 'MZ' || pe + 6 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error('build_binary_architecture_mismatch');
    await copyFile(executable, join(bin, name + '.exe'));
    const repository = name === 'rg' ? 'BurntSushi/ripgrep' : 'sharkdp/fd', tag = (name === 'fd' ? 'v' : '') + version;
    await license('https://raw.githubusercontent.com/' + repository + '/' + tag + '/LICENSE-MIT', name + '-LICENSE-MIT.txt');
    binaries.push({ name, version, source: 'https://github.com/' + repository + '/releases/tag/' + tag, path: 'bin/' + name + '.exe' });
  }
  return binaries;
}
export async function buildInstallation(root = resolve(import.meta.dir, '../..')) {
  root = await realpath(root);
  if (process.platform !== 'win32' || process.arch !== 'x64' || Bun.version !== '1.4.0') throw new Error('build_platform_mismatch');
  const appRoot = await freshOutput(root, 'package-app'), resourceParent = await freshOutput(root, 'package-resources');
  const installRoot = join(resourceParent, 'medclaw'), runtime = join(installRoot, 'runtime');
  await buildDesktop(root, appRoot); await stageRuntimeSources(root, runtime);
  console.log('Preparing production runtime dependencies');
  await run([process.execPath, 'install', '--production', '--frozen-lockfile', '--linker', 'hoisted', '--ignore-scripts'], runtime);
  await verifyRuntimeDependencies(runtime);
  console.log('Preparing fixed Windows binaries through Pi standard discovery');
  const binaries = await prepareBinaries(root, installRoot);
  const checker = await Bun.build({ entrypoints: [join(root, 'apps/host/src/installer-check.ts')], target: 'bun', format: 'esm',
    outdir: installRoot, naming: 'installer-check.js' });
  if (!checker.success) throw new AggregateError(checker.logs, 'Installer check build failed');
  const catalog = JSON.parse(await readFile(join(runtime, 'resources/catalog.json'), 'utf8'));
  const { parseFrontmatter } = await import('@earendil-works/pi-coding-agent');
  for (const [directory,names] of [['subagents',['medclaw-audit','general-analyst']],['subagent-prompts',['medclaw-evidence-review','parallel-medclaw-review']]] as const) {
    for(const name of names){
      const {frontmatter,body}=parseFrontmatter(await readFile(join(runtime,'resources',directory,name+'.md'),'utf8'));
      if(!body.trim()||typeof frontmatter.description!=='string'||!frontmatter.description.trim()||directory==='subagents'&&frontmatter.name!==name)throw new Error('build_subagent_resource_invalid');
    }
  }
  const plugin = JSON.parse(await readFile(join(runtime, 'node_modules/@tintinweb/pi-subagents/package.json'), 'utf8'));
  if (plugin.version !== '0.19.0') throw new Error('build_plugin_mismatch');
  const manifest = InstallManifestSchema.parse({ contract: 'medclaw.install/v1', appVersion: '0.1.0', platform: 'win32', arch: 'x64',
    sdkVersion: '0.87.1', bunVersion: Bun.version, electronVersion: '44.5.1', protocolVersion: HOST_PROTOCOL_VERSION, schemaVersion: DATABASE_SCHEMA_VERSION,
    hostEntry: 'runtime/apps/host/src/main.ts', maintenanceEntry: 'runtime/apps/host/src/maintenance.ts', resourceRoot: 'runtime/resources',
    resources: catalog.definitions.map(({ kind, id, version }: { kind: string; id: string; version: string }) => ({ kind, id, version })),
    plugins: [{ name: '@tintinweb/pi-subagents', version: plugin.version, patch: 'runtime/patches/@tintinweb%2Fpi-subagents@0.19.0.patch' }], binaries });
  await writeFile(join(installRoot, 'install.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('Desktop and runtime build prepared: ' + installRoot);
  return { appRoot, installRoot };
}
if (import.meta.main) await buildInstallation();
