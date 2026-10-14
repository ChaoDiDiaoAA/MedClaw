import {expect,test} from 'bun:test';
import {loadDataset,projectInput} from '../../src/datasets.ts';
import {compactionHistoryEligibility} from '../../src/dataset-fixtures.ts';

test('fixed synthetic handoff turns create a compressible business prefix without adding Gold stages',async()=>{
  const dataset=await loadDataset();
  for(const task of dataset.cases.filter(item=>item.category==='compaction')) {
    const compact=task.steps.findIndex(step=>step.action.action==='compact');
    const preparation=task.steps.slice(0,compact).filter(step=>step.action.action==='send'&&step.action.alias.startsWith('prepare-'));
    expect(preparation.length).toBe(8);
    const prompts=task.steps.slice(0,compact).flatMap(step=>step.action.action==='send'?[step.action.prompt]:[]);
    expect(prompts.every(prompt=>prompt.length<19000)).toBe(true);
    expect(compactionHistoryEligibility(prompts)).toMatchObject({sourceInPrefix:true,keepRecentTokens:20000});
    expect(task.steps.filter(step=>step.action.action==='send'&&step.action.alias==='turn-2')[0]!.action).toMatchObject({routing:'agent'});
    expect(projectInput(dataset,task.id,'turn-1').materials.some(file=>file.path.includes('handoff'))).toBe(false);
    expect(Object.keys((dataset.gold[task.id]!.values as any).stages)).toEqual(['turn-1','turn-2']);
  }
});
