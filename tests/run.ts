import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";

export type TestCategory = "unit" | "integration" | "e2e" | "desktop";
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
const stagePrefixes = { P1: "p1", P2: "p2", P3: "p3", P4: "p4", P5: "p5", P6: "p6", P7: "p7", P8: "p8", P9: "p9", P10: "p10", P11: "p11", P12: "p12", P13: "p13", P14: "p14", P15: "p15" } as const;

export function discoverTests(category: TestCategory, stage: string, root = projectRoot): string[] {
  if (!["unit", "integration", "e2e", "desktop"].includes(category)) throw new Error(`Unknown test category: ${category}`);
  if (!(["e2e", "desktop"].includes(category) && stage === "all") && !Object.hasOwn(stagePrefixes, stage)) throw new Error(`Unknown test stage: ${stage}`);
  const prefix = stage === "all" ? null : stagePrefixes[stage as keyof typeof stagePrefixes];
  const directory = join(root, "tests", category === "e2e" ? "integration" : category === "desktop" ? "e2e" : category);
  if (!existsSync(directory)) return [];
  const files = [...new Bun.Glob(`*.${category === "desktop" ? "spec" : "test"}.ts`).scanSync({ cwd: directory, absolute: true })];
  return [...new Set(files.filter(file => {
    const name = basename(file);
    if (category === "e2e" && !name.includes('-host') && name !== 'p4-messages.test.ts' && !name.startsWith('p15-')) return false;
    return !prefix || new RegExp(`^${prefix}(?:\\D|$)`).test(name);
  }))].sort();
}

interface PlaywrightSuite {file?:string;suites?:PlaywrightSuite[];specs?:{file?:string;tests?:{status?:string}[]}[]}
function desktopIncomplete(suites:PlaywrightSuite[],files:string[]):boolean {
  const executed=new Map(files.map(file=>[basename(file),0]));
  let skipped=false;
  const visit=(items:PlaywrightSuite[],parentFile='')=>{
    for(const suite of items){
      const file=suite.file??parentFile;
      for(const spec of suite.specs??[]){
        const key=basename(spec.file??file);if(!executed.has(key))continue;
        for(const test of spec.tests??[]){
          if(test.status==='skipped')skipped=true;
          else if(['expected','unexpected','flaky'].includes(test.status??''))executed.set(key,executed.get(key)!+1);
        }
      }
      visit(suite.suites??[],file);
    }
  };
  visit(suites);return skipped||[...executed.values()].some(count=>count===0);
}

function terminalIncomplete(cases:string[],files:string[]):boolean {
  const executed=new Map(files.map(file=>[basename(file),0]));
  for(const item of cases){
    const file=basename(/\bfile="([^"]+)"/.exec(item)?.[1]??'');
    if(executed.has(file)&&!/<skipped\b/.test(item))executed.set(file,executed.get(file)!+1);
  }
  return cases.some(item=>/<skipped\b/.test(item))||[...executed.values()].some(count=>count===0);
}

export async function runStage(category: TestCategory, stage: string, options: { root?: string } = {}): Promise<StageReport> {
  const root = resolve(options.root ?? projectRoot);
  const files = discoverTests(category, stage, root);
  const result: StageReport = { category, stage, discoveredFiles: files.length, discovered: 0, executed: 0, pass: 0, fail: 0, skip: 0, exitCode: 1 };
  if (!files.length) return result;
  const temporary = mkdtempSync(join(tmpdir(), "medclaw-test-report-"));
  const desktop=category==='desktop';
  const report = join(temporary, desktop ? "results.json" : "results.xml");
  try {
    const cli = desktop
      // Desktop specs build the same ordinary dev output; serialize files so
      // an active Electron cannot load another spec's in-progress build.
      ? ["node", join(dirname(createRequire(import.meta.url).resolve("@playwright/test/package.json")), "cli.js"), "test", ...files.map(file => relative(root, file).replaceAll("\\", "/")), "--workers=1", "--reporter=json"]
      : [process.execPath, ...(category === 'e2e' ? ['--no-env-file'] : []), "test", ...files, "--reporter=junit", `--reporter-outfile=${report}`];
    const child = Bun.spawn(cli, {
      cwd: root,
      env: { ...process.env, ...(desktop ? { PLAYWRIGHT_JSON_OUTPUT_FILE: report } : {}) },
      stdout: "inherit", stderr: "pipe",
    });
    const [display, recorded] = child.stderr.tee();
    const [exitCode, stderr] = await Promise.all([
      child.exited, new Response(recorded).text(),
      display.pipeTo(new WritableStream({ write(chunk) { process.stderr.write(chunk); } })),
    ]);
    let reportErrors = !existsSync(report), requiredSkipped = false;
    if (existsSync(report)) {
      if (desktop) {
        const data = JSON.parse(readFileSync(report, "utf8")) as { stats: { expected: number; unexpected: number; flaky: number; skipped: number }; errors: unknown[]; suites:PlaywrightSuite[] };
        result.pass = data.stats.expected + data.stats.flaky;
        result.fail = data.stats.unexpected;
        result.skip = data.stats.skipped;
        reportErrors = data.errors.length > 0;
        requiredSkipped = desktopIncomplete(data.suites,files);
        mkdirSync(join(root,'test-results'),{recursive:true});
        writeFileSync(join(root,'test-results/desktop-results.json'),JSON.stringify(data,null,2));
      } else {
        const xml=readFileSync(report, "utf8");
        const cases = xml.match(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g) ?? [];
        result.fail = cases.filter(test => /<(?:failure|error)\b/.test(test)).length;
        result.skip = cases.filter(test => /<skipped\b/.test(test)).length;
        result.pass = cases.length - result.fail - result.skip;
        if(category==='e2e'){
          requiredSkipped=terminalIncomplete(cases,files);
          mkdirSync(join(root,'test-results'),{recursive:true});
          writeFileSync(join(root,'test-results/e2e-results.xml'),xml);
        }
      }
    }
    if (!desktop) {
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
    result.exitCode = exitCode || (result.executed === 0 || result.fail > 0 || reportErrors || requiredSkipped || ['P12', 'P13', 'P14', 'P15'].includes(stage) && result.skip > 0 ? 1 : 0);
    if(category==='e2e'){
      mkdirSync(join(root,'test-results'),{recursive:true});
      writeFileSync(join(root,'test-results/e2e-results.json'),JSON.stringify(result,null,2));
    }
    return result;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2).filter(arg => arg !== "--"), category = args.shift() as TestCategory;
    const checkIndex=args.indexOf('--check'),check=checkIndex!==-1;if(check)args.splice(checkIndex,1);
    const e2e=category==='e2e'||category==='desktop';
    const stage=args.length===0&&e2e?'all':args.length===2&&args[0]==='--stage'?args[1]:undefined;
    if (!stage || check && !e2e) throw new Error(`Usage: bun tests/run.ts e2e|desktop [--stage Pn] [--check] | unit|integration --stage ${Object.keys(stagePrefixes).join('|')}`);
    if(check){
      const files=discoverTests(category,stage),desktop=category==='desktop';
      const ready=files.length>0&&(desktop?existsSync(join(dirname(createRequire(import.meta.url).resolve('@playwright/test/package.json')),'cli.js'))&&Bun.which('node')!==null:existsSync(process.execPath));
      console.log(JSON.stringify({category,stage,runner:desktop?'playwright':'bun',check:true,ready,discoveredFiles:files.length,files:files.map(file=>relative(projectRoot,file).replaceAll('\\','/'))}));process.exitCode=ready?0:1;
    }else{
      const report = await runStage(category, stage);
      console.log(JSON.stringify(report));process.exitCode = report.exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
