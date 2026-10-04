import { expect, test } from 'bun:test';
import { acceptSubmissionDraft, newSessionDraft } from '../../apps/desktop/src/renderer/session-list';
import type { SubmitInput } from '../../packages/contracts/src/session';

test('confirmation resets only the original pending mode and preserves a newer edited message', () => {
  const model = { provider: 'fixture', modelId: 'first', expectedConfigVersion: '1' };
  const input: SubmitInput = { sessionId: 4, clientSequence: 8, text: 'Original correction', mode: 'steer', targetRunId: 12,
    expectedRevision: 2, expectedBatchIds: [], expectedQueryId: null, model, referenceDate: '2026-01-01', timezone: 'Asia/Shanghai' };
  const pending = { operationRef: 'original-operation', input };
  const draft = { ...newSessionDraft(model), text: input.text, mode: 'steer' as const, pending, confirmedFailure: true };
  expect(acceptSubmissionDraft(draft, pending)).toMatchObject({ text: '', mode: 'send', pending: null, model, confirmedFailure: false });
  expect(acceptSubmissionDraft({ ...draft, text: 'Newer unsent message' }, pending)).toMatchObject({ text: 'Newer unsent message', mode: 'send', pending: null });
  const newer = { ...draft, pending: { ...pending, operationRef: 'newer-operation' } };
  expect(acceptSubmissionDraft(newer, pending)).toBe(newer);
  const sameRefDifferentSequence = { ...draft, pending: { ...pending, input: { ...input, clientSequence: 9 } } };
  expect(acceptSubmissionDraft(sameRefDifferentSequence, pending)).toBe(sameRefDifferentSequence);
});
