import { AppErrorSchema, safeError } from '@medclaw/contracts/error';
import type { PublishedSettings } from '@medclaw/contracts/model';
import { SubmitInputSchema, type SubmitInput } from '@medclaw/contracts/session';
import type { RunScope, RuntimeRunStore } from '@medclaw/contracts/run';
import { FrozenRunResourcesSchema, ResourceInputPlanSchema, ResourceItemSchema, ResourceListInputSchema, ResourceListSchema, ResourceReadInputSchema, ResourceSelectionSchema, ResourceSnapshotSchema, ResourceTextSchema, resourceRefKey,
  type FrozenRunResources, type ResourceDiagnostic, type ResourceDiagnosticReason, type ResourceInputPlan, type ResourceItem, type ResourceList, type ResourceListInput, type ResourceReadInput, type ResourceRef, type ResourceSelection, type ResourceSnapshot, type ResourceSource, type ResourceText } from '@medclaw/contracts/resources';

const emptySelection = (): ResourceSelection => ({ prompt: null, skills: [] });
const refs = (selection: ResourceSelection) => [...(selection.prompt ? [selection.prompt] : []), ...selection.skills];
const sameRef = (a: ResourceRef, b: ResourceRef) => resourceRefKey(a) === resourceRefKey(b);
function failure(reason: Exclude<ResourceDiagnosticReason, 'sdk_warning' | 'not_recorded'>): never { throw safeError('resource_unavailable', undefined, { reason }); }
const diagnostic = (resourceRef: ResourceRef | null, reason: ResourceDiagnosticReason): ResourceDiagnostic => ({ resourceRef, reason, file: null, message: `Resource verification: ${reason}.` });
function placeholder(ref: ResourceRef, code: 'resource_missing' | 'resource_changed' | 'resource_catalog_invalid'): ResourceItem {
  return { ref, name: null, description: null, keywords: [], enabled: true, availability: code === 'resource_changed' ? 'content_changed' : code === 'resource_missing' ? 'missing' : 'invalid',
    disableModelInvocation: null, files: [], requiredTools: null, requiredExtensions: null, diagnostics: [diagnostic(ref, code)] };
}
function asItem(snapshot: ResourceSnapshot): ResourceItem {
  const { entry, ...fields } = snapshot;
  return { ...fields, files: snapshot.files.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })), enabled: true, availability: 'ready', diagnostics: [] };
}

/** Published selection, immutable Run content and native evidence share the existing stores. */
export class ResourceService {
  constructor(private readonly readSettings: () => PublishedSettings,
    private readonly store: Pick<RuntimeRunStore, 'readSession' | 'read' | 'readRunResources' | 'readResourceEvidence'>,
    private readonly source: ResourceSource, private readonly configuredToolNames: (settings: PublishedSettings) => readonly string[]) {}
  private session(sessionId: number) {
    const session = this.store.readSession(sessionId); if (!session) throw safeError('input_invalid', undefined, { reason: 'session_not_found' });
    if (session.kind !== 'user') throw safeError('access_denied');
    if (session.deletedAt !== null) throw safeError('input_invalid', undefined, { reason: 'session_deleted' });
    return session;
  }
  private selection(settings: PublishedSettings, sessionId: number) { return ResourceSelectionSchema.parse(settings.resources?.bySession[String(sessionId)] ?? emptySelection()); }
  private decorate(item: ResourceItem, selection: ResourceSelection, allowedTools: readonly string[]): ResourceItem {
    const enabled = refs(selection).some(ref => sameRef(item.ref, ref));
    if (item.availability !== 'ready') return { ...item, enabled };
    const missing = item.requiredTools === null || item.requiredExtensions === null || item.requiredExtensions.length > 0 || item.requiredTools.some(name => !allowedTools.includes(name));
    return { ...item, enabled, ...(missing ? { availability: 'dependency_missing' as const, diagnostics: [...item.diagnostics, diagnostic(item.ref, 'resource_dependency_missing')] } : {}) };
  }
  private async discover(selection: ResourceSelection, allowedTools: readonly string[]) {
    try {
      const catalog = await this.source.discover(), items = catalog.items.map(i => this.decorate(ResourceItemSchema.parse(i), selection, allowedTools));
      for (const ref of refs(selection)) if (!items.some(i => sameRef(i.ref, ref))) items.push(placeholder(ref, items.some(i => i.ref.kind === ref.kind && i.ref.id === ref.id && i.ref.version === ref.version) ? 'resource_changed' : 'resource_missing'));
      return { items, diagnostics: items.flatMap(i => i.diagnostics), catalogError: null, promptNames: [...new Set(catalog.items.filter(i => i.ref.kind === 'prompt').map(i => i.ref.id))].sort() };
    } catch {
      const items = refs(selection).map(ref => placeholder(ref, 'resource_catalog_invalid'));
      return { items, diagnostics: items.flatMap(i => i.diagnostics), catalogError: safeError('resource_unavailable', undefined, { reason: 'resource_catalog_invalid' }), promptNames: [] };
    }
  }
  private run(runId: number) {
    const result = this.store.read({ runId, inputLimit: 1, outputLimit: 1, callLimit: 1 });
    if (result.kind !== 'one' || !result.run) throw safeError('run_not_found');
    if (result.run.kind !== 'agent') throw safeError('resource_unavailable');
    if (!this.store.readRunResources) throw safeError('storage_read_failed');
    const raw = this.store.readRunResources(runId), frozen = raw === null ? null : FrozenRunResourcesSchema.parse(raw);
    if (frozen && (frozen.sessionId !== result.run.sessionId || frozen.configVersion !== result.run.model.configVersion)) failure('resource_snapshot_invalid');
    return { run: result.run, frozen };
  }
  async list(raw: ResourceListInput): Promise<ResourceList> {
    const input = ResourceListInputSchema.parse(raw), page = input.evidencePage ?? 1, pageSize = input.evidencePageSize ?? 50;
    if (input.source === 'selection') {
      this.session(input.sessionId); const settings = this.readSettings(), selection = this.selection(settings, input.sessionId), catalog = await this.discover(selection, this.configuredToolNames(settings));
      return ResourceListSchema.parse({ source: 'selection', sessionId: input.sessionId, configVersion: settings.configVersion, selection, items: catalog.items, diagnostics: catalog.diagnostics, catalogError: catalog.catalogError,
        evidence: [], evidenceInfo: { page, pageSize, totalRows: 0, hasMore: false } });
    }
    const { run, frozen } = this.run(input.runId);
    if (!this.store.readResourceEvidence) throw safeError('storage_read_failed');
    const evidence = this.store.readResourceEvidence(input.runId, page, pageSize);
    return ResourceListSchema.parse({ source: 'run', runId: run.id, sessionId: run.sessionId, configVersion: run.model.configVersion,
      selection: frozen?.selection ?? emptySelection(), items: frozen?.available.map(asItem) ?? [], diagnostics: frozen?.omitted ?? [diagnostic(null, 'not_recorded')], catalogError: null,
      evidence: evidence.items, evidenceInfo: { page, pageSize, totalRows: evidence.totalRows, hasMore: page * pageSize < evidence.totalRows } });
  }
  async read(raw: ResourceReadInput): Promise<ResourceText> {
    const input = ResourceReadInputSchema.parse(raw); let snapshot: ResourceSnapshot, sessionId: number, configVersion: string;
    if (input.source === 'selection') {
      this.session(input.sessionId); const settings = this.readSettings(), selection = this.selection(settings, input.sessionId);
      if (!refs(selection).some(ref => sameRef(ref, input.resourceRef))) throw safeError('access_denied');
      const catalog = await this.discover(selection, this.configuredToolNames(settings));
      const item = catalog.items.find(i => sameRef(i.ref, input.resourceRef)); if (!item || item.availability !== 'ready') this.unavailable(item);
      const captured = await this.source.capture([input.resourceRef]); snapshot = ResourceSnapshotSchema.parse(captured[0]);
      sessionId = input.sessionId; configVersion = settings.configVersion;
    } else {
      const history = this.run(input.runId), found = history.frozen?.available.find(s => sameRef(s.ref, input.resourceRef));
      if (!found) throw safeError('access_denied'); snapshot = found; sessionId = history.run.sessionId; configVersion = history.run.model.configVersion;
    }
    if (!sameRef(snapshot.ref, input.resourceRef)) failure('resource_changed');
    const file = snapshot.files.find(f => f.file === input.file); if (!file) throw safeError('access_denied');
    return ResourceTextSchema.parse({ ...input, ...(input.source === 'run' ? { sessionId } : {}), configVersion, ...file });
  }
  private unavailable(item: ResourceItem | undefined): never {
    if (!item || item.availability === 'missing') failure('resource_missing');
    if (item.availability === 'conflict') failure('resource_conflict');
    if (item.availability === 'dependency_missing') failure('resource_dependency_missing');
    if (item.availability === 'content_changed') failure('resource_changed');
    const code = item.diagnostics.find(d => d.reason !== 'sdk_warning' && d.reason !== 'not_recorded')?.reason;
    failure(code && code !== 'sdk_warning' && code !== 'not_recorded' ? code : 'resource_invalid');
  }
  async validateSelection(sessionId: number, raw: ResourceSelection, allowedTools: readonly string[]): Promise<ResourceSelection> {
    this.session(sessionId); const selection = ResourceSelectionSchema.parse(raw), current = refs(this.selection(this.readSettings(), sessionId));
    for (const ref of refs(selection)) if (current.some(prior => prior.kind === ref.kind && prior.id === ref.id && prior.version === ref.version && prior.treeHash !== ref.treeHash)) failure('resource_changed');
    if (!refs(selection).length) return selection;
    const catalog = await this.discover(selection, allowedTools);
    for (const ref of refs(selection)) { const item = catalog.items.find(i => sameRef(i.ref, ref)); if (!item || item.availability !== 'ready') this.unavailable(item); }
    const snapshots = await this.source.capture(refs(selection));
    if (snapshots.length !== refs(selection).length || snapshots.some((s, i) => !sameRef(ResourceSnapshotSchema.parse(s).ref, refs(selection)[i]!))) failure('resource_changed');
    return selection;
  }
  async freeze(sessionId: number, settings: PublishedSettings, scope: RunScope): Promise<FrozenRunResources> {
    this.session(sessionId); const selection = this.selection(settings, sessionId), available: ResourceSnapshot[] = [], omitted: ResourceDiagnostic[] = [];
    let knownPromptNames: string[] = [];
    if (refs(selection).length) {
      const catalog = await this.discover(selection, scope.allowedToolNames); knownPromptNames = catalog.promptNames;
      for (const ref of refs(selection)) try {
        const item = catalog.items.find(i => sameRef(i.ref, ref)); if (!item || item.availability !== 'ready') this.unavailable(item);
        const captured = await this.source.capture([ref]), snapshot = ResourceSnapshotSchema.parse(captured[0]);
        if (captured.length !== 1 || !sameRef(snapshot.ref, ref)) failure('resource_changed'); available.push(snapshot);
      } catch (error) {
        const parsed = AppErrorSchema.safeParse(error), code = parsed.success && parsed.data.reason?.startsWith('resource_') ? parsed.data.reason as ResourceDiagnosticReason : 'resource_invalid'; omitted.push(diagnostic(ref, code));
      }
    }
    const frozen = FrozenRunResourcesSchema.safeParse({ contract: 'medclaw.run-resources/v1', sdkVersion: '0.87.1', sessionId, configVersion: settings.configVersion, selection, available, knownPromptNames, omitted });
    if (!frozen.success) failure('resource_too_large'); return frozen.data;
  }
  planInput(raw: FrozenRunResources, request: SubmitInput): ResourceInputPlan {
    const frozen = FrozenRunResourcesSchema.parse(raw), input = SubmitInputSchema.parse(request);
    if (!input.text.isWellFormed()) throw safeError('invalid_argument');
    if (input.sessionId !== frozen.sessionId || input.model.expectedConfigVersion !== frozen.configVersion) throw safeError('state_conflict');
    const required = (ref: ResourceRef | undefined | null) => {
      if (!ref) failure('resource_missing');
      if (!frozen.available.some(s => sameRef(s.ref, ref))) {
        const code = frozen.omitted.find(d => d.resourceRef && sameRef(d.resourceRef, ref))?.reason;
        failure(code && code !== 'sdk_warning' && code !== 'not_recorded' ? code : 'resource_missing');
      }
      return ref;
    };
    const command = input.text.startsWith('/') ? input.text.slice(1).split(' ')[0]! : '';
    if (command.startsWith('skill:')) return ResourceInputPlanSchema.parse({ kind: 'skill', resourceRef: required(frozen.selection.skills.find(ref => 'skill:' + ref.id === command)), dispatchText: input.text });
    if (command && frozen.knownPromptNames.includes(command)) return ResourceInputPlanSchema.parse({ kind: 'prompt', resourceRef: required(frozen.selection.prompt?.id === command ? frozen.selection.prompt : null), dispatchText: input.text });
    if (input.mode === 'send' && frozen.selection.prompt) return ResourceInputPlanSchema.parse({ kind: 'prompt', resourceRef: required(frozen.selection.prompt),
      dispatchText: '/' + frozen.selection.prompt.id + ' ' + input.text.split('"').map(part => '"' + part + '"').join("'\"'") });
    return { kind: 'plain', resourceRef: null, dispatchText: input.text };
  }
}
