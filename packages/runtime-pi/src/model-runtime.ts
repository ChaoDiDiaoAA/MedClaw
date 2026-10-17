import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, getApiProviders } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, AuthInteraction, AuthType, CredentialStore, Model, ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
import { readFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AuthStatusView, CustomProviderDefinition, ModelChoice, ModelDirectoryView, ModelEntryView, ModelSelection, RequestPolicy, ModelRuntimePort, ResolvedProviderSelection } from "../../contracts/src/model.ts";
import { CustomProviderDefinitionSchema } from "../../contracts/src/model.ts";
import { safeError, type AppError } from "../../contracts/src/error.ts";
import { safeUsage } from "../../contracts/src/run.ts";
import type { ProviderOutcome } from "../../contracts/src/run.ts";
export type { ProviderOutcome } from "../../contracts/src/run.ts";

export const SDK_VERSION = "0.87.1" as const;
export async function installedSdkVersion(): Promise<string> {
  try {
    const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), packageRoot = dirname(dirname(entry));
    await Promise.all(['pi-coding-agent', 'pi-ai', 'pi-agent-core', 'pi-tui', 'pi-telemetry', 'chord'].map(async name => {
      const installedEntry = Bun.resolveSync('@earendil-works/' + name, packageRoot);
      const value: unknown = JSON.parse(await readFile(join(dirname(installedEntry), '../package.json'), 'utf8'));
      z.strictObject({ name: z.literal('@earendil-works/' + name), version: z.literal(SDK_VERSION) }).passthrough().parse(value);
    }));
    return SDK_VERSION;
  } catch { throw safeError('host_protocol_mismatch'); }
}
export interface ResolvedModel extends ResolvedProviderSelection {
  model: Model<Api>; selection: ModelSelection; policy: RequestPolicy; pricingKnown: boolean;
}
const positive = (n: unknown): number | null => typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
export function textOf(message: AssistantMessage): string {
  return message.content.filter(part => part.type === "text").map(part => part.text).join("");
}
export function previewText(text: string): string {
  let end = Math.min(text.length, 32768);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  return text.slice(0, end);
}
function freezeModel(model: Model<Api>): Model<Api> {
  const copy = structuredClone(model);
  function freeze(value: unknown) {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  }
  freeze(copy);
  return copy;
}
// Pi 0.87.1 cache metadata only: reject credentials and unknown protocol fields.
const cacheNumber = z.number().finite().nonnegative();
const cacheInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const cacheName = z.string().min(1).max(1024);
const cacheKey = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(key => !/(?:secret|password|authorization|token|api.?key)/i.test(key));
const cacheWord = z.string().max(128).regex(/^[A-Za-z0-9_.:/-]*$/);
// Native auto-routing models contain negative sentinel rates; these do not imply known pricing.
const cacheRate = z.number().finite();
const costRates = { input: cacheRate, output: cacheRate, cacheRead: cacheRate, cacheWrite: cacheRate };
const cacheCost = z.strictObject({ ...costRates, tiers: z.array(z.strictObject({ ...costRates, inputTokensAbove: cacheNumber })).optional() });
const boolCompat = Object.fromEntries([
  "supportsStore", "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming", "supportsFinishReason", "requiresToolResultName", "requiresAssistantAfterToolResult", "requiresThinkingAsText", "requiresReasoningContentOnAssistantMessages", "zaiToolStream", "supportsThinkingTokenBudget", "supportsOpenAIGrammarTools", "supportsMidConvoSystemMessages", "supportsMidConvoToolAdditions", "supportsStrictMode", "sendSessionAffinityHeaders", "supportsLongCacheRetention", "supportsAdditionalTools", "supportsToolSearch", "supportsExplicitPromptCacheMode", "supportsMaxOutputTokens", "supportsEagerToolInputStreaming", "supportsCacheControlOnTools", "supportsTemperature", "forceAdaptiveThinking", "allowEmptySignature", "supportsStrictTools", "supportsMidConvoEffort", "supportsMidConvoToolChanges",
].map(key => [key, z.boolean().optional()]));
const cacheWords = z.array(cacheWord);
// Static catalog headers observed in 0.87.1; request authentication headers are refused.
const cacheHeaderValues: Record<string, RegExp> = {
  "user-agent": /^GitHubCopilotChat\/\d+\.\d+\.\d+$/,
  "editor-version": /^vscode\/\d+\.\d+\.\d+$/,
  "editor-plugin-version": /^copilot-chat\/\d+\.\d+\.\d+$/,
  "copilot-integration-id": /^vscode-chat$/,
  "nvcf-poll-seconds": /^\d{1,5}$/,
  "content-type": /^application\/json$/,
  accept: /^(?:application\/json|text\/event-stream)$/,
};
const cacheHeaders = z.record(z.string(), z.string()).refine(headers => Object.entries(headers).every(([name, value]) => Object.hasOwn(cacheHeaderValues, name.toLowerCase()) && cacheHeaderValues[name.toLowerCase()]!.test(value)));
const cachePercentiles = z.union([cacheNumber, z.strictObject({ p50: cacheNumber.optional(), p75: cacheNumber.optional(), p90: cacheNumber.optional(), p99: cacheNumber.optional() })]);
const templateValue = z.union([cacheWord, z.number().finite(), z.boolean(), z.null(), z.strictObject({ $var: z.enum(["thinking.enabled", "thinking.effort", "thinking.budget"]), omitWhenOff: z.boolean().optional() })]);
const cacheCompat = z.strictObject({
  ...boolCompat, maxTokensField: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
  thinkingFormat: z.enum(["openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"]).optional(),
  thinkingTokenBudgetField: z.enum(["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"]).optional(),
  cacheControlFormat: z.literal("anthropic").optional(), sessionAffinityFormat: z.enum(["openai", "openai-nosession", "openrouter"]).optional(), vllmPriority: z.number().int().optional(),
  chatTemplateKwargs: z.record(cacheKey, templateValue).optional(), chatTemplateArgs: z.record(cacheKey, templateValue).optional(),
  allowedFallbackModels: z.array(z.strictObject({ provider: cacheName, model: cacheName, cost: cacheCost })).optional(),
  vercelGatewayRouting: z.strictObject({ only: cacheWords.optional(), order: cacheWords.optional() }).optional(),
  openRouterRouting: z.strictObject({
    allow_fallbacks: z.boolean().optional(), require_parameters: z.boolean().optional(), data_collection: z.enum(["deny", "allow"]).optional(), zdr: z.boolean().optional(), enforce_distillable_text: z.boolean().optional(),
    order: cacheWords.optional(), only: cacheWords.optional(), ignore: cacheWords.optional(), quantizations: cacheWords.optional(),
    sort: z.union([cacheWord, z.strictObject({ by: cacheWord.optional(), partition: cacheWord.nullable().optional() })]).optional(),
    max_price: z.strictObject(Object.fromEntries(["prompt", "completion", "image", "audio", "request"].map(key => [key, z.union([cacheNumber, z.string().regex(/^\d+(?:\.\d+)?$/)]).optional()]))).optional(),
    preferred_min_throughput: cachePercentiles.optional(), preferred_max_latency: cachePercentiles.optional(),
  }).optional(),
});
const cacheModel = z.strictObject({
  id: cacheName, name: cacheName, api: cacheName.refine(api => !!getApiProvider(api)), provider: cacheName,
  baseUrl: z.string().max(8192).refine(value => {
    if (value === "") return true; // Native environment-routed models resolve their endpoint at request time.
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }),
  reasoning: z.boolean(), input: z.array(z.enum(["text", "image"])).min(1).max(2), cost: cacheCost, contextWindow: cacheInteger, maxTokens: cacheInteger,
  thinkingLevelMap: z.partialRecord(z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]), cacheWord.nullable()).optional(),
  promptCache: z.strictObject({ short: cacheNumber.optional(), long: cacheNumber.optional() }).optional(),
  samplingParams: z.record(cacheKey, z.union([z.number().finite(), z.boolean(), cacheWord, z.null()])).optional(), compat: cacheCompat.optional(), headers: cacheHeaders.optional(),
  // Radius 0.87.1's catalog extends Model with these non-secret display/routing labels.
  lab: cacheName.optional(), enabled: z.boolean().optional(), providers: z.array(z.strictObject({ id: cacheWord, name: cacheName, credential: z.literal("radius"), source: z.literal("radius") })).optional(),
  inputLimits: z.strictObject({ maxRequestBytes: cacheInteger.optional(), images: z.strictObject({ maxPerMessage: cacheInteger.optional(), maxPerRequest: cacheInteger.optional(), resize: z.strictObject({ maxWidth: cacheInteger.optional(), maxHeight: cacheInteger.optional(), maxBytes: cacheInteger.optional(), jpegQuality: z.number().min(0).max(100).optional() }).optional() }).optional() }).optional(),
});
const cacheEntry = z.strictObject({ models: z.array(cacheModel), etag: z.string().max(8192).optional(), lastModified: cacheNumber.optional(), checkedAt: cacheNumber.optional() });
export function modelView(model: Model<Api>, custom: boolean): ModelEntryView {
  return { provider: model.provider, id: model.id, name: model.name, api: model.api, input: [...model.input], reasoning: model.reasoning, contextWindow: positive(model.contextWindow), maxTokens: positive(model.maxTokens), capabilitySource: custom ? "user_declared" : "pi_catalog" };
}

/** Host-owned SDK catalog cache; SDK chooses publication, not this adapter. */
export class CatalogStore implements ModelsStore {
  private entries: Record<string, ModelsStoreEntry> = {};
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private readonly path: string) {}
  static async open(path: string, onWarning?: (error: AppError) => void) {
    const store = new CatalogStore(path);
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("catalog_cache_invalid");
      store.entries = Object.fromEntries(Object.entries(value).map(([id, entry]) => [cacheName.parse(id), store.validate(entry)]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (!onWarning) throw error;
        onWarning(safeError("provider_refresh_failed"));
      }
    }
    return store;
  }
  private validate(value: unknown): ModelsStoreEntry {
    return cacheEntry.parse(value) as ModelsStoreEntry;
  }
  async read(id: string, options?: { signal?: AbortSignal }) { options?.signal?.throwIfAborted(); return Object.hasOwn(this.entries, id) ? structuredClone(this.entries[id]) : undefined; }
  private async change(id: string, value: ModelsStoreEntry | undefined, signal?: AbortSignal) {
    const next = this.queue.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const entries: Record<string, ModelsStoreEntry> = Object.assign(Object.create(null), this.entries);
      if (value) entries[id] = value; else delete entries[id];
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(entries), { mode: 0o600 });
        signal?.throwIfAborted();
        await rename(temp, this.path);
      } finally { await unlink(temp).catch(() => {}); }
      this.entries = entries;
    });
    this.queue = next;
    await next;
  }
  async write(id: string, entry: ModelsStoreEntry, options?: { signal?: AbortSignal }) { await this.change(cacheName.parse(id), this.validate(entry), options?.signal); }
  async delete(id: string, options?: { signal?: AbortSignal }) { await this.change(id, undefined, options?.signal); }
}

export class PiModelRuntime implements ModelRuntimePort<ResolvedModel> {
  private custom = new Map<string, CustomProviderDefinition>();
  private readonly builtinIds: Set<string>;
  private constructor(readonly native: ModelRuntime) { this.builtinIds = new Set(native.getProviders().map(p => p.id)); }
  static async create(options: { credentials: CredentialStore; modelsStore: ModelsStore }) {
    const native = await ModelRuntime.create({ ...options, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, modelRefreshTimeoutMs: 30000 });
    await native.refresh({ allowNetwork: false });
    return new PiModelRuntime(native);
  }
  async authStatus(providerId: string, signal?: AbortSignal): Promise<AuthStatusView> {
    const checkedAt = new Date().toISOString();
    try {
      const check = await this.native.checkAuth(providerId, { signal });
      const source = check?.source && check.source.length <= 128 && /^[\w\s./~():-]+$/.test(check.source) ? check.source : null;
      return { providerId, state: check ? "available" : "unavailable", type: check?.type ?? null, source, checkKind: "snapshot", checkedAt };
    } catch { return { providerId, state: "sync_unknown", type: null, source: null, checkKind: "snapshot", checkedAt }; }
  }
  async directory(configVersion: string, selection: ModelSelection | null = null): Promise<ModelDirectoryView> {
    const providers: ModelDirectoryView["providers"] = [];
    // Overlapping snapshots must not multiply catalog-wide private credential requests.
    for (const p of this.native.getProviders()) providers.push({ id: p.id, name: p.name, loginTypes: [ ...(p.auth.apiKey?.login ? ["api_key" as const] : []), ...(p.auth.oauth ? ["oauth" as const] : []) ], auth: await this.authStatus(p.id), source: this.custom.has(p.id) ? "custom" as const : "pi_builtin" as const });
    return { providers, models: this.native.getModels().map(m => modelView(m, this.custom.has(m.provider))), configVersion, selection, customApis: getApiProviders().map(p => p.api) };
  }
  async refresh(providerId: string | undefined, signal: AbortSignal) {
    const result = await this.native.refresh({ allowNetwork: true, force: true, ...(providerId ? { providers: [providerId] } : {}), signal });
    return { aborted: result.aborted, errors: [...result.errors.keys()].map(id => ({ providerId: id, error: safeError("provider_refresh_failed") })) };
  }
  async installCustom(definitions: readonly CustomProviderDefinition[], signal?: AbortSignal) {
    const parsed = definitions.map(d => CustomProviderDefinitionSchema.parse(d));
    for (const definition of parsed) {
      if (this.builtinIds.has(definition.providerId)) throw new Error("provider_id_reserved");
      if (!getApiProvider(definition.api)) throw new Error("custom_api_unsupported");
    }
    for (const id of this.custom.keys()) { this.native.unregisterProvider(id); await this.native.removeRuntimeApiKey(id, { signal }); }
    this.custom.clear();
    for (const definition of parsed) {
      this.native.registerProvider(definition.providerId, {
        name: definition.name, baseUrl: definition.baseUrl, api: definition.api,
        models: definition.models.map(model => ({ id: model.id, name: model.name, input: [...model.input], reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      });
      this.custom.set(definition.providerId, definition);
    }
    const refreshed = await this.native.refresh({ allowNetwork: false, signal });
    if (refreshed.aborted || refreshed.errors.size || this.native.getError()) throw new Error("custom_registration_failed");
    for (const d of parsed) for (const m of d.models) if (!this.native.getModel(d.providerId, m.id)) throw new Error("custom_registration_failed");
  }
  supportsAuth(providerId: string, type: AuthType) {
    const provider = this.native.getProvider(providerId);
    return !!provider && (type === "api_key" ? !!provider.auth.apiKey?.login : !!provider.auth.oauth);
  }
  async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<void> {
    try { await this.native.login(providerId, type, interaction); }
    catch (error) { throw safeError(error instanceof Error && error.name === "CredentialSynchronizationError" ? "model_auth_sync_failed" : "auth_failed"); }
  }
  async resolve(choice: ModelChoice, configVersion: string, credentialRef: string | null, policy: RequestPolicy, requireAuth = true): Promise<ResolvedModel> {
    if (choice.expectedConfigVersion !== configVersion) throw new Error("config_conflict");
    const model = this.native.getModel(choice.provider, choice.modelId);
    if (!model) throw new Error("model_not_found");
    if (!positive(model.maxTokens)) throw new Error("model_output_limit_missing");
    if (!model.input.includes("text")) throw new Error("model_capability_unsupported");
    if ((model.api === "mistral-conversations" || model.api === "pi-messages") && policy.maxRetries !== 0) throw new Error("retry_policy_unsupported");
    if (model.api === "bedrock-converse-stream" && (policy.maxRetries !== 0 || process.env.AWS_MAX_ATTEMPTS !== "1")) throw new Error("retry_policy_unsupported");
    if (requireAuth && (await this.authStatus(choice.provider)).state !== "available") throw new Error("model_auth_missing");
    const custom = this.custom.get(model.provider)?.models.find(m => m.id === model.id);
    const rates = [model.cost, ...(model.cost.tiers ?? [])].flatMap(cost => [cost.input, cost.output, cost.cacheRead, cost.cacheWrite]);
    const pricingKnown = custom ? custom.pricingKnown : rates.every(rate => Number.isFinite(rate) && rate >= 0) && rates.some(rate => rate > 0);
    return { model: freezeModel(model), policy: Object.freeze({ ...policy }), pricingKnown, selection: Object.freeze({ provider: model.provider, modelId: model.id, endpointRef: null, api: model.api, configVersion, credentialRef, maxOutputTokens: model.maxTokens, capabilitySource: custom ? "user_declared" : "pi_catalog", sdkVersion: SDK_VERSION }) };
  }
  async execute(resolved: ResolvedModel, text: string, signal: AbortSignal, onPreview: (text: string) => void, onTerminal: () => void = () => {}): Promise<ProviderOutcome> {
    const stream = this.native.streamSimple(resolved.model, { messages: [{ role: "user", content: text, timestamp: Date.now() }] }, { signal, maxTokens: resolved.selection.maxOutputTokens, maxRetries: resolved.policy.maxRetries, maxRetryDelayMs: resolved.policy.maxRetryDelayMs });
    for await (const event of stream) {
      if (event.type === "done" || event.type === "error") onTerminal();
      if ("partial" in event) { try { onPreview(previewText(textOf(event.partial))); } catch { /* Optional desktop delivery cannot break SDK consumption. */ } }
    }
    const message = await stream.result();
    return outcomeOf(message, resolved.pricingKnown);
  }
}
export function outcomeOf(message: AssistantMessage, pricingKnown: boolean): ProviderOutcome {
  const callState = message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "failed" : "completed";
  const usage = safeUsage(message.usage, pricingKnown), raw = message.usage;
  const parts = [raw.input, raw.output, raw.cacheRead, raw.cacheWrite];
  const totalTokens = positive(raw.totalTokens);
  const usageDetails = {
    source: usage.source, unavailableReason: usage.unavailableReason, cacheRead: positive(raw.cacheRead), cacheWrite: positive(raw.cacheWrite),
    cacheWrite1h: positive(raw.cacheWrite1h) !== null && raw.cacheWrite1h! <= raw.cacheWrite ? raw.cacheWrite1h! : null,
    reasoning: positive(raw.reasoning) !== null && raw.reasoning! <= raw.output ? raw.reasoning! : null,
    totalTokens: usage.inputTokens !== null && usage.outputTokens !== null && totalTokens !== null && parts.every(value => Number.isSafeInteger(value) && value >= 0) && parts.reduce((sum, value) => sum + value, 0) === totalTokens ? totalTokens : null,
    costSource: usage.cost === null ? null : "pi_estimate",
  };
  return { sdkStopReason: message.stopReason, text: textOf(message), responseModel: message.responseModel || message.model || null, callState, usage, usageDetails, error: callState === "failed" ? safeError("provider_request_failed") : null };
}
