import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "operation.recovery", name: "operation.recovery", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；所有预定导入/导出丢回复或中断机会，正确查回可证状态/全部机会",
  evaluate: (expected, actual, check, context) => native("operation.recovery", expected, actual, check),
} satisfies EvaluatorDefinition;
