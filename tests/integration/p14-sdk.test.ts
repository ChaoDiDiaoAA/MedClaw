import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { providerFixture } from '../fixtures/p1-provider';
import { p12Loader, p12Model, p12Runtime, p12Settings } from '../fixtures/p12-extensions';

test('p14 public Pi history sends user/custom content in an actual provider request and keeps details private', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p14-sdk-'));
  const receiver = providerFixture();
  let session: AgentSession | undefined;
  try {
    const manager = SessionManager.inMemory(root);
    const userId = manager.appendMessage({ role: 'user', content: 'ENGINEERING_ORIGINAL_REQUEST', timestamp: Date.now() });
    const resultId = manager.appendCustomMessageEntry('medclaw-query-result', 'ENGINEERING_PROGRAM_QUERY_RESULT', true,
      { privateDetail: 'ENGINEERING_DETAILS_NOT_MODEL_INPUT' });
    const conditionId = manager.appendCustomEntry('medclaw-query-context', { sentinel: 'ENGINEERING_CONDITION_NOT_MODEL_INPUT' });
    expect(manager.getEntry(resultId)?.parentId).toBe(userId);
    expect(manager.getEntry(conditionId)?.parentId).toBe(resultId);
    const header = manager.getHeader();
    if (!header) throw new Error('SDK did not create a real header');
    const restored = SessionManager.inMemory(root, undefined, [header, ...manager.getEntries()]);
    restored.branch(conditionId);
    expect(restored.getLeafId()).toBe(conditionId);
    const loader = p12Loader(root);
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir: join(root, 'agent'),
      modelRuntime: await p12Runtime(), model: { ...p12Model, baseUrl: receiver.url },
      settingsManager: p12Settings(), resourceLoader: loader, sessionManager: restored,
      tools: [], customTools: [], thinkingLevel: 'off' }));
    await session.bindExtensions({ onError: event => { throw new Error(event.error); } });
    await session.prompt('ENGINEERING_FOLLOWUP_REQUEST', { expandPromptTemplates: false });
    await session.waitForIdle();
    expect(session.isIdle).toBe(true);
    expect(receiver.requests).toHaveLength(1);
    const payload = JSON.stringify(receiver.requests[0]!.body);
    for (const sentinel of ['ENGINEERING_ORIGINAL_REQUEST', 'ENGINEERING_PROGRAM_QUERY_RESULT', 'ENGINEERING_FOLLOWUP_REQUEST']) {
      expect(payload).toContain(sentinel);
      expect(payload.split(sentinel)).toHaveLength(2);
    }
    expect(payload).not.toContain('ENGINEERING_DETAILS_NOT_MODEL_INPUT');
    expect(payload).not.toContain('ENGINEERING_CONDITION_NOT_MODEL_INPUT');
    restored.branch(userId);
    expect(restored.getBranch().map(entry => entry.id)).toContain(userId);
    expect(restored.getBranch().map(entry => entry.id)).not.toContain(conditionId);
    expect(restored.buildSessionContext().messages.map(message => JSON.stringify(message)).join('')).not.toContain('ENGINEERING_PROGRAM_QUERY_RESULT');
    expect(receiver.requests).toHaveLength(1);
  } finally {
    if (session) { await session.abort(); await session.waitForIdle(); session.dispose(); }
    receiver.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
