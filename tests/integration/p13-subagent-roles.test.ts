import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicMethodSchemas, PublicHostRequestSchema, HOST_PROTOCOL_VERSION } from '../../packages/contracts/src/protocol';
import { PublishedSettingsSchema, DEFAULT_REQUEST_POLICY } from '../../packages/contracts/src/model';
import { toWorkspaceContext } from '../../packages/contracts/src/workspace';
import { ResourceService } from '../../packages/core/src/resources/resource-service';
import { createResourceSource, createSubagentRoleSource } from '../../packages/runtime-pi/src/resource-loader';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { acceptContextInput, contextAt, contextModel } from '../fixtures/p8-context';

const role = (id: string, tools: string[] = [], body = 'Independent supplied-material analysis.') =>
  `---\nname: ${id}\ndescription: Independent analysis\ntools: ${JSON.stringify(tools)}\n---\n${body}\n`;
async function fixture(action: (f: { repos: Repositories; service: ResourceService; db: ReturnType<typeof openDatabase>; user: string; root: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-role-api-')), db = openDatabase(join(root, 'app.sqlite'));
  try {
    const repos = new Repositories(db);
    repos.createSession({ expectedWorkspaceRevision: 0 }, 'create-roles', 'native-roles', contextAt);
    const author = join(import.meta.dir, '../../resources'), user = join(root, 'subagents');
    const source = createSubagentRoleSource(join(author, 'subagents'), user);
    const auditTools = (await source.read('medclaw-audit')).declaredTools;
    const settings = PublishedSettingsSchema.parse({ schemaVersion: 'medclaw.settings/p1-v1', configVersion: '1', model: null,
      customProviders: [], credentialRefs: {}, previous: null, rollbackFromVersion: null });
    const service = new ResourceService(() => settings, repos, createResourceSource(author), () => auditTools, source, () => auditTools);
    await action({ repos, service, db, user, root });
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

test('p13 role public contracts enforce original source and mandatory expected content', () => {
  for (const method of ['subagents.list', 'subagents.read', 'subagents.save'] as const) expect(publicMethodSchemas[method]).toBeDefined();
  expect(publicMethodSchemas['subagents.list'].input.safeParse({ source: 'run', runId: 1, sessionId: 1 }).success).toBe(false);
  expect(publicMethodSchemas['subagents.save'].input.safeParse({ sessionId: 1, roleId: 'reviewer', content: role('reviewer') }).success).toBe(false);
  const payload = { source: 'selection', sessionId: 1, roleId: 'general-analyst' };
  expect(PublicHostRequestSchema.safeParse({ protocolVersion: HOST_PROTOCOL_VERSION, kind: 'request', requestId: 'read-role', operationRef: 'read-role', instanceId: 'host', method: 'subagents.read', payload }).success).toBe(true);
});

test('p13 role management and current availability do not create inputs runs or model requests', async () => fixture(async ({ repos, service, db, user }) => {
  const list = await service.listSubagents({ source: 'selection', sessionId: 1 });
  expect(list.items.find(item => item.roleId === 'general-analyst')).toMatchObject({ valid: true, available: true, declaredTools: [] });
  const original = await service.readSubagent({ source: 'selection', sessionId: 1, roleId: 'medclaw-audit' });
  expect(original).toMatchObject({ editable: true, expectedContent: original.content });
  const saved = await service.saveSubagent({ sessionId: 1, roleId: 'medclaw-audit', content: role('medclaw-audit'), expectedContent: original.content });
  expect(saved.source.kind).toBe('user');
  await writeFile(join(user, 'unknown.md'), role('unknown', ['not_registered']));
  const unknown = (await service.listSubagents({ source: 'selection', sessionId: 1 })).items.find(item => item.roleId === 'unknown');
  expect(unknown).toMatchObject({ valid: true, available: false, declaredTools: ['not_registered'] });
  expect(unknown!.reasons.length).toBeGreaterThan(0);
  expect(db.query('SELECT * FROM runs').all()).toEqual([]);
  expect(db.query('SELECT * FROM session_inputs').all()).toEqual([]);
  expect(db.query('SELECT * FROM model_calls').all()).toEqual([]);
  expect(repos.readSession(1)!.nextSubmissionSequence).toBe(1);
}));

test('p13 accepted Run role snapshots survive edits while requests and body sources stay independent', async () => fixture(async ({ repos, service, db }) => {
  const workspace = repos.readWorkspace(), context = toWorkspaceContext(workspace), scope = repos.freezeAgentScope(context, ['read']);
  const frozen = await service.freezeSubagents(1, scope);
  expect(frozen).toBeDefined();
  expect(frozen!.roles.find(item => item.roleId === 'general-analyst')!.declaredTools).toEqual([]);
  expect(frozen!.indexText).toContain('general-analyst');
  expect(frozen!.indexText).not.toContain('Analyze only the task materials supplied by the parent.');
  const request = { sessionId: 1, clientSequence: 1, text: 'Inspect supplied materials', mode: 'send' as const,
    expectedRevision: context.revision, expectedBatchIds: [], expectedQueryId: null,
    model: { provider: contextModel.provider, modelId: contextModel.modelId, expectedConfigVersion: '1' }, referenceDate: '2026-10-21', timezone: 'Asia/Shanghai' };
  const content = { contract: 'medclaw.session-input/v1' as const, originalSubmitInput: request, text: request.text, workspaceContext: context,
    scope, model: contextModel, referenceDate: request.referenceDate, timezone: request.timezone, deliveryAttempt: null };
  const run = { sessionId: 1, goal: 'answer' as const, text: request.text, model: contextModel, policy: DEFAULT_REQUEST_POLICY, workspace, scope,
    referenceDate: request.referenceDate, timezone: request.timezone, timeoutMs: DEFAULT_REQUEST_POLICY.timeoutMs,
    agentOptions: { requestedThinkingLevel: 'off' as const, effectiveThinkingLevel: 'off' as const }, instanceId: 'host', createdAt: contextAt, subagents: frozen };
  const accepted = repos.acceptInput({ operationRef: 'role-run', originalSubmitInput: request, content, createdAt: contextAt, execution: { mode: 'send', run } });
  const original = await service.readSubagent({ source: 'selection', sessionId: 1, roleId: 'general-analyst' });
  await service.saveSubagent({ sessionId: 1, roleId: 'general-analyst', content: role('general-analyst', [], 'Changed for later runs.'), expectedContent: original.content });
  expect(await service.readSubagent({ source: 'run', runId: accepted.runId!, roleId: 'general-analyst' })).toMatchObject({ content: original.content, editable: false, expectedContent: null });
  const recorded = await service.listSubagents({ source: 'run', runId: accepted.runId! });
  expect(recorded).toMatchObject({ recorded: true });
  expect(recorded.items.find(item => item.roleId === 'medclaw-audit')).toMatchObject({ available: false });
  expect(db.query('SELECT * FROM model_calls').all()).toEqual([]);
}));

test('p13 legacy Run without role snapshots is not populated from current role files', async () => fixture(async ({ repos, service, db }) => {
  const previous = acceptContextInput(db, { repositories: repos, consume: false });
  expect(await service.listSubagents({ source: 'run', runId: previous.input.runId })).toMatchObject({ items: [], recorded: false, reasons: ['not_recorded'] });
  await expect(service.readSubagent({ source: 'run', runId: previous.input.runId, roleId: 'general-analyst' })).rejects.toMatchObject({ code: 'resource_unavailable', reason: 'resource_missing' });
  expect((await service.listSubagents({ source: 'selection', sessionId: 1 })).items.map(item => item.roleId)).toContain('general-analyst');
}));
