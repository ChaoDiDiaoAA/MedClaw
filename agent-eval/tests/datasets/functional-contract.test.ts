import { test, expect } from 'bun:test';
import { EvalCaseSchema, GoldDefinitionSchema } from '../../src/evaluation.ts';
import { cases } from '../../src/datasets/medclaw-agent-v1.ts';
import {loadDataset,loadSnapshot,snapshotCompiled} from '../../src/datasets.ts';

test('budgets and evidence are explicit, zero is valid, and unsafe budgets are rejected', () => {
  const item = structuredClone(cases[0]!);
  for (const key of ['maxToolCalls', 'mustHaveEvidence'] as const) {
    const missing = structuredClone(item); delete (missing.expected as any)[key];
    expect(EvalCaseSchema.safeParse(missing).success).toBe(false);
  }
  for (const maxToolCalls of [0, 1, Number.MAX_SAFE_INTEGER]) expect(EvalCaseSchema.safeParse({...item, expected:{...item.expected,maxToolCalls}}).success).toBe(true);
  for (const maxToolCalls of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(EvalCaseSchema.safeParse({...item,expected:{...item.expected,maxToolCalls}}).success).toBe(false);
  expect(EvalCaseSchema.safeParse({...item,expected:{...item.expected,requiredCapabilities:['invented-tool']}}).success).toBe(false);
  expect(EvalCaseSchema.safeParse({...item,expected:{...item.expected,requiredCapabilities:['write']}}).success).toBe(false);
});

test('functional constraints are consumed, bounded by the fixture, and archived without recompilation',async()=>{
  const dataset=await loadDataset(),original=structuredClone(dataset.snapshot);
  original.review.state='pending';
  const resource=original.cases.find(item=>item.id==='mc-v1-resource-progressive-read')!;
  const expectation=original.gold[resource.id]!.scorerExpectations!['resource.progressive_read']!;
  expectation.maxBytes=64;
  expect(loadSnapshot(original).gold[resource.id]!.values.resource_progressive_read).toMatchObject({maxBytes:64});
  const invalid=structuredClone(original);invalid.gold[resource.id]!.scorerExpectations!['tool.failure_handling']={maxRetries:1};
  expect(()=>loadSnapshot(invalid)).toThrow('unused_scorer_expectation');
  const scoped=structuredClone(original),scopeCase=scoped.cases.find(item=>item.input.fixture.ref==='zj-only')!;
  scopeCase.scorers.push('security.scope');scoped.gold[scopeCase.id]!.scorerExpectations={...scoped.gold[scopeCase.id]!.scorerExpectations,'security.scope':{regions:['河南']}};
  expect(()=>loadSnapshot(scoped)).toThrow('scope_expectation_widens_fixture');
  const recorded=snapshotCompiled(dataset);recorded[resource.id]!.values.resource_progressive_read={requiredRefs:['archived/material.md'],maxBytes:16};
  expect(loadSnapshot(original,'no-filesystem',recorded).gold[resource.id]!.values.resource_progressive_read).toEqual({requiredRefs:['archived/material.md'],maxBytes:16});
});

test('scorer expectations reject unknown or misspelled fields instead of silently dropping them', () => {
  expect(GoldDefinitionSchema.safeParse({scorerExpectations:{'tool.failure_handling':{maxRetries:1}}}).success).toBe(true);
  expect(GoldDefinitionSchema.safeParse({scorerExpectations:{'tool.failure_handling':{maxRetry:1}}}).success).toBe(false);
  expect(GoldDefinitionSchema.safeParse({scorerExpectations:{'tool.unknown':{enabled:true}}}).success).toBe(false);
});
