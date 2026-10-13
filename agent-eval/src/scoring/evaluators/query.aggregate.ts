import type { EvaluatorDefinition } from '../types.ts';
import { keyedRule } from '../rules.ts';
export default {
  id: "query.aggregate", name: "query.aggregate", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；正确分组键及计数/全部期望组和多余组",
  evaluate: (expected, actual, check, context) => keyedRule(expected, actual, check, "key", ["count"], false),
} satisfies EvaluatorDefinition;
