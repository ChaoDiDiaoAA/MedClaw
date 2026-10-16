import type {TrialPlan,TrialResult} from '../types.ts';
import type {EvaluationScore,ScoreStatus} from '../scoring/types.ts';
import type {CaseAnalysis} from '../reports/analysis.ts';

export type TrialPhase='prepare_input'|'prepare_host'|'execute'|'collect'|'score'|'save';
export interface ProgressEvent extends TrialPlan {
  index:number;total:number;trialsPerCase?:number;kind:'phase'|'heartbeat'|'execution'|'score'|'saved'|'case_summary';phase:TrialPhase;elapsedMs:number;phaseElapsedMs?:number;
  executionStatus?:TrialResult['status'];reason?:string|null;status?:ScoreStatus;checks?:(Pick<EvaluationScore,'metricId'|'status'>&Partial<EvaluationScore>)[];evidenceRef?:string;caseSummary?:CaseAnalysis;
}
export function trialProgress(item:TrialPlan,index:number,total:number,notify?:(event:ProgressEvent)=>void) {
  const started=Date.now();let phase:TrialPhase='prepare_input',phaseStarted=started,timer:ReturnType<typeof setInterval>|undefined;
  const close=()=>{if(timer!==undefined){clearInterval(timer);timer=undefined;}};
  const emit=(value:Omit<ProgressEvent,keyof TrialPlan|'index'|'total'|'elapsedMs'|'phase'>)=>notify?.({trialId:item.trialId,caseId:item.caseId,repetition:item.repetition,index,total,phase,elapsedMs:Date.now()-started,...value});
  return {close,emit,phase(next:TrialPhase){
    close();phase=next;phaseStarted=Date.now();emit({kind:'phase'});
    if(notify){timer=setInterval(()=>emit({kind:'heartbeat',phaseElapsedMs:Date.now()-phaseStarted}),60000);timer.unref();}
  }};
}
