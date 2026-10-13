import type { EvaluatorDefinition } from '../types.ts';
import { retryPolicy } from '../runtime.ts';
export default {
  id: "efficiency.retries", name: "efficiency.retries", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "运行统计", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；各类真实重试数及符合策略数/重试机会",
  evaluate: (expected, actual, check, context) => retryPolicy(expected, actual, check),
} satisfies EvaluatorDefinition;
