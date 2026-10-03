import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  AgentPolicySchema, ConfigVersionSchema, DEFAULT_AGENT_POLICY, DEFAULT_DISPLAY_PREFERENCES, DEFAULT_REQUEST_POLICY,
  DesktopDisplayPreferencesSchema, PublishedSettingsSchema, RequestPolicySchema, SETTINGS_SCHEMA_VERSION,
  SettingsSnapshotObjectSchema, type DesktopDisplayPreferences, type PublishedSettings, type SettingsSnapshot,
} from "../../../../packages/contracts/src/model";
import { StoredToolConfigurationSchema, normalizeToolConfiguration, type StoredToolConfiguration } from '../../../../packages/contracts/src/tool-config';
import { RuntimeConfigurationSchema, mergeRuntimeConfigurationPolicies } from '../../../../packages/contracts/src/runtime-config';

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
export function atomicWriteJson(path: string, value: unknown): void {
  if (!isAbsolute(path)) fail("invalid_argument");
  const temporary = `${path}.tmp-${randomUUID()}`;
  const body = JSON.stringify(value);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    if (readFileSync(path, "utf8") !== body) fail("atomic_write_failed");
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}
export interface SettingsCoordinator {
  prepare(token: string, candidate: PublishedSettings): Promise<unknown>;
  commit(token: string, publishedVersion: string): Promise<unknown>;
  abort(token: string): Promise<unknown>;
  readVersion?(): Promise<string>;
}
export type SettingsPatch = Partial<Pick<SettingsSnapshot, "model" | "customProviders" | "credentialRefs" | "requestPolicy" | "agentPolicy" | 'runtimeConfiguration'>> & {
  toolConfiguration?: StoredToolConfiguration;
  ui?: Partial<DesktopDisplayPreferences>;
};
export interface PublishOptions {
  kind?: "model" | "custom" | "policy" | "ui" | "rollback";
  targetConfigVersion?: string;
  beforeWrite?(candidate: PublishedSettings): Promise<void>;
  onUnpublished?(): Promise<void>;
}
const patchSchema = z.strictObject({
  model: SettingsSnapshotObjectSchema.shape.model.optional(),
  customProviders: SettingsSnapshotObjectSchema.shape.customProviders.optional(),
  credentialRefs: SettingsSnapshotObjectSchema.shape.credentialRefs.optional(),
  requestPolicy: RequestPolicySchema.optional(), ui: DesktopDisplayPreferencesSchema.partial().optional(),
  agentPolicy: AgentPolicySchema.optional(),
  runtimeConfiguration: RuntimeConfigurationSchema.optional(),
  toolConfiguration: StoredToolConfigurationSchema.optional(),
});
function snapshot(value: PublishedSettings): SettingsSnapshot {
  const { previous, rollbackFromVersion, ...current } = value;
  return current;
}

export class MainSettings {
  private queue: Promise<unknown> = Promise.resolve();
  private pending: { token: string; candidate: PublishedSettings; unpublished?: { previous: PublishedSettings; restore?: () => Promise<void> } } | null = null;
  constructor(
    private readonly path: string,
    private readonly coordinator?: SettingsCoordinator,
    private readonly writeJson: typeof atomicWriteJson = atomicWriteJson,
  ) { if (!isAbsolute(path)) fail("invalid_argument"); }

  read(): PublishedSettings {
    try {
      const parsed = PublishedSettingsSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      if (!parsed.success) fail("config_read_failed");
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("config_read_failed");
      const initial = PublishedSettingsSchema.parse({
        schemaVersion: SETTINGS_SCHEMA_VERSION, configVersion: "1", model: null, customProviders: [], credentialRefs: {},
        requestPolicy: { ...DEFAULT_REQUEST_POLICY }, agentPolicy: { ...DEFAULT_AGENT_POLICY }, ui: { ...DEFAULT_DISPLAY_PREFERENCES }, previous: null, rollbackFromVersion: null,
      });
      try { this.writeJson(this.path, initial); } catch { return fail("config_write_failed"); }
      return initial;
    }
  }
  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(action, action);
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  publish(expected: string, patch: SettingsPatch, options: PublishOptions = {}): Promise<PublishedSettings> {
    return this.serialized(async () => {
      if (this.pending) fail("config_write_failed");
      const current = this.read();
      if (!ConfigVersionSchema.safeParse(expected).success || current.configVersion !== expected) fail("config_conflict");
      const parsed = patchSchema.safeParse(patch);
      if (!parsed.success) fail("invalid_argument");
      const kind = options.kind ?? (Object.keys(parsed.data).every(key => key === "ui") ? "ui" : "model");
      if (kind === "ui" && (Object.keys(parsed.data).some(key => key !== "ui") || !parsed.data.ui || Object.keys(parsed.data.ui).length === 0)) fail("invalid_argument");
      let next: SettingsSnapshot;
      let rollbackFromVersion: string | null = null;
      if (kind === "rollback") {
        if (Object.keys(parsed.data).length || !current.previous || current.previous.configVersion !== options.targetConfigVersion) fail("config_conflict");
        next = current.previous;
        rollbackFromVersion = current.previous.configVersion;
      } else {
        if (Object.keys(parsed.data).length === 0) fail("invalid_argument");
        try {
          next = { ...snapshot(current), ...parsed.data, ...mergeRuntimeConfigurationPolicies(current, parsed.data),
            toolConfiguration: normalizeToolConfiguration({ toolConfiguration: parsed.data.toolConfiguration ?? current.toolConfiguration }),
            ui: { ...current.ui, ...parsed.data.ui } };
        } catch { fail('invalid_argument'); }
      }
      const candidate = PublishedSettingsSchema.safeParse({ ...next, configVersion: (BigInt(current.configVersion) + 1n).toString(),
        previous: snapshot(current), rollbackFromVersion });
      if (!candidate.success) fail("invalid_argument");
      const value = candidate.data;
      const token = randomUUID();
      const coordinated = kind !== "ui";
      if (coordinated && !this.coordinator) fail("host_not_ready");
      if (coordinated) {
        try { await this.coordinator!.prepare(token, value); }
        catch (error) { await this.coordinator!.abort(token); throw error; }
      }
      const abortUnpublished = async () => {
        try { await options.onUnpublished?.(); if (coordinated) await this.coordinator!.abort(token); }
        catch (error) { this.pending = { token, candidate: value, unpublished: { previous: current, ...(options.onUnpublished ? { restore: options.onUnpublished } : {}) } }; throw error; }
      };
      try { await options.beforeWrite?.(value); }
      catch (error) { await abortUnpublished(); throw error; }
      try {
        this.writeJson(this.path, value);
        if (!isDeepStrictEqual(this.read(), value)) fail("config_write_failed");
      } catch {
        // Replace may have succeeded before readback failed; query the same snapshot before deciding to abort.
        let published = false;
        let oldConfirmed = false;
        try { const actual = this.read(); published = isDeepStrictEqual(actual, value); oldConfirmed = isDeepStrictEqual(actual, current); }
        catch { /* Keep the result explicitly unknown. */ }
        if (!published) {
          if (oldConfirmed) await abortUnpublished();
          else if (coordinated) this.pending = { token, candidate: value };
          fail("config_write_failed");
        }
      }
      if (coordinated) {
        this.pending = { token, candidate: value };
        try { await this.coordinator!.commit(token, value.configVersion); }
        catch { return fail("config_write_failed"); }
        this.pending = null;
      }
      return value;
    });
  }

  synchronize(): Promise<PublishedSettings> {
    return this.serialized(async () => {
      const current = this.read();
      if (this.pending?.unpublished) {
        if (!isDeepStrictEqual(current, this.pending.unpublished.previous)) fail("config_conflict");
        await this.pending.unpublished.restore?.();
        await this.coordinator?.abort(this.pending.token);
        this.pending = null;
      }
      if (!this.pending) {
        if (!this.coordinator?.readVersion || await this.coordinator.readVersion() === current.configVersion) return current;
        const token = randomUUID();
        await this.coordinator.prepare(token, current);
        this.pending = { token, candidate: current };
      }
      if (!isDeepStrictEqual(current, this.pending.candidate)) fail("config_conflict");
      try { await this.coordinator!.commit(this.pending.token, current.configVersion); }
      catch {
        // A confirmed restarted Host may already have loaded this published file.
        if (await this.coordinator!.readVersion?.() !== current.configVersion) fail("config_write_failed");
      }
      this.pending = null;
      return current;
    });
  }
}
