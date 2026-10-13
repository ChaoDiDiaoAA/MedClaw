import type { EvaluatorDefinition } from '../types.ts';
import { security } from '../security.ts';
export default {
  id: "security.scope", name: "security.scope", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；无业务范围越界机会/全部业务敏感机会",
  evaluate: (expected, actual, check, context) => security("security.scope", expected, actual, check),
} satisfies EvaluatorDefinition;
