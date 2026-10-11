import { expect, spyOn, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mergeRuntimeConfigurationPolicies } from '../../packages/contracts/src/runtime-config';

async function fixture(mode = "normal") {
  const root = mkdtempSync(join(tmpdir(), "medclaw P1 中文 -"));
  const entry = join(root, "host.ts");
  await Bun.write(entry, `import {createInterface} from "node:readline";import {appendFileSync} from "node:fs";
const mode=${JSON.stringify(mode)};const lines=createInterface({input:process.stdin});let hello,ready;const pending=new Map();
function send(value){process.stdout.write(JSON.stringify(value)+"\\n");}
function emitReady(){const text=JSON.stringify(ready)+"\\n";process.stdout.write(text.slice(0,17));setTimeout(()=>process.stdout.write(text.slice(17)),5);}
lines.on("line",line=>{const frame=JSON.parse(line);if(!hello){hello=frame;
if(process.env.AWS_MAX_ATTEMPTS!=="1"||process.env.MEDCLAW_INSTANCE_ID!==hello.instanceId||process.env.MEDCLAW_STARTUP_TOKEN!==hello.startupToken)process.exit(41);
ready={protocolVersion:hello.protocolVersion,instanceId:hello.instanceId,sdkVersion:hello.sdkVersion,schemaVersion:hello.expectedSchemaVersion,configVersion:"1",dataRoot:hello.paths.dataRoot};
if(mode==="wrong-instance")ready.instanceId="unrelated-instance";
if(mode==="wrong-protocol")ready.protocolVersion="unrelated-protocol";
if(mode==="wrong-sdk")ready.sdkVersion="0.0.0";
if(mode==="wrong-schema")ready.schemaVersion=999;
if(mode==="wrong-root")ready.dataRoot=hello.paths.databasePath;
if(mode==="oversized"){process.stdout.write("x".repeat(4*1024*1024+1));return;}
if(mode==="truncated"){process.stdout.write("{");setTimeout(()=>process.exit(0),5);return;}
if(mode==="invalid-utf8"){process.stdout.write(Buffer.from([255,10]));return;}
if(mode==="silence")return;
if(mode==="pre-ready"||mode==="invalid-private"){
for(const method of ["credential.read","credential.list"]){const requestId="initial-"+method;pending.set(requestId,{initial:true});send({protocolVersion:hello.protocolVersion,kind:"private",instanceId:hello.instanceId,requestId,secret:mode!=="invalid-private",method,payload:method==="credential.read"?{providerId:"p1-offline",context:{purpose:"runtime",operationRef:"catalog"}}:{}});}return;}
emitReady();return;}
if(frame.kind==="private"){const request=pending.get(frame.requestId);if(!request||!frame.result.ok)process.exit(42);pending.delete(frame.requestId);if(request.initial){if(!pending.size)emitReady();return;}if(frame.result.data!==null)process.exit(42);
const reply={protocolVersion:hello.protocolVersion,kind:"reply",instanceId:hello.instanceId,requestId:request.requestId,result:{ok:true,data:{providers:[],models:[],configVersion:"1",selection:null,customApis:[]}}};
if(mode==="duplicate"){process.stdout.write([reply,reply,{...reply,requestId:"unknown-reply"}].map(value=>JSON.stringify(value)+"\\n").join(""));return;}
if(mode==="preview"){for(let i=0;i<64;i++)send({protocolVersion:hello.protocolVersion,kind:"notice",instanceId:hello.instanceId,notice:{type:"provider.preview",runId:1,text:"preview-"+i,truncated:false}});setTimeout(()=>send({protocolVersion:hello.protocolVersion,kind:"notice",instanceId:hello.instanceId,notice:{type:"provider.settled",runId:1}}),80);}
send(reply);return;}
if(frame.method==="host.shutdown"){send({protocolVersion:hello.protocolVersion,kind:"reply",instanceId:hello.instanceId,requestId:frame.requestId,result:{ok:true,data:{executionStopped:true,databaseClosed:true}}});if(mode!=="ack-without-exit")setTimeout(()=>process.exit(0),5);return;}
if(mode==="lost-reply"&&["model.list","session.messages.read","session.readSubmission","session.create"].includes(frame.method)){appendFileSync(${JSON.stringify(join(root, "received.jsonl"))},JSON.stringify(frame)+"\\n");return;}
if(frame.method==="model.list"){const requestId="private-"+frame.requestId;pending.set(requestId,frame);send({protocolVersion:hello.protocolVersion,kind:"private",instanceId:hello.instanceId,requestId,secret:true,method:"credential.read",payload:{providerId:"p1-offline",context:{purpose:"runtime",operationRef:frame.operationRef}}});}
});lines.on("close",()=>process.exit(0));`);
  return { root, entry };
}

test("controlled Host authenticates its split ready, routes private frames and confirms actual exit", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const { root, entry } = await fixture();
  const events: string[] = [];
  const calls: string[] = [];
  const host = new HostController({
    dataRoot: root, hostEntry: entry, bunExecutable: process.execPath,
    onStarting: instance => events.push(`start:${instance}`), onExit: instance => events.push(`exit:${instance}`),
    onCredentialRequest: async frame => { calls.push(frame.requestId); return { ok: true, data: null }; },
  });
  try {
    expect(host.read()).toMatchObject({ state: "stopped", canStart: true });
    expect((await host.request("model.list", {})).ok).toBe(false);
    expect(await host.start()).toMatchObject({ state: "ready", error: null });
    const instance = host.read().instanceId!;
    expect(host.paths.databasePath).toBe(join(root, "data/app.sqlite"));
    expect(host.paths.lockPath).toBe(join(root, "runtime/host.lock"));
    const replies = await Promise.all([host.request("model.list", {}, "op-a", "req-a"), host.request("model.list", {}, "op-b", "req-b")]);
    expect(replies.every(reply => reply.ok)).toBe(true);
    expect(calls).toEqual(["private-req-a", "private-req-b"]);
    await expect(host.stop("unrelated-instance")).rejects.toThrow();
    expect(host.read()).toMatchObject({ state: "ready", instanceId: instance, canStart: false });
    expect((await host.stop(instance)).state).toBe("stopped");
    expect(events).toEqual([`start:${instance}`, `exit:${instance}`]);
    expect(host.read().canStart).toBe(true);
    expect((await host.start()).state).toBe("ready");
    const second = host.read().instanceId!;
    await Promise.all([host.restart(second), host.stop(second)]);
    expect(host.read()).toMatchObject({ state: "ready", canStart: false, error: null });
    expect(host.read().instanceId).not.toBe(second);
    expect(events).toEqual([`start:${instance}`, `exit:${instance}`, `start:${second}`, `exit:${second}`, `start:${host.read().instanceId}`]);
  } finally {
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("wrong ready identity and oversized incomplete frames fail and cannot adopt another process", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  for (const mode of ["wrong-instance", "wrong-protocol", "wrong-sdk", "wrong-schema", "wrong-root", "invalid-private", "oversized", "invalid-utf8", "truncated"]) {
    const { root, entry } = await fixture(mode);
    const exited: string[] = [];
    const stopping: boolean[] = [];
    const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath, onExit: instance => exited.push(instance), onNotice: notice => { if (notice.type === "host.status" && notice.host.state === "stopping") stopping.push(notice.host.canStart); } });
    try {
      expect((await host.start()).state).toBe("failed");
      expect(host.read().error?.code).toBe(mode === "oversized" ? "frame_too_large" : mode === "truncated" ? "invalid_frame" : "host_protocol_mismatch");
      expect(host.read().canStart).toBe(true);
      expect(exited).toHaveLength(1);
      expect(stopping).toEqual([false]);
      expect((await host.request("model.list", {})).ok).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 30000);

test("actual Host can request Main credentials before ready and restarts only after its writer exits", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const { MainCredentials } = await import("../../apps/desktop/src/main/credentials");
  const { MainSettings } = await import("../../apps/desktop/src/main/settings");
  const root = mkdtempSync(join(tmpdir(), "medclaw-p1-real-host-"));
  const credentials = new MainCredentials(join(root, "data/credentials.enc.json"), {
    isEncryptionAvailable: () => true,
    encryptString: () => { throw new Error("Catalog startup must not write credentials"); },
    decryptString: () => { throw new Error("The isolated credential file is absent"); },
  });
  const calls: string[] = [];
  const host = new HostController({
    dataRoot: root, hostEntry: join(import.meta.dir, "../../apps/host/src/main.ts"), bunExecutable: process.execPath,
    onStarting: instance => credentials.attachInstance(instance), onExit: instance => credentials.confirmHostExit(instance),
    onCredentialRequest: async frame => {
      if (frame.method === 'export.destination.settlePrevious') return { ok: true, data: { stopped: true } };
      calls.push(frame.method);
      if (frame.method === "credential.read") return { ok: true, data: await credentials.read(frame.instanceId, frame.payload) };
      if (frame.method === "credential.list") return { ok: true, data: await credentials.list(frame.instanceId) };
      throw new Error("Unexpected credential mutation during catalog startup");
    },
  });
  try {
    new MainSettings(host.paths.settingsPath).read();
    expect(await host.start()).toMatchObject({ state: "ready", error: null });
    expect(calls.length).toBeGreaterThan(0);
    const instance = host.read().instanceId!;
    const lock = JSON.parse(readFileSync(host.paths.lockPath, "utf8"));
    expect(lock.instanceId).toBe(instance);
    expect(lock.startupToken.length).toBeGreaterThan(0);
    const directory = await host.request("model.list", {});
    expect(directory).toMatchObject({ ok: true });
    if (directory.ok) expect((directory.data as { models: unknown[] }).models.length).toBeGreaterThan(0);
    expect((await host.stop(instance)).state).toBe("stopped");
    expect(existsSync(host.paths.lockPath)).toBe(false);
    expect((await host.start()).state).toBe("ready");
    expect(host.read().instanceId).not.toBe(instance);
  } finally {
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    rmSync(root, { recursive: true, force: true });
  }
}, 40000);

test("handshake routes strictly validated credentials before ready without changing the parent environment", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const { root, entry } = await fixture("pre-ready");
  const environment = process.env.AWS_MAX_ATTEMPTS;
  const calls: string[] = [];
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath, onCredentialRequest: async frame => {
    expect(host.read()).toMatchObject({ state: "handshaking", canStart: false });
    calls.push(frame.method); return { ok: true, data: frame.method === "credential.list" ? [] : null };
  } });
  try {
    expect(await host.start()).toMatchObject({ state: "ready", error: null });
    expect(calls).toEqual(["credential.read", "credential.list"]);
    expect(process.env.AWS_MAX_ATTEMPTS).toBe(environment);
    const child = (host as unknown as { child: ChildProcessWithoutNullStreams }).child;
    expect(child.spawnargs).toContain("--no-env-file");
  } finally {
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("actual Host rejects a wrong startup token and rechecks a lock created after Main preflight", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const { MainSettings } = await import("../../apps/desktop/src/main/settings");
  let deadPid = 0;
  for (const mode of ["wrong-token", "lock-race", "malformed-dead-lock"]) {
    const root = mkdtempSync(join(tmpdir(), "medclaw-p1-startup-reject-"));
    const entry = join(root, "entry.ts");
    const lock = mode === "malformed-dead-lock" ? JSON.stringify({ pid: deadPid }) : JSON.stringify({ pid: process.pid, instanceId: "unrelated-writer", startupToken: "unrelated-token" });
    const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath,
      onStarting: () => {
        const pid = (host as unknown as { child: ChildProcessWithoutNullStreams }).child.pid!;
        if (mode === "wrong-token") deadPid = pid;
        if (mode === "malformed-dead-lock") expect(pid).not.toBe(deadPid);
      },
    });
    try {
      new MainSettings(host.paths.settingsPath).read();
      await Bun.write(entry, `${mode === "wrong-token" ? 'process.env.MEDCLAW_STARTUP_TOKEN="wrong-token";' : `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(host.paths.lockPath)},${JSON.stringify(lock)});`}
await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../apps/host/src/main.ts")).href)});`);
      expect(host.read().canStart).toBe(true);
      if (mode === "malformed-dead-lock") expect(() => process.kill(deadPid, 0)).toThrow();
      expect(await host.start()).toMatchObject({ state: "failed", canStart: mode === "wrong-token" });
      expect(existsSync(host.paths.databasePath)).toBe(false);
      if (mode !== "wrong-token") expect(readFileSync(host.paths.lockPath, "utf8")).toBe(lock);
      if (mode === "lock-race") expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally {
      if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 20000);

test("actual Host recovers an interrupted slow Run only after its owned writer exits without HTTP resend", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const { MainSettings, atomicWriteJson } = await import("../../apps/desktop/src/main/settings");
  const { PublishedSettingsSchema } = await import("../../packages/contracts/src/model");
  const { ReadRunResultSchema } = await import("../../packages/contracts/src/run");
  const { Database } = await import("bun:sqlite");
  const { providerFixture } = await import("../fixtures/p1-provider");
  const root = mkdtempSync(join(tmpdir(), "medclaw-p1-host-interruption-"));
  const service = providerFixture("slow");
  const exits: string[] = [];
  const host = new HostController({ dataRoot: root, hostEntry: join(import.meta.dir, "../../apps/host/src/main.ts"), bunExecutable: process.execPath,
    onExit: instance => exits.push(instance),
    onCredentialRequest: async frame => {
      if (frame.method === 'export.destination.settlePrevious') return { ok: true, data: { stopped: true } };
      if (frame.method === "credential.list") return { ok: true, data: [{ providerId: "p1-fixture", type: "api_key" }] };
      if (frame.method === "credential.read") return { ok: true, data: frame.payload.providerId === "p1-fixture" ? { type: "api_key", key: "fixture-only" } : null };
      throw new Error("Unexpected credential mutation in interruption fixture");
    },
  });
  try {
    const initial = new MainSettings(host.paths.settingsPath).read();
    const definition = { providerId: "p1-fixture", name: "Fixture", api: "openai-completions", baseUrl: service.url,
      models: [{ id: "fixture", name: "Fixture", input: ["text"], reasoning: false, contextWindow: 8192, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }],
    };
    atomicWriteJson(host.paths.settingsPath, PublishedSettingsSchema.parse({ ...initial, model: { provider: "p1-fixture", modelId: "fixture" },
      customProviders: [{ definition, credentialRef: null }], ...mergeRuntimeConfigurationPolicies(initial, { requestPolicy: { ...initial.requestPolicy, timeoutMs: 30000 } }),
    }));
    expect(await host.start()).toMatchObject({ state: "ready", error: null });
    const oldInstance = host.read().instanceId!;
    const accepted = await host.request("model.request", { text: "Interruption fixture only", model: { provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "1" }, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" }, "owned-interrupted-operation");
    expect(accepted).toMatchObject({ ok: true });
    if (!accepted.ok) throw new Error("Fixture Run was not accepted");
    const { runId } = accepted.data as { runId: number };
    await Promise.race([service.requested, Bun.sleep(4000).then(() => { throw new Error("Native fixture HTTP request did not arrive"); })]);
    expect(service.requests).toHaveLength(1);
    expect(service.requests[0]).toMatchObject({ method: "POST", body: { model: "fixture" } });
    expect(await host.request("run.read", { runId })).toMatchObject({ ok: true, data: { kind: "one", run: { id: runId, status: "running", calls: [{ state: "started" }] } } });
    const child = (host as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const lock = JSON.parse(readFileSync(host.paths.lockPath, "utf8"));
    expect(lock).toMatchObject({ instanceId: oldInstance, pid: child.pid });
    expect(lock.startupToken.length).toBeGreaterThan(0);
    const closed = new Promise<void>(resolve => child.once("close", resolve));
    expect(child.kill("SIGKILL")).toBe(true);
    await closed;
    expect(host.read()).toMatchObject({ state: "failed", canStart: true, error: { code: "host_interrupted" } });
    expect(exits).toEqual([oldInstance]);
    expect(await host.restart(oldInstance)).toMatchObject({ state: "ready", error: null });
    const newInstance = host.read().instanceId!;
    expect(newInstance).not.toBe(oldInstance);
    const reply = await host.request("run.read", { runId });
    expect(reply).toMatchObject({ ok: true });
    if (!reply.ok) throw new Error("Recovered Run could not be read");
    const result = ReadRunResultSchema.parse(reply.data);
    expect(result).toMatchObject({ kind: "one", run: { id: runId, instanceId: oldInstance, operationRef: "owned-interrupted-operation", status: "failed", cancelRequestedAt: null, stoppedAt: null,
      error: { code: "host_interrupted", reason: "host_interrupted" }, output: { text: "", totalChars: 0 },
      calls: [{ state: "failed", error: { code: "host_interrupted" }, unavailableReason: "host_interrupted", endedAt: null, durationMs: null, inputTokens: null, outputTokens: null }],
    } });
    expect(await host.request("run.active", {})).toEqual({ ok: true, data: null });
    expect(service.requests).toHaveLength(1);
    expect(await host.stop(newInstance)).toMatchObject({ state: "stopped", canStart: true });
    expect(exits).toEqual([oldInstance, newInstance]);
    expect(existsSync(host.paths.lockPath)).toBe(false);
    // Read persisted cleanup only after the real Host has closed its database.
    const database = new Database(host.paths.databasePath, { readonly: true });
    try {
      const row = database.query<{ cleanup_json: string }, [number]>("SELECT cleanup_json FROM runs WHERE id=?").get(runId);
      expect(row).not.toBeNull();
      expect(JSON.parse(row!.cleanup_json)).toMatchObject({ contract: "medclaw.run-cleanup/v1", executionStarted: null, stopConfirmed: true,
        requiredPersistenceComplete: true, inputsSettled: true, resourcesReleased: true, unconfirmedItems: [], secondaryErrors: [] });
      expect(JSON.parse(row!.cleanup_json).verifiedAt).toBeString();
    } finally { database.close(); }
    expect(service.requests).toHaveLength(1);
  } finally {
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    service.close(); rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("duplicate and unknown replies are safe diagnostics and preview delivery does not terminate Host", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  for (const mode of ["duplicate", "preview"]) {
    const { root, entry } = await fixture(mode);
    const errors: string[] = [], previews: string[] = [], settled: number[] = [];
    const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath,
      onCredentialRequest: async () => ({ ok: true, data: null }), onError: error => errors.push(error.code),
      onNotice: notice => {
        if (notice.type === "provider.preview") { previews.push(notice.text); throw new Error("Secret native delivery failure must not cross the boundary"); }
        if (notice.type === "provider.settled") settled.push(notice.runId);
      },
    });
    try {
      expect((await host.start()).state).toBe("ready");
      expect((await host.request("model.list", {})).ok).toBe(true);
      await Bun.sleep(150);
      expect(host.read()).toMatchObject({ state: "ready", error: null });
      expect(errors).toEqual(mode === "duplicate" ? ["invalid_frame", "invalid_frame"] : ["preview_delivery_failed"]);
      if (mode === "preview") { expect(previews).toEqual(["preview-63"]); expect(settled).toEqual([1]); }
    } finally {
      if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 20000);

test("actual Host orderly shutdown aborts native retry wait and restart never repeats its request", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const { MainSettings, atomicWriteJson } = await import("../../apps/desktop/src/main/settings");
  const { PublishedSettingsSchema } = await import("../../packages/contracts/src/model");
  const { providerFixture } = await import("../fixtures/p1-provider");
  const root = mkdtempSync(join(tmpdir(), "medclaw-p1-host-retry-shutdown-"));
  const service = providerFixture("retry"), exits: string[] = [];
  const host = new HostController({ dataRoot: root, hostEntry: join(import.meta.dir, "../../apps/host/src/main.ts"), bunExecutable: process.execPath,
    onExit: instance => exits.push(instance), onCredentialRequest: async frame => {
      if (frame.method === 'export.destination.settlePrevious') return { ok: true, data: { stopped: true } };
      if (frame.method === "credential.list") return { ok: true, data: [{ providerId: "p1-fixture", type: "api_key" }] };
      if (frame.method === "credential.read") return { ok: true, data: frame.payload.providerId === "p1-fixture" ? { type: "api_key", key: "fixture-only" } : null };
      throw new Error("Unexpected credential mutation in retry shutdown fixture");
    },
  });
  try {
    const initial = new MainSettings(host.paths.settingsPath).read();
    atomicWriteJson(host.paths.settingsPath, PublishedSettingsSchema.parse({ ...initial, model: { provider: "p1-fixture", modelId: "fixture" },
      customProviders: [{ credentialRef: null, definition: { providerId: "p1-fixture", name: "Fixture", api: "openai-completions", baseUrl: service.url,
        models: [{ id: "fixture", name: "Fixture", input: ["text"], reasoning: false, contextWindow: 8192, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }],
      } }], ...mergeRuntimeConfigurationPolicies(initial, { requestPolicy: { timeoutMs: 30000, maxRetries: 1, maxRetryDelayMs: 2000 } }),
    }));
    expect(await host.start()).toMatchObject({ state: "ready", error: null });
    const oldInstance = host.read().instanceId!;
    const accepted = await host.request("model.request", { text: "Retry shutdown fixture only", model: { provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "1" }, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" }, "owned-retry-shutdown-operation");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("Fixture Run was not accepted");
    const { runId } = accepted.data as { runId: number };
    await Promise.race([service.requested, Bun.sleep(4000).then(() => { throw new Error("Native fixture HTTP request did not arrive"); })]);
    await Bun.sleep(75); // The server returned 503 with Retry-After: 1; stop inside that wait.
    expect(service.requests).toHaveLength(1);
    expect(await host.request("run.active", {})).toMatchObject({ ok: true, data: { runId, stopPending: false, persistencePending: false } });
    const child = (host as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const lock = JSON.parse(readFileSync(host.paths.lockPath, "utf8"));
    expect(lock).toMatchObject({ instanceId: oldInstance, pid: child.pid });
    expect(await host.stop(oldInstance)).toMatchObject({ state: "stopped", canStart: true, error: null });
    expect(child.exitCode).toBe(0);
    expect(exits).toEqual([oldInstance]);
    expect(existsSync(host.paths.lockPath)).toBe(false);
    expect(service.requests).toHaveLength(1);
    expect(await host.start()).toMatchObject({ state: "ready", error: null });
    expect(host.read().instanceId).not.toBe(oldInstance);
    expect(await host.request("run.read", { runId })).toMatchObject({ ok: true, data: { kind: "one", run: {
      id: runId, instanceId: oldInstance, status: "failed", cancelRequestedAt: null, stoppedAt: expect.any(String), endedAt: expect.any(String),
      error: { code: "host_interrupted" }, calls: [{ state: "cancelled", sdkStopReason: "aborted", endedAt: expect.any(String) }],
    } } });
    expect(await host.request("run.active", {})).toEqual({ ok: true, data: null });
    await Bun.sleep(1000);
    expect(service.requests).toHaveLength(1);
  } finally {
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    service.close(); rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("Host startup refuses an unavailable data directory without overwriting the obstruction", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const root = mkdtempSync(join(tmpdir(), "medclaw-p1-unavailable-data-path-"));
  try {
    const blocked = join(root, "data");
    await Bun.write(blocked, "owned fixture obstruction");
    expect(() => new HostController({ dataRoot: root, hostEntry: join(import.meta.dir, "../../apps/host/src/main.ts"), bunExecutable: process.execPath })).toThrow();
    expect(readFileSync(blocked, "utf8")).toBe("owned fixture obstruction");
    expect(existsSync(join(root, "runtime/host.lock"))).toBe(false);
    expect(existsSync(join(root, "data/app.sqlite"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actual Host keeps a failed required save closed through forced shutdown and recovers without HTTP resend", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const { MainSettings, atomicWriteJson } = await import("../../apps/desktop/src/main/settings");
  const { PublishedSettingsSchema } = await import("../../packages/contracts/src/model");
  const { Database } = await import("bun:sqlite");
  const { providerFixture } = await import("../fixtures/p1-provider");
  const root = mkdtempSync(join(tmpdir(), "medclaw-p1-host-required-save-shutdown-"));
  const service = providerFixture("slow"), exits: string[] = [];
  let failed!: (runId: number) => void, obstruction: InstanceType<typeof Database> | null = null;
  const persistenceFailed = new Promise<number>(resolve => { failed = resolve; });
  const host = new HostController({ dataRoot: root, hostEntry: join(import.meta.dir, "../../apps/host/src/main.ts"), bunExecutable: process.execPath,
    onExit: instance => exits.push(instance), onNotice: notice => { if (notice.type === "provider.persistence_failed") failed(notice.runId); },
    onCredentialRequest: async frame => {
      if (frame.method === 'export.destination.settlePrevious') return { ok: true, data: { stopped: true } };
      if (frame.method === "credential.list") return { ok: true, data: [{ providerId: "p1-fixture", type: "api_key" }] };
      if (frame.method === "credential.read") return { ok: true, data: frame.payload.providerId === "p1-fixture" ? { type: "api_key", key: "fixture-only" } : null };
      throw new Error("Unexpected credential mutation in required save fixture");
    },
  });
  try {
    const initial = new MainSettings(host.paths.settingsPath).read();
    atomicWriteJson(host.paths.settingsPath, PublishedSettingsSchema.parse({ ...initial, model: { provider: "p1-fixture", modelId: "fixture" },
      customProviders: [{ credentialRef: null, definition: { providerId: "p1-fixture", name: "Fixture", api: "openai-completions", baseUrl: service.url,
        models: [{ id: "fixture", name: "Fixture", input: ["text"], reasoning: false, contextWindow: 8192, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }],
      } }], ...mergeRuntimeConfigurationPolicies(initial, { requestPolicy: { ...initial.requestPolicy, timeoutMs: 30000 } }),
    }));
    expect(await host.start()).toMatchObject({ state: "ready", error: null });
    const oldInstance = host.read().instanceId!;
    const accepted = await host.request("model.request", { text: "Required save fault fixture only", model: { provider: "p1-fixture", modelId: "fixture", expectedConfigVersion: "1" }, referenceDate: "2026-10-01", timezone: "Asia/Shanghai" }, "owned-required-save-operation");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("Fixture Run was not accepted");
    const { runId } = accepted.data as { runId: number };
    await Promise.race([service.requested, Bun.sleep(4000).then(() => { throw new Error("Native fixture HTTP request did not arrive"); })]);
    // This external writer exists only as an isolated fault fixture, never as a product writer.
    obstruction = new Database(host.paths.databasePath); obstruction.exec("BEGIN IMMEDIATE");
    expect(await Promise.race([persistenceFailed, Bun.sleep(10000).then(() => { throw new Error("Required save did not report failure"); })])).toBe(runId);
    expect(service.requests).toHaveLength(1);
    expect(await host.request("run.active", {})).toMatchObject({ ok: true, data: { runId, persistencePending: true, stopPending: false } });
    expect(await host.request("run.read", { runId })).toMatchObject({ ok: true, data: { kind: "one", run: { status: "running", calls: [{ state: "started" }] } } });
    obstruction.exec("ROLLBACK"); obstruction.close(); obstruction = null;
    const child = (host as unknown as { child: ChildProcessWithoutNullStreams }).child;
    expect(JSON.parse(readFileSync(host.paths.lockPath, "utf8"))).toMatchObject({ pid: child.pid, instanceId: oldInstance });
    const stopped = host.stop(oldInstance);
    expect(host.read()).toMatchObject({ state: "stopping", canStart: false });
    await expect(host.start()).rejects.toThrow("runtime_busy");
    expect((await host.request("model.list", {})).ok).toBe(false);
    await Bun.sleep(100);
    expect(exits).toEqual([]);
    expect(host.read()).toMatchObject({ state: "stopping", canStart: false });
    // No implicit retrySave: shutdown rejects the unsaved fact. Main's timeout then
    // terminates only this owned child; its in-memory native success cannot be recovered.
    expect(await stopped).toMatchObject({ state: "stopped", canStart: true });
    expect(exits).toEqual([oldInstance]);
    expect(child.exitCode === null && child.signalCode === null).toBe(false);
    expect(await host.start()).toMatchObject({ state: "ready", error: null });
    expect(host.read().instanceId).not.toBe(oldInstance);
    expect(await host.request("run.read", { runId })).toMatchObject({ ok: true, data: { kind: "one", run: {
      id: runId, status: "failed", instanceId: oldInstance, stoppedAt: null, error: { code: "host_interrupted" }, output: { text: "" },
      calls: [{ state: "failed", sdkStopReason: null, endedAt: null, inputTokens: null, outputTokens: null, unavailableReason: "host_interrupted" }],
    } } });
    expect(await host.request("run.active", {})).toEqual({ ok: true, data: null });
    expect(service.requests).toHaveLength(1);
  } finally {
    if (obstruction) { obstruction.exec("ROLLBACK"); obstruction.close(); }
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    service.close(); rmSync(root, { recursive: true, force: true });
  }
}, 40000);

test("pending commands stay bounded and a lost reply reports the original operation unknown without retransmission", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const { root, entry } = await fixture("lost-reply");
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath });
  try {
    expect((await host.start()).state).toBe("ready");
    const requests = Array.from({ length: 256 }, (_, i) => host.request("model.list", {}, `original-op-${i}`, `request-${i}`));
    expect(await host.request("model.list", {}, "overflow-op")).toMatchObject({ ok: false, error: { code: "runtime_busy", operationRef: "overflow-op" } });
    await expect(host.request("model.list", {}, "another-op", "request-0")).rejects.toThrow("state_conflict");
    const results = await Promise.all(requests);
    results.forEach((result, i) => expect(result).toMatchObject({ ok: false, error: { code: "host_not_ready", operationRef: `original-op-${i}` } }));
    const received = readFileSync(join(root, "received.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { operationRef: string });
    expect(received).toHaveLength(256);
    expect(new Set(received.map(frame => frame.operationRef)).size).toBe(256);
    expect(host.read()).toMatchObject({ state: "ready", canStart: false });
    expect((host as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  } finally {
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);

test("reader lost replies and rejected pipe writes preserve readonly errors without retrying", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const { root, entry } = await fixture("lost-reply"), host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath });
  try {
    expect((await host.start()).state).toBe("ready");
    const replies = await Promise.all([host.request("session.messages.read", { sessionId: 1 }, "messages-timeout"), host.request("session.readSubmission", { sessionId: 1, clientSequence: 1 }, "lookup-timeout"), host.request("session.create", { expectedWorkspaceRevision: 0 }, "write-timeout")]);
    expect(replies).toMatchObject([{ ok: false, error: { code: "host_not_ready", operationRef: "messages-timeout" } }, { ok: false, error: { code: "host_not_ready", operationRef: "lookup-timeout" } }, { ok: false, error: { code: "operation_result_unknown", operationRef: "write-timeout" } }]);
    expect(readFileSync(join(root, "received.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
    const child = (host as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const write = spyOn(child.stdin, "write").mockImplementation((...args: unknown[]) => { const callback = args.at(-1) as (error: Error) => void; queueMicrotask(() => callback(new Error("fixture rejected write"))); return true; });
    try {
      expect(await host.request("session.messages.read", { sessionId: 1 }, "messages-write-reject")).toMatchObject({ ok: false, error: { code: "host_interrupted" } });
      expect(await host.request("session.readSubmission", { sessionId: 1, clientSequence: 1 }, "lookup-write-reject")).toMatchObject({ ok: false, error: { code: "host_interrupted" } });
      expect(await host.request("session.create", { expectedWorkspaceRevision: 0 }, "mutation-write-reject")).toMatchObject({ ok: false, error: { code: "operation_result_unknown" } });
    } finally { write.mockRestore(); }
    expect((host as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
    expect(readFileSync(join(root, "received.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
  } finally { if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!); rmSync(root, { recursive: true, force: true }); }
}, 25000);

test("a silent handshake times out once and only confirmed close makes a failed Host startable", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const { root, entry } = await fixture("silence");
  const events: string[] = [];
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath,
    onStarting: instance => events.push(`start:${instance}`), onExit: instance => events.push(`exit:${instance}`),
  });
  try {
    expect(await host.start()).toMatchObject({ state: "failed", canStart: true, error: { code: "host_start_failed" } });
    expect(events).toEqual([`start:${host.read().instanceId}`, `exit:${host.read().instanceId}`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 75000);

test("shutdown acknowledgement never substitutes for exit and an unconfirmed owned child blocks a second writer", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const { root, entry } = await fixture("ack-without-exit");
  const exited: string[] = [];
  const host = new HostController({ dataRoot: root, hostEntry: entry, bunExecutable: process.execPath, onExit: instance => exited.push(instance) });
  let child: ChildProcessWithoutNullStreams | null = null, kill: ChildProcessWithoutNullStreams["kill"] | null = null;
  try {
    expect((await host.start()).state).toBe("ready");
    child = (host as unknown as { child: ChildProcessWithoutNullStreams }).child;
    kill = child.kill.bind(child);
    // Inject a refused termination; the subprocess and its exit events remain real.
    child.kill = () => false;
    const stopped = host.stop(host.read().instanceId!);
    await Bun.sleep(100);
    expect(host.read()).toMatchObject({ state: "stopping", canStart: false });
    expect((await host.request("model.list", {})).ok).toBe(false);
    expect(await stopped).toMatchObject({ state: "stopping", canStart: false, error: { code: "host_stop_unconfirmed" } });
    await expect(host.start()).rejects.toThrow("runtime_busy");
    expect(exited).toEqual([]);
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
  } finally {
    if (child && kill) { child.kill = kill; const closed = new Promise<void>(resolve => child!.once("close", resolve)); kill(); await closed; }
    expect(host.read().canStart).toBe(true);
    expect(exited).toEqual([host.read().instanceId!]);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("writer_ownership_is_not_pid_only refuses a live unrelated lock without adopting or killing its PID", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const { MainSettings } = await import("../../apps/desktop/src/main/settings");
  const root = mkdtempSync(join(tmpdir(), "medclaw-p1-unrelated-writer-"));
  const host = new HostController({ dataRoot: root, hostEntry: join(import.meta.dir, "../../apps/host/src/main.ts"), bunExecutable: process.execPath });
  try {
    new MainSettings(host.paths.settingsPath).read();
    const unrelated = JSON.stringify({ pid: process.pid, instanceId: "unrelated-writer", startupToken: "unrelated-token" });
    await Bun.write(host.paths.lockPath, unrelated);
    expect(host.read().canStart).toBe(false);
    expect(await host.start()).toMatchObject({ state: "failed", canStart: false, error: { code: "host_stop_unconfirmed" } });
    expect(readFileSync(host.paths.lockPath, "utf8")).toBe(unrelated);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    await Bun.write(host.paths.lockPath, "not a lock identity");
    expect(host.read().canStart).toBe(false);
    expect(await host.start()).toMatchObject({ state: "failed", canStart: false, error: { code: "host_stop_unconfirmed" } });
    expect(readFileSync(host.paths.lockPath, "utf8")).toBe("not a lock identity");
  } finally {
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("actual Host invalid UTF8 input is rejected before it can become a replacement-character command", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const { MainSettings } = await import("../../apps/desktop/src/main/settings");
  const { HOST_PROTOCOL_VERSION } = await import("../../packages/contracts/src/protocol");
  const root = mkdtempSync(join(tmpdir(), "medclaw-p1-host-utf8-"));
  const host = new HostController({ dataRoot: root, hostEntry: join(import.meta.dir, "../../apps/host/src/main.ts"), bunExecutable: process.execPath,
    onCredentialRequest: async frame => ({ ok: true, data: frame.method === 'export.destination.settlePrevious' ? { stopped: true } : frame.method === "credential.list" ? [] : null }),
  });
  try {
    new MainSettings(host.paths.settingsPath).read();
    expect((await host.start()).state).toBe("ready");
    const child = (host as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const marker = Buffer.from("utf8-marker");
    const line = Buffer.from(`${JSON.stringify({ protocolVersion: HOST_PROTOCOL_VERSION, kind: "request", instanceId: host.read().instanceId, requestId: "invalid-utf8-request", operationRef: "invalid-utf8-operation", method: "model.auth.status", payload: { providerId: marker.toString() } })}\n`);
    const offset = line.indexOf(marker);
    const closed = new Promise<boolean>(resolve => child.once("close", () => resolve(true)));
    child.stdin.write(Buffer.concat([line.subarray(0, offset), Buffer.from([255]), line.subarray(offset)]));
    expect(await Promise.race([closed, Bun.sleep(5000).then(() => false)])).toBe(true);
    expect(child.exitCode).toBe(1);
    expect(host.read()).toMatchObject({ state: "failed", canStart: true });
    expect(existsSync(host.paths.lockPath)).toBe(false);
  } finally {
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test("actual Host duplicate shutdown commands share one application and database close", async () => {
  const { HostController } = await import("../../apps/desktop/src/main/host-controller");
  const { MainSettings } = await import("../../apps/desktop/src/main/settings");
  const root = mkdtempSync(join(tmpdir(), "medclaw-p1-host-shutdown-"));
  const host = new HostController({ dataRoot: root, hostEntry: join(import.meta.dir, "../../apps/host/src/main.ts"), bunExecutable: process.execPath,
    onCredentialRequest: async frame => ({ ok: true, data: frame.method === 'export.destination.settlePrevious' ? { stopped: true } : frame.method === "credential.list" ? [] : null }),
  });
  try {
    new MainSettings(host.paths.settingsPath).read();
    expect((await host.start()).state).toBe("ready");
    const child = (host as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const closed = new Promise<void>(resolve => child.once("close", resolve));
    const payload = { expectedInstanceId: host.read().instanceId! };
    const replies = await Promise.all([host.request("host.shutdown", payload, "shutdown-op-a"), host.request("host.shutdown", payload, "shutdown-op-b")]);
    replies.forEach(reply => expect(reply).toMatchObject({ ok: true, data: { executionStopped: true, databaseClosed: true } }));
    await closed;
    expect(child.exitCode).toBe(0);
    expect(existsSync(host.paths.lockPath)).toBe(false);
  } finally {
    if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!);
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
