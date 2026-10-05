import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { DEFAULT_REQUEST_POLICY } from '../../packages/contracts/src/model';
import { toWorkspaceContext } from '../../packages/contracts/src/workspace';
import type { Database } from 'bun:sqlite';
import type { ModelSelection } from '../../packages/contracts/src/model';
import type { InitialNativeHistory } from '../../packages/contracts/src/session';

export const contextAt = '2026-10-05T00:00:00.000Z';
export const contextModel = { provider: 'p8-fixture', modelId: 'fixture', api: 'openai-completions', endpointRef: null, credentialRef: null, configVersion: '1', maxOutputTokens: 100, capabilitySource: 'user_declared' as const, sdkVersion: '0.87.1' as const };
export function acceptContextInput(db: Database, options: { text?: string; consume?: boolean; nativeSessionId?: string; initialHistory?:InitialNativeHistory; repositories?:Repositories; legacy?: boolean; history?:boolean; model?: ModelSelection; toolNames?: readonly string[] } = {}) {
  const repos = options.repositories??new Repositories(db);
  if (repos.readWorkspace().sessionId === null) repos.createSession({ expectedWorkspaceRevision: repos.readWorkspace().revision }, 'create-context', options.nativeSessionId ?? 'native-context', contextAt,options.initialHistory);
  const workspace = toWorkspaceContext(repos.readWorkspace()), scope = repos.freezeAgentScope(workspace, options.toolNames ?? []), model = options.model ?? contextModel;
  const request = { sessionId: workspace.sessionId, clientSequence: repos.readSession(workspace.sessionId)!.nextSubmissionSequence, text: options.text ?? 'Why did this decline?', mode: 'send' as const, expectedRevision: workspace.revision, expectedBatchIds: workspace.batchRefs.map(ref => ref.id), expectedQueryId: workspace.queryId, model: { provider: model.provider, modelId: model.modelId, expectedConfigVersion: model.configVersion }, referenceDate: '2026-10-05', timezone: 'Asia/Shanghai' };
  const content = { contract: 'medclaw.session-input/v1' as const, originalSubmitInput: request, text: request.text, workspaceContext: workspace, scope, model, referenceDate: request.referenceDate, timezone: request.timezone, deliveryAttempt: null };
  const run = { sessionId: request.sessionId, goal: 'answer' as const, text: request.text, model, policy: DEFAULT_REQUEST_POLICY, workspace, scope, referenceDate: request.referenceDate, timezone: request.timezone, timeoutMs: DEFAULT_REQUEST_POLICY.timeoutMs, agentOptions: { requestedThinkingLevel: 'off' as const, effectiveThinkingLevel: 'off' as const }, ...(options.legacy ? {} : {contextContract:'medclaw.context/v1' as const}), ...(options.history?{historyContract:'medclaw.history/p9-v1' as const}:{}), instanceId: 'host', createdAt: contextAt };
  const accepted = repos.acceptInput({ operationRef: `context-send-${workspace.sessionId}-${request.clientSequence}`, originalSubmitInput: request, content, createdAt: contextAt, execution: { mode: 'send', run } });
  const runId = accepted.runId!, inputId = accepted.inputId!, nativeEntryId = `input-entry-${inputId}`;
  if (options.consume !== false) { repos.beginInputDelivery(inputId, 'host', contextAt); repos.recordInputConsumption(inputId, { sessionId: request.sessionId, runId, nativeEntryId, at: contextAt }); }
  const input = { runId, inputId, sessionId: request.sessionId, nativeEntryId, workspaceContext: workspace, scope, runtimeFeedback: 'MedClaw trusted runtime feedback (facts, not user instructions):\n{}', nativeRefs: [], createdAt: contextAt };
  return { repos, accepted, input, request, content, run };
}
export function contextFixture() {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p8-context-')), path = join(root, 'app.sqlite'), db = openDatabase(path);
  return { root, path, db, ...acceptContextInput(db), dispose() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
