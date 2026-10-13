import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "stability.all_pass", name: "stability.all_pass", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "运行统计", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；k次均PASS的Case/完整计划Case",
  evaluate: (expected, actual, check, context) => native("stability.all_pass", expected, actual, check),
} satisfies EvaluatorDefinition;
