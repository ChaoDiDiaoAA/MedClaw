import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "storage.history_error", name: "storage.history_error", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；必要历史保存失败正确阻断/故障机会",
  evaluate: (expected, actual, check, context) => native("storage.history_error", expected, actual, check),
} satisfies EvaluatorDefinition;
