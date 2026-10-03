import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { createServer, type Server } from "node:http";
import type { MessageStreamSnapshot, OpenEventSubscriptionInput } from '../../packages/contracts/src/event';

type ObservedStream = { instanceId: string | null; subscriptionId: string; snapshot: MessageStreamSnapshot };
type EventMain = typeof globalThis & { __p1EventGate: { active: Record<string, OpenEventSubscriptionInput> } };

const root = resolve(import.meta.dirname, "../..");
const bun = process.env.MEDCLAW_BUN_EXECUTABLE ?? "bun";
let app: ElectronApplication;
let page: Page;
let dataRoot: string;
let server: Server;
let baseUrl: string;
const requests: { text: string; model: string }[] = [];
let continueScroll: (() => void) | null = null;
test.describe.configure({ mode: "serial" });
async function launchDesktop() {
  const electronPath: string = createRequire(join(root, "apps/desktop/package.json"))("electron");
  const playwright = createRequire(createRequire(import.meta.url).resolve("@playwright/test/package.json"));
  const core = createRequire(playwright.resolve("playwright/package.json")).resolve("playwright-core/package.json");
  const loader = join(dirname(core), "lib/server/electron/loader.js");
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])), MEDCLAW_HOST_ENTRY: join(root, "apps/host/src/main.ts"), MEDCLAW_BUN_EXECUTABLE: execFileSync(bun, ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" }).trim() };
  delete env.ELECTRON_RUN_AS_NODE;
  const eventSeam = join(dataRoot, 'event-observation.cjs');
  writeFileSync(eventSeam, `const {ipcMain}=require('electron'),original=ipcMain.handle.bind(ipcMain);const state=globalThis.__p1EventGate={active:{}};
    ipcMain.handle=(channel,listener)=>original(channel,async(event,envelope)=>{const result=await listener(event,envelope);
      if(channel==='medclaw:request'&&envelope.method==='event.subscribe'&&result.ok){const p=envelope.payload;
        if(p.action==='open')state.active[p.subscriptionId]=structuredClone(p);else delete state.active[p.subscriptionId];}
      return result;});`);
  app = await electron.launch({ executablePath: electronPath, args: ["-r", loader, '-r', eventSeam, join(root, ".build/desktop/main/index.cjs"), "--medclaw-data-root", dataRoot], env, timeout: 30000 });
  page = await app.firstWindow();
  const startupErrors: string[] = [];
  const onError = (error: Error) => startupErrors.push(error.message);
  page.on("pageerror", onError);
  try { await expect(page.getByText("Host ready", { exact: true }).first()).toBeVisible({ timeout: 30000 }); }
  catch (error) { console.log("Desktop startup", { url: page.url(), ...await page.evaluate(() => ({ bridge: typeof window.medclaw, body: document.body.innerText })) }, await app.evaluate(({ app }) => ({ argv: process.argv, appPath: app.getAppPath() })), startupErrors); throw error; }
  finally { page.off("pageerror", onError); }
}
async function chooseSessionModel(name: string) {
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByLabel("Search models").fill(name);
  await page.getByRole("button", { name: "Select " + name, exact: true }).click();
  await page.getByRole("button", { name: "Use for this session", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
}
const temporaryOutput = (runId: number) => page.locator(`[data-testid="temporary-message"][data-run-id="${runId}"] .answer-text`);
async function observedStream(runId: number): Promise<ObservedStream> {
  await expect.poll(() => app.evaluate((_, id) => Object.values((globalThis as EventMain).__p1EventGate.active).some(input => input.runId === id), runId)).toBe(true);
  const original = await app.evaluate((_, id) => Object.values((globalThis as EventMain).__p1EventGate.active).findLast(input => input.runId === id)!, runId);
  const refreshed = await page.evaluate(input => window.medclaw.request('event.subscribe', input), original);
  if (!refreshed.ok || refreshed.data.action !== 'open') throw new Error('Expected actual original display subscription ack');
  const snapshot = refreshed.data.snapshots.findLast((value): value is MessageStreamSnapshot => value.type === 'message.snapshot' && value.blocks.some(block => block.text === '你好😀'));
  if (!snapshot || snapshot.streamConnection !== refreshed.data.streamConnection) throw new Error('Expected actual assistant snapshot on the original connection');
  const run = await page.evaluate(id => window.medclaw.request('run.read', { runId: id }), runId);
  const host = await page.evaluate(() => window.medclaw.request('host.read', {}));
  if (!run.ok || run.data.kind !== 'one' || run.data.run?.kind !== 'agent' || !host.ok) throw new Error('Expected original Agent Run and Host facts for stream injection');
  const notice = { instanceId: host.data.instanceId, subscriptionId: original.subscriptionId, snapshot };
  expect(notice.snapshot.runId).toBe(run.data.run.id); expect(notice.snapshot.sessionId).toBe(run.data.run.sessionId);
  expect(notice.instanceId).toBe(host.data.instanceId); expect(notice.subscriptionId).toBeTruthy(); expect(notice.snapshot.streamConnection).toBeTruthy();
  return notice;
}
test.beforeAll(async () => {
  test.setTimeout(90000);
  for (const part of ["main", "preload"]) execFileSync(bun, ["build", `apps/desktop/src/${part}/index.ts`, "--target=node", "--format=cjs", "--external=electron", `--outfile=.build/desktop/${part}/index.cjs`], { cwd: root });
  execFileSync(bun, ["build", "apps/desktop/src/renderer/index.html", "--target=browser", "--outdir=.build/desktop/renderer"], { cwd: root });
  dataRoot = mkdtempSync(join(tmpdir(), "medclaw-p1-e2e-"));
  server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const content = payload.messages?.filter((message: { role: string }) => message.role === "user").at(-1)?.content ?? "";
    const text: string = typeof content === "string" ? content : content.filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join("");
    requests.push({ text, model: payload.model });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (chunk: unknown) => response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    send({ id: "ui-fixture", model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: text.includes("scroll") ? "首段流式文本\n".repeat(120) : text.includes("long") ? "你好😀".repeat(9000) : "你好😀" }, finish_reason: null }] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      send({ id: "ui-fixture", model: "fixture", choices: [{ index: 0, delta: { content: " OK" }, finish_reason: "stop" }] });
      send({ id: "ui-fixture", choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
      response.end("data: [DONE]\n\n");
    };
    if (text.includes("scroll")) continueScroll = () => {
      continueScroll = null;
      send({ id: "ui-fixture", model: "fixture", choices: [{ index: 0, delta: { content: "滚动测试新增增量\n" }, finish_reason: null }] });
      timer = setTimeout(finish, 1000);
    };
    else if (text !== "slow rollback guard") timer = setTimeout(finish, text.includes("slow") ? 5000 : 30);
    response.on("close", () => { clearTimeout(timer); if (text.includes("scroll")) continueScroll = null; });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  await launchDesktop();
});
test.afterAll(async () => {
  await app?.close();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

test("actual Electron custom model publishes, calls once, stops and reads the original run", async () => {
  test.setTimeout(60000);
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByLabel("Search models")).toBeVisible();
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  await page.getByRole("button", { name: "Sign in with API Key", exact: true }).click();
  const auth = page.getByRole("dialog", { name: "Provider sign-in", exact: true });
  await auth.locator('input[type="password"]').focus();
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog", { name: "Confirm authentication cancellation", exact: true }).getByRole("button", { name: "Confirm authentication cancellation", exact: true }).click();
  await expect(auth).toContainText("cancelled");
  await page.getByRole("button", { name: "Sign in with API Key", exact: true }).click();
  await auth.locator('input[type="password"]').fill("P1-NATIVE-AUTH-SECRET-CANARY");
  await auth.getByRole("button", { name: "Submit authentication response", exact: true }).click();
  await expect(auth).toContainText("completed");
  await page.getByRole("button", { name: "Read authentication status", exact: true }).click();
  await expect(page.getByText("Authentication status: Authentication available", { exact: true })).toBeVisible();
  await page.getByLabel("Provider", { exact: true }).selectOption("");
  expect(requests).toHaveLength(0);
  await page.getByLabel("Provider ID").fill("p1-ui-fixture");
  await page.getByLabel("Provider name").fill("P1 UI fixture");
  await page.getByLabel("Base URL").fill(baseUrl);
  await page.getByLabel("Native API").selectOption("openai-completions");
  await page.getByLabel("Model ID", { exact: true }).fill("fixture");
  await page.getByLabel("Model name", { exact: true }).fill("UI fixture model");
  await page.getByLabel("Context limit").fill("8192");
  await page.getByLabel("Output limit", { exact: true }).fill("1024");
  await page.getByLabel("Output limit matches the service configuration").check();
  await page.getByLabel("New API Key").fill("P1-UI-SECRET-CANARY");
  await page.getByRole("button", { name: "Save custom definition" }).click();
  await expect(page.getByText("Custom definition published", { exact: true })).toBeVisible();
  await expect(page.getByLabel("New API Key")).toHaveValue("");
  await page.getByLabel("Search models").fill("UI fixture model");
  await page.getByRole("button", { name: "Select UI fixture model" }).click();
  await page.getByRole("button", { name: "Set as default model" }).click();
  await expect(page.getByText("Default model published", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "New Session", exact: true }).click();
  await expect(page.getByTestId("current-session")).toContainText("New Session 1");
  const firstText = "长文本😀".repeat(9000);
  await page.getByLabel("Message text").fill(firstText);
  await expect.poll(async () => (await page.getByLabel("Message text").inputValue()).length).toBe(firstText.length);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const firstHistory = await page.evaluate(() => window.medclaw.request("session.messages.read", { sessionId: 1 }));
  if (!firstHistory.ok) throw new Error("Expected native messages for the original saved Run");
  const firstReplyId = firstHistory.data.items.find(item => item.runId === 1 && item.displayRole === "assistant")?.nativeEntryId;
  expect(firstReplyId).toBeDefined();
  const firstReply = page.getByTestId("chat-native-messages").locator(`[data-native-entry-id="${firstReplyId}"] .answer-text`);
  await expect(firstReply).toContainText("你好😀 OK");
  await expect(page.getByTestId("run-output")).toHaveCount(0);
  expect(requests[0]!.text).toBe(firstText);
  const firstRun = await page.evaluate(() => window.medclaw.request("run.read", { runId: 1 }));
  expect(firstRun.ok && firstRun.data.kind === "one" && firstRun.data.run?.inputText).toBe(firstText);
  const identity = await page.evaluate(() => window.medclaw.request("host.read", {}));
  if (!identity.ok || !identity.data.instanceId) throw new Error("Expected the ready fixture Host identity");
  await expect(firstReply).toHaveText("你好😀 OK");
  await expect(page.getByTestId("run-output")).toHaveCount(0);
  await expect(page.getByTestId('temporary-run-area')).toHaveCount(0);
  expect(requests).toHaveLength(1);
  await page.getByLabel("Message text").fill("slow");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop generating", exact: true })).toBeEnabled();
  await expect.poll(() => requests.length).toBe(2);
  await expect(temporaryOutput(2)).toHaveText("你好😀");
  const activeStream = await observedStream(2);
  expect(activeStream.snapshot.revision).toBeGreaterThan(1);
  expect(activeStream.snapshot.phase).toBe('streaming');
  await app.evaluate(({ BrowserWindow }, observed) => {
    const content = BrowserWindow.getAllWindows()[0]!.webContents;
    // Labelled negative frames use the proved active subscription; Run 1 is the
    // actual saved original Run, not an invented successful stream identity.
    const lateText = 'late terminal preview', oldText = 'old instance preview';
    content.send("medclaw:notice", { type: "event.stream", instanceId: observed.instanceId, subscriptionId: observed.subscriptionId, snapshot: { ...observed.snapshot, runId: 1, messageId: observed.snapshot.messageId + '.late', ordinal: observed.snapshot.ordinal + 1, revision: observed.snapshot.revision + 1, phase: 'ended', nativeEntryId: null, blocks: [{ contentIndex: 0, text: lateText }], totalChars: lateText.length, truncated: false } });
    content.send("medclaw:notice", { type: "event.stream", instanceId: "old-ui-fixture-instance", subscriptionId: observed.subscriptionId, snapshot: { ...observed.snapshot, revision: observed.snapshot.revision + 1, blocks: [{ contentIndex: 0, text: oldText }], totalChars: oldText.length, truncated: false } });
    for (let repeat = 0; repeat < 2; repeat++) content.send("medclaw:notice", { type: "event.stream", ...observed });
    const staleText = 'stale revision text', foreignText = 'old connection text';
    content.send("medclaw:notice", { type: "event.stream", instanceId: observed.instanceId, subscriptionId: observed.subscriptionId, snapshot: { ...observed.snapshot, revision: observed.snapshot.revision - 1, blocks: [{ contentIndex: 0, text: staleText }], totalChars: staleText.length, truncated: false } });
    content.send("medclaw:notice", { type: "event.stream", instanceId: observed.instanceId, subscriptionId: observed.subscriptionId, snapshot: { ...observed.snapshot, streamConnection: 'old.' + observed.snapshot.streamConnection, revision: observed.snapshot.revision + 1, blocks: [{ contentIndex: 0, text: foreignText }], totalChars: foreignText.length, truncated: false } });
  }, activeStream);
  await expect(temporaryOutput(2)).toHaveText("你好😀");
  await expect(firstReply).toHaveText("你好😀 OK");
  await expect(page.locator('.messages')).not.toContainText('late terminal preview');
  await expect(page.locator('.messages')).not.toContainText('old instance preview');
  await expect(page.locator('.messages')).not.toContainText('stale revision text');
  await expect(page.locator('.messages')).not.toContainText('old connection text');
  expect(requests).toHaveLength(2);
  await page.getByRole("button", { name: "Stop generating", exact: true }).click();
  await expect(page.getByText("Cancelled and saved", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  await page.getByRole("button", { name: "View run details" }).click();
  await page.getByRole("tab", { name: "Run details" }).click();
  await expect(page.getByText("logical_request", { exact: false })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("desktop-1440.png") });
  const publicReplies = await page.evaluate(async () => Promise.all([
    window.medclaw.request("run.read", { runId: 2 }),
    window.medclaw.request("model.custom.read", {}),
    window.medclaw.request("model.config.read", {}),
    window.medclaw.request("diagnostics.read", {}),
  ]));
  for (const reply of publicReplies) expect(reply.ok).toBe(true);
  const publicText = JSON.stringify(publicReplies);
  const bodyText = await page.locator("body").innerText();
  const persisted = ["settings.json", "credentials.enc.json", "app.sqlite"].map(name => join(dataRoot, "data", name));
  const wal = join(dataRoot, "data", "app.sqlite-wal");
  if (existsSync(wal)) persisted.push(wal);
  for (const file of persisted) {
    expect(existsSync(file)).toBe(true);
    const bytes = readFileSync(file);
    for (const secret of ["P1-UI-SECRET-CANARY", "P1-NATIVE-AUTH-SECRET-CANARY"]) {
      expect(bytes.includes(Buffer.from(secret, "utf8")), file).toBe(false);
      expect(bytes.includes(Buffer.from(secret, "utf16le")), file).toBe(false);
    }
  }
  for (const secret of ["P1-UI-SECRET-CANARY", "P1-NATIVE-AUTH-SECRET-CANARY"]) {
    expect(bodyText).not.toContain(secret);
    expect(publicText).not.toContain(secret);
  }
  const sandboxed = await app.evaluate(({ app, BrowserWindow }) => {
    const pid = BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId();
    return app.getAppMetrics().find(metric => metric.pid === pid)?.sandboxed;
  });
  expect(sandboxed).toBe(true);
  // This is published by contextBridge; the page itself has no Node globals.
  expect(await page.evaluate(() => typeof window.medclaw.request)).toBe("function");
  expect(await page.evaluate(() => ({ require: typeof require, process: typeof process }))).toEqual({ require: "undefined", process: "undefined" });
});

test("draft survives navigation, IME Enter does not send, narrow drawer returns focus", async () => {
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const input = page.getByLabel("Message text");
  await input.fill("preserved draft");
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(input).toHaveValue("preserved draft");
  const before = requests.length;
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  expect(requests).toHaveLength(before);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1100, 720));
  await page.getByRole("button", { name: "Close run details" }).click();
  const open = page.getByRole("button", { name: "View run details" });
  await open.click();
  await expect(page.getByRole("dialog", { name: "Run details" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close run details" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  const dialog = page.getByRole("dialog", { name: "Run details" });
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
  await page.evaluate(() => { document.documentElement.style.fontSize = "28px"; });
  await input.fill("200% text draft");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await send.scrollIntoViewIfNeeded();
  const bounds = await send.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(bounds).not.toBeNull();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  await page.screenshot({ path: test.info().outputPath("desktop-minimum-text-200.png") });
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
});

test("custom definition updates all models and persisted Unicode output pages reconstruct the result", async () => {
  test.setTimeout(60000);
  const before = requests.length;
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: /Edit P1 UI fixture/ }).click();
  await expect(page.getByLabel("New API Key")).toHaveValue("");
  await page.getByLabel("Model name", { exact: true }).fill("UI fixture model updated");
  await page.getByLabel("Output limit", { exact: true }).fill("2048");
  await page.getByLabel("Output limit matches the service configuration").check();
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  const second = page.locator("fieldset").filter({ has: page.getByLabel("Model ID", { exact: true }) }).nth(1);
  await second.getByLabel("Model ID", { exact: true }).fill("fixture-second");
  await second.getByLabel("Model name", { exact: true }).fill("Second fixture model");
  await second.getByLabel("Image capability metadata").check();
  await second.getByLabel("Reasoning", { exact: true }).check();
  await second.getByLabel("Output limit matches the service configuration").check();
  await second.getByLabel("Known USD rates per million tokens").check();
  await second.getByLabel("Input rate", { exact: true }).fill("0.1");
  await second.getByLabel("Output rate", { exact: true }).fill("0.2");
  await page.getByRole("button", { name: "Save custom definition" }).click();
  await expect(page.getByText("Custom definition published", { exact: true })).toBeVisible();
  await page.getByLabel("Search models").fill("UI fixture model updated");
  await page.getByRole("button", { name: "Select UI fixture model updated", exact: true }).click();
  await page.getByRole("button", { name: "Set as default model" }).click();
  await expect(page.getByText("Default model published", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(before);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const input = page.getByLabel("Message text");
  const original = await page.evaluate(() => window.medclaw.request("run.read", { runId: 1 }));
  if (!original.ok || original.data.kind !== "one" || !original.data.run) throw new Error("Expected the original frozen Run");
  const directory = await page.evaluate(() => window.medclaw.request("model.read", {}));
  if (!directory.ok) throw new Error("Expected the configured model directory");
  await input.fill("long output");
  await chooseSessionModel("Second fixture model");
  await expect(page.getByRole("combobox", { name: "Session model", exact: true })).toHaveValue(JSON.stringify(["p1-ui-fixture", "fixture-second"]));
  await expect(input).toHaveValue("long output");
  expect(await page.evaluate(() => window.medclaw.request("model.read", {}))).toMatchObject({ ok: true, data: { configVersion: directory.data.configVersion, selection: directory.data.selection } });
  expect(requests).toHaveLength(before);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect.poll(() => requests.length).toBe(before + 1);
  expect(requests.at(-1)!.model).toBe("fixture-second");
  const saved = await page.evaluate(() => window.medclaw.request("run.read", { runId: 3 }));
  if (!saved.ok || saved.data.kind !== "one" || !saved.data.run) throw new Error("Expected the newly selected model Run");
  expect(saved.data.run.model.modelId).toBe("fixture-second");
  expect(saved.data.run.calls[0]!.model.modelId).toBe("fixture-second");
  await chooseSessionModel("UI fixture model updated");
  await expect(page.getByRole("combobox", { name: "Session model", exact: true })).toHaveValue(JSON.stringify(["p1-ui-fixture", "fixture"]));
  const unchanged = await page.evaluate(() => window.medclaw.request("run.read", { runId: 1 }));
  expect(unchanged).toEqual(original);
  expect(await page.evaluate(() => window.medclaw.request("run.read", { runId: 3 }))).toEqual(saved);
  expect(requests).toHaveLength(before + 1);
  await input.fill("draft survives failed model publication");
  const published = await page.evaluate(() => window.medclaw.request("model.read", {}));
  const blocker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $taskSettingsLock=[IO.File]::Open($env:MEDCLAW_SETTINGS_LOCK_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); try { [Console]::Out.WriteLine('LOCKED'); [Console]::In.ReadLine() | Out-Null } finally { $taskSettingsLock.Dispose() }"], { windowsHide: true, env: { ...process.env, MEDCLAW_SETTINGS_LOCK_PATH: join(dataRoot, "data/settings.json") }, stdio: ["pipe", "pipe", "pipe"] });
  let lockOutput = "";
  blocker.stdout.on("data", chunk => { lockOutput += chunk.toString(); });
  blocker.on("error", () => {});
  const released = new Promise<void>(resolve => blocker.once("close", () => resolve()));
  try {
    await expect.poll(() => lockOutput).toContain("LOCKED");
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await page.getByLabel("Search models").fill("Second fixture model");
    await page.getByRole("button", { name: "Select Second fixture model", exact: true }).click();
    await page.getByRole("button", { name: "Set as default model", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("The configuration has not been confirmed saved");
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Session model", exact: true })).toHaveValue(JSON.stringify(["p1-ui-fixture", "fixture"]));
    await expect(input).toHaveValue("draft survives failed model publication");
    expect(await page.evaluate(() => window.medclaw.request("model.read", {}))).toMatchObject(published.ok ? { ok: true, data: { configVersion: published.data.configVersion, selection: published.data.selection } } : published);
    expect(requests).toHaveLength(before + 1);
  } finally { blocker.stdin.end(); await released; }
  await page.getByRole("button", { name: "Dismiss notice", exact: true }).click();
  await input.fill("");
  await page.getByRole("button", { name: "View run details", exact: true }).click();
  await page.getByRole("tab", { name: "Run details", exact: true }).click();
  let combined = await page.getByTestId("saved-output").innerText();
  while (await page.getByRole("button", { name: "Read next output section", exact: true }).isEnabled()) {
    const prior = combined.length;
    await page.getByRole("button", { name: "Read next output section", exact: true }).click();
    await expect(page.getByText(new RegExp(`${prior}–`))).toBeVisible();
    combined += await page.getByTestId("saved-output").innerText();
  }
  expect(combined).toBe("你好😀".repeat(9000) + " OK");
  expect(requests).toHaveLength(before + 1);
});

test("reopening Electron restores published custom models, preferences and runs without resending", async () => {
  test.setTimeout(60000);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Open run details").check();
  await page.getByLabel("Default details tab").selectOption("runtime");
  await page.getByRole("button", { name: "Save display preferences", exact: true }).click();
  await expect(page.getByText("Display preferences published", { exact: true })).toBeVisible();
  const before = requests.length;
  await app.close();
  await launchDesktop();
  await expect(page.getByRole("tab", { name: "Run details", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "View Run 3", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View Run 3", exact: true }).click();
  await expect(page.getByTestId("saved-output")).toContainText("你好😀");
  await expect(page.getByLabel("Message text")).toHaveValue("");
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: /Edit P1 UI fixture/ }).click();
  await expect(page.getByLabel("New API Key")).toHaveValue("");
  const modelDefinitions = page.locator("fieldset").filter({ has: page.getByLabel("Model ID", { exact: true }) });
  await expect(modelDefinitions).toHaveCount(2);
  await expect(modelDefinitions.nth(0).getByLabel("Model name", { exact: true })).toHaveValue("UI fixture model updated");
  await expect(modelDefinitions.nth(1).getByLabel("Image capability metadata")).toBeChecked();
  expect(requests).toHaveLength(before);
  expect(await page.locator("body").innerText()).not.toContain("P1-UI-SECRET-CANARY");
});

test("Host stop leaves local preferences and partial diagnostics reachable", async () => {
  test.setTimeout(45000);
  const before = requests.length;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Stop Host", exact: true }).click();
  await expect(page.getByText("Host stopped", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Read diagnostics", exact: true }).click();
  await expect(page.getByText("Diagnostics partially available; missing sources: host", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save display preferences", exact: true })).toBeEnabled();
  expect(await page.locator("body").innerText()).not.toContain("P1-UI-SECRET-CANARY");
  await page.getByRole("button", { name: "Start Host", exact: true }).click();
  await expect(page.getByText("Host ready", { exact: true }).first()).toBeVisible();
  expect(requests).toHaveLength(before);
});

test("policy rollback publishes a new version, preserves history, and rejects an active run", async () => {
  test.setTimeout(60000);
  const before = requests.length;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const original = await page.evaluate(() => window.medclaw.request("model.config.read", {}));
  const history = await page.evaluate(() => window.medclaw.request("run.read", { recent: true }));
  if (!original.ok || !history.ok || history.data.kind !== "recent") throw new Error("Expected published configuration and saved history");
  await page.getByLabel("Run timeout (milliseconds)").fill("2000");
  await page.getByRole("button", { name: "Publish request policy", exact: true }).click();
  await expect(page.getByText("Request policy published; applies to the next run", { exact: true })).toBeVisible();
  const updated = await page.evaluate(() => window.medclaw.request("model.config.read", {}));
  if (!updated.ok) throw new Error("Expected updated policy");
  expect(updated.data.policy.timeoutMs).toBe(2000);
  await page.getByRole("button", { name: "Roll back to previous configuration", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Confirm configuration rollback", exact: true }).getByRole("button", { name: "Confirm rollback publication", exact: true }).click();
  await expect(page.getByText("Rollback configuration published", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Run timeout (milliseconds)")).toHaveValue(String(original.data.policy.timeoutMs));
  const rolledBack = await page.evaluate(() => window.medclaw.request("model.config.read", {}));
  const after = await page.evaluate(() => window.medclaw.request("run.read", { recent: true }));
  if (!rolledBack.ok || !after.ok || after.data.kind !== "recent") throw new Error("Expected rollback readback");
  expect(BigInt(rolledBack.data.configVersion)).toBeGreaterThan(BigInt(updated.data.configVersion));
  expect(rolledBack.data.rollbackFromVersion).toBe(original.data.configVersion);
  expect(after.data.runs).toEqual(history.data.runs);
  expect(requests).toHaveLength(before);
  await page.getByRole("button", { name: "Close run details", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "New Session", exact: true }).click();
  await expect(page.getByTestId("current-session")).toContainText("New Session 2");
  await page.getByLabel("Message text").fill("slow rollback guard");
  const originalChoice = await page.evaluate(() => window.medclaw.request("model.read", {}));
  if (!originalChoice.ok) throw new Error("Expected the published model before the active Run");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requests.length).toBe(before + 1);
  const activeBeforeChoice = await page.evaluate(() => window.medclaw.request("run.active", {}));
  if (!activeBeforeChoice.ok || !activeBeforeChoice.data) throw new Error("Expected the active Run before changing the next model");
  const activeRunId = activeBeforeChoice.data.runId;
  const frozen = await page.evaluate(runId => window.medclaw.request("run.read", { runId }), activeRunId);
  await page.getByLabel("Message text").fill("draft kept during model switch");
  await chooseSessionModel("Second fixture model");
  await expect(page.getByRole("combobox", { name: "Session model", exact: true })).toHaveValue(JSON.stringify(["p1-ui-fixture", "fixture-second"]));
  await expect(page.getByLabel("Message text")).toHaveValue("draft kept during model switch");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByLabel("Message text").press("Enter");
  expect(requests).toHaveLength(before + 1);
  expect(await page.evaluate(runId => window.medclaw.request("run.read", { runId }), activeRunId)).toEqual(frozen);
  expect(requests.at(-1)!.model).toBe("fixture");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const activeVersion = await page.evaluate(() => window.medclaw.request("model.config.read", {}));
  if (!activeVersion.ok) throw new Error("Expected active configuration version");
  await page.getByRole("button", { name: "Roll back to previous configuration", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Confirm configuration rollback", exact: true }).getByRole("button", { name: "Confirm rollback publication", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("An operation is still running");
  const rejected = await page.evaluate(() => window.medclaw.request("model.config.read", {}));
  if (!rejected.ok) throw new Error("Expected original configuration after rejection");
  expect(rejected.data.configVersion).toBe(activeVersion.data.configVersion);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "Stop generating", exact: true }).click();
  await expect(page.getByText("Cancelled and saved", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(before + 1);
});

test("streaming preserves an upward scroll and a busy draft until return latest", async () => {
  const before = requests.length;
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const input = page.getByLabel("Message text");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await input.fill("scroll response");
  await send.click();
  await expect.poll(() => requests.length).toBe(before + 1);
  const active = await page.evaluate(() => window.medclaw.request('run.active', {}));
  if (!active.ok || !active.data || active.data.sessionId === null) throw new Error('Expected the original active Session Run for scrolling');
  const output = temporaryOutput(active.data.runId);
  await expect(output).toContainText("首段流式文本");
  await input.fill("next draft kept while busy");
  await expect(send).toBeDisabled();
  await input.press("Enter");
  await expect(input).toHaveValue("next draft kept while busy");
  expect(requests).toHaveLength(before + 1);
  const messages = page.locator(".messages");
  expect(await messages.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await messages.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  const latest = page.getByRole("button", { name: "New content · Back to latest", exact: true });
  await expect(latest).toBeVisible();
  if (!continueScroll) throw new Error("Expected the controlled native stream continuation");
  continueScroll();
  await expect(output).toContainText("滚动测试新增增量");
  expect(await messages.evaluate(element => element.scrollTop)).toBe(0);
  await latest.click();
  await expect.poll(() => messages.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(64);
  await expect(latest).not.toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("next draft kept while busy");
  await expect(send).toBeEnabled();
  expect(requests).toHaveLength(before + 1);
});

test("a real SQLite lock preserves the draft and retries only original saved facts", async () => {
  test.setTimeout(30000);
  const before = requests.length;
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const input = page.getByLabel("Message text");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await input.fill("slow necessary save");
  await send.click();
  await expect.poll(() => requests.length).toBe(before + 1);
  const active = await page.evaluate(() => window.medclaw.request("run.active", {}));
  if (!active.ok || !active.data) throw new Error("Expected the actual running request before the SQLite fault");
  const runId = active.data.runId;
  const lockCode = 'import {Database} from "bun:sqlite";const db=new Database(process.argv[1],{strict:true});db.exec("PRAGMA busy_timeout=1000;BEGIN IMMEDIATE;");process.stdin.resume();process.stdin.once("end",()=>{db.exec("ROLLBACK;");db.close();});process.stdout.write("LOCKED\\n");';
  // This owned fault process reserves the isolated test database; it does not write product facts.
  const blocker = spawn(bun, ["--no-env-file", "-e", lockCode, join(dataRoot, "data/app.sqlite")], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number | null>(resolve => blocker.once("exit", resolve));
  let output = "", errors = "";
  blocker.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2000); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SQLite lock did not become ready: ${errors}`)), 10000);
      blocker.stdout.on("data", chunk => { output += chunk; if (output.includes("LOCKED\n")) { clearTimeout(timer); resolve(); } });
      blocker.once("error", error => { clearTimeout(timer); reject(error); });
      blocker.once("exit", code => { clearTimeout(timer); if (!output.includes("LOCKED\n")) reject(new Error(`SQLite lock exited ${code}: ${errors}`)); });
    });
    await input.fill("draft survives necessary save failure");
    await expect(page.getByText("Waiting to save", { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(send).toBeDisabled();
    await input.press("Enter");
    await expect(input).toHaveValue("draft survives necessary save failure");
    const pending = await page.evaluate(() => window.medclaw.request("run.active", {}));
    expect(pending).toMatchObject({ ok: true, data: { runId, persistencePending: true, stopPending: false } });
    const beforeSave = await page.evaluate(id => window.medclaw.request("run.read", { runId: id }), runId);
    expect(beforeSave).toMatchObject({ ok: true, data: { kind: "one", run: { id: runId, status: "running", calls: [{ state: "started" }] } } });
    expect(requests).toHaveLength(before + 1);
    blocker.stdin.end();
    expect(await exited).toBe(0);
    if (!(await page.getByRole("button", { name: "Close run details", exact: true }).isVisible())) await page.getByRole("button", { name: "View run details", exact: true }).click();
    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    const saved = await page.evaluate(id => window.medclaw.request("run.read", { runId: id }), runId);
    expect(saved).toMatchObject({ ok: true, data: { kind: "one", run: { id: runId, status: "completed", output: { text: "你好😀 OK" }, calls: [{ state: "completed", sdkStopReason: "stop" }] } } });
    expect(await page.evaluate(() => window.medclaw.request("run.active", {}))).toEqual({ ok: true, data: null });
    await expect(input).toHaveValue("draft survives necessary save failure");
    await expect(send).toBeEnabled();
    expect(requests).toHaveLength(before + 1);
  } finally {
    if (!blocker.stdin.writableEnded) blocker.stdin.end();
    if (blocker.exitCode === null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(() => { blocker.kill(); resolve(); }, 5000); })]); }
      finally { clearTimeout(timer); }
      await exited;
    }
  }
});

test("repeated authentication cancellation and Host restarts release owned resources", async () => {
  test.setTimeout(60000);
  const before = requests.length;
  const history = await page.evaluate(() => window.medclaw.request("run.read", { recent: true }));
  expect(history.ok).toBe(true);
  const listeners = await app.evaluate(({ ipcMain }) => ipcMain.listenerCount("medclaw:subscribe"));
  expect(listeners).toBe(1);
  for (let round = 0; round < 3; round++) {
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await page.getByLabel("Provider", { exact: true }).selectOption("openai");
    await page.getByRole("button", { name: "Sign in with API Key", exact: true }).click();
    const auth = page.getByRole("dialog", { name: "Provider sign-in", exact: true });
    await expect(auth.locator('input[type="password"]')).toBeVisible();
    const started = await page.evaluate(() => window.medclaw.request("model.auth.status", { providerId: "openai" }));
    if (!started.ok || !started.data.attempt) throw new Error("Expected a new accepted native authentication attempt");
    await auth.getByRole("button", { name: "Cancel this authentication", exact: true }).click();
    await auth.getByRole("alertdialog", { name: "Confirm authentication cancellation", exact: true }).getByRole("button", { name: "Confirm authentication cancellation", exact: true }).click();
    await expect(auth).toContainText("cancelled");
    expect(await page.evaluate(id => window.medclaw.request("model.auth.status", { providerId: "openai", authAttemptId: id }), started.data.attempt.id)).toMatchObject({ ok: true, data: { attempt: { state: "cancelled", pendingPromptId: null } } });
    const details = page.getByRole("complementary", { name: "Run details", exact: true });
    if (await details.isVisible()) {
      await page.getByRole("button", { name: "Close run details", exact: true }).click();
      await expect(details).not.toBeVisible();
    }
    await page.getByRole("button", { name: "View run details", exact: true }).click();
    await expect(details).toBeVisible();
    await page.getByRole("button", { name: "Close run details", exact: true }).click();
    await expect(details).not.toBeVisible();
    const lockPath = join(dataRoot, "runtime/host.lock");
    const old = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; instanceId: string };
    const host = await page.evaluate(() => window.medclaw.request("host.read", {}));
    expect(host).toMatchObject({ ok: true, data: { instanceId: old.instanceId, state: "ready" } });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Restart Host", exact: true }).click();
    await expect.poll(async () => {
      const current = await page.evaluate(() => window.medclaw.request("host.read", {}));
      return current.ok && current.data.state === "ready" && current.data.instanceId !== old.instanceId;
    }).toBe(true);
    const current = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; instanceId: string };
    expect(current.instanceId).not.toBe(old.instanceId);
    expect(current.pid).not.toBe(old.pid);
    expect(() => process.kill(old.pid, 0)).toThrow();
    expect(() => process.kill(current.pid, 0)).not.toThrow();
    expect(await app.evaluate(({ ipcMain }) => ipcMain.listenerCount("medclaw:subscribe"))).toBe(listeners);
    expect(await page.evaluate(() => window.medclaw.request("run.active", {}))).toEqual({ ok: true, data: null });
    expect(requests).toHaveLength(before);
  }
  expect(await page.evaluate(() => window.medclaw.request("run.read", { recent: true }))).toEqual(history);
});
