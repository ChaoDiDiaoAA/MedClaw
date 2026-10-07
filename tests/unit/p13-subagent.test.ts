import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStage } from '../run';

test('p13 runner rejects empty execution, required skips and discovery errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p13-runner-'));
  const directory = join(root, 'tests', 'unit');
  mkdirSync(directory, { recursive: true });
  try {
    expect(await runStage('unit', 'P13', { root })).toMatchObject({ executed: 0, exitCode: 1 });
    const file = join(directory, 'p13-probe.test.ts');
    writeFileSync(file, "import { test } from 'bun:test'; test.skip('required', () => {});");
    expect(await runStage('unit', 'P13', { root })).toMatchObject({ executed: 0, skip: 1, exitCode: 1 });
    writeFileSync(file, "import { test } from 'bun:test'; test('executed', () => {}); test.skip('required', () => {});");
    expect(await runStage('unit', 'P13', { root })).toMatchObject({ executed: 1, skip: 1, exitCode: 1 });
    writeFileSync(file, "throw new Error('ENGINEERING discovery failure');");
    expect((await runStage('unit', 'P13', { root })).exitCode).toBe(1);
    writeFileSync(file, "import { test } from 'bun:test'; test('executed', () => {});");
    expect(await runStage('unit', 'P13', { root })).toMatchObject({ discovered: 1, executed: 1, pass: 1, skip: 0, exitCode: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
