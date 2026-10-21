import { isDeepStrictEqual } from 'node:util';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DefaultResourceLoader, SettingsManager, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { AppErrorSchema, PositiveIdSchema, safeError } from '@medclaw/contracts/error';
import { FrozenRunResourcesSchema, ResourceCatalogueSchema, ResourceFileSchema, ResourceRefSchema, ResourceSnapshotSchema, SubagentTemplateNameSchema, SubagentTemplateSourceSchema, RESOURCE_LIMITS, getSkillReadiness, resourceRefKey,
  type FrozenRunResources, type ResourceInputPlan, type ResourceDefinition, type ResourceDiagnostic, type ResourceDiagnosticReason, type ResourceFileSnapshot, type ResourceItem, type ResourceRef, type ResourceSnapshot, type ResourceSource } from '@medclaw/contracts/resources';
import { SaveSubagentRoleFileInputSchema, SubagentRoleContentSchema, SubagentRoleIdSchema, SubagentRoleSnapshotSchema, SubagentRoleToolsSchema, SUBAGENT_ROLE_LIMITS,
  type SubagentRoleDiagnostic, type SubagentRoleItem, type SubagentRoleSnapshot, type SubagentRoleSource } from '@medclaw/contracts/subagent';

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
    async captureSubagentTemplate(rawName) {
      const templateName = SubagentTemplateNameSchema.parse(rawName), file = `subagent-prompts/${templateName}.md`;
      const { content } = await readText(root, file);
      const { frontmatter, body } = parseFrontmatter(content);
      if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim() || !body.trim()
        || (body.match(/\$(?:ARGUMENTS|@|\d+)|\$\{/g) ?? []).join() !== '$ARGUMENTS') fail('resource_invalid');
      return SubagentTemplateSourceSchema.parse({ templateName, file, content });
    },
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

const roleFrontmatter = z.strictObject({ name: SubagentRoleIdSchema, description: z.string().trim().min(1).max(1024), tools: SubagentRoleToolsSchema });
const roleSaveQueues = new Map<string, Promise<unknown>>();
type RoleEntry = { item: SubagentRoleItem; snapshot: SubagentRoleSnapshot | null };
function parseRole(roleId: string, content: string, source: SubagentRoleSnapshot['source']): SubagentRoleSnapshot {
  SubagentRoleContentSchema.parse(content);
  const parsed = parseFrontmatter(content), fields = roleFrontmatter.parse(parsed.frontmatter);
  if (fields.name !== roleId || !parsed.body.trim()) fail('resource_invalid');
  return SubagentRoleSnapshotSchema.parse({ roleId, description: fields.description, source, content, declaredTools: fields.tools });
}
function roleDiagnostic(roleId: string | null, source: SubagentRoleSnapshot['source'], code: SubagentRoleDiagnostic['reason']): SubagentRoleDiagnostic {
  return { roleId, source, reason: code, message: `Subagent role verification: ${code}.` };
}

/** Author and user directories are supplied by the resolved application paths, never discovered from cwd. */
export function createSubagentRoleSource(authorRoot: string, userRoot: string): SubagentRoleSource {
  const roots = { builtin: resolve(authorRoot), user: resolve(userRoot) };
  const inspect = async () => {
    const entries = new Map<string, RoleEntry>(), diagnostics: SubagentRoleDiagnostic[] = [];
    for (const kind of ['builtin', 'user'] as const) {
      const root = roots[kind];
      try { await managedPath(root); }
      catch (error) { if (kind === 'user' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const files: string[] = [];
      for await (const entry of await opendir(root)) if (/\.md$/i.test(entry.name)) files.push(entry.name);
      const groups = new Map<string, string[]>();
      for (const file of files.sort()) {
        const id = file.slice(0, -3).toLowerCase();
        if (!SubagentRoleIdSchema.safeParse(id).success || !ResourceFileSchema.safeParse(file).success) {
          diagnostics.push(roleDiagnostic(null, { kind, file: file.slice(0, 256) }, 'resource_path_invalid')); continue;
        }
        const names = groups.get(id) ?? []; names.push(file); groups.set(id, names);
      }
      for (const [roleId, names] of groups) {
        const source = { kind, file: names[0]! };
        let snapshot: SubagentRoleSnapshot | null = null, code: SubagentRoleDiagnostic['reason'] | null = null;
        try {
          if (names.length !== 1) fail('resource_conflict');
          if (source.file !== `${roleId}.md`) fail('resource_path_invalid');
          snapshot = parseRole(roleId, (await readText(root, source.file, SUBAGENT_ROLE_LIMITS.fileBytes)).content, source);
        } catch (error) {
          const why = reason(error);
          code = why === 'resource_conflict' || why === 'resource_missing' || why === 'resource_changed' || why === 'resource_too_large' || why === 'resource_path_invalid' ? why : 'resource_invalid';
        }
        const item: SubagentRoleItem = { roleId, source, description: snapshot?.description ?? null, declaredTools: snapshot?.declaredTools ?? null,
          availability: code === 'resource_conflict' ? 'conflict' : code ? 'invalid' : 'ready', diagnostics: code ? [roleDiagnostic(roleId, source, code)] : [] };
        // An invalid user declaration still owns its ID and blocks fallback to the builtin.
        entries.set(roleId, { item, snapshot });
      }
    }
    if (entries.size > SUBAGENT_ROLE_LIMITS.roles || diagnostics.length + [...entries.values()].reduce((sum, entry) => sum + entry.item.diagnostics.length, 0) > 256) fail('resource_too_large');
    return { entries, diagnostics };
  };
  const read = async (roleId: string) => {
    if (!SubagentRoleIdSchema.safeParse(roleId).success) throw safeError('invalid_argument');
    const entry = (await inspect()).entries.get(roleId);
    if (!entry) fail('resource_missing');
    if (!entry.snapshot) fail(entry.item.diagnostics[0]?.reason ?? 'resource_invalid');
    return entry.snapshot;
  };
  return {
    async discover() { return { items: [...(await inspect()).entries.values()].map(entry => entry.item) }; },
    read,
    async capture() {
      const { entries, diagnostics } = await inspect();
      return { roles: [...entries.values()].flatMap(entry => entry.snapshot ? [entry.snapshot] : []), diagnostics: [...diagnostics, ...[...entries.values()].flatMap(entry => entry.item.diagnostics)] };
    },
    async save(raw) {
      const parsed = SaveSubagentRoleFileInputSchema.safeParse(raw);
      if (!parsed.success) throw safeError('invalid_argument');
      const input = parsed.data;
      try { parseRole(input.roleId, input.content, { kind: 'user', file: `${input.roleId}.md` }); }
      catch { throw safeError('invalid_argument'); }
      const key = process.platform === 'win32' ? roots.user.toLowerCase() : roots.user;
      const previous = roleSaveQueues.get(key) ?? Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        const checkExpected = async () => {
          const { entries } = await inspect(), entry = entries.get(input.roleId);
          if (input.expectedContent === null ? !!entry : entry?.snapshot?.content !== input.expectedContent) throw safeError('state_conflict');
          if (!entry && entries.size >= SUBAGENT_ROLE_LIMITS.roles) fail('resource_too_large');
        };
        await checkExpected();
        await managedPath(dirname(roots.user));
        try { await mkdir(roots.user); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw safeError('storage_write_failed'); }
        await managedPath(roots.user);
        const file = `${input.roleId}.md`, temporary = `.${input.roleId}.${crypto.randomUUID()}.tmp`, path = join(roots.user, temporary);
        try {
          const handle = await open(path, 'wx', 0o600);
          try { await handle.writeFile(input.content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
          await checkExpected(); await managedPath(roots.user, temporary);
          await rename(path, join(roots.user, file));
          const saved = await read(input.roleId);
          if (saved.content !== input.content) throw safeError('storage_write_failed');
          return saved;
        } catch (error) {
          if (AppErrorSchema.safeParse(error).success) throw error;
          throw safeError('storage_write_failed');
        } finally { await unlink(path).catch(() => {}); }
      });
      roleSaveQueues.set(key, operation);
      try { return await operation; } finally { if (roleSaveQueues.get(key) === operation) roleSaveQueues.delete(key); }
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
export async function materializeRunResources(runId: number, workdir: string, raw: FrozenRunResources, inputPlan?: ResourceInputPlan): Promise<{ skillPaths: string[]; promptPaths: string[] }> {
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
  if (inputPlan?.kind === 'subagent_template') {
    const source = SubagentTemplateSourceSchema.parse(inputPlan.source), directory = join(workdir, 'subagent-prompts');
    await managedPath(workdir);
    try { await mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await managedPath(workdir, 'subagent-prompts');
    const file = `${source.templateName}.md`, path = join(directory, file);
    try { const handle = await open(path, 'wx'); try { await handle.writeFile(source.content, 'utf8'); } finally { await handle.close(); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if ((await readText(directory, file)).content !== source.content) fail('resource_snapshot_invalid');
    promptPaths.push(path);
  }
  return { skillPaths, promptPaths };
}
