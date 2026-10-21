import { isDeepStrictEqual } from 'node:util';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { AppErrorSchema, PositiveIdSchema, safeError } from '@medclaw/contracts/error';
import { FrozenRunResourcesSchema, ResourceCatalogueSchema, ResourceFileSchema, ResourceRefSchema, ResourceSnapshotSchema, RESOURCE_LIMITS, getSkillReadiness, resourceRefKey,
  type FrozenRunResources, type ResourceDefinition, type ResourceDiagnostic, type ResourceDiagnosticReason, type ResourceFileSnapshot, type ResourceItem, type ResourceRef, type ResourceSnapshot, type ResourceSource } from '@medclaw/contracts/resources';

type ResourceFailureReason = Exclude<ResourceDiagnosticReason, 'not_recorded' | 'sdk_warning'>;
export function formatSkillReadinessSection(frozen: FrozenRunResources, allowedTools: readonly string[]): string {
  const rows=(frozen.skillRequirements??[]).filter(declaration=>{
    const snapshot=frozen.available.find(s=>resourceRefKey(s.ref)===resourceRefKey(declaration.resourceRef));
    return declaration.disableModelInvocation===false || declaration.disableModelInvocation===undefined&&snapshot?.disableModelInvocation===false;
  }).map(declaration=>{
    const readiness=getSkillReadiness(declaration.requiredTools,allowedTools,'run_scope');
    let count=`${readiness.matchedCount}/${readiness.totalCount} capabilities`;
    if(readiness.state==='unknown')count='Unknown';
    else if(readiness.state==='no_requirements')count='No requirements';
    const available=frozen.available.some(s=>resourceRefKey(s.ref)===resourceRefKey(declaration.resourceRef));
    return `${declaration.resourceRef.id}@${declaration.resourceRef.version}: ${readiness.state} (${count}); resource=${available?'available':'unavailable'}${readiness.missingTools.length?`; missing Tools: ${readiness.missingTools.map(t=>t.name).join(', ')}`:''}`;
  });
  return rows.length?`<skill_readiness>\nTool matches describe capabilities, not permission or instruction adherence. Read Skill guidance only when needed.\n${rows.join('\n')}\n</skill_readiness>`:'';
}
function fail(reason: ResourceFailureReason): never { throw safeError('resource_unavailable', undefined, { reason }); }
function reason(error: unknown): ResourceFailureReason {
  const parsed = AppErrorSchema.safeParse(error);
  if (parsed.success && parsed.data.reason?.startsWith('resource_')) return parsed.data.reason as ResourceFailureReason;
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'resource_missing' : 'resource_invalid';
}
const diagnostic = (resourceRef: ResourceRef | null, code: ResourceDiagnosticReason, file: string | null = null): ResourceDiagnostic =>
  ({ resourceRef, reason: code, file, message: `Resource verification: ${code}.` });
const refOf = ({ kind, id, version }: ResourceRef): ResourceRef => ({ kind, id, version });

/** Same lstat/realpath boundary as managed artifacts, with bounded opened-file reads. */
export async function managedPath(root: string, file = '') {
  if (file && !ResourceFileSchema.safeParse(file).success) fail('resource_path_invalid');
  const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('resource_path_invalid');
  const canonicalRoot = await realpath(root); let path = root;
  for (const part of file.split('/').filter(Boolean)) {
    path = join(path, part); const current = await lstat(path);
    if (current.isSymbolicLink()) fail('resource_path_invalid');
    const rel = relative(canonicalRoot, await realpath(path));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('resource_path_invalid');
  }
  return path;
}
export async function readText(root: string, file: string, limit = RESOURCE_LIMITS.fileBytes): Promise<ResourceFileSnapshot> {
  const path = await managedPath(root, file), before = await lstat(path);
  if (!before.isFile()) fail('resource_path_invalid'); if (before.size > limit) fail('resource_too_large');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile()) fail('resource_path_invalid');
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
    if (length > limit) fail('resource_too_large');
    await managedPath(root, file); const after = await lstat(path), final = await handle.stat();
    if (after.ino !== opened.ino || after.dev !== opened.dev || before.size !== final.size || before.mtimeMs !== final.mtimeMs || length !== final.size) fail('resource_changed');
    const body = bytes.subarray(0, length); let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch { return fail('resource_invalid'); }
    if (!Buffer.from(content, 'utf8').equals(body)) fail('resource_invalid');
    return { file, content, bytes: length };
  } finally { await handle.close(); }
}
async function verifyFileSet(root: string, directory: string, files: string[]) {
  const visit = async (prefix: string): Promise<void> => {
    const path = await managedPath(root, [directory, prefix].filter(Boolean).join('/'));
    if (!(await lstat(path)).isDirectory()) fail('resource_path_invalid');
    for await (const entry of await opendir(path)) {
      const file = [prefix, entry.name].filter(Boolean).join('/');
      if (!ResourceFileSchema.safeParse(file).success) fail('resource_path_invalid');
      if (files.includes(file)) { const stat = await lstat(await managedPath(root, `${directory}/${file}`)); if (!stat.isFile()) fail('resource_path_invalid'); }
      else if (files.some(f => f.startsWith(file + '/'))) await visit(file);
      else fail('resource_changed');
    }
  };
  await visit('');
}
async function filesFor(root: string, definition: ResourceDefinition | ResourceSnapshot) {
  const directory = dirname(definition.entry).split(sep).join('/'), names = definition.files.map(f => typeof f === 'string' ? f : f.file);
  await verifyFileSet(root, directory, names);
  const files: ResourceFileSnapshot[] = [];
  for (const name of names.sort()) { const file = await readText(root, `${directory}/${name}`); files.push({ ...file, file: name }); }
  if (files.reduce((n, f) => n + f.bytes, 0) > RESOURCE_LIMITS.versionBytes) fail('resource_too_large');
  return files;
}
async function parseVersion(root: string, definition: ResourceDefinition) {
  const ref = refOf(definition), files = await filesFor(root, definition);
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, '.managed-inspection'),
    settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], skills: [], prompts: [], themes: [], defaultTools: [], enableAnalytics: false, enableInstallTelemetry: false }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [],
    additionalSkillPaths: definition.kind === 'skill' ? [join(root, definition.entry)] : [], additionalPromptTemplatePaths: definition.kind === 'prompt' ? [join(root, definition.entry)] : [] });
  await loader.reload();
  const loaded = definition.kind === 'skill' ? loader.getSkills() : loader.getPrompts();
  const diagnostics = loaded.diagnostics.map(d => ({ ...diagnostic(ref, 'sdk_warning', definition.entry.split('/').at(-1)!), message: `SDK ${d.type}: ${d.message.replaceAll(root, '<managed>').slice(0, 900)}` }));
  const resource = definition.kind === 'skill' ? loader.getSkills().skills[0] : loader.getPrompts().prompts[0];
  if (!resource || resource.name !== definition.id || loaded.diagnostics.some(d => d.type === 'error' || d.type === 'collision')) fail('resource_invalid');
  if (definition.kind === 'prompt') {
    const content = loader.getPrompts().prompts[0]!.content;
    const placeholders = content.match(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g) ?? [];
    if (placeholders.length !== 1 || placeholders[0] !== '$ARGUMENTS') fail('resource_invalid');
  }
  const snapshot = ResourceSnapshotSchema.safeParse({ ref, name: resource.name, description: resource.description, keywords: definition.keywords, entry: definition.entry,
    requiredTools: definition.requiredTools, requiredExtensions: definition.requiredExtensions, disableModelInvocation: 'disableModelInvocation' in resource ? resource.disableModelInvocation : false, files });
  if (!snapshot.success) fail('resource_invalid');
  const after = await filesFor(root, definition); if (!isDeepStrictEqual(files, after)) fail('resource_changed');
  return { snapshot: snapshot.data, diagnostics };
}
const metadata = (snapshot: ResourceSnapshot, diagnostics: ResourceDiagnostic[]): ResourceItem => {
  const { entry, ...fields } = snapshot;
  return { ...fields, files: snapshot.files.map(({ file, bytes }) => ({ file, bytes })), enabled: false, availability: 'ready', diagnostics };
};

export function createResourceSource(authorRoot: string): ResourceSource {
  const root = resolve(authorRoot);
  const catalogue = async () => {
    try { return ResourceCatalogueSchema.parse(JSON.parse((await readText(root, 'catalog.json', RESOURCE_LIMITS.replyBytes)).content)); }
    catch { return fail('resource_catalog_invalid'); }
  };
  return {
    async discover() {
      const catalog = await catalogue(), items: ResourceItem[] = [];
      for (const definition of catalog.definitions) {
        const ref = refOf(definition);
        try {
          if (catalog.definitions.filter(d => d.kind === ref.kind && d.id === ref.id && d.version === ref.version).length !== 1) fail('resource_conflict');
          const parsed = await parseVersion(root, definition); items.push(metadata(parsed.snapshot, parsed.diagnostics));
        } catch (error) {
          const code = reason(error), availability = code === 'resource_missing' ? 'missing' : code === 'resource_conflict' ? 'conflict' : code === 'resource_changed' ? 'content_changed' : 'invalid';
          items.push({ ref, name: null, description: null, keywords: definition.keywords, requiredTools: definition.requiredTools, requiredExtensions: definition.requiredExtensions,
            files: [], disableModelInvocation: null, enabled: false, availability, diagnostics: [diagnostic(ref, code)] });
        }
      }
      return { items, diagnostics: items.flatMap(i => i.diagnostics) };
    },
    async capture(refs) {
      const catalog = await catalogue(), snapshots: ResourceSnapshot[] = [];
      for (const raw of refs) {
        const ref = ResourceRefSchema.parse(raw), candidates = catalog.definitions.filter(d => d.kind === ref.kind && d.id === ref.id && d.version === ref.version);
        if (!candidates.length) fail('resource_missing'); if (candidates.length !== 1) fail('resource_conflict');
        try { snapshots.push((await parseVersion(root, candidates[0]!)).snapshot); } catch (error) { fail(reason(error)); }
      }
      return snapshots;
    },
  };
}

function checkedFrozen(raw: FrozenRunResources) {
  const frozen = FrozenRunResourcesSchema.safeParse(raw); if (!frozen.success) fail('resource_snapshot_invalid');
  return frozen.data;
}
export async function verifyRunResourceFiles(workdir: string, raw: FrozenRunResources): Promise<void> {
  const frozen = checkedFrozen(raw); if (!frozen.available.length) return;
  try { const root = await managedPath(workdir, 'resources'); for (const snapshot of frozen.available) if (!isDeepStrictEqual(await filesFor(root, snapshot), [...snapshot.files].sort((a,b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) fail('resource_snapshot_invalid'); }
  catch (error) { if (reason(error) === 'resource_path_invalid') fail('resource_path_invalid'); fail('resource_snapshot_invalid'); }
}
export async function materializeRunResources(runId: number, workdir: string, raw: FrozenRunResources): Promise<{ skillPaths: string[]; promptPaths: string[] }> {
  PositiveIdSchema.parse(runId); const frozen = checkedFrozen(raw), root = join(workdir, 'resources');
  if (frozen.available.length) {
    await managedPath(workdir);
    const directory = async (relativeDirectory: string) => {
      let prefix = '';
      for (const part of relativeDirectory.split('/')) {
        prefix = [prefix, part].filter(Boolean).join('/');
        try { await mkdir(join(workdir, prefix)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const path = await managedPath(workdir, prefix); if (!(await lstat(path)).isDirectory()) fail('resource_path_invalid');
      }
    };
    for (const snapshot of frozen.available) for (const file of snapshot.files) {
      const relativeFile = `resources/${dirname(snapshot.entry).split(sep).join('/')}/${file.file}`; await directory(dirname(relativeFile).split(sep).join('/'));
      try { const handle = await open(join(workdir, relativeFile), 'wx'); try { await handle.writeFile(Buffer.from(file.content, 'utf8')); } finally { await handle.close(); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    await verifyRunResourceFiles(workdir, frozen);
  }
  const skillPaths = frozen.available.filter(s => s.ref.kind === 'skill').map(s => join(root, s.entry)), promptPaths = frozen.available.filter(s => s.ref.kind === 'prompt').map(s => join(root, s.entry));
  return { skillPaths, promptPaths };
}
