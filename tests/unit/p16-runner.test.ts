import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { discoverTests, runStage } from '../run';

test('P16 discovers four independent test categories without misclassifying integration files', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p16-discovery-'));
  try {
    for (const [directory, files] of [
      ['unit', ['p16-contracts.test.ts', 'p1.test.ts']],
      ['integration', ['p16-service.test.ts', 'p16-evaluation-host.test.ts', 'p15-host.test.ts']],
      ['e2e', ['p16-evaluation.spec.ts', 'p1.spec.ts']],
    ] as const) {
      mkdirSync(join(root, 'tests', directory), { recursive: true });
      for (const file of files) writeFileSync(join(root, 'tests', directory, file), '');
    }
    expect(discoverTests('unit', 'P16', root).map(file => basename(file))).toEqual(['p16-contracts.test.ts']);
    expect(discoverTests('integration', 'P16', root).map(file => basename(file))).toEqual(['p16-evaluation-host.test.ts', 'p16-service.test.ts']);
    expect(discoverTests('e2e', 'P16', root).map(file => basename(file))).toEqual(['p16-evaluation-host.test.ts']);
    expect(discoverTests('desktop', 'P16', root).map(file => basename(file))).toEqual(['p16-evaluation.spec.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P16 empty and mandatory skipped execution fail while actual execution saves its report', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p16-runner-'));
  try {
    expect(await runStage('unit', 'P16', { root })).toMatchObject({ executed: 0, reportComplete: false, exitCode: 1, reportErrors: ['no_tests_discovered'] });
    const directory = join(root, 'tests/unit');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'p16-probe.test.ts');
    writeFileSync(file, 'import {test,expect} from "bun:test"; test("ran",()=>expect(Bun.argv.includes("--stage")).toBe(false)); test.skip("required",()=>{});');
    expect(await runStage('unit', 'P16', { root })).toMatchObject({ executed: 1, skip: 1, exitCode: 1, reportErrors: ['test_coverage_incomplete'] });
    writeFileSync(file, 'import {test,expect} from "bun:test"; test("ran",()=>expect(Bun.argv.includes("--stage")).toBe(false));');
    const report = await runStage('unit', 'P16', { root });
    expect(report).toMatchObject({ discoveredFiles: 1, executed: 1, pass: 1, fail: 0, skip: 0, reportComplete: true, exitCode: 0 });
    expect(await Bun.file(join(report.reportDirectory!, 'result.json')).json()).toMatchObject({ executed: 1, reportComplete: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
