import { IntentInputProjectionSchema, TimeRangeSchema, type IntentInputProjection, type IntentGroundingFact } from '../../../contracts/src/intent';
import type { IntentSnapshot } from '../../../contracts/src/query';
import { nextDate } from '../data/catalog-service';

export const explicitMetrics = [['sum_price', /价格总额|价格合计/g], ['mean_price', /平均价格|价格均值|均价/g], ['count', /快照记录总数|快照记录数/g]] as const;
export const statusAliases = {active:/在售|\bactive\b/gi,suspended:/暂停|停用|\bsuspended\b/gi,delisted:/下架|\bdelisted\b/gi,recalled:/召回|\brecalled\b/gi};
export const clearsCondition = (text:string,expression:string)=>new RegExp(`(?:不限|不限制|取消|清除)(?:${expression})|(?:${expression})(?:条件|过滤|限制|筛选)?(?:不限|不限制|取消|清除)`).test(text);

/** Source facts only: no intent selection, inheritance or executable parameters. Offsets use JS UTF-16. */
export function readExplicitConstraints(text:string,referenceDate:string,source:'current_input'|'pending_task'='current_input'):IntentGroundingFact[] {
  const facts:IntentGroundingFact[]=[];
  const span=(match:RegExpMatchArray)=>({source,quote:match[0],start:match.index!,end:match.index!+match[0].length});
  const dates=/\d{4}-\d{2}-\d{2}\s*(?:至|到)\s*\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}|昨天|上个月|今天|前天/g;
  for(const match of text.matchAll(dates)){
    let time:null|{start:string;endExclusive:string}=null;
    try {
      const range=/(\d{4}-\d{2}-\d{2})\s*(?:至|到)\s*(\d{4}-\d{2}-\d{2})/.exec(match[0]);
      if(range){
        const after=text.slice(match.index!+match[0].length),before=text.slice(0,match.index!);
        const excludesEnd=new RegExp(`^\\s*[，,（(]?\\s*(?:(?:不含|不包含|不包括)(?:结束(?:日期|日)|末日|${range[2]})|半开|endExclusive|exclusive)`,'i').test(after)
          || /(?:半开(?:时间)?区间|endExclusive|exclusive)\s*[:：]?\s*$/i.test(before);
        time={start:range[1]!,endExclusive:excludesEnd?range[2]!:nextDate(range[2]!)};
      }
      else if(match[0]==='上个月'){
        const date=new Date(referenceDate+'T00:00:00Z');date.setUTCDate(1);const endExclusive=date.toISOString().slice(0,10);date.setUTCMonth(date.getUTCMonth()-1);time={start:date.toISOString().slice(0,10),endExclusive};
      } else {
        const offset=match[0]==='昨天'?-1:match[0]==='前天'?-2:0;
        const start=match[0]==='今天'||offset?new Date(Date.parse(referenceDate+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10):match[0];
        time={start,endExclusive:nextDate(start)};
      }
      time=TimeRangeSchema.parse(time);
    } catch {time=null;}
    facts.push({...span(match),kind:'date',time});
  }
  const statusTokens=/(?:非|不为|不是|排除|不包括|不要)(?:的)?(?:在售|暂停|停用|下架|召回|active\b|suspended\b|delisted\b|recalled\b)|(?:不限|不限制|取消|清除)(?:器械状态|状态)|(?:器械状态|状态)(?:条件|过滤|限制|筛选)?(?:不限|不限制|取消|清除)|在售|暂停|停用|下架|召回|\b(?:active|suspended|delisted|recalled)\b/gi;
  for(const match of text.matchAll(statusTokens)){
    const clear=clearsCondition(match[0],'器械状态|状态');
    const value=clear?null:(Object.entries(statusAliases).find(([,pattern])=>new RegExp(pattern.source,'i').test(match[0]))?.[0] as 'active'|'suspended'|'delisted'|'recalled');
    if(value||clear)facts.push({...span(match),kind:'status',operation:clear?'clear':/^(?:非|不为|不是|排除|不包括|不要)/.test(match[0])?'exclude':'set',value});
  }
  for(const [value,pattern] of explicitMetrics)for(const match of text.matchAll(pattern))facts.push({...span(match),kind:'metric',value});
  return facts.sort((a,b)=>a.start-b.start||a.end-b.end);
}

export function groundIntentInput(input:IntentInputProjection,rows:IntentSnapshot[]):IntentInputProjection {
  if(!['medclaw.intent-policy/v4','medclaw.intent-policy/v5'].includes(input.versions.policyVersion))return input;
  const facts:IntentGroundingFact[]=[];
  for(const [source,text] of [['current_input',input.text],['pending_task',input.pendingClarification?.taskText]] as const){
    if(!text)continue;
    facts.push(...readExplicitConstraints(text,input.referenceDate,source));
    for(const field of ['device','region','manufacturer','category','distributor'] as const){
      const names=new Map<string,Set<number>>();
      for(const row of rows){const name=field==='device'?row.deviceName:row[field];if(!name||!text.includes(name))continue;
        const ids=names.get(name)??new Set<number>();if(field==='device')ids.add(row.deviceId);names.set(name,ids);}
      for(const [name,ids] of names)for(const match of text.matchAll(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))){
        facts.push({kind:'entity',source,quote:name,start:match.index!,end:match.index!+name.length,field,value:name,deviceIds:[...ids].sort((a,b)=>a-b)});
      }
    }
  }
  return IntentInputProjectionSchema.parse({...input,grounding:{contract:'medclaw.intent-grounding/v1',facts}});
}
