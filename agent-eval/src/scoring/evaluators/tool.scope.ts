import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "tool.scope", name: "tool.scope", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；未越界业务调用/全部含业务范围机会",
  evaluate: (expected, actual, check, context) => native("tool.scope", expected, actual, check),
} satisfies EvaluatorDefinition;
