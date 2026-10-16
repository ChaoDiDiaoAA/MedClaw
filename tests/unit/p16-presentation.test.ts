import { expect, test } from 'bun:test';
import { reportFixture } from '../../agent-eval/tests/report-fixture';

for (const section of ['cases', 'trials'] as const) test(section + ' report filters narrow the original items without changing Scores or totals', async () => {
  const { projectReportSection } = await import('../../agent-eval/src/desktop/presentation');
  const report = reportFixture(), before = JSON.stringify(report), original = report.plan[0]!;
  const all = projectReportSection(report, { executionId: report.executionId, section });
  expect(all).toMatchObject({ total: 1 });
  expect(projectReportSection(report, { executionId: report.executionId, section, caseId: 'missing-case' })).toMatchObject({ total: 0, items: [] });
  expect(projectReportSection(report, { executionId: report.executionId, section, caseId: original.caseId })).toMatchObject({ total: 1 });
  if (section === 'trials') {
    expect(projectReportSection(report, { executionId: report.executionId, section, trialId: 'missing-trial' })).toMatchObject({ total: 0, items: [] });
    expect(projectReportSection(report, { executionId: report.executionId, section, trialId: original.trialId })).toMatchObject({ total: 1 });
  }
  expect(JSON.stringify(report)).toBe(before);
});

test('value summaries redact nested secrets and known credentials without changing originals', async () => {
  const { summarizeValue } = await import('../../agent-eval/src/desktop/presentation');
  const input = { answer: 'ok', nested: { Authorization: 'Bearer exposed', apiKey: 'key-value', ordinary: 'contains private-known-key' }, gold: { steps: 'private-gold' } };
  const before = structuredClone(input), summary = summarizeValue(input, ['private-known-key']);
  expect(summary).toMatchObject({ type: 'object', total: 3, redacted: true });
  expect(summary.text).toContain('ok');
  for (const secret of ['exposed', 'key-value', 'private-known-key', 'private-gold']) expect(summary.text).not.toContain(secret);
  expect(input).toEqual(before);
});

test('expected summaries hide private Gold canaries while preserving public expected values', async () => {
  const { summarizeValue } = await import('../../agent-eval/src/desktop/presentation');
  const input = { count: 3, canaries: ['PRIVATE_GOLD_CANARY'], nested: { canary: 'PRIVATE_NESTED_CANARY' } };
  const result = summarizeValue(input);
  expect(result.text).toContain('3'); expect(result.redacted).toBe(true);
  expect(result.text.includes('PRIVATE_GOLD_CANARY')).toBe(false);
  expect(result.text.includes('PRIVATE_NESTED_CANARY')).toBe(false);
  expect(input.canaries).toEqual(['PRIVATE_GOLD_CANARY']);
});

test('value summaries enforce total text, depth and child bounds and label truncation', async () => {
  const { summarizeValue } = await import('../../agent-eval/src/desktop/presentation');
  const summary = summarizeValue(Array.from({ length: 30 }, () => '长'.repeat(4000)));
  expect(summary.text.length).toBeLessThanOrEqual(32768);
  expect(summary).toMatchObject({ type: 'array', total: 30, truncated: true });
  const deep = summarizeValue({ a: { b: { c: { d: { e: 'hidden-at-depth-five' } } } } });
  expect(deep.truncated).toBe(true);
  expect(deep.text).not.toContain('hidden-at-depth-five');
});

test('report score projection preserves recorded identities, values and denominators without private snapshot', async () => {
  const { projectReportSection } = await import('../../agent-eval/src/desktop/presentation');
  const report = reportFixture(), original = JSON.stringify(report);
  const page = projectReportSection(report, { executionId: report.executionId, section: 'scores', page: 1, pageSize: 1 });
  expect(page).toMatchObject({ executionId: report.executionId, section: 'scores', page: 1, pageSize: 1, total: report.scores.length });
  expect('items' in page && page.items[0]).toMatchObject({ checkId: report.scores[0]!.checkId, denominator: report.scores[0]!.denominator, status: 'NOT_RUN' });
  expect(JSON.stringify(page)).not.toContain('packageJson');
  expect(JSON.stringify(report)).toBe(original);
});

test('historical coverage and analysis are derived in memory while source metadata remains visible', async () => {
  const { projectReportSection, summarizeValue } = await import('../../agent-eval/src/desktop/presentation');
  const report = reportFixture(), before = JSON.stringify(report);
  const coverage = projectReportSection(report, { executionId: report.executionId, section: 'coverage', page: 1, pageSize: 50 });
  expect(coverage).toMatchObject({ section: 'coverage', total: 39 });
  const summary = projectReportSection(report, { executionId: report.executionId, section: 'summary' });
  expect('summary' in summary && summary.summary.analysis).not.toBeNull();
  const cases = projectReportSection(report, { executionId: report.executionId, section: 'cases' });
  expect('items' in cases && cases.items[0]).toMatchObject({ status: 'NOT_RUN' });
  expect(JSON.stringify(cases)).toContain('passAtK'); expect(JSON.stringify(cases)).toContain('variance');
  const source = summarizeValue({ sourceId: 'source-one', sourceTitle: 'Original source', sourceCode: 'private-source-code' });
  expect(source.text).toContain('source-one'); expect(source.text).not.toContain('private-source-code');
  expect(JSON.stringify(report)).toBe(before); expect(report.analysis).toBeUndefined();
});

test('long failure text stays bounded and redacted in progress, Trial and Score DTOs', async () => {
  const { projectProgress, projectTrial, projectReportSection } = await import('../../agent-eval/src/desktop/presentation');
  const reason = 'Transport private-known-key ' + 'long error '.repeat(1000), report = reportFixture();
  report.scores[0]!.reason = reason;
  const progress = projectProgress({ ...report.plan[0]!, index: 1, total: 1, kind: 'execution', phase: 'execute', elapsedMs: 1, reason }, ['private-known-key']);
  const trial = projectTrial({ ...report.trials[0]!, reason }, ['private-known-key']);
  const page = projectReportSection(report, { executionId: report.executionId, section: 'scores', page: 1, pageSize: 1 }, ['private-known-key']);
  if (page.section !== 'scores') throw new Error('Wrong report section');
  for (const text of [progress.reason!, trial.reason!, page.items[0]!.reason]) {
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain('[Truncated]');
    expect(text.includes('private-known-key')).toBe(false);
  }
  expect(report.scores[0]!.reason).toBe(reason);
});
