import { expect, test } from 'bun:test';
import { errorMessage, safeError } from '../../packages/contracts/src/error';
import { parseHostStartupFailure } from '../../packages/logging/src/host-startup-failure';
import { EvaluationPathsSchema } from '../../packages/contracts/src/evaluation';
import { HostViewSchema } from '../../packages/contracts/src/model';
import { RunCleanupRecordSchema } from '../../packages/contracts/src/run';
import { DesktopMethodSchema, desktopMethodSchemas, HostHelloSchema, HOST_PROTOCOL_VERSION,
  PublicHostRequestSchema, isDesktopReadOnlyMethod } from '../../packages/contracts/src/protocol';

const operationRef = 'b62b7f30-187a-43af-9b75-868e506c2bed';
const at = '2026-10-16T00:00:00.000Z';

test('dependency startup diagnostics accept only fixed reasons and discard arbitrary stderr', () => {
  expect(parseHostStartupFailure('MedClaw Host terminated: native_dependencies/host_dependency_unavailable/dependency_rg_unavailable.'))
    .toMatchObject({ phase: 'native_dependencies', error: { code: 'host_dependency_unavailable', reason: 'dependency_rg_unavailable' } });
  for (const line of ['MedClaw Host terminated: native_dependencies/host_dependency_unavailable/private_path.',
    'MedClaw Host terminated: writer_lock/host_stop_unconfirmed/dependency_rg_unavailable.',
    'MedClaw Host terminated: native_dependencies/host_dependency_unavailable/dependency_rg_unavailable. secret']) expect(parseHostStartupFailure(line)).toBe(null);
});

test('dependency failures identify the missing prerequisite using fixed user text', () => {
  for (const [reason, label] of [['dependency_rg_unavailable', 'rg'], ['dependency_fd_unavailable', 'fd'], ['dependency_bash_unavailable', 'Git Bash'], ['dependency_powershell_unavailable', 'PowerShell']] as const) {
    const message = errorMessage(safeError('host_dependency_unavailable', new Error('PRIVATE native diagnostic'), { reason }));
    expect(message).toContain(label); expect(message).not.toContain('PRIVATE');
  }
});

test('maintenance methods are accepted by the desktop but rejected by the business Host', () => {
  for (const method of ['backup.select', 'backup.create', 'backup.restore', 'backup.read', 'maintenance.discardSelection', 'host.prepareRecovery', 'diagnostics.selectDestination', 'diagnostics.export', 'diagnostics.readExport']) {
    expect(DesktopMethodSchema.safeParse(method).success).toBe(true);
    expect(PublicHostRequestSchema.safeParse({ protocolVersion: HOST_PROTOCOL_VERSION, kind: 'request',
      requestId: 'r', instanceId: 'h', operationRef, method, payload: {} }).success).toBe(false);
  }
  expect(isDesktopReadOnlyMethod('backup.read')).toBe(true);
  expect(isDesktopReadOnlyMethod('backup.create')).toBe(false);
  expect(isDesktopReadOnlyMethod('host.prepareRecovery')).toBe(false);
  expect(isDesktopReadOnlyMethod('diagnostics.readExport')).toBe(true);
  expect(isDesktopReadOnlyMethod('diagnostics.export')).toBe(false);
});

test('backup authorization payloads reject arbitrary paths and require the right capabilities', () => {
  expect(DesktopMethodSchema.safeParse('backup.create').success).toBe(true);
  const create = desktopMethodSchemas[DesktopMethodSchema.parse('backup.create')].input;
  expect(create.safeParse({ destinationToken: 'destination-1' }).success).toBe(true);
  for (const input of [{}, { destinationToken: '' }, { destinationToken: 'destination-1', path: 'C:/private' },
    { destinationToken: 'destination-1', pid: 4 }]) expect(create.safeParse(input).success).toBe(false);
  const restore = desktopMethodSchemas[DesktopMethodSchema.parse('backup.restore')].input;
  expect(restore.safeParse({ sourceToken: 'source-1', targetRootToken: 'target-1' }).success).toBe(true);
  expect(restore.safeParse({ sourceToken: 'source-1' }).success).toBe(false);
  expect(restore.safeParse({ sourceToken: 'source-1', targetRootToken: 'target-1', sourceRoot: 'D:/data' }).success).toBe(false);
  const read = desktopMethodSchemas[DesktopMethodSchema.parse('backup.read')].input;
  expect(read.safeParse({ resultToken: 'result-1', kind: 'restore' }).success).toBe(true);
  expect(read.safeParse({ resultToken: 'result-1', kind: 'run' }).success).toBe(false);
});

test('completed restore receipts require their saved configuration version and fixed SDK', () => {
  expect(DesktopMethodSchema.safeParse('backup.restore').success).toBe(true);
  const output = desktopMethodSchemas[DesktopMethodSchema.parse('backup.restore')].output;
  const receipt = { operationRef, kind: 'restore', state: 'completed', appVersion: '0.1.0',
    schemaVersion: 16, sdkVersion: '0.87.1', restoredAt: at, configVersion: '24' };
  expect(output.safeParse(receipt).success).toBe(true);
  expect(output.safeParse({ ...receipt, configVersion: 'arbitrary-uuid' }).success).toBe(false);
  expect(output.safeParse({ ...receipt, sdkVersion: '0.87.2' }).success).toBe(false);
  expect(output.safeParse({ ...receipt, state: 'running' }).success).toBe(false);
  expect(output.safeParse({ ...receipt, credential: 'private' }).success).toBe(false);
});

test('Host status preserves old records while keeping unconfirmed shutdown explicitly unknown', () => {
  const host = { instanceId: 'h', state: 'stopping', canStart: false, sdkVersion: '0.87.1',
    schemaVersion: 16, error: null };
  expect(HostViewSchema.parse(host)).not.toHaveProperty('shutdown');
  const shutdown = { executionStopped: null, requiredPersistenceComplete: null, databaseClosed: null,
    processExited: true, processTreeStopped: null, error: null };
  expect(HostViewSchema.safeParse({ ...host, shutdown, canPrepareRecovery: false }).success).toBe(true);
  expect(HostViewSchema.safeParse({ ...host, shutdown: { ...shutdown, processTreeStopped: 'yes' } }).success).toBe(false);
});

test('run cleanup accepts an explicit owner-bound stop proof without inventing one for old rows', () => {
  const cleanup = { contract: 'medclaw.run-cleanup/v1', executionStarted: null, stopConfirmed: null,
    requiredPersistenceComplete: null, inputsSettled: null, resourcesReleased: null,
    unconfirmedItems: ['stop'], secondaryErrors: [], verifiedAt: null };
  expect(RunCleanupRecordSchema.parse(cleanup)).not.toHaveProperty('processTreeProof');
  const proof = { instanceId: 'old-instance', basis: 'windows_job_empty', observedAt: at };
  expect(RunCleanupRecordSchema.safeParse({ ...cleanup, processTreeProof: proof }).success).toBe(true);
  expect(RunCleanupRecordSchema.safeParse({ ...cleanup, processTreeProof: { ...proof, basis: 'pid_missing' } }).success).toBe(false);
  expect(RunCleanupRecordSchema.safeParse({ ...cleanup, processTreeProof: { ...proof, instanceId: '' } }).success).toBe(false);
});

test('the P17 handshake accepts trusted resource roots and rejects old or mismatched SDK frames', () => {
  const hello = { protocolVersion: 'medclaw.host/p17-v2', instanceId: 'h', startupToken: 'start-1',
    sdkVersion: '0.87.1', expectedSchemaVersion: 16, resourceRoot: 'C:/Program Files/MedClaw/resources',
    installManifestPath: 'C:/Program Files/MedClaw/install.json',
    paths: { dataRoot: 'C:/用户/Med Claw', databasePath: 'C:/用户/Med Claw/data/app.sqlite',
      settingsPath: 'C:/用户/Med Claw/data/settings.json', cachePath: 'C:/用户/Med Claw/data/pi-model-cache.json',
      lockPath: 'C:/用户/Med Claw/runtime/host.lock' } };
  expect(HostHelloSchema.safeParse(hello).success).toBe(true);
  expect(HostHelloSchema.safeParse({ ...hello, protocolVersion: 'medclaw.host/p15-v4' }).success).toBe(false);
  expect(HostHelloSchema.safeParse({ ...hello, sdkVersion: '0.87.2' }).success).toBe(false);
  expect(HostHelloSchema.safeParse({ ...hello, resourceRoot: '../source' }).success).toBe(false);
});

test('installed evaluation roots preserve legacy callers and reject relative private material roots', () => {
  const paths = { sourceRoot: 'C:/MedClaw/runtime', configsRoot: 'C:/Data/evaluation/configs', runsRoot: 'C:/Data/evaluation/runs' };
  expect(EvaluationPathsSchema.parse(paths)).toEqual(paths);
  expect(EvaluationPathsSchema.safeParse({ ...paths, datasetsRoot: 'C:/Data/evaluation/datasets' }).success).toBe(true);
  expect(EvaluationPathsSchema.safeParse({ ...paths, datasetsRoot: '../Gold' }).success).toBe(false);
  expect(EvaluationPathsSchema.parse({ ...paths, installManifestPath: 'C:/MedClaw/install.json' }).installManifestPath).toBe('C:/MedClaw/install.json');
  expect(EvaluationPathsSchema.safeParse({ ...paths, installManifestPath: '../install.json' }).success).toBe(false);
});

test('maintenance errors keep their category and retry policy without exposing native details', () => {
  for (const [code, category, retryable] of [
    ['host_dependency_unavailable', 'runtime', true], ['host_process_tracking_unavailable', 'runtime', false],
    ['backup_invalid', 'input', false], ['backup_write_failed', 'storage', true],
    ['backup_incompatible', 'input', false], ['restore_failed', 'storage', true], ['maintenance_busy', 'runtime', true],
  ] as const) {
    const error = safeError(code, new Error('synthetic-private-path-and-key'));
    expect(error).toMatchObject({ code, category, retryable });
    expect(JSON.stringify(error)).not.toContain('synthetic-private-path-and-key');
  }
});
