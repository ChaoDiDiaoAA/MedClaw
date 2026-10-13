import type { EvaluatorDefinition } from '../types.ts';
import { setRule } from '../rules.ts';
export default {
  id: "query.set_precision", name: "query.set_precision", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；TP/(TP+FP)，预测集合有项时",
  evaluate: (expected, actual, check, context) => setRule("precision", expected, actual, check),
} satisfies EvaluatorDefinition;
