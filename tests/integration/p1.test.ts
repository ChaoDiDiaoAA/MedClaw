import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { _electron } from "@playwright/test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, createProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AuthInteraction, CredentialStore, Model, ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { getApiProvider, getApiProviders } from "@earendil-works/pi-ai/compat";

type PiProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const offlineModel: Model<Api> = {
  id: "offline", name: "Offline probe", provider: "p1-offline", api: "p1-offline-api",
  baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024, cost,
};
function jsonModelsStore(path: string): ModelsStore {
  const read = (): Record<string, ModelsStoreEntry> => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return {
    read: async provider => read()[provider],
    write: async (provider, entry) => { await Bun.write(path, JSON.stringify({ ...read(), [provider]: entry })); },
    delete: async provider => { const entries = read(); delete entries[provider]; await Bun.write(path, JSON.stringify(entries)); },
  };
}
function cachedProvider() {
  const noRequest = () => { throw new Error("Cache probe must not dispatch a model request"); };
  return createProvider({
    id: offlineModel.provider, models: [],
    auth: { apiKey: { name: "Offline", check: async () => undefined, resolve: async () => undefined } },
    api: { stream: noRequest, streamSimple: noRequest },
    fetchModels: async () => { throw new Error("Cache probe must not refresh over the network"); },
  });
}

test("sdk_public_surface_0871", async () => {
  const credentials: CredentialStore = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  expect(runtime.getProviders().length).toBeGreaterThan(0);
  expect(runtime.getModels().length).toBeGreaterThan(0);
  expect(runtime.getModels().some(model => Number.isInteger(model.maxTokens) && model.maxTokens > 0)).toBe(true);
  expect(getApiProviders().length).toBeGreaterThan(0);
  expect(getApiProvider("openai-completions")).toBeDefined();
  expect(getApiProvider("p1-unknown-api")).toBeUndefined();
  expect(runtime.getError()).toBeUndefined();
  expect(await credentials.list()).toEqual([]);

  let observedMaxTokens: number | undefined;
  const config: PiProviderConfig = {
    name: "Offline probe", api: offlineModel.api, baseUrl: offlineModel.baseUrl,
    models: [offlineModel],
    streamSimple: (model, _context, options) => {
      observedMaxTokens = options?.maxTokens;
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "offline" }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: options?.signal?.aborted ? "aborted" : "stop",
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { ...cost, total: 0 } },
      };
      if (options?.maxTokens === 23 && options.signal) {
        stream.push({ type: "start", partial: message });
        options.signal.addEventListener("abort", () => {
          message.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end();
        }, { once: true });
      } else {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "offline", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      }
      return stream;
    },
  };
  runtime.registerProvider(offlineModel.provider, config);
  const model = runtime.getModel(offlineModel.provider, offlineModel.id)!;
  expect(model.maxTokens).toBe(1024);
  expect(await runtime.checkAuth(offlineModel.provider)).toBeUndefined();
  const interaction: AuthInteraction = { prompt: async () => "offline-probe-key", notify: () => {} };
  await runtime.login(offlineModel.provider, "api_key", interaction);
  expect((await runtime.checkAuth(offlineModel.provider))?.type).toBe("api_key");
  expect((await runtime.getAuth(model, { env: {} }))?.auth.apiKey).toBe("offline-probe-key");
  await runtime.setRuntimeApiKey(offlineModel.provider, "offline-runtime-key");
  expect((await runtime.getAuth(offlineModel.provider, { env: {} }))?.auth.apiKey).toBe("offline-runtime-key");
  await runtime.removeRuntimeApiKey(offlineModel.provider);
  const context = { messages: [{ role: "user" as const, content: "offline", timestamp: Date.now() }] };
  const stream = runtime.streamSimple(model, context, { maxTokens: 17, maxRetries: 0, maxRetryDelayMs: 2000 });
  const events = [];
  for await (const event of stream) events.push(event);
  expect(events.some(event => event.type === "text_delta" && event.partial.content.length > 0)).toBe(true);
  expect((await stream.result()).usage.totalTokens).toBe(3);
  expect(observedMaxTokens).toBe(17);
  expect((await runtime.completeSimple(model, context, { maxTokens: 19 })).stopReason).toBe("stop");
  const abort = new AbortController();
  const cancelled = runtime.streamSimple(model, context, { maxTokens: 23, signal: abort.signal });
  for await (const event of cancelled) if (event.type === "start") abort.abort();
  expect((await cancelled.result()).stopReason).toBe("aborted");
  const refresh = await runtime.refresh({ allowNetwork: false, providers: [offlineModel.provider], signal: new AbortController().signal });
  expect(refresh.errors.size).toBe(0);
  runtime.unregisterProvider(offlineModel.provider);
  expect(runtime.getModel(offlineModel.provider, offlineModel.id)).toBeUndefined();
});

test("explicit_models_store_is_used", async () => {
  const root = mkdtempSync(join(tmpdir(), "medclaw-p1-cache-"));
  try {
    const path = join(root, "pi-model-cache.json");
    await jsonModelsStore(path).write(offlineModel.provider, { models: [offlineModel], etag: '"offline-etag"' });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStore: jsonModelsStore(path), allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerNativeProvider(cachedProvider());
    const refreshed = await runtime.refresh({ allowNetwork: false, providers: [offlineModel.provider] });
    expect(refreshed.errors.size).toBe(0);
    expect(runtime.getModel(offlineModel.provider, offlineModel.id)?.maxTokens).toBe(1024);
    expect((await jsonModelsStore(path).read(offlineModel.provider))?.etag).toBe('"offline-etag"');

    const pathOnly = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: path, allowModelNetwork: false, refreshOnCreate: false });
    pathOnly.registerNativeProvider(cachedProvider());
    await pathOnly.refresh({ allowNetwork: false, providers: [offlineModel.provider] });
    expect(pathOnly.getModel(offlineModel.provider, offlineModel.id)).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installed_pi_packages_are_0871_and_bedrock_max_attempts_is_one", async () => {
  const codingDirectory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const aiDirectory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
  for (const name of ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui", "chord", "pi-telemetry"]) {
    let directory = dirname(Bun.resolveSync(`@earendil-works/${name}`, name === "pi-telemetry" ? aiDirectory : codingDirectory));
    while (!existsSync(join(directory, "package.json"))) directory = dirname(directory);
    expect(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version).toBe("0.87.1");
  }
  const awsModule = Bun.resolveSync("@aws-sdk/client-bedrock-runtime", aiDirectory);
  const script = `const {BedrockRuntimeClient}=require(${JSON.stringify(awsModule)});const client=new BedrockRuntimeClient({region:"us-east-1",credentials:{accessKeyId:"offline",secretAccessKey:"offline"}});console.log(await client.config.maxAttempts());client.destroy();`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { env: { ...process.env, AWS_MAX_ATTEMPTS: "1", AWS_EC2_METADATA_DISABLED: "true" }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output.trim()).toBe("1");
});

test("bun_react_main_preload_and_playwright_electron_are_compatible", async () => {
  const root = mkdtempSync(join(tmpdir(), "medclaw-p1-toolchain-"));
  const requireDesktop = createRequire(join(import.meta.dir, "../../apps/desktop/package.json"));
  const electronPath: string = requireDesktop("electron");
  try {
    await Bun.write(join(root, "probe.tsx"), `import {createRoot} from ${JSON.stringify(requireDesktop.resolve("react-dom/client"))};import {createElement} from ${JSON.stringify(requireDesktop.resolve("react"))};createRoot(document.getElementById("root")).render(createElement("p",{id:"probe"},"P1 build probe"));`);
    await Bun.write(join(root, "index.html"), '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\';script-src \'self\'"><div id="root"></div><script type="module" src="./probe.tsx"></script>');
    await Bun.write(join(root, "preload.ts"), 'import {contextBridge} from "electron";contextBridge.exposeInMainWorld("p1Probe",{active:true});');
    await Bun.write(join(root, "main.ts"), `import {app,BrowserWindow} from "electron";app.whenReady().then(()=>{const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,preload:${JSON.stringify(join(root, "preload.cjs"))}}});window.loadFile(${JSON.stringify(join(root, "renderer/index.html"))});});app.on("window-all-closed",()=>app.quit());`);
    expect((await Bun.build({ entrypoints: [join(root, "index.html")], outdir: join(root, "renderer"), target: "browser" })).success).toBe(true);
    for (const name of ["main", "preload"]) {
      expect((await Bun.build({ entrypoints: [join(root, `${name}.ts`)], outdir: root, naming: `${name}.cjs`, target: "node", format: "cjs", external: ["electron"] })).success).toBe(true);
    }
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
    const desktop = await _electron.launch({ executablePath: electronPath, args: [join(root, "main.cjs")], env });
    try {
      const page = await desktop.firstWindow();
      await page.locator("#probe").waitFor();
      expect(await page.locator("#probe").textContent()).toBe("P1 build probe");
      expect(await page.evaluate(() => (window as unknown as { p1Probe: { active: boolean } }).p1Probe.active)).toBe(true);
      const versions = await desktop.evaluate(() => ({ electron: process.versions.electron, node: process.versions.node }));
      expect(versions.electron).toBe("44.5.1");
      console.log(`Toolchain runtime: Electron ${versions.electron}, embedded Node ${versions.node}`);
    } finally { await desktop.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60000);

test("actual_desktop_dev_command_stays_open_and_closes_its_owned_host", async () => {
  const root = mkdtempSync(join(tmpdir(), "medclaw-p1-dev-command-"));
  const project = dirname(dirname(import.meta.dir));
  const launcher = spawn(process.execPath, ["run", "dev:desktop", "--data-root", root], { cwd: project, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise<number | null>((resolve, reject) => { launcher.once("error", reject); launcher.once("exit", resolve); });
  let output = "", errors = "";
  launcher.stdout.on("data", chunk => { output += chunk.toString(); });
  launcher.stderr.on("data", chunk => { errors += chunk.toString(); });
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  // The native close addresses only this isolated Main, after checking its Host ancestry.
  const script = `$ErrorActionPreference='Stop'; $taskRoot=${quote(root)}; $taskDeadline=(Get-Date).AddSeconds(25); $taskMain=$null;
    do {
      $taskCandidates=@(Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'electron.exe' -and $_.CommandLine -and $_.CommandLine.Contains('--medclaw-data-root '+$taskRoot) -and $_.CommandLine.Contains('main\\index.cjs')});
      if ($taskCandidates.Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $taskRoot 'runtime/host.lock'))) {
        $taskMainProcess=Get-Process -Id $taskCandidates[0].ProcessId; if ($taskMainProcess.MainWindowHandle -ne 0) {$taskMain=$taskCandidates[0]; break}
      }
      Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $taskDeadline);
    if ($null -eq $taskMain) {throw 'Development Main window or Host lock did not become available'};
    $taskLock=Get-Content -LiteralPath (Join-Path $taskRoot 'runtime/host.lock') -Raw | ConvertFrom-Json;
    $taskHost=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$taskLock.pid);
    if ($taskHost.ParentProcessId -ne $taskMain.ProcessId -or $taskHost.Name -ne 'bun.exe') {throw 'Development Host ownership mismatch'};
    $taskClosed=$taskMainProcess.CloseMainWindow(); $taskExited=$taskMainProcess.WaitForExit(15000);
    [pscustomobject]@{mainPid=$taskMain.ProcessId;hostPid=$taskLock.pid;closed=$taskClosed;mainExited=$taskExited;hostExited=($null -eq (Get-Process -Id $taskLock.pid -ErrorAction SilentlyContinue));lockRemoved=(-not (Test-Path -LiteralPath (Join-Path $taskRoot 'runtime/host.lock')))} | ConvertTo-Json -Compress`;
  try {
    const { stdout: closeOutput, stderr: closeErrors } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 45000 });
    expect(closeErrors.trim()).toBe("");
    const facts = JSON.parse(closeOutput);
    expect(facts.mainPid).toBeGreaterThan(0); expect(facts.hostPid).toBeGreaterThan(0);
    expect(facts.closed).toBe(true); expect(facts.mainExited).toBe(true); expect(facts.hostExited).toBe(true); expect(facts.lockRemoved).toBe(true);
    expect(await exited).toBe(0);
    expect(output.trim()).toBe("");
    expect(errors).not.toContain("ERR_FAILED");
  } finally {
    // A failed startup must retain its isolated data until its processes are actually gone.
    if (launcher.exitCode !== null && !existsSync(join(root, "runtime/host.lock"))) rmSync(root, { recursive: true, force: true });
  }
}, 60000);

test("desktop_development_ipc_accepts_only_its_token_and_closes_the_host", async () => {
  const root = mkdtempSync(join(tmpdir(), "medclaw-p1-dev-ipc-"));
  const project = dirname(dirname(import.meta.dir));
  const electronPath: string = createRequire(join(project, "apps/desktop/package.json"))("electron");
  const token = crypto.randomUUID();
  const env: NodeJS.ProcessEnv = { ...process.env, MEDCLAW_HOST_ENTRY: join(project, "apps/host/src/main.ts"), MEDCLAW_BUN_EXECUTABLE: process.execPath, MEDCLAW_DEV_CONTROL_TOKEN: token };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [join(project, ".build/desktop/main/index.cjs"), "--medclaw-data-root", root], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  let stderr = ""; child.stdout?.resume(); child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  try {
    const lockPath = join(root, "runtime/host.lock");
    for (let attempt = 0; !existsSync(lockPath) && attempt < 250; attempt++) await Bun.sleep(100);
    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(Number.isSafeInteger(lock.pid)).toBe(true); expect(typeof lock.instanceId).toBe("string");
    child.send({ token: "wrong-token", command: "quit" });
    child.send({ token, command: "quit", extra: true });
    child.send({ token, command: "delete" });
    await Bun.sleep(300);
    expect(child.exitCode).toBe(null); expect(existsSync(lockPath)).toBe(true);
    child.send({ token, command: "quit" });
    expect(await exited).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    expect(() => process.kill(lock.pid, 0)).toThrow();
    expect(stderr).not.toContain("ERR_FAILED");
  } finally {
    if (child.connected) child.disconnect();
    if (child.exitCode !== null && !existsSync(join(root, "runtime/host.lock"))) rmSync(root, { recursive: true, force: true });
  }
}, 45000);
