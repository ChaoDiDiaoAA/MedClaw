import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const args = Bun.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--data-root")) throw new Error("Usage: bun run dev:desktop [--data-root <isolated directory>]");
const dataRoot = resolve(args[1] ?? join(root, ".medclaw-dev"));
const source = join(import.meta.dir, "src");
for (const path of [join(source, "main/index.ts"), join(source, "preload/index.ts"), join(source, "renderer/App.tsx"), join(root, "apps/host/src/main.ts")]) {
  if (!existsSync(path)) throw new Error(`Desktop entry is not implemented: ${path}`);
}
const output = join(root, ".build/desktop");
for (const part of ["main", "preload", "renderer"]) {
  const html = part === "renderer";
  const build = await Bun.build({
    entrypoints: [join(source, part, html ? "index.html" : "index.ts")],
    outdir: join(output, part), target: html ? "browser" : "node",
    format: html ? "esm" : "cjs", external: html ? [] : ["electron"],
    ...(html ? {} : { naming: "index.cjs" }),
  });
  if (!build.success) throw new AggregateError(build.logs, `Desktop ${part} build failed`);
}
mkdirSync(dataRoot, { recursive: true });
const electronPath: string = createRequire(import.meta.url)("electron");
const controlToken = crypto.randomUUID();
const env: NodeJS.ProcessEnv = { ...process.env, MEDCLAW_HOST_ENTRY: join(root, "apps/host/src/main.ts"), MEDCLAW_BUN_EXECUTABLE: process.execPath, MEDCLAW_DEV_CONTROL_TOKEN: controlToken };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, [join(output, "main/index.cjs"), "--medclaw-data-root", dataRoot], { env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
// Ask Main to close its Host and DB before exiting; an OS kill cannot confirm that cleanup.
const stop = () => { if (child.connected) child.send({ token: controlToken, command: "quit" }, () => {}); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try { process.exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); }); }
finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
