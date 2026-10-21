import { describe, expect, test } from 'bun:test';
import { NativeInputReceiptSchema, ResourceInputPlanSchema } from '../../packages/contracts/src/resources';

const template = { kind: 'subagent_template', resourceRef: null,
  dispatchText: '/medclaw-evidence-review Check the supplied source.',
  source: { templateName: 'medclaw-evidence-review', file: 'subagent-prompts/medclaw-evidence-review.md',
    content: 'Review the supplied source with a read-only Agent. $ARGUMENTS' } };
const command = { kind: 'subagent_command', resourceRef: null,
  dispatchText: '/subagent general-analyst Compare the supplied findings.',
  source: { name: 'subagent', roleId: 'general-analyst', task: 'Compare the supplied findings.' } };

describe('P13 explicit delegation input contracts', () => {
  test('accepts an immutable delegation source plan without relabelling it as a business Prompt', () => {
    expect(ResourceInputPlanSchema.safeParse(template).success).toBe(true);
    expect(ResourceInputPlanSchema.safeParse(command).success).toBe(true);
    expect(ResourceInputPlanSchema.safeParse({ ...template, resourceRef: { kind: 'prompt', id: 'query', version: 'v1' } }).success).toBe(false);
    expect(ResourceInputPlanSchema.safeParse({ ...command, source: template.source }).success).toBe(false);
    expect(ResourceInputPlanSchema.safeParse({ kind: 'plain', resourceRef: { kind: 'skill', id: 'query', version: 'v1' }, dispatchText: 'question' }).success).toBe(false);
    expect(ResourceInputPlanSchema.safeParse({ ...template, expandedText: 'Do not mutate the accepted plan.' }).success).toBe(false);
  });

  test('records template expansion only as the actual consumed text', () => {
    const text = 'Review the supplied source with a read-only Agent. Check the supplied source.';
    const subagentReceipt = { kind: 'template', templateName: 'medclaw-evidence-review', expandedText: text };
    expect(NativeInputReceiptSchema.safeParse({ text, subagentReceipt }).success).toBe(true);
    expect(NativeInputReceiptSchema.safeParse({ text: 'Different text', subagentReceipt }).success).toBe(false);
  });

  test('keeps the registered command owner and original input on its consumed receipt', () => {
    const text = 'Delegate the supplied comparison to general-analyst using Agent.';
    const subagentReceipt = { kind: 'command', name: 'subagent', roleId: 'general-analyst', task: command.source.task,
      operationRef: 'original-submit', inputId: 7,
      owner: { instanceId: 'original-host', sessionId: 2, runId: 3, assemblyId: 'original-subagent-assembly' }, dispatchText: text };
    expect(NativeInputReceiptSchema.safeParse({ text, subagentReceipt }).success).toBe(true);
    expect(NativeInputReceiptSchema.safeParse({ text: 'A second unrelated message', subagentReceipt }).success).toBe(false);
    expect(NativeInputReceiptSchema.safeParse({ text, subagentReceipt: { ...subagentReceipt, inputId: null } }).success).toBe(false);
  });
});
