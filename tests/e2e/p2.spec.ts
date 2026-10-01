import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer, type Server } from "node:http";

const root = resolve(import.meta.dirname, "../.."), bun = process.env.MEDCLAW_BUN_EXECUTABLE ?? "bun";
let app: ElectronApplication, page: Page, dataRoot: string, server: Server;
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
  app = await electron.launch({ executablePath: electronPath, args: ["-r", join(dirname(core), "lib/server/electron/loader.js"), join(root, ".build/desktop/main/index.cjs"), "--medclaw-data-root", dataRoot], env, timeout: 30000 });
  page = await app.firstWindow(); await expect(page.getByText("Host ready", { exact: true }).first()).toBeVisible({ timeout: 30000 });
  const configured = await page.evaluate(async baseUrl => {
    const directory = await window.medclaw.request("model.read", {}); if (!directory.ok) throw new Error(directory.error.code);
    const token = await window.medclaw.secretInput({ providerId: "p2-ui", purpose: "custom_api_key", value: "P2-UI-FIXTURE-SECRET" }); if (!token.ok) throw new Error(token.error.code);
    const saved = await window.medclaw.request("model.custom.save", { expectedConfigVersion: directory.data.configVersion, credentialInput: token.data.token,
      definition: { providerId: "p2-ui", name: "P2 fixture", api: "openai-completions", baseUrl, models: ["first", "second"].map(id => ({ id, name: `P2 ${id}`, input: ["text"], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null })) } });
    if (!saved.ok) throw new Error(saved.error.code);
    return window.medclaw.request("model.configure", { provider: "p2-ui", modelId: "first", expectedConfigVersion: saved.data.configVersion });
  }, baseUrl);
  expect(configured.ok).toBe(true);
});
test.afterAll(async () => { await app?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); if (dataRoot) rmSync(dataRoot, { recursive: true, force: true }); });
const input = () => page.getByLabel("消息文本", { exact: true });
async function select(id: number) { await page.getByRole("button", { name: `新会话 ${id}`, exact: true }).click(); await expect(page.getByTestId("current-session")).toContainText(`新会话 ${id}`); }
async function send(text: string) { await input().fill(text); await page.getByRole("button", { name: "发送", exact: true }).click(); await expect(page.getByTestId("run-output")).toHaveText("P2 reply OK"); await expect(input()).toHaveValue(""); }

test("New Session and A/B navigation preserve independent drafts", async () => {
  await page.getByRole("button", { name: "New Session", exact: true }).click(); await expect(page.getByTestId("current-session")).toContainText("新会话 1");
  await input().fill("A draft"); await page.getByRole("button", { name: "New Session", exact: true }).click(); await expect(page.getByTestId("current-session")).toContainText("新会话 2");
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
  await page.getByRole("button", { name: "管理模型", exact: true }).click(); await page.getByLabel("搜索模型").fill("P2 second");
  await page.getByRole("button", { name: "选择 P2 second", exact: true }).click(); await page.getByRole("button", { name: "用于当前会话", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click(); await expect(page.getByTestId("session-model")).toContainText("second");
  const after = await page.evaluate(() => window.medclaw.request("model.read", {}));
  if (!after.ok) throw new Error("directory unavailable");
  expect(after.data.configVersion).toBe(before.data.configVersion); expect(after.data.selection).toEqual(before.data.selection);
  await select(2); await expect(page.getByTestId("session-model")).toContainText("first"); await select(1); await send("A with changed model");
  expect(requests.at(-1)!.model).toBe("second"); expect(JSON.stringify(requests.at(-1)!.messages)).toContain("A unique history");
  await page.getByRole("button", { name: "管理模型", exact: true }).click(); await page.getByRole("button", { name: "发布全局默认模型", exact: true }).click();
  await expect(page.getByText("模型选择已发布", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click(); await page.getByRole("button", { name: "New Session", exact: true }).click();
  await expect(page.getByTestId("session-model")).toContainText("second"); await select(2); await expect(page.getByTestId("session-model")).toContainText("first");
});
test("running A can be browsed from B without losing B draft or retargeting Stop", async () => {
  await select(1); const before = requests.length; await input().fill("slow A"); await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => requests.length).toBe(before + 1); await select(2); await input().fill("B remains unsent");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled(); await expect(page.getByTestId("running-session")).toContainText("新会话 1");
  await expect(page.getByTestId("run-output")).not.toHaveText("P2 reply"); await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect(input()).toHaveValue("B remains unsent"); await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  await select(1); await expect(page.getByText("已取消并保存", { exact: true })).toBeVisible(); expect(requests).toHaveLength(before + 1);
});
test("terminal and old-instance Agent notices cannot replace saved text; Host restart cannot resume history", async () => {
  const result = await page.evaluate(async () => { const h = await window.medclaw.request("host.read", {}), s = await window.medclaw.request("session.read", { sessionId: 1 }); return { h, s }; });
  if (!result.h.ok || !result.s.ok) throw new Error("facts unavailable");
  const run = await page.evaluate(() => window.medclaw.request("run.read", { recent: true, sessionId: 1, limit: 1 }));
  if (!run.ok || run.data.kind !== "recent") throw new Error("run unavailable");
  const text = await page.getByTestId("run-output").innerText();
  await app.evaluate(({ BrowserWindow }, ids) => { const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    // A bounded notification cache may evict this older known terminal Run.
    for (let runId = 1000; runId < 1052; runId++) contents.send("medclaw:notice", { type: "agent.settled", instanceId: ids.instanceId, runId, sessionId: 2, noticeSequence: 1, status: "completed" });
    for (const instanceId of [ids.instanceId, "old-host"]) contents.send("medclaw:notice", { type: "agent.preview", instanceId, runId: ids.runId, sessionId: 1, noticeSequence: 999, text: "late text", truncated: false });
  }, { instanceId: result.h.data.instanceId!, runId: run.data.runs[0]!.id });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByTestId("run-output")).toHaveText(text);
  const restarted = await page.evaluate(instanceId => window.medclaw.request("host.restart", { expectedInstanceId: instanceId }), result.h.data.instanceId!); expect(restarted.ok).toBe(true);
  await expect(page.getByText("本次启动无法继续此会话，请新建会话。", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
});
declare global { interface Window { harness: { show(id: number, instance?: string): void; count(): number; resolve(): void; saved(): number } } }
test("Run details reject late pages, rereads and save replies after viewing another Run or Host", async () => {
  const html = join(root, ".build/desktop/p2-details.html"), entry = join(root, "apps/desktop/node_modules/.cache/medclaw-p2-details.tsx");
  mkdirSync(dirname(entry), {recursive:true});
  writeFileSync(entry, `
    import {createRoot} from "react-dom/client";
    import {RunDetails} from "../../src/renderer/run-details";
    let current, host, replies=[], saved=0;
    const root=createRoot(document.getElementById("root"));
    const make=id=>({id,kind:"provider",status:"completed",model:{provider:"fixture",modelId:String(id),api:"fixture",maxOutputTokens:1,capabilitySource:"pi_catalog"},policy:{timeoutMs:1000,maxRetries:0,maxRetryDelayMs:0},referenceDate:"2026-10-01",timezone:"UTC",goal:"answer",operationRef:"op"+id,instanceId:host,inputText:"",priorRunId:null,persistence:"committed",createdAt:"time",startedAt:null,cancelRequestedAt:null,stoppedAt:null,endedAt:null,error:null,calls:[],output:{text:"saved "+id,offset:0,nextOffset:16384,totalChars:32768}});
    window.medclaw={request:(method,payload)=>payload.recent?Promise.resolve({ok:true,data:{kind:"recent",runs:[],nextBeforeRunId:null}}):new Promise(resolve=>replies.push({method,payload,resolve}))};
    function render(){root.render(<RunDetails run={make(current)} host={{state:"ready",instanceId:host}} viewSessionId={current} tab="runtime" active={{runId:1,persistencePending:true}} control={null} onTab={()=>{}} onClose={()=>{}} onError={()=>{}} onRun={r=>{current=r.id;render()}} onRetrySaved={()=>saved++}/>);}
    window.harness={show:(id,instance="host-1")=>{current=id;host=instance;render()},count:()=>replies.length,resolve:()=>{const pending=replies.shift(),value=make(pending.payload.runId);value.output={text:"late A text",offset:16384,nextOffset:null,totalChars:32768};pending.resolve({ok:true,data:pending.method==="run.retrySave"?value:{kind:"one",run:value}})},saved:()=>saved};
    window.harness.show(1);
  `);
  writeFileSync(html, '<meta charset="utf-8"><div id="root"></div><script src="./p2-details.js"></script>');
  execFileSync(bun, ["build", entry, "--target=browser", "--outfile=.build/desktop/p2-details.js"], {cwd:root});
  const opened = app.waitForEvent("window");
  await app.evaluate(async ({BrowserWindow},path)=>{const window=new BrowserWindow({show:true,width:1440,height:900,webPreferences:{contextIsolation:true,sandbox:true}});await window.loadFile(path);},html);
  const panel=await opened;
  try {
    for(const action of ["读取下一段全文","重读此 Run","重试保存"]) {
      await panel.evaluate(()=>window.harness.show(1));await expect(panel.locator(".detail-run")).toContainText("Run 1");
      await panel.getByRole("button",{name:action,exact:true}).click();
      await expect.poll(()=>panel.evaluate(()=>window.harness.count())).toBe(1);
      await panel.evaluate(()=>window.harness.show(2));await expect(panel.getByTestId("saved-output")).toHaveText("saved 2");
      await panel.evaluate(()=>window.harness.resolve());
      await panel.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(panel.locator(".detail-run")).toContainText("Run 2");await expect(panel.getByTestId("saved-output")).toHaveText("saved 2");
      await expect(panel.getByRole("button",{name:"读取下一段全文",exact:true})).toBeEnabled();
    }
    await panel.evaluate(()=>window.harness.show(1));await expect(panel.locator(".detail-run")).toContainText("Run 1");
    await panel.getByRole("button",{name:"读取下一段全文",exact:true}).click();await expect.poll(()=>panel.evaluate(()=>window.harness.count())).toBe(1);
    await panel.evaluate(()=>window.harness.show(1,"host-2"));await expect(panel.getByTestId("saved-output")).toHaveText("saved 1");await panel.evaluate(()=>window.harness.resolve());
    await panel.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(panel.getByTestId("saved-output")).toHaveText("saved 1");
  } finally { await panel.close(); }
});
