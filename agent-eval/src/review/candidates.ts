import type { EvaluationScore } from '../scoring/types.ts';
import { record } from '../scoring/rules.ts';

export interface ReviewCandidate {trialId:string;caseId:string;reasons:string[];checkIds:string[];evidenceRefs:string[]}
export interface ReviewTrial {trialId:string;caseId:string;risks:readonly string[];scores:readonly EvaluationScore[];evidenceRefs?:readonly string[]}
interface Feedback {trialId:string;caseId:string;status:string;evidenceRefs?:readonly string[]}

/** Candidates request attention; only actual imported feedback represents a completed review. */
export function reviewCandidates(policy:unknown,trials:readonly ReviewTrial[],feedback:readonly Feedback[]=[]):ReviewCandidate[] {
  const triggers=record(policy)&&Array.isArray(policy.triggers)?policy.triggers:[];
  return trials.flatMap(trial=>{
    const reasons:string[]=[],checks=new Set<string>(),refs=new Set(trial.evidenceRefs??[]),scores=trial.scores.filter(score=>score.applicable);
    const safety=scores.filter(score=>score.status==='FAIL'&&(score.metricId.startsWith('security.')||score.metricId==='subagent.identity_scope'));
    if(triggers.includes('high-risk')&&(trial.risks.some(risk=>['privacy','funds','deletion','external-send','prompt-injection'].includes(risk))||safety.length)) {
      reasons.push('high-risk');safety.forEach(score=>checks.add(score.checkId));
    }
    const uncertain=scores.filter(score=>score.method==='llm-judge'&&(score.status==='UNJUDGEABLE'||score.value===.5));
    if(triggers.includes('judge-uncertain')&&uncertain.length){reasons.push('judge-uncertain');uncertain.forEach(score=>checks.add(score.checkId));}
    const reviews=feedback.filter(item=>item.trialId===trial.trialId&&item.caseId===trial.caseId);
    const required=scores.filter(score=>score.required||score.hardConstraint),automatic=required.some(score=>score.status==='FAIL')?'FAIL':required.length&&required.every(score=>score.status==='PASS')?'PASS':required.some(score=>score.status==='UNJUDGEABLE')?'UNJUDGEABLE':undefined;
    if(triggers.includes('disputed')&&(new Set(reviews.map(item=>item.status)).size>1||automatic!==undefined&&reviews.some(item=>item.status!==automatic))) {
      reasons.push('disputed');required.forEach(score=>checks.add(score.checkId));reviews.forEach(item=>item.evidenceRefs?.forEach(ref=>refs.add(ref)));
    }
    if(!reasons.length)return [];
    scores.forEach(score=>score.evidenceRefs.forEach(ref=>refs.add(ref)));
    return [{trialId:trial.trialId,caseId:trial.caseId,reasons,checkIds:[...checks],evidenceRefs:[...refs]}];
  });
}
