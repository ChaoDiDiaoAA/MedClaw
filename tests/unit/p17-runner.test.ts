import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { discoverTests, runStage } from '../run';

test('P17 discovers its four real test categories without taking P1 or P16 files', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-discovery-'));
  try {
    for (const [directory, files] of [
      ['unit', ['p17-contracts.test.ts', 'p1.test.ts', 'p16-runner.test.ts']],
      ['integration', ['p17-backup.test.ts', 'p17-host.test.ts', 'p16-evaluation-host.test.ts']],
      ['e2e', ['p17-install.spec.ts', 'p16-evaluation.spec.ts']],
    ] as const) {
      mkdirSync(join(root, 'tests', directory), { recursive: true });
      for (const file of files) writeFileSync(join(root, 'tests', directory, file), '');
    }
    expect(discoverTests('unit', 'P17', root).map(file => basename(file))).toEqual(['p17-contracts.test.ts']);
    expect(discoverTests('integration', 'P17', root).map(file => basename(file))).toEqual(['p17-backup.test.ts', 'p17-host.test.ts']);
    expect(discoverTests('e2e', 'P17', root).map(file => basename(file))).toEqual(['p17-host.test.ts']);
    expect(discoverTests('desktop', 'P17', root).map(file => basename(file))).toEqual(['p17-install.spec.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P17 refuses empty or skipped execution and retains a report for actual completed tests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-runner-'));
  try {
    expect(await runStage('unit', 'P17', { root })).toMatchObject({
      executed: 0, reportComplete: false, exitCode: 1, reportErrors: ['no_tests_discovered'],
    });
    const directory = join(root, 'tests/unit');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'p17-probe.test.ts');
    writeFileSync(file, 'import {test,expect} from "bun:test"; test("actual",()=>expect(Bun.argv.includes("--stage")).toBe(false)); test.skip("required",()=>{});');
    expect(await runStage('unit', 'P17', { root })).toMatchObject({
      executed: 1, skip: 1, exitCode: 1, reportErrors: ['test_coverage_incomplete'],
    });
    writeFileSync(file, 'import {test,expect} from "bun:test"; test("actual",()=>expect(Bun.argv.includes("--stage")).toBe(false));');
    const report = await runStage('unit', 'P17', { root });
    expect(report).toMatchObject({ discoveredFiles: 1, executed: 1, pass: 1, fail: 0, skip: 0,
      reportComplete: true, exitCode: 0 });
    expect(await Bun.file(join(report.reportDirectory!, 'result.json')).json()).toMatchObject({
      executed: 1, reportComplete: true, exitCode: 0,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
