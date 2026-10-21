import { z } from 'zod';
import { AbsolutePathSchema, AppErrorSchema, ConfigVersionSchema, OpaqueIdSchema, PositiveIdSchema, TimestampSchema, resultSchema } from './error';

export const MAINTENANCE_PROTOCOL_VERSION = 'medclaw.maintenance/v1' as const;
export const NativeDependencySchema = z.strictObject({ name: z.enum(['rg', 'fd', 'bash', 'powershell']), path: AbsolutePathSchema,
  version: z.string().min(1).max(256).refine(value => !/[\u0000-\u001f]/.test(value)), source: z.enum(['installed_bundle', 'sdk_standard_discovery']) });
export type NativeDependency = z.infer<typeof NativeDependencySchema>;
export const InstallRelativePathSchema = z.string().min(1).max(1024).refine(value => !/[\\:\u0000-\u001f]/.test(value)
  && !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Expected a contained relative path');
export const InstallManifestSchema = z.strictObject({
  contract: z.literal('medclaw.install/v1'), appVersion: z.literal('0.1.0'), platform: z.literal('win32'), arch: z.literal('x64'),
  sdkVersion: z.literal('0.87.1'), bunVersion: z.literal('1.4.0'), electronVersion: z.literal('44.5.1'),
  protocolVersion: z.literal('medclaw.host/p17-v2'), schemaVersion: z.literal(16),
  hostEntry: InstallRelativePathSchema, maintenanceEntry: InstallRelativePathSchema, resourceRoot: InstallRelativePathSchema,
  resources: z.array(z.strictObject({ kind: z.enum(['prompt', 'skill']), id: OpaqueIdSchema, version: OpaqueIdSchema })).max(1000),
  plugins: z.array(z.strictObject({ name: z.string().min(1).max(256), version: OpaqueIdSchema, patch: InstallRelativePathSchema })).max(100),
  binaries: z.array(z.strictObject({ name: z.enum(['bun', 'rg', 'fd']), version: z.string().min(1).max(128), source: z.string().min(1).max(2048), path: InstallRelativePathSchema })).min(1).max(3)
    .refine(values => new Set(values.map(value => value.name)).size === values.length && values.some(value => value.name === 'bun' && value.version === '1.4.0')),
});
export const LaunchSelectionSchema = z.strictObject({ contract: z.literal('medclaw.launch/v1'), activeDataRoot: AbsolutePathSchema, restoreOperationRef: OpaqueIdSchema });
export const ProcessTreeProofSchema = z.strictObject({
  instanceId: OpaqueIdSchema, basis: z.enum(['windows_job_empty', 'system_restarted']), observedAt: TimestampSchema,
});
export const HostJobDomainSchema = z.strictObject({ contract: z.literal('medclaw.host-job/v1'), jobName: z.string().min(1).max(600), createdAt: TimestampSchema });
export type HostJobDomain = z.infer<typeof HostJobDomainSchema>;
export const WriterLockRecordSchema = z.strictObject({ pid: PositiveIdSchema, instanceId: OpaqueIdSchema, startupToken: OpaqueIdSchema,
  processDomain: HostJobDomainSchema.optional(), recoveryBootMarker: TimestampSchema.optional() });
export type WriterLockRecord = z.infer<typeof WriterLockRecordSchema>;
export const HostShutdownProofSchema = z.strictObject({
  executionStopped: z.boolean().nullable(), requiredPersistenceComplete: z.boolean().nullable(), databaseClosed: z.boolean().nullable(),
  processExited: z.boolean(), processTreeStopped: z.boolean().nullable(), error: AppErrorSchema.nullable(),
});
const receiptFields = {
  operationRef: OpaqueIdSchema, state: z.literal('completed'), appVersion: z.string().min(1).max(128),
  schemaVersion: PositiveIdSchema, sdkVersion: z.literal('0.87.1'),
};
export const BackupReceiptSchema = z.strictObject({ ...receiptFields, kind: z.literal('create'), createdAt: TimestampSchema });
export const RestoreReceiptSchema = z.strictObject({ ...receiptFields, kind: z.literal('restore'), restoredAt: TimestampSchema, configVersion: ConfigVersionSchema });
export const MaintenanceOperationRefSchema = OpaqueIdSchema.max(128).refine(value => !value.includes(':'));
export const BackupRecordSchema = z.strictObject({ request: z.strictObject({ kind: z.literal('create'), sourceRoot: AbsolutePathSchema, destinationRoot: AbsolutePathSchema }), receipt: BackupReceiptSchema });
export const RestoreRecordSchema = z.strictObject({
  request: z.strictObject({ kind: z.literal('restore'), sourceBackup: AbsolutePathSchema, targetRoot: AbsolutePathSchema }),
  // A saved receipt identifies an already restored root; it does not negotiate the active Host protocol.
  sourceOperationRef: MaintenanceOperationRefSchema, installation: InstallManifestSchema.extend({protocolVersion:z.enum(['medclaw.host/p17-v1','medclaw.host/p17-v2'])}), receipt: RestoreReceiptSchema,
});
export const MaintenanceSelectionSchema = z.strictObject({
  sourceToken: OpaqueIdSchema.optional(), destinationToken: OpaqueIdSchema.optional(), targetRootToken: OpaqueIdSchema.optional(), resultToken: OpaqueIdSchema.optional(),
  sourceLabel: z.string().min(1).max(512).optional(), destinationLabel: z.string().min(1).max(512).optional(), targetRootLabel: z.string().min(1).max(512).optional(), resultLabel: z.string().min(1).max(512).optional(),
  originalOperationRef: MaintenanceOperationRefSchema.optional(), originalKind: z.enum(['create', 'restore']).optional(),
});
export const maintenanceMethodSchemas = {
  'maintenance.discardSelection': { input: z.strictObject({}), output: z.null() },
  'backup.select': { input: z.strictObject({ purpose: z.enum(['create', 'restore', 'read']) }), output: MaintenanceSelectionSchema.nullable() },
  'backup.create': { input: z.strictObject({ destinationToken: OpaqueIdSchema }), output: BackupReceiptSchema },
  'backup.restore': { input: z.strictObject({ sourceToken: OpaqueIdSchema, targetRootToken: OpaqueIdSchema }), output: RestoreReceiptSchema },
  'backup.read': { input: z.strictObject({ resultToken: OpaqueIdSchema, kind: z.enum(['create', 'restore']) }), output: z.union([BackupReceiptSchema, RestoreReceiptSchema]).nullable() },
} as const;
export type ProcessTreeProof = z.infer<typeof ProcessTreeProofSchema>;
export function stopProofForOwner(proof: ProcessTreeProof | undefined, instanceId: string): ProcessTreeProof | undefined {
  if (!proof) return undefined;
  const parsed = ProcessTreeProofSchema.parse(proof);
  // A verified reboot closes all older owners in this still-owned root; a Job closes only its own instance.
  return parsed.basis === 'system_restarted' ? { ...parsed, instanceId: OpaqueIdSchema.parse(instanceId) }
    : parsed.instanceId === instanceId ? parsed : undefined;
}
export type HostShutdownProof = z.infer<typeof HostShutdownProofSchema>;
export type BackupReceipt = z.infer<typeof BackupReceiptSchema>;
export type RestoreReceipt = z.infer<typeof RestoreReceiptSchema>;
export type MaintenanceSelection = z.infer<typeof MaintenanceSelectionSchema>;
export type MaintenanceContext = { operationRef: string; windowId: number };
export type InstallManifest = z.infer<typeof InstallManifestSchema>;
const ownerSchema = z.strictObject({ instanceId: OpaqueIdSchema, startupToken: OpaqueIdSchema });
export const ProcessCheckResultSchema = z.strictObject({ stopped: z.boolean(), processTreeProof: ProcessTreeProofSchema.nullable(), canPrepareRecovery: z.boolean() })
  .refine(value => value.stopped === (value.processTreeProof !== null) && !(value.stopped && value.canPrepareRecovery));
export const UpgradeCheckResultSchema = z.strictObject({ checkedRoots: z.array(AbsolutePathSchema).min(1).max(2) });
export const MaintenanceInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('process.check'), owner: ownerSchema, lockPath: AbsolutePathSchema }),
  z.strictObject({ action: z.literal('process.prepareRecovery'), owner: ownerSchema, lockPath: AbsolutePathSchema }),
  z.strictObject({ action: z.literal('process.checkDomain'), owner: ownerSchema, domain: HostJobDomainSchema }),
  z.strictObject({ action: z.literal('backup.create'), sourceRoot: AbsolutePathSchema, destinationRoot: AbsolutePathSchema, installManifestPath: AbsolutePathSchema }),
  z.strictObject({ action: z.literal('backup.restore'), sourceRoot: AbsolutePathSchema, sourceBackup: AbsolutePathSchema, targetRoot: AbsolutePathSchema, installManifestPath: AbsolutePathSchema }),
  z.strictObject({ action: z.literal('backup.read'), sourceRoot: AbsolutePathSchema, kind: z.enum(['create', 'restore']) }),
  z.strictObject({ action: z.literal('upgrade.check'), sourceRoot: AbsolutePathSchema }),
]);
const maintenanceIdentity = { protocolVersion: z.literal(MAINTENANCE_PROTOCOL_VERSION), requestId: OpaqueIdSchema, operationRef: OpaqueIdSchema, workerInstanceId: OpaqueIdSchema };
export const MaintenanceRequestSchema = z.strictObject({ ...maintenanceIdentity, input: MaintenanceInputSchema });
export const MaintenanceReplySchema = z.discriminatedUnion('action', [
  z.strictObject({ ...maintenanceIdentity, action: z.literal('process.check'), result: resultSchema(ProcessCheckResultSchema) }),
  z.strictObject({ ...maintenanceIdentity, action: z.literal('process.prepareRecovery'), result: resultSchema(ProcessCheckResultSchema) }),
  z.strictObject({ ...maintenanceIdentity, action: z.literal('process.checkDomain'), result: resultSchema(ProcessCheckResultSchema) }),
  z.strictObject({ ...maintenanceIdentity, action: z.literal('backup.create'), result: resultSchema(BackupReceiptSchema) }),
  z.strictObject({ ...maintenanceIdentity, action: z.literal('backup.restore'), result: resultSchema(RestoreReceiptSchema) }),
  z.strictObject({ ...maintenanceIdentity, action: z.literal('backup.read'), result: resultSchema(z.union([BackupReceiptSchema, RestoreReceiptSchema]).nullable()) }),
  z.strictObject({ ...maintenanceIdentity, action: z.literal('upgrade.check'), result: resultSchema(UpgradeCheckResultSchema) }),
]);
export type MaintenanceInput = z.infer<typeof MaintenanceInputSchema>;
export type ProcessCheckResult = z.infer<typeof ProcessCheckResultSchema>;
export type MaintenanceOutput<I extends MaintenanceInput> = I extends { action: 'process.check' | 'process.prepareRecovery' | 'process.checkDomain' } ? ProcessCheckResult
  : I extends { action: 'upgrade.check' } ? z.infer<typeof UpgradeCheckResultSchema>
  : I extends { action: 'backup.create' } ? BackupReceipt : I extends { action: 'backup.restore' } ? RestoreReceipt : BackupReceipt | RestoreReceipt | null;
