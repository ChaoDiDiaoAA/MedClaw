import { isDeepStrictEqual } from "node:util";
import type { Command, RuntimeNotice } from "../../contracts/src/protocol.ts";
import type { AuthAttemptView, DiagnoseRequest, ModelChoice, ProviderAccepted, ProviderRequest, PublishedSettings, CredentialScope, ModelRuntimePort, ResolvedProviderSelection } from "../../contracts/src/model.ts";
import { PublishedSettingsSchema, AuthPromptViewSchema, AuthNotifyViewSchema } from "../../contracts/src/model.ts";
import type { AgentRuntimePort, ModelCallStarter, RuntimeRunStore } from "../../contracts/src/run.ts";
import type { NativeSessionBindings } from "../../contracts/src/session";
import { RuntimeService } from "./runtime/runtime-service";
import { AppErrorSchema, safeError, type AppError } from "../../contracts/src/error.ts";
import type { EventService } from './events/event-service.ts';
import type { WriteTransactions } from '../../contracts/src/event';

type Login = { view: AuthAttemptView; abort: AbortController; pending?: { id: string; allowedIds: string[] | null; resolve: (value: string) => void; reject: (reason: unknown) => void }; task: Promise<void> };
const now = () => new Date().toISOString();
export class Application<Resolved extends ResolvedProviderSelection = ResolvedProviderSelection> {
  readonly runs: RuntimeService<Resolved>;
  private refreshes = new Map<string, AbortController>();
  private logins = new Map<string, Login>();
  private prepared: { token: string; candidate: PublishedSettings; old: PublishedSettings; changedRuntime: boolean } | null = null;
  private lastCommit: { token: string; version: string } | null = null;
  private closing = false;
  constructor(readonly instanceId: string, private settings: PublishedSettings, readonly runtime: ModelRuntimePort<Resolved>, readonly repositories: RuntimeRunStore, private readonly scope: CredentialScope, startCall: ModelCallStarter, private readonly notice: (notice: RuntimeNotice) => void, private readonly report: (error: AppError) => void = () => {}, agent?: AgentRuntimePort<Resolved> & NativeSessionBindings, events?: Pick<EventService, 'notifyStream'>,transactions?:WriteTransactions) {
    this.runs = new RuntimeService(instanceId, () => this.settings, runtime, repositories, scope, startCall, notice, report, agent,
      () => this.closing || this.prepared !== null || this.refreshes.size > 0 || [...this.logins.values()].some(login => !login.view.endedAt), snapshot => events?.notifyStream(snapshot),transactions);
  }
  get config() { return this.settings; }
  get busy() { return this.runs.busy; }
  get persistencePending() { return this.runs.persistencePending; }
  get stopPending() { return this.runs.stopPending; }
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
    const abort = new AbortController(); this.refreshes.set(operationRef, abort);
    const timer = setTimeout(() => abort.abort(), 30000);
    try { return await this.runtime.refresh(providerId, abort.signal); }
    finally { clearTimeout(timer); this.refreshes.delete(operationRef); }
  }
  cancelOperation(operationRef: string) { const pending = this.refreshes.get(operationRef); pending?.abort(); return { cancelRequested: !!pending, settled: !pending }; }
  async prepareConfig(token: string, input: PublishedSettings) {
    this.runs.assertNoHistoryMutation();
    if (this.prepared && this.prepared.token === token && isDeepStrictEqual(this.prepared.candidate, input)) return { prepared: true as const, selection: (await this.directory()).selection };
    if (this.prepared || this.closing) throw new Error("runtime_busy");
    const candidate = PublishedSettingsSchema.parse(input);
    const changedRuntime = !isDeepStrictEqual(candidate.customProviders.map(p => p.definition), this.settings.customProviders.map(p => p.definition));
    const changedBindings = !isDeepStrictEqual(candidate.credentialRefs, this.settings.credentialRefs) || !isDeepStrictEqual(candidate.customProviders.map(p => p.credentialRef), this.settings.customProviders.map(p => p.credentialRef));
    if (changedRuntime || changedBindings || candidate.rollbackFromVersion !== null) this.assertIdle();
    const old = this.settings;
    this.prepared = { token, candidate, old, changedRuntime };
    try {
      if (changedRuntime) await this.runtime.installCustom(candidate.customProviders.map(p => p.definition));
      const changedSelection = !isDeepStrictEqual(candidate.model, old.model) || !isDeepStrictEqual(candidate.requestPolicy, old.requestPolicy);
      const selected = changedSelection || changedRuntime || changedBindings || candidate.rollbackFromVersion !== null ? candidate.model : null;
      // Main validates auth inside this gate after any candidate credential is durably saved.
      const resolveSelection = () => this.runtime.resolve({ ...selected!, expectedConfigVersion: candidate.configVersion }, candidate.configVersion, candidate.credentialRefs[selected!.provider] ?? null, candidate.requestPolicy, candidate.rollbackFromVersion !== null);
      const selection = selected ? (await (candidate.rollbackFromVersion === null ? resolveSelection() : this.credentialScope(selected.provider, token, candidate.credentialRefs[selected.provider] ?? null, resolveSelection, "rollback"))).selection : null;
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
    this.refreshes.forEach(a => a.abort()); this.logins.forEach(l => l.abort.abort());
    await Promise.all([...this.logins.values()].map(l => l.task));
    return this.runs.shutdown();
  }
}
