import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "facility.cleanup", name: "facility.cleanup", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；确认关闭并仅清自有根/应清理机会",
  evaluate: (expected, actual, check, context) => native("facility.cleanup", expected, actual, check),
} satisfies EvaluatorDefinition;
