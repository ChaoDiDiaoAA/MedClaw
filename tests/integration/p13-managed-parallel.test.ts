import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { loadP13Managed, p13AgentInput } from '../fixtures/p13-subagent';
import { p12Loader, p12Model, p12Response, p12Runtime, p12Settings } from '../fixtures/p12-extensions';
import { createRunSubagent, type ManagedAgentSessionBridge } from '../../packages/runtime-pi/src/subagent-adapter';
import type { ChildExecutionObservation, CommittedChildResult } from '../../packages/contracts/src/subagent';
import type { ToolExecutionContext } from '../../packages/contracts/src/tool';
import { safeError } from '../../packages/contracts/src/error';
import { freezeRunExtensions, loadRunExtension } from '../../packages/runtime-pi/src/extension-loader';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';

test('p13 managed original SDK calls retain four exact origins until release and cancel one child only', async () => {
  const createManaged = await loadP13Managed();
  if (!createManaged) throw new Error('Missing managed plugin');
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p13-parallel-'));
  const sessions: AgentSession[] = [];
  const requests: Parameters<ManagedAgentSessionBridge['openSession']>[0][] = [];
  const gates: (() => void)[] = [];
  let childRequests = 0;
  async function create(parent = false) {
    const loader = p12Loader(root, parent ? [managed.factory] : []);
    await loader.reload();
    const { session } = await createAgentSession({ cwd: root, agentDir: join(root, 'agent'),
      modelRuntime: await p12Runtime(), model: p12Model, settingsManager: p12Settings(), resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root), tools: parent ? ['Agent'] : [], customTools: [], thinkingLevel: 'off' });
    sessions.push(session);
    await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
    return session;
  }
  const managed = createManaged({ getMaxTurns: () => 4, async openSession(request) {
    requests.push(request);
    const child = await create();
    const gate = new Promise<void>(resolve => gates.push(resolve));
    child.agent.streamFunction = async () => { childRequests++; await gate; return p12Response(); };
    return child;
  } });
  let running: Promise<void> | undefined;
  try {
    const parent = await create(true);
    let turn = 0;
    parent.agent.streamFunction = () => ++turn === 1
      ? p12Response(Array.from({ length: 5 }, (_, index) => ({ type: 'toolCall' as const, id: `native-${index}`,
        name: 'Agent', arguments: { ...p13AgentInput, subagent_type: index % 2 ? 'general-analyst' : 'medclaw-audit' } })), 'toolUse')
      : p12Response();
    running = parent.prompt('ENGINEERING identical tasks retain their exact originating call');
    const deadline = Date.now() + 3000;
    while (childRequests < 4 && Date.now() < deadline) await Bun.sleep(10);
    expect(childRequests).toBe(4);
    expect(requests).toHaveLength(4);
    expect(requests.map(request => request.nativeToolCallId).sort()).toEqual(['native-0', 'native-1', 'native-2', 'native-3']);
    expect(requests.map(request => request.roleId)).toEqual(['medclaw-audit', 'general-analyst', 'medclaw-audit', 'general-analyst']);
    expect(new Set(requests.map(request => request.pluginAgentId)).size).toBe(4);
    managed.control.cancel(requests[0]!.pluginAgentId);
    for (const release of gates) release();
    await running;
    const records = await Promise.all(requests.map(request => managed.control.waitForSettled(request.pluginAgentId)));
    expect(records.map(record => record.status)).toEqual(['stopped', 'completed', 'completed', 'completed']);
    const originalMessages = JSON.stringify(parent.sessionManager.getEntries());
    expect(originalMessages).toContain('runtime_busy');
    expect(originalMessages).toContain('native-4');
    parent.agent.streamFunction = () => ++turn % 2 === 1
      ? p12Response([{ type: 'toolCall', id: 'after-terminal', name: 'Agent', arguments: p13AgentInput }], 'toolUse')
      : p12Response();
    await parent.prompt('ENGINEERING terminal children still own all slots');
    expect(childRequests).toBe(4);
    await managed.control.release(requests[0]!.pluginAgentId);
    parent.agent.streamFunction = () => ++turn % 2 === 1
      ? p12Response([{ type: 'toolCall', id: 'after-release', name: 'Agent', arguments: p13AgentInput }], 'toolUse')
      : p12Response();
    running = parent.prompt('ENGINEERING release permits one fresh identity');
    while (childRequests < 5 && Date.now() < deadline + 3000) await Bun.sleep(10);
    expect(childRequests).toBe(5);
    expect(requests[4]!.nativeToolCallId).toBe('after-release');
    gates[4]!();
    await running;
  } finally {
    for (const release of gates) release();
    await running?.catch(() => {});
    await managed.control.dispose();
    for (const session of sessions) { await session.abort(); await session.waitForIdle(); session.dispose(); }
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

for (const unexpected of [false, true]) test(`p13 audit command composition keeps strict registered commands (${unexpected ? 'reject extra' : 'explicit managed command'})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p13-audit-command-'));
  let session: AgentSession | undefined;
  const owner = { instanceId: 'host', sessionId: 1, runId: 1, assemblyId: 'audit-assembly' };
  const settings = PublishedSettingsSchema.parse({ schemaVersion: 'medclaw.settings/p1-v1', configVersion: '1', model: null,
    customProviders: [], credentialRefs: {}, previous: null, rollbackFromVersion: null,
    requestPolicy: { timeoutMs: 15000, maxRetries: 0, maxRetryDelayMs: 2000 },
    extensions: { bySession: { '1': { extension: { id: 'tool-audit', version: 'v1' } } } } });
  const frozen = await freezeRunExtensions(resolve('resources/extensions'), 1, settings);
  const extension = await loadRunExtension(root, frozen, owner, { fatal() {}, abort() {}, proof() {} }, [], () => session);
  const createManaged = await loadP13Managed(); if (!createManaged) throw new Error('Missing managed plugin');
  const managed = createManaged({ getMaxTurns: () => 4, async openSession() { throw new Error('No delegation expected'); } });
  try {
    const loader = p12Loader(root, [extension.factory, managed.factory, ...(unexpected ? [(pi: Parameters<typeof managed.factory>[0]) => {
      pi.registerCommand('unexpected', { async handler() {} });
    }] : [])], [], base => {
      extension.override({ ...base, extensions: base.extensions.filter(item => item.tools.has('extension_runtime_status')) });
      return base;
    });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir: join(root, 'agent'),
      modelRuntime: await p12Runtime(), model: p12Model, settingsManager: p12Settings(), resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root), tools: ['extension_runtime_status'], customTools: [], thinkingLevel: 'off' }));
    await session.bindExtensions({ onError() {} });
    expect(() => extension.active(session!)).toThrow(safeError('extension_conflict').message);
    expect(() => extension.active(session!, ['subagent', 'subagent'])).toThrow(safeError('extension_conflict').message);
    expect(() => extension.active(session!, ['arbitrary'])).toThrow(safeError('extension_conflict').message);
    if (unexpected) expect(() => extension.active(session!, ['subagent'])).toThrow(safeError('extension_conflict').message);
    else { extension.active(session, ['subagent']); expect(extension.proof.state).toBe('active'); }
  } finally {
    await managed.control.dispose(); await extension.close(() => {}); session?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('p13 real subagent command returns a bound receipt without appending history or creating a model request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p13-command-'));
  let session: AgentSession | undefined, requests = 0, children = 0;
  const owner = { instanceId: 'host', sessionId: 1, runId: 1, assemblyId: 'managed-assembly' };
  const adapter = createRunSubagent({ runId: 1, sessionId: 1, owner, getSession: () => session, getMaxTurns: () => 4,
    verifyRole(roleId) { if (roleId !== 'general-analyst') throw safeError('resource_unavailable'); },
    async open() { children++; throw new Error('Command must never create a child'); }, async settle() { return null; },
    finish() { throw new Error('Command must never finish a child'); }, acknowledge() {}, async release() {}, fatal() {} });
  try {
    const loader = p12Loader(root, [adapter.factory], [], adapter.override); await loader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir: join(root, 'agent'),
      modelRuntime: await p12Runtime(), model: p12Model, settingsManager: p12Settings(), resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root), tools: [], customTools: [], thinkingLevel: 'off' }));
    await session.bindExtensions({ onError() {} });
    session.agent.streamFunction = () => { requests++; return p12Response(); };
    const before = session.sessionManager.getEntries();
    const command = { inputId: 20, operationRef: 'accepted-command', ...owner,
      text: '/subagent general-analyst ENGINEERING analyze these supplied facts', roleId: 'general-analyst',
      task: 'ENGINEERING analyze these supplied facts', invoke: (text: string) => session!.prompt(text, { expandPromptTemplates: true }) };
    const receipt = await adapter.prepareCommand(command);
    expect(session.extensionRunner.getCommand('subagent')?.name).toBe('subagent');
    expect(receipt).toMatchObject({ owner, operationRef: command.operationRef, inputId: 20,
      roleId: command.roleId, task: command.task, name: 'subagent', kind: 'command' });
    expect(receipt.dispatchText).toContain(command.roleId);
    expect(receipt.dispatchText).toContain(command.task);
    expect(session.sessionManager.getEntries()).toEqual(before);
    expect(requests).toBe(0); expect(children).toBe(0);
    await expect(adapter.prepareCommand({ ...command, runId: 999 })).rejects.toMatchObject({ code: 'access_denied' });
    await expect(adapter.prepareCommand({ ...command, invoke: async () => {} })).rejects.toMatchObject({ code: 'extension_command_failed' });
    await expect(adapter.prepareCommand({ ...command, task: 'wrong task' })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(requests).toBe(0); expect(children).toBe(0);
    await adapter.close();
    await expect(adapter.prepareCommand(command)).rejects.toMatchObject({ code: 'state_conflict' });
  } finally {
    await adapter.close();
    session?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

for (const fault of ['final', 'release'] as const) test(`p13 adapter retries only the original ${fault} fact without crossing four SDK invocations`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p13-adapter-'));
  const children: AgentSession[] = [];
  const gates: (() => void)[] = [];
  const observations = new Map<string, ChildExecutionObservation>();
  const finishes: string[] = [], acknowledgements: string[] = [], released: string[] = [], fatals: string[] = [];
  let parent: AgentSession | undefined, requests = 0, failed = false;
  const adapter = createRunSubagent({ runId: 1, sessionId: 1, getSession: () => parent, getMaxTurns: () => 4,
    verifyRole(roleId) { if (!['medclaw-audit', 'general-analyst'].includes(roleId)) throw safeError('resource_unavailable'); },
    async open(origin, request) {
      expect(request.nativeToolCallId).toBe(origin.nativeToolCallId);
      expect(request.roleId).toBe(Number(origin.nativeToolCallId.slice(-1)) % 2 ? 'general-analyst' : 'medclaw-audit');
      const loader = p12Loader(root); await loader.reload();
      const { session } = await createAgentSession({ cwd: root, agentDir: join(root, 'agent'),
        modelRuntime: await p12Runtime(), model: p12Model, settingsManager: p12Settings(), resourceLoader: loader,
        sessionManager: SessionManager.inMemory(root), tools: [], customTools: [], thinkingLevel: 'off' });
      await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
      children.push(session);
      const index = Number(origin.nativeToolCallId.slice(-1)), childId = index + 10;
      observations.set(request.pluginAgentId, { identity: { instanceId: 'host', parentRunId: 1, parentSessionId: 1,
        originToolCallId: index + 100, originNativeToolCallId: origin.nativeToolCallId, pluginAgentId: request.pluginAgentId,
        nativeSessionId: session.sessionManager.getSessionId(), childRunId: childId, childSessionId: childId }, nativeIdle: true,
        calls: [], compactions: [], outcome: null, error: null,
        history: { sessionId: childId, runId: childId, expectedStorageVersion: 1, header: session.sessionManager.getHeader(), newEntries: [], activeLeafId: null },
        cleanup: { contract: 'medclaw.run-cleanup/v1', executionStarted: true, stopConfirmed: true, requiredPersistenceComplete: false,
          inputsSettled: true, resourcesReleased: false, unconfirmedItems: [], secondaryErrors: [], verifiedAt: null } });
      const gate = new Promise<void>(resolve => gates.push(resolve));
      session.agent.streamFunction = async () => { requests++; await gate; return p12Response(); };
      return session;
    },
    async settle(id) { return observations.get(id) ?? null; },
    finish(observation, reply): CommittedChildResult {
      const id = observation.identity.originNativeToolCallId; finishes.push(id);
      if (id === 'origin-0' && fault === 'final' && !failed) { failed = true; throw safeError('storage_write_failed'); }
      return { identity: observation.identity, persistence: 'committed', result: { contract: 'medclaw.child-result/v1', ...observation.identity,
        outcome: 'completed', text: id, queryRefs: [], evidenceIds: [], gaps: [], truncated: false, originalReply: reply,
        finalLeafId: null, storageVersion: 2, committedAt: new Date().toISOString() } };
    },
    acknowledge(observation) { acknowledgements.push(observation.identity.originNativeToolCallId); },
    async release(id) {
      const nativeId = observations.get(id)!.identity.originNativeToolCallId;
      if (nativeId === 'origin-0' && fault === 'release' && !failed) { failed = true; throw safeError('storage_write_failed'); }
      released.push(nativeId);
    },
    fatal(error) { fatals.push(error.code); },
  });
  let results: Promise<PromiseSettledResult<unknown>[]> | undefined;
  const context = (index: number): ToolExecutionContext => ({ runId: 1, sessionId: 1, nativeToolCallId: `origin-${index}`,
    scope: { batchIds: [], deviceIds: null, allowedToolNames: ['Agent'], allowedResourceRefs: [], artifactIds: [], readOnly: false },
    referenceDate: '2026-10-21', timezone: 'Asia/Shanghai', signal: new AbortController().signal });
  try {
    const loader = p12Loader(root, [adapter.factory], [], adapter.override); await loader.reload();
    ({ session: parent } = await createAgentSession({ cwd: root, agentDir: join(root, 'agent'),
      modelRuntime: await p12Runtime(), model: p12Model, settingsManager: p12Settings(), resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root), tools: [], customTools: [], thinkingLevel: 'off' }));
    await parent.bindExtensions({ onError: error => { throw new Error(error.error); } });
    const tool = adapter.definitions[0]!;
    expect(tool.executionMode).toBe('parallel');
    results = Promise.allSettled(Array.from({ length: 4 }, (_, index) => tool.execute({ ...p13AgentInput,
      subagent_type: index % 2 ? 'general-analyst' : 'medclaw-audit' }, context(index))));
    const deadline = Date.now() + 3000;
    while (requests < 4 && Date.now() < deadline) await Bun.sleep(10);
    expect(requests).toBe(4);
    await expect(tool.execute(p13AgentInput, context(4))).rejects.toMatchObject({ code: 'runtime_busy' });
    expect(children).toHaveLength(4);
    for (const release of gates) release();
    const settled = await results;
    expect(settled.map(result => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(fatals).toEqual(['storage_write_failed']);
    await expect(adapter.close()).rejects.toMatchObject({ code: 'stop_unconfirmed' });
    await adapter.retryPersistence();
    expect(requests).toBe(4);
    expect(finishes.filter(id => id === 'origin-0')).toHaveLength(fault === 'final' ? 2 : 1);
    for (let index = 1; index < 4; index++) expect(finishes.filter(id => id === `origin-${index}`)).toHaveLength(1);
    expect(new Set(acknowledgements).size).toBe(4);
    expect(released.sort()).toEqual(['origin-0', 'origin-1', 'origin-2', 'origin-3']);
    await adapter.close();
  } finally {
    for (const release of gates) release();
    await results;
    await adapter.retryPersistence().catch(() => {});
    await adapter.close().catch(() => {});
    for (const session of children) { await session.abort(); await session.waitForIdle(); session.dispose(); }
    parent?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
