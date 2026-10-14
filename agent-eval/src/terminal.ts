import type {ProgressEvent} from './execution/progress.ts';
import type {EvaluationReport} from './types.ts';

const phases={prepare_input:'准备公开输入',prepare_host:'准备Host环境',execute:'Agent执行',collect:'确认停止与采证',score:'评分',save:'保存结果'};
const icons={PASS:'✅',FAIL:'❌',UNJUDGEABLE:'⚠️',ERROR:'❌',NOT_RUN:'⏭️'};
export function terminalProgress(write:(line:string)=>void=console.log) {
  return (event:ProgressEvent)=>{
    const label=`[${event.index}/${event.total}] ${event.caseId}：`;
    if(event.kind==='phase')write(`▶ ${label}${phases[event.phase]}`);
    else if(event.kind==='heartbeat')write(`⏳ ${label}${phases[event.phase]}；仍在等待，已用时${Math.floor((event.phaseElapsedMs??event.elapsedMs)/1000)}秒`);
    else if(event.kind==='execution')write(`${event.executionStatus==='completed'?'✅':event.executionStatus==='not_run'?'⏭️':'❌'} ${label}${event.executionStatus==='completed'?'执行阶段完成':'执行状态：'+event.executionStatus}${event.reason&&/^[a-z][a-z0-9_]+(?::[a-z][a-z0-9_]+)?$/.test(event.reason)?'；'+event.reason:''}`);
    else if(event.kind==='score') {
      const checks=event.checks?.filter(check=>check.status!=='PASS').slice(0,3)??[];
      const reasons=checks.map(check=>{
        const actual=check.actual as {calls?:unknown[]}|null,expected=check.expected as {max?:number}|null;
        return check.metricId==='efficiency.calls'&&Array.isArray(actual?.calls)&&typeof expected?.max==='number'?`${check.metricId}：实际${actual.calls.length}，上限${expected.max}`:check.metricId+'：'+check.status;
      });
      const explanation=event.status==='UNJUDGEABLE'?'必要评分或证据尚不完整':event.status==='ERROR'?'必要评分出错':event.status==='NOT_RUN'?'未执行':event.status==='FAIL'?'未满足必要判据':'';
      write(`${icons[event.status!]} ${label}${event.status}${explanation?'；'+explanation:''}${reasons.length?'；'+reasons.join('；'):''}`);
    } else if(event.kind==='saved') {
      write(`💾 ${label}${event.status}，耗时${(event.elapsedMs/1000).toFixed(1)}秒，结果已保存`);
      write(`[证据] ${event.evidenceRef}`);
    }
  };
}
export function terminalSummary(report:Pick<EvaluationReport,'executionId'|'totals'>,path:string,write:(line:string)=>void=console.log) {
  const t=report.totals;
  write(`[汇总] 共${t.planned}个Trial：PASS ${t.pass}，FAIL ${t.fail}，UNJUDGEABLE ${t.unjudgeable}，ERROR ${t.error}，NOT_RUN ${t.notRun}`);
  write(`[报告] ${path}`);
}
