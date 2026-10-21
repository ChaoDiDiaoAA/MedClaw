import { AppErrorSchema, safeError } from '@medclaw/contracts/error';
import type { PublishedSettings } from '@medclaw/contracts/model';
import { SubmitInputSchema, type SubmitInput } from '@medclaw/contracts/session';
import type { RunScope, RuntimeRunStore } from '@medclaw/contracts/run';
import { FrozenRunResourcesSchema, ResourceInputPlanSchema, ResourceItemSchema, ResourceListInputSchema, ResourceListSchema, ResourceReadInputSchema, ResourceSelectionSchema, ResourceSnapshotSchema, ResourceTextSchema, SubagentTemplateNameSchema, InputCommandsListInputSchema, InputCommandsListSchema, resourceRefKey, getSkillReadiness, resourceCommand,
  type FrozenRunResources, type InputCommandsList, type InputCommandsListInput, type ResourceDiagnostic, type ResourceDiagnosticReason, type ResourceInputPlan, type ResourceItem, type ResourceList, type ResourceListInput, type ResourceReadInput, type ResourceRef, type ResourceSelection, type ResourceSnapshot, type ResourceSource, type ResourceText } from '@medclaw/contracts/resources';
import { FrozenRunSubagentsSchema, SubagentsListInputSchema, SubagentsListSchema, SubagentsReadInputSchema, SubagentsReadSchema, SubagentsSaveInputSchema,
  type FrozenRunSubagents, type SubagentRoleItem, type SubagentRoleSnapshot, type SubagentRoleSource, type SubagentsList, type SubagentsListInput, type SubagentsRead, type SubagentsReadInput, type SubagentsSaveInput } from '@medclaw/contracts/subagent';

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
  return { ...fields, files: snapshot.files.map(({ file, bytes }) => ({ file, bytes })), enabled: true, availability: 'ready', diagnostics: [] };
}

/** Published selection, immutable Run content and native evidence share the existing stores. */
export class ResourceService {
  constructor(private readonly readSettings: () => PublishedSettings,
    private readonly store: Pick<RuntimeRunStore, 'readSession' | 'read' | 'readRunResources' | 'readResourceEvidence' | 'readRunResourceScope' | 'readRunSubagents'>,
    private readonly source: ResourceSource, private readonly configuredToolNames: (settings: PublishedSettings) => readonly string[],
    private readonly roleSource?: SubagentRoleSource, private readonly readOnlyToolNames: () => readonly string[] = () => []) {}
  private session(sessionId: number) {
    const session = this.store.readSession(sessionId); if (!session) throw safeError('input_invalid', undefined, { reason: 'session_not_found' });
    if (session.kind !== 'user') throw safeError('access_denied');
    if (session.deletedAt !== null) throw safeError('input_invalid', undefined, { reason: 'session_deleted' });
    return session;
  }
  private selection(settings: PublishedSettings, sessionId: number) { return ResourceSelectionSchema.parse(settings.resources?.bySession[String(sessionId)] ?? emptySelection()); }
  private decorate(item: ResourceItem, selection: ResourceSelection, allowedTools: readonly string[]): ResourceItem {
    const enabled = refs(selection).some(ref => sameRef(item.ref, ref));
    const readiness=item.ref.kind==='skill'?{readiness:getSkillReadiness(item.requiredTools,allowedTools,'configuration')}:{};
    if (item.availability !== 'ready') return { ...item, enabled, ...readiness };
    const missing = item.requiredTools === null || item.requiredExtensions === null || item.requiredExtensions.length > 0 || item.requiredTools.some(name => !allowedTools.includes(name));
    return { ...item, enabled, ...readiness, ...(missing ? { availability: 'dependency_missing' as const, diagnostics: [...item.diagnostics, diagnostic(item.ref, 'resource_dependency_missing')] } : {}) };
  }
  private async discover(selection: ResourceSelection, allowedTools: readonly string[]) {
    try {
      const catalog = await this.source.discover(), items = catalog.items.map(i => this.decorate(ResourceItemSchema.parse(i), selection, allowedTools));
      for (const ref of refs(selection)) if (!items.some(i => sameRef(i.ref, ref))) items.push(this.decorate(placeholder(ref, 'resource_missing'),selection,allowedTools));
      return { items, diagnostics: items.flatMap(i => i.diagnostics), catalogError: null, promptNames: [...new Set(catalog.items.filter(i => i.ref.kind === 'prompt').map(i => i.ref.id))].sort() };
    } catch {
      const items = refs(selection).map(ref => this.decorate(placeholder(ref, 'resource_catalog_invalid'),selection,allowedTools));
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
    const tools=this.store.readRunResourceScope?.(input.runId)?.allowedToolNames??null;
    const items=frozen?.available.map(asItem)??[];
    for(const ref of frozen?.selection.skills??[])if(!items.some(i=>sameRef(i.ref,ref))){
      const requirement=frozen?.skillRequirements?.find(s=>sameRef(s.resourceRef,ref));
      const omitted=frozen?.omitted.filter(d=>d.resourceRef&&sameRef(d.resourceRef,ref))??[];
      items.push({...placeholder(ref,'resource_missing'),requiredTools:requirement?.requiredTools??null,availability:omitted.some(d=>d.reason==='resource_dependency_missing')?'dependency_missing':'invalid',diagnostics:omitted});
    }
    for(const item of items)if(item.ref.kind==='skill')item.readiness=getSkillReadiness(frozen?.skillRequirements?.find(s=>sameRef(s.resourceRef,item.ref))?.requiredTools??null,tools,'run_scope');
    return ResourceListSchema.parse({ source: 'run', runId: run.id, sessionId: run.sessionId, configVersion: run.model.configVersion,
      selection: frozen?.selection ?? emptySelection(), items, diagnostics: frozen?.omitted ?? [diagnostic(null, 'not_recorded')], catalogError: null,
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
    this.session(sessionId); const selection = ResourceSelectionSchema.parse(raw);
    if (!refs(selection).length) return selection;
    const catalog = await this.discover(selection, allowedTools);
    for (const ref of refs(selection)) { const item = catalog.items.find(i => sameRef(i.ref, ref)); if (!item || item.availability !== 'ready') this.unavailable(item); }
    const snapshots = await this.source.capture(refs(selection));
    if (snapshots.length !== refs(selection).length || snapshots.some((s, i) => !sameRef(ResourceSnapshotSchema.parse(s).ref, refs(selection)[i]!))) failure('resource_changed');
    return selection;
  }
  async freeze(sessionId: number, settings: PublishedSettings, scope: RunScope): Promise<FrozenRunResources> {
    this.session(sessionId); const selection = this.selection(settings, sessionId), available: ResourceSnapshot[] = [], omitted: ResourceDiagnostic[] = [];
    const catalog=await this.discover(selection,scope.allowedToolNames), knownPromptNames=catalog.promptNames;
    const skillRequirements=selection.skills.map(resourceRef=>{const item=catalog.items.find(i=>sameRef(i.ref,resourceRef));return {resourceRef,requiredTools:item?.requiredTools??null,disableModelInvocation:item?.disableModelInvocation??null};});
    if (refs(selection).length) {
      for (const ref of refs(selection)) try {
        const item = catalog.items.find(i => sameRef(i.ref, ref)); if (!item || item.availability !== 'ready') this.unavailable(item);
        const captured = await this.source.capture([ref]), snapshot = ResourceSnapshotSchema.parse(captured[0]);
        if (captured.length !== 1 || !sameRef(snapshot.ref, ref)) failure('resource_changed'); available.push(snapshot);
      } catch (error) {
        const parsed = AppErrorSchema.safeParse(error), code = parsed.success && parsed.data.reason?.startsWith('resource_') ? parsed.data.reason as ResourceDiagnosticReason : 'resource_invalid'; omitted.push(diagnostic(ref, code));
      }
    }
    const frozen = FrozenRunResourcesSchema.safeParse({ contract: 'medclaw.run-resources/v1', sdkVersion: '0.87.1', sessionId, configVersion: settings.configVersion, selection, available, knownPromptNames, omitted, skillRequirements });
    if (!frozen.success) failure('resource_too_large'); return frozen.data;
  }
  private roleItem(item: SubagentRoleItem, allowedTools: readonly string[], readOnlyTools: readonly string[]): SubagentsList['items'][number] {
    const reasons = item.diagnostics.map(d => d.reason as string);
    for (const name of item.declaredTools ?? []) {
      if (!readOnlyTools.includes(name)) reasons.push(`tool_not_read_only:${name}`);
      else if (!allowedTools.includes(name)) reasons.push(`scope_tool_not_allowed:${name}`);
    }
    return { roleId: item.roleId, description: item.description, source: item.source.kind, declaredTools: item.declaredTools,
      valid: item.availability === 'ready', available: item.availability === 'ready' && reasons.length === 0, reasons };
  }
  private roleSnapshotItem(snapshot: SubagentRoleSnapshot): SubagentRoleItem {
    return { roleId: snapshot.roleId, description: snapshot.description, source: snapshot.source, declaredTools: snapshot.declaredTools, availability: 'ready', diagnostics: [] };
  }
  private storedSubagents(runId: number) {
    const result = this.store.read({ runId, inputLimit: 1, outputLimit: 1, callLimit: 1 });
    if (result.kind !== 'one' || !result.run) throw safeError('run_not_found');
    if (result.run.kind !== 'agent') throw safeError('access_denied');
    if (!this.store.readRunSubagents) throw safeError('storage_read_failed');
    const raw = this.store.readRunSubagents(runId);
    if (raw === null) return { frozen: null, allowedTools: [] };
    const parsed = FrozenRunSubagentsSchema.safeParse(raw);
    if (!parsed.success) throw safeError('storage_read_failed');
    const scope = this.store.readRunResourceScope?.(runId);
    if (!scope) throw safeError('storage_read_failed');
    return { frozen: parsed.data, allowedTools: scope.allowedToolNames };
  }
  async listSubagents(raw: SubagentsListInput): Promise<SubagentsList> {
    const input = SubagentsListInputSchema.parse(raw);
    if (input.source === 'selection') {
      this.session(input.sessionId); if (!this.roleSource) failure('resource_missing');
      const catalog = await this.roleSource.discover();
      return SubagentsListSchema.parse({ items: catalog.items.map(item => this.roleItem(item, this.configuredToolNames(this.readSettings()), this.readOnlyToolNames())),
        recorded: true, reasons: [], diagnostics: catalog.items.flatMap(item => item.diagnostics) });
    }
    const { frozen, allowedTools } = this.storedSubagents(input.runId);
    const items = frozen?.roles.map(role => this.roleItem(this.roleSnapshotItem(role), allowedTools, allowedTools)) ?? [];
    for (const diagnostic of frozen?.diagnostics ?? []) if (diagnostic.roleId && !items.some(item => item.roleId === diagnostic.roleId)) {
      items.push({ roleId: diagnostic.roleId, description: null, source: diagnostic.source.kind, declaredTools: null, valid: false, available: false, reasons: [diagnostic.reason] });
    }
    return SubagentsListSchema.parse({ items, recorded: frozen !== null, reasons: frozen ? [] : ['not_recorded'], diagnostics: frozen?.diagnostics ?? [] });
  }
  async readSubagent(raw: SubagentsReadInput): Promise<SubagentsRead> {
    const input = SubagentsReadInputSchema.parse(raw);
    if (input.source === 'selection') {
      this.session(input.sessionId); if (!this.roleSource) failure('resource_missing');
      const role = await this.roleSource.read(input.roleId);
      return SubagentsReadSchema.parse({ ...role, diagnostics: [], editable: true, expectedContent: role.content });
    }
    const { frozen } = this.storedSubagents(input.runId), role = frozen?.roles.find(item => item.roleId === input.roleId);
    if (!role) failure('resource_missing');
    return SubagentsReadSchema.parse({ ...role, diagnostics: frozen?.diagnostics.filter(item => item.roleId === role.roleId) ?? [], editable: false, expectedContent: null });
  }
  async saveSubagent(raw: SubagentsSaveInput): Promise<SubagentsRead> {
    const input = SubagentsSaveInputSchema.parse(raw); this.session(input.sessionId);
    if (!this.roleSource) failure('resource_missing');
    const { sessionId: _, ...change } = input, role = await this.roleSource.save(change);
    return SubagentsReadSchema.parse({ ...role, diagnostics: [], editable: true, expectedContent: role.content });
  }
  async freezeSubagents(sessionId: number, scope: RunScope): Promise<FrozenRunSubagents | undefined> {
    if (!this.roleSource) return undefined;
    this.session(sessionId); const captured = await this.roleSource.capture();
    const items = captured.roles.map(role => this.roleItem(this.roleSnapshotItem(role), scope.allowedToolNames, this.readOnlyToolNames()));
    const indexText = '<subagent_roles>\n' + items.map(({ roleId, description, available, reasons }) => JSON.stringify({ roleId, description, available, reasons })).join('\n') + '\n</subagent_roles>';
    const frozen = FrozenRunSubagentsSchema.safeParse({ ...captured, indexText });
    if (!frozen.success) failure('resource_too_large');
    return frozen.data;
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
    const command=resourceCommand(input.text,frozen.knownPromptNames);
    if(command&&input.mode==='send'&&input.routing?.mode==='intent')throw safeError('invalid_argument');
    if (command?.kind==='skill') return ResourceInputPlanSchema.parse({ kind: 'skill', resourceRef: required(frozen.selection.skills.find(ref => ref.id===command.id)), dispatchText: input.text });
    if (command?.kind==='prompt') return ResourceInputPlanSchema.parse({ kind: 'prompt', resourceRef: required(frozen.selection.prompt?.id === command.id ? frozen.selection.prompt : null), dispatchText: input.text });
    if (input.mode === 'send' && frozen.selection.prompt) return ResourceInputPlanSchema.parse({ kind: 'prompt', resourceRef: required(frozen.selection.prompt),
      dispatchText: '/' + frozen.selection.prompt.id + ' ' + input.text.split('"').map(part => '"' + part + '"').join("'\"'") });
    return { kind: 'plain', resourceRef: null, dispatchText: input.text };
  }
  async prepareInput(raw: FrozenRunResources, request: SubmitInput, frozenRoles?: FrozenRunSubagents): Promise<ResourceInputPlan> {
    const frozen = FrozenRunResourcesSchema.parse(raw), input = SubmitInputSchema.parse(request);
    const name = input.text.startsWith('/') ? input.text.slice(1).split(/\s/, 1)[0] : '';
    const template = SubagentTemplateNameSchema.safeParse(name);
    if (name !== 'subagent' && !template.success) return this.planInput(frozen, input);
    if (input.mode !== 'send') throw safeError('state_conflict');
    if (input.sessionId !== frozen.sessionId || input.model.expectedConfigVersion !== frozen.configVersion) throw safeError('state_conflict');
    if (!frozenRoles) failure('resource_missing');
    const requireRole = (roleId: string) => {
      const role = frozenRoles.roles.find(role => role.roleId === roleId);
      if (!role) failure('resource_missing');
      if (!this.roleItem(this.roleSnapshotItem(role), this.configuredToolNames(this.readSettings()), this.readOnlyToolNames()).available) failure('resource_dependency_missing');
    };
    if (name === 'subagent') {
      const match = /^\/subagent ([a-z0-9]+(?:-[a-z0-9]+)*)[ \t]+([\s\S]+)$/.exec(input.text);
      if (!match || !match[2]!.trim()) throw safeError('invalid_argument');
      requireRole(match[1]!);
      return ResourceInputPlanSchema.parse({ kind: 'subagent_command', resourceRef: null, dispatchText: input.text,
        source: { name: 'subagent', roleId: match[1], task: match[2] } });
    }
    requireRole('medclaw-audit');
    if (template.data === 'parallel-medclaw-review') requireRole('general-analyst');
    if (!this.source.captureSubagentTemplate) failure('resource_missing');
    const source = await this.source.captureSubagentTemplate(template.data!);
    if (source.templateName !== template.data || source.file !== `subagent-prompts/${template.data}.md`) failure('resource_snapshot_invalid');
    return ResourceInputPlanSchema.parse({ kind: 'subagent_template', resourceRef: null, dispatchText: input.text, source });
  }
  async listInputCommands(raw: InputCommandsListInput): Promise<InputCommandsList> {
    const input = InputCommandsListInputSchema.parse(raw); this.session(input.sessionId);
    const catalog = await this.list({ source: 'selection', sessionId: input.sessionId }), items: InputCommandsList['items'] = [];
    for (const item of catalog.items.filter(item => item.ref.kind === 'skill' && item.enabled)) items.push({ group: 'skills', id: resourceRefKey(item.ref), command: `/skill:${item.ref.id}`,
      description: item.description ?? item.ref.id, available: item.availability === 'ready', reasons: item.diagnostics.map(item => item.reason), registered: false, owner: null });
    for (const item of catalog.items.filter(item => item.ref.kind === 'prompt' && item.enabled)) items.push({ group: 'prompt_templates', id: resourceRefKey(item.ref), command: `/${item.ref.id}`,
      description: item.description ?? item.ref.id, available: item.availability === 'ready', reasons: item.diagnostics.map(item => item.reason), registered: false, owner: null });
    const roles = this.roleSource ? await this.listSubagents({ source: 'selection', sessionId: input.sessionId }) : null;
    if (roles) {
      for (const role of roles.items) items.push({ group: 'subagents', id: role.roleId, command: `/subagent ${role.roleId}`,
        description: role.description ?? role.roleId, available: role.available, reasons: role.reasons, registered: false, owner: null });
    }
    for (const name of SubagentTemplateNameSchema.options) {
      let available = false; const reasons: string[] = [];
      try { if (!this.source.captureSubagentTemplate) failure('resource_missing'); await this.source.captureSubagentTemplate(name); available = true; }
      catch { reasons.push('resource_unavailable'); }
      for (const roleId of name === 'parallel-medclaw-review' ? ['medclaw-audit', 'general-analyst'] : ['medclaw-audit']) {
        const role = roles?.items.find(item => item.roleId === roleId);
        if (!role?.available) { available = false; reasons.push(`role_unavailable:${roleId}`); }
      }
      items.push({ group: 'prompt_templates', id: name, command: `/${name}`, description: name === 'medclaw-evidence-review' ? 'Delegate read-only evidence review' : 'Delegate complementary evidence reviews', available, reasons, registered: false, owner: null });
    }
    items.push({ group: 'extension_commands', id: 'subagent', command: '/subagent', description: 'Delegate to a named read-only role', available: !!this.roleSource, reasons: this.roleSource ? [] : ['resource_unavailable'], registered: false, owner: null });
    return InputCommandsListSchema.parse({ items });
  }
}
