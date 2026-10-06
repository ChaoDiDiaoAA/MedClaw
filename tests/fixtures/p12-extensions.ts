import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory, type InlineExtension, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from '@earendil-works/pi-ai';

export const p12Model = { id: 'p12-sdk', name: 'ENGINEERING', provider: 'openai', api: 'openai-completions' as const,
  baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 128 };
export function p12Settings() { return SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
  defaultTools: [], packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false, enableInstallTelemetry: false }); }
export function p12Loader(root: string, factories: InlineExtension[] = [], paths: string[] = [],
  override?: ConstructorParameters<typeof DefaultResourceLoader>[0]['extensionsOverride']) {
  return new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager: p12Settings(), noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: paths,
    extensionFactories: factories, extensionsOverride: override, systemPrompt: 'ENGINEERING_FIXED' });
}
export function p12ValueTool(execute: (value: unknown) => unknown): ToolDefinition {
  return { name: 'probe_value', label: 'Probe', description: 'ENGINEERING', parameters: {
    type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false },
    async execute(_id, params) {
      if (!params || typeof params !== 'object' || !('value' in params)) throw new Error('ENGINEERING missing value');
      const value = execute(params.value); return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
    } };
}
export function p12Response(content: AssistantMessage['content'] = [{ type: 'text', text: 'ENGINEERING_OK' }], reason: 'stop' | 'toolUse' = 'stop') {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'done', reason, message: { role: 'assistant', content, api: p12Model.api, provider: p12Model.provider, model: p12Model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: reason, timestamp: Date.now() } }); return stream;
}
export async function p12Runtime() { return ModelRuntime.create({ credentials: { read: async () => ({ type: 'api_key' as const, key: 'ENGINEERING-NONSECRET' }),
  list: async () => [], modify: async () => undefined, delete: async () => {} },
  modelsStore: { read: async () => undefined, write: async () => {}, delete: async () => {} }, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false }); }
export type P12Trace = { calls: number; errors: Array<{ event: string; error: string }>; contexts: Message[][]; manager: SessionManager; loader: DefaultResourceLoader; root: string };
export async function withP12SDK(factory: ExtensionFactory, action: (session: AgentSession, trace: P12Trace) => Promise<void>, useTool = true) {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p12-sdk-')), loader = p12Loader(root, [factory]);
  let session: AgentSession | undefined;
  try {
    await loader.reload();
    const manager = SessionManager.inMemory(root);
    ({ session } = await createAgentSession({ cwd: root, agentDir: join(root, 'agent'), modelRuntime: await p12Runtime(), model: p12Model,
      settingsManager: p12Settings(), resourceLoader: loader, sessionManager: manager, tools: useTool ? ['probe_value'] : [], customTools: [], thinkingLevel: 'off' }));
    const trace: P12Trace = { calls: 0, errors: [], contexts: [], manager, loader, root };
    await session.bindExtensions({ onError: e => trace.errors.push({ event: e.event, error: e.error }) });
    session.agent.streamFunction = (_model, context) => { trace.contexts.push(structuredClone(context.messages)); trace.calls++;
      return useTool && trace.calls === 1 ? p12Response([{ type: 'toolCall', id: 'probe_call', name: 'probe_value', arguments: { value: 1 } }], 'toolUse') : p12Response(); };
    await action(session, trace);
  } finally { if (session) { await session.abort(); await session.waitForIdle(); session.dispose(); } rmSync(root, { recursive: true, force: true }); }
}
