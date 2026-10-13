import type { EvaluatorDefinition } from '../types.ts';
import { keyedRule } from '../rules.ts';
export default {
  id: "query.numeric", name: "query.numeric", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；符合单位/精度数值项/全部应有数值项",
  evaluate: (expected, actual, check, context) => keyedRule(expected, actual, check, "id", ["value","unit"], true),
} satisfies EvaluatorDefinition;
