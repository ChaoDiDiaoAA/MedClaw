import { realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { OpaqueIdSchema } from '../../../../packages/contracts/src/error';
import { MaintenanceOperationRefSchema } from '@medclaw/contracts/maintenance';

export type MaintenancePurpose = 'backup-source' | 'backup-destination' | 'restore-target' | 'backup-result' | 'support-destination' | 'support-result';

export class FileTokens {
  private readonly tokens = new Map<string, { windowId: number; instanceId: string; operationRef: string; root: string; identity: string; expires: number; maintenancePurpose?: MaintenancePurpose; consumed?: boolean }>();
  constructor(private readonly clock = Date.now, private readonly ttlMs = 15 * 60 * 1000) {}
  private identity(path: string) {
    const stat = statSync(path, { bigint: true });
    if (!stat.isDirectory()) throw new Error('file_token_invalid');
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  }
  issue(windowId: number, instanceId: string, operationRef: string, directory: string) {
    OpaqueIdSchema.parse(instanceId); OpaqueIdSchema.parse(operationRef);
    const root = realpathSync(directory), identity = this.identity(root), fileToken = randomUUID();
    for (const [token, entry] of this.tokens) if (entry.expires <= this.clock()) this.tokens.delete(token);
    this.tokens.set(fileToken, { windowId, instanceId, operationRef, root, identity, expires: this.clock() + this.ttlMs });
    return { fileToken, directoryName: basename(root) || root };
  }
  resolve(fileToken: string, windowId: number, instanceId: string, operationRef: string): string {
    const entry = this.tokens.get(fileToken);
    if (!entry || entry.windowId !== windowId || entry.instanceId !== instanceId || entry.operationRef !== operationRef || entry.expires <= this.clock()) throw new Error('file_token_invalid');
    try { if (realpathSync(entry.root) !== entry.root || this.identity(entry.root) !== entry.identity) throw new Error('file_token_invalid'); }
    catch { throw new Error('file_token_invalid'); }
    return entry.root;
  }
  issueMaintenance(windowId: number, operationRef: string, purpose: MaintenancePurpose, directory: string) {
    MaintenanceOperationRefSchema.parse(operationRef);
    if (!Number.isSafeInteger(windowId) || windowId <= 0) throw new Error('access_denied');
    const issued = this.issue(windowId, 'maintenance', operationRef, directory), entry = this.tokens.get(issued.fileToken)!;
    entry.maintenancePurpose = purpose; entry.expires = this.clock() + 300000;
    return { ...issued, directoryName: purpose === 'restore-target' ? 'MedClaw-restored-' + operationRef : issued.directoryName };
  }
  resolveMaintenance(fileToken: string, windowId: number, operationRef: string, purpose: MaintenancePurpose): string {
    try {
      if (this.tokens.get(fileToken)?.maintenancePurpose !== purpose) throw new Error('access_denied');
      const root = this.resolve(fileToken, windowId, 'maintenance', operationRef);
      return purpose === 'restore-target' ? join(root, 'MedClaw-restored-' + operationRef) : root;
    } catch { throw new Error('access_denied'); }
  }
  consumeMaintenance(windowId: number, operationRef: string, grants: ReadonlyArray<{ token: string; purpose: MaintenancePurpose }>): void {
    for (const grant of grants) this.resolveMaintenance(grant.token, windowId, operationRef, grant.purpose);
    // Mark the whole selection only after every binding is valid; this is not publication proof.
    for (const grant of grants) this.tokens.get(grant.token)!.consumed = true;
  }
  discardMaintenance(windowId: number, operationRef: string): void {
    MaintenanceOperationRefSchema.parse(operationRef);
    if (!Number.isSafeInteger(windowId) || windowId <= 0) throw new Error('access_denied');
    for (const [token, entry] of this.tokens) if (entry.windowId === windowId && entry.operationRef === operationRef && entry.maintenancePurpose && !entry.consumed) this.tokens.delete(token);
  }
  closeWindow(windowId: number) { for (const [token, entry] of this.tokens) if (entry.windowId === windowId) this.tokens.delete(token); }
}
