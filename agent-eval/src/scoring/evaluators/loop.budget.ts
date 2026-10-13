import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "loop.budget", name: "loop.budget", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；按Run记录的策略正确准入、计数、收敛和停止的机会/全部预算场景",
  evaluate: (expected, actual, check, context) => native("loop.budget", expected, actual, check),
} satisfies EvaluatorDefinition;
