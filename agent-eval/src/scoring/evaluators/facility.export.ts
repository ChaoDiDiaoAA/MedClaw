import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "facility.export", name: "facility.export", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；稳定ID且回执完整/事件批",
  evaluate: (expected, actual, check, context) => native("facility.export", expected, actual, check),
} satisfies EvaluatorDefinition;
