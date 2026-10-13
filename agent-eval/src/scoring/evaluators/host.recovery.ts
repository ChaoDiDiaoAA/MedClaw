import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "host.recovery", name: "host.recovery", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；同库前缀恢复、正确保持或解除门禁且不重放/全部中断机会",
  evaluate: (expected, actual, check, context) => native("host.recovery", expected, actual, check),
} satisfies EvaluatorDefinition;
