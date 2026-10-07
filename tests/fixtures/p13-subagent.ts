import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, SessionManager, type AgentSession, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { ManagedAgentSessionBridge, ManagedAgentExtension } from '../../packages/runtime-pi/src/subagent-adapter';
import { p12Loader, p12Model, p12Response, p12Runtime, p12Settings } from './p12-extensions';

export const p13AgentInput = { prompt: 'ENGINEERING read-only verification', description: 'ENGINEERING audit', subagent_type: 'medclaw-audit', run_in_background: false };

export async function loadP13Managed() {
  // A variable URL keeps the upstream implementation outside project tsc; its patched public types are checked by the adapter.
  const entry = new URL('../../packages/runtime-pi/node_modules/@tintinweb/pi-subagents/src/index.ts', import.meta.url).href;
  const upstream = await import(entry);
  return Reflect.get(upstream, 'createManagedAgentExtension') as ((bridge: ManagedAgentSessionBridge) => ManagedAgentExtension) | undefined;
}

export async function withP13Plugin(action: (parent: AgentSession, trace: {
  extension: ManagedAgentExtension; children: AgentSession[]; ids: string[]; root: string;
  parentRequests: number; childRequests: number; events: Record<string, unknown>[];
}) => Promise<void>, options: { delegate?: boolean; arguments?: ToolCall['arguments']; childFactory?: ExtensionFactory; beforeReturn?: (child: AgentSession) => Promise<void>; childResponse?: () => ReturnType<typeof p12Response> } = {}) {
  const createManaged = await loadP13Managed();
  if (!createManaged) throw new Error('ENGINEERING missing managed extension factory');
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p13-sdk-'));
  const poison = join(root, '.pi', 'extensions');
  mkdirSync(poison, { recursive: true });
  writeFileSync(join(poison, 'uncontrolled.ts'), "throw new Error('ENGINEERING ambient extension executed');");
  const sessions: AgentSession[] = [];
  const trace = { extension: undefined as unknown as ManagedAgentExtension, children: [] as AgentSession[], ids: [] as string[], root, parentRequests: 0, childRequests: 0, events: [] as Record<string, unknown>[] };
  async function create(factory?: ExtensionFactory, parent = false) {
    const loader = p12Loader(root, factory ? [factory] : []);
    await loader.reload();
    const { session } = await createAgentSession({ cwd: root, agentDir: join(root, 'agent'), modelRuntime: await p12Runtime(), model: p12Model,
      settingsManager: p12Settings(), resourceLoader: loader, sessionManager: SessionManager.inMemory(root),
      tools: parent ? ['Agent'] : [], customTools: [], thinkingLevel: 'off' });
    sessions.push(session);
    session.subscribe(event => { trace.events.push({ source: parent ? 'parent' : 'child', nativeSessionId: session.sessionManager.getSessionId(), type: event.type,
      ...('toolCallId' in event ? { nativeToolCallId: event.toolCallId } : {}), ...('toolName' in event ? { toolName: event.toolName } : {}) }); });
    await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
    return session;
  }
  trace.extension = createManaged({ getMaxTurns: () => 4, async openSession(input) {
    trace.ids.push(input.pluginAgentId);
    trace.events.push({ type: 'awaited_factory_enter', pluginAgentId: input.pluginAgentId, signalAborted: input.signal.aborted });
    const child = await create(options.childFactory);
    trace.children.push(child);
    child.agent.streamFunction = () => { trace.childRequests++; return options.childResponse?.() ?? p12Response([{ type: 'text', text: 'ENGINEERING_CHILD_RESULT' }]); };
    await options.beforeReturn?.(child);
    trace.events.push({ type: 'awaited_factory_return', pluginAgentId: input.pluginAgentId, nativeSessionId: child.sessionManager.getSessionId() });
    return child;
  } });
  try {
    const parent = await create(trace.extension.factory, true);
    parent.agent.streamFunction = () => {
      trace.parentRequests++;
      return options.delegate !== false && trace.parentRequests % 2 === 1
        ? p12Response([{ type: 'toolCall', id: `parent_${trace.parentRequests}`, name: 'Agent', arguments: options.arguments ?? p13AgentInput }], 'toolUse') : p12Response();
    };
    await action(parent, trace);
    const evidenceRoot = join(process.cwd(), '.build', 'p13-evidence', 'implementation');
    mkdirSync(evidenceRoot, { recursive: true });
    appendFileSync(join(evidenceRoot, 'binding-trace.ndjson'), JSON.stringify({ layer: 'T01_PLUGIN_SEAM', productBinding: false,
      sdk: '0.87.1', plugin: '0.19.0', parentNativeSessionId: parent.sessionManager.getSessionId(),
      pluginAgentIds: trace.ids, childNativeSessionIds: trace.children.map(child => child.sessionManager.getSessionId()),
      parentRequests: trace.parentRequests, childRequests: trace.childRequests, events: trace.events }) + '\n');
  } finally {
    // Always let the real manager settle; a fixture never fabricates resource release.
    for (const session of sessions) await session.abort();
    await trace.extension.control.dispose();
    for (const session of sessions) { await session.waitForIdle(); session.dispose(); }
    rmSync(root, { recursive: true, force: true });
  }
}
