import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ConfigVersionSchema, CredentialRefSchema, ProviderIdSchema } from "../../../../packages/contracts/src/model";
import {
  CredentialSchema, DesktopSecretInputSchema, privateCredentialMethodSchemas,
  type Credential, type DesktopSecretInput, type DesktopSecretInputResult,
  type PrivateCredentialPayload, type PrivateCredentialReturn,
} from "../../../../packages/contracts/src/protocol";
import { atomicWriteJson } from "./settings";

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
const envelopeSchema = z.strictObject({ format: z.literal("medclaw.credentials.enc/p1-v1"), ciphertextBase64: z.string().min(1).max(16_777_216).regex(/^[A-Za-z0-9+/]+={0,2}$/) });
const stateSchema = z.strictObject({
  schemaVersion: z.literal("medclaw.credentials/p1-v1"), revision: ConfigVersionSchema,
  activeBindings: z.record(ProviderIdSchema, CredentialRefSchema),
  entries: z.record(CredentialRefSchema, z.strictObject({ providerId: ProviderIdSchema, credential: CredentialSchema })),
});
type CredentialState = z.infer<typeof stateSchema>;
type Lease = {
  id: string; instanceId: string; providerId: string; version: string; reference: string | null;
  purpose: "auth" | "runtime" | "rollback"; release(): void;
};
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function copy<T>(value: T): T { return structuredClone(value); }

export class MainCredentials {
  private instanceId: string | null = null;
  private leases = new Map<string, Lease>();
  private providerQueues = new Map<string, Promise<void>>();
  private publication: Promise<unknown> = Promise.resolve();
  private commits = new Map<string, {
    instanceId: string; input: PrivateCredentialPayload<"credential.modify.commit">;
    assignedReference?: string; result: Promise<Credential | null>; settled: boolean;
  }>();
  constructor(private readonly path: string, private readonly protection: SafeStoragePort) {
    if (!isAbsolute(path)) fail("invalid_argument");
  }
  attachInstance(instanceId: string): void {
    if (!instanceId || this.instanceId && this.instanceId !== instanceId) fail("state_conflict");
    this.instanceId = instanceId;
  }
  private trusted(instanceId: string) { if (this.instanceId !== instanceId) fail("access_denied"); }
  private load(): CredentialState {
    if (!this.protection.isEncryptionAvailable()) fail("credential_storage_unavailable");
    let body: string;
    try { body = readFileSync(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: "medclaw.credentials/p1-v1", revision: "0", activeBindings: {}, entries: {} };
      return fail("credential_read_failed");
    }
    try {
      const envelope = envelopeSchema.parse(JSON.parse(body));
      const state = stateSchema.parse(JSON.parse(this.protection.decryptString(Buffer.from(envelope.ciphertextBase64, "base64"))));
      for (const [providerId, reference] of Object.entries(state.activeBindings)) {
        if (!Object.hasOwn(state.entries, reference) || state.entries[reference]!.providerId !== providerId) fail("credential_read_failed");
      }
      return state;
    } catch { return fail("credential_read_failed"); }
  }
  private reference(state: CredentialState, providerId: string, requested?: string | null): string | null {
    const reference = requested === undefined ? Object.hasOwn(state.activeBindings, providerId) ? state.activeBindings[providerId]! : null : requested;
    if (reference !== null && (!Object.hasOwn(state.entries, reference) || state.entries[reference]!.providerId !== providerId)) fail("access_denied");
    return reference;
  }
  private async lock(providerId: string): Promise<() => void> {
    const prior = this.providerQueues.get(providerId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = prior.then(() => gate);
    this.providerQueues.set(providerId, queued);
    await prior;
    return () => {
      release();
      if (this.providerQueues.get(providerId) === queued) this.providerQueues.delete(providerId);
    };
  }
  private update(action: (state: CredentialState) => void): Promise<void> {
    const task = this.publication.then(() => {
      const state = this.load();
      action(state);
      state.revision = (BigInt(state.revision) + 1n).toString();
      try {
        const encoded = this.protection.encryptString(JSON.stringify(stateSchema.parse(state))).toString("base64");
        atomicWriteJson(this.path, envelopeSchema.parse({ format: "medclaw.credentials.enc/p1-v1", ciphertextBase64: encoded }));
        const actual = this.load();
        if (JSON.stringify(actual) !== JSON.stringify(state)) fail("credential_write_failed");
      } catch { fail("credential_write_failed"); }
    });
    this.publication = task.then(() => undefined, () => undefined);
    return task;
  }

  async read(instanceId: string, payload: PrivateCredentialPayload<"credential.read">): Promise<Credential | null> {
    this.trusted(instanceId);
    const input = privateCredentialMethodSchemas["credential.read"].input.parse(payload);
    const release = await this.lock(input.providerId);
    try {
      this.trusted(instanceId);
      const state = this.load();
      const reference = this.reference(state, input.providerId, input.context.credentialRef);
      return reference === null ? null : copy(state.entries[reference]!.credential);
    } finally { release(); }
  }
  async list(instanceId: string): Promise<PrivateCredentialReturn<"credential.list">> {
    this.trusted(instanceId);
    const state = this.load();
    return Object.entries(state.activeBindings).map(([providerId, reference]) => ({ providerId, type: state.entries[reference]!.credential.type }));
  }
  async begin(instanceId: string, payload: PrivateCredentialPayload<"credential.modify.begin">): Promise<PrivateCredentialReturn<"credential.modify.begin">> {
    this.trusted(instanceId);
    const input = privateCredentialMethodSchemas["credential.modify.begin"].input.parse(payload);
    const release = await this.lock(input.providerId);
    try {
      this.trusted(instanceId);
      const state = this.load();
      const reference = this.reference(state, input.providerId, input.context.credentialRef);
      if (reference !== input.expectedCredentialRef) fail("state_conflict");
      const id = randomUUID();
      this.leases.set(id, { id, instanceId, providerId: input.providerId, version: state.revision, reference, purpose: input.context.purpose, release });
      return { leaseId: id, version: state.revision, current: reference === null ? null : copy(state.entries[reference]!.credential) };
    } catch (error) { release(); throw error; }
  }
  private lease(instanceId: string, leaseId: string): Lease {
    this.trusted(instanceId);
    const lease = this.leases.get(leaseId);
    if (!lease || lease.instanceId !== instanceId) fail("state_conflict");
    return lease;
  }
  private release(lease: Lease) { this.leases.delete(lease.id); lease.release(); }

  async commit(instanceId: string, payload: PrivateCredentialPayload<"credential.modify.commit">, assignedReference?: string): Promise<Credential | null> {
    this.trusted(instanceId);
    const input = privateCredentialMethodSchemas["credential.modify.commit"].input.parse(payload);
    const prior = this.commits.get(input.leaseId);
    if (prior) {
      if (prior.instanceId !== instanceId || prior.assignedReference !== assignedReference || !isDeepStrictEqual(prior.input, input)) fail("state_conflict");
      return copy(await prior.result);
    }
    const lease = this.lease(instanceId, input.leaseId);
    if (input.expectedVersion !== lease.version) fail("state_conflict");
    if (assignedReference !== undefined && (!CredentialRefSchema.safeParse(assignedReference).success || lease.purpose !== "auth" || !input.changed || Object.hasOwn(this.load().entries, assignedReference))) fail("state_conflict");
    const result = (async () => { try {
      if (input.changed) {
        await this.update(state => {
          this.trusted(instanceId);
          const reference = assignedReference ?? (lease.purpose === "auth" || lease.reference === null ? randomUUID() : lease.reference);
          state.entries = { ...state.entries, [reference]: { providerId: lease.providerId, credential: copy(input.next) } };
          if (lease.purpose === "auth" || lease.reference === null || this.reference(state, lease.providerId) === lease.reference)
            state.activeBindings = { ...state.activeBindings, [lease.providerId]: reference };
          lease.reference = reference;
        });
      }
      const state = this.load();
      return lease.reference === null ? null : copy(state.entries[lease.reference]!.credential);
    } finally { this.release(lease); } })();
    const record = { instanceId, input: copy(input), ...(assignedReference ? { assignedReference } : {}), result, settled: false };
    this.commits.set(input.leaseId, record);
    const settle = () => {
      record.settled = true;
      for (const [id, cached] of this.commits) if (this.commits.size > 50 && cached.settled) this.commits.delete(id);
    };
    void result.then(settle, settle);
    return copy(await result);
  }
  // The trusted bridge sends abort only after its callback settles; EOF alone must use confirmed process exit below.
  async abort(instanceId: string, payload: PrivateCredentialPayload<"credential.modify.abort">): Promise<null> {
    const input = privateCredentialMethodSchemas["credential.modify.abort"].input.parse(payload);
    this.trusted(instanceId);
    const committing = this.commits.get(input.leaseId);
    if (committing) { if (committing.instanceId !== instanceId) fail("access_denied"); await committing.result.catch(() => undefined); return null; }
    this.release(this.lease(instanceId, input.leaseId));
    return null;
  }
  async delete(instanceId: string, payload: PrivateCredentialPayload<"credential.delete">): Promise<null> {
    this.trusted(instanceId);
    const input = privateCredentialMethodSchemas["credential.delete"].input.parse(payload);
    const release = await this.lock(input.providerId);
    try {
      await this.update(state => {
        this.trusted(instanceId);
        if (this.reference(state, input.providerId, input.context.credentialRef) !== this.reference(state, input.providerId)) fail("state_conflict");
        delete state.activeBindings[input.providerId];
        // Retained references remain available to the current/previous settings snapshots.
      });
      return null;
    } finally { release(); }
  }
  activeRef(providerId: string): string | null { return this.reference(this.load(), providerId); }
  captureRefs(): Record<string, string> { return copy(this.load().activeBindings); }
  validateRefs(references: Record<string, string | null>): void {
    const state = this.load();
    for (const [provider, reference] of Object.entries(references)) { ProviderIdSchema.parse(provider); this.reference(state, provider, reference); }
  }
  async bindRefs(references: Record<string, string | null>): Promise<void> {
    const providers = [...new Set([...Object.keys(this.load().activeBindings), ...Object.keys(references)])].sort();
    const releases: (() => void)[] = [];
    try {
      for (const provider of providers) releases.push(await this.lock(provider));
      await this.update(state => {
        const bindings: Record<string, string> = {};
        for (const [provider, reference] of Object.entries(references)) {
          ProviderIdSchema.parse(provider);
          this.reference(state, provider, reference);
          if (reference !== null) bindings[provider] = reference;
        }
        state.activeBindings = bindings;
      });
    } finally { releases.reverse().forEach(release => release()); }
  }
  confirmHostExit(instanceId: string): void {
    for (const lease of this.leases.values()) if (lease.instanceId === instanceId) this.release(lease);
    for (const [id, result] of this.commits) if (result.instanceId === instanceId) this.commits.delete(id);
    if (this.instanceId === instanceId) this.instanceId = null;
  }
}

export class SecretInputs {
  private tokens = new Map<string, { windowId: number; providerId: string; purpose: "custom_api_key"; value: string; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly now: () => number = Date.now) {}
  private remove(token: string) { const stored = this.tokens.get(token); if (stored) clearTimeout(stored.timer); this.tokens.delete(token); }
  issue(windowId: number, input: DesktopSecretInput): DesktopSecretInputResult {
    const parsed = DesktopSecretInputSchema.safeParse(input);
    if (!parsed.success || !Number.isSafeInteger(windowId) || windowId <= 0) fail("invalid_argument");
    for (const [token, stored] of this.tokens) if (stored.expiresAt <= this.now()) this.remove(token);
    if (this.tokens.size >= 64) fail("runtime_busy");
    const token = randomUUID();
    const expiresAt = this.now() + 300_000;
    const timer = setTimeout(() => this.remove(token), 300_000); timer.unref();
    this.tokens.set(token, { ...parsed.data, windowId, expiresAt, timer });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }
  consume(token: string, context: { windowId: number; providerId: string; purpose: "custom_api_key" }): string {
    const stored = this.tokens.get(token);
    if (stored && stored.expiresAt <= this.now()) this.remove(token);
    if (!stored || stored.expiresAt <= this.now() || stored.windowId !== context.windowId || stored.providerId !== context.providerId || stored.purpose !== context.purpose) fail("access_denied");
    this.remove(token);
    return stored.value;
  }
  discard(token: string, windowId: number): void { if (this.tokens.get(token)?.windowId === windowId) this.remove(token); }
  closeWindow(windowId: number): void { for (const [token, stored] of this.tokens) if (stored.windowId === windowId) this.remove(token); }
}
