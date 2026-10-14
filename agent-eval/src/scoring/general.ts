import {ratio,record,unknown} from './rules.ts';
import type {EvaluatorDefinition,CheckSpec,RuleResult} from './types.ts';

const strings=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(x=>typeof x==='string'&&x.length>0);
const nonnegative=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
function callsOf(actual:unknown):Record<string,any>[]|undefined {
  if(!record(actual)||actual.complete!==true||!Array.isArray(actual.calls)||!actual.calls.every(call=>record(call)&&typeof call.id==='string'&&strings(call.capabilities)&&['succeeded','failed','rejected','cancelled'].includes(call.status)))return;
  if(new Set(actual.calls.map(call=>call.id)).size!==actual.calls.length)return;
  return actual.calls;
}
function sourceTime(value:unknown):number|null {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value))return null;
  const day=Date.parse(value.slice(0,10)+'T00:00:00Z');
  if(!Number.isFinite(day)||new Date(day).toISOString().slice(0,10)!==value.slice(0,10))return null;
  const parsed=Date.parse(value.length===10?value+'T00:00:00Z':value);
  return Number.isFinite(parsed)?parsed:null;
}
const definition=(id:string,name:string,formula:string,evaluate:EvaluatorDefinition['evaluate']):EvaluatorDefinition=>({id,name,version:'v1',kind:'deterministic',behavior:false,layer:'正式质量',formula,evaluate,
  appliesTo:()=>({applicable:true,reason:'Selected independent task criterion; missing behavior remains an applicable opportunity'})});

export const generalEvaluators:readonly EvaluatorDefinition[]=[
  definition('tool.recall','必需工具召回率','已调用必需能力数/独立声明必需能力数',(g,a,c)=>{
    const calls=callsOf(a);if(!record(g)||!strings(g.requiredCapabilities)||!calls)return unknown('Complete calls and independent required capabilities needed');
    const required=[...new Set(g.requiredCapabilities)],used=new Set(calls.flatMap(call=>call.capabilities));
    return ratio(required.filter(id=>used.has(id)).length,required.length,c,{required,missing:required.filter(id=>!used.has(id))});
  }),
  definition('tool.precision','工具选择准确性','相关调用数/实际调用数；执行失败与重复分别披露',(g,a,c)=>{
    const calls=callsOf(a);if(!record(g)||!strings(g.allowedCapabilities)||!calls)return unknown('Complete calls and independent allowed capability set needed');
    return ratio(calls.filter(call=>call.capabilities.some((id:string)=>g.allowedCapabilities.includes(id))).length,calls.length,c,{irrelevant: calls.filter(call=>!call.capabilities.some((id:string)=>g.allowedCapabilities.includes(id))).map(call=>call.id)});
  }),
  definition('tool.error_rate','工具调用错误率','失败或拒绝调用数/实际调用数；取消分列',(g,a,c)=>{
    const calls=callsOf(a);if(!record(g)||!calls||g.maxRate!==undefined&&(!nonnegative(g.maxRate)||g.maxRate>1))return unknown('Complete terminal calls and valid error threshold needed');
    const failed=calls.filter(call=>['failed','rejected'].includes(call.status));
    const result=ratio(failed.length,calls.length,{...c,direction:'lower',threshold:g.maxRate??0},{failed:failed.map(call=>call.id),cancelled:calls.filter(call=>call.status==='cancelled').map(call=>call.id),measurementOnly:g.maxRate===undefined});
    if(g.maxRate===undefined&&result.value!==null){result.status='PASS';result.reason='Observed error rate only; no quality threshold or task failure inferred';}
    return result;
  }),
  definition('tool.argument_validity','工具参数合法率','原参数和Hook后参数均通过实际Schema的调用/可核验调用',(g,a,c)=>{
    const calls=callsOf(a);if(!record(g)||!calls)return unknown('Complete original tool calls needed');
    if(calls.some(call=>typeof call.originalValid!=='boolean'||typeof call.finalValid!=='boolean'))return unknown('Original and final parameter Schema proofs required',calls.length);
    return ratio(calls.filter(call=>call.originalValid&&call.finalValid).length,calls.length,c);
  }),
  definition('evidence.provenance','证据来源完整率','具有可解析来源身份/版本/业务时间/原件引用的必要证据/必要证据',(g,a,c)=>{
    if(!record(g)||!record(a)||a.complete!==true||!Array.isArray(a.sources))return unknown('Complete verified source inventory required');
    return ratio(a.sources.filter(source=>record(source)&&['id','version','evidenceRef'].every(key=>typeof source[key]==='string'&&source[key].length>0)&&sourceTime(source.businessTime)!==null).length,a.sources.length,c);
  }),
  definition('evidence.freshness','数据时效符合率','所有必要来源中满足独立业务日期或固定参考年龄的来源/必要来源',(g,a,c)=>{
    if(!record(g)||!record(a)||a.complete!==true||!Array.isArray(a.sources))return unknown('Independent freshness criterion and complete supporting sources required');
    const reference=sourceTime(g.mode==='business_date'?g.date:g.asOf),limit=g.mode==='business_date'&&nonnegative(g.maxLagDays)&&Number.isSafeInteger(g.maxLagDays)?g.maxLagDays*86400000:g.mode==='age'&&nonnegative(g.maxAgeMs)?g.maxAgeMs:null;
    if(reference===null||limit===null)return unknown('Explicit valid business date or fixed age requirement needed');
    const times=a.sources.map(source=>record(source)?sourceTime(source.businessTime):null);
    if(times.some(time=>time===null))return unknown('Supporting business timestamps missing or malformed',times.length);
    return ratio(times.filter(time=>reference-time!>=0&&reference-time!<=limit).length,times.length,c,{reference:g.mode==='business_date'?g.date:g.asOf,maxAgeMs:limit});
  }),
  definition('efficiency.latency_budget','执行延迟预算符合性','实际受理至确认停止的单调耗时与独立预算比较',(g,a)=>{
    if(!record(g)||g.maxMs===undefined)return {...unknown('No independently authored latency budget'),applicable:false,denominator:0};
    if(!nonnegative(g.maxMs)||!record(a)||!nonnegative(a.startedMonoMs)||!nonnegative(a.stoppedMonoMs)||a.stoppedMonoMs<a.startedMonoMs||a.stopConfirmed!==true)return unknown('Explicit budget and confirmed monotonic execution interval needed');
    const duration=a.stoppedMonoMs-a.startedMonoMs;
    return {status:duration<=g.maxMs?'PASS':'FAIL',value:duration,numerator:duration,denominator:1,reason:'Monotonic execution duration compared with independently authored budget',details:{budgetMs:g.maxMs}};
  }),
  definition('tool.recovery','工具失败恢复符合率','有依据且无重复副作用的恢复或获准安全停止/实际失败机会',(g,a,c)=>{
    if(!record(g)||!Number.isSafeInteger(g.maxRetries)||g.maxRetries<0||!strings(g.allowedTools)||typeof g.allowStop!=='boolean'||!record(a)||a.complete!==true||!Array.isArray(a.failures))return unknown('Independent recovery policy and complete causal failure records needed');
    if(g.expectedFailureMode&&!a.failures.some(failure=>record(failure)&&failure.code===g.expectedFailureMode))return {...unknown('Expected failure opportunity not reached; do not erase the planned check',1),applicable:true};
    let correct=0,recovered=0,stopped=0;
    for(const failure of a.failures){
      if(!record(failure)||failure.delivered!==true||!Array.isArray(failure.attempts)||!failure.attempts.every(attempt=>record(attempt)&&typeof attempt.id==='string'&&typeof attempt.name==='string'&&['freshIdentity','justified','succeeded'].every(key=>typeof attempt[key]==='boolean'))||!Number.isSafeInteger(failure.sideEffects)||failure.sideEffects<0||typeof failure.stopped!=='boolean')return unknown('Failure delivery, retry identities and side effects must be proved',a.failures.length);
      const identities=failure.attempts.map((attempt:any)=>attempt.id);
      const permitted=identities.length===new Set(identities).size&&failure.attempts.length<=g.maxRetries&&failure.attempts.every((attempt:any)=>attempt.freshIdentity&&attempt.justified&&g.allowedTools.includes(attempt.name))&&failure.sideEffects===0;
      if(permitted&&failure.attempts.at(-1)?.succeeded===true&&typeof failure.targetVerified!=='boolean')return unknown('Successful recovery must be bound to its own verified target result',a.failures.length);
      const success=permitted&&failure.targetVerified&&failure.attempts.at(-1)?.succeeded===true;
      const safeStop=permitted&&g.allowStop&&failure.stopped&&failure.attempts.length===0;
      correct+=Number(success||safeStop);recovered+=Number(success);stopped+=Number(safeStop);
    }
    return ratio(correct,a.failures.length,c,{recovered,safeStops:stopped,failures:a.failures.length});
  }),
  {...definition('answer.partial_failure','部分失败披露正确率','最终回答准确说明真实失败/恢复结果/剩余缺口；关键词不证明披露',()=>unknown('Independent semantic Judge channel required')),kind:'llm-judge'},
];
