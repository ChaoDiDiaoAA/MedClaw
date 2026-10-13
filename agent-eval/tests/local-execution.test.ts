import { expect, test } from 'bun:test';
import { RunConfigSchema } from '../src/types.ts';
import { loadDataset } from '../src/datasets.ts';
import { runBlockers } from '../src/doctor.ts';
import { parsePreset } from '../src/presets.ts';
import { runConfigFixture } from './report-fixture.ts';

test('local configuration needs no manual readiness, source inventory or OS sandbox declaration', async () => {
  const input = runConfigFixture() as Record<string, unknown>;
  delete input.productReadiness; delete input.isolation; delete input.sourceLock;
  expect(RunConfigSchema.safeParse(input).success).toBe(true);
  const dataset = await loadDataset('medclaw-agent-v1');
  expect(runBlockers(dataset, { sdk: '0.87.1', patch: 'installed exact patch' }, undefined, { required: true, configured: true })).toEqual([]);
  expect(runBlockers(dataset, { sdk: 'wrong', patch: 'missing' }, undefined, { required: true, configured: false })).toEqual([
    'sdk_version_mismatch', 'declared_subagent_patch_missing', 'independent_judge_unconfigured',
  ]);
});

test('first Full has no previous-run option or approval prerequisite', () => {
  expect(parsePreset(['full', '--check'])).toEqual({ mode: 'full', check: true });
  expect(() => parsePreset(['full', '--freeze', 'unused'])).toThrow('unknown_option');
});
