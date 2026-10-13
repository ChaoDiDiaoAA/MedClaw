import type { EvaluatorDefinition } from '../types.ts';
import { queryConditions } from '../conditions.ts';
export default {
  id: "query.conditions", name: "query.conditions", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；所有必要过滤/时间/实体正确Query / 应有Query",
  evaluate: (expected, actual, check, context) => queryConditions(expected, actual, check),
} satisfies EvaluatorDefinition;
