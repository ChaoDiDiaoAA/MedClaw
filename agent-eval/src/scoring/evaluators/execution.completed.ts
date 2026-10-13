import type { EvaluatorDefinition } from '../types.ts';
import { ratio } from '../rules.ts';
export default {
  id: "execution.completed", name: "execution.completed", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "运行统计", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；到预定终点Trial/已计划Trial",
  evaluate: (expected, actual, check, context) => ratio(Number(context.trialStatus === 'completed'), 1, check),
} satisfies EvaluatorDefinition;
