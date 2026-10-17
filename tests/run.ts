import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
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
  countsSource: "junit" | "stderr" | "playwright" | "unavailable";
  reportComplete: boolean;
  reportErrors: string[];
  reportDirectory: string | null;
}
const projectRoot = resolve(import.meta.dir, "..");
const stagePrefixes = { P1: "p1", P2: "p2", P3: "p3", P4: "p4", P5: "p5", P6: "p6", P7: "p7", P8: "p8", P9: "p9", P10: "p10", P11: "p11", P12: "p12", P13: "p13", P14: "p14", P15: "p15", P16: "p16", P17: "p17" } as const;

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

function readJUnit(xml:string) {
  const document=/^\s*(?:<\?xml[^>]*>\s*)?<testsuites\b([^>]*)>[\s\S]*<\/testsuites>\s*$/.exec(xml);
  const stack:string[]=[];
  let end=0;
  for(const token of xml.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[\w:.-]+(?:[^<>"']|"[^"]*"|'[^']*')*>/g)){
    if(xml.slice(end,token.index).includes('<'))throw new Error('junit_report_invalid');
    const tag=token[0];end=token.index+tag.length;
    if(tag.startsWith('<?')||tag.startsWith('<!'))continue;
    const name=/^<\/?([\w:.-]+)/.exec(tag)![1];
    if(tag.startsWith('</')){if(!/^<\/[\w:.-]+\s*>$/.test(tag)||stack.pop()!==name)throw new Error('junit_report_invalid');}
    else if(!tag.endsWith('/>'))stack.push(name);
  }
  if(stack.length||xml.slice(end).includes('<'))throw new Error('junit_report_invalid');
  const cases=xml.match(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)??[];
  if(!document||(xml.match(/<testcase\b/g)?.length??0)!==cases.length)throw new Error('junit_report_invalid');
  const fail=cases.filter(item=>/<(?:failure|error)\b/.test(item)).length;
  const skip=cases.filter(item=>/<skipped\b/.test(item)).length;
  for(const [attribute,count] of [['tests',cases.length],['failures',fail],['skipped',skip]] as const){
    const value=new RegExp(`\\b${attribute}="([^"]+)"`).exec(document[1])?.[1];
    if(value!==undefined&&(!/^\d+$/.test(value)||Number(value)!==count))throw new Error('junit_report_invalid');
  }
  return {cases,pass:cases.length-fail-skip,fail,skip};
}

export async function runStage(category: TestCategory, stage: string, options: { root?: string } = {}): Promise<StageReport> {
  const root = resolve(options.root ?? projectRoot);
  const files = discoverTests(category, stage, root);
  const result: StageReport = { category, stage, discoveredFiles: files.length, discovered: 0, executed: 0, pass: 0, fail: 0, skip: 0, exitCode: 1,
    countsSource:'unavailable',reportComplete:false,reportErrors:[],reportDirectory:null };
  const issue=(code:string)=>{if(!result.reportErrors.includes(code))result.reportErrors.push(code);result.reportComplete=false;result.exitCode ||= 1;};
  const output=join(root,'test-results');
  const saveLatest=()=>{if(category==='e2e'&&existsSync(output))try{writeFileSync(join(output,'e2e-results.json'),JSON.stringify(result,null,2));}catch{issue('report_write_failed');}};
  if (!files.length) {
    issue('no_tests_discovered');
    if(category==='e2e')try{rmSync(join(output,'e2e-results.xml'),{force:true});}catch{issue('report_setup_failed');}
    saveLatest();return result;
  }
  const desktop=category==='desktop';
  const directory=join(output,'.runs',randomUUID());
  const report = join(directory, desktop ? "results.json" : "results.xml");
  const descriptors:number[]=[];
  let childExit=1,stderr='',junit:ReturnType<typeof readJUnit>|undefined,desktopData:unknown;
  try {
    if(category==='e2e')rmSync(join(output,'e2e-results.xml'),{force:true});
    mkdirSync(directory,{recursive:true});result.reportDirectory=directory;
    descriptors.push(openSync(join(directory,'stdout.log'),'wx'));
    descriptors.push(openSync(join(directory,'stderr.log'),'wx'));
  }catch{
    for(const descriptor of descriptors){try{closeSync(descriptor);}catch{}}
    issue('report_setup_failed');
    saveLatest();
    if(result.reportDirectory){try{writeFileSync(join(directory,'result.json'),JSON.stringify(result,null,2));}catch{issue('report_write_failed');}}
    return result;
  }
  try {
    const cli = desktop
      // Desktop specs build the same ordinary dev output; serialize files so
      // an active Electron cannot load another spec's in-progress build.
      // Keep Playwright cleanup inside this run so prior reports and open logs survive.
      ? ["node", join(dirname(createRequire(import.meta.url).resolve("@playwright/test/package.json")), "cli.js"), "test", ...files.map(file => relative(root, file).replaceAll("\\", "/")), "--workers=1", "--reporter=json", `--output=${join(directory, "artifacts")}`]
      : [process.execPath, ...(category === 'e2e' ? ['--no-env-file'] : []), "test", ...files, "--reporter=junit", `--reporter-outfile=${report}`];
    const child = Bun.spawn(cli, {
      cwd: root,
      env: { ...process.env, ...(desktop ? { PLAYWRIGHT_JSON_OUTPUT_FILE: report } : {}) },
      stdout: "pipe", stderr: "pipe",
    });
    const forward=(stream:ReadableStream<Uint8Array>,descriptor:number,target:NodeJS.WriteStream)=>{
      const decoder=new TextDecoder();
      let pending='';
      const print=(text:string)=>target.write(text
        .replace(/^((?:\x1b\[[\d;]*m)*)(?:\(pass\)|✓)(?=\s|\x1b\[|$)/gm,'$1✅')
        .replace(/^((?:\x1b\[[\d;]*m)*)(?:\(fail\)|✗)(?=\s|\x1b\[|$)/gm,'$1❌'));
      return stream.pipeTo(new WritableStream<Uint8Array>({write(chunk){
        try{if(writeSync(descriptor,chunk)!==chunk.length)issue('output_write_failed');}catch{issue('output_write_failed');}
        try{
          if(desktop||target===process.stdout)target.write(chunk);
          else{
            pending+=decoder.decode(chunk,{stream:true});
            const end=pending.lastIndexOf('\n');
            if(end!==-1){print(pending.slice(0,end+1));pending=pending.slice(end+1);}
          }
        }catch{issue('output_forward_failed');}
      },close(){
        if(!desktop&&target===process.stderr)try{print(pending+decoder.decode());}catch{issue('output_forward_failed');}
      }})).catch(()=>{issue('output_read_failed');});
    };
    const [display, recorded] = child.stderr.tee();
    [childExit,stderr] = await Promise.all([
      child.exited, new Response(recorded).text().catch(()=>{issue('output_read_failed');return ''; }),
      forward(child.stdout,descriptors[0],process.stdout),forward(display,descriptors[1],process.stderr),
    ]);
  }catch{issue('test_process_failed');}
  finally{for(const descriptor of descriptors){try{closeSync(descriptor);}catch{issue('output_write_failed');}}}
  try {
    if (existsSync(report)) {
      if (desktop) {
        const data = JSON.parse(readFileSync(report, "utf8")) as { stats: { expected: number; unexpected: number; flaky: number; skipped: number }; errors: unknown[]; suites:PlaywrightSuite[] };
        if(!data.stats||![data.stats.expected,data.stats.unexpected,data.stats.flaky,data.stats.skipped].every(value=>Number.isSafeInteger(value)&&value>=0)||!Array.isArray(data.errors)||!Array.isArray(data.suites))throw new Error('invalid_report');
        result.pass = data.stats.expected + data.stats.flaky;
        result.fail = data.stats.unexpected;
        result.skip = data.stats.skipped;
        result.countsSource='playwright';desktopData=data;
        if(data.errors.length)issue('playwright_report_errors');
        if(desktopIncomplete(data.suites,files))issue('test_coverage_incomplete');
      } else {
        junit=readJUnit(readFileSync(report,'utf8'));
        result.pass=junit.pass;result.fail=junit.fail;result.skip=junit.skip;result.countsSource='junit';
        if(category==='e2e'&&terminalIncomplete(junit.cases,files))issue('test_coverage_incomplete');
      }
    }else issue(desktop?'playwright_report_missing':'junit_report_missing');
  }catch{issue(desktop?'playwright_report_invalid':'junit_report_invalid');}
  if (!desktop) {
    // Bun omits module-loading errors from JUnit; its final summary includes them.
    const plain=stripVTControlCharacters(stderr).replaceAll('\r\n','\n');
    const summary = [...plain.matchAll(/(?:^|\n)\s*(\d+) pass\n(?:\s*(\d+) skip\n)?\s*(\d+) fail\b/g)].at(-1);
    if (summary) {
      result.pass = Number(summary[1]);
      result.skip = Number(summary[2] ?? 0);
      result.fail = Number(summary[3]);
      result.countsSource='stderr';
      if(junit&&(['pass','fail','skip'] as const).some(key=>junit[key]!==result[key]))issue('test_counts_inconsistent');
      if(plain.slice(summary.index).includes('JUnitReportFailed:'))issue('junit_report_failed');
    }
  }
  if(result.countsSource==='unavailable')issue('test_counts_unavailable');
  result.executed = result.pass + result.fail;
  result.discovered = result.executed + result.skip;
  if(result.executed===0)issue('test_execution_empty');
  if(['P12','P13','P14','P15','P16','P17'].includes(stage)&&result.skip>0)issue('test_coverage_incomplete');
  result.reportComplete=result.reportErrors.length===0;
  result.exitCode=childExit||(result.fail>0||!result.reportComplete?1:0);
  try{
    if(category==='e2e'&&junit&&result.reportComplete)writeFileSync(join(output,'e2e-results.xml'),readFileSync(report));
    if(desktop&&desktopData)writeFileSync(join(output,'desktop-results.json'),JSON.stringify(desktopData,null,2));
  }catch{issue('report_write_failed');}
  saveLatest();
  try{writeFileSync(join(directory,'result.json'),JSON.stringify(result,null,2));}
  catch{issue('report_write_failed');saveLatest();}
  return result;
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
      if(report.countsSource==='unavailable')console.error('Test counts are unavailable; inspect reportErrors and the retained logs.');
      console.log(JSON.stringify(report));process.exitCode = report.exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
