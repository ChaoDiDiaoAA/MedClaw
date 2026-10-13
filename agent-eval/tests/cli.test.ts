import { test, expect } from 'bun:test';
import { parseCommand } from '../src/cli.ts';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatasetFixture } from './datasets/fixture.ts';
import { runConfigFixture } from './report-fixture.ts';

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
