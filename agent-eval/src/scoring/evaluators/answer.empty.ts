import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "answer.empty", name: "answer.empty", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；如实合法空结果任务/空集任务",
  evaluate: (expected, actual, check, context) => native("answer.empty", expected, actual, check),
} satisfies EvaluatorDefinition;
