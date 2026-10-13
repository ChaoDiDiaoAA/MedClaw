import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "desktop.entry", name: "desktop.entry", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；从公开UI形成预期事实操作/适用操作",
  evaluate: (expected, actual, check, context) => native("desktop.entry", expected, actual, check),
} satisfies EvaluatorDefinition;
