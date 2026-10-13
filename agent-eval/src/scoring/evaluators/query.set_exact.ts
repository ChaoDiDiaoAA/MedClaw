import type { EvaluatorDefinition } from '../types.ts';
import { setRule } from '../rules.ts';
export default {
  id: "query.set_exact", name: "query.set_exact", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；无FP/FN且无重复任务/集合任务",
  evaluate: (expected, actual, check, context) => setRule("exact", expected, actual, check),
} satisfies EvaluatorDefinition;
