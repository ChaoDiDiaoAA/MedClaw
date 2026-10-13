import type { EvaluatorDefinition } from '../types.ts';
import { unknown } from '../rules.ts';
export default {
  id: "task.end_to_end", name: "task.end_to_end", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；全部必需问数/追问/证据/导出完成Trial/计划Trial",
  evaluate: (expected, actual, check, context) => unknown('Task outcome derives from all required original score states in evaluate'),
} satisfies EvaluatorDefinition;
