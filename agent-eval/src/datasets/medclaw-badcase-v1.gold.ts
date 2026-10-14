import type {GoldDefinition} from '../evaluation.ts';
import {goldDefinitions as originalGold,sourceReferences as originalReferences} from './medclaw-agent-v1.gold.ts';
export const goldDefinitions:Record<string,GoldDefinition>={
  'mc-bc-intent-zh-name':originalGold['mc-v1-intent-resolve']!,
  'mc-v1-intent-resolve':originalGold['mc-v1-intent-resolve']!,
  'mc-v1-intent-clarify-region':originalGold['mc-v1-intent-clarify-region']!,
};
export const sourceReferences={...originalReferences,'badcase-intent-expression':{kind:'historical-issue' as const,path:'agent-eval/records/smoke-20261014T034659018Z-665ab02e/issues.md',section:'MC-BC-004',rationale:'Observed Chinese/English intent contrast; execution discovers the candidate, while the synthetic CSV independently supplies business truth.'}};
