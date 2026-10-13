import { intentStageScore } from '../intent.ts';
import type { EvaluatorDefinition } from '../types.ts';
export default {
  id: "intent.slots_exact", name: "intent_slots_exact", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "补全设计身份；[01§8.6.1](01_MedClaw_Agent评测总方案_v1.md#eval01-8-6-1)；完整意图及全部必要槽位精确匹配的预测/适用预测",
  evaluate: (expected, actual, check) => intentStageScore(expected, actual, check),
} satisfies EvaluatorDefinition;
