import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
import {ExecutionIdSchema} from './types.ts';
import {loadDataset} from './datasets.ts';
import {resolveRunConfig} from './scoring/judges/client.ts';
import {planTrials} from './execution/runner.ts';
import {runBlockers,sourceInventory} from './doctor.ts';
import {main} from './cli.ts';
import {readReport} from './reports/write.ts';
import {exportReport,inspectExport,platformConfig} from './langfuse/export.ts';

const projectRoot=resolve(import.meta.dir,'../..');
type Preset={mode:'smoke'|'full'|'upload';check:boolean;executionId?:string};
export function parsePreset(input:string[]):Preset {
  const args=input.filter(arg=>arg!=='--'),mode=args.shift();
  if(mode!=='smoke'&&mode!=='full'&&mode!=='upload')throw new Error('unknown_preset');
  const preset:Preset={mode,check:false},seen=new Set<string>();
  while(args.length){
    const option=args.shift()!;
    if(seen.has(option))throw new Error('duplicate_option');seen.add(option);
    if(option==='--check'){preset.check=true;continue;}
    if(option==='--execution-id'&&mode==='upload'){
      const value=args.shift();if(!value||value.startsWith('--'))throw new Error('missing_option_value');
      preset.executionId=ExecutionIdSchema.parse(value);
    }else throw new Error('unknown_option');
  }
  if(mode==='upload'&&!preset.executionId)throw new Error('missing_execution_id');
  return preset;
}
export async function readPresetEnvironment(root=projectRoot):Promise<Record<string,string|undefined>> {
  return parseEnv(await readFile(join(root,'agent-eval/configs/environment'),'utf8'));
}
export async function mainPreset(args:string[],root=projectRoot,print:(value:unknown)=>void=value=>console.log(JSON.stringify(value,null,2))):Promise<number> {
  if(args.includes('--help')||args.includes('-h')){
    console.log('bun run test:e2e [-- --stage Pn] [-- --check] (terminal)\nbun run test:e2e:desktop [-- --stage Pn] [-- --check] (desktop UI)\nbun run eval:smoke [-- --check]\nbun run eval:full [-- --check]\nbun run eval:upload -- --execution-id ID [--check]');return 0;
  }
  const preset=parsePreset(args),env=await readPresetEnvironment(root),runsRoot=join(root,'agent-eval/runs');
  if(preset.mode==='upload'){
    const config=platformConfig(env),path=join(runsRoot,preset.executionId!,'report.json'),report=await readReport(path);
    if(report.executionId!==preset.executionId)throw new Error('report_execution_identity_mismatch');
    if(!report.trials.some(trial=>trial.startedAt))throw new Error('export_no_started_trials');
    if(preset.check){
      const {document}=await inspectExport(path);
      print({contract:'medclaw-eval-preflight/v1',mode:'upload',check:true,ready:true,executionId:report.executionId,events:document.envelope.events.length});return 0;
    }
    const controller=new AbortController(),stop=()=>controller.abort();process.on('SIGINT',stop);process.on('SIGTERM',stop);
    try{const result=await exportReport(path,'langfuse',config,controller.signal);print({executionId:report.executionId,...result});return result.state==='complete'?0:1;}
    finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
  }
  const dataset=await loadDataset('medclaw-agent-v1'),repeat=preset.mode==='smoke'?1:3;
  const selected=preset.mode==='smoke'?dataset.manifest.smoke:dataset.manifest.members,plan=planTrials(selected,repeat);
  const judged=plan.filter(trial=>dataset.cases.find(task=>task.id===trial.caseId)!.expected.checks.some(check=>check.kind==='llm-judge'));
  const configPath=join(root,'agent-eval/configs/agent.json'),input=JSON.parse(await readFile(configPath,'utf8'));
  const {config,judgeConfig}=await resolveRunConfig(input,env,'required',judged.length>0);
  const blockers=runBlockers(dataset,await sourceInventory(),config,{required:judged.length>0,configured:!!judgeConfig});
  print({contract:'medclaw-eval-preflight/v1',mode:preset.mode,check:preset.check,backend:'local',dataset:dataset.manifest.id,cases:selected.length,repeat,plannedTrials:plan.length,plannedJudgeCalls:judged.length,ready:blockers.length===0,blockers});
  if(blockers.length)return 2;
  if(preset.check)return 0;
  const executionId=ExecutionIdSchema.parse(`${preset.mode}-${new Date().toISOString().replace(/[-:.]/g,'')}-${randomUUID().slice(0,8)}`);
  return main(['run','--dataset',dataset.manifest.id,'--selection',preset.mode,'--repeat',String(repeat),'--config',configPath,'--execution-id',executionId,'--judge','required','--backend','local'],env);
}
if(import.meta.main){
  try{process.exitCode=await mainPreset(Bun.argv.slice(2));}
  catch(error){console.error(JSON.stringify({error:error instanceof Error&&/^[a-z][a-z0-9_]*$/.test(error.message)?error.message:'invalid_request_or_facility_error'}));process.exitCode=1;}
}
