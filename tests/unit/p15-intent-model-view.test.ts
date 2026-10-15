import { expect, test } from 'bun:test';
import { IntentStageInputSchema } from '../../packages/contracts/src/intent';
import { INTENT_VERSIONS } from '../../packages/contracts/src/model';
import { CONTEXT_MATERIAL_PREFIX, renderIntentContext, readIntentContext } from '../../packages/contracts/src/context';
import { intentInput, resolvedIntent } from '../fixtures/p14-intent';

const current = () => IntentStageInputSchema.parse({ input: { ...intentInput(), text: '比较示例区域两个日期的记录总数，不限状态',
  versions: { ...intentInput().versions, ...INTENT_VERSIONS } }, stage: 'classify', review: null });

test('p15 model receives one business input while its complete audit stage verifies the saved projection', () => {
  const stage = current(), rendered = renderIntentContext(stage);
  const view = JSON.parse(rendered.slice(CONTEXT_MATERIAL_PREFIX.length));
  expect(view.contract).toBe('medclaw.intent-model-view/v1');
  expect(view.input).toEqual(stage.input);
  expect(rendered.split(JSON.stringify(stage.input.text))).toHaveLength(2);
  expect(readIntentContext(rendered, stage)).toEqual(stage);
  expect(() => readIntentContext(rendered)).toThrow('storage_read_failed');
  const forged = structuredClone(stage); forged.input.text = '另一个任务';
  expect(() => readIntentContext(rendered, forged)).toThrow('storage_read_failed');
});

test('p15 semantic review exposes its parsed prediction once and retains raw output only in the audit source', () => {
  const first = current(), prediction = resolvedIntent();
  const stage = IntentStageInputSchema.parse({ ...first, stage: 'verify', review: { mode: 'semantic_correction',
    previousCallId: 'first-call', prediction, rawPreview: 'UNIQUE_RAW_OUTPUT_MARKER',
    issues: [{ code: 'explicit_condition_conflict', intentId: 's1', slot: 'l2', severity: 'invalid',
      message: '原文明确要求两日期比较', candidates: [], sourceSpan: { start: 0, end: 2 } }], candidates: [] } });
  const rendered = renderIntentContext(stage), view = JSON.parse(rendered.slice(CONTEXT_MATERIAL_PREFIX.length));
  expect(view.review).toEqual({ mode: 'semantic_correction', prediction, issues: stage.review!.issues, candidates: [] });
  expect(rendered).not.toContain('UNIQUE_RAW_OUTPUT_MARKER');
  expect(rendered).not.toContain('rawPreview'); expect(rendered).not.toContain('previousCallId');
  expect(readIntentContext(rendered, stage).review?.rawPreview).toBe('UNIQUE_RAW_OUTPUT_MARKER');
});

test('p15 legacy v4 projection remains self-readable after the new model view is enabled', () => {
  const stage = current(); stage.input.versions = { ...stage.input.versions,
    classifyPromptVersion: 'medclaw.intent-classify-prompt/v2', verifyPromptVersion: 'medclaw.intent-verify-prompt/v3', policyVersion: 'medclaw.intent-policy/v4' };
  const rendered = renderIntentContext(stage);
  expect(rendered).toContain('Frozen IntentStageInput:');
  expect(readIntentContext(rendered)).toEqual(stage);
});
