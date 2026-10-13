import { readCalibration } from './calibration-record.ts';
import { ratio,record,unknown } from '../rules.ts';
import type { CheckSpec,RuleResult } from '../types.ts';
export async function judgeFacility(expected:unknown,actual:unknown,check:CheckSpec):Promise<RuleResult> {
  if(!record(expected)||!record(actual)||typeof actual.reportPath!=='string')return unknown('Saved actual calibration required');
  try {const {report,snapshot}=await readCalibration(actual.reportPath);return {...ratio(Number(report.assessment.passed&&(!expected.model||expected.model===snapshot.model)),1,check),evidenceRefs:[actual.reportPath],details:report.assessment};}
  catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?unknown('Calibration evidence unavailable'):{...ratio(0,1,check),reason:'Actual calibration or content binding invalid'};}
}
