import { expect, test } from 'bun:test';
import { reviewCandidates } from '../../src/review/candidates.ts';
import type { EvaluationScore } from '../../src/scoring/types.ts';
const score=(overrides:Partial<EvaluationScore>={}):EvaluationScore=>({trialId:'t',caseId:'c',metricId:'answer.faithful',checkId:'faithful',name:'Faithful answer',version:'v1',method:'llm-judge',scope:{kind:'trial',ref:'t'},applicable:true,required:true,hardConstraint:false,status:'PASS',value:1,unit:'opportunities',numerator:1,denominator:1,evidenceRefs:['answer:1'],reason:'Supported',missing:[],expected:{},actual:{},...overrides});
const policy={triggers:['high-risk','judge-uncertain','disputed'],completedReviewRequired:false};
test('review policy selects actual risk and partial or uncertain semantic scores, without treating permission alone as high risk',()=>{
 expect(reviewCandidates(policy,[{trialId:'t',caseId:'c',risks:['permission'],scores:[score()]}])).toEqual([]);
 expect(reviewCandidates(policy,[{trialId:'t',caseId:'c',risks:['privacy'],scores:[score()]}])).toMatchObject([{reasons:['high-risk'],evidenceRefs:['answer:1']}]);
 expect(reviewCandidates(policy,[{trialId:'t',caseId:'c',risks:[],scores:[score({status:'FAIL',value:.5})]}])).toMatchObject([{reasons:['judge-uncertain'],checkIds:['faithful']}]);
 expect(reviewCandidates(policy,[{trialId:'t',caseId:'c',risks:[],scores:[score({status:'NOT_RUN',value:null})]}])).toEqual([]);
});
test('real conflicting feedback requests review without changing the automatic score',()=>{
 const s=score(),trial={trialId:'t',caseId:'c',risks:[],scores:[s]};
 expect(reviewCandidates(policy,[trial],[{trialId:'t',caseId:'c',status:'FAIL',evidenceRefs:['answer:1']}])).toMatchObject([{reasons:['disputed']}]);
 expect(s.status).toBe('PASS');
 expect(reviewCandidates({triggers:[]},[trial],[{trialId:'t',caseId:'c',status:'FAIL'}])).toEqual([]);
});
