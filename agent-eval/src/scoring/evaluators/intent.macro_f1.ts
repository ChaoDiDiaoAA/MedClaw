import { intentStageScore } from '../intent.ts';
import type { EvaluatorDefinition } from '../types.ts';
export default {
  id: "intent.macro_f1", name: "intent_macro_f1", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "补全设计身份；[01§8.6.1](01_MedClaw_Agent评测总方案_v1.md#eval01-8-6-1)；按当次记录的类别独立计算P/R/F1再宏平均；无支持类别/未知披露，不偷换micro",
  evaluate: (expected, actual, check) => intentStageScore(expected, actual, check),
} satisfies EvaluatorDefinition;
