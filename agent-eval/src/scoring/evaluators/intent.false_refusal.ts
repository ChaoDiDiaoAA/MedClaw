import { intentStageScore } from '../intent.ts';
import type { EvaluatorDefinition } from '../types.ts';
export default {
  id: "intent.false_refusal", name: "intent_false_refusal", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "补全设计身份；[01§8.6.1](01_MedClaw_Agent评测总方案_v1.md#eval01-8-6-1)；被错误拒绝的合法任务/全部合法任务，越低越好",
  evaluate: (expected, actual, check) => intentStageScore(expected, actual, check),
} satisfies EvaluatorDefinition;
