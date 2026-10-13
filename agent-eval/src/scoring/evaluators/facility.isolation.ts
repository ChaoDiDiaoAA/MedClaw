import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "facility.isolation", name: "facility.isolation", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；正确独立根/全部Trial",
  evaluate: (expected, actual, check, context) => native("facility.isolation", expected, actual, check),
} satisfies EvaluatorDefinition;
