import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "session.isolation", name: "session.isolation", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；无跨Session污染机会/全部预定适用对照机会",
  evaluate: (expected, actual, check, context) => native("session.isolation", expected, actual, check),
} satisfies EvaluatorDefinition;
