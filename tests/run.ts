import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";

export type TestCategory = "unit" | "integration" | "e2e";
export interface StageReport {
  category: TestCategory;
  stage: string;
  discoveredFiles: number;
  discovered: number;
  executed: number;
  pass: number;
  fail: number;
  skip: number;
  exitCode: number;
}
const projectRoot = resolve(import.meta.dir, "..");
const stagePrefixes = { P1: "p1", P2: "p2" } as const;

export function discoverTests(category: TestCategory, stage: string, root = projectRoot): string[] {
  if (!["unit", "integration", "e2e"].includes(category)) throw new Error(`Unknown test category: ${category}`);
  if (!Object.hasOwn(stagePrefixes, stage)) throw new Error(`Unknown test stage: ${stage}`);
  const prefix = stagePrefixes[stage as keyof typeof stagePrefixes];
  const directory = join(root, "tests", category);
  if (!existsSync(directory)) return [];
  return [...new Bun.Glob(`${prefix}*.${category === "e2e" ? "spec" : "test"}.ts`).scanSync({ cwd: directory, absolute: true })].sort();
}

export async function runStage(category: TestCategory, stage: string, options: { root?: string } = {}): Promise<StageReport> {
  const root = resolve(options.root ?? projectRoot);
  const files = discoverTests(category, stage, root);
  const result: StageReport = { category, stage, discoveredFiles: files.length, discovered: 0, executed: 0, pass: 0, fail: 0, skip: 0, exitCode: 1 };
  if (!files.length) return result;
  const temporary = mkdtempSync(join(tmpdir(), "medclaw-test-report-"));
  const report = join(temporary, category === "e2e" ? "results.json" : "results.xml");
  try {
    const cli = category === "e2e"
      ? ["node", join(dirname(createRequire(import.meta.url).resolve("@playwright/test/package.json")), "cli.js"), "test", ...files.map(file => relative(root, file).replaceAll("\\", "/")), "--reporter=json"]
      : [process.execPath, "test", ...files, "--reporter=junit", `--reporter-outfile=${report}`];
    const child = Bun.spawn(cli, {
      cwd: root,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: report },
      stdout: "inherit", stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    process.stderr.write(stderr);
    let reportErrors = !existsSync(report);
    if (existsSync(report)) {
      if (category === "e2e") {
        const data = JSON.parse(readFileSync(report, "utf8")) as { stats: { expected: number; unexpected: number; flaky: number; skipped: number }; errors: unknown[] };
        result.pass = data.stats.expected + data.stats.flaky;
        result.fail = data.stats.unexpected;
        result.skip = data.stats.skipped;
        reportErrors = data.errors.length > 0;
      } else {
        const cases = readFileSync(report, "utf8").match(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g) ?? [];
        result.fail = cases.filter(test => /<(?:failure|error)\b/.test(test)).length;
        result.skip = cases.filter(test => /<skipped\b/.test(test)).length;
        result.pass = cases.length - result.fail - result.skip;
      }
    }
    if (category !== "e2e") {
      // Bun omits module-loading errors from JUnit; its final summary includes them.
      const summary = [...stderr.replaceAll("\r\n", "\n").matchAll(/(?:^|\n)\s*(\d+) pass\n(?:\s*(\d+) skip\n)?\s*(\d+) fail\b/g)].at(-1);
      if (summary) {
        result.pass = Number(summary[1]);
        result.skip = Number(summary[2] ?? 0);
        result.fail = Number(summary[3]);
      }
    }
    result.executed = result.pass + result.fail;
    result.discovered = result.executed + result.skip;
    result.exitCode = exitCode || (result.executed === 0 || result.fail > 0 || reportErrors ? 1 : 0);
    return result;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2).filter(arg => arg !== "--");
    if (args.length !== 3 || args[1] !== "--stage") throw new Error("Usage: bun tests/run.ts unit|integration|e2e [--] --stage P1|P2");
    const report = await runStage(args[0] as TestCategory, args[2]!);
    console.log(JSON.stringify(report));
    process.exitCode = report.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
