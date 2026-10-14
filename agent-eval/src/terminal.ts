import type {ProgressEvent} from './execution/progress.ts';
import type {EvaluationReport} from './types.ts';
import {deriveReportAnalysis,type CaseAnalysis} from './reports/analysis.ts';
import {qualityMetricNames} from './scoring/registry.ts';

const phases={prepare_input:'准备公开输入',prepare_host:'准备Host环境',execute:'Agent执行',collect:'确认停止与采证',score:'评分',save:'保存结果'};
const icons={PASS:'✅',FAIL:'❌',UNJUDGEABLE:'⚠️',ERROR:'❌',NOT_RUN:'⏭️'};
const clean=(value:unknown)=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').slice(0,240);
const number=(value:number|null|undefined)=>value===null||value===undefined?'未知':Number.isInteger(value)?String(value):value.toFixed(4);
export function terminalCaseSummary(group:CaseAnalysis,write:(line:string)=>void=console.log,unconfirmed=false) {
  write(`[${unconfirmed?'Case未完整':'Case汇总'}] ${clean(group.caseId)} · ${clean(group.name)}：${unconfirmed?'已处理，停止或保存未确认':'已处理并保存'} ${group.saved}/${group.planned} 个Trial`);
  write(`结果：PASS ${group.pass}，FAIL ${group.fail}，UNJUDGEABLE ${group.unjudgeable}，ERROR ${group.error}，NOT_RUN ${group.notRun}；启动 ${group.started}，完成 ${group.completed}`);
  write(`首次：${group.first.trialId} ${group.first.status}；确认通过 ${group.pass}/${group.planned}；本次全部通过 ${group.allPassed===null?'未知':group.allPassed?'是':'否'}`);
  write('各次：'+group.attempts.map(item=>`${clean(item.trialId)} Trial ${item.repetition}/${group.planned} ${item.status}`).join('；'));
  write(`重复统计：有效成功率 ${number(group.successRate)}；样本方差 ${number(group.variance)}；标准差 ${number(group.standardDeviation)}`);
  write(group.passAtK?'pass@k：'+Object.entries(group.passAtK).map(([k,value])=>`pass@${k}=${number(value)}`).join('；'):'pass@k：未知；'+clean(group.gaps.join('；')));
  write('本Case指标 | P/F/U/E/N | 原分子/分母 | 汇总值 | 有效Trial | 均值/方差/标准差');
  for(const row of group.metrics) {
    write(`${clean(row.name)} ${row.metricId} ${row.direction==='lower'?'↓':'↑'} [${clean(row.checkId)}] | ${row.pass}/${row.fail}/${row.unjudgeable}/${row.error}/${row.notRun} | ${number(row.numerator)}/${number(row.denominator)} | ${number(row.value)} (${clean(row.unit)}) | ${row.numeric.count}/${group.planned} | ${number(row.numeric.mean)}/${number(row.numeric.variance)}/${number(row.numeric.standardDeviation)}`);
    if(row.inapplicable)write(`  不适用 ${row.inapplicable} 次`);
    if(row.gaps.length||row.numeric.gaps.length)write('  缺口：'+clean([...row.gaps,...row.numeric.gaps].join('；')));
    if(row.evidenceRefs.length)write('  证据：'+clean(row.evidenceRefs.join('；')));
  }
}
export function terminalProgress(write:(line:string)=>void=console.log) {
  return (event:ProgressEvent)=>{
    const label=`[${event.index}/${event.total}] ${event.caseId} · Trial ${event.repetition}/${event.trialsPerCase??'?'} · ${event.trialId}：`;
    if(event.kind==='phase')write(`▶ ${label}${phases[event.phase]}`);
    else if(event.kind==='heartbeat')write(`⏳ ${label}${phases[event.phase]}；仍在等待，已用时${Math.floor((event.phaseElapsedMs??event.elapsedMs)/1000)}秒`);
    else if(event.kind==='execution')write(`${event.executionStatus==='completed'?'✅':event.executionStatus==='not_run'?'⏭️':'❌'} ${label}${event.executionStatus==='completed'?'执行阶段完成':'执行状态：'+event.executionStatus}${event.reason&&/^[a-z][a-z0-9_]+(?::[a-z][a-z0-9_]+)?$/.test(event.reason)?'；'+event.reason:''}`);
    else if(event.kind==='score') {
      const checks=event.checks??[];
      const reasons=checks.map(check=>{
        const actual=check.actual as {calls?:unknown[]}|null,expected=check.expected as {max?:number}|null;
        return check.metricId==='efficiency.calls'&&Array.isArray(actual?.calls)&&typeof expected?.max==='number'?`${check.metricId}：实际${actual.calls.length}，上限${expected.max}`:check.metricId+'：'+check.status;
      });
      const explanation=event.executionStatus==='infra_error'&&event.status!=='FAIL'?'执行阻断，业务质量未验证':event.status==='UNJUDGEABLE'?'必要评分或证据尚不完整':event.status==='ERROR'?'评分或结果推导异常，请查看诊断':event.status==='NOT_RUN'?'未执行':event.status==='FAIL'?'未满足必要判据':'';
      write(`${icons[event.status!]} ${label}${event.status}${explanation?'；'+explanation:''}${reasons.length?'；'+reasons.join('；'):''}`);
      if(checks.length)write('本Trial指标 | 状态 | 数值 | 分子/分母 | 判据单位 | check');
      for(const check of checks){
        write(`${clean(qualityMetricNames[check.metricId]??check.name??check.metricId)} ${check.metricId} | ${check.applicable===false?'不适用':check.status} | ${number(check.value)} | ${number(check.numerator)}/${number(check.denominator)} | ${clean(check.unit)} | ${clean(check.checkId)}${check.scope?' ['+clean(check.scope.kind+':'+check.scope.ref)+']':''}`);
        if(check.reason||check.missing?.length)write('  说明：'+clean([check.reason,...check.missing??[]].filter(Boolean).join('；')));
        if(check.evidenceRefs?.length)write('  证据：'+clean(check.evidenceRefs.join('；')));
      }
    } else if(event.kind==='saved') {
      write(`💾 ${label}${event.status}，耗时${(event.elapsedMs/1000).toFixed(1)}秒，结果已保存`);
      write(`[证据] ${event.evidenceRef}`);
    } else if(event.kind==='case_summary'&&event.caseSummary)terminalCaseSummary(event.caseSummary,write,!!event.reason);
  };
}
export function terminalSummary(report:Pick<EvaluationReport,'executionId'|'totals'>&Partial<Pick<EvaluationReport,'analysis'>>,path:string,write:(line:string)=>void=console.log) {
  const t=report.totals;
  write(`[汇总] 共${t.planned}个Trial：PASS ${t.pass}，FAIL ${t.fail}，UNJUDGEABLE ${t.unjudgeable}，ERROR ${t.error}，NOT_RUN ${t.notRun}`);
  if(report.analysis){const a=report.analysis;write(`[指标覆盖] 正式指标实际有数值 ${a.coverage.measured}/${a.coverage.formal}；本轮配置 ${a.coverage.selected}；完整可判 ${a.coverage.complete}；完整目录见report.json的analysis.qualityMetrics`);write(`[重复统计] 有效Case ${a.dataset.validCases}/${a.dataset.cases}；有效Case宏平均成功率 ${number(a.dataset.successRate)}；各Case表已按执行顺序输出`);}
  write(`[报告] ${path}`);
}
export function terminalReport(report:EvaluationReport,path:string,write:(line:string)=>void=console.error) {
  const analysis=report.analysis??deriveReportAnalysis(report);
  for(const group of analysis.cases)terminalCaseSummary(group,write,group.gaps.some(gap=>/stop_or_save_unconfirmed|save_unconfirmed|stop_unconfirmed/.test(gap)));
  terminalSummary({...report,analysis},path,write);
}
