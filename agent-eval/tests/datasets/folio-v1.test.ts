import { test, expect } from 'bun:test';
import { loadDataset, projectInput } from '../../src/datasets.ts';

test('built-in cases resolve six authoring requirements without exposing Gold or future turns', async () => {
  const dataset = await loadDataset('medclaw-agent-v1');
  expect(dataset.cases).toHaveLength(50);
  expect(dataset.manifest.smoke).toHaveLength(10);
  expect(new Set(dataset.cases.map(item => item.category)).size).toBe(11);
  for (const item of dataset.cases) {
    expect(item.evalType === 'capability' || item.evalType === 'regression').toBe(true);
    expect(item.input.fixture.ref.length).toBeGreaterThan(0);
    expect(item.expected.forbiddenConditions.length).toBeGreaterThan(0);
    expect(item.scorers.length).toBeGreaterThan(0);
    expect(Array.isArray(item.risks)).toBe(true);
    expect(dataset.gold[item.id]).toBeDefined();
  }
  const item = dataset.cases.find(item => item.input.turns?.length)!;
  const projected = projectInput(dataset, item.id, 'turn-1');
  expect(projected.prompt).toBe(item.input.prompt);
  expect(JSON.stringify(projected)).not.toContain(item.input.turns![0]!.action.action === 'send' ? (item.input.turns![0]!.action as {prompt:string}).prompt : 'PRIVATE_GOLD_CANARY');
  expect(projected).not.toHaveProperty('expected');
  expect(projected).not.toHaveProperty('scorers');
});
