import type { EvaluatorDefinition } from '../types.ts';
import { measurement } from '../measurements.ts';
export default {
  id: "efficiency.tokens", name: "efficiency.tokens", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "运行统计", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；原生input/output/cache分类之和",
  evaluate: (expected, actual, check, context) => measurement("efficiency.tokens", actual, check),
} satisfies EvaluatorDefinition;
