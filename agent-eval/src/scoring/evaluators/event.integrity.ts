import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "event.integrity", name: "event.integrity", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；无缺失/重复终态Run/观察Run",
  evaluate: (expected, actual, check, context) => native("event.integrity", expected, actual, check),
} satisfies EvaluatorDefinition;
