import { test, expect } from 'bun:test';
import { parseCommand,formatCliError } from '../src/cli.ts';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatasetFixture } from './datasets/fixture.ts';
import { runConfigFixture } from './report-fixture.ts';
import {pathToFileURL} from 'node:url';
import {loadDataset} from '../src/datasets.ts';
import {RunConfigSchema} from '../src/types.ts';

test('CLI exposes filesystem codes and operations without private paths or exception messages',()=>{
  const error=Object.assign(new Error('local-private-key in private response'),{code:'EACCES',syscall:'mkdir',path:'C:/private/local-private-key'});
  expect(formatCliError(error)).toEqual({error:'filesystem_error',reason:'EACCES',operation:'mkdir'});
  expect(JSON.stringify(formatCliError(error))).not.toContain('local-private-key');
});

test('CLI validation diagnostics identify fields without rejected values or rubric messages',()=>{
  const input=runConfigFixture();input.model.url='http://remote.invalid/local-private-key';
  const result=RunConfigSchema.safeParse(input);if(result.success)throw new Error('invalid_config_accepted');
  expect(formatCliError(result.error)).toMatchObject({error:'validation_error',issues:[{path:'model.url',code:'custom'}]});
  expect(JSON.stringify(formatCliError(result.error))).not.toContain('local-private-key');
});

test('unknown CLI errors reveal only an existing evaluation source location',()=>{
  const error=new Error('local-private-key from provider');
  error.stack=`Error: local-private-key\n at start (${resolve(import.meta.dir,'../src/execution/runner.ts')}:47:46)\n at private (C:/private/local-private-key.ts:1:1)`;
  expect(formatCliError(error)).toEqual({error:'invalid_request_or_facility_error',location:'agent-eval/src/execution/runner.ts:47:46'});
  error.stack='Error: local-private-key\n at private (C:/private/local-private-key.ts:1:1)';
  expect(formatCliError(error)).toEqual({error:'invalid_request_or_facility_error'});
});

for(const entry of ['cli','presets'])for(const reason of ['review_content_changed','review_criteria_changed','unknown_private_error'])test(`${entry} reports ${reason} safely and exits before evaluation`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-cli-dataset-error-'));
  try {
    const review=JSON.parse(await readFile(join(import.meta.dir,'../src/datasets/medclaw-agent-v1.review.json'),'utf8'));
    const {compiled,criteria,authoring,...recorded}=review.verifiedData;
    const snapshot={contract:'medclaw-dataset-snapshot/v1',...structuredClone(recorded),review};
    if(reason==='review_content_changed')snapshot.info.referenceDate='2027-10-02';
    if(reason==='review_criteria_changed')snapshot.review.verifiedData.compiled={};
    const snapshotPath=join(root,'snapshot.json'),preloadPath=join(root,'preload.ts');
    await writeFile(snapshotPath,JSON.stringify(snapshot));
    if(reason!=='unknown_private_error')await expect(loadDataset(snapshotPath)).rejects.toThrow(`dataset_invalid:${reason}`);
    const moduleUrl=pathToFileURL(resolve(import.meta.dir,'../src/datasets.ts')).href;
    await writeFile(preloadPath,`
import {mock} from 'bun:test';
import * as fs from 'node:fs/promises';
const readFile=fs.readFile;
mock.module('node:fs/promises',()=>({...fs,readFile:(path,...args)=>String(path).replaceAll('\\\\','/').endsWith('/agent-eval/configs/environment')?Promise.resolve(''):readFile(path,...args)}));
const datasets=await import(${JSON.stringify(moduleUrl)}),loadDataset=datasets.loadDataset;
mock.module(${JSON.stringify(moduleUrl)},()=>({...datasets,loadDataset:()=>${reason==='unknown_private_error'?"Promise.reject(new Error('provider response includes local-private-key https://user:password@example.invalid'))":`loadDataset(${JSON.stringify(snapshotPath)})`}}));
globalThis.fetch=()=>{throw new Error('unexpected_network_call');};
Bun.spawn=()=>{throw new Error('unexpected_host_start');};
`);
    const args=entry==='cli'?['dataset','validate','--dataset','medclaw-agent-v1']:['smoke','--check'];
    const child=Bun.spawnSync([process.execPath,'--no-env-file','--preload',preloadPath,resolve(import.meta.dir,`../src/${entry}.ts`),...args],{cwd:root,stdout:'pipe',stderr:'pipe'});
    const stderr=new TextDecoder().decode(child.stderr);
    expect(child.exitCode).toBe(1);expect(child.stdout.byteLength).toBe(0);
    expect(JSON.parse(stderr)).toMatchObject(reason==='unknown_private_error'?{error:'invalid_request_or_facility_error',location:expect.stringMatching(/^agent-eval\/src\/[a-z-]+\.ts:\d+:\d+$/)}:{error:'dataset_invalid',reason});
    expect(stderr).not.toContain('local-private-key');expect(stderr).not.toContain('password');
  } finally {await rm(root,{recursive:true,force:true});}
},30000);

test('CLI rejects unknown commands/options and duplicate options before any side effect', () => {
  expect(parseCommand(['--help']).command).toBe('help');
  expect(parseCommand(['dataset', 'validate', '--dataset', 'medclaw-agent-v1']).command).toBe('dataset validate');
  expect(() => parseCommand(['run', '--dataset', 'x', '--backend', 'langfuse'])).toThrow('run_backend_must_be_local');
  expect(() => parseCommand(['run', '--sql', 'DROP'])).toThrow('unknown_option');
  expect(() => parseCommand(['run', '--config', 'a', '--config', 'b'])).toThrow('duplicate_option');
  expect(() => parseCommand(['mystery'])).toThrow('unknown_command');
  expect(() => parseCommand(['report', '--execution-id'])).toThrow('missing_option_value');
});

test('CLI rejects unknown native model capabilities before any run and never prints the key',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mc-cli-model-'));
  try{
    const dataset=join(root,'dataset');await createDatasetFixture(dataset);
    const input=runConfigFixture();input.model.model='missing-native-model-v1';
    const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify(input));
    const child=Bun.spawnSync([process.execPath,'--no-env-file',resolve(import.meta.dir,'../src/cli.ts'),'run','--dataset',dataset,'--selection','smoke','--repeat','1','--config',configPath,'--execution-id','rejected-native-model','--judge','off','--backend','local'],
      {env:{...process.env,MEDCLAW_JUDGE_BASE_URL:'',MEDCLAW_JUDGE_MODEL:'',MEDCLAW_JUDGE_API_KEY:''},stdout:'pipe',stderr:'pipe'});
    const stderr=new TextDecoder().decode(child.stderr);
    expect(child.exitCode).toBe(1);
    expect(JSON.parse(stderr)).toEqual({error:'agent_model_not_found_or_ambiguous'});
    expect(stderr.includes(input.model.key)).toBe(false);
    expect(child.stdout.byteLength).toBe(0);
  }finally{await rm(root,{recursive:true,force:true});}
});
