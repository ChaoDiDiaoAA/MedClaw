import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "event.replay", name: "event.replay", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；重连等价事实/重连机会",
  evaluate: (expected, actual, check, context) => native("event.replay", expected, actual, check),
} satisfies EvaluatorDefinition;
