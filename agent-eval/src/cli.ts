import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { ZodError } from 'zod';
import { ExecutionIdSchema } from './types.ts';
import { loadDataset, datasetCoverage, auditLineage } from './datasets.ts';
import { doctor } from './doctor.ts';
import { runExperiment,planTrials } from './execution/runner.ts';
import { readReport } from './reports/write.ts';
import { compareReports } from './reports/compare.ts';
import { exportReport, platformConfig } from './langfuse/export.ts';
import { recordFeedback } from './review/store.ts';
import { setupReview, enqueueReview, importReview, syncReview } from './review/platform.ts';
import { JudgeClient, resolveRunConfig } from './scoring/judges/client.ts';

const root = resolve(import.meta.dir, '../..'), runsRoot = join(root, 'agent-eval/runs');
const processEvents: NodeJS.EventEmitter = process;
export function formatCliError(error: unknown): {error:string;reason?:string;operation?:string;location?:string;issues?:{path:string;code:string}[]} {
  const message=error instanceof Error?error.message:'';
  if(message==='dataset_invalid:review_content_changed'||message==='dataset_invalid:review_criteria_changed') {
    return {error:'dataset_invalid',reason:message.slice('dataset_invalid:'.length)};
  }
  if(/^[a-z][a-z0-9_]*$/.test(message))return {error:message};
  const diagnostic:{location?:string}={};
  // Only existing evaluation source frames are public; never print the raw stack or exception text.
  for(const line of (error instanceof Error?error.stack??'':'').replaceAll('\\','/').split('\n').slice(1)) {
    const frame=line.match(/((?:[A-Za-z]:)?\/[^()\r\n]+\.ts):(\d{1,7}):(\d{1,7})\)?$/);
    if(!frame)continue;
    const path=relative(root,frame[1]!).replaceAll('\\','/');
    if(/^agent-eval\/src\/[A-Za-z0-9_/-]+\.ts$/.test(path)&&existsSync(resolve(root,path))) {
      diagnostic.location=`${path}:${frame[2]}:${frame[3]}`;break;
    }
  }
  if(error instanceof ZodError) {
    const fields=new Set(['version','environment','model','url','key','provider','maxTokens','definition','models','id','intent','baseUrl','judge','timeoutMs','temperature','systemRubric','policy','retention','comparison','baselineExecutionId','factors']);
    return {error:'validation_error',issues:error.issues.map(issue=>({path:issue.path.map(part=>typeof part==='number'||typeof part==='string'&&fields.has(part)?part:'[field]').join('.'),code:issue.code})),...diagnostic};
  }
  if(error instanceof Error&&'code' in error&&typeof error.code==='string'&&['ENOENT','EACCES','EPERM','EEXIST','ENOTDIR','EISDIR','EINVAL','ENAMETOOLONG','ENOSPC','EMFILE','EBUSY','EROFS'].includes(error.code)) {
    const operation='syscall' in error&&typeof error.syscall==='string'&&['open','mkdir','read','write','unlink','stat','lstat','scandir','rename'].includes(error.syscall)?error.syscall:undefined;
    return {error:'filesystem_error',reason:error.code,...operation?{operation}:{},...diagnostic};
  }
  return {error:'invalid_request_or_facility_error',...diagnostic};
}
const commands: Record<string, string[]> = {
  doctor: ['dataset'],
  'dataset validate': ['dataset'], 'dataset audit-lineage': ['dataset'],
  'judge calibrate': ['references', 'execution-id', 'output', 'backend'],
  run: [ 'dataset', 'selection', 'repeat', 'config', 'execution-id', 'judge', 'backend'],
  report: ['execution-id'], compare: ['baseline', 'candidate'], resend: ['report', 'backend'],
  'review record': ['report', 'file'], 'review setup': ['file', 'backend'],
  'review enqueue': ['execution-id', 'queue-id', 'backend'], 'review import': ['execution-id', 'queue-id', 'backend'], 'review sync': ['execution-id', 'backend'],
};
export const HELP = `MedClaw independent evaluation (local authority)
Usage: bun run eval -- <command> [options]
  doctor [--dataset ID|PATH]
  dataset validate|audit-lineage --dataset ID|PATH
  judge calibrate --references PATH --execution-id ID --output NEW_DIRECTORY --backend local
  run --dataset ID|PATH --selection smoke|full --repeat 1|3 --config PATH --execution-id NEW_ID --judge required|off --backend local
  report --execution-id ID
  compare --baseline ID --candidate ID
  resend --report PATH --backend langfuse
  review record --report PATH --file FEEDBACK_JSON
  review setup --file QUEUE_JSON --backend langfuse
  review enqueue|import --execution-id ID --queue-id ID --backend langfuse
  review sync --execution-id ID --backend langfuse
Exit: 0 command completed; 1 invalid/config/transport/facility error; 2 quality/admission not passed.
Smoke and Full run locally from current reviewed data. Upload is a separate command.
No .env autoload. Set Judge/platform credentials explicitly in the controller environment.`;
export function parseCommand(input: string[]): { command: string; options: Record<string, string> } {
  const args = input.filter(arg => arg !== '--');
  if (!args.length || args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) return { command: 'help', options: {} };
  const command = ['dataset', 'judge', 'review'].includes(args[0]!) ? `${args.shift()} ${args.shift()}` : args.shift()!;
  if (!Object.hasOwn(commands, command)) throw new Error('unknown_command');
  if (args.length === 1 && args[0] === '--help') return { command: 'help', options: {} };
  const options: Record<string, string> = {};
  while (args.length) {
    const key = args.shift()!;
    if (!key.startsWith('--') || !commands[command]!.includes(key.slice(2))) throw new Error('unknown_option');
    if (Object.hasOwn(options, key.slice(2))) throw new Error('duplicate_option');
    const value = args.shift(); if (!value || value.startsWith('--')) throw new Error('missing_option_value');
    options[key.slice(2)] = value;
  }
  if (command === 'run' && options.backend && options.backend !== 'local') throw new Error('run_backend_must_be_local');
  return { command, options };
}
const json = async (path: string) => JSON.parse(await readFile(resolve(path), 'utf8'));
const datasetPath = (id: string) => id==='medclaw-agent-v1'?id:resolve(id);
const reportPath = (id: string) => join(runsRoot, ExecutionIdSchema.parse(id), 'report.json');
export async function main(args: string[], env:Record<string,string|undefined> = process.env): Promise<number> {
  const { command, options } = parseCommand(args);
  const required = (key: string) => { const value = options[key]; if (!value) throw new Error(`missing_${key.replaceAll('-', '_')}`); return value; };
  const local = () => { if (required('backend') !== 'local') throw new Error('backend_must_be_local'); };
  const platform = () => { if (required('backend') !== 'langfuse') throw new Error('backend_must_be_langfuse'); return platformConfig(env); };
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (command === 'help') { console.log(HELP); return 0; }
  if (command === 'doctor') { const result = await doctor(options.dataset ? datasetPath(options.dataset) : undefined); print(result); return result.ready ? 0 : 2; }
  if (command === 'dataset validate' || command === 'dataset audit-lineage') {
    const dataset = await loadDataset(datasetPath(required('dataset')));
    print(command === 'dataset validate' ? { id: dataset.manifest.id, version:1, readiness: dataset.manifest.readiness, members: dataset.cases.length, smoke: dataset.manifest.smoke.length, coverage: datasetCoverage(dataset),cases:dataset.cases.map(({id,name,category,evalType})=>({id,name,category,evalType})) } : auditLineage(dataset)); return 0;
  }
  if (command === 'judge calibrate') {
    local(); const { calibrateReferences } = await import('./scoring/judges/calibration.ts');
    const controller = new AbortController(), stop = (): void => { controller.abort(); }; processEvents.on('SIGINT', stop); processEvents.on('SIGTERM', stop);
    try { const result = await calibrateReferences({ referencesPath: resolve(required('references')), executionId: ExecutionIdSchema.parse(required('execution-id')), outputPath: resolve(required('output')), env, signal: controller.signal }); print(result); return result.passed ? 0 : 2; }
    finally { processEvents.off('SIGINT', stop); processEvents.off('SIGTERM', stop); }
  }
  if (command === 'run') {
    local(); const selection = required('selection'); if (selection !== 'smoke' && selection !== 'full') throw new Error('selection_invalid');
    const judgeMode = required('judge'); if (judgeMode !== 'required' && judgeMode !== 'off') throw new Error('judge_mode_invalid');
    const input = await json(required('config')), datasetRoot = datasetPath(required('dataset'));
    const dataset = await loadDataset(datasetRoot), repeat = Number(required('repeat'));
    const selected=selection==='smoke'?dataset.manifest.smoke:dataset.manifest.members;
    const judged=planTrials(selected,repeat).filter(trial=>dataset.cases.find(task=>task.id===trial.caseId)!.expected.checks.some(check=>check.kind==='llm-judge'));
    const count = judged.length;
    const {config,modelCredential,judgeConfig} = await resolveRunConfig(input, env, judgeMode, count>0);
    const judge = judgeConfig ? await JudgeClient.create(judgeConfig, { plannedTrials: count,trialIds:judged.map(trial=>trial.trialId) }) : undefined;
    const controller = new AbortController(), stop = (): void => { controller.abort(); }; processEvents.on('SIGINT', stop); processEvents.on('SIGTERM', stop);
    try {
      const report = await runExperiment({ datasetRoot, runsRoot, executionId: required('execution-id'), selection, repeat, config, modelCredential, judgeMode, judge, signal: controller.signal, onProgress: trial => console.error(JSON.stringify({ trialId: trial.trialId, status: trial.status, reason: trial.reason })) });
      print({ executionId: report.executionId, report: reportPath(report.executionId), totals: report.totals }); return report.totals.pass === report.totals.planned ? 0 : 2;
    } finally { processEvents.off('SIGINT', stop); processEvents.off('SIGTERM', stop); }
  }
  if (command === 'report') { print(await readReport(reportPath(required('execution-id')))); return 0; }
  if (command === 'compare') { print(compareReports(await readReport(reportPath(required('baseline'))), await readReport(reportPath(required('candidate'))))); return 0; }
  if (command === 'resend') { const result = await exportReport(resolve(required('report')), 'langfuse', platform()); print(result); return result.state === 'complete' ? 0 : 1; }
  if (command === 'review record') { print(await recordFeedback(resolve(required('report')), await json(required('file')))); return 0; }
  if (command === 'review setup') { print(await setupReview(await json(required('file')), platform())); return 0; }
  if (command === 'review enqueue') { print(await enqueueReview(reportPath(required('execution-id')), required('queue-id'), platform())); return 0; }
  if (command === 'review import') { print(await importReview(reportPath(required('execution-id')), required('queue-id'), platform())); return 0; }
  if (command === 'review sync') { print(await syncReview(reportPath(required('execution-id')), platform())); return 0; }
  throw new Error('unknown_command');
}
if (import.meta.main) {
  try { process.exitCode = await main(Bun.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify(formatCliError(error))); process.exitCode = 1; }
}
