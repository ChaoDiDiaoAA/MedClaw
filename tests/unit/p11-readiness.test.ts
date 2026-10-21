import { expect, test } from 'bun:test';
import * as resources from '../../packages/contracts/src/resources';
import {matchProviderResources} from '../../packages/runtime-pi/src/messages';

type Readiness = { state: string; basis: string; requiredTools: string[] | null; matchedCount: number | null; totalCount: number | null; missingTools: { name: string; reason: string }[] };
function evaluate(required: string[] | null, tools: string[] | null, basis: 'configuration' | 'run_scope' = 'configuration'): Readiness {
  const calculate = Reflect.get(resources, 'getSkillReadiness');
  expect(calculate).toBeFunction();
  return calculate(required, tools, basis);
}

test('p11 readiness distinguishes full partial zero empty and unknown Tool matches', () => {
  expect(evaluate(['read', 'read_data_scope'], ['read', 'read_data_scope'])).toEqual({state:'ready',basis:'configuration',requiredTools:['read','read_data_scope'],matchedCount:2,totalCount:2,missingTools:[]});
  expect(evaluate(['read', 'read_data_scope'], ['read'])).toEqual({state:'partial',basis:'configuration',requiredTools:['read','read_data_scope'],matchedCount:1,totalCount:2,missingTools:[{name:'read_data_scope',reason:'tool_not_available'}]});
  expect(evaluate(['read'], [], 'run_scope')).toEqual({state:'unavailable',basis:'run_scope',requiredTools:['read'],matchedCount:0,totalCount:1,missingTools:[{name:'read',reason:'tool_not_available'}]});
  expect(evaluate([], [])).toEqual({state:'no_requirements',basis:'configuration',requiredTools:[],matchedCount:0,totalCount:0,missingTools:[]});
  expect(evaluate(null, ['read'])).toEqual({state:'unknown',basis:'configuration',requiredTools:null,matchedCount:null,totalCount:null,missingTools:[]});
  expect(evaluate(['read'], null, 'run_scope')).toEqual({state:'unknown',basis:'run_scope',requiredTools:['read'],matchedCount:null,totalCount:1,missingTools:[]});
});

test('p11 readiness is independent of enabled state and does not mutate Tool declarations', () => {
  const required=['read','read_data_scope'], tools=['read','read_data_scope','read'];
  const result=evaluate(required, tools, 'run_scope');
  expect(result.matchedCount).toBe(2);
  expect(result).not.toHaveProperty('enabled');
  expect(required).toEqual(['read','read_data_scope']);
  expect(tools).toEqual(['read','read_data_scope','read']);
});

test('p11 delivery rejects omitted or duplicated readiness even when there are no callable Skills',()=>{
  const readiness='<skill_readiness>\nquery@v1: unavailable (0/1 capabilities)\n</skill_readiness>';
  expect(()=>Reflect.apply(matchProviderResources,null,[{messages:[{role:'system',content:'constraints'}]},'openai-completions',[],readiness])).toThrow();
  expect(()=>Reflect.apply(matchProviderResources,null,[{messages:[{role:'system',content:readiness+'\n'+readiness}]},'openai-completions',[],readiness])).toThrow();
  expect(Reflect.apply(matchProviderResources,null,[{messages:[{role:'system',content:readiness}]},'openai-completions',[],readiness])).toEqual({verified:[],readiness});
});
