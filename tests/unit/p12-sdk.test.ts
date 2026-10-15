import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverTests, runStage } from '../run';
import { createAgentSession, SessionManager, wrapRegisteredTool, type AgentSession, type RegisteredTool } from '@earendil-works/pi-coding-agent';
import { p12Loader, p12Model, p12Response, p12Runtime, p12Settings, p12ValueTool, withP12SDK } from '../fixtures/p12-extensions';
import { PiInputAdapter } from '../../packages/runtime-pi/src/input-adapter';

test('p12 stage discovers actual category files and rejects empty or mandatory skipped runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p12-runner-'));
  try {
    mkdirSync(join(root, 'tests', 'unit'), { recursive: true });
    expect(discoverTests('unit', 'P12', root)).toEqual([]);
    expect((await runStage('unit', 'P12', { root })).exitCode).toBe(1);
    const file = join(root, 'tests', 'unit', 'p12-required.test.ts');
    writeFileSync(file, 'import {test} from "bun:test"; test("required",()=>{}); test.skip("missing-required",()=>{});');
    expect(discoverTests('unit', 'P12', root)).toEqual([file]);
    const report = await runStage('unit', 'P12', { root });
    expect(report).toMatchObject({ discoveredFiles: 1, discovered: 2, executed: 1, pass: 1, fail: 0, skip: 1, exitCode: 1 });
    writeFileSync(file, 'import {test} from "bun:test"; test("required",()=>{});');
    expect(await runStage('unit', 'P12', { root })).toMatchObject({ discovered: 1, executed: 1, pass: 1, fail: 0, skip: 0, exitCode: 0 });
    writeFileSync(file,'import "./missing-engineering.ts";');
    const broken=await runStage('unit','P12',{root});expect(broken.exitCode).toBe(1);expect(broken.pass).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);

test('p12 S01 explicit selected paths load while noExtensions excludes ambient modules and disabled entry evaluation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p12-discovery-'));
  const marker = globalThis as typeof globalThis & { p12Selected?: number; p12Ambient?: number };
  delete marker.p12Selected; delete marker.p12Ambient;
  try {
    mkdirSync(join(root, '.pi', 'extensions'), { recursive: true });
    writeFileSync(join(root, '.pi', 'extensions', 'ambient.ts'), 'globalThis.p12Ambient = 1; export default function() {}');
    const selected = join(root, 'selected.ts'); writeFileSync(selected, 'globalThis.p12Selected = (globalThis.p12Selected ?? 0) + 1; export default function() {}');
    const disabled = p12Loader(root); await disabled.reload();
    expect(disabled.getExtensions().extensions).toHaveLength(0); expect(marker.p12Selected).toBeUndefined(); expect(marker.p12Ambient).toBeUndefined();
    const enabled = p12Loader(root, [], [selected]); await enabled.reload();
    expect(enabled.getExtensions().extensions).toHaveLength(1); expect(Number(marker.p12Selected)).toBe(1); expect(marker.p12Ambient).toBeUndefined();
  } finally { delete marker.p12Selected; delete marker.p12Ambient; rmSync(root, { recursive: true, force: true }); }
});

test('p12 S02 SDK retains duplicate command factories without a load error so product must reject conflict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p12-conflict-')); let count = 0;
  try {
    const loader = p12Loader(root, [0, 1].map(index => ({ name: `probe-${index}`, factory: pi => { count++; pi.registerCommand('same', { description: 'ENGINEERING', handler: async () => {} }); } })));
    await loader.reload(); expect(count).toBe(2); expect(loader.getExtensions().errors).toHaveLength(0);
    expect(loader.getExtensions().extensions.filter(extension => extension.commands.has('same'))).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('p12 S03 SDK tool_call mutation is the actual execute input', async () => {
  let value: unknown;
  await withP12SDK(pi => { pi.registerTool(p12ValueTool(input => value = input)); pi.on('tool_call', event => { if ('value' in event.input) event.input.value = 2; }); }, async session => {
    await session.prompt('ENGINEERING'); expect(value).toBe(2);
  });
});
test('p12 S04 SDK does not revalidate arguments after hook mutation', async () => {
  let value: unknown;
  await withP12SDK(pi => { pi.registerTool(p12ValueTool(input => value = input)); pi.on('tool_call', event => { if ('value' in event.input) event.input.value = 'after-schema'; }); }, async session => {
    await session.prompt('ENGINEERING'); expect(value).toBe('after-schema');
  });
});
test('p12 S05 tool_call throw blocks execute but SDK continues the next model without a product fatal guard', async () => {
  let executions = 0;
  await withP12SDK(pi => { pi.registerTool(p12ValueTool(() => ++executions)); pi.on('tool_call', () => { throw new Error('ENGINEERING'); }); }, async (session, trace) => {
    await session.prompt('ENGINEERING'); expect(executions).toBe(0); expect(trace.calls).toBe(2);
    const result = trace.manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'toolResult');
    expect(result?.type === 'message' && result.message.role === 'toolResult' && result.message.isError).toBe(true);
  });
});
test('p12 S06 tool_result throw is reported and the original successful result remains', async () => {
  await withP12SDK(pi => { pi.registerTool(p12ValueTool(input => input)); pi.on('tool_result', () => { throw new Error('ENGINEERING'); }); }, async (session, trace) => {
    await session.prompt('ENGINEERING'); expect(trace.errors.some(error => error.event === 'tool_result')).toBe(true);
    const result = trace.manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'toolResult');
    expect(result?.type === 'message' && result.message.role === 'toolResult' && result.message.isError).toBe(false);
  });
});
test('p12 S07 native input transform changes the actual persisted user message', async () => {
  await withP12SDK(pi => { pi.on('input', event => ({ action: 'transform', text: 'TRANSFORMED:' + event.text })); }, async (session, trace) => {
    await session.prompt('raw'); const user = trace.manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'user');
    expect(user?.type === 'message' && user.message.role === 'user' ? user.message.content : null).toEqual([{ type: 'text', text: 'TRANSFORMED:raw' }]);
  }, false);
});
test('p12 S08 input and context throw are reported while SDK still sends the model request', async () => {
  await withP12SDK(pi => { pi.on('input', () => { throw new Error('ENGINEERING input'); }); pi.on('context', () => { throw new Error('ENGINEERING context'); }); }, async (session, trace) => {
    await session.prompt('raw'); expect(trace.calls).toBe(1); expect(trace.errors.map(error => error.event)).toEqual(['input', 'context']);
  }, false);
});
test('p12 S09 headless command has no UI or model call and on unsubscribe works but dispose emits no shutdown', async () => {
  let starts = 0, shutdowns = 0, hasUI: boolean | undefined, unsubscribe: (() => void) | undefined;
  await withP12SDK(pi => { unsubscribe = pi.on('agent_start', () => { starts++; }); pi.on('session_shutdown', () => { shutdowns++; });
    pi.registerCommand('status', { description: 'ENGINEERING', handler: async (_args, context) => { hasUI = context.hasUI; } }); }, async (session, trace) => {
    await session.prompt('/status'); expect(trace.calls).toBe(0); expect(hasUI).toBe(false);
    await session.prompt('raw'); expect(starts).toBe(1); expect(typeof unsubscribe).toBe('function'); unsubscribe!();
    await session.prompt('again'); expect(starts).toBe(1); session.dispose(); expect(shutdowns).toBe(0);
  }, false);
});
test('p12 S10 command handler error is observable even when public prompt resolves', async () => {
  await withP12SDK(pi => { pi.registerCommand('fault', { description: 'ENGINEERING', handler: async () => { throw new Error('ENGINEERING'); } }); }, async (session, trace) => {
    await session.prompt('/fault'); expect(trace.calls).toBe(0); expect(trace.errors.some(error => error.event === 'command')).toBe(true);
  }, false);
});
test('p12 S11 native survivor queue exists while Session and Extension queue shadows are zero', async () => {
  await withP12SDK(() => {}, async session => {
    session.clearQueue(); session.agent.steer({ role: 'user', content: [{ type: 'text', text: 'survivor' }], timestamp: Date.now() });
    expect(session.agent.hasQueuedMessages()).toBe(true); expect(session.pendingMessageCount).toBe(0);
    expect(session.extensionRunner?.createContext().hasPendingMessages()).toBe(false); session.clearQueue();
  }, false);
});
test('p12 S12 public registered tool bridge preserves one actual tool call and both hooks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p12-bridge-')); let session: AgentSession | undefined, registered: RegisteredTool | undefined;
  let bridgeCalls = 0, executions = 0, before = 0, after = 0, calls = 0;
  try {
    const loader = p12Loader(root, [{ name: 'probe', factory: pi => { pi.registerTool(p12ValueTool(value => { executions++; return value; }));
      pi.on('tool_call', () => { before++; }); pi.on('tool_result', () => { after++; }); } }], [], base => {
        registered = base.extensions[0]!.tools.get('probe_value'); return { ...base, extensions: base.extensions.map(extension => ({ ...extension, tools: new Map() })) };
      });
    await loader.reload(); expect(loader.getExtensions().extensions[0]!.tools.size).toBe(0);
    ({ session } = await createAgentSession({ cwd: root, agentDir: join(root, 'agent'), modelRuntime: await p12Runtime(), model: p12Model,
      settingsManager: p12Settings(), resourceLoader: loader, sessionManager: SessionManager.inMemory(root), tools: ['probe_value'],
      customTools: [{ ...registered!.definition, execute: async (id, params, signal, update) => { bridgeCalls++; return wrapRegisteredTool(registered!, session!.extensionRunner!).execute(id, params, signal, update); } }], thinkingLevel: 'off' }));
    await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
    session.agent.streamFunction = () => ++calls === 1 ? p12Response([{ type: 'toolCall', id: 'bridge-call', name: 'probe_value', arguments: { value: 9 } }], 'toolUse') : p12Response();
    await session.prompt('ENGINEERING'); expect([bridgeCalls, executions, before, after, calls]).toEqual([1, 1, 1, 1, 2]); expect(session.getActiveToolNames()).toEqual(['probe_value']);
  } finally { if (session) { await session.abort(); await session.waitForIdle(); session.dispose(); } rmSync(root, { recursive: true, force: true }); }
});
test('p12 S13 captured bound public prompt calls SDK command after method replacement with no history or model', async () => {
  let commands = 0;
  await withP12SDK(pi => { pi.registerCommand('status', { description: 'ENGINEERING', handler: async () => { commands++; } }); }, async (session, trace) => {
    const original = session.prompt.bind(session), entries = trace.manager.getEntries().length;
    session.prompt = async () => { throw new Error('ENGINEERING replaced public method'); };
    await original('/status', { expandPromptTemplates: true }); expect(commands).toBe(1); expect(trace.calls).toBe(0); expect(trace.manager.getEntries()).toHaveLength(entries);
  }, false);
});

test('p12 command capture survives the real input adapter without creating an uncontrolled input', async () => {
  let commands = 0;
  await withP12SDK(pi => { pi.registerCommand('status', { description: 'ENGINEERING', handler: async () => { commands++; } }); }, async (session, trace) => {
    const captured = session.prompt.bind(session), entries = trace.manager.getEntries().length;
    const unexpected = () => { throw new Error('Command entered product input delivery'); };
    const adapter = new PiInputAdapter(session, trace.manager, { runId: 1, sessionId: 1,
      delivered: unexpected, consumed: unexpected, failed: unexpected, fatal: unexpected, admissionClosed: () => {} });
    try {
      await captured('/status', { expandPromptTemplates: true });
      expect(commands).toBe(1); expect(trace.calls).toBe(0); expect(trace.manager.getEntries()).toHaveLength(entries);
    } finally { adapter.dispose(); }
  }, false);
});

test('p12 a single type-only SDK module imports from an external managed Run copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p12-module-'));
  try {
    const dir = join(root, 'extensions', 'tool-audit', 'v1', 'a'.repeat(64)); mkdirSync(dir, { recursive: true });
    const entry = join(dir, 'index.ts');
    writeFileSync(entry, 'import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"; export const create = (): ExtensionFactory => pi => { pi.registerCommand("status", {description:"ENGINEERING", handler:async()=>{}}); };');
    const module = await import(entry); let registrations = 0;
    module.create()({ registerCommand: (name: string) => { expect(name).toBe('status'); registrations++; } });
    expect(registrations).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
