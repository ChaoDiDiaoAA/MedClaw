import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "messages.projection", name: "messages.projection", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；安全UI投影及分页正确的读取/全部预定读取机会（含预期拒绝）",
  evaluate: (expected, actual, check, context) => native("messages.projection", expected, actual, check),
} satisfies EvaluatorDefinition;
