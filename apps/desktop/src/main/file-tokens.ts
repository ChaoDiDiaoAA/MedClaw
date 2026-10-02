import { realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { OpaqueIdSchema } from '../../../../packages/contracts/src/error';

export class FileTokens {
  private readonly tokens = new Map<string, { windowId: number; instanceId: string; operationRef: string; root: string; identity: string; expires: number }>();
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
  closeWindow(windowId: number) { for (const [token, entry] of this.tokens) if (entry.windowId === windowId) this.tokens.delete(token); }
}
