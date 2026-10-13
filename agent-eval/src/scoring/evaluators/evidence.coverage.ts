import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "evidence.coverage", name: "evidence.coverage", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；有对应支持依据断言/需依据断言",
  evaluate: (expected, actual, check, context) => native("evidence.coverage", expected, actual, check),
} satisfies EvaluatorDefinition;
