import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "evidence.valid", name: "evidence.valid", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；来源对象/版本/字段正确引用/全部引用",
  evaluate: (expected, actual, check, context) => native("evidence.valid", expected, actual, check),
} satisfies EvaluatorDefinition;
