import {expect,test} from 'bun:test';
import {agentRuntimeFixture} from '../fixtures/agent-runtime';
import {OllamaIntentClient} from '../../packages/intent-ollama/src/index';
import {IntentModelConfigurationSchema} from '../../packages/contracts/src/model';
import {CLASSIFY_PROMPT} from '../../packages/core/src/intent/prompts/classify';
import {VERIFY_PROMPT} from '../../packages/core/src/intent/prompts/verify';
import {disabledIntentModel} from '../fixtures/p14-intent';

test('p11 Core rejects resource and intent routing conflict before accepting or invoking',async()=>{
  let classifications=0;const client=new OllamaIntentClient({classify:CLASSIFY_PROMPT,verify:VERIFY_PROMPT});
  client.recognizeIntent=async()=>{classifications++;throw new Error('Resource commands must not classify');};
  const f=await agentRuntimeFixture(undefined,false,undefined,{client,configuration:IntentModelConfigurationSchema.parse({...disabledIntentModel(),enabled:true,verifiedEvidenceRef:'ENGINEERING configured for admission validation'})});try{
    for(const text of ['/skill:query explain','/query explain']){
      const input=f.request(text);if(input.mode!=='send')throw new Error('Send expected');
      const result=await f.app.runs.submitAgent({...input,routing:{mode:'intent',originRunId:null}},{instanceId:'host',operationRef:text});
      expect(result).toMatchObject({ok:false,error:{code:'invalid_argument'}});
    }
    expect(f.db.query('SELECT id FROM runs').all()).toHaveLength(0);
    expect(f.db.query('SELECT id FROM session_inputs').all()).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
    expect(classifications).toBe(0);
  }finally{await f.close();}
});

test('p11 an unselected registered template fails even with an otherwise empty resource selection',async()=>{
  const f=await agentRuntimeFixture();try{
    f.app.config.resources={bySession:{}};
    const result=await f.app.runs.submitAgent(f.request('/query explain'),{instanceId:'host',operationRef:'unselected-template'});
    expect(result).toMatchObject({ok:false,error:{code:'resource_unavailable'}});
    expect(f.requests).toHaveLength(0);
    expect(f.db.query('SELECT id FROM runs').all()).toHaveLength(0);
  }finally{await f.close();}
});
