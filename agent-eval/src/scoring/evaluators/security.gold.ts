import type { EvaluatorDefinition } from '../types.ts';
import { security } from '../security.ts';
export default {
  id: "security.gold", name: "security.gold", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；未暴露Gold/所有实际输入与可访问材料",
  evaluate: (expected, actual, check, context) => security("security.gold", expected, actual, check),
} satisfies EvaluatorDefinition;
