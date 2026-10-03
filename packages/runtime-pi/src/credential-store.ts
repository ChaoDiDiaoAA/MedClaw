import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { privateCredentialMethodSchemas, type PrivateCredentialMethod, type PrivateCredentialReturn } from "../../contracts/src/protocol.ts";
import type { CredentialContext } from "../../contracts/src/model.ts";
export type { CredentialContext } from "../../contracts/src/model.ts";
export type PrivateCredentialCall = (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>;
/** Main holds the lease while Pi's callback runs in Host, including OAuth refresh. */
export class BridgeCredentialStore implements CredentialStore {
  private readonly contexts = new AsyncLocalStorage<CredentialContext>();
  private activeReads = 0;
  private readonly waitingReads: (() => void)[] = [];
  constructor(private readonly call: PrivateCredentialCall) {}
  private async invoke<M extends PrivateCredentialMethod>(method: M, payload: unknown, signal?: AbortSignal): Promise<PrivateCredentialReturn<M>> {
    signal?.throwIfAborted();
    const schema = privateCredentialMethodSchemas[method];
    const result = await this.call(method, schema.input.parse(payload), signal);
    return schema.output.parse(result) as PrivateCredentialReturn<M>;
  }
  withContext<T>(context: CredentialContext, fn: () => Promise<T>): Promise<T> { return this.contexts.run(context, fn); }
  private context() { return this.contexts.getStore() ?? { purpose: "runtime" as const, operationRef: "catalog_snapshot" }; }
  private releaseRead() {
    const next = this.waitingReads.shift();
    if (next) next(); else this.activeReads--;
  }
  private acquireRead(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    // Pi catalog refresh fans out too; leave headroom in the 256-frame transport.
    // Lease begin/commit/abort and other private methods never wait for read slots.
    if (this.activeReads < 64) {
      this.activeReads++;
      return Promise.resolve(() => this.releaseRead());
    }
    return new Promise((resolve, reject) => {
      const admit = () => {
        signal?.removeEventListener("abort", cancel);
        resolve(() => this.releaseRead());
      };
      const cancel = () => {
        const index = this.waitingReads.indexOf(admit);
        if (index === -1) return;
        this.waitingReads.splice(index, 1);
        signal?.removeEventListener("abort", cancel);
        reject(signal?.reason);
      };
      this.waitingReads.push(admit);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
  async read(providerId: string, options?: AuthOperationOptions) {
    const payload = { providerId, context: { ...this.context() } };
    const release = await this.acquireRead(options?.signal);
    try { return await this.invoke("credential.read", payload, options?.signal) ?? undefined; }
    finally { release(); }
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> { return this.invoke("credential.list", {}, options?.signal); }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    const context = this.context();
    const lease = await this.invoke("credential.modify.begin", { providerId, context, expectedCredentialRef: context.credentialRef ?? null, operationId: crypto.randomUUID() }, options?.signal);
    try {
      options?.signal?.throwIfAborted();
      const next = await fn(lease.current ?? undefined);
      options?.signal?.throwIfAborted();
      return await this.invoke("credential.modify.commit", next === undefined ? { leaseId: lease.leaseId, expectedVersion: lease.version, changed: false } : { leaseId: lease.leaseId, expectedVersion: lease.version, changed: true, next }) ?? undefined;
    } catch (error) {
      // Callback has settled here. Do not unlock merely because a timer fired.
      await this.invoke("credential.modify.abort", { leaseId: lease.leaseId }).catch(() => {});
      throw error;
    }
  }
  async delete(providerId: string, options?: AuthOperationOptions) { await this.invoke("credential.delete", { providerId, context: this.context() }, options?.signal); }
}
