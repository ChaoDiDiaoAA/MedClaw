import type { EvaluatorDefinition } from '../types.ts';
import { keyedRule } from '../rules.ts';
export default {
  id: "query.trend", name: "query.trend", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；正确date/gap/value点/应有点与多余点",
  evaluate: (expected, actual, check, context) => keyedRule(expected, actual, check, "date", ["gap","value"], false),
} satisfies EvaluatorDefinition;
