import type { EvaluatorDefinition } from '../types.ts';
import { exportedExact } from '../runtime.ts';
export default {
  id: "export.exact", name: "export.exact", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；文件与指定Query及元数据一致/导出任务",
  evaluate: (expected, actual, check, context) => exportedExact(expected, actual, check),
} satisfies EvaluatorDefinition;
