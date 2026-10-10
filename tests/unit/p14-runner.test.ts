import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverTests, runStage } from '../run';

test('p14 runner discovers its stage and rejects empty or skipped mandatory execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p14-runner-'));
  const directory = join(root, 'tests/unit');
  mkdirSync(directory, { recursive: true });
  try {
    expect(await runStage('unit', 'P14', { root }).catch(() => null)).toMatchObject({ executed: 0, exitCode: 1 });
    const file = join(directory, 'p14-probe.test.ts');
    writeFileSync(file, "import {test} from 'bun:test'; test('executed',()=>{}); test.skip('required',()=>{});");
    expect(discoverTests('unit', 'P14', root)).toEqual([file]);
    expect(await runStage('unit', 'P14', { root })).toMatchObject({ executed: 1, skip: 1, exitCode: 1 });
    writeFileSync(file, "import {test} from 'bun:test'; test('executed',()=>{});");
    expect(await runStage('unit', 'P14', { root })).toMatchObject({ discovered: 1, executed: 1, pass: 1, fail: 0, skip: 0, exitCode: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
