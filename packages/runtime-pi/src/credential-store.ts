import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { privateCredentialMethodSchemas, type PrivateCredentialMethod, type PrivateCredentialReturn } from "../../contracts/src/protocol.ts";
import type { CredentialContext } from "../../contracts/src/model.ts";
export type { CredentialContext } from "../../contracts/src/model.ts";
export type PrivateCredentialCall = (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>;
/** Main holds the lease while Pi's callback runs in Host, including OAuth refresh. */
export class BridgeCredentialStore implements CredentialStore {
  private readonly contexts = new AsyncLocalStorage<CredentialContext>();
  constructor(private readonly call: PrivateCredentialCall) {}
  private async invoke<M extends PrivateCredentialMethod>(method: M, payload: unknown, signal?: AbortSignal): Promise<PrivateCredentialReturn<M>> {
    signal?.throwIfAborted();
    const schema = privateCredentialMethodSchemas[method];
    const result = await this.call(method, schema.input.parse(payload), signal);
    return schema.output.parse(result) as PrivateCredentialReturn<M>;
  }
  withContext<T>(context: CredentialContext, fn: () => Promise<T>): Promise<T> { return this.contexts.run(context, fn); }
  private context() { return this.contexts.getStore() ?? { purpose: "runtime" as const, operationRef: "catalog_snapshot" }; }
  async read(providerId: string, options?: AuthOperationOptions) {
    return await this.invoke("credential.read", { providerId, context: this.context() }, options?.signal) ?? undefined;
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
