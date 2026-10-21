import { isDeepStrictEqual } from "node:util";
import type { Command, RuntimeNotice } from "../../contracts/src/protocol.ts";
import type { AuthAttemptView, DiagnoseRequest, ModelChoice, ProviderAccepted, ProviderRequest, PublishedSettings, CredentialScope, ModelRuntimePort, ResolvedProviderSelection } from "../../contracts/src/model.ts";
import { PublishedSettingsSchema, AuthPromptViewSchema, AuthNotifyViewSchema, DEFAULT_INTENT_MODEL, IntentModelConfigurationSchema, type IntentModelConfiguration } from "../../contracts/src/model.ts";
import type { IntentModelInspection } from '../../contracts/src/intent';
import type { AgentRuntimePort, ModelCallStarter, RuntimeRunStore } from "../../contracts/src/run.ts";
import type { NativeSessionBindings } from "../../contracts/src/session";
import { RuntimeService, type IntentRoutingDependencies } from "./runtime/runtime-service";
import type { RunControl } from './runtime/run-control';
import { AppErrorSchema, safeError, type AppError } from "../../contracts/src/error.ts";
import type { EventService } from './events/event-service.ts';
import type { WriteTransactions } from '../../contracts/src/event';
import { ResourceService } from './resources/resource-service';
import type { SubagentRoleSource } from '@medclaw/contracts/subagent';
import { InputCommandsListInputSchema, InputCommandsListSchema, type InputCommandsListInput, type InputCommandsList, type ResourceSource } from '../../contracts/src/resources';
import { ExtensionsReadResultSchema, type ExtensionsReadResult } from '../../contracts/src/protocol';
import { ExtensionsReadInputSchema, ExtensionsCommandInputSchema, type ExtensionsReadInput, type ExtensionsCommandInput } from '../../contracts/src/extensions';
import type { ExportServicePort } from '../../contracts/src/export';

type Login = { view: AuthAttemptView; abort: AbortController; pending?: { id: string; allowedIds: string[] | null; resolve: (value: string) => void; reject: (reason: unknown) => void }; task: Promise<void> };
const now = () => new Date().toISOString();
export class Application<Resolved extends ResolvedProviderSelection = ResolvedProviderSelection> {
  readonly runs: RuntimeService<Resolved>;
  readonly resources: ResourceService | null;
  private refreshes = new Map<string, { abort: AbortController; task: Promise<unknown> }>();
  private logins = new Map<string, Login>();
  private prepared: { token: string; candidate: PublishedSettings; old: PublishedSettings; changedRuntime: boolean } | null = null;
  private lastCommit: { token: string; version: string } | null = null;
  private closing = false;
  private readonly intentAbort = new AbortController();
  private readonly intentInspections = new Set<Promise<IntentModelInspection>>();
  constructor(readonly instanceId: string, private settings: PublishedSettings, readonly runtime: ModelRuntimePort<Resolved>, readonly repositories: RuntimeRunStore, private readonly scope: CredentialScope, startCall: ModelCallStarter, private readonly notice: (notice: RuntimeNotice) => void, private readonly report: (error: AppError) => void = () => {}, private readonly agent?: AgentRuntimePort<Resolved,RunControl> & NativeSessionBindings, events?: Pick<EventService, 'notifyStream'>,transactions?:WriteTransactions, resourceSource?:ResourceSource, private readonly intents?:IntentRoutingDependencies, readonly exports: ExportServicePort | null = null, roleSource?:SubagentRoleSource) {
    this.resources = resourceSource ? new ResourceService(() => this.settings, repositories, resourceSource, () => agent?.toolNames ?? [], roleSource, () => agent?.readOnlyToolNames ?? []) : null;
    this.runs = new RuntimeService(instanceId, () => this.settings, runtime, repositories, scope, startCall, notice, report, agent,
      () => this.closing || this.exports?.busy === true || this.prepared !== null || this.refreshes.size > 0 || [...this.logins.values()].some(login => !login.view.endedAt), snapshot => events?.notifyStream(snapshot),transactions,this.resources ?? undefined,intents);
  }
  get config() { return this.settings; }
  get busy() { return this.runs.busy; }
  get persistencePending() { return this.runs.persistencePending; }
  get stopPending() { return this.runs.stopPending; }
  async listInputCommands(raw: InputCommandsListInput): Promise<InputCommandsList> {
    const input = InputCommandsListInputSchema.parse(raw);
    if (!this.resources) throw safeError('resource_unavailable');
    const directory = await this.resources.listInputCommands(input), run = this.runs.activeHandle;
    const extensions = await this.readExtensions({ source: 'selection', sessionId: input.sessionId });
    if (extensions.source === 'selection' && extensions.available) for (const name of extensions.available.commands) {
      const proof = extensions.live, registered = proof?.state === 'active' && proof.callableCommands.includes(name);
      directory.items.push({ group: 'extension_commands', id: name, command: '/' + name, description: 'Inspect the current tool-audit extension',
        available: !!registered, reasons: registered ? [] : ['extension_not_active'], registered: !!registered,
        owner: registered ? { instanceId: proof.instanceId, sessionId: proof.sessionId, runId: proof.runId, assemblyId: proof.assemblyId } : null });
    }
    const live = run?.sessionId === input.sessionId ? this.agent?.readInputCommands?.(run.runId) ?? [] : [];
    for (const command of live) {
      if (command.owner.instanceId !== this.instanceId || command.owner.sessionId !== input.sessionId || command.owner.runId !== run?.runId) throw safeError('state_conflict');
      const found = directory.items.find(item => item.group === 'extension_commands' && item.id === command.name);
      const item = { group: 'extension_commands' as const, id: command.name, command: '/' + command.name, description: command.description, available: true, reasons: [], registered: true, owner: command.owner };
      if (found) Object.assign(found, item); else directory.items.push(item);
    }
    return InputCommandsListSchema.parse(directory);
  }
  private extensionSession(sessionId: number) {
    const session=this.repositories.readSession(sessionId);
    if(!session)throw safeError('input_invalid',undefined,{reason:'session_not_found'});
    if(session.kind!=='user')throw safeError('access_denied');
    if(session.deletedAt!==null)throw safeError('input_invalid',undefined,{reason:'session_deleted'});
    return session;
  }
  async readExtensions(value: ExtensionsReadInput): Promise<ExtensionsReadResult> {
    const input=ExtensionsReadInputSchema.parse(value);
    if(input.source==='selection') {
      this.extensionSession(input.sessionId);
      let available=null; const diagnostics:AppError[]=[];
      try {available=await this.agent?.readExtensionDescriptor?.()??null;} catch {diagnostics.push(safeError('extension_unavailable',undefined,{sessionId:input.sessionId}));}
      const run=this.runs.activeHandle;
      const live=run?.sessionId===input.sessionId?this.agent?.readExtensionCleanup?.(run.runId)??null:null;
      return ExtensionsReadResultSchema.parse({source:'selection',sessionId:input.sessionId,configVersion:this.settings.configVersion,
        selection:this.settings.extensions?.bySession[String(input.sessionId)]??{extension:null},available,live,diagnostics});
    }
    const result=this.repositories.read({runId:input.runId});
    if(result.kind!=='one'||!result.run||result.run.kind!=='agent')throw safeError('run_not_found');
    const run=result.run, frozen=this.repositories.readRunExtensions?.(run.id)??null;
    const summary=frozen?{...frozen,source:frozen.source?{manifest:frozen.source.manifest,files:frozen.source.files.map(({file,bytes})=>({file,bytes}))}:null}:null;
    return ExtensionsReadResultSchema.parse({source:'run',runId:run.id,sessionId:run.sessionId,evidence:frozen?'recorded':'not_recorded',frozen:summary,
      assembly:this.agent?.readExtensionCleanup?.(run.id)??run.cleanup?.extensions??null,cleanup:run.cleanup});
  }
  async executeExtensionCommand(value: ExtensionsCommandInput) {
    const input=ExtensionsCommandInputSchema.parse(value); this.extensionSession(input.sessionId);
    const run=this.runs.activeHandle;
    if(input.instanceId!==this.instanceId)throw safeError('access_denied');
    if(this.closing||this.prepared||this.stopPending||!run||run.runId!==input.runId||run.sessionId!==input.sessionId
      ||!this.runs.readInputControl(input.sessionId)?.acceptingInputs||!this.agent?.executeExtensionCommand)throw safeError('state_conflict');
    return this.agent.executeExtensionCommand(input);
  }
  private assertIdle() { if (this.closing || this.busy || this.prepared || this.refreshes.size || [...this.logins.values()].some(l => !l.view.endedAt)) throw new Error("runtime_busy"); }
  private async credentialScope<T>(provider: string, operationRef: string, credentialRef: string | null, fn: () => Promise<T>, purpose: "auth" | "runtime" | "rollback" = "runtime", authAttemptId?: string) {
    return this.scope({ purpose, operationRef, credentialRef, ...(authAttemptId ? { authAttemptId } : {}) }, fn);
  }
  async directory() {
    let selection = null;
    if (this.settings.model) {
      try { selection = (await this.runtime.resolve({ ...this.settings.model, expectedConfigVersion: this.settings.configVersion }, this.settings.configVersion, this.settings.credentialRefs[this.settings.model.provider] ?? null, this.settings.requestPolicy, false)).selection; } catch { /* Invalid selection remains visible through config, never silently replaced. */ }
    }
    return this.runtime.directory(this.settings.configVersion, selection);
  }
  async refresh(operationRef: string, providerId?: string) {
    this.assertIdle();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30000);
    try {
      const task = this.runtime.refresh(providerId, abort.signal);
      this.refreshes.set(operationRef, { abort, task });
      return await task;
    }
    finally { clearTimeout(timer); this.refreshes.delete(operationRef); }
  }
  cancelOperation(operationRef: string) { const pending = this.refreshes.get(operationRef); pending?.abort.abort(); return { cancelRequested: !!pending, settled: !pending }; }
  async inspectIntentModel(input:Pick<IntentModelConfiguration,'baseUrl'|'modelTag'>) {
    if(this.closing)throw safeError('runtime_busy');
    if(!this.intents)throw safeError('intent_model_unavailable');
    const pending=this.intents.service.inspectModel(IntentModelConfigurationSchema.parse({...DEFAULT_INTENT_MODEL,...input}),this.intentAbort.signal);
    this.intentInspections.add(pending);try{return await pending;}finally{this.intentInspections.delete(pending);}
  }
  async prepareConfig(token: string, input: PublishedSettings) {
    if (this.exports?.busy) throw safeError('runtime_busy');
    this.runs.assertNoHistoryMutation();
    if (this.prepared && this.prepared.token === token && isDeepStrictEqual(this.prepared.candidate, input)) return { prepared: true as const, selection: (await this.directory()).selection };
    if (this.prepared || this.closing) throw new Error("runtime_busy");
    const candidate = PublishedSettingsSchema.parse(input);
    const changedIntent=!isDeepStrictEqual(candidate.intentModel??null,this.settings.intentModel??null);
    if(changedIntent&&candidate.configVersion!==this.settings.configVersion&&candidate.previous?.configVersion!==this.settings.configVersion)throw safeError('config_conflict');
    const oldResources = this.settings.resources?.bySession ?? {}, newResources = candidate.resources?.bySession ?? {};
    const changedResourceSessions = [...new Set([...Object.keys(oldResources), ...Object.keys(newResources)])].filter(id => !isDeepStrictEqual(oldResources[id], newResources[id]));
    const oldExtensions=this.settings.extensions?.bySession??{},newExtensions=candidate.extensions?.bySession??{};
    const changedExtensionSessions=[...new Set([...Object.keys(oldExtensions),...Object.keys(newExtensions)])].filter(id=>!isDeepStrictEqual(oldExtensions[id],newExtensions[id]));
    if ((changedResourceSessions.length||changedExtensionSessions.length) && candidate.configVersion !== this.settings.configVersion && candidate.previous?.configVersion !== this.settings.configVersion) throw new Error('config_conflict');
    if(changedExtensionSessions.length)this.assertIdle();
    const changedRuntime = !isDeepStrictEqual(candidate.customProviders.map(p => p.definition), this.settings.customProviders.map(p => p.definition));
    const changedBindings = !isDeepStrictEqual(candidate.credentialRefs, this.settings.credentialRefs) || !isDeepStrictEqual(candidate.customProviders.map(p => p.credentialRef), this.settings.customProviders.map(p => p.credentialRef));
    if (changedRuntime || changedBindings || candidate.rollbackFromVersion !== null) this.assertIdle();
    const old = this.settings;
    this.prepared = { token, candidate, old, changedRuntime };
    try {
      if(candidate.intentModel?.enabled&&(changedIntent||candidate.rollbackFromVersion!==null)){
        const inspection=await this.inspectIntentModel(candidate.intentModel);
        if(!inspection.available)throw inspection.error??safeError('intent_model_unavailable');
      }
      if(changedExtensionSessions.length&&!this.agent?.validateExtensions)throw safeError('extension_unavailable');
      for(const id of changedExtensionSessions){this.extensionSession(Number(id));await this.agent!.validateExtensions!(Number(id),candidate);}
      if (changedResourceSessions.length && !this.resources) throw new Error('resource_unavailable');
      for (const id of changedResourceSessions) await this.resources!.validateSelection(Number(id), newResources[id] ?? { prompt: null, skills: [] }, this.agent?.toolNames ?? []);
      if (changedRuntime) await this.runtime.installCustom(candidate.customProviders.map(p => p.definition));
      const changedSelection = !isDeepStrictEqual(candidate.model, old.model) || !isDeepStrictEqual(candidate.requestPolicy, old.requestPolicy);
      const selected = changedSelection || changedRuntime || changedBindings || candidate.rollbackFromVersion !== null ? candidate.model : null;
      // Main validates auth inside this gate after any candidate credential is durably saved.
      const resolveSelection = () => this.runtime.resolve({ ...selected!, expectedConfigVersion: candidate.configVersion }, candidate.configVersion, candidate.credentialRefs[selected!.provider] ?? null, candidate.requestPolicy, candidate.rollbackFromVersion !== null);
      const selection = selected ? (await (candidate.rollbackFromVersion === null ? resolveSelection() : this.credentialScope(selected.provider, token, candidate.credentialRefs[selected.provider] ?? null, resolveSelection, "rollback"))).selection : null;
      if(this.closing||this.prepared?.token!==token)throw safeError('config_conflict');
      return { prepared: true as const, selection };
    } catch (error) { if (changedRuntime) await this.runtime.installCustom(old.customProviders.map(p => p.definition)); this.prepared = null; throw error; }
  }
  commitConfig(token: string, publishedVersion: string) {
    if (!this.prepared && this.lastCommit?.token === token && this.lastCommit.version === publishedVersion) return { configVersion: this.settings.configVersion };
    if (!this.prepared || this.prepared.token !== token || this.prepared.candidate.configVersion !== publishedVersion) throw new Error("config_conflict");
    this.settings = this.prepared.candidate; this.prepared = null; this.lastCommit = { token, version: publishedVersion };
    return { configVersion: this.settings.configVersion };
  }
  async abortConfig(token: string) {
    if (!this.prepared || this.prepared.token !== token) return;
    const pending = this.prepared;
    if (pending.changedRuntime) await this.runtime.installCustom(pending.old.customProviders.map(p => p.definition));
    this.prepared = null;
  }
  submitProvider(command: Command<ProviderRequest | DiagnoseRequest>, kind: "main" | "diagnostic" = "main") { return this.runs.submitProvider(command, kind); }
  cancelProvider(runId: number) { return this.runs.cancelNow(runId); }
  retrySave(runId: number) { return this.runs.retrySaveNow(runId); }
  private emit(notice: RuntimeNotice) { try { this.notice(notice); } catch { this.report(safeError("preview_delivery_failed")); } }
  async startAuth(operationRef: string, providerId: string, type: "api_key" | "oauth") {
    this.assertIdle();
    if (!this.runtime.supportsAuth(providerId, type)) throw new Error("auth_method_unsupported");
    const id = crypto.randomUUID();
    const login: Login = { view: { id, providerId, state: "running", pendingPromptId: null, error: null, startedAt: now(), endedAt: null }, abort: new AbortController(), task: Promise.resolve() };
    this.logins.set(id, login);
    const timer = setTimeout(() => login.abort.abort(), 300000);
    login.task = this.credentialScope(providerId, operationRef, null, async () => {
      try {
        await this.runtime.login(providerId, type, { signal: login.abort.signal,
          prompt: prompt => new Promise<string>((resolve, reject) => {
            const promptId = crypto.randomUUID();
            const view = AuthPromptViewSchema.parse({ type: prompt.type, message: prompt.message.slice(0, 2000), secret: prompt.type === "secret", promptId, authAttemptId: id, ...(prompt.type === "select" ? { options: prompt.options.map(o => ({ id: o.id, label: o.label, ...(o.description ? { description: o.description } : {}) })) } : {}) });
            login.pending = { id: promptId, allowedIds: view.type === "select" ? view.options.map(o => o.id) : null, resolve, reject }; login.view.pendingPromptId = promptId; login.view.state = "waiting_input";
            const stop = () => { if (login.pending?.id === promptId) { const active = login.pending; login.pending = undefined; login.view.pendingPromptId = null; active.reject(new Error("auth_cancelled")); } };
            const cleanup = () => { login.abort.signal.removeEventListener("abort", stop); prompt.signal?.removeEventListener("abort", stop); };
            login.pending.resolve = value => { cleanup(); resolve(value); }; login.pending.reject = error => { cleanup(); reject(error); };
            login.abort.signal.addEventListener("abort", stop, { once: true }); prompt.signal?.addEventListener("abort", stop, { once: true });
            if (login.abort.signal.aborted || prompt.signal?.aborted) { stop(); return; }
            this.emit({ type: "auth.prompt", prompt: view });
          }),
          notify: event => this.emit({ type: "auth.notify", notification: AuthNotifyViewSchema.parse({ ...event, ...(event.type === "info" && event.links ? { links: event.links.map(link => ({ ...link })) } : {}), authAttemptId: id }) }),
        });
        login.view.state = "completed";
      } catch (error) {
        const failure = AppErrorSchema.safeParse(error);
        login.view.state = login.abort.signal.aborted ? "cancelled" : failure.success && failure.data.code === "model_auth_sync_failed" ? "sync_unknown" : "failed";
        login.view.error = login.view.state === "cancelled" ? null : safeError(login.view.state === "sync_unknown" ? "model_auth_sync_failed" : "auth_failed");
      } finally {
        clearTimeout(timer); login.pending?.reject(new Error("auth_cancelled")); login.pending = undefined; login.view.pendingPromptId = null; login.view.endedAt = now();
        this.emit({ type: "auth.finished", attempt: { ...login.view } });
        const ended = [...this.logins.entries()].filter(([, value]) => value.view.endedAt !== null);
        ended.slice(0, Math.max(0, ended.length - 20)).forEach(([key]) => this.logins.delete(key));
      }
    }, "auth", id);
    return { authAttemptId: id, state: "running" as const };
  }
  respondAuth(id: string, promptId: string, value: string) {
    const login = this.logins.get(id);
    if (!login || login.view.endedAt || login.pending?.id !== promptId || value.length > 4096 || login.pending.allowedIds && !login.pending.allowedIds.includes(value)) throw new Error("auth_prompt_invalid");
    const pending = login.pending; login.pending = undefined; login.view.pendingPromptId = null; login.view.state = "running"; pending.resolve(value);
    return { accepted: true };
  }
  cancelAuth(id: string) { const login = this.logins.get(id); if (!login) throw new Error("auth_attempt_not_found"); login.abort.abort(); return { cancelRequested: !login.view.endedAt, settled: !!login.view.endedAt }; }
  async authStatus(providerId: string, id?: string) { const login = id ? this.logins.get(id) : [...this.logins.values()].reverse().find(l => l.view.providerId === providerId); if (id && (!login || login.view.providerId !== providerId)) throw new Error("auth_attempt_not_found"); return { auth: await this.runtime.authStatus(providerId), attempt: login ? { ...login.view } : null }; }
  async shutdown() {
    this.runs.assertShutdownAvailable();
    this.closing = true;
    this.intentAbort.abort();
    const refreshes = [...this.refreshes.values()];
    refreshes.forEach(refresh => refresh.abort.abort()); this.logins.forEach(l => l.abort.abort());
    const stopping = this.runs.shutdown();
    const settled = await Promise.allSettled([
      ...[...this.logins.values()].map(login => login.task),
      Promise.allSettled(refreshes.map(refresh => refresh.task)),
      Promise.allSettled([...this.intentInspections]),
      this.exports?.shutdown(), stopping,
    ]);
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
    const stopped = await stopping;
    await this.agent?.disposeIdleSessions?.();
    return stopped;
  }
}
