import {expect,test,spyOn} from 'bun:test';
import {trialProgress} from '../src/execution/progress.ts';
import {terminalProgress,terminalSummary} from '../src/terminal.ts';

test('terminal separates execution completion, quality result and durable save, with exact evidence paths',()=>{
  const lines:string[]=[],render=terminalProgress(line=>lines.push(line)),item={caseId:'mc-v1-task-current-price',trialId:'mc-v1-task-current-price-r1',repetition:1,index:1,total:10};
  render({...item,kind:'phase',phase:'prepare_input',elapsedMs:0});
  render({...item,kind:'execution',phase:'collect',elapsedMs:1000,executionStatus:'completed'});
  render({...item,kind:'score',phase:'score',elapsedMs:2000,status:'FAIL',checks:[{metricId:'efficiency.calls',status:'FAIL',actual:{calls:Array.from({length:7},(_,i)=>({id:String(i)}))},expected:{max:6}}]});
  expect(lines.join('\n')).not.toContain('结果已保存');
  render({...item,kind:'saved',phase:'save',elapsedMs:3000,status:'FAIL',evidenceRef:'evidence/'+item.trialId+'/'});
  expect(lines.join('\n')).toContain('▶ [1/10]');expect(lines.join('\n')).toContain('✅ [1/10]');
  expect(lines.join('\n')).toContain('❌ [1/10]');expect(lines.join('\n')).toContain('实际7，上限6');
  expect(lines.join('\n')).toContain('💾');expect(lines.at(-1)).toBe('[证据] evidence/'+item.trialId+'/');
  for(const status of ['PASS','FAIL','UNJUDGEABLE','ERROR','NOT_RUN'] as const)render({...item,kind:'score',phase:'score',elapsedMs:0,status});
  expect(lines.join('\n')).toContain('UNJUDGEABLE');expect(lines.join('\n')).toContain('NOT_RUN');
  terminalSummary({executionId:'controlled',totals:{planned:10,pass:0,fail:7,unjudgeable:3,error:0,notRun:0}},'report.json',line=>lines.push(line));
  expect(lines.at(-2)).toContain('FAIL 7');
});

test('phase heartbeat repeats at sixty seconds and is cleared on phase changes and exceptions',()=>{
  const events:any[]=[];let tick:()=>void=()=>{};
  const interval=spyOn(globalThis,'setInterval').mockImplementation(((fn:()=>void,ms:number)=>{expect(ms).toBe(60000);tick=fn;return {unref(){}};}) as any);
  const clear=spyOn(globalThis,'clearInterval').mockImplementation(()=>{});
  try{
    const progress=trialProgress({caseId:'case',trialId:'case-r1',repetition:1},1,10,event=>events.push(event));
    progress.phase('execute');tick();tick();expect(events.filter(event=>event.kind==='heartbeat')).toHaveLength(2);
    progress.phase('collect');expect(clear).toHaveBeenCalledTimes(1);
    progress.close();expect(clear).toHaveBeenCalledTimes(2);
  }finally{interval.mockRestore();clear.mockRestore();}
});
