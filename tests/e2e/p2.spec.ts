import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import type { MessageStreamSnapshot, OpenEventSubscriptionInput, OpenEventSubscriptionResult } from '../../packages/contracts/src/event';

const root = resolve(import.meta.dirname, "../.."), bun = process.env.MEDCLAW_BUN_EXECUTABLE ?? "bun";
let app: ElectronApplication, page: Page, dataRoot: string, server: Server;
type EventGate = { active: Record<string, OpenEventSubscriptionInput>; replies: OpenEventSubscriptionResult[] };
type EventMain = typeof globalThis & { __p2EventGate: EventGate };
let terminalStream: MessageStreamSnapshot | null = null;
const requests: { model: string; messages: { role: string; content: unknown }[] }[] = [];
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  test.setTimeout(90000);
  for (const part of ["main", "preload"]) execFileSync(bun, ["build", `apps/desktop/src/${part}/index.ts`, "--target=node", "--format=cjs", "--external=electron", `--outfile=.build/desktop/${part}/index.cjs`], { cwd: root });
  execFileSync(bun, ["build", "apps/desktop/src/renderer/index.html", "--target=browser", "--outdir=.build/desktop/renderer"], { cwd: root });
  dataRoot = mkdtempSync(join(tmpdir(), "medclaw-p2-e2e-"));
  server = createServer(async (request, response) => {
    let body = ""; request.setEncoding("utf8"); for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); requests.push(payload);
    const text = JSON.stringify(payload.messages.filter((message: { role: string }) => message.role === "user").at(-1)?.content ?? "");
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (chunk: unknown) => response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    send({ id: "p2-ui", model: payload.model, choices: [{ index: 0, delta: { role: "assistant", content: "P2 reply" }, finish_reason: null }] });
    const timer = setTimeout(() => {
      send({ id: "p2-ui", model: payload.model, choices: [{ index: 0, delta: { content: " OK" }, finish_reason: "stop" }] });
      send({ id: "p2-ui", choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }); response.end("data: [DONE]\n\n");
    }, text.includes("slow") ? 30000 : 100);
    response.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const require = createRequire(join(root, "apps/desktop/package.json")), electronPath: string = require("electron");
  const playwright = createRequire(createRequire(import.meta.url).resolve("@playwright/test/package.json")), core = createRequire(playwright.resolve("playwright/package.json")).resolve("playwright-core/package.json");
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])), MEDCLAW_HOST_ENTRY: join(root, "apps/host/src/main.ts"), MEDCLAW_BUN_EXECUTABLE: execFileSync(bun, ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" }).trim() };
  delete env.ELECTRON_RUN_AS_NODE;
  const eventSeam = join(dataRoot, 'event-observation.cjs');
  writeFileSync(eventSeam, `const {ipcMain}=require('electron'),original=ipcMain.handle.bind(ipcMain);const state=globalThis.__p2EventGate={active:{},replies:[]};
    ipcMain.handle=(channel,listener)=>original(channel,async(event,envelope)=>{const result=await listener(event,envelope);
      if(channel==='medclaw:request'&&envelope.method==='event.subscribe'&&result.ok){const p=envelope.payload;
        if(p.action==='open'){state.active[p.subscriptionId]=structuredClone(p);state.replies.push(structuredClone(result.data));if(state.replies.length>200)state.replies.shift();}
        else delete state.active[p.subscriptionId];}
      return result;});`);
  app = await electron.launch({ executablePath: electronPath, args: ["-r", join(dirname(core), "lib/server/electron/loader.js"), '-r', eventSeam, join(root, ".build/desktop/main/index.cjs"), "--medclaw-data-root", dataRoot], env, timeout: 30000 });
  page = await app.firstWindow(); await expect(page.getByText("Host ready", { exact: true }).first()).toBeVisible({ timeout: 30000 });
  const configured = await page.evaluate(async baseUrl => {
    const directory = await window.medclaw.request("model.read", {}); if (!directory.ok) throw new Error("setup directory: " + directory.error.code);
    const token = await window.medclaw.secretInput({ providerId: "p2-ui", purpose: "custom_api_key", value: "P2-UI-FIXTURE-SECRET" }); if (!token.ok) throw new Error("setup token: " + token.error.code);
    const saved = await window.medclaw.request("model.custom.save", { expectedConfigVersion: directory.data.configVersion, credentialInput: token.data.token,
      definition: { providerId: "p2-ui", name: "P2 fixture", api: "openai-completions", baseUrl, models: ["first", "second"].map(id => ({ id, name: `P2 ${id}`, input: ["text"], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null })) } });
    if (!saved.ok) throw new Error("setup saved: " + saved.error.code);
    const unconfigured = await window.medclaw.request("model.custom.save", { expectedConfigVersion: saved.data.configVersion,
      definition: { providerId: "p2-unconfigured", name: "Unconfigured fixture", api: "openai-completions", baseUrl,
        models: [{ id: "missing-key", name: "P2 unconfigured", input: ["text"], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] } });
    if (!unconfigured.ok) throw new Error("setup unconfigured: " + unconfigured.error.code + " " + JSON.stringify(await window.medclaw.request("diagnostics.read", { categories: ["errors"] })));
    return window.medclaw.request("model.configure", { provider: "p2-ui", modelId: "first", expectedConfigVersion: unconfigured.data.configVersion });
  }, baseUrl);
  expect(configured.ok).toBe(true);
});
test.afterAll(async () => { await app?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); if (dataRoot) rmSync(dataRoot, { recursive: true, force: true }); });
const input = () => page.getByLabel("Message text", { exact: true });
async function select(id: number) { await page.getByRole("button", { name: `New Session ${id}`, exact: true }).click(); await expect(page.getByTestId("current-session")).toContainText(`New Session ${id}`); }
async function send(text: string) {
  const original = await page.evaluate(async () => {
    const workspace = await window.medclaw.request("workspace.read", {}); if (!workspace.ok || !workspace.data.sessionId) throw Error("Missing selected Session");
    const session = await window.medclaw.request("session.read", { sessionId: workspace.data.sessionId }); if (!session.ok || !session.data) throw Error("Missing original submission sequence");
    return { sessionId: workspace.data.sessionId, sequence: session.data.session.nextSubmissionSequence };
  });
  await input().fill(text); await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(async original => {
    const runs = await window.medclaw.request("run.read", { recent: true, sessionId: original.sessionId, limit: 1 });
    if (!runs.ok || runs.data.kind !== "recent") return false;
    const run = runs.data.runs[0]; return run?.kind === "agent" && run.clientSequence === original.sequence && run.status === "completed";
  }, original)).toBe(true);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const facts = await page.evaluate(async () => {
    const workspace = await window.medclaw.request("workspace.read", {}); if (!workspace.ok || !workspace.data.sessionId) throw Error("Missing selected Session");
    const runs = await window.medclaw.request("run.read", { recent: true, sessionId: workspace.data.sessionId, limit: 1 });
    const history = await window.medclaw.request("session.messages.read", { sessionId: workspace.data.sessionId });
    if (!runs.ok || runs.data.kind !== "recent" || !runs.data.runs[0] || !history.ok) throw Error("Missing saved native exchange");
    const runId = runs.data.runs[0].id;
    return { user: history.data.items.find(item => item.runId === runId && item.displayRole === "user")?.nativeEntryId, assistant: history.data.items.findLast(item => item.runId === runId && item.displayRole === "assistant")?.nativeEntryId };
  });
  expect(facts.user).toBeDefined(); expect(facts.assistant).toBeDefined();
  const history = page.getByTestId("chat-native-messages");
  await expect(history.locator(`[data-native-entry-id="${facts.user}"] .answer-text`)).toHaveText(text);
  await expect(history.locator(`[data-native-entry-id="${facts.assistant}"] .answer-text`)).toHaveText("P2 reply OK"); await expect(input()).toHaveValue("");
}

test("New Session and A/B navigation preserve independent drafts", async () => {
  await expect(page.getByRole("heading", { name: "Create a session", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Configure models", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("button", { name: "New Session", exact: true }).click(); await expect(page.getByTestId("current-session")).toContainText("New Session 1");
  await expect(page.getByRole("heading", { name: "Start a conversation", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "View run details", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage models", exact: true })).toBeVisible();
  await expect(input()).toHaveAttribute("placeholder", "Type a message…");
  await expect(page.getByText("Shift+Enter for a new line", { exact: true })).toBeVisible();
  await expect(page.locator(".reference-fields summary")).toHaveText("Message time context");
  await expect(page.locator(".sidebar-note")).toContainText("Each session keeps its context during this app session.");
  await expect(page.getByText(/^Model for next message:/)).toHaveCount(0);
  await input().fill("First line\nSecond line\nThird line");
  await expect.poll(() => input().evaluate(element => element.scrollHeight - element.clientHeight)).toBe(0);
  await input().fill("中文输入😀"); await expect(input()).toHaveValue("中文输入😀");
  await page.screenshot({ path: test.info().outputPath("desktop-english-chat.png") });
  const picker = page.getByRole("combobox", { name: "Session model", exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("option", { name: "P2 first · p2-ui / first", exact: true })).toHaveCount(1);
  await expect(picker.getByRole("option", { name: "P2 second · p2-ui / second", exact: true })).toHaveCount(1);
  await expect(picker.locator("option").filter({ hasText: "p2-unconfigured" })).toHaveCount(0);
  await input().fill("A draft");
  await page.getByRole("button", { name: "Manage models", exact: true }).click(); await page.getByLabel("Search models").fill("P2 unconfigured");
  await page.getByRole("button", { name: "Select P2 unconfigured", exact: true }).click(); await page.getByRole("button", { name: "Use for this session", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(picker).toHaveValue("");
  await expect(picker.locator("option").filter({ hasText: "p2-unconfigured" })).toHaveCount(0);
  await expect(page.getByTestId("session-model")).toHaveText("The selected model is unavailable. Select a configured model.");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(input()).toHaveValue("A draft");
  await picker.selectOption({ label: "P2 first · p2-ui / first" });
  await page.getByRole("button", { name: "New Session", exact: true }).click(); await expect(page.getByTestId("current-session")).toContainText("New Session 2");
  await input().fill("B draft"); await select(1); await expect(input()).toHaveValue("A draft"); await select(2); await expect(input()).toHaveValue("B draft");
  expect(requests).toHaveLength(0);
});
test("A→B→A native HTTP inputs prove history isolation and continuing dialogue", async () => {
  await select(1); await send("A unique history"); await select(2); await send("B unique history"); await select(1); await send("A follow-up");
  expect(requests).toHaveLength(3); expect(JSON.stringify(requests[1]!.messages)).not.toContain("A unique history");
  expect(JSON.stringify(requests[2]!.messages)).toContain("A unique history"); expect(JSON.stringify(requests[2]!.messages)).not.toContain("B unique history");
  const sessions = await page.evaluate(async () => [await window.medclaw.request("session.read", { sessionId: 1 }), await window.medclaw.request("session.read", { sessionId: 2 })]);
  if (!sessions[0]!.ok || !sessions[1]!.ok || !sessions[0]!.data || !sessions[1]!.data) throw new Error("session unavailable");
  expect(sessions[0]!.data.session.nativeSessionId).not.toBe(sessions[1]!.data.session.nativeSessionId); expect(sessions[0]!.data.history.messages).toHaveLength(4);
});
test("Models session choice changes only A; global default publication is a separate action", async () => {
  const before = await page.evaluate(() => window.medclaw.request("model.read", {}));
  if (!before.ok) throw new Error("directory unavailable");
  await page.getByRole("button", { name: "Manage models", exact: true }).click(); await page.getByLabel("Search models").fill("P2 second");
  await page.getByRole("button", { name: "Select P2 second", exact: true }).click(); await page.getByRole("button", { name: "Use for this session", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click(); await expect(page.getByRole("combobox", { name: "Session model", exact: true })).toHaveValue(JSON.stringify(["p2-ui", "second"]));
  const after = await page.evaluate(() => window.medclaw.request("model.read", {}));
  if (!after.ok) throw new Error("directory unavailable");
  expect(after.data.configVersion).toBe(before.data.configVersion); expect(after.data.selection).toEqual(before.data.selection);
  await select(2); await expect(page.getByRole("combobox", { name: "Session model", exact: true })).toHaveValue(JSON.stringify(["p2-ui", "first"])); await select(1); await send("A with changed model");
  expect(requests.at(-1)!.model).toBe("second"); expect(JSON.stringify(requests.at(-1)!.messages)).toContain("A unique history");
  await page.getByRole("button", { name: "Manage models", exact: true }).click(); await page.getByRole("button", { name: "Set as default model", exact: true }).click();
  await expect(page.getByText("Default model published", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click(); await page.getByRole("button", { name: "New Session", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Session model", exact: true })).toHaveValue(JSON.stringify(["p2-ui", "second"])); await select(2); await expect(page.getByRole("combobox", { name: "Session model", exact: true })).toHaveValue(JSON.stringify(["p2-ui", "first"]));
});
test("Chat model selection preserves drafts and B while the next A request uses the chosen model", async () => {
  const before = await page.evaluate(() => window.medclaw.request("model.read", {}));
  if (!before.ok) throw new Error("directory unavailable");
  await select(1); await input().fill("A inline model choice");
  await page.getByRole("combobox", { name: "Session model", exact: true }).selectOption({ label: "P2 first · p2-ui / first" });
  await expect(input()).toHaveValue("A inline model choice");
  await expect(page.getByRole("combobox", { name: "Session model", exact: true })).toHaveValue(JSON.stringify(["p2-ui", "first"]));
  await select(2); await expect(page.getByRole("combobox", { name: "Session model", exact: true })).toHaveValue(JSON.stringify(["p2-ui", "first"]));
  await select(1); await expect(input()).toHaveValue("A inline model choice");
  await send("A inline model choice");
  expect(requests.at(-1)!.model).toBe("first");
  expect(JSON.stringify(requests.at(-1)!.messages)).toContain("A unique history");
  expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain("B unique history");
  expect(await page.evaluate(() => window.medclaw.request("model.read", {}))).toMatchObject({ ok: true, data: { configVersion: before.data.configVersion, selection: before.data.selection } });
});
test("running A can be browsed from B without losing B draft or retargeting Stop", async () => {
  await select(1); const before = requests.length; await input().fill("slow A"); await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requests.length).toBe(before + 1);
  await page.getByRole("combobox", { name: "Session model", exact: true }).selectOption({ label: "P2 second · p2-ui / second" });
  await expect(page.getByRole("combobox", { name: "Session model", exact: true })).toHaveValue(JSON.stringify(["p2-ui", "second"]));
  const running = await page.evaluate(() => window.medclaw.request("run.read", { recent: true, sessionId: 1, limit: 1 }));
  expect(running).toMatchObject({ ok: true, data: { kind: "recent", runs: [{ model: { modelId: "first" } }] } });
  if (!running.ok || running.data.kind !== 'recent') throw new Error('Missing actual running A');
  const originalRunId = running.data.runs[0]!.id;
  await expect(page.getByTestId('temporary-message').last().locator('.answer-text')).toHaveText('P2 reply');
  await expect.poll(async () => app.evaluate((_, runId) => (globalThis as EventMain).__p2EventGate.replies.some(reply => reply.runId === runId && reply.snapshots.some(snapshot => snapshot.type === 'message.snapshot' && snapshot.blocks.some(block => block.text === 'P2 reply'))), originalRunId)).toBe(true);
  terminalStream = await app.evaluate((_, runId) => (globalThis as EventMain).__p2EventGate.replies.findLast(reply => reply.runId === runId && reply.snapshots.some(snapshot => snapshot.type === 'message.snapshot' && snapshot.blocks.some(block => block.text === 'P2 reply')))!.snapshots.findLast((snapshot): snapshot is MessageStreamSnapshot => snapshot.type === 'message.snapshot' && snapshot.blocks.some(block => block.text === 'P2 reply'))!, originalRunId);
  expect(terminalStream).toMatchObject({ runId: originalRunId, sessionId: 1, phase: 'streaming' });
  expect(requests.at(-1)!.model).toBe("first");
  await select(2); await input().fill("B remains unsent");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled(); await expect(page.getByTestId("running-session")).toContainText("New Session 1");
  await expect(page.getByTestId("run-output")).toHaveCount(0); await expect(page.getByTestId('temporary-run-area')).toHaveCount(0); await expect(page.getByTestId("chat-native-messages")).not.toContainText("slow A"); await page.getByRole("button", { name: "Stop generating", exact: true }).click();
  await expect(input()).toHaveValue("B remains unsent"); await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await select(1); await expect(page.getByText("Cancelled and saved", { exact: true })).toBeVisible(); expect(requests).toHaveLength(before + 1);
});
test("terminal and old-instance Agent notices cannot replace saved text; Host restart cannot resume history", async () => {
  const result = await page.evaluate(async () => { const h = await window.medclaw.request("host.read", {}), s = await window.medclaw.request("session.read", { sessionId: 1 }); return { h, s }; });
  if (!result.h.ok || !result.s.ok) throw new Error("facts unavailable");
  const run = await page.evaluate(() => window.medclaw.request("run.read", { recent: true, sessionId: 1, limit: 1 }));
  if (!run.ok || run.data.kind !== "recent") throw new Error("run unavailable");
  await page.getByRole("button", { name: "View run details", exact: true }).click(); await page.getByRole("tab", { name: "Run details", exact: true }).click();
  await page.getByRole("button", { name: `View Run ${run.data.runs[0]!.id}`, exact: true }).click();
  const text = await page.getByTestId("saved-output").innerText();
  if (!terminalStream || terminalStream.runId !== run.data.runs[0]!.id) throw new Error('Missing original observed stream identity');
  const current = await app.evaluate((_, runId) => Object.values((globalThis as EventMain).__p2EventGate.active).find(input => input.runId === runId), run.data.runs[0]!.id);
  if (!current) throw new Error('Missing actual current display sid');
  await app.evaluate(({ BrowserWindow }, ids) => { const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    // A bounded notification cache may evict this older known terminal Run.
    for (let runId = 1000; runId < 1052; runId++) contents.send("medclaw:notice", { type: "agent.settled", instanceId: ids.instanceId, runId, sessionId: 2, noticeSequence: 1, status: "completed" });
    // Inject display faults using a proved original SDK object and the real
    // current sid. Neither packet creates or repeats a domain operation.
    for (const instanceId of [ids.instanceId, "old-host"]) contents.send("medclaw:notice", { type: 'event.stream', instanceId, subscriptionId: ids.subscriptionId,
      snapshot: { ...ids.snapshot, phase: 'streaming', revision: ids.snapshot.revision + 999, blocks: [{ contentIndex: 0, text: 'late text' }], totalChars: 'late text'.length, truncated: false } });
  }, { instanceId: result.h.data.instanceId!, runId: run.data.runs[0]!.id, subscriptionId: current.subscriptionId, snapshot: terminalStream });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByTestId("saved-output")).toHaveText(text); await expect(page.getByTestId("run-output")).toHaveCount(0); await expect(page.getByTestId('temporary-run-area')).toHaveCount(0); await expect(page.getByTestId('chat-native-messages')).not.toContainText('late text');
  const restarted = await page.evaluate(instanceId => window.medclaw.request("host.restart", { expectedInstanceId: instanceId }), result.h.data.instanceId!); expect(restarted.ok).toBe(true);
  await expect(page.getByText("This session cannot continue after a restart. Create a new session.", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Close run details", exact: true }).click();
});

declare global { interface Window { modelReadGate: { release(): void } } }
test("a late directory read initializes the empty Session model without overwriting a later explicit choice", async () => {
  await page.getByRole("button", { name: "New Session", exact: true }).click();
  const current = await page.evaluate(() => window.medclaw.request("workspace.read", {}));
  if (!current.ok || !current.data.sessionId) throw new Error("session unavailable");
  await expect(page.getByTestId("current-session")).toContainText(`New Session ${current.data.sessionId}`);
  await page.addInitScript(() => {
    const bridge = window.medclaw;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    window.modelReadGate = { release };
    Object.defineProperty(window, "medclaw", { value: { ...bridge, request: async (method: Parameters<typeof bridge.request>[0], payload: never, operationRef?: string) => {
      const result = await bridge.request(method, payload, operationRef);
      if (method === "model.read") await gate;
      return result;
    } } });
  });
  await page.reload();
  await expect(page.getByTestId("current-session")).toContainText(`New Session ${current.data.sessionId}`);
  await input().fill("draft typed before model directory");
  await page.evaluate(() => window.modelReadGate.release());
  const directory = await page.evaluate(() => window.medclaw.request("model.read", {}));
  if (!directory.ok || !directory.data.selection) throw new Error("model unavailable");
  await expect(page.getByRole("combobox", { name: "Session model", exact: true })).toHaveValue(JSON.stringify([directory.data.selection.provider, directory.data.selection.modelId]));
  await expect(input()).toHaveValue("draft typed before model directory");
  const alternative = directory.data.selection.modelId === "first" ? "second" : "first";
  await page.getByRole("combobox", { name: "Session model", exact: true }).selectOption({ label: `P2 ${alternative} · p2-ui / ${alternative}` });
  await page.getByRole("button", { name: "Manage models", exact: true }).click();
  await page.getByRole("button", { name: "Reload published directory", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Session model", exact: true })).toHaveValue(JSON.stringify(["p2-ui", alternative]));
  await expect(input()).toHaveValue("draft typed before model directory");
});
declare global { interface Window { harness: { show(id: number, instance?: string): void; count(): number; resolve(): void; saved(): number; diagnostics(): void } } }
test("Run details reject late pages, rereads and save replies after viewing another Run or Host", async () => {
  const html = join(root, ".build/desktop/p2-details.html"), entry = join(root, "apps/desktop/node_modules/.cache/medclaw-p2-details.tsx");
  mkdirSync(dirname(entry), {recursive:true});
  writeFileSync(entry, `
    import {createRoot} from "react-dom/client";
    import {RunDetails} from "../../src/renderer/run-details";
    import {Diagnostics} from "../../src/renderer/diagnostics";
    let current, host, replies=[], saved=0;
    const root=createRoot(document.getElementById("root"));
    const legacyError=Object.freeze({code:"provider_request_failed",category:"provider",message:"旧错误 CANARY-SECRET",retryable:true});
    const make=id=>({id,kind:"provider",status:id===1?"failed":"completed",model:{provider:"fixture",modelId:String(id),api:"fixture",maxOutputTokens:1,capabilitySource:"pi_catalog"},policy:{timeoutMs:1000,maxRetries:0,maxRetryDelayMs:0},referenceDate:"2026-10-01",timezone:"UTC",goal:"answer",operationRef:"op"+id,instanceId:host,inputText:"",priorRunId:null,persistence:"committed",createdAt:"time",startedAt:null,cancelRequestedAt:null,stoppedAt:null,endedAt:null,error:id===1?legacyError:null,calls:[],output:{text:"saved "+id,offset:0,nextOffset:16384,totalChars:32768}});
    window.medclaw={request:(method,payload)=>method==="diagnostics.read"?Promise.resolve({ok:true,data:{partial:true,missingSources:["host"],host:{state:"stopped",instanceId:null},entries:[{at:"time",source:"main",category:"errors",message:"旧摘要 CANARY-SECRET",error:legacyError}]}}):payload.recent?Promise.resolve({ok:true,data:{kind:"recent",runs:[],nextBeforeRunId:null}}):new Promise(resolve=>replies.push({method,payload,resolve}))};
    function render(){root.render(<RunDetails run={make(current)} host={{state:"ready",instanceId:host}} viewSessionId={current} tab="runtime" active={{runId:1,persistencePending:true}} control={null} onTab={()=>{}} onClose={()=>{}} onError={()=>{}} onRun={r=>{current=r.id;render()}} onRetrySaved={()=>saved++}/>);}
    window.harness={show:(id,instance="host-1")=>{current=id;host=instance;render()},count:()=>replies.length,resolve:()=>{const pending=replies.shift(),value=make(pending.payload.runId);value.output={text:"late A text",offset:16384,nextOffset:null,totalChars:32768};pending.resolve({ok:true,data:pending.method==="run.retrySave"?value:{kind:"one",run:value}})},saved:()=>saved,diagnostics:()=>root.render(<Diagnostics onError={()=>{}}/>)};
    window.harness.show(1);
  `);
  writeFileSync(html, '<meta charset="utf-8"><div id="root"></div><script src="./p2-details.js"></script>');
  execFileSync(bun, ["build", entry, "--target=browser", "--outfile=.build/desktop/p2-details.js"], {cwd:root});
  const opened = app.waitForEvent("window");
  await app.evaluate(async ({BrowserWindow},path)=>{const window=new BrowserWindow({show:true,width:1440,height:900,webPreferences:{contextIsolation:true,sandbox:true}});await window.loadFile(path);},html);
  const panel=await opened;
  try {
    await expect(panel.getByRole("alert")).toHaveText("provider_request_failed · The model request failed. Review the saved run status.");
    await expect(panel.getByRole("tab", { name: "Evidence", exact: true })).toBeDisabled();
    await expect(panel.locator("body")).not.toContainText("CANARY-SECRET");
    for(const action of ["Read next output section","Read this run again","Retry save"]) {
      await panel.evaluate(()=>window.harness.show(1));await expect(panel.locator(".detail-run")).toContainText("Run 1");
      await panel.getByRole("button",{name:action,exact:true}).click();
      await expect.poll(()=>panel.evaluate(()=>window.harness.count())).toBe(1);
      await panel.evaluate(()=>window.harness.show(2));await expect(panel.getByTestId("saved-output")).toHaveText("saved 2");
      await panel.evaluate(()=>window.harness.resolve());
      await panel.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(panel.locator(".detail-run")).toContainText("Run 2");await expect(panel.getByTestId("saved-output")).toHaveText("saved 2");
      await expect(panel.getByRole("button",{name:"Read next output section",exact:true})).toBeEnabled();
    }
    await panel.evaluate(()=>window.harness.show(1));await expect(panel.locator(".detail-run")).toContainText("Run 1");
    await panel.getByRole("button",{name:"Read next output section",exact:true}).click();await expect.poll(()=>panel.evaluate(()=>window.harness.count())).toBe(1);
    await panel.evaluate(()=>window.harness.show(1,"host-2"));await expect(panel.getByTestId("saved-output")).toHaveText("saved 1");await panel.evaluate(()=>window.harness.resolve());
    await panel.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(panel.getByTestId("saved-output")).toHaveText("saved 1");
    await panel.evaluate(()=>window.harness.diagnostics());
    await panel.getByRole("button",{name:"Read diagnostics",exact:true}).click();
    await expect(panel.getByRole("status")).toHaveText("Diagnostics partially available; missing sources: host");
    await expect(panel.locator(".diagnostic-entries")).toContainText("The model request failed. Review the saved run status.");
    await expect(panel.locator("body")).not.toContainText("CANARY-SECRET");
  } finally { await panel.close(); }
});
