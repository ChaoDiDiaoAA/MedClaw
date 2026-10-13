import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "session.select", name: "session.select", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；选择结果、revision及执行归属均正确机会/全部适用选择机会（含预期拒绝）",
  evaluate: (expected, actual, check, context) => native("session.select", expected, actual, check),
} satisfies EvaluatorDefinition;
