import { expect, test } from 'bun:test';
import { RuntimeLog } from '../../packages/logging/src/runtime-log';

test('startup diagnostics retain an allowlisted Host phase and code while discarding raw stderr', () => {
  const log = new RuntimeLog('main');
  log.addStderr('MedClaw Host terminated: database_open/host_start_failed.');
  expect(log.stderrTail()).toContain('database_open');
  expect(log.stderrTail()).toContain('host_start_failed');
  expect(log.read().some(entry => entry.message.includes('database_open'))).toBe(true);
  for (const line of [
    'MedClaw Host terminated: SECRET-CANARY/host_start_failed.',
    'MedClaw Host terminated: database_open/SECRET-CANARY.',
    'MedClaw Host terminated: database_open/host_start_failed. SECRET-CANARY',
    'SECRET-CANARY provider response',
  ]) log.addStderr(line);
  expect(JSON.stringify([log.read(), log.stderrTail()])).not.toContain('SECRET-CANARY');
});
