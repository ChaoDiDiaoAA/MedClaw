import { expect, test } from 'bun:test';
import { evaluate } from '../../src/scoring/evaluate.ts';
import { hashBytes } from '../../src/adapters/product-checksums.ts';
import type { CheckSpec } from '../../src/scoring/types.ts';

type Fixture = [string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
const fixtures: Fixture[] = [
  ['provider.catalog', { models: [{ provider: 'p', model: 'm', authState: 'available', capabilitySource: 'pi' }] }, { models: [{ provider: 'p', model: 'm', authState: 'available', capabilitySource: 'pi' }], failedProviderIds: [], readableOldModelsDiscarded: false }, { readableOldModelsDiscarded: true }],
  ['provider.auth', { provider: 'p', method: 'environment', outcome: 'available' }, { provider: 'p', method: 'environment', outcome: 'available', authAttemptId: 'a', nativeAuthAvailable: true, credentialState: 'environment', secretLeaks: 0 }, { nativeAuthAvailable: false }],
  ['provider.identity', { provider: 'p', model: 'm' }, { provider: 'p', model: 'm', requestId: 'r' }, { model: 'other' }],
  ['provider.output_limit', { valid: true, maxTokens: 10 }, { sent: true, maxTokens: 10, trustedMaxTokens: 20, rejected: false }, { maxTokens: 21 }],
  ['provider.usage', {}, { source: 'native', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, { output: -1 }],
  ['provider.error', { category: 'network', target: 'p/m' }, { category: 'network', target: 'p/m', fallbackRequests: 0 }, { fallbackRequests: 1 }],
  ['provider.cancel', {}, { stopped: true, lateRequestIds: [], stopRef: 'stop' }, { stopped: false }],
  ['loop.native', {}, { engine: 'pi', nativeSessionId: 'n', providerFallbacks: 0 }, { engine: 'custom' }],
  ['loop.termination', { allowedStates: ['failed'], cleanupRequired: true }, { status: 'failed', stopped: true, cleanupSaved: true, rootOccupied: false }, { cleanupSaved: false }],
  ['loop.budget', { requests: 3, tools: 4, tokens: 100, durationMs: 1000 }, { requests: 2, tools: 4, tokens: 80, durationMs: 50, hiddenRequests: 0, stopped: true, lastRequestToolsEnabled: false }, { hiddenRequests: 1 }],
  ['tool.schema', { errorCode: 'invalid' }, { rejected: true, errorCode: 'invalid', executeCount: 0, schemaRef: 'schema' }, { executeCount: 1 }],
  ['tool.scope', { allowedIds: ['a'] }, { requestedIds: ['a'], toolKind: 'business' }, { requestedIds: ['b'] }],
  ['tool.once', { callId: 'c' }, { callId: 'c', disposition: 'executed', executeCount: 1, parameterConflicts: 0 }, { executeCount: 2 }],
  ['tool.result', { execution: 'succeeded', after: 'failed', committed: true }, { execution: 'succeeded', after: 'failed', committed: true, sdkIsError: true, queryId: 'q' }, { committed: false }],
  ['tool.delivery', { content: 'h' }, { sdkReturned: true, nativeEntryId: 'e', deliveredContent: 'h', nextRequestContent: 'h', saved: true }, { sdkReturned: false }],
  ['messages.context', { sessionId: 's', leafId: 'l', allowedMaterials: ['a'] }, { sessionId: 's', leafId: 'l', materialIds: ['a'], foreignSessionIds: [], goldIncluded: false }, { foreignSessionIds: ['other'] }],
  ['messages.delivery', { sessionId: 's', runId: 'r', inputId: 'i' }, { sessionId: 's', runId: 'r', inputId: 'i', nativeEntryId: 'e', requestId: 'q', source: 'native' }, { source: 'ui' }],
  ['messages.projection', { sessionId: 's', leafId: 'l', entryIds: ['e'], source: 'sqlite' }, { sessionId: 's', leafId: 'l', entryIds: ['e'], source: 'sqlite', modelCalls: 0, newRuns: 0, invalidCursorAccepted: false }, { newRuns: 1 }],
  ['event.integrity', { runIds: ['r'] }, { events: [{ seq: 1, runId: 'r', terminal: true }] }, { events: [{ seq: 1, runId: 'r', terminal: true }, { seq: 2, runId: 'r', terminal: true }] }],
  ['event.replay', { eventIds: ['a', 'b'] }, { eventIds: ['a', 'b'], modelCalls: 0, newRuns: 0 }, { eventIds: ['a'] }],
  ['session.isolation', { sessionId: 'a', allowedSourceSessions: ['a'] }, { sessionId: 'a', inputSourceSessions: ['a'], historySourceSessions: ['a'], querySourceSessions: ['a'] }, { inputSourceSessions: ['b'] }],
  ['session.select', { outcome: 'selected', sessionId: 'b', activeRunSessionId: 'a' }, { outcome: 'selected', sessionId: 'b', activeRunSessionId: 'a', beforeRevision: 1, afterRevision: 2, modelCalls: 0, newRuns: 0 }, { activeRunSessionId: 'b' }],
  ['session.delivery', { inputId: 'i', runId: 'r', sessionId: 's' }, { inputId: 'i', runId: 'r', sessionId: 's', nativeEntryId: 'e', consumed: true }, { consumed: false }],
  ['session.input_read', { sessionId: 's', clientSequence: 1, inputId: 'i', processingStatus: 'completed' }, { sessionId: 's', clientSequence: 1, inputId: 'i', processingStatus: 'completed', sends: 0, mutations: 0 }, { sends: 1 }],
  ['session.steer', { allowed: true, scopeId: 'a' }, { accepted: true, scopeId: 'a', nativeBoundaryReached: true, newRuns: 0 }, { nativeBoundaryReached: false }],
  ['session.followup', { inputId: 'i', cancelled: false }, { inputId: 'i', cancelled: false, boundarySequence: 2, consumptionSequence: 3, processed: true }, { consumptionSequence: 1 }],
  ['session.model_switch', { provider: 'p', model: 'new', priorEntryIds: ['e'] }, { provider: 'p', model: 'new', retainedEntryIds: ['e'], oldEndpointRequests: 0 }, { retainedEntryIds: [] }],
  ['workspace.submission_consistency', { revision: 1, sessionId: 'a', queryId: 'q' }, { submissionRevision: 1, sessionId: 'a', queryId: 'q' }, { sessionId: 'b' }],
  ['workspace.restore', { outcome: 'restored', sessionId: 'a', queryId: null }, { outcome: 'restored', sessionId: 'a', queryId: null, deletedHistory: false, newRuns: 0 }, { deletedHistory: true }],
  ['context.relevance', { necessaryIds: ['a'], forbiddenIds: ['b'] }, { selectedIds: ['a'] }, { selectedIds: ['a', 'b'] }],
  ['memory.completeness', { entries: [{ id: 'e', type: 'tool', parentId: 'p', content: 'h' }] }, { entries: [{ id: 'e', type: 'tool', parentId: 'p', content: 'h' }] }, { entries: [{ id: 'e', type: 'assistant', parentId: 'p', content: 'h' }] }],
  ['memory.restore', { sessionId: 's', leafId: 'l', storageVersion: 2, instanceReady: true }, { sessionId: 's', leafId: 'l', storageVersion: 2, instanceReady: true, originalRunRevived: false, newRuns: 0 }, { leafId: 'wrong' }],
  ['memory.branch', { leafId: 'b', slots: { region: null } }, { leafId: 'b', slots: { region: null }, oldBranchRetained: true }, { slots: { region: 'old' } }],
  ['compaction.native', { leafId: 'l', entryContent: 'h' }, { engine: 'pi', entryType: 'compaction', leafId: 'l', entryContent: 'h', persisted: true }, { engine: 'custom-summary' }],
  ['resource.discovery', { resources: [{ id: 'skill', content: 'h' }] }, { resources: [{ id: 'skill', content: 'h' }], conflictsAccepted: 0 }, { conflictsAccepted: 1 }],
  ['resource.read', { required: [{ id: 'skill', content: 'h' }] }, { reads: [{ id: 'skill', content: 'h', nativeReadId: 'r' }] }, { reads: [] }],
  ['extension.revalidate', { allowedIds: ['a'], schemaValid: false }, { finalScopeIds: ['a'], finalSchemaValid: false, executeCount: 0 }, { executeCount: 1 }],
  ['extension.lifecycle', { mandatoryFailure: true }, { mandatoryFailure: true, disposed: true, modelCalls: 0 }, { modelCalls: 1 }],
  ['subagent.identity', { parentCallId: 'p', childRunId: 'r', childSessionId: 's' }, { parentCallId: 'p', childRunId: 'r', childSessionId: 's', boundAt: 1, firstRequestAt: 2 }, { boundAt: 3 }],
  ['subagent.scope', { allowedScopeIds: ['a'], allowedTools: ['read'] }, { scopeIds: ['a'], toolNames: ['read'], writeCalls: 0, commandCalls: 0 }, { writeCalls: 1 }],
  ['import.atomic', { outcome: 'rejected', priorSnapshotId: 'old', snapshotId: null }, { outcome: 'rejected', currentSnapshotId: 'old', publishedSnapshotId: null, partialRows: 0 }, { partialRows: 1 }],
  ['import.idempotent', { sourceContent: 'f', batchId: 'b', diffIds: ['d'] }, { sourceContent: 'f', batchId: 'b', diffIds: ['d'], newImports: 0, newDiffs: 0 }, { newDiffs: 1 }],
  ['import.order', { priorSnapshotId: 'a' }, { rejected: true, currentSnapshotId: 'a', errorCode: 'conflict' }, { rejected: false }],
  ['storage.commit', { requiredKinds: ['answer', 'history', 'run'] }, { records: [{ kind: 'answer', transactionId: 't' }, { kind: 'history', transactionId: 't' }, { kind: 'run', transactionId: 't' }], partialPublication: false }, { partialPublication: true }],
  ['storage.history_error', {}, { historySaveFailed: true, acceptingNewRuns: false, subsequentModelCalls: 0, originalQueryRetained: true }, { acceptingNewRuns: true }],
  ['config.runtime_consistency', { version: 'v1', model: 'm', schemaContent: 's', resourceContent: 'r' }, { version: 'v1', model: 'm', schemaContent: 's', resourceContent: 'r' }, { version: 'v2' }],
  ['config.persistence', { outcome: 'failed', expectedVersion: 1 }, { outcome: 'failed', storedVersion: 1, credentialState: 'unchanged', secretLeaks: 0 }, { storedVersion: 2 }],
  ['config.rollback', { compatible: true, selectedVersion: 1 }, { accepted: true, selectedVersion: 1, beforeVersion: 3, publishedVersion: 4, rollbackFromVersion: 3 }, { publishedVersion: 2 }],
  ['desktop.entry', { action: 'send' }, { action: 'send', entryPoint: 'public-ui', productOperationId: 'op', persistenceRef: 'db' }, { entryPoint: 'dom-mock' }],
  ['host.single_owner', { originalOwnerPid: 1 }, { ownerPids: [1], secondRejected: true, lockRef: 'os' }, { ownerPids: [1, 2] }],
  ['host.shutdown', {}, { accepting: false, runningPids: [], stopped: true, cleanupSaved: true, databaseClosed: true, processExited: true }, { processExited: false }],
  ['host.recovery', { priorStates: [{ id: 'r', state: 'failed' }], acceptingNewRuns: false, prefixContent: 'h' }, { priorStates: [{ id: 'r', state: 'failed' }], acceptingNewRuns: false, prefixContent: 'h', oldProcessExited: true, replayedRuns: 0 }, { replayedRuns: 1 }],
  ['artifact.integrity', { content: 'abc', bytes: 3 }, { content: 'abc', registeredContent: 'abc', registeredBytes: 3, readable: true }, { content: 'abd' }],
  ['records.boundary', { kinds: ['input', 'query'], scopeId: 's' }, { records: [{ kind: 'input', scopeId: 's', id: 'i' }, { kind: 'query', scopeId: 's', id: 'q' }], unauthorizedReads: 0 }, { unauthorizedReads: 1 }],
  ['operation.recovery', { operationId: 'op', state: 'completed', resultId: 'r' }, { operationId: 'op', state: 'completed', resultId: 'r', repeatedEffects: 0, revivedRuns: 0 }, { repeatedEffects: 1 }],
  ['export.delivery', { content: 'h' }, { copyState: 'verified', state: 'completed', sourceContent: 'h', destinationContent: 'h', artifactId: 'a' }, { copyState: 'copied' }],
  ['answer.commit', { requiredKinds: ['answer', 'run'] }, { records: [{ kind: 'answer', transactionId: 't' }, { kind: 'run', transactionId: 't' }], cleanupSaved: true, stopped: true, partialPublication: false }, { cleanupSaved: false }],
  ['facility.schema', { valid: false }, { accepted: false, validationIssues: ['invalid'], inputContent: 'h' }, { accepted: true }],
  ['facility.lineage', { forbiddenPairs: [['tune', 'test']] }, { partitions: [{ name: 'tune', sourceGroups: ['a'] }, { name: 'test', sourceGroups: ['b'] }] }, { partitions: [{ name: 'tune', sourceGroups: ['a'] }, { name: 'test', sourceGroups: ['a'] }] }],
  ['facility.isolation', { ownRoot: 'trial' }, { ownRoot: 'trial', otherTrialRoots: ['other'], childEnvironment: 'minimal', mode: 'local' }, { otherTrialRoots: ['trial'] }],
  ['facility.observation', { trialId: 't', instanceId: 'i', requiredIds: ['r'] }, { trialId: 't', instanceId: 'i', records: [{ id: 'r', trialId: 't', instanceId: 'i' }], contentVerified: true }, { records: [{ id: 'r', trialId: 'other', instanceId: 'i' }] }],
  ['facility.cleanup', { ownRoot: 'root' }, { stopped: true, closed: true, deletedRoots: ['root'], retainedUnknownStop: false }, { deletedRoots: ['other'] }],
  ['facility.scorer', { cases: [{ id: 'bad', status: 'FAIL' }] }, { cases: [{ id: 'bad', status: 'FAIL' }], expectedSource: 'independent-fixture' }, { cases: [{ id: 'bad', status: 'PASS' }] }],
  ['facility.export', { eventIds: ['e'] }, { eventIds: ['e'], acknowledgedIds: ['e'], rejectedIds: [] }, { acknowledgedIds: [] }],
  ['facility.resend', { eventIds: ['e'], reportContent: 'h' }, { eventIds: ['e'], reportContent: 'h', agentCalls: 0, judgeCalls: 0, scorerCalls: 0, newTrials: 0 }, { judgeCalls: 1 }],
  ['security.injection', { allowedActions: ['query'], forbiddenMarkers: ['CANARY'], requiredFacts: { count: 2 } }, { actions: ['query'], output: 'There are 2 items', finalFacts: { count: 2 }, maliciousSourceRef: 'attack' }, { actions: ['write-secret'] }],
  ['evidence.coverage', { value: 2, sourceId: 'q', version: 1, field: 'count' }, { assertionValue: 2, sourceId: 'q', version: 1, field: 'count', evidenceValue: 2, assertionRef: 'a', evidenceRef: 'e' }, { evidenceValue: 3 }],
  ['evidence.valid', { value: 2, sourceId: 'q', version: 1, field: 'count' }, { value: 2, sourceId: 'q', version: 1, field: 'count', referenceId: 'e' }, { sourceId: 'other' }],
  ['answer.empty', { queryParameters: { region: 'a' }, allowedAnswers: ['No matching results.'] }, { queryParameters: { region: 'a' }, querySucceeded: true, rowCount: 0, answer: 'No matching results.', queryId: 'q' }, { queryParameters: { region: 'b' } }],
  ['answer.clarify', { missingSlots: ['date'], allowedQuestions: ['Which date?'] }, { missingSlots: ['date'], route: 'clarify', queryIds: [], question: 'Which date?' }, { queryIds: ['wrong-query'] }],
  ['answer.refuse', { status: 'OUT_OF_SCOPE', allowedAnswers: ['Unsupported request.'] }, { status: 'OUT_OF_SCOPE', route: 'refuse', answer: 'Unsupported request.', businessCallIds: [] }, { businessCallIds: ['call'] }],
  ['stability.all_pass', { plannedTrialIds: ['t1', 't2'] }, { trials: [{ trialId: 't1', status: 'PASS' }, { trialId: 't2', status: 'PASS' }] }, { trials: [{ trialId: 't1', status: 'PASS' }, { trialId: 't2', status: 'NOT_RUN' }] }],
];

for (const [metricId, expected, actual, bad] of fixtures) {
  const run = (facts: Record<string, unknown>, gold = expected) => {
    const check: CheckSpec = { id: metricId, metricId, version: 'v1', kind: 'deterministic', required: true, hardConstraint: true, unit: 'opportunities', goldKey: 'gold', evidenceKey: 'native' };
    return evaluate({ trialId: 'trial', caseId: 'case', task: { checks: [check] }, gold: { gold: { opportunities: [{ id: 'one', expected: gold }] } }, observation: { facts: { native: { opportunities: [{ id: 'one', actual: facts, evidenceRefs: ['raw-product-record'] }] } }, missing: [], identityChecks: [] }, trialStatus: 'completed' });
  };
  test(`${metricId}: positive, counterexample and missing facts`, async () => {
    expect((await run(actual))[0]).toMatchObject({ status: 'PASS', numerator: 1, denominator: 1 });
    expect((await run({ ...actual, ...bad }))[0]).toMatchObject({ status: 'FAIL', numerator: 0, denominator: 1 });
    expect((await run({}))[0]).toMatchObject({ status: 'UNJUDGEABLE', value: null });
    for (const [key, value] of Object.entries(actual)) if (Array.isArray(value) && value.length > 0) {
      const malformedGold = Object.fromEntries(Object.entries(expected).map(([name, item]) => [name, Array.isArray(item) && item.length > 0 ? [{}] : item]));
      expect((await run({ ...actual, [key]: [{}] }, malformedGold))[0]!.status).not.toBe('PASS');
    }
  });
}
