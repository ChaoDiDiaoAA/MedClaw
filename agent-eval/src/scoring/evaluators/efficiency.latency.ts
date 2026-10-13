import type { EvaluatorDefinition } from '../types.ts';
import { measurement } from '../measurements.ts';
export default {
  id: "efficiency.latency", name: "efficiency.latency", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "运行统计", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；受理到真正停止总耗时，已启动Trial",
  evaluate: (expected, actual, check, context) => measurement("efficiency.latency", actual, check),
} satisfies EvaluatorDefinition;
