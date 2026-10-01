import { afterEach, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MainCredentials, SecretInputs, type SafeStoragePort } from "../../apps/desktop/src/main/credentials";
import { MainSettings, atomicWriteJson } from "../../apps/desktop/src/main/settings";

const roots: string[] = [];
function file(name: string) {
  const root = mkdtempSync(join(tmpdir(), "medclaw-p1-main-state-"));
  roots.push(root);
  return join(root, name);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function protection(): SafeStoragePort {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}
const context = { purpose: "auth" as const, operationRef: "operation-login", authAttemptId: "auth-a" };

test("settings initialize, serialize version conflicts and merge UI without replacing model config", async () => {
  const events: string[] = [];
  const settings = new MainSettings(file("settings.json"), {
    async prepare(token, candidate) { events.push(`prepare:${candidate.configVersion}`); },
    async commit(token, version) { events.push(`commit:${version}`); },
    async abort() { events.push("abort"); },
  });
  expect(settings.read()).toMatchObject({ configVersion: "1", model: null, ui: { navCollapsed: false, detailOpen: false, detailTab: "conditions" } });
  const configured = await settings.publish("1", { model: { provider: "test", modelId: "text" } }, { kind: "model" });
  expect(configured.configVersion).toBe("2");
  const results = await Promise.allSettled([
    settings.publish("2", { ui: { navCollapsed: true } }, { kind: "ui" }),
    settings.publish("2", { ui: { detailOpen: true } }, { kind: "ui" }),
  ]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(settings.read()).toMatchObject({ configVersion: "3", model: configured.model, ui: { navCollapsed: true, detailOpen: false } });
  expect(events).toEqual(["prepare:2", "commit:2"]);
});

test("credential values survive an encrypted file reopen without entering its public envelope", async () => {
  const path = file("credentials.enc.json");
  const crypto = protection();
  const credentials = new MainCredentials(path, crypto);
  credentials.attachInstance("instance-a");
  const lease = await credentials.begin("instance-a", { providerId: "test", context, expectedCredentialRef: null, operationId: "operation-modify" });
  const secret = { type: "api_key" as const, key: "canary-secret-should-not-be-plain" };
  expect(await credentials.commit("instance-a", { leaseId: lease.leaseId, expectedVersion: lease.version, changed: true, next: secret })).toEqual(secret);
  expect(readFileSync(path, "utf8")).not.toContain(secret.key);
  const reopened = new MainCredentials(path, crypto);
  reopened.attachInstance("instance-b");
  expect(await reopened.read("instance-b", { providerId: "test", context: { purpose: "runtime", operationRef: "operation-read" } })).toEqual(secret);
  expect(await reopened.list("instance-b")).toEqual([{ providerId: "test", type: "api_key" }]);
});

test("secret input tokens expire, are single use and bind the window and provider", () => {
  let now = 1000;
  const tokens = new SecretInputs(() => now);
  const input = { providerId: "test", purpose: "custom_api_key" as const, value: "secret-key" };
  const { token } = tokens.issue(1, input);
  expect(() => tokens.consume(token, { windowId: 2, providerId: "test", purpose: "custom_api_key" })).toThrow("access_denied");
  expect(tokens.consume(token, { windowId: 1, providerId: "test", purpose: "custom_api_key" })).toBe("secret-key");
  expect(() => tokens.consume(token, { windowId: 1, providerId: "test", purpose: "custom_api_key" })).toThrow("access_denied");
  const expired = tokens.issue(1, input).token;
  now += 300001;
  expect(() => tokens.consume(expired, { windowId: 1, providerId: "test", purpose: "custom_api_key" })).toThrow("access_denied");
  const closed = tokens.issue(1, input).token;
  tokens.closeWindow(1);
  expect(() => tokens.consume(closed, { windowId: 1, providerId: "test", purpose: "custom_api_key" })).toThrow("access_denied");
});

test("a lost credential commit reply replays its exact lease result without writing a second identity", async () => {
  const path = file("credentials.enc.json");
  const credentials = new MainCredentials(path, protection());
  credentials.attachInstance("instance-a");
  const lease = await credentials.begin("instance-a", { providerId: "test", context, expectedCredentialRef: null, operationId: "operation-modify" });
  const input = { leaseId: lease.leaseId, expectedVersion: lease.version, changed: true as const, next: { type: "api_key" as const, key: "once" } };
  const [first, duplicate] = await Promise.all([credentials.commit("instance-a", input), credentials.commit("instance-a", input)]);
  const reference = credentials.activeRef("test");
  const ciphertext = readFileSync(path, "utf8");
  expect(duplicate).toEqual(first);
  expect(await credentials.commit("instance-a", input)).toEqual(first);
  expect(readFileSync(path, "utf8")).toBe(ciphertext);
  expect(credentials.activeRef("test")).toBe(reference);
  expect(() => credentials.attachInstance("instance-b")).toThrow("state_conflict");
  await expect(credentials.commit("instance-a", { ...input, next: { type: "api_key", key: "changed" } })).rejects.toThrow("state_conflict");
});

test("a provider lease blocks later reads until callback settle or confirmed Host exit", async () => {
  const credentials = new MainCredentials(file("credentials.enc.json"), protection());
  credentials.attachInstance("instance-a");
  const lease = await credentials.begin("instance-a", { providerId: "test", context, expectedCredentialRef: null, operationId: "operation-modify" });
  let readFinished = false;
  const waiting = credentials.read("instance-a", { providerId: "test", context }).then(value => { readFinished = true; return value; });
  await Promise.resolve();
  expect(readFinished).toBe(false);
  await credentials.abort("instance-a", { leaseId: lease.leaseId });
  expect(await waiting).toBeNull();
  const second = await credentials.begin("instance-a", { providerId: "test", context, expectedCredentialRef: null, operationId: "operation-second" });
  credentials.confirmHostExit("instance-a");
  credentials.attachInstance("instance-b");
  await expect(credentials.commit("instance-a", { leaseId: second.leaseId, expectedVersion: second.version, changed: false })).rejects.toThrow("access_denied");
  expect(await credentials.read("instance-b", { providerId: "test", context })).toBeNull();
});

test("parallel providers preserve both encrypted entries and token refresh preserves the original reference", async () => {
  const credentials = new MainCredentials(file("credentials.enc.json"), protection());
  credentials.attachInstance("instance-a");
  const [a, b] = await Promise.all(["first", "second"].map(providerId => credentials.begin("instance-a", { providerId, context, expectedCredentialRef: null, operationId: `modify-${providerId}` })));
  await Promise.all([credentials.commit("instance-a", { leaseId: a!.leaseId, expectedVersion: a!.version, changed: true, next: { type: "oauth", access: "first-access", refresh: "first-refresh", expires: 1000, accountId: "account-one" } }),
    credentials.commit("instance-a", { leaseId: b!.leaseId, expectedVersion: b!.version, changed: true, next: { type: "api_key", key: "second-key" } })]);
  expect(await credentials.list("instance-a")).toEqual([{ providerId: "first", type: "oauth" }, { providerId: "second", type: "api_key" }]);
  const originalRef = credentials.activeRef("first");
  const runtime = { purpose: "runtime" as const, operationRef: "run-operation", credentialRef: originalRef };
  const refresh = await credentials.begin("instance-a", { providerId: "first", context: runtime, expectedCredentialRef: originalRef, operationId: "refresh-token" });
  await credentials.commit("instance-a", { leaseId: refresh.leaseId, expectedVersion: refresh.version, changed: true, next: { type: "oauth", access: "new-access", refresh: "new-refresh", expires: 2000, accountId: "account-one" } });
  expect(credentials.activeRef("first")).toBe(originalRef);
  const current = await credentials.read("instance-a", { providerId: "first", context: runtime });
  expect(current).toMatchObject({ access: "new-access", refresh: "new-refresh", accountId: "account-one" });
});

test("changing an account retains the old reference for an explicit checked rollback", async () => {
  const credentials = new MainCredentials(file("credentials.enc.json"), protection());
  credentials.attachInstance("instance-a");
  const first = await credentials.begin("instance-a", { providerId: "test", context, expectedCredentialRef: null, operationId: "first-login" });
  await credentials.commit("instance-a", { leaseId: first.leaseId, expectedVersion: first.version, changed: true, next: { type: "api_key", key: "old-key" } });
  const oldRef = credentials.activeRef("test");
  const second = await credentials.begin("instance-a", { providerId: "test", context, expectedCredentialRef: oldRef, operationId: "second-login" });
  await credentials.commit("instance-a", { leaseId: second.leaseId, expectedVersion: second.version, changed: true, next: { type: "api_key", key: "new-key" } });
  expect(credentials.activeRef("test")).not.toBe(oldRef);
  await credentials.bindRefs({ test: oldRef });
  expect(await credentials.read("instance-a", { providerId: "test", context: { purpose: "rollback", operationRef: "rollback-operation", credentialRef: oldRef } })).toEqual({ type: "api_key", key: "old-key" });
  await expect(credentials.read("instance-a", { providerId: "other", context: { purpose: "runtime", operationRef: "wrong-provider", credentialRef: oldRef } })).rejects.toThrow("access_denied");
  const added = await credentials.begin("instance-a", { providerId: "later", context, expectedCredentialRef: null, operationId: "later-login" });
  await credentials.commit("instance-a", { leaseId: added.leaseId, expectedVersion: added.version, changed: true, next: { type: "api_key", key: "later-key" } });
  const laterRef = credentials.activeRef("later");
  await credentials.bindRefs({ test: oldRef });
  expect(credentials.captureRefs()).toEqual({ test: oldRef! });
  // Removed bindings remain retained facts, rather than being deleted as secrets.
  expect(await credentials.read("instance-a", { providerId: "later", context: { purpose: "rollback", operationRef: "later-lookup", credentialRef: laterRef } })).toEqual({ type: "api_key", key: "later-key" });
});

test("failed encryption and invalid files preserve the last credential file with no plaintext fallback", async () => {
  const path = file("credentials.enc.json");
  const crypto = protection();
  let failEncrypt = false;
  const credentials = new MainCredentials(path, { ...crypto, encryptString(value) { if (failEncrypt) throw new Error("secret-in-unsafe-error"); return crypto.encryptString(value); } });
  credentials.attachInstance("instance-a");
  const first = await credentials.begin("instance-a", { providerId: "test", context, expectedCredentialRef: null, operationId: "first-login" });
  await credentials.commit("instance-a", { leaseId: first.leaseId, expectedVersion: first.version, changed: true, next: { type: "api_key", key: "keep" } });
  const original = readFileSync(path, "utf8");
  const next = await credentials.begin("instance-a", { providerId: "test", context, expectedCredentialRef: credentials.activeRef("test"), operationId: "failed-login" });
  failEncrypt = true;
  await expect(credentials.commit("instance-a", { leaseId: next.leaseId, expectedVersion: next.version, changed: true, next: { type: "api_key", key: "discard" } })).rejects.toThrow("credential_write_failed");
  expect(readFileSync(path, "utf8")).toBe(original);
  const unavailable = new MainCredentials(path, { ...crypto, isEncryptionAvailable: () => false });
  unavailable.attachInstance("instance-b");
  await expect(unavailable.read("instance-b", { providerId: "test", context })).rejects.toThrow("credential_storage_unavailable");
  writeFileSync(path, "not-json");
  await expect(credentials.read("instance-a", { providerId: "test", context })).rejects.toThrow("credential_read_failed");
  expect(readFileSync(path, "utf8")).toBe("not-json");
});

test("settings abort before replacement preserves the complete previous file", async () => {
  const path = file("settings.json");
  const events: string[] = [];
  let failWrite = false;
  const settings = new MainSettings(path, {
    async prepare() { events.push("prepare"); }, async commit() { events.push("commit"); }, async abort() { events.push("abort"); },
  }, (path, value) => { if (failWrite) throw new Error("write fault"); atomicWriteJson(path, value); });
  const original = settings.read();
  failWrite = true;
  await expect(settings.publish("1", { model: { provider: "test", modelId: "text" } }, { kind: "model" })).rejects.toThrow("config_write_failed");
  expect(settings.read()).toEqual(original);
  expect(events).toEqual(["prepare", "abort"]);
});

test("a lost settings commit reply is synchronized with the same published version and token", async () => {
  const commits: { token: string; version: string }[] = [];
  const settings = new MainSettings(file("settings.json"), {
    async prepare() {}, async abort() { throw new Error("published config must not abort"); },
    async commit(token, version) { commits.push({ token, version }); if (commits.length === 1) throw new Error("lost reply"); },
  });
  settings.read();
  await expect(settings.publish("1", { model: { provider: "test", modelId: "text" } }, { kind: "model" })).rejects.toThrow("config_write_failed");
  expect(settings.read()).toMatchObject({ configVersion: "2", model: { provider: "test", modelId: "text" } });
  await expect(settings.publish("2", { ui: { detailOpen: true } }, { kind: "ui" })).rejects.toThrow("config_write_failed");
  expect(await settings.synchronize()).toMatchObject({ configVersion: "2" });
  expect(commits).toEqual([commits[0]!, commits[0]!]);
});

test("explicit settings rollback publishes a new version and does not accept an older missing target", async () => {
  const settings = new MainSettings(file("settings.json"), { async prepare() {}, async commit() {}, async abort() {} });
  settings.read();
  await settings.publish("1", { model: { provider: "test", modelId: "one" } }, { kind: "model" });
  await settings.publish("2", { model: { provider: "test", modelId: "two" } }, { kind: "model" });
  const rolledBack = await settings.publish("3", {}, { kind: "rollback", targetConfigVersion: "2" });
  expect(rolledBack).toMatchObject({ configVersion: "4", model: { provider: "test", modelId: "one" }, rollbackFromVersion: "2", previous: { configVersion: "3", model: { modelId: "two" } } });
  await expect(settings.publish("4", {}, { kind: "rollback", targetConfigVersion: "1" })).rejects.toThrow("config_conflict");
});
test("published settings survive a lost commit reply followed by a confirmed Host restart", async () => {
  let hostVersion = "1";
  const settings = new MainSettings(file("settings.json"), {
    async prepare() {}, async abort() {},
    async commit() { throw new Error("old Host reply lost; new Host has no prepared token"); },
    async readVersion() { return hostVersion; },
  });
  settings.read();
  await expect(settings.publish("1", { model: { provider: "test", modelId: "text" } }, { kind: "model" })).rejects.toThrow("config_write_failed");
  // The restarted Host loaded the exact already-published file, without another publication.
  hostVersion = "2";
  expect((await settings.synchronize()).configVersion).toBe("2");
  expect((await settings.publish("2", { ui: { detailOpen: true } }, { kind: "ui" })).configVersion).toBe("3");
});

test("credential candidates publish under the Host gate and only confirmed unpublished files restore bindings", async () => {
  const credentials = new MainCredentials(file("credentials.enc.json"), protection());
  credentials.attachInstance("instance-a");
  const original = await credentials.begin("instance-a", { providerId: "test", context, expectedCredentialRef: null, operationId: "original" });
  await credentials.commit("instance-a", { leaseId: original.leaseId, expectedVersion: original.version, changed: true, next: { type: "api_key", key: "original-key" } });
  const oldBindings = credentials.captureRefs();
  let gated = false, failWrite = false, lostReply = false, restored = 0;
  const settings = new MainSettings(file("settings.json"), {
    async prepare() { gated = true; }, async abort() { gated = false; },
    async commit() { if (lostReply) throw new Error("commit reply lost"); gated = false; },
  }, (path, value) => { if (failWrite) throw new Error("file replacement denied"); atomicWriteJson(path, value); });
  settings.read();
  const publishCandidate = async (reference: string) => settings.publish("1", { credentialRefs: { test: reference } }, { kind: "custom",
    beforeWrite: async () => {
      expect(gated).toBe(true);
      const lease = await credentials.begin("instance-a", { providerId: "test", context, expectedCredentialRef: oldBindings.test!, operationId: reference });
      await credentials.commit("instance-a", { leaseId: lease.leaseId, expectedVersion: lease.version, changed: true, next: { type: "api_key", key: "candidate-key" } }, reference);
    },
    onUnpublished: async () => { restored++; await credentials.bindRefs(oldBindings); },
  });
  const orphan = crypto.randomUUID();
  failWrite = true;
  await expect(publishCandidate(orphan)).rejects.toThrow("config_write_failed");
  expect(settings.read().configVersion).toBe("1");
  expect(credentials.captureRefs()).toEqual(oldBindings);
  expect(await credentials.read("instance-a", { providerId: "test", context: { purpose: "runtime", operationRef: "orphan-lookup", credentialRef: orphan } })).toEqual({ type: "api_key", key: "candidate-key" });
  expect(gated).toBe(false);
  failWrite = false; lostReply = true;
  const published = crypto.randomUUID();
  await expect(publishCandidate(published)).rejects.toThrow("config_write_failed");
  expect(settings.read()).toMatchObject({ configVersion: "2", credentialRefs: { test: published } });
  expect(credentials.captureRefs()).toEqual({ test: published });
  expect(restored).toBe(1);
  lostReply = false;
  expect((await settings.synchronize()).configVersion).toBe("2");
});

test("UI synchronization shares the settings publication queue instead of racing Host preparation", async () => {
  let hostVersion = "1", prepares = 0, commits = 0;
  const settings = new MainSettings(file("settings.json"), {
    async readVersion() { return hostVersion; },
    async prepare() { prepares++; await Bun.sleep(20); },
    async commit(token, version) { commits++; hostVersion = version; }, async abort() {},
  });
  settings.read();
  await settings.publish("1", { ui: { detailOpen: true } }, { kind: "ui" });
  const synced = await Promise.all([settings.synchronize(), settings.synchronize()]);
  expect(synced.map(s => s.configVersion)).toEqual(["2", "2"]);
  expect([hostVersion, prepares, commits]).toEqual(["2", 1, 1]);
});

test("unconfirmed binding restoration retains the prepared Host gate until the same recovery succeeds", async () => {
  let gated = false, restorationFails = true, aborts = 0;
  const settings = new MainSettings(file("settings.json"), {
    async prepare() { gated = true; }, async commit() {}, async abort() { aborts++; gated = false; },
  });
  settings.read();
  await expect(settings.publish("1", { model: { provider: "test", modelId: "text" } }, { kind: "custom",
    beforeWrite: async () => { throw new Error("credential_write_failed"); },
    onUnpublished: async () => { if (restorationFails) throw new Error("credential_write_failed"); },
  })).rejects.toThrow("credential_write_failed");
  expect([gated, aborts, settings.read().configVersion]).toEqual([true, 0, "1"]);
  await expect(settings.publish("1", { ui: { detailOpen: true } }, { kind: "ui" })).rejects.toThrow("config_write_failed");
  restorationFails = false;
  expect((await settings.synchronize()).configVersion).toBe("1");
  expect([gated, aborts]).toEqual([false, 1]);
});

test("bad settings remain intact and a missing UI segment only takes defaults in the read projection", () => {
  const path = file("settings.json");
  const settings = new MainSettings(path);
  const initial = settings.read();
  const { ui, ...withoutUi } = initial;
  writeFileSync(path, JSON.stringify(withoutUi));
  expect(settings.read().ui).toEqual(ui);
  expect(readFileSync(path, "utf8")).toBe(JSON.stringify(withoutUi));
  writeFileSync(path, "broken-settings");
  expect(() => settings.read()).toThrow("config_read_failed");
  expect(readFileSync(path, "utf8")).toBe("broken-settings");
});
