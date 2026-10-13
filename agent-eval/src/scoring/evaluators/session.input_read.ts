import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "session.input_read", name: "session.input_read", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；原身份提交/受理/处理事实正确查回的机会/全部预定查回及分页机会",
  evaluate: (expected, actual, check, context) => native("session.input_read", expected, actual, check),
} satisfies EvaluatorDefinition;
