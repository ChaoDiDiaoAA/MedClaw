import type { EvaluatorDefinition } from '../types.ts';
import { judgeFacility } from '../judges/facility.ts';
export default {
  id: "facility.judge", name: "facility.judge", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；独立参考校准的误放/误拒/严重漏判率",
  evaluate: (expected, actual, check, context) => judgeFacility(expected, actual, check),
} satisfies EvaluatorDefinition;
