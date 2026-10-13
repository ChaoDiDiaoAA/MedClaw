import type { EvaluatorDefinition } from '../types.ts';
import { measurement } from '../measurements.ts';
export default {
  id: "efficiency.cost", name: "efficiency.cost", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "运行统计", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；可确认调用成本总和/计划及完成任务两口径",
  evaluate: (expected, actual, check, context) => measurement("efficiency.cost", actual, check),
} satisfies EvaluatorDefinition;
